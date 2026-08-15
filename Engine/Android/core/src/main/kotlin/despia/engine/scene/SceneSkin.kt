//
//  SceneSkin.kt - the DSX Scene G3 skeletal kernel, Kotlin twin of the web kernel's
//  scene/skin.ts (dsx-game.md §2 G3): pure JVM, zero dependencies, corpus-pinned
//  (OpenSource/Conformance/scene/skin.json — every law in the file's _note and the
//  corpus README "The G3 laws"). The laws, verbatim from the reference:
//
//  - THE JOINT-MATRIX LAW: jointMatrix[i] = inverse(meshNodeWorld) ·
//    globalJointTransform[i] · inverseBindMatrix[i]; node worlds compose over the FULL
//    retained node forest (parent = the unique referencing node); a singular mesh
//    world inverts to identity (failure is a value, Article 7).
//  - THE SKINNING LAW: skinnedPos = Σ w[i] · jointMatrix[i] · pos; weights renormalize
//    when their sum ≠ 1; a sum ≤ SCENE_SKIN_WEIGHT_EPSILON passes the vertex through.
//  - THE CLIP-SAMPLING LAW: loop wraps modulo duration, non-loop clamps; interval
//    search; LINEAR lerp for t/s, shortest-path slerp for rotation (dot-sign flip,
//    nlerp past SCENE_SLERP_NLERP_THRESHOLD); STEP holds the left key.
//  - THE CROSSFADE LAW: progress = clamp(elapsedMs/blendMs, 0, 1) (blendMs ≤ 0 = hard
//    cut); blended pose lerps t/s + slerps r per node over the union of both poses.
//  - THE MIXER: initial clip = no fade; a switch crossfades from the out-clip's
//    continuing clock; mid-fade switch drops the older fade; unknown clip name →
//    `unknown-clip` diagnostic + keep; "" = the bind pose; `active` is the
//    loop-existence read.
//

package despia.engine.scene

import kotlin.math.acos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

// ── the pinned constants (corpus `constants` — the runner asserts these) ─────────────

/** weights whose sum is within this of 0 pass the vertex through; otherwise ≠1 renormalizes */
const val SCENE_SKIN_WEIGHT_EPSILON = 1e-6

/** quaternion dot beyond this uses normalized lerp (the numerically-safe near-parallel branch) */
const val SCENE_SLERP_NLERP_THRESHOLD = 0.9995

/** `<model blend>` default: 0 ms = the hard cut */
const val SCENE_CLIP_DEFAULT_BLEND_MS = 0.0

/** `<model loop>` default: clips loop */
const val SCENE_CLIP_DEFAULT_LOOP = true

/** one node's animated local transform — absent channels fall back to the base TRS */
class GlbTrsOverride(var t: Vec3? = null, var r: DoubleArray? = null, var s: Vec3? = null)

/** a sampled pose: node index → animated channels. The EMPTY map is the bind pose. */
typealias GlbPose = LinkedHashMap<Int, GlbTrsOverride>

// ── quaternions ──────────────────────────────────────────────────────────────────────

/** spherical linear interpolation, shortest path: a negative dot flips b; a dot past
 *  SCENE_SLERP_NLERP_THRESHOLD lerps + normalizes (the near-parallel branch) */
fun quatSlerp(a: DoubleArray, b: DoubleArray, t: Double): DoubleArray {
    var dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
    var bx = b[0]; var by = b[1]; var bz = b[2]; var bw = b[3]
    if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot }
    if (dot > SCENE_SLERP_NLERP_THRESHOLD) {
        val out = doubleArrayOf(
            a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t,
            a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t,
        )
        val length = sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3])
        return if (length > 0) doubleArrayOf(out[0] / length, out[1] / length, out[2] / length, out[3] / length)
        else doubleArrayOf(0.0, 0.0, 0.0, 1.0)
    }
    val theta = acos(min(dot, 1.0))
    val sinTheta = sin(theta)
    val wa = sin((1 - t) * theta) / sinTheta
    val wb = sin(t * theta) / sinTheta
    return doubleArrayOf(
        wa * a[0] + wb * bx, wa * a[1] + wb * by,
        wa * a[2] + wb * bz, wa * a[3] + wb * bw,
    )
}

