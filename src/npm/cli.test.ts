/**
 * burrow — src/npm/cli.test.ts (COMMAND+LOCKFILE agent)
 *
 * Covers this agent's slice:
 *   - burrow-lock.json round-trip (+ integrity carried through, corruption
 *     tolerance, stable serialization),
 *   - add-spec parsing (@scope/name@^1, name, name@1.2.3, name@latest),
 *   - package.json mutation preserving key order + formatting,
 *   - lock-aware resolution: fully-locked installs fetch ZERO packuments,
 *     stale pins release exactly the stale name to the network,
 *   - the extended `bun` command end-to-end (install / add / remove) over an
 *     InMemoryFs with fixture packuments + synthetic tarballs.
 */

import { describe, expect, test } from "bun:test";
import { InMemoryFs } from "just-bash/browser";
import type { BurrowVfs, CommandContext } from "../contract/types.ts";
import {
  addDependencyToPackageJson,
  collectResolutions,
  createNpmCommands,
  createNpmInstaller,
  parseAddSpec,
  removeDependencyFromPackageJson,
  resolveLockAware,
} from "./cli.ts";
import type { InstallEnv } from "./install.ts";
import {
  LOCKFILE_NAME,
  emptyLockfile,
  lockFromResolutions,
  pinnedResolution,
  readLockfile,
  removeFromLock,
  splitLockKey,
  writeLockfile,
  type Lockfile,
} from "./lockfile.ts";
import type { Packument, PackumentSource } from "./types.ts";

// --------------------------------------------------------------------------
// Fixtures: tiny ustar+gzip tarballs, fixture packuments, counting source
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

function makeTgz(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = enc.encode(content);
    blocks.push(tarHeader(`package/${path}`, data.byteLength, "0", 0o644));
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

const REG = "https://registry.test";

function tarballUrl(name: string, version: string): string {
  const base = name.startsWith("@") ? name.split("/")[1] : name;
  return `${REG}/${name}/-/${base}-${version}.tgz`;
}

interface FixtureVersion {
  deps?: Record<string, string>;
}

/** The exact tarball bytes fixtureRegistry serves for name@version (deterministic). */
function fixtureTgz(name: string, version: string): Uint8Array {
  return makeTgz({
    "package.json": JSON.stringify({ name, version }),
    "index.js": `export const id = ${JSON.stringify(`${name}@${version}`)};`,
  });
}

/** Real SRI digest of the fixture tarball — install-time verification must pass. */
function fixtureIntegrity(name: string, version: string): string {
  return `sha512-${new Bun.CryptoHasher("sha512").update(fixtureTgz(name, version)).digest("base64")}`;
}

function makePackument(name: string, versions: Record<string, FixtureVersion>, latest: string): Packument {
  const packument: Packument = { name, "dist-tags": { latest }, versions: {} };
  for (const [version, spec] of Object.entries(versions)) {
    packument.versions[version] = {
      name,
      version,
      dist: { tarball: tarballUrl(name, version), integrity: fixtureIntegrity(name, version) },
      ...(spec.deps !== undefined ? { dependencies: spec.deps } : {}),
    };
  }
  return packument;
}

/**
 * Registry fixture: aa depends on bb; @scope/util standalone; aa@2 exists so
 * "stale lock" tests can bump the requested range past the pin.
 */
function fixtureRegistry(): { source: PackumentSource; calls: string[]; tarballs: Map<string, Uint8Array> } {
  const packuments = new Map<string, Packument>([
    ["aa", makePackument("aa", { "1.2.3": { deps: { bb: "^2.0.0" } }, "2.0.0": {} }, "1.2.3")],
    ["bb", makePackument("bb", { "2.1.0": {} }, "2.1.0")],
    ["@scope/util", makePackument("@scope/util", { "0.3.0": {} }, "0.3.0")],
  ]);
  const tarballs = new Map<string, Uint8Array>();
  for (const [name, versions] of [
    ["aa", ["1.2.3", "2.0.0"]],
    ["bb", ["2.1.0"]],
    ["@scope/util", ["0.3.0"]],
  ] as const) {
    for (const version of versions) {
      tarballs.set(tarballUrl(name, version), fixtureTgz(name, version));
    }
  }
  const calls: string[] = [];
  const source: PackumentSource = async (name) => {
    calls.push(name);
    const packument = packuments.get(name);
    if (packument === undefined) throw new Error(`[npm] package not found in registry: ${name}`);
    return packument;
  };
  return { source, calls, tarballs };
}

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
  return new InMemoryFs() as unknown as BurrowVfs;
}

