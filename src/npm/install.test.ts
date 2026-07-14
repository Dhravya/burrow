/**
 * burrow — src/npm/install.test.ts (installer agent)
 * executeInstallPlan against an in-memory VFS (just-bash InMemoryFs — the
 * same store the real WatchedFs wraps, so the promise surface is identical)
 * with a fake fetch serving synthetic gzipped tarballs. Covers the hoisted
 * layout, nested version conflicts, progress phases, and the report shape.
 */

import { describe, expect, test } from "bun:test";
import { InMemoryFs } from "just-bash/browser";
import type { BurrowVfs } from "../contract/types.ts";
import type { InstallPlan, InstallProgress, ResolvedPackage } from "./types.ts";
import { executeInstallPlan, planLayout, type InstallEnv } from "./install.ts";

// --------------------------------------------------------------------------
// Synthetic .tgz builder (mini ustar writer + Bun.gzipSync)
// --------------------------------------------------------------------------

const enc = new TextEncoder();

function tarHeader(name: string, size: number, typeflag: string, mode: number): Uint8Array {
  const block = new Uint8Array(512);
  const put = (text: string, offset: number, length: number): void => {
    block.set(enc.encode(text).subarray(0, length), offset);
  };
  const octal = (value: number, len: number): string => `${value.toString(8).padStart(len - 1, "0")}\0`;
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  block.fill(0x20, 148, 156);
  block[156] = typeflag.charCodeAt(0);
  put("ustar", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

/** Build a gzipped npm-style tarball: files keyed by path INSIDE package/. */
function makeTgz(files: Record<string, string>, modes: Record<string, number> = {}): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = enc.encode(content);
    blocks.push(tarHeader(`package/${path}`, data.byteLength, "0", modes[path] ?? 0o644));
    if (data.byteLength > 0) {
      const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
      padded.set(data);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(512), new Uint8Array(512));
  const total = blocks.reduce((n, b) => n + b.byteLength, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.byteLength;
  }
  return Bun.gzipSync(tar);
}

function manifest(name: string, version: string): string {
  return JSON.stringify({ name, version });
}

// --------------------------------------------------------------------------
// Fixtures: alpha@1 depends on beta@1; beta@2 is a direct dep → beta@2 hoists,
// beta@1 nests under alpha. Plan is deduped + parents-first.
// --------------------------------------------------------------------------

const REG = "https://registry.test";

function fixturePlan(): { plan: InstallPlan; tarballs: Map<string, Uint8Array> } {
  const packages: ResolvedPackage[] = [
    {
      name: "beta",
      version: "2.0.0",
      tarballUrl: `${REG}/beta/-/beta-2.0.0.tgz`,
      dependencies: {},
    },
    {
      name: "alpha",
      version: "1.0.0",
      tarballUrl: `${REG}/alpha/-/alpha-1.0.0.tgz`,
      dependencies: { beta: "1.0.0" },
    },
    {
      name: "beta",
      version: "1.0.0",
      tarballUrl: `${REG}/beta/-/beta-1.0.0.tgz`,
      dependencies: {},
    },
  ];
  const tarballs = new Map<string, Uint8Array>([
    [
      `${REG}/beta/-/beta-2.0.0.tgz`,
      makeTgz({ "package.json": manifest("beta", "2.0.0"), "index.js": "export const v = 2;" }),
    ],
    [
      `${REG}/alpha/-/alpha-1.0.0.tgz`,
      makeTgz(
        {
          "package.json": manifest("alpha", "1.0.0"),
          "index.js": 'export { v } from "beta";',
          "bin/cli.js": "#!/usr/bin/env node\n",
        },
        { "bin/cli.js": 0o755 },
      ),
    ],
    [
      `${REG}/beta/-/beta-1.0.0.tgz`,
      makeTgz({ "package.json": manifest("beta", "1.0.0"), "index.js": "export const v = 1;" }),
    ],
  ]);
  return { plan: { packages, requested: { alpha: "^1.0.0", beta: "^2.0.0" } }, tarballs };
}

/** Bun.gunzipSync with the Uint8Array<ArrayBufferLike> → <ArrayBuffer> squint tsc demands. */
const gunzip = (data: Uint8Array): Uint8Array => Bun.gunzipSync(data as Uint8Array<ArrayBuffer>);

function fakeEnv(tarballs: Map<string, Uint8Array>): InstallEnv {
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = tarballs.get(url);
    if (body === undefined) return new Response("not found", { status: 404, statusText: "Not Found" });
    return new Response(body.slice() as unknown as BodyInit);
  }) as typeof fetch;
  return { fetchImpl, gunzip };
}

