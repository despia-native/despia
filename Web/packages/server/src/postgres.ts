//
//  postgres.ts — the SQL transport behind `RepoSeam` (plan B5) and `QueueSeam` (L-11).
//
//  THE CLAIM THIS FILE MAKES GOOD ON:
//
//      user A cannot read user B's rows.
//
//  Everything before this file only DESCRIBED that intention — the schema facet declared
//  `ownership: "owner"`, the emitter compiled it into a row-level-security policy, and the
//  repository refused to hand a handler service authority. But nothing ever executed against a
//  database, so the claim rested on reading code. `rls.postgres.test.ts` executes it against a
//  real Postgres and asserts B gets nothing.
//
//  HOW A REQUEST BECOMES A USER, not the server:
//
//  Postgres decides RLS from the CURRENT ROLE and the current settings, not from anything in
//  the SQL text. So every query runs inside a transaction that first says who is asking:
//
//      begin
//      select set_config('request.jwt.claim.sub', '<verified sub>', true)   -- true = tx-local
//      set local role authenticated
//      <the statement>
//      commit
//
//  This is exactly what PostgREST does per request, which is why the same declared policy works
//  whether Supabase fronts the database or this transport talks to it directly. `set_config`
//  with `is_local = true` is scoped to the transaction, so one request's identity can never
//  leak into the next one on a pooled connection — the failure that would turn a shared pool
//  into a cross-tenant data leak.
//
//  THE THREE SCOPES ARE NOT INTERCHANGEABLE:
//    • user + subject  → role `authenticated`, `auth.uid()` set. RLS applies AS THAT USER.
//    • user, no subject → role `anon`. RLS applies and an owner-policy table yields nothing.
//    • service          → role untouched (the connection's own, RLS-bypassing) — internal jobs
//                         only, on routes the gateway already restricts to service callers.
//  An anonymous read arriving as `service` would hand RLS-bypassing authority to any stranger,
//  which is why `RepoQuery.scope` exists rather than being inferred from "no token".
//
//  Platform-free: no driver is imported. A caller passes any client with a `query` method —
//  `pg`, a Supabase pooler connection, or PGlite in the test — so this file never picks a vendor.
//

import { RepoError, RepoSeam, type RepoQuery } from "./repo.ts";
import { RateLimitSeam, type RateLimitStore } from "./ratelimit.ts";
import { SpendSeam, type SpendStore } from "./spend.ts";
import {
  assertChannel,
  RealtimeError,
  RealtimeSeam,
  type RealtimeEvent,
  type RealtimeReadRequest,
  type RealtimeTransport,
} from "./realtime.ts";
import {
  assertQueueName,
  QueueError,
  QueueSeam,
  type QueueClaimRequest,
  type QueueDeadLetter,
  type QueueDeadLetterRequest,
  type QueueEnqueueRequest,
  type QueueEnqueueResult,
  type QueueMessage,
  type QueueSettleRequest,
  type QueueTransport,
} from "./queue.ts";

/** The minimum a SQL driver must offer. `pg`, PGlite and postgres.js all satisfy it as-is. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** One connection checked out of a pool, returned with `release()`. `pg.PoolClient` matches. */
export interface SqlConnection extends SqlClient {
  release(): void;
}

/**
 * A driver that hands out dedicated connections. `pg.Pool` satisfies this as-is.
 *
 * THIS INTERFACE EXISTS BECAUSE OF A CONFIRMED LEAK. The identity preamble below and the
 * statement it guards MUST run on the same physical connection: `set local role` and
 * `set_config(…, true)` are connection-and-transaction state, not properties of the SQL text.
 * A pool's own `query()` method checks out a fresh connection PER CALL, so the preamble lands on
 * one connection and the statement executes on another — under the pool's login role, with
 * `auth.uid()` unset.
 *
 * Measured against Postgres 17 with eight concurrent callers through `pool.query()`: one of Bob's
 * four requests returned Alice's row, and three of Alice's four returned nothing of her own.
 * Serially it is invisible — an idle pool hands the same connection back every time, so the bug
 * passes every single-threaded test and appears only under load.
 */
export interface SqlPool {
  connect(): Promise<SqlConnection>;
}

//  WHY THERE IS NO `isPool(source)` HERE ANY MORE.
//
//  This file briefly decided pool-vs-client by sniffing `typeof source.connect === "function"`.
//  That is wrong, and an adversarial review caught it against pg 8.22: **`pg.Client` also has
//  `.connect()`** — so a dedicated client, the exact case the serialised path exists for, took
//  the pool path. A pre-connected client then threw "Client has already been connected" on every
//  request (total outage), and a non-connected one COMMITTED its transaction and then threw on
//  the missing `.release()` — a write that lands while the caller is told it failed, which is how
//  you get duplicate rows from a retrying client. PGlite has no `.connect`, which is the only
//  reason the suite stayed green.
//
//  The reverse misdetection was worse: a pool wrapped for metrics/logging (`{ query }`), or one
//  whose checkout is spelled `acquire`, took the SERIALISED path and scattered transactions
//  across connections again — the very leak this transport was written to close, measured at
//  11 cross-tenant reads in 40 requests under contention.
//
//  So the caller DECLARES what it has. That is this codebase's own law applied to itself:
//  declaration over inference, because a wrong inference here is a silent data leak.

/** Table prefix — the emitter writes `dsx_<entity>` (prepare_server.rb). One spelling, both sides. */
const TABLE_PREFIX = "dsx_";

/** Roles, matching Supabase's. Constants, never interpolated from a request. */
const ROLE_AUTHENTICATED = "authenticated";
const ROLE_ANON = "anon";

/**
 * Identifiers cannot be parameterised in SQL, so they are validated against the same
 * snake_case grammar `prepare_server.rb` enforces on the declaration. Every name reaching here
 * has already been checked twice (emitter, then the repository's field allowlist); this is the
 * third, at the point of concatenation, because that is the only place an injection could land.
 */
const IDENT = /^[a-z][a-z0-9_]*$/;

function ident(name: string, what: string): string {
  if (!IDENT.test(name)) {
    throw new RepoError(`${what} "${name}" is not a legal identifier`, "bad_request");
  }
  return name;
}

const tableOf = (entity: string): string => TABLE_PREFIX + ident(entity, "entity");

export interface Statement {
  text: string;
  params: unknown[];
}

/**
 * Compile a RepoQuery into one parameterised statement. Pure — no client, no identity, no I/O —
 * so the shape of every generated statement is unit-testable without a database.
 *
 * Every VALUE is a placeholder. Only identifiers are interpolated, and only after `ident()`.
 */
export function buildStatement(query: RepoQuery): Statement {
  const table = tableOf(query.entity);
  const params: unknown[] = [];
  const p = (value: unknown): string => `$${params.push(value)}`;

  switch (query.op) {
    case "list": {
      const where = Object.entries(query.filters ?? {})
        .map(([column, value]) => `${ident(column, "filter")} = ${p(value)}`);
      const clause = where.length === 0 ? "" : ` where ${where.join(" and ")}`;
      // Ordered so paging is stable; bounded so a list can never be an exfiltration primitive.
      return { text: `select * from ${table}${clause} order by created_at desc limit ${p(query.limit ?? 100)}`, params };
    }
    case "get":
      return { text: `select * from ${table} where id = ${p(query.id)}`, params };
    case "create": {
      const values = query.values ?? {};
      const columns = Object.keys(values).map((c) => ident(c, "column"));
      // No declared field supplied: let the table's own defaults (id, owner_id, created_at) fill
      // the row. `insert into t () values ()` is a syntax error, so this spelling is required.
      if (columns.length === 0) return { text: `insert into ${table} default values returning *`, params };
      const placeholders = Object.values(values).map((v) => p(v));
      return { text: `insert into ${table} (${columns.join(", ")}) values (${placeholders.join(", ")}) returning *`, params };
    }
    case "update": {
      const values = query.values ?? {};
      const sets = Object.entries(values).map(([column, value]) => `${ident(column, "column")} = ${p(value)}`);
      if (sets.length === 0) throw new RepoError("an update needs at least one declared field", "bad_request");
      return { text: `update ${table} set ${sets.join(", ")} where id = ${p(query.id)} returning *`, params };
    }
    case "delete":
      return { text: `delete from ${table} where id = ${p(query.id)} returning id`, params };
  }
}

