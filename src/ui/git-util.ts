/** Burrow — repo discovery helpers shared by diff panel + statusbar (src/ui internal). */

/** Directories that contain a `.git` entry, deepest first (for nearest-root matching). */
export function findRepoRoots(paths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const p of paths) {
    const m = /^(.+?)\/\.git(\/|$)/.exec(p);
    if (m?.[1]) roots.add(m[1]);
  }
  return [...roots].sort((a, b) => b.length - a.length);
}

/** Nearest repo root containing `path`, or null. */
export function repoRootFor(path: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    if (path === root || path.startsWith(`${root}/`)) return root;
  }
  return null;
}