// ── node worlds under a pose ─────────────────────────────────────────────────────────

/** one node's local matrix: pose channels override base TRS per property; a
 *  matrix-authored node with no pose entry uses its matrix verbatim */
fun glbLocalMatrix(node: GlbNode, pose: GlbTrsOverride? = null): Mat4 {
    val matrix = node.matrix
    if (matrix != null && pose == null) return matrix
    val t = pose?.t ?: node.translation
    val r = pose?.r ?: node.rotation
    val s = pose?.s ?: node.scale
    val translate = mat4Translation(t[0], t[1], t[2])
    val scale = mat4Scaling(s[0], s[1], s[2])
    return mat4Multiply(mat4Multiply(translate, quaternionToMat4(r[0], r[1], r[2], r[3])), scale)
}

/** every node's world transform over the FULL node forest (roots = nodes no children
 *  list references), pose-aware — the hierarchy leg of the joint-matrix law */
fun glbNodeWorlds(model: GlbModel, pose: GlbPose? = null): List<Mat4> {
    val count = model.nodes.size
    val parent = IntArray(count) { -1 }
    for (i in 0 until count) {
        for (child in model.nodes[i].children) {
            if (child in 0 until count) parent[child] = i
        }
    }
    val worlds = arrayOfNulls<Mat4>(count)
    fun world(index: Int, depth: Int): Mat4 {
        worlds[index]?.let { return it }
        val local = glbLocalMatrix(model.nodes[index], pose?.get(index))
        val out = if (depth > 64 || parent[index] == -1) local
        else mat4Multiply(world(parent[index], depth + 1), local)
        worlds[index] = out
        return out
    }
    for (i in 0 until count) world(i, 0)
    return worlds.map { it ?: mat4Identity() }
}

/** THE JOINT-MATRIX LAW: inverse(meshNodeWorld) · jointWorld · inverseBindMatrix,
 *  per skin joint. A singular mesh world inverts to identity (failure is a value). */
fun glbJointMatrices(model: GlbModel, skinIndex: Int, meshNode: Int, worlds: List<Mat4>): List<Mat4> {
    val skin = model.skins.getOrNull(skinIndex) ?: return emptyList()
    val meshWorld = worlds.getOrNull(meshNode) ?: mat4Identity()
    val inverseMesh = mat4Invert(meshWorld) ?: mat4Identity()
    return skin.joints.mapIndexed { i, joint ->
        val jointWorld = worlds.getOrNull(joint) ?: mat4Identity()
        val ibm = skin.inverseBindMatrices.getOrNull(i) ?: mat4Identity()
        mat4Multiply(mat4Multiply(inverseMesh, jointWorld), ibm)
    }
}

// ── vertex skinning ──────────────────────────────────────────────────────────────────

/** THE SKINNING LAW for one vertex: Σ w[i] · jointMatrix[i] · pos, weights renormalized
 *  when their sum ≠ 1; a sum ≤ SCENE_SKIN_WEIGHT_EPSILON passes the vertex through */
fun skinPosition(position: Vec3, joints: IntArray, weights: DoubleArray, matrices: List<Mat4>): Vec3 {
    val sum = weights[0] + weights[1] + weights[2] + weights[3]
    if (sum <= SCENE_SKIN_WEIGHT_EPSILON) return doubleArrayOf(position[0], position[1], position[2])
    val out = doubleArrayOf(0.0, 0.0, 0.0)
    for (i in 0 until 4) {
        val w = weights[i] / sum
        if (w == 0.0) continue
        val m = matrices.getOrNull(joints[i]) ?: continue
        out[0] += w * (m[0] * position[0] + m[4] * position[1] + m[8] * position[2] + m[12])
        out[1] += w * (m[1] * position[0] + m[5] * position[1] + m[9] * position[2] + m[13])
        out[2] += w * (m[2] * position[0] + m[6] * position[1] + m[10] * position[2] + m[14])
    }
    return out
}

