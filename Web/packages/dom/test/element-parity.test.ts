// Focused conformance for the richer browser primitives that share the native DSX
// spellings. DOM interaction is covered by the browser oracle; these tests pin the
// data normalization, geometry and dependency-free QR encoder underneath it.

import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHART_RENDER_POINT_LIMIT,
  ELEMENTS,
  chartPoints,
  chartSeries,
  chartPalette,
  chartLinePath,
  downsampleChartPoints,
  normalizeStarCount,
  normalizeStarSize,
  projectMapPoint,
  registerRichElements,
  segmentOptions,
  starAccessibleName,
  webSurfacePathParts,
} from "../src/elements.ts";
import { qrMatrix } from "../src/qr.ts";

test("rich demo primitives are opt-in, then register concrete factories", () => {
  for (const tag of ["segmented", "stars", "chart", "map", "WebView", "qrcode"]) {
    assert.equal(ELEMENTS[tag], undefined, `${tag} stays out of the base embed floor`);
  }
  registerRichElements();
  for (const tag of ["segmented", "stars", "chart", "map", "WebView", "qrcode"]) {
    assert.equal(typeof ELEMENTS[tag], "function", `${tag} is a registered browser primitive`);
  }
});

test("segmented normalizes scalar and object option lists without erasing typed values", () => {
  assert.deepEqual(segmentOptions(["One", "Two"]), [
    { value: "One", label: "One" },
    { value: "Two", label: "Two" },
  ]);
  assert.deepEqual(segmentOptions([
    { key: 10, title: "Ten" },
    { key: false, title: "Disabled" },
  ], "key", "title"), [
    { value: 10, label: "Ten" },
    { value: false, label: "Disabled" },
  ]);
});

test("read-only stars expose their numeric value through a valid accessible name", () => {
  assert.equal(starAccessibleName("Customer rating", 3.5, 5), "Customer rating: 3.5 of 5 stars");
  assert.ok(!starAccessibleName("Rating", 0, 5).includes("undefined"));
});

test("stars bound hostile counts and sizes before allocating DOM", () => {
  assert.equal(normalizeStarCount(Infinity), 5);
  assert.equal(normalizeStarCount("1e309"), 5);
  assert.equal(normalizeStarCount(1_000_000_000), 100);
  assert.equal(normalizeStarCount(-10), 1);
  assert.equal(normalizeStarSize(Infinity), 24);
  assert.equal(normalizeStarSize(100_000), 256);
  assert.equal(normalizeStarSize(-10), 1);
});

test("chart rejects malformed rows and preserves finite zero values", () => {
  assert.deepEqual(chartPoints([
    { day: "Mon", amount: 0 },
    { day: "Tue", amount: 12.5 },
    { day: "bad", amount: "not-a-number" },
    null,
  ], "day", "amount").map(({ x, y }) => ({ x, y })), [
    { x: "Mon", y: 0 },
    { x: "Tue", y: 12.5 },
  ]);
});

test("chartSeries groups rows by series= and caps at 24", () => {
  const rows = [
    { month: "Jan", amount: 10, team: "A" },
    { month: "Jan", amount: 4, team: "B" },
    { month: "Feb", amount: 12, team: "A" },
    { month: "Feb", amount: "nope", team: "B" },
    { month: "Mar", amount: 8, team: "B" },
  ];
  const grouped = chartSeries(rows, "month", "amount", "team");
  assert.deepEqual(grouped.map((entry) => ({ name: entry.name, ys: entry.points.map((p) => p.y) })), [
    { name: "A", ys: [10, 12] },
    { name: "B", ys: [4, 8] },
  ]);
  const hostile = Array.from({ length: 40 }, (_, index) => ({ x: "k", y: 1, series: `s${index}` }));
  assert.equal(chartSeries(hostile, "x", "y", "series").length, 24);
  assert.equal(chartSeries(rows, "month", "amount", "").length, 1);
});

test("chartPalette maps semantic color tokens the same way color= does", () => {
  assert.deepEqual(chartPalette("accent|#FF9500", "currentColor"), [
    "var(--dsx-accent)",
    "#FF9500",
  ]);
  assert.deepEqual(chartPalette("accent,label", "currentColor"), [
    "var(--dsx-accent)",
    "var(--dsx-label)",
  ]);
  assert.equal(chartPalette(undefined, "currentColor")[0], "currentColor");
});

