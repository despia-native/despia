//
//  ScenePhysics.kt - the DSX Scene G2 physics kernel, Kotlin twin of
//  OpenSource/Web/packages/kernel/src/scene/physics.ts (dsx-game.md §2 G2), corpus
//  OpenSource/Conformance/scene/physics.json — every law spelled out in that file's
//  _note and the corpus README "The G2 laws" section. The shape:
//
//  - THE FIXED-TICK LAW: the simulation steps at EXACTLY 60 Hz (dt = 1/60 s), decoupled
//    from rendering. The renderer interpolates body positions between the last two
//    steps (alpha = accumulator/dt); the accumulator caps at 5 steps per frame and
//    DISCARDS the excess (the spiral-of-death guard — the sim slows, never spirals).
//    `on:tick` fires per fixed step with { dt: 1/60, tick: n }; on:frame stays
//    render-rate.
//  - THE DETERMINISM LAW: same initial state + same inputs → identical states to 6
//    decimals on every runner. All math in doubles, fixed document-order iteration,
//    only +,-,*,/ and sqrt (hypot is NOT used in the solver — sqrt of a sum of squares
//    is identically rounded on every IEEE runtime; hypot is not so pinned).
//  - BODIES: static · dynamic · kinematic (follows its authored/bound transform,
//    pushes with derived velocity) · character (move-and-slide; speed/jump attrs;
//    never sleeps; infinite mass against dynamics). Dynamic bodies integrate angular
//    velocity and world torque against shape-derived diagonal inertia, with linear
//    angular damping. Rotation is DSX degrees; angular velocity is radians/second.
//    Colliders still freeze at extraction: rotated manifolds and collision-driven
//    torque remain named follow-ups. Capsule colliders are a named absence too.
//  - THE SOLVER: semi-implicit Euler; sphere/box contacts with the P5 collide depth
//    laws + pinned normals; impulse resolution with restitution (max, with the 0.5
//    approach-speed micro-bounce guard) and Coulomb friction (sqrt mixing, clamped to
//    ±mu·j); Baumgarte positional correction (percent 0.8, slop 0.005); character
//    move-and-slide with full depenetration, velocity projection and ground detection
//    (surface normal up.y > 0.7); sleep at |v| < 0.05 for 60 ticks, wake on write or
//    energetic contact. Triggers overlap without forces (enter/exit tracker).
//
//  This file owns the NUMBERS plus [ScenePhysicsRuntime] — the render-riding fold BOTH
//  JVM `<scene>` elements share (the SceneRaster / SceneAnimator / SceneCollisionPass
//  stance: runtime halves live in :core, pure JVM, plain-JVM-tested); the elements
//  contribute only their loop tick and event dispatch.
//

package despia.engine.scene

import kotlin.math.floor
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import java.util.WeakHashMap

// ── the pinned constants (corpus `constants` — the runner asserts these) ─────────────

const val SCENE_PHYSICS_DT: Double = 1.0 / 60.0
const val SCENE_PHYSICS_MAX_STEPS: Int = 5
val SCENE_PHYSICS_DEFAULT_GRAVITY: Vec3 get() = doubleArrayOf(0.0, -9.81, 0.0)
const val SCENE_PHYSICS_CORRECTION_PERCENT: Double = 0.8
const val SCENE_PHYSICS_SLOP: Double = 0.005
const val SCENE_PHYSICS_RESTITUTION_MIN_SPEED: Double = 0.5
const val SCENE_PHYSICS_GROUND_NORMAL_Y: Double = 0.7
const val SCENE_PHYSICS_SLEEP_SPEED: Double = 0.05
const val SCENE_PHYSICS_SLEEP_TICKS: Int = 60
const val SCENE_PHYSICS_SLIDE_ITERATIONS: Int = 4
const val SCENE_PHYSICS_MANIFOLD_ITERATIONS: Int = 32
const val SCENE_PHYSICS_DEFAULT_SPEED: Double = 5.0
const val SCENE_PHYSICS_DEFAULT_JUMP: Double = 8.0
const val SCENE_PHYSICS_DEFAULT_ANGULAR_DAMPING: Double = 0.0
const val SCENE_PHYSICS_RADIANS_TO_DEGREES: Double = 57.29577951308232
const val SCENE_PHYSICS_DEGREES_TO_RADIANS: Double = 0.017453292519943295

/** G6 (sprite.json): the 2D extrusion of a `<sprite>` box collider — effectively
 *  infinite at scene scales, so the minimum-overlap axis of a box↔box contact is
 *  ALWAYS in the XY plane (the 2D semantics of an extruded rectangle) */
const val SCENE_SPRITE_COLLIDER_HALF_Z: Double = 1000.0

val SCENE_PHYSICS_KINDS: Set<String> = setOf("static", "dynamic", "kinematic", "character")

sealed class ScenePhysicsShape {
    class Sphere(val radius: Double) : ScenePhysicsShape()
    class Box(val half: Vec3) : ScenePhysicsShape()
}

class ScenePhysicsBodySpec(
    val id: String,
    val kind: String,
    val shape: ScenePhysicsShape,
    val position: Vec3 = doubleArrayOf(0.0, 0.0, 0.0),
    val velocity: Vec3 = doubleArrayOf(0.0, 0.0, 0.0),
    /** DSX Euler degrees, X then Y then Z */
    val rotation: Vec3 = doubleArrayOf(0.0, 0.0, 0.0),
    /** radians/second in scene axes */
    val angularVelocity: Vec3 = doubleArrayOf(0.0, 0.0, 0.0),
    /** persistent world torque applied each fixed step */
    val torque: Vec3 = doubleArrayOf(0.0, 0.0, 0.0),
    /** linear angular drag coefficient in 1/seconds */
    val angularDamping: Double = SCENE_PHYSICS_DEFAULT_ANGULAR_DAMPING,
    val mass: Double = 1.0,
    val bounce: Double = 0.0,
    val friction: Double = 0.5,
    val trigger: Boolean = false,
    val layer: String = "default",
    val collides: List<String>? = null,
    val speed: Double = SCENE_PHYSICS_DEFAULT_SPEED,
    val jump: Double = SCENE_PHYSICS_DEFAULT_JUMP,
    /** the extraction's way back to the markup node (renderer-owned; corpora omit it) */
    val node: SceneNode? = null,
)

class ScenePhysicsBody(
    val id: String,
    val kind: String,
    /** "sphere" | "box" */
    val shape: String,
    val radius: Double,
    val half: Vec3,
    /** solver-owned world position (the body CENTER) */
    var position: Vec3,
    /** the position at the START of the last step — the interpolation anchor */
    var previous: Vec3,
    var velocity: Vec3,
    /** solver-owned DSX Euler degrees */
    var rotation: Vec3,
    /** normalized [x,y,z,w] orientation used by contacts and stable integration */
    var orientation: DoubleArray,
    /** rotation at the START of the last step */
    var previousRotation: Vec3,
    /** radians/second in scene axes */
    var angularVelocity: Vec3,
    /** inverse diagonal inertia in frozen extraction axes */
    val invInertia: Vec3,
    /** persistent world torque applied each fixed step */
    var torque: Vec3,
    val angularDamping: Double,
    val invMass: Double,
    val bounce: Double,
    val friction: Double,
    val trigger: Boolean,
    val layer: String,
    val collides: List<String>?,
    val speed: Double,
    val jump: Double,
    var grounded: Boolean = false,
    var sleeping: Boolean = false,
    var sleepCount: Int = 0,
    /** G6 THE Z-LOCK LAW (mode="2d" worlds only): the z position every step re-pins to.
     *  Recorded at world creation; a TELEPORT re-anchors it. */
    var zLock: Double = 0.0,
    /** G6: the z velocity every step re-pins to — recorded at world creation and NEVER
     *  re-anchored (the named v1 shape) */
    val vzLock: Double = 0.0,
    /** mode="2d" preserves authored X/Y orientation; only Z may rotate */
    val rotation2dLock: Vec3,
    /** 2D bodies have only world-Z angular response */
    val mode2d: Boolean,
    /** document index — the deterministic pair order */
    val index: Int,
)

class ScenePhysicsWorld(
    val gravity: Vec3,
    val bodies: List<ScenePhysicsBody>,
    val byId: Map<String, ScenePhysicsBody>,
    /** G6: the world simulates inside `mode="2d"` — the z-lock pass runs each step */
    val mode2d: Boolean = false,
) {
    var tick: Int = 0
    var solidOverlap: MutableSet<String> = HashSet()
    var triggerOverlap: MutableSet<String> = HashSet()
    /** overlapping trigger pairs in insertion order — the pinned exit order */
    var triggerOrder: MutableList<String> = ArrayList()
}

class ScenePhysicsPairEvent(val id: String, val other: String)

class ScenePhysicsStepResult(
    /** the zero-based index of the step just completed (the on:tick payload's `tick`) */
    val tick: Int,
    /** always exactly SCENE_PHYSICS_DT (the on:tick payload's `dt`) */
    val dt: Double,
    val collisions: List<ScenePhysicsPairEvent>,
    val enters: List<ScenePhysicsPairEvent>,
    val exits: List<ScenePhysicsPairEvent>,
)

private class ScenePhysicsCachedImpulse(
    val a: String, val b: String, var normal: Double, var normalAxis: Vec3,
    var tangent: Vec3, var localAnchorA: Vec3, var localAnchorB: Vec3, var lastTick: Int,
)

private class ScenePhysicsPointConstraint(
    val rA: Vec3, val rB: Vec3, val cached: ScenePhysicsCachedImpulse, val target: Double,
    val normalDenominator: Double, var tangentAxis: Vec3, var tangentDenominator: Double,
)

private class ScenePhysicsSolverContact(
    val a: ScenePhysicsBody, val b: ScenePhysicsBody, val depth: Double, val n: Vec3,
    val invA: Double, val invB: Double, val invSum: Double,
    val constraints: List<ScenePhysicsPointConstraint>,
)

private val scenePhysicsContactCaches =
    WeakHashMap<ScenePhysicsWorld, LinkedHashMap<String, ScenePhysicsCachedImpulse>>()

private fun contactCache(world: ScenePhysicsWorld): LinkedHashMap<String, ScenePhysicsCachedImpulse> =
    scenePhysicsContactCaches.getOrPut(world) { LinkedHashMap() }

private fun invalidateContactCache(world: ScenePhysicsWorld, id: String) {
    val cache = scenePhysicsContactCaches[world] ?: return
    val iterator = cache.iterator()
    while (iterator.hasNext()) {
        val value = iterator.next().value
        if (value.a == id || value.b == id) iterator.remove()
    }
}

class ScenePhysicsIntent(
    /** character horizontal intent [x, z] (normalized only when |move| > 1, × speed) */
    val move: DoubleArray? = null,
    /** kinematic drive: the authored/bound position this step */
    val position: Vec3? = null,
    /** kinematic authored/bound DSX Euler rotation this step */
    val rotation: Vec3? = null,
)

// ── construction ─────────────────────────────────────────────────────────────────────

fun createScenePhysicsWorld(
    gravity: Vec3, specs: List<ScenePhysicsBodySpec>, mode2d: Boolean = false,
): ScenePhysicsWorld {
    val bodies = specs.mapIndexed { index, spec ->
        ScenePhysicsBody(
            id = spec.id,
            kind = spec.kind,
            shape = if (spec.shape is ScenePhysicsShape.Sphere) "sphere" else "box",
            radius = (spec.shape as? ScenePhysicsShape.Sphere)?.radius ?: 0.0,
            half = (spec.shape as? ScenePhysicsShape.Box)?.half?.copyOf() ?: doubleArrayOf(0.0, 0.0, 0.0),
            position = spec.position.copyOf(),
            previous = spec.position.copyOf(),
            velocity = spec.velocity.copyOf(),
            rotation = spec.rotation.copyOf(),
            orientation = quaternionFromEuler(spec.rotation),
            previousRotation = spec.rotation.copyOf(),
            angularVelocity = spec.angularVelocity.copyOf(),
            invInertia = scenePhysicsInverseInertia(spec.kind, spec.shape, spec.mass),
            torque = spec.torque.copyOf(),
            angularDamping = max(spec.angularDamping, 0.0),
            invMass = if (spec.kind == "dynamic" && spec.mass > 0.0) 1.0 / spec.mass else 0.0,
            bounce = spec.bounce,
            friction = spec.friction,
            trigger = spec.trigger,
            layer = spec.layer,
            collides = spec.collides,
            speed = spec.speed,
            jump = spec.jump,
            zLock = spec.position[2],
            vzLock = spec.velocity[2],
            rotation2dLock = spec.rotation.copyOf(),
            mode2d = mode2d,
            index = index,
        )
    }
    val world = ScenePhysicsWorld(gravity.copyOf(), bodies, bodies.associateBy { it.id }, mode2d)
    scenePhysicsContactCaches[world] = LinkedHashMap()
    return world
}

