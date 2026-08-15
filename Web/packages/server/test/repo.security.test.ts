//
//  repo.security.test.ts — the T3 repository invariant (plan B3), asserted rather than trusted.
//
//  THE RULE THE WHOLE FILE EXISTS FOR:
//
//      a user request must never reach the database with service-role authority.
//
//  The server holds a service key that BYPASSES row-level security, so every other protection
//  is downstream of that one sentence. These tests pin the three mechanisms that enforce it:
//
//    the caller's token is FORWARDED on every user-scoped query, so Postgres evaluates
//    `auth.uid()` for real (without it the query would run as whoever the transport is);
//    the FIELD ALLOWLIST is the declared schema, so a client that posts `owner_id`/`id`
//    writes a row it owns rather than one it steals;
//    the SERVICE face is a different type reached only by naming `serviceRepo()`, so a
//    generated CRUD handler cannot obtain one by accident.
//
//  These run against a RECORDING transport — they prove what the repository SENDS. Proving the
//  database then enforces it is phase B5 (real Postgres, user A vs user B).
//

import { test } from "node:test";
import { readTraceContext } from "../src/trace.ts";
import assert from "node:assert/strict";

import {
  installEntities, RepoSeam, repoFor, serviceRepo, crudHandler, allowedValues,
  entitySpec, LIST_LIMIT, RepoError, type EntitySpec, type RepoQuery,
} from "../src/repo.ts";
import type { HostContext } from "../src/host.ts";

const NOTE: EntitySpec = {
  entity: "note",
  fields: { title: "text", body: "text", pinned: "boolean" },
  ownership: "owner",
};
const AUDIT: EntitySpec = { entity: "audit", fields: { line: "text" }, ownership: "service" };

installEntities([NOTE, AUDIT]);

/** Records what the repository would send, and answers with it. */
function recorder(): { sent: RepoQuery[]; install(): void } {
  const sent: RepoQuery[] = [];
  return {
    sent,
    install() { RepoSeam.transport = async (q) => { sent.push(q); return { echoed: q }; }; },
  };
}

function ctxFor(identity: HostContext["identity"], over: Partial<HostContext> = {}): HostContext {
  return {
    buildInfo: {},
    identity,
    env: () => undefined,
    query: {},
    body: {},
    params: {},
    correlationId: "test",
    trace: readTraceContext(new Headers()),
    request: new Request("https://test.invalid/"),
    ...over,
  };
}

const USER = { sub: "alice", role: "authenticated", claims: {}, token: "alice.jwt.sig" };

// ── the token must ride along, or RLS is not user-scoped at all ──────────────────────────

test("repo: every user-scoped query forwards the caller's token (this IS the RLS scoping)", async () => {
  const rec = recorder(); rec.install();
  const repo = repoFor(ctxFor(USER));
  await repo.list("note");
  await repo.get("note", "n1");
  await repo.create("note", { title: "t" });
  await repo.update("note", "n1", { title: "t2" });
  await repo.remove("note", "n1");
  assert.equal(rec.sent.length, 5);
  for (const q of rec.sent) {
    assert.equal(q.token, "alice.jwt.sig", `${q.op} dropped the caller's token — the query would not be user-scoped`);
  }
});

test("repo: the SERVICE face sends NO token (it is deliberately not user-scoped)", async () => {
  const rec = recorder(); rec.install();
  await serviceRepo().list("audit");
  assert.equal(rec.sent[0]!.token, null);
});

test("repo: the service face is a DIFFERENT type — a handler ctx cannot produce one", () => {
  // repoFor(ctx) returns RepoScope, which has no `service` marker and no way to reach one.
  // The double cast is required because tsc REFUSES the direct one ("neither type sufficiently
  // overlaps") — which is itself the point: the compiler agrees the user-scoped face is not a
  // bag of properties that might happen to carry service authority.
  const scoped = repoFor(ctxFor(USER)) as unknown as Record<string, unknown>;
  assert.equal(scoped["service"], undefined, "a user-scoped repo exposed a service marker");
  assert.equal(serviceRepo().service, true);
});

// ── the field allowlist ──────────────────────────────────────────────────────────────────

test("repo: a client-supplied owner_id / id / created_at is DROPPED from a write", () => {
  const kept = allowedValues(NOTE, {
    title: "mine", owner_id: "victim", id: "forged", created_at: "1999-01-01", pinned: true,
  });
  assert.deepEqual(kept, { title: "mine", pinned: true });
});

