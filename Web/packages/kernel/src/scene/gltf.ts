//
//  scene/gltf.ts - the DSX Scene GLB/glTF parser (dsx-scene.md P4): pure TS, zero
//  dependencies, platform-neutral (no DOM, no fetch — the caller supplies bytes). The
//  law lives in OpenSource/Conformance/scene/model.json + README.md: glTF 2.0 BINARY
//  containers, EMBEDDED buffers only (a buffer with a `uri` is the NAMED absence,
//  error "external-buffer"), POSITION/NORMAL f32 VEC3, u8/u16/u32 indices (non-indexed
//  synthesizes 0..n-1), pbrMetallicRoughness.baseColorFactor (default [1,1,1,1]),
//  triangle mode only; the draw list flattens the default scene's node hierarchy
//  (matrix, or T · R(quaternion) · S). Failure is a VALUE (Article 7): a broken
//  container parses to an error code — never a throw. The Kotlin twin is
//  Engine/Android core scene/SceneGltf.kt; the Swift twin is SceneGltf.swift.
//
//  G3 (dsx-game.md §2 — corpus OpenSource/Conformance/scene/skin.json): the parse also
//  retains the NODE FOREST (base TRS + matrix + children + mesh/skin references — clip
//  sampling recomposes the hierarchy), `skins` (joints + inverseBindMatrices; absent
//  IBMs are identity), `animations` as NAMED CLIPS (translation/rotation/scale channels,
//  LINEAR + STEP; a CUBICSPLINE or weights/morph channel DROPS — the named absence —
//  and duration folds over the KEPT channels only; an unnamed clip is named by its
//  zero-based index), and JOINTS_0/WEIGHTS_0 vertex attributes (u8/u16 joints read raw;
//  integer-typed WEIGHTS_0 normalizes by 255/65535 — the glTF normalized law). The
//  skinning/sampling/crossfade math lives in skin.ts.
//

import { mat4Identity, mat4Multiply, type Mat4, type Vec3 } from "./math.ts";

export type GlbPrimitive = {
  /** flat xyz triples */
  readonly positions: number[];
  /** flat xyz triples; empty when the primitive authors no NORMAL (flat-shade fallback) */
  readonly normals: number[];
  readonly indices: number[];
  /** pbrMetallicRoughness.baseColorFactor rgba, default [1, 1, 1, 1] */
  readonly baseColor: [number, number, number, number];
  /** G3: flat JOINTS_0 4-tuples (empty when unskinned) — u8/u16 read raw */
  readonly joints: number[];
  /** G3: flat WEIGHTS_0 4-tuples (empty when unskinned) — integer types normalized */
  readonly weights: number[];
};

export type GlbMesh = { readonly primitives: GlbPrimitive[] };

/** one node-referenced mesh instance: world = the node's hierarchy-composed matrix;
 *  G3 adds the referencing node index + its skin (null = unskinned) */
export type GlbDraw = {
  readonly mesh: number; readonly world: Mat4;
  readonly node: number; readonly skin: number | null;
};

/** G3: one retained glTF node — clip sampling recomposes the hierarchy from these */
export type GlbNode = {
  readonly translation: Vec3;
  /** unit-ish quaternion (x, y, z, w) */
  readonly rotation: [number, number, number, number];
  readonly scale: Vec3;
  /** a matrix-authored node (glTF forbids animating these); null = TRS-authored */
  readonly matrix: Mat4 | null;
  readonly children: number[];
  readonly mesh: number | null;
  readonly skin: number | null;
};

/** G3: joints (node indices) + inverse bind matrices (identity when unauthored) */
export type GlbSkin = { readonly joints: number[]; readonly inverseBindMatrices: Mat4[] };

export type GlbChannelPath = "translation" | "rotation" | "scale";

export type GlbChannel = {
  readonly node: number;
  readonly path: GlbChannelPath;
  readonly interpolation: "LINEAR" | "STEP";
  /** key times, seconds, ascending */
  readonly times: number[];
  /** flat values — 3 per key (translation/scale) or 4 (rotation quaternions) */
  readonly values: number[];
};

