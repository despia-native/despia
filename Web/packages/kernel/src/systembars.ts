//
//  systembars.ts — the SHARED PURE CORE behind Core/SystemBars (F17.5): what "hide the system
//  bars" and "go edge to edge" MEAN, decided once and run identically by all three renderers.
//
//  WHY THIS NEEDS A CORE. Android 15 makes edge-to-edge mandatory, which changes what a colour
//  on the navigation bar even does: the bar becomes transparent and the app draws under it, so
//  a `color` that used to paint a strip now paints nothing. iOS has no navigation bar at all,
//  but it has the home indicator, and hiding that is the same author intent expressed against a
//  different piece of hardware. If each platform decided those mappings locally, `immersive`
//  would mean three things and every app would carry a platform fork.
//
//  So this file owns: the closed vocabularies, the colour parser, the ICON-CONTRAST decision
//  (which is what `style: "auto"` really asks), the edge-to-edge interaction rules, and the
//  iOS mapping. Pinned by OpenSource/Conformance/systembars/bars.json.
//
//  THE LUMA FORMULA IS THE SIMPLE ONE, ON PURPOSE. WCAG relative luminance needs a per-channel
//  power function, and `Math.pow` / `StrictMath.pow` / `Foundation.pow` are not guaranteed to
//  agree to the last bit. A one-ULP difference at the threshold flips a bar's icons from black
//  to white on one platform only, which is exactly the drift this core exists to prevent. The
//  ITU-R BT.601 luma is a weighted sum of integers, exact in every language, and it decides
//  black-on-light versus white-on-dark correctly for every colour anyone puts on a system bar.
//

export const BAR_STYLES: readonly string[] = ["light", "dark", "auto"];
export const BAR_BEHAVIORS: readonly string[] = ["default", "swipe"];
export const IMMERSIVE_MODES: readonly string[] = ["none", "leanback", "sticky"];

/** Above this luma the background is "light", so the bar's icons must be dark. */
export const BAR_LUMA_THRESHOLD = 0.5;

export type BarRefusal = "unknown_style" | "unknown_behavior" | "unknown_mode" | "invalid_color";

export type BarResult<T> = { ok: true; value: T } | { ok: false; error: BarRefusal; detail?: string };

function fail<T>(error: BarRefusal, detail?: string): BarResult<T> {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

export interface BarColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0..255, so the whole colour is integers and no float ever crosses a language boundary */
  readonly a: number;
}

function foldWord(
  raw: unknown, vocabulary: readonly string[], fallback: string, refusal: BarRefusal,
): BarResult<string> {
  const text = String(raw ?? "").trim().toLowerCase().replace(/[\s\-_]/g, "");
  if (text.length === 0) return { ok: true, value: fallback };
  for (const word of vocabulary) {
    if (word === text) return { ok: true, value: word };
  }
  return fail(refusal, String(raw ?? ""));
}

export function foldBarStyle(raw: unknown): BarResult<string> {
  return foldWord(raw, BAR_STYLES, "auto", "unknown_style");
}

export function foldBarBehavior(raw: unknown): BarResult<string> {
  return foldWord(raw, BAR_BEHAVIORS, "default", "unknown_behavior");
}

export function foldImmersiveMode(raw: unknown): BarResult<string> {
  return foldWord(raw, IMMERSIVE_MODES, "none", "unknown_mode");
}

function hexDigit(c: string): number {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "a" && c <= "f") return c.charCodeAt(0) - 87;
  if (c >= "A" && c <= "F") return c.charCodeAt(0) - 55;
  return -1;
}

/**
 * Parse the colour spellings a Despia author already writes elsewhere: `#RGB`, `#RGBA`,
 * `#RRGGBB`, `#RRGGBBAA`, the legacy `R,G,B` triple that `bottombarcolor://` carried, and the
 * word `transparent`. Anything else is refused rather than silently becoming black: a bar that
 * quietly turns black is the hardest kind of styling bug to find, because it looks deliberate.
 */
