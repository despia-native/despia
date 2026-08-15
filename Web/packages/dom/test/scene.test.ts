//
//  scene.test.ts — the web <scene> element's DOM contract (dsx-scene.md P1 + P4). The
//  NUMBERS are corpus-pinned in @despia/kernel (scene-conformance.test.ts); under Node
//  there is no WebGL, so these tests assert the structure the element must guarantee
//  anyway: the .dsx-scene box, the honest WebGL fallback, the scheduled-row
//  placeholder (P3 only since P4 landed: mode="ar" + <anchor> — never blank, never
//  fake; model/text3d render for real), the geometry/UV builders, and the byte-level
//  SSR twin (the sized box, no DOM children for scene nodes).
//

import { test } from "node:test";
import assert from "node:assert/strict";

import type { XmlNode } from "@despia/compiler/xml";
import type { Registry } from "@despia/compiler/resolve";
import { compileComponent } from "@despia/compiler/component";
import { renderToString } from "../../server/src/render.ts";
import { scene, registerSceneSurface, SCENE_CSS, SCENE_SCHEDULED_KINDS, buildBoxGeometry, buildSphereGeometry, buildPlaneGeometry, modelPrimitiveGeometry, sceneIndexArray } from "../src/scene.ts";
import { ELEMENTS, type ElementApi } from "../src/elements.ts";
import type { MountCtx } from "../src/mount.ts";

