/**
 * Burrow src/toolchain — Node-style bare-specifier resolution over the VFS.
 *
 * Once src/npm installs packages into `<dir>/node_modules/`, the graph walker
 * consults this resolver BEFORE the esm.sh rewrite: an installed package wins;
 * "not-found" makes the graph fall back to its existing esm.sh URL rewrite.
 *
 * Implemented subset (deviations documented inline):
 *  - walk-up `node_modules/<name>` lookup from the importer (scoped packages,
 *    hoisted AND nested layouts),
 *  - package.json "exports": string form, object form with "." / "./sub" keys,
 *    simple single-`*` wildcard patterns, condition order
 *    browser > import > default > require (a require-condition resolution is
 *    recorded on the result so the CJS wrapper in ./cjs.ts kicks in),
 *  - no "exports" field -> module / browser (string form) / main, then index.js,
 *  - directory imports -> index.js; extension probing .js/.mjs/.cjs/.json,
 *  - subpath specifiers resolve through "./sub" exports (incl. wildcard),
 *    else as a direct file path inside the package,
 *  - .json targets resolve like any file (the graph synthesizes a
 *    default-export module for them).
 *
 * Deviations from Node (lenient on purpose — better DX in a sandbox):
 *  - an "exports" map that does not match the request falls back to the direct
 *    file path / legacy fields instead of ERR_PACKAGE_PATH_NOT_EXPORTED;
 *  - exports targets are probed with extensions if the exact target is absent;
 *  - the object form of "browser" (per-file remapping) is ignored.
 */

import { dirname, joinPath, normalizePath } from "./paths.ts";

// ---------------------------------------------------------------------------
// Minimal VFS surface (structural subset of contract BurrowVfs — lets tests
// drive the algorithm with a tiny fake).
// ---------------------------------------------------------------------------

export interface ResolverVfs {
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }>;
}

export type BareResolution =
  | { kind: "vfs"; path: string; viaRequireCondition: boolean }
  | { kind: "esm.sh"; url: string }
  | { kind: "not-found"; reason?: string };

