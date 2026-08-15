//
//  SceneIR.swift - the DSX Scene IR, the Swift twin of the web kernel's scene/ir.ts and
//  Android's SceneIr.kt (dsx-scene.md P2): a parsed <scene> subtree as typed nodes,
//  Foundation-only and store-agnostic. The markup arrives ALREADY parsed by this
//  renderer's own XML parser — `parseScene` consumes the `StackNode` tree StackXML
//  produced (StackNode.swift), never a second parser (the corpus law: "StackXML twins").
//  Attribute values keep their JSE holes verbatim; a resolver callback interpolates at
//  use time (the `<scene>` element wires the live store via `JSE.interpolate`, the
//  conformance host wires a plain map through `interpolateSceneHoles`). Defaults and
//  the Article-7 fallback law are pinned by OpenSource/Conformance/scene/parse.json;
//  the IR's color type stays platform-neutral 0..1 floats (the SceneKit adapter turns
//  them into UIColor — the kernel's UIColor(hex:) primitive stays the config-plane
//  helper, this parser also accepts #rgb and validates so failure is a value).
//

import Foundation

/// One typed node of a <scene> subtree — authored attribute strings, holes verbatim.
/// A CLASS since P5: the renderer's override plane (animations, orbit), row scopes and
/// animation records key on NODE IDENTITY (`ObjectIdentifier`) — the TS object-identity
/// twin. Bound rows mint fresh identities via `SceneBind.instantiateRow`.
final class SceneNode {
    let kind: String
    let id: String?
    let attrs: [String: String]
    let children: [SceneNode]
    /// G1 (prefab.json): set on a prefab-instance EXPANSION ROOT (an implicit group).
    /// `scope` holds the instance's parameter strings RAW — holes resolve at the
    /// INSTANCE SITE (the enclosing scope); body holes under this node resolve
    /// scope-first.
    let prefab: ScenePrefabRef?
    /// G6 (sprite.json): the enclosing scene's mode is "2d". Stamped by parseScene so the
    /// node-level folds honour the 2D conventions (a 2-number `position` means z = 0)
    /// without every signature growing a mode parameter.
    let mode2d: Bool

    init(kind: String, id: String?, attrs: [String: String], children: [SceneNode],
         prefab: ScenePrefabRef? = nil, mode2d: Bool = false) {
        self.kind = kind
        self.id = id
        self.attrs = attrs
        self.children = children
        self.prefab = prefab
        self.mode2d = mode2d
    }
}

/// the stamp a prefab EXPANSION ROOT carries (SceneNode.prefab — G1, dsx-game.md §2)
struct ScenePrefabRef {
    /// the instance tag (diagnostics/tooling — never dispatch)
    let tag: String
    /// parameter name → RAW instance string (holes resolve at the INSTANCE SITE)
    let scope: [String: String]
}

/// one declared `<attribute>` word (name + optional default raw string)
struct ScenePrefabParam {
    let name: String
    let `default`: String?
}

/// a prefab definition: declared params + the component body's top-level markup roots
struct ScenePrefabDef {
    let params: [ScenePrefabParam]
    let roots: [StackNode]
    /// THE DEFINING-SCOPE LAW: nested tags inside this body resolve where the
    /// component was DECLARED (its own package/scope), exactly as component expansion
    /// outside scenes does. Nil = the instance site's lookup (flat registries).
    var lookup: ScenePrefabLookup? = nil
}

/// tag → definition (nil = not a component). Each renderer wires its own registry —
/// the kernel never learns a component name (constitution rule 18: the lookup is the seam).
typealias ScenePrefabLookup = (String) -> ScenePrefabDef?

/// The parsed <scene> root: mode (3d · 2d · ar), the root's own attrs, the node tree.
struct SceneIR {
    let mode: String
    let attrs: [String: String]
    let nodes: [SceneNode]
}

/// An Article-7 fallback report: the value fell back to its default, and this says so.
struct SceneDiagnostic {
    let code: String   // unknown-tag · unknown-mode · malformed-vector · malformed-number · unknown-light-kind
                       // · malformed-animation · bind-overflow · light-cap · malformed-fog · unknown-collide (P5)
                       // · unknown-physics · physics-nested (G2) · unknown-clip (G3)
                       // · prefab-not-scene · prefab-depth · prefab-ignored (G1)
                       // · malformed-sprite (G6, the 2D engine)
    let message: String
}

/// resolve one authored attribute string for one node (nil node = the <scene> root).
typealias SceneResolve = (SceneNode?, String, String) -> String

/// every typed property a renderer needs, resolved per the parse-corpus defaults
struct SceneNodeProps {
    let position: [Double]
    let rotation: [Double]
    let scale: [Double]
    let color: String
    // camera
    let lookAt: [Double]
    let fov: Double
    let near: Double
    let far: Double
    let size2d: Double
    /// camera controls word ("" = none; "orbit" is the P5 word)
    let controls: String
    // light
    let lightKind: String   // ambient | directional | point
    let intensity: Double
    /// point-light falloff distance (the P5 attenuation law; default 10)
    let range: Double
    /// collision opt-in ("" = not a collider; "sphere" | "box" — the P5 collide law)
    let collide: String
    // geometry
    let boxSize: [Double]
    let radius: Double
    let planeSize: [Double]
    // P4 kinds (anchor stays P3)
    let src: String
    let value: String
    let anchorKind: String
    /// text3d glyph height in scene units (the quad law, text3d.json)
    let text3dSize: Double
    /// texture URL for box/sphere/plane ("" = untextured; the UV law lives in the corpus README)
    let texture: String
    /// G3 (skin.json): the model's clip NAME ("" = bind pose)
    var animation: String = ""
    /// G3: clip time wrap — true = modulo duration (the default), false = clamp at end
    var clipLoop: Bool = true
    /// G3: crossfade duration for an `animation` switch (default 0 = hard cut)
    var blendMs: Double = 0
    /// G6 (sprite.json): the sprite quad's authored `size` (w h; default 1 1)
    var spriteSize: [Double] = [1, 1]
    /// G6: whether `size` was AUTHORED — unauthored derives width from the texture aspect
    var spriteSizeAuthored: Bool = false
    /// G6: the sheet grid [cols, rows] (default 1 1 = the whole texture)
    var spriteFrames: [Int] = [1, 1]
    /// G6: the 0-based frame index, floored and CLAMPED into [0, cols·rows − 1]
    var spriteFrame: Int = 0
    /// G6: frames per second for auto-advance (0 = none; a positive fps OWNS the index)
    var spriteFps: Double = 0
    /// G6: whether an fps-driven strip wraps (true) or holds its last frame (false)
    var spriteLoop: Bool = true
    /// G6: which point of the quad `position` names (the anchor words)
    var spriteAnchor: String = SceneIRKit.spriteDefaultAnchor
    /// G6: the normalized UV mirror word — "" · "x" · "y" · "xy"
    var spriteFlip: String = ""
}

