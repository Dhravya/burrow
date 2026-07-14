/**
 * Burrow src/toolchain — Node builtin module shims.
 *
 * The run-worker executes each module as a blob: ESM. When user code (or a
 * VFS-installed dependency's CJS facade) imports `node:fs` / `fs` / `events`
 * etc., the resolver (graph.ts) redirects the specifier to one of these blob
 * modules instead of failing.
 *
 * Support levels:
 *  - full : a real browser implementation (path, url, events, util, process,
 *           buffer, stream, crypto, os, querystring, assert, timers, …).
 *  - net  : mapped onto fetch()/web APIs (http/https client, zlib streams).
 *  - stub : import succeeds; calling the impossible-in-a-worker parts throws a
 *           precise, actionable error (fs/child_process/net/tls/…). Real sync
 *           fs arrives with the SharedArrayBuffer bridge; real subprocesses are
 *           the Linux VM tab's job.
 *
 * IMPORTANT (authoring): every source below is emitted verbatim into a blob and
 * must be self-contained (a blob module cannot bare-import another builtin —
 * that would hit the network). Keep the sources free of backtick template
 * literals and `${...}` so this file's String.raw wrappers stay clean; use
 * string concatenation for any runtime interpolation instead.
 */

export type BuiltinSupport = "full" | "net" | "stub";

interface BuiltinModule {
  support: BuiltinSupport;
  source: string;
}

const cache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Shared source fragments (inlined into each self-contained module)
// ---------------------------------------------------------------------------

const EVENT_EMITTER = String.raw`
class EventEmitter {
  constructor() { this._events = Object.create(null); this._max = 10; }
  setMaxListeners(n) { this._max = n; return this; }
  getMaxListeners() { return this._max; }
  _list(type) { return this._events[type] || (this._events[type] = []); }
  on(type, fn) { this.emit("newListener", type, fn); this._list(type).push(fn); return this; }
  addListener(type, fn) { return this.on(type, fn); }
  prependListener(type, fn) { this._list(type).unshift(fn); return this; }
  once(type, fn) {
    const self = this;
    function g() { self.off(type, g); return fn.apply(this, arguments); }
    g.listener = fn; return this.on(type, g);
  }
  prependOnceListener(type, fn) {
    const self = this;
    function g() { self.off(type, g); return fn.apply(this, arguments); }
    g.listener = fn; return this.prependListener(type, g);
  }
  off(type, fn) {
    const l = this._events[type]; if (!l) return this;
    const i = l.findIndex((f) => f === fn || f.listener === fn);
    if (i >= 0) { l.splice(i, 1); this.emit("removeListener", type, fn); }
    return this;
  }
  removeListener(type, fn) { return this.off(type, fn); }
  removeAllListeners(type) { if (type === undefined) this._events = Object.create(null); else delete this._events[type]; return this; }
  listeners(type) { return (this._events[type] || []).slice(); }
  rawListeners(type) { return (this._events[type] || []).slice(); }
  listenerCount(type) { return (this._events[type] || []).length; }
  eventNames() { return Object.keys(this._events); }
  emit(type) {
    const l = this._events[type];
    const args = Array.prototype.slice.call(arguments, 1);
    if (!l || l.length === 0) {
      if (type === "error") { const e = args[0]; throw (e instanceof Error ? e : new Error("Unhandled error." + (e ? " (" + e + ")" : ""))); }
      return false;
    }
    for (const fn of l.slice()) fn.apply(this, args);
    return true;
  }
}
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.defaultMaxListeners = 10;
EventEmitter.once = function (ee, name) {
  return new Promise((resolve, reject) => {
    const ok = (...a) => { ee.off("error", err); resolve(a); };
    const err = (e) => { ee.off(name, ok); reject(e); };
    ee.once(name, ok); if (name !== "error") ee.once("error", err);
  });
};
EventEmitter.on = function (ee, name) {
  const q = []; let done = false; const pend = [];
  ee.on(name, (...a) => { if (pend.length) pend.shift().resolve({ value: a, done: false }); else q.push(a); });
  return { [Symbol.asyncIterator]() { return this; },
    next() { if (q.length) return Promise.resolve({ value: q.shift(), done: false });
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => pend.push({ resolve })); },
    return() { done = true; return Promise.resolve({ value: undefined, done: true }); } };
};
`;

// ---------------------------------------------------------------------------
// Module sources
// ---------------------------------------------------------------------------

