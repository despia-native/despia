//
//  webhook.test.ts — the INBOUND webhook boundary.
//
//  Every assertion here corresponds to a way a webhook receiver is silently wrong in production.
//  The signature checks are the obvious half; the ones that matter more are the negatives that
//  LOOK like they pass — a receiver that verifies the re-serialised body accepts almost every
//  legitimate delivery and is trivially forgeable, and a receiver with a clock window but no
//  nonce is replayable at will inside it. Both are proven refused here rather than assumed.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { QueueSeam, type QueueEnqueueRequest } from "../src/queue.ts";
import {
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  receiveWebhook,
  statusFor,
  verifyWebhook,
  webhookResponse,
  type WebhookSource,
} from "../src/webhook.ts";

const SECRET = "whsec_a_very_long_shared_signing_secret_value";
const NOW = 1_760_000_000_000; // fixed clock; nothing here reads the wall clock

function source(over: Partial<WebhookSource> = {}): WebhookSource {
  return { name: "acme", secrets: [SECRET], queue: "webhooks", ...over };
}

async function signature(secret: string, timestampSeconds: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestampSeconds}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function headersFor(body: string, over: { secret?: string; atSeconds?: number } = {}): Promise<Headers> {
  const ts = over.atSeconds ?? Math.floor(NOW / 1000);
  return new Headers({
    "x-dsx-signature": await signature(over.secret ?? SECRET, ts, body),
    "x-dsx-timestamp": String(ts),
  });
}

/** A queue that records what it was handed and enforces the UNIQUE key, as the real table does. */
function installQueue(): { enqueues: QueueEnqueueRequest[] } {
  const enqueues: QueueEnqueueRequest[] = [];
  const keys = new Set<string>();
  QueueSeam.transport = {
    enqueue: async (request) => {
      enqueues.push(request);
      if (keys.has(request.key)) return { id: null, duplicate: true };
      keys.add(request.key);
      return { id: `id-${keys.size}`, duplicate: false };
    },
    claim: async () => [],
    settle: async () => ({ acked: 0, released: 0 }),
    deadLetter: async () => 0,
    listDeadLetters: async () => [],
    replayDeadLetters: async () => 0,
  };
  return { enqueues };
}

// ── the signature ───────────────────────────────────────────────────────────────────────

test("webhook: a correctly signed delivery verifies", async () => {
  const body = JSON.stringify({ id: "evt_1", type: "charge.ok" });
  const verdict = await verifyWebhook(source(), await headersFor(body), body, { nowMs: NOW });
  assert.equal(verdict.ok, true);
});

