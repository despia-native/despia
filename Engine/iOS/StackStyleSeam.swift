//
//  StackStyleSeam.swift — the DSX-CSS and remote-transport seams (Phase K).
//
//  The kernel used to call `CSSEngine`, `CSSResolver`, `CSSInline` and `DSXRemoteCache` by name.
//  None of them live in the kernel: the CSS runtime is `ClosedSource/Registry/DSXCSS/*.swift`
//  and the transport belongs to the DSXView module. So the kernel could not compile without the
//  closed tree — the same defect `KernelTables.swift` fixes for generated data, one layer deeper.
//
//  WHY A SEAM AND NOT A MOVE. The constitution's answer for "a capability that must stay out of
//  a bundle that does not need it" is the empty seam (the pattern behind `RunnerScreenSeam`,
//  `RepoSeam`, `AppManifest.legacyOriginSource`). DSX-CSS is an AUTHORING SURFACE, not a kernel
//  primitive: an embedding that never writes a stylesheet should not carry a CSS cascade
//  resolver, and a kernel that hard-requires one cannot be the small thing every surface
//  consumes. Filling these from the kernel side later is still open — a seam does not prevent
//  the CSS runtime from moving into the kernel, it just stops the kernel from REQUIRING it.
//
//  THE DEFAULTS ARE HONEST, NOT LOSSY-SILENT. Unfilled, styling resolves to "nothing declared"
//  and the transport reports failure — the same answers those subsystems already give for an
//  element with no matching rule and for a network error. Both are states the engine handles on
//  every frame today, so an unassembled kernel degrades along a path that is already exercised
//  rather than into an unreachable branch.
//

import CoreGraphics
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// The DSX-CSS runtime, as the kernel needs it. Filled by the CSS runtime at boot; unfilled,
/// every lookup answers "no declaration", which is what an element with no matching rule gets.
public enum StackStyleSeam {

    /// Inline `style=""` CSS → resolved attribute map. `owner` brings the component sheet's
    /// custom properties into `var()` scope.
    public static var inlineAttributes: (
        _ css: String, _ classes: Set<String>, _ owner: String?, _ isDark: Bool?, _ viewport: CGSize?
    ) -> [String: String] = { _, _, _, _, _ in [:] }

    /// A compiled component `<style>` sheet → resolved attribute map.
    public static var sheetAttributes: (
        _ component: String, _ classes: Set<String>, _ isDark: Bool?,
        _ elementTokens: [String: String], _ viewport: CGSize?
    ) -> [String: String] = { _, _, _, _, _ in [:] }

    /// The `@keyframes` table an element's `animation` names, normalized to ordered stops
    /// (runtime-pressure R28). Separate from the two attribute lookups because a keyframe is a
    /// TABLE, not a declaration that applies to the element. Unfilled it answers "no timeline",
    /// which is the same answer an animation nobody defined gets: the element does not move.
    public static var keyframes: (
        _ owner: String?, _ name: String, _ isDark: Bool?, _ viewport: CGSize?
    ) -> [MotionCore.Stop] = { _, _, _, _ in [] }

    /// The custom properties (`--name: value`) declared in one inline CSS string.
    public static var customProperties: (_ source: String) -> [String: String] = { _ in [:] }

    /// The live DSX app-window viewport, for viewport-relative units and slide transitions.
    /// Defaults to the main screen rather than zero: a zero viewport would collapse every
    /// slide transition into a no-op, which looks like a broken animation, not a missing engine.
    public static var viewport: () -> CGSize = {
        #if canImport(UIKit)
        return UIScreen.main.bounds.size
        #else
        return .zero
        #endif
    }
}

/// The remote transport the Stack engine uses for `fetch`-shaped element work.
///
/// Owned by the DSXView module (`DSXRemoteCache`), which carries the caching and cookie policy.
/// Unfilled, both entry points answer `nil` — the transport-failure path, deterministic and
/// offline. That is precisely what `ClosedSource/scripts/conformance/RecordShims.swift` had to
/// hand-write to get the kernel to build for conformance runs; the seam makes the shim redundant
/// instead of making every embedder invent one.
public enum StackTransportSeam {
    public static var request: (
        _ url: String, _ method: String, _ headers: [String: String], _ body: Data?
    ) async -> (status: Int, data: Data)? = { _, _, _, _ in nil }

    public static var requestFull: (
        _ url: String, _ method: String, _ headers: [String: String], _ body: Data?
    ) async -> (status: Int, data: Data, headers: [String: String])? = { _, _, _, _ in nil }
}
