//
//  DSXScreen.swift — reactive window metrics → global.screen.*  (read as dsx.screen.*)
//
//  Publishes the app window's size + size class to global state, REACTIVELY (on every layout /
//  rotation / size-class change), so responsive markup is just the expression layer — no new
//  primitive:
//      visible-if="dsx.screen.width > 768"           visible-if="dsx.screen.sizeClass == 'regular'"
//      columns="{{ dsx.screen.width > 900 ? 3 : 1 }}"  padding="{{ dsx.screen.breakpoint == 'sm' ? 8 : 24 }}"
//  `global.screen.*` is plain reactive state, so `visible-if` / `{{ }}` re-evaluate live
//  (StackNodeView observes DSX.state). Attached at the app root (RouterHost), measured by a
//  hierarchy-bound, interaction-hidden UIKit probe reading its own UIWindow bounds; RouterHost
//  stays full-window behind any sheet, so metrics reflect the local app window (not keyboard-reduced
//  SwiftUI content, the physical display, a process-global key window, or a presented sub-surface).
//
//  Cross-platform by construction: the keys are renderer-neutral — the Android renderer fills the
//  same `screen.*` from WindowMetrics / calculateWindowSizeClass / Configuration, so identical
//  `dsx.screen.*` markup works on both.
//

import SwiftUI
import UIKit

struct DSXScreenMetrics: ViewModifier {
    @Environment(\.horizontalSizeClass) private var hClass
    func body(content: Content) -> some View {
        content.background(
            DSXWindowMetricsProbe(
                sizeClass: hClass == .regular ? "regular" : "compact",
                publish: publish
            )
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        )
    }
    private func publish(_ metrics: DSXWindowMetricsProbe.Metrics) {
        let size = metrics.size
        let w = Double(size.width), h = Double(size.height)
        guard w > 0, h > 0 else { return }
        // Run RENDER-SAFE — NEVER mutate observed state inside the layout pass that drove this
        // callback. The hierarchy probe reports from UIKit layout/update callbacks; writing
        // to the globally-observed DSX.state synchronously is "Publishing changes from within view
        // updates" — undefined behavior. In a DEBUG build SwiftUI only logs the warning (the app limps
        // on / stalls on the splash); in a RELEASE build it corrupts the AttributeGraph and the next
        // platform view created in the SAME pass (the web view, DSXWebView → DomWebHost, a
        // UIViewControllerRepresentable) traps — EXC_BREAKPOINT in swift_unknownObjectRetain (a PAC
        // auth failure on a freed/garbage graph node). That is the TestFlight-only launch crash.
        // `afterRender` (the same render-safe hop a <watch> uses) moves the publish to the next tick,
        // OUT of the update; screen.* is reactive, so a one-tick delay is invisible.
        JSE.afterRender {
            // MERGE the metric keys into `screen` — never REPLACE the whole object. The shell's
            // Lifecycle coordinator publishes here too (`screen.phase` / `screen.ready`); a flat
            // `setPath("screen", […])` would wipe those on every rotation/resize. Overlaying keeps
            // both concerns alive under one namespace, so `dsx.screen.ready` and `dsx.screen.width` coexist.
            var screen = (DSX.state.getPath("screen") as? [String: Any]) ?? [:]
            screen["width"]       = w
            screen["height"]      = h
            screen["sizeClass"]   = metrics.sizeClass
            screen["orientation"] = w >= h ? "landscape" : "portrait"
            screen["breakpoint"]  = Self.breakpoint(w)
            DSX.state.setPath("screen", screen)
        }
    }
    /// Named breakpoints from width in points: sm < 480 ≤ md < 768 ≤ lg < 1024 ≤ xl.
    static func breakpoint(_ w: Double) -> String {
        switch w {
        case ..<480:  return "sm"
        case ..<768:  return "md"
        case ..<1024: return "lg"
        default:      return "xl"
        }
    }
}

