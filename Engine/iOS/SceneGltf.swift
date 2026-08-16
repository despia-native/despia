//
//  SceneGltf.swift - the DSX Scene GLB/glTF parser, the Swift twin of the web kernel's
//  scene/gltf.ts and Android's SceneGltf.kt (dsx-scene.md P4): Foundation-only, zero
//  dependencies, platform-neutral (no SceneKit, no network — the caller supplies bytes;
//  the JSON chunk parses through this runtime's own JSONSerialization, never a second
//  parser). The law lives in OpenSource/Conformance/scene/model.json + README.md: glTF
//  2.0 BINARY containers, EMBEDDED buffers only (a buffer with a `uri` is the NAMED
//  absence, error "external-buffer"), POSITION/NORMAL f32 VEC3, u8/u16/u32 indices
//  (non-indexed synthesizes 0..n-1), pbrMetallicRoughness.baseColorFactor (default
//  [1,1,1,1]), triangle mode only; the draw list flattens the default scene's node
//  hierarchy (matrix, or T · R(quaternion) · S). Failure is a VALUE (Article 7): a
//  broken container parses to an error code — never a throw. The record-lane leg is
//  ConformanceHosts.SceneConformance (model.json), so a divergent byte read here is a
//  red lane, never a quiet drift.
//
//  G3 (dsx-game.md §2 — corpus OpenSource/Conformance/scene/skin.json, record-lane leg
//  ConformanceHosts.SkinConformance): the parse also retains the NODE FOREST (base TRS
//  + matrix + children + mesh/skin references — clip sampling recomposes the
//  hierarchy), `skins` (joints + inverseBindMatrices; absent IBMs are identity),
//  `animations` as NAMED CLIPS (translation/rotation/scale channels, LINEAR + STEP; a
//  CUBICSPLINE or weights/morph channel DROPS — the named absence — and duration folds
//  over the KEPT channels only; an unnamed clip is named by its zero-based index), and
//  JOINTS_0/WEIGHTS_0 vertex attributes (u8/u16 joints read raw; integer-typed
//  WEIGHTS_0 normalizes by 255/65535 — the glTF normalized law). The skinning/
//  sampling/crossfade math lives in SceneSkin.swift.
//

import Foundation
import CoreFoundation

/// one primitive of a GLB mesh — flat position/normal triples + triangle indices
struct GlbPrimitive {
    /// flat xyz triples
    let positions: [Double]
    /// flat xyz triples; empty when the primitive authors no NORMAL (flat-shade fallback)
    let normals: [Double]
    let indices: [Int]
    /// pbrMetallicRoughness.baseColorFactor rgba, default [1, 1, 1, 1]
    let baseColor: [Double]
    /// G3: flat JOINTS_0 4-tuples (empty when unskinned) — u8/u16 read raw
    var joints: [Int] = []
    /// G3: flat WEIGHTS_0 4-tuples (empty when unskinned) — integer types normalized
    var weights: [Double] = []
}

struct GlbMesh { let primitives: [GlbPrimitive] }

/// one node-referenced mesh instance: world = the node's hierarchy-composed matrix;
/// G3 adds the referencing node index + its skin (nil = unskinned)
struct GlbDraw {
    let mesh: Int
    let world: [Double]
    var node: Int = 0
    var skin: Int? = nil
}

/// G3: one retained glTF node — clip sampling recomposes the hierarchy from these
struct GlbNode {
    let translation: [Double]
    /// unit-ish quaternion (x, y, z, w)
    let rotation: [Double]
    let scale: [Double]
    /// a matrix-authored node (glTF forbids animating these); nil = TRS-authored
    let matrix: [Double]?
    let children: [Int]
    let mesh: Int?
    let skin: Int?
}

/// G3: joints (node indices) + inverse bind matrices (identity when unauthored)
struct GlbSkin { let joints: [Int]; let inverseBindMatrices: [[Double]] }

struct GlbChannel {
    let node: Int
    /// translation · rotation · scale
    let path: String
    /// LINEAR · STEP (CUBICSPLINE dropped at parse — the named absence)
    let interpolation: String
    /// key times, seconds, ascending
    let times: [Double]
    /// flat values — 3 per key (translation/scale) or 4 (rotation quaternions)
    let values: [Double]
}

/// G3: a named clip — `<model animation="name">` selects by this name
struct GlbClip {
    let name: String
    /// max key time over the KEPT channels, seconds
    let duration: Double
    let channels: [GlbChannel]
}

