//
//  cssmap.ts - the shared style vocabulary: semantic color keywords → --dsx-* tokens
//  (the native StackStyle.color vocabulary, /web/17), and the legacy attribute bridge
//  INVERTED (native maps CSS→attr; web runs attr→CSS — /web/06). Used at build time
//  for static values and at runtime for `{{ }}`-reactive ones, so the two paths can
//  never disagree.
//

import { parseFontVariation, parseFontFeatures, resolveGradient } from "@despia/kernel";

export type Decl = [property: string, value: string];

/** the ONE cascade order, weakest → strongest (/web/17) — first statement wins */
export const LAYER_STATEMENT = "@layer dsx-tokens, dsx-elements, dsx-theme, dsx-sheets, dsx-inline, dsx-attrs;";

/** text-family semantic colors (color / tint / caret) */
const LABEL_TOKENS: { [k: string]: string } = {
  label: "var(--dsx-label)",
  secondary: "var(--dsx-secondary-label)",
  tertiary: "var(--dsx-tertiary-label)",
  quaternary: "var(--dsx-tertiary-label)",
  accent: "var(--dsx-accent)",
  destructive: "var(--dsx-destructive)",
  separator: "var(--dsx-separator)",
  fill: "var(--dsx-fill)",
};

/** surface-family semantic colors (background / border) — includes the corpus grouped
 *  surfaces (Conformance/defaults/tokens.json); `secondary`/`tertiary` stay as the
 *  pre-corpus aliases of the same custom properties */
const BACKGROUND_TOKENS: { [k: string]: string } = {
  background: "var(--dsx-background)",
  // The catalogue's own alias of `background` (stack-style-properties.json), and the word an
  // author who learned the vocabulary on iOS reaches for first. Without the row it reached the
  // browser verbatim as `background: systemBackground`, which is invalid and therefore silent.
  systemBackground: "var(--dsx-background)",
  // `clear` is the catalogue's transparent (#00000000). It matters most inside `gradient=`,
  // where a fade is a colour to `clear` and an unmapped word invalidates the WHOLE
  // linear-gradient() rather than one stop.
  clear: "transparent",
  groupedBackground: "var(--dsx-grouped-background)",
  secondaryGroupedBackground: "var(--dsx-secondary-grouped-background)",
  secondary: "var(--dsx-secondary-background)",
  tertiary: "var(--dsx-tertiary-background)",
  fill: "var(--dsx-fill)",
  accent: "var(--dsx-accent)",
  destructive: "var(--dsx-destructive)",
  separator: "var(--dsx-separator)",
  label: "var(--dsx-label)",
};

const COLOR_PROPS = new Set(["color", "caret-color", "tint", "stroke", "outline-color"]);
const BACKGROUND_PROPS = new Set([
  "background", "background-color", "fill",
  "border-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-inline-start-color", "border-inline-end-color", "border-block-start-color", "border-block-end-color",
]);

/** The border SHORTHANDS (wave-7 F6): `border-top: 1px solid separator` used to pass
 *  through unmapped — `separator` is no CSS color, so the browser dropped the whole
 *  declaration and authors stacked 1px hairline elements instead. The color TERM inside
 *  a border shorthand maps through the surface vocabulary exactly like `border-color`;
 *  width/style terms are never token words, so they pass untouched. */
const BORDER_SHORTHAND_PROPS = new Set([
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-inline", "border-block",
  "border-inline-start", "border-inline-end", "border-block-start", "border-block-end",
]);

/** Split a shorthand value into top-level terms — whitespace inside a function
 *  (`rgb(0 0 0 / .5)`, `var(--x, 1px)`, `color-mix(...)`) never splits. */
