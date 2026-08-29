//
//  StackRef.swift — the `ref="name"` universal attribute's shared core plus its SwiftUI
//  adapter. The law is the corpus, `OpenSource/Conformance/input/ref.json`; the Kotlin twin is
//  `:core` StackRef.kt and the web twin is @despia/kernel's ref.ts.
//
//  WHAT REF IS FOR: publishing an element's backing platform view into the shared-handle
//  registry so a MODULE can reach it — `Core/Capture`'s `element` and `pdf`, `<scroll>`'s
//  `toElement`, `<Spotlight>`'s target rect. **The kernel names none of those consumers**: it
//  publishes under a derived key and any module resolves it over the bus, which is what keeps
//  `ref` a kernel primitive rather than a feature (root-plan rule 18).
//
//  THE ONE NON-OBVIOUS RULE is list recycling. A recycled row mounts the INCOMING view before it
//  unmounts the outgoing one, so a naive clear-on-disappear would kill the ref the visible row
//  now owns. Clearing therefore checks provider identity: only the CURRENT provider may clear,
//  and a stale provider's teardown is a no-op.
//
import Foundation
import SwiftUI
import UIKit

public enum StackRef {

    /// The registry key for a ref name, or nil when the name is not a ref.
    ///
    /// Namespaced with `ref.` so an author's name can never collide with a first-class handle
    /// like `web` or `view`. Exact case: a name is opaque, not a keyword.
    public static func key(_ name: String?) -> String? {
        let trimmed = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : "ref.\(trimmed)"
    }

    /// The stable machine id a consumer reports for both never-published and published-then-gone.
    public static let unknown = "unknown_ref"

    /// Resolve a ref to its live view, or nil. `DSXShared` holds handles WEAKLY, so a view that
    /// has gone reads as nil here — a dead view must never read as a live one.
    public static func resolve(_ name: String?) -> UIView? {
        guard let k = key(name) else { return nil }
        return DSXShared().use(k) as? UIView
    }
}

/// `ref="name"` — publish this element's backing `UIView` while it is on screen.
///
/// The measurement trick is the same one `StackMeasure` uses: a transparent background layer
/// that can see the real view tree. `RefProbe` finds the nearest hosting view and publishes it,
/// then clears on teardown **only if it is still the current provider**.
struct StackRefModifier: ViewModifier {
    let name: String

    func body(content: Content) -> some View {
        content.background(RefProbe(name: name).allowsHitTesting(false))
    }
}

private struct RefProbe: UIViewRepresentable {
    let name: String

    func makeUIView(context: UIViewRepresentableContext<Self>) -> RefProbeView {
        let v = RefProbeView()
        v.refName = name
        v.isUserInteractionEnabled = false
        v.backgroundColor = .clear
        return v
    }

    func updateUIView(_ uiView: RefProbeView, context: UIViewRepresentableContext<Self>) {
        uiView.refName = name
        uiView.publish()
    }

    static func dismantleUIView(_ uiView: RefProbeView, coordinator: ()) {
        uiView.withdraw()
    }
}

/// The probe publishes its SUPERVIEW — the element's own backing view — not itself, because a
/// consumer wants the element, and a zero-size transparent probe is not it.
final class RefProbeView: UIView {
    var refName: String = ""
    private var published: UIView?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { withdraw() } else { publish() }
    }

    func publish() {
        guard let key = StackRef.key(refName), let target = superview else { return }
        published = target
        DSXShared().provide(key, target)
    }

    /// Clear only if we are still the current provider (the recycling rule).
    func withdraw() {
        guard let key = StackRef.key(refName), let mine = published else { return }
        if (DSXShared().use(key) as AnyObject?) === mine {
            DSXShared().provide(key, nil)
        }
        published = nil
    }
}
