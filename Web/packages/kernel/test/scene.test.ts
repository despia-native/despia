//
//  scene.test.ts - focused edge cases for the scene kernel beyond the shared corpus
//  (scene-conformance.test.ts): Article-7 fallbacks with the diagnostic callback,
//  hole interpolation corners, the picking primitives, and color parsing.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseScene, interpolateSceneHoles, resolvedProps, worldMatrices, sceneCamera, sceneLighting,
  parseSceneColor, nodeBoundingRadius, worldBoundingSphere, pickRay, raySphere,
  mat4Invert, mat4Identity, mat4Multiply, mat4Translation, projectToNdc,
  type SceneDiagnostic, type SceneNode, type SceneResolve,
} from "../src/index.ts";

const passthrough: SceneResolve = (_n, _a, raw) => raw;

function node(kind: SceneNode["kind"], attrs: { [k: string]: string } = {}, children: SceneNode[] = []): SceneNode {
  return { kind, id: attrs["id"] ?? null, attrs, children };
}

test("malformed vectors and scalars fall back with one diagnostic each — never a throw", () => {
  const diagnostics: SceneDiagnostic[] = [];
  const diag = (d: SceneDiagnostic): void => { diagnostics.push(d); };
  const props = resolvedProps(
    node("box", { position: "not numbers", rotation: "1 2 3 4", size: "", scale: "0.5 0.5 0.5" }),
    passthrough, diag,
  );
  assert.deepEqual(props.position, [0, 0, 0]);
  assert.deepEqual(props.rotation, [0, 0, 0]);   // 4 components is malformed, whole triple falls back
  assert.deepEqual(props.boxSize, [1, 1, 1]);    // empty resolves to the default
  assert.deepEqual(props.scale, [0.5, 0.5, 0.5]);
  assert.equal(diagnostics.length, 3);
  assert.ok(diagnostics.every((d) => d.code === "malformed-vector"));
});

test("Infinity and NaN spellings are malformed numbers", () => {
  const diagnostics: SceneDiagnostic[] = [];
  const props = resolvedProps(
    node("sphere", { radius: "Infinity", position: "0 NaN 0" }),
    passthrough, (d) => diagnostics.push(d),
  );
  assert.equal(props.radius, 1);
  assert.deepEqual(props.position, [0, 0, 0]);
  assert.equal(diagnostics.length, 2);
});

test("hole interpolation: null/undefined resolve to empty, mixed text survives", () => {
  assert.equal(interpolateSceneHoles("0 {{ y }} 0", () => 1.5), "0 1.5 0");
  assert.equal(interpolateSceneHoles("{{ a }} {{ b }}", (e) => (e === "a" ? 1 : null)), "1 ");
  assert.equal(interpolateSceneHoles("no holes", () => { throw new Error("never called"); }), "no holes");
});

test("an unresolved hole (empty substitution) is a malformed vector, not a crash", () => {
  const diagnostics: SceneDiagnostic[] = [];
  const resolve: SceneResolve = (_n, _a, raw) => interpolateSceneHoles(raw, () => null);
  const props = resolvedProps(node("box", { position: "0 {{ missing }} 0" }), resolve, (d) => diagnostics.push(d));
  assert.deepEqual(props.position, [0, 0, 0]);
  assert.equal(diagnostics.length, 1);
});

test("parseScene: unknown mode falls back to 3d with a diagnostic", () => {
  const diagnostics: SceneDiagnostic[] = [];
  const ir = parseScene({ tag: "scene", attrs: { mode: "vr" }, children: [] }, (d) => diagnostics.push(d));
  assert.equal(ir.mode, "3d");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.code, "unknown-mode");
});

test("sceneCamera: no authored camera uses every default; bad aspect fails safe to 1", () => {
  const ir = parseScene({ tag: "scene", attrs: {}, children: [] });
  const a = sceneCamera(ir, passthrough, NaN);
  const b = sceneCamera(ir, passthrough, 1);
  assert.deepEqual(a.proj, b.proj);
  assert.deepEqual(a.eye, [0, 0, 5]);
  // the default camera puts the origin on the view axis
  const ndc = projectToNdc(a.proj, a.view, [0, 0, 0]);
  assert.ok(Math.abs(ndc[0]) < 1e-12 && Math.abs(ndc[1]) < 1e-12);
});

