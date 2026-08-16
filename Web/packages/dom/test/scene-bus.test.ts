//
//  scene-bus.test.ts — the `scene` bus surface (dsx-game.md §2 G5): a mounted <scene>
//  element registers a handle into the kernel SceneRegistry seam, and the Core/Scene
//  module's web facet drives it through the MODULE CALL PATH. Under Node there is no
//  WebGL, so capture answers the typed capture_failed — the honest fallback — while
//  nodes/set/camera/pick/contacts/stats all answer from the corpus-pinned kernel folds.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import type { XmlNode } from "@despia/compiler/xml";
import { sceneSurfaceSeam, sceneBusResolve, sceneBusEmit } from "@despia/kernel";
import { scene } from "../src/scene.ts";
import type { ElementApi } from "../src/elements.ts";
import type { MountCtx } from "../src/mount.ts";
import sceneFacet from "../../../../../ClosedSource/DSX/Modules/Core/Scene/web/index.js";

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
    bindValue() {},
    writeBack() {},
    handler() {},
    hasHandler(name) { return node.attrs[`on:${name}`] !== undefined; },
    children() {},
  };
}

type Failure = { code: string; message: string; recoverable: boolean };

function callCtx(values: Record<string, unknown> = {}): {
  ctx: { args(name: string): unknown; fail(code: string, message: string, recoverable: boolean, data?: unknown): void };
  failures: Failure[];
} {
  const failures: Failure[] = [];
  return {
    ctx: {
      args: (name) => values[name] ?? null,
      fail: (code, message, recoverable) => failures.push({ code, message, recoverable }),
    },
    failures,
  };
}

function mountScene(node: XmlNode): { host: FakeElement; dispose: () => void } {
  const disposers: Array<() => void> = [];
  const ctx = { disposers } as unknown as MountCtx;
  const host = scene(node, ctx, stubApi(node)) as unknown as FakeElement;
  return { host, dispose: () => disposers.forEach((d) => d()) };
}

function freshSeam(): void {
  const seam = sceneSurfaceSeam();
  seam.order.length = 0;
  seam.surfaces.clear();
  seam.listeners.clear();
}

const RIG = xml("scene", { id: "world", background: "#0b1020" }, [
  xml("camera", { position: "0 0 5", "look-at": "0 0 0" }),
  xml("light", { kind: "ambient", intensity: "0.5" }),
  xml("group", { id: "rig" }, [
    xml("box", { id: "crate", position: "-1 0 0", color: "#2563eb", collide: "box" }),
    xml("sphere", { id: "ball", position: "0 0 0", radius: "0.5", collide: "sphere" }),
  ]),
]);

test("a mounted scene registers into the seam under its id and unregisters on dispose", () => {
  freshSeam();
  const mounted = mountScene(RIG);
  assert.ok(sceneBusResolve("world") !== null, "the id attr is the registry key");
  assert.equal(sceneBusResolve(null), sceneBusResolve("world"), "the only scene is the default target");
  mounted.dispose();
  assert.equal(sceneBusResolve("world"), null, "unmount unregisters");
  assert.equal(sceneBusResolve(null), null);
});

test("scene.nodes answers the resolved tree through the module face", () => {
  freshSeam();
  const mounted = mountScene(RIG);
  const call = callCtx();
  const result = sceneFacet.actions.nodes(call.ctx) as { nodes: Array<{ kind: string; id: string; children: unknown[] }> };
  assert.deepEqual(call.failures, []);
  const kinds = result.nodes.map((n) => n.kind);
  assert.deepEqual(kinds, ["camera", "light", "group"]);
  const group = result.nodes[2]! as { kind: string; id: string; world: number[] | null; children: Array<{ id: string; kind: string; props: Record<string, string>; world: number[] | null }> };
  assert.equal(group.id, "rig");
  assert.deepEqual(group.children.map((c) => c.id), ["crate", "ball"]);
  assert.equal(group.children[0]!.props["position"], "-1 0 0");
  assert.equal(group.children[0]!.props["color"], "#2563eb");
  assert.deepEqual(group.children[0]!.world, [-1, 0, 0], "world position from the corpus fold");
  const one = sceneFacet.actions.nodes(callCtx({ id: "ball" }).ctx) as { nodes: Array<{ id: string }> };
  assert.equal(one.nodes.length, 1);
  assert.equal(one.nodes[0]!.id, "ball");
  const missing = callCtx({ id: "ghost" });
  sceneFacet.actions.nodes(missing.ctx);
  assert.equal(missing.failures[0]?.code, "node_not_found");
  mounted.dispose();
});

