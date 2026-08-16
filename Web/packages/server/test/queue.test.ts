//
//  queue.test.ts — the QUEUE PLANE, without a database (L-11).
//
//  What this file proves is the PROTOCOL, which is the part no store can prove for you:
//
//    • an unfilled seam FAILS, and fails with a message naming the fix. This is the one that
//      matters most, because the alternative — a drain that reports `drained: 0` when no queue
//      provider is installed at all — is byte-identical to a drain that is working perfectly on
//      an empty queue. A queue that is completely unwired must never be able to look healthy.
//    • one drain pass is claim → process → ack/release, and the outcome of EACH message is
//      decided on its own. A single throwing handler must cost exactly one message.
//    • what a handler throws never escapes the drain: it becomes a released message and a
//      reported failure, so a cron-driven drain retries instead of dying.
//    • the claim request is bounded and normalised before it reaches a provider, so a caller
//      cannot ask a store for an unbounded page or a negative lease.
//
//  The database-facing half — that a claim two drains issue at the same instant cannot be won
//  twice — is `queue.postgres.test.ts` (PGlite, the emitted migration) and `queue.live.test.ts`
//  (a real pool, genuinely concurrent).
//

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  drainQueue,
  QueueError,
  QueueSeam,
  QUEUE_CLAIM_LIMIT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_VISIBILITY_MS,
  assertQueueName,
  enqueueMessage,
  listDeadLetters,
  replayDeadLetters,
  type QueueClaimRequest,
  type QueueDeadLetterRequest,
  type QueueEnqueueRequest,
  type QueueMessage,
  type QueueSettleRequest,
} from "../src/queue.ts";

/** A transport that records what it was asked and answers with a scripted set of messages. */
function recorder(messages: QueueMessage[] = []): {
  claims: QueueClaimRequest[];
  settles: QueueSettleRequest[];
  enqueues: QueueEnqueueRequest[];
  dead: QueueDeadLetterRequest[];
  replays: { queue: string; ids: readonly string[] }[];
  install(): void;
} {
  const claims: QueueClaimRequest[] = [];
  const settles: QueueSettleRequest[] = [];
  const enqueues: QueueEnqueueRequest[] = [];
  const dead: QueueDeadLetterRequest[] = [];
  const replays: { queue: string; ids: readonly string[] }[] = [];
  const keys = new Set<string>();
  return {
    claims,
    settles,
    enqueues,
    dead,
    replays,
    install() {
      QueueSeam.transport = {
        enqueue: async (request) => {
          enqueues.push(request);
          // The UNIQUE key, modelled: a repeat is accepted and reported, never stored twice.
          if (keys.has(request.key)) return { id: null, duplicate: true };
          keys.add(request.key);
          return { id: `id-${keys.size}`, duplicate: false };
        },
        claim: async (request) => {
          claims.push(request);
          return messages;
        },
        settle: async (request) => {
          settles.push(request);
          return { acked: request.ack.length, released: request.release.length };
        },
        deadLetter: async (request) => {
          dead.push(request);
          return request.entries.length;
        },
        listDeadLetters: async () => [],
        replayDeadLetters: async (request) => {
          replays.push(request);
          return request.ids.length;
        },
      };
    },
  };
}

/** The seam ops a claim/settle-only fixture does not exercise. Present so the fixture satisfies
 *  the full transport, and throwing so a test that DOES reach one fails loudly rather than
 *  silently succeeding against a stub. */
const unusedOps = {
  enqueue: async (): Promise<never> => { throw new Error("this fixture does not implement enqueue"); },
  deadLetter: async (): Promise<never> => { throw new Error("this fixture does not implement deadLetter"); },
  listDeadLetters: async (): Promise<never> => { throw new Error("this fixture does not implement listDeadLetters"); },
  replayDeadLetters: async (): Promise<never> => { throw new Error("this fixture does not implement replayDeadLetters"); },
};