const MODULES: Record<string, BuiltinModule> = {
  events: {
    support: "full",
    source: String.raw`${EVENT_EMITTER}
export default EventEmitter;
export { EventEmitter };
export const once = EventEmitter.once;
export const on = EventEmitter.on;
export const defaultMaxListeners = 10;
`,
  },

  path: {
    support: "full",
    source: String.raw`
function assertPath(p) { if (typeof p !== "string") throw new TypeError("Path must be a string. Received " + JSON.stringify(p)); }
function normalizeArray(parts, allowAbove) {
  const res = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") { if (res.length && res[res.length - 1] !== "..") res.pop(); else if (allowAbove) res.push(".."); }
    else res.push(p);
  }
  return res;
}
const sep = "/";
const delimiter = ":";
function normalize(path) {
  assertPath(path);
  if (path.length === 0) return ".";
  const abs = path.charCodeAt(0) === 47;
  const trailing = path.charCodeAt(path.length - 1) === 47;
  let n = normalizeArray(path.split("/"), !abs).join("/");
  if (!n && !abs) n = ".";
  if (n && trailing) n += "/";
  return (abs ? "/" : "") + n;
}
function join() {
  const args = Array.prototype.slice.call(arguments).filter((a) => { assertPath(a); return a.length > 0; });
  if (args.length === 0) return ".";
  return normalize(args.join("/"));
}
function resolve() {
  let resolved = ""; let abs = false;
  for (let i = arguments.length - 1; i >= -1 && !abs; i--) {
    const p = i >= 0 ? arguments[i] : (typeof process !== "undefined" && process.cwd ? process.cwd() : "/");
    assertPath(p); if (!p) continue;
    resolved = p + "/" + resolved; abs = p.charCodeAt(0) === 47;
  }
  const n = normalizeArray(resolved.split("/"), !abs).join("/");
  return abs ? "/" + n : (n || ".");
}
function isAbsolute(p) { assertPath(p); return p.length > 0 && p.charCodeAt(0) === 47; }
function dirname(p) {
  assertPath(p); if (p.length === 0) return ".";
  let end = -1, matched = false;
  for (let i = p.length - 1; i >= 1; i--) { if (p.charCodeAt(i) === 47) { if (matched) { end = i; break; } } else matched = true; }
  if (end === -1) return p.charCodeAt(0) === 47 ? "/" : ".";
  return p.slice(0, end);
}
function basename(p, ext) {
  assertPath(p);
  let start = 0, end = p.length;
  for (let i = p.length - 1; i >= 0; i--) { if (p.charCodeAt(i) === 47) { start = i + 1; break; } if (i === 0) start = 0; }
  let base = p.slice(start, end);
  if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, base.length - ext.length);
  return base;
}
function extname(p) {
  assertPath(p);
  const b = basename(p); const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i);
}
function parse(p) {
  assertPath(p);
  const root = isAbsolute(p) ? "/" : "";
  const dir = dirname(p); const base = basename(p); const ext = extname(p);
  return { root, dir: dir === "." && !root ? "" : dir, base, ext, name: ext ? base.slice(0, base.length - ext.length) : base };
}
function format(o) {
  const dir = o.dir || o.root || "";
  const base = o.base || ((o.name || "") + (o.ext || ""));
  if (!dir) return base;
  return dir === o.root ? dir + base : dir + "/" + base;
}
function relative(from, to) {
  from = resolve(from); to = resolve(to);
  if (from === to) return "";
  const fp = from.split("/").filter(Boolean); const tp = to.split("/").filter(Boolean);
  let i = 0; while (i < fp.length && i < tp.length && fp[i] === tp[i]) i++;
  const up = fp.slice(i).map(() => "..");
  return up.concat(tp.slice(i)).join("/");
}
function toNamespacedPath(p) { return p; }
const posix = { sep, delimiter, normalize, join, resolve, isAbsolute, dirname, basename, extname, parse, format, relative, toNamespacedPath };
posix.posix = posix; posix.win32 = posix;
export default posix;
export { sep, delimiter, normalize, join, resolve, isAbsolute, dirname, basename, extname, parse, format, relative, toNamespacedPath, posix };
export const win32 = posix;
`,
  },

  url: {
    support: "full",
    source: String.raw`
const URL_ = globalThis.URL;
const URLSearchParams_ = globalThis.URLSearchParams;
function fileURLToPath(u) {
  const s = typeof u === "string" ? u : u.href;
  if (!s.startsWith("file://")) throw new TypeError("The URL must be of scheme file");
  let p = decodeURIComponent(new URL_(s).pathname);
  return p;
}
function pathToFileURL(p) {
  const abs = p.charCodeAt(0) === 47 ? p : "/" + p;
  return new URL_("file://" + encodeURI(abs).replace(/[?#]/g, (c) => "%" + c.charCodeAt(0).toString(16)));
}
function parse(urlStr, parseQuery) {
  try {
    const u = new URL_(urlStr, "http://localhost");
    const query = parseQuery ? Object.fromEntries(u.searchParams) : u.search.replace(/^\?/, "");
    return { href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port,
      pathname: u.pathname, search: u.search, query, hash: u.hash, path: u.pathname + u.search,
      slashes: true, auth: u.username ? u.username + (u.password ? ":" + u.password : "") : null };
  } catch (e) { return { href: urlStr, pathname: urlStr, path: urlStr, query: parseQuery ? {} : "", search: "", hash: "" }; }
}
function format(u) {
  if (typeof u === "string") return u;
  if (u instanceof URL_) return u.href;
  const proto = u.protocol ? (u.protocol.endsWith(":") ? u.protocol : u.protocol + ":") : "";
  const host = u.host || (u.hostname || "") + (u.port ? ":" + u.port : "");
  let search = u.search || "";
  if (!search && u.query) search = "?" + (typeof u.query === "string" ? u.query : new URLSearchParams_(u.query).toString());
  return proto + (proto ? "//" : "") + host + (u.pathname || "") + search + (u.hash || "");
}
function resolve(from, to) { return new URL_(to, new URL_(from, "http://localhost")).href.replace(/^http:\/\/localhost/, ""); }
const domainToASCII = (d) => d;
const domainToUnicode = (d) => d;
const api = { URL: URL_, URLSearchParams: URLSearchParams_, fileURLToPath, pathToFileURL, parse, format, resolve, domainToASCII, domainToUnicode, Url: function Url() {} };
export default api;
export { fileURLToPath, pathToFileURL, parse, format, resolve, domainToASCII, domainToUnicode };
export const URL = URL_;
export const URLSearchParams = URLSearchParams_;
`,
  },

  querystring: {
    support: "full",
    source: String.raw`
function parse(str, sep, eq) {
  sep = sep || "&"; eq = eq || "=";
  const out = Object.create(null);
  if (!str) return out;
  for (const pair of String(str).split(sep)) {
    if (!pair) continue;
    const idx = pair.indexOf(eq);
    const k = decodeURIComponent((idx < 0 ? pair : pair.slice(0, idx)).replace(/\+/g, " "));
    const v = idx < 0 ? "" : decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, " "));
    if (out[k] === undefined) out[k] = v;
    else if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = [out[k], v];
  }
  return out;
}
function stringify(obj, sep, eq) {
  sep = sep || "&"; eq = eq || "=";
  if (!obj) return "";
  const parts = [];
  for (const k of Object.keys(obj)) {
    const ek = encodeURIComponent(k);
    const v = obj[k];
    if (Array.isArray(v)) for (const item of v) parts.push(ek + eq + encodeURIComponent(item));
    else parts.push(ek + eq + encodeURIComponent(v == null ? "" : v));
  }
  return parts.join(sep);
}
const escape = encodeURIComponent, unescape = decodeURIComponent;
const api = { parse, stringify, decode: parse, encode: stringify, escape, unescape };
export default api;
export { parse, stringify, parse as decode, stringify as encode, escape, unescape };
`,
  },

  util: {
    support: "full",
    source: String.raw`
function inherits(ctor, superCtor) {
  ctor.super_ = superCtor;
  ctor.prototype = Object.create(superCtor.prototype, { constructor: { value: ctor, enumerable: false, writable: true, configurable: true } });
}
function inspect(v, opts) {
  const seen = new WeakSet();
  const go = (x, d) => {
    if (x === null) return "null";
    const t = typeof x;
    if (t === "string") return d === 0 ? x : JSON.stringify(x);
    if (t === "function") return "[Function: " + (x.name || "anonymous") + "]";
    if (t === "bigint") return x + "n";
    if (t !== "object") return String(x);
    if (x instanceof Error) return x.stack || (x.name + ": " + x.message);
    if (seen.has(x)) return "[Circular]"; seen.add(x);
    if (Array.isArray(x)) return "[ " + x.slice(0, 100).map((i) => go(i, d + 1)).join(", ") + " ]";
    const keys = Object.keys(x);
    return "{ " + keys.slice(0, 100).map((k) => k + ": " + go(x[k], d + 1)).join(", ") + " }";
  };
  return go(v, 0);
}
function format(f) {
  const args = Array.prototype.slice.call(arguments);
  if (typeof f !== "string") return args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ");
  let i = 1;
  let out = f.replace(/%[sdifjoO%]/g, (m) => {
    if (m === "%%") return "%";
    if (i >= args.length) return m;
    const a = args[i++];
    if (m === "%s") return typeof a === "string" ? a : inspect(a);
    if (m === "%d" || m === "%i") return String(parseInt(a, 10));
    if (m === "%f") return String(parseFloat(a));
    if (m === "%j") { try { return JSON.stringify(a); } catch (e) { return "[Circular]"; } }
    return inspect(a);
  });
  for (; i < args.length; i++) out += " " + (typeof args[i] === "string" ? args[i] : inspect(args[i]));
  return out;
}
function promisify(fn) {
  return function () {
    const args = Array.prototype.slice.call(arguments);
    return new Promise((resolve, reject) => {
      args.push((err, ...rest) => (err ? reject(err) : resolve(rest.length > 1 ? rest : rest[0])));
      fn.apply(this, args);
    });
  };
}
promisify.custom = Symbol.for("nodejs.util.promisify.custom");
function callbackify(fn) {
  return function () {
    const args = Array.prototype.slice.call(arguments);
    const cb = args.pop();
    fn.apply(this, args).then((v) => cb(null, v), (e) => cb(e));
  };
}
function deprecate(fn, msg) { let warned = false; return function () { if (!warned) { warned = true; console.warn(msg); } return fn.apply(this, arguments); }; }
const types = {
  isDate: (v) => v instanceof Date, isRegExp: (v) => v instanceof RegExp,
  isNativeError: (v) => v instanceof Error, isPromise: (v) => v && typeof v.then === "function",
  isMap: (v) => v instanceof Map, isSet: (v) => v instanceof Set,
  isArrayBuffer: (v) => v instanceof ArrayBuffer, isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isUint8Array: (v) => v instanceof Uint8Array, isAnyArrayBuffer: (v) => v instanceof ArrayBuffer,
};
function isDeepStrictEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a !== a && b !== b;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => isDeepStrictEqual(a[k], b[k]));
}
const TextEncoder_ = globalThis.TextEncoder, TextDecoder_ = globalThis.TextDecoder;
const api = { inherits, inspect, format, formatWithOptions: (o, ...a) => format(...a), promisify, callbackify, deprecate, types,
  isDeepStrictEqual, debuglog: () => (() => {}), TextEncoder: TextEncoder_, TextDecoder: TextDecoder_,
  isArray: Array.isArray, isBuffer: (v) => v instanceof Uint8Array,
  isDate: types.isDate, isRegExp: types.isRegExp, isError: types.isNativeError, isFunction: (v) => typeof v === "function",
  isString: (v) => typeof v === "string", isNumber: (v) => typeof v === "number", isObject: (v) => v !== null && typeof v === "object",
  isNullOrUndefined: (v) => v == null, isNull: (v) => v === null, isUndefined: (v) => v === undefined,
  isPrimitive: (v) => v === null || (typeof v !== "object" && typeof v !== "function"), _extend: Object.assign };
inspect.custom = Symbol.for("nodejs.util.inspect.custom");
api.inspect = inspect;
export default api;
export { inherits, inspect, format, promisify, callbackify, deprecate, types, isDeepStrictEqual, TextEncoder_ as TextEncoder, TextDecoder_ as TextDecoder };
`,
  },

  assert: {
    support: "full",
    source: String.raw`
class AssertionError extends Error { constructor(o) { super(o && o.message); this.name = "AssertionError"; this.actual = o && o.actual; this.expected = o && o.expected; this.operator = o && o.operator; } }
function ok(v, msg) { if (!v) throw new AssertionError({ message: msg || (inspect(v) + " == true"), actual: v, expected: true, operator: "==" }); }
function inspect(v) { try { return typeof v === "string" ? JSON.stringify(v) : String(v); } catch (e) { return "?"; } }
function equal(a, b, msg) { if (a != b) throw new AssertionError({ message: msg || (inspect(a) + " == " + inspect(b)), actual: a, expected: b, operator: "==" }); }
function notEqual(a, b, msg) { if (a == b) throw new AssertionError({ message: msg, actual: a, expected: b, operator: "!=" }); }
function strictEqual(a, b, msg) { if (!Object.is(a, b)) throw new AssertionError({ message: msg || (inspect(a) + " === " + inspect(b)), actual: a, expected: b, operator: "===" }); }
function notStrictEqual(a, b, msg) { if (Object.is(a, b)) throw new AssertionError({ message: msg, actual: a, expected: b, operator: "!==" }); }
function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEq(a[k], b[k]));
}
function deepEqual(a, b, msg) { if (!deepEq(a, b)) throw new AssertionError({ message: msg, actual: a, expected: b, operator: "deepEqual" }); }
function deepStrictEqual(a, b, msg) { if (!deepEq(a, b)) throw new AssertionError({ message: msg, actual: a, expected: b, operator: "deepStrictEqual" }); }
function throws(fn, expected, msg) { try { fn(); } catch (e) { return; } throw new AssertionError({ message: msg || "Missing expected exception.", operator: "throws" }); }
function doesNotThrow(fn) { try { fn(); } catch (e) { throw new AssertionError({ message: "Got unwanted exception. " + e, operator: "doesNotThrow" }); } }
function fail(msg) { throw new AssertionError({ message: msg || "Failed", operator: "fail" }); }
function ifError(e) { if (e) throw e; }
async function rejects(fn) { try { await (typeof fn === "function" ? fn() : fn); } catch (e) { return; } throw new AssertionError({ message: "Missing expected rejection.", operator: "rejects" }); }
async function doesNotReject(fn) { await (typeof fn === "function" ? fn() : fn); }
const assert = ok;
Object.assign(assert, { ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual, notDeepEqual: (a, b, m) => { if (deepEq(a, b)) fail(m); }, deepStrictEqual, notDeepStrictEqual: (a, b, m) => { if (deepEq(a, b)) fail(m); }, throws, doesNotThrow, fail, ifError, rejects, doesNotReject, AssertionError });
assert.strict = assert;
export default assert;
export { ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual, deepStrictEqual, throws, doesNotThrow, fail, ifError, rejects, doesNotReject, AssertionError };
`,
  },

  process: {
    support: "full",
    source: String.raw`${EVENT_EMITTER}
const _env = (globalThis.Bun && globalThis.Bun.env) || (globalThis.process && globalThis.process.env) || {};
const emitter = new EventEmitter();
const _start = (globalThis.performance && performance.now()) || 0;
function hrtime(prev) {
  const now = ((globalThis.performance && performance.now()) || 0) * 1e6;
  const sec = Math.floor(now / 1e9); const nano = Math.floor(now % 1e9);
  if (prev) { let s = sec - prev[0], n = nano - prev[1]; if (n < 0) { s -= 1; n += 1e9; } return [s, n]; }
  return [sec, nano];
}
hrtime.bigint = () => BigInt(Math.round(((globalThis.performance && performance.now()) || 0) * 1e6));
const process = {
  env: _env, argv: ["burrow", "script"], argv0: "burrow", execPath: "/usr/bin/burrow", execArgv: [],
  platform: "browser", arch: "wasm", pid: 1, ppid: 0, title: "burrow",
  version: "v20.0.0-burrow", versions: { node: "20.0.0", v8: "0.0", burrow: "wasm" },
  cwd: () => "/workspace", chdir: () => {},
  nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  hrtime,
  exit: (code) => { emitter.emit("exit", code || 0); },
  on: (...a) => (emitter.on(...a), process), once: (...a) => (emitter.once(...a), process),
  off: (...a) => (emitter.off(...a), process), removeListener: (...a) => (emitter.off(...a), process),
  emit: (...a) => emitter.emit(...a), addListener: (...a) => (emitter.on(...a), process),
  removeAllListeners: (...a) => (emitter.removeAllListeners(...a), process), listeners: (t) => emitter.listeners(t),
  stdout: { write: (s) => { console.log(String(s).replace(/\n$/, "")); return true; }, isTTY: false, fd: 1, on: () => {}, once: () => {}, end: () => {} },
  stderr: { write: (s) => { console.error(String(s).replace(/\n$/, "")); return true; }, isTTY: false, fd: 2, on: () => {}, once: () => {}, end: () => {} },
  stdin: { on: () => {}, once: () => {}, read: () => null, resume: () => {}, pause: () => {}, isTTY: false, fd: 0, setEncoding: () => {} },
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  cpuUsage: () => ({ user: 0, system: 0 }),
  uptime: () => (((globalThis.performance && performance.now()) || 0) - _start) / 1000,
  hrtimeStart: _start, features: {}, config: {}, release: { name: "node" },
  binding: () => { throw new Error("process.binding is not supported in the Burrow sandbox"); },
  umask: () => 0, getuid: () => 0, getgid: () => 0, geteuid: () => 0, getegid: () => 0,
  emitWarning: (w) => console.warn(w), allowedNodeEnvironmentFlags: new Set(), noDeprecation: false,
};
// Upgrade any minimal bootstrap process to this full one (idempotent).
try { globalThis.process = process; } catch (e) {}
export default process;
export const env = process.env;
export const argv = process.argv;
export const platform = process.platform;
export const nextTick = process.nextTick;
export const cwd = process.cwd;
export { hrtime };
`,
  },

  os: {
    support: "full",
    source: String.raw`
const EOL = "\n";
const platform = () => "browser";
const arch = () => "wasm";
const type = () => "Browser";
const release = () => "1.0.0";
const hostname = () => "burrow";
const tmpdir = () => "/tmp";
const homedir = () => "/home/user";
const cpus = () => [{ model: "wasm", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }];
const totalmem = () => 2 * 1024 * 1024 * 1024;
const freemem = () => 1 * 1024 * 1024 * 1024;
const loadavg = () => [0, 0, 0];
const uptime = () => (globalThis.performance ? performance.now() / 1000 : 0);
const networkInterfaces = () => ({});
const userInfo = () => ({ username: "user", uid: 0, gid: 0, shell: "/bin/bash", homedir: "/home/user" });
const endianness = () => "LE";
const constants = { signals: {}, errno: {}, priority: {} };
const devNull = "/dev/null";
const machine = () => "wasm";
const api = { EOL, platform, arch, type, release, hostname, tmpdir, homedir, cpus, totalmem, freemem, loadavg, uptime, networkInterfaces, userInfo, endianness, constants, devNull, machine, availableParallelism: () => 1 };
export default api;
export { EOL, platform, arch, type, release, hostname, tmpdir, homedir, cpus, totalmem, freemem, loadavg, uptime, networkInterfaces, userInfo, endianness, constants, devNull, machine };
`,
  },

  buffer: {
    support: "full",
    source: String.raw`
const enc = new TextEncoder();
const dec = new TextDecoder();
function fromString(str, encoding) {
  encoding = (encoding || "utf8").toLowerCase();
  if (encoding === "utf8" || encoding === "utf-8" || encoding === "ascii" || encoding === "latin1" || encoding === "binary") {
    if (encoding === "ascii" || encoding === "latin1" || encoding === "binary") { const u = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 0xff; return u; }
    return enc.encode(str);
  }
  if (encoding === "hex") { const clean = str.replace(/[^0-9a-fA-F]/g, ""); const u = new Uint8Array(clean.length >> 1); for (let i = 0; i < u.length; i++) u[i] = parseInt(clean.substr(i * 2, 2), 16); return u; }
  if (encoding === "base64" || encoding === "base64url") { let s = str; if (encoding === "base64url") s = s.replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(s.replace(/[^A-Za-z0-9+/=]/g, "")); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  if (encoding === "utf16le" || encoding === "ucs2" || encoding === "utf-16le") { const u = new Uint8Array(str.length * 2); const dv = new DataView(u.buffer); for (let i = 0; i < str.length; i++) dv.setUint16(i * 2, str.charCodeAt(i), true); return u; }
  return enc.encode(str);
}
class Buffer extends Uint8Array {
  static from(value, a, b) {
    if (typeof value === "string") return new Buffer(fromString(value, a));
    if (value instanceof ArrayBuffer) return new Buffer(value, a, b);
    if (ArrayBuffer.isView(value)) return new Buffer(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    if (Array.isArray(value) || (value && typeof value.length === "number")) return new Buffer(Uint8Array.from(value));
    if (value && value.type === "Buffer" && Array.isArray(value.data)) return new Buffer(Uint8Array.from(value.data));
    throw new TypeError("Buffer.from: unsupported argument");
  }
  static alloc(size, fill, enc2) { const b = new Buffer(new Uint8Array(size)); if (fill !== undefined) b.fill(fill, undefined, undefined, enc2); return b; }
  static allocUnsafe(size) { return new Buffer(new Uint8Array(size)); }
  static allocUnsafeSlow(size) { return new Buffer(new Uint8Array(size)); }
  static isBuffer(b) { return b instanceof Uint8Array; }
  static isEncoding(e) { return ["utf8", "utf-8", "hex", "base64", "base64url", "ascii", "latin1", "binary", "ucs2", "utf16le"].includes(String(e).toLowerCase()); }
  static byteLength(str, encoding) { if (typeof str !== "string") return str.byteLength || str.length || 0; return fromString(str, encoding).length; }
  static concat(list, totalLength) {
    if (totalLength === undefined) { totalLength = 0; for (const b of list) totalLength += b.length; }
    const out = new Buffer(new Uint8Array(totalLength)); let off = 0;
    for (const b of list) { if (off >= totalLength) break; out.set(b.subarray(0, Math.min(b.length, totalLength - off)), off); off += b.length; }
    return out;
  }
  static compare(a, b) { const len = Math.min(a.length, b.length); for (let i = 0; i < len; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; } return a.length === b.length ? 0 : a.length < b.length ? -1 : 1; }
  toString(encoding, start, end) {
    encoding = (encoding || "utf8").toLowerCase(); const sub = this.subarray(start || 0, end === undefined ? this.length : end);
    if (encoding === "utf8" || encoding === "utf-8") return dec.decode(sub);
    if (encoding === "hex") { let s = ""; for (const x of sub) s += x.toString(16).padStart(2, "0"); return s; }
    if (encoding === "base64" || encoding === "base64url") { let bin = ""; for (const x of sub) bin += String.fromCharCode(x); let out = btoa(bin); if (encoding === "base64url") out = out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); return out; }
    if (encoding === "ascii" || encoding === "latin1" || encoding === "binary") { let s = ""; for (const x of sub) s += String.fromCharCode(x); return s; }
    if (encoding === "utf16le" || encoding === "ucs2" || encoding === "utf-16le") { let s = ""; const dv = new DataView(sub.buffer, sub.byteOffset, sub.byteLength); for (let i = 0; i + 1 < sub.byteLength; i += 2) s += String.fromCharCode(dv.getUint16(i, true)); return s; }
    return dec.decode(sub);
  }
  toJSON() { return { type: "Buffer", data: Array.from(this) }; }
  equals(other) { return Buffer.compare(this, other) === 0; }
  compare(other) { return Buffer.compare(this, other); }
  slice(start, end) { return new Buffer(this.subarray(start, end)); }
  write(str, offset, length, encoding) { if (typeof offset === "string") { encoding = offset; offset = 0; } offset = offset || 0; const bytes = fromString(str, encoding); const n = Math.min(bytes.length, length === undefined ? this.length - offset : length); this.set(bytes.subarray(0, n), offset); return n; }
  fill(val, start, end, encoding) { start = start || 0; end = end === undefined ? this.length : end; if (typeof val === "string") { const bytes = fromString(val, encoding); for (let i = start; i < end; i++) this[i] = bytes[(i - start) % bytes.length]; } else { for (let i = start; i < end; i++) this[i] = val & 0xff; } return this; }
  copy(target, ts, ss, se) { ts = ts || 0; ss = ss || 0; se = se === undefined ? this.length : se; const sub = this.subarray(ss, se); target.set(sub.subarray(0, target.length - ts), ts); return Math.min(sub.length, target.length - ts); }
  readUInt8(o) { return this[o || 0]; }
  readInt8(o) { return (this[o || 0] << 24) >> 24; }
  readUInt16LE(o) { o = o || 0; return this[o] | (this[o + 1] << 8); }
  readUInt16BE(o) { o = o || 0; return (this[o] << 8) | this[o + 1]; }
  readUInt32LE(o) { o = o || 0; return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16)) + this[o + 3] * 0x1000000; }
  readUInt32BE(o) { o = o || 0; return this[o] * 0x1000000 + ((this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]); }
  readInt32LE(o) { o = o || 0; return this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24); }
  readBigUInt64LE(o) { o = o || 0; const dv = new DataView(this.buffer, this.byteOffset, this.byteLength); return dv.getBigUint64(o, true); }
  writeUInt8(v, o) { this[o || 0] = v & 0xff; return (o || 0) + 1; }
  writeUInt16LE(v, o) { o = o || 0; this[o] = v & 0xff; this[o + 1] = (v >>> 8) & 0xff; return o + 2; }
  writeUInt32LE(v, o) { o = o || 0; this[o] = v & 0xff; this[o + 1] = (v >>> 8) & 0xff; this[o + 2] = (v >>> 16) & 0xff; this[o + 3] = (v >>> 24) & 0xff; return o + 4; }
  indexOf(val, off, encoding) { const bytes = typeof val === "string" ? fromString(val, encoding) : (typeof val === "number" ? new Uint8Array([val]) : val); off = off || 0; for (let i = off; i <= this.length - bytes.length; i++) { let ok = true; for (let j = 0; j < bytes.length; j++) if (this[i + j] !== bytes[j]) { ok = false; break; } if (ok) return i; } return -1; }
  includes(val, off, encoding) { return this.indexOf(val, off, encoding) !== -1; }
  subarray(start, end) { const s = super.subarray(start, end); Object.setPrototypeOf(s, Buffer.prototype); return s; }
}
try { if (!globalThis.Buffer) globalThis.Buffer = Buffer; } catch (e) {}
const constants = { MAX_LENGTH: 0x7fffffff, MAX_STRING_LENGTH: 0x1fffffff };
const kMaxLength = constants.MAX_LENGTH;
const SlowBuffer = function (n) { return Buffer.alloc(n); };
function transcode(buf) { return buf; }
export default { Buffer, constants, kMaxLength, SlowBuffer, transcode, INSPECT_MAX_BYTES: 50 };
export { Buffer, constants, kMaxLength, SlowBuffer, transcode };
`,
  },

  string_decoder: {
    support: "full",
    source: String.raw`
class StringDecoder {
  constructor(encoding) { this.encoding = (encoding || "utf8").toLowerCase(); this._dec = new TextDecoder(this.encoding === "latin1" ? "latin1" : "utf-8"); }
  write(buf) { if (typeof buf === "string") return buf; return this._dec.decode(buf, { stream: true }); }
  end(buf) { let out = ""; if (buf) out = this._dec.decode(buf); out += this._dec.decode(); return out; }
}
export default { StringDecoder };
export { StringDecoder };
`,
  },

  punycode: {
    support: "full",
    source: String.raw`
const ucs2decode = (s) => Array.from(s).map((c) => c.codePointAt(0));
const ucs2encode = (a) => a.map((c) => String.fromCodePoint(c)).join("");
const toASCII = (s) => s;
const toUnicode = (s) => s;
const encode = (s) => s;
const decode = (s) => s;
const api = { ucs2: { decode: ucs2decode, encode: ucs2encode }, toASCII, toUnicode, encode, decode, version: "2.1.0" };
export default api;
export { toASCII, toUnicode, encode, decode };
`,
  },

  timers: {
    support: "full",
    source: String.raw`
const setTimeout_ = globalThis.setTimeout.bind(globalThis);
const clearTimeout_ = globalThis.clearTimeout.bind(globalThis);
const setInterval_ = globalThis.setInterval.bind(globalThis);
const clearInterval_ = globalThis.clearInterval.bind(globalThis);
const setImmediate_ = (fn, ...a) => setTimeout_(() => fn(...a), 0);
const clearImmediate_ = (id) => clearTimeout_(id);
const api = { setTimeout: setTimeout_, clearTimeout: clearTimeout_, setInterval: setInterval_, clearInterval: clearInterval_, setImmediate: setImmediate_, clearImmediate: clearImmediate_ };
export default api;
export { setTimeout_ as setTimeout, clearTimeout_ as clearTimeout, setInterval_ as setInterval, clearInterval_ as clearInterval, setImmediate_ as setImmediate, clearImmediate_ as clearImmediate };
`,
  },

  "timers/promises": {
    support: "full",
    source: String.raw`
const setTimeout_ = (ms, value) => new Promise((r) => globalThis.setTimeout(() => r(value), ms));
const setImmediate_ = (value) => new Promise((r) => globalThis.setTimeout(() => r(value), 0));
async function* setInterval_(ms, value) { while (true) { await new Promise((r) => globalThis.setTimeout(r, ms)); yield value; } }
export default { setTimeout: setTimeout_, setImmediate: setImmediate_, setInterval: setInterval_ };
export { setTimeout_ as setTimeout, setImmediate_ as setImmediate, setInterval_ as setInterval };
`,
  },

  perf_hooks: {
    support: "full",
    source: String.raw`
const performance_ = globalThis.performance || { now: () => Date.now() };
class PerformanceObserver { constructor(cb) { this._cb = cb; } observe() {} disconnect() {} }
const monitorEventLoopDelay = () => ({ enable: () => {}, disable: () => {}, reset: () => {}, mean: 0, min: 0, max: 0, stddev: 0 });
const api = { performance: performance_, PerformanceObserver, monitorEventLoopDelay, constants: {}, createHistogram: () => ({ record: () => {} }) };
export default api;
export { performance_ as performance, PerformanceObserver, monitorEventLoopDelay };
`,
  },

  async_hooks: {
    support: "full",
    source: String.raw`
let _store;
class AsyncLocalStorage {
  run(store, cb, ...args) { const prev = _store; _store = store; try { return cb(...args); } finally { _store = prev; } }
  getStore() { return _store; }
  enterWith(store) { _store = store; }
  exit(cb, ...args) { const prev = _store; _store = undefined; try { return cb(...args); } finally { _store = prev; } }
  disable() {}
}
class AsyncResource { constructor() {} runInAsyncScope(fn, thisArg, ...a) { return fn.apply(thisArg, a); } bind(fn) { return fn; } emitDestroy() { return this; } }
const createHook = () => ({ enable: () => {}, disable: () => {} });
const executionAsyncId = () => 0;
const triggerAsyncId = () => 0;
const api = { AsyncLocalStorage, AsyncResource, createHook, executionAsyncId, triggerAsyncId };
export default api;
export { AsyncLocalStorage, AsyncResource, createHook, executionAsyncId, triggerAsyncId };
`,
  },

  crypto: {
    support: "full",
    source: String.raw`
const webcrypto = globalThis.crypto;
function randomBytes(size, cb) {
  const u = new Uint8Array(size); webcrypto.getRandomValues(u);
  if (cb) { cb(null, u); return; }
  return u;
}
function randomFillSync(buf, offset, size) { offset = offset || 0; size = size === undefined ? buf.length - offset : size; const tmp = new Uint8Array(size); webcrypto.getRandomValues(tmp); buf.set(tmp, offset); return buf; }
const randomUUID = () => webcrypto.randomUUID();
function randomInt(min, max) { if (max === undefined) { max = min; min = 0; } const range = max - min; const u = new Uint32Array(1); webcrypto.getRandomValues(u); return min + (u[0] % range); }
// Synchronous SHA-256 / SHA-1 (small, dependency-free) for createHash.
function sha256(bytes) {
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  let h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const l = bytes.length; const withOne = l + 1; const k = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + k + 8; const m = new Uint8Array(total); m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(total - 4, (l * 8) >>> 0); dv.setUint32(total - 8, Math.floor(l / 0x20000000));
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) { const s0 = rotr(w[t-15],7)^rotr(w[t-15],18)^(w[t-15]>>>3); const s1 = rotr(w[t-2],17)^rotr(w[t-2],19)^(w[t-2]>>>10); w[t] = (w[t-16]+s0+w[t-7]+s1)>>>0; }
    let a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
    for (let t = 0; t < 64; t++) { const S1=rotr(e,6)^rotr(e,11)^rotr(e,25); const ch=(e&f)^(~e&g); const t1=(hh+S1+ch+K[t]+w[t])>>>0; const S0=rotr(a,2)^rotr(a,13)^rotr(a,22); const maj=(a&b)^(a&c)^(b&c); const t2=(S0+maj)>>>0; hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
    h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+hh)>>>0;
  }
  const out = new Uint8Array(32); const odv = new DataView(out.buffer); for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]); return out;
}
function sha1(bytes) {
  let h0=0x67452301,h1=0xEFCDAB89,h2=0x98BADCFE,h3=0x10325476,h4=0xC3D2E1F0;
  const l = bytes.length; const withOne = l + 1; const k = (56 - (withOne % 64) + 64) % 64; const total = withOne + k + 8;
  const m = new Uint8Array(total); m.set(bytes); m[l] = 0x80; const dv = new DataView(m.buffer);
  dv.setUint32(total - 4, (l * 8) >>> 0); dv.setUint32(total - 8, Math.floor(l / 0x20000000));
  const w = new Uint32Array(80); const rol = (x, n) => (x << n) | (x >>> (32 - n));
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 80; t++) w[t] = rol(w[t-3]^w[t-8]^w[t-14]^w[t-16], 1);
    let a=h0,b=h1,c=h2,d=h3,e=h4;
    for (let t = 0; t < 80; t++) { let f, kk; if (t<20){f=(b&c)|(~b&d);kk=0x5A827999;} else if (t<40){f=b^c^d;kk=0x6ED9EBA1;} else if (t<60){f=(b&c)|(b&d)|(c&d);kk=0x8F1BBCDC;} else {f=b^c^d;kk=0xCA62C1D6;} const tmp=(rol(a,5)+f+e+kk+w[t])>>>0; e=d;d=c;c=rol(b,30);b=a;a=tmp; }
    h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;h4=(h4+e)>>>0;
  }
  const out = new Uint8Array(20); const odv = new DataView(out.buffer); [h0,h1,h2,h3,h4].forEach((x, i) => odv.setUint32(i * 4, x)); return out;
}
const enc = new TextEncoder();
function toBytes(data, encoding) {
  if (typeof data === "string") { if (encoding === "hex") { const u = new Uint8Array(data.length >> 1); for (let i = 0; i < u.length; i++) u[i] = parseInt(data.substr(i * 2, 2), 16); return u; } if (encoding === "base64") { const bin = atob(data); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; } return enc.encode(data); }
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return enc.encode(String(data));
}
function digestFormat(bytes, encoding) {
  if (!encoding || encoding === "buffer") return (globalThis.Buffer ? globalThis.Buffer.from(bytes) : bytes);
  if (encoding === "hex") { let s = ""; for (const b of bytes) s += b.toString(16).padStart(2, "0"); return s; }
  if (encoding === "base64") { let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); }
  return bytes;
}
class Hash {
  constructor(algo) { this.algo = String(algo).toLowerCase().replace(/-/g, ""); this._chunks = []; }
  update(data, enc2) { this._chunks.push(toBytes(data, enc2)); return this; }
  digest(encoding) {
    let total = 0; for (const c of this._chunks) total += c.length; const all = new Uint8Array(total); let o = 0; for (const c of this._chunks) { all.set(c, o); o += c.length; }
    let out; if (this.algo === "sha256") out = sha256(all); else if (this.algo === "sha1") out = sha1(all); else throw new Error("burrow crypto.createHash: only sha256 and sha1 are implemented synchronously (got " + this.algo + "). Use crypto.subtle for others.");
    return digestFormat(out, encoding);
  }
}
class Hmac {
  constructor(algo, key) { this.algo = String(algo).toLowerCase().replace(/-/g, ""); this.key = toBytes(key); this._chunks = []; this.blockSize = 64; }
  update(data, enc2) { this._chunks.push(toBytes(data, enc2)); return this; }
  digest(encoding) {
    const hash = this.algo === "sha256" ? sha256 : this.algo === "sha1" ? sha1 : null;
    if (!hash) throw new Error("burrow crypto.createHmac: only sha256/sha1 implemented");
    let key = this.key; if (key.length > this.blockSize) key = hash(key);
    const ipad = new Uint8Array(this.blockSize); const opad = new Uint8Array(this.blockSize);
    for (let i = 0; i < this.blockSize; i++) { const k = key[i] || 0; ipad[i] = k ^ 0x36; opad[i] = k ^ 0x5c; }
    let total = 0; for (const c of this._chunks) total += c.length; const msg = new Uint8Array(total); let o = 0; for (const c of this._chunks) { msg.set(c, o); o += c.length; }
    const inner = hash(new Uint8Array([...ipad, ...msg]));
    const out = hash(new Uint8Array([...opad, ...inner]));
    return digestFormat(out, encoding);
  }
}
const createHash = (algo) => new Hash(algo);
const createHmac = (algo, key) => new Hmac(algo, key);
const api = { webcrypto, subtle: webcrypto.subtle, getRandomValues: (a) => webcrypto.getRandomValues(a), randomBytes, randomFillSync, randomFill: (b, o, s, cb) => { if (typeof o === "function") { cb = o; o = 0; } cb(null, randomFillSync(b, o, s)); }, randomUUID, randomInt, createHash, createHmac, timingSafeEqual: (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }, constants: {} };
export default api;
export { webcrypto, randomBytes, randomFillSync, randomUUID, randomInt, createHash, createHmac };
export const subtle = webcrypto.subtle;
export const getRandomValues = (a) => webcrypto.getRandomValues(a);
`,
  },

  stream: {
    support: "full",
    source: String.raw`${EVENT_EMITTER}
class Stream extends EventEmitter {}
class Readable extends Stream {
  constructor(opts) { super(); this._buf = []; this._ended = false; this._flowing = false; this.readable = true; this.readableEnded = false; if (opts && typeof opts.read === "function") this._read = opts.read; this._encoding = null; }
  _read() {}
  push(chunk) { if (chunk === null) { this._ended = true; if (this._flowing) { this.emit("end"); this.readableEnded = true; } return false; } this._buf.push(chunk); if (this._flowing) this._drain(); else this.emit("readable"); return true; }
  _drain() { while (this._buf.length) { const c = this._buf.shift(); this.emit("data", this._encoding ? c.toString(this._encoding) : c); } if (this._ended && !this.readableEnded) { this.readableEnded = true; this.emit("end"); } }
  read() { return this._buf.length ? this._buf.shift() : null; }
  setEncoding(enc) { this._encoding = enc; return this; }
  resume() { this._flowing = true; queueMicrotask(() => { this._read(); this._drain(); }); return this; }
  pause() { this._flowing = false; return this; }
  on(ev, fn) { super.on(ev, fn); if (ev === "data") this.resume(); return this; }
  pipe(dest) { this.on("data", (c) => dest.write(c)); this.on("end", () => dest.end && dest.end()); return dest; }
  destroy(err) { this._buf = []; if (err) this.emit("error", err); this.emit("close"); return this; }
  [Symbol.asyncIterator]() {
    const self = this; const q = []; let ended = false; let pend = null;
    self.on("data", (c) => { if (pend) { const p = pend; pend = null; p({ value: c, done: false }); } else q.push(c); });
    self.on("end", () => { ended = true; if (pend) { const p = pend; pend = null; p({ value: undefined, done: true }); } });
    return { next() { if (q.length) return Promise.resolve({ value: q.shift(), done: false }); if (ended) return Promise.resolve({ value: undefined, done: true }); return new Promise((r) => (pend = r)); }, return() { return Promise.resolve({ value: undefined, done: true }); }, [Symbol.asyncIterator]() { return this; } };
  }
  static from(iterable) { const r = new Readable(); (async () => { try { for await (const c of iterable) r.push(c); r.push(null); } catch (e) { r.destroy(e); } })(); return r; }
}
class Writable extends Stream {
  constructor(opts) { super(); this.writable = true; if (opts && typeof opts.write === "function") this._write = opts.write; this._chunks = []; }
  _write(chunk, enc, cb) { this._chunks.push(chunk); cb && cb(); }
  write(chunk, enc, cb) { if (typeof enc === "function") { cb = enc; enc = null; } this._write(chunk, enc, (err) => { if (err) this.emit("error", err); else cb && cb(); }); return true; }
  end(chunk, enc, cb) { if (typeof chunk === "function") { cb = chunk; chunk = null; } if (chunk != null) this.write(chunk, enc); this.emit("finish"); this.emit("close"); cb && cb(); return this; }
  destroy(err) { if (err) this.emit("error", err); this.emit("close"); return this; }
}
class Duplex extends Readable {
  constructor(opts) { super(opts); this.writable = true; if (opts && typeof opts.write === "function") this._write = opts.write; }
  _write(chunk, enc, cb) { cb && cb(); }
  write(chunk, enc, cb) { if (typeof enc === "function") { cb = enc; enc = null; } this._write(chunk, enc, (err) => { if (err) this.emit("error", err); else cb && cb(); }); return true; }
  end(chunk, enc, cb) { if (typeof chunk === "function") { cb = chunk; chunk = null; } if (chunk != null) this.write(chunk, enc); this.push(null); this.emit("finish"); cb && cb(); return this; }
}
class Transform extends Duplex {
  constructor(opts) { super(opts); if (opts && typeof opts.transform === "function") this._transform = opts.transform; if (opts && typeof opts.flush === "function") this._flush = opts.flush; }
  _transform(chunk, enc, cb) { cb(null, chunk); }
  _flush(cb) { cb(); }
  write(chunk, enc, cb) { if (typeof enc === "function") { cb = enc; enc = null; } this._transform(chunk, enc, (err, out) => { if (err) this.emit("error", err); else { if (out != null) this.push(out); cb && cb(); } }); return true; }
  end(chunk, enc, cb) { if (typeof chunk === "function") { cb = chunk; chunk = null; } if (chunk != null) this.write(chunk, enc); this._flush((err, out) => { if (out != null) this.push(out); this.push(null); this.emit("finish"); cb && cb(); }); return this; }
}
class PassThrough extends Transform { _transform(chunk, enc, cb) { cb(null, chunk); } }
function pipeline(...args) { const cb = typeof args[args.length - 1] === "function" ? args.pop() : null; let cur = args[0]; for (let i = 1; i < args.length; i++) cur = cur.pipe(args[i]); const last = args[args.length - 1]; if (cb) { last.on("finish", () => cb(null)); last.on("error", cb); } return last; }
function finished(stream, cb) { let called = false; const done = (err) => { if (!called) { called = true; cb(err); } }; stream.on("end", () => done()); stream.on("finish", () => done()); stream.on("error", done); stream.on("close", () => done()); return () => {}; }
const api = { Stream, Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished };
api.Stream = Stream; Stream.Readable = Readable; Stream.Writable = Writable; Stream.Duplex = Duplex; Stream.Transform = Transform; Stream.PassThrough = PassThrough; Stream.pipeline = pipeline; Stream.finished = finished;
export default Stream;
export { Stream, Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished };
`,
  },

  "stream/promises": {
    support: "full",
    source: String.raw`
function pipeline(...streams) { return new Promise((resolve, reject) => { let cur = streams[0]; for (let i = 1; i < streams.length; i++) cur = cur.pipe(streams[i]); const last = streams[streams.length - 1]; last.on("finish", resolve); last.on("error", reject); }); }
function finished(stream) { return new Promise((resolve, reject) => { stream.on("end", resolve); stream.on("finish", resolve); stream.on("close", resolve); stream.on("error", reject); }); }
export default { pipeline, finished };
export { pipeline, finished };
`,
  },

  // http / https: a client mapped onto fetch(). Server side points at Bun.serve.
  http: {
    support: "net",
    source: String.raw`${EVENT_EMITTER}
class IncomingMessage extends EventEmitter {
  constructor(res) { super(); this.statusCode = res ? res.status : 200; this.statusMessage = res ? res.statusText : ""; this.headers = {}; if (res) for (const [k, v] of res.headers) this.headers[k.toLowerCase()] = v; this._res = res; this.complete = false; }
  setEncoding(e) { this._encoding = e; return this; }
  async _pump() { try { const buf = new Uint8Array(await this._res.arrayBuffer()); this.emit("data", this._encoding ? new TextDecoder(this._encoding).decode(buf) : (globalThis.Buffer ? globalThis.Buffer.from(buf) : buf)); this.complete = true; this.emit("end"); } catch (e) { this.emit("error", e); } }
  on(ev, fn) { super.on(ev, fn); if (ev === "data" && this._res && !this._pumped) { this._pumped = true; queueMicrotask(() => this._pump()); } return this; }
}
class ClientRequest extends EventEmitter {
  constructor(options, cb) {
    super(); this._body = []; this._headers = {};
    if (typeof options === "string") options = new URL(options);
    if (options instanceof URL) options = { protocol: options.protocol, hostname: options.hostname, port: options.port, path: options.pathname + options.search };
    this.options = options || {}; if (options && options.headers) this._headers = { ...options.headers };
    this.method = (this.options.method || "GET").toUpperCase();
    if (cb) this.once("response", cb);
  }
  setHeader(k, v) { this._headers[k] = v; return this; }
  getHeader(k) { return this._headers[k]; }
  removeHeader(k) { delete this._headers[k]; }
  write(chunk) { this._body.push(chunk); return true; }
  end(chunk, enc, cb) { if (typeof chunk === "function") { cb = chunk; chunk = null; } if (chunk != null) this._body.push(chunk); this._send(); if (cb) cb(); return this; }
  abort() { this._aborted = true; this.emit("abort"); }
  destroy() { this._aborted = true; }
  async _send() {
    const o = this.options;
    const proto = o.protocol || "http:"; const host = o.hostname || o.host || "localhost"; const port = o.port ? ":" + o.port : "";
    const path = o.path || "/"; const url = o.href || (proto + "//" + host + port + path);
    const hasBody = this._body.length > 0 && this.method !== "GET" && this.method !== "HEAD";
    let body; if (hasBody) { const parts = this._body.map((c) => (typeof c === "string" ? new TextEncoder().encode(c) : c)); let len = 0; for (const p of parts) len += p.length; body = new Uint8Array(len); let off = 0; for (const p of parts) { body.set(p, off); off += p.length; } }
    try {
      const res = await fetch(url, { method: this.method, headers: this._headers, body });
      const im = new IncomingMessage(res); this.emit("response", im);
    } catch (e) { this.emit("error", e); }
  }
}
function request(options, cb) { return new ClientRequest(options, cb); }
function get(options, cb) { const req = new ClientRequest(options, cb); req.end(); return req; }
function createServer() { throw new Error("http.createServer is not available in the Burrow sandbox — use 'export default { fetch }' or Bun.serve({ fetch }) so Burrow can route requests through the preview bridge."); }
const STATUS_CODES = { 200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable" };
const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "CONNECT", "TRACE"];
const globalAgent = { maxSockets: Infinity };
class Agent { constructor(o) { this.options = o || {}; } }
const api = { request, get, createServer, ClientRequest, IncomingMessage, ServerResponse: class {}, Agent, globalAgent, STATUS_CODES, METHODS };
export default api;
export { request, get, createServer, ClientRequest, IncomingMessage, Agent, globalAgent, STATUS_CODES, METHODS };
`,
  },
};

