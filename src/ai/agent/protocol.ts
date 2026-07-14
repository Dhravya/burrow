/**
 * Burrow — src/ai/agent/protocol.ts
 *
 * The lenient text protocol the agent loop speaks with the (tiny, local) model.
 * Pure: no DOM, no registry, no I/O — so it unit-tests hard and drives the loop.
 *
 * WHY A TEXT PROTOCOL, NOT NATIVE FUNCTION-CALLING: 0.6–2B on-device models do
 * not reliably emit JSON tool calls. They DO reliably pattern-match short,
 * familiar XML-ish tags, and they mangle JSON string-escaping constantly. So:
 *
 *   - one action per turn, in a distinct tag whose NAME is the tool,
 *   - scalars (path, query) live in tag ATTRIBUTES,
 *   - file content / commands live in the RAW tag BODY, never JSON-escaped,
 *   - edits use the Aider-style conflict fence the models have seen in training.
 *
 * Grammar (see AGENT_SYSTEM_PROMPT for the model-facing spec):
 *
 *   <read path="src/index.ts"/>
 *   <list path="src"/>
 *   <search query="Bun.serve"/>
 *   <write path="src/x.ts">…file body…</write>
 *   <edit path="src/x.ts">
 *   <<<<<<< SEARCH
 *   old text
 *   =======
 *   new text
 *   >>>>>>> REPLACE
 *   </edit>
 *   <bash>bun test</bash>
 *   <done>summary of what changed</done>
 *
 * The parser tolerates: surrounding prose, a wrapping ```xml fence, single or
 * double or bare attribute quotes, a missing self-closing slash, arbitrary
 * whitespace, and (for edit) varying fence-marker lengths. When several tags
 * appear it takes the EARLIEST-OPENING complete one. Reasoning (<think>…</think>)
 * is stripped before parsing — call parseAction on splitThink(text).answer.
 */

export type ToolName = "read" | "list" | "search" | "write" | "edit" | "bash" | "done";

export const TOOL_NAMES: readonly ToolName[] = ["read", "list", "search", "write", "edit", "bash", "done"];

/** A single parsed tool invocation. Only the fields relevant to `tool` are set. */
export interface Action {
  tool: ToolName;
  path?: string;
  body?: string;
  search?: string;
  replace?: string;
  query?: string;
  cmd?: string;
  summary?: string;
  /** The exact source slice this action was parsed from (for de-duping the thought). */
  raw: string;
}

export type ParseOutcome =
  | { kind: "action"; action: Action }
  | { kind: "final"; text: string }
  | { kind: "incomplete" }
  | { kind: "error"; reason: string };

/** The structured result of executing an Action — produced by tools.ts, rendered here. */
export interface ToolResult {
  ok: boolean;
  kind: ToolName;
  /** What gets fed back to the model as the observation body. */
  observation: string;
  path?: string;
  oldText?: string;
  newText?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  matches?: string[];
  summary?: string;
  cmd?: string;
  query?: string;
}

// ── think handling ─────────────────────────────────────────

/** Split Qwen-style output into (optional) reasoning + answer. Mirrors panel.ts. */
export function splitThink(text: string): { thinking: string; answer: string; thinkingOpen: boolean } {
  const open = text.indexOf("<think>");
  if (open === -1) return { thinking: "", answer: text, thinkingOpen: false };
  const before = text.slice(0, open);
  const rest = text.slice(open + "<think>".length);
  const close = rest.indexOf("</think>");
  if (close === -1) return { thinking: rest, answer: before, thinkingOpen: true };
  const thinking = rest.slice(0, close);
  const answer = before + rest.slice(close + "</think>".length);
  return { thinking, answer, thinkingOpen: false };
}

// ── low-level scanning ─────────────────────────────────────

type Located =
  | { status: "none" }
  | { status: "partial" }
  | { status: "complete"; tool: ToolName; openStart: number; endIndex: number; inner: string; body: string };

const OPEN_RE = /<(read|list|search|write|edit|bash|done)\b/i;

/**
 * Locate the earliest-opening tool tag and, if it is syntactically complete,
 * return its bounds + attribute string + raw body. Shared by parseAction and
 * firstCompleteActionEnd so streaming and final parsing agree.
 */
function findAction(text: string): Located {
  const m = OPEN_RE.exec(text);
  if (!m || m[1] === undefined) return { status: "none" };
  const tool = m[1].toLowerCase() as ToolName;
  const openStart = m.index;

  // Find the '>' that closes the opening tag, respecting quoted attributes.
  let i = openStart + m[0].length;
  let quote: string | null = null;
  let tagEnd = -1;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ">") {
      tagEnd = i;
      break;
    }
  }
  if (tagEnd === -1) return { status: "partial" };

  const selfClosed = text[tagEnd - 1] === "/";
  const inner = text.slice(openStart + 1 + tool.length, selfClosed ? tagEnd - 1 : tagEnd);
  const bodyStart = tagEnd + 1;

  const hasQuery = /query\s*=/i.test(inner);
  const attributeOnly = tool === "read" || tool === "list" || (tool === "search" && (selfClosed || hasQuery));
  if (attributeOnly) {
    return { status: "complete", tool, openStart, endIndex: tagEnd + 1, inner, body: "" };
  }

  // Body tools need a matching close tag.
  const closeRe = new RegExp("</\\s*" + tool + "\\s*>", "i");
  const rest = text.slice(bodyStart);
  const cm = closeRe.exec(rest);
  if (!cm) return { status: "partial" };
  const body = rest.slice(0, cm.index);
  const endIndex = bodyStart + cm.index + cm[0].length;
  return { status: "complete", tool, openStart, endIndex, inner, body };
}

