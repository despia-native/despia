//
//  SceneMath.swift - the DSX Scene math kernel, the Swift twin of the web kernel's
//  scene/math.ts and Android's SceneMath.kt (dsx-scene.md P2): column-major mat4 +
//  vec3, Foundation-only, platform-neutral (no UIKit, no SceneKit — the corpus law in
//  OpenSource/Conformance/scene/README.md). Conventions: column vectors (v' = M·v);
//  local = T · Rz · Ry · Rx · S (scale, then rotate X→Y→Z in degrees, then translate);
//  right-handed lookAt view space; GL projection with NDC z ∈ [-1, 1]. The numbers are
//  corpus-pinned — OpenSource/Conformance/scene/ runs on all three implementations
//  (ConformanceHosts.SceneConformance is this twin's record-lane leg), so a divergent
//  matrix element here is a red lane, never a quiet drift.
//

import Foundation

/// 16 numbers, column-major (index = column*4 + row); vectors are 3 numbers.
enum SceneMath {

    private static let deg = Double.pi / 180

    static func identity() -> [Double] {
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    }

    /// out = a · b (apply b first, then a — the matrix composition convention)
    static func multiply(_ a: [Double], _ b: [Double]) -> [Double] {
        var out = [Double](repeating: 0, count: 16)
        for c in 0..<4 {
            for r in 0..<4 {
                var sum = 0.0
                for k in 0..<4 { sum += a[k * 4 + r] * b[c * 4 + k] }
                out[c * 4 + r] = sum
            }
        }
        return out
    }

    static func translation(_ x: Double, _ y: Double, _ z: Double) -> [Double] {
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
    }

    static func scaling(_ x: Double, _ y: Double, _ z: Double) -> [Double] {
        [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]
    }

    static func rotationX(_ degrees: Double) -> [Double] {
        let c = cos(degrees * deg), s = sin(degrees * deg)
        return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
    }

    static func rotationY(_ degrees: Double) -> [Double] {
        let c = cos(degrees * deg), s = sin(degrees * deg)
        return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
    }

    static func rotationZ(_ degrees: Double) -> [Double] {
        let c = cos(degrees * deg), s = sin(degrees * deg)
        return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    }

    /// the corpus rotation law: X applies to the object first, then Y, then Z — Rz·Ry·Rx
    static func rotationXYZ(_ rx: Double, _ ry: Double, _ rz: Double) -> [Double] {
        multiply(multiply(rotationZ(rz), rotationY(ry)), rotationX(rx))
    }

    /// the node-local TRS: local = T · R · S (scale, then rotate, then translate)
    static func trs(position: [Double], rotationDeg: [Double], scale: [Double]) -> [Double] {
        multiply(
            multiply(translation(position[0], position[1], position[2]),
                     rotationXYZ(rotationDeg[0], rotationDeg[1], rotationDeg[2])),
            scaling(scale[0], scale[1], scale[2])
        )
    }

    // ── vec3 helpers (the TS `vec3` namespace) ────────────────────────────────────────

    static func sub(_ a: [Double], _ b: [Double]) -> [Double] {
        [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    }
    static func dot(_ a: [Double], _ b: [Double]) -> Double {
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    }
    static func cross(_ a: [Double], _ b: [Double]) -> [Double] {
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    }
    static func length(_ v: [Double]) -> Double {
        (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).squareRoot()
    }
    static func normalize(_ v: [Double]) -> [Double] {
        let l = length(v)
        return l == 0 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l]
    }

    /// right-handed lookAt (gluLookAt). A degenerate up (looking straight along ±Y with
    /// up = +Y) swaps to +Z rather than producing NaNs — failure is a value.
    static func lookAt(eye: [Double], target: [Double], up: [Double] = [0, 1, 0]) -> [Double] {
        let f = normalize(sub(target, eye))
        var s = cross(f, up)
        if length(s) < 1e-9 { s = cross(f, [0, 0, 1]) }
        s = normalize(s)
        let u = cross(s, f)
        return [
            s[0], u[0], -f[0], 0,
            s[1], u[1], -f[1], 0,
            s[2], u[2], -f[2], 0,
            -dot(s, eye), -dot(u, eye), dot(f, eye), 1,
        ]
    }

