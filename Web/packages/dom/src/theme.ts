//
//  theme.ts - the web system theme (/web/17 + system-defaults): the semantic token
//  sheet + the element base layer, shipped in the TWO WEAKEST cascade layers
//  (dsx-tokens, dsx-elements). Tokens carry the native semantic vocabulary; the
//  element layer styles the stable .dsx-* class contract USING TOKENS ONLY (hardcoded
//  colors fail the tokens-only gate). Author CSS — theme.css, sidecars, unlayered —
//  always wins.
//
//  Token VALUES are the web column of the SHARED corpus
//  OpenSource/Conformance/defaults/tokens.json (system-defaults.md): an HONEST
//  neutral skin — `color-scheme: light dark` + each corpus {light, dark} pair,
//  never fake-Cupertino. The pairs EMIT as floor-safe scheme TWINS (base :root
//  light values, an OS-dark media query, then full pin value tables — /web/17's
//  ratified shape; the same rules target :host inside an embed): the stamped browser
//  floor is last-2 evergreen + Safari 16.4
//  (/web/10 W0), and bare light-dark() needs Safari 17.5 — on 16.4–17.4 it would
//  leave every var(--dsx-*) invalid at computed-value time in BOTH schemes.
//  packages/dom/test/theme.test.ts is the drift gate: a value edited here without
//  the corpus (or vice versa) fails the suite.
//

export { FORM_ELEMENTS_CSS } from "./forms.ts";
export { STRUCTURAL_CONTROLS_CSS } from "./structural-controls.ts";
export { APPLICATION_CONTROLS_CSS } from "./application-controls.ts";

/** The explicit-scheme PIN TABLES ([data-dsx-theme] / :host twin rows). UNCONDITIONAL:
 *  the __DSX_OPTIONAL_THEME__-gated mount branch is not the only stamper — a third-party
 *  HOST page pins an embed's scheme by hand-writing the attribute (the Demo walk's
 *  host-pin gate), so a theme-less embed must still honor it. The define keeps gating
 *  the theme= mount machinery (mount.ts) only. */
const THEME_PIN_TABLES_CSS = `  [data-dsx-theme="dark"], :host([data-dsx-theme="dark"]) {
    color-scheme: dark;
    --dsx-label: #f4f4f5;
    --dsx-secondary-label: #a8a8b0;
    --dsx-tertiary-label: #92929c;
    --dsx-background: #101012;
    --dsx-grouped-background: #141416;
    --dsx-secondary-grouped-background: #1c1c1f;
    --dsx-fill: rgba(255, 255, 255, 0.09);
    --dsx-separator: rgba(255, 255, 255, 0.13);
    --dsx-accent: #6d8cff;
    --dsx-destructive: #ff6b6b;
    --dsx-on-accent: #080b14;
    --dsx-on-destructive: #180506;
    --dsx-control-knob: #f4f4f5;
    --dsx-inner-highlight: rgba(255, 255, 255, 0.10);
    --dsx-rating: #ffd60a;
    --dsx-focus-ring: 0 0 0 var(--dsx-focus-ring-width) var(--dsx-accent);
    --dsx-accent-hover: #7e9aff;
    --dsx-accent-pressed: #5d7ef4;
    --dsx-accent-muted: rgba(109, 140, 255, 0.16);
    --dsx-success: #51cf66;
    --dsx-success-muted: rgba(81, 207, 102, 0.14);
    --dsx-warning: #fcc419;
    --dsx-warning-muted: rgba(252, 196, 25, 0.13);
    --dsx-danger-muted: rgba(255, 107, 107, 0.14);
    --dsx-info: #22b8cf;
    --dsx-info-muted: rgba(34, 184, 207, 0.14);
    --dsx-shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.28), inset 0 0 1px rgba(255, 255, 255, 0.15);
    --dsx-shadow-1: 0 0 5px rgba(0, 0, 0, 0.18), 0 2px 10px rgba(0, 0, 0, 0.32), inset 0 0 1px rgba(255, 255, 255, 0.15);
    --dsx-shadow-2: 0 0 15px rgba(0, 0, 0, 0.20), 0 2px 30px rgba(0, 0, 0, 0.36), inset 0 0 1px rgba(255, 255, 255, 0.15);
    --dsx-shadow-3: 0 0 30px rgba(0, 0, 0, 0.22), 0 30px 60px rgba(0, 0, 0, 0.42), inset 0 0 1px rgba(255, 255, 255, 0.15);
    --dsx-shadow-4: 0 0 40px rgba(0, 0, 0, 0.24), 0 40px 80px rgba(0, 0, 0, 0.48), inset 0 0 1px rgba(255, 255, 255, 0.15);
  }
  [data-dsx-theme="light"], :host([data-dsx-theme="light"]) {
    color-scheme: light;
    --dsx-label: #17171b;
    --dsx-secondary-label: #5f6068;
    --dsx-tertiary-label: #6f7078;
    --dsx-background: #ffffff;
    --dsx-grouped-background: #f5f5f7;
    --dsx-secondary-grouped-background: #ffffff;
    --dsx-fill: rgba(17, 17, 24, 0.06);
    --dsx-separator: rgba(17, 17, 24, 0.13);
    --dsx-accent: #315cea;
    --dsx-destructive: #c92a2a;
    --dsx-on-accent: #ffffff;
    --dsx-on-destructive: #ffffff;
    --dsx-control-knob: #ffffff;
    --dsx-inner-highlight: rgba(255, 255, 255, 0.72);
    --dsx-rating: #b77900;
    --dsx-focus-ring: 0 0 0 var(--dsx-focus-ring-width) var(--dsx-accent);
    --dsx-accent-hover: #2b52d6;
    --dsx-accent-pressed: #2549c2;
    --dsx-accent-muted: rgba(49, 92, 234, 0.10);
    --dsx-success: #277c38;
    --dsx-success-muted: rgba(43, 138, 62, 0.10);
    --dsx-warning: #946300;
    --dsx-warning-muted: rgba(230, 119, 0, 0.10);
    --dsx-danger-muted: rgba(201, 42, 42, 0.10);
    --dsx-info: #0b7285;
    --dsx-info-muted: rgba(11, 114, 133, 0.10);
    --dsx-shadow-xs: 0 1px 2px rgba(17, 17, 24, 0.05), 0 0 1px rgba(17, 17, 24, 0.3);
    --dsx-shadow-1: 0 0 5px rgba(17, 17, 24, 0.02), 0 2px 10px rgba(17, 17, 24, 0.06), 0 0 1px rgba(17, 17, 24, 0.3);
    --dsx-shadow-2: 0 0 15px rgba(17, 17, 24, 0.03), 0 2px 30px rgba(17, 17, 24, 0.08), 0 0 1px rgba(17, 17, 24, 0.3);
    --dsx-shadow-3: 0 0 30px rgba(17, 17, 24, 0.04), 0 30px 60px rgba(17, 17, 24, 0.12), 0 0 1px rgba(17, 17, 24, 0.3);
    --dsx-shadow-4: 0 0 40px rgba(17, 17, 24, 0.05), 0 40px 80px rgba(17, 17, 24, 0.16), 0 0 1px rgba(17, 17, 24, 0.3);
  }
  ` +
// A SUBTREE pin re-asserts its own ink (wave-7 F2): default text color is INHERITED
// from the app root, where var(--dsx-label) resolved against the ROOT scheme — a
// nested [data-dsx-theme] swaps the tokens but inherited ink keeps the outer value.
// Weakest layer + (0,1,0) specificity: any component rule that sets color wins.
`  [data-dsx-theme], :host([data-dsx-theme]) {
    color: var(--dsx-label);
  }
`;

/** The density= PIN TABLES ([data-dsx-density] / :host twin rows) — the subtree knob's
 *  token overrides (shared law: input/density.json; the theme-pin mechanism). Only the
 *  __DSX_OPTIONAL_DENSITY__-gated mount branch ever stamps the attribute, so the same
 *  define drops these tables from an embed that authors no density=. Each table is the
 *  FULL density plane plus the derived radius tokens re-declared (custom properties
 *  inherit COMPUTED, so a pinned --dsx-radius needs --dsx-radius-control re-derived at
 *  the pin element). Unset (every full app, SSR, every test) => byte-identical. */
/** The sampled linear() upgrade of the two spring easings. Bezier fallbacks stay
 *  in the shared token plane (the pre-linear() floor); this block is the unique
 *  float table that only a consumer of `--dsx-ease-spring*` can reach. The same
 *  `__DSX_OPTIONAL_SPRING__` define that a sliced embed sets false when it
 *  imports none of those consumers drops the table. Unset (every full app, SSR,
 *  every test) ⇒ TOKENS_CSS is byte-identical. */
const SPRING_LINEAR_CSS = `  /* real springs (damping .8/.9); the beziers above are the pre-linear() floor */
  @supports (transition-timing-function: linear(0, 1)) {
    :root, :host, [data-dsx-theme] {
      --dsx-ease-spring: linear(0,.069,.221,.396,.562,.701,.81,.89,.945,.98,1,1.011,1.015,1.015,1.013,1.011,1.008,1.006,1.004,1.002,1.001,1.001,1,1,1);
      --dsx-ease-spring-soft: linear(0,.068,.212,.375,.527,.656,.758,.836,.892,.932,.959,.976,.988,.994,.998,1,1.001,1.002,1.001,1.001,1.001,1.001,1.001,1,1);
    }
  }
`;

/** The toggle / slider / field / textarea METRICS of the unconditional density plane.
 *  OPTIONAL: unlike the radius, gap and control-height rows beside them these size ONE
 *  control each, and their only consumers are CONTROL_ELEMENTS_CSS, forms.ts,
 *  native-controls.ts and globals.ts — a slice that imports none of those sheets can
 *  reach no rule that names one, so it was shipping 28 declarations nothing could read.
 *  Author-facing tokens stay out of here on purpose: a sheet may name --dsx-space-*,
 *  --dsx-shadow-* or --dsx-control-height, so those remain unconditional, and the embed
 *  builder keeps the fold true whenever the slice mentions one of these names itself.
 *  The density PIN TABLES restate the same rows and need no guard of their own —
 *  __DSX_OPTIONAL_DENSITY__ already drops the whole table.
 *  Unset (every full app, SSR, every test) ⇒ TOKENS_CSS is byte-identical. */
const CONTROL_METRICS_CSS = `    --dsx-toggle-track-width: 63px;
    --dsx-toggle-track-height: 28px;
    --dsx-toggle-thumb-width: 36px;
    --dsx-toggle-thumb-size: 24px;
    --dsx-toggle-thumb-inset: 2px;
    --dsx-toggle-travel: calc(var(--dsx-toggle-track-width) - var(--dsx-toggle-thumb-width) - 2 * var(--dsx-toggle-thumb-inset));
    --dsx-toggle-box-width: var(--dsx-toggle-track-width);
    --dsx-toggle-box-height: var(--dsx-toggle-track-height);
    --dsx-slider-track-size: 4px;
    --dsx-slider-thumb-size: 22px;
    --dsx-slider-box-height: var(--dsx-control-height-lg);
    --dsx-field-density-pad: 0.875rem;
    --dsx-field-density-type: 1rem;
    --dsx-textarea-density-pad-block: 0.625rem;
`;

/** The same metrics at the desktop fine-pointer default, folded by the same define. */
const CONTROL_METRICS_COMPACT_CSS = `      --dsx-toggle-track-width: 51px;
      --dsx-toggle-track-height: 24px;
      --dsx-toggle-thumb-width: 30px;
      --dsx-toggle-thumb-size: 20px;
      --dsx-toggle-thumb-inset: 2px;
      --dsx-toggle-travel: calc(var(--dsx-toggle-track-width) - var(--dsx-toggle-thumb-width) - 2 * var(--dsx-toggle-thumb-inset));
      --dsx-toggle-box-width: var(--dsx-toggle-track-width);
      --dsx-toggle-box-height: var(--dsx-toggle-track-height);
      --dsx-slider-track-size: 3px;
      --dsx-slider-thumb-size: 18px;
      --dsx-slider-box-height: var(--dsx-control-height);
      --dsx-field-density-pad: 0.75rem;
      --dsx-field-density-type: 0.875rem;
      --dsx-textarea-density-pad-block: 0.5rem;
`;

