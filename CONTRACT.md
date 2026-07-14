# burrow — Integration Contract

Every builder follows this document. Interfaces live in `src/contract/types.ts`; the
service locator in `src/contract/registry.ts`. Both are frozen — if you need a change,
you're doing it wrong; adapt inside your module.

Decisions (from verified scout evidence):

| Concern | Decision |
|---|---|
| Canonical FS | just-bash's `InMemoryFs`, wrapped in our `WatchedFs` event decorator (least glue: zero-code store with symlinks/lazy/mtimes; git needs only a ~50-line promise adapter) |
| Terminal | `@wterm/dom` widget + **our own** shell driver in `src/shell/` (npm `wterm@0.0.1` is an empty name-squat; `@wterm/just-bash`'s BashShell re-executes every command a 2nd time for cwd tracking and can't inject fs/customCommands — disqualified, but we vendor-adapt its line editor) |
| Transpiler | project `bun.wasm` (real Bun Rust transpiler, ABI below), module-level singleton |
| Git | isomorphic-git 1.38.7, flat promise fs adapter, same-origin `/git-proxy` |
| AI | transformers.js 4.2.0 in a Worker; default `onnx-community/Qwen3-0.6B-ONNX` (q4f16, 570 MB), opt-in `onnx-community/gemma-4-E2B-it-qat-mobile-ONNX` (q2f16, ~2.3 GB) |

---

## 1. Module ownership map + boot order

| Dir | Builder owns | Provides to registry | Registers commands |
|---|---|---|---|
| `src/contract/` | ARCHITECT ONLY | — | — |
| `src/vfs/` | InMemoryFs seed, `WatchedFs`, `GitFsAdapter`, `EventBus` impl | `events`, `vfs`, `gitFs` | — |
| `src/git/` | Buffer polyfill, `GitAPI`, `src/git/proxy.ts` (server-side) | `git` | `git` |
| `src/toolchain/` | bun.wasm loader, graph builder, `runner-worker.ts`, `public/sw.js`, SW registration | `toolchain` | `bun`, `serve` |
| `src/ai/` | AI worker, `AiPanelAPI`, chat panel component | `ai` | — |
| `src/shell/` | WTerm mount, shell driver (line editor/history/tab/Ctrl+C), Bash construction | `shell` | `edit`, `open` |
| `src/ui/` | `index.html`, `server.ts`, `bunfig.toml`, `build-plugins.ts`, `zlib-shim.ts`, layout, file tree, CodeMirror editor, diff view, console pane, statusbar, theme | — | — |

**Cross-module imports.** Runtime access to another module goes ONLY through
`src/contract/types.ts` (types) + `src/contract/registry.ts` (`provide`/`use`/`tryUse`,
`registerShellCommand`). Exactly three sanctioned exceptions:

1. `src/ui/main.tsx` (frontend entry) imports the init entrypoints below.
2. `src/ui/server.ts` imports `handleGitProxy` from `src/git/proxy.ts` (server side has no registry).
3. Everyone may import npm packages and `src/contract/*`.

