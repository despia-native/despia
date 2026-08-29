//
//  controls-core.ts — the U07 PURE CORE: the gradient resolver (linear · radial · angular ·
//  mesh, with the angle convention pinned), the `<gauge>` value-to-arc solver, the
//  `<colorpicker>` hex/swatch/name folds, and the `<masked>` mode fold.
//
//  The law is the corpus, OpenSource/Conformance/controls/{gradients,gauge,colorpicker,masked}.json
//  (parity/U07-controls.md); the Kotlin twin is :core ControlsCore.kt and the Swift twin is
//  Engine/iOS/ControlsCore.swift. Everything platform-shaped lives OUTSIDE this file —
//  LinearGradient/Brush/CSS, the system ColorPicker sheet, `.mask()`/BlendMode/mask-image —
//  because keeping the DECISION separate from the PLUMBING is what lets one corpus judge three
//  renderers.
//
//  THE ANGLE CONVENTION, stated once: 0deg points UP and increases CLOCKWISE. That is CSS's
//  convention; SwiftUI's UnitPoint model is unrelated and Compose's Offset model is a third
//  thing. Pinning one convention here and converting at each boundary is the only way
//  `gradientAngle="135deg"` looks the same on three renderers.
//

export type GradientType = "linear" | "radial" | "angular" | "mesh";
export const GRADIENT_TYPES: readonly GradientType[] = ["linear", "radial", "angular", "mesh"];

/** The three legacy direction tokens, kept as EXACT aliases so no shipped app moves a pixel. */
export const GRADIENT_DIRECTION_ALIASES: { readonly [token: string]: number } = {
  vertical: 180, horizontal: 90, diagonal: 135,
};
/** Neither `gradientAngle` nor `gradientDir` declared = today's behaviour: top to bottom. */
export const GRADIENT_ANGLE_DEFAULT = 180;

export interface UnitPoint { readonly x: number; readonly y: number }
export interface MeshPoint { readonly x: number; readonly y: number; readonly color: string }
export interface MeshGrid {
  readonly columns: number;
  readonly rows: number;
  readonly points: readonly MeshPoint[];
}
export interface MeshLayer {
  readonly center: UnitPoint;
  readonly radius: number;
  readonly color: string;
}
/** The DECLARED mesh degradation: a base fill plus one radial per control point, in row-major
 *  paint order. Pinned, so "mesh falls back" is a specification and not an accident. */
export interface MeshFallback { readonly base: string; readonly layers: readonly MeshLayer[] }

export interface GradientResolution {
  readonly type: GradientType;
  readonly colors: readonly string[];
  readonly stops: readonly number[];
  readonly angle: number;
  readonly start: UnitPoint;
  readonly end: UnitPoint;
  readonly center: UnitPoint;
  readonly radius: number;
  /** Fewer than two colours is not a gradient; the caller paints nothing rather than a flat band. */
  readonly valid: boolean;
  readonly mesh: MeshGrid | null;
  readonly meshFallback: MeshFallback | null;
}

export interface GradientAttributes {
  gradient?: string | null;
  gradientType?: string | null;
  gradientStops?: string | null;
  gradientAngle?: string | number | null;
  gradientDir?: string | null;
  gradientCenter?: string | null;
  gradientRadius?: string | number | null;
  gradientPoints?: string | null;
}

/** Six decimals: enough for sub-pixel placement, few enough that three languages agree. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** `135deg` · `135` · `0.25turn` · `1.57rad` · `150grad` · a legacy direction token. */
export function parseGradientAngle(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const text = String(input).trim().toLowerCase();
  if (text === "") return null;
  const alias = GRADIENT_DIRECTION_ALIASES[text];
  if (alias !== undefined) return alias;
  let value: number;
  if (text.endsWith("grad")) value = Number(text.slice(0, -4)) * 0.9;
  else if (text.endsWith("turn")) value = Number(text.slice(0, -4)) * 360;
  else if (text.endsWith("deg")) value = Number(text.slice(0, -3));
  else if (text.endsWith("rad")) value = (Number(text.slice(0, -3)) * 180) / Math.PI;
  else value = Number(text);
  if (!Number.isFinite(value)) return null;
  return ((value % 360) + 360) % 360;
}

