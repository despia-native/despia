//
//  SceneCollide.kt - opt-in scene collisions, Kotlin twin of
//  OpenSource/Web/packages/kernel/src/scene/collide.ts (dsx-scene.md P5), corpus
//  OpenSource/Conformance/scene/collide.json. `collide="sphere"` (bounding sphere —
//  the picking sphere law) or `collide="box"` (world AABB) opts a node in; the scene
//  tests pairs among opted-in nodes after each rendered frame ONLY while at least one
//  `on:collide` handler is authored (the zero-cost static law: nothing moves without a
//  render, so the pass rides the render, never its own loop). Payload {id, other,
//  depth}. THE ENTER LAW: on:collide fires when a pair STARTS overlapping and fires
//  again only after the pair has fully separated (touch with depth 0 is NOT a
//  contact). All math is platform-neutral and corpus-pinned; [SceneCollisionPass] is
//  the render-riding fold BOTH JVM `<scene>` elements share (the SceneRaster stance).
//

package despia.engine.scene

import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

sealed class SceneColliderShape {
    abstract val id: String
    class Sphere(override val id: String, val center: Vec3, val radius: Double) : SceneColliderShape()
    class Box(override val id: String, val min: Vec3, val max: Vec3) : SceneColliderShape()
}

class SceneAabb(val min: Vec3, val max: Vec3)

/** the world AABB of a node's local extents: the 8 corners of [−half, +half]
 *  transformed by the world matrix, folded to min/max */
fun worldAabb(world: Mat4, half: Vec3): SceneAabb {
    val min = doubleArrayOf(Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY)
    val max = doubleArrayOf(Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY)
    for (i in 0 until 8) {
        val lx = if (i and 1 == 0) -half[0] else half[0]
        val ly = if (i and 2 == 0) -half[1] else half[1]
        val lz = if (i and 4 == 0) -half[2] else half[2]
        val x = world[0] * lx + world[4] * ly + world[8] * lz + world[12]
        val y = world[1] * lx + world[5] * ly + world[9] * lz + world[13]
        val z = world[2] * lx + world[6] * ly + world[10] * lz + world[14]
        if (x < min[0]) min[0] = x
        if (x > max[0]) max[0] = x
        if (y < min[1]) min[1] = y
        if (y > max[1]) max[1] = y
        if (z < min[2]) min[2] = z
        if (z > max[2]) max[2] = z
    }
    return SceneAabb(min, max)
}

private fun distance3(ax: Double, ay: Double, az: Double, bx: Double, by: Double, bz: Double): Double {
    val dx = ax - bx
    val dy = ay - by
    val dz = az - bz
    return sqrt(dx * dx + dy * dy + dz * dz)
}

/** THE DEPTH LAWS (pinned):
 *  - sphere↔sphere: depth = rₐ + r_b − |cₐ − c_b|.
 *  - box↔box: overlap per axis oᵢ = min(maxₐᵢ, max_bᵢ) − max(minₐᵢ, min_bᵢ); a contact
 *    needs every oᵢ > 0; depth = min(o₀, o₁, o₂).
 *  - sphere↔box: q = the box point nearest the center (componentwise clamp);
 *    outside (|c − q| > 0): depth = r − |c − q|; center INSIDE the box: depth =
 *    r + min over axes of the distance from the center to its nearest face.
 *  A pair overlaps only when depth > 0 — exact touch is NOT a contact. */
fun collidePair(a: SceneColliderShape, b: SceneColliderShape): Double? {
    if (a is SceneColliderShape.Sphere && b is SceneColliderShape.Sphere) {
        val depth = a.radius + b.radius - distance3(
            a.center[0], a.center[1], a.center[2], b.center[0], b.center[1], b.center[2],
        )
        return if (depth > 0.0) depth else null
    }
    if (a is SceneColliderShape.Box && b is SceneColliderShape.Box) {
        var depth = Double.POSITIVE_INFINITY
        for (i in 0 until 3) {
            val overlap = min(a.max[i], b.max[i]) - max(a.min[i], b.min[i])
            if (overlap <= 0.0) return null
            if (overlap < depth) depth = overlap
        }
        return depth
    }
    val sphere = (if (a is SceneColliderShape.Sphere) a else b) as SceneColliderShape.Sphere
    val box = (if (a is SceneColliderShape.Box) a else b) as SceneColliderShape.Box
    val q = DoubleArray(3) { i -> min(max(sphere.center[i], box.min[i]), box.max[i]) }
    val dist = distance3(sphere.center[0], sphere.center[1], sphere.center[2], q[0], q[1], q[2])
    if (dist > 0.0) {
        val depth = sphere.radius - dist
        return if (depth > 0.0) depth else null
    }
    var inside = Double.POSITIVE_INFINITY
    for (i in 0 until 3) {
        val toFace = min(sphere.center[i] - box.min[i], box.max[i] - sphere.center[i])
        if (toFace < inside) inside = toFace
    }
    return sphere.radius + inside
}

