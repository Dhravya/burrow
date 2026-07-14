/**
 * Burrow — src/toolchain/index.ts
 * Module init entrypoint per CONTRACT.md §1. Boot order guarantees initVfs()
 * (and initGit) ran first, so "events" + "vfs" are in the registry.
 *
 * initToolchain():
 *   1. provides the ToolchainAPI ("toolchain") to the registry,
 *   2. registers the `bun` + `serve` shell commands (before shell boots),
 *   3. registers public/sw.js and wires the page-side preview bridge.
 *
 * bun.wasm stays LAZY — the singleton loads on the first transpile/build/run.
 */

import { provide, registerShellCommand } from "../contract/registry.ts";
import type { ToolchainAPI } from "../contract/types.ts";
import { createToolchainCommands } from "./commands.ts";
import { buildGraph, transpileFile } from "./graph.ts";
import { loaderForPath } from "./paths.ts";
import { activePreviewSession, previewServers, run, stopAll } from "./session.ts";
import { registerServiceWorker } from "./sw-bridge.ts";
import { ready, transpileSource } from "./wasm.ts";

let initialized = false;

const toolchain: ToolchainAPI = {
  ready,
  loaderForPath,
  transpileSource,
  transpileFile,
  buildGraph,
  run,
  activePreviewSession,
  previewServers,
  stopAll,
};

export async function initToolchain(): Promise<void> {
  if (initialized) return;
  initialized = true;

  provide("toolchain", toolchain);

  for (const command of createToolchainCommands()) registerShellCommand(command);

  await registerServiceWorker();
}

// Re-exports for the sanctioned frontend entry (src/ui/main.tsx) and tests.
export { buildGraph, transpileFile } from "./graph.ts";
export { activePreviewSession, previewServers, run, stopAll } from "./session.ts";
export { registerServiceWorker } from "./sw-bridge.ts";
export { ready, transpileSource } from "./wasm.ts";
export { loaderForPath } from "./paths.ts";
