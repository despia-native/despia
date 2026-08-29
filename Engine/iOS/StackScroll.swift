//
//  StackScroll.swift — the `<scroll>` APPLE ADAPTER (U01). Every decision lives in the shared
//  core (ScrollLinked.swift, corpus OpenSource/Conformance/scroll/); this file is the UIKit and
//  SwiftUI plumbing and nothing else: finding the real `UIScrollView` behind SwiftUI's
//  `ScrollView`, observing it, publishing the `--scroll-*` plane, dispatching the coalesced
//  handlers, and standing up the imperative surface behind `ref=`.
//
//  WHY THIS IS ITS OWN FILE. `Stack.swift` and the Structure/Scroll component are shared by
//  every UI workstream, so the call site there is one line — `.modifier(StackScrollModifier(…))`
//  — and the four hundred lines live here.
//
//  WE DO NOT TAKE THE DELEGATE, AND THAT IS THE LOAD-BEARING DECISION. SwiftUI's `ScrollView`
//  installs its own `UIScrollViewDelegate` and drives layout, bouncing and the scroll-position
//  API through it. Assigning our own would silently break all three, and it is the classic
//  introspection bug: everything looks right until a `.scrollPosition` or a keyboard avoidance
//  stops working. So the observation is KVO on `contentOffset` plus the pan recogniser's own
//  state, which is additive: SwiftUI keeps its delegate and we keep our samples.
//
//  THE PUBLICATION IS UNCONDITIONAL AND THE DISPATCH IS NOT. `--scroll-*` is a style write on
//  every sample; `on:scroll` is gated on a bound handler and coalesced to the display link. That
//  split is the performance contract, and it is why a page with no scroll handler pays nothing
//  but a dictionary write.
//
import Foundation
import QuartzCore
import SwiftUI
import UIKit

// ---------------------------------------------------------------------------- the plane

/// The `--scroll-*` publication plane, main-thread confined.
///
/// A node publishes only its own axis (the core's rule), and a consumer resolves the properties
/// in scope by walking its scroll ancestors nearest-first. On the web the browser's own custom
/// property cascade does this for free; UIKit has no cascade, so the walk is explicit and the
/// corpus's `resolveLinkedScope` is the thing that answers.
@MainActor
public enum StackScrollPlane {

    private struct Published {
        var axis: String
        var properties: [String: String]
        /// The node's `ref`, empty when it has none.
        var ref: String
        /// The same plane under that name, and DOCUMENT-WIDE (R27): pinned chrome sits OVER a
        /// scroller and can never be a descendant, so no ancestor walk will ever reach it.
        var named: [String: String]
        /// Registration order. A Dictionary has none, and two nodes may carry one `ref` (the
        /// recycled-row case) - the ref registry gives the name to the LAST provider, so the
        /// merge has to happen in a known order rather than in whatever order hashing produced.
        var order: Int
    }

    private static var planes: [ObjectIdentifier: Published] = [:]
    private static var nextOrder = 0

    /// Publish one node's plane. Called from the observer's frame callback, never from the bus.
    public static func publish(
        _ owner: AnyObject,
        axis: String,
        properties: [String: String],
        ref: String = "",
        named: [String: String] = [:]
    ) {
        let key = ObjectIdentifier(owner)
        // The order is assigned once, at registration: a node that re-publishes every frame must
        // not keep overtaking its neighbours in the name race.
        let order = planes[key]?.order ?? {
            nextOrder += 1
            return nextOrder
        }()
        planes[key] = Published(axis: axis, properties: properties, ref: ref, named: named, order: order)
    }

    public static func withdraw(_ owner: AnyObject) {
        planes.removeValue(forKey: ObjectIdentifier(owner))
    }

    /// The properties in scope for `view`: its scroll ancestors nearest-first, plus EVERY named
    /// plane in the document. An element with no scroll ancestor at all still reads a named
    /// plane, which is the whole point of naming one.
    public static func scope(for view: UIView?) -> [String: String] {
        var ancestors: [ScrollLinkedAncestor] = []
        var node: UIView? = view
        while let current = node {
            if let plane = planes[ObjectIdentifier(current)] {
                ancestors.append(ScrollLinkedAncestor(axis: plane.axis, properties: plane.properties))
            }
            node = current.superview
        }
        let named = planes.values
            .filter { !$0.named.isEmpty }
            .sorted { $0.order < $1.order }
            .map { NamedScrollPlane(ref: $0.ref, properties: $0.named) }
        return ScrollCore.resolveLinkedScope(ancestors, named: named)
    }

