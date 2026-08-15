//
//  SceneOrbit.swift - the `controls="orbit"` camera math, the Swift twin of the web
//  kernel's scene/orbit.ts (dsx-scene.md P5), corpus
//  OpenSource/Conformance/scene/orbit.json. Pointer drags orbit the camera on spherical
//  coordinates around the look-at point; pinch/wheel zooms the radius, clamped to
//  [near, far]. All math is platform-neutral and corpus-pinned; SceneElement wires the
//  iOS gestures.
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

import Foundation

/// the spherical camera state around the look-at point
struct OrbitState {
    let yawDeg: Double
    let pitchDeg: Double
    let distance: Double
}

enum SceneOrbit {

    static let degPerPx = 0.4
    static let zoomRate = 0.0015
    static let pitchLimitDeg = 89.0

    private static let deg = Double.pi / 180

    /// derive the orbit state from the authored camera (a degenerate zero offset
    /// answers the default camera's pose: yaw 0, pitch 0, distance 5 — failure is a
    /// value)
    static func fromCamera(position: [Double], lookAt: [Double]) -> OrbitState {
        let offset = SceneMath.sub(position, lookAt)
        let distance = SceneMath.length(offset)
        if distance == 0 { return OrbitState(yawDeg: 0, pitchDeg: 0, distance: 5) }
        return OrbitState(
            yawDeg: atan2(offset[0], offset[2]) / deg,
            pitchDeg: asin(min(max(offset[1] / distance, -1), 1)) / deg,
            distance: distance)
    }

    /// the spherical inverse: the camera position for a state around lookAt
    static func position(_ state: OrbitState, lookAt: [Double]) -> [Double] {
        let pitch = state.pitchDeg * deg
        let yaw = state.yawDeg * deg
        let flat = state.distance * cos(pitch)
        return [
            lookAt[0] + flat * sin(yaw),
            lookAt[1] + state.distance * sin(pitch),
            lookAt[2] + flat * cos(yaw),
        ]
    }

    /// the drag law (see the header): dx/dy in points (the CSS-pixel twin)
    static func drag(_ state: OrbitState, dxPx: Double, dyPx: Double) -> OrbitState {
        OrbitState(
            yawDeg: state.yawDeg - dxPx * degPerPx,
            pitchDeg: min(max(state.pitchDeg + dyPx * degPerPx, -pitchLimitDeg), pitchLimitDeg),
            distance: state.distance)
    }

    /// the zoom law (see the header): positive deltaY zooms out, clamped [near, far]
    static func zoom(_ state: OrbitState, deltaY: Double, near: Double, far: Double) -> OrbitState {
        let lower = max(near, 1e-3)
        let distance = min(max(state.distance * exp(deltaY * zoomRate), lower), far)
        return OrbitState(yawDeg: state.yawDeg, pitchDeg: state.pitchDeg, distance: distance)
    }
}
