//
//  spend.ts — the SPEND PLANE (architecture/proposals/cost-guardrails.md): deployment-level
//  ceilings on everything that costs money, default-on, opt-out in the open.
//
//  WHAT THIS IS NOT. The rate plane (ratelimit.ts) answers "how many times may ONE caller invoke
//  ONE route in a window" — per-caller fairness. The request sandbox (actions.ts) answers "how
//  much may ONE request consume" — per-request containment, kernel-owned, never raisable. This
//  plane answers a third question neither of them can: "how much may THIS DEPLOYMENT spend, in
//  total, before the owner has said they mean it." Its ceilings are the OWNER's policy, so they
//  are raisable — loudly, in the document, recorded in the emitted table — which is exactly what
//  the other two must never be.
//
//  WHY IT IS SYNC-CHARGE, WRITE-BEHIND. Every metered seam is on a hot path (the egress gate is
//  consulted inside the interpreter's fetch funnel, synchronously). A meter that added a database
//  round trip per unit would be a second bill and a latency tax — the guard would cost more than
//  most runaways. So `chargeSpend` is SYNCHRONOUS against isolate-local state, and the durable
//  counter is written behind, batched, on a clock (`flushSpendIfDue`). The honesty bound that
//  buys, stated the way ratelimit.ts states its 2× window fact: a ceiling can be overrun by at
//  most `flush interval × arrival rate × isolate count` before every isolate agrees it is
//  tripped. Ceilings here are safety margins against five-figure runaways, not invoices; seconds
//  of slack against a window measured in hours is the right trade, and it is written down so
//  nobody rediscovers it from a graph.
//
//  FAILURE POSTURE — bounded staleness, not fail-open and not fail-closed. If the counter store
//  is unreachable, the LAST KNOWN verdict holds: an open budget stays open (a wallet guard must
//  not convert a database hiccup into an outage — the rate plane's fail-open reasoning), and a
//  tripped one stays tripped (the runaway is exactly when the store is likeliest to be drowning).
//  Local units are NOT discarded on a failed flush; they carry to the next attempt, so the count
//  is late, never lost.
//
//  THAT SENTENCE IS SCOPED, deliberately, and the scope is measured rather than implied. "Never
//  lost" covers STORE failure. An isolate DYING between flushes loses its unflushed tail — at
//  most one flush cadence of traffic, because the flush rides every request's completion — and
//  a lost tail is also the ceiling's crash-overshoot allowance (pinned: spend.test.ts,
//  "crash-before-flush, measured"). Likewise enforcement across a FLEET is per-isolate against
//  a durable count synchronized at the flush, so the ceiling is APPROXIMATE with a stated
//  bound: an isolate that has not reconciled admits at most one staleness window past it, plus
//  its boundary unit, and its next reconcile shuts the door (pinned: spend.postgres.test.ts,
//  "overshoot, measured"). There is no cheap globally-atomic pre-check and this plane does not
//  pretend one — a per-charge durable round trip would make the meter the bill. Ceilings are
//  safety margins against five-figure runaways: 2,000 means 2,000 ± seconds of traffic, and
//  anything marketed harder than that is a lie this header exists to forbid.
//
//  EVENTS ARE EDGE-TRIGGERED, PER ISOLATE. Crossing 80% emits `spend.warning` once per window;
//  crossing the ceiling emits `spend.tripped`; the window rolling over emits `spend.recovered`.
//  Two isolates can each cross a threshold before the flush reconciles them, so the feed may
//  carry a duplicate transition under burst — tolerated on purpose: a doorbell that occasionally
//  rings twice is better than a reconciliation protocol on the hot path. The beacon (the
//  report-to-Despia doorbell) rides the same transitions, so its volume is bounded by
//  construction — budgets × windows × isolates — never by traffic.
//

import { RealtimeSeam } from "./realtime.ts";

/** One declared (or defaulted) ceiling, exactly as the emitter writes it into
 *  `settings.spend_budgets`. `max: "unbounded"` is the opt-out — a WORD, not an absence, so the
 *  deploy prints it, the receipt records it, and this plane still counts the units under it. */
