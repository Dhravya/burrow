/**
 * Burrow — src/vfs/git-fs-adapter.ts
 * GitFsAdapter: maps the EXACT isomorphic-git flat promise-style fs surface
 * (GitFsPromises, all 10 required methods) onto the shared WatchedFs, so
 * every git write emits on the one event bus.
 *
 * Non-negotiables honored here (verified against isomorphic-git 1.38.7):
 *  - every method is `async` — detection calls `fs.readFile()` with NO args
 *    and needs a thenable (rejected promise), never a sync throw;
 *  - every error carries `.code` from GitFsErrorCode;
 *  - readdir returns bare names and throws ENOTDIR on files;
 *  - stat/lstat return is* METHODS plus ALL numeric fields (each is taken
 *    % 2**32 — NaN silently corrupts .git/index): uid/gid/dev = 1, stable
 *    ino per path, mtimeMs/ctimeMs from the store's mtime, mode
 *    0o100644 / 0o100755 / 0o40755 / 0o120000;
 *  - readFile honors both `'utf8'` and `{encoding:'utf8'}`;
 *  - mkdir is non-recursive and throws EEXIST / ENOENT itself.
 *
 * Pass the instance FLAT to isomorphic-git (`fs: gitFs`), never `{promises}`.
 */

import type {
  BurrowVfs,
  GitFsError,
  GitFsErrorCode,
  GitFsPromises,
  GitFsReadOptions,
  GitFsStats,
  GitFsWriteOptions,
  VfsStat,
} from "../contract/types.ts";
import { dirname } from "./paths.ts";

const GIT_FS_ERROR_CODES: readonly GitFsErrorCode[] = ["ENOENT", "EEXIST", "ENOTDIR", "ENOTEMPTY", "EINVAL"];

export function gitFsError(code: GitFsErrorCode, message: string): GitFsError {
  const error = new Error(message) as GitFsError;
  error.code = code;
  return error;
}

