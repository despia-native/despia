//
//  expose-lint.test.ts — the three build-time EXPOSE lints (/web/13 §"Lint (build-time, on
//  `expose`)", S-07). Before this, the doc's own header said "No linter runs on the `expose`
//  path at all" — expose.ts enforced only tag grammar, tag collisions and the budget bound.
//  These pin the three it declared: pushed-`vars` rejection (E), the missing-web-entry check
//  for own-module calls (E), and the rich-typed-attribute-without-a-shape warning (W). CORS
//  and expose are web-only embed infrastructure, so this is a web-local gate.
//

import test from "node:test";
import assert from "node:assert/strict";

import { compileComponent } from "../src/component.ts";
import { readExpose, lintExposed } from "../src/expose.ts";
import type { Registry } from "../src/resolve.ts";

/** A minimal registry from {qualified: .dsx source} — css metadata is absent, which
 *  cssForComponentSlice degrades to registry.css gracefully (here ""). */
function makeRegistry(components: Record<string, string>): Registry {
  const out: Registry["components"] = {};
  for (const [qualified, source] of Object.entries(components)) {
    const dot = qualified.indexOf(".");
    out[qualified] = compileComponent(qualified.slice(dot + 1), qualified.slice(0, dot), source);
  }
  return { components: out, globalPool: {}, css: "", schemes: [] };
}

test("a clean exposed component trips no lint — the demo/editor shape stays green", () => {
  // string + number attributes, no expects, no own-module calls, no rich defaults
  const registry = makeRegistry({
    "demo.EmbedCard": `<stack><head><attribute as="title" default="Hi"/><attribute as="count" default="0"/><event as="cheer"/></head><text value="{{ dsx.attribute.title }}"/><button label="Cheer" on:tap="dsx.event('cheer', {})"/></stack>`,
  });
  const result = lintExposed(readExpose("demo", { expose: { EmbedCard: {} } }), registry, new Set(["demo"]));
  assert.deepEqual(result, { errors: [], warnings: [] });
});

test("lint 1 (E): an exposed component with <expects> is rejected — an embed is attribute-driven", () => {
  const registry = makeRegistry({
    "shop.Paywall": `<stack><head><expects variable="vars"/><attribute as="plan" default="pro"/></head><text value="{{ vars.plan }}"/></stack>`,
  });
  // even WITH a web twin the expects is invalid — it is a contract an embed can never satisfy
  const { errors } = lintExposed(readExpose("shop", { expose: { Paywall: {} } }), registry, new Set(["shop"]));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /expects/);
  assert.match(errors[0]!, /attribute-driven/);
});

test("lint 2 (E): own-module calls with NO web twin are dead buttons — must declare a web entry", () => {
  const registry = makeRegistry({
    "shop.Paywall": `<stack><head><attribute as="plan" default="pro"/></head><button label="Buy" on:tap="dsx.module.shop.checkout({ plan: dsx.attribute.plan })"/></stack>`,
  });
  const exposed = readExpose("shop", { expose: { Paywall: {} } });
  // shop ships NO web facet → the checkout button is dead on every embed → ERROR
  const noTwin = lintExposed(exposed, registry, new Set());
  assert.equal(noTwin.errors.length, 1);
  assert.match(noTwin.errors[0]!, /shop\.checkout/);
  assert.match(noTwin.errors[0]!, /web entry|web\.entry/);
  // …the SAME markup, once shop ships a web twin, is implementable → no error
  const withTwin = lintExposed(exposed, registry, new Set(["shop"]));
  assert.equal(withTwin.errors.length, 0);
});

test("lint 2: the legacy <scheme>:// form counts too; OTHER modules degrade (never an error)", () => {
  const legacy = makeRegistry({
    "shop.Paywall": `<stack><button label="Buy" on:tap="shop://checkout"/></stack>`,
  });
  assert.equal(lintExposed(readExpose("shop", { expose: { Paywall: {} } }), legacy, new Set()).errors.length, 1);
  // a call to a DIFFERENT module (haptic) is the honest subset — degrades via dsx.has, not an error
  const foreign = makeRegistry({
    "shop.Paywall": `<stack><button label="Buy" on:tap="dsx.module.haptic.tap()"/></stack>`,
  });
  assert.equal(lintExposed(readExpose("shop", { expose: { Paywall: {} } }), foreign, new Set()).errors.length, 0);
});

test("lint 2 follows the transitive slice — a same-scheme nested component's own call counts", () => {
  const registry = makeRegistry({
    "shop.Paywall": `<stack><shop.BuyRow/></stack>`,
    "shop.BuyRow": `<stack><button label="Buy" on:tap="dsx.module.shop.checkout()"/></stack>`,
  });
  const { errors } = lintExposed(readExpose("shop", { expose: { Paywall: {} } }), registry, new Set());
  assert.equal(errors.length, 1, "the nested BuyRow ships in the embed, so its dead call counts");
});

test("lint 3 (W): a rich-typed attribute (object/array default) with no documented shape warns", () => {
  const registry = makeRegistry({
    "shop.Cart": `<stack><head>` +
      `<attribute as="items" default="[]"/>` +                                   // array → rich
      `<attribute as="theme" default="{&quot;accent&quot;:&quot;red&quot;}"/>` + // object → rich
      `<attribute as="title" default="Cart"/>` +                                 // string → not
      `<attribute as="count" default="0"/>` +                                    // number → not
      `<attribute as="live" default="{{ dsx.attribute.title }}"/>` +             // interpolation → not
      `</head><text value="{{ dsx.attribute.title }}"/></stack>`,
  });
  const { errors, warnings } = lintExposed(readExpose("shop", { expose: { Cart: {} } }), registry, new Set(["shop"]));
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 2, "items ([]) and theme ({…}) warn; string/number/interpolation do not");
  assert.ok(warnings.some((w) => /"items"/.test(w)));
  assert.ok(warnings.some((w) => /"theme"/.test(w)));
  assert.ok(warnings.every((w) => /rich-typed/.test(w) && /JSON shape/.test(w)));
});

test("the three lints compose — one component can raise two errors and a warning at once", () => {
  const registry = makeRegistry({
    "shop.Paywall": `<stack><head><expects variable="vars"/><attribute as="items" default="[]"/></head>` +
      `<button label="Buy" on:tap="dsx.module.shop.checkout()"/></stack>`,
  });
  const { errors, warnings } = lintExposed(readExpose("shop", { expose: { Paywall: {} } }), registry, new Set());
  assert.equal(errors.length, 2, "expects (1) + own-module-no-twin (2)");
  assert.equal(warnings.length, 1, "the rich items[] attribute");
});