/** a whole primitive's skinned positions (flat triples); null when the primitive
 *  carries no JOINTS_0/WEIGHTS_0 (unskinned — draw the authored positions) */
fun skinnedPrimitivePositions(primitive: GlbPrimitive, matrices: List<Mat4>): DoubleArray? {
    val vertexCount = primitive.positions.size / 3
    if (primitive.joints.size < vertexCount * 4 || primitive.weights.size < vertexCount * 4) return null
    val out = DoubleArray(primitive.positions.size)
    for (v in 0 until vertexCount) {
        val skinned = skinPosition(
            doubleArrayOf(primitive.positions[v * 3], primitive.positions[v * 3 + 1], primitive.positions[v * 3 + 2]),
            primitive.joints.copyOfRange(v * 4, v * 4 + 4),
            primitive.weights.copyOfRange(v * 4, v * 4 + 4),
            matrices,
        )
        out[v * 3] = skinned[0]
        out[v * 3 + 1] = skinned[1]
        out[v * 3 + 2] = skinned[2]
    }
    return out
}

// ── clip sampling ────────────────────────────────────────────────────────────────────

/** THE CLIP-TIME LAW: loop wraps modulo duration, non-loop clamps to [0, duration];
 *  a non-positive duration is always 0 */
fun glbClipTime(time: Double, duration: Double, loop: Boolean): Double {
    if (duration <= 0) return 0.0
    if (loop) return time - floor(time / duration) * duration
    return min(max(time, 0.0), duration)
}

/** THE CHANNEL-SAMPLING LAW: interval search + LINEAR lerp (slerp for rotation) or
 *  STEP left-hold; clamped to the first/last key outside the key range */
fun sampleGlbChannel(channel: GlbChannel, time: Double): DoubleArray {
    val components = if (channel.path == "rotation") 4 else 3
    val times = channel.times
    val values = channel.values
    val count = times.size
    if (count == 0) return DoubleArray(components)
    if (time <= times[0]) return values.copyOfRange(0, components)
    if (time >= times[count - 1]) return values.copyOfRange((count - 1) * components, count * components)
    var k = 0
    while (k + 1 < count && times[k + 1] <= time) k += 1
    val a = values.copyOfRange(k * components, (k + 1) * components)
    if (channel.interpolation == "STEP") return a
    val b = values.copyOfRange((k + 1) * components, (k + 2) * components)
    val u = (time - times[k]) / (times[k + 1] - times[k])
    if (channel.path == "rotation") return quatSlerp(a, b, u)
    return DoubleArray(components) { a[it] + (b[it] - a[it]) * u }
}

/** sample a whole clip at a wrapped/clamped time (seconds) into a pose */
fun sampleGlbClip(model: GlbModel, clip: GlbClip, time: Double, loop: Boolean): GlbPose {
    val wrapped = glbClipTime(time, clip.duration, loop)
    val pose = GlbPose()
    for (channel in clip.channels) {
        if (channel.node < 0 || channel.node >= model.nodes.size) continue
        val value = sampleGlbChannel(channel, wrapped)
        val entry = pose.getOrPut(channel.node) { GlbTrsOverride() }
        when (channel.path) {
            "translation" -> entry.t = doubleArrayOf(value[0], value[1], value[2])
            "scale" -> entry.s = doubleArrayOf(value[0], value[1], value[2])
            else -> entry.r = doubleArrayOf(value[0], value[1], value[2], value[3])
        }
    }
    return pose
}