/** Solid-sphere and axis-aligned solid-box diagonal inertia over frozen extents. */
fun scenePhysicsInverseInertia(kind: String, shape: ScenePhysicsShape, mass: Double): Vec3 {
    if (kind != "dynamic" || mass <= 0.0) return doubleArrayOf(0.0, 0.0, 0.0)
    if (shape is ScenePhysicsShape.Sphere) {
        val inertia = 0.4 * mass * shape.radius * shape.radius
        val inv = if (inertia > 0.0) 1.0 / inertia else 0.0
        return doubleArrayOf(inv, inv, inv)
    }
    val half = (shape as ScenePhysicsShape.Box).half
    val ix = mass * (half[1] * half[1] + half[2] * half[2]) / 3.0
    val iy = mass * (half[0] * half[0] + half[2] * half[2]) / 3.0
    val iz = mass * (half[0] * half[0] + half[1] * half[1]) / 3.0
    return doubleArrayOf(
        if (ix > 0.0) 1.0 / ix else 0.0,
        if (iy > 0.0) 1.0 / iy else 0.0,
        if (iz > 0.0) 1.0 / iz else 0.0,
    )
}

/** THE VELOCITY-WRITE LAW: sets the velocity verbatim and wakes the body */
fun scenePhysicsWriteVelocity(world: ScenePhysicsWorld, id: String, v: Vec3): Boolean {
    val body = world.byId[id] ?: return false
    body.velocity = v.copyOf()
    invalidateContactCache(world, id)
    body.sleeping = false
    body.sleepCount = 0
    return true
}

fun scenePhysicsWriteAngularVelocity(world: ScenePhysicsWorld, id: String, v: Vec3): Boolean {
    val body = world.byId[id] ?: return false
    body.angularVelocity = v.copyOf()
    invalidateContactCache(world, id)
    body.sleeping = false
    body.sleepCount = 0
    return true
}

fun scenePhysicsWriteTorque(world: ScenePhysicsWorld, id: String, torque: Vec3): Boolean {
    val body = world.byId[id] ?: return false
    body.torque = torque.copyOf()
    invalidateContactCache(world, id)
    body.sleeping = false
    body.sleepCount = 0
    return true
}

fun scenePhysicsTeleportRotation(world: ScenePhysicsWorld, id: String, rotation: Vec3): Boolean {
    val body = world.byId[id] ?: return false
    body.rotation = rotation.copyOf()
    body.orientation = quaternionFromEuler(rotation)
    body.previousRotation = rotation.copyOf()
    body.angularVelocity = doubleArrayOf(0.0, 0.0, 0.0)
    invalidateContactCache(world, id)
    body.sleeping = false
    body.sleepCount = 0
    return true
}

/** THE TELEPORT LAW: an authored/bound/bus position write moves the body, RESETS its
 *  velocity to zero, resets the interpolation anchor (no glide across a teleport),
 *  and wakes it */
fun scenePhysicsTeleport(world: ScenePhysicsWorld, id: String, p: Vec3): Boolean {
    val body = world.byId[id] ?: return false
    body.position = p.copyOf()
    body.previous = p.copyOf()
    body.velocity = doubleArrayOf(0.0, 0.0, 0.0)
    invalidateContactCache(world, id)
    body.zLock = p[2]   // G6: a teleport RE-ANCHORS the 2D z-lock (vzLock never moves)
    body.sleeping = false
    body.sleepCount = 0
    return true
}

/** the v1 kinematic-write wake law: no island graph (named absence) — a kinematic
 *  position write wakes every sleeping body */
fun scenePhysicsWakeAll(world: ScenePhysicsWorld) {
    for (body in world.bodies) {
        if (body.sleeping) {
            body.sleeping = false
            body.sleepCount = 0
        }
    }
}

// ── the contact laws ─────────────────────────────────────────────────────────────────

/** deterministic length — sqrt is correctly rounded on every IEEE runtime */
private fun length3(v: Vec3): Double = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])

private fun dot3(a: Vec3, b: Vec3): Double = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

private fun cross3(a: Vec3, b: Vec3): Vec3 = doubleArrayOf(
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
)

private fun subtract3(a: Vec3, b: Vec3): Vec3 =
    doubleArrayOf(a[0] - b[0], a[1] - b[1], a[2] - b[2])

private fun quaternionMultiply(a: DoubleArray, b: DoubleArray): DoubleArray = doubleArrayOf(
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
)

private fun normalizeQuaternion(q: DoubleArray): DoubleArray {
    val length = sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
    if (length == 0.0) return doubleArrayOf(0.0, 0.0, 0.0, 1.0)
    return DoubleArray(4) { q[it] / length }
}

/** DSX Euler law is Rz*Ry*Rx: X acts on the object first, then Y, then Z. */
private fun quaternionFromEuler(rotation: Vec3): DoubleArray {
    val hx = rotation[0] * SCENE_PHYSICS_DEGREES_TO_RADIANS / 2.0
    val hy = rotation[1] * SCENE_PHYSICS_DEGREES_TO_RADIANS / 2.0
    val hz = rotation[2] * SCENE_PHYSICS_DEGREES_TO_RADIANS / 2.0
    val qx = doubleArrayOf(sin(hx), 0.0, 0.0, cos(hx))
    val qy = doubleArrayOf(0.0, sin(hy), 0.0, cos(hy))
    val qz = doubleArrayOf(0.0, 0.0, sin(hz), cos(hz))
    return normalizeQuaternion(quaternionMultiply(quaternionMultiply(qz, qy), qx))
}

private fun quaternionAxes(q: DoubleArray): Array<Vec3> {
    val x = q[0]; val y = q[1]; val z = q[2]; val w = q[3]
    return arrayOf(
        doubleArrayOf(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
        doubleArrayOf(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
        doubleArrayOf(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)),
    )
}

private class ScenePhysicsAxesEntry(val orientation: DoubleArray, val axes: Array<Vec3>)
private class ScenePhysicsInertiaEntry(
    val orientation: DoubleArray, val inverse: Array<Vec3>, val tensor: Array<Vec3>,
)
private val scenePhysicsAxesCache = WeakHashMap<ScenePhysicsBody, ScenePhysicsAxesEntry>()
private val scenePhysicsInertiaCache = WeakHashMap<ScenePhysicsBody, ScenePhysicsInertiaEntry>()

private fun bodyAxes(body: ScenePhysicsBody): Array<Vec3> {
    val q = body.orientation
    val cached = scenePhysicsAxesCache[body]
    if (cached != null && cached.orientation[0] == q[0] && cached.orientation[1] == q[1] &&
        cached.orientation[2] == q[2] && cached.orientation[3] == q[3]
    ) return cached.axes
    val axes = quaternionAxes(q)
    scenePhysicsAxesCache[body] = ScenePhysicsAxesEntry(q.copyOf(), axes)
    return axes
}

private fun bodyInertiaMatrices(body: ScenePhysicsBody): ScenePhysicsInertiaEntry {
    val q = body.orientation
    val cached = scenePhysicsInertiaCache[body]
    if (cached != null && cached.orientation[0] == q[0] && cached.orientation[1] == q[1] &&
        cached.orientation[2] == q[2] && cached.orientation[3] == q[3]
    ) return cached
    val axes = bodyAxes(body)
    val inverse = Array(3) { doubleArrayOf(0.0, 0.0, 0.0) }
    val tensor = Array(3) { doubleArrayOf(0.0, 0.0, 0.0) }
    for (axis in 0 until 3) {
        val inv = body.invInertia[axis]
        val inertia = if (inv > 0.0) 1.0 / inv else 0.0
        for (row in 0 until 3) for (column in 0 until 3) {
            val projection = axes[axis][row] * axes[axis][column]
            inverse[row][column] += projection * inv
            tensor[row][column] += projection * inertia
        }
    }
    val entry = ScenePhysicsInertiaEntry(q.copyOf(), inverse, tensor)
    scenePhysicsInertiaCache[body] = entry
    return entry
}

private fun unwrapDegrees(value: Double, reference: Double): Double {
    var result = value
    while (result - reference > 180.0) result -= 360.0
    while (result - reference < -180.0) result += 360.0
    return result
}

private fun eulerFromQuaternion(q: DoubleArray, previous: Vec3): Vec3 {
    val axes = quaternionAxes(q)
    val m00 = axes[0][0]; val m10 = axes[0][1]; val m20 = axes[0][2]
    val m11 = axes[1][1]; val m12 = axes[2][1]; val m21 = axes[1][2]; val m22 = axes[2][2]
    val ry = asin(max(-1.0, min(1.0, -m20)))
    val cy = cos(ry)
    val rx = if (abs(cy) > 1e-9) atan2(m21, m22) else atan2(-m12, m11)
    val rz = if (abs(cy) > 1e-9) atan2(m10, m00) else 0.0
    val principal = doubleArrayOf(
        unwrapDegrees(rx * SCENE_PHYSICS_RADIANS_TO_DEGREES, previous[0]),
        unwrapDegrees(ry * SCENE_PHYSICS_RADIANS_TO_DEGREES, previous[1]),
        unwrapDegrees(rz * SCENE_PHYSICS_RADIANS_TO_DEGREES, previous[2]),
    )
    val alternateY = if (ry >= 0.0) Math.PI - ry else -Math.PI - ry
    val alternate = doubleArrayOf(
        unwrapDegrees((rx + Math.PI) * SCENE_PHYSICS_RADIANS_TO_DEGREES, previous[0]),
        unwrapDegrees(alternateY * SCENE_PHYSICS_RADIANS_TO_DEGREES, previous[1]),
        unwrapDegrees((rz + Math.PI) * SCENE_PHYSICS_RADIANS_TO_DEGREES, previous[2]),
    )
    val principalDistance = (principal[0] - previous[0]) * (principal[0] - previous[0]) +
        (principal[1] - previous[1]) * (principal[1] - previous[1]) +
        (principal[2] - previous[2]) * (principal[2] - previous[2])
    val alternateDistance = (alternate[0] - previous[0]) * (alternate[0] - previous[0]) +
        (alternate[1] - previous[1]) * (alternate[1] - previous[1]) +
        (alternate[2] - previous[2]) * (alternate[2] - previous[2])
    return if (alternateDistance < principalDistance) alternate else principal
}

private fun shortestArcAngularVelocity(from: DoubleArray, to: DoubleArray, dt: Double): Vec3 {
    val conjugate = doubleArrayOf(-from[0], -from[1], -from[2], from[3])
    var delta = normalizeQuaternion(quaternionMultiply(to, conjugate))
    if (delta[3] < 0.0) delta = doubleArrayOf(-delta[0], -delta[1], -delta[2], -delta[3])
    val vectorLength = sqrt(delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2])
    if (vectorLength < 1e-12) return doubleArrayOf(0.0, 0.0, 0.0)
    val angle = 2.0 * atan2(vectorLength, max(delta[3], 0.0))
    val scale = angle / (vectorLength * dt)
    return doubleArrayOf(delta[0] * scale, delta[1] * scale, delta[2] * scale)
}

private fun integrateOrientation(body: ScenePhysicsBody, dt: Double) {
    val speed = length3(body.angularVelocity)
    if (speed == 0.0) return
    val halfAngle = speed * dt / 2.0
    val scale = sin(halfAngle) / speed
    val delta = doubleArrayOf(
        body.angularVelocity[0] * scale, body.angularVelocity[1] * scale,
        body.angularVelocity[2] * scale, cos(halfAngle),
    )
    body.orientation = normalizeQuaternion(quaternionMultiply(delta, body.orientation))
    body.rotation = eulerFromQuaternion(body.orientation, body.rotation)
}

private fun closestPointOnBox(point: Vec3, box: ScenePhysicsBody): Vec3 {
    val axes = bodyAxes(box)
    val d = subtract3(point, box.position)
    val out = box.position.copyOf()
    for (i in 0 until 3) {
        val amount = min(max(dot3(d, axes[i]), -box.half[i]), box.half[i])
        for (k in 0 until 3) out[k] += axes[i][k] * amount
    }
    return out
}

