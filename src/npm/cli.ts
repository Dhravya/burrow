/**
 * burrow — src/npm/cli.ts (owned by the COMMAND+LOCKFILE agent)
 *
 * The user-facing package manager:
 *   bun install            resolve (lock-aware) + install everything in the
 *                          nearest package.json, then write burrow-lock.json
 *   bun add <spec> [--dev] resolve+install one package, update package.json
 *                          (best-effort format-preserving) + the lock
 *   bun remove <name>      drop from package.json + node_modules + the lock
 *
 * This module EXTENDS the toolchain's `bun` command instead of clobbering it:
 * just-bash registers customCommands into a Map (last one wins), and initNpm()
 * runs after initToolchain(), so our spec shadows the toolchain's — and we
 * delegate every non-npm subcommand (`run`, `build`, `stop`, plain files) to a
 * fresh instance of the toolchain spec. Importing ../toolchain/commands.ts is
 * the coordination mechanism sanctioned for this extension (no toolchain file
 * was edited).
 *
 * Resolution machinery comes from sibling npm modules: resolveInstallPlan
 * (resolver agent) + executeInstallPlan (installer agent). Lock-awareness is
 * layered on via PackumentSource: locked entries replay as synthetic
 * packuments so a fully-locked install performs ZERO packument fetches and
 * the integrity string is carried straight from the lock into the plan.
 */

import semver from "semver";
import { tryUse, use } from "../contract/registry.ts";
import type { BurrowVfs, CommandContext, CommandSpec, ShellExecResult } from "../contract/types.ts";
import { createToolchainCommands } from "../toolchain/commands.ts";
import { executeInstallPlan, type InstallEnv } from "./install.ts";
import {
  LOCKFILE_NAME,
  lockFromResolutions,
  lockKey,
  readLockfile,
  removeFromLock,
  splitLockKey,
  writeLockfile,
  type Lockfile,
} from "./lockfile.ts";
import { fetchPackument, isValidPackageName } from "./registry.ts";
import { resolveInstallPlan } from "./resolve.ts";
import type {
  InstallPlan,
  InstallProgress,
  InstallReport,
  NpmInstaller,
  Packument,
  PackumentSource,
  ResolvedInstallPlan,
  ResolvedPackage,
} from "./types.ts";

// ============================================================================
// add-spec parsing
// ============================================================================

export interface ParsedSpec {
  name: string;
  /** Requested range/tag; "latest" when the spec carried none. */
  range: string;
  /** True when the user explicitly wrote `@<range>`. */
  explicitRange: boolean;
}

/**
 * `react` → latest · `react@^19` · `react@19.1.0` · `react@latest` ·
 * `@scope/name` → latest · `@scope/name@^1`. Returns null on malformed input.
 */
export function parseAddSpec(spec: string): ParsedSpec | null {
  const trimmed = spec.trim();
  if (trimmed === "") return null;
  // Skip index 0 so the `@` of a scope is never taken as the range separator.
  const at = trimmed.indexOf("@", 1);
  const name = at === -1 ? trimmed : trimmed.slice(0, at);
  const rawRange = at === -1 ? "" : trimmed.slice(at + 1).trim();
  if (!isValidPackageName(name)) return null;
  return {
    name,
    range: rawRange === "" ? "latest" : rawRange,
    explicitRange: rawRange !== "",
  };
}

// ============================================================================
// package.json mutation (best-effort format-preserving JSON round-trip)
// ============================================================================

type JsonObject = Record<string, unknown>;

function detectIndent(text: string): string {
  const match = /\n([ \t]+)"/.exec(text);
  return match?.[1] ?? "  ";
}

