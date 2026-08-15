//
//  queue.postgres.test.ts — THE CLAIM, against a real Postgres (L-11).
//
//      two drains must never both take the same message.
//
//  `queue.test.ts` proves the protocol with a scripted transport: it establishes what the plane
//  DOES with what it is handed. That is necessary and not sufficient — the sentence above is a
//  claim about what a database does under contention, and only a database can settle it.
//
//  WHAT IS REAL HERE:
//    • REAL: the Postgres engine. PGlite is the actual Postgres source compiled to WASM — same
//      planner, same executor, same row locks.
//    • REAL: the base queue table. It is created by the EMITTED
//      deploy/supabase/migrations/000_dsx_schema.sql, byte for byte, exactly as a deploy applies
//      it — so the `idempotency_key text not null unique` this file leans on is the emitter's,
//      not a convenience the test wrote for itself.
//    • DECLARED, NOT YET EMITTED: the two LEASE columns (`claimed_at`, `attempts`). They are the
//      claim protocol's own requirement and are applied here from `queueTableSql()`, which is
//      where the transport states them. The emitter does not write them yet — that is a named
//      follow-up in `ClosedSource/scripts/prepare_server.rb`, and the SQL is deliberately
//      `add column if not exists` so the day it lands nothing in this file changes.
//    • NOT REAL: genuine parallelism. PGlite is one connection, so two claims here run back to
//      back rather than at the same instant. That still proves the CANDIDATE PREDICATE (a leased
//      message is not offered again), which is the half that a single connection can prove. The
//      other half — that `for update skip locked` makes simultaneous claims take disjoint sets
//      instead of blocking — needs a real pool and lives in `queue.live.test.ts`.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { drainQueue, QueueError, QueueSeam, type QueueMessage } from "../src/queue.ts";
import { buildQueueClaimStatement, buildQueueSettleStatements, installPostgresClient, queueTableSql, type SqlClient } from "../src/postgres.ts";

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "..", "deploy", "supabase", "migrations", "000_dsx_schema.sql");

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

const QUEUE = "webhooks";
const TABLE = "dsx_queue_webhooks";

async function database(): Promise<{ db: PGlite; client: SqlClient }> {
  const db = await new PGlite();
  await db.exec(PLATFORM_PREAMBLE);
  await db.exec(readFileSync(MIGRATION, "utf-8")); // the EMITTED migration, byte for byte
  await db.exec(queueTableSql(QUEUE)); // the lease columns the claim protocol declares
  const client: SqlClient = {
    query: async (text, params) => {
      const r = await db.query(text, params as never[]);
      return { rows: r.rows as unknown[] };
    },
  };
  installPostgresClient(client); // fills BOTH seams — repository and queue
  return { db, client };
}

async function enqueue(db: PGlite, keys: string[]): Promise<void> {
  for (const key of keys) {
    await db.query(`insert into ${TABLE} (idempotency_key, payload) values ($1, $2)`, [key, JSON.stringify({ key })]);
  }
}

async function rows(db: PGlite): Promise<{ idempotency_key: string; processed_at: unknown; claimed_at: unknown; attempts: number }[]> {
  const r = await db.query(`select idempotency_key, processed_at, claimed_at, attempts from ${TABLE} order by idempotency_key`);
  return r.rows as { idempotency_key: string; processed_at: unknown; claimed_at: unknown; attempts: number }[];
}

// ── the emitted bytes really do carry the base table ────────────────────────────────────

test("queue: the EMITTED migration creates the queue table with its idempotency UNIQUE key", () => {
  const sql = readFileSync(MIGRATION, "utf-8");
  assert.match(sql, new RegExp(`create table if not exists ${TABLE}`), "the emitter no longer writes the queue table this plane drains");
  assert.match(sql, /idempotency_key text not null unique/, "row-level idempotency is the emitter's declaration, not this test's");
});

