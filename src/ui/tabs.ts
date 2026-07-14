/** Burrow — tiny tab-stack controller for the right + bottom panes (src/ui internal). */

export interface TabsApi {
  activate(id: string): void;
  active(): string;
  /** Pulse a dot on an inactive tab (cleared when it becomes active). */
  badge(id: string, on: boolean): void;
  onChange(cb: (id: string) => void): () => void;
}

export function initTabs(bar: HTMLElement, panelsRoot: HTMLElement, initial: string): TabsApi {
  const tabs = [...bar.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  const panels = [...panelsRoot.querySelectorAll<HTMLElement>(":scope > [data-panel]")];
  const listeners = new Set<(id: string) => void>();
  let current = "";

  function tabFor(id: string): HTMLButtonElement | undefined {
    return tabs.find((t) => t.dataset.tab === id);
  }

  function activate(id: string): void {
    if (id === current || !tabFor(id)) return;
    current = id;
    for (const t of tabs) t.classList.toggle("active", t.dataset.tab === id);
    for (const p of panels) p.hidden = p.dataset.panel !== id;
    tabFor(id)?.querySelector(".badge")?.remove();
    for (const cb of listeners) {
      try {
        cb(id);
      } catch (err) {
        console.error("[burrow/ui] tab listener failed", err);
      }
    }
  }

  function badge(id: string, on: boolean): void {
    const t = tabFor(id);
    if (!t) return;
    const existing = t.querySelector(".badge");
    if (on && id !== current) {
      if (!existing) {
        const dot = document.createElement("span");
        dot.className = "badge";
        t.append(dot);
      }
    } else {
      existing?.remove();
    }
  }

  for (const t of tabs) t.addEventListener("click", () => activate(t.dataset.tab ?? ""));
  activate(initial);

  return {
    activate,
    active: () => current,
    badge,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
