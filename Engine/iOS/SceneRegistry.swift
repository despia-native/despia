//
//  SceneRegistry.swift — the SceneRegistry seam (dsx-game.md §2 G5): the kernel-side
//  door between mounted `<scene>` ELEMENTS and the `scene` bus MODULE (Core/Scene).
//  The SceneAR.provider / JsTier.engine shape: elements register a SceneBusSurface on
//  mount (keyed by their `id` attr, or the auto key `scene#N`) and unregister on
//  unmount; the module's actions resolve a target by that key (absent = the FIRST
//  mounted scene) and drive the element through the handle — never the other way
//  around. The kernel names no module: an excluded Core/Scene leaves this registry
//  unread and scenes render untouched (file presence is the gate, never #if).
//
//  Events ride the seam too: the element emits `ready` / `collide` through
//  SceneRegistry.emit; the Core/Scene module subscribes once (bind) and re-fires them
//  on the standard bus planes as `scene.ready` / `scene.collide` (modules provide,
//  surfaces consume — the element itself never touches the bus).
//
//  Main-thread confined, like the element that feeds it: registration happens in the
//  representable lifecycle, and the module hops to main before driving a handle.
//

import Foundation

/// one frame of capture evidence — `image` is base64 PNG bytes on iOS
struct SceneBusCapture {
    let image: String
    let width: Int
    let height: Int
}

/// one resolved node of the bus-facing tree (props are RESOLVED strings — overrides
/// applied, the same plane the renderer draws from)
struct SceneBusNode {
    let kind: String
    let id: String
    let props: [String: String]
    /// world position [x, y, z] (the corpus world matrix's translation); nil for
    /// kinds without a world entry
    let world: [Double]?
    let children: [SceneBusNode]

    /// the wire shape the module resolves with (plain JSON-able dictionaries)
    var payload: [String: Any] {
        var out: [String: Any] = ["kind": kind, "id": id, "props": props,
                                  "children": children.map { $0.payload }]
        if let world { out["world"] = world }
        return out
    }
}

struct SceneBusContact {
    let a: String
    let b: String
    let depth: Double
}

struct SceneBusStats {
    let nodes: Int
    let animations: Int
    let lastFrameDt: Double
    let boundRows: Int
}

struct SceneBusCameraState {
    let position: String
    let lookAt: String
    let fov: Double
    let authored: Bool
}

struct SceneBusPickHit {
    let id: String
    let kind: String
}

/// what a mounted `<scene>` element binds into the registry
protocol SceneBusSurface: AnyObject {
    /// the element's authored `id` attr, or nil
    var sceneBusId: String? { get }
    func busNodes() -> [SceneBusNode]
    /// "ok" | "node_not_found" | "bad_attr" — writes ride the resolved-attribute BASE
    /// plane, so an authored `transition=` glides the change (the P5 override plane)
    func busSet(id: String, attr: String, value: String) -> String
    func busCamera() -> SceneBusCameraState
    /// "ok" | "no_camera" | "bad_value" — flyTo rides the P5 transition path (EASE-OUT)
    func busCameraSet(position: String?, lookAt: String?, flyTo: String?, durationMs: Double?) -> String
    /// nil = no live render view → the module's typed capture_failed
    func busCapture() -> SceneBusCapture?
    /// normalized (x, y) ∈ [0,1] — the pick math of on:tap, WITHOUT firing handlers
    func busPick(x: Double, y: Double) -> SceneBusPickHit?
    func busContacts() -> [SceneBusContact]
    func busStats() -> SceneBusStats
}

/// the seam. Registration order is mount order; absent targets resolve to the FIRST
/// mounted scene. Empty by default — the Core/Scene module is its only reader.
enum SceneRegistry {
    private(set) static var order: [String] = []
    private static var surfaces: [String: SceneBusSurface] = [:]
    private static var listeners: [(key: Int, fn: (String, String, [String: Any]) -> Void)] = []
    private static var serial = 0
    private static var listenerSerial = 0

    /// register a mounted scene; returns its key (the id attr, or `scene#N`). A
    /// duplicate id keeps BOTH scenes addressable — the later one takes the auto key.
    static func register(_ surface: SceneBusSurface) -> String {
        serial += 1
        var key = surface.sceneBusId?.isEmpty == false ? surface.sceneBusId! : "scene#\(serial)"
        if surfaces[key] != nil { key = "scene#\(serial)" }
        surfaces[key] = surface
        order.append(key)
        return key
    }

    static func unregister(_ key: String) {
        surfaces[key] = nil
        order.removeAll { $0 == key }
    }

    /// an explicit key, or the FIRST mounted scene when none is named. nil =
    /// scene_not_found.
    static func resolve(_ scene: String?) -> SceneBusSurface? {
        if let scene, !scene.isEmpty { return surfaces[scene] }
        guard let first = order.first else { return nil }
        return surfaces[first]
    }

    /// the module's event subscription (ready/collide → the bus planes); returns the
    /// unsubscribe closure
    static func listen(_ fn: @escaping (String, String, [String: Any]) -> Void) -> () -> Void {
        listenerSerial += 1
        let key = listenerSerial
        listeners.append((key: key, fn: fn))
        return { listeners.removeAll { $0.key == key } }
    }

    /// the element-side event door — delivered as-is (the element already emits on main)
    static func emit(scene: String, kind: String, payload: [String: Any]) {
        for listener in listeners { listener.fn(scene, kind, payload) }
    }
}
