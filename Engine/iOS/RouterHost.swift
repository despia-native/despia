//
//  RouterHost.swift — the KERNEL navigable surface (the app's host).
//
//  The app's root, mounted by DSXBoot. Renders the Router's back-stack (`global.nav.stack`) as a
//  native SwiftUI NavigationStack — each frame a screen in its OWN isolated store, so local state is
//  preserved while a screen is covered and freed when it's popped. Web or native is just frame
//  content: a frame's `view` tag picks the renderer (DSXWebView web / DSXView native / any component).
//
//  Navigation is state. The Router GROWS `nav.stack` (push) → this host pushes; a native back-swipe
//  SHRINKS the NavigationStack path → this host tells the Router to truncate to match. That is the
//  only host-driven change (every push goes through the Router), which keeps the binding trivial.
//  "Open a DSXView, open another" — on the native stack.
//
//  DSXBoot mounts this as the app's root. The behaviors a device/build confirms (there is no Swift
//  toolchain to check them statically): (1) `nav.stack` <-> path round-trips both ways (push + finger
//  back-swipe); (2) the web view (DSXWebView) renders as a frame, including a pushed one; (3) per-screen
//  @StateObject stores isolate and free through NavigationStack; (4) back-swipe works with the nav bar
//  hidden via toolbar(.hidden) — if a build shows the gesture disabled, apps still navigate back via
//  their own chrome (the route package's `pop` action), and the fix is a localized gesture shim, not a model change.
//

import SwiftUI
import UIKit

#if DEBUG
/// App-process timing for the deterministic router qualification fixture. XCTest's `tap()` and
/// accessibility queries include host-side synthesis/snapshot latency, so a wall clock in the test
/// process cannot measure the product's "gesture release → native destination interactive" budget.
/// This probe starts inside the real route verb (or at SwiftUI's accepted native-back path commit),
/// finishes at the
/// native transition coordinator's completion, and exposes only the resulting duration through an
/// accessibility element. It is compiled out of release builds and inert unless the explicit
/// router-stress fixture is active.
final class RouterUIQualificationProbe: ObservableObject {
    static let shared = RouterUIQualificationProbe()

    @Published private(set) var accessibilityReport =
        "router-timing-v1|state=idle|operation=none|elapsed_ms=0|sequence=0"
    @Published private(set) var visualSettleAccessibilityReport =
        "router-settle-v1|state=idle|operation=none|elapsed_ms=0|sequence=0"

    private struct Pending {
        let sequence: Int
        let operation: String
        let expectedFrame: Int?
        let started: CFTimeInterval
    }

    private var pending: Pending?
    private var visualSettlePending: Pending?
    private var sequence = 0
    private var fallbackDisplayLink: CADisplayLink?
    private var fallbackFramesRemaining = 0
    private var fallbackSequence = 0

    var enabled: Bool {
        let env = ProcessInfo.processInfo.environment
        return env["DSX_UI_TEST_MODE"] == "1"
            && env["DSX_UI_TEST_SURFACE"] == "router-stress"
    }

    func begin(operation: String, expectedFrame: Int) {
        guard enabled else { return }
        sequence += 1
        pending = Pending(
            sequence: sequence,
            operation: operation,
            expectedFrame: expectedFrame,
            started: CACurrentMediaTime()
        )
        visualSettlePending = pending
        accessibilityReport =
            "router-timing-v1|state=pending|operation=\(operation)|elapsed_ms=0|sequence=\(sequence)"
        visualSettleAccessibilityReport =
            "router-settle-v1|state=pending|operation=\(operation)|elapsed_ms=0|sequence=\(sequence)"
    }

    /// A pushed/replaced/reset frame reaches this marker from its real NavigationStack surface.
    /// Two app-owned display frames prove the new hierarchy has been committed and presented.
    /// XCUITest separately requires its native destination control to be hittable; waiting for
    /// UIKit's full animation-coordinator completion would measure decorative animation bookkeeping
    /// after that control is already interactive.
    func framePresented(_ frame: Int) {
        guard let pending, pending.expectedFrame == frame else { return }
        completeAfterTwoDisplayFrames(sequence: pending.sequence)
    }