test("scene.set writes the resolved-attribute base plane; handlers refuse; unknown ids refuse", () => {
  freshSeam();
  const mounted = mountScene(RIG);
  const ok = callCtx({ id: "ball", attr: "position", value: "0 2 0" });
  assert.deepEqual(sceneFacet.actions.set(ok.ctx), { ok: true });
  assert.deepEqual(ok.failures, []);
  const tree = (sceneFacet.actions.nodes(callCtx({ id: "ball" }).ctx) as { nodes: Array<{ props: Record<string, string>; world: number[] | null }> }).nodes[0]!;
  assert.equal(tree.props["position"], "0 2 0", "the write is visible on the resolved plane");
  assert.deepEqual(tree.world, [0, 2, 0], "the world fold sees the write");
  const bad = callCtx({ id: "ball", attr: "on:tap", value: "x()" });
  sceneFacet.actions.set(bad.ctx);
  assert.equal(bad.failures[0]?.code, "bad_attr");
  const ghost = callCtx({ id: "ghost", attr: "color", value: "#fff" });
  sceneFacet.actions.set(ghost.ctx);
  assert.equal(ghost.failures[0]?.code, "node_not_found");
  mounted.dispose();
});

test("scene.camera reads, writes, and refuses a malformed flyTo", () => {
  freshSeam();
  const mounted = mountScene(RIG);
  const read = sceneFacet.actions.camera(callCtx().ctx) as { position: string; lookAt: string; fov: number; authored: boolean };
  assert.equal(read.position, "0 0 5");
  assert.equal(read.lookAt, "0 0 0");
  assert.equal(read.fov, 60);
  assert.equal(read.authored, true);
  const moved = sceneFacet.actions.camera(callCtx({ position: "0 1 8" }).ctx) as { position: string };
  assert.equal(moved.position, "0 1 8", "an immediate position write answers the new camera");
  const bad = callCtx({ flyTo: "not a triple" });
  sceneFacet.actions.camera(bad.ctx);
  assert.equal(bad.failures[0]?.code, "bad_value");
  // flyTo seeds the P5 transition plane: the BASE holds the destination immediately
  // (the glide is the render plane's business; Node has no rAF loop to advance it)
  const fly = callCtx({ flyTo: "0 0 12", durationMs: 200 });
  sceneFacet.actions.camera(fly.ctx);
  assert.deepEqual(fly.failures, []);
  mounted.dispose();
});

test("scene.pick answers the tap math without firing handlers; bad points refuse", () => {
  freshSeam();
  const mounted = mountScene(RIG);
  // the ball sits at the origin, camera at 0 0 5 looking at it — dead center hits it
  const hit = sceneFacet.actions.pick(callCtx({ x: 0.5, y: 0.5 }).ctx) as { hit: boolean; id?: string; kind?: string };
  assert.equal(hit.hit, true);
  assert.equal(hit.id, "ball");
  assert.equal(hit.kind, "sphere");
  const missAnswer = sceneFacet.actions.pick(callCtx({ x: 0.02, y: 0.02 }).ctx) as { hit: boolean };
  assert.equal(missAnswer.hit, false, "a corner tap hits nothing");
  const bad = callCtx({ x: 2, y: 0.5 });
  sceneFacet.actions.pick(bad.ctx);
  assert.equal(bad.failures[0]?.code, "bad_point");
  mounted.dispose();
});

test("scene.contacts reads the currently overlapping collider pairs", () => {
  freshSeam();
  const mounted = mountScene(RIG);
  const apart = sceneFacet.actions.contacts(callCtx().ctx) as { contacts: unknown[] };
  assert.deepEqual(apart.contacts, [], "crate at -1 and ball at 0 do not overlap");
  sceneFacet.actions.set(callCtx({ id: "crate", attr: "position", value: "0 0 0" }).ctx);
  const touching = sceneFacet.actions.contacts(callCtx().ctx) as { contacts: Array<{ a: string; b: string; depth: number }> };
  assert.equal(touching.contacts.length, 1);
  assert.deepEqual([touching.contacts[0]!.a, touching.contacts[0]!.b], ["crate", "ball"]);
  assert.ok(touching.contacts[0]!.depth > 0);
  mounted.dispose();
});

test("scene.stats answers the honest v0 profiler counters", () => {
  freshSeam();
  const mounted = mountScene(RIG);
  const stats = sceneFacet.actions.stats(callCtx().ctx) as { nodes: number; animations: number; lastFrameDt: number; boundRows: number };
  assert.equal(stats.nodes, 5, "camera + light + group + box + sphere");
  assert.equal(stats.animations, 0);
  assert.equal(stats.lastFrameDt, 0);
  assert.equal(stats.boundRows, 0);
  mounted.dispose();
});

