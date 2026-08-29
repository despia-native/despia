//
//  fonts.ts — the shared font FACE-SELECTION core (parity/F01-fonts.md). The law is the corpus,
//  OpenSource/Conformance/fonts/matching.json; the Kotlin twin is :core StackFonts.kt and the
//  Swift twin is Engine/iOS/StackFonts.swift.
//
//  WHAT LIVES HERE: given a family's declared faces and a requested weight/italic, which face
//  renders — plus variable-axis clamping and the `fontVariation`/`fontFeature` string parsers.
//  All pure, all corpus-pinned, because a heading that comes out semibold on iOS and bold on
//  Android is precisely the drift one shared core exists to prevent.
//
//  WHAT LIVES OUTSIDE: loading the bytes, registering the face with the platform, and applying
//  the result (UIFont/ResourcesCompat/@font-face). The build (prepare_modules) extracts each
//  face's PostScript name, which is the value the platform actually wants and almost never the
//  family name the designer typed.
//

/** One declared face of a family. `file`/`postscriptName` are carried through untouched. */
export interface FontFace {
  readonly weight: number;
  readonly italic: boolean;
  readonly file?: string;
  readonly postscriptName?: string;
}

/** The face that will render, and whether the renderer must slant it itself. */
export interface FontSelection {
  readonly face: FontFace;
  /** True when italic was asked for and the family declares none, so the platform obliques it. */
  readonly synthesized: boolean;
}

/**
 * The CSS Fonts 4 weight-matching algorithm, over the weights available in one slant set.
 *
 * Deliberately NOT "nearest weight". In the 400–500 band the search goes UP to 500 first, which
 * is why a family shipping 400 and 700 renders **400** for a requested 500 and **700** for a
 * requested 501. Implementing the intuitive nearest-neighbour rule instead is the single most
 * common way a type ramp comes out wrong.
 */
export function matchFontWeight(available: readonly number[], desired: number): number | null {
  if (available.length === 0) return null;
  if (available.includes(desired)) return desired;

  const below = available.filter((w) => w < desired);
  const above = available.filter((w) => w > desired);
  const lower = (): number | null => (below.length ? Math.max(...below) : null);
  const higher = (): number | null => (above.length ? Math.min(...above) : null);

  if (desired >= 400 && desired <= 500) {
    const inBand = available.filter((w) => w >= desired && w <= 500);
    if (inBand.length) return Math.min(...inBand);
    const down = lower();
    if (down !== null) return down;
    const over = available.filter((w) => w > 500);
    return over.length ? Math.min(...over) : null;
  }
  if (desired < 400) return lower() ?? higher();
  return higher() ?? lower();
}

/**
 * Pick the face for a requested weight + slant.
 *
 * An exact slant match always wins, and the weight search runs WITHIN that slant set rather than
 * across both. Italic asked for with no italic face declared falls back to the matched upright
 * and reports `synthesized`, so the renderer obliques it and the build can warn once. Upright
 * asked for with only italic available uses the italic face rather than refusing: a rendered
 * wrong slant beats no text at all.
 */
export function selectFontFace(
  faces: readonly FontFace[],
  weight: number,
  italic: boolean,
): FontSelection | null {
  const preferred = faces.filter((f) => f.italic === italic);
  const pool = preferred.length ? preferred : faces.filter((f) => f.italic !== italic);
  if (pool.length === 0) return null;

  const matched = matchFontWeight(pool.map((f) => f.weight), weight);
  if (matched === null) return null;
  const face = pool.find((f) => f.weight === matched);
  if (!face) return null;
  return { face, synthesized: preferred.length === 0 && italic };
}

/** The resolved axis set, plus what the family refused and why. */
export interface FontVariationResolution {
  readonly applied: { readonly [axis: string]: number };
  /** Axes pushed back inside their declared range. Sorted, so the report is deterministic. */
  readonly clamped: readonly string[];
  /** Axes the family does not declare at all. Sorted. */
  readonly dropped: readonly string[];
}

/**
 * Parse a `fontVariation` string: `"wght 480, SOFT 40"`.
 *
 * Axis tags are case sensitive because OpenType defines them that way. A malformed pair is
 * dropped and the rest survive — one typo should not silently discard a whole declaration.
 */
export function parseFontVariation(input: string | null | undefined): { [axis: string]: number } {
  const out: { [axis: string]: number } = {};
  for (const chunk of String(input ?? "").split(",")) {
    const parts = chunk.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const [tag, raw] = parts as [string, string];
    if (tag === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    out[tag] = value;
  }
  return out;
}

/** Clamp requested axes against what the family declares. A static family drops every axis. */
export function resolveFontVariation(
  declared: { readonly [axis: string]: readonly [number, number] } | null | undefined,
  requested: { readonly [axis: string]: number },
): FontVariationResolution {
  const applied: { [axis: string]: number } = {};
  const clamped: string[] = [];
  const dropped: string[] = [];
  for (const tag of Object.keys(requested)) {
    const range = declared?.[tag];
    if (!range) { dropped.push(tag); continue; }
    const [min, max] = range;
    const value = requested[tag]!;
    if (value < min) { applied[tag] = min; clamped.push(tag); }
    else if (value > max) { applied[tag] = max; clamped.push(tag); }
    else applied[tag] = value;
  }
  return { applied, clamped: clamped.sort(), dropped: dropped.sort() };
}

/**
 * Parse a `fontFeature` string: `"tnum, ss01"`.
 *
 * An OpenType feature tag is exactly four characters; anything else is a typo and is dropped
 * rather than passed to the platform, which would ignore it silently. Duplicates collapse and
 * the first position wins, so the declaration reads in the order the author wrote it.
 */
export function parseFontFeatures(input: string | null | undefined): string[] {
  const out: string[] = [];
  for (const chunk of String(input ?? "").split(",")) {
    const tag = chunk.trim();
    if (tag.length !== 4) continue;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}