private fun localContactAnchor(point: Vec3, body: ScenePhysicsBody): Vec3 {
    val axes = bodyAxes(body)
    val d = subtract3(point, body.position)
    return doubleArrayOf(dot3(d, axes[0]), dot3(d, axes[1]), dot3(d, axes[2]))
}

private fun layersCollide(a: ScenePhysicsBody, b: ScenePhysicsBody): Boolean {
    if (a.collides != null && b.layer !in a.collides) return false
    if (b.collides != null && a.layer !in b.collides) return false
    return true
}

class ScenePhysicsContact(
    val depth: Double, val normal: Vec3, val point: Vec3,
    val points: List<Vec3>, val features: List<String>,
)

private class ScenePhysicsManifoldPoint(val point: Vec3, val feature: String)
private class ScenePhysicsPoint2(val x: Double, val y: Double, val feature: String)
private class ScenePhysicsFace(val points: List<ScenePhysicsManifoldPoint>, val feature: String)
private class ScenePhysicsEdge(val start: Vec3, val end: Vec3, val feature: String)
private sealed class ScenePhysicsSatWinner {
    class FaceA(val axis: Int) : ScenePhysicsSatWinner()
    class FaceB(val axis: Int) : ScenePhysicsSatWinner()
    class Edge(val axisA: Int, val axisB: Int) : ScenePhysicsSatWinner()
}
private class ScenePhysicsSatCandidate(val axis: Vec3, val winner: ScenePhysicsSatWinner)

private fun boxVertices(box: ScenePhysicsBody): List<Vec3> {
    val axes = bodyAxes(box)
    val vertices = ArrayList<Vec3>()
    for (sx in intArrayOf(-1, 1)) for (sy in intArrayOf(-1, 1)) for (sz in intArrayOf(-1, 1)) {
        val vertex = box.position.copyOf()
        val signs = intArrayOf(sx, sy, sz)
        for (i in 0 until 3) for (k in 0 until 3) vertex[k] += axes[i][k] * box.half[i] * signs[i]
        vertices.add(vertex)
    }
    return vertices
}

private fun pointInsideBox(point: Vec3, box: ScenePhysicsBody, margin: Double = 1e-8): Boolean {
    val axes = bodyAxes(box)
    val d = subtract3(point, box.position)
    for (i in 0 until 3) if (abs(dot3(d, axes[i])) > box.half[i] + margin) return false
    return true
}

private fun supportFace(box: ScenePhysicsBody, direction: Vec3): ScenePhysicsFace {
    val axes = bodyAxes(box)
    var faceAxis = 0
    var alignment = abs(dot3(axes[0], direction))
    for (i in 1 until 3) {
        val next = abs(dot3(axes[i], direction))
        if (next > alignment) { faceAxis = i; alignment = next }
    }
    val sign = if (dot3(axes[faceAxis], direction) >= 0.0) 1 else -1
    val center = doubleArrayOf(
        box.position[0] + axes[faceAxis][0] * box.half[faceAxis] * sign,
        box.position[1] + axes[faceAxis][1] * box.half[faceAxis] * sign,
        box.position[2] + axes[faceAxis][2] * box.half[faceAxis] * sign,
    )
    val sideAxes = (0 until 3).filter { it != faceAxis }
    val corners = arrayOf(-1 to -1, 1 to -1, 1 to 1, -1 to 1)
    val faceFeature = "f$faceAxis${if (sign > 0) "+" else "-"}"
    return ScenePhysicsFace(corners.map { (su, sv) ->
        val point = center.copyOf()
        for (k in 0 until 3) {
            point[k] += axes[sideAxes[0]][k] * box.half[sideAxes[0]] * su +
                axes[sideAxes[1]][k] * box.half[sideAxes[1]] * sv
        }
        ScenePhysicsManifoldPoint(point, "$faceFeature:v${if (su > 0) 1 else 0}${if (sv > 0) 1 else 0}")
    }, faceFeature)
}

private fun cross2(a: ScenePhysicsPoint2, b: ScenePhysicsPoint2, c: ScenePhysicsPoint2): Double =
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

private fun polygonArea2(points: List<ScenePhysicsPoint2>): Double {
    var area = 0.0
    for (i in points.indices) {
        val a = points[i]
        val b = points[(i + 1) % points.size]
        area += a.x * b.y - a.y * b.x
    }
    return area
}

private fun clipPolygon(
    subject: List<ScenePhysicsPoint2>, clip: List<ScenePhysicsPoint2>, clipFeature: String,
): List<ScenePhysicsPoint2> {
    var output = subject
    for (edgeIndex in clip.indices) {
        val edgeA = clip[edgeIndex]
        val edgeB = clip[(edgeIndex + 1) % clip.size]
        val input = output
        output = emptyList()
        if (input.isEmpty()) break
        val nextOutput = ArrayList<ScenePhysicsPoint2>()
        var start = input[input.size - 1]
        var startDistance = cross2(edgeA, edgeB, start)
        for (end in input) {
            val endDistance = cross2(edgeA, edgeB, end)
            val startInside = startDistance >= -1e-9
            val endInside = endDistance >= -1e-9
            if (endInside != startInside) {
                val denominator = startDistance - endDistance
                val t = if (denominator == 0.0) 0.0 else startDistance / denominator
                val edge = listOf(start.feature, end.feature).sorted().joinToString("|")
                nextOutput.add(ScenePhysicsPoint2(
                    start.x + (end.x - start.x) * t,
                    start.y + (end.y - start.y) * t,
                    "i($edge;$clipFeature:e$edgeIndex)",
                ))
            }
            if (endInside) nextOutput.add(end)
            start = end
            startDistance = endDistance
        }
        output = nextOutput
    }
    return output
}

private fun clippedFaceManifold(
    a: ScenePhysicsBody, b: ScenePhysicsBody, normal: Vec3, plane: Double,
): List<ScenePhysicsManifoldPoint>? {
    val absNormal = doubleArrayOf(abs(normal[0]), abs(normal[1]), abs(normal[2]))
    val seed = if (absNormal[0] <= absNormal[1] && absNormal[0] <= absNormal[2]) {
        doubleArrayOf(1.0, 0.0, 0.0)
    } else if (absNormal[1] <= absNormal[2]) {
        doubleArrayOf(0.0, 1.0, 0.0)
    } else {
        doubleArrayOf(0.0, 0.0, 1.0)
    }
    val rawU = cross3(seed, normal)
    val ul = length3(rawU)
    val u = doubleArrayOf(rawU[0] / ul, rawU[1] / ul, rawU[2] / ul)
    val v = cross3(normal, u)
    val faceA = supportFace(a, normal)
    val faceB = supportFace(b, doubleArrayOf(-normal[0], -normal[1], -normal[2]))
    fun project(entry: ScenePhysicsManifoldPoint): ScenePhysicsPoint2 =
        ScenePhysicsPoint2(dot3(entry.point, u), dot3(entry.point, v), entry.feature)
    var polygonA = faceA.points.map(::project)
    var polygonB = faceB.points.map(::project)
    if (polygonArea2(polygonA) < 0.0) polygonA = polygonA.reversed()
    if (polygonArea2(polygonB) < 0.0) polygonB = polygonB.reversed()
    var clipped = clipPolygon(polygonA, polygonB, faceB.feature)
    if (clipped.isEmpty()) return null
    val unique = ArrayList<ScenePhysicsPoint2>()
    for (point in clipped) {
        if (unique.none { prior ->
            val dx = prior.x - point.x
            val dy = prior.y - point.y
            dx * dx + dy * dy <= 1e-14
        }) unique.add(point)
    }
    clipped = unique.sortedWith(compareBy<ScenePhysicsPoint2> { it.x }.thenBy { it.y })
    var entries = clipped.map { entry ->
        ScenePhysicsManifoldPoint(
            doubleArrayOf(
                u[0] * entry.x + v[0] * entry.y + normal[0] * plane,
                u[1] * entry.x + v[1] * entry.y + normal[1] * plane,
                u[2] * entry.x + v[2] * entry.y + normal[2] * plane,
            ),
            "${faceA.feature}|${faceB.feature}|${entry.feature}",
        )
    }
    if (entries.size > 4) {
        val selected = ArrayList<ScenePhysicsManifoldPoint>()
        selected.add(entries[0])
        while (selected.size < 4) {
            var best = entries.first { it !in selected }
            var bestDistance = Double.NEGATIVE_INFINITY
            for (entry in entries) {
                if (entry in selected) continue
                var nearest = Double.POSITIVE_INFINITY
                for (chosen in selected) {
                    val delta = subtract3(entry.point, chosen.point)
                    nearest = min(nearest, dot3(delta, delta))
                }
                if (nearest > bestDistance) { best = entry; bestDistance = nearest }
            }
            selected.add(best)
        }
        entries = selected
    }
    return entries
}

private fun supportEdge(
    box: ScenePhysicsBody, edgeAxis: Int, direction: Vec3, maximum: Boolean,
): ScenePhysicsEdge {
    val axes = bodyAxes(box)
    val center = box.position.copyOf()
    val signs = IntArray(3)
    for (axis in 0 until 3) {
        if (axis == edgeAxis) continue
        val projection = dot3(axes[axis], direction)
        val sign = if (if (maximum) projection >= 0.0 else projection < 0.0) 1 else -1
        signs[axis] = sign
        for (k in 0 until 3) center[k] += axes[axis][k] * box.half[axis] * sign
    }
    val along = axes[edgeAxis]
    val half = box.half[edgeAxis]
    val featureSigns = (0 until 3).joinToString("") { axis ->
        if (axis == edgeAxis) "x" else if (signs[axis] > 0) "+" else "-"
    }
    return ScenePhysicsEdge(
        doubleArrayOf(center[0] - along[0] * half, center[1] - along[1] * half, center[2] - along[2] * half),
        doubleArrayOf(center[0] + along[0] * half, center[1] + along[1] * half, center[2] + along[2] * half),
        "e$edgeAxis:$featureSigns",
    )
}

private fun closestSegmentPoints(a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3): Pair<Vec3, Vec3> {
    val d1 = subtract3(a1, a0)
    val d2 = subtract3(b1, b0)
    val r = subtract3(a0, b0)
    val aa = dot3(d1, d1)
    val ee = dot3(d2, d2)
    val f = dot3(d2, r)
    var s = 0.0
    var t = 0.0
    if (aa <= 1e-12 && ee <= 1e-12) return a0 to b0
    if (aa <= 1e-12) {
        t = min(max(f / ee, 0.0), 1.0)
    } else {
        val c = dot3(d1, r)
        if (ee <= 1e-12) {
            s = min(max(-c / aa, 0.0), 1.0)
        } else {
            val b = dot3(d1, d2)
            val denominator = aa * ee - b * b
            if (abs(denominator) > 1e-12) s = min(max((b * f - c * ee) / denominator, 0.0), 1.0)
            t = (b * s + f) / ee
            if (t < 0.0) {
                t = 0.0
                s = min(max(-c / aa, 0.0), 1.0)
            } else if (t > 1.0) {
                t = 1.0
                s = min(max((b - c) / aa, 0.0), 1.0)
            }
        }
    }
    return doubleArrayOf(a0[0] + d1[0] * s, a0[1] + d1[1] * s, a0[2] + d1[2] * s) to
        doubleArrayOf(b0[0] + d2[0] * t, b0[1] + d2[1] * t, b0[2] + d2[2] * t)
}

