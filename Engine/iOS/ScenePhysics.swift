//
//  ScenePhysics.swift - the DSX Scene G2 physics kernel, the Swift twin of the web
//  kernel's scene/physics.ts and Android's ScenePhysics.kt (dsx-game.md §2 G2), corpus
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
//    Collider geometry freezes at extraction. OBB SAT, deterministic clipped face
//    manifolds, selected support edges and point impulses provide collision-driven
//    angular response. Capsule colliders remain a named absence.
//  - THE SOLVER: semi-implicit Euler; sphere/box contacts with the P5 collide depth
//    laws + pinned normals; impulse resolution with restitution (max, with the 0.5
//    approach-speed micro-bounce guard) and Coulomb friction (sqrt mixing, clamped to
//    ±mu·j), persistent local-anchor warm starts over a global 32-iteration fold;
//    Baumgarte positional correction (percent 0.8, slop 0.005); character
//    move-and-slide with full depenetration, velocity projection and ground detection
//    (surface normal up.y > 0.7); sleep at |v| < 0.05 for 60 ticks, wake on write or
//    energetic contact. Triggers overlap without forces (enter/exit tracker).
//
//  This file owns the NUMBERS; SceneElement.swift owns only the wiring (the
//  accumulator inside its ONE CADisplayLink loop, the write-law hooks where base
//  writes land, event dispatch through runGated, the interpolated overrides). The
//  record-lane leg is ConformanceHosts.SceneConformance.verifyPhysics (physics.json).
//

import Foundation

/// one collider shape frozen at extraction
enum ScenePhysicsShape {
    case sphere(radius: Double)
    case box(half: [Double])
}

/// one extracted (or corpus-fed) body record — createWorld consumes these
struct ScenePhysicsBodySpec {
    var id: String
    var kind: String
    var shape: ScenePhysicsShape
    var position: [Double] = [0, 0, 0]
    var velocity: [Double] = [0, 0, 0]
    /// DSX Euler degrees, X then Y then Z
    var rotation: [Double] = [0, 0, 0]
    /// radians/second in scene axes
    var angularVelocity: [Double] = [0, 0, 0]
    /// persistent world torque applied each fixed step
    var torque: [Double] = [0, 0, 0]
    /// linear angular drag coefficient in 1/seconds
    var angularDamping: Double = ScenePhysics.defaultAngularDamping
    var mass: Double = 1
    var bounce: Double = 0
    var friction: Double = 0.5
    var trigger: Bool = false
    var layer: String = "default"
    var collides: [String]? = nil
    var speed: Double = ScenePhysics.defaultSpeed
    var jump: Double = ScenePhysics.defaultJump
    /// the extraction's way back to the markup node (renderer-owned; corpora omit it)
    var node: SceneNode? = nil
}

/// one live body — solver-owned mutable state over the frozen extraction record
final class ScenePhysicsBody {
    let id: String
    let kind: String
    /// "sphere" | "box"
    let shape: String
    let radius: Double
    let half: [Double]
    /// solver-owned world position (the body CENTER)
    var position: [Double]
    /// the position at the START of the last step — the interpolation anchor
    var previous: [Double]
    var velocity: [Double]
    /// solver-owned DSX Euler degrees
    var rotation: [Double]
    /// normalized [x,y,z,w] orientation used by contacts and stable integration
    var orientation: [Double]
    /// rotation at the START of the last step
    var previousRotation: [Double]
    /// radians/second in scene axes
    var angularVelocity: [Double]
    /// inverse diagonal inertia in frozen extraction axes
    let invInertia: [Double]
    /// persistent world torque applied each fixed step
    var torque: [Double]
    let angularDamping: Double
    let invMass: Double
    let bounce: Double
    let friction: Double
    let trigger: Bool
    let layer: String
    let collides: [String]?
    let speed: Double
    let jump: Double
    var grounded = false
    var sleeping = false
    var sleepCount = 0
    /// G6 THE Z-LOCK LAW (mode="2d" worlds only): the z position every step re-pins to.
    /// Recorded at world creation; a TELEPORT re-anchors it.
    var zLock: Double
    /// G6: the z velocity every step re-pins to — recorded at world creation and NEVER
    /// re-anchored (the named v1 shape)
    let vzLock: Double
    /// mode="2d" preserves authored X/Y orientation; only Z may rotate
    let rotation2dLock: [Double]
    /// solver DOF mask: 2D bodies have only world-Z angular response
    let mode2d: Bool
    fileprivate var axesCacheOrientation: [Double]? = nil
    fileprivate var axesCache: [[Double]]? = nil
    fileprivate var inertiaCacheOrientation: [Double]? = nil
    fileprivate var inverseInertiaCache: [[Double]]? = nil
    fileprivate var inertiaCache: [[Double]]? = nil
    /// document index — the deterministic pair order
    let index: Int

    init(spec: ScenePhysicsBodySpec, index: Int, mode2d: Bool) {
        id = spec.id
        kind = spec.kind
        switch spec.shape {
        case .sphere(let radius):
            shape = "sphere"
            self.radius = radius
            half = [0, 0, 0]
        case .box(let half):
            shape = "box"
            radius = 0
            self.half = half
        }
        position = spec.position
        previous = spec.position
        velocity = spec.velocity
        rotation = spec.rotation
        orientation = ScenePhysics.quaternionFromEuler(spec.rotation)
        previousRotation = spec.rotation
        angularVelocity = spec.angularVelocity
        torque = spec.torque
        angularDamping = max(spec.angularDamping, 0)
        invMass = spec.kind == "dynamic" && spec.mass > 0 ? 1 / spec.mass : 0
        if spec.kind != "dynamic" || spec.mass <= 0 {
            invInertia = [0, 0, 0]
        } else {
            switch spec.shape {
            case .sphere(let radius):
                let inertia = 0.4 * spec.mass * radius * radius
                let inverse = inertia > 0 ? 1 / inertia : 0
                invInertia = [inverse, inverse, inverse]
            case .box(let half):
                let ix = spec.mass * (half[1] * half[1] + half[2] * half[2]) / 3
                let iy = spec.mass * (half[0] * half[0] + half[2] * half[2]) / 3
                let iz = spec.mass * (half[0] * half[0] + half[1] * half[1]) / 3
                invInertia = [ix > 0 ? 1 / ix : 0, iy > 0 ? 1 / iy : 0, iz > 0 ? 1 / iz : 0]
            }
        }
        bounce = spec.bounce
        friction = spec.friction
        trigger = spec.trigger
        layer = spec.layer
        collides = spec.collides
        speed = spec.speed
        jump = spec.jump
        zLock = spec.position.count > 2 ? spec.position[2] : 0
        vzLock = spec.velocity.count > 2 ? spec.velocity[2] : 0
        rotation2dLock = spec.rotation
        self.mode2d = mode2d
        self.index = index
    }
}

final class ScenePhysicsWorld {
    let gravity: [Double]
    let bodies: [ScenePhysicsBody]
    let byId: [String: ScenePhysicsBody]
    /// G6: the world simulates inside `mode="2d"` — the z-lock pass runs each step
    let mode2d: Bool
    var tick = 0
    var solidOverlap: Set<String> = []
    var triggerOverlap: Set<String> = []
    /// overlapping trigger pairs in insertion order — the pinned exit order
    var triggerOrder: [String] = []
    fileprivate var contactCache: [String: ScenePhysicsCachedImpulse] = [:]

    init(gravity: [Double], bodies: [ScenePhysicsBody], mode2d: Bool = false) {
        self.gravity = gravity
        self.bodies = bodies
        self.mode2d = mode2d
        var map: [String: ScenePhysicsBody] = [:]
        for body in bodies { map[body.id] = body }
        byId = map
    }
}

fileprivate final class ScenePhysicsCachedImpulse {
    let a: String
    let b: String
    var normal: Double
    var normalAxis: [Double]
    var tangent: [Double]
    var localAnchorA: [Double]
    var localAnchorB: [Double]
    var lastTick: Int

    init(a: String, b: String, normal: Double, normalAxis: [Double],
         tangent: [Double], localAnchorA: [Double], localAnchorB: [Double], lastTick: Int) {
        self.a = a; self.b = b; self.normal = normal; self.normalAxis = normalAxis
        self.tangent = tangent; self.localAnchorA = localAnchorA
        self.localAnchorB = localAnchorB; self.lastTick = lastTick
    }
}

fileprivate final class ScenePhysicsPointConstraint {
    let rA: [Double]
    let rB: [Double]
    let cached: ScenePhysicsCachedImpulse
    let target: Double
    let normalDenominator: Double
    var tangentAxis: [Double] = [0, 0, 0]
    var tangentDenominator: Double = 0

    init(rA: [Double], rB: [Double], cached: ScenePhysicsCachedImpulse,
         target: Double, normalDenominator: Double) {
        self.rA = rA; self.rB = rB; self.cached = cached
        self.target = target; self.normalDenominator = normalDenominator
    }
}

fileprivate struct ScenePhysicsSolverContact {
    let a: ScenePhysicsBody
    let b: ScenePhysicsBody
    let depth: Double
    let n: [Double]
    let invA: Double
    let invB: Double
    let invSum: Double
    let constraints: [ScenePhysicsPointConstraint]
}

struct ScenePhysicsPairEvent {
    let id: String
    let other: String
}