function ctxFor(vfs: BurrowVfs, cwd: string): CommandContext {
  return { fs: vfs, cwd, env: new Map(), stdin: "" };
}

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

// --------------------------------------------------------------------------
// parseAddSpec
// --------------------------------------------------------------------------

describe("parseAddSpec", () => {
  test("scoped name with range", () => {
    expect(parseAddSpec("@scope/name@^1")).toEqual({ name: "@scope/name", range: "^1", explicitRange: true });
  });

  test("bare name defaults to latest", () => {
    expect(parseAddSpec("name")).toEqual({ name: "name", range: "latest", explicitRange: false });
  });

  test("exact version", () => {
    expect(parseAddSpec("name@1.2.3")).toEqual({ name: "name", range: "1.2.3", explicitRange: true });
  });

  test("explicit dist-tag", () => {
    expect(parseAddSpec("name@latest")).toEqual({ name: "name", range: "latest", explicitRange: true });
  });

  test("scoped name without range", () => {
    expect(parseAddSpec("@scope/name")).toEqual({ name: "@scope/name", range: "latest", explicitRange: false });
  });

  test("trailing @ means no explicit range", () => {
    expect(parseAddSpec("name@")).toEqual({ name: "name", range: "latest", explicitRange: false });
  });

  test("malformed specs are rejected", () => {
    expect(parseAddSpec("")).toBeNull();
    expect(parseAddSpec("   ")).toBeNull();
    expect(parseAddSpec("not a name")).toBeNull();
    expect(parseAddSpec("../../etc/passwd")).toBeNull();
  });
});

// --------------------------------------------------------------------------
// package.json mutation
// --------------------------------------------------------------------------

describe("package.json mutation", () => {
  const original = `{
  "name": "demo",
  "version": "1.0.0",
  "scripts": {
    "dev": "bun run index.ts"
  },
  "dependencies": {
    "zebra": "^1.0.0",
    "apple": "^2.0.0"
  }
}
`;

  test("adding preserves top-level key order and existing dep order", () => {
    const next = addDependencyToPackageJson(original, "mango", "^3.0.0", false);
    const doc = JSON.parse(next) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["name", "version", "scripts", "dependencies"]);
    // mango sorts before zebra; zebra/apple keep their original relative order.
    expect(Object.keys(doc.dependencies as object)).toEqual(["mango", "zebra", "apple"]);
    expect(next.endsWith("\n")).toBe(true);
  });

  test("updating an existing dep keeps its position", () => {
    const next = addDependencyToPackageJson(original, "zebra", "^9.0.0", false);
    const deps = (JSON.parse(next) as { dependencies: Record<string, string> }).dependencies;
    expect(Object.keys(deps)).toEqual(["zebra", "apple"]);
    expect(deps.zebra).toBe("^9.0.0");
  });

  test("--dev creates devDependencies at the end and moves the name over", () => {
    const withDev = addDependencyToPackageJson(original, "apple", "^2.0.0", true);
    const doc = JSON.parse(withDev) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["name", "version", "scripts", "dependencies", "devDependencies"]);
    expect(Object.keys(doc.dependencies as object)).toEqual(["zebra"]);
    expect(doc.devDependencies).toEqual({ apple: "^2.0.0" });
  });

  test("indentation and missing trailing newline are preserved", () => {
    const tabbed = `{\n\t"name": "t",\n\t"dependencies": {\n\t\t"a": "1.0.0"\n\t}\n}`;
    const next = addDependencyToPackageJson(tabbed, "b", "2.0.0", false);
    expect(next).toContain('\t"dependencies"');
    expect(next).toContain('\t\t"b": "2.0.0"');
    expect(next.endsWith("\n")).toBe(false);
  });

  test("remove deletes from both fields and reports absence", () => {
    const removed = removeDependencyFromPackageJson(original, "apple");
    expect(removed.removed).toBe(true);
    expect((JSON.parse(removed.text) as { dependencies: object }).dependencies).toEqual({ zebra: "^1.0.0" });

    const absent = removeDependencyFromPackageJson(original, "nope");
    expect(absent.removed).toBe(false);
    expect(absent.text).toBe(original);
  });
});