struct GlbModel {
    let meshes: [GlbMesh]
    let draws: [GlbDraw]
    var nodes: [GlbNode] = []
    var skins: [GlbSkin] = []
    var clips: [GlbClip] = []
}

/// the three corpus error codes — a broken container parses to one of these, never a throw
enum GlbError: String {
    case notGlb = "not-glb"
    case externalBuffer = "external-buffer"
    case malformed = "malformed"
}

/// the discriminated result — a model or an error code (failure is a value, Article 7)
enum GlbParseResult {
    case ok(GlbModel)
    case fail(GlbError)

    var model: GlbModel? { if case .ok(let model) = self { return model }; return nil }
    var error: GlbError? { if case .fail(let error) = self { return error }; return nil }
}

enum SceneGltf {

    private static let glbMagic: UInt32 = 0x46546C67
    private static let chunkJSON: UInt32 = 0x4E4F534A
    private static let chunkBIN: UInt32 = 0x004E4942

    private static let componentF32 = 5126
    private static let componentU8 = 5121
    private static let componentU16 = 5123
    private static let componentU32 = 5125
    private static let modeTriangles = 4

    private static func dict(_ value: Any?) -> [String: Any]? { value as? [String: Any] }
    private static func list(_ value: Any?) -> [Any]? { value as? [Any] }