// ── the QUEUE plane (queue.ts) — a second seam, not a widened repository ─────────────────
//
//  Every declared `worker` queue is one `dsx_queue_<name>` table emitted by prepare_server.rb.
//  The lease needs `claimed_at` + `attempts`; FIFO needs a monotonic `enqueue_order`. A timestamp
//  is not an order key: two inserts can share one clock tick, and UUID tie-breaking then returns
//  a random order. The identity column makes enqueue order explicit and durable.
//
//  The queue plane declares those protocol columns here as SQL the emitter also produces:
//  `queueTableSql(queue)` is written to be applied after the emitted migration and change
//  nothing that already matches (`create table if not exists` + `add column if not exists`), so
//  it is simultaneously the requirement, the convergence step for a live database, and the
//  fixture the tests apply.

/**
 * How a caller of this module hands the transports a connection: repository and queue share ONE
 * runner per install, so both planes inherit the same connection discipline (a pooled checkout
 * held for the whole transaction, or a serialised single client) rather than each inventing its
 * own and one of them getting it wrong.
 */
type SqlRunner = <T>(fn: (c: SqlClient) => Promise<T>) => Promise<T>;

/** Queue tables are `dsx_queue_<name>` — one spelling, matching prepare_server.rb. */
const QUEUE_PREFIX = "dsx_queue_";

const queueTable = (queue: string): string => QUEUE_PREFIX + ident(assertQueueName(queue), "queue");

/**
 * The queue table exactly as the claim protocol requires it.
 *
 * Idempotent by construction and byte-aligned with the emitter. Applying it to an older database
 * adds the FIFO identity and two lease columns without changing matching state. `attempts` is
 * `not null default 0` so existing rows converge to a real delivery count rather than NULL.
 */
export function queueTableSql(queue: string): string {
  const t = queueTable(queue);
  return [
    `create table if not exists ${t} (`,
    "  id uuid primary key default gen_random_uuid(),",
    "  enqueue_order bigint generated by default as identity,",
    "  idempotency_key text not null unique,",
    "  payload jsonb not null default '{}'::jsonb,",
    "  created_at timestamptz not null default now(),",
    "  processed_at timestamptz",
    ");",
    `alter table ${t} add column if not exists enqueue_order bigint generated by default as identity;`,
    `alter table ${t} add column if not exists claimed_at timestamptz;`,
    `alter table ${t} add column if not exists attempts integer not null default 0;`,
    // The TERMINAL failure state (queue.ts "POISON MESSAGES"). Nullable and added by ALTER like
    // the lease columns, so an older queue table converges without rewriting matching state: every
    // existing row reads as not-dead-lettered, which is exactly what it was.
    `alter table ${t} add column if not exists dead_lettered_at timestamptz;`,
    `alter table ${t} add column if not exists dead_letter_reason text;`,
    // The claim's own access path: the pending set, in enqueue order. Partial, because a drained
    // queue is mostly processed rows and indexing those costs writes for a set nothing reads.
    // Dead letters are excluded from the predicate for the same reason processed rows are: they
    // are terminal, the claim can never return them, and an index entry nothing reads is a tax on
    // every insert.
    `drop index if exists ${t}_pending_fifo_idx;`,
    `create index if not exists ${t}_pending_fifo_idx on ${t} (enqueue_order) where processed_at is null and dead_lettered_at is null;`,
    // The operator's view — newest first, and only over the rows that are actually stuck.
    `create index if not exists ${t}_dead_letter_idx on ${t} (dead_lettered_at desc) where dead_lettered_at is not null;`,
    `alter table ${t} enable row level security;`,
    // A queue is service-only, and that needs an explicit REVOKE rather than the absence of a
    // GRANT. Neither emitter grants anything here, yet a real Supabase project reported the
    // queue table visible in the auto-generated GraphQL schema to `anon`: the platform ships
    // `alter default privileges in schema public grant ... to anon, authenticated`, so the
    // table is reachable the moment it exists. RLS denies every row, so no data leaks — the
    // leak is the queue's shape (idempotency key, lease columns, delivery count). Revoking a
    // privilege the role does not hold is a notice, not an error, so this is safe anywhere.
    `revoke all on ${t} from anon, authenticated;`,
    // …and the two layers the drain itself needs, which the revoke above makes mandatory rather
    // than optional: on a self-hosted deployment the connection role reached this table only as a
    // member of anon, so revoking left it with nothing.
    //
    // GRANT gets past the ACL. POLICY is what lets the drain SEE a row — a service-owned table is
    // RLS-enabled, and an RLS table with no policy shows nothing to anyone who neither owns it nor
    // holds bypassrls. Measured on Postgres 17 as a non-owner member role: grant alone returned
    // 200 having claimed nothing (silent no-op), policy alone died on permission denied, both
    // together drained 3 of 3. Naming service_role rather than leaning on a bypassrls attribute
    // keeps the reach equal to the declaration and portable to any Postgres; Postgres applies a
    // policy's TO list to MEMBERS, so service scope (which keeps the connection role) matches and
    // user scope (which has issued `set local role authenticated`) does not.
    `grant select, insert, update, delete on ${t} to service_role;`,
    `drop policy if exists ${t}_service on ${t};`,
    `create policy ${t}_service on ${t} for all to service_role using (true) with check (true);`,
    "",
  ].join("\n");
}

/**
 * THE CLAIM — one statement, and it must stay one statement.
 *
 * ONE STATEMENT IS THE CORRECTNESS PROPERTY. The UPDATE stamps the lease and bumps the delivery
 * count in the same statement that selects the candidates, so there is no window between "I read
 * this row" and "I own this row" for a second drain to slip into. Split into a select and a
 * later update, this is the classic double-delivery bug, and it is invisible until the queue is
 * busy. Deleting the lease predicate below fails `queue.live.test.ts` under eight concurrent
 * drains, which is how that is known rather than assumed.
 *
 * `for update skip locked` is the LIVENESS property, and it is worth being precise about the
 * difference: without it concurrent claims are still correct — Postgres re-applies the WHERE to
 * the row version it locked — but they QUEUE behind one another, so one slow drain paces every
 * other. With it they take disjoint sets and never wait.
 *
 * The candidate predicate is the whole state machine:
 *   processed_at is null        → not already done
 *   attempts < maxAttempts      → not parked as poison
 *   claimed_at is null OR older than the lease → nobody currently holds it
 */
export function buildQueueClaimStatement(request: QueueClaimRequest): Statement {
  const t = queueTable(request.queue);
  const params: unknown[] = [];
  const p = (value: unknown): string => `$${params.push(value)}`;
  const maxAttempts = p(Math.max(1, Math.trunc(request.maxAttempts)));
  const leaseSeconds = p(Math.max(0, request.visibilityMs) / 1000);
  const limit = p(Math.max(1, Math.trunc(request.limit)));
  // The UPDATE is wrapped in a CTE so the rows come back in ENQUEUE ORDER. `update … returning`
  // has no defined row order — measured: three messages enqueued e1·e2·e3 were returned e1·e3·e2
  // — and a queue that delivers out of order for no reason is a bug a handler would eventually
  // be written around. The inner `order by` still decides WHICH rows are claimed under the limit;
  // this decides which order the caller sees them in.
  const text =
    `with claimed as (update ${t} as q set claimed_at = now(), attempts = q.attempts + 1 ` +
    `where q.id in (select c.id from ${t} as c ` +
    `where c.processed_at is null and c.dead_lettered_at is null and c.attempts < ${maxAttempts}::int ` +
    `and (c.claimed_at is null or c.claimed_at < now() - make_interval(secs => ${leaseSeconds}::double precision)) ` +
    `order by c.enqueue_order limit ${limit}::int for update skip locked) ` +
    `returning q.id, q.idempotency_key, q.payload, q.created_at, q.attempts, q.enqueue_order) ` +
    `select id, idempotency_key, payload, created_at, attempts from claimed order by enqueue_order`;
  return { text, params };
}

