import type { AiPanelAPI, BurrowVfs, ChatMessage, EventBus, GitAPI } from "../contract/types.ts";
import { WORKSPACE_ROOT } from "../contract/types.ts";
import type { CommandScope, RankedCommand } from "./command-memory.ts";
import { CommandMemory } from "./command-memory.ts";

export type SuggestionOrigin = "history" | "transition" | "project" | "general" | "ai";

export interface ShellSuggestionRequest {
  line: string;
  cwd: string;
  signal: AbortSignal;
}

export type ShellSuggestionEmitter = (command: string, origin: SuggestionOrigin) => void;
export type ShellSuggestionProvider = (
  request: ShellSuggestionRequest,
  emit: ShellSuggestionEmitter,
) => Promise<void>;

export interface ProjectCompletionContext extends CommandScope {
  relativeCwd: string;
  files: string[];
  projectCandidates: string[];
  packageScripts: string[];
  branch?: string;
  revision: number;
}

const GENERAL_COMMANDS = [
  "ls",
  "ls -la",
  "pwd",
  "clear",
  "git status",
  "git diff",
  "git log",
  "git branch",
  "bun install",
  "bun test",
  "bun run dev",
  "workspace info",
] as const;

const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const AI_DELAY_MS = 360;
const AI_MAX_NEW_TOKENS = 56;
const MAX_FILES = 80;
const MAX_AI_CACHE = 100;

function normalizeDir(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/, "") || "/";
}

function parentDir(path: string): string {
  const clean = normalizeDir(path);
  if (clean === "/") return "/";
  const index = clean.lastIndexOf("/");
  return index <= 0 ? "/" : clean.slice(0, index);
}

