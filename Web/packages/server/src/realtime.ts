//
//  realtime.ts — AUTHENTICATED SUBSCRIPTIONS: a client asks to be told when something changes,
//  and is told, without polling the API itself.
//
//  THE OBVIOUS DESIGN DOES NOT WORK ON THE TARGET, so it is worth saying why before saying what.
//
//  A WebSocket fed by Postgres `LISTEN/NOTIFY` is the textbook answer and it is unimplementable
//  on the deployment this framework ships to, for two independent reasons:
//
//    · `LISTEN` needs a session that outlives the transaction, and the connection string a
//      serverless target must use is a TRANSACTION-MODE pooler. A `LISTEN` issued through it is
//      either refused or silently bound to a connection the pooler hands to somebody else next.
//    · An edge isolate is created per traffic pattern and destroyed when the platform decides.
//      A subscription that lives in one is not a subscription, it is a coin flip.
//
//  And `NOTIFY` has a property that disqualifies it here regardless of transport: it is FIRE AND
//  FORGET. A listener that is not connected at the instant of the notify never learns it happened
//  — no queue, no replay, no cursor. Every mobile client is disconnected constantly (backgrounded,
//  tunnel, lift, handover), so "delivered only to whoever was listening" means "silently loses
//  events for exactly the clients this exists to serve", and the loss is invisible to both ends.
//
//  WHAT THIS DOES INSTEAD — a DURABLE CURSOR FEED over Server-Sent Events.
//
//  Publishing appends a row to `dsx_event` with a monotonic `seq`. A subscriber opens an SSE
//  stream and is sent every row after its cursor, then every row that appears afterwards, each
//  carrying its `seq` as the SSE event id. On reconnect the browser resends the last id it saw as
//  `Last-Event-ID` — automatically, as part of the EventSource spec — and the feed resumes from
//  exactly there. Nothing is lost across a disconnect, which is the property NOTIFY cannot have
//  and the reason this is a table rather than a channel.
//
//  SSE, NOT WEBSOCKET. The traffic is one-directional (the client already has an API for
//  upstream), SSE is plain HTTP so it inherits the identity boundary, the proxies and the
//  infrastructure that already exist, and reconnect-with-cursor is in the protocol rather than in
//  every client. A WebSocket would need its own auth handshake — the browser cannot set an
//  `Authorization` header on one — which is how subscription endpoints end up with a token in the
//  query string and therefore in every access log.
//
//  AUTHORIZATION IS PER ROW, AND IT IS THE WHOLE SECURITY STORY. An event either names an owner,
//  and reaches only that subject, or names none, and is public to any authenticated subscriber.
//  The filter is applied in the SQL predicate against the VERIFIED `sub`, never against anything
//  the subscriber sent: a client chooses its channel and its cursor, and cannot choose whose rows
//  it reads. `channel` is an allowlisted identifier, so it cannot be used to reach a row that the
//  owner predicate would otherwise exclude.
//
//  BACKPRESSURE AND COST. The poll is per stream, so N subscribers are N queries per interval —
//  bounded, predictable, and indexed on `(channel, seq)`. `maxDurationMs` closes the stream on
//  purpose: an edge platform will kill it anyway, and closing it ourselves means the client
//  reconnects with a cursor instead of discovering the death by silence.
//

/** One published event, as a subscriber sees it. */
export interface RealtimeEvent {
  /** the monotonic cursor — the SSE event id a client resumes from */
  seq: string;
  channel: string;
  /** the subject this event is FOR, or null when it is public to any authenticated subscriber */
  ownerId: string | null;
  payload: Record<string, unknown>;
  /** RFC 3339 */
  createdAt: string | null;
}

export interface RealtimeReadRequest {
  channel: string;
  /** exclusive lower bound; "0" starts from the beginning of retention */
  afterSeq: string;
  /** the verified subject; rows owned by anyone else are excluded in SQL */
  subject: string;
  limit: number;
}

/** The provider seam, filled by a store that can append and read by cursor. */
export interface RealtimeTransport {
  publish(event: { channel: string; ownerId: string | null; payload: Record<string, unknown> }): Promise<string>;
  read(request: RealtimeReadRequest): Promise<RealtimeEvent[]>;
}

export const RealtimeSeam = { transport: null as RealtimeTransport | null };

export type RealtimeErrorCode = "no_provider" | "bad_request" | "not_provisioned";

export class RealtimeError extends Error {
  readonly code: RealtimeErrorCode;
  constructor(message: string, code: RealtimeErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RealtimeError";
    this.code = code;
  }
}

/** Channels are identifiers, same grammar as a queue name and checked for the same reason. */
const CHANNEL = /^[a-z][a-z0-9_]*$/;

export function assertChannel(channel: string): string {
  if (!CHANNEL.test(channel)) {
    throw new RealtimeError(`"${channel}" is not a legal channel name (snake_case)`, "bad_request");
  }
  return channel;
}

