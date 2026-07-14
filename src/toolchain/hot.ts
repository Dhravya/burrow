/**
 * Burrow src/toolchain — hot-reload primitives (pure, unit-tested).
 *
 * A live server session watches the VFS: when a path that participated in the
 * last build changes, the session rebuilds the graph and swaps its worker.
 * The two decisions that need to be exactly right live here as pure functions:
 *
 *  - collectWatchedPaths: which VFS paths belong to a build. Every module in
 *    the graph, plus every ancestor package.json of each module — those decide
 *    bare-import version pinning (esm.sh @version), so creating/editing one
 *    changes the build even though it is never imported.
 *
 *  - createHotDebouncer: trailing-edge debounce that coalesces a burst of
 *    file:changed events (editor save + git checkout touch many files) into
 *    one reload, with injectable timers so tests drive time synchronously.
 */

import { dirname } from "./paths.ts";

// ---------------------------------------------------------------------------
// Graph membership
// ---------------------------------------------------------------------------

/**
 * The set of absolute VFS paths whose mutation invalidates a build made from
 * `modulePaths` (the BuiltModule.path list of a successful buildGraph).
 */
export function collectWatchedPaths(modulePaths: Iterable<string>): Set<string> {
  const watched = new Set<string>();
  for (const path of modulePaths) {
    watched.add(path);
    // Walk up: every ancestor package.json influences esm.sh version pinning.
    let dir = dirname(path);
    for (;;) {
      watched.add(dir === "/" ? "/package.json" : `${dir}/package.json`);
      if (dir === "/" || dir === ".") break;
      dir = dirname(dir);
    }
  }
  return watched;
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

export interface HotDebouncer {
  /** Record a changed path; (re)arms the trailing timer. */
  notify(path: string): void;
  /** Cancel any pending fire and drop collected paths. */
  dispose(): void;
}

export interface HotDebouncerOptions {
  delayMs: number;
  /** Fired once per quiet period with the unique changed paths, in first-seen order. */
  onFire: (paths: string[]) => void;
  /** Injectable timers (tests); default to the global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export function createHotDebouncer(options: HotDebouncerOptions): HotDebouncer {
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));

  let pending = new Set<string>();
  let timer: unknown = null;
  let disposed = false;

  const fire = (): void => {
    timer = null;
    if (disposed || pending.size === 0) return;
    const paths = [...pending];
    pending = new Set();
    options.onFire(paths);
  };

  return {
    notify(path: string): void {
      if (disposed) return;
      pending.add(path);
      if (timer !== null) clearTimer(timer);
      timer = setTimer(fire, options.delayMs);
    },
    dispose(): void {
      disposed = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pending.clear();
    },
  };
}