test("capture without a live renderer settles the typed capture_failed", () => {
  freshSeam();
  const mounted = mountScene(RIG);
  const call = callCtx();
  sceneFacet.actions.capture(call.ctx);
  assert.equal(call.failures[0]?.code, "capture_failed");
  assert.equal(call.failures[0]?.recoverable, true);
  mounted.dispose();
});

test("scene targeting: named scenes resolve, unknown targets settle scene_not_found", () => {
  freshSeam();
  const first = mountScene(RIG);
  const second = mountScene(xml("scene", { id: "hud" }, [xml("box", { id: "panel" })]));
  const named = sceneFacet.actions.stats(callCtx({ scene: "hud" }).ctx) as { nodes: number };
  assert.equal(named.nodes, 1);
  const fallback = sceneFacet.actions.stats(callCtx().ctx) as { nodes: number };
  assert.equal(fallback.nodes, 5, "no target = the FIRST mounted scene");
  const missing = callCtx({ scene: "nowhere" });
  sceneFacet.actions.stats(missing.ctx);
  assert.equal(missing.failures[0]?.code, "scene_not_found");
  second.dispose();
  first.dispose();
  const none = callCtx();
  sceneFacet.actions.stats(none.ctx);
  assert.equal(none.failures[0]?.code, "scene_not_found");
});

// ── G2 physics through the module face (dsx-game.md §2 G2): the write laws land on
// the solver via the SAME bus set action — never a second mutation path. Stepping
// itself is corpus-pinned (physics.json) and walk-verified; under Node there is no
// rAF loop, so these tests pin the write/read plumbing.

const PHYSICS_RIG = xml("scene", { id: "game", gravity: "0 -9.81 0" }, [
  xml("box", { id: "ground", physics: "static", position: "0 -0.5 0", size: "20 1 20" }),
  xml("sphere", { id: "ball", physics: "dynamic", position: "0 3 0", radius: "0.5" }),
  xml("box", { id: "hero", physics: "character", position: "2 0.9 2", size: "0.8 1.8 0.8", speed: "6" }),
]);

test("physics bodies expose solver state on the bus read (grounded/sleeping/velocity)", () => {
  freshSeam();
  const mounted = mountScene(PHYSICS_RIG);
  const tree = sceneFacet.actions.nodes(callCtx().ctx) as {
    nodes: Array<{ id: string; props: Record<string, string> }>;
  };
  const ball = tree.nodes.find((n) => n.id === "ball");
  assert.ok(ball !== undefined, "the dynamic body is on the read");
  assert.equal(ball!.props["grounded"], "false");
  assert.equal(ball!.props["sleeping"], "false");
  assert.equal(ball!.props["velocity"], "0 0 0");
  const ground = tree.nodes.find((n) => n.id === "ground");
  assert.equal(ground!.props["sleeping"], "false", "static bodies read too");
  mounted.dispose();
});

test("character intent and the impulse verb ride the bus set action (the G2 write laws)", () => {
  freshSeam();
  const mounted = mountScene(PHYSICS_RIG);
  // the move intent is attribute-shaped state: set writes the base plane the solver
  // reads each fixed step
  assert.deepEqual(sceneFacet.actions.set(callCtx({ id: "hero", attr: "move", value: "1 0" }).ctx), { ok: true });
  const hero = (sceneFacet.actions.nodes(callCtx({ id: "hero" }).ctx) as {
    nodes: Array<{ props: Record<string, string> }>;
  }).nodes[0]!;
  assert.equal(hero.props["move"], "1 0", "the intent landed on the resolved plane");
  // jump() IS a velocity write through the same set action (the impulse verb)
  assert.deepEqual(sceneFacet.actions.set(callCtx({ id: "hero", attr: "velocity", value: "0 8 0" }).ctx), { ok: true });
  const jumped = (sceneFacet.actions.nodes(callCtx({ id: "hero" }).ctx) as {
    nodes: Array<{ props: Record<string, string> }>;
  }).nodes[0]!;
  assert.equal(jumped.props["velocity"], "0 8 0", "the velocity write reached the solver body");
  // THE TELEPORT LAW: a dynamic body's position write moves it and RESETS velocity
  sceneFacet.actions.set(callCtx({ id: "ball", attr: "velocity", value: "1 2 3" }).ctx);
  sceneFacet.actions.set(callCtx({ id: "ball", attr: "position", value: "0 5 0" }).ctx);
  const ball = (sceneFacet.actions.nodes(callCtx({ id: "ball" }).ctx) as {
    nodes: Array<{ props: Record<string, string>; world: number[] | null }>;
  }).nodes[0]!;
  assert.equal(ball.props["velocity"], "0 0 0", "teleport reset the velocity");
  assert.deepEqual(ball.world, [0, 5, 0], "teleport moved the body (the override plane shows it)");
  mounted.dispose();
});