test("repo: an UNDECLARED field is dropped — the schema is the allowlist, not a suggestion", () => {
  assert.deepEqual(allowedValues(NOTE, { title: "t", is_admin: true, role: "service_role" }), { title: "t" });
});

test("repo: the allowlist applies on the real create/update paths, not just the helper", async () => {
  const rec = recorder(); rec.install();
  const repo = repoFor(ctxFor(USER));
  await repo.create("note", { title: "t", owner_id: "victim", nope: 1 });
  await repo.update("note", "n1", { body: "b", id: "forged" });
  assert.deepEqual(rec.sent[0]!.values, { title: "t" });
  assert.deepEqual(rec.sent[1]!.values, { body: "b" });
});

// ── anonymous writes ─────────────────────────────────────────────────────────────────────

test("repo: an anonymous caller cannot write (no identity ⇒ no auth.uid() ⇒ service authority)", async () => {
  const rec = recorder(); rec.install();
  const anon = repoFor(ctxFor(null));
  for (const attempt of [
    () => anon.create("note", { title: "x" }),
    () => anon.update("note", "n1", { title: "x" }),
    () => anon.remove("note", "n1"),
  ]) {
    await assert.rejects(attempt, (e: unknown) => e instanceof RepoError && e.code === "forbidden");
  }
  assert.equal(rec.sent.length, 0, "an anonymous write reached the transport");
});

// ── fail-closed on absence ───────────────────────────────────────────────────────────────

test("repo: with NO provider installed, a query fails closed naming the fix", async () => {
  RepoSeam.transport = null;
  await assert.rejects(
    () => repoFor(ctxFor(USER)).list("note"),
    (e: unknown) => e instanceof RepoError && e.code === "no_provider",
  );
});

test("repo: an undeclared entity is refused — never a silent write to an unknown table", async () => {
  const rec = recorder(); rec.install();
  await assert.rejects(
    () => repoFor(ctxFor(USER)).create("ghost", { a: 1 }),
    (e: unknown) => e instanceof RepoError && e.code === "unknown_entity",
  );
  assert.equal(entitySpec("ghost"), null);
});

// ── list is bounded ──────────────────────────────────────────────────────────────────────

test("repo: a list page is always bounded (an unbounded list is an exfiltration primitive)", async () => {
  const rec = recorder(); rec.install();
  const repo = repoFor(ctxFor(USER));
  await repo.list("note", { limit: 10_000 });
  await repo.list("note", { limit: Number.NaN });
  await repo.list("note");
  for (const q of rec.sent) assert.ok(q.limit! <= LIST_LIMIT, `limit ${q.limit} exceeded the ceiling`);
});

test("repo: an undeclared filter is not a query (a client cannot filter by a column that is not storage)", async () => {
  const rec = recorder(); rec.install();
  await repoFor(ctxFor(USER)).list("note", { filters: { pinned: "true", owner_id: "victim", nope: "x" } });
  assert.deepEqual(rec.sent[0]!.filters, { pinned: "true" });
});

// ── the generated CRUD handler ───────────────────────────────────────────────────────────

test("crudHandler: a create reads ctx.body ONLY — never the merged args bag", async () => {
  const rec = recorder(); rec.install();
  const handler = crudHandler("note", "create");
  // the merged bag carries a hostile owner_id from the QUERY STRING; body is the real payload
  await handler(
    { owner_id: "victim", title: "from-args" },
    ctxFor(USER, { body: { title: "from-body" }, query: { owner_id: "victim" } }),
  );
  assert.deepEqual(rec.sent[0]!.values, { title: "from-body" }, "the handler trusted the merged args");
});

test("crudHandler: get/update/delete address the row from ctx.params, not from the body", async () => {
  const rec = recorder(); rec.install();
  await crudHandler("note", "get")({}, ctxFor(USER, { params: { id: "real-id" }, body: { id: "forged" } }));
  await crudHandler("note", "delete")({}, ctxFor(USER, { params: { id: "real-id" }, body: { id: "forged" } }));
  for (const q of rec.sent) assert.equal(q.id, "real-id", "the row id came from the payload rather than the path");
});

test("crudHandler: every generated op carries the caller's token", async () => {
  const rec = recorder(); rec.install();
  for (const op of ["list", "get", "create", "update", "delete"] as const) {
    await crudHandler("note", op)({}, ctxFor(USER, { params: { id: "n1" }, body: { title: "t" } }));
  }
  assert.equal(rec.sent.length, 5);
  for (const q of rec.sent) assert.equal(q.token, "alice.jwt.sig");
});