const DENSITY_PIN_TABLES_CSS = `  [data-dsx-density="comfortable"], :host([data-dsx-density="comfortable"]) {
    --dsx-radius: 10px;
    --dsx-radius-lg: 14px;
    --dsx-radius-control: var(--dsx-radius);
    --dsx-radius-card: var(--dsx-radius-lg);
    --dsx-gap: 8px;
    --dsx-control-height-sm: 32px;
    --dsx-control-height: 40px;
    --dsx-control-height-lg: 48px;
    --dsx-control-padding-inline: 0.875rem;
    --dsx-control-gap: 0.5rem;
    --dsx-button-density-pad: var(--dsx-control-padding-inline);
    --dsx-button-density-pad-strong: 1rem;
    --dsx-button-density-type: var(--dsx-type-headline-size);
    --dsx-button-density-radius: var(--dsx-radius-control);
    --dsx-toggle-track-width: 63px;
    --dsx-toggle-track-height: 28px;
    --dsx-toggle-thumb-width: 36px;
    --dsx-toggle-thumb-size: 24px;
    --dsx-toggle-thumb-inset: 2px;
    --dsx-toggle-travel: calc(var(--dsx-toggle-track-width) - var(--dsx-toggle-thumb-width) - 2 * var(--dsx-toggle-thumb-inset));
    --dsx-toggle-box-width: var(--dsx-toggle-track-width);
    --dsx-toggle-box-height: var(--dsx-toggle-track-height);
    --dsx-slider-track-size: 4px;
    --dsx-slider-thumb-size: 22px;
    --dsx-slider-box-height: var(--dsx-control-height-lg);
    --dsx-field-density-pad: 0.875rem;
    --dsx-field-density-type: 1rem;
    --dsx-textarea-density-pad-block: 0.625rem;
  }
  [data-dsx-density="compact"], :host([data-dsx-density="compact"]) {
    --dsx-radius: 8px;
    --dsx-radius-lg: 12px;
    --dsx-radius-control: var(--dsx-radius);
    --dsx-radius-card: var(--dsx-radius-lg);
    --dsx-gap: 6px;
    --dsx-control-height-sm: 28px;
    --dsx-control-height: 32px;
    --dsx-control-height-lg: 36px;
    --dsx-control-padding-inline: 0.75rem;
    --dsx-control-gap: 0.375rem;
    --dsx-button-density-pad: 0.625rem;
    --dsx-button-density-pad-strong: 0.75rem;
    --dsx-button-density-type: 0.8125rem;
    --dsx-button-density-radius: var(--dsx-radius-sm);
    --dsx-toggle-track-width: 51px;
    --dsx-toggle-track-height: 24px;
    --dsx-toggle-thumb-width: 30px;
    --dsx-toggle-thumb-size: 20px;
    --dsx-toggle-thumb-inset: 2px;
    --dsx-toggle-travel: calc(var(--dsx-toggle-track-width) - var(--dsx-toggle-thumb-width) - 2 * var(--dsx-toggle-thumb-inset));
    --dsx-toggle-box-width: var(--dsx-toggle-track-width);
    --dsx-toggle-box-height: var(--dsx-toggle-track-height);
    --dsx-slider-track-size: 3px;
    --dsx-slider-thumb-size: 18px;
    --dsx-slider-box-height: var(--dsx-control-height);
    --dsx-field-density-pad: 0.75rem;
    --dsx-field-density-type: 0.875rem;
    --dsx-textarea-density-pad-block: 0.5rem;
  }
`;

