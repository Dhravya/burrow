/**
 * Burrow — dev server (src/ui owns this file).
 * Contract §9: Bun.serve on DEV_PORT, HTML import of index.html, git proxy,
 * sw.js + bun.wasm static routes, /preview/* fallback (real preview is
 * served client-side by the service worker).
 */
import index from "./index.html";
import { handleGitProxy } from "./src/git/proxy.ts";
import { DEV_PORT } from "./src/contract/types.ts";
import { AI_WORKER_URL } from "./src/ai/config.ts";
import { buildAiWorker } from "./src/ai/build-worker.ts";

Bun.serve({
  port: DEV_PORT,
  routes: {
    "/": index,
    "/git-proxy/*": (req: Request) => handleGitProxy(req),
    "/sw.js": () =>
      new Response(Bun.file("public/sw.js"), {
        headers: { "content-type": "text/javascript" },
      }),
    // Bundled AI worker (transformers.js + onnxruntime inlined). Built lazily on
    // first request, so nothing model-related is bundled until the user loads a
    // model. See src/ai/build-worker.ts.
    [AI_WORKER_URL]: async () =>
      new Response(await buildAiWorker(), {
        headers: { "content-type": "text/javascript" },
      }),
    "/bun.wasm": () =>
      new Response(Bun.file("bun.wasm"), {
        headers: { "content-type": "application/wasm" },
      }),
    "/preview/*": () =>
      new Response("preview is served by the service worker — open the app first", {
        status: 503,
      }),
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`burrow → http://localhost:${DEV_PORT}`);
