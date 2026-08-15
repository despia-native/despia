//
//  webhook.ts — the INBOUND webhook boundary: verify that a request really came from the sender
//  it claims to be, refuse a replay of one that did, and put the event on a queue.
//
//  WHY THIS IS A PLANE AND NOT A HANDLER SNIPPET. A webhook receiver is a PUBLIC, unauthenticated
//  POST endpoint that a stranger can call as often as they like, and whose only credential is a
//  signature over bytes. Every one of the ways it goes wrong is silent:
//
//    · comparing the signature with `===`           — a byte-at-a-time timing oracle for the secret
//    · verifying the PARSED body                    — JSON.parse then re-serialise is not the bytes
//                                                     that were signed; key order, unicode escapes
//                                                     and number formatting all differ, so this
//                                                     either rejects everything or is fixed by
//                                                     "just trust it"
//    · no timestamp window                          — a request captured once is valid forever
//    · a window but no nonce                        — valid unlimited times WITHIN the window
//    · doing the work inline                        — a sender's 10-second timeout decides whether
//                                                     your database write is retried
//
//  So the shape is fixed here rather than left to each handler: verify over the RAW BODY, bound
//  by a clock window, made single-use by the queue's own UNIQUE key, and answered before any work
//  happens. The handler an app author writes is the per-message worker on the drain side, which
//  is ordinary code with a retry budget and no stranger holding the other end.
//
//  THE SIGNATURE FORMAT, DECLARED ONCE:
//
//      signature = hex( HMAC-SHA256( secret, `${timestamp}.${rawBody}` ) )
//
//  presented on `X-DSX-Signature`, with the same `timestamp` (Unix SECONDS) on `X-DSX-Timestamp`.
//  The timestamp is inside the signed string on purpose: outside it, an attacker rewrites the
//  header to now and the window stops meaning anything.
//
//  Header names and the tolerance are per-source, because the sender picks them and you do not.
//  A source may carry MORE THAN ONE SECRET, and that is not a convenience — it is the only way to
//  rotate one without dropping deliveries: accept old and new for the overlap, then drop the old.
//
//  REPLAY DEFENSE IS THE QUEUE'S UNIQUE KEY, NOT A SECOND STORE. The queue table already declares
//  `idempotency_key text not null unique` and already keeps acked rows forever precisely so a key
//  keeps refusing. Enqueueing under a key derived from the delivery makes a replay a duplicate
//  INSERT — refused by the index, under concurrency, whether the original is still pending, is
//  mid-flight under a lease, or was drained and acked a month ago. A separate nonce table with a
//  TTL would be weaker (it forgets), more code (a sweeper), and a second answer to a question the
//  queue already answers.
//

import { enqueueMessage } from "./queue.ts";
import { secretEquals } from "./secrets.ts";

/** A declared webhook sender. `prepare_server.rb` builds these from the `webhook` facet rows. */
export interface WebhookSource {
  /** the declared source name (snake_case) — namespaces the idempotency key */
  name: string;
  /**
   * The shared signing secrets, most-current first. More than one is the ROTATION window: a
   * delivery signed with either is accepted, so the sender can be switched over without a gap.
   * Empty means this source is not configured, and every delivery to it is refused.
   */
  secrets: readonly string[];
  /** the queue a verified delivery is enqueued onto */
  queue: string;
  /** where the signature is presented (default `x-dsx-signature`), matched case-insensitively */
  signatureHeader?: string;
  /** where the signed timestamp is presented (default `x-dsx-timestamp`) */
  timestampHeader?: string;
  /**
   * A dotted path into the parsed payload carrying the SENDER's own event id. When present and
   * resolvable it is the idempotency key, so two deliveries the sender considers the same event
   * collapse even if it re-signed them at different times. Absent, the key falls back to the
   * signature, which is unique per (secret, timestamp, body) and is therefore always sufficient
   * for replay defense — just not for sender-side deduplication.
   */
  idField?: string;
  /** how far the signed timestamp may be from now, in either direction (default 5 minutes) */
  toleranceMs?: number;
}

/** Default clock window. Long enough for a slow sender and a skewed clock, short enough that a
 *  captured request is not useful by the time anyone gets to it. */
export const DEFAULT_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/** Ceiling on a webhook body. Bigger than the host default is never right for an event notice. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * The closed vocabulary of refusals.
 *
 * `unknown_source` and `not_configured` are DELIBERATELY DISTINCT INTERNALLY and deliberately
 * indistinguishable on the wire — see `webhookResponse`. Knowing which one it was tells a prober
 * whether a source name exists, and a source name is a thing you might well have named after a
 * vendor you use.
 */
export type WebhookRefusal =
  | "unknown_source"
  | "not_configured"
  | "missing_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "expired_timestamp"
  | "future_timestamp"
  | "bad_signature"
  | "body_too_large"
  | "unreadable_body"
  | "malformed_body";

