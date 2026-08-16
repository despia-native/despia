//
//  postgres.connection.test.ts — THE CONNECTION DISCIPLINE.
//
//  `rls.postgres.test.ts` proves the POLICY: given a correctly-scoped connection, user A cannot
//  read user B's rows. This file proves the thing that hands the policy its connection, because a
//  perfect policy on the wrong connection enforces nothing.
//
//  Postgres decides row-level security from the CURRENT ROLE and the current settings. Both are
//  connection-and-transaction state, invisible in the SQL text. So:
//
//      begin ─ set_config(sub) ─ set local role ─ <statement> ─ commit
//
//  is only meaningful if every step runs on the SAME physical connection, and if no other request
//  interleaves its own steps between them. Two distinct ways to break that, both confirmed:
//
//    1. A POOL'S OWN `query()` checks out a fresh connection per call, scattering the sequence.
//       Measured against Postgres 17, eight concurrent callers through `pool.query()`: one of
//       Bob's four requests returned Alice's row; three of Alice's four returned nothing of hers.
//    2. A SINGLE connection shared by concurrent requests nests one transaction inside another,
//       so the second caller's statement executes under the first caller's identity.
//
//  Neither is visible serially — an idle pool returns the same connection every time, and serial
//  calls cannot interleave. Both suites below therefore run requests CONCURRENTLY on purpose.
//
//  These use recording fakes rather than a live database so they run in CI with no service:
//  what is asserted here is the ROUTING of statements to connections, which is exactly the part a
//  real database cannot show you (it sees one connection at a time and never reports the mixup).
//  The live-Postgres counterpart is `postgres.pool.live.test.ts`.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { RepoSeam, type RepoQuery } from "../src/repo.ts";
import { installPostgresClient, installPostgresPool, type SqlClient, type SqlConnection, type SqlPool } from "../src/postgres.ts";

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

interface Logged {
  connection: number;
  text: string;
  params: unknown[];
}

/** A pool whose connections are individually identifiable, so scatter is observable. */
function recordingPool(opts: { delayMs?: number } = {}): { pool: SqlPool; log: Logged[]; live(): number } {
  const log: Logged[] = [];
  let next = 0;
  let outstanding = 0;
  const pool: SqlPool = {
    connect: async () => {
      const id = next++;
      outstanding++;
      const connection: SqlConnection = {
        query: async (text, params = []) => {
          // yield the microtask queue so concurrent callers genuinely interleave here
          if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs));
          else await Promise.resolve();
          log.push({ connection: id, text, params });
          return { rows: [] };
        },
        release: () => {
          outstanding--;
        },
      };
      return connection;
    },
  };
  return { pool, log, live: () => outstanding };
}

const listFor = (subject: string): RepoQuery => ({ entity: "note", op: "list", token: null, subject, scope: "user" });

/** Split a flat statement log into begin…commit groups, in the order each group COMMITTED. */
function transactions(log: Logged[]): Logged[][] {
  const open = new Map<number, Logged[]>();
  const done: Logged[][] = [];
  for (const entry of log) {
    if (entry.text === "begin") open.set(entry.connection, []);
    const group = open.get(entry.connection);
    if (group === undefined) continue;
    group.push(entry);
    if (entry.text === "commit" || entry.text === "rollback") {
      done.push(group);
      open.delete(entry.connection);
    }
  }
  return done;
}

// ── 1. a pool: one transaction must not be scattered across connections ──────────────────

test("pool: every statement of one transaction runs on ONE checked-out connection", async () => {
  const { pool, log, live } = recordingPool();
  installPostgresPool(pool);

  await RepoSeam.transport!(listFor(ALICE));

  const used = new Set(log.map((l) => l.connection));
  assert.equal(
    used.size,
    1,
    `the transaction was scattered across ${used.size} connections — the identity preamble and the statement it authorises ran on different connections`,
  );
  assert.deepEqual(log.map((l) => l.text.split(" ").slice(0, 2).join(" ")), [
    "begin",
    "select set_config('request.jwt.claim.sub',",
    "select set_config('request.jwt.claims',",
    "set local",
    "select *",
    "commit",
  ]);
  assert.equal(live(), 0, "the connection was never released — a pool this leaks from is exhausted under load");
});

test("pool: CONCURRENT requests never share a connection, so identities cannot cross", async () => {
  const { pool, log, live } = recordingPool({ delayMs: 1 });
  installPostgresPool(pool);

  // four callers at once, alternating identity — the shape that leaked at 1-in-4 for real
  await Promise.all([ALICE, BOB, ALICE, BOB].map((s) => RepoSeam.transport!(listFor(s))));

  const groups = transactions(log);
  assert.equal(groups.length, 4, "expected four complete transactions");
  for (const group of groups) {
    const connections = new Set(group.map((l) => l.connection));
    assert.equal(connections.size, 1, "a transaction spanned more than one connection under concurrency");

    // the identity this transaction declared must be the identity in force for its statement
    const declared = group.find((l) => l.text.startsWith("select set_config('request.jwt.claim.sub'"))?.params[0];
    const others = log.filter((l) => l.connection === group[0]!.connection);
    const identities = new Set(
      others.filter((l) => l.text.startsWith("select set_config('request.jwt.claim.sub'")).map((l) => l.params[0]),
    );
    assert.deepEqual([...identities], [declared], "two identities were set on one connection — a request ran as someone else");
  }
  assert.equal(live(), 0, "connections were not all released");
});

