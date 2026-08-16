//
//  scene-conformance.test.ts - the SHARED DSX Scene numeric corpus
//  (OpenSource/Conformance/scene/{transforms,projection,parse}.json) through the TS
//  scene kernel — the P1 reference leg of dsx-scene.md. The Kotlin (:core) and Swift
//  (record lane) twins are the P2 row and will run the SAME files, so the three
//  implementations cannot drift on a single matrix element. Expected numbers were
//  computed by an independent scratch implementation, never by this kernel.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { parseDsx } from "@despia/compiler/xml";
import {
  parseScene, interpolateSceneHoles, resolvedProps, worldMatrices, findSceneNode,
  sceneCamera, projectToNdc, parseGlb, text3dQuad, sceneFrameSchedule,
  type SceneDiagnostic, type SceneMarkupNode, type SceneNode, type SceneResolve,
} from "../src/index.ts";

const TOLERANCE = 1.5e-6;

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/scene");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("scene corpus not found");
    dir = parent;
  }
}

function loadCases<T>(file: string, minimum: number): T[] {
  const doc = JSON.parse(readFileSync(join(corpusDir(), file), "utf-8")) as { cases: T[] };
  assert.ok(doc.cases.length >= minimum, `${file}: corpus is suspiciously small (${doc.cases.length})`);
  return doc.cases;
}

function mapResolver(vars: Record<string, unknown> | undefined): SceneResolve {
  return (_node, _name, raw) => interpolateSceneHoles(raw, (expr) => (vars ?? {})[expr]);
}

function assertClose(actual: readonly number[], expected: readonly number[], label: string): void {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(Math.abs(actual[i]! - expected[i]!) <= TOLERANCE,
      `${label}[${i}]: ${actual[i]} !~ ${expected[i]}`);
  }
}

// ── transforms.json — corpus trees are JSON scene nodes, not markup ─────────────────

type TransformTree = {
  kind: string; id?: string; position?: string; rotation?: string; scale?: string;
  children?: TransformTree[];
};
type TransformCase = {
  name: string; tree: TransformTree; vars?: Record<string, unknown>;
  node: string; world: number[]; point?: { local: [number, number, number]; world: number[] };
  diagnostics?: number;
};

function toSceneNodes(tree: TransformTree): SceneNode {
  const attrs: { [k: string]: string } = {};
  if (tree.id !== undefined) attrs["id"] = tree.id;
  for (const name of ["position", "rotation", "scale"] as const) {
    if (tree[name] !== undefined) attrs[name] = tree[name];
  }
  return {
    kind: tree.kind as SceneNode["kind"],
    id: tree.id ?? null,
    attrs,
    children: (tree.children ?? []).map(toSceneNodes),
  };
}

for (const c of loadCases<TransformCase>("transforms.json", 12)) {
  test(`scene-transforms/${c.name}`, () => {
    const diagnostics: SceneDiagnostic[] = [];
    const root = toSceneNodes(c.tree);
    const worlds = worldMatrices([root], mapResolver(c.vars), (d) => diagnostics.push(d));
    const target = findSceneNode([root], c.node);
    assert.ok(target !== null, `${c.name}: target node '${c.node}' exists`);
    const world = worlds.get(target);
    assert.ok(world !== undefined, `${c.name}: world matrix computed`);
    assertClose(world, c.world, "world");
    if (c.point !== undefined) {
      const w = c.point.world;
      const local = c.point.local;
      const p = [
        world[0]! * local[0] + world[4]! * local[1] + world[8]! * local[2] + world[12]!,
        world[1]! * local[0] + world[5]! * local[1] + world[9]! * local[2] + world[13]!,
        world[2]! * local[0] + world[6]! * local[1] + world[10]! * local[2] + world[14]!,
      ];
      assertClose(p, w, "point");
    }
    assert.equal(diagnostics.length, c.diagnostics ?? 0,
      `${c.name}: diagnostics ${JSON.stringify(diagnostics)}`);
  });
}

// ── projection.json ─────────────────────────────────────────────────────────────────

type ProjectionCase = {
  name: string;
  camera: {
    mode?: string; size?: number; fov?: number;
    position: string; "look-at": string; near: number; far: number; aspect: number;
  };
  points: Array<{ world: [number, number, number]; ndc: number[] }>;
};

for (const c of loadCases<ProjectionCase>("projection.json", 6)) {
  test(`scene-projection/${c.name}`, () => {
    const cam = c.camera;
    const attrs: { [k: string]: string } = {
      position: cam.position, "look-at": cam["look-at"],
      near: String(cam.near), far: String(cam.far),
    };
    if (cam.fov !== undefined) attrs["fov"] = String(cam.fov);
    if (cam.size !== undefined) attrs["size"] = String(cam.size);
    const markup: SceneMarkupNode = {
      tag: "scene",
      attrs: cam.mode === "2d" ? { mode: "2d" } : {},
      children: [{ tag: "camera", attrs, children: [] }],
    };
    const diagnostics: SceneDiagnostic[] = [];
    const ir = parseScene(markup, (d) => diagnostics.push(d));
    const { view, proj } = sceneCamera(ir, mapResolver(undefined), cam.aspect, (d) => diagnostics.push(d));
    for (const point of c.points) {
      assertClose(projectToNdc(proj, view, point.world), point.ndc, `ndc(${point.world.join(",")})`);
    }
    assert.equal(diagnostics.length, 0, `${c.name}: no diagnostics expected`);
  });
}

// ── parse.json — markup through the compiler's OWN XML parser (never a second one) ──

type ExpectNode = {
  kind: string; id?: string; children?: ExpectNode[];
  raw?: Record<string, string>;
  position?: number[]; rotation?: number[]; scale?: number[]; size?: number[] | number;
  lookAt?: number[]; fov?: number; near?: number; far?: number;
  radius?: number; intensity?: number;
  lightKind?: string; anchorKind?: string; color?: string; src?: string;
};
type ParseCase = {
  name: string; markup: string; vars?: Record<string, unknown>;
  expect: { mode?: string; background?: string; nodes?: ExpectNode[] };
  diagnostics?: number;
};

for (const c of loadCases<ParseCase>("parse.json", 8)) {
  test(`scene-parse/${c.name}`, () => {
    const diagnostics: SceneDiagnostic[] = [];
    const diag = (d: SceneDiagnostic): void => { diagnostics.push(d); };
    const markup = parseDsx(c.markup);
    const ir = parseScene(markup, diag);
    const resolver = mapResolver(c.vars);
    if (c.expect.mode !== undefined) assert.equal(ir.mode, c.expect.mode, "mode");
    if (c.expect.background !== undefined) {
      const raw = ir.attrs["background"] ?? "#000000";
      assert.equal(resolver(null, "background", raw), c.expect.background, "background");
    }
    const check = (nodes: readonly SceneNode[], expected: ExpectNode[], path: string): void => {
      assert.equal(nodes.length, expected.length, `${path}: node count`);
      expected.forEach((want, i) => {
        const node = nodes[i]!;
        assert.equal(node.kind, want.kind, `${path}[${i}].kind`);
        if (want.id !== undefined) assert.equal(node.id, want.id, `${path}[${i}].id`);
        if (want.raw !== undefined) {
          for (const [name, value] of Object.entries(want.raw)) {
            assert.equal(node.attrs[name], value, `${path}[${i}].raw.${name} kept verbatim`);
          }
        }
        const props = resolvedProps(node, resolver, diag);
        if (want.position !== undefined) assertClose(props.position, want.position, `${path}[${i}].position`);
        if (want.rotation !== undefined) assertClose(props.rotation, want.rotation, `${path}[${i}].rotation`);
        if (want.scale !== undefined) assertClose(props.scale, want.scale, `${path}[${i}].scale`);
        if (want.lookAt !== undefined) assertClose(props.lookAt, want.lookAt, `${path}[${i}].lookAt`);
        if (want.size !== undefined) {
          const size = Array.isArray(want.size) ? want.size : [want.size];
          if (node.kind === "camera") assertClose([props.size2d], size, `${path}[${i}].size`);
          else if (node.kind === "plane") assertClose(props.planeSize, size, `${path}[${i}].size`);
          else assertClose(props.boxSize, size, `${path}[${i}].size`);
        }
        for (const key of ["fov", "near", "far", "radius", "intensity"] as const) {
          if (want[key] !== undefined) {
            assert.ok(Math.abs(props[key] - want[key]) <= TOLERANCE, `${path}[${i}].${key}: ${props[key]} !~ ${want[key]}`);
          }
        }
        if (want.lightKind !== undefined) assert.equal(props.lightKind, want.lightKind, `${path}[${i}].lightKind`);
        if (want.anchorKind !== undefined) assert.equal(props.anchorKind, want.anchorKind, `${path}[${i}].anchorKind`);
        if (want.color !== undefined) assert.equal(props.color, want.color, `${path}[${i}].color`);
        if (want.src !== undefined) assert.equal(props.src, want.src, `${path}[${i}].src`);
        if (want.children !== undefined) check(node.children, want.children, `${path}[${i}].children`);
      });
    };
    if (c.expect.nodes !== undefined) check(ir.nodes, c.expect.nodes, "nodes");
    assert.equal(diagnostics.length, c.diagnostics ?? 0,
      `${c.name}: diagnostics ${JSON.stringify(diagnostics)}`);
  });
}

// ── model.json — GLB fixtures through the P4 parser (embedded buffers only) ─────────

type ModelMeshExpect = {
  index: number; vertexCount?: number; indexCount?: number;
  positions?: number[]; normals?: number[]; indices?: number[]; baseColor?: number[];
};
type ModelCase = {
  name: string; fixture: string;
  expect?: {
    meshCount?: number; drawCount?: number; meshes?: ModelMeshExpect[];
    draws?: Array<{ index: number; mesh: number; world: number[] }>;
    transformed?: Array<{ draw: number; vertex: number; world: number[] }>;
  };
  error?: string;
};

const modelDoc = JSON.parse(readFileSync(join(corpusDir(), "model.json"), "utf-8")) as {
  fixtures: Record<string, string>; cases: ModelCase[];
};
assert.ok(modelDoc.cases.length >= 6, `model.json: corpus is suspiciously small (${modelDoc.cases.length})`);

