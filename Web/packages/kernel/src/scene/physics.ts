//
//  scene/physics.ts - the DSX Scene G2 physics kernel (dsx-game.md §2 G2), platform-
//  neutral and corpus-pinned (OpenSource/Conformance/scene/physics.json — every law
//  spelled out in that file's _note and the corpus README). The shape:
//
//  - THE FIXED-TICK LAW: the simulation steps at EXACTLY 60 Hz (dt = 1/60 s), decoupled
//    from rendering. The renderer interpolates body positions between the last two
//    steps (alpha = accumulator/dt); the accumulator caps at 5 steps per frame and
//    DISCARDS the excess (the spiral-of-death guard — the sim slows, never spirals).
//    `on:tick` fires per fixed step with { dt: 1/60, tick: n }; on:frame stays
//    render-rate.
//  - THE DETERMINISM LAW: same initial state + same inputs → identical states to 6
//    decimals on every runner. All math in doubles, fixed document-order iteration,
//    only +,-,*,/ and sqrt (Math.hypot is NOT used in the solver — sqrt of a sum of
//    squares is identically rounded on every IEEE runtime; hypot is not so pinned).
//  - BODIES: static · dynamic · kinematic (follows its authored/bound transform,
//    pushes with derived velocity) · character (move-and-slide; speed/jump attrs;
//    never sleeps; infinite mass against dynamics). Dynamic bodies integrate angular
//    velocity and world torque against a shape-derived diagonal inertia tensor, then
//    apply deterministic linear angular damping. Rotation is stored in DSX degrees;
//    angular velocity is radians/second. A normalized quaternion is the integration
//    state, while DSX Euler angles remain the public/render plane. Box contacts use a
//    15-axis OBB SAT, clipped face/support-edge manifolds and every impulse is applied
//    at its deterministic contact point with persistent coherent warm starting.
//    Capsule colliders remain a named absence.
//  - THE SOLVER: semi-implicit linear integration; sphere/box contacts with the P5 collide depth
//    laws + pinned normals; impulse resolution with restitution (max, with the 0.5
//    approach-speed micro-bounce guard) and Coulomb friction (sqrt mixing, clamped to
//    ±mu·j); Baumgarte positional correction (percent 0.8, slop 0.005); character
//    move-and-slide with full depenetration, velocity projection and ground detection
//    (surface normal up.y > 0.7); sleep at |v| < 0.05 for 60 ticks, wake on write or
//    energetic contact. Triggers overlap without forces (enter/exit tracker).
//
//  This module owns the NUMBERS; the render adapters (packages/dom scene.ts, the
//  JVM/Swift twins when they land from this corpus) own only the wiring.
//

import type { Mat4, Vec3 } from "./math.ts";
import { mat4Identity, mat4Multiply, mat4Trs, mat4Invert, transformPoint } from "./math.ts";
import { spriteAnchorOffset, spriteSizeOf } from "./sprite.ts";
import {
  nodeBoundingRadius, readScalar, readString, readVec, resolvedProps,
  type SceneDiag, type SceneIR, type SceneNode, type SceneResolve,
} from "./ir.ts";

// ── the pinned constants (corpus `constants` — the runner asserts these) ─────────────

export const SCENE_PHYSICS_DT = 1 / 60;
export const SCENE_PHYSICS_MAX_STEPS = 5;
export const SCENE_PHYSICS_DEFAULT_GRAVITY: Vec3 = [0, -9.81, 0];
export const SCENE_PHYSICS_CORRECTION_PERCENT = 0.8;
export const SCENE_PHYSICS_SLOP = 0.005;
export const SCENE_PHYSICS_RESTITUTION_MIN_SPEED = 0.5;
export const SCENE_PHYSICS_GROUND_NORMAL_Y = 0.7;
export const SCENE_PHYSICS_SLEEP_SPEED = 0.05;
export const SCENE_PHYSICS_SLEEP_TICKS = 60;
export const SCENE_PHYSICS_SLIDE_ITERATIONS = 4;
export const SCENE_PHYSICS_MANIFOLD_ITERATIONS = 32;
export const SCENE_PHYSICS_DEFAULT_SPEED = 5;
export const SCENE_PHYSICS_DEFAULT_JUMP = 8;
export const SCENE_PHYSICS_DEFAULT_ANGULAR_DAMPING = 0;
export const SCENE_PHYSICS_RADIANS_TO_DEGREES = 57.29577951308232;
export const SCENE_PHYSICS_DEGREES_TO_RADIANS = 0.017453292519943295;
/** G6 (sprite.json): the 2D extrusion of a `<sprite>` box collider — effectively
 *  infinite at scene scales, so the minimum-overlap axis of a box↔box contact is
 *  ALWAYS in the XY plane (the 2D semantics of an extruded rectangle) */
export const SCENE_SPRITE_COLLIDER_HALF_Z = 1000;

export type ScenePhysicsKind = "static" | "dynamic" | "kinematic" | "character";

export const SCENE_PHYSICS_KINDS: ReadonlySet<string> =
  new Set(["static", "dynamic", "kinematic", "character"]);

export type ScenePhysicsShape =
  | { kind: "sphere"; radius: number }
  | { kind: "box"; half: Vec3 };

export type ScenePhysicsBodySpec = {
  id: string;
  kind: ScenePhysicsKind;
  shape: ScenePhysicsShape;
  position?: Vec3;
  velocity?: Vec3;
  /** DSX Euler degrees, X then Y then Z */
  rotation?: Vec3;
  /** radians/second in scene axes */
  angularVelocity?: Vec3;
  /** persistent world torque applied each fixed step */
  torque?: Vec3;
  /** linear angular drag coefficient in 1/seconds */
  angularDamping?: number;
  mass?: number;
  bounce?: number;
  friction?: number;
  trigger?: boolean;
  layer?: string;
  collides?: readonly string[] | null;
  speed?: number;
  jump?: number;
};

export type ScenePhysicsBody = {
  readonly id: string;
  readonly kind: ScenePhysicsKind;
  readonly shape: "sphere" | "box";
  readonly radius: number;
  readonly half: Vec3;
  /** solver-owned world position (the body CENTER) */
  position: Vec3;
  /** the position at the START of the last step — the interpolation anchor */
  previous: Vec3;
  velocity: Vec3;
  /** solver-owned DSX Euler degrees */
  rotation: Vec3;
  /** normalized [x,y,z,w] orientation used by contacts and stable integration */
  orientation: [number, number, number, number];
  /** the rotation at the START of the last step */
  previousRotation: Vec3;
  /** radians/second in scene axes */
  angularVelocity: Vec3;
  /** inverse diagonal inertia in the body's frozen extraction axes */
  readonly invInertia: Vec3;
  /** persistent world torque applied each fixed step */
  torque: Vec3;
  readonly angularDamping: number;
  readonly invMass: number;
  readonly bounce: number;
  readonly friction: number;
  readonly trigger: boolean;
  readonly layer: string;
  readonly collides: readonly string[] | null;
  readonly speed: number;
  readonly jump: number;
  grounded: boolean;
  sleeping: boolean;
  sleepCount: number;
  /** G6 THE Z-LOCK LAW (mode="2d" worlds only): the z position every step re-pins to.
   *  Recorded at world creation; a TELEPORT re-anchors it. */
  zLock: number;
  /** G6: the z velocity every step re-pins to — recorded at world creation and NEVER
   *  re-anchored (the named v1 shape) */
  readonly vzLock: number;
  /** mode="2d" preserves authored X/Y orientation; only Z may rotate */
  readonly rotation2dLock: Vec3;
  /** solver DOF mask: 2D bodies have only world-Z angular response */
  readonly mode2d: boolean;
  /** document index — the deterministic pair order */
  readonly index: number;
};

export type ScenePhysicsWorld = {
  readonly gravity: Vec3;
  /** G6: the world simulates inside `mode="2d"` — the z-lock pass runs each step */
  readonly mode2d: boolean;
  readonly bodies: ScenePhysicsBody[];
  readonly byId: Map<string, ScenePhysicsBody>;
  tick: number;
  solidOverlap: Set<string>;
  triggerOverlap: Set<string>;
  /** overlapping trigger pairs in insertion order — the pinned exit order */
  triggerOrder: string[];
};

type ScenePhysicsCachedImpulse = {
  readonly a: string;
  readonly b: string;
  normal: number;
  normalAxis: Vec3;
  tangent: Vec3;
  localAnchorA: Vec3;
  localAnchorB: Vec3;
  lastTick: number;
};

/** Solver-private: contact history must never leak onto the public world/store plane. */
const scenePhysicsContactCaches = new WeakMap<ScenePhysicsWorld, Map<string, ScenePhysicsCachedImpulse>>();

function contactCache(world: ScenePhysicsWorld): Map<string, ScenePhysicsCachedImpulse> {
  let cache = scenePhysicsContactCaches.get(world);
  if (cache === undefined) {
    cache = new Map();
    scenePhysicsContactCaches.set(world, cache);
  }
  return cache;
}

/** Carry coherent warm-start state across a renderer-driven world rebuild. Only pairs
 * whose retained bodies keep the same document order are eligible: reversing a pair
 * changes manifold feature ownership, so that cache is deliberately recomputed. */
export function carryScenePhysicsContactState(
  previous: ScenePhysicsWorld,
  next: ScenePhysicsWorld,
  idMap: ReadonlyMap<string, string>,
): void {
  const source = scenePhysicsContactCaches.get(previous);
  if (source === undefined) return;
  const carried = new Map<string, ScenePhysicsCachedImpulse>();
  for (const [key, value] of source) {
    const a = idMap.get(value.a);
    const b = idMap.get(value.b);
    if (a === undefined || b === undefined) continue;
    const nextA = next.byId.get(a);
    const nextB = next.byId.get(b);
    if (nextA === undefined || nextB === undefined || nextA.index >= nextB.index) continue;
    const oldPrefix = `${value.a}\u0000${value.b}\u0000`;
    if (!key.startsWith(oldPrefix)) continue;
    const nextKey = `${a}\u0000${b}\u0000${key.slice(oldPrefix.length)}`;
    carried.set(nextKey, {
      a, b, normal: value.normal, normalAxis: [...value.normalAxis] as Vec3,
      tangent: [...value.tangent] as Vec3,
      localAnchorA: [...value.localAnchorA] as Vec3,
      localAnchorB: [...value.localAnchorB] as Vec3,
      lastTick: value.lastTick,
    });
  }
  if (carried.size > 0) scenePhysicsContactCaches.set(next, carried);
}

