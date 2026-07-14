/*
 * Burrow — preview service worker (CONTRACT.md §6.4). Plain JS, no imports.
 *
 * Intercepts same-origin /preview/* requests and forwards each one to the
 * controlling page over a fresh MessageChannel. The page hands the request to
 * the right `bun run` session's Bun.serve fetch handler and replies on the
 * port. We turn that reply into a real Response. Everything else passes through
 * to the network untouched.
 *
 * ROUTING: /preview/<port>/<path> targets the session bound to <port>; the
 * numeric segment (and the /preview prefix) is stripped before the user
 * handler sees the URL. A non-numeric first segment (or no segment at all,
 * i.e. bare /preview/<path>) is back-compat: it carries no port and the page
 * side resolves it to the active/default session.
 */

"use strict";

const PREVIEW_PREFIX = "/preview";
const REPLY_TIMEOUT_MS = 10_000;
const PORT_SEGMENT = /^\/(\d+)(\/.*)?$/;

self.addEventListener("install", () => {
  // Take over as soon as possible so the preview iframe is controlled on first load.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname !== PREVIEW_PREFIX && !url.pathname.startsWith(PREVIEW_PREFIX + "/")) return;
  event.respondWith(handlePreview(event, url));
});

async function handlePreview(event, url) {
  const request = event.request;

  // Strip the /preview prefix, then an optional leading /<port> segment, so
  // the user handler sees "/", "/api/…". A non-numeric first segment (or none
  // at all) leaves `port` undefined — the bare back-compat route.
  const rest = url.pathname.slice(PREVIEW_PREFIX.length); // "" | "/..."
  const portMatch = PORT_SEGMENT.exec(rest);
  let port;
  let path;
  if (portMatch) {
    port = Number.parseInt(portMatch[1], 10);
    path = portMatch[2] || "/";
  } else {
    path = rest === "" ? "/" : rest;
  }
  const forwardedUrl = url.origin + path + url.search;

  let body = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > 0) body = new Uint8Array(buffer);
    } catch {
      body = null;
    }
  }

  const serialized = {
    id: randomId(),
    method: request.method,
    url: forwardedUrl,
    headers: headerEntries(request.headers),
    body: body,
    port: port,
  };

  const client = await pickClient(event);
  if (!client) {
    return plain(503, "Burrow preview: no controlling page is open — open the Burrow tab first.");
  }

  const response = await requestFromPage(client, serialized, body, port);
  if (!response) {
    return plain(504, "Burrow preview: the run worker did not respond in time (504).");
  }
  return deserializeResponse(response);
}

async function pickClient(event) {
  if (event.clientId) {
    const byId = await self.clients.get(event.clientId);
    if (byId) return byId;
  }
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return (
    windows.find((c) => c.focused) ||
    windows.find((c) => c.visibilityState === "visible") ||
    windows[0] ||
    null
  );
}

function requestFromPage(client, serialized, body, port) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.onmessage = null;
      resolve(null);
    }, REPLY_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      const data = event.data;
      resolve(data && data.type === "preview-response" ? data.response : null);
    };
    const transfer = [channel.port2];
    if (body) transfer.push(body.buffer);
    client.postMessage({ type: "preview-request", request: serialized, port: port }, transfer);
  });
}

function deserializeResponse(response) {
  const headers = new Headers();
  for (const pair of response.headers || []) {
    const name = pair[0];
    const lower = String(name).toLowerCase();
    // fetch already decoded the body; forwarding these would corrupt it.
    if (lower === "content-encoding" || lower === "content-length") continue;
    try {
      headers.append(name, pair[1]);
    } catch {
      // ignore illegal header names/values
    }
  }
  const status = response.status || 200;
  // 204/205/304 and friends must have a null body.
  const nullBody = status === 204 || status === 205 || status === 304;
  const payload = nullBody ? null : response.body || null;
  return new Response(payload, {
    status,
    statusText: response.statusText || "",
    headers,
  });
}

function headerEntries(headers) {
  const out = [];
  headers.forEach((value, key) => {
    out.push([key, value]);
  });
  return out;
}

function randomId() {
  if (self.crypto && typeof self.crypto.randomUUID === "function") return self.crypto.randomUUID();
  return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function plain(status, text) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
