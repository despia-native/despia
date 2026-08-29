//
//  scroll-conformance.test.ts — the <scroll> corpus runner (TS lane).
//  Executes every file in OpenSource/Conformance/scroll/ against packages/kernel/src/scroll.ts;
//  the Kotlin (:core ScrollLinkedConformanceTest) and Swift (ScrollLinked, record lane) twins
//  run the SAME files.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import {
  scrollMetrics,
  scrollMotion,
  coalesceScroll,
  shouldDispatchScroll,
  reachEndState,
  resolveScrollCommand,
  resolveSnap,
  maintainPositionOffset,
  scrollLinkedProperties,
  namedScrollProperties,
  resolveLinkedScope,
  evaluateScrollLinked,
  collapseState,
  shouldEmitCollapse,
  parseScrollConfig,
  formatNumber,
  round4,
  SCROLL_EPSILON,
  FRAME_BUDGET_MS,
  FLING_VELOCITY,
  TITLE_HANDOFF_FRACTION,
  type ScrollAxis,
  type ScrollDirection,
  type ScrollCommand,
  type SnapMode,
  type ChildFrame,
  type LinkedAncestor,
  type NamedScrollPlane,
  type ScrollProperties,
  type CollapseInput,
} from "../src/scroll.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/scroll");
    if (existsSync(join(candidate, "metrics.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/scroll not found");
    dir = parent;
  }
}

const DIR = corpusDir();

function load(file: string): { cases: Record<string, unknown>[] } {
  const doc = JSON.parse(readFileSync(join(DIR, file), "utf8")) as { cases: Record<string, unknown>[] };
  assert.ok(Array.isArray(doc.cases) && doc.cases.length > 0, `${file}: corpus is empty`);
  return doc;
}

const name = (c: Record<string, unknown>): string => String(c["name"] ?? "(unnamed)");

test("metrics corpus", () => {
  for (const c of load("metrics.json").cases) {
    const got = scrollMetrics(c["geometry"] as Record<string, number>);
    assert.deepEqual(got, c["expect"], name(c));
  }
});

test("events corpus — motion, coalescing and the reachEnd latch", () => {
  let motion = 0;
  let coalesce = 0;
  let reach = 0;
  for (const c of load("events.json").cases) {
    if (c["previous"] !== undefined) {
      motion += 1;
      const got = scrollMotion(
        c["previous"] as { x: number; y: number; t: number },
        c["next"] as { x: number; y: number; t: number },
        (c["previousDirection"] ?? null) as ScrollDirection | null,
      );
      assert.deepEqual(got, c["expect"], name(c));
    } else if (c["samples"] !== undefined) {
      coalesce += 1;
      const got = coalesceScroll(
        c["samples"] as number[],
        c["hasHandler"] as boolean,
        c["frameBudgetMs"] as number,
      );
      assert.deepEqual(got, c["expect"], name(c));
    } else {
      reach += 1;
      const metrics = scrollMetrics(c["geometry"] as Record<string, number>);
      const got = reachEndState(
        c["latched"] as boolean,
        metrics,
        c["threshold"] as number,
        c["axis"] as ScrollAxis,
      );
      assert.deepEqual(got, c["expect"], name(c));
    }
  }
  assert.ok(motion > 0 && coalesce > 0 && reach > 0, "events.json lost one of its three groups");
});

test("imperative corpus", () => {
  for (const c of load("imperative.json").cases) {
    const got = resolveScrollCommand(
      c["command"] as ScrollCommand,
      c["geometry"] as Record<string, number>,
      c["axis"] as ScrollAxis,
    );
    assert.deepEqual(got, c["expect"] ?? null, name(c));
  }
});