/// the text3d billboard quad's LAYOUT (the P4 quad law) — center + half-extents
struct Text3dQuad {
    let center: [Double]
    let halfWidth: Double
    let halfHeight: Double
}

/// One authored point light (P5): scene-root lights read their authored position as
/// world (the root-light law).
struct ScenePointLight {
    let position: [Double]
    let color: String
    let intensity: Double
    let range: Double
}

/// One resolved point light on the numeric plane (color premultiplied by nothing —
/// intensity stays explicit so the corpus pins each factor).
struct ScenePointLightResolved {
    let position: [Double]
    let color: [Double]
    let intensity: Double
    let range: Double
}

/// `fog="#color near far"` on `<scene>` — the P5 linear fog words.
struct SceneFog {
    let color: String
    let near: Double
    let far: Double
}

/// P1-lit lighting fold: one ambient + the first directional (Lambert-ish); P5 adds up
/// to `SceneIRKit.maxPointLights` point lights in document order.
struct SceneLighting {
    var ambientIntensity: Double
    var ambientColor: String
    /// unit direction the directional light shines FROM (its position toward the
    /// origin), nil when the scene authors none
    var direction: [Double]?
    var directionalIntensity: Double
    var directionalColor: String
    var points: [ScenePointLight]
}

enum SceneIRKit {

    static let nodeKinds: Set<String> =
        ["camera", "light", "group", "box", "sphere", "plane", "model", "text3d", "anchor",
         "animate", "sprite"]
    static let lightKinds: Set<String> = ["ambient", "directional", "point"]
    static let collideKinds: Set<String> = ["sphere", "box"]
    /// the still-scheduled scene word (dsx-scene.md P3) — `<anchor>` outside AR and
    /// kind="image" keep the honest placeholder; model · text3d · textures · on:frame
    /// left this set when Swift P4 landed (SceneElement renders them for real)
    static let scheduledKinds: Set<String> = ["anchor"]

    /// the store-agnostic hole interpolator: replaces every {{ expr }} with the JS
    /// stringification of evalHole(trimmed expr) — what a map-backed corpus resolver uses
    static func interpolateSceneHoles(_ raw: String, _ evalHole: (String) -> Any?) -> String {
        guard raw.contains("{{") else { return raw }
        var out = ""
        var rest = Substring(raw)
        while let open = rest.range(of: "{{") {
            out += rest[..<open.lowerBound]
            guard let close = rest.range(of: "}}", range: open.upperBound..<rest.endIndex) else {
                out += rest[open.lowerBound...]
                return out
            }
            let expr = String(rest[open.upperBound..<close.lowerBound]).trimmingCharacters(in: .whitespaces)
            out += JSE.string(evalHole(expr))
            rest = rest[close.upperBound...]
        }
        out += rest
        return out
    }

    /// parse a <scene> StackNode subtree into the typed IR. Unknown tags are SKIPPED with
    /// a diagnostic — never a phantom node, never a crash (Article 7). A `prefabs`
    /// lookup (G1, dsx-game.md §2) lets locally-declared COMPONENT tags instantiate as
    /// prefabs — the kernel never learns a component name (rule 18: the lookup is the seam).
    static func parseScene(_ markup: StackNode, diag: ((SceneDiagnostic) -> Void)? = nil,
                           prefabs: ScenePrefabLookup? = nil) -> SceneIR {
        let modeRaw = markup.attrs["mode"] ?? "3d"
        var mode = "3d"
        if modeRaw == "3d" || modeRaw == "2d" || modeRaw == "ar" { mode = modeRaw }
        else { diag?(SceneDiagnostic(code: "unknown-mode", message: "<scene mode=\"\(modeRaw)\"> is not 3d, 2d or ar — using 3d")) }
        return SceneIR(mode: mode, attrs: markup.attrs,
                       nodes: parseNodes(markup.children, diag, prefabs, 0, mode == "2d"))
    }

    private static func parseNodes(_ children: [StackNode], _ diag: ((SceneDiagnostic) -> Void)?,
                                   _ prefabs: ScenePrefabLookup? = nil, _ depth: Int = 0,
                                   _ mode2d: Bool = false) -> [SceneNode] {
        var nodes: [SceneNode] = []
        for child in children {
            guard nodeKinds.contains(child.tag) else {
                if let def = prefabs?(child.tag) {
                    if let expanded = expandScenePrefab(child, def, diag, prefabs, depth, mode2d) {
                        nodes.append(expanded)
                    }
                    continue
                }
                diag?(SceneDiagnostic(code: "unknown-tag", message: "<\(child.tag)> is not a scene node — skipped"))
                continue
            }
            nodes.append(SceneNode(kind: child.tag, id: child.attrs["id"],
                                   attrs: child.attrs,
                                   children: parseNodes(child.children, diag, prefabs, depth, mode2d),
                                   mode2d: mode2d))
        }
        return nodes
    }