function stringifyLike(doc: JsonObject, originalText: string): string {
  const body = JSON.stringify(doc, null, detectIndent(originalText));
  return originalText.endsWith("\n") || originalText === "" ? body + "\n" : body;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Update-in-place when the key exists (its position is preserved); otherwise
 * insert at the alphabetically-sorted position among the existing keys —
 * existing relative order is never disturbed.
 */
function withKeyInserted(obj: JsonObject, key: string, value: unknown): JsonObject {
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    obj[key] = value;
    return obj;
  }
  const out: JsonObject = {};
  let inserted = false;
  for (const existing of Object.keys(obj)) {
    if (!inserted && key < existing) {
      out[key] = value;
      inserted = true;
    }
    out[existing] = obj[existing];
  }
  if (!inserted) out[key] = value;
  return out;
}

/**
 * Set `name: range` in dependencies (or devDependencies when dev). Top-level
 * key order is preserved; a missing deps field is appended at the end. Adding
 * to one field removes the name from the other (npm/bun move semantics).
 * Throws on unparsable JSON.
 */
export function addDependencyToPackageJson(text: string, name: string, range: string, dev: boolean): string {
  const doc = JSON.parse(text) as unknown;
  if (!isPlainObject(doc)) throw new Error("package.json root is not an object");

  const targetField = dev ? "devDependencies" : "dependencies";
  const otherField = dev ? "dependencies" : "devDependencies";

  const other = doc[otherField];
  if (isPlainObject(other) && Object.prototype.hasOwnProperty.call(other, name)) {
    delete other[name];
  }

  const target = doc[targetField];
  doc[targetField] = withKeyInserted(isPlainObject(target) ? target : {}, name, range);
  return stringifyLike(doc, text);
}

/** Delete `name` from both dependency fields. removed=false when it was in neither. */
export function removeDependencyFromPackageJson(text: string, name: string): { text: string; removed: boolean } {
  const doc = JSON.parse(text) as unknown;
  if (!isPlainObject(doc)) throw new Error("package.json root is not an object");

  let removed = false;
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = doc[field];
    if (isPlainObject(deps) && Object.prototype.hasOwnProperty.call(deps, name)) {
      delete deps[name];
      removed = true;
    }
  }
  return { text: removed ? stringifyLike(doc, text) : text, removed };
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
}

// ============================================================================
// Lock-aware resolution — locked entries replay as synthetic packuments
// ============================================================================

/**
 * One synthetic packument per locked name: pinned versions carry the locked
 * tarballUrl/integrity/dependencies, and dist-tag requests (`name@latest`)
 * replay through synthetic dist-tags. Entries without a recorded dependency
 * map (foreign/minimal locks) can't replay a subtree and are skipped.
 */
export function syntheticPackuments(lock: Lockfile): Map<string, Packument> {
  const byName = new Map<string, Packument>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (entry.dependencies === undefined) continue;
    let packument = byName.get(entry.name);
    if (packument === undefined) {
      packument = { name: entry.name, "dist-tags": {}, versions: {} };
      byName.set(entry.name, packument);
    }
    packument.versions[entry.version] = {
      name: entry.name,
      version: entry.version,
      dist: {
        tarball: entry.tarballUrl,
        ...(entry.integrity !== undefined ? { integrity: entry.integrity } : {}),
      },
      dependencies: entry.dependencies,
    };
    const { range } = splitLockKey(key);
    // A locked request that isn't a semver range was a dist-tag ("latest").
    if (range !== "" && semver.validRange(range) === null && semver.valid(range) === null) {
      packument["dist-tags"][range] = entry.version;
    }
  }
  return byName;
}

const STALE_LOCK_RE = /^\[npm\] no version of (\S+) satisfies/;

/**
 * resolveInstallPlan with the lock layered underneath:
 *  - every locked name resolves from its synthetic packument (zero fetches),
 *  - a request the pins can't satisfy (user bumped a range / added a tag)
 *    surfaces as "no version satisfies"; that one name is retried against the
 *    real registry (locked versions overlaid so unrelated pins hold).
 */