/**
 * THE ENQUEUE — one statement, and the UNIQUE index is what makes it safe.
 *
 * `on conflict (idempotency_key) do nothing` is the entire duplicate story. Two senders retrying
 * the same delivery at the same instant both reach this; exactly one inserts and the other's
 * RETURNING comes back empty, decided by the index rather than by anything this process could
 * observe. A read-then-insert would lose that race under precisely the load that makes webhook
 * retries happen.
 *
 * `do nothing` rather than `do update`: the stored payload of an event is the FIRST one received.
 * Letting a retry overwrite it would let a replayed delivery mutate a message that a drain may
 * already be holding a lease on.
 */
export function buildQueueEnqueueStatement(request: QueueEnqueueRequest): Statement {
  const t = queueTable(request.queue);
  const params: unknown[] = [request.key, JSON.stringify(request.payload ?? {})];
  const depth = request.maxPending;
  if (typeof depth !== "number" || !Number.isFinite(depth) || depth <= 0) {
    return {
      text: `insert into ${t} (idempotency_key, payload) values ($1, $2::jsonb) on conflict (idempotency_key) do nothing returning id`,
      params,
    };
  }
  // THE DEPTH CEILING, in the same statement as the insert (QueueEnqueueRequest.maxPending). The
  // pending count and the conditional insert travel together so the check cannot race apart from
  // the write it guards. `existing` rides along because a RETRY OF A STORED DELIVERY must answer
  // `duplicate` even at the ceiling — a sender retrying an event the queue already holds must
  // get the same success it got the first time, whatever the backlog looks like (the webhook
  // law). The count predicate matches the pending index's exactly, so the ceiling read is an
  // index-only scan, not a table walk.
  params.push(Math.trunc(depth));
  return {
    text:
      `with cap as (select count(*)::int as pending from ${t} where processed_at is null and dead_lettered_at is null), ` +
      `existing as (select id from ${t} where idempotency_key = $1 limit 1), ` +
      `ins as (insert into ${t} (idempotency_key, payload) select $1, $2::jsonb ` +
      `where (select pending from cap) < $3::int and not exists (select 1 from existing) ` +
      `on conflict (idempotency_key) do nothing returning id) ` +
      `select (select pending from cap) as pending, (select id from ins) as inserted, (select id from existing) as existing`,
    params,
  };
}

/** Longest failure text kept on a dead letter. Enough for a stack-free message; not a log sink. */
const MAX_DEAD_LETTER_REASON = 2000;

/**
 * THE DEAD LETTER — one statement, one `update … from (values …)` join, so N messages with N
 * DIFFERENT reasons cost one round trip instead of N.
 *
 * `and dead_lettered_at is null` keeps it idempotent: a retried drain must not overwrite the
 * reason recorded by the attempt that actually exhausted the message.
 */
export function buildQueueDeadLetterStatement(request: QueueDeadLetterRequest): Statement {
  const t = queueTable(request.queue);
  const params: unknown[] = [];
  const rows = request.entries
    .map((entry) => {
      if (!UUID.test(entry.id)) throw new QueueError(`"${entry.id}" is not a queue message id`, "bad_request");
      // The reason is a handler's exception text: it can be arbitrarily long and is not the
      // operator's to pay for by the row. Truncated at the plane, never at the column.
      return `($${params.push(entry.id)}::uuid, $${params.push(String(entry.reason).slice(0, MAX_DEAD_LETTER_REASON))}::text)`;
    })
    .join(", ");
  return {
    text:
      `update ${t} as q set dead_lettered_at = now(), dead_letter_reason = v.reason, claimed_at = null ` +
      `from (values ${rows}) as v(id, reason) where q.id = v.id and q.processed_at is null and q.dead_lettered_at is null returning q.id`,
    params,
  };
}

export function buildQueueDeadLetterListStatement(queue: string, limit: number): Statement {
  const t = queueTable(queue);
  const params: unknown[] = [Math.max(1, Math.trunc(limit))];
  return {
    text:
      `select id, idempotency_key, payload, created_at, attempts, dead_lettered_at, dead_letter_reason ` +
      `from ${t} where dead_lettered_at is not null order by dead_lettered_at desc limit $1::int`,
    params,
  };
}

/**
 * THE REPLAY — clears the terminal state AND resets `attempts`.
 *
 * Resetting the count is not cosmetic: the claim predicate refuses anything at or past
 * `maxAttempts`, so a replay that only cleared `dead_lettered_at` would produce a row that is no
 * longer dead-lettered and still never claimed — invisible in both views at once, which is worse
 * than either state alone.
 */
export function buildQueueReplayStatement(queue: string, ids: readonly string[]): Statement {
  const t = queueTable(queue);
  const params: unknown[] = [];
  const list = ids
    .map((id) => {
      if (!UUID.test(id)) throw new QueueError(`"${id}" is not a queue message id`, "bad_request");
      return `$${params.push(id)}`;
    })
    .join(", ");
  return {
    text:
      `update ${t} set dead_lettered_at = null, dead_letter_reason = null, attempts = 0, claimed_at = null ` +
      `where id in (${list}) and dead_lettered_at is not null returning id`,
    params,
  };
}

/**
 * THE SETTLE — at most two statements, each a single set-membership update.
 *
 * `and processed_at is null` on both: acking a message twice must not move its completion time,
 * and releasing one that another pass already completed must not resurrect it. Making both
 * idempotent is what lets a retrying drain be safe.
 *
 * ACK KEEPS THE ROW. Deleting it would be tidier and would silently destroy the idempotency
 * guarantee the queue table declares — `idempotency_key` is UNIQUE, so the row's continued
 * existence is precisely what refuses a duplicate enqueue of the same event later.
 */
export function buildQueueSettleStatements(request: QueueSettleRequest): Statement[] {
  const t = queueTable(request.queue);
  const idList = (ids: readonly string[], params: unknown[]): string =>
    ids
      .map((id) => {
        // Ids come from this transport's own claim, so a non-uuid here means a caller invented
        // one. Parameters make it harmless either way; refusing makes it legible.
        if (!UUID.test(id)) throw new QueueError(`"${id}" is not a queue message id`, "bad_request");
        return `$${params.push(id)}`;
      })
      .join(", ");

  const statements: Statement[] = [];
  if (request.ack.length > 0) {
    const params: unknown[] = [];
    const list = idList(request.ack, params);
    statements.push({ text: `update ${t} set processed_at = now(), claimed_at = null where id in (${list}) and processed_at is null returning id`, params });
  }
  if (request.release.length > 0) {
    const params: unknown[] = [];
    const list = idList(request.release, params);
    statements.push({ text: `update ${t} set claimed_at = null where id in (${list}) and processed_at is null returning id`, params });
  }
  return statements;
}

/** A claimed row → the plane's message shape. Nothing here interprets the payload. */
function decodeQueueRow(row: unknown): QueueMessage {
  const r = (row ?? {}) as Record<string, unknown>;
  const raw = r["payload"];
  let payload: Record<string, unknown> = {};
  if (typeof raw === "string") {
    // Some drivers hand jsonb back as text. Parsing failure is not a reason to drop a message —
    // the handler is told the payload is empty and the row is still leased, acked or released
    // exactly as it would have been.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
  } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    payload = raw as Record<string, unknown>;
  }
  const created = r["created_at"];
  return {
    id: String(r["id"] ?? ""),
    key: String(r["idempotency_key"] ?? ""),
    payload,
    enqueuedAt: created instanceof Date ? created.toISOString() : created === null || created === undefined ? null : String(created),
    attempt: Number(r["attempts"] ?? 0),
  };
}

/**
 * SQLSTATEs that mean "the queue's table is not there yet", as codes rather than message text.
 * A driver's prose is not a contract and changes between versions; `42P01` (undefined_table) and
 * `42703` (undefined_column) are the wire's own vocabulary and both `pg` and PGlite surface them.
 */
