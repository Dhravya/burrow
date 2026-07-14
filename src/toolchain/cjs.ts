/**
 * Burrow src/toolchain — CommonJS-in-Worker support.
 *
 * bun.wasm passes CommonJS sources through as-is (no ESM conversion), and the
 * runner executes every module as a blob-URL ESM import inside the run worker.
 * So each CJS module is wrapped in a generated ESM facade:
 *
 *   import { register, interop, … } from "<cjs-registry blob>";
 *   const __module = { exports: {} };
 *   register("<abs path>", __module);            // BEFORE deps → cycle partials
 *   const __mod0 = await import("<dep blob>");   // deps preloaded bottom-up
 *   const require = spec => … synchronous lookup …;
 *   (function (module, exports, require, __filename, __dirname) {
 *     <original source>
 *   }).call(__module.exports, __module, __module.exports, require, …);
 *   export default __module.exports;
 *   export const <name> = __module.exports["<name>"];  // statically detected
 *
 * `require()` maps to a synchronous per-module deps table; because the graph
 * is walked bottom-up, every dep has fully evaluated (and, if CJS, registered
 * its exports in the burrow:cjs-registry virtual module) before the facade's
 * body runs.
 *
 * Circular requires get Node's partial-exports semantics: a facade registers
 * its `module` object in the registry BEFORE dynamically importing its deps,
 * and a require() edge that points back at a module currently being built
 * (a cycle) compiles to a registry lookup at call time instead of an import —
 * so the ancestor's partially-filled exports are returned, like Node.
 *
 * Known limitations (documented, acceptable v1):
 *  - deps are evaluated eagerly before the module body (ESM ordering), not
 *    lazily at the require() call site — side-effect order can differ;
 *  - CJS bodies run in strict mode (ESM) — sloppy-mode-only code breaks;
 *  - a cycle whose ancestor is an ESM module (not CJS) fails at require()
 *    time with MODULE_NOT_FOUND instead of at build time;
 *  - require() of an ESM/esm.sh module returns its default export when one
 *    exists, else the namespace object;
 *  - named re-exports are detected statically (exports.x = / module.exports.x
 *    = / Object.defineProperty(exports, "x", …)); `module.exports = { … }`
 *    object-literal keys are NOT enumerated — the default export still
 *    carries everything;
 *  - node builtins required from CJS throw MODULE_NOT_FOUND at call time
 *    (so `try { require("optional-native") } catch {}` patterns degrade
 *    gracefully instead of failing the build).
 */

import { nodeBuiltinUrl } from "./node-builtins.ts";
import { dirname } from "./paths.ts";
import { resolveRequireSpecifier, type ResolverVfs } from "./node-resolve.ts";

// ---------------------------------------------------------------------------
// require() extraction (regex over bun.wasm's normalized output, same v1
// stance as ./specifiers.ts — only string-literal arguments are touched).
// ---------------------------------------------------------------------------

export interface RequireOccurrence {
  spec: string;
  /** start/end delimit the specifier text INSIDE the quotes. */
  start: number;
  end: number;
}

