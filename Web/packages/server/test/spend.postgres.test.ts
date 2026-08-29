//
//  spend.postgres.test.ts — the spend plane's SQL against a REAL Postgres (PGlite) and the
//  EMITTED migration, byte for byte, exactly as a deploy applies it (planes.postgres.test.ts
//  is the pattern and states why: the protocols live in the statements, and a non-atomic
//  upsert or a mis-predicated ceiling is invisible until a database evaluates it).
//
//  What only a database can prove here: the multi-row add accumulates under the rate-counter
//  table's own conflict target; a fresh isolate discovers another isolate's spending from the
//  durable counts alone; the capped enqueue refuses at the ceiling, still answers `duplicate`
//  for a stored delivery, and re-admits after the drain; and the SHARED sweep prunes spend
//  windows with no code of its own.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { installPostgresClient, sweepRateCounters, type SqlClient } from "../src/postgres.ts";
import { enqueueMessage, QueueError, QueueSeam } from "../src/queue.ts";
import { RateLimitSeam } from "../src/ratelimit.ts";
import { RealtimeSeam } from "../src/realtime.ts";
import {
  chargeSpend,
  configureSpend,
  flushSpendNow,
  resetSpend,
  SpendSeam,
  windowStart,
} from "../src/spend.ts";

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "..", "deploy", "supabase", "migrations", "000_dsx_schema.sql");

