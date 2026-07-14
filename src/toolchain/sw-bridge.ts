/**
 * Burrow src/toolchain — service worker bridge (CONTRACT.md §6.4).
 *
 * public/sw.js intercepts /preview/* and, for each request, opens a fresh
 * MessageChannel and posts an SwToPageMessage to the controlling page. This
 * module is the page-side counterpart: it listens for those messages and
 * forwards each request to the active run session's Bun.serve fetch handler,
 * replying on the port the service worker handed us.
 *
 * registerServiceWorker() is idempotent and safe to call in non-browser
 * environments (bun test) — it simply no-ops when the API is missing.
 */

import type { PageToSwMessage, SerializedRequest, SerializedResponse, SwToPageMessage } from "../contract/types.ts";
import { previewServers, resolveSessionForPort } from "./session.ts";

const utf8 = new TextEncoder();
let bridgeInstalled = false;
let registerPromise: Promise<void> | null = null;

function statusText(status: number): string {
  if (status === 503) return "Service Unavailable";
  if (status === 502) return "Bad Gateway";
  return "Internal Server Error";
}

function htmlResponse(id: string, status: number, html: string): SerializedResponse {
  return {
    id,
    status,
    statusText: statusText(status),
    headers: [
      ["content-type", "text/html; charset=utf-8"],
      ["cache-control", "no-store"],
    ],
    body: utf8.encode(html),
  };
}

function noServerPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Burrow preview — nothing running</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center;
    font: 14px/1.6 ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    background: radial-gradient(120% 120% at 50% 0%, #17140f 0%, #0d0b09 60%, #080706 100%);
    color: #e7e2d8;
  }
  .card {
    max-width: 30rem; padding: 2.25rem 2.5rem; text-align: center;
    border: 1px solid #322c22; border-radius: 14px;
    background: rgba(28, 24, 18, 0.6);
    box-shadow: 0 24px 60px -30px rgba(0,0,0,0.8);
  }
  .cube { display: inline-block; width: 34px; height: 34px; border-radius: 8px;
    background: linear-gradient(140deg, #f2a34c, #c9761f); margin-bottom: 1rem; }
  h1 { font-size: 1.05rem; margin: 0 0 0.5rem; letter-spacing: -0.01em; }
  p { margin: 0.35rem 0; color: #a49a89; }
  code { color: #f2a34c; background: #241f18; padding: 0.12em 0.42em; border-radius: 5px; }
</style></head>
<body><div class="card">
  <div class="cube"></div>
  <h1>no server running</h1>
  <p>Nothing has called <code>Bun.serve()</code> yet.</p>
  <p>Run an entrypoint — e.g. <code>bun run server.ts</code> — then reload.</p>
</div></body></html>`;
}

function noMatchingPortPage(port: number): string {
  const live = previewServers();
  const list =
    live.length > 0
      ? `<p>Live ports: ${live.map((s) => `<code>${s.port}</code>`).join(", ")}</p>`
      : `<p>No servers are currently running.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Burrow preview — nothing on port ${port}</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center;
    font: 14px/1.6 ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    background: radial-gradient(120% 120% at 50% 0%, #17140f 0%, #0d0b09 60%, #080706 100%);
    color: #e7e2d8;
  }
  .card {
    max-width: 30rem; padding: 2.25rem 2.5rem; text-align: center;
    border: 1px solid #322c22; border-radius: 14px;
    background: rgba(28, 24, 18, 0.6);
    box-shadow: 0 24px 60px -30px rgba(0,0,0,0.8);
  }
  .cube { display: inline-block; width: 34px; height: 34px; border-radius: 8px;
    background: linear-gradient(140deg, #f2a34c, #c9761f); margin-bottom: 1rem; }
  h1 { font-size: 1.05rem; margin: 0 0 0.5rem; letter-spacing: -0.01em; }
  p { margin: 0.35rem 0; color: #a49a89; }
  code { color: #f2a34c; background: #241f18; padding: 0.12em 0.42em; border-radius: 5px; }
</style></head>
<body><div class="card">
  <div class="cube"></div>
  <h1>no server on port ${port}</h1>
  <p>Nothing is listening on <code>${port}</code> right now.</p>
  ${list}
</div></body></html>`;
}

function errorPage(message: string): string {
  const safe = message.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>Burrow preview — handler error</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 2rem; background: #0d0b09; color: #e7e2d8;
    font: 13px/1.6 ui-monospace, Menlo, monospace; }
  h1 { color: #ef8f6b; font-size: 1rem; }
  pre { white-space: pre-wrap; color: #c8bfb0; background: #17140f;
    border: 1px solid #322c22; border-radius: 10px; padding: 1rem; }
</style></head>
<body><h1>the preview bridge failed</h1><pre>${safe}</pre></body></html>`;
}

async function handlePreviewRequest(request: SerializedRequest): Promise<SerializedResponse> {
  const session = resolveSessionForPort(request.port);
  if (!session || !session.hasServer()) {
    // An explicit port with nothing bound to it is a routing miss (502); no
    // port at all (the bare /preview/ route) with no default session yet is
    // the original "nothing has run" case (503).
    return request.port !== undefined
      ? htmlResponse(request.id, 502, noMatchingPortPage(request.port))
      : htmlResponse(request.id, 503, noServerPage());
  }
  try {
    return await session.fetch(request);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    return htmlResponse(request.id, 500, errorPage(message));
  }
}

function installPreviewBridge(): void {
  if (bridgeInstalled) return;
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  bridgeInstalled = true;

  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as SwToPageMessage | undefined;
    if (!data || data.type !== "preview-request") return;
    const port = event.ports[0];
    if (!port) return;
    void handlePreviewRequest(data.request).then((response) => {
      const message: PageToSwMessage = { type: "preview-response", response };
      const transfer = response.body ? [response.body.buffer as ArrayBuffer] : [];
      try {
        port.postMessage(message, transfer);
      } catch {
        // The service worker port may already be closed (request abandoned).
      }
    });
  });
}

/**
 * Register public/sw.js (scope "/") and wire up the page-side preview bridge.
 * Idempotent; the bridge is installed even when registration fails so a
 * pre-existing controller (from an earlier load) can still reach us.
 */
export function registerServiceWorker(): Promise<void> {
  if (registerPromise) return registerPromise;
  registerPromise = (async () => {
    installPreviewBridge();
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    try {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      // Ensure there's an active worker before the preview iframe starts fetching.
      await navigator.serviceWorker.ready;
    } catch (error) {
      console.error("[toolchain] service worker registration failed — preview will be unavailable", error);
    }
  })();
  return registerPromise;
}
