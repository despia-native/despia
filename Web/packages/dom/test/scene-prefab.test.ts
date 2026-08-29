//
//  scene-prefab.test.ts — components as prefabs inside <scene> subtrees (dsx-game.md
//  §2 G1). The NUMBERS are corpus-pinned (OpenSource/Conformance/scene/prefab.json,
//  scene-conformance.test.ts); this file asserts the DOM element's RUNTIME half: a
//  component tag expands through the EXISTING .dsx registry (resolveComponent — the
//  same resolution mountComponent uses), its body binds in a per-instance scope on the
//  live store (params re-resolve reactively, instances never share), and a `<group
//  bind key>` of prefab instances spawns/despawns rows through the standing P5
//  machinery. Under Node there is no WebGL — assertions read the G5 bus handle, whose
//  nodes() answers from the corpus-pinned kernel folds regardless of the renderer.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import type { XmlNode } from "@despia-native/compiler/xml";
import { ReactiveStore, ActionRunner, makeRunEnv, flushEffects, sceneSurfaceSeam, sceneBusResolve } from "@despia-native/kernel";
import type { Registry } from "@despia-native/compiler/resolve";
import { compileComponent } from "@despia-native/compiler/component";
import { scene } from "../src/scene.ts";
import type { ElementApi } from "../src/elements.ts";
import type { MountCtx } from "../src/mount.ts";

// ── the scene.test.ts DOM stand-in (each node --test file owns its process) ─────────

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  attrs = new Map<string, string>();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  appendChild(child: FakeElement): FakeElement { child.parent = this; this.children.push(child); return child; }
  remove(): void {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  addEventListener(): void {}
  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    return { width: 320, height: 180, left: 0, top: 0 };
  }
  getContext(): null { return null; }   // no WebGL in Node — the honest fallback path
}

(globalThis as Record<string, unknown>)["document"] = {
  createElement: (tag: string) => new FakeElement(tag),
};

function xml(tag: string, attrs: { [k: string]: string } = {}, children: XmlNode[] = []): XmlNode {
  return { tag, attrs, children, text: "" };
}

function stubApi(node: XmlNode): ElementApi {
  return {
    bindText(expr, apply) { if (expr !== undefined) apply(expr.includes("{{") ? "" : expr); },
    bindDisplay(expr, apply) { if (expr !== undefined) apply(expr.includes("{{") ? "" : expr); },
    bindValue() {},
    writeBack() {},
    handler() {},
    hasHandler(name) { return node.attrs[`on:${name}`] !== undefined; },
    children() {},
  };
}

/** the enemy prefab: a scene-content component with a declared, defaulted param */
function enemyRegistry(): Registry {
  const enemy = compileComponent("enemy", "t", `<sphere position="0 0.25 0" radius="{{ r }}">
  <head><attribute as="r" default="0.5"/></head>
</sphere>`);
  const card = compileComponent("card", "t", `<stack><text value="not scene content"/></stack>`);
  // a prefab whose BODY spawns rows — the staleness regression's shape
  const squad = compileComponent("squad", "t", `<group>
  <head><attribute as="tint" default="#dddddd"/></head>
  <group bind="dsx.variable.enemies" key="id"><box color="{{ tint }}"/></group>
</group>`);
  return {
    components: { "t.enemy": enemy, "t.card": card, "t.squad": squad },
    globalPool: { enemy: "t.enemy", card: "t.card", squad: "t.squad" },
    css: "", schemes: [],
  };
}

function mountScene(node: XmlNode): { store: ReactiveStore; dispose: () => void } {
  const store = new ReactiveStore();
  const env = makeRunEnv(store, { item: {}, emitEvent: () => {} });
  const runner = new ActionRunner(env);
  const ctx: MountCtx = {
    registry: enemyRegistry(), scheme: "t", owner: "Harness",
    store, runner, env, item: null, disposers: [],
    slots: null, rowBinding: null, formNamespace: null,
  };
  scene(node, ctx, stubApi(node));
  return { store, dispose: () => ctx.disposers.forEach((d) => d()) };
}

function freshSeam(): void {
  const seam = sceneSurfaceSeam();
  seam.order.length = 0;
  seam.surfaces.clear();
  seam.listeners.clear();
}

type BusNode = { kind: string; id: string; props: Record<string, string>; world: number[] | null; children: BusNode[] };

function busNodes(): BusNode[] {
  const handle = sceneBusResolve(null);
  assert.ok(handle !== null, "a scene is registered on the seam");
  return handle!.nodes() as BusNode[];
}

