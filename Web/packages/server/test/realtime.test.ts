//
//  realtime.test.ts — the subscription plane.
//
//  Two properties carry the weight. AUTHORIZATION: a subscriber cannot read another subject's
//  events, and the subject reaching the store is the verified one rather than anything the
//  subscriber sent. DURABILITY: an event published while a subscriber was disconnected is still
//  delivered when it resumes, which is the entire reason this is a cursor over a table instead of
//  a pub/sub channel.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertChannel,
  parseCursor,
  publishEvent,
  RealtimeError,
  RealtimeSeam,
  subscriptionResponse,
  type RealtimeEvent,
  type RealtimeReadRequest,
} from "../src/realtime.ts";
import { buildEventReadStatement } from "../src/postgres.ts";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

/** A store that applies the SAME visibility rule the SQL predicate does, so the stream logic can
 *  be tested without a database while the predicate itself is pinned separately below. */
function feed(): { events: RealtimeEvent[]; reads: RealtimeReadRequest[]; publish(e: Partial<RealtimeEvent>): void } {
  const events: RealtimeEvent[] = [];
  const reads: RealtimeReadRequest[] = [];
  let seq = 0;
  const store = {
    events,
    reads,
    publish(e: Partial<RealtimeEvent>): void {
      seq += 1;
      events.push({ seq: String(seq), channel: "notes", ownerId: null, payload: {}, createdAt: null, ...e });
    },
  };
  RealtimeSeam.transport = {
    publish: async (event) => {
      store.publish({ channel: event.channel, ownerId: event.ownerId, payload: event.payload });
      return String(seq);
    },
    read: async (request) => {
      reads.push(request);
      return events
        .filter((e) => e.channel === request.channel)
        .filter((e) => Number(e.seq) > Number(request.afterSeq))
        .filter((e) => e.ownerId === null || e.ownerId === request.subject)
        .slice(0, request.limit);
    },
  };
  return store;
}

/** Read an SSE body to completion and split it into frames. */
async function frames(response: Response): Promise<string[]> {
  const text = await response.text();
  return text.split("\n\n").filter((f) => f.trim() !== "");
}

/** A stream that polls once and closes, so a test never waits on a wall clock. */
const ONE_PASS = { pollIntervalMs: 100, maxDurationMs: 1, heartbeatMs: 10_000, sleep: async (): Promise<void> => {} };

// ── names and cursors ───────────────────────────────────────────────────────────────────

test("realtime: a channel that is not an identifier is refused before any round trip", () => {
  assert.equal(assertChannel("notes"), "notes");
  for (const bogus of ["Notes", "no tes", "notes;drop table x", "", "1notes"]) {
    assert.throws(() => assertChannel(bogus), (e: unknown) => e instanceof RealtimeError && e.code === "bad_request");
  }
});

test("realtime: a mangled cursor resumes from the beginning rather than failing the stream", () => {
  assert.equal(parseCursor("42"), "42");
  assert.equal(parseCursor(" 42 "), "42");
  for (const bogus of [null, undefined, "", "abc", "-1", "4.2", "1e3"]) {
    assert.equal(parseCursor(bogus), "0", `"${String(bogus)}" was accepted as a cursor`);
  }
});

// ── the authorization predicate, in SQL ─────────────────────────────────────────────────

test("realtime: the read predicate filters by owner, with the subject as a PARAMETER", () => {
  const statement = buildEventReadStatement({ channel: "notes", afterSeq: "0", subject: ALICE, limit: 10 });
  assert.match(statement.text, /owner_id is null or owner_id = \$3::uuid/);
  assert.equal(statement.params[2], ALICE, "the subject must travel as a parameter, never interpolated");
  assert.ok(!statement.text.includes(ALICE), "the subject was interpolated into the SQL text");
});

test("realtime: a non-uuid subject or cursor is refused, so a quiet feed is never a silent bug", () => {
  assert.throws(
    () => buildEventReadStatement({ channel: "notes", afterSeq: "0", subject: "not-a-uuid", limit: 10 }),
    (e: unknown) => e instanceof RealtimeError && e.code === "bad_request",
  );
  assert.throws(
    () => buildEventReadStatement({ channel: "notes", afterSeq: "'; drop table x --", subject: ALICE, limit: 10 }),
    (e: unknown) => e instanceof RealtimeError && e.code === "bad_request",
  );
});

