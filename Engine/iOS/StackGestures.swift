//
//  StackGestures.swift - the U02 gesture family's renderer-neutral pure core.
//
//  Velocity derivation, the slop that separates a tap from a drag, swipe classification,
//  the pinch/rotate transform tracker, the gestureAxis claim, and the COMPOSITION
//  resolver behind `gesture=` / `gestureAxis=`. The law is the corpus:
//  OpenSource/Conformance/input/gestures.json (parity/U02-gestures.md), executed here by
//  GesturesConformance in the record lane and by the Kotlin (StackGestures.kt) and web
//  (@despia-native/dom gestures.ts) twins.
//
//  The split is the tooltip one: the SwiftUI/UIKit adapter owns raw touch delivery,
//  pointer identity, hover capability and recognizer arbitration
//  (shouldRecognizeSimultaneouslyWith / require(toFail:)), then reports normalized
//  samples here. Pure Foundation - no UIKit, no SwiftUI - so the same core compiles into
//  the extension render profile and the record lane.
//
//  Units are density-independent (points here, dp on Android, CSS px on web) and
//  velocities are units per SECOND. The phase vocabulary is the shipped on:drag one -
//  start | move | end - and a cancelled gesture delivers phase "end", already the
//  declared cross-renderer law for on:drag.
//
//  Article 7: a gesture whose input does not exist on a surface never fires there and
//  never degrades into a fake - `degradation` is that promise as data, diffed by all
//  three runners.
//

import Foundation

enum StackGestures {

    static let tapSlop: Double = 10
    static let axisSlop: Double = 10
    static let swipeMinDistance: Double = 24
    static let swipeMinVelocity: Double = 300
    static let velocityWindowMs: Double = 100
    static let velocitySamples: Int = 3
    static let pinchSlop: Double = 0.05
    static let rotateSlop: Double = 0.087

    /// Which continuous recognizer wins an exclusive contest, most specific first.
    static let precedence: [String] = ["pinch", "rotate", "pan", "scroll", "swipe", "longPress", "tap"]

    /// Recognizers that hold the touch for a while, and therefore compete with each other.
    static let continuous: Set<String> = ["pinch", "rotate", "pan", "scroll"]

    /// Recognizers an axis claim can eliminate.
    static let directional: Set<String> = ["pan", "scroll", "swipe"]

    /// Article 7 as data: what each gesture needs, and what must exist when it is absent.
    static let degradation: [[String: String]] = [
        ["gesture": "pinch", "requires": "multiTouch", "whenAbsent": "never-fires",
         "alternative": "scroll zoom= bounds, an on:adjust step, or explicit zoom controls"],
        ["gesture": "rotate", "requires": "multiTouch", "whenAbsent": "never-fires",
         "alternative": "an on:adjust step or explicit rotate controls"],
        ["gesture": "swipe", "requires": "touch", "whenAbsent": "never-fires",
         "alternative": "a visible control for the same action, never swipe-only"],
        ["gesture": "hover", "requires": "hoverPointer", "whenAbsent": "never-fires",
         "alternative": "content is never gated behind hover - the same content on tap or in place"],
        ["gesture": "press", "requires": "pointer", "whenAbsent": "never-fires",
         "alternative": "on:tap keeps working; press state is decoration"],
        ["gesture": "drag", "requires": "pointer", "whenAbsent": "never-fires",
         "alternative": "on:adjust plus a11yValue, which the linter requires anyway"],
    ]

    struct Sample1D { let t: Double; let value: Double }
    struct Sample2D { let t: Double; let x: Double; let y: Double }
    struct Point { let id: String; let x: Double; let y: Double }
    struct Swipe: Equatable { let direction: String; let velocity: Double; let distance: Double }

