//
//  SceneMath.kt - the DSX Scene math kernel, Kotlin twin of
//  OpenSource/Web/packages/kernel/src/scene/math.ts (dsx-scene.md P2): column-major mat4 +
//  vec3, zero dependencies, pure JVM (no android.*, no Compose — the corpus law in
//  OpenSource/Conformance/scene/README.md). Conventions, byte-identical to the TS
//  reference: column vectors (v' = M·v); local = T · Rz · Ry · Rx · S (scale, then rotate
//  X→Y→Z in degrees, then translate); right-handed lookAt view space; GL projection with
//  NDC z ∈ [-1, 1]. Pinned by OpenSource/Conformance/scene/{transforms,projection}.json —
//  SceneConformanceTest runs the SAME files the TS and Swift legs run, so the three
//  implementations cannot drift on a single matrix element.
//

package despia.engine.scene

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/** 16 numbers, column-major (index = column*4 + row) — the TS Mat4 twin. */
typealias Mat4 = DoubleArray

/** 3 numbers — the TS Vec3 twin. */
typealias Vec3 = DoubleArray

private const val DEG = Math.PI / 180.0

fun mat4Identity(): Mat4 =
    doubleArrayOf(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)

/** out = a · b (apply b first, then a — the matrix composition convention) */
fun mat4Multiply(a: Mat4, b: Mat4): Mat4 {
    val out = DoubleArray(16)
    for (c in 0 until 4) {
        for (r in 0 until 4) {
            var sum = 0.0
            for (k in 0 until 4) sum += a[k * 4 + r] * b[c * 4 + k]
            out[c * 4 + r] = sum
        }
    }
    return out
}

fun mat4Translation(x: Double, y: Double, z: Double): Mat4 =
    doubleArrayOf(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, z, 1.0)

fun mat4Scaling(x: Double, y: Double, z: Double): Mat4 =
    doubleArrayOf(x, 0.0, 0.0, 0.0, 0.0, y, 0.0, 0.0, 0.0, 0.0, z, 0.0, 0.0, 0.0, 0.0, 1.0)

fun mat4RotationX(degrees: Double): Mat4 {
    val c = cos(degrees * DEG); val s = sin(degrees * DEG)
    return doubleArrayOf(1.0, 0.0, 0.0, 0.0, 0.0, c, s, 0.0, 0.0, -s, c, 0.0, 0.0, 0.0, 0.0, 1.0)
}

fun mat4RotationY(degrees: Double): Mat4 {
    val c = cos(degrees * DEG); val s = sin(degrees * DEG)
    return doubleArrayOf(c, 0.0, -s, 0.0, 0.0, 1.0, 0.0, 0.0, s, 0.0, c, 0.0, 0.0, 0.0, 0.0, 1.0)
}

