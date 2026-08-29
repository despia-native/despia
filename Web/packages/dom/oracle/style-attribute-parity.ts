//
//  style-attribute-parity.ts — does each STYLE ATTRIBUTE reach the pixels on the web renderer?
//
//  WHY THIS IS EMPIRICAL AND NOT A GREP. `stack-style-properties.json` lists 83 style keys and
//  records NO per-renderer support anywhere. The element ledger has that column; the style
//  catalogue does not, and the cost of the missing column is measured: `fontSize`, `fontWeight`,
//  `italic` and `letterSpacing` were WHOLLY inert on this renderer - not mapped, not forwarded,
//  not even present in the DOM - while working on both native renderers, and nothing in the
//  repository could say so. They were found by accident, twice, while building something else.
//
//  A grep would have missed them the same way a reader did: the names appear in the catalogue,
//  in the reference and in three renderers, so every text search says "handled". So this asks
//  the BROWSER instead. Each key is mounted twice - once bare, once carrying the attribute - and
//  the two elements' full computed styles are diffed. An attribute that changes nothing changed
//  nothing, whatever the source says.
//
//  WHAT A PASS MEANS, precisely: the attribute reaches the pixels. It does NOT mean the value is
//  correct, and this file deliberately does not assert values - a table of 83 hand-written
//  expected values is a table of 83 guesses. Correctness per attribute belongs to the element
//  fixtures and the component probes; REACHING THE PIXELS is the thing no other gate asks.
//
//  Run: node packages/dom/oracle/style-attribute-parity.ts [--json]
//
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchBrowser } from "./browser-engine.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const CATALOG = join(ROOT, "OpenSource/Documentation/reference/stack-style-properties.json");

type Property = {
  key: string;
  control: string;
  default?: unknown;
  options?: Array<{ value: string; default?: boolean }>;
  keywords?: Array<{ value: string }>;
};
type Group = { id: string; properties: Property[] };

const catalog = JSON.parse(readFileSync(CATALOG, "utf8")) as { groups: Group[] };

/** The a11y and animation groups already have a per-attribute web ledger of their own
 *  (support/element-support.json universalAttributes), and it is enforced by
 *  packages/dom/test/attribute-support.test.ts. Auditing them here would be a second opinion
 *  about the same fact, and two ledgers that can disagree are worse than one. */
const LEDGERED_GROUPS = new Set(["accessibility", "animation"]);

/** A value that must visibly differ from the unstyled baseline. Derived from the catalogue's own
 *  control type rather than hand-written, so a new style key is probed the day it is catalogued
 *  and cannot be quietly skipped. A key whose honest test value is not derivable is listed here
 *  WITH its reason; anything else is a bug in this table, not a licence. */
const EXPLICIT: Record<string, string> = {
  // Structural words whose effect is on CHILDREN or the element's own box in ways a solo
  // element cannot show. Each is probed by the element fixtures instead.
  grow: "true",
  align: "center",
  alignItems: "center",
  alignY: "center",
  flexDirection: "row",
  spacing: "13",
  // Values the derivation would get wrong.
  width: "77",
  height: "37",
  fontFamily: "Georgia",
  fontVariation: "wght 700",
  fontFeature: "ss01",
  gradient: "#112233|#445566",
  gradientPoints: "0 0 #112233, 1 0 #445566; 0 1 #112233, 1 1 #445566",
  gradientCenter: "0.25 0.75",
  // NOT "0,1": for two colours that IS the default even spacing, so it would diff clean
  // against the bare twin and read as inert.
  gradientStops: "0,0.25",
  // A generic 23 is out of range for these and the browser clamps it back to the baseline,
  // which reads as inert when the attribute is fine.
  opacity: "0.5",
  aspectRatio: "2",
  gradientRadius: "0.8",
  theme: "dark",
  variant: "bordered",
  density: "compact",
  ignoreSafeArea: "top",
  lineLimit: "1",
  textCase: "upper",
  tracking: "3",
  lineSpacing: "7",
  shadow: "9",
  blur: "4",
  rotation: "15",
  scale: "1.5",
  zIndex: "7",
  offsetX: "11",
  offsetY: "13",
  dynamicType: "true",
  dynamicTypeMax: "22",
};

function testValue(p: Property): string {
  const explicit = EXPLICIT[p.key];
  if (explicit !== undefined) return explicit;
  if (p.options !== undefined && p.options.length > 0) {
    const notDefault = p.options.find((o) => o.default !== true && o.value !== p.default);
    return (notDefault ?? p.options[0]!).value;
  }
  switch (p.control) {
    case "color": return "#123456";
    case "boolean": return "true";
    case "number": case "length": case "ratio": return "23";
    default: return "23";
  }
}

