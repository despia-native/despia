//
//  RouterSharedElements.swift — the iOS half of U03 shared element transitions
//  (parity/U03-shared-transitions.md). The DECISIONS live in the platform-neutral core
//  (StackSharedTransition.swift, corpus OpenSource/Conformance/router/shared.json); this file
//  is the UIKit/SwiftUI plumbing: measure the `shared=` nodes each frame declares, snapshot the
//  pair, fly it in a container above the router host, and let the interactive back-swipe take
//  that flight over mid-air.
//
//  WHY A SNAPSHOT LAYER AND A DISPLAY LINK, NOT `matchedGeometryEffect`. The acceptance test is
//  INTERRUPTION: a back-swipe that starts at 40% of a push must reverse from 40%, not snap.
//  `matchedGeometryEffect` hands the whole animation to SwiftUI, whose progress a gesture
//  cannot address; `UIView.animate` cannot be reversed mid-flight either. A snapshot flown by a
//  CADisplayLink against the shared machine can be driven from any source — the link, or the
//  finger — which is the same reason the web twin runs a FLIP rather than a View Transition.
//
//  THE REGISTRY IS THE SEAM. Elements report themselves through one `.modifier(...)` call in
//  the render tree (Stack.swift), keyed by frame id; the router asks the registry for the two
//  sides at the moment a transition starts. Nothing in Stack.swift knows what a transition is,
//  and nothing here knows what an `<image>` is.
//
import Foundation
import SwiftUI
import UIKit

/// The coordinate space every shared rect is measured in — the router host's own, so a frame's
/// geometry means the same thing whether it is pushed, presented or merely covered.
let dsxSharedSpace = "dsx.shared.space"

/// Every `shared=` node the render trees have measured, keyed by frame. Main-actor: it is
/// written from the layout pass and read from the transition, both on the main thread.
///
/// It is also the HIDE plane: while a pair is flying, its real nodes render at zero opacity so
/// the eye sees exactly one of each element. Publishing that as observable state keeps the
/// render tree declarative — nothing reaches into a view to mutate it.
final class SharedElementRegistry: ObservableObject {

    static let shared = SharedElementRegistry()

    struct Node {
        let element: StackSharedTransition.Element
        /// document order within its frame — the core's tie-break after `sharedOrder`
        let sequence: Int
    }

    private var nodes: [Int: [String: Node]] = [:]
    private var sequence: [Int: Int] = [:]
    /// (frame, id) pairs currently flying, so their real nodes stay invisible
    @Published private(set) var hidden: Set<String> = []

    private init() {}

    private static func key(_ frame: Int, _ id: String) -> String { "\(frame)\u{1}\(id)" }

    /// Record (or re-record, on re-layout) one node. Idempotent per (frame, id): a re-measure
    /// keeps the node's original document position, so a resize cannot reorder the pairs.
    func record(frame: Int, id: String, rect: CGRect, radius: CGFloat, opacity: Double,
                contentMode: String, order: Int?, mode: String?, anim: String?) {
        guard !id.isEmpty else { return }
        var frameNodes = nodes[frame] ?? [:]
        let position = frameNodes[id]?.sequence ?? {
            let next = sequence[frame] ?? 0
            sequence[frame] = next + 1
            return next
        }()
        frameNodes[id] = Node(
            element: StackSharedTransition.Element(
                id: id,
                frame: StackSharedTransition.Rect(x: Double(rect.origin.x), y: Double(rect.origin.y),
                                                  width: Double(rect.width), height: Double(rect.height)),
                radius: Double(radius),
                opacity: opacity,
                contentMode: contentMode,
                // A node the layout pass has not resolved reports an empty rect. Passed through
                // honestly so the core applies the unrealised-destination rule instead of
                // animating into nothing (the collapsing-image bug).
                laid: rect.width > 0 && rect.height > 0,
                order: order, mode: mode, anim: anim),
            sequence: position)
        nodes[frame] = frameNodes
    }

    /// This frame's shared nodes in DOCUMENT order — what the core's matcher expects.
    func elements(frame: Int) -> [StackSharedTransition.Element] {
        (nodes[frame] ?? [:]).values.sorted { $0.sequence < $1.sequence }.map { $0.element }
    }

    /// The frame is permanently gone (the `FrameSurface.deinit` seam) — drop its measurements.
    func release(frame: Int) {
        nodes[frame] = nil
        sequence[frame] = nil
        hidden = hidden.filter { !$0.hasPrefix("\(frame)\u{1}") }
    }

    func isHidden(frame: Int, id: String) -> Bool { hidden.contains(Self.key(frame, id)) }

