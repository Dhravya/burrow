/**
 * Burrow — per-key trailing debounce that backs editor autosave (src/ui
 * internal). Pure scheduling logic: timers are injectable so the behavior is
 * unit-testable without real time.
 */

export const AUTOSAVE_DELAY_MS = 400;

export interface SchedulerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const realTimers: SchedulerTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

interface Pending {
  id: unknown;
  fn: () => void;
}

export class AutosaveScheduler {
  readonly #delay: number;
  readonly #timers: SchedulerTimers;
  readonly #pending = new Map<string, Pending>();

  constructor(delayMs: number = AUTOSAVE_DELAY_MS, timers: SchedulerTimers = realTimers) {
    this.#delay = delayMs;
    this.#timers = timers;
  }

  /** (Re)start the trailing timer for `key`; the latest fn wins. */
  schedule(key: string, fn: () => void): void {
    const prev = this.#pending.get(key);
    if (prev) this.#timers.clear(prev.id);
    const id = this.#timers.set(() => {
      this.#pending.delete(key);
      fn();
    }, this.#delay);
    this.#pending.set(key, { id, fn });
  }

  /** Run the pending fn for `key` right now (no-op when nothing is pending). */
  flush(key: string): void {
    const p = this.#pending.get(key);
    if (!p) return;
    this.#timers.clear(p.id);
    this.#pending.delete(key);
    p.fn();
  }

  /** Flush every pending key (used by cmd/ctrl+S). */
  flushAll(): void {
    for (const key of [...this.#pending.keys()]) this.flush(key);
  }

  /** Drop a pending save without running it (file closed by deletion). */
  cancel(key: string): void {
    const p = this.#pending.get(key);
    if (!p) return;
    this.#timers.clear(p.id);
    this.#pending.delete(key);
  }

  has(key: string): boolean {
    return this.#pending.has(key);
  }

  keys(): string[] {
    return [...this.#pending.keys()];
  }

  get size(): number {
    return this.#pending.size;
  }
}
