/**
 * Burrow — src/vfs/workspace-command.ts
 * The `workspace` terminal command (registered via registerShellCommand in
 * initVfs — the earliest registration point, well before the shell seals).
 *
 *   workspace          — alias for `workspace info`
 *   workspace info     — persistence backend, live file count/bytes, last save
 *   workspace reset    — wipe /home/user + persisted snapshot, reseed the demo
 */

import type { BurrowVfs, CommandSpec, ShellExecResult } from "../contract/types.ts";
import type { WorkspacePersistence } from "./persistence.ts";
import { captureSnapshot, snapshotStats } from "./snapshot.ts";

const USAGE = "usage: workspace [info|reset]\n";

export function createWorkspaceCommand(deps: {
  vfs: BurrowVfs;
  persistence: WorkspacePersistence;
  reset: () => Promise<void>;
}): CommandSpec {
  return {
    name: "workspace",
    async execute(args): Promise<ShellExecResult> {
      const sub = args[0] ?? "info";

      if (sub === "info") {
        const live = snapshotStats(await captureSnapshot(deps.vfs));
        const info = deps.persistence.info();
        const backend =
          info.backend === "none" ? "disabled (no IndexedDB — this tab only)" : `${info.backend} (burrow-workspace)`;
        const lastSaved =
          info.lastSavedAt === null
            ? "never (workspace matches the fresh seed)"
            : `${new Date(info.lastSavedAt).toISOString()}${info.dirty ? "  [unsaved changes pending]" : ""}`;
        const lines = [
          `persistence  ${backend}`,
          `files        ${live.fileCount}`,
          `bytes        ${formatBytes(live.bytes)} (${live.bytes} B)`,
          `last saved   ${lastSaved}`,
        ];
        return ok(`${lines.join("\n")}\n`);
      }

      if (sub === "reset") {
        await deps.reset();
        return ok("workspace reset: persisted snapshot cleared, demo content reseeded\n");
      }

      if (sub === "help" || sub === "--help" || sub === "-h") {
        return ok(USAGE);
      }

      return { stdout: "", stderr: `workspace: unknown subcommand "${sub}"\n${USAGE}`, exitCode: 2 };
    },
  };
}

function ok(stdout: string): ShellExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
