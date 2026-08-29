//
//  ScrollLinked.swift — the `<scroll>` observation plane and the scroll-linked style substrate,
//  Swift twin (U01).
//
//  The law and the reasoning live in `OpenSource/Conformance/scroll/README.md`; the cases live in
//  that folder's seven .json files and run against the web twin
//  (@despia/kernel scroll.ts, packages/kernel/test/scroll-conformance.test.ts) and the Kotlin twin
//  (:core ScrollLinked.kt, ScrollLinkedConformanceTest).
//
//  Everything here is pure: geometry in, values out. The surface work — observing the scroll
//  view, driving the display link, writing resolved values into the render tree, and the `ref`
//  registry behind `dsx.scroll(name)` — belongs to the renderer's presenter, which on Apple is
//  StackScroll.swift. Keeping the decision separate from the plumbing is what lets one corpus
//  judge three runtimes.
//
//  THE SPLIT THIS FILE EXISTS FOR. `on:scroll` is for LOGIC and is coalesced to the display link;
//  `--scroll-*` is for STYLE and is a pure function of one sample, so a renderer resolves it
//  inside its own frame callback and nothing crosses the bus. A scroll handler dispatched per
//  frame through a message bus is how a framework earns its reputation, and it is the one thing
//  this design refuses to make possible.
//
//  FOUNDATION ONLY, ON PURPOSE — no UIKit, no SwiftUI — so this file can sit in
//  `check_swift_parse.rb`'s `engine-kernel` island and be TYPE-CHECKED on Linux, not merely
//  parsed. A pure core that only compiles on a mac stops being checkable between mac builds.
//
import Foundation

// ---------------------------------------------------------------------------- value types

public struct ScrollMetrics: Equatable {
    /// The RAW offset, sign intact: rubber-band over-scroll is real, and
    /// `<CollapsingHeader stretch>` is built on reading it.
    public var x: Double
    public var y: Double
    public var maxX: Double
    public var maxY: Double
    /// 0…1 across the vertical range, from the CLAMPED offset so over-scroll cannot leave it.
    public var progress: Double
    public var progressX: Double
    public var atTop: Bool
    public var atBottom: Bool
    public var atStart: Bool
    public var atEnd: Bool
}

public struct ScrollSample: Equatable {
    public var x: Double
    public var y: Double
    /// Milliseconds, from any monotonic clock the renderer already has.
    public var t: Double
    public init(x: Double, y: Double, t: Double) {
        self.x = x
        self.y = y
        self.t = t
    }
}

public struct ScrollMotionState: Equatable {
    public var dx: Double
    public var dy: Double
    public var velocityX: Double
    public var velocityY: Double
    /// Signed along the axis `direction` names, so the two are one coherent statement.
    public var velocity: Double
    public var direction: String
}

public struct ScrollCoalesceResult: Equatable {
    public var dispatches: Int
    public var at: [Double]
}

public struct ScrollReachEndState: Equatable {
    public var fire: Bool
    public var latched: Bool
    public var remaining: Double
}

public struct ScrollChildFrame: Equatable {
    public var start: Double
    public var length: Double
    public init(start: Double, length: Double) {
        self.start = start
        self.length = length
    }
}

public struct ScrollTarget: Equatable {
    public var x: Double
    public var y: Double
    public var animated: Bool
}

public struct ScrollMaintainResult: Equatable {
    public var offset: Double
    public var delta: Double
}

public struct ScrollLinkedAncestor {
    public var axis: String
    public var properties: [String: String]
    public init(axis: String, properties: [String: String]) {
        self.axis = axis
        self.properties = properties
    }
}

/// One named scroller's contribution to the root scope.
public struct NamedScrollPlane {
    public var ref: String
    public var properties: [String: String]
    public init(ref: String, properties: [String: String]) {
        self.ref = ref
        self.properties = properties
    }
}

public struct ScrollEdgeInsets: Equatable {
    public var top: Double
    public var right: Double
    public var bottom: Double
    public var left: Double
}

public struct ScrollConfig: Equatable {
    public var axis: String
    public var bind: String?
    public var indicators: Bool
    /// TRISTATE. nil is not `true`: it means the PLATFORM decides, and collapsing that to a
    /// boolean is how a framework ends up overriding iOS's own bounce on every scroll view.
    public var bounces: Bool?
    public var paging: Bool
    public var snap: String
    public var keyboardDismiss: String
    public var overscroll: String
    public var contentInset: ScrollEdgeInsets
    public var maintainPosition: Bool
    public var threshold: Double
}

public struct CollapseState: Equatable {
    public var fraction: Double
    public var headerHeight: Double
    public var effectiveMinHeight: Double
    public var imageTranslation: Double
    public var imageScale: Double
    public var effectiveParallax: Double
    public var headerTitleOpacity: Double
    public var navBarTitleOpacity: Double
    public var titleOwner: String
    public var blurRadius: Double
    public var pinnedOffset: Double
}

// ---------------------------------------------------------------------------- the core

public enum ScrollCore {

    /// Sub-pixel tolerance, in points. Momentum deceleration lands a fraction of a point short of
    /// the rail; a strict comparison makes `atBottom` flicker false at rest, which is how an
    /// infinite-scroll trigger misses. The same tolerance gives `direction` its stickiness.
    public static let epsilon: Double = 0.5

    /// One display-link tick at 60 Hz. The default coalescing budget for `on:scroll`.
    public static let frameBudgetMs: Double = 16.0

    /// How long without movement counts as settled, on a renderer with no platform deceleration
    /// callback (the web). iOS and Android have real end-of-deceleration signals and use those.
    public static let settleMs: Double = 120.0

    /// Above this speed a snap follows the direction of travel instead of the nearest candidate.
    public static let flingVelocity: Double = 500.0

    /// `on:collapse` quantum: a hundredth of the collapse range.
    public static let collapseEpsilon: Double = 0.01

