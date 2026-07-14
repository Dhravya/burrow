/**
 * Burrow — src/git/proxy-route.ts
 * Route-handler factory for Bun.serve. The UI server mounts the contract's
 * canonical `handleGitProxy` directly (CONTRACT.md §9); this factory exists
 * for callers that want the same handler bound to a different prefix or a
 * standalone proxy (tests, alternative servers):
 *
 *   Bun.serve({ routes: { "/git-proxy/*": createGitProxyRoute() } })
 */
import { GIT_PROXY_PREFIX } from "../contract/types.ts";
import { handleGitProxy } from "./proxy.ts";

export interface GitProxyRouteOptions {
  /** Mount prefix the handler strips before rewriting to https:// (default GIT_PROXY_PREFIX). */
  prefix?: string;
}

export type GitProxyRouteHandler = (req: Request) => Promise<Response>;

export function createGitProxyRoute(options: GitProxyRouteOptions = {}): GitProxyRouteHandler {
  const prefix = options.prefix ?? GIT_PROXY_PREFIX;
  return (req: Request) => handleGitProxy(req, prefix);
}
