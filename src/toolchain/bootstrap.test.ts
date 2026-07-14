/**
 * Burrow src/toolchain — run-worker bootstrap port-capture tests.
 *
 * coercePort is what the generated worker uses to turn Bun.serve({port})
 * into the number reported in the serve-listening message (CONTRACT.md
 * §6.3/§6.4). Same pattern as handler-shape.test.ts: prove the standalone
 * function's behavior, then prove the EXACT injected source (what
 * makeBootstrapSource splices into the worker via coercePortSource())
 * behaves identically and that the generated bootstrap actually wires it in.
 */

import { describe, expect, test } from "bun:test";
import { coercePort, coercePortSource, makeBootstrapSource } from "./bootstrap.ts";

describe("coercePort", () => {
  test("a plain positive number passes through", () => {
    expect(coercePort(5173)).toBe(5173);
    expect(coercePort(80)).toBe(80);
  });

  test("numeric strings parse", () => {
    expect(coercePort("8080")).toBe(8080);
    expect(coercePort("3001")).toBe(3001);
  });

  test("floats are floored", () => {
    expect(coercePort(3000.7)).toBe(3000);
  });

  test("falls back to Bun's default (3000) for 0, negative, NaN, non-numeric strings, and omission", () => {
    expect(coercePort(0)).toBe(3000);
    expect(coercePort(-1)).toBe(3000);
    expect(coercePort(Number.NaN)).toBe(3000);
    expect(coercePort("abc")).toBe(3000);
    expect(coercePort(undefined)).toBe(3000);
    expect(coercePort(null)).toBe(3000);
  });
});

describe("coercer injection into the run-worker bootstrap", () => {
  test("the injected source is standalone-evaluable and matches the TS function", () => {
    const source = coercePortSource();
    const injected = new Function(`return (${source});`)() as typeof coercePort;

    const samples: unknown[] = [5173, "8080", 0, -1, Number.NaN, "abc", undefined, null, 3000.9];
    for (const sample of samples) {
      expect(injected(sample)).toBe(coercePort(sample));
    }
  });

  test("makeBootstrapSource captures Bun.serve({port}) and reports it in serve-listening", () => {
    const bootstrap = makeBootstrapSource("blob:null/entry");
    expect(bootstrap).toContain("const __coercePort = ");
    expect(bootstrap).toContain("const port = __coercePort(options.port);");
    expect(bootstrap).toContain('__registerFetchHandler(options.fetch, "Bun.serve()", port);');
    expect(bootstrap).toContain('__post({ type: "serve-listening", port: port });');
  });

  test("the default-export handler-shape path always reports port 3000", () => {
    const bootstrap = makeBootstrapSource("blob:null/entry");
    expect(bootstrap).toContain('"default export (object with fetch)", 3000');
    expect(bootstrap).toContain('"default export (function)", 3000');
  });

  test("the generated bootstrap is syntactically valid JS (String.raw template intact)", () => {
    expect(() => new Function(makeBootstrapSource("blob:null/entry"))).not.toThrow();
  });
});
