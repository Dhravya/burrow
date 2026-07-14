/**
 * Burrow src/toolchain — module graph builder (CONTRACT.md §6.2).
 *
 * DFS from the entry: transpile each VFS module with bun.wasm, extract import
 * specifiers from the TRANSPILED output, resolve them (VFS probing / esm.sh /
 * runtime shim), mint blob: module URLs bottom-up with specifiers textually
 * rewritten. Import cycles are a BuildError.
 */

import { use } from "../contract/registry.ts";
import { WORKSPACE_ROOT } from "../contract/types.ts";
import type {
  BuildError,
  BuildGraphResult,
  BuiltModule,
  BurrowVfs,
  TranspileResult,
} from "../contract/types.ts";
import { buildCjsFacade, getCjsRegistryUrl, isCjsModule } from "./cjs.ts";
import { isNodeBuiltin, nodeBuiltinName, nodeBuiltinUrl } from "./node-builtins.ts";
import { resolveBareSpecifier } from "./node-resolve.ts";
import { dirname, joinPath, loaderForPath, normalizePath } from "./paths.ts";
import { findSpecifiers, rewriteSpecifiers } from "./specifiers.ts";
import { transpileSource } from "./wasm.ts";

const PROBE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

interface Ctx {
  vfs: BurrowVfs;
  /** abs path -> blob url (null = failed; error already recorded). */
  done: Map<string, string | null>;
  visiting: Set<string>;
  errors: BuildError[];
  built: BuiltModule[];
  blobUrls: string[];
  /** package.json path -> merged deps map (null = missing/unparsable). */
  pkgCache: Map<string, Record<string, string> | null>;
}

// ---------------------------------------------------------------------------
// burrow:serve / bun runtime shim — a tiny module that re-exports the Bun
// global installed by the run-worker bootstrap. Page-lifetime singleton blob
// (never revoked; shared by every session).
// ---------------------------------------------------------------------------

let runtimeShimUrl: string | null = null;

export function getRuntimeShimUrl(): string {
  if (runtimeShimUrl === null) {
    const code = [
      "const serveImpl = (options) => {",
      "  const fn = globalThis.__burrowServe;",
      '  if (typeof fn !== "function") throw new Error("burrow: the Bun runtime shim only exists inside `bun run` workers");',
      "  return fn(options);",
      "};",
      "const __burrow = { serve: serveImpl, env: (globalThis.Bun && globalThis.Bun.env) || {} };",
      "export const serve = serveImpl;",
      "export const env = __burrow.env;",
      "export default __burrow;",
      "",
    ].join("\n");
    runtimeShimUrl = mintBlobUrl(code);
  }
  return runtimeShimUrl;
}

