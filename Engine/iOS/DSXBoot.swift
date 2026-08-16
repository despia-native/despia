//
//  DSXBoot.swift — the KERNEL's app-entry authority.
//
//  THE single launch entry point. A PACKAGE can never own the init app cycle — the kernel owns it,
//  here. `rootController()` mounts the kernel HOST (`RouterHost`): one universal navigable surface
//  that renders the Router's back-stack (`global.nav.stack`). Web or native is just frame content — a
//  web app is a one-frame stack (DSXWebView), a native app is N frames (DSXView) — so "the root" finally
//  means the app itself, web or native. The Router (kernel) seeds frame 0 from App.json's `entry` and
//  owns navigation; the host renders it and carries the cross-cutting chrome (dsx.screen + load overlay).
//
//  Both boot paths call this ONE primitive (the storyboard splash → SplashscreenVC.fireTimer, and the
//  DSX-splash completion → AppDelegate.switchToMainAppFlow), so the entry decision lives in exactly one
//  kernel-owned place.
//

import UIKit
import SwiftUI

public enum DSXBoot {

    private static var gatesRan = false

    /// Install the app-process expression seams used by `dsx.global`, `dsx.screen`,
    /// `dsx.app`, `env`, and cookies. Production boot and deterministic native
    /// fixture roots share this exact setup so a direct StackSurface does not render
    /// an empty global namespace before RouterHost exists.
    static func installEvaluatorSeams() {
        JSE.appVars = { DSX.state.vars }
        JSE.envChannel = { AppEnvironment.current.rawValue }
        JSECore.platformName = { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }
        JSE.cookieJar = { DSXCookies.shared.jar }
    }

    /// The launch entry the HOST (bootloader) calls. Runs any registered boot gates
    /// (`dsx.boot.gate`) — each shown via `present` — then mounts the app root and calls `then`.
    /// `present` is invoked once per gate-screen AND once for the root, so each call must REPLACE the
    /// current screen (swap the window root), never stack; `then` runs exactly once, after the root is
    /// mounted (host post-mount work — e.g. a launch shortcut). Idempotent: gates run once per process;
    /// a later call just re-mounts. Packages NEVER call this — they register gates with `dsx.boot.gate`
    /// and the kernel runs them here. No gates → mounts immediately.
    public static func boot(present: @escaping (UIViewController) -> Void,
                            then: @escaping () -> Void = {}) {
        // Arm the in-app kernel-log capture on TEST channels (TestFlight/ad-hoc/debug/simulator)
        // BEFORE any surface renders, so bootstrap-time diagnostics (component parse failures)
        // are already captured for the on-device debug drawer. Fail-closed: an App Store
        // install never arms, never buffers. (Both boot paths funnel through here.)
        if AppEnvironment.current.isTest { KernelLogBuffer.shared.arm() }
        // Install the evaluator's APP-STATE SEAMS (JSE.swift header, watch-runtime.md W1):
        // the reserved namespaces (`global.*` / `route.*` / `env` / `cookie.*`) read the app's
        // singletons through these closures — installed here so the phone path is unchanged,
        // while a satellite node (watch/keyboard), which never runs this boot, evaluates with
        // the seams nil and those reads fail open to empty.
        installEvaluatorSeams()
        // COMPILED INTERACTIONS (watch-runtime.md §Snapshot nodes): the app half. A widget/
        // Live-Activity button's statically-compiled dsx.module call executes HERE — the
        // intent either dispatches directly (LiveActivityIntent runs in this process) or
        // queued from the widget extension; drain at boot, on every foreground, and on the
        // extension's Darwin poke. Fire-and-forget by design (a snapshot button has no
        // envelope to render) — failures land in the error ledger like any bus call.
        DSXNodeCalls.invoke = { scheme, action, args in
            DispatchQueue.main.async {
                _ = ModuleRegistry.shared.handle(scheme: scheme, actionPath: action,
                                                 params: Bridge.Params(dict: args, requestID: nil))
            }
        }
        let group = Container.groupID
        DSXNodeCalls.drain(appGroup: group)
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification,
                                               object: nil, queue: .main) { _ in
            DSXNodeCalls.drain(appGroup: group)
        }
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
            DispatchQueue.main.async { DSXNodeCalls.drain(appGroup: Container.groupID) }
        }, DSXNodeCalls.darwinName as CFString, nil, .deliverImmediately)
        // Seed the PROVENANCE plane's kernel facts (`source.online` reachability + `source.boot`
        // first|warm) before any surface renders — per-plane slices are owner-published later
        // (Dom/Routing/content plane via `dsx.source`). See Source.swift.
        DSXSource.seed()
        guard !gatesRan else { mountRoot(present); then(); return }
        gatesRan = true
        BootGates.run(present: present) { mountRoot(present); then() }
    }

    /// Mount the app root, then align the WINDOW's own backdrop with it. The boot window
    /// keeps the SPLASH background (the app's brand hex) forever otherwise: the window is
    /// the deepest layer, so any region the app's surfaces leave uncovered — the exposed
    /// top edge while a sheet card-scales the root, transition gaps at the bar corners —
    /// peeked BRAND-colored over an otherwise system-styled screen (the "red sliver"
    /// artifact class). `.systemBackground` is dynamic: it re-resolves with the window
    /// trait, so the backdrop follows the system AND the app-wide Appearance override
    /// reactively — the same one token the host view already paints. Applied one tick
    /// after the mount so the (cross-dissolve) root swap has attached the view to the
    /// window; the splash and gate screens are untouched — they fully cover the window
    /// and keep owning its boot color.
    private static func mountRoot(_ present: (UIViewController) -> Void) {
        let root = rootController()
        present(root)
        DispatchQueue.main.async { root.viewIfLoaded?.window?.backgroundColor = .systemBackground }
    }

    /// The window's root view controller — kernel-owned. Mounts the kernel host (`RouterHost`); the
    /// Router seeds the first frame from `AppManifest.entry` (with no OTA table yet, that resolves to
    /// the configured fallback — the web view — so a web app boots straight to it). Main thread.
    public static func rootController() -> UIViewController {
        DSX.state.setPath("app", DSXApp().snapshot)   // seed dsx.app.* (App.json identity) before the first surface renders
        let host = UIHostingController(rootView: RouterHost())
        // The host paints the ADAPTIVE system background behind every frame. Routed DSX screens
        // are transparent by design (freed frames render Color.clear), so without a fill the
        // BOOT window color (the splash hex, white by default) showed through — the "random
        // white surfaces in light mode / white flash behind dark pages" class. systemBackground
        // resolves against the window trait, so it follows the system AND the app-wide
        // Appearance override; a page's own `background` paints over it as before.
        host.view.backgroundColor = .systemBackground
        return host
    }

    /// Install a boot package's splash as the window root — KERNEL-OWNED timing. The winning
    /// `boot.splash` claimant supplies ONLY its content + minimum hold (`BootSplash`); the kernel
    /// wraps it in the appear-gated `BootSplashController` and arms `then` (the app-mount handoff →
    /// switchToMainAppFlow) ONLY from the splash's `viewDidAppear`. The package never receives the
    /// app-mount trigger, so no boot package can mount the app before the splash is on screen —
    /// the crash class (mounting the web view's UIViewControllerRepresentable mid-handoff →
    /// EXC_BREAKPOINT) is structurally impossible, for EVERY boot package, not just Splash. The
    /// host calls this with whatever it claimed; nothing claims → it keeps its storyboard fallback.
    public static func installBootSplash(_ splash: BootSplash, in window: UIWindow, then: @escaping () -> Void) {
        window.rootViewController = BootSplashController(splash, onReady: then)
        window.makeKeyAndVisible()
    }
}