    func setFlying(_ flying: Bool, frame: Int, ids: [String]) {
        let keys = ids.map { Self.key(frame, $0) }
        if flying { hidden.formUnion(keys) } else { hidden.subtract(keys) }
    }
}

/// The one-line call site Stack.swift applies to every element: a node that declares `shared`
/// measures itself into the registry and disappears while its pair is in the air. A node
/// WITHOUT the attribute costs one dictionary lookup and renders byte-identically.
struct SharedElementProbe: ViewModifier {
    let attrs: [String: String]
    let frameId: Int?
    @ObservedObject private var registry = SharedElementRegistry.shared

    private var id: String? {
        guard let raw = attrs["shared"]?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        return raw
    }

    func body(content: Content) -> some View {
        if let id, let frameId {
            content
                .opacity(registry.isHidden(frame: frameId, id: id) ? 0 : 1)
                .background(
                    GeometryReader { geo -> Color in
                        let box = geo.frame(in: .named(dsxSharedSpace))
                        DispatchQueue.main.async {
                            registry.record(frame: frameId, id: id, rect: box,
                                            radius: CGFloat(Double(attrs["radius"] ?? "") ?? 0),
                                            opacity: Double(attrs["opacity"] ?? "") ?? 1,
                                            contentMode: attrs["fit"] ?? attrs["contentMode"] ?? "fill",
                                            order: attrs["sharedOrder"].flatMap { Int($0) },
                                            mode: attrs["sharedMode"],
                                            anim: attrs["sharedAnim"])
                        }
                        return Color.clear
                    })
        } else {
            content
        }
    }
}

/// The UIKit container the pairs fly in — one transparent, non-interactive view pinned over the
/// router host. It is a plain `UIView` on purpose: the flight sets frames and opacities sixty
/// times a second, which is the one thing SwiftUI's diffing is the wrong tool for.
final class SharedFlightContainer: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
}

struct SharedFlightHost: UIViewRepresentable {
    func makeUIView(context: UIViewRepresentableContext<Self>) -> SharedFlightContainer {
        let view = SharedFlightContainer()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        SharedFlightDriver.shared.attach(view)
        return view
    }
    func updateUIView(_ uiView: SharedFlightContainer, context: UIViewRepresentableContext<Self>) {
        SharedFlightDriver.shared.attach(uiView)
    }
}

/// The UIKit seam. A SwiftUI `NavigationStack` owns its own push/pop, and the ONLY place its
/// INTERACTIVE pop is observable is the hosting controller's transition coordinator — which is
/// why this marker exists at all. `viewWillAppear` catches an arriving frame's push,
/// `viewWillDisappear` a leaving frame's pop, and in both cases `coordinator.isInteractive` tells
/// the driver whether a finger is already on it.
struct SharedTransitionMarker: UIViewControllerRepresentable {
    let frame: Int
    func makeUIViewController(context: UIViewControllerRepresentableContext<Self>) -> SharedTransitionMarkerController {
        SharedTransitionMarkerController(frame: frame)
    }
    func updateUIViewController(_ controller: SharedTransitionMarkerController, context: UIViewControllerRepresentableContext<Self>) {
        controller.frame = frame
    }
}

final class SharedTransitionMarkerController: UIViewController {
    var frame: Int

    init(frame: Int) {
        self.frame = frame
        super.init(nibName: nil, bundle: nil)
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if let coordinator = transitionCoordinator {
            SharedFlightDriver.shared.startExpected(coordinator: coordinator, at: frame)
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if let coordinator = transitionCoordinator {
            SharedFlightDriver.shared.startExpected(coordinator: coordinator, at: frame)
        }
    }
}

/// One flight at a time, because one transition is in the air at a time. The driver owns the
/// machine, the display link and the snapshot layers; the router only ever tells it that a
/// transition started, that a finger took it over, and that the finger let go.
@MainActor
final class SharedFlightDriver {

    static let shared = SharedFlightDriver()

    private final class Flown {
        let pair: StackSharedTransition.Pair
        let layer: UIView
        let source: UIView?
        var destination: UIView?
        init(pair: StackSharedTransition.Pair, layer: UIView, source: UIView?) {
            self.pair = pair; self.layer = layer; self.source = source
        }
    }

    private weak var container: SharedFlightContainer?
    private var machine = SharedTransitionMachine()
    private var flown: [Flown] = []
    private var link: CADisplayLink?
    private var startedAt: CFTimeInterval = 0
    private var startProgress: Double = 0
    private var span: CFTimeInterval = 0
    private var duration: CFTimeInterval = 0.35
    private var destinationFrame: Int?
    private var sourceFrame: Int?

