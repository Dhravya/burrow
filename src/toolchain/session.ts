/**
 * Burrow src/toolchain — run sessions (CONTRACT.md §6.3).
 *
 * run(entry):
 *   1. emit run:started,
 *   2. buildGraph(entry) on the page (bun.wasm singleton),
 *   3. spawn ONE dedicated module Worker booted from a generated bootstrap
 *      blob that imports the entry's blob module,
 *   4. relay RunnerEvents to subscribers (buffered for late ones), resolve
 *      preview fetch()es by request id, emit preview:ready / run:ended.
 *
 * A build failure still yields a RunSession — it replays the BuildErrors as
 * {type:"error"} events + an {type:"exit",code:1} so the `bun` command renders
 * them exactly like a runtime failure.
 *
 * HOT RELOAD (default on; `bun run --no-hot` opts out): once a session's
 * worker registers a fetch handler (Bun.serve OR a server-shaped default
 * export), the session watches the VFS. When a path that participated in the
 * last build changes (module graph + ancestor package.jsons — see hot.ts),
 * changes are debounced 200 ms and the graph is rebuilt.
 *
 * The swap is GRACEFUL: the rebuilt graph boots in a *pending* worker while the
 * old worker keeps serving. Only when the pending worker confirms it registered
 * a handler (serve-listening) is the old worker torn down and the new one
 * promoted — the exact same registration path the first run takes. A reload
 * whose worker never starts a server (rebuild error, import throw, or a default
 * export that isn't server-shaped) is discarded and the previous worker keeps
 * serving. The session object, its id and its "server live" state survive every
 * reload. Non-server runs never watch.
 */

import { tryUse, use } from "../contract/registry.ts";
import { WORKSPACE_ROOT } from "../contract/types.ts";
import type {
  BuildError,
  BuildGraphResult,
  EventBus,
  PreviewServer,
  RunnerEvent,
  RunOptions,
  RunSession,
  RunnerToHostMessage,
  SerializedRequest,
  SerializedResponse,
} from "../contract/types.ts";
import { makeBootstrapSource } from "./bootstrap.ts";
import { buildGraph } from "./graph.ts";
import { collectWatchedPaths, createHotDebouncer, type HotDebouncer } from "./hot.ts";
import { joinPath, normalizePath } from "./paths.ts";

/** Quiet period between the last watched file change and the reload. */
export const HOT_DEBOUNCE_MS = 200;

/** Extra options understood by this module (superset of the contract RunOptions). */
export interface InternalRunOptions extends RunOptions {
  /** Watch the module graph and restart the server worker on change. Default true. */
  hot?: boolean;
}

/**
 * The subset of the Worker surface a run session drives. The real DOM Worker
 * satisfies it structurally; tests inject a controllable fake (see SessionDeps).
 */
