//
//  SceneSkin.swift - the DSX Scene G3 skeletal kernel, the Swift twin of the web
//  kernel's scene/skin.ts and Android's SceneSkin.kt (dsx-game.md §2 G3):
//  Foundation-only, zero dependencies, corpus-pinned (OpenSource/Conformance/scene/
//  skin.json — every law in the file's _note and the corpus README "The G3 laws"; the
//  record-lane leg is ConformanceHosts.SkinConformance). The laws, verbatim:
//
//  - THE JOINT-MATRIX LAW: jointMatrix[i] = inverse(meshNodeWorld) ·
//    globalJointTransform[i] · inverseBindMatrix[i]; node worlds compose over the FULL
//    retained node forest (parent = the unique referencing node); a singular mesh
//    world inverts to identity (failure is a value, Article 7).
//  - THE SKINNING LAW: skinnedPos = Σ w[i] · jointMatrix[i] · pos; weights renormalize
//    when their sum ≠ 1; a sum ≤ sceneSkinWeightEpsilon passes the vertex through.
//  - THE CLIP-SAMPLING LAW: loop wraps modulo duration, non-loop clamps; interval
//    search; LINEAR lerp for t/s, shortest-path slerp for rotation (dot-sign flip,
//    nlerp past sceneSlerpNlerpThreshold); STEP holds the left key.
//  - THE CROSSFADE LAW: progress = clamp(elapsedMs/blendMs, 0, 1) (blendMs ≤ 0 = hard
//    cut); blended pose lerps t/s + slerps r per node over the union of both poses.
//  - THE MIXER: initial clip = no fade; a switch crossfades from the out-clip's
//    continuing clock; mid-fade switch drops the older fade; unknown clip name →
//    `unknown-clip` diagnostic + keep; "" = the bind pose; `active` is the
//    loop-existence read.
//

import Foundation

/// one node's animated local transform — absent channels fall back to the base TRS
struct GlbTrsOverride {
    var t: [Double]?
    var r: [Double]?
    var s: [Double]?
}

/// a sampled pose: node index → animated channels. The EMPTY map is the bind pose.
typealias GlbPose = [Int: GlbTrsOverride]

/// a node's effective transform (pose channel ?? base)
struct GlbTrs {
    var t: [Double]
    var r: [Double]
    var s: [Double]
}

enum SceneSkin {

    // ── the pinned constants (corpus `constants` — the record lane asserts these) ────

    /// weights whose sum is within this of 0 pass the vertex through; otherwise ≠1 renormalizes
    static let weightEpsilon = 1e-6
    /// quaternion dot beyond this uses normalized lerp (the numerically-safe near-parallel branch)
    static let slerpNlerpThreshold = 0.9995
    /// `<model blend>` default: 0 ms = the hard cut
    static let defaultBlendMs = 0.0
    /// `<model loop>` default: clips loop
    static let defaultLoop = true

    // ── quaternions ──────────────────────────────────────────────────────────────────