function invalidateContactCache(world: ScenePhysicsWorld, id: string): void {
  const cache = scenePhysicsContactCaches.get(world);
  if (cache === undefined) return;
  for (const [key, value] of cache) if (value.a === id || value.b === id) cache.delete(key);
}

export type ScenePhysicsPairEvent = { id: string; other: string };

export type ScenePhysicsStepResult = {
  /** the zero-based index of the step just completed (the on:tick payload's `tick`) */
  tick: number;
  /** always exactly SCENE_PHYSICS_DT (the on:tick payload's `dt`) */
  dt: number;
  collisions: ScenePhysicsPairEvent[];
  enters: ScenePhysicsPairEvent[];
  exits: ScenePhysicsPairEvent[];
};

export type ScenePhysicsIntent = {
  /** character horizontal intent "x z" (normalized only when |move| > 1, × speed) */
  move?: readonly [number, number];
  /** kinematic drive: the authored/bound position this step */
  position?: Vec3;
  /** kinematic drive: authored/bound DSX Euler rotation this step */
  rotation?: Vec3;
};

export type ScenePhysicsIntents = { readonly [id: string]: ScenePhysicsIntent };

// ── construction ─────────────────────────────────────────────────────────────────────

export function createScenePhysicsWorld(
  gravity: Vec3, specs: readonly ScenePhysicsBodySpec[], mode2d = false,
): ScenePhysicsWorld {
  const bodies: ScenePhysicsBody[] = specs.map((spec, index) => {
    const mass = spec.mass ?? 1;
    const invInertia = scenePhysicsInverseInertia(spec.kind, spec.shape, mass);
    const rotation = [...(spec.rotation ?? [0, 0, 0])] as Vec3;
    return {
      id: spec.id,
      kind: spec.kind,
      shape: spec.shape.kind,
      radius: spec.shape.kind === "sphere" ? spec.shape.radius : 0,
      half: spec.shape.kind === "box" ? [...spec.shape.half] as Vec3 : [0, 0, 0],
      position: [...(spec.position ?? [0, 0, 0])] as Vec3,
      previous: [...(spec.position ?? [0, 0, 0])] as Vec3,
      velocity: [...(spec.velocity ?? [0, 0, 0])] as Vec3,
      rotation,
      orientation: quaternionFromEuler(rotation),
      previousRotation: [...rotation] as Vec3,
      angularVelocity: [...(spec.angularVelocity ?? [0, 0, 0])] as Vec3,
      invInertia,
      torque: [...(spec.torque ?? [0, 0, 0])] as Vec3,
      angularDamping: Math.max(spec.angularDamping ?? SCENE_PHYSICS_DEFAULT_ANGULAR_DAMPING, 0),
      invMass: spec.kind === "dynamic" && mass > 0 ? 1 / mass : 0,
      bounce: spec.bounce ?? 0,
      friction: spec.friction ?? 0.5,
      trigger: spec.trigger ?? false,
      layer: spec.layer ?? "default",
      collides: spec.collides ?? null,
      speed: spec.speed ?? SCENE_PHYSICS_DEFAULT_SPEED,
      jump: spec.jump ?? SCENE_PHYSICS_DEFAULT_JUMP,
      grounded: false,
      sleeping: false,
      sleepCount: 0,
      zLock: (spec.position ?? [0, 0, 0])[2]!,
      vzLock: (spec.velocity ?? [0, 0, 0])[2]!,
      rotation2dLock: [...rotation] as Vec3,
      mode2d,
      index,
    };
  });
  const world: ScenePhysicsWorld = {
    gravity: [...gravity] as Vec3,
    mode2d,
    bodies,
    byId: new Map(bodies.map((b) => [b.id, b])),
    tick: 0,
    solidOverlap: new Set(),
    triggerOverlap: new Set(),
    triggerOrder: [],
  };
  scenePhysicsContactCaches.set(world, new Map());
  return world;
}

/** Solid-sphere and solid-box diagonal inertia in body-local principal axes. */
export function scenePhysicsInverseInertia(
  kind: ScenePhysicsKind, shape: ScenePhysicsShape, mass: number,
): Vec3 {
  if (kind !== "dynamic" || mass <= 0) return [0, 0, 0];
  if (shape.kind === "sphere") {
    const inertia = 0.4 * mass * shape.radius * shape.radius;
    const inv = inertia > 0 ? 1 / inertia : 0;
    return [inv, inv, inv];
  }
  const [hx, hy, hz] = shape.half;
  const ix = mass * (hy * hy + hz * hz) / 3;
  const iy = mass * (hx * hx + hz * hz) / 3;
  const iz = mass * (hx * hx + hy * hy) / 3;
  return [ix > 0 ? 1 / ix : 0, iy > 0 ? 1 / iy : 0, iz > 0 ? 1 / iz : 0];
}

/** THE VELOCITY-WRITE LAW: sets the velocity verbatim and wakes the body */
export function scenePhysicsWriteVelocity(world: ScenePhysicsWorld, id: string, v: Vec3): boolean {
  const body = world.byId.get(id);
  if (body === undefined) return false;
  body.velocity = [...v] as Vec3;
  invalidateContactCache(world, id);
  body.sleeping = false;
  body.sleepCount = 0;
  return true;
}

/** Sets angular velocity in radians/second and wakes the body. */
export function scenePhysicsWriteAngularVelocity(
  world: ScenePhysicsWorld, id: string, v: Vec3,
): boolean {
  const body = world.byId.get(id);
  if (body === undefined) return false;
  body.angularVelocity = [...v] as Vec3;
  invalidateContactCache(world, id);
  body.sleeping = false;
  body.sleepCount = 0;
  return true;
}

/** Sets the persistent world torque and wakes the body. */
export function scenePhysicsWriteTorque(world: ScenePhysicsWorld, id: string, torque: Vec3): boolean {
  const body = world.byId.get(id);
  if (body === undefined) return false;
  body.torque = [...torque] as Vec3;
  invalidateContactCache(world, id);
  body.sleeping = false;
  body.sleepCount = 0;
  return true;
}

/** Rotation teleport in DSX Euler degrees: reset the interpolation anchor and angular
 * velocity so authored/bus writes never leave hidden spin behind. */
export function scenePhysicsTeleportRotation(
  world: ScenePhysicsWorld, id: string, rotation: Vec3,
): boolean {
  const body = world.byId.get(id);
  if (body === undefined) return false;
  body.rotation = [...rotation] as Vec3;
  body.orientation = quaternionFromEuler(rotation);
  body.previousRotation = [...rotation] as Vec3;
  body.angularVelocity = [0, 0, 0];
  invalidateContactCache(world, id);
  body.sleeping = false;
  body.sleepCount = 0;
  return true;
}

/** THE TELEPORT LAW: an authored/bound/bus position write moves the body, RESETS its
 *  velocity to zero, resets the interpolation anchor (no glide across a teleport),
 *  and wakes it */
export function scenePhysicsTeleport(world: ScenePhysicsWorld, id: string, p: Vec3): boolean {
  const body = world.byId.get(id);
  if (body === undefined) return false;
  body.position = [...p] as Vec3;
  body.previous = [...p] as Vec3;
  body.velocity = [0, 0, 0];
  invalidateContactCache(world, id);
  body.zLock = p[2];   // G6: a teleport RE-ANCHORS the 2D z-lock (vzLock never moves)
  body.sleeping = false;
  body.sleepCount = 0;
  return true;
}

/** the v1 kinematic-write wake law: no island graph (named absence) — a kinematic
 *  position write wakes every sleeping body */
export function scenePhysicsWakeAll(world: ScenePhysicsWorld): void {
  for (const body of world.bodies) {
    if (body.sleeping) { body.sleeping = false; body.sleepCount = 0; }
  }
}

// ── the contact laws ─────────────────────────────────────────────────────────────────