export const TOKENS_CSS = `@layer dsx-tokens {
  :root, :host {
    color-scheme: light dark;
    --dsx-label: #17171b;
    --dsx-secondary-label: #5f6068;
    --dsx-tertiary-label: #6f7078;
    --dsx-background: #ffffff;
    --dsx-grouped-background: #f5f5f7;
    --dsx-secondary-grouped-background: #ffffff;
    --dsx-fill: rgba(17, 17, 24, 0.06);
    --dsx-separator: rgba(17, 17, 24, 0.13);
    --dsx-accent: #315cea;
    --dsx-destructive: #c92a2a;
    --dsx-on-accent: #ffffff;
    --dsx-on-destructive: #ffffff;
    --dsx-control-knob: #ffffff;
    --dsx-inner-highlight: rgba(255, 255, 255, 0.72);
    --dsx-radius-sm: 6px;
    --dsx-radius: 10px;
    --dsx-radius-lg: 14px;
    --dsx-gap: 8px;
    --dsx-control-height: 40px;
` +
// "InterVariable" first, the previous system stack unchanged behind it. The face is
// BUNDLED (OpenSource/Type - one variable file per unicode-range, opsz 14..32 and
// wght 100..900) but it is NOT declared here: a src: url() inside this sheet would
// have to resolve from an SSR page head, a boot-injected <style>, a shadow root and a
// WKWebView, and would ship the bytes again on every SSR page. A surface links
// OpenSource/Type/inter.css once instead, and one that does not renders exactly as it
// did before - which is also what a 404 or a slow network gets, because every face in
// that sheet is font-display: swap. The ramp below names 400/500/600/700 and the
// static system faces on Windows 10 and the common Linux fontconfig answer cannot
// render 500 or 600; with the face loaded, every weight it names is real.
`    --dsx-font: "InterVariable", "Inter Variable", Inter, system-ui, "Segoe UI", Roboto, sans-serif;
    --dsx-rating: #b77900;
    --dsx-focus-ring: 0 0 0 var(--dsx-focus-ring-width) var(--dsx-accent);
    --dsx-accent-hover: #2b52d6;
    --dsx-accent-pressed: #2549c2;
    --dsx-accent-muted: rgba(49, 92, 234, 0.10);
    --dsx-success: #277c38;
    --dsx-success-muted: rgba(43, 138, 62, 0.10);
    --dsx-warning: #946300;
    --dsx-warning-muted: rgba(230, 119, 0, 0.10);
    --dsx-danger-muted: rgba(201, 42, 42, 0.10);
    --dsx-info: #0b7285;
    --dsx-info-muted: rgba(11, 114, 133, 0.10);
` +
// Elevation: every level is 3 layers, ambient wash + directional drop + a 1px
// CONTACT LINE (light) or an inset 1px INNER HIGHLIGHT (dark). The contact line
// replaces hard borders on elevated surfaces; xs is the field-well whisper.
`    --dsx-shadow-xs: 0 1px 2px rgba(17, 17, 24, 0.05), 0 0 1px rgba(17, 17, 24, 0.3);
    --dsx-shadow-1: 0 0 5px rgba(17, 17, 24, 0.02), 0 2px 10px rgba(17, 17, 24, 0.06), 0 0 1px rgba(17, 17, 24, 0.3);
    --dsx-shadow-2: 0 0 15px rgba(17, 17, 24, 0.03), 0 2px 30px rgba(17, 17, 24, 0.08), 0 0 1px rgba(17, 17, 24, 0.3);
    --dsx-shadow-3: 0 0 30px rgba(17, 17, 24, 0.04), 0 30px 60px rgba(17, 17, 24, 0.12), 0 0 1px rgba(17, 17, 24, 0.3);
    --dsx-shadow-4: 0 0 40px rgba(17, 17, 24, 0.05), 0 40px 80px rgba(17, 17, 24, 0.16), 0 0 1px rgba(17, 17, 24, 0.3);
  }
  @media (prefers-color-scheme: dark) {
    :root, :host {
      --dsx-label: #f4f4f5;
      --dsx-secondary-label: #a8a8b0;
      --dsx-tertiary-label: #92929c;
      --dsx-background: #101012;
      --dsx-grouped-background: #141416;
      --dsx-secondary-grouped-background: #1c1c1f;
      --dsx-fill: rgba(255, 255, 255, 0.09);
      --dsx-separator: rgba(255, 255, 255, 0.13);
      --dsx-accent: #6d8cff;
      --dsx-destructive: #ff6b6b;
      --dsx-on-accent: #080b14;
      --dsx-on-destructive: #180506;
      --dsx-control-knob: #f4f4f5;
      --dsx-inner-highlight: rgba(255, 255, 255, 0.10);
      --dsx-rating: #ffd60a;
      --dsx-accent-hover: #7e9aff;
      --dsx-accent-pressed: #5d7ef4;
      --dsx-accent-muted: rgba(109, 140, 255, 0.16);
      --dsx-success: #51cf66;
      --dsx-success-muted: rgba(81, 207, 102, 0.14);
      --dsx-warning: #fcc419;
      --dsx-warning-muted: rgba(252, 196, 25, 0.13);
      --dsx-danger-muted: rgba(255, 107, 107, 0.14);
      --dsx-info: #22b8cf;
      --dsx-info-muted: rgba(34, 184, 207, 0.14);
      --dsx-shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.28), inset 0 0 1px rgba(255, 255, 255, 0.15);
      --dsx-shadow-1: 0 0 5px rgba(0, 0, 0, 0.18), 0 2px 10px rgba(0, 0, 0, 0.32), inset 0 0 1px rgba(255, 255, 255, 0.15);
      --dsx-shadow-2: 0 0 15px rgba(0, 0, 0, 0.20), 0 2px 30px rgba(0, 0, 0, 0.36), inset 0 0 1px rgba(255, 255, 255, 0.15);
      --dsx-shadow-3: 0 0 30px rgba(0, 0, 0, 0.22), 0 30px 60px rgba(0, 0, 0, 0.42), inset 0 0 1px rgba(255, 255, 255, 0.15);
      --dsx-shadow-4: 0 0 40px rgba(0, 0, 0, 0.24), 0 40px 80px rgba(0, 0, 0, 0.48), inset 0 0 1px rgba(255, 255, 255, 0.15);
    }
  }
${THEME_PIN_TABLES_CSS}  :root, :host, [data-dsx-theme] {
    --dsx-secondary-background: var(--dsx-grouped-background);
    --dsx-tertiary-background: var(--dsx-secondary-grouped-background);
    --dsx-switch-on: var(--dsx-accent);
    --dsx-surface-level-1: var(--dsx-grouped-background);
    --dsx-surface-level-2: var(--dsx-secondary-grouped-background);
    --dsx-surface-level-3: color-mix(in srgb, var(--dsx-secondary-grouped-background) 94%, var(--dsx-label));
    --dsx-surface-cut: color-mix(in srgb, var(--dsx-grouped-background) 88%, var(--dsx-fill));
    --dsx-surface-base: var(--dsx-background);
    --dsx-surface-raised: var(--dsx-surface-level-2);
    --dsx-surface-recessed: var(--dsx-surface-cut);
    --dsx-surface-highlight: color-mix(in srgb, var(--dsx-surface-level-2) 86%, var(--dsx-control-knob));
    --dsx-control-knob-shadow: color-mix(in srgb, var(--dsx-control-knob) 88%, var(--dsx-background));
    --dsx-hairline: 1px;
` +
// THE ONE FOCUS RECIPE (web-face F3): 2px line, 2px offset, focus-visible only,
// z-raised. ONE colour knob feeds all three physical spellings, so a tinted
// control re-declares --dsx-focus-ring-color once instead of hand-writing a ring:
// - outward, unclipped, forced-colors-safe  -> outline: var(--dsx-focus-ring-outline)
// - outward, flush, composes with a shadow  -> box-shadow: var(--dsx-focus-ring), ...
// - a clipped or edge-to-edge surface       -> box-shadow: var(--dsx-focus-ring-inset)
// - the soft halo a field pairs with a ring -> box-shadow: ..., var(--dsx-focus-ring-halo)
// Four spellings, not four decisions: the width, the offset and the colour are
// decided once here, and the halo is the ring's own width plus a pixel at 20% of the
// same ink, so a danger field re-declares the colour and both follow. Neither of the
// two outward spellings can be deleted - the DSX-CSS catalog is
// closed and carries box-shadow but no outline (so box-shadow is the portable
// one), while forced-colors mode paints outline and drops box-shadow entirely
// (so outline is the accessible one), and an inset ring is the only ring an
// overflow-clipped surface can show at all.
`    --dsx-focus-ring-width: 2px;
    --dsx-focus-ring-offset: 2px;
    --dsx-focus-ring-color: var(--dsx-accent);
    --dsx-focus-ring-outline: var(--dsx-focus-ring-width) solid var(--dsx-focus-ring-color);
    --dsx-focus-ring-inset: inset 0 0 0 var(--dsx-focus-ring-width) var(--dsx-focus-ring-color);
    --dsx-focus-ring-halo: 0 0 0 calc(var(--dsx-focus-ring-width) + 1px) color-mix(in srgb, var(--dsx-focus-ring-color) 20%, transparent);
` +
// Minimum comfortable target on a coarse pointer (design-system.md Part 1
// "Density and touch"; Part 3 makes it a WCAG 2.2 AA floor). The density plane
// above sizes controls; this is the floor those sizes may not cross.
`    --dsx-hit-target-min: 44px;
` +
// THE STATE LAYER (design-system.md Part 1, "derived interaction states"): ONE
// law expressed as tokens a component composes, never a per-component recipe.
// A state layer is the state TINT laid over whatever surface the component
// already has, at a ratified strength. The tint defaults to the ink token, so it
// darkens in light and lightens in dark with no second decision, and an
// accent-tinted region re-declares --dsx-state-tint ONCE to restyle every one of
// its hover/press/focus/selected states in both schemes.
// The strengths are the platform ladder, not an average of what shipped: the
// sheet's 144 hand-written color-mix() calls scattered from 4% to 45% with no
// cluster to ratify (hover alone spanned 4/5/8/10/12/15/16/20/22/24/28/30/40/45).
`    --dsx-state-tint: var(--dsx-label);
    --dsx-state-hover: 8%;
    --dsx-state-focus: 10%;
    --dsx-state-pressed: 10%;
    --dsx-state-dragged: 16%;
    --dsx-state-selected: 12%;
    --dsx-state-layer-hover: color-mix(in srgb, var(--dsx-state-tint) var(--dsx-state-hover), transparent);
    --dsx-state-layer-focus: color-mix(in srgb, var(--dsx-state-tint) var(--dsx-state-focus), transparent);
    --dsx-state-layer-pressed: color-mix(in srgb, var(--dsx-state-tint) var(--dsx-state-pressed), transparent);
    --dsx-state-layer-dragged: color-mix(in srgb, var(--dsx-state-tint) var(--dsx-state-dragged), transparent);
    --dsx-state-layer-selected: color-mix(in srgb, var(--dsx-state-tint) var(--dsx-state-selected), transparent);
    --dsx-state-disabled-content: 0.38;
    --dsx-state-disabled-surface: 0.12;
    --dsx-outline-soft: color-mix(in srgb, var(--dsx-separator) 82%, transparent);
    --dsx-icon-size: 1rem;
    --dsx-type-caption: 0.75rem;
    --dsx-type-label: 0.8125rem;
    --dsx-type-body: 0.9375rem;
    --dsx-type-section: 1.0625rem;
    --dsx-ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
    --dsx-danger: var(--dsx-destructive);
    --dsx-space-1: 4px;
    --dsx-space-2: 8px;
    --dsx-space-3: 12px;
    --dsx-space-4: 16px;
    --dsx-space-5: 20px;
    --dsx-space-6: 24px;
    --dsx-space-7: 28px;
    --dsx-space-8: 32px;
    --dsx-space-9: 36px;
    --dsx-space-10: 40px;
    --dsx-space-11: 44px;
    --dsx-space-12: 48px;
    --dsx-radius-control: var(--dsx-radius);
    --dsx-radius-card: var(--dsx-radius-lg);
    --dsx-radius-sheet: 20px;
    --dsx-radius-full: 999px;
    --dsx-dur-fast: 120ms;
    --dsx-dur-base: 200ms;
    --dsx-dur-slow: 300ms;
` +
// An indeterminate loop has a PERIOD, not a duration: it never settles, so no rung
// on the 120/200/300 transition ramp can express a spinner or a shimmer sweep. Two
// rungs because a rotation and a sweep across a wide surface read at different
// tempos. These deliberately do NOT collapse under reduced motion - a 0s infinite
// animation is a frozen busy indicator; every loop below turns itself off with an
// explicit animation: none instead. Web-only, like the fluid type twins: a native
// indeterminate indicator owns its own period.
`    --dsx-dur-loop: 800ms;
    --dsx-dur-loop-slow: 1350ms;
` +
// COMPAT ONLY. --dsx-motion-* was a second duration family (120ms / 180ms) that
// grew beside the ramp above; every call site in this package now reads the ramp,
// and the design-system gate refuses a new one inside @layer dsx-elements. These
// two lines survive because a custom property in a shipped sheet is public API an
// author's theme.css may already reference. --dsx-motion-standard resolves to
// 200ms now, not 180ms: 180 had no rung on the ratified ramp. The retired
// --dsx-duration-* triplet is the name the design-system spec uses in prose, so it
// stays as a published alias even though the sheet itself reads the short one - an
// alias onto the canonical token is not a second family, it is one value with two
// spellings, and it inherits the reduced-motion collapse for free.
`    --dsx-motion-fast: var(--dsx-dur-fast);
    --dsx-motion-standard: var(--dsx-dur-base);
    --dsx-duration-fast: var(--dsx-dur-fast);
    --dsx-duration-base: var(--dsx-dur-base);
    --dsx-duration-slow: var(--dsx-dur-slow);
    --dsx-ease: cubic-bezier(0.2, 0, 0, 1);
    --dsx-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
    --dsx-ease-spring-soft: cubic-bezier(0.22, 1.2, 0.36, 1);
` +
// THE TYPE RAMP - size, weight, tracking AND leading on every role
// (design-system.md Part 1: "each with size, weight, tracking, and leading that
// the layout engine also measures"). Leading was the missing fourth axis, so the
// sheet hand-typed line-height 18 different ways; each rung below is one of the
// values the sheet already shipped, so the ramp covers real usage instead of
// orphaning it. Tighter as the type grows, looser as it settles into reading.
// --dsx-type-leading-none is the honest reset for an icon or glyph box, where
// line-height is box geometry rather than reading rhythm.
//
// THREE ROLES RATIFIED 2026-08-25, each because the element layer was improvising a
// value the nine roles above could not express (the design-system gate's burn-down
// named the sites):
// - label   - the CONTROL label: weight 500, the Material labelLarge / Apple
//             subheadline rung. Nine sites wrote `font-weight: 500` because the ramp
//             offered only 400 and 600, and the audit asked for control labels at
//             "regular or medium". 500 is a real static face, unlike the 560/650 axis
//             values the corpus refuses, so the ramp was wrong, not the sites. Its
//             tracking OPENS (+0.01em): the ramp tightens as type grows, and the small
//             label band is where it has to open again.
// - caption2 - the MICRO label under caption: 11px, Apple caption2 and Material
//             labelSmall exactly. A tab label, a badge, a scene overlay - the ramp
//             bottomed out at 12px and four sites went under it on their own.
// - reading  - LONG-FORM body: 1rem at 1.7 leading. Prose is not UI text; it reads at
//             the reader's own root size and a looser rhythm, which is why the markdown
//             plane never once used --dsx-type-body-*.
//
// THE FLUID TWINS are WEB-ONLY and stay out of the cross-runtime corpus on purpose: a
// viewport-interpolated size has no native twin at all (Dynamic Type and the Material
// scale already resize from the OS, not the window). Each twin spans from its own rung
// to roughly the next one up, so a fluid head still lands inside the ramp.
//
// THE GLYPH SCALE is the axis the type ramp is not: a chevron, a stepper +/-, a map pin
// or a lightbox arrow is a text glyph used as an icon (always paired with
// --dsx-type-leading-none, because the box is geometry). Sizing those off a READING rung
// is a category error, and it is why eight sites wrote their own 18/19.2/20/24/28/30px.
// Three rungs on the 4px step the spacing ramp already uses, from --dsx-icon-size (16px).
`    --dsx-type-display-size: 2.125rem;
    --dsx-type-display-weight: 700;
    --dsx-type-display-tracking: -0.022em;
    --dsx-type-display-leading: 1.1;
    --dsx-type-title1-size: 1.625rem;
    --dsx-type-title1-weight: 700;
    --dsx-type-title1-tracking: -0.02em;
    --dsx-type-title1-leading: 1.15;
    --dsx-type-title2-size: 1.3125rem;
    --dsx-type-title2-weight: 600;
    --dsx-type-title2-tracking: -0.017em;
    --dsx-type-title2-leading: 1.2;
    --dsx-type-title3-size: 1.0625rem;
    --dsx-type-title3-weight: 600;
    --dsx-type-title3-tracking: -0.013em;
    --dsx-type-title3-leading: 1.25;
    --dsx-type-headline-size: 0.9375rem;
    --dsx-type-headline-weight: 600;
    --dsx-type-headline-tracking: -0.01em;
    --dsx-type-headline-leading: 1.3;
    --dsx-type-body-size: 0.9375rem;
    --dsx-type-body-weight: 400;
    --dsx-type-body-tracking: -0.009em;
    --dsx-type-body-leading: 1.5;
    --dsx-type-callout-size: 0.875rem;
    --dsx-type-callout-weight: 400;
    --dsx-type-callout-tracking: -0.006em;
    --dsx-type-callout-leading: 1.45;
    --dsx-type-footnote-size: 0.8125rem;
    --dsx-type-footnote-weight: 400;
    --dsx-type-footnote-tracking: -0.004em;
    --dsx-type-footnote-leading: 1.4;
    --dsx-type-caption-size: 0.75rem;
    --dsx-type-caption-weight: 400;
    --dsx-type-caption-tracking: 0em;
    --dsx-type-caption-leading: 1.35;
    --dsx-type-caption2-size: 0.6875rem;
    --dsx-type-caption2-weight: 400;
    --dsx-type-caption2-tracking: 0.01em;
    --dsx-type-caption2-leading: 1.35;
    --dsx-type-label-size: 0.8125rem;
    --dsx-type-label-weight: 500;
    --dsx-type-label-tracking: 0.01em;
    --dsx-type-label-leading: 1.35;
    --dsx-type-reading-size: 1rem;
    --dsx-type-reading-weight: 400;
    --dsx-type-reading-tracking: -0.009em;
    --dsx-type-reading-leading: 1.7;
    --dsx-type-leading-none: 1;
    --dsx-type-display-size-fluid: clamp(2rem, 1.66rem + 1.7vw, 2.5rem);
    --dsx-type-title1-size-fluid: clamp(1.625rem, 1.2rem + 1vw, 2rem);
    --dsx-type-title2-size-fluid: clamp(1.4rem, 1.24rem + 0.8vw, 1.75rem);
    --dsx-type-title3-size-fluid: clamp(1.15rem, 1.08rem + 0.35vw, 1.35rem);
    --dsx-glyph-size: 1.25rem;
    --dsx-glyph-size-lg: 1.5rem;
    --dsx-glyph-size-xl: 1.75rem;
  }
` +
// real springs (damping .8/.9) — OPTIONAL: a sliced embed that declares no spring easing
// drops the whole linear() block (__DSX_OPTIONAL_SPRING__, wired by the embed builder).
((globalThis as typeof globalThis & { __DSX_OPTIONAL_SPRING__?: boolean })
    .__DSX_OPTIONAL_SPRING__ !== false ? SPRING_LINEAR_CSS : "") +
// THE DENSITY PLANE (component-library.md W9; the shared law: input/density.json).
// Every density-varying control metric is a token declared in ONE ladder: the
// comfortable base here, the desktop fine-pointer platform default (compact) in the
// media block, and the density="comfortable|compact" pin tables after it. Tokens
// inherit, so a stamped data-dsx-density re-derives the whole plane for its subtree
// on any pointer — the nearest ancestor pin wins by inheritance — and theme pins
// deliberately do NOT re-declare these, so density flows through themed subtrees.
`  :root, :host {
    --dsx-control-height-sm: 32px;
    --dsx-control-height-lg: 48px;
    --dsx-control-padding-inline: 0.875rem;
    --dsx-control-gap: 0.5rem;
    --dsx-button-density-pad: var(--dsx-control-padding-inline);
    --dsx-button-density-pad-strong: 1rem;
    --dsx-button-density-type: var(--dsx-type-headline-size);
    --dsx-button-density-radius: var(--dsx-radius-control);
${(globalThis as typeof globalThis & { __DSX_OPTIONAL_CONTROL_METRICS__?: boolean })
    .__DSX_OPTIONAL_CONTROL_METRICS__ !== false ? CONTROL_METRICS_CSS : ""}  }
  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    :root, :host {
      --dsx-radius-sm: 6px;
      --dsx-radius: 8px;
      --dsx-radius-lg: 12px;
      --dsx-gap: 6px;
      --dsx-control-height-sm: 28px;
      --dsx-control-height: 32px;
      --dsx-control-height-lg: 36px;
      --dsx-control-padding-inline: 0.75rem;
      --dsx-control-gap: 0.375rem;
      --dsx-button-density-pad: 0.625rem;
      --dsx-button-density-pad-strong: 0.75rem;
      --dsx-button-density-type: 0.8125rem;
      --dsx-button-density-radius: var(--dsx-radius-sm);
${(globalThis as typeof globalThis & { __DSX_OPTIONAL_CONTROL_METRICS__?: boolean })
    .__DSX_OPTIONAL_CONTROL_METRICS__ !== false ? CONTROL_METRICS_COMPACT_CSS : ""}    }
  }
${(globalThis as typeof globalThis & { __DSX_OPTIONAL_DENSITY__?: boolean })
    .__DSX_OPTIONAL_DENSITY__ !== false ? DENSITY_PIN_TABLES_CSS : ""}
  @media (min-resolution: 2dppx) {
    :root, :host, [data-dsx-theme] { --dsx-hairline: 0.5px; }
  }
  @media (min-resolution: 3dppx) {
    :root, :host, [data-dsx-theme] { --dsx-hairline: 0.333333px; }
  }
  @media (prefers-reduced-motion: reduce) {
    :root, :host, [data-dsx-theme] {
      --dsx-dur-fast: 0ms;
      --dsx-dur-base: 0ms;
      --dsx-dur-slow: 0ms;
      --dsx-motion-fast: 0ms;
      --dsx-motion-standard: 0ms;
      --dsx-ease-spring: var(--dsx-ease);
      --dsx-ease-spring-soft: var(--dsx-ease);
    }
  }
` +
// the one shared keyboard ring: unskinned focusables (links, tappables, focusable
// regions) trade the UA outline for the token ring; skinned controls override it in
// the stronger element layer, so this never doubles an existing indicator.
`  :where(a, area, summary, [contenteditable], [tabindex]):where(:not([tabindex="-1"])):focus-visible {
    outline: var(--dsx-focus-ring-outline);
    outline-offset: var(--dsx-focus-ring-offset);
  }
}`;

