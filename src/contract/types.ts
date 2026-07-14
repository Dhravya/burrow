/**
 * burrow — src/contract/types.ts
 * OWNED BY: architect. Builders import types from here; do NOT edit.
 * Cross-module access happens ONLY through these interfaces + ./registry.ts.
 */

// ============================================================================
// Constants
// ============================================================================

/** Bash home + project workspace root. All UI panes are rooted here. */
export const WORKSPACE_ROOT = "/home/user";
/** Dev server port (Bun.serve in src/ui/server.ts). */
export const DEV_PORT = 4808;
/** Same-origin git CORS proxy prefix (route in server.ts, handler in src/git/proxy.ts). */
export const GIT_PROXY_PREFIX = "/git-proxy";
/** Service-worker-intercepted preview path prefix (public/sw.js). */
export const PREVIEW_PREFIX = "/preview";

export const AI_MODEL_DEFAULT = "onnx-community/Qwen3-0.6B-ONNX"; // 570 MB q4f16
export const AI_MODEL_LARGE = "google/gemma-4-E2B-it-qat-mobile-transformers"; // ~2.5 GB QAT safetensors · custom WGSL kernels
export type AiModelId = typeof AI_MODEL_DEFAULT | typeof AI_MODEL_LARGE;

// ============================================================================
// VFS — canonical store is just-bash's InMemoryFs wrapped in WatchedFs (src/vfs/)
// ============================================================================

/** Mirrors just-bash FsStat (booleans are FIELDS here, not methods). */
export interface VfsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

