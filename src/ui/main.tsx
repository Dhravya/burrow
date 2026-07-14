/**
 * Burrow — frontend entry (src/ui).
 *
 * This is sanctioned cross-module import point #1 (CONTRACT.md §1): it imports
 * each module's fixed init entrypoint and runs them in the frozen boot order
 *   initVfs → initGit → await initToolchain → initNpm → initAi → await initShell
 * (initNpm MUST run after initToolchain — its `bun` spec shadows the
 * toolchain's via just-bash's last-registration-wins command map — and before
 * initShell, which seals the command registry at Bash construction time)
 * then wires the shell UI (editor, file tree, diff, console, preview, status,
 * transport, resizers). Every panel talks to the rest of the app only through
 * the registry + event bus.
 *
 * Boot is resilient: the VFS spine is fatal if it fails, but a module that is
 * missing or half-built only degrades its own feature — the rest still mounts.
 */
import { initVfs, vfsReady } from "../vfs/index.ts";
import { tryUse } from "../contract/registry.ts";
import { WORKSPACE_ROOT } from "../contract/types.ts";
import { initGit } from "../git/index.ts";
import { initToolchain } from "../toolchain/index.ts";
import { initNpm } from "../npm/index.ts";
import { initAi } from "../ai/index.ts";
import { initShell } from "../shell/index.ts";

import { must } from "./util.ts";
import { getActivePath, initEditor } from "./editor.ts";
import { initFileTree } from "./filetree.ts";
import { initDiffPanel } from "./diff.ts";
import { initTabs } from "./tabs.ts";
import { initRunState } from "./run-state.ts";
import { initConsole } from "./console.ts";
import { initStatusBar } from "./statusbar.ts";
import { initTransport } from "./transport.ts";
import { initPreview } from "./preview.ts";
import { initResizers } from "./layout.ts";
import { initMobileNav } from "./mobile.ts";

const degraded: string[] = [];

function step(name: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    degraded.push(name);
    console.error(`[burrow] "${name}" init failed`, err);
  }
}

async function stepAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    degraded.push(name);
    console.error(`[burrow] "${name}" init failed`, err);
  }
}

async function boot(): Promise<void> {
  // ── Module boot order (CONTRACT.md §1). The VFS is the spine; without it
  //    nothing else can function, so its failure is fatal.
  try {
    initVfs();
  } catch (err) {
    console.error("[burrow] fatal: filesystem failed to start", err);
    showBanner("Burrow couldn't start its filesystem — check the console", "err");
    return;
  }
  step("git", () => initGit());
  await stepAsync("toolchain", () => initToolchain());
  step("npm", () => initNpm());
  step("ai", () => initAi(must("ai-panel")));
  await stepAsync("shell", () => initShell(must("terminal")));

  // ── UI wiring (all registry services are up now) ─────────────────────────
  initRunState();
  initEditor(must("editor-tabs"), must("editor-host"), must("editor-empty"));
  initFileTree(must("file-tree"), must("tree-count"), {
    newFile: must("tree-new-file"),
    newDir: must("tree-new-dir"),
  });

  const rightTabs = initTabs(must("right-tabs"), must("right-panels"), "ai");
  const bottomTabs = initTabs(must("bottom-tabs"), must("bottom-panels"), "terminal");

  initDiffPanel({
    files: must("diff-files"),
    head: must("diff-head"),
    st: must("diff-st"),
    path: must("diff-path"),
    note: must("diff-note"),
    openBtn: must("diff-open"),
    host: must("diff-host"),
    empty: must("diff-empty"),
    count: must("diff-count"),
  });

  initConsole(must("console-scroll"), must("console-clear"), bottomTabs);

  initPreview({
    frame: must("preview-frame") as HTMLIFrameElement,
    reload: must("preview-reload"),
    tabs: bottomTabs,
  });

  initStatusBar({
    cwd: must("sb-cwd"),
    branch: must("sb-branch"),
    save: must("sb-save"),
    run: must("sb-run"),
    preview: must("sb-preview"),
  });

  initTransport({
    led: must("run-led"),
    run: must("btn-run") as HTMLButtonElement,
    stop: must("btn-stop") as HTMLButtonElement,
  });

  initResizers(must("app"));
  initMobileNav(must("app"), must("mobile-nav"));

  // Land on the rendered README (tab state isn't persisted, so every load
  // starts empty — the README is the front door). Skipped if something is
  // already open, e.g. a fast `edit <file>` racing restore-or-seed.
  void vfsReady().then(async () => {
    const vfs = tryUse("vfs");
    const events = tryUse("events");
    const readme = `${WORKSPACE_ROOT}/README.md`;
    if (!vfs || !events || getActivePath() !== null) return;
    if (await vfs.exists(readme)) events.emit("editor:open", { path: readme });
  });

  if (degraded.length > 0) {
    showBanner(`offline: ${degraded.join(", ")} — the rest of Burrow still works`, "warn");
  }
}

function showBanner(text: string, kind: "warn" | "err"): void {
  const el = document.getElementById("boot-banner");
  if (!el) return;
  el.textContent = text;
  el.className = `banner banner-${kind}`;
  el.hidden = false;
  if (kind === "warn") {
    window.setTimeout(() => {
      el.classList.add("fade");
    }, 6000);
  }
}

void boot();
