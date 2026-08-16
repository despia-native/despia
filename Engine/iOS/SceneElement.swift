//
//  SceneElement.swift - the iOS `<scene>` element (dsx-scene.md P2): the DSX-native
//  3D/2D engine's SceneKit adapter. The NUMBERS all live in the platform-neutral scene
//  kernel (SceneMath.swift + SceneIR.swift — corpus OpenSource/Conformance/scene/,
//  record-lane host ConformanceHosts.SceneConformance); this file only owns the native
//  adapter: an SCNView whose graph mirrors the IR. SceneKit is a SYSTEM framework — no
//  dependency wave, no WebKit (the confinement rule names WebKit only, and this imports
//  none) — the JavaScriptCore/Tier.swift precedent.
//
//  TRANSFORM EQUIVALENCE (the reason the corpus holds on SceneKit): every SCNNode gets
//  its LOCAL simdTransform set to the corpus local matrix T · Rz · Ry · Rx · S, and
//  SceneKit itself composes parent · child — so its world transform is exactly the
//  corpus world = parentWorld · local, node for node. Geometry size (box `size`, sphere
//  `radius`, plane `size`) rides the SCNGeometry dimensions — the local-unit scale the
//  web renderer applies as model = world · S(geometry) — keeping the corpus-pinned
//  node matrices free of geometry-local scale on both adapters.
//
//  Registered exactly like the other structural elements: a PrivilegedStackComponent
//  subclass (child-node introspection is what a subtree-owning element needs — Stack
//  layout stops at <scene>; StackComponents.didBootstrap also registers it explicitly
//  so surfaces built before the launch class-walk resolve the tag). Reactive like every
//  element: the privileged host re-runs body on each store publish, and updateUIView
//  re-resolves the authored attributes through JSE.interpolate — the SAME interpolation
//  every element attribute uses — touching only the SCNNodes whose values changed is
//  SceneKit's own diffing (property writes on an unchanged value are cheap no-ops).
//  on:tap picking rides SCNView.hitTest mapped back to the IR node, fired through the
//  same runGated path StackNodeView.tap uses. Article-7 fallback diagnostics log once
//  per distinct message via kernelLog (the dev channel, the web console.warn twin).
//
//  P4 (model · text3d · textures · on:frame — dsx-scene.md §7, the Swift follow-up):
//  `<model src>` bytes ride the CONTENT PLANE exactly like `<image src>` (cached-then-
//  fresh, the DSXImageCache.fetch ladder) behind the media-surface URL posture
//  (DSXMediaInputPolicy.validatedRemoteImageURL — the web safeMediaUrl twin), parse
//  through the kernel SceneGltf twin, and mount as DRAW CHILD NODES whose LOCAL
//  simdTransform is draw.world VERBATIM (never decomposed — a glTF `matrix` node may
//  shear, and T·R·S recovery would drift): SceneKit's parent·child composition then
//  makes the effective matrix sceneWorld · draw.world, the corpus model law, with
//  baseColorFactor × node color on a flat Lambert material. `texture=` on box/sphere/
//  plane sets the diffuse to the fetched UIImage NEAREST-sampled and CLAMPED (the
//  pinned UV law's enforceable half — SceneKit's system shapes map the face/longitude
//  UVs, image upright on a +Z face; texel-exact cross-renderer parity is NOT claimed,
//  the P2 stance) with `multiply` carrying the node color (color × texel × lighting —
//  multiplication commutes). `<text3d>` lays out the corpus quad (SceneIRKit.text3dQuad)
//  on an SCNPlane behind an all-axes SCNBillboardConstraint (the billboard law), UNLIT,
//  white UIGraphics-rasterized glyphs (per-platform pixels, deliberately unpinned)
//  modulated by the node color, alpha-transparent edges (the cutout law's SceneKit
//  spelling). `on:frame` is a CADisplayLink loop — NOT the SCNView renderer delegate:
//  the plain path renders on demand (rendersContinuously stays false) and under AR the
//  provider's relay owns the view's delegate slot — feeding the kernel SceneFrameClock
//  (the 60/s budget, corpus frame.json) and dispatching through the SAME runGated path
//  as on:tap; the link exists ONLY while an on:frame handler is authored and the
//  element is mounted, and unmount invalidates it (the lifecycle law).
//
//  P5 (animations · bind · collide · orbit · lighting depth — dsx-scene.md §8, the Swift
//  follow-up; the NUMBERS live in the kernel twins SceneAnim/SceneBind/SceneCollide/
//  SceneOrbit + SceneIRKit, corpus OpenSource/Conformance/scene/): animations override
//  at the RESOLVED ATTRIBUTE plane — the coordinator's resolver consults a per-node
//  OVERRIDE map first (node identity = ObjectIdentifier, the TS object-identity twin);
//  the base resolver never does, so the corpus folds are untouched and the same seam
//  serves tweens, `transition=` retargets and orbit controls. ONE CADisplayLink loop
//  (the P4 link, extended — never two) exists only while an on:frame handler is
//  authored or at least one animation/transition is active, budgeted by the SAME kernel
//  SceneFrameClock; each emitted tick advances the evaluators and re-applies ONLY the
//  nodes whose override changed (the per-node update path — camera/lights route to
//  their appliers). `<group bind key>` reconciles keyed rows (SceneBind — the <list>
//  keying law, ·n suffix + 256 cap): a kept key keeps its SCNNode subtree across
//  reorder, a removed key unmounts it AND stops its animations; row nodes resolve
//  `item.*` through a per-node row scope. The collision pass rides each rendered
//  update (a full apply or a tick's per-node pass — nothing moves without one), only
//  while an on:collide handler is authored, feeding the enter-law tracker and firing
//  on:collide through runGated. Orbit gestures (pan = the drag law, pinch = the zoom
//  law's exponential, tap-pick suppressed after a drag) fold through SceneOrbit into a
//  camera-position override. Point lights (≤4 by the kernel cap) mount as SCNLight
//  .omni nodes and `fog=` maps onto SceneKit's linear fog — equivalence notes at the
//  appliers.
//
//  G2 PHYSICS (dsx-game.md §2 — this file's wiring half; every NUMBER lives in
//  ScenePhysics.swift, corpus OpenSource/Conformance/scene/physics.json): the
//  fixed-tick accumulator rides the ONE CADisplayLink loop (never a second loop) —
//  THE LOOP-EXISTENCE LAW, EXTENDED: the link also exists while any dynamic body is
//  AWAKE or any character exists, and a fully-asleep world stops it (with on:tick);
//  a static scene still runs none. Solver-owned positions and rotations ride the P5
//  override plane INTERPOLATED between the last two steps (alpha = accumulator/dt).
//  THE WRITE LAWS
//  land where base writes land — every store publish and bus `set` funnels through
//  apply(), whose physicsScanWrites detects position/rotation teleports and velocity,
//  angular-velocity or torque command writes. A kinematic transform write wakes the
//  world (v1, no island graph).
//  Kinematics follow the RESOLVED plane each step; character intent reads the `move`
//  attr the same way. on:tick/on:collision/on:enter/on:exit dispatch through the SAME
//  runGated path as on:tap; grounded/sleeping/velocity ride the bus nodes() read.
//
//  mode="ar" (P3): the SAME graph mounts into a camera-composited view the Core/SceneAR
//  MODULE provides through the kernel seam (SceneAR.swift — nil unless that module is
//  in the build; the module borrows Core/AR's one shared ARSession over the bus, so
//  permission + session lifecycle stay module-owned). ARKit composes SceneKit natively,
//  which is the whole point of the P2 transform design: the per-node corpus locals are
//  untouched, the world root just becomes the AR world. <anchor kind="plane"> subtrees
//  mount hidden and reparent onto the matched ARAnchor's node; on:found fires runGated
//  with {kind, id, position}. kind="image" is the P3 named absence. Seam unbound or the
//  session refused (camera denied, Core/AR excluded, unsupported device) → the plain
//  SceneKit render of the same graph + the honest label — never a crash, never a
//  silent camera grab. This file still imports ZERO ARKit (and zero WebKit).
//

import Foundation
import SwiftUI
import SceneKit
import UIKit

/// G1: the per-scope prefab lookup over StackComponents — the kernel only sees the
/// seam (rule 18). A resolved component's body binds to ITS owning scope (the
/// defining-scope law), exactly like component dispatch outside scenes, so a packaged
/// prefab's nested tags mean what they meant where the component was declared.
func scenePrefabLookup(scope: String?) -> ScenePrefabLookup {
    { tag in
        StackComponents.resolve(tag, pkg: scope).map { resolved in
            var def = SceneIRKit.scenePrefabDefFromTemplate(resolved.template)
            def.lookup = scenePrefabLookup(scope: resolved.scope)
            return def
        }
    }
}

final class SceneElement: PrivilegedStackComponent {
    override class var tag: String { "scene" }

    /// the scheduled-notice memo: the scan is STATIC per template + registry + AR seam,
    /// but SwiftUI re-runs `body` on every store publish — without this, each publish
    /// re-parsed and re-expanded the whole scene subtree just to recompute a constant
    /// label. Keyed by a structural fingerprint of the raw markup (tags + the two
    /// attrs the labels depend on) + the scope + the AR seam state; one entry per
    /// distinct scene template, capped defensively.
    private static var scheduledCache: [String: [String]] = [:]

    private static func fingerprint(_ node: StackNode, into out: inout String) {
        out += node.tag
        if let mode = node.attrs["mode"] { out += "|m:" + mode }
        if let kind = node.attrs["kind"] { out += "|k:" + kind }
        out += "("
        for child in node.children { fingerprint(child, into: &out); out += "," }
        out += ")"
    }

    override class func body(_ dsx: PrivilegedStackComponentContext) -> AnyView {
        // AR is live when the markup asks for it AND the Core/SceneAR module bound the
        // kernel seam (SceneAR.swift) — file presence is the gate, never #if. Unbound,
        // the same graph renders through the plain SceneKit path plus the honest label.
        let modeRaw = dsx.node.attrs["mode"] ?? "3d"
        let arLive = modeRaw == "ar" && SceneAR.provider != nil
        var cacheKey = (dsx.env.scope ?? "") + (arLive ? "\u{1F}ar\u{1F}" : "\u{1F}")
        fingerprint(dsx.node, into: &cacheKey)
        let scheduled: [String]
        if let cached = scheduledCache[cacheKey] {
            scheduled = cached
        } else {
            // The scheduled-kind scan is static per template (tags never change at
            // runtime); diagnostics belong to the coordinator's parse, so none are
            // collected here. The scan expands prefabs with the SAME lookup the
            // coordinator uses — an anchor delivered through a prefab body must reach
            // the honest scheduled label (the two parses of one scene must never
            // disagree about its contents).
            let ir = SceneIRKit.parseScene(dsx.node, prefabs: scenePrefabLookup(scope: dsx.env.scope))
            var labels: [String] = []
            if ir.mode == "ar", !arLive { labels.append("mode=\"ar\" (needs the Core/SceneAR module — rendering the plain graph)") }
            func collect(_ nodes: [SceneNode]) {
                for node in nodes {
                    if SceneIRKit.scheduledKinds.contains(node.kind), !labels.contains(where: { $0.hasPrefix("<\(node.kind)") }) {
                        // P3: anchors are live under AR; kind="image" stays the named absence
                        // (model/text3d left the scheduled set when Swift P4 landed).
                        if !arLive { labels.append("<anchor> (mode=\"ar\" + the Core/SceneAR module)") }
                        else if (node.attrs["kind"] ?? "") == "image" { labels.append("<anchor kind=\"image\"> (P3 named absence)") }
                    }
                    collect(node.children)
                }
            }
            collect(ir.nodes)
            if scheduledCache.count > 64 { scheduledCache.removeAll() }
            scheduledCache[cacheKey] = labels
            scheduled = labels
        }
        return AnyView(ZStack(alignment: .bottomLeading) {
            SceneSurface(node: dsx.node, attrs: dsx.attributes,
                         store: dsx.store, env: dsx.env, item: dsx.item, arLive: arLive)
            if !scheduled.isEmpty {
                // the honest scheduled placeholder INSIDE the scene box — the web
                // renderer's .dsx-scene-scheduled notice, SwiftUI-spelled
                Text("Scheduled per dsx-scene.md: " + scheduled.joined(separator: " · "))
                    .font(.system(size: 11))
                    .foregroundColor(Color(UIColor.secondaryLabel))
                    .padding(EdgeInsets(top: 4, leading: 10, bottom: 4, trailing: 10))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(UIColor.systemBackground).opacity(0.72))
            }
        })
    }
}

/// The SCNView host. Like VideoSurface (Video.swift): the representable is rebuilt per
/// render pass, and the Coordinator applies the resolved values to the live view in
/// place — the box geometry (width/height/grow) is the style pipeline's, exactly as
/// image/video size in Stack layout. The mounted view lives inside a plain container:
/// the P3 AR path swaps the render view at runtime (provider AR view → fallback SCNView
/// on a camera denial) without SwiftUI ever seeing the exchange.
private struct SceneSurface: UIViewRepresentable {
    let node: StackNode
    let attrs: [String: String]
    let store: StackStore
    let env: JSERunner
    let item: [String: Any]?
    let arLive: Bool

    func makeCoordinator() -> Coordinator { Coordinator(markup: node, scope: env.scope) }

    // `UIViewRepresentableContext<SceneSurface>` spelled out (not the protocol `Context`
    // typealias): the engine also defines a top-level `Context`, which would shadow it.
    func makeUIView(context: UIViewRepresentableContext<SceneSurface>) -> UIView {
        let container = UIView()
        context.coordinator.mount(in: container, wantsAR: arLive)
        context.coordinator.apply(self)
        return container
    }

    func updateUIView(_ uiView: UIView, context: UIViewRepresentableContext<SceneSurface>) {
        context.coordinator.apply(self)
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.unmount()   // release the camera the moment the element leaves
    }

