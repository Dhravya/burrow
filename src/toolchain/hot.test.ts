/**
 * Burrow src/toolchain — hot-reload primitive tests (pure functions).
 *
 * collectWatchedPaths: which VFS paths invalidate a build (graph membership).
 * createHotDebouncer: trailing-edge coalescing with injectable fake timers.
 */

import { describe, expect, test } from "bun:test";
import { collectWatchedPaths, createHotDebouncer } from "./hot.ts";

// ---------------------------------------------------------------------------
// Graph membership
// ---------------------------------------------------------------------------

describe("collectWatchedPaths", () => {
  const modules = ["/home/user/demo/server.ts", "/home/user/demo/lib/greet.ts"];

  test("every module in the graph is watched", () => {
    const watched = collectWatchedPaths(modules);
    expect(watched.has("/home/user/demo/server.ts")).toBe(true);
    expect(watched.has("/home/user/demo/lib/greet.ts")).toBe(true);
  });

  test("ancestor package.jsons are watched (they pin esm.sh versions)", () => {
    const watched = collectWatchedPaths(modules);
    for (const pkg of [
      "/home/user/demo/lib/package.json",
      "/home/user/demo/package.json",
      "/home/user/package.json",
      "/home/package.json",
      "/package.json",
    ]) {
      expect(watched.has(pkg)).toBe(true);
    }
  });

  test("unrelated files are NOT watched", () => {
    const watched = collectWatchedPaths(modules);
    expect(watched.has("/home/user/demo/README.md")).toBe(false);
    expect(watched.has("/home/user/demo/other.ts")).toBe(false);
    expect(watched.has("/home/user/other-project/index.ts")).toBe(false);
    expect(watched.has("/home/user/demo/lib/nested/package.json")).toBe(false);
  });

  test("empty graph watches nothing", () => {
    expect(collectWatchedPaths([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

function makeFakeClock() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer(fn: () => void, ms: number): unknown {
      const id = nextId++;
      timers.set(id, { at: currentTime + ms, fn });
      return id;
    },
    clearTimer(id: unknown): void {
      timers.delete(id as number);
    },
    advance(ms: number): void {
      const target = currentTime + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const timer = timers.get(dueId)!;
        timers.delete(dueId);
        currentTime = timer.at;
        timer.fn();
      }
      currentTime = target;
    },
  };
}

describe("createHotDebouncer", () => {
  function setup(delayMs = 200) {
    const clock = makeFakeClock();
    const fires: string[][] = [];
    const debouncer = createHotDebouncer({
      delayMs,
      onFire: (paths) => fires.push(paths),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    return { clock, fires, debouncer };
  }

  test("a burst of changes coalesces into ONE fire with unique paths in order", () => {
    const { clock, fires, debouncer } = setup();
    debouncer.notify("/p/a.ts");
    debouncer.notify("/p/b.ts");
    debouncer.notify("/p/a.ts"); // duplicate
    clock.advance(199);
    expect(fires.length).toBe(0); // still inside the quiet window
    clock.advance(1);
    expect(fires).toEqual([["/p/a.ts", "/p/b.ts"]]);
  });

  test("trailing edge: each notify RESETS the timer", () => {
    const { clock, fires, debouncer } = setup();
    debouncer.notify("/p/a.ts"); // t=0, would fire at 200
    clock.advance(150);
    debouncer.notify("/p/b.ts"); // t=150, pushes fire to 350
    clock.advance(150); // t=300 — nothing yet
    expect(fires.length).toBe(0);
    clock.advance(50); // t=350
    expect(fires).toEqual([["/p/a.ts", "/p/b.ts"]]);
  });

  test("changes after a fire schedule a fresh fire", () => {
    const { clock, fires, debouncer } = setup();
    debouncer.notify("/p/a.ts");
    clock.advance(200);
    debouncer.notify("/p/c.ts");
    clock.advance(200);
    expect(fires).toEqual([["/p/a.ts"], ["/p/c.ts"]]);
  });

  test("dispose cancels the pending fire and ignores later notifies", () => {
    const { clock, fires, debouncer } = setup();
    debouncer.notify("/p/a.ts");
    debouncer.dispose();
    clock.advance(1000);
    debouncer.notify("/p/b.ts");
    clock.advance(1000);
    expect(fires.length).toBe(0);
  });
});