**Fixed init entrypoints** (each module's `index.ts` default-exports nothing; named exports only):

```ts
// src/vfs/index.ts        export function initVfs(): void
// src/git/index.ts        export function initGit(): void            // Buffer polyfill at module eval time
// src/toolchain/index.ts  export async function initToolchain(): Promise<void>  // registers SW; bun.wasm stays lazy
// src/ai/index.ts         export function initAi(panelEl: HTMLElement): void     // model load stays lazy
// src/shell/index.ts      export async function initShell(termEl: HTMLElement): Promise<void>
```

**Boot order (src/ui/main.tsx executes exactly this):**
`initVfs() → initGit() → await initToolchain() → initAi(el) → await initShell(el) → render rest of UI`.
All `registerShellCommand` calls MUST happen inside `initGit`/`initToolchain` (and shell's own
in `initShell` before it constructs Bash). The registry throws on late registration.

Package changes (run once, by the named builder): shell: `bun remove wterm && bun add @wterm/dom`;
git: `bun add buffer` (make the transitive dep direct).

---

## 2. The VFS spine (`src/vfs/`)

**Canonical store**: one `new InMemoryFs(SEED_FILES)` from `just-bash/browser`, wrapped in
`WatchedFs implements BurrowVfs` — a delegating decorator that emits events on every mutation.
The **same WatchedFs instance** is:

- provided as `vfs` (all modules, editor, file tree),
- passed by the shell module to `new Bash({ fs: use("vfs") as unknown as IFileSystem })`
  (it structurally satisfies just-bash `IFileSystem`; the cast is confined to `src/shell/`),
- the backing store of `GitFsAdapter implements GitFsPromises`, provided as `gitFs`.

So every write — shell builtin, custom command, editor save, git checkout — hits one store and
emits on one bus. Workspace root is `WORKSPACE_ROOT = "/home/user"`. Seed a small demo project
(e.g. `/home/user/hello/index.ts` + `package.json` + `README.md`) and emit `fs:batch{reason:"seed"}`.

**WatchedFs** wraps the mutators: `writeFile, appendFile, mkdir, rm, cp, mv, chmod, symlink,
link, utimes, writeFileSync, mkdirSync`. For write/append: `await exists(path)` first to decide
`created` vs `modified`; `rm`/`mv`/`cp` emit `deleted`/`created` for the top path (recursive
children may be collapsed into one event + an `fs:batch` — don't enumerate). Reads delegate untouched.

**GitFsAdapter** (~60 lines) maps `GitFsPromises` onto the store. Non-negotiables (all in the
doc comments of `GitFsPromises` — read them): every method `async`; errors are `Error` with
`.code` (`ENOENT`/`EEXIST`/`ENOTDIR`/`ENOTEMPTY`/`EINVAL`); `readdir` returns bare names and
throws `ENOTDIR` on files; `stat` returns methods `isFile()/isDirectory()/isSymbolicLink()` plus
ALL numeric fields (`% 2**32` is applied to each — NaN corrupts `.git/index`): `uid:1, gid:1,
dev:1`, **stable ino per path** (keep a `Map<string, number>` counter), `mtimeMs/ctimeMs` from
InMemoryFs mtime, mode `0o100644`/`0o100755`/`0o40755`/`0o120000`. `readFile` honors both
`'utf8'` and `{encoding:'utf8'}`. Name mapping: `rmdir→rm(path)`, `unlink→rm(path)`,
`mkdir` (non-recursive, throw EEXIST/ENOENT yourself — InMemoryFs `mkdir {recursive:false}`
semantics must be verified and wrapped). Pass FLAT to isomorphic-git (`fs: gitFs`), never
`{promises: gitFs}`.

**EventBus**: trivial typed emitter over `BurrowEventMap` (see types). `on` returns unsubscribe;
`emit` isolates handler exceptions (`try/catch` + `console.error`).

---

## 3. Events

`BurrowEventMap` in types.ts is the complete vocabulary:

- `file:changed {kind, path}` — fine-grained, from WatchedFs. Includes `.git/**`; subscribers filter.
- `fs:batch {reason}` — coarse rescan hint. Shell driver emits after EVERY completed command
  (`reason:"shell-command"`); GitAPI after clone/checkout/discard (`"git"`).
- `cwd:changed {cwd}` — shell driver, when PWD moved.
- `editor:open {path, line?, column?}` — `edit`/`open` commands and file-tree clicks; UI editor subscribes.
- `run:started / run:ended / preview:ready` — toolchain sessions. `preview:ready` fires for the
  default/active session only (back-compat); `preview:servers {servers: PreviewServer[]}` fires
  whenever the live `/preview/<port>/` set changes (see §6.3/§6.4) and is what the preview pane's
  port switcher subscribes to.

File tree strategy: subscribe to `file:changed` + `fs:batch`, debounce 50 ms, rebuild from the
sync `vfs.getAllPaths()`, filter `**/.git/**`.

---

## 4. Command registry (shell)

Custom commands use the contract shapes `CommandSpec`/`CommandContext`/`ShellExecResult`
(structurally identical to just-bash's `Command`/`CommandContext`/`ExecResult`). Providers call
`registerShellCommand(spec)` during init; `src/shell/` calls `sealShellCommands()` and wraps each
with `defineCommand(name, execute)` into `new Bash({ customCommands })` (this also creates
`/usr/bin` stubs so `which git` works). Custom names shadow builtins; `bun git edit open serve`
are all free.

Rules for command authors:

- `ctx.stdin` is a latin1 ByteString — decode with `decodeStdin()` from the registry before text use.
- Long-running work MUST honor `ctx.signal` (the shell driver aborts it on Ctrl+C).
- To spawn sub-commands use `ctx.exec(line, { cwd: ctx.cwd })` — `cwd` is required.
- Return `{stdout, stderr, exitCode}`; write `\n` line endings (driver converts to `\r\n`).

Command specs:

- **`git`** (src/git/): subcommands `clone <url> [dir]`, `init`, `status` (render statusMatrix as
  porcelain-ish), `add <path...|.>`, `add -A`, `commit -m <msg>`, `log [-n N]`, `diff <path>`
  (unified-ish dump of HEAD vs workdir; fancy diff lives in the UI), `checkout -- <path...>`,
  `branch`. `dir` = repo root: nearest ancestor of `ctx.cwd` containing `.git`, else `ctx.cwd`.
- **`bun`** (src/toolchain/): `bun run <file>` / `bun <file>` → `toolchain.run`; stream RunnerEvents
  to stdout until `exit` (or return early on `serve-listening`, printing the preview URL
  `${location.origin}/preview/`). `ctx.signal` → `session.stop()`. `bun build <file>` → `buildGraph`,
  print module list or errors.
- **`serve [file]`** (src/toolchain/): `bun run` an entry (default: first of `./index.ts|./server.ts`)
  expected to call `Bun.serve`; waits for `serve-listening`, prints preview URL, returns (server
  keeps running; `bun stop` optional extra to `stopAll()`).
- **`edit`/`open`** (src/shell/): `events.emit("editor:open", { path: ctx.fs.resolvePath(ctx.cwd, arg) })`.

---

## 5. Shell (`src/shell/`)

Terminal widget: `import { WTerm } from "@wterm/dom"; import "@wterm/dom/css";` —
`const term = new WTerm(el, { cursorBlink: true, onData: d => driver.handleInput(d) });
await term.init();` **Always** set `onData` (else self-echo doubles chars). Container needs an
explicit height (UI provides). Theme via CSS vars on `.wterm` (`--term-bg` etc.) — coordinate
with UI's palette by just using UI's CSS custom properties file.

Shell driver: vendor-adapt the line editor from the extracted BashShell source
(the extracted `wterm-just-bash-0.3.0/package/dist/index.js` npm tarball)
— keystroke handling, history (↑/↓), tab completion (files + `compgen -c` via `ctx.exec`),
Ctrl+L, multi-char paste, red stderr — but replace its execution core:

```ts
const bash = new Bash({ fs: vfs as unknown as IFileSystem, customCommands, env: BASE_ENV, cwd: WORKSPACE_ROOT });
let cwd = WORKSPACE_ROOT; let env = { ...BASE_ENV };
// per command:
const ac = new AbortController();               // Ctrl+C during a run → ac.abort() (exitCode 126)
const r = await bash.exec(line, { cwd, env, signal: ac.signal });
env = r.env; const newCwd = r.env.PWD ?? cwd;
if (newCwd !== cwd) { cwd = newCwd; events.emit("cwd:changed", { cwd }); }
events.emit("fs:batch", { reason: "shell-command" });
```

Never re-execute a command for state tracking (the upstream BashShell bug). just-bash resets
shell state every exec — threading `{cwd, env}` and reading them back from `r.env` is THE
persistence mechanism (`cd`, `export` stick this way). Pass `{ rawScript: true }` when executing
editor buffers verbatim. Prompt: `\x1b[1;32muser@burrow\x1b[0m:\x1b[1;34m${cwd.replace(/^\/home\/user/, "~") || "/"}\x1b[0m$ `.
Unlike upstream, accept Ctrl+C while busy (keep reading onData during exec; only line editing is
locked). Provide `ShellAPI` (`exec` threads the same `{cwd, env}`; `print` writes to the terminal).

Known just-bash facts you inherit: 79 coreutils incl. grep/sed/awk/jq/find; no tar/sqlite/python;
gzip/gunzip/zcat throw (zlib shim); no output streaming (result arrives whole); default
executionLimits cap runaway loops.

---

## 6. Toolchain (`src/toolchain/` + `public/sw.js`)

### 6.1 bun.wasm singleton

Module-level `let wasmPromise: Promise<BunWasm> | null`, first `ready()` fetches
`/bun.wasm` (server.ts serves the repo-root file), instantiates with
`{ wasi_snapshot_preview1: shim, env: throwingProxy }` (adapt the known-good shim at
`src-reference-wasi-shim.js` at the repo root), calls `_initialize()` once.
ABI (little-endian u32s):

```
bun_wasm_alloc(len) -> ptr                 // write UTF-8 source at ptr in exports.memory
bun_wasm_transform(ptr, len, loader) -> r  // loader: 0=js 1=jsx 2=ts 3=tsx
struct at r: ok@0, payloadPtr@4, payloadLen@8, cap@12
ok=1 -> payload = transpiled ESM JS (JSX output may import "react/jsx-dev-runtime")
ok=0 -> payload = UTF-8 error text with caret diagnostics
bun_wasm_result_free(r); bun_wasm_free(ptr, len)
```

Always free both allocations. Memory growth invalidates cached `Uint8Array` views — re-derive
from `exports.memory.buffer` after every call.

### 6.2 Module graph → blob URLs

`buildGraph(entryPath)`:

1. DFS from entry. For each module: `vfs.readFile`, transpile with `loaderForPath`.
2. Extract import specifiers from the TRANSPILED output (static `import ... from "..."`,
   `export ... from "..."`, bare `import "..."`, dynamic `import("...")` with string literals —
   regex over bun's normalized output is acceptable v1; non-literal dynamic imports are left alone).
3. Resolve each specifier:
   - **relative/absolute** (`./x`, `../x`, `/home/...`): probe in order
     `x, x.ts, x.tsx, x.js, x.jsx, x/index.ts, x/index.tsx, x/index.js, x/index.jsx`.
     `.json` files become a synthesized module `export default JSON.parse(<stringified>)`.
     Unresolvable → `BuildError`.
   - **bare** (`react`, `@scope/pkg/sub`, incl. the auto-injected `react/jsx-dev-runtime`):
     rewrite to `https://esm.sh/<pkg>@<version><subpath>`. Version = walk up from the importing
     file to the nearest `package.json` in the VFS, check `dependencies`/`devDependencies`;
     `encodeURIComponent` the range (`^19.1.0` → `%5E19.1.0`); no match → no `@version` (latest).
   - **`burrow:serve` / `bun`** module specifiers: resolve to the runtime-shim blob (6.3).
4. Mint blob URLs bottom-up (post-order), textually replacing each specifier. Import cycles →
   `BuildError` ("import cycles unsupported"). Revoke all blob URLs on `session.stop()`.

### 6.3 Run worker + Bun.serve bridge

`run()` spawns ONE dedicated `new Worker(bootstrapBlobUrl, { type: "module" })` per session.
The bootstrap module (generated text):

1. Overrides `console.log/info/warn/error/debug` to `postMessage({type:"console", level, args})`
   with args pre-stringified (strings verbatim; else a safe inspect: JSON.stringify with cycle
   guard, `Error` → `stack`, depth-limited).
2. Installs `self.onerror` / `onunhandledrejection` → `{type:"error", kind, message, stack}`.
3. Defines the **`burrow:serve` runtime**: `globalThis.Bun = { serve(opts) { handler = opts.fetch;
   const port = coercePort(opts.port); postMessage({type:"serve-listening", port});
   return { port, hostname: "burrow", stop() {} }; } }` plus an `onmessage` for
   `{type:"serve-request", request}`: deserialize to a real `Request`, `await handler(req)`,
   serialize → `postMessage({type:"serve-response", response})` (message types:
   `HostToRunnerMessage`/`RunnerToHostMessage`; bodies as `Uint8Array`, transfer the underlying
   buffer). `coercePort` (src/toolchain/bootstrap.ts, embedded via `.toString()` like
   `detectHandlerShape`) coerces `opts.port` — numbers pass through, numeric strings parse,
   anything falsy/NaN/≤0 (0, omitted, `"abc"`) falls back to Bun's own default of **3000**.
4. `await import(<entryBlobUrl>)` in try/catch → `{type:"error", kind:"import"}` on throw,
   then `postMessage({type:"exit", code})` (0 unless an error fired). A server-shaped default
   export (no explicit `Bun.serve()` call) registers the same way but always reports **port 3000**.

Host side: `RunSession.port` (`number | null`) is set the moment `serve-listening` arrives and
survives hot reloads (a reload that lands on a different port updates it in place). `RunSession`
buffers events for late subscribers, resolves `fetch()` by `request.id`, emits
`run:started`/`run:ended`/`preview:ready`/`preview:servers` on the bus. Multiple concurrent
sessions each keep their own port — there is no single "the" server anymore. The **newest**
session to first register a handler becomes `activePreviewSession()` (back-compat: this is what
the bare `/preview/` route still targets); every session with `hasServer()` true is listed by
`toolchain.previewServers(): PreviewServer[]` (`{port, sessionId, entryPath}`), and
`resolveSessionForPort(port)` (src/toolchain/session.ts) is the shared router: an explicit port
picks the session bound to it (or `null` on a miss), `undefined` falls back to
`activePreviewSession()`. `preview:servers` fires whenever that live set changes (a session's
first listen, a reload that changes its port, or a stop).

### 6.4 Service worker (`public/sw.js`, plain JS, no imports)

Registered by `initToolchain()` as `/sw.js` (scope `/`). `fetch` handler: only intercept
same-origin paths starting `/preview/`.

**Routing**: `/preview/<port>/<path>` targets the session bound to `<port>` — the numeric first
path segment is parsed with `/^\/(\d+)(\/.*)?$/` against the path after the `/preview` prefix is
stripped, then BOTH the prefix and the port segment are stripped before the user handler sees the
URL (so it sees `/`, `/api/...` exactly as before). `/preview/<port>` with no trailing segment
maps to `/`. A non-numeric first segment — or no segment at all, i.e. the bare `/preview/<path>`
— carries no port (back-compat: resolves to the active/default session). For each request: build
`SerializedRequest` (adds `port?: number` from the parse above; `id = crypto.randomUUID()`),
`client = await self.clients.get(event.clientId)` falling back to the focused window client,
post `SwToPageMessage` (`{type, request, port}` — the port is on both the message and the nested
request for convenience) with a fresh `MessageChannel` port, await `PageToSwMessage` on it
(timeout 10 s → 504).

Page side lives in src/toolchain/sw-bridge.ts: a `navigator.serviceWorker` message listener
resolves the target session via `resolveSessionForPort(request.port)` (session.ts) and forwards
to `session.fetch(...)`. No session at all for the bare route → 503 styled "no server running"
page (unchanged). An explicit port with nothing bound to it → **502** styled "no server on port
N" page (lists the currently live ports via `previewServers()`).

---

## 7. Git (`src/git/`)

`src/git/index.ts` top-of-module (before anything else): `import { Buffer } from "buffer";
(globalThis as any).Buffer ??= Buffer;` — Bun's browser bundling does NOT rewrite bare `Buffer`
globals and isomorphic-git references it ~76×. Test with add/commit, not `git.version()`
(tree-shaking hides the failure in trivial smoke tests).

`GitAPI` wraps isomorphic-git with `fs: use("gitFs")`, `http` from `isomorphic-git/http/web`,
one shared `cache = {}` per repo dir (drop it after clone to release RAM, keep a fresh one for
status/log), `corsProxy: GIT_PROXY_PREFIX` on clone (persists to repo config; later fetch/push
auto-use it). `clone` defaults `singleBranch:true, depth:1, noTags:true`. `commit` always passes
an author (`getAuthor()` default `{name:"burrow", email:"burrow@localhost"}`). `stageAll` =
statusMatrix → `workdir===0 ? remove : add`. `discard` = `checkout({filepaths, force:true})` then
`fs:batch{reason:"git"}`. `headContent` = `resolveRef HEAD` + `readBlob` (catch NotFoundError →
null). There is NO textual diff API in isomorphic-git — UI diffs `headContent` vs `vfs.readFile`
with `@codemirror/merge`.

`src/git/proxy.ts` (server-side, no browser imports):

```ts
export async function handleGitProxy(req: Request): Promise<Response>
```

Upstream = `https://` + path after `/git-proxy/` + query. Forward method (GET|POST only, else 405),
headers `accept, content-type, authorization, git-protocol` + `user-agent: git/isomorphic-git`,
POST body verbatim (`req.arrayBuffer()`), `redirect: "follow"`. Respond with upstream
status/statusText, echo ONLY `content-type`, stream `upstream.body`. Never forward
`content-encoding`/`content-length` (fetch already decoded).

---

## 8. AI (`src/ai/`)

Worker-only transformers.js (NEVER import `@huggingface/transformers` in server code — its `node`
export condition pulls onnxruntime-node). `src/ai/worker.ts`:

```ts
const generator = await pipeline("text-generation", model, {
  dtype: model === AI_MODEL_DEFAULT ? "q4f16" : undefined,  // gemma repo config sets its own
  device: "webgpu",                                          // ALWAYS explicit (default is wasm)
  progress_callback: p => { if (p.status === "progress_total") post progress(0..1 from p.progress/100) },
});
const stopper = new InterruptableStoppingCriteria();          // missing from d.ts — cast to any
const streamer = new TextStreamer(generator.tokenizer, { skip_prompt: true, skip_special_tokens: true,
  callback_function: delta => post({type:"token", delta}) });
const out = await generator(messages, { max_new_tokens, do_sample: false, streamer, stopping_criteria: stopper });
post({type:"done", text: out[0].generated_text.at(-1)?.content});
```

Protocol = `AiWorkerRequest`/`AiWorkerResponse`. `AiPanelAPI.load` is lazy + idempotent; gate
`AI_MODEL_LARGE` behind `webgpuSupported()` and an explicit user click (~2.3 GB). Weights come
CORS-clean straight from huggingface.co and cache in the browser Cache API — the server proxies
nothing. Panel UI (owned here): message list, streaming render, stop button (`interrupt`),
one overall progress bar driven ONLY by `progress_total`. The panel may read `vfs` via registry
to inject the open file as context — keep prompts small (0.6B model).

---

## 9. UI (`src/ui/` + `index.html` + `server.ts`)

**server.ts** (`Bun.serve`, port `DEV_PORT` 4808, `development: { hmr: true, console: true }`):

```ts
routes: {
  "/":            index,                       // HTML import of ./index.html
  "/git-proxy/*": req => handleGitProxy(req),  // sanctioned import from src/git/proxy.ts
  "/sw.js":       () => new Response(Bun.file("public/sw.js"), { headers: { "content-type": "text/javascript" } }),
  "/bun.wasm":    () => new Response(Bun.file("bun.wasm"),    { headers: { "content-type": "application/wasm" } }),
  "/preview/*":   () => new Response("preview is served by the service worker — open the app first", { status: 503 }),
}
```

**bunfig.toml + build-plugins.ts + zlib-shim.ts** (UI owns): just-bash's browser bundle statically
imports `node:zlib`, which breaks `bun build`/HTML-import bundling. Fix per scout (verified):

```toml
[serve.static]
plugins = ["./src/ui/build-plugins.ts"]
```

plugin: `build.onResolve({ filter: /^node:zlib$/ }, () => ({ path: <abs zlib-shim.ts> }))`;
shim exports throwing `gzipSync`/`gunzipSync`, `constants = {}`, and a default. Only
gzip/gunzip/zcat commands lose function.

**Layout** (dark, fast, beautiful — single screen, CSS grid): left file tree; center CodeMirror 6
editor (`@codemirror/lang-javascript` with ts/tsx dialects) with tabs + dirty dots; right stack:
AI panel (top, container handed to `initAi`) + git panel; bottom: terminal (explicit-height
container handed to `initShell`) + console pane (RunnerEvents) + preview iframe
(`src=${PREVIEW_PREFIX}/<port>/`) as tabs, with a port switcher (`<select class=
"port-switcher__select">` inside `<span class="port-switcher">`, spliced into the preview panel's
`.pane-toolbar`) when more than one server is live — see src/ui/preview.ts. Statusbar: cwd, branch
(git.currentBranch), active session.

UI behaviors: editor saves via `vfs.writeFile` (WatchedFs emits the event; git panel refreshes
statusMatrix on `file:changed`/`fs:batch`, debounced). `editor:open` focuses/creates a tab. Diff
view: `@codemirror/merge` with `git.headContent(path)` vs buffer. Run button = `shell.exec(
"bun run " + activeFile, { echo: true })` so terminal and console tell one story. Buffers are
UTF-8 text; binary files (readFileBuffer sniff) render a placeholder.

---

## 10. Definition of done (per module)

- vfs: `bun test` proving WatchedFs event emission + GitFsAdapter error codes/stat shape
  (EEXIST on mkdir, ENOTDIR on readdir(file), stable ino, no-arg `readFile()` rejects).
- git: browser clone of a small public GitHub repo through `/git-proxy`, then status → add → commit → log.
- toolchain: `bun run` on a seeded multi-file ts+tsx project with an esm.sh dep; `Bun.serve` echo
  server reachable at `/preview/`.
- shell: `cd`/`export` persist; Ctrl+C aborts a `sleep 999`; `edit x.ts` opens the editor.
- ai: Qwen3-0.6B streams tokens; stop button interrupts; progress bar monotonic.
- ui: everything mounted, dark theme, no horizontal scroll, boots with zero console errors.