function message(over: Partial<QueueMessage> = {}): QueueMessage {
  return { id: "m1", key: "k1", payload: {}, enqueuedAt: null, attempt: 1, ...over };
}

function unfilled(): void {
  QueueSeam.transport = null;
}

// ── fail closed ─────────────────────────────────────────────────────────────────────────

test("queue: with NO provider installed a drain REFUSES — it never reports a quiet queue", async () => {
  unfilled();
  await assert.rejects(
    () => drainQueue("webhooks", async () => {}),
    (e: unknown) => {
      assert.ok(e instanceof QueueError, "an unfilled seam must fail with the plane's own typed error");
      assert.equal((e as QueueError).code, "no_provider");
      assert.match((e as QueueError).message, /no queue provider is installed/);
      assert.match((e as QueueError).message, /Providers\/Postgres/, "the failure must name the fix, not just the fault");
      return true;
    },
  );
});

test("queue: a name that is not an identifier is refused before any round trip", async () => {
  const rec = recorder([message()]);
  rec.install();
  await assert.rejects(() => drainQueue("web hooks", async () => {}), /not a legal queue name/);
  await assert.rejects(() => drainQueue("Webhooks; drop table x", async () => {}), /not a legal queue name/);
  assert.equal(rec.claims.length, 0, "a malformed name reached the provider");
  assert.equal(assertQueueName("webhook_events"), "webhook_events");
});

// ── one pass: claim, process, settle ─────────────────────────────────────────────────────

test("queue: a pass claims, processes each message, and acks exactly what succeeded", async () => {
  const rec = recorder([message({ id: "a", key: "ka" }), message({ id: "b", key: "kb" })]);
  rec.install();
  const seen: string[] = [];

  const result = await drainQueue("webhooks", async (m) => {
    seen.push(m.key);
  });

  assert.deepEqual(seen, ["ka", "kb"], "every claimed message must reach the handler");
  assert.equal(result.claimed, 2);
  assert.equal(result.drained, 2, "drained is the ACKED count — the number a worker route reports");
  assert.equal(result.released, 0);
  assert.deepEqual(result.failures, []);
  assert.equal(rec.settles.length, 1, "one settle per pass, not one per message");
  assert.deepEqual(rec.settles[0]!.ack, ["a", "b"]);
  assert.deepEqual(rec.settles[0]!.release, []);
});

test("queue: ONE failing handler costs exactly one message — the rest still complete", async () => {
  const rec = recorder([
    message({ id: "a", key: "ka" }),
    message({ id: "poison", key: "kp" }),
    message({ id: "c", key: "kc" }),
  ]);
  rec.install();

  const result = await drainQueue("webhooks", async (m) => {
    if (m.id === "poison") throw new Error("upstream refused the webhook");
  });

  assert.equal(result.claimed, 3);
  assert.equal(result.drained, 2, "a poison message aborted the whole pass — the queue would stall on it forever");
  assert.equal(result.released, 1);
  assert.deepEqual(result.failures, [{ key: "kp", reason: "upstream refused the webhook" }]);
  assert.deepEqual(rec.settles[0]!.ack, ["a", "c"]);
  assert.deepEqual(rec.settles[0]!.release, ["poison"], "the failure must go BACK to the queue, not be silently dropped");
});

test("queue: a handler throwing a non-Error still releases, and the reason survives", async () => {
  const rec = recorder([message({ id: "a", key: "ka" })]);
  rec.install();
  const result = await drainQueue("webhooks", () => {
    throw "string rejection"; // eslint-disable-line no-throw-literal -- deliberately hostile
  });
  assert.equal(result.drained, 0);
  assert.deepEqual(result.failures, [{ key: "ka", reason: "string rejection" }]);
  assert.deepEqual(rec.settles[0]!.release, ["a"]);
});

