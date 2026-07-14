/**
 * Burrow src/toolchain — tests for Node-style bare-specifier resolution
 * (node-resolve.ts) over a fake VFS, and for the CommonJS ESM-facade
 * transform (cjs.ts) — both as a pure text transform and EXECUTED via
 * data: URL module imports (Bun supports them natively).
 */

import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  buildCjsFacade,
  CJS_REGISTRY_SOURCE,
  detectNamedExports,
  findRequires,
  isCjsModule,
  isCjsSource,
  nearestPackageType,
  renderCjsFacade,
} from "./cjs.ts";
import {
  nodeProbe,
  parseBareSpecifier,
  resolveBareSpecifier,
  resolveRequireSpecifier,
  type ResolverVfs,
} from "./node-resolve.ts";
import { dirname } from "./paths.ts";

// ---------------------------------------------------------------------------
// Fake VFS
// ---------------------------------------------------------------------------

function fakeVfs(files: Record<string, string>): ResolverVfs {
  const fileSet = new Set(Object.keys(files));
  const dirSet = new Set<string>(["/"]);
  for (const path of fileSet) {
    let dir = dirname(path);
    while (dir !== "/" && !dirSet.has(dir)) {
      dirSet.add(dir);
      dir = dirname(dir);
    }
  }
  return {
    async readFile(path: string) {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return content;
    },
    async stat(path: string) {
      if (fileSet.has(path)) return { isFile: true, isDirectory: false };
      if (dirSet.has(path)) return { isFile: false, isDirectory: true };
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    },
  };
}

const APP = "/home/user/app";
const IMPORTER = `${APP}/src/index.js`;

function vfsPath(r: Awaited<ReturnType<typeof resolveBareSpecifier>>): string {
  if (r.kind !== "vfs") throw new Error(`expected vfs resolution, got ${JSON.stringify(r)}`);
  return r.path;
}

// ---------------------------------------------------------------------------
// parseBareSpecifier
// ---------------------------------------------------------------------------

test("parseBareSpecifier: plain, scoped, subpaths, invalid", () => {
  expect(parseBareSpecifier("ms")).toEqual({ pkg: "ms", subpath: "" });
  expect(parseBareSpecifier("lodash/fp/curry")).toEqual({ pkg: "lodash", subpath: "fp/curry" });
  expect(parseBareSpecifier("@scope/pkg")).toEqual({ pkg: "@scope/pkg", subpath: "" });
  expect(parseBareSpecifier("@scope/pkg/sub/x")).toEqual({ pkg: "@scope/pkg", subpath: "sub/x" });
  expect(parseBareSpecifier("@scope")).toBeNull();
  expect(parseBareSpecifier("./relative")).toBeNull();
  expect(parseBareSpecifier("/abs")).toBeNull();
  expect(parseBareSpecifier("")).toBeNull();
});

// ---------------------------------------------------------------------------
// resolveBareSpecifier — layouts
// ---------------------------------------------------------------------------

test("hoisted layout: walk up from the importer to node_modules", async () => {
  const vfs = fakeVfs({
    [`${APP}/node_modules/ms/package.json`]: JSON.stringify({ main: "index.js" }),
    [`${APP}/node_modules/ms/index.js`]: "module.exports = () => 1;",
  });
  expect(vfsPath(await resolveBareSpecifier("ms", IMPORTER, vfs))).toBe(`${APP}/node_modules/ms/index.js`);
});

test("nested layout wins over hoisted (closest node_modules first)", async () => {
  const vfs = fakeVfs({
    [`${APP}/node_modules/dep/package.json`]: JSON.stringify({ main: "hoisted.js" }),
    [`${APP}/node_modules/dep/hoisted.js`]: "",
    [`${APP}/node_modules/parent/node_modules/dep/package.json`]: JSON.stringify({ main: "nested.js" }),
    [`${APP}/node_modules/parent/node_modules/dep/nested.js`]: "",
    [`${APP}/node_modules/parent/index.js`]: "",
  });
  const fromParent = await resolveBareSpecifier("dep", `${APP}/node_modules/parent/index.js`, vfs);
  expect(vfsPath(fromParent)).toBe(`${APP}/node_modules/parent/node_modules/dep/nested.js`);
  const fromApp = await resolveBareSpecifier("dep", IMPORTER, vfs);
  expect(vfsPath(fromApp)).toBe(`${APP}/node_modules/dep/hoisted.js`);
});

