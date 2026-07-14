/**
 * Burrow — src/ai/agent/loop.ts
 *
 * The pure ReAct driver. It owns NO DOM and NO services: the model's generate()
 * and the executable tools are injected, so the whole loop runs headless in
 * bun:test against a FakeWorker-backed controller + fake vfs/shell.
 *
 * Per step:
 *   1. build messages (system + task + rolling history),
 *   2. generate — streaming into onDelta, and EARLY-CANCEL the instant one
 *      complete action tag has arrived (caps tokens, kills second-block drift),
 *   3. parse the answer into exactly one action,
 *   4. dispatch: final/done → stop · incomplete/error → bounded repair ·
 *      action → (optional approval) → run tool → feed <result> back,
 *   5. loop until done, step cap, repair cap, abort, or no-progress.
 */

import { AI_MODEL_DEFAULT } from "../../contract/types.ts";
import type { AiGenerationHandle, AiModelId, ChatMessage } from "../../contract/types.ts";
import { AGENT_MAX_NEW_TOKENS, AGENT_MAX_STEPS } from "../config.ts";
import {
  compactResult,
  firstCompleteActionEnd,
  formatResult,
  parseAction,
  splitThink,
} from "./protocol.ts";
import type { Action, ToolName, ToolResult } from "./protocol.ts";

export type GenerateFn = (
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  options?: { maxNewTokens?: number },
) => AiGenerationHandle;

export type AgentEvent =
  | { type: "step-start"; index: number }
  /** Streamed <think>…</think> reasoning for this step (full text so far). UI-only. */
  | { type: "thinking"; index: number; text: string }
  /** Prose the model wrote BEFORE its action tag — its narration for the step. */
  | { type: "thought"; index: number; text: string }
  | { type: "action"; index: number; action: Action }
  | { type: "result"; index: number; result: ToolResult }
  | { type: "final"; text: string }
  | { type: "stopped"; reason: string }
  | { type: "await-approval"; index: number; action: Action; approve: (ok: boolean) => void };

export interface RunAgentOptions {
  task: string;
  systemPrompt: string;
  /** Extra system context (repo map, open file). Appended to systemPrompt. */
  repoContext?: string;
  generate: GenerateFn;
  loadedModel: AiModelId | null;
  tools: Record<ToolName, (a: Action) => Promise<ToolResult>>;
  onEvent: (e: AgentEvent) => void;
  onDelta?: (index: number, partialAnswer: string) => void;
  signal: AbortSignal;
  maxSteps?: number;
  /** True → surface an await-approval event and block on the user's choice. */
  needsApproval: (a: Action) => boolean;
  /**
   * True → let the model reason out loud (skips /no_think on Qwen); the
   * reasoning streams to the UI via "thinking" events. Default false: snappy.
   */
  think?: boolean;
}

interface Step {
  assistant: string;
  result: ToolResult;
}

const MAX_REPAIRS = 2;

/** Build the model messages for the next step from the rolling history. */
export function buildAgentMessages(
  systemPrompt: string,
  task: string,
  steps: Step[],
  loadedModel: AiModelId | null,
  repoContext?: string,
  think = false,
): ChatMessage[] {
  const system = repoContext ? `${systemPrompt}\n\n${repoContext}` : systemPrompt;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `TASK: ${task}` },
  ];
  const n = steps.length;
  steps.forEach((step, idx) => {
    messages.push({ role: "assistant", content: step.assistant });
    // Keep the last 3 observations verbatim; older ones collapse to one line.
    const recent = idx >= n - 3;
    messages.push({ role: "user", content: recent ? formatResult(step.result) : compactResult(step.result) });
  });

  // Qwen honours /no_think on the latest user turn — keep the agent snappy
  // unless the user flipped the think toggle on.
  if (loadedModel === AI_MODEL_DEFAULT && !think) {
    const last = messages[messages.length - 1]!;
    if (last.role === "user") last.content += " /no_think";
  }
  return messages;
}

const actionSignature = (a: Action): string =>
  [a.tool, a.path ?? "", a.cmd ?? "", a.query ?? "", a.search ?? ""].join("|");

const prefaceOf = (answer: string, raw: string): string => {
  const i = answer.indexOf(raw);
  return (i > 0 ? answer.slice(0, i) : "").trim();
};

