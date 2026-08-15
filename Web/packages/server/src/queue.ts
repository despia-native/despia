//
//  queue.ts — the DECLARED queue-claim plane (full-stack.md T4; NEXT.md "queue semantics for
//  drainWebhooks — a declared queue op (claim + mark processed), NOT a widening of the CRUD
//  grammar").
//
//  WHY THIS IS ITS OWN PLANE, and not four more `RepoQuery.op` spellings:
//
//  The repository grammar is NARROW, FOREVER (full-stack.md decision 1) — five row operations a
//  Postgres and a Firestore can both mean the same thing by. A queue is not row access; it is a
//  LEASE PROTOCOL. "Give me up to N messages nobody else is working on, and hold them for me
//  until I say otherwise" has no CRUD spelling: `list` cannot mutate, `update` cannot select
//  under contention, and any op that tried would drag SKIP-LOCKED semantics into an interface
//  two stores must agree on. Widening the repository to carry it is exactly the Postgres-ism
//  leak the two-implementation freeze rule exists to catch. So the queue is a SECOND seam with
//  its own closed vocabulary, and a provider fills whichever seams it can honestly fill.
//
//  THE PROTOCOL — claim · process · ack/release, with a visibility timeout:
//
//    claim(queue, limit, visibilityMs, maxAttempts)
//        → up to `limit` messages that are unprocessed, not currently leased, and not parked.
//          Claiming STAMPS a lease and increments the delivery count, atomically, so two drains
//          running at the same instant cannot both take one message.
//    <the caller processes each message>
//    settle(queue, ack[], release[])
//        → `ack` marks a message processed (it stays in the table: its idempotency key is the
//          UNIQUE constraint that stops the same event being enqueued twice, and deleting the
//          row would throw that history away). `release` returns it to the queue immediately.
//
//  WHAT HAPPENS WHEN A DRAIN DIES MID-FLIGHT — the reason a lease has a timeout at all: nothing
//  is acked, so nothing is lost. The lease expires after `visibilityMs` and the message is
//  claimable again. Delivery is therefore AT LEAST ONCE, which is the only honest guarantee a
//  queue can make across a crash, and it is why idempotency is declared on the ROW (the queue
//  table's `idempotency_key text not null unique`) rather than assumed by handler code.
//
//  POISON MESSAGES — and why "parked" was not enough. Each claim increments `attempts`, and a
//  claim skips anything at or past `maxAttempts`. That alone leaves the row unprocessed and
//  unclaimable: still in the table, no longer burning the drain, and INDISTINGUISHABLE at a
//  glance from a message that is merely waiting. A queue whose failures are invisible is a queue
//  that reports healthy while losing work, so parking is now a TERMINAL, NAMED state instead of
//  an implicit one:
//
//    deadLetter(queue, [{id, reason}])   the drain moves a message here when its handler fails
//                                        on the attempt that reaches `maxAttempts`. The row keeps
//                                        its payload and its idempotency key, and gains the
//                                        REASON its last attempt gave.
//    listDeadLetters(queue, limit)       what is stuck, and why. The answer an operator needs.
//    replayDeadLetters(queue, ids)       after the bug is fixed: attempts back to 0, dead-letter
//                                        state cleared, the message claimable again.
//
//  The dead letter stays in the SAME table rather than a second one. Moving it would break the
//  one guarantee the queue makes about it — `idempotency_key` is UNIQUE, and a row that leaves
//  the table stops refusing a duplicate enqueue of the event it represents.
//
//  SCOPE — THE SECURITY POSTURE, STATED SO IT IS NOT REDISCOVERED:
//
//  This plane has exactly ONE face, and it is the SERVICE face. There is deliberately no
//  user-scoped queue handle, no `scope` field, and no identity anywhere in this file: a queue
//  drain is the server working on its own behalf, so there is no user whose authority it could
//  run with. What keeps that safe is machinery that ALREADY EXISTS and is not restated here —
//  `prepare_server.rb` assigns `reach: []` to every `worker` row, and `host.ts` answers any
//  non-service caller of a `reach: []` route with the byte-identical 404 an absent route
//  returns. This file adds no enforcement of its own and must never grow any: a second opinion
//  about who may drain a queue is a second place for that answer to be wrong.
//