/** G3: a named clip — `<model animation="name">` selects by this name */
export type GlbClip = {
  readonly name: string;
  /** max key time over the KEPT channels, seconds */
  readonly duration: number;
  readonly channels: GlbChannel[];
};

export type GlbModel = {
  readonly meshes: GlbMesh[];
  readonly draws: GlbDraw[];
  readonly nodes: GlbNode[];
  readonly skins: GlbSkin[];
  readonly clips: GlbClip[];
};

export type GlbError = "not-glb" | "external-buffer" | "malformed";

export type GlbParseResult = { ok: true; model: GlbModel } | { ok: false; error: GlbError };

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT_F32 = 5126;
const COMPONENT_U8 = 5121;
const COMPONENT_U16 = 5123;
const COMPONENT_U32 = 5125;
const MODE_TRIANGLES = 4;

type JsonDict = { readonly [key: string]: unknown };

function dict(value: unknown): JsonDict | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonDict) : null;
}
function list(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** a unit-ish glTF quaternion (x, y, z, w) → column-major rotation mat4 */
export function quaternionToMat4(x: number, y: number, z: number, w: number): Mat4 {
  const length = Math.hypot(x, y, z, w);
  if (length < 1e-12) return mat4Identity();
  const qx = x / length, qy = y / length, qz = z / length, qw = w / length;
  return [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw), 0,
    2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw), 0,
    2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy), 0,
    0, 0, 0, 1,
  ];
}

