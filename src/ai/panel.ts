/**
 * Burrow — src/ai/panel.ts
 * The agent side panel (CONTRACT.md §8). Agent-only, Cursor-style: each prompt
 * renders as a rounded card followed by a flat activity stream (thoughts,
 * narration, grouped tool lines, a final summary) — see agent/view.ts. Vanilla
 * DOM, self-contained styling. Talks to the AiController (which owns the model
 * worker), drives the ReAct loop in agent/loop.ts, and reads the shared VFS
 * through the registry for the repo map + active-file context.
 *
 * Follow-ups never reset the thread: runs stack, and a short recap of recent
 * runs rides along in the next task's repo context so the (stateless) loop
 * keeps rough continuity.
 */

import { tryUse } from "../contract/registry.ts";
import { AI_MODEL_DEFAULT, WORKSPACE_ROOT } from "../contract/types.ts";
import type { AiLoadProgress, AiModelId, AiState } from "../contract/types.ts";
import { AGENT_SYSTEM_PROMPT, MODELS, MODEL_ORDER } from "./config.ts";
import type { AiController } from "./controller.ts";
import { createAgentThread } from "./agent/view.ts";
import type { AgentThreadView } from "./agent/view.ts";
import { runAgent } from "./agent/loop.ts";
import type { AgentEvent } from "./agent/loop.ts";
import { createAgentTools } from "./agent/tools.ts";
import { injectAiStyles } from "./styles.ts";

const AGENT_SUGGESTIONS = [
  "explain what this project does",
  "create a Bun HTTP server in src/server.ts",
  "run the tests and fix any failures",
  "refactor the open file",
];

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

const baseName = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;
const relPath = (path: string): string =>
  path.startsWith(WORKSPACE_ROOT + "/") ? path.slice(WORKSPACE_ROOT.length + 1) : path;