private fun boxManifoldPoints(
    a: ScenePhysicsBody, b: ScenePhysicsBody, normal: Vec3, depth: Double,
    winner: ScenePhysicsSatWinner,
): List<ScenePhysicsManifoldPoint> {
    if (winner is ScenePhysicsSatWinner.Edge) {
        val edgeA = supportEdge(a, winner.axisA, normal, true)
        val edgeB = supportEdge(b, winner.axisB, normal, false)
        val (pointA, pointB) = closestSegmentPoints(edgeA.start, edgeA.end, edgeB.start, edgeB.end)
        return listOf(ScenePhysicsManifoldPoint(
            doubleArrayOf((pointA[0] + pointB[0]) / 2.0, (pointA[1] + pointB[1]) / 2.0,
                (pointA[2] + pointB[2]) / 2.0),
            "${edgeA.feature}|${edgeB.feature}",
        ))
    }
    val verticesA = boxVertices(a); val verticesB = boxVertices(b)
    var supportA = Double.NEGATIVE_INFINITY; var supportB = Double.POSITIVE_INFINITY
    for (v in verticesA) supportA = max(supportA, dot3(v, normal))
    for (v in verticesB) supportB = min(supportB, dot3(v, normal))
    val plane = (supportA + supportB) / 2.0
    val clipped = clippedFaceManifold(a, b, normal, plane)
    if (clipped != null) return clipped
    val candidates = ArrayList<ScenePhysicsManifoldPoint>()
    for ((index, point) in verticesA.withIndex()) {
        if (supportA - dot3(point, normal) <= depth + SCENE_PHYSICS_SLOP &&
            pointInsideBox(point, b, depth + SCENE_PHYSICS_SLOP)
        ) candidates.add(ScenePhysicsManifoldPoint(point, "a$index"))
    }
    for ((index, point) in verticesB.withIndex()) {
        if (dot3(point, normal) - supportB <= depth + SCENE_PHYSICS_SLOP &&
            pointInsideBox(point, a, depth + SCENE_PHYSICS_SLOP)
        ) candidates.add(ScenePhysicsManifoldPoint(point, "b$index"))
    }
    val points = ArrayList<ScenePhysicsManifoldPoint>()
    for (candidate in candidates) {
        val distance = dot3(candidate.point, normal) - plane
        val point = DoubleArray(3) { candidate.point[it] - normal[it] * distance }
        if (points.none { length3(subtract3(it.point, point)) <= 1e-7 }) {
            points.add(ScenePhysicsManifoldPoint(point, candidate.feature))
        }
    }
    if (points.size > 4) {
        val selected = ArrayList<ScenePhysicsManifoldPoint>()
        selected.add(points[0])
        while (selected.size < 4) {
            var best: ScenePhysicsManifoldPoint? = null
            var bestDistance = Double.NEGATIVE_INFINITY
            for (entry in points) {
                if (entry in selected) continue
                var nearest = Double.POSITIVE_INFINITY
                for (chosen in selected) {
                    val delta = subtract3(entry.point, chosen.point)
                    nearest = min(nearest, dot3(delta, delta))
                }
                if (best == null || nearest > bestDistance) { best = entry; bestDistance = nearest }
            }
            selected.add(best!!)
        }
        return selected
    }
    if (points.isNotEmpty()) return points
    val onA = closestPointOnBox(b.position, a); val onB = closestPointOnBox(a.position, b)
    return listOf(ScenePhysicsManifoldPoint(DoubleArray(3) { (onA[it] + onB[it]) / 2.0 }, "fallback"))
}

/** depth per the P5 collide corpus; normal points FROM a TOWARD b. Ties take the
 *  smallest axis index; axis sign is sign(centerB − centerA) with ties +1. */
fun scenePhysicsContact(a: ScenePhysicsBody, b: ScenePhysicsBody): ScenePhysicsContact? {
    if (a.shape == "sphere" && b.shape == "sphere") {
        val d = doubleArrayOf(
            b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2],
        )
        val dist = length3(d)
        val depth = a.radius + b.radius - dist
        if (depth <= 0.0) return null
        val normal = if (dist == 0.0) doubleArrayOf(0.0, 1.0, 0.0)
        else doubleArrayOf(d[0] / dist, d[1] / dist, d[2] / dist)
        val point = DoubleArray(3) { i ->
            (a.position[i] + normal[i] * a.radius + b.position[i] - normal[i] * b.radius) / 2.0
        }
        return ScenePhysicsContact(depth, normal, point, listOf(point), listOf("sphere"))
    }
    if (a.shape == "box" && b.shape == "box") {
        val axesA = bodyAxes(a)
        val axesB = bodyAxes(b)
        val delta = subtract3(b.position, a.position)
        var depth = Double.POSITIVE_INFINITY
        var normal = doubleArrayOf(0.0, 0.0, 0.0)
        val candidates = ArrayList<ScenePhysicsSatCandidate>()
        axesA.forEachIndexed { index, axis -> candidates.add(ScenePhysicsSatCandidate(axis, ScenePhysicsSatWinner.FaceA(index))) }
        axesB.forEachIndexed { index, axis -> candidates.add(ScenePhysicsSatCandidate(axis, ScenePhysicsSatWinner.FaceB(index))) }
        for (axisAIndex in axesA.indices) for (axisBIndex in axesB.indices) {
            val axisA = axesA[axisAIndex]
            val axisB = axesB[axisBIndex]
            val axis = cross3(axisA, axisB)
            val length = length3(axis)
            if (length > 1e-9) candidates.add(ScenePhysicsSatCandidate(
                doubleArrayOf(axis[0] / length, axis[1] / length, axis[2] / length),
                ScenePhysicsSatWinner.Edge(axisAIndex, axisBIndex),
            ))
        }
        var winner: ScenePhysicsSatWinner = ScenePhysicsSatWinner.FaceA(0)
        for (candidate in candidates) {
            val axis = candidate.axis
            var radiusA = 0.0; var radiusB = 0.0
            for (i in 0 until 3) {
                radiusA += a.half[i] * abs(dot3(axis, axesA[i]))
                radiusB += b.half[i] * abs(dot3(axis, axesB[i]))
            }
            val distance = dot3(delta, axis)
            val overlap = radiusA + radiusB - abs(distance)
            if (overlap <= 0.0) return null
            if (overlap < depth) {
                depth = overlap
                normal = if (distance >= 0.0) axis.copyOf() else doubleArrayOf(-axis[0], -axis[1], -axis[2])
                winner = candidate.winner
            }
        }
        val manifold = boxManifoldPoints(a, b, normal, depth, winner)
        val points = manifold.map { it.point }
        return ScenePhysicsContact(depth, normal, points[0], points, manifold.map { it.feature })
    }
    val sphere = if (a.shape == "sphere") a else b
    val box = if (a.shape == "box") a else b
    val axes = bodyAxes(box)
    val local = subtract3(sphere.position, box.position)
    val qLocal = DoubleArray(3) { i -> min(max(dot3(local, axes[i]), -box.half[i]), box.half[i]) }
    var q = box.position.copyOf()
    for (i in 0 until 3) for (k in 0 until 3) q[k] += axes[i][k] * qLocal[i]
    val d = doubleArrayOf(
        sphere.position[0] - q[0], sphere.position[1] - q[1], sphere.position[2] - q[2],
    )
    val dist = length3(d)
    val depth: Double
    val towardSphere: Vec3
    if (dist > 0.0) {
        depth = sphere.radius - dist
        if (depth <= 0.0) return null
        towardSphere = doubleArrayOf(d[0] / dist, d[1] / dist, d[2] / dist)
    } else {
        var inside = Double.POSITIVE_INFINITY
        var axis = -1
        for (i in 0 until 3) {
            val toFace = box.half[i] - abs(dot3(local, axes[i]))
            if (toFace < inside) { inside = toFace; axis = i }
        }
        depth = sphere.radius + inside
        val sign = if (dot3(local, axes[axis]) >= 0.0) 1.0 else -1.0
        towardSphere = DoubleArray(3) { axes[axis][it] * sign }
        qLocal[axis] = box.half[axis] * sign
        q = box.position.copyOf()
        for (i in 0 until 3) for (k in 0 until 3) q[k] += axes[i][k] * qLocal[i]
    }
    return if (a.shape == "sphere") {
        ScenePhysicsContact(depth, doubleArrayOf(-towardSphere[0], -towardSphere[1], -towardSphere[2]), q, listOf(q), listOf("sphere-box"))
    } else {
        ScenePhysicsContact(depth, towardSphere, q, listOf(q), listOf("sphere-box"))
    }
}

private fun inverseInertiaWorld(body: ScenePhysicsBody, value: Vec3): Vec3 {
    if (body.mode2d) return doubleArrayOf(0.0, 0.0, value[2] * body.invInertia[2])
    val matrix = bodyInertiaMatrices(body).inverse
    return DoubleArray(3) { row -> dot3(matrix[row], value) }
}

private fun inertiaWorld(body: ScenePhysicsBody, value: Vec3): Vec3 {
    if (body.mode2d) {
        val inertia = if (body.invInertia[2] > 0.0) 1.0 / body.invInertia[2] else 0.0
        return doubleArrayOf(0.0, 0.0, value[2] * inertia)
    }
    val matrix = bodyInertiaMatrices(body).tensor
    return DoubleArray(3) { row -> dot3(matrix[row], value) }
}

private fun pointVelocity(body: ScenePhysicsBody, r: Vec3): Vec3 {
    val angular = cross3(body.angularVelocity, r)
    return DoubleArray(3) { body.velocity[it] + angular[it] }
}

private fun impulseDenominator(
    body: ScenePhysicsBody, r: Vec3, direction: Vec3,
    effectiveInvMass: Double = body.invMass,
): Double {
    // Sleeping dynamics remain immutable supports. Preserve their stored mass and
    // inertia for a later wake, but expose neither to the active constraint.
    if (effectiveInvMass == 0.0) return 0.0
    val rxn = cross3(r, direction)
    return effectiveInvMass + dot3(direction, cross3(inverseInertiaWorld(body, rxn), r))
}

private fun applyImpulse(
    body: ScenePhysicsBody, r: Vec3, impulse: Vec3, sign: Double,
    effectiveInvMass: Double = body.invMass,
) {
    if (effectiveInvMass == 0.0) return
    for (i in 0 until 3) body.velocity[i] += impulse[i] * effectiveInvMass * sign
    val angular = inverseInertiaWorld(body, cross3(r, impulse))
    for (i in 0 until 3) body.angularVelocity[i] += angular[i] * sign
}

// ── the step (THE STEP ORDER — pinned in the corpus _note, mirrored verbatim) ────────

private fun pairKey(a: String, b: String): String = "$a\u0000$b"   // NUL, the TS twin's separator — ids may contain spaces

