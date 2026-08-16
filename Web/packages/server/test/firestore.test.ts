//
//  firestore.test.ts — the Firestore transport's own surface (A0-SWEEP L-07).
//
//  `repo-portability.test.ts` proves this transport keeps the repository's PROMISES. This file
//  proves the things that are true of Firestore and of nothing else, and that therefore have no
//  place in a portable corpus:
//
//    • the wire each operation builds — the update mask, `currentDocument.exists`, the
//      structuredQuery, the `documentId` the create supplies;
//    • the value codec, in both directions, over the whole declared type vocabulary;
//    • WHICH CREDENTIAL travels with a query, and that a service query with none FAILS rather
//      than falling through to an unauthenticated request;
//    • the status→result mapping that makes "you may not see it" and "it is not there" the same
//      answer for a single document, as the SQL transport cannot tell them apart either;
//    • and the one that motivates the whole design: RULES ARE NOT ROW FILTERS. An owner-scoped
//      query is refused unless it names its owner, and it is refused just the same if it names
//      the WRONG one — so the filter the transport adds is what makes an honest request
//      expressible, never what decides the answer.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installEntities, repoFor, serviceRepo, RepoError, RepoSeam, type EntitySpec, type RepoQuery } from "../src/repo.ts";
import {
  buildFirestoreRequest,
  decodeDocument,
  decodeValue,
  encodeJson,
  encodeValue,
  installFirestore,
  type FetchLike,
} from "../src/firestore.ts";
import { fakeFirestore, rulesFromEmitted } from "./firestore-fake.ts";
import { ALICE, BOB, ctxFor, tokenFor } from "./repo-portability.ts";

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const RULES = join(HERE, "..", "deploy", "firebase", "firestore.rules");

const NOTE: EntitySpec = { entity: "note", fields: { title: "text", body: "text", pinned: "boolean" }, ownership: "owner" };
const EVENTS: EntitySpec = {
  entity: "webhook_events",
  fields: { source: "text", payload: "jsonb", received_at: "timestamptz" },
  ownership: "service",
};
const METRICS: EntitySpec = {
  entity: "metric",
  fields: { name: "text", count: "integer", ratio: "real", at: "timestamptz", extra: "jsonb" },
  ownership: "owner",
};

installEntities([NOTE, EVENTS, METRICS]);

const BASE = "http://firestore.local/v1";
const ROOT = "/projects/p/databases/(default)/documents";

const ctx = { projectId: "p", databaseId: "(default)", spec: NOTE, now: () => new Date("2026-05-04T10:00:00.000Z"), newId: () => "fixed-id" };

function query(over: Partial<RepoQuery> & Pick<RepoQuery, "op">): RepoQuery {
  return { entity: "note", token: tokenFor(ALICE), subject: ALICE, scope: "user", ...over };
}

/** A wire that records and answers with whatever it is told to. */
function wire(answer: { status: number; body?: unknown }): { fetch: FetchLike; calls: { url: string; method?: string; headers?: Record<string, string>; body?: string }[] } {
  const calls: { url: string; method?: string; headers?: Record<string, string>; body?: string }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, ...(init ?? {}) });
      return { status: answer.status, text: async () => (answer.body === undefined ? "" : JSON.stringify(answer.body)) };
    },
  };
}

// ── the request each operation builds ───────────────────────────────────────────────────

test("firestore: a get addresses the document directly", () => {
  const request = buildFirestoreRequest(ctx, query({ op: "get", id: "n1" }));
  assert.deepEqual(request, { method: "GET", url: `${ROOT}/dsx_note/n1` });
});

test("firestore: a create supplies its own id and stamps the two columns Postgres defaults", () => {
  const request = buildFirestoreRequest(ctx, query({ op: "create", values: { title: "t", pinned: true } }));
  assert.equal(request.method, "POST");
  assert.equal(request.url, `${ROOT}/dsx_note?documentId=fixed-id`);
  assert.deepEqual((request.body as { fields: Record<string, unknown> }).fields, {
    title: { stringValue: "t" },
    pinned: { booleanValue: true },
    owner_id: { stringValue: ALICE },
    created_at: { timestampValue: "2026-05-04T10:00:00.000Z" },
  });
});