function makeVfs(): BurrowVfs {
  // InMemoryFs is the exact store WatchedFs decorates (src/vfs) — the same
  // promise surface, minus events, which install.ts never relies on.
  return new InMemoryFs() as unknown as BurrowVfs;
}

const ROOT = "/home/user/proj";

// --------------------------------------------------------------------------
// planLayout (pure hoisting decisions)
// --------------------------------------------------------------------------

describe("planLayout", () => {
  test("first name wins top level; conflict nests under its dependent", () => {
    const { plan } = fixturePlan();
    const layout = planLayout(plan, ROOT);
    expect(layout.placements.map((p) => [`${p.pkg.name}@${p.pkg.version}`, ...p.dirs])).toEqual([
      ["beta@2.0.0", `${ROOT}/node_modules/beta`],
      ["alpha@1.0.0", `${ROOT}/node_modules/alpha`],
      ["beta@1.0.0", `${ROOT}/node_modules/alpha/node_modules/beta`],
    ]);
    expect(layout.warnings.join("\n")).toContain("hoist conflict");
    expect(layout.warnings.join("\n")).toContain("beta@1.0.0");
  });

  test("conflicting version with no dependent is skipped with a warning", () => {
    const plan: InstallPlan = {
      requested: { solo: "1.0.0" },
      packages: [
        { name: "solo", version: "1.0.0", tarballUrl: `${REG}/solo-1.tgz`, dependencies: {} },
        { name: "solo", version: "2.0.0", tarballUrl: `${REG}/solo-2.tgz`, dependencies: {} },
      ],
    };
    const layout = planLayout(plan, ROOT);
    expect(layout.placements).toHaveLength(1);
    expect(layout.warnings.join("\n")).toContain("no dependent");
  });

  test("range-valued dependencies still find the dependent (loose fallback)", () => {
    const plan: InstallPlan = {
      requested: { a: "^1.0.0", b: "^2.0.0" },
      packages: [
        { name: "b", version: "2.0.0", tarballUrl: `${REG}/b-2.tgz`, dependencies: {} },
        { name: "a", version: "1.0.0", tarballUrl: `${REG}/a-1.tgz`, dependencies: { b: "^1.0.0" } },
        { name: "b", version: "1.5.0", tarballUrl: `${REG}/b-1.5.tgz`, dependencies: {} },
      ],
    };
    const layout = planLayout(plan, ROOT);
    const nested = layout.placements.find((p) => p.pkg.version === "1.5.0");
    expect(nested?.dirs).toEqual([`${ROOT}/node_modules/a/node_modules/b`]);
  });
});

// --------------------------------------------------------------------------
// executeInstallPlan (full pipeline over the fake registry)
// --------------------------------------------------------------------------

