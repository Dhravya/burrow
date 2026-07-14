/**
 * Burrow — bottom "console" pane: a human-readable feed of RunnerEvents
 * (src/ui internal). The terminal is the primary output for plain `bun run`s;
 * this pane tells the story of long-lived server sessions (console output,
 * errors, request activity) and the run lifecycle across the whole app.
 */
import { use, tryUse } from "../contract/registry.ts";
import { PREVIEW_PREFIX } from "../contract/types.ts";
import type { RunnerEvent, RunSession } from "../contract/types.ts";
import type { TabsApi } from "./tabs.ts";
import { basename, h } from "./util.ts";

const LEVEL_CLASS: Record<string, string> = {
  log: "cev-log",
  info: "cev-info",
  warn: "cev-warn",
  error: "cev-error",
  debug: "cev-debug",
};

export function initConsole(scrollEl: HTMLElement, clearBtn: HTMLElement, tabs: TabsApi): void {
  const events = use("events");
  const subscribed = new Set<string>();
  const unsubscribe = new Map<string, () => void>();
  let empty = true;

  showPlaceholder();

  clearBtn.addEventListener("click", () => {
    empty = true;
    showPlaceholder();
  });

  events.on("run:started", (e) => {
    lifecycle("▸", `bun run ${basename(e.entryPath)}`, "start");
  });

  events.on("preview:ready", () => {
    const session = tryUse("toolchain")?.activePreviewSession();
    if (session) attach(session);
    row("cev-ok", "◇", `server ready — ${PREVIEW_PREFIX}/`);
  });

  events.on("run:ended", (e) => {
    const un = unsubscribe.get(e.sessionId);
    if (un) {
      un();
      unsubscribe.delete(e.sessionId);
    }
    subscribed.delete(e.sessionId);
    lifecycle(e.exitCode === 0 ? "✓" : "■", `exit ${e.exitCode}`, e.exitCode === 0 ? "ok" : "bad");
  });

  function attach(session: RunSession): void {
    if (subscribed.has(session.id)) return;
    subscribed.add(session.id);
    // onEvent replays buffered events, so late-attaching still shows history.
    const un = session.onEvent((event) => renderEvent(event));
    unsubscribe.set(session.id, un);
  }

  function renderEvent(event: RunnerEvent): void {
    switch (event.type) {
      case "console":
        tagged(LEVEL_CLASS[event.level] ?? "cev-log", event.level, event.args.join(" "));
        break;
      case "error":
        renderError(event.kind, event.message, event.stack);
        break;
      case "serve-listening":
        row("cev-ok", "◇", "Bun.serve listening");
        break;
      case "exit":
        // Lifecycle exit is handled off the bus (run:ended); ignore here to
        // avoid a duplicate line.
        break;
    }
  }

  function renderError(kind: string, message: string, stack?: string): void {
    const line = beginRow("cev-error");
    line.append(tag(kind === "unhandled-rejection" ? "reject" : kind), h("span", "cev-msg", message));
    if (stack) {
      const pre = h("pre", "cev-stack", stack);
      line.append(pre);
    }
    commit(line);
  }

  /** A console line: a small level tag chip + the message text. */
  function tagged(cls: string, label: string, text: string): void {
    const line = beginRow(cls);
    line.append(tag(label), h("span", "cev-msg", text));
    commit(line);
  }

  function lifecycle(sigil: string, text: string, mood: "start" | "ok" | "bad"): void {
    const cls = mood === "ok" ? "cev-life cev-life-ok" : mood === "bad" ? "cev-life cev-life-bad" : "cev-life";
    row(cls, sigil, text);
  }

  function row(cls: string, sigil: string, text: string): void {
    const line = beginRow(cls);
    line.append(h("span", "cev-sigil", sigil), h("span", "cev-msg", text));
    commit(line);
  }

  function tag(label: string): HTMLElement {
    return h("span", "cev-tag", label);
  }

  function beginRow(cls: string): HTMLElement {
    return h("div", `cev ${cls}`);
  }

  function commit(line: HTMLElement): void {
    if (empty) {
      scrollEl.replaceChildren();
      empty = false;
    }
    const nearBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 32;
    scrollEl.append(line);
    if (nearBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
    if (tabs.active() !== "console") tabs.badge("console", true);
  }

  function showPlaceholder(): void {
    const msg = h("div", "empty", "Nothing has run yet. `bun run <file>` or start a server — the output lands here.");
    scrollEl.replaceChildren(msg);
  }
}
