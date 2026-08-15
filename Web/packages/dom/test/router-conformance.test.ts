//
//  router-conformance.test.ts — the SHARED root-plan corpus
//  (OpenSource/Conformance/router/root-plan.json) through the REAL web fold
//  (RootPlanFold in ../src/root-plan.ts). The corpus `_note` is the contract; this
//  harness implements its deterministic virtual-clock simulation: attempt 0 mounts
//  at t=0, attempt N+1 at the instant N fails, deadline = mountAt + timeoutMs, a
//  live attempt whose deadline ≤ the next event's atMs times out FIRST, and after
//  the last event a still-live attempt times out at its deadline. Kotlin
//  (RootPlanConformanceTest) and Swift (RootPlanConformance, the reference) drive
//  the SAME file. boot.json's two-arm cases never ran on TS (no origin-less web
//  boot) — this corpus is the web runner's first router-boot gate.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { normalizePlan, RootPlanFold, type Attempt, type FoldHost, type NormalizedCandidate } from "../src/root-plan.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/router/root-plan.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("root-plan corpus not found");
    dir = parent;
  }
}

type CorpusEvent = { atMs: number; kind: "settle" | "error"; origin?: string; code?: string; attempt?: number };
type Case = {
  name: string;
  components: string[];
  surfaces: unknown;
  events: CorpusEvent[];
  expect: {
    normalized: NormalizedCandidate[];
    attempts: string[];
    failures: { id: string; code: string }[];
    ready: string | null;
    fired: string[];
    diagnostic: boolean;
    winnerView?: string;
    mountedAttrs?: Record<string, Record<string, unknown>>;
  };
};

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as { cases: Case[] };
assert.ok(doc.cases.length > 0, "root-plan corpus is empty");

type Timer = { at: number; fire: () => void; cancelled: boolean };

for (const c of doc.cases) {
  test(`root-plan/${c.name}`, () => {
    let now = 0;
    const timers: Timer[] = [];
    const fired: string[] = [];
    const payloads: Record<string, unknown>[] = [];
    const mountedAttrs: Record<string, Record<string, unknown>> = {};
    let sawDiagnostic = false;

    const host: FoldHost = {
      mount(cand) { if (cand.config) mountedAttrs[cand.id] = cand.config; else mountedAttrs[cand.id] = mountedAttrs[cand.id] ?? {}; },
      now: () => now,
      setTimer(ms, fire) {
        const t: Timer = { at: now + ms, fire, cancelled: false };
        timers.push(t);
        return () => { t.cancelled = true; };
      },
      send(event, payload) { fired.push(event); payloads.push({ event, ...payload }); },
      registered: (view) => c.components.includes(view),
      diagnostic() { sawDiagnostic = true; },
    };

    const plan = normalizePlan(c.surfaces);
    assert.deepEqual(plan, c.expect.normalized, "normalized plan");

    const fold = new RootPlanFold(plan, host, "web");
    fold.start();

    const nextTimer = (): Timer | null => {
      const live = timers.filter((t) => !t.cancelled).sort((a, b) => a.at - b.at);
      return live[0] ?? null;
    };
    const runTimersThrough = (limit: number): void => {
      for (;;) {
        const t = nextTimer();
        if (!t || t.at > limit) return;
        now = t.at;
        t.cancelled = true;
        t.fire();
      }
    };

    for (const e of [...c.events].sort((a, b) => a.atMs - b.atMs)) {
      runTimersThrough(e.atMs);   // a deadline ≤ the event's atMs fires FIRST
      now = Math.max(now, e.atMs);
      if (e.kind === "settle") fold.settle(e.attempt);
      else fold.rootError(e.code ?? "error", e.origin ?? "root", e.attempt);
    }
    runTimersThrough(Number.MAX_SAFE_INTEGER);   // the fold always terminates

    const attempts = payloads
      .filter((p) => p.event === "root.failed" || p.event === "root.ready")
      .map((p) => p.id as string);
    const failures = payloads
      .filter((p) => p.event === "root.failed")
      .map((p) => ({ id: p.id as string, code: (p.error as { code: string }).code }));
    const ready = (payloads.find((p) => p.event === "root.ready")?.id as string | undefined) ?? null;

    assert.deepEqual(attempts, c.expect.attempts, "attempt order");
    assert.deepEqual(failures, c.expect.failures, "failures");
    assert.equal(ready, c.expect.ready, "ready");
    assert.deepEqual(fired, c.expect.fired, "fired order");
    assert.equal(sawDiagnostic, c.expect.diagnostic, "diagnostic");
    if (c.expect.winnerView !== undefined) assert.equal(fold.winner?.view, c.expect.winnerView, "winnerView");
    if (c.expect.mountedAttrs !== undefined) {
      for (const [id, attrs] of Object.entries(c.expect.mountedAttrs)) {
        assert.deepEqual(mountedAttrs[id], attrs, `mountedAttrs[${id}]`);
      }
    }
    const ledgerIds = fold.ledger.map((a: Attempt) => a.id);
    assert.deepEqual(ledgerIds, c.expect.failures.map((f) => f.id), "ledger mirrors failures");
  });
}
