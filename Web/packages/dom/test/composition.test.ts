//
//  composition.test.ts — what a component INSTANCE receives, and for how long it stays
//  right. Two defects live here, and they turned out to be the same one seen from two
//  sides: a component boundary that is neither typed nor reactive.
//
//    R6 — props arrived interpolated, so every one was a string. A component could not be
//         handed structure, which makes a self-recursive component (a tree, an outliner,
//         a comment thread) unbuildable: the child got "[object Object]".
//    R5 — a keyed row whose data changed in place refreshed a binding written directly in
//         the row and NOT the identical binding one component deep, because every
//         `{...ctx}` copy had frozen `item` at mount. Live and stale data in one row.
//
//  Both are asserted here against the real mount path with a real store. The pure fold is
//  corpus-gated three ways (Conformance/composition/attribute-binding.json); this file
//  gates the RENDERER: the value actually reaching `dsx.attribute.*`, the identity of a
//  row's item view, and the recursion floor that keeps corrupt data from killing the tab.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { ReactiveStore, ActionRunner, makeRunEnv, flushEffects } from "@despia-native/kernel";
import type { XmlNode } from "@despia-native/compiler/xml";
import type { Registry } from "@despia-native/compiler/resolve";
import { compileComponent } from "@despia-native/compiler/component";
import { mountNode, COMPONENT_DEPTH_CAP, type MountCtx } from "../src/mount.ts";
import { registerRichElements } from "../src/elements.ts";
// imported for effect as well as for the class: it installs document/window/observers
import { FakeElement } from "./fake-dom.ts";

registerRichElements();

