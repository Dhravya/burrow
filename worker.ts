/**
 * Burrow — Cloudflare Worker entry (production hosting).
 *
 * Serves the static build (./dist, uploaded as Workers assets) and mounts the
 * same server-side pieces the dev server provides in server.ts:
 *  - /git-proxy/*  → src/git/proxy.ts (runtime-agnostic: plain fetch/Request/
 *    Response, so the exact dev handler runs on the edge unchanged)
 *  - /preview/*    → 503 hint; the real preview is served client-side by the
 *    service worker, this only answers when the SW isn't installed yet
 *
 * Deploy: bun run build.ts && bunx wrangler deploy
 */
import { handleGitProxy } from "./src/git/proxy.ts";

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/git-proxy" || pathname.startsWith("/git-proxy/")) {
      return handleGitProxy(req);
    }
    if (pathname === "/preview" || pathname.startsWith("/preview/")) {
      return new Response("preview is served by the service worker — open the app first", {
        status: 503,
      });
    }
    return env.ASSETS.fetch(req);
  },
};
