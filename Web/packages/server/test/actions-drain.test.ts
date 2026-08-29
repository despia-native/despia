//
//  actions-drain.test.ts — `dsx.module.queue.<q>.drain({ action })`, the seam that lets a
//  `<worker>` body read the queue it was declared to drain.
//
//  WHY IT TAKES AN ACTION NAME. JSE has no function values, so a body cannot be handed a
//  callback the way `drainQueue` takes one. The alternative — a `claim` seam returning messages
//  for the body to loop over — would push the lease, per-message isolation, the
//  release-versus-dead-letter decision and the settle into every author's loop, which are the
//  four things drainQueue exists to get right once. Naming a sibling action keeps them in tested
//  TypeScript and leaves the author only the part that is theirs: what one message means.
//
//  So what is pinned here is the CONTRACT an author sees at that boundary. Return and the
//  message is acked. Throw and it goes back, until its attempts are spent and it dead-letters
//  with the reason still attached. One poison message must not cost the other nine, and a body
//  naming an action that does not exist must be refused BEFORE it claims anything — otherwise it
//  would claim the queue, fail every message, and park the lot.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHost, type HostConfig, type HostContext } from "../src/host.ts";
import { declaredHandler, type DeclaredAction } from "../src/actions.ts";
import { QueueSeam, type QueueMessage, type QueueSettleRequest } from "../src/queue.ts";

/** A transport with a real claim/settle, so the assertions below are about the drain's
 *  behaviour rather than a mock's opinion of it. */
function installQueue(messages: QueueMessage[]): {
  settled: QueueSettleRequest[];
  deadLettered: { id: string; reason: string }[];
  claims: number;
} {
  const settled: QueueSettleRequest[] = [];
  const deadLettered: { id: string; reason: string }[] = [];
  const state = { claims: 0 };
  QueueSeam.transport = {
    enqueue: async () => ({ id: "q1", duplicate: false }),
    claim: async (request) => {
      state.claims++;
      return messages.slice(0, request.limit);
    },
    settle: async (request) => {
      settled.push(request);
      return { acked: request.ack.length, released: request.release.length };
    },
    deadLetter: async (request) => {
      deadLettered.push(...request.entries);
      return request.entries.length;
    },
    listDeadLetters: async () => [],
    replayDeadLetters: async () => 0,
  };
  return { settled, deadLettered, get claims() { return state.claims; } };
}

function message(over: Partial<QueueMessage> & { id: string }): QueueMessage {
  return {
    key: `k-${over.id}`, payload: {}, attempt: 1,
    enqueuedAt: "2026-08-21T00:00:00.000Z", ...over,
  } as QueueMessage;
}

function workerHost(drainBody: string, siblings: Record<string, { body: string; inputs?: Record<string, string> }>): HostConfig {
  const spec: DeclaredAction = { chain: "platform", name: "drainEvents", body: drainBody, siblings };
  return {
    routes: [{
      key: "drain", chain: "platform", action: "drainEvents", method: "POST",
      path: "/internal/events/drain", auth: "required", worker: "platform_events", reach: [],
    }],
    handlers: { platform: { drainEvents: declaredHandler(spec) } },
    onError: () => {},
  };
}

/** A `dsx.module.*` call answers the standard envelope, so a body returning the drain result
 *  verbatim puts it under `data`. Unwrapped here rather than in every assertion. */
async function drain(cfg: HostConfig): Promise<{ status: number; body: Record<string, unknown> }> {
  const ctx: Partial<HostContext> = {
    identity: { sub: "svc", role: "service_role", token: "t" } as unknown as HostContext["identity"],
    env: () => undefined,
  };
  const res = await createHost(cfg).handle(
    new Request("http://fixture.test/internal/events/drain", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }),
    ctx,
  );
  const parsed = (await res.json()) as Record<string, unknown>;
  const data = parsed["data"];
  return {
    status: res.status,
    body: (typeof data === "object" && data !== null ? data : parsed) as Record<string, unknown>,
  };
}

const DRAIN = "return await dsx.module.queue.platform_events.drain({ action: 'handleEvent', limit: 10 })";

test("drain: every message runs the named action and is acked", async () => {
  const queue = installQueue([message({ id: "m1" }), message({ id: "m2" }), message({ id: "m3" })]);
  const { status, body } = await drain(workerHost(DRAIN, {
    handleEvent: { body: "return { seen: message.id }", inputs: { message: "message" } },
  }));

  assert.equal(status, 200);
  assert.equal(body.claimed, 3);
  assert.equal(body.drained, 3);
  assert.deepEqual(queue.settled[0]!.ack, ["m1", "m2", "m3"]);
  assert.deepEqual(queue.settled[0]!.release, []);
});

