/**
 * burrow — src/npm/resolve.test.ts (resolver agent)
 * Offline fixture tests for the graph algebra + live registry.npmjs.org tests
 * (real network is acceptable for this suite per the module brief).
 */

import { describe, expect, test } from "bun:test";
import semver from "semver";
import { clearPackumentCache, fetchPackument, isValidPackageName, packumentUrl } from "./registry.ts";
import { pickVersion, resolveInstallPlan } from "./resolve.ts";
import type { InstallProgress, Packument, PackumentVersion } from "./types.ts";

const LIVE_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function fixtureVersion(
  name: string,
  version: string,
  extra: Partial<PackumentVersion> = {},
): PackumentVersion {
  return {
    name,
    version,
    dist: {
      tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity: `sha512-FIXTURE-${name}-${version}`,
    },
    ...extra,
  };
}

function fixturePackument(
  name: string,
  versions: PackumentVersion[],
  distTags: Record<string, string> = {},
): Packument {
  const versionMap: Record<string, PackumentVersion> = {};
  for (const v of versions) versionMap[v.version] = v;
  const latest = versions[versions.length - 1]!.version;
  return { name, "dist-tags": { latest, ...distTags }, versions: versionMap };
}

/** alpha@^1 → alpha@1.2.0 → beta@^1 → (cycle back to alpha) */
const FIXTURES: Record<string, Packument> = {
  alpha: fixturePackument("alpha", [
    fixtureVersion("alpha", "1.0.0"),
    fixtureVersion("alpha", "1.2.0", { dependencies: { beta: "^1.0.0" } }),
    fixtureVersion("alpha", "2.0.0", { dependencies: { beta: "^1.0.0" } }),
  ]),
  beta: fixturePackument("beta", [
    fixtureVersion("beta", "1.0.5", {
      dependencies: { alpha: "^1.0.0", fsevents: "^2.0.0", weird: "github:someone/weird" },
      optionalDependencies: { fsevents: "^2.0.0" },
      peerDependencies: { react: "^18.0.0", "optional-peer": "*" },
      peerDependenciesMeta: { "optional-peer": { optional: true } },
    }),
  ]),
  tagged: fixturePackument(
    "tagged",
    [fixtureVersion("tagged", "1.0.0"), fixtureVersion("tagged", "2.0.0-beta.1")],
    { latest: "1.0.0", beta: "2.0.0-beta.1" },
  ),
};

const fixtureSource = async (name: string): Promise<Packument> => {
  const doc = FIXTURES[name];
  if (!doc) throw new Error(`[npm] package not found in registry: ${name}`);
  return doc;
};

// ---------------------------------------------------------------------------
// Offline: registry URL construction
// ---------------------------------------------------------------------------

