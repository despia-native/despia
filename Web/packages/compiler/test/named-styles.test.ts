//
//  named-styles.test.ts — `<style as="card" …/>` head declarations, the REUSABLE LOOK
//  (dsx-anatomy.md "style: repeated looks get a class"). Both native renderers have
//  always implemented this — iOS and Android each keep a `store.classes[name]` table and
//  merge it under the element's own attributes — while the web compiler dropped the head
//  tag on a `default: break`. The class still landed on the element, so idiomatic DSX
//  rendered structurally right and completely unstyled: our own worked example's Settings
//  screen lost every card, and an agent following the reference got the same. That was an
//  Article 10 gap (a capability shipping on two renderers of three), not a missing feature.
//
//  The fold: a named style is exactly "a class rule in this component's own sheet", so it
//  goes through the SAME cssmap an element attribute uses and the SAME owner scoping a
//  sidecar Foo.css gets, landing in `dsx-sheets`. The layer order then supplies the native
//  precedence for free — dsx-sheets sits below dsx-inline and dsx-attrs, so the element's
//  own attributes win over the named style exactly as `base.putAll(a)` does on native.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { compileComponent } from "../src/component.ts";
import { CssCollector, extractComponentCss } from "../src/css.ts";
import { LAYER_STATEMENT } from "../src/cssmap.ts";

function css(source: string, name = "Card"): string {
  const ir = compileComponent(name, "test", source);
  const collector = new CssCollector();
  extractComponentCss(ir, collector);
  return collector.emit();
}

test("a named style reaches the IR instead of being dropped on the floor", () => {
  const ir = compileComponent("Card", "test", `<stack>\n  <head>\n    <style as="card" padding="12" radius="14"/>\n  </head>\n  <vstack class="card"/>\n</stack>\n`);
  assert.equal(ir.head.styles.length, 1);
  assert.equal(ir.head.styles[0]!.as, "card");
  assert.deepEqual(ir.head.styles[0]!.attrs, { padding: "12", radius: "14" });
  assert.ok(!("as" in ir.head.styles[0]!.attrs), "`as` is the name, never a declaration");
});

