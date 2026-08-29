//
//  StackSharedTransition.swift — the shared-element (`shared=`) transition PURE CORE: the
//  matching algorithm, the interpolation schedule and the interruption/reversal state machine.
//  The law is the corpus, OpenSource/Conformance/router/shared.json
//  (parity/U03-shared-transitions.md); the Kotlin twin is :core StackSharedTransition.kt and
//  the web twin is @despia-native/kernel's shared-transition.ts.
//
//  Everything platform-shaped lives OUTSIDE this file. iOS flies the pairs under
//  `UIViewControllerAnimatedTransitioning` with a snapshot layer driven by a
//  `UIViewPropertyAnimator` (RouterSharedElements.swift); Android places them inside a shared
//  LookaheadScope; web sets `view-transition-name` where the View Transitions API exists and
//  runs a WAAPI FLIP otherwise. All three ask THIS file which ids pair, where a pair is at a
//  given progress, and what an interruption does — which is why one corpus can judge three
//  renderers.
//
//  THE TWO LAWS THAT ARE EASY TO GET WRONG, both pinned here rather than per platform:
//    • an UNMATCHED id is not an error. It takes the ordinary frame transition, silently.
//    • an UNREALISED destination (a virtualised row, an image still loading) animates from the
//      SOURCE geometry to the SOURCE geometry and cross-fades. Animating to the zero rect a
//      not-yet-laid-out node reports is what makes the naive implementation look like the
//      image collapsing into nothing.
//
//  No UIKit import: this file is pure so the record lane can run it headless.
//
import Foundation

public enum StackSharedTransition {

    /// The three shared modes. `move` is the default; `crossfade` is what reduced motion and an
    /// unrealised destination downgrade to; `clip` is for text that changes size, where scaling
    /// the glyphs would distort them.
    public static let modes: [String] = ["move", "crossfade", "clip"]

    /// `move` keeps the source snapshot for the whole flight and fades the destination in over
    /// the final third. Pinned so the three renderers hand off at the same instant.
    public static let handoffStart: Double = 2.0 / 3.0

    /// Accessibility focus moves to the DESTINATION frame at transition START, not end, so a
    /// VoiceOver user is never narrating a moving snapshot. A constant, because the law has no
    /// parameters and no opt-out.
    public static let a11yFocusTarget = "destination"
    public static let a11yFocusAt = "start"

