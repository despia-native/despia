//
//  lifecycle-conformance.test.ts — the SCREEN-LIFECYCLE corpus runner (TS lane).
//
//  Executes BOTH halves of OpenSource/Conformance/lifecycle/ against this renderer's real
//  implementation — the same two files the Kotlin `ScreenReadinessTest` and the Swift
//  `ConformanceHosts` record lane run:
//
//    • readiness.json → `ScreenReadiness`, the per-frame NATIVE reporter behind
//      `viewStart` / `viewFinish` (auto settle-on-first-render, the `settle="manual"`
//      opt-in, the `<DSXWebView/>` hosted-surface gate, the bounded settle deadline,
//      release/re-mount, once-per-frame).
//    • phase.json → `installScreenPhase()`, the stateless COORDINATOR that translates
//      `dom*` (web) and `view*` (native) into the ONE `screen.loading` / `screen.ready`
//      vocabulary + `global.screen.phase` / `.ready`.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { ModuleRegistry } from "../src/bus.ts";
import { DSXState } from "../src/store.ts";
import { ScreenReadiness, installScreenPhase, SETTLE_DEADLINE_MS } from "../src/screen.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname);
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/lifecycle");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`OpenSource/Conformance/lifecycle not found from ${import.meta.dirname}`);
    dir = parent;
  }
}

type Json = { [k: string]: unknown };
function corpus(name: string): Json {
  const doc = JSON.parse(readFileSync(join(corpusDir(), name), "utf8")) as Json;
  assert.equal(doc["version"], 1, `${name}: unsupported version`);
  return doc;
}

// ── readiness.json — the per-frame reporter ─────────────────────────────────────────────

test("native screen readiness matches the shared conformance corpus", () => {
  const doc = corpus("readiness.json");
  const cases = doc["cases"] as Json[];
  assert.ok(cases.length > 0, "readiness.json has no cases");

  // The deadline is armed BY THE MACHINE at mount (that is what makes it un-forgettable), so
  // the corpus drives the `deadline` step directly against a stubbed clock. `armed` also proves
  // every mount arms exactly one timer at the pinned delay and that a settle cancels it.
  let armed: number[] = [];
  let cancelled = 0;
  const restore = ScreenReadiness.scheduleDeadline;
  ScreenReadiness.scheduleDeadline = (ms, _fire) => {
    armed.push(ms);
    return () => { cancelled += 1 };
  };

  try {
    const fired: Array<[string, number, string | null]> = [];
    const off = ModuleRegistry.registerDelegate("surface.viewStart", 0, (input) => {
      const d = input as Json;
      fired.push(["surface.viewStart", d["frame"] as number, (d["path"] as string | null) ?? null]);
      return null;
    });
    const off2 = ModuleRegistry.registerDelegate("surface.viewFinish", 0, (input) => {
      const d = input as Json;
      fired.push(["surface.viewFinish", d["frame"] as number, (d["path"] as string | null) ?? null]);
      return null;
    });

    try {
      for (const row of cases) {
        const name = row["name"] as string;
        ScreenReadiness.reset();
        fired.length = 0;
        armed = [];
        cancelled = 0;

        for (const raw of row["steps"] as Json[]) {
          const step = raw["do"] as string;
          const frame = raw["frame"] as number;
          switch (step) {
            case "mount":
              ScreenReadiness.mount(frame, (raw["path"] as string | undefined) ?? null,
                                    raw["surface"] as string);
              break;
            case "manual":     ScreenReadiness.manual(frame); break;
            case "hostsWeb":   ScreenReadiness.hostsWeb(frame); break;
            case "rendered":   ScreenReadiness.rendered(frame); break;
            case "settled":    ScreenReadiness.settled(frame); break;
            case "deadline":   ScreenReadiness.deadline(frame); break;
            case "release":    ScreenReadiness.release(frame); break;
            case "webStart":   ScreenReadiness.webStart(); break;
            case "webSettled": ScreenReadiness.webSettled(); break;
            default: throw new Error(`readiness/${name}: unknown step ${step}`);
          }
        }

        const expect = (row["expect"] as Json[]).map((e): [string, number, string | null] =>
          [e["event"] as string, e["frame"] as number, (e["path"] as string | undefined) ?? null]);
        assert.deepEqual(fired, expect, name);
        assert.deepEqual(ScreenReadiness.pending(),
                         (row["expectPending"] as number[] | undefined) ?? [], `${name} (pending)`);
        // one armed deadline per tracked frame INSTANCE (1:1 with `viewStart`), at the pinned delay
        const starts = fired.filter(([event]) => event === "surface.viewStart").length;
        assert.deepEqual(armed, new Array<number>(starts).fill(SETTLE_DEADLINE_MS),
                         `${name} (deadlines armed)`);
      }
    } finally {
      off();
      off2();
    }
  } finally {
    ScreenReadiness.reset();
    ScreenReadiness.scheduleDeadline = restore;
  }
});

