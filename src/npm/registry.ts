/**
 * burrow — src/npm/registry.ts
 * OWNED BY: resolver agent. npm registry packument client.
 *
 * fetchPackument(name) GETs https://registry.npmjs.org/<name> with the
 * abbreviated install metadata Accept header. Plain fetch only — works in the
 * browser and under `bun test`. In-memory promise cache per session so
 * concurrent graph resolution dedupes requests for the same package.
 */

import type { Packument } from "./types.ts";

export const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
/** Abbreviated packument: only the fields needed to install (much smaller). */
export const PACKUMENT_ACCEPT = "application/vnd.npm.install-v1+json";

/**
 * Loose npm package-name check — enough to reject specs that would corrupt
 * the registry URL (spaces, extra slashes, traversal). Mirrors npm's rules:
 * optional @scope/ prefix, then URL-safe name characters.
 */
const NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && NAME_RE.test(name);
}

/** Scoped names keep the leading `@` but URL-encode the inner `/` (`%2F`). */
export function packumentUrl(name: string): string {
  const encoded = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  return `${NPM_REGISTRY_BASE}/${encoded}`;
}

// Promise-valued so concurrent callers share one in-flight request. Failed
// fetches are evicted so a later retry can succeed.
const packumentCache = new Map<string, Promise<Packument>>();

/** Test/interactive helper: drop the session cache. */
export function clearPackumentCache(): void {
  packumentCache.clear();
}

export async function fetchPackument(name: string): Promise<Packument> {
  if (!isValidPackageName(name)) {
    throw new Error(`[npm] invalid package name: ${JSON.stringify(name)}`);
  }
  const cached = packumentCache.get(name);
  if (cached) return cached;

  const promise = fetchPackumentUncached(name);
  packumentCache.set(name, promise);
  promise.catch(() => {
    // Evict failures; keep the cache to successful packuments only.
    if (packumentCache.get(name) === promise) packumentCache.delete(name);
  });
  return promise;
}

async function fetchPackumentUncached(name: string): Promise<Packument> {
  const res = await fetch(packumentUrl(name), {
    headers: { accept: PACKUMENT_ACCEPT },
  });
  if (res.status === 404) {
    throw new Error(`[npm] package not found in registry: ${name}`);
  }
  if (!res.ok) {
    throw new Error(`[npm] registry error for ${name}: ${res.status} ${res.statusText}`);
  }
  const doc = (await res.json()) as Packument;
  if (typeof doc !== "object" || doc === null || typeof doc.versions !== "object" || doc.versions === null) {
    throw new Error(`[npm] malformed packument for ${name}: missing versions`);
  }
  return doc;
}
