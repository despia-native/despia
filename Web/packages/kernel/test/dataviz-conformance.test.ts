//
//  dataviz-conformance.test.ts — the SHARED dataviz corpus through the TS kernel
//  (OpenSource/Conformance/dataviz/, all SIX files). The Kotlin twin (:core
//  DatavizConformanceTest) and the Swift twin (DatavizConformance, the record lane) run the
//  SAME files, so a chart cannot put a datum in one place on one renderer and somewhere else
//  on another, five hundred pins cannot group two ways at the same zoom, and the accessible
//  table cannot say something the picture does not.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  decimalExponent, powerOfTen, niceNumber, niceLinearDomain, valueDomain, linearScale,
  bandScale, logDomain, logScale, timeTicks,
  pieSlices, bubbleRadius, radarPoints, funnelStages, candleBuckets, candleGeometry,
  heatmapCells,
  nearestIndex, nearestValueIndex, brushWindow, zoomDomain, panDomain,
  accessibleTable,
  normalizeLongitude, mercatorX, mercatorY, longitudeAtWorldX, latitudeAtWorldY,
  fitCamera, mapRegion,
  clusterPins,
  MAP_TILE_SIZE, MAP_MIN_ZOOM, MAP_MAX_ZOOM, MAP_DEFAULT_ZOOM, MAP_MAX_MERCATOR_LATITUDE,
} from "../src/dataviz.ts";
import type { GeoPoint, EdgePadding, TimePoint, WeightedPoint } from "../src/dataviz.ts";

type Doc = { [k: string]: unknown };

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/dataviz");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/dataviz not found");
    dir = parent;
  }
}

function corpus(file: string): Doc {
  const doc = JSON.parse(readFileSync(join(corpusDir(), file), "utf-8")) as Doc;
  assert.equal(doc["version"], 1, `${file}: version`);
  return doc;
}

function section<T>(doc: Doc, file: string, key: string): T[] {
  const rows = doc[key] as T[] | undefined;
  assert.ok(Array.isArray(rows) && rows.length > 0, `${file}: ${key}[] must not be empty`);
  return rows;
}

const TOLERANCE = 1e-9;

function close(actual: number, expected: number, label: string): void {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= TOLERANCE,
    `${label}: ${actual} != ${expected}`,
  );
}

function closeList(actual: readonly number[], expected: readonly number[], label: string): void {
  assert.equal(actual.length, expected.length, `${label}: length (${actual.join(", ")})`);
  for (let i = 0; i < expected.length; i += 1) close(actual[i]!, expected[i]!, `${label}[${i}]`);
}

// ── scales.json ──────────────────────────────────────────────────────────────────────────

test("dataviz: the decimal-exponent primitive agrees with the corpus", () => {
  const doc = corpus("scales.json");
  for (const c of section<{ name: string; x: number; expect: number }>(doc, "scales.json", "decExp")) {
    assert.equal(decimalExponent(c.x), c.expect, `decExp/${c.name}`);
  }
});

test("dataviz: the power-of-ten primitive agrees with the corpus", () => {
  const doc = corpus("scales.json");
  for (const c of section<{ name: string; n: number; expect: number }>(doc, "scales.json", "pow10")) {
    close(powerOfTen(c.n), c.expect, `pow10/${c.name}`);
  }
});

test("dataviz: Heckbert nice numbers agree with the corpus", () => {
  const doc = corpus("scales.json");
  type Case = { name: string; x: number; round: boolean; expect: number };
  for (const c of section<Case>(doc, "scales.json", "niceNum")) {
    close(niceNumber(c.x, c.round), c.expect, `niceNum/${c.name}`);
  }
});

type DomainExpect = { lo: number; hi: number; step: number; ticks: number[] };