    /// GL perspective: fovY in degrees, NDC z ∈ [-1, 1]
    static func perspective(fovYDeg: Double, aspect: Double, near: Double, far: Double) -> [Double] {
        let t = 1 / tan(fovYDeg * deg / 2)
        return [
            t / aspect, 0, 0, 0,
            0, t, 0, 0,
            0, 0, (far + near) / (near - far), -1,
            0, 0, 2 * far * near / (near - far), 0,
        ]
    }

    /// the mode="2d" camera: halfHeight is the vertical HALF-extent (`size`), centered
    static func orthographic(halfHeight: Double, aspect: Double, near: Double, far: Double) -> [Double] {
        let r = halfHeight * aspect
        return [
            1 / r, 0, 0, 0,
            0, 1 / halfHeight, 0, 0,
            0, 0, -2 / (far - near), 0,
            0, 0, -(far + near) / (far - near), 1,
        ]
    }

    /// transform a point (w = 1) and divide by the resulting w
    static func transformPoint(_ m: [Double], _ p: [Double]) -> [Double] {
        let w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]
        let d = w == 0 ? 1 : w
        return [
            (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / d,
            (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / d,
            (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / d,
        ]
    }

    /// world → NDC through a projection·view pair (the projection corpus contract)
    static func projectToNdc(proj: [Double], view: [Double], world: [Double]) -> [Double] {
        transformPoint(multiply(proj, view), world)
    }

    /// general 4×4 inverse (cofactor expansion); nil for a singular matrix — the picking
    /// unproject fails closed instead of dividing by zero
    static func invert(_ m: [Double]) -> [Double]? {
        var inv = [Double](repeating: 0, count: 16)
        inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15]
            + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10]
        inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15]
            - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10]
        inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15]
            + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9]
        inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14]
            - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9]
        inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15]
            - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10]
        inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15]
            + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10]
        inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15]
            - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9]
        inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14]
            + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9]
        inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15]
            + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6]
        inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15]
            - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6]
        inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15]
            + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5]
        inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14]
            - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5]
        inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11]
            - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6]
        inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11]
            + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6]
        inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11]
            - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5]
        inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10]
            + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5]
        let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12]
        if !det.isFinite || abs(det) < 1e-12 { return nil }
        return inv.map { $0 / det }
    }

    /// the picking ray (v0): unproject an NDC point (x, y ∈ [-1, 1]) through the camera's
    /// proj·view into a world-space origin + unit direction. Nil when the pair is singular.
    static func pickRay(proj: [Double], view: [Double], ndcX: Double, ndcY: Double)
        -> (origin: [Double], dir: [Double])? {
        guard let inverse = invert(multiply(proj, view)) else { return nil }
        let near = transformPoint(inverse, [ndcX, ndcY, -1])
        let far = transformPoint(inverse, [ndcX, ndcY, 1])
        return (origin: near, dir: normalize(sub(far, near)))
    }

    /// ray ∩ sphere — the v0 picking primitive: the smallest non-negative hit distance,
    /// or nil for a miss (dsx-scene.md: unproject against each node's bounding sphere)
    static func raySphere(origin: [Double], dir: [Double], center: [Double], radius: Double) -> Double? {
        let oc = sub(origin, center)
        let b = dot(oc, dir)
        let c = dot(oc, oc) - radius * radius
        let disc = b * b - c
        if disc < 0 { return nil }
        let root = disc.squareRoot()
        let t0 = -b - root
        if t0 >= 0 { return t0 }
        let t1 = -b + root
        return t1 >= 0 ? t1 : nil
    }
}
