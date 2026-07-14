/**
 * Burrow — src/ai/agent/view.ts
 *
 * Cursor-style activity stream for agent runs. Each run renders as a flat
 * document, not a chat — no bubbles, no avatars:
 *
 *   [ the user's prompt, in a rounded bordered card ]
 *   Thought ⌄                        ← collapsed reasoning, muted (think toggle)
 *   I'll read the server file first. ← the model's narration, normal text
 *   Explored 2 files, ran 1 search ⌄ ← grouped quiet tool lines, expandable
 *   Ran `bun test` exit 0 ⌄
 *   Edited `server.ts` +4 −1 ⌄       ← green adds / red dels, diff inside
 *   …final summary (markdown)…
 *   [ Changes +24 −87 ]              ← total chip for the run
 *
 * Follow-up runs stack BELOW previous ones — the thread is never reset between
 * prompts. Consecutive read/list/search results collapse into one "Explored…"
 * line; consecutive write/edit results collapse into one "Edited…" line; any
 * narration, thought, or bash line breaks the grouping. Vanilla DOM (the
 * panel's `h` helper, duplicated here to stay self-contained).
 */

import { WORKSPACE_ROOT } from "../../contract/types.ts";
import { renderMarkdown } from "../markdown.ts";
import { countDiff, diffLines } from "./diff.ts";
import type { Action, ToolResult } from "./protocol.ts";

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> & { class?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
};

const baseName = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;
const rel = (p: string): string =>
  p.startsWith(WORKSPACE_ROOT + "/") ? p.slice(WORKSPACE_ROOT.length + 1) : p;

export interface AgentThreadView {
  /** Wipe every run (the "new" button). */
  reset(): void;
  /** Start a new run: appends the prompt card + a fresh activity stream. */
  beginRun(task: string): void;
  /** True once any run has been started (drives the follow-up placeholder). */
  hasRuns(): boolean;
  startStep(index: number): void;
  /** Streamed <think> reasoning → the collapsed "Thought ⌄" line. */
  streamThinking(index: number, text: string): void;
  /** Streamed answer-so-far → live tail on the pending line (pre-action). */
  streamPartial(index: number, text: string): void;
  /** The model's prose before its action tag → a narration paragraph. */
  narrate(index: number, text: string): void;
  setAction(index: number, action: Action): void;
  setResult(index: number, result: ToolResult): void;
  requestApproval(index: number, action: Action, cb: (ok: boolean) => void): void;
  final(text: string): void;
  stopped(reason: string): void;
}

interface Pending {
  line: HTMLElement;
  text: HTMLElement;
  /** Body of this step's "Thought ⌄" details, once reasoning has streamed. */
  thought: HTMLElement | null;
}

interface ExploreGroup {
  summary: HTMLElement;
  body: HTMLElement;
  reads: number;
  lists: number;
  searches: number;
}

interface EditGroup {
  summary: HTMLElement;
  body: HTMLElement;
  files: Map<string, { adds: number; dels: number; created: boolean }>;
}

interface Run {
  stream: HTMLElement;
  pending: Map<number, Pending>;
  live: Pending | null;
  explore: ExploreGroup | null;
  edits: EditGroup | null;
  adds: number;
  dels: number;
}

