/**
 * Burrow — src/git/command.ts
 * The `git` terminal command (registered via registerShellCommand in initGit).
 * Subcommands per CONTRACT.md §4: clone, init, status, add / add -A,
 * commit -m, log [-n N], diff [path...], checkout -- <path...>, branch.
 * Colored stdout (stderr stays plain — the shell driver renders it red).
 */
import type {
  CommandContext,
  CommandSpec,
  GitAPI,
  ShellExecResult,
} from "../contract/types.ts";
import { formatUnified } from "./diff.ts";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const USAGE = `${C.bold}usage:${C.reset} git <command> [<args>]

commands:
   ${C.cyan}clone${C.reset} <url> [dir]      clone a repository (through the Burrow proxy)
   ${C.cyan}init${C.reset} [dir]             create an empty repository
   ${C.cyan}status${C.reset}                 show the working tree status
   ${C.cyan}add${C.reset} <path...|.>        stage file contents
   ${C.cyan}add${C.reset} -A                 stage all changes, including deletions
   ${C.cyan}commit${C.reset} -m <msg>        record staged changes (add -a to stage first)
   ${C.cyan}log${C.reset} [-n N]             show commit history
   ${C.cyan}diff${C.reset} [path...]         show HEAD vs working tree changes
   ${C.cyan}checkout${C.reset} -- <path...>  discard working tree changes
   ${C.cyan}branch${C.reset}                 show the current branch
`;

class GitCmdError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function ok(stdout = ""): ShellExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Path helpers (VFS paths are always absolute, "/"-separated)
// ---------------------------------------------------------------------------

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

function dirnameOf(path: string): string {
  const normalized = normalizePath(path);
  const i = normalized.lastIndexOf("/");
  return i <= 0 ? "/" : normalized.slice(0, i);
}

function joinPath(a: string, b: string): string {
  return normalizePath(`${a}/${b}`);
}

/** Repo-root-relative filepath for isomorphic-git ("." for the root itself). */
function toRepoRel(root: string, abs: string): string {
  const nRoot = normalizePath(root);
  const nAbs = normalizePath(abs);
  if (nAbs === nRoot) return ".";
  const prefix = nRoot === "/" ? "/" : `${nRoot}/`;
  if (!nAbs.startsWith(prefix)) {
    throw new GitCmdError(`fatal: '${abs}' is outside repository at '${root}'`, 128);
  }
  return nAbs.slice(prefix.length);
}

/** Nearest ancestor of ctx.cwd containing .git, else ctx.cwd. */
async function findRepoRoot(ctx: CommandContext): Promise<string> {
  let dir = normalizePath(ctx.cwd);
  for (;;) {
    if (await ctx.fs.exists(joinPath(dir, ".git"))) return dir;
    if (dir === "/") return normalizePath(ctx.cwd);
    dir = dirnameOf(dir);
  }
}

async function requireRepoRoot(ctx: CommandContext): Promise<string> {
  const root = await findRepoRoot(ctx);
  if (!(await ctx.fs.exists(joinPath(root, ".git")))) {
    throw new GitCmdError("fatal: not a git repository (or any of the parent directories): .git", 128);
  }
  return root;
}

function throwIfAborted(ctx: CommandContext): void {
  if (ctx.signal?.aborted) throw new GitCmdError("fatal: operation aborted", 130);
}

function repoNameFromUrl(url: string): string {
  const tail = url.replace(/\/+$/, "").split("/").pop() ?? "repo";
  return tail.replace(/\.git$/, "") || "repo";
}

