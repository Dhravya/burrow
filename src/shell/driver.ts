/**
 * Burrow — src/shell/driver.ts
 * Interactive shell driver: line editor, history, tab completion, Ctrl+C.
 *
 * Vendor-adapted from @wterm/just-bash's BashShell line editor, with the
 * execution core replaced per CONTRACT.md §5:
 *   - ONE bash.exec per command, threading {cwd, env} manually (just-bash
 *     resets shell state every exec; result.env is the persistence mechanism).
 *   - Never re-execute a command for state tracking (the upstream bug).
 *   - Ctrl+C is accepted WHILE a command runs (AbortController per command;
 *     aborted runs resolve with exitCode 126). Only line editing is locked.
 *   - Emits "cwd:changed" when PWD moves and "fs:batch"{reason:"shell-command"}
 *     after every completed command.
 *
 * No DOM / @wterm imports here — this file is exercised directly by bun test.
 */

import type { Bash } from "just-bash/browser";
import type { EventBus, ShellExecResult } from "../contract/types.ts";
import { WORKSPACE_ROOT } from "../contract/types.ts";

export const BASE_ENV: Record<string, string> = {
  SHELL: "/bin/bash",
  TERM: "xterm-256color",
  HOME: WORKSPACE_ROOT,
  USER: "user",
  HOSTNAME: "burrow",
};

export interface ShellDriverOptions {
  bash: Bash;
  events: EventBus;
  /** Raw terminal writer (ANSI ok; driver emits \r\n line endings). */
  write: (data: string) => void;
  /** Lines printed once by start(), before the first prompt. */
  greeting?: readonly string[];
}

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/** just-bash "bytes" stdout is a latin1-shaped ByteString — decode as UTF-8. */
function decodeByteString(bytes: string): string {
  return new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0) & 0xff));
}

export class ShellDriver {
  private readonly bash: Bash;
  private readonly events: EventBus;
  private readonly write: (data: string) => void;
  private readonly greeting: readonly string[];

  // ---- line editor state ----
  private line = "";
  private cursor = 0;
  private continuation = ""; // backslash-continued previous lines
  private history: string[] = [];
  private historyPos = -1;

  // ---- execution state ----
  private cwd = WORKSPACE_ROOT;
  private env: Record<string, string> = { ...BASE_ENV };
  private busy = false;
  private currentAbort: AbortController | null = null;
  /** Serializes interactive + programmatic commands (never interleave). */
  private queue: Promise<unknown> = Promise.resolve();
  /** Serializes keystroke processing so async keys never overlap (see handleInput). */
  private inputQueue: Promise<void> = Promise.resolve();

  constructor(options: ShellDriverOptions) {
    this.bash = options.bash;
    this.events = options.events;
    this.write = options.write;
    this.greeting = options.greeting ?? [];
  }

  /** Print greeting + first prompt. Call once after the terminal is ready. */
  start(): void {
    if (this.greeting.length > 0) {
      this.write(this.greeting.join("\r\n") + "\r\n");
    }
    this.write(this.prompt());
  }

  getCwd(): string {
    return this.cwd;
  }

  getEnv(): Readonly<Record<string, string>> {
    return this.env;
  }

  prompt(): string {
    const display = this.cwd.replace(/^\/home\/user/, "~") || "/";
    return `\x1b[1;32muser@burrow${RESET}:\x1b[1;34m${display}${RESET}$ `;
  }

  // ==========================================================================
  // Programmatic execution (ShellAPI.exec) — same Bash + persisted {cwd, env}
  // ==========================================================================

  exec(line: string, options?: { echo?: boolean; signal?: AbortSignal }): Promise<ShellExecResult> {
    return this.enqueue(async () => {
      const echo = options?.echo ?? false;
      if (echo) {
        // Clear any partially-typed interactive line, render like a typed command.
        this.write(`\r\x1b[K${this.prompt()}${line}\r\n`);
        if (line.trim() && this.history[this.history.length - 1] !== line) {
          this.history.push(line);
        }
        this.historyPos = -1;
      }
      try {
        const result = await this.runCommand(line, options?.signal);
        if (echo) {
          this.printResult(result);
          this.restoreLine();
        }
        return result;
      } catch (err) {
        if (echo) {
          this.write(`${RED}${toCrlf(errorMessage(err))}${RESET}\r\n`);
          this.restoreLine();
        }
        throw err;
      }
    });
  }