test("scoped packages resolve", async () => {
  const vfs = fakeVfs({
    [`${APP}/node_modules/@scope/pkg/package.json`]: JSON.stringify({ main: "lib/entry.js" }),
    [`${APP}/node_modules/@scope/pkg/lib/entry.js`]: "",
  });
  expect(vfsPath(await resolveBareSpecifier("@scope/pkg", IMPORTER, vfs))).toBe(
    `${APP}/node_modules/@scope/pkg/lib/entry.js`,
  );
});

test("not installed -> not-found (graph falls back to esm.sh)", async () => {
  const vfs = fakeVfs({ [`${APP}/package.json`]: "{}" });
  const r = await resolveBareSpecifier("left-pad", IMPORTER, vfs);
  expect(r.kind).toBe("not-found");
});

// ---------------------------------------------------------------------------
// resolveBareSpecifier — exports maps
// ---------------------------------------------------------------------------

test("exports string form", async () => {
  const vfs = fakeVfs({
    [`${APP}/node_modules/pkg/package.json`]: JSON.stringify({ exports: "./dist/index.js" }),
    [`${APP}/node_modules/pkg/dist/index.js`]: "",
  });
  expect(vfsPath(await resolveBareSpecifier("pkg", IMPORTER, vfs))).toBe(`${APP}/node_modules/pkg/dist/index.js`);
});

test("exports condition order: browser > import > default > require", async () => {
  const files = {
    [`${APP}/node_modules/pkg/browser.js`]: "",
    [`${APP}/node_modules/pkg/import.mjs`]: "",
    [`${APP}/node_modules/pkg/default.js`]: "",
    [`${APP}/node_modules/pkg/require.cjs`]: "",
  };
  const withExports = (exports: unknown) =>
    fakeVfs({ ...files, [`${APP}/node_modules/pkg/package.json`]: JSON.stringify({ exports }) });

  const all = await resolveBareSpecifier(
    "pkg",
    IMPORTER,
    withExports({ ".": { require: "./require.cjs", browser: "./browser.js", import: "./import.mjs", default: "./default.js" } }),
  );
  expect(vfsPath(all)).toBe(`${APP}/node_modules/pkg/browser.js`);
  expect(all.kind === "vfs" && all.viaRequireCondition).toBe(false);

  const noBrowser = await resolveBareSpecifier(
    "pkg",
    IMPORTER,
    withExports({ ".": { require: "./require.cjs", import: "./import.mjs" } }),
  );
  expect(vfsPath(noBrowser)).toBe(`${APP}/node_modules/pkg/import.mjs`);

  const requireOnly = await resolveBareSpecifier(
    "pkg",
    IMPORTER,
    withExports({ ".": { require: "./require.cjs", node: "./default.js" } }),
  );
  expect(vfsPath(requireOnly)).toBe(`${APP}/node_modules/pkg/require.cjs`);
  expect(requireOnly.kind === "vfs" && requireOnly.viaRequireCondition).toBe(true);
});

test("bare condition object (no '.' key) stands for the root entry", async () => {
  const vfs = fakeVfs({
    [`${APP}/node_modules/pkg/package.json`]: JSON.stringify({ exports: { import: "./esm.js", require: "./cjs.js" } }),
    [`${APP}/node_modules/pkg/esm.js`]: "",
    [`${APP}/node_modules/pkg/cjs.js`]: "",
  });
  expect(vfsPath(await resolveBareSpecifier("pkg", IMPORTER, vfs))).toBe(`${APP}/node_modules/pkg/esm.js`);
});

