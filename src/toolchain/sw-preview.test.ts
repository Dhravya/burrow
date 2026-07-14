/**
 * Burrow src/toolchain — /preview bridge tests against the REAL public/sw.js.
 *
 * The service worker source is plain dependency-free JS, so we evaluate it
 * with a mocked `self` (addEventListener/clients/location) and drive its fetch
 * handler directly. The page side is simulated by replying on the transferred
 * MessagePort — a real MessageChannel, exactly like production.
 *
 * The essential guarantee proven here: non-GET methods and request BODIES
 * cross the bridge intact (needed for e.g. a Hono `POST /echo` route), the
 * /preview prefix is stripped, and the serialized response round-trips into a
 * real Response.
 */

import { beforeEach, describe, expect, test } from "bun:test";

const ORIGIN = "http://localhost:4808";

type FetchListener = (event: {
  request: Request;
  clientId?: string;
  respondWith: (response: Response | Promise<Response>) => void;
}) => void;

interface SwHarness {
  fetchListener: FetchListener;
  /** Every SwToPageMessage the "page" received, with its reply port. */
  received: { message: any; transfer: unknown[]; reply: (data: unknown, transfer?: any[]) => void }[];
  /** Set to null to simulate "no controlled page". */
  client: { postMessage: (message: any, transfer: unknown[]) => void } | null;
}

async function loadServiceWorker(): Promise<SwHarness> {
  const source = await Bun.file(new URL("../../public/sw.js", import.meta.url).pathname).text();

  const listeners = new Map<string, (event: any) => void>();
  const harness: SwHarness = { fetchListener: null as unknown as FetchListener, received: [], client: null };

  harness.client = {
    postMessage(message: any, transfer: unknown[]) {
      const port = transfer[0] as MessagePort;
      harness.received.push({
        message,
        transfer,
        reply: (data, replyTransfer) => port.postMessage(data, replyTransfer ?? []),
      });
    },
  };

  const fakeSelf = {
    addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    location: { origin: ORIGIN },
    crypto: globalThis.crypto,
    clients: {
      get: async (_id: string) => harness.client,
      matchAll: async () => (harness.client ? [harness.client] : []),
    },
  };

  // Evaluate the untouched service-worker source with our `self`.
  new Function("self", source)(fakeSelf);

  const fetchListener = listeners.get("fetch");
  if (!fetchListener) throw new Error("sw.js registered no fetch listener");
  harness.fetchListener = fetchListener as FetchListener;
  return harness;
}

function dispatchFetch(harness: SwHarness, request: Request): Promise<Response> | null {
  let responded: Promise<Response> | null = null;
  harness.fetchListener({
    request,
    clientId: "client-1",
    respondWith: (response) => {
      responded = Promise.resolve(response);
    },
  });
  return responded;
}

