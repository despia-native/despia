//
//  websocket-facet.test.ts — Core/WebSocket's web lane. The browser HAS a WebSocket, so the facet
//  is a real implementation of the six declared verbs and is held to the SAME contract the native
//  twins carry: the backoff ladder, the queue that survives a drop, the ack that ends a replay, and
//  the refusals that replaced the silent no-ops.
//
//  The ladder runs on a VIRTUAL clock — a stubbed timer and a stubbed random — because the real one
//  reaches 30 s on the fifth attempt and a suite that waits for it is a suite nobody runs.
//

import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The facet under test ships in ClosedSource; an open drop skips LOUDLY, per test, with the reason.
const hasClosedSource = existsSync(fileURLToPath(new URL("../../../../../ClosedSource", import.meta.url)));
const test: typeof nodeTest = hasClosedSource
  ? nodeTest
  : (((name: string) => nodeTest(name, (t) => t.skip("open drop without ClosedSource - Core/WebSocket's web facet ships closed"))) as typeof nodeTest);
// `.default`, like `dom-facet` and `scene-bus` next door, and the backoff curve comes off the
// module object rather than the namespace: TypeScript models these facets as CommonJS (no
// `"type"` in any package.json above them), so a named export is invisible to it and the
// declaration beside the facet is an `export =`. Without that declaration the untyped `.js` is
// an implicit `any` the typecheck refuses (TS7016) - which is what it was.
const facet = hasClosedSource
  ? (await import("../../../../../ClosedSource/DSX/Modules/Core/WebSocket/web/index.js")).default
  : (undefined as never);
const backoffDelayMs = hasClosedSource ? facet.backoffDelayMs : (undefined as never);

// ── the harness ──────────────────────────────────────────────────────────────────────────

type Settled = { ok?: unknown; code?: string; message?: string };

/** One action call. `fail` records rather than throws, because the facet returns null after it. */
function call(action: string, args: Record<string, unknown>): { value: unknown; settled: Settled;
                                                                events: Record<string, unknown>[];
                                                                state: Map<string, unknown> } {
  const settled: Settled = {};
  const events: Record<string, unknown>[] = [];
  const state = new Map<string, unknown>();
  const dsx = {
    state: { set(k: string, v: unknown): void { state.set(k, v); } },
    broadcast(name: string, value: unknown): void { events.push({ name, ...(value as object) }); },
    log(): void { /* diagnostics are not assertions */ },
  };
  const ctx = {
    args(key: string): unknown { return args[key]; },
    fail(code: string, message: string): void { settled.code = code; settled.message = message; },
    dsx,
  };
  const value = facet.actions[action](ctx);
  return { value, settled, events, state };
}

/** A stand-in socket the facet drives exactly as it drives a real one. */
class FakeSocket {
  static live: FakeSocket[] = [];
  url: string;
  protocols: string[];
  protocol = "";
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols ?? [];
    FakeSocket.live.push(this);
  }
  send(payload: string): void { this.sent.push(payload); }
  close(code?: number, reason?: string): void { this.closed = { code: code ?? 1000, reason: reason ?? "" }; }
}

const realWebSocket = globalThis.WebSocket;
const realSetTimeout = globalThis.setTimeout;
type Pending = { fn: () => void; delay: number };
let pending: Pending[] = [];

function installFakes(): void {
  FakeSocket.live = [];
  pending = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  (globalThis as { setTimeout?: unknown }).setTimeout = ((fn: () => void, delay: number) => {
    pending.push({ fn, delay });
    return pending.length;
  }) as unknown as typeof setTimeout;
}

