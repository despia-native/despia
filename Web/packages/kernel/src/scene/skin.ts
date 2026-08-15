//
//  scene/skin.ts - the DSX Scene G3 skeletal kernel (dsx-game.md §2 G3), platform-
//  neutral and corpus-pinned (OpenSource/Conformance/scene/skin.json — every law in the
//  file's _note and the corpus README "The G3 laws"). The shape:
//
//  - THE JOINT-MATRIX LAW: jointMatrix[i] = inverse(meshNodeWorld) ·
//    globalJointTransform[i] · inverseBindMatrix[i]. Node worlds compose over the FULL
//    retained node forest (parent = the unique referencing node; an unreferenced node
//    is a root), pose channels overriding base TRS per property. A singular mesh-node
//    world falls back to the identity inverse (failure is a value, Article 7).
//  - THE SKINNING LAW: skinnedPos = Σ w[i] · jointMatrix[i] · pos. Weights renormalize
//    when their sum differs from 1 (beyond SCENE_SKIN_WEIGHT_EPSILON); a sum at or
//    below the epsilon passes the vertex through untransformed.
//  - THE CLIP-SAMPLING LAW: time wraps modulo duration when `loop`, clamps to
//    [0, duration] when not; channel sampling is keyframe interval search — LINEAR
//    lerp for translation/scale, spherical slerp for rotation (shortest path via the
//    dot-sign flip; nlerp past SCENE_SLERP_NLERP_THRESHOLD), STEP holds the left key;
//    at/before the first key the first value, at/after the last key the last.
//  - THE CROSSFADE LAW: progress = clamp(elapsedMs / blendMs, 0, 1) (blendMs ≤ 0 is
//    the hard cut — progress 1); a blended pose lerps t/s componentwise and slerps r,
//    per node over the union of both poses (a missing side reads the node's base TRS).
//  - THE MIXER (the crossfade state machine every renderer drives): the INITIAL clip
//    applies without a fade; switching `animation` starts one crossfade from the
//    out-clip's CONTINUING clock; a mid-fade switch drops the older fade; an unknown
//    clip name diagnoses (`unknown-clip`) and KEEPS the current clip; the empty name
//    is the BIND POSE (an empty pose). `active` is the loop-existence read: a fade in
//    flight, a looping clip, or an unfinished non-looping clip.
//
//  This module owns the NUMBERS; the render adapters (packages/dom scene.ts, the JVM
//  SceneSkin.kt twin, the Swift SceneSkin.swift twin) own only the wiring.
//

import type { Mat4, Vec3 } from "./math.ts";
import { mat4Identity, mat4Invert, mat4Multiply } from "./math.ts";
import { quaternionToMat4, type GlbChannel, type GlbClip, type GlbModel, type GlbNode } from "./gltf.ts";
import type { SceneDiag } from "./ir.ts";

// ── the pinned constants (corpus `constants` — the runner asserts these) ─────────────

/** weights whose sum is within this of 0 pass the vertex through; otherwise ≠1 renormalizes */
export const SCENE_SKIN_WEIGHT_EPSILON = 1e-6;
/** quaternion dot beyond this uses normalized lerp (the numerically-safe near-parallel branch) */
export const SCENE_SLERP_NLERP_THRESHOLD = 0.9995;
/** `<model blend>` default: 0 ms = the hard cut */
export const SCENE_CLIP_DEFAULT_BLEND_MS = 0;
/** `<model loop>` default: clips loop */
export const SCENE_CLIP_DEFAULT_LOOP = true;

export type GlbQuat = [number, number, number, number];

/** one node's animated local transform — absent channels fall back to the base TRS */
export type GlbTrsOverride = { t?: Vec3; r?: GlbQuat; s?: Vec3 };

/** a sampled pose: node index → animated channels. The EMPTY map is the bind pose. */
export type GlbPose = Map<number, GlbTrsOverride>;

// ── quaternions ──────────────────────────────────────────────────────────────────────

/** spherical linear interpolation, shortest path: a negative dot flips b; a dot past
 *  SCENE_SLERP_NLERP_THRESHOLD lerps + normalizes (the near-parallel branch) */
export function quatSlerp(a: GlbQuat, b: GlbQuat, t: number): GlbQuat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  if (dot > SCENE_SLERP_NLERP_THRESHOLD) {
    const out: GlbQuat = [
      a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t,
    ];
    const length = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3]);
    return length > 0 ? [out[0] / length, out[1] / length, out[2] / length, out[3] / length] : [0, 0, 0, 1];
  }
  const theta = Math.acos(Math.min(dot, 1));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return [
    wa * a[0] + wb * bx, wa * a[1] + wb * by,
    wa * a[2] + wb * bz, wa * a[3] + wb * bw,
  ];
}