fun mat4RotationZ(degrees: Double): Mat4 {
    val c = cos(degrees * DEG); val s = sin(degrees * DEG)
    return doubleArrayOf(c, s, 0.0, 0.0, -s, c, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
}

/** the corpus rotation law: X applies to the object first, then Y, then Z — Rz·Ry·Rx */
fun mat4RotationXYZ(rx: Double, ry: Double, rz: Double): Mat4 =
    mat4Multiply(mat4Multiply(mat4RotationZ(rz), mat4RotationY(ry)), mat4RotationX(rx))

/** the node-local TRS: local = T · R · S (scale, then rotate, then translate) */
fun mat4Trs(position: Vec3, rotationDeg: Vec3, scale: Vec3): Mat4 =
    mat4Multiply(
        mat4Multiply(
            mat4Translation(position[0], position[1], position[2]),
            mat4RotationXYZ(rotationDeg[0], rotationDeg[1], rotationDeg[2]),
        ),
        mat4Scaling(scale[0], scale[1], scale[2]),
    )

fun vec3Sub(a: Vec3, b: Vec3): Vec3 = doubleArrayOf(a[0] - b[0], a[1] - b[1], a[2] - b[2])
fun vec3Dot(a: Vec3, b: Vec3): Double = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
fun vec3Cross(a: Vec3, b: Vec3): Vec3 = doubleArrayOf(
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
)
fun vec3Length(v: Vec3): Double = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
fun vec3Normalize(v: Vec3): Vec3 {
    val l = vec3Length(v)
    return if (l == 0.0) doubleArrayOf(0.0, 0.0, 0.0) else doubleArrayOf(v[0] / l, v[1] / l, v[2] / l)
}

/** right-handed lookAt (gluLookAt). A degenerate up (looking straight along ±Y with
 *  up = +Y) swaps to +Z rather than producing NaNs — failure is a value. */
fun mat4LookAt(eye: Vec3, target: Vec3, up: Vec3 = doubleArrayOf(0.0, 1.0, 0.0)): Mat4 {
    val f = vec3Normalize(vec3Sub(target, eye))
    var s = vec3Cross(f, up)
    if (vec3Length(s) < 1e-9) s = vec3Cross(f, doubleArrayOf(0.0, 0.0, 1.0))
    s = vec3Normalize(s)
    val u = vec3Cross(s, f)
    return doubleArrayOf(
        s[0], u[0], -f[0], 0.0,
        s[1], u[1], -f[1], 0.0,
        s[2], u[2], -f[2], 0.0,
        -vec3Dot(s, eye), -vec3Dot(u, eye), vec3Dot(f, eye), 1.0,
    )
}

/** GL perspective: fovY in degrees, NDC z ∈ [-1, 1] */
fun mat4Perspective(fovYDeg: Double, aspect: Double, near: Double, far: Double): Mat4 {
    val t = 1.0 / tan(fovYDeg * DEG / 2.0)
    return doubleArrayOf(
        t / aspect, 0.0, 0.0, 0.0,
        0.0, t, 0.0, 0.0,
        0.0, 0.0, (far + near) / (near - far), -1.0,
        0.0, 0.0, 2.0 * far * near / (near - far), 0.0,
    )
}

/** the mode="2d" camera: halfHeight is the vertical HALF-extent (`size`), centered */
fun mat4Orthographic(halfHeight: Double, aspect: Double, near: Double, far: Double): Mat4 {
    val r = halfHeight * aspect
    return doubleArrayOf(
        1.0 / r, 0.0, 0.0, 0.0,
        0.0, 1.0 / halfHeight, 0.0, 0.0,
        0.0, 0.0, -2.0 / (far - near), 0.0,
        0.0, 0.0, -(far + near) / (far - near), 1.0,
    )
}

/** transform a point (w = 1) and divide by the resulting w */
fun transformPoint(m: Mat4, p: Vec3): Vec3 {
    val w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]
    val d = if (w == 0.0) 1.0 else w
    return doubleArrayOf(
        (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / d,
        (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / d,
        (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / d,
    )
}

/** world → NDC through a projection·view pair (the projection corpus contract) */
fun projectToNdc(proj: Mat4, view: Mat4, world: Vec3): Vec3 =
    transformPoint(mat4Multiply(proj, view), world)

/** general 4×4 inverse (cofactor expansion); null for a singular matrix — the picking
 *  unproject fails closed instead of dividing by zero. Same expansion as the TS twin. */
fun mat4Invert(m: Mat4): Mat4? {
    val inv = DoubleArray(16)
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] +
        m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10]
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] -
        m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10]
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] +
        m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9]
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] -
        m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9]
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] -
        m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10]
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] +
        m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10]
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] -
        m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9]
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] +
        m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9]
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] +
        m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6]
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] -
        m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6]
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] +
        m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5]
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] -
        m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5]
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] -
        m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6]
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] +
        m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6]
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] -
        m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5]
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] +
        m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5]
    val det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12]
    if (!det.isFinite() || abs(det) < 1e-12) return null
    for (i in 0 until 16) inv[i] = inv[i] / det
    return inv
}

/** the picking ray origin + unit direction (the TS { origin, dir } twin) */
class SceneRay(val origin: Vec3, val dir: Vec3)

/** the picking ray (v0): unproject an NDC point (x, y ∈ [-1, 1]) through the camera's
 *  proj·view into a world-space origin + unit direction. Null when the pair is singular. */
fun pickRay(proj: Mat4, view: Mat4, ndcX: Double, ndcY: Double): SceneRay? {
    val inverse = mat4Invert(mat4Multiply(proj, view)) ?: return null
    val near = transformPoint(inverse, doubleArrayOf(ndcX, ndcY, -1.0))
    val far = transformPoint(inverse, doubleArrayOf(ndcX, ndcY, 1.0))
    return SceneRay(near, vec3Normalize(vec3Sub(far, near)))
}

/** ray ∩ sphere — the v0 picking primitive: the smallest non-negative hit distance,
 *  or null for a miss (dsx-scene.md: unproject against each node's bounding sphere) */
fun raySphere(origin: Vec3, dir: Vec3, center: Vec3, radius: Double): Double? {
    val oc = vec3Sub(origin, center)
    val b = vec3Dot(oc, dir)
    val c = vec3Dot(oc, oc) - radius * radius
    val disc = b * b - c
    if (disc < 0.0) return null
    val root = sqrt(disc)
    val t0 = -b - root
    if (t0 >= 0.0) return t0
    val t1 = -b + root
    return if (t1 >= 0.0) t1 else null
}

/** JS String(number) formatting for interpolated holes (the TS twin stringifies holes
 *  with String(value)): integral doubles print without ".0". Kept here so the IR's hole
 *  interpolation matches the web renderer byte-for-byte on the common numeric case. */
internal fun sceneNumberString(d: Double): String =
    if (d.isFinite() && d == floor(d) && abs(d) < 9.007199254740992E15) d.toLong().toString()
    else d.toString()