const UNDEFINED_TABLE = "42P01";
const UNDEFINED_COLUMN = "42703";

function asQueueFailure(queue: string, e: unknown): unknown {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === UNDEFINED_TABLE || code === UNDEFINED_COLUMN) {
    return new QueueError(
      `the queue table for "${queue}" is missing or has no lease columns — apply queueTableSql("${queue}") ` +
        "(the emitted migration creates the table; the claim protocol also needs claimed_at and attempts)",
      "not_provisioned",
      { cause: e },
    );
  }
  return e;
}

/**
 * Run the queue's statements in one transaction, on ONE connection.
 *
 * NO ROLE IS SWITCHED, and that is the whole security note for this path: the queue plane has a
 * single SERVICE face (queue.ts), so it runs as the connection's own role exactly like a
 * `scope: "service"` repository query does in `runAs`. There is no identity to adopt, and
 * nothing here should ever learn how to adopt one.
 */
async function runQueueStatements(client: SqlClient, statements: Statement[]): Promise<unknown[][]> {
  const out: unknown[][] = [];
  await client.query("begin");
  try {
    for (const statement of statements) {
      const result = await client.query(statement.text, statement.params);
      out.push(result.rows);
    }
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

/** A dead-letter row → the plane's shape. The message half is decoded exactly as a claim's is. */
function decodeDeadLetterRow(row: unknown): QueueDeadLetter {
  const r = (row ?? {}) as Record<string, unknown>;
  const at = r["dead_lettered_at"];
  return {
    ...decodeQueueRow(row),
    reason: String(r["dead_letter_reason"] ?? ""),
    deadLetteredAt: at instanceof Date ? at.toISOString() : at === null || at === undefined ? null : String(at),
  };
}

function queueTransport(run: SqlRunner): QueueTransport {
  return {
    enqueue: async (request: QueueEnqueueRequest): Promise<QueueEnqueueResult> => {
      const statement = buildQueueEnqueueStatement(request);
      const capped = typeof request.maxPending === "number" && Number.isFinite(request.maxPending) && request.maxPending > 0;
      try {
        const [rows = []] = await run((c) => runQueueStatements(c, [statement]));
        if (!capped) {
          const inserted = rows[0] as { id?: unknown } | undefined;
          // No row back means `do nothing` fired: the key was already present. That is the
          // duplicate, and it is a success — see QueueEnqueueRequest.
          return inserted === undefined
            ? { id: null, duplicate: true }
            : { id: String(inserted.id ?? ""), duplicate: false };
        }
        // The capped statement ALWAYS answers one row: the pending count, the inserted id (or
        // null), and the pre-existing row's id (or null). Existing wins — a retry of a stored
        // delivery is `duplicate` whatever the backlog looks like. Then an insert is success,
        // and neither is the ceiling — `saturated`, the transient code, because the consumer
        // draining is what clears it and a retry after backoff is the correct caller behaviour.
        // (An exactly-concurrent first delivery of the same key can land as `saturated` once —
        // the sender's retry then reads `duplicate`, which is the answer that matters.)
        const row = (rows[0] ?? {}) as { pending?: unknown; inserted?: unknown; existing?: unknown };
        if (row.existing !== null && row.existing !== undefined) return { id: null, duplicate: true };
        if (row.inserted !== null && row.inserted !== undefined) return { id: String(row.inserted), duplicate: false };
        throw new QueueError(
          `queue "${request.queue}" is at its declared depth ceiling (${request.maxPending} outstanding) — ` +
            `the enqueue is refused until the drain catches up`,
          "saturated",
        );
      } catch (e) {
        if (e instanceof QueueError) throw e;
        throw asQueueFailure(request.queue, e);
      }
    },
    claim: async (request: QueueClaimRequest): Promise<QueueMessage[]> => {
      const statement = buildQueueClaimStatement(request); // built outside the connection, like the repo path
      try {
        const [rows = []] = await run((c) => runQueueStatements(c, [statement]));
        return rows.map(decodeQueueRow);
      } catch (e) {
        throw asQueueFailure(request.queue, e);
      }
    },
    settle: async (request: QueueSettleRequest): Promise<{ acked: number; released: number }> => {
      const statements = buildQueueSettleStatements(request);
      if (statements.length === 0) return { acked: 0, released: 0 };
      try {
        const results = await run((c) => runQueueStatements(c, statements));
        // The statements were pushed ack-first, so the counts read back in the same order.
        let index = 0;
        const acked = request.ack.length > 0 ? (results[index++]?.length ?? 0) : 0;
        const released = request.release.length > 0 ? (results[index]?.length ?? 0) : 0;
        return { acked, released };
      } catch (e) {
        throw asQueueFailure(request.queue, e);
      }
    },
    deadLetter: async (request: QueueDeadLetterRequest): Promise<number> => {
      if (request.entries.length === 0) return 0;
      const statement = buildQueueDeadLetterStatement(request);
      try {
        const [rows = []] = await run((c) => runQueueStatements(c, [statement]));
        return rows.length;
      } catch (e) {
        throw asQueueFailure(request.queue, e);
      }
    },
    listDeadLetters: async (request: { queue: string; limit: number }): Promise<QueueDeadLetter[]> => {
      const statement = buildQueueDeadLetterListStatement(request.queue, request.limit);
      try {
        const [rows = []] = await run((c) => runQueueStatements(c, [statement]));
        return rows.map(decodeDeadLetterRow);
      } catch (e) {
        throw asQueueFailure(request.queue, e);
      }
    },
    replayDeadLetters: async (request: { queue: string; ids: readonly string[] }): Promise<number> => {
      if (request.ids.length === 0) return 0;
      const statement = buildQueueReplayStatement(request.queue, request.ids);
      try {
        const [rows = []] = await run((c) => runQueueStatements(c, [statement]));
        return rows.length;
      } catch (e) {
        throw asQueueFailure(request.queue, e);
      }
    },
  };
}

/**
 * Run `fn` against ONE connection held for its whole duration.
 *
 * Pool: check a connection out and release it in `finally`, so the identity preamble and the
 * statement it authorises cannot land on different connections (see `SqlPool`).
 *
 * Single client (PGlite, a dedicated `pg.Client`): there is only one connection, so transactions
 * must not INTERLEAVE on it. Two concurrent requests would otherwise nest `begin`/`commit` and the
 * second caller's statement would execute inside the first caller's transaction — under the first
 * caller's identity. That is the same cross-tenant leak by a different route, so calls are queued:
 * each waits for the previous to finish. Serialising one connection is what a single connection
 * already is; the queue only stops the interleaving.
 */
/** Check a connection out for the whole transaction and always hand it back. */
async function withConnection<T>(connection: SqlConnection, fn: (c: SqlClient) => Promise<T>): Promise<T> {
  let failure: unknown;
  let failed = false;
  try {
    return await fn(connection);
  } catch (e) {
    failure = e;
    failed = true;
    throw e;
  } finally {
    // A throwing release() must never REPLACE the error that caused it. Reported as-is, a
    // "release is not a function" would be the only thing a caller ever saw of a connection
    // reset — the real cause lost, and the incident unexplainable.
    try {
      connection.release();
    } catch (releaseError) {
      if (!failed) throw releaseError;
      void failure;
    }
  }
}

export interface PostgresPoolGuardOptions {
  /** Active + acquiring + timed-out-but-not-yet-returned checkouts. Default 1000. */
  maxInFlight?: number;
  /** Maximum wait for `pool.connect()`. Default 5000 ms. */
  acquireTimeoutMs?: number;
}

const DEFAULT_POOL_MAX_IN_FLIGHT = 1000;
const DEFAULT_POOL_ACQUIRE_TIMEOUT_MS = 5000;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RepoError(`${name} must be a positive finite number`, "bad_request");
  }
  return Math.max(1, Math.trunc(resolved));
}