test("exports subpath keys ('./sub')", async () => {
  const vfs = fakeVfs({
    [`${APP}/node_modules/pkg/package.json`]: JSON.stringify({
      exports: { ".": "./index.js", "./sub": { default: "./lib/sub.js" } },
    }),
    [`${APP}/node_modules/pkg/index.js`]: "",
    [`${APP}/node_modules/pkg/lib/sub.js`]: "",
  });
  expect(vfsPath(await resolveBareSpecifier("pkg/sub", IMPORTER, vfs))).toBe(`${APP}/node_modules/pkg/lib/sub.js`);
});

test("exports wildcard patterns ('./*' and './feature/*'), longest prefix wins", async () => {
  const vfs = fakeVfs({
    [`${APP}/node_modules/pkg/package.json`]: JSON.stringify({
      exports: { "./*": "./dist/*.js", "./feature/*": "./dist/features/*.js" },
    }),
    [`${APP}/node_modules/pkg/dist/util.js`]: "",
    [`${APP}/node_modules/pkg/dist/features/auth.js`]: "",
  });
  expect(vfsPath(await resolveBareSpecifier("pkg/util", IMPORTER, vfs))).toBe(`${APP}/node_modules/pkg/dist/util.js`);
  expect(vfsPath(await resolveBareSpecifier("pkg/feature/auth", IMPORTER, vfs))).toBe(
    `${APP}/node_modules/pkg/dist/features/auth.js`,
  );
});

test("exports present but subpath unmatched -> lenient direct-file fallback", async () => {
  const vfs = fakeVfs({
    [`${APP}/node_modules/pkg/package.json`]: JSON.stringify({ exports: { ".": "./index.js" } }),
    [`${APP}/node_modules/pkg/index.js`]: "",
    [`${APP}/node_modules/pkg/extra/thing.js`]: "",
  });
  expect(vfsPath(await resolveBareSpecifier("pkg/extra/thing", IMPORTER, vfs))).toBe(
    `${APP}/node_modules/pkg/extra/thing.js`,
  );
});

// ---------------------------------------------------------------------------
// resolveBareSpecifier — legacy fields + probing
// ---------------------------------------------------------------------------

test("no exports field: module > browser > main, then index.js", async () => {
  const base = `${APP}/node_modules/pkg`;
  const files = {
    [`${base}/esm.js`]: "",
    [`${base}/browser.js`]: "",
    [`${base}/cjs.js`]: "",
    [`${base}/index.js`]: "",
  };
  const withPkg = (pkg: unknown) => fakeVfs({ ...files, [`${base}/package.json`]: JSON.stringify(pkg) });

  expect(vfsPath(await resolveBareSpecifier("pkg", IMPORTER, withPkg({ module: "esm.js", browser: "browser.js", main: "cjs.js" })))).toBe(`${base}/esm.js`);
  expect(vfsPath(await resolveBareSpecifier("pkg", IMPORTER, withPkg({ browser: "browser.js", main: "cjs.js" })))).toBe(`${base}/browser.js`);
  expect(vfsPath(await resolveBareSpecifier("pkg", IMPORTER, withPkg({ main: "cjs.js" })))).toBe(`${base}/cjs.js`);
  expect(vfsPath(await resolveBareSpecifier("pkg", IMPORTER, withPkg({})))).toBe(`${base}/index.js`);
});

test("main without extension + directory main -> probing and index.js", async () => {
  const base = `${APP}/node_modules/pkg`;
  const noExt = fakeVfs({
    [`${base}/package.json`]: JSON.stringify({ main: "lib/entry" }),
    [`${base}/lib/entry.cjs`]: "",
  });
  expect(vfsPath(await resolveBareSpecifier("pkg", IMPORTER, noExt))).toBe(`${base}/lib/entry.cjs`);

  const dirMain = fakeVfs({
    [`${base}/package.json`]: JSON.stringify({ main: "lib" }),
    [`${base}/lib/index.js`]: "",
  });
  expect(vfsPath(await resolveBareSpecifier("pkg", IMPORTER, dirMain))).toBe(`${base}/lib/index.js`);
});