fun findGlbClip(model: GlbModel, name: String): GlbClip? =
    model.clips.firstOrNull { it.name == name }

// ── crossfade ────────────────────────────────────────────────────────────────────────

/** THE RAMP LAW: clamp(elapsedMs / blendMs, 0, 1); blendMs ≤ 0 is the hard cut (1) */
fun sceneCrossfadeProgress(elapsedMs: Double, blendMs: Double): Double {
    if (blendMs <= 0) return 1.0
    return min(max(elapsedMs / blendMs, 0.0), 1.0)
}

class GlbTrs(val t: Vec3, val r: DoubleArray, val s: Vec3)

/** a node's effective TRS under a pose (pose channel ?? base) */
fun glbEffectiveTrs(node: GlbNode, pose: GlbTrsOverride? = null): GlbTrs = GlbTrs(
    (pose?.t ?: node.translation).copyOf(),
    (pose?.r ?: node.rotation).copyOf(),
    (pose?.s ?: node.scale).copyOf(),
)

/** THE BLEND LAW for one node: t/s componentwise lerp, r shortest-path slerp */
fun blendGlbTrs(from: GlbTrs, to: GlbTrs, progress: Double): GlbTrs {
    fun lerp3(a: Vec3, b: Vec3): Vec3 = doubleArrayOf(
        a[0] + (b[0] - a[0]) * progress, a[1] + (b[1] - a[1]) * progress, a[2] + (b[2] - a[2]) * progress,
    )
    return GlbTrs(lerp3(from.t, to.t), quatSlerp(from.r, to.r, progress), lerp3(from.s, to.s))
}

/** blend two poses over the union of their nodes — a missing side reads base TRS */
fun blendGlbPoses(model: GlbModel, from: GlbPose, to: GlbPose, progress: Double): GlbPose {
    val out = GlbPose()
    val indices = LinkedHashSet<Int>().apply { addAll(from.keys); addAll(to.keys) }
    for (index in indices) {
        val node = model.nodes.getOrNull(index) ?: continue
        val blended = blendGlbTrs(
            glbEffectiveTrs(node, from[index]),
            glbEffectiveTrs(node, to[index]),
            progress,
        )
        out[index] = GlbTrsOverride(blended.t, blended.r, blended.s)
    }
    return out
}

// ── the mixer (the crossfade state machine every renderer drives) ────────────────────

/** the crossfade state machine — the web reference's createSceneClipMixer verbatim */
class SceneClipMixer(private val model: GlbModel, private val diag: SceneDiag? = null) {
    private var currentName: String? = null    // null = never assigned
    private var currentClip: GlbClip? = null   // null = bind pose
    private var currentStartMs = 0.0
    private var fading = false
    private var previousClip: GlbClip? = null  // the out-clip (null = bind) while fading
    private var previousStartMs = 0.0
    private var fadeStartMs = 0.0
    private var fadeBlendMs = 0.0
    private var loop = SCENE_CLIP_DEFAULT_LOOP

    private fun poseOf(clip: GlbClip?, startMs: Double, nowMs: Double): GlbPose =
        if (clip == null) GlbPose() else sampleGlbClip(model, clip, (nowMs - startMs) / 1000.0, loop)