    /// Fold one authored declaration against the plane in scope. Returns nil when the value is
    /// invalid at computed value, which is CSS's own answer and therefore ours: the declaration
    /// is DROPPED rather than shipped half-typed.
    public static func resolve(_ expression: String, for view: UIView?) -> String? {
        return ScrollCore.evaluateLinked(expression, properties: scope(for: view))
    }
}

// ---------------------------------------------------------------------------- the observer

/// One `<scroll>`'s presenter: config, samples, publication, dispatch, and the imperative verbs.
///
/// Held by the probe view that found the scroll view, so it dies with the element. The scroll
/// view itself is held WEAKLY — a presenter must never be the reason a detached screen stays in
/// memory.
@MainActor
public final class StackScrollObserver: NSObject {

    public let config: ScrollConfig
    private weak var scrollView: UIScrollView?
    private let dispatch: (String, [String: Any]) -> Void
    private let hasHandler: (String) -> Bool
    private let writeBind: ((String, [String: Any]) -> Void)?

    private var observation: NSKeyValueObservation?
    private var geometry: [NSKeyValueObservation] = []
    private var lastSample: ScrollSample?
    private var lastDirection: String?
    private var lastDispatchAt: Double?
    private var reachLatched = false
    private var settleWork: DispatchWorkItem?
    private var anchorBefore: Double?
    /// The node's `ref`. It names the plane this scroller publishes document-wide, so anything in
    /// the tree can read it - including the pinned chrome that is not a descendant.
    public let ref: String

    public init(
        scrollView: UIScrollView,
        config: ScrollConfig,
        ref: String = "",
        hasHandler: @escaping (String) -> Bool,
        dispatch: @escaping (String, [String: Any]) -> Void,
        writeBind: ((String, [String: Any]) -> Void)? = nil
    ) {
        self.scrollView = scrollView
        self.config = config
        self.ref = ref
        self.hasHandler = hasHandler
        self.dispatch = dispatch
        self.writeBind = writeBind
        super.init()
        apply(to: scrollView)
        // KVO, not the delegate: see the file header. `.initial` publishes the resting plane
        // before the first finger, so a header bound to --scroll-progress renders right at boot.
        observation = scrollView.observe(\.contentOffset, options: [.initial, .new]) { [weak self] view, _ in
            MainActor.assumeIsolated {
                guard let self = self else { return }
                // The `.initial` fire is the resting publish, not a scroll.
                let resting = self.lastSample == nil
                self.sample(view, settling: !resting)
            }
        }
        // GEOMETRY, not just offset. Half the plane is derived from content size -
        // `--scroll-progress` and `--scroll-remaining` both are - so the resting publish above
        // describes whatever layout had happened by init, which for a list that has not measured
        // yet is none of it. Without these two, nothing corrects it until the first finger, and a
        // bar bound to `remaining` boots saying the list has nowhere left to go.
        // SIZE changes only, never origin: a UIScrollView scrolls by mutating `bounds.origin`,
        // so an unfiltered bounds observer fires on every scrolled frame - a second sample per
        // frame with dx=0 and a dt of microseconds, which republished the plane with a zeroed
        // (or spiked) velocity right after the real one and fed an extra empty dispatch through
        // the coalescer. The offset is the contentOffset observer's job; these two exist for
        // GEOMETRY, and geometry is the size.
        geometry = [
            scrollView.observe(\.contentSize, options: [.old, .new]) { [weak self] view, change in
                MainActor.assumeIsolated {
                    guard change.oldValue != change.newValue else { return }
                    self?.sample(view, settling: false)
                }
            },
            scrollView.observe(\.bounds, options: [.old, .new]) { [weak self] view, change in
                MainActor.assumeIsolated {
                    guard change.oldValue?.size != change.newValue?.size else { return }
                    self?.sample(view, settling: false)
                }
            },
        ]
    }