// ── a minimal DOM stand-in (each node --test file owns its process) ─────────────────

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  attrs = new Map<string, string>();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  appendChild(child: FakeElement): FakeElement { child.parent = this; this.children.push(child); return child; }
  remove(): void {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  addEventListener(name: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    return { width: 320, height: 180, left: 0, top: 0 };
  }
  /** canvas in Node: no WebGL — getContext exists and answers null (the honest path) */
  getContext(): null { return null; }
  find(cls: string): FakeElement | null {
    if (this.className.split(/\s+/).includes(cls)) return this;
    for (const child of this.children) {
      const hit = child.find(cls);
      if (hit !== null) return hit;
    }
    return null;
  }
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

function mountScene(node: XmlNode): FakeElement {
  const ctx = { disposers: [] as Array<() => void> } as unknown as MountCtx;
  return scene(node, ctx, stubApi(node)) as unknown as FakeElement;
}

test("registerSceneSurface installs the boot-only factory (embeds never import it)", () => {
  assert.equal(ELEMENTS["scene"], undefined, "the base table stays scene-free for sliced embeds");
  registerSceneSurface();
  assert.equal(ELEMENTS["scene"], scene);
  delete ELEMENTS["scene"];
});

test("no WebGL: the sized box stays, labelled honestly — never blank, never a crash", () => {
  const host = mountScene(xml("scene", { background: "#0b1020" }, [
    xml("camera", { position: "0 1.5 4" }),
    xml("box", { color: "#2563eb" }),
  ]));
  assert.equal(host.className, "dsx-scene");
  assert.equal(host.getAttribute("role"), "img");
  assert.equal(host.getAttribute("aria-label"), "3D scene");
  assert.equal(host.getAttribute("data-dsx-component"), "scene");
  const fallback = host.find("dsx-scene-fallback");
  assert.ok(fallback !== null, "the WebGL-unavailable note renders inside the box");
  assert.match(fallback.textContent, /WebGL is unavailable/);
  assert.equal(host.find("dsx-scene-canvas"), null, "a dead canvas is removed, not left blank");
});

test("P3 rows still render the honest placeholder; model/text3d left it (P4 landed)", () => {
  const host = mountScene(xml("scene", { mode: "ar" }, [
    xml("model", { src: "widget.glb" }),
    xml("text3d", { value: "hi" }),
    xml("anchor", { kind: "plane" }),
  ]));
  const note = host.find("dsx-scene-scheduled");
  assert.ok(note !== null, "the scheduled note exists");
  assert.match(note.textContent, /mode="ar" \(P3\)/);
  assert.match(note.textContent, /<anchor> \(P3\)/);
  assert.match(note.textContent, /dsx-scene\.md/);
  assert.ok(!note.textContent.includes("<model>"), "model renders for real — no placeholder");
  assert.ok(!note.textContent.includes("<text3d>"), "text3d renders for real — no placeholder");
  assert.ok(SCENE_SCHEDULED_KINDS.has("anchor"));
  for (const kind of ["model", "text3d"]) assert.ok(!SCENE_SCHEDULED_KINDS.has(kind), `${kind} is no longer scheduled`);
});

test("a plain 3d scene shows no scheduled note — and neither do model/text3d alone", () => {
  const host = mountScene(xml("scene", {}, [xml("box", {}), xml("sphere", {})]));
  assert.equal(host.find("dsx-scene-scheduled"), null);
  const p4 = mountScene(xml("scene", {}, [xml("model", { src: "w.glb" }), xml("text3d", { value: "hi" })]));
  assert.equal(p4.find("dsx-scene-scheduled"), null);
});

test("geometry builders emit consistent flat-shaded meshes with UVs (the P4 UV law)", () => {
  for (const geometry of [buildBoxGeometry(), buildSphereGeometry(), buildPlaneGeometry()]) {
    assert.equal(geometry.positions.length, geometry.normals.length);
    assert.equal(geometry.positions.length % 3, 0);
    assert.equal(geometry.indices.length % 3, 0, "triangles");
    const vertexCount = geometry.positions.length / 3;
    assert.equal(geometry.uvs.length, vertexCount * 2, "one UV pair per vertex");
    for (const uv of geometry.uvs) assert.ok(uv >= 0 && uv <= 1, "UVs normalized");
    for (const index of geometry.indices) assert.ok(index < vertexCount, "indices in range");
  }
  assert.equal(buildBoxGeometry().indices.length, 36);
  assert.equal(buildPlaneGeometry().indices.length, 6);
  // the plane UV law verbatim: u = x_face + 0.5, v = 0.5 − y_face
  const plane = buildPlaneGeometry();
  assert.deepEqual([...plane.uvs], [0, 1, 1, 1, 1, 0, 0, 0]);
});

test("modelPrimitiveGeometry: authored normals pass through, absent normals flat-shade", () => {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const withNormals = modelPrimitiveGeometry(positions, [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]);
  assert.deepEqual([...withNormals.indices], [0, 1, 2]);
  assert.deepEqual([...withNormals.normals], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const flat = modelPrimitiveGeometry(positions, [], [0, 1, 2]);
  assert.equal(flat.positions.length, 9, "de-indexed soup keeps the triangle");
  assert.deepEqual([...flat.normals], [0, 0, 1, 0, 0, 1, 0, 0, 1], "computed face normal is +Z");
});

test("index buffers widen to u32 when a GLB exceeds 64k vertices — never wrap mod 65536", () => {
  // the kernel parser accepts componentType 5125 (u32) indices; a u16 buffer would
  // silently wrap them, corrupting large models on web only (JVM/iOS use 32-bit)
  assert.ok(sceneIndexArray([0, 1, 65535]) instanceof Uint16Array, "small meshes stay u16");
  const wide = sceneIndexArray([0, 1, 65536]);
  assert.ok(wide instanceof Uint32Array, "an index past 65535 widens the buffer");
  assert.deepEqual([...wide], [0, 1, 65536], "the value survives — no wrap");
  // the de-index path is where a big non-normaled mesh grows its own indices
  const positions = new Array(3 * 3).fill(0).map((_, i) => i);
  const soup = modelPrimitiveGeometry(positions, [], [0, 1, 2]);
  assert.ok(soup.indices instanceof Uint16Array, "a small soup stays u16");
});

test("the scene sheet carries the box, canvas, fallback and scheduled classes", () => {
  for (const cls of [".dsx-scene", ".dsx-scene-canvas", ".dsx-scene-fallback", ".dsx-scene-scheduled"]) {
    assert.ok(SCENE_CSS.includes(cls), `${cls} styled`);
  }
  assert.match(SCENE_CSS, /aspect-ratio/);
});

// ── the SSR twin: the sized box only; scene nodes never become DOM children ─────────

test("SSR renders the sized .dsx-scene box with no scene-node children", () => {
  const ir = compileComponent("Probe", "t",
    '<scene background="#0b1020" a11yLabel="Demo scene">'
    + '<camera position="0 1.5 4"/><light kind="directional" position="3 5 2"/>'
    + '<group id="rig"><box color="#2563eb"/><sphere radius="0.5"/></group>'
    + "</scene>");
  const registry: Registry = { components: { "t.Probe": ir }, globalPool: {}, css: "", schemes: ["t"] };
  const html = renderToString(registry, "t.Probe");
  assert.match(html, /class="dsx-scene"/);
  assert.match(html, /aria-label="Demo scene"/);
  assert.match(html, /role="img"/);
  assert.ok(!html.includes("dsx-unsupported"), "scene nodes never degrade to the unsupported placeholder");
  assert.ok(!html.includes("<box"), "scene-space children stay out of the DOM");
  assert.match(html, /<div [^>]*data-dsx-component="scene"[^>]*><\/div>/);
});

test("P5: <animate> is a scene word — no scheduled placeholder, no unknown-tag skip", () => {
  const host = mountScene(xml("scene", {}, [
    xml("box", { color: "#2563eb" }, [
      xml("animate", { target: "rotation", from: "0 0 0", to: "0 360 0", duration: "2s", loop: "true" }),
    ]),
  ]));
  assert.equal(host.find("dsx-scene-scheduled"), null, "animate never shows a scheduled note");
  assert.ok(!SCENE_SCHEDULED_KINDS.has("animate"));
});
