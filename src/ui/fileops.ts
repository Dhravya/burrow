/**
 * Burrow — pure file-management helpers for the tree CRUD (src/ui internal).
 * No DOM, no registry: everything here is unit-testable with plain data.
 */

export interface NameValidationContext {
  /** Names already present in the target directory (files AND folders). */
  siblings: Iterable<string>;
  /** For renames: the entry's current name — colliding with itself is fine. */
  current?: string;
}

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** Returns an error message, or null when the name is usable. */
export function validateName(name: string, ctx: NameValidationContext): string | null {
  if (name.length === 0) return "name required";
  if (name !== name.trim()) return "no leading/trailing whitespace";
  if (name === "." || name === "..") return "reserved name";
  if (name.includes("/") || name.includes("\\")) return "no slashes in names";
  if (CONTROL_CHARS.test(name)) return "control characters not allowed";
  if (ctx.current !== undefined && name === ctx.current) return null;
  for (const s of ctx.siblings) if (s === name) return `"${name}" already exists here`;
  return null;
}

/** Immediate child entry names of `dir`, derived from a full path listing. */
export function childNames(allPaths: readonly string[], dir: string): string[] {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  const names = new Set<string>();
  for (const p of allPaths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const i = rest.indexOf("/");
    const name = i === -1 ? rest : rest.slice(0, i);
    if (name) names.add(name);
  }
  return [...names];
}

/** How many entries live under `dir` (recursively), for delete confirmations. */
export function countDescendants(allPaths: readonly string[], dir: string): number {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  let n = 0;
  for (const p of allPaths) if (p.startsWith(prefix) && p !== prefix) n++;
  return n;
}

/**
 * After `mv(from, to)` (where `from` may be a directory), remap a dependent
 * path. Returns the new path, or null when `path` is unaffected.
 */
export function remapPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return null;
}

/**
 * Selection range for a rename input: the stem (name without its extension),
 * so typing immediately replaces the interesting part.
 */
export function stemRange(name: string): { start: number; end: number } {
  const i = name.lastIndexOf(".");
  return { start: 0, end: i > 0 ? i : name.length };
}
