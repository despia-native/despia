//
//  NativeViewHost.swift — `DSXNativeView`: host a foreign native view in the Stack.
//
//  A kernel UI primitive (Article 1) that lets a MODULE render a third-party
//  framework's view — a game engine (Godot), a map SDK, a video surface — inside the DSX
//  Stack WITHOUT importing UIKit or hand-rolling a `UIViewRepresentable`. The engine
//  owns UIKit (it already does — Stack/RouterHost/Color); modules stay at the
//  SwiftUI/DSX layer and never reach for `UIApplication`/`topViewController`.
//
//  The view is vended as an opaque `AnyObject` (the provider returns whatever the
//  framework hands back), so the calling module never names a UIKit type. A non-view
//  answer simply renders empty (fail-open). Names no module — generic by design.
//

import SwiftUI
import UIKit

/// Wrap an opaque native view in a SwiftUI `View`, pinned edge-to-edge:
///
///     DSXNativeView { GodotEngineLoader.shared.load(...) }   // provider returns AnyObject?
///
public struct DSXNativeView: View {
    private let provider: () -> AnyObject?

    /// `provider` returns the native view (e.g. a `UIView`) as an opaque object, re-read
    /// when the host rebuilds. Returning `nil` or a non-view renders nothing.
    public init(_ provider: @escaping () -> AnyObject?) { self.provider = provider }

    public var body: some View { Host(provider: provider) }

    private struct Host: UIViewRepresentable {
        let provider: () -> AnyObject?

        // Spell out SwiftUI's context type — the bare `Context` resolves to the engine's
        // own `Context` (the DSX bus handle) and breaks the protocol conformance.
        func makeUIView(context: UIViewRepresentableContext<Host>) -> UIView {
            let container = UIView()
            mount(into: container)
            return container
        }

        func updateUIView(_ container: UIView, context: UIViewRepresentableContext<Host>) {
            // Re-mount if the provider now yields a (different) view not already hosted.
            if let v = provider() as? UIView, v.superview !== container { mount(into: container) }
        }

        private func mount(into container: UIView) {
            guard let v = provider() as? UIView else { return }
            v.removeFromSuperview()                            // a UIView has one superview; re-parent safely
            v.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(v)
            NSLayoutConstraint.activate([
                v.topAnchor.constraint(equalTo: container.topAnchor),
                v.bottomAnchor.constraint(equalTo: container.bottomAnchor),
                v.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                v.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            ])
        }
    }
}

/// Host an opaque native VIEW CONTROLLER in the Stack — the twin of `DSXNativeView` for a
/// framework that vends a `UIViewController` (a game engine hosted in a `UIHostingController`,
/// an `AVPlayerViewController`, a map SDK's controller). Prefer this over `DSXNativeView` when a
/// controller exists: SwiftUI CONTAINS the child controller (proper appearance callbacks,
/// reliable safe-area, and — decisively for embedded game engines — the hosted view's origin
/// stays `.zero`, which their touch hit-tests assume; a bare re-parented `controller.view` gets
/// none of that and silently drops touches).
///
///     DSXNativeController { GodotEngineLoader.shared.hostingController }   // returns AnyObject?
///
public struct DSXNativeController: View {
    private let provider: () -> AnyObject?

    /// `provider` returns the controller as an opaque object (nil / non-controller renders empty).
    /// Read once at mount, so mount the view that hosts this only once the controller exists.
    public init(_ provider: @escaping () -> AnyObject?) { self.provider = provider }

    public var body: some View { Host(provider: provider) }

    private struct Host: UIViewControllerRepresentable {
        let provider: () -> AnyObject?

        // Spell out the context type for the same reason `DSXNativeView.Host` does — the bare
        // `Context` resolves to the engine's DSX bus handle and breaks the conformance.
        func makeUIViewController(context: UIViewControllerRepresentableContext<Host>) -> UIViewController {
            (provider() as? UIViewController) ?? UIViewController()
        }

        func updateUIViewController(_ controller: UIViewController, context: UIViewControllerRepresentableContext<Host>) {}
    }
}