test("firestore: an update is a MASKED patch that refuses to create a missing document", () => {
  const request = buildFirestoreRequest(ctx, query({ op: "update", id: "n1", values: { title: "after" } }));
  assert.equal(request.method, "PATCH");
  assert.match(request.url, /^\/projects\/p\/databases\/\(default\)\/documents\/dsx_note\/n1\?/);
  assert.match(request.url, /updateMask\.fieldPaths=title/, "without a mask a PATCH REPLACES the document");
  assert.match(request.url, /currentDocument\.exists=true/, "without this an update of a missing row silently creates it");
  assert.deepEqual((request.body as { fields: Record<string, unknown> }).fields, { title: { stringValue: "after" } });
  assert.throws(() => buildFirestoreRequest(ctx, query({ op: "update", id: "n1", values: {} })), /at least one declared field/);
});

test("firestore: a delete refuses to succeed on a document that is not there", () => {
  const request = buildFirestoreRequest(ctx, query({ op: "delete", id: "n1" }));
  assert.equal(request.method, "DELETE");
  assert.match(request.url, /currentDocument\.exists=true/, "an unconditional delete reports success for a row it never saw");
});

test("firestore: a list is a structuredQuery ordered and bounded like the SQL one", () => {
  const request = buildFirestoreRequest(ctx, query({ op: "list", filters: { pinned: "true" }, limit: 25 }));
  assert.equal(request.url, `${ROOT}:runQuery`);
  const q = (request.body as { structuredQuery: Record<string, unknown> }).structuredQuery;
  assert.deepEqual(q["from"], [{ collectionId: "dsx_note" }]);
  assert.deepEqual(q["orderBy"], [{ field: { fieldPath: "created_at" }, direction: "DESCENDING" }]);
  assert.equal(q["limit"], 25);
  const filters = (q["where"] as { compositeFilter: { op: string; filters: unknown[] } }).compositeFilter;
  assert.equal(filters.op, "AND");
  assert.deepEqual(filters.filters, [
    { fieldFilter: { field: { fieldPath: "pinned" }, op: "EQUAL", value: { booleanValue: true } } },
    { fieldFilter: { field: { fieldPath: "owner_id" }, op: "EQUAL", value: { stringValue: ALICE } } },
  ], "an owner-scoped list must name its owner — see the rules test below for why");
});

test("firestore: a list of a NON-owner entity carries no owner filter", () => {
  const request = buildFirestoreRequest({ ...ctx, spec: EVENTS }, { entity: "webhook_events", op: "list", token: null, subject: null, scope: "service", limit: 10 });
  const q = (request.body as { structuredQuery: Record<string, unknown> }).structuredQuery;
  assert.equal(q["where"], undefined, "a service-scoped read must not be narrowed by an owner nobody declared");
});

test("firestore: a hostile entity or field name never reaches a path or a field path", () => {
  assert.throws(() => buildFirestoreRequest(ctx, query({ op: "get", entity: "note/../dsx_secret", id: "x" })), /not a legal identifier/);
  assert.throws(() => buildFirestoreRequest(ctx, query({ op: "list", filters: { "a.b": "1" } })), /not a legal identifier/);
  // a COMPUTED key, so it is an own property rather than a prototype assignment
  assert.throws(() => buildFirestoreRequest(ctx, query({ op: "create", values: { ["__proto__"]: "x" } })), /not a legal identifier/);
  assert.throws(() => buildFirestoreRequest(ctx, query({ op: "update", id: "n1", values: { "title/../x": "y" } })), /not a legal identifier/);
});

// ── the codec ───────────────────────────────────────────────────────────────────────────

test("firestore: every declared type encodes to its own wire spelling", () => {
  assert.deepEqual(encodeValue("text", "hi"), { stringValue: "hi" });
  assert.deepEqual(encodeValue("uuid", ALICE), { stringValue: ALICE });
  assert.deepEqual(encodeValue("integer", "42"), { integerValue: "42" }, "Firestore carries integers as STRINGS on the wire");
  assert.deepEqual(encodeValue("real", "1.5"), { doubleValue: 1.5 });
  assert.deepEqual(encodeValue("boolean", "true"), { booleanValue: true });
  assert.deepEqual(encodeValue("boolean", false), { booleanValue: false });
  assert.deepEqual(encodeValue("timestamptz", "2026-05-04T10:00:00Z"), { timestampValue: "2026-05-04T10:00:00.000Z" });
  assert.deepEqual(encodeValue("text", null), { nullValue: null });
  assert.deepEqual(encodeValue("jsonb", { a: [1, "x", true, null] }), {
    mapValue: { fields: { a: { arrayValue: { values: [{ integerValue: "1" }, { stringValue: "x" }, { booleanValue: true }, { nullValue: null }] } } } },
  });
});

