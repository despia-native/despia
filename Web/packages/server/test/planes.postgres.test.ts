//
//  planes.postgres.test.ts — the three planes added for the production slice, against a REAL
//  Postgres (PGlite) and the EMITTED migration, byte for byte, exactly as a deploy applies it.
//
//  The unit tests prove the protocols with fake transports. This file proves the SQL, which is
//  where the protocols actually live: an upsert that is not atomic, a dead-letter predicate that
//  is not idempotent, or an owner filter that a subscriber can influence are all invisible until
//  a database evaluates them.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { installPostgresClient, type SqlClient } from "../src/postgres.ts";
import { drainQueue, enqueueMessage, listDeadLetters, replayDeadLetters, QueueSeam } from "../src/queue.ts";
import { RateLimitSeam, spend } from "../src/ratelimit.ts";
import { publishEvent, RealtimeSeam } from "../src/realtime.ts";

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
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

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
  QueueSeam.transport = null;
  RateLimitSeam.store = null;
  RealtimeSeam.transport = null;
}

// ── enqueue ─────────────────────────────────────────────────────────────────────────────

test("planes.postgres: the EMITTED migration alone is enough to enqueue and drain", async () => {
  const db = await database();
  try {
    const first = await enqueueMessage(QUEUE, "evt-1", { amount: 100 });
    assert.equal(first.duplicate, false);
    assert.match(first.id!, /^[0-9a-f-]{36}$/);

    const seen: Record<string, unknown>[] = [];
    const result = await drainQueue(QUEUE, async (m) => {
      seen.push(m.payload);
    });
    assert.equal(result.drained, 1);
    assert.deepEqual(seen, [{ amount: 100 }]);
  } finally {
    uninstall();
    await db.close();
  }
});

test("planes.postgres: a duplicate key is refused BY THE INDEX and reported as a duplicate", async () => {
  const db = await database();
  try {
    await enqueueMessage(QUEUE, "evt-dup", { n: 1 });
    const again = await enqueueMessage(QUEUE, "evt-dup", { n: 2 });
    assert.equal(again.duplicate, true);
    assert.equal(again.id, null);

    const rows = await db.query(`select payload from dsx_queue_${QUEUE} where idempotency_key = 'evt-dup'`);
    assert.equal(rows.rows.length, 1, "the retry stored a second row");
    assert.deepEqual(rows.rows[0], { payload: { n: 1 } }, "the retry overwrote the payload of the first delivery");
  } finally {
    uninstall();
    await db.close();
  }
});

test("planes.postgres: a duplicate key stays refused after the original was DRAINED AND ACKED", async () => {
  //  The replay-defense guarantee. An acked row keeps its key forever, so an event replayed a
  //  month later is still refused — which a nonce table with a TTL cannot promise.
  const db = await database();
  try {
    await enqueueMessage(QUEUE, "evt-old", {});
    await drainQueue(QUEUE, async () => {});
    const replay = await enqueueMessage(QUEUE, "evt-old", {});
    assert.equal(replay.duplicate, true);
  } finally {
    uninstall();
    await db.close();
  }
});

// ── the dead letter ─────────────────────────────────────────────────────────────────────

test("planes.postgres: a message that always fails ends DEAD-LETTERED, with its reason, and stops being claimed", async () => {
  const db = await database();
  try {
    await enqueueMessage(QUEUE, "evt-poison", { bad: true });

    let attempts = 0;
    for (let pass = 0; pass < 5; pass++) {
      await drainQueue(QUEUE, async () => {
        attempts++;
        throw new Error("upstream refused");
      }, { maxAttempts: 3, visibilityMs: 0 });
    }
    assert.equal(attempts, 3, `the poison message was delivered ${attempts} times against a ceiling of 3`);

    const stuck = await listDeadLetters(QUEUE);
    assert.equal(stuck.length, 1);
    assert.equal(stuck[0]!.key, "evt-poison");
    assert.equal(stuck[0]!.reason, "upstream refused");
    assert.equal(stuck[0]!.attempt, 3);
    assert.notEqual(stuck[0]!.deadLetteredAt, null);
    assert.deepEqual(stuck[0]!.payload, { bad: true });
  } finally {
    uninstall();
    await db.close();
  }
});