/** `dynamicType` needs a `fontSize` to scale, and the gradient modifiers need a `gradient` to
 *  modify. A modifier probed alone is inert by definition and would be recorded as broken. */
const COMPANIONS: Record<string, string> = {
  dynamicType: ` fontSize="17"`,
  dynamicTypeMax: ` fontSize="17" dynamicType="true"`,
  gradientDir: ` gradient="#112233|#445566"`,
  gradientType: ` gradient="#112233|#445566"`,
  gradientStops: ` gradient="#112233|#445566"`,
  gradientAngle: ` gradient="#112233|#445566"`,
  gradientCenter: ` gradient="#112233|#445566" gradientType="radial"`,
  gradientRadius: ` gradient="#112233|#445566" gradientType="radial"`,
  gradientPoints: ` gradient="#112233|#445566" gradientType="mesh"`,
  glassTint: ` surface="glass"`,
  glassInteractive: ` surface="glass"`,
  shadowColor: ` shadow="9"`,
  shadowX: ` shadow="9"`,
  shadowY: ` shadow="9"`,
  maxWidth: ` width="500"`,
  maxHeight: ` height="500"`,
  minWidth: ` width="1"`,
  minHeight: ` height="1"`,
  borderColor: ` borderWidth="3"`,
};

/** The root font size a key must be measured at, where the default one hides the effect. Only
 *  Dynamic Type needs this so far, and it needs it for a reason worth keeping: its polyfill is
 *  deliberately a no-op at a 16px root. */
const ROOT_FONT_SIZE: Record<string, number> = { dynamicType: 24, dynamicTypeMax: 24 };
const DEFAULT_ROOT = 16;

/** Keys whose whole subject is an INTERACTION STATE, measured under a held pointer. A resting
 *  probe cannot see one by construction, and this harness said so in writing before it could:
 *  `glassInteractive` was pinned inert with the note that the press-stretch "is an interaction
 *  state this resting probe could not see even once it exists". A gate that cannot see the thing
 *  it gates is the same false green as a marker scan crediting a degradation table.
 *
 *  A REAL PRESS, not a forced pseudo-class: the mouse goes down on the element and stays down
 *  while the computed style is read, so what is measured is what a finger gets rather than what
 *  CDP can be talked into asserting. */
const PRESSED = new Set(["glassInteractive"]);

/** Long enough for --dsx-dur-fast (120ms) to finish, so the press is read settled rather than
 *  mid-transition. A mid-transition read would still differ from the baseline and pass, which is
 *  exactly the kind of accidental green this file exists to remove. */
const PRESS_SETTLE_MS = 220;

const probes = catalog.groups
  .filter((g) => !LEDGERED_GROUPS.has(g.id))
  .flatMap((g) => g.properties.map((p) => ({ group: g.id, key: p.key, value: testValue(p) })));

