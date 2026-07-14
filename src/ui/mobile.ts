/**
 * Burrow — mobile pane switcher (src/ui internal). Below the phone breakpoint
 * the app grid stacks all panes in one cell (styles.css); the #mobile-nav
 * buttons flip #app's data-mview between them. Opening a file — a tree tap,
 * `edit x` in the terminal — jumps to the editor pane so the result is visible.
 * Keep the breakpoint in sync with the mobile media query in styles.css.
 */
import { tryUse } from "../contract/registry.ts";

const VIEWS = ["files", "editor", "right", "bottom"] as const;
type View = (typeof VIEWS)[number];

const isView = (v: string | undefined): v is View => (VIEWS as readonly string[]).includes(v ?? "");

export function initMobileNav(app: HTMLElement, nav: HTMLElement): void {
  const phone = window.matchMedia("(max-width: 768px)");
  const buttons = [...nav.querySelectorAll<HTMLButtonElement>("[data-view]")];

  function setView(view: View): void {
    app.dataset.mview = view;
    for (const b of buttons) b.classList.toggle("active", b.dataset.view === view);
  }

  for (const b of buttons) {
    b.addEventListener("click", () => {
      if (isView(b.dataset.view)) setView(b.dataset.view);
    });
  }
  setView(isView(app.dataset.mview) ? app.dataset.mview : "editor");

  tryUse("events")?.on("editor:open", () => {
    if (phone.matches) setView("editor");
  });
}