test("planes.postgres: a dead letter REPLAYED is claimable again, and its attempts are reset", async () => {
  const db = await database();
  try {
    await enqueueMessage(QUEUE, "evt-fixable", { n: 1 });
    for (let pass = 0; pass < 3; pass++) {
      await drainQueue(QUEUE, async () => { throw new Error("bug"); }, { maxAttempts: 2, visibilityMs: 0 });
    }
    const stuck = await listDeadLetters(QUEUE);
    assert.equal(stuck.length, 1);

    assert.equal(await replayDeadLetters(QUEUE, [stuck[0]!.id]), 1);
    assert.equal((await listDeadLetters(QUEUE)).length, 0, "the replayed message is still listed as stuck");

    // …and the bug is fixed, so it drains.
    const result = await drainQueue(QUEUE, async () => {}, { maxAttempts: 2, visibilityMs: 0 });
    assert.equal(result.drained, 1);
  } finally {
    uninstall();
    await db.close();
  }
});

test("planes.postgres: dead-lettering twice does not overwrite the reason the FIRST exhaustion recorded", async () => {
  const db = await database();
  try {
    await enqueueMessage(QUEUE, "evt-once", {});
    for (let pass = 0; pass < 2; pass++) {
      await drainQueue(QUEUE, async () => { throw new Error("original cause"); }, { maxAttempts: 1, visibilityMs: 0 });
    }
    const transport = QueueSeam.transport!;
    const rows = await db.query(`select id from dsx_queue_${QUEUE}`);
    const id = (rows.rows[0] as { id: string }).id;
    assert.equal(await transport.deadLetter({ queue: QUEUE, entries: [{ id, reason: "a later, wrong cause" }] }), 0);

    const stuck = await listDeadLetters(QUEUE);
    assert.equal(stuck[0]!.reason, "original cause");
  } finally {
    uninstall();
    await db.close();
  }
});

// ── the request budget ──────────────────────────────────────────────────────────────────

test("planes.postgres: the counter is ATOMIC — concurrent spends never exceed the ceiling", async () => {
  const db = await database();
  try {
    const rule = { limit: 10, windowMs: 60_000 };
    const at = 1_700_000_000_000;
    //  Fired together on purpose. A select-then-update would let several of these read the same
    //  value and all write value+1, so more than `limit` would be allowed.
    const verdicts = await Promise.all(Array.from({ length: 25 }, () => spend("burst", rule, { nowMs: at })));
    assert.equal(verdicts.filter((v) => v.allowed).length, 10, "the ceiling was exceeded under concurrency");

    const rows = await db.query("select count from dsx_rate_counter where bucket = 'burst'");
    assert.equal((rows.rows[0] as { count: number }).count, 25, "every request must be counted, allowed or not");
  } finally {
    uninstall();
    await db.close();
  }
});

test("planes.postgres: a new window starts a new row, so a budget really does refresh", async () => {
  const db = await database();
  try {
    const rule = { limit: 1, windowMs: 60_000 };
    const base = Math.floor(1_700_000_000_000 / 60_000) * 60_000;
    assert.equal((await spend("b", rule, { nowMs: base })).allowed, true);
    assert.equal((await spend("b", rule, { nowMs: base + 30_000 })).allowed, false);
    assert.equal((await spend("b", rule, { nowMs: base + 60_000 })).allowed, true);

    const rows = await db.query("select count(*)::int as n from dsx_rate_counter where bucket = 'b'");
    assert.equal((rows.rows[0] as { n: number }).n, 2);
  } finally {
    uninstall();
    await db.close();
  }
});

// ── the event feed ──────────────────────────────────────────────────────────────────────

