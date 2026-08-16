//
//  scene/collide.ts - opt-in scene collisions (dsx-scene.md P5), corpus
//  OpenSource/Conformance/scene/collide.json. `collide="sphere"` (bounding sphere —
//  the picking sphere law) or `collide="box"` (world AABB) opts a node in; the scene
//  tests pairs among opted-in nodes after each rendered frame ONLY while at least one
//  `on:collide` handler is authored (the zero-cost static law: nothing moves without a
//  render, so the pass rides the render, never its own loop). Payload {id, other,
//  depth}. THE ENTER LAW: on:collide fires when a pair STARTS overlapping and fires
//  again only after the pair has fully separated (touch with depth 0 is NOT a
//  contact). All math is platform-neutral and corpus-pinned.
//

import type { Mat4, Vec3 } from "./math.ts";
import { nodeBoundingRadius, worldBoundingSphere, type SceneNode, type SceneNodeProps } from "./ir.ts";

export type SceneColliderShape =
  | { id: string; kind: "sphere"; center: Vec3; radius: number }
  | { id: string; kind: "box"; min: Vec3; max: Vec3 };

/** the world AABB of a node's local extents: the 8 corners of [−half, +half]
 *  transformed by the world matrix, folded to min/max */
export function worldAabb(world: Mat4, half: Vec3): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i += 1) {
    const local: Vec3 = [
      (i & 1) === 0 ? -half[0] : half[0],
      (i & 2) === 0 ? -half[1] : half[1],
      (i & 4) === 0 ? -half[2] : half[2],
    ];
    const x = world[0]! * local[0] + world[4]! * local[1] + world[8]! * local[2] + world[12]!;
    const y = world[1]! * local[0] + world[5]! * local[1] + world[9]! * local[2] + world[13]!;
    const z = world[2]! * local[0] + world[6]! * local[1] + world[10]! * local[2] + world[14]!;
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }
  return { min, max };
}

/** THE DEPTH LAWS (pinned):
 *  - sphere↔sphere: depth = rₐ + r_b − |cₐ − c_b|.
 *  - box↔box: overlap per axis oᵢ = min(maxₐᵢ, max_bᵢ) − max(minₐᵢ, min_bᵢ); a contact
 *    needs every oᵢ > 0; depth = min(o₀, o₁, o₂).
 *  - sphere↔box: q = the box point nearest the center (componentwise clamp);
 *    outside (|c − q| > 0): depth = r − |c − q|; center INSIDE the box: depth =
 *    r + min over axes of the distance from the center to its nearest face.
 *  A pair overlaps only when depth > 0 — exact touch is NOT a contact. */
export function collidePair(a: SceneColliderShape, b: SceneColliderShape): number | null {
  if (a.kind === "sphere" && b.kind === "sphere") {
    const depth = a.radius + b.radius - Math.hypot(
      a.center[0] - b.center[0], a.center[1] - b.center[1], a.center[2] - b.center[2]);
    return depth > 0 ? depth : null;
  }
  if (a.kind === "box" && b.kind === "box") {
    let depth = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const overlap = Math.min(a.max[i]!, b.max[i]!) - Math.max(a.min[i]!, b.min[i]!);
      if (overlap <= 0) return null;
      if (overlap < depth) depth = overlap;
    }
    return depth;
  }
  const sphere = a.kind === "sphere" ? a : b as Extract<SceneColliderShape, { kind: "sphere" }>;
  const box = a.kind === "box" ? a : b as Extract<SceneColliderShape, { kind: "box" }>;
  const q: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    q[i] = Math.min(Math.max(sphere.center[i]!, box.min[i]!), box.max[i]!);
  }
  const dist = Math.hypot(
    sphere.center[0] - q[0], sphere.center[1] - q[1], sphere.center[2] - q[2]);
  if (dist > 0) {
    const depth = sphere.radius - dist;
    return depth > 0 ? depth : null;
  }
  let inside = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const toFace = Math.min(sphere.center[i]! - box.min[i]!, box.max[i]! - sphere.center[i]!);
    if (toFace < inside) inside = toFace;
  }
  return sphere.radius + inside;
}

/** a node's collider under its collide= word: "sphere" = the node's bounding sphere
 *  (the picking-sphere law verbatim); "box" = the world AABB of the node's local half
 *  extents (box: size/2 · sphere: radius · plane: [w/2, h/2, 0]). null = not a
 *  collider (no collide word, or a non-geometry node). `id` is the caller's tracker
 *  identity (unique per node — the renderer's job). */
export function sceneColliderFor(
  node: SceneNode, props: SceneNodeProps, world: Mat4, id: string,
): SceneColliderShape | null {
  if (props.collide === "sphere") {
    const local = nodeBoundingRadius(node, props);
    if (local === null) return null;
    const sphere = worldBoundingSphere(world, local);
    return { id, kind: "sphere", center: sphere.center, radius: sphere.radius };
  }
  if (props.collide === "box") {
    const half: Vec3 | null =
      node.kind === "box" ? [props.boxSize[0] / 2, props.boxSize[1] / 2, props.boxSize[2] / 2]
      : node.kind === "sphere" ? [props.radius, props.radius, props.radius]
      : node.kind === "plane" ? [props.planeSize[0] / 2, props.planeSize[1] / 2, 0]
      : null;
    if (half === null) return null;
    const aabb = worldAabb(world, half);
    return { id, kind: "box", min: aabb.min, max: aabb.max };
  }
  return null;
}

export type SceneContact = { a: string; b: string; depth: number };

/** every overlapping pair among the shapes, document order (i < j) */
export function sceneContacts(shapes: readonly SceneColliderShape[]): SceneContact[] {
  const out: SceneContact[] = [];
  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) {
      const depth = collidePair(shapes[i]!, shapes[j]!);
      if (depth !== null) out.push({ a: shapes[i]!.id, b: shapes[j]!.id, depth });
    }
  }
  return out;
}

export type SceneCollisionEvent = { id: string; other: string; depth: number };

export type SceneCollisionTracker = {
  /** feed one frame's shapes; the ENTER events this frame (both directions per new
   *  contact: {id: a, other: b} and {id: b, other: a}), in contact order */
  step(shapes: readonly SceneColliderShape[]): SceneCollisionEvent[];
};

/** THE ENTER-ONLY FOLD: a pair fires on overlap START and re-arms only once the pair
 *  is no longer overlapping. Pair identity is the id pair — the renderer feeds unique
 *  per-node ids. Pure state machine, corpus-pinned as frame data. */
export function createSceneCollisionTracker(): SceneCollisionTracker {
  const overlapping = new Set<string>();
  return {
    step(shapes) {
      const events: SceneCollisionEvent[] = [];
      const current = new Set<string>();
      for (const contact of sceneContacts(shapes)) {
        const key = `${contact.a}\u0000${contact.b}`;
        current.add(key);
        if (!overlapping.has(key)) {
          events.push({ id: contact.a, other: contact.b, depth: contact.depth });
          events.push({ id: contact.b, other: contact.a, depth: contact.depth });
        }
      }
      overlapping.clear();
      for (const key of current) overlapping.add(key);
      return events;
    },
  };
}