    /** feed the resolved `animation`/`loop`/`blend` props each frame; a NAME CHANGE is
     *  the switch (unknown name → `unknown-clip` diagnostic + keep; "" → bind pose) */
    fun update(name: String, loopFlag: Boolean, blendMs: Double, nowMs: Double) {
        loop = loopFlag
        if (name == currentName) return
        val clip = if (name.isEmpty()) null else findGlbClip(model, name)
        if (name.isNotEmpty() && clip == null) {
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.UNKNOWN_CLIP,
                "animation=\"$name\" is not a clip in this model — keeping the current clip",
            ))
            return
        }
        if (currentName == null) {
            // the initial assignment applies WITHOUT a crossfade (the mount law)
            currentName = name
            currentClip = clip
            currentStartMs = nowMs
            return
        }
        if (blendMs > 0) {
            // one crossfade at a time: a mid-fade switch drops the older fade — the
            // out-clip is the clip that WAS current, on its continuing clock
            fading = true
            previousClip = currentClip
            previousStartMs = currentStartMs
            fadeStartMs = nowMs
            fadeBlendMs = blendMs
        } else {
            fading = false
            previousClip = null
        }
        currentName = name
        currentClip = clip
        currentStartMs = nowMs
    }

    /** the pose at nowMs — the empty map is the bind pose */
    fun pose(nowMs: Double): GlbPose {
        val current = poseOf(currentClip, currentStartMs, nowMs)
        if (!fading) return current
        val progress = sceneCrossfadeProgress(nowMs - fadeStartMs, fadeBlendMs)
        if (progress >= 1) {
            fading = false
            previousClip = null
            return current
        }
        return blendGlbPoses(model, poseOf(previousClip, previousStartMs, nowMs), current, progress)
    }

    /** the loop-existence read: a fade in flight, a looping clip, or an unfinished
     *  non-looping clip (a finished non-loop clip with no fade lets the loop stop) */
    fun active(nowMs: Double): Boolean {
        if (fading && sceneCrossfadeProgress(nowMs - fadeStartMs, fadeBlendMs) < 1) return true
        val clip = currentClip ?: return false
        if (clip.duration <= 0) return false
        if (loop) return true
        return (nowMs - currentStartMs) / 1000.0 < clip.duration
    }
}

// ── the per-element mixer bundle (shared by BOTH JVM surfaces — the SceneAnimator
// stance): one SceneClipMixer per `<model animation>` node, advanced from the raster
// path each sampled frame; `wantsTick` is the loop-existence read ─────────────────────

class SceneClipMixers(private val diag: SceneDiag? = null) {
    private val mixers = HashMap<SceneNode, SceneClipMixer>()
    private val models = HashMap<SceneNode, GlbModel>()
    private val poses = HashMap<SceneNode, GlbPose>()
    private var lastNowMs = 0.0

    /** advance every `<model animation>` node's mixer at nowMs (a src change or a
     *  reloaded model recreates its mixer); true = at least one pose is live */
    fun advance(ir: SceneIR, resolve: SceneResolve, model: (String) -> GlbModel?, nowMs: Double): Boolean {
        lastNowMs = nowMs
        val seen = HashSet<SceneNode>()
        fun walk(nodes: List<SceneNode>) {
            for (node in nodes) {
                if (node.kind == SceneNodeKind.MODEL && node.attrs.containsKey("animation")) {
                    seen.add(node)
                    val props = resolvedProps(node, resolve, diag)
                    val glb = if (props.src.isEmpty()) null else model(props.src)
                    if (glb == null) {
                        mixers.remove(node); models.remove(node); poses.remove(node)
                    } else {
                        if (models[node] !== glb) { mixers.remove(node); models[node] = glb }
                        val mixer = mixers.getOrPut(node) { SceneClipMixer(glb, diag) }
                        mixer.update(props.animation, props.clipLoop, props.blendMs, nowMs)
                        poses[node] = mixer.pose(nowMs)
                    }
                }
                walk(node.children)
            }
        }
        walk(ir.nodes)
        mixers.keys.retainAll(seen)
        models.keys.retainAll(seen)
        poses.keys.retainAll(seen)
        return poses.isNotEmpty()
    }

    /** the SceneAssets.pose seam answer for one model node */
    fun pose(node: SceneNode): GlbPose? = poses[node]

    /** the loop-existence extension (G3): any mixer with an active clip or crossfade
     *  keeps the loop; a finished non-looping clip with no crossfade lets it stop */
    fun wantsTick(): Boolean = mixers.values.any { it.active(lastNowMs) }
}
