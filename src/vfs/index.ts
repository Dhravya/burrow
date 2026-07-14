/**
 * Burrow — src/vfs/index.ts
 * Filesystem spine. Boot order position: FIRST (see CONTRACT.md §1).
 * Provides: "events" (TypedEventBus), "vfs" (WatchedFs over one InMemoryFs),
 * "gitFs" (GitFsAdapter over that same WatchedFs).
 *
 * Workspace persistence: the whole VFS is mirrored into IndexedDB (debounced
 * ~300ms after the last change + flush on visibilitychange/pagehide) and
 * restored here BEFORE seeding — the demo content is seeded only when nothing
 * was persisted (first boot) or the snapshot is corrupt/incompatible.
 * Restore is async (IndexedDB), so initVfs() stays synchronous per contract
 * and finishes the restore-or-seed in the background, announcing completion
 * with fs:batch{reason:"seed"}. Additive exports:
 *   - vfsReady(): Promise<void> — resolves once restore-or-seed completed
 *     (main.tsx may await it right after initVfs() so the first paint shows
 *     the restored workspace; nothing breaks if it doesn't).
 *   - resetWorkspace(): clears the persisted store, reseeds, emits events.
 * Registers the `workspace` (info|reset) terminal command.
 * Without IndexedDB (bun tests, exotic embeds) persistence degrades to
 * no-persistence — boot never throws because of it.
 */

import { InMemoryFs } from "just-bash/browser";
import { provide, registerShellCommand } from "../contract/registry.ts";
import { WORKSPACE_ROOT } from "../contract/types.ts";
import { TypedEventBus } from "./event-bus.ts";
import { GitFsAdapter } from "./git-fs-adapter.ts";
import { WorkspacePersistence } from "./persistence.ts";
import { SEED_FILES } from "./seed.ts";
import { createSnapshotStorage } from "./snapshot-storage.ts";
import { WatchedFs } from "./watched-fs.ts";
import { createWorkspaceCommand } from "./workspace-command.ts";

interface VfsRuntime {
  events: TypedEventBus;
  vfs: WatchedFs;
  persistence: WorkspacePersistence;
  ready: Promise<void>;
}

let runtime: VfsRuntime | null = null;

export function initVfs(): void {
  const events = new TypedEventBus();
  const store = new InMemoryFs();
  const vfs = new WatchedFs(store, events);
  const gitFs = new GitFsAdapter(vfs);

  provide("events", events);
  provide("vfs", vfs);
  provide("gitFs", gitFs);

  // Later modules assume the workspace root exists the moment they boot
  // (shell cwd, git dir default) — create it silently before restore runs.
  store.mkdirSync(WORKSPACE_ROOT, { recursive: true });

  const persistence = new WorkspacePersistence(vfs, events, createSnapshotStorage());

  try {
    registerShellCommand(createWorkspaceCommand({ vfs, persistence, reset: resetWorkspace }));
  } catch (error) {
    // Only reachable when the shell already sealed (never in the real boot
    // order) — losing the convenience command must not take the VFS down.
    console.warn('[burrow] could not register the "workspace" command', error);
  }

  const ready = (async () => {
    try {
      const result = await persistence.restore();
      if (result !== "restored") seedWorkspace(vfs);
    } catch (error) {
      // restore() never throws by design; this is pure belt-and-suspenders.
      console.error("[burrow] workspace restore failed unexpectedly — reseeding", error);
      seedWorkspace(vfs);
    }
    persistence.start();
    events.emit("fs:batch", { reason: "seed" });
  })();

  runtime = { events, vfs, persistence, ready };
}

/**
 * Additive helper: resolves once the persisted workspace was restored (or the
 * demo content seeded). Safe to call before initVfs() — resolves immediately.
 */
export function vfsReady(): Promise<void> {
  return runtime?.ready ?? Promise.resolve();
}

/**
 * Wipe the workspace root, clear the persisted snapshot, reseed the demo
 * content, and announce it (file:changed per top-level entry + one
 * fs:batch{reason:"seed"}). Also exposed as `workspace reset` in the terminal.
 */
export async function resetWorkspace(): Promise<void> {
  if (runtime === null) throw new Error("[burrow] resetWorkspace() called before initVfs()");
  const { events, vfs, persistence, ready } = runtime;
  await ready; // never reset mid-restore

  for (const name of await vfs.readdir(WORKSPACE_ROOT)) {
    await vfs.rm(`${WORKSPACE_ROOT}/${name}`, { recursive: true, force: true });
  }
  seedWorkspace(vfs, { emitEvents: true });
  events.emit("fs:batch", { reason: "seed" });

  await persistence.resetStorage();
  await persistence.flush(); // persist the fresh seed right away
}

/**
 * First-boot seeding. Silent by default (matches the old constructor-seeded
 * behavior — one fs:batch announces it); resetWorkspace() opts into per-file
 * events so panes and the persistence writer see the change.
 */
function seedWorkspace(vfs: WatchedFs, options?: { emitEvents?: boolean }): void {
  for (const [path, content] of Object.entries(SEED_FILES)) {
    if (options?.emitEvents) vfs.writeFileSync(path, content);
    else vfs.store.writeFileSync(path, content);
  }
}
