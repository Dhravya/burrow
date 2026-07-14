/**
 * Burrow src/toolchain — generated run-worker bootstrap module (CONTRACT.md §6.3).
 *
 * The bootstrap:
 *  1. pipes console.* to postMessage({type:"console"}) with pre-stringified args,
 *  2. pipes uncaught errors / unhandled rejections,
 *  3. installs the Bun.serve runtime shim + serve-request handler,
 *  4. dynamic-imports the entry blob module, then inspects its DEFAULT EXPORT:
 *     an object with a callable .fetch (Hono instance / Bun's export-default-
 *     {fetch} convention) or a bare (req)=>Response function registers on the
 *     /preview bridge exactly like Bun.serve. Multiple registrations: last
 *     wins, one warning. Finally posts {type:"exit"}.
 *
 * Registration gate: serve-requests await __handlerReady, which resolves on
 * the first registration OR when module evaluation settles — so a request
 * racing a (hot-)restarting worker queues instead of erroring.
 *
 * PORTS: Bun.serve({port}) is captured and coerced (string/0/NaN/negative ->
 * the Bun default 3000) and reported back to the host in the serve-listening
 * message so multiple concurrent sessions can each expose their own port
 * (CONTRACT.md §6.3/§6.4). A default-export handler (no Bun.serve call at
 * all) always reports port 3000, matching Bun's own default.
 *
 * String.raw so escape sequences land in the generated JS verbatim. The
 * template must not contain backticks or `${` outside the four interpolations.
 */

import { handlerShapeDetectorSource } from "./handler-shape.ts";

/**
 * Bun.serve({port}) coercion: numbers pass through, numeric strings parse,
 * anything falsy/NaN/<=0 (including port:0 / omitted / "abc") falls back to
 * Bun's own default of 3000. SELF-CONTAINED ON PURPOSE (see handler-shape.ts
 * doc comment) — bootstrap.ts embeds it verbatim via coercePortSource(), so
 * the exact function under test here is the one that runs inside the worker.
 * No outer bindings, no backticks.
 */
export function coercePort(value: unknown): number {
  var n = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 3000;
  return Math.floor(n);
}

/** The coercer as embeddable JS source (what bootstrap.ts splices into the worker). */
export function coercePortSource(): string {
  return Function.prototype.toString.call(coercePort);
}

