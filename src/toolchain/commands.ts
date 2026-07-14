/**
 * Burrow src/toolchain — the `bun` and `serve` terminal commands (CONTRACT.md §4).
 *
 *   bun run <file> | bun <file>   → toolchain.run, stream RunnerEvents to stdout
 *                                   until exit (or return early on serve-listening).
 *   bun build <file>              → buildGraph, print the module list or errors.
 *   bun stop                      → stopAll().
 *   serve [file]                  → run an entry expected to call Bun.serve; wait
 *                                   for serve-listening, print the preview URL.
 *
 * just-bash delivers a command's output whole (no streaming), so we accumulate
 * stdout/stderr and return them once the run reaches a terminal state. The UI
 * console pane streams the same RunnerEvents live off the session directly.
 */

import { PREVIEW_PREFIX } from "../contract/types.ts";
import type { CommandContext, CommandSpec, RunSession, RunnerEvent, ShellExecResult } from "../contract/types.ts";
import { buildGraph } from "./graph.ts";
import { run, stopAll } from "./session.ts";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  orange: "\x1b[38;5;214m",
};

/**
 * Handled by src/npm's extended `bun` spec, which registers after ours and
 * shadows it (just-bash: last registration wins) — it intercepts these and
 * delegates everything else back here. If one of these reaches THIS spec,
 * the npm module failed to init (degraded boot) and we say so.
 */
const NPM_SUBCOMMANDS = new Set(["install", "i", "add", "remove", "rm"]);

const UNSUPPORTED_SUBCOMMANDS = new Set([
  "update",
  "outdated",
  "link",
  "unlink",
  "test",
  "x",
  "create",
  "init",
  "upgrade",
  "pm",
  "publish",
  "patch",
  "repl",
]);

const BUN_USAGE = `${C.bold}Burrow${C.reset} — a slice of bun, in your tab

${C.bold}usage:${C.reset}
   ${C.cyan}bun run${C.reset} <file>      transpile + execute a module graph in a worker
   ${C.cyan}bun${C.reset} <file>          alias for ${C.cyan}bun run${C.reset}
   ${C.cyan}bun build${C.reset} <file>    resolve the graph and print the bundled modules
   ${C.cyan}bun stop${C.reset}            stop every running session
   ${C.cyan}serve${C.reset} [file]        run an entry that serves HTTP (default ./index.ts, ./server.ts)

servers hot-reload on file change by default; pass ${C.cyan}--no-hot${C.reset} to opt out.
a server is anything that calls ${C.cyan}Bun.serve${C.reset} — or just ${C.cyan}export default app${C.reset}
(any object with a fetch method, e.g. a Hono app, or a bare request handler).
`;

function ok(stdout = ""): ShellExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(message: string, exitCode = 1): ShellExecResult {
  return { stdout: "", stderr: message.endsWith("\n") ? message : message + "\n", exitCode };
}

function firstFile(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

function previewUrl(port?: number): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin ?? "";
  return port === undefined ? `${origin}${PREVIEW_PREFIX}/` : `${origin}${PREVIEW_PREFIX}/${port}/`;
}

function formatConsole(event: Extract<RunnerEvent, { type: "console" }>): string {
  const line = event.args.join(" ");
  if (event.level === "error") return `${C.red}${line}${C.reset}\n`;
  if (event.level === "warn") return `${C.yellow}${line}${C.reset}\n`;
  if (event.level === "debug") return `${C.dim}${line}${C.reset}\n`;
  return line + "\n";
}

function formatError(event: Extract<RunnerEvent, { type: "error" }>): string {
  const header = `${C.red}${C.bold}${event.kind}:${C.reset} ${C.red}${event.message}${C.reset}\n`;
  if (event.stack && event.stack.trim() && event.stack.trim() !== event.message.trim()) {
    return header + `${C.dim}${event.stack}${C.reset}\n`;
  }
  return header;
}

/**
 * Subscribe to a session and settle once it reaches a terminal state:
 *  - serve-listening → print the preview URL and return (server keeps running),
 *  - exit            → return with the module's exit code.
 * Honors ctx.signal by stopping the session (Ctrl+C in the terminal).
 */
function streamSession(
  session: RunSession,
  ctx: CommandContext,
  requireServer: boolean,
  hot: boolean,
): Promise<ShellExecResult> {
  return new Promise<ShellExecResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let sawServer = false;
    let settled = false;
    // Assigned after onEvent(); onEvent replays buffered events SYNCHRONOUSLY
    // (e.g. a build failure's error+exit), so settle() may run before the real
    // unsubscribe exists — the no-op default keeps that from throwing.
    let unsubscribe: () => void = () => {};

    const settle = (result: ShellExecResult): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      ctx.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = (): void => {
      settle({ stdout, stderr: stderr + `${C.dim}^C — session stopped${C.reset}\n`, exitCode: 130 });
      session.stop();
    };

    unsubscribe = session.onEvent((event) => {
      switch (event.type) {
        case "console":
          stdout += formatConsole(event);
          break;
        case "error":
          stderr += formatError(event);
          break;
        case "serve-listening":
          sawServer = true;
          stdout += `${C.green}${C.bold}⚡ server is listening${C.reset} ${C.dim}→${C.reset} ${C.cyan}${previewUrl(event.port)}${C.reset}\n`;
          stdout += hot
            ? `${C.dim}   hot reload is on — edit a file and the server restarts (\`--no-hot\` to opt out, \`bun stop\` to halt)${C.reset}\n`
            : `${C.dim}   the server keeps running — open the preview tab, or \`bun stop\` to halt it${C.reset}\n`;
          settle({ stdout, stderr, exitCode: 0 });
          break;
        case "exit":
          if (requireServer && !sawServer) {
            settle({
              stdout,
              stderr:
                stderr +
                `${C.red}serve: the entry finished without starting a server — call Bun.serve() or \`export default app\`${C.reset}\n`,
              exitCode: 1,
            });
          } else {
            settle({ stdout, stderr, exitCode: event.code });
          }
          break;
      }
    });
    // If a buffered event already settled us during replay, drop the subscription.
    if (settled) unsubscribe();

    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort);
    }
  });
}