test("dataviz: the loose-labelled linear domain agrees with the corpus", () => {
  const doc = corpus("scales.json");
  type Case = { name: string; lo: number; hi: number; count: number; expect: DomainExpect };
  for (const c of section<Case>(doc, "scales.json", "niceDomain")) {
    const got = niceLinearDomain(c.lo, c.hi, c.count);
    close(got.lo, c.expect.lo, `niceDomain/${c.name}: lo`);
    close(got.hi, c.expect.hi, `niceDomain/${c.name}: hi`);
    close(got.step, c.expect.step, `niceDomain/${c.name}: step`);
    closeList(got.ticks, c.expect.ticks, `niceDomain/${c.name}: ticks`);
  }
});

test("dataviz: the value domain honours the zero anchor and pads a degenerate series", () => {
  const doc = corpus("scales.json");
  type Case = {
    name: string; values: number[]; includeZero: boolean; count: number; expect: DomainExpect;
  };
  for (const c of section<Case>(doc, "scales.json", "valueDomain")) {
    const got = valueDomain(c.values, c.includeZero, c.count);
    close(got.lo, c.expect.lo, `valueDomain/${c.name}: lo`);
    close(got.hi, c.expect.hi, `valueDomain/${c.name}: hi`);
    close(got.step, c.expect.step, `valueDomain/${c.name}: step`);
    closeList(got.ticks, c.expect.ticks, `valueDomain/${c.name}: ticks`);
  }
});

test("dataviz: the linear scale agrees with the corpus", () => {
  const doc = corpus("scales.json");
  type Case = {
    name: string; v: number; domain: [number, number]; range: [number, number]; expect: number;
  };
  for (const c of section<Case>(doc, "scales.json", "linear")) {
    close(linearScale(c.v, c.domain, c.range), c.expect, `linear/${c.name}`);
  }
});

test("dataviz: the band scale agrees with the corpus", () => {
  const doc = corpus("scales.json");
  type Case = {
    name: string; count: number; range: [number, number];
    paddingInner: number; paddingOuter: number; align: number;
    expect: {
      step: number; bandwidth: number; start: number; positions: number[]; centers: number[];
    };
  };
  for (const c of section<Case>(doc, "scales.json", "band")) {
    const got = bandScale(c.count, c.range, c.paddingInner, c.paddingOuter, c.align);
    close(got.step, c.expect.step, `band/${c.name}: step`);
    close(got.bandwidth, c.expect.bandwidth, `band/${c.name}: bandwidth`);
    close(got.start, c.expect.start, `band/${c.name}: start`);
    closeList(got.positions, c.expect.positions, `band/${c.name}: positions`);
    closeList(got.centers, c.expect.centers, `band/${c.name}: centers`);
  }
});

test("dataviz: the log decade ladder refuses a non-positive domain loudly", () => {
  const doc = corpus("scales.json");
  type Case = {
    name: string; lo: number; hi: number; maxTicks: number;
    expect: { valid: boolean; reason: string; lo: number; hi: number; ticks: number[] };
  };
  for (const c of section<Case>(doc, "scales.json", "log")) {
    const got = logDomain(c.lo, c.hi, c.maxTicks);
    assert.equal(got.valid, c.expect.valid, `log/${c.name}: valid`);
    assert.equal(got.reason, c.expect.reason, `log/${c.name}: reason`);
    close(got.lo, c.expect.lo, `log/${c.name}: lo`);
    close(got.hi, c.expect.hi, `log/${c.name}: hi`);
    closeList(got.ticks, c.expect.ticks, `log/${c.name}: ticks`);
  }
});

test("dataviz: the log scale agrees with the corpus", () => {
  const doc = corpus("scales.json");
  type Case = {
    name: string; v: number; domain: [number, number]; range: [number, number]; expect: number;
  };
  for (const c of section<Case>(doc, "scales.json", "logScale")) {
    close(logScale(c.v, c.domain, c.range), c.expect, `logScale/${c.name}`);
  }
});

test("dataviz: the fixed-duration time ladder agrees with the corpus", () => {
  const doc = corpus("scales.json");
  type Case = {
    name: string; lo: number; hi: number; count: number;
    expect: { step: number; ticks: number[] };
  };
  for (const c of section<Case>(doc, "scales.json", "time")) {
    const got = timeTicks(c.lo, c.hi, c.count);
    close(got.step, c.expect.step, `time/${c.name}: step`);
    closeList(got.ticks, c.expect.ticks, `time/${c.name}: ticks`);
  }
});

