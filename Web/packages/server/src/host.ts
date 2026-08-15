//
//  host.ts - the T1 server module host (full-stack.md): boot from the compiled routes
//  table, dispatch a web-standard Request to the registered action handler, answer with
//  the typed JSON envelope. Platform-free by construction — no node:/Deno imports, same
//  bar the kernel already clears in the browser; anything platform-shaped (fs, env,
//  ports, JWT verification) lives in the bootloaders around it.
//

import type { Identity } from "./identity.ts";
import { rateHeaders, spend, type RateLimitRule } from "./ratelimit.ts";
import { secretEquals } from "./secrets.ts";
import { readTraceContext, type TraceContext } from "./trace.ts";

/** One row of the emitter's routes table (prepare_server.rb): a module action exposed at method+path. */
export interface ServerRoute {
  /** the declaration key (the module's facets.api row name) */
  key: string;
  /** the owning module's derived chain (e.g. "server.http") */
  chain: string;
  /** the module action the row targets */
  action: string;
  /** HTTP method — any case; matched case-insensitively */
  method: string;
  /** /segments with :param placeholders (e.g. /orders/:id) */
  path: string;
  /** "required" gates the row on a resolved identity (401 unauthenticated otherwise); absent ≡ public */
  auth?: string;
  /** cron expression — consumed by the platform emitters (pg_cron / Cloud Scheduler), inert to dispatch */
  schedule?: string;
  /**
   * THE API GATEWAY (full-stack.md: "`provides`/`reach` is the API gateway … a fail-closed
   * allowlist: the client can invoke, never execute"). The client surfaces the target action
   * declares `reach` to. The emitter (prepare_server.rb) aborts the BUILD when a route's action
   * reaches no client surface, so this array is the runtime's defence in depth rather than its
   * only line. An EMPTY array means INTERNAL: no client surface may invoke it, so the route is
   * dispatchable only by a service-role caller (cron/queue drains) — see `serviceRoles`.
   */
  reach?: string[];
  /** the queue this row drains (T4). A worker row is internal by construction. */
  worker?: string;
  /** the payload field carrying the idempotency key (T4) — enforced by the queue table's UNIQUE */
  idempotencyKey?: string;
  /**
   * The declared request budget for this row: `"<limit>/<window>"`, window one of s·m·h
   * (e.g. `"60/m"`, `"1000/h"`). Absent means no limit, which stays the default — a ceiling
   * nobody asked for is a production incident waiting for the first traffic spike.
   */
  rate?: string;
  /**
   * DO NOT READ THE BODY — hand the handler the Request with its stream untouched.
   *
   * Exactly one class of route needs this and it is not a preference: an inbound webhook is
   * verified by an HMAC over the RAW BYTES the sender signed, and a body this host has already
   * parsed cannot be un-parsed. `JSON.parse` then `JSON.stringify` is the same VALUE and
   * different BYTES (key order, escapes, number formatting), so a receiver handed the
   * round-tripped body either rejects legitimate deliveries or stops verifying. A stream can be
   * read once, so the choice has to be made before the read, which is why it is declared on the
   * row rather than decided by the handler.
   *
   * `ctx.body` is empty on such a route; the handler reads `ctx.request` itself, under its own
   * cap.
   */
  rawBody?: boolean;
}

/** Request-scoped context handed to every handler — the identity/env seam the bootloaders fill. */
export interface HostContext {
  buildInfo: Record<string, unknown>;
  /** the bootloader-resolved identity (identity.ts) — T1's loose record shape stays accepted at the seam */
  identity: Identity | Record<string, unknown> | null;
  /** secrets stay at the bootloader boundary — handlers read through this, never ambient globals */
  env: (key: string) => string | undefined;
  /**
   * THE ARG PLANES, KEPT DISTINCT. The first handler parameter is the convenience MERGE
   * (query ⊕ body ⊕ path params) and is fine to read field-by-field — but it is caller-controlled
   * in its entirety, so passing it WHOLESALE into a write is mass assignment: a client can name
   * any key, including ones the handler never meant to accept (`owner_id`, `id`, `role`).
   * These three planes let a writer say exactly which surface a value came from, and are what the
   * T3 repository + declared-CRUD codegen bind against (they never read the merge).
   */
  query: Record<string, string>;
  body: Record<string, unknown>;
  params: Record<string, string>;
  /** correlation id for this request — the token that ties a client-visible failure to the server log */
  correlationId: string;
  /**
   * The W3C trace context (trace.ts), adopted from the caller's `traceparent` or started fresh.
   * A handler making an outbound call spreads `traceHeaders(ctx.trace)` into it, and the hop is
   * joined; ignoring it costs nothing.
   */
  trace: TraceContext;
  /**
   * The request itself, for the handlers that genuinely need it: the raw signed bytes of an
   * inbound webhook (`rawBody`), and a header no arg plane carries, such as the `Last-Event-ID`
   * an SSE client resumes from.
   *
   * The three arg planes remain the way to read caller INPUT — reaching for `request.url` or
   * re-parsing the body here is how a handler ends up with a second, different opinion about
   * what the caller sent. On a route that did not declare `rawBody` the body stream is ALREADY
   * CONSUMED and reading it again yields nothing.
   */
  request: Request;
}