/** The gradient axis as unit points, from the pinned angle convention. */
export function gradientUnitPoints(angle: number): { start: UnitPoint; end: UnitPoint } {
  const radians = (angle * Math.PI) / 180;
  const sine = Math.sin(radians);
  const cosine = Math.cos(radians);
  return {
    start: { x: round6(0.5 - sine / 2), y: round6(0.5 + cosine / 2) },
    end: { x: round6(0.5 + sine / 2), y: round6(0.5 - cosine / 2) },
  };
}

function parseUnitScalar(token: string): number | null {
  const text = token.trim();
  if (text === "") return null;
  const value = text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);
  return Number.isFinite(value) ? clamp01(value) : null;
}

/** `gradientCenter="0.25 0.75"` / `"25% 75%"`. A single value means both axes. */
export function parseUnitPoint(input: string | null | undefined, fallback: UnitPoint): UnitPoint {
  const parts = (input ?? "").trim().replace(/,/g, " ").split(" ").filter((part) => part !== "");
  if (parts.length >= 2) {
    const x = parseUnitScalar(parts[0]!);
    const y = parseUnitScalar(parts[1]!);
    if (x !== null && y !== null) return { x: round6(x), y: round6(y) };
  } else if (parts.length === 1) {
    const only = parseUnitScalar(parts[0]!);
    if (only !== null) return { x: round6(only), y: round6(only) };
  }
  return fallback;
}

/** `gradientRadius` as a fraction of the box's larger side. Default 0.5, capped at 4. */
export function parseGradientRadius(input: string | number | null | undefined): number {
  const text = String(input ?? "").trim();
  if (text === "") return 0.5;
  const value = text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);
  if (!Number.isFinite(value) || value <= 0) return 0.5;
  return round6(Math.min(4, value));
}

/**
 * The colour bound. A gradient is a handful of stops; a list in the thousands is a bug or an
 * attack, and every renderer turns each colour into shader geometry. The desktop lane already
 * bounded this on its own, which made the bound a property of one renderer instead of the
 * grammar - so it lives here now, where all four read it.
 *
 * TRUNCATION rather than rejection: a bounded gradient still paints, and past sixty-four stops
 * no display can show the difference. Refusing to paint would turn a cosmetic excess into a
 * blank element.
 */
export const MAX_GRADIENT_COLORS = 64;

/** `gradient="c1|c2|…"` — the shorthand every existing app already writes. */
export function parseGradientColors(input: string | null | undefined): string[] {
  if (input === null || input === undefined) return [];
  const parts = String(input).split("|").map((part) => part.trim()).filter((part) => part !== "");
  return parts.length > MAX_GRADIENT_COLORS ? parts.slice(0, MAX_GRADIENT_COLORS) : parts;
}

/**
 * `gradientStops` — positions matching the colour list. A COUNT MISMATCH FALLS BACK TO EVEN
 * SPACING rather than guessing which colour lost its stop: a gradient that silently reorders
 * itself when the author adds a colour is worse than one that ignores the attribute.
 * Values are clamped to 0…1 and forced monotonically non-decreasing.
 */
export function parseGradientStops(input: string | null | undefined, count: number): number[] {
  if (count === 0) return [];
  if (count === 1) return [0];
  const even = Array.from({ length: count }, (_, index) => round6(index / (count - 1)));
  const text = (input ?? "").trim();
  if (text === "") return even;
  const raw = text.replace(/\|/g, ",").split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (raw.length !== count) return even;
  const stops: number[] = [];
  let previous = 0;
  for (const token of raw) {
    const value = token.endsWith("%") ? Number(token.slice(0, -1)) / 100 : Number(token);
    if (!Number.isFinite(value)) return even;
    const monotonic = Math.max(previous, clamp01(value));
    previous = monotonic;
    stops.push(round6(monotonic));
  }
  return stops;
}

/**
 * `gradientPoints` — the mesh control grid. Rows are `;`-separated, points `,`-separated, and
 * each point is `x y color`. The grid must be rectangular and at least 2x2; anything else
 * returns null and the caller degrades to a linear gradient rather than painting a blank.
 */