/** One claimed message. The payload is the enqueuer's, verbatim; everything else is the queue's. */
export interface QueueMessage {
  /** the queue row id — the handle `ack`/`release` name */
  id: string;
  /** the declared idempotency key (the row's UNIQUE column), so a handler can log what it saw */
  key: string;
  /** the enqueued body, exactly as stored */
  payload: Record<string, unknown>;
  /** when it was enqueued (RFC 3339), or null if the store did not record one */
  enqueuedAt: string | null;
  /** which delivery this is — 1 on the first, 2 after a lease expired or a release, and so on */
  attempt: number;
}

/**
 * PUT ONE MESSAGE ON THE QUEUE.
 *
 * This half of the protocol was missing for the plane's whole life, and its absence was not
 * visible from here: `drainQueue` worked, the drain route answered, the live tests passed —
 * because every one of them enqueued with hand-written SQL. Nothing SHIPPED could enqueue, so
 * the only queue a deployment could ever drain was an empty one. An inbound webhook has nowhere
 * to put what it received without this.
 *
 * `key` is the declared idempotency key and it is the whole duplicate story: the queue table's
 * `idempotency_key` is UNIQUE, so a second enqueue of the same event is refused BY THE ROW,
 * under concurrency, rather than by a read-then-write this code could lose a race on. That is
 * reported as `duplicate: true` and is a SUCCESS — a webhook sender retrying a delivery it
 * already made must get the same answer it got the first time, not a 500.
 */
export interface QueueEnqueueRequest {
  queue: string;
  /** the idempotency key — the row's UNIQUE column; a repeat is accepted and reported, never stored twice */
  key: string;
  /** the message body, stored verbatim */
  payload: Record<string, unknown>;
}

export interface QueueEnqueueResult {
  /** the new row's id, or null when the key was already present */
  id: string | null;
  /** true when this exact key was already on the queue — accepted, not stored again */
  duplicate: boolean;
}

/** A message that exhausted its attempts, with the reason its last one gave. */
export interface QueueDeadLetter extends QueueMessage {
  /** the failure reported by the attempt that exhausted `maxAttempts` */
  reason: string;
  /** when it was moved to the dead-letter state (RFC 3339) */
  deadLetteredAt: string | null;
}

export interface QueueDeadLetterRequest {
  queue: string;
  entries: readonly { id: string; reason: string }[];
}

export interface QueueClaimRequest {
  queue: string;
  /** how many messages to take — bounded by QUEUE_CLAIM_LIMIT */
  limit: number;
  /** how long the claim holds them before they become claimable again */
  visibilityMs: number;
  /** a message at or past this many deliveries is PARKED and no longer claimed */
  maxAttempts: number;
}

export interface QueueSettleRequest {
  queue: string;
  /** ids that completed — marked processed, kept for their idempotency key */
  ack: readonly string[];
  /** ids to return to the queue right now, without waiting for the lease to expire */
  release: readonly string[];
}

/**
 * The provider seam. Two methods, both request-scoped, neither carrying an identity — a provider
 * fills this only if it can implement the lease honestly (an atomic claim that two concurrent
 * drains cannot both win). A store that cannot must leave it EMPTY rather than approximate it:
 * a queue that silently delivers the same message to two workers is worse than one that refuses.
 */
export interface QueueTransport {
  enqueue(request: QueueEnqueueRequest): Promise<QueueEnqueueResult>;
  claim(request: QueueClaimRequest): Promise<QueueMessage[]>;
  settle(request: QueueSettleRequest): Promise<{ acked: number; released: number }>;
  /** move exhausted messages to the terminal dead-letter state, with their last reason */
  deadLetter(request: QueueDeadLetterRequest): Promise<number>;
  /** what is stuck and why — the operator's view, newest first */
  listDeadLetters(request: { queue: string; limit: number }): Promise<QueueDeadLetter[]>;
  /** clear the dead-letter state and reset attempts, making the messages claimable again */
  replayDeadLetters(request: { queue: string; ids: readonly string[] }): Promise<number>;
}

/**
 * EMPTY by default, exactly like `RepoSeam` and the kernel's other seams. An unfilled seam fails
 * CLOSED with a message naming the fix — it never degrades into "drained nothing", which is what
 * a drain reports when it is working perfectly and is therefore the one answer a broken queue
 * must not be able to give.
 */
export const QueueSeam = { transport: null as QueueTransport | null };