/// The NATIVE screen-readiness reporter — the native sibling of the web surface's private
/// `surface.domStart` / `surface.domFinish` relay fires, and the thing that makes "web-optional native runtime"
/// TRUE at runtime instead of only structurally. Before this, only the web surface reported, so a
/// host-less native app never fired `screen.ready` (no page ever loaded) and every consumer of the
/// unified vocabulary — Splash's reveal, ScreenShield, Engagement, PostHog's route tracking — sat
/// waiting forever.
///
/// NINE INPUTS, ONE FUNNEL. The call sites never decide when to fire; this machine does, which IS
/// the once-per-frame guarantee:
///
///     mount(frame:path:surface:)   a native frame entered the stack        → `surface.viewStart`
///     manual(_:)                   its root declared `settle="manual"`     → (defers the settle)
///     hostsWeb(_:)                 it mounted a <DSXWebView/> web surface      → (defers the settle)
///     rendered(_:)                 its FIRST render pass completed         → `surface.viewFinish` (auto)
///     settled(_:)                  it reported readiness itself            → `surface.viewFinish`
///     deadline(_:)                 its bounded settle deadline elapsed     → `surface.viewFinish` (fail-open)
///     release(_:)                  the frame left the stack                → (drops the record)
///     webStart()                   the app web surface began loading       → (re-arms the gate)
///     webSettled()                 the app web surface settled             → `surface.viewFinish` (gated frames)
///
/// THE LAW (corpus `OpenSource/Conformance/lifecycle/readiness.json`, 38 rows):
///  1. only a NATIVE frame is tracked — a `mount` whose surface is not `"native"` is ignored, so a
///     `DSXWebView` frame never double-reports alongside the relay's `dom*`;
///  2. `mount` fires `surface.viewStart` exactly once per frame INSTANCE and is idempotent while the record
///     lives (SwiftUI re-fires `onAppear` when a covered screen resurfaces);
///  3. DEFAULT is auto — the frame settles on its first completed render pass;
///  4. OPT-IN is manual — a root declaring `settle="manual"` makes `rendered` emit nothing;
///  5. a frame settles AT MOST ONCE — later `rendered`/`settled`/`manual`/`hostsWeb`/`deadline`
///     inputs are no-ops;
///  6. an explicit `settled` always WINS: it settles an auto frame early and clears a pending
///     `manual` AND a pending `hostsWeb` gate;
///  7. a frame RELEASED before it settled never settles — no late `surface.viewFinish` after the screen is
///     gone, and a re-`mount` of the same id is a fresh instance;
///  8. an input for an unknown/released frame is a silent no-op (Article 7, fail-open);
///  9. HYBRID ORDERING — a native frame HOSTING a `<DSXWebView/>` app web surface must not report
///     settled while that surface is still blank, or Splash reveals over an empty web view and the
///     page's own `surface.domStart` re-opens the phase a beat later (the pre-#22 behavior was correct and
///     this restores it). `hostsWeb` gates the frame, the surface's own `webSettled()` releases it,
///     and NOTHING here is author-opt-in — `<DSXWebView/>` registers the gate itself. `webSettled`
///     LATCHES: a frame mounted while the page is already up never waits for a load that will not
///     come, and `webStart` re-arms it. A frame that also declared `manual` keeps its own
///     ownership, so `webSettled` skips it;
/// 10. BOUNDED FALLBACK (Article 7) — every tracked frame carries a settle DEADLINE
///     (`settleDeadlineMs`), armed by THIS machine at `mount` and cancelled on settle/release. When
///     it elapses the frame settles anyway, so a `settle="manual"` screen that never calls
///     `dsx.screen.settled()` — or a hosted page that never loads — degrades to a late reveal
///     instead of a PERMANENT `loading` phase (which, on a hybrid app, would also freeze the WEB
///     surface's consumers, since there is ONE shared phase). The lint (`lint_dsx.rb`) catches the
///     authoring mistake at build time; this catches everything else at runtime.
///
/// There is deliberately NO `viewFail`: a native frame ALWAYS settles (first render, or its own
/// `dsx.screen.settled()`), so there is no "terminated without finishing" case — `surface.domFail` exists
/// only because a WKWebView navigation can die mid-flight. A native screen's failure is a value on
/// the ERROR plane (`dsx.error`), never a lifecycle phase.
///
/// The emitted payload is `{ path, surface: "native", frame }` — the relay's `{ url, surface }`
/// shape with `path` because a native frame carries a route path, not a URL. Translation into the
/// unified `screen.loading` / `screen.ready` vocabulary is the Lifecycle coordinator's job
/// (corpus `lifecycle/phase.json`); this type publishes NO state and knows no consumer.
///
/// MAIN-THREAD ONLY (every input is a UI-lifecycle seam: `onAppear`, a render pass, a store deinit,
/// a JSE statement) — so the record table needs no lock.
enum DSXScreenReadiness {
    /// THE BOUNDED FALLBACK (readiness.json `settleDeadlineMs`, rule 10). Corpus-pinned and
    /// IDENTICAL on all three renderers (TS `SETTLE_DEADLINE_MS`, Kotlin `SETTLE_DEADLINE_MS`).
    static let settleDeadlineMs = 10_000
    static var settleDeadlineSeconds: Double { Double(settleDeadlineMs) / 1000 }