/** resolveRequireSpecifier adds builtins (node:fs, path, …) to the vocabulary. */
export type RequireResolution = BareResolution | { kind: "builtin"; name: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isFile(vfs: ResolverVfs, path: string): Promise<boolean> {
  try {
    return (await vfs.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function isDirectory(vfs: ResolverVfs, path: string): Promise<boolean> {
  try {
    return (await vfs.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function readPackageJson(vfs: ResolverVfs, path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await vfs.readFile(path));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* missing or unparsable */
  }
  return null;
}

/** `pkg` like "ms" or "@scope/pkg"; `subpath` WITHOUT a leading slash ("" for root). */
export function parseBareSpecifier(spec: string): { pkg: string; subpath: string } | null {
  if (spec.length === 0 || spec.startsWith(".") || spec.startsWith("/")) return null;
  const parts = spec.split("/");
  if (spec.startsWith("@")) {
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return { pkg: `${parts[0]}/${parts[1]}`, subpath: parts.slice(2).join("/") };
  }
  if (!parts[0]) return null;
  return { pkg: parts[0], subpath: parts.slice(1).join("/") };
}

const NODE_EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".json"] as const;
const NODE_INDEXES = ["/index.js", "/index.mjs", "/index.cjs", "/index.json"] as const;

/**
 * Node-flavoured file probe: exact path, then .js/.mjs/.cjs/.json, then
 * directory index.js (and friends). Returns the resolved file path or null.
 */
export async function nodeProbe(vfs: ResolverVfs, base: string): Promise<string | null> {
  for (const ext of NODE_EXTENSIONS) {
    if (await isFile(vfs, base + ext)) return base + ext;
  }
  if (await isDirectory(vfs, base)) {
    for (const index of NODE_INDEXES) {
      if (await isFile(vfs, base + index)) return base + index;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// package.json "exports"
// ---------------------------------------------------------------------------

interface ConditionFlags {
  viaRequire: boolean;
}

/** Priority is FIXED per CONTRACT scope: browser > import > default > require. */
const CONDITION_ORDER = ["browser", "import", "default", "require"] as const;

/** Resolve a target value (string | array | condition object | null) to a string. */
function resolveExportsTarget(value: unknown, flags: ConditionFlags): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = resolveExportsTarget(item, flags);
      if (target !== null) return target;
    }
    return null;
  }
  if (typeof value === "object") {
    const conditions = value as Record<string, unknown>;
    for (const condition of CONDITION_ORDER) {
      if (condition in conditions) {
        const target = resolveExportsTarget(conditions[condition], flags);
        if (target !== null) {
          if (condition === "require") flags.viaRequire = true;
          return target;
        }
      }
    }
    return null; // only unknown conditions (e.g. "node", "types")
  }
  return null;
}

/**
 * Look up `key` ("." or "./sub/path") in an exports field. Handles the string
 * form, the bare condition-object form (stands for "."), exact subpath keys,
 * and simple single-`*` wildcard patterns (longest prefix wins; every `*` in
 * the target is replaced by the captured text).
 */
export function lookupExports(exportsField: unknown, key: string, flags: ConditionFlags): string | null {
  if (exportsField === null || exportsField === undefined) return null;
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return key === "." ? resolveExportsTarget(exportsField, flags) : null;
  }
  if (typeof exportsField !== "object") return null;

  const map = exportsField as Record<string, unknown>;
  const keys = Object.keys(map);
  const isPathMap = keys.some((k) => k === "." || k.startsWith("./"));
  if (!isPathMap) {
    // Bare condition object — shorthand for { ".": {...} }.
    return key === "." ? resolveExportsTarget(map, flags) : null;
  }

  if (key in map) return resolveExportsTarget(map[key], flags);

  let best: { prefix: string; suffix: string; value: unknown } | null = null;
  for (const patternKey of keys) {
    const star = patternKey.indexOf("*");
    if (star === -1) continue;
    const prefix = patternKey.slice(0, star);
    const suffix = patternKey.slice(star + 1);
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    if (key.length < prefix.length + suffix.length) continue;
    if (best === null || prefix.length > best.prefix.length) best = { prefix, suffix, value: map[patternKey] };
  }
  if (best === null) return null;
  const captured = key.slice(best.prefix.length, key.length - best.suffix.length);
  const target = resolveExportsTarget(best.value, flags);
  return target === null ? null : target.split("*").join(captured);
}

// ---------------------------------------------------------------------------
// In-package resolution
// ---------------------------------------------------------------------------

const LEGACY_ENTRY_FIELDS = ["module", "browser", "main"] as const;

async function resolveInPackage(
  vfs: ResolverVfs,
  pkgDir: string,
  subpath: string,
  flags: ConditionFlags,
): Promise<{ kind: "vfs"; path: string } | { kind: "esm.sh"; url: string } | null> {
  const pkg = await readPackageJson(vfs, `${pkgDir}/package.json`);
  const key = subpath === "" ? "." : `./${subpath}`;

  const exportsField = pkg?.exports;
  if (exportsField !== undefined && exportsField !== null) {
    const target = lookupExports(exportsField, key, flags);
    if (target !== null) {
      if (/^https?:\/\//.test(target)) return { kind: "esm.sh", url: target };
      const exact = joinPath(pkgDir, target);
      if (await isFile(vfs, exact)) return { kind: "vfs", path: exact };
      const probed = await nodeProbe(vfs, exact); // lenient: Node is strict here
      if (probed !== null) return { kind: "vfs", path: probed };
    }
    // exports present but unmatched/broken → fall through (lenient deviation).
  }

  if (subpath !== "") {
    const direct = await nodeProbe(vfs, joinPath(pkgDir, subpath));
    return direct === null ? null : { kind: "vfs", path: direct };
  }

  for (const field of LEGACY_ENTRY_FIELDS) {
    const value = pkg?.[field];
    if (typeof value !== "string" || value.length === 0) continue;
    if (field === "browser" && /^https?:\/\//.test(value)) return { kind: "esm.sh", url: value };
    const probed = await nodeProbe(vfs, joinPath(pkgDir, value));
    if (probed !== null) return { kind: "vfs", path: probed };
  }

  const index = await nodeProbe(vfs, joinPath(pkgDir, "index"));
  return index === null ? null : { kind: "vfs", path: index };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a bare specifier against installed node_modules, walking up from the
 * importer's directory (nested layouts win over hoisted ones). A package dir
 * that exists but resolves to nothing keeps walking up (Node behaviour).
 */
export async function resolveBareSpecifier(
  spec: string,
  importerPath: string,
  vfs: ResolverVfs,
): Promise<BareResolution> {
  const parsed = parseBareSpecifier(spec);
  if (parsed === null) return { kind: "not-found", reason: "invalid bare specifier" };

  let dir = dirname(normalizePath(importerPath));
  for (;;) {
    const pkgDir = joinPath(dir, "node_modules", parsed.pkg);
    if (await isDirectory(vfs, pkgDir)) {
      const flags: ConditionFlags = { viaRequire: false };
      const resolved = await resolveInPackage(vfs, pkgDir, parsed.subpath, flags);
      if (resolved !== null) {
        return resolved.kind === "vfs"
          ? { kind: "vfs", path: resolved.path, viaRequireCondition: flags.viaRequire }
          : resolved;
      }
    }
    if (dir === "/" || dir === ".") break;
    dir = dirname(dir);
  }
  return { kind: "not-found", reason: `package "${parsed.pkg}" is not installed` };
}

/** Node builtin module roots (require("fs"), require("node:path"), "fs/promises", …). */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2",
  "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls",
  "trace_events", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

/**
 * Resolution for `require()` specifiers inside CommonJS modules (see ./cjs.ts):
 *  - relative/absolute → node-style probe (.js/.mjs/.cjs/.json + index.js),
 *  - "node:*" → builtin immediately,
 *  - bare → node_modules first; an uninstalled builtin name (e.g. "path")
 *    classifies as builtin only AFTER the node_modules walk misses (so an
 *    installed polyfill wins).
 */
export async function resolveRequireSpecifier(
  spec: string,
  importerPath: string,
  vfs: ResolverVfs,
): Promise<RequireResolution> {
  if (spec.startsWith("node:")) return { kind: "builtin", name: spec.slice("node:".length) };

  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
    const base = spec.startsWith("/") ? normalizePath(spec) : joinPath(dirname(normalizePath(importerPath)), spec);
    const probed = await nodeProbe(vfs, base);
    if (probed === null) return { kind: "not-found", reason: `file not found: ${base}` };
    return { kind: "vfs", path: probed, viaRequireCondition: true };
  }

  const bare = await resolveBareSpecifier(spec, importerPath, vfs);
  if (bare.kind === "not-found") {
    const parsed = parseBareSpecifier(spec);
    if (parsed !== null && NODE_BUILTINS.has(parsed.pkg)) return { kind: "builtin", name: spec };
  }
  if (bare.kind === "vfs") return { ...bare, viaRequireCondition: true };
  return bare;
}
