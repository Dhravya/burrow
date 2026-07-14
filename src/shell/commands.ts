/**
 * Burrow — src/shell/commands.ts
 * `edit` / `open` shell commands: raise "editor:open" on the event bus
 * (CONTRACT.md §4). The UI editor subscribes and focuses/creates a tab.
 */

import { use } from "../contract/registry.ts";
import type { CommandSpec } from "../contract/types.ts";

/** Optional `path:line[:column]` suffix, e.g. `edit src/index.ts:42:7`. */
const LINE_SPEC = /^(.+?):(\d+)(?::(\d+))?$/;

export function editorOpenCommand(name: "edit" | "open"): CommandSpec {
  return {
    name,
    async execute(args, ctx) {
      const targets = args.filter((arg) => arg !== "--" && !arg.startsWith("-"));
      if (targets.length === 0) {
        return { stdout: "", stderr: `${name}: usage: ${name} <file> [<file> ...]\n`, exitCode: 1 };
      }
      const events = use("events");
      for (const target of targets) {
        let file = target;
        let line: number | undefined;
        let column: number | undefined;
        // Treat `x.ts:12` as a line spec only when no file literally named that exists.
        const match = LINE_SPEC.exec(target);
        if (match && !(await ctx.fs.exists(ctx.fs.resolvePath(ctx.cwd, target)))) {
          file = match[1]!;
          line = Number(match[2]);
          column = match[3] !== undefined ? Number(match[3]) : undefined;
        }
        const path = ctx.fs.resolvePath(ctx.cwd, file);
        events.emit("editor:open", { path, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}