/** deterministic length — sqrt is correctly rounded on every IEEE runtime */
function length3(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function subtract3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function quaternionMultiply(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function normalizeQuaternion(q: [number, number, number, number]): [number, number, number, number] {
  const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (length === 0) return [0, 0, 0, 1];
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** DSX Euler law is Rz*Ry*Rx: X acts on the object first, then Y, then Z. */
function quaternionFromEuler(rotation: Vec3): [number, number, number, number] {
  const hx = rotation[0] * SCENE_PHYSICS_DEGREES_TO_RADIANS / 2;
  const hy = rotation[1] * SCENE_PHYSICS_DEGREES_TO_RADIANS / 2;
  const hz = rotation[2] * SCENE_PHYSICS_DEGREES_TO_RADIANS / 2;
  const qx: [number, number, number, number] = [Math.sin(hx), 0, 0, Math.cos(hx)];
  const qy: [number, number, number, number] = [0, Math.sin(hy), 0, Math.cos(hy)];
  const qz: [number, number, number, number] = [0, 0, Math.sin(hz), Math.cos(hz)];
  return normalizeQuaternion(quaternionMultiply(quaternionMultiply(qz, qy), qx));
}

function quaternionAxes(q: readonly [number, number, number, number]): [Vec3, Vec3, Vec3] {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
    [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
    [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
  ];
}

const scenePhysicsAxesCache = new WeakMap<ScenePhysicsBody, {
  orientation: [number, number, number, number]; axes: [Vec3, Vec3, Vec3];
}>();

const scenePhysicsInertiaCache = new WeakMap<ScenePhysicsBody, {
  orientation: [number, number, number, number]; inverse: [Vec3, Vec3, Vec3]; tensor: [Vec3, Vec3, Vec3];
}>();

function bodyAxes(body: ScenePhysicsBody): [Vec3, Vec3, Vec3] {
  const cached = scenePhysicsAxesCache.get(body), q = body.orientation;
  if (cached !== undefined && cached.orientation[0] === q[0] && cached.orientation[1] === q[1]
      && cached.orientation[2] === q[2] && cached.orientation[3] === q[3]) return cached.axes;
  const axes = quaternionAxes(q);
  scenePhysicsAxesCache.set(body, { orientation: [...q], axes });
  return axes;
}

function bodyInertiaMatrices(body: ScenePhysicsBody): {
  inverse: [Vec3, Vec3, Vec3]; tensor: [Vec3, Vec3, Vec3];
} {
  const cached = scenePhysicsInertiaCache.get(body), q = body.orientation;
  if (cached !== undefined && cached.orientation[0] === q[0] && cached.orientation[1] === q[1]
      && cached.orientation[2] === q[2] && cached.orientation[3] === q[3]) return cached;
  const axes = bodyAxes(body);
  const inverse = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as [Vec3, Vec3, Vec3];
  const tensor = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as [Vec3, Vec3, Vec3];
  for (let axis = 0; axis < 3; axis += 1) {
    const inv = body.invInertia[axis]!, inertia = inv > 0 ? 1 / inv : 0;
    for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
      const projection = axes[axis]![row]! * axes[axis]![column]!;
      inverse[row]![column] += projection * inv;
      tensor[row]![column] += projection * inertia;
    }
  }
  const entry = { orientation: [...q] as [number, number, number, number], inverse, tensor };
  scenePhysicsInertiaCache.set(body, entry);
  return entry;
}

function unwrapDegrees(value: number, reference: number): number {
  let result = value;
  while (result - reference > 180) result -= 360;
  while (result - reference < -180) result += 360;
  return result;
}

function eulerFromQuaternion(
  q: readonly [number, number, number, number], previous: Vec3,
): Vec3 {
  const axes = quaternionAxes(q);
  const m00 = axes[0][0], m10 = axes[0][1], m20 = axes[0][2];
  const m11 = axes[1][1], m12 = axes[2][1], m21 = axes[1][2], m22 = axes[2][2];
  const ry = Math.asin(Math.max(-1, Math.min(1, -m20)));
  const cy = Math.cos(ry);
  const rx = Math.abs(cy) > 1e-9 ? Math.atan2(m21, m22) : Math.atan2(-m12, m11);
  const rz = Math.abs(cy) > 1e-9 ? Math.atan2(m10, m00) : 0;
  const principal: Vec3 = [
    unwrapDegrees(rx * SCENE_PHYSICS_RADIANS_TO_DEGREES, previous[0]),
    unwrapDegrees(ry * SCENE_PHYSICS_RADIANS_TO_DEGREES, previous[1]),
    unwrapDegrees(rz * SCENE_PHYSICS_RADIANS_TO_DEGREES, previous[2]),
  ];
  const alternateY = ry >= 0 ? Math.PI - ry : -Math.PI - ry;
  const alternate: Vec3 = [
    unwrapDegrees((rx + Math.PI) * SCENE_PHYSICS_RADIANS_TO_DEGREES, previous[0]),
    unwrapDegrees(alternateY * SCENE_PHYSICS_RADIANS_TO_DEGREES, previous[1]),
    unwrapDegrees((rz + Math.PI) * SCENE_PHYSICS_RADIANS_TO_DEGREES, previous[2]),
  ];
  const principalDistance = (principal[0] - previous[0]) ** 2
    + (principal[1] - previous[1]) ** 2 + (principal[2] - previous[2]) ** 2;
  const alternateDistance = (alternate[0] - previous[0]) ** 2
    + (alternate[1] - previous[1]) ** 2 + (alternate[2] - previous[2]) ** 2;
  return alternateDistance < principalDistance ? alternate : principal;
}

function shortestArcAngularVelocity(
  from: readonly [number, number, number, number],
  to: readonly [number, number, number, number], dt: number,
): Vec3 {
  const conjugate: [number, number, number, number] = [-from[0], -from[1], -from[2], from[3]];
  let delta = normalizeQuaternion(quaternionMultiply(to, conjugate));
  if (delta[3] < 0) delta = [-delta[0], -delta[1], -delta[2], -delta[3]];
  const vectorLength = Math.sqrt(delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]);
  if (vectorLength < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(vectorLength, Math.max(delta[3], 0));
  const scale = angle / (vectorLength * dt);
  return [delta[0] * scale, delta[1] * scale, delta[2] * scale];
}

/** Exponential-map step with world-space angular velocity. */
function integrateOrientation(body: ScenePhysicsBody, dt: number): void {
  const speed = length3(body.angularVelocity);
  if (speed === 0) return;
  const halfAngle = speed * dt / 2;
  const scale = Math.sin(halfAngle) / speed;
  const delta: [number, number, number, number] = [
    body.angularVelocity[0] * scale,
    body.angularVelocity[1] * scale,
    body.angularVelocity[2] * scale,
    Math.cos(halfAngle),
  ];
  body.orientation = normalizeQuaternion(quaternionMultiply(delta, body.orientation));
  body.rotation = eulerFromQuaternion(body.orientation, body.rotation);
}

function closestPointOnBox(point: Vec3, box: ScenePhysicsBody): Vec3 {
  const axes = bodyAxes(box);
  const d = subtract3(point, box.position);
  const out = [...box.position] as Vec3;
  for (let i = 0; i < 3; i += 1) {
    const amount = Math.min(Math.max(dot3(d, axes[i]!), -box.half[i]!), box.half[i]!);
    out[0] += axes[i]![0] * amount;
    out[1] += axes[i]![1] * amount;
    out[2] += axes[i]![2] * amount;
  }
  return out;
}

function localContactAnchor(point: Vec3, body: ScenePhysicsBody): Vec3 {
  const axes = bodyAxes(body), d = subtract3(point, body.position);
  return [dot3(d, axes[0]), dot3(d, axes[1]), dot3(d, axes[2])];
}

function layersCollide(a: ScenePhysicsBody, b: ScenePhysicsBody): boolean {
  if (a.collides !== null && !a.collides.includes(b.layer)) return false;
  if (b.collides !== null && !b.collides.includes(a.layer)) return false;
  return true;
}

export type ScenePhysicsContact = {
  depth: number; normal: Vec3; point: Vec3; points: readonly Vec3[]; features: readonly string[];
};

function boxVertices(box: ScenePhysicsBody): Vec3[] {
  const axes = bodyAxes(box);
  const vertices: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const vertex = [...box.position] as Vec3;
    const signs = [sx, sy, sz];
    for (let i = 0; i < 3; i += 1) for (let k = 0; k < 3; k += 1) {
      vertex[k] += axes[i]![k]! * box.half[i]! * signs[i]!;
    }
    vertices.push(vertex);
  }
  return vertices;
}

function pointInsideBox(point: Vec3, box: ScenePhysicsBody, margin = 1e-8): boolean {
  const axes = bodyAxes(box);
  const d = subtract3(point, box.position);
  for (let i = 0; i < 3; i += 1) if (Math.abs(dot3(d, axes[i]!)) > box.half[i]! + margin) return false;
  return true;
}

type ScenePhysicsPoint2 = { x: number; y: number; feature: string };

function supportFace(box: ScenePhysicsBody, direction: Vec3): { points: Array<{ point: Vec3; feature: string }>; feature: string } {
  const axes = bodyAxes(box);
  let faceAxis = 0, alignment = Math.abs(dot3(axes[0], direction));
  for (let i = 1; i < 3; i += 1) {
    const next = Math.abs(dot3(axes[i]!, direction));
    if (next > alignment) { faceAxis = i; alignment = next; }
  }
  const sign = dot3(axes[faceAxis]!, direction) >= 0 ? 1 : -1;
  const center: Vec3 = [
    box.position[0] + axes[faceAxis]![0] * box.half[faceAxis]! * sign,
    box.position[1] + axes[faceAxis]![1] * box.half[faceAxis]! * sign,
    box.position[2] + axes[faceAxis]![2] * box.half[faceAxis]! * sign,
  ];
  const sideAxes = [0, 1, 2].filter((axis) => axis !== faceAxis);
  const corners: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const faceFeature = `f${faceAxis}${sign > 0 ? "+" : "-"}`;
  return { feature: faceFeature, points: corners.map(([su, sv]) => {
    const point = [...center] as Vec3;
    for (let k = 0; k < 3; k += 1) {
      point[k] += axes[sideAxes[0]!]![k]! * box.half[sideAxes[0]!]! * su
        + axes[sideAxes[1]!]![k]! * box.half[sideAxes[1]!]! * sv;
    }
    return { point, feature: `${faceFeature}:v${su > 0 ? 1 : 0}${sv > 0 ? 1 : 0}` };
  }) };
}

function cross2(a: ScenePhysicsPoint2, b: ScenePhysicsPoint2, c: ScenePhysicsPoint2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function polygonArea2(points: readonly ScenePhysicsPoint2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    area += a.x * b.y - a.y * b.x;
  }
  return area;
}

function clipPolygon(
  subject: ScenePhysicsPoint2[], clip: ScenePhysicsPoint2[], clipFeature: string,
): ScenePhysicsPoint2[] {
  let output = subject;
  for (let edgeIndex = 0; edgeIndex < clip.length; edgeIndex += 1) {
    const edgeA = clip[edgeIndex]!, edgeB = clip[(edgeIndex + 1) % clip.length]!;
    const input = output;
    output = [];
    if (input.length === 0) break;
    let start = input[input.length - 1]!;
    let startDistance = cross2(edgeA, edgeB, start);
    for (const end of input) {
      const endDistance = cross2(edgeA, edgeB, end);
      const startInside = startDistance >= -1e-9, endInside = endDistance >= -1e-9;
      if (endInside !== startInside) {
        const denominator = startDistance - endDistance;
        const t = denominator === 0 ? 0 : startDistance / denominator;
        const edge = [start.feature, end.feature].sort().join("|");
        output.push({
          x: start.x + (end.x - start.x) * t,
          y: start.y + (end.y - start.y) * t,
          feature: `i(${edge};${clipFeature}:e${edgeIndex})`,
        });
      }
      if (endInside) output.push(end);
      start = end;
      startDistance = endDistance;
    }
  }
  return output;
}

function clippedFaceManifold(
  a: ScenePhysicsBody, b: ScenePhysicsBody, normal: Vec3, plane: number,
): Array<{ point: Vec3; feature: string }> | null {
  const absNormal: Vec3 = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])];
  const seed: Vec3 = absNormal[0] <= absNormal[1] && absNormal[0] <= absNormal[2]
    ? [1, 0, 0] : absNormal[1] <= absNormal[2] ? [0, 1, 0] : [0, 0, 1];
  const rawU = cross3(seed, normal), ul = length3(rawU);
  const u: Vec3 = [rawU[0] / ul, rawU[1] / ul, rawU[2] / ul];
  const v = cross3(normal, u);
  const faceA = supportFace(a, normal), faceB = supportFace(b, [-normal[0], -normal[1], -normal[2]]);
  const project = (entry: { point: Vec3; feature: string }): ScenePhysicsPoint2 => ({
    x: dot3(entry.point, u), y: dot3(entry.point, v), feature: entry.feature,
  });
  let polygonA = faceA.points.map(project);
  let polygonB = faceB.points.map(project);
  if (polygonArea2(polygonA) < 0) polygonA = [...polygonA].reverse();
  if (polygonArea2(polygonB) < 0) polygonB = [...polygonB].reverse();
  let clipped = clipPolygon(polygonA, polygonB, faceB.feature);
  if (clipped.length === 0) return null;
  clipped = clipped.filter((point, index) => !clipped.slice(0, index).some((prior) => {
    const dx = prior.x - point.x, dy = prior.y - point.y;
    return dx * dx + dy * dy <= 1e-14;
  }));
  clipped.sort((left, right) => left.x === right.x ? left.y - right.y : left.x - right.x);
  let entries = clipped.map((entry) => ({
    point: [u[0] * entry.x + v[0] * entry.y + normal[0] * plane,
      u[1] * entry.x + v[1] * entry.y + normal[1] * plane,
      u[2] * entry.x + v[2] * entry.y + normal[2] * plane] as Vec3,
    feature: `${faceA.feature}|${faceB.feature}|${entry.feature}`,
  }));
  if (entries.length > 4) {
    const selected = [entries[0]!];
    while (selected.length < 4) {
      let best = entries.find((entry) => !selected.includes(entry))!;
      let bestDistance = -Infinity;
      for (const entry of entries) {
        if (selected.includes(entry)) continue;
        let nearest = Infinity;
        for (const chosen of selected) {
          const delta = subtract3(entry.point, chosen.point);
          nearest = Math.min(nearest, dot3(delta, delta));
        }
        if (nearest > bestDistance) { best = entry; bestDistance = nearest; }
      }
      selected.push(best);
    }
    entries = selected;
  }
  return entries;
}