test("the bounded settle deadline is the corpus value and fires the settle itself", () => {
  assert.equal(SETTLE_DEADLINE_MS, corpus("readiness.json")["settleDeadlineMs"],
               "SETTLE_DEADLINE_MS drifted from readiness.json");

  const restore = ScreenReadiness.scheduleDeadline;
  let elapse: (() => void) | null = null;
  let cancelled = 0;
  ScreenReadiness.scheduleDeadline = (_ms, fire) => {
    elapse = fire;
    return () => { cancelled += 1 };
  };
  const fired: string[] = [];
  const off = ModuleRegistry.registerDelegate("surface.viewFinish", 0, () => { fired.push("surface.viewFinish"); return null });
  try {
    ScreenReadiness.reset();
    // a manual screen that never reports: the armed timer is what settles it
    ScreenReadiness.mount(1, "/orders", "native");
    ScreenReadiness.manual(1);
    ScreenReadiness.rendered(1);
    assert.deepEqual(fired, [], "a manual screen must not settle on render");
    assert.ok(elapse !== null, "mount must arm the bounded deadline");
    (elapse as unknown as () => void)();
    assert.deepEqual(fired, ["surface.viewFinish"], "the elapsed deadline must settle the frame");
    assert.deepEqual(ScreenReadiness.pending(), []);

    // a frame that settles normally cancels its timer instead of leaking it
    fired.length = 0;
    cancelled = 0;
    ScreenReadiness.reset();
    ScreenReadiness.mount(2, "/", "native");
    ScreenReadiness.rendered(2);
    assert.equal(cancelled, 1, "a settled frame must cancel its deadline");
    ScreenReadiness.reset();
    ScreenReadiness.mount(3, "/", "native");
    ScreenReadiness.release(3);
    assert.equal(cancelled, 2, "a released frame must cancel its deadline");
  } finally {
    off();
    ScreenReadiness.reset();
    ScreenReadiness.scheduleDeadline = restore;
  }
});

// ── phase.json — the stateless coordinator ──────────────────────────────────────────────

test("surface → unified screen.* translation matches the shared conformance corpus", () => {
  const doc = corpus("phase.json");
  const cases = doc["cases"] as Json[];
  assert.ok(cases.length > 0, "phase.json has no cases");

  const uninstall = installScreenPhase();
  const fires: Array<[string, unknown]> = [];
  const off = [
    ModuleRegistry.registerDelegate("screen.loading", 0, (input) => { fires.push(["screen.loading", input]); return null }),
    ModuleRegistry.registerDelegate("screen.ready", 0, (input) => { fires.push(["screen.ready", input]); return null }),
  ];
  try {
    for (const row of cases) {
      const name = row["name"] as string;
      fires.length = 0;
      const seed = (row["seedState"] as Json | undefined)?.["screen"];
      DSXState.set("screen", seed ?? {});

      for (const step of row["steps"] as Json[]) {
        ModuleRegistry.foldDelegate(step["fire"] as string, step["input"], "void");
      }

      const expect = (row["expect"] as Json[]).map((e): [string, unknown] =>
        [e["fire"] as string, e["input"] ?? null]);
      assert.deepEqual(fires.map(([n, i]) => [n, i ?? null]), expect, name);

      for (const [key, want] of Object.entries((row["expectState"] as Json | undefined) ?? {})) {
        assert.deepEqual(DSXState.get(key) ?? null, want ?? null, `${name} (${key})`);
      }
    }
  } finally {
    for (const drop of off) drop();
    uninstall();
    DSXState.set("screen", {});
  }
});