// --------------------------------------------------------------------------
// lockfile round-trip
// --------------------------------------------------------------------------

describe("lockfile", () => {
  const sampleLock = (): Lockfile => ({
    version: 1,
    packages: {
      "bb@^2.0.0": { name: "bb", version: "2.1.0", tarballUrl: tarballUrl("bb", "2.1.0"), integrity: "sha512-bb-2.1.0", dependencies: {} },
      "aa@^1.0.0": {
        name: "aa",
        version: "1.2.3",
        tarballUrl: tarballUrl("aa", "1.2.3"),
        integrity: "sha512-aa-1.2.3",
        dependencies: { bb: "^2.0.0" },
      },
    },
  });

  test("write → read round-trips, integrity carried through", async () => {
    const vfs = makeVfs();
    vfs.mkdirSync("/p", { recursive: true });
    await writeLockfile(vfs, "/p", sampleLock());
    const back = await readLockfile(vfs, "/p");
    expect(back).toEqual(sampleLock());

    const pinned = pinnedResolution(back, "aa", "^1.0.0");
    expect(pinned).toEqual({
      name: "aa",
      version: "1.2.3",
      tarballUrl: tarballUrl("aa", "1.2.3"),
      integrity: "sha512-aa-1.2.3",
      dependencies: { bb: "^2.0.0" },
    });
    expect(pinnedResolution(back, "aa", "^2.0.0")).toBeNull();
  });

  test("serialization is stable: keys sorted, trailing newline", async () => {
    const vfs = makeVfs();
    vfs.mkdirSync("/p", { recursive: true });
    await writeLockfile(vfs, "/p", sampleLock());
    const text = await vfs.readFile(`/p/${LOCKFILE_NAME}`);
    expect(text.indexOf('"aa@^1.0.0"')).toBeLessThan(text.indexOf('"bb@^2.0.0"'));
    expect(text.endsWith("\n")).toBe(true);
  });

  test("absent, corrupt, wrong-version, malformed → null (never throws)", async () => {
    const vfs = makeVfs();
    vfs.mkdirSync("/p", { recursive: true });
    expect(await readLockfile(vfs, "/p")).toBeNull();

    await vfs.writeFile(`/p/${LOCKFILE_NAME}`, "{ not json");
    expect(await readLockfile(vfs, "/p")).toBeNull();

    await vfs.writeFile(`/p/${LOCKFILE_NAME}`, JSON.stringify({ version: 2, packages: {} }));
    expect(await readLockfile(vfs, "/p")).toBeNull();

    await vfs.writeFile(`/p/${LOCKFILE_NAME}`, JSON.stringify({ version: 1, packages: { x: { name: 42 } } }));
    expect(await readLockfile(vfs, "/p")).toBeNull();
  });

  test("removeFromLock drops every range of a name", () => {
    const lock = emptyLockfile();
    lock.packages["aa@^1.0.0"] = { name: "aa", version: "1.2.3", tarballUrl: "t" };
    lock.packages["aa@latest"] = { name: "aa", version: "1.2.3", tarballUrl: "t" };
    lock.packages["bb@^2.0.0"] = { name: "bb", version: "2.1.0", tarballUrl: "t" };
    expect(removeFromLock(lock, "aa")).toBe(2);
    expect(Object.keys(lock.packages)).toEqual(["bb@^2.0.0"]);
  });

  test("splitLockKey is scope-aware", () => {
    expect(splitLockKey("@s/n@^1")).toEqual({ name: "@s/n", range: "^1" });
    expect(splitLockKey("plain@1.2.3")).toEqual({ name: "plain", range: "1.2.3" });
  });
});

