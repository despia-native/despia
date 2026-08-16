//
//  SceneOrbit.kt - the `controls="orbit"` camera math, Kotlin twin of
//  OpenSource/Web/packages/kernel/src/scene/orbit.ts (dsx-scene.md P5), corpus
//  OpenSource/Conformance/scene/orbit.json. Pointer drags orbit the camera on
//  spherical coordinates around the look-at point; wheel/pinch zooms the radius,
//  clamped to [near, far]. All math is platform-neutral and corpus-pinned; each
//  renderer wires its own pointer events (desktop mouse drag + scroll wheel; the
//  Android element touch drag) and writes the result through the SceneAnimator's
//  override plane (the same seam animations ride).
//
//  THE SPHERICAL LAW: offset = position − lookAt; distance = |offset|;
//  pitch = asin(offset.y / distance) degrees; yaw = atan2(offset.x, offset.z) degrees
//  (yaw 0 = the camera on the +Z side, growing toward +X). The inverse:
//  position = lookAt + distance · (cosPitch·sinYaw, sinPitch, cosPitch·cosYaw).
//
//  THE DRAG LAW: yaw −= dx · 0.4°/px, pitch += dy · 0.4°/px, pitch clamped to ±89°
//  (dragging right orbits the camera left, so the SCENE appears to turn right — the
//  grab-the-object convention).
//  THE ZOOM LAW: distance ×= e^(deltaY · 0.0015), clamped to [max(near, 1e-3), far].
//

package despia.engine.scene

import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

const val ORBIT_DEG_PER_PX = 0.4
const val ORBIT_ZOOM_RATE = 0.0015
const val ORBIT_PITCH_LIMIT_DEG = 89.0

private const val DEG = Math.PI / 180.0

class OrbitState(val yawDeg: Double, val pitchDeg: Double, val distance: Double)

/** derive the orbit state from the authored camera (a degenerate zero offset answers
 *  the default camera's pose: yaw 0, pitch 0, distance 5 — failure is a value) */
fun orbitFromCamera(position: Vec3, lookAt: Vec3): OrbitState {
    val ox = position[0] - lookAt[0]
    val oy = position[1] - lookAt[1]
    val oz = position[2] - lookAt[2]
    val distance = sqrt(ox * ox + oy * oy + oz * oz)
    if (distance == 0.0) return OrbitState(0.0, 0.0, 5.0)
    return OrbitState(
        yawDeg = atan2(ox, oz) / DEG,
        pitchDeg = asin(min(max(oy / distance, -1.0), 1.0)) / DEG,
        distance = distance,
    )
}

/** the spherical inverse: the camera position for a state around lookAt */
fun orbitPosition(state: OrbitState, lookAt: Vec3): Vec3 {
    val pitch = state.pitchDeg * DEG
    val yaw = state.yawDeg * DEG
    val flat = state.distance * cos(pitch)
    return doubleArrayOf(
        lookAt[0] + flat * sin(yaw),
        lookAt[1] + state.distance * sin(pitch),
        lookAt[2] + flat * cos(yaw),
    )
}

/** the drag law (see the header): dx/dy in density-independent pixels */
fun orbitDrag(state: OrbitState, dxPx: Double, dyPx: Double): OrbitState = OrbitState(
    yawDeg = state.yawDeg - dxPx * ORBIT_DEG_PER_PX,
    pitchDeg = min(max(state.pitchDeg + dyPx * ORBIT_DEG_PER_PX, -ORBIT_PITCH_LIMIT_DEG), ORBIT_PITCH_LIMIT_DEG),
    distance = state.distance,
)

/** the zoom law (see the header): positive deltaY zooms out, clamped [near, far] */
fun orbitZoom(state: OrbitState, deltaY: Double, near: Double, far: Double): OrbitState {
    val lower = max(near, 1e-3)
    val distance = min(max(state.distance * exp(deltaY * ORBIT_ZOOM_RATE), lower), far)
    return OrbitState(state.yawDeg, state.pitchDeg, distance)
}
