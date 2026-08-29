//
//  scene.ts - the web `<scene>` element (dsx-scene.md P1 + P4): the DSX-native 3D/2D
//  engine's WebGL renderer. The NUMBERS all live in the platform-neutral kernel
//  (@despia/kernel scene/ — corpus OpenSource/Conformance/scene/), this module only owns
//  the browser adapter: a canvas + raw WebGL1 (zero deps, broadest support), flat
//  Lambert-ish shading (ambient + one directional light), reactive transforms (bound
//  attributes re-resolve through the store like every element; a change re-uploads and
//  redraws, requestAnimationFrame-coalesced — no free-running loop for STATIC scenes),
//  and on:tap picking v0 (kernel pickRay/raySphere against world bounding spheres,
//  handlers fire through the SAME runner path as every other element).
//
//  P4 (landed): `<model src>` — GLB fetched with the media-surface URL posture
//  (safeMediaUrl + CORS-anonymous fetch), parsed by the kernel's parseGlb (embedded
//  buffers only — the named absence), drawn flat-Lambert with baseColorFactor × node
//  color; `<text3d>` — the value rasterized through canvas 2D onto a BILLBOARD quad
//  (the billboard law: the quad always faces the camera — its rotation is the view
//  rotation transposed; drawn UNLIT so the label stays legible, alpha-cutout edges);
//  `texture="url"` on box/sphere/plane — NEAREST-sampled, clamped, modulating the
//  material color per the UV law in the corpus README; `on:frame` — dispatching
//  { dt, elapsed, frame } through the same runner path as on:tap under the kernel
//  frame clock's 60/s budget (corpus frame.json). mode="ar" and <anchor> are the P3
//  row: they render the honest scheduled placeholder INSIDE the scene box — never
//  blank, never fake. Registered from boot.ts only, so sliced embeds pay zero bytes
//  (/web/13).
//
//  P5 (this file's adapter half; all NUMBERS in @despia/kernel scene/{anim,bind,collide,
//  orbit}.ts + ir.ts, corpus OpenSource/Conformance/scene/):
//  - ANIMATIONS: implicit `transition=` retargets (a base change glides from the
//    CURRENT RENDERED value — the CSS interrupt model) + explicit `<animate>` tweens
//    (loop/delay/when/fill/on:done). The override plane is the RESOLVED ATTRIBUTE:
//    an active animation injects its formatted value into the resolver, so the
//    corpus-pinned world/camera/lighting folds stay untouched. One rAF loop exists
//    ONLY while at least one animation is active or an on:frame handler is authored
//    (the zero-cost static law survives); it rides the shared kernel frame clock.
//  - DATA-DRIVEN CHILDREN: `<group bind key>` instantiates its template per row with
//    keyed identity (kernel sceneBindRows/diff; the <list> law); each row binds
//    through a row-scoped ctx so `item.*` holes and handlers see the row.
//  - COLLISIONS: `collide="sphere|box"` + `on:collide` — the pass runs after each
//    RENDERED frame while a handler is authored (movement implies a render).
//  - ORBIT CONTROLS: `controls="orbit"` on <camera> wires pointer-drag + wheel to the
//    kernel orbit math, writing the camera position through the same override plane.
//  - LIGHTING DEPTH: up to 4 `<light kind="point">` + linear `fog=` in the shader,
//    formulas pinned in the kernel (lighting.json).
//
//  G2 PHYSICS (dsx-game.md §2 G2 — this file's adapter half; every NUMBER lives in
//  @despia/kernel scene/physics.ts, corpus OpenSource/Conformance/scene/physics.json):
//  - THE FIXED-TICK LAW: the solver steps at exactly 60 Hz inside the ONE rAF loop
//    (a 5-step accumulator cap discards excess frame time); rendered positions and
//    rotations are INTERPOLATED between the last two steps. `on:tick`
//    ({dt: 1/60, tick}) fires per
//    fixed step; on:frame stays render-rate. on:tick/on:collision/on:enter/on:exit
//    all dispatch through the SAME runner path as on:tap.
//  - THE LOOP-EXISTENCE LAW, EXTENDED: the loop exists while an on:frame handler is
//    authored, an animation is active, OR any dynamic body is AWAKE / any character
//    body exists. A fully-asleep world stops the loop (and on:tick with it); a
//    static scene still runs none.
//  - THE OVERRIDE-PLANE LAW: a dynamic body's rendered `position` and `rotation` are
//    SOLVER-OWNED interpolated overrides (characters own position only); the authored/
//    bound base holds the SPAWN pose. Base writes to position/rotation teleport the
//    corresponding state; velocity/angular-velocity/torque are command writes. Kinematic
//    bodies read the RESOLVED plane each step (store writes, bus set and animations
//    all drive them); character intent reads the `move` attr the same way.
//
//  G3 SKELETAL CLIPS (dsx-game.md §2 G3 — this file's adapter half; every NUMBER lives
//  in @despia/kernel scene/skin.ts + gltf.ts, corpus OpenSource/Conformance/scene/
//  skin.json): `<model animation loop blend>` — the reactive `animation` name drives
//  the kernel CLIP MIXER (initial clip = hard cut; a switch crossfades over `blend`;
//  unknown name diagnoses + keeps; "" = bind pose); each rendered frame samples the
//  mixer's pose, recomputes the GLB node worlds (animated node transforms move
//  UNSKINNED draws too), folds the joint matrices (inverse(meshNodeWorld) · jointWorld
//  · IBM) and CPU-SKINS the JOINTS_0/WEIGHTS_0 vertices into dynamic buffers feeding
//  the EXISTING draw path (flat facet normals — the raster stance; GPU skinning is the
//  named perf upgrade). THE LOOP-EXISTENCE LAW, EXTENDED AGAIN: the one rAF loop also
//  runs while any model has an active clip or crossfade (mixer.active); a finished
//  non-looping clip with no crossfade lets it stop.
//

import {
  parseScene, resolvedProps, worldMatrices, sceneCamera, sceneLighting, parseSceneColor,
  nodeBoundingRadius, worldBoundingSphere, pickRay, raySphere, mat4Multiply,
  parseGlb, text3dQuad, createSceneFrameClock, findSceneNode,
  extractScenePhysics, createScenePhysicsWorld, stepScenePhysicsWorld,
  carryScenePhysicsContactState,
  scenePhysicsWriteVelocity, scenePhysicsWriteAngularVelocity, scenePhysicsWriteTorque,
  scenePhysicsTeleport, scenePhysicsTeleportRotation, scenePhysicsWakeAll,
  createScenePhysicsAccumulator, scenePhysicsInterpolate,
  scenePhysicsToLocal, scenePhysicsToRoot,
  scenePhysicsRotationToLocal, scenePhysicsRotationToRoot,
  parseSceneTransitions, parseSceneTween, sceneTweenValue, sceneTransitionValue,
  parseSceneAnimValue, formatSceneAnimValue, SCENE_ANIM_TARGETS, parseSceneEasing,
  sceneBindRows, diffSceneBindRows, instantiateSceneRow,
  sceneColliderFor, createSceneCollisionTracker, sceneContacts,
  orbitFromCamera, orbitPosition, orbitDrag, orbitZoom,
  sceneFog,
  sceneBusRegister, sceneBusUnregister, sceneBusEmit,
  scenePrefabDefFromTemplate, type ScenePrefabDef, type ScenePrefabLookup,
  spriteSizeOf, spriteAnchorOffset, spriteUvRect, spriteFrameAt, spriteFrameCount,
  sceneDrawOrder2d, mat4Trs,
  createSceneClipMixer, glbNodeWorlds, glbJointMatrices, skinnedPrimitivePositions,
  type GlbPose, type GlbPrimitive, type SceneClipMixer,
  type GlbModel, type Mat4, type SceneDiagnostic, type SceneIR, type SceneMarkupNode,
  type SceneNode, type SceneNodeProps, type SceneResolve, type Vec3,
  type SceneAnimTarget, type SceneTweenSpec, type SceneTransitionEntry,
  type SceneTransitionState, type SceneColliderShape,
  type SceneBusHandle, type SceneBusNode, type SceneBusCapture,
  type ScenePhysicsWorld, type ScenePhysicsBody, type ScenePhysicsIntents,
} from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import { resolveComponent } from "@despia/compiler/resolve";
import { ELEMENTS, type ElementApi, type ElementFactory } from "./elements.ts";
import { adoptInternals, type MountCtx } from "./mount.ts";
import { safeMediaUrl } from "./media-surfaces.ts";
import { inputHostFrame } from "./input.ts";
/** Carry solver-owned state across a DOM scene re-extraction. Node identity is the
 * stable key: body ids may be regenerated by a keyed bind reconcile. New/changed
 * bodies keep their freshly extracted state, while retained bodies preserve the
 * complete solver timeline and contact ledgers. */
export function carryScenePhysicsState(
  previous: ScenePhysicsWorld,
  next: ScenePhysicsWorld,
  previousNodes: ReadonlyMap<string, SceneNode>,
  nextNodes: ReadonlyMap<string, SceneNode>,
): void {
  const previousByNode = new Map<SceneNode, ScenePhysicsBody>();
  for (const body of previous.bodies) {
    const node = previousNodes.get(body.id);
    if (node !== undefined) previousByNode.set(node, body);
  }
  const nextIdByNode = new Map<SceneNode, string>();

  for (const body of next.bodies) {
    const node = nextNodes.get(body.id);
    const prior = node === undefined ? undefined : previousByNode.get(node);
    if (prior === undefined || prior.kind !== body.kind) continue;
    nextIdByNode.set(node!, body.id);
    body.position = [...prior.position] as Vec3;
    body.previous = [...prior.previous] as Vec3;
    body.velocity = [...prior.velocity] as Vec3;
    body.rotation = [...prior.rotation] as Vec3;
    body.orientation = [...prior.orientation];
    body.previousRotation = [...prior.previousRotation] as Vec3;
    body.angularVelocity = [...prior.angularVelocity] as Vec3;
    body.torque = [...prior.torque] as Vec3;
    body.grounded = prior.grounded;
    body.sleeping = prior.sleeping;
    body.sleepCount = prior.sleepCount;
    body.zLock = prior.zLock;
  }

  const separator = String.fromCharCode(0);
  const translatePair = (key: string): string | null => {
    const at = key.indexOf(separator);
    if (at < 0) return null;
    const aNode = previousNodes.get(key.slice(0, at));
    const bNode = previousNodes.get(key.slice(at + separator.length));
    if (aNode === undefined || bNode === undefined) return null;
    const a = nextIdByNode.get(aNode);
    const b = nextIdByNode.get(bNode);
    if (a === undefined || b === undefined) return null;
    const aIndex = next.byId.get(a)?.index;
    const bIndex = next.byId.get(b)?.index;
    if (aIndex === undefined || bIndex === undefined) return null;
    return aIndex < bIndex ? `${a}${separator}${b}` : `${b}${separator}${a}`;
  };
  const translateSet = (source: ReadonlySet<string>): Set<string> => {
    const translated = new Set<string>();
    for (const key of source) {
      const nextKey = translatePair(key);
      if (nextKey !== null) translated.add(nextKey);
    }
    return translated;
  };

  next.tick = previous.tick;
  next.solidOverlap = translateSet(previous.solidOverlap);
  next.triggerOverlap = translateSet(previous.triggerOverlap);
  const triggerOrder: string[] = [];
  for (const key of previous.triggerOrder) {
    const nextKey = translatePair(key);
    if (nextKey !== null && next.triggerOverlap.has(nextKey) && !triggerOrder.includes(nextKey)) {
      triggerOrder.push(nextKey);
    }
  }
  next.triggerOrder = triggerOrder;
  const nextIdByPreviousId = new Map<string, string>();
  for (const [previousId, previousNode] of previousNodes) {
    const nextId = nextIdByNode.get(previousNode);
    if (nextId !== undefined) nextIdByPreviousId.set(previousId, nextId);
  }
  carryScenePhysicsContactState(previous, next, nextIdByPreviousId);
}

// ── geometry (unit shapes; per-node size/radius rides an extra model scale) ──────────

type Geometry = { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint16Array | Uint32Array };

