/**
 * Burrow — src/ai/config.ts
 * Static configuration for the AI side panel: which transformers.js build the
 * worker imports, and the user-facing metadata for each selectable model.
 */

import { AI_MODEL_DEFAULT, AI_MODEL_LARGE } from "../contract/types.ts";
import type { AiModelId } from "../contract/types.ts";

/**
 * Pinned to the version installed in node_modules so the worker matches types.
 * Only the Qwen path runs on transformers.js — the Gemma path runs on the
 * vendored WebGPU-kernel bundle (src/ai/vendor/gemma-4-e2b.js) instead.
 */
export const TRANSFORMERS_VERSION = "4.2.0";

/**
 * Same-origin URL of the bundled AI worker. worker-entry.ts is bundled server
 * side (src/ai/build-worker.ts) with transformers.js + onnxruntime inlined, and
 * served here by server.ts (dev) / emitted into the outdir by build.ts (static).
 * Loading it from a real URL — not a Blob — is what lets the browser resolve the
 * bundle's internal module graph; a raw CDN dist has unresolved bare imports.
 */
export const AI_WORKER_URL = "/ai-worker.js";

export interface ModelInfo {
  id: AiModelId;
  /** Short label for the segmented picker. */
  label: string;
  /** Sub-label under the picker (size, precision). */
  size: string;
  /** Approximate download in bytes — drives the pre-load weight-size notice. */
  approxBytes: number;
  /** One-line pitch shown on the intro card. */
  blurb: string;
  /** Large models are gated behind a confirmed click + WebGPU. */
  heavy: boolean;
}

export const MODELS: Record<AiModelId, ModelInfo> = {
  [AI_MODEL_DEFAULT]: {
    id: AI_MODEL_DEFAULT,
    label: "Qwen3 0.6B",
    size: "~570 MB · q4f16",
    approxBytes: 570 * 1024 * 1024,
    blurb: "Fast, compact chat model. Great default for quick coding questions.",
    heavy: false,
  },
  [AI_MODEL_LARGE]: {
    id: AI_MODEL_LARGE,
    label: "Gemma 4 E2B",
    size: "~2.5 GB · QAT + custom WGSL kernels",
    approxBytes: 2_460_000_000,
    blurb:
      "Google's E2B model on hand-tuned WebGPU kernels — ~250 tok/s on an M4 Max. " +
      "Heavy download, needs 4 GB+ of GPU memory.",
    heavy: true,
  },
};

export const MODEL_ORDER: readonly AiModelId[] = [AI_MODEL_DEFAULT, AI_MODEL_LARGE];

/** Kept deliberately short — the default model is only 0.6B parameters. */
export const SYSTEM_PROMPT =
  "You are the coding assistant inside Burrow, a browser dev environment where " +
  "Bun, a shell, git and this model all run locally in one tab. Be concise and " +
  "practical. Use fenced code blocks for code. When the user shares a file, ground " +
  "your answer in it.";

/** Cap injected file context so we never blow the small model's window. */
export const MAX_CONTEXT_CHARS = 6000;
export const DEFAULT_MAX_NEW_TOKENS = 1024;

// ── agentic harness (src/ai/agent) ─────────────────────────

/** Hard cap on ReAct steps per task — a runaway guard for tiny models. */
export const AGENT_MAX_STEPS = 12;

/**
 * Per-step generation budget. The loop early-cancels the moment one complete
 * action tag has streamed, so this is only a backstop; it must be roomy enough
 * for a small <write> body to finish before the cap bites.
 */
export const AGENT_MAX_NEW_TOKENS = 896;

/**
 * The agentic system prompt: a compact grammar spec + two worked cycles. Kept
 * deliberately short and example-heavy — tiny models copy shapes they can see.
 */
export const AGENT_SYSTEM_PROMPT = `You are Burrow Agent, an autonomous coding agent working INSIDE a browser dev environment where Bun, a shell, and git all run locally. You complete the user's TASK by taking ONE action at a time and reading the result before the next one.

RULES
- Reply with EXACTLY ONE action tag per turn. No prose outside the tag.
- After each action you receive a <result …> message. Read it, then take the next action.
- When the task is fully done, emit <done> with a short summary. Do not stop early.
- Prefer reading before editing. Keep edits small and exact.

ACTIONS
<read path="src/index.ts"/>            — show a file with line numbers
<list path="src"/>                     — list files under a path (omit path for the whole project)
<search query="Bun.serve"/>            — find a string across the project
<write path="src/x.ts">                — create or fully overwrite a file (raw body, no escaping)
FULL FILE CONTENT HERE
</write>
<edit path="src/x.ts">                 — replace an exact snippet
<<<<<<< SEARCH
exact old text
=======
new text
>>>>>>> REPLACE
</edit>
<bash>bun test</bash>                  — run a shell command
<done>what you changed and why</done>  — finish

EXAMPLE — TASK: change the dev port to 4808
<read path="src/server.ts"/>
<result tool="read" ok="true">
src/server.ts (3 lines):
1	const port = 3000
2	Bun.serve({ port, fetch: () => new Response("hi") })
</result>
<edit path="src/server.ts">
<<<<<<< SEARCH
const port = 3000
=======
const port = 4808
>>>>>>> REPLACE
</edit>
<result tool="edit" ok="true">updated src/server.ts (+1 −1)</result>
<done>Set the dev port to 4808 in src/server.ts.</done>

EXAMPLE — TASK: add a greet helper
<write path="src/greet.ts">
export const greet = (name: string) => \`hi \${name}\`
</write>
<result tool="write" ok="true">created src/greet.ts (1 lines)</result>
<done>Added src/greet.ts exporting greet().</done>`;