    /// Where `<CollapsingHeader titleTransition="move">` hands the title to the nav bar. The
    /// header title's opacity reaches 0 exactly here and the nav bar's leaves 0 exactly here, so
    /// the two are never both visible and the title is ONE accessibility element at every fraction.
    public static let titleHandoffFraction: Double = 0.75

    /// Full-collapse blur radius for `blurOnCollapse`.
    public static let blurMax: Double = 20.0

    /// The default `<CollapsingHeader>` scrim: a bottom-anchored gradient from transparent at 60%
    /// of the height to 60% black at the bottom edge. It exists by default because a white title
    /// over a light photo is unreadable, and every app that ships this without one ships that bug.
    public static let scrimStart: Double = 0.6
    public static let scrimAlpha: Double = 0.6

    /// The default `minHeight` when the author names none. A host that knows its real bar height
    /// passes it; 56 is the shared floor (M3 small top app bar, comfortably over an iOS bar).
    public static let navBarHeight: Double = 56.0

    private static let calcUnits = ["rem", "deg", "ms", "em", "px", "pt", "vh", "vw", "%", "s"]
    private static let varDepthBudget = 8

    // ------------------------------------------------------------------ numbers

    /// A number that survived a platform report. Nonsense reads as the origin rather than
    /// poisoning every value derived from it: one NaN offset otherwise becomes a NaN CSS length,
    /// and a dropped declaration is a silent layout hole.
    ///
    /// A BOOLEAN IS NOT A NUMBER, matching Kotlin's `is Number` and TS's `typeof === "number"`.
    /// `objCType` is the only discriminator that holds: an NSNumber wrapping 0 answers TRUE to
    /// `is Bool` on both Apple and corelibs Foundation.
    public static func finite(_ value: Any?) -> Double {
        guard let value = value else { return 0.0 }
        var d: Double = 0.0
        if let number = value as? NSNumber {
            if String(cString: number.objCType) == "c" { return 0.0 }
            d = number.doubleValue
        } else if let number = value as? Double {
            d = number
        } else if let number = value as? Int {
            d = Double(number)
        } else if let text = value as? String {
            d = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0.0
        } else {
            return 0.0
        }
        return d.isFinite ? d : 0.0
    }

    /// Round half AWAY FROM ZERO to four decimals. Away-from-zero rather than half-to-even because
    /// three languages must agree, and only this rule is spelled the same in all three.
    public static func round4(_ value: Any?) -> Double {
        let v = finite(value)
        let sign: Double = v < 0 ? -1.0 : 1.0
        return sign * (abs(v) * 10000.0 + 0.5).rounded(.down) / 10000.0
    }

    /// The published spelling of a number. Part of the contract: the corpus compares strings, so
    /// three languages must format identically. No exponent, no trailing zeros, no negative zero.
    public static func formatNumber(_ value: Any?) -> String {
        let r = round4(value)
        if r == 0.0 { return "0" }
        var s = String(format: "%.4f", r)
        if s.contains(".") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        return s
    }

