/**
 * Burrow — src/ai/controller.ts
 *
 * The AiPanelAPI implementation: a thin, stateful controller in front of the
 * transformers.js worker (bundled from worker-entry.ts, served at
 * AI_WORKER_URL). It owns the worker lifecycle, the AiState machine, and the
 * request/response plumbing described by AiWorkerRequest / AiWorkerResponse in
 * the contract.
 *
 * The worker is created lazily on the first load() and reused across model
 * switches (the worker disposes the old pipeline before loading a new one).
 */

import { AI_MODEL_DEFAULT } from "../contract/types.ts";
import type {
  AiGenerationHandle,
  AiLoadProgress,
  AiModelId,
  AiPanelAPI,
  AiState,
  AiWorkerRequest,
  AiWorkerResponse,
  ChatMessage,
} from "../contract/types.ts";
import { AI_WORKER_URL } from "./config.ts";

/** AiPanelAPI plus the extras the in-module panel needs (state subscription). */
export interface AiController extends AiPanelAPI {
  /** The model currently loaded (or loading), or null before any load(). */
  loadedModel(): AiModelId | null;
  /** Subscribe to AiState transitions; returns an unsubscribe. */
  onStateChange(handler: (state: AiState) => void): () => void;
  /** Terminate the worker and reset to idle/unsupported. */
  dispose(): void;
}