/** Alias `to` to an already-registered builtin `from` (same source, given support level). */
function alias(to: string, from: string, support: BuiltinSupport): void {
  const base = MODULES[from];
  if (base === undefined) throw new Error(`node-builtins: alias target "${from}" is not registered`);
  MODULES[to] = { support, source: base.source };
}

// https shares http's implementation (fetch already does TLS).
alias("https", "http", "net");
// sys is a deprecated alias of util.
alias("sys", "util", "full");
alias("path/posix", "path", "full");
alias("path/win32", "path", "full");
alias("assert/strict", "assert", "full");
// (fs/promises is registered below, after FS_MSG is declared.)

// ---------------------------------------------------------------------------
// Capability stubs — import succeeds; the impossible-in-a-worker call throws a
// precise, actionable error. `fs` will become VFS-backed with the SAB bridge.
// ---------------------------------------------------------------------------

function makeStub(name: string, message: string, members: string[], extra = ""): BuiltinModule {
  const thrower = `function __throw(){ throw new Error(${JSON.stringify(message)}); }`;
  const named = members.map((m) => `export const ${m} = (...a) => __throw();`).join("\n");
  const defObj = `{ ${members.map((m) => `${m}: (...a) => __throw()`).join(", ")} }`;
  return {
    support: "stub",
    source: String.raw`${thrower}
${extra}
${named}
const __default = ${defObj};
export default __default;
`,
  };
}