/** Application-shell-only rules. Custom-element embeds instantiate their component
 * directly and never create the boot host, router frames, or presentation planes;
 * full application boot and SSR always inject this sheet. */
export const APPLICATION_ELEMENTS_CSS = `@layer dsx-elements {
  [data-dsx-root] {
    font-family: var(--dsx-font);
    color: var(--dsx-label);
    background: var(--dsx-background);
    line-height: var(--dsx-type-callout-leading);
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
    position: fixed;
    inset: 0 0 auto 0;
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
    overscroll-behavior: none;
  }
  [data-dsx-root] *, [data-dsx-root] *::before, [data-dsx-root] *::after {
    box-sizing: border-box;
  }
` +
// text selection carries the accent in both schemes: a translucent accent wash
// keeps the glyph ink readable without pinning a foreground
`  [data-dsx-root] ::selection {
    background: color-mix(in srgb, var(--dsx-accent) 26%, transparent);
  }
  .dsx-frame {
    --dsx-safe-block-start: env(safe-area-inset-top, 0px);
    --dsx-safe-block-end: env(safe-area-inset-bottom, 0px);
    --dsx-safe-inline-start: env(safe-area-inset-left, 0px);
    --dsx-safe-inline-end: env(safe-area-inset-right, 0px);
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--dsx-background);
    padding-block-start: var(--dsx-chrome-inset, 0px);
    padding-block-end: var(--dsx-safe-block-end);
    padding-inline-start: var(--dsx-safe-inline-start);
    padding-inline-end: var(--dsx-safe-inline-end);
  }
  .dsx-frame:dir(rtl) {
    --dsx-safe-inline-start: env(safe-area-inset-right, 0px);
    --dsx-safe-inline-end: env(safe-area-inset-left, 0px);
  }
  .dsx-frame:focus { outline: none; }
  .dsx-split .dsx-master { padding-block-start: var(--dsx-safe-block-start); }
  .dsx-frame > * { flex: 1 1 auto; min-height: 0; }

  .dsx-overlay-plane { position: absolute; inset: 0; z-index: 500; pointer-events: none; }
  .dsx-overlay { position: absolute; inset: 0; }
  .dsx-overlay, .dsx-overlay * { pointer-events: none; }
  .dsx-overlay button, .dsx-overlay [role="button"], .dsx-overlay a, .dsx-overlay input,
  .dsx-overlay textarea, .dsx-overlay select, .dsx-overlay [tabindex],
  .dsx-overlay .dsx-scroll { pointer-events: auto; }
  .dsx-overlay-block, .dsx-overlay-block * { pointer-events: auto; }
  .dsx-frame-cover { background: var(--dsx-background); }
}`;

/** The <scaffold> application-shell rules. Split out of the sheet below so the same
 *  `__DSX_OPTIONAL_SCAFFOLD__` define that drops the factory (elements.ts) drops its
 *  rules too — folded inline, so esbuild resolves the ternary and tree-shakes the
 *  string. Unset (every full app, SSR, every test) ⇒ ELEMENTS_CSS is byte-identical. */
const SCAFFOLD_ELEMENTS_CSS = `
  .dsx-scaffold { display: flex; flex-direction: column; min-width: 0; min-height: 0; width: 100%; height: 100%; }
  .dsx-scaffold-pin { flex: none; position: relative; z-index: 1; }
  .dsx-scaffold-shell { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: hidden; }
  .dsx-scaffold-custom, .dsx-scaffold-pane { min-width: 0; min-height: 0; overflow: auto; }
  .dsx-scaffold-shell[data-dsx-layout="custom"] .dsx-scaffold-custom { display: flex; flex-direction: column; height: 100%; }
  .dsx-scaffold-shell:not([data-dsx-layout="custom"]) .dsx-scaffold-custom { display: none; }
  .dsx-scaffold-shell[data-dsx-layout="custom"] .dsx-scaffold-pane { display: none; }
  .dsx-scaffold-shell[data-dsx-layout="stack"] { display: flex; flex-direction: column; overflow: auto; }
  .dsx-scaffold-shell[data-dsx-layout="stack"] .dsx-scaffold-pane { display: block; flex: none; overflow: visible; }
  .dsx-scaffold-shell[data-dsx-layout="content"] .dsx-scaffold-sidebar,
  .dsx-scaffold-shell[data-dsx-layout="content"] .dsx-scaffold-inspector { display: none; }
  .dsx-scaffold-shell[data-dsx-layout="content"] .dsx-scaffold-content { display: block; height: 100%; }
  .dsx-scaffold-shell[data-dsx-layout="split2"],
  .dsx-scaffold-shell[data-dsx-layout="native2"] {
    display: grid;
    grid-template-columns: clamp(var(--dsx-sidebar-min), var(--dsx-sidebar-ideal), var(--dsx-sidebar-max)) minmax(0, 1fr);
  }
  .dsx-scaffold-shell[data-dsx-layout="split3"],
  .dsx-scaffold-shell[data-dsx-layout="native3"] {
    display: grid;
    grid-template-columns: clamp(var(--dsx-sidebar-min), var(--dsx-sidebar-ideal), var(--dsx-sidebar-max)) minmax(0, 1fr) clamp(var(--dsx-inspector-min), var(--dsx-inspector-ideal), var(--dsx-inspector-max));
  }
  .dsx-scaffold-shell[data-dsx-layout="split2"] .dsx-scaffold-inspector,
  .dsx-scaffold-shell[data-dsx-layout="native2"] .dsx-scaffold-inspector { display: none; }
  .dsx-scaffold-shell[data-dsx-layout^="split"] .dsx-scaffold-sidebar,
  .dsx-scaffold-shell[data-dsx-layout^="native"] .dsx-scaffold-sidebar { border-inline-end: var(--dsx-hairline) solid var(--dsx-separator); }
  .dsx-scaffold-shell[data-dsx-layout="split3"] .dsx-scaffold-inspector,
  .dsx-scaffold-shell[data-dsx-layout="native3"] .dsx-scaffold-inspector { border-inline-start: var(--dsx-hairline) solid var(--dsx-separator); }
`;

/** `.dsx-spacer` / `.dsx-divider` and `.dsx-image` / `.dsx-icon` — the rules only the four
 *  static presentation factories emit, gated by the same `__DSX_OPTIONAL_STATIC_ELEMENTS__`
 *  define that drops those factories. Two constants because they sit in two places in the
 *  sheet and the unfolded sheet stays byte-identical. (`.dsx-scroll*` deliberately stays in
 *  the base sheet: bound collections and the structural controls set `dsx-scroll-x` without
 *  ever mounting a `<scroll>`.) */
const STATIC_ELEMENTS_CSS_A = `  .dsx-spacer { flex: 1 1 0; align-self: stretch; }
  .dsx-divider { --dsx-divider-color: var(--dsx-separator); height: var(--dsx-hairline); align-self: stretch; background: var(--dsx-divider-color); }
`;
const STATIC_ELEMENTS_CSS_B = `
  .dsx-image { display: block; max-width: 100%; }
  .dsx-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    line-height: 0;
    vertical-align: middle;
  }`;
/** The NON-DEFAULT button skin: variant="bordered", the destructive/cancel role
 *  words, and the aria-pressed state rules. data-dsx-variant / data-dsx-role /
 *  aria-pressed stamp ONLY from authored attrs (elements.ts buttonEl, mount.ts), so an
 *  embed that authors none of those spellings folds the skin (build-demo detection:
 *  the bordered/destructive/cancel words or an interpolated variant/role keep it; the
 *  aria-pressed rule rides the existing PRESSED define). Unset, the sheet is
 *  byte-identical. */
const BUTTON_VARIANTS_CSS_A = `    .dsx-button:not([data-dsx-variant])[data-dsx-role="destructive"]:not(:disabled):not([aria-disabled="true"]):hover {
      background: var(--dsx-danger-muted);
    }
    .dsx-button[data-dsx-variant="bordered"]:not(:disabled):not([aria-disabled="true"]):hover {
      background: color-mix(in srgb, var(--dsx-label) 7%, var(--dsx-fill));
    }
`;
const BUTTON_VARIANTS_CSS_B = `    .dsx-button[data-dsx-variant="prominent"][data-dsx-role="destructive"]:not(:disabled):not([aria-disabled="true"]):hover {
      background: color-mix(in srgb, var(--dsx-destructive) 90%, var(--dsx-label));
    }
`;
// SwiftUI's .bordered is a QUIET FLAT FILL with the tint as ink - no visible border, no
// gloss, no elevation. This variant used to paint a vertical gradient chip under a
// hairline ring and the shadow-1 drop stack, which is the raised-button grammar of a
// 2010 toolkit and the single loudest "generated app" tell on every preview. Flat fill,
// flat hover (one quiet level up in CSS_A), nothing floating.
// THE INK-DEEPENING LAW for translucent standing surfaces: fill lets the ground show
// through, so on groupedBackground the blended chip is one step darker (light) or
// lighter (dark) than on the page ground and bare accent ink lands at ~4.4:1 there.
// Mixing 10% label into the tint deepens the ink in light and lifts it in dark from
// the SAME declaration, holding AA (>=4.5) on every token ground in both schemes -
// pinned with blended-surface math in theme.test.ts.
const BUTTON_VARIANTS_CSS_C = `  .dsx-button[data-dsx-variant="bordered"] {
    background: var(--dsx-fill);
    color: color-mix(in srgb, var(--dsx-accent) 90%, var(--dsx-label));
    padding-inline: var(--dsx-button-density-pad-strong);
    min-height: var(--dsx-button-min-height);
  }
`;
const BUTTON_VARIANTS_CSS_D = `  .dsx-button[data-dsx-role="destructive"] { color: color-mix(in srgb, var(--dsx-destructive) 90%, var(--dsx-label)); }
  .dsx-button[data-dsx-variant="bordered"][data-dsx-role="destructive"] {
    background: color-mix(in srgb, var(--dsx-destructive) 12%, transparent);
  }
`;
const BUTTON_VARIANTS_CSS_E = `  .dsx-button[data-dsx-variant="prominent"][data-dsx-role="destructive"] {
    background: var(--dsx-destructive);
    color: var(--dsx-on-destructive);
  }
`;
const PRESSED_BUTTON_CSS = `  .dsx-button:not([data-dsx-variant])[aria-pressed="true"] {
    color: color-mix(in srgb, var(--dsx-accent) 90%, var(--dsx-label));
    background: var(--dsx-accent-muted);
  }
`;
const BUTTON_VARIANTS_CSS_F = `  .dsx-button[data-dsx-variant="bordered"][aria-pressed="true"] {
    background: var(--dsx-accent-muted);
  }
  .dsx-button[data-dsx-variant="bordered"]:not(:disabled):not([aria-disabled="true"]):active {
    background: var(--dsx-surface-recessed);
  }
`;
const BUTTON_VARIANTS_CSS_G = `  .dsx-button[data-dsx-variant="prominent"][data-dsx-role="destructive"]:not(:disabled):not([aria-disabled="true"]):active {
    background: color-mix(in srgb, var(--dsx-destructive) 80%, var(--dsx-label));
  }
`;
const BUTTON_VARIANTS_CSS_H = `  .dsx-button[data-dsx-role="cancel"] { font-weight: var(--dsx-type-headline-weight); }
  ` +