test("snap corpus — snap points and maintainPosition", () => {
  let snaps = 0;
  let maintains = 0;
  for (const c of load("snap.json").cases) {
    if (c["mode"] !== undefined) {
      snaps += 1;
      const got = resolveSnap(
        c["mode"] as SnapMode,
        c["offset"] as number,
        c["viewportLength"] as number,
        c["contentLength"] as number,
        c["children"] as ChildFrame[],
        c["velocity"] as number,
      );
      assert.deepEqual(got, c["expect"] ?? null, name(c));
    } else {
      maintains += 1;
      const got = maintainPositionOffset(
        c["offset"] as number,
        c["anchorBefore"] as number,
        c["anchorAfter"] as number,
        c["viewportLength"] as number,
        c["contentLength"] as number,
      );
      assert.deepEqual(got, c["expect"], name(c));
    }
  }
  assert.ok(snaps > 0 && maintains > 0, "snap.json lost one of its two groups");
});

test("linked corpus — publication, per-axis scope, and the calc evaluator", () => {
  let published = 0;
  let namedPublished = 0;
  let scopes = 0;
  let evaluated = 0;
  for (const c of load("linked.json").cases) {
    if (c["ref"] !== undefined) {
      namedPublished += 1;
      const metrics = scrollMetrics(c["geometry"] as Record<string, number>);
      const got = namedScrollProperties(
        c["ref"] as string,
        c["axis"] as ScrollAxis,
        metrics,
        c["velocity"] as number,
      );
      assert.deepEqual(got, c["expect"], name(c));
    } else if (c["geometry"] !== undefined) {
      published += 1;
      const metrics = scrollMetrics(c["geometry"] as Record<string, number>);
      const got = scrollLinkedProperties(c["axis"] as ScrollAxis, metrics, c["velocity"] as number);
      assert.deepEqual(got, c["expect"], name(c));
    } else if (c["ancestors"] !== undefined) {
      scopes += 1;
      assert.deepEqual(
        resolveLinkedScope(
          c["ancestors"] as LinkedAncestor[],
          (c["named"] ?? []) as NamedScrollPlane[],
        ),
        c["expect"],
        name(c),
      );
    } else {
      evaluated += 1;
      const got = evaluateScrollLinked(
        c["expression"] as string,
        c["properties"] as ScrollProperties,
      );
      assert.equal(got, (c["expect"] ?? null) as string | null, name(c));
    }
  }
  assert.ok(
    published > 0 && namedPublished > 0 && scopes > 0 && evaluated > 0,
    "linked.json lost one of its four groups",
  );
});

test("collapse corpus — <CollapsingHeader>", () => {
  let states = 0;
  let emits = 0;
  for (const c of load("collapse.json").cases) {
    if (c["input"] !== undefined) {
      states += 1;
      assert.deepEqual(collapseState(c["input"] as CollapseInput), c["expect"], name(c));
    } else {
      emits += 1;
      const got = shouldEmitCollapse(
        (c["previousFraction"] ?? null) as number | null,
        c["fraction"] as number,
      );
      assert.deepEqual({ emit: got }, c["expect"], name(c));
    }
  }
  assert.ok(states > 0 && emits > 0, "collapse.json lost one of its two groups");
});

test("config corpus — the attribute table folded", () => {
  for (const c of load("config.json").cases) {
    const got = parseScrollConfig(c["attributes"] as Record<string, string>);
    assert.deepEqual(got, c["expect"], name(c));
  }
});

// ---------------------------------------------------------------- properties the corpus cannot state

test("no handler bound means ZERO dispatches, whatever the platform reports", () => {
  const train = Array.from({ length: 600 }, (_, i) => i * 4);
  assert.equal(coalesceScroll(train, false).dispatches, 0);
  assert.equal(coalesceScroll(train, false, 0).dispatches, 0);
  for (const t of train) assert.equal(shouldDispatchScroll(false, null, t), false);
});

test("coalescing never exceeds one dispatch per budget over any train", () => {
  for (const step of [1, 2, 4, 8, 8.333, 16, 33]) {
    const train = Array.from({ length: 400 }, (_, i) => i * step);
    const span = train[train.length - 1]! - train[0]!;
    const got = coalesceScroll(train, true).dispatches;
    assert.ok(got <= Math.floor(span / FRAME_BUDGET_MS) + 1, `step ${step} dispatched ${got}`);
  }
});