fun stepScenePhysicsWorld(
    world: ScenePhysicsWorld, intents: Map<String, ScenePhysicsIntent> = emptyMap(),
): ScenePhysicsStepResult {
    val g = world.gravity
    val dt = SCENE_PHYSICS_DT
    // 1 ── kinematic drive: position from the authored/bound plane, velocity derived
    for (b in world.bodies) {
        if (b.kind != "kinematic") continue
        b.previous = b.position.copyOf()
        b.previousRotation = b.rotation.copyOf()
        val p = intents[b.id]?.position
        if (p != null) {
            if (p[0] != b.position[0] || p[1] != b.position[1] || p[2] != b.position[2]) {
                invalidateContactCache(world, b.id)
            }
            b.velocity = doubleArrayOf(
                (p[0] - b.position[0]) / dt, (p[1] - b.position[1]) / dt, (p[2] - b.position[2]) / dt,
            )
            b.position = p.copyOf()
        } else {
            b.velocity = doubleArrayOf(0.0, 0.0, 0.0)
        }
        val rotation = intents[b.id]?.rotation
        if (rotation != null) {
            if (rotation[0] != b.rotation[0] || rotation[1] != b.rotation[1] || rotation[2] != b.rotation[2]) {
                invalidateContactCache(world, b.id)
            }
            val targetOrientation = quaternionFromEuler(rotation)
            b.angularVelocity = shortestArcAngularVelocity(b.orientation, targetOrientation, dt)
            b.rotation = rotation.copyOf()
            b.orientation = targetOrientation
        } else {
            b.angularVelocity = doubleArrayOf(0.0, 0.0, 0.0)
        }
    }
    if (world.mode2d) {
        for (b in world.bodies) {
            b.angularVelocity[0] = 0.0
            b.angularVelocity[1] = 0.0
        }
    }
    // 2 ── character intent · 3 ── integrate (semi-implicit Euler: v += g·dt, x += v·dt)
    for (b in world.bodies) {
        if (b.kind == "static" || b.kind == "kinematic" || b.sleeping) continue
        if (b.kind == "character") {
            val move = intents[b.id]?.move
            var mx = move?.get(0) ?: 0.0
            var mz = move?.get(1) ?: 0.0
            val ln = sqrt(mx * mx + mz * mz)
            if (ln > 1.0) { mx /= ln; mz /= ln }
            b.velocity[0] = mx * b.speed
            b.velocity[2] = mz * b.speed
        }
        b.previous = b.position.copyOf()
        b.previousRotation = b.rotation.copyOf()
        b.velocity[0] += g[0] * dt
        b.velocity[1] += g[1] * dt
        b.velocity[2] += g[2] * dt
        b.position[0] += b.velocity[0] * dt
        b.position[1] += b.velocity[1] * dt
        b.position[2] += b.velocity[2] * dt
        if (b.kind == "dynamic") {
            val drag = max(0.0, 1.0 - b.angularDamping * dt)
            val angularMomentum = inertiaWorld(b, b.angularVelocity)
            for (k in 0 until 3) {
                angularMomentum[k] = (angularMomentum[k] + b.torque[k] * dt) * drag
            }
            b.angularVelocity = inverseInertiaWorld(b, angularMomentum)
            integrateOrientation(b, dt)
            b.angularVelocity = inverseInertiaWorld(b, angularMomentum)
        }
    }
    // 4 ── solid pass: pairs in document order (i < j)
    val solidNow = ArrayList<Pair<String, String>>()
    val bodies = world.bodies
    val solverContacts = ArrayList<ScenePhysicsSolverContact>()
    for (i in bodies.indices) {
        for (j in i + 1 until bodies.size) {
            val a = bodies[i]
            val b = bodies[j]
            if (a.trigger || b.trigger) continue
            val aStill = a.kind == "static" || a.kind == "kinematic"
            val bStill = b.kind == "static" || b.kind == "kinematic"
            if (aStill && bStill) continue
            if (a.kind == "character" && b.kind == "character") continue // named non-interaction
            if ((a.kind == "character" && bStill) || (b.kind == "character" && aStill)) continue // pass 5
            if (!layersCollide(a, b)) continue
            val c = scenePhysicsContact(a, b) ?: continue
            val depth = c.depth
            var n = c.normal.copyOf()
            if (world.mode2d) {
                val planarLength = sqrt(n[0] * n[0] + n[1] * n[1])
                if (planarLength <= 1e-12) continue
                n = doubleArrayOf(n[0] / planarLength, n[1] / planarLength, 0.0)
            }
            solidNow.add(a.id to b.id)
            // the wake law
            for ((s, o) in listOf(a to b, b to a)) {
                if (s.kind == "dynamic" && s.sleeping) {
                    // energetic contact ONLY: a kinematic wakes a sleeper when it is
                    // MOVING — a stationary platform must let the world sleep
                    val surfaceVelocity = pointVelocity(o, subtract3(c.point, o.position))
                    val surfaceSpeed = if (world.mode2d) {
                        sqrt(surfaceVelocity[0] * surfaceVelocity[0] + surfaceVelocity[1] * surfaceVelocity[1])
                    } else length3(surfaceVelocity)
                    // An awake dynamic already accumulating quiet sleep ticks is a
                    // resting neighbour, not a new impactor. Its pre-solve gravity
                    // velocity must not make staggered stack sleepers wake forever.
                    val energeticDynamic = o.kind == "dynamic" && !o.sleeping && o.sleepCount == 0
                    if (o.kind == "character" ||
                        ((o.kind == "kinematic" || energeticDynamic) &&
                            surfaceSpeed > SCENE_PHYSICS_SLEEP_SPEED)
                    ) {
                        s.sleeping = false
                        s.sleepCount = 0
                    }
                }
            }
            // Sleeping dynamics remain solid solver-static supports. Dropping their
            // pair for one tick makes staggered stacks repeatedly lose their floor.
            val invA = if (a.kind == "character" || (a.kind == "dynamic" && a.sleeping)) 0.0 else a.invMass
            val invB = if (b.kind == "character" || (b.kind == "dynamic" && b.sleeping)) 0.0 else b.invMass
            val invSum = invA + invB
            if (invSum == 0.0) continue
            val cache = contactCache(world)
            val constraints = c.points.mapIndexed { pointIndex, point ->
                val key = "${pairKey(a.id, b.id)}\u0000${c.features[pointIndex]}"
                val localAnchorA = localContactAnchor(point, a)
                val localAnchorB = localContactAnchor(point, b)
                var cached = cache[key]
                if (cached == null) {
                    cached = ScenePhysicsCachedImpulse(
                        a.id, b.id, 0.0, n.copyOf(), doubleArrayOf(0.0, 0.0, 0.0),
                        localAnchorA, localAnchorB, world.tick,
                    )
                    cache[key] = cached
                } else if (dot3(cached.normalAxis, n) < 0.95 ||
                    length3(subtract3(cached.localAnchorA, localAnchorA)) > 0.02 ||
                    length3(subtract3(cached.localAnchorB, localAnchorB)) > 0.02
                ) {
                    cached.normal = 0.0
                    cached.tangent = doubleArrayOf(0.0, 0.0, 0.0)
                }
                cached.normalAxis = n.copyOf()
                cached.localAnchorA = localAnchorA
                cached.localAnchorB = localAnchorB
                cached.lastTick = world.tick
                val rA = subtract3(point, a.position); val rB = subtract3(point, b.position)
                val approach = dot3(subtract3(pointVelocity(b, rB), pointVelocity(a, rA)), n)
                val restitution = if (-approach > SCENE_PHYSICS_RESTITUTION_MIN_SPEED) max(a.bounce, b.bounce) else 0.0
                ScenePhysicsPointConstraint(
                    rA, rB, cached, if (approach < 0.0) -restitution * approach else 0.0,
                    impulseDenominator(a, rA, n, invA) + impulseDenominator(b, rB, n, invB),
                    doubleArrayOf(0.0, 0.0, 0.0), 0.0,
                )
            }
            solverContacts.add(ScenePhysicsSolverContact(a, b, depth, n, invA, invB, invSum, constraints))
        }
    }
    for (solver in solverContacts) {
        val a = solver.a; val b = solver.b; val n = solver.n
        for (constraint in solver.constraints) {
            val cached = constraint.cached
            val tangentNormal = dot3(cached.tangent, n)
            cached.tangent = DoubleArray(3) { cached.tangent[it] - n[it] * tangentNormal }
            val warm = DoubleArray(3) { n[it] * cached.normal + cached.tangent[it] }
            applyImpulse(a, constraint.rA, warm, -1.0, solver.invA)
            applyImpulse(b, constraint.rB, warm, 1.0, solver.invB)
        }
    }
    repeat(SCENE_PHYSICS_MANIFOLD_ITERATIONS) {
        for (solver in solverContacts) {
            val a = solver.a; val b = solver.b; val n = solver.n
            for (constraint in solver.constraints) {
                    val rA = constraint.rA; val rB = constraint.rB; val cached = constraint.cached
                    val rel = dot3(subtract3(pointVelocity(b, rB), pointVelocity(a, rA)), n)
                    val normalDenominator = constraint.normalDenominator
                    val deltaNormal = if (normalDenominator > 0.0) (constraint.target - rel) / normalDenominator else 0.0
                    val previousNormal = cached.normal
                    cached.normal = max(previousNormal + deltaNormal, 0.0)
                    val appliedNormal = cached.normal - previousNormal
                    val normalImpulse = DoubleArray(3) { n[it] * appliedNormal }
                    applyImpulse(a, rA, normalImpulse, -1.0, solver.invA)
                    applyImpulse(b, rB, normalImpulse, 1.0, solver.invB)
                    val rv = subtract3(pointVelocity(b, rB), pointVelocity(a, rA))
                    val rn = dot3(rv, n)
                    val t = doubleArrayOf(
                        rv[0] - n[0] * rn,
                        rv[1] - n[1] * rn,
                        if (world.mode2d) 0.0 else rv[2] - n[2] * rn,
                    )
                    val tl = length3(t)
                    if (tl > 1e-9) {
                        val tn = doubleArrayOf(t[0] / tl, t[1] / tl, t[2] / tl)
                        if (dot3(constraint.tangentAxis, tn) < 0.999999) {
                            constraint.tangentAxis = tn
                            constraint.tangentDenominator = impulseDenominator(a, rA, tn, solver.invA) +
                                impulseDenominator(b, rB, tn, solver.invB)
                        }
                        val tangentDenominator = constraint.tangentDenominator
                        val deltaTangent = if (tangentDenominator > 0.0) -dot3(rv, tn) / tangentDenominator else 0.0
                        val previousTangent = cached.tangent.copyOf()
                        cached.tangent = DoubleArray(3) { cached.tangent[it] + tn[it] * deltaTangent }
                        val tangentProjection = dot3(cached.tangent, n)
                        for (k in 0 until 3) cached.tangent[k] -= n[k] * tangentProjection
                        val mu = sqrt(a.friction * b.friction)
                        val cap = mu * cached.normal
                        val tangentLength = length3(cached.tangent)
                        if (tangentLength > cap && tangentLength > 0.0) {
                            val scale = cap / tangentLength
                            for (k in 0 until 3) cached.tangent[k] *= scale
                        }
                        val tangentImpulse = subtract3(cached.tangent, previousTangent)
                        applyImpulse(a, rA, tangentImpulse, -1.0, solver.invA)
                        applyImpulse(b, rB, tangentImpulse, 1.0, solver.invB)
                    }
            }
        }
    }
    for (solver in solverContacts) {
        val corr = SCENE_PHYSICS_CORRECTION_PERCENT * max(solver.depth - SCENE_PHYSICS_SLOP, 0.0) / solver.invSum
        for (k in 0 until 3) {
            solver.a.position[k] -= solver.n[k] * (corr * solver.invA)
            solver.b.position[k] += solver.n[k] * (corr * solver.invB)
        }
    }
    // 5 ── character move-and-slide vs static/kinematic (full depenetration, deepest first)
    for (ch in bodies) {
        if (ch.kind != "character") continue
        ch.grounded = false
        for (iter in 0 until SCENE_PHYSICS_SLIDE_ITERATIONS) {
            var bestContact: ScenePhysicsContact? = null
            var bestOther: ScenePhysicsBody? = null
            for (other in bodies) {
                if ((other.kind != "static" && other.kind != "kinematic") || other.trigger) continue
                if (!layersCollide(ch, other)) continue
                val c = scenePhysicsContact(ch, other) ?: continue
                if (bestContact == null || c.depth > bestContact.depth) {
                    bestContact = c
                    bestOther = other
                }
            }
            val contact = bestContact ?: break
            val other = bestOther!!
            val depth = contact.depth
            val n = contact.normal
            solidNow.add(if (ch.index < other.index) ch.id to other.id else other.id to ch.id)
            for (k in 0 until 3) ch.position[k] -= n[k] * depth
            val vn = ch.velocity[0] * n[0] + ch.velocity[1] * n[1] + ch.velocity[2] * n[2]
            if (vn > 0.0) {
                for (k in 0 until 3) ch.velocity[k] -= n[k] * vn
            }
            if (-n[1] > SCENE_PHYSICS_GROUND_NORMAL_Y) ch.grounded = true
        }
    }
    // 6 ── trigger overlaps (exactly one trigger per pair; no forces)
    val triggerNow = ArrayList<Pair<String, String>>()
    for (i in bodies.indices) {
        for (j in i + 1 until bodies.size) {
            val a = bodies[i]
            val b = bodies[j]
            if (a.trigger == b.trigger) continue
            if (!layersCollide(a, b)) continue
            if (scenePhysicsContact(a, b) != null) triggerNow.add(a.id to b.id)
        }
    }
    // 7 ── events (enter-tracker semantics, both directions per pair)
    val collisions = ArrayList<ScenePhysicsPairEvent>()
    val enters = ArrayList<ScenePhysicsPairEvent>()
    val exits = ArrayList<ScenePhysicsPairEvent>()
    val seenSolid = LinkedHashSet<String>()
    for ((pa, pb) in solidNow) {
        val key = pairKey(pa, pb)
        if (key in seenSolid) continue
        seenSolid.add(key)
        if (key !in world.solidOverlap) {
            collisions.add(ScenePhysicsPairEvent(pa, pb))
            collisions.add(ScenePhysicsPairEvent(pb, pa))
        }
    }
    world.solidOverlap = seenSolid
    val triggerSet = triggerNow.mapTo(HashSet()) { pairKey(it.first, it.second) }
    for ((pa, pb) in triggerNow) {
        if (pairKey(pa, pb) !in world.triggerOverlap) {
            enters.add(ScenePhysicsPairEvent(pa, pb))
            enters.add(ScenePhysicsPairEvent(pb, pa))
        }
    }
    for (key in world.triggerOrder) {
        if (key !in triggerSet) {
            val parts = key.split("\u0000")
            exits.add(ScenePhysicsPairEvent(parts[0], parts[1]))
            exits.add(ScenePhysicsPairEvent(parts[1], parts[0]))
        }
    }
    world.triggerOrder = world.triggerOrder.filterTo(ArrayList()) { it in triggerSet }
    for ((pa, pb) in triggerNow) {
        val key = pairKey(pa, pb)
        if (key !in world.triggerOrder) world.triggerOrder.add(key)
    }
    world.triggerOverlap = triggerSet
    // 8 ── sleep pass (dynamic only; characters and kinematics never sleep)
    for (b in bodies) {
        if (b.kind != "dynamic" || b.sleeping) continue
        if (length3(b.velocity) < SCENE_PHYSICS_SLEEP_SPEED &&
            length3(b.angularVelocity) < SCENE_PHYSICS_SLEEP_SPEED && length3(b.torque) == 0.0
        ) {
            b.sleepCount += 1
            if (b.sleepCount >= SCENE_PHYSICS_SLEEP_TICKS) {
                b.sleeping = true
                b.velocity = doubleArrayOf(0.0, 0.0, 0.0)
                b.angularVelocity = doubleArrayOf(0.0, 0.0, 0.0)
            }
        } else {
            b.sleepCount = 0
        }
    }
    // 8.5 ── G6 THE Z-LOCK PASS (mode="2d" only — the 3D solver above ran UNCHANGED):
    // the last act of every step re-pins each body's z position (and its interpolation
    // anchor) and z velocity to the recorded locks, so one solver serves both modes.
    if (world.mode2d) {
        for (b in bodies) {
            b.position[2] = b.zLock
            b.previous[2] = b.zLock
            b.velocity[2] = b.vzLock
            b.rotation[0] = b.rotation2dLock[0]
            b.rotation[1] = b.rotation2dLock[1]
            b.previousRotation[0] = b.rotation2dLock[0]
            b.previousRotation[1] = b.rotation2dLock[1]
            b.angularVelocity[0] = 0.0
            b.angularVelocity[1] = 0.0
            b.orientation = quaternionFromEuler(b.rotation)
        }
    }
    val cache = contactCache(world)
    val cacheIterator = cache.iterator()
    while (cacheIterator.hasNext()) if (cacheIterator.next().value.lastTick != world.tick) cacheIterator.remove()
    val tick = world.tick
    world.tick += 1
    return ScenePhysicsStepResult(tick, dt, collisions, enters, exits)
}