    private struct Record {
        let path: String?
        var manual = false
        var hostsWeb = false
        var settled = false
        var cancelDeadline: (() -> Void)?
    }
    /// One record per LIVE frame id (the Router's `nav.stack` id). Absent = not tracked.
    private static var records: [Int: Record] = [:]

    /// Has the app web surface settled since its last start? A LATCH, not a counter (rule 9).
    private static var webIsSettled = false

    /// The shipping deadline timer — main-queue, cancellable, kept as a named value so a test can
    /// restore it verbatim.
    static let defaultScheduleDeadline: (Double, @escaping () -> Void) -> (() -> Void) = { seconds, fire in
        let work = DispatchWorkItem(block: fire)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
        return { work.cancel() }
    }

    /// The deadline timer seam — swapped by the conformance runner (which drives the `deadline`
    /// input directly) and by any host that owns its own clock. Returns the canceller.
    static var scheduleDeadline: (Double, @escaping () -> Void) -> (() -> Void) = defaultScheduleDeadline

    /// The WEB-SURFACE TAG REGISTRY — the seam that retired the host's hard-coded
    /// `view == "DSXWebView"` readiness ternary (root-plan.md §capability). A module whose
    /// component hosts a web surface registers ITS OWN tag at setup (Dom does), and the
    /// host derives `surface = "web" | "native"` by membership: the kernel and the host
    /// name nobody, and a future surface kind registers itself the same way.
    static var webSurfaceTags: Set<String> = []

    /// The ROOT-PLAN handshake (root-plan.md): while a boot-plan attempt is live, ITS frame's
    /// bounded settle deadline is suspended — the candidate's own `timeoutMs` is the bounded
    /// fail-open, and a forced fail-open "ready" here would defeat any longer surface fallback.
    /// The Router sets this per mount and clears it on `root.ready` / exhaustion; every other
    /// frame keeps the fail-open deadline untouched.
    static var suppressedDeadlineFrame: Int?

    /// The emission seam. Defaults to the kernel bus — the SAME way `Source.swift` /
    /// `ContentStore.swift` / `Errors.swift` fire kernel-owned events (`dsx` is the bus handle for
    /// module code; kernel primitives reach the registry directly). The conformance host swaps it
    /// for a capture sink so `readiness.json` runs against this exact machine.
    static var emit: (String, [String: Any]) -> Void = { name, payload in
        ModuleRegistry.shared.dispatch(name, payload, .void)
    }

    /// A native frame entered the stack. Idempotent while the record lives (rule 2); a non-native
    /// surface is dropped outright (rule 1). Arming the bounded deadline HERE (not at the call
    /// site) is what makes the fail-open impossible for a renderer to forget (rule 10).
    static func mount(frame: Int, path: String?, surface: String) {
        guard surface == "native" else { return }
        guard records[frame] == nil else { return }
        var record = Record(path: path)
        record.cancelDeadline = scheduleDeadline(settleDeadlineSeconds, { deadline(frame) })
        records[frame] = record
        emit("surface.viewStart", payload(frame: frame, path: path))
    }

    /// This frame's root declared `settle="manual"` — it reports readiness itself, so its first
    /// render pass must NOT settle it. Registered between `mount` and the first `rendered`; a
    /// `manual` for an unknown or already-settled frame is a no-op (rules 5, 8).
    static func manual(_ frame: Int?) {
        guard let frame, var record = records[frame], !record.settled else { return }
        record.manual = true
        records[frame] = record
    }

    /// This frame mounted the app's `<DSXWebView/>` web surface (rule 9 — the HYBRID ordering law).
    /// Gated exactly like `manual`, released by `webSettled()`. No gate when the page has ALREADY
    /// settled: the content is on screen, so the frame is free to settle on its first render.
    /// Registered by the COMPONENT, never by the author — this is a regression fix, not a feature.
    static func hostsWeb(_ frame: Int?) {
        guard !webIsSettled, let frame, var record = records[frame], !record.settled else { return }
        record.hostsWeb = true
        records[frame] = record
    }

    /// The frame completed its FIRST render pass. Settles an AUTO frame; a deferred one waits.
    static func rendered(_ frame: Int?) {
        guard let frame, let record = records[frame],
              !record.settled, !record.manual, !record.hostsWeb else { return }
        settle(frame, record)
    }

    /// The frame reported readiness ITSELF (`dsx.screen.settled()`, or `DSXView` on its
    /// ready/failed outcome). Always wins — settles an auto frame early and clears a pending
    /// manual / hosted gate (rule 6); repeats are no-ops (rule 5).
    static func settled(_ frame: Int?) {
        guard let frame, let record = records[frame], !record.settled else { return }
        settle(frame, record)
    }