export function parseBarColor(raw: unknown): BarResult<BarColor> {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return fail("invalid_color", "a colour is required");
  if (text.toLowerCase() === "transparent") return { ok: true, value: { r: 0, g: 0, b: 0, a: 0 } };

  if (text.startsWith("#")) {
    const body = text.slice(1);
    const digits: number[] = [];
    for (const c of body) {
      const d = hexDigit(c);
      if (d < 0) return fail("invalid_color", text);
      digits.push(d);
    }
    if (digits.length === 3 || digits.length === 4) {
      // Short form doubles each digit: #f0a is #ff00aa, the same rule CSS uses.
      const r = digits[0]! * 17;
      const g = digits[1]! * 17;
      const b = digits[2]! * 17;
      const a = digits.length === 4 ? digits[3]! * 17 : 255;
      return { ok: true, value: { r, g, b, a } };
    }
    if (digits.length === 6 || digits.length === 8) {
      const r = digits[0]! * 16 + digits[1]!;
      const g = digits[2]! * 16 + digits[3]!;
      const b = digits[4]! * 16 + digits[5]!;
      const a = digits.length === 8 ? digits[6]! * 16 + digits[7]! : 255;
      return { ok: true, value: { r, g, b, a } };
    }
    return fail("invalid_color", text);
  }

  if (text.includes(",")) {
    const parts = text.split(",").map((p) => p.trim());
    if (parts.length !== 3 && parts.length !== 4) return fail("invalid_color", text);
    const values: number[] = [];
    for (const part of parts) {
      if (part.length === 0 || !/^[0-9]+$/.test(part)) return fail("invalid_color", text);
      const n = Number(part);
      if (n > 255) return fail("invalid_color", text);
      values.push(n);
    }
    return {
      ok: true,
      value: { r: values[0]!, g: values[1]!, b: values[2]!, a: values.length === 4 ? values[3]! : 255 },
    };
  }

  return fail("invalid_color", text);
}

/** ITU-R BT.601 luma, 0..1. Integer weights, so three languages cannot disagree (see header). */
export function barLuma(color: BarColor): number {
  return (299 * color.r + 587 * color.g + 114 * color.b) / 255000;
}

/**
 * Should the bar's icons be dark? A light background needs dark icons and vice versa.
 *
 * A TRANSPARENT bar is the interesting case: there is no background to read, so the icons must
 * contrast with whatever the app draws underneath, which this core cannot see. The answer is
 * therefore the app's own appearance, passed in by the caller — never a guess.
 */
export function barIconsDark(color: BarColor, appearanceIsDark: boolean): boolean {
  if (color.a === 0) return !appearanceIsDark;
  return barLuma(color) > BAR_LUMA_THRESHOLD;
}

export interface BarPlan {
  /** are the bars on screen at all */
  readonly visible: boolean;
  /** `light` or `dark` — never `auto`; the plan is fully resolved */
  readonly style: string;
  readonly behavior: string;
  readonly immersive: string;
  readonly edgeToEdge: boolean;
  readonly color: BarColor;
  readonly dividerColor: BarColor;
  /** true when the resolved style means black icons on a light bar */
  readonly iconsDark: boolean;
  /** whether the app must inset its own content for the status bar */
  readonly insetTop: boolean;
  /** …and for the navigation bar */
  readonly insetBottom: boolean;
  /** iOS: what `immersive` maps onto, since there is no navigation bar to hide */
  readonly hidesHomeIndicator: boolean;
  /** stable codes for decisions the author did not ask for; never silent */
  readonly diagnostics: readonly string[];
}

export interface RawBarRequest {
  visible?: unknown;
  style?: unknown;
  behavior?: unknown;
  color?: unknown;
  dividerColor?: unknown;
  immersive?: unknown;
  edgeToEdge?: unknown;
  /** the app's current light/dark appearance, needed to contrast a transparent bar */
  appearanceIsDark?: unknown;
}

function truthy(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "boolean") return raw;
  const text = String(raw).trim().toLowerCase();
  if (text === "true" || text === "1" || text === "yes") return true;
  if (text === "false" || text === "0" || text === "no") return false;
  return fallback;
}