test("firestore: a value that is not of its declared type is refused, not coerced to nonsense", () => {
  assert.throws(() => encodeValue("integer", "not a number"), RepoError);
  assert.throws(() => encodeValue("real", "abc"), RepoError);
  assert.throws(() => encodeValue("boolean", "yes"), RepoError);
  assert.throws(() => encodeValue("timestamptz", "never"), RepoError);
});

test("firestore: decoding is the inverse, including nested maps and arrays", () => {
  const round = (v: unknown): unknown => decodeValue(encodeJson(v));
  assert.deepEqual(round({ a: 1, b: [true, "x", { c: 2.5 }], d: null }), { a: 1, b: [true, "x", { c: 2.5 }], d: null });
  assert.equal(decodeValue(undefined), null);
  assert.equal(decodeValue({ integerValue: "7" }), 7);
  assert.equal(decodeValue({ timestampValue: "2026-05-04T10:00:00Z" }), "2026-05-04T10:00:00Z");
});

test("firestore: a document decodes to the row shape a SQL `select *` would give", () => {
  const row = decodeDocument({ name: `${ROOT}/dsx_note/abc`, fields: { title: { stringValue: "t" } } }, NOTE);
  assert.deepEqual(row, { id: "abc", owner_id: null, created_at: null, title: "t", body: null, pinned: null });
  // Without a spec the shape is whatever was stored — the id still comes off the document name.
  assert.deepEqual(decodeDocument({ name: `${ROOT}/dsx_note/abc`, fields: {} }), { id: "abc" });
});

// ── credentials ─────────────────────────────────────────────────────────────────────────

test("firestore: a user query travels with the CALLER's verified token", async () => {
  const w = wire({ status: 200, body: [{ readTime: "t" }] });
  installFirestore({ projectId: "p", baseUrl: BASE, fetch: w.fetch });
  await repoFor(ctxFor(ALICE)).list("note");
  assert.equal(w.calls[0]!.headers?.["authorization"], `Bearer ${tokenFor(ALICE)}`, "without the caller's token the rules judge the server, not the user");
});

test("firestore: a service query travels with the INJECTED service credential, never the caller's", async () => {
  const w = wire({ status: 200, body: [{ readTime: "t" }] });
  installFirestore({ projectId: "p", baseUrl: BASE, fetch: w.fetch, serviceToken: () => "sa-token" });
  await serviceRepo().list("webhook_events");
  assert.equal(w.calls[0]!.headers?.["authorization"], "Bearer sa-token");
});

test("firestore: a service query with NO credential fails closed — it never goes out unauthenticated", async () => {
  const w = wire({ status: 200, body: [{ readTime: "t" }] });
  installFirestore({ projectId: "p", baseUrl: BASE, fetch: w.fetch });
  await assert.rejects(() => serviceRepo().list("webhook_events"), (e: unknown) => {
    assert.ok(e instanceof RepoError);
    assert.equal((e as RepoError).code, "no_provider");
    return true;
  });
  assert.equal(w.calls.length, 0, "an unauthenticated service request reached the wire");
});

test("firestore: a read whose answer the DECLARATION already fixes costs no round trip", async () => {
  const w = wire({ status: 500, body: { error: { status: "INTERNAL" } } });
  installFirestore({ projectId: "p", baseUrl: BASE, fetch: w.fetch });
  // Anonymous on an owner entity, and a user on a service entity: both are knowably empty.
  assert.deepEqual(await repoFor(ctxFor(null)).list("note"), []);
  assert.equal(await repoFor(ctxFor(null)).get("note", "n1"), null);
  assert.deepEqual(await repoFor(ctxFor(ALICE)).list("webhook_events"), []);
  assert.equal(w.calls.length, 0, "a knowably-empty read still asked the store");
});

// ── the status mapping ──────────────────────────────────────────────────────────────────

test("firestore: for ONE document, RULES-denied and absent are the same answer", async () => {
  for (const status of [403, 404]) {
    installFirestore({ projectId: "p", baseUrl: BASE, fetch: wire({ status, body: { error: { status: "PERMISSION_DENIED" } } }).fetch });
    assert.equal(await repoFor(ctxFor(ALICE)).get("note", "n1"), null, `${status} on a get must be null`);
    assert.equal(await repoFor(ctxFor(ALICE)).update("note", "n1", { title: "x" }), null, `${status} on an update must be null`);
    assert.equal(await repoFor(ctxFor(ALICE)).remove("note", "n1"), null, `${status} on a delete must be null`);
  }
});

