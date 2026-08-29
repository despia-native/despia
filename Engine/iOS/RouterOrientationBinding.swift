//
//  RouterOrientationBinding.swift — the iOS half of `lockOrientation=` (parity/F07-orientation.md
//  §3a). The DECISION is the platform-neutral reconcile (StackOrientationBinding.swift, corpus
//  OpenSource/Conformance/input/orientation-binding.json); this file is the two things that are
//  genuinely iOS: reading the attribute off a surface ROOT through component references, and
//  turning the reconcile's plan into bus calls.
//
//  The Orientation module is EXCLUDABLE, so every call is `try? dsx.module.orientation…`. With
//  the module absent nothing happens and the app keeps its build-time orientation set, exactly
//  as before the attribute existed (Article 7). The kernel never names the module's internals
//  and never holds its claim stack.
//
import Foundation

enum RouterOrientationBinding {

    /// The `lockOrientation` a surface declares, resolved THROUGH component references — a
    /// pushed frame's root is the reference `<Name/>`, and the screen that actually declares the
    /// attribute is that template's root. The same bounded walk `StackHead.declaresManualSettle`
    /// uses for `settle`, and bounded for the same reason: a component cycle must cost eight
    /// lookups, not a hang.
    static func declaredLock(tag: String, scope: String?) -> String? {
        func lock(_ attrs: [String: String]) -> String? {
            guard let raw = attrs["lockOrientation"]?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !raw.isEmpty else { return nil }
            return raw
        }
        var node = StackNode(tag: tag, attrs: [:], children: [])
        var scope = scope
        var hops = 0
        while hops < 8, let (template, owningScope) = StackComponents.resolve(node.tag, pkg: scope) {
            if let found = lock(template.attrs) { return found }
            node = template
            scope = owningScope ?? scope
            hops += 1
        }
        return nil
    }

    /// The live surfaces, bottom-of-stack first: pushed frames in stack order, then presentations
    /// in presentation order — the order the shared claim stack has to see them in, so a sheet
    /// presented over a landscape screen sits ABOVE it.
    ///
    /// A frame is named by whatever the router can resolve it from: a route frame by its `view`
    /// tag, a module-pushed or presented frame by its `component`.
    static func surfaces(stack: [[String: Any]], modal: [[String: Any]]) -> [StackOrientationBinding.Surface] {
        var out: [StackOrientationBinding.Surface] = []
        func append(_ entry: [String: Any], id: String) {
            let tag = (entry["component"] as? String) ?? (entry["view"] as? String) ?? ""
            guard !tag.isEmpty,
                  let to = declaredLock(tag: tag, scope: entry["scope"] as? String) else { return }
            out.append(StackOrientationBinding.Surface(surface: id, to: to))
        }
        for entry in stack {
            guard let raw = entry["id"], let id = NavFrame.intId(raw) else { continue }
            append(entry, id: StackOrientationBinding.frameSurface(id))
        }
        for entry in modal {
            guard let raw = entry["id"], let id = NavFrame.intId(raw) else { continue }
            append(entry, id: StackOrientationBinding.modalSurface(id))
        }
        return out
    }
}