for (const c of modelDoc.cases) {
  test(`scene-model/${c.name}`, () => {
    const b64 = modelDoc.fixtures[c.fixture];
    assert.ok(b64 !== undefined, `${c.name}: fixture '${c.fixture}' exists`);
    const result = parseGlb(new Uint8Array(Buffer.from(b64!, "base64")));
    if (c.error !== undefined) {
      assert.equal(result.ok, false, `${c.name}: expected error '${c.error}'`);
      if (result.ok === false) assert.equal(result.error, c.error, "error code");
      return;
    }
    assert.equal(result.ok, true, `${c.name}: parses (${result.ok ? "" : result.error})`);
    if (!result.ok) return;
    const model = result.model;
    const want = c.expect ?? {};
    if (want.meshCount !== undefined) assert.equal(model.meshes.length, want.meshCount, "meshCount");
    if (want.drawCount !== undefined) assert.equal(model.draws.length, want.drawCount, "drawCount");
    for (const meshWant of want.meshes ?? []) {
      const primitive = model.meshes[meshWant.index]?.primitives[0];
      assert.ok(primitive !== undefined, `mesh[${meshWant.index}] primitive 0 exists`);
      if (meshWant.vertexCount !== undefined) {
        assert.equal(primitive!.positions.length / 3, meshWant.vertexCount, `mesh[${meshWant.index}].vertexCount`);
      }
      if (meshWant.indexCount !== undefined) {
        assert.equal(primitive!.indices.length, meshWant.indexCount, `mesh[${meshWant.index}].indexCount`);
      }
      if (meshWant.positions !== undefined) assertClose(primitive!.positions, meshWant.positions, `mesh[${meshWant.index}].positions`);
      if (meshWant.normals !== undefined) assertClose(primitive!.normals, meshWant.normals, `mesh[${meshWant.index}].normals`);
      if (meshWant.indices !== undefined) assert.deepEqual(primitive!.indices, meshWant.indices, `mesh[${meshWant.index}].indices`);
      if (meshWant.baseColor !== undefined) assertClose(primitive!.baseColor, meshWant.baseColor, `mesh[${meshWant.index}].baseColor`);
    }
    for (const drawWant of want.draws ?? []) {
      const draw = model.draws[drawWant.index];
      assert.ok(draw !== undefined, `draw[${drawWant.index}] exists`);
      assert.equal(draw!.mesh, drawWant.mesh, `draw[${drawWant.index}].mesh`);
      assertClose(draw!.world, drawWant.world, `draw[${drawWant.index}].world`);
    }
    for (const t of want.transformed ?? []) {
      const draw = model.draws[t.draw]!;
      const primitive = model.meshes[draw.mesh]!.primitives[0]!;
      const local = primitive.positions.slice(t.vertex * 3, t.vertex * 3 + 3);
      const m = draw.world;
      const world = [
        m[0]! * local[0]! + m[4]! * local[1]! + m[8]! * local[2]! + m[12]!,
        m[1]! * local[0]! + m[5]! * local[1]! + m[9]! * local[2]! + m[13]!,
        m[2]! * local[0]! + m[6]! * local[1]! + m[10]! * local[2]! + m[14]!,
      ];
      assertClose(world, t.world, `transformed[draw ${t.draw} vertex ${t.vertex}]`);
    }
  });
}

// ── text3d.json — the billboard-quad layout law ─────────────────────────────────────

type Text3dCase = {
  name: string; attrs: Record<string, string>; vars?: Record<string, unknown>;
  expect: { center: number[]; halfWidth: number; halfHeight: number } | null;
  diagnostics?: number;
};

for (const c of loadCases<Text3dCase>("text3d.json", 4)) {
  test(`scene-text3d/${c.name}`, () => {
    const diagnostics: SceneDiagnostic[] = [];
    const node: SceneNode = { kind: "text3d", id: null, attrs: c.attrs, children: [] };
    const props = resolvedProps(node, mapResolver(c.vars), (d) => diagnostics.push(d));
    const quad = text3dQuad(props);
    if (c.expect === null) {
      assert.equal(quad, null, `${c.name}: empty value lays out no quad`);
    } else {
      assert.ok(quad !== null, `${c.name}: quad exists`);
      assertClose(quad!.center, c.expect.center, "center");
      assert.ok(Math.abs(quad!.halfWidth - c.expect.halfWidth) <= TOLERANCE,
        `halfWidth: ${quad!.halfWidth} !~ ${c.expect.halfWidth}`);
      assert.ok(Math.abs(quad!.halfHeight - c.expect.halfHeight) <= TOLERANCE,
        `halfHeight: ${quad!.halfHeight} !~ ${c.expect.halfHeight}`);
    }
    assert.equal(diagnostics.length, c.diagnostics ?? 0,
      `${c.name}: diagnostics ${JSON.stringify(diagnostics)}`);
  });
}

// ── frame.json — the on:frame schedule law (the budget fold) ────────────────────────

type FrameCase = {
  name: string; ticks: number[];
  expect: Array<{ dt: number; elapsed: number; frame: number }>;
};

for (const c of loadCases<FrameCase>("frame.json", 3)) {
  test(`scene-frame/${c.name}`, () => {
    const emitted = sceneFrameSchedule(c.ticks);
    assert.equal(emitted.length, c.expect.length,
      `${c.name}: emitted count (${JSON.stringify(emitted)})`);
    c.expect.forEach((want, i) => {
      const got = emitted[i]!;
      assert.ok(Math.abs(got.dt - want.dt) <= TOLERANCE, `[${i}].dt: ${got.dt} !~ ${want.dt}`);
      assert.ok(Math.abs(got.elapsed - want.elapsed) <= TOLERANCE, `[${i}].elapsed: ${got.elapsed} !~ ${want.elapsed}`);
      assert.equal(got.frame, want.frame, `[${i}].frame`);
    });
    // the stated semantics a runner CAN assert: monotonic elapsed/frame, non-negative dt
    emitted.forEach((payload, i) => {
      assert.ok(payload.dt >= 0, `[${i}].dt non-negative`);
      if (i > 0) {
        assert.ok(payload.elapsed > emitted[i - 1]!.elapsed, `[${i}].elapsed strictly increases`);
        assert.equal(payload.frame, emitted[i - 1]!.frame + 1, `[${i}].frame increments`);
      }
    });
  });
}

// ── the P5 lanes (dsx-scene.md P5): animation · bind · collide · orbit · lighting ───

import {
  parseSceneTween, sceneTweenValue, parseSceneTransitions, sceneTransitionValue,
  parseSceneAnimValue, formatSceneAnimValue,
  sceneBindRows, diffSceneBindRows, instantiateSceneRow,
  sceneContacts, worldAabb, createSceneCollisionTracker, mat4Trs,
  orbitFromCamera, orbitPosition, orbitDrag, orbitZoom,
  scenePointAttenuation, sceneLitColor, sceneFogFactor, sceneLighting,
  type SceneAnimTarget, type SceneColliderShape, type SceneIR, type SceneTransitionState,
  type OrbitState, type Vec3,
} from "../src/index.ts";

const noHoles: SceneResolve = (_n, _a, raw) => raw;

function animNode(attrs: Record<string, string>): SceneNode {
  return { kind: "animate", id: null, attrs, children: [] };
}

// ── animation.json — tweens · the when gate · transitions ───────────────────────────

type TweenSampleExpect = { t: number; value: number[]; overriding: boolean; done: boolean };
type TweenCase = {
  name: string; spec: Record<string, string>; base: string;
  samples: TweenSampleExpect[]; format?: { t: number; value: string };
};
type GatedCase = {
  name: string; spec: Record<string, string>; base: string;
  events: Array<{ t: number; when: boolean }>;
  samples: Array<{ t: number; value: number[]; overriding: boolean }>;
};
type TransitionCase = {
  name: string; entry: string; base0: string;
  events: Array<{ t: number; base: string }>;
  samples: Array<{ t: number; value: number[]; done: boolean }>;
};

const animDoc = JSON.parse(readFileSync(join(corpusDir(), "animation.json"), "utf-8")) as {
  tweens: TweenCase[]; gated: GatedCase[]; transitions: TransitionCase[];
};
assert.ok(animDoc.tweens.length + animDoc.gated.length + animDoc.transitions.length >= 14,
  "animation.json: corpus is suspiciously small");

function tweenSetup(c: { spec: Record<string, string>; base: string }): {
  spec: NonNullable<ReturnType<typeof parseSceneTween>>; from: number[]; base: number[];
} {
  const diagnostics: SceneDiagnostic[] = [];
  const spec = parseSceneTween(animNode(c.spec), noHoles, (d) => diagnostics.push(d));
  assert.ok(spec !== null, `spec parses (${JSON.stringify(diagnostics)})`);
  assert.equal(diagnostics.length, 0, `no diagnostics: ${JSON.stringify(diagnostics)}`);
  const base = parseSceneAnimValue(spec!.target, c.base);
  assert.ok(base !== null, "base parses");
  return { spec: spec!, from: spec!.from ?? base!, base: base! };
}

for (const c of animDoc.tweens) {
  test(`scene-animation/tween/${c.name}`, () => {
    const { spec, from, base } = tweenSetup(c);
    for (const want of c.samples) {
      const got = sceneTweenValue(spec, from, base, want.t);
      assertClose(got.value, want.value, `value@${want.t}`);
      assert.equal(got.overriding, want.overriding, `overriding@${want.t}`);
      assert.equal(got.done, want.done, `done@${want.t}`);
    }
    if (c.format !== undefined) {
      const got = sceneTweenValue(spec, from, base, c.format.t);
      assert.equal(formatSceneAnimValue(spec.target, got.value), c.format.value, "formatted override string");
    }
  });
}

for (const c of animDoc.gated) {
  test(`scene-animation/gated/${c.name}`, () => {
    const { spec, from, base } = tweenSetup(c);
    // THE GATE LAW (the corpus _note): falsy ⇒ base; each falsy→truthy edge restarts
    // the clock. The fold below IS the law each surface implements.
    for (const want of c.samples) {
      let playing = false;
      let startMs = 0;
      for (const event of c.events) {
        if (event.t > want.t) break;
        if (event.when && !playing) startMs = event.t;
        playing = event.when;
      }
      const got = playing
        ? sceneTweenValue(spec, from, base, want.t - startMs)
        : { value: base, overriding: false };
      assertClose(got.value, want.value, `value@${want.t}`);
      assert.equal(got.overriding, want.overriding, `overriding@${want.t}`);
    }
  });
}

for (const c of animDoc.transitions) {
  test(`scene-animation/transition/${c.name}`, () => {
    const diagnostics: SceneDiagnostic[] = [];
    const entries = parseSceneTransitions(c.entry, (d) => diagnostics.push(d));
    assert.equal(entries.length, 1, `entry parses: ${JSON.stringify(diagnostics)}`);
    assert.equal(diagnostics.length, 0);
    const entry = entries[0]!;
    const parse = (raw: string): number[] => {
      const v = parseSceneAnimValue(entry.property, raw);
      assert.ok(v !== null, `${raw} parses as ${entry.property}`);
      return v!;
    };
    let state: SceneTransitionState | null = null;
    const rendered = (t: number): { value: number[]; done: boolean } =>
      state === null ? { value: parse(c.base0), done: true } : sceneTransitionValue(entry, state, t);
    let next = 0;
    for (const want of c.samples) {
      while (next < c.events.length && c.events[next]!.t <= want.t) {
        const event = c.events[next]!;
        // THE RETARGET LAW: the new glide starts from the CURRENT RENDERED value
        state = { from: rendered(event.t).value, to: parse(event.base), startMs: event.t };
        next += 1;
      }
      const got = rendered(want.t);
      assertClose(got.value, want.value, `value@${want.t}`);
      assert.equal(got.done, want.done, `done@${want.t}`);
    }
  });
}