const isBinary = (s: string): boolean => s.includes("\u0000");

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function doClone(api: GitAPI, rest: string[], ctx: CommandContext): Promise<ShellExecResult> {
  const positional = rest.filter((a) => !a.startsWith("-"));
  const url = positional[0];
  if (!url) throw new GitCmdError("usage: git clone <url> [dir]", 129);
  const name = positional[1] ?? repoNameFromUrl(url);
  const dir = ctx.fs.resolvePath(ctx.cwd, name);

  if (await ctx.fs.exists(dir)) {
    const entries = await ctx.fs.readdir(dir).catch(() => null);
    if (entries === null || entries.length > 0) {
      throw new GitCmdError(
        `fatal: destination path '${name}' already exists and is not an empty directory.`,
        128,
      );
    }
  }
  throwIfAborted(ctx);

  // just-bash delivers output whole (no streaming), so progress is summarized:
  // keep the LAST message per remote-progress "family" and print them at the end.
  const messages = new Map<string, string>();
  await api.clone({
    url,
    dir,
    onMessage: (m) => {
      const line = m.trimEnd();
      if (!line) return;
      messages.set(line.replace(/[\d,.%()/\s]+$/, ""), line);
    },
    onProgress: () => {
      // isomorphic-git has no AbortSignal support; best effort — a throw from
      // the progress callback unwinds the current phase.
      if (ctx.signal?.aborted) throw new GitCmdError("fatal: clone aborted", 130);
    },
  });
  throwIfAborted(ctx);

  const branch = await api.currentBranch(dir);
  const lines = [
    `Cloning into '${C.bold}${name}${C.reset}'...`,
    ...[...messages.values()].map((m) => `${C.dim}remote: ${m}${C.reset}`),
    branch ? `done. checked out branch ${C.green}${branch}${C.reset} (shallow, depth 1)` : "done.",
  ];
  return ok(lines.join("\n") + "\n");
}

async function doInit(api: GitAPI, rest: string[], ctx: CommandContext): Promise<ShellExecResult> {
  const target = rest[0] ? ctx.fs.resolvePath(ctx.cwd, rest[0]) : normalizePath(ctx.cwd);
  await api.init(target);
  return ok(`Initialized empty Git repository in ${target}/.git/\n`);
}

async function doStatus(api: GitAPI, ctx: CommandContext): Promise<ShellExecResult> {
  const root = await requireRepoRoot(ctx);
  const branch = await api.currentBranch(root);
  const rows = await api.statusMatrix(root);

  const staged: Array<[label: string, filepath: string]> = [];
  const unstaged: Array<[label: string, filepath: string]> = [];
  const untracked: string[] = [];

  for (const [filepath, head, workdir, stage] of rows) {
    if (head === 1 && workdir === 1 && stage === 1) continue; // clean

    if (head === 0 && stage === 0) {
      if (workdir === 2) untracked.push(filepath);
      continue;
    }

    // index vs HEAD (staged section)
    if (head === 0 && stage >= 2) staged.push(["new file", filepath]);
    else if (head === 1 && stage === 0) staged.push(["deleted", filepath]);
    else if (head === 1 && stage >= 2) staged.push(["modified", filepath]);

    // workdir vs index (unstaged section)
    if (workdir === 0 && stage !== 0) unstaged.push(["deleted", filepath]);
    else if (workdir === 2 && (stage === 1 || stage === 3)) unstaged.push(["modified", filepath]);
    else if (workdir !== 0 && stage === 0 && head === 1) untracked.push(filepath); // rm --cached shape
  }

  const out: string[] = [`On branch ${C.bold}${branch ?? "HEAD (detached)"}${C.reset}`];

  const pad = (label: string): string => `${label}:`.padEnd(12);
  if (staged.length > 0) {
    out.push("", "Changes to be committed:", `  ${C.dim}(use "git checkout -- <file>..." to discard)${C.reset}`);
    for (const [label, filepath] of staged) out.push(`\t${C.green}${pad(label)}${filepath}${C.reset}`);
  }
  if (unstaged.length > 0) {
    out.push("", "Changes not staged for commit:", `  ${C.dim}(use "git add <file>..." to update what will be committed)${C.reset}`);
    for (const [label, filepath] of unstaged) out.push(`\t${C.red}${pad(label)}${filepath}${C.reset}`);
  }
  if (untracked.length > 0) {
    out.push("", "Untracked files:", `  ${C.dim}(use "git add <file>..." to include in what will be committed)${C.reset}`);
    for (const filepath of untracked) out.push(`\t${C.red}${filepath}${C.reset}`);
  }
  if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
    out.push("", "nothing to commit, working tree clean");
  }
  return ok(out.join("\n") + "\n");
}