    /// Torn down explicitly by `StackScroll.detach` rather than in `deinit`: an isolated stored
    /// property is not reachable from a nonisolated deinit, and an observation that outlives its
    /// element would keep sampling a view nobody is looking at.
    public func invalidate() {
        observation?.invalidate()
        observation = nil
        for observation in geometry { observation.invalidate() }
        geometry = []
        settleWork?.cancel()
        settleWork = nil
    }

    /// The declarative half of the attribute table, written onto the real scroll view. Every one
    /// of these is a property SwiftUI does not expose, which is why the introspection exists.
    private func apply(to view: UIScrollView) {
        view.showsVerticalScrollIndicator = config.indicators
        view.showsHorizontalScrollIndicator = config.indicators
        // TRISTATE: nil means the PLATFORM decides, so an unauthored `bounces` leaves iOS's own
        // rubber band exactly as it was. Collapsing that to `true` is how a framework quietly
        // overrides the platform on every scroll view in an app.
        if let bounces = config.bounces { view.bounces = bounces }
        view.isPagingEnabled = config.snap == "page"
        switch config.keyboardDismiss {
        case "none": view.keyboardDismissMode = .none
        case "onDrag": view.keyboardDismissMode = .onDrag
        default: view.keyboardDismissMode = .interactive
        }
        let inset = config.contentInset
        if inset.top != 0 || inset.right != 0 || inset.bottom != 0 || inset.left != 0 {
            view.contentInset = UIEdgeInsets(
                top: CGFloat(inset.top), left: CGFloat(inset.left),
                bottom: CGFloat(inset.bottom), right: CGFloat(inset.right)
            )
        }
        // `snap` to CHILD boundaries has no UIScrollView switch; it is applied at rest, in
        // `settle()`, off the real child frames — which is also the only way a rail of
        // variable-width cards can snap correctly.
    }

    /// The geometry the core reasons over.
    public func metrics(_ view: UIScrollView) -> ScrollMetrics {
        return ScrollCore.metrics(
            x: Double(view.contentOffset.x),
            y: Double(view.contentOffset.y),
            viewportWidth: Double(view.bounds.width),
            viewportHeight: Double(view.bounds.height),
            contentWidth: Double(view.contentSize.width),
            contentHeight: Double(view.contentSize.height)
        )
    }

    /// One sample. Publication first and always; dispatch second and only under the budget.
    /// `settling: false` publishes without arming the settle timer. Only a real SCROLL settles:
    /// the resting publish at mount is not one, and neither is content arriving underneath a
    /// still finger-free list - arming from either fires `on:scrollEnd`, and runs a snap, 120ms
    /// after a mount nobody touched. The web presenter draws the same line at the same place.
    public func sample(_ view: UIScrollView, settling: Bool = true) {
        let now = CACurrentMediaTime() * 1000.0
        let m = metrics(view)
        let next = ScrollSample(x: m.x, y: m.y, t: now)
        let motion: ScrollMotionState
        if let previous = lastSample {
            motion = ScrollCore.motion(previous: previous, next: next, previousDirection: lastDirection)
        } else {
            motion = ScrollMotionState(dx: 0, dy: 0, velocityX: 0, velocityY: 0, velocity: 0,
                                       direction: lastDirection ?? "none")
        }
        lastSample = next
        lastDirection = motion.direction

        StackScrollPlane.publish(
            view, axis: config.axis,
            properties: ScrollCore.linkedProperties(axis: config.axis, metrics: m, velocity: motion.velocity),
            ref: ref,
            named: ref.isEmpty ? [:] : ScrollCore.namedLinkedProperties(
                ref: ref, axis: config.axis, metrics: m, velocity: motion.velocity)
        )

        if let bind = config.bind, let write = writeBind {
            write(bind, ["x": m.x, "y": m.y])
        }

        if ScrollCore.shouldDispatch(hasHandler: hasHandler("scroll"),
                                     lastDispatchAt: lastDispatchAt, now: now) {
            lastDispatchAt = now
            dispatch("scroll", [
                "x": m.x, "y": m.y, "dx": motion.dx, "dy": motion.dy,
                "width": Double(view.bounds.width), "height": Double(view.bounds.height),
                "contentWidth": Double(view.contentSize.width),
                "contentHeight": Double(view.contentSize.height),
                "atTop": m.atTop, "atBottom": m.atBottom,
                "direction": motion.direction, "velocity": motion.velocity,
            ])
        }

        let reach = ScrollCore.reachEnd(latched: reachLatched, metrics: m,
                                        threshold: config.threshold, axis: config.axis)
        reachLatched = reach.latched
        if reach.fire, hasHandler("reachEnd") {
            dispatch("reachEnd", ["remaining": reach.remaining])
        }

        if settling { armSettle(view) }
    }