    public struct Rect: Equatable {
        public let x: Double, y: Double, width: Double, height: Double
        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x; self.y = y; self.width = width; self.height = height
        }
    }

    /// One `shared=` element as the renderer measured it. `laid` is the renderer saying the node
    /// has been through a layout pass; nil `order`/`mode`/`anim` mean the author did not declare
    /// them, which is what makes "the destination declares, the source is the fallback"
    /// expressible.
    public struct Element {
        public let id: String
        public let frame: Rect
        public let radius: Double
        public let opacity: Double
        public let contentMode: String
        public let laid: Bool
        public let order: Int?
        public let mode: String?
        public let anim: String?

        public init(id: String, frame: Rect, radius: Double = 0, opacity: Double = 1,
                    contentMode: String = "fill", laid: Bool = true,
                    order: Int? = nil, mode: String? = nil, anim: String? = nil) {
            self.id = id; self.frame = frame; self.radius = radius; self.opacity = opacity
            self.contentMode = contentMode; self.laid = laid
            self.order = order; self.mode = mode; self.anim = anim
        }
    }

    /// One end of a pair, fully resolved — no optionals left for a renderer to guess at.
    public struct Geometry: Equatable {
        public let x: Double, y: Double, width: Double, height: Double
        public let radius: Double, opacity: Double
        public let contentMode: String
        public init(x: Double, y: Double, width: Double, height: Double,
                    radius: Double, opacity: Double, contentMode: String) {
            self.x = x; self.y = y; self.width = width; self.height = height
            self.radius = radius; self.opacity = opacity; self.contentMode = contentMode
        }
    }

    public struct Pair: Equatable {
        public let id: String
        public let order: Int
        public let mode: String
        /// the resolved curve word, or nil to inherit whatever the frame transition uses
        public let anim: String?
        /// true when the destination was not laid out: `to` copies `from`, the mode is crossfade
        public let deferred: Bool
        public let from: Geometry
        public let to: Geometry
    }

    public struct Match: Equatable {
        public let pairs: [Pair]
        /// ids the outgoing frame declared that nothing on the incoming frame answers
        public let unmatchedSource: [String]
        public let unmatchedDestination: [String]
        /// ids declared more than once within ONE frame — a lint error at author time, resolved
        /// to the first occurrence here so the runtime is deterministic, not platform-dependent
        public let duplicates: [String]
    }

    static func round6(_ value: Double) -> Double { (value * 1e6).rounded() / 1e6 + 0 }

    private static func geometry(_ element: Element) -> Geometry {
        Geometry(x: round6(element.frame.x), y: round6(element.frame.y),
                 width: round6(element.frame.width), height: round6(element.frame.height),
                 radius: round6(element.radius), opacity: round6(element.opacity),
                 contentMode: element.contentMode)
    }

    /// Has the destination actually been laid out? An explicit `laid: false` says no; so does a
    /// zero width or height, which is what a virtualised row reports before it is measured.
    private static func realised(_ element: Element) -> Bool {
        element.laid && element.frame.width > 0 && element.frame.height > 0
    }

    /// ONE inheritance rule for `sharedMode`, `sharedAnim` and `sharedOrder`: the arriving screen
    /// decides, the outgoing screen fills the gap, and the caller's floor is the last resort.
    private static func inherit<T>(_ destination: T?, _ source: T?, _ floor: T?) -> T? {
        destination ?? source ?? floor
    }

    /// First occurrence in document order wins; every id seen twice is reported.
    private static func indexSide(_ elements: [Element]) -> (first: [String: (Int, Element)],
                                                             duplicates: [String],
                                                             order: [String]) {
        var first: [String: (Int, Element)] = [:]
        var duplicates: [String] = []
        var order: [String] = []
        for (index, element) in elements.enumerated() {
            if first[element.id] != nil {
                if !duplicates.contains(element.id) { duplicates.append(element.id) }
                continue
            }
            first[element.id] = (index, element)
            order.append(element.id)
        }
        return (first, duplicates, order)
    }

    /// Pair the `shared` ids across the outgoing and incoming frames.
    ///
    /// Collect the ids on each side (first occurrence wins), intersect, order by `sharedOrder`
    /// then DESTINATION document order, and resolve each pair's mode/anim/geometry. Everything
    /// outside the intersection takes the ordinary frame transition — reported, never thrown.
    public static func match(source: [Element], destination: [Element],
                             reducedMotion: Bool = false, frameAnim: String? = nil) -> Match {
        let src = indexSide(source)
        let dst = indexSide(destination)

        var ordered: [(documentIndex: Int, pair: Pair)] = []
        for id in dst.order {
            guard let sourceEntry = src.first[id], let destinationEntry = dst.first[id] else { continue }
            let deferred = !realised(destinationEntry.1)
            let from = geometry(sourceEntry.1)
            let to = deferred ? from : geometry(destinationEntry.1)
            var mode = inherit(destinationEntry.1.mode, sourceEntry.1.mode, "move") ?? "move"
            if !modes.contains(mode) { mode = "move" }
            if deferred || reducedMotion { mode = "crossfade" }
            ordered.append((documentIndex: destinationEntry.0,
                            pair: Pair(id: id,
                                       order: inherit(destinationEntry.1.order, sourceEntry.1.order, 0) ?? 0,
                                       mode: mode,
                                       anim: inherit(destinationEntry.1.anim, sourceEntry.1.anim, frameAnim),
                                       deferred: deferred,
                                       from: from,
                                       to: to)))
        }
        ordered.sort { a, b in
            a.pair.order != b.pair.order ? a.pair.order < b.pair.order : a.documentIndex < b.documentIndex
        }
        let pairs = ordered.map { $0.pair }
        let paired = Set(pairs.map { $0.id })

        return Match(pairs: pairs,
                     unmatchedSource: src.order.filter { !paired.contains($0) },
                     unmatchedDestination: dst.order.filter { !paired.contains($0) },
                     duplicates: Array(Set(src.duplicates + dst.duplicates)).sorted())
    }

    /// The pair's state at one instant. `sourceOpacity`/`destinationOpacity` are the two
    /// snapshots' weights INSIDE the flying layer; `alpha` is the layer's own opacity.
    /// `scaleContent == false` is `clip`: the frame animates, the content does not stretch.
    public struct Sample: Equatable {
        public let x: Double, y: Double, width: Double, height: Double
        public let radius: Double, alpha: Double
        public let sourceOpacity: Double, destinationOpacity: Double
        public let contentMode: String
        public let scaleContent: Bool
    }

    static func clamp01(_ value: Double) -> Double {
        guard value > 0 else { return 0 }   // also catches NaN
        return value > 1 ? 1 : value
    }

    private static func lerp(_ a: Double, _ b: Double, _ p: Double) -> Double { a + (b - a) * p }

    /// Where the pair is at `progress` (0 = fully at the source, 1 = fully at the destination).
    /// Out-of-range progress clamps rather than overshooting — an interruption can hand this
    /// function a value past either end while a spring is still settling.
    public static func sample(_ pair: Pair, progress: Double) -> Sample {
        let p = clamp01(progress)
        let from = pair.from, to = pair.to
        let sourceOpacity = pair.mode == "move" ? 1 : 1 - p
        let destinationOpacity = pair.mode == "move" ? clamp01((p - handoffStart) * 3) : p
        return Sample(x: round6(lerp(from.x, to.x, p)),
                      y: round6(lerp(from.y, to.y, p)),
                      width: round6(lerp(from.width, to.width, p)),
                      height: round6(lerp(from.height, to.height, p)),
                      radius: round6(lerp(from.radius, to.radius, p)),
                      alpha: round6(lerp(from.opacity, to.opacity, p)),
                      sourceOpacity: round6(sourceOpacity),
                      destinationOpacity: round6(destinationOpacity),
                      // A discrete value cannot interpolate; it switches at the midpoint, where
                      // the aspect mismatch between the two content modes is smallest.
                      contentMode: p < 0.5 ? from.contentMode : to.contentMode,
                      scaleContent: pair.mode != "clip")
    }

    public enum State: String { case idle, running, interactive, settled }
    public enum Direction: String { case forward, reverse }
    public enum Outcome: String { case completed, reversed }

    public struct Snapshot: Equatable {
        public let state: State
        public let direction: Direction
        public let progress: Double
        public let target: Double
        /// the distance still to travel — a reversal costs what is LEFT, never a full replay
        public let remaining: Double
        public let outcome: Outcome?
    }
}

