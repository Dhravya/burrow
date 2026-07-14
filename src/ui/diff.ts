/**
 * Burrow — right diff panel: changed-file list from git.statusMatrix +
 * HEAD-vs-workdir unified merge view via @codemirror/merge (src/ui internal).
 */
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { unifiedMergeView } from "@codemirror/merge";
import { use, tryUse } from "../contract/registry.ts";
import { burrowTheme } from "./theme.ts";
import { findRepoRoots, repoRootFor } from "./git-util.ts";
import { onEditorChange } from "./editor.ts";
import { debounce, decodeText, extOf, h } from "./util.ts";

interface ChangeRow {
  abs: string;
  rel: string;
  root: string;
  /** ? untracked · A added · M modified · D deleted */
  code: "?" | "A" | "M" | "D";
}

export function initDiffPanel(els: {
  files: HTMLElement;
  head: HTMLElement;
  st: HTMLElement;
  path: HTMLElement;
  note: HTMLElement;
  openBtn: HTMLElement;
  host: HTMLElement;
  empty: HTMLElement;
  count: HTMLElement;
}): void {
  const events = use("events");

  let roots: string[] = [];
  let rows: ChangeRow[] = [];
  let selected: string | null = null; // absolute VFS path
  let lastActive: string | null = null;
  let merge: EditorView | null = null;
  let renderSeq = 0;

  function langFor(path: string): Extension[] {
    switch (extOf(path)) {
      case "ts":
      case "mts":
      case "cts":
        return [javascript({ typescript: true })];
      case "tsx":
        return [javascript({ typescript: true, jsx: true })];
      case "jsx":
        return [javascript({ jsx: true })];
      case "js":
      case "mjs":
      case "cjs":
        return [javascript()];
      default:
        return [];
    }
  }

  function codeFor(head: 0 | 1, workdir: 0 | 1 | 2, stage: 0 | 1 | 2 | 3): ChangeRow["code"] {
    if (head === 0) {
      if (workdir === 2) return stage === 0 ? "?" : "A";
      return "D"; // staged-new file removed from workdir
    }
    if (workdir === 0) return "D";
    return "M";
  }

  function setEmpty(text: string | null): void {
    if (text === null) {
      els.empty.hidden = true;
      return;
    }
    els.empty.textContent = text;
    els.empty.hidden = false;
    els.head.hidden = true;
    els.files.replaceChildren();
    destroyMerge();
  }

  function destroyMerge(): void {
    merge?.destroy();
    merge = null;
    els.host.replaceChildren();
  }

  async function refresh(): Promise<void> {
    const git = tryUse("git");
    const vfs = tryUse("vfs");
    if (!git || !vfs) {
      setEmpty("Git isn't available right now.");
      updateCount();
      return;
    }
    roots = findRepoRoots(vfs.getAllPaths());
    if (roots.length === 0) {
      rows = [];
      updateCount();
      setEmpty("No repo here yet. Run `git init`, or `git clone <url>` in the terminal.");
      return;
    }
    const next: ChangeRow[] = [];
    for (const root of roots) {
      try {
        const matrix = await git.statusMatrix(root);
        for (const [rel, head, workdir, stage] of matrix) {
          if (head === 1 && workdir === 1 && stage === 1) continue;
          next.push({ abs: `${root}/${rel}`, rel, root, code: codeFor(head, workdir, stage) });
        }
      } catch (err) {
        console.error(`[burrow/ui] statusMatrix failed for ${root}`, err);
      }
    }
    rows = next;
    updateCount();
    els.empty.hidden = true;

    // Selection: keep if still sensible, else follow the editor, else first change.
    if (!selected || (!rows.some((r) => r.abs === selected) && !repoRootFor(selected, roots))) selected = null;
    if (!selected && lastActive && repoRootFor(lastActive, roots)) selected = lastActive;
    if (!selected) selected = rows[0]?.abs ?? null;

    renderList();
    await renderMerge();
  }

  function updateCount(): void {
    els.count.hidden = rows.length === 0;
    els.count.textContent = String(rows.length);
  }

  function renderList(): void {
    const frag = document.createDocumentFragment();
    if (rows.length === 0) {
      frag.append(h("div", "diff-clean", "Working tree clean — nothing to commit."));
    }
    for (const row of rows) {
      const btn = h("button", `drow drow-${row.code === "?" ? "q" : row.code.toLowerCase()}`);
      btn.classList.toggle("active", row.abs === selected);
      btn.title = row.abs;
      const label = roots.length > 1 ? `${row.root.split("/").pop()}/${row.rel}` : row.rel;
      btn.append(h("span", "st", row.code), h("span", "name", label));
      btn.addEventListener("click", () => {
        selected = row.abs;
        renderList();
        void renderMerge();
      });
      frag.append(btn);
    }
    els.files.replaceChildren(frag);
  }

  async function renderMerge(): Promise<void> {
    const seq = ++renderSeq;
    const git = tryUse("git");
    const vfs = tryUse("vfs");
    if (!git || !vfs || !selected) {
      els.head.hidden = true;
      destroyMerge();
      return;
    }
    const abs = selected;
    const root = repoRootFor(abs, roots);
    if (!root) {
      els.head.hidden = true;
      destroyMerge();
      return;
    }
    const rel = abs.slice(root.length + 1);

    let headText = "";
    try {
      const blob = await git.headContent(rel, root);
      headText = blob ? decodeText(blob) : "";
    } catch (err) {
      console.error(`[burrow/ui] headContent failed for ${rel}`, err);
    }
    let workText = "";
    let workMissing = false;
    try {
      workText = (await vfs.exists(abs)) ? await vfs.readFile(abs) : ((workMissing = true), "");
    } catch {
      workMissing = true;
    }
    if (seq !== renderSeq) return; // a newer render superseded this one

    const row = rows.find((r) => r.abs === abs);
    els.head.hidden = false;
    els.st.textContent = row?.code ?? "·";
    els.st.className = `st st-${row ? (row.code === "?" ? "q" : row.code.toLowerCase()) : "none"}`;
    els.path.textContent = rel;
    els.path.setAttribute("title", abs);
    els.note.textContent = workMissing ? "deleted in workdir" : headText === workText ? "matches HEAD" : "";

    destroyMerge();
    merge = new EditorView({
      doc: workText,
      extensions: [
        basicSetup,
        keymap.of([]),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        ...langFor(abs),
        burrowTheme,
        unifiedMergeView({
          original: headText,
          mergeControls: false,
          gutter: true,
          allowInlineDiffs: true,
          collapseUnchanged: { margin: 2, minSize: 6 },
        }),
      ],
      parent: els.host,
    });
  }

  els.openBtn.addEventListener("click", () => {
    if (selected) events.emit("editor:open", { path: selected });
  });

  const schedule = debounce(() => void refresh(), 300);
  events.on("fs:batch", () => schedule());
  events.on("file:changed", () => schedule());
  onEditorChange((s) => {
    if (s.activePath && s.activePath !== lastActive) {
      lastActive = s.activePath;
      if (repoRootFor(s.activePath, roots) && s.activePath !== selected) {
        selected = s.activePath;
        renderList();
        void renderMerge();
      }
    }
  });

  void refresh();
}