    /// iOS DOES have a real end-of-deceleration signal, but reading it needs the delegate we
    /// deliberately do not take. The pan recogniser plus a silence window is the additive twin:
    /// the recogniser says the finger is gone, and SETTLE_MS of no movement says momentum is
    /// spent. The window is the CORE's constant, so every renderer without a callback settles at
    /// the same moment.
    private func armSettle(_ view: UIScrollView) {
        settleWork?.cancel()
        let work = DispatchWorkItem { [weak self, weak view] in
            guard let self = self, let view = view else { return }
            MainActor.assumeIsolated {
                if view.panGestureRecognizer.state == .began || view.panGestureRecognizer.state == .changed {
                    return   // still under the finger: not settled, and re-armed by the next sample
                }
                self.settle(view)
            }
        }
        settleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + ScrollCore.settleMs / 1000.0, execute: work)
    }

    public func settle(_ view: UIScrollView) {
        let m = metrics(view)
        let horizontal = config.axis == "horizontal"
        // At rest the snap decision is the AT-REST one; feeding the last velocity would re-apply
        // a fling UIKit has already spent.
        if let target = ScrollCore.resolveSnap(
            mode: config.snap,
            offset: horizontal ? m.x : m.y,
            viewportLength: horizontal ? Double(view.bounds.width) : Double(view.bounds.height),
            contentLength: horizontal ? Double(view.contentSize.width) : Double(view.contentSize.height),
            children: childFrames(view),
            velocity: 0.0
        ), config.snap != "page" {
            // `page` is UIScrollView's own `isPagingEnabled`, already applied — snapping it again
            // here would fight the platform's animation.
            let point = CGPoint(x: horizontal ? CGFloat(target) : view.contentOffset.x,
                                y: horizontal ? view.contentOffset.y : CGFloat(target))
            if point != view.contentOffset { view.setContentOffset(point, animated: true) }
        }
        if hasHandler("scrollEnd") {
            dispatch("scrollEnd", ["x": m.x, "y": m.y, "atTop": m.atTop, "atBottom": m.atBottom])
        }
    }

    /// Child frames along the scrolling axis, for `snap` and `toElement`. A UIScrollView's real
    /// children are its content view's subviews when SwiftUI has wrapped them in one.
    public func childFrames(_ view: UIScrollView) -> [ScrollChildFrame] {
        let horizontal = config.axis == "horizontal"
        let container: UIView = view.subviews.count == 1 ? view.subviews[0] : view
        return container.subviews.map { child in
            horizontal
                ? ScrollChildFrame(start: Double(child.frame.minX), length: Double(child.frame.width))
                : ScrollChildFrame(start: Double(child.frame.minY), length: Double(child.frame.height))
        }
    }

    // ── maintainPosition ──────────────────────────────────────────────────────────

    /// Call BEFORE the mutation with a still-visible child, and again after. An anchor rather
    /// than a content-height delta is the whole design: a height diff cannot tell a prepend from
    /// an append, so compensating on it makes an appending chat jump exactly as badly.
    public func captureAnchor(_ child: UIView) {
        anchorBefore = config.axis == "horizontal" ? Double(child.frame.minX) : Double(child.frame.minY)
    }

    public func restoreAnchor(_ child: UIView) {
        guard config.maintainPosition, let before = anchorBefore, let view = scrollView else { return }
        anchorBefore = nil
        let horizontal = config.axis == "horizontal"
        let after = horizontal ? Double(child.frame.minX) : Double(child.frame.minY)
        let result = ScrollCore.maintainPosition(
            offset: horizontal ? Double(view.contentOffset.x) : Double(view.contentOffset.y),
            anchorBefore: before, anchorAfter: after,
            viewportLength: horizontal ? Double(view.bounds.width) : Double(view.bounds.height),
            contentLength: horizontal ? Double(view.contentSize.width) : Double(view.contentSize.height)
        )
        if result.delta == 0 { return }
        // NOT animated, and never on the next runloop turn: the compensation has to land in the
        // same layout pass as the insertion or the jump is visible, which is the entire point.
        view.setContentOffset(
            CGPoint(x: horizontal ? CGFloat(result.offset) : view.contentOffset.x,
                    y: horizontal ? view.contentOffset.y : CGFloat(result.offset)),
            animated: false
        )
    }

    // ── the imperative surface ────────────────────────────────────────────────────

    @discardableResult
    public func run(
        kind: String, toX: Double? = nil, toY: Double? = nil,
        child: ScrollChildFrame? = nil, align: String = "nearest", animated: Bool = true
    ) -> Bool {
        guard let view = scrollView else { return false }
        guard let target = ScrollCore.resolveCommand(
            kind: kind, metrics: metrics(view),
            viewportWidth: Double(view.bounds.width), viewportHeight: Double(view.bounds.height),
            axis: config.axis, animated: animated, toX: toX, toY: toY, child: child, align: align
        ) else { return false }
        view.setContentOffset(CGPoint(x: CGFloat(target.x), y: CGFloat(target.y)), animated: target.animated)
        return true
    }
}