function harness(components: { [name: string]: string }, seed: { [k: string]: unknown } = {}): {
  root: FakeElement;
  store: ReactiveStore;
  mount: (node: XmlNode) => void;
} {
  const store = new ReactiveStore();
  for (const [k, v] of Object.entries(seed)) store.set(k, v);
  const env = makeRunEnv(store);
  const registry: Registry = { components: {}, globalPool: {}, css: "", schemes: ["t"] };
  for (const [name, source] of Object.entries(components)) {
    registry.components[`t.${name}`] = compileComponent(name, "t", source);
  }
  const ctx: MountCtx = {
    registry, scheme: "t", owner: "Test", store, runner: new ActionRunner(env), env,
    item: null, disposers: [], slots: null, rowBinding: null,
  };
  const root = new FakeElement("div");
  return { root, store, mount: (node) => mountNode(node, ctx, root as unknown as ParentNode) };
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

// ── R6: a sole {{ … }} prop carries the VALUE ────────────────────────────────────────

test("a sole-hole prop carries the object, not its string coercion", () => {
  const h = harness({
    Probe: `<stack>
      <head><attribute as="row"/></head>
      <text value="{{ typeof dsx.attribute.row }}|{{ dsx.attribute.row.label }}"/>
    </stack>`,
  }, { row: { label: "Alpha" } });
  h.mount(xml("Probe", { row: "{{ dsx.variable.row }}" }));
  flushEffects();
  assert.deepEqual(texts(h.root), ["object|Alpha"]);
});

test("a sole-hole prop carries a number and a boolean, not \"3\" and \"false\"", () => {
  const h = harness({
    Probe: `<stack>
      <head><attribute as="n"/><attribute as="flag"/></head>
      <text value="{{ typeof dsx.attribute.n }}|{{ typeof dsx.attribute.flag }}|{{ dsx.attribute.flag ? 'on' : 'off' }}"/>
    </stack>`,
  }, { n: 3, flag: false });
  h.mount(xml("Probe", { n: "{{ dsx.variable.n }}", flag: "{{ dsx.variable.flag }}" }));
  flushEffects();
  // `false` reaching the child as the STRING "false" is truthy under JS string rules,
  // which is the exact shape of the shipped `disabled=` trap. It must arrive as a boolean.
  assert.deepEqual(texts(h.root), ["number|boolean|off"]);
});

test("a mixed template is still a sentence", () => {
  const h = harness({
    Probe: `<stack>
      <head><attribute as="label"/></head>
      <text value="{{ typeof dsx.attribute.label }}|{{ dsx.attribute.label }}"/>
    </stack>`,
  }, { n: 3 });
  h.mount(xml("Probe", { label: "{{ dsx.variable.n }} deep" }));
  flushEffects();
  assert.deepEqual(texts(h.root), ["string|3 deep"]);
});

test("a value prop stays typed when it changes", () => {
  const h = harness({
    Probe: `<stack>
      <head><attribute as="row"/></head>
      <text value="{{ typeof dsx.attribute.row }}|{{ dsx.attribute.row.label }}"/>
    </stack>`,
  }, { row: { label: "Alpha" } });
  h.mount(xml("Probe", { row: "{{ dsx.variable.row }}" }));
  flushEffects();
  h.store.set("row", { label: "Beta" });
  flushEffects();
  assert.deepEqual(texts(h.root), ["object|Beta"]);
});

// ── R6: the recursive component, which is the reason typed props had to exist ────────

test("a component that names itself walks a tree until the data runs out", () => {
  const h = harness({
    Node: `<stack>
      <head>
        <attribute as="node"/>
        <variable as="kids" computed="true">
          const n = dsx.attribute.node
          return n == null || n.children == null ? [] : n.children
        </variable>
      </head>
      <text value="{{ dsx.attribute.node.label }}"/>
      <list bind="kids" key="label">
        <Node node="{{ item }}"/>
      </list>
    </stack>`,
  }, {
    tree: {
      label: "root",
      children: [
        { label: "a", children: [{ label: "a1", children: [] }] },
        { label: "b", children: [] },
      ],
    },
  });
  h.mount(xml("Node", { node: "{{ dsx.variable.tree }}" }));
  flushEffects();
  assert.deepEqual(texts(h.root), ["root", "a", "a1", "b"]);
});

test("a recursive component goes as deep and as wide as the data does", () => {
  // The stress the flat-tree workaround used to exist to avoid: deep on one spine, wide at
  // every level, and no arbitrary ceiling short of the corrupt-data floor. 64 is well past
  // the 32 the native renderers used to cap at.
  const DEPTH = 64;
  let spine: { label: string; children: unknown[] } = { label: `n${DEPTH}`, children: [] };
  for (let i = DEPTH - 1; i >= 0; i -= 1) {
    spine = { label: `n${i}`, children: [spine, { label: `leaf${i}`, children: [] }] };
  }
  const h = harness({
    Node: `<stack>
      <head>
        <attribute as="node"/>
        <variable as="kids" computed="true">
          const n = dsx.attribute.node
          return n == null || n.children == null ? [] : n.children
        </variable>
      </head>
      <text value="{{ dsx.attribute.node.label }}"/>
      <list bind="kids" key="label">
        <Node node="{{ item }}"/>
      </list>
    </stack>`,
  }, { tree: spine });
  h.mount(xml("Node", { node: "{{ dsx.variable.tree }}" }));
  flushEffects();
  const rendered = texts(h.root);
  // one spine node per level (0..DEPTH) plus one leaf beside every level except the last
  assert.equal(rendered.length, (DEPTH + 1) + DEPTH);
  assert.equal(rendered[0], "n0");
  assert.ok(rendered.includes(`n${DEPTH}`), `the deepest node never rendered`);
  assert.ok(rendered.includes(`leaf${DEPTH - 1}`), `the deepest sibling never rendered`);
});

test("cyclic data stops at the depth floor instead of killing the surface", () => {
  const h = harness({
    Node: `<stack>
      <head>
        <attribute as="node"/>
        <variable as="kids" computed="true">
          const n = dsx.attribute.node
          return n == null || n.children == null ? [] : n.children
        </variable>
      </head>
      <text value="x"/>
      <list bind="kids" key="label">
        <Node node="{{ item }}"/>
      </list>
    </stack>`,
  });
  // A child list that contains its own parent — the corrupt-data case the floor is for.
  const cycle: { label: string; children: unknown[] } = { label: "loop", children: [] };
  cycle.children.push(cycle);
  h.store.set("tree", cycle);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
  try {
    h.mount(xml("Node", { node: "{{ dsx.variable.tree }}" }));
    flushEffects();
  } finally {
    console.warn = realWarn;
  }
  // Bounded, not crashed, and it says so rather than looking like missing data.
  assert.equal(texts(h.root).length, COMPONENT_DEPTH_CAP);
  assert.ok(
    warnings.some((w) => w.includes("component depth cap")),
    `no depth-cap warning; got ${JSON.stringify(warnings.slice(0, 3))}`,
  );
});

test("the depth floor is the number the corpus pins", () => {
  let dir = resolve(import.meta.dirname ?? ".");
  let file = "";
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/composition/attribute-binding.json");
    if (existsSync(candidate)) { file = candidate; break; }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("composition/attribute-binding.json not found");
    dir = parent;
  }
  const corpus = JSON.parse(readFileSync(file, "utf8")) as { recursion: { cap: number } };
  assert.equal(COMPONENT_DEPTH_CAP, corpus.recursion.cap);
});

// ── R5: a keyed row's item view is ONE object for the row's lifetime ─────────────────

test("a keyed row refreshes a binding inside a component, not only one written in the row", () => {
  const h = harness({
    Card: `<stack><slot/></stack>`,
  }, {
    rows: [{ id: "a1", mode: "web" }, { id: "a2", mode: "web" }],
  });
  // The decisive shape: the SAME expression written directly in the row and one component
  // deep. Before the fix the first read `native` and the second still read `web`.
  h.mount(xml("list", { bind: "dsx.variable.rows", key: "id" }, [
    xml("stack", {}, [
      xml("text", { value: "row:{{ item.mode }}" }),
      xml("Card", {}, [xml("text", { value: "card:{{ item.mode }}" })]),
    ]),
  ]));
  flushEffects();
  assert.deepEqual(texts(h.root), ["row:web", "card:web", "row:web", "card:web"]);

  // Same keys, new objects — a keyed row survives and its data changes underneath it.
  h.store.set("rows", [{ id: "a1", mode: "native" }, { id: "a2", mode: "native" }]);
  flushEffects();
  assert.deepEqual(texts(h.root), ["row:native", "card:native", "row:native", "card:native"]);
});

