//
//  link.ts — the HTTP filler for the client link seam (full-stack.md T2, "the client link").
//
//  `bus.ts` declares WHERE the link sits in the resolution ladder and knows no transport. This
//  is a transport: the one an ordinary HTTPS deployment uses. A surface installs it at boot
//
//      LinkSeam.routes = linkRoutes;                       // the emitted table
//      LinkSeam.invoke = createHttpLink({ baseUrl, token }); // how to reach it
//
//  and from then on `dsx.module.orders.create({…})` reaches the server without any call site
//  naming a URL, a method, or a header. Moving an action between client and server changes the
//  build, never the markup — which is the entire promise the ladder exists to keep.
//
//  WHAT THIS FILE REFUSES TO DO, and why each refusal is load-bearing:
//
//   • It never chooses a route. It is handed one from the emitted table, which the gateway
//     already filtered — so an internal endpoint cannot be reached from here even by a caller
//     who knows its path, because no LinkRoute for it exists to be handed over.
//   • It never sends the bearer token anywhere but `baseUrl`'s own origin. The origin is fixed
//     at install; a route path cannot escape it (see `resolveUrl`). A link that followed a
//     redirect or an absolute path would post the user's credential to whoever asked.
//   • It never invents a failure. The server answers in a closed vocabulary
//     (`unauthenticated` · `bad_request` · `handler_failed` · …); those pass through as the
//     call's reason. Only a genuine transport failure becomes `unreachable` — and that mapping
//     lives in bus.ts, not here, so there is one place that decides it.
//

import { ModuleCallError, type LinkRoute } from "./bus.ts";
import type { Dict } from "./jse/values.ts";

/** A ceiling on a single response. An unbounded read is a memory-exhaustion primitive. */
const MAX_LINK_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface HttpLinkOptions {
  /** where the server lives — scheme + host (+ optional mount). The token never leaves it. */
  baseUrl: string;
  /** the caller's bearer token, read PER CALL so a refresh is picked up without reinstalling */
  token?: () => string | null | undefined;
  /** injected for tests; defaults to the platform fetch */
  fetchImpl?: typeof fetch;
}

/** Methods that carry a JSON body; everything else puts its arguments in the query string. */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Fill `:param` placeholders from `args`, and report which keys were consumed.
 *
 * A consumed key must NOT also ride in the body or query: sending `id` twice invites the server
 * and the client to disagree about which one is authoritative.
 */
function fillPath(path: string, args: Dict): { path: string; consumed: Set<string> } {
  const consumed = new Set<string>();
  const filled = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":") || segment.length < 2) return segment;
      const name = segment.slice(1);
      const value = args[name];
      if (value === undefined || value === null) {
        throw new ModuleCallError("bad_request", `the route needs a "${name}" argument`, { param: name });
      }
      consumed.add(name);
      // encode: a path argument is DATA and must never add segments or a query of its own
      return encodeURIComponent(String(value));
    })
    .join("/");
  return { path: filled, consumed };
}

/**
 * Join the fixed base to a route path, and refuse anything that would leave the origin.
 *
 * The emitted table only ever holds `/`-rooted paths validated by the emitter, so this cannot
 * trigger in a healthy build — which is exactly why it is here: a link that silently followed a
 * path to another host would carry the bearer token with it.
 */
function resolveUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const url = new URL(base.pathname.replace(/\/$/, "") + path, base);
  if (url.origin !== base.origin) {
    throw new ModuleCallError("bad_request", `the route "${path}" resolves outside ${base.origin}`, { path });
  }
  return url;
}

export function createHttpLink(options: HttpLinkOptions): (route: LinkRoute, args: Dict) => Promise<unknown> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("@despia-native/kernel: createHttpLink needs a fetch implementation on this platform");
  }

  return async (route: LinkRoute, args: Dict): Promise<unknown> => {
    const method = route.method.toUpperCase();
    const { path, consumed } = fillPath(route.path, args);
    const url = resolveUrl(options.baseUrl, path);

    const rest: Dict = {};
    for (const [key, value] of Object.entries(args)) if (!consumed.has(key)) rest[key] = value;

    const headers: Record<string, string> = { accept: "application/json" };
    const token = options.token?.();
    // Attached only for THIS origin — `resolveUrl` already refused anything else.
    if (typeof token === "string" && token !== "") headers.authorization = `Bearer ${token}`;

    const init: RequestInit = { method, headers };
    if (BODY_METHODS.has(method)) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(rest);
    } else {
      for (const [key, value] of Object.entries(rest)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }

    // A transport failure throws — bus.ts turns it into the frozen `unreachable`. Anything the
    // SERVER says, however badly, is an answer and is reported with the server's own reason.
    const response = await doFetch(url.toString(), init);
    const text = await response.text();
    if (text.length > MAX_LINK_RESPONSE_BYTES) {
      throw new ModuleCallError("handler_failed", `the response exceeds ${MAX_LINK_RESPONSE_BYTES} bytes`, { path: route.path });
    }

    let body: unknown;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // Not JSON at all — a proxy error page, a captive portal, an HTML 502. Reporting the body
      // would leak whatever it contains into the caller's error; the status is enough.
      throw new ModuleCallError("handler_failed", `the server answered ${response.status} with a non-JSON body`, { status: response.status });
    }

    // HTTP is the envelope. The server adds no wrapper of its own (host.ts): a success is 2xx
    // carrying the handler's value VERBATIM, a failure is its real status carrying
    // {reason, message}. So the STATUS decides — never a field in the body. That ordering is
    // load-bearing, not stylistic: a handler may legitimately return a payload containing
    // `reason`, and sniffing the body for it would turn that success into an error.
    if (!response.ok) {
      const record = typeof body === "object" && body !== null ? (body as Dict) : {};
      const reason = typeof record["reason"] === "string" ? record["reason"] : "handler_failed";
      const message = typeof record["message"] === "string"
        ? record["message"]
        : `the server refused ${route.chain}.${route.action}`;
      throw new ModuleCallError(reason, message, { status: response.status });
    }
    return body;
  };
}