struct ScenePhysicsStepResult {
    /// the zero-based index of the step just completed (the on:tick payload's `tick`)
    let tick: Int
    /// always exactly ScenePhysics.dt (the on:tick payload's `dt`)
    let dt: Double
    let collisions: [ScenePhysicsPairEvent]
    let enters: [ScenePhysicsPairEvent]
    let exits: [ScenePhysicsPairEvent]
}

struct ScenePhysicsIntent {
    /// character horizontal intent [x, z] (normalized only when |move| > 1, × speed)
    var move: [Double]? = nil
    /// kinematic drive: the authored/bound position this step
    var position: [Double]? = nil
    /// kinematic authored/bound DSX Euler rotation this step
    var rotation: [Double]? = nil
}

/// feed one rendered frame's dt (SECONDS); how many fixed steps to run now and the
/// interpolation alpha after them
final class ScenePhysicsAccumulator {
    private var acc = 0.0

    func advance(frameSeconds: Double) -> (steps: Int, alpha: Double) {
        acc = min(acc + frameSeconds, Double(ScenePhysics.maxStepsPerFrame) * ScenePhysics.dt)
        let steps = Int((acc / ScenePhysics.dt).rounded(.down))
        acc -= Double(steps) * ScenePhysics.dt
        return (steps: steps, alpha: acc / ScenePhysics.dt)
    }
}

enum ScenePhysics {

    // ── the pinned constants (corpus `constants` — the runner asserts these) ─────────

    static let dt = 1.0 / 60.0
    static let maxStepsPerFrame = 5
    static let defaultGravity: [Double] = [0, -9.81, 0]
    static let correctionPercent = 0.8
    static let slop = 0.005
    static let restitutionMinSpeed = 0.5
    static let groundNormalY = 0.7
    static let sleepSpeed = 0.05
    static let sleepTicks = 60
    static let slideIterations = 4
    static let manifoldIterations = 32
    static let defaultSpeed = 5.0
    static let defaultJump = 8.0
    static let defaultAngularDamping = 0.0
    static let radiansToDegrees = 57.29577951308232
    static let degreesToRadians = 0.017453292519943295

    /// G6 (sprite.json): the 2D extrusion of a `<sprite>` box collider — effectively
    /// infinite at scene scales, so the minimum-overlap axis of a box↔box contact is
    /// ALWAYS in the XY plane (the 2D semantics of an extruded rectangle)
    static let spriteColliderHalfZ = 1000.0

    static let kinds: Set<String> = ["static", "dynamic", "kinematic", "character"]

    private static let eligibleKinds: Set<String> = ["box", "sphere", "plane", "model", "sprite"]

    // ── construction ─────────────────────────────────────────────────────────────────

    static func createWorld(gravity: [Double], specs: [ScenePhysicsBodySpec],
                            mode2d: Bool = false) -> ScenePhysicsWorld {
        ScenePhysicsWorld(gravity: gravity,
                          bodies: specs.enumerated().map {
                              ScenePhysicsBody(spec: $0.element, index: $0.offset, mode2d: mode2d)
                          },
                          mode2d: mode2d)
    }

    private static func invalidateContactCache(_ world: ScenePhysicsWorld, _ id: String) {
        world.contactCache = world.contactCache.filter { $0.value.a != id && $0.value.b != id }
    }

    /// THE VELOCITY-WRITE LAW: sets the velocity verbatim and wakes the body
    @discardableResult
    static func writeVelocity(_ world: ScenePhysicsWorld, id: String, _ v: [Double]) -> Bool {
        guard let body = world.byId[id] else { return false }
        body.velocity = v
        invalidateContactCache(world, id)
        body.sleeping = false
        body.sleepCount = 0
        return true
    }

    @discardableResult
    static func writeAngularVelocity(_ world: ScenePhysicsWorld, id: String, _ v: [Double]) -> Bool {
        guard let body = world.byId[id] else { return false }
        body.angularVelocity = v
        invalidateContactCache(world, id)
        body.sleeping = false
        body.sleepCount = 0
        return true
    }

    @discardableResult
    static func writeTorque(_ world: ScenePhysicsWorld, id: String, _ torque: [Double]) -> Bool {
        guard let body = world.byId[id] else { return false }
        body.torque = torque
        invalidateContactCache(world, id)
        body.sleeping = false
        body.sleepCount = 0
        return true
    }

    @discardableResult
    static func teleportRotation(_ world: ScenePhysicsWorld, id: String, _ rotation: [Double]) -> Bool {
        guard let body = world.byId[id] else { return false }
        body.rotation = rotation
        body.orientation = quaternionFromEuler(rotation)
        body.previousRotation = rotation
        body.angularVelocity = [0, 0, 0]
        invalidateContactCache(world, id)
        body.sleeping = false
        body.sleepCount = 0
        return true
    }

    /// THE TELEPORT LAW: an authored/bound/bus position write moves the body, RESETS
    /// its velocity to zero, resets the interpolation anchor (no glide across a
    /// teleport), and wakes it
    @discardableResult
    static func teleport(_ world: ScenePhysicsWorld, id: String, _ p: [Double]) -> Bool {
        guard let body = world.byId[id] else { return false }
        body.position = p
        body.previous = p
        body.velocity = [0, 0, 0]
        invalidateContactCache(world, id)
        // G6: a teleport RE-ANCHORS the 2D z-lock (vzLock never moves)
        if p.count > 2 { body.zLock = p[2] }
        body.sleeping = false
        body.sleepCount = 0
        return true
    }

    /// the v1 kinematic-write wake law: no island graph (named absence) — a kinematic
    /// position write wakes every sleeping body
    static func wakeAll(_ world: ScenePhysicsWorld) {
        for body in world.bodies where body.sleeping {
            body.sleeping = false
            body.sleepCount = 0
        }
    }

    // ── the contact laws ─────────────────────────────────────────────────────────────

    /// deterministic length — sqrt is correctly rounded on every IEEE runtime
    private static func length3(_ v: [Double]) -> Double {
        (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).squareRoot()
    }

    private static func dot3(_ a: [Double], _ b: [Double]) -> Double {
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    }

    private static func cross3(_ a: [Double], _ b: [Double]) -> [Double] {
        [a[1] * b[2] - a[2] * b[1],
         a[2] * b[0] - a[0] * b[2],
         a[0] * b[1] - a[1] * b[0]]
    }

    private static func subtract3(_ a: [Double], _ b: [Double]) -> [Double] {
        [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    }

    private static func quaternionMultiply(_ a: [Double], _ b: [Double]) -> [Double] {
        [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
         a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
         a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
         a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]
    }

    private static func normalizeQuaternion(_ q: [Double]) -> [Double] {
        let length = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).squareRoot()
        if length == 0 { return [0, 0, 0, 1] }
        return q.map { $0 / length }
    }

    /** DSX Euler law is Rz*Ry*Rx: X acts on the object first, then Y, then Z. */
    static func quaternionFromEuler(_ rotation: [Double]) -> [Double] {
        let hx = rotation[0] * degreesToRadians / 2
        let hy = rotation[1] * degreesToRadians / 2
        let hz = rotation[2] * degreesToRadians / 2
        let qx = [sin(hx), 0.0, 0.0, cos(hx)]
        let qy = [0.0, sin(hy), 0.0, cos(hy)]
        let qz = [0.0, 0.0, sin(hz), cos(hz)]
        return normalizeQuaternion(quaternionMultiply(quaternionMultiply(qz, qy), qx))
    }

