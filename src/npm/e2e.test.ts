/**
 * burrow — src/npm/e2e.test.ts (integrator)
 *
 * END-TO-END PROOF, headless, against the REAL npm registry:
 *
 *   resolveInstallPlan({ ms: "^2" })              (live packument fetch)
 *     → executeInstallPlan(plan, root, vfs)       (live tarball → gunzip → untar → VFS)
 *     → node_modules/ms/package.json exists in the VFS
 *     → resolveBareSpecifier("ms", …) finds the installed file (not esm.sh)
 *     → the CJS wrapper turns that file into an ESM facade
 *     → importing the facade yields the working ms() function.
 *
 * This is the exact chain the browser runs when a user types `bun add ms`
 * and then `bun run` a file importing it — proven here entirely under bun test
 * (temp-file module paths stand in for the browser's blob: URLs; Bun rejects
 * long data: URLs with NameTooLong).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import { InMemoryFs } from "just-bash/browser";
import type { BurrowVfs } from "../contract/types.ts";
import { resolveInstallPlan } from "./resolve.ts";
import { executeInstallPlan } from "./install.ts";
import { resolveBareSpecifier } from "../toolchain/node-resolve.ts";
import { buildCjsFacade, isCjsModule, CJS_REGISTRY_SOURCE, type CjsBuildHost } from "../toolchain/cjs.ts";

const LIVE_TIMEOUT = 90_000;
const ROOT = "/home/user";

function makeVfs(): BurrowVfs {
  // InMemoryFs is the exact store WatchedFs decorates (src/vfs) — the same
  // promise surface, minus events, which nothing in this chain relies on.
  return new InMemoryFs() as unknown as BurrowVfs;
}

/**
 * bun test stand-in for the app's blob: URLs: generated module text lands in a
 * real temp file whose absolute path is a valid import specifier.
 */
const moduleDir = mkdtempSync(join(tmpdir(), "burrow-e2e-"));
let moduleCount = 0;

async function asModuleUrl(code: string): Promise<string> {
  const path = join(moduleDir, `mod${moduleCount++}.mjs`);
  await Bun.write(path, code);
  return path;
}

afterAll(() => {
  rmSync(moduleDir, { recursive: true, force: true });
});

describe("npm end-to-end (live registry)", () => {
  test(
    "resolve → install → node-resolve → CJS facade → working ms()",
    async () => {
      const vfs = makeVfs();
      await vfs.mkdir(ROOT, { recursive: true });

      // 1. Resolve against the real registry.
      const plan = await resolveInstallPlan({ ms: "^2" });
      expect(plan.packages.length).toBe(1);
      const pkg = plan.packages[0]!;
      expect(pkg.name).toBe("ms");
      expect(semver.satisfies(pkg.version, "^2")).toBe(true);

      // 2. Install: real tarball download → gunzip → untar → VFS.
      const report = await executeInstallPlan(plan, ROOT, vfs);
      expect(report.installed).toEqual([{ name: "ms", version: pkg.version }]);
      expect(report.bytes).toBeGreaterThan(0);

      // 3. The package landed in the VFS.
      const manifestPath = `${ROOT}/node_modules/ms/package.json`;
      expect(await vfs.exists(manifestPath)).toBe(true);
      const manifest = JSON.parse(await vfs.readFile(manifestPath)) as { name: string; version: string };
      expect(manifest.name).toBe("ms");
      expect(manifest.version).toBe(pkg.version);

      // 4. The toolchain resolver finds the INSTALLED package (no esm.sh).
      const resolved = await resolveBareSpecifier("ms", `${ROOT}/x.ts`, vfs);
      if (resolved.kind !== "vfs") throw new Error(`expected vfs resolution, got ${JSON.stringify(resolved)}`);
      expect(resolved.path.startsWith(`${ROOT}/node_modules/ms/`)).toBe(true);
      expect((await vfs.stat(resolved.path)).isFile).toBe(true);

      // 5. ms is CommonJS → the CJS wrapper must kick in for that file.
      const source = await vfs.readFile(resolved.path);
      expect(await isCjsModule(resolved.path, source, vfs)).toBe(true);

      const host: CjsBuildHost = {
        vfs,
        isCycle: () => false,
        buildChild: async () => {
          throw new Error("ms has no local requires — buildChild must not be called");
        },
        esmShFallback: async () => null,
      };
      const facade = await buildCjsFacade(resolved.path, source, await asModuleUrl(CJS_REGISTRY_SOURCE), host);
      expect(facade.errors).toEqual([]);
      expect(facade.code).not.toBeNull();
      expect(facade.code!).toContain("export default");

      // 6. The facade is a real ESM module whose default export IS ms().
      const mod = (await import(await asModuleUrl(facade.code!))) as {
        default: (value: string | number) => string | number;
        __burrowCjs: boolean;
      };
      expect(mod.__burrowCjs).toBe(true);
      expect(typeof mod.default).toBe("function");
      expect(mod.default("2 days")).toBe(172_800_000);
      expect(mod.default(60_000)).toBe("1m");
    },
    LIVE_TIMEOUT,
  );
});