    /// The ONE velocity derivation every gesture uses. Weighted moving average over the
    /// samples inside the last `velocityWindowMs`, capped at `velocitySamples`, with the
    /// oldest surviving pair weighted 1 and each newer pair one more. A pair whose dt is
    /// not positive is DROPPED (never a divide by zero, never `.infinity`) while still
    /// consuming its recency weight; fewer than two usable samples is 0.
    static func velocity1D(_ samples: [Sample1D]) -> Double {
        guard samples.count >= 2, let lastT = samples.last?.t else { return 0 }
        let kept = samples.filter { lastT - $0.t <= velocityWindowMs }.suffix(velocitySamples)
        guard kept.count >= 2 else { return 0 }
        let list = Array(kept)
        var total: Double = 0
        var weightTotal: Double = 0
        var weight: Double = 0
        for i in 0..<(list.count - 1) {
            let a = list[i], b = list[i + 1]
            let dt = b.t - a.t
            weight += 1
            if dt <= 0 { continue }
            total += weight * ((b.value - a.value) / (dt / 1000))
            weightTotal += weight
        }
        return weightTotal == 0 ? 0 : total / weightTotal
    }

    /// velocity1D per axis - no second formula, so on:drag and the swipe gate cannot drift.
    static func velocity2D(_ samples: [Sample2D]) -> (vx: Double, vy: Double) {
        (velocity1D(samples.map { Sample1D(t: $0.t, value: $0.x) }),
         velocity1D(samples.map { Sample1D(t: $0.t, value: $0.y) }))
    }

    /// Direction classification at the end of a pan. The DOMINANT axis wins and an exact
    /// |dx| == |dy| diagonal breaks HORIZONTAL (the same tie-break `claimAxis` uses). Both
    /// gates read the chosen axis: distance >= swipeMinDistance and |velocity| >=
    /// swipeMinVelocity, which is what makes a slow drag not a swipe. An axis claim of x
    /// or y rejects the other axis outright.
    static func resolveSwipe(dx: Double, dy: Double, vx: Double, vy: Double,
                             axis: String = "both") -> Swipe? {
        let horizontal = abs(dx) >= abs(dy)
        let directionAxis = horizontal ? "x" : "y"
        if (axis == "x" || axis == "y") && axis != directionAxis { return nil }
        let distance = horizontal ? abs(dx) : abs(dy)
        let velocity = horizontal ? abs(vx) : abs(vy)
        if distance == 0 { return nil }
        if distance < swipeMinDistance || velocity < swipeMinVelocity { return nil }
        let direction = horizontal ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up")
        return Swipe(direction: direction, velocity: velocity, distance: distance)
    }

    /// `gestureAxis=` as the RECOGNIZER-LEVEL claim, not a direction check in the handler:
    /// inside the slop nothing is claimed yet (an ancestor scroll may still take the
    /// touch); past it an x or y claimer either claims the touch or FAILS it back to the
    /// ancestor. This is what the UIPanGestureRecognizer subclass decides in touchesMoved,
    /// and what `touch-action` declares on the web. Ties break horizontal, exactly as
    /// `resolveSwipe`.
    static func claimAxis(_ axis: String, dx: Double, dy: Double,
                          slop: Double = StackGestures.axisSlop) -> String {
        if hypot(dx, dy) <= slop { return "pending" }
        if axis != "x" && axis != "y" { return "claimed" }
        if axis == "x" { return abs(dx) >= abs(dy) ? "claimed" : "rejected" }
        return abs(dy) > abs(dx) ? "claimed" : "rejected"
    }

    /// Normalize into the half-open turn - exclusive at -pi, inclusive at +pi: the wrap that makes rotation continuous.
    static func normalizeAngle(_ angle: Double) -> Double {
        var a = angle
        while a > Double.pi { a -= 2 * Double.pi }
        while a <= -Double.pi { a += 2 * Double.pi }
        return a
    }