export function createAgentThread(container: HTMLElement, onScroll?: () => void): AgentThreadView {
  let run: Run | null = null;
  let runCount = 0;

  const bump = (): void => onScroll?.();

  const chip = (text: string): HTMLElement => h("code", { class: "ai-code-chip" }, [text]);

  /** Green +N / red −N spans (Cursor-style). Shows the sides that are nonzero. */
  const plusMinus = (adds: number, dels: number): HTMLElement[] => {
    const out: HTMLElement[] = [];
    if (adds > 0 || dels === 0) out.push(h("span", { class: "ai-plus" }, [`+${adds}`]));
    if (dels > 0) out.push(h("span", { class: "ai-minus" }, [`−${dels}`]));
    return out;
  };

  const mono = (text: string): HTMLElement => {
    const pre = h("pre", { class: "ai-act-pre" });
    pre.textContent = text;
    return pre;
  };

  const diffEl = (oldText: string, newText: string): HTMLElement => {
    const pre = h("pre", { class: "ai-diff" });
    for (const row of diffLines(oldText, newText)) {
      const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
      pre.append(h("div", { class: `ai-diff-row ${row.type}` }, [`${sign} ${row.text}`]));
    }
    return pre;
  };

  /** A collapsed activity line: quiet summary, chevron, expandable detail. */
  const actLine = (summaryKids: (Node | string)[], detail: HTMLElement, cls = ""): HTMLDetailsElement => {
    const summary = h("summary", {}, summaryKids);
    const body = h("div", { class: "ai-act-body" }, [detail]);
    return h("details", { class: `ai-act${cls ? " " + cls : ""}` }, [summary, body]) as HTMLDetailsElement;
  };

  /** Anything appended that isn't explore/edit content ends those groups. */
  const breakGroups = (): void => {
    if (!run) return;
    run.explore = null;
    run.edits = null;
  };

  /** Insert before the live pending line so "working…" always sits last. */
  const insert = (el: HTMLElement): void => {
    if (!run) return;
    run.stream.insertBefore(el, run.live?.line ?? null);
    bump();
  };

  const beginRun = (task: string): void => {
    runCount++;
    const stream = h("div", { class: "ai-stream" });
    const card = h("div", { class: "ai-prompt-card" }, [task]);
    container.append(h("div", { class: "ai-run" }, [card, stream]));
    run = { stream, pending: new Map(), live: null, explore: null, edits: null, adds: 0, dels: 0 };
    bump();
  };

  const ensurePending = (index: number): Pending => {
    if (!run) beginRun("");
    const r = run!;
    const existing = r.pending.get(index);
    if (existing) return existing;
    const text = h("span", { class: "ai-live-text" }, ["Thinking"]);
    const line = h("div", { class: "ai-live" }, [text]);
    const p: Pending = { line, text, thought: null };
    r.pending.set(index, p);
    r.live = p;
    r.stream.append(line);
    bump();
    return p;
  };

  /** Drop any still-spinning pending line — called on final/stopped. */
  const resolvePending = (): void => {
    if (!run) return;
    for (const p of run.pending.values()) p.line.remove();
    run.pending.clear();
    run.live = null;
  };

  const actionLabel = (a: Action): (Node | string)[] => {
    switch (a.tool) {
      case "read":
        return ["Reading ", chip(baseName(a.path ?? ""))];
      case "list":
        return ["Listing ", chip(a.path ?? "project")];
      case "search":
        return ["Searching ", chip(a.query ?? "")];
      case "write":
        return ["Writing ", chip(baseName(a.path ?? ""))];
      case "edit":
        return ["Editing ", chip(baseName(a.path ?? ""))];
      case "bash":
        return ["Running ", chip(a.cmd ?? "")];
      case "done":
        return ["Wrapping up"];
    }
  };

  const exploreSummary = (g: ExploreGroup): string => {
    const parts: string[] = [];
    if (g.reads) parts.push(`${g.reads} file${g.reads === 1 ? "" : "s"}`);
    if (g.searches) parts.push(`ran ${g.searches} search${g.searches === 1 ? "" : "es"}`);
    if (g.lists) parts.push(`${g.lists} listing${g.lists === 1 ? "" : "s"}`);
    return `Explored ${parts.join(", ")}`;
  };

  const addExploreItem = (result: ToolResult): void => {
    const r = run!;
    r.edits = null;
    let g = r.explore;
    if (!g) {
      const summary = h("summary", {});
      const body = h("div", { class: "ai-act-body" });
      g = { summary, body, reads: 0, lists: 0, searches: 0 };
      r.explore = g;
      insert(h("details", { class: "ai-act" }, [summary, body]));
    }
    if (result.kind === "read") g.reads++;
    else if (result.kind === "list") g.lists++;
    else g.searches++;
    g.summary.textContent = exploreSummary(g);
    const head =
      result.kind === "search"
        ? `search "${result.query ?? ""}"`
        : `${result.kind} ${result.path ? rel(result.path) : ""}`.trim();
    g.body.append(
      h("div", { class: `ai-act-item${result.ok ? "" : " fail"}` }, [
        h("div", { class: "ai-act-item-head" }, [head]),
        mono(result.observation),
      ]),
    );
    bump();
  };

  const addEditItem = (result: ToolResult): void => {
    const r = run!;
    r.explore = null;
    const { adds, dels } = countDiff(result.oldText ?? "", result.newText ?? "");
    r.adds += adds;
    r.dels += dels;
    let g = r.edits;
    if (!g) {
      const summary = h("summary", {});
      const body = h("div", { class: "ai-act-body" });
      g = { summary, body, files: new Map() };
      r.edits = g;
      insert(h("details", { class: "ai-act" }, [summary, body]));
    }
    const key = result.path ?? "";
    const prev = g.files.get(key);
    const created = prev?.created ?? (result.kind === "write" && (result.oldText ?? "") === "");
    g.files.set(key, { adds: (prev?.adds ?? 0) + adds, dels: (prev?.dels ?? 0) + dels, created });
    let totA = 0;
    let totD = 0;
    for (const f of g.files.values()) {
      totA += f.adds;
      totD += f.dels;
    }
    if (g.files.size === 1) {
      const [path, info] = [...g.files.entries()][0]!;
      g.summary.replaceChildren(info.created ? "Created " : "Edited ", chip(baseName(path)), " ", ...plusMinus(totA, totD));
    } else {
      g.summary.replaceChildren(`Edited ${g.files.size} files `, ...plusMinus(totA, totD));
    }
    g.body.append(
      h("div", { class: "ai-act-item" }, [
        h("div", { class: "ai-act-item-head" }, [rel(key)]),
        diffEl(result.oldText ?? "", result.newText ?? ""),
      ]),
    );
    bump();
  };

  return {
    reset(): void {
      container.replaceChildren();
      run = null;
      runCount = 0;
    },

    beginRun,

    hasRuns(): boolean {
      return runCount > 0;
    },

    startStep(index: number): void {
      ensurePending(index);
    },

    streamThinking(index: number, text: string): void {
      const p = ensurePending(index);
      if (!p.thought) {
        breakGroups();
        const body = h("div", { class: "ai-thought-body" });
        insert(h("details", { class: "ai-thought" }, [h("summary", {}, ["Thought"]), body]));
        p.thought = body;
      }
      p.thought.textContent = text;
      bump();
    },

    streamPartial(index: number, text: string): void {
      const p = ensurePending(index);
      // Never show a half-typed action tag — cut at the first '<'.
      const cut = text.indexOf("<");
      const visible = (cut === -1 ? text : text.slice(0, cut)).replace(/\s+/g, " ").trim();
      if (!visible) return;
      p.text.textContent = visible.length > 110 ? "…" + visible.slice(-110) : visible;
      bump();
    },

    narrate(index: number, text: string): void {
      ensurePending(index);
      breakGroups();
      const el = h("div", { class: "ai-narration ai-md" });
      el.innerHTML = renderMarkdown(text);
      insert(el);
      bump();
    },

    setAction(index: number, action: Action): void {
      const p = ensurePending(index);
      p.text.replaceChildren(...actionLabel(action));
      p.line.setAttribute("data-tool", action.tool);
      bump();
    },

    setResult(index: number, result: ToolResult): void {
      if (!run) return;
      const p = run.pending.get(index);
      if (p) {
        p.line.remove();
        if (run.live === p) run.live = null;
      }

      // Loop-internal coaching (repairs, repeats, skips) has no real target —
      // render a single quiet line instead of pretending a tool ran.
      const identified = result.path || result.cmd || result.query;
      if (!result.ok && !identified) {
        breakGroups();
        const skipped = result.observation.startsWith("[user skipped");
        insert(h("div", { class: "ai-nudge" }, [skipped ? "skipped" : "nudged the model to take a real step"]));
        return;
      }

      if (result.kind === "read" || result.kind === "list" || result.kind === "search") {
        addExploreItem(result);
        return;
      }

      if (result.kind === "bash") {
        breakGroups();
        const badge = h("span", { class: `ai-exit ${result.exitCode === 0 ? "ok" : "bad"}` }, [
          `exit ${result.exitCode ?? "?"}`,
        ]);
        const out = [result.stdout, result.stderr].filter((t) => t && t.trim()).join("\n");
        insert(actLine(["Ran ", chip(result.cmd ?? "command"), " ", badge], mono(out || result.observation || "(no output)")));
        return;
      }

      if (result.kind === "write" || result.kind === "edit") {
        if (!result.ok || result.newText === undefined) {
          breakGroups();
          const kids: (Node | string)[] = [result.kind === "write" ? "Write failed" : "Edit failed"];
          if (result.path) kids.push(" ", chip(rel(result.path)));
          insert(actLine(kids, mono(result.observation), "fail"));
          return;
        }
        addEditItem(result);
        return;
      }

      // done never executes as a tool; anything else falls back to a quiet line.
      breakGroups();
      insert(actLine([firstLine(result.observation)], mono(result.observation)));
    },

    requestApproval(index: number, action: Action, cb: (ok: boolean) => void): void {
      const p = ensurePending(index);
      p.line.classList.add("await");
      const approve = h("button", { class: "ai-approve", type: "button" }, ["run"]);
      const skip = h("button", { class: "ai-skip", type: "button" }, ["skip"]);
      const row = h("span", { class: "ai-approval" }, [approve, skip]);
      p.text.replaceChildren("Run ", chip(action.cmd ?? ""), "?");
      p.line.append(row);
      const settle = (ok: boolean): void => {
        row.remove();
        p.line.classList.remove("await");
        p.text.replaceChildren(...actionLabel(action));
        cb(ok);
      };
      approve.addEventListener("click", () => settle(true));
      skip.addEventListener("click", () => settle(false));
      bump();
    },

    final(text: string): void {
      if (!run) return;
      resolvePending();
      breakGroups();
      const md = h("div", { class: "ai-final ai-md" });
      md.innerHTML = renderMarkdown(text);
      run.stream.append(md);
      if (run.adds || run.dels) {
        run.stream.append(h("div", { class: "ai-changes" }, ["Changes ", ...plusMinus(run.adds, run.dels)]));
      }
      bump();
    },

    stopped(reason: string): void {
      if (!run) return;
      resolvePending();
      breakGroups();
      run.stream.append(h("div", { class: "ai-stopped" }, [reason]));
      bump();
    },
  };
}

function firstLine(text: string): string {
  const l = (text.split("\n", 1)[0] ?? "").trim();
  return l.length > 80 ? l.slice(0, 80) + "…" : l || "result";
}
