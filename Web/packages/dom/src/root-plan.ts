//
//  root-plan.ts — `App.json entry.surfaces` (the ROOT PLAN) normalization for the web
//  runtime. The fold itself lives in boot.ts; this module is the pure grammar half.
//  Normalization MUST stay byte-identical to Conformance/router/root-plan.json
//  `expect.normalized`, scripts/root_plan_schema.rb, and the two native AppManifests —
//  the corpus pins all four. Malformed rows are a BUILD abort (root_plan_schema.rb
//  V-rules); runtime parsing fail-opens by skipping them.
//

export type PlanScalar = string | number | boolean;

export type PlanCandidate = {
  view: string;
  id?: string;
  timeoutMs?: number;
  config?: Record<string, PlanScalar>;
};

export type NormalizedCandidate = {
  view: string;
  id: string;
  timeoutMs: number;
  config?: Record<string, PlanScalar>;
};

/** The settle deadline a candidate gets when `timeoutMs` is omitted — identical on
 *  every runtime, pinned by the root-plan corpus. */
export const ROOT_SETTLE_TIMEOUT_MS = 15000;

const clean = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};

// ─── the fold ────────────────────────────────────────────────────────────────
// The first-ready fold over the normalized plan (root-plan.md §fold; corpus
// Conformance/router/root-plan.json — its `_note` is the contract). The class is
// the PRODUCTION engine; `FoldHost` is the seam that lets the conformance runner
// drive it on a virtual clock while bootDsx wires the real router/bus/timers.

export type Attempt = { index: number; id: string; view: string; code: string; elapsedMs: number };

export type FoldHost = {
  /** swap frame-0 content to this candidate (config = component attributes, verbatim) */
  mount(c: NormalizedCandidate, index: number): void;
  now(): number;
  /** schedule `fire` in `ms`; returns cancel */
  setTimer(ms: number, fire: () => void): () => void;
  /** bus emission — root.ready / root.failed / root.exhausted, Article-8 names */
  /** Announce a root-plan milestone. 0..N may care, so it is a `void` fold — never a
   *  claim, which would let the FIRST listener settle it and starve the rest. */
  send(event: string, payload: Record<string, unknown>): void;
  /** component-registry membership (an absent tag fails as root.component_missing) */
  registered(view: string): boolean;
  /** the kernel boot diagnostic (NOT a component) — shown on exhaustion */
  diagnostic(ledger: Attempt[]): void;
};

export class RootPlanFold {
  readonly plan: NormalizedCandidate[];
  readonly ledger: Attempt[] = [];
  winner: NormalizedCandidate | null = null;
  private live = -1;             // the live attempt index — the stale-signal token
  private startedAt = 0;
  private cancelTimer: (() => void) | null = null;
  private done = false;

  private host: FoldHost;
  private target: string;

  constructor(plan: NormalizedCandidate[], host: FoldHost, target = "web") {
    this.plan = plan;
    this.host = host;
    this.target = target;
  }

  start(): void { this.attempt(0); }

  /** Tear the fold down (a retry or a host teardown replacing it): cancel the pending
   *  attempt timer and close the selector so late timers/signals are inert. Idempotent.
   *  The twin of `RootPlan.Fold.close()` on both natives — the web's own retry is a page
   *  reload, but an embedder that re-boots in-process must be able to silence the old fold. */
  close(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.done = true;
    this.live = -1;
  }

  /** Is an attempt LIVE — the plan still racing, neither crowned nor exhausted? The natives'
   *  level-observing sinks need it to tell "the fold refused my signal" from "the fold is
   *  finished"; the web settles off the `screen.ready` EDGE, so nothing here reads it yet —
   *  it exists so the three folds expose one surface (root-plan.md §engine). */
  get active(): boolean { return !this.done && this.live >= 0; }

  /** frame-0 settle. `attemptIndex` binds the signal to one attempt (stale → dropped). */
  settle(attemptIndex?: number): void {
    if (this.done || this.live < 0) return;
    if (attemptIndex !== undefined && attemptIndex !== this.live) return;
    const c = this.plan[this.live];
    this.cancelTimer?.();
    this.done = true;
    this.winner = c;
    this.host.send("root.ready", {
      id: c.id, view: c.view, index: this.live, target: this.target,
      elapsedMs: this.host.now() - this.startedAt,
    });
  }

