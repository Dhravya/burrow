/**
 * burrow — src/contract/registry.ts
 * OWNED BY: architect. Typed service locator + shell-command collection point.
 * This is the ONLY sanctioned cross-module value import (besides the init
 * entrypoints listed in CONTRACT.md §1 and src/git/proxy.ts on the server).
 */

import type { CommandSpec, Services } from "./types.ts";

const services = new Map<keyof Services, Services[keyof Services]>();

/** Called exactly once per service by its owning module's init (see boot order). */
export function provide<K extends keyof Services>(name: K, service: Services[K]): void {
  if (services.has(name)) {
    throw new Error(`[burrow] service "${name}" provided twice — check boot order in CONTRACT.md`);
  }
  services.set(name, service);
}

/** Throws if the service is not up yet — never call before its init per CONTRACT.md §1 boot order. */
export function use<K extends keyof Services>(name: K): Services[K] {
  const service = services.get(name);
  if (service === undefined) {
    throw new Error(`[burrow] service "${name}" not provided yet — check boot order in CONTRACT.md`);
  }
  return service as Services[K];
}

/** Non-throwing variant for optional integrations (e.g. UI probing "ai"). */
export function tryUse<K extends keyof Services>(name: K): Services[K] | undefined {
  return services.get(name) as Services[K] | undefined;
}

/**
 * TEST-ONLY: wipe services + unseal shell commands. `bun test` runs every file
 * in one process, and file order differs across platforms — a registry-booting
 * test file (src/vfs/index.test.ts) calls this first so a lazily-providing file
 * that happened to run earlier (src/shell/driver.test.ts) can't trip the
 * double-provide guard. Never call outside tests.
 */
export function resetRegistryForTests(): void {
  services.clear();
  shellCommands.length = 0;
  shellCommandsSealed = false;
}

// ---------------------------------------------------------------------------
// Shell command collection. Modules register during their init; the shell
// module (which boots after all command providers) drains this list into
// just-bash `customCommands`. Registering after shell boot is a contract
// violation and throws.
// ---------------------------------------------------------------------------

const shellCommands: CommandSpec[] = [];
let shellCommandsSealed = false;

export function registerShellCommand(spec: CommandSpec): void {
  if (shellCommandsSealed) {
    throw new Error(`[burrow] registerShellCommand("${spec.name}") after shell boot — register during module init`);
  }
  shellCommands.push(spec);
}

/** Shell module only: drains + seals the command list at Bash construction time. */
export function sealShellCommands(): readonly CommandSpec[] {
  shellCommandsSealed = true;
  return shellCommands;
}

// ---------------------------------------------------------------------------
// Shared helper: just-bash ctx.stdin is a latin1 ByteString. The browser
// bundle does NOT export decodeBytesToUtf8, so this is the canonical decode.
// ---------------------------------------------------------------------------

export function decodeStdin(stdin: string): string {
  return new TextDecoder().decode(Uint8Array.from(stdin, (c) => c.charCodeAt(0)));
}