export async function resolveLockAware(
  requested: Record<string, string>,
  lock: Lockfile | null,
  getPackument: PackumentSource,
  onProgress?: (p: InstallProgress) => void,
): Promise<ResolvedInstallPlan> {
  if (lock === null || Object.keys(lock.packages).length === 0) {
    return resolveInstallPlan(requested, { getPackument, onProgress });
  }

  const pinned = syntheticPackuments(lock);
  const forceNetwork = new Set<string>();

  const source: PackumentSource = async (name) => {
    const synthetic = pinned.get(name);
    if (synthetic === undefined) return getPackument(name);
    if (!forceNetwork.has(name)) return synthetic;
    const real = await getPackument(name);
    return {
      ...real,
      // Locked versions keep their locked dist/deps; pinned tags hold unless
      // truly absent (real tags fill only the gaps the pins never covered).
      "dist-tags": { ...real["dist-tags"], ...synthetic["dist-tags"] },
      versions: { ...real.versions, ...synthetic.versions },
    };
  };

  // Each retry releases exactly one stale-locked name to the network.
  for (let attempt = 0; ; attempt++) {
    try {
      return await resolveInstallPlan(requested, { getPackument: source, onProgress });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const staleName = STALE_LOCK_RE.exec(message)?.[1];
      if (staleName === undefined || !pinned.has(staleName) || forceNetwork.has(staleName) || attempt >= 32) {
        throw error;
      }
      forceNetwork.add(staleName);
    }
  }
}

// ============================================================================
// Installer facade — NpmInstaller (+ additive remove) over the sibling engine
// ============================================================================

/** Additive result shape for the CLI-level `bun remove`. */
export interface RemoveReport {
  name: string;
  /** Directory whose package.json / node_modules / lock were updated. */
  dir: string;
  lockEntriesRemoved: number;
}

export interface NpmCliOptions {
  /** Defaults to registry "vfs" at call time (never at construction). */
  vfs?: BurrowVfs;
  /** Packument source override (fixtures in tests). Default: fetchPackument. */
  getPackument?: PackumentSource;
  /** Tarball pipeline override for executeInstallPlan (fetch/gunzip/events). */
  installEnv?: InstallEnv;
}

