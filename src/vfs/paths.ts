/**
 * Burrow — src/vfs/paths.ts
 * Minimal POSIX-style path helpers for the in-memory VFS.
 * No `node:path`: this code runs in the browser bundle.
 */

/**
 * Collapse `.`, `..`, empty segments and duplicate slashes.
 * Absolute paths stay absolute; relative paths stay relative
 * (a fully-collapsed relative path becomes ".").
 */
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== "..") {
        out.pop();
      } else if (!absolute) {
        out.push("..");
      }
      continue;
    }
    out.push(segment);
  }
  const joined = out.join("/");
  if (absolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}

/** Parent directory of a normalized path. dirname("/") === "/", dirname("/a") === "/". */
export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

/** Final segment of a normalized path. basename("/") === "/". */
export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** Join and normalize path segments. Empty segments are ignored. */
export function joinPath(...segments: string[]): string {
  const nonEmpty = segments.filter((segment) => segment.length > 0);
  if (nonEmpty.length === 0) return ".";
  return normalizePath(nonEmpty.join("/"));
}

/** True when `child` equals `parent` or lives underneath it (both normalized). */
export function isInside(parent: string, child: string): boolean {
  const p = normalizePath(parent);
  const c = normalizePath(child);
  if (p === c) return true;
  const prefix = p === "/" ? "/" : `${p}/`;
  return c.startsWith(prefix);
}