    final class Coordinator: NSObject {
        private let ir: SceneIR
        private let scene = SCNScene()
        private let cameraNode = SCNNode()
        private let ambientNode = SCNNode()
        private let directionalNode = SCNNode()
        /// P5 point lights, one SCNNode per fold entry (≤ SceneIRKit.maxPointLights)
        private var pointLightNodes: [SCNNode] = []
        private weak var scnView: SCNView?
        /// IR tree key ("0/2/…", SceneIRKit.WorldEntry's scheme) → the mirroring SCNNode;
        /// the same key rides SCNNode.name so a hit test maps back to its IR node.
        private var scnNodes: [String: SCNNode] = [:]
        private var irNodesByKey: [String: SceneNode] = [:]
        /// Article 7: fall back + say so ONCE per distinct message (kernelLog is the dev
        /// channel here — the web adapter's console.warn twin).
        private var reported: Set<String> = []
        private var ready = false
        private var surface: SceneSurface?
        /// G4: the `on:input.<name>` handlers this scene currently subscribes to
        private var inputHandlers: [String: String] = [:]
        private weak var keyResponder: StackInputResponderView?
        // ── mode="ar" (P3) ── the container the render view mounts in, the provider's
        // AR view while live, and the one-way fallback latch (AR → plain SceneKit).
        private weak var container: UIView?
        private var arView: UIView?
        private var arLive = false
        private var fellBack = false
        private var fallbackNote: UILabel?
        /// Per-<anchor> mount state: claimed by an ARAnchor yet, and the latest resolved
        /// kind (default "plane"). Keys are the shared tree keys; `anchorKeys` keeps
        /// document order so matches claim the FIRST unmatched anchor deterministically.
        private struct AnchorMount { var matched = false; var kind = "plane" }
        private var anchorMounts: [String: AnchorMount] = [:]
        private var anchorKeys: [String] = []
        // ── P4 asset caches (src/url/value keyed — the web adapter's maps) and the
        // on:frame machinery (the kernel clock + the element-owned CADisplayLink).
        private enum ModelEntry { case loading, error, ready(GlbModel) }
        private enum TextureEntry { case loading, error, ready(UIImage) }
        private var models: [String: ModelEntry] = [:]        // src → parse state
        private var modelMounts: [String: String] = [:]       // tree key → the mounted src
        // ── G3 clip mixers (skin.json): one SceneClipMixer per `<model animation>`
        // node, advanced per emitted frame tick (manual per-frame sampling — the same
        // CADisplayLink that drives the P5 evaluators; never a CAAnimation, so the
        // corpus mixer/crossfade laws hold verbatim). The mixer recreates when the
        // node's src changes (a new GlbModel).
        private var clipMixers: [ObjectIdentifier: SceneClipMixer] = [:]
        private var clipMixerSrc: [ObjectIdentifier: String] = [:]
        private var textures: [String: TextureEntry] = [:]    // url → decode state
        private var textRasters: [String: UIImage] = [:]      // value → white-glyph raster
        private let frameClock = SceneFrameClock()
        /// G6: the per-key sprite quad child nodes + the fps clock epoch (ms, 0 = unset)
        private var spriteQuadNodes: [String: SCNNode] = [:]
        private var spriteEpochMs: Double = 0
        private var frameLink: CADisplayLink?
        // ── P5 state. The override plane: node identity → attr name → resolved override
        // string (the web adapter's `overrides` map — SceneNode is a class exactly so
        // this can key on identity). `resolve` consults it first; `resolveBase` never.
        private var overrides: [ObjectIdentifier: [String: String]] = [:]
        /// last BASE-resolved value of each authored animatable attr (retarget detection)
        private var baseCache: [ObjectIdentifier: [String: String]] = [:]
        /// bound-row `item.*` scope per node (every node of a row subtree)
        private var rowScopes: [ObjectIdentifier: [String: Any]] = [:]
        /// per-row stamp serial (which registerRowScopes call stamped a node) — the
        /// row-vs-prefab innermost-scope tiebreak (G1; dictionaries are value types, so
        /// the JVM/web map-identity comparison spells as a serial here)
        private var rowSerials: [ObjectIdentifier: Int] = [:]
        private var rowSerialCounter = 0
        /// G1: each node's chain of enclosing prefab ROOTS (outer → inner), stamped
        /// structurally at parse + per row instantiation (the :core ScenePrefabItems twin)
        private var prefabChains: [ObjectIdentifier: [SceneNode]] = [:]
        /// tree keys whose override changed since the last per-node pass
        private var changedOverrideKeys: Set<String> = []
        /// node identity → its tree key, and key → its parent key ("" = root) — the
        /// local-matrix mirrors the collide pass multiplies worlds from
        private var keysByNode: [ObjectIdentifier: String] = [:]
        private var parentKeyByKey: [String: String] = [:]
        private var localsByKey: [String: [Double]] = [:]
        /// document order of first mount — the collide pass's deterministic pair order
        private var mountedOrder: [String] = []
        // implicit transitions (the CSS retarget model)
        private struct TransitionRec {
            var entry: SceneTransitionEntry
            var state: SceneTransitionState
        }
        private var transitions: [ObjectIdentifier: [String: TransitionRec]] = [:]
        private var transitionParse: [ObjectIdentifier: (source: String, entries: [SceneTransitionEntry])] = [:]
        // explicit tweens — one record per <animate>, evaluated by the kernel
        private struct AnimRec {
            var node: SceneNode
            var target: SceneNode
            var playing = false
            var finished = false
            var doneFired = false
            var startMs = 0.0
            var spec: SceneTweenSpec?
            var from: [Double]?
        }
        private var animations: [ObjectIdentifier: AnimRec] = [:]
        private var animationOrder: [ObjectIdentifier] = []
        private static let falsyWhen: Set<String> = ["", "false", "0", "null", "undefined"]
        // collisions: tracker identity is a per-node serial (authored ids may repeat or
        // be absent); the PAYLOAD carries the authored id ("" when none)
        private let collisionTracker = SceneCollisionTracker()
        private var colliderSerial = 0
        private var colliderIds: [ObjectIdentifier: String] = [:]
        private var anyCollideAuthored = false
        // bound groups: group tree key → template + mounted rows (keyed identity)
        private struct BoundRowRec {
            var nodes: [SceneNode]
        }
        private struct BoundGroupRec {
            var template: [SceneNode]
            var keyField: String
            var rows: [String: BoundRowRec] = [:]
            var order: [String] = []
        }
        private var boundGroups: [String: BoundGroupRec] = [:]
        // orbit gestures
        private var dragMoved = false
        private var lastPinchScale: CGFloat = 1
        // ── G5 scene bus (dsx-game.md §2): this coordinator registers into the kernel
        // SceneRegistry seam on mount (the SceneBusSurface conformance below), so the
        // Core/Scene module — and through it any module, action, or MCP agent — can
        // query/drive this element. The bus-owned BASE overlay sits under the store
        // resolver: a bus `set` IS a base change, and detectRetargets glides authored
        // `transition=` properties from it (the P5 plane, never a second path).
        fileprivate var busKey: String?
        fileprivate var busBase: [ObjectIdentifier: [String: String]] = [:]
        /// G6 (found by the 2D walk): a BUS write of the SAME base string is still a
        /// COMMAND. While the solver owns the rendered position the base cache holds the
        /// SPAWN string, so `scene.set(id, "position", <spawn>)` — "put it back where it
        /// started" — must teleport even though nothing about the string changed. The
        /// bus path marks the write FORCED; the next physics scan honours it once.
        fileprivate var physicsForcedWrites: Set<String> = []
        /// the stats() honest profiler read — stamped per emitted frame tick
        fileprivate var busLastFrameDt: Double = 0
        // ── G2 physics (dsx-game.md §2): the fixed-tick solver riding the ONE
        // CADisplayLink loop. Every NUMBER lives in ScenePhysics.swift (corpus
        // physics.json); this coordinator owns only extraction wiring (a
        // signature-keyed re-freeze carrying live state by node identity), the
        // write-law scan, per-step intents, event dispatch, and the interpolated
        // solver-owned position and rotation overrides.
        private let physicsAccumulator = ScenePhysicsAccumulator()
        private var physicsWorld: ScenePhysicsWorld?
        private var physicsAuthored = false
        private var physicsSignature: String?
        private var physicsNodesById: [String: SceneNode] = [:]
        private var physicsIdsByNode: [ObjectIdentifier: String] = [:]
        /// THE PARENT-FRAME LAW: bodies simulate in scene-root space, but a node's
        /// `position` is LOCAL to its parent. A root-level body needs nothing (the fast
        /// path); a nested one — every G1 prefab instance — needs its parent's world so
        /// the solver result can be expressed in that frame. The index is structural
        /// (rebuilt with the world); the matrices re-derive once per write pass.
        private var physicsParentOf: [ObjectIdentifier: SceneNode] = [:]
        private var physicsParentWorlds: [ObjectIdentifier: [Double]]?
        private var physicsAnyNested = false
        /// last BASE-resolved transform/velocity/torque strings per body
        private var physicsWriteCache: [ObjectIdentifier: [String: String]] = [:]
        /// the body-shaping attrs whose base change re-extracts (extents re-freeze)
        private static let physicsShapingAttrs = [
            "physics", "collider", "mass", "bounce", "friction", "trigger", "layer",
            "collides", "speed", "jump", "size", "radius", "angular-damping",
        ]

        init(markup: StackNode, scope: String? = nil) {
            var diagnostics: [SceneDiagnostic] = []
            // G1 prefabs: component tags inside the scene expand through the EXISTING
            // component registry (StackComponents — the same resolution the component
            // dispatch uses); the kernel only sees the lookup seam (rule 18), and each
            // resolved body binds to its OWNING scope (the defining-scope law)
            ir = SceneIRKit.parseScene(markup, diag: { diagnostics.append($0) },
                                       prefabs: scenePrefabLookup(scope: scope))
            super.init()
            for d in diagnostics { diag(d) }
            stampPrefabChains(ir.nodes)
            func index(_ nodes: [SceneNode], _ prefix: String) {
                for (i, node) in nodes.enumerated() {
                    let key = prefix.isEmpty ? String(i) : prefix + "/" + String(i)
                    irNodesByKey[key] = node
                    if node.kind == "anchor" { anchorKeys.append(key) }
                    index(node.children, key)
                }
            }
            index(ir.nodes, "")
            // the on:collide arming scan is static per template (tags/attrs never
            // change at runtime; bound-row templates count — their instances inherit
            // the handler): the pass runs only while SOME handler is authored.
            func scanCollide(_ nodes: [SceneNode]) -> Bool {
                for node in nodes {
                    if node.attrs["on:collide"] != nil { return true }
                    if scanCollide(node.children) { return true }
                }
                return false
            }
            anyCollideAuthored = scanCollide(ir.nodes)
            // the physics arming scan is static per template the same way (bound-row
            // templates count — their instances inherit the physics attr)
            func scanPhysics(_ nodes: [SceneNode]) -> Bool {
                for node in nodes {
                    if node.attrs["physics"] != nil { return true }
                    if scanPhysics(node.children) { return true }
                }
                return false
            }
            physicsAuthored = scanPhysics(ir.nodes)
            let camera = SCNCamera()
            cameraNode.camera = camera
            scene.rootNode.addChildNode(cameraNode)
            ambientNode.light = SCNLight()
            ambientNode.light?.type = .ambient
            scene.rootNode.addChildNode(ambientNode)
            directionalNode.light = SCNLight()
            directionalNode.light?.type = .directional
            scene.rootNode.addChildNode(directionalNode)
        }

        private func diag(_ d: SceneDiagnostic) {
            guard !reported.contains(d.message) else { return }
            reported.insert(d.message)
            kernelLog("[dsx scene] \(d.message)")
        }

        /// Mount the render view into the SwiftUI-owned container. AR (P3): ask the
        /// module-bound provider for the camera-composited view hosting the SAME scene;
        /// session start is async behind it, and any failure lands in fallBack — never
        /// a crash, never a silent camera grab (Article 7). No provider / no AR: the
        /// plain SCNView, exactly the P2 path.
        func mount(in container: UIView, wantsAR: Bool) {
            self.container = container
            // G5: register into the kernel SceneRegistry seam (keyed by the scene's
            // id attr, or the auto key) — the Core/Scene module's door to this element
            if busKey == nil { busKey = SceneRegistry.register(self) }
            if wantsAR, let provider = SceneAR.provider {
                // Arm plane detection when the markup authors any plane anchor (an
                // unresolved hole may still resolve to "plane" — assume yes; armed and
                // unused detection is harmless, the reverse loses the anchor).
                let planes = anchorKeys.contains { key in
                    (irNodesByKey[key]?.attrs["kind"] ?? "plane") != "image"
                }
                if let view = provider.makeARView(
                    scene: scene, planeDetection: planes,
                    onAnchor: { [weak self] match in self?.anchorMatched(match) },
                    onUnavailable: { [weak self] reason in self?.fallBack(reason) }) {
                    arLive = true
                    arView = view
                    install(view)
                    if let scn = view as? SCNView { bind(to: scn) }
                    return
                }
                fallBack("unsupported_device")
                return
            }
            let view = SCNView()
            install(view)
            bind(to: view)
        }

        /// The element left the tree — release the camera (dismantleUIView; deinit is
        /// the belt-and-braces twin, endARView is idempotent by contract) and stop the
        /// on:frame loop (the lifecycle law: unmounting stops it — and CADisplayLink
        /// retains its target, so THIS invalidate is what lets the coordinator deinit).
        func unmount() {
            frameLink?.invalidate()
            frameLink = nil
            // G4: drop every `on:input.<name>` subscription and the key responder
            for name in inputHandlers.keys { DsxInputRuntime.shared.unsubscribe(name, token: self) }
            inputHandlers.removeAll()
            keyResponder?.removeFromSuperview()
            keyResponder = nil
            if let busKey {
                SceneRegistry.unregister(busKey)
                self.busKey = nil
            }
            if let arView {
                SceneAR.provider?.endARView(arView)
                self.arView = nil
            }
        }

        deinit {
            // deinit may run off-main; the provider mutates main-confined state.
            if let view = arView {
                DispatchQueue.main.async { SceneAR.provider?.endARView(view) }
            }
        }

        private func install(_ view: UIView) {
            guard let container else { return }
            view.frame = container.bounds
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(view)
        }

        /// AR turned no — before mount (a device that can never AR) or after (camera
        /// denied, Core/AR excluded, session failure). One-way: release the AR view,
        /// render the SAME graph through the plain SceneKit path, and say so honestly
        /// (kernelLog + the in-box note — the scheduled label's runtime twin, because
        /// the body's static scan cannot know a runtime denial).
        private func fallBack(_ reason: String) {
            guard !fellBack else { return }
            fellBack = true
            if let arView {
                SceneAR.provider?.endARView(arView)
                arView.removeFromSuperview()
                self.arView = nil
            }
            arLive = false
            diag(SceneDiagnostic(code: "ar-unavailable",
                                 message: "mode=\"ar\" is unavailable (\(reason)) — rendering the plain scene graph"))
            let view = SCNView()
            install(view)
            bind(to: view)
            note("AR unavailable (\(reason))")
            if let surface { apply(surface) }
        }

