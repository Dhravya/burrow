/**
 * Burrow — bottom status bar: cwd, current git branch, run state, preview link
 * (src/ui internal). Everything is event-driven off the bus + registry.
 */
import { use, tryUse } from "../contract/registry.ts";
import { PREVIEW_PREFIX, WORKSPACE_ROOT } from "../contract/types.ts";
import { onRunState } from "./run-state.ts";
import { onSaveState } from "./editor.ts";
import { findRepoRoots, repoRootFor } from "./git-util.ts";
import { debounce, tildify } from "./util.ts";

export interface StatusBarEls {
  cwd: HTMLElement;
  branch: HTMLElement;
  save: HTMLElement;
  run: HTMLElement;
  preview: HTMLElement;
}

export function initStatusBar(els: StatusBarEls): void {
  const events = use("events");
  let cwd = tryUse("shell")?.getCwd() ?? WORKSPACE_ROOT;

  function paintCwd(): void {
    els.cwd.textContent = tildify(cwd);
  }
  paintCwd();

  events.on("cwd:changed", (e) => {
    cwd = e.cwd;
    paintCwd();
    refreshBranch();
  });

  const refreshBranch = debounce(() => void updateBranch(), 250);
  events.on("fs:batch", () => refreshBranch());
  events.on("file:changed", (e) => {
    // Branch only moves on ref/HEAD churn — cheap filter to avoid spamming git.
    if (e.path.includes("/.git/")) refreshBranch();
  });

  async function updateBranch(): Promise<void> {
    const git = tryUse("git");
    const vfs = tryUse("vfs");
    if (!git || !vfs) {
      els.branch.hidden = true;
      return;
    }
    const roots = findRepoRoots(vfs.getAllPaths());
    const root = repoRootFor(cwd, roots) ?? roots[0];
    if (!root) {
      els.branch.hidden = true;
      return;
    }
    try {
      const branch = await git.currentBranch(root);
      if (branch) {
        els.branch.textContent = branch;
        els.branch.hidden = false;
      } else {
        els.branch.textContent = "detached";
        els.branch.hidden = false;
      }
    } catch {
      els.branch.hidden = true;
    }
  }
  void updateBranch();

  // Transient autosave indicator: "saving…" while edits are pending/writing,
  // a brief "saved" that fades out, and a sticky red note when a write failed.
  let saveFade: number | undefined;
  let saveHide: number | undefined;
  onSaveState((s) => {
    window.clearTimeout(saveFade);
    window.clearTimeout(saveHide);
    els.save.classList.remove("ok", "err", "fade");
    if (s.kind === "idle") {
      els.save.hidden = true;
      return;
    }
    els.save.hidden = false;
    if (s.kind === "saving") {
      els.save.textContent = "saving…";
    } else if (s.kind === "saved") {
      els.save.textContent = "saved";
      els.save.classList.add("ok");
      saveFade = window.setTimeout(() => els.save.classList.add("fade"), 1200);
      saveHide = window.setTimeout(() => {
        els.save.hidden = true;
      }, 1700);
    } else {
      els.save.textContent = `save failed · ${s.detail}`;
      els.save.classList.add("err");
    }
  });

  onRunState((s) => {
    els.run.textContent =
      s.running === 0
        ? "idle"
        : s.previewLive
          ? `server live · ${s.running} running`
          : `${s.running} running`;
    els.run.classList.toggle("live", s.running > 0);
    els.preview.hidden = !s.previewLive;
    els.preview.setAttribute("href", `${PREVIEW_PREFIX}/`);
  });
}
