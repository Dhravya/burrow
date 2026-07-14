/**
 * Burrow — center editor: CodeMirror 6, file tabs, autosave (src/ui internal).
 * Edits write to the VFS on a ~400ms per-tab trailing debounce; cmd/ctrl+S
 * flushes immediately. There are no dirty markers and no prompts — content is
 * always saved (a transient saving…/saved indicator lives in the status bar).
 * Every save goes through vfs.writeFile, so WatchedFs emits "file:changed"
 * and the rest of the app (tree, git panel, hot reload) sees it instantly.
 *
 * MARKDOWN PREVIEW: .md files open rendered (src/ui/markdown.ts) with an
 * edit ⇄ preview chip in the top-right of the pane; the choice sticks per
 * tab. Workspace-relative image paths resolve through the VFS into blob URLs
 * (revoked on every rerender); http(s)/data: URLs pass through untouched.
 */
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { use } from "../contract/registry.ts";
import { AutosaveScheduler } from "./autosave.ts";
import { renderMarkdownDoc } from "./markdown.ts";
import { burrowTheme } from "./theme.ts";
import { basename, debounce, decodeText, extOf, h, looksBinary } from "./util.ts";

export interface EditorUiState {
  activePath: string | null;
  openPaths: string[];
}

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; detail: string };

interface OpenDoc {
  path: string;
  state: EditorState;
  /** Last text known to be on disk (or in flight to it). */
  savedText: string;
  binary: boolean;
  byteSize: number;
  /** .md files only: rendered preview vs raw source. Sticky per tab. */
  mdPreview?: boolean;
}

const isMarkdown = (path: string): boolean => extOf(path) === "md";

const docs = new Map<string, OpenDoc>();
const order: string[] = [];
const listeners = new Set<(s: EditorUiState) => void>();
const saveListeners = new Set<(s: SaveState) => void>();
const autosave = new AutosaveScheduler();
let inflightWrites = 0;
let lastSaveError: string | null = null;
let saveState: SaveState = { kind: "idle" };
let active: string | null = null;
let view: EditorView | null = null;
let tabsEl: HTMLElement | null = null;
let hostEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let previewEl: HTMLElement | null = null;
let mdToggleEl: HTMLButtonElement | null = null;
/** Blob URLs minted for the current preview render — revoked on the next. */
let previewBlobUrls: string[] = [];
/** Guards against a stale async image-hydration pass writing into a newer render. */
let previewEpoch = 0;

// ── public surface ───────────────────────────────────────────────────────────

export function onEditorChange(cb: (s: EditorUiState) => void): () => void {
  listeners.add(cb);
  cb(uiState());
  return () => listeners.delete(cb);
}

/** Autosave lifecycle feed for the status bar indicator. */
export function onSaveState(cb: (s: SaveState) => void): () => void {
  saveListeners.add(cb);
  cb(saveState);
  return () => saveListeners.delete(cb);
}

export function getActivePath(): string | null {
  return active;
}

/** Force-write every pending buffer right now (cmd/ctrl+S path). */
export function flushPendingSaves(): void {
  autosave.flushAll();
}

export function initEditor(tabs: HTMLElement, host: HTMLElement, empty: HTMLElement): void {
  tabsEl = tabs;
  hostEl = host;
  emptyEl = empty;
  const events = use("events");

  // Preview surface + mode chip live beside the CM host in #editor-body.
  previewEl = h("div", "md-preview");
  previewEl.style.display = "none";
  mdToggleEl = h("button", "md-toggle") as HTMLButtonElement;
  mdToggleEl.type = "button";
  mdToggleEl.style.display = "none";
  mdToggleEl.addEventListener("click", () => {
    const doc = active ? docs.get(active) : undefined;
    if (!doc || !isMarkdown(doc.path)) return;
    doc.mdPreview = !doc.mdPreview;
    render();
    if (!doc.mdPreview) view?.focus();
  });
  host.parentElement?.append(previewEl, mdToggleEl);

  events.on("editor:open", (e) => {
    void open(e.path, e.line, e.column);
  });
  events.on("file:changed", (e) => {
    if (e.kind === "deleted") {
      // A deleted directory collapses into one event for the top path —
      // close every open doc at or under it.
      for (const path of [...docs.keys()]) {
        if (path === e.path || path.startsWith(`${e.path}/`)) handleGone(path);
      }
    } else if (docs.has(e.path)) {
      void reload(e.path);
    }
  });
  events.on("fs:batch", () => reconcileAll());

  // One global save shortcut: flush pending autosaves immediately and always
  // eat the browser's save dialog.
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      flushPendingSaves();
    }
  });

  // Autosave means closing never prompts; the last debounce window is flushed
  // synchronously so not even a just-typed character is lost.
  window.addEventListener("beforeunload", () => {
    for (const key of autosave.keys()) {
      autosave.cancel(key);
      const doc = docs.get(key);
      if (!doc || doc.binary) continue;
      const text = textOf(doc);
      if (text === doc.savedText) continue;
      try {
        use("vfs").writeFileSync(key, text);
      } catch {
        /* the in-memory fs is going away with the page anyway */
      }
    }
  });

  render();
}