        private func note(_ text: String) {
            guard let container, fallbackNote == nil else { return }
            let label = UILabel()
            label.text = text
            label.font = .systemFont(ofSize: 11)
            label.textColor = .secondaryLabel
            label.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.72)
            label.numberOfLines = 0
            label.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(label)
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                label.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor),
                label.bottomAnchor.constraint(equalTo: container.bottomAnchor)
            ])
            fallbackNote = label
        }

        func bind(to view: SCNView) {
            scnView = view
            view.scene = scene
            view.autoenablesDefaultLighting = false
            view.antialiasingMode = .multisampling4X
            view.isAccessibilityElement = true
            view.accessibilityTraits = .image
            let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
            view.addGestureRecognizer(tap)
            // P5 orbit gestures (inert unless controls="orbit" resolves on the camera,
            // and never under AR — the device pose IS the camera there): pan = the drag
            // law, pinch = the zoom law (SceneOrbit, corpus orbit.json).
            let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
            view.addGestureRecognizer(pan)
            let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
            view.addGestureRecognizer(pinch)
            // AR live: the provider's view owns the camera (the device pose IS the
            // point of view), frame pacing, and the background (the feed).
            guard !arLive else { return }
            view.pointOfView = cameraNode
            view.rendersContinuously = false
        }

        // ── G1 prefab scopes: the per-instance item plane (:core ScenePrefabItems twin) ─

        /// record each node's chain of enclosing prefab ROOTS (outer → inner) —
        /// structural, once per mount/instantiation; the root's OWN attrs resolve at
        /// the INSTANCE SITE, so its chain excludes itself
        private func stampPrefabChains(_ nodes: [SceneNode], _ chain: [SceneNode] = []) {
            rootScopeCache.removeAll()
            for node in nodes {
                if !chain.isEmpty { prefabChains[ObjectIdentifier(node)] = chain }
                let inner = node.prefab != nil ? chain + [node] : chain
                stampPrefabChains(node.children, inner)
            }
        }

        /// the per-pass cache of resolved instance scopes, keyed by prefab ROOT —
        /// [itemPlane] runs once per attribute read per node, so re-deriving the
        /// (unchanged) scope each read is pure waste (the ScenePrefabItems twin's
        /// per-pass cache). Cleared at the top of every [apply] pass and on any
        /// structural restamp.
        private var rootScopeCache: [ObjectIdentifier: [String: Any]] = [:]

        /// the LIVE item scope a node resolves/handles in: the innermost of its prefab
        /// instance scope and its bound-row scope. Scope values re-resolve at the
        /// instance site once per render pass (the per-pass cache), so a store-bound
        /// instance attribute stays reactive (the G1 item-plane law — the Kotlin
        /// ScenePrefabItems.itemFor twin).
        private func itemPlane(_ node: SceneNode) -> [String: Any]? {
            let oid = ObjectIdentifier(node)
            guard let surface else { return rowScopes[oid] }
            guard let chain = prefabChains[oid], let last = chain.last else {
                return rowScopes[oid] ?? surface.item
            }
            // a row instantiated INSIDE the innermost prefab body stamps the prefab
            // root in the same registerRowScopes pass (equal serial); a differing (or
            // absent) stamp means the row is the deeper scope and wins
            if rowScopes[oid] != nil, rowSerials[oid] != rowSerials[ObjectIdentifier(last)] {
                return rowScopes[oid]
            }
            var item: [String: Any]? = nil
            for root in chain {
                let rootOid = ObjectIdentifier(root)
                if let cached = rootScopeCache[rootOid] { item = cached; continue }
                let site = rowScopes[rootOid] ?? item ?? surface.item
                var resolved: [String: Any] = [:]
                for (key, raw) in root.prefab?.scope ?? [:] {
                    resolved[key] = JSE.interpolate(raw, store: surface.store, item: site)
                }
                rootScopeCache[rootOid] = resolved
                item = resolved
            }
            return item
        }

        /// record each node's parent (structural — rebuilt with the physics world)
        private func physicsIndexParents() {
            physicsParentOf = [:]
            func walk(_ list: [SceneNode], _ parent: SceneNode?) {
                for node in list {
                    if let parent { physicsParentOf[ObjectIdentifier(node)] = parent }
                    walk(node.children, node)
                }
            }
            walk(ir.nodes, nil)
        }

        /// the node's parent world matrix (nil = the scene root, the identity fast path)
        private func physicsParentWorld(_ node: SceneNode) -> [Double]? {
            guard let parent = physicsParentOf[ObjectIdentifier(node)] else { return nil }
            if physicsParentWorlds == nil {
                var map: [ObjectIdentifier: [Double]] = [:]
                for entry in SceneIRKit.worldMatrices(ir.nodes, kernelResolve(base: false), { [weak self] in self?.diag($0) }) {
                    map[ObjectIdentifier(entry.node)] = entry.world
                }
                physicsParentWorlds = map
            }
            return physicsParentWorlds?[ObjectIdentifier(parent)]
        }

        /// the BASE resolver: the bus overlay first (a module `scene.set` writes it —
        /// the G5 write plane), then holes through the live store in the node's row/
        /// prefab scope — never the override plane (the base an animation glides toward)
        private func resolveBase(_ node: SceneNode?, _ name: String, _ raw: String) -> String {
            if let node, let value = busBase[ObjectIdentifier(node)]?[name] { return value }
            guard let surface else { return raw }
            let item = node.flatMap { itemPlane($0) } ?? surface.item
            return JSE.interpolate(raw, store: surface.store, item: item)
        }

        /// the SceneResolve closure the kernel folds consume. base: false = the OVERRIDE
        /// plane first (what renders — animations/orbit win), then the store; base: true
        /// = the store only (what a tween's `from` defaults to, what a transition
        /// retargets toward).
        private func kernelResolve(base: Bool) -> SceneResolve {
            { [weak self] node, name, raw in
                guard let self else { return raw }
                if !base, let node, let value = self.overrides[ObjectIdentifier(node)]?[name] {
                    return value
                }
                return self.resolveBase(node, name, raw)
            }
        }

        /// One pass over the IR with the LIVE resolver — every authored attribute
        /// re-resolves through the same {{ }} interpolation as any element attribute
        /// (overrides applied on top), and the touched SCNNode transforms/materials
        /// update in place.
        func apply(_ surface: SceneSurface) {
            self.surface = surface
            syncInputHandlers(surface)
            // the store may have changed since the last pass — resolved instance
            // scopes re-derive once per pass, not once per attribute read
            rootScopeCache.removeAll()
            // G2: the write laws land where base writes land — every store publish and
            // bus `set` funnels through here, BEFORE the walk's retarget detector
            physicsScanWrites()
            let resolve = kernelResolve(base: false)
            applyBackground(surface, resolve)
            walk(ir.nodes, parent: scene.rootNode, prefix: "", parentKey: "", resolve: resolve)
            applyCamera(resolve)
            applyLighting(resolve)
            changedOverrideKeys.removeAll()   // the full pass just applied everything
            collisionPass()
            syncFrameLoop()
            if !ready {
                // `ready` fires ONCE, render-safe (apply runs inside the view-update
                // pass — see JSE.afterRender), mirroring the web adapter's first draw.
                ready = true
                if let action = surface.attrs["on:ready"] {
                    JSE.afterRender { surface.env.run(action, item: surface.item, args: [:]) }
                }
                // the bus event door (G5) — the Core/Scene module re-fires this as
                // scene.ready on the standard planes
                if let busKey {
                    JSE.afterRender { SceneRegistry.emit(scene: busKey, kind: "ready", payload: ["scene": busKey]) }
                }
            }
        }

        private func applyBackground(_ surface: SceneSurface, _ resolve: SceneResolve) {
            guard !arLive else { return }   // the camera feed IS the background
            let raw = ir.attrs["background"] ?? "#000000"
            let resolved = resolve(nil, "background", raw)
            var rgb = SceneIRKit.parseSceneColor(resolved)
            if rgb == nil {
                diag(SceneDiagnostic(code: "malformed-number",
                                     message: "background=\"\(resolved)\" is not a #hex color — using #000000"))
                rgb = [0, 0, 0]
            }
            scnView?.backgroundColor = color(rgb ?? [0, 0, 0])
        }

        private func color(_ rgb: [Double], intensity: Double = 1) -> UIColor {
            UIColor(red: CGFloat(min(1, rgb[0] * intensity)),
                    green: CGFloat(min(1, rgb[1] * intensity)),
                    blue: CGFloat(min(1, rgb[2] * intensity)), alpha: 1)
        }

        private func walk(_ nodes: [SceneNode], parent: SCNNode, prefix: String,
                          parentKey: String, resolve: SceneResolve) {
            for (i, node) in nodes.enumerated() {
                let key = prefix.isEmpty ? String(i) : prefix + "/" + String(i)
                mount(node, parent: parent, key: key, parentKey: parentKey, resolve: resolve)
            }
        }

        /// one node's pass — shared by the static walk and the bound-row walk (rows
        /// mount under `groupKey#rowKey/…` keys so keyed identity survives reorder)
        private func mount(_ node: SceneNode, parent: SCNNode, key: String, parentKey: String,
                           resolve: SceneResolve) {
            let oid = ObjectIdentifier(node)
            keysByNode[oid] = key
            irNodesByKey[key] = node
            parentKeyByKey[key] = parentKey
            if node.kind == "animate" {
                // P5: a CONTROLLER, not a transform — no SCNNode; register the record
                registerAnimation(node, parentKey: parentKey)
                return
            }
            let scn: SCNNode
            if let existing = scnNodes[key] {
                scn = existing
            } else {
                scn = SCNNode()
                scn.name = key
                if node.kind == "text3d" {
                    // the BILLBOARD law: the quad always faces the camera — the
                    // constraint re-orients at draw time (never the layout corpus)
                    let billboard = SCNBillboardConstraint()
                    billboard.freeAxes = .all
                    scn.constraints = [billboard]
                }
                if node.kind == "anchor" {
                    // P3: an <anchor> subtree mounts HIDDEN until a matching
                    // ARAnchor arrives — under AR it stays DETACHED (it reparents
                    // onto the anchor's live node on match, anchorMatched); outside
                    // AR it holds its place hidden (never fake world content).
                    scn.isHidden = true
                    if !arLive { parent.addChildNode(scn) }
                    anchorMounts[key] = AnchorMount()
                } else {
                    parent.addChildNode(scn)
                }
                scnNodes[key] = scn
                mountedOrder.append(key)
            }
            // detect base changes BEFORE resolving: an authored animatable attr whose
            // BASE value changed retargets its `transition=` entry (the CSS model)
            detectRetargets(node)
            let props = SceneIRKit.resolvedProps(node, resolve, diag)
            if node.kind == "anchor", var mount = anchorMounts[key], !mount.matched {
                // keep the latest RESOLVED kind (holes re-resolve live) until claimed
                mount.kind = props.anchorKind.isEmpty ? "plane" : props.anchorKind
                anchorMounts[key] = mount
            }
            // LOCAL transform only — SceneKit composes parent · child itself, so with
            // local = T·Rz·Ry·Rx·S its composed world IS the corpus world (header note).
            let local = SceneMath.trs(position: props.position, rotationDeg: props.rotation, scale: props.scale)
            localsByKey[key] = local
            scn.simdTransform = Self.simdMatrix(local)
            applyGeometry(node, props, to: scn, key: key)
            if node.kind == "group", node.attrs["bind"] != nil {
                // P5: template children instantiate per row, never statically
                reconcileBoundGroup(node, groupKey: key, scn: scn, resolve: resolve)
                return
            }
            walk(node.children, parent: scn, prefix: key, parentKey: key, resolve: resolve)
        }

        private func applyGeometry(_ node: SceneNode, _ props: SceneNodeProps, to scn: SCNNode, key: String) {
            switch node.kind {
            case "box":
                let box = (scn.geometry as? SCNBox) ?? SCNBox(width: 1, height: 1, length: 1, chamferRadius: 0)
                box.width = CGFloat(props.boxSize[0])
                box.height = CGFloat(props.boxSize[1])
                box.length = CGFloat(props.boxSize[2])
                scn.geometry = box
            case "sphere":
                let sphere = (scn.geometry as? SCNSphere) ?? SCNSphere(radius: 1)
                sphere.radius = CGFloat(props.radius)
                scn.geometry = sphere
            case "plane":
                // SCNPlane sits in the local XY plane facing +Z — the corpus plane law
                // (rotate -90° about X for a ground plane), two-sided like the web shader.
                let plane = (scn.geometry as? SCNPlane) ?? SCNPlane(width: 1, height: 1)
                plane.width = CGFloat(props.planeSize[0])
                plane.height = CGFloat(props.planeSize[1])
                scn.geometry = plane
            case "sprite":
                // G6: the 2D primitive — a textured quad on its own child node (its
                // own path: the anchor offset, the sheet UV rect, the cutout).
                applySprite(props, to: scn, key: key)
                return
            case "model":
                // P4: the GLB draw list mounts as draw child nodes (their own path).
                applyModel(props, to: scn, key: key)
                return
            case "text3d":
                // P4: the billboard quad (its own path — unlit, alpha, no shared tint).
                applyText3d(props, to: scn)
                return
            default:
                // group composes; camera/light transforms ride the same plane (the
                // RENDERING camera + lights are the adapter-owned nodes below, fed by
                // the same sceneCamera/sceneLighting fold the corpus pins); <anchor>
                // renders the labelled placeholder outside AR (the P3 row).
                scn.geometry = nil
                return
            }
            let rgb = nodeColor(props)
            let material = scn.geometry?.firstMaterial ?? SCNMaterial()
            material.lightingModel = .lambert
            material.isDoubleSided = node.kind == "plane"
            if !props.texture.isEmpty, let image = textureImage(props.texture) {
                // the pinned UV law's enforceable half on SceneKit: NEAREST sampling
                // clamped to the edge (the system box/plane/sphere geometries map the
                // face / longitude-latitude UVs, image upright on a +Z face — texel-exact
                // cross-renderer parity is NOT claimed, the P2 stance); the texel
                // MODULATES the lit color: `multiply` post-multiplies the node color,
                // the same color × texel × lighting product as the web shader.
                material.diffuse.contents = image
                Self.nearestClamp(material.diffuse)
                material.multiply.contents = color(rgb)
            } else {
                // untextured (or still loading / failed — the web adapter's white-texture
                // fallback): the plain lit color, exactly the P2 material
                material.diffuse.contents = color(rgb)
                material.multiply.contents = nil
            }
            scn.geometry?.firstMaterial = material
        }

        /// the diag'd #hex parse every geometry path shares (the web nodeColor twin)
        private func nodeColor(_ props: SceneNodeProps) -> [Double] {
            if let rgb = SceneIRKit.parseSceneColor(props.color) { return rgb }
            diag(SceneDiagnostic(code: "malformed-number",
                                 message: "color=\"\(props.color)\" is not a #hex color — using #ffffff"))
            return [1, 1, 1]
        }

        /// NEAREST + clamp-to-edge on a material property — the UV law's sampling half
        private static func nearestClamp(_ property: SCNMaterialProperty) {
            property.magnificationFilter = .nearest
            property.minificationFilter = .nearest
            property.mipFilter = .none
            property.wrapS = .clamp
            property.wrapT = .clamp
        }

        // ── P4 `<model src>` — the GLB draw list on SceneKit ─────────────────────────

        /// The parsed draws mount as CHILD NODES under the element node. The element
        /// node's simdTransform is already the corpus local (walk), so SceneKit's
        /// parent·child composition makes each draw's effective matrix
        /// sceneWorld · draw.world — the corpus model law — with draw.world set as the
        /// child's LOCAL transform matrix VERBATIM (never decomposed onto position/
        /// rotation/scale: a glTF `matrix` node may shear, and T·R·S recovery would
        /// drift from the corpus numbers). Materials re-tint per apply (holes in
        /// `color` re-resolve live): baseColorFactor × node color, flat Lambert.
        private func applyModel(_ props: SceneNodeProps, to scn: SCNNode, key: String) {
            scn.geometry = nil
            guard !props.src.isEmpty, case .ready(let model) = modelEntry(props.src) else {
                unmountModel(scn, key: key)
                return
            }
            let drawName = key + "#draw"
            if modelMounts[key] != props.src {
                unmountModel(scn, key: key)
                for draw in model.draws where draw.mesh < model.meshes.count {
                    for primitive in model.meshes[draw.mesh].primitives {
                        let child = SCNNode()
                        child.name = drawName
                        child.simdTransform = Self.simdMatrix(draw.world)
                        child.geometry = Self.primitiveGeometry(primitive)
                        scn.addChildNode(child)
                    }
                }
                modelMounts[key] = props.src
            }
            // tint pass — childNodes preserves the mount order, so zip the same walk
            let tint = nodeColor(props)
            let children = scn.childNodes.filter { $0.name == drawName }
            var i = 0
            for draw in model.draws where draw.mesh < model.meshes.count {
                for primitive in model.meshes[draw.mesh].primitives {
                    guard i < children.count else { return }
                    let material = children[i].geometry?.firstMaterial ?? SCNMaterial()
                    material.lightingModel = .lambert
                    material.diffuse.contents = color([tint[0] * primitive.baseColor[0],
                                                       tint[1] * primitive.baseColor[1],
                                                       tint[2] * primitive.baseColor[2]])
                    children[i].geometry?.firstMaterial = material
                    i += 1
                }
            }
        }

        private func unmountModel(_ scn: SCNNode, key: String) {
            guard modelMounts[key] != nil else { return }
            modelMounts[key] = nil
            for child in scn.childNodes where child.name == key + "#draw" {
                child.removeFromParentNode()
            }
        }

        // ── G3 `<model animation loop blend>` — the clip mixer on SceneKit ───────────

        /// Advance every `<model animation>` node's mixer at the link stamp and apply
        /// the sampled pose: the kernel recomputes the GLB node worlds (animated
        /// transforms move unskinned draws too — each draw child's LOCAL transform
        /// updates), folds the joint matrices and CPU-skins JOINTS_0/WEIGHTS_0
        /// primitives into rebuilt flat-shaded geometry (GPU skinning is the named
        /// perf upgrade). Every NUMBER lives in SceneSkin.swift (corpus skin.json).
        private func advanceClips(_ stamp: Double) {
            for (key, node) in irNodesByKey where node.kind == "model" && node.attrs["animation"] != nil {
                guard let scn = scnNodes[key] else { continue }
                let props = SceneIRKit.resolvedProps(node, kernelResolve(base: true), diag)
                guard !props.src.isEmpty, case .ready(let model) = modelEntry(props.src) else { continue }
                let oid = ObjectIdentifier(node)
                if clipMixerSrc[oid] != props.src {
                    clipMixers[oid] = SceneClipMixer(model: model) { [weak self] in self?.diag($0) }
                    clipMixerSrc[oid] = props.src
                }
                guard let mixer = clipMixers[oid] else { continue }
                mixer.update(name: props.animation, loop: props.clipLoop,
                             blendMs: props.blendMs, nowMs: stamp)
                applyClipPose(model, pose: mixer.pose(nowMs: stamp), to: scn, key: key)
            }
        }

        /// one sampled pose onto the mounted draw children (mount order = the tint
        /// pass's zip order): child.simdTransform = the pose-aware node world; a
        /// skinned draw's geometry rebuilds from the CPU-skinned positions with flat
        /// facet normals (the raster stance), keeping its material (the tint pass owns
        /// color)
        private func applyClipPose(_ model: GlbModel, pose: GlbPose, to scn: SCNNode, key: String) {
            let worlds = SceneSkin.nodeWorlds(model, pose: pose)
            let children = scn.childNodes.filter { $0.name == key + "#draw" }
            var i = 0
            for draw in model.draws where draw.mesh < model.meshes.count {
                let world = draw.node < worlds.count ? worlds[draw.node] : draw.world
                let matrices = draw.skin.map {
                    SceneSkin.jointMatrices(model, skin: $0, meshNode: draw.node, worlds: worlds)
                }
                for primitive in model.meshes[draw.mesh].primitives {
                    guard i < children.count else { return }
                    children[i].simdTransform = Self.simdMatrix(world)
                    if let matrices,
                       let skinned = SceneSkin.skinnedPrimitivePositions(primitive, matrices: matrices) {
                        let material = children[i].geometry?.firstMaterial
                        let posed = GlbPrimitive(positions: skinned, normals: [],
                                                 indices: primitive.indices,
                                                 baseColor: primitive.baseColor)
                        let geometry = Self.primitiveGeometry(posed)
                        if let material { geometry.firstMaterial = material }
                        children[i].geometry = geometry
                    }
                    i += 1
                }
            }
        }

        /// Bytes ride the CONTENT PLANE exactly like `<image src>` (the DSXImageCache
        /// ladder: cached-then-fresh — DSXContent single-flights, verifies and ingests
        /// underneath) behind the media-surface URL posture
        /// (DSXMediaInputPolicy.validatedRemoteImageURL, the web safeMediaUrl twin).
        /// Parse lands back on MAIN and re-applies the surface (the fallBack precedent);
        /// a broken container is a diag'd VALUE — not drawn, never a throw (Article 7).
        private func modelEntry(_ src: String) -> ModelEntry {
            if let entry = models[src] { return entry }
            guard let url = DSXMediaInputPolicy.validatedRemoteImageURL(src) else {
                diag(SceneDiagnostic(code: "malformed-number",
                                     message: "<model src=\"\(src)\"> is not a loadable URL — not drawn"))
                models[src] = .error
                return .error
            }
            models[src] = .loading
            let target = url.absoluteString
            Task.detached(priority: .utility) {
                var bytes = DSXContent.cachedFile(target)
                if bytes == nil { bytes = await DSXContent.freshFile(target) }
                let result = bytes.map { SceneGltf.parseGlb($0) }
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    switch result {
                    case .some(.ok(let model)):
                        self.models[src] = .ready(model)
                        if let surface = self.surface { self.apply(surface) }
                    case .some(.fail(let error)):
                        self.models[src] = .error
                        self.diag(SceneDiagnostic(code: "malformed-number",
                                                  message: "<model src=\"\(src)\"> did not parse (\(error.rawValue)) — not drawn"))
                    case .none:
                        self.models[src] = .error
                        self.diag(SceneDiagnostic(code: "malformed-number",
                                                  message: "<model src=\"\(src)\"> failed to load — not drawn"))
                    }
                }
            }
            return .loading
        }

        /// positions/normals/indices → SCNGeometry. Absent normals FLAT-SHADE: the
        /// primitive de-indexes and every triangle carries its face normal (the web
        /// renderer's twin of the same fallback).
        private static func primitiveGeometry(_ primitive: GlbPrimitive) -> SCNGeometry {
            var positions = primitive.positions
            var normals = primitive.normals
            var indices = primitive.indices
            if normals.isEmpty {
                var flatPositions: [Double] = []
                var flatNormals: [Double] = []
                for t in stride(from: 0, to: indices.count - 2, by: 3) {
                    let a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
                    guard max(a, b, c) + 2 < positions.count else { continue }
                    let pa = [positions[a], positions[a + 1], positions[a + 2]]
                    let pb = [positions[b], positions[b + 1], positions[b + 2]]
                    let pc = [positions[c], positions[c + 1], positions[c + 2]]
                    let n = SceneMath.normalize(SceneMath.cross(SceneMath.sub(pb, pa), SceneMath.sub(pc, pa)))
                    flatPositions += pa + pb + pc
                    flatNormals += n + n + n
                }
                positions = flatPositions
                normals = flatNormals
                indices = Array(0..<(positions.count / 3))
            }
            var vertices: [SCNVector3] = []
            var normalVectors: [SCNVector3] = []
            for i in stride(from: 0, to: positions.count - 2, by: 3) {
                vertices.append(SCNVector3(positions[i], positions[i + 1], positions[i + 2]))
            }
            for i in stride(from: 0, to: normals.count - 2, by: 3) {
                normalVectors.append(SCNVector3(normals[i], normals[i + 1], normals[i + 2]))
            }
            let element = SCNGeometryElement(indices: indices.map { Int32($0) }, primitiveType: .triangles)
            var sources = [SCNGeometrySource(vertices: vertices)]
            if normalVectors.count == vertices.count { sources.append(SCNGeometrySource(normals: normalVectors)) }
            return SCNGeometry(sources: sources, elements: [element])
        }

        /// `texture=` bytes take the SAME content-plane ladder as the model (and the
        /// `<image>` element); decode is a plain bounded UIImage(data:) — the plane's
        /// 4 MiB transport ceiling bounds the transfer, and the image ceiling is kept
        /// as the tighter-of-two guard (the DSXImageCache posture).
        private func textureImage(_ url: String) -> UIImage? {
            switch textures[url] {
            case .ready(let image): return image
            case .loading, .error: return nil
            case .none: break
            }
            guard let valid = DSXMediaInputPolicy.validatedRemoteImageURL(url) else {
                diag(SceneDiagnostic(code: "malformed-number",
                                     message: "texture=\"\(url)\" is not a loadable image URL — untextured"))
                textures[url] = .error
                return nil
            }
            textures[url] = .loading
            let target = valid.absoluteString
            Task.detached(priority: .utility) {
                var bytes = DSXContent.cachedFile(target)
                if bytes == nil { bytes = await DSXContent.freshFile(target) }
                let image: UIImage? = bytes.flatMap {
                    $0.count <= DSXMediaInputPolicy.maximumEncodedImageBytes ? UIImage(data: $0) : nil
                }
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    if let image {
                        self.textures[url] = .ready(image)
                        if let surface = self.surface { self.apply(surface) }
                    } else {
                        self.textures[url] = .error
                        self.diag(SceneDiagnostic(code: "malformed-number",
                                                  message: "texture=\"\(url)\" failed to load — untextured"))
                    }
                }
            }
            return nil
        }

        // ── G6 `<sprite>` — the 2D primitive (corpus sprite.json) ────────────────────

        /// THE QUAD LAW: an SCNPlane in the node's LOCAL XY plane facing +Z, riding the
        /// node's world transform exactly like `<plane>` — in mode="2d" that IS
        /// camera-facing (the orthographic camera looks down −Z); BILLBOARDING IN 3D IS
        /// A NAMED ABSENCE, so an authored `rotation` keeps meaning what it means
        /// everywhere else. The quad lives on a CHILD node carrying the ANCHOR OFFSET so
        /// the sprite node's own corpus-local transform stays untouched (and the offset
        /// never reaches the node's scene children — the web/JVM shape, 1:1). The
        /// sheet's frame rectangle rides `diffuse.contentsTransform` — the SceneKit
        /// spelling of the web lane's UV offset/scale uniform pair, with `flip` as a
        /// negative scale. An authored `src` draws NOTHING until its texture arrives
        /// (the `<model>` posture); a src-less sprite is an honest flat `color` quad.
        private func applySprite(_ props: SceneNodeProps, to scn: SCNNode, key: String) {
            let image = props.src.isEmpty ? nil : textureImage(props.src)
            if !props.src.isEmpty, image == nil {
                spriteQuadNodes[key]?.removeFromParentNode()
                spriteQuadNodes[key] = nil
                return
            }
            var aspect: Double? = nil
            if let image, image.size.height > 0 {
                aspect = Double(image.size.width) / Double(image.size.height)
            }
            let size = SceneSprite.sizeOf(props, aspect)
            let frame = SceneSprite.frameAt(props, spriteElapsedSeconds())
            let offset = SceneSprite.anchorOffset(props, size[0], size[1])
            let quad: SCNNode
            if let existing = spriteQuadNodes[key] {
                quad = existing
            } else {
                quad = SCNNode()
                scn.addChildNode(quad)
                spriteQuadNodes[key] = quad
            }
            quad.simdTransform = Self.simdMatrix(
                SceneMath.trs(position: offset, rotationDeg: [0, 0, 0], scale: [1, 1, 1]))
            let plane = (quad.geometry as? SCNPlane) ?? SCNPlane(width: 1, height: 1)
            plane.width = CGFloat(size[0])
            plane.height = CGFloat(size[1])
            quad.geometry = plane
            let material = quad.geometry?.firstMaterial ?? SCNMaterial()
            material.lightingModel = .lambert
            material.isDoubleSided = true
            if let image {
                material.diffuse.contents = image
                Self.nearestClamp(material.diffuse)
                let uv = SceneSprite.uvRect(props, frame)
                let scaled = SCNMatrix4MakeScale(Float(uv[2] - uv[0]), Float(uv[3] - uv[1]), 1)
                material.diffuse.contentsTransform =
                    SCNMatrix4Translate(scaled, Float(uv[0]), Float(uv[1]), 0)
                // the texel MODULATES the tint (the P4 texture law) and alpha CUTS OUT —
                // the sprite silhouette, the text3d transparency path verbatim
                material.multiply.contents = color(nodeColor(props))
                material.transparencyMode = .aOne
            } else {
                material.diffuse.contents = color(nodeColor(props))
                material.diffuse.contentsTransform = SCNMatrix4Identity
                material.multiply.contents = nil
            }
            // G6 THE 2D DRAW-ORDER LAW: inside mode="2d" z IS the draw order — higher z
            // draws IN FRONT. SceneKit renders by ASCENDING renderingOrder, so a key
            // monotone in world z IS the painter's order, with depth reads/writes off so
            // coplanar sprites layer instead of z-fighting.
            if ir.mode == "2d" {
                material.writesToDepthBuffer = false
                material.readsFromDepthBuffer = false
                quad.renderingOrder = Int((Double(scn.worldPosition.z) * 1000).rounded())
            }
            quad.geometry?.firstMaterial = material
        }

        /// G6: `fps` sprite clocks measure from the element's first draw — the frame
        /// index is a pure function of elapsed seconds (the corpus fold), never a timer
        private func spriteElapsedSeconds() -> Double {
            if spriteEpochMs == 0 { spriteEpochMs = nowMs() }
            return (nowMs() - spriteEpochMs) / 1000
        }

        /// G6: an fps-driven sprite re-reads its frame every EMITTED tick — the sheet
        /// advances with no store write, on the ONE existing loop
        private func applyAnimatedSprites() {
            guard !spriteQuadNodes.isEmpty || irNodesByKey.values.contains(where: { $0.kind == "sprite" }) else { return }
            let resolve = kernelResolve(base: false)
            for (key, node) in irNodesByKey where node.kind == "sprite" {
                guard let scn = scnNodes[key] else { continue }
                let props = SceneIRKit.resolvedProps(node, resolve, nil)
                if props.spriteFps <= 0 { continue }
                applySprite(props, to: scn, key: key)
            }
        }

        /// G6 the loop-existence extension: an fps-driven sprite keeps the loop alive —
        /// a looping strip forever, a loop="false" strip only until its last frame
        private func spritesWantTick() -> Bool {
            let elapsed = spriteElapsedSeconds()
            let resolve = kernelResolve(base: false)
            for (_, node) in irNodesByKey where node.kind == "sprite" {
                let props = SceneIRKit.resolvedProps(node, resolve, nil)
                if props.spriteFps <= 0 { continue }
                if props.spriteLoop { return true }
                if SceneSprite.frameAt(props, elapsed) < SceneSprite.frameCount(props) - 1 { return true }
            }
            return false
        }

        // ── P4 `<text3d>` — the corpus quad on a billboard ───────────────────────────

        /// The quad LAW is the kernel's (SceneIRKit.text3dQuad: height = size, width =
        /// size × 0.6 × code points, center = position — the node transform already
        /// carries `position`, the SCNPlane carries the extents); the billboard
        /// constraint set at node creation keeps it camera-facing; UNLIT (.constant)
        /// so labels stay legible; white glyphs modulated by the node color; alpha
        /// transparency cuts the empty texels (the cutout law's SceneKit spelling).
        private func applyText3d(_ props: SceneNodeProps, to scn: SCNNode) {
            guard let quad = SceneIRKit.text3dQuad(props), let raster = textRaster(props.value) else {
                scn.geometry = nil      // empty value → no quad, nothing drawn
                return
            }
            let plane = (scn.geometry as? SCNPlane) ?? SCNPlane(width: 1, height: 1)
            plane.width = CGFloat(quad.halfWidth * 2)
            plane.height = CGFloat(quad.halfHeight * 2)
            scn.geometry = plane
            let material = scn.geometry?.firstMaterial ?? SCNMaterial()
            material.lightingModel = .constant
            material.isDoubleSided = true
            material.diffuse.contents = raster
            Self.nearestClamp(material.diffuse)
            material.multiply.contents = color(nodeColor(props))
            material.transparencyMode = .aOne
            scn.geometry?.firstMaterial = material
        }

        /// rasterize the value through UIGraphics — WHITE glyphs on transparency (the
        /// node color modulates), the canvas aspect matching the quad law (0.6/char) so
        /// glyphs are not stretched. Glyph pixels are per-platform and deliberately
        /// unpinned (the corpus honest scope line) — Core Text draws here.
        private func textRaster(_ value: String) -> UIImage? {
            if let cached = textRasters[value] { return cached }
            let characters = value.unicodeScalars.count
            guard characters > 0 else { return nil }
            let height: CGFloat = 64
            let width = max(1, (height * 0.6 * CGFloat(characters)).rounded())
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = false
            let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height),
                                                format: format).image { _ in
                var font = UIFont.systemFont(ofSize: (height * 0.78).rounded())
                let text = value as NSString
                var measured = text.size(withAttributes: [.font: font])
                if measured.width > width, measured.width > 0 {
                    // scale-to-fit (the web rasterizer's setTransform squeeze twin)
                    font = UIFont.systemFont(ofSize: font.pointSize * width / measured.width)
                    measured = text.size(withAttributes: [.font: font])
                }
                text.draw(at: CGPoint(x: (width - measured.width) / 2, y: (height - measured.height) / 2),
                          withAttributes: [.font: font, .foregroundColor: UIColor.white])
            }
            textRasters[value] = image
            return image
        }

        // ── the ONE tick loop (P4 on:frame + P5 animations) ──────────────────────────

        /// The loop exists ONLY while an on:frame handler is authored OR at least one
        /// animation/transition is active (`loopActive`) and the element is mounted —
        /// a static scene never spins (the P1 law stands), and unmount invalidates the
        /// link. ONE CADisplayLink serves both consumers — never two loops. (Not the
        /// SCNView renderer delegate: the plain path renders on demand —
        /// rendersContinuously stays false — and under AR the provider's relay owns the
        /// view's delegate slot, SceneARBridge.) The link is the platform raw-tick
        /// source, the rAF / withFrameNanos twin.
        private func syncFrameLoop() {
            let needed = loopActive()
            if needed, frameLink == nil, container != nil {
                let link = CADisplayLink(target: self, selector: #selector(frameTick(_:)))
                link.add(to: .main, forMode: .common)
                frameLink = link
            } else if !needed, let link = frameLink {
                link.invalidate()
                frameLink = nil
            }
        }

        /// One raw platform tick → the kernel SceneFrameClock (the 60/s budget law,
        /// corpus frame.json — a 120 Hz link coalesces every second tick). Each EMITTED
        /// tick dispatches on:frame through the SAME runGated path as on:tap with
        /// { dt, elapsed, frame }, advances the P5 evaluators (the budget applies to
        /// animation advance too — the web loopTick twin), re-applies only the nodes
        /// whose override changed, and runs the render-riding collision pass.
        @objc private func frameTick(_ link: CADisplayLink) {
            guard let surface else {
                link.invalidate()
                frameLink = nil
                return
            }
            // G4 unified input: the gamepad is POLLED INSIDE THE LOOP THAT ALREADY EXISTS —
            // one line, no second display link (StackInputHost.swift, "the loop-existence law
            // applied to input"); keyboard and touch commit on their own event edges.
            DsxInputRuntime.shared.pollGamepad()
            let stamp = link.timestamp * 1000
            guard let payload = frameClock.tick(stamp) else { return }   // coalesced
            busLastFrameDt = payload.dt   // the stats() honest profiler read
            if let action = surface.attrs["on:frame"] {
                surface.env.runGated(action, item: surface.item,
                                     args: ["dt": payload.dt, "elapsed": payload.elapsed, "frame": payload.frame],
                                     debounceMs: JSERunner.gateMs(surface.attrs, event: "frame", kind: "debounce"),
                                     throttleMs: JSERunner.gateMs(surface.attrs, event: "frame", kind: "throttle"),
                                     gateKey: "scene.frame")
            }
            _ = advanceTransitions(stamp)
            _ = advanceAnimations(stamp)
            advanceClips(stamp)
            applyAnimatedSprites()   // G6: the fps sheet advances on the SAME loop
            // G2: the fixed-tick solver rides the same loop AFTER animations
            // (kinematics read animation overrides written this tick), interpolating
            // solver-owned positions into overrides applyChangedNodes re-applies
            advancePhysics(payload.dt)
            applyChangedNodes()
            collisionPass()
            if !loopActive() {
                link.invalidate()
                frameLink = nil
            }
        }

        // ── P5 explicit tweens + implicit transitions (the kernel SceneAnim evaluators;
        // this adapter owns start state, the when gate, on:done, and the override plane)

        private func nowMs() -> Double { CACurrentMediaTime() * 1000 }   // the link's timebase

        private func setOverride(_ oid: ObjectIdentifier, _ name: String, _ value: String) {
            var bucket = overrides[oid] ?? [:]
            bucket[name] = value
            overrides[oid] = bucket
            if let key = keysByNode[oid] { changedOverrideKeys.insert(key) }
        }

        private func clearOverride(_ oid: ObjectIdentifier, _ name: String) {
            guard var bucket = overrides[oid], bucket[name] != nil else { return }
            bucket[name] = nil
            overrides[oid] = bucket.isEmpty ? nil : bucket
            if let key = keysByNode[oid] { changedOverrideKeys.insert(key) }
        }

        private func registerAnimation(_ node: SceneNode, parentKey: String) {
            let oid = ObjectIdentifier(node)
            guard animations[oid] == nil else { return }
            guard !parentKey.isEmpty, let target = irNodesByKey[parentKey] else {
                diag(SceneDiagnostic(code: "malformed-animation",
                                     message: "<animate> must be the child of the node it animates — inert"))
                return
            }
            animations[oid] = AnimRec(node: node, target: target)
            animationOrder.append(oid)
        }

        /// the `when` gate: absent = open; a resolved falsy word ("", false, 0, null,
        /// undefined) = closed (the web FALSY_WHEN twin — `when` is JSE-bindable)
        private func gateOpen(_ animNode: SceneNode) -> Bool {
            guard let raw = animNode.attrs["when"] else { return true }
            return !Self.falsyWhen.contains(resolveBase(animNode, "when", raw).trimmingCharacters(in: .whitespaces))
        }

        /// the property's BASE on the animation value plane (what a finished tween
        /// returns to, what an unauthored `from` captures at clip start)
        private func baseValueFor(_ node: SceneNode, target: String) -> [Double] {
            let props = SceneIRKit.resolvedProps(node, kernelResolve(base: true), diag)
            switch target {
            case "position": return props.position
            case "rotation": return props.rotation
            case "scale": return props.scale
            case "intensity": return [props.intensity]
            case "fov": return [props.fov]
            default: return SceneAnim.parseAnimValue("color", props.color) ?? [1, 1, 1]
            }
        }

        /// an ACTIVE explicit tween owns its property — implicit transitions yield to it
        private func tweenOwns(_ targetOid: ObjectIdentifier, target: String) -> Bool {
            for rec in animations.values {
                if ObjectIdentifier(rec.target) == targetOid, rec.playing, !rec.finished,
                   rec.spec?.target == target { return true }
            }
            return false
        }

        private func transitionEntries(_ node: SceneNode) -> [SceneTransitionEntry] {
            guard let raw = node.attrs["transition"] else { return [] }
            let oid = ObjectIdentifier(node)
            let source = resolveBase(node, "transition", raw)
            if let cached = transitionParse[oid], cached.source == source { return cached.entries }
            let entries = SceneAnim.parseTransitions(source) { [weak self] in self?.diag($0) }
            transitionParse[oid] = (source: source, entries: entries)
            return entries
        }

        /// compare each authored animatable attr's BASE value with the last pass; a
        /// change on a `transition=` property starts a retarget (never on first sight —
        /// the cache seeds silently before `ready`)
        private func detectRetargets(_ node: SceneNode) {
            let oid = ObjectIdentifier(node)
            var bucket = baseCache[oid] ?? [:]
            for (name, raw) in node.attrs where SceneAnim.animTargets.contains(name) {
                let value = resolveBase(node, name, raw)
                let previous = bucket[name]
                bucket[name] = value
                guard ready, let previous, previous != value else { continue }
                maybeRetarget(node, name: name, previousValue: previous, nextValue: value)
            }
            baseCache[oid] = bucket
        }

        private func maybeRetarget(_ node: SceneNode, name: String, previousValue: String, nextValue: String) {
            let oid = ObjectIdentifier(node)
            guard let entry = transitionEntries(node).first(where: { $0.property == name }),
                  !tweenOwns(oid, target: name) else { return }
            // start from where you are: the mid-flight override when one exists, else
            // the old base — the CSS interrupt model (never snap, never queue)
            guard let to = SceneAnim.parseAnimValue(name, nextValue),
                  let from = SceneAnim.parseAnimValue(name, overrides[oid]?[name] ?? previousValue) else { return }
            var bucket = transitions[oid] ?? [:]
            bucket[name] = TransitionRec(entry: entry,
                                         state: SceneTransitionState(from: from, to: to, startMs: nowMs()))
            transitions[oid] = bucket
            setOverride(oid, name, SceneAnim.formatAnimValue(name, from))
        }

        /// advance every implicit transition; true = more work next frame
        private func advanceTransitions(_ t: Double) -> Bool {
            var active = false
            for (oid, bucket) in transitions {
                var next = bucket
                for (target, rec) in bucket {
                    if tweenOwns(oid, target: target) { continue }   // explicit beats implicit
                    let result = SceneAnim.transitionValue(rec.entry, rec.state, t)
                    if result.done {
                        // the glide reached base — the override retires, the property shows base
                        clearOverride(oid, target)
                        next[target] = nil
                    } else {
                        setOverride(oid, target, SceneAnim.formatAnimValue(target, result.value))
                        active = true
                    }
                }
                transitions[oid] = next.isEmpty ? nil : next
            }
            return active
        }

        /// advance every `<animate>`; true = more work next frame
        private func advanceAnimations(_ t: Double) -> Bool {
            var active = false
            for oid in animationOrder {
                guard var rec = animations[oid] else { continue }
                let targetOid = ObjectIdentifier(rec.target)
                if !gateOpen(rec.node) {
                    // the when law: falsy stops at base (no on:done); the next truthy
                    // edge restarts the clock
                    if rec.playing, let spec = rec.spec { clearOverride(targetOid, spec.target) }
                    rec.playing = false
                    rec.finished = false
                    animations[oid] = rec
                    continue
                }
                if !rec.playing {
                    rec.spec = SceneAnim.parseTween(rec.node, kernelResolve(base: true)) { [weak self] in self?.diag($0) }
                    rec.playing = true
                    rec.doneFired = false
                    if let spec = rec.spec {
                        rec.finished = false
                        rec.startMs = t
                        // from defaults to the BASE at start; an explicit tween cancels
                        // the implicit transition on its property (explicit wins)
                        rec.from = spec.from ?? baseValueFor(rec.target, target: spec.target)
                        if var bucket = transitions[targetOid] {
                            bucket[spec.target] = nil
                            transitions[targetOid] = bucket.isEmpty ? nil : bucket
                        }
                    } else {
                        rec.finished = true   // inert (diagnosed)
                    }
                }
                guard !rec.finished, let spec = rec.spec else {
                    animations[oid] = rec
                    continue
                }
                let sample = SceneAnim.tweenValue(spec, from: rec.from ?? [],
                                                  base: baseValueFor(rec.target, target: spec.target),
                                                  tMs: t - rec.startMs)
                if sample.overriding { setOverride(targetOid, spec.target, SceneAnim.formatAnimValue(spec.target, sample.value)) }
                else { clearOverride(targetOid, spec.target) }
                if sample.done {
                    rec.finished = true   // fill=hold keeps its final override; fill=none cleared above
                    if !rec.doneFired {
                        rec.doneFired = true
                        fireDone(rec)
                    }
                } else {
                    active = true
                }
                animations[oid] = rec
            }
            return active
        }

        /// on:done — fires ONCE per completion (never per loop iteration), through the
        /// same gated handler path as on:tap
        private func fireDone(_ rec: AnimRec) {
            guard let surface, let action = rec.node.attrs["on:done"] else { return }
            let key = keysByNode[ObjectIdentifier(rec.node)] ?? ""
            surface.env.runGated(action, item: itemPlane(rec.node) ?? surface.item,
                                 args: ["id": rec.target.id ?? ""],
                                 debounceMs: JSERunner.gateMs(rec.node.attrs, event: "done", kind: "debounce"),
                                 throttleMs: JSERunner.gateMs(rec.node.attrs, event: "done", kind: "throttle"),
                                 gateKey: "scene." + key + ".done")
        }

        private func animationsWantTick() -> Bool {
            for oid in animationOrder {
                guard let rec = animations[oid] else { continue }
                let open = gateOpen(rec.node)
                if open && !(rec.playing && rec.finished) { return true }   // will start, or mid-flight
                if !open && rec.playing { return true }                     // needs its stop tick
            }
            return false
        }

        // ── G4 unified input (dsx-game.md §2) ────────────────────────────────────
        /// `on:input.<name>` on this `<scene>` subscribes to the declared binding's press
        /// EDGE and dispatches through the ordinary gated runner path. The DECLARATIONS
        /// registered from the head (StackHead.hoist); this is the CONSUMER half. A
        /// keyboard-bound scene also hosts the UIKit responder that turns hardware key
        /// presses into canonical key words.
        private func syncInputHandlers(_ surface: SceneSurface) {
            var wanted: [String: String] = [:]
            for (key, value) in surface.attrs where key.hasPrefix("on:input.") && !value.isEmpty {
                let name = String(key.dropFirst("on:input.".count))
                if name.hasSuffix(".throttle") || name.hasSuffix(".debounce") { continue }
                wanted[name] = value
            }
            guard wanted != inputHandlers else { return }
            for name in inputHandlers.keys { DsxInputRuntime.shared.unsubscribe(name, token: self) }
            inputHandlers = wanted
            for (name, action) in wanted {
                DsxInputRuntime.shared.subscribe(name, token: self) { [weak self] event in
                    guard let self, let live = self.surface else { return }
                    live.env.runGated(action, item: live.item,
                                      args: ["name": event.name, "x": event.x, "y": event.y],
                                      debounceMs: JSERunner.gateMs(live.attrs, event: "input.\(name)", kind: "debounce"),
                                      throttleMs: JSERunner.gateMs(live.attrs, event: "input.\(name)", kind: "throttle"),
                                      gateKey: "scene.input.\(name)")
                }
            }
            if !wanted.isEmpty { installKeyResponder() }
        }

        /// Host the first-responder view once, inside this element's container, so
        /// hardware keys reach the runtime while the scene is on screen.
        private func installKeyResponder() {
            guard keyResponder == nil, let container else { return }
            let view = StackInputResponderView(frame: .zero)
            container.addSubview(view)
            keyResponder = view
        }

        /// the ONE-loop condition: on:frame authored, a transition in flight, an
        /// animation that wants a tick, or a physics world with an awake dynamic body
        /// or a character (the G2 extension) — a static scene never spins (the P1
        /// law), and a fully-asleep world stops the loop (and on:tick with it)
        private func loopActive() -> Bool {
            (surface?.attrs["on:frame"] != nil) || !transitions.isEmpty || animationsWantTick()
                || physicsWants() || clipsWantTick() || spritesWantTick()
        }

        /// the G3 loop-existence extension: an active clip or crossfade on any
        /// `<model animation>` keeps the loop; a finished non-looping clip with no
        /// crossfade lets it stop. A ready-but-not-yet-mixed model counts as active
        /// (the first tick creates its mixer); a loading model does not — its arrival
        /// re-applies the surface and re-evaluates this.
        private func clipsWantTick() -> Bool {
            let t = nowMs()
            for (_, node) in irNodesByKey where node.kind == "model" && node.attrs["animation"] != nil {
                let oid = ObjectIdentifier(node)
                if let mixer = clipMixers[oid] {
                    if mixer.active(nowMs: t) { return true }
                } else {
                    let src = resolveBase(node, "src", node.attrs["src"] ?? "")
                    if !src.isEmpty, case .some(.ready) = models[src] { return true }
                }
            }
            return false
        }

        /// the per-node update path: only the nodes whose override changed this tick
        /// re-resolve and touch their SCNNode; camera/lights route to their appliers
        private func applyChangedNodes() {
            guard !changedOverrideKeys.isEmpty else { return }
            let resolve = kernelResolve(base: false)
            var lightsTouched = false
            var cameraTouched = false
            for key in changedOverrideKeys {
                guard let node = irNodesByKey[key] else { continue }
                if node.kind == "light" { lightsTouched = true; continue }
                if node.kind == "camera" { cameraTouched = true; continue }
                guard let scn = scnNodes[key] else { continue }
                let props = SceneIRKit.resolvedProps(node, resolve, diag)
                let local = SceneMath.trs(position: props.position, rotationDeg: props.rotation, scale: props.scale)
                localsByKey[key] = local
                scn.simdTransform = Self.simdMatrix(local)
                applyGeometry(node, props, to: scn, key: key)
            }
            changedOverrideKeys.removeAll()
            if lightsTouched { applyLighting(resolve) }
            if cameraTouched { applyCamera(resolve) }
        }

        // ── G2 physics: the fixed-tick solver wiring (dsx-game.md §2) ────────────────

        /// a bind group's LIVE rows substitute for its template children (the TS tree
        /// mutates in place; Swift's IR is immutable, so the extraction walk asks)
        private func physicsChildren(_ node: SceneNode) -> [SceneNode] {
            if node.kind == "group", node.attrs["bind"] != nil,
               let key = keysByNode[ObjectIdentifier(node)], let record = boundGroups[key] {
                return record.order.flatMap { record.rows[$0]?.nodes ?? [] }
            }
            return node.children
        }

        /// a loaded model's collider bounds ([0.5 0.5 0.5] until known — arrival
        /// re-applies, the signature changes and the collider re-freezes)
        private func physicsModelHalf(_ node: SceneNode) -> [Double]? {
            let src = SceneIRKit.resolvedProps(node, kernelResolve(base: true)).src
            guard !src.isEmpty, case .some(.ready(let model)) = models[src] else { return nil }
            return ScenePhysics.modelHalfExtents(model)
        }

        /// the body-shaping fingerprint of the live tree (node identity + shaping
        /// attrs + gravity + model bounds) — a change re-extracts (colliders
        /// re-freeze) with live state carried across by node identity
        private func physicsSignatureNow() -> String {
            var out = resolveBase(nil, "gravity", ir.attrs["gravity"] ?? "")
            func walk(_ nodes: [SceneNode]) {
                for node in nodes {
                    if node.kind == "animate" { continue }
                    if node.attrs["physics"] != nil {
                        out += "\u{1E}\(ObjectIdentifier(node).hashValue)"
                        for name in Self.physicsShapingAttrs {
                            out += "\u{1F}" + resolveBase(node, name, node.attrs[name] ?? "")
                        }
                        if node.kind == "model" {
                            out += "\u{1F}" + (physicsModelHalf(node)?.map { JSE.string($0) }
                                .joined(separator: " ") ?? "?")
                        }
                    }
                    walk(physicsChildren(node))
                }
            }
            walk(ir.nodes)
            return out
        }

        private func seedPhysicsWriteCache() {
            physicsWriteCache = [:]
            guard let world = physicsWorld else { return }
            for body in world.bodies {
                guard let node = physicsNodesById[body.id] else { continue }
                physicsWriteCache[ObjectIdentifier(node)] = [
                    "position": resolveBase(node, "position", node.attrs["position"] ?? ""),
                    "velocity": resolveBase(node, "velocity", node.attrs["velocity"] ?? ""),
                    "rotation": resolveBase(node, "rotation", node.attrs["rotation"] ?? ""),
                    "angular-velocity": resolveBase(
                        node, "angular-velocity", node.attrs["angular-velocity"] ?? ""),
                    "torque": resolveBase(node, "torque", node.attrs["torque"] ?? ""),
                ]
            }
        }

        private func ensurePhysicsWorld() {
            guard physicsAuthored, surface != nil else { return }
            let next = physicsSignatureNow()
            if next == physicsSignature { return }
            physicsSignature = next
            var carried: [ObjectIdentifier: ScenePhysicsBody] = [:]
            if let old = physicsWorld {
                for body in old.bodies {
                    if let node = physicsNodesById[body.id] { carried[ObjectIdentifier(node)] = body }
                }
            }
            physicsNodesById = [:]
            physicsIdsByNode = [:]
            let extraction = ScenePhysics.extract(
                ir, kernelResolve(base: true), { [weak self] in self?.diag($0) },
                modelHalf: { [weak self] node in self?.physicsModelHalf(node) },
                childrenOf: { [weak self] node in self?.physicsChildren(node) ?? node.children })
            guard !extraction.bodies.isEmpty else {
                physicsWorld = nil
                physicsWriteCache = [:]
                return
            }
            // G6: a mode="2d" scene builds a Z-LOCKED world — the SAME solver, one flag
            let world = ScenePhysics.createWorld(gravity: extraction.gravity, specs: extraction.bodies,
                                                 mode2d: extraction.mode2d)
            physicsIndexParents()
            physicsAnyNested = extraction.bodies.contains {
                guard let node = $0.node else { return false }
                return physicsParentOf[ObjectIdentifier(node)] != nil
            }
            for (i, body) in world.bodies.enumerated() {
                guard let node = extraction.bodies[i].node else { continue }
                physicsNodesById[body.id] = node
                physicsIdsByNode[ObjectIdentifier(node)] = body.id
                if let prior = carried[ObjectIdentifier(node)], prior.kind == body.kind {
                    // a rebuild (bind reconcile, attr change) carries live state by
                    // node identity
                    body.position = prior.position
                    body.previous = prior.previous
                    body.velocity = prior.velocity
                    body.rotation = prior.rotation
                    body.orientation = prior.orientation
                    body.previousRotation = prior.previousRotation
                    body.angularVelocity = prior.angularVelocity
                    body.torque = prior.torque
                    body.grounded = prior.grounded
                    body.sleeping = prior.sleeping
                    body.sleepCount = prior.sleepCount
                }
            }
            physicsWorld = world
            seedPhysicsWriteCache()
        }

        /// THE WRITE LAWS, scanned where base writes land (every store publish and bus
        /// `set` funnels through apply): a changed base `position` on a dynamic/
        /// character body TELEPORTS it — velocity reset, and never a `transition=`
        /// glide: the in-flight transition retires, the override shows the pose NOW,
        /// and the retarget detector's base cache re-seeds so the walk never starts
        /// one. Rotation follows the same teleport law. Velocity, angular velocity and
        /// torque are command writes; a kinematic transform write wakes every sleeping
        /// body (v1 — no island graph, the named absence).
        private func physicsScanWrites() {
            guard physicsAuthored else { return }
            ensurePhysicsWorld()
            guard let world = physicsWorld else { return }
            for body in world.bodies {
                guard let node = physicsNodesById[body.id] else { continue }
                let oid = ObjectIdentifier(node)
                var cache = physicsWriteCache[oid] ?? [:]
                physicsParentWorlds = nil   // this scan resolves parents fresh too
                let pos = resolveBase(node, "position", node.attrs["position"] ?? "")
                let previousPos = cache.updateValue(pos, forKey: "position")
                let vel = resolveBase(node, "velocity", node.attrs["velocity"] ?? "")
                let previousVel = cache.updateValue(vel, forKey: "velocity")
                let rotation = resolveBase(node, "rotation", node.attrs["rotation"] ?? "")
                let previousRotation = cache.updateValue(rotation, forKey: "rotation")
                let angularVelocity = resolveBase(
                    node, "angular-velocity", node.attrs["angular-velocity"] ?? "")
                let previousAngularVelocity = cache.updateValue(
                    angularVelocity, forKey: "angular-velocity")
                let torque = resolveBase(node, "torque", node.attrs["torque"] ?? "")
                let previousTorque = cache.updateValue(torque, forKey: "torque")
                physicsWriteCache[oid] = cache
                let forcedPos = physicsForcedWrites.remove("\(oid):position") != nil
                let forcedVel = physicsForcedWrites.remove("\(oid):velocity") != nil
                let forcedRotation = physicsForcedWrites.remove("\(oid):rotation") != nil
                let forcedAngularVelocity = physicsForcedWrites.remove("\(oid):angular-velocity") != nil
                let forcedTorque = physicsForcedWrites.remove("\(oid):torque") != nil
                if body.kind == "static" { continue }
                if body.kind == "kinematic" {
                    if (previousPos != nil && (forcedPos || previousPos != pos)) ||
                        (previousRotation != nil && (forcedRotation || previousRotation != rotation)) {
                        ScenePhysics.wakeAll(world)
                    }
                    continue
                }
                if let previousPos, forcedPos || previousPos != pos,
                   let p = SceneAnim.parseAnimValue("position", pos), p.count >= 3 {
                    // the authored/bus value is LOCAL to the parent; the solver speaks root
                    let parent = physicsAnyNested ? physicsParentWorld(node) : nil
                    ScenePhysics.teleport(world, id: body.id, ScenePhysics.toRoot(p, parentWorld: parent))
                    if var bucket = transitions[oid] {
                        bucket["position"] = nil
                        transitions[oid] = bucket.isEmpty ? nil : bucket
                    }
                    baseCache[oid, default: [:]]["position"] = pos
                    setOverride(oid, "position", SceneAnim.formatAnimValue("position", p))
                }
                if let previousVel, forcedVel || previousVel != vel,
                   let v = SceneAnim.parseAnimValue("position", vel), v.count >= 3 {
                    ScenePhysics.writeVelocity(world, id: body.id, v)
                }
                if let previousRotation, forcedRotation || previousRotation != rotation,
                   let r = SceneAnim.parseAnimValue("rotation", rotation), r.count >= 3 {
                    let parent = physicsAnyNested ? physicsParentWorld(node) : nil
                    ScenePhysics.teleportRotation(
                        world, id: body.id,
                        ScenePhysics.rotationToRoot(r, parentWorld: parent, reference: body.rotation))
                    if var bucket = transitions[oid] {
                        bucket["rotation"] = nil
                        transitions[oid] = bucket.isEmpty ? nil : bucket
                    }
                    baseCache[oid, default: [:]]["rotation"] = rotation
                    setOverride(oid, "rotation", SceneAnim.formatAnimValue("rotation", r))
                }
                if let previousAngularVelocity,
                   forcedAngularVelocity || previousAngularVelocity != angularVelocity,
                   let v = SceneAnim.parseAnimValue("position", angularVelocity), v.count >= 3 {
                    ScenePhysics.writeAngularVelocity(world, id: body.id, v)
                }
                if let previousTorque, forcedTorque || previousTorque != torque,
                   let value = SceneAnim.parseAnimValue("position", torque), value.count >= 3 {
                    ScenePhysics.writeTorque(world, id: body.id, value)
                }
            }
        }

        /// THE LOOP-EXISTENCE LAW, EXTENDED (G2): the loop also runs while any dynamic
        /// body is AWAKE or any character exists — a fully-asleep world stops it
        private func physicsWants() -> Bool {
            guard physicsAuthored else { return false }
            ensurePhysicsWorld()
            guard let world = physicsWorld else { return false }
            for body in world.bodies {
                if body.kind == "character" { return true }
                if body.kind == "dynamic" && !body.sleeping { return true }
            }
            return false
        }

        private func physicsMoveIntent(_ node: SceneNode, _ resolve: SceneResolve) -> [Double]? {
            let resolved = resolve(node, "move", node.attrs["move"] ?? "")
                .trimmingCharacters(in: .whitespaces)
            if resolved.isEmpty { return nil }
            let parts = resolved.split(whereSeparator: { $0.isWhitespace })
            guard parts.count == 2, let x = Double(parts[0]), x.isFinite,
                  let z = Double(parts[1]), z.isFinite else {
                diag(SceneDiagnostic(code: "malformed-vector",
                                     message: "move=\"\(resolved)\" is not 2 numbers — no intent"))
                return nil
            }
            return [x, z]
        }

        /// the loop's fixed-tick driver: accumulate the frame's dt (SECONDS), step
        /// 0..5 times (the kernel cap), dispatch on:collision/on:enter/on:exit/on:tick
        /// through the SAME runGated path as on:tap, then write the INTERPOLATED
        /// solver-owned positions onto the override plane (applyChangedNodes re-applies
        /// them this same frame tick)
        private func advancePhysics(_ frameSeconds: Double) {
            guard physicsAuthored, let surface else { return }
            ensurePhysicsWorld()
            guard let world = physicsWorld else { return }
            let advanced = physicsAccumulator.advance(frameSeconds: frameSeconds)
            let resolve = kernelResolve(base: false)
            for _ in 0..<advanced.steps {
                var intents: [String: ScenePhysicsIntent] = [:]
                for body in world.bodies {
                    guard let node = physicsNodesById[body.id] else { continue }
                    if body.kind == "kinematic" {
                        // kinematics follow the RESOLVED plane — store writes, bus set
                        // and animations all move them; the solver derives their push
                        // velocity
                        let props = SceneIRKit.resolvedProps(node, resolve) { [weak self] in self?.diag($0) }
                        let parent = physicsAnyNested ? physicsParentWorld(node) : nil
                        intents[body.id] = ScenePhysicsIntent(
                            position: ScenePhysics.toRoot(props.position, parentWorld: parent),
                            rotation: ScenePhysics.rotationToRoot(
                                props.rotation, parentWorld: parent, reference: body.rotation))
                    } else if body.kind == "character" {
                        if let move = physicsMoveIntent(node, resolve) {
                            intents[body.id] = ScenePhysicsIntent(move: move)
                        }
                    }
                }
                let result = ScenePhysics.step(world, intents: intents)
                for e in result.collisions { firePhysicsPair("collision", e) }
                for e in result.enters { firePhysicsPair("enter", e) }
                for e in result.exits { firePhysicsPair("exit", e) }
                if let action = surface.attrs["on:tick"] {
                    surface.env.runGated(action, item: surface.item,
                                         args: ["dt": result.dt, "tick": result.tick],
                                         debounceMs: JSERunner.gateMs(surface.attrs, event: "tick", kind: "debounce"),
                                         throttleMs: JSERunner.gateMs(surface.attrs, event: "tick", kind: "throttle"),
                                         gateKey: "scene.tick")
                }
            }
            // interpolated solver-owned overrides — rendered = prev + (curr − prev)·alpha
            physicsParentWorlds = nil   // parents may have animated since the last pass
            for body in world.bodies where body.kind == "dynamic" || body.kind == "character" {
                guard let node = physicsNodesById[body.id] else { continue }
                let rendered = ScenePhysics.interpolate(
                    prev: body.previous, curr: body.position, alpha: advanced.alpha)
                let local = physicsAnyNested
                    ? ScenePhysics.toLocal(rendered, parentWorld: physicsParentWorld(node)) : rendered
                setOverride(ObjectIdentifier(node), "position",
                            SceneAnim.formatAnimValue("position", local))
                if body.kind == "dynamic" {
                    let renderedRotation = ScenePhysics.interpolate(
                        prev: body.previousRotation, curr: body.rotation, alpha: advanced.alpha)
                    let priorLocal = SceneIRKit.resolvedProps(node, resolve) {
                        [weak self] in self?.diag($0)
                    }.rotation
                    let localRotation = ScenePhysics.rotationToLocal(
                        renderedRotation,
                        parentWorld: physicsAnyNested ? physicsParentWorld(node) : nil,
                        reference: priorLocal)
                    setOverride(ObjectIdentifier(node), "rotation",
                                SceneAnim.formatAnimValue("rotation", localRotation))
                }
            }
        }

        /// on:collision/on:enter/on:exit — on the BODY's node, both directions per
        /// pair, in the row scope, through the same gated path as on:tap
        private func firePhysicsPair(_ event: String, _ e: ScenePhysicsPairEvent) {
            guard let surface, let node = physicsNodesById[e.id],
                  let action = node.attrs["on:" + event] else { return }
            let key = keysByNode[ObjectIdentifier(node)] ?? ""
            let payload: [String: Any] = [
                "id": node.id ?? "",
                "other": physicsNodesById[e.other]?.id ?? "",
            ]
            surface.env.runGated(action, item: itemPlane(node) ?? surface.item,
                                 args: payload,
                                 debounceMs: JSERunner.gateMs(node.attrs, event: event, kind: "debounce"),
                                 throttleMs: JSERunner.gateMs(node.attrs, event: event, kind: "throttle"),
                                 gateKey: "scene." + key + "." + event)
        }

        /// the bus read: a body node's solver state rides the nodes() answer
        fileprivate func physicsBusInfo(_ node: SceneNode)
            -> (grounded: Bool, sleeping: Bool, velocity: [Double], rotation: [Double],
                angularVelocity: [Double], torque: [Double])? {
            guard let id = physicsIdsByNode[ObjectIdentifier(node)],
                  let body = physicsWorld?.byId[id] else { return nil }
            return (grounded: body.grounded, sleeping: body.sleeping, velocity: body.velocity,
                    rotation: body.rotation, angularVelocity: body.angularVelocity,
                    torque: body.torque)
        }

        // ── P5 bound groups: `<group bind key>` — keyed rows of the template subtree ─

        /// the row scope dict `item.*` resolves against — the web rowItem twin: a dict
        /// row merges over the enclosing scope; a scalar row rides `value`; `index` is
        /// the row's position (nested binds inherit the outer row's scope)
        private func rowItem(parent: [String: Any]?, raw: Any, index: Int) -> [String: Any] {
            var out = parent ?? [:]
            if let dict = raw as? [String: Any] {
                for (k, v) in dict { out[k] = v }
            } else {
                out["value"] = raw
            }
            out["index"] = Double(index)
            return out
        }

        private func registerRowScopes(_ nodes: [SceneNode], _ item: [String: Any]) {
            rootScopeCache.removeAll()   // row sites feed resolved scopes — restamp invalidates
            rowSerialCounter += 1
            stampRowScopes(nodes, item, rowSerialCounter)
        }

        private func stampRowScopes(_ nodes: [SceneNode], _ item: [String: Any], _ serial: Int) {
            for node in nodes {
                let oid = ObjectIdentifier(node)
                rowScopes[oid] = item
                rowSerials[oid] = serial   // the G1 row-vs-prefab innermost tiebreak
                stampRowScopes(node.children, item, serial)
            }
        }

        /// drop every per-identity record of an unmounting subtree — removing a row
        /// STOPS ITS ANIMATIONS (the bind law) and retires its overrides/scopes
        private func dropNodeState(_ nodes: [SceneNode]) {
            for node in nodes {
                let oid = ObjectIdentifier(node)
                overrides[oid] = nil
                baseCache[oid] = nil
                rowScopes[oid] = nil
                rowSerials[oid] = nil
                prefabChains[oid] = nil   // a despawned prefab instance drops its chain (G1)
                // bus writes + physics write snapshots die with the node — an
                // ObjectIdentifier is a raw address, and a stale entry would silently
                // re-apply to whatever future node the allocator hands the same slot
                busBase[oid] = nil
                physicsWriteCache[oid] = nil
                transitions[oid] = nil
                transitionParse[oid] = nil
                colliderIds[oid] = nil
                keysByNode[oid] = nil
                clipMixers[oid] = nil     // …and its clips (G3)
                clipMixerSrc[oid] = nil
                if animations[oid] != nil {
                    animations[oid] = nil
                    animationOrder.removeAll { $0 == oid }
                }
                dropNodeState(node.children)
            }
        }

        private func unmountRow(_ row: BoundRowRec, groupKey: String, rowKey: String) {
            dropNodeState(row.nodes)
            let prefix = groupKey + "#" + rowKey + "/"
            for (key, scn) in scnNodes where key.hasPrefix(prefix) {
                scn.removeFromParentNode()
                scnNodes[key] = nil
                irNodesByKey[key] = nil
                localsByKey[key] = nil
                parentKeyByKey[key] = nil
                modelMounts[key] = nil
                anchorMounts[key] = nil
            }
            mountedOrder.removeAll { $0.hasPrefix(prefix) }
        }

        /// keyed reconcile (kernel SceneBind: the <list> keying law — `·n` duplicate
        /// suffix, 256 cap): a kept key keeps its instantiated SceneNode subtree AND its
        /// SCNNodes across reorder; a new key instantiates fresh identities; a vanished
        /// key unmounts. Row nodes mount under `groupKey#rowKey/i` keys and re-resolve
        /// `item.*` through their registered row scope.
        private func reconcileBoundGroup(_ node: SceneNode, groupKey: String, scn: SCNNode,
                                         resolve: SceneResolve) {
            var record = boundGroups[groupKey] ?? BoundGroupRec(template: node.children,
                                                                keyField: node.attrs["key"] ?? "id")
            guard let surface else { boundGroups[groupKey] = record; return }
            // the bound expression evaluates through the ordinary JSE plane in the
            // group's own scope (arrays stay arrays — never a stringified hole); a
            // group inside a prefab body evaluates in the LIVE instance scope (G1)
            let scopeItem = itemPlane(node) ?? surface.item
            let value = JSE.eval(node.attrs["bind"] ?? "", store: surface.store, item: scopeItem)
            let rows = SceneBind.rows(value, keyField: record.keyField, diag)
            let diffResult = SceneBind.diff(previous: record.order, next: rows)
            for key in diffResult.removed {
                guard let gone = record.rows[key] else { continue }
                unmountRow(gone, groupKey: groupKey, rowKey: key)
                record.rows[key] = nil
            }
            for row in rows {
                let rec: BoundRowRec
                if let existing = record.rows[row.key] {
                    rec = existing
                } else {
                    rec = BoundRowRec(nodes: SceneBind.instantiateRow(record.template))
                    // spawned prefab instances inherit the group's prefab chain (G1)
                    stampPrefabChains(rec.nodes, prefabChains[ObjectIdentifier(node)] ?? [])
                }
                record.rows[row.key] = rec
                // keyed identity survives: same subtree, refreshed row scope (the list law)
                registerRowScopes(rec.nodes, rowItem(parent: scopeItem, raw: row.item, index: row.index))
                for (i, child) in rec.nodes.enumerated() {
                    mount(child, parent: scn, key: groupKey + "#" + row.key + "/" + String(i),
                          parentKey: groupKey, resolve: resolve)
                }
            }
            record.order = rows.map(\.key)
            boundGroups[groupKey] = record
        }

        // ── P5 collisions: the render-riding pass (kernel SceneCollide + the tracker) ─

        /// worlds multiply from the local-matrix mirrors (world = parentWorld · local —
        /// the corpus law, so the pass never reads SceneKit's presentation tree), pairs
        /// test in first-mount document order, and each ENTER event fires on:collide
        /// through runGated with {id, other, depth} (authored ids, "" when none)
        private func collisionPass() {
            guard anyCollideAuthored, let surface else { return }
            let resolve = kernelResolve(base: false)
            var worldMemo: [String: [Double]] = [:]
            func world(_ key: String) -> [Double] {
                if let cached = worldMemo[key] { return cached }
                let local = localsByKey[key] ?? SceneMath.identity()
                let parent = parentKeyByKey[key] ?? ""
                let result = parent.isEmpty ? local : SceneMath.multiply(world(parent), local)
                worldMemo[key] = result
                return result
            }
            var shapes: [SceneColliderShape] = []
            var byTrackerId: [String: (node: SceneNode, key: String)] = [:]
            for key in mountedOrder {
                guard let node = irNodesByKey[key],
                      node.kind == "box" || node.kind == "sphere" || node.kind == "plane",
                      node.attrs["collide"] != nil else { continue }
                let props = SceneIRKit.resolvedProps(node, resolve, diag)
                if props.collide.isEmpty { continue }
                let oid = ObjectIdentifier(node)
                let trackerId: String
                if let existing = colliderIds[oid] { trackerId = existing }
                else {
                    colliderSerial += 1
                    trackerId = "n\(colliderSerial)"
                    colliderIds[oid] = trackerId
                }
                if let shape = SceneCollide.colliderFor(node, props, world: world(key), id: trackerId) {
                    shapes.append(shape)
                    byTrackerId[trackerId] = (node: node, key: key)
                }
            }
            for event in collisionTracker.step(shapes) {
                guard let target = byTrackerId[event.id] else { continue }
                let payload: [String: Any] = [
                    "id": target.node.id ?? "",
                    "other": byTrackerId[event.other]?.node.id ?? "",
                    "depth": event.depth,
                ]
                // the bus event door (G5) — re-fired by the Core/Scene module as
                // scene.collide
                if let busKey {
                    var busPayload = payload
                    busPayload["scene"] = busKey
                    SceneRegistry.emit(scene: busKey, kind: "collide", payload: busPayload)
                }
                guard let action = target.node.attrs["on:collide"] else { continue }
                surface.env.runGated(action, item: itemPlane(target.node) ?? surface.item,
                                     args: payload,
                                     debounceMs: JSERunner.gateMs(target.node.attrs, event: "collide", kind: "debounce"),
                                     throttleMs: JSERunner.gateMs(target.node.attrs, event: "collide", kind: "throttle"),
                                     gateKey: "scene." + target.key + ".collide")
            }
        }

        // ── P5 orbit controls: pan/pinch fold through the kernel math into a camera-
        // position override (the same plane animations write — applyCamera then reads it)

        /// the first authored top-level <camera> and its tree key (the sceneCamera law)
        private func cameraEntry() -> (node: SceneNode, key: String)? {
            for (i, node) in ir.nodes.enumerated() where node.kind == "camera" {
                return (node: node, key: String(i))
            }
            return nil
        }

        private func orbitEnabled() -> Bool {
            guard !arLive, let camera = cameraEntry() else { return false }
            return SceneIRKit.resolvedProps(camera.node, kernelResolve(base: true), diag).controls == "orbit"
        }

        private func orbitWrite(_ position: [Double]) {
            guard let camera = cameraEntry() else { return }
            setOverride(ObjectIdentifier(camera.node), "position",
                        SceneAnim.formatAnimValue("position", position))
            applyChangedNodes()   // routes the camera key to applyCamera
        }

        /// THE DRAG LAW (SceneOrbit, corpus orbit.json): yaw −= dx·0.4°/px, pitch +=
        /// dy·0.4°/px clamped ±89° — folded from the CURRENT rendered camera each step
        @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
            guard let view = scnView, orbitEnabled(), let camera = cameraEntry() else { return }
            if recognizer.state == .began { dragMoved = false }
            if recognizer.state == .ended || recognizer.state == .cancelled || recognizer.state == .failed {
                // the drag is over — a NEXT genuine tap must not be swallowed (the tap
                // recognizer never fires for the pan itself, so nobody else resets this)
                dragMoved = false
                return
            }
            guard recognizer.state == .changed else { return }
            let translation = recognizer.translation(in: view)
            recognizer.setTranslation(.zero, in: view)
            if translation.x == 0 && translation.y == 0 { return }
            dragMoved = true   // an orbit drag suppresses the tap-pick that follows
            let props = SceneIRKit.resolvedProps(camera.node, kernelResolve(base: false), diag)
            let state = SceneOrbit.drag(SceneOrbit.fromCamera(position: props.position, lookAt: props.lookAt),
                                        dxPx: Double(translation.x), dyPx: Double(translation.y))
            orbitWrite(SceneOrbit.position(state, lookAt: props.lookAt))
        }

        /// THE ZOOM LAW: distance ×= e^(deltaY·0.0015) clamped [max(near, 1e-3), far].
        /// The pinch is the wheel's twin: an incremental pinch factor f maps to
        /// deltaY = ln(1/f)/0.0015, so distance ×= 1/f rides the SAME clamped
        /// exponential — spelled through the native gesture.
        @objc private func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
            guard orbitEnabled(), let camera = cameraEntry() else { return }
            if recognizer.state == .began { lastPinchScale = 1 }
            guard recognizer.state == .changed, recognizer.scale > 0, lastPinchScale > 0 else { return }
            let factor = Double(recognizer.scale / lastPinchScale)
            lastPinchScale = recognizer.scale
            guard factor > 0, factor.isFinite else { return }
            let deltaY = log(1 / factor) / SceneOrbit.zoomRate
            let props = SceneIRKit.resolvedProps(camera.node, kernelResolve(base: false), diag)
            let state = SceneOrbit.zoom(SceneOrbit.fromCamera(position: props.position, lookAt: props.lookAt),
                                        deltaY: deltaY, near: props.near, far: props.far)
            orbitWrite(SceneOrbit.position(state, lookAt: props.lookAt))
        }

        private func applyCamera(_ resolve: SceneResolve) {
            guard !arLive else { return }   // AR: the device camera IS <camera> (§2)
            let props = SceneIRKit.cameraProps(ir, resolve, diag)
            guard let camera = cameraNode.camera else { return }
            cameraNode.simdPosition = SIMD3<Float>(Float(props.position[0]), Float(props.position[1]), Float(props.position[2]))
            if props.position != props.lookAt {
                look(cameraNode, from: props.position, toward: props.lookAt)
            }
            camera.fieldOfView = CGFloat(props.fov)
            camera.zNear = props.near
            camera.zFar = props.far
            camera.usesOrthographicProjection = ir.mode == "2d"
            if ir.mode == "2d" { camera.orthographicScale = props.size2d }
        }

        private func applyLighting(_ resolve: SceneResolve) {
            let lighting = SceneIRKit.sceneLighting(ir, resolve, diag)
            let ambient = SceneIRKit.parseSceneColor(lighting.ambientColor) ?? [1, 1, 1]
            ambientNode.light?.color = color(ambient, intensity: lighting.ambientIntensity)
            if let d = lighting.direction {
                let directional = SceneIRKit.parseSceneColor(lighting.directionalColor) ?? [1, 1, 1]
                directionalNode.light?.color = color(directional, intensity: lighting.directionalIntensity)
                // the light shines FROM `direction` toward the origin: orient the node's
                // -Z (its shine axis) along -direction — the web uLightDir contract
                look(directionalNode, from: [0, 0, 0], toward: [-d[0], -d[1], -d[2]])
            } else {
                directionalNode.light?.color = UIColor.black
            }
            // P5 point lights (the fold already capped them at 4, document order): one
            // SCNLight .omni per entry, color × intensity like ambient/directional.
            // Attenuation: the corpus window law hits EXACTLY 0 at `range`, and so does
            // SceneKit's falloff at attenuationEndDistance — same support; the curve
            // in between is SceneKit's own (pixel-exact cross-renderer parity is NOT
            // claimed — the P2 rasterizer stance; the NUMBERS live in
            // SceneIRKit.scenePointAttenuation, corpus lighting.json).
            while pointLightNodes.count < lighting.points.count {
                let node = SCNNode()
                node.light = SCNLight()
                node.light?.type = .omni
                scene.rootNode.addChildNode(node)
                pointLightNodes.append(node)
            }
            while pointLightNodes.count > lighting.points.count {
                pointLightNodes.removeLast().removeFromParentNode()
            }
            for (i, p) in lighting.points.enumerated() {
                let node = pointLightNodes[i]
                let rgb = SceneIRKit.parseSceneColor(p.color) ?? [1, 1, 1]
                node.light?.color = color(rgb, intensity: p.intensity)
                node.light?.attenuationStartDistance = 0
                node.light?.attenuationEndDistance = CGFloat(max(0, p.range))
                // root-level lights read their authored position as world (the root-light law)
                node.simdPosition = SIMD3<Float>(Float(p.position[0]), Float(p.position[1]), Float(p.position[2]))
            }
            applyFog(resolve)
        }

        /// P5 fog — SceneKit's linear ramp IS the corpus law: with fogDensityExponent
        /// = 1 SceneKit blends factor = clamp((fogEndDistance − d)/(fogEndDistance −
        /// fogStartDistance), 0, 1) toward fogColor, which is exactly
        /// `sceneFogFactor` (f = clamp((far − d)/(far − near), 0, 1)) and
        /// `final = f·lit + (1 − f)·fogColor` — the corpus blend, no adapter math.
        /// No fog authored (or the whole attribute rejected, malformed-fog):
        /// start = end = 0 disables it (SceneKit's off state).
        private func applyFog(_ resolve: SceneResolve) {
            if let fog = SceneIRKit.sceneFog(ir, resolve, diag) {
                scene.fogStartDistance = CGFloat(fog.near)
                scene.fogEndDistance = CGFloat(fog.far)
                scene.fogDensityExponent = 1
                scene.fogColor = color(SceneIRKit.parseSceneColor(fog.color) ?? [0, 0, 0])
            } else {
                scene.fogStartDistance = 0
                scene.fogEndDistance = 0
            }
        }

        /// look(at:) with the math kernel's degenerate-up rule: forward parallel to +Y
        /// swaps the up vector to +Z rather than producing a NaN orientation.
        private func look(_ node: SCNNode, from: [Double], toward: [Double]) {
            let f = SceneMath.normalize(SceneMath.sub(toward, from))
            let up: SCNVector3 = SceneMath.length(SceneMath.cross(f, [0, 1, 0])) < 1e-9
                ? SCNVector3(0, 0, 1) : SCNVector3(0, 1, 0)
            node.look(at: SCNVector3(toward[0], toward[1], toward[2]),
                      up: up, localFront: SCNVector3(0, 0, -1))
        }

        /// A world anchor arrived (provider → main, P3). The FIRST unmatched <anchor>
        /// whose kind matches claims it, document order: its subtree reparents under
        /// the ARAnchor's live node (world-locked from here on — ARKit moves that node,
        /// SceneKit composes the subtree's corpus-law locals under it), unhides, and
        /// on:found fires through the standard gated handler path (the on:tap twin)
        /// with the P3 payload {kind, id, position} — id the <anchor>'s markup id,
        /// position the anchor's world-space meters at match time.
        private func anchorMatched(_ match: SceneARAnchorMatch) {
            guard arLive else { return }
            for key in anchorKeys {
                guard var mount = anchorMounts[key], !mount.matched, mount.kind == match.kind,
                      let scn = scnNodes[key], let irNode = irNodesByKey[key] else { continue }
                mount.matched = true
                anchorMounts[key] = mount
                match.node.addChildNode(scn)
                scn.isHidden = false
                if let action = irNode.attrs["on:found"], let surface {
                    let payload: [String: Any] = ["kind": match.kind, "id": irNode.id ?? "",
                                                  "position": match.position]
                    surface.env.runGated(action, item: itemPlane(irNode) ?? surface.item, args: payload,
                                         debounceMs: JSERunner.gateMs(irNode.attrs, event: "found", kind: "debounce"),
                                         throttleMs: JSERunner.gateMs(irNode.attrs, event: "found", kind: "throttle"),
                                         gateKey: "scene." + key + ".found")
                }
                return
            }
        }

        /// on:tap picking v0 — SCNView.hitTest, nearest handler-bearing GEOMETRY node
        /// (the web adapter's rule: the handler lives on the geometry node itself),
        /// mapped back to the IR by the shared tree key and fired through the SAME
        /// runGated path as any element's on:tap (StackNodeView.tap).
        @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
            if dragMoved { dragMoved = false; return }   // an orbit drag is not a tap
            guard let view = scnView, let surface else { return }
            let point = recognizer.location(in: view)
            let options: [SCNHitTestOption: Any] =
                [.searchMode: NSNumber(value: SCNHitTestSearchMode.all.rawValue)]
            for hit in view.hitTest(point, options: options) {
                guard let key = hit.node.name, let irNode = irNodesByKey[key],
                      let action = irNode.attrs["on:tap"] else { continue }
                let payload: [String: Any] = ["id": irNode.id ?? ""]
                // a bound-row / prefab-body node's handler runs in ITS scope (G1)
                surface.env.runGated(action, item: itemPlane(irNode) ?? surface.item, args: payload,
                                     debounceMs: JSERunner.gateMs(irNode.attrs, event: "tap", kind: "debounce"),
                                     throttleMs: JSERunner.gateMs(irNode.attrs, event: "tap", kind: "throttle"),
                                     gateKey: "scene." + key + ".tap")
                return
            }
        }

        /// column-major [Double]16 → simd_float4x4 (same layout: columns of 4)
        private static func simdMatrix(_ m: [Double]) -> simd_float4x4 {
            simd_float4x4(
                SIMD4<Float>(Float(m[0]), Float(m[1]), Float(m[2]), Float(m[3])),
                SIMD4<Float>(Float(m[4]), Float(m[5]), Float(m[6]), Float(m[7])),
                SIMD4<Float>(Float(m[8]), Float(m[9]), Float(m[10]), Float(m[11])),
                SIMD4<Float>(Float(m[12]), Float(m[13]), Float(m[14]), Float(m[15]))
            )
        }
    }
}

