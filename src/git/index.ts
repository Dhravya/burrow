/**
 * Burrow — src/git/index.ts
 * Module init entrypoint per CONTRACT.md §1. Boot order guarantees initVfs()
 * ran first, so "gitFs" and "events" are available in the registry.
 *
 * The Buffer polyfill import comes FIRST so its module body (the global
 * assignment) evaluates before isomorphic-git code can run.
 */
import "./polyfill.ts";

import { provide, registerShellCommand } from "../contract/registry.ts";
import { createGitApi } from "./api.ts";
import { createGitCommand } from "./command.ts";

let initialized = false;

export function initGit(): void {
  if (initialized) return;
  initialized = true;
  const api = createGitApi();
  provide("git", api);
  registerShellCommand(createGitCommand(api));
}