// ── node worlds under a pose ─────────────────────────────────────────────────────────

/** one node's local matrix: pose channels override base TRS per property; a
 *  matrix-authored node with no pose entry uses its matrix verbatim */
export function glbLocalMatrix(node: GlbNode, pose?: GlbTrsOverride): Mat4 {
  if (node.matrix !== null && pose === undefined) return node.matrix;
  const t = pose?.t ?? node.translation;
  const r = pose?.r ?? node.rotation;
  const s = pose?.s ?? node.scale;
  const translate: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
  const scale: Mat4 = [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1];
  return mat4Multiply(mat4Multiply(translate, quaternionToMat4(r[0], r[1], r[2], r[3])), scale);
}

/** every node's world transform over the FULL node forest (roots = nodes no children
 *  list references), pose-aware — the hierarchy leg of the joint-matrix law */
export function glbNodeWorlds(model: GlbModel, pose?: GlbPose | null): Mat4[] {
  const count = model.nodes.length;
  const parent = new Array<number>(count).fill(-1);
  for (let i = 0; i < count; i += 1) {
    for (const child of model.nodes[i]!.children) {
      if (child >= 0 && child < count) parent[child] = i;
    }
  }
  const worlds = new Array<Mat4 | null>(count).fill(null);
  const world = (index: number, depth: number): Mat4 => {
    const cached = worlds[index];
    if (cached !== null) return cached;
    const local = glbLocalMatrix(model.nodes[index]!, pose?.get(index));
    const out = depth > 64 || parent[index] === -1
      ? local : mat4Multiply(world(parent[index]!, depth + 1), local);
    worlds[index] = out;
    return out;
  };
  for (let i = 0; i < count; i += 1) world(i, 0);
  return worlds as Mat4[];
}

/** THE JOINT-MATRIX LAW: inverse(meshNodeWorld) · jointWorld · inverseBindMatrix,
 *  per skin joint. A singular mesh world inverts to identity (failure is a value). */
export function glbJointMatrices(
  model: GlbModel, skinIndex: number, meshNode: number, worlds: readonly Mat4[],
): Mat4[] {
  const skin = model.skins[skinIndex];
  if (skin === undefined) return [];
  const meshWorld = worlds[meshNode] ?? mat4Identity();
  const inverseMesh = mat4Invert(meshWorld) ?? mat4Identity();
  return skin.joints.map((joint, i) => {
    const jointWorld = worlds[joint] ?? mat4Identity();
    const ibm = skin.inverseBindMatrices[i] ?? mat4Identity();
    return mat4Multiply(mat4Multiply(inverseMesh, jointWorld), ibm);
  });
}

// ── vertex skinning ──────────────────────────────────────────────────────────────────

/** THE SKINNING LAW for one vertex: Σ w[i] · jointMatrix[i] · pos, weights renormalized
 *  when their sum ≠ 1; a sum ≤ SCENE_SKIN_WEIGHT_EPSILON passes the vertex through */
export function skinPosition(
  position: Vec3, joints: readonly number[], weights: readonly number[],
  matrices: readonly Mat4[],
): Vec3 {
  const sum = weights[0]! + weights[1]! + weights[2]! + weights[3]!;
  if (sum <= SCENE_SKIN_WEIGHT_EPSILON) return [position[0], position[1], position[2]];
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 4; i += 1) {
    const w = weights[i]! / sum;
    if (w === 0) continue;
    const m = matrices[joints[i]!];
    if (m === undefined) continue;
    out[0] += w * (m[0]! * position[0] + m[4]! * position[1] + m[8]! * position[2] + m[12]!);
    out[1] += w * (m[1]! * position[0] + m[5]! * position[1] + m[9]! * position[2] + m[13]!);
    out[2] += w * (m[2]! * position[0] + m[6]! * position[1] + m[10]! * position[2] + m[14]!);
  }
  return out;
}

/** a whole primitive's skinned positions (flat triples); null when the primitive
 *  carries no JOINTS_0/WEIGHTS_0 (unskinned — draw the authored positions) */
