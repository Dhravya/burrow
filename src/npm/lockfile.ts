/**
 * burrow — src/npm/lockfile.ts (owned by the COMMAND+LOCKFILE agent)
 *
 * burrow-lock.json — written next to package.json after every successful
 * install/add. Format (version 1):
 *
 *   {
 *     "version": 1,
 *     "packages": {
 *       "<name@range-or-spec>": { "name", "version", "tarballUrl", "integrity"?, "dependencies"? }
 *     }
 *   }
 *
 * Keys are the REQUEST spec (`react@^19.1.0`, `left-pad@latest`), values the
 * pinned resolution. `dependencies` is an additive optional field (not in the
 * minimal shared shape) that lets a later install skip the packument fetch
 * entirely — the whole transitive plan replays from the lock.
 *
 * On subsequent installs, entries pre-pin resolutions: when a locked entry
 * exists for a request key, the resolver skips the registry packument fetch
 * and the integrity string is carried through to download verification.
 */

/** Mirrors the shared ResolvedPackage shape from src/npm/types.ts (resolver-owned). */
export interface LockResolvedPackage {
  name: string;
  version: string;
  tarballUrl: string;
  integrity?: string;
  dependencies: Record<string, string>;
}

export interface LockfileEntry {
  name: string;
  version: string;
  tarballUrl: string;
  integrity?: string;
  /** Additive: pinned dependency ranges so locked installs skip packuments. */
  dependencies?: Record<string, string>;
}

export interface Lockfile {
  version: 1;
  packages: Record<string, LockfileEntry>;
}

export const LOCKFILE_NAME = "burrow-lock.json";

/** The (tiny) slice of BurrowVfs the lockfile needs — keeps tests dependency-free. */
export interface LockfileFs {
  readFile(path: string, encoding?: string): Promise<string>;
  writeFile(path: string, data: string | Uint8Array, encoding?: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export function emptyLockfile(): Lockfile {
  return { version: 1, packages: {} };
}

/** `name@range` — the request spec key used in lockfile `packages`. */
export function lockKey(name: string, range: string): string {
  return `${name}@${range}`;
}

/** Split a lock key back into name + range (scope-aware: `@s/n@^1` → `@s/n`, `^1`). */
export function splitLockKey(key: string): { name: string; range: string } {
  const at = key.indexOf("@", 1);
  if (at === -1) return { name: key, range: "" };
  return { name: key.slice(0, at), range: key.slice(at + 1) };
}

function isValidEntry(value: unknown): value is LockfileEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    typeof entry.version === "string" &&
    typeof entry.tarballUrl === "string" &&
    (entry.integrity === undefined || typeof entry.integrity === "string") &&
    (entry.dependencies === undefined || (typeof entry.dependencies === "object" && entry.dependencies !== null))
  );
}

/**
 * Read + validate `<dir>/burrow-lock.json`. Returns null when the file is
 * absent, unparsable, has the wrong version, or entries are malformed —
 * callers fall back to a full resolve (never throw over a bad lock).
 */
export async function readLockfile(fs: LockfileFs, dir: string): Promise<Lockfile | null> {
  const path = `${dir.replace(/\/+$/, "")}/${LOCKFILE_NAME}`;
  try {
    if (!(await fs.exists(path))) return null;
    const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const lock = parsed as { version?: unknown; packages?: unknown };
    if (lock.version !== 1) return null;
    if (typeof lock.packages !== "object" || lock.packages === null) return null;
    const packages: Record<string, LockfileEntry> = {};
    for (const [key, value] of Object.entries(lock.packages)) {
      if (!isValidEntry(value)) return null;
      packages[key] = value;
    }
    return { version: 1, packages };
  } catch {
    return null;
  }
}

/** Serialize with stable (sorted) keys, 2-space indent, trailing newline. */
export async function writeLockfile(fs: LockfileFs, dir: string, lock: Lockfile): Promise<void> {
  const path = `${dir.replace(/\/+$/, "")}/${LOCKFILE_NAME}`;
  const packages: Record<string, LockfileEntry> = {};
  for (const key of Object.keys(lock.packages).sort()) {
    const entry = lock.packages[key];
    if (entry !== undefined) packages[key] = entry;
  }
  await fs.writeFile(path, JSON.stringify({ version: 1, packages }, null, 2) + "\n");
}

/**
 * Pre-pin a request from the lock. Returns the full ResolvedPackage (so the
 * resolver can skip the packument fetch — integrity carried through) or null
 * when the request isn't locked.
 */
export function pinnedResolution(lock: Lockfile | null, name: string, range: string): LockResolvedPackage | null {
  const entry = lock?.packages[lockKey(name, range)];
  if (entry === undefined || entry.name !== name) return null;
  return {
    name: entry.name,
    version: entry.version,
    tarballUrl: entry.tarballUrl,
    ...(entry.integrity !== undefined ? { integrity: entry.integrity } : {}),
    dependencies: entry.dependencies ?? {},
  };
}

/**
 * Build the lock to persist after an install: start from `previous` (pass null
 * for a full `bun install`, the existing lock for `bun add` so unrelated pins
 * survive) and record every request→resolution pair from this run.
 */
export function lockFromResolutions(
  previous: Lockfile | null,
  resolutions: ReadonlyMap<string, LockResolvedPackage>,
): Lockfile {
  const lock = emptyLockfile();
  if (previous !== null) {
    for (const [key, entry] of Object.entries(previous.packages)) lock.packages[key] = entry;
  }
  for (const [key, pkg] of resolutions) {
    lock.packages[key] = {
      name: pkg.name,
      version: pkg.version,
      tarballUrl: pkg.tarballUrl,
      ...(pkg.integrity !== undefined ? { integrity: pkg.integrity } : {}),
      dependencies: pkg.dependencies,
    };
  }
  return lock;
}

/** Drop every pin for `name` (any requested range). Returns how many were removed. */
export function removeFromLock(lock: Lockfile, name: string): number {
  let removed = 0;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (entry.name === name || splitLockKey(key).name === name) {
      delete lock.packages[key];
      removed += 1;
    }
  }
  return removed;
}