    /// The frame's bounded settle deadline elapsed (rule 10) — settle whatever it was waiting for.
    /// Deliberately blind to `manual` / `hostsWeb`: the deadline exists precisely for the screens
    /// those flags would otherwise hold open forever. Released/settled frames are silent no-ops.
    static func deadline(_ frame: Int?) {
        guard let frame, let record = records[frame], !record.settled else { return }
        if frame == suppressedDeadlineFrame { return }   // a live root-plan attempt owns its own clock
        settle(frame, record)
    }

    /// The app web surface began loading (the relay's `surface.domStart`) — re-arms the hosted gate for
    /// frames that mount during this load. Frameless: there is exactly ONE app web surface.
    static func webStart() { webIsSettled = false }

    /// The app web surface settled (the relay's `surface.domFinish` OR `surface.domFail` — a failed load is still
    /// settled). Releases every frame gated on it, ascending, so a hybrid app's splash reveals over
    /// the loaded page instead of over a blank web view. A frame that ALSO declared
    /// `settle="manual"` keeps its own ownership and is untouched.
    static func webSettled() {
        webIsSettled = true
        for frame in records.keys.sorted() {
            guard let record = records[frame],
                  !record.settled, !record.manual, record.hostsWeb else { continue }
            settle(frame, record)
        }
    }

    /// The frame left the stack. Drops the record so no late `surface.viewFinish` can fire, and a re-mount
    /// of the same id starts a fresh instance (rule 7).
    static func release(_ frame: Int?) {
        guard let frame else { return }
        records.removeValue(forKey: frame)?.cancelDeadline?()
    }

    /// Frame ids that have started but not settled — the shell is still `loading` for each.
    /// Exposed for the conformance corpus's `expectPending`; no runtime consumer reads it.
    static var pendingFrames: [Int] {
        records.filter { !$0.value.settled }.keys.sorted()
    }

    /// Drop every record — the conformance host's per-case reset. Never called by the app.
    static func resetForTesting() {
        for record in records.values { record.cancelDeadline?() }
        records.removeAll()
        webIsSettled = false
    }

    private static func settle(_ frame: Int, _ record: Record) {
        var settled = record
        settled.settled = true
        settled.manual = false
        settled.hostsWeb = false
        settled.cancelDeadline = nil
        records[frame] = settled
        record.cancelDeadline?()   // spend the bounded deadline — it can never fire late
        emit("surface.viewFinish", payload(frame: frame, path: record.path))
    }

    /// `{ path, surface: "native", frame }` — `path` is omitted when the frame carries none, so a
    /// routeless report translates to a null `screen.*` input (phase.json).
    private static func payload(frame: Int, path: String?) -> [String: Any] {
        var out: [String: Any] = ["surface": "native", "frame": frame]
        if let path { out["path"] = path }
        return out
    }
}

/// A hierarchy-bound UIKit probe is required here instead of a GeometryReader. SwiftUI proposes a
/// keyboard-reduced height to root content while an iPad software keyboard is visible; treating that
/// proposal as the screen made a portrait 1032 x 1376 window publish as 1032 x 941 (landscape). The
/// probe reads *its own* window, rather than a process-global key window, so multi-scene apps, Split
/// View and Stage Manager still publish the exact local app-window viewport.
private struct DSXWindowMetricsProbe: UIViewRepresentable {
    struct Metrics: Equatable {
        let size: CGSize
        let sizeClass: String
    }

    let sizeClass: String
    let publish: (Metrics) -> Void

    func makeUIView(context: UIViewRepresentableContext<DSXWindowMetricsProbe>) -> ProbeView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        view.update(sizeClass: sizeClass, publish: publish)
        return view
    }

    func updateUIView(
        _ uiView: ProbeView,
        context: UIViewRepresentableContext<DSXWindowMetricsProbe>
    ) {
        uiView.update(sizeClass: sizeClass, publish: publish)
    }

    final class ProbeView: UIView {
        private var sizeClass = "compact"
        private var publish: ((Metrics) -> Void)?
        private var lastMetrics: Metrics?

        func update(sizeClass: String, publish: @escaping (Metrics) -> Void) {
            self.sizeClass = sizeClass
            self.publish = publish
            captureWindowMetrics()
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            captureWindowMetrics()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            captureWindowMetrics()
        }

        private func captureWindowMetrics() {
            guard let window else { return }
            let metrics = Metrics(size: window.bounds.size, sizeClass: sizeClass)
            guard metrics != lastMetrics else { return }
            lastMetrics = metrics
            publish?(metrics)
        }
    }
}