test("package.json missing entirely -> index.js", async () => {
  const vfs = fakeVfs({ [`${APP}/node_modules/pkg/index.js`]: "" });
  expect(vfsPath(await resolveBareSpecifier("pkg", IMPORTER, vfs))).toBe(`${APP}/node_modules/pkg/index.js`);
});

test("json subpath resolves like a file (pkg/package.json)", async () => {
  const vfs = fakeVfs({
    [`${APP}/node_modules/pkg/package.json`]: JSON.stringify({ main: "index.js" }),
    [`${APP}/node_modules/pkg/index.js`]: "",
  });
  expect(vfsPath(await resolveBareSpecifier("pkg/package.json", IMPORTER, vfs))).toBe(
    `${APP}/node_modules/pkg/package.json`,
  );
});

test("nodeProbe order: exact, .js, .mjs, .cjs, .json, dir index", async () => {
  const vfs = fakeVfs({ "/x/a.mjs": "", "/x/a.cjs": "", "/x/b/index.json": "" });
  expect(await nodeProbe(vfs, "/x/a")).toBe("/x/a.mjs");
  expect(await nodeProbe(vfs, "/x/b")).toBe("/x/b/index.json");
  expect(await nodeProbe(vfs, "/x/missing")).toBeNull();
});

// ---------------------------------------------------------------------------
// resolveRequireSpecifier
// ---------------------------------------------------------------------------

test("require resolution: relative probe, builtins, installed polyfill wins", async () => {
  const vfs = fakeVfs({
    [`${APP}/node_modules/pkg/index.js`]: "",
    [`${APP}/node_modules/pkg/util.cjs`]: "",
    [`${APP}/node_modules/path/package.json`]: JSON.stringify({ main: "polyfill.js" }),
    [`${APP}/node_modules/path/polyfill.js`]: "",
  });
  const importer = `${APP}/node_modules/pkg/index.js`;

  const rel = await resolveRequireSpecifier("./util", importer, vfs);
  expect(rel).toMatchObject({ kind: "vfs", path: `${APP}/node_modules/pkg/util.cjs`, viaRequireCondition: true });

  expect(await resolveRequireSpecifier("node:fs", importer, vfs)).toEqual({ kind: "builtin", name: "fs" });
  expect(await resolveRequireSpecifier("fs/promises", importer, vfs)).toEqual({ kind: "builtin", name: "fs/promises" });
  // "path" is a builtin NAME but an installed polyfill takes precedence.
  expect(vfsPath(await resolveRequireSpecifier("path", importer, vfs) as never)).toBe(
    `${APP}/node_modules/path/polyfill.js`,
  );
  expect((await resolveRequireSpecifier("./nope", importer, vfs)).kind).toBe("not-found");
});

// ---------------------------------------------------------------------------
// CJS detection
// ---------------------------------------------------------------------------

test("isCjsSource: markers vs ESM syntax", () => {
  expect(isCjsSource(`const ms = require("ms");\nmodule.exports = ms;`)).toBe(true);
  expect(isCjsSource(`exports.parse = function () {};`)).toBe(true);
  expect(isCjsSource(`Object.defineProperty(exports, "__esModule", { value: true });`)).toBe(true);
  // static ESM syntax disqualifies
  expect(isCjsSource(`import ms from "ms";\nmodule.exports = ms;`)).toBe(false);
  expect(isCjsSource(`export default 1;`)).toBe(false);
  expect(isCjsSource(`export { a };\nconst a = require("b");`)).toBe(false);
  // dynamic import() is legal in CJS — not an ESM marker
  expect(isCjsSource(`module.exports = () => import("x");`)).toBe(true);
  // no markers at all
  expect(isCjsSource(`console.log("hi");`)).toBe(false);
  // identifiers that merely contain the words
  expect(isCjsSource(`const notrequire = myrequire("x"); a.require("y"); b.module.exports;`)).toBe(false);
});

