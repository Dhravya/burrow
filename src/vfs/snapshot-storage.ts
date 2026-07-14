/**
 * Burrow — src/vfs/snapshot-storage.ts
 * Storage backends for workspace snapshots.
 *
 * The interface is deliberately dumb IO: `load()` returns the RAW persisted
 * value (or null when nothing is stored) and the caller validates it with
 * decodeSnapshot() — so a corrupt database can never crash boot, it just
 * fails validation and falls back to a fresh seed.
 *
 * Backends:
 *  - IndexedDbSnapshotStorage — the real browser backend. One database, one
 *    object store; per-file records keyed by absolute path plus a single meta
 *    record under a NUL key (paths can never contain NUL / always start "/").
 *  - MemorySnapshotStorage — in-memory stand-in for bun tests (no IndexedDB)
 *    with save/clear counters and an injectable raw value for corruption tests.
 *
 * createSnapshotStorage() feature-detects: no IndexedDB -> null -> the
 * persistence layer degrades to no-persistence without ever throwing.
 */

import type { WorkspaceSnapshot } from "./snapshot.ts";

export interface SnapshotStorage {
  readonly kind: "indexeddb" | "memory";
  /** Raw, UNVALIDATED persisted value; null when nothing is stored. */
  load(): Promise<unknown>;
  /** Replace the persisted state with this snapshot atomically. */
  save(snapshot: WorkspaceSnapshot): Promise<void>;
  /** Drop all persisted state (next boot seeds fresh). */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------- memory ---

/** Test/in-memory backend. `structuredClone` keeps Uint8Array fidelity. */
export class MemorySnapshotStorage implements SnapshotStorage {
  readonly kind = "memory" as const;
  raw: unknown;
  saveCount = 0;
  clearCount = 0;
  /** Test hook: make the next save() reject once. */
  failNextSave = false;

  constructor(initialRaw: unknown = null) {
    this.raw = initialRaw;
  }

  async load(): Promise<unknown> {
    return this.raw === null || this.raw === undefined ? null : structuredClone(this.raw);
  }

  async save(snapshot: WorkspaceSnapshot): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("MemorySnapshotStorage: simulated save failure");
    }
    this.saveCount += 1;
    this.raw = structuredClone(snapshot);
  }

  async clear(): Promise<void> {
    this.clearCount += 1;
    this.raw = null;
  }
}

// ------------------------------------------------------------- indexeddb ---

const DB_NAME = "burrow-workspace";
const DB_VERSION = 1;
const FILES_STORE = "files";
/** Reserved meta key: real paths always start "/" and can never contain NUL. */
const META_KEY = "\u0000meta";

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class IndexedDbSnapshotStorage implements SnapshotStorage {
  readonly kind = "indexeddb" as const;
  readonly #dbName: string;
  #dbPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName: string = DB_NAME) {
    this.#dbName = dbName;
  }

  #open(): Promise<IDBDatabase> {
    if (this.#dbPromise === null) {
      this.#dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.#dbName, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(FILES_STORE)) db.createObjectStore(FILES_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      });
      // A failed open must not be cached forever (e.g. transient quota error).
      this.#dbPromise.catch(() => {
        this.#dbPromise = null;
      });
    }
    return this.#dbPromise;
  }

  async load(): Promise<unknown> {
    const db = await this.#open();
    const tx = db.transaction(FILES_STORE, "readonly");
    const store = tx.objectStore(FILES_STORE);
    // getAllKeys/getAll both return in key order, so index i lines up.
    const keysReq = store.getAllKeys();
    const valuesReq = store.getAll();
    const [keys, values] = await Promise.all([requestToPromise(keysReq), requestToPromise(valuesReq)]);
    await transactionDone(tx);

    if (keys.length === 0) return null; // first boot — nothing persisted

    let meta: unknown = null;
    const files: Record<string, unknown> = {};
    keys.forEach((key, i) => {
      if (key === META_KEY) meta = values[i];
      else if (typeof key === "string") files[key] = values[i];
    });

    // Reassemble the snapshot shape; a missing/garbled meta record yields a
    // value that fails decodeSnapshot() and reseeds — never a crash.
    const m = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
    return { version: m.version, savedAt: m.savedAt, files };
  }

  async save(snapshot: WorkspaceSnapshot): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(FILES_STORE, "readwrite");
    const store = tx.objectStore(FILES_STORE);
    store.clear();
    store.put({ version: snapshot.version, savedAt: snapshot.savedAt }, META_KEY);
    for (const [path, entry] of Object.entries(snapshot.files)) {
      store.put(entry, path);
    }
    await transactionDone(tx);
  }

  async clear(): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(FILES_STORE, "readwrite");
    tx.objectStore(FILES_STORE).clear();
    await transactionDone(tx);
  }
}

/** Browser gets IndexedDB; anywhere without it (bun tests, exotic embeds) gets null = persistence off. */
export function createSnapshotStorage(): SnapshotStorage | null {
  try {
    if (typeof indexedDB === "undefined" || indexedDB === null) return null;
    return new IndexedDbSnapshotStorage();
  } catch {
    return null;
  }
}