// ── the G5 scene-bus conformance (dsx-game.md §2): the SceneRegistry seam's handle.
// Every answer folds through the corpus-pinned kernel (resolvedProps · worldMatrices ·
// sceneCamera · pickRay/raySphere · SceneCollide.contacts) with the live resolver —
// overrides applied, the same plane the renderer draws from. Main-thread confined
// (the Core/Scene module hops to main before driving a handle).
extension SceneSurface.Coordinator: SceneBusSurface {

    var sceneBusId: String? { ir.attrs["id"] }

    /// world = parentWorld · local from the live local-matrix mirrors (the
    /// collisionPass law — never SceneKit's presentation tree)
    private func busWorld(_ key: String, _ memo: inout [String: [Double]]) -> [Double] {
        if let cached = memo[key] { return cached }
        let local = localsByKey[key] ?? SceneMath.identity()
        let parent = parentKeyByKey[key] ?? ""
        let result = parent.isEmpty ? local : SceneMath.multiply(busWorld(parent, &memo), local)
        memo[key] = result
        return result
    }

    func busNodes() -> [SceneBusNode] {
        let resolve = kernelResolve(base: false)
        var memo: [String: [Double]] = [:]
        var childrenByParent: [String: [String]] = [:]
        for key in mountedOrder {
            childrenByParent[parentKeyByKey[key] ?? "", default: []].append(key)
        }
        func build(_ key: String) -> SceneBusNode? {
            guard let node = irNodesByKey[key] else { return nil }
            let p = SceneIRKit.resolvedProps(node, resolve) { [weak self] in self?.diag($0) }
            var props: [String: String] = [
                "position": SceneAnim.formatAnimValue("position", p.position),
                "rotation": SceneAnim.formatAnimValue("rotation", p.rotation),
                "scale": SceneAnim.formatAnimValue("scale", p.scale),
                "color": p.color,
            ]
            for (name, raw) in node.attrs where !name.hasPrefix("on:") && name != "id" && name != "__css" {
                props[name] = resolve(node, name, raw)
            }
            // G2: a physics body's solver state rides the read (grounded exposed here)
            if let physics = physicsBusInfo(node) {
                props["grounded"] = physics.grounded ? "true" : "false"
                props["sleeping"] = physics.sleeping ? "true" : "false"
                props["velocity"] = SceneAnim.formatAnimValue("position", physics.velocity)
                props["rotation"] = SceneAnim.formatAnimValue("rotation", physics.rotation)
                props["angular-velocity"] = SceneAnim.formatAnimValue(
                    "position", physics.angularVelocity)
                props["torque"] = SceneAnim.formatAnimValue("position", physics.torque)
            }
            let world = busWorld(key, &memo)
            return SceneBusNode(kind: node.kind, id: node.id ?? "", props: props,
                                world: [world[12], world[13], world[14]],
                                children: (childrenByParent[key] ?? []).compactMap(build))
        }
        return (childrenByParent[""] ?? []).compactMap(build)
    }