const source = String.raw`
  import { compileComponent } from "./packages/compiler/src/component.ts";
  import { CssCollector, extractComponentCss } from "./packages/compiler/src/css.ts";
  import { LAYER_STATEMENT } from "./packages/compiler/src/cssmap.ts";
  import { instantiate } from "./packages/dom/src/mount.ts";
  import { registerGlobalElements, registerRichElements } from "./packages/dom/src/elements.ts";
  import { UNIVERSAL_GLOBAL_ELEMENTS, GLOBAL_ELEMENTS_CSS } from "./packages/dom/src/globals.ts";
  import { TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, RICH_ELEMENTS_CSS } from "./packages/dom/src/theme.ts";
  import { STRUCTURAL_CONTROLS_CSS } from "./packages/dom/src/structural-controls.ts";

  registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);
  registerRichElements();

  window.__DSX_STYLE_PROBE__ = (markup) => {
    const ir = compileComponent("Probe", "test", markup);
    const collector = new CssCollector();
    extractComponentCss(ir, collector);
    const registry = { components: { "test.Probe": ir }, globalPool: {}, css: collector.emit(), schemes: [] };
    document.getElementById("probe-style").textContent = [
      LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS,
      RICH_ELEMENTS_CSS, STRUCTURAL_CONTROLS_CSS, GLOBAL_ELEMENTS_CSS, registry.css,
      "@layer dsx-components { * { box-sizing:border-box } body { margin:0 } .probe-root { width:360px } }",
    ].join("\n");
    document.body.replaceChildren(instantiate(ir, registry).root);
    return true;
  };

  // The FULL computed style, plus the box, plus what the element actually carries. A style
  // attribute can land as a declaration, as a class, as a data-attribute the sheet keys on, or
  // as a changed layout - all four count as reaching the pixels, and only the union catches
  // every one of them.
  // Properties Chromium computes but does not enumerate. Measured, not guessed: each one was
  // observed to return a value from getPropertyValue while being absent from the indexed list.
  const UNENUMERATED = ["font-variation-settings", "font-feature-settings"];

  window.__DSX_STYLE_READ__ = (selector) => {
    const el = document.querySelector(selector);
    if (el === null) return null;
    const computed = getComputedStyle(el);
    const style = {};
    for (let i = 0; i < computed.length; i++) {
      const name = computed.item(i);
      style[name] = computed.getPropertyValue(name);
    }
    // Chromium's computed-style ENUMERATION is not the set of properties it computes: it omits
    // several that getPropertyValue answers perfectly well, and two of them are the only thing
    // fontVariation and fontFeature emit - so both reported inert against a renderer that was
    // setting them correctly. Read by name rather than by index; a name that is not set reads
    // back identical on both twins and costs nothing.
    for (const name of UNENUMERATED) style[name] = computed.getPropertyValue(name);
    const rect = el.getBoundingClientRect();
    // STRUCTURAL differences are not style effects, and counting them is how this harness
    // reported 67 of 67 attributes working while four of them were provably inert. The node
    // INDEX always differs (the two probes are siblings), the compiled class handle differs by
    // construction, and the class list carries the probe own bare/styled discriminator.
    // Comparing any of them makes every probe pass for free.
    const attrs = {};
    for (const name of el.getAttributeNames()) attrs[name] = el.getAttribute(name);
    // data-dsx is CONTENT-ADDRESSED: two elements with the same declarations carry the same
    // handle, so a difference there says a declaration was EMITTED. That is weaker than it looks
    // and is scored separately below - a declaration nothing reads is what the glassTint and
    // glassInteractive pair had, and counting it made both report green against a renderer that
    // consumed neither.
    delete attrs["data-dsx-n"];
    delete attrs["data-dsx-owner"];
    delete attrs["class"];
    // The discriminator itself is stripped from the class list before it is compared.
    const cls = el.className.split(" ").filter((c) => c !== "bare" && c !== "styled").sort().join(" ");
    return { style, attrs, box: rect.width + "x" + rect.height, cls };
  };

  // The ROOT FONT SIZE, because one polyfill is only visible away from the default. Dynamic Type
  // folds to calc(size / 16 * 1rem), which at a 16px root computes to exactly the px twin - that
  // identity IS the safety argument for it, and it also means a same-root probe can never see the
  // attribute work. Measured at a larger root the scaled size diverges, which is the whole point
  // of the attribute.
  window.__DSX_STYLE_ROOT__ = (px) => { document.documentElement.style.fontSize = px + "px"; };

  const style = document.createElement("style");
  style.id = "probe-style";
  document.head.appendChild(style);
  window.__DSX_STYLE_READY__ = true;
`;

const bundle = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "style-parity-entry.ts" },
  bundle: true, write: false, format: "iife", target: "es2022", logLevel: "silent",
}).outputFiles[0]?.text;
if (bundle === undefined) throw new Error("the style-parity harness did not bundle");

declare global {
  // eslint-disable-next-line no-var
  var __DSX_STYLE_PROBE__: (markup: string) => boolean;
  // eslint-disable-next-line no-var
  var __DSX_STYLE_ROOT__: (px: number) => void;
  // eslint-disable-next-line no-var
  var __DSX_STYLE_READ__: (selector: string) => {
    style: Record<string, string>; attrs: Record<string, string>; box: string; cls: string;
  } | null;
}

const browser = await launchBrowser();
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
await page.setContent("<!doctype html><html><head></head><body></body></html>");
await page.addScriptTag({ content: bundle });
await page.waitForFunction(() => (window as unknown as { __DSX_STYLE_READY__?: boolean }).__DSX_STYLE_READY__ === true);

type Verdict = { group: string; key: string; reaches: boolean; evidence: string };
const verdicts: Verdict[] = [];

/** TWO SHAPES, and the attribute counts as reaching the pixels if EITHER moves. A style
 *  attribute is not one kind of thing: `flexDirection` and `spacing` need children to arrange,
 *  `lineLimit` and `textCase` need a text element to apply to, and probing only one shape
 *  reports the other kind as inert. The first version of this file probed a childless `<text>`
 *  and called sixteen working attributes broken. */