// ── marks.json ───────────────────────────────────────────────────────────────────────────

test("dataviz: pie geometry agrees with the corpus, degenerate cases included", () => {
  const doc = corpus("marks.json");
  type SliceExpect = {
    index: number; value: number; fraction: number; startAngle: number; endAngle: number;
    sweep: number; centroidX: number; centroidY: number; full: boolean;
  };
  type Case = {
    name: string; values: number[]; outerRadius: number; innerRadius: number;
    startAngle: number; padAngle: number; clockwise: boolean;
    expect: {
      total: number; empty: boolean; innerRadius: number; outerRadius: number;
      slices: SliceExpect[];
    };
  };
  for (const c of section<Case>(doc, "marks.json", "pie")) {
    const got = pieSlices(c.values, {
      outerRadius: c.outerRadius,
      innerRadius: c.innerRadius,
      startAngle: c.startAngle,
      padAngle: c.padAngle,
      clockwise: c.clockwise,
    });
    close(got.total, c.expect.total, `pie/${c.name}: total`);
    assert.equal(got.empty, c.expect.empty, `pie/${c.name}: empty`);
    close(got.innerRadius, c.expect.innerRadius, `pie/${c.name}: innerRadius`);
    close(got.outerRadius, c.expect.outerRadius, `pie/${c.name}: outerRadius`);
    assert.equal(got.slices.length, c.expect.slices.length, `pie/${c.name}: slice count`);
    for (let i = 0; i < c.expect.slices.length; i += 1) {
      const a = got.slices[i]!;
      const e = c.expect.slices[i]!;
      const at = `pie/${c.name}[${i}]`;
      assert.equal(a.index, e.index, `${at}: index`);
      close(a.value, e.value, `${at}: value`);
      close(a.fraction, e.fraction, `${at}: fraction`);
      close(a.startAngle, e.startAngle, `${at}: startAngle`);
      close(a.endAngle, e.endAngle, `${at}: endAngle`);
      close(a.sweep, e.sweep, `${at}: sweep`);
      close(a.centroidX, e.centroidX, `${at}: centroidX`);
      close(a.centroidY, e.centroidY, `${at}: centroidY`);
      assert.equal(a.full, e.full, `${at}: full`);
    }
  }
});

test("dataviz: bubble radius interpolates area, not radius", () => {
  const doc = corpus("marks.json");
  type Case = {
    name: string; v: number; min: number; max: number; rMin: number; rMax: number; expect: number;
  };
  for (const c of section<Case>(doc, "marks.json", "bubble")) {
    close(bubbleRadius(c.v, c.min, c.max, c.rMin, c.rMax), c.expect, `bubble/${c.name}`);
  }
});

test("dataviz: radar vertices agree with the corpus", () => {
  const doc = corpus("marks.json");
  type Case = {
    name: string; values: number[]; max: number; radius: number; center: [number, number];
    expect: { index: number; fraction: number; angle: number; x: number; y: number }[];
  };
  for (const c of section<Case>(doc, "marks.json", "radar")) {
    const got = radarPoints(c.values, c.max, c.radius, c.center[0], c.center[1]);
    assert.equal(got.length, c.expect.length, `radar/${c.name}: count`);
    for (let i = 0; i < c.expect.length; i += 1) {
      const a = got[i]!;
      const e = c.expect[i]!;
      assert.equal(a.index, e.index, `radar/${c.name}[${i}]: index`);
      close(a.fraction, e.fraction, `radar/${c.name}[${i}]: fraction`);
      close(a.angle, e.angle, `radar/${c.name}[${i}]: angle`);
      close(a.x, e.x, `radar/${c.name}[${i}]: x`);
      close(a.y, e.y, `radar/${c.name}[${i}]: y`);
    }
  }
});