    /// spherical linear interpolation, shortest path: a negative dot flips b; a dot
    /// past slerpNlerpThreshold lerps + normalizes (the near-parallel branch)
    static func quatSlerp(_ a: [Double], _ b: [Double], _ t: Double) -> [Double] {
        var dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
        var bx = b[0], by = b[1], bz = b[2], bw = b[3]
        if dot < 0 { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot }
        if dot > slerpNlerpThreshold {
            let out = [
                a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t,
                a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t,
            ]
            let length = (out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3]).squareRoot()
            return length > 0 ? [out[0] / length, out[1] / length, out[2] / length, out[3] / length]
                : [0, 0, 0, 1]
        }
        let theta = acos(min(dot, 1))
        let sinTheta = sin(theta)
        let wa = sin((1 - t) * theta) / sinTheta
        let wb = sin(t * theta) / sinTheta
        return [
            wa * a[0] + wb * bx, wa * a[1] + wb * by,
            wa * a[2] + wb * bz, wa * a[3] + wb * bw,
        ]
    }

    // ── node worlds under a pose ─────────────────────────────────────────────────────

    /// one node's local matrix: pose channels override base TRS per property; a
    /// matrix-authored node with no pose entry uses its matrix verbatim
    static func localMatrix(_ node: GlbNode, pose: GlbTrsOverride? = nil) -> [Double] {
        if let matrix = node.matrix, pose == nil { return matrix }
        let t = pose?.t ?? node.translation
        let r = pose?.r ?? node.rotation
        let s = pose?.s ?? node.scale
        let translate = SceneMath.translation(t[0], t[1], t[2])
        let scale = SceneMath.scaling(s[0], s[1], s[2])
        return SceneMath.multiply(
            SceneMath.multiply(translate, SceneGltf.quaternionToMat4(r[0], r[1], r[2], r[3])), scale)
    }

    /// every node's world transform over the FULL node forest (roots = nodes no
    /// children list references), pose-aware — the hierarchy leg of the joint-matrix law
    static func nodeWorlds(_ model: GlbModel, pose: GlbPose? = nil) -> [[Double]] {
        let count = model.nodes.count
        var parent = [Int](repeating: -1, count: count)
        for i in 0..<count {
            for child in model.nodes[i].children where child >= 0 && child < count {
                parent[child] = i
            }
        }
        var worlds = [[Double]?](repeating: nil, count: count)
        func world(_ index: Int, _ depth: Int) -> [Double] {
            if let cached = worlds[index] { return cached }
            let local = localMatrix(model.nodes[index], pose: pose?[index])
            let out = depth > 64 || parent[index] == -1
                ? local : SceneMath.multiply(world(parent[index], depth + 1), local)
            worlds[index] = out
            return out
        }
        for i in 0..<count { _ = world(i, 0) }
        return worlds.map { $0 ?? SceneMath.identity() }
    }

    /// THE JOINT-MATRIX LAW: inverse(meshNodeWorld) · jointWorld · inverseBindMatrix,
    /// per skin joint. A singular mesh world inverts to identity (failure is a value).
    static func jointMatrices(_ model: GlbModel, skin skinIndex: Int, meshNode: Int,
                              worlds: [[Double]]) -> [[Double]] {
        guard skinIndex >= 0, skinIndex < model.skins.count else { return [] }
        let skin = model.skins[skinIndex]
        let meshWorld = meshNode >= 0 && meshNode < worlds.count ? worlds[meshNode] : SceneMath.identity()
        let inverseMesh = SceneMath.invert(meshWorld) ?? SceneMath.identity()
        return skin.joints.enumerated().map { i, joint in
            let jointWorld = joint >= 0 && joint < worlds.count ? worlds[joint] : SceneMath.identity()
            let ibm = i < skin.inverseBindMatrices.count ? skin.inverseBindMatrices[i] : SceneMath.identity()
            return SceneMath.multiply(SceneMath.multiply(inverseMesh, jointWorld), ibm)
        }
    }

    // ── vertex skinning ──────────────────────────────────────────────────────────────

    /// THE SKINNING LAW for one vertex: Σ w[i] · jointMatrix[i] · pos, weights
    /// renormalized when their sum ≠ 1; a sum ≤ weightEpsilon passes the vertex through
    static func skinPosition(_ position: [Double], joints: [Int], weights: [Double],
                             matrices: [[Double]]) -> [Double] {
        let sum = weights[0] + weights[1] + weights[2] + weights[3]
        if sum <= weightEpsilon { return [position[0], position[1], position[2]] }
        var out: [Double] = [0, 0, 0]
        for i in 0..<4 {
            let w = weights[i] / sum
            if w == 0 { continue }
            let joint = joints[i]
            guard joint >= 0, joint < matrices.count else { continue }
            let m = matrices[joint]
            out[0] += w * (m[0] * position[0] + m[4] * position[1] + m[8] * position[2] + m[12])
            out[1] += w * (m[1] * position[0] + m[5] * position[1] + m[9] * position[2] + m[13])
            out[2] += w * (m[2] * position[0] + m[6] * position[1] + m[10] * position[2] + m[14])
        }
        return out
    }

    /// a whole primitive's skinned positions (flat triples); nil when the primitive
    /// carries no JOINTS_0/WEIGHTS_0 (unskinned — draw the authored positions)
    static func skinnedPrimitivePositions(_ primitive: GlbPrimitive,
                                          matrices: [[Double]]) -> [Double]? {
        let vertexCount = primitive.positions.count / 3
        guard primitive.joints.count >= vertexCount * 4,
              primitive.weights.count >= vertexCount * 4 else { return nil }
        var out = [Double](repeating: 0, count: primitive.positions.count)
        for v in 0..<vertexCount {
            let skinned = skinPosition(
                [primitive.positions[v * 3], primitive.positions[v * 3 + 1], primitive.positions[v * 3 + 2]],
                joints: Array(primitive.joints[(v * 4)..<(v * 4 + 4)]),
                weights: Array(primitive.weights[(v * 4)..<(v * 4 + 4)]),
                matrices: matrices)
            out[v * 3] = skinned[0]
            out[v * 3 + 1] = skinned[1]
            out[v * 3 + 2] = skinned[2]
        }
        return out
    }

    // ── clip sampling ────────────────────────────────────────────────────────────────

    /// THE CLIP-TIME LAW: loop wraps modulo duration, non-loop clamps to [0, duration];
    /// a non-positive duration is always 0
    static func clipTime(_ time: Double, duration: Double, loop: Bool) -> Double {
        if duration <= 0 { return 0 }
        if loop { return time - (time / duration).rounded(.down) * duration }
        return min(max(time, 0), duration)
    }

    /// THE CHANNEL-SAMPLING LAW: interval search + LINEAR lerp (slerp for rotation) or
    /// STEP left-hold; clamped to the first/last key outside the key range
    static func sampleChannel(_ channel: GlbChannel, at time: Double) -> [Double] {
        let components = channel.path == "rotation" ? 4 : 3
        let times = channel.times
        let values = channel.values
        let count = times.count
        if count == 0 { return [Double](repeating: 0, count: components) }
        if time <= times[0] { return Array(values[0..<components]) }
        if time >= times[count - 1] {
            return Array(values[((count - 1) * components)..<(count * components)])
        }
        var k = 0
        while k + 1 < count, times[k + 1] <= time { k += 1 }
        let a = Array(values[(k * components)..<((k + 1) * components)])
        if channel.interpolation == "STEP" { return a }
        let b = Array(values[((k + 1) * components)..<((k + 2) * components)])
        let u = (time - times[k]) / (times[k + 1] - times[k])
        if channel.path == "rotation" { return quatSlerp(a, b, u) }
        return (0..<components).map { a[$0] + (b[$0] - a[$0]) * u }
    }

    /// sample a whole clip at a wrapped/clamped time (seconds) into a pose
    static func sampleClip(_ model: GlbModel, clip: GlbClip, time: Double, loop: Bool) -> GlbPose {
        let wrapped = clipTime(time, duration: clip.duration, loop: loop)
        var pose = GlbPose()
        for channel in clip.channels {
            guard channel.node >= 0, channel.node < model.nodes.count else { continue }
            let value = sampleChannel(channel, at: wrapped)
            var entry = pose[channel.node] ?? GlbTrsOverride()
            switch channel.path {
            case "translation": entry.t = [value[0], value[1], value[2]]
            case "scale": entry.s = [value[0], value[1], value[2]]
            default: entry.r = [value[0], value[1], value[2], value[3]]
            }
            pose[channel.node] = entry
        }
        return pose
    }

    static func findClip(_ model: GlbModel, name: String) -> GlbClip? {
        model.clips.first { $0.name == name }
    }

    // ── crossfade ────────────────────────────────────────────────────────────────────

    /// THE RAMP LAW: clamp(elapsedMs / blendMs, 0, 1); blendMs ≤ 0 is the hard cut (1)
    static func crossfadeProgress(elapsedMs: Double, blendMs: Double) -> Double {
        if blendMs <= 0 { return 1 }
        return min(max(elapsedMs / blendMs, 0), 1)
    }

    /// a node's effective TRS under a pose (pose channel ?? base)
    static func effectiveTrs(_ node: GlbNode, pose: GlbTrsOverride? = nil) -> GlbTrs {
        GlbTrs(t: pose?.t ?? node.translation,
               r: pose?.r ?? node.rotation,
               s: pose?.s ?? node.scale)
    }

    /// THE BLEND LAW for one node: t/s componentwise lerp, r shortest-path slerp
    static func blendTrs(_ from: GlbTrs, _ to: GlbTrs, progress: Double) -> GlbTrs {
        func lerp3(_ a: [Double], _ b: [Double]) -> [Double] {
            [a[0] + (b[0] - a[0]) * progress, a[1] + (b[1] - a[1]) * progress,
             a[2] + (b[2] - a[2]) * progress]
        }
        return GlbTrs(t: lerp3(from.t, to.t), r: quatSlerp(from.r, to.r, progress),
                      s: lerp3(from.s, to.s))
    }

    /// blend two poses over the union of their nodes — a missing side reads base TRS
    static func blendPoses(_ model: GlbModel, from: GlbPose, to: GlbPose,
                           progress: Double) -> GlbPose {
        var out = GlbPose()
        var indices = Set(from.keys)
        indices.formUnion(to.keys)
        for index in indices {
            guard index >= 0, index < model.nodes.count else { continue }
            let node = model.nodes[index]
            let blended = blendTrs(effectiveTrs(node, pose: from[index]),
                                   effectiveTrs(node, pose: to[index]), progress: progress)
            out[index] = GlbTrsOverride(t: blended.t, r: blended.r, s: blended.s)
        }
        return out
    }
}