test("firestore: a BAD CREDENTIAL is never an empty result — 401 throws on every operation", async () => {
  installFirestore({ projectId: "p", baseUrl: BASE, fetch: wire({ status: 401, body: { error: { status: "UNAUTHENTICATED" } } }).fetch });
  for (const call of [
    () => repoFor(ctxFor(ALICE)).get("note", "n1"),
    () => repoFor(ctxFor(ALICE)).update("note", "n1", { title: "x" }),
    () => repoFor(ctxFor(ALICE)).remove("note", "n1"),
    () => repoFor(ctxFor(ALICE)).list("note"),
  ]) {
    await assert.rejects(call, (e: unknown) => {
      assert.equal((e as RepoError).code, "forbidden");
      assert.match((e as RepoError).message, /credential/, "an expired token must not read as 'the database is empty'");
      return true;
    });
  }
});

test("firestore: a denied CREATE throws — a write that did not happen must never look like one that did", async () => {
  installFirestore({ projectId: "p", baseUrl: BASE, fetch: wire({ status: 403, body: { error: { status: "PERMISSION_DENIED" } } }).fetch });
  await assert.rejects(() => repoFor(ctxFor(ALICE)).create("note", { title: "t" }), (e: unknown) => {
    assert.equal((e as RepoError).code, "forbidden");
    return true;
  });
});

test("firestore: an overloaded store is `saturated`, not `no_provider` — they want opposite responses", async () => {
  for (const status of [429, 503, 504]) {
    installFirestore({ projectId: "p", baseUrl: BASE, fetch: wire({ status, body: { error: { status: "UNAVAILABLE" } } }).fetch });
    await assert.rejects(() => repoFor(ctxFor(ALICE)).list("note"), (e: unknown) => {
      assert.equal((e as RepoError).code, "saturated", `${status} was not reported as saturation`);
      return true;
    });
  }
});

test("firestore: a rejected request is `bad_request` and carries the store's reason to the LOG", async () => {
  installFirestore({
    projectId: "p",
    baseUrl: BASE,
    fetch: wire({ status: 400, body: { error: { status: "FAILED_PRECONDITION", message: "The query requires an index." } } }).fetch,
  });
  await assert.rejects(() => repoFor(ctxFor(ALICE)).list("note"), (e: unknown) => {
    assert.equal((e as RepoError).code, "bad_request");
    assert.match((e as RepoError).message, /requires an index/, "the operator needs to be told what to fix");
    return true;
  });
});

// ── RULES ARE NOT ROW FILTERS — the property the owner filter exists to satisfy ─────────

test("firestore: the EMITTED rules refuse an owner query that does not name its owner", async () => {
  const fake = fakeFirestore({ rules: rulesFromEmitted(readFileSync(RULES, "utf-8")) });
  // Straight at the wire, bypassing the transport, so this is about the RULES and not about us.
  const unfiltered = await fake.fetch(`${BASE}${ROOT}:runQuery`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenFor(ALICE)}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "dsx_note" }], limit: 10 } }),
  });
  assert.equal(unfiltered.status, 403, "an unconstrained owner query was allowed — then the transport's filter would be the only isolation");

  // And naming SOMEONE ELSE is refused just the same: the filter makes a request expressible,
  // it never makes it permitted.
  const lying = await fake.fetch(`${BASE}${ROOT}:runQuery`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenFor(BOB)}` },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "dsx_note" }],
        where: { fieldFilter: { field: { fieldPath: "owner_id" }, op: "EQUAL", value: { stringValue: ALICE } } },
      },
    }),
  });
  assert.equal(lying.status, 403, "a query naming another user's id was allowed");
});

test("firestore: the emitted rules classify every declared collection", () => {
  const rules = rulesFromEmitted(readFileSync(RULES, "utf-8"));
  assert.equal(rules["dsx_note"], "owner", "the owner-scoped collection is no longer emitted as owner-scoped");
  assert.equal(rules["dsx_webhook_events"], "service", "the service collection is no longer emitted as service-only");
});

test("firestore: installing the transport leaves the QUEUE seam empty rather than approximating it", async () => {
  const { QueueSeam } = await import("../src/queue.ts");
  QueueSeam.transport = null;
  installFirestore({ projectId: "p", baseUrl: BASE, fetch: wire({ status: 200 }).fetch });
  assert.equal(QueueSeam.transport, null, "a queue that cannot be claimed atomically must fail closed, not half-work");
  RepoSeam.transport = null;
});