export function skinnedPrimitivePositions(
  primitive: { readonly positions: number[]; readonly joints: number[]; readonly weights: number[] },
  matrices: readonly Mat4[],
): number[] | null {
  const vertexCount = primitive.positions.length / 3;
  if (primitive.joints.length < vertexCount * 4 || primitive.weights.length < vertexCount * 4) return null;
  const out = new Array<number>(primitive.positions.length);
  for (let v = 0; v < vertexCount; v += 1) {
    const skinned = skinPosition(
      [primitive.positions[v * 3]!, primitive.positions[v * 3 + 1]!, primitive.positions[v * 3 + 2]!],
      primitive.joints.slice(v * 4, v * 4 + 4),
      primitive.weights.slice(v * 4, v * 4 + 4),
      matrices,
    );
    out[v * 3] = skinned[0];
    out[v * 3 + 1] = skinned[1];
    out[v * 3 + 2] = skinned[2];
  }
  return out;
}

// ── clip sampling ────────────────────────────────────────────────────────────────────

/** THE CLIP-TIME LAW: loop wraps modulo duration, non-loop clamps to [0, duration];
 *  a non-positive duration is always 0 */
export function glbClipTime(time: number, duration: number, loop: boolean): number {
  if (duration <= 0) return 0;
  if (loop) return time - Math.floor(time / duration) * duration;
  return Math.min(Math.max(time, 0), duration);
}

/** THE CHANNEL-SAMPLING LAW: interval search + LINEAR lerp (slerp for rotation) or
 *  STEP left-hold; clamped to the first/last key outside the key range */
export function sampleGlbChannel(channel: GlbChannel, time: number): number[] {
  const components = channel.path === "rotation" ? 4 : 3;
  const times = channel.times;
  const values = channel.values;
  const count = times.length;
  if (count === 0) return new Array<number>(components).fill(0);
  if (time <= times[0]!) return values.slice(0, components);
  if (time >= times[count - 1]!) return values.slice((count - 1) * components, count * components);
  let k = 0;
  while (k + 1 < count && times[k + 1]! <= time) k += 1;
  const a = values.slice(k * components, (k + 1) * components);
  if (channel.interpolation === "STEP") return a;
  const b = values.slice((k + 1) * components, (k + 2) * components);
  const u = (time - times[k]!) / (times[k + 1]! - times[k]!);
  if (channel.path === "rotation") {
    return quatSlerp(a as GlbQuat, b as GlbQuat, u);
  }
  return a.map((v, i) => v + (b[i]! - v) * u);
}

/** sample a whole clip at a wrapped/clamped time (seconds) into a pose */
export function sampleGlbClip(model: GlbModel, clip: GlbClip, time: number, loop: boolean): GlbPose {
  const wrapped = glbClipTime(time, clip.duration, loop);
  const pose: GlbPose = new Map();
  for (const channel of clip.channels) {
    if (channel.node < 0 || channel.node >= model.nodes.length) continue;
    const value = sampleGlbChannel(channel, wrapped);
    let entry = pose.get(channel.node);
    if (entry === undefined) { entry = {}; pose.set(channel.node, entry); }
    if (channel.path === "translation") entry.t = [value[0]!, value[1]!, value[2]!];
    else if (channel.path === "scale") entry.s = [value[0]!, value[1]!, value[2]!];
    else entry.r = [value[0]!, value[1]!, value[2]!, value[3]!];
  }
  return pose;
}

export function findGlbClip(model: GlbModel, name: string): GlbClip | null {
  for (const clip of model.clips) {
    if (clip.name === name) return clip;
  }
  return null;
}

// ── crossfade ────────────────────────────────────────────────────────────────────────

/** THE RAMP LAW: clamp(elapsedMs / blendMs, 0, 1); blendMs ≤ 0 is the hard cut (1) */
export function sceneCrossfadeProgress(elapsedMs: number, blendMs: number): number {
  if (blendMs <= 0) return 1;
  return Math.min(Math.max(elapsedMs / blendMs, 0), 1);
}

export type GlbTrs = { t: Vec3; r: GlbQuat; s: Vec3 };

/** a node's effective TRS under a pose (pose channel ?? base) */
export function glbEffectiveTrs(node: GlbNode, pose?: GlbTrsOverride): GlbTrs {
  return {
    t: [...(pose?.t ?? node.translation)] as Vec3,
    r: [...(pose?.r ?? node.rotation)] as GlbQuat,
    s: [...(pose?.s ?? node.scale)] as Vec3,
  };
}

