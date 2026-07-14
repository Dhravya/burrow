/**
 * Burrow src/toolchain — run-session hot-reload state machine (headless).
 *
 * RunSessionImpl drives a real DOM Worker + buildGraph in the browser, but its
 * boot / reload / handler-registration logic is pure host-side bookkeeping. We
 * inject a fake event bus, a fake buildGraph and a controllable fake worker
 * (SessionDeps) so the two live-browser bugs this module had are pinned:
 *
 *  - BUG 1: a reload that fails to (re)register a server used to tear the old
 *    worker down first, leaving /preview/ with no handler. The swap is now
 *    graceful — the previous worker keeps serving until the new one confirms.
 *  - BUG 2: a fresh `bun run` of the same entry used to leak the previous
 *    session's VFS watcher, so one file change fired N reloads. A new run now
 *    supersedes the old, and each session keeps exactly one watcher.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BuildGraphResult, EventBus, RunnerToHostMessage } from "../contract/types.ts";
import {
  __liveSessionCountForTest,
  __resetSessionsForTest,
  activePreviewSession,
  previewServers,
  resolveSessionForPort,
  runWithDeps,
  type RunnerWorkerErrorLike,
  type RunnerWorkerLike,
  type SessionDeps,
} from "./session.ts";

const ENTRY = "/home/user/demo/server.ts";
const ENTRY2 = "/home/user/demo/other.ts";

// ---- test doubles ----------------------------------------------------------

/** Minimal typed emitter that also reports its live handler count per event. */
class TestBus implements EventBus {
  private readonly handlers = new Map<string, Set<(event: unknown) => void>>();

  on(type: string, handler: (event: never) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    const erased = handler as (event: unknown) => void;
    set.add(erased);
    return () => set!.delete(erased);
  }