export function parseMeshPoints(input: string | null | undefined): MeshGrid | null {
  const text = (input ?? "").trim();
  if (text === "") return null;
  const rows: MeshPoint[][] = [];
  for (const rowText of text.split(";")) {
    if (rowText.trim() === "") continue;
    const cells = rowText.split(",").filter((cell) => cell.trim() !== "");
    const row: MeshPoint[] = [];
    for (const cell of cells) {
      const parts = cell.trim().split(" ").filter((part) => part !== "");
      if (parts.length < 3) return null;
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      row.push({ x: round6(clamp01(x)), y: round6(clamp01(y)), color: parts.slice(2).join(" ").trim() });
    }
    rows.push(row);
  }
  if (rows.length < 2) return null;
  const columns = rows[0]!.length;
  if (columns < 2) return null;
  for (const row of rows) if (row.length !== columns) return null;
  return { columns, rows: rows.length, points: rows.flat() };
}

/**
 * The declared mesh degradation, used by every target that cannot draw a real mesh (Android,
 * the web, and iOS below 18): one radial per control point over a base fill, painted row-major.
 * The base is the control point nearest the centre, chosen by index so it is deterministic.
 */
export function meshFallbackLayers(mesh: MeshGrid): MeshFallback {
  const spread = Math.max(1 / (mesh.columns - 1), 1 / (mesh.rows - 1));
  const radius = round6(0.75 * spread);
  const baseIndex = Math.floor(mesh.rows / 2) * mesh.columns + Math.floor(mesh.columns / 2);
  return {
    base: mesh.points[baseIndex]!.color,
    layers: mesh.points.map((point) => ({ center: { x: point.x, y: point.y }, radius, color: point.color })),
  };
}

/** Fold every gradient attribute into the one descriptor each renderer paints from. */
export function resolveGradient(attributes: GradientAttributes): GradientResolution {
  let colors = parseGradientColors(attributes.gradient);
  const typeWord = (attributes.gradientType ?? "").trim();
  let type: GradientType = (GRADIENT_TYPES as readonly string[]).includes(typeWord)
    ? (typeWord as GradientType)
    : "linear";
  let angle = parseGradientAngle(attributes.gradientAngle);
  if (angle === null) angle = parseGradientAngle(attributes.gradientDir);
  if (angle === null) angle = GRADIENT_ANGLE_DEFAULT;

  let mesh = type === "mesh" ? parseMeshPoints(attributes.gradientPoints) : null;
  if (type === "mesh" && mesh === null) type = "linear";
  if (type === "mesh" && mesh !== null) colors = mesh.points.map((point) => point.color);

  const stops = parseGradientStops(attributes.gradientStops, colors.length);
  const axis = gradientUnitPoints(angle);
  return {
    type,
    colors,
    stops,
    angle: round6(angle),
    start: axis.start,
    end: axis.end,
    center: parseUnitPoint(attributes.gradientCenter, { x: 0.5, y: 0.5 }),
    radius: parseGradientRadius(attributes.gradientRadius),
    valid: colors.length >= 2,
    mesh,
    meshFallback: mesh === null ? null : meshFallbackLayers(mesh),
  };
}

export type GaugeStyle = "circular" | "accessoryCircular" | "linear" | "accessoryLinear";

export interface GaugeMetrics {
  readonly arcStart: number;
  readonly arcSweep: number;
  readonly thickness: number;
  readonly showsCurrentLabel: boolean;
  readonly showsBoundLabels: boolean;
}

/** The circular arc starts at 225 and sweeps 270, leaving the 90-degree gap at the bottom that
 *  makes a gauge read as a gauge and not as a progress ring. */
export const GAUGE_STYLES: { readonly [style: string]: GaugeMetrics } = {
  circular: { arcStart: 225, arcSweep: 270, thickness: 6, showsCurrentLabel: true, showsBoundLabels: true },
  accessoryCircular: { arcStart: 225, arcSweep: 270, thickness: 4, showsCurrentLabel: true, showsBoundLabels: false },
  linear: { arcStart: 0, arcSweep: 0, thickness: 6, showsCurrentLabel: true, showsBoundLabels: true },
  accessoryLinear: { arcStart: 0, arcSweep: 0, thickness: 4, showsCurrentLabel: false, showsBoundLabels: false },
};

export interface GaugeAccessibility {
  readonly role: "meter";
  readonly min: number;
  readonly max: number;
  readonly now: number;
  readonly percent: number;
  readonly valueText: string;
}