const FS_MSG =
  "burrow: node:fs is not yet wired to the workspace VFS from inside a run worker " +
  "(synchronous fs needs the SharedArrayBuffer bridge, which is not enabled yet). " +
  "Async file work can use Bun.file / the shell; real filesystem + subprocess access is coming via the Linux VM tab.";
const CP_MSG =
  "burrow: child_process is not available in the native browser sandbox — there is no real process table here. " +
  "Use the Linux VM tab for real subprocesses, or call an HTTP API instead of shelling out.";
const NET_MSG =
  "burrow: raw TCP/UDP sockets (net/tls/dgram) are not available in the browser sandbox. " +
  "Use fetch()/WebSocket, or the Linux VM tab for a real network stack.";

function makePromiseFsPlaceholder(): BuiltinModule {
  const members = ["readFile", "writeFile", "appendFile", "mkdir", "rmdir", "rm", "unlink", "readdir", "stat", "lstat", "access", "copyFile", "rename", "realpath", "readlink", "symlink", "chmod", "chown", "utimes", "open", "opendir", "cp", "mkdtemp"];
  const named = members.map((m) => `export const ${m} = (...a) => Promise.reject(new Error(${JSON.stringify(FS_MSG)}));`).join("\n");
  const defObj = `{ ${members.map((m) => `${m}: (...a) => Promise.reject(new Error(${JSON.stringify(FS_MSG)}))`).join(", ")} }`;
  return { support: "stub", source: String.raw`${named}
const __default = ${defObj};
export default __default;
` };
}

