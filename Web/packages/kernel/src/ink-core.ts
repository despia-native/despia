//
//  ink-core.ts — the INK PRIMITIVE's pure core: the wire shape of a captured drawing, the
//  capture folds (clamp · round · coalesce), the ink curve, and the tier-1 canvas nodes a
//  committed drawing becomes. Nothing DOM-shaped in it.
//
//  This is the `<ink>` child of `<canvas>` (StackReference → canvas): the one primitive a
//  drawing surface needs that a display list cannot express — a pointer stream captured and
//  painted NATIVELY, at pointer rate, without a store write per sample. `<Signature>` is its
//  first consumer.
//
//  The law is OpenSource/Conformance/canvas/ink.json; the Kotlin twin is :core InkCore.kt and
//  the Swift twin is Engine/iOS/InkCore.swift.
//
//  THE VALUE IS THE API. A drawing is `[{ points: [[x, y], …], width }]` with x/y NORMALIZED
//  0…1 against the surface box and rounded to 1/INK_COORDINATE_SCALE at CAPTURE — so the
//  number written to the store is the number every renderer draws, a phone capture replays on
//  a desktop surface, and clearing is `drawing = []` rather than a control channel.
//
//  THE COMMITTED DRAWING IS ORDINARY TIER 1. `inkNodes` turns the stored strokes into the same
//  `path` markup nodes an author could have written by hand, so the display list, its keyed
//  diff and its SVG serialisation (`canvasSvgMarkup`) all work on ink with no special case.
//  Only the IN-FLIGHT stroke is transient native paint. (The canvas's own SSR still emits the
//  sized, labelled box rather than that SVG - a standing decision recorded in render.ts, not a
//  gap in ink; `<Signature>`, which paints its own pad, does serialise its strokes.)
//
import type { CanvasMarkupNode } from "./canvas-core.ts";

/** Ink defaults and the capture folds. */
export const INK_STROKE_WIDTH = 3;
/** Samples closer than this (in pad points, before normalization) are dropped. */
export const INK_MIN_POINT_DISTANCE = 1.5;
/** The normalized pair is rounded to 1/10000 at capture. */
export const INK_COORDINATE_SCALE = 10000;

export type InkPoint = readonly [number, number];
export type InkStroke = { readonly points: readonly InkPoint[]; readonly width: number };

export type InkOp =
  | { readonly op: "M" | "L"; readonly x: number; readonly y: number }
  | { readonly op: "Q"; readonly cx: number; readonly cy: number; readonly x: number; readonly y: number };

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Read a stored signature. Anything that is not a usable stroke is dropped, never guessed. */
export function decodeInk(value: unknown): InkStroke[] {
  if (!Array.isArray(value)) return [];
  const strokes: InkStroke[] = [];
  for (const row of value) {
    if (row === null || typeof row !== "object") continue;
    const raw = (row as { points?: unknown }).points;
    if (!Array.isArray(raw)) continue;
    const points: InkPoint[] = [];
    for (const pair of raw) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const x = finite(pair[0]);
      const y = finite(pair[1]);
      if (x === null || y === null) continue;
      points.push([x, y]);
    }
    if (points.length === 0) continue;
    strokes.push({ points, width: finite((row as { width?: unknown }).width) ?? INK_STROKE_WIDTH });
  }
  return strokes;
}

/** The store shape — plain JSON arrays, so the value survives every transport unchanged. */
export function encodeInk(
  strokes: readonly InkStroke[],
): Array<{ points: number[][]; width: number }> {
  return strokes.map((stroke) => ({
    points: stroke.points.map((p) => [p[0], p[1]]),
    width: stroke.width,
  }));
}

/** Clamp a pointer position to the pad box and round it AT CAPTURE. */
export function inkPoint(x: number, y: number, width: number, height: number): InkPoint {
  const nx = width > 0 ? x / width : 0;
  const ny = height > 0 ? y / height : 0;
  return [round01(nx), round01(ny)];
}

function round01(v: number): number {
  const clamped = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
  return Math.round(clamped * INK_COORDINATE_SCALE) / INK_COORDINATE_SCALE;
}

/** The coalescing floor: is the new sample far enough from the last one to keep? */
export function inkFarEnough(
  last: InkPoint,
  next: InkPoint,
  width: number,
  height: number,
): boolean {
  const dx = (next[0] - last[0]) * width;
  const dy = (next[1] - last[1]) * height;
  return dx * dx + dy * dy >= INK_MIN_POINT_DISTANCE * INK_MIN_POINT_DISTANCE;
}

/**
 * The INK LAW: a quadratic Bézier through the MIDPOINTS of consecutive samples, so the same
 * stroke list draws the same curve on all four renderers. A one-point stroke is a dot, painted
 * by the round cap.
 */
export function inkOps(
  points: readonly InkPoint[],
  width: number,
  height: number,
): InkOp[] {
  if (points.length === 0) return [];
  const at = (p: InkPoint): { x: number; y: number } => ({ x: p[0] * width, y: p[1] * height });
  const first = at(points[0]!);
  const ops: InkOp[] = [{ op: "M", x: first.x, y: first.y }];
  if (points.length === 1) {
    ops.push({ op: "L", x: first.x, y: first.y });
    return ops;
  }
  for (let i = 1; i < points.length - 1; i += 1) {
    const control = at(points[i]!);
    const next = at(points[i + 1]!);
    ops.push({ op: "Q", cx: control.x, cy: control.y, x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 });
  }
  const last = at(points[points.length - 1]!);
  ops.push({ op: "L", x: last.x, y: last.y });
  return ops;
}

/** The same ops as an SVG `d` — the server renderer's ink, and the readable form in tests. */
export function inkPathData(
  points: readonly InkPoint[],
  width: number,
  height: number,
): string {
  return inkOps(points, width, height)
    .map((op) => (op.op === "Q"
      ? `Q ${trim(op.cx)} ${trim(op.cy)} ${trim(op.x)} ${trim(op.y)}`
      : `${op.op} ${trim(op.x)} ${trim(op.y)}`))
    .join(" ");
}

function trim(v: number): string {
  const rounded = Math.round(v * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** The ink paint every renderer applies to a committed stroke: round cap, round join, no fill. */
export const INK_LINECAP = "round";
export const INK_LINEJOIN = "round";

/**
 * The committed drawing as TIER-1 markup nodes — one stroked `path` per stroke, in the
 * surface's own pixel space. The display list, its keyed diff and its SVG serialisation then
 * treat ink exactly like geometry an author wrote by hand, which is why SSR needs no special
 * case: a saved drawing renders server-side as SVG and hydrates onto the canvas.
 */
export function inkNodes(
  strokes: readonly InkStroke[],
  width: number,
  height: number,
  stroke: string,
): CanvasMarkupNode[] {
  return strokes.map((entry) => ({
    kind: "path",
    attrs: {
      d: inkPathData(entry.points, width, height),
      fill: "none",
      stroke,
      strokeWidth: entry.width,
      strokeLinecap: INK_LINECAP,
      strokeLinejoin: INK_LINEJOIN,
    },
  }));
}
