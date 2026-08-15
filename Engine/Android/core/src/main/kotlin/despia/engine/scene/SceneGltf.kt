//
//  SceneGltf.kt - the DSX Scene GLB/glTF parser, Kotlin twin of
//  OpenSource/Web/packages/kernel/src/scene/gltf.ts (dsx-scene.md P4): pure JVM, zero
//  dependencies, platform-neutral (no android.*, no network — the caller supplies
//  bytes; the JSON chunk parses through this runtime's own `json(...)` reader, never a
//  second parser). The law lives in OpenSource/Conformance/scene/model.json +
//  README.md: glTF 2.0 BINARY containers, EMBEDDED buffers only (a buffer with a `uri`
//  is the NAMED absence, error "external-buffer"), POSITION/NORMAL f32 VEC3, u8/u16/u32
//  indices (non-indexed synthesizes 0..n-1), pbrMetallicRoughness.baseColorFactor
//  (default [1,1,1,1]), triangle mode only; the draw list flattens the default scene's
//  node hierarchy (matrix, or T · R(quaternion) · S). Failure is a VALUE (Article 7):
//  a broken container parses to an error code — never a throw.
//
//  G3 (dsx-game.md §2 — corpus OpenSource/Conformance/scene/skin.json): the parse also
//  retains the NODE FOREST (base TRS + matrix + children + mesh/skin references — clip
//  sampling recomposes the hierarchy), `skins` (joints + inverseBindMatrices; absent
//  IBMs are identity), `animations` as NAMED CLIPS (translation/rotation/scale channels,
//  LINEAR + STEP; a CUBICSPLINE or weights/morph channel DROPS — the named absence —
//  and duration folds over the KEPT channels only; an unnamed clip is named by its
//  zero-based index), and JOINTS_0/WEIGHTS_0 vertex attributes (u8/u16 joints read raw;
//  integer-typed WEIGHTS_0 normalizes by 255/65535 — the glTF normalized law). The
//  skinning/sampling/crossfade math lives in SceneSkin.kt.
//

package despia.engine.scene

import despia.engine.json
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.hypot

class GlbPrimitive(
    /** flat xyz triples */
    val positions: DoubleArray,
    /** flat xyz triples; empty when the primitive authors no NORMAL (flat-shade fallback) */
    val normals: DoubleArray,
    val indices: IntArray,
    /** pbrMetallicRoughness.baseColorFactor rgba, default [1, 1, 1, 1] */
    val baseColor: DoubleArray,
    /** G3: flat JOINTS_0 4-tuples (empty when unskinned) — u8/u16 read raw */
    val joints: IntArray = IntArray(0),
    /** G3: flat WEIGHTS_0 4-tuples (empty when unskinned) — integer types normalized */
    val weights: DoubleArray = DoubleArray(0),
)

class GlbMesh(val primitives: List<GlbPrimitive>)

/** one node-referenced mesh instance: world = the node's hierarchy-composed matrix;
 *  G3 adds the referencing node index + its skin (null = unskinned) */
class GlbDraw(val mesh: Int, val world: Mat4, val node: Int = 0, val skin: Int? = null)

/** G3: one retained glTF node — clip sampling recomposes the hierarchy from these */
class GlbNode(
    val translation: Vec3,
    /** unit-ish quaternion (x, y, z, w) */
    val rotation: DoubleArray,
    val scale: Vec3,
    /** a matrix-authored node (glTF forbids animating these); null = TRS-authored */
    val matrix: Mat4?,
    val children: IntArray,
    val mesh: Int?,
    val skin: Int?,
)

/** G3: joints (node indices) + inverse bind matrices (identity when unauthored) */
class GlbSkin(val joints: IntArray, val inverseBindMatrices: List<Mat4>)

class GlbChannel(
    val node: Int,
    /** translation · rotation · scale */
    val path: String,
    /** LINEAR · STEP (CUBICSPLINE dropped at parse — the named absence) */
    val interpolation: String,
    /** key times, seconds, ascending */
    val times: DoubleArray,
    /** flat values — 3 per key (translation/scale) or 4 (rotation quaternions) */
    val values: DoubleArray,
)

/** G3: a named clip — `<model animation="name">` selects by this name */
class GlbClip(
    val name: String,
    /** max key time over the KEPT channels, seconds */
    val duration: Double,
    val channels: List<GlbChannel>,
)

class GlbModel(
    val meshes: List<GlbMesh>,
    val draws: List<GlbDraw>,
    val nodes: List<GlbNode> = emptyList(),
    val skins: List<GlbSkin> = emptyList(),
    val clips: List<GlbClip> = emptyList(),
)