test("webhook: a body altered after signing is REFUSED", async () => {
  const body = JSON.stringify({ amount: 100 });
  const headers = await headersFor(body);
  const verdict = await verifyWebhook(source(), headers, JSON.stringify({ amount: 1_000_000 }), { nowMs: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.refusal, "bad_signature");
});

test("webhook: THE RAW BYTES are what is signed — a re-serialised body does not verify", async () => {
  //  The single most common way a webhook verifier is wrong. `{"a":1, "b":2}` and
  //  `JSON.stringify(JSON.parse(...))` are the same VALUE and different BYTES, so a verifier
  //  handed the round-tripped body rejects legitimate deliveries — and the usual "fix" is to stop
  //  checking. Pinning it here means the failure is a test, not a production incident.
  const raw = '{"a":1,  "b":2}';
  const headers = await headersFor(raw);
  assert.equal((await verifyWebhook(source(), headers, raw, { nowMs: NOW })).ok, true);
  const reserialised = JSON.stringify(JSON.parse(raw));
  assert.notEqual(reserialised, raw, "the fixture must actually differ in bytes, or this proves nothing");
  assert.equal((await verifyWebhook(source(), headers, reserialised, { nowMs: NOW })).ok, false);
});

test("webhook: a source with no secret refuses everything, and says so distinctly", async () => {
  const body = "{}";
  const verdict = await verifyWebhook(source({ secrets: [] }), await headersFor(body), body, { nowMs: NOW });
  assert.equal(verdict.ok === false && verdict.refusal, "not_configured");
  assert.equal(statusFor("not_configured"), 404, "an unconfigured source must not be distinguishable from an absent one");
});

test("webhook: a missing signature or timestamp is refused before any hashing", async () => {
  const body = "{}";
  const noSig = await verifyWebhook(source(), new Headers({ "x-dsx-timestamp": "1" }), body, { nowMs: NOW });
  assert.equal(noSig.ok === false && noSig.refusal, "missing_signature");
  const noTs = await verifyWebhook(source(), new Headers({ "x-dsx-signature": "a".repeat(64) }), body, { nowMs: NOW });
  assert.equal(noTs.ok === false && noTs.refusal, "missing_timestamp");
});

test("webhook: a signature that is not a sha256 hex digest is refused on shape", async () => {
  const body = "{}";
  for (const bogus of ["not-hex", "A".repeat(64), "ab".repeat(40), ""]) {
    const headers = new Headers({ "x-dsx-signature": bogus, "x-dsx-timestamp": String(Math.floor(NOW / 1000)) });
    const verdict = await verifyWebhook(source(), headers, body, { nowMs: NOW });
    assert.equal(verdict.ok, false, `"${bogus}" was accepted`);
  }
});

// ── the clock window ────────────────────────────────────────────────────────────────────

test("webhook: a delivery older than the tolerance is refused even though it verifies", async () => {
  const body = "{}";
  const old = Math.floor((NOW - DEFAULT_WEBHOOK_TOLERANCE_MS - 1000) / 1000);
  const headers = await headersFor(body, { atSeconds: old });
  const verdict = await verifyWebhook(source(), headers, body, { nowMs: NOW });
  assert.equal(verdict.ok === false && verdict.refusal, "expired_timestamp");
});

test("webhook: a delivery signed in the future is refused", async () => {
  const body = "{}";
  const ahead = Math.floor((NOW + DEFAULT_WEBHOOK_TOLERANCE_MS + 60_000) / 1000);
  const verdict = await verifyWebhook(source(), await headersFor(body, { atSeconds: ahead }), body, { nowMs: NOW });
  assert.equal(verdict.ok === false && verdict.refusal, "future_timestamp");
});

test("webhook: the timestamp is inside the signed string — moving it invalidates the signature", async () => {
  //  If the timestamp were not signed, an attacker replays a captured body with the header set to
  //  now and the window stops meaning anything. This is that attack, and it must fail.
  const body = JSON.stringify({ id: "evt_9" });
  const captured = Math.floor((NOW - DEFAULT_WEBHOOK_TOLERANCE_MS - 60_000) / 1000);
  const headers = await headersFor(body, { atSeconds: captured });
  headers.set("x-dsx-timestamp", String(Math.floor(NOW / 1000))); // rewritten to "now"
  const verdict = await verifyWebhook(source(), headers, body, { nowMs: NOW });
  assert.equal(verdict.ok === false && verdict.refusal, "bad_signature");
});

test("webhook: a non-integer timestamp is refused, and Number() coercions do not sneak through", async () => {
  const body = "{}";
  for (const bogus of ["0x10", " 12 ", "1e9", "12.5", "abc", ""]) {
    const headers = new Headers({ "x-dsx-signature": "a".repeat(64), "x-dsx-timestamp": bogus });
    const verdict = await verifyWebhook(source(), headers, body, { nowMs: NOW });
    assert.equal(verdict.ok, false, `"${bogus}" was accepted as a timestamp`);
  }
});

// ── secret rotation ─────────────────────────────────────────────────────────────────────

test("webhook: BOTH secrets verify during a rotation window", async () => {
  const body = JSON.stringify({ id: "evt_rot" });
  const next = "whsec_the_replacement_signing_secret_value_x";
  const rotating = source({ secrets: [next, SECRET] });

  assert.equal((await verifyWebhook(rotating, await headersFor(body, { secret: SECRET }), body, { nowMs: NOW })).ok, true);
  assert.equal((await verifyWebhook(rotating, await headersFor(body, { secret: next }), body, { nowMs: NOW })).ok, true);
  // …and once the old one is dropped, deliveries signed with it stop verifying.
  const rotated = source({ secrets: [next] });
  assert.equal((await verifyWebhook(rotated, await headersFor(body, { secret: SECRET }), body, { nowMs: NOW })).ok, false);
});

// ── replay defense ──────────────────────────────────────────────────────────────────────

test("webhook: the delivery is enqueued onto the source's DECLARED QUEUE, not its name", async () => {
  //  Regression. These are two different strings and the wrong one type-checks perfectly, so the
  //  only thing that catches it is asserting the queue: live, it surfaced as every verified
  //  delivery answering 500 with `the queue table for "acme" is missing`.
  const queue = installQueue();
  const body = JSON.stringify({ id: "evt_queue" });
  const headers = await headersFor(body);
  await receiveWebhook(source({ name: "acme", queue: "webhooks" }), new Request("https://x/h", { method: "POST", headers, body }), { nowMs: NOW });
  assert.equal(queue.enqueues[0]!.queue, "webhooks");
});

test("webhook: an IDENTICAL delivery replayed inside the window is stored ONCE", async () => {
  const queue = installQueue();
  const body = JSON.stringify({ id: "evt_replay", amount: 42 });
  const headers = await headersFor(body);
  const request = (): Request => new Request("https://x/hooks/acme", { method: "POST", headers, body });

  const first = await receiveWebhook(source(), request(), { nowMs: NOW });
  assert.equal(first.accepted && first.duplicate, false);

  const second = await receiveWebhook(source(), request(), { nowMs: NOW });
  assert.equal(second.accepted, true, "a replay must be a SUCCESS, or the sender retries forever");
  assert.equal(second.accepted && second.duplicate, true);
  assert.equal(queue.enqueues.length, 2);
  assert.equal(queue.enqueues[0]!.key, queue.enqueues[1]!.key, "the same delivery must produce the same key");
});

test("webhook: the sender's own event id collapses two DIFFERENTLY SIGNED deliveries of one event", async () => {
  //  A sender that retries by re-signing produces a different signature for the same event. Only
  //  the declared id field can collapse those, which is why `idField` exists at all.
  const queue = installQueue();
  const declared = source({ idField: "data.id" });
  const body = JSON.stringify({ data: { id: "evt_77" } });

  const early = await headersFor(body, { atSeconds: Math.floor(NOW / 1000) - 30 });
  const late = await headersFor(body, { atSeconds: Math.floor(NOW / 1000) });
  assert.notEqual(early.get("x-dsx-signature"), late.get("x-dsx-signature"));

  const a = await receiveWebhook(declared, new Request("https://x/h", { method: "POST", headers: early, body }), { nowMs: NOW });
  const b = await receiveWebhook(declared, new Request("https://x/h", { method: "POST", headers: late, body }), { nowMs: NOW });
  assert.equal(a.accepted && a.duplicate, false);
  assert.equal(b.accepted && b.duplicate, true);
  assert.equal(queue.enqueues[0]!.key, "acme:evt_77");
});

test("webhook: the key namespaces the SOURCE — two senders cannot swallow each other's events", async () => {
  const queue = installQueue();
  const body = JSON.stringify({ id: "1" });
  const acme = source({ name: "acme", idField: "id" });
  const other = source({ name: "globex", idField: "id" });

  const a = await receiveWebhook(acme, new Request("https://x/h", { method: "POST", headers: await headersFor(body), body }), { nowMs: NOW });
  const b = await receiveWebhook(other, new Request("https://x/h", { method: "POST", headers: await headersFor(body), body }), { nowMs: NOW });
  assert.equal(a.accepted && a.duplicate, false);
  assert.equal(b.accepted && b.duplicate, false, "globex's event 1 was swallowed by acme's");
  assert.deepEqual(queue.enqueues.map((e) => e.key), ["acme:1", "globex:1"]);
});

// ── the receiver ────────────────────────────────────────────────────────────────────────

test("webhook: a refused delivery never reaches the queue", async () => {
  const queue = installQueue();
  const body = JSON.stringify({ id: "evt_bad" });
  const headers = await headersFor(body, { secret: "whsec_not_the_configured_secret_at_all_xx" });
  const outcome = await receiveWebhook(source(), new Request("https://x/h", { method: "POST", headers, body }), { nowMs: NOW });

  assert.equal(outcome.accepted, false);
  assert.equal(outcome.accepted === false && outcome.status, 401);
  assert.equal(queue.enqueues.length, 0, "an unverified body was stored");
});

test("webhook: an oversized body is refused against the STREAM, not the declared length", async () => {
  installQueue();
  const body = "x".repeat(4096);
  const headers = await headersFor(body);
  // Content-Length omitted deliberately: a client that lies about it must still be capped.
  const req = new Request("https://x/h", { method: "POST", headers, body });
  const outcome = await receiveWebhook(source(), req, { nowMs: NOW, maxBodyBytes: 1024 });
  assert.equal(outcome.accepted === false && outcome.refusal, "body_too_large");
  assert.equal(outcome.accepted === false && outcome.status, 413);
});

test("webhook: a QUEUE failure is NOT reported as acceptance — the sender must retry", async () => {
  QueueSeam.transport = null; // no provider: the receiver's fault, not the sender's
  const body = JSON.stringify({ id: "evt_q" });
  const headers = await headersFor(body);
  await assert.rejects(
    () => receiveWebhook(source(), new Request("https://x/h", { method: "POST", headers, body }), { nowMs: NOW }),
    /no queue provider is installed/,
    "answering 2xx here tells the sender the event is safe when it was dropped",
  );
});

test("webhook: the response is 200 for both a first delivery and its replay", async () => {
  installQueue();
  const body = JSON.stringify({ id: "evt_resp" });
  const headers = await headersFor(body);
  const req = (): Request => new Request("https://x/h", { method: "POST", headers, body });

  const first = webhookResponse(await receiveWebhook(source(), req(), { nowMs: NOW }));
  const second = webhookResponse(await receiveWebhook(source(), req(), { nowMs: NOW }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { accepted: true, duplicate: true });
});

test("webhook: a refusal response never echoes the body or the secret back", async () => {
  installQueue();
  const body = JSON.stringify({ card: "4111111111111111" });
  const headers = new Headers({ "x-dsx-signature": "b".repeat(64), "x-dsx-timestamp": String(Math.floor(NOW / 1000)) });
  const response = webhookResponse(await receiveWebhook(source(), new Request("https://x/h", { method: "POST", headers, body }), { nowMs: NOW }));
  const text = await response.text();
  assert.equal(response.status, 401);
  assert.ok(!text.includes("4111"), "the refusal echoed the request body");
  assert.ok(!text.includes(SECRET), "the refusal echoed the signing secret");
});