export interface GaugeResolution extends GaugeMetrics {
  readonly style: GaugeStyle;
  readonly fraction: number;
  readonly clampedValue: number;
  readonly valueAngle: number;
  readonly a11y: GaugeAccessibility;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** How the raw value reads aloud when no `currentLabel` is given. Integers lose the `.0`. */
function defaultValueText(value: number): string {
  return Number.isInteger(value) ? String(Math.trunc(value)) : String(value);
}

/**
 * `<gauge>` — value to arc, plus the meter semantics that are contract, not follow-up. An
 * inverted or empty range resolves to fraction 0 rather than NaN, because a gauge that renders
 * nothing is recoverable and one that renders garbage is not.
 */
export function resolveGauge(args: {
  value?: unknown; min?: unknown; max?: unknown;
  style?: string | null; currentLabel?: string | null;
}): GaugeResolution {
  const word = (args.style ?? "").trim();
  const style: GaugeStyle = (Object.prototype.hasOwnProperty.call(GAUGE_STYLES, word) ? word : "circular") as GaugeStyle;
  const metrics = GAUGE_STYLES[style]!;
  const value = finite(args.value, 0);
  const min = finite(args.min, 0);
  const max = finite(args.max, 1);
  const fraction = max <= min ? 0 : clamp01((value - min) / (max - min));
  const clamped = Math.min(Math.max(value, min), max);
  const valueAngle = ((metrics.arcStart + fraction * metrics.arcSweep) % 360 + 360) % 360;
  const label = (args.currentLabel ?? "").trim();
  return {
    ...metrics,
    style,
    fraction: round6(fraction),
    clampedValue: round6(clamped),
    valueAngle: round6(valueAngle),
    a11y: {
      role: "meter",
      min: round6(min),
      max: round6(max),
      now: round6(clamped),
      percent: Math.round(fraction * 100),
      valueText: label === "" ? defaultValueText(value) : label,
    },
  };
}

export interface GaugeTintSegment {
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly t: number;
}

/**
 * The value-following tint: which two colours of `tint="a|b|c"` the needle sits between, and
 * how far. Colour RESOLUTION is per-renderer (tokens differ), so the core returns indices and
 * an interpolation factor and lets each target mix in its own colour space.
 */
export function gaugeTintSegment(
  colors: readonly string[], stops: readonly number[], fraction: number,
): GaugeTintSegment | null {
  if (colors.length === 0) return null;
  if (colors.length === 1) return { fromIndex: 0, toIndex: 0, t: 0 };
  const value = clamp01(fraction);
  for (let index = 0; index < stops.length - 1; index++) {
    const low = stops[index]!;
    const high = stops[index + 1]!;
    if (value <= high || index === stops.length - 2) {
      const span = high - low;
      return { fromIndex: index, toIndex: index + 1, t: round6(clamp01(span <= 0 ? 0 : (value - low) / span)) };
    }
  }
  return { fromIndex: colors.length - 2, toIndex: colors.length - 1, t: 1 };
}

export interface Rgba { readonly r: number; readonly g: number; readonly b: number; readonly a: number }

/** The pinned name table the picker announces from. Small on purpose: a screen reader saying
 *  "cornflower blue" is not more useful than "blue", and a big table is a big disagreement. */
export const COLOR_NAMES: readonly { readonly name: string; readonly hex: string }[] = [
  { name: "black", hex: "#000000" }, { name: "white", hex: "#FFFFFF" },
  { name: "gray", hex: "#808080" }, { name: "silver", hex: "#C0C0C0" },
  { name: "red", hex: "#FF0000" }, { name: "maroon", hex: "#800000" },
  { name: "orange", hex: "#FFA500" }, { name: "brown", hex: "#A52A2A" },
  { name: "yellow", hex: "#FFFF00" }, { name: "olive", hex: "#808000" },
  { name: "lime", hex: "#00FF00" }, { name: "green", hex: "#008000" },
  { name: "teal", hex: "#008080" }, { name: "cyan", hex: "#00FFFF" },
  { name: "blue", hex: "#0000FF" }, { name: "navy", hex: "#000080" },
  { name: "indigo", hex: "#4B0082" }, { name: "purple", hex: "#800080" },
  { name: "magenta", hex: "#FF00FF" }, { name: "pink", hex: "#FFC0CB" },
  { name: "tan", hex: "#D2B48C" }, { name: "gold", hex: "#FFD700" },
  { name: "beige", hex: "#F5F5DC" }, { name: "turquoise", hex: "#40E0D0" },
];

const HEX_DIGITS = "0123456789abcdef";

/** `#RGB` · `#RGBA` · `#RRGGBB` · `#RRGGBBAA` → channels, or null. Nothing else is a colour here. */
export function parseHexColor(input: string | null | undefined): Rgba | null {
  const text = (input ?? "").trim();
  if (!text.startsWith("#")) return null;
  let body = text.slice(1).toLowerCase();
  for (const character of body) if (!HEX_DIGITS.includes(character)) return null;
  if (body.length === 3 || body.length === 4) {
    body = body.split("").map((character) => character + character).join("");
  }
  if (body.length === 6) body += "ff";
  if (body.length !== 8) return null;
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
    a: parseInt(body.slice(6, 8), 16),
  };
}