test("planes.postgres: a subscriber reads public events and its OWN, and cannot reach another subject's", async () => {
  const db = await database();
  try {
    await publishEvent("notes", { n: "public" });
    await publishEvent("notes", { n: "alice" }, { ownerId: ALICE });
    await publishEvent("notes", { n: "bob" }, { ownerId: BOB });
    await publishEvent("other", { n: "wrong channel" });

    const transport = RealtimeSeam.transport!;
    const forAlice = await transport.read({ channel: "notes", afterSeq: "0", subject: ALICE, limit: 100 });
    assert.deepEqual(forAlice.map((e) => e.payload.n), ["public", "alice"]);

    const forBob = await transport.read({ channel: "notes", afterSeq: "0", subject: BOB, limit: 100 });
    assert.deepEqual(forBob.map((e) => e.payload.n), ["public", "bob"]);
  } finally {
    uninstall();
    await db.close();
  }
});

test("planes.postgres: the cursor is monotonic and exclusive, so a resumed feed repeats nothing", async () => {
  const db = await database();
  try {
    const first = await publishEvent("notes", { n: 1 });
    await publishEvent("notes", { n: 2 });
    const transport = RealtimeSeam.transport!;

    const resumed = await transport.read({ channel: "notes", afterSeq: first, subject: ALICE, limit: 100 });
    assert.deepEqual(resumed.map((e) => e.payload.n), [2]);
    assert.equal(Number(resumed[0]!.seq) > Number(first), true);
  } finally {
    uninstall();
    await db.close();
  }
});

test("planes.postgres: an OWNER entity is not reachable by anon, so its shape is not published", async () => {
  //  Supabase auto-generates PostgREST/GraphQL surfaces from TABLE PRIVILEGES, so a grant that
  //  RLS makes useless still publishes the entity's name, columns and types to anyone holding the
  //  publishable key. A real project raised `pg_graphql_anon_table_exposed` on exactly this table.
  //
  //  The grant bought nothing: the policy is `owner_id = auth.uid()`, and auth.uid() is NULL for
  //  anon, so the anonymous read matched no row with it and is refused at the ACL without it.
  //
  //  `authenticated` KEEPS the grant deliberately — `runAs` reaches a user-scoped row by issuing
  //  `set local role authenticated`, so revoking it would refuse the server's own read path with
  //  42501 before any policy is consulted.
  const db = await database();
  try {
    const granted = async (role: string): Promise<string[]> => {
      const r = await db.query(
        `select privilege_type from information_schema.role_table_grants where table_name = 'dsx_note' and grantee = $1 order by 1`,
        [role],
      );
      return r.rows.map((x) => (x as { privilege_type: string }).privilege_type);
    };
    assert.deepEqual(await granted("anon"), [], "the owner entity is still reachable by anon");
    assert.deepEqual(
      (await granted("authenticated")).sort(),
      ["DELETE", "INSERT", "SELECT", "UPDATE"],
      "revoking authenticated refuses the server's OWN user-scoped read path at the ACL",
    );
  } finally {
    uninstall();
    await db.close();
  }
});

test("planes.postgres: every added table is RLS-enabled and unreachable by anon or authenticated", async () => {
  //  The platform ships default privileges that grant a new table to `anon` the moment it exists,
  //  so the absence of a GRANT is not the same as the absence of access. This is the check that
  //  the emitted migration actually revokes it.
  const db = await database();
  try {
    for (const table of ["dsx_rate_counter", "dsx_event", `dsx_queue_${QUEUE}`]) {
      const rls = await db.query(`select relrowsecurity from pg_class where relname = $1`, [table]);
      assert.equal((rls.rows[0] as { relrowsecurity: boolean }).relrowsecurity, true, `${table} is not RLS-enabled`);

      for (const role of ["anon", "authenticated"]) {
        const granted = await db.query(
          `select count(*)::int as n from information_schema.role_table_grants where table_name = $1 and grantee = $2`,
          [table, role],
        );
        assert.equal((granted.rows[0] as { n: number }).n, 0, `${table} is still granted to ${role}`);
      }
    }
  } finally {
    uninstall();
    await db.close();
  }
});
