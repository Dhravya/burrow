/**
 * Burrow — src/ai/ai.test.ts
 * Unit coverage for the pure pieces of the AI panel: the XSS-safe markdown
 * renderer and the worker-message routing in the controller (with a fake
 * Worker so no GPU/network is touched). The full transformers.js streaming
 * path needs a real browser + WebGPU and is verified manually.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { AI_MODEL_DEFAULT, AI_MODEL_LARGE } from "../contract/types.ts";
import type { AiWorkerResponse } from "../contract/types.ts";
import { renderMarkdown } from "./markdown.ts";
import { AI_WORKER_URL } from "./config.ts";

// ── markdown ──────────────────────────────────────────────
test("markdown escapes HTML — no injection from model output", () => {
  const html = renderMarkdown("<script>alert('x')</script> & <b>hi</b>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<b>hi</b>");
  expect(html).toContain("&lt;script&gt;");
});

test("markdown keeps standalone numbers (inline-code placeholder regression)", () => {
  const html = renderMarkdown("count to 3 then 5 then 42 items");
  expect(html).toContain("3");
  expect(html).toContain("5");
  expect(html).toContain("42");
});

test("markdown renders inline code and fenced code", () => {
  const inline = renderMarkdown("use `const x = 1` here");
  expect(inline).toContain("<code>const x = 1</code>");

  const fenced = renderMarkdown("```ts\nconst y: number = 2;\n```");
  expect(fenced).toContain('<pre class="ai-code"');
  expect(fenced).toContain('data-lang="ts"');
  expect(fenced).toContain("const y: number = 2;");
});

test("markdown treats an unterminated fence as open code (streaming)", () => {
  const html = renderMarkdown("here:\n```js\nconsole.log(1)");
  expect(html).toContain('<pre class="ai-code"');
  expect(html).toContain("console.log(1)");
});

test("markdown renders bold and bullet lists", () => {
  const html = renderMarkdown("**bold** text\n\n- one\n- two");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<ul>");
  expect(html).toContain("<li>one</li>");
});

test("markdown does not escape-break code contents with angle brackets", () => {
  const html = renderMarkdown("```tsx\n<App title={x} />\n```");
  expect(html).toContain("&lt;App title={x} /&gt;");
});

// ── controller (fake worker) ──────────────────────────────
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: AiWorkerResponse }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  constructor(
    public url: string,
    public opts?: unknown,
  ) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(message: AiWorkerResponse): void {
    this.onmessage?.({ data: message });
  }
}

const g = globalThis as unknown as { Worker: unknown };
let savedWorker: unknown;

beforeEach(() => {
  FakeWorker.instances = [];
  savedWorker = g.Worker;
  g.Worker = FakeWorker as unknown;
});
afterEach(() => {
  g.Worker = savedWorker;
});

// import after the fake-worker plumbing is defined; controller only touches
// globals lazily inside load()/generate(), so a top-level import is fine.
import { createAiController } from "./controller.ts";

test("load posts a load request and resolves on ready", async () => {
  const ctrl = createAiController();
  const progress: number[] = [];
  const p = ctrl.load(AI_MODEL_DEFAULT, (pr) => progress.push(pr.fraction));
  expect(ctrl.getState()).toBe("loading");
  const worker = FakeWorker.instances[0]!;
  expect(worker.url).toBe(AI_WORKER_URL);
  expect(worker.opts).toEqual({ type: "module" });
  expect(worker.posted[0]).toEqual({ type: "load", model: AI_MODEL_DEFAULT });

  worker.emit({ type: "progress", progress: { fraction: 0.5 } });
  worker.emit({ type: "ready" });
  await p;
  expect(ctrl.getState()).toBe("ready");
  expect(ctrl.loadedModel()).toBe(AI_MODEL_DEFAULT);
  expect(progress).toContain(0.5);
});

test("load for a second model while the first is in flight queues, resolving both", async () => {
  const ctrl = createAiController();
  const loadA = ctrl.load(AI_MODEL_DEFAULT);
  const worker = FakeWorker.instances[0]!;
  // Request a different model before the first load settles.
  const loadB = ctrl.load(AI_MODEL_LARGE);
  // Only the first load request has been posted so far.
  expect(worker.posted).toEqual([{ type: "load", model: AI_MODEL_DEFAULT }]);

  worker.emit({ type: "ready" }); // completes model A
  await loadA;
  expect(ctrl.loadedModel()).toBe(AI_MODEL_DEFAULT);

  // The queued load for model B is posted only after A settles.
  await Promise.resolve(); // let the chained .then() run
  expect(worker.posted.at(-1)).toEqual({ type: "load", model: AI_MODEL_LARGE });
  worker.emit({ type: "ready" }); // completes model B
  await loadB;
  expect(ctrl.loadedModel()).toBe(AI_MODEL_LARGE);
  expect(ctrl.getState()).toBe("ready");
});

test("generate streams tokens then resolves with the done text", async () => {
  const ctrl = createAiController();
  const load = ctrl.load(AI_MODEL_DEFAULT);
  const worker = FakeWorker.instances[0]!;
  worker.emit({ type: "ready" });
  await load;

  const deltas: string[] = [];
  const handle = ctrl.generate([{ role: "user", content: "hi" }], (d) => deltas.push(d));
  expect(ctrl.getState()).toBe("generating");
  expect(worker.posted.at(-1)).toMatchObject({ type: "generate" });

  worker.emit({ type: "token", delta: "Hel" });
  worker.emit({ type: "token", delta: "lo" });
  worker.emit({ type: "done", text: "Hello" });
  const text = await handle.done;
  expect(deltas).toEqual(["Hel", "lo"]);
  expect(text).toBe("Hello");
  expect(ctrl.getState()).toBe("ready");
});

test("cancel posts an interrupt", async () => {
  const ctrl = createAiController();
  const load = ctrl.load(AI_MODEL_DEFAULT);
  const worker = FakeWorker.instances[0]!;
  worker.emit({ type: "ready" });
  await load;

  const handle = ctrl.generate([{ role: "user", content: "hi" }], () => {});
  handle.cancel();
  expect(worker.posted.at(-1)).toEqual({ type: "interrupt" });
  // let the (rejected-less) handle settle via a done event
  worker.emit({ type: "done", text: "partial" });
  await handle.done;
});

test("generate before load rejects", async () => {
  const ctrl = createAiController();
  const handle = ctrl.generate([{ role: "user", content: "hi" }], () => {});
  await expect(handle.done).rejects.toThrow(/No model is loaded/);
});

test("a worker error during generation rejects and returns to ready", async () => {
  const ctrl = createAiController();
  const load = ctrl.load(AI_MODEL_DEFAULT);
  const worker = FakeWorker.instances[0]!;
  worker.emit({ type: "ready" });
  await load;

  const handle = ctrl.generate([{ role: "user", content: "hi" }], () => {});
  worker.emit({ type: "error", message: "kernel boom" });
  await expect(handle.done).rejects.toThrow(/kernel boom/);
  expect(ctrl.getState()).toBe("ready");
});
