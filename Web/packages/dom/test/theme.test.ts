//
//  theme.test.ts — the system-defaults web skin against the SHARED corpus
//  OpenSource/Conformance/defaults/tokens.json (system-defaults.md). The corpus is
//  the source of truth for the semantic vocabulary; this suite is the web DRIFT GATE:
//  theme.ts must carry every corpus word as floor-safe scheme TWINS (base :root light
//  values → the OS-dark media query → full pin value tables, /web/17's ratified
//  shape — bare light-dark() is BANNED: it needs Safari 17.5 and the stamped floor is
//  last-2 evergreen + Safari 16.4, /web/10 W0), :root must ride `color-scheme: light
//  dark`, the element layer must stay tokens-only, and the variant words must stamp
//  as data attributes (never ARIA).
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TOKENS_CSS, APPLICATION_ELEMENTS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, RICH_ELEMENTS_CSS,
} from "../src/theme.ts";
import { GLOBAL_ELEMENTS_CSS } from "../src/globals.ts";
import { ELEMENTS, BUTTON_ROLES, type ElementApi } from "../src/elements.ts";
import type { MountCtx } from "../src/mount.ts";
import type { XmlNode } from "@despia/compiler/xml";

type WebToken = { css: string; light: string; dark: string };
type TokenRow = { ios: string; watchos: string; android: string; wear: string; web: WebToken };

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((part) => parseInt(part, 16) / 255).map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return (0.2126 * channels[0]!) + (0.7152 * channels[1]!) + (0.0722 * channels[2]!);
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const corpus = JSON.parse(
  readFileSync(new URL("../../../../Conformance/defaults/tokens.json", import.meta.url), "utf8"),
) as { tokens: { [word: string]: TokenRow } };

/** the ratified vocabulary (system-defaults.md §Token vocabulary) — pinned so a
 *  corpus edit without a spec change trips loudly */
const VOCABULARY = [
  "label", "secondary", "tertiary", "background", "groupedBackground",
  "secondaryGroupedBackground", "fill", "separator", "accent", "destructive",
];

test("the corpus carries exactly the ratified vocabulary, every target column filled", () => {
  assert.deepEqual(Object.keys(corpus.tokens).sort(), [...VOCABULARY].sort());
  const cssNames = new Set<string>();
  for (const [word, row] of Object.entries(corpus.tokens)) {
    for (const target of ["ios", "watchos", "android", "wear"] as const) {
      assert.ok(typeof row[target] === "string" && row[target].length > 0, `${word}.${target}`);
    }
    assert.ok(row.web.css.startsWith("--dsx-"), `${word}: web css var is --dsx-*`);
    assert.ok(row.web.light.length > 0 && row.web.dark.length > 0, `${word}: light/dark pair`);
    assert.ok(!cssNames.has(row.web.css), `${word}: duplicate css var ${row.web.css}`);
    cssNames.add(row.web.css);
  }
});

// ── the sheet's four blocks, sliced in ratified order (/web/17): base :root →
//    client/DSD :host → the OS-dark media query → dark pin → light pin ──────────────
const rootStart = TOKENS_CSS.indexOf(":root, :host {");
const mediaStart = TOKENS_CSS.indexOf("@media (prefers-color-scheme: dark)");
const darkPinStart = TOKENS_CSS.indexOf(`[data-dsx-theme="dark"]`);
const lightPinStart = TOKENS_CSS.indexOf(`[data-dsx-theme="light"]`);
const rootBlock = TOKENS_CSS.slice(rootStart, mediaStart < 0 ? undefined : mediaStart);
const mediaBlock = TOKENS_CSS.slice(mediaStart, darkPinStart < 0 ? undefined : darkPinStart);
const darkPin = TOKENS_CSS.slice(darkPinStart, lightPinStart < 0 ? undefined : lightPinStart);
const lightPin = TOKENS_CSS.slice(lightPinStart);