    /// The on:drag payload. Every shipped key keeps its exact meaning and value;
    /// `translationX` / `translationY` are the named twins of `dx` / `dy` (the vocabulary
    /// authors expect) and `velocityX` / `velocityY` come from the same velocity1D fold.
    /// `width` and `height` floor at 1, so a zero-sized element never divides by zero.
    static func dragPayload(width: Double, height: Double, x: Double, y: Double,
                            startX: Double, startY: Double, samples: [Sample2D],
                            phase: String) -> [String: Any] {
        let w = max(width, 1)
        let h = max(height, 1)
        let v = velocity2D(samples)
        let tx = x - startX
        let ty = y - startY
        return [
            "x": x, "y": y, "width": w, "height": h,
            "fraction": min(max(x / w, 0), 1),
            "fractionY": min(max(y / h, 0), 1),
            "dx": tx, "dy": ty,
            "translationX": tx, "translationY": ty,
            "velocityX": v.vx, "velocityY": v.vy,
            "phase": phase,
        ]
    }

    // MARK: - the composition resolver

    struct Node {
        let id: String
        let recognizers: [String]
        var gesture: String = "exclusive"
        var axis: String = "both"
    }

    struct Attempt {
        let kinds: Set<String>
        var axis: String = "none"
        var claimedBy: String? = nil
    }

    struct Fired: Equatable { let node: String; let kind: String }
    struct Blocked: Equatable { let node: String; let kind: String; let reason: String }
    struct Composition: Equatable { let fire: [Fired]; let blocked: [Blocked] }

    private static func precedenceIndex(_ kind: String) -> Int {
        precedence.firstIndex(of: kind) ?? precedence.count
    }

    /// Given the ancestor chain (root first) and one attempt, which recognizers may fire
    /// together. The attempt is what the RAW input physically matches - the adapter
    /// decides that, this decides composition. In order: an axis claim eliminates a
    /// directional recognizer running on the other axis; an outstanding claim by one node
    /// cancels every other node's recognizers; a `defer` node yields while any ANCESTOR
    /// candidate is still viable; the DEEPEST surviving node owns the touch and an
    /// ancestor keeps its recognizers only if it declared `simultaneous`; inside a node
    /// the continuous recognizers are exclusive by precedence unless the node declared
    /// `simultaneous`, while discrete ones never compete.
    static func resolveComposition(tree: [Node], attempt: Attempt) -> Composition {
        struct Candidate {
            let index: Int
            let node: String
            let kind: String
            var blocked: String? = nil
            var alive: Bool { blocked == nil }
        }

        var candidates: [Candidate] = []
        for (index, node) in tree.enumerated() {
            let kinds = node.recognizers
                .filter { attempt.kinds.contains($0) }
                .sorted { lhs, rhs in
                    let l = precedenceIndex(lhs), r = precedenceIndex(rhs)
                    return l == r ? lhs < rhs : l < r
                }
            for kind in kinds {
                candidates.append(Candidate(index: index, node: node.id, kind: kind))
            }
        }

        for i in candidates.indices {
            let axis = tree[candidates[i].index].axis
            if directional.contains(candidates[i].kind), axis == "x" || axis == "y",
               attempt.axis == "x" || attempt.axis == "y", axis != attempt.axis {
                candidates[i].blocked = "axis"
            }
        }

        if let claimedBy = attempt.claimedBy {
            for i in candidates.indices where candidates[i].alive && candidates[i].node != claimedBy {
                candidates[i].blocked = "claimed"
            }
        }

        for (index, node) in tree.enumerated() where node.gesture == "defer" {
            guard candidates.contains(where: { $0.alive && $0.index < index }) else { continue }
            for i in candidates.indices where candidates[i].index == index && candidates[i].alive {
                candidates[i].blocked = "deferred"
            }
        }

        let winner = candidates.filter { $0.alive }.map { $0.index }.max()
        guard let owner = winner else {
            return Composition(fire: [],
                               blocked: candidates.map { Blocked(node: $0.node, kind: $0.kind, reason: $0.blocked ?? "") })
        }

        for i in candidates.indices where candidates[i].alive && candidates[i].index != owner {
            if tree[candidates[i].index].gesture != "simultaneous" { candidates[i].blocked = "exclusive" }
        }

        for (index, node) in tree.enumerated() where node.gesture != "simultaneous" {
            let contenders = candidates.indices.filter {
                candidates[$0].index == index && candidates[$0].alive && continuous.contains(candidates[$0].kind)
            }
            for i in contenders.dropFirst() { candidates[i].blocked = "exclusive" }
        }

        return Composition(
            fire: candidates.filter { $0.alive }.map { Fired(node: $0.node, kind: $0.kind) },
            blocked: candidates.filter { !$0.alive }.map { Blocked(node: $0.node, kind: $0.kind, reason: $0.blocked ?? "") }
        )
    }
}