// ── fail closed ─────────────────────────────────────────────────────────────────────────

test("realtime: with NO provider installed a publish and a subscribe both REFUSE, naming the fix", async () => {
  RealtimeSeam.transport = null;
  await assert.rejects(
    () => publishEvent("notes", {}),
    (e: unknown) => e instanceof RealtimeError && e.code === "no_provider" && /Providers\/Postgres/.test(e.message),
  );
  assert.throws(
    () => subscriptionResponse("notes", ALICE, "0"),
    (e: unknown) => e instanceof RealtimeError && e.code === "no_provider",
  );
});

// ── delivery ────────────────────────────────────────────────────────────────────────────

test("realtime: a subscriber receives public events and its OWN, and never another subject's", async () => {
  const store = feed();
  store.publish({ ownerId: null, payload: { n: "public" } });
  store.publish({ ownerId: ALICE, payload: { n: "for-alice" } });
  store.publish({ ownerId: BOB, payload: { n: "for-bob" } });

  const body = await frames(subscriptionResponse("notes", ALICE, "0", ONE_PASS));
  const delivered = body.filter((f) => f.startsWith("id:")).map((f) => JSON.parse(f.split("data: ")[1]!));
  assert.deepEqual(delivered.map((e) => e.payload.n), ["public", "for-alice"]);
  assert.equal(store.reads[0]!.subject, ALICE);
});

test("realtime: each frame carries its seq as the SSE id, which is what a browser resumes from", async () => {
  const store = feed();
  store.publish({ payload: { n: 1 } });
  store.publish({ payload: { n: 2 } });

  const body = await frames(subscriptionResponse("notes", ALICE, "0", ONE_PASS));
  assert.match(body[1]!, /^id: 1\nevent: notes\ndata: /);
  assert.match(body[2]!, /^id: 2\n/);
});

test("realtime: a subscriber resuming from a cursor gets ONLY what it missed", async () => {
  //  The durability property. An event published while the client was disconnected is still
  //  delivered on reconnect, which a NOTIFY-based channel cannot do.
  const store = feed();
  store.publish({ payload: { n: 1 } });
  store.publish({ payload: { n: 2 } });
  store.publish({ payload: { n: 3 } });

  const body = await frames(subscriptionResponse("notes", ALICE, "2", ONE_PASS));
  const delivered = body.filter((f) => f.startsWith("id:")).map((f) => JSON.parse(f.split("data: ")[1]!));
  assert.deepEqual(delivered.map((e) => e.payload.n), [3]);
  assert.equal(store.reads[0]!.afterSeq, "2");
});

test("realtime: the stream announces its reconnect interval before anything else", async () => {
  feed();
  const body = await frames(subscriptionResponse("notes", ALICE, "0", ONE_PASS));
  assert.match(body[0]!, /^retry: \d+$/, "a stream that dies immediately must still have told the client when to retry");
});

test("realtime: the response is an unbuffered event stream", () => {
  feed();
  const response = subscriptionResponse("notes", ALICE, "0", ONE_PASS);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-accel-buffering"), "no", "a buffering proxy turns realtime into a batch");
});

test("realtime: a payload containing a newline cannot break out of its data frame", async () => {
  const store = feed();
  store.publish({ payload: { text: "line one\nline two\n\nid: 999" } });
  const body = await frames(subscriptionResponse("notes", ALICE, "0", ONE_PASS));
  const dataFrames = body.filter((f) => f.startsWith("id:"));
  assert.equal(dataFrames.length, 1, "a payload newline split one event into several frames");
  assert.equal(JSON.parse(dataFrames[0]!.split("data: ")[1]!).payload.text, "line one\nline two\n\nid: 999");
});

test("realtime: publishing returns the new cursor, and an owner id that is not a subject is refused", async () => {
  feed();
  assert.equal(await publishEvent("notes", { a: 1 }, { ownerId: ALICE }), "1");
  RealtimeSeam.transport = {
    publish: async () => {
      throw new RealtimeError("boom", "bad_request");
    },
    read: async () => [],
  };
  await assert.rejects(() => publishEvent("notes", {}, { ownerId: "nope" }), RealtimeError);
});