describe("packumentUrl", () => {
  test("plain names pass through", () => {
    expect(packumentUrl("nanoid")).toBe("https://registry.npmjs.org/nanoid");
  });

  test("scoped names keep @ and encode the slash", () => {
    expect(packumentUrl("@types/node")).toBe("https://registry.npmjs.org/@types%2Fnode");
  });

  test("name validation rejects URL-corrupting input", () => {
    expect(isValidPackageName("nanoid")).toBe(true);
    expect(isValidPackageName("@scope/pkg")).toBe(true);
    expect(isValidPackageName("../../etc")).toBe(false);
    expect(isValidPackageName("a b")).toBe(false);
    expect(isValidPackageName("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Offline: version picking
// ---------------------------------------------------------------------------

describe("pickVersion (fixtures)", () => {
  test("maxSatisfying within a caret range", () => {
    expect(pickVersion(FIXTURES["alpha"]!, "^1.0.0")).toBe("1.2.0");
  });

  test("exact pin", () => {
    expect(pickVersion(FIXTURES["alpha"]!, "1.0.0")).toBe("1.0.0");
  });

  test("dist-tag specs", () => {
    expect(pickVersion(FIXTURES["tagged"]!, "latest")).toBe("1.0.0");
    expect(pickVersion(FIXTURES["tagged"]!, "beta")).toBe("2.0.0-beta.1");
  });

  test("star and empty specs resolve to latest", () => {
    expect(pickVersion(FIXTURES["tagged"]!, "*")).toBe("1.0.0");
    expect(pickVersion(FIXTURES["tagged"]!, "")).toBe("1.0.0");
  });

  test("unsatisfiable range yields null", () => {
    expect(pickVersion(FIXTURES["alpha"]!, "^9.0.0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Offline: full plan over a fixed fixture (determinism, cycles, peers, order)
// ---------------------------------------------------------------------------

describe("resolveInstallPlan (fixtures)", () => {
  test("plan shape, exact-version pinning, cycle safety, topo order", async () => {
    const plan = await resolveInstallPlan({ alpha: "^1.0.0" }, { getPackument: fixtureSource });

    // Deduped by name@version; cycle (beta → alpha) did not loop or duplicate.
    expect(plan.packages.map((p) => `${p.name}@${p.version}`)).toEqual(["alpha@1.2.0", "beta@1.0.5"]);
    // Parents before children.
    expect(plan.packages[0]!.name).toBe("alpha");
    // Exact pinning: ^1.0.0 → 1.2.0, never 2.0.0.
    expect(plan.packages[0]!.version).toBe("1.2.0");
    expect(plan.requested).toEqual({ alpha: "^1.0.0" });
    // dist fields carried through.
    expect(plan.packages[1]!.tarballUrl).toBe("https://registry.npmjs.org/beta/-/beta-1.0.5.tgz");
    expect(plan.packages[1]!.integrity).toBe("sha512-FIXTURE-beta-1.0.5");
    // Optional dep (fsevents) and non-registry dep (weird) are excluded from
    // beta's plan-facing dependency record.
    expect(plan.packages[1]!.dependencies).toEqual({ alpha: "^1.0.0" });
  });

  test("deterministic: identical plans across runs", async () => {
    const a = await resolveInstallPlan({ alpha: "^1.0.0" }, { getPackument: fixtureSource });
    const b = await resolveInstallPlan({ alpha: "^1.0.0" }, { getPackument: fixtureSource });
    expect(b).toEqual(a);
  });

  test("non-optional peers become warnings; optional peers stay silent", async () => {
    const plan = await resolveInstallPlan({ beta: "^1.0.0" }, { getPackument: fixtureSource });
    expect(plan.warnings.some((w) => w.includes("peer dependency react@^18.0.0"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("optional-peer"))).toBe(false);
    // Skipped non-registry transitive dep is warned about, not fatal.
    expect(plan.warnings.some((w) => w.includes("weird@github:someone/weird"))).toBe(true);
  });

  test("non-registry spec for a directly-requested dep throws", async () => {
    await expect(
      resolveInstallPlan({ alpha: "github:someone/alpha" }, { getPackument: fixtureSource }),
    ).rejects.toThrow(/non-registry/);
  });

  test("unsatisfiable requested range throws with the requirer", async () => {
    await expect(
      resolveInstallPlan({ alpha: "^9.0.0" }, { getPackument: fixtureSource }),
    ).rejects.toThrow(/no version of alpha satisfies "\^9\.0\.0"/);
  });

  test("unknown package propagates the registry error", async () => {
    await expect(
      resolveInstallPlan({ nope: "^1.0.0" }, { getPackument: fixtureSource }),
    ).rejects.toThrow(/not found/);
  });

  test("progress stays in the resolve phase with monotonic done", async () => {
    const events: InstallProgress[] = [];
    await resolveInstallPlan(
      { alpha: "^1.0.0" },
      { getPackument: fixtureSource, onProgress: (p) => events.push(p) },
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.phase === "resolve")).toBe(true);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.done).toBeGreaterThanOrEqual(events[i - 1]!.done);
    }
    expect(events[events.length - 1]!.detail).toBe("resolved");
  });
});

// ---------------------------------------------------------------------------
// Live registry (real network — acceptable for this suite)
// ---------------------------------------------------------------------------

describe("live registry.npmjs.org", () => {
  test(
    "nanoid ^5.1.5 — zero-dep ESM package",
    async () => {
      const plan = await resolveInstallPlan({ nanoid: "^5.1.5" });
      expect(plan.packages.length).toBe(1);
      const pkg = plan.packages[0]!;
      expect(pkg.name).toBe("nanoid");
      expect(semver.satisfies(pkg.version, "^5.1.5")).toBe(true);
      expect(pkg.tarballUrl).toContain("/nanoid/-/nanoid-");
      expect(pkg.integrity).toStartWith("sha512-");
      expect(pkg.dependencies).toEqual({});
      expect(plan.requested).toEqual({ nanoid: "^5.1.5" });
    },
    LIVE_TIMEOUT,
  );

  test(
    "hono ^4 — requested package leads the plan",
    async () => {
      const plan = await resolveInstallPlan({ hono: "^4" });
      expect(plan.packages.length).toBeGreaterThanOrEqual(1);
      const first = plan.packages[0]!;
      expect(first.name).toBe("hono");
      expect(semver.satisfies(first.version, "^4")).toBe(true);
      for (const pkg of plan.packages) {
        expect(pkg.tarballUrl).toMatch(/^https:\/\//);
        expect(pkg.version).toBe(semver.valid(pkg.version)!);
      }
      // Deduped: no name@version appears twice.
      const keys = plan.packages.map((p) => `${p.name}@${p.version}`);
      expect(new Set(keys).size).toBe(keys.length);
    },
    LIVE_TIMEOUT,
  );

  test(
    "ms ^2 — classic zero-dep CJS package",
    async () => {
      const plan = await resolveInstallPlan({ ms: "^2" });
      expect(plan.packages.length).toBe(1);
      const pkg = plan.packages[0]!;
      expect(pkg.name).toBe("ms");
      expect(semver.satisfies(pkg.version, "^2")).toBe(true);
      expect(pkg.tarballUrl).toContain("/ms/-/ms-");
      expect(pkg.dependencies).toEqual({});
    },
    LIVE_TIMEOUT,
  );

  test(
    "packument session cache returns the identical document",
    async () => {
      clearPackumentCache();
      const first = await fetchPackument("ms");
      const second = await fetchPackument("ms");
      expect(second).toBe(first);
      expect(first.name).toBe("ms");
      expect(Object.keys(first.versions).length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT,
  );

  test(
    "scoped packument fetch (@scope%2fname URL form)",
    async () => {
      const doc = await fetchPackument("@sindresorhus/is");
      expect(doc.name).toBe("@sindresorhus/is");
      expect(doc["dist-tags"]["latest"]).toBeDefined();
    },
    LIVE_TIMEOUT,
  );
});
