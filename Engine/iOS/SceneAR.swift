//
//  SceneAR.swift - the kernel's mode="ar" seam (dsx-scene.md P3). The `<scene>` element
//  renders AR by mounting the SAME SceneKit graph (SceneElement.swift) into a camera-
//  composited view a MODULE provides — the kernel itself imports zero ARKit, exactly as
//  it imports zero WebKit: the AR capability (camera permission, session lifecycle,
//  anchor events) is module-owned and file-presence-gated per the constitution.
//
//  THE SEAM CONTRACT (the Tier.swift `JsTier.engine` / RemoteBundleGate verifier shape,
//  and Android's JsEngine precedent for the module-bound half): `SceneAR.provider` is
//  NIL BY DEFAULT. The Core/SceneAR module binds it in setup(); that module in turn
//  borrows the ONE shared ARSession from the Core/AR module over the bus
//  (dsx.module.ar.start / object("session") — the Scene3D precedent), so permission
//  prompts and the camera stay owned where they always were. Unbound — the module
//  excluded — `<scene mode="ar">` renders the plain SceneKit graph plus the honest
//  unavailable label: never a crash, never a silent camera grab (Article 7).
//
//  Only SceneKit/UIKit types cross the seam (both already kernel frameworks): the
//  provider receives the live SCNScene and hands back a plain UIView; anchor matches
//  arrive as SCNNode + plain numbers, delivered ON MAIN. No ARKit type is named here,
//  so excluding the module strips every line of AR behavior from the build.
//

import Foundation
import SceneKit
import UIKit

/// One world anchor the AR session matched: `kind` ("plane" — kind="image" is the P3
/// named absence), the live SCNNode ARKit keeps world-locked (the `<anchor>` subtree
/// reparents under it), and the anchor's world position in meters at match time.
struct SceneARAnchorMatch {
    let kind: String
    let node: SCNNode
    let position: [Double]
}

/// What the Core/SceneAR module binds. Every callback MUST be delivered on the main
/// queue (ARKit's delegates fire on its render/session queues — the provider hops).
protocol SceneARSurfaceProviding: AnyObject {
    /// Build the camera-composited AR view rendering `scene` (the element's live graph —
    /// the provider must not replace it). `planeDetection` is true when the markup
    /// authors any `<anchor kind="plane">`. Session start is ASYNC behind this call
    /// (permission prompt); a failure (camera denied, AR module excluded, session error)
    /// arrives as `onUnavailable(reason)` and the caller falls back to the plain
    /// SceneKit path. Returns nil only when this device can never run AR.
    func makeARView(scene: SCNScene, planeDetection: Bool,
                    onAnchor: @escaping (SceneARAnchorMatch) -> Void,
                    onUnavailable: @escaping (String) -> Void) -> UIView?
    /// Release the session behind `view` (the camera) — idempotent, called at unmount.
    func endARView(_ view: UIView)
}

enum SceneAR {
    /// nil by default — bound by the SceneAR module (ClosedSource/DSX/Modules/
    /// Core/Scene/Modules/AR — the nested `scene.ar` child of Core/Scene) in setup().
    /// File presence IS the gate: excluded, nothing binds and mode="ar" keeps the
    /// honest fallback (never `#if`).
    static var provider: SceneARSurfaceProviding?
}
