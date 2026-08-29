//
//  snackbar-conformance.test.ts — the snackbar corpus runner (TS lane).
//  Executes OpenSource/Conformance/overlays/snackbar.json against src/snackbar.ts; the
//  Kotlin (:core SnackbarConformanceTest) and Swift (SnackbarConformance) twins run the
//  SAME file.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import {
  resolveDuration,
  resolveLift,
  resolveEdge,
  snackbarApply,
  snackbarInitial,
  snackbarPending,
  normalizeRequest,
  SNACKBAR_GAP,
  SNACKBAR_MIN_MS,
  type SnackbarOp,
  type SnackbarState,
} from "../src/snackbar.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/overlays/snackbar.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/overlays/snackbar.json not found");
    dir = parent;
  }
}

interface DurationCase {
  name: string;
  duration: string | number | null;
  hasAction?: boolean;
  expect: number;
}

interface QueueCase {
  name: string;
  ops: Array<Record<string, unknown>>;
  expect: { current: string | null; pending: string[]; settled: Array<{ id: string; result: string }> };
}

interface LiftCase {
  name: string;
  lift: {
    position: string;
    safeAreaTop: number;
    safeAreaBottom: number;
    bottomBar: number;
    fab: number;
    keyboard: number;
  };
  expect: { edge: string; inset: number; clearsHomeIndicator: boolean };
}

const corpus = JSON.parse(readFileSync(corpusFile(), "utf8")) as {
  durationCases: DurationCase[];
  queueCases: QueueCase[];
  liftCases: LiftCase[];
};

test("snackbar duration corpus", () => {
  assert.ok(corpus.durationCases.length > 0, "durationCases is empty");
  for (const c of corpus.durationCases) {
    assert.equal(resolveDuration(c.duration, c.hasAction === true), c.expect, c.name);
  }
});

test("snackbar queue corpus", () => {
  assert.ok(corpus.queueCases.length > 0, "queueCases is empty");
  for (const c of corpus.queueCases) {
    let state: SnackbarState = snackbarInitial();
    for (const raw of c.ops) {
      // The corpus omits `message` where it does not matter; the reducer treats an empty
      // message as a no-op, so the runner supplies the id as the text unless a case is
      // deliberately testing emptiness.
      const op = { message: raw.message === undefined ? String(raw.id ?? "x") : raw.message, ...raw } as SnackbarOp;
      state = snackbarApply(state, op);
    }
    assert.equal(state.current === null ? null : state.current.id, c.expect.current, `${c.name} — current`);
    assert.deepEqual(state.queue.map((e) => e.id), c.expect.pending, `${c.name} — pending`);
    assert.deepEqual(state.settled, c.expect.settled, `${c.name} — settled`);
    assert.equal(snackbarPending(state), c.expect.pending.length, `${c.name} — pending count`);
  }
});

test("snackbar lift corpus", () => {
  assert.ok(corpus.liftCases.length > 0, "liftCases is empty");
  for (const c of corpus.liftCases) {
    assert.deepEqual(resolveLift(c.lift), c.expect, c.name);
  }
});

test("duration parsing is total — no input throws, everything unknown is the default", () => {
  for (const junk of [undefined, null, "", "   ", "soon", "NaN", {}, [], true]) {
    assert.equal(resolveDuration(junk as never), 2000, String(junk));
    assert.equal(resolveDuration(junk as never, true), 4000, String(junk));
  }
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(resolveDuration(bad), 2000, String(bad));
  }
  assert.equal(resolveDuration(-1_000_000), SNACKBAR_MIN_MS);
});

test("the edge word is total and defaults to bottom", () => {
  assert.equal(resolveEdge("top"), "top");
  assert.equal(resolveEdge(" TOP "), "top");
  for (const junk of [null, undefined, "", "bottom", "middle", "TOPMOST"]) {
    if (junk === "top") continue;
    assert.equal(resolveEdge(junk as string), junk === "top" ? "top" : "bottom", String(junk));
  }
});

test("the card never covers the home indicator, whatever geometry arrives", () => {
  const values = [-10_000, -1, 0, 12, 34, 400, 10_000, Number.NaN, Number.POSITIVE_INFINITY];
  for (const safeAreaBottom of values) {
    for (const keyboard of values) {
      for (const bottomBar of [0, 49, -49]) {
        const lift = resolveLift({
          position: "bottom",
          safeAreaTop: 47,
          safeAreaBottom,
          bottomBar,
          fab: 0,
          keyboard,
        });
        const safe = Number.isFinite(safeAreaBottom) && safeAreaBottom > 0 ? safeAreaBottom : 0;
        assert.ok(lift.inset >= safe + SNACKBAR_GAP, `inset ${lift.inset} sits on the home indicator`);
        assert.ok(lift.clearsHomeIndicator, "clearsHomeIndicator went false");
      }
    }
  }
});

test("one at a time: N shows leave N-1 waiting and drain in order", () => {
  let state = snackbarInitial();
  const ids = ["a", "b", "c", "d", "e"];
  for (const id of ids) state = snackbarApply(state, { op: "show", id, message: id });
  assert.equal(state.current?.id, "a");
  assert.equal(snackbarPending(state), 4);
  const seen: string[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    seen.push(state.current?.id ?? "");
    state = snackbarApply(state, { op: "elapse" });
  }
  assert.deepEqual(seen, ids);
  assert.equal(state.current, null);
  assert.deepEqual(state.settled.map((s) => s.result), ids.map(() => "timeout"));
});

test("every card settles exactly once, whatever order the endings arrive in", () => {
  let state = snackbarInitial();
  state = snackbarApply(state, { op: "show", id: "a", message: "a", action: { label: "Undo", id: "u" } });
  state = snackbarApply(state, { op: "show", id: "b", message: "b" });
  for (const op of ["action", "action", "dismiss", "elapse", "hide"] as const) {
    state = snackbarApply(state, { op } as SnackbarOp);
  }
  const counts = new Map<string, number>();
  for (const s of state.settled) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
  assert.deepEqual([...counts.entries()].sort(), [["a", 1], ["b", 1]]);
});

test("an action button with no label is not an action button", () => {
  const entry = normalizeRequest({ id: "a", message: "m", action: { label: "", id: "u" } });
  assert.equal(entry.action, null);
  assert.equal(entry.durationMs, 2000, "no action means the wordless default stays 2s");
});