function nodeLocalMatrix(node: JsonDict): Mat4 | null {
  const matrix = list(node["matrix"]);
  if (matrix !== null) {
    if (matrix.length !== 16 || !matrix.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
    return matrix as Mat4;
  }
  const triple = (name: string, fallback: Vec3): Vec3 | null => {
    const raw = list(node[name]);
    if (raw === null) return fallback;
    if (raw.length !== 3 || !raw.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
    return raw as Vec3;
  };
  const translation = triple("translation", [0, 0, 0]);
  const scale = triple("scale", [1, 1, 1]);
  if (translation === null || scale === null) return null;
  let rotation = mat4Identity();
  const quat = list(node["rotation"]);
  if (quat !== null) {
    if (quat.length !== 4 || !quat.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
    rotation = quaternionToMat4(quat[0] as number, quat[1] as number, quat[2] as number, quat[3] as number);
  }
  const t: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, translation[0], translation[1], translation[2], 1];
  const s: Mat4 = [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, 0, 0, 0, 1];
  return mat4Multiply(mat4Multiply(t, rotation), s);
}

type AccessorReader = (accessorIndex: number, componentCount: number, normalizeInts?: boolean) => number[] | null;

function makeAccessorReader(doc: JsonDict, bin: DataView | null): AccessorReader {
  const accessors = list(doc["accessors"]) ?? [];
  const views = list(doc["bufferViews"]) ?? [];
  return (accessorIndex, componentCount, normalizeInts) => {
    const accessor = dict(accessors[accessorIndex]);
    if (accessor === null || bin === null) return null;
    if (accessor["sparse"] !== undefined) return null;           // named absence
    const viewIndex = int(accessor["bufferView"]);
    const count = int(accessor["count"]);
    const componentType = int(accessor["componentType"]);
    if (viewIndex === null || count === null || componentType === null) return null;
    const view = dict(views[viewIndex]);
    if (view === null) return null;
    const viewOffset = int(view["byteOffset"]) ?? 0;
    const accessorOffset = int(accessor["byteOffset"]) ?? 0;
    const stride = int(view["byteStride"]) ?? 0;
    const componentBytes = componentType === COMPONENT_F32 || componentType === COMPONENT_U32 ? 4
      : componentType === COMPONENT_U16 ? 2
      : componentType === COMPONENT_U8 ? 1 : null;
    if (componentBytes === null) return null;
    const elementBytes = componentBytes * componentCount;
    const step = stride > 0 ? stride : elementBytes;
    const base = viewOffset + accessorOffset;
    if (base + (count - 1) * step + elementBytes > bin.byteLength) return null;
    // the G3 normalized law: integer-typed WEIGHTS_0 components divide by 255/65535
    const divisor = normalizeInts === true && componentType === COMPONENT_U8 ? 255
      : normalizeInts === true && componentType === COMPONENT_U16 ? 65535 : 1;
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) {
      for (let c = 0; c < componentCount; c += 1) {
        const at = base + i * step + c * componentBytes;
        out.push(
          componentType === COMPONENT_F32 ? bin.getFloat32(at, true)
            : componentType === COMPONENT_U32 ? bin.getUint32(at, true) / divisor
            : componentType === COMPONENT_U16 ? bin.getUint16(at, true) / divisor
            : bin.getUint8(at) / divisor,
        );
      }
    }
    return out;
  };
}

/** parse a GLB container into the typed model. Failure is a value (Article 7). */
export function parseGlb(bytes: Uint8Array): GlbParseResult {
  if (bytes.byteLength < 20) return { ok: false, error: "not-glb" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    return { ok: false, error: "not-glb" };
  }
  // walk the chunk stream: one JSON chunk, at most one BIN chunk
  let offset = 12;
  let jsonText: string | null = null;
  let bin: DataView | null = null;
  while (offset + 8 <= view.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > view.byteLength) return { ok: false, error: "malformed" };
    if (type === CHUNK_JSON && jsonText === null) {
      jsonText = new TextDecoder().decode(bytes.subarray(start, start + length));
    } else if (type === CHUNK_BIN && bin === null) {
      bin = new DataView(bytes.buffer, bytes.byteOffset + start, length);
    }
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (jsonText === null) return { ok: false, error: "malformed" };
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch { return { ok: false, error: "malformed" }; }
  const doc = dict(parsed);
  if (doc === null) return { ok: false, error: "malformed" };

  // v1 law: embedded buffers only — a uri is the named absence
  const buffers = list(doc["buffers"]) ?? [];
  for (const buffer of buffers) {
    const b = dict(buffer);
    if (b !== null && typeof b["uri"] === "string") return { ok: false, error: "external-buffer" };
  }

  const read = makeAccessorReader(doc, bin);
  const materials = list(doc["materials"]) ?? [];
  const baseColorOf = (materialIndex: unknown): [number, number, number, number] => {
    const material = dict(materials[int(materialIndex) ?? -1]);
    const pbr = material === null ? null : dict(material["pbrMetallicRoughness"]);
    const factor = pbr === null ? null : list(pbr["baseColorFactor"]);
    if (factor !== null && factor.length === 4 && factor.every((v) => typeof v === "number")) {
      return [factor[0] as number, factor[1] as number, factor[2] as number, factor[3] as number];
    }
    return [1, 1, 1, 1];
  };

  const meshes: GlbMesh[] = [];
  for (const rawMesh of list(doc["meshes"]) ?? []) {
    const mesh = dict(rawMesh);
    if (mesh === null) return { ok: false, error: "malformed" };
    const primitives: GlbPrimitive[] = [];
    for (const rawPrimitive of list(mesh["primitives"]) ?? []) {
      const primitive = dict(rawPrimitive);
      if (primitive === null) return { ok: false, error: "malformed" };
      const mode = int(primitive["mode"]) ?? MODE_TRIANGLES;
      if (mode !== MODE_TRIANGLES) continue;                     // named absence: triangles only
      const attributes = dict(primitive["attributes"]);
      const positionAccessor = attributes === null ? null : int(attributes["POSITION"]);
      if (positionAccessor === null) return { ok: false, error: "malformed" };
      const positions = read(positionAccessor, 3);
      if (positions === null) return { ok: false, error: "malformed" };
      const normalAccessor = attributes === null ? null : int(attributes["NORMAL"]);
      const normals = normalAccessor === null ? [] : read(normalAccessor, 3);
      if (normals === null) return { ok: false, error: "malformed" };
      const indexAccessor = int(primitive["indices"]);
      let indices: number[];
      if (indexAccessor === null) {
        indices = Array.from({ length: positions.length / 3 }, (_, i) => i);
      } else {
        const readIndices = read(indexAccessor, 1);
        if (readIndices === null) return { ok: false, error: "malformed" };
        indices = readIndices;
      }
      // G3: JOINTS_0 (raw) + WEIGHTS_0 (integer types normalized) — both or neither
      const jointsAccessor = attributes === null ? null : int(attributes["JOINTS_0"]);
      const weightsAccessor = attributes === null ? null : int(attributes["WEIGHTS_0"]);
      let joints: number[] = [];
      let weights: number[] = [];
      if (jointsAccessor !== null && weightsAccessor !== null) {
        const readJoints = read(jointsAccessor, 4);
        const readWeights = read(weightsAccessor, 4, true);
        if (readJoints === null || readWeights === null) return { ok: false, error: "malformed" };
        joints = readJoints;
        weights = readWeights;
      }
      primitives.push({
        positions, normals, indices, baseColor: baseColorOf(primitive["material"]),
        joints, weights,
      });
    }
    meshes.push({ primitives });
  }

  // G3: the retained node forest (base TRS + matrix + references)
  const rawNodes = list(doc["nodes"]) ?? [];
  const glbNodes: GlbNode[] = [];
  for (const rawNode of rawNodes) {
    const node = dict(rawNode);
    if (node === null) return { ok: false, error: "malformed" };
    const matrixRaw = list(node["matrix"]);
    let matrix: Mat4 | null = null;
    if (matrixRaw !== null) {
      if (matrixRaw.length !== 16 || !matrixRaw.every((v) => typeof v === "number" && Number.isFinite(v))) {
        return { ok: false, error: "malformed" };
      }
      matrix = matrixRaw as Mat4;
    }
    const triple = (name: string, fallback: Vec3): Vec3 | null => {
      const raw = list(node[name]);
      if (raw === null) return fallback;
      if (raw.length !== 3 || !raw.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
      return raw as Vec3;
    };
    const translation = triple("translation", [0, 0, 0]);
    const scale = triple("scale", [1, 1, 1]);
    if (translation === null || scale === null) return { ok: false, error: "malformed" };
    let rotation: [number, number, number, number] = [0, 0, 0, 1];
    const quat = list(node["rotation"]);
    if (quat !== null) {
      if (quat.length !== 4 || !quat.every((v) => typeof v === "number" && Number.isFinite(v))) {
        return { ok: false, error: "malformed" };
      }
      rotation = quat as [number, number, number, number];
    }
    const children: number[] = [];
    for (const child of list(node["children"]) ?? []) {
      const index = int(child);
      if (index === null) return { ok: false, error: "malformed" };
      children.push(index);
    }
    glbNodes.push({
      translation, rotation, scale, matrix, children,
      mesh: int(node["mesh"]), skin: int(node["skin"]),
    });
  }

  // G3: skins — joints + inverse bind matrices (absent IBM accessor = identity)
  const skins: GlbSkin[] = [];
  for (const rawSkin of list(doc["skins"]) ?? []) {
    const skin = dict(rawSkin);
    if (skin === null) return { ok: false, error: "malformed" };
    const joints: number[] = [];
    for (const joint of list(skin["joints"]) ?? []) {
      const index = int(joint);
      if (index === null) return { ok: false, error: "malformed" };
      joints.push(index);
    }
    const ibmAccessor = int(skin["inverseBindMatrices"]);
    let inverseBindMatrices: Mat4[];
    if (ibmAccessor === null) {
      inverseBindMatrices = joints.map(() => mat4Identity());
    } else {
      const flat = read(ibmAccessor, 16);
      if (flat === null || flat.length < joints.length * 16) return { ok: false, error: "malformed" };
      inverseBindMatrices = joints.map((_, i) => flat.slice(i * 16, i * 16 + 16));
    }
    skins.push({ joints, inverseBindMatrices });
  }

  // G3: animations → named clips. LINEAR + STEP only — a CUBICSPLINE or non-TRS
  // channel DROPS (the named absence); duration folds over the KEPT channels;
  // an unnamed animation is named by its zero-based index.
  const clips: GlbClip[] = [];
  const rawAnimations = list(doc["animations"]) ?? [];
  for (let a = 0; a < rawAnimations.length; a += 1) {
    const animation = dict(rawAnimations[a]);
    if (animation === null) return { ok: false, error: "malformed" };
    const samplers = list(animation["samplers"]) ?? [];
    const channels: GlbChannel[] = [];
    let duration = 0;
    for (const rawChannel of list(animation["channels"]) ?? []) {
      const channel = dict(rawChannel);
      if (channel === null) return { ok: false, error: "malformed" };
      const target = dict(channel["target"]);
      const nodeIndex = target === null ? null : int(target["node"]);
      const path = target === null ? null : target["path"];
      if (nodeIndex === null || (path !== "translation" && path !== "rotation" && path !== "scale")) {
        continue;                                              // named absence: weights/morphs
      }
      const sampler = dict(samplers[int(channel["sampler"]) ?? -1]);
      if (sampler === null) return { ok: false, error: "malformed" };
      const interpolationRaw = sampler["interpolation"] ?? "LINEAR";
      if (interpolationRaw !== "LINEAR" && interpolationRaw !== "STEP") {
        continue;                                              // named absence: CUBICSPLINE
      }
      const inputAccessor = int(sampler["input"]);
      const outputAccessor = int(sampler["output"]);
      if (inputAccessor === null || outputAccessor === null) return { ok: false, error: "malformed" };
      const times = read(inputAccessor, 1);
      const components = path === "rotation" ? 4 : 3;
      const values = read(outputAccessor, components);
      if (times === null || values === null || times.length === 0
        || values.length < times.length * components) {
        return { ok: false, error: "malformed" };
      }
      channels.push({
        node: nodeIndex, path, interpolation: interpolationRaw,
        times, values: values.slice(0, times.length * components),
      });
      const last = times[times.length - 1]!;
      if (last > duration) duration = last;
    }
    const name = typeof animation["name"] === "string" && animation["name"].length > 0
      ? animation["name"] : String(a);
    clips.push({ name, duration, channels });
  }

  // the draw list: the default scene's node hierarchy, world = parentWorld · local
  const nodes = list(doc["nodes"]) ?? [];
  const scenes = list(doc["scenes"]) ?? [];
  const sceneIndex = int(doc["scene"]) ?? 0;
  const scene = dict(scenes[sceneIndex]) ?? dict(scenes[0]);
  const draws: GlbDraw[] = [];
  let broken = false;
  const walk = (nodeIndex: unknown, parent: Mat4, depth: number): void => {
    if (broken || depth > 64) { broken = true; return; }
    const index = int(nodeIndex);
    const node = index === null ? null : dict(nodes[index]);
    if (index === null || node === null) { broken = true; return; }
    const local = nodeLocalMatrix(node);
    if (local === null) { broken = true; return; }
    const world = mat4Multiply(parent, local);
    const meshIndex = int(node["mesh"]);
    if (meshIndex !== null && meshIndex < meshes.length) {
      const skinIndex = int(node["skin"]);
      draws.push({
        mesh: meshIndex, world, node: index,
        skin: skinIndex !== null && skinIndex < skins.length ? skinIndex : null,
      });
    }
    for (const child of list(node["children"]) ?? []) walk(child, world, depth + 1);
  };
  for (const root of (scene === null ? [] : list(scene["nodes"]) ?? [])) {
    walk(root, mat4Identity(), 0);
  }
  if (broken) return { ok: false, error: "malformed" };
  return { ok: true, model: { meshes, draws, nodes: glbNodes, skins, clips } };
}