// ── the mixer (the crossfade state machine every renderer drives) ────────────────────

/// the crossfade state machine — the web reference's createSceneClipMixer verbatim
final class SceneClipMixer {
    private let model: GlbModel
    private let diag: ((SceneDiagnostic) -> Void)?
    private var currentName: String?          // nil = never assigned
    private var currentClip: GlbClip?         // nil = bind pose
    private var currentStartMs = 0.0
    private var fading = false
    private var previousClip: GlbClip?        // the out-clip (nil = bind) while fading
    private var previousStartMs = 0.0
    private var fadeStartMs = 0.0
    private var fadeBlendMs = 0.0
    private var loop = SceneSkin.defaultLoop

    init(model: GlbModel, diag: ((SceneDiagnostic) -> Void)? = nil) {
        self.model = model
        self.diag = diag
    }

    private func poseOf(_ clip: GlbClip?, startMs: Double, nowMs: Double) -> GlbPose {
        guard let clip else { return GlbPose() }
        return SceneSkin.sampleClip(model, clip: clip, time: (nowMs - startMs) / 1000, loop: loop)
    }

    /// feed the resolved `animation`/`loop`/`blend` props each frame; a NAME CHANGE is
    /// the switch (unknown name → `unknown-clip` diagnostic + keep; "" → bind pose)
    func update(name: String, loop loopFlag: Bool, blendMs: Double, nowMs: Double) {
        loop = loopFlag
        if name == currentName { return }
        let clip = name.isEmpty ? nil : SceneSkin.findClip(model, name: name)
        if !name.isEmpty, clip == nil {
            diag?(SceneDiagnostic(
                code: "unknown-clip",
                message: "animation=\"\(name)\" is not a clip in this model — keeping the current clip"))
            return
        }
        if currentName == nil {
            // the initial assignment applies WITHOUT a crossfade (the mount law)
            currentName = name
            currentClip = clip
            currentStartMs = nowMs
            return
        }
        if blendMs > 0 {
            // one crossfade at a time: a mid-fade switch drops the older fade — the
            // out-clip is the clip that WAS current, on its continuing clock
            fading = true
            previousClip = currentClip
            previousStartMs = currentStartMs
            fadeStartMs = nowMs
            fadeBlendMs = blendMs
        } else {
            fading = false
            previousClip = nil
        }
        currentName = name
        currentClip = clip
        currentStartMs = nowMs
    }

    /// the pose at nowMs — the empty map is the bind pose
    func pose(nowMs: Double) -> GlbPose {
        let current = poseOf(currentClip, startMs: currentStartMs, nowMs: nowMs)
        if !fading { return current }
        let progress = SceneSkin.crossfadeProgress(elapsedMs: nowMs - fadeStartMs, blendMs: fadeBlendMs)
        if progress >= 1 {
            fading = false
            previousClip = nil
            return current
        }
        return SceneSkin.blendPoses(
            model, from: poseOf(previousClip, startMs: previousStartMs, nowMs: nowMs),
            to: current, progress: progress)
    }

    /// the loop-existence read: a fade in flight, a looping clip, or an unfinished
    /// non-looping clip (a finished non-loop clip with no fade lets the loop stop)
    func active(nowMs: Double) -> Bool {
        if fading, SceneSkin.crossfadeProgress(elapsedMs: nowMs - fadeStartMs, blendMs: fadeBlendMs) < 1 {
            return true
        }
        guard let clip = currentClip else { return false }
        if clip.duration <= 0 { return false }
        if loop { return true }
        return (nowMs - currentStartMs) / 1000 < clip.duration
    }
}