/**
 * A bounded pooled executor. A driver's pool normally has its own maximum connection count, but
 * that does NOT bound its waiting queue: pg-pool, for example, appends to `_pendingQueue` without
 * a ceiling and waits forever when `connectionTimeoutMillis` is absent. The engine therefore
 * admits a finite number before calling the driver and puts its own deadline around acquisition.
 *
 * A timed-out `connect()` may still resolve later on a driver that cannot cancel checkout. That
 * connection is released immediately and the admission slot remains occupied UNTIL it arrives;
 * releasing the slot when the caller times out would let a dead pool retain a fresh unbounded
 * generation of late promises every deadline interval.
 */
function pooledExecutor(
  pool: SqlPool,
  options: PostgresPoolGuardOptions,
): <T>(fn: (c: SqlClient) => Promise<T>) => Promise<T> {
  const maxInFlight = positiveInteger(options.maxInFlight, DEFAULT_POOL_MAX_IN_FLIGHT, "maxInFlight");
  const acquireTimeoutMs = positiveInteger(options.acquireTimeoutMs, DEFAULT_POOL_ACQUIRE_TIMEOUT_MS, "acquireTimeoutMs");
  let admitted = 0;

  return async <T>(fn: (c: SqlClient) => Promise<T>): Promise<T> => {
    if (admitted >= maxInFlight) {
      throw new RepoError(
        `the database pool is saturated (${admitted} requests admitted) — refusing to queue another`,
        "saturated",
      );
    }
    admitted += 1;
    let slotHeld = true;
    const releaseSlot = (): void => {
      if (!slotHeld) return;
      slotHeld = false;
      admitted -= 1;
    };

    // Promise.resolve catches a pool whose `connect()` throws synchronously as well as one which
    // rejects normally, keeping the slot accounting identical for both driver shapes.
    const acquisition = Promise.resolve().then(() => pool.connect());
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new RepoError(`database connection acquisition timed out after ${acquireTimeoutMs} ms`, "saturated"));
      }, acquireTimeoutMs);
      // THE DEADLINE IS NOT UNREF'd, and that is deliberate. An unref'd timer cannot hold the
      // event loop, so when nothing else is pending the loop DRAINS BEFORE THE DEADLINE FIRES and
      // the caller awaiting this race is never answered at all — the typed `saturated` refusal
      // this whole path exists to deliver simply never arrives. That is not merely a test
      // artifact: a short-lived host (an edge invocation, a one-shot deploy/migration script)
      // has no listening socket keeping the loop alive, so it is exactly the shape that loses
      // the answer. A long-lived server is unaffected either way — its socket holds the loop —
      // so referencing the timer costs it nothing. The timer is cleared the moment the
      // acquisition settles, on BOTH the success path and the failure path below, so a
      // referenced deadline extends process life only while a checkout is genuinely outstanding.
      //
      // Measured before the fix: `postgres.connection.test.ts` ran 5 of its 14 tests and the
      // other 9 reported `cancelledByParent` ("Promise resolution is still pending but the event
      // loop has already resolved") — starting at the first test that depends on this deadline
      // firing. Zero assertion failures, so it read as runner noise for as long as it survived.
    });

    let connection: SqlConnection;
    try {
      connection = await Promise.race([acquisition, timeout]);
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      if (!timedOut) {
        releaseSlot();
      } else {
        // The caller gets its bounded refusal now. Cleanup follows the driver's eventual answer.
        void acquisition.then(
          (late) => {
            try { late.release(); } catch { /* there is no caller left to report cleanup to */ }
            releaseSlot();
          },
          () => releaseSlot(),
        );
      }
      throw error;
    }
    if (timer !== undefined) clearTimeout(timer);

    try {
      return await withConnection(connection, fn);
    } finally {
      releaseSlot();
    }
  };
}

/**
 * How many requests may queue behind one in-flight transaction on a single connection.
 *
 * A single connection cannot run transactions concurrently, so callers wait. If the one in
 * flight never settles (a stalled socket, a lock wait), every later caller waits forever and the
 * queue grows unbounded: 200k queued requests measured at 372 MB of retained heap, none running.
 * Refusing past a depth is the honest answer — the server is not able to serve them, and saying
 * so lets a load balancer shed while a silent queue would just consume the process.
 */
const MAX_QUEUE_DEPTH = 1000;

/** A serialised executor bound to ONE client. Created per install — never module-global. */
function serialiser(client: SqlClient): <T>(fn: (c: SqlClient) => Promise<T>) => Promise<T> {
  // Module-global state here used to mean one stalled call in an earlier test wedged every
  // later one in the process, and a fresh install inherited the previous transport's backlog.
  let tail: Promise<unknown> = Promise.resolve();
  let depth = 0;
  return <T>(fn: (c: SqlClient) => Promise<T>): Promise<T> => {
    if (depth >= MAX_QUEUE_DEPTH) {
      return Promise.reject(
        new RepoError(`the database connection is saturated (${depth} requests queued) — refusing to queue another`, "saturated"),
      );
    }
    depth += 1;
    // chain past however the previous call settled, or one rejection wedges the queue
    const mine = tail.then(() => fn(client), () => fn(client));
    tail = mine.then(() => undefined, () => undefined).finally(() => {
      depth -= 1;
    });
    return mine;
  };
}

/**
 * Run one statement under the caller's identity, in its own transaction.
 *
 * The identity is applied INSIDE the transaction and torn down with it (`set local`,
 * `set_config(..., true)`), so nothing survives into the next request on the same connection.
 */
/**
 * `owner_id` is `uuid` and `auth.uid()` casts to uuid, so a subject that is not a UUID cannot
 * scope anything — Auth0 (`auth0|abc123`) and Clerk (`user_2abcXYZ`) both mint exactly that, and
 * `auth_mode: "jwks"` invites precisely those providers. Unchecked, the cast failed deep inside
 * the statement and surfaced as a bare 500 with `internal error`: a total outage for that
 * deployment with nothing anywhere naming the cause. Checked here, it is still a failure — the
 * schema genuinely cannot store it — but one that says what is wrong and what to do.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function runAs(client: SqlClient, query: RepoQuery, statement: Statement): Promise<unknown[]> {
  if (query.scope === "user" && query.subject !== null && !UUID.test(query.subject)) {
    throw new RepoError(
      `the verified identity "${query.subject}" is not a UUID, and this schema stores owner_id as uuid — ` +
        "the identity provider must mint UUID subjects for owner-scoped data",
      "bad_request",
    );
  }
  await client.query("begin");
  try {
    if (query.scope === "user") {
      if (query.subject !== null) {
        // Both spellings: PostgREST-era `request.jwt.claim.sub` and the current
        // `request.jwt.claims` JSON. Supabase's own auth.uid() has read each over time, and a
        // policy written against the other spelling must not silently evaluate to NULL —
        // which, on an `owner_id = auth.uid()` policy, would look exactly like "no rows".
        await client.query("select set_config('request.jwt.claim.sub', $1, true)", [query.subject]);
        await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: query.subject, role: ROLE_AUTHENTICATED })]);
        await client.query(`set local role ${ROLE_AUTHENTICATED}`);
      } else {
        await client.query(`set local role ${ROLE_ANON}`);
      }
    }
    const result = await client.query(statement.text, statement.params);
    await client.query("commit");
    return result.rows;
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

/**
 * Fill the repository AND queue seams with a Postgres transport over `run`.
 *
 * `list` returns the rows; every single-row op returns the row or null — never an empty array a
 * caller might treat as truthy. A `get` that RLS filtered out is indistinguishable from a row
 * that does not exist, which is the correct answer: confirming existence to someone not allowed
 * to read it is itself a leak.
 *
 * BOTH SEAMS, ONE INSTALL. The queue is a distinct plane (queue.ts) but not a distinct
 * deployment: the same provider module, the same connection string, the same pool. Filling them
 * together is what lets a `worker` route drain with no change to the provider residence — and it
 * means the two planes can never end up on differently-configured connections, which is the
 * class of mistake that leaves a queue silently writing to yesterday's database.
 */
// ── the request-budget counter (ratelimit.ts) ───────────────────────────────────────────

const RATE_TABLE = `${TABLE_PREFIX}rate_counter`;