const requireRe = () => /(?<![.\w$])require\s*\(\s*(["'])([^"'\\\n]+)\1\s*\)/dg;

export function findRequires(code: string): RequireOccurrence[] {
  const out: RequireOccurrence[] = [];
  const re = requireRe();
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    const spec = match[2];
    const range = match.indices?.[2];
    if (spec === undefined || range === undefined) continue;
    out.push({ spec, start: range[0], end: range[1] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CJS detection
// ---------------------------------------------------------------------------

const CJS_MARKER_RE =
  /(?<![.\w$])(?:require\s*\(|module\.exports\b|exports\.[A-Za-z_$]|Object\.defineProperty\s*\(\s*(?:module\.)?exports\b)/;
// Static import forms only — dynamic import() is legal inside CJS too.
const ESM_IMPORT_RE = /(?<![.\w$])import(?:\s+[\w$*{"']|\s*["'{*])/;
const ESM_EXPORT_RE = /(?<![.\w$])export(?:\s+(?:default|const|let|var|function|async|class)\b|\s*[{*])/;

/** Pure content check: CommonJS markers present AND no static ESM syntax. */
export function isCjsSource(code: string): boolean {
  if (ESM_IMPORT_RE.test(code) || ESM_EXPORT_RE.test(code)) return false;
  return CJS_MARKER_RE.test(code);
}

/** "type" of the NEAREST package.json (walking up), or null (≙ commonjs). */
export async function nearestPackageType(vfs: ResolverVfs, fromPath: string): Promise<string | null> {
  let dir = dirname(fromPath);
  for (;;) {
    try {
      const raw: unknown = JSON.parse(await vfs.readFile(dir === "/" ? "/package.json" : `${dir}/package.json`));
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        const type = (raw as Record<string, unknown>).type;
        return typeof type === "string" ? type : null; // nearest package.json decides
      }
    } catch {
      /* missing/unparsable — keep walking */
    }
    if (dir === "/" || dir === ".") return null;
    dir = dirname(dir);
  }
}

/**
 * Contract detection rule: the resolved file is .cjs, OR the nearest
 * package.json lacks type:module AND the transpiled output still contains
 * CommonJS markers (bun.wasm reports/loads CJS as-is).
 */
export async function isCjsModule(path: string, transpiledCode: string, vfs: ResolverVfs): Promise<boolean> {
  const base = path.toLowerCase().slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  if (ext === "cjs") return true;
  if (ext === "cts") return isCjsSource(transpiledCode); // .cts is always CJS in Node
  if (ext !== "js" && ext !== "") return false; // .ts/.tsx/.mjs/… transpile to ESM
  if (!isCjsSource(transpiledCode)) return false;
  return (await nearestPackageType(vfs, path)) !== "module";
}

// ---------------------------------------------------------------------------
// Static named-export detection ("where statically safe")
// ---------------------------------------------------------------------------

const RESERVED_WORDS = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "eval", "export", "extends", "false", "finally",
  "for", "function", "if", "implements", "import", "in", "instanceof", "interface", "let",
  "new", "null", "package", "private", "protected", "public", "return", "static", "super",
  "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
]);

/** Names the facade itself declares — never re-export them. */
const FACADE_INTERNAL_RE = /^__(?:module|deps|paths|require|exports|register|requirePath|interop|missing|burrowCjs|(?:ext|extp|mod)\d+)$/;

export function detectNamedExports(source: string): string[] {
  const names = new Set<string>();
  const assignRe = /(?<![.\w$])(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=(?!=)/g;
  const defineRe = /Object\.defineProperty\s*\(\s*(?:module\.)?exports\s*,\s*(["'])([A-Za-z_$][\w$]*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = assignRe.exec(source)) !== null) if (match[1] !== undefined) names.add(match[1]);
  while ((match = defineRe.exec(source)) !== null) if (match[2] !== undefined) names.add(match[2]);
  return [...names].filter(
    (name) => !RESERVED_WORDS.has(name) && name !== "default" && !FACADE_INTERNAL_RE.test(name),
  );
}

// ---------------------------------------------------------------------------
// burrow:cjs-registry — virtual module (one blob per page; module workers get
// a fresh instance per worker, so registry state is naturally per-session).
// ---------------------------------------------------------------------------

export const CJS_REGISTRY_SOURCE = `/* burrow:cjs-registry (generated) */
if (typeof globalThis.global === "undefined") { try { globalThis.global = globalThis; } catch (_e) {} }
const modules = new Map();
export function register(path, mod) { modules.set(path, mod); }
export function requirePath(path, spec) {
  const mod = modules.get(path);
  if (mod === undefined) {
    const err = new Error("Cannot find module '" + spec + "' (burrow: cyclic require target " + path + " has not started evaluating — mixed ESM/CJS cycles are unsupported)");
    err.code = "MODULE_NOT_FOUND";
    throw err;
  }
  return mod.exports;
}
export function interop(ns) {
  if (ns && ns.__burrowCjs === true) return ns.default;
  if (ns && typeof ns === "object" && "default" in ns && ns.default !== undefined) return ns.default;
  return ns;
}
export function missing(spec) {
  const err = new Error("Cannot find module '" + spec + "'");
  err.code = "MODULE_NOT_FOUND";
  throw err;
}
`;

let registryUrl: string | null = null;

/** Page-lifetime singleton blob URL for the registry module (never revoked). */
export function getCjsRegistryUrl(): string {
  if (registryUrl === null) {
    registryUrl = URL.createObjectURL(new Blob([CJS_REGISTRY_SOURCE], { type: "text/javascript" }));
  }
  return registryUrl;
}

// ---------------------------------------------------------------------------
// Facade codegen (pure)
// ---------------------------------------------------------------------------

export type CjsFacadeDep =
  /** A built VFS child module (blob/data URL) — awaited AFTER self-registration. */
  | { spec: string; kind: "module"; url: string; path: string }
  /** An https URL (esm.sh) — imported resiliently; failure → MODULE_NOT_FOUND at call time. */
  | { spec: string; kind: "external"; url: string }
  /** A require() edge back into a module currently being built — registry lookup at call time. */
  | { spec: string; kind: "cycle"; path: string }
  /** Unresolvable (node builtin / missing file) — throws MODULE_NOT_FOUND at call time. */
  | { spec: string; kind: "missing"; reason?: string };

export interface CjsFacadeOptions {
  /** Absolute VFS path of the CJS module (registry key, __filename). */
  path: string;
  /** Transpiled (or raw) CommonJS source. */
  source: string;
  /** URL of the cjs-registry module (blob in the app; any importable URL in tests). */
  registryUrl: string;
  deps: CjsFacadeDep[];
}

/** Generate the ESM facade for one CommonJS module. Pure text transform. */
export function renderCjsFacade(options: CjsFacadeOptions): string {
  const { path, source, registryUrl: regUrl, deps } = options;
  const lines: string[] = [];
  lines.push(`/* burrow cjs facade for ${path} (generated) */`);
  lines.push(
    `import { register as __register, requirePath as __requirePath, interop as __interop, missing as __missing } from ${JSON.stringify(regUrl)};`,
  );
  lines.push(`const __module = { exports: {}, id: ${JSON.stringify(path)}, filename: ${JSON.stringify(path)}, loaded: false };`);
  // Register BEFORE loading deps: a cyclic require back into this module gets
  // the partially-filled exports object (Node semantics).
  lines.push(`__register(${JSON.stringify(path)}, __module);`);

  const externals = deps.filter((d) => d.kind === "external");
  const modules = deps.filter((d) => d.kind === "module");
  // Externals: start all fetches in parallel; tolerate failures so optional
  // deps (`try { require("x") } catch {}`) degrade to a call-time throw.
  externals.forEach((dep, i) => {
    lines.push(`const __extp${i} = import(${JSON.stringify(dep.url)}).catch(() => undefined);`);
  });
  modules.forEach((dep, i) => {
    lines.push(`const __mod${i} = await import(${JSON.stringify(dep.url)});`);
  });
  externals.forEach((_dep, i) => {
    lines.push(`const __ext${i} = await __extp${i};`);
  });

  lines.push(`const __deps = Object.create(null);`);
  lines.push(`const __paths = Object.create(null);`);
  let moduleIndex = 0;
  let externalIndex = 0;
  for (const dep of deps) {
    const spec = JSON.stringify(dep.spec);
    switch (dep.kind) {
      case "module":
        lines.push(`__deps[${spec}] = () => __interop(__mod${moduleIndex});`);
        lines.push(`__paths[${spec}] = ${JSON.stringify(dep.path)};`);
        moduleIndex++;
        break;
      case "external": {
        const i = externalIndex++;
        lines.push(`__deps[${spec}] = () => (__ext${i} === undefined ? __missing(${spec}) : __interop(__ext${i}));`);
        lines.push(`__paths[${spec}] = ${JSON.stringify(dep.url)};`);
        break;
      }
      case "cycle":
        lines.push(`__deps[${spec}] = () => __requirePath(${JSON.stringify(dep.path)}, ${spec});`);
        lines.push(`__paths[${spec}] = ${JSON.stringify(dep.path)};`);
        break;
      case "missing":
        lines.push(`__deps[${spec}] = () => __missing(${spec});`);
        break;
    }
  }
  lines.push(`const __require = (spec) => { const dep = __deps[spec]; return dep === undefined ? __missing(spec) : dep(); };`);
  lines.push(`__require.resolve = (spec) => { const p = __paths[spec]; if (p === undefined) __missing(spec); return p; };`);
  lines.push(`__require.cache = Object.create(null);`);
  lines.push(`(function (module, exports, require, __filename, __dirname) {`);
  lines.push(source);
  lines.push(
    `}).call(__module.exports, __module, __module.exports, __require, ${JSON.stringify(path)}, ${JSON.stringify(dirname(path))});`,
  );
  lines.push(`__module.loaded = true;`);
  lines.push(`const __exports = __module.exports;`);
  lines.push(`export default __exports;`);
  lines.push(`export const __burrowCjs = true;`);
  for (const name of detectNamedExports(source)) {
    lines.push(`export const ${name} = __exports[${JSON.stringify(name)}];`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Build orchestration — the graph walker plugs its recursion in via CjsBuildHost.
// ---------------------------------------------------------------------------

export interface CjsBuildHost {
  vfs: ResolverVfs;
  /** True when `path` is an ancestor currently being built (a require cycle). */
  isCycle(path: string): boolean;
  /** Build a dep module (recursion into the graph walker); null = failed (error recorded). */
  buildChild(path: string): Promise<string | null>;
  /** esm.sh URL for an uninstalled bare specifier (graph's version-pinning walk), or null. */
  esmShFallback(spec: string): Promise<string | null>;
}

export interface CjsFacadeBuild {
  /** Facade module source, or null when a dep failed to build (errors below). */
  code: string | null;
  /** BuiltModule.deps mapping: original specifier → resolved path/URL. */
  deps: Record<string, string>;
  errors: string[];
}

/** Resolve every require() of a CJS module, build its deps, render the facade. */
export async function buildCjsFacade(
  path: string,
  transpiledCode: string,
  registryModuleUrl: string,
  host: CjsBuildHost,
): Promise<CjsFacadeBuild> {
  const errors: string[] = [];
  const deps: Record<string, string> = {};
  const facadeDeps: CjsFacadeDep[] = [];

  for (const spec of new Set(findRequires(transpiledCode).map((o) => o.spec))) {
    const resolved = await resolveRequireSpecifier(spec, path, host.vfs);
    switch (resolved.kind) {
      case "vfs": {
        deps[spec] = resolved.path;
        if (host.isCycle(resolved.path)) {
          facadeDeps.push({ spec, kind: "cycle", path: resolved.path });
          break;
        }
        const childUrl = await host.buildChild(resolved.path);
        if (childUrl === null) {
          errors.push(`cannot build required module "${spec}" (${resolved.path})`);
          break;
        }
        facadeDeps.push({ spec, kind: "module", url: childUrl, path: resolved.path });
        break;
      }
      case "esm.sh":
        deps[spec] = resolved.url;
        facadeDeps.push({ spec, kind: "external", url: resolved.url });
        break;
      case "builtin": {
        // Route require("fs")/require("node:path")/… to the builtin shims. The
        // shim's `default` export (unwrapped by interop) is the module object,
        // matching Node's require() shape.
        const url = nodeBuiltinUrl(spec);
        if (url !== null) {
          deps[spec] = url;
          facadeDeps.push({ spec, kind: "external", url });
        } else {
          facadeDeps.push({ spec, kind: "missing", reason: `node builtin "${resolved.name}"` });
        }
        break;
      }
      case "not-found": {
        if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
          facadeDeps.push({ spec, kind: "missing", reason: resolved.reason });
          break;
        }
        const url = await host.esmShFallback(spec);
        if (url !== null) {
          deps[spec] = url;
          facadeDeps.push({ spec, kind: "external", url });
        } else {
          facadeDeps.push({ spec, kind: "missing", reason: resolved.reason });
        }
        break;
      }
    }
  }

  if (errors.length > 0) return { code: null, deps, errors };
  return {
    code: renderCjsFacade({ path, source: transpiledCode, registryUrl: registryModuleUrl, deps: facadeDeps }),
    deps,
    errors,
  };
}