/// A boot package's splash contribution: WHAT to show + the minimum on-screen hold (ms). A boot
/// package supplies ONLY this — never the app-mount trigger. The kernel decides WHEN it's safe to
/// hand off (after the splash is actually on screen, in `BootSplashController`), so a package can't
/// mount the app early. Returned from `claim("boot.splash")`; the host passes it to
/// `DSXBoot.installBootSplash`.
public struct BootSplash {
    public let content: UIViewController
    public let minMs: Int
    public init(content: UIViewController, minMs: Int) {
        self.content = content
        self.minMs = minMs
    }
}

/// Kernel-owned boot-splash container. Embeds the boot package's splash content and drives the app
/// handoff from `viewDidAppear` (+ the package's min hold) — NEVER a boot-time timer. Mounting the
/// app root before the splash has settled in the window hierarchy traps in SwiftUI's
/// UIViewControllerRepresentable construction (the web view, DSXWebView → DomWebHost). Because a boot
/// package supplies only `BootSplash` and the kernel owns this container + the `onReady` trigger,
/// the bug class is structurally impossible. (Mirrors the proven `SplashscreenVC` lifecycle, which
/// moved its own handoff into `viewDidAppear` for the identical reason.)
final class BootSplashController: UIViewController {
    private let content: UIViewController
    private let minMs: Int
    private let onReady: () -> Void
    private var handedOff = false

    init(_ splash: BootSplash, onReady: @escaping () -> Void) {
        self.content = splash.content
        self.minMs = splash.minMs
        self.onReady = onReady
        super.init(nibName: nil, bundle: nil)
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("BootSplashController is code-only") }

    override func viewDidLoad() {
        super.viewDidLoad()
        addChild(content)
        content.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content.view)
        NSLayoutConstraint.activate([
            content.view.topAnchor.constraint(equalTo: view.topAnchor),
            content.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            content.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            content.view.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        content.didMove(toParent: self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !handedOff else { return }          // hand off exactly once, AFTER we're on screen
        handedOff = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(max(0, minMs)) / 1000) { [weak self] in
            self?.onReady()
        }
    }
}
