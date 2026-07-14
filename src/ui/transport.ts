/**
 * Burrow — header run transport: the ▸ run / ■ stop buttons + the runner LED
 * (src/ui internal). Run routes through the SAME shell the terminal uses
 * (`shell.exec("bun run …", { echo:true })`) so the terminal and console tell
 * one story; stop aborts that command and terminates every run worker.
 */
import { tryUse } from "../contract/registry.ts";
import { getActivePath, onEditorChange } from "./editor.ts";
import { onRunState } from "./run-state.ts";

export interface TransportEls {
  led: HTMLElement;
  run: HTMLButtonElement;
  stop: HTMLButtonElement;
}

export function initTransport(els: TransportEls): void {
  let current: AbortController | null = null;

  onEditorChange((s) => {
    els.run.disabled = !s.activePath || tryUse("shell") === undefined;
  });

  onRunState((s) => {
    els.stop.disabled = s.running === 0;
    els.led.className = s.previewLive ? "led live" : s.running > 0 ? "led busy" : "led";
    els.led.title = s.running === 0 ? "runner idle" : s.previewLive ? "server live" : "running";
  });

  function run(): void {
    const shell = tryUse("shell");
    const path = getActivePath();
    if (!shell || !path) return;
    current?.abort();
    const ac = new AbortController();
    current = ac;
    shell.focus();
    // Single-quote the path so filenames with spaces (or other shell-special
    // characters) survive word splitting; embedded quotes become '\''.
    const quoted = `'${path.replaceAll("'", "'\\''")}'`;
    void shell
      .exec(`bun run ${quoted}`, { echo: true, signal: ac.signal })
      .catch((err) => console.error("[burrow/ui] run failed", err))
      .finally(() => {
        if (current === ac) current = null;
      });
  }

  function stop(): void {
    current?.abort();
    current = null;
    tryUse("toolchain")?.stopAll();
  }

  els.run.addEventListener("click", run);
  els.stop.addEventListener("click", stop);

  // Cmd/Ctrl+Enter runs the active file from anywhere.
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!els.run.disabled) run();
    }
  });
}