//  THE THREE LINES A QUEUE NEEDS, AND WHY THIS IS A STRING ASSERTION RATHER THAN A QUERY.
//
//  Everything else in this file runs on PGlite as a SUPERUSER, which needs no privilege and is
//  subject to no policy. That is exactly how this table shipped first with no grant, then with no
//  way to SEE a row, while this suite stayed green throughout. Both were found by booting the
//  server against a real Postgres as the ordinary self-hosted role — a member of the request
//  roles that does NOT own the tables:
//
//    revoke  → keeps the queue out of Supabase's auto-generated PostgREST/GraphQL surface, which
//              the platform's default privileges would otherwise publish to `anon`.
//    grant   → without it the drain dies on "permission denied" before RLS is consulted. The
//              revoke above makes this mandatory: it removed the privilege the connection role
//              previously inherited through anon.
//    policy  → without it the drain returns 200 having claimed NOTHING. An RLS table with no
//              policy shows no rows to anyone who neither owns it nor holds bypassrls. That is
//              the worse failure of the two, because it reports success.
//
//  Asserted in BOTH emitters — prepare_server.rb and queueTableSql() must stay byte-aligned, and
//  a fix applied to only one is the same bug again on whichever path a deploy takes.
test("queue: revoke + grant + policy, in both emitters — any one missing leaves the queue broken or exposed", () => {
  const migration = readFileSync(MIGRATION, "utf-8");
  const revoke = new RegExp(`revoke all on ${TABLE} from anon, authenticated;`);
  const grant = new RegExp(`grant select, insert, update, delete on ${TABLE} to service_role;`);
  const policy = new RegExp(`create policy ${TABLE}_service on ${TABLE} for all to service_role using \\(true\\) with check \\(true\\);`);

  for (const [name, source] of [["the emitted migration", migration], ["queueTableSql", queueTableSql(QUEUE)]] as const) {
    assert.match(source, revoke, `${name} stopped revoking — Supabase would publish the queue's shape to anon`);
    assert.match(source, grant, `${name} stopped granting — the drain dies on permission denied as a non-owner`);
    assert.match(source, policy, `${name} stopped naming service_role — the drain claims nothing and still returns 200`);
  }
  assert.match(migration, new RegExp(`alter table ${TABLE} enable row level security;`),
    "the grant is only safe while RLS is enabled on this table");
});

test("queue: queueTableSql converges an already-migrated database and is idempotent", async () => {
  const db = await new PGlite();
  try {
    await db.exec(PLATFORM_PREAMBLE);
    await db.exec(readFileSync(MIGRATION, "utf-8"));
    // Before: the emitted table exists and has NO lease columns.
    const before = await db.query(`select column_name from information_schema.columns where table_name = '${TABLE}'`);
    const names = (before.rows as { column_name: string }[]).map((r) => r.column_name);
    assert.ok(names.includes("idempotency_key"), "the emitted migration did not create the queue table at all");
    // After: applying it twice adds the lease columns and changes nothing the second time.
    await db.exec(queueTableSql(QUEUE));
    await db.exec(queueTableSql(QUEUE));
    const after = await db.query(`select column_name from information_schema.columns where table_name = '${TABLE}'`);
    const grown = (after.rows as { column_name: string }[]).map((r) => r.column_name);
    for (const column of ["enqueue_order", "claimed_at", "attempts"]) {
      assert.ok(grown.includes(column), `the claim protocol needs ${column} and the convergence SQL did not add it`);
    }
  } finally {
    await db.close();
  }
});

// ── the claim ───────────────────────────────────────────────────────────────────────────

test("queue: a drain claims, processes and acks — and the queue really drains", async () => {
  const { db } = await database();
  try {
    await enqueue(db, ["e1", "e2", "e3"]);
    const seen: string[] = [];
    const result = await drainQueue(QUEUE, async (m: QueueMessage) => {
      seen.push(m.key);
      assert.deepEqual(m.payload, { key: m.key }, "the payload must arrive verbatim");
      assert.equal(m.attempt, 1, "a first delivery is attempt 1");
      assert.ok(m.enqueuedAt !== null, "the enqueue time must survive the wire");
    });
    assert.deepEqual(seen, ["e1", "e2", "e3"], "messages must arrive in enqueue order");
    assert.equal(result.claimed, 3);
    assert.equal(result.drained, 3, "THE DRAIN DID NOT DRAIN — this is the whole point of L-11");
    for (const row of await rows(db)) {
      assert.ok(row.processed_at !== null, `${row.idempotency_key} was not marked processed`);
      assert.equal(row.claimed_at, null, "an acked message must not keep its lease");
    }
    // A second pass has nothing left to do.
    assert.equal((await drainQueue(QUEUE, async () => {})).claimed, 0);
  } finally {
    await db.close();
  }
});

test("queue: TWO DRAINS CANNOT BOTH TAKE ONE MESSAGE — the lease excludes it", async () => {
  const { db } = await database();
  try {
    await enqueue(db, ["only"]);
    // The first drain claims but never settles: its handler hangs on a promise the test controls,
    // which is exactly the shape of a slow worker.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const first = drainQueue(QUEUE, async () => {
      await held;
    });
    // Give the claim time to land before the second drain runs. On one connection the transports
    // serialise, so this is "after the claim committed", which is the state the predicate guards.
    await new Promise((r) => setTimeout(r, 25));

    const secondSeen: string[] = [];
    const second = await drainQueue(QUEUE, async (m) => {
      secondSeen.push(m.key);
    });
    assert.equal(second.claimed, 0, "A SECOND DRAIN CLAIMED A LEASED MESSAGE — it would be processed twice");
    assert.deepEqual(secondSeen, []);

    release();
    const firstResult = await first;
    assert.equal(firstResult.drained, 1, "the first drain must still own and complete the message");
  } finally {
    await db.close();
  }
});