test("sceneLighting: unlit scenes get full ambient; first directional wins; zero direction fails safe", () => {
  const unlit = parseScene({ tag: "scene", attrs: {}, children: [] });
  assert.equal(sceneLighting(unlit, passthrough).ambientIntensity, 1);
  const lit = parseScene({
    tag: "scene", attrs: {}, children: [
      { tag: "light", attrs: { kind: "directional", position: "0 0 0" }, children: [] },
      { tag: "light", attrs: { kind: "directional", position: "1 0 0", intensity: "0.5" }, children: [] },
    ],
  });
  const lighting = sceneLighting(lit, passthrough);
  assert.deepEqual(lighting.direction, [0, 1, 0]); // zero-length position falls back to straight down
  assert.equal(lighting.ambientIntensity, 0);
});

test("parseSceneColor: #rgb and #rrggbb parse, junk returns null", () => {
  assert.deepEqual(parseSceneColor("#ffffff"), [1, 1, 1]);
  assert.deepEqual(parseSceneColor("#f00"), [1, 0, 0]);
  const blue = parseSceneColor("#2563eb")!;
  assert.ok(Math.abs(blue[0] - 0x25 / 255) < 1e-12 && Math.abs(blue[2] - 0xeb / 255) < 1e-12);
  assert.equal(parseSceneColor("red"), null);
  assert.equal(parseSceneColor(""), null);
});

test("bounding radii: box half-diagonal, sphere radius, plane half-diagonal, others unpickable", () => {
  const box = node("box", { size: "2 2 2" });
  assert.ok(Math.abs(nodeBoundingRadius(box, resolvedProps(box, passthrough))! - Math.sqrt(3)) < 1e-12);
  const sphere = node("sphere", { radius: "0.5" });
  assert.equal(nodeBoundingRadius(sphere, resolvedProps(sphere, passthrough)), 0.5);
  const group = node("group");
  assert.equal(nodeBoundingRadius(group, resolvedProps(group, passthrough)), null);
});

test("worldBoundingSphere scales by the largest world basis", () => {
  const worlds = worldMatrices(
    [node("group", { scale: "3 1 1", position: "1 2 3", id: "g" })], passthrough,
  );
  const world = [...worlds.values()][0]!;
  const sphere = worldBoundingSphere(world, 1);
  assert.deepEqual(sphere.center, [1, 2, 3]);
  assert.ok(Math.abs(sphere.radius - 3) < 1e-12);
});

test("picking: a centered sphere is hit at ndc (0,0) and missed at the edge", () => {
  const ir = parseScene({
    tag: "scene", attrs: {}, children: [
      { tag: "camera", attrs: { position: "0 0 5" }, children: [] },
      { tag: "sphere", attrs: { radius: "0.5", id: "ball" }, children: [] },
    ],
  });
  const { view, proj, eye } = sceneCamera(ir, passthrough, 1);
  const hitRay = pickRay(proj, view, 0, 0)!;
  assert.ok(hitRay !== null);
  const t = raySphere(hitRay.origin, hitRay.dir, [0, 0, 0], 0.5);
  assert.ok(t !== null && t > 0, "center ray hits");
  // distance from the eye to the front of the sphere is ~4.5 (origin sits on the near plane side)
  const hit = [
    hitRay.origin[0] + hitRay.dir[0] * t!,
    hitRay.origin[1] + hitRay.dir[1] * t!,
    hitRay.origin[2] + hitRay.dir[2] * t!,
  ];
  assert.ok(Math.abs(hit[2]! - 0.5) < 1e-6, `front intersection at z=0.5, got ${hit[2]}`);
  assert.ok(Math.abs(eye[2] - 5) < 1e-12);
  const missRay = pickRay(proj, view, 0.9, 0.9)!;
  assert.equal(raySphere(missRay.origin, missRay.dir, [0, 0, 0], 0.5), null, "edge ray misses");
});

