/**
 * Burrow — src/vfs/watched-fs.ts
 * WatchedFs: delegating decorator over just-bash's InMemoryFs that emits
 * "file:changed" on every mutation. The SAME instance is:
 *   - provided to the registry as "vfs" (editor, file tree, commands),
 *   - passed to `new Bash({ fs })` by src/shell/ (structurally satisfies
 *     just-bash IFileSystem; the cast is confined to that module),
 *   - the backing store of GitFsAdapter ("gitFs").
 *
 * Wrapped mutators (per CONTRACT.md §2): writeFile, appendFile, mkdir, rm,
 * cp, mv, chmod, symlink, link, utimes, writeFileSync, mkdirSync.
 * Reads delegate untouched. Emitted paths are normalized.
 */

import type { BufferEncoding, InMemoryFs } from "just-bash/browser";
import type { BurrowVfs, EventBus, FileChangeKind, VfsDirent, VfsStat } from "../contract/types.ts";

function toDate(value: Date | number): Date {
  return value instanceof Date ? value : new Date(value);
}

export class WatchedFs implements BurrowVfs {
  /** The canonical just-bash store. Internal to src/vfs; do not reach around the decorator. */
  readonly store: InMemoryFs;
  readonly #events: EventBus;

  constructor(store: InMemoryFs, events: EventBus) {
    this.store = store;
    this.#events = events;
  }

  // -------------------------------------------------------------- events --

  #normalize(path: string): string {
    return path.startsWith("/") ? this.store.resolvePath("/", path) : path;
  }

  #emit(kind: FileChangeKind, path: string): void {
    this.#events.emit("file:changed", { kind, path: this.#normalize(path) });
  }

  /** lstat-based existence: sees broken symlinks (store.exists() follows links). */
  async #lexists(path: string): Promise<boolean> {
    try {
      await this.store.lstat(path);
      return true;
    } catch {
      return false;
    }
  }

  #existsSync(path: string): boolean {
    return this.store.getAllPaths().includes(this.#normalize(path));
  }

  // --------------------------------------------------------------- reads --

  readFile(path: string, encoding?: string): Promise<string> {
    return this.store.readFile(path, encoding as BufferEncoding | undefined);
  }

  /**
   * Not part of BurrowVfs, but just-bash routes binary-safe reads through it
   * when present (cat/pipes). Pure delegation keeps byte fidelity.
   */
  readFileBytes(path: string): ReturnType<InMemoryFs["readFileBytes"]> {
    return this.store.readFileBytes(path);
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.store.readFileBuffer(path);
  }

  exists(path: string): Promise<boolean> {
    return this.store.exists(path);
  }

  stat(path: string): Promise<VfsStat> {
    return this.store.stat(path);
  }

  lstat(path: string): Promise<VfsStat> {
    return this.store.lstat(path);
  }

  readdir(path: string): Promise<string[]> {
    return this.store.readdir(path);
  }

  readdirWithFileTypes(path: string): Promise<VfsDirent[]> {
    return this.store.readdirWithFileTypes(path);
  }

  readlink(path: string): Promise<string> {
    return this.store.readlink(path);
  }

  realpath(path: string): Promise<string> {
    return this.store.realpath(path);
  }

  // ------------------------------------------------------------ mutators --

  async writeFile(path: string, data: string | Uint8Array, encoding?: string): Promise<void> {
    const existed = await this.store.exists(path);
    await this.store.writeFile(path, data, encoding as BufferEncoding | undefined);
    this.#emit(existed ? "modified" : "created", path);
  }

  async appendFile(path: string, data: string | Uint8Array): Promise<void> {
    const existed = await this.store.exists(path);
    await this.store.appendFile(path, data);
    this.#emit(existed ? "modified" : "created", path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const existed = await this.store.exists(path);
    await this.store.mkdir(path, options);
    if (!existed) this.#emit("created", path);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const existed = await this.#lexists(path);
    await this.store.rm(path, options);
    // Top path only; recursive children collapse into this single event.
    if (existed) this.#emit("deleted", path);
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    await this.store.cp(src, dest, options);
    this.#emit("created", dest);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.store.mv(src, dest);
    this.#emit("deleted", src);
    this.#emit("created", dest);
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.store.chmod(path, mode);
    this.#emit("modified", path);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.store.symlink(target, linkPath);
    this.#emit("created", linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.store.link(existingPath, newPath);
    this.#emit("created", newPath);
  }

  async utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void> {
    // InMemoryFs stores whatever it is handed; normalize so stat().mtime stays a Date.
    await this.store.utimes(path, toDate(atime), toDate(mtime));
    this.#emit("modified", path);
  }

  // --------------------------------------------------------- sync surface --

  resolvePath(base: string, path: string): string {
    return this.store.resolvePath(base, path);
  }

  getAllPaths(): string[] {
    return this.store.getAllPaths();
  }

  writeFileSync(path: string, data: string | Uint8Array): void {
    const existed = this.#existsSync(path);
    this.store.writeFileSync(path, data);
    this.#emit(existed ? "modified" : "created", path);
  }

  mkdirSync(path: string, options?: { recursive?: boolean }): void {
    const existed = this.#existsSync(path);
    this.store.mkdirSync(path, options);
    if (!existed) this.#emit("created", path);
  }
}