    /// find a LIVE mounted node by authored id (bound rows included — the mounted-key
    /// walk, never the static template tree)
    private func busFind(_ id: String) -> SceneNode? {
        for key in mountedOrder {
            if let node = irNodesByKey[key], node.id == id { return node }
        }
        return nil
    }

    func busSet(id: String, attr: String, value: String) -> String {
        if attr.hasPrefix("on:") || attr == "id" || attr == "__css" { return "bad_attr" }
        guard let node = busFind(id) else { return "node_not_found" }
        busBase[ObjectIdentifier(node), default: [:]][attr] = value
        if attr == "position" || attr == "velocity" || attr == "rotation" ||
            attr == "angular-velocity" || attr == "torque" {
            physicsForcedWrites.insert("\(ObjectIdentifier(node)):\(attr)")
        }
        // the next apply detects the base change and glides authored transition=
        // properties (detectRetargets — the P5 plane); re-apply now so the write shows
        if let surface { apply(surface) }
        return "ok"
    }

    func busCamera() -> SceneBusCameraState {
        let resolve = kernelResolve(base: false)
        guard ir.nodes.contains(where: { $0.kind == "camera" }) else {
            return SceneBusCameraState(position: "0 0 5", lookAt: "0 0 0", fov: 60, authored: false)
        }
        let props = SceneIRKit.cameraProps(ir, resolve) { [weak self] in self?.diag($0) }
        return SceneBusCameraState(position: SceneAnim.formatAnimValue("position", props.position),
                                   lookAt: SceneAnim.formatAnimValue("position", props.lookAt),
                                   fov: props.fov, authored: true)
    }