function supportEdge(
  box: ScenePhysicsBody, edgeAxis: number, direction: Vec3, maximum: boolean,
): { start: Vec3; end: Vec3; feature: string } {
  const axes = bodyAxes(box);
  const center = [...box.position] as Vec3;
  const signs: number[] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    if (axis === edgeAxis) continue;
    const projection = dot3(axes[axis]!, direction);
    const sign = (maximum ? projection >= 0 : projection < 0) ? 1 : -1;
    signs[axis] = sign;
    for (let k = 0; k < 3; k += 1) center[k] += axes[axis]![k]! * box.half[axis]! * sign;
  }
  const along = axes[edgeAxis]!, half = box.half[edgeAxis]!;
  return {
    start: [center[0] - along[0] * half, center[1] - along[1] * half, center[2] - along[2] * half],
    end: [center[0] + along[0] * half, center[1] + along[1] * half, center[2] + along[2] * half],
    feature: `e${edgeAxis}:${signs.map((sign, axis) => axis === edgeAxis ? "x" : sign > 0 ? "+" : "-").join("")}`,
  };
}

function closestSegmentPoints(a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3): [Vec3, Vec3] {
  const d1 = subtract3(a1, a0), d2 = subtract3(b1, b0), r = subtract3(a0, b0);
  const aa = dot3(d1, d1), ee = dot3(d2, d2), f = dot3(d2, r);
  let s = 0, t = 0;
  if (aa <= 1e-12 && ee <= 1e-12) return [a0, b0];
  if (aa <= 1e-12) t = Math.min(Math.max(f / ee, 0), 1);
  else {
    const c = dot3(d1, r);
    if (ee <= 1e-12) s = Math.min(Math.max(-c / aa, 0), 1);
    else {
      const b = dot3(d1, d2), denominator = aa * ee - b * b;
      if (Math.abs(denominator) > 1e-12) s = Math.min(Math.max((b * f - c * ee) / denominator, 0), 1);
      t = (b * s + f) / ee;
      if (t < 0) { t = 0; s = Math.min(Math.max(-c / aa, 0), 1); }
      else if (t > 1) { t = 1; s = Math.min(Math.max((b - c) / aa, 0), 1); }
    }
  }
  return [
    [a0[0] + d1[0] * s, a0[1] + d1[1] * s, a0[2] + d1[2] * s],
    [b0[0] + d2[0] * t, b0[1] + d2[1] * t, b0[2] + d2[2] * t],
  ];
}

type ScenePhysicsSatWinner =
  | { kind: "faceA" | "faceB"; axis: number }
  | { kind: "edge"; axisA: number; axisB: number };

function boxManifoldPoints(
  a: ScenePhysicsBody, b: ScenePhysicsBody, normal: Vec3, depth: number,
  winner: ScenePhysicsSatWinner,
): Array<{ point: Vec3; feature: string }> {
  if (winner.kind === "edge") {
    const edgeA = supportEdge(a, winner.axisA, normal, true);
    const edgeB = supportEdge(b, winner.axisB, normal, false);
    const [pointA, pointB] = closestSegmentPoints(edgeA.start, edgeA.end, edgeB.start, edgeB.end);
    return [{
      point: [(pointA[0] + pointB[0]) / 2, (pointA[1] + pointB[1]) / 2, (pointA[2] + pointB[2]) / 2],
      feature: `${edgeA.feature}|${edgeB.feature}`,
    }];
  }
  const verticesA = boxVertices(a), verticesB = boxVertices(b);
  let supportA = -Infinity, supportB = Infinity;
  for (const v of verticesA) supportA = Math.max(supportA, dot3(v, normal));
  for (const v of verticesB) supportB = Math.min(supportB, dot3(v, normal));
  const plane = (supportA + supportB) / 2;
  const clipped = clippedFaceManifold(a, b, normal, plane);
  if (clipped !== null) return clipped;
  const candidates: Array<{ point: Vec3; feature: string }> = [];
  verticesA.forEach((point, index) => {
    if (supportA - dot3(point, normal) <= depth + SCENE_PHYSICS_SLOP
        && pointInsideBox(point, b, depth + SCENE_PHYSICS_SLOP)) {
      candidates.push({ point, feature: `a${index}` });
    }
  });
  verticesB.forEach((point, index) => {
    if (dot3(point, normal) - supportB <= depth + SCENE_PHYSICS_SLOP
        && pointInsideBox(point, a, depth + SCENE_PHYSICS_SLOP)) {
      candidates.push({ point, feature: `b${index}` });
    }
  });
  const points: Array<{ point: Vec3; feature: string }> = [];
  for (const candidate of candidates) {
    const distance = dot3(candidate.point, normal) - plane;
    const point: Vec3 = [
      candidate.point[0] - normal[0] * distance,
      candidate.point[1] - normal[1] * distance,
      candidate.point[2] - normal[2] * distance,
    ];
    if (!points.some((p) => length3(subtract3(p.point, point)) <= 1e-7)) {
      points.push({ point, feature: candidate.feature });
    }
  }
  if (points.length > 4) {
    const selected = [points[0]!];
    while (selected.length < 4) {
      let best: { entry: { point: Vec3; feature: string }; distance: number } | null = null;
      for (const entry of points) {
        if (selected.includes(entry)) continue;
        let nearest = Infinity;
        for (const chosen of selected) {
          const delta = subtract3(entry.point, chosen.point);
          nearest = Math.min(nearest, dot3(delta, delta));
        }
        if (best === null || nearest > best.distance) best = { entry, distance: nearest };
      }
      selected.push(best!.entry);
    }
    return selected;
  }
  if (points.length > 0) return points;
  const onA = closestPointOnBox(b.position, a), onB = closestPointOnBox(a.position, b);
  return [{ point: [(onA[0] + onB[0]) / 2, (onA[1] + onB[1]) / 2, (onA[2] + onB[2]) / 2], feature: "fallback" }];
}

/** depth per the P5 collide corpus; normal points FROM a TOWARD b. Ties take the
 *  smallest axis index; axis sign is sign(centerB − centerA) with ties +1. */