    // ── prefabs (G1, dsx-game.md §2): components instantiate inside <scene> subtrees ─
    //
    // The Swift twin of ir.ts's prefab section, corpus prefab.json. A PREFAB IS A
    // COMPONENT whose body is scene content — no second concept. The kernel owns only
    // the STRUCTURAL law; the `<scene>` element derives the definition from
    // StackComponents (its own registry) and hands parseScene a lookup.

    /// the runaway self-reference guard — prefab expansion nests at most this deep
    static let prefabDepthLimit = 8

    /// instance words that are the node TRANSFORM, never scope parameters
    static let prefabTransformWords: [String] = ["position", "rotation", "scale"]

    /// head/declaration tags that never join a prefab body (the dsx-anatomy head words)
    private static let prefabDeclarationTags: Set<String> = [
        "head", "attribute", "variable", "var", "let", "action", "formula", "script", "functions",
        "event", "expects", "watch", "api", "style", "component", "slot",
    ]

    /// instance attrs that never enter the scope (identity/presentation/reserved words)
    private static let prefabReservedWords: Set<String> = ["id", "__css", "css-owner", "slot", "bind", "key"]

    /// derive a prefab definition from a component TEMPLATE — the shape the registry
    /// holds: a bare scene root, or a wrapper whose non-declaration children are the
    /// body roots (a Components/*.dsx file root, an inline `<component as>` wrap).
    /// Declared `<attribute as default>` params scan from the wrapper's head/declarations.
    static func scenePrefabDefFromTemplate(_ template: StackNode) -> ScenePrefabDef {
        var params: [ScenePrefabParam] = []
        func scanParams(_ children: [StackNode]) {
            for child in children {
                if child.tag == "head" { scanParams(child.children); continue }
                guard child.tag == "attribute", let name = child.attrs["as"], !name.isEmpty else { continue }
                params.append(ScenePrefabParam(name: name, default: child.attrs["default"]))
            }
        }
        if nodeKinds.contains(template.tag) {
            // a bare scene root may carry its <head> as a child (registries that keep
            // templates verbatim): declarations scan for params AND strip from the body
            scanParams(template.children)
            let body = template.children.filter { !prefabDeclarationTags.contains($0.tag) }
            var root = template
            if body.count != template.children.count { root.children = body }
            return ScenePrefabDef(params: params, roots: [root])
        }
        scanParams(template.children)
        return ScenePrefabDef(params: params,
                              roots: template.children.filter { !prefabDeclarationTags.contains($0.tag) })
    }

    /// THE SCOPE LAW: every non-reserved, non-transform, non-handler instance attribute
    /// enters the scope RAW; declared params missing from the instance fall to their
    /// declared default string.
    static func scenePrefabScope(_ instance: StackNode, _ def: ScenePrefabDef) -> [String: String] {
        var scope: [String: String] = [:]
        for (name, value) in instance.attrs {
            if prefabReservedWords.contains(name) || name.hasPrefix("on:") { continue }
            if prefabTransformWords.contains(name) { continue }
            scope[name] = value
        }
        for p in def.params where scope[p.name] == nil {
            if let fallback = p.default { scope[p.name] = fallback }
        }
        return scope
    }

    /// THE EXPANSION-ROOT LAW: an instance ALWAYS expands to one implicit `group`
    /// carrying the instance's transform words + id (instance transforms COMPOSE with
    /// body-authored transforms — never clobber), children = the body roots. A body
    /// that is not scene content skips the WHOLE instance with one `prefab-not-scene`
    /// diagnostic; expansion past `prefabDepthLimit` skips with one `prefab-depth`
    /// diagnostic (Article 7 — never a crash, never a phantom).
    private static func expandScenePrefab(
        _ instance: StackNode, _ def: ScenePrefabDef,
        _ diag: ((SceneDiagnostic) -> Void)?, _ prefabs: ScenePrefabLookup?, _ depth: Int,
        _ mode2d: Bool = false,
    ) -> SceneNode? {
        if depth >= prefabDepthLimit {
            diag?(SceneDiagnostic(code: "prefab-depth",
                                  message: "<\(instance.tag)> nests prefabs deeper than \(prefabDepthLimit) — skipped"))
            return nil
        }
        // the body resolves in its DEFINING scope when the renderer provides one (the
        // defining-scope law) — a packaged prefab's nested tags mean what they meant
        // where the component was declared, exactly as expansion outside scenes
        let bodyLookup = def.lookup ?? prefabs
        let notScene = def.roots.isEmpty || def.roots.contains {
            !nodeKinds.contains($0.tag) && bodyLookup?($0.tag) == nil
        }
        if notScene {
            diag?(SceneDiagnostic(code: "prefab-not-scene",
                                  message: "<\(instance.tag)> is a component but its body is not scene content — skipped"))
            return nil
        }
        // bind/key/on:* on an instance tag do nothing — say so (Article 7, never
        // silent): spawning is <group bind> around the instance; handlers live inside
        // the component body
        let ignored = instance.attrs.keys.filter { $0 == "bind" || $0 == "key" || $0.hasPrefix("on:") }
        if !ignored.isEmpty {
            diag?(SceneDiagnostic(code: "prefab-ignored",
                                  message: "<\(instance.tag)> \(ignored.sorted().joined(separator: ", ")) ignored — wrap the instance in <group bind key> to spawn; attach handlers inside the component body"))
        }
        var attrs: [String: String] = [:]
        for name in prefabTransformWords {
            if let value = instance.attrs[name] { attrs[name] = value }
        }
        let id = instance.attrs["id"]
        if let id { attrs["id"] = id }
        return SceneNode(kind: "group", id: id, attrs: attrs,
                         children: parseNodes(def.roots, diag, bodyLookup, depth + 1, mode2d),
                         prefab: ScenePrefabRef(tag: instance.tag,
                                                scope: scenePrefabScope(instance, def)),
                         mode2d: mode2d)
    }