test("dataviz: funnel stages agree with the corpus", () => {
  const doc = corpus("marks.json");
  type StageExpect = {
    index: number; topWidth: number; bottomWidth: number; top: number; bottom: number;
    ofFirst: number; ofPrevious: number;
  };
  type Case = {
    name: string; values: number[]; width: number; height: number; gap: number;
    expect: StageExpect[];
  };
  for (const c of section<Case>(doc, "marks.json", "funnel")) {
    const got = funnelStages(c.values, c.width, c.height, c.gap);
    assert.equal(got.length, c.expect.length, `funnel/${c.name}: count`);
    for (let i = 0; i < c.expect.length; i += 1) {
      const a = got[i]!;
      const e = c.expect[i]!;
      const at = `funnel/${c.name}[${i}]`;
      assert.equal(a.index, e.index, `${at}: index`);
      close(a.topWidth, e.topWidth, `${at}: topWidth`);
      close(a.bottomWidth, e.bottomWidth, `${at}: bottomWidth`);
      close(a.top, e.top, `${at}: top`);
      close(a.bottom, e.bottom, `${at}: bottom`);
      close(a.ofFirst, e.ofFirst, `${at}: ofFirst`);
      close(a.ofPrevious, e.ofPrevious, `${at}: ofPrevious`);
    }
  }
});

test("dataviz: candle bucketing skips empty buckets and never emits a zero", () => {
  const doc = corpus("marks.json");
  type CandleExpect = {
    bucket: number; start: number; open: number; high: number; low: number; close: number;
    count: number; direction: string;
  };
  type Case = {
    name: string; points: TimePoint[]; interval: number; origin: number; expect: CandleExpect[];
  };
  for (const c of section<Case>(doc, "marks.json", "candleBuckets")) {
    const got = candleBuckets(c.points, c.interval, c.origin);
    assert.equal(got.length, c.expect.length, `candleBuckets/${c.name}: count`);
    for (let i = 0; i < c.expect.length; i += 1) {
      const a = got[i]!;
      const e = c.expect[i]!;
      const at = `candleBuckets/${c.name}[${i}]`;
      assert.equal(a.bucket, e.bucket, `${at}: bucket`);
      close(a.start, e.start, `${at}: start`);
      close(a.open, e.open, `${at}: open`);
      close(a.high, e.high, `${at}: high`);
      close(a.low, e.low, `${at}: low`);
      close(a.close, e.close, `${at}: close`);
      assert.equal(a.count, e.count, `${at}: count`);
      assert.equal(a.direction, e.direction, `${at}: direction`);
    }
  }
});

test("dataviz: a doji still gets a visible body", () => {
  const doc = corpus("marks.json");
  type Case = {
    name: string; ohlc: [number, number, number, number];
    domain: [number, number]; range: [number, number]; minBody: number;
    expect: {
      bodyTop: number; bodyBottom: number; wickTop: number; wickBottom: number; direction: string;
    };
  };
  for (const c of section<Case>(doc, "marks.json", "candleGeometry")) {
    const got = candleGeometry(
      c.ohlc[0], c.ohlc[1], c.ohlc[2], c.ohlc[3], c.domain, c.range, c.minBody,
    );
    close(got.bodyTop, c.expect.bodyTop, `candleGeometry/${c.name}: bodyTop`);
    close(got.bodyBottom, c.expect.bodyBottom, `candleGeometry/${c.name}: bodyBottom`);
    close(got.wickTop, c.expect.wickTop, `candleGeometry/${c.name}: wickTop`);
    close(got.wickBottom, c.expect.wickBottom, `candleGeometry/${c.name}: wickBottom`);
    assert.equal(got.direction, c.expect.direction, `candleGeometry/${c.name}: direction`);
  }
});