export function scenePhysicsContact(
  a: ScenePhysicsBody, b: ScenePhysicsBody,
): ScenePhysicsContact | null {
  if (a.shape === "sphere" && b.shape === "sphere") {
    const d: Vec3 = [
      b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2],
    ];
    const dist = length3(d);
    const depth = a.radius + b.radius - dist;
    if (depth <= 0) return null;
    const normal: Vec3 = dist === 0 ? [0, 1, 0] : [d[0] / dist, d[1] / dist, d[2] / dist];
    const point: Vec3 = [
      (a.position[0] + normal[0] * a.radius + b.position[0] - normal[0] * b.radius) / 2,
      (a.position[1] + normal[1] * a.radius + b.position[1] - normal[1] * b.radius) / 2,
      (a.position[2] + normal[2] * a.radius + b.position[2] - normal[2] * b.radius) / 2,
    ];
    return { depth, normal, point, points: [point], features: ["sphere"] };
  }
  if (a.shape === "box" && b.shape === "box") {
    const axesA = bodyAxes(a);
    const axesB = bodyAxes(b);
    const delta = subtract3(b.position, a.position);
    let depth = Infinity;
    let normal: Vec3 = [0, 0, 0];
    const candidates: Array<{ axis: Vec3; winner: ScenePhysicsSatWinner }> = [
      ...axesA.map((axis, index) => ({ axis, winner: { kind: "faceA" as const, axis: index } })),
      ...axesB.map((axis, index) => ({ axis, winner: { kind: "faceB" as const, axis: index } })),
    ];
    for (let axisAIndex = 0; axisAIndex < axesA.length; axisAIndex += 1) {
      for (let axisBIndex = 0; axisBIndex < axesB.length; axisBIndex += 1) {
        const axisA = axesA[axisAIndex]!, axisB = axesB[axisBIndex]!;
        const axis = cross3(axisA, axisB);
        const length = length3(axis);
        if (length > 1e-9) candidates.push({
          axis: [axis[0] / length, axis[1] / length, axis[2] / length],
          winner: { kind: "edge", axisA: axisAIndex, axisB: axisBIndex },
        });
      }
    }
    let winner: ScenePhysicsSatWinner = { kind: "faceA", axis: 0 };
    for (const candidate of candidates) {
      const axis = candidate.axis;
      let radiusA = 0, radiusB = 0;
      for (let i = 0; i < 3; i += 1) {
        radiusA += a.half[i]! * Math.abs(dot3(axis, axesA[i]!));
        radiusB += b.half[i]! * Math.abs(dot3(axis, axesB[i]!));
      }
      const distance = dot3(delta, axis);
      const overlap = radiusA + radiusB - Math.abs(distance);
      if (overlap <= 0) return null;
      if (overlap < depth) {
        depth = overlap;
        normal = distance >= 0 ? [...axis] as Vec3 : [-axis[0], -axis[1], -axis[2]];
        winner = candidate.winner;
      }
    }
    const manifold = boxManifoldPoints(a, b, normal, depth, winner);
    const points = manifold.map((entry) => entry.point);
    return { depth, normal, point: points[0]!, points, features: manifold.map((entry) => entry.feature) };
  }
  const sphere = a.shape === "sphere" ? a : b;
  const box = a.shape === "box" ? a : b;
  const axes = bodyAxes(box);
  const local = subtract3(sphere.position, box.position);
  const qLocal: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    qLocal[i] = Math.min(Math.max(dot3(local, axes[i]!), -box.half[i]!), box.half[i]!);
  }
  let q: Vec3 = [...box.position] as Vec3;
  for (let i = 0; i < 3; i += 1) for (let k = 0; k < 3; k += 1) q[k] += axes[i]![k]! * qLocal[i]!;
  const d: Vec3 = [sphere.position[0] - q[0], sphere.position[1] - q[1], sphere.position[2] - q[2]];
  const dist = length3(d);
  let depth: number;
  let towardSphere: Vec3;
  if (dist > 0) {
    depth = sphere.radius - dist;
    if (depth <= 0) return null;
    towardSphere = [d[0] / dist, d[1] / dist, d[2] / dist];
  } else {
    let inside = Infinity;
    let axis = -1;
    for (let i = 0; i < 3; i += 1) {
      const toFace = box.half[i]! - Math.abs(dot3(local, axes[i]!));
      if (toFace < inside) { inside = toFace; axis = i; }
    }
    depth = sphere.radius + inside;
    const sign = dot3(local, axes[axis]!) >= 0 ? 1 : -1;
    towardSphere = [axes[axis]![0] * sign, axes[axis]![1] * sign, axes[axis]![2] * sign];
    qLocal[axis] = box.half[axis]! * sign;
    q = [...box.position] as Vec3;
    for (let i = 0; i < 3; i += 1) for (let k = 0; k < 3; k += 1) q[k] += axes[i]![k]! * qLocal[i]!;
  }
  return a.shape === "sphere"
    ? { depth, normal: [-towardSphere[0], -towardSphere[1], -towardSphere[2]], point: q, points: [q], features: ["sphere-box"] }
    : { depth, normal: towardSphere, point: q, points: [q], features: ["sphere-box"] };
}

function inverseInertiaWorld(body: ScenePhysicsBody, value: Vec3): Vec3 {
  if (body.mode2d) return [0, 0, value[2] * body.invInertia[2]];
  const matrix = bodyInertiaMatrices(body).inverse;
  return matrix.map((row) => dot3(row, value)) as Vec3;
}

function inertiaWorld(body: ScenePhysicsBody, value: Vec3): Vec3 {
  if (body.mode2d) {
    const inertia = body.invInertia[2] > 0 ? 1 / body.invInertia[2] : 0;
    return [0, 0, value[2] * inertia];
  }
  const matrix = bodyInertiaMatrices(body).tensor;
  return matrix.map((row) => dot3(row, value)) as Vec3;
}

function pointVelocity(body: ScenePhysicsBody, r: Vec3): Vec3 {
  const angular = cross3(body.angularVelocity, r);
  return [body.velocity[0] + angular[0], body.velocity[1] + angular[1], body.velocity[2] + angular[2]];
}

function impulseDenominator(
  body: ScenePhysicsBody, r: Vec3, direction: Vec3, effectiveInvMass = body.invMass,
): number {
  // Sleeping dynamics participate as immutable supports. Their stored mass and
  // inertia remain intact for the eventual wake, but neither contributes while
  // the constraint treats the body as solver-static.
  if (effectiveInvMass === 0) return 0;
  const rxn = cross3(r, direction);
  return effectiveInvMass + dot3(direction, cross3(inverseInertiaWorld(body, rxn), r));
}

function applyImpulse(
  body: ScenePhysicsBody, r: Vec3, impulse: Vec3, sign: number,
  effectiveInvMass = body.invMass,
): void {
  if (effectiveInvMass === 0) return;
  for (let i = 0; i < 3; i += 1) body.velocity[i] += impulse[i]! * effectiveInvMass * sign;
  const angular = inverseInertiaWorld(body, cross3(r, impulse));
  for (let i = 0; i < 3; i += 1) body.angularVelocity[i] += angular[i]! * sign;
}

// ── the step (THE STEP ORDER — pinned in the corpus _note, mirrored verbatim) ────────

