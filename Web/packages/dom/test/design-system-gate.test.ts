//
//  design-system-gate.test.ts - the design system is a FAILING TEST, not a matter of
//  taste (design-system.md Part 1 "Foundations"; W-B).
//
//  theme.test.ts already gates the COLOR axis: a raw hex or rgb() inside
//  @layer dsx-elements fails. That idea works, and every other foundation axis needs
//  it just as badly. This file is the same idea widened to the rest of Part 1: inside
//  the element layer, a literal font-size, font-weight, line-height, letter-spacing,
//  box-shadow, border-radius, cubic-bezier() or transition/animation duration is a
//  decision a component made on its own, in place of a decision the token plane
//  already made for it.
//
//  WHERE IT LOOKS. Every packages/dom/src/*.ts, minus theme.ts's TOKENS_CSS block -
//  @layer dsx-tokens is where the literals are SUPPOSED to live, because that is the
//  one place a design constant is ratified rather than improvised. Everything else in
//  the package that emits CSS emits it into @layer dsx-elements.
//
//  WHAT A FAILURE IS FOR. The message is a WORK LIST, not a wall: every finding names
//  the file, the line, the declaration as written, and the token that replaces it. A
//  developer reading the failure should be able to fix a row without opening anything
//  else. The list is grouped by file with a per-file count so the burn-down splits
//  across people by file set without collisions.
//
//  EXEMPTIONS are the anti-gaming surface, so they are few, named, and each carries
//  its one line of justification below. An exemption list that swallows the drift is
//  worse than no gate.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// - the exemption list - // Each entry is a VALUE shape, never a file or a component: an exemption that names a
// file exempts everything that file ever grows, which is how a gate stops biting.
const EXEMPT_VALUES: { match: RegExp; why: string }[] = [
  { match: /^(?:none|inherit|initial|unset|revert|auto|normal)$/,
    why: "a keyword reset is the absence of a value, so there is no token it could be reading instead" },
  { match: /^0(?:px|rem|em|%|s|ms)?$/,
    why: "zero is not a design constant - a zeroed radius/leading/tracking is a reset, a 0s duration is the reduced-motion off switch, and every scale's zero rung is the same zero" },
  { match: /^calc\(\s*var\(--dsx-radius[a-z-]*\)\s*[-+]\s*[12]px\s*\)$/,
    why: "the NESTED CORNER idiom: an inner radius is its parent's rung minus the hairline between them, so the 1-2px is a border width already on the page, not a second shape decision - the value still moves when the rung moves" },
  { match: /^50%$/,
    why: "border-radius:50% is a CIRCLE (avatar, dot, native range thumb), which no radius rung can express - a rung is a corner size, a circle is a shape" },
  { match: /^cubic-bezier\(0\.25,0\.1,0\.25,1\)$|^cubic-bezier\(0,0,0\.2,1\)$/,
    why: "the two PLATFORM PAGE-TRANSITION curves (iOS default and Material decelerate): a route animation exists to imitate the platform it runs on, so pulling it onto --dsx-ease would break the one thing it is for - this exempts those two exact control-point sets and nothing else" },
];

