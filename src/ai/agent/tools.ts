/**
 * Burrow — src/ai/agent/tools.ts
 *
 * The tool implementations the agent loop dispatches to. Execution happens on
 * the MAIN THREAD (the model inference stays in the worker) because only the
 * main thread has registry access to the vfs/shell services. Dependencies are
 * injected (ToolDeps) so the whole surface is testable against fakes.
 *
 * Guardrails baked in here:
 *  - every path is resolved against cwd (relative + dropped-absolute both work),
 *  - writes auto-create parent dirs (vfs.writeFile does NOT),
 *  - edits use an EXACT single-occurrence match, with one whitespace-normalized
 *    unique-match rescue; 0 or >1 matches return a RECOVERABLE observation and
 *    NEVER corrupt the file,
 *  - bash degrades gracefully when the shell service isn't up yet.
 */

import { WORKSPACE_ROOT } from "../../contract/types.ts";
import type { BurrowVfs, EventBus, ShellAPI, ShellExecResult } from "../../contract/types.ts";
import { countDiff } from "./diff.ts";
import type { Action, ToolName, ToolResult } from "./protocol.ts";
import { truncateMiddle } from "./protocol.ts";

export interface ToolDeps {
  vfs: BurrowVfs;
  /** Lazy: the shell service boots AFTER ai, so resolve it at run time. */
  shell: () => ShellAPI | undefined;
  events?: EventBus | undefined;
  cwd: () => string;
  signal: AbortSignal;
}

export type ToolFn = (a: Action) => Promise<ToolResult>;

const MAX_READ_LINES = 200;
const MAX_READ_CHARS = 4000;
const MAX_LIST = 150;
const MAX_MATCHES = 40;
const MAX_SHELL_OUT = 2000;
/** A single command may not wedge the whole ReAct loop — cap it. */
const BASH_TIMEOUT_MS = 20_000;

/**
 * A resolved path is only writable if it stays strictly under WORKSPACE_ROOT and
 * never reaches into a `.git` directory. `..`/absolute escapes and .git writes
 * (which silently corrupt the repo index) are refused with a recoverable result,
 * never applied. Returns null when the path is safe.
 */
function containmentError(kind: ToolName, resolved: string, requested: string): ToolResult | null {
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + "/")) {
    return err(kind, `refused: ${requested} resolves outside the workspace (${WORKSPACE_ROOT}).`, resolved);
  }
  if (resolved === WORKSPACE_ROOT + "/.git" || resolved.includes("/.git/")) {
    return err(kind, `refused: ${requested} is inside .git — never write there, it corrupts the repo.`, resolved);
  }
  return null;
}

const dirname = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
};

const rel = (path: string): string =>
  path.startsWith(WORKSPACE_ROOT + "/") ? path.slice(WORKSPACE_ROOT.length + 1) : path;

const numbered = (text: string, cap: number): string => {
  const lines = text.split("\n");
  const shown = lines.slice(0, cap).map((l, i) => `${i + 1}\t${l}`).join("\n");
  const more = lines.length > cap ? `\n… (${lines.length - cap} more lines)` : "";
  return shown + more;
};

const err = (kind: ToolName, observation: string, path?: string): ToolResult => ({
  ok: false,
  kind,
  observation,
  ...(path ? { path } : {}),
});