async function startRun(absPath: string, ctx: CommandContext, requireServer: boolean, hot: boolean): Promise<ShellExecResult> {
  let session: RunSession;
  try {
    session = await run(absPath, { hot });
  } catch (error) {
    return fail(`bun: failed to start ${absPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return streamSession(session, ctx, requireServer, hot);
}

/** `--no-hot` (or `--hot=false`) disables the default watch-and-restart behavior. */
function wantsHot(args: string[]): boolean {
  return !args.includes("--no-hot") && !args.includes("--hot=false");
}

async function doRun(args: string[], ctx: CommandContext): Promise<ShellExecResult> {
  const file = firstFile(args);
  if (!file) return fail("bun run: no entrypoint given\nusage: bun run [--no-hot] <file>", 129);
  const abs = ctx.fs.resolvePath(ctx.cwd, file);
  if (!(await ctx.fs.exists(abs))) return fail(`bun run: module not found: ${file}`, 1);
  return startRun(abs, ctx, false, wantsHot(args));
}

async function doBuild(args: string[], ctx: CommandContext): Promise<ShellExecResult> {
  const file = firstFile(args);
  if (!file) return fail("bun build: no entrypoint given\nusage: bun build <file>", 129);
  const abs = ctx.fs.resolvePath(ctx.cwd, file);

  const result = await buildGraph(abs);
  if (!result.ok) {
    const body = result.errors.map((error) => `${C.red}${error.path}${C.reset}: ${error.message}`).join("\n");
    return { stdout: "", stderr: body + "\n", exitCode: 1 };
  }

  const lines: string[] = [
    `${C.green}${C.bold}✓${C.reset} bundled ${C.bold}${result.modules.length}${C.reset} module${result.modules.length === 1 ? "" : "s"}`,
  ];
  for (const mod of result.modules) {
    lines.push(`  ${C.cyan}${mod.path}${C.reset}`);
    for (const [spec, target] of Object.entries(mod.deps)) {
      const shown = target.startsWith("blob:") ? `${C.dim}(inlined module)${C.reset}` : `${C.dim}${target}${C.reset}`;
      lines.push(`      ${C.dim}↳${C.reset} ${spec} ${C.dim}→${C.reset} ${shown}`);
    }
  }

  // bun build only reports the graph — nothing imports these blobs, so free them.
  for (const mod of result.modules) URL.revokeObjectURL(mod.blobUrl);

  return ok(lines.join("\n") + "\n");
}

function createBunCommand(): CommandSpec {
  return {
    name: "bun",
    async execute(args, ctx): Promise<ShellExecResult> {
      const first = args[0];
      if (!first || first === "--help" || first === "-h" || first === "help") return ok(BUN_USAGE);
      if (first === "--version" || first === "-v") return ok(`burrow ${C.orange}1.0.0-wasm${C.reset}\n`);
      if (first === "run") return doRun(args.slice(1), ctx);
      if (first === "build") return doBuild(args.slice(1), ctx);
      if (first === "stop") {
        stopAll();
        return ok(`${C.dim}stopped all running sessions${C.reset}\n`);
      }
      if (NPM_SUBCOMMANDS.has(first)) {
        return fail(
          `bun ${first}: the package-manager module didn't load (degraded boot) — reload the tab and check the console.`,
          1,
        );
      }
      if (UNSUPPORTED_SUBCOMMANDS.has(first)) {
        return fail(
          `bun ${first}: not available in Burrow.\n` +
            `package management: \`bun install\`, \`bun add <pkg>\`, \`bun remove <pkg>\`;\n` +
            `imports resolve from node_modules first, then https://esm.sh — so \`bun run\` just works either way.`,
          1,
        );
      }
      // Plain `bun <file>` aliases `bun run <file>`.
      return doRun(args, ctx);
    },
  };
}

function createServeCommand(): CommandSpec {
  return {
    name: "serve",
    async execute(args, ctx): Promise<ShellExecResult> {
      let file = firstFile(args);
      if (!file) {
        for (const candidate of ["./index.ts", "./server.ts", "./index.tsx", "./index.js"]) {
          if (await ctx.fs.exists(ctx.fs.resolvePath(ctx.cwd, candidate))) {
            file = candidate;
            break;
          }
        }
        if (!file) {
          return fail("serve: no entry found (looked for ./index.ts, ./server.ts) — pass one: serve <file>", 1);
        }
      }
      const abs = ctx.fs.resolvePath(ctx.cwd, file);
      if (!(await ctx.fs.exists(abs))) return fail(`serve: module not found: ${file}`, 1);
      return startRun(abs, ctx, true, wantsHot(args));
    },
  };
}

/** Both toolchain-owned command specs (registered in initToolchain). */
export function createToolchainCommands(): CommandSpec[] {
  return [createBunCommand(), createServeCommand()];
}
