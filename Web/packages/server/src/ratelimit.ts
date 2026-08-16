//
//  ratelimit.ts — the REQUEST BUDGET plane: how many times one caller may invoke one route in a
//  window, and what happens when they exceed it.
//
//  WHY THIS IS DURABLE AND NOT A MAP. The obvious implementation is a Map in module scope, and on
//  the deployment target this framework ships to it is worse than nothing. An edge function is a
//  fleet of isolates with independent memory that are created and destroyed per traffic pattern;
//  an in-memory counter is therefore per-isolate, so the real limit is `limit × isolates` and it
//  resets whenever the platform feels like it. A limiter that reports "10 per minute" while
//  actually allowing a few hundred is not a weaker limiter, it is a FALSE STATEMENT in the
//  security posture — and the failure only appears under the load it exists to survive.
//
//  So the counter lives in the store, in one statement:
//
//      insert … on conflict (bucket, window_start) do update set count = t.count + 1 returning count
//
//  One atomic upsert, one round trip, no read-then-write to lose a race on. Postgres decides the
//  count under concurrency, which is the same reason the queue's idempotency key is a UNIQUE index
//  rather than a lookup.
//
//  FIXED WINDOW, AND THE HONESTY THAT REQUIRES. A fixed window admits up to 2× the limit across a
//  boundary (the tail of one window plus the head of the next). A sliding-log window does not, and
//  costs a row per request and a range scan to answer. For the thing this actually defends —
//  credential stuffing on a login route, a runaway client, one tenant starving another — 2× at a
//  boundary is irrelevant and the cost is not. The property is stated here so nobody has to
//  rediscover it from a graph, and `retryAfterSeconds` is computed from the real window end so a
//  well-behaved client backs off exactly as long as it must.
//
//  FAIL OPEN, DELIBERATELY, AND ONLY HERE. Every other boundary in this server fails closed. This
//  one does not: if the limiter's own store is unreachable, the request is ALLOWED and the failure
//  is reported to the sink. A limiter that 500s when its database hiccups converts a partial
//  outage into a total one, and it does so at exactly the moment the system is least able to
//  absorb it. The thing it protects is availability; taking the whole service down to protect
//  availability is not a trade, it is the outage. Authentication is unaffected — an over-budget
//  request that is also unauthenticated is still refused by the identity boundary, which has not
//  moved.
//

/** One decision. `allowed: false` is the only thing a caller must act on. */
export interface RateVerdict {
  allowed: boolean;
  /** the ceiling that applied */
  limit: number;
  /** how many of the budget are left after this request (never negative) */
  remaining: number;
  /** when the current window ends, ms since epoch — the `X-RateLimit-Reset` value */
  resetAtMs: number;
  /** seconds to wait before retrying; 0 when allowed */
  retryAfterSeconds: number;
}

export interface RateLimitRule {
  /** requests permitted per window */
  limit: number;
  /** the window length in ms */
  windowMs: number;
}

/** The store seam. A provider fills it only if it can count ATOMICALLY (see the file header). */
export interface RateLimitStore {
  /**
   * Increment `bucket` for the window beginning at `windowStartMs` and return the count AFTER
   * this request. Must be atomic against concurrent callers, and must never return a count that
   * two concurrent callers both saw.
   */
  hit(bucket: string, windowStartMs: number, windowMs: number): Promise<number>;
}

export const RateLimitSeam = { store: null as RateLimitStore | null };

/**
 * Ceiling on a bucket key. The key is built from caller-controlled parts (a route path, an
 * identity subject, a forwarded address); without a cap a caller chooses how much of the
 * limiter's index they occupy, which turns the defence into the attack.
 */
const MAX_BUCKET_BYTES = 200;

function clampBucket(bucket: string): string {
  const bytes = new TextEncoder().encode(bucket);
  if (bytes.length <= MAX_BUCKET_BYTES) return bucket;
  // Truncating BYTES can split a multi-byte character; decoding the slice with the default
  // (lossy) decoder replaces the fragment rather than throwing, so the key stays valid UTF-8.
  return new TextDecoder().decode(bytes.slice(0, MAX_BUCKET_BYTES));
}

export interface RateLimitOptions {
  /** injected in tests; defaults to the wall clock */
  nowMs?: number;
  /** where a store failure is reported. The request is allowed either way (see the header). */
  onError?: (error: unknown) => void;
}

/**
 * SPEND ONE UNIT of `bucket`'s budget.
 *
 * With no store installed this ALLOWS and reports nothing: an unconfigured limiter is not a
 * broken one, and every deployment that has not declared a limit would otherwise be refused.
 * Whether a limit is declared at all is a build-time question (the `rate` facet), which is where
 * "you asked for a limit and configured no store" belongs.
 */
export async function spend(bucket: string, rule: RateLimitRule, options: RateLimitOptions = {}): Promise<RateVerdict> {
  const limit = Math.max(1, Math.trunc(rule.limit));
  const windowMs = Math.max(1, Math.trunc(rule.windowMs));
  const nowMs = options.nowMs ?? Date.now();
  // Windows are aligned to the epoch, not to first contact. Two isolates that first see a caller
  // a second apart must agree on which window a request falls in, or the count is split.
  const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  const resetAtMs = windowStartMs + windowMs;

  const store = RateLimitSeam.store;
  if (store === null) {
    return { allowed: true, limit, remaining: limit, resetAtMs, retryAfterSeconds: 0 };
  }

  let count: number;
  try {
    count = await store.hit(clampBucket(bucket), windowStartMs, windowMs);
  } catch (e) {
    options.onError?.(e);
    return { allowed: true, limit, remaining: limit, resetAtMs, retryAfterSeconds: 0 };
  }

  const allowed = count <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - count),
    resetAtMs,
    // Ceiling, and never 0 for a refused request: `Retry-After: 0` invites an immediate retry,
    // which is the behaviour the refusal exists to stop.
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
  };
}

/** The advisory headers, on EVERY answer rather than only the refusals — a client cannot back off
 *  before it is refused unless it can see the budget shrinking. */
export function rateHeaders(verdict: RateVerdict): Record<string, string> {
  const headers: Record<string, string> = {
    "x-ratelimit-limit": String(verdict.limit),
    "x-ratelimit-remaining": String(verdict.remaining),
    "x-ratelimit-reset": String(Math.ceil(verdict.resetAtMs / 1000)),
  };
  if (!verdict.allowed) headers["retry-after"] = String(verdict.retryAfterSeconds);
  return headers;
}