    /// the corpus/tooling resolver over an expanded tree: body holes under a prefab
    /// root resolve SCOPE-FIRST (an expr that is exactly a scope key reads the
    /// per-instance value, resolved at the instance site), everything else falls
    /// through to `evalHole` (the outer plane). The element implements the same law on
    /// its live item plane (ScenePrefabItems).
    static func scenePrefabResolver(_ nodes: [SceneNode],
                                    _ evalHole: @escaping (String) -> Any?) -> SceneResolve {
        var scopes: [ObjectIdentifier: [String: String]] = [:]
        func walk(_ list: [SceneNode], _ enclosing: [String: String]?) {
            for node in list {
                // the root's OWN attrs (the instance transforms) resolve at the INSTANCE SITE
                if let enclosing { scopes[ObjectIdentifier(node)] = enclosing }
                var inner = enclosing
                if let ref = node.prefab {
                    let site: (String) -> Any? = { expr in
                        if let enclosing, let value = enclosing[expr] { return value }
                        return evalHole(expr)
                    }
                    var resolved: [String: String] = [:]
                    for (key, raw) in ref.scope { resolved[key] = interpolateSceneHoles(raw, site) }
                    inner = resolved
                }
                walk(node.children, inner)
            }
        }
        walk(nodes, nil)
        return { node, _, raw in
            interpolateSceneHoles(raw) { expr in
                if let node, let scope = scopes[ObjectIdentifier(node)], let value = scope[expr] {
                    return value
                }
                return evalHole(expr)
            }
        }
    }

    // ── typed attribute resolution (the corpus defaults) ─────────────────────────────

    private static func finiteNumbers(_ resolved: String) -> [Double]? {
        let parts = resolved.split(whereSeparator: { $0.isWhitespace })
        var numbers: [Double] = []
        for part in parts {
            guard let value = Double(part), value.isFinite else { return nil }
            numbers.append(value)
        }
        return numbers
    }

    // THE TOTAL-RESOLVE LAW (P5): an UNAUTHORED attribute still consults the resolver,
    // with its formatted DEFAULT as the raw value. A pure hole-interpolating resolver
    // returns that default string unchanged — identical numbers to the pre-P5
    // early-return — while a renderer's OVERRIDE PLANE (animations, orbit) can reach
    // properties the author never wrote.

    // readVec/readScalar/readString are internal, not private: the physics extraction
    // (ScenePhysics.swift) shares them exactly like the TS ir.ts exports them to
    // physics.ts — sibling kernel modules only, never a renderer surface.

    static func readVec(_ node: SceneNode?, _ name: String, _ fallback: [Double],
                                _ resolve: SceneResolve, _ diag: ((SceneDiagnostic) -> Void)?,
                                _ attrs: [String: String]) -> [Double] {
        let raw = attrs[name] ?? fallback.map { JSE.string($0) }.joined(separator: " ")
        let resolved = resolve(node, name, raw)
        guard let numbers = finiteNumbers(resolved), numbers.count == fallback.count else {
            diag?(SceneDiagnostic(
                code: "malformed-vector",
                message: "\(name)=\"\(resolved)\" is not \(fallback.count) numbers — using \"\(fallback.map { JSE.string($0) }.joined(separator: " "))\""))
            return fallback
        }
        return numbers
    }

    static func readScalar(_ node: SceneNode?, _ name: String, _ fallback: Double,
                                   _ resolve: SceneResolve, _ diag: ((SceneDiagnostic) -> Void)?,
                                   _ attrs: [String: String]) -> Double {
        let raw = attrs[name] ?? JSE.string(fallback)
        let resolved = resolve(node, name, raw).trimmingCharacters(in: .whitespaces)
        guard !resolved.isEmpty, let value = Double(resolved), value.isFinite else {
            diag?(SceneDiagnostic(code: "malformed-number",
                                  message: "\(name)=\"\(resolved)\" is not a number — using \(JSE.string(fallback))"))
            return fallback
        }
        return value
    }

    static func readString(_ node: SceneNode?, _ name: String, _ fallback: String,
                                   _ resolve: SceneResolve, _ attrs: [String: String]) -> String {
        resolve(node, name, attrs[name] ?? fallback)
    }

    /// THE 2D PAIR LAW (G6, sprite.json): inside `mode="2d"` a `position` of TWO numbers
    /// means z = 0; a triple still means what it always did, and every OTHER vector word
    /// (rotation, scale, velocity) stays a triple — a named absence. Outside 2D a pair is
    /// malformed exactly as before (readVec's shared law).
    static func readPosition(_ node: SceneNode?, _ fallback: [Double],
                             _ resolve: SceneResolve, _ diag: ((SceneDiagnostic) -> Void)?,
                             _ attrs: [String: String]) -> [Double] {
        if node?.mode2d == true {
            let raw = attrs["position"] ?? fallback.map { JSE.string($0) }.joined(separator: " ")
            if let pair = finiteNumbers(resolve(node, "position", raw)), pair.count == 2 {
                return [pair[0], pair[1], 0]
            }
        }
        return readVec(node, "position", fallback, resolve, diag, attrs)
    }