test("drift gate: every corpus token ships as floor-safe scheme twins (base + media + pins)", () => {
  // block order is load-bearing: the pins sit AFTER the media query at equal
  // specificity, so an explicit pin beats the OS scheme in both directions
  assert.ok(rootStart >= 0, "the :root base block exists");
  assert.ok(mediaStart > rootStart, "the prefers-color-scheme dark block follows :root");
  assert.ok(darkPinStart > mediaStart, "the dark pin table follows the media block");
  assert.ok(lightPinStart > darkPinStart, "the light pin table follows the dark pin");
  for (const [word, row] of Object.entries(corpus.tokens)) {
    const light = `${row.web.css}: ${row.web.light};`;
    const dark = `${row.web.css}: ${row.web.dark};`;
    assert.ok(rootBlock.includes(light), `${word}: expected \`${light}\` in the :root base block`);
    assert.ok(mediaBlock.includes(dark), `${word}: expected \`${dark}\` in the OS-dark media block`);
    assert.ok(darkPin.includes(dark), `${word}: expected \`${dark}\` in the [data-dsx-theme="dark"] pin table`);
    assert.ok(lightPin.includes(light), `${word}: expected \`${light}\` in the [data-dsx-theme="light"] pin table`);
  }
  // the stamped browser floor (last-2 evergreen + Safari 16.4, /web/10 W0) predates
  // light-dark() (Safari 17.5): a bare pair is invalid-at-computed-value-time on
  // 16.4–17.4 — the twins above ARE the floor-safe emission of the corpus pairs
  assert.ok(!TOKENS_CSS.includes("light-dark("), "no bare light-dark() below the Safari 16.4 floor");
});

test(":root rides color-scheme: light dark; theme pins carry the scheme + full value tables", () => {
  assert.ok(rootBlock.includes("color-scheme: light dark;"), ":root carries color-scheme: light dark");
  assert.ok(darkPin.includes("color-scheme: dark;"), "the dark pin flips color-scheme");
  assert.ok(lightPin.includes("color-scheme: light;"), "the light pin flips color-scheme");
  // pins stay UNANCHORED (no :root prefix) so a subtree pin re-themes its subtree
  assert.ok(!TOKENS_CSS.includes(":root[data-dsx-theme"), "pins are unanchored for per-subtree use");
  // de-Cupertino (the spec's "never fake-Cupertino"): the SF-flavored rgba tables and
  // the -apple-system font stack stay gone
  assert.ok(!TOKENS_CSS.includes("60, 60, 67"), "SF secondary-label rgba is gone");
  assert.ok(!TOKENS_CSS.includes("120, 120, 128"), "SF fill rgba is gone");
  assert.ok(!TOKENS_CSS.includes("-apple-system"), "the font stack is system-ui");
});

test("the token sheet is self-contained in client and declarative shadow roots", () => {
  assert.ok(rootBlock.includes(":root, :host {"), "light defaults target the document root and shadow host");
  assert.ok(mediaBlock.includes(":root, :host {"), "OS-dark defaults target the shadow host");
  assert.ok(
    darkPin.includes(':host([data-dsx-theme="dark"])'),
    "an explicit dark pin on the custom-element host overrides the OS scheme",
  );
  assert.ok(
    lightPin.includes(':host([data-dsx-theme="light"])'),
    "an explicit light pin on the custom-element host overrides the OS scheme",
  );
  assert.ok(
    TOKENS_CSS.includes(":root, :host, [data-dsx-theme]"),
    "derived aliases recompute at both host and internal subtree theme boundaries",
  );
  const desktop = TOKENS_CSS.slice(TOKENS_CSS.indexOf("@media (min-width: 64rem)"));
  assert.ok(
    desktop.includes(":root, :host, [data-dsx-theme] {"),
    "precision density reaches document roots, shadow hosts, and explicitly themed subtrees",
  );
});