    /// Keep the interactivity deadline and the visual-capture seam separate. A destination can
    /// expose a hittable native control after two display frames while NavigationStack is still
    /// drawing the outgoing frame. UIKit's appearance completion is the first point at which a
    /// golden may truthfully assert that no old-route pixels remain.
    ///
    /// `animated` is UIKit's own verdict on the appearance transition (the marker controller's
    /// forwarded appearance flag OR its transition coordinator's `isAnimated`). A wall clock
    /// cannot separate "slide removed" from "slide ran" on a saturated CI simulator: the animated
    /// settle is pinned near the slide duration while the no-animation settle is pure main-thread
    /// latency that scales with load. The reduced-motion gate asserts this flag instead.
    func frameVisuallySettled(_ frame: Int, animated: Bool) {
        guard let pending = visualSettlePending, pending.expectedFrame == frame else { return }
        let elapsedMs = max(0, (CACurrentMediaTime() - pending.started) * 1_000)
        visualSettleAccessibilityReport = String(
            format:
                "router-settle-v1|state=complete|operation=%@|elapsed_ms=%.3f|animated=%@|sequence=%d",
            pending.operation,
            elapsedMs,
            animated ? "true" : "false",
            pending.sequence
        )
        visualSettlePending = nil
    }

    /// SwiftUI commits NavigationStack's writable path only after accepting the system Back
    /// interaction. At that point the covered frame is already the selected destination; two
    /// app-owned display frames prove its hierarchy has been committed without relying on
    /// XCUIElement's host-side accessibility snapshot latency.
    func nativeBackPathCommitted(expectedFrame: Int) {
        guard enabled else { return }
        sequence += 1
        let token = sequence
        pending = Pending(
            sequence: token,
            operation: "back",
            expectedFrame: expectedFrame,
            started: CACurrentMediaTime()
        )
        visualSettlePending = pending
        accessibilityReport =
            "router-timing-v1|state=pending|operation=back|elapsed_ms=0|sequence=\(token)"
        visualSettleAccessibilityReport =
            "router-settle-v1|state=pending|operation=back|elapsed_ms=0|sequence=\(token)"
        completeAfterTwoDisplayFrames(sequence: token)
    }

    private func completeAfterTwoDisplayFrames(sequence: Int) {
        guard pending?.sequence == sequence else { return }
        guard fallbackDisplayLink == nil || fallbackSequence != sequence else { return }
        fallbackDisplayLink?.invalidate()
        fallbackSequence = sequence
        fallbackFramesRemaining = 2
        let link = CADisplayLink(target: self, selector: #selector(fallbackDisplayTick))
        fallbackDisplayLink = link
        link.add(to: .main, forMode: .common)
    }

    @objc private func fallbackDisplayTick() {
        fallbackFramesRemaining -= 1
        guard fallbackFramesRemaining <= 0 else { return }
        fallbackDisplayLink?.invalidate()
        fallbackDisplayLink = nil
        let sequence = fallbackSequence
        fallbackSequence = 0
        complete(sequence: sequence)
    }

    private func complete(sequence: Int) {
        guard let pending, pending.sequence == sequence else { return }
        let elapsedMs = max(0, (CACurrentMediaTime() - pending.started) * 1_000)
        accessibilityReport = String(
            format:
                "router-timing-v1|state=complete|operation=%@|elapsed_ms=%.3f|sequence=%d",
            pending.operation,
            elapsedMs,
            pending.sequence
        )
        self.pending = nil
    }
}
#endif

/// One stack frame, keyed by a stable id so SwiftUI keeps each screen's surface across re-renders
/// (and treats a remapped id as a new screen). Identity IS the id.
struct NavFrame: Hashable, Identifiable {
    let id: Int
    let view: String, src: String, path: String, origin: String

    init?(_ d: [String: Any]) {
        guard let raw = d["id"], let id = NavFrame.intId(raw) else { return nil }
        self.id = id
        // Frames always carry `view` (the Router resolves it — boot winner for view-less
        // rows); an absent one renders nothing rather than resurrecting a kernel default.
        view = (d["view"] as? String) ?? ""
        src = (d["src"] as? String) ?? ""
        path = (d["path"] as? String) ?? "/"
        origin = (d["origin"] as? String) ?? ""
    }
    private init(id: Int, view: String, src: String, path: String, origin: String) {
        self.id = id; self.view = view; self.src = src; self.path = path; self.origin = origin
    }

    /// The empty-stack / pre-boot screen — the root PLAN's first candidate (`entry.fallback`
    /// is the derived alias of `entry.surfaces[0]`, root-plan.md). Data-driven; an app with
    /// no plan derives an empty view and the boot diagnostic owns that state.
    static var fallback: NavFrame {
        let f = AppManifest.entry.fallback
        return NavFrame(id: 0, view: f.view, src: f.src, path: "/", origin: f.origin)
    }