export type WebhookVerdict =
  | {
      ok: true;
      source: string;
      /** the idempotency key this delivery will be stored under */
      key: string;
      /** the parsed payload */
      payload: Record<string, unknown>;
      /** the signed timestamp, in ms */
      signedAtMs: number;
    }
  | { ok: false; refusal: WebhookRefusal; message: string };

const DEFAULT_SIGNATURE_HEADER = "x-dsx-signature";
const DEFAULT_TIMESTAMP_HEADER = "x-dsx-timestamp";

const HEX = /^[0-9a-f]+$/;

function toHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * HMAC-SHA256 over the signed string. WebCrypto only — the same bar `identity.ts` clears, so this
 * runs unchanged on Node, Deno and the edge with no platform import anywhere in the file.
 */
async function sign(secret: string, signedString: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(signedString)));
}

/** Resolve a dotted path against the payload, returning a non-empty string or null. */
function readIdField(payload: Record<string, unknown>, path: string): string | null {
  let cursor: unknown = payload;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor === "string" && cursor !== "") return cursor;
  if (typeof cursor === "number" && Number.isFinite(cursor)) return String(cursor);
  return null;
}

export interface WebhookVerifyOptions {
  /** injected in tests; defaults to the wall clock */
  nowMs?: number;
}

/**
 * VERIFY ONE DELIVERY, over the raw body the sender signed.
 *
 * `rawBody` is a string of the EXACT bytes received. It is a parameter rather than something this
 * function reads off the Request because the caller must have already read the body under a cap —
 * and because a caller who passes `JSON.stringify(parsed)` here should have to write that out and
 * see it, since it is the single most common way a webhook verifier is silently wrong.
 *
 * NEVER THROWS on a bad delivery. A refusal is a value: a stranger's malformed request is not an
 * exceptional condition on an endpoint whose entire job is receiving strangers' requests, and
 * throwing would put attacker-controlled text into the failure sink at whatever rate they choose.
 */