    private static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
        return v < lo ? lo : (v > hi ? hi : v)
    }

    // ------------------------------------------------------------------ metrics

    /// The offset math every other function here builds on.
    ///
    /// The degenerate case is pinned on purpose: content no taller than the viewport is at BOTH
    /// ends (a page with nothing to scroll IS at each of them, and that is what makes
    /// `on:reachEnd` fire once for a short list) and reports progress 0, never 1 — a
    /// non-scrollable plane must publish the RESTING state, because a header that boots into its
    /// collapsed look on a short page is the visible bug.
    public static func metrics(
        x: Any?, y: Any?,
        viewportWidth: Any?, viewportHeight: Any?,
        contentWidth: Any?, contentHeight: Any?
    ) -> ScrollMetrics {
        let ox = finite(x)
        let oy = finite(y)
        let maxX = max(0.0, finite(contentWidth) - finite(viewportWidth))
        let maxY = max(0.0, finite(contentHeight) - finite(viewportHeight))
        return ScrollMetrics(
            x: round4(ox),
            y: round4(oy),
            maxX: round4(maxX),
            maxY: round4(maxY),
            progress: round4(maxY <= 0 ? 0 : clamp(oy, 0, maxY) / maxY),
            progressX: round4(maxX <= 0 ? 0 : clamp(ox, 0, maxX) / maxX),
            atTop: oy <= epsilon,
            atBottom: oy >= maxY - epsilon,
            atStart: ox <= epsilon,
            atEnd: ox >= maxX - epsilon
        )
    }

    // ------------------------------------------------------------------ motion

    /// Motion from a SAMPLE PAIR, never from an accumulated delta.
    ///
    /// `direction` is STICKY below the tolerance. A one-pixel jitter that flips the word every
    /// frame is exactly the shrinking-header flicker, so a sub-tolerance sample keeps the previous
    /// word rather than inventing `none`; `none` is only ever the state before the first real
    /// movement. A non-monotonic or backwards clock yields velocity 0 rather than an infinity.
    public static func motion(
        previous: ScrollSample, next: ScrollSample, previousDirection: String?
    ) -> ScrollMotionState {
        let dx = finite(next.x) - finite(previous.x)
        let dy = finite(next.y) - finite(previous.y)
        let dt = finite(next.t) - finite(previous.t)
        let velocityX = dt > 0 ? dx * 1000.0 / dt : 0.0
        let velocityY = dt > 0 ? dy * 1000.0 / dt : 0.0
        // An exact tie prefers the vertical axis: it is the default axis of a <scroll>.
        let vertical = abs(dy) >= abs(dx)
        let delta = vertical ? dy : dx
        let direction: String
        if abs(delta) <= epsilon {
            direction = previousDirection ?? "none"
        } else if vertical {
            direction = delta > 0 ? "down" : "up"
        } else {
            direction = delta > 0 ? "right" : "left"
        }
        return ScrollMotionState(
            dx: round4(dx), dy: round4(dy),
            velocityX: round4(velocityX), velocityY: round4(velocityY),
            velocity: round4(vertical ? velocityY : velocityX),
            direction: direction
        )
    }

    // ------------------------------------------------------------------ coalescing

    /// The performance contract, as one predicate.
    ///
    /// With no handler bound the answer is FALSE, not "cheap": a scroll nobody is listening to
    /// costs nothing at all. Otherwise at most one dispatch per display-link tick, and the first
    /// sample of a gesture always dispatches so a handler sees the start.
    public static func shouldDispatch(
        hasHandler: Bool, lastDispatchAt: Double?, now: Double,
        frameBudgetMs budget: Double = ScrollCore.frameBudgetMs
    ) -> Bool {
        if !hasHandler { return false }
        guard let last = lastDispatchAt else { return true }
        return finite(now) - finite(last) >= finite(budget)
    }

    /// Run a whole sample train through the policy. The corpus asserts the COUNT over a fixed
    /// train, so a coalescing regression is caught rather than felt.
    public static func coalesce(
        samples: [Any?], hasHandler: Bool,
        frameBudgetMs budget: Double = ScrollCore.frameBudgetMs
    ) -> ScrollCoalesceResult {
        if !hasHandler { return ScrollCoalesceResult(dispatches: 0, at: []) }
        var at: [Double] = []
        var last: Double?
        for raw in samples {
            let t = finite(raw)
            if shouldDispatch(hasHandler: true, lastDispatchAt: last, now: t, frameBudgetMs: budget) {
                at.append(round4(t))
                last = t
            }
        }
        return ScrollCoalesceResult(dispatches: at.count, at: at)
    }

    // ------------------------------------------------------------------ reachEnd

    /// `on:reachEnd`, EDGE-TRIGGERED. It fires on the sample that crosses the threshold, not on
    /// every frame spent at the bottom; the latch releases when the user scrolls back out. Without
    /// the latch a "load more" handler is called sixty times a second at the rail, which is the
    /// classic duplicate-page bug.
    public static func reachEnd(
        latched: Bool, metrics m: ScrollMetrics, threshold: Any?, axis: String
    ) -> ScrollReachEndState {
        let remaining = axis == "horizontal"
            ? m.maxX - clamp(m.x, 0.0, m.maxX)
            : m.maxY - clamp(m.y, 0.0, m.maxY)
        let crossed = remaining <= finite(threshold) + epsilon
        return ScrollReachEndState(fire: crossed && !latched, latched: crossed, remaining: round4(remaining))
    }

    // ------------------------------------------------------------------ imperative

    /// `dsx.scroll(ref).to/.toTop/.toBottom/.toElement`, reduced to one offset.
    ///
    /// Three rules. An imperative call NEVER over-scrolls, so every target clamps into 0…max —
    /// `to({y: 99999})` parks on the rail instead of leaving a band of nothing under the content.
    /// `toTop`/`toBottom` name the PRIMARY AXIS rather than the vertical one, so the familiar
    /// words keep working on a horizontal rail. `align: "nearest"` is the only alignment allowed
    /// to decide not to move, which is what makes `toElement` safe to call on every selection
    /// change.
    ///
    /// An unrealised row in a virtualised list returns nil rather than guessing at an offset it
    /// cannot know; a virtualiser carrying an estimate passes the estimated frame and gets a real
    /// answer, then re-resolves once the row is realised.
    public static func resolveCommand(
        kind: String,
        metrics m: ScrollMetrics,
        viewportWidth: Any?,
        viewportHeight: Any?,
        axis: String,
        animated: Bool = true,
        toX: Double? = nil,
        toY: Double? = nil,
        child: ScrollChildFrame? = nil,
        align: String = "nearest"
    ) -> ScrollTarget? {
        let horizontal = axis == "horizontal"
        let offset = horizontal ? m.x : m.y
        let limit = horizontal ? m.maxX : m.maxY
        let view = finite(horizontal ? viewportWidth : viewportHeight)

        if kind == "to" {
            return ScrollTarget(
                x: round4(toX == nil ? m.x : clamp(finite(toX), 0.0, m.maxX)),
                y: round4(toY == nil ? m.y : clamp(finite(toY), 0.0, m.maxY)),
                animated: animated
            )
        }

        var target: Double
        switch kind {
        case "toTop":
            target = 0.0
        case "toBottom":
            target = limit
        case "toElement":
            guard let child = child else { return nil }
            let start = child.start
            let length = child.length
            if align == "start" {
                target = start
            } else if align == "center" {
                target = start + length / 2.0 - view / 2.0
            } else if align == "end" {
                target = start + length - view
            } else if start >= offset && start + length <= offset + view {
                target = offset
            } else if start < offset {
                target = start
            } else {
                target = start + length - view
            }
        default:
            return nil
        }
        target = clamp(target, 0.0, limit)
        return ScrollTarget(
            x: round4(horizontal ? target : m.x),
            y: round4(horizontal ? m.y : target),
            animated: animated
        )
    }

    // ------------------------------------------------------------------ snap

    private static func roundHalfUp(_ v: Double) -> Double {
        return v >= 0 ? (v + 0.5).rounded(.down) : -((-v + 0.5).rounded(.down))
    }

    /// The snap target, or nil when the container proposes none.
    ///
    /// `paging` is `page` (the viewport is the stride); `start`/`center`/`end` snap to CHILD
    /// BOUNDARIES, which is why real child frames are the input and a fixed stride is not — a rail
    /// of variable-width cards is the common case. At rest the nearest candidate wins and an exact
    /// tie takes the SMALLER offset, because a tie that advances is a snap that fights the finger.
    /// Past the fling threshold the target is the next candidate in the direction of travel.
    public static func resolveSnap(
        mode: String, offset: Any?, viewportLength: Any?, contentLength: Any?,
        children: [ScrollChildFrame], velocity: Any?
    ) -> Double? {
        let view = finite(viewportLength)
        let limit = max(0.0, finite(contentLength) - view)
        let at = finite(offset)
        let v = finite(velocity)
        if mode == "none" || limit <= 0 { return nil }

        if mode == "page" {
            if view <= 0 { return nil }
            let index = (at / view).rounded(.down)
            let fraction = at / view - index
            let target: Double
            if v >= flingVelocity {
                target = (index + 1) * view
            } else if v <= -flingVelocity {
                target = fraction > 0 ? index * view : (index - 1) * view
            } else {
                target = roundHalfUp(at / view) * view
            }
            return round4(clamp(target, 0.0, limit))
        }

        var candidates: [Double] = []
        for child in children {
            let start = finite(child.start)
            let length = finite(child.length)
            let raw: Double
            if mode == "start" {
                raw = start
            } else if mode == "center" {
                raw = start + length / 2.0 - view / 2.0
            } else {
                raw = start + length - view
            }
            candidates.append(clamp(raw, 0.0, limit))
        }
        if candidates.isEmpty { return nil }

        if v >= flingVelocity {
            let ahead = candidates.filter { $0 > at + epsilon }
            if let nearest = ahead.min() { return round4(nearest) }
        } else if v <= -flingVelocity {
            let behind = candidates.filter { $0 < at - epsilon }
            if let nearest = behind.max() { return round4(nearest) }
        }

        var best = candidates[0]
        for c in candidates {
            let d = abs(c - at)
            let bd = abs(best - at)
            if d < bd || (d == bd && c < best) { best = c }
        }
        return round4(best)
    }

    // ------------------------------------------------------------------ maintainPosition

    /// Keep the visual position across a content mutation.
    ///
    /// THE INPUT IS AN ANCHOR, not a content-height delta, and that is the whole design. A content
    /// height diff cannot tell a prepend from an append, so compensating on it makes an appending
    /// chat jump exactly as badly as a prepending one failed to. The anchor is a previously
    /// visible child's frame origin before and after the mutation; prepend, append and
    /// removal-above then all fall out of ONE formula, and the append case correctly compensates
    /// by zero.
    public static func maintainPosition(
        offset: Any?, anchorBefore: Any?, anchorAfter: Any?,
        viewportLength: Any?, contentLength: Any?
    ) -> ScrollMaintainResult {
        let limit = max(0.0, finite(contentLength) - finite(viewportLength))
        let delta = finite(anchorAfter) - finite(anchorBefore)
        return ScrollMaintainResult(
            offset: round4(clamp(finite(offset) + delta, 0.0, limit)),
            delta: round4(delta)
        )
    }

    // ------------------------------------------------------------------ linked properties

    /// The prefix every published key carries. A named plane is spelled by inserting the ref right
    /// after it, so the two families are one family with one namespace.
    private static let scrollPrefix = "--scroll-"

    /// The unqualified keys the two axis planes own. A named scroller may never publish one of
    /// them: `ref="progress"` would otherwise spell `--scroll-progress-x` and shadow the horizontal
    /// plane of whatever page it sits on. The reserved key wins and the named twin is simply not
    /// published, which keeps the collision a naming inconvenience rather than action at a distance.
    public static let reservedScrollKeys: Set<String> = [
        "--scroll-y", "--scroll-y-px", "--scroll-progress", "--scroll-velocity",
        "--scroll-remaining", "--scroll-remaining-px",
        "--scroll-x", "--scroll-x-px", "--scroll-progress-x", "--scroll-velocity-x",
        "--scroll-remaining-x", "--scroll-remaining-x-px",
    ]

    /// Points still to travel on an axis, from the CLAMPED offset so rubber-band over-scroll cannot
    /// push it past either end. `--scroll-y` measures from the top and this measures from the
    /// bottom; without it a bottom-anchored effect can only be written in `progress`, which is a
    /// fraction of the content and therefore a different distance on every list.
    private static func remainingOf(_ offset: Double, _ max: Double) -> Double {
        finite(max) - clamp(finite(offset), 0, finite(max))
    }

    /// The plane one scroll node publishes. A node contributes ONLY the plane of its own axis, so
    /// a horizontal rail inside a vertical page owns `--scroll-x*` and leaves `--scroll-y*` to the
    /// page.
    ///
    /// Two spellings per length, and this is a CORRECTION to the U01 plan: `--scroll-y` is
    /// unitless points so `calc(1 - var(--scroll-y) / 280)` types as a number, and `--scroll-y-px`
    /// carries px so `translateY(calc(var(--scroll-y-px) * 0.5))` types as a length. A single
    /// property cannot be both, and the plan's example is rejected by every engine.
    public static func linkedProperties(
        axis: String, metrics m: ScrollMetrics, velocity: Any?
    ) -> [String: String] {
        if axis == "horizontal" {
            let remaining = remainingOf(m.x, m.maxX)
            return [
                "--scroll-x": formatNumber(m.x),
                "--scroll-x-px": formatNumber(m.x) + "px",
                "--scroll-progress-x": formatNumber(m.progressX),
                "--scroll-velocity-x": formatNumber(velocity),
                "--scroll-remaining-x": formatNumber(remaining),
                "--scroll-remaining-x-px": formatNumber(remaining) + "px",
            ]
        }
        let remaining = remainingOf(m.y, m.maxY)
        return [
            "--scroll-y": formatNumber(m.y),
            "--scroll-y-px": formatNumber(m.y) + "px",
            "--scroll-progress": formatNumber(m.progress),
            "--scroll-velocity": formatNumber(velocity),
            "--scroll-remaining": formatNumber(remaining),
            "--scroll-remaining-px": formatNumber(remaining) + "px",
        ]
    }

    /// Whether a `ref` can name a plane. The ref registry treats a name as opaque, but a published
    /// key is a CSS custom property, and a name carrying a space or a dot does not spell one - so
    /// it publishes NOTHING rather than an unreachable key or, worse, a truncated one that another
    /// ref could also spell. The imperative surface behind the same ref is unaffected.
    public static func isScrollPlaneRef(_ ref: String) -> Bool {
        if ref.isEmpty { return false }
        for c in ref {
            let ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")
                || c == "-" || c == "_"
            if !ok { return false }
        }
        return true
    }

    /// The same plane, published under the node's `ref` and scoped to the DOCUMENT ROOT rather than
    /// to the node's descendants.
    ///
    /// THE CASE THE CASCADE CANNOT SERVE (R27). Pinned chrome - fade edges, a floating back-to-top,
    /// a progress rail - sits OVER a scroller and is by definition not inside it, so no cascade can
    /// ever reach it; and every way to make it a descendant makes it scroll away. Naming the
    /// scroller is the web's own answer to the same problem (`scroll-timeline` + `timeline-scope`
    /// name a scroller precisely so something outside its subtree can read it), and it needs no new
    /// value grammar here: the key is an ordinary custom property and `var()` already reads it.
    public static func namedLinkedProperties(
        ref: String, axis: String, metrics m: ScrollMetrics, velocity: Any?
    ) -> [String: String] {
        if !isScrollPlaneRef(ref) { return [:] }
        var out: [String: String] = [:]
        for (key, value) in linkedProperties(axis: axis, metrics: m, velocity: velocity) {
            let named = scrollPrefix + ref + "-" + String(key.dropFirst(scrollPrefix.count))
            if reservedScrollKeys.contains(named) { continue }
            out[named] = value
        }
        return out
    }

    /// Resolve the properties in scope for an element, from its scroll ancestors NEAREST FIRST, plus
    /// every named plane in the document.
    ///
    /// Each axis resolves independently from its own nearest ancestor, which is what an author
    /// expects of a horizontal rail inside a vertical page. An axis with no ancestor contributes
    /// NOTHING rather than zero, so `var(--scroll-y, 0)` can tell "no scroller" from "at the top".
    ///
    /// Named planes are document-wide and apply to every element, ancestor or not. They are merged
    /// in document order so a duplicated ref resolves to its LAST provider, which is the ref
    /// registry's own law (`Conformance/input/ref.json`) rather than a second opinion about it. A
    /// reserved key is dropped here as well as at publication, so a hand-built plane cannot shadow
    /// an axis either.
    public static func resolveLinkedScope(
        _ ancestors: [ScrollLinkedAncestor],
        named: [NamedScrollPlane] = []
    ) -> [String: String] {
        var out: [String: String] = [:]
        for plane in named {
            for (key, value) in plane.properties where !reservedScrollKeys.contains(key) {
                out[key] = value
            }
        }
        var vertical = false
        var horizontal = false
        for ancestor in ancestors {
            if ancestor.axis == "vertical" && !vertical {
                for (key, value) in ancestor.properties { out[key] = value }
                vertical = true
            } else if ancestor.axis == "horizontal" && !horizontal {
                for (key, value) in ancestor.properties { out[key] = value }
                horizontal = true
            }
        }
        return out
    }

    // ------------------------------------------------------------------ var()/calc()

    private struct Dimension {
        var value: Double
        var unit: String
    }

    /// The native twin of what a browser does for free: substitute `var()`, then fold every
    /// `calc()` with CSS's own unit algebra. The web renderer never calls it — the browser owns
    /// calc there — but the two native renderers must agree with the browser to the last decimal,
    /// so the reference implementation lives in the core and the corpus judges all three.
    ///
    /// Anything it cannot type DROPS the declaration (returns nil), which is what CSS itself does
    /// for a value that is invalid at computed value, and what CssValue already does for a cyclic
    /// var() chain.
    public static func evaluateLinked(_ expression: String, properties: [String: String]) -> String? {
        guard let substituted = substituteVars(expression, properties, 0) else { return nil }
        let characters = Array(substituted)
        let lower = Array(substituted.lowercased())
        var out = ""
        var i = 0
        while true {
            guard let at = nextMathFunction(lower, from: i) else {
                out += String(characters[i...].prefix(characters.count - i))
                return out
            }
            out += String(characters[i..<at.start])
            guard let close = matchParen(characters, from: at.open + 1) else { return nil }
            guard let folded = foldCalc(String(characters[at.start...close])) else { return nil }
            out += formatNumber(folded.value) + folded.unit
            i = close + 1
        }
    }

    /// The four CSS math functions this evaluator folds, longest first so `calc` cannot shadow one.
    private static let mathFunctions = ["clamp(", "calc(", "min(", "max("]

    /// The next math function at or after `from`, ignoring one that is only the tail of a longer
    /// identifier (`admin(` is not `min(`).
    private static func nextMathFunction(
        _ lower: [Character], from: Int
    ) -> (start: Int, open: Int)? {
        var best: (start: Int, open: Int)?
        for name in mathFunctions {
            var at = indexOf(lower, name, from: from)
            while let found = at {
                let before: Character = found > 0 ? lower[found - 1] : " "
                let glued = (before >= "a" && before <= "z") || (before >= "0" && before <= "9")
                    || before == "-" || before == "_"
                if !glued {
                    if best == nil || found < best!.start {
                        best = (start: found, open: found + name.count - 1)
                    }
                    break
                }
                at = indexOf(lower, name, from: found + 1)
            }
        }
        return best
    }

    /// Index of `needle` in `haystack` at or after `from`, or nil. Character arrays rather than
    /// String.Index so the three twins index the same way over the same units.
    private static func indexOf(_ haystack: [Character], _ needle: String, from: Int) -> Int? {
        let pattern = Array(needle)
        if pattern.isEmpty || from > haystack.count - pattern.count { return nil }
        var i = max(0, from)
        while i + pattern.count <= haystack.count {
            var match = true
            for j in 0..<pattern.count where haystack[i + j] != pattern[j] {
                match = false
                break
            }
            if match { return i }
            i += 1
        }
        return nil
    }

    /// Index of the `)` closing a `(` whose CONTENT starts at `from`, or nil.
    private static func matchParen(_ source: [Character], from: Int) -> Int? {
        var depth = 1
        var i = from
        while i < source.count {
            if source[i] == "(" {
                depth += 1
            } else if source[i] == ")" {
                depth -= 1
                if depth == 0 { return i }
            }
            i += 1
        }
        return nil
    }

    private static func substituteVars(
        _ source: String, _ properties: [String: String], _ depth: Int
    ) -> String? {
        let characters = Array(source)
        if indexOf(characters, "var(", from: 0) == nil { return source }
        // A cyclic definition rotates forever; the budget terminates it exactly as CssValue does.
        if depth > varDepthBudget { return nil }
        var out = ""
        var i = 0
        while true {
            guard let at = indexOf(characters, "var(", from: i) else {
                out += String(characters[i...].prefix(characters.count - i))
                break
            }
            out += String(characters[i..<at])
            guard let close = matchParen(characters, from: at + 4) else { return nil }
            let inner = String(characters[(at + 4)..<close])
            let comma = splitTopLevel(inner, ",")
            let name = comma[0].trimmingCharacters(in: .whitespacesAndNewlines)
            let fallback: String? = comma.count > 1
                ? comma[1...].joined(separator: ",").trimmingCharacters(in: .whitespacesAndNewlines)
                : nil
            if let value = properties[name] {
                out += value
            } else if let value = fallback {
                out += value
            } else {
                return nil
            }
            i = close + 1
        }
        return substituteVars(out, properties, depth + 1)
    }

    private static func splitTopLevel(_ source: String, _ separator: Character) -> [String] {
        var parts: [String] = []
        var depth = 0
        var current = ""
        for ch in source {
            if ch == "(" {
                depth += 1
            } else if ch == ")" {
                depth -= 1
            }
            if ch == separator && depth == 0 {
                parts.append(current)
                current = ""
            } else {
                current.append(ch)
            }
        }
        parts.append(current)
        return parts
    }

    private enum CalcToken {
        case op(Character)
        case num(Double, String)
    }

    private static func tokenizeCalc(_ source: String) -> [CalcToken]? {
        let characters = Array(source)
        let lower = Array(source.lowercased())
        var tokens: [CalcToken] = []
        var i = 0
        while i < characters.count {
            let ch = characters[i]
            if ch == " " || ch == "\t" || ch == "\n" || ch == "\r" {
                i += 1
                continue
            }
            if ch == "(" || ch == ")" || ch == "+" || ch == "-" || ch == "*" || ch == "/"
                || ch == "," {
                tokens.append(.op(ch))
                i += 1
                continue
            }
            if (ch >= "0" && ch <= "9") || ch == "." {
                var j = i
                while j < characters.count && ((characters[j] >= "0" && characters[j] <= "9") || characters[j] == ".") {
                    j += 1
                }
                guard let value = Double(String(characters[i..<j])), value.isFinite else { return nil }
                var unit = ""
                for candidate in calcUnits {
                    let end = j + candidate.count
                    if end <= lower.count && String(lower[j..<end]) == candidate {
                        unit = candidate
                        j = end
                        break
                    }
                }
                tokens.append(.num(value, unit))
                i = j
                continue
            }
            if i + 5 <= lower.count && String(lower[i..<(i + 5)]) == "calc(" {
                tokens.append(.op("("))
                i += 5
                continue
            }
            // `m` / `x` / `c` are the heads of min() / max() / clamp(); each keeps its own `(`, so
            // the parser reads a function the way it reads a group plus an arity.
            if i + 4 <= lower.count && String(lower[i..<(i + 4)]) == "min(" {
                tokens.append(.op("m"))
                tokens.append(.op("("))
                i += 4
                continue
            }
            if i + 4 <= lower.count && String(lower[i..<(i + 4)]) == "max(" {
                tokens.append(.op("x"))
                tokens.append(.op("("))
                i += 4
                continue
            }
            if i + 6 <= lower.count && String(lower[i..<(i + 6)]) == "clamp(" {
                tokens.append(.op("c"))
                tokens.append(.op("("))
                i += 6
                continue
            }
            return nil
        }
        return tokens
    }

    /// `min()` / `max()` / `clamp()`. CSS compares LIKE with LIKE, so every argument must carry
    /// the same unit — a bound is meaningless between a length and a ratio — and `clamp()` is
    /// exactly three arguments, folded as `max(low, min(value, high))`, which is CSS's own
    /// definition and is what makes an inverted pair resolve to the low bound rather than to
    /// nothing.
    private static func compare(_ fn: Character, _ args: [Dimension]) -> Dimension? {
        guard let first = args.first else { return nil }
        let unit = first.unit
        for arg in args where arg.unit != unit { return nil }
        if fn == "c" {
            guard args.count == 3 else { return nil }
            let value = Swift.min(args[1].value, args[2].value)
            return Dimension(value: Swift.max(args[0].value, value), unit: unit)
        }
        var out = first.value
        for arg in args {
            out = fn == "m" ? Swift.min(out, arg.value) : Swift.max(out, arg.value)
        }
        return Dimension(value: out, unit: unit)
    }

    /// Fold one math function, HEAD INCLUDED (`calc(…)`, `min(…)`, `max(…)`, `clamp(…)`, nested
    /// freely). CSS's unit algebra, and nothing beyond it: `+`/`-` need matching
    /// units (zero being the one unitless length), at most one operand of a product may carry a
    /// unit, and a divisor must be a non-zero number. Every refusal returns nil so the caller
    /// drops the whole declaration rather than shipping a half-typed value.
    private static func foldCalc(_ body: String) -> Dimension? {
        guard let tokens = tokenizeCalc(body) else { return nil }
        var pos = 0

        func peek() -> Character? {
            guard pos < tokens.count else { return nil }
            switch tokens[pos] {
            case .op(let ch): return ch
            case .num: return "n"
            }
        }

        func primary() -> Dimension? {
            guard let kind = peek() else { return nil }
            if kind == "(" {
                pos += 1
                guard let inner = sum(), peek() == ")" else { return nil }
                pos += 1
                return inner
            }
            if kind == "-" {
                pos += 1
                guard let inner = primary() else { return nil }
                return Dimension(value: -inner.value, unit: inner.unit)
            }
            if kind == "+" {
                pos += 1
                return primary()
            }
            if kind == "m" || kind == "x" || kind == "c" {
                pos += 1
                guard peek() == "(" else { return nil }
                pos += 1
                var args: [Dimension] = []
                while true {
                    guard let arg = sum() else { return nil }
                    args.append(arg)
                    if peek() != "," { break }
                    pos += 1
                }
                guard peek() == ")" else { return nil }
                pos += 1
                return compare(kind, args)
            }
            if kind == "n" {
                guard case let .num(value, unit) = tokens[pos] else { return nil }
                pos += 1
                return Dimension(value: value, unit: unit)
            }
            return nil
        }

        func product() -> Dimension? {
            guard var left = primary() else { return nil }
            while true {
                guard let op = peek(), op == "*" || op == "/" else { return left }
                pos += 1
                guard let right = primary() else { return nil }
                if op == "*" {
                    // CSS has no square pixels.
                    if !left.unit.isEmpty && !right.unit.isEmpty { return nil }
                    left = Dimension(value: left.value * right.value,
                                     unit: left.unit.isEmpty ? right.unit : left.unit)
                } else {
                    // Division BY a dimension is not a CSS operation.
                    if !right.unit.isEmpty { return nil }
                    // An infinity in a declaration is a dropped declaration.
                    if right.value == 0 { return nil }
                    left = Dimension(value: left.value / right.value, unit: left.unit)
                }
            }
        }

        func sum() -> Dimension? {
            guard var left = product() else { return nil }
            while true {
                guard let op = peek(), op == "+" || op == "-" else { return left }
                pos += 1
                guard let right = product() else { return nil }
                var unit = left.unit
                if !left.unit.isEmpty && !right.unit.isEmpty {
                    if left.unit != right.unit { return nil }
                } else if !left.unit.isEmpty && right.unit.isEmpty {
                    if right.value != 0 { return nil }
                } else if left.unit.isEmpty && !right.unit.isEmpty {
                    if left.value != 0 { return nil }
                    unit = right.unit
                }
                left = Dimension(value: op == "+" ? left.value + right.value : left.value - right.value,
                                 unit: unit)
            }
        }

        guard let result = sum(), pos == tokens.count else { return nil }
        return result
    }

    // ------------------------------------------------------------------ collapse (U10)

    /// `<CollapsingHeader>` (U10), which is a pure function of `--scroll-y` and therefore lives
    /// here.
    ///
    /// THE TITLE IS ONE ACCESSIBILITY ELEMENT AT EVERY FRACTION, and that is enforced by
    /// construction rather than by review: `titleOwner` is a single value, and under `move` the
    /// header's opacity reaches 0 exactly where the nav bar's leaves 0. A naive implementation
    /// cross-fades the two over the whole range and a screen reader then finds the title twice.
    ///
    /// THE PINNED SLOT RAISES THE FLOOR. `effectiveMinHeight` is max(minHeight, pinnedHeight), so
    /// content that must survive the collapse cannot be clipped by a minHeight the author chose
    /// before adding it.
    ///
    /// REDUCED MOTION zeroes parallax and keeps everything else: the collapse is LAYOUT and must
    /// still happen, and `stretch` survives because it tracks the finger one to one rather than
    /// animating on its own, which is not what the vestibular guidance is about.
    public static func collapse(
        scrollY: Any?,
        height: Any? = 280.0,
        minHeight: Any? = ScrollCore.navBarHeight,
        pinnedHeight: Any? = 0.0,
        parallax: Any? = 0.5,
        stretch: Bool = true,
        blurOnCollapse: Bool = false,
        titleTransition: String = "move",
        reduceMotion: Bool = false
    ) -> CollapseState {
        let h = max(0.0, finite(height))
        let pinned = max(0.0, finite(pinnedHeight))
        let floorHeight = clamp(max(finite(minHeight), pinned), 0.0, h)
        let y = finite(scrollY)
        let p = clamp(finite(parallax), 0.0, 1.0)

        let range = max(0.0, h - floorHeight)
        // The degenerate case answers 0, matching metrics.json: nothing to collapse means the
        // RESTING state, because booting into the collapsed look on a short page is the bug.
        let fraction = range <= 0.0 ? 0.0 : clamp(y / range, 0.0, 1.0)

        let stretching = y < 0.0 && stretch
        let headerHeight = stretching ? h - y : h - fraction * range
        let imageScale = (stretching && h > 0.0) ? (h - y) / h : 1.0

        let effectiveParallax = reduceMotion ? 0.0 : p
        // Clamped to the range: once the header has stopped shrinking there is nothing left to
        // move the image against, and an unclamped translation walks it out of its own header.
        let imageTranslation = clamp(y, 0.0, range) * effectiveParallax

        let headerTitleOpacity: Double
        let navBarTitleOpacity: Double
        let titleOwner: String
        if titleTransition == "move" {
            headerTitleOpacity = clamp(1.0 - fraction / titleHandoffFraction, 0.0, 1.0)
            navBarTitleOpacity = clamp((fraction - titleHandoffFraction) / (1.0 - titleHandoffFraction), 0.0, 1.0)
            titleOwner = fraction >= titleHandoffFraction ? "navbar" : "header"
        } else if titleTransition == "fade" {
            headerTitleOpacity = clamp(1.0 - fraction, 0.0, 1.0)
            navBarTitleOpacity = 0.0
            titleOwner = "header"
        } else {
            headerTitleOpacity = 1.0
            navBarTitleOpacity = 0.0
            titleOwner = "header"
        }

        return CollapseState(
            fraction: round4(fraction),
            headerHeight: round4(headerHeight),
            effectiveMinHeight: round4(floorHeight),
            imageTranslation: round4(imageTranslation),
            imageScale: round4(imageScale),
            effectiveParallax: round4(effectiveParallax),
            headerTitleOpacity: round4(headerTitleOpacity),
            navBarTitleOpacity: round4(navBarTitleOpacity),
            titleOwner: titleOwner,
            blurRadius: round4(blurOnCollapse ? fraction * blurMax : 0.0),
            pinnedOffset: round4(max(0.0, headerHeight - pinned))
        )
    }

    /// `on:collapse` is quantised to a hundredth of the range, with the endpoints ALWAYS emitted
    /// so a handler can rely on seeing exactly 0 and exactly 1.
    public static func shouldEmitCollapse(previousFraction: Double?, fraction: Double) -> Bool {
        guard let previous = previousFraction else { return true }
        if fraction != previous && (fraction == 0.0 || fraction == 1.0) { return true }
        return abs(fraction - previous) >= collapseEpsilon
    }

    // ------------------------------------------------------------------ attributes

    public static func boolAttribute(_ value: String?, _ fallback: Bool) -> Bool {
        guard let value = value else { return fallback }
        switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "false", "0", "no", "off": return false
        case "true", "1", "yes", "on", "": return true
        default: return fallback
        }
    }

    public static func numberAttribute(_ value: String?, _ fallback: Double) -> Double {
        guard let value = value else { return fallback }
        // An empty string is ABSENCE, not zero: `Number('')` is 0 in JS and null in Kotlin/Swift,
        // and a twin that disagrees on the empty attribute disagrees on every unset one.
        var cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasSuffix("%") { cleaned = String(cleaned.dropLast()) }
        let lower = cleaned.lowercased()
        if lower.hasSuffix("px") || lower.hasSuffix("pt") { cleaned = String(cleaned.dropLast(2)) }
        if cleaned.isEmpty { return fallback }
        guard let n = Double(cleaned), n.isFinite else { return fallback }
        return n
    }

    public static func wordAttribute(_ value: String?, _ allowed: [String], _ fallback: String) -> String {
        guard let value = value else { return fallback }
        let word = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        for candidate in allowed where candidate.lowercased() == word { return candidate }
        return fallback
    }

    /// CSS edge shorthand, exactly: 1, 2, 3 or 4 values. An author who has written CSS knows it.
    public static func parseEdgeInsets(_ value: String?) -> ScrollEdgeInsets {
        let zero = ScrollEdgeInsets(top: 0, right: 0, bottom: 0, left: 0)
        guard let value = value else { return zero }
        let nums = value.replacingOccurrences(of: ",", with: " ")
            .split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" })
            .map { numberAttribute(String($0), 0.0) }
        if nums.isEmpty { return zero }
        if nums.count == 1 {
            let v = round4(nums[0])
            return ScrollEdgeInsets(top: v, right: v, bottom: v, left: v)
        }
        if nums.count == 2 {
            return ScrollEdgeInsets(top: round4(nums[0]), right: round4(nums[1]),
                                    bottom: round4(nums[0]), left: round4(nums[1]))
        }
        if nums.count == 3 {
            return ScrollEdgeInsets(top: round4(nums[0]), right: round4(nums[1]),
                                    bottom: round4(nums[2]), left: round4(nums[1]))
        }
        return ScrollEdgeInsets(top: round4(nums[0]), right: round4(nums[1]),
                                bottom: round4(nums[2]), left: round4(nums[3]))
    }

    /// The whole `<scroll>` attribute table, folded through ONE total function: no input throws,
    /// no unrecognised word fails a build, and every unknown value falls back to the documented
    /// default. These values come from authored markup and a dashboard field, not from a schema.
    ///
    /// `paging` and `snap` are one setting with two spellings, so paging resolves to `page` and
    /// outranks a declared snap word rather than silently fighting it.
    public static func parseConfig(_ attributes: [String: String?]) -> ScrollConfig {
        let paging = boolAttribute(attributes["paging"] ?? nil, false)
        let snapWord = wordAttribute(attributes["snap"] ?? nil, ["none", "start", "center", "end"], "none")
        let bouncesWord = attributes["bounces"] ?? nil
        return ScrollConfig(
            axis: wordAttribute(
                (attributes["axis"] ?? nil) ?? (attributes["direction"] ?? nil),
                ["vertical", "horizontal"], "vertical"
            ),
            bind: attributes["bind"] ?? nil,
            indicators: boolAttribute(attributes["indicators"] ?? nil, true),
            bounces: bouncesWord == nil ? nil : boolAttribute(bouncesWord, true),
            paging: paging,
            snap: paging ? "page" : snapWord,
            keyboardDismiss: wordAttribute(
                attributes["keyboardDismiss"] ?? nil,
                ["none", "onDrag", "interactive"], "interactive"
            ),
            overscroll: wordAttribute(attributes["overscroll"] ?? nil, ["auto", "never", "always"], "auto"),
            contentInset: parseEdgeInsets(attributes["contentInset"] ?? nil),
            maintainPosition: boolAttribute(attributes["maintainPosition"] ?? nil, false),
            threshold: round4(max(0.0, numberAttribute(attributes["threshold"] ?? nil, 0.0)))
        )
    }
}