/**
 * The counter table. Service-only, exactly like a queue table and for the same reasons — the
 * three lines below (revoke · grant · policy) are what make a non-owner connection role able to
 * reach an RLS-enabled table without granting anything to `anon`.
 *
 * `window_start` is part of the primary key rather than a column that gets overwritten: the upsert
 * needs a conflict target that is stable for the life of a window, and keeping expired windows as
 * distinct rows is what lets `sweepRateCounters` delete them by predicate instead of by scan.
 */
export function rateLimitTableSql(): string {
  const t = RATE_TABLE;
  return [
    `create table if not exists ${t} (`,
    "  bucket text not null,",
    "  window_start timestamptz not null,",
    "  expires_at timestamptz not null,",
    "  count integer not null default 0,",
    "  primary key (bucket, window_start)",
    ");",
    `create index if not exists ${t}_expiry_idx on ${t} (expires_at);`,
    `alter table ${t} enable row level security;`,
    `revoke all on ${t} from anon, authenticated;`,
    `grant select, insert, update, delete on ${t} to service_role;`,
    `drop policy if exists ${t}_service on ${t};`,
    `create policy ${t}_service on ${t} for all to service_role using (true) with check (true);`,
    "",
  ].join("\n");
}

/**
 * THE HIT — one statement, and it must stay one statement.
 *
 * `on conflict … do update set count = ${t}.count + 1 returning count` makes Postgres decide the
 * count under concurrency. A select-then-update would let two requests read the same value and
 * both write value+1, so the ceiling would be exceeded by exactly as much traffic as arrives at
 * once, which is the traffic the limit exists for.
 *
 * The insert's own `count` is 1, not 0: the row is created BY a request, and that request has
 * spent one unit. Starting at 0 makes every window admit `limit + 1`.
 */
export function buildRateHitStatement(bucket: string, windowStartMs: number, windowMs: number): Statement {
  const t = RATE_TABLE;
  // Two windows of grace before a row is sweepable, so a request arriving late against a window
  // that just closed still counts against the window it belongs to rather than opening a new one.
  const expiresAt = new Date(windowStartMs + windowMs * 3).toISOString();
  return {
    text:
      `insert into ${t} (bucket, window_start, expires_at, count) values ($1, $2::timestamptz, $3::timestamptz, 1) ` +
      `on conflict (bucket, window_start) do update set count = ${t}.count + 1 returning count`,
    params: [bucket, new Date(windowStartMs).toISOString(), expiresAt],
  };
}

/**
 * Delete windows nobody can still be counting against.
 *
 * A limiter that never prunes turns its own table into the outage: one row per (caller, window)
 * grows without bound, the index with it, and the upsert that must stay fast is the thing that
 * slows down. This is deliberately a plain DELETE the deploy's cron row calls, not a trigger and
 * not a background task — the same pg_cron schedule that drains the queue.
 */
export function buildRateSweepStatement(): Statement {
  return { text: `delete from ${RATE_TABLE} where expires_at < now() returning bucket`, params: [] };
}

function rateLimitStore(run: SqlRunner): RateLimitStore {
  return {
    hit: async (bucket: string, windowStartMs: number, windowMs: number): Promise<number> => {
      const statement = buildRateHitStatement(bucket, windowStartMs, windowMs);
      // NO TRANSACTION. A single upsert is already atomic, and wrapping it in begin/commit costs
      // two extra round trips on the hottest path in the server — one per request, before the
      // request has done anything. `spend()` treats a throw here as "allow", so the caller is
      // never blocked by the limiter's own store (ratelimit.ts, fail open).
      const result = await run((c) => c.query(statement.text, statement.params));
      const row = (result.rows[0] ?? {}) as { count?: unknown };
      return Number(row.count ?? 0);
    },
  };
}

// ── the spend counters (spend.ts) — the SAME table, deliberately ────────────────────────
//
//  The spend plane's durable counters ride `dsx_rate_counter`, not a table of their own. The
//  shape is identical (bucket · epoch-aligned window · atomic add), the sweep already prunes
//  expired windows on the emitted cron row, and — decisively — every provisioned deployment
//  already HAS this table, so the plane is durable on day one with no migration to apply and no
//  `not_provisioned` state to explain. Spend buckets are namespaced `spend|<of>`, which the
//  rate plane's `<route.key>|<caller>` grammar can never produce.

/** Multi-row atomic add: one statement, N budgets, Postgres decides every count under
 *  concurrency. Entries are one-per-budget by construction, so the upsert can never touch the
 *  same row twice in one statement. */
export function buildSpendAddStatement(
  entries: readonly { bucket: string; windowStartMs: number; windowMs: number; n: number }[],
): Statement {
  const params: unknown[] = [];
  const p = (value: unknown): string => `$${params.push(value)}`;
  const values = entries.map((e) => {
    // The same three-window grace the rate hit uses, so the shared sweep prunes both planes.
    const expires = new Date(e.windowStartMs + e.windowMs * 3).toISOString();
    return `(${p(e.bucket)}, ${p(new Date(e.windowStartMs).toISOString())}::timestamptz, ${p(expires)}::timestamptz, ${p(Math.max(1, Math.trunc(e.n)))}::int)`;
  });
  return {
    text:
      `insert into ${RATE_TABLE} (bucket, window_start, expires_at, count) values ${values.join(", ")} ` +
      `on conflict (bucket, window_start) do update set count = ${RATE_TABLE}.count + excluded.count returning bucket, count`,
    params,
  };
}

/** Read counts without adding — the reconcile half of the flush (spend.ts). Absent rows simply
 *  return no row; the caller treats that as 0. */
export function buildSpendReadStatement(entries: readonly { bucket: string; windowStartMs: number }[]): Statement {
  const params: unknown[] = [];
  const p = (value: unknown): string => `$${params.push(value)}`;
  const pairs = entries.map((e) => `(${p(e.bucket)}, ${p(new Date(e.windowStartMs).toISOString())}::timestamptz)`);
  return {
    text: `select bucket, count from ${RATE_TABLE} where (bucket, window_start) in (${pairs.join(", ")})`,
    params,
  };
}

function decodeSpendRows(rows: readonly unknown[]): { bucket: string; count: number }[] {
  return rows.map((row) => {
    const r = (row ?? {}) as { bucket?: unknown; count?: unknown };
    return { bucket: String(r.bucket ?? ""), count: Number(r.count ?? 0) };
  });
}

function spendStore(run: SqlRunner): SpendStore {
  return {
    add: async (entries): Promise<{ bucket: string; count: number }[]> => {
      if (entries.length === 0) return [];
      const statement = buildSpendAddStatement(entries);
      // NO TRANSACTION, same as the rate hit: one upsert is already atomic, and the flush treats
      // a throw as "keep the local units, try again next interval" (spend.ts, bounded staleness).
      const result = await run((c) => c.query(statement.text, statement.params));
      return decodeSpendRows(result.rows);
    },
    read: async (entries): Promise<{ bucket: string; count: number }[]> => {
      if (entries.length === 0) return [];
      const statement = buildSpendReadStatement(entries);
      const result = await run((c) => c.query(statement.text, statement.params));
      return decodeSpendRows(result.rows);
    },
  };
}

// ── the durable event feed (realtime.ts) ────────────────────────────────────────────────

const EVENT_TABLE = `${TABLE_PREFIX}event`;

/**
 * The append-only feed. `seq` is an identity column and is the cursor a subscriber resumes from.
 *
 * `owner_id` is NULLABLE and that nullability IS the authorization model: a row with an owner
 * reaches that subject only, a row without one reaches every authenticated subscriber. The read
 * predicate below is the only place that is decided.
 *
 * Service-only at the ACL, exactly like the queue: subscribers never reach this table directly,
 * they reach it through the SSE route, which runs service-scoped and filters by the VERIFIED
 * subject. Exposing it to `authenticated` would let PostgREST serve the whole feed with the
 * platform's own row filter instead of ours.
 */