    private static func quaternionAxes(_ q: [Double]) -> [[Double]] {
        let x = q[0], y = q[1], z = q[2], w = q[3]
        return [
            [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
            [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
            [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
        ]
    }

    private static func sameQuaternion(_ a: [Double]?, _ b: [Double]) -> Bool {
        guard let a, a.count == 4 else { return false }
        return a[0] == b[0] && a[1] == b[1] && a[2] == b[2] && a[3] == b[3]
    }

    private static func bodyAxes(_ body: ScenePhysicsBody) -> [[Double]] {
        if sameQuaternion(body.axesCacheOrientation, body.orientation), let axes = body.axesCache {
            return axes
        }
        let axes = quaternionAxes(body.orientation)
        body.axesCacheOrientation = body.orientation
        body.axesCache = axes
        return axes
    }

    private static func bodyInertiaMatrices(_ body: ScenePhysicsBody)
        -> (inverse: [[Double]], tensor: [[Double]]) {
        if sameQuaternion(body.inertiaCacheOrientation, body.orientation),
           let inverse = body.inverseInertiaCache, let tensor = body.inertiaCache {
            return (inverse, tensor)
        }
        let axes = bodyAxes(body)
        var inverse = Array(repeating: Array(repeating: 0.0, count: 3), count: 3)
        var tensor = Array(repeating: Array(repeating: 0.0, count: 3), count: 3)
        for axis in 0..<3 {
            let inv = body.invInertia[axis], inertia = inv > 0 ? 1 / inv : 0
            for row in 0..<3 { for column in 0..<3 {
                let projection = axes[axis][row] * axes[axis][column]
                inverse[row][column] += projection * inv
                tensor[row][column] += projection * inertia
            }}
        }
        body.inertiaCacheOrientation = body.orientation
        body.inverseInertiaCache = inverse
        body.inertiaCache = tensor
        return (inverse, tensor)
    }

    private static func unwrapDegrees(_ value: Double, _ reference: Double) -> Double {
        var result = value
        while result - reference > 180 { result -= 360 }
        while result - reference < -180 { result += 360 }
        return result
    }

    private static func eulerFromQuaternion(_ q: [Double], _ previous: [Double]) -> [Double] {
        let axes = quaternionAxes(q)
        let m00 = axes[0][0], m10 = axes[0][1], m20 = axes[0][2]
        let m11 = axes[1][1], m12 = axes[2][1], m21 = axes[1][2], m22 = axes[2][2]
        let ry = asin(max(-1, min(1, -m20)))
        let cy = cos(ry)
        let rx = abs(cy) > 1e-9 ? atan2(m21, m22) : atan2(-m12, m11)
        let rz = abs(cy) > 1e-9 ? atan2(m10, m00) : 0
        let principal = [unwrapDegrees(rx * radiansToDegrees, previous[0]),
                         unwrapDegrees(ry * radiansToDegrees, previous[1]),
                         unwrapDegrees(rz * radiansToDegrees, previous[2])]
        let alternateY = ry >= 0 ? Double.pi - ry : -Double.pi - ry
        let alternate = [unwrapDegrees((rx + Double.pi) * radiansToDegrees, previous[0]),
                         unwrapDegrees(alternateY * radiansToDegrees, previous[1]),
                         unwrapDegrees((rz + Double.pi) * radiansToDegrees, previous[2])]
        let principalDistance = (principal[0] - previous[0]) * (principal[0] - previous[0])
            + (principal[1] - previous[1]) * (principal[1] - previous[1])
            + (principal[2] - previous[2]) * (principal[2] - previous[2])
        let alternateDistance = (alternate[0] - previous[0]) * (alternate[0] - previous[0])
            + (alternate[1] - previous[1]) * (alternate[1] - previous[1])
            + (alternate[2] - previous[2]) * (alternate[2] - previous[2])
        return alternateDistance < principalDistance ? alternate : principal
    }

    private static func shortestArcAngularVelocity(_ from: [Double], _ to: [Double], _ dt: Double)
        -> [Double] {
        let conjugate = [-from[0], -from[1], -from[2], from[3]]
        var delta = normalizeQuaternion(quaternionMultiply(to, conjugate))
        if delta[3] < 0 { delta = delta.map { -$0 } }
        let vectorLength = (delta[0] * delta[0] + delta[1] * delta[1]
            + delta[2] * delta[2]).squareRoot()
        if vectorLength < 1e-12 { return [0, 0, 0] }
        let angle = 2 * atan2(vectorLength, max(delta[3], 0))
        let scale = angle / (vectorLength * dt)
        return [delta[0] * scale, delta[1] * scale, delta[2] * scale]
    }

    private static func integrateOrientation(_ body: ScenePhysicsBody, _ dt: Double) {
        let speed = length3(body.angularVelocity)
        if speed == 0 { return }
        let halfAngle = speed * dt / 2
        let scale = sin(halfAngle) / speed
        let delta = [body.angularVelocity[0] * scale, body.angularVelocity[1] * scale,
                     body.angularVelocity[2] * scale, cos(halfAngle)]
        body.orientation = normalizeQuaternion(quaternionMultiply(delta, body.orientation))
        body.rotation = eulerFromQuaternion(body.orientation, body.rotation)
    }

    private static func closestPointOnBox(_ point: [Double], _ box: ScenePhysicsBody) -> [Double] {
        let axes = bodyAxes(box)
        let d = subtract3(point, box.position)
        var out = box.position
        for i in 0..<3 {
            let amount = min(max(dot3(d, axes[i]), -box.half[i]), box.half[i])
            for k in 0..<3 { out[k] += axes[i][k] * amount }
        }
        return out
    }

    private static func localContactAnchor(_ point: [Double], _ body: ScenePhysicsBody) -> [Double] {
        let axes = bodyAxes(body), d = subtract3(point, body.position)
        return [dot3(d, axes[0]), dot3(d, axes[1]), dot3(d, axes[2])]
    }

    private static func boxVertices(_ box: ScenePhysicsBody) -> [[Double]] {
        let axes = bodyAxes(box)
        var vertices: [[Double]] = []
        for sx in [-1.0, 1.0] { for sy in [-1.0, 1.0] { for sz in [-1.0, 1.0] {
            var vertex = box.position
            let signs = [sx, sy, sz]
            for i in 0..<3 { for k in 0..<3 { vertex[k] += axes[i][k] * box.half[i] * signs[i] } }
            vertices.append(vertex)
        }}}
        return vertices
    }

    private static func pointInsideBox(_ point: [Double], _ box: ScenePhysicsBody,
                                       _ margin: Double = 1e-8) -> Bool {
        let axes = bodyAxes(box), d = subtract3(point, box.position)
        for i in 0..<3 where abs(dot3(d, axes[i])) > box.half[i] + margin { return false }
        return true
    }

    private struct Point2 {
        var x: Double
        var y: Double
        var feature: String
    }

    private enum SatWinner {
        case faceA(Int)
        case faceB(Int)
        case edge(Int, Int)
    }

    private static func supportFace(_ box: ScenePhysicsBody, _ direction: [Double])
        -> (points: [(point: [Double], feature: String)], feature: String) {
        let axes = bodyAxes(box)
        var faceAxis = 0, alignment = abs(dot3(axes[0], direction))
        for i in 1..<3 {
            let next = abs(dot3(axes[i], direction))
            if next > alignment { faceAxis = i; alignment = next }
        }
        let sign = dot3(axes[faceAxis], direction) >= 0 ? 1.0 : -1.0
        var center = box.position
        for k in 0..<3 { center[k] += axes[faceAxis][k] * box.half[faceAxis] * sign }
        let sideAxes = [0, 1, 2].filter { $0 != faceAxis }
        let corners = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)]
        let faceFeature = "f\(faceAxis)\(sign > 0 ? "+" : "-")"
        let points = corners.map { su, sv -> (point: [Double], feature: String) in
            var point = center
            for k in 0..<3 {
                point[k] += axes[sideAxes[0]][k] * box.half[sideAxes[0]] * su
                    + axes[sideAxes[1]][k] * box.half[sideAxes[1]] * sv
            }
            return (point: point,
                    feature: "\(faceFeature):v\(su > 0 ? 1 : 0)\(sv > 0 ? 1 : 0)")
        }
        return (points, faceFeature)
    }

    private static func cross2(_ a: Point2, _ b: Point2, _ c: Point2) -> Double {
        (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    }

    private static func polygonArea2(_ points: [Point2]) -> Double {
        var area = 0.0
        for i in points.indices {
            let a = points[i], b = points[(i + 1) % points.count]
            area += a.x * b.y - a.y * b.x
        }
        return area
    }

    private static func clipPolygon(_ subject: [Point2], _ clip: [Point2], _ clipFeature: String)
        -> [Point2] {
        var output = subject
        for edgeIndex in clip.indices {
            let edgeA = clip[edgeIndex], edgeB = clip[(edgeIndex + 1) % clip.count]
            let input = output
            output = []
            if input.isEmpty { break }
            var start = input[input.count - 1]
            var startDistance = cross2(edgeA, edgeB, start)
            for end in input {
                let endDistance = cross2(edgeA, edgeB, end)
                let startInside = startDistance >= -1e-9, endInside = endDistance >= -1e-9
                if endInside != startInside {
                    let denominator = startDistance - endDistance
                    let t = denominator == 0 ? 0 : startDistance / denominator
                    let edge = [start.feature, end.feature].sorted().joined(separator: "|")
                    output.append(Point2(x: start.x + (end.x - start.x) * t,
                                         y: start.y + (end.y - start.y) * t,
                                         feature: "i(\(edge);\(clipFeature):e\(edgeIndex))"))
                }
                if endInside { output.append(end) }
                start = end
                startDistance = endDistance
            }
        }
        return output
    }

    private static func clippedFaceManifold(_ a: ScenePhysicsBody, _ b: ScenePhysicsBody,
                                             _ normal: [Double], _ plane: Double)
        -> [(point: [Double], feature: String)]? {
        let absNormal = normal.map(abs)
        let seed: [Double] = absNormal[0] <= absNormal[1] && absNormal[0] <= absNormal[2]
            ? [1, 0, 0] : absNormal[1] <= absNormal[2] ? [0, 1, 0] : [0, 0, 1]
        let rawU = cross3(seed, normal), ul = length3(rawU)
        let u = rawU.map { $0 / ul }, v = cross3(normal, u)
        let faceA = supportFace(a, normal)
        let faceB = supportFace(b, normal.map { -$0 })
        func project(_ entry: (point: [Double], feature: String)) -> Point2 {
            Point2(x: dot3(entry.point, u), y: dot3(entry.point, v), feature: entry.feature)
        }
        var polygonA = faceA.points.map(project), polygonB = faceB.points.map(project)
        if polygonArea2(polygonA) < 0 { polygonA.reverse() }
        if polygonArea2(polygonB) < 0 { polygonB.reverse() }
        var clipped = clipPolygon(polygonA, polygonB, faceB.feature)
        if clipped.isEmpty { return nil }
        var unique: [Point2] = []
        for point in clipped {
            if !unique.contains(where: {
                let dx = $0.x - point.x, dy = $0.y - point.y
                return dx * dx + dy * dy <= 1e-14
            }) { unique.append(point) }
        }
        clipped = unique.sorted { $0.x == $1.x ? $0.y < $1.y : $0.x < $1.x }
        var entries = clipped.map { entry -> (point: [Double], feature: String) in
            let point = [u[0] * entry.x + v[0] * entry.y + normal[0] * plane,
                         u[1] * entry.x + v[1] * entry.y + normal[1] * plane,
                         u[2] * entry.x + v[2] * entry.y + normal[2] * plane]
            return (point, "\(faceA.feature)|\(faceB.feature)|\(entry.feature)")
        }
        if entries.count > 4 {
            var selected = [entries[0]]
            while selected.count < 4 {
                var best: (point: [Double], feature: String)?
                var bestDistance = -Double.infinity
                for entry in entries {
                    if selected.contains(where: { $0.feature == entry.feature }) { continue }
                    var nearest = Double.infinity
                    for chosen in selected {
                        let delta = subtract3(entry.point, chosen.point)
                        nearest = min(nearest, dot3(delta, delta))
                    }
                    if nearest > bestDistance { best = entry; bestDistance = nearest }
                }
                selected.append(best!)
            }
            entries = selected
        }
        return entries
    }

    private static func supportEdge(_ box: ScenePhysicsBody, _ edgeAxis: Int,
                                    _ direction: [Double], _ maximum: Bool)
        -> (start: [Double], end: [Double], feature: String) {
        let axes = bodyAxes(box)
        var center = box.position, signs = [0, 0, 0]
        for axis in 0..<3 where axis != edgeAxis {
            let projection = dot3(axes[axis], direction)
            let sign = (maximum ? projection >= 0 : projection < 0) ? 1 : -1
            signs[axis] = sign
            for k in 0..<3 { center[k] += axes[axis][k] * box.half[axis] * Double(sign) }
        }
        let along = axes[edgeAxis], half = box.half[edgeAxis]
        let start = (0..<3).map { center[$0] - along[$0] * half }
        let end = (0..<3).map { center[$0] + along[$0] * half }
        let signature = signs.enumerated().map { axis, sign in
            axis == edgeAxis ? "x" : sign > 0 ? "+" : "-"
        }.joined()
        return (start, end, "e\(edgeAxis):\(signature)")
    }

    private static func closestSegmentPoints(_ a0: [Double], _ a1: [Double],
                                             _ b0: [Double], _ b1: [Double])
        -> ([Double], [Double]) {
        let d1 = subtract3(a1, a0), d2 = subtract3(b1, b0), r = subtract3(a0, b0)
        let aa = dot3(d1, d1), ee = dot3(d2, d2), f = dot3(d2, r)
        var s = 0.0, t = 0.0
        if aa <= 1e-12 && ee <= 1e-12 { return (a0, b0) }
        if aa <= 1e-12 { t = min(max(f / ee, 0), 1) }
        else {
            let c = dot3(d1, r)
            if ee <= 1e-12 { s = min(max(-c / aa, 0), 1) }
            else {
                let bb = dot3(d1, d2), denominator = aa * ee - bb * bb
                if abs(denominator) > 1e-12 { s = min(max((bb * f - c * ee) / denominator, 0), 1) }
                t = (bb * s + f) / ee
                if t < 0 { t = 0; s = min(max(-c / aa, 0), 1) }
                else if t > 1 { t = 1; s = min(max((bb - c) / aa, 0), 1) }
            }
        }
        return ((0..<3).map { a0[$0] + d1[$0] * s },
                (0..<3).map { b0[$0] + d2[$0] * t })
    }

    private static func boxManifoldPoints(_ a: ScenePhysicsBody, _ b: ScenePhysicsBody,
                                          _ normal: [Double], _ depth: Double,
                                          _ winner: SatWinner)
        -> [(point: [Double], feature: String)] {
        if case .edge(let axisA, let axisB) = winner {
            let edgeA = supportEdge(a, axisA, normal, true)
            let edgeB = supportEdge(b, axisB, normal, false)
            let (pointA, pointB) = closestSegmentPoints(edgeA.start, edgeA.end, edgeB.start, edgeB.end)
            return [(point: (0..<3).map { (pointA[$0] + pointB[$0]) / 2 },
                     feature: "\(edgeA.feature)|\(edgeB.feature)")]
        }
        let verticesA = boxVertices(a), verticesB = boxVertices(b)
        var supportA = -Double.infinity, supportB = Double.infinity
        for v in verticesA { supportA = max(supportA, dot3(v, normal)) }
        for v in verticesB { supportB = min(supportB, dot3(v, normal)) }
        let plane = (supportA + supportB) / 2
        if let clipped = clippedFaceManifold(a, b, normal, plane) { return clipped }
        var candidates: [(point: [Double], feature: String)] = []
        for (index, point) in verticesA.enumerated()
            where supportA - dot3(point, normal) <= depth + slop && pointInsideBox(point, b, depth + slop) {
            candidates.append((point: point, feature: "a\(index)"))
        }
        for (index, point) in verticesB.enumerated()
            where dot3(point, normal) - supportB <= depth + slop && pointInsideBox(point, a, depth + slop) {
            candidates.append((point: point, feature: "b\(index)"))
        }
        var points: [(point: [Double], feature: String)] = []
        for candidate in candidates {
            let distance = dot3(candidate.point, normal) - plane
            let point = (0..<3).map { candidate.point[$0] - normal[$0] * distance }
            if !points.contains(where: { length3(subtract3($0.point, point)) <= 1e-7 }) {
                points.append((point: point, feature: candidate.feature))
            }
        }
        if points.count > 4 {
            var selected = [points[0]]
            while selected.count < 4 {
                var best: (entry: (point: [Double], feature: String), distance: Double)?
                for entry in points {
                    if selected.contains(where: { $0.feature == entry.feature }) { continue }
                    var nearest = Double.infinity
                    for chosen in selected {
                        let delta = subtract3(entry.point, chosen.point)
                        nearest = min(nearest, dot3(delta, delta))
                    }
                    if best == nil || nearest > best!.distance { best = (entry: entry, distance: nearest) }
                }
                selected.append(best!.entry)
            }
            return selected
        }
        if !points.isEmpty { return points }
        let onA = closestPointOnBox(b.position, a), onB = closestPointOnBox(a.position, b)
        return [(point: (0..<3).map { (onA[$0] + onB[$0]) / 2 }, feature: "fallback")]
    }

    private static func layersCollide(_ a: ScenePhysicsBody, _ b: ScenePhysicsBody) -> Bool {
        if let collides = a.collides, !collides.contains(b.layer) { return false }
        if let collides = b.collides, !collides.contains(a.layer) { return false }
        return true
    }

    /// depth per the P5 collide corpus; normal points FROM a TOWARD b. Ties take the
    /// smallest axis index; axis sign is sign(centerB − centerA) with ties +1.
    static func contact(_ a: ScenePhysicsBody, _ b: ScenePhysicsBody)
        -> (depth: Double, normal: [Double], point: [Double], points: [[Double]], features: [String])? {
        if a.shape == "sphere", b.shape == "sphere" {
            let d = [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]]
            let dist = length3(d)
            let depth = a.radius + b.radius - dist
            if depth <= 0 { return nil }
            let normal = dist == 0 ? [0.0, 1.0, 0.0] : [d[0] / dist, d[1] / dist, d[2] / dist]
            let point = (0..<3).map {
                (a.position[$0] + normal[$0] * a.radius + b.position[$0] - normal[$0] * b.radius) / 2
            }
            return (depth: depth, normal: normal, point: point, points: [point], features: ["sphere"])
        }
        if a.shape == "box", b.shape == "box" {
            let axesA = bodyAxes(a), axesB = bodyAxes(b)
            let delta = subtract3(b.position, a.position)
            var depth = Double.infinity
            var normal = [0.0, 0.0, 0.0]
            var candidates: [(axis: [Double], winner: SatWinner)] = []
            for (index, axis) in axesA.enumerated() { candidates.append((axis, .faceA(index))) }
            for (index, axis) in axesB.enumerated() { candidates.append((axis, .faceB(index))) }
            for (axisAIndex, axisA) in axesA.enumerated() {
              for (axisBIndex, axisB) in axesB.enumerated() {
                let axis = cross3(axisA, axisB), length = length3(axis)
                if length > 1e-9 {
                    candidates.append((axis.map { $0 / length }, .edge(axisAIndex, axisBIndex)))
                }
            }}
            var winner = SatWinner.faceA(0)
            for candidate in candidates {
                let axis = candidate.axis
                var radiusA = 0.0, radiusB = 0.0
                for i in 0..<3 {
                    radiusA += a.half[i] * abs(dot3(axis, axesA[i]))
                    radiusB += b.half[i] * abs(dot3(axis, axesB[i]))
                }
                let distance = dot3(delta, axis)
                let overlap = radiusA + radiusB - abs(distance)
                if overlap <= 0 { return nil }
                if overlap < depth {
                    depth = overlap
                    normal = distance >= 0 ? axis : axis.map { -$0 }
                    winner = candidate.winner
                }
            }
            let manifold = boxManifoldPoints(a, b, normal, depth, winner)
            let points = manifold.map(\.point)
            return (depth: depth, normal: normal, point: points[0], points: points,
                    features: manifold.map(\.feature))
        }
        let sphere = a.shape == "sphere" ? a : b
        let box = a.shape == "box" ? a : b
        let axes = bodyAxes(box)
        let local = subtract3(sphere.position, box.position)
        var qLocal = (0..<3).map { min(max(dot3(local, axes[$0]), -box.half[$0]), box.half[$0]) }
        var q = box.position
        for i in 0..<3 { for k in 0..<3 { q[k] += axes[i][k] * qLocal[i] } }
        let d = [sphere.position[0] - q[0], sphere.position[1] - q[1], sphere.position[2] - q[2]]
        let dist = length3(d)
        let depth: Double
        var towardSphere: [Double]
        if dist > 0 {
            depth = sphere.radius - dist
            if depth <= 0 { return nil }
            towardSphere = [d[0] / dist, d[1] / dist, d[2] / dist]
        } else {
            var inside = Double.infinity
            var axis = -1
            for i in 0..<3 {
                let toFace = box.half[i] - abs(dot3(local, axes[i]))
                if toFace < inside { inside = toFace; axis = i }
            }
            depth = sphere.radius + inside
            let sign = dot3(local, axes[axis]) >= 0 ? 1.0 : -1.0
            towardSphere = axes[axis].map { $0 * sign }
            qLocal[axis] = box.half[axis] * sign
            q = box.position
            for i in 0..<3 { for k in 0..<3 { q[k] += axes[i][k] * qLocal[i] } }
        }
        return a.shape == "sphere"
            ? (depth: depth, normal: [-towardSphere[0], -towardSphere[1], -towardSphere[2]], point: q, points: [q], features: ["sphere-box"])
            : (depth: depth, normal: towardSphere, point: q, points: [q], features: ["sphere-box"])
    }

    private static func inverseInertiaWorld(_ body: ScenePhysicsBody, _ value: [Double]) -> [Double] {
        if body.mode2d { return [0, 0, value[2] * body.invInertia[2]] }
        return bodyInertiaMatrices(body).inverse.map { dot3($0, value) }
    }

    private static func inertiaWorld(_ body: ScenePhysicsBody, _ value: [Double]) -> [Double] {
        if body.mode2d {
            let inertia = body.invInertia[2] > 0 ? 1 / body.invInertia[2] : 0
            return [0, 0, value[2] * inertia]
        }
        return bodyInertiaMatrices(body).tensor.map { dot3($0, value) }
    }

    private static func pointVelocity(_ body: ScenePhysicsBody, _ r: [Double]) -> [Double] {
        let angular = cross3(body.angularVelocity, r)
        return (0..<3).map { body.velocity[$0] + angular[$0] }
    }

    private static func impulseDenominator(
        _ body: ScenePhysicsBody, _ r: [Double], _ direction: [Double],
        _ effectiveInvMass: Double? = nil
    ) -> Double {
        let effective = effectiveInvMass ?? body.invMass
        // A sleeping dynamic is solver-static while its stored mass/inertia remain
        // intact for a later wake.
        if effective == 0 { return 0 }
        let rxn = cross3(r, direction)
        return effective + dot3(direction, cross3(inverseInertiaWorld(body, rxn), r))
    }

    private static func applyImpulse(
        _ body: ScenePhysicsBody, _ r: [Double], _ impulse: [Double], _ sign: Double,
        _ effectiveInvMass: Double? = nil
    ) {
        let effective = effectiveInvMass ?? body.invMass
        if effective == 0 { return }
        for i in 0..<3 { body.velocity[i] += impulse[i] * effective * sign }
        let angular = inverseInertiaWorld(body, cross3(r, impulse))
        for i in 0..<3 { body.angularVelocity[i] += angular[i] * sign }
    }

    // ── the step (THE STEP ORDER — pinned in the corpus _note, mirrored verbatim) ────

    private static func pairKey(_ a: String, _ b: String) -> String { a + "\u{0000}" + b }   // NUL, the TS twin's separator — ids may contain spaces

    static func step(_ world: ScenePhysicsWorld,
                     intents: [String: ScenePhysicsIntent] = [:]) -> ScenePhysicsStepResult {
        let g = world.gravity
        let dt = Self.dt
        // 1 ── kinematic drive: position from the authored/bound plane, velocity derived
        for b in world.bodies where b.kind == "kinematic" {
            b.previous = b.position
            b.previousRotation = b.rotation
            if let p = intents[b.id]?.position {
                if p[0] != b.position[0] || p[1] != b.position[1] || p[2] != b.position[2] {
                    invalidateContactCache(world, b.id)
                }
                b.velocity = [(p[0] - b.position[0]) / dt, (p[1] - b.position[1]) / dt, (p[2] - b.position[2]) / dt]
                b.position = p
            } else {
                b.velocity = [0, 0, 0]
            }
            if let rotation = intents[b.id]?.rotation {
                if rotation[0] != b.rotation[0] || rotation[1] != b.rotation[1] || rotation[2] != b.rotation[2] {
                    invalidateContactCache(world, b.id)
                }
                let targetOrientation = quaternionFromEuler(rotation)
                b.angularVelocity = shortestArcAngularVelocity(b.orientation, targetOrientation, dt)
                b.rotation = rotation
                b.orientation = targetOrientation
            } else {
                b.angularVelocity = [0, 0, 0]
            }
        }
        if world.mode2d {
            for b in world.bodies {
                b.angularVelocity[0] = 0
                b.angularVelocity[1] = 0
            }
        }
        // 2 ── character intent · 3 ── integrate (semi-implicit Euler: v += g·dt, x += v·dt)
        for b in world.bodies {
            if b.kind == "static" || b.kind == "kinematic" || b.sleeping { continue }
            if b.kind == "character" {
                let move = intents[b.id]?.move
                var mx = move?[0] ?? 0
                var mz = move?[1] ?? 0
                let ln = (mx * mx + mz * mz).squareRoot()
                if ln > 1 { mx /= ln; mz /= ln }
                b.velocity[0] = mx * b.speed
                b.velocity[2] = mz * b.speed
            }
            b.previous = b.position
            b.previousRotation = b.rotation
            b.velocity[0] += g[0] * dt
            b.velocity[1] += g[1] * dt
            b.velocity[2] += g[2] * dt
            b.position[0] += b.velocity[0] * dt
            b.position[1] += b.velocity[1] * dt
            b.position[2] += b.velocity[2] * dt
            if b.kind == "dynamic" {
                let drag = max(0, 1 - b.angularDamping * dt)
                var angularMomentum = inertiaWorld(b, b.angularVelocity)
                for k in 0..<3 {
                    angularMomentum[k] = (angularMomentum[k] + b.torque[k] * dt) * drag
                }
                b.angularVelocity = inverseInertiaWorld(b, angularMomentum)
                integrateOrientation(b, dt)
                b.angularVelocity = inverseInertiaWorld(b, angularMomentum)
            }
        }
        // 4 ── solid pass: pairs in document order (i < j)
        var solidNow: [(String, String)] = []
        let bodies = world.bodies
        var solverContacts: [ScenePhysicsSolverContact] = []
        for i in 0..<bodies.count {
            for j in (i + 1)..<bodies.count {
                let a = bodies[i]
                let b = bodies[j]
                if a.trigger || b.trigger { continue }
                let aStill = a.kind == "static" || a.kind == "kinematic"
                let bStill = b.kind == "static" || b.kind == "kinematic"
                if aStill && bStill { continue }
                if a.kind == "character" && b.kind == "character" { continue }   // named non-interaction
                if (a.kind == "character" && bStill) || (b.kind == "character" && aStill) { continue }   // pass 5
                if !layersCollide(a, b) { continue }
                guard let c = contact(a, b) else { continue }
                let depth = c.depth
                var n = c.normal
                if world.mode2d {
                    let planarLength = (n[0] * n[0] + n[1] * n[1]).squareRoot()
                    if planarLength <= 1e-12 { continue }
                    n = [n[0] / planarLength, n[1] / planarLength, 0]
                }
                solidNow.append((a.id, b.id))
                // the wake law
                for (s, o) in [(a, b), (b, a)] {
                    if s.kind == "dynamic", s.sleeping {
                        // energetic contact ONLY: a kinematic wakes a sleeper when it
                        // is MOVING — a stationary platform must let the world sleep
                        let surfaceVelocity = pointVelocity(o, subtract3(c.point, o.position))
                        let surfaceSpeed = world.mode2d
                            ? (surfaceVelocity[0] * surfaceVelocity[0]
                               + surfaceVelocity[1] * surfaceVelocity[1]).squareRoot()
                            : length3(surfaceVelocity)
                        // Quiet awake neighbours already accumulating sleep ticks are
                        // resting supports, not new impactors with a gravity-step speed.
                        let energeticDynamic = o.kind == "dynamic" && !o.sleeping
                            && o.sleepCount == 0
                        if o.kind == "character" ||
                            ((o.kind == "kinematic" || energeticDynamic)
                                && surfaceSpeed > sleepSpeed) {
                            s.sleeping = false
                            s.sleepCount = 0
                        }
                    }
                }
                // Sleepers remain solid immutable supports; omitting the pair makes a
                // staggered stack lose its floor for a tick and wake repeatedly.
                let invA = a.kind == "character" || (a.kind == "dynamic" && a.sleeping)
                    ? 0 : a.invMass
                let invB = b.kind == "character" || (b.kind == "dynamic" && b.sleeping)
                    ? 0 : b.invMass
                let invSum = invA + invB
                if invSum == 0 { continue }
                var constraints: [ScenePhysicsPointConstraint] = []
                for (pointIndex, point) in c.points.enumerated() {
                    let key = pairKey(a.id, b.id) + "\u{0000}" + c.features[pointIndex]
                    let localAnchorA = localContactAnchor(point, a)
                    let localAnchorB = localContactAnchor(point, b)
                    let cached: ScenePhysicsCachedImpulse
                    if let existing = world.contactCache[key] {
                        cached = existing
                        if dot3(cached.normalAxis, n) < 0.95
                            || length3(subtract3(cached.localAnchorA, localAnchorA)) > 0.02
                            || length3(subtract3(cached.localAnchorB, localAnchorB)) > 0.02 {
                            cached.normal = 0
                            cached.tangent = [0, 0, 0]
                        }
                    } else {
                        cached = ScenePhysicsCachedImpulse(
                            a: a.id, b: b.id, normal: 0, normalAxis: n,
                            tangent: [0, 0, 0], localAnchorA: localAnchorA,
                            localAnchorB: localAnchorB, lastTick: world.tick)
                        world.contactCache[key] = cached
                    }
                    cached.normalAxis = n
                    cached.localAnchorA = localAnchorA
                    cached.localAnchorB = localAnchorB
                    cached.lastTick = world.tick
                    let rA = subtract3(point, a.position), rB = subtract3(point, b.position)
                    let approach = dot3(subtract3(pointVelocity(b, rB), pointVelocity(a, rA)), n)
                    let restitution = -approach > restitutionMinSpeed ? max(a.bounce, b.bounce) : 0
                    let target = approach < 0 ? -restitution * approach : 0
                    constraints.append(ScenePhysicsPointConstraint(
                        rA: rA, rB: rB, cached: cached, target: target,
                        normalDenominator: impulseDenominator(a, rA, n, invA)
                            + impulseDenominator(b, rB, n, invB)))
                }
                solverContacts.append(ScenePhysicsSolverContact(
                    a: a, b: b, depth: depth, n: n, invA: invA, invB: invB,
                    invSum: invSum, constraints: constraints))
            }
        }
        for solver in solverContacts {
            for constraint in solver.constraints {
                let tangentNormal = dot3(constraint.cached.tangent, solver.n)
                for k in 0..<3 {
                    constraint.cached.tangent[k] -= solver.n[k] * tangentNormal
                }
                let warm = (0..<3).map {
                    solver.n[$0] * constraint.cached.normal + constraint.cached.tangent[$0]
                }
                applyImpulse(solver.a, constraint.rA, warm, -1, solver.invA)
                applyImpulse(solver.b, constraint.rB, warm, 1, solver.invB)
            }
        }
        for _ in 0..<manifoldIterations {
            for solver in solverContacts {
                for constraint in solver.constraints {
                    let rel = dot3(subtract3(pointVelocity(solver.b, constraint.rB),
                                             pointVelocity(solver.a, constraint.rA)), solver.n)
                    let deltaNormal = constraint.normalDenominator > 0
                        ? (constraint.target - rel) / constraint.normalDenominator : 0
                    let previousNormal = constraint.cached.normal
                    constraint.cached.normal = max(previousNormal + deltaNormal, 0)
                    let appliedNormal = constraint.cached.normal - previousNormal
                    let normalImpulse = solver.n.map { $0 * appliedNormal }
                    applyImpulse(solver.a, constraint.rA, normalImpulse, -1, solver.invA)
                    applyImpulse(solver.b, constraint.rB, normalImpulse, 1, solver.invB)
                    let rv = subtract3(pointVelocity(solver.b, constraint.rB),
                                       pointVelocity(solver.a, constraint.rA))
                    let rn = dot3(rv, solver.n)
                    let t = [rv[0] - solver.n[0] * rn,
                             rv[1] - solver.n[1] * rn,
                             world.mode2d ? 0 : rv[2] - solver.n[2] * rn]
                    let tl = length3(t)
                    if tl > 1e-9 {
                        let tn = t.map { $0 / tl }
                        if dot3(constraint.tangentAxis, tn) < 0.999999 {
                            constraint.tangentAxis = tn
                            constraint.tangentDenominator = impulseDenominator(
                                solver.a, constraint.rA, tn, solver.invA)
                                + impulseDenominator(solver.b, constraint.rB, tn, solver.invB)
                        }
                        let deltaTangent = constraint.tangentDenominator > 0
                            ? -dot3(rv, tn) / constraint.tangentDenominator : 0
                        let previousTangent = constraint.cached.tangent
                        for k in 0..<3 {
                            constraint.cached.tangent[k] += tn[k] * deltaTangent
                        }
                        let tangentProjection = dot3(constraint.cached.tangent, solver.n)
                        for k in 0..<3 {
                            constraint.cached.tangent[k] -= solver.n[k] * tangentProjection
                        }
                        let cap = (solver.a.friction * solver.b.friction).squareRoot()
                            * constraint.cached.normal
                        let tangentLength = length3(constraint.cached.tangent)
                        if tangentLength > cap && tangentLength > 0 {
                            let scale = cap / tangentLength
                            for k in 0..<3 { constraint.cached.tangent[k] *= scale }
                        }
                        let tangentImpulse = subtract3(constraint.cached.tangent, previousTangent)
                        applyImpulse(solver.a, constraint.rA, tangentImpulse, -1, solver.invA)
                        applyImpulse(solver.b, constraint.rB, tangentImpulse, 1, solver.invB)
                    }
                }
            }
        }
        for solver in solverContacts {
            let corr = correctionPercent * max(solver.depth - slop, 0) / solver.invSum
            for k in 0..<3 {
                solver.a.position[k] -= solver.n[k] * (corr * solver.invA)
                solver.b.position[k] += solver.n[k] * (corr * solver.invB)
            }
        }
        // 5 ── character move-and-slide vs static/kinematic (full depenetration, deepest first)
        for ch in bodies where ch.kind == "character" {
            ch.grounded = false
            for _ in 0..<slideIterations {
                var best: (c: (depth: Double, normal: [Double], point: [Double],
                                points: [[Double]], features: [String]),
                           other: ScenePhysicsBody)?
                for other in bodies {
                    if (other.kind != "static" && other.kind != "kinematic") || other.trigger { continue }
                    if !layersCollide(ch, other) { continue }
                    guard let c = contact(ch, other) else { continue }
                    if best == nil || c.depth > best!.c.depth { best = (c: c, other: other) }
                }
                guard let hit = best else { break }
                let depth = hit.c.depth
                let n = hit.c.normal
                solidNow.append(ch.index < hit.other.index ? (ch.id, hit.other.id) : (hit.other.id, ch.id))
                for k in 0..<3 { ch.position[k] -= n[k] * depth }
                let vn = ch.velocity[0] * n[0] + ch.velocity[1] * n[1] + ch.velocity[2] * n[2]
                if vn > 0 {
                    for k in 0..<3 { ch.velocity[k] -= n[k] * vn }
                }
                if -n[1] > groundNormalY { ch.grounded = true }
            }
        }
        // 6 ── trigger overlaps (exactly one trigger per pair; no forces)
        var triggerNow: [(String, String)] = []
        for i in 0..<bodies.count {
            for j in (i + 1)..<bodies.count {
                let a = bodies[i]
                let b = bodies[j]
                if a.trigger == b.trigger { continue }
                if !layersCollide(a, b) { continue }
                if contact(a, b) != nil { triggerNow.append((a.id, b.id)) }
            }
        }
        // 7 ── events (enter-tracker semantics, both directions per pair)
        var collisions: [ScenePhysicsPairEvent] = []
        var enters: [ScenePhysicsPairEvent] = []
        var exits: [ScenePhysicsPairEvent] = []
        var seenSolid: Set<String> = []
        for (pa, pb) in solidNow {
            let key = pairKey(pa, pb)
            if seenSolid.contains(key) { continue }
            seenSolid.insert(key)
            if !world.solidOverlap.contains(key) {
                collisions.append(ScenePhysicsPairEvent(id: pa, other: pb))
                collisions.append(ScenePhysicsPairEvent(id: pb, other: pa))
            }
        }
        world.solidOverlap = seenSolid
        let triggerSet = Set(triggerNow.map { pairKey($0.0, $0.1) })
        for (pa, pb) in triggerNow {
            if !world.triggerOverlap.contains(pairKey(pa, pb)) {
                enters.append(ScenePhysicsPairEvent(id: pa, other: pb))
                enters.append(ScenePhysicsPairEvent(id: pb, other: pa))
            }
        }
        for key in world.triggerOrder where !triggerSet.contains(key) {
            let parts = key.split(separator: "\u{0000}").map(String.init)
            exits.append(ScenePhysicsPairEvent(id: parts[0], other: parts[1]))
            exits.append(ScenePhysicsPairEvent(id: parts[1], other: parts[0]))
        }
        world.triggerOrder = world.triggerOrder.filter { triggerSet.contains($0) }
        for (pa, pb) in triggerNow {
            let key = pairKey(pa, pb)
            if !world.triggerOrder.contains(key) { world.triggerOrder.append(key) }
        }
        world.triggerOverlap = triggerSet
        // 8 ── sleep pass (dynamic only; characters and kinematics never sleep)
        for b in bodies {
            if b.kind != "dynamic" || b.sleeping { continue }
            if length3(b.velocity) < sleepSpeed && length3(b.angularVelocity) < sleepSpeed
                && length3(b.torque) == 0 {
                b.sleepCount += 1
                if b.sleepCount >= sleepTicks {
                    b.sleeping = true
                    b.velocity = [0, 0, 0]
                    b.angularVelocity = [0, 0, 0]
                }
            } else {
                b.sleepCount = 0
            }
        }
        // 8.5 ── G6 THE Z-LOCK PASS (mode="2d" only): the last act of every step
        // re-pins z translation and authored X/Y orientation. Angular solve DOFs were
        // already masked to world Z throughout integration and constraint resolution.
        if world.mode2d {
            for b in bodies {
                b.position[2] = b.zLock
                b.previous[2] = b.zLock
                b.velocity[2] = b.vzLock
                b.rotation[0] = b.rotation2dLock[0]
                b.rotation[1] = b.rotation2dLock[1]
                b.previousRotation[0] = b.rotation2dLock[0]
                b.previousRotation[1] = b.rotation2dLock[1]
                b.angularVelocity[0] = 0
                b.angularVelocity[1] = 0
                b.orientation = quaternionFromEuler(b.rotation)
            }
        }
        world.contactCache = world.contactCache.filter { $0.value.lastTick == world.tick }
        let tick = world.tick
        world.tick += 1
        return ScenePhysicsStepResult(tick: tick, dt: dt, collisions: collisions, enters: enters, exits: exits)
    }

    // ── the accumulator fold + interpolation (THE FIXED-TICK LAW's render half) ──────

    /// the pure fold the corpus pins: frame durations in MILLISECONDS → per-frame
    /// steps and alpha (the runner divides by 1000 exactly as the surface does)
    static func schedule(_ framesMs: [Double]) -> [(steps: Int, alpha: Double)] {
        let accumulator = ScenePhysicsAccumulator()
        return framesMs.map { accumulator.advance(frameSeconds: $0 / 1000) }
    }

    /// THE INTERPOLATION LAW: rendered = prev + (curr − prev)·alpha, componentwise
    static func interpolate(prev: [Double], curr: [Double], alpha: Double) -> [Double] {
        [prev[0] + (curr[0] - prev[0]) * alpha,
         prev[1] + (curr[1] - prev[1]) * alpha,
         prev[2] + (curr[2] - prev[2]) * alpha]
    }

    // ── extraction from the IR (the world law — corpus `world` cases) ────────────────

    private static func isIdentity(_ m: [Double]) -> Bool {
        let identity = SceneMath.identity()
        for i in 0..<16 where abs(m[i] - identity[i]) > 1e-9 { return false }
        return true
    }

    private static func largestBasis(_ m: [Double]) -> Double {
        max((m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).squareRoot(),
            (m[4] * m[4] + m[5] * m[5] + m[6] * m[6]).squareRoot(),
            (m[8] * m[8] + m[9] * m[9] + m[10] * m[10]).squareRoot())
    }

    private static func basisScales(_ m: [Double]) -> [Double] {
        [(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).squareRoot(),
         (m[4] * m[4] + m[5] * m[5] + m[6] * m[6]).squareRoot(),
         (m[8] * m[8] + m[9] * m[9] + m[10] * m[10]).squareRoot()]
    }

    /** Root-frame Rz*Ry*Rx rotation. Transformed-parent shear is diagnosed; a stable
     * Gram-Schmidt frame keeps the collider deterministic at that boundary. */
    private static func rootRotation(_ m: [Double], _ reference: [Double]) -> [Double] {
        let scales = basisScales(m)
        var x = scales[0] > 0 ? [m[0] / scales[0], m[1] / scales[0], m[2] / scales[0]] : [1, 0, 0]
        let rawY = scales[1] > 0 ? [m[4] / scales[1], m[5] / scales[1], m[6] / scales[1]] : [0, 1, 0]
        let xy = dot3(rawY, x)
        var y = [rawY[0] - x[0] * xy, rawY[1] - x[1] * xy, rawY[2] - x[2] * xy]
        let yl = length3(y)
        y = yl > 1e-9 ? y.map { $0 / yl } : [0, 1, 0]
        var z = cross3(x, y)
        let rawZ = scales[2] > 0 ? [m[8] / scales[2], m[9] / scales[2], m[10] / scales[2]] : [0, 0, 1]
        if dot3(z, rawZ) < 0 { z = z.map { -$0 } }
        x = cross3(y, z)
        let ry = asin(max(-1, min(1, -x[2]))), cy = cos(ry)
        let rx = abs(cy) > 1e-9 ? atan2(y[2], z[2]) : atan2(-z[1], y[1])
        let rz = abs(cy) > 1e-9 ? atan2(x[1], x[0]) : 0
        return [unwrapDegrees(rx * radiansToDegrees, reference[0]),
                unwrapDegrees(ry * radiansToDegrees, reference[1]),
                unwrapDegrees(rz * radiansToDegrees, reference[2])]
    }

    private static func orientedHalfFromWorld(_ m: [Double], _ localHalf: [Double],
                                              _ rotation: [Double]) -> [Double] {
        let axes = quaternionAxes(quaternionFromEuler(rotation))
        let center = [m[12], m[13], m[14]]
        var half = [0.0, 0.0, 0.0]
        for sx in [-1.0, 1.0] { for sy in [-1.0, 1.0] { for sz in [-1.0, 1.0] {
            let corner = SceneMath.transformPoint(m, [localHalf[0] * sx,
                                                      localHalf[1] * sy,
                                                      localHalf[2] * sz])
            let delta = subtract3(corner, center)
            for i in 0..<3 { half[i] = max(half[i], abs(dot3(delta, axes[i]))) }
        }}}
        return half
    }

    /// a model's auto SPHERE collider radius from its local half extents (the
    /// bounding-sphere convention: half-diagonal)
    // ── the parent-frame law (G2 × G1) ───────────────────────────────────────────
    //
    // Bodies SIMULATE in scene-root space (extraction freezes each body's WORLD
    // position; a transformed parent is diagnosed, not obeyed). But a node's authored
    // `position` is LOCAL to its parent, and the renderer composes parentWorld · local.
    // So the solver's root-space result must be expressed in the parent's frame before
    // it lands on the node, and an authored/bus position write must be lifted out of
    // that frame before it teleports the body. Without this pair every body under a
    // transformed parent — which a G1 prefab instance ALWAYS is — renders
    // double-offset. Both are identities at the scene root (the callers' fast path).
    // Corpus: physics.json `parentframe`.

    /// root-space → the parent's local frame (what the node's `position` must hold)
    static func toLocal(_ rootPosition: [Double], parentWorld: [Double]?) -> [Double] {
        guard let parentWorld else { return rootPosition }
        guard let inverse = SceneMath.invert(parentWorld) else { return rootPosition }
        return SceneMath.transformPoint(inverse, rootPosition)
    }

    /// the parent's local frame → root space (what a position write means to the solver)
    static func toRoot(_ localPosition: [Double], parentWorld: [Double]?) -> [Double] {
        guard let parentWorld else { return localPosition }
        return SceneMath.transformPoint(parentWorld, localPosition)
    }

    /// local DSX Euler rotation -> solver root orientation through the same stable
    /// orthonormal extraction used for colliders.
    static func rotationToRoot(_ localRotation: [Double], parentWorld: [Double]?,
                               reference: [Double]? = nil) -> [Double] {
        guard let parentWorld else { return localRotation }
        let local = SceneMath.trs(position: [0, 0, 0], rotationDeg: localRotation, scale: [1, 1, 1])
        return rootRotation(SceneMath.multiply(parentWorld, local), reference ?? localRotation)
    }

    /// solver root orientation -> node-local DSX Euler rotation.
    static func rotationToLocal(_ root: [Double], parentWorld: [Double]?,
                                reference: [Double]? = nil) -> [Double] {
        guard let parentWorld, let inverse = SceneMath.invert(parentWorld) else { return root }
        let rootMatrix = SceneMath.trs(position: [0, 0, 0], rotationDeg: root, scale: [1, 1, 1])
        return rootRotation(SceneMath.multiply(inverse, rootMatrix), reference ?? root)
    }

    private static func sphereRadiusOfHalf(_ half: [Double]) -> Double {
        (half[0] * half[0] + half[1] * half[1] + half[2] * half[2]).squareRoot()
    }

    /// THE GRAVITY LAW: `<scene gravity="x y z">`, default 0 −9.81 0, malformed →
    /// default with one diagnostic (Article 7)
    static func gravity(_ ir: SceneIR, _ resolve: SceneResolve,
                        _ diag: ((SceneDiagnostic) -> Void)? = nil) -> [Double] {
        SceneIRKit.readVec(nil, "gravity", defaultGravity, resolve, diag, ir.attrs)
    }

    /// extract every physics body from the scene tree. THE EXTRACTION LAWS:
    /// - a `physics` word outside static|dynamic|kinematic|character is NOT a body
    ///   (one diagnostic); only box/sphere/plane/model nodes are eligible (one
    ///   diagnostic);
    /// - colliders derive from the authored world transform ONCE (the freeze law):
    ///   collider="auto" → sphere from `<sphere>` (bounding-sphere law), world AABB
    ///   from box/plane/model bounds; explicit collider="sphere"|"box" per the P5
    ///   collider laws; another word → auto with one diagnostic;
    /// - bodies without an id get `#N` (1-based, extraction order);
    /// - a transformed ancestor draws ONE diagnostic and the body simulates in
    ///   scene-root space (v1 — bodies are root-frame citizens);
    /// - `modelHalf` supplies a loaded model's local half extents (renderer-owned;
    ///   [0.5, 0.5, 0.5] until known);
    /// - `childrenOf` lets the element substitute a bind group's LIVE rows for its
    ///   template children (the TS tree mutates in place; Swift's IR is immutable, so
    ///   the walk asks) — corpora and plain callers use the default.
    static func extract(_ ir: SceneIR, _ resolve: SceneResolve,
                        _ diag: ((SceneDiagnostic) -> Void)? = nil,
                        modelHalf: (SceneNode) -> [Double]? = { _ in nil },
                        childrenOf: (SceneNode) -> [SceneNode] = { $0.children })
        -> (gravity: [Double], bodies: [ScenePhysicsBodySpec], mode2d: Bool) {
        var bodies: [ScenePhysicsBodySpec] = []
        var serial = 0

        func extractBody(_ node: SceneNode, _ props: SceneNodeProps, _ world: [Double],
                         _ physicsRaw: String, _ parentTransformed: Bool) -> ScenePhysicsBodySpec? {
            guard kinds.contains(physicsRaw) else {
                diag?(SceneDiagnostic(code: "unknown-physics",
                                      message: "physics=\"\(physicsRaw)\" is not static, dynamic, kinematic or character — not a body"))
                return nil
            }
            guard eligibleKinds.contains(node.kind) else {
                diag?(SceneDiagnostic(code: "unknown-physics",
                                      message: "<\(node.kind)> cannot be a physics body — only box, sphere, plane, model and sprite"))
                return nil
            }
            if parentTransformed {
                diag?(SceneDiagnostic(code: "physics-nested",
                                      message: "a physics body under a transformed parent simulates in scene-root space (v1)"))
            }
            let colliderRaw = SceneIRKit.readString(node, "collider", "auto", resolve, node.attrs)
            var collider = colliderRaw
            // G6: `circle` is the 2D spelling of `sphere` (the sprite word) — one shape set
            if collider == "circle" { collider = "sphere" }
            if collider != "auto" && collider != "sphere" && collider != "box" {
                diag?(SceneDiagnostic(code: "unknown-collide",
                                      message: "collider=\"\(colliderRaw)\" is not auto, sphere, circle or box — using auto"))
                collider = "auto"
            }
            let shape: ScenePhysicsShape
            let position: [Double]
            if node.kind == "sprite" {
                // G6 THE SPRITE COLLIDER LAW: the quad's own rectangle, centered on the
                // QUAD (the anchor offset applied), extruded spriteColliderHalfZ in z so
                // a box↔box minimum-overlap axis always lands in the XY plane.
                // `collider="circle"` takes radius = half the SMALLER extent. The
                // RESOLVED `size` is what colliders read — the texture-aspect default is
                // a render-time refinement (the honest v1).
                let size = SceneSprite.sizeOf(props)
                let quadWorld = SceneMath.multiply(
                    world, SceneMath.trs(position: SceneSprite.anchorOffset(props, size[0], size[1]),
                                  rotationDeg: [0, 0, 0], scale: [1, 1, 1]))
                if collider == "sphere" {
                    shape = .sphere(radius: Swift.min(size[0], size[1]) / 2 * largestBasis(world))
                    position = [quadWorld[12], quadWorld[13], quadWorld[14]]
                } else {
                    let rotation = rootRotation(quadWorld, props.rotation)
                    position = [quadWorld[12], quadWorld[13], quadWorld[14]]
                    shape = .box(half: orientedHalfFromWorld(
                        quadWorld, [size[0] / 2, size[1] / 2, spriteColliderHalfZ], rotation))
                }
            } else if collider == "sphere" || (collider == "auto" && node.kind == "sphere") {
                let local = node.kind == "model"
                    ? sphereRadiusOfHalf(modelHalf(node) ?? [0.5, 0.5, 0.5])
                    : SceneIRKit.nodeBoundingRadius(node, props) ?? 0.5
                shape = .sphere(radius: local * largestBasis(world))
                position = [world[12], world[13], world[14]]
            } else {
                let localHalf: [Double]
                switch node.kind {
                case "box": localHalf = [props.boxSize[0] / 2, props.boxSize[1] / 2, props.boxSize[2] / 2]
                case "sphere": localHalf = [props.radius, props.radius, props.radius]
                case "plane": localHalf = [props.planeSize[0] / 2, props.planeSize[1] / 2, 0]
                default: localHalf = modelHalf(node) ?? [0.5, 0.5, 0.5]
                }
                let rotation = rootRotation(world, props.rotation)
                position = [world[12], world[13], world[14]]
                shape = .box(half: orientedHalfFromWorld(world, localHalf, rotation))
            }
            serial += 1
            var mass = physicsRaw == "dynamic"
                ? SceneIRKit.readScalar(node, "mass", 1, resolve, diag, node.attrs) : 1
            if mass <= 0 {
                diag?(SceneDiagnostic(code: "malformed-number",
                                      message: "mass=\"\(JSE.string(mass))\" is not positive — using 1"))
                mass = 1
            }
            let bounceRaw = SceneIRKit.readScalar(node, "bounce", 0, resolve, diag, node.attrs)
            let frictionRaw = SceneIRKit.readScalar(node, "friction", 0.5, resolve, diag, node.attrs)
            let collidesRaw: String? = node.attrs["collides"] == nil
                ? nil : SceneIRKit.readString(node, "collides", "", resolve, node.attrs)
            return ScenePhysicsBodySpec(
                id: node.id ?? "#\(serial)",
                kind: physicsRaw,
                shape: shape,
                position: position,
                velocity: SceneIRKit.readVec(node, "velocity", [0, 0, 0], resolve, diag, node.attrs),
                rotation: rootRotation(world, props.rotation),
                angularVelocity: SceneIRKit.readVec(
                    node, "angular-velocity", [0, 0, 0], resolve, diag, node.attrs),
                torque: SceneIRKit.readVec(node, "torque", [0, 0, 0], resolve, diag, node.attrs),
                angularDamping: max(SceneIRKit.readScalar(
                    node, "angular-damping", defaultAngularDamping, resolve, diag, node.attrs), 0),
                mass: mass,
                bounce: min(max(bounceRaw, 0), 1),
                friction: max(frictionRaw, 0),
                trigger: SceneIRKit.readString(node, "trigger", "", resolve, node.attrs) == "true",
                layer: SceneIRKit.readString(node, "layer", "default", resolve, node.attrs),
                collides: collidesRaw.map { raw in
                    raw.split(whereSeparator: { $0.isWhitespace }).map(String.init)
                },
                speed: physicsRaw == "character"
                    ? SceneIRKit.readScalar(node, "speed", defaultSpeed, resolve, diag, node.attrs) : defaultSpeed,
                jump: physicsRaw == "character"
                    ? SceneIRKit.readScalar(node, "jump", defaultJump, resolve, diag, node.attrs) : defaultJump,
                node: node)
        }

        func walk(_ nodes: [SceneNode], _ parent: [Double], _ parentTransformed: Bool) {
            for node in nodes {
                if node.kind == "animate" { continue }
                let props = SceneIRKit.resolvedProps(node, resolve, diag)
                let world = SceneMath.multiply(
                    parent, SceneMath.trs(position: props.position, rotationDeg: props.rotation, scale: props.scale))
                let physicsRaw = node.attrs["physics"] == nil
                    ? "" : SceneIRKit.readString(node, "physics", "", resolve, node.attrs)
                if !physicsRaw.isEmpty {
                    if let body = extractBody(node, props, world, physicsRaw, parentTransformed) {
                        bodies.append(body)
                    }
                }
                walk(childrenOf(node), world, parentTransformed || !isIdentity(world))
            }
        }
        walk(ir.nodes, SceneMath.identity(), false)
        // G6: the scene's mode is "2d" — the world this extraction builds carries the z-lock
        return (gravity: gravity(ir, resolve, diag), bodies: bodies, mode2d: ir.mode == "2d")
    }

    /// a loaded model's local half extents for the G2 auto collider — symmetric about
    /// the node origin (v1: half = max |coordinate| per axis over every
    /// draw-transformed vertex; an asymmetric model gets the symmetric hull, the
    /// honest approximation)
    static func modelHalfExtents(_ model: GlbModel) -> [Double] {
        var half = [0.0, 0.0, 0.0]
        for draw in model.draws where draw.mesh < model.meshes.count {
            let m = draw.world
            for primitive in model.meshes[draw.mesh].primitives {
                let positions = primitive.positions
                var i = 0
                while i + 2 < positions.count {
                    let lx = positions[i], ly = positions[i + 1], lz = positions[i + 2]
                    let x = m[0] * lx + m[4] * ly + m[8] * lz + m[12]
                    let y = m[1] * lx + m[5] * ly + m[9] * lz + m[13]
                    let z = m[2] * lx + m[6] * ly + m[10] * lz + m[14]
                    if abs(x) > half[0] { half[0] = abs(x) }
                    if abs(y) > half[1] { half[1] = abs(y) }
                    if abs(z) > half[2] { half[2] = abs(z) }
                    i += 3
                }
            }
        }
        return half
    }
}
