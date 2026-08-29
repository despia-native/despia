//
//  length-units.ts - THE UNIT PLANE for authored lengths.
//
//  An editor that offers rem and px has to answer one question honestly: what happens to the
//  NUMBER when the unit changes. Two answers are possible and only one is defensible.
//
//    CONVERT       16px becomes 1rem. The rendered size does not move; the author changed how
//                  they want to SAY it. This is what a unit switch means everywhere else in
//                  design tooling, and it is what this module does.
//    REINTERPRET   16px becomes 16rem. The author asked to see the value in another unit and
//                  the headline became sixteen times larger.
//
//  REM IS THE DEFAULT, and that is a framework position rather than a preference: DSX-CSS
//  defines rem as "root = 16 x Dynamic Type / fontScale", so a length authored in rem is
//  accessibility-responsive by construction and the same length in px is frozen. A tool whose
//  default silently freezes type is a tool that teaches the wrong habit at scale.
//

/** The root the rem/px relationship is defined against (dsx-css-properties.json conventions). */
export const ROOT_FONT_SIZE_PX = 16;

/** Units a length control may be switched between. Percent and degree are deliberately absent:
 *  a percent is of its container and a degree is an angle, so neither has a rem equivalent and
 *  offering one would be a control that lies about what it does. */
export const SWITCHABLE_LENGTH_UNITS = ["rem", "px"] as const;
export type LengthUnit = (typeof SWITCHABLE_LENGTH_UNITS)[number];

export type ParsedLength = { value: number; unit: string } | null;

/** Split an authored length into its number and unit. Returns null for anything that is not a
 *  plain length - `calc(...)`, a token reference, an empty well - because those must pass
 *  through a unit switch untouched rather than being mangled into a number. */
export function parseLength(text: unknown): ParsedLength {
  if (typeof text === "number" && Number.isFinite(text)) return { value: text, unit: "" };
  if (typeof text !== "string") return null;
  const match = /^\s*(-?\d*\.?\d+)\s*([a-z%]*)\s*$/i.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: (match[2] ?? "").toLowerCase() };
}

/** Round to a readable precision: rem values carry decimals (0.9375rem is 15px) and a value
 *  printed to full float precision is unusable in a text well. */
function tidy(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Convert an authored length to `unit`, preserving the rendered size.
 *
 * A value that is already in the target unit is returned unchanged, so switching twice is
 * lossless. A value this module cannot parse is returned VERBATIM - a unit switch is never a
 * reason to destroy an expression the author wrote deliberately.
 */
export function convertLength(text: unknown, unit: LengthUnit): string {
  const parsed = parseLength(text);
  if (parsed === null) return typeof text === "string" ? text : "";
  const from = parsed.unit === "" ? "px" : parsed.unit;
  if (from === unit) return `${tidy(parsed.value)}${unit}`;
  // `em` is the element's own font size rather than the root, so it is not convertible without
  // knowing that font size: treat it as its own unit and only relabel when asked for rem, which
  // is the same number against the root the editor assumes.
  if (from !== "px" && from !== "rem" && from !== "em") return `${tidy(parsed.value)}${from}`;
  const px = from === "px" ? parsed.value : parsed.value * ROOT_FONT_SIZE_PX;
  const out = unit === "px" ? px : px / ROOT_FONT_SIZE_PX;
  return `${tidy(out)}${unit}`;
}

/** Which unit an authored length is written in, for a control that shows the active one.
 *  A bare number is px by CSS's own reading, but the editor WRITES rem, so an unparsed or
 *  empty value reports the default rather than pretending to know. */
export function lengthUnitOf(text: unknown, fallback: LengthUnit = "rem"): LengthUnit {
  const parsed = parseLength(text);
  if (parsed === null || parsed.unit === "") return fallback;
  if (parsed.unit === "px") return "px";
  if (parsed.unit === "rem" || parsed.unit === "em") return "rem";
  return fallback;
}

/** The unit the editor appends when an author types a bare number. */
export const DEFAULT_LENGTH_UNIT: LengthUnit = "rem";
