//
//  postgres.live.test.ts — the proofs that ONLY a real database server can give.
//
//  `rls.postgres.test.ts` runs against PGlite: real Postgres, but one in-process connection
//  owned by a superuser. Two whole classes of failure are invisible there, and both were found
//  by running this file against Postgres 17 rather than by reading code:
//
//    A. THE TABLE-OWNER BYPASS. `alter table … enable row level security` does NOT apply to the
//       role that owns the table. Connected as the owner, Bob read Alice's row — policy present,
//       RLS "enabled", no error, no log line. PGlite cannot show this: its superuser bypasses RLS
//       unconditionally, so the suite there compensates with `set local role`, which is exactly
//       the step that hides the owner case. Supabase is unaffected (its API role does not own the
//       tables) but the ordinary self-hosted shape IS the owner: whoever ran the migration is
//       whoever the app connects as. The emitted migration now says `force row level security`.
//
//    B. THE POOL SCATTER, under genuine concurrency. Covered structurally in
//       `postgres.connection.test.ts` with recording fakes; here it runs against a real pool and
//       a real planner, which is the only place "the policy actually filtered the rows" is true
//       rather than modelled.
//
//  SKIPPING: this file needs a Postgres it may create databases and roles in. With none reachable
//  it SKIPS rather than fails, so CI without a database stays green — but a skip proves nothing,
//  which is why A and B also have always-on counterparts. Point it elsewhere with
//  DSX_TEST_ADMIN_URL, e.g. postgresql://user:pw@localhost:5432/postgres.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { readTraceContext } from "../src/trace.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { installEntities, repoFor, crudHandler, type EntitySpec } from "../src/repo.ts";
import { installPostgresPool } from "../src/postgres.ts";
import type { HostContext } from "../src/host.ts";

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "..", "deploy", "supabase", "migrations", "000_dsx_schema.sql");
const ROLES = join(HERE, "..", "deploy", "supabase", "migrations", "000_dsx_roles.sql");

const ADMIN = process.env.DSX_TEST_ADMIN_URL ?? "postgresql://localhost:5432/postgres";
const DB = "dsx_live_test";
const OWNER = "dsx_live_owner"; // owns the tables — NOT a superuser, or FORCE could not bite
const APP = "dsx_live_app"; // what the server connects as
const PW = "dsx-live-test";

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

const NOTE: EntitySpec = { entity: "note", fields: { title: "text", body: "text", pinned: "boolean" }, ownership: "owner" };

//  NO PREAMBLE IS DEFINED HERE ANY MORE, and that absence is the point.
//
//  This file used to create the `auth` schema, `auth.uid()` and the two roles itself before
//  applying the migration — which quietly meant the emitted artifacts were NOT self-sufficient.
//  A review applied the migration to a bare Postgres and got `ERROR: schema "auth" does not
//  exist`, zero tables: the `force row level security` this suite proves was guarding a database
//  the emitter could not actually create. The artifacts now carry it, and this test applies ONLY
//  emitted bytes to an empty cluster — which is the only way that claim can stay true.

async function reachable(): Promise<string | false> {
  const probe = new pg.Client({ connectionString: ADMIN, connectionTimeoutMillis: 1500 });
  try {
    await probe.connect();
    await probe.end();
    return false;
  } catch (e) {
    return `no Postgres at ${ADMIN} (${e instanceof Error ? e.message : String(e)}) — start one, or set DSX_TEST_ADMIN_URL`;
  }
}
const skip = await reachable();

//  Every test here is bounded. The suite runs under `--test-timeout=0`, so before this a stuck
//  connection did not fail — it HUNG, at 0% CPU, until the release gate's 20-minute stage
//  deadline killed the whole stage and blamed the deadline. Measured twice: fixtures surviving an
//  interrupted run (`dsx_live_test_bare` + its owner role) wedge the teardown that drops the
//  shared `anon`/`authenticated` roles, and the client then never sends again. Cleared of that
//  residue the same file passes in 618 ms, so a minute is ~100x the real budget and can only fire
//  on a genuine wedge — where a legible failure beats a silent twenty-minute stall.
const LIVE_TIMEOUT_MS = 60_000;
const live = { skip, timeout: LIVE_TIMEOUT_MS };