export function eventTableSql(): string {
  const t = EVENT_TABLE;
  return [
    `create table if not exists ${t} (`,
    "  seq bigint generated by default as identity primary key,",
    "  channel text not null,",
    "  owner_id uuid,",
    "  payload jsonb not null default '{}'::jsonb,",
    "  created_at timestamptz not null default now()",
    ");",
    // The subscriber's exact access path: one channel, everything after a cursor, in order.
    `create index if not exists ${t}_channel_seq_idx on ${t} (channel, seq);`,
    // Retention: the feed is append-only, so something must remove what no cursor can still want.
    `create index if not exists ${t}_created_idx on ${t} (created_at);`,
    `alter table ${t} enable row level security;`,
    `revoke all on ${t} from anon, authenticated;`,
    `grant select, insert, delete on ${t} to service_role;`,
    `drop policy if exists ${t}_service on ${t};`,
    `create policy ${t}_service on ${t} for all to service_role using (true) with check (true);`,
    "",
  ].join("\n");
}

export function buildEventPublishStatement(channel: string, ownerId: string | null, payload: Record<string, unknown>): Statement {
  if (ownerId !== null && !UUID.test(ownerId)) {
    throw new RealtimeError(`"${ownerId}" is not a subject id`, "bad_request");
  }
  return {
    text: `insert into ${EVENT_TABLE} (channel, owner_id, payload) values ($1, $2::uuid, $3::jsonb) returning seq`,
    params: [assertChannel(channel), ownerId, JSON.stringify(payload ?? {})],
  };
}

/**
 * THE SUBSCRIBER'S READ, and the one predicate that decides who sees what.
 *
 * `(owner_id is null or owner_id = $subject)` — a public row, or one addressed to this exact
 * verified subject. The subject is a PARAMETER, never interpolated, and it comes from the token
 * the identity boundary verified rather than from anything the subscriber sent. A subscriber can
 * choose their channel and their cursor and nothing else, which is why those two are the only
 * caller-controlled values here.
 *
 * A non-uuid subject cannot match a uuid column, so it is refused before the round trip rather
 * than silently returning an empty feed forever — a subscription that is quiet because the
 * subject was malformed looks exactly like one that is quiet because nothing happened.
 */
export function buildEventReadStatement(request: RealtimeReadRequest): Statement {
  if (!UUID.test(request.subject)) {
    throw new RealtimeError("the subscriber's subject is not a uuid", "bad_request");
  }
  if (!/^\d{1,19}$/.test(request.afterSeq)) {
    throw new RealtimeError("the cursor is not a sequence number", "bad_request");
  }
  return {
    text:
      `select seq, channel, owner_id, payload, created_at from ${EVENT_TABLE} ` +
      `where channel = $1 and seq > $2::bigint and (owner_id is null or owner_id = $3::uuid) ` +
      `order by seq limit $4::int`,
    params: [assertChannel(request.channel), request.afterSeq, request.subject, Math.max(1, Math.trunc(request.limit))],
  };
}

/** Drop events older than the retention window. The cron row calls this; a subscriber that has
 *  been away longer than the window resumes from the oldest surviving event rather than silently
 *  receiving nothing. */
export function buildEventSweepStatement(retentionHours: number): Statement {
  return {
    text: `delete from ${EVENT_TABLE} where created_at < now() - make_interval(hours => $1::int) returning seq`,
    params: [Math.max(1, Math.trunc(retentionHours))],
  };
}

function decodeEventRow(row: unknown): RealtimeEvent {
  const r = (row ?? {}) as Record<string, unknown>;
  const raw = r["payload"];
  let payload: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
  } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    payload = raw as Record<string, unknown>;
  }
  const created = r["created_at"];
  const owner = r["owner_id"];
  return {
    // `bigint` arrives as a STRING from `pg` (it does not fit a JS number safely) and as a number
    // from some others. String either way: the cursor is an opaque token, never arithmetic.
    seq: String(r["seq"] ?? "0"),
    channel: String(r["channel"] ?? ""),
    ownerId: owner === null || owner === undefined ? null : String(owner),
    payload,
    createdAt: created instanceof Date ? created.toISOString() : created === null || created === undefined ? null : String(created),
  };
}

function realtimeTransport(run: SqlRunner): RealtimeTransport {
  const asFailure = (e: unknown): unknown =>
    (e as { code?: unknown } | null)?.code === UNDEFINED_TABLE
      ? new RealtimeError(
          `the event feed table is missing — apply eventTableSql() (the emitted migration creates it)`,
          "not_provisioned",
          { cause: e },
        )
      : e;
  return {
    publish: async (event): Promise<string> => {
      const statement = buildEventPublishStatement(event.channel, event.ownerId, event.payload);
      try {
        const result = await run((c) => c.query(statement.text, statement.params));
        return String((result.rows[0] as { seq?: unknown } | undefined)?.seq ?? "0");
      } catch (e) {
        throw asFailure(e);
      }
    },
    read: async (request): Promise<RealtimeEvent[]> => {
      const statement = buildEventReadStatement(request);
      try {
        const result = await run((c) => c.query(statement.text, statement.params));
        return result.rows.map(decodeEventRow);
      } catch (e) {
        throw asFailure(e);
      }
    },
  };
}

/** Set by `install`, so the sweep runs on the SAME connection plane every other op uses rather
 *  than opening a second, differently-configured one. */
let rateSweeper: (() => Promise<number>) | null = null;

let eventSweeper: ((retentionHours: number) => Promise<number>) | null = null;

/** Prune expired rate-limit windows. Called by the emitted cron row; returns rows removed. */
export async function sweepRateCounters(): Promise<number> {
  if (rateSweeper === null) return 0;
  return rateSweeper();
}

/** Prune events past the retention window. Called by the emitted cron row; returns rows removed. */
export async function sweepEvents(retentionHours: number): Promise<number> {
  if (eventSweeper === null) return 0;
  return eventSweeper(retentionHours);
}

function install(run: SqlRunner): void {
  RepoSeam.transport = async (query: RepoQuery): Promise<unknown> => {
    // buildStatement first, OUTSIDE the connection: a malformed query must not consume a
    // connection (or open a transaction) only to be rejected on the identifier check.
    const statement = buildStatement(query);
    const rows = await run((c) => runAs(c, query, statement));
    return query.op === "list" ? rows : (rows[0] ?? null);
  };
  QueueSeam.transport = queueTransport(run);
  RateLimitSeam.store = rateLimitStore(run);
  SpendSeam.store = spendStore(run);
  RealtimeSeam.transport = realtimeTransport(run);
  eventSweeper = async (retentionHours: number): Promise<number> => {
    const statement = buildEventSweepStatement(retentionHours);
    const result = await run((c) => c.query(statement.text, statement.params));
    return result.rows.length;
  };
  rateSweeper = async (): Promise<number> => {
    const statement = buildRateSweepStatement();
    const result = await run((c) => c.query(statement.text, statement.params));
    return result.rows.length;
  };
}

/**
 * Install a transport over a POOL — a driver that hands out dedicated connections via
 * `connect()`. This is what a server uses: `pg.Pool`, or a Supabase pooler connection.
 *
 * Each transaction holds one checked-out connection for its whole life, so the identity
 * preamble and the statement it authorises can never land on different connections.
 */
export function installPostgresPool(pool: SqlPool, options: PostgresPoolGuardOptions = {}): void {
  install(pooledExecutor(pool, options));
}

/**
 * Install a transport over a SINGLE dedicated connection — PGlite, or one `pg.Client` you
 * connected yourself. Transactions are SERIALISED, because two concurrent transactions on one
 * connection nest, and the second caller's statement would then execute under the first
 * caller's identity — the same cross-tenant leak by a different route.
 *
 * Prefer `installPostgresPool` in a server. This exists for tests, single-tenant tools, and
 * embedded engines that genuinely have one connection.
 */
export function installPostgresClient(client: SqlClient): void {
  install(serialiser(client));
}