// THE DOUBLE RING, retired with the glow itself (the flat re-ratification,
// 2026-08-27): a prominent button no longer rests on an accent glow, so focus needs
// no substitute elevation - the focus ring is the one and only accent indicator.
`  .dsx-button[data-dsx-variant="prominent"]:focus-visible {
    --dsx-button-shadow: inset 0 0 0 0 transparent;
  }
`;

/** The .dsx-surface-* material classes. Only the __DSX_OPTIONAL_SURFACES__-gated
 *  mount branch (surface=) stamps them, so the same define drops these rules from an
 *  embed that authors no surface. Unset => ELEMENTS_CSS is byte-identical. */
/** Bound-collection / pager fallback rules. Structural embeds load the fuller
 *  STRUCTURAL_CONTROLS_CSS twin; a slice that authors no list/grid/pager (and so
 *  never mounts `.dsx-list` / `.dsx-pager`) folds these under the same
 *  `__DSX_OPTIONAL_BOUND_COLLECTIONS__` define that drops keyed reconciliation.
 *  Unset ⇒ ELEMENTS_CSS is byte-identical. */
// A VERTICAL COLLECTION FILLS ITS PARENT'S CROSS AXIS, which is what List does on iOS and
// LazyColumn does on Compose. On web it inherited the flex default and HUGGED its widest row,
// so a bound list inside a column came out as wide as its longest string and every row in it
// with it - the same list, the same markup, a different picture on one renderer. A horizontal
// collection is untouched: its cross axis is height, and a rail that grew to its parent's
// height would be the same mistake pointing the other way. The comment lives OUT here because
// a comment inside the template ships in every bundle that carries the sheet.
//
// A HORIZONTAL COLLECTION'S ROWS KEEP THEIR SIZE, which is the other half of the same law and
// the one that had no rule. `ScrollView(.horizontal) { LazyHStack }` and `LazyRow` both lay
// their rows out at the size the row asks for and let the CONTENT overflow into scroll; web
// flex does the opposite by default - `flex-shrink: 1` - so the eleventh card in a rail does
// not scroll into view, it squeezes the other ten. Measured on a 375pt phone: a rail of 150px
// posters rendered them at 72.25px each, `width: 150px` still sitting in the markup and
// `getComputedStyle().width` reporting the squeezed number, so the poster's `object-fit: cover`
// then cropped art nobody had authored. Nothing warns, because nothing is wrong: this is what
// the row was asked to do. `flex: none` is the whole fix. The selector reaches THROUGH
// `.dsx-row`, which is `display: contents` and generates no box - the row template's own root
// is the flex item, which is also why the neighbouring `> .dsx-row { flex: 0 0 auto }` in
// structural-controls cannot do this job: a flex declaration on a box that does not exist is
// inert. A row that DOES want to share the axis still says so with `grow="width"` and still
// wins: that rule lives in the SAME @layer dsx-elements (there is no later layer - the sheet
// declares exactly dsx-tokens and dsx-elements), and it wins on specificity, matching one
// attribute selector more than this rule does. collection-rail-browser.ts measures both
// halves in a real engine, because a sheet can carry a correct-looking rule that reaches
// nothing and only the engine reports which box actually got the width.
const COLLECTION_ELEMENTS_CSS = `  .dsx-list { display: flex; flex-direction: column; min-width: 0; }
  .dsx-list[data-dsx-axis="vertical"] { align-self: stretch; }
  .dsx-list[data-dsx-axis="horizontal"] > .dsx-row > * { flex: none; }
  .dsx-row { display: contents; }
  .dsx-grid { display: grid; gap: var(--dsx-gap); }
  .dsx-pager:not(.dsx-paged) { flex-direction: row; overflow-x: auto; scroll-snap-type: x mandatory; }
  .dsx-pager:not(.dsx-paged) > .dsx-row { display: block; flex: 0 0 100%; scroll-snap-align: start; }
`;

const SURFACE_ELEMENTS_CSS = `  .dsx-surface-glass, .dsx-surface-ultraThin {
    /* THE TINT AND THE PRESS, declared on the glass class itself rather than inherited. Both are
       what \`glassTint\` / \`glassInteractive\` compile to, and both were inert until this rule read
       them - the compiler emitted a \`-dsx-*\` vendor spelling the browser dropped, and nothing in
       the renderer consumed either one even when it did not.
       Re-declaring the defaults HERE is what makes them behave like the per-element properties
       they are on the native renderers: a custom property inherits, so a glass button inside a
       tinted glass sheet would wear the sheet's colour. The compiled attribute class lands in
       \`dsx-attrs\`, the last layer, so a declared value still wins on the element that declares
       it - and every nested glass resets to the default for its own subtree. */
    --dsx-glass-tint: var(--dsx-surface-level-1);
    --dsx-glass-interactive: 0;
    background: color-mix(in srgb, var(--dsx-glass-tint) 76%, transparent);
    transition: scale var(--dsx-dur-slow) var(--dsx-ease-spring);
  }
  /* The interactive press. iOS 26 stretches the real material under the finger; the browser has
     no material to stretch, so the twin is the geometry of the response - the same 0.97 the
     pressable surface cards already use, fast in and springing back out. Multiplied by the
     factor, so a glass surface that did not ask for it computes an identity scale rather than
     needing a second selector. */
  .dsx-surface-glass:active, .dsx-surface-ultraThin:active {
    scale: calc(1 - 0.03 * var(--dsx-glass-interactive));
    transition: scale var(--dsx-dur-fast) var(--dsx-ease);
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-surface-glass, .dsx-surface-ultraThin,
    .dsx-surface-glass:active, .dsx-surface-ultraThin:active { transition: none; }
  }
  /* The two glass tokens are the ones iOS renders as a real material, and the browser has the
     primitive to mean it: a translucent fill alone reads as a flat wash, and the frost is what
     makes the token worth naming. Guarded, because a backdrop-filter that does not composite
     leaves the fill above doing the whole job - which is exactly the pre-frost look, so the
     unsupported path is the old one rather than a broken one. Saturation is lifted with the
     blur for the same reason Apple's materials do it: blurring alone desaturates what shows
     through and the surface reads grey. */
  @supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
    .dsx-surface-glass, .dsx-surface-ultraThin {
      background: color-mix(in srgb, var(--dsx-glass-tint) 56%, transparent);
      -webkit-backdrop-filter: blur(20px) saturate(1.6);
      backdrop-filter: blur(20px) saturate(1.6);
    }
  }
  /* A frost costs a compositor pass per element, and a reader who has asked for less motion is
     often on the hardware that pays for it most. */
  @media (prefers-reduced-transparency: reduce) {
    .dsx-surface-glass, .dsx-surface-ultraThin {
      /* No frost, so the tint is the whole read - opaque, exactly the solid fill the pre-26 iOS
         path and both Compose lanes paint when they cannot host a material. */
      background: var(--dsx-glass-tint);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }
  .dsx-surface-thin { background: var(--dsx-surface-level-1); }
  .dsx-surface-regular { background: var(--dsx-surface-level-2); }
  .dsx-surface-thick, .dsx-surface-sheet { background: var(--dsx-surface-level-3); }
  .dsx-surface-sheet {
    border-radius: var(--dsx-radius-lg);
    box-shadow: inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft);
  }
`;

import { TYPE_ROLES as TYPE_ROLE_LIST } from "./type-roles.ts";
export { TYPE_ROLES, type TypeRole } from "./type-roles.ts";

/* THE TYPE RAMP, REACHABLE. `<text type="label">` is the author's word for a rung of
   `Conformance/defaults/type.json`, and it exists because the ramp did not: twelve roles were
   ratified with all seven native columns filled in, and markup had no way to name one, so
   every caller wrote its own font-size (runtime-pressure.md R24). The four properties are the
   four the corpus declares per role - nothing here decides a value, it only points at the one
   the token sheet already carries. The list is the corpus's key order and
   `defaults-corpus.test.ts` fails if the two ever disagree, so a role added to the corpus
   without a rule here is a role the web cannot render. */

const TYPE_ROLE_RULES = TYPE_ROLE_LIST.map((r) =>
  `.dsx-text[data-dsx-type="${r}"] {`
  + ` font-size: var(--dsx-type-${r}-size);`
  + ` font-weight: var(--dsx-type-${r}-weight);`
  + ` letter-spacing: var(--dsx-type-${r}-tracking);`
  + ` line-height: var(--dsx-type-${r}-leading); }`).join("\n  ");

