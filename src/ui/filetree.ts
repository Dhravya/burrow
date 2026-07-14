/**
 * Burrow — left file tree (src/ui internal): rebuilt from vfs.getAllPaths()
 * on VFS events; expand/collapse; click → "editor:open"; full CRUD —
 * new file / new folder / rename / delete via header buttons, row hover
 * action, and a context menu, all with inline name editing and inline
 * delete confirmation. Every operation goes through the shared VFS, so the
 * shell and git see it instantly and the tree refreshes off the same events.
 */
import { WORKSPACE_ROOT } from "../contract/types.ts";
import { use } from "../contract/registry.ts";
import { onEditorChange } from "./editor.ts";
import { showContextMenu, type CtxMenuItem } from "./contextmenu.ts";
import { childNames, countDescendants, remapPath, stemRange, validateName } from "./fileops.ts";
import { basename, debounce, dirname, h, tildify } from "./util.ts";

const GIT_RE = /(^|\/)\.git(\/|$)/;
const EXPANDED_KEY = "burrow.tree.expanded";

interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  children: TreeNode[];
}

type Session =
  | { kind: "create"; parent: string; isDir: boolean; value: string; selStart: number; selEnd: number; error: string | null }
  | { kind: "rename"; path: string; isDir: boolean; value: string; selStart: number; selEnd: number; error: string | null }
  | { kind: "confirm-delete"; path: string; isDir: boolean };

export interface FileTreeActions {
  newFile: HTMLElement;
  newDir: HTMLElement;
}

