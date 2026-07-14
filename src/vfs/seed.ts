/**
 * Burrow — src/vfs/seed.ts
 * Initial workspace content: a README at the workspace root and a small
 * multi-file TypeScript demo project under /home/user/demo that uses two
 * esm.sh-resolvable dependencies (nanoid, hono) so `bun run` exercises the
 * whole toolchain path (graph build → esm.sh rewrite → worker run →
 * handler-shape detection → /preview bridge).
 *
 * The server example (a plain Hono app, `export default app`, no Bun.serve)
 * is authored by the toolchain builder in ../toolchain/seed-server-example.ts
 * — a self-contained data module with zero imports, handed to the seed here
 * so the demo proves the run worker's handler-shape detection end to end.
 */

import { WORKSPACE_ROOT } from "../contract/types.ts";
import { SERVER_EXAMPLE_PACKAGE_JSON, SERVER_EXAMPLE_TS } from "../toolchain/seed-server-example.ts";

export const DEMO_DIR = `${WORKSPACE_ROOT}/demo`;

const README_MD = `# Burrow

A tiny Bun-flavored dev box that lives entirely in your browser tab.

- **Shell** — a real bash-like environment (grep, sed, awk, jq, find, …).
- **bun** — \`bun run <file>\` transpiles with Bun's actual Rust transpiler
  (compiled to WASM) and runs the module graph in a worker.
- **packages** — \`bun install\` / \`bun add <pkg>\` fetch real npm tarballs
  into \`node_modules\` (writes \`burrow-lock.json\`); imports resolve from
  \`node_modules\` first, then fall back to esm.sh.
- **git** — \`git clone/status/add/commit/log\` via isomorphic-git.
- **edit** — \`edit <file>\` opens it in the editor pane.

## Try it

\`\`\`sh
cd demo
bun run index.ts     # run the demo project
bun add ms           # install a real npm package into node_modules
bun run server.ts    # a Hono app (export default) — then open the preview pane
git init && git add . && git commit -m "first"
\`\`\`

Your workspace is saved in this browser (IndexedDB) and survives reloads.
\`workspace info\` shows what's stored; \`workspace reset\` gives you a fresh box.
`;

const DEMO_INDEX_TS = `import { nanoid } from "nanoid";
import { greet } from "./greet.ts";

console.log(greet("Burrow"));
console.log("fresh session id:", nanoid());
`;

const DEMO_GREET_TS = `export function greet(name: string): string {
  return \`Hello, \${name}! Edit me, then \\\`bun run index.ts\\\` again.\`;
}
`;

export const SEED_FILES: Record<string, string> = {
  [`${WORKSPACE_ROOT}/README.md`]: README_MD,
  [`${DEMO_DIR}/package.json`]: SERVER_EXAMPLE_PACKAGE_JSON,
  [`${DEMO_DIR}/index.ts`]: DEMO_INDEX_TS,
  [`${DEMO_DIR}/greet.ts`]: DEMO_GREET_TS,
  [`${DEMO_DIR}/server.ts`]: SERVER_EXAMPLE_TS,
};