/// `on:pressIn` / `on:pressOut` - the custom press-state channel, and the slop that
/// separates a tap from a drag. pressOut ALWAYS balances pressIn (release, cancellation,
/// unmount); a press that ever exceeded the slop is a drag and never also reports a tap;
/// the slop is radial and one-way; one pointer owns the press.
struct StackPressTracker {
    private let slop: Double
    private var active: String? = nil
    private var sx: Double = 0
    private var sy: Double = 0

    /// true once this press has travelled past the slop - it is a drag, not a tap.
    private(set) var dragging = false

    init(slop: Double = StackGestures.tapSlop) { self.slop = slop }

    mutating func down(pointer: String, x: Double, y: Double) -> [String] {
        guard active == nil else { return [] }
        active = pointer
        sx = x
        sy = y
        dragging = false
        return ["pressIn"]
    }

    mutating func move(pointer: String, x: Double, y: Double) -> [String] {
        guard active == pointer, !dragging else { return [] }
        if hypot(x - sx, y - sy) > slop { dragging = true }
        return []
    }

    mutating func up(pointer: String, x: Double, y: Double) -> [String] {
        guard active == pointer else { return [] }
        active = nil
        return dragging ? ["pressOut"] : ["pressOut", "tap"]
    }

    mutating func cancel(pointer: String) -> [String] {
        guard active == pointer else { return [] }
        active = nil
        return ["pressOut"]
    }

    mutating func unmount() -> [String] {
        guard active != nil else { return [] }
        active = nil
        return ["pressOut"]
    }
}

/// `on:hover` - the POSITIONAL hover channel that complements the shipped
/// `on:hoverStart` / `on:hoverEnd` pair (input/hover.json owns pointer identity and the
/// balanced pair). Only a hover-capable source is ever tracked, so a touch screen never
/// fires it and content is never gated behind hover (Article 7); the enter IS the first
/// sample, the on:drag minimum-distance-0 rule.
struct StackHoverMotion {
    struct Emission: Equatable { let action: String; let x: Double; let y: Double }

    private var active = false

    mutating func enter(hoverCapable: Bool, x: Double, y: Double) -> [Emission] {
        guard hoverCapable, !active else { return [] }
        active = true
        return [Emission(action: "hover", x: x, y: y)]
    }

    mutating func move(x: Double, y: Double) -> [Emission] {
        active ? [Emission(action: "hover", x: x, y: y)] : []
    }

    mutating func leave(x: Double, y: Double) -> [Emission] {
        guard active else { return [] }
        active = false
        return [Emission(action: "hoverEnd", x: x, y: y)]
    }

    mutating func unmount() -> [Emission] {
        guard active else { return [] }
        active = false
        return [Emission(action: "hoverEnd", x: 0, y: 0)]
    }
}

