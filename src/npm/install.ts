/**
 * burrow — src/npm/install.ts
 * OWNED BY: installer agent.
 *
 * Executes a resolved InstallPlan against the shared VFS:
 *   fetch tarball → verify integrity (SRI) → gunzip → untar → write under
 *   <root>/node_modules/...
 *
 * Integrity: when a plan package carries an `integrity` string (npm SRI,
 * e.g. "sha512-<base64>"), the raw tarball bytes are hashed with
 * crypto.subtle and the install rejects on mismatch. Packages without an
 * integrity string are not verified; an unsupported hash algorithm is
 * reported as a warning instead of failing the install.
 *
 * Layout: flat hoisted. The first package to claim a name wins the top-level
 * `node_modules/<name>` slot (the plan is topologically ordered parents-first,
 * so direct deps hoist before transitive ones). A conflicting version of an
 * already-hoisted name nests under every dependent that resolved to it:
 * `<dependentInstallDir>/node_modules/<name>`. Conflicts are reported in
 * InstallReport.warnings.
 *
 * Environment: the tarball pipeline is abstracted behind InstallEnv so the
 * same code runs in the browser (fetch + DecompressionStream("gzip")) and in
 * bun tests (fetch + Bun.gunzipSync); the default adapter picks automatically.
 * Concurrency: 4 tarballs in flight.
 *
 * Events: WatchedFs already emits fine-grained file:changed per write; the
 * VFS surface exposes no batch primitive, so when the caller passes the
 * EventBus in InstallEnv one coarse fs:batch{reason:"toolchain"} is emitted
 * after all files land ("npm" is not in the frozen reason union; toolchain
 * is the closest owner).
 */

import type { BurrowVfs, EventBus } from "../contract/types.ts";
import type { InstallPlan, InstallProgress, InstallReport, ResolvedPackage } from "./types.ts";
import { untar, type TarEntry } from "./untar.ts";

// ---------------------------------------------------------------------------
// Environment adapter (browser vs bun test)
// ---------------------------------------------------------------------------

export interface InstallEnv {
  /** Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Gunzip raw .tgz bytes. Defaults to Bun.gunzipSync under bun, DecompressionStream("gzip") in the browser. */
  gunzip?: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  /** Optional bus for one coarse fs:batch after the install completes. */
  events?: EventBus;
}