// ── bind.json — rows · keyed diff · row scope · nesting · the cap ───────────────────

type BindCase = {
  name: string; kind: "rows" | "diff" | "scope" | "nested" | "cap"; key: string;
  value?: unknown; previous?: string[]; template?: { kind: string; attrs: Record<string, string> };
  innerField?: string; innerKey?: string; count?: number;
  expect: {
    keys?: string[]; indices?: number[];
    added?: string[]; removed?: string[]; retained?: string[];
    positions?: number[][]; colors?: string[];
    outerKeys?: string[]; innerKeys?: string[][];
    rowCount?: number; firstKey?: string; lastKey?: string; diagnostics?: number;
  };
};

const bindDoc = JSON.parse(readFileSync(join(corpusDir(), "bind.json"), "utf-8")) as { cases: BindCase[] };
assert.ok(bindDoc.cases.length >= 6, "bind.json: corpus is suspiciously small");

for (const c of bindDoc.cases) {
  test(`scene-bind/${c.name}`, () => {
    const diagnostics: SceneDiagnostic[] = [];
    const diag = (d: SceneDiagnostic): void => { diagnostics.push(d); };
    if (c.kind === "rows") {
      const rows = sceneBindRows(c.value, c.key, diag);
      assert.deepEqual(rows.map((r) => r.key), c.expect.keys, "keys");
      assert.deepEqual(rows.map((r) => r.index), c.expect.indices, "indices");
      assert.equal(diagnostics.length, 0);
      return;
    }
    if (c.kind === "diff") {
      const rows = sceneBindRows(c.value, c.key, diag);
      const diff = diffSceneBindRows(c.previous!, rows);
      assert.deepEqual(diff.added, c.expect.added, "added");
      assert.deepEqual(diff.removed, c.expect.removed, "removed");
      assert.deepEqual(diff.retained, c.expect.retained, "retained");
      return;
    }
    if (c.kind === "scope") {
      const template: SceneNode = {
        kind: c.template!.kind as SceneNode["kind"], id: null, attrs: c.template!.attrs, children: [],
      };
      const rows = sceneBindRows(c.value, c.key, diag);
      const positions: number[][] = [];
      const colors: string[] = [];
      for (const row of rows) {
        const [instance] = instantiateSceneRow([template]);
        // the row scope: item.* resolves against the row value (the <list> row law)
        const rowResolve: SceneResolve = (_n, _a, raw) => interpolateSceneHoles(raw, (expr) => {
          if (expr === "item") return row.item;
          if (expr === "item.index") return row.index;
          if (expr.startsWith("item.")) return (row.item as Record<string, unknown>)[expr.substring(5)];
          return undefined;
        });
        const props = resolvedProps(instance!, rowResolve, diag);
        positions.push([...props.position]);
        colors.push(props.color);
      }
      assert.deepEqual(positions, c.expect.positions, "positions");
      assert.deepEqual(colors, c.expect.colors, "colors");
      assert.equal(diagnostics.length, 0);
      return;
    }
    if (c.kind === "nested") {
      const outer = sceneBindRows(c.value, c.key, diag);
      assert.deepEqual(outer.map((r) => r.key), c.expect.outerKeys, "outer keys");
      const inner = outer.map((r) =>
        sceneBindRows((r.item as Record<string, unknown>)[c.innerField!], c.innerKey!, diag).map((x) => x.key));
      assert.deepEqual(inner, c.expect.innerKeys, "inner keys");
      assert.equal(diagnostics.length, 0);
      return;
    }
    // cap: the runner builds the oversized array (a corpus file should not carry 300 rows)
    const rows = sceneBindRows(Array.from({ length: c.count! }, (_, i) => i), c.key, diag);
    assert.equal(rows.length, c.expect.rowCount, "rowCount");
    assert.equal(rows[0]!.key, c.expect.firstKey, "firstKey");
    assert.equal(rows.at(-1)!.key, c.expect.lastKey, "lastKey");
    assert.equal(diagnostics.length, c.expect.diagnostics, "diagnostics");
    assert.ok(diagnostics.every((d) => d.code === "bind-overflow"));
  });
}

// ── collide.json — depth laws · world AABB · the enter fold ─────────────────────────

type CollideCase = {
  name: string; kind: "contacts" | "aabb" | "track";
  shapes?: SceneColliderShape[];
  half?: Vec3; trs?: { position: Vec3; rotation: Vec3; scale: Vec3 };
  frames?: SceneColliderShape[][];
  expect: unknown;
};

const collideDoc = JSON.parse(readFileSync(join(corpusDir(), "collide.json"), "utf-8")) as { cases: CollideCase[] };
assert.ok(collideDoc.cases.length >= 6, "collide.json: corpus is suspiciously small");

for (const c of collideDoc.cases) {
  test(`scene-collide/${c.name}`, () => {
    if (c.kind === "contacts") {
      const got = sceneContacts(c.shapes!);
      const want = c.expect as Array<{ a: string; b: string; depth: number }>;
      assert.equal(got.length, want.length, `contact count (${JSON.stringify(got)})`);
      want.forEach((w, i) => {
        assert.equal(got[i]!.a, w.a, `[${i}].a`);
        assert.equal(got[i]!.b, w.b, `[${i}].b`);
        assert.ok(Math.abs(got[i]!.depth - w.depth) <= TOLERANCE, `[${i}].depth: ${got[i]!.depth} !~ ${w.depth}`);
      });
      return;
    }
    if (c.kind === "aabb") {
      const world = mat4Trs(c.trs!.position, c.trs!.rotation, c.trs!.scale);
      const got = worldAabb(world, c.half!);
      const want = c.expect as { min: number[]; max: number[] };
      assertClose(got.min, want.min, "min");
      assertClose(got.max, want.max, "max");
      return;
    }
    const tracker = createSceneCollisionTracker();
    const want = c.expect as Array<Array<{ id: string; other: string; depth: number }>>;
    c.frames!.forEach((frame, i) => {
      const events = tracker.step(frame);
      assert.equal(events.length, want[i]!.length, `frame ${i}: event count (${JSON.stringify(events)})`);
      want[i]!.forEach((w, j) => {
        assert.equal(events[j]!.id, w.id, `frame ${i}[${j}].id`);
        assert.equal(events[j]!.other, w.other, `frame ${i}[${j}].other`);
        assert.ok(Math.abs(events[j]!.depth - w.depth) <= TOLERANCE, `frame ${i}[${j}].depth`);
      });
    });
  });
}

// ── orbit.json — the spherical/drag/zoom laws ───────────────────────────────────────

type OrbitCase = {
  name: string; camera: { position: Vec3; lookAt: Vec3 };
  ops: Array<{ drag?: [number, number]; zoom?: { deltaY: number; near: number; far: number } }>;
  expect: { yawDeg: number; pitchDeg: number; distance: number; position: number[] };
};

const orbitDoc = JSON.parse(readFileSync(join(corpusDir(), "orbit.json"), "utf-8")) as { cases: OrbitCase[] };
assert.ok(orbitDoc.cases.length >= 4, "orbit.json: corpus is suspiciously small");

for (const c of orbitDoc.cases) {
  test(`scene-orbit/${c.name}`, () => {
    let state: OrbitState = orbitFromCamera(c.camera.position, c.camera.lookAt);
    for (const op of c.ops) {
      if (op.drag !== undefined) state = orbitDrag(state, op.drag[0], op.drag[1]);
      else state = orbitZoom(state, op.zoom!.deltaY, op.zoom!.near, op.zoom!.far);
    }
    assertClose([state.yawDeg, state.pitchDeg, state.distance],
      [c.expect.yawDeg, c.expect.pitchDeg, c.expect.distance], "state");
    assertClose(orbitPosition(state, c.camera.lookAt), c.expect.position, "position");
  });
}

// ── lighting.json — attenuation · lit color · the cap · fog ─────────────────────────

type LightingCase = {
  name: string; kind: "attenuation" | "lit" | "cap" | "fog-factor" | "fog-blend";
  range?: number; samples?: Array<{ d: number; value: number }>;
  base?: Vec3; normal?: Vec3; point?: Vec3; ambient?: Vec3;
  directional?: { dir: Vec3; color: Vec3 } | null;
  points?: Array<{ position: Vec3; color: Vec3; intensity: number; range: number }>;
  lights?: Array<Record<string, string>>;
  near?: number; far?: number; d?: number; lit?: Vec3; fogColor?: Vec3;
  expect?: unknown;
};

const lightingDoc = JSON.parse(readFileSync(join(corpusDir(), "lighting.json"), "utf-8")) as { cases: LightingCase[] };
assert.ok(lightingDoc.cases.length >= 5, "lighting.json: corpus is suspiciously small");

for (const c of lightingDoc.cases) {
  test(`scene-lighting/${c.name}`, () => {
    if (c.kind === "attenuation") {
      for (const s of c.samples!) {
        const got = scenePointAttenuation(s.d, c.range!);
        assert.ok(Math.abs(got - s.value) <= TOLERANCE, `att(${s.d}): ${got} !~ ${s.value}`);
      }
      return;
    }
    if (c.kind === "lit") {
      const got = sceneLitColor(c.base!, c.normal!, c.point!, c.ambient!, c.directional ?? null, c.points!);
      assertClose(got, c.expect as number[], "lit");
      return;
    }
    if (c.kind === "cap") {
      const diagnostics: SceneDiagnostic[] = [];
      const ir: SceneIR = {
        mode: "3d", attrs: {},
        nodes: c.lights!.map((attrs) => ({ kind: "light", id: null, attrs, children: [] })),
      };
      const lighting = sceneLighting(ir, noHoles, (d) => diagnostics.push(d));
      const want = c.expect as { pointCount: number; positions: number[][]; diagnostics: number };
      assert.equal(lighting.points.length, want.pointCount, "pointCount");
      lighting.points.forEach((p, i) => assertClose(p.position, want.positions[i]!, `points[${i}]`));
      assert.equal(diagnostics.length, want.diagnostics, `diagnostics ${JSON.stringify(diagnostics)}`);
      assert.ok(diagnostics.every((d) => d.code === "light-cap"));
      return;
    }
    if (c.kind === "fog-factor") {
      for (const s of c.samples!) {
        const got = sceneFogFactor(s.d, c.near!, c.far!);
        assert.ok(Math.abs(got - s.value) <= TOLERANCE, `fog(${s.d}): ${got} !~ ${s.value}`);
      }
      return;
    }
    // fog-blend: final = f·lit + (1 − f)·fogColor (the blend law verbatim)
    const f = sceneFogFactor(c.d!, c.near!, c.far!);
    const got = c.lit!.map((l, i) => f * l + (1 - f) * c.fogColor![i]!);
    assertClose(got, c.expect as number[], "blend");
  });
}