export interface SpendBudget {
  /** the metered seam: `requests` · `data:writes` · `data:reads` · `egress:<host>` · `queue:<name>` */
  of: string;
  per: "hour" | "day" | "month";
  max: number | "unbounded";
  /** queue rows only: the outstanding-message ceiling (backpressure), enforced at enqueue */
  depth?: number;
}

/** One decision. `allowed: false` is the only thing a caller must act on; the rest is the
 *  refusal's honesty — which budget went and when it resets. */
export interface SpendVerdict {
  allowed: boolean;
  /** the budget that decided (its `of`), or null when nothing meters this kind */
  budget: string | null;
  /** seconds until the window rolls; 0 when allowed */
  retryAfterSeconds: number;
}

const OPEN: SpendVerdict = Object.freeze({ allowed: true, budget: null, retryAfterSeconds: 0 });

/** The durable counter seam. A provider fills it only if it can add ATOMICALLY (the rate-limit
 *  store's rule); the Postgres provider backs it with the same `dsx_rate_counter` table, so a
 *  provisioned deployment needs NOTHING new for this plane to be durable. */
export interface SpendStore {
  /** add each entry's `n` to its (bucket, window) row atomically; answer the counts AFTER. */
  add(entries: { bucket: string; windowStartMs: number; windowMs: number; n: number }[]): Promise<{ bucket: string; count: number }[]>;
  /** read current counts without adding (absent rows answer 0). */
  read(entries: { bucket: string; windowStartMs: number }[]): Promise<{ bucket: string; count: number }[]>;
}

export const SpendSeam = { store: null as SpendStore | null };

/** The feed channel spend transitions land on (`dsx_events` rows the dashboard reads). */
export const SPEND_CHANNEL = "dsx_spend";

/** The env names the beacon reads (Core/Server config.json `spend_beacon_*`). URL or key unset =
 *  the doorbell does not exist, and the plane never fetches anywhere. The APP id is what the
 *  ingest side attributes and verifies BY (each deployment's key is minted per app, so the id
 *  names which key to check the signature against); without one the beacon still rings and the
 *  ingest is free to drop what it cannot attribute. */
export const SPEND_BEACON_URL_ENV = "DSX_SPEND_BEACON_URL";
export const SPEND_BEACON_KEY_ENV = "DSX_SPEND_BEACON_KEY";
export const SPEND_BEACON_APP_ENV = "DSX_SPEND_BEACON_APP";

/** Warn threshold: the fraction of a finite ceiling that emits `spend.warning`. */
export const SPEND_WARN_AT = 0.8;

/** Write-behind cadence. The staleness half of the honesty bound in the header. */
export const SPEND_FLUSH_MS = 5_000;

/** The doorbell's own deadline (see `ringBeacon`). */
const BEACON_TIMEOUT_MS = 5_000;

interface BudgetState {
  budget: SpendBudget;
  windowStartMs: number;
  /** units confirmed in the durable counter (this window, all isolates) */
  global: number;
  /** units charged locally since the last successful flush */
  local: number;
  tripped: boolean;
  warned: boolean;
}

/** A transition waiting to be published/beaconed on the next flush. */
interface Transition {
  kind: "spend.warning" | "spend.tripped" | "spend.recovered";
  budget: SpendBudget;
  count: number;
  windowStartMs: number;
}

interface Plane {
  states: BudgetState[];
  warnAt: number;
  flushMs: number;
  now: () => number;
  onError: (error: unknown) => void;
  pending: Transition[];
  lastFlushAt: number;
  flushing: Promise<void> | null;
}

let plane: Plane | null = null;

export interface SpendOptions {
  warnAt?: number;
  flushIntervalMs?: number;
  /** injected in tests; defaults to the wall clock */
  now?: () => number;
  /** where a store/feed/beacon failure is reported. Charging is never blocked by one. */
  onError?: (error: unknown) => void;
}

