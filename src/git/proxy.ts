/**
 * Burrow — src/git/proxy.ts
 * SERVER-SIDE git smart-http CORS proxy (no browser imports, no registry —
 * the server has neither). Mounted by src/ui/server.ts at `/git-proxy/*`
 * (sanctioned import per CONTRACT.md §1). isomorphic-git's corsProxify
 * rewrites `https://github.com/o/r` into `/git-proxy/github.com/o/r/...`
 * (protocol stripped), so the upstream is `https://` + everything after the
 * prefix + the original query string.
 *
 * Protocol notes (verified against isomorphic-git 1.38.7):
 *  - clone/fetch/pull/push speak smart-http protocol v1:
 *      GET  {repo}/info/refs?service=git-upload-pack   (advertisement)
 *      POST {repo}/git-upload-pack                      (packfile)
 *      (push = same shape with git-receive-pack)
 *  - only getRemoteInfo2/listServerRefs send a Git-Protocol: version=2
 *    header — forwarded anyway.
 *  - 401 upstream responses pass through so onAuth can kick in client-side.
 */
import { GIT_PROXY_PREFIX } from "../contract/types.ts";

/** Request headers forwarded upstream (everything else is dropped). */
const FORWARD_REQUEST_HEADERS = ["accept", "content-type", "authorization", "git-protocol"] as const;

/** Upstream host sanity check: DNS-ish name + optional port. */
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

/** Redirect hops followed manually (each re-validated against the blocklist). */
const MAX_REDIRECTS = 5;

/**
 * Reject upstream hosts that point at loopback, private, link-local (incl.
 * the 169.254.169.254 cloud metadata endpoint), or otherwise non-public
 * addresses. Limitation: a DNS name that RESOLVES to an internal IP still
 * passes — there is no resolver hook here. This proxy is intended for a
 * local dev server; do not expose it on the public internet as-is.
 */
export function isBlockedUpstreamHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.includes(":")) return true; // IPv6 literal (bracketed or not)
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (quad) {
    const segs = quad.slice(1);
    // Segments with leading zeros parse as octal in many stacks ("0177" = 127).
    if (segs.some((s) => s.length > 1 && s.startsWith("0"))) return true;
    const [a, b, c, d] = segs.map(Number) as [number, number, number, number];
    if (a > 255 || b > 255 || c > 255 || d > 255) return true; // not an IP, not a DNS name
    if (a === 0 || a === 10 || a === 127) return true; // "this net", private, loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  // All-numeric or hex-ish hostnames are alternate IP encodings (2130706433,
  // 0x7f000001, 0x7f.0.0.1) — never valid DNS names, so reject wholesale.
  if (/^[\d.]+$/.test(hostname) || /^0x[\da-f.]+$/i.test(hostname)) return true;
  return false;
}

/**
 * Handle one `/git-proxy/*` request. `prefix` defaults to the contract's
 * GIT_PROXY_PREFIX; pass a custom one via createGitProxyRoute (proxy-route.ts).
 */
export async function handleGitProxy(req: Request, prefix: string = GIT_PROXY_PREFIX): Promise<Response> {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return new Response("git-proxy: method not allowed\n", { status: 405 });
  }

  const url = new URL(req.url);
  const cleanPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (url.pathname !== cleanPrefix && !url.pathname.startsWith(`${cleanPrefix}/`)) {
    return new Response("git-proxy: bad prefix\n", { status: 400 });
  }

  // Path after the prefix; be lenient if a client kept the protocol.
  let rest = url.pathname.slice(cleanPrefix.length).replace(/^\/+/, "");
  rest = rest.replace(/^https?:\/{1,2}/i, "");
  if (rest.length === 0) {
    return new Response("git-proxy: missing upstream URL\n", { status: 400 });
  }

  const host = rest.split("/", 1)[0]!;
  const hostname = host.replace(/:\d{1,5}$/, "").toLowerCase();
  if (!HOST_RE.test(host) || isBlockedUpstreamHostname(hostname)) {
    return new Response("git-proxy: invalid upstream host\n", { status: 400 });
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("user-agent", "git/isomorphic-git");

  // POST bodies (git-upload-pack / git-receive-pack requests) verbatim.
  const body = method === "POST" ? await req.arrayBuffer() : undefined;

  // Follow redirects manually so every hop is re-validated against the host
  // blocklist (redirect:"follow" would happily hop to an internal address).
  // The browser client never sees 30x either way.
  let currentUrl = `https://${rest}${url.search}`;
  let currentMethod = method;
  let currentBody = body;
  let upstream: Response;
  for (let hop = 0; ; hop++) {
    try {
      upstream = await fetch(currentUrl, {
        method: currentMethod,
        headers,
        body: currentBody,
        redirect: "manual",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`git-proxy: upstream fetch failed: ${message}\n`, { status: 502 });
    }

    if (upstream.status < 300 || upstream.status >= 400 || upstream.status === 304) break;
    const location = upstream.headers.get("location");
    if (location === null) break; // 30x without Location — pass through as-is
    if (hop >= MAX_REDIRECTS) {
      return new Response("git-proxy: too many upstream redirects\n", { status: 502 });
    }

    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      return new Response("git-proxy: invalid upstream redirect\n", { status: 502 });
    }
    if (next.protocol !== "https:" || isBlockedUpstreamHostname(next.hostname.toLowerCase())) {
      return new Response("git-proxy: redirect to invalid upstream host\n", { status: 400 });
    }

    // Mirror redirect:"follow" semantics: 303 (and 301/302 on POST) become GET.
    if (
      upstream.status === 303 ||
      ((upstream.status === 301 || upstream.status === 302) && currentMethod === "POST")
    ) {
      currentMethod = "GET";
      currentBody = undefined;
    }
    await upstream.body?.cancel().catch(() => {});
    currentUrl = next.toString();
  }

  // Echo ONLY content-type. Never content-encoding/content-length — fetch
  // already decoded the body, so those would corrupt the response.
  const responseHeaders = new Headers({ "cache-control": "no-store" });
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) responseHeaders.set("content-type", contentType);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
