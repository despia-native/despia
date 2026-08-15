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
    --dsx-font: system-ui, "Segoe UI", Roboto, sans-serif;
    --dsx-rating: #b77900;
    --dsx-focus-ring: 0 0 0 3px var(--dsx-accent);
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
    }
  }
  [data-dsx-theme="dark"], :host([data-dsx-theme="dark"]) {
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
    --dsx-focus-ring: 0 0 0 3px var(--dsx-accent);
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
    --dsx-focus-ring: 0 0 0 3px var(--dsx-accent);
  }
  :root, :host, [data-dsx-theme] {
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
    --dsx-outline-soft: color-mix(in srgb, var(--dsx-separator) 82%, transparent);
    --dsx-control-height-sm: 32px;
    --dsx-control-height-lg: 48px;
    --dsx-control-padding-inline: 0.875rem;
    --dsx-control-gap: 0.5rem;
    --dsx-icon-size: 1rem;
    --dsx-type-caption: 0.75rem;
    --dsx-type-label: 0.8125rem;
    --dsx-type-body: 0.9375rem;
    --dsx-type-section: 1.0625rem;
    --dsx-motion-fast: 120ms;
    --dsx-motion-standard: 180ms;
    --dsx-ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    :root, :host, [data-dsx-theme] {
      --dsx-radius-sm: 6px;
      --dsx-radius: 8px;
      --dsx-radius-lg: 12px;
      --dsx-gap: 6px;
      --dsx-control-height-sm: 28px;
      --dsx-control-height: 32px;
      --dsx-control-height-lg: 36px;
      --dsx-control-padding-inline: 0.75rem;
      --dsx-control-gap: 0.375rem;
    }
  }
  @media (min-resolution: 2dppx) {
    :root, :host, [data-dsx-theme] { --dsx-hairline: 0.5px; }
  }
  @media (min-resolution: 3dppx) {
    :root, :host, [data-dsx-theme] { --dsx-hairline: 0.333333px; }
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
    line-height: 1.45;
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
  .dsx-hstack > [data-dsx-grow="width"], .dsx-hstack > [data-dsx-grow="true"] {
    align-self: auto; flex-grow: 1; flex-shrink: 1; min-width: 0;
  }
  .dsx-hstack > [data-dsx-grow="true"] { align-self: stretch; }
  .dsx-hstack > [data-dsx-grow="height"] { flex-grow: 0; align-self: stretch; }
  .dsx-zstack { display: grid; align-items: center; justify-items: center; justify-content: center; }
  .dsx-zstack > * { grid-area: 1 / 1; }
  .dsx-stack[style*="display: grid"] > *, .dsx-stack[data-dsx-grid] > * { grid-area: 1 / 1; }

  .dsx-text { font-family: var(--dsx-font); min-width: 0; overflow-wrap: anywhere; flex: none; }

  .dsx-button {
    --dsx-button-shadow: inset 0 0 0 0 transparent;
    --dsx-button-min-height: var(--dsx-control-height);
    --dsx-button-radius: var(--dsx-radius);
    --dsx-button-padding-inline: var(--dsx-control-padding-inline);
    --dsx-button-font-size: 0.9375rem;
    --dsx-button-font-weight: 600;
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--dsx-control-gap);
    font-family: var(--dsx-font);
    font-size: var(--dsx-button-font-size);
    font-weight: var(--dsx-button-font-weight);
    line-height: 1.2;
    letter-spacing: -0.006em;
    color: var(--dsx-label);
    background: transparent;
    border: 0;
    padding: 0 var(--dsx-button-padding-inline);
    min-height: var(--dsx-button-min-height);
    border-radius: var(--dsx-button-radius);
    box-shadow: var(--dsx-button-shadow);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition:
      background-color var(--dsx-motion-fast) ease,
      filter var(--dsx-motion-fast) ease;
  }
  .dsx-button > span, .dsx-button > svg {
    transition: opacity 80ms ease;
  }
  .dsx-button:not(:disabled):not([aria-disabled="true"]):active > span,
  .dsx-button:not(:disabled):not([aria-disabled="true"]):active > svg {
    opacity: .88;
  }
  .dsx-button:disabled, .dsx-button[aria-disabled="true"] {
    cursor: not-allowed;
    opacity: .42;
    filter: saturate(.5);
  }
  .dsx-button[aria-busy="true"] { cursor: progress; opacity: .68; }
  @media (hover: hover) and (pointer: fine) {
    .dsx-button:not([data-dsx-variant]):not(:disabled):not([aria-disabled="true"]):hover {
      background: var(--dsx-surface-hover, color-mix(in srgb, var(--dsx-fill) 78%, transparent));
    }
    .dsx-button[data-dsx-variant="bordered"]:not(:disabled):not([aria-disabled="true"]):hover {
      background: linear-gradient(
        165deg,
        var(--dsx-surface-highlight),
        var(--dsx-surface-level-3)
      );
    }
    .dsx-button[data-dsx-variant="prominent"]:not(:disabled):not([aria-disabled="true"]):hover {
      filter: saturate(1.06) brightness(1.03);
    }
  }
  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    .dsx-button {
      --dsx-button-padding-inline: 0.625rem;
      --dsx-button-font-size: 0.8125rem;
      --dsx-button-radius: var(--dsx-radius-sm);
    }
  }

  .dsx-button[data-dsx-variant="bordered"] {
    --dsx-button-shadow:
      inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft),
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 1px 2px color-mix(in srgb, var(--dsx-label) 8%, transparent);
    background: linear-gradient(
      165deg,
      var(--dsx-surface-highlight),
      var(--dsx-surface-level-3)
    );
    color: var(--dsx-accent);
    padding-inline: 1rem;
    min-height: var(--dsx-button-min-height);
  }
  .dsx-button[data-dsx-variant="prominent"] {
    --dsx-button-shadow:
      inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-accent) 74%, var(--dsx-label)),
      inset 0 1px 0 color-mix(in srgb, var(--dsx-control-knob) 28%, transparent),
      0 1px 2px color-mix(in srgb, var(--dsx-accent) 24%, transparent);
    background: linear-gradient(
      165deg,
      color-mix(in srgb, var(--dsx-accent) 90%, var(--dsx-control-knob)),
      var(--dsx-accent)
    );
    color: var(--dsx-on-accent);
    padding-inline: 1rem;
    min-height: var(--dsx-button-min-height);
  }
  .dsx-button[data-dsx-role="destructive"] { color: var(--dsx-destructive); }
  .dsx-button[data-dsx-variant="bordered"][data-dsx-role="destructive"] {
    --dsx-button-shadow:
      inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-destructive) 42%, var(--dsx-separator)),
      inset 0 1px 0 var(--dsx-inner-highlight);
  }
  .dsx-button[data-dsx-variant="prominent"][data-dsx-role="destructive"] {
    background: linear-gradient(
      165deg,
      color-mix(in srgb, var(--dsx-destructive) 90%, var(--dsx-control-knob)),
      var(--dsx-destructive)
    );
    color: var(--dsx-on-destructive);
  }
  .dsx-button:not([data-dsx-variant])[aria-pressed="true"] {
    color: var(--dsx-accent);
    background: var(--dsx-fill);
  }
  .dsx-button[data-dsx-variant="bordered"][aria-pressed="true"] {
    background: var(--dsx-surface-recessed);
  }
  .dsx-button[data-dsx-variant="bordered"]:not(:disabled):not([aria-disabled="true"]):active {
    --dsx-button-shadow:
      inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft),
      inset 0 1px 2px color-mix(in srgb, var(--dsx-label) 10%, transparent);
    background: var(--dsx-surface-recessed);
  }
  .dsx-button[data-dsx-variant="prominent"]:not(:disabled):not([aria-disabled="true"]):active {
    --dsx-button-shadow:
      inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-accent) 78%, var(--dsx-label)),
      inset 0 2px 3px color-mix(in srgb, var(--dsx-label) 18%, transparent);
    filter: saturate(.96) brightness(.96);
  }
  .dsx-button:focus-visible {
    outline: 2px solid var(--dsx-accent);
    outline-offset: 2px;
    box-shadow: var(--dsx-button-shadow);
  }
  .dsx-button[data-dsx-role="cancel"] { font-weight: 600; }
  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    .dsx-button[data-dsx-variant="bordered"],
    .dsx-button[data-dsx-variant="prominent"] { padding-inline: 0.75rem; }
  }

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
    border-radius: var(--dsx-radius);
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition: box-shadow var(--dsx-motion-standard) var(--dsx-ease-out);
  }
  .dsx-pressable:focus-visible { outline: none; box-shadow: var(--dsx-focus-ring); }
  .dsx-pressable:is([aria-current="page"], [aria-selected="true"], [aria-pressed="true"]) {
    color: var(--dsx-accent);
    background: var(--dsx-fill);
  }
  .dsx-pressable:not(:disabled):not([aria-disabled="true"]):active {
    background: var(--dsx-fill);
  }
  .dsx-pressable:disabled, .dsx-pressable[aria-disabled="true"] {
    cursor: not-allowed;
    opacity: .46;
    transform: none;
  }
  .dsx-tappable { cursor: pointer; }

  .dsx-surface-glass, .dsx-surface-ultraThin {
    background: color-mix(in srgb, var(--dsx-surface-level-1) 76%, transparent);
  }
  .dsx-surface-thin { background: var(--dsx-surface-level-1); }
  .dsx-surface-regular { background: var(--dsx-surface-level-2); }
  .dsx-surface-thick, .dsx-surface-sheet { background: var(--dsx-surface-level-3); }
  .dsx-surface-sheet {
    border-radius: var(--dsx-radius-lg);
    box-shadow: inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft);
  }
  .dsx-scroll {
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
  .dsx-list { display: flex; flex-direction: column; min-width: 0; }
  .dsx-row { display: contents; }
  .dsx-grid { display: grid; gap: var(--dsx-gap); }
  .dsx-pager { flex-direction: row; overflow-x: auto; scroll-snap-type: x mandatory; }
  .dsx-pager > .dsx-row { display: block; flex: 0 0 100%; scroll-snap-align: start; }
${(globalThis as typeof globalThis & { __DSX_OPTIONAL_STATIC_ELEMENTS__?: boolean })
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
    font-size: 0.75rem;
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
    .dsx-button, .dsx-pressable { min-height: 48px; }
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
    --dsx-toggle-track-width: 42px;
    --dsx-toggle-track-height: 24px;
    --dsx-toggle-thumb-size: 20px;
    --dsx-toggle-travel: 18px;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--dsx-control-height-lg);
    height: var(--dsx-control-height-lg);
    flex: none;
  }
  .dsx-toggle input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .dsx-toggle-track {
    box-sizing: border-box;
    width: var(--dsx-toggle-track-width);
    height: var(--dsx-toggle-track-height);
    margin: auto;
    border: var(--dsx-hairline) solid var(--dsx-outline-soft);
    border-radius: 999px;
    background: color-mix(in srgb, var(--dsx-secondary-label) 24%, var(--dsx-surface-recessed));
    box-shadow:
      inset 0 1px 2px color-mix(in srgb, var(--dsx-label) 10%, transparent),
      inset 0 -1px 0 color-mix(in srgb, var(--dsx-control-knob) 36%, transparent);
    transition:
      background var(--dsx-motion-standard) ease,
      border-color var(--dsx-motion-standard) ease,
      box-shadow var(--dsx-motion-standard) var(--dsx-ease-out);
    pointer-events: none;
  }
  .dsx-toggle input:checked + .dsx-toggle-track {
    border-color: color-mix(in srgb, var(--dsx-control-tint) 76%, var(--dsx-label));
    background: linear-gradient(
      165deg,
      color-mix(in srgb, var(--dsx-control-tint) 88%, var(--dsx-control-knob)),
      var(--dsx-control-tint)
    );
  }
  .dsx-toggle input:focus-visible + .dsx-toggle-track {
    box-shadow:
      inset 0 1px 1px color-mix(in srgb, var(--dsx-label) 9%, transparent),
      0 0 0 3px var(--dsx-control-tint);
  }
  .dsx-toggle input:disabled { cursor: not-allowed; }
  .dsx-toggle input:disabled + .dsx-toggle-track {
    opacity: .42;
    filter: saturate(.45);
  }
  .dsx-toggle-thumb {
    display: block;
    box-sizing: border-box;
    width: var(--dsx-toggle-thumb-size);
    height: var(--dsx-toggle-thumb-size);
    margin: 1px;
    border: var(--dsx-hairline) solid color-mix(in srgb, var(--dsx-label) 16%, transparent);
    border-radius: 50%;
    background: linear-gradient(
      165deg,
      var(--dsx-control-knob),
      var(--dsx-control-knob-shadow)
    );
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 .5px 2px color-mix(in srgb, var(--dsx-label) 18%, transparent),
      0 3px 7px color-mix(in srgb, var(--dsx-label) 14%, transparent);
    transition:
      transform var(--dsx-motion-standard) var(--dsx-ease-out),
      box-shadow var(--dsx-motion-standard) var(--dsx-ease-out);
  }
  .dsx-toggle input:checked + .dsx-toggle-track .dsx-toggle-thumb { transform: translateX(var(--dsx-toggle-travel)); }
  [dir="rtl"] .dsx-toggle-track .dsx-toggle-thumb { transform: translateX(var(--dsx-toggle-travel)); }
  [dir="rtl"] .dsx-toggle input:checked + .dsx-toggle-track .dsx-toggle-thumb { transform: translateX(0); }
  .dsx-toggle input:not(:disabled):active + .dsx-toggle-track .dsx-toggle-thumb {
    transform: scale(1.06);
    box-shadow:
      inset 0 1px 2px color-mix(in srgb, var(--dsx-label) 10%, transparent),
      0 1px 3px color-mix(in srgb, var(--dsx-label) 16%, transparent);
  }
  .dsx-toggle input:checked:not(:disabled):active + .dsx-toggle-track .dsx-toggle-thumb {
    transform: translateX(var(--dsx-toggle-travel)) scale(1.06);
  }
  [dir="rtl"] .dsx-toggle input:not(:checked):not(:disabled):active + .dsx-toggle-track .dsx-toggle-thumb {
    transform: translateX(var(--dsx-toggle-travel)) scale(1.06);
  }
  [dir="rtl"] .dsx-toggle input:checked:not(:disabled):active + .dsx-toggle-track .dsx-toggle-thumb {
    transform: scale(1.06);
  }
  @media (hover: hover) and (pointer: fine) {
    .dsx-toggle {
      --dsx-toggle-track-width: 36px;
      --dsx-toggle-track-height: 20px;
      --dsx-toggle-thumb-size: 16px;
      --dsx-toggle-travel: 16px;
      width: var(--dsx-control-height-lg);
      height: var(--dsx-control-height);
    }
    .dsx-toggle input:not(:disabled):hover + .dsx-toggle-track {
      border-color: color-mix(in srgb, var(--dsx-label) 24%, var(--dsx-separator));
    }
  }

  .dsx-slider {
    --dsx-control-tint: var(--dsx-accent);
    --dsx-slider-position: 0%;
    --dsx-slider-direction: to right;
    --dsx-slider-track-size: 4px;
    --dsx-slider-thumb-size: 22px;
    --dsx-slider-track-color: color-mix(in srgb, var(--dsx-secondary-label) 24%, var(--dsx-surface-recessed));
    --dsx-slider-fill-color: var(--dsx-control-tint);
    --dsx-slider-thumb-color: var(--dsx-control-knob);
    --dsx-slider-thumb-shadow-color: var(--dsx-control-knob-shadow);
    appearance: none;
    accent-color: var(--dsx-control-tint);
    display: block;
    width: 100%;
    height: var(--dsx-control-height-lg);
    min-height: 44px;
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
    border-radius: 999px;
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
    border-radius: 999px;
    background: var(--dsx-slider-track-color);
    box-shadow:
      inset 0 1px 1px color-mix(in srgb, var(--dsx-label) 11%, transparent),
      0 1px 0 color-mix(in srgb, var(--dsx-control-knob) 38%, transparent);
  }
  .dsx-slider::-moz-range-progress {
    height: var(--dsx-slider-track-size);
    border-radius: 999px;
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
      box-shadow var(--dsx-motion-standard) var(--dsx-ease-out),
      transform var(--dsx-motion-fast) var(--dsx-ease-out);
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
      box-shadow var(--dsx-motion-standard) var(--dsx-ease-out),
      transform var(--dsx-motion-fast) var(--dsx-ease-out);
  }
  .dsx-slider:focus-visible::-webkit-slider-thumb {
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 .5px 3px color-mix(in srgb, var(--dsx-label) 18%, transparent),
      0 0 0 3px var(--dsx-control-tint);
  }
  .dsx-slider:focus-visible::-moz-range-thumb {
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 .5px 3px color-mix(in srgb, var(--dsx-label) 18%, transparent),
      0 0 0 3px var(--dsx-control-tint);
  }
  .dsx-slider:not(:disabled):active::-webkit-slider-thumb { transform: scale(1.08); }
  .dsx-slider:not(:disabled):active::-moz-range-thumb { transform: scale(1.08); }
  @media (hover: hover) and (pointer: fine) {
    .dsx-slider {
      --dsx-slider-track-size: 3px;
      --dsx-slider-thumb-size: 18px;
      height: var(--dsx-control-height);
      min-height: var(--dsx-control-height);
    }
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
  @media (pointer: coarse) {
    .dsx-toggle {
      --dsx-toggle-track-width: 42px;
      --dsx-toggle-track-height: 24px;
      --dsx-toggle-thumb-size: 20px;
      --dsx-toggle-travel: 18px;
      width: var(--dsx-control-height-lg);
      height: var(--dsx-control-height-lg);
    }
    .dsx-slider {
      --dsx-slider-track-size: 4px;
      --dsx-slider-thumb-size: 22px;
      height: var(--dsx-control-height-lg);
      min-height: 44px;
    }
  }
  .dsx-slider:disabled {
    cursor: not-allowed;
    opacity: .42;
    filter: saturate(.45);
  }

  .dsx-textfield, .dsx-textarea {
    font-family: var(--dsx-font);
    font-size: 1rem;
    font-weight: 500;
    color: var(--dsx-label);
    caret-color: var(--dsx-accent);
    background: var(--dsx-surface-recessed);
    border: 0;
    border-radius: var(--dsx-radius);
    padding: 0 0.875rem;
    min-height: var(--dsx-control-height);
    line-height: 1.35;
    box-shadow:
      inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft),
      inset 0 1px 2px color-mix(in srgb, var(--dsx-label) 7%, transparent);
    transition:
      box-shadow var(--dsx-motion-standard) var(--dsx-ease-out),
      background-color var(--dsx-motion-fast) ease;
  }
  .dsx-textfield::placeholder, .dsx-textarea::placeholder { color: var(--dsx-tertiary-label); opacity: 1; }
  .dsx-textfield:focus-visible, .dsx-textarea:focus-visible {
    outline: none;
    background: var(--dsx-surface-level-1);
    box-shadow:
      inset 0 0 0 2px var(--dsx-accent),
      0 0 0 3px color-mix(in srgb, var(--dsx-accent) 20%, transparent);
  }
  .dsx-textfield[aria-invalid="true"], .dsx-textarea[aria-invalid="true"] {
    box-shadow:
      inset 0 0 0 2px var(--dsx-destructive),
      0 0 0 3px color-mix(in srgb, var(--dsx-destructive) 18%, transparent);
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
  .dsx-searchbar { padding-inline: 1rem; }
  /* <searchbar> composite anatomy: the leading glass + trailing clear ride a
     presentational shell around the SAME real input (/web/17). */
  .dsx-searchbar-field {
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
  .dsx-searchbar-clear:focus-visible { outline: none; box-shadow: var(--dsx-focus-ring); }
  /* maxLines caps the AUTO-GROWN box, so soft-wrapped lines respect it too. */
  .dsx-textarea {
    --dsx-textarea-max-lines: 8;
    min-height: 6rem;
    max-height: calc(var(--dsx-textarea-max-lines) * 1.35em + 1.25rem);
    padding-block: 0.625rem;
    resize: vertical;
    overflow-y: auto;
  }

  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    .dsx-textfield, .dsx-textarea {
      padding-inline: 0.75rem;
      font-size: 0.875rem;
    }
    .dsx-textarea { padding-block: 0.5rem; }
    .dsx-searchbar { padding-inline: 0.875rem; }
  }

  .dsx-progress { height: 6px; border-radius: 999px; color: var(--dsx-accent); background: color-mix(in srgb, currentColor 20%, transparent); overflow: hidden; align-self: stretch; }
  .dsx-progress-fill { height: 100%; background: currentColor; transition: width .2s ease; }

  .dsx-spinner {
    --dsx-spinner-color: var(--dsx-secondary-label);
    --dsx-spinner-scale: 1;
    width: 20px;
    height: 20px;
    flex: none;
    border-radius: 50%;
    border: 2.5px solid var(--dsx-fill);
    border-top-color: var(--dsx-spinner-color);
    animation: dsx-spin .8s linear infinite;
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
    font-size: 1.125rem;
    width: var(--dsx-control-height-sm);
    height: var(--dsx-control-height-sm);
    border-radius: calc(var(--dsx-radius) - 2px);
    cursor: pointer;
  }
  .dsx-stepper-btn:focus-visible { outline: none; box-shadow: var(--dsx-focus-ring); }
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
    .dsx-textfield, .dsx-textarea, .dsx-stepper { border-color: var(--dsx-secondary-label); }
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
    transition:
      left 220ms var(--dsx-ease-out),
      top 220ms var(--dsx-ease-out),
      width 220ms var(--dsx-ease-out),
      height 220ms var(--dsx-ease-out),
      opacity var(--dsx-motion-fast) ease;
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
      color var(--dsx-motion-fast) ease,
      opacity var(--dsx-motion-fast) ease,
      transform var(--dsx-motion-fast) var(--dsx-ease-out);
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
  }
  .dsx-segmented > .dsx-segmented-option[data-selected="true"] {
    color: var(--dsx-label);
    background: transparent;
    box-shadow: none;
  }
  .dsx-segmented > .dsx-segmented-option:focus-visible {
    z-index: 2;
    outline: none;
    box-shadow: inset 0 0 0 3px var(--dsx-accent);
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
  .dsx-star:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 3px var(--dsx-accent);
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
    box-shadow: inset 0 0 0 3px var(--dsx-accent);
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
    box-shadow: 0 1px 4px color-mix(in srgb, var(--dsx-label) 14%, transparent);
    font-size: 1.25rem;
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
    .dsx-segmented > .dsx-segmented-option { transition: none; }
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