export type HostHandler = (args: Record<string, unknown>, ctx: HostContext) => Promise<unknown> | unknown;

export interface HostConfig {
  routes: ServerRoute[];
  /** chain → action name → implementation (the generated handlers barrel) */
  handlers: Record<string, Record<string, HostHandler>>;
  buildInfo?: Record<string, unknown>;
  /**
   * Request-body ceiling in bytes (default 1 MiB). An unbounded `await req.text()` is a
   * memory-exhaustion DoS with a one-line request; the cap is enforced BEFORE parsing, and
   * against the stream rather than only the declared Content-Length (which a client may lie about).
   */
  maxBodyBytes?: number;
  /**
   * The identity roles that count as INTERNAL callers — who may invoke a route whose `reach` is
   * empty (a cron/queue drain). Default `["service_role"]`, the Supabase service-role claim.
   * Without this a drain endpoint is a public POST guarded only by "any valid user JWT".
   */
  serviceRoles?: string[];
  /**
   * A SHARED SECRET that admits an internal (`reach: []`) caller without an identity at all,
   * presented as `X-DSX-Internal-Key`. Absent by default; when absent this path does not exist
   * and the role check below is the only way in.
   *
   * WHY THIS EXISTS (the pg_cron drain, full-stack.md). A Supabase `service_role` key is a
   * ~10-year JWT, and `identity.ts` refuses any token whose declared lifetime exceeds 24h — so a
   * platform service key resolves to NO identity, the role check fails, and the drain gets the
   * same 404 a stranger gets. Measured on the live edge server: a 10-year token → 404, a
   * 5-minute token → 200. The queue silently never drains.
   *
   * Of the three ways out, this is the one that neither weakens the ceiling nor needs a token
   * minter. A machine caller on a fixed schedule is not a user and has no identity to model; the
   * honest primitive for it is a declared secret, not a forged user. The 24h ceiling stays
   * exactly as strict for everything that IS a user, which is the point — raising it would have
   * widened the boundary for every caller in order to admit one cron job.
   */
  internalKey?: string;
  /**
   * Server-side failure sink. The client NEVER receives an exception message (it leaks stack
   * frames, SQL, and occasionally secrets); it receives a reason + correlation id, and the real
   * detail arrives here. Defaults to `console.error`, which is web-standard on Node, Deno and
   * the edge — the host stays platform-free (see the file header).
   */
  onError?: (info: { correlationId: string; route: string; error: unknown; trace?: TraceContext }) => void;
  /**
   * WHO THIS REQUEST IS, for rate-limiting purposes, when it carries no identity.
   *
   * Supplied by the bootloader because only the bootloader knows what is in front of it. Reading
   * `X-Forwarded-For` unconditionally would be worse than not limiting at all: the header is
   * caller-controlled, so a limiter keyed on it is bypassed by sending a different value each
   * request, AND can be used to exhaust another caller's budget by sending theirs. It is
   * trustworthy only when a proxy you control overwrites it, which is a deployment fact this
   * file cannot know. `bootloader-deno` supplies the platform's own value; `bootloader-node`
   * supplies the socket address.
   *
   * Returning null is fine and is the safe default. See the bucket comment in `dispatch` for what
   * an unidentifiable caller is charged against, and what that costs.
   */
  clientAddress?: (req: Request) => string | null;
}

/** The closed failure vocabulary of the wire envelope (errors are typed values — error-system.md). */
export type HostErrorReason = "unknown_route" | "method_not_allowed" | "unauthenticated" | "bad_request" | "handler_failed" | "unknown_action" | "rate_limited";

export interface Host {
  handle(req: Request, ctx?: Partial<HostContext>): Promise<Response>;
}

// ── the compiled match table ────────────────────────────────────────────────────────────

