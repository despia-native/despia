//
//  chrome-motion.test.ts - the wave-4 fidelity contract for the ACTIONS / CHROME /
//  OVERLAYS plane (design-system.md "the fidelity ruling"). Motion is part of the
//  default, so the per-state intent is pinned against the plane's five sheets:
//  the button press spring + hover lift + THE WIDTH LAW and the segmented sliding
//  thumb (globals.ts - the last-injected override sheet; the base lives in theme.ts,
//  outside this plane's files), the <tabs> app frame (structural-controls.ts), the
//  overlay enter choreography (overlay-controls.ts), the drawer / menu bar
//  chrome (application-controls.ts), and the system navigation bar
//  (route-chrome-style.ts). Springs ride ONLY the easing tokens, so the
//  reduced-motion token collapse (--dsx-dur-* to 0ms, --dsx-ease-spring* to
//  --dsx-ease) silences every rule asserted here by construction.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { GLOBAL_ELEMENTS_CSS } from "../src/globals.ts";
import { TOKENS_CSS, ELEMENTS_CSS, RICH_ELEMENTS_CSS } from "../src/theme.ts";
import { STRUCTURAL_CONTROLS_CSS } from "../src/structural-controls.ts";
import { OVERLAY_CONTROLS_CSS } from "../src/overlay-controls.ts";
import { APPLICATION_CONTROLS_CSS } from "../src/application-controls.ts";
import { DATA_CONTROLS_CSS } from "../src/data-controls.ts";
import { ROUTE_CHROME_CSS } from "../src/route-chrome-style.ts";

const SHEETS: ReadonlyArray<readonly [string, string]> = [
  ["GLOBAL_ELEMENTS_CSS", GLOBAL_ELEMENTS_CSS],
  ["STRUCTURAL_CONTROLS_CSS", STRUCTURAL_CONTROLS_CSS],
  ["OVERLAY_CONTROLS_CSS", OVERLAY_CONTROLS_CSS],
  ["APPLICATION_CONTROLS_CSS", APPLICATION_CONTROLS_CSS],
  ["ROUTE_CHROME_CSS", ROUTE_CHROME_CSS],
];

/** The sheet with every `@media` block removed, so a rule can be pinned as viewport-unconditional. */
function withoutMediaBlocks(css: string): string {
  let out = "";
  for (let index = 0; index < css.length;) {
    const next = css.indexOf("@media", index);
    if (next < 0) { out += css.slice(index); break; }
    out += css.slice(index, next);
    const open = css.indexOf("{", next);
    let depth = 1;
    let cursor = open + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === "{") depth += 1;
      else if (css[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    index = cursor;
  }
  return out;
}

/** All bodies of `@media <marker> ... { ... }` blocks, brace-matched. */
function mediaBlocks(css: string, marker: string): string[] {
  const out: string[] = [];
  for (let from = css.indexOf(marker); from >= 0; from = css.indexOf(marker, from + 1)) {
    const open = css.indexOf("{", from);
    let depth = 1;
    let index = open + 1;
    while (index < css.length && depth > 0) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") depth -= 1;
      index += 1;
    }
    out.push(css.slice(open + 1, index - 1));
  }
  return out;
}