/**
 * Install the plane. Called by `createHost` from the emitted `settings.spend_budgets`, so every
 * bootloader — Workers, Supabase edge, Node, Firebase — inherits it with no wiring of its own.
 * An empty table means the emitter was told to guard nothing (every row opted out at build), or
 * a hand-built host declared nothing: the plane then answers OPEN everywhere, which is the same
 * honest meaning an unconfigured rate limiter has.
 */
export function configureSpend(budgets: readonly SpendBudget[], options: SpendOptions = {}): void {
  const now = options.now ?? ((): number => Date.now());
  const nowMs = now();
  plane = {
    states: budgets
      .filter((b) => b !== null && typeof b === "object" && typeof b.of === "string" && b.of !== "")
      .map((b) => ({
        budget: b,
        windowStartMs: windowStart(b.per, nowMs),
        global: 0,
        local: 0,
        tripped: false,
        warned: false,
      })),
    warnAt: options.warnAt ?? SPEND_WARN_AT,
    flushMs: Math.max(250, options.flushIntervalMs ?? SPEND_FLUSH_MS),
    now,
    onError: options.onError ?? ((e: unknown): void => {
      // eslint-disable-next-line no-console -- the default failure sink, replaceable via options
      console.error(`[dsx.spend] ${e instanceof Error ? e.message : String(e)}`);
    }),
    pending: [],
    lastFlushAt: nowMs,
    flushing: null,
  };
}

/** Tear the plane down (tests). A live server never calls this. */
export function resetSpend(): void {
  plane = null;
}

// ── window math ─────────────────────────────────────────────────────────────────────────
//
// Hour and day windows are epoch-aligned, exactly like the rate plane's: two isolates that first
// see traffic a second apart must agree which window a unit belongs to, or the count is split.
// A month window is the UTC calendar month — a "month" of fixed milliseconds would drift off
// every human expectation of when a monthly budget resets.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function windowStart(per: SpendBudget["per"], nowMs: number): number {
  if (per === "hour") return Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  if (per === "day") return Math.floor(nowMs / DAY_MS) * DAY_MS;
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function windowEnd(per: SpendBudget["per"], windowStartMs: number): number {
  if (per === "hour") return windowStartMs + HOUR_MS;
  if (per === "day") return windowStartMs + DAY_MS;
  const d = new Date(windowStartMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

// ── budget resolution ───────────────────────────────────────────────────────────────────

/**
 * Which budget meters `kind`. Exact match for everything except egress, where the declared host
 * is matched by the SAME suffix rule the egress gate uses (`egress:stripe.com` meters
 * `egress:api.stripe.com`), so the allowlist and the meter can never disagree about which
 * declaration a call belongs to. Among several matching declarations the LONGEST (most
 * specific) wins — the DNS-suffix rule everyone expects — never declaration or sort order:
 * with budgets on both `example.com` and `z.example.com`, a call to `a.z.example.com` belongs
 * to the specific one, and an order-dependent answer here would make the ceiling that applies
 * depend on the alphabet.
 */
function stateFor(p: Plane, kind: string): BudgetState | null {
  for (const s of p.states) if (s.budget.of === kind) return s;
  if (kind.startsWith("egress:")) {
    const host = kind.slice("egress:".length).toLowerCase();
    let best: BudgetState | null = null;
    let bestLength = -1;
    for (const s of p.states) {
      if (!s.budget.of.startsWith("egress:")) continue;
      const declared = s.budget.of.slice("egress:".length).toLowerCase();
      if ((host === declared || host.endsWith(`.${declared}`)) && declared.length > bestLength) {
        best = s;
        bestLength = declared.length;
      }
    }
    return best;
  }
  return null;
}

function rollIfDue(p: Plane, s: BudgetState, nowMs: number): void {
  const start = windowStart(s.budget.per, nowMs);
  if (start === s.windowStartMs) return;
  // The roll is the ONLY way a tripped budget re-opens — there is deliberately no admin
  // "reset the counter" verb, because a ceiling that can be waved away under pressure is not
  // a ceiling. Raising the budget in the document and redeploying is the sanctioned override.
  if (s.tripped) p.pending.push({ kind: "spend.recovered", budget: s.budget, count: s.global + s.local, windowStartMs: s.windowStartMs });
  s.windowStartMs = start;
  s.global = 0;
  s.local = 0;
  s.tripped = false;
  s.warned = false;
}

/**
 * SPEND `n` UNITS of `kind`. Synchronous, allocation-light, safe on the hottest path.
 *
 * The unit is counted EVEN WHEN REFUSED and even under `unbounded`: the counter is the
 * observability the dashboard renders, and demand during a trip is exactly what the owner needs
 * to see. Only `allowed` changes.
 */
export function chargeSpend(kind: string, n = 1): SpendVerdict {
  const p = plane;
  if (p === null) return OPEN;
  const s = stateFor(p, kind);
  if (s === null) return OPEN;
  const nowMs = p.now();
  rollIfDue(p, s, nowMs);
  s.local += Math.max(1, Math.trunc(n));
  const max = s.budget.max;
  if (max === "unbounded") return OPEN;
  const total = s.global + s.local;
  // No upper bound on the warn branch: a multi-unit charge can jump from below the threshold
  // straight past the ceiling, and the dashboard sequence every corpus verdict pins is
  // warning-then-trip - both emitted from this one charge, in that order, when the jump spans
  // both lines. `warned` alone keeps it single-shot per window.
  if (!s.warned && total >= max * p.warnAt) {
    s.warned = true;
    p.pending.push({ kind: "spend.warning", budget: s.budget, count: total, windowStartMs: s.windowStartMs });
  }
  if (!s.tripped && total > max) {
    s.tripped = true;
    p.pending.push({ kind: "spend.tripped", budget: s.budget, count: total, windowStartMs: s.windowStartMs });
  }
  if (!s.tripped) return OPEN;
  return {
    allowed: false,
    budget: s.budget.of,
    // Never 0: `Retry-After: 0` invites the immediate retry the refusal exists to stop.
    retryAfterSeconds: Math.max(1, Math.ceil((windowEnd(s.budget.per, s.windowStartMs) - nowMs) / 1000)),
  };
}

/** The refusal's headers. `retry-after` is the window's real end; the budget name rides its own
 *  header so a client (and a support thread) can see WHICH ceiling went without parsing prose. */
export function spendHeaders(verdict: SpendVerdict): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!verdict.allowed) {
    headers["retry-after"] = String(verdict.retryAfterSeconds);
    if (verdict.budget !== null) headers["x-dsx-spend-budget"] = verdict.budget;
  }
  return headers;
}