// ── the accumulator + interpolation (THE FIXED-TICK LAW's render half) ───────────────

class ScenePhysicsAdvance(val steps: Int, val alpha: Double)

/** feed one rendered frame's dt (SECONDS); how many fixed steps to run now and the
 *  interpolation alpha after them */
class ScenePhysicsAccumulator {
    private var acc = 0.0

    fun advance(frameSeconds: Double): ScenePhysicsAdvance {
        acc = min(acc + frameSeconds, SCENE_PHYSICS_MAX_STEPS * SCENE_PHYSICS_DT)
        val steps = floor(acc / SCENE_PHYSICS_DT).toInt()
        acc -= steps * SCENE_PHYSICS_DT
        return ScenePhysicsAdvance(steps, acc / SCENE_PHYSICS_DT)
    }
}

/** the pure fold the corpus pins: frame durations in MILLISECONDS → per-frame steps
 *  and alpha (the runner divides by 1000 exactly as the surface does) */
fun scenePhysicsSchedule(framesMs: List<Double>): List<ScenePhysicsAdvance> {
    val accumulator = ScenePhysicsAccumulator()
    return framesMs.map { accumulator.advance(it / 1000.0) }
}

/** THE INTERPOLATION LAW: rendered = prev + (curr − prev)·alpha, componentwise */
fun scenePhysicsInterpolate(prev: Vec3, curr: Vec3, alpha: Double): Vec3 = doubleArrayOf(
    prev[0] + (curr[0] - prev[0]) * alpha,
    prev[1] + (curr[1] - prev[1]) * alpha,
    prev[2] + (curr[2] - prev[2]) * alpha,
)

// ── extraction from the IR (the world law — corpus `world` cases) ────────────────────

class ScenePhysicsExtraction(
    val gravity: Vec3,
    val bodies: List<ScenePhysicsBodySpec>,
    /** G6: the scene's mode is "2d" — the world this extraction builds carries the z-lock */
    val mode2d: Boolean = false,
)

private val PHYSICS_ELIGIBLE: Set<SceneNodeKind> =
    setOf(
        SceneNodeKind.BOX, SceneNodeKind.SPHERE, SceneNodeKind.PLANE, SceneNodeKind.MODEL,
        SceneNodeKind.SPRITE,
    )

private fun isIdentityMat(m: Mat4): Boolean {
    val identity = mat4Identity()
    for (i in 0 until 16) {
        if (kotlin.math.abs(m[i] - identity[i]) > 1e-9) return false
    }
    return true
}

private fun largestBasis(m: Mat4): Double = max(
    max(
        sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]),
        sqrt(m[4] * m[4] + m[5] * m[5] + m[6] * m[6]),
    ),
    sqrt(m[8] * m[8] + m[9] * m[9] + m[10] * m[10]),
)

private fun basisScales(m: Mat4): Vec3 = doubleArrayOf(
    sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]),
    sqrt(m[4] * m[4] + m[5] * m[5] + m[6] * m[6]),
    sqrt(m[8] * m[8] + m[9] * m[9] + m[10] * m[10]),
)

/** Root-frame Rz*Ry*Rx rotation. Transformed-parent shear is diagnosed; a stable
 * Gram-Schmidt frame keeps the collider deterministic at that boundary. */
private fun rootRotation(m: Mat4, reference: Vec3): Vec3 {
    val scales = basisScales(m)
    var x = if (scales[0] > 0.0) doubleArrayOf(m[0] / scales[0], m[1] / scales[0], m[2] / scales[0])
        else doubleArrayOf(1.0, 0.0, 0.0)
    val rawY = if (scales[1] > 0.0) doubleArrayOf(m[4] / scales[1], m[5] / scales[1], m[6] / scales[1])
        else doubleArrayOf(0.0, 1.0, 0.0)
    val xy = dot3(rawY, x)
    var y = doubleArrayOf(rawY[0] - x[0] * xy, rawY[1] - x[1] * xy, rawY[2] - x[2] * xy)
    val yl = length3(y)
    y = if (yl > 1e-9) doubleArrayOf(y[0] / yl, y[1] / yl, y[2] / yl)
        else doubleArrayOf(0.0, 1.0, 0.0)
    var z = cross3(x, y)
    val rawZ = if (scales[2] > 0.0) doubleArrayOf(m[8] / scales[2], m[9] / scales[2], m[10] / scales[2])
        else doubleArrayOf(0.0, 0.0, 1.0)
    if (dot3(z, rawZ) < 0.0) z = doubleArrayOf(-z[0], -z[1], -z[2])
    x = cross3(y, z)
    val ry = asin(max(-1.0, min(1.0, -x[2])))
    val cy = cos(ry)
    val rx = if (abs(cy) > 1e-9) atan2(y[2], z[2]) else atan2(-z[1], y[1])
    val rz = if (abs(cy) > 1e-9) atan2(x[1], x[0]) else 0.0
    return doubleArrayOf(
        unwrapDegrees(rx * SCENE_PHYSICS_RADIANS_TO_DEGREES, reference[0]),
        unwrapDegrees(ry * SCENE_PHYSICS_RADIANS_TO_DEGREES, reference[1]),
        unwrapDegrees(rz * SCENE_PHYSICS_RADIANS_TO_DEGREES, reference[2]),
    )
}

private fun orientedHalfFromWorld(m: Mat4, localHalf: Vec3, rotation: Vec3): Vec3 {
    val axes = quaternionAxes(quaternionFromEuler(rotation))
    val center = doubleArrayOf(m[12], m[13], m[14])
    val half = doubleArrayOf(0.0, 0.0, 0.0)
    for (sx in intArrayOf(-1, 1)) for (sy in intArrayOf(-1, 1)) for (sz in intArrayOf(-1, 1)) {
        val corner = transformPoint(m, doubleArrayOf(localHalf[0] * sx, localHalf[1] * sy, localHalf[2] * sz))
        val delta = subtract3(corner, center)
        for (i in 0 until 3) half[i] = max(half[i], abs(dot3(delta, axes[i])))
    }
    return half
}

/** a model's auto SPHERE collider radius from its local half extents (the
 *  bounding-sphere convention: half-diagonal) */
// ── the parent-frame law (G2 x G1) ───────────────────────────────────────────────────
//
// Bodies SIMULATE in scene-root space (extraction freezes each body's WORLD position; a
// transformed parent is diagnosed, not obeyed). But a node's authored `position` is
// LOCAL to its parent, and the renderer composes parentWorld * local. So the solver's
// root-space result must be expressed in the parent's frame before it lands on the
// node, and an authored/bus position write must be lifted out of the parent's frame
// before it teleports the body. Without this pair every body under a transformed parent
// — which a G1 prefab instance ALWAYS is — renders double-offset. Both are identities
// at the scene root (the fast path callers take). Corpus: physics.json `parentframe`.

/** root-space -> the parent's local frame (what the node's `position` must hold) */
fun scenePhysicsToLocal(rootPosition: Vec3, parentWorld: Mat4?): Vec3 {
    if (parentWorld == null) return rootPosition.copyOf()
    val inverse = mat4Invert(parentWorld) ?: return rootPosition.copyOf()   // degenerate: honest passthrough
    return transformPoint(inverse, rootPosition)
}

/** the parent's local frame -> root space (what a position write means to the solver) */
fun scenePhysicsToRoot(localPosition: Vec3, parentWorld: Mat4?): Vec3 {
    if (parentWorld == null) return localPosition.copyOf()
    return transformPoint(parentWorld, localPosition)
}

fun scenePhysicsRotationToRoot(
    localRotation: Vec3, parentWorld: Mat4?, reference: Vec3 = localRotation,
): Vec3 {
    if (parentWorld == null) return localRotation.copyOf()
    val local = mat4Trs(
        doubleArrayOf(0.0, 0.0, 0.0), localRotation, doubleArrayOf(1.0, 1.0, 1.0),
    )
    return rootRotation(mat4Multiply(parentWorld, local), reference)
}

fun scenePhysicsRotationToLocal(
    root: Vec3, parentWorld: Mat4?, reference: Vec3 = root,
): Vec3 {
    if (parentWorld == null) return root.copyOf()
    val inverse = mat4Invert(parentWorld) ?: return root.copyOf()
    val rootMatrix = mat4Trs(
        doubleArrayOf(0.0, 0.0, 0.0), root, doubleArrayOf(1.0, 1.0, 1.0),
    )
    return rootRotation(mat4Multiply(inverse, rootMatrix), reference)
}

private fun sphereRadiusOfHalf(half: Vec3): Double =
    sqrt(half[0] * half[0] + half[1] * half[1] + half[2] * half[2])

/** THE GRAVITY LAW: `<scene gravity="x y z">`, default 0 −9.81 0, malformed → default
 *  with one diagnostic (Article 7) */
fun scenePhysicsGravity(ir: SceneIR, resolve: SceneResolve, diag: SceneDiag? = null): Vec3 =
    readVec(null, "gravity", SCENE_PHYSICS_DEFAULT_GRAVITY, resolve, diag, ir.attrs)

/** extract every physics body from the scene tree. THE EXTRACTION LAWS:
 *  - a `physics` word outside static|dynamic|kinematic|character is NOT a body (one
 *    diagnostic); only box/sphere/plane/model nodes are eligible (one diagnostic);
 *  - colliders derive from the authored world transform ONCE (the freeze law):
 *    collider="auto" → sphere from `<sphere>` (bounding-sphere law), world AABB from
 *    box/plane/model bounds; explicit collider="sphere"|"box" per the P5 collider
 *    laws; another word → auto with one diagnostic;
 *  - bodies without an id get `#N` (1-based, extraction order);
 *  - a transformed ancestor draws ONE diagnostic and the body simulates in scene-root
 *    space (v1 — bodies are root-frame citizens);
 *  - `modelHalf` supplies a loaded model's local half extents (renderer-owned;
 *    [0.5, 0.5, 0.5] until known). */