export async function runAgent(opts: RunAgentOptions): Promise<void> {
  const { task, systemPrompt, repoContext, generate, loadedModel, tools, onEvent, onDelta, signal, needsApproval } =
    opts;
  const maxSteps = opts.maxSteps ?? AGENT_MAX_STEPS;

  const steps: Step[] = [];
  let repairs = 0;
  let lastSig: string | null = null;
  let toolRan = false; // becomes true once a real tool has executed

  const bailIfAborted = (): boolean => {
    if (signal.aborted) {
      onEvent({ type: "stopped", reason: "stopped by user" });
      return true;
    }
    return false;
  };

  for (let index = 0; index < maxSteps; index++) {
    if (bailIfAborted()) return;
    onEvent({ type: "step-start", index });

    const messages = buildAgentMessages(systemPrompt, task, steps, loadedModel, repoContext, opts.think ?? false);

    let buffer = "";
    let earlyCancelled = false;
    const handle = generate(
      messages,
      (delta) => {
        buffer += delta;
        const { thinking, answer } = splitThink(buffer);
        if (thinking.trim()) onEvent({ type: "thinking", index, text: thinking.trim() });
        onDelta?.(index, answer);
        if (!earlyCancelled && firstCompleteActionEnd(buffer) !== -1) {
          earlyCancelled = true;
          handle.cancel();
        }
      },
      { maxNewTokens: AGENT_MAX_NEW_TOKENS },
    );

    // Stop must interrupt the WORKER immediately, not wait for the token cap:
    // wire this step's abort to handle.cancel(), removed once the step settles.
    const onAbort = (): void => handle.cancel();
    signal.addEventListener("abort", onAbort);

    let text: string;
    try {
      text = await handle.done;
    } catch (e) {
      if (bailIfAborted()) return;
      onEvent({ type: "stopped", reason: e instanceof Error ? e.message : String(e) });
      return;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (bailIfAborted()) return;

    const { thinking, answer } = splitThink(text);
    // A generation that settled without token deltas still surfaces its reasoning.
    if (thinking.trim()) onEvent({ type: "thinking", index, text: thinking.trim() });
    const outcome = parseAction(answer);

    if (outcome.kind === "final") {
      // A genuine conclusion only comes via <done> (handled below). Tagless prose
      // on kind:"final" means the model NARRATED instead of acting — a frequent
      // small-model failure. Until a tool has actually run, treat it as a
      // repairable no-action rather than silently finishing with nothing done.
      if (!toolRan && repairs < MAX_REPAIRS) {
        repairs++;
        const result: ToolResult = {
          ok: false,
          kind: "read",
          observation:
            "Don't narrate — reply with EXACTLY ONE action tag and nothing else. " +
            'Start by inspecting the project, e.g. <list/> or <read path="src/index.ts"/>.',
        };
        steps.push({ assistant: answer, result });
        onEvent({ type: "result", index, result });
        continue;
      }
      onEvent({ type: "final", text: outcome.text });
      return;
    }

    if (outcome.kind === "incomplete" || outcome.kind === "error") {
      repairs++;
      if (repairs > MAX_REPAIRS) {
        onEvent({ type: "stopped", reason: "the model did not produce a valid action" });
        return;
      }
      const reason = outcome.kind === "error" ? outcome.reason : "the action tag was incomplete";
      const result: ToolResult = {
        ok: false,
        kind: "read",
        observation: `Reply with EXACTLY ONE complete action tag and nothing else. ${reason}. Example: <read path="src/index.ts"/>`,
      };
      steps.push({ assistant: answer, result });
      onEvent({ type: "result", index, result });
      continue;
    }

    // A valid action.
    repairs = 0;
    const action = outcome.action;
    const preface = prefaceOf(answer, action.raw);
    if (preface) onEvent({ type: "thought", index, text: preface });
    onEvent({ type: "action", index, action });

    if (action.tool === "done") {
      onEvent({ type: "final", text: action.summary || "Done." });
      return;
    }

    // No-progress guard: identical action twice in a row.
    const sig = actionSignature(action);
    if (sig === lastSig) {
      const result: ToolResult = {
        ok: false,
        kind: action.tool,
        observation: "You just repeated that exact action. Take a different step, or emit <done> if the task is finished.",
      };
      steps.push({ assistant: answer, result });
      onEvent({ type: "result", index, result });
      lastSig = null;
      continue;
    }
    lastSig = sig;

    // Approval gate (e.g. bash when auto-run is off). Race the user's choice
    // against the abort signal so the Stop button always unblocks the loop — a
    // pending approval must never deadlock the run.
    if (needsApproval(action)) {
      const approved = await new Promise<boolean>((resolve) => {
        const onAbortApproval = (): void => resolve(false);
        signal.addEventListener("abort", onAbortApproval, { once: true });
        onEvent({
          type: "await-approval",
          index,
          action,
          approve: (ok) => {
            signal.removeEventListener("abort", onAbortApproval);
            resolve(ok);
          },
        });
      });
      if (bailIfAborted()) return;
      if (!approved) {
        const result: ToolResult = { ok: false, kind: action.tool, observation: "[user skipped this action]" };
        steps.push({ assistant: answer, result });
        onEvent({ type: "result", index, result });
        continue;
      }
    }

    let result: ToolResult;
    try {
      result = await tools[action.tool](action);
    } catch (e) {
      result = { ok: false, kind: action.tool, observation: `tool error: ${e instanceof Error ? e.message : String(e)}` };
    }
    toolRan = true;
    if (bailIfAborted()) return;
    steps.push({ assistant: answer, result });
    onEvent({ type: "result", index, result });
  }

  onEvent({ type: "stopped", reason: `reached the ${maxSteps}-step limit` });
}