// --------------------------------------------------------------------------
// lock-aware resolution
// --------------------------------------------------------------------------

describe("resolveLockAware", () => {
  const requested = { aa: "^1.0.0", "@scope/util": "latest" };

  async function freshLock(): Promise<Lockfile> {
    const { source } = fixtureRegistry();
    const plan = await resolveLockAware(requested, null, source);
    return lockFromResolutions(null, collectResolutions(plan));
  }

  test("without a lock, every packument is fetched and the plan is parents-first", async () => {
    const { source, calls } = fixtureRegistry();
    const plan = await resolveLockAware(requested, null, source);
    expect(calls.sort()).toEqual(["@scope/util", "aa", "bb"]);
    // parents-first: aa precedes its dependency bb.
    expect(plan.packages.map((p) => `${p.name}@${p.version}`)).toEqual(["aa@1.2.3", "bb@2.1.0", "@scope/util@0.3.0"]);
    const lock = lockFromResolutions(null, collectResolutions(plan));
    expect(Object.keys(lock.packages).sort()).toEqual(["@scope/util@latest", "aa@^1.0.0", "bb@^2.0.0"]);
  });

  test("a fully-locked install fetches ZERO packuments and carries integrity through", async () => {
    const lock = await freshLock();
    const { source, calls } = fixtureRegistry();
    const plan = await resolveLockAware(requested, lock, source);
    expect(calls).toEqual([]);
    const aa = plan.packages.find((p) => p.name === "aa");
    expect(aa?.version).toBe("1.2.3");
    expect(aa?.integrity).toBe(fixtureIntegrity("aa", "1.2.3")); // straight from the lock
    expect(plan.packages).toHaveLength(3);
  });

  test("a stale pin releases exactly the stale name to the network", async () => {
    const lock = await freshLock();
    const { source, calls } = fixtureRegistry();
    // User bumped aa's range past the pinned 1.2.3.
    const plan = await resolveLockAware({ aa: "^2.0.0", "@scope/util": "latest" }, lock, source);
    expect(calls).toEqual(["aa"]); // @scope/util stayed pinned
    expect(plan.packages.map((p) => `${p.name}@${p.version}`).sort()).toEqual(["@scope/util@0.3.0", "aa@2.0.0"]);
  });
});

// --------------------------------------------------------------------------
// the extended `bun` command, end to end
// --------------------------------------------------------------------------

