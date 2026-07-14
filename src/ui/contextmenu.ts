/**
 * Burrow — one shared context menu, styled like the rest of the chrome
 * (src/ui internal). Only one menu exists at a time; it closes on outside
 * pointerdown, Escape, scroll/wheel, resize, and window blur.
 */
import { h } from "./util.ts";

export interface CtxMenuItem {
  label: string;
  /** Dim right-aligned annotation, e.g. a target directory. */
  hint?: string;
  danger?: boolean;
  separatorBefore?: boolean;
  action(): void;
}

let current: { el: HTMLElement; dispose(): void } | null = null;

export function closeContextMenu(): void {
  current?.dispose();
}

export function showContextMenu(x: number, y: number, items: CtxMenuItem[]): void {
  closeContextMenu();
  if (items.length === 0) return;

  const el = h("div", "ctxmenu");
  el.setAttribute("role", "menu");

  function dispose(): void {
    if (current?.el !== el) return;
    current = null;
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("wheel", dispose, true);
    window.removeEventListener("blur", dispose);
    window.removeEventListener("resize", dispose);
    el.remove();
  }

  for (const item of items) {
    if (item.separatorBefore) el.append(h("div", "ctxmenu-sep"));
    const btn = h("button", `ctxmenu-item${item.danger ? " danger" : ""}`);
    btn.setAttribute("role", "menuitem");
    btn.append(h("span", "label", item.label));
    if (item.hint) btn.append(h("span", "hint", item.hint));
    btn.addEventListener("click", () => {
      dispose();
      item.action();
    });
    el.append(btn);
  }

  function onPointerDown(e: PointerEvent): void {
    if (!el.contains(e.target as Node)) dispose();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dispose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const btns = [...el.querySelectorAll<HTMLButtonElement>(".ctxmenu-item")];
      if (btns.length === 0) return;
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "ArrowDown" ? (i + 1) % btns.length : i <= 0 ? btns.length - 1 : i - 1;
      btns[next]?.focus();
    }
  }

  document.body.append(el);
  // Clamp into the viewport once the menu has a size.
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;

  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("wheel", dispose, true);
  window.addEventListener("blur", dispose);
  window.addEventListener("resize", dispose);

  current = { el, dispose };
  el.querySelector<HTMLButtonElement>(".ctxmenu-item")?.focus();
}