function shorthandTerms(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    if (depth === 0 && /\s/.test(ch)) {
      if (cur.length > 0) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// Characters that let a single declaration value escape into extra declarations or a
// rule/element breakout: `;` (add a declaration — e.g. a full-viewport overlay), `{`/`}`
// (close/open a rule), `<`/`>` (open a tag in a generated stylesheet). None occur in a
// legitimate single value (colors, lengths, calc(), var(), gradients), so stripping them
// neutralizes injection through a `{{ }}`-reactive style bound to untrusted data without
// touching any real value. HTML-escaping alone can't stop the `;`-injection (no HTML
// metacharacters are needed for it).
function neutralizeCssValue(v: string): string {
  return /[;{}<>]/.test(v) ? v.replace(/[;{}<>]/g, "") : v;
}

/** Map one CSS value through the semantic token vocabulary (per property family). */
function mapStyleValueFull(property: string, value: string): string {
  const v = neutralizeCssValue(value.trim());
  if (COLOR_PROPS.has(property) && LABEL_TOKENS[v] !== undefined) return LABEL_TOKENS[v]!;
  if (BACKGROUND_PROPS.has(property) && BACKGROUND_TOKENS[v] !== undefined) return BACKGROUND_TOKENS[v]!;
  if (BORDER_SHORTHAND_PROPS.has(property) && shorthandTerms(v).some((term) => BACKGROUND_TOKENS[term] !== undefined)) {
    return shorthandTerms(v).map((term) => BACKGROUND_TOKENS[term] ?? term).join(" ");
  }
  return v;
}

/** The RUNTIME STYLE-FORMULA fold (the `__DSX_OPTIONAL_JS_GLOBALS__` precedent): a build
 *  whose closed slice authors no `{{ }}` style/bridge formula, no semantic `color=`, and
 *  no bound rows (embed-entry.ts `registryUsesStyleFormulas`) can never map a style value
 *  at runtime, so the vocabulary tables and the bridge fold away. Static values were
 *  already mapped at BUILD time by the compiler, where the flag is never set. The absent
 *  twins stay fail-open (neutralized pass-through / no declarations), so a value that
 *  somehow arrives is inert, never unsafe. Unset (build time, full apps, every test) the
 *  exports are the full implementations. */
export const mapStyleValue: (property: string, value: string) => string =
  (globalThis as typeof globalThis & { __DSX_OPTIONAL_STYLE_FORMULAS__?: boolean })
    .__DSX_OPTIONAL_STYLE_FORMULAS__ !== false
    ? mapStyleValueFull
    : (_property: string, value: string) => neutralizeCssValue(value.trim());

/** Parse a `style=""` attribute into declarations (no nesting — inline declarations). */
export function parseStyleAttr(style: string): Decl[] {
  const out: Decl[] = [];
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const prop = part.substring(0, colon).trim().toLowerCase();
    const value = part.substring(colon + 1).trim();
    if (prop.length === 0 || value.length === 0) continue;
    out.push([prop, value]);
  }
  return out;
}

/** Split declarations into the static portion (build-time sheet) and the reactive
 *  portion (`{{ }}`-bearing — one runtime signal per declaration, /web/06). */
export function splitStyleAttr(style: string): { staticDecls: Decl[]; reactiveDecls: Decl[] } {
  const staticDecls: Decl[] = [];
  const reactiveDecls: Decl[] = [];
  for (const [prop, value] of parseStyleAttr(style)) {
    if (value.includes("{{")) reactiveDecls.push([prop, value]);
    else staticDecls.push([prop, mapStyleValue(prop, value)]);
  }
  return { staticDecls, reactiveDecls };
}

/** a numeric attr value → px; anything else passes through (injection-neutralized, since a
 *  reactive bridge attr like `padding="{{ x }}"` reaches here with untrusted data) */
function px(value: string): string {
  const v = value.trim();
  return /^-?\d+(\.\d+)?$/.test(v) ? `${v}px` : neutralizeCssValue(v);
}

const ALIGN_MAP: { [k: string]: Decl[] } = {
  center: [["align-items", "center"], ["justify-items", "center"], ["justify-content", "center"]],
  leading: [["align-items", "start"], ["justify-items", "start"]],
  trailing: [["align-items", "end"], ["justify-items", "end"]],
  top: [["align-items", "start"], ["justify-items", "center"]],
  bottom: [["align-items", "end"], ["justify-items", "center"]],
  topLeading: [["align-items", "start"], ["justify-items", "start"]],
  topTrailing: [["align-items", "start"], ["justify-items", "end"]],
  bottomLeading: [["align-items", "end"], ["justify-items", "start"]],
  bottomTrailing: [["align-items", "end"], ["justify-items", "end"]],
};

const FLEX_DIRECTIONS = new Set(["column", "row"]);
const ALIGN_ITEMS = new Set(["flex-start", "center", "flex-end", "baseline", "stretch"]);
const DISPLAYS = new Set(["flex", "grid"]);

/** The legacy attribute bridge, attr → declarations. Returns null when the attribute
 *  is not a style-bearing legacy attr (it's behavior/content — the element's business). */
function legacyAttrToDeclsFull(
  name: string,
  value: string,
  /** The element's other attributes, when the caller has them. Only the type family reads it:
   *  `dynamicType`/`dynamicTypeMax` are a STATIC opt-in that modifies `fontSize` rather than
   *  contributing declarations of their own, which is exactly how both native renderers read
   *  them. A caller with no map gets the un-opted-in fixed size, never a wrong one. */
  attrs?: Record<string, string | undefined>,
): Decl[] | null {
  switch (name) {
    case "grow":
      // axis-aware: emitted as data-dsx-grow + parent-axis child rules (theme layer),
      // because "grow along width" means MAIN axis in a row and CROSS in a column
      return [];
    case "align":
      return ALIGN_MAP[value] ?? [];
    case "flexDirection":
      return FLEX_DIRECTIONS.has(value) ? [["flex-direction", value]] : [];
    case "alignItems":
      return ALIGN_ITEMS.has(value) ? [["align-items", value]] : [];
    case "display":
      return DISPLAYS.has(value) ? [["display", value]] : [];
    case "padding": return [["padding", px(value)]];
    case "radius": return [["border-radius", px(value)]];
    case "background": return [["background", mapStyleValue("background", value)]];
    case "color": return [["color", mapStyleValue("color", value)]];
    case "spacing": return [["gap", px(value)]];
    case "aspectRatio": {
      // The native bridge runs CSS -> attr and normalizes "16 / 9" to "16:9" (CssBridge.kt /
      // CSSBridge.swift); the web runs attr -> CSS, so it normalizes back. A bare number is a
      // ratio against 1, which is what every renderer's parser already accepts.
      const raw = value.trim();
      const parts = raw.includes(":") ? raw.split(":") : raw.includes("/") ? raw.split("/") : [raw];
      const numbers = parts.map((part) => Number(part.trim()));
      if (numbers.length === 1 && Number.isFinite(numbers[0]!) && numbers[0]! > 0) {
        return [["aspect-ratio", `${numbers[0]!} / 1`]];
      }
      if (numbers.length === 2 && numbers.every((n) => Number.isFinite(n) && n > 0)) {
        return [["aspect-ratio", `${numbers[0]!} / ${numbers[1]!}`]];
      }
      return [];
    }
    // An explicit size is a FIXED frame on the native renderers (SwiftUI .frame(width:),
    // Compose Modifier.width) - it never shrinks under flex pressure. Every stack child
    // here carries `min-width: 0` (the wrap enabler text columns need), so a bare CSS
    // `width` silently loses to flex-shrink: a 44pt icon tile measured 33px the first time
    // a row ran out of room, and the stolen width read as a broken layout. Pinning the
    // minimum to the declared size restores the contract; an authored minWidth/minHeight
    // still wins (it maps after, and the author said so).
    case "width": {
      const w = px(value);
      return attrs?.["minWidth"] === undefined ? [["width", w], ["min-width", w]] : [["width", w]];
    }
    case "height": {
      const h = px(value);
      return attrs?.["minHeight"] === undefined ? [["height", h], ["min-height", h]] : [["height", h]];
    }
    case "opacity": return [["opacity", neutralizeCssValue(value.trim())]];
    // ---- the type attributes (Article 10) -------------------------------------------------
    // `fontSize`, `fontWeight`, `italic` and `letterSpacing` are style-catalogue attributes that
    // apply to any element and work on both native renderers. They were INERT here: not mapped,
    // not forwarded, not even present in the DOM, so a fixed size authored on the phone silently
    // became the theme's default in a browser. That is the defect Article 10 names.
    case "fontSize": {
      const size = value.trim();
      if (!/^-?\d+(\.\d+)?$/.test(size)) return [["font-size", neutralizeCssValue(size)]];
      if (attrs?.["dynamicType"] !== "true") return [["font-size", `${size}px`]];
      // DYNAMIC TYPE, polyfilled. Native scales a FIXED point size with the OS text-size ramp
      // (@ScaledMetric on iOS; .sp is scale-aware on Compose). A browser exposes no per-element
      // hook into that ramp - but `rem` IS the ramp, since the root font size is what browser
      // text scaling moves. Re-expressing the fixed size against it turns a global mechanism
      // into the per-element opt-in the attribute promises. At the default 16px root the
      // computed value is the SAME pixel count, so nothing moves for a reader who never
      // changed the setting; `dynamicTypeMax` is the cap on the scaled size, exactly as on iOS.
      const scaled = `calc(${size} / 16 * 1rem)`;
      const cap = attrs["dynamicTypeMax"]?.trim();
      const capped = cap !== undefined && /^-?\d+(\.\d+)?$/.test(cap);
      return [["font-size", capped ? `min(${scaled}, ${cap}px)` : scaled]];
    }
    case "fontWeight": {
      const w = neutralizeCssValue(value.trim());
      return [["font-weight", FONT_WEIGHTS[w] ?? (/^\d+$/.test(w) ? w : "400")]];
    }
    // A boolean attribute contributes NOTHING when false rather than `font-style: normal`, so it
    // cannot outrank an italic inherited from a class - the native `italic` is additive too.
    case "italic": return value.trim() === "true" ? [["font-style", "italic"]] : [];
    case "letterSpacing": return [["letter-spacing", px(value)]];
    // ---- the size, spacing and effect attributes (Article 10) --------------------------------
    // Every one of these is catalogued as applying to any element and works on both native
    // renderers; all of them were INERT here. The style-attribute oracle found 37 in one run,
    // which is what a catalogue with no per-renderer column costs.
    case "minWidth": return [["min-width", px(value)]];
    case "maxWidth": return [["max-width", px(value)]];
    case "minHeight": return [["min-height", px(value)]];
    case "maxHeight": return [["max-height", px(value)]];
    case "paddingH": return [["padding-inline", px(value)]];
    case "paddingV": return [["padding-block", px(value)]];
    case "paddingTop": return [["padding-top", px(value)]];
    case "paddingBottom": return [["padding-bottom", px(value)]];
    // LEADING/TRAILING are writing-direction words, not left/right: the logical property is the
    // only spelling that stays correct under RTL, which is what the native edges do too.
    case "paddingLeading": return [["padding-inline-start", px(value)]];
    case "paddingTrailing": return [["padding-inline-end", px(value)]];
    case "zIndex": return [["z-index", neutralizeCssValue(value.trim())]];
    case "blur": return [["filter", `blur(${px(value)})`]];
    case "tracking": return [["letter-spacing", px(value)]];
    // `lineSpacing` is EXTRA space between lines on both native renderers; CSS line-height is the
    // TOTAL. Adding it to one em is the polyfill, and it is exact for single-size text.
    case "lineSpacing": return [["line-height", `calc(1em + ${px(value)})`]];
    case "textAlign": return [["text-align", TEXT_ALIGNS[value.trim()] ?? neutralizeCssValue(value.trim())]];
    case "textCase": {
      const mapped = TEXT_CASES[value.trim()];
      return mapped === undefined ? [] : [["text-transform", mapped]];
    }
    case "fontDesign": {
      const mapped = FONT_DESIGNS[value.trim()];
      return mapped === undefined ? [] : [["font-family", mapped]];
    }
    // LIQUID GLASS. Both of these used to emit `-dsx-*` - the DSX-CSS AUTHORING spelling, which
    // our own sheet parser reads and a browser drops on the floor as an unknown vendor prefix. So
    // the pair was inert twice over: an invalid property, and no rule reading it either way. The
    // browser spelling is a real custom property, and the theme now resolves the glass fill
    // through it (Article 10 - both work on the three other renderers).
    case "glassTint": return [["--dsx-glass-tint", mapStyleValue("background", value.trim())]];
    // A FACTOR, not the authored boolean: the press rule multiplies by it, so a 0 leaves the
    // resting geometry exactly where it was and the rule needs no second selector to branch on.
    // Opt-in on "true" alone, matching the iOS reading (Stack.swift: #1002 defaulted it on for
    // every tappable and it leaked a stray platter, so it is per-element opt-in on all renderers).
    case "glassInteractive": return [["--dsx-glass-interactive", value.trim() === "true" ? "1" : "0"]];
    // Families that fold to ONE property, so every member returns the whole thing.
    case "rotation": case "scale": case "offsetX": case "offsetY": return transformDecls(attrs);
    case "shadow": case "shadowColor": case "shadowX": case "shadowY": return shadowDecls(attrs);
    case "borderWidth": case "borderColor": return borderDecls(attrs);
    case "underline": case "strikethrough": return decorationDecls(attrs);
    case "fontFamily":
      // The declared family FIRST, the platform stack last: the chain is declared, never
      // accidental, so an emoji or CJK glyph the brand face lacks falls through to the system
      // font instead of rendering a box. `system` is the reserved word for "no brand face".
      return value.trim() === "" || value.trim() === "system"
        ? [["font-family", "var(--dsx-font)"]]
        : [["font-family", `${quoteFamily(value.trim())}, var(--dsx-font)`]];
    case "fontVariation": {
      // Parsed by the SHARED core, so a malformed pair is dropped here exactly as it is on
      // iOS and Android (Conformance/fonts/matching.json `parse`). Clamping needs the family's
      // declared ranges, which live in the registry the native runtimes read; on the web the
      // font itself clamps, which is the same observable result.
      const axes = parseFontVariation(value);
      const settings = Object.keys(axes).map((tag) => `"${tag}" ${axes[tag]}`);
      return settings.length ? [["font-variation-settings", settings.join(", ")]] : [];
    }
    case "fontFeature": {
      const tags = parseFontFeatures(value);
      return tags.length ? [["font-feature-settings", tags.map((t) => `"${t}"`).join(", ")]] : [];
    }
    case "gradient": return gradientDecls(value, attrs);
    default:
      return null;
  }
}

/** The runtime half of the bridge, folded with mapStyleValue above: only `{{ }}`-reactive
 *  bridge attrs reach it at runtime (mount.ts), so the same slice fact folds it. */
export const legacyAttrToDecls: (
  name: string,
  value: string,
  attrs?: Record<string, string | undefined>,
) => Decl[] | null =
  (globalThis as typeof globalThis & { __DSX_OPTIONAL_STYLE_FORMULAS__?: boolean })
    .__DSX_OPTIONAL_STYLE_FORMULAS__ !== false
    ? legacyAttrToDeclsFull
    : () => null;

/** attrs the bridge consumes entirely (never forwarded to the DOM element) */
export const BRIDGE_ATTRS = new Set([
  "grow", "align", "padding", "radius", "background", "color", "spacing", "gradient",
  "width", "height", "aspectRatio", "opacity", "flexDirection", "alignItems", "display",
  "fontFamily", "fontVariation", "fontFeature",
  "fontSize", "fontWeight", "italic", "letterSpacing",
  "minWidth", "maxWidth", "minHeight", "maxHeight",
  "paddingH", "paddingV", "paddingTop", "paddingBottom", "paddingLeading", "paddingTrailing",
  "zIndex", "blur", "tracking", "lineSpacing", "textAlign", "textCase", "fontDesign",
  "glassTint", "glassInteractive",
  "rotation", "scale", "offsetX", "offsetY",
  "shadow", "shadowColor", "shadowX", "shadowY",
  "borderWidth", "borderColor", "underline", "strikethrough",
]);

/** Read as CONTEXT by the `gradient` case rather than contributing declarations of their own,
 *  which is how both native renderers read them too. Deliberately NOT in BRIDGE_ATTRS: they are
 *  not forwarded to the DOM (an unknown attribute is dropped) and they have no decls to fold. */
export const GRADIENT_MODIFIER_ATTRS: ReadonlySet<string> = new Set([
  "gradientDir", "gradientAngle", "gradientStops", "gradientType",
  "gradientCenter", "gradientRadius", "gradientPoints",
]);

/** Attributes a bridge fold READS but does not own. They never contribute declarations, so they
 *  are not BRIDGE_ATTRS - but a `{{ }}` in one still has to reach the fold RESOLVED, and
 *  `node.attrs` holds templates. Both call sites resolve these before folding, and both treat a
 *  dynamic one as making its owner dynamic; otherwise a computed `gradientStops` folds once
 *  against the literal text "{{ … }}", fails to parse, and silently becomes even spacing. */
export const BRIDGE_CONTEXT_ATTRS: ReadonlySet<string> = new Set([
  ...GRADIENT_MODIFIER_ATTRS, "dynamicType", "dynamicTypeMax",
  // The families that fold to one property: each member reads its siblings, so a reactive
  // sibling has to re-fold the whole family.
  "rotation", "scale", "offsetX", "offsetY",
  "shadow", "shadowColor", "shadowX", "shadowY",
  "borderWidth", "borderColor", "underline", "strikethrough",
]);

/** DSX named weight -> CSS number. The exact inverse of CSSBridge's CSS->named table (Kotlin
 *  CssBridge.kt and the Swift twin) and of StackStyle.weight, so a round trip is lossless:
 *  bold 700, semibold 600, medium 500, heavy 800 (Compose ExtraBold), everything else 400.
 *  `light` is not in the style catalogue's enum but IS a word the CSS->named direction
 *  produces, so it maps rather than silently resolving to regular. */
const FONT_WEIGHTS: { [k: string]: string } = {
  light: "300", regular: "400", medium: "500", semibold: "600", bold: "700", heavy: "800",
};


/** DSX `fontDesign` -> a CSS family stack. `rounded` has no web face to name, so it resolves to
 *  the platform sans exactly as it does on Compose (StackStyle.design's declared divergence):
 *  conjuring one would mean bundling a font, which is an app decision and never a kernel one. */
const FONT_DESIGNS: { [k: string]: string } = {
  serif: "ui-serif, Georgia, serif",
  monospaced: "ui-monospace, SFMono-Regular, Menlo, monospace",
  rounded: "var(--dsx-font)",
  default: "var(--dsx-font)",
};

const TEXT_ALIGNS: { [k: string]: string } = { leading: "start", center: "center", trailing: "end" };
const TEXT_CASES: { [k: string]: string } = { upper: "uppercase", lower: "lowercase" };

function num(value: string | undefined, fallback: number): number {
  // ABSENT IS NOT ZERO. `Number("")` is 0 and 0 is finite, so an unwritten attribute used to
  // return zero and the fallback argument was dead for every caller that wanted a non-zero one.
  // Two live defects came out of that: `scale` folded to `scale(0)`, which made ANY element
  // carrying `rotation`/`offsetX`/`offsetY` and no explicit scale collapse to nothing, and
  // `shadowY` defaulted to 0 where the other three renderers default to 2.
  const text = (value ?? "").trim();
  if (text === "") return fallback;
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

/** The TRANSFORM family folded into ONE declaration. Four attributes write one CSS property, so
 *  emitting them separately would make each overwrite the last; every member returns the same
 *  complete value instead. The order is the NATIVE ladder - rotation, then scale, then offset -
 *  which is the same order MotionCore decomposes a sampled transform into, so a keyframe and a
 *  static attribute compose identically. */
function transformDecls(attrs?: Record<string, string | undefined>): Decl[] {
  const rotation = num(attrs?.["rotation"], 0);
  const scale = num(attrs?.["scale"], 1);
  const x = num(attrs?.["offsetX"], 0);
  const y = num(attrs?.["offsetY"], 0);
  const parts: string[] = [];
  if (rotation !== 0) parts.push(`rotate(${rotation}deg)`);
  if (scale !== 1) parts.push(`scale(${scale})`);
  if (x !== 0 || y !== 0) parts.push(`translate(${x}px, ${y}px)`);
  return parts.length > 0 ? [["transform", parts.join(" ")]] : [];
}

/** The SHADOW family, likewise one declaration. `shadow` is the blur radius and its presence is
 *  what enables the shadow at all (the catalogue's own words), so the other three are inert
 *  without it - on every renderer. */
function shadowDecls(attrs?: Record<string, string | undefined>): Decl[] {
  const blur = attrs?.["shadow"];
  if (blur === undefined || blur.trim().length === 0) return [];
  const color = mapStyleValue("background", (attrs?.["shadowColor"] ?? "rgba(0,0,0,0.25)").trim());
  return [["box-shadow",
    `${num(attrs?.["shadowX"], 0)}px ${num(attrs?.["shadowY"], 2)}px ${num(blur, 0)}px ${color}`]];
}

/** `borderColor` needs `borderWidth` (the catalogue says so), and an authored width with no
 *  colour takes the separator, which is what both native renderers paint. */
function borderDecls(attrs?: Record<string, string | undefined>): Decl[] {
  const width = attrs?.["borderWidth"];
  if (width === undefined || width.trim().length === 0) return [];
  const color = mapStyleValue("border-color", (attrs?.["borderColor"] ?? "separator").trim());
  return [["border", `${num(width, 1)}px solid ${color}`]];
}

/** Two booleans, one CSS property: authored together they must BOTH show. */
function decorationDecls(attrs?: Record<string, string | undefined>): Decl[] {
  const lines: string[] = [];
  if (attrs?.["underline"] === "true") lines.push("underline");
  if (attrs?.["strikethrough"] === "true") lines.push("line-through");
  return lines.length > 0 ? [["text-decoration-line", lines.join(" ")]] : [];
}

/** GRADIENTS GO THROUGH THE SHARED CORE. `resolveGradient` (packages/kernel/src/controls-core.ts,
 *  with its Kotlin and Swift twins and the Conformance/controls corpus behind it) already folds
 *  the type, the colours, the stops, the angle, the centre, the radius and the mesh fallback.
 *  This bridge used to hardcode 180deg and drop the stops, and the first fix for that was a
 *  SECOND fold written here - a second opinion about a decision three languages already agree
 *  on, which is the thing the corpus exists to prevent. It is gone; only the CSS spelling of the
 *  resolved answer belongs in this file. */
/**
 * A radial gradient as a real CIRCLE, which is what all three other renderers paint
 * (`RadialGradient(startRadius:endRadius:)` on SwiftUI, `RadialGradientShader(radius)` on both
 * Compose lanes).
 *
 * The obvious spelling is a percentage radius, and it is INVALID CSS: a `circle` takes a length,
 * never a percentage, so `radial-gradient(circle 50% at …)` is dropped by the browser and the
 * element paints nothing. That is exactly what shipped here for one commit, and it is why this
 * function exists instead of a template string.
 *
 * `circle farthest-side` IS valid, and for a centred gradient its radius is max(width, height)/2 -
 * precisely half of what the shared core means by radius 1. So the RADIUS stays a keyword and the
 * fraction moves into the STOPS, scaled by 2r: CSS allows stop positions outside 0..100%, and a
 * circle of radius R with stops s is the same picture as a circle of radius R/k with stops s*k.
 * At the default radius of 0.5 the scale is 1 and this is byte-for-byte the native gradient.
 *
 * THE SEAM, named: `farthest-side` is measured from the CENTRE, so once `gradientCenter` moves off
 * the middle the browser's reference radius stops being max(width, height)/2 and the ramp
 * stretches toward the far side. CSS has no length that means "the box's longer side", so the
 * alternative would be an ellipse - a different SHAPE, which is a worse divergence than a circle
 * of a slightly different radius.
 */
function radial(
  radius: number, cx: number, cy: number,
  colors: readonly string[], stops: readonly number[],
): string {
  const scale = radius * 2;
  const ramp = colors.map((color, i) =>
    `${mapStyleValue("background", color.trim())} ${round4((stops[i] ?? 0) * scale * 100)}%`);
  return `radial-gradient(circle farthest-side at ${round4(cx * 100)}% ${round4(cy * 100)}%, ${ramp.join(", ")})`;
}

function gradientDecls(value: string, attrs?: Record<string, string | undefined>): Decl[] {
  const g = resolveGradient({
    gradient: value,
    gradientType: attrs?.["gradientType"] ?? null,
    gradientStops: attrs?.["gradientStops"] ?? null,
    gradientAngle: attrs?.["gradientAngle"] ?? null,
    gradientDir: attrs?.["gradientDir"] ?? null,
    gradientCenter: attrs?.["gradientCenter"] ?? null,
    gradientRadius: attrs?.["gradientRadius"] ?? null,
    gradientPoints: attrs?.["gradientPoints"] ?? null,
  });
  if (!g.valid) return [];
  // Stops are a FRACTION in the shared core and a PERCENTAGE in CSS, and they are emitted only
  // when the author actually moved one: at the default even spacing the position is what the
  // browser already computes, so printing it says the same thing in more bytes - and this file
  // is inside the widget byte law.
  const even = g.colors.length > 1
    ? g.colors.every((_, i) => Math.abs((g.stops[i] ?? 0) - i / (g.colors.length - 1)) < 1e-6)
    : true;
  const rendered = g.colors.map((c, i) => {
    const color = mapStyleValue("background", c.trim());
    return even ? color : `${color} ${round4((g.stops[i] ?? 0) * 100)}%`;
  });
  const cx = round4(g.center.x);
  const cy = round4(g.center.y);
  switch (g.type) {
    // 0deg is UP and clockwise in both vocabularies, so the angle carries across unchanged.
    case "radial":
      return [["background", radial(g.radius, cx, cy, g.colors, g.stops)]];
    case "angular":
      return [["background",
        `conic-gradient(from ${round4(g.angle)}deg at ${cx * 100}% ${cy * 100}%, ${rendered.join(", ")})`]];
    case "mesh": {
      // A real mesh needs iOS 18. Every other renderer paints the SAME pinned fallback the
      // native side paints below 18: a base fill plus one radial per control point, row-major.
      const fallback = g.meshFallback;
      if (fallback === null) break;
      // Row-major paint order, and CSS paints the FIRST background layer on top - which is the
      // same order the native fallback stacks them in, so the two agree without reversing.
      const layers = fallback.layers.map((layer) =>
        radial(layer.radius, layer.center.x, layer.center.y,
               [layer.color, "transparent"], [0, 1]));
      return [["background",
        `${layers.join(", ")}, ${mapStyleValue("background", fallback.base)}`]];
    }
    default: break;
  }
  return [["background", `linear-gradient(${round4(g.angle)}deg, ${rendered.join(", ")})`]];
}

/** Four decimals, the repository's shared spelling for a published number. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** A CSS family name needs quoting unless it is a bare identifier run. */
function quoteFamily(name: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) ? name : `"${name.replace(/"/g, '\\"')}"`;
}