function join(dir: string, name: string): string {
  return `${normalizeDir(dir)}/${name}`.replace(/^\/\//, "/");
}

function relativePath(root: string, path: string): string {
  const base = normalizeDir(root);
  if (path === base) return ".";
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return path;
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

async function safeExists(vfs: BurrowVfs, path: string): Promise<boolean> {
  try {
    return await vfs.exists(path);
  } catch {
    return false;
  }
}

async function findNearest(vfs: BurrowVfs, cwd: string, child: string): Promise<string | null> {
  let dir = normalizeDir(cwd);
  const floor = normalizeDir(WORKSPACE_ROOT);
  while (dir === floor || dir.startsWith(`${floor}/`)) {
    if (await safeExists(vfs, join(dir, child))) return dir;
    if (dir === floor) break;
    dir = parentDir(dir);
  }
  return null;
}

function sanitizeRemote(raw: string): string | null {
  const remote = raw.trim();
  if (!remote) return null;
  try {
    if (/^https?:\/\//i.test(remote)) {
      const url = new URL(remote);
      url.username = "";
      url.password = "";
      url.hash = "";
      url.search = "";
      return url.toString().replace(/\/$/, "").replace(/\.git$/, "");
    }
  } catch {
    return null;
  }
  if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(remote)) return remote.replace(/\.git$/, "");
  return null;
}

async function projectIdentity(vfs: BurrowVfs, projectRoot: string, hasGit: boolean): Promise<string> {
  if (hasGit) {
    try {
      const config = await vfs.readFile(join(projectRoot, ".git/config"));
      const match = /^\s*url\s*=\s*(.+)$/im.exec(config);
      const remote = match ? sanitizeRemote(match[1]!) : null;
      if (remote) return `git:${remote}`;
    } catch {
    }
    return `git-path:${projectRoot}`;
  }
  return `workspace:${projectRoot}`;
}

function directChild(path: string, cwd: string): string | null {
  const prefix = `${normalizeDir(cwd)}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  return rest && !rest.includes("/") ? rest : null;
}

function shellWord(value: string): string | null {
  if (!value || /[\x00-\x1f\x7f-\x9f]/.test(value)) return null;
  return value.replace(/([^A-Za-z0-9_@%+=:,./-])/g, "\\$1");
}

export class ProjectCompletionContextProvider {
  readonly #vfs: BurrowVfs;
  readonly #git: GitAPI | undefined;
  readonly #cache = new Map<string, Promise<ProjectCompletionContext>>();
  readonly #off: Array<() => void> = [];
  #revision = 0;

  constructor(vfs: BurrowVfs, events: EventBus, git?: GitAPI) {
    this.#vfs = vfs;
    this.#git = git;
    const invalidate = (): void => {
      this.#revision++;
      this.#cache.clear();
    };
    this.#off.push(events.on("file:changed", invalidate));
    this.#off.push(
      events.on("fs:batch", (event) => {
        if (event.reason !== "shell-command") invalidate();
      }),
    );
  }

  get(cwd: string): Promise<ProjectCompletionContext> {
    const normalized = normalizeDir(cwd);
    const key = `${this.#revision}\0${normalized}`;
    let pending = this.#cache.get(key);
    if (!pending) {
      pending = this.#build(normalized, this.#revision);
      this.#cache.set(key, pending);
      pending.catch(() => this.#cache.delete(key));
    }
    return pending;
  }

  dispose(): void {
    for (const off of this.#off) off();
    this.#off.length = 0;
    this.#cache.clear();
  }

  async #build(cwd: string, revision: number): Promise<ProjectCompletionContext> {
    const [gitRoot, packageRoot] = await Promise.all([
      findNearest(this.#vfs, cwd, ".git"),
      findNearest(this.#vfs, cwd, "package.json"),
    ]);
    const projectRoot = gitRoot ?? packageRoot ?? WORKSPACE_ROOT;
    const hasGit = gitRoot !== null;
    const projectKey = await projectIdentity(this.#vfs, projectRoot, hasGit);
    const packageScripts: string[] = [];
    const projectCandidates = new Set<string>();

    if (packageRoot !== null) {
      try {
        const manifest = JSON.parse(await this.#vfs.readFile(join(packageRoot, "package.json"))) as {
          scripts?: Record<string, unknown>;
        };
        for (const name of Object.keys(manifest.scripts ?? {}).sort()) {
          if (typeof manifest.scripts?.[name] !== "string") continue;
          packageScripts.push(name);
          projectCandidates.add(`bun run ${name}`);
          if (name === "test") projectCandidates.add("bun test");
        }
        projectCandidates.add("bun install");
      } catch {
      }
    }

    if (hasGit) {
      projectCandidates.add("git status");
      projectCandidates.add("git diff");
      projectCandidates.add("git log");
      projectCandidates.add("git branch");
    }

    const allPaths = this.#vfs
      .getAllPaths()
      .filter(
        (path) =>
          (path === projectRoot || path.startsWith(`${projectRoot}/`)) &&
          !/(^|\/)(?:\.git|node_modules)(?:\/|$)/.test(path),
      );

    for (const path of allPaths) {
      const child = directChild(path, cwd);
      if (!child) continue;
      const word = shellWord(child);
      if (!word) continue;
      try {
        const stat = await this.#vfs.stat(path);
        if (stat.isDirectory) projectCandidates.add(`cd ${word}`);
        else if (stat.isFile) {
          projectCandidates.add(`edit ${word}`);
          if (SCRIPT_EXT.test(child)) projectCandidates.add(`bun run ${word}`);
        }
      } catch {
      }
    }

    const files = allPaths
      .map((path) => relativePath(projectRoot, path))
      .filter((path) => path !== ".")
      .sort((a, b) => {
        const aNear = directChild(join(projectRoot, a), cwd) ? 0 : 1;
        const bNear = directChild(join(projectRoot, b), cwd) ? 0 : 1;
        return aNear - bNear || pathDepth(a) - pathDepth(b) || a.localeCompare(b);
      })
      .slice(0, MAX_FILES);

    let branch: string | undefined;
    if (hasGit && this.#git) {
      try {
        branch = await this.#git.currentBranch(projectRoot);
      } catch {
        branch = undefined;
      }
    }

    return {
      projectKey,
      projectRoot,
      cwd,
      relativeCwd: relativePath(projectRoot, cwd),
      files,
      projectCandidates: [...projectCandidates],
      packageScripts,
      branch,
      revision,
    };
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const done = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/gi, "");
}

export function parseAiCommand(raw: string, prefix: string): string | null {
  let text = stripThinking(raw).trim();
  text = text.replace(/^```(?:bash|sh|shell)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return null;
  let command = first.replace(/^(?:command|suggestion)\s*:\s*/i, "").trim();
  if (
    (command.startsWith("`") && command.endsWith("`")) ||
    (command.startsWith('"') && command.endsWith('"')) ||
    (command.startsWith("'") && command.endsWith("'"))
  ) {
    command = command.slice(1, -1).trim();
  }
  if (!command || command.length > 800 || /[\x00-\x1f\x7f-\x9f]/.test(command)) return null;
  if (!command.startsWith(prefix) || command === prefix) return null;
  return command;
}

function messagesForAi(
  line: string,
  context: ProjectCompletionContext,
  ranked: RankedCommand[],
  memory: CommandMemory,
): ChatMessage[] {
  const recent = memory.recentFor(context, 12).map((run) => ({
    command: run.command,
    cwd: relativePath(context.projectRoot, run.cwd),
    exitCode: run.exitCode,
  }));
  const last = memory.lastRun(context);
  const payload = {
    prefix: line,
    cwd: context.relativeCwd,
    branch: context.branch ?? null,
    packageScripts: context.packageScripts,
    candidates: ranked.slice(0, 8).map((item) => item.command),
    recent,
    lastCommand: last ? { command: last.command, exitCode: last.exitCode } : null,
    files: context.files,
  };
  return [
    {
      role: "system",
      content:
        "You autocomplete one command for Burrow's local bash shell. Return exactly ONE complete single-line command and nothing else. It MUST begin byte-for-byte with the provided prefix. Prefer commands supported by the listed files, scripts, history, cwd, and candidates. Never add markdown, explanations, newlines, or execute anything. Avoid destructive commands unless the exact command appears in recent history.",
    },
    {
      role: "user",
      content: `Choose the best full command for this JSON context:\n${JSON.stringify(payload)}\n/no_think`,
    },
  ];
}

export function createHybridSuggestionProvider(options: {
  memory: CommandMemory;
  context: ProjectCompletionContextProvider;
  ai?: AiPanelAPI;
  aiDelayMs?: number;
}): ShellSuggestionProvider {
  const aiCache = new Map<string, string>();

  return async (request, emit): Promise<void> => {
    if (request.signal.aborted || !request.line.trim() || request.line !== request.line.trimStart()) return;
    const context = await options.context.get(request.cwd);
    if (request.signal.aborted) return;

    const ranked = options.memory.rank({
      ...context,
      prefix: request.line,
      projectCandidates: context.projectCandidates,
      generalCandidates: GENERAL_COMMANDS,
      limit: 8,
    });
    const local = ranked[0];
    if (local) emit(local.command, local.source);

    const ai = options.ai;
    if (!ai) return;
    const key = `${context.projectKey}\0${context.cwd}\0${context.revision}\0${options.memory.revision}\0${request.line}`;
    const cached = aiCache.get(key);
    if (cached) {
      emit(cached, "ai");
      return;
    }

    try {
      await abortableDelay(options.aiDelayMs ?? AI_DELAY_MS, request.signal);
    } catch {
      return;
    }
    if (request.signal.aborted || ai.getState() !== "ready") return;

    const handle = ai.generate(messagesForAi(request.line, context, ranked, options.memory), () => {}, {
      maxNewTokens: AI_MAX_NEW_TOKENS,
      priority: "background",
    });
    const cancel = (): void => handle.cancel();
    request.signal.addEventListener("abort", cancel, { once: true });
    try {
      const command = parseAiCommand(await handle.done, request.line);
      if (!command || request.signal.aborted) return;
      aiCache.set(key, command);
      if (aiCache.size > MAX_AI_CACHE) aiCache.delete(aiCache.keys().next().value as string);
      emit(command, "ai");
    } catch {
    } finally {
      request.signal.removeEventListener("abort", cancel);
    }
  };
}
