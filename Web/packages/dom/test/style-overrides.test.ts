//
//  style-overrides.test.ts — the RENDERER half of the style-override plane (the pure
//  laws are corpus-gated three ways: Conformance/overrides/style-overrides.json). What
//  belongs here is the wiring no pure function can prove: the usage-site split at the
//  real mount path, a knob reaching an element nested DEEP inside the component, the
//  live re-seed when a bound override changes, the css-typed whole-list door
//  (`style="{{ dsx.override.x }}"`) applying and RETRACTING declarations, plane
//  separation from attributes, forwarding into a nested component, and the verb door
//  (instantiate's opts.overrides).
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, ActionRunner, makeRunEnv, flushEffects } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import type { Registry } from "@despia/compiler/resolve";
import { compileComponent } from "@despia/compiler/component";
import { CssCollector, extractComponentCss } from "@despia/compiler";
import { mountNode, instantiate, type MountCtx } from "../src/mount.ts";
import { registerRichElements } from "../src/elements.ts";
// imported for effect as well as for the class: it installs document/window/observers
import { FakeElement } from "./fake-dom.ts";

registerRichElements();

function harness(components: { [name: string]: string }, seed: { [k: string]: unknown } = {}): {
  root: FakeElement;
  store: ReactiveStore;
  registry: Registry;
  mount: (node: XmlNode) => void;
} {
  const store = new ReactiveStore();
  for (const [k, v] of Object.entries(seed)) store.set(k, v);
  const env = makeRunEnv(store);
  const registry: Registry = { components: {}, globalPool: {}, css: "", schemes: ["t"] };
  const collector = new CssCollector();
  for (const [name, source] of Object.entries(components)) {
    const ir = compileComponent(name, "t", source);
    extractComponentCss(ir, collector); // the registry build's pass — stamps __style_list
    registry.components[`t.${name}`] = ir;
  }
  const ctx: MountCtx = {
    registry, scheme: "t", owner: "Test", store, runner: new ActionRunner(env), env,
    item: null, disposers: [], slots: null, rowBinding: null,
  };
  const root = new FakeElement("div");
  return { root, store, registry, mount: (node) => mountNode(node, ctx, root as unknown as ParentNode) };
}

function xml(tag: string, attrs: { [k: string]: string } = {}, children: XmlNode[] = []): XmlNode {
  return { tag, attrs, children, text: "" };
}

/** Every text this subtree renders, in document order. */
function texts(el: FakeElement): string[] {
  const out: string[] = [];
  const walk = (n: FakeElement): void => {
    if (n.childCount === 0) { if (n.textContent.length > 0) out.push(n.textContent); return; }
    for (let i = 0; i < n.childCount; i += 1) walk(n.childAt(i));
  };
  walk(el);
  return out;
}

/** depth-first search for the first element carrying a class token */
function findByClass(el: FakeElement, token: string): FakeElement | null {
  if (el.classList.contains(token)) return el;
  for (let i = 0; i < el.childCount; i += 1) {
    const hit = findByClass(el.childAt(i), token);
    if (hit !== null) return hit;
  }
  return null;
}

// ── the tag door: literal values, typed reads, defaults ──────────────────────────────

test("a literal override is coerced by its declared type; an unset one reads its default", () => {
  const h = harness({
    Probe: `<stack>
      <head>
        <override as="radius" type="length" default="12"/>
        <override as="glass" type="boolean" default="true"/>
      </head>
      <text value="{{ typeof dsx.override.radius }}|{{ dsx.override.radius }}|{{ dsx.override.glass ? 'glass' : 'flat' }}"/>
    </stack>`,
  });
  h.mount(xml("Probe", { "override:radius": "6" }));
  flushEffects();
  assert.deepEqual(texts(h.root), ["number|6|glass"]);
});

test("an invalid override degrades to the default; an undeclared one reads null", () => {
  const h = harness({
    Probe: `<stack>
      <head><override as="surface" type="enum" options="raised cut" default="raised"/></head>
      <text value="{{ dsx.override.surface }}|{{ dsx.override.ghost == null ? 'null' : 'leak' }}"/>
    </stack>`,
  });
  h.mount(xml("Probe", { "override:surface": "velvet", "override:ghost": "6" }));
  flushEffects();
  assert.deepEqual(texts(h.root), ["raised|null"]);
});

// ── depth: the knob lands on an element nested inside the component ──────────────────

test("an override reaches an element three levels deep", () => {
  const h = harness({
    Deep: `<stack>
      <head><override as="tint" type="color" default="accent"/></head>
      <stack><stack><text class="innermost" value="tinted" color="{{ dsx.override.tint }}"/></stack></stack>
    </stack>`,
  });
  h.mount(xml("Deep", { "override:tint": "#FF0000" }));
  flushEffects();
  const inner = findByClass(h.root, "innermost");
  assert.ok(inner !== null, "the deep element mounted");
  // `color=` is a reactive bridge attribute: its declaration lands as an inline style
  assert.equal(inner.style.values.get("color"), "#FF0000");
});

