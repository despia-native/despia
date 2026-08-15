//
//  SceneCollide.swift - opt-in scene collisions, the Swift twin of the web kernel's
//  scene/collide.ts (dsx-scene.md P5), corpus OpenSource/Conformance/scene/collide.json.
//  `collide="sphere"` (bounding sphere — the picking sphere law) or `collide="box"`
//  (world AABB) opts a node in; the scene tests pairs among opted-in nodes after each
//  rendered frame ONLY while at least one `on:collide` handler is authored (the
//  zero-cost static law: nothing moves without a render, so the pass rides the render,
//  never its own loop). Payload {id, other, depth}. THE ENTER LAW: on:collide fires
//  when a pair STARTS overlapping and fires again only after the pair has fully
//  separated (touch with depth 0 is NOT a contact). All math is platform-neutral and
//  corpus-pinned; SceneElement owns the SceneKit pass.
//

import Foundation

/// one collider in world space — a bounding sphere or a world AABB
enum SceneColliderShape {
    case sphere(id: String, center: [Double], radius: Double)
    case box(id: String, min: [Double], max: [Double])

    var id: String {
        switch self {
        case .sphere(let id, _, _): return id
        case .box(let id, _, _): return id
        }
    }
}

/// one overlapping pair (document order, i < j) and its depth
struct SceneContact {
    let a: String
    let b: String
    let depth: Double
}

/// one ENTER event — both directions fire per new contact
struct SceneCollisionEvent {
    let id: String
    let other: String
    let depth: Double
}

enum SceneCollide {

    /// the world AABB of a node's local extents: the 8 corners of [−half, +half]
    /// transformed by the world matrix, folded to min/max
    static func worldAabb(_ world: [Double], half: [Double]) -> (min: [Double], max: [Double]) {
        var minOut = [Double.infinity, Double.infinity, Double.infinity]
        var maxOut = [-Double.infinity, -Double.infinity, -Double.infinity]
        for i in 0..<8 {
            let local = [
                (i & 1) == 0 ? -half[0] : half[0],
                (i & 2) == 0 ? -half[1] : half[1],
                (i & 4) == 0 ? -half[2] : half[2],
            ]
            let x = world[0] * local[0] + world[4] * local[1] + world[8] * local[2] + world[12]
            let y = world[1] * local[0] + world[5] * local[1] + world[9] * local[2] + world[13]
            let z = world[2] * local[0] + world[6] * local[1] + world[10] * local[2] + world[14]
            if x < minOut[0] { minOut[0] = x }
            if x > maxOut[0] { maxOut[0] = x }
            if y < minOut[1] { minOut[1] = y }
            if y > maxOut[1] { maxOut[1] = y }
            if z < minOut[2] { minOut[2] = z }
            if z > maxOut[2] { maxOut[2] = z }
        }
        return (min: minOut, max: maxOut)
    }

    /// THE DEPTH LAWS (pinned):
    /// - sphere↔sphere: depth = rₐ + r_b − |cₐ − c_b|.
    /// - box↔box: overlap per axis oᵢ = min(maxₐᵢ, max_bᵢ) − max(minₐᵢ, min_bᵢ); a
    ///   contact needs every oᵢ > 0; depth = min(o₀, o₁, o₂).
    /// - sphere↔box: q = the box point nearest the center (componentwise clamp);
    ///   outside (|c − q| > 0): depth = r − |c − q|; center INSIDE the box: depth =
    ///   r + min over axes of the distance from the center to its nearest face.
    /// A pair overlaps only when depth > 0 — exact touch is NOT a contact.
    static func collidePair(_ a: SceneColliderShape, _ b: SceneColliderShape) -> Double? {
        switch (a, b) {
        case (.sphere(_, let ca, let ra), .sphere(_, let cb, let rb)):
            let depth = ra + rb - SceneMath.length(SceneMath.sub(ca, cb))
            return depth > 0 ? depth : nil
        case (.box(_, let minA, let maxA), .box(_, let minB, let maxB)):
            var depth = Double.infinity
            for i in 0..<3 {
                let overlap = min(maxA[i], maxB[i]) - max(minA[i], minB[i])
                if overlap <= 0 { return nil }
                if overlap < depth { depth = overlap }
            }
            return depth
        case (.sphere(_, let center, let radius), .box(_, let boxMin, let boxMax)),
             (.box(_, let boxMin, let boxMax), .sphere(_, let center, let radius)):
            var q = [0.0, 0.0, 0.0]
            for i in 0..<3 { q[i] = min(max(center[i], boxMin[i]), boxMax[i]) }
            let dist = SceneMath.length(SceneMath.sub(center, q))
            if dist > 0 {
                let depth = radius - dist
                return depth > 0 ? depth : nil
            }
            var inside = Double.infinity
            for i in 0..<3 {
                let toFace = min(center[i] - boxMin[i], boxMax[i] - center[i])
                if toFace < inside { inside = toFace }
            }
            return radius + inside
        }
    }