test("adaptive defaults stay touch-safe on mobile and compact for desktop precision", () => {
  assert.ok(rootBlock.includes("--dsx-control-height: 40px;"), "the mobile-first visual control height is 40px");
  for (const size of ["--dsx-control-height-sm: 32px;", "--dsx-control-height-lg: 48px;"]) {
    assert.ok(TOKENS_CSS.includes(size), `the mobile 32/40/48 geometry includes ${size}`);
  }
  assert.ok(
    ELEMENTS_CSS.includes("@media (pointer: coarse)"),
    "coarse primary pointers receive the mobile 48px action target",
  );
  assert.ok(
    TOKENS_CSS.includes("@media (min-width: 64rem) and (hover: hover) and (pointer: fine)"),
    "desktop density requires both room and a precision pointer",
  );
  for (const size of [
    "--dsx-control-height-sm: 28px;",
    "--dsx-control-height: 32px;",
    "--dsx-control-height-lg: 36px;",
  ]) {
    assert.ok(TOKENS_CSS.includes(size), `desktop precision uses the 28/32/36 geometry: ${size}`);
  }
  assert.ok(ELEMENTS_CSS.includes("min-height: var(--dsx-control-height);"), "base controls consume the adaptive token");
  assert.ok(CONTROL_ELEMENTS_CSS.includes("min-height: var(--dsx-control-height);"), "form controls consume the adaptive token");
  assert.ok(RICH_ELEMENTS_CSS.includes("min-height: var(--dsx-control-height);"), "rich controls consume the adaptive token");
  assert.ok(CONTROL_ELEMENTS_CSS.includes('[dir="rtl"] .dsx-toggle'), "binary controls mirror in RTL");
  assert.ok(!/:[^;{}]+!important\s*;/.test(TOKENS_CSS), "authors can replace adaptive defaults normally");
  assert.ok(rootBlock.includes("--dsx-on-accent: #ffffff;"), "light accent content has an explicit contrast token");
  assert.ok(mediaBlock.includes("--dsx-on-accent: #080b14;"), "dark accent content flips for contrast");
  assert.ok(ELEMENTS_CSS.includes("color: var(--dsx-on-accent);"), "prominent controls consume the contrast token");
  assert.match(CONTROL_ELEMENTS_CSS, /\.dsx-stepper-btn\s*\{[^}]*min-width:\s*48px;[^}]*min-height:\s*48px;/s,
    "coarse-pointer stepper actions use the 48px hit target");
  assert.match(RICH_ELEMENTS_CSS, /\.dsx-segmented > \.dsx-segmented-option\s*\{[^}]*min-width:\s*48px;[^}]*min-height:\s*48px;/s,
    "coarse-pointer segmented options use the 48px hit target");
});

test("surface depth, physical hairlines, and safe-area insets form one neutral system", () => {
  for (const token of [
    "--dsx-surface-base", "--dsx-surface-level-1", "--dsx-surface-level-2",
    "--dsx-surface-level-3", "--dsx-surface-cut",
  ]) {
    assert.ok(TOKENS_CSS.includes(`${token}:`), `${token} is available for continuous nested panes`);
  }
  assert.ok(TOKENS_CSS.includes("--dsx-hairline: 1px;"), "one CSS pixel is the density-1 fallback");
  assert.ok(TOKENS_CSS.includes("@media (min-resolution: 2dppx)"), "2x displays receive a physical-pixel hairline");
  assert.ok(TOKENS_CSS.includes("--dsx-hairline: 0.5px;"), "2x hairlines are half a CSS pixel");
  assert.ok(TOKENS_CSS.includes("--dsx-hairline: 0.333333px;"), "3x hairlines are one third of a CSS pixel");
  assert.ok(ELEMENTS_CSS.includes("height: var(--dsx-hairline)"), "dividers consume the physical hairline");
  assert.ok(ELEMENTS_CSS.includes("border-inline-end: var(--dsx-hairline)"), "split panes consume the physical hairline");
  for (const token of [
    "--dsx-safe-block-start", "--dsx-safe-block-end",
    "--dsx-safe-inline-start", "--dsx-safe-inline-end",
  ]) {
    assert.ok(APPLICATION_ELEMENTS_CSS.includes(`${token}:`), `${token} exposes a logical safe-area inset`);
    assert.ok(APPLICATION_ELEMENTS_CSS.includes(`var(${token})`), `${token} is consumed by the app frame`);
  }
  assert.ok(APPLICATION_ELEMENTS_CSS.includes(".dsx-frame:dir(rtl)"), "logical safe-area sides swap under RTL");
});