/** The declared outstanding-message ceiling for a queue, or null when none. Consulted by the
 *  enqueue path (queue.ts) — the plane owns the declaration, the queue owns the enforcement. */
export function queueDepthCeiling(queue: string): number | null {
  const p = plane;
  if (p === null) return null;
  const s = p.states.find((row) => row.budget.of === `queue:${queue}`);
  const depth = s?.budget.depth;
  return typeof depth === "number" && Number.isFinite(depth) && depth > 0 ? Math.trunc(depth) : null;
}

/** The dashboard's read: every budget, its window, its counts and its flags. Served by the
 *  host's `/dsx-internal/spend` face — the internal plane the editor reads browser-direct. */
export function spendSnapshot(): {
  budgets: { of: string; per: string; max: number | "unbounded"; depth?: number; windowStartMs: number; windowEndMs: number; count: number; tripped: boolean; warned: boolean }[];
} {
  const p = plane;
  if (p === null) return { budgets: [] };
  const nowMs = p.now();
  return {
    budgets: p.states.map((s) => {
      rollIfDue(p, s, nowMs);
      return {
        of: s.budget.of,
        per: s.budget.per,
        max: s.budget.max,
        ...(s.budget.depth !== undefined ? { depth: s.budget.depth } : {}),
        windowStartMs: s.windowStartMs,
        windowEndMs: windowEnd(s.budget.per, s.windowStartMs),
        count: s.global + s.local,
        tripped: s.tripped,
        warned: s.warned,
      };
    }),
  };
}