    // ── the sprite grammar (G6, corpus sprite.json) ──────────────────────────────────
    //
    // These three live HERE, beside the other attribute grammars, so `resolvedProps`
    // needs nothing from SceneSprite.swift — the quad/UV/fps folds use THEM (one
    // direction, the text3d precedent).

    /// which point of the quad `position` names → the anchor point's offset from the
    /// quad CENTER as a fraction of (width, height): ax ∈ {−½ left, 0 center, +½ right},
    /// ay ∈ {+½ top, 0 center, −½ bottom}
    static let spriteAnchors: [String: [Double]] = [
        "center": [0, 0], "top": [0, 0.5], "bottom": [0, -0.5],
        "left": [-0.5, 0], "right": [0.5, 0],
        "top-left": [-0.5, 0.5], "top-right": [0.5, 0.5],
        "bottom-left": [-0.5, -0.5], "bottom-right": [0.5, -0.5],
    ]

    static let spriteDefaultAnchor = "center"

    /// THE SHEET GRAMMAR: ONE number N = a SINGLE ROW (cols = N, rows = 1); TWO numbers
    /// = "cols rows" EXPLICITLY. The kernel never guesses a grid — `cols = ceil(√N)` is
    /// WRONG and is not the law. Anything else (a fraction, < 1, three numbers, a word)
    /// is nil and the caller falls back to 1×1 with one diagnostic (Article 7).
    static func parseSpriteFrames(_ raw: String) -> [Int]? {
        let parts = raw.split(whereSeparator: { $0.isWhitespace })
        guard parts.count == 1 || parts.count == 2 else { return nil }
        var numbers: [Int] = []
        for part in parts {
            guard let value = Double(part), value.isFinite, value >= 1,
                  value == value.rounded(.down) else { return nil }
            numbers.append(Int(value))
        }
        return parts.count == 1 ? [numbers[0], 1] : [numbers[0], numbers[1]]
    }

    /// the `flip` word: "" or any arrangement of the letters x and y ("yx" IS "xy" — the
    /// word is a SET), normalized to "" · "x" · "y" · "xy". nil = not a flip word.
    static func normalizeSpriteFlip(_ raw: String) -> String? {
        if raw.isEmpty { return "" }
        if raw.count > 2 { return nil }
        var x = false
        var y = false
        for letter in raw {
            if letter == "x", !x { x = true }
            else if letter == "y", !y { y = true }
            else { return nil }
        }
        return x ? (y ? "xy" : "x") : "y"
    }

