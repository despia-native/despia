//
//  idempotency.live.test.ts — the AT-LEAST-ONCE contract, replayed against a real Postgres.
//
//  `queue.ts` states the guarantee plainly: "Delivery is therefore AT LEAST ONCE, which is the
//  only honest guarantee a queue can make across a crash, and it is why idempotency is declared on
//  the ROW (the queue table's `idempotency_key text not null unique`) rather than assumed by
//  handler code." That sentence is a claim about what a DATABASE does under replay, and the
//  suites that exist do not settle it:
//
//    • `queue.postgres.test.ts` runs the lease protocol against PGlite — one connection, so a
//      genuine concurrent redelivery cannot be staged there.
//    • `queue.live.test.ts` proves `for update skip locked` gives two SIMULTANEOUS claims disjoint
//      sets. That is the exclusion half.
//
//  This file is the REPLAY half — what happens when the same event arrives twice, which is the
//  normal case the guarantee exists to absorb, not an error case:
//
//    1. AN UPSTREAM RETRY. A webhook sender that did not see the 200 sends the event again. The
//       row's UNIQUE key must refuse the duplicate ENQUEUE, so a replayed delivery cannot become
//       two queue rows and be handled twice.
//    2. A CRASHED DRAIN. A drain claims, the process dies before it can ack, the lease expires.
//       The message MUST come back (nothing was lost) and MUST be handled again (at-least-once,
//       not at-most-once) — and the handler must be able to tell it is a replay from `attempt`.
//    3. AN ACKED MESSAGE IS NOT REDELIVERED, and its key STILL refuses a re-enqueue. Acking keeps
//       the row precisely so the idempotency history survives the work.
//
//  SKIPPING: needs a real Postgres it may create a database in (DSX_TEST_ADMIN_URL), and SKIPS
//  cleanly without one. The protocol itself is covered always-on by `queue.test.ts`.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { drainQueue, QueueSeam, type QueueMessage } from "../src/queue.ts";
import { installPostgresPool, queueTableSql } from "../src/postgres.ts";

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, "..", "deploy", "supabase", "migrations", "000_dsx_schema.sql");
const ROLES = join(HERE, "..", "deploy", "supabase", "migrations", "000_dsx_roles.sql");

const ADMIN = process.env["DSX_TEST_ADMIN_URL"] ?? "postgresql://localhost:5432/postgres";
const DB = "dsx_idempotency_test";
const OWNER = "dsx_idem_owner";
const PW = "dsx-idem-test";
const QUEUE = "webhooks";
const TABLE = "dsx_queue_webhooks";

async function reachable(): Promise<string | false> {
  const probe = new pg.Client({ connectionString: ADMIN });
  try {
    await probe.connect();
    await probe.end();
    return false;
  } catch (e) {
    return `no postgres at ${ADMIN} (${e instanceof Error ? e.message : String(e)})`;
  }
}