test("angular physics writes ride the bus and rotation lands on the render override plane", () => {
  freshSeam();
  const mounted = mountScene(PHYSICS_RIG);
  assert.deepEqual(
    sceneFacet.actions.set(callCtx({ id: "ball", attr: "rotation", value: "0 45 0" }).ctx),
    { ok: true },
  );
  sceneFacet.actions.set(callCtx({ id: "ball", attr: "angular-velocity", value: "0 3 0" }).ctx);
  sceneFacet.actions.set(callCtx({ id: "ball", attr: "torque", value: "0 2 0" }).ctx);
  let ball = (sceneFacet.actions.nodes(callCtx({ id: "ball" }).ctx) as {
    nodes: Array<{ props: Record<string, string> }>;
  }).nodes[0]!;
  assert.equal(ball.props["rotation"], "0 45 0", "rotation teleport is visible on the override plane");
  assert.equal(ball.props["angular-velocity"], "0 3 0", "angular velocity reached solver state");
  assert.equal(ball.props["torque"], "0 2 0", "persistent torque reached solver state");

  // A rotation teleport clears hidden spin, matching position teleport's no-glide law.
  sceneFacet.actions.set(callCtx({ id: "ball", attr: "rotation", value: "0 90 0" }).ctx);
  ball = (sceneFacet.actions.nodes(callCtx({ id: "ball" }).ctx) as {
    nodes: Array<{ props: Record<string, string> }>;
  }).nodes[0]!;
  assert.equal(ball.props["rotation"], "0 90 0");
  assert.equal(ball.props["angular-velocity"], "0 0 0", "rotation teleport reset angular velocity");
  mounted.dispose();
});

test("nested physics writes map local poses to root and rebuild without losing solver rotation", () => {
  freshSeam();
  const rig = xml("scene", { id: "nested" }, [
    xml("group", { id: "parent", position: "3 2 0", rotation: "0 0 20", scale: "2 1 1" }, [
      xml("box", { id: "child", physics: "dynamic", position: "1 0 0", rotation: "0 0 45", size: "2 1 1" }),
    ]),
  ]);
  const mounted = mountScene(rig);
  const child = (): { props: Record<string, string>; world: number[] | null } => {
    const tree = sceneFacet.actions.nodes(callCtx({ scene: "nested" }).ctx) as {
      nodes: Array<{ children: Array<{ props: Record<string, string>; world: number[] | null }> }>;
    };
    return tree.nodes[0]!.children[0]!;
  };
  let read = child();
  assert.equal(read.props["rotation"], "0 0 46.565051177078", "extraction exposes the root solver orientation");
  assert.deepEqual(read.world, [4.879385241571817, 2.6840402866513373, 0]);

  sceneFacet.actions.set(callCtx({ scene: "nested", id: "child", attr: "position", value: "2 0 0" }).ctx);
  sceneFacet.actions.set(callCtx({ scene: "nested", id: "child", attr: "rotation", value: "0 0 60" }).ctx);
  read = child();
  assert.deepEqual(read.world, [6.758770483143634, 3.3680805733026746, 0], "local teleport lifts through parent world");
  assert.equal(read.props["rotation"], "0 0 60.8933946491309", "local rotation composes into the root OBB frame");

  // Body-shaping writes rebuild extraction. The adapter must carry both public Euler
  // and the solver quaternion; this read catches a visible pose regression while the
  // subsequent kernel parity lane pins quaternion/contact continuity.
  sceneFacet.actions.set(callCtx({ scene: "nested", id: "child", attr: "mass", value: "2" }).ctx);
  read = child();
  assert.deepEqual(read.world, [6.758770483143634, 3.3680805733026746, 0]);
  assert.equal(read.props["rotation"], "0 0 60.8933946491309");
  mounted.dispose();
});

test("the seam's event door reaches the facet's boot subscription", () => {
  freshSeam();
  const events: Array<{ plane: string; kind: string; payload: unknown }> = [];
  sceneFacet.boot({
    delegate: { send: (event: string, payload: unknown) => events.push({ plane: "delegate", kind: event, payload }) },
    events: { publish: (name: string, payload: unknown) => events.push({ plane: "channel", kind: name, payload }) },
  } as never);
  sceneBusEmit("world", "ready", { scene: "world" });
  sceneBusEmit("world", "collide", { scene: "world", id: "a", other: "b", depth: 0.1 });
  sceneBusEmit("world", "internal", { scene: "world" });   // not a bus event — ignored
  assert.deepEqual(events.map((e) => `${e.plane}:${e.kind}`), [
    "delegate:scene.ready", "channel:scene:ready",
    "delegate:scene.collide", "channel:scene:collide",
  ]);
});