test("mat4Invert: inverse of a translation, and null for singular", () => {
  const m = mat4Translation(1, 2, 3);
  const inv = mat4Invert(m)!;
  const identity = mat4Multiply(m, inv);
  mat4Identity().forEach((v, i) => assert.ok(Math.abs(identity[i]! - v) < 1e-12));
  assert.equal(mat4Invert(new Array(16).fill(0)), null);
});

// ── P5 edge cases (the corpus pins the numbers; these pin the failure paths) ────────

import {
  parseSceneEasing, parseSceneTween, parseSceneTransitions, sceneBindRows,
  parseSceneDuration, formatSceneAnimValue, parseSceneAnimValue,
} from "../src/index.ts";

test("the total-resolve law: an unauthored attribute consults the resolver with its formatted default (the P5 override plane)", () => {
  const seen: string[] = [];
  const overriding: SceneResolve = (_n, name, raw) => {
    seen.push(`${name}=${raw}`);
    return name === "rotation" ? "0 90 0" : raw;
  };
  const props = resolvedProps(node("box", {}), overriding);
  assert.deepEqual(props.rotation, [0, 90, 0], "an override reaches a property the author never wrote");
  assert.deepEqual(props.position, [0, 0, 0], "untouched defaults parse to themselves");
  assert.ok(seen.includes("rotation=0 0 0"), "the formatted default rides as the raw value");
});

test("parseSceneTween: unknown target and malformed to are INERT with one diagnostic each — never a throw", () => {
  const diagnostics: SceneDiagnostic[] = [];
  const diag = (d: SceneDiagnostic): void => { diagnostics.push(d); };
  assert.equal(parseSceneTween(node("animate", { target: "opacity", to: "1" }), passthrough, diag), null);
  assert.equal(parseSceneTween(node("animate", { target: "position", to: "not a vec" }), passthrough, diag), null);
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every((d) => d.code === "malformed-animation"));
});

test("parseSceneTransitions skips malformed entries, keeps the rest; spring commas stay with the easing", () => {
  const diagnostics: SceneDiagnostic[] = [];
  const entries = parseSceneTransitions("position 300ms ease-out, banana 100ms, color 200ms spring(100,10)",
    (d) => diagnostics.push(d));
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.property, "position");
  assert.equal(entries[1]!.property, "color");
  assert.equal(entries[1]!.easing.kind, "spring");
  assert.equal(diagnostics.length, 1);
});

test("parseSceneEasing: malformed falls back to ease with one diagnostic; spring() takes the defaults", () => {
  const diagnostics: SceneDiagnostic[] = [];
  const bad = parseSceneEasing("bounce", (d) => diagnostics.push(d));
  assert.equal(bad.kind, "bezier");
  assert.equal(diagnostics.length, 1);
  const spring = parseSceneEasing("spring()", (d) => diagnostics.push(d));
  assert.deepEqual(spring, { kind: "spring", stiffness: 100, damping: 10 });
  assert.equal(diagnostics.length, 1);
});

test("parseSceneDuration: ms/s/bare forms; negatives and junk are null", () => {
  assert.equal(parseSceneDuration("2s"), 2000);
  assert.equal(parseSceneDuration("300ms"), 300);
  assert.equal(parseSceneDuration("300"), 300);
  assert.equal(parseSceneDuration("0.5s"), 500);
  assert.equal(parseSceneDuration("-1s"), null);
  assert.equal(parseSceneDuration("fast"), null);
});

test("the color value plane round-trips through linear RGB to a #hex override string", () => {
  const linear = parseSceneAnimValue("color", "#ff8800");
  assert.ok(linear !== null);
  assert.equal(formatSceneAnimValue("color", linear!), "#ff8800");
});

test("sceneBindRows: a non-array is zero rows; the animate kind never enters worldMatrices", () => {
  assert.deepEqual(sceneBindRows({ not: "an array" }, "id"), []);
  assert.deepEqual(sceneBindRows(null, "id"), []);
  const tree = node("box", { id: "b" }, [node("animate", { target: "rotation", to: "0 360 0" })]);
  const worlds = worldMatrices([tree], passthrough);
  assert.equal(worlds.size, 1, "the <animate> controller carries no transform");
});