export interface VfsDirent {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/**
 * The shared filesystem every module uses. Implemented by src/vfs/ WatchedFs,
 * a delegating decorator over just-bash's InMemoryFs that emits "file:changed"
 * events on every mutation. The SAME object instance is:
 *   - passed to `new Bash({ fs })` (it structurally satisfies just-bash IFileSystem),
 *   - provided to the registry as "vfs",
 *   - the backing store of the "gitFs" adapter.
 * Promise methods mirror just-bash IFileSystem exactly; the sync tail
 * (resolvePath/getAllPaths/writeFileSync/mkdirSync) mirrors InMemoryFs extras
 * and is the sync surface for the editor/file-tree.
 */
export interface BurrowVfs {
  readFile(path: string, encoding?: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array, encoding?: string): Promise<void>;
  appendFile(path: string, data: string | Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<VfsStat>;
  lstat(path: string): Promise<VfsStat>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes?(path: string): Promise<VfsDirent[]>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>;

  // ---- sync surface (editor / file tree / command helpers) ----
  resolvePath(base: string, path: string): string;
  getAllPaths(): string[];
  writeFileSync(path: string, data: string | Uint8Array): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

// ============================================================================
// GitFs — EXACT isomorphic-git flat promise-style fs (src/vfs/ provides "gitFs")
// ============================================================================

export type GitFsErrorCode = "ENOENT" | "EEXIST" | "ENOTDIR" | "ENOTEMPTY" | "EINVAL";

/** Every error thrown by GitFsPromises methods MUST have a `.code` set. */
export interface GitFsError extends Error {
  code: GitFsErrorCode;
}

/**
 * Stat shape isomorphic-git normalizes. is* are METHODS here (unlike VfsStat).
 * ALL numeric fields are mandatory real numbers — isomorphic-git computes each
 * `% 2**32`; a missing field becomes NaN and silently corrupts .git/index.
 * Use uid:1, gid:1, dev:1; ino must be STABLE per file; mode 0o100644 file /
 * 0o100755 exec / 0o40755 dir / 0o120000 symlink.
 */
export interface GitFsStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  size: number;
  ino: number;
  uid: number;
  gid: number;
  dev: number;
  mtimeMs: number;
  ctimeMs: number;
}

/** Both call forms occur: `{encoding:'utf8'}` AND the bare string 'utf8'. */
export type GitFsReadOptions = "utf8" | { encoding?: "utf8" } | undefined;
export type GitFsWriteOptions = "utf8" | { encoding?: "utf8"; mode?: number } | undefined;

/**
 * EXACT surface isomorphic-git binds (all 10 required methods, even
 * readlink/symlink — `bindFs` throws at `new FileSystem()` time if any is missing).
 *
 * IMPLEMENTATION RULES (verified against isomorphic-git 1.38.7):
 *  - Every method MUST be declared `async` (rejected promise, NEVER a sync throw):
 *    detection calls `fs.readFile()` with NO ARGS and requires a thenable back,
 *    or the fs gets misclassified as callback-style and pify-wrapped.
 *  - readFile: Uint8Array by default; string when options is {encoding:'utf8'}
 *    OR bare 'utf8'. Throw ENOENT (as GitFsError) when missing.
 *  - writeFile: parent dir may not exist on first call — throwing is fine
 *    (wrapper catches, mkdirs, retries once). options may carry {mode:0o777}.
 *  - mkdir: MUST throw EEXIST if exists, ENOENT if parent missing.
 *  - rmdir: throw ENOENT / ENOTDIR / ENOTEMPTY as appropriate.
 *  - unlink: throw ENOENT when missing.
 *  - readdir: BARE names (not paths); MUST throw ENOTDIR on a file.
 *  - stat/lstat: throw ENOENT when missing; return GitFsStats per above.
 *  - readlink: throw EINVAL on a non-symlink.
 *  - Pass to isomorphic-git as the flat `fs` param (NOT wrapped in {promises}).
 */
export interface GitFsPromises {
  readFile(path: string, options?: GitFsReadOptions): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string, options?: GitFsWriteOptions): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<GitFsStats>;
  lstat(path: string): Promise<GitFsStats>;
  readlink(path: string): Promise<string | Uint8Array>;
  symlink(target: string, path: string): Promise<void>;
  /** optional but nice: recursive delete fast-path */
  rm?(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

// ============================================================================
// Events
// ============================================================================

export type FileChangeKind = "created" | "modified" | "deleted";

export interface BurrowEventMap {
  /** Fine-grained, emitted by WatchedFs on every mutation (incl. .git/** — subscribers filter). */
  "file:changed": { kind: FileChangeKind; path: string };
  /** Coarse "something may have changed" hint; file tree re-scans via getAllPaths(). */
  "fs:batch": { reason: "shell-command" | "git" | "toolchain" | "seed" };
  /** Emitted by the shell driver whenever PWD changes after a command. */
  "cwd:changed": { cwd: string };
  /** `edit`/`open` commands + file-tree clicks. UI editor subscribes. */
  "editor:open": { path: string; line?: number; column?: number };
  "run:started": { sessionId: string; entryPath: string };
  "run:ended": { sessionId: string; exitCode: number };
  /** The default/active run session called Bun.serve — preview at PREVIEW_PREFIX is live. */
  "preview:ready": { sessionId: string };
  /** The live set of preview servers changed (a session started/stopped/reloaded a port). */
  "preview:servers": { servers: PreviewServer[] };
}

export interface EventBus {
  /** Returns an unsubscribe function. Handlers must not throw (bus swallows + console.error). */
  on<K extends keyof BurrowEventMap>(type: K, handler: (event: BurrowEventMap[K]) => void): () => void;
  emit<K extends keyof BurrowEventMap>(type: K, event: BurrowEventMap[K]): void;
}

// ============================================================================
// Shell command registry (just-bash custom commands)
// ============================================================================

/** Matches just-bash ExecResult. */
export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutKind?: "text" | "bytes";
}

/**
 * Matches just-bash CommandContext structurally. `fs` is the shared WatchedFs
 * (same object as registry "vfs"). `stdin` is a latin1 ByteString — decode with
 * decodeStdin() from ./registry.ts before treating it as UTF-8 text.
 */
export interface CommandContext {
  fs: BurrowVfs;
  cwd: string;
  env: Map<string, string>;
  stdin: string;
  /** Spawn sub-commands. `cwd` is REQUIRED by just-bash. */
  exec?: (
    cmdLine: string,
    options: { cwd: string; stdin?: string; env?: Record<string, string>; args?: string[]; signal?: AbortSignal },
  ) => Promise<ShellExecResult>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Registered via registry.registerShellCommand() BEFORE the shell boots
 * (boot order: vfs → git → toolchain → ai → shell → ui). The shell module
 * wraps each spec with just-bash `defineCommand(name, execute)` and passes
 * them as `customCommands` to `new Bash(...)`. Same-name specs shadow
 * builtins; `bun`, `git`, `edit`, `open`, `serve` are all free names.
 */
export interface CommandSpec {
  name: string;
  execute(args: string[], ctx: CommandContext): Promise<ShellExecResult>;
}

/** Programmatic access to the interactive terminal (provided by src/shell/). */
export interface ShellAPI {
  /**
   * Run a line through the SAME Bash instance + persisted {cwd, env} the
   * terminal uses. If echo, the command and its output render in the terminal.
   */
  exec(line: string, options?: { echo?: boolean; signal?: AbortSignal }): Promise<ShellExecResult>;
  getCwd(): string;
  /** Write raw text (ANSI ok, use \r\n) to the terminal. */
  print(text: string): void;
  focus(): void;
}

// ============================================================================
// Toolchain (bun.wasm transpiler + module-graph runner) — src/toolchain/
// ============================================================================

/** bun_wasm_transform loader arg: 0=js 1=jsx 2=ts 3=tsx */
export type BunLoader = 0 | 1 | 2 | 3;

export type TranspileResult =
  | { ok: true; code: string }
  | { ok: false; error: string }; // UTF-8 caret diagnostics from bun.wasm

export interface BuildError {
  path: string;
  message: string;
}

export interface BuiltModule {
  /** Absolute VFS path. */
  path: string;
  /** blob: URL of the transpiled, specifier-rewritten module. */
  blobUrl: string;
  /** original specifier -> resolved absolute VFS path or https://esm.sh/... URL */
  deps: Record<string, string>;
}

export type BuildGraphResult =
  | { ok: true; entryBlobUrl: string; modules: BuiltModule[] }
  | { ok: false; errors: BuildError[] };

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

/** Messages a RunSession surfaces to subscribers (console pane, `bun` command). */
export type RunnerEvent =
  | { type: "console"; level: ConsoleLevel; args: string[] } // pre-stringified in the worker
  | { type: "error"; kind: "uncaught" | "unhandled-rejection" | "import"; message: string; stack?: string }
  | { type: "serve-listening"; port: number }
  | { type: "exit"; code: number }; // top-level module evaluation settled

export interface SerializedRequest {
  id: string;
  method: string;
  /** Full URL as the user handler should see it (PREVIEW_PREFIX + port segment already stripped). */
  url: string;
  headers: [string, string][];
  body: Uint8Array | null;
  /** The numeric port segment parsed from /preview/<port>/..., if the request URL had one. */
  port?: number;
}

export interface SerializedResponse {
  id: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array | null;
}

/** postMessage protocol: host page -> run worker. */
export type HostToRunnerMessage = { type: "serve-request"; request: SerializedRequest };

/** postMessage protocol: run worker -> host page. */
export type RunnerToHostMessage = RunnerEvent | { type: "serve-response"; response: SerializedResponse };

/** postMessage protocol: service worker -> page (sent with a MessagePort to reply on). */
export type SwToPageMessage = { type: "preview-request"; request: SerializedRequest; port?: number };
/** Reply posted back on the provided MessagePort. */
export type PageToSwMessage = { type: "preview-response"; response: SerializedResponse };

export interface RunSession {
  readonly id: string;
  readonly entryPath: string;
  /** The port this session's Bun.serve is bound to; null until serve-listening fires. */
  readonly port: number | null;
  /** Subscribe to runner events; returns unsubscribe. Late subscribers replay buffered events. */
  onEvent(handler: (event: RunnerEvent) => void): () => void;
  /** True once serve-listening was received. */
  hasServer(): boolean;
  /** Forward a preview request to the session's Bun.serve fetch handler. Rejects if !hasServer(). */
  fetch(request: SerializedRequest): Promise<SerializedResponse>;
  /** Terminate the worker. Emits {type:"exit"} if not already exited. */
  stop(): void;
}

/** One live `/preview/<port>/` target — a run session that has called Bun.serve. */
export interface PreviewServer {
  port: number;
  sessionId: string;
  entryPath: string;
}

export interface RunOptions {
  /** argv exposed to user code (reserved; default []). */
  args?: string[];
}

export interface ToolchainAPI {
  /** Idempotent: loads + _initialize()s the bun.wasm singleton. */
  ready(): Promise<void>;
  /** .js→0 .jsx→1 .ts/.mts/.cts→2 .tsx→3 (default 2 for extensionless). */
  loaderForPath(path: string): BunLoader;
  transpileSource(source: string, loader: BunLoader): Promise<TranspileResult>;
  transpileFile(path: string): Promise<TranspileResult>;
  /** Resolve+transpile the whole graph, rewrite specifiers, mint blob: URLs bottom-up. */
  buildGraph(entryPath: string): Promise<BuildGraphResult>;
  /** buildGraph + spawn a dedicated module Worker. Emits run:started on the bus. */
  run(entryPath: string, options?: RunOptions): Promise<RunSession>;
  /** The session whose Bun.serve currently backs bare /preview/*, if any (latest serve-listening wins). */
  activePreviewSession(): RunSession | null;
  /** Every live `/preview/<port>/` target, oldest first. */
  previewServers(): PreviewServer[];
  stopAll(): void;
}

// ============================================================================
// Git — src/git/ (isomorphic-git over registry "gitFs")
// ============================================================================

/** statusMatrix row: [filepath, head 0|1, workdir 0|1|2, stage 0|1|2|3] */
export type GitStatusRow = [filepath: string, head: 0 | 1, workdir: 0 | 1 | 2, stage: 0 | 1 | 2 | 3];

export interface GitAuthor {
  name: string;
  email: string;
  timestamp?: number; // seconds
  timezoneOffset?: number; // minutes
}

export interface GitLogEntry {
  oid: string;
  message: string;
  parent: string[];
  author: { name: string; email: string; timestamp: number; timezoneOffset: number };
}

export interface GitProgress {
  phase: string;
  loaded: number;
  total?: number;
}

export interface GitAuth {
  username: string;
  password: string;
}

/**
 * All methods default dir to WORKSPACE_ROOT; the `git` shell command passes
 * ctx.cwd. Implementations share ONE `cache = {}` per dir and always pass
 * corsProxy: GIT_PROXY_PREFIX on clone. commit() falls back to getAuthor()
 * (default { name:"burrow", email:"burrow@localhost" }) — NEVER call
 * isomorphic-git commit without an explicit author.
 */
export interface GitAPI {
  clone(options: {
    url: string;
    dir?: string;
    depth?: number;
    singleBranch?: boolean;
    noTags?: boolean;
    onProgress?: (p: GitProgress) => void;
    onMessage?: (m: string) => void;
    onAuth?: (url: string) => GitAuth | Promise<GitAuth>;
  }): Promise<void>;
  init(dir?: string): Promise<void>;
  statusMatrix(dir?: string): Promise<GitStatusRow[]>;
  /** Single-file porcelain status, e.g. "*modified". */
  status(filepath: string, dir?: string): Promise<string>;
  /** git add <paths> (accepts "." ). Does NOT stage deletions. */
  stage(filepath: string | string[], dir?: string): Promise<void>;
  /** "git add -A": statusMatrix rows → workdir===0 ? remove() : add(). */
  stageAll(dir?: string): Promise<void>;
  /** Index-only removal (stages a deletion). */
  unstageDelete(filepath: string, dir?: string): Promise<void>;
  commit(message: string, author?: GitAuthor, dir?: string): Promise<string>; // full 40-char sha
  log(options?: { depth?: number; dir?: string }): Promise<GitLogEntry[]>;
  currentBranch(dir?: string): Promise<string | undefined>;
  /** HEAD blob content for a path; null if the path is absent in HEAD. */
  headContent(filepath: string, dir?: string): Promise<Uint8Array | null>;
  /** Restore files from index/HEAD — checkout({ filepaths, force:true }). Emits fs:batch{reason:"git"}. */
  discard(filepaths: string[], dir?: string): Promise<void>;
  setAuthor(author: GitAuthor): void;
  getAuthor(): GitAuthor;
}

// ============================================================================
// AI panel — src/ai/ (transformers.js in a module Worker)
// ============================================================================

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiLoadProgress {
  /** Drive the bar from "progress_total" events only (0..1 here). */
  fraction: number;
  loadedBytes?: number;
  totalBytes?: number;
  detail?: string;
}

export type AiState = "unsupported" | "idle" | "loading" | "ready" | "generating" | "error";

export interface AiGenerationHandle {
  /** InterruptableStoppingCriteria.interrupt() in the worker. */
  cancel(): void;
  /** Resolves with the full assistant text (also delivered via onDelta). */
  done: Promise<string>;
}

export interface AiPanelAPI {
  getState(): AiState;
  /** navigator.gpu presence + adapter check. */
  webgpuSupported(): Promise<boolean>;
  /** Idempotent per model. Default model: AI_MODEL_DEFAULT. */
  load(model?: AiModelId, onProgress?: (p: AiLoadProgress) => void): Promise<void>;
  generate(
    messages: ChatMessage[],
    onDelta: (delta: string) => void,
    options?: { maxNewTokens?: number },
  ): AiGenerationHandle;
}

/** postMessage protocol: page -> AI worker. */
export type AiWorkerRequest =
  | { type: "load"; model: AiModelId }
  | { type: "generate"; messages: ChatMessage[]; maxNewTokens?: number }
  | { type: "interrupt" };

/** postMessage protocol: AI worker -> page. */
export type AiWorkerResponse =
  | { type: "progress"; progress: AiLoadProgress }
  | { type: "ready" }
  | { type: "token"; delta: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

// ============================================================================
// Service registry shape (see ./registry.ts)
// ============================================================================

export interface Services {
  events: EventBus;
  vfs: BurrowVfs;
  gitFs: GitFsPromises;
  toolchain: ToolchainAPI;
  git: GitAPI;
  shell: ShellAPI;
  ai: AiPanelAPI;
}