/**
 * Resolve a request into the plan every platform applies.
 *
 * THE THREE INTERACTIONS THAT MAKE THIS WORTH SHARING:
 *
 *  1. **Edge-to-edge wins over colour.** Android 15 forces transparent system bars, so a colour
 *     set alongside `edgeToEdge` paints nothing. The plan drops it and says
 *     `color_ignored_edge_to_edge` rather than letting the author believe it worked.
 *  2. **An immersive mode implies the bars are gone.** Asking for `leanback` while also asking
 *     for `visible: true` is a contradiction; the immersive mode wins (it is the more specific
 *     request) and `visible_overridden_by_immersive` is reported.
 *  3. **Hidden bars need no insets.** `insetTop` / `insetBottom` are what a layout actually
 *     consumes, and getting them from the same place as the visibility decision is what stops
 *     the classic "content under the notch after going fullscreen" bug.
 */
export function planSystemBars(raw: RawBarRequest): BarResult<BarPlan> {
  const styleWord = foldBarStyle(raw.style);
  if (styleWord.ok !== true) return fail(styleWord.error, styleWord.detail);
  const behavior = foldBarBehavior(raw.behavior);
  if (behavior.ok !== true) return fail(behavior.error, behavior.detail);
  const immersive = foldImmersiveMode(raw.immersive);
  if (immersive.ok !== true) return fail(immersive.error, immersive.detail);

  const edgeToEdge = truthy(raw.edgeToEdge, false);
  const appearanceIsDark = truthy(raw.appearanceIsDark, false);
  const diagnostics: string[] = [];

  let color: BarColor = { r: 0, g: 0, b: 0, a: 0 };
  if (raw.color !== undefined && raw.color !== null && String(raw.color).length > 0) {
    const parsed = parseBarColor(raw.color);
    if (parsed.ok !== true) return fail(parsed.error, parsed.detail);
    if (edgeToEdge) diagnostics.push("color_ignored_edge_to_edge");
    else color = parsed.value;
  }

  let dividerColor: BarColor = { r: 0, g: 0, b: 0, a: 0 };
  if (raw.dividerColor !== undefined && raw.dividerColor !== null && String(raw.dividerColor).length > 0) {
    const parsed = parseBarColor(raw.dividerColor);
    if (parsed.ok !== true) return fail(parsed.error, parsed.detail);
    if (edgeToEdge) diagnostics.push("divider_ignored_edge_to_edge");
    else dividerColor = parsed.value;
  }

  const requestedVisible = truthy(raw.visible, true);
  const immersiveHides = immersive.value !== "none";
  let visible = requestedVisible;
  if (immersiveHides && requestedVisible && raw.visible !== undefined && raw.visible !== null) {
    diagnostics.push("visible_overridden_by_immersive");
  }
  if (immersiveHides) visible = false;

  const iconsDark = styleWord.value === "auto"
    ? barIconsDark(color, appearanceIsDark)
    : styleWord.value === "dark";
  const resolvedStyle = iconsDark ? "dark" : "light";

  // Under edge-to-edge the app draws behind the bars, so it owns the insets even while they
  // are visible. Hidden bars consume nothing either way.
  const insets = visible && !edgeToEdge;

  return {
    ok: true,
    value: {
      visible,
      style: resolvedStyle,
      behavior: behavior.value,
      immersive: immersive.value,
      edgeToEdge,
      color,
      dividerColor,
      iconsDark,
      insetTop: insets,
      insetBottom: insets,
      hidesHomeIndicator: immersiveHides,
      diagnostics,
    },
  };
}

/** Human copy for each refusal, so three renderers apologise with one sentence. */
export const BAR_MESSAGES: Readonly<Record<BarRefusal, string>> = {
  unknown_style: "That is not a system-bar style. Use light, dark or auto.",
  unknown_behavior: "That is not a system-bar behavior. Use default or swipe.",
  unknown_mode: "That is not an immersive mode. Use none, leanback or sticky.",
  invalid_color: "That is not a colour. Use #RRGGBB, #RRGGBBAA, an R,G,B triple, or transparent.",
};

/** Human copy for each diagnostic, so a log line explains itself. */
export const BAR_DIAGNOSTICS: Readonly<Record<string, string>> = {
  color_ignored_edge_to_edge:
    "Edge-to-edge makes the system bars transparent, so the colour was not applied. Draw the colour in your own layout instead.",
  divider_ignored_edge_to_edge:
    "Edge-to-edge removes the navigation-bar divider, so the divider colour was not applied.",
  visible_overridden_by_immersive:
    "An immersive mode hides the system bars, so `visible: true` was overridden.",
};
