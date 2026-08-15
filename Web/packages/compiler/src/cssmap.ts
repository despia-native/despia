//
//  cssmap.ts - the shared style vocabulary: semantic color keywords → --dsx-* tokens
//  (the native StackStyle.color vocabulary, /web/17), and the legacy attribute bridge
//  INVERTED (native maps CSS→attr; web runs attr→CSS — /web/06). Used at build time
//  for static values and at runtime for `{{ }}`-reactive ones, so the two paths can
//  never disagree.
//

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
const BACKGROUND_PROPS = new Set(["background", "background-color", "border-color", "fill"]);

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
export function mapStyleValue(property: string, value: string): string {
  const v = neutralizeCssValue(value.trim());
  if (COLOR_PROPS.has(property) && LABEL_TOKENS[v] !== undefined) return LABEL_TOKENS[v]!;
  if (BACKGROUND_PROPS.has(property) && BACKGROUND_TOKENS[v] !== undefined) return BACKGROUND_TOKENS[v]!;
  return v;
}

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
export function legacyAttrToDecls(name: string, value: string): Decl[] | null {
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
    case "width": return [["width", px(value)]];
    case "height": return [["height", px(value)]];
    case "opacity": return [["opacity", neutralizeCssValue(value.trim())]];
    case "gradient": {
      // "a|b" → a simple top-to-bottom gradient (the native shorthand)
      const parts = value.split("|").map((p) => mapStyleValue("background", p.trim()));
      if (parts.length >= 2) return [["background", `linear-gradient(180deg, ${parts.join(", ")})`]];
      return [];
    }
    default:
      return null;
  }
}

/** attrs the bridge consumes entirely (never forwarded to the DOM element) */
export const BRIDGE_ATTRS = new Set([
  "grow", "align", "padding", "radius", "background", "color", "spacing", "gradient",
  "width", "height", "opacity", "flexDirection", "alignItems", "display",
]);