test("a keyed row's item reaches a component as a typed, live prop", () => {
  const h = harness({
    Row: `<stack>
      <head><attribute as="data"/></head>
      <text value="{{ typeof dsx.attribute.data }}:{{ dsx.attribute.data.mode }}"/>
    </stack>`,
  }, { rows: [{ id: "a1", mode: "web" }] });
  h.mount(xml("list", { bind: "dsx.variable.rows", key: "id" }, [
    xml("Row", { data: "{{ item }}" }),
  ]));
  flushEffects();
  assert.deepEqual(texts(h.root), ["object:web"]);
  h.store.set("rows", [{ id: "a1", mode: "native" }]);
  flushEffects();
  assert.deepEqual(texts(h.root), ["object:native"]);
});

test("a row's index stays live for a binding one component deep", () => {
  const h = harness({
    Card: `<stack><slot/></stack>`,
  }, { rows: [{ id: "a" }, { id: "b" }] });
  h.mount(xml("list", { bind: "dsx.variable.rows", key: "id" }, [
    xml("Card", {}, [xml("text", { value: "{{ item.id }}@{{ item.index }}" })]),
  ]));
  flushEffects();
  assert.deepEqual(texts(h.root), ["a@0", "b@1"]);
  // Reorder: both rows survive by key and both indexes move.
  h.store.set("rows", [{ id: "b" }, { id: "a" }]);
  flushEffects();
  assert.deepEqual(texts(h.root), ["b@0", "a@1"]);
});

// ── R6 continued: a prop stays live BELOW a `container` element ──────────────────────
//
// `container` publishes dsx.element.* to descendants by layering __element onto the
// local item — and ctx.item in a component body IS the instance's live attrs object.
// A `{ ...item }` spread there froze every attribute for the whole subtree: the stale
// copy answered dsx.attribute reads first, so the store fallback (which IS live) never
// fired. Found by Flow's fit staying at the pre-fetch extent while its slot content
// drew the fetched data. The child item must be a view over the live attrs, never a
// snapshot of them.

test("a reactive prop stays live below a container element", () => {
  if ((globalThis as { ResizeObserver?: unknown }).ResizeObserver === undefined) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  const h = harness({
    Fit: `<stack container="true">
      <head>
        <attribute as="size"/>
        <variable as="extent" computed="true">
          const n = Number(dsx.attribute.size)
          return n > 0 ? n : 1
        </variable>
      </head>
      <text value="E{{ extent }} A{{ dsx.attribute.size }}"/>
    </stack>`,
  }, { w: 0 });
  h.mount(xml("Fit", { size: "{{ w + 96 }}" }));
  flushEffects();
  assert.deepEqual(texts(h.root), ["E96 A96"]);
  h.store.set("w", 532);
  flushEffects();
  assert.deepEqual(texts(h.root), ["E628 A628"]);
});

// ── The instance store: a component instance OWNS its state ─────────────────────────
//
// The composition law (the native renderers port this file's behavior): a component
// instance mounts against a store born with it - head declarations register per
// instance, two instances hold independent state, and nothing a component declares
// leaks into the consumer's store. Slot content is the one deliberate exception: it is
// the CONSUMER's markup and binds in the consumer's scope and store.

function buttons(el: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement): void => {
    if (n.tagName === "BUTTON") out.push(n);
    for (let i = 0; i < n.childCount; i += 1) walk(n.childAt(i));
  };
  walk(el);
  return out;
}

test("two instances hold independent state; head declarations never reach the consumer store", async () => {
  const h = harness({
    Counter: `<stack>
      <head><variable as="n">return 0</variable></head>
      <button label="+" on:tap="n = n + 1"/>
      <text value="{{ n }}"/>
    </stack>`,
  });
  h.mount(xml("stack", {}, [xml("Counter"), xml("Counter")]));
  flushEffects();
  assert.deepEqual(texts(h.root), ["+", "0", "+", "0"]);
  const [first] = buttons(h.root);
  first!.click();
  await new Promise((r) => setImmediate(r));   // the action runner settles on a microtask
  first!.click();
  await new Promise((r) => setImmediate(r));
  flushEffects();
  assert.deepEqual(texts(h.root), ["+", "2", "+", "0"], "only the tapped instance counts");
  assert.equal(h.store.getPath("n"), null, "the instance variable never lands in the consumer store");
});

test("slot content binds in the consumer's store, inside an isolated instance", () => {
  const h = harness({
    Card: `<stack>
      <head><variable as="n">return 99</variable></head>
      <slot/>
    </stack>`,
  }, { n: 7 });
  h.mount(xml("Card", {}, [xml("text", { value: "{{ n }}" })]));
  flushEffects();
  assert.deepEqual(texts(h.root), ["7"], "slotted markup reads the caller's n, not the instance's");
});