interface Segment {
  kind: "literal" | "param";
  value: string; // literal text, or the param name without the ":"
}

interface CompiledRoute {
  route: ServerRoute;
  method: string; // uppercased once at compile time
  segments: Segment[];
  literalPrefix: number; // count of leading literal segments — the primary sort key
  rate: RateLimitRule | null; // parsed ONCE at construction, never per-request
}

function compileRoute(route: ServerRoute): CompiledRoute {
  const segments = route.path
    .split("/")
    .filter((s) => s !== "")
    .map((s): Segment => (s.startsWith(":") && s.length > 1 ? { kind: "param", value: s.slice(1) } : { kind: "literal", value: s }));
  let literalPrefix = 0;
  for (const seg of segments) {
    if (seg.kind !== "literal") break;
    literalPrefix++;
  }
  return { route, method: route.method.toUpperCase(), segments, literalPrefix, rate: parseRateRule(route.rate) };
}

// Deterministic table order — longest literal prefix first (/orders/summary always beats
// /orders/:id), then literal-before-param position by position, then lexicographic
// literals, then method/key: the same routes array yields the same table everywhere,
// whatever order the emitter listed the rows in.
function compareRoutes(a: CompiledRoute, b: CompiledRoute): number {
  if (a.literalPrefix !== b.literalPrefix) return b.literalPrefix - a.literalPrefix;
  const n = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) {
    const sa = a.segments[i]!;
    const sb = b.segments[i]!;
    if (sa.kind !== sb.kind) return sa.kind === "literal" ? -1 : 1;
    if (sa.kind === "literal" && sa.value !== sb.value) return sa.value < sb.value ? -1 : 1;
  }
  if (a.segments.length !== b.segments.length) return a.segments.length - b.segments.length;
  if (a.method !== b.method) return a.method < b.method ? -1 : 1;
  return a.route.key < b.route.key ? -1 : a.route.key > b.route.key ? 1 : 0;
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a malformed escape can only ever match literally
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((s) => s !== "").map(decodeSegment);
}

/** null = no match; otherwise the extracted :param map (possibly empty) */
function matchPath(compiled: CompiledRoute, pathSegments: string[]): Record<string, string> | null {
  if (compiled.segments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < compiled.segments.length; i++) {
    const seg = compiled.segments[i]!;
    const got = pathSegments[i]!;
    if (seg.kind === "literal") {
      if (seg.value !== got) return null;
    } else {
      params[seg.value] = got;
    }
  }
  return params;
}

// ── the wire shape: HTTP is the envelope ────────────────────────────────────────────────
//
// This server adds NO envelope of its own. A success is `200` carrying the handler's value
// verbatim; a failure is its real status carrying `{reason, message}`. There is no `ok` field
// because the status line already is one, and no `data` wrapper because the body already is
// the data.
//
// It used to reply `200 {ok, data|error}` on top of the status. That cost more than the
// nesting it looked like:
//
//   * a screen had to write `notes.data.data`, while `notes.ok` described the HTTP hop and
//     `notes.data.ok` described the server's verdict — two `ok`s, different meanings, one
//     binding path. A 200 carrying `{"ok":false}` read as success.
//   * <api> could only strip it by GUESSING from the body whether `{ok, data}` came from a
//     DSX server or from a third-party API that happens to use those keys — a very common
//     shape. No content rule can be right, so the block would eventually unwrap somebody
//     else's payload silently. A marker header only moves the privilege elsewhere.
//   * it made the DSX backend the one special-cased server in a system whose law is that no
//     envelope is imposed on a third-party API, and that neither surface is privileged.
//
// The field carried no information either way: every failure below already picks a real
// status (400/401/404/405/413/500), so `ok` only ever restated the status line.
//
// If a handler's own payload happens to contain `reason`/`message`, nothing is ambiguous —
// the status distinguishes them, which is exactly the job HTTP status codes exist to do.