    func busCameraSet(position: String?, lookAt: String?, flyTo: String?, durationMs: Double?) -> String {
        guard let camera = ir.nodes.first(where: { $0.kind == "camera" }) else { return "no_camera" }
        let oid = ObjectIdentifier(camera)
        if let lookAt {
            guard let parsed = SceneAnim.parseAnimValue("position", lookAt), parsed.count >= 3 else { return "bad_value" }
            busBase[oid, default: [:]]["look-at"] = SceneAnim.formatAnimValue("position", parsed)
        }
        if let position {
            guard let parsed = SceneAnim.parseAnimValue("position", position), parsed.count >= 3 else { return "bad_value" }
            busBase[oid, default: [:]]["position"] = SceneAnim.formatAnimValue("position", parsed)
        }
        if let flyTo {
            guard let to = SceneAnim.parseAnimValue("position", flyTo), to.count >= 3 else { return "bad_value" }
            // the P5 transition path, EASE-OUT (the documented choice): glide from the
            // CURRENT RENDERED position (never snap); the base holds the destination
            let from = SceneIRKit.cameraProps(ir, kernelResolve(base: false)) { [weak self] in self?.diag($0) }.position
            let ms = (durationMs ?? 0) > 0 ? durationMs! : 600
            var bucket = transitions[oid] ?? [:]
            bucket["position"] = TransitionRec(
                entry: SceneTransitionEntry(property: "position", durationMs: ms,
                                            easing: SceneAnim.parseEasing("ease-out"), delayMs: 0),
                state: SceneTransitionState(from: from, to: to, startMs: nowMs()))
            transitions[oid] = bucket
            setOverride(oid, "position", SceneAnim.formatAnimValue("position", from))
            busBase[oid, default: [:]]["position"] = SceneAnim.formatAnimValue("position", to)
        }
        if let surface { apply(surface) }
        return "ok"
    }