function mintBlobUrl(code: string): string {
  return URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

async function isVfsFile(vfs: BurrowVfs, path: string): Promise<boolean> {
  try {
    return (await vfs.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** Probe `x, x.ts, x.tsx, x.js, x.jsx, x/index.ts, x/index.tsx, x/index.js, x/index.jsx`. */
export async function probeFile(vfs: BurrowVfs, base: string): Promise<string | null> {
  for (const suffix of PROBE_SUFFIXES) {
    const candidate = base + suffix;
    if (await isVfsFile(vfs, candidate)) return candidate;
  }
  return null;
}

function parseBare(spec: string): { pkg: string; subpath: string } | null {
  const parts = spec.split("/");
  if (spec.startsWith("@")) {
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return { pkg: `${parts[0]}/${parts[1]}`, subpath: parts.length > 2 ? `/${parts.slice(2).join("/")}` : "" };
  }
  if (!parts[0]) return null;
  return { pkg: parts[0], subpath: parts.length > 1 ? `/${parts.slice(1).join("/")}` : "" };
}

/**
 * Walk up from the importing file's directory; the first package.json whose
 * dependencies/devDependencies names the package wins. No match -> null
 * (esm.sh serves latest).
 */
async function nearestVersion(pkg: string, fromDir: string, ctx: Ctx): Promise<string | null> {
  let dir = fromDir;
  for (;;) {
    const pkgPath = dir === "/" ? "/package.json" : `${dir}/package.json`;
    let deps = ctx.pkgCache.get(pkgPath);
    if (deps === undefined) {
      try {
        const parsed = JSON.parse(await ctx.vfs.readFile(pkgPath)) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        deps = { ...(parsed.devDependencies ?? {}), ...(parsed.dependencies ?? {}) };
      } catch {
        deps = null;
      }
      ctx.pkgCache.set(pkgPath, deps);
    }
    const version = deps?.[pkg];
    if (typeof version === "string" && version.length > 0) return version;
    if (dir === "/") return null;
    dir = dirname(dir);
  }
}

type Resolved =
  | { kind: "vfs"; path: string }
  | { kind: "external"; url: string; rewrite: boolean }
  | { kind: "shim" }
  | { kind: "fail"; message: string };

async function resolveSpecifier(spec: string, importer: string, ctx: Ctx): Promise<Resolved> {
  if (spec === "bun" || spec === "burrow:serve") return { kind: "shim" };
  if (/^(https?:|blob:|data:)/.test(spec)) return { kind: "external", url: spec, rewrite: false };

  // Node builtins (both `node:fs` and bare `fs`): core modules win over
  // node_modules, matching Node's resolution. An unknown `node:` specifier is a
  // real failure; an unknown bare name falls through to the package resolver.
  if (spec.startsWith("node:")) {
    const url = nodeBuiltinUrl(spec);
    if (url !== null) return { kind: "external", url, rewrite: true };
    return { kind: "fail", message: `unknown Node builtin "${nodeBuiltinName(spec) ?? spec}" (not shimmed by the Burrow sandbox)` };
  }
  if (spec.startsWith("bun:")) return { kind: "fail", message: "Bun builtins are not available in the browser sandbox" };

  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
    const base = spec.startsWith("/") ? normalizePath(spec) : joinPath(dirname(importer), spec);
    const found = await probeFile(ctx.vfs, base);
    if (found === null) {
      return { kind: "fail", message: `file not found (tried ${base}, +.ts/.tsx/.js/.jsx, +/index.*)` };
    }
    return { kind: "vfs", path: found };
  }

  // Bare builtin name (e.g. `fs`, `events`, `stream`): Node core wins over any
  // like-named package in node_modules.
  if (isNodeBuiltin(spec)) {
    const url = nodeBuiltinUrl(spec);
    if (url !== null) return { kind: "external", url, rewrite: true };
  }

  // Bare specifier: an INSTALLED package (src/npm → node_modules in the VFS)
  // wins over the esm.sh rewrite; "not-found" falls through to esm.sh below.
  const installed = await resolveBareSpecifier(spec, importer, ctx.vfs);
  if (installed.kind === "vfs") return { kind: "vfs", path: installed.path };
  if (installed.kind === "esm.sh") return { kind: "external", url: installed.url, rewrite: true };

  const parsed = parseBare(spec);
  if (parsed === null) return { kind: "fail", message: "invalid module specifier" };
  const version = await nearestVersion(parsed.pkg, dirname(importer), ctx);
  const url = `https://esm.sh/${parsed.pkg}${version ? `@${encodeURIComponent(version)}` : ""}${parsed.subpath}`;
  return { kind: "external", url, rewrite: true };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function buildModule(path: string, ctx: Ctx): Promise<string | null> {
  const memo = ctx.done.get(path);
  if (memo !== undefined) return memo;
  if (ctx.visiting.has(path)) {
    ctx.errors.push({
      path,
      message: `import cycles are unsupported: ${[...ctx.visiting, path].join(" -> ")}`,
    });
    return null;
  }
  ctx.visiting.add(path);
  try {
    const blobUrl = await buildModuleInner(path, ctx);
    ctx.done.set(path, blobUrl);
    return blobUrl;
  } finally {
    ctx.visiting.delete(path);
  }
}

async function buildModuleInner(path: string, ctx: Ctx): Promise<string | null> {
  let source: string;
  try {
    source = await ctx.vfs.readFile(path);
  } catch (error) {
    ctx.errors.push({ path, message: `cannot read file: ${errorMessage(error)}` });
    return null;
  }

  // .json files become a synthesized default-export module.
  if (path.toLowerCase().endsWith(".json")) {
    try {
      JSON.parse(source);
    } catch (error) {
      ctx.errors.push({ path, message: `invalid JSON: ${errorMessage(error)}` });
      return null;
    }
    const blobUrl = mintTracked(`export default JSON.parse(${JSON.stringify(source)});\n`, ctx);
    ctx.built.push({ path, blobUrl, deps: {} });
    return blobUrl;
  }

  const transpiled: TranspileResult = await transpileSource(source, loaderForPath(path));
  if (!transpiled.ok) {
    ctx.errors.push({ path, message: transpiled.error });
    return null;
  }

  // CommonJS (bun.wasm passes it through as-is): wrap in an ESM facade whose
  // require() reads a synchronous registry of already-loaded modules (cjs.ts).
  if (await isCjsModule(path, transpiled.code, ctx.vfs)) {
    return buildCjsModule(path, transpiled.code, ctx);
  }

  const occurrences = findSpecifiers(transpiled.code);
  const deps: Record<string, string> = {};
  const mapping = new Map<string, string>();
  let failed = false;

  for (const spec of new Set(occurrences.map((o) => o.spec))) {
    const resolved = await resolveSpecifier(spec, path, ctx);
    switch (resolved.kind) {
      case "fail":
        ctx.errors.push({ path, message: `cannot resolve "${spec}": ${resolved.message}` });
        failed = true;
        break;
      case "shim": {
        const url = getRuntimeShimUrl();
        deps[spec] = url;
        mapping.set(spec, url);
        break;
      }
      case "external":
        deps[spec] = resolved.url;
        if (resolved.rewrite) mapping.set(spec, resolved.url);
        break;
      case "vfs": {
        deps[spec] = resolved.path;
        const childUrl = await buildModule(resolved.path, ctx);
        if (childUrl === null) failed = true;
        else mapping.set(spec, childUrl);
        break;
      }
    }
  }

  if (failed) return null;

  const blobUrl = mintTracked(rewriteSpecifiers(transpiled.code, occurrences, mapping), ctx);
  ctx.built.push({ path, blobUrl, deps });
  return blobUrl;
}

/** Build one CommonJS module: resolve its require()s, wrap it in an ESM facade. */
async function buildCjsModule(path: string, transpiledCode: string, ctx: Ctx): Promise<string | null> {
  const facade = await buildCjsFacade(path, transpiledCode, getCjsRegistryUrl(), {
    vfs: ctx.vfs,
    isCycle: (p) => ctx.visiting.has(p),
    buildChild: (p) => buildModule(p, ctx),
    esmShFallback: async (spec) => {
      const parsed = parseBare(spec);
      if (parsed === null) return null;
      const version = await nearestVersion(parsed.pkg, dirname(path), ctx);
      return `https://esm.sh/${parsed.pkg}${version ? `@${encodeURIComponent(version)}` : ""}${parsed.subpath}`;
    },
  });
  if (facade.code === null) {
    for (const message of facade.errors) ctx.errors.push({ path, message });
    return null;
  }
  const blobUrl = mintTracked(facade.code, ctx);
  ctx.built.push({ path, blobUrl, deps: facade.deps });
  return blobUrl;
}

function mintTracked(code: string, ctx: Ctx): string {
  const url = mintBlobUrl(code);
  ctx.blobUrls.push(url);
  return url;
}

/** Resolve+transpile the whole graph, rewrite specifiers, mint blob: URLs bottom-up. */
export async function buildGraph(entryPath: string): Promise<BuildGraphResult> {
  return buildGraphWith(use("vfs"), entryPath);
}

/** buildGraph over an explicit VFS (tests inject a fake; the contract entrypoint above uses the registry). */
export async function buildGraphWith(vfs: BurrowVfs, entryPath: string): Promise<BuildGraphResult> {
  const ctx: Ctx = {
    vfs,
    done: new Map(),
    visiting: new Set(),
    errors: [],
    built: [],
    blobUrls: [],
    pkgCache: new Map(),
  };

  const base = entryPath.startsWith("/") ? normalizePath(entryPath) : joinPath(WORKSPACE_ROOT, entryPath);
  const entryFile = await probeFile(vfs, base);
  if (entryFile === null) {
    return { ok: false, errors: [{ path: base, message: "entry not found" }] };
  }

  const entryBlobUrl = await buildModule(entryFile, ctx);
  if (entryBlobUrl === null || ctx.errors.length > 0) {
    for (const url of ctx.blobUrls) URL.revokeObjectURL(url);
    return {
      ok: false,
      errors: ctx.errors.length > 0 ? ctx.errors : [{ path: entryFile, message: "build failed" }],
    };
  }
  return { ok: true, entryBlobUrl, modules: ctx.built };
}

/** Contract ToolchainAPI.transpileFile. */
export async function transpileFile(path: string): Promise<TranspileResult> {
  const vfs = use("vfs");
  let source: string;
  try {
    source = await vfs.readFile(path);
  } catch (error) {
    return { ok: false, error: `${path}: ${errorMessage(error)}` };
  }
  return transpileSource(source, loaderForPath(path));
}