    static func == (a: NavFrame, b: NavFrame) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
    static func intId(_ v: Any) -> Int? { (v as? Int) ?? (v as? Double).map(Int.init) }
}

/// One PRESENTED modal — the observable twin of a pushed `NavFrame`. Read from `global.nav.modal`
/// (which the Router owns), keyed by the same stable id. `mode` picks how the host renders it:
/// `cover` → a full-screen modal (`.fullScreenCover`); `overlay` → the state-backed overlay LAYER
/// (`ModalOverlayLayer`, no UIKit presentation); anything else (`sheet`) → a drawer (`.sheet`).
/// Identity IS the id, so SwiftUI keeps the held surface across re-renders.
struct ModalEntry: Identifiable, Hashable {
    let id: Int
    let mode: String
    let detents: [String]
    /// overlay-only (present.json): "block" = the FULL overlay (every touch stops at the
    /// layer); anything else = passthrough (only drawn content hit-tests — the default).
    let touch: String

    init?(_ d: [String: Any]) {
        guard let raw = d["id"], let id = NavFrame.intId(raw) else { return nil }
        self.id = id
        mode = (d["as"] as? String) ?? "sheet"
        detents = (d["detents"] as? [String]) ?? []
        touch = (d["touch"] as? String) ?? "passthrough"
    }
    var isCover: Bool { mode == "cover" }
    var isOverlay: Bool { mode == "overlay" }
    var isBlockingOverlay: Bool { isOverlay && touch == "block" }
    static func == (a: ModalEntry, b: ModalEntry) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

/// Renders one presented modal — the HELD surface registered for this id (its own store/handlers),
/// the modal twin of `ScreenFrame`. Applies the resting detents for a drawer sheet (iOS 16+). A freed
/// surface (already released) renders transparent, never the white system background.
///
/// A modal-over-modal (present B while A is up) is presented from WITHIN this surface — each level
/// re-presents the NEXT-deeper `global.nav.modal` entry via its own `.sheet` / `.fullScreenCover`. That
/// chains modals through the presentation hierarchy (a sheet presents the next sheet), instead of asking
/// ONE root modifier to swap a live item identity non-nil→non-nil — which SwiftUI does not do reliably,
/// the desync that would let `resolve` report "opened" while nothing appears. Observes `DSX.state` so a
/// new/removed deeper modal re-renders this level and (dis)presents its child.
private struct ModalFrame: View {
    let entry: ModalEntry
    let depth: Int
    @ObservedObject private var global = DSX.state
    var body: some View {
        Group {
            if let surface = StackSurface.modalFrames[entry.id] {
                surface.frameView
            } else {
                Color.clear
            }
        }
        .modifier(ModalDetents(entry: entry))
        .sheet(item: modalItemBinding(at: depth + 1, cover: false)) { ModalFrame(entry: $0, depth: depth + 1) }
        .fullScreenCover(item: modalItemBinding(at: depth + 1, cover: true)) { ModalFrame(entry: $0, depth: depth + 1) }
    }
}

/// The presented CHAIN entry (sheet / cover) at `index`, read straight off `global.nav.modal` in one
/// allocation-free pass. OVERLAY entries are NOT part of the chain — they render in the
/// `ModalOverlayLayer`, never as a UIKit presentation — so chain positions SKIP them: presenting or
/// dismissing an overlay can never shift which entry a live `.sheet`/`.fullScreenCover` binding sees.
private func chainEntry(at index: Int, in raw: [[String: Any]]) -> ModalEntry? {
    var k = 0
    for d in raw {
        guard let e = ModalEntry(d), !e.isOverlay else { continue }
        if k == index { return e }
        k += 1
    }
    return nil
}

/// Item binding for the presented chain modal at `index`, but only when it matches the requested
/// container kind (`cover` vs drawer) — so exactly ONE of the two presentation modifiers at a level is
/// ever active. Setting it nil reports an interactive dismissal (swipe / tap-away) to the Router —
/// keyed by the entry's IDENTITY and guarded on the model still holding it, so the report is
/// IDEMPOTENT: SwiftUI also writes nil back after a PROGRAMMATIC dismissal completes (and a cascade
/// tears down several presentations at once, each writing nil); an unconditional "pop the top" here
/// would over-pop unrelated modals. `global.nav.modal` stays the single source of truth.
private func modalItemBinding(at index: Int, cover: Bool) -> Binding<ModalEntry?> {
    Binding(
        get: {
            let raw = (DSX.state.getPath("nav.modal") as? [[String: Any]]) ?? []
            guard let e = chainEntry(at: index, in: raw) else { return nil }
            return e.isCover == cover ? e : nil
        },
        set: { newVal in
            guard newVal == nil else { return }
            let raw = (DSX.state.getPath("nav.modal") as? [[String: Any]]) ?? []
            guard let e = chainEntry(at: index, in: raw), e.isCover == cover else { return }
            Router.shared?.hostDismissedModal(id: e.id)
        })
}

/// The state-backed OVERLAY layer (`present(as: "overlay")`): every overlay entry renders here,
/// stacked in presentation order OVER the current screen. No UIKit presentation is involved, so an
/// overlay can never silently fail — it exists exactly while its `global.nav.modal` entry does, and
/// `dismiss` removes it by pure state. TOUCH MODES (present.json): "passthrough" (default) —
/// transparent regions pass touches through (SwiftUI hit-tests rendered content, not frames), so a
/// glass bar / HUD keeps the page behind it live — the state-backed twin of
/// `mount(as: .overlay(edge))`; "block" — the FULL overlay: a clear, full-area hit-test shape
/// renders UNDER the surface so every touch stops at this layer (the lock-screen shape) while the
/// overlay itself can stay visually transparent. Chain modals (sheet / cover) present in the
/// window ABOVE this layer, so they cover overlays regardless of presentation order — the PLANES
/// contract (a drawer always covers a menu bar).
private struct ModalOverlayLayer: View {
    @ObservedObject private var global = DSX.state
    var body: some View {
        ZStack {
            ForEach(((global.getPath("nav.modal") as? [[String: Any]]) ?? [])
                        .compactMap(ModalEntry.init)
                        .filter { $0.isOverlay }) { e in
                if let surface = StackSurface.modalFrames[e.id] {
                    if e.isBlockingOverlay {
                        ZStack {
                            Color.clear.contentShape(Rectangle()).onTapGesture {}
                            surface.frameView
                        }
                    } else {
                        surface.frameView
                    }
                }
            }
        }
    }
}

/// Resting detents for a drawer sheet — `half` → `.medium`, `full` → `.large`, `content`
/// approximated to `.medium`; default a single `.large` stop (a presented component screen is
/// usually full-height). A `cover` gets no detents (it's full-screen). iOS 16+ only.
private struct ModalDetents: ViewModifier {
    let entry: ModalEntry
    @ViewBuilder func body(content: Content) -> some View {
        if !entry.isCover, #available(iOS 16.0, *) {
            content.presentationDetents(Self.detents(entry.detents))
        } else {
            content
        }
    }
    @available(iOS 16.0, *)
    private static func detents(_ tokens: [String]) -> Set<PresentationDetent> {
        var out: Set<PresentationDetent> = []
        for t in tokens {
            switch t {
            case "full":    out.insert(.large)
            case "half":    out.insert(.medium)
            case "content": out.insert(.medium)
            default:        break
            }
        }
        return out.isEmpty ? [.large] : out
    }
}

/// One screen's isolated DSX surface — its own store + env, alive (via @StateObject) exactly while
/// the frame is in the stack. NavigationStack frees it on pop; covered screens keep their state.
private final class FrameSurface: ObservableObject {
    let store = StackStore()
    let env: JSERunner
    private let frameId: Int
    init(frameId: Int) {
        self.frameId = frameId
        store.frameId = frameId   // frame-scoped package calls (route.chrome targeting) — see StackStore.frameId
        env = JSERunner(store: store, webView: nil, scope: nil, dsx: nil)
    }
    /// FRAME TEARDOWN — the readiness reporter's `release`. Deliberately here and NOT in
    /// `onDisappear`: SwiftUI calls `onDisappear` on a frame that is merely COVERED (a push, a
    /// presented sheet), and releasing there would drop a live screen's record and re-run its whole
    /// `viewStart`/`viewFinish` cycle on the way back — a phantom `screen.loading` on every pop.
    /// A `@StateObject` is destroyed only when the frame is permanently gone, which is exactly the
    /// event the corpus means. Hopped to main because deinit runs on whichever queue drops the last
    /// reference, and the record table is main-thread-only.
    deinit {
        let id = frameId
        DispatchQueue.main.async { DSXScreenReadiness.release(id) }
    }
}

/// Renders one frame as `<node tag="{{view}}" src=… path=… origin=…/>` in its own surface — the same
/// dynamic resolution a single route used, now one per stacked screen (DSXView native / DSXWebView web).
/// A NATIVE frame (a module pushed a component via `StackSurface.push`) instead renders the HELD
/// surface registered for this frame id — its own store/handlers, hosted as a route so it gets the
/// real push transition + interactive edge-swipe-back, with the web view live underneath.
private struct ScreenFrame: View {
    let frame: NavFrame
    @StateObject private var surface: FrameSurface
    @ObservedObject private var global = DSX.state
    init(frame: NavFrame) {
        self.frame = frame
        _surface = StateObject(wrappedValue: FrameSurface(frameId: frame.id))
    }
    var body: some View {
        // ROUTE-hosted rendering (`canvas: true` / `routeCanvas: true`): a page root that
        // declares a `background` gets it as the full-bleed HOST canvas behind the screen —
        // the nav-title region and top/bottom overscroll stop flashing systemBackground white
        // over a grouped-gray page (StackRootView.hostCanvasSpec, the canvas-seam fix). A page
        // with no root background renders byte-for-byte as before.
        Group {
            if let pushed = StackSurface.pushedFrames[frame.id] {
                pushed.frameView(canvas: true)                     // module-pushed component surface (its own store/handlers)
            } else if frame.view == "__native" {
                Color.clear                                        // native frame whose surface was already freed — transparent (reveals the destination), NEVER the white system background that flashes mid-pop
            } else {
                StackRootView(root: StackNode(tag: frame.view,
                                              attrs: ["src": frame.src, "path": frame.path, "origin": frame.origin],
                                              children: []),
                              store: surface.store,
                              env: surface.env,
                              routeCanvas: true)
            }
        }
        .modifier(FrameChrome(spec: chromeSpec))   // REAL system nav bar when the screen claims it (nav.chrome), hidden otherwise
        #if DEBUG
        .background(RouterUIQualificationTransitionMarker(frame: frame.id))
        #endif
        // NATIVE READINESS (Conformance/lifecycle/readiness.json). This is the frame-render seam:
        // the surface reports, the shell decides. Three inputs in ONE ordered place —
        //   • `mount` tags the frame's surface off its `view`, so a DSXWebView frame is DROPPED by the
        //     machine and the web relay's dom* stays the only web reporter (no double-report);
        //   • `manual` reads the root's `settle=` opt-in, recorded during the first render pass
        //     (StackHead.hoist / DSXView) which SwiftUI runs strictly BEFORE onAppear;
        //   • `rendered` is hopped to the next main-queue turn — the ordering obligation the corpus
        //     cannot express: it MUST land after the pass that registered `manual`, or every
        //     deferred screen would settle while still blank.
        // All three are idempotent, so the onAppear SwiftUI re-fires when a covered screen
        // resurfaces mid-back-swipe changes nothing. `release` is FrameSurface's deinit.
        .onAppear {
            // Surface kind by REGISTRATION, never by name (root-plan.md §capability):
            // web-surface owners register their tags (DSXScreenReadiness.webSurfaceTags).
            DSXScreenReadiness.mount(frame: frame.id, path: frame.path,
                                     surface: DSXScreenReadiness.webSurfaceTags.contains(frame.view) ? "web" : "native")
            if declaresManualSettle { DSXScreenReadiness.manual(frame.id) }
            // HYBRID ORDERING (readiness.json rule 9): a NATIVE frame that mounted a <DSXWebView/>
            // child gates its settle on that page. Read at the same seam as `manual` and for the
            // same reason — the component ran during the render pass this onAppear follows.
            if hostsWebSurface { DSXScreenReadiness.hostsWeb(frame.id) }
            DispatchQueue.main.async { DSXScreenReadiness.rendered(frame.id) }
        }
    }
    /// Did this frame mount the app's `<DSXWebView/>` web surface? Read off the same store the
    /// component wrote during its first render pass (module-pushed frames carry their own).
    private var hostsWebSurface: Bool {
        if let pushed = StackSurface.pushedFrames[frame.id] { return pushed.store.hostsWebSurface }
        return surface.store.hostsWebSurface
    }
    /// Did this frame's root opt into reporting readiness itself? A module-pushed frame carries its
    /// own held surface (hoisted at construction); a route frame's root is the `view` tag, resolved
    /// through component references — and a remote `<DSXView/>` sets the same flag on this frame's
    /// store while it loads (it renders a ProgressView first, so it must never settle on render).
    private var declaresManualSettle: Bool {
        if let pushed = StackSurface.pushedFrames[frame.id] { return pushed.store.settleManual }
        if surface.store.settleManual { return true }
        return StackHead.declaresManualSettle(StackNode(tag: frame.view, attrs: [:], children: []),
                                              scope: nil)
    }
    /// This frame's system-chrome claim (`global.nav.chrome[id]`, written by the Router's
    /// `chrome` action). Nil = the DSX screen owns its own chrome — bar hidden, the default.
    private var chromeSpec: [String: Any]? {
        (global.getPath("nav.chrome") as? [String: Any])?["\(frame.id)"] as? [String: Any]
    }
}

/// Applies the REAL navigation bar for a frame that claimed system chrome: the system title
/// (inline or large), the system back button (the NavigationStack provides it — pop/back-swipe
/// already round-trip through the path binding), and on iOS 26 the system's Liquid Glass bar
/// with scroll-edge behavior — for free, because it IS the system bar. No claim → the bar stays
/// hidden and DSX markup draws its own chrome (the previous behavior, unchanged).
private struct FrameChrome: ViewModifier {
    let spec: [String: Any]?
    func body(content: Content) -> some View {
        // An empty-title claim renders NO bar: on iOS 26 `.navigationTitle("") +
        // .toolbar(.visible)` draws an empty Liquid Glass title platter at the top —
        // a claim without a title is treated as no claim (fail-open, Article 7).
        if let spec, !((spec["title"] as? String ?? "").isEmpty) {
            content
                .navigationTitle((spec["title"] as? String) ?? "")
                .navigationBarTitleDisplayMode(((spec["large"] as? Bool) ?? false) ? .large : .inline)
                .toolbar(.visible, for: .navigationBar)
        } else {
            content
                .toolbar(.hidden, for: .navigationBar)   // DSX screens own their chrome — no system nav bar
        }
    }
}

/// Re-enables the interactive edge-swipe-back when the system nav bar is HIDDEN. Every DSX route hides
/// it (`toolbar(.hidden)` on each ScreenFrame), and UIKit DISABLES `interactivePopGestureRecognizer`
/// by default while the bar is hidden — so the finger back-swipe stops working and a route can only be
/// popped via on-screen chrome. This probe walks up to the NavigationStack's `UINavigationController`
/// and installs a permissive delegate that re-enables the gesture whenever there's a screen to pop
/// (depth > 1, never at the root). The swipe still drives SwiftUI's own pop → the path binding →
/// `Router.hostTruncate`, so nothing about the navigation model changes — this is the "localized gesture
/// shim" the host note anticipated, nothing more. Added as a `.background` of the stack root, so its
/// host controller is a child of the nav controller.
private struct InteractivePopEnabler: UIViewControllerRepresentable {
    // NOTE: spell out SwiftUI's context type — the bare `Context` resolves to the engine's own
    // `Context` class (OpenSource/Engine/iOS/Context.swift, the DSX bus handle), which shadows
    // `UIViewControllerRepresentableContext` in this module and breaks the protocol conformance.
    func makeUIViewController(context: UIViewControllerRepresentableContext<InteractivePopEnabler>) -> PopEnablerController { PopEnablerController() }
    func updateUIViewController(_ controller: PopEnablerController, context: UIViewControllerRepresentableContext<InteractivePopEnabler>) { controller.enable() }
}

/// The invisible child controller that re-enables (and gates) the nav controller's interactive pop. It
/// is the gesture delegate ITSELF — retained by living in the controller hierarchy, so the weak
/// `interactivePopGestureRecognizer.delegate` stays valid without a SwiftUI Coordinator (the controller
/// owns the delegate, so there's no Coordinator/`context` to thread through `make`/`update` — which also
/// sidesteps the `Context` name collision noted on the representable above).
private final class PopEnablerController: UIViewController, UIGestureRecognizerDelegate {
    override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); enable() }
    override func didMove(toParent parent: UIViewController?) { super.didMove(toParent: parent); enable() }

    func enable() {
        guard let nav = navigationController else { return }
        guard let gesture = nav.interactivePopGestureRecognizer else { return }
        gesture.delegate = self   // override UIKit's hidden-bar disable
        gesture.isEnabled = true
    }

    // Begin only when there's something to pop — at the root the swipe must NOT fire (else it traps the
    // nav controller in a half-popped state). This is the entire policy: re-enable, but not at root —
    // UNLESS a full-screen native surface has claimed the edge (a game engine consuming lane/dodge
    // swipes); then the back-swipe would steal its touches, so the surface exits via its own control.
    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        if DSXNavGestures.suppressInteractivePop { return false }
        guard let nav = navigationController else { return false }
        // Never begin while a push/pop TRANSITION is in flight. UIKit's own delegate refuses
        // this and the permissive shim must keep that guard: an interactive pop started
        // mid-transition corrupts the nav controller (overlapping half-slid screens, a stuck
        // bar — exactly the "half-navigated" jank a fast swipe right after a row tap
        // reproduces). The swipe simply doesn't arm for the ~0.35s a transition runs.
        if nav.transitionCoordinator != nil { return false }
        return nav.viewControllers.count > 1
    }

    // Restore the SYSTEM precedence the delegate override dropped: UIKit's own
    // nav delegate makes every other pan REQUIRE the edge-pop to fail first, so
    // an edge swipe pops even when the finger lands on horizontally-pannable
    // content (a scroll rail, list swipe-actions, the web view's scroll). A
    // delegate that only implements shouldBegin loses that rule — the content
    // pan wins the edge touch and the back-swipe goes dead there. Center drags
    // are unaffected: the edge-pop fails instantly away from the edge.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        other is UIPanGestureRecognizer
    }
}