/// The ONE tracker behind `on:pinch` and `on:rotate` (the UIPinchGestureRecognizer +
/// UIRotationGestureRecognizer pair, arbitrated as one). Each update carries the FULL set
/// of touches currently down and the two lowest-sorted ids define the span. The gesture
/// spans from the first two-finger engagement until the LAST finger lifts: dropping to one
/// finger SUSPENDS (values hold, nothing emitted) and a returning finger re-baselines
/// against the held accumulation, which is why the scale never jumps at a finger change.
/// Rotation accumulates normalized frame deltas, so it is continuous across the +-pi wrap
/// and keeps growing past a full turn. A re-baseline never emits; `start` fires the first
/// frame past pinchSlop or rotateSlop; `end` fires once, with the last values.
struct StackTransformTracker {
    struct Emission: Equatable {
        let phase: String
        let scale: Double
        let rotation: Double
        let focusX: Double
        let focusY: Double
        let scaleVelocity: Double
        let rotationVelocity: Double
    }

    private let pinchSlop: Double
    private let rotateSlop: Double
    private var engaged = false
    private var spanning = false
    private var started = false
    private var accumScale: Double = 1
    private var scale: Double = 1
    private var rotation: Double = 0
    private var focusX: Double = 0
    private var focusY: Double = 0
    private var baseDistance: Double = 0
    private var lastAngle: Double = 0
    private var baseIDs: String? = nil
    private var samples: [(t: Double, scale: Double, rotation: Double)] = []

    init(pinchSlop: Double = StackGestures.pinchSlop, rotateSlop: Double = StackGestures.rotateSlop) {
        self.pinchSlop = pinchSlop
        self.rotateSlop = rotateSlop
    }

    mutating func update(t: Double, points: [StackGestures.Point]) -> [Emission] {
        let pts = points.sorted { $0.id < $1.id }
        if pts.count >= 2 {
            let a = pts[0], b = pts[1]
            let distance = hypot(b.x - a.x, b.y - a.y)
            let angle = atan2(b.y - a.y, b.x - a.x)
            focusX = pts.reduce(0) { $0 + $1.x } / Double(pts.count)
            focusY = pts.reduce(0) { $0 + $1.y } / Double(pts.count)
            let ids = "\(a.id) \(b.id)"
            if !spanning || ids != baseIDs {
                accumScale = scale                       // fold the finished span in
                baseDistance = distance
                lastAngle = angle
                baseIDs = ids
                spanning = true
                engaged = true
                samples.append((t: t, scale: scale, rotation: rotation))
                return []                                // a re-baseline never emits
            }
            let span = baseDistance > 0 ? distance / baseDistance : 1
            scale = accumScale * span
            rotation += StackGestures.normalizeAngle(angle - lastAngle)
            lastAngle = angle
            samples.append((t: t, scale: scale, rotation: rotation))
            if !started {
                if abs(scale - 1) > pinchSlop || abs(rotation) > rotateSlop {
                    started = true
                    return [emission("start")]
                }
                return []
            }
            return [emission("move")]
        }
        if pts.count == 1 && engaged {
            accumScale = scale                           // suspend: hold, wait for the second finger
            spanning = false
            baseIDs = nil
            return []
        }
        if pts.isEmpty {
            let out = started ? [emission("end")] : []
            reset()
            return out
        }
        return []
    }

    /// An ancestor stole the touch: end at the last values, exactly like the final lift.
    mutating func cancel() -> [Emission] {
        let out = started ? [emission("end")] : []
        reset()
        return out
    }

    private mutating func reset() {
        engaged = false
        spanning = false
        started = false
        accumScale = 1
        scale = 1
        rotation = 0
        focusX = 0
        focusY = 0
        baseDistance = 0
        lastAngle = 0
        baseIDs = nil
        samples = []
    }

    private func emission(_ phase: String) -> Emission {
        Emission(
            phase: phase,
            scale: scale,
            rotation: rotation,
            focusX: focusX,
            focusY: focusY,
            scaleVelocity: StackGestures.velocity1D(samples.map { StackGestures.Sample1D(t: $0.t, value: $0.scale) }),
            rotationVelocity: StackGestures.velocity1D(samples.map { StackGestures.Sample1D(t: $0.t, value: $0.rotation) })
        )
    }
}
