/**
 * Burrow src/toolchain — bun.wasm singleton loader + transform ABI.
 *
 * ABI (little-endian u32s, verified):
 *   bun_wasm_alloc(len) -> ptr              // write UTF-8 source at ptr
 *   bun_wasm_transform(ptr, len, loader) -> resultPtr  // 0=js 1=jsx 2=ts 3=tsx
 *   struct at resultPtr: ok@0, payloadPtr@4, payloadLen@8, cap@12
 *   ok=1 -> payload is transpiled ESM JS; ok=0 -> UTF-8 caret diagnostics
 *   bun_wasm_result_free(resultPtr); bun_wasm_free(ptr, len)
 *
 * Memory growth invalidates cached views — always re-derive from
 * exports.memory.buffer after every call into the module.
 */

import type { BunLoader, TranspileResult } from "../contract/types.ts";
import { makeEnvProxy, makeWasi } from "./wasi-shim.ts";

const WASM_URL = "/bun.wasm";

export interface BunWasmExports {
  memory: WebAssembly.Memory;
  bun_wasm_alloc(len: number): number;
  bun_wasm_transform(ptr: number, len: number, loader: number): number;
  bun_wasm_result_free(resultPtr: number): void;
  bun_wasm_free(ptr: number, len: number): void;
  // Reactor init — this bun.wasm was linked with mimalloc's own init symbols
  // rather than a wasi `_initialize`. We call whichever the module exports.
  _initialize?(): void;
  __wasm_call_ctors?(): void;
  mi_process_init?(): void;
  mi_thread_init?(): void;
}

/**
 * Run the module's one-time init. wasip1 reactor conventions differ by linker:
 * this bun.wasm exports mimalloc's process/thread init (no wasi `_initialize`),
 * so we invoke whatever is present. Calling extras is harmless; calling none
 * would leave the allocator's heap uninitialized under load.
 */
function initializeModule(exports: BunWasmExports): void {
  exports._initialize?.();
  exports.__wasm_call_ctors?.();
  exports.mi_process_init?.();
  exports.mi_thread_init?.();
}

let wasmPromise: Promise<BunWasmExports> | null = null;

/** Idempotent: loads + _initialize()s the bun.wasm singleton. */
export function ready(): Promise<void> {
  return loadWasm().then(() => undefined);
}

function loadWasm(): Promise<BunWasmExports> {
  if (wasmPromise === null) {
    wasmPromise = fetchWasmBytes().then(instantiateBunWasm);
    // A transient failure (e.g. dev server hiccup) should not poison the singleton.
    wasmPromise.catch(() => {
      wasmPromise = null;
    });
  }
  return wasmPromise;
}

async function fetchWasmBytes(): Promise<ArrayBuffer> {
  const g = globalThis as {
    location?: unknown;
    Bun?: { file(path: string): { arrayBuffer(): Promise<ArrayBuffer> } };
  };
  if (g.location === undefined && g.Bun) {
    // bun test / server-side: read the repo-root file directly.
    return g.Bun.file("bun.wasm").arrayBuffer();
  }
  const response = await fetch(WASM_URL);
  if (!response.ok) {
    throw new Error(`[toolchain] fetching ${WASM_URL} failed: HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

/** Exported separately so tests can instantiate from raw bytes. */
export async function instantiateBunWasm(bytes: ArrayBuffer | Uint8Array): Promise<BunWasmExports> {
  const wasi = makeWasi({
    onStdout: (text) => console.log("[bun.wasm]", text),
    onStderr: (text) => console.warn("[bun.wasm]", text),
  });
  const { instance } = await WebAssembly.instantiate(bytes as ArrayBuffer, {
    wasi_snapshot_preview1: wasi.imports,
    env: makeEnvProxy(),
  } as unknown as WebAssembly.Imports);
  const exports = instance.exports as unknown as BunWasmExports;
  if (typeof exports.bun_wasm_transform !== "function" || typeof exports.bun_wasm_alloc !== "function") {
    throw new Error("[toolchain] bun.wasm is missing its transform exports — wrong wasm file?");
  }
  wasi.setMemory(exports.memory);
  initializeModule(exports);
  return exports;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Synchronous transform against an already-instantiated module. JS is single
 * threaded and there is no await between alloc and free, so calls can't
 * interleave.
 */
export function transformWith(wasm: BunWasmExports, source: string, loader: BunLoader): TranspileResult {
  const src = utf8Encoder.encode(source);
  const allocLen = Math.max(src.length, 1);
  const srcPtr = wasm.bun_wasm_alloc(allocLen);
  if (srcPtr === 0) return { ok: false, error: "bun.wasm: allocation failed" };
  // alloc may have grown memory — derive the view after it.
  new Uint8Array(wasm.memory.buffer, srcPtr, src.length).set(src);
  const resultPtr = wasm.bun_wasm_transform(srcPtr, src.length, loader);
  try {
    if (resultPtr === 0) return { ok: false, error: "bun.wasm: transform returned no result" };
    // transform may have grown memory — re-derive all views.
    const view = new DataView(wasm.memory.buffer);
    const ok = view.getUint32(resultPtr + 0, true) === 1;
    const payloadPtr = view.getUint32(resultPtr + 4, true);
    const payloadLen = view.getUint32(resultPtr + 8, true);
    const payload = utf8Decoder.decode(new Uint8Array(wasm.memory.buffer, payloadPtr, payloadLen));
    return ok ? { ok: true, code: payload } : { ok: false, error: payload };
  } finally {
    if (resultPtr !== 0) wasm.bun_wasm_result_free(resultPtr);
    wasm.bun_wasm_free(srcPtr, allocLen);
  }
}

/** Contract ToolchainAPI.transpileSource — lazy-loads the singleton. */
export async function transpileSource(source: string, loader: BunLoader): Promise<TranspileResult> {
  const wasm = await loadWasm();
  return transformWith(wasm, source, loader);
}