test("metrics are total — no geometry throws and progress never leaves 0..1", () => {
  const wild = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1e9, 0, 1e9];
  for (const y of wild) {
    for (const contentHeight of wild) {
      for (const viewportHeight of [0, 800]) {
        const m = scrollMetrics({ x: 0, y, viewportWidth: 390, viewportHeight, contentWidth: 390, contentHeight });
        assert.ok(m.progress >= 0 && m.progress <= 1, `progress left the range for ${y}/${contentHeight}`);
        assert.ok(m.maxY >= 0, "maxY went negative");
        assert.ok(Number.isFinite(m.y) && Number.isFinite(m.progress), "a non-finite escaped");
      }
    }
  }
});

test("a page with nothing to scroll is at BOTH ends and rests at progress 0", () => {
  const m = scrollMetrics({ x: 0, y: 0, viewportWidth: 390, viewportHeight: 800, contentWidth: 390, contentHeight: 400 });
  assert.equal(m.atTop, true);
  assert.equal(m.atBottom, true);
  assert.equal(m.progress, 0, "a non-scrollable plane must publish the RESTING state");
});

test("reachEnd fires exactly once per crossing, however long you sit on the rail", () => {
  const geometry = { x: 0, y: 0, viewportWidth: 390, viewportHeight: 800, contentWidth: 390, contentHeight: 2000 };
  let latched = false;
  let fired = 0;
  for (const y of [0, 400, 900, 1200, 1200, 1200, 1199.9, 1200]) {
    const state = reachEndState(latched, scrollMetrics({ ...geometry, y }), 0);
    if (state.fire) fired += 1;
    latched = state.latched;
  }
  assert.equal(fired, 1, "a latched reachEnd is what stops the duplicate-page bug");
  // Leaving and returning is a NEW crossing, and must fire again.
  latched = reachEndState(latched, scrollMetrics({ ...geometry, y: 200 }), 0).latched;
  assert.equal(reachEndState(latched, scrollMetrics({ ...geometry, y: 1200 }), 0).fire, true);
});

test("direction is sticky under the tolerance, so a jitter cannot flicker a header", () => {
  let direction: ScrollDirection = "none";
  const start = { x: 0, y: 600, t: 0 };
  direction = scrollMotion(start, { x: 0, y: 700, t: 100 }, direction).direction;
  assert.equal(direction, "down");
  for (let i = 0; i < 20; i += 1) {
    const jitter = { x: 0, y: 700 + (i % 2 === 0 ? 0.25 : -0.25), t: 100 + i * 8 };
    direction = scrollMotion({ x: 0, y: 700, t: 100 + i * 8 }, jitter, direction).direction;
    assert.equal(direction, "down", `flipped on jitter ${i}`);
  }
});

test("an imperative target can never leave the scrollable range", () => {
  const geometry = { x: 0, y: 300, viewportWidth: 390, viewportHeight: 800, contentWidth: 390, contentHeight: 2000 };
  for (const y of [-1e9, -1, 0, 1200, 1201, 1e9, Number.NaN]) {
    const target = resolveScrollCommand({ kind: "to", y }, geometry);
    assert.ok(target !== null && target.y >= 0 && target.y <= 1200, `escaped for ${y}`);
  }
});

test("toElement refuses an unrealised row instead of guessing", () => {
  const geometry = { x: 0, y: 0, viewportWidth: 390, viewportHeight: 800, contentWidth: 390, contentHeight: 2000 };
  assert.equal(resolveScrollCommand({ kind: "toElement", align: "start" }, geometry), null);
  assert.equal(resolveScrollCommand({ kind: "toElement", align: "start", child: null }, geometry), null);
});

