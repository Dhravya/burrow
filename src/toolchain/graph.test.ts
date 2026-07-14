/**
 * Burrow src/toolchain — build-pipeline tests.
 *
 * Covers the three layers `bun run` is made of, headless under `bun test`:
 *   - wasm.ts: the real bun.wasm transform ABI (TS/TSX in, ESM out, caret
 *     diagnostics on syntax errors),
 *   - specifiers.ts: import-specifier extraction + textual rewriting,
 *   - graph.ts: buildGraphWith over a fake VFS — probing, JSON modules,
 *     esm.sh pinning, runtime/builtin shims, cycles, and error paths. Built
 *     graphs are EXECUTED via import(blob:) (Bun supports blob module URLs).
 *   - commands.ts: the non-running surfaces of `bun` / `serve` (usage,
 *     version, error messages) — anything that would spawn a worker is
 *     covered by run-session.test.ts instead.
 */

import { describe, expect, test } from "bun:test";
import type { BurrowVfs, CommandContext } from "../contract/types.ts";
import { createToolchainCommands } from "./commands.ts";
import { buildGraphWith, getRuntimeShimUrl, probeFile } from "./graph.ts";
import { joinPath, loaderForPath, normalizePath } from "./paths.ts";
import { findSpecifiers, rewriteSpecifiers } from "./specifiers.ts";
import { transpileSource } from "./wasm.ts";

// ---------------------------------------------------------------------------
// Fake VFS (readFile/stat/exists/resolvePath are all graph.ts + commands.ts use)
// ---------------------------------------------------------------------------

function fakeVfs(files: Record<string, string>): BurrowVfs {
  const dirSet = new Set<string>(["/"]);
  for (const path of Object.keys(files)) {
    let dir = path;
    for (;;) {
      const parent = path === "/" ? "/" : dir.slice(0, dir.lastIndexOf("/")) || "/";
      if (parent === dir || dirSet.has(parent)) break;
      dirSet.add(parent);
      dir = parent;
    }
  }
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const partial = {
    async readFile(path: string): Promise<string> {
      const content = files[path];
      if (content === undefined) throw enoent(path);
      return content;
    },
    async stat(path: string) {
      if (files[path] !== undefined) return { isFile: true, isDirectory: false, size: files[path]!.length };
      if (dirSet.has(path)) return { isFile: false, isDirectory: true, size: 0 };
      throw enoent(path);
    },
    async exists(path: string): Promise<boolean> {
      return files[path] !== undefined || dirSet.has(path);
    },
    resolvePath(cwd: string, path: string): string {
      return path.startsWith("/") ? normalizePath(path) : joinPath(cwd, path);
    },
  };
  return partial as unknown as BurrowVfs;
}

const APP = "/home/user/app";

// ---------------------------------------------------------------------------
// wasm.ts — transform ABI against the real bun.wasm
// ---------------------------------------------------------------------------