/** Hard ceiling on one claim. A drain is request-scoped (full-stack.md T4: no workflow engine). */
export const QUEUE_CLAIM_LIMIT = 100;
/** Default lease. Long enough for real work, short enough that a crashed drain recovers quickly. */
export const DEFAULT_VISIBILITY_MS = 30_000;
/** Default deliveries before a message parks. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * The closed vocabulary of queue failures. Deliberately NOT `RepoErrorCode`: the two planes fail
 * for different reasons and a caller acts differently on each. `not_provisioned` in particular
 * has no repository twin — it means the store is reachable and the queue's own table is not
 * there or is missing the lease columns, which is a deployment step, not a bug and not an outage.
 */
export type QueueErrorCode = "no_provider" | "bad_request" | "not_provisioned" | "saturated";

export class QueueError extends Error {
  // a plain field, not a constructor parameter property: the workspace compiles under
  // `erasableSyntaxOnly` (types must vanish without emit), which forbids that shorthand
  readonly code: QueueErrorCode;
  constructor(message: string, code: QueueErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QueueError";
    this.code = code;
  }
}

/**
 * Queue names are identifiers, validated against the same snake_case grammar
 * `prepare_server.rb` enforces on the `worker` declaration. Checked here as well as at the
 * point of SQL concatenation, because a name that fails this check names no queue at all and
 * saying so before a round trip is a better failure than saying so after one.
 */
const QUEUE_NAME = /^[a-z][a-z0-9_]*$/;

export function assertQueueName(queue: string): string {
  if (!QUEUE_NAME.test(queue)) {
    throw new QueueError(`"${queue}" is not a legal queue name (snake_case, as declared by the worker row)`, "bad_request");
  }
  return queue;
}

/** The one place the unfilled seam is reported, so every op fails closed with the same fix. */
function requireTransport(): QueueTransport {
  const transport = QueueSeam.transport;
  if (transport === null) {
    throw new QueueError(
      `no queue provider is installed — enable a data provider whose residence fills the queue seam ` +
        `(Core/Server/Providers/Postgres does) and configure its connection`,
      "no_provider",
    );
  }
  return transport;
}

/** Longest idempotency key the plane accepts. The column is unbounded `text`; this is what
 *  stops a caller making the UNIQUE index carry a megabyte per row. */
const MAX_KEY_BYTES = 512;

/**
 * ENQUEUE ONE MESSAGE. A duplicate key is a SUCCESS reporting `duplicate: true` — see
 * QueueEnqueueRequest for why that is the only honest answer to a sender's retry.
 */
export async function enqueueMessage(
  queue: string,
  key: string,
  payload: Record<string, unknown>,
): Promise<QueueEnqueueResult> {
  assertQueueName(queue);
  if (typeof key !== "string" || key === "") {
    throw new QueueError("an enqueued message needs a non-empty idempotency key", "bad_request");
  }
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) {
    throw new QueueError(`the idempotency key exceeds ${MAX_KEY_BYTES} bytes`, "bad_request");
  }
  return requireTransport().enqueue({ queue, key, payload });
}

/** Hard ceiling on one dead-letter listing — the same reasoning as QUEUE_CLAIM_LIMIT. */
export const QUEUE_DEAD_LETTER_LIMIT = 100;

/** What is stuck on this queue, and why. Newest first. */
export async function listDeadLetters(queue: string, limit?: number): Promise<QueueDeadLetter[]> {
  assertQueueName(queue);
  return requireTransport().listDeadLetters({ queue, limit: bounded(limit, QUEUE_DEAD_LETTER_LIMIT) });
}

/**
 * Put dead letters back on the queue: attempts reset to 0, dead-letter state cleared, claimable
 * on the next drain. The deliberate shape is that this takes EXPLICIT IDS rather than a
 * "replay everything" switch — a queue full of poison replayed wholesale re-runs the same
 * failure against production at full rate, which is how a fixed bug becomes an outage.
 */
export async function replayDeadLetters(queue: string, ids: readonly string[]): Promise<number> {
  assertQueueName(queue);
  if (ids.length === 0) return 0;
  return requireTransport().replayDeadLetters({ queue, ids });
}

export interface QueueDrainOptions {
  /** how many messages this pass may take (default QUEUE_CLAIM_LIMIT, always bounded by it) */
  limit?: number;
  /** the lease (default DEFAULT_VISIBILITY_MS) */
  visibilityMs?: number;
  /** deliveries before a message parks (default DEFAULT_MAX_ATTEMPTS) */
  maxAttempts?: number;
}