test("a fling always advances, a rest never fights the finger", () => {
  const kids: ChildFrame[] = [0, 320, 640, 960, 1280].map((start) => ({ start, length: 320 }));
  assert.equal(resolveSnap("start", 330, 390, 1920, kids, FLING_VELOCITY), 640);
  assert.equal(resolveSnap("start", 330, 390, 1920, kids, -FLING_VELOCITY), 320);
  assert.equal(resolveSnap("start", 320, 390, 1920, kids, -FLING_VELOCITY), 0);
  assert.equal(resolveSnap("start", 330, 390, 1920, kids, FLING_VELOCITY - 1), 320);
});

test("maintainPosition compensates a prepend by exactly the anchor's travel, and an append by nothing", () => {
  assert.equal(maintainPositionOffset(0, 0, 1600, 800, 3600).offset, 1600);
  assert.equal(maintainPositionOffset(420, 300, 300, 800, 3600).offset, 420);
  assert.ok(maintainPositionOffset(0, 0, 99999, 800, 1200).offset <= 400, "compensation escaped the range");
});

test("the vertical and horizontal planes never collide", () => {
  const vertical = scrollLinkedProperties("vertical", scrollMetrics({ x: 0, y: 600, viewportWidth: 390, viewportHeight: 800, contentWidth: 390, contentHeight: 2000 }), 100);
  const horizontal = scrollLinkedProperties("horizontal", scrollMetrics({ x: 240, y: 0, viewportWidth: 390, viewportHeight: 200, contentWidth: 1200, contentHeight: 200 }), 50);
  for (const key of Object.keys(vertical)) assert.ok(!(key in horizontal), `${key} is published by both planes`);
  const scope = resolveLinkedScope([{ axis: "horizontal", properties: horizontal }, { axis: "vertical", properties: vertical }]);
  assert.equal(scope["--scroll-y"], vertical["--scroll-y"]);
  assert.equal(scope["--scroll-x"], horizontal["--scroll-x"]);
});

test("an axis with no scroll ancestor publishes NOTHING, so a var() fallback can tell it apart", () => {
  const scope = resolveLinkedScope([]);
  assert.deepEqual(scope, {});
  assert.equal(evaluateScrollLinked("calc(var(--scroll-y, 0) + 1)", scope), "1");
  assert.equal(evaluateScrollLinked("calc(var(--scroll-y) + 1)", scope), null);
});

test("the evaluator drops what it cannot type rather than shipping a half-typed value", () => {
  const props: ScrollProperties = { "--scroll-y": "600", "--scroll-y-px": "600px" };
  for (const bad of [
    "calc(8px * 8px)",
    "calc(8px / 2px)",
    "calc(8px / 0)",
    "calc(8px + 2)",
    "calc(8px + 2rem)",
    "calc(var(--missing))",
    "calc(1 +)",
    "calc()",
    "calc(1 2)",
    "calc(red)",
  ]) {
    assert.equal(evaluateScrollLinked(bad, props), null, bad);
  }
});

test("number formatting agrees on the awkward values", () => {
  assert.equal(formatNumber(0), "0");
  assert.equal(formatNumber(-0), "0");
  assert.equal(formatNumber(-0.00001), "0", "a negative zero must never reach a stylesheet");
  assert.equal(formatNumber(1200), "1200");
  assert.equal(formatNumber(0.5), "0.5");
  assert.equal(formatNumber(1 / 3), "0.3333");
  assert.equal(formatNumber(-1 / 3), "-0.3333");
  assert.equal(formatNumber(2 / 3), "0.6667", "half away from zero, not half to even");
  assert.equal(formatNumber(Number.NaN), "0");
  assert.equal(formatNumber(Number.POSITIVE_INFINITY), "0");
  assert.equal(round4(0.00005), 0.0001);
  assert.equal(round4(-0.00005), -0.0001);
});

test("the title is exactly ONE accessibility element at every fraction", () => {
  for (let step = -40; step <= 300; step += 1) {
    const state = collapseState({ scrollY: step, height: 280, minHeight: 56 });
    const visible = (state.headerTitleOpacity > 0 ? 1 : 0) + (state.navBarTitleOpacity > 0 ? 1 : 0);
    assert.ok(visible <= 1, `two titles visible at scrollY ${step}`);
    assert.ok(
      state.titleOwner === (state.fraction >= TITLE_HANDOFF_FRACTION ? "navbar" : "header"),
      `owner disagreed with the hand-off at ${step}`,
    );
  }
});