test("dataviz: the last heatmap bin owns its own upper edge", () => {
  const doc = corpus("marks.json");
  type Case = {
    name: string; points: WeightedPoint[]; xBins: number; yBins: number;
    xDomain: [number, number]; yDomain: [number, number];
    expect: {
      max: number;
      cells: { xBin: number; yBin: number; value: number; intensity: number }[];
    };
  };
  for (const c of section<Case>(doc, "marks.json", "heatmap")) {
    const got = heatmapCells(c.points, c.xBins, c.yBins, c.xDomain, c.yDomain);
    close(got.max, c.expect.max, `heatmap/${c.name}: max`);
    assert.equal(got.cells.length, c.expect.cells.length, `heatmap/${c.name}: cell count`);
    for (let i = 0; i < c.expect.cells.length; i += 1) {
      const a = got.cells[i]!;
      const e = c.expect.cells[i]!;
      const at = `heatmap/${c.name}[${i}]`;
      assert.equal(a.xBin, e.xBin, `${at}: xBin`);
      assert.equal(a.yBin, e.yBin, `${at}: yBin`);
      close(a.value, e.value, `${at}: value`);
      close(a.intensity, e.intensity, `${at}: intensity`);
    }
  }
});

// ── interaction.json ─────────────────────────────────────────────────────────────────────

test("dataviz: nearestIndex is the shipped select rule, and an empty series is minus one", () => {
  const doc = corpus("interaction.json");
  type Case = { name: string; fraction: number; count: number; expect: number };
  for (const c of section<Case>(doc, "interaction.json", "nearestIndex")) {
    assert.equal(nearestIndex(c.fraction, c.count), c.expect, `nearestIndex/${c.name}`);
  }
});

test("dataviz: nearestValueIndex breaks a tie toward the lower index", () => {
  const doc = corpus("interaction.json");
  type Case = { name: string; value: number; values: number[]; expect: number };
  for (const c of section<Case>(doc, "interaction.json", "nearestValueIndex")) {
    assert.equal(nearestValueIndex(c.value, c.values), c.expect, `nearestValueIndex/${c.name}`);
  }
});

test("dataviz: a tap inside a brushable chart clears the brush", () => {
  const doc = corpus("interaction.json");
  type Case = {
    name: string; from: number; to: number; domain: [number, number];
    expect: { start: number; end: number; cleared: boolean };
  };
  for (const c of section<Case>(doc, "interaction.json", "brush")) {
    const got = brushWindow(c.from, c.to, c.domain);
    close(got.start, c.expect.start, `brush/${c.name}: start`);
    close(got.end, c.expect.end, `brush/${c.name}: end`);
    assert.equal(got.cleared, c.expect.cleared, `brush/${c.name}: cleared`);
  }
});

test("dataviz: zoom clamps to the data extent and floors the span", () => {
  const doc = corpus("interaction.json");
  type Case = {
    name: string; domain: [number, number]; full: [number, number];
    factor: number; anchor: number; expect: { lo: number; hi: number };
  };
  for (const c of section<Case>(doc, "interaction.json", "zoom")) {
    const got = zoomDomain(c.domain, c.full, c.factor, c.anchor);
    close(got.lo, c.expect.lo, `zoom/${c.name}: lo`);
    close(got.hi, c.expect.hi, `zoom/${c.name}: hi`);
  }
});

test("dataviz: pan keeps its span at both edges", () => {
  const doc = corpus("interaction.json");
  type Case = {
    name: string; domain: [number, number]; full: [number, number];
    delta: number; expect: { lo: number; hi: number };
  };
  for (const c of section<Case>(doc, "interaction.json", "pan")) {
    const got = panDomain(c.domain, c.full, c.delta);
    close(got.lo, c.expect.lo, `pan/${c.name}: lo`);
    close(got.hi, c.expect.hi, `pan/${c.name}: hi`);
  }
});

// ── a11y.json ────────────────────────────────────────────────────────────────────────────

test("dataviz: the accessible table pivots the series and leaves a missing cell blank", () => {
  const doc = corpus("a11y.json");
  type Case = {
    name: string; rows: Record<string, unknown>[];
    x: string; y: string; series: string; type: string; xTitle: string; yTitle: string;
    expect: { caption: string; columns: string[]; rows: string[][]; summary: string };
  };
  for (const c of section<Case>(doc, "a11y.json", "table")) {
    const got = accessibleTable(c.rows, {
      x: c.x, y: c.y, series: c.series, type: c.type, xTitle: c.xTitle, yTitle: c.yTitle,
    });
    assert.equal(got.caption, c.expect.caption, `a11y/${c.name}: caption`);
    assert.deepEqual([...got.columns], c.expect.columns, `a11y/${c.name}: columns`);
    assert.deepEqual(got.rows.map((r) => [...r]), c.expect.rows, `a11y/${c.name}: rows`);
    assert.equal(got.summary, c.expect.summary, `a11y/${c.name}: summary`);
  }
});

