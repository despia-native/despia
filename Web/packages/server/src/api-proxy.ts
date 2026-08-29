//
//  api-proxy.ts - the `<api via="server">` proxy route (/web/05 "the secrets story",
//  /web/11 "via=server aggregation"). The CLIENT half is in the kernel: an `<api>` with
//  `via="server"` materializes its request against `/dsx/api/<as>?u=<encoded target>`
//  instead of the target itself, so the secret-bearing half never reaches the bundle.
//  THIS is the server half: one route, no per-block code.
//
//  [S-BOUNDARY] — this file performs NO credential handling. The server-held headers are
//  supplied by the HOST through the `headers` provider (module config / env / a secret
//  manager); this module never reads a secret store, never mints a token, and never
//  forwards the browser's own `authorization`/`cookie` (that is the whole point of the
//  proxy: the client half is not trusted with the credential). Wiring a real provider is
//  Track S work and is deliberately left to the host.
//

import { chargeSpend } from "./spend.ts";

/** The internal route one `via="server"` block calls. Keep in sync with the kernel's
 *  `applyTransportControls` (api.ts / ApiBlock.kt / ApiBlock.swift). */
export const API_PROXY_PREFIX = "/dsx/api/";

export function apiProxyRoutePath(as: string): string {
  return `${API_PROXY_PREFIX}${as}`;
}

export type ApiProxyRequest = { as: string; target: string };

export type ApiProxyOptions = {
  /** the `as` names this build actually declared `via="server"` — anything else is 404.
   *  An unlisted name must never reach the network: that is what keeps the route from
   *  being an open proxy the moment one page ships. */
  allow: Iterable<string>;
  /** absolute origins a target may address. A RELATIVE target is always allowed and
   *  resolves against `base`. An absolute target whose origin is not listed is 403. */
  origins?: Iterable<string>;
  /** the origin a relative target resolves against (the deployed web origin). */
  base?: string;
  /** [S-BOUNDARY] host-supplied server-held headers for one block. */
  headers?: (as: string) => Record<string, string> | Promise<Record<string, string>>;
  /** injectable transport (tests, edge runtimes without a global fetch). */
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  /** request-body ceiling. The body is buffered once so a 307/308 can replay it safely. */
  maxRequestBytes?: number;
  /** upstream response ceiling; matches the kernel's own 16 MiB read bound. */
  maxResponseBytes?: number;
  /** maximum followed redirects. Every target is authorized before it reaches fetch. */
  maxRedirects?: number;
  /** one wall-clock budget for request buffering, every redirect hop and the final body. */
  timeoutMs?: number;
};

const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const HARD_MAX_REDIRECTS = 20;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Request headers the CLIENT half may contribute. Credentials are excluded by design:
 *  a proxied call carries the server's identity, never the browser's. */