test("the pinned slot survives a full collapse", () => {
  const state = collapseState({ scrollY: 10_000, height: 280, minHeight: 56, pinnedHeight: 88 });
  assert.equal(state.fraction, 1);
  assert.equal(state.effectiveMinHeight, 88, "minHeight must not clip content that survives the collapse");
  assert.equal(state.headerHeight, 88);
  assert.equal(state.pinnedOffset, 0, "the pinned slot sits on the header's bottom edge");
});

test("reduced motion disables parallax and keeps the collapse", () => {
  const moving = collapseState({ scrollY: 112, height: 280, minHeight: 56 });
  const reduced = collapseState({ scrollY: 112, height: 280, minHeight: 56, reduceMotion: true });
  assert.equal(reduced.fraction, moving.fraction, "the collapse is layout, and layout still happens");
  assert.equal(reduced.headerHeight, moving.headerHeight);
  assert.equal(reduced.imageTranslation, 0);
  assert.equal(reduced.effectiveParallax, 0);
  // Stretch tracks the finger one to one, so it is not what the vestibular guidance is about.
  assert.equal(collapseState({ scrollY: -140, height: 280, minHeight: 56, reduceMotion: true }).imageScale, 1.5);
});

test("the collapse fraction is monotone in scrollY and never leaves 0..1", () => {
  let previous = -1;
  for (let y = -200; y <= 600; y += 1) {
    const f = collapseState({ scrollY: y, height: 280, minHeight: 56 }).fraction;
    assert.ok(f >= 0 && f <= 1, `fraction left the range at ${y}`);
    assert.ok(f >= previous, `fraction went backwards at ${y}`);
    previous = f;
  }
});

test("on:collapse emits the endpoints and nothing under the quantum", () => {
  assert.equal(shouldEmitCollapse(null, 0.42), true);
  assert.equal(shouldEmitCollapse(0.42, 0.4201), false);
  assert.equal(shouldEmitCollapse(0.42, 0.43), true);
  assert.equal(shouldEmitCollapse(0.001, 0), true);
  assert.equal(shouldEmitCollapse(0.9999, 1), true);
  assert.equal(shouldEmitCollapse(1, 1), false);
});

test("the attribute table is total — no value throws and every default survives junk", () => {
  const junk = ["", "   ", "yes", "TRUE", "0", "nope", "12;drop", "-", "NaN", "∞"];
  for (const value of junk) {
    for (const key of ["axis", "indicators", "bounces", "paging", "snap", "keyboardDismiss", "overscroll", "contentInset", "maintainPosition", "threshold"]) {
      const config = parseScrollConfig({ [key]: value });
      assert.ok(["vertical", "horizontal"].includes(config.axis), `${key}=${value}`);
      assert.ok(["none", "start", "center", "end", "page"].includes(config.snap), `${key}=${value}`);
      assert.ok(config.threshold >= 0 && Number.isFinite(config.threshold), `${key}=${value}`);
    }
  }
  assert.equal(parseScrollConfig({}).bounces, null, "bounces is tristate: unset means the platform decides");
  assert.equal(parseScrollConfig({ bounces: "false" }).bounces, false);
  assert.equal(parseScrollConfig({ paging: "true", snap: "center" }).snap, "page", "paging outranks snap");
});

test("the tolerance is the same half point everywhere it is claimed", () => {
  assert.equal(SCROLL_EPSILON, 0.5);
  const geometry = { x: 0, y: 1199.5, viewportWidth: 390, viewportHeight: 800, contentWidth: 390, contentHeight: 2000 };
  assert.equal(scrollMetrics(geometry).atBottom, true);
  assert.equal(scrollMetrics({ ...geometry, y: 1199.49 }).atBottom, false);
});