// A TAP TARGET RESPONDS TO THE FINGER. on:tap announces as a button to assistive tech,
// and UIKit highlights the cell under a touch - but this class carried only a cursor, so
// every card, row and chip built as a tappable stack was inert to the press (measured:
// zero press feedback across an entire seven-screen app, because every one of its cards
// is a tappable stack rather than a button element). The dim is the platform cell-highlight's
// twin: opacity, not transform, so pressed geometry never shifts under the finger, and
// the fast duration in both directions keeps it punctuation rather than animation.
// A full-bleed tap surface (a video stage's tap-to-pause) opts out by AUTHORING opacity
// inline - an element style outranks every sheet layer, the same escape the stretch
// rules honor.
// This comment lives OUT here on purpose: a comment inside the template ships in every
// bundle that carries the sheet, and 832 bytes of it put EmbedCard over the 40960-byte
// G10 widget law (41364B measured). The rule below is unchanged.
export const ELEMENTS_CSS = `@layer dsx-elements {
  .dsx-stack { display: flex; flex-direction: column; align-items: start; min-width: 0; min-height: 0; }
  .dsx-hstack { flex-direction: row; align-items: center; }
  .dsx-hstack-defaults, .dsx-vstack { gap: 8px; }
  .dsx-vstack { align-items: start; }
${(globalThis as typeof globalThis & { __DSX_OPTIONAL_SCAFFOLD__?: boolean })
    .__DSX_OPTIONAL_SCAFFOLD__ !== false ? SCAFFOLD_ELEMENTS_CSS : ""}
  .dsx-stack > [data-dsx-grow="width"], .dsx-stack > [data-dsx-grow="true"],
  .dsx-scroll > [data-dsx-grow="width"], .dsx-scroll > [data-dsx-grow="true"],
  .dsx-row > [data-dsx-grow="width"], .dsx-row > [data-dsx-grow="true"] { align-self: stretch; }
  .dsx-stack > [data-dsx-grow="height"], .dsx-stack > [data-dsx-grow="true"],
  .dsx-scroll > [data-dsx-grow="height"], .dsx-scroll > [data-dsx-grow="true"] { flex-grow: 1; }
  .dsx-hstack > [data-dsx-grow="width"], .dsx-hstack > [data-dsx-grow="true"],
  .dsx-pressable > [data-dsx-grow="width"], .dsx-pressable > [data-dsx-grow="true"] {
    align-self: auto; flex-grow: 1; flex-shrink: 1; min-width: 0;
  }
  .dsx-hstack > [data-dsx-grow="true"] { align-self: stretch; }
  .dsx-hstack > [data-dsx-grow="height"] { flex-grow: 0; align-self: stretch; }
  .dsx-zstack { display: grid; align-items: center; justify-items: center; justify-content: center; }
  .dsx-zstack > * { grid-area: 1 / 1; }
  .dsx-stack[style*="display: grid"] > *, .dsx-stack[data-dsx-grid] > * { grid-area: 1 / 1; }

  .dsx-text {
    font-family: var(--dsx-font);
    font-size: var(--dsx-type-body-size);
    font-weight: var(--dsx-type-body-weight);
    letter-spacing: var(--dsx-type-body-tracking);
    line-height: var(--dsx-type-body-leading);
    min-width: 0;
    overflow-wrap: anywhere;
    flex: none;
  }
  .dsx-text a {
    color: var(--dsx-accent);
    text-decoration: none;
    text-underline-offset: 0.14em;
  }
  .dsx-text a:active { opacity: .8; }
${TYPE_ROLE_RULES}

  .dsx-button {
    --dsx-button-shadow: inset 0 0 0 0 transparent;
    --dsx-button-min-height: var(--dsx-control-height);
    --dsx-button-radius: var(--dsx-button-density-radius);
    --dsx-button-padding-inline: var(--dsx-button-density-pad);
    --dsx-button-font-size: var(--dsx-button-density-type);
    --dsx-button-font-weight: var(--dsx-type-headline-weight);
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--dsx-control-gap);
    font-family: var(--dsx-font);
    font-size: var(--dsx-button-font-size);
    font-weight: var(--dsx-button-font-weight);
    line-height: var(--dsx-type-title2-leading);
    letter-spacing: var(--dsx-type-headline-tracking);
    color: var(--dsx-label);
    background: transparent;
    border: 0;
    padding: 0 var(--dsx-button-padding-inline);
    min-height: var(--dsx-button-min-height);
    border-radius: var(--dsx-button-radius);
    box-shadow: var(--dsx-button-shadow);
    text-decoration: none;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition:
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      color var(--dsx-dur-fast) var(--dsx-ease),
      transform var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-button > span, .dsx-button > svg {
    transition: opacity var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-button:not(:disabled):not([aria-disabled="true"]):active > span,
  .dsx-button:not(:disabled):not([aria-disabled="true"]):active > svg {
    opacity: .9;
  }
  .dsx-button:not([data-dsx-variant]):not(:disabled):not([aria-disabled="true"]):active {
    background: var(--dsx-fill);
  }
  .dsx-button:not([data-dsx-variant])[data-dsx-role="destructive"]:not(:disabled):not([aria-disabled="true"]):active {
    background: color-mix(in srgb, var(--dsx-destructive) 16%, transparent);
  }
  .dsx-button:disabled, .dsx-button[aria-disabled="true"] {
    cursor: not-allowed;
    opacity: .45;
    filter: saturate(.5);
  }
  .dsx-button[aria-busy="true"] { cursor: progress; opacity: .68; }
  @media (hover: hover) and (pointer: fine) {
    .dsx-button:not([data-dsx-variant]):not(:disabled):not([aria-disabled="true"]):hover {
      background: var(--dsx-surface-hover, color-mix(in srgb, var(--dsx-fill) 72%, transparent));
    }
${(globalThis as typeof globalThis & { __DSX_OPTIONAL_BUTTON_VARIANTS__?: boolean })
    .__DSX_OPTIONAL_BUTTON_VARIANTS__ !== false ? BUTTON_VARIANTS_CSS_A : ""}    .dsx-button[data-dsx-variant="prominent"]:not(:disabled):not([aria-disabled="true"]):hover {
      background: var(--dsx-accent-hover);
    }
${(globalThis as typeof globalThis & { __DSX_OPTIONAL_BUTTON_VARIANTS__?: boolean })
    .__DSX_OPTIONAL_BUTTON_VARIANTS__ !== false ? BUTTON_VARIANTS_CSS_B : ""}    .dsx-pressable:not(:disabled):not([aria-disabled="true"]):hover {
      background: color-mix(in srgb, var(--dsx-fill) 55%, transparent);
    }
    .dsx-text a:hover { text-decoration: underline; }
  }

${(globalThis as typeof globalThis & { __DSX_OPTIONAL_BUTTON_VARIANTS__?: boolean })
    .__DSX_OPTIONAL_BUTTON_VARIANTS__ !== false ? BUTTON_VARIANTS_CSS_C : ""}  .dsx-button[data-dsx-variant="prominent"] {
    background: var(--dsx-accent);
    color: var(--dsx-on-accent);
    padding-inline: var(--dsx-button-density-pad-strong);
    min-height: var(--dsx-button-min-height);
  }
${(globalThis as typeof globalThis & { __DSX_OPTIONAL_BUTTON_VARIANTS__?: boolean })
    .__DSX_OPTIONAL_BUTTON_VARIANTS__ !== false ? BUTTON_VARIANTS_CSS_D : ""}${(globalThis as typeof globalThis & { __DSX_OPTIONAL_BUTTON_VARIANTS__?: boolean })
    .__DSX_OPTIONAL_BUTTON_VARIANTS__ !== false ? BUTTON_VARIANTS_CSS_E : ""}${(globalThis as typeof globalThis & { __DSX_OPTIONAL_PRESSED__?: boolean })
    .__DSX_OPTIONAL_PRESSED__ !== false ? PRESSED_BUTTON_CSS : ""}${(globalThis as typeof globalThis & { __DSX_OPTIONAL_BUTTON_VARIANTS__?: boolean })
    .__DSX_OPTIONAL_BUTTON_VARIANTS__ !== false ? BUTTON_VARIANTS_CSS_F : ""}  .dsx-button[data-dsx-variant="prominent"]:not(:disabled):not([aria-disabled="true"]):active {
    background: var(--dsx-accent-pressed);
  }
${(globalThis as typeof globalThis & { __DSX_OPTIONAL_BUTTON_VARIANTS__?: boolean })
    .__DSX_OPTIONAL_BUTTON_VARIANTS__ !== false ? BUTTON_VARIANTS_CSS_G : ""}  .dsx-button:not(:disabled):not([aria-disabled="true"]):active {
    transform: scale(0.98);
  }
  .dsx-button:focus-visible {
    outline: var(--dsx-focus-ring-outline);
    outline-offset: var(--dsx-focus-ring-offset);
    box-shadow: var(--dsx-button-shadow);
    z-index: 1;
  }
${(globalThis as typeof globalThis & { __DSX_OPTIONAL_BUTTON_VARIANTS__?: boolean })
    .__DSX_OPTIONAL_BUTTON_VARIANTS__ !== false ? BUTTON_VARIANTS_CSS_H : ""}
  .dsx-pressable {
    appearance: none;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    font: inherit;
    color: inherit;
    text-align: inherit;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    border-radius: var(--dsx-radius-control);
    text-decoration: none;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition:
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      color var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-pressable:focus-visible {
    outline: var(--dsx-focus-ring-outline);
    outline-offset: var(--dsx-focus-ring-offset);
    z-index: 1;
  }
  .dsx-pressable:is([aria-current="page"], [aria-selected="true"], [aria-pressed="true"]) {
    color: var(--dsx-accent);
    background: var(--dsx-accent-muted);
  }
  .dsx-pressable:not(:disabled):not([aria-disabled="true"]):active {
    background: var(--dsx-fill);
  }
  .dsx-pressable:disabled, .dsx-pressable[aria-disabled="true"] {
    cursor: not-allowed;
    opacity: .45;
    filter: saturate(.5);
    transform: none;
  }
  .dsx-tappable { cursor: pointer; transition: opacity var(--dsx-dur-fast) var(--dsx-ease); }
  .dsx-tappable:active { opacity: .8; }

${(globalThis as typeof globalThis & { __DSX_OPTIONAL_SURFACES__?: boolean })
    .__DSX_OPTIONAL_SURFACES__ !== false ? SURFACE_ELEMENTS_CSS : ""}  .dsx-scroll {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    min-height: 0;
    scrollbar-gutter: stable;
    scrollbar-color: var(--dsx-separator) transparent;
  }
  .dsx-scroll > * { flex-shrink: 0; }
  .dsx-scroll-x { flex-direction: row; overflow-y: hidden; overflow-x: auto; }
${(globalThis as typeof globalThis & { __DSX_OPTIONAL_STATIC_ELEMENTS__?: boolean })
    .__DSX_OPTIONAL_STATIC_ELEMENTS__ !== false ? STATIC_ELEMENTS_CSS_A : ""}
${(globalThis as typeof globalThis & { __DSX_OPTIONAL_BOUND_COLLECTIONS__?: boolean })
    .__DSX_OPTIONAL_BOUND_COLLECTIONS__ !== false ? COLLECTION_ELEMENTS_CSS : ""}${(globalThis as typeof globalThis & { __DSX_OPTIONAL_STATIC_ELEMENTS__?: boolean })
    .__DSX_OPTIONAL_STATIC_ELEMENTS__ !== false ? STATIC_ELEMENTS_CSS_B : ""}
  .dsx-button > svg { flex: none; }

  .dsx-unsupported {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    border: var(--dsx-hairline) dashed var(--dsx-separator);
    border-radius: var(--dsx-radius);
    padding: 0.75rem;
    color: var(--dsx-secondary-label);
    font-family: var(--dsx-font);
    font-size: var(--dsx-type-caption-size);
  }
  .dsx-unsupported-label {
    display: block;
    max-width: 100%;
    overflow: hidden;
    opacity: .8;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (pointer: coarse) {
    .dsx-pressable { min-height: 48px; }
    ` +
// THE 44px RESOLUTION (component-library.md contract 3 x the wave-7 40px ruling):
// the regular button keeps its 40px VISUAL on coarse pointers and meets the
// --dsx-hit-target-min floor with the switch's padded-hit-area pattern — a transparent
// pseudo-element expands the tap target, no layout shift. Stars widen the same pseudo on
// both axes in RICH_ELEMENTS_CSS — the only sheet that mounts .dsx-star, so a sliced
// embed with no stars carries no star rule.
`    .dsx-button { position: relative; }
    .dsx-button::after {
      content: "";
      position: absolute;
      inset-inline: 0;
      top: min(0px, calc((100% - var(--dsx-hit-target-min)) / 2));
      bottom: min(0px, calc((100% - var(--dsx-hit-target-min)) / 2));
    }

    .dsx-scroll { scrollbar-gutter: auto; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-button, .dsx-pressable { transition: none; }
  }
  @media (forced-colors: active) {
    .dsx-button, .dsx-pressable, .dsx-unsupported { border: 1px solid ButtonText; }
    .dsx-button:focus-visible, .dsx-pressable:focus-visible {
      outline: 2px solid Highlight;
      outline-offset: 2px;
      box-shadow: none;
    }
  }
}`;

/** Optional form/progress control skin. Control factories remain available in the
 * base runtime, but a sliced custom-element embed only carries these rules when its
 * transitive component tree references one of those controls. Full apps always
 * inject this sheet. */
