/**
 * Burrow — src/vfs/persistence.test.ts
 * Workspace persistence: snapshot round-trip, restore-before-seed, corrupt
 * snapshot fallback, debounce coalescing, flush, and graceful degradation
 * without IndexedDB. Registry-free: everything is constructed directly so
 * this file can run alongside index.test.ts in one process.
 */

import { describe, expect, test } from "bun:test";
import { InMemoryFs } from "just-bash/browser";
import { TypedEventBus } from "./event-bus.ts";
import { WorkspacePersistence } from "./persistence.ts";
import { createSnapshotStorage, MemorySnapshotStorage, type SnapshotStorage } from "./snapshot-storage.ts";
import {
  applySnapshot,
  captureSnapshot,
  decodeSnapshot,
  S_IFDIR,
  S_IFREG,
  SNAPSHOT_VERSION,
  snapshotStats,
} from "./snapshot.ts";
import { WatchedFs } from "./watched-fs.ts";
import { createWorkspaceCommand } from "./workspace-command.ts";
import type { CommandContext } from "../contract/types.ts";

function makeFs(): { events: TypedEventBus; store: InMemoryFs; vfs: WatchedFs } {
  const events = new TypedEventBus();
  const store = new InMemoryFs();
  const vfs = new WatchedFs(store, events);
  return { events, store, vfs };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// snapshot codec
// ---------------------------------------------------------------------------

describe("snapshot round-trip", () => {
  test("files (text + binary), dirs, symlinks, modes and mtimes survive capture → apply", async () => {
    const a = makeFs();
    a.vfs.mkdirSync("/home/user/project/src", { recursive: true });
    await a.vfs.writeFile("/home/user/project/src/app.ts", "export const x = 1;\n");
    await a.vfs.writeFile("/home/user/project/blob.bin", new Uint8Array([0, 1, 128, 255]));
    await a.vfs.chmod("/home/user/project/src/app.ts", 0o755);
    await a.vfs.utimes("/home/user/project/src/app.ts", 0, new Date(1234567890000));
    await a.vfs.symlink("./src/app.ts", "/home/user/project/link.ts");
    await a.vfs.mkdir("/home/user/project/empty");

    const snapshot = await captureSnapshot(a.vfs);

    const b = makeFs();
    await applySnapshot(b.store, snapshot);

    expect(b.store.getAllPaths().sort()).toEqual(a.store.getAllPaths().sort());
    expect(await b.vfs.readFile("/home/user/project/src/app.ts")).toBe("export const x = 1;\n");
    expect(Array.from(await b.vfs.readFileBuffer("/home/user/project/blob.bin"))).toEqual([0, 1, 128, 255]);

    const st = await b.vfs.lstat("/home/user/project/src/app.ts");
    expect(st.mode & 0o777).toBe(0o755);
    expect(st.mtime.getTime()).toBe(1234567890000);

    const link = await b.vfs.lstat("/home/user/project/link.ts");
    expect(link.isSymbolicLink).toBe(true);
    expect(await b.vfs.readlink("/home/user/project/link.ts")).toBe("./src/app.ts");
    expect(await b.vfs.readFile("/home/user/project/link.ts")).toBe("export const x = 1;\n");

    expect((await b.vfs.stat("/home/user/project/empty")).isDirectory).toBe(true);
  });

  test("survives a save → load → decode trip through storage", async () => {
    const a = makeFs();
    await a.vfs.writeFile("/home/user/hello.txt", "hi");
    await a.vfs.writeFile("/home/user/raw.bin", new Uint8Array([7, 8, 9]));
    const snapshot = await captureSnapshot(a.vfs);

    const storage = new MemorySnapshotStorage();
    await storage.save(snapshot);
    const decoded = decodeSnapshot(await storage.load());
    expect(decoded).not.toBeNull();

    const b = makeFs();
    await applySnapshot(b.store, decoded!);
    expect(await b.vfs.readFile("/home/user/hello.txt")).toBe("hi");
    expect(Array.from(await b.vfs.readFileBuffer("/home/user/raw.bin"))).toEqual([7, 8, 9]);
  });

  test("snapshotStats counts non-directory entries and content bytes", async () => {
    const a = makeFs();
    a.vfs.mkdirSync("/home/user/dir", { recursive: true });
    await a.vfs.writeFile("/home/user/a.txt", "1234"); // 4 bytes
    await a.vfs.writeFile("/home/user/b.bin", new Uint8Array(10)); // 10 bytes
    const stats = snapshotStats(await captureSnapshot(a.vfs));
    expect(stats.fileCount).toBe(2);
    expect(stats.bytes).toBe(14);
  });
});

describe("decodeSnapshot validation", () => {
  const entry = { content: "x", mode: S_IFREG | 0o644, mtime: 1 };

  test("accepts a well-formed snapshot", () => {
    const good = { version: SNAPSHOT_VERSION, savedAt: 5, files: { "/a": entry } };
    expect(decodeSnapshot(good)).not.toBeNull();
  });

  test.each([
    ["not an object", "garbage"],
    ["null", null],
    ["wrong version", { version: SNAPSHOT_VERSION + 1, savedAt: 1, files: {} }],
    ["missing version", { savedAt: 1, files: {} }],
    ["non-numeric savedAt", { version: SNAPSHOT_VERSION, savedAt: "x", files: {} }],
    ["files not an object", { version: SNAPSHOT_VERSION, savedAt: 1, files: 3 }],
    ["relative path key", { version: SNAPSHOT_VERSION, savedAt: 1, files: { "a/b": entry } }],
    ["root path key", { version: SNAPSHOT_VERSION, savedAt: 1, files: { "/": entry } }],
    ["non-entry value", { version: SNAPSHOT_VERSION, savedAt: 1, files: { "/a": 42 } }],
    ["bad content", { version: SNAPSHOT_VERSION, savedAt: 1, files: { "/a": { ...entry, content: 42 } } }],
    ["bad mode", { version: SNAPSHOT_VERSION, savedAt: 1, files: { "/a": { ...entry, mode: "w" } } }],
    ["bad mtime", { version: SNAPSHOT_VERSION, savedAt: 1, files: { "/a": { ...entry, mtime: Number.NaN } } }],
  ])("rejects %s", (_name, raw) => {
    expect(decodeSnapshot(raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// restore-before-seed
// ---------------------------------------------------------------------------

describe("restore before seed", () => {
  test("a persisted workspace is restored and wins over seeding", async () => {
    // session 1: seeded box + a user edit, flushed to storage
    const storage = new MemorySnapshotStorage();
    const one = makeFs();
    one.store.mkdirSync("/home/user", { recursive: true });
    one.store.writeFileSync("/home/user/README.md", "seeded");
    const pOne = new WorkspacePersistence(one.vfs, one.events, storage, { debounceMs: 5 });
    pOne.start();
    await one.vfs.writeFile("/home/user/notes.txt", "user data survives reloads");
    await pOne.flush();
    pOne.stop();
    expect(storage.saveCount).toBe(1);

    // session 2 (the "reload"): restore runs BEFORE any seeding decision
    const two = makeFs();
    two.store.mkdirSync("/home/user", { recursive: true });
    const pTwo = new WorkspacePersistence(two.vfs, two.events, storage, { debounceMs: 5 });
    const result = await pTwo.restore();
    expect(result).toBe("restored");
    expect(await two.vfs.readFile("/home/user/notes.txt")).toBe("user data survives reloads");
    expect(await two.vfs.readFile("/home/user/README.md")).toBe("seeded");
    // callers only seed when result !== "restored" — nothing to overwrite here
    expect(pTwo.info().lastSavedAt).not.toBeNull();
  });

  test("an empty store reports 'empty' (first boot → caller seeds)", async () => {
    const f = makeFs();
    const p = new WorkspacePersistence(f.vfs, f.events, new MemorySnapshotStorage(), { debounceMs: 5 });
    expect(await p.restore()).toBe("empty");
  });

  test("an empty-files snapshot also reports 'empty'", async () => {
    const storage = new MemorySnapshotStorage({ version: SNAPSHOT_VERSION, savedAt: 1, files: {} });
    const f = makeFs();
    const p = new WorkspacePersistence(f.vfs, f.events, storage, { debounceMs: 5 });
    expect(await p.restore()).toBe("empty");
  });
});

// ---------------------------------------------------------------------------
// corrupt snapshot fallback
// ---------------------------------------------------------------------------

describe("corrupt snapshot fallback", () => {
  test.each([
    ["garbage string", "corrupt"],
    ["future version", { version: 999, savedAt: 1, files: { "/a": { content: "x", mode: S_IFREG, mtime: 1 } } }],
    ["mangled entries", { version: SNAPSHOT_VERSION, savedAt: 1, files: { "/a": { nope: true } } }],
  ])("%s → 'corrupt', storage cleared, boot survives", async (_name, raw) => {
    const storage = new MemorySnapshotStorage(raw);
    const f = makeFs();
    const p = new WorkspacePersistence(f.vfs, f.events, storage, { debounceMs: 5 });
    expect(await p.restore()).toBe("corrupt"); // caller reseeds
    expect(await storage.load()).toBeNull(); // next boot is a clean first boot
  });

  test("a storage backend that throws on load degrades to 'error' without throwing", async () => {
    const throwing: SnapshotStorage = {
      kind: "memory",
      async load() {
        throw new Error("boom");
      },
      async save() {},
      async clear() {},
    };
    const f = makeFs();
    const p = new WorkspacePersistence(f.vfs, f.events, throwing, { debounceMs: 5 });
    expect(await p.restore()).toBe("error");
  });

  test("a failing save marks state dirty again and never throws", async () => {
    const storage = new MemorySnapshotStorage();
    storage.failNextSave = true;
    const f = makeFs();
    const p = new WorkspacePersistence(f.vfs, f.events, storage, { debounceMs: 5 });
    p.start();
    await f.vfs.writeFile("/home/user/x.txt", "x");
    await p.flush(); // simulated failure swallowed
    expect(p.info().dirty).toBe(true);
    await p.flush(); // retry succeeds
    expect(storage.saveCount).toBe(1);
    expect(p.info().dirty).toBe(false);
    p.stop();
  });
});

// ---------------------------------------------------------------------------
// debounce coalescing + flush
// ---------------------------------------------------------------------------

describe("debounced writer", () => {
  test("a burst of changes coalesces into one save ~debounceMs after the last", async () => {
    const storage = new MemorySnapshotStorage();
    const f = makeFs();
    const p = new WorkspacePersistence(f.vfs, f.events, storage, { debounceMs: 50 });
    p.start();

    for (let i = 0; i < 5; i++) {
      await f.vfs.writeFile(`/home/user/f${i}.txt`, `content ${i}`);
      await sleep(5);
    }
    expect(storage.saveCount).toBe(0); // still inside the debounce window

    await sleep(150);
    expect(storage.saveCount).toBe(1); // one coalesced write

    const decoded = decodeSnapshot(await storage.load());
    expect(decoded).not.toBeNull();
    for (let i = 0; i < 5; i++) {
      expect(Object.keys(decoded!.files)).toContain(`/home/user/f${i}.txt`);
    }

    await f.vfs.writeFile("/home/user/later.txt", "more");
    await sleep(150);
    expect(storage.saveCount).toBe(2); // a fresh burst schedules a fresh save
    p.stop();
  });

  test("flush persists pending changes immediately (visibilitychange/pagehide path)", async () => {
    const storage = new MemorySnapshotStorage();
    const f = makeFs();
    const p = new WorkspacePersistence(f.vfs, f.events, storage, { debounceMs: 10_000 });
    p.start();
    await f.vfs.writeFile("/home/user/urgent.txt", "save me");
    expect(storage.saveCount).toBe(0);
    await p.flush();
    expect(storage.saveCount).toBe(1);
    await p.flush(); // clean → no extra write
    expect(storage.saveCount).toBe(1);
    p.stop();
  });

  test("deletions and directory ops reach the snapshot too", async () => {
    const storage = new MemorySnapshotStorage();
    const f = makeFs();
    const p = new WorkspacePersistence(f.vfs, f.events, storage, { debounceMs: 5 });
    p.start();
    await f.vfs.writeFile("/home/user/tmp.txt", "x");
    await f.vfs.mkdir("/home/user/keep", { recursive: true });
    await p.flush();
    await f.vfs.rm("/home/user/tmp.txt");
    await p.flush();
    const decoded = decodeSnapshot(await storage.load());
    expect(Object.keys(decoded!.files)).not.toContain("/home/user/tmp.txt");
    expect(decoded!.files["/home/user/keep"]!.mode & S_IFDIR).toBe(S_IFDIR);
    p.stop();
  });
});

// ---------------------------------------------------------------------------
// graceful degradation without IndexedDB
// ---------------------------------------------------------------------------

describe("no-IndexedDB degradation", () => {
  test("createSnapshotStorage() returns null under bun (no indexedDB) without throwing", () => {
    expect(typeof indexedDB).toBe("undefined");
    expect(createSnapshotStorage()).toBeNull();
  });

  test("persistence with null storage is a graceful no-op end to end", async () => {
    const f = makeFs();
    const p = new WorkspacePersistence(f.vfs, f.events, null, { debounceMs: 5 });
    expect(p.enabled).toBe(false);
    expect(await p.restore()).toBe("disabled");
    p.start(); // no-op
    await f.vfs.writeFile("/home/user/x.txt", "x"); // markDirty path, no storage
    await p.flush();
    await p.resetStorage();
    expect(p.info().backend).toBe("none");
    expect(p.info().lastSavedAt).toBeNull();
    p.stop();
  });
});

// ---------------------------------------------------------------------------
// workspace command
// ---------------------------------------------------------------------------

describe("workspace command", () => {
  const ctx = {} as CommandContext; // execute() never touches ctx

  test("info reports backend, live file count/bytes, and last save", async () => {
    const storage = new MemorySnapshotStorage();
    const f = makeFs();
    const p = new WorkspacePersistence(f.vfs, f.events, storage, { debounceMs: 5 });
    p.start();
    await f.vfs.writeFile("/home/user/one.txt", "12345678");
    await p.flush();

    const cmd = createWorkspaceCommand({ vfs: f.vfs, persistence: p, reset: async () => {} });
    const result = await cmd.execute(["info"], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("memory");
    expect(result.stdout).toContain("files        1");
    expect(result.stdout).toContain("8 B");
    expect(result.stdout).toMatch(/last saved {3}\d{4}-\d{2}-\d{2}T/);
    p.stop();
  });

  test("reset invokes the reset hook; unknown subcommands exit 2 with usage", async () => {
    const f = makeFs();
    const p = new WorkspacePersistence(f.vfs, f.events, null);
    let resets = 0;
    const cmd = createWorkspaceCommand({
      vfs: f.vfs,
      persistence: p,
      reset: async () => {
        resets += 1;
      },
    });

    const reset = await cmd.execute(["reset"], ctx);
    expect(reset.exitCode).toBe(0);
    expect(resets).toBe(1);

    const bogus = await cmd.execute(["frobnicate"], ctx);
    expect(bogus.exitCode).toBe(2);
    expect(bogus.stderr).toContain("usage: workspace [info|reset]");
  });
});