  /** a dsx.error reaching the fold. Only origin "root" during a live attempt advances. */
  rootError(code: string, origin: string, attemptIndex?: number): void {
    if (this.done || this.live < 0) return;
    if (attemptIndex !== undefined && attemptIndex !== this.live) return;
    if (origin !== "root") return;
    this.fail(code);
  }

  private attempt(i: number): void {
    this.live = i;
    if (i >= this.plan.length) {
      this.live = -1;
      this.done = true;
      this.host.send("root.exhausted", {
        target: this.target,
        attempts: this.ledger.map((a) => ({ ...a })),
      });
      this.host.diagnostic(this.ledger);
      return;
    }
    const c = this.plan[i];
    this.startedAt = this.host.now();
    if (!this.host.registered(c.view)) {
      this.fail("root.component_missing");
      return;
    }
    this.host.mount(c, i);
    // `mount` can drive the fold SYNCHRONOUSLY (the `screen.ready` hook fires inside
    // `router.start`; a state sink can error inline). If it did, that later attempt already
    // armed its own deadline and owns it: arming here would overwrite its canceller,
    // orphaning it, and leave a zombie timer for a DEAD candidate to fire against whoever
    // is live.
    if (this.done || this.live !== i) return;
    this.cancelTimer = this.host.setTimer(c.timeoutMs, () => this.fail("root.timeout", i));
  }

  private fail(code: string, attemptIndex?: number): void {
    if (this.done || this.live < 0) return;   // a timer that slipped past its canceller is inert (first terminal wins)
    if (attemptIndex !== undefined && attemptIndex !== this.live) return;   // a deadline from a previous attempt never kills the live one
    const i = this.live;
    const c = this.plan[i];
    this.cancelTimer?.();
    this.cancelTimer = null;
    const elapsedMs = this.host.now() - this.startedAt;
    this.ledger.push({ index: i, id: c.id, view: c.view, code, elapsedMs });
    // Close the attempt BEFORE the fire: a hook on root.failed — or any state write it makes —
    // can re-enter the fold synchronously, and with the token still live that re-entry would
    // settle the candidate that just failed, crowning a corpse.
    this.live = -1;
    this.host.send("root.failed", {
      id: c.id, view: c.view, index: i, target: this.target, elapsedMs,
      error: { code, recoverable: true },
    });
    this.attempt(i + 1);   // failure ALWAYS advances — there is no policy key
  }
}

/** Raw `entry.surfaces` (strings and/or objects) → the normalized ordered plan.
 *  Shorthand `"X"` ≡ `{view:"X"}`; timeoutMs defaults to ROOT_SETTLE_TIMEOUT_MS; a
 *  derived id is the view name, numbered `view#k` (1-based occurrence among ALL
 *  candidates of that view) when the view repeats; explicit ids ride verbatim. */
export function normalizePlan(raw: unknown): NormalizedCandidate[] {
  if (!Array.isArray(raw)) return [];
  type Cand = { view: string; id: string | null; timeoutMs: number | null; config: Record<string, PlanScalar> };
  const cands: Cand[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const v = clean(item);
      if (v) cands.push({ view: v, id: null, timeoutMs: null, config: {} });
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      const v = clean(o.view);
      if (!v) continue;
      const t = typeof o.timeoutMs === "number" && Number.isInteger(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : null;
      const config = o.config && typeof o.config === "object" && !Array.isArray(o.config)
        ? (o.config as Record<string, PlanScalar>)
        : {};
      cands.push({ view: v, id: clean(o.id), timeoutMs: t, config });
    }
  }
  const counts = new Map<string, number>();
  for (const c of cands) counts.set(c.view, (counts.get(c.view) ?? 0) + 1);
  const seen = new Map<string, number>();
  return cands.map((c) => {
    const k = (seen.get(c.view) ?? 0) + 1;
    seen.set(c.view, k);
    const id = c.id ?? ((counts.get(c.view) ?? 0) > 1 ? `${c.view}#${k}` : c.view);
    const out: NormalizedCandidate = { view: c.view, id, timeoutMs: c.timeoutMs ?? ROOT_SETTLE_TIMEOUT_MS };
    if (Object.keys(c.config).length) out.config = c.config;
    return out;
  });
}
