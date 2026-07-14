/**
 * Burrow src/toolchain — export-shape detector tests.
 *
 * detectHandlerShape decides, inside the run worker, whether an entry module's
 * default export should be registered on the /preview bridge. The same function
 * body is injected into the generated bootstrap via toString(), so we also
 * prove the injected source is standalone-evaluable and behaves identically.
 */

import { describe, expect, test } from "bun:test";
import { makeBootstrapSource } from "./bootstrap.ts";
import { detectHandlerShape, handlerShapeDetectorSource } from "./handler-shape.ts";

describe("detectHandlerShape", () => {
  test("object with a callable fetch (Bun export-default convention)", () => {
    expect(detectHandlerShape({ fetch: (req: Request) => new Response(String(req.url)) })).toBe("fetch-object");
  });

  test("class instance with a fetch property (Hono app shape)", () => {
    class HonoLike {
      fetch = (_req: Request) => new Response("ok");
      get() {}
      post() {}
    }
    expect(detectHandlerShape(new HonoLike())).toBe("fetch-object");
  });

  test("class instance with a fetch METHOD (prototype-defined) also counts", () => {
    class App {
      fetch(_req: Request) {
        return new Response("ok");
      }
    }
    expect(detectHandlerShape(new App())).toBe("fetch-object");
  });

  test("bare function handlers", () => {
    expect(detectHandlerShape(function handler(_req: Request) {})).toBe("function");
    expect(detectHandlerShape((_req: Request) => new Response("hi"))).toBe("function");
    expect(detectHandlerShape(async (_req: Request) => new Response("hi"))).toBe("function");
  });

  test("a class constructor is NOT a handler", () => {
    class NotAHandler {
      render() {}
    }
    expect(detectHandlerShape(NotAHandler)).toBe("none");
  });

  test("non-server default exports", () => {
    expect(detectHandlerShape(undefined)).toBe("none");
    expect(detectHandlerShape(null)).toBe("none");
    expect(detectHandlerShape(42)).toBe("none");
    expect(detectHandlerShape("fetch")).toBe("none");
    expect(detectHandlerShape({})).toBe("none");
    expect(detectHandlerShape({ fetch: "not callable" })).toBe("none");
    expect(detectHandlerShape([1, 2, 3])).toBe("none");
  });
});

describe("detector injection into the run-worker bootstrap", () => {
  test("the injected source is standalone-evaluable and matches the TS function", () => {
    const source = handlerShapeDetectorSource();
    // Evaluate the exact text the bootstrap embeds — no imports, no outer scope.
    const injected = new Function(`return (${source});`)() as typeof detectHandlerShape;

    const samples: unknown[] = [
      { fetch: () => new Response("x") },
      (_req: Request) => new Response("x"),
      class Nope {},
      { fetch: 7 },
      null,
    ];
    for (const sample of samples) {
      expect(injected(sample)).toBe(detectHandlerShape(sample));
    }
  });

  test("makeBootstrapSource wires detection + last-wins registration", () => {
    const bootstrap = makeBootstrapSource("blob:null/entry");
    expect(bootstrap).toContain("const __detectHandlerShape = ");
    expect(bootstrap).toContain("__registerFetchHandler(");
    expect(bootstrap).toContain("default export (object with fetch)");
    expect(bootstrap).toContain("default export (function)");
    // Multiple registrations: last wins, exactly one warning.
    expect(bootstrap).toContain("last one wins");
    // Requests that race a (re)starting worker queue on the ready gate.
    expect(bootstrap).toContain("await __handlerReady");
  });

  test("the generated bootstrap is syntactically valid JS (String.raw template intact)", () => {
    // Parse-only: a stray backtick or ${ in the template throws right here.
    expect(() => new Function(makeBootstrapSource("blob:null/entry"))).not.toThrow();
  });
});