interface PendingLoad {
  model: AiModelId;
  onProgress?: (p: AiLoadProgress) => void;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingGen {
  priority: "interactive" | "background";
  messages: ChatMessage[];
  maxNewTokens?: number;
  onDelta: (delta: string) => void;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  accumulated: string;
  settled: boolean;
  cancelled: boolean;
  preempted: boolean;
}

export function createAiController(): AiController {
  let worker: Worker | null = null;
  let state: AiState = "idle";
  let loaded: AiModelId | null = null;
  let webgpuChecked = false;
  let webgpuOk = false;

  let pendingLoad: PendingLoad | null = null;
  let activeGen: PendingGen | null = null;
  let queuedInteractive: PendingGen | null = null;

  const stateHandlers = new Set<(s: AiState) => void>();

  const setState = (next: AiState): void => {
    if (next === state) return;
    state = next;
    for (const handler of stateHandlers) {
      try {
        handler(next);
      } catch (error) {
        console.error("[ai] state handler threw", error);
      }
    }
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    // A same-origin module worker: the bundle (transformers + onnxruntime) is
    // built and served by the dev server / static build at AI_WORKER_URL.
    const w = new Worker(AI_WORKER_URL, { type: "module" });
    w.onmessage = (event: MessageEvent<AiWorkerResponse>) => handleMessage(event.data);
    w.onerror = (event) => {
      const message = event.message || "AI worker crashed";
      failPending(new Error(message));
      setState("error");
    };
    worker = w;
    return w;
  };

  const failPending = (error: Error): void => {
    if (pendingLoad) {
      const p = pendingLoad;
      pendingLoad = null;
      p.reject(error);
    }
    if (activeGen) rejectGen(activeGen, error);
    if (queuedInteractive) rejectGen(queuedInteractive, error);
    activeGen = null;
    queuedInteractive = null;
  };

  const resolveGen = (gen: PendingGen, text: string): void => {
    if (gen.settled) return;
    gen.settled = true;
    gen.resolve(text);
  };

  const rejectGen = (gen: PendingGen, error: Error): void => {
    if (gen.settled) return;
    gen.settled = true;
    gen.reject(error);
  };

  const startGeneration = (gen: PendingGen): void => {
    activeGen = gen;
    if (gen.priority === "interactive") setState("generating");
    ensureWorker().postMessage({
      type: "generate",
      messages: gen.messages,
      maxNewTokens: gen.maxNewTokens,
    } satisfies AiWorkerRequest);
  };

  const finishActive = (result: { text: string } | { error: Error }): void => {
    const gen = activeGen;
    if (!gen) return;
    activeGen = null;
    if ("error" in result) rejectGen(gen, result.error);
    else if (gen.preempted) rejectGen(gen, new Error("Background generation was preempted by the agent."));
    else resolveGen(gen, result.text || gen.accumulated);

    const next = queuedInteractive;
    queuedInteractive = null;
    if (next && !next.cancelled) {
      startGeneration(next);
      return;
    }
    if (state === "generating") setState(loaded ? "ready" : "error");
  };

  const handleMessage = (msg: AiWorkerResponse): void => {
    switch (msg.type) {
      case "progress":
        pendingLoad?.onProgress?.(msg.progress);
        break;
      case "ready":
        if (pendingLoad) {
          const p = pendingLoad;
          pendingLoad = null;
          loaded = p.model;
          setState("ready");
          p.resolve();
        }
        break;
      case "token":
        if (activeGen && !activeGen.preempted && !activeGen.settled) {
          activeGen.accumulated += msg.delta;
          activeGen.onDelta(msg.delta);
        }
        break;
      case "done":
        finishActive({ text: msg.text });
        break;
      case "error": {
        const error = new Error(msg.message || "AI worker error");
        if (pendingLoad) {
          const p = pendingLoad;
          pendingLoad = null;
          setState("error");
          p.reject(error);
        } else if (activeGen) {
          finishActive({ error });
        } else {
          setState("error");
        }
        break;
      }
    }
  };

  const post = (request: AiWorkerRequest): void => {
    ensureWorker().postMessage(request);
  };

  const api: AiController = {
    getState(): AiState {
      return state;
    },

    async webgpuSupported(): Promise<boolean> {
      if (webgpuChecked) return webgpuOk;
      webgpuChecked = true;
      // Structural type — avoids a hard dependency on @webgpu/types.
      const gpu = (
        navigator as unknown as {
          gpu?: { requestAdapter(opts?: { powerPreference?: string }): Promise<unknown | null> };
        }
      ).gpu;
      if (!gpu) {
        webgpuOk = false;
        if (state === "idle") setState("unsupported");
        return false;
      }
      try {
        const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
        webgpuOk = adapter != null;
      } catch {
        webgpuOk = false;
      }
      if (!webgpuOk && state === "idle") setState("unsupported");
      return webgpuOk;
    },

    load(model: AiModelId = AI_MODEL_DEFAULT, onProgress?: (p: AiLoadProgress) => void): Promise<void> {
      // Idempotent: already loaded and no other load in flight.
      if (loaded === model && !pendingLoad && state !== "loading") {
        return Promise.resolve();
      }
      // A load for the same model is already running — piggyback on it.
      if (pendingLoad && pendingLoad.model === model) {
        const existing = pendingLoad;
        return new Promise<void>((resolve, reject) => {
          const prevResolve = existing.resolve;
          const prevReject = existing.reject;
          existing.resolve = () => {
            prevResolve();
            resolve();
          };
          existing.reject = (e) => {
            prevReject(e);
            reject(e);
          };
          if (onProgress) {
            const prevProgress = existing.onProgress;
            existing.onProgress = (p) => {
              prevProgress?.(p);
              onProgress(p);
            };
          }
        });
      }
      // A load for a DIFFERENT model is in flight — queue behind it. Starting a
      // second load now would overwrite pendingLoad (orphaning the first
      // promise) and mis-attribute the worker's next "ready" to this model.
      if (pendingLoad) {
        const current = pendingLoad;
        const currentSettled = new Promise<void>((resolve) => {
          const prevResolve = current.resolve;
          const prevReject = current.reject;
          current.resolve = () => {
            prevResolve();
            resolve();
          };
          current.reject = (e) => {
            prevReject(e);
            // Even if the first load failed, still attempt the requested one.
            resolve();
          };
        });
        return currentSettled.then(() => api.load(model, onProgress));
      }

      setState("loading");
      return new Promise<void>((resolve, reject) => {
        pendingLoad = { model, onProgress, resolve, reject };
        post({ type: "load", model });
      });
    },

    generate(
      messages: ChatMessage[],
      onDelta: (delta: string) => void,
      options?: { maxNewTokens?: number; priority?: "interactive" | "background" },
    ): AiGenerationHandle {
      let settle!: (text: string) => void;
      let fail!: (error: Error) => void;
      const done = new Promise<string>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });

      if (!worker || loaded == null) {
        fail(new Error("No model is loaded — click Load model first."));
        return { cancel: () => {}, done };
      }
      const gen: PendingGen = {
        priority: options?.priority ?? "interactive",
        messages,
        maxNewTokens: options?.maxNewTokens,
        onDelta,
        resolve: settle,
        reject: fail,
        accumulated: "",
        settled: false,
        cancelled: false,
        preempted: false,
      };

      const handle: AiGenerationHandle = {
        cancel: () => {
          if (gen.cancelled || gen.settled) return;
          gen.cancelled = true;
          if (activeGen === gen) {
            if (worker) post({ type: "interrupt" });
          } else if (queuedInteractive === gen) {
            queuedInteractive = null;
            resolveGen(gen, "");
            if (state === "generating") setState(loaded ? "ready" : "error");
          }
        },
        done,
      };

      if (gen.priority === "background") {
        if (state !== "ready" || activeGen || queuedInteractive) {
          fail(new Error("AI is busy — background suggestion skipped."));
          return handle;
        }
        startGeneration(gen);
        return handle;
      }

      if (queuedInteractive || activeGen?.priority === "interactive") {
        fail(new Error("Already generating — stop the current reply first."));
        return handle;
      }

      if (activeGen?.priority === "background") {
        queuedInteractive = gen;
        setState("generating");
        activeGen.preempted = true;
        rejectGen(activeGen, new Error("Background generation was preempted by the agent."));
        post({ type: "interrupt" });
      } else {
        startGeneration(gen);
      }
      return handle;
    },

    loadedModel(): AiModelId | null {
      return loaded;
    },

    onStateChange(handler: (s: AiState) => void): () => void {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },

    dispose(): void {
      failPending(new Error("AI panel disposed"));
      if (worker) {
        worker.terminate();
        worker = null;
      }
      loaded = null;
      setState("idle");
    },
  };

  return api;
}