function normalizeDir(path: string): string {
  if (path === "" || path === "/") return "/";
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

async function nearestPackageJsonDir(vfs: BurrowVfs, cwd: string): Promise<string | null> {
  let dir = normalizeDir(cwd);
  for (;;) {
    if (await vfs.exists(`${dir}/package.json`)) return dir;
    if (dir === "/") return null;
    dir = parentDir(dir);
  }
}

/** Which plan package a `name@spec` request resolved to (for lock recording). */
function matchResolved(plan: InstallPlan, name: string, spec: string): ResolvedPackage | null {
  const candidates = plan.packages.filter((pkg) => pkg.name === name);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;
  if (semver.validRange(spec) !== null) {
    const best = semver.maxSatisfying(
      candidates.map((candidate) => candidate.version),
      spec,
    );
    return candidates.find((candidate) => candidate.version === best) ?? null;
  }
  return null;
}

/** Every request edge (roots + transitive ranges) → its pinned resolution. */
export function collectResolutions(plan: InstallPlan): Map<string, ResolvedPackage> {
  const resolutions = new Map<string, ResolvedPackage>();
  const record = (name: string, spec: string): void => {
    const key = lockKey(name, spec);
    if (resolutions.has(key)) return;
    const resolved = matchResolved(plan, name, spec);
    if (resolved !== null) resolutions.set(key, resolved);
  };
  for (const [name, spec] of Object.entries(plan.requested)) record(name, spec);
  for (const pkg of plan.packages) {
    for (const [name, spec] of Object.entries(pkg.dependencies)) record(name, spec);
  }
  return resolutions;
}

export function createNpmInstaller(options?: NpmCliOptions): NpmInstaller & {
  remove(cwd: string, name: string): Promise<RemoveReport>;
} {
  const vfsOf = (): BurrowVfs => options?.vfs ?? use("vfs");
  const getPackument = options?.getPackument ?? fetchPackument;
  const envOf = (): InstallEnv => options?.installEnv ?? { events: tryUse("events") };

  async function readManifest(vfs: BurrowVfs, dir: string): Promise<JsonObject> {
    const path = `${dir}/package.json`;
    let doc: unknown;
    try {
      doc = JSON.parse(await vfs.readFile(path));
    } catch (error) {
      throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isPlainObject(doc)) throw new Error(`invalid ${path}: root is not an object`);
    return doc;
  }

  async function install(cwd: string, onProgress?: (p: InstallProgress) => void): Promise<InstallReport> {
    const started = Date.now();
    const vfs = vfsOf();
    const dir = await nearestPackageJsonDir(vfs, cwd);
    if (dir === null) throw new Error(`no package.json found in ${normalizeDir(cwd)} or any parent directory`);

    const manifest = await readManifest(vfs, dir);
    const requested = {
      ...asStringRecord(manifest["dependencies"]),
      ...asStringRecord(manifest["devDependencies"]),
    };

    if (Object.keys(requested).length === 0) {
      await writeLockfile(vfs, dir, lockFromResolutions(null, new Map()));
      return { installed: [], bytes: 0, ms: Date.now() - started, warnings: ["package.json has no dependencies"] };
    }

    const lock = await readLockfile(vfs, dir);
    const plan = await resolveLockAware(requested, lock, getPackument, onProgress);
    const report = await executeInstallPlan(plan, dir, vfs, onProgress, envOf());
    await writeLockfile(vfs, dir, lockFromResolutions(null, collectResolutions(plan)));

    return {
      installed: report.installed,
      bytes: report.bytes,
      ms: Date.now() - started,
      warnings: [...plan.warnings, ...report.warnings],
    };
  }

  async function add(
    cwd: string,
    spec: string,
    opts: { dev?: boolean },
    onProgress?: (p: InstallProgress) => void,
  ): Promise<InstallReport> {
    const started = Date.now();
    const parsed = parseAddSpec(spec);
    if (parsed === null) throw new Error(`invalid package spec: ${JSON.stringify(spec)}`);
    const { name, range } = parsed;

    const vfs = vfsOf();
    let dir = await nearestPackageJsonDir(vfs, cwd);
    let manifestText: string;
    if (dir === null) {
      // bun-style: create a minimal manifest where the user stands.
      dir = normalizeDir(cwd);
      const base = dir.split("/").filter(Boolean).at(-1) ?? "app";
      manifestText = JSON.stringify({ name: base, version: "0.0.0" }, null, 2) + "\n";
    } else {
      manifestText = await vfs.readFile(`${dir}/package.json`);
    }

    const lock = await readLockfile(vfs, dir);
    const plan = await resolveLockAware({ [name]: range }, lock, getPackument, onProgress);
    const report = await executeInstallPlan(plan, dir, vfs, onProgress, envOf());

    const root = matchResolved(plan, name, range) ?? plan.packages.find((pkg) => pkg.name === name) ?? null;
    if (root === null) throw new Error(`resolution for ${name}@${range} produced no package (resolver bug?)`);

    // Save an explicit range verbatim; a bare name / dist-tag saves ^resolved.
    const saveRange = semver.validRange(range) !== null ? range : `^${root.version}`;
    await vfs.writeFile(`${dir}/package.json`, addDependencyToPackageJson(manifestText, name, saveRange, opts.dev === true));

    // Lock: keep unrelated pins, record this run's edges, and key the direct
    // request under the range that actually landed in package.json.
    const resolutions = collectResolutions(plan);
    if (saveRange !== range) resolutions.delete(lockKey(name, range));
    resolutions.set(lockKey(name, saveRange), root);
    await writeLockfile(vfs, dir, lockFromResolutions(lock, resolutions));

    return {
      installed: report.installed,
      bytes: report.bytes,
      ms: Date.now() - started,
      warnings: [...plan.warnings, ...report.warnings],
    };
  }

  async function remove(cwd: string, name: string): Promise<RemoveReport> {
    const vfs = vfsOf();
    const dir = await nearestPackageJsonDir(vfs, cwd);
    if (dir === null) throw new Error(`no package.json found in ${normalizeDir(cwd)} or any parent directory`);

    const manifestPath = `${dir}/package.json`;
    const { text, removed } = removeDependencyFromPackageJson(await vfs.readFile(manifestPath), name);
    if (!removed) throw new Error(`"${name}" is not a dependency in ${manifestPath}`);
    await vfs.writeFile(manifestPath, text);

    await vfs.rm(`${dir}/node_modules/${name}`, { recursive: true, force: true });

    let lockEntriesRemoved = 0;
    const lock = await readLockfile(vfs, dir);
    if (lock !== null) {
      lockEntriesRemoved = removeFromLock(lock, name);
      if (lockEntriesRemoved > 0) await writeLockfile(vfs, dir, lock);
    }
    tryUse("events")?.emit("fs:batch", { reason: "toolchain" });

    return { name, dir, lockEntriesRemoved };
  }

  return { install, add, remove };
}

// ============================================================================
// Terminal command — `bun install|add|remove`, everything else delegated
// ============================================================================

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
} as const;

