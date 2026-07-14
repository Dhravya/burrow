/**
 * Burrow — src/vfs/persistence.ts
 * WorkspacePersistence: keeps the live VFS mirrored into a SnapshotStorage so
 * the workspace survives page reloads.
 *
 *  - restore(): load + validate + apply the persisted snapshot onto the fresh
 *    store. Runs BEFORE seeding — the caller seeds only when this does not
 *    return "restored". Corrupt/incompatible/unreadable snapshots degrade to a
 *    fresh seed; boot never crashes on persistence.
 *  - start(): subscribe to "file:changed" and schedule a debounced save
 *    (DEBOUNCE_MS after the LAST change — bursts like `git clone` coalesce
 *    into one write), plus flush-on-visibilitychange/pagehide so a closing tab
 *    doesn't lose the tail of the debounce window.
 *  - Saves are full snapshots written atomically (clear+put in one IndexedDB
 *    transaction) and serialized on an internal queue — no torn states.
 *
 * With a null storage (no IndexedDB) every method is a graceful no-op.
 */

import type { EventBus } from "../contract/types.ts";
import type { SnapshotStorage } from "./snapshot-storage.ts";
import { applySnapshot, captureSnapshot, decodeSnapshot, snapshotStats, wipeStore } from "./snapshot.ts";
import type { WatchedFs } from "./watched-fs.ts";

/** ~300ms after the last VFS change event (see mission/CONTRACT notes). */
export const DEBOUNCE_MS = 300;

export type RestoreResult =
  | "restored" //  snapshot applied — do NOT seed
  | "empty" //     nothing persisted (first boot) — seed
  | "corrupt" //   snapshot failed validation/apply — cleared, seed
  | "error" //     storage unreadable — seed (persistence may still work later)
  | "disabled"; // no storage backend — seed

export interface PersistenceInfo {
  backend: "indexeddb" | "memory" | "none";
  /** Epoch ms of the last successful save (or the restored snapshot's). */
  lastSavedAt: number | null;
  lastSaveFileCount: number | null;
  lastSaveBytes: number | null;
  /** True when changes are waiting for the debounced writer. */
  dirty: boolean;
}

export class WorkspacePersistence {
  readonly #vfs: WatchedFs;
  readonly #events: EventBus;
  readonly #storage: SnapshotStorage | null;
  readonly #debounceMs: number;

  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #queue: Promise<void> = Promise.resolve();
  #started = false;
  #offFileChanged: (() => void) | null = null;
  #warnedSaveFailure = false;
  #lastSaved: { at: number; fileCount: number; bytes: number } | null = null;

  readonly #onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") void this.flush();
  };
  readonly #onPageHide = (): void => {
    void this.flush();
  };

  constructor(vfs: WatchedFs, events: EventBus, storage: SnapshotStorage | null, options?: { debounceMs?: number }) {
    this.#vfs = vfs;
    this.#events = events;
    this.#storage = storage;
    this.#debounceMs = options?.debounceMs ?? DEBOUNCE_MS;
  }

  get enabled(): boolean {
    return this.#storage !== null;
  }

  /** Apply the persisted snapshot onto the (still fresh) store. Never throws. */
  async restore(): Promise<RestoreResult> {
    if (this.#storage === null) return "disabled";

    let raw: unknown;
    try {
      raw = await this.#storage.load();
    } catch (error) {
      console.warn("[burrow] workspace snapshot could not be read — starting fresh", error);
      return "error";
    }
    if (raw === null || raw === undefined) return "empty";

    const snapshot = decodeSnapshot(raw);
    if (snapshot === null) {
      console.warn("[burrow] persisted workspace snapshot is corrupt or from an incompatible version — reseeding");
      await this.#clearStorageQuietly();
      return "corrupt";
    }
    if (Object.keys(snapshot.files).length === 0) return "empty";

    try {
      await applySnapshot(this.#vfs.store, snapshot);
    } catch (error) {
      console.warn("[burrow] persisted workspace snapshot failed to apply — reseeding", error);
      try {
        await wipeStore(this.#vfs.store);
      } catch {
        // a partially wiped store still gets reseeded over
      }
      await this.#clearStorageQuietly();
      return "corrupt";
    }

    const stats = snapshotStats(snapshot);
    this.#lastSaved = { at: snapshot.savedAt, fileCount: stats.fileCount, bytes: stats.bytes };
    return "restored";
  }

  /** Begin watching the bus + page lifecycle. Idempotent. */
  start(): void {
    if (this.#started || this.#storage === null) return;
    this.#started = true;
    this.#offFileChanged = this.#events.on("file:changed", () => this.markDirty());
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this.#onVisibilityChange);
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", this.#onPageHide);
    }
  }

  /** Detach listeners and cancel any pending debounce (tests / teardown). */
  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#offFileChanged?.();
    this.#offFileChanged = null;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this.#onVisibilityChange);
    }
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("pagehide", this.#onPageHide);
    }
  }

  /** Note a change and (re)arm the debounced writer. */
  markDirty(): void {
    if (this.#storage === null) return;
    this.#dirty = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#saveNow();
    }, this.#debounceMs);
  }

  /** Persist pending changes immediately (visibilitychange/pagehide/reset). */
  flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#dirty) return this.#saveNow();
    return this.#queue;
  }

  /** Drop all persisted state (workspace reset). Never throws. */
  async resetStorage(): Promise<void> {
    if (this.#storage === null) return;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#queue.catch(() => {});
    await this.#clearStorageQuietly();
    this.#lastSaved = null;
  }

  info(): PersistenceInfo {
    return {
      backend: this.#storage?.kind ?? "none",
      lastSavedAt: this.#lastSaved?.at ?? null,
      lastSaveFileCount: this.#lastSaved?.fileCount ?? null,
      lastSaveBytes: this.#lastSaved?.bytes ?? null,
      dirty: this.#dirty,
    };
  }

  #saveNow(): Promise<void> {
    this.#dirty = false;
    this.#queue = this.#queue.then(async () => {
      const storage = this.#storage;
      if (storage === null) return;
      try {
        const snapshot = await captureSnapshot(this.#vfs);
        await storage.save(snapshot);
        const stats = snapshotStats(snapshot);
        this.#lastSaved = { at: snapshot.savedAt, fileCount: stats.fileCount, bytes: stats.bytes };
        this.#warnedSaveFailure = false;
      } catch (error) {
        this.#dirty = true; // retry on the next change/flush
        if (!this.#warnedSaveFailure) {
          this.#warnedSaveFailure = true;
          console.warn("[burrow] workspace snapshot save failed — changes stay in memory only", error);
        }
      }
    });
    return this.#queue;
  }

  async #clearStorageQuietly(): Promise<void> {
    try {
      await this.#storage?.clear();
    } catch (error) {
      console.warn("[burrow] workspace snapshot store could not be cleared", error);
    }
  }
}
