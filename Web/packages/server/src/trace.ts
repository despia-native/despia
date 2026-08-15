//
//  trace.ts — W3C Trace Context (traceparent / tracestate), so one user action can be followed
//  across the hops it actually took.
//
//  WHAT WAS ALREADY HERE AND WHY IT IS NOT ENOUGH. `host.ts` mints a `correlationId` per request
//  and returns it on a failure, which ties a client-visible error to one server log line. That is
//  the whole of it: the id is created at the edge of THIS server and dies at its other edge. When
//  a page calls the API, the API calls a third-party through `<api via="server">`, and that call
//  fails, three systems logged three unrelated ids and nothing joins them. Reconstructing the
//  request means matching timestamps by eye.
//
//  A trace id is the same idea with the one property that makes it useful: it is ADOPTED from the
//  caller rather than invented, and PROPAGATED to the callee. Every hop logs the same trace id and
//  its own span id, so the sequence is recoverable by grep rather than by inference.
//
//  W3C rather than a private header, because the format is what every collector already parses,
//  and because the value arriving on our door was very likely minted by something we do not own.
//
//      traceparent: 00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>
//
//  A MALFORMED OR ABSENT HEADER IS NOT AN ERROR. It means "this is the first hop", and the answer
//  is a fresh trace, never a refusal: trace context is diagnostics, and a diagnostics header must
//  never be able to fail a request. That is also why nothing here throws.
//
//  THE INBOUND VALUE IS UNTRUSTED and is treated as such — validated to the exact grammar,
//  length-checked, never interpolated anywhere, and `tracestate` is passed through with a hard cap
//  rather than parsed. It decides nothing: no authorization, no routing, no rate-limit bucket. It
//  is a label carried in logs, and a caller who forges one has forged their own log label.
//

/** The request's position in a distributed trace. */
export interface TraceContext {
  /** 32 lowercase hex — the id shared by every hop of this operation */
  traceId: string;
  /** 16 lowercase hex — THIS server's span */
  spanId: string;
  /** the caller's span id, or null when this is the first hop */
  parentSpanId: string | null;
  /** the caller's sampling decision (flags bit 0), preserved rather than re-decided */
  sampled: boolean;
  /** vendor state, passed through verbatim and capped; null when absent */
  traceState: string | null;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZERO_TRACE = "0".repeat(32);
const ALL_ZERO_SPAN = "0".repeat(16);

/** The spec's own ceiling on `tracestate`; beyond it a collector is required to drop entries, so
 *  carrying more is bytes on every hop that nothing will read. */
const MAX_TRACESTATE_BYTES = 512;

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(buffer);
  else for (let i = 0; i < bytes; i++) buffer[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (const b of buffer) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Read the trace context off an inbound request, or start a new trace.
 *
 * The all-zero trace id and the all-zero parent id are rejected by the spec as invalid, and both
 * turn up in practice from misconfigured instrumentation. Adopting one would merge every such
 * request into a single enormous trace, which is worse than starting fresh.
 */
export function readTraceContext(headers: Headers): TraceContext {
  const spanId = randomHex(8);
  const raw = headers.get("traceparent");
  const match = raw === null ? null : TRACEPARENT.exec(raw.trim().toLowerCase());
  if (match === null || match[1] === ALL_ZERO_TRACE || match[2] === ALL_ZERO_SPAN) {
    return { traceId: randomHex(16), spanId, parentSpanId: null, sampled: true, traceState: null };
  }
  const state = headers.get("tracestate");
  return {
    traceId: match[1]!,
    spanId,
    parentSpanId: match[2]!,
    sampled: (Number.parseInt(match[3]!, 16) & 0x01) === 1,
    traceState: state !== null && state !== "" && state.length <= MAX_TRACESTATE_BYTES ? state : null,
  };
}

/** The header value to send on an OUTBOUND call, naming this server's span as the parent. */
export function traceparentHeader(trace: TraceContext): string {
  return `00-${trace.traceId}-${trace.spanId}-${trace.sampled ? "01" : "00"}`;
}

/** Every trace header an outbound request should carry, ready to spread into a HeadersInit. */
export function traceHeaders(trace: TraceContext): Record<string, string> {
  const headers: Record<string, string> = { traceparent: traceparentHeader(trace) };
  if (trace.traceState !== null) headers["tracestate"] = trace.traceState;
  return headers;
}
