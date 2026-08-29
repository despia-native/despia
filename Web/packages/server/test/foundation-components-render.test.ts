// The Wave 3 Foundation pair (design-system.md (c)2–(c)3): <Badge> + <Breadcrumb> are
// PURE-MARKUP shared components, so the web renderer must carry them with no web-side
// code at all. These tests compile the REAL shipped .dsx sources (the same bytes the
// Swift and Kotlin registries inline) and assert the observable contract on the
// DOM-free string renderer: the count fold, the dot form, the one-utterance a11y
// shape, the navigation landmark, real prior-row anchors, and the honest
// current-page row (text, never a link).

import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileComponent } from "../../compiler/src/component.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { renderToString } from "../src/render.ts";

const CORE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Core",
);

// Every test compiles the REAL shipped closed sources. An open drop skips LOUDLY,
// per test, with the reason - never silently (the component-fold-conformance rule).
const hasClosedSource = existsSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../../ClosedSource"));
const test: typeof nodeTest = hasClosedSource
  ? nodeTest
  : (((name: string) => nodeTest(name, (t) => t.skip("open drop without ClosedSource - the Foundation component sources ship closed"))) as typeof nodeTest);

function shared(name: string): ReturnType<typeof compileComponent> {
  return compileComponent(name, "shared", readFileSync(join(CORE, `${name}.dsx`), "utf-8"));
}

function registryWith(caller: ReturnType<typeof compileComponent>, ...deps: string[]): Registry {
  const components: Registry["components"] = { [`${caller.scheme}.${caller.name}`]: caller };
  const globalPool: Registry["globalPool"] = {};
  for (const dep of deps) {
    const ir = shared(dep);
    components[`shared.${dep}`] = ir;
    globalPool[dep] = `shared.${dep}`;
  }
  return { components, globalPool, css: "", schemes: ["t", "shared"] };
}

test("Badge: the count pill folds past max, announces once, and rides the token plane", () => {
  const caller = compileComponent("Screen", "t", `<vstack>
    <Badge value="3"/>
    <Badge value="128"/>
    <Badge value="128" max="500"/>
    <Badge value="7" color="accent"/>
    <Badge dot="true"/>
    <Badge dot="true" color="accent"/>
  </vstack>`);
  const html = renderToString(registryWith(caller, "Badge"), "t.Screen");

  assert.ok(!html.includes("dsx-unsupported"), "the component expands — never the placeholder");
  assert.ok(html.includes(">3</"), "an in-range count renders verbatim");
  assert.ok(html.includes(">99+</"), "numeric overflow folds to max+ (default 99)");
  assert.ok(html.includes(">128</"), "a raised max keeps the honest count");
  assert.equal(html.split('aria-label="99+"').length - 1, 1, "the fold is also the single utterance");
  assert.equal(html.split('aria-label="3"').length - 1, 1, "the pill announces its value exactly once");
  assert.ok(html.includes("var(--dsx-destructive)"), "default fill is the destructive token");
  assert.ok(html.includes("var(--dsx-on-destructive"), "pill text rides the on-color for its fill");
  assert.ok(html.includes("var(--dsx-accent)"), "color= retargets the fill token");
  // the dot form: no text, no utterance of its own (aria-hidden lands at hydration —
  // the server markup's contract is the ABSENCE of any label or text on the dot)
  assert.equal(html.split("aria-label=").length - 1, 4, "only the four pills announce");
  assert.equal(renderToString(registryWith(caller, "Badge"), "t.Screen"), html, "deterministic");
});

test("Breadcrumb: a navigation landmark whose prior rows are real anchors and whose last row is the current page", () => {
  const caller = compileComponent("Screen", "t", `<vstack>
    <Breadcrumb bind='[{"label":"Docs","path":"/"},{"label":"Guides","path":"/guides"},{"label":"System","path":"/guides/system"}]'/>
  </vstack>`);
  const html = renderToString(registryWith(caller, "Breadcrumb"), "t.Screen");

  assert.ok(!html.includes("dsx-unsupported"), "the component expands — never the placeholder");
  assert.ok(html.includes('role="navigation"'), "the trail is a navigation landmark");
  assert.ok(html.includes('aria-label="Breadcrumb"'));
  assert.ok(html.includes('role="list"'), "rows ride real list semantics");
  assert.equal(html.split('href="/"').length - 1, 1, "the first prior row is a real anchor");
  assert.equal(html.split('href="/guides"').length - 1, 1, "the second prior row is a real anchor");
  assert.ok(!html.includes('href="/guides/system"'), "the LAST row is the current page — never a link");
  assert.ok(html.includes("System"), "the current page label still renders");
  assert.equal(html.split("dsx-breadcrumb-sep").length - 1, 2, "N rows draw N-1 separators");
});

test("Breadcrumb: a hostile or empty bind renders nothing rather than a broken trail", () => {
  const caller = compileComponent("Screen", "t", `<vstack>
    <Breadcrumb bind="not rows"/>
    <Breadcrumb/>
  </vstack>`);
  const html = renderToString(registryWith(caller, "Breadcrumb"), "t.Screen");
  assert.ok(!html.includes("dsx-breadcrumb-sep"), "no separators");
  assert.ok(!html.includes("<a "), "no anchors");
});