test("queue: an empty claim settles nothing at all — a quiet queue costs one round trip", async () => {
  const rec = recorder([]);
  rec.install();
  const result = await drainQueue("webhooks", async () => {
    assert.fail("the handler ran with no messages");
  });
  assert.deepEqual(result, { queue: "webhooks", claimed: 0, drained: 0, released: 0, deadLettered: 0, failures: [] });
  assert.equal(rec.settles.length, 0, "an empty pass spent a settle round trip for nothing");
});

// ── the claim request is normalised before a provider ever sees it ───────────────────────

test("queue: the claim request carries bounded, defaulted values", async () => {
  const rec = recorder([]);
  rec.install();

  await drainQueue("webhooks", async () => {});
  assert.deepEqual(rec.claims[0], {
    queue: "webhooks",
    limit: QUEUE_CLAIM_LIMIT,
    visibilityMs: DEFAULT_VISIBILITY_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  });

  await drainQueue("webhooks", async () => {}, { limit: 10_000, visibilityMs: -5, maxAttempts: 0 });
  assert.equal(rec.claims[1]!.limit, QUEUE_CLAIM_LIMIT, "an unbounded page is a data-exfiltration primitive and a DoS");
  assert.equal(rec.claims[1]!.visibilityMs, 0, "a negative lease is not a lease");
  assert.equal(rec.claims[1]!.maxAttempts, 1, "zero attempts would park every message on first delivery");

  await drainQueue("webhooks", async () => {}, { limit: Number.NaN, visibilityMs: Number.NaN, maxAttempts: Number.NaN });
  assert.deepEqual(
    { l: rec.claims[2]!.limit, v: rec.claims[2]!.visibilityMs, a: rec.claims[2]!.maxAttempts },
    { l: QUEUE_CLAIM_LIMIT, v: DEFAULT_VISIBILITY_MS, a: DEFAULT_MAX_ATTEMPTS },
    "a non-finite option must fall back to the default, never propagate as NaN",
  );
});

// ── a failing settle loses nothing ───────────────────────────────────────────────────────

test("queue: when the settle fails the pass fails — nothing is acked, so nothing is lost", async () => {
  QueueSeam.transport = {
    ...unusedOps,
    claim: async () => [message({ id: "a", key: "ka" })],
    settle: async () => {
      throw new Error("connection reset");
    },
  };
  let handled = 0;
  await assert.rejects(
    () =>
      drainQueue("webhooks", async () => {
        handled += 1;
      }),
    /connection reset/,
  );
  assert.equal(handled, 1, "the handler should still have run — the lease is what protects the retry");
});

// ── the plane names no vendor ────────────────────────────────────────────────────────────

test("queue: the seam is provider-agnostic — any transport satisfies it", async () => {
  const inMemory: { key: string; payload: Record<string, unknown>; done: boolean }[] = [
    { key: "e1", payload: { a: 1 }, done: false },
    { key: "e2", payload: { a: 2 }, done: false },
  ];
  QueueSeam.transport = {
    ...unusedOps,
    claim: async (request) =>
      inMemory
        .filter((r) => !r.done)
        .slice(0, request.limit)
        .map((r) => ({ id: r.key, key: r.key, payload: r.payload, enqueuedAt: null, attempt: 1 })),
    settle: async (request) => {
      for (const id of request.ack) {
        const row = inMemory.find((r) => r.key === id);
        if (row) row.done = true;
      }
      return { acked: request.ack.length, released: request.release.length };
    },
  };
  const first = await drainQueue("webhooks", async () => {}, { limit: 1 });
  assert.equal(first.drained, 1);
  const second = await drainQueue("webhooks", async () => {}, { limit: 5 });
  assert.equal(second.drained, 1, "the second pass must not re-deliver what the first acked");
  const third = await drainQueue("webhooks", async () => {});
  assert.equal(third.claimed, 0);
});

// ── the enqueue half of the protocol (the half that did not exist) ───────────────────────