// ── internals ────────────────────────────────────────────────────────────────

function uiState(): EditorUiState {
  return { activePath: active, openPaths: [...order] };
}

function notify(): void {
  const s = uiState();
  for (const cb of listeners) {
    try {
      cb(s);
    } catch (err) {
      console.error("[burrow/ui] editor listener failed", err);
    }
  }
}

function emitSaveState(s: SaveState): void {
  if (s.kind === saveState.kind && s.kind !== "error") return;
  saveState = s;
  for (const cb of saveListeners) {
    try {
      cb(s);
    } catch (err) {
      console.error("[burrow/ui] save-state listener failed", err);
    }
  }
}

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

const updateListener = EditorView.updateListener.of((update) => {
  if (!update.docChanged || !active) return;
  const doc = docs.get(active);
  if (!doc || doc.binary) return;
  // Keep the stashed state fresh so a flush for a background tab is exact.
  doc.state = update.state;
  scheduleSave(doc.path);
});

function makeState(path: string, text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      EditorState.tabSize.of(2),
      ...langFor(path),
      burrowTheme,
      updateListener,
    ],
  });
}

// ── autosave core ────────────────────────────────────────────────────────────

function textOf(doc: OpenDoc): string {
  return active === doc.path && view ? view.state.doc.toString() : doc.state.doc.toString();
}

function scheduleSave(path: string): void {
  lastSaveError = null;
  emitSaveState({ kind: "saving" });
  autosave.schedule(path, () => void persist(path));
}

async function persist(path: string): Promise<void> {
  const doc = docs.get(path);
  if (!doc || doc.binary) {
    settleSaveState();
    return;
  }
  const text = textOf(doc);
  if (text === doc.savedText) {
    settleSaveState();
    return;
  }
  doc.savedText = text; // claim before the await so reload() keeps the buffer
  inflightWrites++;
  try {
    await use("vfs").writeFile(path, text);
  } catch (err) {
    console.error(`[burrow/ui] autosave failed for ${path}`, err);
    lastSaveError = basename(path);
  } finally {
    inflightWrites--;
    settleSaveState();
  }
}

function settleSaveState(outcome: "saved" | "idle" = "saved"): void {
  if (autosave.size > 0 || inflightWrites > 0) return;
  if (lastSaveError) emitSaveState({ kind: "error", detail: lastSaveError });
  else emitSaveState({ kind: outcome });
}

// ── open / close / reload ────────────────────────────────────────────────────

async function open(path: string, line?: number, column?: number): Promise<void> {
  if (!docs.has(path)) {
    const vfs = use("vfs");
    let buf: Uint8Array;
    try {
      buf = await vfs.readFileBuffer(path);
    } catch (err) {
      console.error(`[burrow/ui] cannot open ${path}`, err);
      return;
    }
    const binary = looksBinary(buf);
    const text = binary ? "" : decodeText(buf);
    docs.set(path, {
      path,
      state: makeState(path, text),
      savedText: text,
      binary,
      byteSize: buf.byteLength,
      // Docs read best rendered; jumping to a line means the caller wants source.
      ...(isMarkdown(path) ? { mdPreview: line === undefined } : {}),
    });
    order.push(path);
  }
  const doc = docs.get(path);
  if (line !== undefined && doc?.mdPreview) doc.mdPreview = false; // reveal needs source
  activate(path);
  if (line !== undefined) reveal(line, column);
}

function activate(path: string): void {
  const next = docs.get(path);
  if (!next) return;
  stashActiveState();
  active = path;
  if (!next.binary && hostEl) {
    if (!view) view = new EditorView({ state: next.state, parent: hostEl });
    else view.setState(next.state);
  }
  render();
  if (!next.binary && !next.mdPreview) view?.focus();
}

/** Keep undo history + selection when switching tabs. */
function stashActiveState(): void {
  if (active && view) {
    const prev = docs.get(active);
    if (prev && !prev.binary) prev.state = view.state;
  }
}

function reveal(line: number, column?: number): void {
  if (!view) return;
  try {
    const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
    const pos = Math.min(l.from + Math.max(0, (column ?? 1) - 1), l.to);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
  } catch (err) {
    console.error("[burrow/ui] reveal failed", err);
  }
}

/** User closed the tab: flush any pending save (never prompts), then drop it. */
function close(path: string): void {
  autosave.flush(path); // persist() captures the text synchronously
  removeDoc(path);
}

/** The file vanished from disk: drop the tab, discard any pending save. */
function handleGone(path: string): void {
  if (!docs.has(path)) return;
  autosave.cancel(path);
  settleSaveState("idle");
  removeDoc(path);
}

function removeDoc(path: string): void {
  if (!docs.delete(path)) return;
  const i = order.indexOf(path);
  if (i !== -1) order.splice(i, 1);
  if (active === path) {
    active = null;
    const neighbor = order[Math.min(i, order.length - 1)];
    if (neighbor) {
      activate(neighbor);
      return;
    }
  }
  render();
}