const SHAPES = [
  { name: "container", open: '<vstack class="', body: '"ATTRS><text value="A"/><text value="B"/>', close: "</vstack>" },
  { name: "text", open: '<text class="', body: '"ATTRS value="Sample"/>', close: "" },
  // A BUTTON, because several catalogue words are system-control words: `variant` selects the
  // system button rendering and means nothing on a text, and the glass pair defaults on for
  // tappable elements. Probing them on a text would accuse a working attribute.
  { name: "button", open: '<button class="', body: '"ATTRS label="Tap"/>', close: "" },
];

function shapeMarkup(shape: (typeof SHAPES)[number], cls: string, attrs: string): string {
  return shape.open + cls + shape.body.replace("ATTRS", attrs) + shape.close;
}

/** The computed style of one twin while the pointer is genuinely held on it. Falls back to the
 *  resting read when the element has no box to press (a zero-size probe), which reports inert -
 *  the honest answer for something a finger cannot reach. */
async function readPressed(selector: string): Promise<ReturnType<typeof globalThis.__DSX_STYLE_READ__>> {
  const box = await page.locator(selector).boundingBox();
  if (box === null || box.width === 0 || box.height === 0) {
    return page.evaluate((s) => globalThis.__DSX_STYLE_READ__(s), selector);
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(PRESS_SETTLE_MS);
  const read = await page.evaluate((s) => globalThis.__DSX_STYLE_READ__(s), selector);
  await page.mouse.up();
  // PARK THE POINTER OFF THE PROBES. A pointer left where it pressed keeps hovering whatever
  // lands under it on the next probe, and a hover transition in flight reads as a changed
  // computed style - `ignoreSafeArea` passed on exactly that, its transparent background
  // serialising as oklab mid-interpolation rather than rgba. The corner is outside the 360px
  // probe root and below its content.
  await page.mouse.move(PARK.x, PARK.y);
  return read;
}

const PARK = { x: 415, y: 895 } as const;

for (const probe of probes) {
  const companion = COMPANIONS[probe.key] ?? "";
  const changed: string[] = [];
  // A DECLARATION IS NOT A RENDERING. The content-addressed `data-dsx` handle differs whenever
  // the two probes carry different declarations, whether or not anything consumes them - so on
  // its own it proves the compiler emitted something, not that the page shows anything. Kept
  // separate rather than dropped: when it is the ONLY difference that is exactly the finding,
  // and the evidence line should say so.
  const declarationOnly: string[] = [];
  for (const shape of SHAPES) {
    // The BARE twin carries the companions too, so the diff isolates the key under test rather
    // than reporting the companion own effect.
    const markup = '<vstack class="probe-root">' +
      shapeMarkup(shape, "bare", companion) +
      shapeMarkup(shape, "styled", companion + " " + probe.key + '="' + probe.value + '"') +
      "</vstack>";
    await page.evaluate((px) => globalThis.__DSX_STYLE_ROOT__(px), ROOT_FONT_SIZE[probe.key] ?? DEFAULT_ROOT);
    await page.evaluate((m) => globalThis.__DSX_STYLE_PROBE__(m), markup);
    await page.waitForTimeout(10);
    const [bare, styled] = PRESSED.has(probe.key)
      // Sequential and one at a time: there is a single pointer, so both twins are read under
      // their own press rather than one of them being read while the other holds it.
      ? [await readPressed(".bare"), await readPressed(".styled")]
      : await Promise.all([
        page.evaluate(() => globalThis.__DSX_STYLE_READ__(".bare")),
        page.evaluate(() => globalThis.__DSX_STYLE_READ__(".styled")),
      ]);
    if (process.env["DSX_SP"] === probe.key) {
      console.log("DBG", shape.name, markup);
      console.log("DBG html", await page.evaluate(() => document.body.innerHTML));
      console.log("DBG fs", JSON.stringify(styled && styled.style["font-style"]), JSON.stringify(styled && styled.style["opacity"]));
    }
    if (bare === null || styled === null) continue;
    for (const [name, value] of Object.entries(styled.style)) {
      if (bare.style[name] === value) continue;
      // A `--dsx-*` CUSTOM PROPERTY IS NOT A RENDERING. Setting one changes computed style
      // whether or not any rule reads it, and this harness counted that as reaching the pixels -
      // which is how `glassTint` and `glassInteractive` reported green while nothing in the
      // renderer consumed either one. An attribute that legitimately works THROUGH a custom
      // property still shows the downstream property it drives, so requiring a real effect costs
      // a working attribute nothing and costs an inert one its false green.
      if (name.startsWith("--")) continue;
      changed.push(shape.name + " " + name + ": " + bare.style[name] + " -> " + value);
    }
    for (const [name, value] of Object.entries(styled.attrs)) {
      if (bare.attrs[name] === value) continue;
      (name === "data-dsx" ? declarationOnly : changed).push(shape.name + " [" + name + "]=" + value);
    }
    if (styled.box !== bare.box) changed.push(shape.name + " box " + bare.box + " -> " + styled.box);
    if (styled.cls !== bare.cls) changed.push(shape.name + " class " + bare.cls + " -> " + styled.cls);
  }
  verdicts.push({
    group: probe.group, key: probe.key, reaches: changed.length > 0,
    evidence: changed.slice(0, 3).join(" \u00b7 ") ||
      (declarationOnly.length > 0
        ? "a declaration and nothing that reads it (" + declarationOnly[0] + ")"
        : "nothing changed"),
  });
}
await browser.close();

/** THE PIN. 4 on 2026-08-27, down from 37 in the run that first measured it. Every name here is
 *  a live Article 10 defect with a row in ClosedSource/release/platform-parity-register.json, and
 *  this list is the gate: an attribute that stops working joins it and fails, and one that starts
 *  working has to be REMOVED from it, so the next regression is caught. It only shrinks.
 *
 *  It went 37 -> 6 -> 2 -> 10 -> 4 in one day, and the excursion is the interesting part. Two of
 *  this harness OWN rules were too generous, and tightening them moved eight keys at once: a
 *  --dsx-* custom property nobody reads is not a rendering, and neither is the content-addressed
 *  data-dsx handle on its own. Six of those eight then turned out to be probe defects rather than
 *  renderer defects and were fixed here - Chromium does not ENUMERATE font-variation-settings or
 *  font-feature-settings, and Dynamic Type is deliberately a no-op at a 16px root, so both needed
 *  measuring differently rather than declaring broken.
 *
 *  The other two were real, and one was a defect this very file had just certified: radial and
 *  mesh were emitting a circle with a PERCENTAGE radius, which is invalid CSS, so the browser
 *  dropped the whole declaration and the element painted nothing. It read as working only because
 *  nothing still differs from a linear gradient. That is the strongest argument in this
 *  repository for measuring rather than grepping, and it is why the evidence string now prints
 *  for a passing row too under DSX_SP_EVIDENCE.
 *
 *  Then 4 -> 2. The glass pair was the one entry on this list whose diagnosis named a defect in
 *  the HARNESS as well as in the renderer, and both halves were real: the compiler emitted a
 *  `-dsx-*` vendor spelling a browser drops on sight, no rule consumed it either way, and the
 *  press-stretch is an interaction state a resting probe cannot see even once it ships. So the
 *  probe learned to hold the pointer down (PRESSED above) and the theme learned to read both
 *  properties. A gate that cannot observe the thing it gates is the same false green as a marker
 *  scan crediting a degradation table, and it is worth fixing before the feature, not after.
 *
 *  What is left needs DECISIONS rather than implementations: alignY and ignoreSafeArea both need
 *  a page semantic settled first. Guessing would have made this list shorter and the renderer
 *  less honest. */
const PINNED_INERT = ["alignY", "ignoreSafeArea"];

const inert = verdicts.filter((v) => !v.reaches);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ probed: verdicts.length, inert: inert.map((v) => v.key), verdicts }, null, 2));
} else {
  for (const group of [...new Set(verdicts.map((v) => v.group))]) {
    const rows = verdicts.filter((v) => v.group === group);
    console.log(`  ${group}`);
    for (const row of rows) console.log(`    ${row.reaches ? "ok  " : "INERT"} ${row.key.padEnd(18)} ${process.env["DSX_SP_EVIDENCE"] !== undefined || !row.reaches ? row.evidence : ""}`);
  }
  console.log(`\nstyle-attribute-parity: ${verdicts.length} probed, ${inert.length} inert on the web renderer`);
  if (inert.length > 0) console.log(`  inert: ${inert.map((v) => v.key).join(", ")}`);
}

const names = inert.map((v) => v.key).sort();
const pinned = [...PINNED_INERT].sort();
const regressed = names.filter((n) => !pinned.includes(n));
const fixed = pinned.filter((n) => !names.includes(n));
if (regressed.length > 0) {
  console.error(`\nERROR ${regressed.join(", ")} stopped reaching the pixels on the web renderer. ` +
    "Article 10: a style attribute the catalogue advertises works on every renderer. Fix it, or " +
    "add it to PINNED_INERT with a register row saying what an author gets instead.");
}
if (fixed.length > 0) {
  console.error(`\nERROR ${fixed.join(", ")} now reaches the pixels - good. Remove it from ` +
    "PINNED_INERT (and from the parity register) so the next regression is caught.");
}
if (regressed.length > 0 || fixed.length > 0) process.exit(1);
