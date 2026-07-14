import { describe, expect, test } from "bun:test";
import { AutosaveScheduler, type SchedulerTimers } from "./autosave.ts";

/** Deterministic manual clock so debounce behavior is tested without real time. */
class FakeTimers implements SchedulerTimers {
  now = 0;
  #nextId = 1;
  #timers = new Map<number, { at: number; fn: () => void }>();

  set(fn: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clear(id: unknown): void {
    this.#timers.delete(id as number);
  }

  advance(ms: number): void {
    this.now += ms;
    const due = [...this.#timers.entries()]
      .filter(([, t]) => t.at <= this.now)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, t] of due) {
      this.#timers.delete(id);
      t.fn();
    }
  }
}

function make(delay = 400): { s: AutosaveScheduler; clock: FakeTimers; runs: string[] } {
  const clock = new FakeTimers();
  const s = new AutosaveScheduler(delay, clock);
  const runs: string[] = [];
  return { s, clock, runs };
}

describe("AutosaveScheduler", () => {
  test("fires once after the delay", () => {
    const { s, clock, runs } = make();
    s.schedule("a.ts", () => runs.push("a"));
    clock.advance(399);
    expect(runs).toEqual([]);
    clock.advance(1);
    expect(runs).toEqual(["a"]);
    expect(s.size).toBe(0);
  });

  test("rescheduling resets the trailing window (debounce)", () => {
    const { s, clock, runs } = make();
    s.schedule("a.ts", () => runs.push("first"));
    clock.advance(300);
    s.schedule("a.ts", () => runs.push("second"));
    clock.advance(300);
    expect(runs).toEqual([]); // 600ms elapsed but the timer was reset at 300
    clock.advance(100);
    expect(runs).toEqual(["second"]); // and the LATEST fn wins
  });

  test("keys debounce independently", () => {
    const { s, clock, runs } = make();
    s.schedule("a.ts", () => runs.push("a"));
    clock.advance(200);
    s.schedule("b.ts", () => runs.push("b"));
    clock.advance(200);
    expect(runs).toEqual(["a"]);
    clock.advance(200);
    expect(runs).toEqual(["a", "b"]);
  });

  test("flush runs the pending fn immediately and clears it", () => {
    const { s, clock, runs } = make();
    s.schedule("a.ts", () => runs.push("a"));
    s.flush("a.ts");
    expect(runs).toEqual(["a"]);
    expect(s.has("a.ts")).toBe(false);
    clock.advance(1000);
    expect(runs).toEqual(["a"]); // no double fire
  });

  test("flush of an unknown key is a no-op", () => {
    const { s, runs } = make();
    s.flush("nope.ts");
    expect(runs).toEqual([]);
  });

  test("flushAll drains every pending key (cmd+S)", () => {
    const { s, clock, runs } = make();
    s.schedule("a.ts", () => runs.push("a"));
    s.schedule("b.ts", () => runs.push("b"));
    s.flushAll();
    expect(runs.sort()).toEqual(["a", "b"]);
    expect(s.size).toBe(0);
    clock.advance(1000);
    expect(runs.length).toBe(2);
  });

  test("cancel drops a pending save without running it (file deleted)", () => {
    const { s, clock, runs } = make();
    s.schedule("a.ts", () => runs.push("a"));
    s.cancel("a.ts");
    clock.advance(1000);
    expect(runs).toEqual([]);
    expect(s.size).toBe(0);
  });

  test("has/keys/size reflect pending state", () => {
    const { s, clock } = make();
    s.schedule("a.ts", () => {});
    s.schedule("b.ts", () => {});
    expect(s.has("a.ts")).toBe(true);
    expect(s.keys().sort()).toEqual(["a.ts", "b.ts"]);
    expect(s.size).toBe(2);
    clock.advance(400);
    expect(s.size).toBe(0);
    expect(s.keys()).toEqual([]);
  });

  test("a key can be scheduled again after firing", () => {
    const { s, clock, runs } = make();
    s.schedule("a.ts", () => runs.push("1"));
    clock.advance(400);
    s.schedule("a.ts", () => runs.push("2"));
    clock.advance(400);
    expect(runs).toEqual(["1", "2"]);
  });
});