function isGitFsCode(code: unknown): code is GitFsErrorCode {
  return typeof code === "string" && (GIT_FS_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Normalize any underlying failure into a GitFsError. InMemoryFs throws plain
 * Errors whose messages START with the POSIX code ("ENOENT: no such file or
 * directory, open '/x'") but carry no `.code` property — parse the prefix.
 */
function coerce(error: unknown, fallback: GitFsErrorCode = "EINVAL"): GitFsError {
  if (error instanceof Error) {
    if (isGitFsCode((error as Partial<GitFsError>).code)) return error as GitFsError;
    const prefix = /^(E[A-Z]+):/.exec(error.message)?.[1];
    if (isGitFsCode(prefix)) return gitFsError(prefix, error.message);
    return gitFsError(fallback, error.message);
  }
  return gitFsError(fallback, String(error));
}

function wantsUtf8(options: GitFsReadOptions | GitFsWriteOptions): boolean {
  if (options === "utf8") return true;
  return typeof options === "object" && options !== null && options.encoding === "utf8";
}

function mtimeMillis(stat: VfsStat): number {
  // WatchedFs.utimes normalizes to Date, but a raw number snuck into the store
  // (e.g. via a direct utimes on InMemoryFs) must still yield a real number.
  const raw = stat.mtime as Date | number;
  const ms = typeof raw === "number" ? raw : raw.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export class GitFsAdapter implements GitFsPromises {
  readonly #vfs: BurrowVfs;
  /** Stable inode numbers per normalized path — the .git/index stat cache keys on these. */
  readonly #inodes = new Map<string, number>();
  #nextIno = 1;

  constructor(vfs: BurrowVfs) {
    this.#vfs = vfs;
  }

  #normalize(path: string): string {
    return this.#vfs.resolvePath("/", path);
  }

  #ino(path: string): number {
    const key = this.#normalize(path);
    let ino = this.#inodes.get(key);
    if (ino === undefined) {
      ino = this.#nextIno++;
      this.#inodes.set(key, ino);
    }
    return ino;
  }

  async #lexists(path: string): Promise<boolean> {
    try {
      await this.#vfs.lstat(path);
      return true;
    } catch {
      return false;
    }
  }

  #toStats(path: string, stat: VfsStat): GitFsStats {
    const mode = stat.isDirectory
      ? 0o40755
      : stat.isSymbolicLink
        ? 0o120000
        : (stat.mode & 0o111) !== 0
          ? 0o100755
          : 0o100644;
    const mtimeMs = mtimeMillis(stat);
    return {
      isFile: () => stat.isFile,
      isDirectory: () => stat.isDirectory,
      isSymbolicLink: () => stat.isSymbolicLink,
      mode,
      size: stat.size,
      ino: this.#ino(path),
      uid: 1,
      gid: 1,
      dev: 1,
      mtimeMs,
      ctimeMs: mtimeMs,
    };
  }

  // ------------------------------------------------------------------------

  async readFile(path: string, options?: GitFsReadOptions): Promise<Uint8Array | string> {
    // isPromiseFs detection calls readFile() with no args; async => rejected promise.
    if (typeof path !== "string") throw gitFsError("EINVAL", "readFile: path must be a string");
    try {
      if (wantsUtf8(options)) return await this.#vfs.readFile(path, "utf8");
      return await this.#vfs.readFileBuffer(path);
    } catch (error) {
      throw coerce(error);
    }
  }

  async writeFile(path: string, data: Uint8Array | string, options?: GitFsWriteOptions): Promise<void> {
    try {
      await this.#vfs.writeFile(path, data);
      const mode = typeof options === "object" && options !== null ? options.mode : undefined;
      if (mode !== undefined && (mode & 0o111) !== 0) {
        await this.#vfs.chmod(path, 0o755); // executable — surfaces as 0o100755 in stat()
      }
    } catch (error) {
      throw coerce(error);
    }
  }

  /** Non-recursive. EEXIST when the path exists, ENOENT when the parent is missing. */
  async mkdir(path: string): Promise<void> {
    if (await this.#lexists(path)) {
      throw gitFsError("EEXIST", `EEXIST: file already exists, mkdir '${path}'`);
    }
    const parent = dirname(this.#normalize(path));
    if (parent !== path && !(await this.#lexists(parent))) {
      throw gitFsError("ENOENT", `ENOENT: no such file or directory, mkdir '${path}'`);
    }
    try {
      await this.#vfs.mkdir(path);
    } catch (error) {
      throw coerce(error);
    }
  }

  async rmdir(path: string): Promise<void> {
    let stat: VfsStat;
    try {
      stat = await this.#vfs.lstat(path);
    } catch (error) {
      throw coerce(error, "ENOENT");
    }
    if (!stat.isDirectory) {
      throw gitFsError("ENOTDIR", `ENOTDIR: not a directory, rmdir '${path}'`);
    }
    try {
      await this.#vfs.rm(path); // non-recursive: non-empty => ENOTEMPTY from the store
    } catch (error) {
      throw coerce(error);
    }
  }

  async unlink(path: string): Promise<void> {
    let stat: VfsStat;
    try {
      stat = await this.#vfs.lstat(path); // lstat: unlink must see (and remove) broken symlinks
    } catch (error) {
      throw coerce(error, "ENOENT");
    }
    if (stat.isDirectory) {
      throw gitFsError("EINVAL", `EINVAL: is a directory, unlink '${path}'`);
    }
    try {
      await this.#vfs.rm(path);
    } catch (error) {
      throw coerce(error);
    }
  }

  /** Bare entry names, never paths. ENOTDIR on a file (the walker relies on it). */
  async readdir(path: string): Promise<string[]> {
    try {
      return await this.#vfs.readdir(path);
    } catch (error) {
      throw coerce(error);
    }
  }

  async stat(path: string): Promise<GitFsStats> {
    try {
      return this.#toStats(path, await this.#vfs.stat(path));
    } catch (error) {
      throw coerce(error, "ENOENT");
    }
  }

  async lstat(path: string): Promise<GitFsStats> {
    try {
      return this.#toStats(path, await this.#vfs.lstat(path));
    } catch (error) {
      throw coerce(error, "ENOENT");
    }
  }

  async readlink(path: string): Promise<string | Uint8Array> {
    try {
      return await this.#vfs.readlink(path); // store throws EINVAL on non-symlinks
    } catch (error) {
      throw coerce(error);
    }
  }

  async symlink(target: string, path: string): Promise<void> {
    try {
      await this.#vfs.symlink(target, path);
    } catch (error) {
      throw coerce(error);
    }
  }

  /** Optional fast-path isomorphic-git probes for; force swallows ENOENT like node's fs.rm. */
  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    try {
      await this.#vfs.rm(path, options);
    } catch (error) {
      const coerced = coerce(error);
      if (options?.force && coerced.code === "ENOENT") return;
      throw coerced;
    }
  }
}