const PLATFORM_PREAMBLE = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
`;

const QUEUE = "webhooks";

async function database(): Promise<PGlite> {
  const db = await new PGlite();
  await db.exec(PLATFORM_PREAMBLE);
  await db.exec(readFileSync(MIGRATION, "utf-8")); // the EMITTED migration, nothing else
  const client: SqlClient = {
    query: async (text, params) => {
      const r = await db.query(text, params as never[]);
      return { rows: r.rows as unknown[] };
    },
  };
  installPostgresClient(client);
  return db;
}

function uninstall(): void {
  resetSpend();
  SpendSeam.store = null;
  QueueSeam.transport = null;
  RateLimitSeam.store = null;
  RealtimeSeam.transport = null;
}

test("spend.postgres: the batched add accumulates atomically on the shared counter table, and read answers it back", async () => {
  const db = await database();
  try {
    const store = SpendSeam.store!;
    const day = windowStart("day", Date.now());
    const entries = [
      { bucket: "spend|requests", windowStartMs: day, windowMs: 86_400_000, n: 12 },
      { bucket: "spend|egress:api.openai.com", windowStartMs: day, windowMs: 86_400_000, n: 3 },
    ];
    const first = await store.add(entries);
    assert.deepEqual(
      first.sort((a, b) => a.bucket.localeCompare(b.bucket)).map((r) => r.count),
      [3, 12],
    );
    const second = await store.add(entries);
    assert.deepEqual(
      second.sort((a, b) => a.bucket.localeCompare(b.bucket)).map((r) => r.count),
      [6, 24],
      "the upsert must ADD, not overwrite — Postgres decides the count",
    );
    const read = await store.read([
      { bucket: "spend|requests", windowStartMs: day },
      { bucket: "spend|never-written", windowStartMs: day },
    ]);
    assert.deepEqual(read, [{ bucket: "spend|requests", count: 24 }], "absent rows answer no row, never 0-rows invented");
  } finally {
    uninstall();
    await db.close();
  }
});

test("spend.postgres: a fresh isolate discovers another isolate's spending from the durable counts alone", async () => {
  const db = await database();
  try {
    // Isolate one burns most of the ceiling and flushes.
    configureSpend([{ of: "requests", per: "day", max: 10 }]);
    for (let i = 0; i < 9; i++) chargeSpend("requests");
    await flushSpendNow();

    // Isolate two boots fresh (same store), spends past the ceiling, flushes, and is refused —
    // the durable count is what joins them; nothing in memory survived the "restart".
    configureSpend([{ of: "requests", per: "day", max: 10 }]);
    assert.equal(chargeSpend("requests").allowed, true, "the fresh isolate has not reconciled yet — bounded staleness");
    assert.equal(chargeSpend("requests").allowed, true);
    await flushSpendNow(); // 9 (durable) + 2 (local) = 11 > 10 → reconciled as tripped
    const refused = chargeSpend("requests");
    assert.equal(refused.allowed, false);
    assert.equal(refused.budget, "requests");
  } finally {
    uninstall();
    await db.close();
  }
});

test("spend.postgres: the depth ceiling refuses at capacity, still answers duplicate for a stored delivery, and re-admits after the drain", async () => {
  const db = await database();
  try {
    configureSpend([{ of: `queue:${QUEUE}`, per: "day", max: "unbounded", depth: 2 }]);
    assert.equal((await enqueueMessage(QUEUE, "evt-1", { n: 1 })).duplicate, false);
    assert.equal((await enqueueMessage(QUEUE, "evt-2", { n: 2 })).duplicate, false);

    await assert.rejects(
      () => enqueueMessage(QUEUE, "evt-3", { n: 3 }),
      (e: unknown) => e instanceof QueueError && e.code === "saturated",
      "the third message must be refused saturated at depth 2",
    );

    // The webhook law, evaluated by the database: a retry of a STORED delivery answers
    // duplicate even while the queue is at its ceiling.
    const retry = await enqueueMessage(QUEUE, "evt-1", { n: 1 });
    assert.equal(retry.duplicate, true);

    // Draining clears the pending set (acked rows keep their key but leave the predicate),
    // so capacity returns without deleting anything.
    await db.query(`update dsx_queue_${QUEUE} set processed_at = now() where idempotency_key in ('evt-1','evt-2')`);
    assert.equal((await enqueueMessage(QUEUE, "evt-3", { n: 3 })).duplicate, false);
  } finally {
    uninstall();
    await db.close();
  }
});

test("spend.postgres: AT THE BOUNDARY a reconciled isolate is exact — the ceiling itself admitted, strictly past refused", async () => {
  const db = await database();
  try {
    const store = SpendSeam.store!;
    const day = windowStart("day", Date.now());
    await store.add([{ bucket: "spend|egress:api.openai.com", windowStartMs: day, windowMs: 86_400_000, n: 1998 }]);
    configureSpend([{ of: "egress:api.openai.com", per: "day", max: 2000 }]);
    await flushSpendNow(); // reconcile: this isolate now knows the durable 1998
    assert.equal(chargeSpend("egress:api.openai.com").allowed, true, "1,999 is under the ceiling");
    assert.equal(chargeSpend("egress:api.openai.com").allowed, true, "2,000 IS the ceiling, and the ceiling itself is admitted");
    const refused = chargeSpend("egress:api.openai.com");
    assert.equal(refused.allowed, false, "2,001 is strictly past — refused");
    assert.equal(refused.budget, "egress:api.openai.com");
  } finally {
    uninstall();
    await db.close();
  }
});

test("spend.postgres: OVERSHOOT, measured — a stale isolate admits its staleness window, the flush lands it, the reconcile slams shut", async () => {
  //  The distributed-enforcement semantics, pinned instead of marketed: enforcement is
  //  per-isolate against a durable count synchronized at the flush. An isolate that has not
  //  reconciled yet decides on a stale view, so the fleet-wide ceiling is APPROXIMATE with a
  //  stated bound — each isolate can admit at most one staleness window of traffic past the
  //  ceiling (plus its boundary unit), and the next reconcile closes every door. There is no
  //  cheap globally-atomic pre-check and the plane does not pretend one: a per-charge durable
  //  round trip would make the meter the bill (the thousand-charges-one-statement law above).
  const db = await database();
  try {
    const store = SpendSeam.store!;
    const day = windowStart("day", Date.now());
    //  The rest of the fleet has already spent the whole ceiling.
    await store.add([{ bucket: "spend|requests", windowStartMs: day, windowMs: 86_400_000, n: 2000 }]);
    //  A fresh isolate boots and serves traffic BEFORE its first reconcile: stale view, admits.
    configureSpend([{ of: "requests", per: "day", max: 2000 }]);
    for (let i = 0; i < 3; i++) assert.equal(chargeSpend("requests").allowed, true, "stale view admits — this IS the bound");
    await flushSpendNow(); // its flush lands the extras AND reconciles it to the truth
    const rows = await db.query(`select count from dsx_rate_counter where bucket = 'spend|requests'`);
    assert.deepEqual(rows.rows[0], { count: 2003 }, "durable overshoot = exactly the stale window's admissions");
    assert.equal(chargeSpend("requests").allowed, false, "reconciled, the door is shut fleet-wide truth in hand");
  } finally {
    uninstall();
    await db.close();
  }
});

test("spend.postgres: the SHARED sweep prunes expired spend windows — no second retention path exists", async () => {
  const db = await database();
  try {
    const store = SpendSeam.store!;
    const ancient = windowStart("hour", Date.parse("2020-01-01T00:00:00Z"));
    await store.add([{ bucket: "spend|requests", windowStartMs: ancient, windowMs: 3_600_000, n: 5 }]);
    const swept = await sweepRateCounters();
    assert.ok(swept >= 1, "the 2020 window is three grace-windows past and must be sweepable");
    const rows = await db.query(`select count(*)::int as n from dsx_rate_counter where bucket = 'spend|requests'`);
    assert.deepEqual(rows.rows[0], { n: 0 });
  } finally {
    uninstall();
    await db.close();
  }
});