describe("wasm transform ABI", () => {
  test("TypeScript in, plain ESM out", async () => {
    const result = await transpileSource(
      `export function double(n: number): number {\n  return n * 2;\n}\nconst tag: string = "x";\nexport { tag };\n`,
      loaderForPath("mod.ts"),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.code).toContain("export function double(n)");
    expect(result.code).not.toContain(": number");
    expect(result.code).not.toContain(": string");
  });

  test("TSX compiles (JSX survives as calls, types are gone)", async () => {
    const result = await transpileSource(`export const el = <div className="a">{1 as number}</div>;\n`, loaderForPath("mod.tsx"));
    if (!result.ok) throw new Error(result.error);
    expect(result.code).toContain("div");
    expect(result.code).not.toContain(" as number");
  });

  test("syntax errors produce diagnostics, not a throw", async () => {
    const result = await transpileSource("const = ;\n", loaderForPath("mod.ts"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  test("repeated transforms reuse the singleton and stay consistent", async () => {
    for (let i = 0; i < 3; i++) {
      const result = await transpileSource(`export const n${i}: number = ${i};\n`, loaderForPath("mod.ts"));
      if (!result.ok) throw new Error(result.error);
      expect(result.code).toContain(`n${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// specifiers.ts — extraction + rewriting
// ---------------------------------------------------------------------------

describe("specifiers", () => {
  test("finds static imports, re-exports, and dynamic imports", () => {
    const code = [
      `import { a } from "./a.ts";`,
      `import "./side-effect.ts";`,
      `export * from './b.ts';`,
      `const later = import("./c.ts");`,
      `const notAnImport = thing.import("./nope.ts");`,
      `const alsoNot = import(someVariable);`,
    ].join("\n");
    const specs = findSpecifiers(code).map((o) => o.spec);
    expect(specs).toEqual(["./a.ts", "./side-effect.ts", "./b.ts", "./c.ts"]);
  });

  test("rewrites only mapped specifiers, preserving surrounding code", () => {
    const code = `import { a } from "./a.ts";\nimport { b } from "./b.ts";\n`;
    const occurrences = findSpecifiers(code);
    const out = rewriteSpecifiers(code, occurrences, new Map([["./a.ts", "blob:fake/a"]]));
    expect(out).toContain(`from "blob:fake/a"`);
    expect(out).toContain(`from "./b.ts"`);
  });
});

// ---------------------------------------------------------------------------
// graph.ts — buildGraphWith over the fake VFS
// ---------------------------------------------------------------------------

describe("buildGraph", () => {
  test("probeFile tries extensions and index files", async () => {
    const vfs = fakeVfs({
      [`${APP}/util.ts`]: "export {};",
      [`${APP}/lib/index.tsx`]: "export {};",
    });
    expect(await probeFile(vfs, `${APP}/util`)).toBe(`${APP}/util.ts`);
    expect(await probeFile(vfs, `${APP}/lib`)).toBe(`${APP}/lib/index.tsx`);
    expect(await probeFile(vfs, `${APP}/missing`)).toBeNull();
  });

  test("builds and EXECUTES a two-module TS graph (extension probing + rewrite)", async () => {
    const vfs = fakeVfs({
      [`${APP}/index.ts`]: `import { double } from "./util";\nexport const result: number = double(21);\n`,
      [`${APP}/util.ts`]: `export function double(n: number): number {\n  return n * 2;\n}\n`,
    });
    const built = await buildGraphWith(vfs, `${APP}/index.ts`);
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    expect(built.modules.map((m) => m.path).sort()).toEqual([`${APP}/index.ts`, `${APP}/util.ts`]);
    const entry = built.modules.find((m) => m.path === `${APP}/index.ts`)!;
    expect(entry.deps["./util"]).toBe(`${APP}/util.ts`);

    const ns = (await import(built.entryBlobUrl)) as { result: number };
    expect(ns.result).toBe(42);
  });

  test("JSON files become default-export modules", async () => {
    const vfs = fakeVfs({
      [`${APP}/index.ts`]: `import data from "./data.json";\nexport const n = data.n;\n`,
      [`${APP}/data.json`]: `{ "n": 7 }`,
    });
    const built = await buildGraphWith(vfs, `${APP}/index.ts`);
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    const ns = (await import(built.entryBlobUrl)) as { n: number };
    expect(ns.n).toBe(7);
  });

  test("invalid JSON is a build error", async () => {
    const vfs = fakeVfs({
      [`${APP}/index.ts`]: `import data from "./data.json";\nexport default data;\n`,
      [`${APP}/data.json`]: `{ not json`,
    });
    const built = await buildGraphWith(vfs, `${APP}/index.ts`);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.errors[0]!.message).toContain("invalid JSON");
  });

  test("bare specifiers pin to esm.sh using the nearest package.json version", async () => {
    const vfs = fakeVfs({
      [`${APP}/package.json`]: JSON.stringify({ dependencies: { nanoid: "^5.1.5" } }),
      [`${APP}/index.ts`]: `import { nanoid } from "nanoid";\nexport const id = nanoid;\n`,
    });
    const built = await buildGraphWith(vfs, `${APP}/index.ts`);
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    const entry = built.modules.find((m) => m.path === `${APP}/index.ts`)!;
    expect(entry.deps["nanoid"]).toBe(`https://esm.sh/nanoid@${encodeURIComponent("^5.1.5")}`);
  });

  test("undeclared bare specifiers fall through to unpinned esm.sh", async () => {
    const vfs = fakeVfs({
      [`${APP}/index.ts`]: `import { Hono } from "hono";\nexport const h = Hono;\n`,
    });
    const built = await buildGraphWith(vfs, `${APP}/index.ts`);
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    const entry = built.modules.find((m) => m.path === `${APP}/index.ts`)!;
    expect(entry.deps["hono"]).toBe("https://esm.sh/hono");
  });

  test("`bun` resolves to the runtime shim blob (serve exists, host-only)", async () => {
    const vfs = fakeVfs({
      [`${APP}/index.ts`]: `import { serve } from "bun";\nexport const kind = typeof serve;\n`,
    });
    const built = await buildGraphWith(vfs, `${APP}/index.ts`);
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    const entry = built.modules.find((m) => m.path === `${APP}/index.ts`)!;
    expect(entry.deps["bun"]).toBe(getRuntimeShimUrl());

    const ns = (await import(built.entryBlobUrl)) as { kind: string };
    expect(ns.kind).toBe("function");
  });

  test("node builtins resolve to shim blobs and execute", async () => {
    const vfs = fakeVfs({
      [`${APP}/index.ts`]: `import { join } from "node:path";\nexport const p = join("/a", "b");\n`,
    });
    const built = await buildGraphWith(vfs, `${APP}/index.ts`);
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    const entry = built.modules.find((m) => m.path === `${APP}/index.ts`)!;
    expect(entry.deps["node:path"]).toMatch(/^blob:/);

    const ns = (await import(built.entryBlobUrl)) as { p: string };
    expect(ns.p).toBe("/a/b");
  });

  test("unknown node: builtins fail the build", async () => {
    const vfs = fakeVfs({
      [`${APP}/index.ts`]: `import "node:definitely-not-real";\n`,
    });
    const built = await buildGraphWith(vfs, `${APP}/index.ts`);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.errors[0]!.message).toContain("unknown Node builtin");
  });

  test("import cycles are a build error", async () => {
    const vfs = fakeVfs({
      [`${APP}/a.ts`]: `import { b } from "./b.ts";\nexport const a = 1;\n`,
      [`${APP}/b.ts`]: `import { a } from "./a.ts";\nexport const b = 2;\n`,
    });
    const built = await buildGraphWith(vfs, `${APP}/a.ts`);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.errors.some((e) => e.message.includes("import cycles are unsupported"))).toBe(true);
  });

  test("unresolvable relative imports report what was probed", async () => {
    const vfs = fakeVfs({
      [`${APP}/index.ts`]: `import { x } from "./nope";\nexport const y = x;\n`,
    });
    const built = await buildGraphWith(vfs, `${APP}/index.ts`);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.errors[0]!.message).toContain(`cannot resolve "./nope"`);
      expect(built.errors[0]!.message).toContain(`${APP}/nope`);
    }
  });

  test("a missing entry is reported without throwing", async () => {
    const built = await buildGraphWith(fakeVfs({}), `${APP}/missing.ts`);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.errors[0]!.message).toBe("entry not found");
  });

  test("transpile errors carry the failing path", async () => {
    const vfs = fakeVfs({
      [`${APP}/broken.ts`]: "const = ;\n",
    });
    const built = await buildGraphWith(vfs, `${APP}/broken.ts`);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.errors[0]!.path).toBe(`${APP}/broken.ts`);
  });
});

// ---------------------------------------------------------------------------
// commands.ts — non-running surfaces of `bun` / `serve`
// ---------------------------------------------------------------------------

function makeCtx(files: Record<string, string>): CommandContext {
  return { fs: fakeVfs(files), cwd: APP, env: new Map(), stdin: "" };
}

function getCommand(name: string) {
  const spec = createToolchainCommands().find((c) => c.name === name);
  if (!spec) throw new Error(`command ${name} not registered`);
  return spec;
}

describe("bun/serve commands", () => {
  test("registers exactly bun and serve", () => {
    expect(createToolchainCommands().map((c) => c.name).sort()).toEqual(["bun", "serve"]);
  });

  test("bun --help prints the Burrow usage banner", async () => {
    const result = await getCommand("bun").execute(["--help"], makeCtx({}));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Burrow");
    expect(result.stdout).toContain("bun run");
  });

  test("bun --version reports the wasm build", async () => {
    const result = await getCommand("bun").execute(["--version"], makeCtx({}));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("burrow");
    expect(result.stdout).toContain("1.0.0-wasm");
  });

  test("bun run without an entry is usage error 129", async () => {
    const result = await getCommand("bun").execute(["run"], makeCtx({}));
    expect(result.exitCode).toBe(129);
    expect(result.stderr).toContain("no entrypoint");
  });

  test("bun run on a missing file fails before starting a session", async () => {
    const result = await getCommand("bun").execute(["run", "missing.ts"], makeCtx({}));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("module not found: missing.ts");
  });

  test("npm subcommands reaching the toolchain report the degraded boot", async () => {
    const result = await getCommand("bun").execute(["install"], makeCtx({}));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("package-manager module");
  });

  test("unsupported subcommands name what IS available", async () => {
    const result = await getCommand("bun").execute(["test"], makeCtx({}));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not available in Burrow");
    expect(result.stderr).toContain("bun install");
  });

  test("serve with no entry candidates explains what it looked for", async () => {
    const result = await getCommand("serve").execute([], makeCtx({}));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no entry found");
  });

  test("serve on a missing explicit entry fails cleanly", async () => {
    const result = await getCommand("serve").execute(["gone.ts"], makeCtx({}));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("module not found: gone.ts");
  });
});
