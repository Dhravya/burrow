/**
 * Burrow — src/ai/styles.ts
 * Panel styling injected once as a <style> tag. Self-contained: every colour
 * reads a UI custom property with a hand-tuned dark fallback, so the panel
 * looks right whether or not src/ui/styles.css has defined the palette yet.
 * All selectors are namespaced under `.ai` to avoid collisions.
 *
 * The agent thread is deliberately quiet (Cursor-style): activity lines are
 * muted gray, narration and final answers are the loudest text, and diffs get
 * the only strong colour (green adds / red dels).
 */

const STYLE_ID = "burrow-ai-styles";

const CSS = `
.ai {
  --ai-fg:      var(--fg0, #ece3d2);
  --ai-fg-dim:  var(--fg1, #b3a892);
  --ai-fg-mute: var(--fg2, #7c7261);
  --ai-bg:      var(--bg0, #14110d);
  --ai-surface: var(--bg2, #1c1813);
  --ai-raised:  var(--bg3, #262019);
  --ai-line:    var(--line, #2c261e);
  --ai-line2:   var(--line2, #3b342a);
  --ai-acc:     var(--acc, #f2a34c);
  --ai-acc-dim: var(--acc-dim, rgba(242, 163, 76, 0.14));
  --ai-acc-hi:  var(--acc-hi, #f7c07a);
  --ai-err:     var(--err, #e5716a);
  --ai-add:     #8fe0a0;
  --ai-del:     #eda49f;
  --ai-mono:    var(--mono, ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace);
  --ai-ui:      var(--font-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif);

  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  color: var(--ai-fg);
  font-family: var(--ai-ui);
  font-size: 13px;
  line-height: 1.5;
  overflow: hidden;
}
/* The right-bar tab logic hides inactive panels via the [hidden] attribute.
   #ai-panel{display:flex} (id specificity) would otherwise win — force it. */
.ai[hidden] { display: none !important; }
/* Views with author display rules (flex) would otherwise override the UA's
   [hidden]{display:none} — panel.ts toggles views via the hidden property. */
.ai-view-intro[hidden], .ai-view-loading[hidden] { display: none; }

/* ── header (minimal: dot + toggles) ────────────────────── */
.ai-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ai-line);
  flex: none;
}
.ai-head-title { font-size: 11.5px; font-weight: 600; letter-spacing: 0.01em; color: var(--ai-fg-dim); }
.ai-head .ai-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--ai-fg-mute);
  box-shadow: 0 0 0 0 transparent;
  transition: background 0.2s, box-shadow 0.2s;
  flex: none;
}
.ai[data-state="ready"] .ai-dot { background: var(--ai-add); }
.ai[data-state="generating"] .ai-dot {
  background: var(--ai-acc);
  box-shadow: 0 0 0 3px var(--ai-acc-dim);
  animation: ai-pulse 1.1s ease-in-out infinite;
}
.ai[data-state="loading"] .ai-dot { background: var(--ai-acc); animation: ai-pulse 1.1s ease-in-out infinite; }
.ai[data-state="error"] .ai-dot { background: var(--ai-err); }
@keyframes ai-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

.ai-spacer { flex: 1; }
.ai-mini {
  appearance: none;
  border: 1px solid var(--ai-line2);
  background: var(--ai-surface);
  color: var(--ai-fg-dim);
  font: inherit;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.ai-mini:hover:not(:disabled) { color: var(--ai-fg); border-color: var(--ai-acc); }
.ai-mini:disabled { opacity: 0.4; cursor: default; }
.ai-mini.on { color: var(--ai-fg); border-color: var(--ai-acc); background: var(--ai-acc-dim); }

/* ── scroll body ────────────────────────────────────────── */
.ai-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--ai-line2) transparent;
}
.ai-body::-webkit-scrollbar { width: 9px; }
.ai-body::-webkit-scrollbar-thumb { background: var(--ai-line2); border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }

/* ── intro / idle ───────────────────────────────────────── */
.ai-view-intro { padding: 16px 14px 20px; display: flex; flex-direction: column; gap: 14px; }
.ai-view-intro h2 { font-size: 14px; font-weight: 650; margin: 0; letter-spacing: -0.01em; }
.ai-view-intro p { margin: 0; color: var(--ai-fg-dim); font-size: 12.5px; }

.ai-picker { display: flex; gap: 6px; }
.ai-pick {
  flex: 1;
  text-align: left;
  appearance: none;
  border: 1px solid var(--ai-line2);
  background: var(--ai-surface);
  color: var(--ai-fg-dim);
  padding: 9px 11px;
  border-radius: 9px;
  cursor: pointer;
  transition: border-color 0.14s, background 0.14s, transform 0.08s;
}
.ai-pick:hover { border-color: var(--ai-acc); }
.ai-pick:active { transform: translateY(0.5px); }
.ai-pick[aria-pressed="true"] {
  border-color: var(--ai-acc);
  background: var(--ai-acc-dim);
  color: var(--ai-fg);
}
.ai-pick .ai-pick-name { display: block; font-weight: 620; font-size: 12.5px; color: var(--ai-fg); }
.ai-pick .ai-pick-size { display: block; font-size: 11px; color: var(--ai-fg-mute); margin-top: 2px; font-family: var(--ai-mono); }

.ai-gpu {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px; padding: 4px 9px; border-radius: 999px;
  border: 1px solid var(--ai-line2); background: var(--ai-surface);
  color: var(--ai-fg-dim); align-self: flex-start;
}
.ai-gpu.ok { color: var(--ai-add); border-color: rgba(127, 216, 143, 0.35); }
.ai-gpu.bad { color: var(--ai-err); border-color: rgba(229, 113, 106, 0.4); }
.ai-gpu .ai-gpu-glyph { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.ai-cta {
  appearance: none; border: none; cursor: pointer;
  background: var(--ai-acc); color: #17120a;
  font: inherit; font-weight: 640; font-size: 13px;
  padding: 10px 14px; border-radius: 9px;
  transition: filter 0.12s, transform 0.08s, opacity 0.12s;
}
.ai-cta:hover:not(:disabled) { filter: brightness(1.06); }
.ai-cta:active:not(:disabled) { transform: translateY(0.5px); }
.ai-cta:disabled { opacity: 0.45; cursor: default; }
.ai-note { font-size: 11.5px; color: var(--ai-fg-mute); }
.ai-note.warn { color: var(--ai-acc-hi); }

/* ── loading ────────────────────────────────────────────── */
.ai-view-loading { padding: 18px 14px; display: flex; flex-direction: column; gap: 10px; }
.ai-view-loading .ai-load-title { font-size: 12.5px; color: var(--ai-fg-dim); display: flex; justify-content: space-between; gap: 8px; }
.ai-view-loading .ai-pct { font-family: var(--ai-mono); color: var(--ai-acc-hi); font-variant-numeric: tabular-nums; }
.ai-bar { height: 7px; border-radius: 999px; background: var(--ai-surface); overflow: hidden; border: 1px solid var(--ai-line); }
.ai-bar-fill {
  height: 100%; width: 0%;
  background: linear-gradient(90deg, var(--ai-acc), var(--ai-acc-hi));
  border-radius: 999px;
  transition: width 0.25s ease-out;
}
.ai-load-detail { font-size: 11px; color: var(--ai-fg-mute); font-family: var(--ai-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ai-load-sub { font-size: 11.5px; color: var(--ai-fg-mute); }

/* ── the run stream ─────────────────────────────────────── */
.ai-agent-thread { padding: 14px 14px 20px; display: flex; flex-direction: column; gap: 22px; }
.ai-run { display: flex; flex-direction: column; gap: 12px; }

/* the user's prompt: a rounded, bordered card at the top of each run */
.ai-prompt-card {
  border: 1px solid var(--ai-line2);
  background: var(--ai-surface);
  border-radius: 10px;
  padding: 9px 12px;
  font-size: 13px;
  color: var(--ai-fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ai-stream { display: flex; flex-direction: column; gap: 9px; }

/* narration — the model's short statements between actions (loudest text) */
.ai-narration { font-size: 13px; color: var(--ai-fg); overflow-wrap: anywhere; }

/* collapsed "Thought ⌄" reasoning */
.ai-thought > summary {
  cursor: pointer; list-style: none; user-select: none;
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; color: var(--ai-fg-mute);
}
.ai-thought > summary::-webkit-details-marker { display: none; }
.ai-thought > summary::after { content: "⌄"; font-size: 10px; opacity: 0.8; transition: transform 0.15s; }
.ai-thought[open] > summary::after { transform: rotate(180deg); }
.ai-thought > summary:hover { color: var(--ai-fg-dim); }
.ai-thought-body {
  margin: 4px 0 2px; padding-left: 10px; border-left: 2px solid var(--ai-line);
  color: var(--ai-fg-mute); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere;
}

/* grouped activity lines — quiet gray, chevron, expandable mono detail */
.ai-act > summary {
  cursor: pointer; list-style: none; user-select: none;
  display: flex; align-items: center; flex-wrap: wrap; gap: 5px;
  font-size: 12px; color: var(--ai-fg-mute);
  overflow-wrap: anywhere;
}
.ai-act > summary::-webkit-details-marker { display: none; }
.ai-act > summary::after { content: "⌄"; font-size: 10px; opacity: 0.7; transition: transform 0.15s; }
.ai-act[open] > summary::after { transform: rotate(180deg); }
.ai-act > summary:hover { color: var(--ai-fg-dim); }
.ai-act.fail > summary { color: var(--ai-del); }
.ai-act-body {
  margin: 6px 0 2px; padding-left: 10px; border-left: 2px solid var(--ai-line);
  display: flex; flex-direction: column; gap: 10px;
}
.ai-act-item.fail .ai-act-item-head { color: var(--ai-del); }
.ai-act-item-head { font-family: var(--ai-mono); font-size: 11px; color: var(--ai-fg-mute); margin-bottom: 3px; overflow-wrap: anywhere; }
.ai-act-pre {
  margin: 0; font-family: var(--ai-mono); font-size: 11.5px; line-height: 1.5;
  color: var(--ai-fg-dim); white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 280px; overflow-y: auto; scrollbar-width: thin;
}

/* the live "working…" line (last in the stream while a step runs) */
.ai-live {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; color: var(--ai-fg-mute);
  overflow: hidden;
}
.ai-live::before {
  content: ""; width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--ai-acc); animation: ai-pulse 1.1s ease-in-out infinite;
}
.ai-live.await::before { background: var(--ai-acc-hi); animation: none; }
.ai-live-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* loop-internal coaching (repairs, skips) */
.ai-nudge { font-size: 11.5px; color: var(--ai-fg-mute); font-style: italic; }

/* inline code chips (file names, commands) */
.ai .ai-code-chip {
  font-family: var(--ai-mono); font-size: 11px;
  background: var(--ai-raised); border: 1px solid var(--ai-line);
  padding: 0.5px 5px; border-radius: 5px; color: var(--ai-fg-dim);
  overflow-wrap: anywhere;
}
.ai-act > summary .ai-code-chip,
.ai-live .ai-code-chip { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* green/red line counts */
.ai-plus { color: var(--ai-add); font-variant-numeric: tabular-nums; }
.ai-minus { color: var(--ai-del); font-variant-numeric: tabular-nums; }

.ai-exit { font-family: var(--ai-mono); font-size: 10px; padding: 1px 6px; border-radius: 5px; }
.ai-exit.ok { color: var(--ai-add); background: rgba(127, 216, 143, 0.12); }
.ai-exit.bad { color: var(--ai-err); background: rgba(229, 113, 106, 0.12); }

/* diff rows inside an edit's detail */
.ai-diff { margin: 0; font-family: var(--ai-mono); font-size: 11.5px; line-height: 1.5; overflow-x: auto; max-height: 340px; overflow-y: auto; scrollbar-width: thin; }
.ai-diff-row { white-space: pre; padding: 0 4px; }
.ai-diff-row.add { background: rgba(127, 216, 143, 0.1); color: #a9e6b6; }
.ai-diff-row.del { background: rgba(229, 113, 106, 0.1); color: var(--ai-del); }
.ai-diff-row.same { color: var(--ai-fg-mute); }

/* inline approval on the live line */
.ai-approval { display: inline-flex; align-items: center; gap: 6px; margin-left: 4px; }
.ai-approve, .ai-skip {
  appearance: none; cursor: pointer; font: inherit; font-size: 11px; font-weight: 620;
  padding: 2px 10px; border-radius: 6px; border: 1px solid var(--ai-line2);
}
.ai-approve { background: var(--ai-acc); color: #17120a; border-color: transparent; }
.ai-approve:hover { filter: brightness(1.07); }
.ai-skip { background: var(--ai-surface); color: var(--ai-fg-dim); }
.ai-skip:hover { color: var(--ai-fg); border-color: var(--ai-err); }

/* final summary + total changes chip */
.ai-final { font-size: 13px; color: var(--ai-fg); overflow-wrap: anywhere; margin-top: 2px; }
.ai-changes {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px; color: var(--ai-fg-dim);
  border: 1px solid var(--ai-line2); background: var(--ai-surface);
  border-radius: 999px; padding: 3px 10px;
}
.ai-stopped {
  padding: 7px 11px; border-radius: 8px; font-size: 11.5px;
  color: var(--ai-fg-mute); border: 1px dashed var(--ai-line2); background: var(--ai-bg);
}

/* ── shared markdown (narration + final summaries) ──────── */
.ai-md p { margin: 0 0 8px; }
.ai-md p:last-child { margin-bottom: 0; }
.ai-md h1, .ai-md h2, .ai-md h3, .ai-md h4 { margin: 10px 0 6px; font-size: 13px; font-weight: 650; }
.ai-md h1:first-child, .ai-md h2:first-child, .ai-md h3:first-child { margin-top: 0; }
.ai-md ul, .ai-md ol { margin: 0 0 8px; padding-left: 20px; }
.ai-md li { margin: 2px 0; }
.ai-md blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 2px solid var(--ai-line2); color: var(--ai-fg-dim); }
.ai-md a { color: var(--ai-acc-hi); text-decoration: underline; text-underline-offset: 2px; }
.ai-md code {
  font-family: var(--ai-mono); font-size: 12px;
  background: var(--ai-raised); border: 1px solid var(--ai-line);
  padding: 0.5px 4px; border-radius: 4px;
}
.ai-md pre.ai-code {
  position: relative;
  margin: 8px 0; padding: 9px 11px;
  background: var(--ai-bg); border: 1px solid var(--ai-line);
  border-radius: 8px; overflow-x: auto;
  scrollbar-width: thin;
}
.ai-md pre.ai-code code { background: none; border: none; padding: 0; font-size: 12px; line-height: 1.5; }
.ai-md pre.ai-code::-webkit-scrollbar { height: 8px; }
.ai-md pre.ai-code::-webkit-scrollbar-thumb { background: var(--ai-line2); border-radius: 6px; }
.ai-copy {
  position: absolute; top: 6px; right: 6px;
  appearance: none; border: 1px solid var(--ai-line2); background: var(--ai-surface);
  color: var(--ai-fg-mute); font: inherit; font-size: 10px; padding: 2px 7px;
  border-radius: 5px; cursor: pointer; opacity: 0; transition: opacity 0.12s, color 0.12s;
}
.ai-md pre.ai-code:hover .ai-copy { opacity: 1; }
.ai-copy:hover { color: var(--ai-fg); border-color: var(--ai-acc); }
.ai-copy.done { color: var(--ai-add); }

/* ── error + empty state ────────────────────────────────── */
.ai-error {
  margin: 12px; padding: 10px 12px;
  border: 1px solid rgba(229, 113, 106, 0.4); background: rgba(229, 113, 106, 0.08);
  border-radius: 9px; color: var(--ai-fg); font-size: 12.5px;
}
.ai-error .ai-err-title { color: var(--ai-err); font-weight: 640; margin-bottom: 3px; }

.ai-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; color: var(--ai-fg-mute); text-align: center; padding: 28px 16px; font-size: 12.5px;
}
.ai-empty .ai-empty-glyph { font-size: 24px; opacity: 0.7; }
.ai-chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 4px; }
.ai-chip {
  appearance: none; cursor: pointer; font: inherit; font-size: 11.5px;
  border: 1px solid var(--ai-line2); background: var(--ai-surface); color: var(--ai-fg-dim);
  padding: 5px 10px; border-radius: 999px; transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.ai-chip:hover { color: var(--ai-fg); border-color: var(--ai-acc); background: var(--ai-acc-dim); }

/* ── composer (rounded, "+" left, model name right) ─────── */
.ai-composer { flex: none; border-top: 1px solid var(--ai-line); padding: 10px; }
.ai-input-wrap {
  display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--ai-line2); background: var(--ai-surface);
  border-radius: 12px; padding: 8px 8px 6px 11px;
  transition: border-color 0.14s;
}
.ai-input-wrap:focus-within { border-color: var(--ai-acc); }
.ai-input {
  width: 100%; resize: none; border: none; background: none; outline: none;
  color: var(--ai-fg); font-family: var(--ai-ui); font-size: 13px; line-height: 1.45;
  max-height: 140px; min-height: 20px; padding: 2px 0;
}
.ai-input::placeholder { color: var(--ai-fg-mute); }
.ai-input:disabled { opacity: 0.6; }
.ai-composer-row { display: flex; align-items: center; gap: 8px; }
.ai-plus-btn {
  appearance: none; cursor: pointer; flex: none;
  width: 24px; height: 24px; border-radius: 7px;
  border: 1px solid var(--ai-line2); background: none; color: var(--ai-fg-mute);
  font-size: 15px; line-height: 1; display: grid; place-items: center;
  transition: color 0.12s, border-color 0.12s;
}
.ai-plus-btn:hover:not(:disabled) { color: var(--ai-fg); border-color: var(--ai-acc); }
.ai-plus-btn:disabled { opacity: 0.4; cursor: default; }
.ai-model-mini {
  margin-left: auto; font-size: 11px; color: var(--ai-fg-mute);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ai-send {
  flex: none; appearance: none; cursor: pointer; border: none;
  width: 26px; height: 26px; border-radius: 8px;
  background: var(--ai-acc); color: #17120a;
  display: grid; place-items: center; font-size: 14px;
  transition: filter 0.12s, transform 0.08s, opacity 0.12s;
}
.ai-send:hover:not(:disabled) { filter: brightness(1.07); }
.ai-send:active:not(:disabled) { transform: translateY(0.5px); }
.ai-send:disabled { opacity: 0.4; cursor: default; }
.ai-send.stop { background: var(--ai-err); color: #1a0f0e; }
`;

export function injectAiStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