function json(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function failure(status: number, reason: HostErrorReason, message: string, extraHeaders?: Record<string, string>): Response {
  return json(status, { reason, message }, extraHeaders);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
/** The floor both the host and every bootloader fall back to — one spelling, exported so a
 *  transport-level cap can never drift from the one the host enforces. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_SERVICE_ROLES = ["service_role"];

/** A short opaque id tying a client-visible failure to its server-side detail. */
function newCorrelationId(): string {
  // crypto.randomUUID is web-standard on Node 19+, Deno and the edge; the fallback keeps the
  // host usable on an older embedder without reaching for a platform module (file header).
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** The role claim of a resolved identity, whatever shape the seam accepted. */
/** The header a machine caller presents the declared internal key on. */
const INTERNAL_KEY_HEADER = "x-dsx-internal-key";

/**
 * `"<limit>/<window>"` → a rule, or null when the row declares no budget.
 *
 * Returns null rather than throwing on a malformed value for one reason: this runs once per row
 * at host construction, and an unparseable rate would otherwise take the whole server down at
 * boot over a typo in a declaration. The BUILD is where a bad `rate` should be caught
 * (prepare_server.rb validates the same grammar and aborts), so a value that reaches here and
 * fails to parse means the build check was bypassed — and refusing to boot is a worse answer than
 * serving without a limit that was never enforced before either.
 */
const RATE_RULE = /^(\d+)\/(\d+)?([smh])$/;
const WINDOW_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

export function parseRateRule(rate: string | undefined): RateLimitRule | null {
  if (typeof rate !== "string" || rate === "") return null;
  const match = RATE_RULE.exec(rate.trim());
  if (match === null) return null;
  const limit = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  const unit = WINDOW_MS[match[3]!];
  if (!Number.isFinite(limit) || limit < 1 || !Number.isFinite(count) || count < 1 || unit === undefined) return null;
  return { limit, windowMs: count * unit };
}

function identityRole(identity: HostContext["identity"]): string | null {
  if (identity === null || typeof identity !== "object") return null;
  const role = (identity as { role?: unknown }).role;
  return typeof role === "string" && role !== "" ? role : null;
}

type BodyRead = { ok: true; text: string } | { ok: false; reason: "too_large" | "unreadable" };

/**
 * Read the body with a HARD ceiling. Content-Length is checked first (the cheap rejection) but is
 * never trusted alone — a chunked or mis-declared request is capped while streaming, so an
 * oversized body is refused without ever being fully materialised.
 */
async function readBodyCapped(req: Request, maxBytes: number): Promise<BodyRead> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large" };
  const stream = req.body;
  if (!stream) {
    try {
      const text = await req.text();
      if (new TextEncoder().encode(text).length > maxBytes) return { ok: false, reason: "too_large" };
      return { ok: true, text };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "too_large" };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

// ── the host ────────────────────────────────────────────────────────────────────────────

export function createHost(config: HostConfig): Host {
  const table = config.routes.map(compileRoute).sort(compareRoutes); // built ONCE, never per-request
  const configBuildInfo = config.buildInfo ?? {};
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const serviceRoles = config.serviceRoles ?? DEFAULT_SERVICE_ROLES;
  // Normalised ONCE per host, not per request: an empty string is "not configured", so a
  // blank env var can never become a key that an empty header matches.
  const internalKey = typeof config.internalKey === "string" && config.internalKey !== ""
    ? config.internalKey
    : null;
  const onError = config.onError ?? ((info: { correlationId: string; route: string; error: unknown; trace?: TraceContext }): void => {
    // The TRACE ID is what joins this line to the caller's log and to whatever this handler
    // called; the correlation id is what the client was handed. Both, or the line is only half
    // useful — and printing the trace id is the entire reason it is adopted rather than invented.
    const trace = info.trace === undefined ? "" : ` trace=${info.trace.traceId}/${info.trace.spanId}`;
    // eslint-disable-next-line no-console -- the default failure sink; a host may replace it
    console.error(`[dsx.server] ${info.route} failed (${info.correlationId})${trace}: ${errorMessage(info.error)}`);
  });

  async function dispatch(
    compiled: CompiledRoute,
    params: Record<string, string>,
    req: Request,
    url: URL,
    method: string,
    ctx: Partial<HostContext> | undefined,
  ): Promise<Response> {
    const { route } = compiled;
    const identity = ctx?.identity ?? null;
    // Set only when a budget applied, and echoed on the SUCCESS response too: a client cannot
    // back off before it is refused unless it can watch the budget shrink.
    let rateAdvisory: Record<string, string> | undefined;

    // THE GATEWAY, first and cheapest. A route whose action reaches no client surface is
    // INTERNAL (a cron/queue drain): only a service-role caller may invoke it. Anyone else gets
    // 404 — never 403, which would confirm the endpoint exists to a prober. The build already
    // aborts on an unreachable route (prepare_server.rb); this is defence in depth.
    // Whether THIS request cleared the internal gateway by presenting the declared key rather
    // than by carrying a service-role identity. Scoped to one request, set only inside the
    // `reach: []` branch, and read only by the auth check immediately after it.
    let admittedByKey = false;
    if (route.reach !== undefined && route.reach.length === 0) {
      const role = identityRole(identity);
      const byRole = role !== null && serviceRoles.includes(role);
      // The declared internal key is an ALTERNATIVE to a service-role identity, never a
      // widening of one: it only ever admits a `reach: []` route, which no client surface can
      // name, and it is checked nowhere else in this file. A caller with neither still gets the
      // prober's 404.
      const byKey = internalKey !== null && secretEquals(req.headers.get(INTERNAL_KEY_HEADER), internalKey);
      if (!byRole && !byKey) {
        return failure(404, "unknown_route", `no route matches ${method} ${url.pathname}`);
      }
      admittedByKey = byKey;
    }
    // ON AN INTERNAL ROUTE, THE KEY *IS* THE CREDENTIAL. The emitter marks every worker row
    // `auth: "required"` as well as `reach: []`, so without this the key would clear the gateway
    // and then be refused 401 by the very next line — the drain would stay exactly as broken as
    // the 24h ceiling left it, which is what the S5b test caught.
    //
    // `admittedByKey` can only be true inside the `reach: []` branch above, so this cannot widen
    // anything a client can name: an `auth: required` route with a non-empty reach never consults
    // it, and is 401 to a key-bearing caller (pinned by test).
    if (route.auth === "required" && identity === null && !admittedByKey) {
      // gated BEFORE any body work — an anonymous request never exercises a protected handler's parsing
      return failure(401, "unauthenticated", `route "${route.key}" requires an authenticated identity`);
    }

    // THE REQUEST BUDGET, after the identity gate and before ANY body work.
    //
    // The order is the whole point. Charging before the 401 lets an unauthenticated stranger
    // spend an authenticated user's budget; charging after the body read makes the expensive work
    // happen anyway, so the limit stops nothing it was declared to stop.
    //
    // THE BUCKET. An identified caller is charged by `sub`, which they cannot forge — the token
    // was verified. A caller with no identity is charged by whatever `clientAddress` reports, and
    // when that is null they all share ONE bucket per route. That shared bucket is a deliberate
    // trade, not an oversight: it means a single abusive stranger can exhaust the anonymous
    // budget for a public route and other anonymous callers get 429s. The alternative is no
    // ceiling on the one class of route a stranger can reach at will, which takes the backend
    // down for everyone including the authenticated users this keeps serving. Degrading anonymous
    // access is the better failure, and supplying `clientAddress` removes the trade entirely.
    const rule = compiled.rate;
    if (rule !== null) {
      const sub = identity !== null && typeof identity === "object" ? (identity as { sub?: unknown }).sub : undefined;
      const caller = typeof sub === "string" && sub !== ""
        ? `u:${sub}`
        : `a:${config.clientAddress?.(req) ?? ""}`;
      const verdict = await spend(`${route.key}|${caller}`, rule, {
        onError: (error) => onError({ correlationId: newCorrelationId(), route: route.key, error }),
      });
      if (!verdict.allowed) {
        return failure(429, "rate_limited", `too many requests for route "${route.key}"`, rateHeaders(verdict));
      }
      rateAdvisory = rateHeaders(verdict);
    }

    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value; // a repeated query key: last one wins
    const body: Record<string, unknown> = {};
    if (!route.rawBody && BODY_METHODS.has(method) && (req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      const read = await readBodyCapped(req, maxBodyBytes);
      if (!read.ok) {
        return read.reason === "too_large"
          ? failure(413, "bad_request", `request body exceeds the ${maxBodyBytes}-byte limit`)
          : failure(400, "bad_request", "unreadable request body");
      }
      if (read.text.trim() !== "") { // an empty body under a JSON content-type is absent, not malformed
        let parsed: unknown;
        try {
          parsed = JSON.parse(read.text);
        } catch {
          // the parser's own message can echo body bytes back to the caller — say only what failed
          return failure(400, "bad_request", "malformed JSON body");
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return failure(400, "bad_request", "JSON body must be an object");
        }
        // Copy the caller's fields WITHOUT letting a "__proto__" key rewrite body's prototype.
        // `Object.assign(body, parsed)` — and any `body[k] = v` — goes through [[Set]], and
        // [[Set]] of the key "__proto__" invokes the Object.prototype setter, replacing body's
        // prototype with a caller-supplied object. `ctx.body.<anyKey-the-client-did-not-send>`
        // would then resolve to that injected object's value instead of `undefined`, defeating
        // the plane separation a handler is explicitly told it may trust field-by-field (see
        // HostContext.body) — mass assignment reachable by any unauthenticated request. It never
        // reaches the global Object.prototype (Object.assign is shallow) and the declared-CRUD
        // allowlist stops it from becoming a write, but a hand-written handler reading
        // `ctx.body.<field>` directly (the recommended pattern) is exposed. "__proto__" can never
        // be a declared field — the emitter's identifier grammar forbids a leading underscore —
        // so dropping it changes no legitimate body, exactly as the field allowlist silently
        // drops what is not the caller's to set.
        for (const key of Object.keys(parsed)) {
          if (key === "__proto__") continue;
          body[key] = (parsed as Record<string, unknown>)[key];
        }
      }
    }
    // The convenience merge, unchanged in precedence: query < body < path params.
    const args: Record<string, unknown> = { ...query, ...body, ...params };

    const handler = config.handlers[route.chain]?.[route.action];
    if (typeof handler !== "function") {
      return failure(500, "unknown_action", `route "${route.key}" names ${route.chain}.${route.action}, which is not a registered handler`);
    }
    const correlationId = newCorrelationId();
    const context: HostContext = {
      buildInfo: ctx?.buildInfo ?? configBuildInfo,
      identity,
      env: ctx?.env ?? ((): undefined => undefined),
      query,
      body,
      params,
      correlationId,
      trace: ctx?.trace ?? readTraceContext(req.headers),
      request: req,
    };
    let data: unknown;
    try {
      data = await handler(args, context);
    } catch (e) {
      // The exception NEVER reaches the client: it carries stack frames, SQL text and sometimes
      // secrets. The caller gets a reason + the correlation id; the detail goes to the sink.
      onError({ correlationId, route: route.key, error: e, trace: context.trace });
      return failure(500, "handler_failed", "internal error", { "x-dsx-correlation-id": correlationId, ...rateAdvisory });
    }
    try {
      // A handler that returns a RESPONSE has produced the whole answer, and the host adds nothing
      // but the budget advisory. Two declared planes cannot work any other way: an inbound webhook
      // must answer 401 on a bad signature (a refusal is not a 200 carrying a sad value), and a
      // subscription must answer a streaming body that is still open when this line returns. The
      // alternative is a side-channel on ctx for "actually, use this status", which is the same
      // capability with a worse shape.
      if (data instanceof Response) {
        if (rateAdvisory !== undefined) for (const [k, v] of Object.entries(rateAdvisory)) data.headers.set(k, v);
        return data;
      }
      // The handler's value IS the body. `undefined` is not JSON, so it goes out as `null`
      // rather than an empty response — a reader must never have to distinguish "no body"
      // from "the handler returned nothing".
      return json(200, data === undefined ? null : data, rateAdvisory);
    } catch (e) {
      onError({ correlationId, route: route.key, error: e, trace: context.trace });
      return failure(500, "handler_failed", "internal error", { "x-dsx-correlation-id": correlationId, ...rateAdvisory });
    }
  }

  async function handle(req: Request, ctx?: Partial<HostContext>): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const pathSegments = splitPath(url.pathname);
    const allowed: string[] = [];
    for (const compiled of table) {
      const params = matchPath(compiled, pathSegments);
      if (params === null) continue;
      if (compiled.method !== method) {
        // An INTERNAL route (reach: []) must not advertise itself here. The reach gate in
        // dispatch() answers non-service callers with the same 404 an absent route returns —
        // "never 403, which would confirm the endpoint exists to a prober" — but the method
        // check runs FIRST, so a wrong-method probe got a 405 naming the allowed verb. An
        // unauthenticated `GET /internal/webhooks/drain` therefore disclosed both that the
        // endpoint exists and that it is a POST, while the gate it was meant to sit behind
        // held perfectly. Internal routes contribute nothing to `allowed`, so they fall
        // through to the same 404 as a path that matches nothing at all.
        if (compiled.route.reach?.length === 0) continue;
        if (!allowed.includes(compiled.method)) allowed.push(compiled.method);
        continue; // a later route (e.g. the :param twin) may still serve this method
      }
      return dispatch(compiled, params, req, url, method, ctx);
    }
    if (allowed.length > 0) {
      allowed.sort();
      return failure(
        405,
        "method_not_allowed",
        `${method} is not allowed for ${url.pathname} (allowed: ${allowed.join(", ")})`,
        { allow: allowed.join(", ") },
      );
    }
    return failure(404, "unknown_route", `no route matches ${method} ${url.pathname}`);
  }

  return { handle };
}