/** Wait until the fake page received `count` bridge messages. */
async function receivedCount(harness: SwHarness, count: number): Promise<void> {
  for (let i = 0; i < 200 && harness.received.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (harness.received.length < count) throw new Error("bridge message never reached the page side");
}

describe("public/sw.js /preview bridge", () => {
  let harness: SwHarness;

  beforeEach(async () => {
    harness = await loadServiceWorker();
  });

  test("POST with a body crosses the bridge: method, body bytes, headers, stripped path", async () => {
    const payload = JSON.stringify({ hello: "burrow" });
    const responded = dispatchFetch(
      harness,
      new Request(`${ORIGIN}/preview/echo?x=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
    );
    expect(responded).not.toBeNull();

    await receivedCount(harness, 1);
    const { message, reply } = harness.received[0]!;

    // What the user's fetch handler will see.
    expect(message.type).toBe("preview-request");
    const serialized = message.request;
    expect(serialized.method).toBe("POST");
    expect(serialized.url).toBe(`${ORIGIN}/echo?x=1`); // /preview stripped, query kept
    expect(serialized.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(serialized.body)).toBe(payload);
    const headers = new Map<string, string>(serialized.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(typeof serialized.id).toBe("string");

    // Page replies over the REAL MessagePort — like sw-bridge.ts does.
    const responseBody = new TextEncoder().encode(JSON.stringify({ echoed: "hello burrow" }));
    reply(
      {
        type: "preview-response",
        response: {
          id: serialized.id,
          status: 201,
          statusText: "Created",
          headers: [
            ["content-type", "application/json"],
            ["content-length", "999"], // must be dropped (fetch already decoded)
            ["x-burrow", "1"],
          ],
          body: responseBody,
        },
      },
      [responseBody.buffer],
    );

    const response = await responded!;
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-burrow")).toBe("1");
    expect(response.headers.get("content-length")).not.toBe("999");
    expect(await response.json()).toEqual({ echoed: "hello burrow" });
  });

  test("GET carries no body and the bare /preview path maps to /", async () => {
    const responded = dispatchFetch(harness, new Request(`${ORIGIN}/preview`, { method: "GET" }));
    expect(responded).not.toBeNull();

    await receivedCount(harness, 1);
    const serialized = harness.received[0]!.message.request;
    expect(serialized.method).toBe("GET");
    expect(serialized.url).toBe(`${ORIGIN}/`);
    expect(serialized.body).toBeNull();

    harness.received[0]!.reply({
      type: "preview-response",
      response: { id: serialized.id, status: 200, statusText: "OK", headers: [], body: null },
    });
    const response = await responded!;
    expect(response.status).toBe(200);
  });

  test("PUT bodies cross too (any non-GET/HEAD method)", async () => {
    const responded = dispatchFetch(
      harness,
      new Request(`${ORIGIN}/preview/items/7`, { method: "PUT", body: "updated!" }),
    );
    await receivedCount(harness, 1);
    const serialized = harness.received[0]!.message.request;
    expect(serialized.method).toBe("PUT");
    expect(serialized.url).toBe(`${ORIGIN}/items/7`);
    expect(new TextDecoder().decode(serialized.body)).toBe("updated!");

    harness.received[0]!.reply({
      type: "preview-response",
      response: { id: serialized.id, status: 204, statusText: "No Content", headers: [], body: null },
    });
    const response = await responded!;
    expect(response.status).toBe(204);
    expect(response.body).toBeNull(); // 204 must have a null body
  });

  test("/preview/<port>/<path> strips both the prefix and the port segment, and reports the port", async () => {
    const responded = dispatchFetch(harness, new Request(`${ORIGIN}/preview/3000/echo`, { method: "GET" }));
    expect(responded).not.toBeNull();

    await receivedCount(harness, 1);
    const { message } = harness.received[0]!;
    const serialized = message.request;
    expect(serialized.url).toBe(`${ORIGIN}/echo`);
    expect(serialized.port).toBe(3000);
    // Top-level message also carries the port (SwToPageMessage.port).
    expect(message.port).toBe(3000);

    harness.received[0]!.reply({
      type: "preview-response",
      response: { id: serialized.id, status: 200, statusText: "OK", headers: [], body: null },
    });
    expect((await responded!).status).toBe(200);
  });

  test("/preview/<port> with no trailing path maps to / and still reports the port", async () => {
    const responded = dispatchFetch(harness, new Request(`${ORIGIN}/preview/4200`, { method: "GET" }));
    await receivedCount(harness, 1);
    const serialized = harness.received[0]!.message.request;
    expect(serialized.url).toBe(`${ORIGIN}/`);
    expect(serialized.port).toBe(4200);

    harness.received[0]!.reply({
      type: "preview-response",
      response: { id: serialized.id, status: 200, statusText: "OK", headers: [], body: null },
    });
    await responded;
  });

  test("/preview/<non-numeric path> keeps back-compat behavior: no port", async () => {
    const responded = dispatchFetch(harness, new Request(`${ORIGIN}/preview/echo`, { method: "GET" }));
    await receivedCount(harness, 1);
    const serialized = harness.received[0]!.message.request;
    expect(serialized.url).toBe(`${ORIGIN}/echo`);
    expect(serialized.port).toBeUndefined();

    harness.received[0]!.reply({
      type: "preview-response",
      response: { id: serialized.id, status: 200, statusText: "OK", headers: [], body: null },
    });
    await responded;
  });

  test("requests outside /preview/* are not intercepted", () => {
    expect(dispatchFetch(harness, new Request(`${ORIGIN}/git-proxy/github.com`, { method: "POST", body: "x" }))).toBeNull();
    expect(dispatchFetch(harness, new Request(`${ORIGIN}/previewer`, { method: "GET" }))).toBeNull();
    expect(dispatchFetch(harness, new Request("https://other-origin.dev/preview/", { method: "GET" }))).toBeNull();
  });

  test("no controlled page -> 503, not a hang", async () => {
    harness.client = null;
    const responded = dispatchFetch(harness, new Request(`${ORIGIN}/preview/`, { method: "POST", body: "x" }));
    const response = await responded!;
    expect(response.status).toBe(503);
  });
});