async function doAdd(api: GitAPI, rest: string[], ctx: CommandContext): Promise<ShellExecResult> {
  const root = await requireRepoRoot(ctx);
  if (rest.includes("-A") || rest.includes("--all")) {
    await api.stageAll(root);
    return ok();
  }
  const paths = rest.filter((a) => !a.startsWith("-"));
  if (paths.length === 0) {
    throw new GitCmdError("Nothing specified, nothing added.\nhint: use 'git add .' or 'git add -A'", 1);
  }
  const rels = paths.map((p) => toRepoRel(root, ctx.fs.resolvePath(ctx.cwd, p)));
  await api.stage(rels.length === 1 ? rels[0]! : rels, root);
  return ok();
}

async function doCommit(api: GitAPI, rest: string[], ctx: CommandContext): Promise<ShellExecResult> {
  const root = await requireRepoRoot(ctx);

  let message: string | undefined;
  let stageFirst = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-m" || arg === "--message" || arg === "-am" || arg === "-ma") {
      if (arg === "-am" || arg === "-ma") stageFirst = true;
      message = rest[i + 1];
      i++;
    } else if (arg.startsWith("--message=")) {
      message = arg.slice("--message=".length);
    } else if (arg === "-a" || arg === "--all") {
      stageFirst = true;
    }
  }
  if (message === undefined || message === "") {
    throw new GitCmdError("usage: git commit [-a] -m <message>", 129);
  }

  if (stageFirst) await api.stageAll(root);

  // Anything to commit? (index differs from HEAD)
  const rows = await api.statusMatrix(root);
  const hasStaged = rows.some(([, head, , stage]) => (head === 0 && stage >= 2) || (head === 1 && stage !== 1));
  if (!hasStaged) {
    throw new GitCmdError("nothing to commit, working tree clean", 1);
  }

  const branch = (await api.currentBranch(root)) ?? "HEAD";
  const sha = await api.commit(message, undefined, root);
  const firstLine = message.split("\n")[0]!;
  const author = api.getAuthor();
  return ok(
    `[${C.green}${branch}${C.reset} ${C.yellow}${sha.slice(0, 7)}${C.reset}] ${firstLine}\n` +
      `${C.dim} Author: ${author.name} <${author.email}>${C.reset}\n`,
  );
}