    /// What the Router said the next transition would be. Set at the publish, consumed by the
    /// marker when UIKit hands over its transition coordinator — the Router owns frame identity,
    /// UIKit owns the timing, and neither has to learn the other's job.
    private var expectation: (source: Int, destination: Int,
                              direction: StackSharedTransition.Direction, reducedMotion: Bool)?
    /// the interactive pop's coordinator while a finger owns it
    private weak var interactiveCoordinator: UIViewControllerTransitionCoordinator?

    private init() {}

    func attach(_ view: SharedFlightContainer) { container = view }

    /// The Router announcing a transition it just published. Cheap and idempotent — a transition
    /// with nothing shared simply never starts.
    func expect(source: Int?, destination: Int?, direction: StackSharedTransition.Direction,
                reducedMotion: Bool) {
        guard let source, let destination, source != destination else { expectation = nil; return }
        expectation = (source, destination, direction, reducedMotion)
    }

    /// UIKit handing over the live transition. Starts the announced flight and, when a finger is
    /// already driving (an interactive back-swipe), hands the flight straight to it: the machine
    /// goes interactive at the coordinator's own progress, so nothing restarts and nothing snaps.
    func startExpected(coordinator: UIViewControllerTransitionCoordinator, at frame: Int) {
        guard let expectation, expectation.source == frame || expectation.destination == frame else { return }
        self.expectation = nil
        guard begin(source: expectation.source, destination: expectation.destination,
                    direction: expectation.direction, reducedMotion: expectation.reducedMotion) else { return }
        guard coordinator.isInteractive else {
            coordinator.animate(alongsideTransition: nil) { [weak self] context in
                // A non-interactive transition UIKit itself cancelled must not leave the pair
                // stranded at the destination.
                if context.isCancelled { self?.release(commit: false) }
            }
            return
        }
        interactiveCoordinator = coordinator
        interrupt()
        driveInteractively()
        coordinator.notifyWhenInteractionChanges { [weak self] context in
            guard let self else { return }
            self.interactiveCoordinator = nil
            self.stopLink()
            // isCancelled on an interactive POP means the finger let go short of the threshold,
            // so the push it interrupted resumes — `cancel`, not `commit`.
            self.release(commit: !context.isCancelled)
        }
    }

