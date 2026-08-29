//
//  defaults.test.ts — the system-defaults precedence ladder on the web renderer
//  (architecture/proposals/system-defaults.md): renderer defaults (1) < app theme
//  tokens (2) < sidecar sheets (3) < shared author styles (4) < :native (5) <
//  exact-target suffixes (6). Rungs 5–6 fold at COMPILE time (web/14's ratified rule:
//  exact > :native > bare, whole-attribute, the iOS Stack.resolvePlatform twin — and
//  :native = ios+android, so it is DEAD on the web target); rungs 1–4 are cascade
//  layers whose order is fixed by the ONE layer statement.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { compileComponent } from "../src/component.ts";
import { CssCollector, extractComponentCss } from "../src/css.ts";
import { LAYER_STATEMENT, legacyAttrToDecls, mapStyleValue } from "../src/cssmap.ts";
import { TOKENS_CSS, ELEMENTS_CSS } from "../../dom/src/theme.ts";

const corpus = JSON.parse(
  readFileSync(new URL("../../../../Conformance/defaults/tokens.json", import.meta.url), "utf8"),
) as { tokens: { [word: string]: { web: { css: string } } } };

// ONE element riding every rung: the renderer default (.dsx-button, rung 1), an app
// theme-token override (rung 2), a shared style (rung 4), a :native style (rung 5),
// and the exact :web suffix (rung 6 — always wins).
const SRC = `<stack>
  <button label="Delete"
          style="color: accent; padding: 9px"
          style:native="color: separator"
          style:ios="padding: 1px"
          style:web="color: destructive; max-width: 640px"/>
</stack>`;

// rung 2: the app's theme.css recolors system components by token override alone
const THEME_CSS = `@layer dsx-theme { :root { --dsx-accent: rebeccapurple; } }`;

test("suffix fold on style attrs: exact :web wins whole-attribute; :native/:ios are dead on web", () => {
  const ir = compileComponent("Ladder", "t", SRC);
  const button = ir.root.children[0]!;
  // most-specific wins WHOLESALE (web/14 + iOS resolvePlatform: attribute-level
  // replacement, not a property merge) — resolved once at compile, never per frame
  assert.equal(button.attrs["style"], "color: destructive; max-width: 640px");
  assert.equal(button.attrs["style:web"], undefined);
  assert.equal(button.attrs["style:native"], undefined, ":native = ios+android, never web");
  assert.equal(button.attrs["style:ios"], undefined);
});

test("the ladder outcome in the compiled cascade", () => {
  const ir = compileComponent("Ladder", "t", SRC);
  const collector = new CssCollector();
  extractComponentCss(ir, collector);
  const bundle = [LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, THEME_CSS, collector.emit()].join("\n\n");

  // the ONE layer statement declares the rungs weakest → strongest
  const order = ["dsx-tokens", "dsx-elements", "dsx-theme", "dsx-sheets", "dsx-inline", "dsx-attrs"];
  const idx = order.map((l) => LAYER_STATEMENT.indexOf(l));
  assert.ok(idx.every((i) => i >= 0), "every rung layer is declared");
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, "declared weakest → strongest");

  // rung 1: the renderer's system default for the element, in the weak element layer
  assert.ok(ELEMENTS_CSS.includes(".dsx-button"), "the unstyled button HAS a system default");
  // rung 2: the theme override rides dsx-theme — later than dsx-elements in the ONE
  // statement, so it recolors system components with zero specificity fights
  assert.ok(bundle.includes("@layer dsx-theme"));
  assert.ok(LAYER_STATEMENT.indexOf("dsx-elements") < LAYER_STATEMENT.indexOf("dsx-theme"));

  // rung 6 landed in dsx-inline as the folded declarations, semantic word → token
  const inline = bundle.substring(bundle.indexOf("@layer dsx-inline"));
  assert.ok(inline.includes("color: var(--dsx-destructive)"), "the corpus word resolved to its token");
  assert.ok(inline.includes("max-width: 640px"));
  // the losing rungs shipped ZERO bytes (web bundles carry no iOS-only style)
  assert.ok(!inline.includes("var(--dsx-accent)"), "bare style lost whole-attribute to :web");
  assert.ok(!bundle.includes("padding: 9px"), "bare style's declarations are gone");
  assert.ok(!bundle.includes("padding: 1px"), ":ios is dead on the web target");
  assert.ok(!inline.includes("var(--dsx-separator)"), ":native is dead on the web target");
});

/** each corpus word's CANONICAL style family (system-defaults semantics): text words
 *  resolve through color=, surface words through background=. cssmap deliberately
 *  keeps the pre-corpus aliases where the families DIVERGE (`secondary`/`tertiary`
 *  mean the label var in the color family but the surface alias in the background
 *  family), so the gate asserts the corpus var in AT LEAST the canonical family —
 *  never blindly both. A NEW corpus word fails here until it is classified. */
const CANONICAL_FAMILY: { [word: string]: "color" | "background" } = {
  label: "color", secondary: "color", tertiary: "color", accent: "color", destructive: "color",
  background: "background", groupedBackground: "background",
  secondaryGroupedBackground: "background", fill: "background", separator: "background",
};

test("cssmap gate: EVERY corpus word resolves to its corpus var in its canonical family", () => {
  for (const [word, row] of Object.entries(corpus.tokens)) {
    const family = CANONICAL_FAMILY[word];
    assert.ok(family !== undefined, `${word}: new corpus word — classify its canonical family in this gate`);
    assert.equal(mapStyleValue(family, word), `var(${row.web.css})`, `${word} via ${family}=`);
  }
});

test("the pre-corpus aliases stay pinned where the families diverge (the cssmap wiring)", () => {
  // background-family secondary/tertiary are the SURFACE aliases (theme.ts declares
  // the alias custom properties) — NOT the corpus label vars the color family maps
  assert.equal(mapStyleValue("background", "secondary"), "var(--dsx-secondary-background)");
  assert.equal(mapStyleValue("background", "tertiary"), "var(--dsx-tertiary-background)");
  // words cssmap deliberately carries in BOTH families keep the same var either way
  assert.equal(mapStyleValue("background", "destructive"), "var(--dsx-destructive)");
  assert.equal(mapStyleValue("background", "accent"), "var(--dsx-accent)");
  assert.equal(mapStyleValue("color", "fill"), "var(--dsx-fill)");
  assert.equal(mapStyleValue("color", "separator"), "var(--dsx-separator)");
});

test("the two vocabulary words a gradient needs resolve, because one unmapped stop kills the whole gradient", () => {
  // `gradient="a|b"` folds to ONE `linear-gradient()` declaration, so an unmapped stop does not
  // degrade that stop - it invalidates the declaration and the browser drops it in silence. Both
  // of these are in the catalogue (stack-style-properties.json: `systemBackground` is the listed
  // alias of `background`, `clear` is #00000000), and neither was in the table.
  assert.equal(mapStyleValue("background", "systemBackground"), "var(--dsx-background)");
  assert.equal(mapStyleValue("background", "background"), "var(--dsx-background)");
  assert.equal(mapStyleValue("background", "clear"), "transparent");
  assert.deepEqual(
    legacyAttrToDecls("gradient", "systemBackground|clear"),
    [["background", "linear-gradient(180deg, var(--dsx-background), transparent)"]],
  );
});