test("queue: an EXPIRED lease is redelivered — a crashed drain loses nothing", async () => {
  const { db } = await database();
  try {
    await enqueue(db, ["e1"]);
    // Claim directly through the seam and never settle: the shape of a process that died holding
    // the message. A zero lease is one that has already expired by the next statement.
    const claimed = await QueueSeam.transport!.claim({ queue: QUEUE, limit: 10, visibilityMs: 0, maxAttempts: 5 });
    assert.equal(claimed.length, 1);
    assert.equal((await rows(db))[0]!.attempts, 1);

    const again = await drainQueue(QUEUE, async () => {}, { visibilityMs: 0 });
    assert.equal(again.claimed, 1, "an expired lease was never re-offered — the message is lost");
    assert.equal(again.drained, 1);

    // And with a live lease it is NOT redelivered.
    await enqueue(db, ["e2"]);
    await QueueSeam.transport!.claim({ queue: QUEUE, limit: 10, visibilityMs: 60_000, maxAttempts: 5 });
    assert.equal((await drainQueue(QUEUE, async () => {}, { visibilityMs: 60_000 })).claimed, 0, "a live lease was ignored");
  } finally {
    await db.close();
  }
});

test("queue: a released message comes back immediately, and its delivery count climbs", async () => {
  const { db } = await database();
  try {
    await enqueue(db, ["e1"]);
    const first = await drainQueue(QUEUE, async () => {
      throw new Error("downstream 503");
    });
    assert.equal(first.drained, 0);
    assert.equal(first.released, 1);
    assert.deepEqual(first.failures, [{ key: "e1", reason: "downstream 503" }]);
    assert.equal((await rows(db))[0]!.processed_at, null, "a failed message must not be marked processed");
    assert.equal((await rows(db))[0]!.claimed_at, null, "a released message must not keep its lease");

    // Back at once — no waiting for the lease, because the drain handed it back explicitly.
    let attempt = 0;
    const second = await drainQueue(QUEUE, async (m) => {
      attempt = m.attempt;
    });
    assert.equal(second.drained, 1);
    assert.equal(attempt, 2, "the redelivery must be reported as a second attempt");
  } finally {
    await db.close();
  }
});

test("queue: a message that always fails PARKS instead of burning every drain forever", async () => {
  const { db } = await database();
  try {
    await enqueue(db, ["poison"]);
    for (let pass = 0; pass < 3; pass++) {
      const r = await drainQueue(QUEUE, async () => {
        throw new Error("always fails");
      }, { maxAttempts: 3 });
      assert.equal(r.claimed, 1, `pass ${pass} should still have offered the message`);
    }
    const parked = await drainQueue(QUEUE, async () => {}, { maxAttempts: 3 });
    assert.equal(parked.claimed, 0, "a poison message is still being redelivered past its attempt ceiling");
    const row = (await rows(db))[0]!;
    assert.equal(row.attempts, 3);
    assert.equal(row.processed_at, null, "a parked message must stay visibly unprocessed, not be marked done");
  } finally {
    await db.close();
  }
});

test("queue: ACK KEEPS THE ROW — the idempotency key still refuses a duplicate enqueue", async () => {
  const { db } = await database();
  try {
    await enqueue(db, ["evt-9"]);
    assert.equal((await drainQueue(QUEUE, async () => {})).drained, 1);
    // The same webhook arriving twice must not become two messages. If ack had DELETED the row,
    // this insert would succeed and the event would be processed a second time.
    await assert.rejects(() => enqueue(db, ["evt-9"]), /duplicate key value|unique/i);
  } finally {
    await db.close();
  }
});

// ── the worker route's handler, exactly as a residence writes it ────────────────────────

test("queue: the whole of a `worker` route's handler is two lines, and it reports a REAL count", async () => {
  const { db } = await database();
  try {
    await enqueue(db, ["stripe-1", "stripe-2"]);

    // This IS the body `Core/Server/Modules/Http/web/server/index.ts` needs — reproduced here
    // because that residence lives in another lane, and a shape nobody has executed is a shape
    // nobody should paste. `drained` is the declared action's own resolve key, and the value it
    // now carries is what the queue actually dequeued rather than the honest floor of 0.
    const handled: string[] = [];
    const drainWebhooks = async (
      _args: Record<string, unknown>,
      ctx: { identity?: { sub: string } | null },
    ): Promise<{ ok: boolean; queue: string; drained: number; by: string | null }> => {
      const result = await drainQueue("webhooks", async (message) => {
        handled.push(message.key);
      });
      return { ok: true, queue: "webhooks", drained: result.drained, by: ctx.identity?.sub ?? null };
    };

    const reply = await drainWebhooks({}, { identity: { sub: "service" } });
    assert.deepEqual(reply, { ok: true, queue: "webhooks", drained: 2, by: "service" });
    assert.deepEqual(handled, ["stripe-1", "stripe-2"]);

    // The next minute's cron finds nothing left, and says so honestly.
    assert.deepEqual(await drainWebhooks({}, { identity: null }), { ok: true, queue: "webhooks", drained: 0, by: null });
  } finally {
    await db.close();
  }
});