test("isCjsModule: extension, package type, markers", async () => {
  const vfs = fakeVfs({
    "/p/esm/package.json": JSON.stringify({ type: "module" }),
    "/p/cjs/package.json": JSON.stringify({ name: "x" }),
  });
  const cjsCode = `module.exports = 1;`;
  expect(await isCjsModule("/p/esm/file.cjs", "anything", vfs)).toBe(true); // .cjs always
  expect(await isCjsModule("/p/esm/file.js", cjsCode, vfs)).toBe(false); // type:module
  expect(await isCjsModule("/p/cjs/file.js", cjsCode, vfs)).toBe(true); // no type + markers
  expect(await isCjsModule("/p/cjs/file.js", `export default 1;`, vfs)).toBe(false); // ESM output
  expect(await isCjsModule("/p/cjs/file.ts", cjsCode, vfs)).toBe(false); // TS transpiles to ESM
  expect(await isCjsModule("/nowhere/file.js", cjsCode, vfs)).toBe(true); // no package.json ≙ commonjs
});

test("nearestPackageType: nearest package.json decides, walk stops there", async () => {
  const vfs = fakeVfs({
    "/a/package.json": JSON.stringify({ type: "module" }),
    "/a/node_modules/dep/package.json": JSON.stringify({ name: "dep" }),
    "/a/node_modules/dep/index.js": "",
  });
  expect(await nearestPackageType(vfs, "/a/node_modules/dep/index.js")).toBeNull();
  expect(await nearestPackageType(vfs, "/a/src/x.js")).toBe("module");
});

// ---------------------------------------------------------------------------
// findRequires / detectNamedExports (pure)
// ---------------------------------------------------------------------------

test("findRequires extracts string-literal require() calls only", () => {
  const code = `
    const a = require("ms");
    const b = require('./util');
    const c = obj.require("not-a-require");
    const d = myrequire("nope");
    const e = require(dynamic);
    require ( "spaced" );
  `;
  expect(findRequires(code).map((o) => o.spec)).toEqual(["ms", "./util", "spaced"]);
});

test("detectNamedExports: assignments + defineProperty, filters reserved words", () => {
  const source = `
    exports.parse = () => {};
    module.exports.stringify = () => {};
    Object.defineProperty(exports, "version", { value: "1.0.0" });
    exports.default = {};       // reserved as an export name
    exports.class = {};         // reserved word
    exports.eq === x;           // comparison, not assignment
  `;
  expect(detectNamedExports(source).sort()).toEqual(["parse", "stringify", "version"]);
});

// ---------------------------------------------------------------------------
// CJS facade — pure transform shape
// ---------------------------------------------------------------------------

test("renderCjsFacade: ms-style module (default-only) facade shape", () => {
  const facade = renderCjsFacade({
    path: "/n/ms/index.js",
    source: `module.exports = function ms(v) { return v; };`,
    registryUrl: "blob:registry",
    deps: [],
  });
  expect(facade).toContain(`from "blob:registry"`);
  expect(facade).toContain(`__register("/n/ms/index.js", __module)`);
  expect(facade).toContain(`(function (module, exports, require, __filename, __dirname) {`);
  expect(facade).toContain(`"/n/ms/index.js", "/n/ms");`);
  expect(facade).toContain(`export default __exports;`);
  expect(facade).toContain(`export const __burrowCjs = true;`);
  expect(facade).not.toContain(`await import(`); // no deps -> no dep imports
});

test("renderCjsFacade: registration precedes dep imports (cycle partials)", () => {
  const facade = renderCjsFacade({
    path: "/n/a/index.js",
    source: `const b = require("b"); module.exports = { b };`,
    registryUrl: "blob:registry",
    deps: [{ spec: "b", kind: "module", url: "blob:b", path: "/n/b/index.js" }],
  });
  const registerAt = facade.indexOf(`__register("/n/a/index.js"`);
  const importAt = facade.indexOf(`await import("blob:b")`);
  expect(registerAt).toBeGreaterThan(-1);
  expect(importAt).toBeGreaterThan(registerAt);
});

// ---------------------------------------------------------------------------
// CJS facade — EXECUTED. Facades are written as real temp-file modules (Bun's
// resolver rejects long nested data: URLs); every facade imports the SAME
// registry file, so they share one registry instance like one worker would.
// ---------------------------------------------------------------------------