const skip = await reachable();

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** A database carrying ONLY emitted bytes plus the transport's own declared lease columns. */
async function database(): Promise<{ pool: pg.Pool; end: () => Promise<void> }> {
  await admin(`drop database if exists ${DB}`);
  await admin(`drop role if exists ${OWNER}`);
  await admin(`create role ${OWNER} login password '${PW}'`);
  await admin(`create database ${DB} owner ${OWNER}`);
  await admin(readFileSync(ROLES, "utf-8"));

  const dbUrl = ADMIN.replace(/\/[^/]*$/, `/${DB}`);
  const grant = new pg.Client({ connectionString: dbUrl });
  await grant.connect();
  try {
    await grant.query(`grant anon, authenticated to ${OWNER}`);
  } finally {
    await grant.end();
  }

  const ownerUrl = dbUrl.replace(/^postgresql:\/\//, `postgresql://${OWNER}:${PW}@`);
  const migrate = new pg.Client({ connectionString: ownerUrl });
  await migrate.connect();
  try {
    await migrate.query(readFileSync(SCHEMA, "utf-8")); // the EMITTED schema, byte for byte
    await migrate.query(queueTableSql(QUEUE)); // the lease columns the claim protocol declares
  } finally {
    await migrate.end();
  }

  const pool = new pg.Pool({ connectionString: ownerUrl });
  installPostgresPool(pool);
  const end = async (): Promise<void> => {
    QueueSeam.transport = null;
    await pool.end().catch(() => {});
    await admin(`drop database if exists ${DB}`).catch(() => {});
    await admin(`drop role if exists ${OWNER}`).catch(() => {});
  };
  return { pool, end };
}

/** Enqueue one event. Returns the error when the row's UNIQUE key refuses it. */
async function enqueue(pool: pg.Pool, key: string): Promise<Error | null> {
  try {
    await pool.query(`insert into ${TABLE} (idempotency_key, payload) values ($1, $2)`, [key, JSON.stringify({ event: key })]);
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

async function countRows(pool: pg.Pool, key: string): Promise<number> {
  const r = await pool.query(`select count(*)::int as n from ${TABLE} where idempotency_key = $1`, [key]);
  return (r.rows[0] as { n: number }).n;
}

test("idempotency.live: an UPSTREAM RETRY cannot become a second queue row", { skip }, async () => {
  const { pool, end } = await database();
  try {
    assert.equal(await enqueue(pool, "evt-1"), null, "the first delivery must be accepted");

    // The sender did not see our 200 and sends the identical event again.
    const replay = await enqueue(pool, "evt-1");
    assert.ok(replay !== null, "THE DUPLICATE WAS ACCEPTED — the UNIQUE idempotency key is not doing its job");
    assert.match(replay.message, /duplicate key|unique/i, "the refusal must come from the row's own constraint, not from application code");
    assert.equal(await countRows(pool, "evt-1"), 1, "a replayed event must leave exactly one row");

    // And the work happens once, not twice.
    const handled: string[] = [];
    const result = await drainQueue(QUEUE, async (m: QueueMessage) => { handled.push(m.key); });
    assert.deepEqual(handled, ["evt-1"], "the replayed event must be handled exactly once");
    assert.equal(result.drained, 1);
  } finally {
    await end();
  }
});

test("idempotency.live: a CRASHED drain loses nothing and the replay is visible as one", { skip }, async () => {
  const { pool, end } = await database();
  try {
    await enqueue(pool, "evt-2");

    // A drain that claims and then dies: the handler throws in a way that leaves the message
    // leased rather than acked. A zero lease is how this file stages "the lease expired" without
    // sleeping — the protocol's own visibilityMs, set to nothing.
    let firstAttempt = 0;
    await drainQueue(QUEUE, async (m: QueueMessage) => {
      firstAttempt = m.attempt;
      throw new Error("the drain process died here");
    }, { visibilityMs: 0 });
    assert.equal(firstAttempt, 1, "a first delivery is attempt 1");

    const stillThere = await pool.query(`select processed_at, attempts from ${TABLE} where idempotency_key = 'evt-2'`);
    const row = stillThere.rows[0] as { processed_at: unknown; attempts: number };
    assert.equal(row.processed_at, null, "NOTHING WAS ACKED, so nothing may be marked processed — that is the whole at-least-once contract");

    // The redelivery. It must arrive, and it must announce itself as a replay.
    const replays: number[] = [];
    const second = await drainQueue(QUEUE, async (m: QueueMessage) => {
      replays.push(m.attempt);
      assert.deepEqual(m.payload, { event: "evt-2" }, "the payload must survive the replay verbatim");
    }, { visibilityMs: 0 });
    assert.equal(second.drained, 1, "the message did NOT come back — a crashed drain lost work");
    assert.deepEqual(replays, [2], "attempt must climb, or a handler cannot tell a replay from a first delivery");
  } finally {
    await end();
  }
});

test("idempotency.live: an ACKED message is never redelivered, and its key still refuses a re-enqueue", { skip }, async () => {
  const { pool, end } = await database();
  try {
    await enqueue(pool, "evt-3");
    assert.equal((await drainQueue(QUEUE, async () => {})).drained, 1);

    // Redelivery: none. The work is done.
    assert.equal((await drainQueue(QUEUE, async () => { throw new Error("must never run"); })).claimed, 0, "an acked message came back — at-least-once became at-least-twice");

    // History: kept. This is why an ack does not delete the row.
    const late = await enqueue(pool, "evt-3");
    assert.ok(late !== null, "a LATE duplicate of already-done work was accepted — the idempotency history was thrown away with the row");
    assert.equal(await countRows(pool, "evt-3"), 1);
  } finally {
    await end();
  }
});