// ── physics.json — the G2 fixed-tick solver (dsx-game.md §2 G2) ─────────────────────

import {
  createScenePhysicsWorld, stepScenePhysicsWorld, extractScenePhysics,
  scenePhysicsContact,
  scenePhysicsWriteVelocity, scenePhysicsTeleport, scenePhysicsSchedule,
  scenePhysicsInterpolate, scenePhysicsToLocal, scenePhysicsToRoot,
  scenePhysicsRotationToLocal, scenePhysicsRotationToRoot,
  SCENE_PHYSICS_DT, SCENE_PHYSICS_MAX_STEPS, SCENE_PHYSICS_DEFAULT_GRAVITY,
  SCENE_PHYSICS_CORRECTION_PERCENT, SCENE_PHYSICS_SLOP,
  SCENE_PHYSICS_RESTITUTION_MIN_SPEED, SCENE_PHYSICS_GROUND_NORMAL_Y,
  SCENE_PHYSICS_SLEEP_SPEED, SCENE_PHYSICS_SLEEP_TICKS, SCENE_PHYSICS_SLIDE_ITERATIONS,
  SCENE_PHYSICS_MANIFOLD_ITERATIONS,
  SCENE_PHYSICS_DEFAULT_SPEED, SCENE_PHYSICS_DEFAULT_JUMP,
  SCENE_PHYSICS_DEFAULT_ANGULAR_DAMPING, SCENE_PHYSICS_RADIANS_TO_DEGREES,
  scenePhysicsWriteAngularVelocity, scenePhysicsWriteTorque, scenePhysicsTeleportRotation,
  type ScenePhysicsBodySpec, type ScenePhysicsIntents, type ScenePhysicsWorld,
} from "../src/index.ts";

type PhysicsBodyExpect = {
  id: string; kind: string; shape: "sphere" | "box"; radius?: number; half?: number[];
  position: number[]; velocity: number[]; invMass: number; bounce: number; friction: number;
  trigger: boolean; layer: string; collides: string[] | null; speed: number; jump: number;
  rotation?: number[]; angularVelocity?: number[]; torque?: number[];
  invInertia?: number[]; angularDamping?: number;
};
type PhysicsEventExpect = { tick: number; name: "collision" | "enter" | "exit"; id: string; other: string };
type PhysicsSampleExpect = {
  tick: number; id: string; position: number[]; velocity: number[];
  grounded: boolean; sleeping: boolean;
  rotation?: number[]; angularVelocity?: number[];
  angularMomentum?: number[];
};
type PhysicsCase = {
  name: string; kind: "world" | "sim" | "contact" | "accumulator" | "interpolate" | "parentframe" | "orientationframe";
  // world
  markup?: string; vars?: Record<string, unknown>;
  expect?: unknown; diagnostics?: number; corners?: number[][];
  // sim
  gravity?: [number, number, number]; bodies?: ScenePhysicsBodySpec[]; ticks?: number;
  mode2d?: boolean;
  writes?: Array<{ tick: number; id: string; attr: "velocity" | "position" | "rotation" | "angular-velocity" | "torque"; value: [number, number, number] }>;
  drives?: Array<{ id: string; start: [number, number, number]; velocity: [number, number, number] }>;
  rotationDrives?: Array<{ tick: number; id: string; value: [number, number, number] }>;
  moves?: Array<{ id: string; from: number; to: number; move: [number, number] }>;
  samples?: PhysicsSampleExpect[]; events?: PhysicsEventExpect[]; replay?: boolean;
  // accumulator / interpolate
  frames?: number[]; prev?: [number, number, number]; curr?: [number, number, number]; alpha?: number;
};