    func busCapture() -> SceneBusCapture? {
        guard let view = scnView, view.bounds.width > 0, view.bounds.height > 0 else { return nil }
        let image = view.snapshot()
        guard let data = image.pngData(), !data.isEmpty else { return nil }
        return SceneBusCapture(image: data.base64EncodedString(),
                               width: Int(image.size.width * image.scale),
                               height: Int(image.size.height * image.scale))
    }

    func busPick(x: Double, y: Double) -> SceneBusPickHit? {
        let resolve = kernelResolve(base: false)
        let bounds = scnView?.bounds
        let aspect = (bounds?.width ?? 0) > 0 && (bounds?.height ?? 0) > 0
            ? Double(bounds!.width / bounds!.height) : 16.0 / 9.0
        let camera = SceneIRKit.sceneCamera(ir, resolve, aspect: aspect) { [weak self] in self?.diag($0) }
        guard let ray = SceneMath.pickRay(proj: camera.proj, view: camera.view,
                                          ndcX: x * 2 - 1, ndcY: -(y * 2 - 1)) else { return nil }
        var memo: [String: [Double]] = [:]
        var best: (node: SceneNode, t: Double)?
        for key in mountedOrder {
            guard let node = irNodesByKey[key] else { continue }
            let props = SceneIRKit.resolvedProps(node, resolve) { [weak self] in self?.diag($0) }
            guard let localRadius = SceneIRKit.nodeBoundingRadius(node, props) else { continue }
            let sphere = SceneIRKit.worldBoundingSphere(busWorld(key, &memo), localRadius)
            guard let t = SceneMath.raySphere(origin: ray.origin, dir: ray.dir,
                                              center: sphere.center, radius: sphere.radius) else { continue }
            if best == nil || t < best!.t { best = (node: node, t: t) }
        }
        guard let best else { return nil }
        return SceneBusPickHit(id: best.node.id ?? "", kind: best.node.kind)
    }

