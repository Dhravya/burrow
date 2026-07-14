/**
 * Burrow — src/ai/build-worker.ts  (server side; never imported by the browser)
 *
 * Bundles the AI worker entrypoint (worker-entry.ts) into one self-contained
 * ESM string. @huggingface/transformers + onnxruntime-web/-common get bundled
 * in (the Qwen engine), as does the vendored Gemma WebGPU-kernel bundle
 * (src/ai/vendor/gemma-4-e2b.js — already import-free, it inlines cleanly), so
 * the served worker has no bare import specifiers for the browser to choke on.
 * server.ts serves the result at AI_WORKER_URL; build.ts writes it into the
 * static outdir.
 *
 * The build is lazy + cached: nothing is bundled until the worker asset is
 * first requested (i.e. the user's first "Load model" click fetches it).
 */

import { fileURLToPath } from "node:url";

const WORKER_ENTRY = fileURLToPath(new URL("./worker-entry.ts", import.meta.url));

let cached: Promise<string> | null = null;

export function buildAiWorker(): Promise<string> {
  cached ??= (async () => {
    const result = await Bun.build({
      entrypoints: [WORKER_ENTRY],
      target: "browser",
      format: "esm",
      minify: true,
    });
    if (!result.success) {
      cached = null; // allow a retry on the next request
      throw new AggregateError(result.logs, "failed to bundle the AI worker");
    }
    return result.outputs[0]!.text();
  })();
  return cached;
}