describe("bun install/add/remove command", () => {
  const PROJ = "/home/user/proj";

  function setup(manifest: object): {
    vfs: BurrowVfs;
    run: (line: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    calls: string[];
  } {
    const vfs = makeVfs();
    vfs.mkdirSync(PROJ, { recursive: true });
    vfs.writeFileSync(`${PROJ}/package.json`, JSON.stringify(manifest, null, 2) + "\n");
    const { source, calls, tarballs } = fixtureRegistry();
    const installer = createNpmInstaller({ vfs, getPackument: source, installEnv: fakeEnv(tarballs) });
    const commands = createNpmCommands(installer);
    const bun = commands.find((c) => c.name === "bun");
    if (bun === undefined) throw new Error("bun command not created");
    return {
      vfs,
      calls,
      run: async (args) => {
        const r = await bun.execute(args, ctxFor(vfs, PROJ));
        return { stdout: strip(r.stdout), stderr: strip(r.stderr), exitCode: r.exitCode };
      },
    };
  }

  test("bun install: installs the graph, writes the lock, prints phase lines", async () => {
    const { vfs, run } = setup({ name: "proj", version: "1.0.0", dependencies: { aa: "^1.0.0" } });
    const out = await run(["install"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("resolve   2 packages");
    expect(out.stdout).toContain("download  2/2");
    expect(out.stdout).toContain("extract   2 archives");
    expect(out.stdout).toContain("link      2 folders");
    expect(out.stdout).toMatch(/done in \d+ms — 2 packages, [\d.]+ (B|KB|MB)/);
    expect(await vfs.readFile(`${PROJ}/node_modules/aa/index.js`)).toContain("aa@1.2.3");
    expect(await vfs.readFile(`${PROJ}/node_modules/bb/index.js`)).toContain("bb@2.1.0");
    const lock = await readLockfile(vfs, PROJ);
    expect(Object.keys(lock?.packages ?? {}).sort()).toEqual(["aa@^1.0.0", "bb@^2.0.0"]);
  });

  test("bun install twice: second run resolves entirely from the lock", async () => {
    const { run, calls } = setup({ name: "proj", version: "1.0.0", dependencies: { aa: "^1.0.0" } });
    await run(["install"]);
    const fetchesAfterFirst = calls.length;
    const out = await run(["install"]);
    expect(out.exitCode).toBe(0);
    expect(calls.length).toBe(fetchesAfterFirst); // zero new packument fetches
  });

  test("bun add @scope/util --dev: updates package.json (order kept) + lock", async () => {
    const { vfs, run } = setup({ name: "proj", version: "1.0.0", dependencies: { aa: "^1.0.0" } });
    const out = await run(["add", "@scope/util", "--dev"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("+ @scope/util@0.3.0 (dev)");

    const doc = JSON.parse(await vfs.readFile(`${PROJ}/package.json`)) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["name", "version", "dependencies", "devDependencies"]);
    expect(doc.devDependencies).toEqual({ "@scope/util": "^0.3.0" });
    expect(await vfs.exists(`${PROJ}/node_modules/@scope/util/index.js`)).toBe(true);

    const lock = await readLockfile(vfs, PROJ);
    expect(lock?.packages["@scope/util@^0.3.0"]?.version).toBe("0.3.0");
    expect(lock?.packages["@scope/util@latest"]).toBeUndefined(); // re-keyed to the saved range
  });

  test("bun add name@1.2.3 saves the exact pin", async () => {
    const { vfs, run } = setup({ name: "proj", version: "1.0.0" });
    const out = await run(["add", "aa@1.2.3"]);
    expect(out.exitCode).toBe(0);
    const doc = JSON.parse(await vfs.readFile(`${PROJ}/package.json`)) as { dependencies: Record<string, string> };
    expect(doc.dependencies.aa).toBe("1.2.3");
  });

  test("bun remove: drops package.json entry, node_modules dir, lock pins", async () => {
    const { vfs, run } = setup({ name: "proj", version: "1.0.0", dependencies: { aa: "^1.0.0" } });
    await run(["install"]);
    const out = await run(["remove", "aa"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("- aa");

    const doc = JSON.parse(await vfs.readFile(`${PROJ}/package.json`)) as { dependencies: object };
    expect(doc.dependencies).toEqual({});
    expect(await vfs.exists(`${PROJ}/node_modules/aa`)).toBe(false);
    const lock = await readLockfile(vfs, PROJ);
    expect(lock?.packages["aa@^1.0.0"]).toBeUndefined();

    const again = await run(["remove", "aa"]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("not a dependency");
  });

  test("bun install with no package.json anywhere fails cleanly", async () => {
    const vfs = makeVfs();
    vfs.mkdirSync("/home/user/empty", { recursive: true });
    const { source, tarballs } = fixtureRegistry();
    const installer = createNpmInstaller({ vfs, getPackument: source, installEnv: fakeEnv(tarballs) });
    const bun = createNpmCommands(installer).find((c) => c.name === "bun");
    const out = await bun!.execute(["install"], ctxFor(vfs, "/home/user/empty"));
    expect(out.exitCode).toBe(1);
    expect(strip(out.stderr)).toContain("no package.json");
  });

  test("bun install <name> hints at bun add", async () => {
    const { run } = setup({ name: "proj", version: "1.0.0" });
    const out = await run(["install", "aa"]);
    expect(out.exitCode).toBe(129);
    expect(out.stderr).toContain("bun add aa");
  });

  test("non-npm subcommands still reach the toolchain (delegation)", async () => {
    const { run } = setup({ name: "proj", version: "1.0.0" });
    const version = await run(["--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toContain("burrow");

    const help = await run(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("bun run");           // toolchain usage intact
    expect(help.stdout).toContain("package manager:");  // npm section appended
    expect(help.stdout).toContain("bun install");
  });
});
