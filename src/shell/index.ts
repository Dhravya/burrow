/**
 * Burrow — src/shell/index.ts
 * Terminal + bash wiring (CONTRACT.md §5).
 *
 * initShell(termEl):
 *   1. registers this module's own `edit`/`open` commands,
 *   2. seals the shell-command registry and wraps every CommandSpec with
 *      just-bash defineCommand (also creates /usr/bin stubs → `which git` works),
 *   3. constructs ONE Bash over the shared WatchedFs ("vfs" service),
 *   4. mounts a WTerm into termEl and attaches the ShellDriver,
 *   5. provides "shell" (ShellAPI) to the registry.
 */

import { WTerm } from "@wterm/dom";
import "@wterm/dom/css";
import "./terminal.css";
import { Bash, defineCommand } from "just-bash/browser";
import type { CustomCommand, ExecResult, IFileSystem } from "just-bash/browser";
import { provide, registerShellCommand, sealShellCommands, tryUse, use } from "../contract/registry.ts";
import { WORKSPACE_ROOT } from "../contract/types.ts";
import type { CommandContext, ShellAPI } from "../contract/types.ts";
import { editorOpenCommand } from "./commands.ts";
import { CommandMemory, createCommandMemoryStorage } from "./command-memory.ts";
import { createHybridSuggestionProvider, ProjectCompletionContextProvider } from "./completion.ts";
import { BASE_ENV, ShellDriver } from "./driver.ts";

const GREETING: readonly string[] = [
  "\x1b[1;38;5;214mburrow\x1b[0m \x1b[2m— a dev machine in this tab. real bun, real git, real shell, nothing leaves the browser.\x1b[0m",
  "\x1b[2mtry \x1b[0m\x1b[36mbun run <file>\x1b[0m\x1b[2m · \x1b[0m\x1b[36mbun add <pkg>\x1b[0m\x1b[2m · \x1b[0m\x1b[36mgit clone <url>\x1b[0m\x1b[2m · \x1b[0m\x1b[36medit <file>\x1b[0m",
  "",
];

export async function initShell(termEl: HTMLElement): Promise<void> {
  // 1. Our own commands must be registered before sealing (contract §1).
  registerShellCommand(editorOpenCommand("edit"));
  registerShellCommand(editorOpenCommand("open"));

  // 2. Drain + seal the registry; wrap specs as just-bash custom commands.
  //    Contract shapes are structurally identical to just-bash's — the cast
  //    (fs: BurrowVfs vs IFileSystem on the SAME WatchedFs object, stdin
  //    ByteString branding) is confined to this module by design.
  const customCommands: CustomCommand[] = sealShellCommands().map((spec) =>
    defineCommand(spec.name, (args, ctx): Promise<ExecResult> => spec.execute(args, ctx as unknown as CommandContext)),
  );

  const vfs = use("vfs");
  const events = use("events");
  const commandMemory = new CommandMemory(createCommandMemoryStorage());
  await commandMemory.load();
  commandMemory.attachLifecycle();
  const completionContext = new ProjectCompletionContextProvider(vfs, events, tryUse("git"));
  const suggestionProvider = createHybridSuggestionProvider({
    memory: commandMemory,
    context: completionContext,
    ai: tryUse("ai"),
  });

  // 3. One Bash for the lifetime of the app. Shell state (cwd/env) does NOT
  //    persist across exec() calls — the driver threads it manually.
  const bash = new Bash({
    fs: vfs as unknown as IFileSystem,
    customCommands,
    env: { ...BASE_ENV },
    cwd: WORKSPACE_ROOT,
  });

  // 4. Terminal. onData MUST be set (else WTerm self-echoes → doubled chars).
  //    handleInput is intentionally not awaited: keystrokes keep flowing while
  //    a command runs, which is how Ctrl+C interrupts a busy shell.
  let driver!: ShellDriver;
  const term = new WTerm(termEl, {
    cursorBlink: true,
    // We drive resize ourselves (see attachAutoResize). WTerm's built-in
    // autoResize re-measures char metrics by mutating the DOM *inside* its
    // ResizeObserver callback, which makes Chrome spam "ResizeObserver loop
    // completed with undelivered notifications" and can feed back through the
    // scrollbar on every resize.
    autoResize: false,
    onData: (data) => {
      void driver.handleInput(data);
    },
  });
  driver = new ShellDriver({
    bash,
    events,
    write: (data) => term.write(data),
    greeting: GREETING,
    initialHistory: commandMemory.history(),
    suggestionProvider,
    onCommand: async (event) => {
      const context = await completionContext.get(event.cwd);
      commandMemory.record({
        projectKey: context.projectKey,
        projectRoot: context.projectRoot,
        cwd: event.cwd,
        command: event.command,
        exitCode: event.exitCode,
        source: event.source,
      });
    },
    onSuggestionAccepted: async (event) => {
      const context = await completionContext.get(event.cwd);
      commandMemory.markAccepted(context, event.command);
    },
  });

  await term.init();
  // With autoResize off, WTerm's init locks an explicit pixel height on the
  // element; clear it so the terminal fills its absolutely-positioned box.
  termEl.style.height = "";
  attachAutoResize(termEl, term);

  // Keep onData the SINGLE source of truth for input. WTerm's InputHandler
  // emits a recognized key from `keydown` (after preventDefault) AND keeps an
  // `input` listener on its hidden textarea as the fallback for IME / mobile /
  // dictation, relying on keydown's preventDefault to suppress that input
  // event. On browser + input-method combinations where preventDefault does
  // NOT stop the textarea insertion, every printable key reaches onData twice
  // — typing `ls` yields `llss` (and bash then runs `llss`). Drop the
  // redundant `input`-sourced copy at the DOM boundary, before WTerm's own
  // handler reads the textarea, but ONLY when the inserted text is exactly the
  // character the preceding keydown already delivered. Composition commits
  // (inputType `insertCompositionText`) and paste (`insertFromPaste`) have no
  // matching prior keydown and pass through untouched.
  dedupePrintableInput(termEl);

  driver.start();
  term.focus();

  // 5. Programmatic terminal access for other modules / the UI Run button.
  const shell: ShellAPI = {
    exec: (line, options) => driver.exec(line, options),
    getCwd: () => driver.getCwd(),
    print: (text) => term.write(text),
    focus: () => term.focus(),
  };
  provide("shell", shell);
}