/** Build the database from scratch: roles, ownership, the EMITTED migration, grants. */
async function build(): Promise<{ appUrl: string; ownerUrl: string; drop: () => Promise<void> }> {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  // WITH (FORCE), like the teardown already used. A plain `drop database` BLOCKS FOREVER on
  // any lingering connection — a pool a previous case failed before closing, a server left
  // running — so the suite hung instead of failing, which is the worst way to be wrong.
  await admin.query(`drop database if exists ${DB} with (force)`);
  // `anon` and `authenticated` are CLUSTER-level and SHARED — 000_dsx_roles.sql creates them
  // idempotently and every DSX database in this cluster grants to them. Dropping them here (as
  // this file used to) reaches outside its own database and breaks any other live suite, or any
  // running server, that depends on them; it hung the full test run exactly once, which is once
  // more than a test should ever affect something it does not own. Only OUR roles are dropped.
  for (const r of [OWNER, APP]) await admin.query(`drop role if exists ${r}`);
  await admin.query(`create role ${OWNER} login password '${PW}'`);
  await admin.query(`create role ${APP} login password '${PW}'`);
  // anon / authenticated are deliberately NOT created here — the migration must create them.
  await admin.query(`create database ${DB} owner ${OWNER}`);
  await admin.query(`grant create on database ${DB} to ${OWNER}`);
  await admin.end();

  const url = (user: string) => `postgresql://${user}:${PW}@localhost:5432/${DB}`;

  // THE EMITTED ARTIFACTS, APPLIED EXACTLY AS A DEPLOY APPLIES THEM. No preamble, no grants, no
  // fixups written here — if a deploy needs it, an artifact must carry it.
  //
  //   000_dsx_roles.sql  — the cluster prerequisite, as a SUPERUSER (creating a role needs
  //                        CREATEROLE, which a database owner does not have).
  //   000_dsx_schema.sql — the schema, as the OWNER. That is the self-hosted shape under test:
  //                        whoever ran the migration is whoever the app connects as.
  const su = new pg.Client({ connectionString: ADMIN });
  await su.connect();
  await su.query(readFileSync(ROLES, "utf-8")); // emitted bytes, unedited
  await su.query(`grant anon, authenticated to ${APP}`); // a deploy's own step, not the schema's
  await su.end();

  const owner = new pg.Client({ connectionString: url(OWNER) });
  await owner.connect();
  await owner.query(readFileSync(MIGRATION, "utf-8")); // emitted bytes, unedited
  await owner.end();

  return {
    appUrl: url(APP),
    ownerUrl: url(OWNER),
    drop: async () => {
      const a = new pg.Client({ connectionString: ADMIN });
      await a.connect();
      await a.query(`drop database if exists ${DB} with (force)`);
      for (const r of [OWNER, APP]) await a.query(`drop role if exists ${r}`); // shared roles are not ours to drop
      await a.end();
    },
  };
}

function ctxFor(sub: string | null): HostContext {
  return {
    buildInfo: {},
    identity: sub === null ? null : { sub, role: "authenticated", claims: {}, token: `${sub}.jwt.sig` },
    env: () => undefined,
    query: {},
    body: {},
    params: {},
    correlationId: "live-test",
    trace: readTraceContext(new Headers()),
    request: new Request("https://test.invalid/"),
  };
}

installEntities([NOTE]);

/** Read as a bare connection would: set the claim, no role switch. That IS the self-hosted app. */
async function readAsOwnerClaiming(client: pg.Client, sub: string): Promise<string[]> {
  await client.query("begin");
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
  const r = await client.query("select title from dsx_note");
  await client.query("commit");
  return r.rows.map((x) => x.title as string);
}

// ── A. the table-owner bypass, and that FORCE closes it ──────────────────────────────────

