/**
 * Burrow — src/git/polyfill.ts
 *
 * isomorphic-git references the bare `Buffer` global ~76 times and Bun's
 * browser bundling does NOT rewrite it (verified: ReferenceError inside
 * git.add — tree-shaking hides the failure in trivial smoke tests). This
 * module MUST be imported before any isomorphic-git import so the global
 * exists by the time git code runs (isomorphic-git has no module-eval-time
 * Buffer usage, but eval order is kept safe anyway: src/git/index.ts imports
 * this file first).
 */
import { Buffer } from "buffer";

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