/** What one drain pass did. `drained` is the number of messages that actually completed. */
export interface QueueDrainResult {
  queue: string;
  /** how many the claim returned */
  claimed: number;
  /** how many were acked — THE number a drain route reports */
  drained: number;
  /** how many were handed back for another attempt */
  released: number;
  /** how many exhausted their attempts on this pass and moved to the dead-letter state */
  deadLettered: number;
  /** one entry per message whose handler threw, with the reason, for the server log */
  failures: { key: string; reason: string }[];
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function bounded(want: number | undefined, ceiling: number): number {
  return Math.max(1, Math.min(ceiling, Number.isFinite(want) ? Number(want) : ceiling));
}

/**
 * ONE DRAIN PASS: claim, process each message, settle.
 *
 * This is the whole of what a `worker` route's handler has to write — the declared shape the
 * narrow CRUD grammar deliberately lacks, so a drain route can report what it really dequeued
 * instead of the honest floor of 0:
 *
 * ```ts
 * const result = await drainQueue("webhooks", async (message) => {
 *   await handleOne(message.payload);     // throw and the message is released for a retry
 * });
 * return { ok: true, queue: "webhooks", drained: result.drained, by: ctx.identity?.sub ?? null };
 * ```
 *
 * PER-MESSAGE ISOLATION IS THE POINT. One bad message must not cost the other nine: each handler
 * call is caught on its own, the survivors are acked, and only the failures go back. A drain that
 * aborted the whole pass on the first throw would make one poison message stall the queue forever
 * — which is the classic way a queue stops draining while every component reports healthy.
 *
 * The handler receives ONLY the message. It gets no repository, no identity and no request: if a
 * worker needs data access it names `serviceRepo()` itself, deliberately and visibly, exactly as
 * any other internal job does.
 */
export async function drainQueue(
  queue: string,
  handle: (message: QueueMessage) => Promise<void> | void,
  options?: QueueDrainOptions,
): Promise<QueueDrainResult> {
  assertQueueName(queue);
  const transport = requireTransport();

  const request: QueueClaimRequest = {
    queue,
    limit: bounded(options?.limit, QUEUE_CLAIM_LIMIT),
    visibilityMs: Math.max(0, Number.isFinite(options?.visibilityMs) ? Number(options?.visibilityMs) : DEFAULT_VISIBILITY_MS),
    maxAttempts: Math.max(1, Number.isFinite(options?.maxAttempts) ? Number(options?.maxAttempts) : DEFAULT_MAX_ATTEMPTS),
  };

  const messages = await transport.claim(request);
  if (messages.length === 0) {
    // Nothing to settle, and no round trip to spend saying so — the common case on a quiet queue
    // that a cron drains every minute.
    return { queue, claimed: 0, drained: 0, released: 0, deadLettered: 0, failures: [] };
  }

  const ack: string[] = [];
  const release: string[] = [];
  const exhausted: { id: string; reason: string }[] = [];
  const failures: { key: string; reason: string }[] = [];
  for (const message of messages) {
    try {
      await handle(message);
      ack.push(message.id);
    } catch (e) {
      const reason = reasonOf(e);
      failures.push({ key: message.key, reason });
      // `attempt` is the delivery this claim STAMPED, so `attempt >= maxAttempts` means this was
      // the last one the claim predicate would ever hand out. Releasing it here would leave a row
      // the next claim silently skips forever; dead-lettering it records the reason while the
      // reason is still in hand. One attempt earlier and a transient outage buries a good message;
      // one later never happens, because there is no later claim.
      if (message.attempt >= request.maxAttempts) exhausted.push({ id: message.id, reason });
      else release.push(message.id);
    }
  }

  // If THIS throws, nothing has been acked, so nothing has been lost: every claimed message stays
  // leased and becomes claimable again when the lease expires. That is the at-least-once contract
  // doing its job, and it is why the settle is one statement per outcome rather than one per row.
  const settled = await transport.settle({ queue, ack, release });
  // Dead-lettering runs AFTER the settle, and its failure is not allowed to lose the settle's
  // work: a message left un-dead-lettered is merely parked, which is where it stood before this
  // existed, whereas a throw here would discard the acks of every message that succeeded.
  let deadLettered = 0;
  if (exhausted.length > 0) {
    try {
      deadLettered = await transport.deadLetter({ queue, entries: exhausted });
    } catch (e) {
      failures.push({ key: "", reason: `dead-letter failed: ${reasonOf(e)}` });
    }
  }
  return { queue, claimed: messages.length, drained: settled.acked, released: settled.released, deadLettered, failures };
}
