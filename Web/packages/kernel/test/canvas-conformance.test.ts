//
//  canvas-conformance.test.ts - the SHARED `<canvas>` corpus
//  (OpenSource/Conformance/canvas/{path,transform,gradient,fillrule,displaylist,frames,
//  tier2,a11y,ink}.json) through the TS canvas core — the reference leg of parity/U04-canvas.md.
//  The Kotlin twin is :core CanvasConformanceTest.kt and the Swift twin is
//  Engine/iOS/CanvasCore.swift (record lane), both reading the SAME eight files off disk,
//  so the three implementations cannot drift on a single coordinate.
//
//  Expected numbers come from an independent scratch implementation, never from this core.
//  GEOMETRY is exact everywhere and is asserted to 1e-6; PIXELS are toleranced and are not
//  asserted here at all — that is the determinism split the corpus is built on.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  parseCanvasPath, canvasPathBBox, parseCanvasTransform, canvasApply,
  canvasPathArea, canvasWindingAt, canvasContains,
  normalizeCanvasStops, sampleCanvasStops, canvasGradientT,
  buildCanvasDisplayList, diffCanvasDisplayList, canvasToSvg,
  runCanvasScript, canvasFrameSchedule, canvasA11y,
  type CanvasMarkupNode, type CanvasGradientKind, type CanvasCommand, type CanvasFrameEvent,
} from "../src/canvas-core.ts";
import {
  INK_COORDINATE_SCALE, INK_LINECAP, INK_LINEJOIN, INK_MIN_POINT_DISTANCE, INK_STROKE_WIDTH,
  decodeInk, inkFarEnough, inkNodes, inkOps, inkPathData, inkPoint, type InkPoint,
  type InkStroke,
} from "../src/ink-core.ts";

const TOLERANCE = 1e-6;

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/canvas");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("canvas corpus not found");
    dir = parent;
  }
}

function corpus(file: string): { [key: string]: unknown } {
  return JSON.parse(readFileSync(join(corpusDir(), file), "utf-8")) as { [key: string]: unknown };
}

function rows<T>(file: string, key: string, minimum: number): T[] {
  const list = corpus(file)[key] as T[] | undefined;
  assert.ok(Array.isArray(list), `${file}: no ${key}[]`);
  assert.ok(list.length >= minimum, `${file}.${key}: corpus is suspiciously small (${list.length})`);
  return list;
}

/** deep structural equality with a numeric tolerance — the corpus stores 6-decimal
 *  roundings of exact folds, so a bit-exact compare would fail on arithmetic that is
 *  right. Key sets are compared BOTH ways: an extra field is a drift too. */
