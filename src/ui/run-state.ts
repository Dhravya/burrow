/**
 * Burrow — tracks live run sessions + preview availability off the event bus
 * (src/ui internal; feeds the header transport LED and the statusbar).
 */
import { use } from "../contract/registry.ts";

export interface RunStateSnapshot {
  running: number;
  previewLive: boolean;
}

const sessions = new Set<string>();
const previewSessions = new Set<string>();
const listeners = new Set<(s: RunStateSnapshot) => void>();
let inited = false;

function snapshot(): RunStateSnapshot {
  let previewLive = false;
  for (const id of previewSessions) if (sessions.has(id)) previewLive = true;
  return { running: sessions.size, previewLive };
}

function notify(): void {
  const s = snapshot();
  for (const cb of listeners) {
    try {
      cb(s);
    } catch (err) {
      console.error("[burrow/ui] run-state listener failed", err);
    }
  }
}

export function initRunState(): void {
  if (inited) return;
  inited = true;
  const events = use("events");
  events.on("run:started", (e) => {
    sessions.add(e.sessionId);
    notify();
  });
  events.on("run:ended", (e) => {
    sessions.delete(e.sessionId);
    previewSessions.delete(e.sessionId);
    notify();
  });
  events.on("preview:ready", (e) => {
    previewSessions.add(e.sessionId);
    notify();
  });
}

/** Subscribe; fires immediately with the current snapshot. Returns unsubscribe. */
export function onRunState(cb: (s: RunStateSnapshot) => void): () => void {
  listeners.add(cb);
  cb(snapshot());
  return () => listeners.delete(cb);
}
