//
//  provision.postgres.test.ts — the reserved `dsx_` namespace against a REAL Postgres (PGlite).
//
//  THE PRODUCT LAW THIS DEFENDS: the customer owns the database, Despia owns the system tables
//  inside it, and nobody is ever asked to write this SQL or to know it exists. So these assert
//  the three things a person would otherwise have to do by hand — find out what is missing,
//  create it, and prove it worked — against a database rather than against a string.
//
//  It exists because the two emitters had already drifted apart: the monorepo pipeline wrote the
//  counter and event tables into its migration and the standalone `despia build` wrote neither,
//  so a customer deployment metered spend against a table that did not exist. The registry is
//  now the single source of truth, and the last test here is the end-to-end proof: apply the
//  EMITTED migration, byte for byte, and the runtime's own planes work on top of it.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { PGlite } from "@electric-sql/pglite";

import {
  ddlStatements,
  inspectSystemStorage,
  installPostgresClient,
  provisionSystemStorage,
  systemSchemaSql,
  systemTables,
  type SqlClient,
} from "../src/postgres.ts";
import { RateLimitSeam } from "../src/ratelimit.ts";
import { RealtimeSeam } from "../src/realtime.ts";
import { chargeSpend, configureSpend, flushSpendNow, resetSpend, SpendSeam } from "../src/spend.ts";

