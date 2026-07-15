import { AI_MODEL_DEFAULT, WORKSPACE_ROOT } from "../contract/types.ts";
import type { AiModelId, AiPanelAPI, BurrowVfs, ChatMessage, EventBus, GitAPI } from "../contract/types.ts";
import type { CommandRetrieval, CommandScope, RankedCommand } from "./command-memory.ts";
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

export interface CompletionDirectoryEntry {
  name: string;
  kind: "file" | "directory" | "symlink";
}

export interface CompletionDirectoryContext {
  path: string;
  relativePath: string;
  entries: CompletionDirectoryEntry[];
}

export interface ProjectCompletionContext extends CommandScope {
  relativeCwd: string;
  projectMarkers: string[];
  projectCommands: string[];
  currentDirectory: CompletionDirectoryContext;
  relevantDirectory?: CompletionDirectoryContext;
  pathCandidates: string[];
  branch?: string;
  revision: number;
}

interface ProjectRoots {
  projectRoot: string;
  gitRoot: string | null;
  markers: string[];
}

interface ShellWordToken {
  value: string;
  start: number;
  end: number;
}

interface ParsedShellInput {
  command: string;
  words: ShellWordToken[];
  active: ShellWordToken;
  activeIndex: number;
}

interface DirectoryRequest {
  path: string;
  leafPrefix: string;
  renderedBase: string;
}

type PathKind = "file" | "directory" | "script" | "any";

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Makefile",
  "Justfile",
  "Taskfile.yml",
  "Taskfile.yaml",
  "deno.json",
  "deno.jsonc",
  "composer.json",
  "Gemfile",
  "Rakefile",
  "mix.exs",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradlew",
  "CMakeLists.txt",
  "Dockerfile",
  "compose.yml",
  "compose.yaml",
] as const;

const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const AI_DELAY_MS = 360;
const MAX_DIRECTORY_ENTRIES = 48;
const MAX_PROJECT_COMMANDS = 40;
const MAX_AI_CACHE = 100;
const NO_SUGGESTION = "NO_SUGGESTION";
const FILE_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "edit", "open", "source", "."]);
const DIRECTORY_COMMANDS = new Set(["cd", "pushd", "rmdir"]);
const ANY_PATH_COMMANDS = new Set(["ls", "find", "du", "tree", "stat", "file", "rm", "cp", "mv", "touch", "mkdir"]);
const CONTEXT_COMMANDS = new Set([
  ".", "awk", "bun", "cargo", "cat", "cd", "chmod", "cmake", "composer", "cp", "curl", "deno", "docker",
  "echo", "edit", "file", "find", "git", "go", "grep", "head", "jq", "just", "less", "ln", "ls", "make",
  "mkdir", "mv", "node", "npm", "npx", "open", "pnpm", "poetry", "printf", "pwd", "python", "python3", "rg",
  "rm", "rmdir", "sed", "sort", "source", "stat", "tail", "tar", "task", "touch", "tree", "uniq", "uv",
  "wget", "xargs", "yarn",
]);

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

function cleanLine(value: string, max = 240): string | null {
  const line = value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
  if (!line) return null;
  return line.slice(0, max);
}

async function safeExists(vfs: BurrowVfs, path: string): Promise<boolean> {
  try {
    return await vfs.exists(path);
  } catch {
    return false;
  }
}