test("stack-family defaults and fixture chrome colors live in weak overridable CSS", () => {
  assert.ok(ELEMENTS_CSS.includes(".dsx-hstack-defaults, .dsx-vstack { gap: 8px; }"));
  assert.ok(ELEMENTS_CSS.includes(".dsx-hstack { flex-direction: row; align-items: center; }"));
  assert.ok(ELEMENTS_CSS.includes(".dsx-vstack { align-items: start; }"));
  assert.ok(ELEMENTS_CSS.includes(".dsx-zstack { display: grid; align-items: center; justify-items: center; justify-content: center; }"));
  assert.ok(ELEMENTS_CSS.includes("background: var(--dsx-divider-color)"));
  assert.match(
    CONTROL_ELEMENTS_CSS,
    /\.dsx-toggle input:checked \+ \.dsx-toggle-track\s*\{[\s\S]*?var\(--dsx-control-tint\)/,
    "toggle tint reaches the layered checked track",
  );
  assert.ok(CONTROL_ELEMENTS_CSS.includes("accent-color: var(--dsx-control-tint)"), "slider tint reaches native range chrome");
  assert.ok(CONTROL_ELEMENTS_CSS.includes("border-top-color: var(--dsx-spinner-color)"), "spinner tint reaches its arc");
  assert.ok(CONTROL_ELEMENTS_CSS.includes("scale(var(--dsx-spinner-scale))"), "spinner scale survives its rotation animation");
  assert.match(
    GLOBAL_ELEMENTS_CSS,
    /\.dsx-checkbox input:checked \+ \.dsx-checkbox-box\s*\{[\s\S]*?var\(--dsx-checkbox-color\)/,
    "checkbox tint reaches layered checked chrome",
  );
});

test("control foregrounds and small tertiary copy retain normal-text contrast in both schemes", () => {
  for (const [surface, foreground] of [
    ["#315cea", "#ffffff"],
    ["#6d8cff", "#080b14"],
    ["#c92a2a", "#ffffff"],
    ["#ff6b6b", "#180506"],
    ["#ffffff", "#6f7078"],
    ["#f5f5f7", "#6f7078"],
    ["#101012", "#92929c"],
    ["#1c1c1f", "#92929c"],
  ] as const) {
    assert.ok(contrast(surface, foreground) >= 4.5, `${surface} / ${foreground} stays WCAG AA`);
  }
});

test("rating glyphs retain non-text contrast on every default surface", () => {
  const lightRating = rootBlock.match(/--dsx-rating:\s*(#[0-9a-f]{6})/i)?.[1];
  const darkRating = mediaBlock.match(/--dsx-rating:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.ok(lightRating, "light rating token is present");
  assert.ok(darkRating, "dark rating token is present");
  for (const surface of ["#ffffff", "#f5f5f7"] as const) {
    assert.ok(contrast(lightRating, surface) >= 3, `${lightRating} rating clears 3:1 against ${surface}`);
  }
  for (const surface of ["#101012", "#1c1c1f"] as const) {
    assert.ok(contrast(darkRating, surface) >= 3, `${darkRating} rating clears 3:1 against ${surface}`);
  }
  assert.ok(RICH_ELEMENTS_CSS.includes("color: var(--dsx-rating);"), "star controls consume the qualified token");
});

test("focus rings and neutral bordered buttons retain contrast in both schemes", () => {
  for (const block of [rootBlock, darkPin, lightPin]) {
    assert.ok(
      block.includes("--dsx-focus-ring: 0 0 0 3px var(--dsx-accent);"),
      "focus uses the solid adaptive accent rather than a translucent halo",
    );
  }
  assert.doesNotMatch(
    TOKENS_CSS,
    /--dsx-focus-ring:[^;]*(?:transparent|color-mix)/,
    "focus contrast cannot be diluted by transparency",
  );
  for (const [indicator, adjacent] of [
    ["#315cea", "#ffffff"],
    ["#315cea", "#f5f5f7"],
    ["#6d8cff", "#101012"],
    ["#6d8cff", "#1c1c1f"],
  ] as const) {
    assert.ok(contrast(indicator, adjacent) >= 3, `${indicator} focus clears 3:1 against ${adjacent}`);
  }

  const bordered = ELEMENTS_CSS.match(/\.dsx-button\[data-dsx-variant="bordered"\] \{([^}]*)\}/s)?.[1] ?? "";
  assert.match(
    bordered,
    /background:\s*linear-gradient\([\s\S]*?var\(--dsx-surface-highlight\)[\s\S]*?var\(--dsx-surface-level-3\)/,
    "bordered controls keep a layered neutral raised surface",
  );
  assert.match(bordered, /color:\s*var\(--dsx-accent\);/, "bordered controls retain semantic accent text");
  const destructiveBordered = ELEMENTS_CSS.match(
    /\.dsx-button\[data-dsx-variant="bordered"\]\[data-dsx-role="destructive"\] \{([^}]*)\}/s,
  )?.[1] ?? "";
  assert.doesNotMatch(destructiveBordered, /background:/, "destructive bordered controls inherit the readable neutral surface");
  for (const [foreground, surface] of [
    ["#315cea", "#ffffff"],
    ["#6d8cff", "#101012"],
    ["#c92a2a", "#ffffff"],
    ["#ff6b6b", "#101012"],
  ] as const) {
    assert.ok(contrast(foreground, surface) >= 4.5, `${foreground} text clears AA against ${surface}`);
  }
});

test("neutral surface, motion, and interaction scales are complete and overridable", () => {
  for (const token of [
    "--dsx-surface-base", "--dsx-surface-raised", "--dsx-surface-recessed",
    "--dsx-outline-soft", "--dsx-inner-highlight", "--dsx-control-padding-inline",
    "--dsx-control-gap", "--dsx-icon-size", "--dsx-motion-fast",
    "--dsx-motion-standard", "--dsx-ease-out",
  ]) {
    assert.ok(TOKENS_CSS.includes(`${token}:`), `${token} ships in the weak token layer`);
  }
  assert.ok(ELEMENTS_CSS.includes('[data-dsx-variant="bordered"]:not(:disabled):not([aria-disabled="true"]):hover'),
    "bordered buttons have a deliberate hover state");
  assert.ok(ELEMENTS_CSS.includes('[data-dsx-variant="prominent"]:not(:disabled):not([aria-disabled="true"]):hover'),
    "prominent buttons have a deliberate hover state");
  assert.ok(ELEMENTS_CSS.includes('[aria-busy="true"]'), "buttons expose a loading-state contract");
  assert.ok(ELEMENTS_CSS.includes('[aria-pressed="true"]'), "buttons and pressables expose a selected-state contract");
  assert.ok(ELEMENTS_CSS.includes('.dsx-pressable:disabled, .dsx-pressable[aria-disabled="true"]'),
    "pressable buttons and links share the same disabled-state treatment");
  assert.ok(CONTROL_ELEMENTS_CSS.includes('[aria-invalid="true"]'), "fields expose an invalid-state contract");
  assert.ok(CONTROL_ELEMENTS_CSS.includes(":read-only"), "fields distinguish read-only from disabled");
  assert.ok(RICH_ELEMENTS_CSS.includes(".dsx-segmented > .dsx-segmented-option:focus-visible"),
    "segmented options retain independent keyboard focus");
  assert.ok(CONTROL_ELEMENTS_CSS.includes(".dsx-searchbar { padding-inline: 1rem; }"),
    "search fields use the shared restrained radius instead of an automatic pill");
  assert.ok(!CONTROL_ELEMENTS_CSS.includes(".dsx-searchbar { border-radius: 999px"),
    "search fields never reintroduce the generic pill grammar");
  assert.ok(!CONTROL_ELEMENTS_CSS.includes("width: 51px"), "the Web switch does not copy platform-specific geometry");
});

test("reduced-motion and keyboard-focus defaults remain useful without moving or clipping", () => {
  assert.ok(!ELEMENTS_CSS.includes("translateY("), "button press feedback is tonal rather than spatial");
  const buttonContentRules = ELEMENTS_CSS.match(
    /\.dsx-button > span, \.dsx-button > svg \{([\s\S]*?)\n  \}[\s\S]*?\.dsx-button:not\(:disabled\)[\s\S]*?\{([\s\S]*?)\n  \}/,
  )?.slice(1).join("\n") ?? "";
  assert.doesNotMatch(
    buttonContentRules,
    /transform/,
    "button labels and icons must not move independently from their control surface",
  );
  assert.ok(!RICH_ELEMENTS_CSS.includes("translateY("), "segmented press feedback is tonal rather than spatial");
  const reducedControls = CONTROL_ELEMENTS_CSS.match(
    /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n  \}/,
  )?.[1] ?? "";
  assert.match(reducedControls, /\.dsx-spinner\s*\{[\s\S]*?animation:\s*none;/,
    "reduced motion stops the indefinite spinner instead of merely slowing it");
  assert.match(reducedControls, /transform:\s*scale\(var\(--dsx-spinner-scale\)\);/,
    "the stopped loading arc preserves the authored spinner scale");
  assert.doesNotMatch(reducedControls, /animation-duration:/,
    "reduced motion never substitutes a slower perpetual animation");
  assert.match(
    CONTROL_ELEMENTS_CSS,
    /\.dsx-slider:focus-visible::-(?:webkit-slider-thumb|moz-range-thumb)\s*\{[\s\S]*?0 0 0 3px var\(--dsx-control-tint\)/,
    "native range thumbs receive a solid keyboard focus indicator",
  );

  for (const selector of [
    ".dsx-segmented > .dsx-segmented-option:focus-visible",
    ".dsx-star:focus-visible",
    ".dsx-map:focus-visible",
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = RICH_ELEMENTS_CSS.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n  \\}`))?.[1] ?? "";
    assert.match(rule, /box-shadow:\s*inset 0 0 0 3px var\(--dsx-accent\);/,
      `${selector} keeps its ring inside an overflow-clipped surface`);
  }
  assert.ok(RICH_ELEMENTS_CSS.includes(".dsx-map:focus-visible"),
    "the keyboard-operable map viewport never suppresses focus without a replacement");
  const forcedColors = RICH_ELEMENTS_CSS.match(
    /@media \(forced-colors: active\) \{([\s\S]*?)\n  \}/,
  )?.[1] ?? "";
  assert.ok(
    forcedColors.lastIndexOf(".dsx-segmented > .dsx-segmented-option:focus-visible")
      > forcedColors.indexOf('.dsx-segmented > .dsx-segmented-option[data-selected="true"]'),
    "forced-colors focus wins source order when the focused segment is also selected",
  );
  assert.match(forcedColors, /outline:\s*3px double Highlight;/,
    "forced-colors focus remains distinct from the solid selected-state outline");
});

test("all exported theme sheets keep their braces balanced", () => {
  for (const [name, css] of [
    ["application", APPLICATION_ELEMENTS_CSS],
    ["elements", ELEMENTS_CSS],
    ["controls", CONTROL_ELEMENTS_CSS],
    ["rich", RICH_ELEMENTS_CSS],
    ["globals", GLOBAL_ELEMENTS_CSS],
  ] as const) {
    let depth = 0;
    for (const character of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      assert.ok(depth >= 0, `${name} never closes an unopened block`);
    }
    assert.equal(depth, 0, `${name} closes every block`);
  }
});

test("the element layer is tokens-only and carries the variant-word skin", () => {
  const allElementsCss = `${APPLICATION_ELEMENTS_CSS}\n${ELEMENTS_CSS}\n${CONTROL_ELEMENTS_CSS}\n${RICH_ELEMENTS_CSS}\n${GLOBAL_ELEMENTS_CSS}`;
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(allElementsCss), "no raw hex in dsx-elements");
  assert.ok(!/\brgba?\(/.test(allElementsCss), "no raw rgb()/rgba() in dsx-elements");
  assert.ok(APPLICATION_ELEMENTS_CSS.startsWith("@layer dsx-elements {"), "application shell skin stays in the element layer");
  assert.ok(APPLICATION_ELEMENTS_CSS.includes("[data-dsx-root]"), "full apps retain root sizing");
  assert.ok(APPLICATION_ELEMENTS_CSS.includes(".dsx-overlay-plane"), "full apps retain presentation planes");
  assert.ok(!ELEMENTS_CSS.includes("[data-dsx-root]"), "embeds do not carry application-root CSS");
  assert.ok(!ELEMENTS_CSS.includes(".dsx-overlay-plane"), "embeds do not carry router-overlay CSS");
  assert.ok(ELEMENTS_CSS.startsWith("@layer dsx-elements {"), "the skin lives in @layer dsx-elements");
  assert.ok(CONTROL_ELEMENTS_CSS.startsWith("@layer dsx-elements {"), "optional control skin stays in the element layer");
  assert.ok(CONTROL_ELEMENTS_CSS.includes(".dsx-toggle"), "optional control skin is present");
  assert.ok(CONTROL_ELEMENTS_CSS.includes(".dsx-stepper"), "the complete control family stays together");
  assert.ok(CONTROL_ELEMENTS_CSS.includes(".dsx-progress { height: 6px"),
    "progress keeps the canonical six-pixel geometry");
  assert.ok(CONTROL_ELEMENTS_CSS.includes("background: currentColor"),
    "progress tint follows the semantic authored color");
  assert.ok(CONTROL_ELEMENTS_CSS.includes("::placeholder { color: var(--dsx-tertiary-label)"),
    "default placeholder copy uses the readable tertiary token");
  assert.ok(!ELEMENTS_CSS.includes(".dsx-toggle"), "base embeds do not carry unused control CSS");
  assert.ok(!ELEMENTS_CSS.includes(".dsx-stepper"), "base embeds do not carry unused stepper CSS");
  for (const material of ["glass", "ultraThin", "thin", "regular", "thick", "sheet"]) {
    assert.ok(ELEMENTS_CSS.includes(`.dsx-surface-${material}`), `neutral web material exists: ${material}`);
  }
  assert.ok(RICH_ELEMENTS_CSS.startsWith("@layer dsx-elements {"), "optional rich skin stays in the element layer");
  assert.ok(RICH_ELEMENTS_CSS.includes(".dsx-qrcode"), "optional rich skin is present");
  assert.ok(GLOBAL_ELEMENTS_CSS.startsWith("@layer dsx-elements {"), "optional globals stay in the element layer");
  assert.ok(GLOBAL_ELEMENTS_CSS.includes(".dsx-checkbox"), "optional global skin is present");
  for (const sel of [
    '.dsx-button[data-dsx-variant="bordered"]',
    '.dsx-button[data-dsx-variant="prominent"]',
    '.dsx-button[data-dsx-role="destructive"]',
    '.dsx-button[data-dsx-variant="bordered"][data-dsx-role="destructive"]',
    '.dsx-button[data-dsx-variant="prominent"][data-dsx-role="destructive"]',
    '.dsx-button[data-dsx-role="cancel"]',
  ]) {
    assert.ok(ELEMENTS_CSS.includes(sel), `variant rule present: ${sel}`);
  }
  assert.ok(
    ELEMENTS_CSS.lastIndexOf(".dsx-button:focus-visible") >
      ELEMENTS_CSS.indexOf('.dsx-button[data-dsx-variant="prominent"]'),
    "focus-visible wins the prominent elevation shadow by source order",
  );
  const buttonRule = ELEMENTS_CSS.match(/\.dsx-button \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  assert.doesNotMatch(
    buttonRule,
    /transition:[^;]*box-shadow/,
    "button focus rings never interpolate from an elevation shadow",
  );
});

test("rich primitive defaults stay in the weak layer so authored DSX styles can override them", () => {
  const source = readFileSync(new URL("../src/elements.ts", import.meta.url), "utf8");
  // A style attribute written by a factory outranks every cascade layer, including
  // static `style=""`, sidecars and theme.css. Public-root defaults therefore belong
  // in dsx-elements; inline style is reserved for live values/custom properties.
  for (const forbidden of [
    'group.style.cssText =',
    'figure.style.cssText =',
    'wrap.style.cssText =\n    "position:relative;display:block;width:100%;min-height:220px',
    'frame.style.cssText = "display:block;width:100%;min-height:160px',
    'wrap.style.cssText = `display:inline-block;width:${size}px',
  ]) {
    assert.ok(!source.includes(forbidden), `factory-owned presentation escaped the weak layer: ${forbidden}`);
  }
  for (const selector of [
    ".dsx-segmented",
    '.dsx-segmented-option[data-selected="true"]',
    ".dsx-stars",
    ".dsx-chart",
    ".dsx-map",
    ".dsx-webview",
    ".dsx-qrcode",
  ]) {
    assert.ok(RICH_ELEMENTS_CSS.includes(selector), `weak rich default exists: ${selector}`);
  }
  assert.ok(source.includes('control.dataset["selected"] = String(on)'), "state is exposed as a CSS-selectable data attribute");
});

test("universal global defaults are accessible weak-layer tokens, not factory inline paint", () => {
  const source = readFileSync(new URL("../src/globals.ts", import.meta.url), "utf8");
  assert.ok(!source.includes('right ? "accent" : "#2C2C2E"'), "chat has no hard-coded low-contrast bubble");
  for (const declaration of [
    "--dsx-ring-size: 88px;",
    "--dsx-ring-track: var(--dsx-fill);",
    "--dsx-skeleton-height: 14px;",
    "--dsx-chat-max: 280px;",
    "--dsx-chat-foreground: var(--dsx-on-accent);",
  ]) {
    assert.ok(GLOBAL_ELEMENTS_CSS.includes(declaration), `weak global default exists: ${declaration}`);
  }
  assert.ok(GLOBAL_ELEMENTS_CSS.includes("color: var(--dsx-chat-foreground);"),
    "chat text consumes its contrast-aware foreground");
  assert.ok(GLOBAL_ELEMENTS_CSS.includes(".dsx-accordion-chevron"));
  assert.ok(GLOBAL_ELEMENTS_CSS.includes("color: var(--dsx-accent);"));
  assert.ok(GLOBAL_ELEMENTS_CSS.includes('[dir="rtl"] .dsx-accordion-chevron'), "disclosure direction mirrors in RTL");
  assert.ok(GLOBAL_ELEMENTS_CSS.includes("@media (forced-colors: active)"), "global controls survive forced colors");
});

// ── the factory wiring: variant/role stamp as data attributes, never ARIA ───────────
// (a minimal document stand-in — node --test runs this file in its own process)

class FakeNode {
  tagName: string;
  className = "";
  type = "";
  textContent = "";
  private attrs = new Map<string, string>();
  private kids: FakeNode[] = [];
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  appendChild(c: FakeNode): FakeNode { this.kids.push(c); return c; }
  append(...cs: FakeNode[]): void { this.kids.push(...cs); }
  prepend(c: FakeNode): void { this.kids.unshift(c); }
  querySelector(): null { return null; }
  addEventListener(): void {}
}

(globalThis as { document?: unknown }).document = {
  createElement: (t: string) => new FakeNode(t),
  createElementNS: (_ns: string, t: string) => new FakeNode(t),
};

function staticApi(): ElementApi {
  return {
    bindText: (expr, apply) => { if (expr !== undefined) apply(expr); },
    bindValue: () => {},
    writeBack: () => {},
    handler: () => {},
    hasHandler: () => false,
    children: () => {},
  };
}

function makeButton(attrs: { [k: string]: string }): FakeNode {
  const node: XmlNode = { tag: "button", attrs, children: [], text: "" };
  const factory = ELEMENTS["button"]!;
  return factory(node, {} as MountCtx, staticApi()) as unknown as FakeNode;
}

test("buttonEl stamps variant + button-role words as data attributes (never ARIA)", () => {
  const e = makeButton({ label: "Delete", variant: "prominent", role: "destructive" });
  assert.equal(e.getAttribute("data-dsx-variant"), "prominent");
  assert.equal(e.getAttribute("data-dsx-role"), "destructive");
  assert.equal(e.getAttribute("role"), null, "the button role word never lands on the ARIA attribute");
  assert.ok(BUTTON_ROLES.has("destructive") && BUTTON_ROLES.has("cancel"));
});

test("only the two role WORDS stamp — anything else keeps its ARIA meaning", () => {
  const e = makeButton({ role: "group" });
  assert.equal(e.getAttribute("data-dsx-role"), null);
  assert.ok(!BUTTON_ROLES.has("group"));
  const cancel = makeButton({ variant: "bordered", role: "cancel" });
  assert.equal(cancel.getAttribute("data-dsx-variant"), "bordered");
  assert.equal(cancel.getAttribute("data-dsx-role"), "cancel");
});