async function defaultGunzip(data: Uint8Array): Promise<Uint8Array> {
  const maybeBun = (globalThis as { Bun?: { gunzipSync?: (d: Uint8Array) => Uint8Array } }).Bun;
  if (typeof maybeBun?.gunzipSync === "function") {
    return maybeBun.gunzipSync(data);
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------------------
// Integrity (npm SRI — "algo-base64", space-separated alternatives)
// ---------------------------------------------------------------------------

/** SRI algorithms crypto.subtle can digest, strongest first. */
const SRI_ALGORITHMS: ReadonlyArray<{ prefix: string; subtle: string }> = [
  { prefix: "sha512", subtle: "SHA-512" },
  { prefix: "sha384", subtle: "SHA-384" },
  { prefix: "sha256", subtle: "SHA-256" },
  { prefix: "sha1", subtle: "SHA-1" },
];

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

/**
 * Check `data` against an SRI string. Returns null on success, an error
 * message on mismatch, and pushes a warning (without failing) when no
 * entry uses an algorithm crypto.subtle supports.
 */
async function checkIntegrity(
  data: Uint8Array,
  integrity: string,
  key: string,
  warnings: string[],
): Promise<string | null> {
  const entries = integrity.trim().split(/\s+/);
  for (const { prefix, subtle } of SRI_ALGORITHMS) {
    const entry = entries.find((candidate) => candidate.startsWith(`${prefix}-`));
    if (entry === undefined) continue;
    // Strip SRI options ("?...") if present; the rest is the base64 digest.
    const expected = entry.slice(prefix.length + 1).split("?")[0] ?? "";
    const digest = new Uint8Array(await crypto.subtle.digest(subtle, data as Uint8Array<ArrayBuffer>));
    const actual = bytesToBase64(digest);
    if (actual === expected) return null;
    return `integrity checksum failed for ${key}: expected ${prefix}-${expected}, got ${prefix}-${actual}`;
  }
  warnings.push(`integrity: ${key} uses an unsupported hash algorithm (${integrity}) — skipped verification`);
  return null;
}

// ---------------------------------------------------------------------------
// Layout planning (pure — exported for tests)
// ---------------------------------------------------------------------------

export interface Placement {
  pkg: ResolvedPackage;
  /** Absolute VFS directories this exact name@version gets written to. */
  dirs: string[];
}

export interface LayoutPlan {
  placements: Placement[];
  warnings: string[];
}

function packageKey(pkg: { name: string; version: string }): string {
  return `${pkg.name}@${pkg.version}`;
}

/**
 * Decide where every package in the plan lands. Deterministic and
 * side-effect free: hoisting depends only on plan order, never on download
 * completion order.
 */
export function planLayout(plan: InstallPlan, targetRootDir: string): LayoutPlan {
  const root = targetRootDir.replace(/\/+$/, "");
  const warnings: string[] = [];
  const placements: Placement[] = [];
  /** name → version holding the top-level node_modules/<name> slot */
  const hoisted = new Map<string, string>();
  /** name@version → primary install dir (used to nest under dependents) */
  const primaryDir = new Map<string, string>();

  for (const pkg of plan.packages) {
    const key = packageKey(pkg);
    const holder = hoisted.get(pkg.name);

    if (holder === undefined) {
      const dir = `${root}/node_modules/${pkg.name}`;
      hoisted.set(pkg.name, pkg.version);
      primaryDir.set(key, dir);
      placements.push({ pkg, dirs: [dir] });
      continue;
    }

    if (holder === pkg.version) {
      // Same name@version reappearing (plans are deduped; belt-and-suspenders).
      continue;
    }

    // Version conflict — nest under every dependent that resolved to this
    // exact version. Plans are parents-first, so dependents are already placed.
    let dependents = plan.packages.filter(
      (p) => p !== pkg && p.dependencies?.[pkg.name] === pkg.version,
    );
    if (dependents.length === 0) {
      // Resolver recorded ranges instead of exact versions: fall back to
      // anyone that depends on the name but not on the hoisted version.
      dependents = plan.packages.filter(
        (p) => p !== pkg && p.dependencies?.[pkg.name] !== undefined && p.dependencies[pkg.name] !== holder,
      );
    }

    const dirs: string[] = [];
    for (const dependent of dependents) {
      const parentDir = primaryDir.get(packageKey(dependent));
      if (parentDir === undefined) {
        warnings.push(
          `hoist: dependent ${packageKey(dependent)} of ${key} has no install dir (plan not parents-first?) — skipped`,
        );
        continue;
      }
      dirs.push(`${parentDir}/node_modules/${pkg.name}`);
    }

    if (dirs.length === 0) {
      warnings.push(`hoist conflict: ${key} loses to ${pkg.name}@${holder} and no dependent was found — skipped`);
      continue;
    }

    warnings.push(
      `hoist conflict: ${pkg.name}@${holder} holds node_modules/${pkg.name}; ` +
        `${key} nested under ${dependents.map((d) => d.name).join(", ")}`,
    );
    const first = dirs[0];
    if (first !== undefined) primaryDir.set(key, first);
    placements.push({ pkg, dirs });
  }

  return { placements, warnings };
}

// ---------------------------------------------------------------------------
// Extraction into the VFS
// ---------------------------------------------------------------------------

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

async function writeEntries(
  vfs: BurrowVfs,
  dir: string,
  entries: TarEntry[],
  madeDirs: Set<string>,
): Promise<void> {
  const mkdirp = async (path: string): Promise<void> => {
    if (madeDirs.has(path)) return;
    await vfs.mkdir(path, { recursive: true });
    madeDirs.add(path);
  };

  await mkdirp(dir);
  for (const entry of entries) {
    const target = `${dir}/${entry.path}`;
    if (entry.type === "directory") {
      await mkdirp(target);
      continue;
    }
    await mkdirp(parentOf(target));
    await vfs.writeFile(target, entry.data);
    if ((entry.mode & 0o111) !== 0) {
      await vfs.chmod(target, 0o755);
    }
  }
}

/** Minimal promise pool: run `worker` over `items`, at most `limit` in flight. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

// ---------------------------------------------------------------------------
// executeInstallPlan
// ---------------------------------------------------------------------------

/**
 * Download, extract, and link every package in the plan into
 * `<targetRootDir>/node_modules`. Progress phases emitted here: download
 * (one per tarball), extract (one per tarball), link (one per placement dir).
 * Rejects on a failed download, an integrity (SRI) mismatch, or a corrupt
 * tarball.
 */
export async function executeInstallPlan(
  plan: InstallPlan,
  targetRootDir: string,
  vfs: BurrowVfs,
  onProgress?: (p: InstallProgress) => void,
  env?: InstallEnv,
): Promise<InstallReport> {
  const started = Date.now();
  const fetchImpl = env?.fetchImpl ?? fetch;
  const gunzip = env?.gunzip ?? defaultGunzip;

  const { placements, warnings } = planLayout(plan, targetRootDir);
  const totalTarballs = placements.length;
  const totalLinks = placements.reduce((n, p) => n + p.dirs.length, 0);

  let bytes = 0;
  let downloaded = 0;
  let extracted = 0;
  let linked = 0;
  const madeDirs = new Set<string>();

  const progress = (phase: InstallProgress["phase"], detail: string, done: number, total: number): void => {
    onProgress?.({ phase, detail, done, total });
  };

  await runPool(placements, 4, async ({ pkg, dirs }) => {
    const key = packageKey(pkg);

    progress("download", key, downloaded, totalTarballs);
    const response = await fetchImpl(pkg.tarballUrl);
    if (!response.ok) {
      throw new Error(`npm install: ${key}: GET ${pkg.tarballUrl} → ${response.status} ${response.statusText}`);
    }
    const raw = new Uint8Array(await response.arrayBuffer());
    if (pkg.integrity !== undefined) {
      const mismatch = await checkIntegrity(raw, pkg.integrity, key, warnings);
      if (mismatch !== null) throw new Error(`npm install: ${mismatch} (${pkg.tarballUrl})`);
    }
    bytes += raw.byteLength;
    downloaded++;
    progress("download", key, downloaded, totalTarballs);

    const tar = await gunzip(raw);
    const entries = [...untar(tar)];
    extracted++;
    progress("extract", key, extracted, totalTarballs);

    for (const dir of dirs) {
      await writeEntries(vfs, dir, entries, madeDirs);
      linked++;
      progress("link", `${key} → ${dir}`, linked, totalLinks);
    }
  });

  env?.events?.emit("fs:batch", { reason: "toolchain" });

  return {
    installed: placements.map(({ pkg }) => ({ name: pkg.name, version: pkg.version })),
    bytes,
    ms: Date.now() - started,
    warnings,
  };
}