    /// a node's collider under its collide= word: "sphere" = the node's bounding sphere
    /// (the picking-sphere law verbatim); "box" = the world AABB of the node's local
    /// half extents (box: size/2 · sphere: radius · plane: [w/2, h/2, 0]). nil = not a
    /// collider (no collide word, or a non-geometry node). `id` is the caller's tracker
    /// identity (unique per node — the renderer's job).
    static func colliderFor(_ node: SceneNode, _ props: SceneNodeProps, world: [Double],
                            id: String) -> SceneColliderShape? {
        if props.collide == "sphere" {
            guard let local = SceneIRKit.nodeBoundingRadius(node, props) else { return nil }
            let sphere = SceneIRKit.worldBoundingSphere(world, local)
            return .sphere(id: id, center: sphere.center, radius: sphere.radius)
        }
        if props.collide == "box" {
            let half: [Double]?
            switch node.kind {
            case "box": half = [props.boxSize[0] / 2, props.boxSize[1] / 2, props.boxSize[2] / 2]
            case "sphere": half = [props.radius, props.radius, props.radius]
            case "plane": half = [props.planeSize[0] / 2, props.planeSize[1] / 2, 0]
            default: half = nil
            }
            guard let half else { return nil }
            let aabb = worldAabb(world, half: half)
            return .box(id: id, min: aabb.min, max: aabb.max)
        }
        return nil
    }

    /// every overlapping pair among the shapes, document order (i < j)
    static func contacts(_ shapes: [SceneColliderShape]) -> [SceneContact] {
        var out: [SceneContact] = []
        for i in 0..<shapes.count {
            for j in (i + 1)..<shapes.count {
                if let depth = collidePair(shapes[i], shapes[j]) {
                    out.append(SceneContact(a: shapes[i].id, b: shapes[j].id, depth: depth))
                }
            }
        }
        return out
    }
}

/// THE ENTER-ONLY FOLD: a pair fires on overlap START and re-arms only once the pair
/// is no longer overlapping. Pair identity is the id pair — the renderer feeds unique
/// per-node ids. Pure state machine, corpus-pinned as frame data.
final class SceneCollisionTracker {

    private var overlapping: Set<String> = []

    /// feed one frame's shapes; the ENTER events this frame (both directions per new
    /// contact: {id: a, other: b} and {id: b, other: a}), in contact order
    func step(_ shapes: [SceneColliderShape]) -> [SceneCollisionEvent] {
        var events: [SceneCollisionEvent] = []
        var current: Set<String> = []
        for contact in SceneCollide.contacts(shapes) {
            let key = contact.a + " " + contact.b
            current.insert(key)
            if !overlapping.contains(key) {
                events.append(SceneCollisionEvent(id: contact.a, other: contact.b, depth: contact.depth))
                events.append(SceneCollisionEvent(id: contact.b, other: contact.a, depth: contact.depth))
            }
        }
        overlapping = current
        return events
    }
}