// ── camera.json ──────────────────────────────────────────────────────────────────────────

test("dataviz: the camera defaults agree with the corpus", () => {
  const doc = corpus("camera.json");
  const defaults = doc["defaults"] as { [k: string]: number };
  close(MAP_TILE_SIZE, defaults["tileSize"]!, "camera: tileSize");
  close(MAP_MIN_ZOOM, defaults["minZoom"]!, "camera: minZoom");
  close(MAP_MAX_ZOOM, defaults["maxZoom"]!, "camera: maxZoom");
  close(MAP_DEFAULT_ZOOM, defaults["defaultZoom"]!, "camera: defaultZoom");
  close(MAP_MAX_MERCATOR_LATITUDE, defaults["maxMercatorLatitude"]!, "camera: maxMercatorLatitude");
});

test("dataviz: the web-mercator projection agrees with the corpus", () => {
  const doc = corpus("camera.json");
  type Case = { name: string; lat?: number; lon?: number; expectWorldX?: number; expectWorldY?: number };
  for (const c of section<Case>(doc, "camera.json", "project")) {
    if (c.lon !== undefined && c.expectWorldX !== undefined) {
      close(mercatorX(c.lon), c.expectWorldX, `project/${c.name}: worldX`);
    }
    if (c.lat !== undefined && c.expectWorldY !== undefined) {
      close(mercatorY(c.lat), c.expectWorldY, `project/${c.name}: worldY`);
    }
  }
});

test("dataviz: the projection round-trips", () => {
  const doc = corpus("camera.json");
  type Case = { name: string; lat: number; lon: number };
  for (const c of section<Case>(doc, "camera.json", "roundTrip")) {
    close(latitudeAtWorldY(mercatorY(c.lat)), c.lat, `roundTrip/${c.name}: lat`);
    close(longitudeAtWorldX(mercatorX(c.lon)), c.lon, `roundTrip/${c.name}: lon`);
  }
});

test("dataviz: longitude normalisation wraps west at the antimeridian", () => {
  const doc = corpus("camera.json");
  type Case = { name: string; lon: number; expect: number };
  for (const c of section<Case>(doc, "camera.json", "normalizeLon")) {
    close(normalizeLongitude(c.lon), c.expect, `normalizeLon/${c.name}`);
  }
});

test("dataviz: fitTo takes the short way round and centres in the usable rectangle", () => {
  const doc = corpus("camera.json");
  type Case = {
    name: string; coords: GeoPoint[]; width: number; height: number; padding: EdgePadding;
    expect: { valid: boolean; lat: number; lon: number; zoom: number };
  };
  for (const c of section<Case>(doc, "camera.json", "fitTo")) {
    const got = fitCamera(c.coords, c.width, c.height, c.padding);
    assert.equal(got.valid, c.expect.valid, `fitTo/${c.name}: valid`);
    close(got.lat, c.expect.lat, `fitTo/${c.name}: lat`);
    close(got.lon, c.expect.lon, `fitTo/${c.name}: lon`);
    close(got.zoom, c.expect.zoom, `fitTo/${c.name}: zoom`);
  }
});

test("dataviz: the region payload agrees with the corpus", () => {
  const doc = corpus("camera.json");
  type Case = {
    name: string; lat: number; lon: number; zoom: number; width: number; height: number;
    expect: {
      centerLat: number; centerLon: number; zoom: number; latSpan: number; lonSpan: number;
    };
  };
  for (const c of section<Case>(doc, "camera.json", "region")) {
    const got = mapRegion(c.lat, c.lon, c.zoom, c.width, c.height);
    close(got.centerLat, c.expect.centerLat, `region/${c.name}: centerLat`);
    close(got.centerLon, c.expect.centerLon, `region/${c.name}: centerLon`);
    close(got.zoom, c.expect.zoom, `region/${c.name}: zoom`);
    close(got.latSpan, c.expect.latSpan, `region/${c.name}: latSpan`);
    close(got.lonSpan, c.expect.lonSpan, `region/${c.name}: lonSpan`);
  }
});