/// A generic kernel switch a full-screen native surface flips while it owns on-screen gestures, so
/// the interactive back-swipe (`InteractivePopEnabler`) stands down and the surface's own touches
/// (a game engine's lane/dodge swipes) aren't stolen at the screen edge. The surface RE-ARMS it on
/// disappear; the kernel names no module. Main-thread only (UI lifecycle).
public enum DSXNavGestures {
    public static var suppressInteractivePop = false
}

/// The kernel host. A NavigationStack over `global.nav.stack`: frame 0 is the root, the rest are the
/// pushed path. Bound to the Router's stack, so a JS/native `route.push` and a finger back-swipe both
/// flow through the same state.
struct RouterHost: View {
    @ObservedObject private var global = DSX.state
    #if DEBUG
    @ObservedObject private var routerUIQualification = RouterUIQualificationProbe.shared
    #endif

    private var frames: [NavFrame] {
        ((global.getPath("nav.stack") as? [[String: Any]]) ?? []).compactMap(NavFrame.init)
    }

    var body: some View {
        let root = frames.first ?? .fallback
        NavigationStack(path: pathBinding) {
            ScreenFrame(frame: root)
                .id(root.id)                                       // a new root id (reset) → fresh surface
                .background(InteractivePopEnabler())               // re-enable finger back-swipe (DSX routes hide the nav bar, which disables it)
                .navigationDestination(for: NavFrame.self) { ScreenFrame(frame: $0) }
        }
        .modifier(DSXScreenMetrics())                              // publish global.screen.* (dsx.screen)
        // NavigationStack remains the native host. This transaction only removes its motion when
        // the real system accessibility value requests it (or the explicit DEBUG fixture mirrors
        // that request); it does not substitute a custom transition.
        .modifier(RouterReducedMotionTransaction())
        .overlay { LoadingIndicator(showing: (global.getPath("ui.loading") as? Bool) ?? false) }
        // THE BOOT DIAGNOSTIC (root-plan.md §9) — kernel-owned pixels, deliberately NOT a
        // component: it must survive a broken component system and never re-privilege a
        // surface. Renders only when the root plan is EXHAUSTED (`global.root.exhausted`,
        // published by the fold): test channels see the attempt ledger, production sees a
        // neutral line + Retry (re-runs the plan once per tap via the kernel Router).
        .overlay { BootDiagnostic(ledger: (global.getPath("root.exhausted") as? [[String: Any]]) ?? []) }
        // STATE-BACKED modals — three containers, one source of truth (`global.nav.modal`):
        //   • overlays render in the layer below (pure state, no UIKit presentation);
        //   • the first CHAIN entry (sheet / cover) presents here; each presented ModalFrame
        //     re-presents the next-deeper chain entry from within itself, so a modal-over-modal
        //     chains through the presentation hierarchy (never a live item-identity swap).
        // The item bindings' nil-set reports an interactive swipe-away to the Router by entry
        // IDENTITY (idempotent — see modalItemBinding), so SwiftUI never dismisses behind the
        // model's back. `dsx.component.present`/`dismiss` (and the web / native twins) flow through
        // here; no fire-and-forget UIKit present.
        .overlay { ModalOverlayLayer() }
        .sheet(item: modalItemBinding(at: 0, cover: false)) { ModalFrame(entry: $0, depth: 0) }
        .fullScreenCover(item: modalItemBinding(at: 0, cover: true)) { ModalFrame(entry: $0, depth: 0) }
        #if DEBUG
        // One nearly invisible QA-only accessibility node carries the app-process measurement to
        // XCUITest. It never ships in Release and cannot appear outside the explicit fixture.
        .overlay(alignment: .topLeading) {
            if routerUIQualification.enabled {
                VStack(spacing: 0) {
                    Text(routerUIQualification.accessibilityReport)
                        .accessibilityIdentifier("dsx.router.timing")
                    Text(routerUIQualification.visualSettleAccessibilityReport)
                        .accessibilityIdentifier("dsx.router.settle")
                }
                .font(.system(size: 1))
                .lineLimit(1)
                .frame(width: 1, height: 2)
                .opacity(0.01)
            }
        }
        #endif
    }