describe("executeInstallPlan", () => {
  test("hoisted + nested layout lands in the VFS with the right manifests", async () => {
    const { plan, tarballs } = fixturePlan();
    const vfs = makeVfs();

    const report = await executeInstallPlan(plan, ROOT, vfs, undefined, fakeEnv(tarballs));

    const readManifest = async (path: string): Promise<{ name: string; version: string }> =>
      JSON.parse(await vfs.readFile(path)) as { name: string; version: string };

    expect(await readManifest(`${ROOT}/node_modules/beta/package.json`)).toEqual({ name: "beta", version: "2.0.0" });
    expect(await readManifest(`${ROOT}/node_modules/alpha/package.json`)).toEqual({ name: "alpha", version: "1.0.0" });
    expect(await readManifest(`${ROOT}/node_modules/alpha/node_modules/beta/package.json`)).toEqual({
      name: "beta",
      version: "1.0.0",
    });
    expect(await vfs.readFile(`${ROOT}/node_modules/alpha/node_modules/beta/index.js`)).toBe("export const v = 1;");
    expect(await vfs.readFile(`${ROOT}/node_modules/beta/index.js`)).toBe("export const v = 2;");

    expect(report.installed).toEqual([
      { name: "beta", version: "2.0.0" },
      { name: "alpha", version: "1.0.0" },
      { name: "beta", version: "1.0.0" },
    ]);
    expect(report.bytes).toBeGreaterThan(0);
    expect(report.ms).toBeGreaterThanOrEqual(0);
    expect(report.warnings.join("\n")).toContain("hoist conflict");
  });

  test("executable tarball entries get their exec bit via chmod", async () => {
    const { plan, tarballs } = fixturePlan();
    const vfs = makeVfs();
    await executeInstallPlan(plan, ROOT, vfs, undefined, fakeEnv(tarballs));
    const stat = await vfs.stat(`${ROOT}/node_modules/alpha/bin/cli.js`);
    expect(stat.mode & 0o111).not.toBe(0);
  });

  test("progress covers download/extract/link with sane counters", async () => {
    const { plan, tarballs } = fixturePlan();
    const vfs = makeVfs();
    const events: InstallProgress[] = [];

    await executeInstallPlan(plan, ROOT, vfs, (p) => events.push({ ...p }), fakeEnv(tarballs));

    const phases = new Set(events.map((e) => e.phase));
    expect(phases.has("download")).toBe(true);
    expect(phases.has("extract")).toBe(true);
    expect(phases.has("link")).toBe(true);
    for (const e of events) {
      expect(e.done).toBeGreaterThanOrEqual(0);
      expect(e.done).toBeLessThanOrEqual(e.total);
    }
    const lastLink = events.filter((e) => e.phase === "link").at(-1);
    expect(lastLink).toEqual({ phase: "link", detail: expect.any(String), done: 3, total: 3 });
    const lastDownload = events.filter((e) => e.phase === "download").at(-1);
    expect(lastDownload?.done).toBe(3);
    expect(lastDownload?.total).toBe(3);
  });

  test("a 404 tarball rejects the install with a descriptive error", async () => {
    const { plan } = fixturePlan();
    const vfs = makeVfs();
    await expect(executeInstallPlan(plan, ROOT, vfs, undefined, fakeEnv(new Map()))).rejects.toThrow(/404/);
  });

  test("a matching sha512 integrity string passes verification", async () => {
    const { plan, tarballs } = fixturePlan();
    for (const pkg of plan.packages) {
      const tgz = tarballs.get(pkg.tarballUrl);
      if (tgz === undefined) throw new Error(`fixture missing tarball for ${pkg.tarballUrl}`);
      pkg.integrity = `sha512-${new Bun.CryptoHasher("sha512").update(tgz).digest("base64")}`;
    }
    const vfs = makeVfs();
    const report = await executeInstallPlan(plan, ROOT, vfs, undefined, fakeEnv(tarballs));
    expect(report.installed).toHaveLength(3);
    expect(report.warnings.join("\n")).not.toContain("integrity");
  });

  test("a mismatched integrity string rejects the install", async () => {
    const { plan, tarballs } = fixturePlan();
    const first = plan.packages[0];
    if (first === undefined) throw new Error("fixture plan is empty");
    first.integrity = `sha512-${new Bun.CryptoHasher("sha512").update("tampered bytes").digest("base64")}`;
    const vfs = makeVfs();
    await expect(executeInstallPlan(plan, ROOT, vfs, undefined, fakeEnv(tarballs))).rejects.toThrow(
      /integrity checksum failed for beta@2\.0\.0/,
    );
  });

  test("an unsupported integrity algorithm warns instead of failing", async () => {
    const { plan, tarballs } = fixturePlan();
    const first = plan.packages[0];
    if (first === undefined) throw new Error("fixture plan is empty");
    first.integrity = "md5-notarealdigest==";
    const vfs = makeVfs();
    const report = await executeInstallPlan(plan, ROOT, vfs, undefined, fakeEnv(tarballs));
    expect(report.installed).toHaveLength(3);
    expect(report.warnings.join("\n")).toContain("unsupported hash algorithm");
  });

  test("concurrency: at most 4 tarball fetches in flight", async () => {
    const packages: ResolvedPackage[] = Array.from({ length: 9 }, (_, i) => ({
      name: `pkg${i}`,
      version: "1.0.0",
      tarballUrl: `${REG}/pkg${i}.tgz`,
      dependencies: {},
    }));
    const tgz = makeTgz({ "package.json": manifest("p", "1.0.0") });
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response(tgz.slice() as unknown as BodyInit);
    }) as unknown as typeof fetch;

    const vfs = makeVfs();
    const report = await executeInstallPlan({ packages, requested: {} }, ROOT, vfs, undefined, { fetchImpl, gunzip });

    expect(report.installed).toHaveLength(9);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