/**
 * Streaming early-stop probe: index just past the first COMPLETE action, or -1.
 * Content inside an unclosed <think> is ignored (parsing happens on the answer),
 * so a stray tag the model is only "thinking about" never trips the cancel.
 */
export function firstCompleteActionEnd(buffer: string): number {
  const { answer } = splitThink(buffer);
  const loc = findAction(answer);
  return loc.status === "complete" ? loc.endIndex : -1;
}

// ── attribute + fence helpers ──────────────────────────────

function attr(inner: string, name: string): string | undefined {
  const dq = new RegExp(name + '\\s*=\\s*"([^"]*)"', "i").exec(inner);
  if (dq && dq[1] !== undefined) return dq[1];
  const sq = new RegExp(name + "\\s*=\\s*'([^']*)'", "i").exec(inner);
  if (sq && sq[1] !== undefined) return sq[1];
  // Bare (unquoted) value: allow '/' so a real path keeps every segment
  // (`path=src/ai` → "src/ai", not "src"), and drop a trailing self-closing slash.
  const bare = new RegExp(name + "\\s*=\\s*([^\\s>]+)", "i").exec(inner);
  if (bare && bare[1] !== undefined) return bare[1].replace(/\/+$/, "");
  return undefined;
}

/** Strip a single fence that WRAPS the whole answer (```xml … ```), leaving interior fences alone. */
function stripWrappingFence(answer: string): string {
  let s = answer.trim();
  const open = /^```[a-zA-Z0-9]*[ \t]*\r?\n/;
  if (open.test(s) && /```[ \t]*$/.test(s)) {
    s = s.replace(open, "").replace(/\r?\n?[ \t]*```[ \t]*$/, "");
  }
  return s;
}

/** Trim exactly one leading and one trailing newline (the wrappers after `>` / before `</`). */
function trimEdgeNewlines(body: string): string {
  return body.replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, "");
}

/** Parse the Aider conflict fence out of an <edit> body. Interior whitespace preserved. */
export function parseSearchReplace(body: string): { search: string; replace: string } | null {
  const re =
    /<{3,}[ \t]*SEARCH[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*={3,}[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*>{3,}[ \t]*REPLACE/i;
  const m = re.exec(body);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { search: m[1], replace: m[2] };
}

// ── the parser ─────────────────────────────────────────────

function action(a: Omit<Action, "raw">, raw: string): ParseOutcome {
  return { kind: "action", action: { ...a, raw } };
}

/**
 * Parse the model's answer text into exactly one Action, a final message, or a
 * recoverable incomplete/error signal. Operate on splitThink(text).answer.
 */
export function parseAction(answer: string): ParseOutcome {
  const s = stripWrappingFence(answer);
  const loc = findAction(s);

  if (loc.status === "none") {
    const t = s.trim();
    return t ? { kind: "final", text: t } : { kind: "incomplete" };
  }
  if (loc.status === "partial") return { kind: "incomplete" };

  const { tool, inner, body } = loc;
  const raw = s.slice(loc.openStart, loc.endIndex);

  switch (tool) {
    case "read": {
      const path = attr(inner, "path");
      if (!path) return { kind: "error", reason: "<read> needs a path attribute" };
      return action({ tool, path }, raw);
    }
    case "list": {
      const path = attr(inner, "path");
      return action(path ? { tool, path } : { tool }, raw);
    }
    case "search": {
      const query = attr(inner, "query") ?? body.trim();
      if (!query) return { kind: "error", reason: "<search> needs a query" };
      return action({ tool, query }, raw);
    }
    case "write": {
      const path = attr(inner, "path");
      if (!path) return { kind: "error", reason: "<write> needs a path attribute" };
      return action({ tool, path, body: trimEdgeNewlines(body) }, raw);
    }
    case "edit": {
      const path = attr(inner, "path");
      if (!path) return { kind: "error", reason: "<edit> needs a path attribute" };
      const sr = parseSearchReplace(body);
      if (!sr) {
        return {
          kind: "error",
          reason: "<edit> body must be <<<<<<< SEARCH … ======= … >>>>>>> REPLACE",
        };
      }
      return action({ tool, path, search: sr.search, replace: sr.replace }, raw);
    }
    case "bash": {
      const cmd = trimEdgeNewlines(body).trim();
      if (!cmd) return { kind: "error", reason: "<bash> needs a command" };
      return action({ tool, cmd }, raw);
    }
    case "done": {
      return action({ tool, summary: trimEdgeNewlines(body).trim() }, raw);
    }
  }
}

// ── observation formatting ─────────────────────────────────

/** Keep head and tail, drop the middle of an over-long observation. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n… (${omitted} chars omitted) …\n${text.slice(text.length - tail)}`;
}

/**
 * Neutralize forged protocol framing inside untrusted tool output (file bytes,
 * shell stdout) so a downloaded file or cloned repo cannot spoof a `<result>`
 * boundary and steer the tiny model. Only the control token is defanged — the
 * text stays fully human/model-readable.
 */
export function neutralizeFraming(s: string): string {
  return s.replace(/<\s*(\/?)\s*result\b/gi, "‹$1result");
}

/** Render a full observation the model reads back as a user turn. */
export function formatResult(r: ToolResult): string {
  const body = neutralizeFraming(truncateMiddle(r.observation, 1600));
  return `<result tool="${r.kind}" ok="${r.ok}">\n${body}\n</result>`;
}

/** Compact one-line observation for older steps that have rolled out of the window. */
export function compactResult(r: ToolResult): string {
  const first = r.observation.split("\n", 1)[0] ?? "";
  return `<result tool="${r.kind}" ok="${r.ok}">${neutralizeFraming(truncateMiddle(first, 120))}</result>`;
}