const FORWARDABLE_REQUEST_HEADERS = new Set(["content-type", "accept", "accept-language"]);
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "set-cookie", "set-cookie2",
]);
const FORBIDDEN_UPSTREAM_REQUEST_HEADERS = new Set([
  "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);
const REQUEST_BODY_HEADERS = new Set([
  "content-encoding", "content-language", "content-length", "content-location", "content-type",
]);
const CREDENTIAL_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "cookie2", "x-api-key",
  "x-auth-token", "x-access-token",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

/** `/dsx/api/<as>?u=<target>` → the block name + its target, or null when the URL is not
 *  a proxy route at all (the caller falls through to its own routing table). */
export function parseApiProxyRequest(url: URL): ApiProxyRequest | null {
  if (!url.pathname.startsWith(API_PROXY_PREFIX)) return null;
  const as = url.pathname.substring(API_PROXY_PREFIX.length);
  if (!IDENTIFIER.test(as)) return null;
  const target = url.searchParams.get("u");
  if (target === null || target.length === 0) return null;
  return { as, target };
}

function failure(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { kind: code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class ProxyBodyLimitError extends Error {
  readonly kind: "request_too_large" | "response_too_large";
  readonly bytes: number;

  constructor(kind: "request_too_large" | "response_too_large", bytes: number) {
    super(`${kind === "request_too_large" ? "request" : "upstream"} exceeded ${bytes} bytes`);
    this.kind = kind;
    this.bytes = bytes;
  }
}

class ProxyDeadlineError extends Error {
  constructor() {
    super("upstream request deadline exceeded");
  }
}

function numericLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function redirectLimit(value: number | undefined): number {
  return Math.min(HARD_MAX_REDIRECTS, numericLimit(value, DEFAULT_MAX_REDIRECTS));
}

function declaredOrigins(opts: { origins?: Iterable<string>; base?: string }): Set<string> {
  const allowed = new Set([...(opts.origins ?? [])]);
  if ((opts.base ?? "").length > 0) {
    try { allowed.add(new URL(opts.base!).origin); } catch { /* an unparsable base declares nothing */ }
  }
  return allowed;
}

function authorizeProxyUrl(resolved: URL, allowed: Set<string>): string | null {
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return `unsupported scheme ${resolved.protocol}`;
  }
  if (resolved.username.length > 0 || resolved.password.length > 0) {
    return "URL credentials are not allowed";
  }
  if (!allowed.has(resolved.origin)) return `origin ${resolved.origin} is not declared`;
  return null;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("request aborted");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  signal: AbortSignal,
  kind: "request_too_large" | "response_too_large",
): Promise<Uint8Array<ArrayBuffer>> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > max) {
        try { await abortable(reader.cancel(kind), signal); } catch { /* cancellation is best-effort */ }
        throw new ProxyBodyLimitError(kind, total);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (!(error instanceof ProxyBodyLimitError)) {
      try {
        const cancellation = reader.cancel(error);
        await abortable(cancellation, signal);
      } catch { /* already closed or the total deadline elapsed */ }
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function advertisedLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function redirectMethod(status: number, method: string): string {
  if ((status === 301 || status === 302) && method === "POST") return "GET";
  if (status === 303 && method !== "GET" && method !== "HEAD") return "GET";
  return method;
}

function cancelResponse(response: Response, reason: string): void {
  try { void response.body?.cancel(reason).catch(() => undefined); } catch { /* already closed */ }
}

/** Resolve + AUTHORIZE the target. A proxy that will fetch any URL a caller names is an
 *  SSRF hole, so an absolute target must match a declared origin and a relative one is
 *  pinned to `base`. */
export function resolveProxyTarget(
  target: string,
  opts: { origins?: Iterable<string>; base?: string },
): { url: string } | { error: string } {
  const base = opts.base ?? "";
  let resolved: URL;
  try {
    resolved = base.length > 0 ? new URL(target, base) : new URL(target, "http://proxy.invalid");
  } catch {
    return { error: "target is not a URL" };
  }
  const relative = !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) && !target.startsWith("//");
  if (relative && base.length === 0) return { error: "a relative target needs a configured base" };
  const denied = authorizeProxyUrl(resolved, declaredOrigins(opts));
  if (denied !== null) return { error: denied };
  return { url: resolved.toString() };
}

/** Serve one `via="server"` call. Returns null when the request is not a proxy route, so
 *  a host can chain this ahead of its own table. */
export async function handleApiProxy(
  request: Request,
  opts: ApiProxyOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  const parsed = parseApiProxyRequest(url);
  if (parsed === null) return null;
  const allow = new Set([...opts.allow]);
  if (!allow.has(parsed.as)) {
    return failure(404, "unknown_api", `no via="server" block named ${parsed.as}`);
  }
  // Materialize once: `Iterable` deliberately permits generator-backed configuration,
  // which must not disappear between initial authorization and the first redirect.
  const configuredOrigins = [...(opts.origins ?? [])];
  const resolved = resolveProxyTarget(parsed.target, { origins: configuredOrigins, base: opts.base });
  if ("error" in resolved) return failure(403, "target_not_allowed", resolved.error);

  const controller = new AbortController();
  const timeoutMs = Math.max(1, numericLimit(opts.timeoutMs, DEFAULT_TIMEOUT_MS));
  const timeout = setTimeout(() => controller.abort(new ProxyDeadlineError()), timeoutMs);
  const onRequestAbort = () => controller.abort(request.signal.reason ?? new Error("request aborted"));
  if (request.signal.aborted) onRequestAbort();
  else request.signal.addEventListener("abort", onRequestAbort, { once: true });

  try {
    let headers = new Headers();
    request.headers.forEach((value, name) => {
      if (FORWARDABLE_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    });
    const serverHeaderNames = new Set<string>();
    // [S-BOUNDARY] the ONLY place a credential can enter — and it comes from the host.
    if (opts.headers !== undefined) {
      const supplied = await abortable(Promise.resolve(opts.headers(parsed.as)), controller.signal);
      for (const [name, value] of Object.entries(supplied)) {
        if (FORBIDDEN_UPSTREAM_REQUEST_HEADERS.has(name.toLowerCase())) continue;
        headers.set(name, value);
        serverHeaderNames.add(name.toLowerCase());
      }
    }

    let method = request.method.toUpperCase();
    const maxRequest = numericLimit(opts.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES);
    const requestLength = request.headers.get("content-length");
    if (requestLength !== null && /^\d+$/.test(requestLength.trim()) && Number(requestLength) > maxRequest) {
      try { void request.body?.cancel("request_too_large").catch(() => undefined); } catch { /* already closed */ }
      throw new ProxyBodyLimitError("request_too_large", Number(requestLength));
    }
    let body = method === "GET" || method === "HEAD"
      ? undefined
      : await readBounded(request.body, maxRequest, controller.signal, "request_too_large");

    const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    const allowedOrigins = declaredOrigins({ origins: configuredOrigins, base: opts.base });
    const maxResponse = numericLimit(opts.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    const maxRedirects = redirectLimit(opts.maxRedirects);
    let redirects = 0;
    let currentUrl = resolved.url;

    while (true) {
      // The spend meter, per upstream call — redirect hops each cost a call, so each is charged.
      // A host with no matching `egress:` budget answers OPEN (the proxy's own origin included),
      // so only declared egress ever meters here, exactly as at the interpreter's fetch funnel.
      const spendVerdict = chargeSpend(`egress:${new URL(currentUrl).hostname.toLowerCase()}`);
      if (!spendVerdict.allowed) {
        return failure(429, "spend_capped", `the deployment's "${spendVerdict.budget}" budget is spent for this window`);
      }
      let upstream: Response;
      try {
        upstream = await abortable(doFetch(currentUrl, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          redirect: "manual",
          signal: controller.signal,
        }), controller.signal);
      } catch (error) {
        if (error instanceof ProxyDeadlineError || controller.signal.reason instanceof ProxyDeadlineError) {
          return failure(504, "upstream_timeout", "upstream request deadline exceeded");
        }
        if (request.signal.aborted) return failure(499, "request_aborted", "request was aborted");
        return failure(502, "upstream_unreachable", String((error as { message?: string }).message ?? error));
      }

      const advertised = advertisedLength(upstream);
      if (advertised !== null && advertised > maxResponse) {
        cancelResponse(upstream, "response_too_large");
        return failure(502, "response_too_large", `upstream advertised ${advertised} bytes`);
      }

      const location = upstream.headers.get("location");
      if (REDIRECT_STATUSES.has(upstream.status) && location !== null) {
        if (redirects >= maxRedirects) {
          cancelResponse(upstream, "too_many_redirects");
          return failure(502, "too_many_redirects", `upstream exceeded ${maxRedirects} redirects`);
        }
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          cancelResponse(upstream, "invalid_redirect");
          return failure(502, "invalid_redirect", "upstream returned a malformed redirect target");
        }
        const denied = authorizeProxyUrl(next, allowedOrigins);
        if (denied !== null) {
          cancelResponse(upstream, "redirect_not_allowed");
          return failure(403, "target_not_allowed", denied);
        }

        const previous = new URL(currentUrl);
        const nextMethod = redirectMethod(upstream.status, method);
        if (nextMethod !== method) {
          method = nextMethod;
          body = undefined;
          headers = new Headers(headers);
          for (const name of REQUEST_BODY_HEADERS) headers.delete(name);
        }
        if (previous.origin !== next.origin) {
          headers = new Headers(headers);
          for (const name of serverHeaderNames) headers.delete(name);
          for (const name of CREDENTIAL_HEADERS) headers.delete(name);
        }
        cancelResponse(upstream, "redirect_followed");
        currentUrl = next.toString();
        redirects += 1;
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBounded(upstream.body, maxResponse, controller.signal, "response_too_large");
      } catch (error) {
        if (error instanceof ProxyBodyLimitError) {
          return failure(502, error.kind, `upstream returned more than ${maxResponse} bytes`);
        }
        if (error instanceof ProxyDeadlineError || controller.signal.reason instanceof ProxyDeadlineError) {
          return failure(504, "upstream_timeout", "upstream request deadline exceeded");
        }
        if (request.signal.aborted) return failure(499, "request_aborted", "request was aborted");
        return failure(502, "upstream_unreachable", String((error as { message?: string }).message ?? error));
      }
      const out = new Headers();
      upstream.headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        if (!HOP_BY_HOP_RESPONSE_HEADERS.has(lower)
          && lower !== "content-length"
          && lower !== "content-encoding") out.set(name, value);
      });
      const nullBody = method === "HEAD"
        || upstream.status === 204
        || upstream.status === 205
        || upstream.status === 304;
      if (!nullBody) out.set("content-length", String(bytes.byteLength));
      return new Response(nullBody ? null : bytes as unknown as BodyInit, {
        status: upstream.status,
        headers: out,
      });
    }
  } catch (error) {
    if (error instanceof ProxyBodyLimitError) {
      return failure(413, error.kind, `request exceeded ${numericLimit(opts.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES)} bytes`);
    }
    if (error instanceof ProxyDeadlineError || controller.signal.reason instanceof ProxyDeadlineError) {
      return failure(504, "upstream_timeout", "upstream request deadline exceeded");
    }
    if (request.signal.aborted) return failure(499, "request_aborted", "request was aborted");
    return failure(502, "upstream_unreachable", String((error as { message?: string }).message ?? error));
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onRequestAbort);
  }
}