  // ==========================================================================
  // Keystroke handling (WTerm onData). While busy, ONLY Ctrl+C is accepted.
  // ==========================================================================

  handleInput(data: string): Promise<void> {
    // Defensive: strip bracketed-paste markers, normalize pasted newlines.
    if (data.length > 1) {
      data = data.replace(/\x1b\[20[01]~/g, "").replace(/\r\n|\n/g, "\r");
    }
    if (data.length === 0) return Promise.resolve();

    // Ctrl+C while a command runs must reach the AbortController immediately:
    // the input queue is blocked awaiting that same command, so it cannot wait
    // in line. Every other keystroke during a busy command is dropped.
    if (this.busy) {
      if (data.includes("\x03")) this.interrupt();
      return Promise.resolve();
    }

    // Serialize keystroke processing. tabComplete() and acceptLine() await the
    // VFS / a running command; WTerm's onData delivers keys back-to-back, so a
    // key arriving mid-await would mutate the shared cursor/line state and
    // scramble the render. One in-order queue makes every keystroke atomic.
    const run = this.inputQueue.then(() => this.process(data));
    this.inputQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async process(data: string): Promise<void> {
    // A programmatic exec() may have started a command after this key was queued
    // but before it ran — honor the same "no typing while busy" rule.
    if (this.busy) {
      if (data.includes("\x03")) this.interrupt();
      return;
    }

    switch (data) {
      case "\t":
        await this.tabComplete();
        return;
      case "\r":
        await this.acceptLine();
        return;
      case "\x7f":
      case "\b":
        this.backspace();
        return;
      case "\x1b[3~": // Delete
        this.deleteForward();
        return;
      case "\x1b[A": // Up
        this.historyPrev();
        return;
      case "\x1b[B": // Down
        this.historyNext();
        return;
      case "\x1b[D": // Left
        if (this.cursor > 0) {
          this.cursor--;
          this.write("\x1b[D");
        }
        return;
      case "\x1b[C": // Right
        if (this.cursor < this.line.length) {
          this.cursor++;
          this.write("\x1b[C");
        }
        return;
      case "\x01": // Ctrl+A — start of line
      case "\x1b[H":
      case "\x1b[1~":
        if (this.cursor > 0) {
          this.write(`\x1b[${this.cursor}D`);
          this.cursor = 0;
        }
        return;
      case "\x05": // Ctrl+E — end of line
      case "\x1b[F":
      case "\x1b[4~":
        if (this.cursor < this.line.length) {
          this.write(`\x1b[${this.line.length - this.cursor}C`);
          this.cursor = this.line.length;
        }
        return;
      case "\x15": // Ctrl+U — kill line
        if (this.line.length > 0) {
          if (this.cursor > 0) this.write(`\x1b[${this.cursor}D`);
          this.write("\x1b[K");
          this.line = "";
          this.cursor = 0;
        }
        return;
      case "\x17": // Ctrl+W — kill word backwards
        this.killWordBack();
        return;
      case "\x03": // Ctrl+C — abandon current line
        this.line = "";
        this.cursor = 0;
        this.continuation = "";
        this.historyPos = -1;
        this.write("^C\r\n");
        this.write(this.prompt());
        return;
      case "\x0c": // Ctrl+L — clear screen
        this.write("\x1b[2J\x1b[H");
        this.write(this.prompt());
        this.write(this.line);
        if (this.cursor < this.line.length) {
          this.write(`\x1b[${this.line.length - this.cursor}D`);
        }
        return;
    }

    if (data.length === 1 && data >= " ") {
      this.insert(data);
    } else if (data.length > 1 && !data.startsWith("\x1b")) {
      // Multi-char paste — feed sequentially (a "\r" mid-paste runs the line
      // and the loop resumes with the remaining characters afterwards). Stays
      // within this one queued task, so the paste is atomic against live keys.
      for (const ch of data) {
        await this.process(ch);
      }
    }
    // Unknown escape sequences fall through and are ignored.
  }

  /** Abort the in-flight command (Ctrl+C while busy). */
  interrupt(): void {
    if (this.currentAbort) {
      this.write("^C\r\n");
      this.currentAbort.abort();
    }
  }

  // ==========================================================================
  // internals
  // ==========================================================================

  private insert(data: string): void {
    const tail = this.line.slice(this.cursor);
    this.line = this.line.slice(0, this.cursor) + data + tail;
    this.cursor += data.length;
    if (tail.length === 0) {
      this.write(data);
    } else {
      this.write(data + tail + "\x1b[K");
      this.write(`\x1b[${tail.length}D`);
    }
  }

  private backspace(): void {
    if (this.cursor === 0) return;
    const tail = this.line.slice(this.cursor);
    this.line = this.line.slice(0, this.cursor - 1) + tail;
    this.cursor--;
    this.write("\b" + tail + "\x1b[K");
    if (tail.length > 0) this.write(`\x1b[${tail.length}D`);
  }

  private deleteForward(): void {
    if (this.cursor >= this.line.length) return;
    const tail = this.line.slice(this.cursor + 1);
    this.line = this.line.slice(0, this.cursor) + tail;
    this.write(tail + "\x1b[K");
    if (tail.length > 0) this.write(`\x1b[${tail.length}D`);
  }

  private killWordBack(): void {
    if (this.cursor === 0) return;
    const head = this.line.slice(0, this.cursor);
    const cut = head.replace(/\S+\s*$/, "");
    const removed = head.length - cut.length;
    if (removed === 0) return;
    const tail = this.line.slice(this.cursor);
    this.line = cut + tail;
    this.cursor = cut.length;
    this.write(`\x1b[${removed}D` + tail + "\x1b[K");
    if (tail.length > 0) this.write(`\x1b[${tail.length}D`);
  }

  private redrawLine(): void {
    this.write(`\r${this.prompt()}\x1b[K${this.line}`);
    const back = this.line.length - this.cursor;
    if (back > 0) this.write(`\x1b[${back}D`);
  }

  /** After a programmatic echo run, re-render the user's partial line. */
  private restoreLine(): void {
    this.write(this.prompt() + this.line);
    const back = this.line.length - this.cursor;
    if (back > 0) this.write(`\x1b[${back}D`);
  }

  private setLine(text: string): void {
    this.line = text;
    this.cursor = text.length;
    this.write(`\r${this.prompt()}\x1b[K${text}`);
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.historyPos < 0) this.historyPos = this.history.length;
    if (this.historyPos > 0) {
      this.historyPos--;
      this.setLine(this.history[this.historyPos]!);
    }
  }

  private historyNext(): void {
    if (this.historyPos < 0) return;
    this.historyPos++;
    if (this.historyPos >= this.history.length) {
      this.historyPos = -1;
      this.setLine("");
    } else {
      this.setLine(this.history[this.historyPos]!);
    }
  }

  private async acceptLine(): Promise<void> {
    const current = this.line;
    this.line = "";
    this.cursor = 0;
    this.write("\r\n");

    if (current.endsWith("\\")) {
      this.continuation += current.slice(0, -1) + "\n";
      this.write("> ");
      return;
    }

    const cmd = this.continuation + current;
    this.continuation = "";

    if (!cmd.trim()) {
      this.write(this.prompt());
      return;
    }

    if (this.history[this.history.length - 1] !== cmd) {
      this.history.push(cmd);
    }
    this.historyPos = -1;

    try {
      const result = await this.enqueue(() => this.runCommand(cmd));
      this.printResult(result);
    } catch (err) {
      this.write(`${RED}${toCrlf(errorMessage(err))}${RESET}\r\n`);
    }
    this.write(this.prompt());
  }

  /**
   * THE execution core (contract §5): one exec, thread {cwd, env}, read the
   * new state back from result.env. Runs inside the queue.
   */
  private async runCommand(cmd: string, externalSignal?: AbortSignal): Promise<ShellExecResult> {
    const ac = new AbortController();
    const onExternalAbort = () => ac.abort();
    if (externalSignal) {
      if (externalSignal.aborted) ac.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    this.currentAbort = ac;
    this.busy = true;
    try {
      const result = await this.bash.exec(cmd, { cwd: this.cwd, env: this.env, signal: ac.signal });
      this.env = result.env;
      const nextCwd = result.env.PWD ?? this.cwd;
      if (nextCwd !== this.cwd) {
        this.cwd = nextCwd;
        this.events.emit("cwd:changed", { cwd: nextCwd });
      }
      return result;
    } finally {
      this.busy = false;
      this.currentAbort = null;
      externalSignal?.removeEventListener("abort", onExternalAbort);
      this.events.emit("fs:batch", { reason: "shell-command" });
    }
  }

  private printResult(result: ShellExecResult): void {
    const stdout = result.stdoutKind === "bytes" ? decodeByteString(result.stdout) : result.stdout;
    if (stdout) {
      this.write(toCrlf(stdout));
      if (!stdout.endsWith("\n")) this.write("\r\n");
    }
    if (result.stderr) {
      this.write(`${RED}${toCrlf(result.stderr)}${RESET}`);
      if (!result.stderr.endsWith("\n")) this.write("\r\n");
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Read-only helper exec for completion probes — does NOT adopt env/cwd. */
  private async probe(cmd: string): Promise<ShellExecResult | null> {
    try {
      return await this.bash.exec(cmd, { cwd: this.cwd, env: this.env });
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Tab completion (files always; command names for the first word)
  // ==========================================================================

  private async tabComplete(): Promise<void> {
    const line = this.line.slice(0, this.cursor);
    if (line !== this.line) return; // only complete at end-of-line
    const parts = line.split(/\s+/);
    const word = parts[parts.length - 1] ?? "";
    const isFirstWord = parts.filter(Boolean).length <= 1 && !line.endsWith(" ");

    let dir: string;
    let prefix: string;
    if (word.includes("/")) {
      const lastSlash = word.lastIndexOf("/");
      const rawDir = word.slice(0, lastSlash + 1);
      prefix = word.slice(lastSlash + 1);
      if (rawDir.startsWith("/")) dir = rawDir;
      else if (rawDir === "~/" || rawDir.startsWith("~/")) dir = `${this.env.HOME ?? WORKSPACE_ROOT}/${rawDir.slice(2)}`;
      else dir = `${this.cwd}/${rawDir}`;
    } else {
      dir = this.cwd;
      prefix = word;
    }

    const candidates: string[] = [];

    const ls = await this.probe(`ls -1a ${JSON.stringify(dir)}`);
    if (ls && ls.exitCode === 0 && ls.stdout) {
      for (const name of ls.stdout.split("\n")) {
        if (name && name !== "." && name !== ".." && name.startsWith(prefix)) {
          candidates.push(name);
        }
      }
    }

    if (isFirstWord && !word.includes("/")) {
      const compgen = await this.probe(`compgen -c ${JSON.stringify(prefix)} 2>/dev/null || true`);
      if (compgen && compgen.exitCode === 0 && compgen.stdout) {
        for (const name of compgen.stdout.split("\n")) {
          if (name && !candidates.includes(name)) candidates.push(name);
        }
      }
    }

    if (candidates.length === 0) return;

    if (candidates.length === 1) {
      const completion = candidates[0]!.slice(prefix.length);
      if (completion) this.insert(completion);
      // Append "/" when the single candidate is a directory.
      const full = word + completion;
      const testPath = full.startsWith("/") ? full : `${this.cwd}/${full}`;
      const stat = await this.probe(`test -d ${JSON.stringify(testPath)} && echo DIR`);
      if (stat?.stdout?.trim() === "DIR" && !this.line.endsWith("/")) {
        this.insert("/");
      }
      return;
    }

    // Longest common prefix across candidates.
    let common = candidates[0]!;
    for (let i = 1; i < candidates.length; i++) {
      while (!candidates[i]!.startsWith(common)) common = common.slice(0, -1);
    }
    const partial = common.slice(prefix.length);
    if (partial) {
      this.insert(partial);
    } else {
      this.write("\r\n" + candidates.join("  ") + "\r\n");
      this.redrawLine();
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