    /// The pushed frames (everything after the root). GROWN by the Router (push) → NavigationStack
    /// pushes; TRUNCATED by a back-swipe → tell the Router to match. Truncation is the only
    /// host-driven change — pushes always originate in the Router — so the setter stays a one-liner.
    private var pathBinding: Binding<[NavFrame]> {
        Binding(get: { Array(self.frames.dropFirst()) },
                set: { path in
                    #if DEBUG
                    let destinationFrame = path.last?.id ?? self.frames.first?.id ?? 0
                    RouterUIQualificationProbe.shared.nativeBackPathCommitted(
                        expectedFrame: destinationFrame
                    )
                    #endif
                    Router.shared?.hostTruncate(toDepth: path.count + 1)   // +1 for the root frame
                })
    }
}

private struct RouterReducedMotionTransaction: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var systemReducedMotion

    private var qualificationReducedMotion: Bool {
        #if DEBUG
        return RouterUIQualificationProbe.shared.enabled
            && UserDefaults.standard.bool(forKey: "UIAccessibilityReduceMotionEnabled")
        #else
        return false
        #endif
    }

    func body(content: Content) -> some View {
        content.transaction { transaction in
            if systemReducedMotion || qualificationReducedMotion {
                transaction.animation = nil
                transaction.disablesAnimations = true
            }
        }
    }
}