// ── the write-behind flush ──────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  let out = "";
  for (const b of new Uint8Array(bytes)) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * THE BEACON — the doorbell, not the ledger. One signed POST per transition, so its volume is
 * bounded by construction; losing one loses nothing (the truth lives in the owner's own event
 * feed and counters). Absent configuration = no request, ever: a deployment that has not opted
 * into notifications must not talk to anyone.
 */
async function ringBeacon(t: Transition, env: (key: string) => string | undefined, onError: (e: unknown) => void): Promise<void> {
  const url = env(SPEND_BEACON_URL_ENV);
  const key = env(SPEND_BEACON_KEY_ENV);
  if (url === undefined || url === "" || key === undefined || key === "") return;
  try {
    const app = env(SPEND_BEACON_APP_ENV);
    const body = JSON.stringify({
      ...(app !== undefined && app !== "" ? { app } : {}),
      kind: t.kind,
      budget: t.budget.of,
      per: t.budget.per,
      max: t.budget.max,
      count: t.count,
      windowStartMs: t.windowStartMs,
    });
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    if (subtle === undefined) return; // no WebCrypto, no signature, no unsigned beacon
    const cryptoKey = await subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = hex(await subtle.sign("HMAC", cryptoKey, encoder.encode(body)));
    // A HARD deadline on the ring. The scheduled tick AWAITS its flush, so a hung ingest
    // without this would hold a cron invocation to the platform's own timeout — the doorbell
    // becoming the outage. Five seconds is generous for one small POST; past it the bell is
    // simply dropped, which the design already tolerates (the truth is on the owner's plane).
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error("beacon timed out")), BEACON_TIMEOUT_MS);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "x-dsx-signature": signature },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(deadline);
    }
  } catch (e) {
    onError(e); // a doorbell failure is reported, never propagated — nothing here may fail a request
  }
}

async function flushNow(env?: (key: string) => string | undefined): Promise<void> {
  const p = plane;
  if (p === null) return;
  const transitions = p.pending;
  p.pending = [];
  p.lastFlushAt = p.now();

  const store = SpendSeam.store;
  if (store !== null && p.states.length > 0) {
    // SNAPSHOT what this flush is sending, per state, BEFORE any await. Charges keep landing on
    // `s.local` while the store round trip is in flight, so the writeback below must subtract
    // exactly what was sent rather than zeroing — zeroing silently discarded every unit charged
    // during the await, which under load is `RTT × arrival rate` units per flush, forever (the
    // review's verified repro: 5 sent + 3 charged mid-flight flushed as 5, not 8).
    const sent = new Map<BudgetState, { n: number; windowStartMs: number }>();
    for (const s of p.states) if (s.local > 0) sent.set(s, { n: s.local, windowStartMs: s.windowStartMs });
    const idle = p.states.filter((s) => s.local === 0 && s.budget.max !== "unbounded");
    const idleWindows = new Map<BudgetState, number>(idle.map((s) => [s, s.windowStartMs]));
    try {
      if (sent.size > 0) {
        const counts = await store.add([...sent.entries()].map(([s, snap]) => ({
          bucket: `spend|${s.budget.of}`,
          windowStartMs: snap.windowStartMs,
          windowMs: windowEnd(s.budget.per, snap.windowStartMs) - snap.windowStartMs,
          n: snap.n,
        })));
        for (const [s, snap] of sent) {
          // The window may have ROLLED during the await. The sent units still landed in the row
          // they belonged to (the snapshot's window), but the state now describes the NEW
          // window: writing the old window's total into it would falsely trip a fresh day with
          // yesterday's count and nothing would clear it until the next roll. Skip both halves —
          // the roll already reset the state this flush was accounting for.
          if (s.windowStartMs !== snap.windowStartMs) continue;
          const row = counts.find((c) => c.bucket === `spend|${s.budget.of}`);
          if (row === undefined) continue;
          s.global = row.count;
          s.local -= snap.n;
        }
      }
      if (idle.length > 0) {
        const counts = await store.read(idle.map((s) => ({ bucket: `spend|${s.budget.of}`, windowStartMs: idleWindows.get(s)! })));
        for (const s of idle) {
          if (s.windowStartMs !== idleWindows.get(s)) continue; // rolled mid-read: stale count, drop it
          const row = counts.find((c) => c.bucket === `spend|${s.budget.of}`);
          if (row !== undefined) s.global = row.count;
        }
      }
      // Reconcile: another isolate may have pushed a budget past its ceiling. Discovering that
      // here trips this isolate WITHOUT a transition event — the isolate that crossed the line
      // already rang the bell, and this one is only catching up to the truth.
      for (const s of p.states) {
        if (s.budget.max === "unbounded") continue;
        if (!s.tripped && s.global + s.local > s.budget.max) s.tripped = true;
      }
    } catch (e) {
      // Local units are KEPT (`s.local` untouched on the failed branch): the count is late,
      // never lost, and the last known verdict holds — the bounded-staleness posture.
      p.onError(e);
    }
  }

  for (const t of transitions) {
    const feed = RealtimeSeam.transport;
    if (feed !== null) {
      try {
        await feed.publish({
          channel: SPEND_CHANNEL,
          ownerId: null,
          payload: { kind: t.kind, budget: t.budget.of, per: t.budget.per, max: t.budget.max, count: t.count, windowStartMs: t.windowStartMs },
        });
      } catch (e) {
        p.onError(e);
      }
    }
    if (env !== undefined && (t.kind === "spend.tripped" || t.kind === "spend.recovered")) {
      await ringBeacon(t, env, p.onError);
    }
  }
}