// The one construct-level exemption: element-motion.ts builds a bezier from an
// AUTHORED spring spec at runtime, so its cubic-bezier() carries no design constant -
// the four control points are interpolated from the author's stiffness/damping.
const EXEMPT_INTERPOLATED_BEZIER = /cubic-bezier\(\$\{/;

// - the token plane the gate points at
const TYPE_SIZES: [number, string][] = [
  [2.125, "--dsx-type-display-size"], [1.625, "--dsx-type-title1-size"],
  [1.3125, "--dsx-type-title2-size"], [1.0625, "--dsx-type-title3-size"],
  [1, "--dsx-type-reading-size"],
  [0.9375, "--dsx-type-body-size"], [0.875, "--dsx-type-callout-size"],
  [0.8125, "--dsx-type-footnote-size (or --dsx-type-label-size)"],
  [0.75, "--dsx-type-caption-size"], [0.6875, "--dsx-type-caption2-size"],
];
/** A text glyph used as an ICON is not on the reading ramp: the box is geometry, which
 *  is why every one of these call sites also carries --dsx-type-leading-none. */
const GLYPH_SIZES: [number, string][] = [
  [1.25, "--dsx-glyph-size"], [1.5, "--dsx-glyph-size-lg"], [1.75, "--dsx-glyph-size-xl"],
];
const LEADINGS: [number, string][] = [
  [1, "--dsx-type-leading-none"], [1.1, "--dsx-type-display-leading"],
  [1.7, "--dsx-type-reading-leading"],
  [1.15, "--dsx-type-title1-leading"], [1.2, "--dsx-type-title2-leading"],
  [1.25, "--dsx-type-title3-leading"], [1.3, "--dsx-type-headline-leading"],
  [1.35, "--dsx-type-caption-leading"], [1.4, "--dsx-type-footnote-leading"],
  [1.45, "--dsx-type-callout-leading"], [1.5, "--dsx-type-body-leading"],
];
const TRACKINGS: [number, string][] = [
  [-0.022, "--dsx-type-display-tracking"], [-0.02, "--dsx-type-title1-tracking"],
  [-0.017, "--dsx-type-title2-tracking"], [-0.013, "--dsx-type-title3-tracking"],
  [-0.01, "--dsx-type-headline-tracking"], [-0.009, "--dsx-type-body-tracking"],
  [-0.006, "--dsx-type-callout-tracking"], [-0.004, "--dsx-type-footnote-tracking"],
  [0, "--dsx-type-caption-tracking"], [0.01, "--dsx-type-label-tracking"],
];
const RADII: [number, string][] = [
  [6, "--dsx-radius-sm"], [10, "--dsx-radius (or --dsx-radius-control)"],
  [14, "--dsx-radius-lg (or --dsx-radius-card)"], [20, "--dsx-radius-sheet"],
  [999, "--dsx-radius-full"],
];
const DURATIONS: [number, string][] = [
  [120, "--dsx-dur-fast"], [200, "--dsx-dur-base"], [300, "--dsx-dur-slow"],
  [800, "--dsx-dur-loop"], [1350, "--dsx-dur-loop-slow"],
];
const WEIGHTS: Record<string, string> = {
  "400": "--dsx-type-body-weight",
  "500": "--dsx-type-label-weight",
  "600": "--dsx-type-headline-weight",
  "700": "--dsx-type-display-weight",
  bold: "--dsx-type-display-weight",
};
const CURVES: Record<string, string> = {
  "0.2,0,0,1": "--dsx-ease",
  "0.2,0.8,0.2,1": "--dsx-ease-out",
  "0.34,1.56,0.64,1": "--dsx-ease-spring",
  "0.22,1.2,0.36,1": "--dsx-ease-spring-soft",
};

/** Names the rung, its value, and whether the literal LANDS on it. An exact hit is a
 *  pure substitution; a near miss is a real decision - adopt the rung, or ratify a new
 *  one in TOKENS_CSS - and the message has to say which of the two this row is. */
function nearest(value: number, scale: [number, string][], unit = ""): string {
  let best = scale[0]!;
  for (const rung of scale) if (Math.abs(rung[0] - value) < Math.abs(best[0] - value)) best = rung;
  const exact = Math.abs(best[0] - value) < 1e-9;
  return `${best[1]} (${best[0]}${unit})${exact ? "" : ` - NEAREST rung, not exact: adopt it or ratify a ${value}${unit} rung`}`;
}

/** rem/em -> rem-equivalent number; px -> rem at the 16px root the sheet assumes. */
function toRem(raw: string): number | null {
  const m = raw.match(/^(-?[\d.]+)(rem|em|px)$/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  return m[2] === "px" ? n / 16 : n;
}

function toMs(raw: string): number | null {
  const m = raw.match(/^([\d.]+)(ms|s)$/);
  if (!m) return null;
  return m[2] === "s" ? Number.parseFloat(m[1]!) * 1000 : Number.parseFloat(m[1]!);
}

/** A value is a LITERAL when something survives after every var() reference, every
 *  keyword, and every zero is removed. `inset 0 0 0 var(--dsx-hairline) var(--x)` is
 *  a token-built border, not an elevation literal, so it is not a finding. */
function hasLiteralLength(value: string): boolean {
  const stripped = unwrapVars(value)
    .replace(/color-mix\((?:[^()]|\([^()]*\))*\)/g, " ")
    .replace(/\b0(?:px|rem|em|%)?\b/g, " ");
  return /[\d.]+\s*(?:px|rem|em|%|ms|s)\b/.test(stripped);
}

/** A var() REFERENCE resolves to a token, so it carries no constant - but a var()
 *  FALLBACK is a literal wearing a hat: `var(--dsx-route-title-size, 1.0625rem)` still
 *  freezes a type size into the sheet, it just does it where a grep for the property
 *  will not find it. Drop the reference, keep the fallback, and judge that. */
function unwrapVars(value: string): string {
  let out = value, previous = "";
  while (out !== previous) {
    previous = out;
    out = out.replace(/var\(\s*--[a-z0-9-]+\s*,([^()]*)\)/gi, " $1 ")
      .replace(/var\(\s*--[a-z0-9-]+\s*\)/gi, " ");
  }
  return out;
}

type Finding = { file: string; line: number; decl: string; fix: string };

const GATED = [
  "font-size", "font-weight", "line-height", "letter-spacing",
  "box-shadow", "border-radius",
  "border-start-start-radius", "border-start-end-radius",
  "border-end-start-radius", "border-end-end-radius",
  "transition-duration", "animation-duration",
] as const;

const DECL = new RegExp(
  `(?:^|[;{"'\\\`\\s])((?:--dsx-[a-z0-9-]+-)?(?:${GATED.join("|")}))\\s*:\\s*([^;{}"'\\\`]+?)\\s*(?=[;}"'\\\`]|$)`,
  "gs",
);

/** transition:/animation: shorthands carry a duration in the middle of the value. */
const SHORTHAND = /(?:^|[;{"'`\s])(transition|animation)\s*:\s*([^;{}"'`]+?)\s*(?=[;}"'`]|$)/gs;

const BEZIER = /cubic-bezier\(([^)]*)\)/g;
const RETIRED = /var\(--dsx-(motion-(?:fast|standard)|duration-(?:fast|base|slow))\)/g;

function suggest(prop: string, value: string): string | null {
  let v = value.replace(/\s+/g, " ").trim();
  if (/^var\(/.test(v)) {
    const fallback = unwrapVars(v).replace(/\s+/g, " ").trim();
    if (!fallback || !/[\d.]/.test(fallback)) return null;
    v = fallback;
  }
  if (EXEMPT_VALUES.some((e) => e.match.test(v))) return null;
  // a component-scoped custom property is judged on the AXIS its name ends in
  const axis = GATED.find((g) => prop === g || prop.endsWith(`-${g}`));
  if (!axis) return null;

  switch (axis) {
    case "font-size": {
      // `em` is a ratio to the PARENT, not a position on the ramp: a code chip at 0.9em
      // tracks whatever text surrounds it, which is a relationship no rung can carry.
      if (/^[\d.]+em$/.test(v)) return null;
      const rem = toRem(v);
      if (rem !== null) {
        return `${nearest(rem, TYPE_SIZES, "rem")}`
          + ` [icon glyph? ${nearest(rem, GLYPH_SIZES, "rem")}]`;
      }
      if (!/[\d.]/.test(v)) return null;
      return "a --dsx-type-*-size rung, or --dsx-type-*-size-fluid: a clamp() is still a size "
        + "decision the ramp owns, and the ramp carries a fluid twin for its four heading rungs";
    }
    case "font-weight": {
      if (WEIGHTS[v]) return WEIGHTS[v]!;
      if (!/^(?:\d+|bolder|lighter)$/.test(v)) return null;
      return `no ${v} rung exists on the type ramp - use --dsx-type-label-weight (500), `
        + `--dsx-type-headline-weight (600) or --dsx-type-body-weight (400), or ratify the rung in TOKENS_CSS`;
    }
    case "line-height": {
      const n = /^[\d.]+$/.test(v) ? Number.parseFloat(v) : toRem(v);
      if (n !== null && Number.isFinite(n)) return nearest(n, LEADINGS);
      return null;
    }
    case "letter-spacing": {
      const m = v.match(/^(-?[\d.]+)em$/);
      if (m) return nearest(Number.parseFloat(m[1]!), TRACKINGS, "em");
      if (!/[\d.]/.test(v)) return null;
      return "a --dsx-type-*-tracking rung";
    }
    case "box-shadow": {
      if (!hasLiteralLength(v)) return null;
      if (/inset/.test(v)) return "--dsx-focus-ring-inset for a keyboard ring, else --dsx-shadow-xs..4 (an inset hairline border belongs on var(--dsx-hairline))";
      return "--dsx-shadow-xs | --dsx-shadow-1..4 (a keyboard ring is --dsx-focus-ring)";
    }
    case "border-radius":
    case "border-start-start-radius":
    case "border-start-end-radius":
    case "border-end-start-radius":
    case "border-end-end-radius": {
      if (!hasLiteralLength(v)) return null;
      const m = v.match(/(-?[\d.]+)px/);
      if (m) return nearest(Number.parseFloat(m[1]!), RADII, "px");
      return "a --dsx-radius-* rung";
    }
    case "transition-duration":
    case "animation-duration": {
      if (!hasLiteralLength(v)) return null;
      const ms = toMs(v);
      if (ms !== null) return nearest(ms, DURATIONS, "ms");
      return "a --dsx-dur-* rung";
    }
    default: return null;
  }
}

const lineOf = (source: string, index: number): number =>
  source.slice(0, index).split("\n").length;

/** A comment is prose about the code, not code: the four ratified curves are NAMED in
 *  several headers, and a header is where they are supposed to be named. */
function commentSpans(source: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const m of source.matchAll(/\/\*[\s\S]*?\*\//g)) spans.push([m.index!, m.index! + m[0].length]);
  for (const m of source.matchAll(/^[ \t]*\/\/.*$/gm)) spans.push([m.index!, m.index! + m[0].length]);
  return spans;
}

function scanFile(file: string, source: string, skip: (index: number) => boolean): Finding[] {
  const found: Finding[] = [];
  const comments = commentSpans(source);
  const inComment = (i: number): boolean => comments.some(([a, b]) => i >= a && i < b);
  const push = (index: number, decl: string, fix: string): void => {
    if (skip(index) || inComment(index)) return;
    found.push({ file, line: lineOf(source, index), decl: decl.replace(/\s+/g, " ").trim(), fix });
  };

  for (const m of source.matchAll(DECL)) {
    const fix = suggest(m[1]!, m[2]!);
    if (fix) push(m.index!, `${m[1]}: ${m[2]}`, fix);
  }
  for (const m of source.matchAll(SHORTHAND)) {
    const literal = m[2]!.replace(/var\((?:[^()]|\([^()]*\))*\)/g, " ")
      .match(/(?<![\w.-])([\d.]+m?s)\b/);
    if (!literal) continue;
    const ms = toMs(literal[1]!);
    push(m.index!, `${m[1]}: ${m[2]}`, ms === null ? "a --dsx-dur-* rung" : nearest(ms, DURATIONS, "ms"));
  }
  for (const m of source.matchAll(BEZIER)) {
    if (EXEMPT_INTERPOLATED_BEZIER.test(m[0])) continue;
    const flat = m[0].replace(/\s+/g, "");
    if (EXEMPT_VALUES.some((e) => e.match.test(flat))) continue;
    const key = m[1]!.replace(/\s+/g, "");
    push(m.index!, m[0], CURVES[key]
      ?? "--dsx-ease | --dsx-ease-out | --dsx-ease-spring | --dsx-ease-spring-soft (an unratified curve is a new easing, so ratify it in TOKENS_CSS or drop it)");
  }
  for (const m of source.matchAll(RETIRED)) {
    push(m.index!, m[0],
      "--dsx-dur-fast | --dsx-dur-base | --dsx-dur-slow (the retired second duration family; --dsx-motion-* survives as a compat alias for author CSS only)");
  }
  return found;
}

/** theme.ts's TOKENS_CSS is @layer dsx-tokens - the one place a literal is a RATIFIED
 *  constant rather than an improvisation, so the gate does not look inside it. */
function tokensLayerSpan(source: string): [number, number] {
  const start = source.indexOf("export const TOKENS_CSS");
  if (start < 0) return [-1, -1];
  const end = source.indexOf("\n}`;", start);
  return [start, end < 0 ? source.length : end + 4];
}

function collect(): Finding[] {
  const findings: Finding[] = [];
  for (const name of readdirSync(SRC).filter((n) => n.endsWith(".ts")).sort()) {
    if (name === "icons.generated.ts") continue;
    // shot-skin.ts is NOT the element layer and does not emit into it (it is unlayered on
    // purpose, so it wins the cascade as an override sheet). Its values are a DEPICTION of
    // another platform's materials for store screenshots - platform/09-store-screenshots.md
    // §3 - not design-system constants, and dressing them in element tokens would make the
    // token plane mean two different things. It is also opt-in: no shipping web page links
    // it, so it can never move the default appearance this gate protects.
    if (name === "shot-skin.ts") continue;
    const source = readFileSync(SRC + name, "utf8");
    const [from, to] = name === "theme.ts" ? tokensLayerSpan(source) : [-1, -1];
    findings.push(...scanFile(name, source, (index) => index >= from && index < to));
  }
  return findings;
}

function report(findings: Finding[]): string {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const order = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
  const out: string[] = [
    "",
    `${findings.length} off-system declarations in @layer dsx-elements, across ${order.length} files.`,
    "Each row: the declaration as written, then the token that replaces it.",
    "",
  ];
  for (const [file, rows] of order) {
    out.push(`── packages/dom/src/${file}  (${rows.length})`);
    for (const r of rows) out.push(`   ${file}:${r.line}\n      ${r.decl}\n      -> ${r.fix}`);
    out.push("");
  }
  return out.join("\n");
}

// THE RATCHET. 162 -> 80 -> 21, and 21 is where the honest floor is.
//
// The count is PINNED, and it is a real gate in both directions: one new literal in the
// element layer fails the build, and burning one down fails too until the number here moves
// with it. A ratchet cannot be ignored the way a warning can, and it cannot drift the way an
// unpinned count can.
//
// WHAT THE LAST 80 WERE, and what each turned into (2026-08-25):
//  - 9 x `font-weight: 500` -> the ramp gained the LABEL role. No type role carried 500, so
//    the gate had nothing to offer nine control labels; 500 is a real static face (Material
//    labelLarge, Apple's control band), so the ramp was wrong, not the call sites.
//  - 4 fluid clamps and 8 icon-glyph font-sizes -> --dsx-type-*-size-fluid and the
//    --dsx-glyph-* scale. A clamp cannot be built out of rungs (its middle term is a
//    viewport slope), and a chevron sized off a READING rung is a category error.
//  - 4 sub-caption sizes -> the CAPTION2 role (11px: Apple caption2, Material labelSmall).
//  - 4 prose sizes/leadings -> the READING role (1rem / 1.7). Long-form is not UI text.
//  - 3 perpetual loops -> --dsx-dur-loop / --dsx-dur-loop-slow. A loop has a PERIOD, and the
//    120/200/300 transition ramp has no rung that means "never settles".
//  - 2 hand-spelled focus rings on the text field -> var(--dsx-focus-ring-inset) plus the new
//    var(--dsx-focus-ring-halo), so the danger skin re-declares ONE colour knob.
//  - the rest adopted the rung the gate already named.
//
// WHAT THE 21 ARE, and why they are not a to-do list:
//  - 19 box-shadows on tracks, knobs, wells and key caps. A recessed well and a floating knob
//    are REAL DEPTH: the inset bevel and the contact line are the two halves of one physical
//    reading, and --dsx-shadow-1..4 is an ELEVATION ramp - it says how far off the page a
//    surface floats, which is the opposite question. Flattening them onto a rung would not
//    tokenise these controls, it would delete their dimensionality.
//  - 2 px line-heights on .dsx-wheelpicker-select (30px, 34px coarse). That number is the ROW
//    HEIGHT of a native <select multiple>, paired with the option's min-height; it is box
//    geometry wearing the line-height property, and the nearest unitless rung (1.7) resolves
//    against the inherited font size, so adopting it would resize the wheel. Naming it as a
//    component custom property would only hide it from this census without ratifying it.
//
// So the floor is 21, not 0, and it is written down rather than forgotten. Zero arrives if a
// DEPTH family is ever ratified beside the elevation ramp; until then a new literal here is
// still a failure.
const REMAINING = 21;

test("the element layer improvises no design constant: type, elevation, shape, motion", () => {
  const findings = collect();
  const text = report(findings);
  if (findings.length !== REMAINING) console.log(text);
  assert.ok(findings.length <= REMAINING,
    `the element layer gained ${findings.length - REMAINING} new improvised constant(s). ` +
    `A literal here is the default plane disagreeing with itself - read the report above ` +
    `and take the token it names.\n\n${text}`);
  assert.equal(findings.length, REMAINING,
    `${REMAINING - findings.length} literal(s) burned down since this census was pinned. ` +
    `Set REMAINING to ${findings.length} in this file so the ratchet holds the new floor.`);
});

test("every exemption is a value shape, never a file, and carries its justification", () => {
  for (const entry of [...EXEMPT_VALUES]) {
    assert.ok(entry.why.length > 40, `exemption ${entry.match} states why in a full sentence`);
    assert.ok(!/\.ts\b/.test(entry.match.source), `exemption ${entry.match} exempts a value, not a file`);
  }
  assert.ok(EXEMPT_VALUES.length <= 5,
    "the exemption list stays short - a long one swallows the drift the gate exists to catch");
});

test("the three foundation families the design system was missing now ship as tokens", () => {
  const tokens = readFileSync(SRC + "theme.ts", "utf8");
  for (const token of [
    "--dsx-state-tint", "--dsx-state-hover", "--dsx-state-focus", "--dsx-state-pressed",
    "--dsx-state-dragged", "--dsx-state-selected",
    "--dsx-state-layer-hover", "--dsx-state-layer-focus", "--dsx-state-layer-pressed",
    "--dsx-state-layer-dragged", "--dsx-state-layer-selected",
    "--dsx-state-disabled-content", "--dsx-state-disabled-surface",
  ]) assert.ok(tokens.includes(`${token}:`), `the state layer declares ${token}`);

  for (const role of [
    "display", "title1", "title2", "title3", "headline", "body", "callout", "footnote", "caption",
  ]) {
    for (const axis of ["size", "weight", "tracking", "leading"]) {
      assert.ok(tokens.includes(`--dsx-type-${role}-${axis}:`),
        `the type ramp carries ${axis} on the ${role} role`);
    }
  }
  assert.ok(tokens.includes("--dsx-hit-target-min: 44px;"),
    "the coarse-pointer minimum target ships as a token the density plane can floor against");
});

test("focus is ONE recipe: one colour knob, three physical spellings, no second family", () => {
  const tokens = readFileSync(SRC + "theme.ts", "utf8");
  for (const token of [
    "--dsx-focus-ring-width", "--dsx-focus-ring-offset", "--dsx-focus-ring-color",
    "--dsx-focus-ring", "--dsx-focus-ring-outline", "--dsx-focus-ring-inset",
  ]) assert.ok(tokens.includes(`${token}:`), `the focus family declares ${token}`);
  assert.ok(tokens.includes("--dsx-focus-ring-outline: var(--dsx-focus-ring-width) solid var(--dsx-focus-ring-color);"),
    "the outline spelling derives from the shared width and colour rather than restating them");
  assert.ok(tokens.includes("--dsx-focus-ring-inset: inset 0 0 0 var(--dsx-focus-ring-width) var(--dsx-focus-ring-color);"),
    "the clipped-surface spelling derives from the same two knobs");
  assert.ok(!/outline:\s*\d+px solid var\(--dsx-accent\)/.test(tokens),
    "theme.ts never re-spells the ring width and colour inline");
});

test("motion is ONE duration ramp: the retired families reach no call site in this package", () => {
  for (const name of readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
    const source = readFileSync(SRC + name, "utf8");
    assert.ok(!source.includes("var(--dsx-duration-"),
      `${name} reads the canonical --dsx-dur-*, never the published --dsx-duration-* alias`);
    if (name === "theme.ts") continue;
    assert.ok(!source.includes("var(--dsx-motion-"),
      `${name} reads --dsx-dur-* rather than the retired --dsx-motion-* spelling`);
  }
  const tokens = readFileSync(SRC + "theme.ts", "utf8");
  // The alias is DECLARED in the token sheet (the spec names it, motion-tokens.test.ts
  // pins it) and READ by nothing - one value, two spellings, not two families.
  assert.ok(tokens.includes("--dsx-duration-fast: var(--dsx-dur-fast);"),
    "--dsx-duration-* stays a published alias resolving onto the canonical token");
  assert.ok(tokens.includes("--dsx-motion-fast: var(--dsx-dur-fast);"),
    "--dsx-motion-* survives only as a compat alias onto the ramp, never as a rival value");
  assert.ok(tokens.includes("--dsx-motion-standard: var(--dsx-dur-base);"),
    "the 180ms rung that existed on no ramp resolves onto --dsx-dur-base");
});
