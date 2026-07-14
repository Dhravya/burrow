/**
 * Burrow — src/ai/worker-entry.ts
 *
 * The AI worker, as a real bundler entrypoint. `Bun.build`
 * (src/ai/build-worker.ts) bundles this file — pulling @huggingface/transformers
 * and its onnxruntime-web / onnxruntime-common deps *inline* — into a single
 * self-contained ESM served at AI_WORKER_URL. Because those deps are bundled,
 * the browser never has to resolve transformers' bare `onnxruntime-web/webgpu`
 * import specifier, which is exactly what broke the old load-from-CDN approach.
 *
 * TWO ENGINES behind the SAME AiWorkerRequest/AiWorkerResponse protocol:
 *  - AI_MODEL_DEFAULT (Qwen3) runs on transformers.js + onnxruntime-web,
 *    exactly as before: device "webgpu", dtype q4f16.
 *  - AI_MODEL_LARGE (Gemma 4 E2B) runs on the vendored WebGPU-kernel bundle
 *    (./vendor/gemma-4-e2b.js): a custom runtime with hand-tuned, fused WGSL
 *    kernels specialized for the Gemma-4 architecture (~250 tok/s on an M4
 *    Max). The bundle streams safetensors from the HF Hub itself and
 *    feature-detects shader-f16/subgroups on its own — no env flags needed.
 * Each engine requests its own GPUDevice, so the previous engine is ALWAYS
 * disposed before loading the other — two live 2 GB+ models would exhaust
 * most adapters.
 *
 * Laziness: this module (and therefore the static engine imports) only
 * evaluates when the controller constructs the Worker, which happens on the
 * user's first "Load model" click. Nothing here runs at page load.
 *
 * onnxruntime-web fetches its wasm runtime from cdn.jsdelivr.net by default, so
 * the actual model + kernel bytes are still downloaded on demand, not bundled.
 */

import {
  InterruptableStoppingCriteria,
  pipeline,
  TextStreamer,
} from "@huggingface/transformers";
import { Gemma4Mobile } from "./vendor/gemma-4-e2b.js";
import { AI_MODEL_DEFAULT, AI_MODEL_LARGE } from "../contract/types.ts";
import type { AiWorkerRequest, AiWorkerResponse, ChatMessage } from "../contract/types.ts";

// ── typed views over the worker global + the transformers surface we use ──────
// Structural, cast at the boundary — avoids wrestling transformers' generics
// while keeping every call site checked.
type WorkerScope = {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: AiWorkerRequest }) => void) | null;
};
interface Stopper {
  interrupt(): void;
  reset(): void;
}
interface GenOutput {
  generated_text: string | { role: string; content: string }[];
}
type Generator = ((messages: ChatMessage[], options: Record<string, unknown>) => Promise<GenOutput[]>) & {
  tokenizer: unknown;
  dispose(): Promise<void>;
};
interface RawProgress {
  status: string;
  file?: string;
  /** 0..100 on "progress" / "progress_total" events. */
  progress?: number;
  loaded?: number;
  total?: number;
}

const scope = self as unknown as WorkerScope;
const post = (message: AiWorkerResponse): void => scope.postMessage(message);
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message || String(error) : String(error);

// Exactly one of these is non-null once a model is loaded.
let pipelinePromise: Promise<Generator> | null = null; // transformers engine (Qwen3)
let gemmaPromise: Promise<Gemma4Mobile> | null = null; // WGSL-kernel engine (Gemma 4)
let loadedModelId: string | null = null;
let stopper: Stopper | null = null; // transformers interrupt
let gemmaAbort: AbortController | null = null; // gemma interrupt (checked between tokens)
let busy = false;

/**
 * Free the previous engine's GPU memory before pulling in another one.
 * onnxruntime-web and the Gemma runtime each own a full GPUDevice — switching
 * without disposing leaks the old model's buffers until the worker dies.
 */
async function disposePrevious(): Promise<void> {
  if (pipelinePromise !== null) {
    const previous = pipelinePromise;
    pipelinePromise = null;
    try {
      await (await previous).dispose();
    } catch {
      // the previous pipeline never finished loading — nothing to free
    }
  }
  if (gemmaPromise !== null) {
    const previous = gemmaPromise;
    gemmaPromise = null;
    try {
      (await previous).dispose();
    } catch {
      // the previous model never finished loading — nothing to free
    }
  }
  loadedModelId = null;
}

async function loadTransformers(model: string): Promise<void> {
  let lastFraction = 0;
  const options: Record<string, unknown> = {
    device: "webgpu", // ALWAYS explicit — the in-browser default is wasm
    progress_callback: (p: RawProgress) => {
      if (p.status === "progress_total") {
        // The ONE overall bar (per-file "progress" events interleave and jump).
        lastFraction = (p.progress ?? 0) / 100;
        post({
          type: "progress",
          progress: { fraction: lastFraction, loadedBytes: p.loaded, totalBytes: p.total },
        });
      } else if ((p.status === "initiate" || p.status === "download") && p.file) {
        // Detail-only update: keep the last fraction so the bar stays monotonic.
        post({ type: "progress", progress: { fraction: lastFraction, detail: p.file } });
      }
    },
  };
  if (model === AI_MODEL_DEFAULT) options.dtype = "q4f16";

  pipelinePromise = pipeline("text-generation", model, options) as unknown as Promise<Generator>;
  await pipelinePromise;
}