const EXEC_DIR = `${tmpdir()}/burrow-cjs-exec-${crypto.randomUUID()}`;
let moduleCount = 0;

async function moduleFile(code: string): Promise<string> {
  // One subdirectory per module: Bun caches a directory's listing on first
  // import, so files written into an already-imported-from dir aren't found.
  const path = `${EXEC_DIR}/m${++moduleCount}/index.mjs`;
  await Bun.write(path, code);
  return path;
}

const REGISTRY_URL = await moduleFile(CJS_REGISTRY_SOURCE);

afterAll(async () => {
  await rm(EXEC_DIR, { recursive: true, force: true });
});

test("executed: ms-style module — default export is module.exports", async () => {
  const facade = renderCjsFacade({
    path: "/exec1/ms/index.js",
    source: `module.exports = function ms(v) { return v * 2; };\nmodule.exports.brand = "ms";`,
    registryUrl: REGISTRY_URL,
    deps: [],
  });
  const ns = await import(await moduleFile(facade));
  expect(typeof ns.default).toBe("function");
  expect(ns.default(21)).toBe(42);
  expect(ns.brand).toBe("ms"); // statically detected named re-export
  expect(ns.__burrowCjs).toBe(true);
});

test("executed: named exports module — import { parse } works", async () => {
  const facade = renderCjsFacade({
    path: "/exec2/qs/index.js",
    source: `exports.parse = (s) => s.split("&").length;\nexports.stringify = (n) => "n=" + n;`,
    registryUrl: REGISTRY_URL,
    deps: [],
  });
  const ns = await import(await moduleFile(facade));
  expect(ns.parse("a=1&b=2")).toBe(2);
  expect(ns.stringify(7)).toBe("n=7");
  expect(ns.default.parse("a=1")).toBe(1); // default carries everything too
});

test("executed: 2-module require chain (a requires b through the deps table)", async () => {
  const facadeB = renderCjsFacade({
    path: "/exec3/b.js",
    source: `module.exports = { value: 40, add: (n) => 40 + n };`,
    registryUrl: REGISTRY_URL,
    deps: [],
  });
  const facadeA = renderCjsFacade({
    path: "/exec3/a.js",
    source: `const b = require("./b");\nexports.total = b.add(2);\nexports.viaResolve = require.resolve("./b");`,
    registryUrl: REGISTRY_URL,
    deps: [{ spec: "./b", kind: "module", url: await moduleFile(facadeB), path: "/exec3/b.js" }],
  });
  const ns = await import(await moduleFile(facadeA));
  expect(ns.total).toBe(42);
  expect(ns.viaResolve).toBe("/exec3/b.js");
});

test("executed: require of a plain ESM dep prefers its default export", async () => {
  const esmDep = await moduleFile(`export default (n) => n + 1; export const tag = "esm";`);
  const facade = renderCjsFacade({
    path: "/exec4/user.js",
    source: `const inc = require("esm-dep");\nexports.result = inc(9);`,
    registryUrl: REGISTRY_URL,
    deps: [{ spec: "esm-dep", kind: "external", url: esmDep }],
  });
  const ns = await import(await moduleFile(facade));
  expect(ns.result).toBe(10);
});

test("executed: circular requires get partial-exports semantics", async () => {
  // a (module dep) -> b; b (cycle edge) -> a. b sees a's exports object BEFORE
  // a's body ran (empty, but the LIVE object — Node-style partial exports).
  const facadeB = renderCjsFacade({
    path: "/exec5/b.js",
    source: `const a = require("./a");\nexports.keysAtRequire = Object.keys(a).length;\nexports.aRef = a;\nexports.value = 42;`,
    registryUrl: REGISTRY_URL,
    deps: [{ spec: "./a", kind: "cycle", path: "/exec5/a.js" }],
  });
  const facadeBUrl = await moduleFile(facadeB);
  const facadeA = renderCjsFacade({
    path: "/exec5/a.js",
    source: `exports.name = "a";\nconst b = require("./b");\nexports.bValue = b.value;`,
    registryUrl: REGISTRY_URL,
    deps: [{ spec: "./b", kind: "module", url: facadeBUrl, path: "/exec5/b.js" }],
  });
  const nsA = await import(await moduleFile(facadeA));
  const nsB = await import(facadeBUrl); // same module instance (same URL)
  expect(nsA.default.name).toBe("a");
  expect(nsA.default.bValue).toBe(42);
  expect(nsB.default.keysAtRequire).toBe(0); // partial: a's body had not run yet
  expect(nsB.default.aRef).toBe(nsA.default); // live object identity across the cycle
  expect(nsB.default.aRef.name).toBe("a"); // later fills are visible through it
});