async function safeRead(vfs: BurrowVfs, path: string): Promise<string | null> {
  try {
    return await vfs.readFile(path);
  } catch {
    return null;
  }
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

async function projectIdentity(
  vfs: BurrowVfs,
  projectRoot: string,
  gitRoot: string | null,
): Promise<string> {
  if (gitRoot !== null) {
    const config = await safeRead(vfs, join(gitRoot, ".git/config"));
    const match = config ? /^\s*url\s*=\s*(.+)$/im.exec(config) : null;
    const remote = match ? sanitizeRemote(match[1]!) : null;
    const base = remote ? `git:${remote}` : `git-path:${gitRoot}`;
    const subproject = relativePath(gitRoot, projectRoot);
    return subproject === "." ? base : `${base}#${subproject}`;
  }
  return `workspace:${projectRoot}`;
}

async function findProjectRoots(vfs: BurrowVfs, cwd: string): Promise<ProjectRoots> {
  const floor = normalizeDir(WORKSPACE_ROOT);
  let dir = normalizeDir(cwd);
  let projectRoot: string | null = null;
  let selectedMarkers: string[] = [];
  let gitRoot: string | null = null;
  while (dir === floor || dir.startsWith(`${floor}/`)) {
    const present = (
      await Promise.all(PROJECT_MARKERS.map(async (marker) => ((await safeExists(vfs, join(dir, marker))) ? marker : null)))
    ).filter((marker): marker is (typeof PROJECT_MARKERS)[number] => marker !== null);
    if (present.includes(".git")) gitRoot ??= dir;
    const identityMarkers = present.filter((marker) => marker !== ".git");
    if (projectRoot === null && identityMarkers.length > 0) {
      projectRoot = dir;
      selectedMarkers = present;
    }
    if (dir === floor) break;
    dir = parentDir(dir);
  }
  if (projectRoot === null && gitRoot !== null) {
    projectRoot = gitRoot;
    selectedMarkers = [".git"];
  }
  return {
    projectRoot: projectRoot ?? floor,
    gitRoot,
    markers: selectedMarkers,
  };
}

function packageManager(manifest: Record<string, unknown>, markers: readonly string[]): "bun" | "pnpm" | "yarn" | "npm" {
  const declared = typeof manifest.packageManager === "string" ? /^(bun|pnpm|yarn|npm)(?:@|$)/.exec(manifest.packageManager) : null;
  if (declared) return declared[1] as "bun" | "pnpm" | "yarn" | "npm";
  if (markers.includes("bun.lock") || markers.includes("bun.lockb")) return "bun";
  if (markers.includes("pnpm-lock.yaml")) return "pnpm";
  if (markers.includes("yarn.lock")) return "yarn";
  return "npm";
}

function packageScriptCommand(manager: "bun" | "pnpm" | "yarn" | "npm", name: string): string {
  return manager === "yarn" ? `yarn ${name}` : `${manager} run ${name}`;
}

function sectionBody(text: string, section: string): string {
  const lines = text.split(/\r?\n/);
  let active = false;
  const body: string[] = [];
  for (const line of lines) {
    const heading = /^\s*\[([^\]]+)]\s*$/.exec(line);
    if (heading) {
      active = heading[1] === section;
      continue;
    }
    if (active) body.push(line);
  }
  return body.join("\n");
}

function tomlKeys(text: string, section: string): string[] {
  const keys: string[] = [];
  for (const line of sectionBody(text, section).split(/\r?\n/)) {
    const match = /^\s*["']?([A-Za-z_][\w.-]*)["']?\s*=/.exec(line);
    if (match) keys.push(match[1]!);
  }
  return keys;
}

function makeTargets(text: string): string[] {
  const targets: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\s+[^:=]+)?\s*:(?!=)/.exec(line);
    if (!match || match[1]!.includes("%") || match[1] === "default") continue;
    targets.push(match[1]!);
  }
  return targets;
}