test("pool: a connection is released even when the statement fails", async () => {
  const { pool, live } = recordingPool();
  const failing: SqlPool = {
    connect: async () => {
      const c = await pool.connect();
      return { query: async (t: string) => (t.startsWith("select *") ? Promise.reject(new Error("boom")) : c.query(t)), release: c.release };
    },
  };
  installPostgresPool(failing);
  await assert.rejects(RepoSeam.transport!(listFor(ALICE)), /boom/);
  assert.equal(live(), 0, "a failed statement leaked its connection — the pool drains to zero under errors");
});

test("pool: a malformed query is rejected WITHOUT consuming a connection", async () => {
  const { pool, log } = recordingPool();
  installPostgresPool(pool);
  await assert.rejects(
    RepoSeam.transport!({ entity: "note; drop table dsx_note", op: "list", token: null, subject: ALICE, scope: "user" }),
    /not a legal identifier/,
  );
  assert.deepEqual(log, [], "a rejected query still opened a transaction");
});

test("pool: admission is bounded BEFORE the driver's own waiting queue", async () => {
  const never = new Promise<SqlConnection>(() => {});
  installPostgresPool({ connect: () => never }, { maxInFlight: 2, acquireTimeoutMs: 1000 });
  void RepoSeam.transport!(listFor(ALICE)).catch(() => {});
  void RepoSeam.transport!(listFor(BOB)).catch(() => {});
  await Promise.resolve();
  await assert.rejects(
    RepoSeam.transport!(listFor(ALICE)),
    /pool is saturated \(2 requests admitted\)/,
    "the engine admitted an unbounded driver checkout queue",
  );
});

test("pool: acquisition has a deadline and a late connection is immediately released", async () => {
  let deliver!: (connection: SqlConnection) => void;
  let calls = 0;
  let releases = 0;
  const normal: SqlConnection = {
    query: async () => ({ rows: [] }),
    release: () => { releases++; },
  };
  const pool: SqlPool = {
    connect: () => {
      calls++;
      return calls === 1 ? new Promise<SqlConnection>((resolve) => { deliver = resolve; }) : Promise.resolve(normal);
    },
  };
  installPostgresPool(pool, { maxInFlight: 1, acquireTimeoutMs: 15 });
  await assert.rejects(
    RepoSeam.transport!(listFor(ALICE)),
    /acquisition timed out after 15 ms/,
  );

  deliver(normal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(releases, 1, "a checkout arriving after its deadline leaked from the pool");

  await RepoSeam.transport!(listFor(BOB));
  assert.equal(releases, 2, "the late checkout kept its admission slot forever");
});

test("pool: a driver query deadline rolls the transaction back and releases its connection", async () => {
  const seen: string[] = [];
  let releases = 0;
  const pool: SqlPool = {
    connect: async () => ({
      query: async (text: string) => {
        seen.push(text);
        if (text.startsWith("select *")) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          throw new Error("Query read timeout");
        }
        return { rows: [] };
      },
      release: () => { releases++; },
    }),
  };
  installPostgresPool(pool, { maxInFlight: 2, acquireTimeoutMs: 50 });
  const started = Date.now();
  await assert.rejects(RepoSeam.transport!(listFor(ALICE)), /Query read timeout/);
  assert.ok(Date.now() - started < 100, "the stalled query was not bounded by the driver deadline");
  assert.equal(seen.at(-1), "rollback", "a timed-out statement left its transaction open");
  assert.equal(releases, 1, "a timed-out statement pinned its pool connection");
});

// ── 2. a single connection: concurrent transactions must not interleave ──────────────────

test("single client: concurrent requests are serialised, never nested", async () => {
  const log: Logged[] = [];
  const client: SqlClient = {
    query: async (text, params = []) => {
      await new Promise((r) => setTimeout(r, 1)); // a real round trip, so interleaving is possible
      log.push({ connection: 0, text, params });
      return { rows: [] };
    },
  };
  installPostgresClient(client);

  await Promise.all([ALICE, BOB, ALICE].map((s) => RepoSeam.transport!(listFor(s))));

  // Every begin must be followed by its own commit before the next begin. If transactions
  // interleaved, a second `begin` would appear before the first `commit` — and the statement
  // between them would have executed under whichever identity was set last.
  let depth = 0;
  for (const entry of log) {
    if (entry.text === "begin") {
      depth++;
      assert.equal(depth, 1, "a transaction began while another was still open on the same connection");
    }
    if (entry.text === "commit" || entry.text === "rollback") depth--;
  }
  assert.equal(log.filter((l) => l.text === "begin").length, 3);
  assert.equal(depth, 0, "a transaction was left open");
});