function restoreFakes(): void {
  (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
  (globalThis as { setTimeout?: unknown }).setTimeout = realSetTimeout;
}

// ── the ladder ───────────────────────────────────────────────────────────────────────────

test("the backoff ladder is min(2^attempt, 30) seconds with full jitter", () => {
  // Full jitter: the delay is uniform on [0, base], so random=1 IS the ceiling and random=0 is an
  // immediate retry. The cap lands on attempt 5 (2^5 = 32 > 30) and never moves again.
  assert.equal(backoffDelayMs(1, 1), 2_000);
  assert.equal(backoffDelayMs(2, 1), 4_000);
  assert.equal(backoffDelayMs(3, 1), 8_000);
  assert.equal(backoffDelayMs(4, 1), 16_000);
  assert.equal(backoffDelayMs(5, 1), 30_000);
  assert.equal(backoffDelayMs(9, 1), 30_000);
  assert.equal(backoffDelayMs(3, 0), 0);
  assert.equal(backoffDelayMs(3, 0.5), 4_000);
});

test("a drop schedules a reconnect on the ladder and reports the attempt", () => {
  installFakes();
  const realRandom = Math.random;
  Math.random = () => 1;
  try {
    call("connect", { id: "ladder", url: "wss://example.com/s" });
    const socket = FakeSocket.live[0]!;
    socket.onopen!();
    socket.onclose!({ code: 1006, reason: "", wasClean: false });

    const scheduled = pending.at(-1)!;
    assert.equal(scheduled.delay, 2_000, "first reconnect rides attempt 1 of the ladder");

    scheduled.fn();                         // the retry fires on the virtual clock
    FakeSocket.live[1]!.onclose!({ code: 1006, reason: "", wasClean: false });
    assert.equal(pending.at(-1)!.delay, 4_000, "the second attempt doubles");
  } finally {
    Math.random = realRandom;
    restoreFakes();
  }
});

// ── the verbs ────────────────────────────────────────────────────────────────────────────

test("connect opens a real socket and publishes the connection plane", () => {
  installFakes();
  try {
    const { value, state } = call("connect", { id: "feed", url: "wss://example.com/s", protocols: "graphql-ws" });
    assert.deepEqual(value, { ok: true, id: "feed" });
    assert.equal(FakeSocket.live[0]!.url, "wss://example.com/s");
    assert.deepEqual(FakeSocket.live[0]!.protocols, ["graphql-ws"]);
    assert.equal(state.get("connection"), "feed");
    assert.equal(state.get("state"), "connecting");

    const opened = call("status", { id: "feed" });
    assert.equal((opened.value as { state: string }).state, "connecting");
  } finally { restoreFakes(); }
});

test("connect refuses a missing url and a non-websocket scheme", () => {
  installFakes();
  try {
    assert.equal(call("connect", { id: "feed" }).settled.code, "missing_param");
    assert.equal(call("connect", { id: "feed", url: "https://example.com/s" }).settled.code, "invalid_param");
    assert.equal(FakeSocket.live.length, 0, "neither refusal opened a socket");
  } finally { restoreFakes(); }
});

test("send queues while down and flushes FIFO on the next open", () => {
  installFakes();
  try {
    call("connect", { id: "q", url: "wss://example.com/s" });
    call("send", { id: "q", payload: "one" });
    call("send", { id: "q", payload: "two" });
    assert.equal((call("status", { id: "q" }).value as { pendingOutbound: number }).pendingOutbound, 2);

    FakeSocket.live[0]!.onopen!();
    assert.deepEqual(FakeSocket.live[0]!.sent, ["one", "two"]);
    assert.equal((call("status", { id: "q" }).value as { pendingOutbound: number }).pendingOutbound, 0);
  } finally { restoreFakes(); }
});

test("the subscribe frame is replayed FIRST on every open", () => {
  installFakes();
  try {
    call("connect", { id: "sub", url: "wss://example.com/s" });
    call("subscribe", { id: "sub", frame: "{\"op\":\"resume\"}" });
    call("send", { id: "sub", payload: "after" });
    FakeSocket.live[0]!.onopen!();
    assert.deepEqual(FakeSocket.live[0]!.sent, ["{\"op\":\"resume\"}", "after"]);
  } finally { restoreFakes(); }
});

test("an un-acked message replays on reconnect and stops once acked", () => {
  installFakes();
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    call("connect", { id: "dur", url: "wss://example.com/s" });
    const socket = FakeSocket.live[0]!;
    socket.onopen!();
    socket.onmessage!({ data: "{\"hello\":1}" });
    assert.equal((call("status", { id: "dur" }).value as { unacked: number }).unacked, 1);

    socket.onclose!({ code: 1006, reason: "", wasClean: false });
    pending.at(-1)!.fn();
    const reconnected = FakeSocket.live[1]!;
    const before = call("status", { id: "dur" });
    reconnected.onopen!();
    assert.equal((before.value as { unacked: number }).unacked, 1, "the record survives the drop");

    call("ack", { id: "dur", message_id: "dur:1" });
    assert.equal((call("status", { id: "dur" }).value as { unacked: number }).unacked, 0);
  } finally {
    Math.random = realRandom;
    restoreFakes();
  }
});

test("a JSON text frame is delivered parsed, a bare scalar stays text", () => {
  installFakes();
  try {
    const opened = call("connect", { id: "shape", url: "wss://example.com/s" });
    const socket = FakeSocket.live[0]!;
    socket.onopen!();
    socket.onmessage!({ data: "{\"a\":1}" });
    socket.onmessage!({ data: "42" });
    const messages = opened.events.filter((e) => e["type"] === "message");
    assert.equal(messages.at(-2)!["dataType"], "json");
    assert.deepEqual(messages.at(-2)!["payload"], { a: 1 });
    assert.equal(messages.at(-1)!["dataType"], "text");
    assert.equal(messages.at(-1)!["payload"], "42");
  } finally { restoreFakes(); }
});

test("every verb answers a declared refusal rather than a silent no-op", () => {
  installFakes();
  try {
    for (const verb of ["subscribe", "send", "disconnect", "status", "ack"]) {
      assert.equal(call(verb, { id: "ghost", message_id: "x", frame: "f", payload: "p" }).settled.code,
                   "not_found", `${verb} on an unknown id`);
    }
    call("connect", { id: "live", url: "wss://example.com/s" });
    assert.equal(call("ack", { id: "live" }).settled.code, "missing_param",
                 "ack used to return silently on a missing message_id");
    assert.equal(call("send", { id: "live" }).settled.code, "missing_param");
    assert.equal(call("subscribe", { id: "live" }).settled.code, "missing_param");
  } finally { restoreFakes(); }
});

test("disconnect stands down auto-reconnect and reports a clean close", () => {
  installFakes();
  try {
    const opened = call("connect", { id: "bye", url: "wss://example.com/s" });
    FakeSocket.live[0]!.onopen!();
    const result = call("disconnect", { id: "bye" });
    assert.deepEqual(result.value, { ok: true, id: "bye" });
    assert.deepEqual(FakeSocket.live[0]!.closed, { code: 1001, reason: "client_shutdown" });
    assert.equal(result.state.get("state"), "closed");
    assert.equal(result.state.get("lastCloseCode"), 1001);
    assert.equal(result.state.get("lastCloseReason"), "client_shutdown");
    assert.ok(opened.events.length > 0);
  } finally { restoreFakes(); }
});