test("live: the role that OWNS the table cannot read another user's rows (FORCE, not just ENABLE)", live, async () => {
  const { ownerUrl, drop } = await build();
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    // THE SEED IS ITSELF A PROOF. Under FORCE the owner connection cannot write a row it does
    // not own: the policy's `with check (owner_id = auth.uid())` rejects it (SQLSTATE 42501)
    // because auth.uid() is NULL. So the row has to be inserted while ADOPTING Alice's identity,
    // exactly as a request does. A bare owner insert must fail, and that is asserted first.
    await assert.rejects(
      owner.query("insert into dsx_note (owner_id, title) values ($1, 'x')", [ALICE]),
      /row-level security/,
      "the owner connection wrote a row for another user with no identity set — FORCE is not in effect",
    );
    await owner.query("begin");
    await owner.query("select set_config('request.jwt.claim.sub', $1, true)", [ALICE]);
    await owner.query("insert into dsx_note (owner_id, title) values ($1, 'alice private')", [ALICE]);
    await owner.query("commit");

    assert.deepEqual(
      await readAsOwnerClaiming(owner, BOB),
      [],
      "THE OWNER CONNECTION READ ANOTHER USER'S ROW — `enable row level security` does not bind the table owner; the migration must also say `force`",
    );
    assert.deepEqual(await readAsOwnerClaiming(owner, ALICE), ["alice private"], "FORCE locked the rightful owner out of her own row");

    // ── negative control: undo FORCE and the leak must come back, or this test proves nothing
    await owner.query("alter table dsx_note no force row level security");
    assert.deepEqual(
      await readAsOwnerClaiming(owner, BOB),
      ["alice private"],
      "with FORCE removed Bob STILL saw nothing — this test is not exercising the owner bypass at all",
    );
  } finally {
    await owner.end();
    await drop();
  }
});

test("live: the migration REFUSES, with a fix, when the cluster prerequisite is missing", live, async () => {
  // THIS CASE NEEDS THE SHARED ROLES ABSENT, and they are CLUSTER-level: dropping them would
  // reach outside this test's own database and break any other suite — or any running server —
  // that depends on them. So it drops them only when nothing else does, and otherwise skips
  // SAYING SO. The guard's text itself is asserted statically and unconditionally by
  // `prepare_server_test.rb`, so the property is never unverified — only this live half is.
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  const dependents = await admin.query(
    `select count(*)::int as n from pg_auth_members m
       join pg_roles r on r.oid = m.roleid
      where r.rolname in ('anon','authenticated')`,
  );
  if (dependents.rows[0].n > 0) {
    await admin.end();
    console.log("[skip] another database grants the shared anon/authenticated roles — not dropping cluster state this test does not own");
    return;
  }
  await admin.query(`drop database if exists ${DB}_bare with (force)`);
  await admin.query(`drop role if exists ${OWNER}_bare`);
  await admin.query(`create role ${OWNER}_bare login password '${PW}'`);
  await admin.query(`create database ${DB}_bare owner ${OWNER}_bare`);
  // deliberately do NOT apply 000_dsx_roles.sql
  await admin.query('drop role if exists anon');
  await admin.query('drop role if exists authenticated');
  await admin.end();

  const owner = new pg.Client({ connectionString: `postgresql://${OWNER}_bare:${PW}@localhost:5432/${DB}_bare` });
  await owner.connect();
  try {
    // Postgres' own answer here is `role "anon" does not exist`, from inside a grant — no cause,
    // no fix, and the tables would already be half-created. The migration must beat it to that.
    await assert.rejects(
      owner.query(readFileSync(MIGRATION, "utf-8")),
      (e: Error & { hint?: string; detail?: string }) => {
        assert.match(e.message, /roles `anon` and `authenticated` do not exist/);
        assert.match(String(e.hint), /000_dsx_roles\.sql/, "the refusal must name the artifact that fixes it");
        return true;
      },
    );
    // …and it must refuse BEFORE creating anything, or a retry meets a half-built schema.
    const tables = await owner.query("select count(*)::int as n from pg_tables where tablename like 'dsx_%'");
    assert.equal(tables.rows[0].n, 0, "the migration created tables before discovering it could not finish");
  } finally {
    await owner.end();
    const a = new pg.Client({ connectionString: ADMIN });
    await a.connect();
    await a.query(`drop database if exists ${DB}_bare with (force)`);
    await a.query(`drop role if exists ${OWNER}_bare`);
    await a.end();
  }
});

// ── B. the pool, under real concurrency, against a real planner ──────────────────────────

