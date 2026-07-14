# Compatibility

An honest scoreboard of what Burrow supports today. Everything marked ✅ is
implemented in this repo and covered by `bun test` (342 tests) unless noted
otherwise. 🟡 means it works with real caveats. ❌ means it does not exist yet
— no promises attached.

Legend: ✅ works · 🟡 partial · ❌ not yet

---

## 1. Shell commands

The terminal is [just-bash](https://www.npmjs.com/package/just-bash) (a bash
interpreter in JS, browser build) over Burrow's in-memory VFS, plus commands
Burrow registers itself.

### Burrow commands

| Command | Status | Notes |
|---|---|---|
| `bun run <file>` / `bun <file>` | ✅ | Transpile + execute in a worker; `--no-hot` opts out of hot reload |
| `bun build <file>` | ✅ | Resolves the module graph and prints it (no bundle output file) |
| `bun stop` | ✅ | Stops every running session |
| `bun install` / `bun i` | ✅ | See [§4](#4-package-manager) |
| `bun add <pkg[@range]>` `[--dev]` | ✅ | Updates package.json format-preservingly |
| `bun remove <pkg>` / `bun rm` | ✅ | Drops package.json entry, `node_modules/<name>`, lock pins |
| `bun test`, `bun x`, `bun init`, `bun create`, `bun update`, `bun link`, … | ❌ | Print an explicit "not available in Burrow" error |
| `serve [file]` | ✅ | Runs an entry expected to serve HTTP (probes `./index.ts`, `./server.ts`, `./index.tsx`, `./index.js` in order) |
| `git clone` | 🟡 | Real smart-HTTP clone through the `/git-proxy` relay, but always shallow (depth 1, single branch, no tags); no auth from the CLI, so public repos only |
| `git init` / `status` / `add` / `commit -m` / `log [-n]` / `branch` | ✅ | Backed by isomorphic-git; `add .` does not stage deletions (`add -A` does) |
| `git diff [path…]` | 🟡 | HEAD vs. working tree only — no `--cached` |
| `git checkout -- <path…>` | 🟡 | Discard-to-HEAD only; branch switching is not supported |
| `git push` / `pull` / `fetch` / `merge` / `stash` / `tag` / `remote` | ❌ | |
| `edit <file[:line[:col]]>` / `open` | ✅ | Opens the file in the editor pane |
| `workspace info` / `workspace reset` | ✅ | Persistence status / wipe-and-reseed the workspace |

### just-bash built-ins

Bash syntax works: pipes, redirection, globs, variables, `$(…)` command
substitution, conditionals/loops, `cd`, `export`, aliases, history (in-memory
only — lost on reload), Ctrl+C interrupt, and tab completion for files and
command names (completion only triggers with the cursor at end of line).

Available commands:

`echo` `cat` `printf` `ls` `mkdir` `rmdir` `touch` `rm` `cp` `mv` `ln`
`chmod` `pwd` `readlink` `head` `tail` `wc` `stat` `grep` `fgrep` `egrep`
`rg` `sed` `awk` `sort` `uniq` `comm` `cut` `paste` `tr` `rev` `nl` `fold`
`expand` `unexpand` `strings` `split` `column` `join` `tee` `find`
`basename` `dirname` `tree` `du` `env` `printenv` `alias` `unalias`
`history` `xargs` `true` `false` `clear` `bash` `sh` `jq` `base64` `diff`
`date` `sleep` `timeout` `seq` `expr` `md5sum` `sha1sum` `sha256sum` `file`
`html-to-markdown` `help` `which` `tac` `hostname` `od` `gzip` `gunzip`
`zcat` `time` `whoami`

Not available (verified against the browser build Burrow ships): `curl`
(just-bash only enables it with a network configuration Burrow doesn't pass),
`tar`, `yq`, `xan`, `sqlite3`, `python3`/`python`, `js-exec`. There is no
`node` command either — use `bun run`.

---

## 2. Bun APIs

Code run with `bun run` executes in a dedicated Web Worker. The `Bun` global
installed there is `{ serve, env, version }` — nothing else. `import … from
"bun"` resolves to a shim exporting `serve` and `env`.

| API | Status | Notes |
|---|---|---|
| `Bun.serve({ fetch })` | 🟡 | The `fetch` handler is fully wired to the `/preview` bridge (POST bodies, headers, hot reload — all tested). `routes`, `websocket`, `port`, TLS options are **not** supported: anything without `options.fetch` throws. `server.stop()` only unregisters the handler; the preview slot stays claimed until `bun stop` |
| `export default app` (Hono / any `{ fetch }` object) | ✅ | Detected and registered on the preview bridge exactly like `Bun.serve` (tested, including class-vs-function edge cases) |
| `export default (req) => Response` | ✅ | Bare request handler works too |
| `Bun.env` | 🟡 | Exists, always `{}` — there is no `.env` loading |
| `Bun.version` | ✅ | Reports the sandbox version string, not a real Bun version |
| `Bun.file` | ❌ | Run workers have no filesystem access yet (planned via a SharedArrayBuffer bridge to the VFS) |
| `Bun.write` / `Bun.spawn` / `Bun.$` | ❌ | |
| `bun:sqlite` | ❌ | Any `bun:*` import is a build error: "Bun builtins are not available in the browser sandbox" |
| `bun:test` / `bun:ffi` / `bun:jsc` | ❌ | Same hard error |
| `fetch`, `WebSocket` (client), `crypto.subtle`, timers, … | ✅ | Standard worker globals — real browser implementations |

Transpilation itself is the real thing: TS/TSX/JS/JSX go through Bun's actual
transpiler compiled to WASM (`bun.wasm`).

---

## 3. node:* compat

The module graph resolver redirects `node:x` (and bare `x` for core names) to
in-repo shims. Three tiers, exactly as implemented in
`src/toolchain/node-builtins.ts` (behavior-tested by executing the shim
sources in `node-builtins.test.ts`):

### ✅ Full — real browser-backed implementations

`events` · `path` (+ `path/posix`, `path/win32`) · `url` · `querystring` ·
`util` (+ `sys`) · `assert` (+ `assert/strict`) · `process` · `os` ·
`buffer` · `string_decoder` · `punycode` · `timers` · `timers/promises` ·
`perf_hooks` · `async_hooks` · `crypto` · `stream` · `stream/promises` ·
`constants` · `tty` · `diagnostics_channel`

Caveats within "full":

- `crypto` 🟡 — `webcrypto`/`subtle`, `randomBytes`/`randomUUID`/`randomInt`,
  `timingSafeEqual`, and synchronous `createHash`/`createHmac` for **sha1 and
  sha256 only**. No ciphers, no `sign`/`verify`, no `pbkdf2`.
- `stream` 🟡 — simplified Readable/Writable/Transform (event-based; no real
  backpressure semantics).
- `process` 🟡 — `env` is empty, `stdout.write` maps to `console.log`,
  `platform` is `"browser"`.

### 🟡 Net — mapped onto fetch()

- `http` / `https` — client only (`request`, `get`, `ClientRequest`,
  `IncomingMessage`, `Agent`). `http.createServer` throws with a pointer to
  `Bun.serve`/`export default { fetch }`.

### ❌ Stubs — import succeeds, calls throw a precise error

`fs` · `fs/promises` · `child_process` · `net` · `tls` · `dgram` · `dns` ·
`http2` · `cluster` · `worker_threads` · `vm` · `v8` · `inspector` · `repl`
· `readline` · `zlib` · `module` (`createRequire` returns a thrower)

The stub design is deliberate: packages that merely *import* these modules
load fine and only fail if they actually call into them (optional-dependency
degradation is tested). An unknown `node:` specifier is a build error.

---

## 4. Package manager

`bun install` / `add` / `remove` is a browser-native npm client
(`src/npm/`), including a live end-to-end test that installs `ms` from the
real registry and executes it.

| Feature | Status | Notes |
|---|---|---|
| Registry resolution | ✅ | Abbreviated packuments from `registry.npmjs.org` — single hardcoded registry |
| Semver ranges, exact pins, dist-tags | ✅ | `maxSatisfying`, deterministic plans, cycle-safe dedupe |
| Transitive dependency graph | ✅ | deps + devDeps of the root; deps of everything below |
| Flat hoisted `node_modules` | ✅ | Version conflicts nest under their dependents |
| Lockfile (`burrow-lock.json`) | ✅ | A fully-locked install performs **zero** packument fetches; a stale pin releases only that name to the network (tested) |
| Tarball integrity (npm SRI) | ✅ | sha512/384/256/1 verified via `crypto.subtle`; mismatch fails the install, unsupported algorithms warn (tested) |
| Tarball extraction | ✅ | Hand-rolled ustar parser; path-traversal entries dropped, exec bits preserved |
| `--dev`, package.json round-trip | ✅ | Key order, indent, trailing newline preserved |
| Peer dependencies | 🟡 | Surfaced as warnings, never auto-installed |
| Optional dependencies | 🟡 | Dropped from the graph (their absence degrades gracefully at require time) |
| Lifecycle scripts (postinstall, …) | ❌ | Packages that rely on them (esbuild, sharp, husky) install but won't work |
| Bin linking (`node_modules/.bin`) | ❌ | Installed CLIs can't be run from the terminal |
| `bunx` / `bun x` | ❌ | |
| Workspaces / monorepos | ❌ | |
| `git:` / `file:` / `link:` / alias specs | ❌ | Throw for direct deps; warn + skip for transitive ones |
| `.npmrc`, scoped registries, auth tokens | ❌ | |
| `bun update` / `outdated` / `--frozen-lockfile` | ❌ | |
| Offline tarball cache | ❌ | Every install re-downloads |

Escape hatch: imports that aren't in `node_modules` fall back to
`https://esm.sh` at build time (version pinned from the nearest
package.json), so `bun run` works even without an install — but it needs
network access.

---

## 5. Networking model

There is no network stack — Burrow maps everything onto browser primitives:

- **`/preview/*` — service-worker loopback.** `public/sw.js` intercepts
  same-origin `/preview/*` requests and forwards each over a MessageChannel
  to the page, which hands it to the running worker's fetch handler. This is
  how `Bun.serve` "listens": no port is ever bound (`server.port` is 0).
  Requests time out after 10 s (504); no running server yields a 503 page.
  Bodies, headers, and null-body statuses are handled (tested against the
  real sw.js source).
- **`/git-proxy/*` — server-side CORS relay for git smart-HTTP.** GET/POST
  only, forwards a whitelist of headers, refuses localhost/127.x targets.
  Used by `git clone`; exists on the dev server (`server.ts`) — a static
  deploy needs to provide its own.
- **Outbound `fetch` / `WebSocket` (client)** from user code is the
  browser's own — cross-origin requests are subject to CORS.
- **No raw TCP/UDP.** `node:net`/`tls`/`dgram` are throwing stubs. No
  inbound connections of any kind; nothing outside your browser tab can
  reach a Burrow "server".
- **No `/proxy/:port` relay.** A guest-port bridge is designed (for a future
  in-browser Linux VM) but not implemented.

---

## 6. Known limitations

| Area | Limitation |
|---|---|
| Module graph | ESM import cycles are a hard build error |
| Module graph | Import specifiers are extracted from transpiled output with regexes — string literals that look exactly like imports can confuse it |
| Runtime | Uninstalled bare imports need network access to esm.sh at build time |
| Bun.serve | `routes`, `websocket`, `port` options unsupported; only `options.fetch` |
| Preview | 10 s handler timeout; after "listening", later console output goes to the console pane, not the terminal |
| Filesystem | Run workers can't touch the VFS (`node:fs` throws, no `Bun.file`) — files are only reachable from the shell/editor/git |
| Persistence | Workspace snapshots to IndexedDB; two tabs on the same origin silently clobber each other (last save wins) |
| Persistence | Shell history and the git author (`user.name`/`email`) are in-memory only — reset on reload |
| Git | Shallow clone only; no push/pull/fetch/branch-switching/merge; private repos can't be cloned from the terminal |
| npm | No lifecycle scripts, no `.bin`, no workspaces (see §4) |
| Editor | Syntax highlighting for the JS/TS family only; dark theme only |
