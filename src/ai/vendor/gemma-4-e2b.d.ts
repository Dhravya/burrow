/**
 * Burrow — src/ai/vendor/gemma-4-e2b.d.ts
 *
 * Hand-written types for the vendored sibling `gemma-4-e2b.js`: the
 * self-contained "Gemma-4 E2B (QAT mobile) WebGPU chat bundle" from the HF
 * space webml-community/gemma-4-webgpu-kernels. The bundle is its own
 * inference stack — a custom WebGPU runtime running hand-tuned, fused WGSL
 * kernels specialized for the Gemma-4 architecture (~250 tok/s on an M4 Max) —
 * NOT transformers.js. It streams safetensors weights from the HF Hub itself
 * and feature-detects shader-f16 / subgroups / subgroup-matrix at device
 * setup, so no env flags are needed.
 *
 * Vendored deliberately (no npm package exists). Pinned bytes:
 *   sha256 0234c0e866bfaa9623e938a7cfa7f5740cca22532cc1112dd4e8915b97f78d62
 *   (551,802 bytes, fetched 2026-07-13 from
 *   huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/resolve/main/gemma-4-e2b.js)
 * Re-vendor deliberately — there is no update channel. Only the surface
 * worker-entry.ts actually uses is typed here.
 */

export interface GemmaLoadProgressEvent {
  status: string;
  /** "bytes" = network download, "tensors" = GPU repack (races ahead of bytes). */
  kind?: "bytes" | "tensors";
  /** 0..1 within the current phase. */
  fraction?: number;
  loaded?: number;
  total?: number;
  fromCache?: boolean;
  message?: string;
}

export interface GemmaLoadOptions {
  onProgress?: (event: GemmaLoadProgressEvent) => void;
  signal?: AbortSignal;
}

export interface GemmaGenerateOptions {
  /** ALWAYS pass this — the bundle's internal default is only 512. */
  maxNewTokens?: number;
  eosTokenId?: number[];
  /** Checked between tokens only; a stuck kernel dispatch is not interruptible. */
  signal?: AbortSignal;
}

export declare class Gemma4Mobile {
  static DEFAULT_MODEL_ID: string;
  /** `model` null means DEFAULT_MODEL_ID; otherwise an HF repo id or URL. */
  static load(model: string | null, opts?: GemmaLoadOptions): Promise<Gemma4Mobile>;
  /** Compile + prime every WGSL pipeline so the first token has no shader stall. */
  warmup(): Promise<void>;
  /**
   * Yields the CUMULATIVE reply so far (not deltas). Multi-turn KV-cache reuse
   * is internal: the new prompt is diffed against the previous token prefix
   * and only the suffix is prefilled.
   */
  generate(
    messages: { role: string; content: string }[],
    opts?: GemmaGenerateOptions,
  ): AsyncIterable<{ text: string }>;
  /** Drop the KV cache / conversation state. */
  reset(): void;
  /** Release the GPUDevice + buffers. Call before loading another engine. */
  dispose(): void;
  runtime: { getRenderedShaders?(): { name: string; source: string }[] };
}

export declare const DEFAULT_MODEL_ID: string;
export declare function resolveModelRoot(modelId: string): string;