const reconcileAll = debounce(() => {
  for (const path of [...docs.keys()]) void reload(path);
}, 100);

async function reload(path: string): Promise<void> {
  const doc = docs.get(path);
  if (!doc || doc.binary) return;
  const vfs = use("vfs");
  let exists = false;
  try {
    exists = await vfs.exists(path);
  } catch {
    return;
  }
  if (!exists) {
    handleGone(path);
    return;
  }
  let buf: Uint8Array;
  try {
    buf = await vfs.readFileBuffer(path);
  } catch {
    return;
  }
  const text = decodeText(buf);
  if (text === doc.savedText) return; // our own autosave echoing back
  doc.savedText = text;
  doc.byteSize = buf.byteLength;
  if (!autosave.has(path)) {
    // No pending edits → follow the disk (git checkout, shell edits, …).
    if (active === path && view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      doc.state = view.state;
    } else {
      doc.state = makeState(path, text);
    }
    // A previewed doc follows the disk immediately (agent edits, git checkout).
    if (active === path && doc.mdPreview) renderPreview(doc);
  }
  // With edits pending, the buffer wins: the scheduled autosave will
  // overwrite the disk in <400ms anyway.
}

// ── rendering ────────────────────────────────────────────────────────────────

function render(): void {
  renderTabs();
  const doc = active ? docs.get(active) : undefined;
  if (hostEl && emptyEl && previewEl && mdToggleEl) {
    const showPreview = !!doc && !doc.binary && !!doc.mdPreview;
    const showEditor = !!doc && !doc.binary && !showPreview;
    hostEl.style.display = showEditor ? "" : "none";
    previewEl.style.display = showPreview ? "" : "none";
    emptyEl.style.display = showEditor || showPreview ? "none" : "";
    const isMd = !!doc && !doc.binary && isMarkdown(doc.path);
    mdToggleEl.style.display = isMd ? "" : "none";
    if (isMd) {
      mdToggleEl.textContent = showPreview ? "✎ edit" : "◫ preview";
      mdToggleEl.title = showPreview ? "edit the source" : "render the markdown";
    }
    if (showPreview && doc) renderPreview(doc);
    if (!doc) {
      emptyEl.textContent = "Nothing open yet. Pick a file from the tree, or type `edit index.ts` in the terminal.";
    } else if (doc.binary) {
      emptyEl.textContent = `// ${basename(doc.path)} is binary — ${doc.byteSize} bytes, no editor for that`;
    }
  }
  notify();
}

// ── markdown preview ─────────────────────────────────────────────────────────

const IMAGE_MIME: Record<string, string> = {
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", ico: "image/x-icon", bmp: "image/bmp",
};

/** Resolve a markdown-relative src against the doc's directory ("."/".." aware). */
function resolveDocPath(docPath: string, src: string): string {
  const base = src.startsWith("/") ? [] : docPath.split("/").slice(0, -1);
  const segments = [...base, ...src.split("/")];
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

function renderPreview(doc: OpenDoc): void {
  if (!previewEl) return;
  const epoch = ++previewEpoch;
  for (const url of previewBlobUrls) URL.revokeObjectURL(url);
  previewBlobUrls = [];
  previewEl.innerHTML = renderMarkdownDoc(textOf(doc));
  previewEl.scrollTop = 0;

  // Hydrate images: http(s)/data: pass through; anything else is a workspace
  // path served out of the VFS as a blob URL (async — epoch-guarded).
  for (const img of previewEl.querySelectorAll<HTMLImageElement>("img[data-md-src]")) {
    const src = img.getAttribute("data-md-src") ?? "";
    if (/^(https?:|data:)/i.test(src)) {
      img.src = src;
      continue;
    }
    const path = resolveDocPath(doc.path, src);
    void use("vfs")
      .readFileBuffer(path)
      .then((buf) => {
        if (epoch !== previewEpoch) return;
        const mime = IMAGE_MIME[extOf(path)] ?? "application/octet-stream";
        const url = URL.createObjectURL(new Blob([buf as BlobPart], { type: mime }));
        previewBlobUrls.push(url);
        img.src = url;
      })
      .catch(() => {
        img.alt = `${img.alt || src} (missing: ${path})`;
        img.classList.add("md-img-missing");
      });
  }
}

function renderTabs(): void {
  if (!tabsEl) return;
  const frag = document.createDocumentFragment();
  for (const path of order) {
    const doc = docs.get(path);
    if (!doc) continue;
    const tab = h("div", "ftab");
    tab.classList.toggle("active", path === active);
    tab.title = path;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(path === active));

    const name = h("button", "name", basename(path));
    name.addEventListener("click", () => activate(path));
    tab.append(name);

    const x = h("button", "x", "×");
    x.title = `close ${basename(path)}`;
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      close(path);
    });
    tab.append(x);

    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) close(path);
    });
    frag.append(tab);
  }
  tabsEl.replaceChildren(frag);
}