function pairKey(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

export function stepScenePhysicsWorld(
  world: ScenePhysicsWorld, intents?: ScenePhysicsIntents,
): ScenePhysicsStepResult {
  const g = world.gravity;
  const dt = SCENE_PHYSICS_DT;
  // 1 ── kinematic drive: position from the authored/bound plane, velocity derived
  for (const b of world.bodies) {
    if (b.kind !== "kinematic") continue;
    b.previous = [...b.position] as Vec3;
    b.previousRotation = [...b.rotation] as Vec3;
    const p = intents?.[b.id]?.position;
    if (p !== undefined) {
      if (p[0] !== b.position[0] || p[1] !== b.position[1] || p[2] !== b.position[2]) {
        invalidateContactCache(world, b.id);
      }
      b.velocity = [
        (p[0] - b.position[0]) / dt, (p[1] - b.position[1]) / dt, (p[2] - b.position[2]) / dt,
      ];
      b.position = [...p] as Vec3;
    } else {
      b.velocity = [0, 0, 0];
    }
    const rotation = intents?.[b.id]?.rotation;
    if (rotation !== undefined) {
      if (rotation[0] !== b.rotation[0] || rotation[1] !== b.rotation[1] || rotation[2] !== b.rotation[2]) {
        invalidateContactCache(world, b.id);
      }
      const targetOrientation = quaternionFromEuler(rotation);
      b.angularVelocity = shortestArcAngularVelocity(b.orientation, targetOrientation, dt);
      b.rotation = [...rotation] as Vec3;
      b.orientation = targetOrientation;
    } else {
      b.angularVelocity = [0, 0, 0];
    }
  }
  if (world.mode2d) {
    for (const b of world.bodies) {
      b.angularVelocity[0] = 0;
      b.angularVelocity[1] = 0;
    }
  }
  // 2 ── character intent · 3 ── integrate (semi-implicit Euler: v += g·dt, x += v·dt)
  for (const b of world.bodies) {
    if (b.kind === "static" || b.kind === "kinematic" || b.sleeping) continue;
    if (b.kind === "character") {
      const move = intents?.[b.id]?.move;
      let mx = move === undefined ? 0 : move[0];
      let mz = move === undefined ? 0 : move[1];
      const ln = Math.sqrt(mx * mx + mz * mz);
      if (ln > 1) { mx /= ln; mz /= ln; }
      b.velocity[0] = mx * b.speed;
      b.velocity[2] = mz * b.speed;
    }
    b.previous = [...b.position] as Vec3;
    b.previousRotation = [...b.rotation] as Vec3;
    b.velocity[0] += g[0] * dt;
    b.velocity[1] += g[1] * dt;
    b.velocity[2] += g[2] * dt;
    b.position[0] += b.velocity[0] * dt;
    b.position[1] += b.velocity[1] * dt;
    b.position[2] += b.velocity[2] * dt;
    if (b.kind === "dynamic") {
      const drag = Math.max(0, 1 - b.angularDamping * dt);
      const angularMomentum = inertiaWorld(b, b.angularVelocity);
      for (let k = 0; k < 3; k += 1) {
        angularMomentum[k] = (angularMomentum[k]! + b.torque[k]! * dt) * drag;
      }
      b.angularVelocity = inverseInertiaWorld(b, angularMomentum);
      integrateOrientation(b, dt);
      // Torque-free anisotropic bodies keep WORLD angular momentum as their inertia
      // tensor rotates; recompute omega against the new orientation after the step.
      b.angularVelocity = inverseInertiaWorld(b, angularMomentum);
    }
  }
  // 4 ── solid pass: pairs in document order (i < j)
  const solidNow: Array<[string, string]> = [];
  const bodies = world.bodies;
  const solverContacts: Array<{
    a: ScenePhysicsBody; b: ScenePhysicsBody; depth: number; n: Vec3;
    invA: number; invB: number; invSum: number;
    constraints: Array<{
      rA: Vec3; rB: Vec3; cached: ScenePhysicsCachedImpulse; target: number;
      normalDenominator: number; tangentAxis: Vec3; tangentDenominator: number;
    }>;
  }> = [];
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const a = bodies[i]!, b = bodies[j]!;
      if (a.trigger || b.trigger) continue;
      const aStill = a.kind === "static" || a.kind === "kinematic";
      const bStill = b.kind === "static" || b.kind === "kinematic";
      if (aStill && bStill) continue;
      if (a.kind === "character" && b.kind === "character") continue; // named non-interaction
      if ((a.kind === "character" && bStill) || (b.kind === "character" && aStill)) continue; // pass 5
      if (!layersCollide(a, b)) continue;
      const c = scenePhysicsContact(a, b);
      if (c === null) continue;
      const { depth } = c;
      let n = [...c.normal] as Vec3;
      if (world.mode2d) {
        const planarLength = Math.sqrt(n[0] * n[0] + n[1] * n[1]);
        if (planarLength <= 1e-12) continue;
        n = [n[0] / planarLength, n[1] / planarLength, 0];
      }
      solidNow.push([a.id, b.id]);
      // the wake law
      for (const [s, o] of [[a, b], [b, a]] as Array<[ScenePhysicsBody, ScenePhysicsBody]>) {
        if (s.kind === "dynamic" && s.sleeping) {
          // energetic contact ONLY: a kinematic wakes a sleeper when it is MOVING
          // (its velocity derives from the resolved plane) — a stationary platform
          // must let the world sleep, or the frame loop never stops
          const surfaceVelocity = pointVelocity(o, subtract3(c.point, o.position));
          const surfaceSpeed = world.mode2d
            ? Math.sqrt(surfaceVelocity[0] * surfaceVelocity[0] + surfaceVelocity[1] * surfaceVelocity[1])
            : length3(surfaceVelocity);
          // An awake dynamic already accumulating quiet sleep ticks is a resting
          // neighbour, not an impactor. Its pre-solve velocity includes one gravity
          // step (~0.1635 m/s at 60 Hz), which must not make staggered stack sleepers
          // wake each other forever. Explicit writes/real impacts reset sleepCount to 0.
          const energeticDynamic = o.kind === "dynamic" && !o.sleeping && o.sleepCount === 0;
          if (o.kind === "character" ||
              ((o.kind === "kinematic" || energeticDynamic)
                && surfaceSpeed > SCENE_PHYSICS_SLEEP_SPEED)) {
            s.sleeping = false;
            s.sleepCount = 0;
          }
        }
      }
      // A sleeper remains a solid support with zero effective mass. Dropping the pair
      // entirely makes a body resting on a just-slept neighbour lose its floor for one
      // tick, repeatedly resetting staggered stack sleep. Energetic surface motion above
      // already wakes the sleeper before these masses are selected.
      const invA = a.kind === "character" || (a.kind === "dynamic" && a.sleeping) ? 0 : a.invMass;
      const invB = b.kind === "character" || (b.kind === "dynamic" && b.sleeping) ? 0 : b.invMass;
      const invSum = invA + invB;
      if (invSum === 0) continue;
      const cache = contactCache(world);
      const constraints = c.points.map((point, pointIndex) => {
        const key = `${pairKey(a.id, b.id)}\u0000${c.features[pointIndex]}`;
        const localAnchorA = localContactAnchor(point, a);
        const localAnchorB = localContactAnchor(point, b);
        let cached = cache.get(key);
        if (cached === undefined) {
          cached = { a: a.id, b: b.id, normal: 0, normalAxis: [...n] as Vec3,
            tangent: [0, 0, 0], localAnchorA, localAnchorB, lastTick: world.tick };
          cache.set(key, cached);
        } else if (dot3(cached.normalAxis, n) < 0.95
            || length3(subtract3(cached.localAnchorA, localAnchorA)) > 0.02
            || length3(subtract3(cached.localAnchorB, localAnchorB)) > 0.02) {
          cached.normal = 0;
          cached.tangent = [0, 0, 0];
        }
        cached.normalAxis = [...n] as Vec3;
        cached.localAnchorA = localAnchorA;
        cached.localAnchorB = localAnchorB;
        cached.lastTick = world.tick;
        const rA = subtract3(point, a.position), rB = subtract3(point, b.position);
        const approach = dot3(subtract3(pointVelocity(b, rB), pointVelocity(a, rA)), n);
        const restitution = -approach > SCENE_PHYSICS_RESTITUTION_MIN_SPEED
          ? Math.max(a.bounce, b.bounce) : 0;
        return { rA, rB, cached, target: approach < 0 ? -restitution * approach : 0,
          normalDenominator: impulseDenominator(a, rA, n, invA)
            + impulseDenominator(b, rB, n, invB),
          tangentAxis: [0, 0, 0] as Vec3, tangentDenominator: 0 };
      });
      solverContacts.push({ a, b, depth, n, invA, invB, invSum, constraints });
    }
  }
  // Warm start every contact before the GLOBAL fixed-iteration fold. Global ordering
  // is what lets a stack transmit support impulses through more than one body/tick.
  for (const solver of solverContacts) {
      const { a, b, n, invA, invB } = solver;
      for (const constraint of solver.constraints) {
        const tangentNormal = dot3(constraint.cached.tangent, n);
        constraint.cached.tangent = [
          constraint.cached.tangent[0] - n[0] * tangentNormal,
          constraint.cached.tangent[1] - n[1] * tangentNormal,
          constraint.cached.tangent[2] - n[2] * tangentNormal,
        ];
        const warm: Vec3 = [
          n[0] * constraint.cached.normal + constraint.cached.tangent[0],
          n[1] * constraint.cached.normal + constraint.cached.tangent[1],
          n[2] * constraint.cached.normal + constraint.cached.tangent[2],
        ];
        applyImpulse(a, constraint.rA, warm, -1, invA);
        applyImpulse(b, constraint.rB, warm, 1, invB);
      }
  }
  for (let manifoldIteration = 0; manifoldIteration < SCENE_PHYSICS_MANIFOLD_ITERATIONS; manifoldIteration += 1) {
    for (const solver of solverContacts) {
      const { a, b, n, invA, invB } = solver;
       for (const constraint of solver.constraints) {
          const { rA, rB, cached } = constraint;
          const rel = dot3(subtract3(pointVelocity(b, rB), pointVelocity(a, rA)), n);
          const normalDenominator = constraint.normalDenominator;
          const deltaNormal = normalDenominator > 0 ? (constraint.target - rel) / normalDenominator : 0;
          const previousNormal = cached.normal;
          cached.normal = Math.max(previousNormal + deltaNormal, 0);
          const appliedNormal = cached.normal - previousNormal;
          const normalImpulse: Vec3 = [n[0] * appliedNormal, n[1] * appliedNormal, n[2] * appliedNormal];
          applyImpulse(a, rA, normalImpulse, -1, invA);
          applyImpulse(b, rB, normalImpulse, 1, invB);
          const rv = subtract3(pointVelocity(b, rB), pointVelocity(a, rA));
          const rn = dot3(rv, n);
          const t: Vec3 = [
            rv[0] - n[0] * rn,
            rv[1] - n[1] * rn,
            world.mode2d ? 0 : rv[2] - n[2] * rn,
          ];
          const tl = length3(t);
          if (tl > 1e-9) {
            const tn: Vec3 = [t[0] / tl, t[1] / tl, t[2] / tl];
            if (dot3(constraint.tangentAxis, tn) < 0.999999) {
              constraint.tangentAxis = tn;
              constraint.tangentDenominator = impulseDenominator(a, rA, tn, invA)
                + impulseDenominator(b, rB, tn, invB);
            }
            const tangentDenominator = constraint.tangentDenominator;
            const deltaTangent = tangentDenominator > 0 ? -dot3(rv, tn) / tangentDenominator : 0;
            const previousTangent = [...cached.tangent] as Vec3;
            cached.tangent = [
              cached.tangent[0] + tn[0] * deltaTangent,
              cached.tangent[1] + tn[1] * deltaTangent,
              cached.tangent[2] + tn[2] * deltaTangent,
            ];
            const tangentProjection = dot3(cached.tangent, n);
            for (let k = 0; k < 3; k += 1) cached.tangent[k] -= n[k]! * tangentProjection;
            const mu = Math.sqrt(a.friction * b.friction);
            const cap = mu * cached.normal;
            const tangentLength = length3(cached.tangent);
            if (tangentLength > cap && tangentLength > 0) {
              const scale = cap / tangentLength;
              for (let k = 0; k < 3; k += 1) cached.tangent[k] *= scale;
            }
            const tangentImpulse: Vec3 = subtract3(cached.tangent, previousTangent);
            applyImpulse(a, rA, tangentImpulse, -1, invA);
            applyImpulse(b, rB, tangentImpulse, 1, invB);
          }
       }
    }
  }
  // Baumgarte positional correction, per contact, sequential after velocity solve.
  for (const solver of solverContacts) {
      const { a, b, depth, n, invA, invB, invSum } = solver;
      const corr = SCENE_PHYSICS_CORRECTION_PERCENT
        * Math.max(depth - SCENE_PHYSICS_SLOP, 0) / invSum;
      for (let k = 0; k < 3; k += 1) {
        a.position[k] -= n[k]! * (corr * invA);
        b.position[k] += n[k]! * (corr * invB);
      }
  }
  // 5 ── character move-and-slide vs static/kinematic (full depenetration, deepest first)
  for (const ch of bodies) {
    if (ch.kind !== "character") continue;
    ch.grounded = false;
    for (let iter = 0; iter < SCENE_PHYSICS_SLIDE_ITERATIONS; iter += 1) {
      let best: { c: ScenePhysicsContact; other: ScenePhysicsBody } | null = null;
      for (const other of bodies) {
        if ((other.kind !== "static" && other.kind !== "kinematic") || other.trigger) continue;
        if (!layersCollide(ch, other)) continue;
        const c = scenePhysicsContact(ch, other);
        if (c !== null && (best === null || c.depth > best.c.depth)) best = { c, other };
      }
      if (best === null) break;
      const { depth, normal: n } = best.c;
      solidNow.push(ch.index < best.other.index ? [ch.id, best.other.id] : [best.other.id, ch.id]);
      for (let k = 0; k < 3; k += 1) ch.position[k] -= n[k]! * depth;
      const vn = ch.velocity[0] * n[0] + ch.velocity[1] * n[1] + ch.velocity[2] * n[2];
      if (vn > 0) {
        for (let k = 0; k < 3; k += 1) ch.velocity[k] -= n[k]! * vn;
      }
      if (-n[1] > SCENE_PHYSICS_GROUND_NORMAL_Y) ch.grounded = true;
    }
  }
  // 6 ── trigger overlaps (exactly one trigger per pair; no forces)
  const triggerNow: Array<[string, string]> = [];
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const a = bodies[i]!, b = bodies[j]!;
      if (a.trigger === b.trigger) continue;
      if (!layersCollide(a, b)) continue;
      if (scenePhysicsContact(a, b) !== null) triggerNow.push([a.id, b.id]);
    }
  }
  // 7 ── events (enter-tracker semantics, both directions per pair)
  const collisions: ScenePhysicsPairEvent[] = [];
  const enters: ScenePhysicsPairEvent[] = [];
  const exits: ScenePhysicsPairEvent[] = [];
  const seenSolid = new Set<string>();
  for (const [pa, pb] of solidNow) {
    const key = pairKey(pa, pb);
    if (seenSolid.has(key)) continue;
    seenSolid.add(key);
    if (!world.solidOverlap.has(key)) {
      collisions.push({ id: pa, other: pb });
      collisions.push({ id: pb, other: pa });
    }
  }
  world.solidOverlap = seenSolid;
  const triggerSet = new Set(triggerNow.map(([pa, pb]) => pairKey(pa, pb)));
  for (const [pa, pb] of triggerNow) {
    if (!world.triggerOverlap.has(pairKey(pa, pb))) {
      enters.push({ id: pa, other: pb });
      enters.push({ id: pb, other: pa });
    }
  }
  for (const key of world.triggerOrder) {
    if (!triggerSet.has(key)) {
      const [pa, pb] = key.split("\u0000") as [string, string];
      exits.push({ id: pa, other: pb });
      exits.push({ id: pb, other: pa });
    }
  }
  world.triggerOrder = world.triggerOrder.filter((key) => triggerSet.has(key));
  for (const [pa, pb] of triggerNow) {
    const key = pairKey(pa, pb);
    if (!world.triggerOrder.includes(key)) world.triggerOrder.push(key);
  }
  world.triggerOverlap = triggerSet;
  // 8 ── sleep pass (dynamic only; characters and kinematics never sleep)
  for (const b of bodies) {
    if (b.kind !== "dynamic" || b.sleeping) continue;
    if (length3(b.velocity) < SCENE_PHYSICS_SLEEP_SPEED
        && length3(b.angularVelocity) < SCENE_PHYSICS_SLEEP_SPEED
        && length3(b.torque) === 0) {
      b.sleepCount += 1;
      if (b.sleepCount >= SCENE_PHYSICS_SLEEP_TICKS) {
        b.sleeping = true;
        b.velocity = [0, 0, 0];
        b.angularVelocity = [0, 0, 0];
      }
    } else {
      b.sleepCount = 0;
    }
  }
  // 8.5 ── G6 THE Z-LOCK PASS (mode="2d" only; the solve already masked angular
  // inertia to world Z and contact/friction impulses to planar XY):
  // the last act of every step re-pins each body's z position (and its interpolation
  // anchor) and z velocity to the recorded locks, so one solver serves both modes.
  if (world.mode2d) {
    for (const b of bodies) {
      b.position[2] = b.zLock;
      b.previous[2] = b.zLock;
      b.velocity[2] = b.vzLock;
      b.rotation[0] = b.rotation2dLock[0];
      b.rotation[1] = b.rotation2dLock[1];
      b.previousRotation[0] = b.rotation2dLock[0];
      b.previousRotation[1] = b.rotation2dLock[1];
      b.angularVelocity[0] = 0;
      b.angularVelocity[1] = 0;
      b.orientation = quaternionFromEuler(b.rotation);
    }
  }
  const cache = contactCache(world);
  for (const [key, value] of cache) if (value.lastTick !== world.tick) cache.delete(key);
  const tick = world.tick;
  world.tick += 1;
  return { tick, dt, collisions, enters, exits };
}