MODULES["fs/promises"] = makePromiseFsPlaceholder();
MODULES["fs"] = makeStub(
  "fs",
  FS_MSG,
  ["readFileSync", "writeFileSync", "appendFileSync", "existsSync", "statSync", "lstatSync", "mkdirSync", "rmdirSync", "rmSync", "unlinkSync", "readdirSync", "realpathSync", "copyFileSync", "renameSync", "readlinkSync", "chmodSync", "accessSync", "readFile", "writeFile", "mkdir", "readdir", "stat", "lstat", "unlink", "rm", "watch", "watchFile", "createReadStream", "createWriteStream", "openSync", "closeSync", "readSync", "writeSync"],
  String.raw`export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_APPEND: 1024 };
export const promises = __makePromises();
function __makePromises(){ const p = (...a) => Promise.reject(new Error(${JSON.stringify(FS_MSG)})); return new Proxy({}, { get: () => p }); }`,
);
MODULES["child_process"] = makeStub("child_process", CP_MSG, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
MODULES["net"] = makeStub("net", NET_MSG, ["connect", "createConnection", "createServer", "Socket", "Server", "isIP", "isIPv4", "isIPv6"]);
MODULES["tls"] = makeStub("tls", NET_MSG, ["connect", "createServer", "createSecureContext", "TLSSocket"]);
MODULES["dgram"] = makeStub("dgram", NET_MSG, ["createSocket"]);
MODULES["dns"] = makeStub("dns", "burrow: node:dns is not available in the browser sandbox (no resolver). Use fetch() with hostnames directly.", ["lookup", "resolve", "resolve4", "resolve6", "reverse"], String.raw`export const promises = new Proxy({}, { get: () => (() => Promise.reject(new Error("dns unavailable"))) });`);
MODULES["http2"] = makeStub("http2", "burrow: node:http2 is not available in the browser sandbox. Use fetch() (HTTP/2 is handled by the browser transparently) or the Linux VM tab.", ["connect", "createServer", "createSecureServer", "constants"]);
MODULES["cluster"] = makeStub("cluster", "burrow: node:cluster is not available in the browser sandbox (single-threaded worker). Use Web Workers via worker_threads instead.", ["fork", "setupMaster", "setupPrimary"], String.raw`export const isPrimary = true; export const isMaster = true; export const isWorker = false; export const workers = {};`);
MODULES["worker_threads"] = makeStub("worker_threads", "burrow: node:worker_threads is not yet mapped to Web Workers. Coming soon; for now avoid worker threads in the sandbox.", ["Worker", "parentPort", "MessageChannel", "MessagePort", "receiveMessageOnPort", "markAsUntransferable", "moveMessagePortToContext"], String.raw`export const isMainThread = true; export const threadId = 0; export const workerData = null;`);
MODULES["vm"] = makeStub("vm", "burrow: node:vm is not available. Use dynamic import() of a blob module (which is how Burrow already runs your code) instead of vm.runInContext.", ["runInNewContext", "runInThisContext", "runInContext", "compileFunction", "createContext", "Script", "SourceTextModule"]);
MODULES["v8"] = makeStub("v8", "burrow: node:v8 is not available in the browser sandbox.", ["serialize", "deserialize", "getHeapStatistics", "setFlagsFromString", "takeCoverage"]);
MODULES["inspector"] = makeStub("inspector", "burrow: node:inspector is not available in the browser sandbox.", ["open", "close", "url", "Session"]);
MODULES["repl"] = makeStub("repl", "burrow: node:repl is not available (use the terminal tab).", ["start"]);
MODULES["readline"] = makeStub("readline", "burrow: node:readline is not wired to the terminal yet.", ["createInterface", "cursorTo", "clearLine", "clearScreenDown", "moveCursor"]);
MODULES["zlib"] = makeStub("zlib", "burrow: node:zlib is not implemented yet (gzip/deflate). Use the web CompressionStream/DecompressionStream APIs directly for now.", ["gzip", "gunzip", "deflate", "inflate", "brotliCompress", "brotliDecompress", "gzipSync", "gunzipSync", "deflateSync", "inflateSync", "createGzip", "createGunzip", "createDeflate", "createInflate"], String.raw`export const constants = {};`);

// module: a require shim consistent with cjs.ts's CJS registry philosophy.
MODULES["module"] = {
  support: "stub",
  source: String.raw`
function createRequire() { return function require(id) { throw new Error("burrow: dynamic require(" + JSON.stringify(id) + ") outside the static graph is not supported — use a static import so Burrow's bundler can resolve it."); }; }
const builtinModules = ${JSON.stringify(Object.keys({}))};
const Module = function () {};
Module.createRequire = createRequire; Module.builtinModules = builtinModules;
Module._resolveFilename = (r) => r;
const isBuiltin = (name) => false;
export default Module;
export { createRequire, builtinModules, Module, isBuiltin };
`,
};

// constants / tty / diagnostics_channel: tiny real-ish shims.
MODULES["constants"] = {
  support: "full",
  source: String.raw`const c = { E2BIG: 7, EACCES: 13, EADDRINUSE: 48, EAGAIN: 35, EBADF: 9, EEXIST: 17, EINVAL: 22, ENOENT: 2, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 512, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
export default c;`,
};
MODULES["tty"] = {
  support: "full",
  source: String.raw`class ReadStream { constructor() { this.isTTY = false; } on() {} }
class WriteStream { constructor() { this.isTTY = false; this.columns = 80; this.rows = 24; } on() {} write(s) { console.log(String(s)); return true; } }
const isatty = () => false;
export default { isatty, ReadStream, WriteStream };
export { isatty, ReadStream, WriteStream };`,
};
MODULES["diagnostics_channel"] = {
  support: "full",
  source: String.raw`const channels = new Map();
class Channel { constructor(name) { this.name = name; this._subs = []; } get hasSubscribers() { return this._subs.length > 0; } publish(msg) { for (const s of this._subs) s(msg, this.name); } subscribe(fn) { this._subs.push(fn); } unsubscribe(fn) { const i = this._subs.indexOf(fn); if (i >= 0) this._subs.splice(i, 1); } }
const channel = (name) => { if (!channels.has(name)) channels.set(name, new Channel(name)); return channels.get(name); };
const api = { channel, Channel, hasSubscribers: (n) => channels.has(n) && channels.get(n).hasSubscribers, subscribe: (n, fn) => channel(n).subscribe(fn), unsubscribe: (n, fn) => channel(n).unsubscribe(fn), tracingChannel: () => ({ start: channel("start"), end: channel("end") }) };
export default api;
export { channel, Channel };`,
};

// Fill module.builtinModules now that MODULES is populated.
const moduleShim = MODULES["module"];
if (moduleShim !== undefined) {
  moduleShim.source = moduleShim.source.replace(
    JSON.stringify(Object.keys({})),
    JSON.stringify(Object.keys(MODULES).filter((n) => !n.includes("/"))),
  );
}

// ---------------------------------------------------------------------------
// Public API (consumed by graph.ts)
// ---------------------------------------------------------------------------

/** Canonical builtin name for a specifier, or null if it is not a builtin. */
export function nodeBuiltinName(spec: string): string | null {
  const name = spec.startsWith("node:") ? spec.slice(5) : spec;
  return Object.prototype.hasOwnProperty.call(MODULES, name) ? name : null;
}

/** Whether a bare/`node:` specifier maps to one of our builtin shims. */
export function isNodeBuiltin(spec: string): boolean {
  return nodeBuiltinName(spec) !== null;
}

/** Blob: URL for the builtin shim (page-lifetime cached), or null if unknown. */
export function nodeBuiltinUrl(spec: string): string | null {
  const name = nodeBuiltinName(spec);
  const mod = name === null ? undefined : MODULES[name];
  if (name === null || mod === undefined) return null;
  let url = cache.get(name);
  if (url === undefined) {
    url = URL.createObjectURL(new Blob([mod.source], { type: "text/javascript" }));
    cache.set(name, url);
  }
  return url;
}

/** Support level for a builtin (for diagnostics / the `bun` command surface). */
export function nodeBuiltinSupport(spec: string): BuiltinSupport | null {
  const name = nodeBuiltinName(spec);
  const mod = name === null ? undefined : MODULES[name];
  return mod === undefined ? null : mod.support;
}

/** Every supported builtin name with its support level (for introspection/tests). */
export function nodeBuiltinManifest(): Array<{ name: string; support: BuiltinSupport }> {
  return Object.entries(MODULES).map(([name, mod]) => ({ name, support: mod.support }));
}

/** Test-only: raw source for a builtin (so tests can import it as a blob). */
export function __builtinSourceForTest(name: string): string | null {
  return MODULES[name]?.source ?? null;
}