/** THE BLEND LAW for one node: t/s componentwise lerp, r shortest-path slerp */
export function blendGlbTrs(from: GlbTrs, to: GlbTrs, progress: number): GlbTrs {
  const lerp3 = (a: Vec3, b: Vec3): Vec3 => [
    a[0] + (b[0] - a[0]) * progress, a[1] + (b[1] - a[1]) * progress, a[2] + (b[2] - a[2]) * progress,
  ];
  return { t: lerp3(from.t, to.t), r: quatSlerp(from.r, to.r, progress), s: lerp3(from.s, to.s) };
}

/** blend two poses over the union of their nodes — a missing side reads base TRS */
export function blendGlbPoses(model: GlbModel, from: GlbPose, to: GlbPose, progress: number): GlbPose {
  const out: GlbPose = new Map();
  const indices = new Set<number>([...from.keys(), ...to.keys()]);
  for (const index of indices) {
    const node = model.nodes[index];
    if (node === undefined) continue;
    const blended = blendGlbTrs(
      glbEffectiveTrs(node, from.get(index)),
      glbEffectiveTrs(node, to.get(index)),
      progress,
    );
    out.set(index, { t: blended.t, r: blended.r, s: blended.s });
  }
  return out;
}

// ── the mixer (the crossfade state machine every renderer drives) ────────────────────

export type SceneClipMixer = {
  /** feed the resolved `animation`/`loop`/`blend` props each frame; a NAME CHANGE is
   *  the switch (unknown name → `unknown-clip` diagnostic + keep; "" → bind pose) */
  update(name: string, loop: boolean, blendMs: number, nowMs: number): void;
  /** the pose at nowMs — the empty map is the bind pose */
  pose(nowMs: number): GlbPose;
  /** the loop-existence read: a fade in flight, a looping clip, or an unfinished
   *  non-looping clip (a finished non-loop clip with no fade lets the loop stop) */
  active(nowMs: number): boolean;
};

export function createSceneClipMixer(model: GlbModel, diag?: SceneDiag): SceneClipMixer {
  let currentName: string | null = null;    // null = never assigned
  let currentClip: GlbClip | null = null;   // null = bind pose
  let currentStartMs = 0;
  let fading = false;
  let previousClip: GlbClip | null = null;  // the out-clip (null = bind) while fading
  let previousStartMs = 0;
  let fadeStartMs = 0;
  let fadeBlendMs = 0;
  let loop = SCENE_CLIP_DEFAULT_LOOP;

  const poseOf = (clip: GlbClip | null, startMs: number, nowMs: number): GlbPose =>
    clip === null ? new Map() : sampleGlbClip(model, clip, (nowMs - startMs) / 1000, loop);

  return {
    update(name, loopFlag, blendMs, nowMs) {
      loop = loopFlag;
      if (name === currentName) return;
      const clip = name === "" ? null : findGlbClip(model, name);
      if (name !== "" && clip === null) {
        diag?.({ code: "unknown-clip", message: `animation="${name}" is not a clip in this model — keeping the current clip` });
        return;
      }
      if (currentName === null) {
        // the initial assignment applies WITHOUT a crossfade (the mount law)
        currentName = name;
        currentClip = clip;
        currentStartMs = nowMs;
        return;
      }
      if (blendMs > 0) {
        // one crossfade at a time: a mid-fade switch drops the older fade — the
        // out-clip is the clip that WAS current, on its continuing clock
        fading = true;
        previousClip = currentClip;
        previousStartMs = currentStartMs;
        fadeStartMs = nowMs;
        fadeBlendMs = blendMs;
      } else {
        fading = false;
        previousClip = null;
      }
      currentName = name;
      currentClip = clip;
      currentStartMs = nowMs;
    },
    pose(nowMs) {
      const current = poseOf(currentClip, currentStartMs, nowMs);
      if (!fading) return current;
      const progress = sceneCrossfadeProgress(nowMs - fadeStartMs, fadeBlendMs);
      if (progress >= 1) {
        fading = false;
        previousClip = null;
        return current;
      }
      return blendGlbPoses(model, poseOf(previousClip, previousStartMs, nowMs), current, progress);
    },
    active(nowMs) {
      if (fading && sceneCrossfadeProgress(nowMs - fadeStartMs, fadeBlendMs) < 1) return true;
      if (currentClip === null || currentClip.duration <= 0) return false;
      if (loop) return true;
      return (nowMs - currentStartMs) / 1000 < currentClip.duration;
    },
  };
}