// ── reactivity: a bound override re-seeds the instance live ──────────────────────────

test("a bound override updates the deep element when the consumer's state changes", () => {
  const h = harness({
    Deep: `<stack>
      <head><override as="pad" type="number" default="8" min="0" max="40"/></head>
      <stack><text id="probe" value="{{ dsx.override.pad }}"/></stack>
    </stack>`,
  }, { p: 10 });
  h.mount(xml("Deep", { "override:pad": "{{ dsx.variable.p }}" }));
  flushEffects();
  assert.deepEqual(texts(h.root), ["10"]);
  h.store.set("p", 24);
  flushEffects();
  assert.deepEqual(texts(h.root), ["24"]);
  // garbage degrades to the default, live
  h.store.set("p", "huge");
  flushEffects();
  assert.deepEqual(texts(h.root), ["8"]);
  // and the clamp holds on the live path too
  h.store.set("p", 999);
  flushEffects();
  assert.deepEqual(texts(h.root), ["40"]);
});

// ── the css-typed whole-list door ────────────────────────────────────────────────────

test("style=\"{{ dsx.override.extra }}\" applies a declaration list and retracts it on change", () => {
  const h = harness({
    Skin: `<stack>
      <head><override as="extra" type="css"/></head>
      <stack class="skinned" style="{{ dsx.override.extra }}"><slot/></stack>
    </stack>`,
  }, { look: "border-radius: 6px; opacity: 0.9" });
  h.mount(xml("Skin", { "override:extra": "{{ dsx.variable.look }}" }));
  flushEffects();
  const el = findByClass(h.root, "skinned");
  assert.ok(el !== null);
  assert.equal(el.style.values.get("border-radius"), "6px");
  assert.equal(el.style.values.get("opacity"), "0.9");
  // a shrinking list retracts what the previous evaluation set
  h.store.set("look", "opacity: 0.5");
  flushEffects();
  assert.equal(el.style.values.get("border-radius"), undefined, "stale declaration retracted");
  assert.equal(el.style.values.get("opacity"), "0.5");
  // the class contract retracts too: flex-direction toggled dsx-hstack on, and a later
  // list without the declaration restores the element's own base state
  h.store.set("look", "flex-direction: row; opacity: 0.5");
  flushEffects();
  assert.ok(el.classList.contains("dsx-hstack"), "row list toggles the hstack class on");
  h.store.set("look", "opacity: 0.4");
  flushEffects();
  assert.ok(!el.classList.contains("dsx-hstack"), "dropping flex-direction restores the base class state");
  assert.equal(el.style.values.get("flex-direction"), undefined, "the inline property retracted with it");
});

// ── plane separation + forwarding ────────────────────────────────────────────────────

test("an override and an attribute of the same name are separate planes", () => {
  const h = harness({
    Probe: `<stack>
      <head>
        <attribute as="tint" default="'data'"/>
        <override as="tint" type="color" default="accent"/>
      </head>
      <text value="{{ dsx.attribute.tint }}|{{ dsx.override.tint }}"/>
    </stack>`,
  });
  h.mount(xml("Probe", { tint: "payload", "override:tint": "#00FF00" }));
  flushEffects();
  assert.deepEqual(texts(h.root), ["payload|#00FF00"]);
});

test("a component forwards its own override into a nested component", () => {
  const h = harness({
    Inner: `<stack>
      <head><override as="radius" type="length" default="4"/></head>
      <text value="{{ dsx.override.radius }}"/>
    </stack>`,
    Outer: `<stack>
      <head><override as="radius" type="length" default="12"/></head>
      <Inner override:radius="{{ dsx.override.radius }}"/>
    </stack>`,
  });
  h.mount(xml("Outer", { "override:radius": "20" }));
  flushEffects();
  assert.deepEqual(texts(h.root), ["20"]);
});

// ── the verb door: instantiate(opts.overrides) ───────────────────────────────────────

test("instantiate's overrides option seeds the store-var door", () => {
  const h = harness({
    Probe: `<stack>
      <head><override as="radius" type="length" default="12"/></head>
      <text value="{{ dsx.override.radius }}"/>
    </stack>`,
  });
  const ir = h.registry.components["t.Probe"]!;
  const instance = instantiate(ir, h.registry, { overrides: { radius: "30" } });
  flushEffects();
  const probe = instance.root as unknown as FakeElement;
  assert.deepEqual(texts(probe), ["30"]);
  instance.unmount();
});