// ── the accumulator + interpolation (THE FIXED-TICK LAW's render half) ───────────────

export type ScenePhysicsAccumulator = {
  /** feed one rendered frame's dt (SECONDS); how many fixed steps to run now and the
   *  interpolation alpha after them */
  advance(frameSeconds: number): { steps: number; alpha: number };
};

export function createScenePhysicsAccumulator(): ScenePhysicsAccumulator {
  let acc = 0;
  return {
    advance(frameSeconds) {
      acc = Math.min(acc + frameSeconds, SCENE_PHYSICS_MAX_STEPS * SCENE_PHYSICS_DT);
      const steps = Math.floor(acc / SCENE_PHYSICS_DT);
      acc -= steps * SCENE_PHYSICS_DT;
      return { steps, alpha: acc / SCENE_PHYSICS_DT };
    },
  };
}

/** the pure fold the corpus pins: frame durations in MILLISECONDS → per-frame steps
 *  and alpha (the runner divides by 1000 exactly as the surface does) */
export function scenePhysicsSchedule(
  framesMs: readonly number[],
): Array<{ steps: number; alpha: number }> {
  const accumulator = createScenePhysicsAccumulator();
  return framesMs.map((ms) => accumulator.advance(ms / 1000));
}

/** THE INTERPOLATION LAW: rendered = prev + (curr − prev)·alpha, componentwise */
export function scenePhysicsInterpolate(prev: Vec3, curr: Vec3, alpha: number): Vec3 {
  return [
    prev[0] + (curr[0] - prev[0]) * alpha,
    prev[1] + (curr[1] - prev[1]) * alpha,
    prev[2] + (curr[2] - prev[2]) * alpha,
  ];
}

// ── extraction from the IR (the world law — corpus `world` cases) ────────────────────

export type ScenePhysicsExtractedBody = ScenePhysicsBodySpec & { node: SceneNode };

export type ScenePhysicsExtraction = {
  gravity: Vec3;
  bodies: ScenePhysicsExtractedBody[];
  /** G6: the scene's mode is "2d" — the world this extraction builds carries the z-lock */
  mode2d: boolean;
};

const PHYSICS_ELIGIBLE: ReadonlySet<string> = new Set(["box", "sphere", "plane", "model", "sprite"]);

function isIdentity(m: Mat4): boolean {
  const identity = mat4Identity();
  for (let i = 0; i < 16; i += 1) {
    if (Math.abs(m[i]! - identity[i]!) > 1e-9) return false;
  }
  return true;
}

function largestBasis(m: Mat4): number {
  return Math.max(
    Math.sqrt(m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!),
    Math.sqrt(m[4]! * m[4]! + m[5]! * m[5]! + m[6]! * m[6]!),
    Math.sqrt(m[8]! * m[8]! + m[9]! * m[9]! + m[10]! * m[10]!),
  );
}

function basisScales(m: Mat4): Vec3 {
  return [
    Math.sqrt(m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!),
    Math.sqrt(m[4]! * m[4]! + m[5]! * m[5]! + m[6]! * m[6]!),
    Math.sqrt(m[8]! * m[8]! + m[9]! * m[9]! + m[10]! * m[10]!),
  ];
}

/** Extract the root-frame Rz*Ry*Rx rotation from a TRS matrix. Transformed-parent
 * shear is already diagnosed; Gram-Schmidt gives that boundary a stable OBB. */
function rootRotation(m: Mat4, reference: Vec3): Vec3 {
  const scales = basisScales(m);
  let x: Vec3 = scales[0] > 0 ? [m[0]! / scales[0], m[1]! / scales[0], m[2]! / scales[0]] : [1, 0, 0];
  const rawY: Vec3 = scales[1] > 0 ? [m[4]! / scales[1], m[5]! / scales[1], m[6]! / scales[1]] : [0, 1, 0];
  const xy = dot3(rawY, x);
  let y: Vec3 = [rawY[0] - x[0] * xy, rawY[1] - x[1] * xy, rawY[2] - x[2] * xy];
  const yl = length3(y);
  y = yl > 1e-9 ? [y[0] / yl, y[1] / yl, y[2] / yl] : [0, 1, 0];
  let z = cross3(x, y);
  const rawZ: Vec3 = scales[2] > 0 ? [m[8]! / scales[2], m[9]! / scales[2], m[10]! / scales[2]] : [0, 0, 1];
  if (dot3(z, rawZ) < 0) z = [-z[0], -z[1], -z[2]];
  x = cross3(y, z);
  const ry = Math.asin(Math.max(-1, Math.min(1, -x[2])));
  const cy = Math.cos(ry);
  const rx = Math.abs(cy) > 1e-9 ? Math.atan2(y[2], z[2]) : Math.atan2(-z[1], y[1]);
  const rz = Math.abs(cy) > 1e-9 ? Math.atan2(x[1], x[0]) : 0;
  return [
    unwrapDegrees(rx * SCENE_PHYSICS_RADIANS_TO_DEGREES, reference[0]),
    unwrapDegrees(ry * SCENE_PHYSICS_RADIANS_TO_DEGREES, reference[1]),
    unwrapDegrees(rz * SCENE_PHYSICS_RADIANS_TO_DEGREES, reference[2]),
  ];
}

function orientedHalfFromWorld(m: Mat4, localHalf: Vec3, rotation: Vec3): Vec3 {
  const axes = quaternionAxes(quaternionFromEuler(rotation));
  const center: Vec3 = [m[12]!, m[13]!, m[14]!];
  const half: Vec3 = [0, 0, 0];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const corner = transformPoint(m, [localHalf[0] * sx, localHalf[1] * sy, localHalf[2] * sz]);
    const delta = subtract3(corner, center);
    for (let i = 0; i < 3; i += 1) half[i] = Math.max(half[i], Math.abs(dot3(delta, axes[i]!)));
  }
  return half;
}

/** THE GRAVITY LAW: `<scene gravity="x y z">`, default 0 −9.81 0, malformed → default
 *  with one diagnostic (Article 7) */
export function scenePhysicsGravity(ir: SceneIR, resolve: SceneResolve, diag?: SceneDiag): Vec3 {
  return readVec(null, "gravity", SCENE_PHYSICS_DEFAULT_GRAVITY, resolve, diag, ir.attrs) as Vec3;
}

/** extract every physics body from the scene tree. THE EXTRACTION LAWS:
 *  - a `physics` word outside static|dynamic|kinematic|character is NOT a body (one
 *    diagnostic); only box/sphere/plane/model nodes are eligible (one diagnostic);
 *  - colliders derive from the authored world transform: boxes retain local half
 *    extents times root-basis scale and a root-frame orientation (OBBs, not AABBs);
 *    explicit collider="sphere"|"box" follows the same scale laws;
 *    laws; another word → auto with one diagnostic;
 *  - bodies without an id get `#N` (1-based, extraction order);
 *  - a transformed ancestor draws ONE diagnostic and the body simulates in scene-root
 *    space (v1 — bodies are root-frame citizens);
 *  - `modelHalf` supplies a loaded model's local half extents (renderer-owned;
 *    [0.5, 0.5, 0.5] until known). */