test("it folds through the ordinary cssmap and lands owner-scoped in dsx-sheets", () => {
  const out = css(`<stack>\n  <head>\n    <style as="card" padding="12" radius="14"/>\n  </head>\n  <vstack class="card"/>\n</stack>\n`);
  assert.match(out, /@layer dsx-sheets \{/, "a named style is a component-sheet rule");
  assert.match(out, /\[data-dsx-owner="Card"\] \.card/, "scoped to its component, like a sidecar sheet");
  assert.match(out, /\[data-dsx-owner="Card"\]:is\(\.card\)/, "and reaches the component's own root");
  assert.match(out, /padding: 12px/);
  assert.match(out, /border-radius: 14px/);
});

test("semantic tokens resolve, so a named style is not a hex trap", () => {
  const out = css(`<stack>\n  <head>\n    <style as="card" background="secondaryGroupedBackground"/>\n  </head>\n  <vstack class="card"/>\n</stack>\n`);
  assert.match(out, /background: var\(--dsx-secondary-grouped-background\)/);
});

test("the layer order puts the element's own attributes ABOVE the named style", () => {
  // the native law is `base.putAll(a)` — the element always wins. On web that is the
  // cascade: dsx-sheets is declared before dsx-inline/dsx-attrs in the ONE layer statement.
  const order = LAYER_STATEMENT.replace(/@layer |;/g, "").split(",").map((l) => l.trim());
  assert.ok(order.indexOf("dsx-sheets") < order.indexOf("dsx-attrs"),
    "a named style must never beat the element's own attribute");
  assert.ok(order.indexOf("dsx-sheets") < order.indexOf("dsx-inline"),
    "nor its inline style");
});

test("two components may each name `card` without colliding", () => {
  const a = css(`<stack>\n  <head>\n    <style as="card" padding="12"/>\n  </head>\n  <vstack class="card"/>\n</stack>\n`, "Alpha");
  const b = css(`<stack>\n  <head>\n    <style as="card" padding="32"/>\n  </head>\n  <vstack class="card"/>\n</stack>\n`, "Beta");
  assert.match(a, /\[data-dsx-owner="Alpha"\] \.card/);
  assert.ok(!a.includes("Beta"), "one component's look cannot leak out under a shared name");
  assert.match(b, /padding: 32px/);
});

test("a reactive value is not baked into a class", () => {
  // a class rule is static by construction; folding `{{ }}` here would freeze the
  // template TEXT into CSS the runtime never revisits
  const out = css(`<stack>\n  <head>\n    <style as="card" padding="{{ dsx.variable.pad }}" radius="14"/>\n  </head>\n  <vstack class="card"/>\n</stack>\n`);
  assert.ok(!out.includes("{{"), "no template text in the sheet");
  assert.match(out, /border-radius: 14px/, "the static half of the same style still lands");
});

test("a name that is not a usable class ident is skipped, not emitted broken", () => {
  const out = css(`<stack>\n  <head>\n    <style as="9 bad" padding="12"/>\n  </head>\n  <vstack/>\n</stack>\n`);
  assert.ok(!out.includes(".9 bad"), "an unusable ident never reaches the sheet");
});

test("a style with no mappable declaration emits no empty rule", () => {
  const out = css(`<stack>\n  <head>\n    <style as="card" data-nonsense="x"/>\n  </head>\n  <vstack class="card"/>\n</stack>\n`);
  assert.ok(!/\.card \{\s*;?\s*\}/.test(out), "no empty rule blocks");
});

test("a component with no named styles emits no dsx-sheets layer at all", () => {
  const out = css(`<stack>\n  <vstack padding="12"/>\n</stack>\n`);
  assert.ok(!out.includes("@layer dsx-sheets"), "byte-identical for the components that never use it");
});

test("multi-class merges in CLASS-ATTRIBUTE order, the native law", () => {
  // iOS and Android both walk the class attribute left to right (`base.putAll`), so the
  // LAST class listed wins. A CSS cascade would resolve by the head's declaration order
  // instead and hand `class="b a"` the wrong padding, so a static class list folds at
  // compile time in the author's order.
  const ir = compileComponent("Order", "test",
    `<stack>\n  <head>\n    <style as="a" padding="4"/>\n    <style as="b" padding="8"/>\n  </head>\n  <vstack class="b a"/>\n</stack>\n`);
  const collector = new CssCollector();
  extractComponentCss(ir, collector);
  const out = collector.emit();
  const attrs = out.slice(out.indexOf("@layer dsx-attrs"));
  const four = attrs.lastIndexOf("padding: 4px");
  const eight = attrs.lastIndexOf("padding: 8px");
  assert.ok(four > eight, `class="b a" must let a win (padding 4), got ${attrs.trim().slice(0, 160)}`);
});

test("the element's own attribute still beats every named style it carries", () => {
  const ir = compileComponent("Own", "test",
    `<stack>\n  <head>\n    <style as="a" padding="4"/>\n  </head>\n  <vstack class="a" padding="32"/>\n</stack>\n`);
  const collector = new CssCollector();
  extractComponentCss(ir, collector);
  const attrs = collector.emit();
  const own = attrs.lastIndexOf("padding: 32px");
  const named = attrs.lastIndexOf("padding: 4px");
  assert.ok(own > named, "the element's own declaration is last, so it wins");
});

test("a class formula still resolves through the sheet rules", () => {
  const ir = compileComponent("Dyn", "test",
    `<stack>\n  <head>\n    <style as="a" padding="4"/>\n  </head>\n  <vstack class="{{ dsx.variable.which }}"/>\n</stack>\n`);
  const collector = new CssCollector();
  extractComponentCss(ir, collector);
  const out = collector.emit();
  assert.match(out, /@layer dsx-sheets[\s\S]*\.a/, "a runtime-swapped class still has a rule to hit");
});