export const CONTROL_ELEMENTS_CSS = `@layer dsx-elements {
  .dsx-toggle {
    --dsx-control-tint: var(--dsx-accent);
    --dsx-toggle-box-width: var(--dsx-toggle-track-width);
    --dsx-toggle-travel: calc(var(--dsx-toggle-track-width) - var(--dsx-toggle-thumb-width) - 2 * var(--dsx-toggle-thumb-inset));
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--dsx-toggle-box-width);
    height: var(--dsx-toggle-box-height);
    flex: none;
  }
  .dsx-toggle input {
    position: absolute;
    /* THE HIT FLOOR, OFF THE LAYOUT BOX. The switch is a 42x24 pill on every platform,
       but its BOX was sized to the 48px large-control height to buy the 44pt tap target -
       which inflated every row that holds one (a settings row measured 80px against a
       platform's 52). The floor now rides this overlay input instead: the negative inset
       grows the interactive rect to 44x44 without adding a pixel of layout. */
    inset: min(0px, calc((100% - var(--dsx-hit-target-min)) / 2));
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .dsx-toggle-track {
    box-sizing: border-box;
    width: var(--dsx-toggle-track-width);
    height: var(--dsx-toggle-track-height);
    margin: auto;
    border: 0;
    border-radius: var(--dsx-radius-full);
    background: color-mix(in srgb, var(--dsx-secondary-label) 24%, var(--dsx-surface-recessed));
    box-shadow: inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-label) 10%, transparent);
    transition:
      background-color var(--dsx-dur-base) var(--dsx-ease),
      box-shadow var(--dsx-dur-base) var(--dsx-ease);
    pointer-events: none;
  }
  .dsx-toggle input:checked + .dsx-toggle-track {
    background: var(--dsx-control-tint);
    box-shadow: inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-control-tint) 84%, var(--dsx-label));
  }
  .dsx-toggle input:focus-visible + .dsx-toggle-track {
    outline: var(--dsx-focus-ring-width) solid var(--dsx-control-tint);
    outline-offset: var(--dsx-focus-ring-offset);
  }
  .dsx-toggle input:disabled { cursor: not-allowed; }
  .dsx-toggle input:disabled + .dsx-toggle-track {
    opacity: .42;
    filter: saturate(.45);
  }
  .dsx-toggle-thumb {
    display: block;
    box-sizing: border-box;
    width: var(--dsx-toggle-thumb-width);
    height: var(--dsx-toggle-thumb-size);
    margin: var(--dsx-toggle-thumb-inset);
    border: 0;
    border-radius: var(--dsx-radius-full);
    background: var(--dsx-control-knob);
    box-shadow: var(--dsx-shadow-1);
    will-change: transform;
    transition:
      transform var(--dsx-dur-base) var(--dsx-ease-spring),
      width var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-toggle input:checked + .dsx-toggle-track .dsx-toggle-thumb { transform: translateX(var(--dsx-toggle-travel)); }
  [dir="rtl"] .dsx-toggle-track .dsx-toggle-thumb { transform: translateX(var(--dsx-toggle-travel)); }
  [dir="rtl"] .dsx-toggle input:checked + .dsx-toggle-track .dsx-toggle-thumb { transform: translateX(0); }
  .dsx-toggle input:not(:disabled):active + .dsx-toggle-track .dsx-toggle-thumb {
    width: calc(var(--dsx-toggle-thumb-width) + var(--dsx-toggle-stretch, 6px));
  }
  .dsx-toggle input:checked:not(:disabled):active + .dsx-toggle-track .dsx-toggle-thumb {
    transform: translateX(calc(var(--dsx-toggle-travel) - var(--dsx-toggle-stretch, 6px)));
  }
  [dir="rtl"] .dsx-toggle input:not(:checked):not(:disabled):active + .dsx-toggle-track .dsx-toggle-thumb {
    transform: translateX(calc(var(--dsx-toggle-travel) - var(--dsx-toggle-stretch, 6px)));
  }
  [dir="rtl"] .dsx-toggle input:checked:not(:disabled):active + .dsx-toggle-track .dsx-toggle-thumb {
    transform: translateX(0);
  }
  @media (hover: hover) and (pointer: fine) {
    .dsx-toggle input:not(:disabled):hover + .dsx-toggle-track {
      box-shadow: inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-label) 24%, var(--dsx-separator));
    }
  }

  .dsx-slider {
    --dsx-control-tint: var(--dsx-accent);
    --dsx-slider-position: 0%;
    --dsx-slider-direction: to right;
    --dsx-slider-track-color: color-mix(in srgb, var(--dsx-secondary-label) 24%, var(--dsx-surface-recessed));
    --dsx-slider-fill-color: var(--dsx-control-tint);
    --dsx-slider-thumb-color: var(--dsx-control-knob);
    --dsx-slider-thumb-shadow-color: var(--dsx-control-knob-shadow);
    appearance: none;
    accent-color: var(--dsx-control-tint);
    display: block;
    width: 100%;
    height: var(--dsx-slider-box-height);
    min-height: var(--dsx-slider-box-height);
    margin: 0;
    padding: 0;
    border: 0;
    outline: 0;
    background: transparent;
    cursor: pointer;
    touch-action: manipulation;
  }
  [dir="rtl"] .dsx-slider { --dsx-slider-direction: to left; }
  .dsx-slider::-webkit-slider-runnable-track {
    box-sizing: border-box;
    width: 100%;
    height: var(--dsx-slider-track-size);
    border: 0;
    border-radius: var(--dsx-radius-full);
    background: linear-gradient(
      var(--dsx-slider-direction),
      var(--dsx-slider-fill-color) 0 var(--dsx-slider-position),
      var(--dsx-slider-track-color) var(--dsx-slider-position) 100%
    );
    box-shadow:
      inset 0 1px 1px color-mix(in srgb, var(--dsx-label) 11%, transparent),
      0 1px 0 color-mix(in srgb, var(--dsx-control-knob) 38%, transparent);
  }
  .dsx-slider::-moz-range-track {
    box-sizing: border-box;
    width: 100%;
    height: var(--dsx-slider-track-size);
    border: 0;
    border-radius: var(--dsx-radius-full);
    background: var(--dsx-slider-track-color);
    box-shadow:
      inset 0 1px 1px color-mix(in srgb, var(--dsx-label) 11%, transparent),
      0 1px 0 color-mix(in srgb, var(--dsx-control-knob) 38%, transparent);
  }
  .dsx-slider::-moz-range-progress {
    height: var(--dsx-slider-track-size);
    border-radius: var(--dsx-radius-full);
    background: var(--dsx-slider-fill-color);
  }
  .dsx-slider::-webkit-slider-thumb {
    appearance: none;
    box-sizing: border-box;
    width: var(--dsx-slider-thumb-size);
    height: var(--dsx-slider-thumb-size);
    margin-top: calc((var(--dsx-slider-track-size) - var(--dsx-slider-thumb-size)) / 2);
    border: var(--dsx-hairline) solid color-mix(in srgb, var(--dsx-label) 18%, transparent);
    border-radius: 50%;
    background: linear-gradient(
      165deg,
      var(--dsx-slider-thumb-color),
      var(--dsx-slider-thumb-shadow-color)
    );
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 .5px 3px color-mix(in srgb, var(--dsx-label) 18%, transparent),
      0 4px 10px color-mix(in srgb, var(--dsx-label) 13%, transparent);
    transition:
      box-shadow var(--dsx-dur-base) var(--dsx-ease-out),
      transform var(--dsx-dur-fast) var(--dsx-ease-out);
  }
  .dsx-slider::-moz-range-thumb {
    box-sizing: border-box;
    width: var(--dsx-slider-thumb-size);
    height: var(--dsx-slider-thumb-size);
    border: var(--dsx-hairline) solid color-mix(in srgb, var(--dsx-label) 18%, transparent);
    border-radius: 50%;
    background: linear-gradient(
      165deg,
      var(--dsx-slider-thumb-color),
      var(--dsx-slider-thumb-shadow-color)
    );
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 .5px 3px color-mix(in srgb, var(--dsx-label) 18%, transparent),
      0 4px 10px color-mix(in srgb, var(--dsx-label) 13%, transparent);
    transition:
      box-shadow var(--dsx-dur-base) var(--dsx-ease-out),
      transform var(--dsx-dur-fast) var(--dsx-ease-out);
  }
` +
// range thumbs are pseudo-elements: outline cannot offset from them reliably, so
// the ring stays a box-shadow drawn at the shared width (the recipe's one
// documented pseudo-element exception)
`  .dsx-slider:focus-visible::-webkit-slider-thumb {
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 .5px 3px color-mix(in srgb, var(--dsx-label) 18%, transparent),
      0 0 0 var(--dsx-focus-ring-width) var(--dsx-control-tint);
  }
  .dsx-slider:focus-visible::-moz-range-thumb {
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 .5px 3px color-mix(in srgb, var(--dsx-label) 18%, transparent),
      0 0 0 var(--dsx-focus-ring-width) var(--dsx-control-tint);
  }
  .dsx-slider:not(:disabled):active::-webkit-slider-thumb { transform: scale(1.08); }
  .dsx-slider:not(:disabled):active::-moz-range-thumb { transform: scale(1.08); }
  @media (hover: hover) and (pointer: fine) {
    .dsx-slider:not(:disabled):hover::-webkit-slider-thumb {
      box-shadow:
        inset 0 1px 0 var(--dsx-inner-highlight),
        0 .5px 3px color-mix(in srgb, var(--dsx-label) 20%, transparent),
        0 5px 12px color-mix(in srgb, var(--dsx-label) 15%, transparent);
    }
    .dsx-slider:not(:disabled):hover::-moz-range-thumb {
      box-shadow:
        inset 0 1px 0 var(--dsx-inner-highlight),
        0 .5px 3px color-mix(in srgb, var(--dsx-label) 20%, transparent),
        0 5px 12px color-mix(in srgb, var(--dsx-label) 15%, transparent);
    }
  }
  .dsx-slider:disabled {
    cursor: not-allowed;
    opacity: .42;
    filter: saturate(.45);
  }

  .dsx-textfield, .dsx-textarea {
    font-family: var(--dsx-font);
    font-size: var(--dsx-field-density-type);
    font-weight: var(--dsx-type-label-weight);
    color: var(--dsx-label);
    caret-color: var(--dsx-accent);
    background: var(--dsx-surface-recessed);
    border: 0;
    border-radius: var(--dsx-radius);
    padding: 0 var(--dsx-field-density-pad);
    min-height: var(--dsx-control-height);
    line-height: var(--dsx-type-caption-leading);
    box-shadow:
      inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft),
      inset 0 1px 2px color-mix(in srgb, var(--dsx-label) 7%, transparent);
    transition:
      box-shadow var(--dsx-dur-base) var(--dsx-ease-out),
      background-color var(--dsx-dur-fast) ease;
  }
  .dsx-textfield::placeholder, .dsx-textarea::placeholder { color: var(--dsx-tertiary-label); opacity: 1; }
  .dsx-textfield:focus-visible, .dsx-textarea:focus-visible {
    outline: none;
    background: var(--dsx-surface-level-1);
    box-shadow: var(--dsx-focus-ring-inset), var(--dsx-focus-ring-halo);
  }
` +
// the danger skin re-declares the ONE colour knob; ring and halo follow it
`  .dsx-textfield[aria-invalid="true"], .dsx-textarea[aria-invalid="true"] {
    --dsx-focus-ring-color: var(--dsx-destructive);
    box-shadow: var(--dsx-focus-ring-inset), var(--dsx-focus-ring-halo);
  }
  .dsx-textfield:read-only, .dsx-textarea:read-only {
    color: var(--dsx-secondary-label);
    background: color-mix(in srgb, var(--dsx-surface-recessed) 72%, transparent);
  }
  .dsx-textfield:disabled, .dsx-textarea:disabled {
    cursor: not-allowed;
    opacity: .52;
  }
  @media (hover: hover) and (pointer: fine) {
    .dsx-textfield:not(:disabled):not(:focus-visible):hover,
    .dsx-textarea:not(:disabled):not(:focus-visible):hover {
      background: color-mix(in srgb, var(--dsx-surface-recessed) 96%, var(--dsx-label));
      box-shadow:
        inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-label) 24%, var(--dsx-separator)),
        inset 0 1px 2px color-mix(in srgb, var(--dsx-label) 8%, transparent);
    }
  }
  .dsx-searchbar { padding-inline: calc(var(--dsx-field-density-pad) + 0.125rem); }
` +
// <searchbar> composite anatomy: the leading glass + trailing clear ride a
// presentational shell around the SAME real input (/web/17).
`  .dsx-searchbar-field {
    --dsx-searchbar-color: var(--dsx-accent);
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .dsx-searchbar-field .dsx-searchbar {
    flex: 1 1 auto;
    min-width: 0;
    padding-inline-start: 2.25rem;
    padding-inline-end: 2.25rem;
    caret-color: var(--dsx-searchbar-color);
  }
  .dsx-searchbar-field .dsx-searchbar::-webkit-search-cancel-button { appearance: none; display: none; }
  .dsx-searchbar-icon {
    position: absolute;
    inset-inline-start: 0.75rem;
    display: inline-flex;
    color: var(--dsx-secondary-label);
    pointer-events: none;
    line-height: 0;
  }
  .dsx-searchbar-clear {
    position: absolute;
    inset-inline-end: 0.5rem;
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--dsx-secondary-label);
    cursor: pointer;
  }
  .dsx-searchbar-clear[hidden] { display: none; }
  .dsx-searchbar-clear:focus-visible {
    outline: var(--dsx-focus-ring-outline);
    outline-offset: var(--dsx-focus-ring-offset);
    z-index: 1;
  }
` +
// minLines FLOORS the auto-grown box and maxLines caps it, both from the author's numbers.
// The floor was a hardcoded 6rem, which is three lines by coincidence and ignores minLines
// entirely: `<textarea minLines="1">` still reserved three lines of empty well.
`  .dsx-textarea {
    --dsx-textarea-max-lines: 8;
    --dsx-textarea-min-lines: 3;
    min-height: calc(var(--dsx-textarea-min-lines) * 1.35em + 1.25rem);
    max-height: calc(var(--dsx-textarea-max-lines) * 1.35em + 1.25rem);
    padding-block: var(--dsx-textarea-density-pad-block);
    resize: vertical;
    overflow-y: auto;
  }

` +
// min-width is the UA range intrinsic (~129px = 8rem): a non-stretch container
// (hstack hug, zstack center) must not collapse the bar to 0 (W9 audit fix).
`  .dsx-progress { height: 6px;
    min-width: 8rem;
    border-radius: var(--dsx-radius-full);
    color: var(--dsx-accent);
    background: var(--dsx-surface-recessed);
    box-shadow: inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft);
    overflow: hidden;
    align-self: stretch;
  }
  .dsx-progress-fill {
    height: 100%;
    border-radius: inherit;
    background: currentColor;
    box-shadow: inset 0 1px 0 var(--dsx-inner-highlight);
    transition: width var(--dsx-dur-base) var(--dsx-ease);
  }

  .dsx-spinner {
    --dsx-spinner-color: var(--dsx-secondary-label);
    --dsx-spinner-scale: 1;
    box-sizing: border-box;
    width: 22px;
    height: 22px;
    flex: none;
    border-radius: 50%;
    border: 2.5px solid color-mix(in srgb, var(--dsx-spinner-color) 16%, transparent);
    border-top-color: var(--dsx-spinner-color);
    animation: dsx-spin var(--dsx-dur-loop) linear infinite;
  }
  @keyframes dsx-spin {
    from { transform: rotate(0deg) scale(var(--dsx-spinner-scale)); }
    to { transform: rotate(360deg) scale(var(--dsx-spinner-scale)); }
  }

  .dsx-stepper {
    --dsx-stepper-color: var(--dsx-accent);
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: var(--dsx-surface-recessed);
    border: 0;
    border-radius: var(--dsx-radius);
    padding: 2px;
    min-height: var(--dsx-control-height);
    box-shadow: inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft);
  }
  .dsx-stepper-btn {
    appearance: none;
    border: none;
    background: none;
    color: var(--dsx-stepper-color);
    font-family: var(--dsx-font);
    font-size: var(--dsx-glyph-size);
    width: var(--dsx-control-height-sm);
    height: var(--dsx-control-height-sm);
    border-radius: calc(var(--dsx-radius) - 2px);
    cursor: pointer;
  }
  .dsx-stepper-btn:focus-visible {
    outline: var(--dsx-focus-ring-outline);
    outline-offset: var(--dsx-focus-ring-offset);
    z-index: 1;
  }
  .dsx-stepper-btn:disabled { cursor: not-allowed; opacity: .46; }
  .dsx-stepper-btn:not(:disabled):active { background: var(--dsx-fill); }
  .dsx-stepper-value { color: var(--dsx-label); font-family: var(--dsx-font); min-width: 2ch; text-align: center; }
  .dsx-stepper-label {
    color: var(--dsx-label);
    font-family: var(--dsx-font);
    font-size: var(--dsx-type-body);
    padding-inline: 0.5rem 0.25rem;
  }
  .dsx-stepper-label[hidden] { display: none; }
  @media (pointer: coarse) {
    .dsx-textfield { min-height: 48px; }
    .dsx-stepper { padding: 0; }
    .dsx-stepper-btn { min-width: 48px; min-height: 48px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-toggle-track, .dsx-toggle-thumb, .dsx-slider::-webkit-slider-thumb,
    .dsx-slider::-moz-range-thumb, .dsx-textfield, .dsx-textarea { transition: none; }
    .dsx-spinner {
      animation: none;
      transform: scale(var(--dsx-spinner-scale));
    }
    .dsx-progress-fill { transition: none; }
  }
  @media (prefers-contrast: more) {
    .dsx-textfield, .dsx-textarea, .dsx-stepper {
      border: 1px solid var(--dsx-secondary-label);
      box-shadow: none;
    }
  }
  @media (forced-colors: active) {
    .dsx-toggle-track, .dsx-textfield, .dsx-textarea, .dsx-stepper { border: 1px solid ButtonText; }
    .dsx-slider::-webkit-slider-runnable-track,
    .dsx-slider::-moz-range-track { background: CanvasText; box-shadow: none; }
    .dsx-slider::-moz-range-progress {
      forced-color-adjust: none;
      background: Highlight;
    }
    .dsx-slider::-webkit-slider-thumb,
    .dsx-slider::-moz-range-thumb {
      border: 1px solid Highlight;
      background: Canvas;
      box-shadow: none;
    }
    .dsx-toggle input:focus-visible + .dsx-toggle-track,
    .dsx-slider:focus-visible,
    .dsx-textfield:focus-visible, .dsx-textarea:focus-visible,
    .dsx-stepper-btn:focus-visible {
      outline: 2px solid Highlight;
      outline-offset: 2px;
      box-shadow: none;
    }
  }
}`;

