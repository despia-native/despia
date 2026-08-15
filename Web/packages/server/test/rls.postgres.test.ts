//
//  rls.postgres.test.ts — THE ISOLATION PROOF (plan B5).
//
//      user A cannot read user B's rows.
//
//  Every other server suite runs against a recording transport: they prove what the repository
//  SENDS. That is necessary and not sufficient — the sentence above is a claim about what a
//  DATABASE does, and no amount of mocking can establish it. This file executes it.
//
//  WHAT IS REAL HERE, and what is not:
//    • REAL: the Postgres engine (PGlite is the actual Postgres source compiled to WASM — same
//      planner, same executor, same row-level-security machinery).
//    • REAL: the migration. The schema is read from the EMITTED
//      deploy/supabase/migrations/000_dsx_schema.sql — the same bytes a deploy applies. Nothing
//      is hand-written here, so a policy this test proves is a policy the emitter really writes.
//    • REAL: the code path. Requests go through `crudHandler` → `repoFor(ctx)` → the transport,
//      i.e. the generated CRUD handler that ships, not a shortcut.
//    • NOT REAL: the network. Supabase fronts Postgres with PostgREST over HTTP; this speaks SQL
//      directly. The POLICY semantics are identical (PostgREST sets the same role and the same
//      request settings), but connection pooling and the HTTP layer are unproven here.
//
//  The Supabase-provided preamble (the `auth` schema, `auth.uid()`, and the three roles) is NOT
//  part of the emitted migration because a real Supabase project already has it. It is created
//  here to stand in for the hosted platform, and it is the standard definition.
//
//  THE TEST MUST BE ABLE TO FAIL. The last case disables row-level security and asserts that B
//  then DOES see A's row. Without it, a suite that passed because the table was empty, or
//  because `auth.uid()` returned NULL for everyone, would look identical to a suite that passed
//  because the policy works.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { readTraceContext } from "../src/trace.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { installEntities, repoFor, crudHandler, RepoSeam, type EntitySpec } from "../src/repo.ts";
import { installPostgresClient, buildStatement, type SqlClient } from "../src/postgres.ts";
import type { HostContext } from "../src/host.ts";

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "..", "deploy", "supabase", "migrations", "000_dsx_schema.sql");

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

// The entity exactly as the emitter declares it (generated/entities.json).
const NOTE: EntitySpec = {
  entity: "note",
  fields: { title: "text", body: "text", pinned: "boolean" },
  ownership: "owner",
};