// ── the statements, without a database ──────────────────────────────────────────────────

test("queue: the claim is ONE statement and carries its whole state machine", () => {
  const claim = buildQueueClaimStatement({ queue: QUEUE, limit: 25, visibilityMs: 30_000, maxAttempts: 5 });
  assert.match(claim.text, /^with claimed as \(update dsx_queue_webhooks as q set claimed_at = now\(\), attempts = q\.attempts \+ 1/);
  assert.match(claim.text, /select id, idempotency_key, payload, created_at, attempts from claimed order by enqueue_order$/);
  assert.match(claim.text, /for update skip locked/, "without SKIP LOCKED concurrent drains are still correct but queue behind one another");
  assert.match(claim.text, /c\.processed_at is null/);
  assert.match(claim.text, /c\.attempts < \$1::int/);
  assert.match(claim.text, /c\.claimed_at is null or c\.claimed_at < now\(\) - make_interval/);
  assert.deepEqual(claim.params, [5, 30, 25], "the lease crosses the wire in seconds, as a parameter");
  assert.equal(claim.text.split(";").length, 1, "the claim must not be splittable into select-then-update");
});

test("queue: the settle is idempotent per outcome and never touches a completed row", () => {
  const a = "11111111-1111-1111-1111-111111111111";
  const b = "22222222-2222-2222-2222-222222222222";
  const statements = buildQueueSettleStatements({ queue: QUEUE, ack: [a], release: [b] });
  assert.equal(statements.length, 2);
  assert.match(statements[0]!.text, /set processed_at = now\(\), claimed_at = null where id in \(\$1\) and processed_at is null/);
  assert.match(statements[1]!.text, /set claimed_at = null where id in \(\$1\) and processed_at is null/);
  assert.deepEqual(statements[0]!.params, [a]);
  assert.deepEqual(buildQueueSettleStatements({ queue: QUEUE, ack: [], release: [] }), [], "an empty settle emits no SQL");
});

test("queue: a hostile queue name or message id never reaches the SQL text", () => {
  assert.throws(
    () => buildQueueClaimStatement({ queue: "webhooks; drop table dsx_note", limit: 1, visibilityMs: 0, maxAttempts: 1 }),
    /not a legal queue name/,
  );
  assert.throws(
    () => buildQueueSettleStatements({ queue: QUEUE, ack: ["1); drop table dsx_note --"], release: [] }),
    /is not a queue message id/,
  );
});

// ── the table is not there ──────────────────────────────────────────────────────────────

// A queue table from BEFORE the lease columns existed. This used to be spelled as "apply the
// emitted migration", which worked only because the emitter was missing the lease columns — the
// bug. Now that the emitter converges them, the migration can no longer produce the state this
// test names, so the pre-lease shape is stated directly, which is what the test always meant.
const PRE_LEASE_QUEUE_TABLE = `
  create table if not exists dsx_queue_webhooks (
    id uuid primary key default gen_random_uuid(),
    idempotency_key text not null unique,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    processed_at timestamptz
  );
`;

test("queue: an unprovisioned queue reports not_provisioned, naming the fix", async () => {
  const db = await new PGlite();
  try {
    await db.exec(PLATFORM_PREAMBLE);
    await db.exec(PRE_LEASE_QUEUE_TABLE); // base table only — no lease columns
    installPostgresClient({
      query: async (text, params) => {
        const r = await db.query(text, params as never[]);
        return { rows: r.rows as unknown[] };
      },
    });
    await assert.rejects(
      () => drainQueue(QUEUE, async () => {}),
      (e: unknown) => {
        assert.ok(e instanceof QueueError, "a missing lease column surfaced as a raw driver error");
        assert.equal((e as QueueError).code, "not_provisioned");
        assert.match((e as QueueError).message, /queueTableSql\("webhooks"\)/, "the failure must name the step that fixes it");
        return true;
      },
    );
    // And a queue whose table does not exist at all is the same class of failure.
    await assert.rejects(() => drainQueue("nowhere", async () => {}), (e: unknown) => (e as QueueError).code === "not_provisioned");
  } finally {
    await db.close();
  }
});
