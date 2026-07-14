/**
 * Burrow — src/vfs/seed.ts
 * Initial workspace content: a README (rendered by the editor's markdown
 * preview on first load, with ./burrow.svg proving VFS-relative images), a
 * zero-import index.ts server at the root ("bun run index.ts" → preview tab,
 * no install needed), and a small multi-file TypeScript demo project under
 * /home/user/demo that uses two esm.sh-resolvable dependencies (nanoid, hono)
 * so `bun run` exercises the whole toolchain path (graph build → esm.sh
 * rewrite → worker run → handler-shape detection → /preview bridge).
 *
 * The server example (a plain Hono app, `export default app`, no Bun.serve)
 * is authored by the toolchain builder in ../toolchain/seed-server-example.ts
 * — a self-contained data module with zero imports, handed to the seed here
 * so the demo proves the run worker's handler-shape detection end to end.
 */

import { WORKSPACE_ROOT } from "../contract/types.ts";
import { SERVER_EXAMPLE_PACKAGE_JSON, SERVER_EXAMPLE_TS } from "../toolchain/seed-server-example.ts";

export const DEMO_DIR = `${WORKSPACE_ROOT}/demo`;

const README_MD = `![burrow](./burrow.svg)

# Burrow

A whole dev machine in this browser tab. Bun's real transpiler (compiled to
WASM), a bash-like shell, git, npm packages, and a local WebGPU AI agent —
**phones home to nobody**.

## Try it right now

\`\`\`sh
bun run index.ts     # spins up a web server → watch the preview tab light up
\`\`\`

Then edit \`index.ts\` and run it again. That's the whole loop.

## What's in the box

- **shell** — a real bash-like environment in the terminal below
  (\`grep\`, \`sed\`, \`awk\`, \`jq\`, \`find\`, pipes, the works).
- **bun** — \`bun run <file>\` transpiles with Bun's actual Rust transpiler
  and runs the module graph in a worker. Servers get a live preview tab.
- **packages** — \`bun add <pkg>\` fetches real npm tarballs into
  \`node_modules\`; imports fall back to esm.sh when you skip the install.
- **git** — \`git clone/status/add/commit/log\` via isomorphic-git.
  Clone anything public: \`git clone https://github.com/Dhravya/burrow\`.
- **ai** — the agent panel on the right runs a model on *your* GPU.
  Load one and ask it to edit these files.
- **edit** — \`edit <file>\` opens anything in this editor. This README is
  rendered — hit the ✎ chip in the corner to see the raw markdown.

## More to poke at

\`\`\`sh
cd demo && bun run server.ts   # a Hono app from npm, previewed live
bun add ms                     # install a real package
git init && git add . && git commit -m "first"
\`\`\`

> Your workspace persists in this browser (IndexedDB) and survives reloads.
> \`workspace info\` shows what's stored; \`workspace reset\` gives you a fresh box.
`;

/**
 * Seed logo, referenced by the README ("![burrow](./burrow.svg)") — it proves
 * the markdown preview resolves workspace-relative images through the VFS.
 * Hand-drawn on purpose; Burrow should look like a person made it.
 */
const BURROW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="150" viewBox="0 0 520 150">
  <rect width="520" height="150" rx="10" fill="#17150f"/>
  <!-- the mound -->
  <path d="M40 118 Q 75 52 128 60 Q 168 66 178 118 Z" fill="#322b20" stroke="#f2a34c" stroke-width="2.5" stroke-linejoin="round"/>
  <!-- the hole -->
  <ellipse cx="112" cy="118" rx="30" ry="9" fill="#0c0b0a" stroke="#f2a34c" stroke-width="2"/>
  <!-- a resident, mid-thought -->
  <circle cx="112" cy="96" r="9" fill="#0c0b0a" stroke="#ffc27a" stroke-width="2"/>
  <path d="M106 90 q -2 -9 3 -12 M118 90 q 2 -9 -3 -12" fill="none" stroke="#ffc27a" stroke-width="2" stroke-linecap="round"/>
  <!-- ground -->
  <path d="M28 118 H 492" stroke="#3d3629" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 7"/>
  <text x="210" y="92" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="34" fill="#ece3d2">burrow</text>
  <text x="212" y="114" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="#7c7261">a dev machine in a browser tab · phones home to nobody</text>
</svg>
`;

/**
 * Root-level server sample: zero imports, Bun's \`export default { fetch }\`
 * shape (handler-shape.ts → "fetch-object"), so \`bun run index.ts\` from the
 * workspace root spins up a server and lights the preview tab with no
 * package.json and no install — the shortest possible path to "it runs!".
 */
const ROOT_INDEX_TS = `// try it:  bun run index.ts   ← type that in the terminal below
//
// Burrow detects the \`export default { fetch }\` server shape, runs it in a
// worker, and serves it in the preview tab (and via the port switcher).
// Edit something — the page below is yours.

const page = \`<!doctype html>
<html>
  <head>
    <style>
      body { background: #17150f; color: #ece3d2; font-family: ui-monospace, monospace;
             display: grid; place-items: center; min-height: 90vh; text-align: center; }
      h1 { color: #f2a34c; } a { color: #ffc27a; } code { color: #b3c186; }
    </style>
  </head>
  <body>
    <div>
      <h1>it runs!</h1>
      <p>this page is served by <code>index.ts</code>, from a worker, in your tab.</p>
      <p>the server clock says <b id="t">…</b></p>
      <script>
        setInterval(async () => {
          const r = await fetch("/api/time");
          document.getElementById("t").textContent = (await r.json()).now;
        }, 1000);
      </script>
    </div>
  </body>
</html>\`;

export default {
  fetch(req: Request): Response {
    const url = new URL(req.url);
    if (url.pathname === "/api/time") {
      return Response.json({ now: new Date().toLocaleTimeString() });
    }
    return new Response(page, { headers: { "content-type": "text/html" } });
  },
};
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
  [`${WORKSPACE_ROOT}/burrow.svg`]: BURROW_SVG,
  [`${WORKSPACE_ROOT}/index.ts`]: ROOT_INDEX_TS,
  [`${DEMO_DIR}/package.json`]: SERVER_EXAMPLE_PACKAGE_JSON,
  [`${DEMO_DIR}/index.ts`]: DEMO_INDEX_TS,
  [`${DEMO_DIR}/greet.ts`]: DEMO_GREET_TS,
  [`${DEMO_DIR}/server.ts`]: SERVER_EXAMPLE_TS,
};