    /// Sample the coordinator's own `percentComplete` each frame. `percentComplete` counts toward
    /// the POP's destination (the revealed screen), which is progress 0 on the shared axis.
    private func driveInteractively() {
        stopLink()
        let link = CADisplayLink(target: self, selector: #selector(sampleInteractive))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func sampleInteractive() {
        guard let coordinator = interactiveCoordinator else { stopLink(); return }
        drag(to: 1 - Double(coordinator.percentComplete))
    }

    /// Is a non-interactive flight still in the air? The back-swipe asks before adopting one.
    var isRunning: Bool { machine.state == .running && !flown.isEmpty }

    /// Start a flight between two frames. Returns false when nothing paired (or the host is not
    /// mounted), and the caller then runs the ordinary frame transition untouched — the
    /// unmatched law: never an error, never a flash.
    @discardableResult
    func begin(source: Int, destination: Int, direction: StackSharedTransition.Direction,
               reducedMotion: Bool, frameAnim: String? = nil) -> Bool {
        finish()
        guard let container, container.bounds.width > 0 else { return false }
        let match = StackSharedTransition.match(
            source: SharedElementRegistry.shared.elements(frame: source),
            destination: SharedElementRegistry.shared.elements(frame: destination),
            reducedMotion: reducedMotion,
            frameAnim: frameAnim)
        if !match.duplicates.isEmpty {
            // A lint error at author time; the core already picked the first occurrence, so the
            // transition is correct — say so once rather than failing the navigation.
            kernelLog("[Router] duplicate shared id(s) in one frame: \(match.duplicates.joined(separator: ", "))")
        }
        guard !match.pairs.isEmpty else { return false }

        sourceFrame = source
        destinationFrame = destination
        for pair in match.pairs {
            let layer = UIView()
            layer.isUserInteractionEnabled = false
            layer.clipsToBounds = true
            container.addSubview(layer)                       // `sharedOrder` IS the z-order,
            let rect = CGRect(x: pair.from.x, y: pair.from.y,  // and the core already sorted them
                              width: pair.from.width, height: pair.from.height)
            let snapshot = container.superview?.resizableSnapshotView(from: rect, afterScreenUpdates: false,
                                                                      withCapInsets: .zero)
            snapshot?.isUserInteractionEnabled = false
            if let snapshot { layer.addSubview(snapshot) }
            flown.append(Flown(pair: pair, layer: layer, source: snapshot))
        }
        SharedElementRegistry.shared.setFlying(true, frame: source, ids: match.pairs.map { $0.id })
        SharedElementRegistry.shared.setFlying(true, frame: destination, ids: match.pairs.map { $0.id })

        machine = SharedTransitionMachine()
        paint(machine.begin(direction).progress)
        run()
        return true
    }

    /// A gesture takes the flight over WHERE IT IS. The whole acceptance test: nothing restarts,
    /// nothing snaps — the finger inherits the pose the animation had reached.
    @discardableResult
    func interrupt() -> Double {
        stopLink()
        let snapshot = machine.interrupt(at: machine.progress)
        paint(snapshot.progress)
        return snapshot.progress
    }

    /// The finger moving, as an absolute progress toward the destination.
    func drag(to progress: Double) { paint(machine.drag(to: progress).progress) }

    /// The finger lifting: commit the reversal, or cancel it and resume forward.
    func release(commit: Bool) {
        machine.release(commit: commit)
        run()
    }

    /// Tear the flight down and give the real nodes their opacity back. Idempotent.
    func finish() {
        stopLink()
        guard !flown.isEmpty else { return }
        let ids = flown.map { $0.pair.id }
        for entry in flown { entry.layer.removeFromSuperview() }
        flown = []
        if let sourceFrame { SharedElementRegistry.shared.setFlying(false, frame: sourceFrame, ids: ids) }
        if let destinationFrame { SharedElementRegistry.shared.setFlying(false, frame: destinationFrame, ids: ids) }
        sourceFrame = nil
        destinationFrame = nil
    }

    /// The router's frame teardown seam — a frame that is gone can hold no measurements.
    func release(frame: Int) {
        if sourceFrame == frame || destinationFrame == frame { finish() }
        SharedElementRegistry.shared.release(frame: frame)
    }

    // MARK: - the drive

    private func run() {
        stopLink()
        let snapshot = machine.snapshot()
        guard snapshot.state == .running else { return }
        startProgress = snapshot.progress
        // A reversal costs what is LEFT, never a full replay — the corpus's `remaining`.
        span = max(0.001, duration * snapshot.remaining)
        startedAt = CACurrentMediaTime()
        let link = CADisplayLink(target: self, selector: #selector(step))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    private func stopLink() {
        link?.invalidate()
        link = nil
    }

    @objc private func step() {
        guard machine.state == .running else { stopLink(); return }
        let elapsed = CACurrentMediaTime() - startedAt
        let t = min(1, elapsed / span)
        // easeOutCubic: the "arrive gently" shape the rest of the router's motion uses.
        let eased = 1 - pow(1 - t, 3)
        let target = machine.snapshot().target
        paint(machine.tick(startProgress + (target - startProgress) * eased).progress)
        if t >= 1 {
            machine.settle()
            finish()
        }
    }

    private func paint(_ progress: Double) {
        for entry in flown {
            let s = StackSharedTransition.sample(entry.pair, progress: progress)
            entry.layer.frame = CGRect(x: s.x, y: s.y, width: s.width, height: s.height)
            entry.layer.layer.cornerRadius = s.radius
            entry.layer.alpha = s.alpha
            entry.source?.alpha = s.sourceOpacity
            // `clip` is the mode for text that changes size: the frame animates, the glyphs do
            // not stretch with it, so the content keeps its natural box and the layer clips it.
            if let source = entry.source {
                source.frame = s.scaleContent
                    ? entry.layer.bounds
                    : CGRect(origin: .zero, size: CGSize(width: entry.pair.from.width,
                                                         height: entry.pair.from.height))
            }
            if s.destinationOpacity > 0 { attachDestination(entry) }
            entry.destination?.alpha = s.destinationOpacity
            entry.destination?.frame = entry.layer.bounds
        }
    }

    /// The destination snapshot is captured LAZILY, the first instant it would be visible: at
    /// the moment a push starts, the destination screen has not rendered yet, so a snapshot
    /// taken then would be blank. A deferred pair never reaches here (its schedule keeps the
    /// destination at zero), which is exactly the unrealised-destination rule in pixels.
    private func attachDestination(_ entry: Flown) {
        guard entry.destination == nil, !entry.pair.deferred, let container else { return }
        let rect = CGRect(x: entry.pair.to.x, y: entry.pair.to.y,
                          width: entry.pair.to.width, height: entry.pair.to.height)
        guard let snapshot = container.superview?.resizableSnapshotView(from: rect,
                                                                        afterScreenUpdates: false,
                                                                        withCapInsets: .zero) else { return }
        snapshot.isUserInteractionEnabled = false
        snapshot.alpha = 0
        entry.layer.addSubview(snapshot)
        entry.destination = snapshot
    }
}