const NPM_USAGE = `${C.bold}package manager:${C.reset}
   ${C.cyan}bun install${C.reset}                 install deps from package.json (writes ${LOCKFILE_NAME})
   ${C.cyan}bun add${C.reset} <pkg[@range]> [--dev]  add + install a dependency
   ${C.cyan}bun remove${C.reset} <pkg>            remove a dependency
`;

function fail(message: string, exitCode = 1): ShellExecResult {
  return { stdout: "", stderr: message.endsWith("\n") ? message : message + "\n", exitCode };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

interface PhaseSnapshot {
  done: number;
  total: number;
}

function createProgressTracker(): {
  onProgress: (p: InstallProgress) => void;
  phaseLines: () => string;
} {
  const phases = new Map<InstallProgress["phase"], PhaseSnapshot>();
  return {
    onProgress: (p) => {
      phases.set(p.phase, { done: p.done, total: p.total });
    },
    phaseLines: () => {
      const lines: string[] = [];
      const resolve = phases.get("resolve");
      if (resolve) lines.push(`${C.dim}resolve${C.reset}   ${resolve.done} package${resolve.done === 1 ? "" : "s"}`);
      const download = phases.get("download");
      if (download) lines.push(`${C.dim}download${C.reset}  ${download.done}/${download.total}`);
      const extract = phases.get("extract");
      if (extract) lines.push(`${C.dim}extract${C.reset}   ${extract.done} archive${extract.done === 1 ? "" : "s"}`);
      const link = phases.get("link");
      if (link) lines.push(`${C.dim}link${C.reset}      ${link.done} folder${link.done === 1 ? "" : "s"}`);
      return lines.length > 0 ? lines.join("\n") + "\n" : "";
    },
  };
}

function warningLines(warnings: string[]): string {
  return warnings.map((warning) => `${C.dim}warn: ${warning}${C.reset}\n`).join("");
}

function doneLine(report: InstallReport): string {
  const count = report.installed.length;
  return (
    `${C.green}${C.bold}done${C.reset} in ${report.ms}ms` +
    ` ${C.dim}—${C.reset} ${count} package${count === 1 ? "" : "s"}, ${formatBytes(report.bytes)}\n`
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Installer = ReturnType<typeof createNpmInstaller>;

async function doInstall(installer: Installer, args: string[], ctx: CommandContext): Promise<ShellExecResult> {
  const extra = args.find((arg) => !arg.startsWith("-"));
  if (extra !== undefined) {
    return fail(`bun install: unexpected argument "${extra}" — did you mean \`bun add ${extra}\`?`, 129);
  }
  const tracker = createProgressTracker();
  try {
    const report = await installer.install(ctx.cwd, tracker.onProgress);
    return {
      stdout: tracker.phaseLines() + warningLines(report.warnings) + doneLine(report),
      stderr: "",
      exitCode: 0,
    };
  } catch (error) {
    return fail(`bun install: ${errorMessage(error)}`);
  }
}

async function doAdd(installer: Installer, args: string[], ctx: CommandContext): Promise<ShellExecResult> {
  const dev = args.some((arg) => arg === "--dev" || arg === "-d" || arg === "-D" || arg === "--development");
  const specs = args.filter((arg) => !arg.startsWith("-"));
  if (specs.length === 0) return fail("bun add: no package given\nusage: bun add <pkg[@range]> [--dev]", 129);

  let stdout = "";
  for (const spec of specs) {
    const tracker = createProgressTracker();
    try {
      const report = await installer.add(ctx.cwd, spec, { dev }, tracker.onProgress);
      const direct = parseAddSpec(spec);
      const installedDirect = report.installed.find((pkg) => pkg.name === direct?.name);
      const label = installedDirect ? `${installedDirect.name}@${installedDirect.version}` : spec;
      stdout +=
        `${C.green}+${C.reset} ${C.bold}${label}${C.reset}${dev ? ` ${C.dim}(dev)${C.reset}` : ""}\n` +
        tracker.phaseLines() +
        warningLines(report.warnings) +
        doneLine(report);
    } catch (error) {
      return { stdout, stderr: `bun add: ${spec}: ${errorMessage(error)}\n`, exitCode: 1 };
    }
  }
  return { stdout, stderr: "", exitCode: 0 };
}

async function doRemove(installer: Installer, args: string[], ctx: CommandContext): Promise<ShellExecResult> {
  const names = args.filter((arg) => !arg.startsWith("-"));
  if (names.length === 0) return fail("bun remove: no package given\nusage: bun remove <pkg>", 129);

  let stdout = "";
  for (const name of names) {
    try {
      const report = await installer.remove(ctx.cwd, name);
      stdout += `${C.red}-${C.reset} ${C.bold}${name}${C.reset} ${C.dim}(package.json, node_modules${
        report.lockEntriesRemoved > 0 ? `, ${LOCKFILE_NAME}` : ""
      })${C.reset}\n`;
    } catch (error) {
      return { stdout, stderr: `bun remove: ${errorMessage(error)}\n`, exitCode: 1 };
    }
  }
  return { stdout, stderr: "", exitCode: 0 };
}

/**
 * The extended `bun` command spec. Registered by initNpm() AFTER the
 * toolchain's own registration so it shadows it (just-bash: last name wins);
 * anything that isn't install/add/remove is delegated to the toolchain spec,
 * and the help text gains a package-manager section.
 */
export function createNpmCommands(installer: Installer): CommandSpec[] {
  const toolchainBun = createToolchainCommands().find((command) => command.name === "bun");

  const bun: CommandSpec = {
    name: "bun",
    async execute(args, ctx): Promise<ShellExecResult> {
      const first = args[0];
      if (first === "install" || first === "i") return doInstall(installer, args.slice(1), ctx);
      if (first === "add") return doAdd(installer, args.slice(1), ctx);
      if (first === "remove" || first === "rm") return doRemove(installer, args.slice(1), ctx);

      if (toolchainBun === undefined) {
        return fail("bun: toolchain module unavailable — only install/add/remove work right now");
      }
      const result = await toolchainBun.execute(args, ctx);
      const isHelp = first === undefined || first === "--help" || first === "-h" || first === "help";
      if (isHelp && result.exitCode === 0) {
        return { ...result, stdout: result.stdout + "\n" + NPM_USAGE };
      }
      return result;
    },
  };

  return [bun];
}