export interface RunnerWorkerLike {
  onmessage: ((event: { data: RunnerToHostMessage }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  onerror: ((event: RunnerWorkerErrorLike) => void) | null;
  postMessage(message: unknown, transfer?: unknown[]): void;
  terminate(): void;
}

/** The fields of a worker-level ErrorEvent the session reads. */
export interface RunnerWorkerErrorLike {
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  preventDefault?: () => void;
}

/**
 * The impure dependencies of a run session. Production wires the registry event
 * bus, the real buildGraph and a DOM Worker; tests inject fakes so the whole
 * boot/reload/handler-registration state machine runs headlessly.
 */
export interface SessionDeps {
  events: EventBus;
  buildGraph(entryPath: string): Promise<BuildGraphResult>;
  makeWorker(bootstrapUrl: string): RunnerWorkerLike;
  /** Debounce window for the VFS watcher; defaults to HOT_DEBOUNCE_MS. */
  debounceMs?: number;
}

// Module-level session registry ------------------------------------------------

const liveSessions = new Set<RunSessionImpl>();
let activePreview: RunSessionImpl | null = null;

/** The session whose Bun.serve currently backs bare /preview/* (latest serve-listening wins). */
export function activePreviewSession(): RunSession | null {
  return activePreview;
}

/** Every live `/preview/<port>/` target, oldest first (liveSessions is insertion-ordered). */
export function previewServers(): PreviewServer[] {
  const servers: PreviewServer[] = [];
  for (const session of liveSessions) {
    if (session.hasServer() && session.port !== null) {
      servers.push({ port: session.port, sessionId: session.id, entryPath: session.entryPath });
    }
  }
  return servers;
}

/**
 * Resolve a preview request's target session: an explicit port picks the
 * session bound to it (or null if nothing is listening there); no port falls
 * back to the active/default session, exactly like the bare /preview/ route.
 */
export function resolveSessionForPort(port: number | undefined): RunSession | null {
  if (port === undefined) return activePreview;
  for (const session of liveSessions) {
    if (session.hasServer() && session.port === port) return session;
  }
  return null;
}

/** Terminate every live session. */
export function stopAll(): void {
  for (const session of [...liveSessions]) session.stop();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function workspaceRelative(path: string): string {
  const prefix = `${WORKSPACE_ROOT}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Minimal terminal line (dim), best-effort — the shell may not be up in tests. */
function shellPrint(line: string): void {
  try {
    tryUse("shell")?.print(`\x1b[2m${line}\x1b[0m\r\n`);
  } catch {
    /* shell unavailable — console pane still gets the event */
  }
}

// -----------------------------------------------------------------------------

class RunSessionImpl implements RunSession {
  readonly id: string = crypto.randomUUID();
  readonly entryPath: string;
  /** Bound by Bun.serve's port (or 3000 default); null until serve-listening fires. */
  port: number | null = null;

  private readonly hot: boolean;
  private readonly deps: SessionDeps;

  private worker: RunnerWorkerLike | null = null;
  private readonly buffer: RunnerEvent[] = [];
  private readonly handlers = new Set<(event: RunnerEvent) => void>();
  private readonly pending = new Map<
    string,
    { resolve: (r: SerializedResponse) => void; reject: (e: Error) => void }
  >();

  private serverListening = false;
  private exitDispatched = false;
  private finalized = false;
  private exitCode = 0;

  /** Blobs backing the ACTIVE worker's graph — revoked on stop / on promote. */
  private ownedBlobUrls: string[] = [];

  // ---- hot reload state ----
  private watchedPaths: Set<string> = new Set();
  private unwatch: (() => void) | null = null;
  private debouncer: HotDebouncer | null = null;
  private reloadGeneration = 0;
  /**
   * A reload's rebuilt graph boots here and keeps the old worker serving until
   * it confirms registration. Promoted (→ worker) on serve-listening, discarded
   * on exit/error without registration.
   */
  private pendingWorker: RunnerWorkerLike | null = null;
  private pendingBlobUrls: string[] = [];
  private pendingWatchedPaths: Set<string> = new Set();
  /** Metadata for the in-flight reload (for the "[hot] reloaded"/failed lines). */
  private pendingReload: { startedAt: number; changed: string[] } | null = null;

  constructor(entryPath: string, hot: boolean, deps: SessionDeps) {
    this.entryPath = entryPath;
    this.hot = hot;
    this.deps = deps;
  }

  // ---- event fan-out ----

  private dispatch(event: RunnerEvent): void {
    this.buffer.push(event);
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (error) {
        console.error("[toolchain] run-session subscriber threw", error);
      }
    }
  }

  onEvent(handler: (event: RunnerEvent) => void): () => void {
    for (const event of this.buffer) {
      try {
        handler(event);
      } catch (error) {
        console.error("[toolchain] run-session subscriber threw", error);
      }
    }
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  hasServer(): boolean {
    return this.serverListening;
  }

  // ---- lifecycle ----

  /** Wire the worker + kick off the build. Resolves the outer run() promise. */
  async boot(): Promise<void> {
    this.deps.events.emit("run:started", { sessionId: this.id, entryPath: this.entryPath });

    let build;
    try {
      build = await this.deps.buildGraph(this.entryPath);
    } catch (error) {
      this.reportBuildErrors([{ path: this.entryPath, message: errorMessage(error) }]);
      return;
    }
    if (this.finalized) {
      // stop() raced in before the build finished — drop the freshly minted blobs.
      if (build.ok) for (const mod of build.modules) URL.revokeObjectURL(mod.blobUrl);
      return;
    }
    if (!build.ok) {
      this.reportBuildErrors(build.errors);
      return;
    }

    this.watchedPaths = collectWatchedPaths(build.modules.map((mod) => mod.path));
    this.ownedBlobUrls = build.modules.map((mod) => mod.blobUrl);
    this.spawnWorker(build.entryBlobUrl, "active");
  }

  /**
   * Mint the bootstrap blob for entryBlobUrl and boot a worker from it. The
   * "active" role is the first run's serving worker; a "pending" worker is a
   * reload's replacement that only takes over once it registers.
   */
  private spawnWorker(entryBlobUrl: string, role: "active" | "pending"): void {
    const bootstrapSource = makeBootstrapSource(entryBlobUrl);
    const bootstrapUrl = URL.createObjectURL(new Blob([bootstrapSource], { type: "text/javascript" }));
    if (role === "active") this.ownedBlobUrls.push(bootstrapUrl);
    else this.pendingBlobUrls.push(bootstrapUrl);

    let worker: RunnerWorkerLike;
    try {
      worker = this.deps.makeWorker(bootstrapUrl);
    } catch (error) {
      if (role === "pending") {
        // A reload that can't even start a worker leaves the previous one serving.
        const changed = this.pendingReload?.changed.join(", ") ?? "";
        this.pendingReload = null;
        this.discardPendingWorker();
        const line = `[hot] reload could not start a worker (${errorMessage(error)}; changed: ${changed}) — keeping the previous server`;
        this.dispatch({ type: "console", level: "warn", args: [line] });
        shellPrint(line);
        return;
      }
      this.dispatch({ type: "error", kind: "import", message: `failed to start run worker: ${errorMessage(error)}` });
      this.dispatchExit(1);
      return;
    }

    if (role === "active") this.worker = worker;
    else this.pendingWorker = worker;

    worker.onmessage = (event) => this.onWorkerMessage(event.data, worker);
    worker.onmessageerror = () => {
      this.dispatch({ type: "error", kind: "uncaught", message: "run worker received an unstructured message" });
    };
    worker.onerror = (event) => this.onWorkerError(worker, event);
  }

  private reportBuildErrors(errors: BuildError[]): void {
    for (const error of errors) {
      this.dispatch({ type: "error", kind: "import", message: `${error.path}: ${error.message}` });
    }
    this.dispatchExit(1);
  }

  private onWorkerMessage(message: RunnerToHostMessage, source: RunnerWorkerLike): void {
    // Ignore stragglers from a worker we've already torn down.
    if (source !== this.worker && source !== this.pendingWorker) return;
    switch (message.type) {
      case "console":
      case "error":
        this.dispatch(message);
        return;
      case "serve-listening":
        this.onServerListening(source, message.port);
        return;
      case "exit":
        this.onWorkerExit(message.code, source);
        return;
      case "serve-response": {
        if (source !== this.worker) return; // only the active worker answers preview requests
        const waiter = this.pending.get(message.response.id);
        if (waiter) {
          this.pending.delete(message.response.id);
          waiter.resolve(message.response);
        }
        return;
      }
    }
  }

  private onWorkerError(source: RunnerWorkerLike, event: RunnerWorkerErrorLike): void {
    // A worker-level error (e.g. the bootstrap itself failed to parse).
    event.preventDefault?.();
    const errorEvent: RunnerEvent = {
      type: "error",
      kind: "uncaught",
      message: event.message || "run worker error",
      stack: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    };
    if (source === this.pendingWorker) {
      // A reload's worker crashed before registering — keep the previous server.
      const changed = this.pendingReload?.changed.join(", ") ?? "";
      this.pendingReload = null;
      this.dispatch(errorEvent);
      this.discardPendingWorker();
      const line = `[hot] reload worker crashed (changed: ${changed}) — keeping the previous server`;
      this.dispatch({ type: "console", level: "warn", args: [line] });
      shellPrint(line);
      return;
    }
    if (source !== this.worker) return;
    this.dispatch(errorEvent);
    this.dispatchExit(1);
  }

  // ---- hot reload ----

  private startWatching(): void {
    if (!this.hot || this.unwatch !== null || this.finalized) return;
    this.debouncer = createHotDebouncer({
      delayMs: this.deps.debounceMs ?? HOT_DEBOUNCE_MS,
      onFire: (paths) => {
        void this.reload(paths);
      },
    });
    this.unwatch = this.deps.events.on("file:changed", (event) => {
      // Watch the currently-serving graph AND an in-flight reload's graph, so a
      // rapid second edit that only touches a new file still triggers a rebuild.
      if (this.watchedPaths.has(event.path) || this.pendingWatchedPaths.has(event.path)) {
        this.debouncer?.notify(event.path);
      }
    });
  }

  private stopWatching(): void {
    this.unwatch?.();
    this.unwatch = null;
    this.debouncer?.dispose();
    this.debouncer = null;
  }

  /**
   * Rebuild the graph and boot a *pending* worker; the old worker keeps serving
   * until the pending one registers (promoteReloadedWorker). A failed rebuild or
   * a worker that never starts a server leaves the running one untouched.
   */
  private async reload(changedPaths: string[]): Promise<void> {
    if (this.finalized) return;
    const generation = ++this.reloadGeneration;
    const startedAt = now();
    const changed = changedPaths.map(workspaceRelative);
    // Supersede any earlier reload whose worker hasn't taken over yet.
    this.discardPendingWorker();

    let build: BuildGraphResult;
    try {
      build = await this.deps.buildGraph(this.entryPath);
    } catch (error) {
      build = { ok: false, errors: [{ path: this.entryPath, message: errorMessage(error) }] };
    }

    if (this.finalized || generation !== this.reloadGeneration) {
      // stop() or a newer reload superseded this one — drop the fresh blobs.
      if (build.ok) for (const mod of build.modules) URL.revokeObjectURL(mod.blobUrl);
      return;
    }

    if (!build.ok) {
      for (const error of build.errors) {
        this.dispatch({ type: "error", kind: "import", message: `${error.path}: ${error.message}` });
      }
      const line = `[hot] rebuild failed (changed: ${changed.join(", ")}) — previous server still live`;
      this.dispatch({ type: "console", level: "warn", args: [line] });
      shellPrint(line);
      return;
    }

    // Boot the rebuilt graph alongside the still-serving old worker. Promotion /
    // teardown happens in onServerListening / onWorkerExit once it registers.
    this.pendingWatchedPaths = collectWatchedPaths(build.modules.map((mod) => mod.path));
    this.pendingBlobUrls = build.modules.map((mod) => mod.blobUrl);
    this.pendingReload = { startedAt, changed };
    this.spawnWorker(build.entryBlobUrl, "pending");
  }

  /**
   * A worker announced a fetch handler. The active worker's first announcement
   * is the initial registration; a pending (reload) worker's announcement means
   * the replacement is live, so promote it over the old worker. Both funnel
   * through markServerActive — the one shared post-registration path.
   */
  private onServerListening(source: RunnerWorkerLike, port: number): void {
    if (source === this.pendingWorker) {
      this.promoteReloadedWorker(port);
      return;
    }
    if (source !== this.worker) return;
    const firstListen = !this.serverListening;
    this.serverListening = true;
    this.port = port;
    if (firstListen) {
      this.dispatch({ type: "serve-listening", port });
      this.startWatching();
      this.notifyPreviewServersChanged();
    }
    this.markServerActive(firstListen);
  }

  /** Swap the confirmed reload worker in for the old one — the graceful part. */
  private promoteReloadedWorker(port: number): void {
    const next = this.pendingWorker;
    if (next === null) return;
    const info = this.pendingReload;
    const portChanged = this.port !== port;

    // Tear down the OLD worker now that its replacement is confirmed serving.
    this.terminateWorker(this.worker);
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error("hot reload swapped in a fresh server while this request was in flight — retry"));
    }
    this.pending.clear();
    for (const url of this.ownedBlobUrls) URL.revokeObjectURL(url);

    // Adopt the pending worker + its graph as the active one.
    this.worker = next;
    this.pendingWorker = null;
    this.ownedBlobUrls = this.pendingBlobUrls;
    this.pendingBlobUrls = [];
    this.watchedPaths = this.pendingWatchedPaths;
    this.pendingWatchedPaths = new Set();
    this.pendingReload = null;
    this.port = port;

    this.markServerActive(false);
    if (portChanged) this.notifyPreviewServersChanged();
    if (info) {
      const ms = Math.max(1, Math.round(now() - info.startedAt));
      const line = `[hot] reloaded in ${ms}ms (changed: ${info.changed.join(", ")})`;
      this.dispatch({ type: "console", level: "info", args: [line] });
      shellPrint(line);
    }
  }

  /** Recompute + broadcast the live `/preview/<port>/` set (start/stop/reload-port-change). */
  private notifyPreviewServersChanged(): void {
    this.deps.events.emit("preview:servers", { servers: previewServers() });
  }

  /**
   * The one shared "a server is now serving on this session" step: claim the
   * preview slot (a brand-new server always claims; a reload keeps it unless a
   * newer session took over) and announce readiness.
   */
  private markServerActive(claim: boolean): void {
    if (claim || activePreview === null || activePreview === this) activePreview = this;
    if (activePreview === this) this.deps.events.emit("preview:ready", { sessionId: this.id });
  }

  private onWorkerExit(code: number, source: RunnerWorkerLike): void {
    if (source === this.pendingWorker) {
      // The reloaded module ran to completion WITHOUT registering a handler —
      // keep the previous worker serving instead of dropping the server.
      const changed = this.pendingReload?.changed.join(", ") ?? "";
      this.pendingReload = null;
      this.discardPendingWorker();
      const line = `[hot] reload finished without starting a server (changed: ${changed}) — keeping the previous one`;
      this.dispatch({ type: "console", level: "warn", args: [line] });
      shellPrint(line);
      return;
    }
    if (source !== this.worker) return;
    this.dispatchExit(code);
  }

  private terminateWorker(worker: RunnerWorkerLike | null): void {
    if (worker === null) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }

  /** Kill an un-promoted reload worker and free its graph's blobs. */
  private discardPendingWorker(): void {
    this.terminateWorker(this.pendingWorker);
    this.pendingWorker = null;
    for (const url of this.pendingBlobUrls) URL.revokeObjectURL(url);
    this.pendingBlobUrls = [];
    this.pendingWatchedPaths = new Set();
  }

  /**
   * Surface the terminal "exit" event once. A server keeps its worker alive
   * afterwards (it must still answer preview requests); a plain script is
   * finalized immediately.
   */
  private dispatchExit(code: number): void {
    this.exitCode = code;
    if (this.exitDispatched) {
      if (!this.serverListening) this.finalize();
      return;
    }
    this.exitDispatched = true;
    this.dispatch({ type: "exit", code });
    if (!this.serverListening) this.finalize();
  }

  fetch(request: SerializedRequest): Promise<SerializedResponse> {
    if (!this.serverListening || this.worker === null) {
      return Promise.reject(new Error("this run session is not serving (Bun.serve was never called)"));
    }
    const worker = this.worker;
    return new Promise<SerializedResponse>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      const transfer = request.body ? [request.body.buffer as ArrayBuffer] : [];
      try {
        worker.postMessage({ type: "serve-request", request }, transfer);
      } catch (error) {
        this.pending.delete(request.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  stop(): void {
    if (this.finalized) return;
    if (!this.exitDispatched) {
      this.exitDispatched = true;
      this.dispatch({ type: "exit", code: this.exitCode });
    }
    this.finalize();
  }

  private finalize(): void {
    if (this.finalized) return;
    this.finalized = true;

    this.stopWatching();
    this.pendingReload = null;
    this.reloadGeneration++; // invalidate any in-flight reload build
    this.discardPendingWorker();

    for (const waiter of this.pending.values()) {
      waiter.reject(new Error("run session ended before the request was answered"));
    }
    this.pending.clear();

    this.terminateWorker(this.worker);
    this.worker = null;

    for (const url of this.ownedBlobUrls) URL.revokeObjectURL(url);
    this.ownedBlobUrls = [];

    const wasServing = this.serverListening;
    this.serverListening = false;
    this.port = null;

    liveSessions.delete(this);
    if (activePreview === this) activePreview = null;

    if (wasServing) this.notifyPreviewServersChanged();
    this.deps.events.emit("run:ended", { sessionId: this.id, exitCode: this.exitCode });
  }
}

const defaultMakeWorker = (bootstrapUrl: string): RunnerWorkerLike =>
  new Worker(bootstrapUrl, { type: "module" }) as unknown as RunnerWorkerLike;

function prodDeps(): SessionDeps {
  return { events: use("events"), buildGraph, makeWorker: defaultMakeWorker };
}

/**
 * Start a session with explicit dependencies. Shared by run() (production deps)
 * and the headless tests (injected fakes) so the reload/registration state
 * machine and the "a new run of the same entry supersedes the old one" rule are
 * exercised through the exact same code path.
 */
export async function runWithDeps(entryPath: string, hot: boolean, deps: SessionDeps): Promise<RunSessionImpl> {
  const resolved = entryPath.startsWith("/") ? normalizePath(entryPath) : joinPath(WORKSPACE_ROOT, entryPath);
  // A fresh run of the same entry replaces the previous one — otherwise the old
  // session's VFS watcher lingers and every file change fires N reloads.
  for (const session of [...liveSessions]) {
    if (session.entryPath === resolved) session.stop();
  }
  const session = new RunSessionImpl(resolved, hot, deps);
  liveSessions.add(session);
  await session.boot();
  return session;
}

/** buildGraph + spawn a dedicated module Worker. Emits run:started on the bus. */
export async function run(entryPath: string, options?: InternalRunOptions): Promise<RunSession> {
  return runWithDeps(entryPath, options?.hot ?? true, prodDeps());
}

/** Test-only: current live-session count (watchers included). */
export function __liveSessionCountForTest(): number {
  return liveSessions.size;
}

/** Test-only: reset the module-level session registry between cases. */
export function __resetSessionsForTest(): void {
  for (const session of [...liveSessions]) session.stop();
  liveSessions.clear();
  activePreview = null;
}

export type { RunSessionImpl };
