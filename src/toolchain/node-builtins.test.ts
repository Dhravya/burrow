/**
 * Tests for the Node builtin shims (src/toolchain/node-builtins.ts).
 *
 * Resolution API is tested directly. Behavior is tested by importing each
 * shim's source as a data: URL module and exercising it — the same source that
 * is minted as a blob: module in the run worker. Modules that clobber globals
 * (process → globalThis.process) are only smoke-imported, never in a way that
 * would disturb the Bun test runner.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  __builtinSourceForTest,
  isNodeBuiltin,
  nodeBuiltinManifest,
  nodeBuiltinName,
  nodeBuiltinSupport,
  nodeBuiltinUrl,
} from "./node-builtins.ts";

const scratchDir = join(tmpdir(), `burrow-node-builtins-${process.pid}`);
const written: string[] = [];
let counter = 0;

/**
 * Import a builtin's source (verbatim, as minted into the run-worker blob) by
 * writing it to a temp .mjs and importing that file — Bun can't import() a
 * data: URL, and blob: URLs need a browser. Each module goes in its OWN temp
 * dir: Bun's dynamic import() only resolves the first file:// URL per directory
 * inside a test file (later ones fail with "from ''"), so a unique dir sidesteps
 * that quirk.
 */
async function loadBuiltin(name: string): Promise<Record<string, unknown>> {
  const source = __builtinSourceForTest(name);
  if (source === null) throw new Error(`no such builtin: ${name}`);
  const file = join(scratchDir, String(counter++), `${name.replace(/[^\w]/g, "_")}.mjs`);
  await Bun.write(file, source);
  written.push(file);
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

afterAll(async () => {
  await Promise.all(written.map((f) => Bun.file(f).delete().catch(() => {})));
});

describe("resolution API", () => {
  test("node: prefix and bare names both resolve", () => {
    for (const spec of ["node:path", "path", "node:fs", "fs", "events", "node:buffer", "buffer"]) {
      expect(isNodeBuiltin(spec)).toBe(true);
    }
  });

  test("non-builtins do not resolve", () => {
    for (const spec of ["react", "hono", "./local", "@scope/pkg", "not-a-builtin"]) {
      expect(isNodeBuiltin(spec)).toBe(false);
      expect(nodeBuiltinName(spec)).toBeNull();
    }
  });

  test("node: prefix is stripped to the canonical name", () => {
    expect(nodeBuiltinName("node:path")).toBe("path");
    expect(nodeBuiltinName("node:fs/promises")).toBe("fs/promises");
    expect(nodeBuiltinName("path")).toBe("path");
  });

  test("support levels are classified", () => {
    expect(nodeBuiltinSupport("path")).toBe("full");
    expect(nodeBuiltinSupport("buffer")).toBe("full");
    expect(nodeBuiltinSupport("http")).toBe("net");
    expect(nodeBuiltinSupport("fs")).toBe("stub");
    expect(nodeBuiltinSupport("child_process")).toBe("stub");
    expect(nodeBuiltinSupport("react")).toBeNull();
  });

  test("builtins commonly pulled in by npm SDKs are fully covered", () => {
    // A specifier set that real-world SDK packages typically require at import time.
    for (const spec of ["node:buffer", "node:child_process", "node:fs", "node:path", "node:url"]) {
      expect(isNodeBuiltin(spec)).toBe(true);
      expect(nodeBuiltinUrl(spec)).toMatch(/^blob:/);
    }
  });

  test("manifest enumerates all modules with a level each", () => {
    const manifest = nodeBuiltinManifest();
    expect(manifest.length).toBeGreaterThan(30);
    for (const { name, support } of manifest) {
      expect(typeof name).toBe("string");
      expect(["full", "net", "stub"]).toContain(support);
    }
  });

  test("nodeBuiltinUrl caches (same URL for repeated calls)", () => {
    expect(nodeBuiltinUrl("path")).toBe(nodeBuiltinUrl("node:path"));
  });
});

describe("path", () => {
  test("join / basename / dirname / extname / normalize", async () => {
    const path = await loadBuiltin("path");
    expect((path.join as Function)("/a", "b", "c.ts")).toBe("/a/b/c.ts");
    expect((path.join as Function)("a", "..", "b")).toBe("b");
    expect((path.basename as Function)("/a/b/c.ts")).toBe("c.ts");
    expect((path.basename as Function)("/a/b/c.ts", ".ts")).toBe("c");
    expect((path.dirname as Function)("/a/b/c.ts")).toBe("/a/b");
    expect((path.extname as Function)("/a/b/c.test.ts")).toBe(".ts");
    expect((path.normalize as Function)("/a/./b/../c")).toBe("/a/c");
    expect((path.isAbsolute as Function)("/x")).toBe(true);
    expect((path.isAbsolute as Function)("x")).toBe(false);
    expect((path.relative as Function)("/a/b/c", "/a/b/d")).toBe("../d");
    expect((path.default as { sep: string }).sep).toBe("/");
  });

  test("parse / format round-trip", async () => {
    const path = await loadBuiltin("path");
    const parsed = (path.parse as Function)("/a/b/c.ts");
    expect(parsed).toMatchObject({ base: "c.ts", ext: ".ts", name: "c", dir: "/a/b" });
    expect((path.format as Function)(parsed)).toBe("/a/b/c.ts");
  });
});

describe("events", () => {
  test("EventEmitter on/emit/once/off", async () => {
    const mod = await loadBuiltin("events");
    const EventEmitter = mod.default as new () => {
      on: Function; once: Function; off: Function; emit: Function; listenerCount: Function;
    };
    const ee = new EventEmitter();
    let count = 0;
    const fn = (n: number) => (count += n);
    ee.on("x", fn);
    ee.emit("x", 5);
    expect(count).toBe(5);
    let onceCount = 0;
    ee.once("y", () => (onceCount += 1));
    ee.emit("y");
    ee.emit("y");
    expect(onceCount).toBe(1);
    ee.off("x", fn);
    ee.emit("x", 10);
    expect(count).toBe(5);
    expect(ee.listenerCount("x")).toBe(0);
  });
});

describe("buffer", () => {
  test("from/toString round-trips across encodings", async () => {
    const mod = await loadBuiltin("buffer");
    const Buffer = mod.Buffer as {
      from: Function; alloc: Function; concat: Function; isBuffer: Function; byteLength: Function;
    };
    expect((Buffer.from("hello") as { toString: Function }).toString("hex")).toBe("68656c6c6f");
    expect((Buffer.from("68656c6c6f", "hex") as { toString: Function }).toString()).toBe("hello");
    const b64 = (Buffer.from("hello world") as { toString: Function }).toString("base64");
    expect(b64).toBe("aGVsbG8gd29ybGQ=");
    expect((Buffer.from(b64, "base64") as { toString: Function }).toString()).toBe("hello world");
    expect(Buffer.byteLength("héllo")).toBe(6); // é is 2 bytes in utf8
    expect(Buffer.isBuffer(Buffer.from("x"))).toBe(true);
    const joined = Buffer.concat([Buffer.from("ab"), Buffer.from("cd")]) as { toString: Function };
    expect(joined.toString()).toBe("abcd");
  });
});

describe("crypto", () => {
  test("createHash sha256 matches the known 'abc' vector", async () => {
    const crypto = await loadBuiltin("crypto");
    const hash = (crypto.createHash as Function)("sha256");
    hash.update("abc");
    // Canonical SHA-256("abc").
    expect(hash.digest("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("createHash sha1 matches the known 'abc' vector", async () => {
    const crypto = await loadBuiltin("crypto");
    const hash = (crypto.createHash as Function)("sha1");
    hash.update("abc");
    expect(hash.digest("hex")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  test("randomUUID and randomBytes work", async () => {
    const crypto = await loadBuiltin("crypto");
    expect((crypto.randomUUID as Function)()).toMatch(/^[0-9a-f-]{36}$/);
    expect(((crypto.randomBytes as Function)(16) as Uint8Array).length).toBe(16);
  });
});

describe("url", () => {
  test("fileURLToPath / pathToFileURL / parse", async () => {
    const url = await loadBuiltin("url");
    expect((url.fileURLToPath as Function)("file:///a/b.ts")).toBe("/a/b.ts");
    expect((url.pathToFileURL as Function)("/a/b.ts").href).toBe("file:///a/b.ts");
    const parsed = (url.parse as Function)("https://x.com/p?q=1", true);
    expect(parsed).toMatchObject({ hostname: "x.com", pathname: "/p" });
    expect(parsed.query).toMatchObject({ q: "1" });
  });
});

describe("querystring", () => {
  test("parse / stringify", async () => {
    const qs = await loadBuiltin("querystring");
    expect((qs.parse as Function)("a=1&b=2")).toMatchObject({ a: "1", b: "2" });
    expect((qs.stringify as Function)({ a: "1", b: "2" })).toBe("a=1&b=2");
  });
});

describe("assert", () => {
  test("ok / equal / throws", async () => {
    const mod = await loadBuiltin("assert");
    const assert = mod.default as Function & { equal: Function; throws: Function; strictEqual: Function };
    expect(() => assert(true)).not.toThrow();
    expect(() => assert(false)).toThrow();
    expect(() => assert.equal(1, "1")).not.toThrow();
    expect(() => assert.strictEqual(1, 2)).toThrow();
    expect(() => assert.throws(() => { throw new Error("x"); })).not.toThrow();
  });
});

describe("stream", () => {
  test("Readable.from + async iteration", async () => {
    const mod = await loadBuiltin("stream");
    const Readable = mod.Readable as { from: Function };
    const r = Readable.from(["a", "b", "c"]);
    const out: string[] = [];
    for await (const chunk of r as AsyncIterable<string>) out.push(chunk);
    expect(out).toEqual(["a", "b", "c"]);
  });

  test("PassThrough write→data", async () => {
    const mod = await loadBuiltin("stream");
    const PassThrough = mod.PassThrough as new () => { on: Function; write: Function; end: Function };
    const pt = new PassThrough();
    const seen: string[] = [];
    pt.on("data", (c: string) => seen.push(String(c)));
    pt.write("hi");
    pt.end();
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.join("")).toBe("hi");
  });
});

describe("capability stubs", () => {
  test("fs sync fns throw the actionable message; import itself succeeds", async () => {
    const fs = await loadBuiltin("fs");
    expect(typeof fs.readFileSync).toBe("function");
    expect(() => (fs.readFileSync as Function)("/x")).toThrow(/not yet wired to the workspace VFS/);
    expect(() => (fs.existsSync as Function)("/x")).toThrow(/SharedArrayBuffer bridge/);
  });

  test("child_process functions throw the sandbox message", async () => {
    const cp = await loadBuiltin("child_process");
    expect(() => (cp.execSync as Function)("ls")).toThrow(/not available in the native browser sandbox/);
    expect(() => (cp.spawn as Function)("ls")).toThrow(/Linux VM tab/);
  });

  test("net sockets throw pointing at fetch/WebSocket", async () => {
    const net = await loadBuiltin("net");
    expect(() => (net.connect as Function)(80)).toThrow(/fetch\(\)\/WebSocket/);
  });
});