enum class GlbError(val code: String) {
    NOT_GLB("not-glb"), EXTERNAL_BUFFER("external-buffer"), MALFORMED("malformed")
}

/** the discriminated result — exactly one of model/error is set (failure is a value) */
class GlbParseResult private constructor(val model: GlbModel?, val error: GlbError?) {
    companion object {
        fun ok(model: GlbModel) = GlbParseResult(model, null)
        fun fail(error: GlbError) = GlbParseResult(null, error)
    }
}

private const val GLB_MAGIC = 0x46546C67
private const val CHUNK_JSON = 0x4E4F534A
private const val CHUNK_BIN = 0x004E4942

private const val COMPONENT_F32 = 5126
private const val COMPONENT_U8 = 5121
private const val COMPONENT_U16 = 5123
private const val COMPONENT_U32 = 5125
private const val MODE_TRIANGLES = 4

@Suppress("UNCHECKED_CAST")
private fun dict(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>

private fun list(value: Any?): List<Any?>? = value as? List<Any?>

private fun int(value: Any?): Int? = (value as? Number)?.let {
    val d = it.toDouble()
    if (d >= 0 && d == Math.floor(d) && d <= Int.MAX_VALUE.toDouble()) d.toInt() else null
}

private fun finiteDouble(value: Any?): Double? =
    (value as? Number)?.toDouble()?.takeIf { it.isFinite() }

/** a unit-ish glTF quaternion (x, y, z, w) → column-major rotation mat4 */
fun quaternionToMat4(x: Double, y: Double, z: Double, w: Double): Mat4 {
    val length = Math.sqrt(x * x + y * y + z * z + w * w)
    if (length < 1e-12) return mat4Identity()
    val qx = x / length; val qy = y / length; val qz = z / length; val qw = w / length
    return doubleArrayOf(
        1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw), 0.0,
        2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw), 0.0,
        2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy), 0.0,
        0.0, 0.0, 0.0, 1.0,
    )
}

private fun nodeLocalMatrix(node: Map<String, Any?>): Mat4? {
    list(node["matrix"])?.let { matrix ->
        if (matrix.size != 16) return null
        val out = DoubleArray(16)
        for (i in 0 until 16) out[i] = finiteDouble(matrix[i]) ?: return null
        return out
    }
    fun triple(name: String, fallback: DoubleArray): DoubleArray? {
        val raw = list(node[name]) ?: return fallback
        if (raw.size != 3) return null
        val out = DoubleArray(3)
        for (i in 0 until 3) out[i] = finiteDouble(raw[i]) ?: return null
        return out
    }
    val translation = triple("translation", doubleArrayOf(0.0, 0.0, 0.0)) ?: return null
    val scale = triple("scale", doubleArrayOf(1.0, 1.0, 1.0)) ?: return null
    var rotation = mat4Identity()
    list(node["rotation"])?.let { quat ->
        if (quat.size != 4) return null
        val q = DoubleArray(4)
        for (i in 0 until 4) q[i] = finiteDouble(quat[i]) ?: return null
        rotation = quaternionToMat4(q[0], q[1], q[2], q[3])
    }
    val t = mat4Translation(translation[0], translation[1], translation[2])
    val s = mat4Scaling(scale[0], scale[1], scale[2])
    return mat4Multiply(mat4Multiply(t, rotation), s)
}

private fun makeAccessorReader(
    doc: Map<String, Any?>, bin: ByteBuffer?,
): (accessorIndex: Int, componentCount: Int, normalizeInts: Boolean) -> DoubleArray? {
    val accessors = list(doc["accessors"]) ?: emptyList()
    val views = list(doc["bufferViews"]) ?: emptyList()
    return reader@{ accessorIndex, componentCount, normalizeInts ->
        val accessor = dict(accessors.getOrNull(accessorIndex)) ?: return@reader null
        if (bin == null) return@reader null
        if (accessor.containsKey("sparse")) return@reader null      // named absence
        val viewIndex = int(accessor["bufferView"]) ?: return@reader null
        val count = int(accessor["count"]) ?: return@reader null
        val componentType = int(accessor["componentType"]) ?: return@reader null
        val view = dict(views.getOrNull(viewIndex)) ?: return@reader null
        val viewOffset = int(view["byteOffset"]) ?: 0
        val accessorOffset = int(accessor["byteOffset"]) ?: 0
        val stride = int(view["byteStride"]) ?: 0
        val componentBytes = when (componentType) {
            COMPONENT_F32, COMPONENT_U32 -> 4
            COMPONENT_U16 -> 2
            COMPONENT_U8 -> 1
            else -> return@reader null
        }
        // the G3 normalized law: integer-typed WEIGHTS_0 components divide by 255/65535
        val divisor = when {
            normalizeInts && componentType == COMPONENT_U8 -> 255.0
            normalizeInts && componentType == COMPONENT_U16 -> 65535.0
            else -> 1.0
        }
        val elementBytes = componentBytes * componentCount
        val step = if (stride > 0) stride else elementBytes
        val base = viewOffset + accessorOffset
        if (count > 0 && base + (count - 1) * step + elementBytes > bin.limit()) return@reader null
        val out = DoubleArray(count * componentCount)
        for (i in 0 until count) {
            for (c in 0 until componentCount) {
                val at = base + i * step + c * componentBytes
                out[i * componentCount + c] = when (componentType) {
                    COMPONENT_F32 -> bin.getFloat(at).toDouble()
                    COMPONENT_U32 -> (bin.getInt(at).toLong() and 0xFFFFFFFFL).toDouble() / divisor
                    COMPONENT_U16 -> (bin.getShort(at).toInt() and 0xFFFF).toDouble() / divisor
                    else -> (bin.get(at).toInt() and 0xFF).toDouble() / divisor
                }
            }
        }
        out
    }
}