//  A bare database — the platform roles only, and NOT the schema. Every test here starts from
//  what a customer's Postgres actually looks like before Despia has ever touched it.
const PLATFORM_PREAMBLE = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
`;

const QUEUES = ["mail"];

async function bare(): Promise<{ db: PGlite; client: SqlClient }> {
  const db = await new PGlite();
  await db.exec(PLATFORM_PREAMBLE);
  const client: SqlClient = {
    query: async (text, params) => {
      const r = await db.query(text, params as never[]);
      return { rows: r.rows as unknown[] };
    },
  };
  return { db, client };
}

function uninstall(): void {
  resetSpend();
  SpendSeam.store = null;
  RateLimitSeam.store = null;
  RealtimeSeam.transport = null;
}

test("provision: a database Despia has never touched reports every system table missing", async () => {
  const { db, client } = await bare();
  try {
    const status = await inspectSystemStorage(client, QUEUES);
    assert.deepEqual(status.map((s) => s.table), ["dsx_rate_counter", "dsx_event", "dsx_queue_mail"]);
    assert.ok(status.every((s) => !s.present && !s.ok), "a bare database must report nothing present");
    // The report is written to be read by a person in a repair prompt, not by a DBA.
    assert.match(status[0]!.purpose, /spend ceilings/);
  } finally {
    await db.close();
  }
});

test("provision: creates what is missing, verifies by re-reading, and names what it repaired", async () => {
  const { db, client } = await bare();
  try {
    const first = await provisionSystemStorage(client, QUEUES);
    assert.deepEqual(first.created, ["dsx_rate_counter", "dsx_event", "dsx_queue_mail"]);
    assert.deepEqual(first.damaged, []);
    assert.equal(first.verified, true);
    assert.ok(first.tables.every((t) => t.ok && t.present && t.missingColumns.length === 0));

    //  IDEMPOTENT: the second run is the same operation and creates nothing. This is what makes
    //  "repair" and "first provision" one code path — there is no repair mode to get wrong.
    const second = await provisionSystemStorage(client, QUEUES);
    assert.deepEqual(second.created, []);
    assert.equal(second.verified, true);
  } finally {
    await db.close();
  }
});

test("provision: damage is found and repaired — a dropped table and a dropped column, by name", async () => {
  const { db, client } = await bare();
  try {
    await provisionSystemStorage(client, QUEUES);

    //  What a person actually does to a database they own: drop something they did not recognise,
    //  and alter something they did.
    await db.exec("drop table dsx_event;");
    await db.exec("alter table dsx_rate_counter drop column expires_at;");

    const damaged = await inspectSystemStorage(client, QUEUES);
    const byName = new Map(damaged.map((t) => [t.table, t]));
    //  ABSENT and DAMAGED are different answers, because they are different sentences in the
    //  prompt: one table is gone, the other is present and cannot serve the runtime.
    assert.equal(byName.get("dsx_event")!.present, false);
    assert.equal(byName.get("dsx_rate_counter")!.present, true);
    assert.deepEqual(byName.get("dsx_rate_counter")!.missingColumns, ["expires_at"]);
    assert.equal(byName.get("dsx_queue_mail")!.ok, true, "an untouched table must not read as damaged");
    assert.equal(damaged.filter((t) => !t.ok).length, 2, "exactly two internal tables need repair");

    //  The dropped TABLE comes back; the ALTERED one is named and left alone, and the run does
    //  not verify — which is what stops a deploy publishing against a database that cannot serve.
    const repair = await provisionSystemStorage(client, QUEUES);
    assert.deepEqual(repair.created, ["dsx_event"]);
    assert.deepEqual(repair.damaged, ["dsx_rate_counter"]);
    assert.equal(repair.verified, false);
    assert.deepEqual(
      repair.tables.filter((t) => !t.ok).map((t) => [t.table, t.missingColumns]),
      [["dsx_rate_counter", ["expires_at"]]],
    );

    //  And once a person has dealt with the table somebody altered, the same command finishes
    //  the job: no separate repair mode, no second code path.
    await db.exec("drop table dsx_rate_counter;");
    const done = await provisionSystemStorage(client, QUEUES);
    assert.deepEqual(done.created, ["dsx_rate_counter"]);
    assert.equal(done.verified, true);
  } finally {
    await db.close();
  }
});

test("provision: every statement applies on its own, so no driver privilege is assumed", async () => {
  //  provisionSystemStorage never sends multi-statement text: `pg` would accept it and a
  //  parameterised or embedded driver would not, which is a deploy that works on our machine.
  //  PGlite's query() is exactly such a driver, so these tests ARE that proof — and this asserts
  //  the split itself, including the guard that fires if a script grows a dollar-quoted body.
  for (const spec of systemTables(QUEUES)) {
    const statements = ddlStatements(spec.sql);
    assert.ok(statements.length > 1, `${spec.table} should split into statements`);
    assert.ok(statements.every((s) => !s.startsWith("--")), "comments are not statements");
    assert.ok(statements[0]!.startsWith("create table if not exists"), "convergent DDL leads with create-if-not-exists");
  }
  assert.throws(() => ddlStatements("create function f() as $$ select 1 $$;"), /dollar-quoted/);
});

test("provision: the runtime's own planes work on a database the provisioner alone created", async () => {
  //  THE END-TO-END CLAIM. Nothing here applies a hand-written migration or a fixture: the
  //  provisioner creates the namespace, and then the planes that failed before it existed —
  //  the durable spend counters and the event feed — run against what it made.
  const { db, client } = await bare();
  try {
    const outcome = await provisionSystemStorage(client, QUEUES);
    assert.equal(outcome.verified, true);
    installPostgresClient(client);

    configureSpend([{ of: "requests", per: "day", max: 10 }]);
    chargeSpend("requests", 4);
    await flushSpendNow();
    const counted = await db.query<{ count: number }>("select count from dsx_rate_counter where bucket like 'spend|%'");
    assert.equal(Number(counted.rows[0]?.count), 4, "the spend plane's durable counter must have a table to land in");

    await RealtimeSeam.transport!.publish({ channel: "dsx_spend", ownerId: null, payload: { budget: "requests" } });
    const events = await db.query<{ channel: string }>("select channel from dsx_event");
    assert.deepEqual(events.rows.map((r) => r.channel), ["dsx_spend"], "the event feed must have a table to land in");
  } finally {
    uninstall();
    await db.close();
  }
});

test("provision: the emitted schema and the registry are one source of truth", () => {
  //  The script the migration carries IS the registry's, so a table cannot be created by the
  //  build and forgotten by the provisioner (or the reverse) — the drift that made this work.
  const script = systemSchemaSql(QUEUES);
  for (const spec of systemTables(QUEUES)) {
    assert.ok(script.includes(spec.sql.trimEnd()), `${spec.table} must be in the emitted schema verbatim`);
  }
});
