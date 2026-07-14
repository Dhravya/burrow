/**
 * Burrow — src/ai/index.ts
 * Module init entrypoint per CONTRACT.md §1. Boot order guarantees initVfs()
 * (events + vfs) and the earlier modules have run before this. Nothing here
 * touches WebGPU or transformers.js — the model download stays lazy until the
 * user clicks "Load model" in the panel.
 *
 *   initAi(panelEl):
 *     1. builds the AiController (owns the bundled worker + AiState machine),
 *     2. provides it to the registry as "ai" (it satisfies AiPanelAPI),
 *     3. mounts the agent panel into the supplied element.
 */

import { provide } from "../contract/registry.ts";
import { createAiController } from "./controller.ts";
import { mountAiPanel } from "./panel.ts";

let initialized = false;

export function initAi(panelEl: HTMLElement): void {
  if (initialized) return;
  initialized = true;

  const controller = createAiController();
  provide("ai", controller);
  mountAiPanel(panelEl, controller);
}