/**
 * Flush when due (the cadence) or when a transition is waiting (a trip must not sit in memory
 * for the flush interval — the event and the doorbell are the notification duty). Returns the
 * in-flight promise so a platform can `waitUntil` it, or null when nothing needed doing.
 * Coalesced: a flush already in flight is the answer, never a second concurrent one.
 */
export function flushSpendIfDue(env?: (key: string) => string | undefined): Promise<void> | null {
  const p = plane;
  if (p === null) return null;
  const urgent = p.pending.length > 0;
  if (p.flushing !== null) {
    // A transition that arrived WHILE a flush is in flight was not in that flush's snapshot, so
    // handing back the in-flight promise would let the caller's waitUntil resolve with the trip's
    // event and doorbell still sitting in memory — and on Workers the isolate is free to die
    // right after the burst that caused the trip, which is exactly the fail-mute loss the plane
    // exists to prevent. Chain a follow-up flush behind the running one instead: still
    // serialized, never concurrent, and the returned promise now covers the transition.
    if (!urgent) return p.flushing;
    const follow = p.flushing.then(() => flushNow(env)).finally(() => {
      if (plane === p && p.flushing === follow) p.flushing = null;
    });
    p.flushing = follow;
    return follow;
  }
  const due = p.now() - p.lastFlushAt >= p.flushMs;
  const dirty = p.states.some((s) => s.local > 0);
  if (!urgent && !(due && dirty)) return null;
  const run = flushNow(env).finally(() => {
    if (plane === p) p.flushing = null;
  });
  p.flushing = run;
  return run;
}

/** Force a flush (tests, a platform's shutdown hook, and the scheduled tick).
 *
 *  SERIALIZED through the same `flushing` slot as `flushSpendIfDue`, for the same reason that
 *  slot exists: a forced flush that ran beside an in-flight one snapshotted the same `local`
 *  units, added them to the durable counter twice, and left `local` negative - every other
 *  isolate then reconciled against the inflated global and tripped early. The Workers scheduled
 *  tick calls this in production, so the bypass was not a test-only hazard. */
export function flushSpendNow(env?: (key: string) => string | undefined): Promise<void> {
  const p = plane;
  if (p === null) return flushNow(env);
  if (p.flushing !== null) {
    const follow = p.flushing.then(() => flushNow(env)).finally(() => {
      if (plane === p && p.flushing === follow) p.flushing = null;
    });
    p.flushing = follow;
    return follow;
  }
  const run = flushNow(env).finally(() => {
    if (plane === p) p.flushing = null;
  });
  p.flushing = run;
  return run;
}
