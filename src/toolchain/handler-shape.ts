/**
 * Burrow src/toolchain — default-export handler-shape detection.
 *
 * After the run worker evaluates the entry module, it inspects the module's
 * default export for a server shape:
 *
 *   "fetch-object" — an object with a callable .fetch (a Hono instance, or
 *                    Bun's `export default { fetch(req) {...} }` convention),
 *   "function"     — a bare (req) => Response handler,
 *   "none"         — anything else (classes included: a constructor is not a
 *                    request handler).
 *
 * detectHandlerShape is SELF-CONTAINED ON PURPOSE: bootstrap.ts embeds it into
 * the generated worker source via `detectHandlerShape.toString()`, so the exact
 * function under test here is the one that runs inside the worker. It must not
 * reference any outer binding, and its body must stay backtick-free (the
 * bootstrap is a String.raw template).
 */

export type HandlerShape = "fetch-object" | "function" | "none";

export function detectHandlerShape(value: unknown): HandlerShape {
  if (typeof value === "function") {
    // A class constructor also has typeof "function" but is not a handler.
    var source = Function.prototype.toString.call(value);
    if (/^class[\s{]/.test(source)) return "none";
    return "function";
  }
  if (value !== null && typeof value === "object") {
    var fetchProp = (value as { fetch?: unknown }).fetch;
    if (typeof fetchProp === "function") return "fetch-object";
  }
  return "none";
}

/** The detector as embeddable JS source (what bootstrap.ts splices into the worker). */
export function handlerShapeDetectorSource(): string {
  return Function.prototype.toString.call(detectHandlerShape);
}