#if DEBUG
/// A child of each real NavigationStack frame. The controller lifecycle exposes UIKit's transition
/// coordinator, which is the authoritative moment a native push/replace/reset becomes interactive.
private struct RouterUIQualificationTransitionMarker: UIViewControllerRepresentable {
    let frame: Int

    func makeUIViewController(
        context: UIViewControllerRepresentableContext<RouterUIQualificationTransitionMarker>
    ) -> RouterUIQualificationTransitionController {
        RouterUIQualificationTransitionController(frame: frame)
    }

    func updateUIViewController(
        _ controller: RouterUIQualificationTransitionController,
        context: UIViewControllerRepresentableContext<RouterUIQualificationTransitionMarker>
    ) {
        controller.frame = frame
        controller.reportPresentationIfNeeded()
    }
}

private final class RouterUIQualificationTransitionController: UIViewController {
    var frame: Int
    /// UIKit's animation verdict for the in-flight appearance, captured while the transition
    /// coordinator still exists (it is gone by `viewDidAppear`). Fresh-assigned per appearance.
    private var appearanceWasAnimated = false

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
        appearanceWasAnimated = animated || (transitionCoordinator?.isAnimated ?? false)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        reportPresentationIfNeeded()
        RouterUIQualificationProbe.shared.frameVisuallySettled(
            frame,
            animated: appearanceWasAnimated || animated
        )
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        reportPresentationIfNeeded()
    }

    func reportPresentationIfNeeded() {
        guard viewIfLoaded?.window != nil else { return }
        RouterUIQualificationProbe.shared.framePresented(frame)
    }
}
#endif