/** u16 indices when they fit, u32 when any index exceeds 65535 (the kernel GLB parser
 *  accepts componentType 5125 — a >64k-vertex mesh must not wrap mod 65536) */
export function sceneIndexArray(indices: readonly number[]): Uint16Array | Uint32Array {
  for (const i of indices) if (i > 0xffff) return new Uint32Array(indices);
  return new Uint16Array(indices);
}

/** the per-face UV pattern (corpus README UV law): u = x_face + 0.5, v = 0.5 − y_face —
 *  texel row 0 is the image's TOP, so the image reads upright on a +Z-facing surface */
const FACE_UVS: ReadonlyArray<readonly [number, number]> = [[0, 1], [1, 1], [1, 0], [0, 0]];

export function buildBoxGeometry(): Geometry {
  // 6 faces × 4 vertices, unit cube centered at the origin
  const faces: Array<{ n: Vec3; corners: Vec3[] }> = [
    { n: [0, 0, 1], corners: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { n: [0, 0, -1], corners: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
    { n: [1, 0, 0], corners: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
    { n: [-1, 0, 0], corners: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
    { n: [0, 1, 0], corners: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { n: [0, -1, 0], corners: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  ];
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  faces.forEach((face, f) => {
    face.corners.forEach((corner, i) => {
      positions.push(...corner);
      normals.push(...face.n);
      uvs.push(...FACE_UVS[i]!);
    });
    indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint16Array(indices) };
}

export function buildSphereGeometry(latBands = 12, lonBands = 18): Geometry {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let lat = 0; lat <= latBands; lat += 1) {
    const theta = lat * Math.PI / latBands;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let lon = 0; lon <= lonBands; lon += 1) {
      const phi = lon * 2 * Math.PI / lonBands;
      const x = st * Math.cos(phi), y = ct, z = st * Math.sin(phi);
      positions.push(x, y, z);
      normals.push(x, y, z);
      // the sphere UV law: u = φ/2π (+X meridian toward +Z), v = θ/π (0 at the +Y pole)
      uvs.push(lon / lonBands, lat / latBands);
    }
  }
  for (let lat = 0; lat < latBands; lat += 1) {
    for (let lon = 0; lon < lonBands; lon += 1) {
      const first = lat * (lonBands + 1) + lon;
      const second = first + lonBands + 1;
      indices.push(first, second, first + 1, second, second + 1, first + 1);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint16Array(indices) };
}

export function buildPlaneGeometry(): Geometry {
  // unit quad in XY facing +Z (the corpus law: rotate -90° about X for a ground plane)
  return {
    positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array(FACE_UVS.flat()),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUV;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormal;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUV;
void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorld = world.xyz;
  vNormal = uNormal * aNormal;
  vUV = aUV;
  gl_Position = uProj * uView * world;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform vec3 uColor;
uniform vec3 uAmbient;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uEye;
uniform sampler2D uTexture;
uniform vec2 uUvOffset;
uniform vec2 uUvScale;
uniform float uCutout;
uniform float uUnlit;
uniform vec3 uPointPos[4];
uniform vec3 uPointColor[4];
uniform float uPointRange[4];
uniform int uPointCount;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUV;
void main() {
  vec4 texel = texture2D(uTexture, uUvOffset + vUV * uUvScale);
  if (uCutout > 0.5 && texel.a < 0.5) discard;   // text3d glyph cutout
  vec3 n = normalize(vNormal);
  vec3 toEye = normalize(uEye - vWorld);
  if (dot(n, toEye) < 0.0) n = -n;   // two-sided: planes shade from either face
  float diffuse = max(dot(n, normalize(uLightDir)), 0.0);
  // P5 point lights — the pinned falloff: window²/(1+d²), window = max(0, 1−(d/range)⁴)
  vec3 pointLight = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= uPointCount) break;
    vec3 toLight = uPointPos[i] - vWorld;
    float d = length(toLight);
    if (d <= 0.0) continue;
    float ratio = d / max(uPointRange[i], 1e-4);
    float window = max(0.0, 1.0 - ratio * ratio * ratio * ratio);
    float att = window * window / (1.0 + d * d);
    pointLight += uPointColor[i] * (att * max(dot(n, toLight / d), 0.0));
  }
  vec3 lit = uColor * (uAmbient + uLightColor * diffuse + pointLight);
  vec3 c = min(mix(lit, uColor, uUnlit) * texel.rgb, vec3(1.0));   // texel MODULATES; clamp
  // P5 linear fog: f = clamp((far − d)/(far − near), 0, 1); far ≤ near = fog off
  if (uFogFar > uFogNear) {
    float f = clamp((uFogFar - distance(uEye, vWorld)) / (uFogFar - uFogNear), 0.0, 1.0);
    c = mix(uFogColor, c, f);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

/** the scene words still scheduled (dsx-scene.md P3) — placeholder-rendered, never fake.
 *  model/text3d left this set when P4 landed. */
export const SCENE_SCHEDULED_KINDS: ReadonlySet<string> = new Set(["anchor"]);

type GlBuffers = { position: WebGLBuffer; normal: WebGLBuffer; uv: WebGLBuffer; index: WebGLBuffer; count: number; indexType: number };

type GlState = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  attrs: { position: number; normal: number; uv: number };
  uniforms: { [name: string]: WebGLUniformLocation | null };
  geometry: { box: GlBuffers; sphere: GlBuffers; plane: GlBuffers };
  /** 1×1 white — bound when a surface has no texture so texel.rgb is 1 */
  whiteTexture: WebGLTexture;
};

function compileProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const make = (kind: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(kind);
    if (shader === null) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
      console.warn(`[dsx scene] shader compile failed: ${gl.getShaderInfoLog(shader) ?? "unknown"}`);
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };
  const vertex = make(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = make(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (vertex === null || fragment === null) return null;
  const program = gl.createProgram();
  if (program === null) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    console.warn(`[dsx scene] program link failed: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
    return null;
  }
  return program;
}

function uploadGeometry(gl: WebGLRenderingContext, geometry: Geometry): GlBuffers | null {
  const position = gl.createBuffer(), normal = gl.createBuffer(), uv = gl.createBuffer(), index = gl.createBuffer();
  if (position === null || normal === null || uv === null || index === null) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, position);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, normal);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.normals, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, uv);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.uvs, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
  const indexType = geometry.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  return { position, normal, uv, index, count: geometry.indices.length, indexType };
}

/** the UV law's sampling half: NEAREST texel, clamped to the edge (also the WebGL1
 *  requirement for non-power-of-two images) */
function uploadTexture(gl: WebGLRenderingContext, source: TexImageSource): WebGLTexture | null {
  const texture = gl.createTexture();
  if (texture === null) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function initGl(canvas: HTMLCanvasElement): GlState | null {
  let gl: WebGLRenderingContext | null = null;
  // preserveDrawingBuffer: the renderer draws ON DEMAND (no per-frame loop unless
  // on:frame asks for one), so the buffer must survive compositing — it also keeps
  // canvas readback (tests, user screenshots) honest for one retained framebuffer.
  const options = { preserveDrawingBuffer: true };
  try {
    gl = (canvas.getContext("webgl", options)
      ?? canvas.getContext("experimental-webgl", options)) as WebGLRenderingContext | null;
  } catch { gl = null; }
  if (gl === null) return null;
  // u32 index buffers (>64k-vertex GLB meshes) need this WebGL1 extension; enabling is
  // a no-op where unsupported, and sceneIndexArray only emits u32 when indices demand it
  gl.getExtension("OES_element_index_uint");
  const program = compileProgram(gl);
  if (program === null) return null;
  const box = uploadGeometry(gl, buildBoxGeometry());
  const sphere = uploadGeometry(gl, buildSphereGeometry());
  const plane = uploadGeometry(gl, buildPlaneGeometry());
  if (box === null || sphere === null || plane === null) return null;
  const white = gl.createTexture();
  if (white === null) return null;
  gl.bindTexture(gl.TEXTURE_2D, white);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255]));
  const uniforms: GlState["uniforms"] = {};
  for (const name of ["uProj", "uView", "uModel", "uNormal", "uColor", "uAmbient",
    "uLightDir", "uLightColor", "uEye", "uTexture", "uUvOffset", "uUvScale", "uCutout", "uUnlit",
    "uPointPos", "uPointColor", "uPointRange", "uPointCount",
    "uFogColor", "uFogNear", "uFogFar"]) {
    // array uniforms report as "name[0]" on some drivers — accept either spelling
    uniforms[name] = gl.getUniformLocation(program, name) ?? gl.getUniformLocation(program, `${name}[0]`);
  }
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE); // two-sided planes; the fragment shader flips the normal
  return {
    gl, program,
    attrs: {
      position: gl.getAttribLocation(program, "aPosition"),
      normal: gl.getAttribLocation(program, "aNormal"),
      uv: gl.getAttribLocation(program, "aUV"),
    },
    uniforms,
    geometry: { box, sphere, plane },
    whiteTexture: white,
  };
}

/** upper-left 3×3 of a column-major mat4 (the P1 normal matrix — the shader
 *  re-normalizes, good enough for the flat-shaded v0) */
function normalMatrix(model: Mat4): Float32Array {
  return new Float32Array([
    model[0]!, model[1]!, model[2]!,
    model[4]!, model[5]!, model[6]!,
    model[8]!, model[9]!, model[10]!,
  ]);
}

function geometryScale(node: SceneNode, props: SceneNodeProps): Vec3 | null {
  if (node.kind === "box") return props.boxSize;
  if (node.kind === "sphere") return [props.radius, props.radius, props.radius];
  if (node.kind === "plane") return [props.planeSize[0], props.planeSize[1], 1];
  return null;
}

/** model = world · S(geometry) — the unit shapes carry their authored size here,
 *  keeping the corpus-pinned world matrices free of geometry-local scale */
function modelMatrix(world: Mat4, scale: Vec3): Mat4 {
  const m = [...world];
  for (let i = 0; i < 3; i += 1) {
    m[0 + i] = m[0 + i]! * scale[0];
    m[4 + i] = m[4 + i]! * scale[1];
    m[8 + i] = m[8 + i]! * scale[2];
  }
  return m;
}

/** the largest world basis length — the uniform-enough scale text3d billboards ride
 *  (the worldBoundingSphere convention) */
function worldScale(world: Mat4): number {
  return Math.max(
    Math.hypot(world[0]!, world[1]!, world[2]!),
    Math.hypot(world[4]!, world[5]!, world[6]!),
    Math.hypot(world[8]!, world[9]!, world[10]!),
  );
}

/** the BILLBOARD law: model = T(world position) · R(view rotation transposed) ·
 *  S(quad size · world scale) — the quad always faces the camera */
function billboardMatrix(world: Mat4, view: Mat4, width: number, height: number): Mat4 {
  const scale = worldScale(world);
  const rotation: Mat4 = [
    view[0]!, view[4]!, view[8]!, 0,
    view[1]!, view[5]!, view[9]!, 0,
    view[2]!, view[6]!, view[10]!, 0,
    0, 0, 0, 1,
  ];
  const t: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, world[12]!, world[13]!, world[14]!, 1];
  return modelMatrix(mat4Multiply(t, rotation), [width * scale, height * scale, 1]);
}

/** rasterize a text3d value through canvas 2D — WHITE glyphs on transparency (uColor
 *  modulates), the canvas aspect matching the quad law so glyphs are not stretched */
function rasterizeText3d(value: string, characters: number): TexImageSource | null {
  const height = 64;
  const width = Math.max(1, Math.round(height * 0.6 * characters));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx2d = canvas.getContext("2d");
  if (ctx2d === null) return null;
  ctx2d.clearRect(0, 0, width, height);
  ctx2d.fillStyle = "#ffffff";
  ctx2d.textAlign = "center";
  ctx2d.textBaseline = "middle";
  ctx2d.font = `${Math.round(height * 0.78)}px sans-serif`;
  const measured = ctx2d.measureText(value).width;
  if (measured > width) ctx2d.setTransform(width / measured, 0, 0, 1, 0, 0);
  ctx2d.fillText(value, (measured > width ? measured : width) / 2, height / 2);
  return canvas;
}

// ── the element ──────────────────────────────────────────────────────────────────────

type ModelEntry =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; model: GlbModel; buffers: Array<{ mesh: number; primitive: GlBuffers; baseColor: [number, number, number, number]; source: GlbPrimitive }> };

const sceneFactory: ElementFactory = (node, ctx, api) => {
  const host = document.createElement("div");
  host.className = "dsx-scene";
  host.setAttribute("data-dsx-component", "scene");
  host.setAttribute("role", "img");
  api.bindText(node.attrs["a11yLabel"] ?? "3D scene", (v) => host.setAttribute("aria-label", v));

  // Article 7 diagnostics: fall back + say so ONCE per distinct message (console is the
  // dev channel every element here uses; the ledgered dsx.error hat is the native bus's)
  const reported = new Set<string>();
  const diag = (d: SceneDiagnostic): void => {
    if (reported.has(d.message)) return;
    reported.add(d.message);
    console.warn(`[dsx scene] ${d.message}`);
  };

  // ── prefabs (G1, dsx-game.md §2): a component whose body is scene content
  // instantiates by tag inside the scene subtree. The definition derives from the
  // EXISTING .dsx registry (resolveComponent — the same resolution mountComponent
  // uses); the kernel only sees the lookup seam, never a component name (rule 18).
  // per-scope caches: a tag means different things from different packages (the
  // defining-scope law) — each component's BODY resolves nested tags where the
  // component was declared, exactly as mountComponent's expansion does
  const prefabDefs = new Map<string, Map<string, ScenePrefabDef | null>>();
  const prefabLookupFor = (scheme: string): ScenePrefabLookup => (tag) => {
    let scoped = prefabDefs.get(scheme);
    if (scoped === undefined) { scoped = new Map(); prefabDefs.set(scheme, scoped); }
    const cached = scoped.get(tag);
    if (cached !== undefined) return cached;
    // registry-less mounts (bare harnesses) have no components — honest null
    const componentIr = (ctx.registry as typeof ctx.registry | undefined) === undefined
      ? null : resolveComponent(ctx.registry, scheme, tag);
    let def: ScenePrefabDef | null = null;
    if (componentIr !== null) {
      // the web head is parsed separately (ComponentIR) — its declared attributes
      // ARE the params; the template scan only serves the wrapper/inline shapes
      const derived = scenePrefabDefFromTemplate(componentIr.root as SceneMarkupNode);
      const headParams = componentIr.head.attributes.map((a) =>
        a.default !== undefined ? { name: a.as, default: a.default } : { name: a.as });
      def = {
        params: headParams.length > 0 ? headParams : derived.params,
        roots: derived.roots,
        lookup: prefabLookupFor(componentIr.scheme),
      };
    }
    scoped.set(tag, def);
    return def;
  };
  const prefabLookup: ScenePrefabLookup = prefabLookupFor(ctx.scheme);

  const ir: SceneIR = parseScene(node as SceneMarkupNode, diag, prefabLookup);

  // ── reactive resolution: every authored attribute binds through the SAME store path
  // as any other element (api.bindText per attr); resolved strings land in a cache the
  // kernel resolver reads, and any change coalesces into one redraw. P5 adds the
  // OVERRIDE PLANE on top: an active animation/transition/orbit writes the property's
  // resolved string, so the corpus-pinned kernel folds stay untouched — `resolve`
  // consults overrides first, `resolveBase` never does (the base an animation glides
  // back to / retargets toward).
  const cache = new Map<SceneNode | null, Map<string, string>>();
  const overrides = new Map<SceneNode, Map<string, string>>();
  const resolveBase: SceneResolve = (scNode, name, raw) => cache.get(scNode)?.get(name) ?? raw;
  const resolve: SceneResolve = (scNode, name, raw) => {
    if (scNode !== null) {
      const override = overrides.get(scNode)?.get(name);
      if (override !== undefined) return override;
    }
    return cache.get(scNode)?.get(name) ?? raw;
  };
  const setOverride = (scNode: SceneNode, name: string, value: string): void => {
    let bucket = overrides.get(scNode);
    if (bucket === undefined) { bucket = new Map(); overrides.set(scNode, bucket); }
    bucket.set(name, value);
  };
  const clearOverride = (scNode: SceneNode, name: string): void => {
    const bucket = overrides.get(scNode);
    if (bucket === undefined) return;
    bucket.delete(name);
    if (bucket.size === 0) overrides.delete(scNode);
  };
  const apis = new Map<SceneNode, ElementApi>();
  /** every node's enclosing scene node (an <animate>'s parent is its TARGET) */
  const parents = new Map<SceneNode, SceneNode>();
  let ready = false;
  /** G6: `fps` sprite clocks measure from the element's mount — the frame index is a
   *  pure function of elapsed seconds (the corpus fold), never its own timer */
  const spriteNodes = new Set<SceneNode>();
  let spriteEpoch = 0;
  const nowMs = (): number => typeof performance !== "undefined" ? performance.now() : Date.now();

  // ── physics hooks (G2) — declared before the binders that call them; the runtime
  // block below (pre-GL, renderer-independent) rebinds them
  let physicsAuthored = false;
  let physicsDirty = true;
  let physicsOnBaseWrite: (scNode: SceneNode | null, name: string, value: string) => void = () => {};
  let physicsBusInfo: (scNode: SceneNode) =>
    { grounded: boolean; sleeping: boolean; velocity: Vec3; rotation: Vec3;
      angularVelocity: Vec3; torque: Vec3 } | null = () => null;

  // ── collisions (P5): tracker identity is a per-node serial (authored ids may repeat
  // or be absent); the PAYLOAD carries the authored id ("" when none)
  let colliderSerial = 0;
  const colliderIds = new Map<SceneNode, string>();
  const trackerIdFor = (scNode: SceneNode): string => {
    let id = colliderIds.get(scNode);
    if (id === undefined) { id = `n${colliderSerial += 1}`; colliderIds.set(scNode, id); }
    return id;
  };
  const collisionTracker = createSceneCollisionTracker();

  // ── G3 clip mixers (one per `<model animation>` node) + the per-node dynamic
  // buffers CPU-skinned vertices re-upload into each sampled frame
  const clipMixers = new Map<SceneNode, SceneClipMixer>();
  const skinnedCache = new Map<SceneNode, Map<string, GlBuffers>>();

  // ── implicit transitions (P5): base change ⇒ retarget from the CURRENT RENDERED
  // value (the CSS interrupt model — never snap, never queue)
  type TransitionRec = { entry: SceneTransitionEntry; state: SceneTransitionState };
  const transitions = new Map<SceneNode, Map<SceneAnimTarget, TransitionRec>>();
  const transitionParse = new Map<SceneNode, { source: string; entries: SceneTransitionEntry[] }>();
  const transitionEntriesFor = (scNode: SceneNode): SceneTransitionEntry[] => {
    const raw = scNode.attrs["transition"];
    if (raw === undefined) return [];
    const source = resolveBase(scNode, "transition", raw);
    const cached = transitionParse.get(scNode);
    if (cached !== undefined && cached.source === source) return cached.entries;
    const entries = parseSceneTransitions(source, diag);
    transitionParse.set(scNode, { source, entries });
    return entries;
  };

  // ── explicit tweens (P5): one record per <animate>, evaluated by the kernel
  type AnimRec = {
    node: SceneNode; target: SceneNode;
    playing: boolean; finished: boolean; doneFired: boolean;
    startMs: number; spec: SceneTweenSpec | null; from: number[] | null;
  };
  const animations = new Map<SceneNode, AnimRec>();
  const FALSY_WHEN = new Set(["", "false", "0", "null", "undefined"]);
  const gateOpen = (animNode: SceneNode): boolean => {
    const raw = animNode.attrs["when"];
    if (raw === undefined) return true;
    return !FALSY_WHEN.has(resolveBase(animNode, "when", raw).trim());
  };
  /** the property's BASE on the animation value plane (what a finished tween returns to) */
  const baseValueFor = (scNode: SceneNode, target: SceneAnimTarget): number[] => {
    const props = resolvedProps(scNode, resolveBase, diag);
    switch (target) {
      case "position": return [...props.position];
      case "rotation": return [...props.rotation];
      case "scale": return [...props.scale];
      case "intensity": return [props.intensity];
      case "fov": return [props.fov];
      case "color": return parseSceneAnimValue("color", props.color) ?? [1, 1, 1];
    }
  };
  /** an ACTIVE explicit tween owns its property — implicit transitions yield to it */
  const tweenOwns = (scNode: SceneNode, target: SceneAnimTarget): boolean => {
    for (const rec of animations.values()) {
      if (rec.target === scNode && rec.playing && !rec.finished && rec.spec?.target === target) return true;
    }
    return false;
  };

  const maybeRetarget = (scNode: SceneNode, name: string, previousValue: string, nextValue: string): void => {
    if (!SCENE_ANIM_TARGETS.has(name)) return;
    const target = name as SceneAnimTarget;
    const entry = transitionEntriesFor(scNode).find((e) => e.property === target);
    if (entry === undefined || tweenOwns(scNode, target)) return;
    const to = parseSceneAnimValue(target, nextValue);
    // start from where you are: the mid-flight override when one exists, else the old base
    const from = parseSceneAnimValue(target, overrides.get(scNode)?.get(name) ?? previousValue);
    if (to === null || from === null) return;
    let bucket = transitions.get(scNode);
    if (bucket === undefined) { bucket = new Map(); transitions.set(scNode, bucket); }
    bucket.set(target, { entry, state: { from, to, startMs: nowMs() } });
    setOverride(scNode, name, formatSceneAnimValue(target, from));
  };

  const bindAttrs = (scNode: SceneNode | null, xml: XmlNode, childApi: ElementApi): void => {
    const bucket = new Map<string, string>();
    cache.set(scNode, bucket);
    for (const [name, raw] of Object.entries(xml.attrs)) {
      if (name.startsWith("on:") || name === "id" || name === "__css") continue;
      childApi.bindText(raw, (v) => {
        const previous = bucket.get(name);
        if (previous === v) return;
        bucket.set(name, v);
        if (!ready) return;
        if (scNode !== null && previous !== undefined) maybeRetarget(scNode, name, previous, v);
        physicsOnBaseWrite(scNode, name, v);
        ensureLoop();
        scheduleRender();
      });
    }
  };
  bindAttrs(null, node, api);

  // ── bound groups (P5): `<group bind key>` — keyed rows of the template subtree
  type RowRec = { key: string; rowCtx: MountCtx; nodes: SceneNode[]; raw: unknown; index: number };
  type BoundGroup = { template: SceneNode[]; rows: Map<string, RowRec>; order: string[] };
  const boundGroups = new Map<SceneNode, BoundGroup>();

  const rowItem = (parent: Record<string, unknown> | null, raw: unknown, index: number): Record<string, unknown> =>
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(parent ?? {}), ...(raw as Record<string, unknown>), index }
      : { ...(parent ?? {}), value: raw, index };

  const dropNodeState = (nodes: readonly SceneNode[]): void => {
    for (const gone of nodes) {
      cache.delete(gone);
      overrides.delete(gone);
      apis.delete(gone);
      parents.delete(gone);
      transitions.delete(gone);
      transitionParse.delete(gone);
      animations.delete(gone); // removing a row STOPS its animations (the bind law)
      clipMixers.delete(gone); // …and its clips (G3)
      skinnedCache.delete(gone);
      colliderIds.delete(gone);
      spriteNodes.delete(gone);
      const group = boundGroups.get(gone);
      if (group !== undefined) {
        for (const row of group.rows.values()) {
          row.rowCtx.disposers.forEach((d) => d());
          dropNodeState(row.nodes);
        }
        boundGroups.delete(gone);
      }
      dropNodeState(gone.children);
    }
  };

  const setupBoundGroup = (groupNode: SceneNode, scopeCtx: MountCtx, groupApi: ElementApi): void => {
    const keyField = groupNode.attrs["key"] ?? "id";
    const record: BoundGroup = { template: [...groupNode.children], rows: new Map(), order: [] };
    boundGroups.set(groupNode, record);
    (groupNode as unknown as { children: SceneNode[] }).children = [];
    ctx.disposers.push(() => {
      for (const row of record.rows.values()) row.rowCtx.disposers.forEach((d) => d());
    });
    groupApi.bindValue(groupNode.attrs["bind"]!, (value) => {
      const rows = sceneBindRows(value, keyField, diag);
      const diff = diffSceneBindRows(record.order, rows);
      for (const key of diff.removed) {
        const gone = record.rows.get(key);
        if (gone === undefined) continue;
        gone.rowCtx.disposers.forEach((d) => d());
        dropNodeState(gone.nodes);
        record.rows.delete(key);
      }
      const nextChildren: SceneNode[] = [];
      for (const row of rows) {
        let rec = record.rows.get(row.key);
        if (rec === undefined) {
          const rowCtx = adoptInternals.subCtx(scopeCtx, {
            item: rowItem(scopeCtx.item as Record<string, unknown> | null, row.item, row.index),
            itemRefresh: { listeners: new Set() },
          });
          const nodes = instantiateSceneRow(record.template);
          walkNodes(nodes, groupNode, rowCtx);
          rec = { key: row.key, rowCtx, nodes, raw: row.item, index: row.index };
          record.rows.set(row.key, rec);
          // an ENCLOSING scope refresh (a prefab instance scope, an outer row) must
          // reach this row too: re-derive the row item from the LIVE parent item and
          // cascade — without this, rows spawned inside a prefab body keep the scope
          // values they were born with (the review's three-renderer divergence)
          const parentRefresh = scopeCtx.itemRefresh;
          if (parentRefresh !== undefined && parentRefresh !== null) {
            const bound = rec;
            const chain = (): void => {
              bound.rowCtx.item = rowItem(scopeCtx.item as Record<string, unknown> | null, bound.raw, bound.index);
              for (const listener of [...(bound.rowCtx.itemRefresh?.listeners ?? [])]) listener();
            };
            parentRefresh.listeners.add(chain);
            rowCtx.disposers.push(() => parentRefresh.listeners.delete(chain));
          }
        } else if (rec.raw !== row.item || rec.index !== row.index) {
          // keyed identity survives: same subtree, refreshed row scope (the list law)
          rec.rowCtx.item = rowItem(scopeCtx.item as Record<string, unknown> | null, row.item, row.index);
          rec.raw = row.item;
          rec.index = row.index;
          for (const listener of [...(rec.rowCtx.itemRefresh?.listeners ?? [])]) listener();
        }
        nextChildren.push(...rec.nodes);
      }
      record.order = rows.map((r) => r.key);
      (groupNode as unknown as { children: SceneNode[] }).children = nextChildren;
      // Re-extract only when the keyed structure actually changed. Reactive stores may
      // re-evaluate a bind on every unrelated state write (GameDemo's on:tick counter is
      // one); rebuilding an unchanged body set would discard the persistent warm-start
      // cache every tick and keep an otherwise motionless pile awake forever.
      if (diff.added.length > 0 || diff.removed.length > 0) physicsDirty = true;
      if (ready) { ensureLoop(); scheduleRender(); }
    });
  };

  /** G1: a prefab instance's body binds in the INSTANCE SCOPE — params resolved at the
   *  instance site (the enclosing scope), per instance (the corpus scope law). The
   *  scope rides the item plane exactly like a bound row: a subCtx whose `item` is the
   *  live scope dict, refreshed reactively through the SAME contextEffect machinery
   *  mountComponent uses for reactive props. */
  const makePrefabCtx = (scNode: SceneNode, scopeCtx: MountCtx): MountCtx => {
    const scopeItem: Record<string, unknown> = {};
    const instCtx = adoptInternals.subCtx(scopeCtx, {
      item: scopeItem, itemRefresh: { listeners: new Set<() => void>() },
    });
    adoptInternals.adoptDisposers(scopeCtx, instCtx);
    const notify = (): void => {
      for (const listener of [...(instCtx.itemRefresh?.listeners ?? [])]) listener();
    };
    for (const [name, raw] of Object.entries(scNode.prefab?.scope ?? {})) {
      if (!raw.includes("{{")) { scopeItem[name] = raw; continue; }
      scopeCtx.disposers.push(adoptInternals.contextEffect(scopeCtx,
        () => scopeCtx.store.interpolate(raw, scopeCtx.item),
        (v) => {
          scopeItem[name] = v;
          notify();
          if (ready) { ensureLoop(); scheduleRender(); }
        },
      ));
    }
    return instCtx;
  };

  const walkNodes = (nodes: readonly SceneNode[], parent: SceneNode | null, scopeCtx: MountCtx): void => {
    for (const scNode of nodes) {
      if (parent !== null) parents.set(scNode, parent);
      if (scNode.attrs["physics"] !== undefined) physicsAuthored = true;
      if (scNode.kind === "sprite") spriteNodes.add(scNode);
      const xml = scNode.source as XmlNode | undefined;
      let childApi: ElementApi | undefined;
      if (xml !== undefined) {
        childApi = adoptInternals.makeApi(xml, scopeCtx);
        apis.set(scNode, childApi);
        bindAttrs(scNode, xml, childApi);
      }
      if (scNode.prefab !== undefined) {
        // the instance tag's own attrs (transforms) bound above in the ENCLOSING
        // scope; the body descends into the per-instance scope ctx
        walkNodes(scNode.children, scNode, makePrefabCtx(scNode, scopeCtx));
        continue;
      }
      if (scNode.kind === "animate") {
        if (parent === null || parent.kind === "animate") {
          diag({ code: "malformed-animation", message: "<animate> must be the child of the node it animates — inert" });
          continue;
        }
        animations.set(scNode, {
          node: scNode, target: parent,
          playing: false, finished: false, doneFired: false, startMs: 0, spec: null, from: null,
        });
        continue;
      }
      if (scNode.kind === "group" && scNode.attrs["bind"] !== undefined && childApi !== undefined) {
        setupBoundGroup(scNode, scopeCtx, childApi);
        continue; // template children instantiate per row, never statically
      }
      walkNodes(scNode.children, scNode, scopeCtx);
    }
  };
  walkNodes(ir.nodes, null, ctx);

  // ── the scene BUS handle (dsx-game.md G5): registered into the kernel SceneRegistry
  // seam so the Core/Scene module — and through it any module, action, or MCP agent —
  // can query/drive this element. Registered BEFORE the renderer exists, so a
  // WebGL-less environment still answers nodes/set/pick/stats honestly (capture then
  // answers null → the module's typed capture_failed). The render hooks are rebound
  // once the renderer stands up; in the fallback they stay no-ops.
  const cameraNode = ir.nodes.find((n) => n.kind === "camera") ?? null;
  let busScheduleRender: () => void = () => {};
  let busEnsureLoop: () => void = () => {};
  let busCapture: () => SceneBusCapture | null = () => null;
  let lastFrameDt = 0;

  /** a bus write lands on the resolved-attribute BASE plane (the same cache a store
   *  write feeds), so `transition=`-covered properties glide — never a second path */
  const busWriteBase = (scNode: SceneNode, name: string, value: string): void => {
    let bucket = cache.get(scNode);
    if (bucket === undefined) { bucket = new Map(); cache.set(scNode, bucket); }
    const previous = bucket.get(name) ?? scNode.attrs[name];
    // THE OVERRIDE-AWARE DEDUPE (found by the G6 2D walk): while a property is
    // SOLVER- or animation-OWNED the base cache still holds the SPAWN string, so a bus
    // write of that same string — "put the crate back where it started" — is a real
    // command, not a no-op. Dedupe only when nothing is overriding the property.
    // THE IMPULSE-VERB EXEMPTION (the G2 law): a `velocity` write on a body is a
    // COMMAND, never state — firing the same impulse twice is two impulses. The JVM
    // and iOS bus adapters force every physics write; without this the web deduped a
    // re-issued identical impulse into a no-op (the second fire() launched nothing).
    const isImpulse = (name === "velocity" || name === "angular-velocity" || name === "torque")
      && physicsBodies.has(scNode);
    if (previous === value && !isImpulse && overrides.get(scNode)?.get(name) === undefined) return;
    bucket.set(name, value);
    if (previous !== undefined) maybeRetarget(scNode, name, previous, value);
    physicsOnBaseWrite(scNode, name, value);
    busEnsureLoop();
    busScheduleRender();
  };

  const busCountNodes = (list: readonly SceneNode[]): number =>
    list.reduce((acc, n) => n.kind === "animate" ? acc : acc + 1 + busCountNodes(n.children), 0);

  const busHandle: SceneBusHandle = {
    id: node.attrs["id"] ?? null,
    nodes() {
      const worlds = worldMatrices(ir.nodes, resolve, diag);
      const toBus = (list: readonly SceneNode[]): SceneBusNode[] =>
        list.filter((n) => n.kind !== "animate").map((n) => {
          const p = resolvedProps(n, resolve, diag);
          const props: { [name: string]: string } = {
            position: formatSceneAnimValue("position", p.position),
            rotation: formatSceneAnimValue("rotation", p.rotation),
            scale: formatSceneAnimValue("scale", p.scale),
            color: p.color,
          };
          for (const [name, raw] of Object.entries(n.attrs)) {
            if (name.startsWith("on:") || name === "id" || name === "__css") continue;
            props[name] = resolve(n, name, raw);
          }
          // bus-written attrs the author never spelled (a set on an unauthored attr —
          // e.g. the G2 `move` intent) live on the base cache: the read shows them too
          const bucket = cache.get(n);
          if (bucket !== undefined) {
            for (const [name, value] of bucket) {
              if (name.startsWith("on:") || name === "id" || name === "__css") continue;
              if (props[name] === undefined) props[name] = resolve(n, name, value);
            }
          }
          // G2: a physics body's solver state rides the read (grounded exposed here)
          const physics = physicsBusInfo(n);
          if (physics !== null) {
            props["grounded"] = String(physics.grounded);
            props["sleeping"] = String(physics.sleeping);
            props["velocity"] = formatSceneAnimValue("position", physics.velocity);
            props["rotation"] = formatSceneAnimValue("rotation", physics.rotation);
            props["angular-velocity"] = formatSceneAnimValue("position", physics.angularVelocity);
            props["torque"] = formatSceneAnimValue("position", physics.torque);
          }
          const world = worlds.get(n);
          return {
            kind: n.kind, id: n.id ?? "", props,
            world: world === undefined ? null : [world[12]!, world[13]!, world[14]!],
            children: toBus(n.children),
          };
        });
      return toBus(ir.nodes);
    },
    set(id, attr, value) {
      if (attr.startsWith("on:") || attr === "id" || attr === "__css") return "bad_attr";
      const scNode = findSceneNode(ir.nodes, id);
      if (scNode === null) return "node_not_found";
      busWriteBase(scNode, attr, value);
      return "ok";
    },
    camera() {
      if (cameraNode === null) {
        // the corpus defaults (parse.json): no <camera> authored — readable, not movable
        return { position: "0 0 5", lookAt: "0 0 0", fov: 60, authored: false };
      }
      const p = resolvedProps(cameraNode, resolve, diag);
      return {
        position: formatSceneAnimValue("position", p.position),
        lookAt: formatSceneAnimValue("position", p.lookAt),
        fov: p.fov, authored: true,
      };
    },
    cameraSet(spec) {
      if (cameraNode === null) return "no_camera";
      if (spec.lookAt !== undefined) {
        const parsed = parseSceneAnimValue("position", spec.lookAt);
        if (parsed === null || parsed.length < 3) return "bad_value";
        busWriteBase(cameraNode, "look-at", formatSceneAnimValue("position", parsed));
      }
      if (spec.position !== undefined) {
        const parsed = parseSceneAnimValue("position", spec.position);
        if (parsed === null || parsed.length < 3) return "bad_value";
        busWriteBase(cameraNode, "position", formatSceneAnimValue("position", parsed));
      }
      if (spec.flyTo !== undefined) {
        const to = parseSceneAnimValue("position", spec.flyTo);
        if (to === null || to.length < 3) return "bad_value";
        // the P5 transition path, EASE-OUT (the documented choice): glide from the
        // CURRENT RENDERED position (never snap), base holds the destination
        const from = [...resolvedProps(cameraNode, resolve, diag).position];
        const durationMs = typeof spec.durationMs === "number" && spec.durationMs > 0 ? spec.durationMs : 600;
        let bucket = transitions.get(cameraNode);
        if (bucket === undefined) { bucket = new Map(); transitions.set(cameraNode, bucket); }
        bucket.set("position", {
          entry: { property: "position", durationMs, easing: parseSceneEasing("ease-out"), delayMs: 0 },
          state: { from, to, startMs: nowMs() },
        });
        setOverride(cameraNode, "position", formatSceneAnimValue("position", from));
        busWriteBase(cameraNode, "position", formatSceneAnimValue("position", to));
        busEnsureLoop();
        busScheduleRender();
      }
      return "ok";
    },
    capture() { return busCapture(); },
    pick(x, y) {
      const width = canvasSizeForPick().width, height = canvasSizeForPick().height;
      const camera = sceneCamera(ir, resolve, width / height, diag);
      const ray = pickRay(camera.proj, camera.view, x * 2 - 1, -(y * 2 - 1));
      if (ray === null) return null;
      const worlds = worldMatrices(ir.nodes, resolve, diag);
      let best: { scNode: SceneNode; t: number } | null = null;
      for (const [scNode, world] of worlds) {
        const props = resolvedProps(scNode, resolve, diag);
        const localRadius = nodeBoundingRadius(scNode, props);
        if (localRadius === null) continue;
        const sphere = worldBoundingSphere(world, localRadius);
        const t = raySphere(ray.origin, ray.dir, sphere.center, sphere.radius);
        if (t !== null && (best === null || t < best.t)) best = { scNode, t };
      }
      return best === null ? null : { id: best.scNode.id ?? "", kind: best.scNode.kind };
    },
    contacts() {
      const worlds = worldMatrices(ir.nodes, resolve, diag);
      const shapes: SceneColliderShape[] = [];
      const authoredIds = new Map<string, string>();
      for (const [scNode, world] of worlds) {
        const props = resolvedProps(scNode, resolve, diag);
        if (props.collide.length === 0) continue;
        const tid = trackerIdFor(scNode);
        const shape = sceneColliderFor(scNode, props, world, tid);
        if (shape !== null) { shapes.push(shape); authoredIds.set(tid, scNode.id ?? ""); }
      }
      return sceneContacts(shapes).map((c) => ({
        a: authoredIds.get(c.a) ?? "", b: authoredIds.get(c.b) ?? "", depth: c.depth,
      }));
    },
    stats() {
      let animationCount = 0;
      for (const bucket of transitions.values()) animationCount += bucket.size;
      for (const rec of animations.values()) if (rec.playing && !rec.finished) animationCount += 1;
      let boundRows = 0;
      for (const group of boundGroups.values()) boundRows += group.rows.size;
      return { nodes: busCountNodes(ir.nodes), animations: animationCount, lastFrameDt, boundRows };
    },
  };
  const busKey = sceneBusRegister(busHandle);
  ctx.disposers.push(() => sceneBusUnregister(busKey));
  /** the pick plane's pixel size — the live canvas when one exists, else the 16:9 box */
  let canvasSizeForPick = (): { width: number; height: number } => ({ width: 16, height: 9 });

  // ── physics (G2): the fixed-tick solver runtime. Renderer-INDEPENDENT and placed
  // before the WebGL adapter (the bus-handle precedent) so a WebGL-less environment
  // still answers the module-face writes/reads honestly — the rAF loop below is what
  // drives stepping. All numbers live in @despia/kernel scene/physics.ts (corpus
  // physics.json); this block owns only extraction wiring, intents, events and the
  // interpolated position and rotation overrides.
  const physicsAccumulator = createScenePhysicsAccumulator();
  let physicsWorld: ScenePhysicsWorld | null = null;
  const physicsNodes = new Map<string, SceneNode>();   // body id → node
  const physicsBodies = new Map<SceneNode, string>();  // node → body id
  /** a loaded model's local half extents (post-GL rebind; [0.5,0.5,0.5] until known) */
  let physicsModelHalf: (scNode: SceneNode) => Vec3 | null = () => null;

  const rebuildPhysics = (): void => {
    physicsDirty = false;
    const previousWorld = physicsWorld;
    const previousNodes = new Map(physicsNodes);
    physicsNodes.clear();
    physicsBodies.clear();
    const extraction = extractScenePhysics(ir, resolveBase, diag, (n) => physicsModelHalf(n));
    if (extraction.bodies.length === 0) { physicsWorld = null; return; }
    // G6: a mode="2d" scene builds a Z-LOCKED world — the SAME solver, one flag
    const nextWorld = createScenePhysicsWorld(extraction.gravity, extraction.bodies, extraction.mode2d);
    nextWorld.bodies.forEach((body, i) => {
      const scNode = extraction.bodies[i]!.node;
      physicsNodes.set(body.id, scNode);
      physicsBodies.set(scNode, body.id);
    });
    if (previousWorld !== null) {
      carryScenePhysicsState(previousWorld, nextWorld, previousNodes, physicsNodes);
    }
    physicsWorld = nextWorld;
  };

  const ensurePhysicsWorld = (): void => {
    if (!physicsAuthored) return;
    if (physicsDirty) rebuildPhysics();
  };

  /** THE LOOP-EXISTENCE LAW, EXTENDED (G2): the loop also runs while any dynamic body
   *  is AWAKE or any character exists — a fully-asleep world stops it (and on:tick) */
  const physicsWants = (): boolean => {
    if (!physicsAuthored) return false;
    ensurePhysicsWorld();
    if (physicsWorld === null) return false;
    for (const body of physicsWorld.bodies) {
      if (body.kind === "character") return true;
      if (body.kind === "dynamic" && !body.sleeping) return true;
    }
    return false;
  };

  const physicsMoveIntent = (scNode: SceneNode): [number, number] | null => {
    // the total-resolve law: an UNAUTHORED move still consults the resolver with the
    // empty default, so a bus `scene.set(id, "move", …)` intent drives a character
    // with no markup attr — the same write path Android and iOS honor
    const resolved = resolve(scNode, "move", scNode.attrs["move"] ?? "").trim();
    if (resolved.length === 0) return null;
    const parts = resolved.split(/\s+/);
    const x = Number(parts[0]);
    const z = Number(parts[1]);
    if (parts.length !== 2 || !Number.isFinite(x) || !Number.isFinite(z)) {
      diag({ code: "malformed-vector", message: `move="${resolved}" is not 2 numbers — no intent` });
      return null;
    }
    return [x, z];
  };

  /** THE PARENT-FRAME LAW: bodies simulate in scene-root space, but a node's `position`
   *  is LOCAL to its parent (the renderer composes parentWorld · local). A body at the
   *  scene root needs nothing (null, the fast path); a nested one — every G1 prefab
   *  instance, since the expansion root carries the instance transform — needs its
   *  parent's world matrix so the solver result can be expressed in that frame. */
  let physicsParentWorlds: Map<SceneNode, Mat4> | null = null;
  const physicsParentWorld = (scNode: SceneNode): Mat4 | null => {
    const parent = parents.get(scNode);
    if (parent === undefined || parent === null) return null;
    if (physicsParentWorlds === null) {
      // one pass per write, and only when some body is actually nested
      physicsParentWorlds = new Map();
      for (const [node, world] of worldMatrices(ir.nodes, resolve, diag)) physicsParentWorlds.set(node, world);
    }
    return physicsParentWorlds.get(parent) ?? null;
  };

  /** Interpolated solver overrides. Solver poses are scene-root values; both
   * position and orientation are expressed in the node's parent frame before the
   * renderer composes them. */
  const physicsWriteOverrides = (alpha: number): void => {
    physicsParentWorlds = null;   // the pass's cache: parents may have animated
    for (const body of physicsWorld!.bodies) {
      if (body.kind !== "dynamic" && body.kind !== "character") continue;
      const scNode = physicsNodes.get(body.id);
      if (scNode === undefined) continue;
      const rendered = scenePhysicsInterpolate(body.previous, body.position, alpha);
      const local = scenePhysicsToLocal(rendered, physicsParentWorld(scNode));
      setOverride(scNode, "position", formatSceneAnimValue("position", local));
      if (body.kind === "dynamic") {
        const renderedRotation = scenePhysicsInterpolate(
          body.previousRotation, body.rotation, alpha,
        );
        const priorLocal = resolvedProps(scNode, resolve, diag).rotation;
        const localRotation = scenePhysicsRotationToLocal(
          renderedRotation, physicsParentWorld(scNode), priorLocal,
        );
        setOverride(scNode, "rotation", formatSceneAnimValue("rotation", localRotation));
      }
    }
  };

  /** the loop's fixed-tick driver: accumulate the frame's dt, step 0..5 times (the
   *  kernel cap), dispatch on:collision/on:enter/on:exit/on:tick through the SAME
   *  runner path as on:tap, then interpolate */
  const advancePhysics = (frameSeconds: number): void => {
    ensurePhysicsWorld();
    if (physicsWorld === null) return;
    const { steps, alpha } = physicsAccumulator.advance(frameSeconds);
    for (let s = 0; s < steps; s += 1) {
      const intents: { [id: string]: { move?: [number, number]; position?: Vec3; rotation?: Vec3 } } = {};
      for (const body of physicsWorld.bodies) {
        const scNode = physicsNodes.get(body.id);
        if (scNode === undefined) continue;
        if (body.kind === "kinematic") {
          // kinematics follow the RESOLVED plane — store writes, bus set and
          // animations all move them; the solver derives their push velocity
          const props = resolvedProps(scNode, resolve, diag);
          const parentWorld = physicsParentWorld(scNode);
          intents[body.id] = {
            position: scenePhysicsToRoot(props.position, parentWorld),
            rotation: scenePhysicsRotationToRoot(props.rotation, parentWorld, body.rotation),
          };
        } else if (body.kind === "character") {
          const move = physicsMoveIntent(scNode);
          if (move !== null) intents[body.id] = { move };
        }
      }
      const result = stepScenePhysicsWorld(physicsWorld, intents as ScenePhysicsIntents);
      const firePair = (handlerName: string, event: { id: string; other: string }): void => {
        const scNode = physicsNodes.get(event.id);
        if (scNode === undefined) return;
        apis.get(scNode)?.handler(handlerName, {
          id: scNode.id ?? "",
          other: physicsNodes.get(event.other)?.id ?? "",
        });
      };
      for (const e of result.collisions) firePair("collision", e);
      for (const e of result.enters) firePair("enter", e);
      for (const e of result.exits) firePair("exit", e);
      if (api.hasHandler("tick")) api.handler("tick", { dt: result.dt, tick: result.tick });
    }
    physicsWriteOverrides(alpha);
  };

  physicsOnBaseWrite = (scNode, name, value) => {
    if (!physicsAuthored) return;
    if (scNode === null) {
      if (name === "gravity") physicsDirty = true;
      return;
    }
    if (name === "physics" || name === "collider" || name === "mass" || name === "bounce"
      || name === "friction" || name === "trigger" || name === "layer" || name === "collides"
      || name === "speed" || name === "jump" || name === "size" || name === "radius"
      || name === "angular-damping") {
      physicsDirty = true; // a body-shaping attr changed — re-extract (extents re-freeze)
      return;
    }
    if (name !== "position" && name !== "velocity" && name !== "rotation"
      && name !== "angular-velocity" && name !== "torque") return;
    ensurePhysicsWorld();
    if (physicsWorld === null) return;
    const id = physicsBodies.get(scNode);
    if (id === undefined) return;
    const body = physicsWorld.byId.get(id);
    if (body === undefined) return;
    if (body.kind === "kinematic") {
      // THE V1 WAKE LAW: a kinematic position write wakes the world (no island graph
      // — the named absence); the write itself lands through the per-step intents
      if (name === "position" || name === "rotation") scenePhysicsWakeAll(physicsWorld);
      return;
    }
    if (body.kind === "static") return;
    const parsed = parseSceneAnimValue(name === "rotation" ? "rotation" : "position", value);
    if (parsed === null || parsed.length < 3) return;
    const triple: Vec3 = [parsed[0]!, parsed[1]!, parsed[2]!];
    if (name === "position") {
      // THE TELEPORT LAW: a base position write on a dynamic/character body moves it
      // and RESETS velocity — never a glide (any transition on position yields). The
      // authored value is LOCAL to the node's parent; the solver speaks root space.
      physicsParentWorlds = null;
      const parentWorld = physicsParentWorld(scNode);
      scenePhysicsTeleport(physicsWorld, id, scenePhysicsToRoot(triple, parentWorld));
      const bucket = transitions.get(scNode);
      if (bucket !== undefined) {
        bucket.delete("position");
        if (bucket.size === 0) transitions.delete(scNode);
      }
      setOverride(scNode, "position", formatSceneAnimValue("position", triple));
    } else if (name === "rotation") {
      physicsParentWorlds = null;
      const parentWorld = physicsParentWorld(scNode);
      scenePhysicsTeleportRotation(
        physicsWorld, id, scenePhysicsRotationToRoot(triple, parentWorld, body.rotation),
      );
      const bucket = transitions.get(scNode);
      if (bucket !== undefined) {
        bucket.delete("rotation");
        if (bucket.size === 0) transitions.delete(scNode);
      }
      setOverride(scNode, "rotation", formatSceneAnimValue("rotation", triple));
    } else if (name === "velocity") {
      // THE VELOCITY-WRITE LAW: the attribute-shaped impulse verb (jump() is
      // `set velocity "0 <jump> 0"` through the bus)
      scenePhysicsWriteVelocity(physicsWorld, id, triple);
    } else if (name === "angular-velocity") {
      scenePhysicsWriteAngularVelocity(physicsWorld, id, triple);
    } else {
      scenePhysicsWriteTorque(physicsWorld, id, triple);
    }
  };

  physicsBusInfo = (scNode) => {
    if (!physicsAuthored) return null;
    ensurePhysicsWorld();
    if (physicsWorld === null) return null;
    const id = physicsBodies.get(scNode);
    if (id === undefined) return null;
    const body = physicsWorld.byId.get(id);
    if (body === undefined) return null;
    return {
      grounded: body.grounded, sleeping: body.sleeping,
      velocity: [...body.velocity] as Vec3,
      rotation: [...body.rotation] as Vec3,
      angularVelocity: [...body.angularVelocity] as Vec3,
      torque: [...body.torque] as Vec3,
    };
  };

  // ── the honest placeholder for scheduled rows (P3: mode="ar" + <anchor>) —
  // INSIDE the scene box, never blank, never fake. model/text3d render for real (P4).
  const scheduled: string[] = [];
  if (ir.mode === "ar") scheduled.push('mode="ar" (P3)');
  const collectScheduled = (nodes: readonly SceneNode[]): void => {
    for (const scNode of nodes) {
      if (SCENE_SCHEDULED_KINDS.has(scNode.kind)) scheduled.push(`<${scNode.kind}> (P3)`);
      collectScheduled(scNode.children);
    }
  };
  collectScheduled(ir.nodes);
  if (scheduled.length > 0) {
    const notice = document.createElement("div");
    notice.className = "dsx-scene-scheduled";
    notice.setAttribute("role", "note");
    notice.textContent = `Scheduled per dsx-scene.md: ${[...new Set(scheduled)].join(" · ")}`;
    host.appendChild(notice);
  }

  // ── the canvas + WebGL adapter (client-only; SSR emits the sized box)
  const canvas = document.createElement("canvas");
  canvas.className = "dsx-scene-canvas";
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);
  const state = initGl(canvas);
  if (state === null) {
    // honest fallback: WebGL missing (headless/legacy) — label the box, keep the size
    canvas.remove();
    const fallback = document.createElement("div");
    fallback.className = "dsx-scene-fallback";
    fallback.setAttribute("role", "note");
    fallback.textContent = "<scene> — WebGL is unavailable in this browser";
    host.appendChild(fallback);
    return host;
  }

  let disposed = false;
  ctx.disposers.push(() => { disposed = true; });

  // ── P4 asset caches: textures by URL, models by src, text3d rasters by value ───────
  // Loads ride the media-surface posture (safeMediaUrl; CORS-anonymous — WebGL upload
  // needs untainted pixels) and re-render on arrival. A failed load diags + stays absent.
  const textures = new Map<string, WebGLTexture | "loading" | "error">();
  /** G6: a loaded image's width/height — the unauthored sprite `size` derives its WIDTH
   *  from this aspect at 1 unit tall (1 until the image arrives — the honest square) */
  const textureAspects = new Map<string, number>();
  const models = new Map<string, ModelEntry>();
  const textRasters = new Map<string, WebGLTexture | "error">();

  const textureFor = (url: string): WebGLTexture | null => {
    const entry = textures.get(url);
    if (entry !== undefined) return entry === "loading" || entry === "error" ? null : entry;
    const safe = safeMediaUrl(url);
    if (safe === null) {
      textures.set(url, "error");
      diag({ code: "malformed-number", message: `texture="${url}" is not a loadable image URL — untextured` });
      return null;
    }
    textures.set(url, "loading");
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (disposed) return;
      if (image.naturalHeight > 0) textureAspects.set(url, image.naturalWidth / image.naturalHeight);
      const texture = uploadTexture(state.gl, image);
      textures.set(url, texture ?? "error");
      scheduleRender();
    };
    image.onerror = () => {
      textures.set(url, "error");
      diag({ code: "malformed-number", message: `texture="${url}" failed to load — untextured` });
    };
    image.src = safe;
    return null;
  };

  const modelFor = (src: string): ModelEntry => {
    const entry = models.get(src);
    if (entry !== undefined) return entry;
    const safe = safeMediaUrl(src);
    if (safe === null) {
      diag({ code: "malformed-number", message: `<model src="${src}"> is not a loadable URL — not drawn` });
      const errored: ModelEntry = { state: "error" };
      models.set(src, errored);
      return errored;
    }
    const loading: ModelEntry = { state: "loading" };
    models.set(src, loading);
    void fetch(safe, { mode: "cors", credentials: "omit" })
      .then((response) => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`http ${response.status}`)))
      .then((buffer) => {
        if (disposed) return;
        const result = parseGlb(new Uint8Array(buffer));
        if (!result.ok) {
          diag({ code: "malformed-number", message: `<model src="${src}"> did not parse (${result.error}) — not drawn` });
          models.set(src, { state: "error" });
          return;
        }
        const buffers: Array<{ mesh: number; primitive: GlBuffers; baseColor: [number, number, number, number]; source: GlbPrimitive }> = [];
        result.model.meshes.forEach((mesh, meshIndex) => {
          for (const primitive of mesh.primitives) {
            const geometry = modelPrimitiveGeometry(primitive.positions, primitive.normals, primitive.indices);
            const uploaded = uploadGeometry(state.gl, geometry);
            if (uploaded !== null) buffers.push({ mesh: meshIndex, primitive: uploaded, baseColor: primitive.baseColor, source: primitive });
          }
        });
        models.set(src, { state: "ready", model: result.model, buffers });
        if (physicsAuthored) physicsDirty = true; // model bounds arrived — re-freeze
        scheduleRender();
      })
      .catch((error: unknown) => {
        diag({ code: "malformed-number", message: `<model src="${src}"> failed to load (${String(error)}) — not drawn` });
        models.set(src, { state: "error" });
      });
    return loading;
  };

  const textRasterFor = (value: string, characters: number): WebGLTexture | null => {
    const key = `${characters}${value}`;
    const cached = textRasters.get(key);
    if (cached !== undefined) return cached === "error" ? null : cached;
    const source = rasterizeText3d(value, characters);
    const texture = source === null ? null : uploadTexture(state.gl, source);
    textRasters.set(key, texture ?? "error");
    return texture;
  };

  /** G3: per-(node, draw, primitive) DYNAMIC buffers the CPU-skinned vertices
   *  re-upload into each sampled frame; normals recompute as flat facets (the
   *  modelPrimitiveGeometry de-index path — the raster stance) */
  const skinnedBuffers = (
    scNode: SceneNode, key: string, positions: number[], source: GlbPrimitive,
  ): GlBuffers | null => {
    const geometry = modelPrimitiveGeometry(positions, [], source.indices);
    let bucket = skinnedCache.get(scNode);
    if (bucket === undefined) { bucket = new Map(); skinnedCache.set(scNode, bucket); }
    const cached = bucket.get(key);
    const { gl } = state;
    if (cached !== undefined) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cached.position);
      gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, cached.normal);
      gl.bufferData(gl.ARRAY_BUFFER, geometry.normals, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, cached.uv);
      gl.bufferData(gl.ARRAY_BUFFER, geometry.uvs, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cached.index);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.DYNAMIC_DRAW);
      cached.count = geometry.indices.length;
      cached.indexType = geometry.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      return cached;
    }
    const uploaded = uploadGeometry(gl, geometry);
    if (uploaded !== null) bucket.set(key, uploaded);
    return uploaded;
  };

  const drawBuffers = (buffers: GlBuffers): void => {
    const { gl, attrs } = state;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
    gl.enableVertexAttribArray(attrs.position);
    gl.vertexAttribPointer(attrs.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normal);
    gl.enableVertexAttribArray(attrs.normal);
    gl.vertexAttribPointer(attrs.normal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.uv);
    gl.enableVertexAttribArray(attrs.uv);
    gl.vertexAttribPointer(attrs.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
    gl.drawElements(gl.TRIANGLES, buffers.count, buffers.indexType, 0);
  };

  let frame = 0;
  let aspect = 1;
  const render = (): void => {
    frame = 0;
    const { gl, program, uniforms, geometry } = state;
    const width = canvas.width > 0 ? canvas.width : 1;
    const height = canvas.height > 0 ? canvas.height : 1;
    aspect = width / height;
    gl.viewport(0, 0, width, height);
    const backgroundRaw = ir.attrs["background"] === undefined
      ? "#000000" : resolve(null, "background", ir.attrs["background"]);
    let background = parseSceneColor(backgroundRaw);
    if (background === null) {
      diag({ code: "malformed-number", message: `background="${backgroundRaw}" is not a #hex color — using #000000` });
      background = [0, 0, 0];
    }
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const camera = sceneCamera(ir, resolve, aspect, diag);
    const lighting = sceneLighting(ir, resolve, diag);
    const ambientColor = parseSceneColor(lighting.ambientColor) ?? [1, 1, 1];
    const directionalColor = parseSceneColor(lighting.directionalColor) ?? [1, 1, 1];
    const worlds = worldMatrices(ir.nodes, resolve, diag);

    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms["uProj"]!, false, new Float32Array(camera.proj));
    gl.uniformMatrix4fv(uniforms["uView"]!, false, new Float32Array(camera.view));
    gl.uniform3fv(uniforms["uEye"]!, new Float32Array(camera.eye));
    gl.uniform3fv(uniforms["uAmbient"]!, new Float32Array(
      ambientColor.map((c) => c * lighting.ambientIntensity)));
    gl.uniform3fv(uniforms["uLightDir"]!, new Float32Array(lighting.direction ?? [0, 1, 0]));
    gl.uniform3fv(uniforms["uLightColor"]!, new Float32Array(
      directionalColor.map((c) => c * (lighting.direction === null ? 0 : lighting.directionalIntensity))));
    // P5 point lights (≤4, kernel-capped) — color premultiplied by intensity
    const pointPositions = new Float32Array(12);
    const pointColors = new Float32Array(12);
    const pointRanges = new Float32Array(4);
    lighting.points.forEach((point, i) => {
      pointPositions.set(point.position, i * 3);
      const color = parseSceneColor(point.color) ?? [1, 1, 1];
      pointColors.set([color[0] * point.intensity, color[1] * point.intensity, color[2] * point.intensity], i * 3);
      pointRanges[i] = point.range;
    });
    gl.uniform3fv(uniforms["uPointPos"]!, pointPositions);
    gl.uniform3fv(uniforms["uPointColor"]!, pointColors);
    gl.uniform1fv(uniforms["uPointRange"]!, pointRanges);
    gl.uniform1i(uniforms["uPointCount"]!, lighting.points.length);
    // P5 linear fog — far ≤ near (or no fog authored) disables in the shader
    const fog = sceneFog(ir, resolve, diag);
    const fogColor = fog === null ? [0, 0, 0] : parseSceneColor(fog.color) ?? [0, 0, 0];
    gl.uniform3fv(uniforms["uFogColor"]!, new Float32Array(fogColor));
    gl.uniform1f(uniforms["uFogNear"]!, fog === null ? 0 : fog.near);
    gl.uniform1f(uniforms["uFogFar"]!, fog === null ? 0 : fog.far);
    gl.uniform1i(uniforms["uTexture"]!, 0);
    gl.activeTexture(gl.TEXTURE0);

    const nodeColor = (props: SceneNodeProps): Vec3 => {
      let color = parseSceneColor(props.color);
      if (color === null) {
        diag({ code: "malformed-number", message: `color="${props.color}" is not a #hex color — using #ffffff` });
        color = [1, 1, 1];
      }
      return color;
    };
    const setSurface = (
      cutout: boolean, unlit: boolean, texture: WebGLTexture | null,
      uv?: readonly [number, number, number, number],
    ): void => {
      gl.uniform1f(uniforms["uCutout"]!, cutout ? 1 : 0);
      gl.uniform1f(uniforms["uUnlit"]!, unlit ? 1 : 0);
      // G6: the sheet's frame rect (and `flip`, as a negative scale) rides the EXISTING
      // program as a UV offset/scale pair — never a second shader, never per-frame geometry
      gl.uniform2f(uniforms["uUvOffset"]!, uv === undefined ? 0 : uv[0], uv === undefined ? 0 : uv[1]);
      gl.uniform2f(uniforms["uUvScale"]!, uv === undefined ? 1 : uv[2] - uv[0], uv === undefined ? 1 : uv[3] - uv[1]);
      gl.bindTexture(gl.TEXTURE_2D, texture ?? state.whiteTexture);
    };

    // G6 THE 2D DRAW-ORDER LAW: inside mode="2d" z IS the draw order — paint world z
    // ASCENDING (stable, document order breaking ties) with depth testing OFF, so a
    // higher z lands in front and coplanar sprites never z-fight. 3D keeps the z-buffer.
    let drawList = [...worlds];
    if (ir.mode === "2d") {
      const order = sceneDrawOrder2d(drawList.map(([, world]) => world[14]!));
      drawList = order.map((index) => drawList[index]!);
      gl.disable(gl.DEPTH_TEST);
    } else {
      gl.enable(gl.DEPTH_TEST);
    }
    for (const [scNode, world] of drawList) {
      const props = resolvedProps(scNode, resolve, diag);
      if (scNode.kind === "model") {
        // P4: the GLB draw list — model = sceneWorld · draw.world, flat Lambert with
        // baseColorFactor × the node color (default white)
        if (props.src.length === 0) continue;
        const entry = modelFor(props.src);
        if (entry.state !== "ready") continue;
        const color = nodeColor(props);
        setSurface(false, false, null);
        // G3: an authored `animation` drives the kernel clip mixer — the sampled pose
        // recomputes node worlds (animated transforms move unskinned draws too) and
        // CPU-skins JOINTS_0/WEIGHTS_0 draws into dynamic buffers
        let poseWorlds: Mat4[] | null = null;
        if (scNode.attrs["animation"] !== undefined) {
          let mixer = clipMixers.get(scNode);
          if (mixer === undefined) {
            mixer = createSceneClipMixer(entry.model, diag);
            clipMixers.set(scNode, mixer);
          }
          const t = nowMs();
          mixer.update(props.animation, props.clipLoop, props.blendMs, t);
          poseWorlds = glbNodeWorlds(entry.model, mixer.pose(t));
        }
        for (const item of entry.buffers) {
          entry.model.draws.forEach((draw, drawIndex) => {
            if (draw.mesh !== item.mesh) return;
            const model = mat4Multiply(world, poseWorlds === null ? draw.world : poseWorlds[draw.node]!);
            gl.uniformMatrix4fv(uniforms["uModel"]!, false, new Float32Array(model));
            gl.uniformMatrix3fv(uniforms["uNormal"]!, false, normalMatrix(model));
            gl.uniform3fv(uniforms["uColor"]!, new Float32Array([
              color[0] * item.baseColor[0], color[1] * item.baseColor[1], color[2] * item.baseColor[2],
            ]));
            let buffers = item.primitive;
            if (poseWorlds !== null && draw.skin !== null) {
              const matrices = glbJointMatrices(entry.model, draw.skin, draw.node, poseWorlds);
              const skinned = skinnedPrimitivePositions(item.source, matrices);
              if (skinned !== null) {
                const dynamic = skinnedBuffers(scNode, `${drawIndex}:${item.mesh}`, skinned, item.source);
                if (dynamic !== null) buffers = dynamic;
              }
            }
            drawBuffers(buffers);
          });
        }
        continue;
      }
      if (scNode.kind === "text3d") {
        // P4: the billboard quad — camera-facing by law, UNLIT, alpha-cutout glyphs
        const quad = text3dQuad(props);
        if (quad === null) continue;
        const characters = Array.from(props.value).length;
        const texture = textRasterFor(props.value, characters);
        if (texture === null) continue;
        const model = billboardMatrix(world, camera.view, quad.halfWidth * 2, quad.halfHeight * 2);
        gl.uniformMatrix4fv(uniforms["uModel"]!, false, new Float32Array(model));
        gl.uniformMatrix3fv(uniforms["uNormal"]!, false, normalMatrix(model));
        gl.uniform3fv(uniforms["uColor"]!, new Float32Array(nodeColor(props)));
        setSurface(true, true, texture);
        drawBuffers(geometry.plane);
        continue;
      }
      if (scNode.kind === "sprite") {
        // G6 THE QUAD LAW: a textured quad in the node's LOCAL XY plane facing +Z,
        // riding the node's world transform (in mode="2d" the orthographic camera looks
        // down −Z, so that IS camera-facing; billboarding in 3D is a named absence).
        // model = world · T(anchor offset) · S(w, h, 1) — the plane geometry, verbatim.
        const texture = props.src.length === 0 ? null : textureFor(props.src);
        // an authored src draws NOTHING until its texture arrives (the <model> posture);
        // a src-less sprite is an honest flat `color` rectangle
        if (props.src.length > 0 && texture === null) continue;
        const [spriteW, spriteH] = spriteSizeOf(props, textureAspects.get(props.src) ?? null);
        const frame = spriteFrameAt(props, (nowMs() - spriteEpoch) / 1000);
        const offset = spriteAnchorOffset(props, spriteW, spriteH);
        const model = modelMatrix(
          mat4Multiply(world, mat4Trs(offset, [0, 0, 0], [1, 1, 1])), [spriteW, spriteH, 1]);
        gl.uniformMatrix4fv(uniforms["uModel"]!, false, new Float32Array(model));
        gl.uniformMatrix3fv(uniforms["uNormal"]!, false, normalMatrix(model));
        gl.uniform3fv(uniforms["uColor"]!, new Float32Array(nodeColor(props)));
        // the texel MODULATES the tint (the P4 texture law) and alpha < 0.5 CUTS OUT —
        // the sprite's silhouette, the text3d cutout path verbatim
        setSurface(texture !== null, false, texture, spriteUvRect(props, frame));
        drawBuffers(geometry.plane);
        continue;
      }
      const buffers = scNode.kind === "box" ? geometry.box
        : scNode.kind === "sphere" ? geometry.sphere
        : scNode.kind === "plane" ? geometry.plane : null;
      if (buffers === null) continue;
      const scale = geometryScale(scNode, props);
      if (scale === null) continue;
      const model = modelMatrix(world, scale);
      gl.uniformMatrix4fv(uniforms["uModel"]!, false, new Float32Array(model));
      gl.uniformMatrix3fv(uniforms["uNormal"]!, false, normalMatrix(model));
      gl.uniform3fv(uniforms["uColor"]!, new Float32Array(nodeColor(props)));
      // P4 textures: NEAREST-sampled, modulating the lit color (the UV law)
      setSurface(false, false, props.texture.length > 0 ? textureFor(props.texture) : null);
      drawBuffers(buffers);
    }
    // P5 collisions: the pass rides the RENDER (movement implies a render — the
    // zero-cost static law), and only while an on:collide handler is authored
    collisionPass(worlds);
    if (!ready) {
      ready = true;
      api.handler("ready");
      // the bus event door (G5): the Core/Scene module re-fires this as scene.ready
      sceneBusEmit(busKey, "ready", { scene: busKey });
    }
    // G3: a mixer created/advanced by THIS render may need the loop (an active clip
    // or crossfade) — the loop-existence extension
    ensureLoop();
  };

  const collisionPass = (worlds: Map<SceneNode, Mat4>): void => {
    let anyHandler = false;
    for (const childApi of apis.values()) if (childApi.hasHandler("collide")) { anyHandler = true; break; }
    if (!anyHandler) return;
    const shapes: SceneColliderShape[] = [];
    const byTrackerId = new Map<string, SceneNode>();
    for (const [scNode, world] of worlds) {
      const props = resolvedProps(scNode, resolve, diag);
      if (props.collide.length === 0) continue;
      const id = trackerIdFor(scNode);
      const shape = sceneColliderFor(scNode, props, world, id);
      if (shape !== null) { shapes.push(shape); byTrackerId.set(id, scNode); }
    }
    for (const event of collisionTracker.step(shapes)) {
      const scNode = byTrackerId.get(event.id);
      if (scNode === undefined) continue;
      const payload = {
        id: scNode.id ?? "",
        other: byTrackerId.get(event.other)?.id ?? "",
        depth: event.depth,
      };
      apis.get(scNode)?.handler("collide", payload);
      // the bus event door (G5): re-fired by the Core/Scene module as scene.collide
      sceneBusEmit(busKey, "collide", { scene: busKey, ...payload });
    }
  };

  // rAF-coalesced: N store writes in a tick = one draw; nothing changes = no loop
  const scheduleRender = (): void => {
    if (frame !== 0) return;
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(render);
    else { frame = 1; queueMicrotask(render); }
  };
  // the renderer is live — rebind the bus hooks the handle was registered with
  busScheduleRender = scheduleRender;
  canvasSizeForPick = () => ({
    width: canvas.width > 0 ? canvas.width : 16,
    height: canvas.height > 0 ? canvas.height : 9,
  });
  busCapture = () => {
    if (canvas.width <= 0 || canvas.height <= 0) return null;
    try {
      render();   // draw the CURRENT state synchronously — evidence, not a stale buffer
      const image = (canvas as HTMLCanvasElement & { toDataURL?: (type: string) => string })
        .toDataURL?.("image/png");
      if (typeof image !== "string" || image.length === 0) return null;
      return { image, width: canvas.width, height: canvas.height };
    } catch {
      return null;
    }
  };
  ctx.disposers.push(() => {
    if (frame !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    frame = 0;
  });
  // a loaded model's collider bounds (the G2 auto-collider law; [0.5,0.5,0.5] before)
  physicsModelHalf = (scNode) => {
    const src = resolvedProps(scNode, resolveBase, diag).src;
    if (src.length === 0) return null;
    const entry = models.get(src);
    if (entry === undefined || entry.state !== "ready") return null;
    return modelHalfExtents(entry.model);
  };

  const resize = (): void => {
    const rect = host.getBoundingClientRect?.();
    const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const width = Math.max(1, Math.round((rect?.width || 300) * dpr));
    const height = Math.max(1, Math.round((rect?.height || 169) * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      scheduleRender();
    }
  };
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    ctx.disposers.push(() => observer.disconnect());
  }
  queueMicrotask(resize);

  // ── orbit controls (P5): `controls="orbit"` on the camera — pointer drags fold
  // through the kernel orbit math into a camera-position override; wheel zooms
  // clamped [near, far]. A drag suppresses the click-pick that follows it.
  // (`cameraNode` is hoisted above the bus handle — the camera actions share it.)
  const orbitEnabled = (): boolean =>
    cameraNode !== null && resolvedProps(cameraNode, resolveBase, diag).controls === "orbit";
  let pointerDown = false;
  let dragMoved = false;
  let lastPointerX = 0, lastPointerY = 0;
  const orbitWrite = (position: Vec3): void => {
    setOverride(cameraNode!, "position", formatSceneAnimValue("position", position));
    scheduleRender();
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (!orbitEnabled()) return;
    pointerDown = true;
    dragMoved = false;
    lastPointerX = (event as PointerEvent).clientX;
    lastPointerY = (event as PointerEvent).clientY;
    (canvas as HTMLElement & { setPointerCapture?: (id: number) => void })
      .setPointerCapture?.((event as PointerEvent).pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pointerDown || cameraNode === null) return;
    const dx = (event as PointerEvent).clientX - lastPointerX;
    const dy = (event as PointerEvent).clientY - lastPointerY;
    if (dx === 0 && dy === 0) return;
    lastPointerX = (event as PointerEvent).clientX;
    lastPointerY = (event as PointerEvent).clientY;
    dragMoved = true;
    const props = resolvedProps(cameraNode, resolve, diag);
    const state = orbitDrag(orbitFromCamera(props.position, props.lookAt), dx, dy);
    orbitWrite(orbitPosition(state, props.lookAt));
  });
  const endPointer = (): void => { pointerDown = false; };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", (event) => {
    if (!orbitEnabled() || cameraNode === null) return;
    event.preventDefault();
    const props = resolvedProps(cameraNode, resolve, diag);
    const state = orbitZoom(
      orbitFromCamera(props.position, props.lookAt), (event as WheelEvent).deltaY, props.near, props.far);
    orbitWrite(orbitPosition(state, props.lookAt));
  }, { passive: false });

  // ── on:tap picking v0: unproject the pointer, nearest bounding-sphere hit among
  // handler-bearing nodes, fire through the same runner path as every element
  canvas.addEventListener("click", (event) => {
    if (dragMoved) { dragMoved = false; return; } // an orbit drag is not a tap
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    const camera = sceneCamera(ir, resolve, aspect, diag);
    const ray = pickRay(camera.proj, camera.view, ndcX, ndcY);
    if (ray === null) return;
    const worlds = worldMatrices(ir.nodes, resolve, diag);
    let best: { scNode: SceneNode; t: number } | null = null;
    for (const [scNode, world] of worlds) {
      const childApi = apis.get(scNode);
      if (childApi === undefined || !childApi.hasHandler("tap")) continue;
      const props = resolvedProps(scNode, resolve, diag);
      const localRadius = nodeBoundingRadius(scNode, props);
      if (localRadius === null) continue;
      const sphere = worldBoundingSphere(world, localRadius);
      const t = raySphere(ray.origin, ray.dir, sphere.center, sphere.radius);
      if (t !== null && (best === null || t < best.t)) best = { scNode, t };
    }
    if (best !== null) apis.get(best.scNode)!.handler("tap", { id: best.scNode.id ?? "" });
  });

  // ── the ONE frame loop (P4 on:frame + P5 animations + G2 physics): it exists ONLY
  // while an on:frame handler is authored, at least one animation/transition is
  // active, or any dynamic body is awake / any character exists (the G2 extension of
  // the loop-existence law) — a static scene never spins (the P1 law), and a fully-
  // asleep physics world stops the loop again. The shared kernel frame clock applies
  // the 60/s budget (corpus frame.json); the physics accumulator (corpus physics.json)
  // decouples the fixed 60 Hz simulation from the rendered rate inside it.

  /** advance every implicit transition; true = more work next frame */
  const advanceTransitions = (t: number): boolean => {
    let active = false;
    for (const [scNode, bucket] of transitions) {
      for (const [target, rec] of bucket) {
        if (tweenOwns(scNode, target)) continue; // explicit beats implicit
        const result = sceneTransitionValue(rec.entry, rec.state, t);
        if (result.done) {
          // the glide reached base — the override retires, the property shows base
          clearOverride(scNode, target);
          bucket.delete(target);
        } else {
          setOverride(scNode, target, formatSceneAnimValue(target, result.value));
          active = true;
        }
      }
      if (bucket.size === 0) transitions.delete(scNode);
    }
    return active;
  };

  /** advance every <animate>; true = more work next frame */
  const advanceAnimations = (t: number): boolean => {
    let active = false;
    for (const rec of animations.values()) {
      const open = gateOpen(rec.node);
      if (!open) {
        // the when law: falsy stops at base (no on:done); the next truthy edge restarts
        if (rec.playing && rec.spec !== null) clearOverride(rec.target, rec.spec.target);
        rec.playing = false;
        rec.finished = false;
        continue;
      }
      if (!rec.playing) {
        rec.spec = parseSceneTween(rec.node, resolveBase, diag);
        rec.playing = true;
        rec.doneFired = false;
        if (rec.spec === null) { rec.finished = true; continue; } // inert (diagnosed)
        rec.finished = false;
        rec.startMs = t;
        // from defaults to the BASE at start; an explicit tween cancels the implicit
        // transition on its property (explicit wins)
        rec.from = rec.spec.from ?? baseValueFor(rec.target, rec.spec.target);
        const bucket = transitions.get(rec.target);
        if (bucket !== undefined) { bucket.delete(rec.spec.target); if (bucket.size === 0) transitions.delete(rec.target); }
      }
      if (rec.finished || rec.spec === null) continue;
      const target = rec.spec.target;
      const sample = sceneTweenValue(rec.spec, rec.from!, baseValueFor(rec.target, target), t - rec.startMs);
      if (sample.overriding) setOverride(rec.target, target, formatSceneAnimValue(target, sample.value));
      else clearOverride(rec.target, target);
      if (sample.done) {
        rec.finished = true; // fill=hold keeps its final override; fill=none cleared above
        // payload {id} = the ANIMATED target's id (the iOS shape — one event, three renderers)
        if (!rec.doneFired) { rec.doneFired = true; apis.get(rec.node)?.handler("done", { id: rec.target.id ?? "" }); }
      } else {
        active = true;
      }
    }
    return active;
  };

  const animationsWantTick = (): boolean => {
    for (const rec of animations.values()) {
      const open = gateOpen(rec.node);
      if (open && !(rec.playing && rec.finished)) return true; // will start, or mid-flight
      if (!open && rec.playing) return true;                   // needs its stop tick
    }
    return false;
  };
  /** G3: any model clip mixer with an active clip or crossfade keeps the loop alive;
   *  a finished non-looping clip with no crossfade lets it stop */
  const clipsWantTick = (): boolean => {
    if (clipMixers.size === 0) return false;
    const t = nowMs();
    for (const mixer of clipMixers.values()) {
      if (mixer.active(t)) return true;
    }
    return false;
  };
  /** G6: an fps-driven sprite keeps the loop alive — a looping strip forever, a
   *  loop="false" strip only until it reaches its last frame (the law extended again) */
  const spritesWantTick = (): boolean => {
    for (const scNode of spriteNodes) {
      const props = resolvedProps(scNode, resolve, diag);
      if (!(props.spriteFps > 0)) continue;
      if (props.spriteLoop) return true;
      if (spriteFrameAt(props, (nowMs() - spriteEpoch) / 1000) < spriteFrameCount(props) - 1) return true;
    }
    return false;
  };
  const loopActive = (): boolean =>
    api.hasHandler("frame") || transitions.size > 0 || animationsWantTick() || physicsWants()
      || clipsWantTick() || spritesWantTick();

  let loopHandle = 0;
  const frameClock = createSceneFrameClock();
  const loopTick = (stamp: number): void => {
    loopHandle = 0;
    if (disposed) return;
    // G4 unified input: the Gamepad API is POLLED INSIDE THE LOOP THAT ALREADY EXISTS —
    // one line, no second rAF. inputHostFrame() also parks the input runtime's own gated
    // loop while this one is driving (input.ts, "the loop-existence law applied to input").
    inputHostFrame();
    const emitted = frameClock.tick(stamp);
    if (emitted !== null) {
      lastFrameDt = emitted.dt;   // the stats() honest v0 profiler read
      if (api.hasHandler("frame")) {
        api.handler("frame", { dt: emitted.dt, elapsed: emitted.elapsed, frame: emitted.frame });
      }
      advanceTransitions(stamp);
      advanceAnimations(stamp);
      // G2: the fixed-tick solver rides the same loop AFTER animations (kinematics
      // read animation overrides written this frame), interpolating into overrides
      advancePhysics(emitted.dt);
      render();
    }
    // render() above may already have re-armed the loop through ensureLoop (the G3
    // mixer path) — never double-schedule
    if (loopHandle === 0 && loopActive()) loopHandle = requestAnimationFrame(loopTick);
  };
  const ensureLoop = (): void => {
    if (loopHandle !== 0 || disposed || typeof requestAnimationFrame !== "function") return;
    if (!loopActive()) return;
    loopHandle = requestAnimationFrame(loopTick);
  };
  busEnsureLoop = ensureLoop;   // the bus's flyTo/set writes may need the loop
  ctx.disposers.push(() => {
    if (loopHandle !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(loopHandle);
    loopHandle = 0;
  });

  spriteEpoch = nowMs();
  scheduleRender();
  ensureLoop();
  return host;
};

/** a loaded model's local half extents for the G2 auto collider — symmetric about the
 *  node origin (v1: half = max |coordinate| per axis over every draw-transformed
 *  vertex; an asymmetric model gets the symmetric hull, the honest approximation) */
export function modelHalfExtents(model: GlbModel): Vec3 {
  const half: Vec3 = [0, 0, 0];
  for (const draw of model.draws) {
    const mesh = model.meshes[draw.mesh];
    if (mesh === undefined) continue;
    const m = draw.world;
    for (const primitive of mesh.primitives) {
      const positions = primitive.positions;
      for (let i = 0; i + 2 < positions.length; i += 3) {
        const lx = positions[i]!, ly = positions[i + 1]!, lz = positions[i + 2]!;
        const x = m[0]! * lx + m[4]! * ly + m[8]! * lz + m[12]!;
        const y = m[1]! * lx + m[5]! * ly + m[9]! * lz + m[13]!;
        const z = m[2]! * lx + m[6]! * ly + m[10]! * lz + m[14]!;
        if (Math.abs(x) > half[0]) half[0] = Math.abs(x);
        if (Math.abs(y) > half[1]) half[1] = Math.abs(y);
        if (Math.abs(z) > half[2]) half[2] = Math.abs(z);
      }
    }
  }
  return half;
}

/** a GLB primitive → the renderer's geometry shape; absent normals synthesize flat
 *  face normals by de-indexing (the parser's named degradation) */
export function modelPrimitiveGeometry(
  positions: readonly number[], normals: readonly number[], indices: readonly number[],
): Geometry {
  if (normals.length === positions.length && positions.length > 0) {
    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      uvs: new Float32Array(positions.length / 3 * 2),
      indices: sceneIndexArray(indices),
    };
  }
  // de-index into a triangle soup with computed face normals
  const outPositions: number[] = [], outNormals: number[] = [], outIndices: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const vertex = (i: number): [number, number, number] => [
      positions[indices[t + i]! * 3] ?? 0,
      positions[indices[t + i]! * 3 + 1] ?? 0,
      positions[indices[t + i]! * 3 + 2] ?? 0,
    ];
    const a = vertex(0), b = vertex(1), c = vertex(2);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) { nx /= length; ny /= length; nz /= length; }
    for (const p of [a, b, c]) {
      outIndices.push(outPositions.length / 3);
      outPositions.push(...p);
      outNormals.push(nx, ny, nz);
    }
  }
  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    uvs: new Float32Array(outPositions.length / 3 * 2),
    indices: sceneIndexArray(outIndices),
  };
}

export const scene: ElementFactory = sceneFactory;

export function registerSceneSurface(): void { ELEMENTS["scene"] = sceneFactory; }

export const SCENE_CSS = `@layer dsx-elements {
  .dsx-scene {
    position: relative;
    display: block;
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    max-inline-size: 100%;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    background: var(--dsx-fill);
    color: var(--dsx-label);
  }
  .dsx-scene-canvas {
    position: absolute;
    inset: 0;
    inline-size: 100%;
    block-size: 100%;
    display: block;
  }
  .dsx-scene-fallback,
  .dsx-scene-scheduled {
    position: absolute;
    inset-inline: 0;
    display: block;
    padding: 0.375rem 0.625rem;
    font-family: var(--dsx-font);
    font-size: var(--dsx-type-caption2-size);
    color: var(--dsx-secondary-label);
    background: color-mix(in srgb, var(--dsx-background) 72%, transparent);
    z-index: 1;
  }
  .dsx-scene-fallback { inset-block-start: 0; }
  .dsx-scene-scheduled { inset-block-end: 0; }
  @media (forced-colors: active) {
    .dsx-scene { border: 1px solid CanvasText; forced-color-adjust: auto; }
  }
}`;
