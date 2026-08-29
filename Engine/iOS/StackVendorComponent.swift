//
//  StackVendorComponent.swift — scheme-scoped NATIVE components
//  (architecture/proposals/inline-native-surfaces.md, parity/V01-stripe-inline.md).
//
//  A vendor module that owns a real platform view exposes it as `<stripe.CardInput/>`, not
//  `<CardInput/>`: the tag names its owner, so a vendor namespace can never collide with the
//  global component set, and a reader can see which module has to ship for the tag to
//  resolve. The `<store.PaywallVIP/>` precedent, extended from XML templates to native ones.
//
//  THE GAP THIS CLOSES. `StackComponents.nativeGlobal(_:)` deliberately refuses a
//  package-qualified tag ("a package-qualified tag is XML-only"), because until now every
//  package-scoped component WAS an XML template. The Compose twin has no such rule — its
//  `nativeGlobal` is a plain table lookup, so `stripe.CardInput` already resolves on Android
//  — and the web twin resolves `Scheme.Name` through `ModuleRegistry.facetComponent`. iOS was
//  the odd renderer out, which is a divergence, not a design.
//
//  A native component claims a scheme-scoped tag by spelling it whole:
//
//      final class StripeCardInput: GlobalStackComponent {
//          override class var tag: String { "stripe.CardInput" }
//      }
//
//  The launch class-walk registers it exactly like any other native global (one dictionary
//  write, keyed by the dotted tag), so nothing new discovers it and nothing new owns it.
//  Registration is still FILE PRESENCE: exclude the module, the class is not compiled in, the
//  table has no entry, and the tag falls through to the renderer's ordinary Article 7
//  fail-open — the author's slot children, or the diagnostic card on a test channel.
//
//  What this file must NOT do is answer for a tag nothing registered. `nativeGlobal` also
//  backs `StackComponents.has(_:)`, the capability boundary a remote route's `requires`
//  consults; inventing a placeholder builder here would make an excluded vendor tag report
//  itself as shipped. Absence stays absence.
//
import SwiftUI

extension StackComponents {

    /// A native global registered under a SCHEME-QUALIFIED tag (`stripe.CardInput`), or nil.
    ///
    /// Namespace-blind on purpose: `shared` / `global` are handled by `nativeGlobal(_:)`
    /// before this is reached, and every other prefix is a package scheme whose components
    /// are keyed by the whole dotted tag. nil when nothing registered it — the module is
    /// excluded from this build, and the caller keeps its honest degradation.
    static func schemedNative(_ tag: String) -> ((StackComponentContext) -> AnyView)? {
        guard let dot = tag.firstIndex(of: "."), dot != tag.startIndex,
              tag.index(after: dot) != tag.endIndex else { return nil }
        return nativeGlobals[tag]
    }
}