export function mountAiPanel(root: HTMLElement, controller: AiController): void {
  injectAiStyles();
  const events = tryUse("events");
  const vfs = tryUse("vfs");

  let selectedModel: AiModelId = AI_MODEL_DEFAULT;
  let activeFilePath: string | null = null;
  let reasoning = false; // default: snappy (/no_think for Qwen)
  let gpuStatus: "checking" | "ok" | "bad" = "checking";
  let autoRun = false; // OFF → shell commands need per-step approval
  let agentAbort: AbortController | null = null;
  let lastError: string | null = null;
  /** Finished runs, recapped into the next task's context for continuity. */
  const pastRuns: Array<{ task: string; summary: string }> = [];

  // ── skeleton ────────────────────────────────────────────
  // Add our class WITHOUT clobbering the UI's `panel` class — the right-bar
  // tab logic hides inactive panels via that class, and #ai-panel already
  // provides the flex column + resting look.
  root.classList.add("ai");
  root.replaceChildren();

  // header: minimal — status dot + a few quiet toggles. The model name lives
  // down in the composer, Cursor-style.
  const dot = h("span", { class: "ai-dot", title: "" });
  const autoBtn = h("button", { class: "ai-mini", type: "button", title: "auto-run shell commands without approval" }, [
    "auto-run: off",
  ]);
  const reasonBtn = h("button", { class: "ai-mini", type: "button", title: "toggle model reasoning" }, ["think: off"]);
  const newBtn = h("button", { class: "ai-mini", type: "button", title: "clear the thread" }, ["new"]);
  const head = h("div", { class: "ai-head" }, [
    dot,
    h("span", { class: "ai-head-title" }, ["agent"]),
    h("span", { class: "ai-spacer" }),
    autoBtn,
    reasonBtn,
    newBtn,
  ]);

  const body = h("div", { class: "ai-body" });
  const introView = h("div", { class: "ai-view-intro" });
  const loadingView = h("div", { class: "ai-view-loading" });
  const threadView = h("div", { class: "ai-view-thread" });
  body.append(introView, loadingView, threadView);

  // composer: rounded input, "+" on the left, model name muted on the right.
  const input = h("textarea", {
    class: "ai-input",
    rows: "1",
    placeholder: "",
    "aria-label": "task",
  });
  const plusBtn = h("button", { class: "ai-plus-btn", type: "button", title: "mention the open file" }, ["+"]);
  const modelMini = h("span", { class: "ai-model-mini" });
  const sendBtn = h("button", { class: "ai-send", type: "button", title: "run", "aria-label": "run" }, ["↑"]);
  const composerRow = h("div", { class: "ai-composer-row" }, [plusBtn, modelMini, sendBtn]);
  const inputWrap = h("div", { class: "ai-input-wrap" }, [input, composerRow]);
  const composer = h("div", { class: "ai-composer" }, [inputWrap]);

  root.append(head, body, composer);

  // ── intro / idle view ───────────────────────────────────
  function renderIntro(): void {
    const info = MODELS[selectedModel];
    const gpuBadge = h(
      "span",
      { class: `ai-gpu ${gpuStatus === "ok" ? "ok" : gpuStatus === "bad" ? "bad" : ""}` },
      [
        h("span", { class: "ai-gpu-glyph" }),
        gpuStatus === "checking"
          ? "checking WebGPU…"
          : gpuStatus === "ok"
            ? "WebGPU ready"
            : "WebGPU unavailable",
      ],
    );

    const picker = h(
      "div",
      { class: "ai-picker" },
      MODEL_ORDER.map((id) => {
        const m = MODELS[id];
        const btn = h(
          "button",
          { class: "ai-pick", type: "button", "aria-pressed": id === selectedModel ? "true" : "false" },
          [
            h("span", { class: "ai-pick-name" }, [m.label]),
            h("span", { class: "ai-pick-size" }, [m.size]),
          ],
        );
        btn.addEventListener("click", () => {
          selectedModel = id;
          updateModelMini();
          renderIntro();
        });
        return btn;
      }),
    );

    const gpuBad = gpuStatus === "bad";
    const loadBtn = h("button", { class: "ai-cta", type: "button" }, [
      gpuBad ? "WebGPU required" : `Load ${info.label} · ${info.size.split(" · ")[0]}`,
    ]);
    if (gpuBad) loadBtn.setAttribute("disabled", "");
    loadBtn.addEventListener("click", () => void startLoad());

    const children: (Node | string)[] = [
      h("h2", {}, ["Local AI, in this tab"]),
      h("p", {}, [
        "An agent that reads, edits, and runs commands in your workspace — entirely ",
        "on your GPU with WebGPU. Nothing leaves the browser; weights download once ",
        "from Hugging Face and cache locally.",
      ]),
      picker,
      h("p", { class: "ai-note" }, [info.blurb]),
      gpuBadge,
      loadBtn,
    ];
    if (info.heavy && !gpuBad) {
      children.push(h("p", { class: "ai-note warn" }, [`Heavy: ${info.size} download and ~4 GB of GPU memory.`]));
    }
    if (lastError) {
      children.push(
        h("div", { class: "ai-error" }, [
          h("div", { class: "ai-err-title" }, ["Couldn't load the model"]),
          h("div", {}, [lastError]),
        ]),
      );
    }
    introView.replaceChildren(...children);
  }

  // ── loading view ────────────────────────────────────────
  const barFill = h("div", { class: "ai-bar-fill" });
  const pctText = h("span", { class: "ai-pct" }, ["0%"]);
  const loadDetail = h("div", { class: "ai-load-detail" }, ["preparing…"]);
  function buildLoadingView(): void {
    loadingView.replaceChildren(
      h("div", { class: "ai-load-title" }, [h("span", {}, [`Loading ${MODELS[selectedModel].label}`]), pctText]),
      h("div", { class: "ai-bar" }, [barFill]),
      loadDetail,
      h("div", { class: "ai-load-sub" }, ["First load streams the weights; later loads are instant from cache."]),
    );
  }
  buildLoadingView();

  function onProgress(p: AiLoadProgress): void {
    const pct = Math.max(0, Math.min(100, Math.round(p.fraction * 100)));
    barFill.style.width = `${pct}%`;
    pctText.textContent = `${pct}%`;
    if (p.detail) {
      loadDetail.textContent = baseName(p.detail);
    } else if (p.loadedBytes != null && p.totalBytes != null && p.totalBytes > 0) {
      loadDetail.textContent = `${fmtBytes(p.loadedBytes)} / ${fmtBytes(p.totalBytes)}`;
    }
  }

  // ── the agent thread ────────────────────────────────────
  const agentWrap = h("div", { class: "ai-agent-thread" });
  const errorBanner = h("div", { class: "ai-error", hidden: "" });
  threadView.append(agentWrap, errorBanner);
  const view: AgentThreadView = createAgentThread(agentWrap, () => scrollToBottom());

  const agentEmpty = h("div", { class: "ai-empty" }, [
    h("div", { class: "ai-empty-glyph" }, ["✦"]),
    h("div", {}, ["describe a task — the agent reads, edits, and runs commands step by step."]),
    h(
      "div",
      { class: "ai-chips" },
      AGENT_SUGGESTIONS.map((s) => {
        const chip = h("button", { class: "ai-chip", type: "button" }, [s]);
        chip.addEventListener("click", () => {
          input.value = s;
          autosize();
          input.focus();
        });
        return chip;
      }),
    ),
  ]);

  // copy-button delegation (final summaries render markdown code blocks)
  body.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (!target.classList.contains("ai-copy")) return;
    const pre = target.closest("pre");
    const code = pre?.querySelector("code");
    if (!code) return;
    void navigator.clipboard?.writeText(code.textContent ?? "").then(() => {
      target.textContent = "copied";
      target.classList.add("done");
      setTimeout(() => {
        target.textContent = "copy";
        target.classList.remove("done");
      }, 1200);
    });
  });

  // ── agent flow ──────────────────────────────────────────
  function buildRepoContext(): string {
    if (!vfs) return "";
    const rel = vfs
      .getAllPaths()
      .filter((p) => p.startsWith(WORKSPACE_ROOT) && !p.includes("/.git/") && !p.includes("/node_modules/"))
      .map((p) => p.slice(WORKSPACE_ROOT.length + 1))
      .filter(Boolean)
      .sort()
      .slice(0, 120);
    let ctx = `PROJECT FILES (working dir ${WORKSPACE_ROOT}, refer to files by these relative paths):\n${rel.join("\n")}`;
    if (activeFilePath) ctx += `\n\nThe user currently has this file open in the editor: ${activeFilePath}`;
    if (pastRuns.length > 0) {
      const recap = pastRuns
        .slice(-3)
        .map((r) => `- "${r.task}" → ${r.summary.replace(/\s+/g, " ").slice(0, 160)}`)
        .join("\n");
      ctx += `\n\nEARLIER IN THIS SESSION (already done — context for follow-ups):\n${recap}`;
    }
    return ctx;
  }

  function handleAgentEvent(e: AgentEvent): void {
    switch (e.type) {
      case "step-start":
        view.startStep(e.index);
        break;
      case "thinking":
        view.streamThinking(e.index, e.text);
        break;
      case "thought":
        view.narrate(e.index, e.text);
        break;
      case "action":
        view.setAction(e.index, e.action);
        break;
      case "result":
        view.setResult(e.index, e.result);
        break;
      case "await-approval":
        view.requestApproval(e.index, e.action, e.approve);
        break;
      case "final":
        view.final(e.text);
        break;
      case "stopped":
        view.stopped(e.reason);
        break;
    }
  }

  async function runFlow(): Promise<void> {
    const task = input.value.trim();
    if (!task || agentAbort) return;
    if (controller.getState() !== "ready") return;
    if (!vfs) {
      showError("the filesystem service isn't available — the agent can't run.");
      return;
    }
    clearError();
    input.value = "";
    autosize();

    const abort = new AbortController();
    agentAbort = abort;
    if (agentWrap.contains(agentEmpty)) agentEmpty.remove();
    view.beginRun(task);
    updateComposer();
    scrollToBottom(true);

    const tools = createAgentTools({
      vfs,
      shell: () => tryUse("shell"),
      events: events ?? undefined,
      cwd: () => tryUse("shell")?.getCwd() ?? WORKSPACE_ROOT,
      signal: abort.signal,
    });

    try {
      await runAgent({
        task,
        systemPrompt: AGENT_SYSTEM_PROMPT,
        repoContext: buildRepoContext(),
        generate: (m, d, o) => controller.generate(m, d, o),
        loadedModel: controller.loadedModel(),
        tools,
        think: reasoning,
        onEvent: (e) => {
          if (e.type === "final") pastRuns.push({ task, summary: e.text });
          handleAgentEvent(e);
        },
        onDelta: (index, partial) => view.streamPartial(index, partial),
        signal: abort.signal,
        needsApproval: (a) => !autoRun && a.tool === "bash",
      });
    } catch (error) {
      view.stopped(error instanceof Error ? error.message : String(error));
    } finally {
      agentAbort = null;
      updateComposer();
      scrollToBottom();
      input.focus();
    }
  }

  function stop(): void {
    agentAbort?.abort();
  }

  function renderEmpty(): void {
    if (!view.hasRuns() && !agentAbort && !agentWrap.contains(agentEmpty)) {
      agentWrap.prepend(agentEmpty);
    }
  }

  // ── model load ──────────────────────────────────────────
  async function startLoad(): Promise<void> {
    lastError = null;
    barFill.style.width = "0%";
    pctText.textContent = "0%";
    loadDetail.textContent = "connecting…";
    buildLoadingView();
    try {
      await controller.load(selectedModel, onProgress);
      updateModelMini();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      renderIntro();
    }
  }

  // ── error surface (in-thread) ───────────────────────────
  function showError(message: string): void {
    errorBanner.replaceChildren(
      h("div", { class: "ai-err-title" }, ["Something broke"]),
      h("div", {}, [message]),
    );
    errorBanner.hidden = false;
  }
  function clearError(): void {
    errorBanner.hidden = true;
  }

  // ── view switching by state ─────────────────────────────
  function showView(state: AiState): void {
    root.setAttribute("data-state", state);
    const loaded = controller.loadedModel() != null;
    const showThread = state === "ready" || state === "generating" || (state === "error" && loaded);
    const showLoading = state === "loading";
    const showIntro = !showThread && !showLoading;

    introView.hidden = !showIntro;
    loadingView.hidden = !showLoading;
    threadView.hidden = !showThread;
    composer.hidden = !showThread;

    if (showIntro) renderIntro();
    if (showThread) {
      renderEmpty();
      updateComposer();
    }
    updateReasonBtn();
  }

  function updateComposer(): void {
    const busy = agentAbort != null || controller.getState() === "generating";
    input.disabled = busy;
    sendBtn.textContent = busy ? "■" : "↑";
    sendBtn.classList.toggle("stop", busy);
    sendBtn.title = busy ? "stop" : "run";
    input.placeholder = view.hasRuns() ? "Send follow-up" : "what should the agent do?";
    updatePlusBtn();
    updateModelMini();
  }

  function updatePlusBtn(): void {
    plusBtn.disabled = activeFilePath == null;
    plusBtn.title = activeFilePath
      ? `mention ${baseName(activeFilePath)} in your prompt`
      : "open a file to mention it";
  }

  function updateModelMini(): void {
    const id = controller.loadedModel() ?? selectedModel;
    modelMini.textContent = MODELS[id]?.label ?? "";
  }

  function updateReasonBtn(): void {
    // Only the default (Qwen) model honours the /no_think switch today.
    const supportsThink = (controller.loadedModel() ?? selectedModel) === AI_MODEL_DEFAULT;
    reasonBtn.hidden = !supportsThink;
    reasonBtn.textContent = `think: ${reasoning ? "on" : "off"}`;
    reasonBtn.setAttribute("aria-pressed", reasoning ? "true" : "false");
  }

  // ── scroll helpers ──────────────────────────────────────
  let pinned = true;
  body.addEventListener("scroll", () => {
    pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  });
  function scrollToBottom(force = false): void {
    if (force) pinned = true;
    if (pinned) body.scrollTop = body.scrollHeight;
  }

  // ── input handlers ──────────────────────────────────────
  function autosize(): void {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      if (agentAbort) return;
      void runFlow();
    }
  });
  sendBtn.addEventListener("click", () => {
    if (agentAbort) stop();
    else void runFlow();
  });
  plusBtn.addEventListener("click", () => {
    if (activeFilePath == null) return;
    const mention = "`" + relPath(activeFilePath) + "`";
    input.value = input.value.trim() ? input.value.replace(/\s*$/, " ") + mention + " " : mention + " ";
    autosize();
    input.focus();
  });
  autoBtn.addEventListener("click", () => {
    autoRun = !autoRun;
    autoBtn.textContent = `auto-run: ${autoRun ? "on" : "off"}`;
    autoBtn.setAttribute("aria-pressed", autoRun ? "true" : "false");
    autoBtn.classList.toggle("on", autoRun);
  });
  reasonBtn.addEventListener("click", () => {
    reasoning = !reasoning;
    updateReasonBtn();
  });
  newBtn.addEventListener("click", () => {
    if (agentAbort) stop();
    pastRuns.length = 0;
    clearError();
    view.reset();
    renderEmpty();
    updateComposer();
    input.focus();
  });

  // ── wiring ──────────────────────────────────────────────
  controller.onStateChange((state) => {
    if (state === "ready") clearError();
    showView(state);
  });

  if (events) {
    events.on("editor:open", (e) => {
      activeFilePath = e.path;
      updatePlusBtn();
    });
  }

  // initial paint + async webgpu probe
  updateComposer();
  showView(controller.getState());
  void controller.webgpuSupported().then((ok) => {
    gpuStatus = ok ? "ok" : "bad";
    if (controller.getState() === "idle" || controller.getState() === "unsupported") renderIntro();
  });
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
