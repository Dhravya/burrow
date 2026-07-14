/**
 * Burrow src/toolchain — tiny posix path helpers + loader mapping.
 * No node:path in the browser bundle; the VFS is posix-only.
 */

import type { BunLoader } from "../contract/types.ts";

export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else {
      out.push(part);
    }
  }
  if (absolute) return "/" + out.join("/");
  return out.join("/") || ".";
}

export function dirname(path: string): string {
  const norm = normalizePath(path);
  const idx = norm.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return norm.slice(0, idx);
}

export function joinPath(base: string, ...parts: string[]): string {
  return normalizePath([base, ...parts].join("/"));
}

const LOADER_BY_EXT: Record<string, BunLoader> = {
  js: 0,
  mjs: 0,
  cjs: 0,
  jsx: 1,
  ts: 2,
  mts: 2,
  cts: 2,
  tsx: 3,
};

/** .js→0 .jsx→1 .ts/.mts/.cts→2 .tsx→3 (default 2 for extensionless). */
export function loaderForPath(path: string): BunLoader {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return 2;
  return LOADER_BY_EXT[base.slice(dot + 1).toLowerCase()] ?? 2;
}