  emit(type: string, event: unknown): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler(event);
  }

  count(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

class FakeWorker implements RunnerWorkerLike {
  onmessage: ((event: { data: RunnerToHostMessage }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  onerror: ((event: RunnerWorkerErrorLike) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }

  /** Deliver a worker→host message (as the browser would via onmessage). */
  send(message: RunnerToHostMessage): void {
    this.onmessage?.({ data: message });
  }
  /** Convenience: fire a serve-listening with a port (default 3000). */
  listen(port = 3000): void {
    this.send({ type: "serve-listening", port });
  }
  /** Fire a worker-level error event. */
  crash(event: RunnerWorkerErrorLike = { message: "boom" }): void {
    this.onerror?.(event);
  }
}

interface Harness {
  bus: TestBus;
  workers: FakeWorker[];
  deps: SessionDeps;
  builds: number;
}

function makeHarness(): Harness {
  const bus = new TestBus();
  const workers: FakeWorker[] = [];
  const h: Harness = {
    bus,
    workers,
    builds: 0,
    deps: {
      events: bus as unknown as EventBus,
      debounceMs: 1,
      buildGraph(entryPath: string): Promise<BuildGraphResult> {
        h.builds += 1;
        const n = h.builds;
        return Promise.resolve({
          ok: true,
          entryBlobUrl: `blob:fake/entry-${n}`,
          modules: [{ path: entryPath, blobUrl: `blob:fake/mod-${n}`, deps: {} }],
        });
      },
      makeWorker(): RunnerWorkerLike {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    },
  };
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until predicate holds (the debounce + async rebuild need a beat). */
async function waitFor(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(2);
  }
}

/** Fire a change to a watched path and wait for the reload's pending worker. */
async function editAndAwaitReload(h: Harness, before: number): Promise<void> {
  h.bus.emit("file:changed", { kind: "modified", path: ENTRY });
  await waitFor(() => h.workers.length > before);
}

// ---- tests -----------------------------------------------------------------

describe("run session — registration + hot reload", () => {
  beforeEach(() => __resetSessionsForTest());
  afterEach(() => __resetSessionsForTest());

  test("first run: serve-listening installs exactly one watcher + claims preview", async () => {
    const h = makeHarness();
    const session = await runWithDeps(ENTRY, true, h.deps);

    expect(h.workers.length).toBe(1);
    expect(session.hasServer()).toBe(false);
    expect(h.bus.count("file:changed")).toBe(0); // not watching until a server registers

    h.workers[0]!.listen();

    expect(session.hasServer()).toBe(true);
    expect(h.bus.count("file:changed")).toBe(1);
    expect(activePreviewSession()?.id).toBe(session.id);

    // A server keeps its worker after the module finishes evaluating.
    h.workers[0]!.send({ type: "exit", code: 0 });
    expect(session.hasServer()).toBe(true);
  });

  test("graceful reload: old worker keeps serving until the new one confirms", async () => {
    const h = makeHarness();
    const session = await runWithDeps(ENTRY, true, h.deps);
    h.workers[0]!.listen();
    h.workers[0]!.send({ type: "exit", code: 0 });

    await editAndAwaitReload(h, 1);
    expect(h.workers.length).toBe(2);
    // The old worker is still live while the replacement boots — no preview gap.
    expect(h.workers[0]!.terminated).toBe(false);

    h.workers[1]!.listen(); // reload confirms → promote
    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.workers[1]!.terminated).toBe(false);
    expect(session.hasServer()).toBe(true);
    expect(h.bus.count("file:changed")).toBe(1); // reload never adds a second watcher
  });

  test("BUG 1: a reload that never registers a server keeps the previous one", async () => {
    const h = makeHarness();
    const session = await runWithDeps(ENTRY, true, h.deps);
    h.workers[0]!.listen();
    h.workers[0]!.send({ type: "exit", code: 0 });

    await editAndAwaitReload(h, 1);
    expect(h.workers.length).toBe(2);

    // The reloaded module runs to completion WITHOUT registering a handler.
    h.workers[1]!.send({ type: "exit", code: 0 });

    // The original worker must still be the one serving — not torn down.
    expect(h.workers[0]!.terminated).toBe(false);
    expect(h.workers[1]!.terminated).toBe(true);
    expect(session.hasServer()).toBe(true);

    // A preview request routes to the still-registered original worker. The
    // promise stays pending (the fake never replies); swallow the teardown reject.
    const req = { id: "r1", method: "GET", url: "http://x/", headers: [], body: null };
    session.fetch(req).catch(() => {});
    const forwarded = h.workers[0]!.posted.find(
      (m) => (m as { type?: string }).type === "serve-request",
    );
    expect(forwarded).toBeDefined();
    expect(h.workers[1]!.posted.length).toBe(0);
  });

  test("BUG 1b: a reload worker that crashes keeps the previous server", async () => {
    const h = makeHarness();
    const session = await runWithDeps(ENTRY, true, h.deps);
    h.workers[0]!.listen();

    await editAndAwaitReload(h, 1);
    h.workers[1]!.crash({ message: "SyntaxError in reloaded module" });

    expect(h.workers[0]!.terminated).toBe(false);
    expect(h.workers[1]!.terminated).toBe(true);
    expect(session.hasServer()).toBe(true);
  });

  test("BUG 2: a new run of the same entry supersedes the old — one watcher", async () => {
    const h = makeHarness();
    const s1 = await runWithDeps(ENTRY, true, h.deps);
    h.workers[0]!.listen();
    expect(h.bus.count("file:changed")).toBe(1);
    expect(__liveSessionCountForTest()).toBe(1);

    // Re-run the same entry: the previous session (and its watcher) must go away.
    const s2 = await runWithDeps(ENTRY, true, h.deps);
    expect(s2.id).not.toBe(s1.id);
    expect(__liveSessionCountForTest()).toBe(1);
    expect(h.bus.count("file:changed")).toBe(0); // s1's watcher disposed; s2 not listening yet

    h.workers[1]!.listen();
    expect(h.bus.count("file:changed")).toBe(1);

    // ONE file change now fires exactly ONE reload (before the fix it fired two).
    await editAndAwaitReload(h, 2);
    await sleep(15); // give any stray second watcher a chance to also spawn
    expect(h.workers.length).toBe(3);
  });

  test("BUG 2b: four runs of the same entry never stack watchers", async () => {
    const h = makeHarness();
    for (let i = 0; i < 4; i++) {
      await runWithDeps(ENTRY, true, h.deps);
      h.workers[i]!.listen();
      expect(__liveSessionCountForTest()).toBe(1);
      expect(h.bus.count("file:changed")).toBe(1);
    }
  });

  test("stop() disposes the watcher and releases the preview slot", async () => {
    const h = makeHarness();
    const session = await runWithDeps(ENTRY, true, h.deps);
    h.workers[0]!.listen();
    expect(h.bus.count("file:changed")).toBe(1);
    expect(activePreviewSession()?.id).toBe(session.id);

    session.stop();
    expect(h.bus.count("file:changed")).toBe(0);
    expect(__liveSessionCountForTest()).toBe(0);
    expect(activePreviewSession()).toBeNull();
    expect(h.workers[0]!.terminated).toBe(true);
  });

  test("--no-hot server never watches the VFS", async () => {
    const h = makeHarness();
    const session = await runWithDeps(ENTRY, false, h.deps);
    h.workers[0]!.listen();
    expect(session.hasServer()).toBe(true);
    expect(h.bus.count("file:changed")).toBe(0);
  });
});

describe("run session — ports + previewServers (multi-port routing)", () => {
  beforeEach(() => __resetSessionsForTest());
  afterEach(() => __resetSessionsForTest());

  test("session.port is null until serve-listening, then reflects the reported port", async () => {
    const h = makeHarness();
    const session = await runWithDeps(ENTRY, true, h.deps);
    expect(session.port).toBeNull();
    h.workers[0]!.listen(); // FakeWorker.listen() defaults to port 3000
    expect(session.port).toBe(3000);
  });

  test("a non-default Bun.serve({port}) is captured verbatim", async () => {
    const h = makeHarness();
    const session = await runWithDeps(ENTRY, true, h.deps);
    h.workers[0]!.listen(5173);
    expect(session.port).toBe(5173);
  });

  test("previewServers() lists every live server with its port, oldest first", async () => {
    const h = makeHarness();
    const s1 = await runWithDeps(ENTRY, true, h.deps);
    h.workers[0]!.listen(3000);
    const s2 = await runWithDeps(ENTRY2, true, h.deps);
    h.workers[1]!.listen(4000);

    expect(previewServers()).toEqual([
      { port: 3000, sessionId: s1.id, entryPath: s1.entryPath },
      { port: 4000, sessionId: s2.id, entryPath: s2.entryPath },
    ]);
  });

  test("the previewServers() set updates when a session stops", async () => {
    const h = makeHarness();
    const s1 = await runWithDeps(ENTRY, true, h.deps);
    h.workers[0]!.listen(3000);
    const s2 = await runWithDeps(ENTRY2, true, h.deps);
    h.workers[1]!.listen(4000);

    s1.stop();
    expect(previewServers()).toEqual([{ port: 4000, sessionId: s2.id, entryPath: s2.entryPath }]);

    s2.stop();
    expect(previewServers()).toEqual([]);
  });

  test("resolveSessionForPort: explicit port picks that session, undefined falls back to active, a miss is null", async () => {
    const h = makeHarness();
    const s1 = await runWithDeps(ENTRY, true, h.deps);
    h.workers[0]!.listen(3000);
    const s2 = await runWithDeps(ENTRY2, true, h.deps);
    h.workers[1]!.listen(4000);

    expect(resolveSessionForPort(3000)?.id).toBe(s1.id);
    expect(resolveSessionForPort(4000)?.id).toBe(s2.id);
    expect(resolveSessionForPort(9999)).toBeNull();
    // The newest server to register claims the default/active session.
    expect(resolveSessionForPort(undefined)?.id).toBe(s2.id);
    expect(activePreviewSession()?.id).toBe(s2.id);
  });

  test("preview:servers fires on start, on a port-changing reload, and on stop", async () => {
    const h = makeHarness();
    const snapshots: unknown[] = [];
    h.bus.on("preview:servers", ((event: { servers: unknown }) => snapshots.push(event.servers)) as never);

    const session = await runWithDeps(ENTRY, true, h.deps);
    h.workers[0]!.listen(3000);
    expect(snapshots.at(-1)).toEqual([{ port: 3000, sessionId: session.id, entryPath: session.entryPath }]);

    await editAndAwaitReload(h, 1);
    h.workers[1]!.listen(4000); // reload confirms on a NEW port
    expect(snapshots.at(-1)).toEqual([{ port: 4000, sessionId: session.id, entryPath: session.entryPath }]);

    session.stop();
    expect(snapshots.at(-1)).toEqual([]);
  });
});
