//
//  trace.test.ts — W3C trace context: adopted from the caller, propagated to the callee, and
//  incapable of failing a request no matter what arrives on the header.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHost, type HostContext, type ServerRoute } from "../src/host.ts";
import { readTraceContext, traceHeaders, traceparentHeader } from "../src/trace.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";

test("trace: a valid traceparent is ADOPTED — the trace id survives the hop", () => {
  const trace = readTraceContext(new Headers({ traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` }));
  assert.equal(trace.traceId, TRACE_ID);
  assert.equal(trace.parentSpanId, PARENT_ID);
  assert.equal(trace.sampled, true);
  assert.notEqual(trace.spanId, PARENT_ID, "this hop must mint its OWN span id");
  assert.match(trace.spanId, /^[0-9a-f]{16}$/);
});

test("trace: the caller's sampling decision is preserved rather than re-decided", () => {
  assert.equal(readTraceContext(new Headers({ traceparent: `00-${TRACE_ID}-${PARENT_ID}-00` })).sampled, false);
  assert.equal(readTraceContext(new Headers({ traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` })).sampled, true);
});

test("trace: no header starts a NEW trace, and never fails", () => {
  const trace = readTraceContext(new Headers());
  assert.match(trace.traceId, /^[0-9a-f]{32}$/);
  assert.equal(trace.parentSpanId, null);
  assert.equal(trace.traceState, null);
});

test("trace: a malformed, wrong-version or all-zero header starts a new trace instead of adopting it", () => {
  const bogus = [
    "garbage",
    `01-${TRACE_ID}-${PARENT_ID}-01`, // a version this code does not implement
    `00-${TRACE_ID}-${PARENT_ID}`, // truncated
    `00-${"0".repeat(32)}-${PARENT_ID}-01`, // all-zero trace id: invalid per spec
    `00-${TRACE_ID}-${"0".repeat(16)}-01`, // all-zero parent id: invalid per spec
    `00-${TRACE_ID.toUpperCase()}-${PARENT_ID}-0z`,
    "",
  ];
  for (const raw of bogus) {
    const trace = readTraceContext(new Headers({ traceparent: raw }));
    assert.equal(trace.parentSpanId, null, `"${raw}" was adopted as a parent`);
    assert.match(trace.traceId, /^[0-9a-f]{32}$/);
    assert.notEqual(trace.traceId, "0".repeat(32));
  }
});

test("trace: an uppercase but otherwise valid header is normalised, not rejected", () => {
  const trace = readTraceContext(new Headers({ traceparent: `00-${TRACE_ID.toUpperCase()}-${PARENT_ID.toUpperCase()}-01` }));
  assert.equal(trace.traceId, TRACE_ID, "hex is case-insensitive on the wire and lowercase in logs");
});

test("trace: tracestate is passed through, and an oversized one is dropped rather than forwarded", () => {
  const kept = readTraceContext(new Headers({ traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`, tracestate: "vendor=abc" }));
  assert.equal(kept.traceState, "vendor=abc");
  assert.deepEqual(traceHeaders(kept), { traceparent: traceparentHeader(kept), tracestate: "vendor=abc" });

  const huge = readTraceContext(new Headers({ traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`, tracestate: "v=" + "x".repeat(600) }));
  assert.equal(huge.traceState, null);
  assert.deepEqual(Object.keys(traceHeaders(huge)), ["traceparent"]);
});

test("trace: the OUTBOUND header names THIS server's span as the parent", () => {
  const trace = readTraceContext(new Headers({ traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` }));
  assert.equal(traceparentHeader(trace), `00-${TRACE_ID}-${trace.spanId}-01`);
});

test("trace: two requests on the same trace share the trace id and differ in span id", () => {
  const headers = new Headers({ traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` });
  const a = readTraceContext(headers);
  const b = readTraceContext(headers);
  assert.equal(a.traceId, b.traceId);
  assert.notEqual(a.spanId, b.spanId, "two spans on one trace collided");
});

// ── the host seam ───────────────────────────────────────────────────────────────────────

const ROUTE: ServerRoute = { key: "echo", chain: "server.http", action: "echo", method: "GET", path: "/echo", reach: ["web"] };

test("trace: a handler receives the adopted trace on ctx", async () => {
  let seen: HostContext["trace"] | null = null;
  const server = createHost({
    routes: [ROUTE],
    handlers: { "server.http": { echo: (_args, ctx) => { seen = ctx.trace; return {}; } } },
  });
  await server.handle(new Request("https://x/echo", { headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` } }));
  assert.equal(seen!.traceId, TRACE_ID);
  assert.equal(seen!.parentSpanId, PARENT_ID);
});

test("trace: the trace id reaches the failure sink alongside the correlation id", async () => {
  const reported: { correlationId: string; trace?: { traceId: string } }[] = [];
  const server = createHost({
    routes: [ROUTE],
    handlers: { "server.http": { echo: () => { throw new Error("boom"); } } },
    onError: (info) => reported.push(info),
  });
  const response = await server.handle(new Request("https://x/echo", { headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` } }));

  assert.equal(response.status, 500);
  assert.equal(reported[0]!.trace?.traceId, TRACE_ID, "the log line cannot be joined to the caller's without this");
  assert.equal(response.headers.get("x-dsx-correlation-id"), reported[0]!.correlationId);
  // …and the trace id is NOT handed to the client: it is a server-side join key, and echoing it
  // would let a caller confirm which of its requests reached which backend.
  assert.equal(response.headers.get("traceparent"), null);
});

test("trace: a garbage traceparent does not fail the request", async () => {
  const server = createHost({ routes: [ROUTE], handlers: { "server.http": { echo: () => ({ ok: true }) } } });
  const response = await server.handle(new Request("https://x/echo", { headers: { traceparent: "not-a-trace" } }));
  assert.equal(response.status, 200, "a diagnostics header must never be able to fail a request");
});