/// The interruption/reversal state machine — the one thing that separates a real shared-element
/// implementation from a demo.
///
/// `progress` is always measured toward the DESTINATION: 0 is the source frame, 1 the
/// destination, regardless of which way the transition is travelling. An interruption
/// (`interrupt`) adopts the transition AT ITS CURRENT PROGRESS and flips the direction; it never
/// restarts at 1 and never snaps to 0. The release then commits (target 0, the back-swipe won)
/// or cancels (target 1, the push resumes), and the settle travels only `remaining`.
///
/// Platform mapping: iOS drives this from a `UIPercentDrivenInteractiveTransition` against a
/// `UIViewPropertyAnimator` (a `UIView.animate` block cannot be reversed mid-flight, which is
/// exactly how an implementation ends up snapping); Android from the predictive-back progress
/// callbacks; web from the pointer stream against a paused WAAPI animation.
public final class SharedTransitionMachine {

    public private(set) var state: StackSharedTransition.State = .idle
    public private(set) var direction: StackSharedTransition.Direction = .forward
    public private(set) var progress: Double = 0
    public private(set) var target: Double = 1
    public private(set) var outcome: StackSharedTransition.Outcome?
    /// true once a gesture has taken this transition over — the renderer must keep its animator
    /// interruptible for the rest of the flight rather than restoring a fire-and-forget curve
    public private(set) var interrupted = false

    public init() {}

    public func snapshot() -> StackSharedTransition.Snapshot {
        StackSharedTransition.Snapshot(state: state,
                                       direction: direction,
                                       progress: StackSharedTransition.round6(progress),
                                       target: StackSharedTransition.round6(target),
                                       remaining: StackSharedTransition.round6(abs(target - progress)),
                                       outcome: outcome)
    }

    /// Start a push (`forward`, from the source) or a pop (`reverse`, from the destination).
    @discardableResult
    public func begin(_ direction: StackSharedTransition.Direction) -> StackSharedTransition.Snapshot {
        state = .running
        self.direction = direction
        progress = direction == .forward ? 0 : 1
        target = direction == .forward ? 1 : 0
        outcome = nil
        interrupted = false
        return snapshot()
    }

    /// The animator reporting where it is. Ignored while a gesture owns the transition.
    @discardableResult
    public func tick(_ progress: Double) -> StackSharedTransition.Snapshot {
        if state == .running { self.progress = StackSharedTransition.clamp01(progress) }
        return snapshot()
    }

    /// A gesture takes the transition over at `progress`. A settled transition is NOT resurrected.
    @discardableResult
    public func interrupt(at progress: Double) -> StackSharedTransition.Snapshot {
        if state == .running || state == .interactive {
            state = .interactive
            direction = .reverse
            self.progress = StackSharedTransition.clamp01(progress)
            target = 0
            interrupted = true
        }
        return snapshot()
    }

    /// The finger moving, as an ABSOLUTE progress (the renderer owns the pixels→progress map).
    @discardableResult
    public func drag(to progress: Double) -> StackSharedTransition.Snapshot {
        if state == .interactive { self.progress = StackSharedTransition.clamp01(progress) }
        return snapshot()
    }

    /// The finger lifting: commit the reversal, or cancel it and resume forward.
    @discardableResult
    public func release(commit: Bool) -> StackSharedTransition.Snapshot {
        if state == .interactive {
            direction = commit ? .reverse : .forward
            target = commit ? 0 : 1
            state = .running
        }
        return snapshot()
    }

    /// The animator reached its target.
    @discardableResult
    public func settle() -> StackSharedTransition.Snapshot {
        if state == .running {
            progress = target
            state = .settled
            outcome = target == 0 ? .reversed : .completed
        }
        return snapshot()
    }
}
