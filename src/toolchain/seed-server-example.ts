/**
 * Burrow src/toolchain — seed server example (Hono), consumed by src/vfs/seed.ts
 * as part of the demo workspace.
 *
 * Why this example: it exercises the whole "real server DX" path end-to-end —
 * a plain Hono endpoint (`export default app`, no Bun.serve call) is picked
 * up by the run worker's handler-shape detection; `"hono": "^4"` pins the
 * bare import to esm.sh's hono@4.x (which has a named `Hono` export); GET /
 * renders a per-request timestamp so hot reload and server-side rendering are
 * visible; and the in-page button POSTs a JSON body to /echo, exercising
 * non-GET methods + request bodies across the service-worker /preview bridge.
 */

/** Suggested VFS filename inside the demo dir. */
export const SERVER_EXAMPLE_FILENAME = "server.ts";

/** Dependencies the demo package.json must carry for the example to build. */
export const SERVER_EXAMPLE_DEPENDENCIES: Record<string, string> = { hono: "^4" };

/**
 * Full demo package.json (keeps the existing nanoid dep used by index.ts and
 * adds hono). To merge into an existing manifest instead, use
 * SERVER_EXAMPLE_DEPENDENCIES.
 */
export const SERVER_EXAMPLE_PACKAGE_JSON = `${JSON.stringify(
  {
    name: "demo",
    private: true,
    type: "module",
    dependencies: {
      hono: "^4",
      nanoid: "^5.1.5",
    },
  },
  null,
  2,
)}\n`;

/** The seed server file: a plain Hono app — no Bun.serve, just `export default app`. */
export const SERVER_EXAMPLE_TS = `import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => {
  const renderedAt = new Date().toISOString();
  return c.html(\`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>hono on Burrow</title>
  <style>
    body { font: 15px/1.6 ui-monospace, Menlo, monospace; background: #0d0b09; color: #e7e2d8;
           display: grid; place-items: center; min-height: 100vh; margin: 0; }
    main { max-width: 36rem; padding: 2rem; }
    code { background: #241f18; border-radius: 6px; padding: 0.1em 0.4em; color: #f2a34c; }
    pre { background: #17140f; border: 1px solid #322c22; border-radius: 10px;
          padding: 0.75rem 1rem; white-space: pre-wrap; color: #c8bfb0; }
    button { font: inherit; background: #f2a34c; color: #241f18; border: 0; border-radius: 8px;
             padding: 0.5rem 1.1rem; cursor: pointer; }
    button:hover { filter: brightness(1.1); }
  </style>
</head>
<body>
  <main>
    <h1>hono, from inside your tab</h1>
    <p>rendered by the server at <code>\${renderedAt}</code></p>
    <p>edit <code>server.ts</code> and save — the server hot-reloads, then refresh me.</p>
    <p><button id="go">POST /echo</button></p>
    <pre id="out">click the button — the request crosses the service-worker bridge</pre>
    <script>
      document.getElementById("go").onclick = async () => {
        const res = await fetch("/echo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hello: "burrow", sentAt: new Date().toISOString() }),
        });
        document.getElementById("out").textContent = JSON.stringify(await res.json(), null, 2);
      };
    </script>
  </main>
</body>
</html>\`);
});

app.post("/echo", async (c) => {
  const body = await c.req.text();
  return c.json({
    youSent: body,
    bytes: body.length,
    echoedAt: new Date().toISOString(),
  });
});

export default app;
`;