/// The root-plan EXHAUSTION diagnostic (root-plan.md §9) — the floor beneath the plan.
/// Kernel-owned pixels, never a component and never a surface: rendering it must not
/// re-privilege any renderer, and it must survive a broken component system. Test
/// channels (`AppEnvironment.isTest`) show the full attempt ledger; production shows a
/// neutral line. Retry re-runs the plan once per tap through the kernel Router.
private struct BootDiagnostic: View {
    let ledger: [[String: Any]]

    var body: some View {
        if !ledger.isEmpty {
            VStack(spacing: 12) {
                if AppEnvironment.current.isTest {
                    Text("Root plan exhausted").font(.headline.monospaced())
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(ledger.enumerated()), id: \.offset) { _, row in
                            Text("\((row["index"] as? Int) ?? 0)  \((row["id"] as? String) ?? "?")  \((row["code"] as? String) ?? "?")  \(Double((row["elapsedMs"] as? Int) ?? 0) / 1000, specifier: "%.1f")s")
                                .font(.caption.monospaced())
                        }
                    }
                    Text("Plan: App.json entry.surfaces · details in dsx.errors")
                        .font(.caption2).foregroundStyle(.secondary)
                } else {
                    Text("Something went wrong").font(.headline)
                }
                Button("Retry") { Router.shared?.retryRootPlan() }
                    .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(uiColor: .systemBackground))
        }
    }
}