test("drain: the message reaches the body whole — id, key, payload, attempt", async () => {
  installQueue([message({ id: "m1", key: "orders:evt_9", payload: { source: "orders" }, attempt: 2 })]);
  const { body } = await drain(workerHost(
    "const r = await dsx.module.queue.platform_events.drain({ action: 'handleEvent' })\nreturn { drained: r.data.drained, saw: dsx.variable.saw }",
    { handleEvent: { body: "dsx.variable.saw = { id: message.id, key: message.key, source: message.payload.source, attempt: message.attempt }", inputs: { message: "message" } } },
  ));
  assert.equal(body.drained, 1);
  assert.deepEqual(body.saw, { id: "m1", key: "orders:evt_9", source: "orders", attempt: 2 });
});

test("drain: one poison message does not cost the other two", async () => {
  // The classic way a queue stops draining while every component reports healthy: an
  // exception on the first message aborts the pass, so the survivors are never acked either.
  const queue = installQueue([message({ id: "ok1" }), message({ id: "bad" }), message({ id: "ok2" })]);
  const { status, body } = await drain(workerHost(DRAIN, {
    handleEvent: {
      body: "if (message.id === 'bad') { throw { reason: 'unavailable', message: 'downstream is down' } }\nreturn { ok: true }",
      inputs: { message: "message" },
    },
  }));

  assert.equal(status, 200);
  assert.equal(body.claimed, 3);
  assert.equal(body.drained, 2, "the two good messages were acked");
  assert.deepEqual(queue.settled[0]!.ack, ["ok1", "ok2"]);
  assert.deepEqual(queue.settled[0]!.release, ["bad"], "the failure went back for another attempt");
  assert.deepEqual(queue.deadLettered, [], "it has attempts left, so it is not buried yet");
});

test("drain: a message that has spent its attempts dead-letters with its reason", async () => {
  // attempt 5 of maxAttempts 5 is the last delivery the claim predicate will ever hand out.
  // Releasing it would leave a row the next claim silently skips forever.
  const queue = installQueue([message({ id: "spent", attempt: 5 })]);
  const { body } = await drain(workerHost(DRAIN, {
    handleEvent: { body: "throw { reason: 'invalid', message: 'a payload shape we do not know' }", inputs: { message: "message" } },
  }));

  assert.equal(body.drained, 0);
  assert.equal(queue.deadLettered.length, 1);
  assert.equal(queue.deadLettered[0]!.id, "spent");
  assert.match(String(queue.deadLettered[0]!.reason), /payload shape/);
});

test("drain: a throw on one message does not abort the outer action", async () => {
  // The runner holds ONE thrown value; if the drain seam left it there, the failure of a single
  // message would surface as the whole worker failing and every ack would be lost.
  installQueue([message({ id: "bad" }), message({ id: "good" })]);
  const { status, body } = await drain(workerHost(
    "const r = await dsx.module.queue.platform_events.drain({ action: 'handleEvent' })\nreturn { after: 'reached', drained: r.data.drained }",
    { handleEvent: { body: "if (message.id === 'bad') { throw { reason: 'unavailable', message: 'no' } }\nreturn 1", inputs: { message: "message" } } },
  ));
  assert.equal(status, 200);
  assert.equal(body.after, "reached");
  assert.equal(body.drained, 1);
});

test("drain: an action this document does not declare is refused BEFORE anything is claimed", async () => {
  const queue = installQueue([message({ id: "m1" })]);
  const { body } = await drain(workerHost(
    "const r = await dsx.module.queue.platform_events.drain({ action: 'noSuchAction' })\nreturn { failed: r.ok === false, reason: r.error }",
    { handleEvent: { body: "return 1", inputs: { message: "message" } } },
  ));
  // A failed module call SETTLES the call handle rather than throwing — the bus's own shape.
  // What matters is WHEN it was refused: a drain naming a missing action must not claim the
  // queue, fail every message, and park the lot.
  assert.equal(body.failed, true);
  assert.equal(body.reason, "bad_request");
  assert.equal(queue.claims, 0);
});

test("drain: a drain with no action at all is refused, not silently treated as a no-op", async () => {
  const queue = installQueue([message({ id: "m1" })]);
  const { body } = await drain(workerHost(
    "const r = await dsx.module.queue.platform_events.drain({ limit: 5 })\nreturn { failed: r.ok === false }",
    { handleEvent: { body: "return 1", inputs: { message: "message" } } },
  ));
  assert.equal(body.failed, true);
  assert.equal(queue.claims, 0);
});

test("drain: an empty queue costs one claim and no settle round trip", async () => {
  const queue = installQueue([]);
  const { body } = await drain(workerHost(DRAIN, {
    handleEvent: { body: "return 1", inputs: { message: "message" } },
  }));
  assert.equal(body.claimed, 0);
  assert.deepEqual(queue.settled, []);
});