/** The first flat `selector { ... }` body. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing rule: ${selector}`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

test("every spring in this plane rides the easing tokens, never a literal curve", () => {
  for (const [name, css] of SHEETS) {
    assert.ok(!css.includes("cubic-bezier"), `${name} hardcodes a curve`);
    assert.ok(!css.includes("linear(0"), `${name} hardcodes a spring`);
    assert.ok(!css.includes("!important"), `${name} shouts`);
  }
});

// ── buttons (the base sheet lives in theme.ts; the fidelity pass is globals.ts,
//    which boot injects last so equal specificity deterministically wins) ─────────

test("stars press the glyph to 0.88; Chip and segmentedButton press to 0.97 and release on the spring", () => {
  const glyph = rule(RICH_ELEMENTS_CSS, ".dsx-star svg");
  assert.ok(glyph.includes("transform var(--dsx-dur-base) var(--dsx-ease-spring)"));
  assert.ok(rule(RICH_ELEMENTS_CSS, '.dsx-button.dsx-star:not(:disabled):not([aria-disabled="true"]):active svg')
    .includes("transform: scale(0.88)"));
  const richReduce = mediaBlocks(RICH_ELEMENTS_CSS, "@media (prefers-reduced-motion: reduce)").join("\n");
  assert.ok(richReduce.includes(".dsx-star svg"), "star press goes still under reduced motion");

  const chip = rule(GLOBAL_ELEMENTS_CSS, ".dsx-chip");
  assert.ok(chip.includes("transform var(--dsx-dur-slow) var(--dsx-ease-spring)"),
    "Chip is a pressable without a surface material; it still gets the button spring");
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, '.dsx-chip:not(:disabled):not([aria-disabled="true"]):active')
    .includes("transform: scale(0.97)"));
  const reduce = mediaBlocks(GLOBAL_ELEMENTS_CSS, "@media (prefers-reduced-motion: reduce)").join("\n");
  assert.ok(reduce.includes(".dsx-chip"), "Chip goes still under reduced motion");
  const chipSidecar = readFileSync(new URL(
    "../../../../../ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Core/Chip.css",
    import.meta.url,
  ), "utf8");
  assert.doesNotMatch(chipSidecar, /^\.dsx-chip\s*\{[^}]*transition:/m,
    "Chip.css must not override the globals spring; reduced-motion none is the only transition it may set");

  const item = rule(DATA_CONTROLS_CSS, ".dsx-segmented-button-item");
  assert.ok(item.includes("transform var(--dsx-dur-base) var(--dsx-ease-spring)"));
  assert.ok(rule(DATA_CONTROLS_CSS, ".dsx-segmented-button-item:not(:disabled):active")
    .includes("transform: scale(0.97)"));
  const thumb = rule(DATA_CONTROLS_CSS, ".dsx-segmented-button-indicator");
  assert.ok(thumb.includes("transform var(--dsx-dur-slow) var(--dsx-ease-spring)"),
    "exclusive segmentedButton slides a thumb the way segmented does");
  assert.ok(DATA_CONTROLS_CSS.includes('.dsx-segmented-button[data-dsx-multiple="false"] .dsx-segmented-button-item[data-dsx-selected="true"]'),
    "exclusive selected items go transparent so the sliding thumb is the fill");

  assert.ok(rule(GLOBAL_ELEMENTS_CSS, ".dsx-banner").includes("animation: dsx-banner-in"));
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, ".dsx-banner::before").includes("background: var(--dsx-info)"),
    "banners carry a type rail so status is visible without fighting the authored fill");
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, ".dsx-banner-error::before").includes("var(--dsx-destructive)"));
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, ".dsx-callout")
    .includes("inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft)"));
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, ".dsx-card-raised").includes("box-shadow: var(--dsx-shadow-1)"));
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, ".dsx-fab").includes("transform var(--dsx-dur-slow) var(--dsx-ease-spring)"));
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, '.dsx-fab:not(:disabled):not([aria-disabled="true"]):active')
    .includes("transform: scale(0.94)"));
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, ".dsx-progress-ring-arc")
    .includes("stroke-dashoffset var(--dsx-dur-base) var(--dsx-ease)"));
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, ".dsx-avatar-status")
    .includes("box-shadow: 0 0 0 2px var(--dsx-secondary-grouped-background)"),
    "the status dot keeps a surface ring so it reads on a matching avatar fill");
});

test("buttons press to scale(0.97) fast and release on the spring", () => {
  const rest = rule(GLOBAL_ELEMENTS_CSS, ".dsx-button");
  assert.ok(rest.includes("transform var(--dsx-dur-slow) var(--dsx-ease-spring)"),
    "the release travels on the spring");
  assert.ok(rest.includes("background-color var(--dsx-dur-fast) var(--dsx-ease)"),
    "color planes stay on plain ease: overshoot on transform only");
  const press = rule(GLOBAL_ELEMENTS_CSS, '.dsx-button:not(:disabled):not([aria-disabled="true"]):active');
  assert.ok(press.includes("transform: scale(0.97)"));
  assert.ok(press.includes("transform var(--dsx-dur-fast) var(--dsx-ease)"),
    "the press lands fast; only the release springs");
});

test("hover is a brightness lift behind hover:hover, never an opacity fade", () => {
  const hover = mediaBlocks(GLOBAL_ELEMENTS_CSS, "@media (hover: hover) and (pointer: fine)").join("\n");
  assert.ok(hover.includes('.dsx-button[data-dsx-variant="prominent"]'));
  assert.ok(hover.includes("filter: brightness(1.05)"));
  for (const [name, css] of SHEETS) {
    for (const block of css.split("}")) {
      if (!block.includes(":hover")) continue;
      assert.ok(!/opacity:\s*\.\d/.test(block.slice(block.indexOf(":hover")))
        || block.includes("dsx-paged-dot"), `${name} fades a hover: ${block.trim().slice(0, 80)}`);
    }
  }
});

test("the height ramp stays the control tokens: variants large, plain regular even on coarse", () => {
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, ".dsx-button[data-dsx-variant]")
    .includes("--dsx-button-min-height: var(--dsx-control-height-lg)"));
  // W9: the base sheet itself no longer flattens buttons to 48 on coarse — the 40px
  // visual holds everywhere and the 44px floor rides the padded hit area instead.
  const baseCoarse = mediaBlocks(ELEMENTS_CSS, "@media (pointer: coarse)").join("\n");
  assert.ok(!/\.dsx-button[^:{]*\{[^}]*min-height:\s*48px/.test(baseCoarse),
    "coarse pointers keep the 32/40/48 ramp instead of flattening buttons to 48");
  assert.ok(baseCoarse.includes(".dsx-button::after"),
    "the coarse 44px floor is the transparent padded hit area (no layout shift)");
  // W9 landed the floor as --dsx-hit-target-min so the density plane can move it. The
  // intent is unchanged, so assert both halves: the rule reads the token, and the token
  // is still 44px. Pinning the literal here would have forbidden the tokenisation.
  assert.ok(baseCoarse.includes("min(0px, calc((100% - var(--dsx-hit-target-min)) / 2))"),
    "the hit expansion engages only below the hit-target floor");
  assert.ok(TOKENS_CSS.includes("--dsx-hit-target-min: 44px"),
    "and that floor is still 44px");
});

test("THE WIDTH LAW: only the BUTTON is viewport-conditional; a form, an input and a section are not", () => {
  // The law used to put forms, text inputs and nested vertical sections behind the same media
  // query as the button, so one document changed shape at 48rem. MEASURED: form-screen rendered
  // its whole sign-in as a 178px sliver at w1366 and filled its 326px measure at w390. A button's
  // width is genuinely its own (full-width is a phone idiom, a 1366px button is not a button);
  // a form is a block and an input has no intrinsic width worth honouring, on any viewport.
  const compact = mediaBlocks(GLOBAL_ELEMENTS_CSS, "@media (max-width: 47.9375rem)").join("\n");
  const stackContext = ":is(.dsx-stack:not(.dsx-hstack):not(.dsx-zstack):not([data-dsx-grid]), .dsx-scroll:not(.dsx-scroll-x))";
  assert.ok(compact.includes(`${stackContext} > .dsx-button`),
    "the compact law names the vertical stack contexts and covers the button");
  assert.ok(compact.includes("align-self: stretch"));
  for (const child of [".dsx-form", ".dsx-textfield", ".dsx-textarea", ".dsx-select"]) {
    assert.ok(!compact.includes(child), `${child} must NOT be viewport-conditional`);
  }
  // Pin the STRETCH rule itself, not the substring: `.dsx-form` also appears in the field-control
  // rule below, so a bare includes() would keep passing after the selector was deleted.
  const outsideMedia = withoutMediaBlocks(GLOBAL_ELEMENTS_CSS);
  const stretchRule = outsideMedia
    .split("}")
    .find((r) => r.includes("align-self: stretch") && r.includes(".dsx-form")) ?? "";
  for (const child of [".dsx-form", ".dsx-textfield", ".dsx-textarea", ".dsx-select"]) {
    assert.ok(stretchRule.includes(child), `${child} stretches at every width`);
  }
  assert.ok(outsideMedia.includes(".dsx-form .dsx-field-control"),
    "fields fill their form at every width, so inputs and the submit agree");
  assert.ok(!GLOBAL_ELEMENTS_CSS.includes(".dsx-toolbar > .dsx-button"),
    "toolbar buttons keep hugging");
  assert.ok(!GLOBAL_ELEMENTS_CSS.includes(".dsx-flow > .dsx-button"),
    "inline flow buttons keep hugging");
});

test("THE SPACER FILL LAW: a row holding a flexible child fills its column, as both natives do", () => {
  // SwiftUI's HStack with a Spacer() takes its VStack's width and Compose gives a weight(1f) child
  // the parent's max constraint, so a hugging row was the web disagreeing. MEASURED before the
  // rule: landing-hero's brand bar was 306px inside a 688px column and its hairline stopped there.
  const outsideMedia = withoutMediaBlocks(GLOBAL_ELEMENTS_CSS);
  assert.ok(outsideMedia.includes(".dsx-hstack:has(> :is("),
    "the trigger is read off the document with :has(), not an authoring opt-in");
  for (const signal of ['.dsx-spacer', '[data-dsx-grow="width"]', '[data-dsx-grow="true"]']) {
    assert.ok(outsideMedia.includes(signal), `${signal} is a fill signal`);
  }
  assert.ok(!outsideMedia.includes('[style*="flex"]'),
    "a raw inline flex stays the author's own escape hatch, never a selector");
});

test("the fidelity pass never touches focus rings or pressable rows", () => {
  assert.ok(!GLOBAL_ELEMENTS_CSS.includes(".dsx-button:focus"), "focus ring unchanged");
  // the hug law may STRETCH a row (layout), but its press look stays the base
  // background flash: no scale, no transition restyling on pressables here.
  // A pressable carrying a SURFACE MATERIAL is a CARD, not a row (wave 7) - the
  // card behaviors below are the one sanctioned exception.
  const pressableRules = GLOBAL_ELEMENTS_CSS.split("}")
    .filter((rule) => rule.includes(".dsx-pressable") && !rule.includes(".dsx-surface"));
  for (const rule of pressableRules) {
    assert.ok(!rule.includes("scale(") && !rule.includes("transition"),
      "rows keep the base background flash, no scale");
  }
});

// ── wave-7 fidelity: surfaces + actions (component-fidelity) ─────────────────────

const CARD_SET = ":is(.dsx-surface-thin, .dsx-surface-regular, .dsx-surface-thick, .dsx-surface-sheet)";

test("a pressable surface card rests on shadow-1, presses to 0.97 fast and releases on the spring", () => {
  const rest = rule(GLOBAL_ELEMENTS_CSS, `.dsx-pressable${CARD_SET}`);
  assert.ok(rest.includes("box-shadow: var(--dsx-shadow-1)"), "the card rests on the contact-line shadow");
  assert.ok(rest.includes("border-radius: var(--dsx-radius-card)"));
  assert.ok(rest.includes("transform var(--dsx-dur-slow) var(--dsx-ease-spring)"),
    "the release travels on the spring");
  const press = rule(GLOBAL_ELEMENTS_CSS,
    `.dsx-pressable${CARD_SET}:not(:disabled):not([aria-disabled="true"]):active`);
  assert.ok(press.includes("transform: scale(0.97)"));
  assert.ok(press.includes("transform var(--dsx-dur-fast) var(--dsx-ease)"),
    "the press lands fast; only the release springs");
  assert.ok(!GLOBAL_ELEMENTS_CSS.includes(".dsx-pressable.dsx-surface-glass"),
    "glass materials stay chrome, not cards");
});

test("hoverable cards step their material one level behind hover:hover", () => {
  const hover = mediaBlocks(GLOBAL_ELEMENTS_CSS, "@media (hover: hover) and (pointer: fine)").join("\n");
  assert.ok(hover.includes('.dsx-pressable.dsx-surface-thin:not(:disabled):not([aria-disabled="true"]):hover { background: var(--dsx-surface-level-2); }'));
  assert.ok(hover.includes('.dsx-pressable.dsx-surface-regular:not(:disabled):not([aria-disabled="true"]):hover { background: var(--dsx-surface-level-3); }'));
  assert.ok(hover.includes('.dsx-pressable:is(.dsx-surface-thick, .dsx-surface-sheet):not(:disabled):not([aria-disabled="true"]):hover { background: var(--dsx-surface-highlight); }'));
});

test("the actions plane is FLAT: the fidelity sheet paints no ring and no glow (re-ratified 2026-08-27)", () => {
  // the wave-7 raised grammar (2px rings, accent glows) is retired: the fidelity
  // sheet may size the variants but never re-skins them - the element layer owns
  // their flat paint (theme.test.ts pins it)
  assert.ok(!GLOBAL_ELEMENTS_CSS.includes('[data-dsx-variant="bordered"]'),
    "the fidelity sheet declares no bordered rule at all");
  assert.ok(!GLOBAL_ELEMENTS_CSS.includes("inset 0 0 0 2px"),
    "the 2px raised ring is retired from the plane");
  assert.ok(!GLOBAL_ELEMENTS_CSS.includes("var(--dsx-accent) 20%, transparent"),
    "the prominent accent glow is retired");
  assert.ok(!GLOBAL_ELEMENTS_CSS.includes("var(--dsx-destructive) 20%, transparent"),
    "the destructive glow went with it");
});

test("variants keep the LARGE height step and prominent hovers by brightness, not glow", () => {
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, ".dsx-button[data-dsx-variant]")
    .includes("--dsx-button-min-height: var(--dsx-control-height-lg)"));
  const hover = mediaBlocks(GLOBAL_ELEMENTS_CSS, "@media (hover: hover) and (pointer: fine)").join("\n");
  assert.ok(hover.includes('.dsx-button[data-dsx-variant="prominent"]:not(:disabled):not([aria-disabled="true"]):hover'));
  assert.ok(hover.includes("filter: brightness(1.05)"), "the flat prominent hover is a brightness step");
});

test("disabled settles on the 0.5 discipline across the plane", () => {
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, '.dsx-button:disabled, .dsx-button[aria-disabled="true"],\n  .dsx-pressable:disabled, .dsx-pressable[aria-disabled="true"]')
    .includes("opacity: .5"));
  // the surfaces+actions sheets; application-controls (menu bar/drawer chrome) joins
  // the discipline when its plane is next touched
  const DISCIPLINE_SHEETS: ReadonlyArray<readonly [string, string]> = [
    ["GLOBAL_ELEMENTS_CSS", GLOBAL_ELEMENTS_CSS],
    ["STRUCTURAL_CONTROLS_CSS", STRUCTURAL_CONTROLS_CSS],
    ["OVERLAY_CONTROLS_CSS", OVERLAY_CONTROLS_CSS],
    ["DATA_CONTROLS_CSS", DATA_CONTROLS_CSS],
  ];
  for (const [name, css] of DISCIPLINE_SHEETS) {
    for (const block of css.split("}")) {
      if (!/:disabled|data-dsx-disabled="true"/.test(block) || !block.includes("opacity:")) continue;
      // the busy affordance (cursor: progress) is not the unavailable-disabled state
      if (block.includes("cursor: progress")) continue;
      assert.ok(/opacity:\s*\.5\b/.test(block), `${name} disabled opacity is 0.5: ${block.trim().slice(0, 80)}`);
    }
  }
});

test("the standalone toggle press-stretch matches the flagship 6px", () => {
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, ".dsx-toggle.dsx-toggle").includes("--dsx-toggle-stretch: 6px"));
});

test("elevated surfaces trade hard hairline borders for the contact-line shadows", () => {
  // overlays: sheet/dialog/menu/popover panels ride shadow-3, no border declaration
  const panel = rule(OVERLAY_CONTROLS_CSS, ".dsx-overlay-panel, .dsx-floating-panel");
  assert.ok(panel.includes("box-shadow: var(--dsx-shadow-3)"));
  assert.ok(!panel.includes("border:"), "the contact line replaces the panel hairline");
  const submenu = rule(OVERLAY_CONTROLS_CSS, ".dsx-submenu");
  assert.ok(submenu.includes("box-shadow: var(--dsx-shadow-3)") && !submenu.includes("border:"));
  // the tab bar is APP CHROME, not an elevated card (owner ruling 2026-08-19): the
  // hairline + translucency carry its edge at every compact width - never shadow-3.
  const wideCompact = mediaBlocks(STRUCTURAL_CONTROLS_CSS, "@media (min-width: 48rem)").join("\n");
  assert.ok(!wideCompact.includes("box-shadow") && !wideCompact.includes("border-radius"),
    "no floating dock re-emerges at the tablet step");
  // the grouped-list card KEEPS its flat inset hairline: that flatness is the grouped language
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes("inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft)"),
    "the grouped card's inset hairline stays");
});

test("the scrim gains the blurred treatment behind @supports", () => {
  const blurred = mediaBlocks(OVERLAY_CONTROLS_CSS,
    "@supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))").join("\n");
  assert.ok(blurred.includes(".dsx-overlay-scrim"));
  assert.ok(blurred.includes("backdrop-filter: blur(8px) saturate(1.12)"));
  assert.ok(blurred.includes("rgb(0 0 0 / 0.22)"), "the dim drops when the blur carries the separation");
});

test("the selection wash: control radius, 6px inset on both edges, and no dead gutter band", () => {
  const wash = rule(STRUCTURAL_CONTROLS_CSS,
    '.dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="grouped"] > .dsx-row > .dsx-pressable:not(.dsx-settings-row):is([aria-current="page"], [aria-selected="true"], [aria-pressed="true"]),\n  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"][class="dsx-list"]:not([style]) > .dsx-row > .dsx-pressable:not(.dsx-settings-row):is([aria-current="page"], [aria-selected="true"], [aria-pressed="true"])');
  assert.ok(wash.includes("border-radius: var(--dsx-radius-control)"), "the wash takes the control radius");
  assert.ok(wash.includes("width: calc(100% - 2 * var(--dsx-list-wash-inset, 6px))"));
  assert.ok(wash.includes("margin-inline: var(--dsx-list-wash-inset, 6px)"), "both edges breathe symmetrically");
  assert.ok(wash.includes("padding-inline: calc(var(--dsx-list-padding-inline) - var(--dsx-list-wash-inset, 6px))"),
    "the content column does not shift");
  // The grouped CARD never pre-reserves a scrollbar gutter: the base .dsx-list
  // "stable" reservation would end every row 15px short of the card's trailing
  // edge on classic-bar platforms (the trailing-edge nit).
  const card = rule(STRUCTURAL_CONTROLS_CSS,
    '.dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="grouped"],\n  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"][class="dsx-list"]:not([style]),\n  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"]:has(> .dsx-row > .dsx-settings-row)');
  assert.ok(card.includes("scrollbar-gutter: auto") && card.includes("scrollbar-width: thin"),
    "rows reach the card's trailing edge; a truly scrolling card consumes a thin bar");
});

test("the standalone toggle's flagship geometry is density-aware, and the 6px stretch holds", () => {
  // W9: the flagship pill's metrics ride the DENSITY PLANE — globals re-declares the
  // toggle tokens on the plane's own selectors (:root/:host + the media default + the
  // density= pin tables), NEVER on the element, so a density pin can always reach it.
  assert.ok(GLOBAL_ELEMENTS_CSS.includes("--dsx-toggle-track-width: 63px"), "comfortable is the web 63x28 capsule");
  assert.ok(GLOBAL_ELEMENTS_CSS.includes("--dsx-toggle-thumb-width: 36px"), "the default thumb is a 36x24 pill, not a circle");
  assert.ok(GLOBAL_ELEMENTS_CSS.includes(`[data-dsx-density="compact"], :host([data-dsx-density="compact"])`),
    "a compact pin re-derives the pill through the same plane");
  const toggleRule = rule(GLOBAL_ELEMENTS_CSS, ".dsx-toggle.dsx-toggle");
  assert.ok(!toggleRule.includes("--dsx-toggle-track-width")
    && !toggleRule.includes("--dsx-toggle-thumb-size"),
    "no element-level metric re-pin (a density= pin must reach the toggle)");
  assert.ok(toggleRule.includes("--dsx-toggle-stretch: 6px"),
    "the 6px stretch is the flagship's own number at every density");
});

test("the selection wash is an inset pill: control radius + a breathing trailing edge", () => {
  const wash = rule(STRUCTURAL_CONTROLS_CSS,
    '.dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="grouped"] > .dsx-row > .dsx-pressable:not(.dsx-settings-row):is([aria-current="page"], [aria-selected="true"], [aria-pressed="true"]),\n  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"][class="dsx-list"]:not([style]) > .dsx-row > .dsx-pressable:not(.dsx-settings-row):is([aria-current="page"], [aria-selected="true"], [aria-pressed="true"])');
  assert.ok(wash.includes("border-radius: var(--dsx-radius-control)"));
  assert.ok(wash.includes("margin-inline: var(--dsx-list-wash-inset, 6px)"),
    "the wash insets from BOTH inline edges (logical: RTL mirrors free)");
  assert.ok(wash.includes("padding-inline: calc(var(--dsx-list-padding-inline) - var(--dsx-list-wash-inset, 6px))"),
    "the content column does not shift");
});

// ── segmented: the thumb SLIDES, the labels crossfade weight ─────────────────────

test("the segmented thumb slides between segments on the spring; its reveal stays ease", () => {
  // BETWEEN SEGMENTS is the whole of it, so the geometry transition is gated on
  // [data-animate], which elements.ts sets only when the SELECTED INDEX changes.
  // Ungated it also animated the FIRST position, which is measured pre-layout while
  // option one still spans the track: the pill entered 310px wide over three of its four
  // options and shrank into place on every load.
  const moving = rule(GLOBAL_ELEMENTS_CSS, '.dsx-segmented-indicator[data-animate="true"]');
  for (const side of ["left", "top", "width", "height"]) {
    assert.ok(moving.includes(`${side} var(--dsx-dur-slow) var(--dsx-ease-spring)`),
      `${side} travels on the spring`);
  }
  assert.ok(moving.includes("opacity var(--dsx-dur-fast) ease"),
    "opacity never springs");
  // and the plane declares NO unqualified indicator rule: a placement is not a move
  assert.ok(!GLOBAL_ELEMENTS_CSS.includes(".dsx-segmented-indicator {"),
    "an unqualified indicator rule would animate the first, pre-layout placement again");
});

test("segmented labels crossfade weight under the thumb", () => {
  const option = rule(GLOBAL_ELEMENTS_CSS, ".dsx-segmented > .dsx-segmented-option");
  assert.ok(option.includes("font-weight: var(--dsx-type-label-weight)"));
  assert.ok(TOKENS_CSS.includes("--dsx-type-label-weight: 500"), "and the resting rung is medium");
  assert.ok(option.includes("font-weight var(--dsx-dur-base) var(--dsx-ease)"));
  assert.ok(option.includes("transform var(--dsx-dur-slow) var(--dsx-ease-spring)"),
    "segment press keeps the shared release spring");
  // the selected weight came off the type ramp in the design-system burn-down; assert the
  // rung it reads AND the rung's value, so tokenising it stayed honest
  assert.ok(rule(GLOBAL_ELEMENTS_CSS, '.dsx-segmented > .dsx-segmented-option[data-selected="true"]')
    .includes("font-weight: var(--dsx-type-headline-weight)"));
  assert.ok(TOKENS_CSS.includes("--dsx-type-headline-weight: 600"), "and that rung is 600");
});

// ── the <tabs> compact shell is a real app frame ─────────────────────────────────

test("the tab bar is native-grade app chrome: an edge-to-edge translucent hairline bar, never a floating card", () => {
  const bar = rule(STRUCTURAL_CONTROLS_CSS, ".dsx-tablist");
  assert.ok(bar.includes("env(safe-area-inset-bottom)"), "the bar bottom-anchors its content above the safe area");
  assert.ok(bar.includes("backdrop-filter: blur(20px) saturate(1.1)"), "the translucent material recipe");
  assert.ok(bar.includes("background: color-mix(in srgb, var(--dsx-background) 90%, transparent)"));
  assert.ok(bar.includes("border-top: var(--dsx-hairline) solid var(--dsx-separator)"));
  assert.ok(rule(STRUCTURAL_CONTROLS_CSS, ".dsx-tab").includes("min-height: 3.25rem"),
    "the 3.25rem content band");
  // owner ruling 2026-08-19: the >=48rem floating shadow-card dock is RETIRED - the
  // same edge-to-edge bar holds at every width below the sidebar step.
  assert.ok(!STRUCTURAL_CONTROLS_CSS.includes("width: min(calc(100% - 32px), 44rem)"),
    "no width-capped floating dock remains");
  assert.ok(!/\.dsx-tablist[^{]*\{[^}]*box-shadow:\s*var\(--dsx-shadow/.test(STRUCTURAL_CONTROLS_CSS),
    "the tab bar never carries an elevation shadow");
  const fallback = mediaBlocks(STRUCTURAL_CONTROLS_CSS,
    "@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))").join("\n");
  assert.ok(fallback.includes(".dsx-tablist { background: var(--dsx-background); }"),
    "no blur support = an honest opaque bar");
});

test("selection is tint alone: no persistent transforms, the press stays the only transform", () => {
  assert.ok(!STRUCTURAL_CONTROLS_CSS.includes('.dsx-tab[data-dsx-selected="true"] .dsx-tab-icon'),
    "the active icon carries no transform or decoration of its own");
  assert.ok(!STRUCTURAL_CONTROLS_CSS.includes('.dsx-tab[data-dsx-selected="true"] .dsx-tab-label'),
    "the active label changes color only, never weight");
  assert.ok(rule(STRUCTURAL_CONTROLS_CSS, ".dsx-tab-label").includes("font-weight: var(--dsx-type-label-weight)"));
  assert.ok(TOKENS_CSS.includes("--dsx-type-label-weight: 500"), "and the label rung is medium");
  const tab = rule(STRUCTURAL_CONTROLS_CSS, ".dsx-tab");
  assert.ok(tab.includes("transform var(--dsx-dur-slow) var(--dsx-ease-spring)"),
    "the press release springs back");
  const press = rule(STRUCTURAL_CONTROLS_CSS, ".dsx-tab:active");
  assert.ok(press.includes("transform: scale(.98)"));
  assert.ok(press.includes("transform var(--dsx-dur-fast) var(--dsx-ease)"));
});

test("selection ink: inactive tabs rest on tertiary ink, the active tab takes the accent", () => {
  assert.ok(rule(STRUCTURAL_CONTROLS_CSS, ".dsx-tab").includes("color: var(--dsx-tertiary-label)"));
  assert.ok(rule(STRUCTURAL_CONTROLS_CSS, '.dsx-tab[data-dsx-selected="true"]')
    .includes("color: var(--dsx-accent)"));
});

test("nothing is drawn behind a tab item: the indicator pill is retired grammar", () => {
  assert.ok(!STRUCTURAL_CONTROLS_CSS.includes(".dsx-tab-icon::before"),
    "the platform tab bar signals selection with tint, never an indicator behind the item");
  assert.ok(!/\.dsx-tab[^{]*\{[^}]*var\(--dsx-accent-muted\)/.test(STRUCTURAL_CONTROLS_CSS.split("THE DESKTOP STEP")[0]),
    "no accent-muted wash anywhere in the compact bar");
});

test("a pane switch fades and rises subtly on the soft spring, and collapses under reduced motion", () => {
  assert.ok(rule(STRUCTURAL_CONTROLS_CSS, ".dsx-tab-panel:not([hidden])")
    .includes("animation: dsx-tab-pane-in var(--dsx-dur-base) var(--dsx-ease-spring-soft)"));
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes(
    "@keyframes dsx-tab-pane-in { from { opacity: 0; transform: translateY(6px); } }"));
  const reduced = mediaBlocks(STRUCTURAL_CONTROLS_CSS, "@media (prefers-reduced-motion: reduce)").join("\n");
  assert.ok(reduced.includes(".dsx-tab-panel:not([hidden]) { animation: none; }"));
  assert.ok(reduced.includes(".dsx-tab-icon"));
  assert.ok(reduced.includes(".dsx-tab-label"));
});

test("grouped rows keep the inset-separator language", () => {
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes("--dsx-list-separator-inset"));
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes('[dir="rtl"] .dsx-list[data-dsx-axis="vertical"]'),
    "separator insets stay RTL-mirrored");
});

// ── overlays: enter choreography per surface ─────────────────────────────────────

test("the sheet enters translate-up on the soft spring", () => {
  assert.ok(rule(OVERLAY_CONTROLS_CSS, ".dsx-sheet-panel")
    .includes("animation: dsx-sheet-up var(--dsx-dur-slow) var(--dsx-ease-spring-soft) both"));
  assert.ok(OVERLAY_CONTROLS_CSS.includes("@keyframes dsx-sheet-up { from { translate: 0 100%; } }"));
});

test("dialogs zoom 0.96 to 1 on the spring while the fade stays linear", () => {
  for (const panel of [".dsx-alert-panel", ".dsx-confirm-panel"]) {
    const body = rule(OVERLAY_CONTROLS_CSS, panel);
    assert.ok(body.includes("dsx-dialog-zoom var(--dsx-dur-base) var(--dsx-ease-spring) both"), panel);
    assert.ok(body.includes("dsx-overlay-fade var(--dsx-dur-base) linear both"), panel);
  }
  assert.ok(OVERLAY_CONTROLS_CSS.includes("@keyframes dsx-dialog-zoom { from { scale: 0.96; } }"));
  assert.ok(OVERLAY_CONTROLS_CSS.includes("@keyframes dsx-overlay-fade { from { opacity: 0; } }"));
});

test("the scrim fades linear", () => {
  assert.ok(rule(OVERLAY_CONTROLS_CSS, ".dsx-overlay-scrim")
    .includes("animation: dsx-overlay-fade var(--dsx-dur-base) linear both"));
});

test("menus and popovers zoom 0.95 from their anchor edge; the tooltip rides the same tokens", () => {
  // The first `.dsx-floating-panel` rule is the shared surface (with .dsx-overlay-panel);
  // the enter choreography lives on the standalone rule after the floating layer.
  const float = rule(OVERLAY_CONTROLS_CSS.slice(
    OVERLAY_CONTROLS_CSS.indexOf(".dsx-floating-layer { inset: 0")), ".dsx-floating-panel");
  assert.ok(float.includes("dsx-float-zoom var(--dsx-dur-base) var(--dsx-ease-spring) both"));
  assert.ok(float.includes("dsx-overlay-fade var(--dsx-dur-fast) linear both"));
  assert.ok(OVERLAY_CONTROLS_CSS.includes("@keyframes dsx-float-zoom { from { scale: 0.95; } }"));
  const origins: ReadonlyArray<readonly [string, string]> = [
    ["bottom", "50% 0"], ["top", "50% 100%"], ["right", "0 50%"], ["left", "100% 50%"],
  ];
  for (const [placement, origin] of origins) {
    assert.ok(rule(OVERLAY_CONTROLS_CSS, `.dsx-floating-panel[data-dsx-placement="${placement}"]`)
      .includes(`transform-origin: ${origin}`), `zooms from the ${placement} anchor edge`);
  }
  const tooltip = rule(OVERLAY_CONTROLS_CSS, ".dsx-tooltip");
  assert.ok(tooltip.includes("dsx-float-zoom var(--dsx-dur-base) var(--dsx-ease-spring) both"));
  assert.ok(tooltip.includes("dsx-overlay-fade var(--dsx-dur-fast) linear both"));
});

test("overlay motion collapses under reduced motion", () => {
  const reduced = mediaBlocks(OVERLAY_CONTROLS_CSS, "@media (prefers-reduced-motion: reduce)").join("\n");
  for (const cls of [".dsx-overlay-scrim", ".dsx-alert-panel", ".dsx-confirm-panel", ".dsx-sheet-panel", ".dsx-floating-panel", ".dsx-tooltip"]) {
    assert.ok(reduced.includes(cls), `${cls} keeps its animation: none collapse`);
  }
});

// ── app chrome: drawer + menu bar ────────────────────────────────────────────────

test("the drawer rises on the soft spring with a linear fade, and springs back after a drag", () => {
  const panel = rule(APPLICATION_CONTROLS_CSS, ".dsx-drawer-panel");
  assert.ok(panel.includes("dsx-drawer-rise var(--dsx-dur-slow) var(--dsx-ease-spring-soft) both"));
  assert.ok(panel.includes("dsx-drawer-fade var(--dsx-dur-base) linear both"));
  assert.ok(panel.includes("transition: transform var(--dsx-dur-base) var(--dsx-ease-spring-soft)"),
    "drag release settles on the soft spring");
  assert.ok(APPLICATION_CONTROLS_CSS.includes("@keyframes dsx-drawer-rise { from { translate: 0 16px; } }"));
  assert.ok(rule(APPLICATION_CONTROLS_CSS, ".dsx-drawer-scrim")
    .includes("animation: dsx-drawer-fade var(--dsx-dur-base) linear both"));
});

// ── app chrome: the system navigation bar (owner ruling 2026-08-19) ──────────────

test("the nav bar is native-grade: a 3rem translucent band over the safe area with a centered 600-weight title", () => {
  const bar = rule(ROUTE_CHROME_CSS, ":where(.dsx-route-chrome)");
  assert.ok(bar.includes("var(--dsx-route-height, 48px)"), "the 3rem band");
  assert.ok(bar.includes("env(safe-area-inset-top)"));
  assert.ok(bar.includes("color-mix(in srgb, var(--dsx-background, #fff) 90%, transparent)"),
    "the same translucent recipe as the tab bar");
  assert.ok(bar.includes("blur(var(--dsx-route-blur, 20px)) saturate(var(--dsx-route-saturation, 1.1))"));
  assert.ok(bar.includes("border-block-end: var(--dsx-hairline, 1px) solid"));
  const title = rule(ROUTE_CHROME_CSS, ":where(.dsx-route-title)");
  // both knobs survive; their DEFAULTS now come off the type ramp rather than a literal,
  // so an author override still works and the unset case follows the system
  assert.ok(title.includes("font-size: var(--dsx-route-title-size, var(--dsx-type-title3-size))"));
  assert.ok(title.includes("font-weight: var(--dsx-route-title-weight, var(--dsx-type-headline-weight))"));
  assert.ok(TOKENS_CSS.includes("--dsx-type-title3-size: 1.0625rem"), "the title rung is unchanged");
  assert.ok(title.includes("justify-self: center"));
  const fallback = mediaBlocks(ROUTE_CHROME_CSS,
    "@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))").join("\n");
  assert.ok(fallback.includes("--dsx-route-surface-opaque"), "no blur support = an honest opaque bar");
});

test("scroll-edge: the nav bar reads seamless at the top and gains hairline + material once content scrolls under", () => {
  const edge = rule(ROUTE_CHROME_CSS, ':where(.dsx-route-chrome[data-dsx-edge="top"])');
  assert.ok(edge.includes("background: transparent"));
  assert.ok(edge.includes("border-block-end-color: transparent"));
  assert.ok(edge.includes("backdrop-filter: none"));
  const bar = rule(ROUTE_CHROME_CSS, ":where(.dsx-route-chrome)");
  assert.ok(bar.includes("background-color var(--dsx-dur-base, 200ms) var(--dsx-ease, ease)"),
    "the material fades in on the ease tokens (with standalone fallbacks)");
  const reduced = mediaBlocks(ROUTE_CHROME_CSS, "@media (prefers-reduced-motion: reduce)").join("\n");
  assert.ok(reduced.includes("transition: none"), "reduced motion collapses the edge fade");
});

test("the back affordance is a chevron with a previous-title label that yields when space runs out", () => {
  const label = rule(ROUTE_CHROME_CSS, ":where(.dsx-route-back-label)");
  assert.ok(label.includes("text-overflow: ellipsis"), "the label truncates before crowding the title");
  const narrow = mediaBlocks(ROUTE_CHROME_CSS, "@media (max-width: 23.9375rem)").join("\n");
  assert.ok(narrow.includes(".dsx-route-back-label) { display: none; }"),
    "below ~384px only the chevron remains");
  assert.ok(ROUTE_CHROME_CSS.includes('[dir="rtl"] .dsx-route-back-icon) { transform: scaleX(-1); }'),
    "the chevron mirrors under RTL");
});

test("the menu bar keeps its safe-area frame; the pill and active icon travel on the spring", () => {
  assert.ok(rule(APPLICATION_CONTROLS_CSS, ".dsx-menu-bar").includes("env(safe-area-inset-bottom)"));
  assert.ok(rule(APPLICATION_CONTROLS_CSS, ".dsx-menu-bar-pill")
    .includes("transform var(--dsx-dur-base) var(--dsx-ease-spring)"));
  assert.ok(rule(APPLICATION_CONTROLS_CSS, ".dsx-menu-bar-icon")
    .includes("transition: transform var(--dsx-dur-slow) var(--dsx-ease-spring)"));
  assert.ok(rule(APPLICATION_CONTROLS_CSS, '.dsx-menu-bar-item[data-dsx-selected="true"] .dsx-menu-bar-icon')
    .includes("transform: scale(1.06)"));
  const reduced = mediaBlocks(APPLICATION_CONTROLS_CSS, "@media (prefers-reduced-motion: reduce)").join("\n");
  assert.ok(reduced.includes(".dsx-menu-bar-icon"));
});