export function initFileTree(container: HTMLElement, countEl: HTMLElement, actions: FileTreeActions): void {
  const vfs = use("vfs");
  const events = use("events");

  const expanded = new Set<string>(loadExpanded());
  /** async-refined "is this childless path actually a directory?" cache */
  const dirCache = new Map<string, boolean>();
  const statPending = new Set<string>();
  let activePath: string | null = null;
  let openPaths: string[] = [];
  let lastRenderedActive: string | null = null;
  let session: Session | null = null;
  let rendering = false;

  function loadExpanded(): string[] {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  }

  function saveExpanded(): void {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
    } catch {
      /* storage full/blocked — expansion just won't persist */
    }
  }

  // ── model ──────────────────────────────────────────────────────────────────

  function buildTree(): { root: TreeNode; fileCount: number } {
    const root: TreeNode = { path: WORKSPACE_ROOT, name: "~", isDir: true, children: [] };
    const nodes = new Map<string, TreeNode>([[WORKSPACE_ROOT, root]]);

    function ensure(path: string): TreeNode {
      const existing = nodes.get(path);
      if (existing) return existing;
      const node: TreeNode = { path, name: basename(path), isDir: false, children: [] };
      nodes.set(path, node);
      const parentPath = dirname(path);
      const parent =
        parentPath === WORKSPACE_ROOT || !parentPath.startsWith(WORKSPACE_ROOT) ? root : ensure(parentPath);
      parent.isDir = true;
      parent.children.push(node);
      return node;
    }

    for (const p of vfs.getAllPaths()) {
      if (p === WORKSPACE_ROOT) continue;
      if (!p.startsWith(`${WORKSPACE_ROOT}/`)) continue;
      if (GIT_RE.test(p)) continue;
      ensure(p);
    }

    // Childless nodes might still be (empty) directories — refine via stat.
    let fileCount = 0;
    for (const node of nodes.values()) {
      if (node === root) continue;
      if (!node.isDir) {
        const cached = dirCache.get(node.path);
        if (cached === undefined) {
          if (!statPending.has(node.path)) {
            statPending.add(node.path);
            vfs
              .stat(node.path)
              .then((st) => {
                statPending.delete(node.path);
                dirCache.set(node.path, st.isDirectory);
                if (st.isDirectory) schedule();
              })
              .catch(() => {
                statPending.delete(node.path);
                dirCache.set(node.path, false);
              });
          }
        } else if (cached) {
          node.isDir = true;
        }
      }
      if (!node.isDir) fileCount++;
    }

    sortNode(root);
    return { root, fileCount };
  }

  function sortNode(node: TreeNode): void {
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) sortNode(c);
  }

  // ── CRUD sessions ──────────────────────────────────────────────────────────

  function expandTo(dir: string): void {
    let d = dir;
    while (d.startsWith(WORKSPACE_ROOT) && d !== WORKSPACE_ROOT) {
      expanded.add(d);
      d = dirname(d);
    }
    saveExpanded();
  }

  function startCreate(parent: string, isDir: boolean): void {
    expandTo(parent);
    expanded.add(parent);
    session = { kind: "create", parent, isDir, value: "", selStart: 0, selEnd: 0, error: null };
    render();
  }

  function startRename(path: string, isDir: boolean): void {
    const name = basename(path);
    const sel = stemRange(name);
    session = { kind: "rename", path, isDir, value: name, selStart: sel.start, selEnd: sel.end, error: null };
    render();
  }

  function startDelete(path: string, isDir: boolean): void {
    session = { kind: "confirm-delete", path, isDir };
    render();
  }

  function cancelSession(): void {
    if (!session) return;
    session = null;
    render();
  }

  function siblingsOf(dir: string): string[] {
    return childNames(vfs.getAllPaths(), dir);
  }

  async function commitCreate(s: Extract<Session, { kind: "create" }>): Promise<void> {
    const error = validateName(s.value, { siblings: siblingsOf(s.parent) });
    if (error) {
      s.error = error;
      render();
      return;
    }
    const path = `${s.parent}/${s.value}`;
    try {
      if (s.isDir) {
        await vfs.mkdir(path);
        dirCache.set(path, true);
        expanded.add(path);
        saveExpanded();
      } else {
        await vfs.writeFile(path, "");
      }
    } catch (err) {
      if (session === s) {
        s.error = err instanceof Error ? err.message : String(err);
        render();
      }
      return;
    }
    if (session === s) {
      session = null;
      render();
    }
    // New files open immediately, focused, ready to type.
    if (!s.isDir) events.emit("editor:open", { path });
  }

  async function commitRename(s: Extract<Session, { kind: "rename" }>): Promise<void> {
    const current = basename(s.path);
    if (s.value === current) {
      session = null;
      render();
      return;
    }
    const parent = dirname(s.path);
    const error = validateName(s.value, { siblings: siblingsOf(parent), current });
    if (error) {
      s.error = error;
      render();
      return;
    }
    const dest = `${parent}/${s.value}`;
    // Snapshot open tabs before mv: the delete event closes them synchronously.
    const reopen = openPaths
      .map((p) => ({ old: p, next: remapPath(p, s.path, dest) }))
      .filter((r): r is { old: string; next: string } => r.next !== null);
    const activeNext = activePath ? remapPath(activePath, s.path, dest) : null;
    try {
      await vfs.mv(s.path, dest);
    } catch (err) {
      if (session === s) {
        s.error = err instanceof Error ? err.message : String(err);
        render();
      }
      return;
    }
    for (const p of [...expanded]) {
      const next = remapPath(p, s.path, dest);
      if (next) {
        expanded.delete(p);
        expanded.add(next);
      }
    }
    saveExpanded();
    if (session === s) {
      session = null;
      render();
    }
    // Reopen renamed tabs; the previously active one last so it stays focused.
    for (const r of reopen) if (r.next !== activeNext) events.emit("editor:open", { path: r.next });
    if (activeNext) events.emit("editor:open", { path: activeNext });
  }

  async function commitDelete(s: Extract<Session, { kind: "confirm-delete" }>): Promise<void> {
    session = null;
    try {
      await vfs.rm(s.path, { recursive: true, force: true });
    } catch (err) {
      console.error(`[burrow/ui] delete failed for ${s.path}`, err);
    }
    for (const p of [...expanded]) {
      if (p === s.path || p.startsWith(`${s.path}/`)) expanded.delete(p);
    }
    for (const p of [...dirCache.keys()]) {
      if (p === s.path || p.startsWith(`${s.path}/`)) dirCache.delete(p);
    }
    saveExpanded();
    render();
  }

  function commitSession(): void {
    if (!session) return;
    if (session.kind === "create") void commitCreate(session);
    else if (session.kind === "rename") void commitRename(session);
    else void commitDelete(session);
  }

  // ── context menu ───────────────────────────────────────────────────────────

  function menuFor(node: TreeNode): CtxMenuItem[] {
    const parent = node.isDir ? node.path : dirname(node.path);
    const hint = tildify(parent);
    return [
      { label: "new file", hint, action: () => startCreate(parent, false) },
      { label: "new folder", hint, action: () => startCreate(parent, true) },
      { label: "rename", separatorBefore: true, action: () => startRename(node.path, node.isDir) },
      { label: "delete", danger: true, action: () => startDelete(node.path, node.isDir) },
    ];
  }

  function rootMenu(): CtxMenuItem[] {
    return [
      { label: "new file", hint: "~", action: () => startCreate(WORKSPACE_ROOT, false) },
      { label: "new folder", hint: "~", action: () => startCreate(WORKSPACE_ROOT, true) },
    ];
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  function extBadge(name: string): HTMLElement | null {
    const i = name.lastIndexOf(".");
    if (i <= 0) return null;
    const ext = name.slice(i + 1).toLowerCase();
    if (!ext || ext.length > 4) return null;
    const cls =
      ext === "ts" || ext === "tsx"
        ? "acc"
        : ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs"
          ? "warn"
          : ext === "json"
            ? "info"
            : ext === "css" || ext === "html"
              ? "ok"
              : "dim";
    return h("span", `ext ext-${cls}`, ext);
  }

  function editRow(depth: number, isDir: boolean): HTMLElement[] {
    const s = session;
    if (!s || s.kind === "confirm-delete") return [];
    const row = h("div", `row edit ${isDir ? "dir" : "file"}`);
    row.style.setProperty("--depth", String(depth));
    if (isDir) row.append(h("span", "chev", "▸"));

    const input = h("input", "tree-input");
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = s.value;
    input.setAttribute(
      "aria-label",
      s.kind === "create" ? (s.isDir ? "new folder name" : "new file name") : "new name",
    );
    input.classList.toggle("invalid", s.error !== null);

    const trackSel = () => {
      s.selStart = input.selectionStart ?? s.value.length;
      s.selEnd = input.selectionEnd ?? s.value.length;
    };
    input.addEventListener("input", () => {
      s.value = input.value;
      trackSel();
      const siblings =
        s.kind === "create"
          ? siblingsOf(s.parent)
          : siblingsOf(dirname(s.path));
      s.error = validateName(s.value, {
        siblings,
        current: s.kind === "rename" ? basename(s.path) : undefined,
      });
      input.classList.toggle("invalid", s.error !== null);
      errEl.textContent = s.error ?? "";
      errEl.hidden = s.error === null;
    });
    input.addEventListener("keyup", trackSel);
    input.addEventListener("mouseup", trackSel);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commitSession();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelSession();
      }
    });
    input.addEventListener("blur", () => {
      if (rendering || session !== s) return;
      // Click-away: commit when the name is usable, otherwise abandon quietly.
      if (s.value.length > 0 && s.error === null) commitSession();
      else cancelSession();
    });

    row.append(input);
    const errEl = h("div", "tree-err", s.error ?? "");
    errEl.style.setProperty("--depth", String(depth));
    errEl.hidden = s.error === null;
    return [row, errEl];
  }

  function confirmRow(node: TreeNode, depth: number): HTMLElement {
    const row = h("div", "row confirm");
    row.style.setProperty("--depth", String(depth));
    const n = node.isDir ? countDescendants(vfs.getAllPaths(), node.path) : 0;
    const label = node.isDir
      ? `delete ${node.name}/${n > 0 ? ` (${n} item${n === 1 ? "" : "s"})` : ""}?`
      : `delete ${node.name}?`;
    row.append(h("span", "confirm-label", label));

    const yes = h("button", "mini danger", "delete");
    yes.addEventListener("click", (e) => {
      e.stopPropagation();
      commitSession();
    });
    const no = h("button", "mini", "cancel");
    no.addEventListener("click", (e) => {
      e.stopPropagation();
      cancelSession();
    });
    row.append(yes, no);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelSession();
      }
    });
    return row;
  }

  function actionsButton(node: TreeNode): HTMLElement {
    const btn = h("button", "acts", "⋯");
    btn.title = "file actions";
    btn.setAttribute("aria-label", `actions for ${node.name}`);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = btn.getBoundingClientRect();
      showContextMenu(r.left, r.bottom + 2, menuFor(node));
    });
    return btn;
  }

  function renderRows(node: TreeNode, depth: number, out: HTMLElement[]): void {
    for (const child of node.children) {
      if (session?.kind === "rename" && session.path === child.path) {
        out.push(...editRow(depth, child.isDir));
        continue;
      }
      if (session?.kind === "confirm-delete" && session.path === child.path) {
        out.push(confirmRow(child, depth));
        continue;
      }

      const row = h("div", "row");
      row.style.setProperty("--depth", String(depth));
      row.setAttribute("role", "treeitem");
      row.tabIndex = 0;
      row.title = child.path;

      if (child.isDir) {
        const open = expanded.has(child.path);
        row.classList.add("dir");
        row.classList.toggle("open", open);
        row.setAttribute("aria-expanded", String(open));
        row.append(h("span", "chev", "▸"), h("span", "name", child.name));
        row.append(actionsButton(child));
        row.addEventListener("click", () => {
          if (expanded.has(child.path)) expanded.delete(child.path);
          else expanded.add(child.path);
          saveExpanded();
          render();
        });
        out.push(row);
        if (open) {
          if (session?.kind === "create" && session.parent === child.path) {
            out.push(...editRow(depth + 1, session.isDir));
          }
          renderRows(child, depth + 1, out);
        }
      } else {
        row.classList.add("file");
        row.classList.toggle("active", child.path === activePath);
        const badge = extBadge(child.name);
        if (badge) row.append(badge);
        row.append(h("span", "name", child.name));
        row.append(actionsButton(child));
        row.addEventListener("click", () => {
          events.emit("editor:open", { path: child.path });
        });
        out.push(row);
      }

      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, menuFor(child));
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      });
    }
  }

  function render(): void {
    rendering = true;
    try {
      const { root, fileCount } = buildTree();
      countEl.textContent = fileCount > 0 ? String(fileCount) : "";
      const rows: HTMLElement[] = [];
      if (session?.kind === "create" && session.parent === WORKSPACE_ROOT) {
        rows.push(...editRow(0, session.isDir));
      }
      renderRows(root, 0, rows);
      if (rows.length === 0) {
        const empty = h("div", "empty", "Empty workspace. Try `git clone <url>` in the terminal.");
        container.replaceChildren(empty);
        return;
      }
      container.replaceChildren(...rows);
    } finally {
      rendering = false;
    }

    // Restore inline-edit focus/caret after a rebuild (VFS churn mid-typing).
    if (session && session.kind !== "confirm-delete") {
      const input = container.querySelector<HTMLInputElement>(".tree-input");
      if (input) {
        input.focus();
        input.setSelectionRange(session.selStart, session.selEnd);
      }
    } else if (session?.kind === "confirm-delete") {
      container.querySelector<HTMLButtonElement>(".row.confirm .danger")?.focus();
    } else if (activePath && activePath !== lastRenderedActive) {
      lastRenderedActive = activePath;
      container.querySelector(".row.active")?.scrollIntoView({ block: "nearest" });
    }
  }

  const schedule = debounce(() => {
    // A session whose target vanished underneath us (shell rm, git checkout)
    // must not commit against a ghost path.
    if (session && session.kind !== "create") {
      const target = session.path;
      if (!vfs.getAllPaths().includes(target)) session = null;
    }
    render();
  }, 50);

  events.on("file:changed", () => schedule());
  events.on("fs:batch", () => schedule());
  onEditorChange((s) => {
    activePath = s.activePath;
    openPaths = s.openPaths;
    // Auto-expand ancestors of the active file so it is visible.
    if (activePath) {
      let dir = dirname(activePath);
      while (dir.startsWith(WORKSPACE_ROOT) && dir !== WORKSPACE_ROOT) {
        expanded.add(dir);
        dir = dirname(dir);
      }
    }
    schedule();
  });

  // Header buttons create at the workspace root.
  actions.newFile.addEventListener("click", () => startCreate(WORKSPACE_ROOT, false));
  actions.newDir.addEventListener("click", () => startCreate(WORKSPACE_ROOT, true));

  // Right-click on empty tree space → root-level create menu.
  container.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".row")) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, rootMenu());
  });

  render();
}