// ---------------------------------------------------------------------------- the SwiftUI seam

/// `<scroll>`'s presenter, reached by name. The lookup is the ONE ref registry `ref=` publishes
/// into — `StackRef.resolve` — and never a second name table.
@MainActor
public enum StackScroll {

    private static var observers: [ObjectIdentifier: StackScrollObserver] = [:]

    static func attach(_ observer: StackScrollObserver, to view: UIScrollView) {
        observers[ObjectIdentifier(view)] = observer
    }

    static func detach(_ view: UIScrollView) {
        observers.removeValue(forKey: ObjectIdentifier(view))?.invalidate()
        StackScrollPlane.withdraw(view)
    }

    /// The enclosing `UIScrollView` of a published ref, or nil. A `ref=` on the `<scroll>` itself
    /// publishes the container; the scroll view is that view or one of its descendants.
    public static func scrollView(named name: String) -> UIScrollView? {
        guard let view = StackRef.resolve(name) else { return nil }
        if let scroll = view as? UIScrollView { return scroll }
        if let found = descendantScrollView(view) { return found }
        var node: UIView? = view.superview
        while let current = node {
            if let scroll = current as? UIScrollView { return scroll }
            node = current.superview
        }
        return nil
    }

    private static func descendantScrollView(_ view: UIView) -> UIScrollView? {
        for child in view.subviews {
            if let scroll = child as? UIScrollView { return scroll }
            if let found = descendantScrollView(child) { return found }
        }
        return nil
    }

    /// `dsx.scroll("feed")` — the named scroll view's presenter, or nil. The caller reports
    /// `StackRef.unknown` for nil; this returns the value, not an error envelope.
    public static func observer(named name: String) -> StackScrollObserver? {
        guard let view = scrollView(named: name) else { return nil }
        return observers[ObjectIdentifier(view)]
    }

    /// `dsx.scroll(name).toElement({ ref: … })`. The target frame is converted into the scroll
    /// view's own coordinate space, so a row nested in three stacks resolves as correctly as a
    /// direct child. A ref that is not published, or is published outside this scroll view,
    /// answers false — never a scroll to a guessed offset.
    @discardableResult
    public static func toElement(
        scroll: String, ref target: String, align: String = "nearest",
        animated: Bool = true, focus: Bool = false
    ) -> Bool {
        guard let observer = observer(named: scroll),
              let view = scrollView(named: scroll),
              let element = StackRef.resolve(target),
              element.isDescendant(of: view) else { return false }
        let container: UIView = view.subviews.count == 1 ? view.subviews[0] : view
        let frame = element.convert(element.bounds, to: container)
        let horizontal = observer.config.axis == "horizontal"
        let child = horizontal
            ? ScrollChildFrame(start: Double(frame.minX), length: Double(frame.width))
            : ScrollChildFrame(start: Double(frame.minY), length: Double(frame.height))
        let moved = observer.run(kind: "toElement", child: child, align: align, animated: animated)
        // Accessibility focus moves ONLY when the caller asks: a scroll is not a focus change,
        // and silently stealing focus is how a "jump to section" button breaks VoiceOver's place.
        if moved && focus {
            UIAccessibility.post(notification: .layoutChanged, argument: element)
        }
        return moved
    }
}