/** a node's collider under its collide= word: "sphere" = the node's bounding sphere
 *  (the picking-sphere law verbatim); "box" = the world AABB of the node's local half
 *  extents (box: size/2 · sphere: radius · plane: [w/2, h/2, 0]). null = not a
 *  collider (no collide word, or a non-geometry node). `id` is the caller's tracker
 *  identity (unique per node — the renderer's job). */
fun sceneColliderFor(
    node: SceneNode, props: SceneNodeProps, world: Mat4, id: String,
): SceneColliderShape? {
    if (props.collide == "sphere") {
        val local = nodeBoundingRadius(node, props) ?: return null
        val sphere = worldBoundingSphere(world, local)
        return SceneColliderShape.Sphere(id, sphere.center, sphere.radius)
    }
    if (props.collide == "box") {
        val half: Vec3 = when (node.kind) {
            SceneNodeKind.BOX -> doubleArrayOf(props.boxSize[0] / 2.0, props.boxSize[1] / 2.0, props.boxSize[2] / 2.0)
            SceneNodeKind.SPHERE -> doubleArrayOf(props.radius, props.radius, props.radius)
            SceneNodeKind.PLANE -> doubleArrayOf(props.planeSize[0] / 2.0, props.planeSize[1] / 2.0, 0.0)
            else -> return null
        }
        val aabb = worldAabb(world, half)
        return SceneColliderShape.Box(id, aabb.min, aabb.max)
    }
    return null
}

class SceneContact(val a: String, val b: String, val depth: Double)

/** every overlapping pair among the shapes, document order (i < j) */
fun sceneContacts(shapes: List<SceneColliderShape>): List<SceneContact> {
    val out = ArrayList<SceneContact>()
    for (i in shapes.indices) {
        for (j in i + 1 until shapes.size) {
            val depth = collidePair(shapes[i], shapes[j]) ?: continue
            out.add(SceneContact(shapes[i].id, shapes[j].id, depth))
        }
    }
    return out
}

class SceneCollisionEvent(val id: String, val other: String, val depth: Double)

/** THE ENTER-ONLY FOLD: a pair fires on overlap START and re-arms only once the pair
 *  is no longer overlapping. Pair identity is the id pair — the renderer feeds unique
 *  per-node ids. Pure state machine, corpus-pinned as frame data. Feed one frame's
 *  shapes; the ENTER events this frame (both directions per new contact: {id: a,
 *  other: b} and {id: b, other: a}), in contact order. */
class SceneCollisionTracker {
    private val overlapping = HashSet<String>()

    fun step(shapes: List<SceneColliderShape>): List<SceneCollisionEvent> {
        val events = ArrayList<SceneCollisionEvent>()
        val current = HashSet<String>()
        for (contact in sceneContacts(shapes)) {
            val key = "${contact.a} ${contact.b}"
            current.add(key)
            if (key !in overlapping) {
                events.add(SceneCollisionEvent(contact.a, contact.b, contact.depth))
                events.add(SceneCollisionEvent(contact.b, contact.a, contact.depth))
            }
        }
        overlapping.clear()
        overlapping.addAll(current)
        return events
    }
}

// ── the render-riding pass (both JVM `<scene>` elements) ─────────────────────────────

/** true when any node in the tree authors an `on:collide` handler — the pass's gate
 *  (the zero-cost static law: no handler, no pass) */
fun sceneAnyCollideHandler(nodes: List<SceneNode>): Boolean {
    for (node in nodes) {
        if (node.source?.attrs?.get("on:collide")?.isNotBlank() == true) return true
        if (sceneAnyCollideHandler(node.children)) return true
    }
    return false
}

/**
 * The per-frame collision fold BOTH JVM elements run after a rendered frame: collect
 * opted-in colliders from the resolved world matrices (tracker identity is a per-node
 * serial — authored ids may repeat or be absent), step the enter-only tracker, and
 * hand back the ENTER events with their nodes so the element can dispatch each node's
 * `on:collide` through the ordinary runner path with the {id, other, depth} payload.
 */
class SceneCollisionPass {
    class Hit(val node: SceneNode, val otherNode: SceneNode?, val depth: Double)

    private val tracker = SceneCollisionTracker()
    private val ids = HashMap<SceneNode, String>()
    private var serial = 0

    private fun trackerIdFor(node: SceneNode): String =
        ids.getOrPut(node) { "n${++serial}" }

    fun step(ir: SceneIR, resolve: SceneResolve, diag: SceneDiag? = null): List<Hit> {
        val shapes = ArrayList<SceneColliderShape>()
        val byTrackerId = HashMap<String, SceneNode>()
        for ((node, world) in worldMatrices(ir.nodes, resolve, diag)) {
            val props = resolvedProps(node, resolve, diag)
            if (props.collide.isEmpty()) continue
            val id = trackerIdFor(node)
            val shape = sceneColliderFor(node, props, world, id) ?: continue
            shapes.add(shape)
            byTrackerId[id] = node
        }
        return tracker.step(shapes).mapNotNull { event ->
            val node = byTrackerId[event.id] ?: return@mapNotNull null
            Hit(node, byTrackerId[event.other], event.depth)
        }
    }
}