function physicsBodyAngularMomentum(body: ScenePhysicsWorld["bodies"][number]): number[] {
  const [x, y, z, w] = body.orientation;
  const axes: number[][] = [
    [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
    [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
    [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
  ];
  const out = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const basis = axes[axis]!;
    const component = body.angularVelocity[0] * basis[0]!
      + body.angularVelocity[1] * basis[1]! + body.angularVelocity[2] * basis[2]!;
    const inertia = body.invInertia[axis]! > 0 ? 1 / body.invInertia[axis]! : 0;
    for (let k = 0; k < 3; k += 1) out[k] += basis[k]! * component * inertia;
  }
  return out;
}

const physicsDoc = JSON.parse(readFileSync(join(corpusDir(), "physics.json"), "utf-8")) as {
  constants: Record<string, unknown>; cases: PhysicsCase[];
};
assert.ok(physicsDoc.cases.length >= 16, `physics.json: corpus is suspiciously small (${physicsDoc.cases.length})`);

test("scene-physics/constants — the pinned constants match the kernel exports", () => {
  const k = physicsDoc.constants;
  assert.ok(Math.abs((k["dt"] as number) - SCENE_PHYSICS_DT) <= TOLERANCE, "dt");
  assert.equal(k["maxStepsPerFrame"], SCENE_PHYSICS_MAX_STEPS, "maxStepsPerFrame");
  assertClose(SCENE_PHYSICS_DEFAULT_GRAVITY, k["gravity"] as number[], "gravity");
  assert.equal(k["correctionPercent"], SCENE_PHYSICS_CORRECTION_PERCENT, "correctionPercent");
  assert.equal(k["slop"], SCENE_PHYSICS_SLOP, "slop");
  assert.equal(k["restitutionMinSpeed"], SCENE_PHYSICS_RESTITUTION_MIN_SPEED, "restitutionMinSpeed");
  assert.equal(k["groundNormalY"], SCENE_PHYSICS_GROUND_NORMAL_Y, "groundNormalY");
  assert.equal(k["sleepSpeed"], SCENE_PHYSICS_SLEEP_SPEED, "sleepSpeed");
  assert.equal(k["sleepTicks"], SCENE_PHYSICS_SLEEP_TICKS, "sleepTicks");
  assert.equal(k["characterSlideIterations"], SCENE_PHYSICS_SLIDE_ITERATIONS, "characterSlideIterations");
  assert.equal(k["manifoldIterations"], SCENE_PHYSICS_MANIFOLD_ITERATIONS, "manifoldIterations");
  assert.equal(k["defaultSpeed"], SCENE_PHYSICS_DEFAULT_SPEED, "defaultSpeed");
  assert.equal(k["defaultJump"], SCENE_PHYSICS_DEFAULT_JUMP, "defaultJump");
  assert.equal(k["defaultAngularDamping"], SCENE_PHYSICS_DEFAULT_ANGULAR_DAMPING, "defaultAngularDamping");
  assert.equal(k["radiansToDegrees"], SCENE_PHYSICS_RADIANS_TO_DEGREES, "radiansToDegrees");
});

/** the corpus sim driver — writes land BEFORE their tick's step; kinematic drives
 *  position the body at start + velocity·dt·(tick+1); samples record state AFTER */
function runPhysicsSim(c: PhysicsCase): {
  world: ScenePhysicsWorld;
  // `angularMomentum` is RECORDED by the sampler below and ASSERTED against the corpus
  // (Conformance/scene/physics.json carries it), but this declared return type had drifted
  // without it — so `got.angularMomentum` was a type error and `npm run typecheck` was red
  // for every reader of this tree, even though the assertion itself runs and passes.
  samples: Map<string, { position: number[]; velocity: number[]; rotation: number[]; angularVelocity: number[]; angularMomentum: number[]; grounded: boolean; sleeping: boolean }>;
  events: PhysicsEventExpect[];
} {
  const world = createScenePhysicsWorld(c.gravity ?? [0, -9.81, 0], c.bodies!, c.mode2d ?? false);
  const wanted = new Map<number, string[]>();
  for (const s of c.samples ?? []) {
    const list = wanted.get(s.tick) ?? [];
    list.push(s.id);
    wanted.set(s.tick, list);
  }
  const samples = new Map<string, { position: number[]; velocity: number[]; rotation: number[]; angularVelocity: number[]; angularMomentum: number[]; grounded: boolean; sleeping: boolean }>();
  const events: PhysicsEventExpect[] = [];
  const drivenRotations = new Map<string, [number, number, number]>();
  for (let n = 0; n < c.ticks!; n += 1) {
    for (const w of c.writes ?? []) {
      if (w.tick !== n) continue;
      if (w.attr === "velocity") scenePhysicsWriteVelocity(world, w.id, w.value);
      else if (w.attr === "angular-velocity") scenePhysicsWriteAngularVelocity(world, w.id, w.value);
      else if (w.attr === "torque") scenePhysicsWriteTorque(world, w.id, w.value);
      else if (w.attr === "rotation") scenePhysicsTeleportRotation(world, w.id, w.value);
      else scenePhysicsTeleport(world, w.id, w.value);
    }
    const intents: { [id: string]: { move?: [number, number]; position?: [number, number, number]; rotation?: [number, number, number] } } = {};
    for (const d of c.drives ?? []) {
      intents[d.id] = {
        position: [
          d.start[0] + d.velocity[0] * (SCENE_PHYSICS_DT * (n + 1)),
          d.start[1] + d.velocity[1] * (SCENE_PHYSICS_DT * (n + 1)),
          d.start[2] + d.velocity[2] * (SCENE_PHYSICS_DT * (n + 1)),
        ],
      };
    }
    for (const drive of c.rotationDrives ?? []) {
      if (drive.tick === n) drivenRotations.set(drive.id, [...drive.value]);
    }
    for (const [id, rotation] of drivenRotations) (intents[id] ??= {}).rotation = rotation;
    for (const m of c.moves ?? []) {
      if (m.from <= n && n <= m.to) (intents[m.id] ??= {}).move = m.move;
    }
    const result = stepScenePhysicsWorld(world, intents as ScenePhysicsIntents);
    assert.equal(result.tick, n, "tick is the zero-based step index");
    assert.equal(result.dt, SCENE_PHYSICS_DT, "dt is exactly 1/60");
    for (const [name, list] of [["collision", result.collisions], ["enter", result.enters], ["exit", result.exits]] as const) {
      for (const e of list) events.push({ tick: n, name, id: e.id, other: e.other });
    }
    for (const id of wanted.get(n) ?? []) {
      const body = world.byId.get(id)!;
      samples.set(`${n}:${id}`, {
        position: [...body.position], velocity: [...body.velocity],
        rotation: [...body.rotation], angularVelocity: [...body.angularVelocity],
        angularMomentum: physicsBodyAngularMomentum(body),
        grounded: body.grounded, sleeping: body.sleeping,
      });
    }
  }
  return { world, samples, events };
}

for (const c of physicsDoc.cases) {
  test(`scene-physics/${c.name}`, () => {
    if (c.kind === "world") {
      const diagnostics: SceneDiagnostic[] = [];
      const diag = (d: SceneDiagnostic): void => { diagnostics.push(d); };
      const ir = parseScene(parseDsx(c.markup!), diag);
      const extraction = extractScenePhysics(ir, mapResolver(c.vars), diag);
      const want = c.expect as { gravity: number[]; bodies: PhysicsBodyExpect[] };
      assertClose(extraction.gravity, want.gravity, "gravity");
      // build the world from the extraction — the corpus pins the BODY records
      const world = createScenePhysicsWorld(extraction.gravity, extraction.bodies);
      assert.equal(world.bodies.length, want.bodies.length, "body count");
      want.bodies.forEach((w, i) => {
        const body = world.bodies[i]!;
        assert.equal(body.id, w.id, `[${i}].id`);
        assert.equal(body.kind, w.kind, `[${i}].kind`);
        assert.equal(body.shape, w.shape, `[${i}].shape`);
        if (w.shape === "sphere") {
          assert.ok(Math.abs(body.radius - w.radius!) <= TOLERANCE, `[${i}].radius: ${body.radius} !~ ${w.radius}`);
        } else {
          assertClose(body.half, w.half!, `[${i}].half`);
        }
        assertClose(body.position, w.position, `[${i}].position`);
        assertClose(body.velocity, w.velocity, `[${i}].velocity`);
        if (w.rotation !== undefined) assertClose(body.rotation, w.rotation, `[${i}].rotation`);
        if (w.angularVelocity !== undefined) assertClose(body.angularVelocity, w.angularVelocity, `[${i}].angularVelocity`);
        if (w.torque !== undefined) assertClose(body.torque, w.torque, `[${i}].torque`);
        if (w.invInertia !== undefined) assertClose(body.invInertia, w.invInertia, `[${i}].invInertia`);
        if (w.angularDamping !== undefined) assert.equal(body.angularDamping, w.angularDamping, `[${i}].angularDamping`);
        assert.ok(Math.abs(body.invMass - w.invMass) <= TOLERANCE, `[${i}].invMass`);
        assert.equal(body.bounce, w.bounce, `[${i}].bounce`);
        assert.equal(body.friction, w.friction, `[${i}].friction`);
        assert.equal(body.trigger, w.trigger, `[${i}].trigger`);
        assert.equal(body.layer, w.layer, `[${i}].layer`);
        assert.deepEqual(body.collides, w.collides, `[${i}].collides`);
        assert.equal(body.speed, w.speed, `[${i}].speed`);
        assert.equal(body.jump, w.jump, `[${i}].jump`);
      });
      assert.equal(diagnostics.length, c.diagnostics ?? 0,
        `diagnostics ${JSON.stringify(diagnostics)}`);
      if (c.corners !== undefined) {
        assert.equal(world.bodies.length, 1, "corner containment cases own one body");
        const body = world.bodies[0]!;
        const rotationMatrix = mat4Trs([0, 0, 0], body.rotation, [1, 1, 1]);
        const axes = [
          [rotationMatrix[0]!, rotationMatrix[1]!, rotationMatrix[2]!],
          [rotationMatrix[4]!, rotationMatrix[5]!, rotationMatrix[6]!],
          [rotationMatrix[8]!, rotationMatrix[9]!, rotationMatrix[10]!],
        ];
        for (const [cornerIndex, corner] of c.corners.entries()) {
          const delta = corner.map((value, index) => value - body.position[index]!) as Vec3;
          for (let axis = 0; axis < 3; axis += 1) {
            const projection = Math.abs(delta[0] * axes[axis]![0]!
              + delta[1] * axes[axis]![1]! + delta[2] * axes[axis]![2]!);
            assert.ok(projection <= body.half[axis]! + TOLERANCE,
              `corner ${cornerIndex} axis ${axis}: ${projection} > ${body.half[axis]}`);
          }
        }
      }
      return;
    }
    if (c.kind === "sim") {
      const run = runPhysicsSim(c);
      for (const want of c.samples ?? []) {
        const got = run.samples.get(`${want.tick}:${want.id}`);
        assert.ok(got !== undefined, `sample @${want.tick} ${want.id} recorded`);
        assertClose(got!.position, want.position, `@${want.tick} ${want.id} position`);
        assertClose(got!.velocity, want.velocity, `@${want.tick} ${want.id} velocity`);
        if (want.rotation !== undefined) assertClose(got!.rotation, want.rotation, `@${want.tick} ${want.id} rotation`);
        if (want.angularVelocity !== undefined) assertClose(got!.angularVelocity, want.angularVelocity, `@${want.tick} ${want.id} angularVelocity`);
        if (want.angularMomentum !== undefined) assertClose(got!.angularMomentum, want.angularMomentum, `@${want.tick} ${want.id} angularMomentum`);
        assert.equal(got!.grounded, want.grounded, `@${want.tick} ${want.id} grounded`);
        assert.equal(got!.sleeping, want.sleeping, `@${want.tick} ${want.id} sleeping`);
      }
      if (c.events !== undefined) {
        assert.deepEqual(run.events, c.events, "the exact event sequence");
      }
      if (c.replay === true) {
        // THE DETERMINISM LAW: a second identical run ends BIT-IDENTICAL
        const again = runPhysicsSim(c);
        for (const body of run.world.bodies) {
          const twin = again.world.byId.get(body.id)!;
          assert.deepEqual(twin.position, body.position, `${body.id} replay position`);
          assert.deepEqual(twin.velocity, body.velocity, `${body.id} replay velocity`);
          assert.deepEqual(twin.rotation, body.rotation, `${body.id} replay rotation`);
          assert.deepEqual(twin.angularVelocity, body.angularVelocity, `${body.id} replay angularVelocity`);
        }
      }
      return;
    }
    if (c.kind === "contact") {
      const world = createScenePhysicsWorld([0, 0, 0], c.bodies!);
      const got = scenePhysicsContact(world.bodies[0]!, world.bodies[1]!);
      const want = c.expect as { depth: number; normal: number[]; pointCount: number; centroid: number[]; symmetric?: boolean };
      assert.ok(got !== null, "contact exists");
      assert.ok(Math.abs(got!.depth - want.depth) <= TOLERANCE, `depth ${got!.depth} !~ ${want.depth}`);
      assertClose(got!.normal, want.normal, "normal");
      assert.equal(got!.points.length, want.pointCount, "pointCount");
      const centroid = got!.points.reduce((sum, point) => [
        sum[0]! + point[0] / got!.points.length,
        sum[1]! + point[1] / got!.points.length,
        sum[2]! + point[2] / got!.points.length,
      ], [0, 0, 0]);
      assertClose(centroid, want.centroid, "centroid");
      if (want.symmetric === true) {
        const reverse = scenePhysicsContact(world.bodies[1]!, world.bodies[0]!);
        assert.ok(reverse !== null, "reverse contact exists");
        assert.equal(reverse!.points.length, got!.points.length, "reverse pointCount");
        assertClose(reverse!.normal, got!.normal.map((value) => -value), "reverse normal");
        const reverseCentroid = reverse!.points.reduce((sum, point) => [
          sum[0]! + point[0] / reverse!.points.length,
          sum[1]! + point[1] / reverse!.points.length,
          sum[2]! + point[2] / reverse!.points.length,
        ], [0, 0, 0]);
        assertClose(reverseCentroid, centroid, "reverse centroid");
      }
      return;
    }
    if (c.kind === "accumulator") {
      const got = scenePhysicsSchedule(c.frames!);
      const want = c.expect as Array<{ steps: number; alpha: number }>;
      assert.equal(got.length, want.length, "frame count");
      want.forEach((w, i) => {
        assert.equal(got[i]!.steps, w.steps, `[${i}].steps`);
        assert.ok(Math.abs(got[i]!.alpha - w.alpha) <= TOLERANCE, `[${i}].alpha: ${got[i]!.alpha} !~ ${w.alpha}`);
      });
      return;
    }
    if (c.kind === "parentframe") {
      // THE PARENT-FRAME LAW: each runner composes the parent with its OWN mat4Trs
      const spec = (c as unknown as { parent: { position: number[]; rotation: number[]; scale: number[] } | null }).parent;
      const parentWorld = spec === null ? null
        : mat4Trs(spec.position as Vec3, spec.rotation as Vec3, spec.scale as Vec3);
      const root = (c as unknown as { root: number[] }).root as Vec3;
      const local = (c as unknown as { local: number[] }).local;
      assertClose(scenePhysicsToLocal(root, parentWorld), local, "toLocal");
      if ((c as unknown as { noRoundTrip?: boolean }).noRoundTrip !== true) {
        assertClose(scenePhysicsToRoot(local as Vec3, parentWorld), root, "toRoot");
      }
      return;
    }
    if (c.kind === "orientationframe") {
      const spec = (c as unknown as { parent: { position: number[]; rotation: number[]; scale: number[] } | null }).parent;
      const parentWorld = spec === null ? null
        : mat4Trs(spec.position as Vec3, spec.rotation as Vec3, spec.scale as Vec3);
      const local = (c as unknown as { localRotation: number[] }).localRotation as Vec3;
      const root = (c as unknown as { rootRotation: number[] }).rootRotation as Vec3;
      assertClose(scenePhysicsRotationToRoot(local, parentWorld, root), root, "rotationToRoot");
      if ((c as unknown as { noRoundTrip?: boolean }).noRoundTrip !== true) {
        const expectedLocal = (c as unknown as { localRoundTrip?: number[] }).localRoundTrip ?? local;
        assertClose(scenePhysicsRotationToLocal(root, parentWorld, expectedLocal as Vec3), expectedLocal, "rotationToLocal");
      }
      return;
    }
    // interpolate
    const got = scenePhysicsInterpolate(c.prev!, c.curr!, c.alpha!);
    assertClose(got, c.expect as number[], "interpolated");
  });
}

// ── skin.json — the G3 skeletal corpus (dsx-game.md §2 G3) ──────────────────────────

import {
  glbNodeWorlds, glbJointMatrices, skinPosition, glbClipTime, sampleGlbChannel,
  glbEffectiveTrs, blendGlbTrs, sceneCrossfadeProgress, createSceneClipMixer,
  SCENE_SKIN_WEIGHT_EPSILON, SCENE_SLERP_NLERP_THRESHOLD,
  SCENE_CLIP_DEFAULT_BLEND_MS, SCENE_CLIP_DEFAULT_LOOP,
  type GlbChannel, type GlbClip, type GlbModel, type GlbNode, type GlbPose,
  type GlbQuat, type GlbTrs,
} from "../src/index.ts";

type SkinNodeJson = {
  translation?: [number, number, number]; rotation?: GlbQuat;
  scale?: [number, number, number]; children?: number[]; mesh?: number; skin?: number;
};
type SkinCase = {
  name: string; kind: string; fixture?: string;
  nodes?: SkinNodeJson[]; skin?: { joints: number[]; ibms: number[][] };
  meshNode?: number; pose?: Record<string, { t?: number[]; r?: number[]; s?: number[] }>;
  matrices?: number[][];
  vertices?: Array<{ position: [number, number, number]; joints: number[]; weights: number[]; expect: number[] }>;
  channel?: { path: string; interpolation: string; times: number[]; values: number[] };
  duration?: number;
  samples?: Array<Record<string, unknown>>;
  from?: { t: number[]; r: number[]; s: number[] }; to?: { t: number[]; r: number[]; s: number[] };
  model?: { nodes: SkinNodeJson[]; clips: Array<{ name: string; duration: number; channels: Array<{ node: number; path: string; interpolation: string; times: number[]; values: number[] }> }> };
  loop?: boolean; blendMs?: number;
  events?: Array<{ ms: number; set: string }>;
  markup?: string; vars?: Record<string, unknown>;
  expect?: Record<string, unknown>; diagnostics?: number;
};

const skinDoc = JSON.parse(readFileSync(join(corpusDir(), "skin.json"), "utf-8")) as {
  constants: Record<string, unknown>; fixtures: Record<string, string>; cases: SkinCase[];
};
assert.ok(skinDoc.cases.length >= 16, `skin.json: corpus is suspiciously small (${skinDoc.cases.length})`);

test("scene-skin/constants — the pinned constants match the kernel exports", () => {
  const k = skinDoc.constants;
  assert.equal(k["slerpNlerpThreshold"], SCENE_SLERP_NLERP_THRESHOLD, "slerpNlerpThreshold");
  assert.equal(k["weightEpsilon"], SCENE_SKIN_WEIGHT_EPSILON, "weightEpsilon");
  assert.equal(k["defaultBlendMs"], SCENE_CLIP_DEFAULT_BLEND_MS, "defaultBlendMs");
  assert.equal(k["defaultLoop"], SCENE_CLIP_DEFAULT_LOOP, "defaultLoop");
});

function skinNodes(raw: SkinNodeJson[]): GlbNode[] {
  return raw.map((n) => ({
    translation: n.translation ?? [0, 0, 0],
    rotation: n.rotation ?? [0, 0, 0, 1],
    scale: n.scale ?? [1, 1, 1],
    matrix: null,
    children: n.children ?? [],
    mesh: n.mesh ?? null,
    skin: n.skin ?? null,
  }));
}

function skinModel(c: SkinCase): GlbModel {
  const source = c.model!;
  const clips: GlbClip[] = source.clips.map((clip) => ({
    name: clip.name, duration: clip.duration,
    channels: clip.channels.map((ch) => ({
      node: ch.node, path: ch.path as GlbChannel["path"],
      interpolation: ch.interpolation as GlbChannel["interpolation"],
      times: ch.times, values: ch.values,
    })),
  }));
  return { meshes: [], draws: [], nodes: skinNodes(source.nodes), skins: [], clips };
}

function poseOf(raw: SkinCase["pose"]): GlbPose {
  const pose: GlbPose = new Map();
  for (const [index, entry] of Object.entries(raw ?? {})) {
    pose.set(Number(index), {
      ...(entry.t !== undefined ? { t: entry.t as [number, number, number] } : {}),
      ...(entry.r !== undefined ? { r: entry.r as GlbQuat } : {}),
      ...(entry.s !== undefined ? { s: entry.s as [number, number, number] } : {}),
    });
  }
  return pose;
}

for (const c of skinDoc.cases) {
  test(`scene-skin/${c.name}`, () => {
    const diagnostics: SceneDiagnostic[] = [];
    const diag = (d: SceneDiagnostic): void => { diagnostics.push(d); };
    if (c.kind === "parse") {
      const b64 = skinDoc.fixtures[c.fixture!];
      assert.ok(b64 !== undefined, `fixture '${c.fixture}' exists`);
      const result = parseGlb(new Uint8Array(Buffer.from(b64!, "base64")));
      assert.equal(result.ok, true, `parses (${result.ok ? "" : result.error})`);
      if (!result.ok) return;
      const model = result.model;
      const want = c.expect as {
        nodeCount: number; meshCount: number; drawCount: number;
        draws: Array<{ index: number; mesh: number; node: number; skin: number | null }>;
        skins: Array<{ joints: number[]; ibms: number[][] }>;
        primitives: Array<{ mesh: number; primitive: number; joints: number[]; weights: number[] }>;
        clips: Array<{ name: string; duration: number; channels: Array<{ node: number; path: string; interpolation: string; keys: number }> }>;
      };
      assert.equal(model.nodes.length, want.nodeCount, "nodeCount");
      assert.equal(model.meshes.length, want.meshCount, "meshCount");
      assert.equal(model.draws.length, want.drawCount, "drawCount");
      for (const drawWant of want.draws) {
        const draw = model.draws[drawWant.index]!;
        assert.equal(draw.mesh, drawWant.mesh, `draw[${drawWant.index}].mesh`);
        assert.equal(draw.node, drawWant.node, `draw[${drawWant.index}].node`);
        assert.equal(draw.skin, drawWant.skin, `draw[${drawWant.index}].skin`);
      }
      assert.equal(model.skins.length, want.skins.length, "skinCount");
      want.skins.forEach((skinWant, i) => {
        assert.deepEqual(model.skins[i]!.joints, skinWant.joints, `skins[${i}].joints`);
        assert.equal(model.skins[i]!.inverseBindMatrices.length, skinWant.ibms.length, `skins[${i}].ibm count`);
        skinWant.ibms.forEach((ibm, j) => {
          assertClose(model.skins[i]!.inverseBindMatrices[j]!, ibm, `skins[${i}].ibms[${j}]`);
        });
      });
      for (const p of want.primitives) {
        const primitive = model.meshes[p.mesh]!.primitives[p.primitive]!;
        assert.deepEqual(primitive.joints, p.joints, `mesh[${p.mesh}][${p.primitive}].joints`);
        assertClose(primitive.weights, p.weights, `mesh[${p.mesh}][${p.primitive}].weights`);
      }
      assert.equal(model.clips.length, want.clips.length, "clipCount");
      want.clips.forEach((clipWant, i) => {
        const clip = model.clips[i]!;
        assert.equal(clip.name, clipWant.name, `clips[${i}].name`);
        assert.ok(Math.abs(clip.duration - clipWant.duration) <= TOLERANCE,
          `clips[${i}].duration: ${clip.duration} !~ ${clipWant.duration}`);
        assert.equal(clip.channels.length, clipWant.channels.length, `clips[${i}].channel count`);
        clipWant.channels.forEach((chWant, j) => {
          const channel = clip.channels[j]!;
          assert.equal(channel.node, chWant.node, `clips[${i}][${j}].node`);
          assert.equal(channel.path, chWant.path, `clips[${i}][${j}].path`);
          assert.equal(channel.interpolation, chWant.interpolation, `clips[${i}][${j}].interpolation`);
          assert.equal(channel.times.length, chWant.keys, `clips[${i}][${j}].keys`);
        });
      });
      return;
    }
    if (c.kind === "jointMatrices") {
      const model: GlbModel = {
        meshes: [], draws: [], nodes: skinNodes(c.nodes!),
        skins: [{ joints: c.skin!.joints, inverseBindMatrices: c.skin!.ibms }],
        clips: [],
      };
      const worlds = glbNodeWorlds(model, poseOf(c.pose));
      const want = c.expect as { worlds: number[][]; jointMatrices: number[][] };
      want.worlds.forEach((w, i) => assertClose(worlds[c.skin!.joints[i]!]!, w, `worlds[joint ${i}]`));
      const matrices = glbJointMatrices(model, 0, c.meshNode!, worlds);
      assert.equal(matrices.length, want.jointMatrices.length, "joint matrix count");
      want.jointMatrices.forEach((m, i) => assertClose(matrices[i]!, m, `jointMatrices[${i}]`));
      return;
    }
    if (c.kind === "skinVertex") {
      for (const v of c.vertices!) {
        const got = skinPosition(v.position, v.joints, v.weights, c.matrices!);
        assertClose(got, v.expect, `skin(${v.position.join(",")})`);
      }
      return;
    }
    if (c.kind === "sample") {
      const channel: GlbChannel = {
        node: 0, path: c.channel!.path as GlbChannel["path"],
        interpolation: c.channel!.interpolation as GlbChannel["interpolation"],
        times: c.channel!.times, values: c.channel!.values,
      };
      for (const s of c.samples! as Array<{ time: number; loop: boolean; expect: number[] }>) {
        const wrapped = glbClipTime(s.time, c.duration!, s.loop);
        assertClose(sampleGlbChannel(channel, wrapped), s.expect, `sample@${s.time}`);
      }
      return;
    }
    if (c.kind === "crossfade") {
      const parse = (raw: { t: number[]; r: number[]; s: number[] }): GlbTrs => ({
        t: raw.t as [number, number, number], r: raw.r as GlbQuat, s: raw.s as [number, number, number],
      });
      for (const s of c.samples! as Array<{ progress: number; t: number[]; r: number[]; s: number[] }>) {
        const got = blendGlbTrs(parse(c.from!), parse(c.to!), s.progress);
        assertClose(got.t, s.t, `t@${s.progress}`);
        assertClose(got.r, s.r, `r@${s.progress}`);
        assertClose(got.s, s.s, `s@${s.progress}`);
      }
      return;
    }
    if (c.kind === "progress") {
      for (const s of c.samples! as Array<{ elapsedMs: number; blendMs: number; progress: number }>) {
        const got = sceneCrossfadeProgress(s.elapsedMs, s.blendMs);
        assert.ok(Math.abs(got - s.progress) <= TOLERANCE,
          `progress(${s.elapsedMs}, ${s.blendMs}): ${got} !~ ${s.progress}`);
      }
      return;
    }
    if (c.kind === "mixer") {
      const model = skinModel(c);
      const mixer = createSceneClipMixer(model, diag);
      let next = 0;
      for (const s of c.samples! as Array<{ ms: number; node: number; t?: number[]; r?: number[]; active?: boolean }>) {
        while (next < c.events!.length && c.events![next]!.ms <= s.ms) {
          mixer.update(c.events![next]!.set, c.loop!, c.blendMs!, c.events![next]!.ms);
          next += 1;
        }
        mixer.update(mixerCurrentName(c, s.ms), c.loop!, c.blendMs!, s.ms);
        const pose = mixer.pose(s.ms);
        const trs = glbEffectiveTrs(model.nodes[s.node]!, pose.get(s.node));
        if (s.t !== undefined) assertClose(trs.t, s.t, `t@${s.ms}`);
        if (s.r !== undefined) assertClose(trs.r, s.r, `r@${s.ms}`);
        if (s.active !== undefined) assert.equal(mixer.active(s.ms), s.active, `active@${s.ms}`);
      }
      assert.equal(diagnostics.length, c.diagnostics ?? 0,
        `diagnostics ${JSON.stringify(diagnostics)}`);
      return;
    }
    // props: markup through the compiler's own parser (never a second one)
    const ir = parseScene(parseDsx(c.markup!), diag);
    const modelNode = ir.nodes.find((n) => n.kind === "model");
    assert.ok(modelNode !== undefined, "markup contains a <model>");
    const props = resolvedProps(modelNode!, mapResolver(c.vars), diag);
    const want = c.expect as { animation: string; loop: boolean; blendMs: number };
    assert.equal(props.animation, want.animation, "animation");
    assert.equal(props.clipLoop, want.loop, "loop");
    assert.ok(Math.abs(props.blendMs - want.blendMs) <= TOLERANCE, `blendMs: ${props.blendMs} !~ ${want.blendMs}`);
    assert.equal(diagnostics.length, c.diagnostics ?? 0,
      `diagnostics ${JSON.stringify(diagnostics)}`);
  });
}

/** re-assert the CURRENT name between events — a per-frame update with an unchanged
 *  name must be a no-op (the surfaces call update every frame) */
function mixerCurrentName(c: SkinCase, ms: number): string {
  let name = "";
  for (const event of c.events!) {
    if (event.ms > ms) break;
    // an unknown-name event keeps the previous name (the mixer law) — mirror it here
    const known = event.set === "" || c.model!.clips.some((clip) => clip.name === event.set);
    if (known) name = event.set;
  }
  return name;
}

// ── prefab.json — components as prefabs inside <scene> subtrees (dsx-game.md G1) ────

import { scenePrefabDefFromTemplate, scenePrefabResolver, type ScenePrefabDef } from "../src/index.ts";

type PrefabComponentEntry = {
  template: string;
  params?: Array<{ name: string; default?: string }>;
  /** the defining-scope law: this component's body resolves tags through ITS OWN table */
  components?: Record<string, PrefabComponentEntry>;
};
type PrefabWorldExpect = {
  node?: string; path?: number[]; world: number[];
  point?: { local: [number, number, number]; world: number[] };
};
type PrefabCase = {
  name: string;
  components: Record<string, PrefabComponentEntry>;
  markup: string;
  vars?: Record<string, unknown>;
  expect?: { mode?: string; background?: string; nodes?: ExpectNode[] };
  worlds?: PrefabWorldExpect[];
  diagnostics?: number;
  rows?: {
    first: Array<Record<string, unknown>>;
    next: Array<Record<string, unknown>>;
    expect: { firstKeys: string[]; nextRemoved: string[]; nextRetained: string[]; radius: number[] };
  };
};

/** the case's component table as a prefab lookup: templates parse through the
 *  compiler's OWN XML parser (never a second one); explicit `params` override the
 *  template-derived declaration (the web ComponentIR shape); a per-component
 *  `components` sub-table becomes the def's OWN lookup (the defining-scope law). */
function prefabLookupOver(table: Record<string, PrefabComponentEntry>): (tag: string) => ScenePrefabDef | null {
  const defs = new Map<string, ScenePrefabDef | null>();
  const lookup = (tag: string): ScenePrefabDef | null => {
    const cached = defs.get(tag);
    if (cached !== undefined) return cached;
    const entry = table[tag];
    let def: ScenePrefabDef | null = null;
    if (entry !== undefined) {
      const derived = scenePrefabDefFromTemplate(parseDsx(entry.template));
      def = {
        params: entry.params ?? derived.params,
        roots: derived.roots,
        ...(entry.components !== undefined ? { lookup: prefabLookupOver(entry.components) } : {}),
      };
    }
    defs.set(tag, def);
    return def;
  };
  return lookup;
}

function prefabLookupFor(c: PrefabCase): (tag: string) => ScenePrefabDef | null {
  return prefabLookupOver(c.components);
}

function prefabNodeAtPath(nodes: readonly SceneNode[], path: readonly number[]): SceneNode {
  let list = nodes;
  let node: SceneNode | undefined;
  for (const index of path) {
    node = list[index];
    assert.ok(node !== undefined, `path [${path.join(",")}] resolves`);
    list = node!.children;
  }
  assert.ok(node !== undefined, "path is non-empty");
  return node!;
}

for (const c of loadCases<PrefabCase>("prefab.json", 10)) {
  test(`scene-prefab/${c.name}`, () => {
    const diagnostics: SceneDiagnostic[] = [];
    const diag = (d: SceneDiagnostic): void => { diagnostics.push(d); };
    const lookup = prefabLookupFor(c);
    const ir = parseScene(parseDsx(c.markup), diag, lookup);
    const outer = (expr: string): unknown => (c.vars ?? {})[expr];

    if (c.rows !== undefined) {
      // the keyed-spawn leg: rows of prefab instances at the IR plane
      const group = ir.nodes.find((n) => n.kind === "group" && n.attrs["bind"] !== undefined);
      assert.ok(group !== undefined, "markup contains a bound group");
      const template = group!.children;
      assert.ok(template.length > 0 && template[0]!.prefab !== undefined,
        "the template child is a prefab expansion root");
      const firstRows = sceneBindRows(c.rows.first, group!.attrs["key"] ?? "id", diag);
      assert.deepEqual(firstRows.map((r) => r.key), c.rows.expect.firstKeys, "first keys");
      const instances = firstRows.map((row) => {
        const nodes = instantiateSceneRow(template);
        // fresh identity per spawn, the prefab stamp preserved (the instantiation law)
        assert.ok(nodes[0] !== template[0], "fresh node identity");
        assert.ok(nodes[0]!.prefab !== undefined, "prefab stamp survives instantiation");
        const rowEval = (expr: string): unknown => {
          if (expr.startsWith("item.")) return (row.item as Record<string, unknown>)[expr.substring(5)];
          return outer(expr);
        };
        return { nodes, resolve: scenePrefabResolver(nodes, rowEval) };
      });
      if (instances.length > 1) {
        assert.ok(instances[0]!.nodes[0] !== instances[1]!.nodes[0], "instances are distinct");
      }
      c.rows.expect.radius.forEach((want, i) => {
        const instance = instances[i]!;
        const sphere = instance.nodes[0]!.children[0]!;
        const props = resolvedProps(sphere, instance.resolve, diag);
        assert.ok(Math.abs(props.radius - want) <= TOLERANCE, `row[${i}].radius: ${props.radius} !~ ${want}`);
      });
      const diff = diffSceneBindRows(
        firstRows.map((r) => r.key), sceneBindRows(c.rows.next, group!.attrs["key"] ?? "id", diag));
      assert.deepEqual(diff.removed, c.rows.expect.nextRemoved, "despawned keys");
      assert.deepEqual(diff.retained, c.rows.expect.nextRetained, "retained keys");
      assert.equal(diagnostics.length, c.diagnostics ?? 0,
        `${c.name}: diagnostics ${JSON.stringify(diagnostics)}`);
      return;
    }

    const resolver = scenePrefabResolver(ir.nodes, outer);
    const check = (nodes: readonly SceneNode[], expected: ExpectNode[], path: string): void => {
      assert.equal(nodes.length, expected.length, `${path}: node count`);
      expected.forEach((want, i) => {
        const node = nodes[i]!;
        assert.equal(node.kind, want.kind, `${path}[${i}].kind`);
        if (want.id !== undefined) assert.equal(node.id, want.id, `${path}[${i}].id`);
        const props = resolvedProps(node, resolver, diag);
        if (want.position !== undefined) assertClose(props.position, want.position, `${path}[${i}].position`);
        if (want.rotation !== undefined) assertClose(props.rotation, want.rotation, `${path}[${i}].rotation`);
        if (want.scale !== undefined) assertClose(props.scale, want.scale, `${path}[${i}].scale`);
        if (want.size !== undefined) {
          const size = Array.isArray(want.size) ? want.size : [want.size];
          if (node.kind === "plane") assertClose(props.planeSize, size, `${path}[${i}].size`);
          else assertClose(props.boxSize, size, `${path}[${i}].size`);
        }
        if (want.radius !== undefined) {
          assert.ok(Math.abs(props.radius - want.radius) <= TOLERANCE, `${path}[${i}].radius: ${props.radius} !~ ${want.radius}`);
        }
        if (want.color !== undefined) assert.equal(props.color, want.color, `${path}[${i}].color`);
        if ((want as { value?: string }).value !== undefined) {
          assert.equal(props.value, (want as { value?: string }).value, `${path}[${i}].value`);
        }
        if (want.children !== undefined) check(node.children, want.children, `${path}[${i}].children`);
      });
    };
    if (c.expect?.nodes !== undefined) check(ir.nodes, c.expect.nodes, "nodes");
    for (const w of c.worlds ?? []) {
      const worlds = worldMatrices(ir.nodes, resolver, diag);
      const target = w.node !== undefined
        ? findSceneNode(ir.nodes, w.node)
        : prefabNodeAtPath(ir.nodes, w.path ?? []);
      assert.ok(target !== null, `world target exists`);
      const world = worlds.get(target!);
      assert.ok(world !== undefined, "world matrix computed");
      assertClose(world!, w.world, "world");
      if (w.point !== undefined) {
        const m = world!;
        const l = w.point.local;
        assertClose([
          m[0]! * l[0] + m[4]! * l[1] + m[8]! * l[2] + m[12]!,
          m[1]! * l[0] + m[5]! * l[1] + m[9]! * l[2] + m[13]!,
          m[2]! * l[0] + m[6]! * l[1] + m[10]! * l[2] + m[14]!,
        ], w.point.world, "point");
      }
    }
    assert.equal(diagnostics.length, c.diagnostics ?? 0,
      `${c.name}: diagnostics ${JSON.stringify(diagnostics)}`);
  });
}

// ── sprite.json — the 2D engine (dsx-game.md G6): the sprite quad · sheets · fps ·
// the 2D conventions · the z-lock solver ──────────────────────────────────────────────

import {
  spriteQuad, spriteSizeOf, spriteFrameCount, spriteUvRect, spriteFrameAt,
  sceneDrawOrder2d, SPRITE_DEFAULT_HEIGHT, SPRITE_ANCHORS, SPRITE_DEFAULT_ANCHOR,
  SCENE_SPRITE_COLLIDER_HALF_Z,
} from "../src/index.ts";

type SpriteCase = {
  name: string;
  kind: "quad" | "uv" | "sheet" | "fps" | "parse" | "order" | "physics-world" | "physics-sim";
  attrs?: Record<string, string>;
  vars?: Record<string, unknown>;
  aspect?: number;
  markup?: string;
  samples?: Array<{ elapsed: number; frame: number }>;
  z?: number[];
  // physics-sim
  mode2d?: boolean;
  gravity?: [number, number, number];
  bodies?: ScenePhysicsBodySpec[];
  ticks?: number;
  writes?: Array<{ tick: number; id: string; attr: "velocity" | "position"; value: [number, number, number] }>;
  physicsSamples?: PhysicsSampleExpect[];
  worlds?: Array<{ node: string; world: number[] }>;
  expect?: unknown;
  diagnostics?: number;
};

const spriteDoc = JSON.parse(readFileSync(join(corpusDir(), "sprite.json"), "utf-8")) as {
  constants: Record<string, unknown>; cases: SpriteCase[];
};
assert.ok(spriteDoc.cases.length >= 30, `sprite.json: corpus is suspiciously small (${spriteDoc.cases.length})`);

test("scene-sprite/constants — the pinned constants match the kernel exports", () => {
  const k = spriteDoc.constants;
  assert.equal(k["defaultHeight"], SPRITE_DEFAULT_HEIGHT, "defaultHeight");
  assert.equal(k["colliderHalfZ"], SCENE_SPRITE_COLLIDER_HALF_Z, "colliderHalfZ");
  assert.equal(k["defaultAnchor"], SPRITE_DEFAULT_ANCHOR, "defaultAnchor");
  assert.equal(k["defaultLoop"], true, "defaultLoop");
  const anchors = k["anchors"] as Record<string, [number, number]>;
  assert.equal(Object.keys(anchors).length, SPRITE_ANCHORS.size, "anchor word count");
  for (const [word, want] of Object.entries(anchors)) {
    const got = SPRITE_ANCHORS.get(word);
    assert.ok(got !== undefined, `anchor '${word}' exists`);
    assertClose(got!, want, `anchor ${word}`);
  }
});

/** a bare `<sprite>` node in 2D — the corpus's attribute-only lanes never mount markup */
function spriteNode(attrs: Record<string, string>): SceneNode {
  return { kind: "sprite", id: null, attrs, children: [], mode2d: true };
}

for (const c of spriteDoc.cases) {
  test(`scene-sprite/${c.name}`, () => {
    const diagnostics: SceneDiagnostic[] = [];
    const diag = (d: SceneDiagnostic): void => { diagnostics.push(d); };
    const expectDiagnostics = (): void => {
      assert.equal(diagnostics.length, c.diagnostics ?? 0,
        `${c.name}: diagnostics ${JSON.stringify(diagnostics)}`);
    };

    if (c.kind === "quad") {
      const props = resolvedProps(spriteNode(c.attrs!), mapResolver(c.vars), diag);
      const quad = spriteQuad(props, c.aspect);
      const want = c.expect as { offset: number[]; halfWidth: number; halfHeight: number };
      assertClose(quad.center, want.offset, "quad center offset");
      assert.ok(Math.abs(quad.halfWidth - want.halfWidth) <= TOLERANCE,
        `halfWidth: ${quad.halfWidth} !~ ${want.halfWidth}`);
      assert.ok(Math.abs(quad.halfHeight - want.halfHeight) <= TOLERANCE,
        `halfHeight: ${quad.halfHeight} !~ ${want.halfHeight}`);
      // the size fold agrees with the quad's own half extents (one law, one number)
      const [w, h] = spriteSizeOf(props, c.aspect);
      assertClose([w / 2, h / 2], [want.halfWidth, want.halfHeight], "spriteSizeOf");
      expectDiagnostics();
      return;
    }

    if (c.kind === "uv") {
      const props = resolvedProps(spriteNode(c.attrs!), mapResolver(c.vars), diag);
      assertClose(spriteUvRect(props, props.spriteFrame), c.expect as number[], "uv rect");
      // spriteQuad carries the SAME rect (the one-call layout)
      assertClose(spriteQuad(props).uv, c.expect as number[], "quad.uv");
      expectDiagnostics();
      return;
    }

    if (c.kind === "sheet") {
      const props = resolvedProps(spriteNode(c.attrs!), mapResolver(c.vars), diag);
      const want = c.expect as { cols: number; rows: number; total: number; frame: number };
      assert.equal(props.spriteFrames[0], want.cols, "cols");
      assert.equal(props.spriteFrames[1], want.rows, "rows");
      assert.equal(spriteFrameCount(props), want.total, "total");
      assert.equal(props.spriteFrame, want.frame, "frame");
      expectDiagnostics();
      return;
    }

    if (c.kind === "fps") {
      const props = resolvedProps(spriteNode(c.attrs!), mapResolver(c.vars), diag);
      for (const sample of c.samples ?? []) {
        assert.equal(spriteFrameAt(props, sample.elapsed), sample.frame,
          `frame @${sample.elapsed}s`);
      }
      expectDiagnostics();
      return;
    }

    if (c.kind === "order") {
      assert.deepEqual(sceneDrawOrder2d(c.z!), c.expect as number[], "draw order");
      return;
    }

    if (c.kind === "parse") {
      const ir = parseScene(parseDsx(c.markup!), diag);
      const resolver = mapResolver(c.vars);
      const want = c.expect as {
        mode?: string;
        nodes?: Array<Record<string, unknown>>;
      };
      if (want.mode !== undefined) assert.equal(ir.mode, want.mode, "mode");
      (want.nodes ?? []).forEach((expected, i) => {
        const scNode = ir.nodes[i]!;
        assert.equal(scNode.kind, expected["kind"], `nodes[${i}].kind`);
        const props = resolvedProps(scNode, resolver, diag);
        const numeric: Array<[string, readonly number[]]> = [
          ["position", props.position], ["rotation", props.rotation], ["scale", props.scale],
          ["spriteSize", props.spriteSize], ["frames", props.spriteFrames],
        ];
        for (const [key, got] of numeric) {
          if (expected[key] !== undefined) assertClose(got, expected[key] as number[], `nodes[${i}].${key}`);
        }
        for (const key of ["frame", "fps"] as const) {
          if (expected[key] !== undefined) {
            const got = key === "frame" ? props.spriteFrame : props.spriteFps;
            assert.ok(Math.abs(got - (expected[key] as number)) <= TOLERANCE, `nodes[${i}].${key}`);
          }
        }
        if (expected["loop"] !== undefined) assert.equal(props.spriteLoop, expected["loop"], `nodes[${i}].loop`);
        if (expected["anchor"] !== undefined) assert.equal(props.spriteAnchor, expected["anchor"], `nodes[${i}].anchor`);
        if (expected["flip"] !== undefined) assert.equal(props.spriteFlip, expected["flip"], `nodes[${i}].flip`);
        if (expected["src"] !== undefined) assert.equal(props.src, expected["src"], `nodes[${i}].src`);
        if (expected["color"] !== undefined) assert.equal(props.color, expected["color"], `nodes[${i}].color`);
      });
      for (const w of c.worlds ?? []) {
        const worlds = worldMatrices(ir.nodes, resolver, diag);
        const target = findSceneNode(ir.nodes, w.node);
        assert.ok(target !== null, `world target '${w.node}' exists`);
        const world = worlds.get(target!);
        assert.ok(world !== undefined, "world matrix computed");
        assertClose(world!, w.world, `world(${w.node})`);
      }
      expectDiagnostics();
      return;
    }

    if (c.kind === "physics-world") {
      const ir = parseScene(parseDsx(c.markup!), diag);
      const extraction = extractScenePhysics(ir, mapResolver(c.vars), diag);
      const want = c.expect as {
        gravity: number[]; mode2d: boolean; bodies: PhysicsBodyExpect[];
      };
      assertClose(extraction.gravity, want.gravity, "gravity");
      assert.equal(extraction.mode2d, want.mode2d, "mode2d");
      const world = createScenePhysicsWorld(extraction.gravity, extraction.bodies, extraction.mode2d);
      assert.equal(world.mode2d, want.mode2d, "world.mode2d");
      assert.equal(world.bodies.length, want.bodies.length, "body count");
      want.bodies.forEach((w, i) => {
        const body = world.bodies[i]!;
        assert.equal(body.id, w.id, `[${i}].id`);
        assert.equal(body.kind, w.kind, `[${i}].kind`);
        assert.equal(body.shape, w.shape, `[${i}].shape`);
        if (w.shape === "sphere") {
          assert.ok(Math.abs(body.radius - w.radius!) <= TOLERANCE, `[${i}].radius: ${body.radius} !~ ${w.radius}`);
        } else {
          assertClose(body.half, w.half!, `[${i}].half`);
        }
        assertClose(body.position, w.position, `[${i}].position`);
        assertClose(body.velocity, w.velocity, `[${i}].velocity`);
        assert.ok(Math.abs(body.invMass - w.invMass) <= TOLERANCE, `[${i}].invMass`);
        assert.equal(body.bounce, w.bounce, `[${i}].bounce`);
        assert.equal(body.friction, w.friction, `[${i}].friction`);
        assert.equal(body.trigger, w.trigger, `[${i}].trigger`);
        assert.equal(body.layer, w.layer, `[${i}].layer`);
        assert.deepEqual(body.collides, w.collides, `[${i}].collides`);
        assert.equal(body.speed, w.speed, `[${i}].speed`);
        assert.equal(body.jump, w.jump, `[${i}].jump`);
      });
      expectDiagnostics();
      return;
    }

    // physics-sim: the SAME driver shape physics.json uses, plus the mode2d flag
    const world = createScenePhysicsWorld(c.gravity ?? [0, -9.81, 0], c.bodies!, c.mode2d === true);
    const wanted = new Map<number, string[]>();
    const samples = (c as unknown as { samples?: PhysicsSampleExpect[] }).samples ?? [];
    for (const s of samples) {
      const list = wanted.get(s.tick) ?? [];
      list.push(s.id);
      wanted.set(s.tick, list);
    }
    const recorded = new Map<string, { position: number[]; velocity: number[]; grounded: boolean; sleeping: boolean }>();
    for (let n = 0; n < c.ticks!; n += 1) {
      for (const w of c.writes ?? []) {
        if (w.tick !== n) continue;
        if (w.attr === "velocity") scenePhysicsWriteVelocity(world, w.id, w.value);
        else scenePhysicsTeleport(world, w.id, w.value);
      }
      stepScenePhysicsWorld(world);
      for (const id of wanted.get(n) ?? []) {
        const body = world.byId.get(id)!;
        recorded.set(`${n}:${id}`, {
          position: [...body.position], velocity: [...body.velocity],
          grounded: body.grounded, sleeping: body.sleeping,
        });
      }
    }
    for (const want of samples) {
      const got = recorded.get(`${want.tick}:${want.id}`);
      assert.ok(got !== undefined, `sample @${want.tick} ${want.id} recorded`);
      assertClose(got!.position, want.position, `@${want.tick} ${want.id} position`);
      assertClose(got!.velocity, want.velocity, `@${want.tick} ${want.id} velocity`);
      assert.equal(got!.grounded, want.grounded, `@${want.tick} ${want.id} grounded`);
      assert.equal(got!.sleeping, want.sleeping, `@${want.tick} ${want.id} sleeping`);
    }
    // THE Z-LOCK LAW as an invariant, not only as pinned samples
    if (c.mode2d === true) {
      for (const body of world.bodies) {
        assert.equal(body.position[2], body.zLock, `${body.id}: z stayed exactly at its lock`);
        assert.equal(body.previous[2], body.zLock, `${body.id}: the interpolation anchor stayed too`);
        assert.equal(body.velocity[2], body.vzLock, `${body.id}: vz stayed exactly at its lock`);
      }
    }
  });
}
