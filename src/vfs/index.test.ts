import { beforeAll, describe, expect, test } from "bun:test";
import { resetRegistryForTests, tryUse } from "../contract/registry.ts";
import { WORKSPACE_ROOT } from "../contract/types.ts";
import { initVfs, resetWorkspace, vfsReady } from "./index.ts";
import { DEMO_DIR } from "./seed.ts";

// NOTE: the registry is module-global and provide() throws on duplicates, so
// initVfs() runs exactly once for this whole test process — keep every
// registry-touching assertion in this file. Test-file ORDER is platform
// dependent (CI runs shell/driver.test.ts, which lazily provides "events",
// before this file), so wipe whatever earlier files left behind first.
beforeAll(() => resetRegistryForTests());

describe("initVfs", () => {
  test("provides events, vfs, and gitFs; seeds README + demo project", async () => {
    initVfs();
    // Restore-or-seed is async (IndexedDB in the browser); under bun there is
    // no IndexedDB, so this resolves after the first-boot seed was applied.
    await vfsReady();

    const events = tryUse("events");
    const vfs = tryUse("vfs");
    const gitFs = tryUse("gitFs");
    expect(events).toBeDefined();
    expect(vfs).toBeDefined();
    expect(gitFs).toBeDefined();

    const paths = vfs!.getAllPaths();
    expect(paths).toContain(`${WORKSPACE_ROOT}/README.md`);
    expect(paths).toContain(`${DEMO_DIR}/package.json`);
    expect(paths).toContain(`${DEMO_DIR}/index.ts`);
    expect(paths).toContain(`${DEMO_DIR}/greet.ts`);
    expect(paths).toContain(`${DEMO_DIR}/server.ts`);

    // demo package.json declares exactly the esm.sh-able dependencies the
    // seed files import (hono for server.ts, nanoid for index.ts)
    const pkg = JSON.parse(await vfs!.readFile(`${DEMO_DIR}/package.json`)) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["hono", "nanoid"]);

    // the demo entry imports the dep + a local module (toolchain graph fodder)
    const index = await vfs!.readFile(`${DEMO_DIR}/index.ts`);
    expect(index).toContain(`from "nanoid"`);
    expect(index).toContain(`from "./greet.ts"`);

    // the server example is a plain Hono app — no Bun.serve; the run worker's
    // handler-shape detection picks up the default export
    const server = await vfs!.readFile(`${DEMO_DIR}/server.ts`);
    expect(server).toContain(`from "hono"`);
    expect(server).toContain("export default app");
    expect(server).not.toContain("Bun.serve");

    // gitFs is wired over the same store
    const names = await gitFs!.readdir(DEMO_DIR);
    expect(names.sort()).toEqual(["greet.ts", "index.ts", "package.json", "server.ts"]);

    // the shared bus is live: a write through vfs reaches subscribers
    let observed: string | undefined;
    const off = events!.on("file:changed", (e) => {
      observed = e.path;
    });
    await vfs!.writeFile(`${WORKSPACE_ROOT}/probe.txt`, "x");
    off();
    expect(observed).toBe(`${WORKSPACE_ROOT}/probe.txt`);

    // WORKSPACE_ROOT exists as a directory (Bash cwd home)
    expect((await vfs!.stat(WORKSPACE_ROOT)).isDirectory).toBe(true);
  });

  test("initVfs throws if called twice (registry guards double-provide)", () => {
    expect(() => initVfs()).toThrow(/provided twice/);
  });

  test("resetWorkspace wipes user files, reseeds, and emits fs:batch{seed}", async () => {
    const events = tryUse("events")!;
    const vfs = tryUse("vfs")!;

    await vfs.writeFile(`${WORKSPACE_ROOT}/junk.txt`, "delete me");
    await vfs.writeFile(`${DEMO_DIR}/greet.ts`, "// user broke the demo");

    let seedBatches = 0;
    const off = events.on("fs:batch", (e) => {
      if (e.reason === "seed") seedBatches += 1;
    });
    await resetWorkspace();
    off();

    expect(seedBatches).toBe(1);
    const paths = vfs.getAllPaths();
    expect(paths).not.toContain(`${WORKSPACE_ROOT}/junk.txt`);
    expect(paths).toContain(`${WORKSPACE_ROOT}/README.md`);
    expect(await vfs.readFile(`${DEMO_DIR}/greet.ts`)).toContain("export function greet");
  });
});