function rakeTargets(text: string): string[] {
  const targets: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*task\s+(?::([A-Za-z0-9_.-]+)|["']([A-Za-z0-9_.-]+)["'])/.exec(line);
    const target = match?.[1] ?? match?.[2];
    if (target) targets.push(target);
  }
  return targets;
}

function taskfileTargets(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const targets: string[] = [];
  let tasksIndent: number | null = null;
  let targetIndent: number | null = null;
  for (const line of lines) {
    const heading = /^(\s*)tasks:\s*$/.exec(line);
    if (heading) {
      tasksIndent = heading[1]!.length;
      targetIndent = null;
      continue;
    }
    if (tasksIndent === null || !line.trim() || /^\s*#/.test(line)) continue;
    const match = /^(\s*)([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (!match) continue;
    const indent = match[1]!.length;
    if (indent <= tasksIndent) {
      tasksIndent = null;
      targetIndent = null;
      continue;
    }
    targetIndent ??= indent;
    if (indent === targetIndent) targets.push(match[2]!);
  }
  return targets;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function deriveProjectCommands(
  vfs: BurrowVfs,
  projectRoot: string,
  markers: readonly string[],
  hasGit: boolean,
): Promise<string[]> {
  const commands = new Set<string>();
  const packageText = markers.includes("package.json") ? await safeRead(vfs, join(projectRoot, "package.json")) : null;
  if (packageText !== null) {
    try {
      const manifest = JSON.parse(packageText) as Record<string, unknown>;
      const manager = packageManager(manifest, markers);
      const scripts = typeof manifest.scripts === "object" && manifest.scripts !== null
        ? (manifest.scripts as Record<string, unknown>)
        : {};
      for (const name of Object.keys(scripts).sort()) {
        if (typeof scripts[name] === "string") commands.add(packageScriptCommand(manager, name));
      }
      commands.add(`${manager} install`);
    } catch {
    }
  }

  const pyproject = markers.includes("pyproject.toml") ? await safeRead(vfs, join(projectRoot, "pyproject.toml")) : null;
  if (pyproject !== null) {
    const usesUv = markers.includes("uv.lock");
    const usesPoetry = markers.includes("poetry.lock") || /\[tool\.poetry(?:\]|\.)/.test(pyproject);
    const runner = usesUv ? "uv run " : usesPoetry ? "poetry run " : "";
    if (usesUv) commands.add("uv sync");
    if (usesPoetry) commands.add("poetry install");
    const scripts = [...tomlKeys(pyproject, "project.scripts"), ...tomlKeys(pyproject, "tool.poetry.scripts")];
    for (const name of scripts) commands.add(`${runner}${name}`);
    if (/pytest/i.test(pyproject)) commands.add(runner ? `${runner}pytest` : "python -m pytest");
    if (/\[build-system]/.test(pyproject)) commands.add(runner ? `${runner}python -m build` : "python -m build");
  }

  if (markers.includes("requirements.txt")) {
    commands.add("python -m pip install -r requirements.txt");
  }
  if (markers.includes("Cargo.toml")) {
    commands.add("cargo build");
    commands.add("cargo test");
    commands.add("cargo run");
  }
  if (markers.includes("go.mod")) {
    commands.add("go build ./...");
    commands.add("go test ./...");
    commands.add("go run .");
  }
  if (markers.includes("Makefile")) {
    const makefile = await safeRead(vfs, join(projectRoot, "Makefile"));
    if (makefile !== null) for (const target of makeTargets(makefile)) commands.add(`make ${target}`);
  }
  if (markers.includes("Justfile")) {
    const justfile = await safeRead(vfs, join(projectRoot, "Justfile"));
    if (justfile !== null) for (const target of makeTargets(justfile)) commands.add(`just ${target}`);
  }
  if (markers.includes("Taskfile.yml") || markers.includes("Taskfile.yaml")) {
    const name = markers.includes("Taskfile.yml") ? "Taskfile.yml" : "Taskfile.yaml";
    const taskfile = await safeRead(vfs, join(projectRoot, name));
    if (taskfile !== null) {
      const targets = taskfileTargets(taskfile);
      if (targets.length === 0) commands.add("task");
      else for (const target of targets) commands.add(`task ${target}`);
    }
  }
  if (markers.includes("deno.json") || markers.includes("deno.jsonc")) {
    const name = markers.includes("deno.json") ? "deno.json" : "deno.jsonc";
    const denoText = await safeRead(vfs, join(projectRoot, name));
    const deno = denoText === null ? null : parseJsonObject(denoText);
    const tasks = deno && typeof deno.tasks === "object" && deno.tasks !== null ? deno.tasks as Record<string, unknown> : {};
    for (const task of Object.keys(tasks).sort()) commands.add(`deno task ${task}`);
  }
  if (markers.includes("composer.json")) {
    const composerText = await safeRead(vfs, join(projectRoot, "composer.json"));
    const composer = composerText === null ? null : parseJsonObject(composerText);
    const scripts = composer && typeof composer.scripts === "object" && composer.scripts !== null
      ? composer.scripts as Record<string, unknown>
      : {};
    for (const script of Object.keys(scripts).sort()) commands.add(`composer run ${script}`);
    commands.add("composer install");
  }
  if (markers.includes("Gemfile")) commands.add("bundle install");
  if (markers.includes("Rakefile")) {
    const rakefile = await safeRead(vfs, join(projectRoot, "Rakefile"));
    if (rakefile !== null) {
      const targets = rakeTargets(rakefile);
      if (targets.length === 0) commands.add("bundle exec rake");
      else for (const target of targets) commands.add(`bundle exec rake ${target}`);
    }
  }
  if (markers.includes("mix.exs")) {
    commands.add("mix deps.get");
    commands.add("mix compile");
    commands.add("mix test");
  }
  if (markers.includes("pom.xml")) {
    commands.add("mvn test");
    commands.add("mvn package");
  }
  if (markers.includes("build.gradle") || markers.includes("build.gradle.kts") || markers.includes("gradlew")) {
    const gradle = markers.includes("gradlew") ? "./gradlew" : "gradle";
    commands.add(`${gradle} build`);
    commands.add(`${gradle} test`);
  }
  if (markers.includes("CMakeLists.txt")) {
    commands.add("cmake -S . -B build");
    commands.add("cmake --build build");
  }
  if (markers.includes("Dockerfile")) commands.add("docker build .");
  if (markers.includes("compose.yml") || markers.includes("compose.yaml")) commands.add("docker compose up");
  if (hasGit) {
    commands.add("git status");
    commands.add("git diff");
    commands.add("git log");
    commands.add("git branch");
  }
  return [...commands]
    .map((command) => cleanLine(command))
    .filter((command): command is string => command !== null)
    .slice(0, MAX_PROJECT_COMMANDS);
}

async function listDirectory(
  vfs: BurrowVfs,
  path: string,
  projectRoot: string,
): Promise<CompletionDirectoryContext> {
  let names: string[] = [];
  try {
    names = await vfs.readdir(path);
  } catch {
    return { path, relativePath: relativePath(projectRoot, path), entries: [] };
  }
  const entries = (
    await Promise.all(
      names
        .filter((name) => name !== ".git" && name !== "node_modules" && cleanLine(name) !== null)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, MAX_DIRECTORY_ENTRIES)
        .map(async (name): Promise<CompletionDirectoryEntry | null> => {
          try {
            const stat = await vfs.lstat(join(path, name));
            return {
              name,
              kind: stat.isDirectory ? "directory" : stat.isSymbolicLink ? "symlink" : "file",
            };
          } catch {
            return null;
          }
        }),
    )
  ).filter((entry): entry is CompletionDirectoryEntry => entry !== null);
  return { path, relativePath: relativePath(projectRoot, path), entries };
}

function activeSegmentStart(line: string): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&") start = i + 1;
  }
  return start;
}

function shellWords(line: string): ShellWordToken[] {
  const words: ShellWordToken[] = [];
  const segmentStart = activeSegmentStart(line);
  let index = segmentStart;
  while (index < line.length) {
    while (index < line.length && /\s/.test(line[index]!)) index++;
    if (index >= line.length) break;
    const start = index;
    let value = "";
    let quote: "'" | '"' | null = null;
    let escaped = false;
    while (index < line.length) {
      const char = line[index]!;
      if (escaped) {
        value += char;
        escaped = false;
        index++;
        continue;
      }
      if (char === "\\" && quote !== "'") {
        escaped = true;
        index++;
        continue;
      }
      if (quote !== null) {
        if (char === quote) quote = null;
        else value += char;
        index++;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        index++;
        continue;
      }
      if (/\s/.test(char) || char === ";" || char === "|" || char === "&") break;
      value += char;
      index++;
    }
    words.push({ value, start, end: index });
    if (index < line.length && (line[index] === ";" || line[index] === "|" || line[index] === "&")) {
      words.length = 0;
      index++;
    }
  }
  return words;
}

function parseShellInput(line: string): ParsedShellInput {
  const words = shellWords(line);
  const trailingSpace = /\s$/.test(line);
  const active = trailingSpace || words.length === 0
    ? { value: "", start: line.length, end: line.length }
    : words[words.length - 1]!;
  return {
    command: words[0]?.value ?? "",
    words,
    active,
    activeIndex: trailingSpace ? words.length : Math.max(0, words.length - 1),
  };
}

function pathKind(input: ParsedShellInput): PathKind | null {
  if (input.activeIndex === 0) return null;
  if (DIRECTORY_COMMANDS.has(input.command)) return "directory";
  if (FILE_COMMANDS.has(input.command)) return "file";
  if (ANY_PATH_COMMANDS.has(input.command)) return "any";
  if (input.command === "serve") return "script";
  if (input.command === "bun" && ["run", "build"].includes(input.words[1]?.value ?? "") && input.activeIndex >= 2) {
    return "script";
  }
  return null;
}

function directoryRequest(vfs: BurrowVfs, cwd: string, input: ParsedShellInput): DirectoryRequest {
  const token = input.active.value;
  const slash = token.lastIndexOf("/");
  if (slash < 0) return { path: cwd, leafPrefix: token, renderedBase: "" };
  const renderedBase = token.slice(0, slash + 1);
  const rawDir = renderedBase.slice(0, -1) || "/";
  const resolved = rawDir === "~" ? WORKSPACE_ROOT : rawDir.startsWith("~/")
    ? join(WORKSPACE_ROOT, rawDir.slice(2))
    : vfs.resolvePath(cwd, rawDir);
  return {
    path: normalizeDir(resolved),
    leafPrefix: token.slice(slash + 1),
    renderedBase,
  };
}

function shellWord(value: string): string | null {
  if (!value || /[\x00-\x1f\x7f-\x9f]/.test(value)) return null;
  return value.replace(/([^A-Za-z0-9_@%+=:,./-])/g, "\\$1");
}

function pathCandidates(
  line: string,
  input: ParsedShellInput,
  request: DirectoryRequest,
  directory: CompletionDirectoryContext,
): string[] {
  const kind = pathKind(input);
  if (kind === null) return [];
  const commands: string[] = [];
  for (const entry of directory.entries) {
    if (!entry.name.startsWith(request.leafPrefix)) continue;
    if (kind === "directory" && entry.kind !== "directory") continue;
    if ((kind === "file" || kind === "script") && entry.kind === "directory") continue;
    if (kind === "script" && !SCRIPT_EXT.test(entry.name)) continue;
    const suffix = entry.kind === "directory" ? "/" : "";
    const word = shellWord(`${request.renderedBase}${entry.name}${suffix}`);
    if (!word) continue;
    const command = `${line.slice(0, input.active.start)}${word}`;
    if (command !== line && command.startsWith(line)) commands.push(command);
  }
  return commands.slice(0, 8);
}

export class ProjectCompletionContextProvider {
  readonly #vfs: BurrowVfs;
  readonly #git: GitAPI | undefined;
  readonly #cache = new Map<string, Promise<Omit<ProjectCompletionContext, "relevantDirectory" | "pathCandidates">>>();
  readonly #directories = new Map<string, Promise<CompletionDirectoryContext>>();
  readonly #off: Array<() => void> = [];
  #revision = 0;

  constructor(vfs: BurrowVfs, events: EventBus, git?: GitAPI) {
    this.#vfs = vfs;
    this.#git = git;
    const invalidate = (): void => {
      this.#revision++;
      this.#cache.clear();
      this.#directories.clear();
    };
    this.#off.push(events.on("file:changed", invalidate));
    this.#off.push(
      events.on("fs:batch", (event) => {
        if (event.reason !== "shell-command") invalidate();
      }),
    );
  }

  async get(cwd: string, line = ""): Promise<ProjectCompletionContext> {
    const normalized = normalizeDir(cwd);
    const key = `${this.#revision}\0${normalized}`;
    let pending = this.#cache.get(key);
    if (!pending) {
      pending = this.#build(normalized, this.#revision);
      this.#cache.set(key, pending);
      pending.catch(() => this.#cache.delete(key));
    }
    const base = await pending;
    const input = parseShellInput(line);
    const requested = directoryRequest(this.#vfs, normalized, input);
    const relevantDirectory = requested.path === normalized
      ? base.currentDirectory
      : await this.#getDirectory(requested.path, base.projectRoot);
    return {
      ...base,
      ...(requested.path === normalized ? {} : { relevantDirectory }),
      pathCandidates: pathCandidates(line, input, requested, relevantDirectory),
    };
  }

  dispose(): void {
    for (const off of this.#off) off();
    this.#off.length = 0;
    this.#cache.clear();
    this.#directories.clear();
  }

  #getDirectory(path: string, projectRoot: string): Promise<CompletionDirectoryContext> {
    const key = `${this.#revision}\0${path}`;
    let pending = this.#directories.get(key);
    if (!pending) {
      pending = listDirectory(this.#vfs, path, projectRoot);
      this.#directories.set(key, pending);
      pending.catch(() => this.#directories.delete(key));
    }
    return pending;
  }

  async #build(
    cwd: string,
    revision: number,
  ): Promise<Omit<ProjectCompletionContext, "relevantDirectory" | "pathCandidates">> {
    const roots = await findProjectRoots(this.#vfs, cwd);
    const projectKey = await projectIdentity(this.#vfs, roots.projectRoot, roots.gitRoot);
    const [projectCommands, currentDirectory] = await Promise.all([
      deriveProjectCommands(this.#vfs, roots.projectRoot, roots.markers, roots.gitRoot !== null),
      this.#getDirectory(cwd, roots.projectRoot),
    ]);
    let branch: string | undefined;
    if (roots.gitRoot !== null && this.#git) {
      try {
        branch = await this.#git.currentBranch(roots.gitRoot);
      } catch {
        branch = undefined;
      }
    }
    return {
      projectKey,
      projectRoot: roots.projectRoot,
      cwd,
      relativeCwd: relativePath(roots.projectRoot, cwd),
      projectMarkers: roots.markers,
      projectCommands,
      currentDirectory,
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
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  const first = lines[0];
  if (!first || new RegExp(`^${NO_SUGGESTION}[.!]?$`, "i").test(first)) return null;
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

function parseAiSuffix(raw: string, prefix: string): string | null {
  let text = stripThinking(raw).trim();
  text = text.replace(/^```(?:bash|sh|shell)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  const first = lines[0];
  if (!first || new RegExp(`^${NO_SUGGESTION}[.!]?$`, "i").test(first)) return null;
  let suffix = first.replace(/^(?:completion|suffix)\s*:\s*/i, "").trim();
  if (
    (suffix.startsWith("`") && suffix.endsWith("`")) ||
    (suffix.startsWith('"') && suffix.endsWith('"')) ||
    (suffix.startsWith("'") && suffix.endsWith("'"))
  ) {
    suffix = suffix.slice(1, -1).trim();
  }
  if (suffix.startsWith(prefix)) return parseAiCommand(suffix, prefix);
  const active = parseShellInput(prefix).active.value;
  const appendable = active && suffix.startsWith(active) ? suffix.slice(active.length) : suffix;
  return parseAiCommand(`${prefix}${appendable}`, prefix);
}

function supportsGeneratedCommand(
  command: string,
  prefix: string,
  context: ProjectCompletionContext,
  retrieval: CommandRetrieval,
  memory: CommandMemory,
): boolean {
  if (retrieval.ranked.some((candidate) => candidate.command === command)) return true;
  const input = parseShellInput(prefix);
  const completed = shellWords(command);
  const program = completed[0]?.value;
  if (!program) return false;
  const supportedPrograms = new Set(CONTEXT_COMMANDS);
  for (const projectCommand of context.projectCommands) {
    const projectProgram = shellWords(projectCommand)[0]?.value;
    if (projectProgram) supportedPrograms.add(projectProgram);
  }
  for (const run of memory.recentFor(context, 30)) {
    if (run.exitCode !== 0 || run.source === "programmatic") continue;
    const historyProgram = shellWords(run.command)[0]?.value;
    if (historyProgram) supportedPrograms.add(historyProgram);
  }
  if (!supportedPrograms.has(program)) return false;
  const active = completed[input.activeIndex];
  if (input.active.value) {
    return Boolean(active && active.value.startsWith(input.active.value) && active.value.length > input.active.value.length);
  }
  if (completed.length <= input.words.length) return false;
  return true;
}

function formatDirectory(directory: CompletionDirectoryContext): string[] {
  return directory.entries.map((entry) => {
    const prefix = entry.kind === "directory" ? "[D]" : entry.kind === "symlink" ? "[L]" : "[F]";
    return `${prefix} ${entry.name}${entry.kind === "directory" ? "/" : ""}`;
  });
}

function commandLines(commands: readonly RankedCommand[]): string[] {
  return commands.map((candidate) => candidate.command);
}

function section(title: string, values: readonly string[]): string | null {
  const lines = values.map((value) => cleanLine(value)).filter((value): value is string => value !== null);
  if (lines.length === 0) return null;
  return `${title}\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

function promptContext(
  line: string,
  context: ProjectCompletionContext,
  retrieval: CommandRetrieval,
  memory: CommandMemory,
): string {
  const recent = memory
    .recentFor(context, 30)
    .filter((run) => run.exitCode === 0 && run.source !== "programmatic")
    .slice(0, 2)
    .map((run) => `${run.command}  [from ${relativePath(context.projectRoot, run.cwd)}]`);
  const sections = [
    `CURRENT DIRECTORY\n${context.relativeCwd}`,
    `PROJECT ROOT\n${context.projectRoot}`,
    context.branch ? `GIT BRANCH\n${context.branch}` : null,
    section("PROJECT MARKERS", context.projectMarkers),
    section("RECENT SUCCESSFUL COMMANDS", recent),
    section("PROJECT COMMANDS", context.projectCommands),
    section(`CURRENT DIRECTORY ENTRIES (${context.currentDirectory.relativePath})`, formatDirectory(context.currentDirectory)),
    context.relevantDirectory
      ? section(`RELEVANT DIRECTORY ENTRIES (${context.relevantDirectory.relativePath})`, formatDirectory(context.relevantDirectory))
      : null,
    section("EXACT FOLDER HISTORY", commandLines(retrieval.folderHistory)),
    section("PROJECT HISTORY", commandLines(retrieval.projectHistory)),
    section("GLOBAL HISTORY", commandLines(retrieval.globalHistory)),
    section("COMMON AFTER THE PREVIOUS COMMAND", commandLines(retrieval.transitions)),
    section("RETRIEVED COMPLETIONS", commandLines(retrieval.contextCandidates)),
    `TYPED PREFIX\n${line}`,
  ].filter((value): value is string => value !== null);
  return sections.join("\n\n");
}

function selectionContext(
  line: string,
  context: ProjectCompletionContext,
  retrieval: CommandRetrieval,
  prefixLast: boolean,
): string {
  const [best, ...alternatives] = commandLines(retrieval.ranked);
  const stable = [
    `CURRENT DIRECTORY\n${context.relativeCwd}`,
    section("PROJECT MARKERS", context.projectMarkers),
    best ? `BEST MATCH\n${best}` : null,
    section("OTHER MATCHES", alternatives),
  ].filter((value): value is string => value !== null);
  const prefix = `TYPED PREFIX\n${line}`;
  return (prefixLast ? [...stable, prefix] : [prefix, ...stable]).join("\n\n");
}

export function messagesForCompletion(
  line: string,
  context: ProjectCompletionContext,
  retrieval: CommandRetrieval,
  memory: CommandMemory,
  model: AiModelId | null,
): ChatMessage[] {
  const qwen = model === null || model === AI_MODEL_DEFAULT;
  if (retrieval.ranked.length > 0) {
    const system = `Select one local Bash autocomplete. Copy BEST MATCH exactly unless another listed command is clearly better for the directory. Preserve every character, space, and flag in the command. Never modify a listed command. Generate a different command only if every listed command is unusable. Reply with one full command and nothing else, or ${NO_SUGGESTION} if none is useful.`;
    return [
      { role: "system", content: system },
      {
        role: "user",
        content: `${selectionContext(line, context, retrieval, !qwen)}\n\nReturn BEST MATCH character-for-character unless an OTHER MATCH is clearly better. Do not repeat only the prefix.${qwen ? " /no_think" : ""}`,
      },
    ];
  }
  const system = qwen
    ? `Complete one local Bash command. Reply with exactly one useful full command that starts byte-for-byte with the typed prefix and is longer than it. Use the project commands and directory entries as evidence. Do not invent an executable or append an unrelated command. If no project command or directory entry supports extending the prefix, reply ${NO_SUGGESTION}. Never explain, use markdown, or add a label.`
    : `Return only the missing suffix that should be appended to the typed prefix to form one useful local Bash command. Use the project commands and directory entries as evidence. Do not repeat or alter the typed prefix. Do not invent an executable or append an unrelated command. If no supported suffix exists, reply ${NO_SUGGESTION}. Never explain, use markdown, or add a label.`;
  const contextText = promptContext(line, context, retrieval, memory);
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: qwen
        ? "CURRENT DIRECTORY\n.\n\nCURRENT DIRECTORY ENTRIES (.)\n- [F] main.py\n- [D] tests/\n\nTYPED PREFIX\nfind . -n\n\nComplete the typed prefix with one full command."
        : "CURRENT DIRECTORY\n.\n\nCURRENT DIRECTORY ENTRIES (.)\n- [F] main.py\n- [D] tests/\n\nTYPED PREFIX\nfind . -n\n\nReturn only the missing suffix.",
    },
    { role: "assistant", content: qwen ? "find . -name \"*.py\" -type f" : "ame \"*.py\" -type f" },
    {
      role: "user",
      content: `${contextText}\n\n${qwen ? "Complete the typed prefix with one full command. /no_think" : "Return only the missing suffix."}`,
    },
  ];
}

function maxNewTokens(model: AiModelId | null): number {
  return model === AI_MODEL_DEFAULT || model === null ? 48 : 64;
}

export function createHybridSuggestionProvider(options: {
  memory: CommandMemory;
  context: ProjectCompletionContextProvider;
  ai?: AiPanelAPI;
  aiDelayMs?: number;
}): ShellSuggestionProvider {
  const aiCache = new Map<string, string>();

  return async (request, emit): Promise<void> => {
    if (
      request.signal.aborted ||
      !request.line.trim() ||
      request.line !== request.line.trimStart() ||
      /[\x00-\x1f\x7f-\x9f]/.test(request.line)
    ) {
      return;
    }
    const context = await options.context.get(request.cwd, request.line);
    if (request.signal.aborted) return;
    const retrieval = options.memory.retrieve({
      ...context,
      prefix: request.line,
      projectCandidates: [...context.pathCandidates, ...context.projectCommands],
      limit: 12,
    });

    const local = retrieval.ranked[0];
    if (local) emit(local.command, local.source);

    const ai = options.ai;
    if (!ai) return;
    const initialModel = ai.loadedModel();
    const initialKey = `${initialModel ?? "none"}\0${context.projectKey}\0${context.cwd}\0${context.revision}\0${options.memory.revision}\0${request.line}`;
    const cached = aiCache.get(initialKey);
    if (cached) {
      emit(cached, "ai");
      return;
    }

    const delayMs = options.aiDelayMs ?? AI_DELAY_MS;
    try {
      await abortableDelay(delayMs, request.signal);
    } catch {
      return;
    }
    if (request.signal.aborted) return;
    const aiState = ai.getState();
    const model = ai.loadedModel();
    if (aiState !== "ready" || model === null) return;
    const key = `${model}\0${context.projectKey}\0${context.cwd}\0${context.revision}\0${options.memory.revision}\0${request.line}`;
    const currentCached = aiCache.get(key);
    if (currentCached) {
      emit(currentCached, "ai");
      return;
    }

    const messages = messagesForCompletion(request.line, context, retrieval, options.memory, model);
    const tokenLimit = maxNewTokens(model);
    let streamed = "";
    const handle = ai.generate(
      messages,
      (delta) => {
        streamed += delta;
      },
      {
        maxNewTokens: tokenLimit,
        priority: "background",
      },
    );
    const cancel = (): void => handle.cancel();
    request.signal.addEventListener("abort", cancel, { once: true });
    try {
      const raw = await handle.done;
      const result = raw || streamed;
      const command = model === AI_MODEL_DEFAULT || retrieval.ranked.length > 0
        ? parseAiCommand(result, request.line)
        : parseAiSuffix(result, request.line);
      if (!command || !supportsGeneratedCommand(command, request.line, context, retrieval, options.memory) || request.signal.aborted) return;
      aiCache.set(key, command);
      if (aiCache.size > MAX_AI_CACHE) aiCache.delete(aiCache.keys().next().value as string);
      if (command !== local?.command) emit(command, "ai");
    } catch {
    } finally {
      request.signal.removeEventListener("abort", cancel);
    }
  };
}