// ── cluster.json ─────────────────────────────────────────────────────────────────────────

type ClusterExpect = {
  cluster: boolean; id: string; lat: number; lon: number;
  count: number; members: number[]; expansionZoom: number;
};

test("dataviz: pin membership agrees with the corpus at every zoom", () => {
  const doc = corpus("cluster.json");
  const defaults = doc["defaults"] as { [k: string]: number };
  const maxZoom = defaults["maxZoom"]!;
  const membership = doc["membership"] as {
    pins: GeoPoint[];
    cases: { zoom: number; radius: number; expect: ClusterExpect[] }[];
  };
  assert.ok(membership.cases.length > 0, "cluster.json: membership.cases[] must not be empty");
  for (const c of membership.cases) {
    const got = clusterPins(membership.pins, c.zoom, c.radius, maxZoom);
    const at = `cluster/membership z=${c.zoom} r=${c.radius}`;
    assert.equal(got.length, c.expect.length, `${at}: node count`);
    for (let i = 0; i < c.expect.length; i += 1) {
      const a = got[i]!;
      const e = c.expect[i]!;
      assert.equal(a.id, e.id, `${at}[${i}]: id`);
      assert.equal(a.cluster, e.cluster, `${at}[${i}]: cluster`);
      close(a.lat, e.lat, `${at}[${i}]: lat`);
      close(a.lon, e.lon, `${at}[${i}]: lon`);
      assert.equal(a.count, e.count, `${at}[${i}]: count`);
      assert.deepEqual([...a.members], e.members, `${at}[${i}]: members`);
      assert.equal(a.expansionZoom, e.expansionZoom, `${at}[${i}]: expansionZoom`);
    }
  }
});

test("dataviz: membership does not flicker inside one integer level", () => {
  const doc = corpus("cluster.json");
  const defaults = doc["defaults"] as { [k: string]: number };
  const stability = doc["stability"] as {
    pins: GeoPoint[]; sameLevel: number[]; nextLevel: number;
  };
  assert.ok(stability.sameLevel.length > 1, "cluster.json: stability.sameLevel needs a sweep");
  const radius = defaults["clusterRadius"]!;
  const maxZoom = defaults["maxZoom"]!;
  const reference = clusterPins(stability.pins, stability.sameLevel[0]!, radius, maxZoom)
    .map((n) => n.id);
  for (const zoom of stability.sameLevel) {
    const ids = clusterPins(stability.pins, zoom, radius, maxZoom).map((n) => n.id);
    assert.deepEqual(ids, reference, `cluster/stability: zoom ${zoom} must not re-cluster`);
  }
  const next = clusterPins(stability.pins, stability.nextLevel, radius, maxZoom).map((n) => n.id);
  assert.notDeepEqual(
    next, reference, "cluster/stability: the next level must re-cluster",
  );
});

test("dataviz: five hundred pins produce the same ordered digest at every zoom", () => {
  const doc = corpus("cluster.json");
  const defaults = doc["defaults"] as { [k: string]: number };
  const maxZoom = defaults["maxZoom"]!;
  const scale = doc["scale"] as {
    pins: GeoPoint[];
    cases: { zoom: number; radius: number; expect: [string, number][] }[];
  };
  assert.ok(scale.pins.length >= 500, "cluster.json: scale.pins must be the 500-pin lattice");
  for (const c of scale.cases) {
    const digest = clusterPins(scale.pins, c.zoom, c.radius, maxZoom)
      .map((n) => [n.id, n.count]);
    assert.deepEqual(digest, c.expect, `cluster/scale z=${c.zoom}: digest`);
  }
});