fun extractScenePhysics(
    ir: SceneIR, resolve: SceneResolve, diag: SceneDiag? = null,
    modelHalf: (SceneNode) -> Vec3? = { null },
): ScenePhysicsExtraction {
    val bodies = ArrayList<ScenePhysicsBodySpec>()
    var serial = 0

    fun extractBody(
        node: SceneNode, props: SceneNodeProps, world: Mat4,
        physicsRaw: String, parentTransformed: Boolean,
    ): ScenePhysicsBodySpec? {
        if (physicsRaw !in SCENE_PHYSICS_KINDS) {
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.UNKNOWN_PHYSICS,
                "physics=\"$physicsRaw\" is not static, dynamic, kinematic or character — not a body",
            ))
            return null
        }
        if (node.kind !in PHYSICS_ELIGIBLE) {
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.UNKNOWN_PHYSICS,
                "<${node.kind.tag}> cannot be a physics body — only box, sphere, plane, model and sprite",
            ))
            return null
        }
        if (parentTransformed) {
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.PHYSICS_NESTED,
                "a physics body under a transformed parent simulates in scene-root space (v1)",
            ))
        }
        val colliderRaw = readString(node, "collider", "auto", resolve, node.attrs)
        var collider = colliderRaw
        // G6: `circle` is the 2D spelling of `sphere` (the sprite word) — one shape set
        if (collider == "circle") collider = "sphere"
        if (collider != "auto" && collider != "sphere" && collider != "box") {
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.UNKNOWN_COLLIDE,
                "collider=\"$colliderRaw\" is not auto, sphere, circle or box — using auto",
            ))
            collider = "auto"
        }
        val shape: ScenePhysicsShape
        val position: Vec3
        if (node.kind == SceneNodeKind.SPRITE) {
            // G6 THE SPRITE COLLIDER LAW: the quad's own rectangle, centered on the QUAD
            // (the anchor offset applied), extruded SCENE_SPRITE_COLLIDER_HALF_Z in z so
            // a box↔box minimum-overlap axis always lands in the XY plane.
            // `collider="circle"` takes radius = half the SMALLER extent. The RESOLVED
            // `size` is what colliders read — the texture-aspect default is a render-time
            // refinement (the honest v1).
            val size = spriteSizeOf(props)
            val quadWorld = mat4Multiply(world, mat4Trs(
                spriteAnchorOffset(props, size[0], size[1]),
                doubleArrayOf(0.0, 0.0, 0.0), doubleArrayOf(1.0, 1.0, 1.0),
            ))
            if (collider == "sphere") {
                shape = ScenePhysicsShape.Sphere(min(size[0], size[1]) / 2.0 * largestBasis(world))
                position = doubleArrayOf(quadWorld[12], quadWorld[13], quadWorld[14])
            } else {
                val rotation = rootRotation(quadWorld, props.rotation)
                position = doubleArrayOf(quadWorld[12], quadWorld[13], quadWorld[14])
                shape = ScenePhysicsShape.Box(orientedHalfFromWorld(
                    quadWorld, doubleArrayOf(size[0] / 2.0, size[1] / 2.0, SCENE_SPRITE_COLLIDER_HALF_Z),
                    rotation,
                ))
            }
        } else if (collider == "sphere" || (collider == "auto" && node.kind == SceneNodeKind.SPHERE)) {
            val local = if (node.kind == SceneNodeKind.MODEL) {
                sphereRadiusOfHalf(modelHalf(node) ?: doubleArrayOf(0.5, 0.5, 0.5))
            } else {
                nodeBoundingRadius(node, props) ?: 0.5
            }
            shape = ScenePhysicsShape.Sphere(local * largestBasis(world))
            position = doubleArrayOf(world[12], world[13], world[14])
        } else {
            val localHalf: Vec3 = when (node.kind) {
                SceneNodeKind.BOX -> doubleArrayOf(props.boxSize[0] / 2.0, props.boxSize[1] / 2.0, props.boxSize[2] / 2.0)
                SceneNodeKind.SPHERE -> doubleArrayOf(props.radius, props.radius, props.radius)
                SceneNodeKind.PLANE -> doubleArrayOf(props.planeSize[0] / 2.0, props.planeSize[1] / 2.0, 0.0)
                else -> modelHalf(node) ?: doubleArrayOf(0.5, 0.5, 0.5)
            }
            val rotation = rootRotation(world, props.rotation)
            position = doubleArrayOf(world[12], world[13], world[14])
            shape = ScenePhysicsShape.Box(orientedHalfFromWorld(world, localHalf, rotation))
        }
        serial += 1
        var mass = if (physicsRaw == "dynamic") readScalar(node, "mass", 1.0, resolve, diag, node.attrs) else 1.0
        if (mass <= 0.0) {
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.MALFORMED_NUMBER,
                "mass=\"${sceneNumberString(mass)}\" is not positive — using 1",
            ))
            mass = 1.0
        }
        val bounceRaw = readScalar(node, "bounce", 0.0, resolve, diag, node.attrs)
        val frictionRaw = readScalar(node, "friction", 0.5, resolve, diag, node.attrs)
        val collidesRaw = if (node.attrs["collides"] == null) null
        else readString(node, "collides", "", resolve, node.attrs)
        return ScenePhysicsBodySpec(
            id = node.id ?: "#$serial",
            kind = physicsRaw,
            shape = shape,
            position = position,
            velocity = readVec(node, "velocity", doubleArrayOf(0.0, 0.0, 0.0), resolve, diag, node.attrs),
            rotation = rootRotation(world, props.rotation),
            angularVelocity = readVec(
                node, "angular-velocity", doubleArrayOf(0.0, 0.0, 0.0), resolve, diag, node.attrs,
            ),
            torque = readVec(node, "torque", doubleArrayOf(0.0, 0.0, 0.0), resolve, diag, node.attrs),
            angularDamping = max(readScalar(
                node, "angular-damping", SCENE_PHYSICS_DEFAULT_ANGULAR_DAMPING, resolve, diag, node.attrs,
            ), 0.0),
            mass = mass,
            bounce = min(max(bounceRaw, 0.0), 1.0),
            friction = max(frictionRaw, 0.0),
            trigger = readString(node, "trigger", "", resolve, node.attrs) == "true",
            layer = readString(node, "layer", "default", resolve, node.attrs),
            collides = collidesRaw?.trim()?.split(Regex("\\s+"))?.filter { it.isNotEmpty() },
            speed = if (physicsRaw == "character")
                readScalar(node, "speed", SCENE_PHYSICS_DEFAULT_SPEED, resolve, diag, node.attrs)
            else SCENE_PHYSICS_DEFAULT_SPEED,
            jump = if (physicsRaw == "character")
                readScalar(node, "jump", SCENE_PHYSICS_DEFAULT_JUMP, resolve, diag, node.attrs)
            else SCENE_PHYSICS_DEFAULT_JUMP,
            node = node,
        )
    }

    fun walk(nodes: List<SceneNode>, parent: Mat4, parentTransformed: Boolean) {
        for (node in nodes) {
            if (node.kind == SceneNodeKind.ANIMATE) continue
            val props = resolvedProps(node, resolve, diag)
            val world = mat4Multiply(parent, mat4Trs(props.position, props.rotation, props.scale))
            val physicsRaw = if (node.attrs["physics"] == null) ""
            else readString(node, "physics", "", resolve, node.attrs)
            if (physicsRaw.isNotEmpty()) {
                extractBody(node, props, world, physicsRaw, parentTransformed)?.let { bodies.add(it) }
            }
            walk(node.children, world, parentTransformed || !isIdentityMat(world))
        }
    }
    walk(ir.nodes, mat4Identity(), false)
    return ScenePhysicsExtraction(
        scenePhysicsGravity(ir, resolve, diag), bodies, ir.mode == SceneMode.TWO_D,
    )
}

// ── the render-riding runtime (both JVM `<scene>` elements — the G2 wiring half) ─────

/** true when any node in the LIVE tree carries a `physics=` attr (bound rows included —
 *  the reconciler swaps them into their group's children) — the loop gate's cheap scan */
fun sceneAnyPhysicsAuthored(nodes: List<SceneNode>): Boolean {
    for (node in nodes) {
        if (node.attrs.containsKey("physics")) return true
        if (sceneAnyPhysicsAuthored(node.children)) return true
    }
    return false
}

/** a loaded model's local half extents for the G2 auto collider — symmetric about the
 *  node origin (v1: half = max |coordinate| per axis over every draw-transformed
 *  vertex; an asymmetric model gets the symmetric hull, the honest approximation) */
fun sceneModelHalfExtents(model: GlbModel): Vec3 {
    val half = doubleArrayOf(0.0, 0.0, 0.0)
    for (draw in model.draws) {
        val mesh = model.meshes.getOrNull(draw.mesh) ?: continue
        val m = draw.world
        for (primitive in mesh.primitives) {
            val positions = primitive.positions
            var i = 0
            while (i + 2 < positions.size) {
                val lx = positions[i]
                val ly = positions[i + 1]
                val lz = positions[i + 2]
                val x = m[0] * lx + m[4] * ly + m[8] * lz + m[12]
                val y = m[1] * lx + m[5] * ly + m[9] * lz + m[13]
                val z = m[2] * lx + m[6] * ly + m[10] * lz + m[14]
                if (kotlin.math.abs(x) > half[0]) half[0] = kotlin.math.abs(x)
                if (kotlin.math.abs(y) > half[1]) half[1] = kotlin.math.abs(y)
                if (kotlin.math.abs(z) > half[2]) half[2] = kotlin.math.abs(z)
                i += 3
            }
        }
    }
    return half
}

/** the bus read of one body's solver state (grounded/sleeping/velocity ride nodes()) */
class ScenePhysicsNodeInfo(val grounded: Boolean, val sleeping: Boolean, val velocity: Vec3)

/** one frame's worth of fixed steps — the element dispatches on:tick and the pair
 *  events from [ticks] through its ordinary runner path */
class ScenePhysicsFrame(val ticks: List<ScenePhysicsStepResult>, val changed: Boolean)

/** the body-shaping attrs whose base change re-extracts (extents re-freeze — the web
 *  adapter's physicsOnBaseWrite dirty list) */
private val SCENE_PHYSICS_SHAPING_ATTRS = listOf(
    "physics", "collider", "mass", "bounce", "friction", "trigger", "layer", "collides",
    "speed", "jump", "size", "radius", "angular-damping",
)

/**
 * The fixed-tick solver runtime BOTH JVM `<scene>` elements share (the SceneAnimator /
 * SceneCollisionPass stance). Renderer-independent: the element calls [noteBase] each
 * composition (the pull twin of the web adapter's push write-hook — store AND bus
 * writes both land on the resolved base plane this scans), gates its ONE frame loop on
 * [wants], and drives [advance] per emitted frame tick. Solver-owned positions ride
 * the animator's override plane INTERPOLATED (the P5 seam — the rasterizer path reads
 * them like any animation override).
 */