async function doLog(api: GitAPI, rest: string[], ctx: CommandContext): Promise<ShellExecResult> {
  const root = await requireRepoRoot(ctx);
  let depth = 20;
  const nIdx = rest.indexOf("-n");
  if (nIdx !== -1 && rest[nIdx + 1]) {
    const parsed = Number.parseInt(rest[nIdx + 1]!, 10);
    if (Number.isNaN(parsed) || parsed <= 0) throw new GitCmdError(`fatal: invalid -n value: ${rest[nIdx + 1]}`, 129);
    depth = parsed;
  }
  for (const arg of rest) {
    const m = /^--max-count=(\d+)$/.exec(arg);
    if (m) depth = Number.parseInt(m[1]!, 10);
  }

  let entries;
  try {
    entries = await api.log({ depth, dir: root });
  } catch {
    throw new GitCmdError("fatal: your current branch does not have any commits yet", 128);
  }

  const blocks = entries.map((entry) => {
    const msg = entry.message.trimEnd().split("\n").map((l) => `    ${l}`).join("\n");
    return [
      `${C.yellow}commit ${entry.oid}${C.reset}`,
      `Author: ${entry.author.name} <${entry.author.email}>`,
      `Date:   ${fmtGitDate(entry.author)}`,
      "",
      msg,
    ].join("\n");
  });
  return ok(blocks.join("\n\n") + (blocks.length > 0 ? "\n" : ""));
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtGitDate(author: { timestamp: number; timezoneOffset: number }): string {
  // timezoneOffset follows Date.getTimezoneOffset() convention (positive = west of UTC).
  const local = new Date((author.timestamp - author.timezoneOffset * 60) * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  const abs = Math.abs(author.timezoneOffset);
  const tz = `${author.timezoneOffset <= 0 ? "+" : "-"}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
  return (
    `${DAYS[local.getUTCDay()]} ${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()} ` +
    `${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())} ${local.getUTCFullYear()} ${tz}`
  );
}

async function doDiff(api: GitAPI, rest: string[], ctx: CommandContext): Promise<ShellExecResult> {
  const root = await requireRepoRoot(ctx);
  const pathArgs = rest.filter((a) => a !== "--" && !a.startsWith("-"));

  let targets: string[];
  let explicit: boolean;
  if (pathArgs.length > 0) {
    explicit = true;
    targets = pathArgs.map((p) => toRepoRel(root, ctx.fs.resolvePath(ctx.cwd, p)));
  } else {
    explicit = false;
    const rows = await api.statusMatrix(root);
    targets = rows
      .filter(
        ([, head, workdir, stage]) =>
          (head === 1 && workdir !== 1) || // tracked, changed/deleted in workdir
          (head === 0 && stage >= 2 && workdir !== 0), // staged new file
      )
      .map((row) => row[0]);
  }

  let out = "";
  for (const rel of targets) {
    throwIfAborted(ctx);
    const abs = joinPath(root, rel);
    const headBytes = await api.headContent(rel, root);
    const inWorkdir = await ctx.fs.exists(abs);
    if (headBytes === null && !inWorkdir) {
      if (explicit) {
        throw new GitCmdError(`fatal: path '${rel}' exists neither in HEAD nor in the working tree`, 128);
      }
      continue;
    }

    const headText = headBytes === null ? null : new TextDecoder().decode(headBytes);
    const workText = inWorkdir ? await ctx.fs.readFile(abs) : null;

    if ((headText !== null && isBinary(headText)) || (workText !== null && isBinary(workText))) {
      if (headText !== workText) out += `Binary files a/${rel} and b/${rel} differ\n`;
      continue;
    }
    out += formatUnified(headText, workText, rel, { color: true });
  }
  return ok(out);
}

async function doCheckout(api: GitAPI, rest: string[], ctx: CommandContext): Promise<ShellExecResult> {
  const root = await requireRepoRoot(ctx);
  const sep = rest.indexOf("--");
  const paths = sep === -1 ? [] : rest.slice(sep + 1);
  if (sep === -1 || paths.length === 0) {
    throw new GitCmdError("usage: git checkout -- <path>...\n(branch switching is not supported in Burrow)", 129);
  }
  const rels = paths.map((p) => toRepoRel(root, ctx.fs.resolvePath(ctx.cwd, p)));
  await api.discard(rels, root);
  return ok(`Updated ${rels.length} path${rels.length === 1 ? "" : "s"} from HEAD\n`);
}

async function doBranch(api: GitAPI, ctx: CommandContext): Promise<ShellExecResult> {
  const root = await requireRepoRoot(ctx);
  const branch = await api.currentBranch(root);
  if (!branch) return ok(`${C.dim}(no branch)${C.reset}\n`);
  return ok(`* ${C.green}${branch}${C.reset}\n`);
}

// ---------------------------------------------------------------------------
// Command spec
// ---------------------------------------------------------------------------

export function createGitCommand(api: GitAPI): CommandSpec {
  return {
    name: "git",
    async execute(args, ctx): Promise<ShellExecResult> {
      const sub = args[0];
      const rest = args.slice(1);
      try {
        throwIfAborted(ctx);
        switch (sub) {
          case undefined:
          case "help":
          case "--help":
            return ok(USAGE);
          case "clone":
            return await doClone(api, rest, ctx);
          case "init":
            return await doInit(api, rest, ctx);
          case "status":
            return await doStatus(api, ctx);
          case "add":
            return await doAdd(api, rest, ctx);
          case "commit":
            return await doCommit(api, rest, ctx);
          case "log":
            return await doLog(api, rest, ctx);
          case "diff":
            return await doDiff(api, rest, ctx);
          case "checkout":
            return await doCheckout(api, rest, ctx);
          case "branch":
            return await doBranch(api, ctx);
          default:
            return {
              stdout: "",
              stderr: `git: '${sub}' is not a git command. See 'git help'.\n`,
              exitCode: 1,
            };
        }
      } catch (error) {
        if (error instanceof GitCmdError) {
          return { stdout: "", stderr: `${error.message}\n`, exitCode: error.exitCode };
        }
        const message = error instanceof Error ? error.message || String(error) : String(error);
        return { stdout: "", stderr: `fatal: ${message}\n`, exitCode: 1 };
      }
    },
  };
}