//
//  ── THE RESERVED NAMESPACE: what Despia owns inside the customer's database ──────────────
//
//  The customer owns the database. Despia owns the `dsx_` system tables inside it, the way any
//  framework owns its own migration table — so nobody is ever asked to write this SQL, and
//  nobody has to know it exists. This registry is the ONE place that says what "provisioned"
//  means; the emitted migration, the deploy's provisioning step, and the damage report all read
//  it, so a table cannot be created by one and forgotten by another.
//
//  It exists because those three had already drifted: the monorepo emitter wrote the counter and
//  event tables, the standalone `despia build` migration wrote neither, and a deployment that
//  believed it was metered had nowhere to count. The registry is what makes that class
//  structurally impossible rather than caught by review.
//
//  A queue table is here too, per declared queue: the same law, just parameterised by the
//  document. Entity tables are NOT — those are the customer's own, declared in their document
//  and theirs to name.
//

/** One framework-owned table: what it is for, the SQL that converges it, and the columns whose
 *  absence means the runtime would fail against it (present-but-wrong is damage, not health). */
export interface SystemTable {
  table: string;
  /** one sentence, written for a person reading a repair prompt — not a schema comment */
  purpose: string;
  /** convergent DDL: create-if-not-exists plus additive alters, safe on a live database */
  sql: string;
  columns: string[];
}

/**
 * Every `dsx_` table this runtime requires, for a deployment draining `queues`.
 *
 * Ordered so a reader sees the always-present pair first. The column lists name what the
 * runtime's own statements address — they are the shape check, and they are deliberately not
 * the whole schema: an extra column somebody added is their business, a missing one is ours.
 */
export function systemTables(queues: readonly string[] = []): SystemTable[] {
  const rows: SystemTable[] = [
    {
      table: RATE_TABLE,
      purpose: "rate limits and spend ceilings — the durable counters every window is measured against",
      sql: rateLimitTableSql(),
      columns: ["bucket", "window_start", "expires_at", "count"],
    },
    {
      table: EVENT_TABLE,
      purpose: "the event feed — what the app and the dashboard subscribe to, spend alerts included",
      sql: eventTableSql(),
      columns: ["seq", "channel", "owner_id", "payload", "created_at"],
    },
  ];
  for (const queue of [...new Set(queues)].sort()) {
    rows.push({
      table: queueTable(queue),
      purpose: `the "${queue}" queue — messages waiting to be drained, and their delivery state`,
      sql: queueTableSql(queue),
      columns: ["id", "idempotency_key", "payload", "created_at", "claimed_at", "attempts"],
    });
  }
  return rows;
}

/** The whole reserved namespace as one convergent script — what the emitted migration carries.
 *  Re-runnable by construction. */
export function systemSchemaSql(queues: readonly string[] = []): string {
  return systemTables(queues).map((t) => t.sql.trimEnd()).join("\n\n") + "\n";
}

/**
 * One DDL script as its individual statements.
 *
 * `provisionSystemStorage` applies them ONE AT A TIME rather than sending the script whole,
 * because multi-statement text is a simple-protocol privilege: `pg` allows it, a parameterised
 * driver or an embedded engine does not, and a provisioning step that works only against one
 * driver is a provisioning step that fails on somebody's database at deploy time. Applying them
 * singly also means a refusal names the statement that was refused.
 *
 * The split accumulates lines until one ends the statement, which is exactly the shape these
 * scripts have. It is deliberately not a SQL parser: it is only ever handed the three DDL
 * builders above, none of which carries a dollar-quoted body or a literal semicolon — the
 * assertion below is what keeps that true if one ever grows one.
 */
export function ddlStatements(script: string): string[] {
  if (script.includes("$$")) {
    throw new Error("[dsx.provision] a system DDL script grew a dollar-quoted body — split it explicitly");
  }
  const out: string[] = [];
  let current: string[] = [];
  for (const line of script.split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("--")) continue;
    current.push(line);
    if (text.endsWith(";")) {
      out.push(current.join("\n").trim());
      current = [];
    }
  }
  if (current.length > 0) out.push(current.join("\n").trim());
  return out;
}

/** One table's health. `ok` is the only field a caller must act on; the rest is the report. */
export interface SystemTableStatus {
  table: string;
  purpose: string;
  present: boolean;
  /** columns the runtime addresses that this table does not have (empty when absent entirely) */
  missingColumns: string[];
  ok: boolean;
}

/**
 * Read the live database and answer what is actually there.
 *
 * One query for the whole namespace rather than one per table: a deploy runs this against a
 * customer's database over the open internet, and a round trip per table is the difference
 * between a check nobody notices and one they learn to skip.
 *
 * `information_schema` rather than a probe query per table, because a select against a missing
 * table aborts the surrounding transaction in Postgres — the diagnosis would break the thing it
 * is diagnosing.
 */
export async function inspectSystemStorage(
  client: SqlClient,
  queues: readonly string[] = [],
): Promise<SystemTableStatus[]> {
  const wanted = systemTables(queues);
  const names = wanted.map((t) => t.table);
  const { rows } = await client.query(
    "select table_name, column_name from information_schema.columns " +
      "where table_schema = current_schema() and table_name = any($1::text[])",
    [names],
  );
  const found = new Map<string, Set<string>>();
  for (const raw of rows as { table_name?: unknown; column_name?: unknown }[]) {
    const table = String(raw.table_name ?? "");
    const column = String(raw.column_name ?? "");
    if (table === "") continue;
    const set = found.get(table) ?? new Set<string>();
    set.add(column);
    found.set(table, set);
  }
  return wanted.map((spec) => {
    const columns = found.get(spec.table);
    const present = columns !== undefined;
    const missingColumns = present ? spec.columns.filter((c) => !columns.has(c)) : [];
    return {
      table: spec.table,
      purpose: spec.purpose,
      present,
      missingColumns,
      ok: present && missingColumns.length === 0,
    };
  });
}

/** What one provisioning run did. `created` is what a receipt records and what a person is told
 *  was fixed; `damaged` is what the run deliberately refused to touch. */
export interface ProvisionOutcome {
  /** every system table this deployment requires, after the run */
  tables: SystemTableStatus[];
  /** tables that were absent going in and exist because of this run */
  created: string[];
  /**
   * Tables that are present and cannot serve the runtime — someone altered one of ours.
   *
   * NOT repaired automatically, and that is the honest answer rather than a missing feature. A
   * generic `add column` restores a column but never the constraint it carried, so a dropped
   * primary-key column would come back as an ordinary nullable one: the table would then pass
   * every check here and still break the upsert it exists for. Naming it and refusing to publish
   * beats a repair that reports success and leaves the deployment broken.
   */
  damaged: string[];
  /** false when the database still does not match after applying — never silently tolerated */
  verified: boolean;
}

/**
 * Inspect, apply what is missing, then inspect again and answer both.
 *
 * The apply is unconditional over the whole namespace rather than only the damaged rows: the DDL
 * is convergent (`create table if not exists`, `add column if not exists`), so applying all of it
 * costs one round trip and cannot leave a partially-repaired table behind. That is also what
 * makes repair and first-provision the same operation with the same code path — there is no
 * "repair mode" to get wrong.
 *
 * The verify is a SECOND read, not the assumption that the apply worked. A grant this connection
 * does not have, a schema it cannot write, an extension it lacks: each fails here, named, instead
 * of surfacing later as a runtime error against a table nobody checked.
 */
export async function provisionSystemStorage(
  client: SqlClient,
  queues: readonly string[] = [],
): Promise<ProvisionOutcome> {
  const before = await inspectSystemStorage(client, queues);
  const state = new Map(before.map((t) => [t.table, t]));
  const created = before.filter((t) => !t.present).map((t) => t.table);
  const damaged = before.filter((t) => t.present && !t.ok).map((t) => t.table);

  for (const spec of systemTables(queues)) {
    //  A damaged table's DDL is SKIPPED rather than attempted. Its create-if-not-exists no-ops
    //  against the table that is already there, so the statements that would actually run are
    //  the indexes and policies over columns it no longer has — each of which fails, turning a
    //  precise report into a stack trace about the third one.
    if (state.get(spec.table)?.present === true && state.get(spec.table)?.ok !== true) continue;
    for (const statement of ddlStatements(spec.sql)) {
      await client.query(statement);
    }
  }

  const tables = await inspectSystemStorage(client, queues);
  return { tables, created, damaged, verified: tables.every((t) => t.ok) };
}