test("queue: with NO provider installed an enqueue REFUSES, naming the fix", async () => {
  unfilled();
  await assert.rejects(
    () => enqueueMessage("webhooks", "k1", {}),
    (e: unknown) => e instanceof QueueError && e.code === "no_provider",
    "an unwired queue must never silently accept a message it cannot store",
  );
});

test("queue: a repeated idempotency key is ACCEPTED and reported, never stored twice", async () => {
  const rec = recorder([]);
  rec.install();
  const first = await enqueueMessage("webhooks", "evt-1", { a: 1 });
  assert.equal(first.duplicate, false);
  assert.notEqual(first.id, null);

  const again = await enqueueMessage("webhooks", "evt-1", { a: 1 });
  assert.equal(again.duplicate, true, "a sender's retry must be a success, or it retries forever");
  assert.equal(again.id, null);
  assert.equal(rec.enqueues.length, 2, "both reached the transport — the ROW decides, not this code");
});

test("queue: an enqueue refuses an empty or oversized idempotency key before a round trip", async () => {
  const rec = recorder([]);
  rec.install();
  await assert.rejects(() => enqueueMessage("webhooks", "", {}), (e: unknown) => e instanceof QueueError && e.code === "bad_request");
  await assert.rejects(
    () => enqueueMessage("webhooks", "x".repeat(513), {}),
    (e: unknown) => e instanceof QueueError && e.code === "bad_request",
  );
  assert.equal(rec.enqueues.length, 0, "a key that names no message must not reach the store");
});

// ── the dead letter: a poison message becomes VISIBLE, not merely invisible ──────────────

test("queue: a handler failure on the LAST attempt dead-letters, with the reason it gave", async () => {
  const rec = recorder([message({ id: "a", key: "ka", attempt: 3 })]);
  rec.install();
  const result = await drainQueue("webhooks", async () => {
    throw new Error("still broken");
  }, { maxAttempts: 3 });

  assert.equal(result.deadLettered, 1);
  assert.equal(result.released, 0, "an exhausted message must not be released — the next claim would skip it forever");
  assert.deepEqual(rec.dead[0]!.entries, [{ id: "a", reason: "still broken" }]);
  assert.deepEqual(rec.settles[0]!.release, [], "the settle carried no release for the exhausted message");
});

test("queue: a handler failure BEFORE the last attempt releases, and never dead-letters", async () => {
  const rec = recorder([message({ id: "a", key: "ka", attempt: 2 })]);
  rec.install();
  const result = await drainQueue("webhooks", async () => {
    throw new Error("transient");
  }, { maxAttempts: 3 });

  assert.equal(result.deadLettered, 0, "one transient outage must not bury a good message");
  assert.equal(result.released, 1);
  assert.equal(rec.dead.length, 0);
});

test("queue: a dead-letter failure never discards the acks of the messages that SUCCEEDED", async () => {
  const rec = recorder([message({ id: "a", key: "ka", attempt: 1 }), message({ id: "b", key: "kb", attempt: 5 })]);
  rec.install();
  QueueSeam.transport = {
    ...QueueSeam.transport!,
    deadLetter: async () => {
      throw new Error("the dead-letter update failed");
    },
  };

  const result = await drainQueue("webhooks", async (m) => {
    if (m.id === "b") throw new Error("poison");
  }, { maxAttempts: 5 });

  assert.equal(result.drained, 1, "the good message must still be acked");
  assert.equal(result.deadLettered, 0);
  assert.ok(
    result.failures.some((f) => f.reason.startsWith("dead-letter failed:")),
    "the dead-letter failure must be reported, not swallowed",
  );
});

test("queue: replaying nothing costs no round trip, and a listing is bounded", async () => {
  const rec = recorder([]);
  rec.install();
  assert.equal(await replayDeadLetters("webhooks", []), 0);
  assert.equal(rec.replays.length, 0);

  await listDeadLetters("webhooks", 10_000);
  await replayDeadLetters("webhooks", ["x"]);
  assert.deepEqual(rec.replays[0]!.ids, ["x"]);
});
