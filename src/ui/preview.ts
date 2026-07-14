/**
 * Burrow — preview pane wiring (src/ui internal). The iframe points at
 * PREVIEW_PREFIX/<port>/, which the service worker intercepts and routes to
 * the run session bound to that port. The pane has two states driven by the
 * live server set: with zero servers the iframe is hidden (and blanked) and
 * the `.preview-empty` placeholder in index.html explains how to start one —
 * users never see the 503/502 placeholder by accident; with one or more
 * servers the iframe shows the selected port.
 *
 * PORT SWITCHER: multiple concurrent `bun run`/`serve` sessions each expose
 * their own port (CONTRACT.md §6.3/§6.4). We build a `<select class=
 * "port-switcher__select">` inside a `<span class="port-switcher">` and splice
 * it into the preview panel's existing `.pane-toolbar` (found relative to the
 * `els` passed in), so the toolbar becomes: [port switcher] [.url text]
 * [reload] [open-in-new-tab]. It's populated from toolchain.previewServers()
 * and kept live via the "preview:servers" event; picking a new port updates
 * the iframe, the `.url` text, and the `#preview-open` link together.
 * Newly-appeared servers are auto-selected (the "it runs!" moment should show
 * the thing that just started); the switcher is visible whenever at least one
 * server is live — so you can always see which port you're on — and hides at
 * zero (the placeholder explains that state). When the last server goes away
 * we return to the placeholder and clear the tab badge.
 */
import { use } from "../contract/registry.ts";
import { PREVIEW_PREFIX } from "../contract/types.ts";
import type { PreviewServer } from "../contract/types.ts";
import type { TabsApi } from "./tabs.ts";

export interface PreviewEls {
  frame: HTMLIFrameElement;
  reload: HTMLElement;
  tabs: TabsApi;
}

function previewPath(port: number | undefined): string {
  return port === undefined ? `${PREVIEW_PREFIX}/` : `${PREVIEW_PREFIX}/${port}/`;
}

export function initPreview(els: PreviewEls): void {
  const events = use("events");
  const toolchain = use("toolchain");
  let live = false;
  let selectedPort: number | undefined;
  let knownPorts = new Set<number>();

  // The switcher lives in the SAME .pane-toolbar as the reload button, and the
  // empty-state placeholder shares the panel with the iframe — both found
  // relative to els, per this module's file ownership.
  const toolbar = els.reload.closest(".pane-toolbar") as HTMLElement | null;
  const urlEl = toolbar?.querySelector<HTMLElement>(".url") ?? null;
  const openLink = toolbar?.querySelector<HTMLAnchorElement>("#preview-open") ?? null;
  const placeholder = els.frame.closest(".panel")?.querySelector<HTMLElement>(".preview-empty") ?? null;

  let switcherWrap: HTMLSpanElement | null = null;
  let select: HTMLSelectElement | null = null;
  if (toolbar) {
    switcherWrap = document.createElement("span");
    switcherWrap.className = "port-switcher";
    switcherWrap.hidden = true;
    select = document.createElement("select");
    select.className = "port-switcher__select";
    select.title = "live preview ports";
    select.addEventListener("change", () => {
      selectedPort = select!.value === "" ? undefined : Number(select!.value);
      applySelection();
    });
    switcherWrap.appendChild(select);
    toolbar.insertBefore(switcherWrap, toolbar.firstChild);
  }

  function setFrameSrc(path: string): void {
    // Don't touch src when it already matches — a same-value assignment
    // reloads the iframe, and refreshServers runs on every servers event.
    const abs = new URL(path, location.href).href;
    if (els.frame.src !== abs) els.frame.src = abs;
  }

  function applySelection(): void {
    const path = previewPath(selectedPort);
    if (urlEl) urlEl.textContent = path;
    if (openLink) openLink.href = path;
    if (live) setFrameSrc(path);
  }

  function load(): void {
    live = true;
    els.frame.hidden = false;
    if (placeholder) placeholder.hidden = true;
    setFrameSrc(previewPath(selectedPort));
  }

  function showPlaceholder(): void {
    live = false;
    els.frame.hidden = true;
    if (placeholder) placeholder.hidden = false;
    // Blank the frame so the dead server's last page (and its timers) go away.
    if (els.frame.src !== "" && els.frame.src !== "about:blank") els.frame.src = "about:blank";
  }

  function refreshServers(servers: PreviewServer[]): void {
    const currentPorts = new Set(servers.map((s) => s.port));
    const newlyAdded = servers.filter((s) => !knownPorts.has(s.port));
    knownPorts = currentPorts;

    if (select && switcherWrap) {
      // Visible whenever anything is live — even a single server should show
      // its port. At zero the placeholder explains the state instead.
      switcherWrap.hidden = servers.length === 0;
      select.innerHTML = "";
      for (const s of servers) {
        const option = document.createElement("option");
        option.value = String(s.port);
        option.textContent = `:${s.port}`;
        select.appendChild(option);
      }
    }

    if (servers.length === 0) {
      // Last server stopped — back to the default state, no dead iframe.
      selectedPort = undefined;
      showPlaceholder();
      els.tabs.badge("preview", false);
      applySelection();
      return;
    }

    if (newlyAdded.length > 0) {
      // A server just started — that's the "it runs!" moment, show it.
      selectedPort = newlyAdded[newlyAdded.length - 1]!.port;
    } else if (selectedPort === undefined || !currentPorts.has(selectedPort)) {
      const newest = servers[servers.length - 1];
      selectedPort = newest?.port;
    }

    if (select) select.value = selectedPort !== undefined ? String(selectedPort) : "";
    if (!live) load();
    else applySelection();
  }

  events.on("preview:ready", () => {
    load();
    els.tabs.badge("preview", true);
    // The "it runs!" moment — surface the preview immediately.
    els.tabs.activate("preview");
  });

  events.on("preview:servers", (event) => {
    refreshServers(event.servers);
  });

  els.reload.addEventListener("click", () => {
    // Nothing live → nothing to reload; the placeholder already says why.
    // Loading anyway would just frame the service worker's 503 page.
    if (!live) return;
    els.frame.src = `${previewPath(selectedPort)}?_=${Date.now()}`;
  });

  // Seed initial state in case servers are already live (e.g. this module
  // re-initializing after a hot module reload during dev).
  refreshServers(toolchain.previewServers());
}