test("executed: missing dep throws MODULE_NOT_FOUND at require() call time", async () => {
  const facade = renderCjsFacade({
    path: "/exec6/opt.js",
    source: `try { require("fsevents"); exports.native = true; } catch (err) { exports.code = err.code; }\nexports.ok = 1;`,
    registryUrl: REGISTRY_URL,
    deps: [{ spec: "fsevents", kind: "missing" }],
  });
  const ns = await import(await moduleFile(facade));
  expect(ns.ok).toBe(1);
  expect(ns.code).toBe("MODULE_NOT_FOUND");
  expect(ns.native).toBeUndefined();
});

// ---------------------------------------------------------------------------
// buildCjsFacade — resolution + host integration over the fake VFS
// ---------------------------------------------------------------------------

test("buildCjsFacade: resolves requires via node_modules, builtins -> shims", async () => {
  const vfs = fakeVfs({
    [`${APP}/node_modules/pkg/package.json`]: JSON.stringify({ main: "index.js" }),
    [`${APP}/node_modules/pkg/index.js`]: "",
    [`${APP}/node_modules/pkg/lib/util.js`]: "",
  });
  const built: string[] = [];
  const source = `const util = require("./lib/util");\nconst path = require("path");\nconst missing = require("not-installed");\nmodule.exports = util;`;
  const result = await buildCjsFacade(`${APP}/node_modules/pkg/index.js`, source, "blob:registry", {
    vfs,
    isCycle: () => false,
    buildChild: async (p) => {
      built.push(p);
      return `blob:child-${p}`;
    },
    esmShFallback: async (spec) => `https://esm.sh/${spec}`,
  });
  expect(result.code).not.toBeNull();
  expect(built).toEqual([`${APP}/node_modules/pkg/lib/util.js`]);
  expect(result.deps["./lib/util"]).toBe(`${APP}/node_modules/pkg/lib/util.js`);
  expect(result.deps["not-installed"]).toBe("https://esm.sh/not-installed");
  expect(result.code).toContain(`await import("blob:child-${APP}/node_modules/pkg/lib/util.js")`);
  // require("path") now resolves to the Node builtin shim (a blob: module),
  // imported like any external dep — NOT a lazy MODULE_NOT_FOUND throw.
  expect(result.deps["path"]).toMatch(/^blob:/);
  expect(result.code).toContain(`__paths["path"] = "${result.deps["path"]}";`);
  expect(result.code).not.toContain(`__deps["path"] = () => __missing("path");`);
  expect(result.code).toContain(`import("https://esm.sh/not-installed").catch(() => undefined);`);
});

test("buildCjsFacade: cycle edges become registry lookups, not child builds", async () => {
  const vfs = fakeVfs({
    [`${APP}/node_modules/pkg/a.js`]: "",
    [`${APP}/node_modules/pkg/b.js`]: "",
  });
  const result = await buildCjsFacade(
    `${APP}/node_modules/pkg/b.js`,
    `const a = require("./a"); module.exports = () => a;`,
    "blob:registry",
    {
      vfs,
      isCycle: (p) => p === `${APP}/node_modules/pkg/a.js`,
      buildChild: async () => {
        throw new Error("must not build a cycle edge");
      },
      esmShFallback: async () => null,
    },
  );
  expect(result.code).not.toBeNull();
  expect(result.code).toContain(`__requirePath("${APP}/node_modules/pkg/a.js", "./a")`);
  expect(result.code).not.toContain("await import(");
});