/// `.modifier(StackScrollModifier(attributes:hasHandler:dispatch:))` on the `<scroll>` element's
/// SwiftUI body. One line at the call site; the probe below does the finding and the observing.
public struct StackScrollModifier: ViewModifier {
    let attributes: [String: String?]
    let hasHandler: (String) -> Bool
    let dispatch: (String, [String: Any]) -> Void
    let writeBind: ((String, [String: Any]) -> Void)?

    public init(
        attributes: [String: String?],
        hasHandler: @escaping (String) -> Bool,
        dispatch: @escaping (String, [String: Any]) -> Void,
        writeBind: ((String, [String: Any]) -> Void)? = nil
    ) {
        self.attributes = attributes
        self.hasHandler = hasHandler
        self.dispatch = dispatch
        self.writeBind = writeBind
    }

    public func body(content: Content) -> some View {
        content.background(
            StackScrollProbe(attributes: attributes, hasHandler: hasHandler,
                             dispatch: dispatch, writeBind: writeBind)
                .allowsHitTesting(false)
                .frame(width: 0, height: 0)
        )
    }
}

/// The introspection probe: a zero-size transparent view that walks UP to the `UIScrollView`
/// SwiftUI built, then attaches the observer to it. The same trick `StackRef`'s probe uses,
/// which is why it is spelled the same way — one mechanism, two consumers.
private struct StackScrollProbe: UIViewRepresentable {
    let attributes: [String: String?]
    let hasHandler: (String) -> Bool
    let dispatch: (String, [String: Any]) -> Void
    let writeBind: ((String, [String: Any]) -> Void)?

    func makeUIView(context: UIViewRepresentableContext<Self>) -> StackScrollProbeView {
        let view = StackScrollProbeView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        view.configure(attributes: attributes, hasHandler: hasHandler, dispatch: dispatch, writeBind: writeBind)
        return view
    }

    func updateUIView(_ uiView: StackScrollProbeView, context: UIViewRepresentableContext<Self>) {
        uiView.configure(attributes: attributes, hasHandler: hasHandler, dispatch: dispatch, writeBind: writeBind)
        uiView.bind()
    }

    static func dismantleUIView(_ uiView: StackScrollProbeView, coordinator: ()) {
        uiView.unbind()
    }
}

final class StackScrollProbeView: UIView {
    private var attributes: [String: String?] = [:]
    private var hasHandler: (String) -> Bool = { _ in false }
    private var dispatch: (String, [String: Any]) -> Void = { _, _ in }
    private var writeBind: ((String, [String: Any]) -> Void)?
    private weak var bound: UIScrollView?

    func configure(
        attributes: [String: String?],
        hasHandler: @escaping (String) -> Bool,
        dispatch: @escaping (String, [String: Any]) -> Void,
        writeBind: ((String, [String: Any]) -> Void)?
    ) {
        self.attributes = attributes
        self.hasHandler = hasHandler
        self.dispatch = dispatch
        self.writeBind = writeBind
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { unbind() } else { bind() }
    }

    func bind() {
        guard bound == nil else { return }
        var node: UIView? = superview
        while let current = node {
            if let scroll = current as? UIScrollView {
                let observer = StackScrollObserver(
                    scrollView: scroll,
                    config: ScrollCore.parseConfig(attributes),
                    ref: ((attributes["ref"] ?? nil) ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                    hasHandler: hasHandler,
                    dispatch: dispatch,
                    writeBind: writeBind
                )
                StackScroll.attach(observer, to: scroll)
                bound = scroll
                return
            }
            node = current.superview
        }
    }

    func unbind() {
        guard let scroll = bound else { return }
        StackScroll.detach(scroll)
        bound = nil
    }
}