test("a component tag inside <scene> expands with scene-node semantics — per-instance params", () => {
  freshSeam();
  const mounted = mountScene(xml("scene", { id: "world" }, [
    xml("enemy", { id: "e1", position: "0 0 -5", r: "1.25" }),
    xml("enemy", { id: "e2" }),
  ]));
  const nodes = busNodes();
  assert.deepEqual(nodes.map((n) => [n.kind, n.id]), [["group", "e1"], ["group", "e2"]],
    "each instance expands to one implicit group carrying the instance id");
  assert.equal(nodes[0]!.props["position"], "0 0 -5", "the instance transform rides the group");
  assert.deepEqual(nodes[0]!.children.map((c) => c.kind), ["sphere"], "the body root is the child");
  assert.equal(nodes[0]!.children[0]!.props["radius"], "1.25", "e1's param fills its body hole");
  assert.equal(nodes[1]!.children[0]!.props["radius"], "0.5", "e2 falls to the declared default — no shared scope");
  assert.deepEqual(nodes[0]!.children[0]!.world, [0, 0.25, -5],
    "the world transform flows through the component boundary");
  mounted.dispose();
});

test("params re-resolve reactively at the instance site — one instance only", () => {
  freshSeam();
  const mounted = mountScene(xml("scene", {}, [
    xml("enemy", { id: "e1", r: "{{ dsx.variable.grow }}" }),
    xml("enemy", { id: "e2" }),
  ]));
  mounted.store.set("grow", 2);
  flushEffects();
  let nodes = busNodes();
  assert.equal(nodes[0]!.children[0]!.props["radius"], "2", "the bound param resolves in the OUTER scope");
  assert.equal(nodes[1]!.children[0]!.props["radius"], "0.5", "the sibling instance is untouched");
  mounted.store.set("grow", 3);
  flushEffects();
  nodes = busNodes();
  assert.equal(nodes[0]!.children[0]!.props["radius"], "3", "a store write re-resolves the instance scope");
  mounted.dispose();
});

test("keyed rows of prefab instances spawn and despawn through the bound group", () => {
  freshSeam();
  const mounted = mountScene(xml("scene", {}, [
    xml("group", { id: "wave", bind: "dsx.variable.enemies", key: "id" }, [
      xml("enemy", { r: "{{ item.r }}" }),
    ]),
  ]));
  mounted.store.set("enemies", [{ id: "a", r: 0.4 }, { id: "b", r: 1.25 }]);
  flushEffects();
  let wave = busNodes().find((n) => n.id === "wave")!;
  assert.equal(wave.children.length, 2, "two rows instantiate two prefab instances");
  assert.deepEqual(wave.children.map((c) => c.children[0]!.props["radius"]), ["0.4", "1.25"],
    "each row's param resolves in ITS row scope");
  mounted.store.set("enemies", [{ id: "b", r: 1.25 }]);
  flushEffects();
  wave = busNodes().find((n) => n.id === "wave")!;
  assert.equal(wave.children.length, 1, "the removed row despawns its prefab instance");
  assert.equal(wave.children[0]!.children[0]!.props["radius"], "1.25", "the retained key keeps its subtree");
  mounted.dispose();
});

test("a component whose body is not scene content skips with the Article-7 diagnostic", () => {
  freshSeam();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    mountScene(xml("scene", {}, [xml("box", {}), xml("card", {})]));
    const nodes = busNodes();
    assert.deepEqual(nodes.map((n) => n.kind), ["box"], "the non-scene component never becomes a node");
    assert.ok(warnings.some((w) => w.includes("not scene content")), "the prefab-not-scene diagnostic is spoken");
  } finally {
    console.warn = originalWarn;
  }
});

test("a live instance param reaches ALREADY-SPAWNED rows — no stale scope in bound groups", () => {
  freshSeam();
  const mounted = mountScene(xml("scene", {}, [
    xml("squad", { id: "s", tint: "{{ dsx.variable.theme }}" }),
  ]));
  mounted.store.set("theme", "#ff2200");
  mounted.store.set("enemies", [{ id: "a" }, { id: "b" }]);
  flushEffects();
  const wave = (): BusNode => busNodes()[0]!.children[0]!.children[0]!;
  assert.equal(wave().children.length, 2, "two rows spawn inside the prefab body");
  assert.deepEqual(wave().children.map((c) => c.props["color"]), ["#ff2200", "#ff2200"],
    "spawned rows read the instance param at spawn");
  // the review's divergence: a scope-only change (same rows) must restamp the rows —
  // without the parent-refresh chain the boxes keep the color they were born with
  mounted.store.set("theme", "#00ff88");
  flushEffects();
  assert.deepEqual(wave().children.map((c) => c.props["color"]), ["#00ff88", "#00ff88"],
    "a live scope change reaches every already-spawned row");
  mounted.dispose();
});
