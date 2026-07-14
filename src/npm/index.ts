/**
 * burrow — src/npm/index.ts (owned by the COMMAND+LOCKFILE agent)
 * Module init entrypoint for the in-browser package manager.
 *
 * initNpm():
 *   1. provides the NpmInstaller to the registry under the ADDITIVE key "npm"
 *      (Services is extended via module augmentation below — contract files
 *      themselves are untouched),
 *   2. registers the extended `bun` command (install/add/remove subcommands,
 *      everything else delegated to the toolchain's spec).
 *
 * INTEGRATOR NOTE (src/ui/main.tsx): call initNpm() AFTER initToolchain() and
 * before initShell() —
 *
 *     await stepAsync("toolchain", () => initToolchain());
 *     step("npm", () => initNpm());                          // ← add this line
 *
 * The ordering matters twice over: the npm `bun` spec must register after the
 * toolchain's so it wins just-bash's last-name-wins command map, and before
 * the shell seals the command registry.
 */

import { provide, registerShellCommand, tryUse } from "../contract/registry.ts";
import { createNpmCommands, createNpmInstaller } from "./cli.ts";
import type { NpmInstaller } from "./types.ts";

// Additive extension of the frozen contract: registry key "npm".
declare module "../contract/types.ts" {
  interface Services {
    npm: NpmInstaller;
  }
}

let initialized = false;

export function initNpm(): void {
  if (initialized) return;
  initialized = true;

  if (tryUse("toolchain") === undefined) {
    console.warn(
      "[burrow] initNpm() ran before initToolchain() — the toolchain `bun` command will shadow " +
        "install/add/remove. Call initNpm() after initToolchain() in main.tsx.",
    );
  }

  const installer = createNpmInstaller();
  provide("npm", installer);
  for (const command of createNpmCommands(installer)) registerShellCommand(command);
}

// Re-exports for tests and the sanctioned frontend entry.
export { createNpmCommands, createNpmInstaller } from "./cli.ts";
export type { NpmInstaller } from "./types.ts";
