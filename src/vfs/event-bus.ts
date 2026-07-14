/**
 * Burrow — src/vfs/event-bus.ts
 * Typed emitter over BurrowEventMap. Handler exceptions are isolated:
 * a throwing subscriber never breaks the emitter or its siblings.
 */

import type { BurrowEventMap, EventBus } from "../contract/types.ts";

type AnyHandler = (event: unknown) => void;

export class TypedEventBus implements EventBus {
  readonly #handlers = new Map<keyof BurrowEventMap, Set<AnyHandler>>();

  on<K extends keyof BurrowEventMap>(type: K, handler: (event: BurrowEventMap[K]) => void): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    const erased = handler as AnyHandler;
    set.add(erased);
    return () => {
      set.delete(erased);
    };
  }

  emit<K extends keyof BurrowEventMap>(type: K, event: BurrowEventMap[K]): void {
    const set = this.#handlers.get(type);
    if (!set || set.size === 0) return;
    // Snapshot so handlers that (un)subscribe during dispatch don't skew iteration.
    for (const handler of [...set]) {
      try {
        handler(event);
      } catch (error) {
        console.error(`[burrow] "${String(type)}" event handler threw:`, error);
      }
    }
  }
}
