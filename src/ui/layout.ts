/**
 * Burrow — draggable pane resizers (src/ui internal). Each handle drives one
 * CSS custom property on #app; double-click resets to the default. Sizes
 * persist to localStorage.
 */
import { must } from "./util.ts";

type VarName = "--sidebar-w" | "--rightbar-w" | "--bottom-h";

const KEY = "burrow.layout";

const DEFAULTS: Record<VarName, number> = {
  "--sidebar-w": 248,
  "--rightbar-w": 360,
  "--bottom-h": 260,
};

const LIMITS: Record<VarName, [number, number]> = {
  "--sidebar-w": [160, 520],
  "--rightbar-w": [240, 680],
  "--bottom-h": [120, 720],
};

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export function initResizers(app: HTMLElement): void {
  const state: Record<VarName, number> = { ...DEFAULTS };
  load();
  apply();

  wire("rz-left", "--sidebar-w", "x", 1);
  wire("rz-right", "--rightbar-w", "x", -1);
  wire("rz-bottom", "--bottom-h", "y", -1);

  function wire(id: string, varName: VarName, axis: "x" | "y", sign: 1 | -1): void {
    const handle = must(id);
    const [min, max] = LIMITS[varName];
    let dragging = false;
    let startPos = 0;
    let startVal = 0;

    handle.addEventListener("pointerdown", (e) => {
      dragging = true;
      startPos = axis === "x" ? e.clientX : e.clientY;
      startVal = state[varName];
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    });

    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const pos = axis === "x" ? e.clientX : e.clientY;
      state[varName] = clamp(startVal + (pos - startPos) * sign, min, max);
      apply();
    });

    const end = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      save();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);

    handle.addEventListener("dblclick", () => {
      state[varName] = DEFAULTS[varName];
      apply();
      save();
    });
  }

  function apply(): void {
    for (const key of Object.keys(state) as VarName[]) {
      app.style.setProperty(key, `${state[key]}px`);
    }
  }

  function load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const key of Object.keys(state) as VarName[]) {
        const value = parsed[key];
        if (typeof value === "number") {
          const [min, max] = LIMITS[key];
          state[key] = clamp(value, min, max);
        }
      }
    } catch {
      /* corrupt/blocked storage — fall back to defaults */
    }
  }

  function save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage full/blocked — sizing just won't persist */
    }
  }
}