    static func resolvedProps(_ node: SceneNode, _ resolve: SceneResolve,
                              _ diag: ((SceneDiagnostic) -> Void)? = nil) -> SceneNodeProps {
        let a = node.attrs
        let kindRaw = readString(node, "kind", "", resolve, a)
        var lightKind = "ambient"
        if node.kind == "light", !kindRaw.isEmpty {
            if lightKinds.contains(kindRaw) { lightKind = kindRaw }
            else { diag?(SceneDiagnostic(code: "unknown-light-kind", message: "<light kind=\"\(kindRaw)\"> is not ambient, directional or point — using ambient")) }
        }
        let geometryNode = node.kind == "box" || node.kind == "sphere" || node.kind == "plane"
        var collide = ""
        if geometryNode {
            let collideRaw = readString(node, "collide", "", resolve, a)
            if !collideRaw.isEmpty {
                if collideKinds.contains(collideRaw) { collide = collideRaw }
                else { diag?(SceneDiagnostic(code: "unknown-collide", message: "collide=\"\(collideRaw)\" is not sphere or box — not a collider")) }
            }
        }
        // `size` and every camera scalar read PER KIND — the word is shared (camera scalar,
        // box triple, plane pair), so an unconditional read would mis-diagnose valid markup.
        let camera = node.kind == "camera"
        // G3 model clip words (skin.json props cases): animation name, loop, blend
        let model = node.kind == "model"
        var clipLoop = true
        if model {
            let loopRaw = readString(node, "loop", "true", resolve, a)
            if loopRaw == "false" { clipLoop = false }
            else if loopRaw != "true" {
                diag?(SceneDiagnostic(code: "malformed-animation",
                                      message: "loop=\"\(loopRaw)\" is not true or false — using true"))
            }
        }
        var blendMs = 0.0
        if model, a["blend"] != nil {
            let blendRaw = readString(node, "blend", "0", resolve, a)
            if let parsed = SceneAnim.parseDuration(blendRaw) { blendMs = parsed }
            else {
                diag?(SceneDiagnostic(code: "malformed-animation",
                                      message: "blend=\"\(blendRaw)\" is not ms|s — using 0"))
            }
        }
        // G6 (sprite.json): the `<sprite>` words. Every read is gated on the kind —
        // `size`, `loop` and `frame` are shared words, so an unconditional read would
        // mis-diagnose valid markup.
        let sprite = node.kind == "sprite"
        let spriteSize = sprite ? readVec(node, "size", [1, 1], resolve, diag, a) : [1, 1]
        var spriteFrames = [1, 1]
        if sprite {
            let framesRaw = readString(node, "frames", "1 1", resolve, a)
            if let parsed = parseSpriteFrames(framesRaw) { spriteFrames = parsed }
            else {
                diag?(SceneDiagnostic(code: "malformed-sprite",
                                      message: "frames=\"\(framesRaw)\" is not a frame count or \"cols rows\" of whole numbers ≥ 1 — using the whole texture"))
            }
        }
        var spriteFrame = 0
        if sprite {
            let total = spriteFrames[0] * spriteFrames[1]
            let floored = readScalar(node, "frame", 0, resolve, diag, a).rounded(.down)
            let clamped = Swift.min(Swift.max(floored, 0), Double(total - 1))
            spriteFrame = Int(clamped)
            if floored != clamped {
                diag?(SceneDiagnostic(code: "malformed-sprite",
                                      message: "frame=\"\(JSE.string(floored))\" is outside 0..\(total - 1) — clamped to \(spriteFrame)"))
            }
        }
        var spriteLoop = true
        var spriteAnchor = spriteDefaultAnchor
        var spriteFlip = ""
        if sprite {
            let loopRaw = readString(node, "loop", "true", resolve, a)
            if loopRaw == "false" { spriteLoop = false }
            else if loopRaw != "true" {
                diag?(SceneDiagnostic(code: "malformed-sprite",
                                      message: "loop=\"\(loopRaw)\" is not true or false — using true"))
            }
            let anchorRaw = readString(node, "anchor", spriteDefaultAnchor, resolve, a)
            if spriteAnchors[anchorRaw] != nil { spriteAnchor = anchorRaw }
            else {
                diag?(SceneDiagnostic(code: "malformed-sprite",
                                      message: "anchor=\"\(anchorRaw)\" is not a sprite anchor word — using \(spriteDefaultAnchor)"))
            }
            let flipRaw = readString(node, "flip", "", resolve, a).trimmingCharacters(in: .whitespaces)
            if let flip = normalizeSpriteFlip(flipRaw) { spriteFlip = flip }
            else {
                diag?(SceneDiagnostic(code: "malformed-sprite",
                                      message: "flip=\"\(flipRaw)\" is not \"\", \"x\", \"y\" or \"xy\" — not mirrored"))
            }
        }
        return SceneNodeProps(
            position: readPosition(node, camera ? [0, 0, 5] : [0, 0, 0], resolve, diag, a),
            rotation: readVec(node, "rotation", [0, 0, 0], resolve, diag, a),
            scale: readVec(node, "scale", [1, 1, 1], resolve, diag, a),
            color: readString(node, "color", "#ffffff", resolve, a),
            lookAt: camera ? readVec(node, "look-at", [0, 0, 0], resolve, diag, a) : [0, 0, 0],
            fov: camera ? readScalar(node, "fov", 60, resolve, diag, a) : 60,
            near: camera ? readScalar(node, "near", 0.1, resolve, diag, a) : 0.1,
            far: camera ? readScalar(node, "far", 1000, resolve, diag, a) : 1000,
            size2d: camera ? readScalar(node, "size", 5, resolve, diag, a) : 5,
            controls: camera ? readString(node, "controls", "", resolve, a) : "",
            lightKind: lightKind,
            intensity: node.kind == "light" ? readScalar(node, "intensity", 1, resolve, diag, a) : 1,
            range: node.kind == "light" && lightKind == "point"
                ? readScalar(node, "range", pointLightDefaultRange, resolve, diag, a) : pointLightDefaultRange,
            collide: collide,
            boxSize: node.kind == "box" ? readVec(node, "size", [1, 1, 1], resolve, diag, a) : [1, 1, 1],
            radius: node.kind == "sphere" ? readScalar(node, "radius", 1, resolve, diag, a) : 1,
            planeSize: node.kind == "plane" ? readVec(node, "size", [1, 1], resolve, diag, a) : [1, 1],
            src: readString(node, "src", "", resolve, a),
            value: readString(node, "value", "", resolve, a),
            anchorKind: node.kind == "anchor" ? readString(node, "kind", "", resolve, a) : "",
            text3dSize: node.kind == "text3d"
                ? readScalar(node, "size", text3dDefaultSize, resolve, diag, a) : text3dDefaultSize,
            texture: node.kind == "box" || node.kind == "sphere" || node.kind == "plane"
                ? readString(node, "texture", "", resolve, a) : "",
            animation: model ? readString(node, "animation", "", resolve, a) : "",
            clipLoop: clipLoop,
            blendMs: blendMs,
            spriteSize: spriteSize,
            spriteSizeAuthored: sprite && a["size"] != nil,
            spriteFrames: spriteFrames,
            spriteFrame: spriteFrame,
            spriteFps: sprite ? readScalar(node, "fps", 0, resolve, diag, a) : 0,
            spriteLoop: spriteLoop,
            spriteAnchor: spriteAnchor,
            spriteFlip: spriteFlip
        )
    }

    // ── the text3d quad law (dsx-scene.md P4, corpus text3d.json) ────────────────────

    /// the glyph height default (scene units)
    static let text3dDefaultSize = 0.5
    /// the LAW's fixed per-character advance: width = size × 0.6 × codePointCount
    static let text3dAdvance = 0.6

    /// the billboard quad's layout: center = position, height = size, width = size · 0.6
    /// · codePointCount; an empty value lays out NO quad (nil — the node draws nothing).
    /// Characters are Unicode CODE POINTS (the surrogate-pair corpus case — Swift's
    /// unicodeScalars ARE code points). The BILLBOARD law (the quad always faces the
    /// camera) is draw-time behavior, not layout.
    static func text3dQuad(_ props: SceneNodeProps) -> Text3dQuad? {
        let characters = props.value.unicodeScalars.count
        if characters == 0 { return nil }
        return Text3dQuad(center: props.position,
                          halfWidth: props.text3dSize * text3dAdvance * Double(characters) / 2,
                          halfHeight: props.text3dSize / 2)
    }

    // ── world transforms (the transform-corpus law) ──────────────────────────────────

    /// One walked node: a stable tree key ("0/2/…" — index path, root down), the node,
    /// and its world matrix. The KEY is the identity a renderer maps native nodes by
    /// (SceneNode is a value; the tree shape is static per surface template).
    struct WorldEntry {
        let key: String
        let node: SceneNode
        let world: [Double]
    }