// ── 3. the classification is DECLARED, never sniffed ─────────────────────────────────────
//
// This file once let the transport guess pool-vs-client from `typeof source.connect`. A review
// caught it: `pg.Client` HAS `.connect()`, so a dedicated client took the pool path — a
// pre-connected one threw on every request, and a fresh one COMMITTED its transaction and then
// threw on the missing `.release()` (a write that lands while the caller is told it failed).
// The reverse was worse: a pool wrapped as `{ query }` for metrics took the serialised path and
// scattered transactions across connections again. There is no sniffing left to regress, so
// these pin the property that replaced it.

test("classification: a pg.Client-shaped object (connect() but no release()) is safe as a CLIENT", async () => {
  const seen: string[] = [];
  // the exact shape that broke: has connect(), has NO release()
  const clientShaped = {
    connect: async () => {
      throw new Error("Client has already been connected. You cannot reuse a client.");
    },
    query: async (text: string) => {
      seen.push(text);
      return { rows: [] };
    },
  };
  installPostgresClient(clientShaped as unknown as SqlClient);
  await RepoSeam.transport!(listFor(ALICE));
  // it must never have tried to check a connection out
  assert.ok(seen.includes("begin") && seen.includes("commit"), "the transaction did not run on the client itself");
  assert.ok(seen.includes("set local role authenticated"), "identity was not applied");
});

test("classification: a pool wrapped so it has no connect() is still POOLED when declared so", async () => {
  const { pool, log, live } = recordingPool({ delayMs: 1 });
  // a metrics/tracing wrapper — the shape that silently fell back to serialised before
  const wrapped: SqlPool = { connect: async () => pool.connect() };
  installPostgresPool(wrapped);
  await Promise.all([ALICE, BOB, ALICE, BOB].map((s) => RepoSeam.transport!(listFor(s))));
  for (const group of transactions(log)) {
    assert.equal(new Set(group.map((l) => l.connection)).size, 1, "a transaction spanned connections");
  }
  assert.equal(live(), 0);
});

test("single client: a saturated queue REFUSES rather than growing without bound", async () => {
  // one never-settling call — a stalled socket or a lock wait
  const client: SqlClient = { query: () => new Promise(() => {}) };
  installPostgresClient(client);
  void RepoSeam.transport!(listFor(ALICE)).catch(() => {});
  // Fill the queue to the cap. These legitimately never settle — they are waiting on a call
  // that never returns — so they must NOT be awaited; awaiting them is waiting forever.
  for (let i = 0; i < 1000; i++) void RepoSeam.transport!(listFor(BOB)).catch(() => {});
  // The next one is over the cap and must be refused NOW rather than joining the queue.
  await assert.rejects(
    RepoSeam.transport!(listFor(BOB)),
    /saturated/,
    "the queue grew without bound behind a stalled call — 200k waiters measured at 372 MB of retained heap",
  );
});

test("single client: a fresh install does not inherit the previous transport's stalled queue", async () => {
  installPostgresClient({ query: () => new Promise(() => {}) }); // wedged transport
  void RepoSeam.transport!(listFor(ALICE)).catch(() => {});

  let ran = false;
  installPostgresClient({
    query: async () => {
      ran = true;
      return { rows: [] };
    },
  });
  // must complete on its own; previously it waited behind the WEDGED transport's chain
  await RepoSeam.transport!(listFor(BOB));
  assert.ok(ran, "a healthy new transport was blocked by the previous one — the serial chain was module-global");
});

test("pool: a throwing release() does not replace the error that caused it", async () => {
  const failing: SqlPool = {
    connect: async () => ({
      query: async (text: string) => {
        if (text === "begin") throw new Error("REAL CAUSE: connection reset by peer");
        return { rows: [] };
      },
      release: () => {
        throw new Error("release is not a function");
      },
    }),
  };
  installPostgresPool(failing);
  await assert.rejects(
    RepoSeam.transport!(listFor(ALICE)),
    /REAL CAUSE/,
    "the release failure masked the real cause — the incident would be unexplainable",
  );
});

test("single client: one failed request does not wedge the ones queued behind it", async () => {
  let calls = 0;
  const client: SqlClient = {
    query: async (text) => {
      calls++;
      if (text.startsWith("select *") && calls < 10) throw new Error("transient");
      return { rows: [] };
    },
  };
  installPostgresClient(client);
  const results = await Promise.allSettled([ALICE, BOB, ALICE].map((s) => RepoSeam.transport!(listFor(s))));
  assert.ok(results.some((r) => r.status === "rejected"), "expected the failing request to reject");
  // the queue must keep draining: a rejection that is not caught when chaining would leave
  // every later caller pending forever, which reads in production as a hung server
  assert.equal(results.length, 3);
});