/** A cursor is a decimal sequence number. Anything else is a client sending garbage, and is
 *  treated as "from the beginning" rather than as an error — a resumed stream must never fail
 *  because a proxy mangled a header. */
export function parseCursor(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "0";
  const trimmed = raw.trim();
  return /^\d{1,19}$/.test(trimmed) ? trimmed : "0";
}

function requireTransport(): RealtimeTransport {
  const transport = RealtimeSeam.transport;
  if (transport === null) {
    throw new RealtimeError(
      "no realtime provider is installed — enable a data provider whose residence fills the realtime seam " +
        "(Core/Server/Providers/Postgres does) and apply the emitted migration",
      "no_provider",
    );
  }
  return transport;
}

/**
 * PUBLISH ONE EVENT. Service-side only: `ownerId` decides who may read it, so a caller that could
 * choose it for themselves could publish into anyone's feed. Nothing on the client surface
 * reaches this, exactly like the queue plane.
 */
export async function publishEvent(
  channel: string,
  payload: Record<string, unknown>,
  options: { ownerId?: string | null } = {},
): Promise<string> {
  assertChannel(channel);
  return requireTransport().publish({ channel, ownerId: options.ownerId ?? null, payload });
}

/** How many events one poll may return. A burst larger than this is delivered over consecutive
 *  polls, in order, rather than in one unbounded response. */
export const REALTIME_BATCH_LIMIT = 200;

export interface SubscriptionOptions {
  /** how often to look for new events (default 1s) */
  pollIntervalMs?: number;
  /** close the stream after this long so the client reconnects deliberately (default 55s) */
  maxDurationMs?: number;
  /** comment frames that keep intermediaries from timing out an idle stream (default 15s) */
  heartbeatMs?: number;
  /** injected in tests */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_MS = 1000;
/** Under a minute on purpose: the common proxy and platform idle timeout is 60s, and being closed
 *  BY us with a cursor in hand is strictly better than being closed by something that will not
 *  say why. */
const DEFAULT_MAX_DURATION_MS = 55_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

function sseFrame(event: RealtimeEvent): string {
  // `id:` is what the browser echoes back as Last-Event-ID. `data:` must not contain a newline,
  // and JSON.stringify cannot produce a raw one, so a single data line is always correct here.
  return `id: ${event.seq}\nevent: ${event.channel}\ndata: ${JSON.stringify({
    seq: event.seq,
    channel: event.channel,
    payload: event.payload,
    createdAt: event.createdAt,
  })}\n\n`;
}

/**
 * THE SUBSCRIPTION RESPONSE.
 *
 * `subject` is the VERIFIED identity's `sub` and is the caller's responsibility to have verified —
 * this function is unreachable from a route that is not `auth: required`, and passing an
 * unverified value here would hand a stranger somebody's feed.
 */
export function subscriptionResponse(
  channel: string,
  subject: string,
  cursor: string,
  options: SubscriptionOptions = {},
): Response {
  assertChannel(channel);
  const transport = requireTransport();
  const pollMs = Math.max(100, options.pollIntervalMs ?? DEFAULT_POLL_MS);
  const maxMs = Math.max(pollMs, options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
  const heartbeatMs = Math.max(pollMs, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const encoder = new TextEncoder();
  let afterSeq = cursor;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const put = (s: string): void => {
        if (!closed) controller.enqueue(encoder.encode(s));
      };
      // `retry:` tells the browser how long to wait before reconnecting. Sent first so it applies
      // even to a stream that dies immediately.
      put(`retry: ${pollMs}\n\n`);
      const startedAt = Date.now();
      let lastFrameAt = startedAt;
      try {
        while (!closed && Date.now() - startedAt < maxMs) {
          const events = await transport.read({ channel, afterSeq, subject, limit: REALTIME_BATCH_LIMIT });
          for (const event of events) {
            put(sseFrame(event));
            afterSeq = event.seq;
            lastFrameAt = Date.now();
          }
          // A full batch means there is more waiting; go straight round again rather than
          // sleeping, or a backlog drains at `limit` per interval and never catches up.
          if (events.length === REALTIME_BATCH_LIMIT) continue;
          if (Date.now() - lastFrameAt >= heartbeatMs) {
            put(": keep-alive\n\n"); // an SSE comment: ignored by the client, unblocks every proxy
            lastFrameAt = Date.now();
          }
          await sleep(pollMs);
        }
      } catch (e) {
        // The stream is already open, so there is no status code left to send. An `error` frame is
        // the only way to say anything at all, and it says NOTHING about the cause: the client is
        // told to reconnect, and the detail belongs in the server log the caller already has.
        put(`event: error\ndata: {"reason":"subscription_failed"}\n\n`);
        throw e instanceof RealtimeError ? e : new RealtimeError("subscription failed", "not_provisioned", { cause: e });
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      // The client hung up. Stop polling: without this the loop keeps querying for a reader that
      // is gone, which on a mobile fleet is most of the load.
      closed = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      // Named explicitly because an intermediary that buffers an event stream turns realtime into
      // "everything at once, when the buffer fills".
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