    /// every node's world matrix: world = parentWorld · (T · Rz · Ry · Rx · S), root
    /// down. Cameras and lights get world matrices too (their position rides the same
    /// plane). `<animate>` nodes are CONTROLLERS, not transforms — skipped entirely.
    /// Ordered parent-before-child — the renderer's build order.
    static func worldMatrices(_ nodes: [SceneNode], _ resolve: SceneResolve,
                              _ diag: ((SceneDiagnostic) -> Void)? = nil) -> [WorldEntry] {
        var out: [WorldEntry] = []
        func walk(_ list: [SceneNode], _ parent: [Double], _ prefix: String) {
            for (i, node) in list.enumerated() {
                if node.kind == "animate" { continue }
                let props = resolvedProps(node, resolve, diag)
                let world = SceneMath.multiply(
                    parent, SceneMath.trs(position: props.position, rotationDeg: props.rotation, scale: props.scale))
                let key = prefix.isEmpty ? String(i) : prefix + "/" + String(i)
                out.append(WorldEntry(key: key, node: node, world: world))
                walk(node.children, world, key)
            }
        }
        walk(nodes, SceneMath.identity(), "")
        return out
    }

    static func findSceneNode(_ nodes: [SceneNode], id: String) -> SceneNode? {
        for node in nodes {
            if node.id == id { return node }
            if let inner = findSceneNode(node.children, id: id) { return inner }
        }
        return nil
    }

    // ── the camera fold (the projection-corpus law) ──────────────────────────────────

    /// the first authored top-level <camera> wins; an unauthored camera uses every
    /// default. mode="2d" projects orthographically (`size` = vertical half-extent);
    /// 3d and ar perspective.
    static func sceneCamera(_ ir: SceneIR, _ resolve: SceneResolve, aspect: Double,
                            _ diag: ((SceneDiagnostic) -> Void)? = nil)
        -> (view: [Double], proj: [Double], eye: [Double]) {
        let props = cameraProps(ir, resolve, diag)
        let safeAspect = aspect.isFinite && aspect > 0 ? aspect : 1
        let view = SceneMath.lookAt(eye: props.position, target: props.lookAt)
        let proj = ir.mode == "2d"
            ? SceneMath.orthographic(halfHeight: props.size2d, aspect: safeAspect, near: props.near, far: props.far)
            : SceneMath.perspective(fovYDeg: props.fov, aspect: safeAspect, near: props.near, far: props.far)
        return (view: view, proj: proj, eye: props.position)
    }

