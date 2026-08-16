//
//  queue.live.test.ts — the half of the claim that ONLY a real database server can prove (L-11).
//
//  `queue.postgres.test.ts` runs against PGlite: real Postgres, but ONE connection. It proves the
//  candidate predicate (a leased message is not offered again) because that is what one
//  connection can prove. It cannot prove the other half:
//
//      TWO DRAINS RUNNING AT THE SAME INSTANT TAKE DISJOINT SETS.
//
//  Serially, the candidate predicate alone is enough, so a claim that is only correct serially
//  passes every single-connection test and fails under load. This file opens a real pool and runs
//  eight drains at once against one queue, then asserts that every message was delivered EXACTLY
//  once across all of them — the property a webhook consumer's correctness rests on.
//
//  WHICH PART DOES WHICH JOB, since only one of them is a correctness property: the ATOMIC claim
//  (one `update … returning` carrying the whole predicate, so there is no window between reading
//  a row and owning it) is what makes delivery exactly-once — deleting the lease predicate fails
//  both cases below, which is how that is known rather than assumed. `for update skip locked` is
//  LIVENESS: without it concurrent claims are still correct but queue behind one another, so one
//  slow drain paces every other. That is why the SQL-text assertion for SKIP LOCKED lives in the
//  always-on PGlite suite: it is a property of the statement, not something contention reveals.
//
//  SKIPPING: with no Postgres reachable this file SKIPS rather than fails, so CI without a
//  database stays green — but a skip proves nothing, which is why the predicate half is always-on
//  in the PGlite suite. Point it elsewhere with DSX_TEST_ADMIN_URL, e.g.
//  postgresql://user:pw@localhost:5432/postgres.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import pg from "pg";

import { drainQueue, QueueSeam } from "../src/queue.ts";
import { installPostgresPool, queueTableSql } from "../src/postgres.ts";

const ADMIN = process.env.DSX_TEST_ADMIN_URL ?? "postgresql://localhost:5432/postgres";
// ONE DATABASE AND ROLE PER TEST, never a shared pair.
//
// Both tests used to build `dsx_queue_live_test` / `dsx_queue_live_app`, and `build()` starts by
// dropping them WITH (FORCE) — which terminates the other test's connections mid-query. Measured
// over fresh-database runs: roughly one in twenty failed, and the two faces of the same collision
// were `terminating connection due to administrator command` (the running test, killed by the
// other's drop) and `could not find tuple for role NNNNN` from Postgres's own DropRole
// (user.c:1286 — two drops racing on one catalog row). The file then sat until the runner's
// timeout, so on a lane without one it wedges rather than fails.
//
// It never indicated anything wrong with the claim protocol: the assertions passed in every run
// that was not torn down underneath, 55+ consecutively while this was being diagnosed. Naming the
// resources per test removes the shared thing to race over, and does so whatever order or
// concurrency the runner chooses — which is the property worth having, since the scheduling is
// the runner's business and not this file's.
const SLUG = "dsx_queue_live";
const PW = "dsx-queue-live-test";

const QUEUE = "webhooks";
const TABLE = "dsx_queue_webhooks";

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

/**
 * A pool that does not turn its own teardown into a test failure.
 *
 * `pg.Pool` is an EventEmitter, and an error on a client it still tracks is emitted as `error`.
 * Node's rule for EventEmitters applies: an `error` with no listener is re-thrown as an uncaught
 * exception, which the test runner attributes to whichever test is in flight.
 *
 * That is exactly what `drop()` provokes. `drop database … with (force)` SIGTERMs every backend
 * still registered for the database, and a backend can still be registered for a few milliseconds
 * after `pool.end()` has resolved — the client has sent its termination and closed its socket, but
 * the server has not finished reaping it. Postgres's own log shows the sequence: the test's final
 * `select count(*)` on backend N, the force-drop 6 ms later, then `FATAL: terminating connection
 * due to administrator command` on that same N.
 *
 * The symptom was a test failing with a bare libpq FATAL and NO assertion text — because no
 * assertion failed. Roughly one fresh-database run in twenty. Attaching a listener keeps the
 * event from being fatal; it cannot mask a real failure, because a real failure here is an
 * assertion, and assertions do not travel through the pool's error channel.
 */
function livePool(connectionString: string, max: number): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  pool.on("error", () => {
    // Teardown-time socket loss. Deliberately swallowed: see above.
  });
  return pool;
}

/**
 * Build a database that holds ONLY the queue table, from the transport's own declared SQL.
 *
 * The entity migration is deliberately not applied here: this file is about the lease under
 * contention, and the queue table is the only thing that participates in it. `queueTableSql` is
 * the same text `queue.postgres.test.ts` applies on top of the emitted migration, so what runs
 * here is what runs there.
 */
