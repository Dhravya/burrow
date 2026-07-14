/**
 * Burrow — src/vfs/snapshot.ts
 * Workspace snapshot codec: capture the whole VFS into a plain, structured-
 * clone-safe value (path -> {content, mode, mtime}), apply one back onto a
 * fresh InMemoryFs, and validate untrusted persisted data.
 *
 * The entry `mode` carries POSIX type bits (S_IFREG/S_IFDIR/S_IFLNK) so one
 * record shape covers files, directories (content "") and symlinks (content =
 * target). `SNAPSHOT_VERSION` gates the format: anything else — or any
 * malformed record — decodes to null and the caller falls back to a fresh seed.
 */

import type { InMemoryFs } from "just-bash/browser";
import type { BurrowVfs } from "../contract/types.ts";
import { dirname } from "./paths.ts";

/** Bump when the persisted record shape changes; old snapshots then reseed. */
export const SNAPSHOT_VERSION = 1;

export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

export interface SnapshotFileEntry {
  /** File bytes/text, symlink target, or "" for a directory. */
  content: Uint8Array | string;
  /** Permission bits | one of S_IFREG / S_IFDIR / S_IFLNK. */
  mode: number;
  /** mtime, epoch milliseconds. */
  mtime: number;
}

export interface WorkspaceSnapshot {
  version: number;
  /** When the snapshot was captured, epoch milliseconds. */
  savedAt: number;
  /** Absolute VFS path -> entry. The root "/" itself is never recorded. */
  files: Record<string, SnapshotFileEntry>;
}

const encoder = new TextEncoder();

/** Read every path in the VFS into a snapshot. Reads only — emits no events. */
export async function captureSnapshot(vfs: BurrowVfs): Promise<WorkspaceSnapshot> {
  const files: Record<string, SnapshotFileEntry> = {};
  for (const path of vfs.getAllPaths()) {
    if (path === "/") continue;
    let st;
    try {
      st = await vfs.lstat(path);
    } catch {
      continue; // deleted while walking — skip
    }
    const mtime = st.mtime.getTime();
    const perms = st.mode & 0o7777;
    if (st.isDirectory) {
      files[path] = { content: "", mode: perms | S_IFDIR, mtime };
    } else if (st.isSymbolicLink) {
      files[path] = { content: await vfs.readlink(path), mode: perms | S_IFLNK, mtime };
    } else {
      files[path] = { content: await vfs.readFileBuffer(path), mode: perms | S_IFREG, mtime };
    }
  }
  return { version: SNAPSHOT_VERSION, savedAt: Date.now(), files };
}

/**
 * Write a snapshot onto the raw InMemoryFs (NOT the WatchedFs decorator):
 * restore is not a user edit, so no file:changed events fire — the caller
 * announces completion with one fs:batch. Directories are applied shallowest-
 * first so their modes/mtimes are not clobbered by implicit parent creation.
 */
export async function applySnapshot(store: InMemoryFs, snapshot: WorkspaceSnapshot): Promise<void> {
  const paths = Object.keys(snapshot.files).sort(byDepthThenName);
  for (const path of paths) {
    const entry = snapshot.files[path]!;
    const kind = entry.mode & S_IFMT;
    const perms = entry.mode & 0o7777;
    const mtime = new Date(entry.mtime);
    if (kind === S_IFDIR) {
      store.mkdirSync(path, { recursive: true });
      await store.chmod(path, perms);
      await store.utimes(path, mtime, mtime);
    } else if (kind === S_IFLNK) {
      const target = typeof entry.content === "string" ? entry.content : new TextDecoder().decode(entry.content);
      const parent = dirname(path);
      if (parent !== "/") store.mkdirSync(parent, { recursive: true });
      try {
        await store.symlink(target, path);
      } catch {
        // A pre-restore boot step (e.g. shell /usr/bin stubs) claimed the path.
        await store.rm(path, { recursive: true, force: true });
        await store.symlink(target, path);
      }
    } else {
      store.writeFileSync(path, entry.content, undefined, { mode: perms, mtime });
    }
  }
}

/** Remove every top-level entry so a half-applied snapshot can't linger. */
export async function wipeStore(store: InMemoryFs): Promise<void> {
  for (const path of store.getAllPaths()) {
    if (path === "/" || path.lastIndexOf("/") !== 0) continue; // top-level only; rm recurses
    await store.rm(path, { recursive: true, force: true });
  }
}

/**
 * Validate an untrusted persisted value into a WorkspaceSnapshot.
 * Returns null for anything corrupt or from an incompatible version.
 */
export function decodeSnapshot(raw: unknown): WorkspaceSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { version, savedAt, files } = raw as Record<string, unknown>;
  if (version !== SNAPSHOT_VERSION) return null;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  if (typeof files !== "object" || files === null || Array.isArray(files)) return null;

  const out: Record<string, SnapshotFileEntry> = {};
  for (const [path, value] of Object.entries(files)) {
    if (!path.startsWith("/") || path === "/" || path.includes("\0")) return null;
    if (typeof value !== "object" || value === null) return null;
    const { content, mode, mtime } = value as Record<string, unknown>;
    if (typeof content !== "string" && !(content instanceof Uint8Array)) return null;
    if (typeof mode !== "number" || !Number.isFinite(mode)) return null;
    if (typeof mtime !== "number" || !Number.isFinite(mtime)) return null;
    out[path] = { content, mode, mtime };
  }
  return { version, savedAt, files: out };
}

/** Non-directory entry count + total content bytes (what the store holds). */
export function snapshotStats(snapshot: WorkspaceSnapshot): { fileCount: number; bytes: number } {
  let fileCount = 0;
  let bytes = 0;
  for (const entry of Object.values(snapshot.files)) {
    if ((entry.mode & S_IFMT) === S_IFDIR) continue;
    fileCount += 1;
    bytes += typeof entry.content === "string" ? encoder.encode(entry.content).length : entry.content.byteLength;
  }
  return { fileCount, bytes };
}

function byDepthThenName(a: string, b: string): number {
  const depthA = a.split("/").length;
  const depthB = b.split("/").length;
  if (depthA !== depthB) return depthA - depthB;
  return a < b ? -1 : a > b ? 1 : 0;
}