    /// the resolved camera words a native adapter consumes directly (SceneKit builds its
    /// own projection from fov/near/far/size — the SAME resolved inputs the matrix fold
    /// above projects with, so the two stay one law)
    static func cameraProps(_ ir: SceneIR, _ resolve: SceneResolve,
                            _ diag: ((SceneDiagnostic) -> Void)? = nil) -> SceneNodeProps {
        if let node = ir.nodes.first(where: { $0.kind == "camera" }) {
            return resolvedProps(node, resolve, diag)
        }
        return SceneNodeProps(position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1],
                              color: "#ffffff", lookAt: [0, 0, 0], fov: 60, near: 0.1, far: 1000,
                              size2d: 5, controls: "", lightKind: "ambient", intensity: 1,
                              range: pointLightDefaultRange, collide: "", boxSize: [1, 1, 1],
                              radius: 1, planeSize: [1, 1], src: "", value: "", anchorKind: "",
                              text3dSize: text3dDefaultSize, texture: "")
    }

    // ── lights (P1: ambient + one directional; P5 adds point lights + fog) ───────────

    static let pointLightDefaultRange = 10.0

    /// the point-light cap: the first 4 in document order; a 5th+ drops with one diagnostic
    static let maxPointLights = 4

    static func sceneLighting(_ ir: SceneIR, _ resolve: SceneResolve,
                              _ diag: ((SceneDiagnostic) -> Void)? = nil) -> SceneLighting {
        var out = SceneLighting(ambientIntensity: 0, ambientColor: "#ffffff",
                                direction: nil, directionalIntensity: 0, directionalColor: "#ffffff",
                                points: [])
        var sawAmbient = false
        var droppedPoints = 0
        for node in ir.nodes where node.kind == "light" {
            let props = resolvedProps(node, resolve, diag)
            if props.lightKind == "point" {
                if out.points.count >= maxPointLights { droppedPoints += 1; continue }
                out.points.append(ScenePointLight(position: props.position, color: props.color,
                                                  intensity: props.intensity, range: props.range))
            } else if props.lightKind == "directional" {
                if out.direction != nil { continue }   // P1: the first directional wins
                let length = SceneMath.length(props.position)
                out.direction = length == 0 ? [0, 1, 0]
                    : [props.position[0] / length, props.position[1] / length, props.position[2] / length]
                out.directionalIntensity = props.intensity
                out.directionalColor = props.color
            } else if !sawAmbient {
                sawAmbient = true
                out.ambientIntensity = props.intensity
                out.ambientColor = props.color
            }
        }
        if droppedPoints > 0 {
            diag?(SceneDiagnostic(
                code: "light-cap",
                message: "\(out.points.count + droppedPoints) point lights authored — the cap is \(maxPointLights), \(droppedPoints) dropped"))
        }
        // an unlit scene still shows its shapes: full ambient is the honest default
        if !sawAmbient && out.direction == nil && out.points.isEmpty { out.ambientIntensity = 1 }
        return out
    }

    // ── the P5 lighting math (corpus lighting.json) ──────────────────────────────────

    /// THE POINT FALLOFF LAW (inverse-square with a smooth range window, pinned):
    /// attenuation(d, range) = window² / (1 + d²) with window = max(0, 1 − (d/range)⁴).
    /// 1 at d = 0, exactly 0 at and past `range`. A non-positive range attenuates to 0.
    static func scenePointAttenuation(distance: Double, range: Double) -> Double {
        if range <= 0 { return 0 }
        let ratio = distance / range
        let window = max(0, 1 - ratio * ratio * ratio * ratio)
        return window * window / (1 + distance * distance)
    }

    /// THE LIT-COLOR LAW (the flat-Lambert model all renderers share, extended by P5):
    /// lit = base · (ambient + dirColor·max(0, n·dirL) + Σᵢ colorᵢ·intensityᵢ·att(dᵢ)·max(0, n·Lᵢ))
    /// with Lᵢ = normalize(positionᵢ − point), dᵢ = |positionᵢ − point|; each channel
    /// clamps to [0, 1] at the end (the shader's min(c, 1)). n is normalized here.
    static func sceneLitColor(base: [Double], normal: [Double], point: [Double],
                              ambient: [Double],
                              directional: (dir: [Double], color: [Double])?,
                              points: [ScenePointLightResolved]) -> [Double] {
        let nLen = SceneMath.length(normal)
        let n = nLen == 0 ? [0.0, 0.0, 0.0] : [normal[0] / nLen, normal[1] / nLen, normal[2] / nLen]
        var light = [ambient[0], ambient[1], ambient[2]]
        if let directional {
            let lambert = max(0, n[0] * directional.dir[0] + n[1] * directional.dir[1] + n[2] * directional.dir[2])
            for c in 0..<3 { light[c] += directional.color[c] * lambert }
        }
        for p in points {
            let toLight = SceneMath.sub(p.position, point)
            let distance = SceneMath.length(toLight)
            if distance == 0 { continue }   // L is undefined at the light's own position — contributes 0
            let l = [toLight[0] / distance, toLight[1] / distance, toLight[2] / distance]
            let lambert = max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2])
            let factor = p.intensity * scenePointAttenuation(distance: distance, range: p.range) * lambert
            for c in 0..<3 { light[c] += p.color[c] * factor }
        }
        return [
            min(1, base[0] * light[0]),
            min(1, base[1] * light[1]),
            min(1, base[2] * light[2]),
        ]
    }

    /// `fog="#color near far"` on `<scene>` — linear fog. Malformed (bad color,
    /// non-finite numbers, far ≤ near) rejects the WHOLE attribute with one diagnostic —
    /// never a half-applied fog. nil = no fog authored.
    static func sceneFog(_ ir: SceneIR, _ resolve: SceneResolve,
                         _ diag: ((SceneDiagnostic) -> Void)? = nil) -> SceneFog? {
        guard let raw = ir.attrs["fog"] else { return nil }
        let resolved = resolve(nil, "fog", raw)
        let parts = resolved.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let color = parts.count == 3 ? parseSceneColor(parts[0]) : nil
        let nearRaw = parts.count == 3 ? Double(parts[1]) : nil
        let farRaw = parts.count == 3 ? Double(parts[2]) : nil
        guard color != nil, let near = nearRaw, near.isFinite, let far = farRaw, far.isFinite, far > near else {
            diag?(SceneDiagnostic(code: "malformed-fog",
                                  message: "fog=\"\(resolved)\" is not \"#color near far\" with far > near — no fog"))
            return nil
        }
        return SceneFog(color: parts[0], near: near, far: far)
    }

    /// THE LINEAR FOG LAW: f = clamp((far − d)/(far − near), 0, 1) for d = the distance
    /// from the EYE to the fragment; final = f·lit + (1 − f)·fogColor (f = 1 unfogged at
    /// and before near, 0 fully fogged at and past far).
    static func sceneFogFactor(distance: Double, near: Double, far: Double) -> Double {
        min(max((far - distance) / (far - near), 0), 1)
    }

    /// #rgb/#rrggbb → [r, g, b] in 0..1, or nil (the caller diags + falls back)
    static func parseSceneColor(_ color: String) -> [Double]? {
        let trimmed = color.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("#") else { return nil }
        let body = String(trimmed.dropFirst())
        guard body.count == 3 || body.count == 6, body.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }   // ASCII only: isHexDigit alone admits fullwidth digits UInt8(_:radix:) then fails on
        let wide = body.count == 6 ? body : body.map { String($0) + String($0) }.joined()
        let chars = Array(wide)
        func channel(_ at: Int) -> Double {
            Double(UInt8(String(chars[at...at + 1]), radix: 16) ?? 0) / 255
        }
        return [channel(0), channel(2), channel(4)]
    }

    /// the picking bounding radius in LOCAL units for a geometry node (nil = unpickable).
    /// The world-space radius scales by the world matrix's largest basis length.
    static func nodeBoundingRadius(_ node: SceneNode, _ props: SceneNodeProps) -> Double? {
        if node.kind == "box" { return SceneMath.length(props.boxSize) / 2 }
        if node.kind == "sphere" { return props.radius }
        if node.kind == "plane" {
            return (props.planeSize[0] * props.planeSize[0] + props.planeSize[1] * props.planeSize[1]).squareRoot() / 2
        }
        // G6: a sprite picks by its quad's bounding circle (the resolved `size` — the
        // texture-aspect refinement is a render-time detail)
        if node.kind == "sprite" {
            return (props.spriteSize[0] * props.spriteSize[0] + props.spriteSize[1] * props.spriteSize[1]).squareRoot() / 2
        }
        return nil
    }

    /// world-space bounding sphere: center = world · origin, radius scaled by the largest
    /// world basis column (uniform-enough for v0 picking)
    static func worldBoundingSphere(_ world: [Double], _ localRadius: Double)
        -> (center: [Double], radius: Double) {
        let center = [world[12], world[13], world[14]]
        let scale = max(
            SceneMath.length([world[0], world[1], world[2]]),
            SceneMath.length([world[4], world[5], world[6]]),
            SceneMath.length([world[8], world[9], world[10]])
        )
        return (center: center, radius: localRadius * scale)
    }
}