class ScenePhysicsRuntime(
    private val ir: SceneIR,
    private val animator: SceneAnimator,
    private val diag: SceneDiag? = null,
) {
    /** a loaded model's local half extents (element-rebound; null until known) */
    var modelHalf: (SceneNode) -> Vec3? = { null }

    private val accumulator = ScenePhysicsAccumulator()
    private var world: ScenePhysicsWorld? = null
    private var signature: String? = null
    private val nodesById = HashMap<String, SceneNode>()
    private val idsByNode = HashMap<SceneNode, String>()
    /** last BASE-resolved position/velocity strings per body (the write-law detector) */
    private val writeCache = HashMap<SceneNode, HashMap<String, String>>()

    /** G6 (found by the 2D walk): a BUS write of the SAME base string is still a
     *  COMMAND. While the solver owns the rendered position the base cache still holds
     *  the SPAWN string, so `scene.set(id, "position", <spawn>)` — "put it back where it
     *  started" — must teleport even though nothing about the string changed. The bus
     *  path marks such a write FORCED and the next [noteBase] honours it once. */
    private val forcedWrites = HashSet<Pair<SceneNode, String>>()

    fun forceWrite(node: SceneNode, attr: String) { forcedWrites.add(node to attr) }

    /** THE PARENT-FRAME LAW: bodies simulate in scene-root space, but a node's
     *  `position` is LOCAL to its parent. A body at the scene root needs nothing (null,
     *  the fast path); a nested one — every G1 prefab instance — needs its parent's
     *  world so the solver result can be expressed in that frame. The map is structural
     *  (rebuilt with the world) and the matrices re-derive once per write pass. */
    private val parentOf = HashMap<SceneNode, SceneNode>()
    private var parentWorlds: Map<SceneNode, Mat4>? = null
    private var anyNestedBody = false

    private fun indexParents() {
        parentOf.clear()
        fun walk(list: List<SceneNode>, parent: SceneNode?) {
            for (node in list) {
                if (parent != null) parentOf[node] = parent
                walk(node.children, node)
            }
        }
        walk(ir.nodes, null)
    }

    private fun parentWorld(node: SceneNode, resolve: SceneResolve): Mat4? {
        val parent = parentOf[node] ?: return null
        val cached = parentWorlds ?: worldMatrices(ir.nodes, resolve, diag).also { parentWorlds = it }
        return cached[parent]
    }

    /** the body-shaping fingerprint of the live tree: node identity + shaping attrs +
     *  gravity + model bounds — a change re-extracts (colliders re-freeze), carrying
     *  live state across by node identity (the web rebuildPhysics carry) */
    private fun signatureNow(resolveBase: SceneResolve): String {
        val out = StringBuilder()
        out.append(resolveBase(null, "gravity", ir.attrs["gravity"] ?: ""))
        fun walk(nodes: List<SceneNode>) {
            for (node in nodes) {
                if (node.kind == SceneNodeKind.ANIMATE) continue
                if (node.attrs.containsKey("physics")) {
                    out.append('\u001E').append(System.identityHashCode(node))
                    for (name in SCENE_PHYSICS_SHAPING_ATTRS) {
                        out.append('\u001F').append(resolveBase(node, name, node.attrs[name] ?: ""))
                    }
                    if (node.kind == SceneNodeKind.MODEL) {
                        out.append('\u001F').append(modelHalf(node)?.joinToString(" ") { sceneNumberString(it) } ?: "?")
                    }
                }
                walk(node.children)
            }
        }
        walk(ir.nodes)
        return out.toString()
    }

    private fun seedWriteCache(resolveBase: SceneResolve) {
        writeCache.clear()
        forcedWrites.clear()
        for (body in world?.bodies ?: emptyList()) {
            val node = nodesById[body.id] ?: continue
            val cache = HashMap<String, String>()
            cache["position"] = resolveBase(node, "position", node.attrs["position"] ?: "")
            cache["velocity"] = resolveBase(node, "velocity", node.attrs["velocity"] ?: "")
            cache["rotation"] = resolveBase(node, "rotation", node.attrs["rotation"] ?: "")
            cache["angular-velocity"] = resolveBase(node, "angular-velocity", node.attrs["angular-velocity"] ?: "")
            cache["torque"] = resolveBase(node, "torque", node.attrs["torque"] ?: "")
            writeCache[node] = cache
        }
    }

    private fun ensureWorld(resolveBase: SceneResolve) {
        val next = signatureNow(resolveBase)
        if (next == signature) return
        signature = next
        val carried = HashMap<SceneNode, ScenePhysicsBody>()
        world?.let { old ->
            for (body in old.bodies) {
                nodesById[body.id]?.let { carried[it] = body }
            }
        }
        nodesById.clear()
        idsByNode.clear()
        val extraction = extractScenePhysics(ir, resolveBase, diag) { modelHalf(it) }
        if (extraction.bodies.isEmpty()) {
            world = null
            writeCache.clear()
            return
        }
        val rebuilt = createScenePhysicsWorld(extraction.gravity, extraction.bodies, extraction.mode2d)
        indexParents()   // the parent-frame law's structural half (rebuilt with the world)
        anyNestedBody = extraction.bodies.any { it.node?.let { n -> parentOf.containsKey(n) } == true }
        rebuilt.bodies.forEachIndexed { i, body ->
            val node = extraction.bodies[i].node ?: return@forEachIndexed
            nodesById[body.id] = node
            idsByNode[node] = body.id
            val prior = carried[node]
            if (prior != null && prior.kind == body.kind) {
                // a rebuild (bind reconcile, attr change) carries live state by node identity
                body.position = prior.position.copyOf()
                body.previous = prior.previous.copyOf()
                body.velocity = prior.velocity.copyOf()
                body.rotation = prior.rotation.copyOf()
                body.orientation = prior.orientation.copyOf()
                body.previousRotation = prior.previousRotation.copyOf()
                body.angularVelocity = prior.angularVelocity.copyOf()
                body.torque = prior.torque.copyOf()
                body.grounded = prior.grounded
                body.sleeping = prior.sleeping
                body.sleepCount = prior.sleepCount
            }
        }
        world = rebuilt
        seedWriteCache(resolveBase)
    }

    /** THE WRITE LAWS, pull-detected each composition: a changed base `position` on a
     *  dynamic/character body TELEPORTS it (velocity reset, no transition glide — the
     *  in-flight glide retires and the override shows the pose NOW); a changed base
     *  `velocity` sets it verbatim; a kinematic position write wakes every sleeping
     *  body (v1 — no island graph). Store writes and bus `set` writes both land on the
     *  resolved base plane this scans — never a second path. */
    fun noteBase(resolveBase: SceneResolve) {
        if (!sceneAnyPhysicsAuthored(ir.nodes)) {
            world = null
            signature = null
            return
        }
        ensureWorld(resolveBase)
        val w = world ?: return
        parentWorlds = null   // this scan resolves parents fresh too
        for (body in w.bodies) {
            val node = nodesById[body.id] ?: continue
            val cache = writeCache.getOrPut(node) { HashMap() }
            val pos = resolveBase(node, "position", node.attrs["position"] ?: "")
            val previousPos = cache.put("position", pos)
            val vel = resolveBase(node, "velocity", node.attrs["velocity"] ?: "")
            val previousVel = cache.put("velocity", vel)
            val rotation = resolveBase(node, "rotation", node.attrs["rotation"] ?: "")
            val previousRotation = cache.put("rotation", rotation)
            val angularVelocity = resolveBase(node, "angular-velocity", node.attrs["angular-velocity"] ?: "")
            val previousAngularVelocity = cache.put("angular-velocity", angularVelocity)
            val torque = resolveBase(node, "torque", node.attrs["torque"] ?: "")
            val previousTorque = cache.put("torque", torque)
            val forcedPos = forcedWrites.remove(node to "position")
            val forcedVel = forcedWrites.remove(node to "velocity")
            val forcedRotation = forcedWrites.remove(node to "rotation")
            val forcedAngularVelocity = forcedWrites.remove(node to "angular-velocity")
            val forcedTorque = forcedWrites.remove(node to "torque")
            if (body.kind == "static") continue
            if (body.kind == "kinematic") {
                if ((previousPos != null && (forcedPos || previousPos != pos)) ||
                    (previousRotation != null && (forcedRotation || previousRotation != rotation))
                ) scenePhysicsWakeAll(w)
                continue
            }
            if (previousPos != null && (forcedPos || previousPos != pos)) {
                parseSceneAnimValue("position", pos)?.let { p ->
                    // the authored/bus value is LOCAL to the parent; the solver speaks root
                    val parent = if (anyNestedBody) parentWorld(node, resolveBase) else null
                    scenePhysicsTeleport(w, body.id, scenePhysicsToRoot(p, parent))
                    animator.cancelTransition(node, "position", resolveBase)
                    animator.setOverride(node, "position", formatSceneAnimValue("position", p))
                }
            }
            if (previousVel != null && (forcedVel || previousVel != vel)) {
                parseSceneAnimValue("position", vel)?.let { v ->
                    scenePhysicsWriteVelocity(w, body.id, v)
                }
            }
            if (previousRotation != null && (forcedRotation || previousRotation != rotation)) {
                parseSceneAnimValue("rotation", rotation)?.let { r ->
                    val parent = if (anyNestedBody) parentWorld(node, resolveBase) else null
                    scenePhysicsTeleportRotation(
                        w, body.id, scenePhysicsRotationToRoot(r, parent, body.rotation),
                    )
                    animator.cancelTransition(node, "rotation", resolveBase)
                    animator.setOverride(node, "rotation", formatSceneAnimValue("rotation", r))
                }
            }
            if (previousAngularVelocity != null &&
                (forcedAngularVelocity || previousAngularVelocity != angularVelocity)
            ) {
                parseSceneAnimValue("position", angularVelocity)?.let { v ->
                    scenePhysicsWriteAngularVelocity(w, body.id, v)
                }
            }
            if (previousTorque != null && (forcedTorque || previousTorque != torque)) {
                parseSceneAnimValue("position", torque)?.let { v ->
                    scenePhysicsWriteTorque(w, body.id, v)
                }
            }
        }
    }

    /** THE LOOP-EXISTENCE LAW, EXTENDED (G2): the loop also runs while any dynamic body
     *  is AWAKE or any character exists — a fully-asleep world stops it (and on:tick) */
    fun wants(resolveBase: SceneResolve): Boolean {
        if (!sceneAnyPhysicsAuthored(ir.nodes)) return false
        ensureWorld(resolveBase)
        val w = world ?: return false
        for (body in w.bodies) {
            if (body.kind == "character") return true
            if (body.kind == "dynamic" && !body.sleeping) return true
        }
        return false
    }

    private fun moveIntent(node: SceneNode, resolve: SceneResolve): DoubleArray? {
        val resolved = resolve(node, "move", node.attrs["move"] ?: "").trim()
        if (resolved.isEmpty()) return null
        val parts = resolved.split(Regex("\\s+"))
        val x = parts.getOrNull(0)?.let(::sceneAttrDouble)
        val z = parts.getOrNull(1)?.let(::sceneAttrDouble)
        if (parts.size != 2 || x == null || !x.isFinite() || z == null || !z.isFinite()) {
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.MALFORMED_VECTOR,
                "move=\"$resolved\" is not 2 numbers — no intent",
            ))
            return null
        }
        return doubleArrayOf(x, z)
    }

    /** the loop's fixed-tick driver: accumulate the frame's dt (SECONDS), step 0..5
     *  times (the kernel cap), then write the INTERPOLATED solver-owned positions onto
     *  the animator's override plane. Kinematics follow the RESOLVED plane (store
     *  writes, bus set and animations all drive them); character intent reads the
     *  `move` attr the same way. The element dispatches the returned tick payloads and
     *  pair events through its ordinary runner path. */
    fun advance(frameSeconds: Double, resolve: SceneResolve, resolveBase: SceneResolve): ScenePhysicsFrame {
        parentWorlds = null   // parents may have animated since the last pass
        ensureWorld(resolveBase)
        val w = world ?: return ScenePhysicsFrame(emptyList(), changed = false)
        val advanceResult = accumulator.advance(frameSeconds)
        val ticks = ArrayList<ScenePhysicsStepResult>(advanceResult.steps)
        for (s in 0 until advanceResult.steps) {
            val intents = HashMap<String, ScenePhysicsIntent>()
            for (body in w.bodies) {
                val node = nodesById[body.id] ?: continue
                if (body.kind == "kinematic") {
                    val props = resolvedProps(node, resolve, diag)
                    val parent = if (anyNestedBody) parentWorld(node, resolve) else null
                    intents[body.id] = ScenePhysicsIntent(
                        position = scenePhysicsToRoot(props.position, parent),
                        rotation = scenePhysicsRotationToRoot(props.rotation, parent, body.rotation),
                    )
                } else if (body.kind == "character") {
                    moveIntent(node, resolve)?.let { intents[body.id] = ScenePhysicsIntent(move = it) }
                }
            }
            ticks.add(stepScenePhysicsWorld(w, intents))
        }
        var moved = false
        for (body in w.bodies) {
            if (body.kind != "dynamic" && body.kind != "character") continue
            val node = nodesById[body.id] ?: continue
            val rendered = scenePhysicsInterpolate(body.previous, body.position, advanceResult.alpha)
            val local = if (anyNestedBody) scenePhysicsToLocal(rendered, parentWorld(node, resolve)) else rendered
            animator.setOverride(node, "position", formatSceneAnimValue("position", local))
            if (body.kind == "dynamic") {
                val renderedRotation = scenePhysicsInterpolate(
                    body.previousRotation, body.rotation, advanceResult.alpha,
                )
                val priorLocal = resolvedProps(node, resolve, diag).rotation
                val localRotation = scenePhysicsRotationToLocal(
                    renderedRotation,
                    if (anyNestedBody) parentWorld(node, resolve) else null,
                    priorLocal,
                )
                animator.setOverride(node, "rotation", formatSceneAnimValue("rotation", localRotation))
            }
            if (body.kind == "character" || !body.sleeping) moved = true
        }
        return ScenePhysicsFrame(ticks, changed = ticks.isNotEmpty() || moved)
    }

    /** the event ids' way back to their nodes (the element's dispatch map) */
    fun nodeFor(id: String): SceneNode? = nodesById[id]

    /** the bus read: a body node's solver state, null when the node is not a body */
    fun info(node: SceneNode): ScenePhysicsNodeInfo? {
        val id = idsByNode[node] ?: return null
        val body = world?.byId?.get(id) ?: return null
        return ScenePhysicsNodeInfo(body.grounded, body.sleeping, body.velocity.copyOf())
    }
}