/** What a hosted Supabase project already provides, and the emitted migration therefore assumes. */
const PLATFORM_PREAMBLE = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
`;

async function database(): Promise<{ db: PGlite; client: SqlClient }> {
  const db = await new PGlite();
  await db.exec(PLATFORM_PREAMBLE);
  await db.exec(readFileSync(MIGRATION, "utf-8")); // the EMITTED migration, byte for byte
  await db.exec(`
    grant usage on schema public to anon, authenticated;
    grant all on all tables in schema public to anon, authenticated;
  `);
  const client: SqlClient = {
    query: async (text, params) => {
      const r = await db.query(text, params as never[]);
      return { rows: r.rows as unknown[] };
    },
  };
  installPostgresClient(client);
  return { db, client };
}

function ctxFor(sub: string | null): HostContext {
  return {
    buildInfo: {},
    identity: sub === null ? null : { sub, role: "authenticated", claims: {}, token: `${sub}.jwt.sig` },
    env: () => undefined,
    query: {},
    body: {},
    params: {},
    correlationId: "rls-test",
    trace: readTraceContext(new Headers()),
    request: new Request("https://test.invalid/"),
  };
}

installEntities([NOTE]);

// ── the proof ────────────────────────────────────────────────────────────────────────────

test("RLS: user A cannot read, update or delete user B's rows — against a real Postgres", async () => {
  const { db } = await database();
  try {
    // Alice writes a note through the GENERATED CRUD handler, not a raw insert.
    const created = (await crudHandler("note", "create")(
      {},
      { ...ctxFor(ALICE), body: { title: "alice private", body: "her secret", pinned: true } },
    )) as { id: string; owner_id: string; title: string };

    assert.equal(created.title, "alice private");
    assert.equal(created.owner_id, ALICE, "owner_id must be assigned from the verified identity, not the payload");

    // Alice sees exactly her row.
    const alicesList = (await repoFor(ctxFor(ALICE)).list("note")) as unknown[];
    assert.equal(alicesList.length, 1);

    // ── THE CLAIM ──
    const bobsList = (await repoFor(ctxFor(BOB)).list("note")) as unknown[];
    assert.deepEqual(bobsList, [], "BOB READ ALICE'S ROWS — row-level security is not in force");

    // Nor by addressing the row directly: a filtered row is indistinguishable from a missing one.
    assert.equal(await repoFor(ctxFor(BOB)).get("note", created.id), null, "Bob fetched Alice's row by id");

    // Nor by writing to it.
    assert.equal(await repoFor(ctxFor(BOB)).update("note", created.id, { title: "defaced" }), null, "Bob updated Alice's row");
    assert.equal(await repoFor(ctxFor(BOB)).remove("note", created.id), null, "Bob deleted Alice's row");

    // And Alice's row survived all of it, unchanged.
    const after = (await repoFor(ctxFor(ALICE)).list("note")) as { title: string }[];
    assert.equal(after.length, 1);
    assert.equal(after[0]!.title, "alice private");
  } finally {
    await db.close();
  }
});

test("RLS: an anonymous caller reads nothing — 'no identity' must not mean 'the server itself'", async () => {
  const { db } = await database();
  try {
    await crudHandler("note", "create")({}, { ...ctxFor(ALICE), body: { title: "alice private" } });
    // scope stays "user" with no subject ⇒ role `anon` ⇒ the owner policy yields nothing.
    // If an anonymous query ever ran as the service role instead, this returns the row.
    assert.deepEqual(await repoFor(ctxFor(null)).list("note"), [], "an anonymous read reached another user's data");
  } finally {
    await db.close();
  }
});

test("RLS: a client-supplied owner_id cannot steal a row — the allowlist holds against a real insert", async () => {
  const { db } = await database();
  try {
    const created = (await crudHandler("note", "create")(
      {},
      { ...ctxFor(ALICE), body: { title: "t", owner_id: BOB, id: "33333333-3333-3333-3333-333333333333" } },
    )) as { id: string; owner_id: string };
    assert.equal(created.owner_id, ALICE, "a posted owner_id was written — the row would belong to someone else");
    assert.notEqual(created.id, "33333333-3333-3333-3333-333333333333", "a posted id was written");
  } finally {
    await db.close();
  }
});

// ── the negative control: this suite must be capable of failing ──────────────────────────

test("RLS: with the policy OFF, Bob DOES see Alice's row (proving these tests can fail)", async () => {
  const { db } = await database();
  try {
    await crudHandler("note", "create")({}, { ...ctxFor(ALICE), body: { title: "alice private" } });
    await db.exec("alter table dsx_note disable row level security");
    const bobsList = (await repoFor(ctxFor(BOB)).list("note")) as unknown[];
    assert.equal(bobsList.length, 1, "even with RLS disabled Bob saw nothing — the test is not exercising the policy at all");
  } finally {
    await db.close();
  }
});

// ── the statement builder, without a database ────────────────────────────────────────────

test("postgres: every value is a placeholder and every identifier is validated", () => {
  const base = { entity: "note", token: null, subject: ALICE, scope: "user" } as const;
  const create = buildStatement({ ...base, op: "create", values: { title: "x", pinned: true } });
  assert.match(create.text, /^insert into dsx_note \(title, pinned\) values \(\$1, \$2\) returning \*$/);
  assert.deepEqual(create.params, ["x", true]);

  const list = buildStatement({ ...base, op: "list", filters: { pinned: "true" }, limit: 25 });
  assert.match(list.text, /where pinned = \$1 order by created_at desc limit \$2/);
  assert.deepEqual(list.params, ["true", 25]);

  // A hostile entity or column name never reaches the SQL text.
  assert.throws(() => buildStatement({ ...base, entity: "note; drop table dsx_note", op: "get", id: "1" }), /not a legal identifier/);
  assert.throws(() => buildStatement({ ...base, op: "list", filters: { "a; drop table x": "1" } }), /not a legal identifier/);
});

test("postgres: the SERVICE scope does not switch role — and the seam stays fillable", async () => {
  const seen: string[] = [];
  const client: SqlClient = {
    query: async (text) => {
      seen.push(text);
      return { rows: [] };
    },
  };
  installPostgresClient(client);
  await RepoSeam.transport!({ entity: "note", op: "list", token: null, subject: null, scope: "service" });
  assert.equal(seen.some((s) => s.startsWith("set local role")), false, "a service query switched to a user role");
  seen.length = 0;
  await RepoSeam.transport!({ entity: "note", op: "list", token: null, subject: null, scope: "user" });
  assert.ok(seen.includes("set local role anon"), "an anonymous user query did not drop to the anon role");
});