test("live: 16 concurrent requests through a real pg.Pool — no request sees another user's row", live, async () => {
  const { appUrl, drop } = await build();
  const pool = new pg.Pool({ connectionString: appUrl, max: 8 });
  try {
    installPostgresPool(pool);

    // Alice writes through the GENERATED CRUD handler
    await crudHandler("note", "create")({}, { ...ctxFor(ALICE), body: { title: "alice private", pinned: true } });

    const callers = Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? ALICE : BOB));
    const results = await Promise.all(callers.map((sub) => repoFor(ctxFor(sub)).list("note") as Promise<unknown[]>));

    const bobSaw = results.filter((_, i) => callers[i] === BOB).filter((rows) => rows.length > 0);
    assert.equal(bobSaw.length, 0, `BOB READ ALICE'S ROW IN ${bobSaw.length} OF 8 CONCURRENT REQUESTS — the transaction is being scattered across pooled connections`);

    const aliceMissed = results.filter((_, i) => callers[i] === ALICE).filter((rows) => rows.length !== 1);
    assert.equal(aliceMissed.length, 0, `Alice failed to read her OWN row in ${aliceMissed.length} of 8 requests — identity is not reaching the statement`);

    // Anonymous, under the same load. An `owner` table grants nothing to `anon` (the grant bought
    // no rows — the policy is `owner_id = auth.uid()` and auth.uid() is NULL — and only published
    // the table's shape into the auto-generated GraphQL schema), so this is REFUSED at the ACL
    // rather than answered with an empty list. Stricter than it was: the assertion is that no
    // anonymous read produces a row, and now none of them produces an answer at all.
    const anon = await Promise.allSettled(Array.from({ length: 4 }, () => repoFor(ctxFor(null)).list("note") as Promise<unknown[]>));
    const anonRows = anon.flatMap((r) => (r.status === "fulfilled" ? (r.value as unknown[]) : []));
    assert.deepEqual(anonRows, [], "an anonymous read reached another user's data under concurrency");
    assert.ok(
      anon.every((r) => r.status === "rejected"),
      "an anonymous read of an OWNER table must be refused at the ACL, not answered with an empty list",
    );
  } finally {
    await pool.end();
    await drop();
  }
});

test("live: a service-scope read is NOT how an anonymous caller is treated", live, async () => {
  const { appUrl, drop } = await build();
  const pool = new pg.Pool({ connectionString: appUrl, max: 4 });
  try {
    installPostgresPool(pool);
    await crudHandler("note", "create")({}, { ...ctxFor(ALICE), body: { title: "alice private" } });
    // `anon` role on an owner table ⇒ REFUSED. If scope were inferred from "no token" this would
    // return Alice's row; instead the ACL refuses before RLS is consulted, because an owner entity
    // grants nothing to `anon`. The property under test is unchanged and the outcome is stronger:
    // the anonymous caller is not merely shown nothing, it cannot address the table.
    await assert.rejects(
      () => repoFor(ctxFor(null)).list("note"),
      /permission denied/i,
      "an anonymous caller must not be silently answered with an empty list on an owner table",
    );
  } finally {
    await pool.end();
    await drop();
  }
});

// ── C. schema evolution: the migration must converge an EXISTING database ────────────────

test("live: a field added after the first deploy actually reaches an existing database", live, async () => {
  const { ownerUrl, drop } = await build();
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    // Simulate the week-two change WITHOUT re-running the emitter: drop a declared column, then
    // re-apply the emitted migration. If the migration only ever said `create table if not
    // exists`, the column stays missing — which is exactly what happened before, and what makes
    // a declared field silently absent in production while the build reports success.
    await owner.query("alter table dsx_note drop column pinned");
    const before = await owner.query("select count(*)::int as n from information_schema.columns where table_name='dsx_note' and column_name='pinned'");
    assert.equal(before.rows[0].n, 0, "the column should be gone for this test to mean anything");

    await owner.query(readFileSync(MIGRATION, "utf-8")); // the emitted bytes, re-applied

    const after = await owner.query("select count(*)::int as n from information_schema.columns where table_name='dsx_note' and column_name='pinned'");
    assert.equal(after.rows[0].n, 1, "re-applying the migration did NOT restore a declared column — `create table if not exists` is a no-op on an existing table, so every field added after the first deploy is silently missing");
  } finally {
    await owner.end();
    await drop();
  }
});