/** parse a GLB container into the typed model. Failure is a value (Article 7). */
fun parseGlb(bytes: ByteArray): GlbParseResult {
    if (bytes.size < 20) return GlbParseResult.fail(GlbError.NOT_GLB)
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    if (buffer.getInt(0) != GLB_MAGIC || buffer.getInt(4) != 2) {
        return GlbParseResult.fail(GlbError.NOT_GLB)
    }
    // walk the chunk stream: one JSON chunk, at most one BIN chunk
    var offset = 12
    var jsonText: String? = null
    var bin: ByteBuffer? = null
    while (offset + 8 <= bytes.size) {
        val length = buffer.getInt(offset)
        val type = buffer.getInt(offset + 4)
        val start = offset + 8
        if (length < 0 || start + length > bytes.size) return GlbParseResult.fail(GlbError.MALFORMED)
        if (type == CHUNK_JSON && jsonText == null) {
            jsonText = String(bytes, start, length, Charsets.UTF_8)
        } else if (type == CHUNK_BIN && bin == null) {
            val slice = ByteBuffer.wrap(bytes, start, length).slice()
            slice.order(ByteOrder.LITTLE_ENDIAN)
            bin = slice
        }
        offset = start + length + ((4 - (length % 4)) % 4)
    }
    if (jsonText == null) return GlbParseResult.fail(GlbError.MALFORMED)
    val doc = dict(json(jsonText).foundationValue) ?: return GlbParseResult.fail(GlbError.MALFORMED)

    // v1 law: embedded buffers only — a uri is the named absence
    for (rawBuffer in list(doc["buffers"]) ?: emptyList()) {
        val b = dict(rawBuffer)
        if (b != null && b["uri"] is String) return GlbParseResult.fail(GlbError.EXTERNAL_BUFFER)
    }

    val read = makeAccessorReader(doc, bin)
    val materials = list(doc["materials"]) ?: emptyList()
    fun baseColorOf(materialIndex: Any?): DoubleArray {
        val material = dict(int(materialIndex)?.let { materials.getOrNull(it) })
        val pbr = material?.let { dict(it["pbrMetallicRoughness"]) }
        val factor = pbr?.let { list(it["baseColorFactor"]) }
        if (factor != null && factor.size == 4 && factor.all { it is Number }) {
            return DoubleArray(4) { (factor[it] as Number).toDouble() }
        }
        return doubleArrayOf(1.0, 1.0, 1.0, 1.0)
    }

    val meshes = ArrayList<GlbMesh>()
    for (rawMesh in list(doc["meshes"]) ?: emptyList()) {
        val mesh = dict(rawMesh) ?: return GlbParseResult.fail(GlbError.MALFORMED)
        val primitives = ArrayList<GlbPrimitive>()
        for (rawPrimitive in list(mesh["primitives"]) ?: emptyList()) {
            val primitive = dict(rawPrimitive) ?: return GlbParseResult.fail(GlbError.MALFORMED)
            val mode = int(primitive["mode"]) ?: MODE_TRIANGLES
            if (mode != MODE_TRIANGLES) continue                    // named absence: triangles only
            val attributes = dict(primitive["attributes"])
            val positionAccessor = attributes?.let { int(it["POSITION"]) }
                ?: return GlbParseResult.fail(GlbError.MALFORMED)
            val positions = read(positionAccessor, 3, false) ?: return GlbParseResult.fail(GlbError.MALFORMED)
            val normalAccessor = attributes.let { int(it["NORMAL"]) }
            val normals = if (normalAccessor == null) DoubleArray(0)
            else read(normalAccessor, 3, false) ?: return GlbParseResult.fail(GlbError.MALFORMED)
            val indexAccessor = int(primitive["indices"])
            val indices: IntArray = if (indexAccessor == null) {
                IntArray(positions.size / 3) { it }
            } else {
                val readIndices = read(indexAccessor, 1, false) ?: return GlbParseResult.fail(GlbError.MALFORMED)
                IntArray(readIndices.size) { readIndices[it].toInt() }
            }
            // G3: JOINTS_0 (raw) + WEIGHTS_0 (integer types normalized) — both or neither
            val jointsAccessor = attributes.let { int(it["JOINTS_0"]) }
            val weightsAccessor = attributes.let { int(it["WEIGHTS_0"]) }
            var joints = IntArray(0)
            var weights = DoubleArray(0)
            if (jointsAccessor != null && weightsAccessor != null) {
                val readJoints = read(jointsAccessor, 4, false) ?: return GlbParseResult.fail(GlbError.MALFORMED)
                weights = read(weightsAccessor, 4, true) ?: return GlbParseResult.fail(GlbError.MALFORMED)
                joints = IntArray(readJoints.size) { readJoints[it].toInt() }
            }
            primitives.add(GlbPrimitive(positions, normals, indices, baseColorOf(primitive["material"]),
                joints, weights))
        }
        meshes.add(GlbMesh(primitives))
    }

    // G3: the retained node forest (base TRS + matrix + references)
    val rawNodes = list(doc["nodes"]) ?: emptyList()
    val glbNodes = ArrayList<GlbNode>(rawNodes.size)
    for (rawNode in rawNodes) {
        val node = dict(rawNode) ?: return GlbParseResult.fail(GlbError.MALFORMED)
        var matrix: Mat4? = null
        list(node["matrix"])?.let { raw ->
            if (raw.size != 16) return GlbParseResult.fail(GlbError.MALFORMED)
            val out = DoubleArray(16)
            for (i in 0 until 16) out[i] = finiteDouble(raw[i]) ?: return GlbParseResult.fail(GlbError.MALFORMED)
            matrix = out
        }
        fun triple(name: String, fallback: DoubleArray): DoubleArray? {
            val raw = list(node[name]) ?: return fallback
            if (raw.size != 3) return null
            val out = DoubleArray(3)
            for (i in 0 until 3) out[i] = finiteDouble(raw[i]) ?: return null
            return out
        }
        val translation = triple("translation", doubleArrayOf(0.0, 0.0, 0.0))
            ?: return GlbParseResult.fail(GlbError.MALFORMED)
        val scale = triple("scale", doubleArrayOf(1.0, 1.0, 1.0))
            ?: return GlbParseResult.fail(GlbError.MALFORMED)
        var rotation = doubleArrayOf(0.0, 0.0, 0.0, 1.0)
        list(node["rotation"])?.let { raw ->
            if (raw.size != 4) return GlbParseResult.fail(GlbError.MALFORMED)
            val out = DoubleArray(4)
            for (i in 0 until 4) out[i] = finiteDouble(raw[i]) ?: return GlbParseResult.fail(GlbError.MALFORMED)
            rotation = out
        }
        val children = ArrayList<Int>()
        for (child in list(node["children"]) ?: emptyList()) {
            children.add(int(child) ?: return GlbParseResult.fail(GlbError.MALFORMED))
        }
        glbNodes.add(GlbNode(translation, rotation, scale, matrix, children.toIntArray(),
            int(node["mesh"]), int(node["skin"])))
    }

    // G3: skins — joints + inverse bind matrices (absent IBM accessor = identity)
    val skins = ArrayList<GlbSkin>()
    for (rawSkin in list(doc["skins"]) ?: emptyList()) {
        val skin = dict(rawSkin) ?: return GlbParseResult.fail(GlbError.MALFORMED)
        val joints = ArrayList<Int>()
        for (joint in list(skin["joints"]) ?: emptyList()) {
            joints.add(int(joint) ?: return GlbParseResult.fail(GlbError.MALFORMED))
        }
        val ibmAccessor = int(skin["inverseBindMatrices"])
        val inverseBindMatrices: List<Mat4> = if (ibmAccessor == null) {
            joints.map { mat4Identity() }
        } else {
            val flat = read(ibmAccessor, 16, false) ?: return GlbParseResult.fail(GlbError.MALFORMED)
            if (flat.size < joints.size * 16) return GlbParseResult.fail(GlbError.MALFORMED)
            joints.indices.map { i -> flat.copyOfRange(i * 16, i * 16 + 16) }
        }
        skins.add(GlbSkin(joints.toIntArray(), inverseBindMatrices))
    }

    // G3: animations → named clips. LINEAR + STEP only — a CUBICSPLINE or non-TRS
    // channel DROPS (the named absence); duration folds over the KEPT channels;
    // an unnamed animation is named by its zero-based index.
    val clips = ArrayList<GlbClip>()
    val rawAnimations = list(doc["animations"]) ?: emptyList()
    for (a in rawAnimations.indices) {
        val animation = dict(rawAnimations[a]) ?: return GlbParseResult.fail(GlbError.MALFORMED)
        val samplers = list(animation["samplers"]) ?: emptyList()
        val channels = ArrayList<GlbChannel>()
        var duration = 0.0
        for (rawChannel in list(animation["channels"]) ?: emptyList()) {
            val channel = dict(rawChannel) ?: return GlbParseResult.fail(GlbError.MALFORMED)
            val target = dict(channel["target"])
            val nodeIndex = target?.let { int(it["node"]) }
            val path = target?.get("path")
            if (nodeIndex == null || (path != "translation" && path != "rotation" && path != "scale")) {
                continue                                        // named absence: weights/morphs
            }
            val sampler = dict(int(channel["sampler"])?.let { samplers.getOrNull(it) })
                ?: return GlbParseResult.fail(GlbError.MALFORMED)
            val interpolation = sampler["interpolation"] ?: "LINEAR"
            if (interpolation != "LINEAR" && interpolation != "STEP") {
                continue                                        // named absence: CUBICSPLINE
            }
            val inputAccessor = int(sampler["input"]) ?: return GlbParseResult.fail(GlbError.MALFORMED)
            val outputAccessor = int(sampler["output"]) ?: return GlbParseResult.fail(GlbError.MALFORMED)
            val times = read(inputAccessor, 1, false) ?: return GlbParseResult.fail(GlbError.MALFORMED)
            val components = if (path == "rotation") 4 else 3
            val values = read(outputAccessor, components, false)
                ?: return GlbParseResult.fail(GlbError.MALFORMED)
            if (times.isEmpty() || values.size < times.size * components) {
                return GlbParseResult.fail(GlbError.MALFORMED)
            }
            channels.add(GlbChannel(nodeIndex, path as String, interpolation as String,
                times, values.copyOfRange(0, times.size * components)))
            if (times.last() > duration) duration = times.last()
        }
        val name = (animation["name"] as? String)?.takeIf { it.isNotEmpty() } ?: a.toString()
        clips.add(GlbClip(name, duration, channels))
    }

    // the draw list: the default scene's node hierarchy, world = parentWorld · local
    val nodes = list(doc["nodes"]) ?: emptyList()
    val scenes = list(doc["scenes"]) ?: emptyList()
    val sceneIndex = int(doc["scene"]) ?: 0
    val scene = dict(scenes.getOrNull(sceneIndex)) ?: dict(scenes.getOrNull(0))
    val draws = ArrayList<GlbDraw>()
    var broken = false
    fun walk(nodeIndex: Any?, parent: Mat4, depth: Int) {
        if (broken || depth > 64) { broken = true; return }
        val index = int(nodeIndex)
        val node = index?.let { dict(nodes.getOrNull(it)) }
        if (index == null || node == null) { broken = true; return }
        val local = nodeLocalMatrix(node)
        if (local == null) { broken = true; return }
        val world = mat4Multiply(parent, local)
        val meshIndex = int(node["mesh"])
        if (meshIndex != null && meshIndex < meshes.size) {
            val skinIndex = int(node["skin"])?.takeIf { it < skins.size }
            draws.add(GlbDraw(meshIndex, world, index, skinIndex))
        }
        for (child in list(node["children"]) ?: emptyList()) walk(child, world, depth + 1)
    }
    for (root in (scene?.let { list(it["nodes"]) } ?: emptyList())) {
        walk(root, mat4Identity(), 0)
    }
    if (broken) return GlbParseResult.fail(GlbError.MALFORMED)
    return GlbParseResult.ok(GlbModel(meshes, draws, glbNodes, skins, clips))
}

/** the largest world basis length — the uniform-enough scale billboards and bounding
 *  spheres ride (the worldBoundingSphere convention, shared with the raster) */
internal fun mat4LargestBasis(world: Mat4): Double = maxOf(
    hypot(hypot(world[0], world[1]), world[2]),
    hypot(hypot(world[4], world[5]), world[6]),
    hypot(hypot(world[8], world[9]), world[10]),
)