export function makeBootstrapSource(entryBlobUrl: string): string {
  return String.raw`/* burrow run-worker bootstrap (generated) */
"use strict";
const __post = (message, transfer) => self.postMessage(message, transfer || []);
let __errored = false;

const __inspect = (value) => {
  const seen = new WeakSet();
  const go = (v, depth) => {
    if (v === null) return "null";
    const t = typeof v;
    if (t === "string") return depth === 0 ? v : JSON.stringify(v);
    if (t === "undefined") return "undefined";
    if (t === "number" || t === "boolean") return String(v);
    if (t === "bigint") return String(v) + "n";
    if (t === "symbol") return v.toString();
    if (t === "function") return "[Function: " + (v.name || "anonymous") + "]";
    if (v instanceof Error) return v.stack || (v.name + ": " + v.message);
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) {
      if (depth >= 4) return "[Array(" + v.length + ")]";
      const shown = v.slice(0, 64).map((item) => go(item, depth + 1));
      if (v.length > 64) shown.push("... " + (v.length - 64) + " more");
      return "[" + shown.join(", ") + "]";
    }
    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Map) return "Map(" + v.size + ")";
    if (v instanceof Set) return "Set(" + v.size + ")";
    if (ArrayBuffer.isView(v)) return v.constructor.name + "(" + (v.length !== undefined ? v.length : v.byteLength) + ")";
    if (v instanceof ArrayBuffer) return "ArrayBuffer(" + v.byteLength + ")";
    if (typeof Request !== "undefined" && v instanceof Request) return "Request " + v.method + " " + v.url;
    if (typeof Response !== "undefined" && v instanceof Response) return "Response " + v.status;
    if (depth >= 4) return "[Object]";
    const keys = Object.keys(v);
    const parts = keys.slice(0, 32).map((k) => k + ": " + go(v[k], depth + 1));
    if (keys.length > 32) parts.push("... " + (keys.length - 32) + " more");
    const name = v.constructor && v.constructor.name && v.constructor.name !== "Object" ? v.constructor.name + " " : "";
    return name + "{ " + parts.join(", ") + " }";
  };
  try { return go(value, 0); } catch (err) { return "[uninspectable: " + String(err) + "]"; }
};

for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...args) => __post({ type: "console", level: level, args: args.map((a) => __inspect(a)) });
}

self.addEventListener("error", (event) => {
  __errored = true;
  const error = event.error;
  __post({
    type: "error",
    kind: "uncaught",
    message: String(event.message || (error && error.message) || "uncaught error"),
    stack: error && error.stack ? String(error.stack) : undefined,
  });
  if (event.preventDefault) event.preventDefault();
});

self.addEventListener("unhandledrejection", (event) => {
  __errored = true;
  const reason = event.reason;
  const isError = reason instanceof Error;
  __post({
    type: "error",
    kind: "unhandled-rejection",
    message: isError ? reason.message : __inspect(reason),
    stack: isError && reason.stack ? String(reason.stack) : undefined,
  });
  if (event.preventDefault) event.preventDefault();
});

let __fetchHandler = null;
let __server = null;
let __handlerSource = null;
let __warnedMultipleHandlers = false;
let __resolveHandlerReady;
const __handlerReady = new Promise((resolve) => { __resolveHandlerReady = resolve; });

const __detectHandlerShape = ${handlerShapeDetectorSource()};
const __coercePort = ${coercePortSource()};

function __makeServer(port) {
  if (__server === null) {
    __server = {
      port: port,
      hostname: "burrow",
      development: true,
      stop() { __fetchHandler = null; },
      reload(next) { if (next && typeof next.fetch === "function") __fetchHandler = next.fetch; },
    };
  } else {
    __server.port = port;
  }
  return __server;
}

/**
 * Every server shape funnels here. Last registration wins for WHICH handler
 * answers requests; the port reported to the host is the FIRST registration's
 * (matches Bun: the first Bun.serve() call in a script is the one you'd print
 * a URL for) — later calls only ever arrive synchronously before that first
 * postMessage in practice, so this keeps a single, stable serve-listening.
 */
function __registerFetchHandler(fn, source, port) {
  if (__fetchHandler !== null && !__warnedMultipleHandlers) {
    __warnedMultipleHandlers = true;
    console.warn(
      "burrow: multiple fetch handlers registered (" + __handlerSource + ", then " + source + ") — last one wins",
    );
  }
  const first = __fetchHandler === null;
  __fetchHandler = fn;
  __handlerSource = source;
  __makeServer(port);
  if (first) __post({ type: "serve-listening", port: port });
  __resolveHandlerReady();
}

function __burrowServe(options) {
  if (!options || typeof options.fetch !== "function") {
    throw new TypeError("burrow: Bun.serve requires options.fetch (routes are not supported in the sandbox yet)");
  }
  const port = __coercePort(options.port);
  __registerFetchHandler(options.fetch, "Bun.serve()", port);
  return __makeServer(port);
}

// The burrow:serve / bun shim module routes through this channel — always
// available, even where globalThis.Bun cannot be overwritten.
globalThis.__burrowServe = __burrowServe;

// Node-compat globals many packages touch without importing: global and a
// minimal process (the node:process shim upgrades this to the full object the
// first time it is imported). Both are best-effort — a frozen global is fine.
try { if (typeof globalThis.global === "undefined") globalThis.global = globalThis; } catch (_e) {}
try {
  if (typeof globalThis.process === "undefined") {
    globalThis.process = {
      env: {}, argv: ["burrow", "script"], platform: "browser", arch: "wasm",
      version: "v20.0.0-burrow", versions: { node: "20.0.0" },
      nextTick: (fn) => queueMicrotask(fn), cwd: () => "/workspace",
      on: () => {}, once: () => {}, off: () => {},
    };
  }
} catch (_e) {}

// Also expose the Bun global so user code using Bun.serve(...) directly works.
// In a browser worker Bun is undefined (plain assignment is enough); guard the
// case where a host already froze the global (e.g. running under real Bun).
const __bunGlobal = { env: {}, version: "burrow-wasm", serve: __burrowServe };
try {
  globalThis.Bun = __bunGlobal;
} catch (_assignErr) {
  try {
    Object.defineProperty(globalThis, "Bun", { value: __bunGlobal, configurable: true, writable: true });
  } catch (_defineErr) {
    /* frozen host global — import-based serve still works via __burrowServe */
  }
}

self.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg || msg.type !== "serve-request" || !msg.request) return;
  const r = msg.request;
  let response;
  try {
    // Queue requests that race module (re-)evaluation: resolves on the first
    // handler registration or once top-level evaluation settles.
    await __handlerReady;
    if (!__fetchHandler) {
      throw new Error("no fetch handler is registered — call Bun.serve() or use 'export default app'");
    }
    const init = { method: r.method, headers: r.headers };
    if (r.body && r.method !== "GET" && r.method !== "HEAD") init.body = r.body;
    response = await __fetchHandler(new Request(r.url, init), __server);
    if (!(response instanceof Response)) {
      response = new Response(__inspect(response), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  } catch (err) {
    console.error(err);
    response = new Response(
      "burrow: fetch handler threw\n\n" + (err && err.stack ? err.stack : String(err)),
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  let body = null;
  try {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 0) body = new Uint8Array(buffer);
  } catch (err) {
    // body already consumed or unreadable — reply with what we have
  }
  const serialized = {
    id: r.id,
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body: body,
  };
  __post({ type: "serve-response", response: serialized }, body ? [body.buffer] : []);
});

(async () => {
  let __mod = null;
  try {
    __mod = await import(${JSON.stringify(entryBlobUrl)});
  } catch (err) {
    __errored = true;
    const isError = err instanceof Error;
    __post({
      type: "error",
      kind: "import",
      message: isError ? err.message : __inspect(err),
      stack: isError && err.stack ? String(err.stack) : undefined,
    });
  }
  // Handler-shape support: a default export that looks like a server registers
  // on the preview bridge exactly like Bun.serve (a normal Hono app just works).
  if (__mod !== null) {
    try {
      const __def = __mod.default;
      const __shape = __detectHandlerShape(__def);
      if (__shape === "fetch-object") {
        __registerFetchHandler((req, server) => __def.fetch(req, server), "default export (object with fetch)", 3000);
      } else if (__shape === "function") {
        __registerFetchHandler((req, server) => __def(req, server), "default export (function)", 3000);
      }
    } catch (err) {
      console.error(err);
    }
  }
  // No handler will ever arrive after evaluation settles — release queued requests.
  __resolveHandlerReady();
  __post({ type: "exit", code: __errored ? 1 : 0 });
})();
`;
}