/** Optional richer-native element skin. Keep this out of the base sheet so a
 * self-contained embed that only uses layout/text/buttons does not pay for rich
 * primitives it cannot mount. Full applications and rich registry slices include it. */
export const RICH_ELEMENTS_CSS = `@layer dsx-elements {
  .dsx-segmented {
    --dsx-segment-gap: 2px;
    --dsx-segment-inset: 2px;
    --dsx-segment-indicator-x: var(--dsx-segment-inset);
    --dsx-segment-indicator-y: var(--dsx-segment-inset);
    --dsx-segment-indicator-width: calc(100% - var(--dsx-segment-inset) - var(--dsx-segment-inset));
    --dsx-segment-indicator-height: calc(100% - var(--dsx-segment-inset) - var(--dsx-segment-inset));
    --dsx-segment-plate-inset: 0px;
    position: relative;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    gap: var(--dsx-segment-gap);
    min-height: var(--dsx-control-height);
    padding: var(--dsx-segment-inset);
    border: 0;
    border-radius: var(--dsx-radius);
    background: var(--dsx-surface-recessed);
    box-shadow:
      inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft),
      inset 0 1px 2px color-mix(in srgb, var(--dsx-label) 7%, transparent);
    overflow: auto hidden;
  }
  .dsx-segmented-indicator {
    position: absolute;
    z-index: 0;
    left: var(--dsx-segment-indicator-x);
    top: var(--dsx-segment-indicator-y);
    width: var(--dsx-segment-indicator-width);
    height: var(--dsx-segment-indicator-height);
    pointer-events: none;
    opacity: 0;
    /* THE FIRST POSITION IS NOT A MOVE. The indicator's geometry rides four custom
       properties, so before the first measurement lands it holds their fallback - the
       whole track - and a transition on the base rule ANIMATED that: measured, the pill
       entered 310px wide and shrank to 76 over ~900ms, so every load showed a segmented
       control visibly assembling itself over three of its four options. The correction
       animated because the FIRST measurement is taken pre-layout, when option one still
       spans the whole track. Only opacity transitions here; geometry transitions solely
       under [data-animate], which elements.ts sets for a selection move alone. */
    transition: opacity var(--dsx-dur-fast) ease;
  }
  .dsx-segmented-indicator::before {
    content: "";
    position: absolute;
    inset: var(--dsx-segment-plate-inset);
    border: var(--dsx-hairline) solid var(--dsx-outline-soft);
    border-radius: calc(var(--dsx-radius) - 2px);
    background: linear-gradient(
      165deg,
      var(--dsx-surface-highlight),
      var(--dsx-surface-level-3)
    );
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 1px 2px color-mix(in srgb, var(--dsx-label) 12%, transparent),
      0 3px 7px color-mix(in srgb, var(--dsx-label) 7%, transparent);
  }
  .dsx-segmented-indicator[data-positioned="true"] { opacity: 1; }
  /* The pill glides for a SELECTION MOVE and for nothing else. Layout-driven positions -
     the first measurement, a resize, an options change - are facts, not movement, and are
     committed with this transition absent. */
  .dsx-segmented-indicator[data-animate="true"] {
    transition:
      left var(--dsx-dur-base) var(--dsx-ease-out),
      top var(--dsx-dur-base) var(--dsx-ease-out),
      width var(--dsx-dur-base) var(--dsx-ease-out),
      height var(--dsx-dur-base) var(--dsx-ease-out),
      opacity var(--dsx-dur-fast) ease;
  }
  .dsx-segmented-indicator[hidden] { display: none; }
  .dsx-segmented > .dsx-segmented-option {
    position: relative;
    z-index: 1;
    min-width: var(--dsx-control-height);
    min-height: var(--dsx-control-height-sm);
    padding: 0 .75rem;
    border: 0;
    border-radius: calc(var(--dsx-radius) - 2px);
    color: var(--dsx-secondary-label);
    background: transparent;
    font: 600 var(--dsx-type-label)/1.2 var(--dsx-font);
    white-space: nowrap;
    cursor: pointer;
    box-shadow: none;
    transition:
      color var(--dsx-dur-fast) ease,
      opacity var(--dsx-dur-fast) ease,
      transform var(--dsx-dur-fast) var(--dsx-ease-out);
  }
  @media (pointer: coarse) {
    .dsx-segmented {
      --dsx-segment-gap: 0px;
      --dsx-segment-inset: 0px;
      --dsx-segment-plate-inset: 2px;
      min-height: 48px;
    }
    .dsx-segmented > .dsx-segmented-option {
      min-width: 48px;
      min-height: 48px;
    }
    .dsx-map-control { min-width: 48px; min-height: 48px; }
    .dsx-star::after {
      inset-inline: min(0px, calc((100% - 44px) / 2));
    }
  }
  .dsx-segmented > .dsx-segmented-option[data-selected="true"] {
    color: var(--dsx-label);
    background: transparent;
    box-shadow: none;
  }
  .dsx-segmented > .dsx-segmented-option:focus-visible {
    z-index: 2;
    outline: none;
    box-shadow: inset 0 0 0 var(--dsx-focus-ring-width) var(--dsx-accent);
  }
  .dsx-segmented > .dsx-segmented-option:disabled {
    cursor: not-allowed;
    opacity: .48;
  }
  .dsx-segmented > .dsx-segmented-option:not(:disabled):active {
    opacity: .76;
    transform: scale(.98);
  }
  @media (hover: hover) and (pointer: fine) {
    .dsx-segmented > .dsx-segmented-option:not([data-selected="true"]):not(:disabled):hover {
      color: var(--dsx-label);
      background: color-mix(in srgb, var(--dsx-fill) 76%, transparent);
    }
  }
  .dsx-stars {
    display: inline-flex;
    align-items: center;
    min-height: var(--dsx-control-height);
    gap: var(--dsx-star-gap);
    color: var(--dsx-rating);
  }
  .dsx-star {
    display: inline-grid;
    place-items: center;
    min-width: var(--dsx-star-hit-size);
    min-height: var(--dsx-star-hit-size);
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
  }
  .dsx-star svg {
    display: block;
    width: var(--dsx-star-size, 24px);
    height: var(--dsx-star-size, 24px);
    transition:
      transform var(--dsx-dur-base) var(--dsx-ease-spring),
      filter var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-button.dsx-star:not(:disabled):not([aria-disabled="true"]):active svg {
    transform: scale(0.88);
    filter: brightness(1.08);
    transition:
      transform var(--dsx-dur-fast) var(--dsx-ease),
      filter var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-star:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 var(--dsx-focus-ring-width) var(--dsx-accent);
    border-radius: var(--dsx-radius-sm);
  }
  .dsx-chart, .dsx-map { position: relative; display: block; width: 100%; min-height: 180px; }
  .dsx-chart { margin: 0; color: var(--dsx-accent); }
  .dsx-map {
    min-height: 220px;
    overflow: hidden;
    touch-action: none;
    border: var(--dsx-hairline) solid color-mix(in srgb, var(--dsx-separator) 82%, transparent);
    border-radius: var(--dsx-radius-lg);
    background-color: var(--dsx-secondary-grouped-background);
    background-image: linear-gradient(var(--dsx-separator) 1px, transparent 1px),
                      linear-gradient(90deg, var(--dsx-separator) 1px, transparent 1px);
    background-size: 32px 32px;
  }
  .dsx-map:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 var(--dsx-focus-ring-width) var(--dsx-accent);
  }
  .dsx-map-pins { position: absolute; inset: 0; pointer-events: none; }
  .dsx-map-status {
    position: absolute;
    inset: auto auto 8px 8px;
    max-width: calc(100% - 72px);
    padding: 3px 6px;
    border-radius: var(--dsx-radius-sm);
    font: 11px/1.3 var(--dsx-font);
    color: var(--dsx-secondary-label);
    background: color-mix(in srgb, var(--dsx-background) 88%, transparent);
  }
  .dsx-map-controls { position: absolute; inset: 8px 8px auto auto; display: flex; flex-direction: column; gap: 4px; }
  .dsx-map-control {
    width: var(--dsx-control-height);
    height: var(--dsx-control-height);
    padding: 0;
    border: var(--dsx-hairline) solid color-mix(in srgb, var(--dsx-separator) 82%, transparent);
    border-radius: var(--dsx-radius-sm);
    color: var(--dsx-label);
    background: var(--dsx-background);
    box-shadow: var(--dsx-shadow-xs);
    font-size: var(--dsx-glyph-size);
  }
  .dsx-webview { display: block; width: 100%; min-height: 160px; border: 0; background: var(--dsx-background); }
  .dsx-qrcode {
    display: inline-grid;
    place-items: center;
    width: var(--dsx-qr-size);
    height: var(--dsx-qr-size);
    max-width: 100%;
    aspect-ratio: 1;
  }
  .dsx-qrcode-error {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    padding: 8px;
    color: var(--dsx-destructive);
    font: 12px var(--dsx-font);
    text-align: center;
  }
  .dsx-static-status { display: grid; place-items: center; width: 100%; height: 100%; color: var(--dsx-secondary-label); }
  @media (prefers-reduced-motion: reduce) {
    .dsx-segmented-indicator,
    .dsx-segmented > .dsx-segmented-option,
    .dsx-star svg { transition: none; }
  }
  @media (forced-colors: active) {
    .dsx-segmented, .dsx-map { border: 1px solid ButtonText; }
    .dsx-segmented-indicator::before {
      border-color: Highlight;
      background: Canvas;
      box-shadow: none;
    }
    .dsx-segmented > .dsx-segmented-option[data-selected="true"] {
      outline: 2px solid Highlight;
      outline-offset: -2px;
      box-shadow: none;
    }
    .dsx-segmented > .dsx-segmented-option:focus-visible,
    .dsx-star:focus-visible,
    .dsx-map:focus-visible {
      outline: 3px double Highlight;
      outline-offset: -4px;
      box-shadow: none;
    }
  }
}`;
