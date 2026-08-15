//
//  KeyboardViewport.swift — the soft-keyboard viewport contract, Swift twin.
//
//  The law and the reasoning live in OpenSource/Conformance/keyboard/README.md; the cases live
//  in viewport.json and run against THIS file (KeyboardViewportConformance, record lane),
//  against the TS twin (packages/kernel/src/keyboard.ts) and against the Kotlin twin
//  (:core KeyboardViewport.kt).
//
//  Everything here is pure: geometry in, published values out. The surface work — observing the
//  keyboard, resizing the web view, writing the CSS property — belongs to the
//  Core/Basics/Viewport module's swift facet. Keeping the decision separate from the plumbing is
//  what lets one corpus judge three runtimes, and is why this file imports only Foundation.
//

import Foundation

/// How the soft keyboard is allowed to affect the layout viewport.
public enum KeyboardMode: String {
    case legacy
    case resize
    case overlay
}

public struct KeyboardRect: Equatable {
    public let x: Int
    public let y: Int
    public let width: Int
    public let height: Int

    public init(x: Int, y: Int, width: Int, height: Int) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct KeyboardViewportState: Equatable {
    /// The mode actually in force, after capability gating.
    public let mode: KeyboardMode
    /// True when the declared mode could not be honoured and fell back to `.legacy`.
    public let degraded: Bool
    /// How much of the LAYOUT VIEWPORT the keyboard still obscures — `--keyboard-inset-height`.
    public let insetHeight: Int
    /// The same fact as a boolean: `navigator.virtualKeyboard.overlaysContent`.
    public let overlaysContent: Bool
    /// Where the keyboard is, clamped to the viewport: `navigator.virtualKeyboard.boundingRect`.
    public let boundingRect: KeyboardRect
}

public enum KeyboardViewport {

    /// Android's floor for reliable IME geometry (WindowInsets.Type.ime, API 30). Carried here so
    /// the three runtimes agree on the number the corpus asserts, not so iOS uses it.
    public static let imeInsetsAPIFloor = 30

    private static let emptyRect = KeyboardRect(x: 0, y: 0, width: 0, height: 0)

    /// The declared mode word, normalized. Anything unrecognized is `.legacy`: this value comes
    /// from a dashboard field, and a typo must not fail a build or half-apply a mode.
    public static func parseMode(_ declared: String?) -> KeyboardMode {
        switch declared?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "resize": return .resize
        case "overlay": return .overlay
        default: return .legacy
        }
    }

    /// The mode a runtime `navigator.virtualKeyboard.overlaysContent` assignment asks for.
    ///
    /// The page has exactly two things to say — overlay the content, or take the space out of the
    /// layout viewport — so the standard boolean covers the whole runtime vocabulary. `.legacy` is
    /// deliberately unreachable from here: it is the frozen BUILD default, not something a page can
    /// ask to return to.
    public static func modeForOverlaysContent(_ requested: Bool) -> KeyboardMode {
        return requested ? .overlay : .resize
    }

    /// Can this platform honour a non-legacy mode?
    ///
    /// Android only has reliable IME geometry from API 30; below that the signal is inconsistent
    /// enough that a half-working `resize` is worse than none, and an UNKNOWN level fails closed
    /// for the same reason. iOS and web are always capable.
    public static func supportsViewportModes(platform: String, api: Int?) -> Bool {
        guard platform.lowercased() == "android" else { return true }
        guard let api else { return false }
        return api >= imeInsetsAPIFloor
    }

    /// The whole contract, in one function.
    ///
    /// The subtle part is `insetHeight`, and it is the reason a page can be written once and work
    /// in every mode: it reports what the keyboard obscures OF THE LAYOUT VIEWPORT, not how tall
    /// the keyboard is. Under `.resize` the viewport has already shrunk, so the answer is 0 —
    /// publishing the raw height there would double-count and push content off screen.
    /// `boundingRect` answers the different question of WHERE the keyboard is, so it stays real in
    /// every mode.
    ///
    /// TWO PLANES FEED ONE ANSWER. `declared` is the build's word and never moves; `requested` is
    /// the page's live `overlaysContent` assignment and wins while it is set. Capability gating
    /// applies to whichever won, which is why `overlaysContent` in the result is the READ-BACK
    /// CONTRACT rather than an echo: a request the platform cannot honour degrades, and the page
    /// must be told what is in force instead of being left believing it got what it asked for.
    public static func resolve(
        declared: String?,
        platform: String,
        api: Int? = nil,
        keyboardVisible: Bool,
        keyboardHeight: Int,
        viewportWidth: Int,
        viewportHeight: Int,
        requested: Bool? = nil
    ) -> KeyboardViewportState {
        let declaredMode = requested.map { modeForOverlaysContent($0) } ?? parseMode(declared)
        let capable = supportsViewportModes(platform: platform, api: api)
        let mode: KeyboardMode = (declaredMode == .legacy || capable) ? declaredMode : .legacy
        // Declaring `.legacy` on an incapable platform is not degradation — it got what it asked for.
        let degraded = declaredMode != .legacy && !capable

        // A keyboard cannot obscure more than the viewport, and a negative height is nonsense that
        // reads as dismissed. Both guards matter: without them a rotation race or a bad platform
        // report becomes a negative CSS length or a rect taller than the screen.
        let ceiling = max(0, viewportHeight)
        let height = keyboardVisible ? min(max(0, keyboardHeight), ceiling) : 0

        let rect = height > 0
            ? KeyboardRect(x: 0, y: viewportHeight - height, width: viewportWidth, height: height)
            : emptyRect

        let overlays = mode != .resize
        return KeyboardViewportState(
            mode: mode,
            degraded: degraded,
            insetHeight: overlays ? height : 0,
            overlaysContent: overlays,
            boundingRect: rect
        )
    }
}