async function loadGemma(model: string): Promise<void> {
  // Progress rule mirrors the upstream space: drive the bar off weight
  // download events with kind === "bytes" ONLY — "tensors" (GPU repack)
  // events race ahead of the download and would make the bar jump around.
  // Everything else is a detail-only update at the last known fraction.
  let lastFraction = 0;
  gemmaPromise = (async () => {
    const gemma = await Gemma4Mobile.load(model, {
      onProgress: (e) => {
        if (e.status === "weights" && (e.kind ?? "bytes") === "bytes" && Number.isFinite(e.fraction)) {
          lastFraction = 0.04 + 0.96 * (e.fraction ?? 0);
          post({
            type: "progress",
            progress: { fraction: lastFraction, loadedBytes: e.loaded, totalBytes: e.total },
          });
        } else {
          post({ type: "progress", progress: { fraction: lastFraction, detail: e.message ?? e.status } });
        }
      },
    });
    // Compile + prime every WGSL pipeline before reporting ready, so the
    // first real token isn't hit by shader-compilation stalls.
    await gemma.warmup();
    return gemma;
  })();
  await gemmaPromise;
}

async function handleLoad(model: string): Promise<void> {
  if (loadedModelId === model && (pipelinePromise !== null || gemmaPromise !== null)) {
    await (pipelinePromise ?? gemmaPromise); // idempotent per model
    post({ type: "ready" });
    return;
  }

  await disposePrevious();

  loadedModelId = model;
  try {
    if (model === AI_MODEL_LARGE) await loadGemma(model);
    else await loadTransformers(model);
  } catch (error) {
    pipelinePromise = null;
    gemmaPromise = null;
    loadedModelId = null;
    throw error;
  }
  post({ type: "ready" });
}

async function generateTransformers(
  generator: Generator,
  messages: ChatMessage[],
  maxNewTokens: number,
): Promise<void> {
  stopper ??= new InterruptableStoppingCriteria() as unknown as Stopper;
  stopper.reset();
  const streamer = new TextStreamer(generator.tokenizer as never, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (delta: string) => post({ type: "token", delta }),
  });
  const output = await generator(messages, {
    max_new_tokens: maxNewTokens,
    do_sample: false,
    streamer,
    stopping_criteria: stopper,
  });
  const generated = output[0]?.generated_text;
  const text =
    typeof generated === "string" ? generated : (generated?.[generated.length - 1]?.content ?? "");
  post({ type: "done", text });
}

async function generateGemma(
  gemma: Gemma4Mobile,
  messages: ChatMessage[],
  maxNewTokens: number,
): Promise<void> {
  // generate() yields the CUMULATIVE reply so far, not deltas — slice off what
  // was already posted. ALWAYS pass maxNewTokens: the bundle's own default is
  // only 512. Multi-turn KV-cache reuse is internal (prompt-prefix diffing).
  const ac = new AbortController();
  gemmaAbort = ac;
  let prev = "";
  try {
    for await (const { text } of gemma.generate(messages, { maxNewTokens, signal: ac.signal })) {
      post({ type: "token", delta: text.slice(prev.length) });
      prev = text;
    }
  } catch (error) {
    // An "interrupt" lands here as an abort — a normal stop, not a failure.
    // Fall through to "done" with the partial text, like the transformers path.
    if (!ac.signal.aborted) throw error;
  } finally {
    gemmaAbort = null;
  }
  post({ type: "done", text: prev });
}

async function handleGenerate(messages: ChatMessage[], maxNewTokens: number): Promise<void> {
  if (pipelinePromise === null && gemmaPromise === null) {
    post({ type: "error", message: "No model is loaded yet." });
    return;
  }
  if (busy) {
    post({ type: "error", message: "Already generating — stop the current reply first." });
    return;
  }
  busy = true;
  try {
    if (gemmaPromise !== null) {
      await generateGemma(await gemmaPromise, messages, maxNewTokens);
    } else if (pipelinePromise !== null) {
      await generateTransformers(await pipelinePromise, messages, maxNewTokens);
    }
  } catch (error) {
    post({ type: "error", message: errorText(error) });
  } finally {
    busy = false;
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case "load":
      handleLoad(message.model).catch((error: unknown) => post({ type: "error", message: errorText(error) }));
      break;
    case "generate":
      void handleGenerate(message.messages, message.maxNewTokens ?? 1024);
      break;
    case "interrupt":
      stopper?.interrupt(); // transformers engine
      gemmaAbort?.abort(); // gemma engine
      break;
  }
};