/** Count non-overlapping occurrences of `needle` in `hay`. */
function occurrences(hay: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

/** Rescue an edit whose SEARCH didn't match exactly, by comparing trimmed lines. Unique or null. */
function normalizedReplace(oldText: string, search: string, replace: string): string | null {
  const oldLines = oldText.split("\n");
  const searchLines = search.split("\n");
  const norm = searchLines.map((l) => l.trim());
  if (searchLines.length === 0) return null;
  let foundAt = -1;
  for (let i = 0; i + searchLines.length <= oldLines.length; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (oldLines[i + j]!.trim() !== norm[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      if (foundAt !== -1) return null; // ambiguous — refuse
      foundAt = i;
    }
  }
  if (foundAt === -1) return null;
  const before = oldLines.slice(0, foundAt);
  const after = oldLines.slice(foundAt + searchLines.length);
  return [...before, ...replace.split("\n"), ...after].join("\n");
}

export function createAgentTools(deps: ToolDeps): Record<ToolName, ToolFn> {
  const { vfs, events, signal } = deps;
  const resolve = (p: string): string => vfs.resolvePath(deps.cwd(), p);

  const read: ToolFn = async (a) => {
    const path = resolve(a.path ?? "");
    if (!(await vfs.exists(path))) return err("read", `ENOENT: ${a.path} does not exist`, path);
    const content = await vfs.readFile(path);
    const total = content.split("\n").length;
    const body = truncateMiddle(numbered(content, MAX_READ_LINES), MAX_READ_CHARS);
    return { ok: true, kind: "read", path, observation: `${a.path} (${total} lines):\n${body}` };
  };

  const list: ToolFn = async (a) => {
    const prefix = a.path ? resolve(a.path) : WORKSPACE_ROOT;
    const under = prefix.endsWith("/") ? prefix : prefix + "/";
    const paths = vfs
      .getAllPaths()
      .filter((p) => (p === prefix || p.startsWith(under)) && !p.includes("/.git/") && !p.includes("/node_modules/"))
      .map(rel)
      .filter(Boolean)
      .sort();
    const shown = paths.slice(0, MAX_LIST);
    const more = paths.length > MAX_LIST ? `\n… (${paths.length - MAX_LIST} more)` : "";
    const obs = shown.length ? shown.join("\n") + more : `(no files under ${a.path ?? "/"})`;
    return { ok: true, kind: "list", observation: obs };
  };

  const search: ToolFn = async (a) => {
    const query = a.query ?? "";
    const matches: string[] = [];
    for (const p of vfs.getAllPaths()) {
      if (signal.aborted) break;
      if (p.includes("/.git/") || p.includes("/node_modules/")) continue;
      let text: string;
      try {
        text = await vfs.readFile(p);
      } catch {
        continue; // directory or binary
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(query)) {
          matches.push(`${rel(p)}:${i + 1}: ${lines[i]!.trim().slice(0, 120)}`);
          if (matches.length >= MAX_MATCHES) break;
        }
      }
      if (matches.length >= MAX_MATCHES) break;
    }
    const obs = matches.length ? matches.join("\n") : `no matches for "${query}"`;
    return { ok: true, kind: "search", query, matches, observation: obs };
  };

  const write: ToolFn = async (a) => {
    const path = resolve(a.path ?? "");
    const blocked = containmentError("write", path, a.path ?? "");
    if (blocked) return blocked;
    const existed = await vfs.exists(path);
    let oldText = "";
    if (existed) {
      try {
        oldText = await vfs.readFile(path);
      } catch {
        /* ignore */
      }
    }
    const dir = dirname(path);
    if (dir) {
      try {
        await vfs.mkdir(dir, { recursive: true });
      } catch {
        /* already exists */
      }
    }
    const newText = a.body ?? "";
    await vfs.writeFile(path, newText);
    events?.emit("editor:open", { path });
    const lines = newText === "" ? 0 : newText.split("\n").length;
    return {
      ok: true,
      kind: "write",
      path,
      oldText,
      newText,
      observation: `${existed ? "updated" : "created"} ${a.path} (${lines} lines)`,
    };
  };

  const edit: ToolFn = async (a) => {
    const path = resolve(a.path ?? "");
    const blocked = containmentError("edit", path, a.path ?? "");
    if (blocked) return blocked;
    if (!(await vfs.exists(path))) return err("edit", `ENOENT: ${a.path} does not exist — use <write> to create it`, path);
    const oldText = await vfs.readFile(path);
    const searchText = a.search ?? "";
    const replaceText = a.replace ?? "";
    if (searchText === "") {
      return err("edit", "the SEARCH block is empty — use <write> to replace the whole file", path);
    }

    const count = occurrences(oldText, searchText);
    let newText: string;
    if (count === 1) {
      newText = oldText.split(searchText).join(replaceText);
    } else if (count === 0) {
      const rescued = normalizedReplace(oldText, searchText, replaceText);
      if (rescued === null) {
        return err(
          "edit",
          `SEARCH text was not found in ${a.path}. Re-read the file and copy an exact snippet. Current file:\n` +
            numbered(oldText, 120),
          path,
        );
      }
      newText = rescued;
    } else {
      return err(
        "edit",
        `SEARCH text matched ${count} times in ${a.path} — include more surrounding lines so it is unique.`,
        path,
      );
    }

    await vfs.writeFile(path, newText);
    events?.emit("editor:open", { path });
    const { adds, dels } = countDiff(oldText, newText);
    return { ok: true, kind: "edit", path, oldText, newText, observation: `updated ${a.path} (+${adds} −${dels})` };
  };

  const bash: ToolFn = async (a) => {
    const sh = deps.shell();
    if (!sh) return err("bash", "the shell isn't ready yet — use file tools (read/list/write/edit) for now.");
    const cmd = a.cmd ?? "";

    // Bound every command: a non-terminating command (bun --watch, while true, a
    // dev server) must not wedge the ReAct loop. We race exec against a timer so
    // the loop proceeds even if the shell ignores the abort, and ask the shell to
    // cancel via a combined signal when it honours one.
    const timer = new AbortController();
    const combined =
      typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timer.signal]) : signal;
    let timedOut = false;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<never>((_, reject) => {
      handle = setTimeout(() => {
        timedOut = true;
        timer.abort();
        reject(new Error("__bash_timeout__"));
      }, BASH_TIMEOUT_MS);
    });

    let res: ShellExecResult;
    try {
      res = await Promise.race([sh.exec(cmd, { echo: true, signal: combined }), timeoutP]);
    } catch (e) {
      // A user stop fires the run-level `signal`; the loop handles that. Only a
      // genuine timeout surfaces here as a recoverable observation.
      if (timedOut && !signal.aborted) {
        return err("bash", `$ ${cmd}\ncommand timed out after ${BASH_TIMEOUT_MS / 1000}s and was aborted.`);
      }
      throw e;
    } finally {
      if (handle) clearTimeout(handle);
    }

    const parts = [`$ ${cmd}`, `exit ${res.exitCode}`];
    const out = truncateMiddle(res.stdout, MAX_SHELL_OUT);
    const errOut = truncateMiddle(res.stderr, MAX_SHELL_OUT);
    if (out.trim()) parts.push(`stdout:\n${out}`);
    if (errOut.trim()) parts.push(`stderr:\n${errOut}`);
    return {
      ok: res.exitCode === 0,
      kind: "bash",
      cmd,
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      observation: parts.join("\n"),
    };
  };

  const done: ToolFn = async (a) => ({
    ok: true,
    kind: "done",
    summary: a.summary ?? "",
    observation: a.summary ?? "",
  });

  return { read, list, search, write, edit, bash, done };
}