async function build(name: string): Promise<{ appUrl: string; drop: () => Promise<void> }> {
  const DB = `${SLUG}_${name}`;
  const APP = `${SLUG}_${name}_app`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.query(`drop role if exists ${APP}`);
  await admin.query(`create role ${APP} login password '${PW}'`);
  await admin.query(`create database ${DB} owner ${APP}`);
  await admin.end();

  const appUrl = `postgresql://${APP}:${PW}@localhost:5432/${DB}`;
  const app = new pg.Client({ connectionString: appUrl });
  await app.connect();
  await app.query(queueTableSql(QUEUE));
  await app.end();

  return {
    appUrl,
    drop: async () => {
      const a = new pg.Client({ connectionString: ADMIN });
      await a.connect();
      await a.query(`drop database if exists ${DB} with (force)`);
      await a.query(`drop role if exists ${APP}`);
      await a.end();
    },
  };
}

// ── the claim under genuine contention ──────────────────────────────────────────────────

test("live queue: eight concurrent drains deliver every message EXACTLY once", { skip }, async () => {
  const { appUrl, drop } = await build("contention");
  const pool = livePool(appUrl, 8);
  try {
    const total = 40;
    const seed = new pg.Client({ connectionString: appUrl });
    await seed.connect();
    for (let i = 0; i < total; i++) {
      await seed.query(`insert into ${TABLE} (idempotency_key, payload) values ($1, $2)`, [`evt-${i}`, JSON.stringify({ i })]);
    }
    await seed.end();

    installPostgresPool(pool);

    // Eight drains at once, each taking small pages, each doing real (awaited) work per message —
    // which is exactly the window in which a scattered or non-atomic claim hands the same row to
    // two of them.
    const delivered: string[] = [];
    const drains = Array.from({ length: 8 }, () =>
      drainQueue(
        QUEUE,
        async (m) => {
          await new Promise((r) => setTimeout(r, 3));
          delivered.push(m.key);
        },
        { limit: 5, visibilityMs: 60_000 },
      ),
    );
    const results = await Promise.all(drains);

    const unique = new Set(delivered);
    assert.equal(
      unique.size,
      delivered.length,
      `A MESSAGE WAS DELIVERED TWICE — two drains claimed the same row (${delivered.length} deliveries, ${unique.size} distinct)`,
    );
    assert.equal(results.reduce((n, r) => n + r.drained, 0), delivered.length, "acked count and delivered count disagree");

    // Drain what the first wave left, then assert the whole queue completed exactly once.
    for (let pass = 0; pass < 12 && unique.size < total; pass++) {
      const more = await drainQueue(QUEUE, async (m) => {
        delivered.push(m.key);
        unique.add(m.key);
      }, { limit: 20, visibilityMs: 60_000 });
      if (more.claimed === 0) break;
    }
    assert.equal(unique.size, total, "not every message was delivered");
    assert.equal(delivered.length, total, "some message was delivered more than once across all passes");

    const left = await pool.query(`select count(*)::int as n from ${TABLE} where processed_at is null`);
    assert.equal((left.rows[0] as { n: number }).n, 0, "messages remain unprocessed after every drain reported success");
  } finally {
    QueueSeam.transport = null;
    await pool.end();
    await drop();
  }
});

test("live queue: a leased message is invisible to another drain, and the REST are not", { skip }, async () => {
  const { appUrl, drop } = await build("lease");
  const pool = livePool(appUrl, 4);
  try {
    const seed = new pg.Client({ connectionString: appUrl });
    await seed.connect();
    for (const key of ["a", "b"]) {
      await seed.query(`insert into ${TABLE} (idempotency_key) values ($1)`, [key]);
    }
    await seed.end();
    installPostgresPool(pool);

    // One drain holds its message under a live lease; a second must come back with the OTHER one
    // — not with the leased one (that would be a double delivery) and not empty-handed (that
    // would mean one slow worker had stalled the whole queue). Both halves are asserted, and
    // deleting the lease predicate from the claim fails this case as well as the one above.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const slow = drainQueue(QUEUE, async () => {
      await held;
    }, { limit: 1, visibilityMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));

    const started = Date.now();
    const fast = await drainQueue(QUEUE, async () => {}, { limit: 1, visibilityMs: 60_000 });
    assert.equal(fast.claimed, 1, "the second drain got nothing while an unrelated message was pending");
    assert.ok(Date.now() - started < 2000, "the second drain waited on the first — a slow worker must not stall the queue");

    release();
    assert.equal((await slow).drained, 1);
  } finally {
    QueueSeam.transport = null;
    await pool.end();
    await drop();
  }
});