export function extractScenePhysics(
  ir: SceneIR, resolve: SceneResolve, diag?: SceneDiag,
  modelHalf?: (node: SceneNode) => Vec3 | null,
): ScenePhysicsExtraction {
  const bodies: ScenePhysicsExtractedBody[] = [];
  let serial = 0;
  const walk = (nodes: readonly SceneNode[], parent: Mat4, parentTransformed: boolean): void => {
    for (const node of nodes) {
      if (node.kind === "animate") continue;
      const props = resolvedProps(node, resolve, diag);
      const world = mat4Multiply(parent, mat4Trs(props.position, props.rotation, props.scale));
      const physicsRaw = node.attrs["physics"] === undefined
        ? "" : readString(node, "physics", "", resolve, node.attrs);
      if (physicsRaw.length > 0) {
        const body = extractBody(node, props, world, physicsRaw, parentTransformed);
        if (body !== null) bodies.push(body);
      }
      walk(node.children, world, parentTransformed || !isIdentity(world));
    }
  };
  const extractBody = (
    node: SceneNode, props: ReturnType<typeof resolvedProps>, world: Mat4,
    physicsRaw: string, parentTransformed: boolean,
  ): ScenePhysicsExtractedBody | null => {
    if (!SCENE_PHYSICS_KINDS.has(physicsRaw)) {
      diag?.({ code: "unknown-physics", message: `physics="${physicsRaw}" is not static, dynamic, kinematic or character — not a body` });
      return null;
    }
    if (!PHYSICS_ELIGIBLE.has(node.kind)) {
      diag?.({ code: "unknown-physics", message: `<${node.kind}> cannot be a physics body — only box, sphere, plane and model` });
      return null;
    }
    const kind = physicsRaw as ScenePhysicsKind;
    if (parentTransformed) {
      diag?.({ code: "physics-nested", message: `a physics body under a transformed parent simulates in scene-root space (v1)` });
    }
    const colliderRaw = readString(node, "collider", "auto", resolve, node.attrs);
    let collider = colliderRaw;
    // G6: `circle` is the 2D spelling of `sphere` (the sprite word) — one shape set
    if (collider === "circle") collider = "sphere";
    if (collider !== "auto" && collider !== "sphere" && collider !== "box") {
      diag?.({ code: "unknown-collide", message: `collider="${colliderRaw}" is not auto, sphere, circle or box — using auto` });
      collider = "auto";
    }
    let shape: ScenePhysicsShape;
    let position: Vec3;
    if (node.kind === "sprite") {
      // G6 THE SPRITE COLLIDER LAW: the quad's own rectangle, centered on the QUAD
      // (the anchor offset applied), extruded SCENE_SPRITE_COLLIDER_HALF_Z in z so a
      // box↔box minimum-overlap axis always lands in the XY plane. `collider="circle"`
      // takes radius = half the SMALLER extent. The RESOLVED `size` is what colliders
      // read — the texture-aspect default is a render-time refinement (the honest v1).
      const [w, h] = spriteSizeOf(props);
      const quadWorld = mat4Multiply(
        world, mat4Trs(spriteAnchorOffset(props, w, h), [0, 0, 0], [1, 1, 1]));
      if (collider === "sphere") {
        shape = { kind: "sphere", radius: Math.min(w, h) / 2 * largestBasis(world) };
        position = [quadWorld[12]!, quadWorld[13]!, quadWorld[14]!];
      } else {
        const rotation = rootRotation(quadWorld, props.rotation);
        position = [quadWorld[12]!, quadWorld[13]!, quadWorld[14]!];
        shape = {
          kind: "box",
          half: orientedHalfFromWorld(
            quadWorld, [w / 2, h / 2, SCENE_SPRITE_COLLIDER_HALF_Z], rotation),
        };
      }
    } else if (collider === "sphere" || (collider === "auto" && node.kind === "sphere")) {
      const local = node.kind === "model"
        ? sphereRadiusOfHalf(modelHalf?.(node) ?? [0.5, 0.5, 0.5])
        : nodeBoundingRadius(node, props) ?? 0.5;
      shape = { kind: "sphere", radius: local * largestBasis(world) };
      position = [world[12]!, world[13]!, world[14]!];
    } else {
      const localHalf: Vec3 = node.kind === "box"
        ? [props.boxSize[0] / 2, props.boxSize[1] / 2, props.boxSize[2] / 2]
        : node.kind === "sphere" ? [props.radius, props.radius, props.radius]
        : node.kind === "plane" ? [props.planeSize[0] / 2, props.planeSize[1] / 2, 0]
        : modelHalf?.(node) ?? [0.5, 0.5, 0.5];
      const rotation = rootRotation(world, props.rotation);
      position = [world[12]!, world[13]!, world[14]!];
      shape = {
        kind: "box",
        half: orientedHalfFromWorld(world, localHalf, rotation),
      };
    }
    serial += 1;
    let mass = kind === "dynamic" ? readScalar(node, "mass", 1, resolve, diag, node.attrs) : 1;
    if (mass <= 0) {
      diag?.({ code: "malformed-number", message: `mass="${mass}" is not positive — using 1` });
      mass = 1;
    }
    const bounceRaw = readScalar(node, "bounce", 0, resolve, diag, node.attrs);
    const frictionRaw = readScalar(node, "friction", 0.5, resolve, diag, node.attrs);
    const collidesRaw = node.attrs["collides"] === undefined
      ? null : readString(node, "collides", "", resolve, node.attrs);
    return {
      id: node.id ?? `#${serial}`,
      node,
      kind,
      shape,
      position,
      velocity: readVec(node, "velocity", [0, 0, 0], resolve, diag, node.attrs) as Vec3,
      rotation: rootRotation(world, props.rotation),
      angularVelocity: readVec(node, "angular-velocity", [0, 0, 0], resolve, diag, node.attrs) as Vec3,
      torque: readVec(node, "torque", [0, 0, 0], resolve, diag, node.attrs) as Vec3,
      angularDamping: Math.max(readScalar(
        node, "angular-damping", SCENE_PHYSICS_DEFAULT_ANGULAR_DAMPING, resolve, diag, node.attrs,
      ), 0),
      mass,
      bounce: Math.min(Math.max(bounceRaw, 0), 1),
      friction: Math.max(frictionRaw, 0),
      trigger: readString(node, "trigger", "", resolve, node.attrs) === "true",
      layer: readString(node, "layer", "default", resolve, node.attrs),
      collides: collidesRaw === null
        ? null : collidesRaw.trim().split(/\s+/).filter((p) => p.length > 0),
      speed: kind === "character"
        ? readScalar(node, "speed", SCENE_PHYSICS_DEFAULT_SPEED, resolve, diag, node.attrs)
        : SCENE_PHYSICS_DEFAULT_SPEED,
      jump: kind === "character"
        ? readScalar(node, "jump", SCENE_PHYSICS_DEFAULT_JUMP, resolve, diag, node.attrs)
        : SCENE_PHYSICS_DEFAULT_JUMP,
    };
  };
  walk(ir.nodes, mat4Identity(), false);
  return { gravity: scenePhysicsGravity(ir, resolve, diag), bodies, mode2d: ir.mode === "2d" };
}

// ── the parent-frame law (G2 × G1) ───────────────────────────────────────────────────
//
// Bodies SIMULATE in scene-root space (the extraction freezes each body's WORLD
// position; a transformed parent is diagnosed, not obeyed). But a node's authored
// `position` is LOCAL to its parent, and the renderer composes parentWorld · local.
// So the solver's root-space result must be expressed in the parent's frame before it
// lands on the node, and an authored/bus position write must be lifted out of the
// parent's frame before it teleports the body. Without this pair, every body under a
// transformed parent — which a G1 prefab instance ALWAYS is, since the expansion root
// carries the instance transform — renders double-offset.
//
// Both are identities when the parent is the scene root (the fast path callers take).

/** root-space → the parent's local frame (what the node's `position` must hold) */
export function scenePhysicsToLocal(rootPosition: Vec3, parentWorld: Mat4 | null): Vec3 {
  if (parentWorld === null) return [...rootPosition] as Vec3;
  const inverse = mat4Invert(parentWorld);
  if (inverse === null) return [...rootPosition] as Vec3;   // degenerate parent: honest passthrough
  return transformPoint(inverse, rootPosition);
}

/** the parent's local frame → root space (what a position write means to the solver) */
export function scenePhysicsToRoot(localPosition: Vec3, parentWorld: Mat4 | null): Vec3 {
  if (parentWorld === null) return [...localPosition] as Vec3;
  return transformPoint(parentWorld, localPosition);
}

/** the node's local DSX Euler rotation -> the solver's scene-root orientation.
 *  This deliberately extracts the same orthonormal frame as body extraction, so a
 *  stationary kinematic nested below non-uniform scale does not manufacture an
 *  angular velocity on its first tick. */
export function scenePhysicsRotationToRoot(
  localRotation: Vec3, parentWorld: Mat4 | null, reference: Vec3 = localRotation,
): Vec3 {
  if (parentWorld === null) return [...localRotation] as Vec3;
  const local = mat4Trs([0, 0, 0], localRotation, [1, 1, 1]);
  return rootRotation(mat4Multiply(parentWorld, local), reference);
}

/** solver scene-root orientation -> the node's local DSX Euler rotation. The
 *  inverse-parent fold is followed by the same stable orthonormal extraction used
 *  for colliders; a singular parent is an honest passthrough. */
export function scenePhysicsRotationToLocal(
  root: Vec3, parentWorld: Mat4 | null, reference: Vec3 = root,
): Vec3 {
  if (parentWorld === null) return [...root] as Vec3;
  const inverse = mat4Invert(parentWorld);
  if (inverse === null) return [...root] as Vec3;
  const rootMatrix = mat4Trs([0, 0, 0], root, [1, 1, 1]);
  return rootRotation(mat4Multiply(inverse, rootMatrix), reference);
}

/** a model's auto SPHERE collider radius from its local half extents (the
 *  bounding-sphere convention: half-diagonal) */
function sphereRadiusOfHalf(half: Vec3): number {
  return Math.sqrt(half[0] * half[0] + half[1] * half[1] + half[2] * half[2]);
}