export async function verifyWebhook(
  source: WebhookSource,
  headers: Headers,
  rawBody: string,
  options: WebhookVerifyOptions = {},
): Promise<WebhookVerdict> {
  if (source.secrets.length === 0 || source.secrets.every((s) => s === "")) {
    return { ok: false, refusal: "not_configured", message: `webhook source "${source.name}" has no signing secret` };
  }

  const presented = headers.get(source.signatureHeader ?? DEFAULT_SIGNATURE_HEADER);
  if (presented === null || presented === "") {
    return { ok: false, refusal: "missing_signature", message: "no signature presented" };
  }
  const rawTimestamp = headers.get(source.timestampHeader ?? DEFAULT_TIMESTAMP_HEADER);
  if (rawTimestamp === null || rawTimestamp === "") {
    return { ok: false, refusal: "missing_timestamp", message: "no signed timestamp presented" };
  }
  // Unix SECONDS, integral. `Number("12 ")` is 12 and `Number("0x10")` is 16, so the shape is
  // checked before the value: a timestamp is digits, optionally negative, and nothing else.
  if (!/^-?\d{1,15}$/.test(rawTimestamp)) {
    return { ok: false, refusal: "malformed_timestamp", message: "the signed timestamp is not an integer" };
  }
  const signedAtMs = Number(rawTimestamp) * 1000;
  const nowMs = options.nowMs ?? Date.now();
  const tolerance = Math.max(0, source.toleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS);
  // THE WINDOW IS CHECKED BEFORE THE HMAC, deliberately. It is a comparison of two numbers, where
  // the HMAC is a key import plus a digest; an unauthenticated endpoint that does the expensive
  // half first is a CPU amplifier for anyone with a socket. The window leaks nothing — the
  // attacker supplied the timestamp.
  if (signedAtMs < nowMs - tolerance) {
    return { ok: false, refusal: "expired_timestamp", message: "the signed timestamp is outside the tolerance window" };
  }
  if (signedAtMs > nowMs + tolerance) {
    return { ok: false, refusal: "future_timestamp", message: "the signed timestamp is in the future" };
  }

  const normalised = presented.trim().toLowerCase();
  // A hex digest is 64 lowercase hex characters. Checking the SHAPE first means a garbage header
  // never reaches the comparison; it costs nothing and it is not a secret-dependent branch.
  if (normalised.length !== 64 || !HEX.test(normalised)) {
    return { ok: false, refusal: "bad_signature", message: "the signature is not a sha256 hex digest" };
  }

  const signedString = `${rawTimestamp}.${rawBody}`;
  // EVERY candidate secret is tried, and the loop does NOT break early. Returning as soon as one
  // matches would make the response time report WHICH secret verified it — during a rotation that
  // distinguishes "the sender has already moved to the new secret" from "it has not", which is
  // exactly the window an attacker holding a leaked old secret wants to know about.
  let matched = false;
  for (const secret of source.secrets) {
    if (secret === "") continue;
    const expected = await sign(secret, signedString);
    if (secretEquals(normalised, expected)) matched = true;
  }
  if (!matched) {
    return { ok: false, refusal: "bad_signature", message: "the signature does not verify" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody === "" ? "{}" : rawBody);
  } catch {
    return { ok: false, refusal: "malformed_body", message: "the body is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, refusal: "malformed_body", message: "the body must be a JSON object" };
  }
  const payload = parsed as Record<string, unknown>;

  // The key namespaces the source, so two senders that both call an event "1" cannot collide and
  // silently swallow each other's deliveries.
  const senderId = source.idField === undefined ? null : readIdField(payload, source.idField);
  const key = `${source.name}:${senderId ?? normalised}`;
  return { ok: true, source: source.name, key, payload, signedAtMs };
}

/** What `receiveWebhook` did, for the caller's log. */
export type WebhookOutcome =
  | { accepted: true; source: string; key: string; duplicate: boolean }
  | { accepted: false; status: number; refusal: WebhookRefusal; message: string };

/**
 * READ, VERIFY, ENQUEUE — the whole receiver.
 *
 * The body is read under `MAX_WEBHOOK_BODY_BYTES` against the STREAM, never against the
 * Content-Length a stranger declared, for the same reason `host.ts` does: an unbounded read is a
 * memory-exhaustion DoS with a one-line request.
 */
export async function receiveWebhook(
  source: WebhookSource,
  req: Request,
  options: WebhookVerifyOptions & { maxBodyBytes?: number } = {},
): Promise<WebhookOutcome> {
  const max = Math.max(1, options.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES);
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    return { accepted: false, status: 413, refusal: "body_too_large", message: `body exceeds ${max} bytes` };
  }
  let rawBody: string;
  try {
    rawBody = await readCapped(req, max);
  } catch (e) {
    return e instanceof TooLarge
      ? { accepted: false, status: 413, refusal: "body_too_large", message: `body exceeds ${max} bytes` }
      : { accepted: false, status: 400, refusal: "unreadable_body", message: "unreadable request body" };
  }

  const verdict = await verifyWebhook(source, req.headers, rawBody, options);
  if (!verdict.ok) {
    return { accepted: false, status: statusFor(verdict.refusal), refusal: verdict.refusal, message: verdict.message };
  }

  // A QueueError here (no provider, table not provisioned) is the ONLY condition in this function
  // that is the RECEIVER's fault rather than the sender's, so it is the only one that leaves as an
  // exception: the caller turns it into a 500 with a correlation id, and the sender retries — which
  // is the correct behaviour, because the delivery was good and we failed to store it. Answering
  // any 2xx here would tell the sender the event was accepted and stop the retry that would have
  // saved it.
  const result = await enqueueMessage(source.queue, verdict.key, {
    // The received event, kept whole, plus the receipt facts a worker cannot reconstruct later.
    received_at: new Date(options.nowMs ?? Date.now()).toISOString(),
    signed_at: new Date(verdict.signedAtMs).toISOString(),
    source: verdict.source,
    body: verdict.payload,
  });

  return { accepted: true, source: verdict.source, key: verdict.key, duplicate: result.duplicate };
}

class TooLarge extends Error {}

async function readCapped(req: Request, max: number): Promise<string> {
  const stream = req.body;
  if (!stream) {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > max) throw new TooLarge();
    return text;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * The wire status for a refusal.
 *
 * `unknown_source` and `not_configured` both answer 404 — the byte-identical answer a path that
 * matches nothing gives — for the reason stated on `WebhookRefusal`. Everything a correctly
 * addressed but unverifiable delivery can be is 401: a sender reading its own dashboard learns
 * "you are not signing this the way I expect", and learns nothing more precise than that.
 */
export function statusFor(refusal: WebhookRefusal): number {
  switch (refusal) {
    case "unknown_source":
    case "not_configured":
      return 404;
    case "body_too_large":
      return 413;
    case "unreadable_body":
    case "malformed_body":
      return 400;
    default:
      return 401;
  }
}

/** The response a receiver route returns. A duplicate is 200 with `duplicate: true`, never an
 *  error: a sender retrying a delivery it already made must get the same answer it got the first
 *  time, or it will keep retrying forever. */
export function webhookResponse(outcome: WebhookOutcome): Response {
  const body = outcome.accepted
    ? { accepted: true, duplicate: outcome.duplicate }
    : { reason: "webhook_refused", message: outcome.message };
  return new Response(JSON.stringify(body), {
    status: outcome.accepted ? 200 : outcome.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