/**
 * Drive WTerm's cols/rows from the container size ourselves, replacing WTerm's
 * built-in autoResize. Two reasons: (1) WTerm's observer re-measures char size
 * by appending/removing a probe node *inside* the ResizeObserver callback,
 * which triggers Chrome's "ResizeObserver loop completed with undelivered
 * notifications" on every resize; (2) enabling terminal scrollback means a
 * scrollbar can appear and change the content width, feeding back into the
 * observer. Here the measure + resize run inside requestAnimationFrame — OUTSIDE
 * the observation delivery — and bursts are coalesced to a single frame, so the
 * loop can't form and the warning never fires. Zero/hidden sizes are skipped so
 * a hidden panel never collapses the grid.
 */
function attachAutoResize(el: HTMLElement, term: WTerm): void {
  let scheduled = false;

  const measureCell = (): { cw: number; ch: number } | null => {
    // Mirror WTerm's own _measureCharSize EXACTLY: a `.term-row` holding a
    // <span>, appended to the inner `.term-grid` (not the outer element) so the
    // grid's font/line-height apply. Measuring anywhere else yields the wrong
    // row height and the grid ends up taller than its box (blank, scrolled-off).
    const grid = el.querySelector<HTMLElement>(".term-grid") ?? el;
    const row = document.createElement("div");
    row.className = "term-row";
    row.style.cssText = "position:absolute;visibility:hidden;white-space:pre;pointer-events:none;";
    const span = document.createElement("span");
    span.textContent = "W".repeat(20);
    row.appendChild(span);
    grid.appendChild(row);
    const cw = span.getBoundingClientRect().width / 20;
    const ch = row.getBoundingClientRect().height;
    row.remove();
    if (cw === 0 || ch === 0) return null;
    return { cw, ch };
  };

  const apply = (): void => {
    scheduled = false;
    const cell = measureCell();
    if (!cell) return; // not laid out (hidden / detached) — keep current size
    const cs = getComputedStyle(el);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const cols = Math.max(2, Math.floor((el.clientWidth - padX) / cell.cw));
    const rows = Math.max(1, Math.floor((el.clientHeight - padY) / cell.ch));
    if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(apply);
  };

  new ResizeObserver(schedule).observe(el);
  // Size to the real container SYNCHRONOUSLY now, before the caller writes the
  // greeting — otherwise the greeting lands in WTerm's default 24-row buffer and
  // the first (async) resize reflows it out of view, leaving a blank terminal.
  apply();
}

/**
 * Neutralize WTerm 0.3.0's double-emit of printable keys (keydown path +
 * hidden-textarea `input` path) on browsers where keydown's preventDefault
 * fails to suppress the input event. Deterministic and event-ordering based
 * (no timers): capture-phase listeners on the terminal element run before
 * WTerm's own textarea listeners, so the redundant `input` copy is swallowed
 * before WTerm can re-emit it. A no-op on browsers that don't double —
 * printable keydowns produce no `input` event there, so nothing is dropped.
 */
function dedupePrintableInput(termEl: HTMLElement): void {
  const textarea = termEl.querySelector<HTMLTextAreaElement>("textarea");
  let lastKeyChar: string | null = null;

  termEl.addEventListener(
    "keydown",
    (e) => {
      // Mirror WTerm's keyToSequence printable branch: a bare single char.
      lastKeyChar =
        !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && e.key.length === 1 && e.key >= " "
          ? e.key
          : null;
    },
    true,
  );

  termEl.addEventListener(
    "input",
    (e) => {
      const ie = e as InputEvent;
      const inserted = ie.data ?? textarea?.value ?? null;
      if (lastKeyChar !== null && ie.inputType === "insertText" && inserted === lastKeyChar) {
        // WTerm already emitted this char from keydown — drop the duplicate.
        if (textarea) textarea.value = "";
        e.stopImmediatePropagation();
      }
      lastKeyChar = null;
    },
    true,
  );
}

/** Convenience alias: mount the terminal into an element. Same as initShell. */
export const mountTerminal: (el: HTMLElement) => Promise<void> = initShell;
