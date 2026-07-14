/**
 * Burrow — production bundle check / static build.
 *
 * The CLI `bun build` cannot apply bundler plugins (bun docs: "plugins are
 * only supported through Bun.build's API or through bunfig.toml with the
 * frontend dev server"), and just-bash's browser bundle statically imports
 * node:zlib — so bundling MUST go through this script, which applies the same
 * shim plugin the dev server gets from bunfig.toml [serve.static].
 *
 * Usage: bun run build.ts [outdir]   (default ./dist)
 *
 * The output is a self-contained static site (/sw.js and /bun.wasm are copied
 * in below), except git clone/push over HTTP: the app calls /git-proxy/* to
 * dodge CORS, which needs a server-side handler on the host (the dev server
 * provides one via src/git/proxy.ts; any CORS proxy will do in production).
 */
import burrowShims from "./src/ui/build-plugins.ts";
import { AI_WORKER_URL } from "./src/ai/config.ts";
import { buildAiWorker } from "./src/ai/build-worker.ts";

const outdir = process.argv[2] ?? "./dist";

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir,
  target: "browser",
  plugins: [burrowShims],
  sourcemap: "linked",
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The AI worker is fetched at runtime from AI_WORKER_URL, so index.html's graph
// never references it — emit it alongside the page for static deploys.
const workerCode = await buildAiWorker();
const workerPath = `${outdir}${AI_WORKER_URL}`;
await Bun.write(workerPath, workerCode);

// Runtime assets fetched by URL (never in index.html's module graph): the
// service worker and the Bun transpiler WASM. The dev server serves these from
// routes; a static deploy needs them at the site root.
const staticAssets = ["public/sw.js", "bun.wasm"] as const;
const copied: Array<{ path: string; size: number }> = [];
for (const src of staticAssets) {
  const file = Bun.file(src);
  const dest = `${outdir}/${src.split("/").pop()}`;
  await Bun.write(dest, file);
  copied.push({ path: dest, size: file.size });
}

for (const artifact of result.outputs) {
  console.log(`${artifact.path}  (${(artifact.size / 1024).toFixed(1)} KB)`);
}
console.log(`${workerPath}  (${(workerCode.length / 1024).toFixed(1)} KB)`);
for (const { path, size } of copied) {
  console.log(`${path}  (${(size / 1024).toFixed(1)} KB)`);
}