/** Uppercase output, and the alpha pair only when it is both allowed and not opaque. */
export function formatHexColor(color: Rgba, alphaAllowed = false): string {
  const pair = (value: number): string => value.toString(16).padStart(2, "0").toUpperCase();
  const base = `#${pair(color.r)}${pair(color.g)}${pair(color.b)}`;
  return alphaAllowed && color.a !== 255 ? `${base}${pair(color.a)}` : base;
}

/** Nearest name by squared sRGB distance, ties broken by table order. Deterministic on purpose. */
export function nearestColorName(color: Rgba): string {
  let best = COLOR_NAMES[0]!.name;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of COLOR_NAMES) {
    const target = parseHexColor(entry.hex)!;
    const dr = color.r - target.r;
    const dg = color.g - target.g;
    const db = color.b - target.b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) { bestDistance = distance; best = entry.name; }
  }
  return best;
}

/** Presets shown first. Invalid entries drop, duplicates collapse, and the list caps at 24. */
export function resolveSwatches(input: string | null | undefined, alphaAllowed = false): string[] {
  if (input === null || input === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of String(input).replace(/\|/g, ",").split(",")) {
    const parsed = parseHexColor(token);
    if (parsed === null) continue;
    const text = formatHexColor(parsed, alphaAllowed);
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length === 24) break;
  }
  return out;
}

export type ColorPickerMode = "wheel" | "sliders" | "swatches";
export const COLOR_PICKER_MODES: readonly ColorPickerMode[] = ["wheel", "sliders", "swatches"];

/** Undeclared mode: swatches when presets exist (they are the fast path), otherwise the wheel. */
export function resolveColorPickerMode(
  mode: string | null | undefined, _alpha: boolean, swatchCount: number,
): ColorPickerMode {
  const word = (mode ?? "").trim();
  if ((COLOR_PICKER_MODES as readonly string[]).includes(word)) return word as ColorPickerMode;
  return swatchCount > 0 ? "swatches" : "wheel";
}

/** `<input type="color">` supports neither alpha nor presets, so the web ejects to its own panel. */
export function webNeedsCustomColorPanel(alpha: boolean, swatchCount: number): boolean {
  return alpha === true || swatchCount > 0;
}

export type MaskMode = "alpha" | "luminance";
export interface MaskWebLayer { readonly image: "mask" | "opaque"; readonly composite: "add" | "subtract" }
export interface MaskResolution {
  readonly mode: MaskMode;
  readonly invert: boolean;
  /** The Compose blend mode: DstIn keeps what the mask covers, DstOut keeps what it does not. */
  readonly blend: "dstIn" | "dstOut";
  readonly cssMaskMode: "alpha" | "luminance";
  readonly webLayers: readonly MaskWebLayer[];
  /** Always true: the mask child is decorative BY CONSTRUCTION. */
  readonly maskChildHidden: boolean;
  /** Always true: `<masked>` changes appearance, not content. */
  readonly contentSemanticsPreserved: boolean;
}

export function resolveMask(mode: string | null | undefined, invert: boolean | string | null | undefined): MaskResolution {
  const word = (mode ?? "").trim();
  const resolved: MaskMode = word === "luminance" ? "luminance" : "alpha";
  const inverted = invert === true || String(invert ?? "").trim().toLowerCase() === "true";
  return {
    mode: resolved,
    invert: inverted,
    blend: inverted ? "dstOut" : "dstIn",
    cssMaskMode: resolved,
    webLayers: inverted
      ? [{ image: "opaque", composite: "add" }, { image: "mask", composite: "subtract" }]
      : [{ image: "mask", composite: "add" }],
    maskChildHidden: true,
    contentSemanticsPreserved: true,
  };
}