test("chartLinePath supports the corpus interpolation words; an unknown word keeps linear", () => {
  const pts = [{ x: 0, y: 10 }, { x: 10, y: 20 }, { x: 20, y: 10 }];
  assert.equal(chartLinePath(pts, "linear"), "M0.00 10.00 L10.00 20.00 L20.00 10.00");
  assert.equal(chartLinePath(pts, "step"), "M0.00 10.00 L10.00 10.00 L10.00 20.00 L20.00 20.00 L20.00 10.00");
  assert.match(chartLinePath(pts, "monotone"), /^M0\.00 10\.00 C/);
  // "smooth" was a web-only alias no corpus, census or other renderer carried — retired;
  // an unknown word renders the linear default, same as the natives
  assert.equal(chartLinePath(pts, "smooth"), chartLinePath(pts, "linear"));
});

test("chart bounds 200k-point renders while preserving order, endpoints and extrema", () => {
  const source = Array.from({ length: 200_000 }, (_, index) => ({
    x: String(index),
    y: index === 73_421 ? -50_000 : index === 150_123 ? 90_000 : Math.sin(index / 100),
    source: { index },
  }));
  const sampled = downsampleChartPoints(source);
  assert.ok(sampled.length <= CHART_RENDER_POINT_LIMIT);
  assert.equal(sampled[0], source[0]);
  assert.equal(sampled.at(-1), source.at(-1));
  assert.ok(sampled.includes(source[73_421]!));
  assert.ok(sampled.includes(source[150_123]!));
  const indices = sampled.map((point) => Number(point.x));
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
});

test("offline map projection centers exactly and wraps across the antimeridian", () => {
  assert.deepEqual(projectMapPoint(37, -122, 37, -122, 12, 600, 300), { x: 300, y: 150 });
  const wrapped = projectMapPoint(0, 179.9, 0, -179.9, 3, 400, 200);
  assert.ok(wrapped.x > 200 && wrapped.x < 205, `wrapped x=${wrapped.x}`);
  assert.equal(wrapped.y, 100);
});

test("WebView callback paths allow dotted APIs but block prototype traversal", () => {
  assert.deepEqual(webSurfacePathParts("window.app.receive"), ["window", "app", "receive"]);
  for (const path of ["__proto__.polluted", "window.constructor", "app.prototype.call", "bad-name.fn"]) {
    assert.throws(() => webSurfacePathParts(path), /invalid/);
  }
});

function matrixHash(value: string, correction: "L" | "M" | "Q" | "H"): {
  version: number;
  size: number;
  mask: number;
  hash: string;
} {
  const qr = qrMatrix(value, correction);
  const rows = qr.modules.map((row) => row.map((dark) => dark ? "1" : "0").join("")).join("\n");
  return {
    version: qr.version,
    size: qr.size,
    mask: qr.mask,
    hash: createHash("sha256").update(rows).digest("hex"),
  };
}

test("QR matrices match independently cross-checked byte-mode vectors", () => {
  assert.deepEqual(matrixHash("HELLO WORLD", "M"), {
    version: 1, size: 21, mask: 4,
    hash: "2d21897bf5a7ac606d02da07bdd5e7f02a8b90097f12404b1f7d764f18ef618c",
  });
  assert.deepEqual(matrixHash("x".repeat(200), "L"), {
    version: 9, size: 53, mask: 0,
    hash: "71ddfbc79101aebe329e96f941cecd5e8440af18575c5b44b1700da69a5e03d3",
  });
  assert.deepEqual(matrixHash("🙂".repeat(20), "H"), {
    version: 8, size: 49, mask: 1,
    hash: "c14d56c1ae08e5294e8b241db0d6dd8f0ef6e37f26cdcf6a632e659710dbcb21",
  });
});

test("QR encoder fails closed for unsupported correction and oversized payloads", () => {
  assert.throws(() => qrMatrix("test", "X" as "M"), /invalid QR correction level/);
  assert.throws(() => qrMatrix("x".repeat(2_000), "L"), /too long/);
});