    func busContacts() -> [SceneBusContact] {
        let resolve = kernelResolve(base: false)
        var memo: [String: [Double]] = [:]
        var shapes: [SceneColliderShape] = []
        var authoredIds: [String: String] = [:]
        var serial = 0
        for key in mountedOrder {
            guard let node = irNodesByKey[key],
                  node.kind == "box" || node.kind == "sphere" || node.kind == "plane" else { continue }
            let props = SceneIRKit.resolvedProps(node, resolve) { [weak self] in self?.diag($0) }
            if props.collide.isEmpty { continue }
            serial += 1
            let tid = "c\(serial)"
            guard let shape = SceneCollide.colliderFor(node, props, world: busWorld(key, &memo), id: tid) else { continue }
            shapes.append(shape)
            authoredIds[tid] = node.id ?? ""
        }
        return SceneCollide.contacts(shapes).map {
            SceneBusContact(a: authoredIds[$0.a] ?? "", b: authoredIds[$0.b] ?? "", depth: $0.depth)
        }
    }

    func busStats() -> SceneBusStats {
        var animationCount = transitions.values.reduce(0) { $0 + $1.count }
        for rec in animations.values where rec.playing && !rec.finished { animationCount += 1 }
        let boundRows = boundGroups.values.reduce(0) { $0 + $1.rows.count }
        return SceneBusStats(nodes: mountedOrder.count, animations: animationCount,
                             lastFrameDt: busLastFrameDt, boundRows: boundRows)
    }
}