    /// a strict JSON number — NSNumber that is not a boolean (the TS `typeof === "number"`
    /// gate; JSE.number would coerce strings/bools, which the twins reject)
    private static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.doubleValue
    }

    /// a non-negative JSON integer (the Kotlin twin's int(): integral double, capped)
    private static func int(_ value: Any?) -> Int? {
        guard let d = number(value), d >= 0, d == d.rounded(.down), d <= Double(Int32.max) else { return nil }
        return Int(d)
    }

    private static func finiteDouble(_ value: Any?) -> Double? {
        guard let d = number(value), d.isFinite else { return nil }
        return d
    }

    /// a unit-ish glTF quaternion (x, y, z, w) → column-major rotation mat4
    static func quaternionToMat4(_ x: Double, _ y: Double, _ z: Double, _ w: Double) -> [Double] {
        let length = (x * x + y * y + z * z + w * w).squareRoot()
        if length < 1e-12 { return SceneMath.identity() }
        let qx = x / length, qy = y / length, qz = z / length, qw = w / length
        return [
            1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw), 0,
            2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw), 0,
            2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy), 0,
            0, 0, 0, 1,
        ]
    }

    private static func nodeLocalMatrix(_ node: [String: Any]) -> [Double]? {
        if let matrix = list(node["matrix"]) {
            guard matrix.count == 16 else { return nil }
            var out = [Double](repeating: 0, count: 16)
            for i in 0..<16 {
                guard let v = finiteDouble(matrix[i]) else { return nil }
                out[i] = v
            }
            return out
        }
        func triple(_ name: String, _ fallback: [Double]) -> [Double]? {
            guard let raw = list(node[name]) else { return fallback }
            guard raw.count == 3 else { return nil }
            var out = [Double](repeating: 0, count: 3)
            for i in 0..<3 {
                guard let v = finiteDouble(raw[i]) else { return nil }
                out[i] = v
            }
            return out
        }
        guard let translation = triple("translation", [0, 0, 0]),
              let scale = triple("scale", [1, 1, 1]) else { return nil }
        var rotation = SceneMath.identity()
        if let quat = list(node["rotation"]) {
            guard quat.count == 4 else { return nil }
            var q = [Double](repeating: 0, count: 4)
            for i in 0..<4 {
                guard let v = finiteDouble(quat[i]) else { return nil }
                q[i] = v
            }
            rotation = quaternionToMat4(q[0], q[1], q[2], q[3])
        }
        let t = SceneMath.translation(translation[0], translation[1], translation[2])
        let s = SceneMath.scaling(scale[0], scale[1], scale[2])
        return SceneMath.multiply(SceneMath.multiply(t, rotation), s)
    }

    private static func u32(_ bytes: [UInt8], _ at: Int) -> UInt32 {
        UInt32(bytes[at]) | (UInt32(bytes[at + 1]) << 8)
            | (UInt32(bytes[at + 2]) << 16) | (UInt32(bytes[at + 3]) << 24)
    }

    /// (accessorIndex, componentCount) → the flat component list, or nil (the caller
    /// folds nil into "malformed" — exactly the TS/Kotlin closure)
    private static func makeAccessorReader(_ doc: [String: Any], _ bytes: [UInt8],
                                           _ bin: (start: Int, length: Int)?)
        -> (Int, Int, Bool) -> [Double]? {
        let accessors = list(doc["accessors"]) ?? []
        let views = list(doc["bufferViews"]) ?? []
        return { accessorIndex, componentCount, normalizeInts in
            guard accessorIndex >= 0, accessorIndex < accessors.count,
                  let accessor = dict(accessors[accessorIndex]), let bin else { return nil }
            if accessor["sparse"] != nil { return nil }             // named absence
            guard let viewIndex = int(accessor["bufferView"]),
                  let count = int(accessor["count"]),
                  let componentType = int(accessor["componentType"]),
                  viewIndex < views.count, let view = dict(views[viewIndex]) else { return nil }
            let viewOffset = int(view["byteOffset"]) ?? 0
            let accessorOffset = int(accessor["byteOffset"]) ?? 0
            let stride = int(view["byteStride"]) ?? 0
            let componentBytes: Int
            switch componentType {
            case componentF32, componentU32: componentBytes = 4
            case componentU16: componentBytes = 2
            case componentU8: componentBytes = 1
            default: return nil
            }
            // the G3 normalized law: integer WEIGHTS_0 components divide by 255/65535
            let divisor: Double
            if normalizeInts, componentType == componentU8 { divisor = 255 }
            else if normalizeInts, componentType == componentU16 { divisor = 65535 }
            else { divisor = 1 }
            let elementBytes = componentBytes * componentCount
            let step = stride > 0 ? stride : elementBytes
            let base = viewOffset + accessorOffset
            if count > 0, base + (count - 1) * step + elementBytes > bin.length { return nil }
            var out: [Double] = []
            out.reserveCapacity(count * componentCount)
            for i in 0..<count {
                for c in 0..<componentCount {
                    let at = bin.start + base + i * step + c * componentBytes
                    switch componentType {
                    case componentF32: out.append(Double(Float(bitPattern: u32(bytes, at))))
                    case componentU32: out.append(Double(u32(bytes, at)) / divisor)
                    case componentU16: out.append(Double(UInt32(bytes[at]) | (UInt32(bytes[at + 1]) << 8)) / divisor)
                    default: out.append(Double(bytes[at]) / divisor)
                    }
                }
            }
            return out
        }
    }

    /// parse a GLB container into the typed model. Failure is a value (Article 7).
    static func parseGlb(_ data: Data) -> GlbParseResult {
        let bytes = [UInt8](data)
        if bytes.count < 20 { return .fail(.notGlb) }
        if u32(bytes, 0) != glbMagic || u32(bytes, 4) != 2 { return .fail(.notGlb) }
        // walk the chunk stream: one JSON chunk, at most one BIN chunk
        var offset = 12
        var jsonText: String?
        var bin: (start: Int, length: Int)?
        while offset + 8 <= bytes.count {
            let length = Int(u32(bytes, offset))
            let type = u32(bytes, offset + 4)
            let start = offset + 8
            if start + length > bytes.count { return .fail(.malformed) }
            if type == chunkJSON, jsonText == nil {
                jsonText = String(decoding: bytes[start..<start + length], as: UTF8.self)
            } else if type == chunkBIN, bin == nil {
                bin = (start: start, length: length)
            }
            offset = start + length + ((4 - (length % 4)) % 4)
        }
        guard let jsonText,
              let parsed = try? JSONSerialization.jsonObject(with: Data(jsonText.utf8)),
              let doc = dict(parsed) else { return .fail(.malformed) }

        // v1 law: embedded buffers only — a uri is the named absence
        for rawBuffer in list(doc["buffers"]) ?? [] {
            if let b = dict(rawBuffer), b["uri"] is String { return .fail(.externalBuffer) }
        }

        let read = makeAccessorReader(doc, bytes, bin)
        let materials = list(doc["materials"]) ?? []
        func baseColorOf(_ materialIndex: Any?) -> [Double] {
            guard let index = int(materialIndex), index < materials.count,
                  let material = dict(materials[index]),
                  let pbr = dict(material["pbrMetallicRoughness"]),
                  let factor = list(pbr["baseColorFactor"]), factor.count == 4 else { return [1, 1, 1, 1] }
            var out = [Double](repeating: 1, count: 4)
            for i in 0..<4 {
                guard let v = number(factor[i]) else { return [1, 1, 1, 1] }
                out[i] = v
            }
            return out
        }

        var meshes: [GlbMesh] = []
        for rawMesh in list(doc["meshes"]) ?? [] {
            guard let mesh = dict(rawMesh) else { return .fail(.malformed) }
            var primitives: [GlbPrimitive] = []
            for rawPrimitive in list(mesh["primitives"]) ?? [] {
                guard let primitive = dict(rawPrimitive) else { return .fail(.malformed) }
                let mode = int(primitive["mode"]) ?? modeTriangles
                if mode != modeTriangles { continue }               // named absence: triangles only
                let attributes = dict(primitive["attributes"])
                guard let positionAccessor = attributes.flatMap({ int($0["POSITION"]) }),
                      let positions = read(positionAccessor, 3, false) else { return .fail(.malformed) }
                var normals: [Double] = []
                if let normalAccessor = attributes.flatMap({ int($0["NORMAL"]) }) {
                    guard let readNormals = read(normalAccessor, 3, false) else { return .fail(.malformed) }
                    normals = readNormals
                }
                let indices: [Int]
                if let indexAccessor = int(primitive["indices"]) {
                    guard let readIndices = read(indexAccessor, 1, false) else { return .fail(.malformed) }
                    indices = readIndices.map { Int($0) }
                } else {
                    indices = Array(0..<(positions.count / 3))
                }
                // G3: JOINTS_0 (raw) + WEIGHTS_0 (integers normalized) — both or neither
                var joints: [Int] = []
                var weights: [Double] = []
                if let jointsAccessor = attributes.flatMap({ int($0["JOINTS_0"]) }),
                   let weightsAccessor = attributes.flatMap({ int($0["WEIGHTS_0"]) }) {
                    guard let readJoints = read(jointsAccessor, 4, false),
                          let readWeights = read(weightsAccessor, 4, true) else { return .fail(.malformed) }
                    joints = readJoints.map { Int($0) }
                    weights = readWeights
                }
                primitives.append(GlbPrimitive(positions: positions, normals: normals, indices: indices,
                                               baseColor: baseColorOf(primitive["material"]),
                                               joints: joints, weights: weights))
            }
            meshes.append(GlbMesh(primitives: primitives))
        }

        // G3: the retained node forest (base TRS + matrix + references)
        var glbNodes: [GlbNode] = []
        for rawNode in list(doc["nodes"]) ?? [] {
            guard let node = dict(rawNode) else { return .fail(.malformed) }
            var matrix: [Double]?
            if let raw = list(node["matrix"]) {
                guard raw.count == 16 else { return .fail(.malformed) }
                var out = [Double](repeating: 0, count: 16)
                for i in 0..<16 {
                    guard let v = finiteDouble(raw[i]) else { return .fail(.malformed) }
                    out[i] = v
                }
                matrix = out
            }
            func triple(_ name: String, _ fallback: [Double]) -> [Double]? {
                guard let raw = list(node[name]) else { return fallback }
                guard raw.count == 3 else { return nil }
                var out = [Double](repeating: 0, count: 3)
                for i in 0..<3 {
                    guard let v = finiteDouble(raw[i]) else { return nil }
                    out[i] = v
                }
                return out
            }
            guard let translation = triple("translation", [0, 0, 0]),
                  let scale = triple("scale", [1, 1, 1]) else { return .fail(.malformed) }
            var rotation: [Double] = [0, 0, 0, 1]
            if let raw = list(node["rotation"]) {
                guard raw.count == 4 else { return .fail(.malformed) }
                var out = [Double](repeating: 0, count: 4)
                for i in 0..<4 {
                    guard let v = finiteDouble(raw[i]) else { return .fail(.malformed) }
                    out[i] = v
                }
                rotation = out
            }
            var children: [Int] = []
            for child in list(node["children"]) ?? [] {
                guard let index = int(child) else { return .fail(.malformed) }
                children.append(index)
            }
            glbNodes.append(GlbNode(translation: translation, rotation: rotation, scale: scale,
                                    matrix: matrix, children: children,
                                    mesh: int(node["mesh"]), skin: int(node["skin"])))
        }

        // G3: skins — joints + inverse bind matrices (absent IBM accessor = identity)
        var skins: [GlbSkin] = []
        for rawSkin in list(doc["skins"]) ?? [] {
            guard let skin = dict(rawSkin) else { return .fail(.malformed) }
            var joints: [Int] = []
            for joint in list(skin["joints"]) ?? [] {
                guard let index = int(joint) else { return .fail(.malformed) }
                joints.append(index)
            }
            var inverseBindMatrices: [[Double]]
            if let ibmAccessor = int(skin["inverseBindMatrices"]) {
                guard let flat = read(ibmAccessor, 16, false), flat.count >= joints.count * 16 else {
                    return .fail(.malformed)
                }
                inverseBindMatrices = (0..<joints.count).map { Array(flat[($0 * 16)..<($0 * 16 + 16)]) }
            } else {
                inverseBindMatrices = joints.map { _ in SceneMath.identity() }
            }
            skins.append(GlbSkin(joints: joints, inverseBindMatrices: inverseBindMatrices))
        }

        // G3: animations → named clips. LINEAR + STEP only — a CUBICSPLINE or non-TRS
        // channel DROPS (the named absence); duration folds over the KEPT channels;
        // an unnamed animation is named by its zero-based index.
        var clips: [GlbClip] = []
        let rawAnimations = list(doc["animations"]) ?? []
        for a in 0..<rawAnimations.count {
            guard let animation = dict(rawAnimations[a]) else { return .fail(.malformed) }
            let samplers = list(animation["samplers"]) ?? []
            var channels: [GlbChannel] = []
            var duration = 0.0
            for rawChannel in list(animation["channels"]) ?? [] {
                guard let channel = dict(rawChannel) else { return .fail(.malformed) }
                let target = dict(channel["target"])
                let nodeIndex = target.flatMap { int($0["node"]) }
                let path = target?["path"] as? String
                guard let nodeIndex, let path,
                      path == "translation" || path == "rotation" || path == "scale" else {
                    continue                                    // named absence: weights/morphs
                }
                guard let samplerIndex = int(channel["sampler"]), samplerIndex < samplers.count,
                      let sampler = dict(samplers[samplerIndex]) else { return .fail(.malformed) }
                let interpolation = (sampler["interpolation"] as? String) ?? "LINEAR"
                if interpolation != "LINEAR" && interpolation != "STEP" {
                    continue                                    // named absence: CUBICSPLINE
                }
                guard let inputAccessor = int(sampler["input"]),
                      let outputAccessor = int(sampler["output"]),
                      let times = read(inputAccessor, 1, false), !times.isEmpty else {
                    return .fail(.malformed)
                }
                let components = path == "rotation" ? 4 : 3
                guard let values = read(outputAccessor, components, false),
                      values.count >= times.count * components else { return .fail(.malformed) }
                channels.append(GlbChannel(node: nodeIndex, path: path, interpolation: interpolation,
                                           times: times,
                                           values: Array(values[0..<(times.count * components)])))
                if let last = times.last, last > duration { duration = last }
            }
            let name = (animation["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? String(a)
            clips.append(GlbClip(name: name, duration: duration, channels: channels))
        }

        // the draw list: the default scene's node hierarchy, world = parentWorld · local
        let nodes = list(doc["nodes"]) ?? []
        let scenes = list(doc["scenes"]) ?? []
        let sceneIndex = int(doc["scene"]) ?? 0
        let scene = (sceneIndex < scenes.count ? dict(scenes[sceneIndex]) : nil)
            ?? (scenes.isEmpty ? nil : dict(scenes[0]))
        var draws: [GlbDraw] = []
        var broken = false
        func walk(_ nodeIndex: Any?, _ parent: [Double], _ depth: Int) {
            if broken || depth > 64 { broken = true; return }
            guard let index = int(nodeIndex), index < nodes.count, let node = dict(nodes[index]),
                  let local = nodeLocalMatrix(node) else { broken = true; return }
            let world = SceneMath.multiply(parent, local)
            if let meshIndex = int(node["mesh"]), meshIndex < meshes.count {
                let skinIndex = int(node["skin"]).flatMap { $0 < skins.count ? $0 : nil }
                draws.append(GlbDraw(mesh: meshIndex, world: world, node: index, skin: skinIndex))
            }
            for child in list(node["children"]) ?? [] { walk(child, world, depth + 1) }
        }
        for root in (scene.flatMap { list($0["nodes"]) } ?? []) {
            walk(root, SceneMath.identity(), 0)
        }
        if broken { return .fail(.malformed) }
        return .ok(GlbModel(meshes: meshes, draws: draws, nodes: glbNodes, skins: skins, clips: clips))
    }
}