function like(actual: unknown, expected: unknown, where: string): void {
  if (expected === null) {
    assert.equal(actual, null, `${where}: expected null, got ${JSON.stringify(actual)}`);
    return;
  }
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", `${where}: expected a number, got ${JSON.stringify(actual)}`);
    assert.ok(Math.abs((actual as number) - expected) <= TOLERANCE,
      `${where}: ${actual} !~ ${expected}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: expected an array, got ${JSON.stringify(actual)}`);
    assert.equal((actual as unknown[]).length, expected.length, `${where}: length`);
    expected.forEach((value, i) => like((actual as unknown[])[i], value, `${where}[${i}]`));
    return;
  }
  if (typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual),
      `${where}: expected an object, got ${JSON.stringify(actual)}`);
    const got = actual as { [k: string]: unknown };
    const want = expected as { [k: string]: unknown };
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${where}: field set`);
    for (const key of Object.keys(want)) like(got[key], want[key], `${where}.${key}`);
    return;
  }
  assert.equal(actual, expected, where);
}

function diagnosticCount(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

// ── path.json ────────────────────────────────────────────────────────────────────────

type PathCase = {
  name: string; d: string; segments: unknown[]; bbox: unknown; diagnostics?: number;
};

for (const c of rows<PathCase>("path.json", "cases", 25)) {
  test(`canvas-path/${c.name}`, () => {
    const parsed = parseCanvasPath(c.d);
    like(parsed.segments, c.segments, "segments");
    like(canvasPathBBox(parsed.segments), c.bbox, "bbox");
    assert.equal(parsed.diagnostics.length, diagnosticCount(c.diagnostics),
      `diagnostics: ${JSON.stringify(parsed.diagnostics)}`);
  });
}

// ── transform.json ───────────────────────────────────────────────────────────────────

type TransformCase = {
  name: string; transform: string; matrix: number[];
  points: { in: [number, number]; out: [number, number] }[]; diagnostics?: number;
};

for (const c of rows<TransformCase>("transform.json", "parse", 15)) {
  test(`canvas-transform/${c.name}`, () => {
    const parsed = parseCanvasTransform(c.transform);
    like(parsed.matrix, c.matrix, "matrix");
    for (const point of c.points) {
      like(canvasApply(parsed.matrix, point.in[0], point.in[1]), point.out,
        `point(${point.in.join(",")})`);
    }
    assert.equal(parsed.diagnostics.length, diagnosticCount(c.diagnostics),
      `diagnostics: ${JSON.stringify(parsed.diagnostics)}`);
  });
}

type ComposeCase = {
  name: string; tree: CanvasMarkupNode[];
  nodes: { key: string; transform: number[]; points?: { in: [number, number]; out: [number, number] }[] }[];
};

for (const c of rows<ComposeCase>("transform.json", "compose", 3)) {
  test(`canvas-transform-compose/${c.name}`, () => {
    const list = buildCanvasDisplayList(c.tree);
    for (const want of c.nodes) {
      const op = list.ops.find((candidate) => candidate.key === want.key);
      assert.ok(op !== undefined, `no op keyed ${want.key} (got ${list.ops.map((o) => o.key).join(", ")})`);
      like(op.transform, want.transform, `${want.key}.transform`);
      for (const point of want.points ?? []) {
        like(canvasApply(op.transform, point.in[0], point.in[1]), point.out,
          `${want.key} point(${point.in.join(",")})`);
      }
    }
  });
}

// ── fillrule.json ────────────────────────────────────────────────────────────────────

type FillRuleCase = {
  name: string; d: string; area: number;
  points: { at: [number, number]; winding: number; nonzero: boolean; evenodd: boolean }[];
};

for (const c of rows<FillRuleCase>("fillrule.json", "cases", 5)) {
  test(`canvas-fillrule/${c.name}`, () => {
    const path = parseCanvasPath(c.d).segments;
    like(canvasPathArea(path), c.area, "area");
    for (const point of c.points) {
      const label = `at(${point.at.join(",")})`;
      like(canvasWindingAt(path, point.at[0], point.at[1]), point.winding, `${label}.winding`);
      assert.equal(canvasContains(path, point.at[0], point.at[1], "nonzero"), point.nonzero, `${label}.nonzero`);
      assert.equal(canvasContains(path, point.at[0], point.at[1], "evenodd"), point.evenodd, `${label}.evenodd`);
    }
  });
}

// ── gradient.json ────────────────────────────────────────────────────────────────────

type GradientCase = {
  name: string;
  stops: { offset?: number | string; color?: string; opacity?: number }[];
  normalized: unknown[];
  samples?: { t: number; rgba: number[] }[];
  diagnostics?: number;
};

for (const c of rows<GradientCase>("gradient.json", "cases", 12)) {
  test(`canvas-gradient/${c.name}`, () => {
    const parsed = normalizeCanvasStops(c.stops);
    like(parsed.stops, c.normalized, "normalized");
    assert.equal(parsed.diagnostics.length, diagnosticCount(c.diagnostics),
      `diagnostics: ${JSON.stringify(parsed.diagnostics)}`);
    for (const sample of c.samples ?? []) {
      like(sampleCanvasStops(parsed.stops, sample.t), sample.rgba, `sample(${sample.t})`);
    }
  });
}

type ProjectionCase = {
  name: string; kind: CanvasGradientKind; geom: number[];
  points: { at: [number, number]; t: number }[];
};

for (const c of rows<ProjectionCase>("gradient.json", "projection", 6)) {
  test(`canvas-gradient-projection/${c.name}`, () => {
    for (const point of c.points) {
      like(canvasGradientT(c.kind, c.geom, point.at[0], point.at[1]), point.t,
        `at(${point.at.join(",")})`);
    }
  });
}

// ── displaylist.json ─────────────────────────────────────────────────────────────────

type DisplayCase = {
  name: string; canvas: { width: number; height: number }; tree: CanvasMarkupNode[];
  ops: unknown[]; svg: string; gradients?: unknown; diagnostics?: number;
};

for (const c of rows<DisplayCase>("displaylist.json", "cases", 9)) {
  test(`canvas-displaylist/${c.name}`, () => {
    const list = buildCanvasDisplayList(c.tree);
    like(list.ops, c.ops, "ops");
    assert.equal(list.diagnostics.length, diagnosticCount(c.diagnostics),
      `diagnostics: ${JSON.stringify(list.diagnostics)}`);
    if (c.gradients !== undefined) like(list.gradients, c.gradients, "gradients");
    assert.equal(canvasToSvg(list, c.canvas.width, c.canvas.height), c.svg, "svg");
  });
}

type DiffCase = {
  name: string; before: CanvasMarkupNode[]; after: CanvasMarkupNode[];
  beforeKeys: string[]; afterKeys: string[]; diff: unknown[];
};

for (const c of rows<DiffCase>("displaylist.json", "diff", 9)) {
  test(`canvas-diff/${c.name}`, () => {
    const before = buildCanvasDisplayList(c.before).ops;
    const after = buildCanvasDisplayList(c.after).ops;
    assert.deepEqual(before.map((op) => op.key), c.beforeKeys, "beforeKeys");
    assert.deepEqual(after.map((op) => op.key), c.afterKeys, "afterKeys");
    like(diffCanvasDisplayList(before, after), c.diff, "diff");
  });
}

// ── frames.json ──────────────────────────────────────────────────────────────────────

type FrameCase = {
  name: string; bound: boolean; events: CanvasFrameEvent[];
  emitted: unknown[]; installs: number; uninstalls: number; installed: boolean;
};

for (const c of rows<FrameCase>("frames.json", "cases", 7)) {
  test(`canvas-frames/${c.name}`, () => {
    const fold = canvasFrameSchedule(c.bound, c.events);
    like(fold.emitted, c.emitted, "emitted");
    assert.equal(fold.installs, c.installs, "installs");
    assert.equal(fold.uninstalls, c.uninstalls, "uninstalls");
    assert.equal(fold.installed, c.installed, "installed");
  });
}

// ── tier2.json ───────────────────────────────────────────────────────────────────────

type Tier2Case = {
  name: string; script: CanvasCommand[]; log: unknown[];
  measurements?: unknown[]; diagnostics?: number;
};

for (const c of rows<Tier2Case>("tier2.json", "cases", 20)) {
  test(`canvas-tier2/${c.name}`, () => {
    const result = runCanvasScript(c.script);
    like(result.log, c.log, "log");
    like(result.measurements, c.measurements ?? [], "measurements");
    assert.equal(result.diagnostics.length, diagnosticCount(c.diagnostics),
      `diagnostics: ${JSON.stringify(result.diagnostics)}`);
  });
}

// ── a11y.json ────────────────────────────────────────────────────────────────────────

type A11yCase = {
  name: string; attrs: { [k: string]: unknown }; verdict: unknown;
  a11yChildren?: { role?: string; label?: string; value?: string | null }[];
};

for (const c of rows<A11yCase>("a11y.json", "cases", 9)) {
  test(`canvas-a11y/${c.name}`, () => {
    like(canvasA11y(c.attrs, c.a11yChildren), c.verdict, "verdict");
  });
}

// ── ink.json ─────────────────────────────────────────────────────────────────────────
//
// `<ink>` is the canvas's pointer-capture primitive: the committed drawing is ordinary tier 1
// (`nodes`), and only the in-flight stroke is transient native paint. What is asserted here is
// everything a renderer must NOT decide for itself - the capture folds, the sampling floor, the
// curve, and the markup a stored drawing becomes.

test("canvas-ink/constants", () => {
  const c = corpus("ink.json")["constants"] as { [k: string]: unknown };
  assert.equal(INK_STROKE_WIDTH, c["strokeWidth"]);
  assert.equal(INK_MIN_POINT_DISTANCE, c["minPointDistance"]);
  assert.equal(INK_COORDINATE_SCALE, c["coordinateScale"]);
  assert.equal(INK_LINECAP, c["linecap"]);
  assert.equal(INK_LINEJOIN, c["linejoin"]);
});

type InkCaptureCase = { name: string; point: [number, number]; box: [number, number]; out: [number, number] };

for (const c of rows<InkCaptureCase>("ink.json", "capture", 5)) {
  test(`canvas-ink-capture/${c.name}`, () => {
    like(inkPoint(c.point[0], c.point[1], c.box[0], c.box[1]), c.out, "point");
  });
}

type InkCoalesceCase = { name: string; last: InkPoint; next: InkPoint; box: [number, number]; keep: boolean };

for (const c of rows<InkCoalesceCase>("ink.json", "coalesce", 4)) {
  test(`canvas-ink-coalesce/${c.name}`, () => {
    assert.equal(inkFarEnough(c.last, c.next, c.box[0], c.box[1]), c.keep, "keep");
  });
}

type InkDecodeCase = { name: string; value: unknown; out: InkStroke[] };

for (const c of rows<InkDecodeCase>("ink.json", "decode", 5)) {
  test(`canvas-ink-decode/${c.name}`, () => {
    like(decodeInk(c.value), c.out, "strokes");
  });
}

type InkOpsCase = {
  name: string; points: InkPoint[]; box: [number, number]; ops: unknown[][]; d: string;
};

for (const c of rows<InkOpsCase>("ink.json", "ops", 5)) {
  test(`canvas-ink-ops/${c.name}`, () => {
    const flat = inkOps(c.points, c.box[0], c.box[1])
      .map((op) => (op.op === "Q" ? ["Q", op.cx, op.cy, op.x, op.y] : [op.op, op.x, op.y]));
    like(flat, c.ops, "ops");
    assert.equal(inkPathData(c.points, c.box[0], c.box[1]), c.d, "d");
  });
}

type InkNodesCase = {
  name: string; strokes: InkStroke[]; box: [number, number]; stroke: string;
  nodes: CanvasMarkupNode[];
};

for (const c of rows<InkNodesCase>("ink.json", "nodes", 3)) {
  test(`canvas-ink-nodes/${c.name}`, () => {
    like(inkNodes(c.strokes, c.box[0], c.box[1], c.stroke), c.nodes, "nodes");
  });
}
