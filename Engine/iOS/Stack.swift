//
//  Stack.swift — dsx.stack: native declarative UI for DespiaScript
//
//  Part of the DespiaScript core (extends Context). Public API: dsx.stack.*
//  write the view as an XML string and the logic/state in native `dsx` code:
//
//      let ui = dsx.stack.render("""
//        <vstack style="sheet">
//          <text style="heading">{{ title }}</text>
//          <list bind="episodes" key="id">
//            <row>
//              <text bind="item.title"/>
//              <glassButton id="like"
//                           color="{{ item.liked ? 'accent' : 'white' }}"
//                           on:tap="call: api.like?id={{ item.id }}"/>
//            </row>
//          </list>
//        </vstack>
//      """)
//      ui.state("title", "Episodes")
//      ui.list("episodes").set(items)
//      ui.list("episodes").update(id: 5) { $0["liked"] = true }   // patches that one row
//      ui.node("#like")?.set("color", "accent")                    // imperative escape
//      present(ui.controller)   // a package presents it
//
//  Reactive: state lives in a native @Published store; SwiftUI's own diffing
//  (ForEach(id:) for lists) does the minimal patching. All native — no JS, can't
//  be frozen by the web view. v0.1: core components + bindings + keyed lists.
//

import Foundation
import SwiftUI
import UIKit
import CryptoKit
import CommonCrypto
import Security
import Network

// MARK: - dsx.stack — the native UI namespace

extension Context {
    /// Native UI surface of the bridge: `dsx.stack.render(xml)`, and room for
    /// more (`dsx.stack.present(...)`, `dsx.stack.theme(...)`, …). It's the same
    /// `dsx`, so a package mixes UI with the rest of its API — render a surface
    /// and still `dsx.resolve(...)` / `dsx.module...` / `dsx.broadcast(...)`.
    /// Prefer `dsx.component.render(…)` for a REGISTERED component; raw XML via
    /// `dsx.stack.render(xml)` is the escape hatch.
    public var stack: StackAPI { StackAPI(dsx: self) }
    /// THE way to mount UI: mount a component by reference — the GENERATED leading-dot refs
    /// (`dsx.component.mount(.Player)` / `.scheme.Name` — autocompleted, compile-checked) or
    /// the string form for data-borne names (`mount("dsx.module.self.Player")`).
    /// See `ComponentAPI.mount`. (The old `dsx.module`-as-ComponentRef root was removed:
    /// `dsx.module` is the CALL root now — the native twin of `dsx.module.scheme.method`.)
    public var component: ComponentAPI { ComponentAPI(dsx: self) }
}

/// The typed component reference — the generated leading-dot refs resolve here —
/// built by dynamic member lookup, so the Swift call reads exactly like the JSE `dsx.module.…`
/// namespace (the `$` itself is reserved by Swift; `dsx.module` is the same root). `.self`
/// is Swift's identity postfix, so a `….self.Player` chain ≡ `….Player` = THIS
/// package's component (own-scope resolution — no hard-coded scheme).
/// String references that arrive as DATA use the same path: `mount("dsx.module.self.Player")`.
@dynamicMemberLookup
public struct ComponentRef {
    var path: [String] = []
    public subscript(dynamicMember name: String) -> ComponentRef {
        var c = self; c.path.append(name); return c
    }
    /// `"Player"` or `"store.Card"` — the tag the registry resolves.
    var tag: String { path.joined(separator: ".") }
}

/// `dsx.component` — mount FILE-based components by reference (the ideal form;
/// `dsx.stack.render(xml)` stays as the raw-markup escape hatch).
///
/// This is essentially "dsx.stack.present a FILE": the component IS a `.dsx` file in a
/// package's `Components/` folder (baked into the registry at build time), and every
/// `<Tag>` used inside it resolves from folders the same way — package-local first, then
/// global. Native code never carries inline XML; the UI lives in files.
public struct ComponentAPI {
    let dsx: Context

    /// MOUNT a file-based component and get the reactive `StackSurface` — then wire it
    /// like any surface: `ui.on(…)`, `ui.action(…)`, `ui.variable(…)`, `ui.attribute(…)`.
    ///
    ///   let ui = dsx.component.mount(.Player)                    // GENERATED ref: autocompleted + compile-checked
    ///   dsx.component.mount(.verticalplayer.Episodes)             // another package — still leading-dot, still checked
    ///   dsx.component.mount("dsx.module.self.Player")               // dynamic/string form — for data-borne names
    ///
    /// The leading-dot refs are GENERATED from the .dsx files (Registry/StackComponents
    /// .generated.swift), so a misspelled component is a COMPILE error and the list can
    /// never drift from the folders. `dsx.module.…` stays for dynamic/runtime references.
    ///
    /// (the string form mirrors the JSE `dsx.module.self.…` — same namespace, no hard-coded
    /// scheme; Swift reserves `$`, so the root is `dsx.module`.)
    ///
    /// Mount modes answer "page vs over-the-web-view", same as `dsx.stack.render`:
    ///   `as: .screen` (default)    → a PAGE — present `surface.controller` (full screen;
    ///                                give the component's root `enter=` / `dismissEdge=`)
    ///   `as: .overlay(.bottom/…)`  → OVER the web view with passthrough touches (glass bars)
    /// Bottom sheets stay declarative: a `<sheet>` inside the component, or `surface.sheet(…)`.
    @discardableResult
    public func mount(_ ref: ComponentRef, as mount: StackMount = .screen) -> StackSurface {
        let surface = dsx.stack.render("<\(ref.tag)/>", as: mount)
        dsx.lastMount = surface                                        // let dsx.boot.gate show it
        return surface
    }
    /// String form (`"dsx.module.self.Player"` / `"Player"` / `"shared.Card"`) — e.g. a reference
    /// that arrives as data. Prefer the typed `package.…` value above.
    @discardableResult
    public func mount(_ reference: String, as mount: StackMount = .screen) -> StackSurface {
        var tag = reference.trimmingCharacters(in: .whitespaces)
        if tag.hasPrefix("dsx.module.") { tag = String(tag.dropFirst("dsx.module.".count)) }
        if tag.hasPrefix("self.") { tag = String(tag.dropFirst(5)) }   // own package = the surface's default scope
        let surface = dsx.stack.render("<\(tag)/>", as: mount)
        dsx.lastMount = surface                                        // let dsx.boot.gate show it
        return surface
    }

    // MARK: push / present / dismiss — the promoted, STATE-BACKED presentation verbs
    //
    // Two distinct mental models (the reason `push` and `present` are separate verbs):
    //   • push    → a navigation FRAME on `global.nav.stack` (interactive swipe-back, OS back history).
    //   • present → a MODAL on the observable `global.nav.modal` (`sheet` / `overlay` / `cover`).
    // Both are STATE mutations the kernel host renders — never a fire-and-forget UIKit `presenter.present`
    // (which can `resolve` "opened" while nothing is on screen). `vars` seed the frame's own store,
    // read inside the component as `{{ vars.x }}` / `bind="vars.x"`. The same three verbs exist in
    // markup (`dsx.component.push/present/dismiss`) and on web (`window.despia.route.*`), 1:1 per surface.

    /// PUSH this component as a native nav frame, seeding `vars`. Returns the surface so an advanced
    /// caller can still wire `.on`/`.action` (the simple case needs no wiring). The twin of the module
    /// pattern `mount(ref).push(from:dsx,path:)`, in one call.
    @discardableResult
    public func push(_ ref: ComponentRef, path: String = "", vars: [String: Any]? = nil,
                     attrs: [String: Any]? = nil, onPop: (() -> Void)? = nil) -> StackSurface {
        let surface = dsx.stack.render("<\(ref.tag)/>")
        if let attrs { for (k, v) in attrs { surface.attribute(k, v) } }   // THE input contract
        surface.push(from: dsx, path: path, vars: vars, onPop: onPop)
        return surface
    }

    /// LIVE attribute updates on an open frame/modal (the reactive half of the attribute
    /// contract): merges into the entry's published `attrs` and re-seeds the surface's reactive
    /// `dsx.attribute` dict — bindings recalc, `<attribute on:change>` fires. `target` matches
    /// like dismiss (component tag / `as:` mode; nil = top-most presented, else the top frame).
    public func update(_ target: String? = nil, attrs: [String: Any]) {
        Router.shared?.updateComponent(target: target, attrs: attrs)
    }

    /// PRESENT this component as a state-backed modal — `mode`: `sheet` (default, a drawer) /
    /// `cover` (full-screen) / `overlay` (the layer over the current screen; `touch:` picks
    /// "passthrough" — the default, only drawn content is tappable, the menu-bar-over-web shape —
    /// or "block", the full overlay where every touch stops at the layer) — seeding `vars`.
    /// Interactive swipe-away stays in sync with `global.nav.modal` — the host reports the
    /// dismissal back, so state is never stale. Returns the surface for optional wiring.
    @discardableResult
    public func present(_ ref: ComponentRef, mode: String = "sheet", vars: [String: Any]? = nil,
                        detents: [String]? = nil, touch: String? = nil, attrs: [String: Any]? = nil,
                        onDismiss: (() -> Void)? = nil) -> StackSurface {
        let surface = dsx.stack.render("<\(ref.tag)/>")
        if let attrs { for (k, v) in attrs { surface.attribute(k, v) } }   // THE input contract
        surface.presentModal(from: dsx, mode: mode, vars: vars, detents: detents, touch: touch,
                             attrs: attrs, onDismiss: onDismiss)
        return surface
    }

    /// DISMISS a presented modal — default pops the TOP; `target` (a component tag or an `as:` mode)
    /// targets one. A no-op when nothing is presented.
    public func dismiss(_ target: String? = nil) {
        Router.shared?.dismissModal(target: target)
    }
}

/// Which edge an overlay surface pins to (or `.fill` for the whole web view).
public enum StackEdge { case top, bottom, leading, trailing, fill }

/// How `dsx.stack.render` mounts a surface: a presented native `.screen`, or an
/// `.overlay(edge)` floating over the web view with passthrough touches.
public enum StackMount { case screen, overlay(StackEdge) }

/// A resting size for a `StackSurface.sheet(...)` bottom sheet — the stops every
/// platform supports 1:1: `content` (wraps the content's height — iOS custom
/// detent / Compose `ModalBottomSheet` wrap / Views `wrap_content`), `half`
/// (iOS `.medium()` / Compose PartiallyExpanded / Views HALF_EXPANDED), and `full`
/// (iOS `.large()` / Compose Expanded / Views EXPANDED). Pass `[.half, .full]` to
/// drag between two stops, or a single stop to pin it. (No custom fraction/peek
/// detents — they don't map cleanly to Compose's modal sheet.)
public enum StackDetent {
    case content, half, full
    var uiDetent: UISheetPresentationController.Detent {
        switch self {
        case .content: return .medium()   // measured in sheet(); this is the iOS-15 fallback
        case .half:    return .medium()
        case .full:    return .large()
        }
    }
}

/// Retains the sheet's onDismiss and forwards the interactive (swipe / tap-away)
/// dismissal — `presentationControllerDidDismiss` does NOT fire for a programmatic
/// `dismiss(animated:)`, so callers can dismiss silently after a successful action.
final class StackSheetDelegate: NSObject, UIAdaptivePresentationControllerDelegate {
    let onDismiss: () -> Void
    init(onDismiss: @escaping () -> Void) { self.onDismiss = onDismiss }
    func presentationControllerDidDismiss(_ pc: UIPresentationController) { onDismiss() }
}

/// `dismissEdge="left"` — the interactive left-edge back-swipe for a presented DSX page
/// (see `StackSurface.present`). 1:1 finger follow; past ⅓ width (or a fast fling) the page
/// slides out (0.22s ease-out) and `onDismiss` runs; otherwise it springs back (0.85 damping).
final class StackEdgeDismiss: NSObject {
    private weak var controller: UIViewController?
    private let onDismiss: () -> Void
    init(controller: UIViewController, onDismiss: @escaping () -> Void) {
        self.controller = controller; self.onDismiss = onDismiss
    }
    @objc func handle(_ g: UIScreenEdgePanGestureRecognizer) {
        guard let v = controller?.view else { return }
        let w = max(v.bounds.width, 1)
        let dx = max(0, g.translation(in: v).x)        // rightward only
        switch g.state {
        case .changed:
            v.transform = CGAffineTransform(translationX: dx, y: 0)   // 1:1 follow (snap-back = the resistance)
        case .ended, .cancelled, .failed:
            let vx = g.velocity(in: v).x
            if dx > w * 0.33 || vx > 800 {
                UIView.animate(withDuration: 0.22, delay: 0, options: .curveEaseOut, animations: {
                    v.transform = CGAffineTransform(translationX: w, y: 0)
                }, completion: { _ in self.onDismiss() })
            } else {
                UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.85,
                               initialSpringVelocity: 0, options: []) { v.transform = .identity }
            }
        default: break
        }
    }
}


public struct StackAPI {
    let dsx: Context

    /// Parse an XML view string into a native, reactive surface (scoped to this
    /// package so its `<Components>` resolve, plus the global ones) and mount it.
    ///
    /// `as: .screen` (default) builds a surface you present (`.controller`) — a
    /// native screen that owns the display. `as: .overlay(edge)` mounts it as a
    /// sibling ABOVE the web view with passthrough hit-testing: only real native
    /// controls in the XML capture touches; taps on transparent areas fall
    /// straight through to the page, which stays scrollable and clickable. That's
    /// how you float a native liquid-glass nav/tab bar (`surface="glass"`) over
    /// web content. The edge pins it (.bottom/.top/.leading/.trailing size to
    /// content; .fill covers the whole web view). Tear an overlay down with
    /// `surface.remove()`. Both modes return the same reactive `StackSurface`.
    @discardableResult
    public func render(_ xml: String, as mount: StackMount = .screen) -> StackSurface {
        let root = StackXML.parse(xml) ?? StackNode(tag: "vstack", attrs: [:], children: [])
        let surface = StackSurface(root: root, webView: (dsx.shared.use("web") as? UIView), scope: dsx.store.primaryScheme, dsx: dsx)
        if case .overlay(let edge) = mount { surface.mountOverlay(edge) }
        return surface
    }

    /// Register a native view a package owns at RUNTIME — the dynamic counterpart to a
    /// class-walk `GlobalStackComponent` (its closure can capture live package state, e.g.
    /// `[weak self]`). Resolved through the normal component path, so reference it as `<name/>`
    /// (or the legacy alias `<native name="name"/>`). Builder gets raw attrs; ship a
    /// `GlobalStackComponent` instead when the surface wants the full dsx.
    public func register(_ name: String, _ build: @escaping ([String: String]) -> AnyView) {
        StackComponents.registry[name] = build
    }

    /// Register a reusable XML component. `global: false` (default) scopes it to
    /// this package (folder-local — only this package's templates can use it);
    /// `global: true` registers it for every package (the Core/Components case).
    /// Use it in XML by its Capitalized tag: `<PlanRow title="…" on:select="…"/>`.
    /// Props are the attributes (available as `{{ title }}` / `bind`), and the
    /// component raises events with `dsx.event('select')` → the consumer's `on:select`.
    public func component(_ name: String, xml: String, global: Bool = false) {
        StackComponents.define(name, xml: xml, scope: global ? nil : dsx.store.primaryScheme)
    }
}

/// Registry of components. `native:<name>` views (registry) + reusable XML
/// components (defs), the latter scoped by the package that registered them
/// (folder-based sharing): a package's own components resolve first, then global.
public enum StackComponents {
    static var registry: [String: ([String: String]) -> AnyView] = [:]

    struct Def { let template: StackNode; let scope: String? }   // scope = pkg scheme; nil = global
    static var defs: [String: [Def]] = [:]

    /// Load every package's `Components/*.dsx` exactly once, the first time the
    /// engine touches the component table. Each file auto-registers under its
    /// file name, scoped to the owning package's scheme (folder-local) — no
    /// `dsx.stack.component(...)` call. The table is generated at build time by
    /// scripts/prepare_config.rb (see Registry/StackComponents.generated.swift).
    /// Runs before any explicit `define`/`resolve`, so an explicit
    /// `dsx.stack.component(...)` still wins (it appends after this, same scope).
    private static let didBootstrap: Bool = {
        // The kernel's own element classes register here as well as via the launch
        // class-walk (both are idempotent dictionary writes): a surface resolved before —
        // or without — ModuleRegistry.bootstrap() still finds the engine-owned `<scene>`
        // tag (SceneElement.swift, dsx-scene.md P2).
        registerPrivileged(SceneElement.self)
        for c in KernelTables.stackComponents {
            if let template = StackXML.parse(c.xml) {
                append(c.name, Def(template: template, scope: c.scheme))
            } else {
                // The template is DEAD — it registers as NOTHING and every use renders empty.
                // Record a STRUCTURED issue (exact line:column, source excerpt, hint) for the
                // on-device issues panel; on test channels this also auto-presents the panel.
                StackDiagnostics.recordParseFailure(name: c.name, scope: c.scheme ?? "", xml: c.xml)
            }
        }
        return true
    }()

    private static func append(_ name: String, _ def: Def) {
        var list = defs[name] ?? []
        list.removeAll { $0.scope == def.scope }
        list.append(Def(template: stampCSSOwner(def.template, name), scope: def.scope))
        defs[name] = list
    }

    /// Stamp every node of a component template with its owning component name
    /// (reserved attr `css-owner`) so DSX-CSS sheet scoping can resolve the
    /// component's compiled stylesheet for any node in its subtree — the
    /// node→component identity the CSS cascade needs. One-time cost at
    /// registration; unknown attributes are inert everywhere else.
    private static func stampCSSOwner(_ node: StackNode, _ name: String) -> StackNode {
        var n = node
        if n.attrs["css-owner"] == nil { n.attrs["css-owner"] = name }
        n.children = n.children.map { stampCSSOwner($0, name) }
        return n
    }

    static func define(_ name: String, xml: String, scope: String?) {
        _ = didBootstrap
        guard let template = StackXML.parse(xml) else {
            // Same failure class as bootstrap: an explicit define that fails to parse
            // registers nothing — record the structured issue instead of a silent return.
            StackDiagnostics.recordParseFailure(name: name, scope: scope ?? "", xml: xml)
            return
        }
        append(name, Def(template: template, scope: scope))
    }
    /// Inline `<component as="…">` definitions — IDEMPOTENT per (name, scope): a re-render
    /// replaces the definition instead of stacking duplicates (and an inline definition
    /// shadows a same-name file component in the same scope — the closest wins).
    static func defineNode(_ name: String, template: StackNode, scope: String?) {
        _ = didBootstrap
        var list = defs[name] ?? []
        let stamped = Def(template: stampCSSOwner(template, name), scope: scope)
        if let i = list.firstIndex(where: { $0.scope == scope }) {
            list[i] = stamped
        } else {
            list.insert(stamped, at: 0)
        }
        defs[name] = list
    }
    /// Resolve a component for the rendering package: package-local first, else global.
    static func resolve(_ tag: String, pkg: String?) -> (template: StackNode, scope: String?)? {
        _ = didBootstrap
        // Qualified reference `<namespace.Name/>` addresses ONE scope explicitly,
        // bypassing local-first resolution — use it when a package's own component
        // would otherwise shadow the one you want:
        //   • <shared.Name/> / <global.Name/> → the universal pool (DSX/Modules/Components, scope nil)
        //   • <store.Name/>  (any other prefix) → that package's component (scope = its scheme)
        if let dot = tag.firstIndex(of: ".") {
            let ns   = String(tag[..<dot])
            let name = String(tag[tag.index(after: dot)...])
            let scope: String? = (ns == "shared" || ns == "global") ? nil : ns
            return defs[name]?.first { $0.scope == scope }.map { ($0.template, $0.scope) }
        }
        // Bare `<Name/>`: this package's own component first, else a global one.
        guard let list = defs[tag] else { return nil }
        return (list.first { $0.scope == pkg } ?? list.first { $0.scope == nil }).map { ($0.template, $0.scope) }
    }

    // ── Native global components (GlobalStackComponent) ──────────────────────
    /// Native global components — real SwiftUI views owned by no package, keyed by
    /// tag. Registered at launch (ModuleRegistry bootstrap), and resolved AFTER XML
    /// components for a bare or `<shared.Name/>` tag, so an XML component of the same
    /// name takes precedence.
    static var nativeGlobals: [String: (StackComponentContext) -> AnyView] = [:]

    static func registerNative(_ type: GlobalStackComponent.Type) {
        let builder: (StackComponentContext) -> AnyView = { dsx in type.body(dsx) }
        nativeGlobals[type.tag] = builder
        for alias in type.aliases { nativeGlobals[alias] = builder }   // e.g. text/label, spinner/activity
    }

    /// A bare `<Name/>` or qualified `<shared.Name/>` / `<global.Name/>` tag → its
    /// native global builder. A package-qualified tag (`<store.Name/>`) is XML-only.
    static func nativeGlobal(_ tag: String) -> ((StackComponentContext) -> AnyView)? {
        if let dot = tag.firstIndex(of: ".") {
            let ns = String(tag[..<dot])
            guard ns == "shared" || ns == "global" else { return nil }
            return nativeGlobals[String(tag[tag.index(after: dot)...])]
        }
        return nativeGlobals[tag]
    }

    // ── Privileged global components (PrivilegedStackComponent) ───────────────
    /// The structural orchestrators (`list`/`grid`/`pager`/`tabs`/`scaffold`/…) — native
    /// components granted engine power (scoped child rendering, child-node introspection,
    /// collection write-back) via the privileged dsx. Registered at launch exactly like the
    /// safe native globals, keyed by their (lowercase) structural tag; resolved by the
    /// renderer BEFORE the built-in switch so a literal `<list>` reaches the component.
    static var privilegedGlobals: [String: (PrivilegedStackComponentContext) -> AnyView] = [:]

    static func registerPrivileged(_ type: PrivilegedStackComponent.Type) {
        let builder: (PrivilegedStackComponentContext) -> AnyView = { dsx in type.body(dsx) }
        privilegedGlobals[type.tag] = builder
        for alias in type.aliases { privilegedGlobals[alias] = builder }   // e.g. tabs/tabview
    }
    /// A privileged orchestrator builder for a bare structural tag. (Privileged tags are the
    /// always-shipped default library — not package-scoped or dotted.)
    static func privilegedGlobal(_ tag: String) -> ((PrivilegedStackComponentContext) -> AnyView)? {
        privilegedGlobals[tag]
    }

    /// Is a tag shipped in THIS binary — an XML component or a native global? The
    /// component half of the capability boundary: a remote route's `requires` and the
    /// dynamic `<node>` resolver consult it before naming a tag. Bare names are the coarse,
    /// scope-blind capability question. Qualified wire names (`demo.Launcher`) address one
    /// explicit scope and must follow `resolve(_:pkg:)` rather than looking up the dotted
    /// string as a component name.
    static func has(_ tag: String) -> Bool {
        _ = didBootstrap
        if let dot = tag.firstIndex(of: ".") {
            let ns = String(tag[..<dot])
            let name = String(tag[tag.index(after: dot)...])
            let scope: String? = (ns == "shared" || ns == "global") ? nil : ns
            let hasQualifiedNode = defs[name]?.contains { $0.scope == scope } == true
            return hasQualifiedNode || nativeGlobal(tag) != nil || registry[tag] != nil
        }
        // Shipped under ANY scope (global or package-local) — this is a coarse "is it
        // compiled in" check for the capability gate, not scoped render resolution.
        return defs[tag] != nil || nativeGlobal(tag) != nil || privilegedGlobals[tag] != nil || registry[tag] != nil
    }
}

// MARK: - Native components (Swift-backed, around XML)

/// Base class for a NATIVE global component — a real SwiftUI view that registers
/// GLOBALLY (usable from any package). Drop a `<Tag>.swift` in a package (e.g. the
/// mandatory `Foundation` package's `Components/`):
///
///     final class Drawer: GlobalStackComponent {
///         override class var tag: String { "Drawer" }
///         override class func body(_ dsx: StackComponentContext) -> AnyView {
///             AnyView(DrawerView(dsx: dsx))   // your SwiftUI view, with @State, etc.
///         }
///     }
///
/// It auto-registers at launch (the same sweep that finds `Module` subclasses) and
/// is used in XML as `<Drawer/>` (or `<shared.Drawer/>`). Render the consumer's XML
/// children via `context.slot()`.
open class GlobalStackComponent: NSObject {
    /// The XML tag (Capitalized). Defaults to the class name; keep file name, class
    /// name and tag identical (e.g. `Drawer.swift` → `Drawer` → `<Drawer/>`).
    open class var tag: String { String(describing: self) }
    /// Extra tags this component also answers to (e.g. `["label"]` for `text`). Optional.
    open class var aliases: [String] { [] }
    /// Build the view from the component context (attributes, slot, state, events).
    open class func body(_ dsx: StackComponentContext) -> AnyView { AnyView(EmptyView()) }
}

/// The bridge a native component uses to behave like any Stack component: read
/// attributes, render the consumer's XML children (`slot`) or arbitrary XML (`render`),
/// two-way bind store state (`binding`), and raise events back to the Stack
/// (`dsx.event` → the consumer's `on:<name>`; `dsx.send` → a `ui.on` handler).
public struct StackComponentContext {
    let attrs: [String: String]          // raw tag attributes (un-resolved → reactive on read)
    let store: StackStore
    let env: JSERunner
    let item: [String: Any]?             // consumer's data scope (e.g. the list row)
    let rowWrite: ((String, Any) -> Void)?   // row write-back, so `bind="item.x"` edits the row
    private let slotContent: SlotContent?
    private let nodeText: String?        // the element's inner text (`<text>Hello</text>`)
    let componentTag: String?            // the registered tag this dsx renders (native components) → its event scheme
    /// Value-only dependency passed by `NativeStackComponentHost`. It is intentionally not public
    /// component API; its sole job is to make SwiftUI re-evaluate an otherwise stateless child when
    /// any evaluator namespace that child can read publishes.
    private struct RenderRevision: Equatable {
        let local: UInt64
        let global: UInt64
        let cookies: UInt64
        static let initial = RenderRevision(local: 0, global: 0, cookies: 0)
    }
    private let renderRevision: RenderRevision

    init(attrs: [String: String], store: StackStore, env: JSERunner,
         item: [String: Any]?, slot: SlotContent?, nodeText: String? = nil,
         rowWrite: ((String, Any) -> Void)? = nil, componentTag: String? = nil) {
        self.init(
            attrs: attrs,
            store: store,
            env: env,
            item: item,
            slot: slot,
            nodeText: nodeText,
            rowWrite: rowWrite,
            componentTag: componentTag,
            renderRevision: .initial
        )
    }

    private init(attrs: [String: String], store: StackStore, env: JSERunner,
                 item: [String: Any]?, slot: SlotContent?, nodeText: String?,
                 rowWrite: ((String, Any) -> Void)?, componentTag: String?,
                 renderRevision: RenderRevision) {
        self.attrs = attrs; self.store = store; self.env = env; self.item = item
        self.slotContent = slot; self.nodeText = nodeText; self.rowWrite = rowWrite
        self.componentTag = componentTag
        self.renderRevision = renderRevision
    }

    fileprivate func withRenderRevisions(local: UInt64, global: UInt64, cookies: UInt64) -> Self {
        StackComponentContext(
            attrs: attrs,
            store: store,
            env: env,
            item: item,
            slot: slotContent,
            nodeText: nodeText,
            rowWrite: rowWrite,
            componentTag: componentTag,
            renderRevision: RenderRevision(local: local, global: global, cookies: cookies)
        )
    }

    /// The raw (platform-resolved) attributes — for elements that hand the whole dict to a
    /// styler (e.g. `StackStyle.styleText`). Prefer the typed `string`/`double`/… readers.
    public var attributes: [String: String] { attrs }

    /// The element's text content — `bind` (evaluated) ?? inner text ?? `value`
    /// (interpolated). Mirrors the engine's `boundText`, for the `<text>` element.
    /// The STATIC paths (inner text / `value` — authored UI copy) run through the kernel
    /// localization seam; the `bind` path is DATA (a chat message, a user's note) and is
    /// never localized — translating user content through UI tables would corrupt it.
    public func text() -> String {
        if let b = attrs["bind"] { return JSE.string(JSE.eval(b, store: store, item: item)) }
        if let t = nodeText { return DSXStrings.localize(JSE.interpolate(t, store: store, item: item)) }
        if let v = attrs["value"] { return DSXStrings.localize(JSE.interpolate(v, store: store, item: item)) }
        return ""
    }

    /// A HUMAN-DISPLAY string prop: `string(key)` + the kernel localization seam. THE reader for
    /// authored UI copy (labels, placeholders, titles, messages) — one choke point, so a component
    /// never couples to the strings machinery directly. Non-display props (colors, ids, tokens)
    /// keep using `string(key)`.
    public func displayString(_ key: String, _ fallback: String = "") -> String {
        DSXStrings.localize(string(key, fallback))
    }

    // ── Props (reactive: resolved on every read, re-renders with the store) ──
    /// A string prop (`{{ }}` interpolated). `value="{{ title }}"`.
    public func string(_ key: String, _ fallback: String = "") -> String {
        attrs[key].map { JSE.interpolate($0, store: store, item: item) } ?? fallback
    }
    public func double(_ key: String, _ fallback: Double = 0) -> Double {
        guard let raw = attrs[key] else { return fallback }
        return Double(JSE.interpolate(raw, store: store, item: item)) ?? fallback
    }
    public func int(_ key: String, _ fallback: Int = 0) -> Int {
        let d = double(key, Double(fallback))
        return (d.isFinite && abs(d) < 9e18) ? Int(d) : fallback
    }
    public func bool(_ key: String, _ fallback: Bool = false) -> Bool {
        guard let raw = attrs[key] else { return fallback }
        let s = JSE.interpolate(raw, store: store, item: item)
        return s == "true" || (Double(s).map { $0 != 0 } ?? false)
    }
    /// A list prop — the attribute is a bare expression (like `bind`): `items="rows"`.
    public func list(_ key: String) -> [[String: Any]] {
        guard let raw = attrs[key] else { return [] }
        return JSE.asRows(JSE.eval(raw, store: store, item: item))
    }
    /// A structured prop (any value), bare-expression attribute.
    public func json(_ key: String) -> Any? {
        attrs[key].flatMap { JSE.eval($0, store: store, item: item) }
    }
    /// Is a prop present on the tag?
    public func has(_ key: String) -> Bool { attrs[key] != nil }

    // ── Slots (the consumer's XML children) ──
    /// Render the default children, or a `slot="name"` group.
    public func slot(_ name: String? = nil) -> AnyView {
        guard let s = slotContent else { return AnyView(EmptyView()) }
        let kids = s.children.filter { $0.attrs["slot"] == name }
        return AnyView(ForEach(kids.indices, id: \.self) { i in
            StackNodeView(node: kids[i], store: store, env: s.env, item: s.item, rowWrite: s.rowWrite)
        })
    }
    public func hasSlot(_ name: String? = nil) -> Bool {
        slotContent?.children.contains { $0.attrs["slot"] == name } ?? false
    }

    // ── Compose: drop back into Stack XML ──
    public func render(_ xml: String) -> AnyView {
        let node = StackXML.parse(xml) ?? StackNode(tag: "vstack", attrs: [:], children: [])
        return AnyView(StackNodeView(node: node, store: store, env: env, item: item))
    }

    // ── State: two-way bindings to the (shared) store ──
    public var bind: Binder { Binder(store: store) }
    public struct Binder {
        let store: StackStore
        // Path-aware, matching `set:` / `{{ }}`: `bind="x"` a flat var · `bind="user.email"` the
        // `email` key of the `user` object var · `bind="global.x"` the app store.
        public func string(_ key: String) -> Binding<String> {
            Binding(get: { JSE.string(JSE.eval(key, store: store, item: nil)) },
                    set: { store.writeBound(key, $0) })
        }
        public func int(_ key: String) -> Binding<Int> {
            Binding(get: { let d = JSE.number(JSE.eval(key, store: store, item: nil)) ?? 0
                           return (d.isFinite && abs(d) < 9e18) ? Int(d) : 0 },
                    set: { store.writeBound(key, $0) })
        }
        public func double(_ key: String) -> Binding<Double> {
            Binding(get: { JSE.number(JSE.eval(key, store: store, item: nil)) ?? 0 },
                    set: { store.writeBound(key, $0) })
        }
        public func bool(_ key: String) -> Binding<Bool> {
            Binding(get: { JSE.truthy(JSE.eval(key, store: store, item: nil)) },
                    set: { store.writeBound(key, $0) })
        }
        public func list(_ key: String) -> [[String: Any]] { store.list(JSE.normalizeScope(key)) }   // `dsx.variable.x` → `x` (a bound list carries the namespace)
    }

    // ── Bind helpers (scope-aware: `item.x` is row-local, else path-aware into the store) ──
    /// Read a bound value, ROW-LOCAL first: `bind="item.x"` reads the current row's `x`; otherwise
    /// PATH-AWARE (reads like `{{ }}`) — `bind="user.email"` reads the `email` key of the `user`
    /// object var, `bind="global.x"` the app store, `bind="x"` a flat var. For two-way inputs.
    public func boundValue(_ key: String) -> Any? {
        let k = Self.rowKey(key)
        if k.hasPrefix("item."), let it = item { return it[String(k.dropFirst(5))] }
        return JSE.eval(key, store: store, item: item)
    }
    /// Write a bound value back where it came from: a row field (`item.x` / `dsx.this.x`) edits the
    /// row in place (via the write-back path the owning list installed) — so an input over a
    /// `<list bind="todos">` editing `dsx.this.name` mutates that element of the `todos` array var,
    /// reactively. Else PATH-AWARE — `user.email` edits the object var's key, `global.*`/`route.*`
    /// the app store, `x` a flat var.
    public func setBound(_ key: String, _ value: Any) {
        // `on:change` for ANY bound element: read the prior value, write, and if the value
        // ACTUALLY changed run this element's `on:change`. The inputs (textfield/toggle/pager)
        // no longer fire it themselves — this single seam is the source of truth, so a `<text
        // bind=>`, a custom drag-driven control, anything two-way also emits `change`. Two guards
        // keep it loop-safe: (1) only when the new value differs from the old (`JSE.equals` —
        // scalar-exact, structures by value), so an idempotent re-write is silent; (2) `changeDepth`
        // — a write the change handler ITSELF makes (incl. writing this same key back) won't
        // re-enter `on:change`, so a handler that touches its own bound state can't ping-pong.
        let fireChange = attrs["on:change"] != nil && store.changeDepth == 0
        let before: Any? = fireChange ? boundValue(key) : nil
        let k = Self.rowKey(key)
        if k.hasPrefix("item."), let rw = rowWrite { rw(String(k.dropFirst(5)), value) }
        else { store.writeBound(k, value) }
        guard fireChange, !JSE.equals(before, value) else { return }
        store.changeDepth += 1
        run("change")
        store.changeDepth -= 1
    }

    /// Normalize a bind key for ROW routing: `dsx.this.x` / `dsx.item.x` → `item.x` (the current
    /// `<list>`/`<grid>` row), so the `dsx.this` spelling row-binds exactly like `item.`. Other
    /// `$`-aliases normalize via `normalizeScope`. `dsx.this` is row-local *here* (an input's scope is
    /// its row) even though the engine leaves bare `dsx.this` context-dependent elsewhere.
    static func rowKey(_ key: String) -> String {
        if key == "dsx.this" { return "item" }
        if key.hasPrefix("dsx.this.") { return "item." + String(key.dropFirst(9)) }
        return JSE.normalizeScope(key)
    }

    // ── Act — run this element's `on:<event>` action (the markup action verbs) ──
    /// Run `on:<event>` (default `tap`): a JSE action body — `dsx.event(…)`, `dsx.module.s.m(…)`, state writes, `fetch:`/`resolve:`/`error:`
    /// and `;`-sequences, with `arg:*` attributes as the payload. The interactive primitive a
    /// native control (`button`/`pressable`/…) fires from its gesture.
    public func run(_ event: String = "tap") {
        guard let action = attrs["on:\(event)"] else { return }
        // Declarative debounce/throttle: `on:tap.debounce="300"` / `on:submit.throttle="1000"`.
        // No modifier → an immediate run (unchanged). The control's tag + event key the gate, so
        // two debounced controls keep independent windows.
        env.runGated(action, item: item, args: eventPayload,
                     debounceMs: JSERunner.gateMs(attrs, event: event, kind: "debounce"),
                     throttleMs: JSERunner.gateMs(attrs, event: event, kind: "throttle"),
                     gateKey: (componentTag ?? "ctl") + "." + event)
    }

    /// `href=` — the ANCHOR attribute (/web/04): after `on:tap` (if any), a tap on an element
    /// carrying `href` navigates the route table — the declarative twin of
    /// `dsx.module.route.push({ path: <href> })`, identical on every renderer (the web renders
    /// a REAL crawlable `<a>`). `{{ }}` interpolates; an empty resolve is a no-op. The tappable
    /// controls call this beside `run()` in their tap action.
    public func followHref() {
        let path = string("href")
        guard !path.isEmpty else { return }
        env.run("dsx.module.route.push({ path: __href })", item: item, args: ["__href": path])
    }
    /// `arg:*` attributes → the event payload (interpolated + coerced to bool/number/string).
    private var eventPayload: [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in attrs where k.hasPrefix("arg:") {
            let s = JSE.interpolate(v, store: store, item: item)
            let value: Any
            if s == "true" { value = true } else if s == "false" { value = false }
            else if let d = Double(s) { value = d } else { value = s }
            out[String(k.dropFirst(4))] = value
        }
        return out
    }

    // ── Numeric layout attr + control sizing (the engine's `num` / `sized`, for controls) ──
    /// A numeric attr that may be `{{ }}`-interpolated → CGFloat, nil if absent/non-numeric.
    public func cgFloat(_ key: String) -> CGFloat? {
        guard let s = attrs[key] else { return nil }
        let r = s.contains("{{") ? JSE.interpolate(s, store: store, item: item) : s
        return Double(r).map { CGFloat($0) }
    }
    /// Frame a control's content to a declared `width`/`height` with a rectangular hit area
    /// (so the whole control is tappable, not just its glyph). No-op when neither is set.
    /// (TAP CONTROLS — button/pressable families — use `controlBox` below instead, which
    /// carries the FULL box geometry; `sized` remains for the other sized controls.)
    public func sized<V: View>(_ v: V) -> AnyView {
        if cgFloat("width") != nil || cgFloat("height") != nil {
            return AnyView(v.frame(width: cgFloat("width"), height: cgFloat("height")).contentShape(Rectangle()))
        }
        return AnyView(v)
    }
    /// A tap control's content framed to its FULL styled box — the same padding / fixed-frame /
    /// min-max / grow / anchor arms the style pipeline applies to every other element, applied
    /// INSIDE the control's tappable core (the Button label / gesture surface) plus a full-rect
    /// hit shape. StackStyle.apply skips those arms for `StackNodeView.tapControls`, so the
    /// geometry lands exactly once and the padded, grown box IS the button: a tap on the
    /// label-less side of a grow="width" button registers ("only the text taps" bug). The fill
    /// layers (background / surface / radius) still wrap outside — same bounds, so painted
    /// box == tappable box.
    public func controlBox<V: View>(_ v: V) -> AnyView {
        StackStyle.controlBox(AnyView(v), attrs: attrs, store: store, item: item, tag: componentTag)
    }

    // ── Global app state (DSXState): shared across every route / node + the web. ──
    /// `dsx.global.set("session.credits", 200)` / `dsx.global.get("session")`.
    /// Read in XML as `{{ global.session.credits }}` / `visible-if="global.session.premium"`.
    public var global: DSXGlobal { DSXGlobal() }

    // ── Shared context (live in-process handles, e.g. the webview) ──
    /// `dsx.shared.use("web") as? UIView` / `dsx.shared.provide("key", handle)`.
    public var shared: DSXShared { DSXShared() }

    // ── Out-of-band event bus (the native mirror of `window.despia.on`) ──
    /// A native SCREEN subscribes to any package's broadcasts by scheme, without
    /// knowing which events exist: `dsx.events.on("audio") { event, data in … }` (keep
    /// the handle, `cancel()` it). This is GLOBAL/cross-package — distinct from the
    /// LOCAL `event`/`on` below (this component ↔ its consumer). See DSXEvents.swift.
    public var events: DSXEvents { DSXEvents() }

    // ── Local component events (this component ↔ its consumer; NOT the global bus). ──
    /// Fire an event from this component → the consumer's `on:<name>`, else the host's
    /// `ui.on(name)`. Fire-and-forget (0..N), like `dispatchEvent`. The handler runs
    /// in its DECLARING env (see OnHandler) — a same-name re-raise inside it bubbles UP.
    public func event(_ name: String, _ rawPayload: [String: Any] = [:]) {
        // Stamp this component's identity so a consumer's `from:component=<tag>` filter can scope
        // to it (no bus — see JSERunner.stampFrom / OnHandler.from). `from:action` is for action
        // emitters; a native component stamps `{ type:"component", name:<tag> }`.
        let payload = JSERunner.stampFrom(rawPayload, type: "component", name: componentTag)
        // The payload IS the handler's `dsx.this` scope (matching dispatchEvent's same-env branch,
        // which runs `item: pay`): JSE resolves dsx.this.* from `item` only, so without the merge a
        // handler like on:clipSelected="x = dsx.this.id" read nil and wrote "" — silently. A
        // row-scoped consumer keeps its row fields; payload keys win on collision.
        if let e = env.onHandlers[name] {
            if e.accepts(payload) { e.env.run(e.action, item: (item ?? [:]).merging(payload) { _, new in new }, args: payload) }
        }
        else { store.handlers[name]?(payload) }
        store.anyHandlers.forEach { $0(name, payload) }               // ui.onAny wildcard taps see every event
        JSERunner.publishNative(name, payload, source: componentTag)  // scheme = this component's tag → dsx.events.on(tag) in Swift/Kotlin
    }
    /// Listen for a LOCAL component event (rare in native — usually you read a reactive
    /// prop / binding). For another package's broadcasts, use `dsx.events.on` above.
    public func on(_ name: String, _ handler: @escaping ([String: Any]) -> Void) {
        store.handlers[name] = handler
    }

    // ── Bus dispatch (native component → a module action, over the bus) ──
    /// Call a module action from native component code — the native twin of markup's
    /// `dsx.module.scheme.method(args)` / `call: scheme.method`. Routes through the SAME
    /// `ModuleRegistry` the JSE dispatch uses, so a component fires haptics, navigation, or any
    /// package action OVER THE BUS instead of reaching for UIKit / another module directly. This is
    /// the native-component → module bridge the safe context previously lacked (a component could
    /// only `event`/`broadcast`, never invoke a scheme). Accepts the dot-API form (`"haptic.medium"`,
    /// `"studio.moveClip"`) or a full `scheme://method` URL. Returns false if the scheme is
    /// unregistered. Args cross as the action's params (named).
    @discardableResult
    public func dispatch(_ call: String, _ args: [String: Any] = [:]) -> Bool {
        JSERunner.dispatchCarrier(JSERunner.normalizeCall(call),
                                  params: Bridge.Params(dict: args, onTerminal: { _ in })).handled
    }
    /// Fire a haptic through the `haptic` module — `light` | `medium` | `heavy` (impact) ·
    /// `success` | `warning` | `error` (notification). The DSX-native way for a component to give
    /// touch feedback (single owner: the Haptics module), not a private UIKit generator.
    public func haptic(_ style: String) { dispatch("haptic." + style) }
}

// MARK: - Privileged components (engine-powered: around children + data)

/// The context handed to a PRIVILEGED component — the structural orchestrators
/// (`list` / `grid` / `pager` / `tabs` / `scaffold`). A superset of the safe
/// `StackComponentContext`: the same reactive prop readers, PLUS the three engine powers the
/// safe tier deliberately withholds, which are exactly what an orchestrator needs:
///
///   1. **Child-node introspection** (`children`) — read each child's `tag` / side attrs
///      (`tabIcon`, `pin`) and render it. (`tabs` / `scaffold`.)
///   2. **Scoped per-row rendering + write-back** (`bound`) — a data-bound collection whose
///      rows each render the template in their OWN `item` scope and edit back in place.
///      (`list` / `grid` / `pager`.)
///   3. **The measuring flag** (`measuring`) — collapse scroll containers while a sheet sizes
///      its `.content` detent.
///
/// These powers are why an orchestrator can be a real, modular component instead of a
/// hardcoded engine `raw()` case. They ship COMPILED-IN (a privileged component is native
/// code, never OTA-loadable) — the safety boundary is "what new code may be downloaded,"
/// not "what a remote screen may use" (`<list>` is always usable; it ships in the binary).
/// See OpenSource/Documentation/reference/engine-capabilities.md → "Two capability tiers."
public struct PrivilegedStackComponentContext {
    let node: StackNode
    let attrs: [String: String]
    let store: StackStore
    let env: JSERunner
    let item: [String: Any]?
    let rowWrite: ((String, Any) -> Void)?
    private struct RenderRevision: Equatable {
        let local: UInt64
        let global: UInt64
        let cookies: UInt64
        static let initial = RenderRevision(local: 0, global: 0, cookies: 0)
    }
    private let renderRevision: RenderRevision

    init(node: StackNode, attrs: [String: String], store: StackStore, env: JSERunner,
         item: [String: Any]?, rowWrite: ((String, Any) -> Void)?) {
        self.init(
            node: node,
            attrs: attrs,
            store: store,
            env: env,
            item: item,
            rowWrite: rowWrite,
            renderRevision: .initial
        )
    }

    private init(node: StackNode, attrs: [String: String], store: StackStore, env: JSERunner,
                 item: [String: Any]?, rowWrite: ((String, Any) -> Void)?,
                 renderRevision: RenderRevision) {
        self.node = node
        self.attrs = attrs
        self.store = store
        self.env = env
        self.item = item
        self.rowWrite = rowWrite
        self.renderRevision = renderRevision
    }

    fileprivate func withRenderRevisions(local: UInt64, global: UInt64, cookies: UInt64) -> Self {
        PrivilegedStackComponentContext(
            node: node,
            attrs: attrs,
            store: store,
            env: env,
            item: item,
            rowWrite: rowWrite,
            renderRevision: RenderRevision(local: local, global: global, cookies: cookies)
        )
    }

    // ── Reactive prop readers (same semantics as the safe dsx; resolved on every read) ──
    public var attributes: [String: String] { attrs }
    public func has(_ key: String) -> Bool { attrs[key] != nil }
    public func string(_ key: String, _ fallback: String = "") -> String {
        attrs[key].map { JSE.interpolate($0, store: store, item: item) } ?? fallback
    }
    public func int(_ key: String, _ fallback: Int = 0) -> Int {
        guard let raw = attrs[key], let d = Double(JSE.interpolate(raw, store: store, item: item)) else { return fallback }
        return (d.isFinite && abs(d) < 9e18) ? Int(d) : fallback
    }
    public func bool(_ key: String, _ fallback: Bool = false) -> Bool {
        guard let raw = attrs[key] else { return fallback }
        let s = JSE.interpolate(raw, store: store, item: item)
        return s == "true" || (Double(s).map { $0 != 0 } ?? false)
    }
    /// A numeric layout attr that may be `{{ }}`-interpolated → CGFloat (the engine's `num`).
    public func cgFloat(_ key: String) -> CGFloat? {
        guard let s = attrs[key] else { return nil }
        let r = s.contains("{{") ? JSE.interpolate(s, store: store, item: item) : s
        return Double(r).map { CGFloat($0) }
    }

    /// True only during the throwaway pass that measures a sheet's `.content` detent, so a
    /// scroll container renders as its intrinsic content (no greedy full-screen height).
    public var measuring: Bool { env.measuring }

    /// Two-way state bindings to the shared store — the same Binder the safe dsx exposes, so an
    /// orchestrator can drive a scalar key (e.g. a `<pager value="index">` current page) and read
    /// it back. Path-aware, exactly like `bind=` / `{{ }}`.
    public var bind: StackComponentContext.Binder { StackComponentContext.Binder(store: store) }

    /// Run this element's `on:<event>` action (the markup verbs) with `arg:*` as payload —
    /// e.g. a list firing `on:reachEnd` when its last row appears. Mirrors the safe dsx's `run`.
    public func run(_ event: String) {
        guard let action = attrs["on:\(event)"] else { return }
        env.run(action, item: item, args: eventPayload)
    }

    /// Run this element's `on:<event>` with an EXPLICIT payload scope — the collection
    /// orchestrators' form: a list's swipe button / reorder reports the affected ROW, so the
    /// handler reads its fields directly (`on:delete="emails = emails.filter(e => e.id != id)"`).
    public func run(_ event: String, payload: [String: Any]) {
        guard let action = attrs["on:\(event)"] else { return }
        env.run(action, item: payload, args: payload)
    }

    /// Write a BOUND value through the same path-aware seam as bindings (`global.*` / `route.*` /
    /// surface vars) — the collection write-back an orchestrator needs (e.g. a reordered rows
    /// array back onto its `bind` key). An `item.*` key (a NESTED collection — a list bound to a
    /// parent row's field) writes through THIS component's row write-back, editing the parent row
    /// in place; writing it to the store would mint a phantom surface var named "item.…".
    public func setBound(_ key: String, _ value: Any) {
        if key.hasPrefix("item."), let rowWrite {
            rowWrite(String(key.dropFirst("item.".count)), value)
            return
        }
        store.writeBound(key, value)
    }

    /// Invoke a module action over the bus — the same native-component → module bridge the safe
    /// context has (dot-API `"haptic.medium"` / `"studio.moveClip"` or a full `scheme://method`
    /// URL; named args). Returns false when the scheme is unregistered.
    @discardableResult
    public func dispatch(_ call: String, _ args: [String: Any] = [:]) -> Bool {
        JSERunner.dispatchCarrier(JSERunner.normalizeCall(call),
                                  params: Bridge.Params(dict: args, onTerminal: { _ in })).handled
    }
    private var eventPayload: [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in attrs where k.hasPrefix("arg:") {
            let s = JSE.interpolate(v, store: store, item: item)
            if s == "true" { out[String(k.dropFirst(4))] = true }
            else if s == "false" { out[String(k.dropFirst(4))] = false }
            else if let d = Double(s) { out[String(k.dropFirst(4))] = d }
            else { out[String(k.dropFirst(4))] = s }
        }
        return out
    }

    /// Render an arbitrary node in an arbitrary data scope — THE privileged power: an
    /// orchestrator mints a child instance with its own `item` + write-back path.
    func render(_ n: StackNode, item: [String: Any]?, rowWrite: ((String, Any) -> Void)?) -> AnyView {
        AnyView(StackNodeView(node: n, store: store, env: env, item: item, rowWrite: rowWrite))
    }

    // ── 1. Child-node introspection ──
    /// One of the component's raw children: its `tag`, its side attrs (read with `attr`), and
    /// a `view` that renders it in the orchestrator's current scope.
    public struct Child: Identifiable {
        public let id: Int
        public let tag: String
        let attrs: [String: String]
        let make: () -> AnyView
        /// A raw (un-interpolated) side attribute on the child node: `tabIcon`, `pin`, …
        public func attr(_ key: String) -> String? { attrs[key] }
        /// Every raw attribute KEY on the child node — lets an orchestrator run an
        /// ALLOWLIST gate over the row template's own attrs (the List system-default
        /// gate) instead of probing a fixed name list. Raw means cascade-NOT-run:
        /// class/sheet styling is still folded later, at the row's own render.
        public var attrKeys: [String] { Array(attrs.keys) }
        public var view: AnyView { make() }
    }
    /// The component's children, each introspectable + renderable in the current scope.
    public var children: [Child] {
        node.children.enumerated().map { (i, child) in
            Child(id: i, tag: child.tag, attrs: child.attrs,
                  make: { [self] in render(child, item: item, rowWrite: rowWrite) })
        }
    }

    // ── 2. Scoped per-row rendering + write-back ──
    /// A data-bound collection resolved to its rows + a keyed, per-row renderer. The single
    /// row template is the component's first child; each row renders it in its own `item`
    /// scope, and edits to `item.*` write back in place (nested collections nest).
    public struct Bound {
        public let rows: [[String: Any]]
        public let keys: [String]                 // stable identity per row (the `key` field)
        let rowView: (String) -> AnyView?
        public var isEmpty: Bool { rows.isEmpty }
        /// The row template rendered for `key`, scoped to that row with write-back (nil if
        /// the key is gone or there is no template).
        public func row(_ key: String) -> AnyView? { rowView(key) }
    }
    /// Bind `bind="feed.data"` (global) or `bind="item.children"` (row-local) → a `Bound`.
    public func bound(_ bindKey: String, key field: String = "id") -> Bound {
        let (rows, ownerSet) = boundCollection(bindKey)
        let template = node.children.first
        // POSITIONAL keying: `key="index"` keys rows by position (data with no stable id —
        // chat messages, logs), and a row MISSING the key field falls back to its position
        // too (previously every keyless row keyed to "" — duplicate ForEach ids).
        let positional = (field == "index")
        let keys: [String] = rows.enumerated().map { i, r in
            if positional { return String(i) }
            let v = r[field].map { "\($0)" } ?? ""
            return v.isEmpty ? String(i) : v
        }
        let make: (String) -> AnyView? = { [self] k in
            guard let template else { return nil }
            let found: Int? = positional
                ? Int(k)
                : (rows.firstIndex(where: { "\($0[field] ?? "")" == k }) ?? Int(k))
            guard let i = found, rows.indices.contains(i) else { return nil }
            var row = rows[i]; row["index"] = Double(i)   // dsx.this.index / item.index — the row's position
            let writer: (String, Any) -> Void = (positional || rows[i][field] == nil)
                ? { f, v in var arr = rows; arr[i][f] = v; ownerSet(arr) }
                : rowWriter(k, field: field, source: rows, ownerSet: ownerSet)
            return render(template, item: row, rowWrite: writer)
        }
        return Bound(rows: rows, keys: keys, rowView: make)
    }

    // The collection read + per-row write-back machinery (the privileged internals an
    // orchestrator stands on — lifted out of the engine alongside the components).
    private func boundCollection(_ rawKey: String) -> (rows: [[String: Any]], set: ([[String: Any]]) -> Void) {
        let key = JSE.normalizeScope(rawKey)   // bind keys carry the namespace too: `dsx.variable.episodes` → `episodes`, `dsx.item.x` → `item.x`
        if key.hasPrefix("item."), let it = item {
            let lk = String(key.dropFirst(5))
            let raw = it[lk]
            let rows = JSE.asRows(raw)
            let rw = rowWrite
            return (rows, { new in rw?(lk, new) })
        }
        return (store.list(key), { store.setList(key, $0) })
    }
    private func rowWriter(_ id: String, field: String, source: [[String: Any]],
                           ownerSet: @escaping ([[String: Any]]) -> Void) -> (String, Any) -> Void {
        return { f, v in
            var arr = source
            if let i = arr.firstIndex(where: { "\($0[field] ?? "")" == id }) { arr[i][f] = v; ownerSet(arr) }
        }
    }
}

/// Base class for a PRIVILEGED native component (`list` / `grid` / `pager` / `tabs` /
/// `scaffold` / …). Identical registration to `GlobalStackComponent` (the launch class-walk
/// finds it, the same XML resolution drives it), but `body` receives the richer
/// `PrivilegedStackComponentContext` — the engine grants it scoped child rendering, child-node
/// introspection and collection write-back. Drop a folder under
/// `Components/Libraries/Mandatory/Structure/<Tag>/`.
open class PrivilegedStackComponent: NSObject {
    /// The XML tag (typically lowercase — these answer the structural tags `list`/`pager`/…).
    open class var tag: String { String(describing: self) }
    /// Extra tags this component also answers to (e.g. `["tabview"]` for `tabs`).
    open class var aliases: [String] { [] }
    /// Build the view from the privileged context.
    open class func body(_ dsx: PrivilegedStackComponentContext) -> AnyView { AnyView(EmptyView()) }
}

// MARK: - Reactive store

// (`StackFormula` moved to JSE.swift — the `logic` tier is self-contained; same type,
//  same module, every use here unchanged.)

/// The evaluator's state seam (JSE.swift `JSEState`, watch-runtime.md W1): the store IS the
/// app-side state surface — the nine members the protocol names are declared right below,
/// so conformance is free and the phone path is byte-for-byte what it was.
extension StackStore: JSEState {}

/// JSERunner needs named `<api>` handles, while the MOUNT owns their lifetime.
/// Keeping only weak references in the store avoids the cycle store → block → store,
/// and leaves exactly one strong owner per block: `StackSurface.apiBlocks` for the root
/// head, and the `MountedStackApi` of its `StackApiMountView` for every other position
/// (a component's head). Either way, when the owner goes the request is disposed and the
/// weak entry self-clears on the next observation pass.
private final class StackApiHandleRef {
    weak var value: ApiBlock?
    init(_ value: ApiBlock) { self.value = value }
}

final class StackStore: ObservableObject {
    /// Monotonic input token for native-component contexts. `@Published` invalidates the host, and
    /// this value makes the rebuilt context observably different without changing view identity or
    /// resetting a component's local `@State` / focus.
    private(set) var renderRevision: UInt64 = 0
    @Published var vars: [String: Any] = [:] {
        didSet {
            renderRevision &+= 1
            scheduleApiObservation()
        }
    }
    @Published var overrides: [String: [String: String]] = [:] {   // dsx.node(id) patches
        didSet { renderRevision &+= 1 }
    }
    var handlers: [String: ([String: Any]) -> Void] = [:]         // ui.on(event) { payload in … }
    var actions: [String: StackFormula] = [:]                     // named actions (optional params): <action as="x" foo="…">…</action> → do: x
    var actionDepth = 0                                           // guards runaway `do:` recursion (not @Published — no re-render)
    var computed: [String: String] = [:]                          // reactive formulas: <variable computed="true">
    var computedDepth = 0                                         // guards self-referential computed values
    var changeDepth = 0                                          // > 0 while an element's on:change handler runs — the bound-write seam (StackComponentContext.setBound) won't re-fire on:change for writes that handler itself makes (the ping-pong / write-loop guard)
    var initials: [String: Any] = [:]                             // declared defaults: <variable as="x">expr</variable> (set once)
    var formulas: [String: StackFormula] = [:]                    // parameterized reactive formulas: <formula as="x" foo="…">…uses foo…</formula>
    var functions: [String: Any] = [:]                            // user functions: function name(args){…} → a callable JSE.StackLambda (type-erased)
    var fnDepth = 0                                               // guards user-function recursion (capped at 32 — bounded, can't hang)
    var evalDepth = 0                                             // guards expression-evaluator recursion: a computed/<variable>/binding that reads itself (directly or transitively) would re-evaluate forever and overflow the native stack (a 2-frame mutual recursion → device crash). Capped in JSE.eval — past it the expression yields nil + logs (bounded, never fatal).
    var actionEvents: [String: String] = [:]                      // the current action call's event callbacks: dsx.event('x') → handler body (from dsx.action.x(args, { x: () => … }))
    var actionNameStack: [String] = []                            // the named <action>s currently executing (innermost = .last) — so a `dsx.event(…)` raised from an action body stamps `__from = { type:"action", name }`, the modern (no-bus) twin of the old `<listener from:action=>` source filter
    var timers: [String: DispatchWorkItem] = [:]                  // keyed setTimeout/setInterval work items: a same-key timer cancels/replaces the pending one (debounce); all cancelled when the surface's store deallocates
    var anyHandlers: [(String, [String: Any]) -> Void] = []       // ui.onAny wildcard taps — see EVERY event the surface raises (analytics/relay/logging), alongside the named ui.on handlers
    var classes: [String: [String: String]] = [:]                // reusable style classes: <style as="card" …/> → merge via class="card"
    var attrDefaults: [String: String] = [:]                     // declared prop defaults: <attribute as="x" default="…"/> → dsx.attribute.x falls back here when the consumer omits it
    var expected: Set<String> = []                               // declared seed contract: <expects variable="x"/> in the root <head> — the mounting side must ui.variable/vars: these (missing-seed diagnostic in StackHead.hoist)
    var watchBudget = 0                                          // <watch> loop backstop — fires within one runloop; reset async after the cascade settles (see WatchView)
    var watchResetScheduled = false                             // ensures a single async reset of watchBudget per runloop tick
    var flowSignal: String? = nil                               // statement control flow in flight: "break" | "continue" | "return" | "throw" — consumed by its construct
    var thrownValue: Any? = nil                                 // the `throw expr` payload (becomes the `catch (e)` binding)
    var returnValue: Any? = nil                                 // RETURNING ACTIONS: the callee's `return <expr>` value (the action-call branch scopes it per call; an AWAITING `dsx.action` caller binds { ok:true, data } from it)
    var entryBody: String = ""                                  // the entry/action body currently running — a throw keeps the THROWING body here (snippet in the uncaught report)
    var loopWork = 0                                            // for/while iteration ledger per user action — JSE stays BOUNDED (cap = JSERunner.loopCap; reset per entry event)
    var tryDepth = 0                                            // > 0 while a `try` body runs: a call to an UNAVAILABLE package / UNDEFINED action throws → catch (universal feature-detection). 0 = lenient (silent no-op).
    struct PendingEventReply { let bind: String?; let rest: String; let locals: [String: Any]; let args: [String: Any]; let handlers: [String: String] }
    var eventReplies: [Int: PendingEventReply] = [:]           // `await dsx.event` correlation token → the suspended caller's continuation; a consumer's on:<event> resolve:/error: (while handling) replays the matching one (runAwaitEvent / resumeAwaitEvent)
    var nextEventReply = 0                                      // monotonic token source — each `await dsx.event` mints a unique reply id so N concurrent requests route back to the right awaiter
    /// The kernel nav FRAME this surface renders in (the Router stamps pushed/presented
    /// surfaces, RouterHost its per-frame URL surfaces). The statement runner forwards it
    /// on every package call as the `__frame` framing key so a frame-scoped verb
    /// (route.chrome) can target the CALLING screen: SwiftUI re-fires `on:appear` when a
    /// covered screen resurfaces during an interactive back-swipe, so "whatever frame is
    /// top right now" is precisely the wrong target mid-gesture. nil = not a nav frame
    /// (a mounted overlay, a bare dsx.render surface) — those callers keep top-frame
    /// semantics.
    var frameId: Int?
    /// This surface's root declared `settle="manual"` — the ROOT-ONLY opt-in that says "this
    /// screen reports readiness ITSELF (`dsx.screen.settled()`) instead of settling on its first
    /// render". Recorded here (not reported straight to `DSXScreenReadiness`) because a surface is
    /// built BEFORE its frame mounts — the Router stamps `frameId` after `StackSurface.init`, and a
    /// `manual` for an unknown frame is a no-op by design. The frame host (`RouterHost.ScreenFrame`)
    /// reads this flag right after `mount`, which is exactly the "registered between mount and the
    /// first rendered" ordering `Conformance/lifecycle/README.md` requires of every renderer.
    var settleManual = false
    /// This surface MOUNTED the app's `<DSXWebView/>` web surface — the HYBRID ordering gate
    /// (`Conformance/lifecycle/readiness.json` rule 9). A native frame that hosts a web view must
    /// not report settled while that view is still blank: the splash would reveal over nothing and
    /// the page's own `domStart` would re-open the shell's phase a beat later. Recorded here (not
    /// reported straight to `DSXScreenReadiness`) for the same reason `settleManual` is — the
    /// component renders BEFORE the frame host's `onAppear` mounts the frame, and a gate for an
    /// unknown frame is a no-op by design. NOT author-opt-in: `<DSXWebView/>` sets it itself.
    var hostsWebSurface = false
    fileprivate var apiHandles: [String: StackApiHandleRef] = [:]
    private var apiObservationScheduled = false

    /// The surface's api transport, cache and partition. They live on the STORE rather than
    /// on StackSurface because `<api>` mounts from the RENDER pass (StackApiMountView)
    /// wherever the tag appears — including inside a component template, which the surface
    /// never sees. StackSurface.init sets these before the first render.
    var apiFetch: ApiBlock.AsyncFetch?
    var apiCache: ApiBlock.Cache?
    var apiCachePartition: (ApiBlock.FetchRequest) -> String = { _ in "" }

    /// Hoisted root `<head>` `<api>` declarations, mounted by StackSurface once the whole
    /// head pass has registered every variable/action they might reference.
    var apiDeclarations: [StackNode] = []

    /// /web/11: the root head's `<api>` DAG — ONE graph for the hoisted scope, the
    /// `packages/dom/src/mount.ts` twin. With a graph a block does NOT fire on
    /// construction: every sibling mounts, then `start()` runs the runnable ones, so a
    /// `needs=` edge, an `upstream-error` and the declared cycle error all behave here
    /// exactly as the corpus pins them.
    private var apiGraph: ApiGraph?
    /// The names the graph owns. A block mounted from the RENDER pass that is NOT a
    /// hoisted root declaration (a COMPONENT's own head) is its own scope and gets no
    /// graph — handing it the surface graph would invent edges the compiler never saw.
    private var apiGraphNames: Set<String> = []

    /// Build the hoisted scope's graph. Called by StackSurface AFTER the head pass and
    /// BEFORE the first `mountApiBlock`, so every block can attach as it is constructed.
    func buildApiGraph() {
        let specs = apiDeclarations.map { $0.attrs }
        apiGraph = ApiGraph(specs: specs)
        apiGraphNames = Set(specs.compactMap { $0["as"] }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty })
    }

    /// Mount is over — release the runnable blocks (no-op when the surface declared none).
    func startApiGraph() { apiGraph?.start() }

    /// THE one construction path for an `<api>` block, shared by both entry points:
    /// StackSurface (the root head, at surface construction) and StackApiMountView (any
    /// other position, at render — which is the only way a COMPONENT's head is reached).
    ///
    /// The name is claimed BEFORE anything is built, because `ApiBlock.init` seeds the
    /// reserved envelope paths and schedules the first auto-fetch. Probing first is what
    /// makes the two entry points safe to overlap: when the root's own head renders, the
    /// name is already owned, so nothing is constructed and no second request is issued.
    /// First declaration wins — the head-hoist law, and the Kotlin twin's
    /// `StackStore.claimApiHandle` (JseRunner.kt) rule.
    ///
    /// Returns the block so the caller can own its lifetime; the registry's own reference
    /// is weak, so a returned block that nobody retains is correctly torn down.
    func mountApiBlock(attrs: [String: String], env: JSERunner, item: [String: Any]?) -> ApiBlock? {
        let name = (attrs["as"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let url = (attrs["url"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !url.isEmpty else {
            kernelLog("[Stack] <api> requires non-empty as= and url=; declaration ignored")
            return nil
        }
        guard apiHandles[name]?.value == nil else { return nil }   // already owned — silent, this is the re-render path
        // /web/11: only a HOISTED root declaration belongs to the surface graph. A block
        // mounted at render from a component's own head is a different scope, so it keeps
        // the graph-less contract (fires on construction, value-presence gating only).
        let scopeGraph = apiGraphNames.contains(name) ? apiGraph : nil
        let block = ApiBlock(
            spec: attrs,
            store: self,
            item: item,
            fetchAsync: apiFetch ?? ApiBlock.urlSessionTransport(baseURL: nil),
            cache: apiCache,
            cachePartition: apiCachePartition,
            onEvent: { event, payload in
                guard let handler = attrs["on:\(event)"], !handler.isEmpty else { return }
                env.run(handler, item: payload, args: payload)
            },
            graph: scopeGraph
        )
        scopeGraph?.attach(block, name: name)
        apiHandles[name] = StackApiHandleRef(block)
        return block
    }

    /// Release a claim on unmount — identity-checked, so a late teardown can never evict
    /// a newer owner of the same name.
    func releaseApiHandle(_ name: String, _ block: ApiBlock) {
        guard apiHandles[name]?.value === block else { return }
        apiHandles[name] = nil
        if apiGraphNames.contains(name) { apiGraph?.detach(name) }
    }

    /// Native's equivalent of the web signal effect: coalesce all store publishes
    /// in a runloop turn, then let each block compare its MATERIALIZED request key.
    /// The hop also prevents an API envelope write from publishing recursively
    /// inside another SwiftUI/store update.
    private func scheduleApiObservation() {
        guard !apiHandles.isEmpty else { return }
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.scheduleApiObservation() }
            return
        }
        guard !apiObservationScheduled else { return }
        apiObservationScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.apiObservationScheduled = false
            self.apiHandles = self.apiHandles.filter { $0.value.value != nil }
            for ref in self.apiHandles.values { ref.value?.storeChanged() }
        }
    }

    func set(_ key: String, _ value: Any) {
        // MAIN-THREAD ONLY (`vars` is @Published — it drives SwiftUI). A stray background
        // write — a package calling `surface.set` from a purchase/ad/fetch completion off
        // its Task — re-dispatches here instead of corrupting the AttributeGraph. Those
        // corruptions don't crash at the write; they crash LATER, at the next big tree
        // change (a dismissal, a sheet present) — brutal to trace without this guard.
        guard Thread.isMainThread else { DispatchQueue.main.async { self.set(key, value) }; return }
        // No-op writes don't re-render. EVERY mutation of `vars` re-renders the whole
        // surface (@Published), and hot paths re-write unchanged values constantly —
        // `controls = true` on every tap, measure dicts on every layout pass, repeated
        // `buffering = false` — so equal-value writes return here. NSObject.isEqual is
        // deep over the bridged plist types (String/NSNumber/Bool/array/dict).
        if let o = vars[key] as? NSObject, let n = value as? NSObject, o.isEqual(n) { return }
        if JSETrace.shared.enabled { JSETrace.shared.state(key, old: vars[key], new: value) }
        vars[key] = value
    }

    /// Publish several TOP-LEVEL values as one observable snapshot. Kernel state machines whose
    /// fields must become visible together (notably Router's `nav` + `route`) use this instead of
    /// calling `set` twice: two @Published writes schedule two full SwiftUI render passes and can
    /// expose a frame where the back stack and current route disagree. The whole update is
    /// main-thread-only, no-op-aware, bounded by the same container cap as `setPath`, and emits
    /// exactly one `vars` publication regardless of the number of changed keys.
    func setTopLevelAtomically(_ values: [String: Any]) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.setTopLevelAtomically(values) }
            return
        }
        guard !values.isEmpty else { return }

        let addedKeys = values.keys.reduce(into: 0) { count, key in
            if vars[key] == nil { count += 1 }
        }
        guard vars.count + addedKeys <= DsxStatePathPolicy.maxContainerEntries else { return }

        var next = vars
        var changed = false
        for (key, value) in values {
            if let old = vars[key] as? NSObject,
               let replacement = value as? NSObject,
               old.isEqual(replacement) {
                continue
            }
            if JSETrace.shared.enabled { JSETrace.shared.state(key, old: vars[key], new: value) }
            next[key] = value
            changed = true
        }
        if changed { vars = next }
    }

    func list(_ key: String) -> [[String: Any]] {
        if let live = vars[key] { return JSE.asRows(live) }
        // A collection with no LIVE var under the flat key must BIND the way it reads in
        // {{ }}: fall back through the JSE lookup — dotted paths ("vars.presets"), computed
        // variables and <head>-declared initials (`<variable as="rows">return […]`). vars[key]
        // only exists after a live `set:`/`push:` write — without this fallback a list bound
        // to a declared array rendered permanently EMPTY while every interpolation of the
        // same name worked (the demo launcher / dev panel symptom).
        return JSE.asRows(JSE.eval(key, store: self, item: nil))
    }
    func setList(_ key: String, _ items: [[String: Any]]) {
        guard Thread.isMainThread else { DispatchQueue.main.async { self.setList(key, items) }; return }
        if let o = vars[key] as? NSArray, o.isEqual(items as NSArray) { return }   // same rows → no re-render
        vars[key] = items
    }

    var sockets: [String: JSESocket] = [:]                        // keyed WebSockets (same key replaces; all closed when the surface's store deallocates)
    deinit {
        timers.values.forEach { $0.cancel() }          // a dismissed surface never leaves a timer/interval ticking
        sockets.values.forEach { $0.close() }          // …or a WebSocket connected (route changes can't leak connections)
    }
}

// MARK: - Head hoisting

/// Mount-time registration of a surface root's `<head>` declarations (see
/// OpenSource/Documentation/reference/dsx-anatomy.md). Declarations become facts of the
/// surface BEFORE SwiftUI evaluates anything, instead of render side effects in document
/// order. The `<head>` node itself stays a transparent container when rendered — every
/// registration below is idempotent, and view-backed declarations (`<watch>`,
/// `<attribute on:change>`) still mount as views when its children render.
enum StackHead {
    static func hoist(_ root: StackNode, store: StackStore, scope: String?) {
        // `settle="manual"` — the ROOT-ONLY readiness opt-in (the slot `exit` occupies). Read
        // FIRST, before any declaration registers, so the intent is a fact of the surface from
        // its very first render pass. Recorded on the store (the frame may not have mounted yet)
        // AND reported straight away when this surface already knows its frame.
        if declaresManualSettle(root, scope: scope) {
            store.settleManual = true
            DSXScreenReadiness.manual(store.frameId)
        }
        for head in root.children where head.tag == "head" {
            // G4 unified input (dsx-game.md §2): the head `<input as=… keys= gamepad= touch=
            // axis=/>` device declarations register as ONE table keyed by the owning store,
            // so re-hoisting a surface replaces its bindings instead of stacking duplicates.
            // The vocabulary, the diagnostics and the fold all live in the corpus-pinned
            // kernel (SceneInput.swift); this is only the hoist.
            let inputs = head.children.filter { $0.tag == "input" }.map { $0.attrs }
            if !inputs.isEmpty { DsxInputRuntime.shared.register(owner: store, declarations: inputs) }
            for decl in head.children { register(decl, store: store, scope: scope) }
        }
        guard !store.expected.isEmpty else { return }
        // Missing-seed diagnostic, deferred one tick: the mounting side seeds via
        // ui.variable / dsx.component.push(vars:) right after creating the surface
        // ("seed before you push"), so check only after the current runloop turn.
        DispatchQueue.main.async { [weak store] in
            guard let store else { return }
            for name in store.expected.sorted() where store.vars[name] == nil && store.initials[name] == nil {
                kernelLog("[Stack] <expects variable=\"\(name)\"/> was never seeded — the first frame reads it empty (seed before you push; see dsx-anatomy.md)")
            }
        }
    }

    /// Does this surface root opt OUT of settling on first render — `settle="manual"`?
    ///
    /// `settle` is a ROOT-ONLY universal attribute (enum `auto` | `manual`, `auto` never written),
    /// so it is known the instant the root node is read — always before the post-render `rendered`
    /// hop. The PAGE ROOT is the surface root resolved THROUGH component references (a pushed
    /// frame's root is the reference `<Name/>`; the page root is that template's root), the same
    /// bounded walk `StackRootView.hostCanvasSpec` uses for the host canvas — so a screen authored
    /// as a component declares `settle` on its own root, not on every call site.
    static func declaresManualSettle(_ root: StackNode, scope: String?) -> Bool {
        var node = root
        var scope = scope
        var hops = 0
        if node.attrs["settle"] == "manual" { return true }
        while hops < 8, let (template, owningScope) = StackComponents.resolve(node.tag, pkg: scope) {
            if template.attrs["settle"] == "manual" { return true }
            node = template
            scope = owningScope ?? scope
            hops += 1
        }
        return false
    }

    private static func register(_ node: StackNode, store: StackStore, scope: String?) {
        let a = node.attrs
        switch node.tag {
        case "action":
            JSE.registerFunctions(node.text ?? "", store: store)
            if let name = a["as"] {
                var inputs = a; inputs["as"] = nil; inputs["id"] = nil
                store.actions[name] = StackFormula(inputs: inputs, body: node.text ?? "")
            }
        case "variable", "var", "let":
            JSE.registerFunctions(node.text ?? "", store: store)
            if let name = a["as"] {
                if a["computed"] == "true" {
                    store.computed[name] = node.text ?? ""
                } else if store.initials[name] == nil {
                    store.initials[name] = JSE.evalBlock(node.text ?? "", store: store, item: nil) ?? ""
                }
            }
        case "formula":
            JSE.registerFunctions(node.text ?? "", store: store)
            if let name = a["as"] {
                var inputs = a; inputs["as"] = nil; inputs["id"] = nil
                store.formulas[name] = StackFormula(inputs: inputs, body: node.text ?? "")
            }
        case "input":
            // G4 unified input: handled as a GROUP in hoist() (all of a head's `<input>`
            // declarations register as one table, keyed by the owning store) — never here,
            // where a per-declaration call would replace the table each time.
            break
        case "script", "functions":
            // the `global` attribute — PRESENCE is the switch; canonical spelling
            // global="true" — routes the block into the app-wide GLOBAL FUNCTION
            // LIBRARY (js-core.md "Shared logic"; corpus Conformance/functions):
            // `<functions global="true">` registers once for EVERY surface, last
            // write wins; a plain block stays surface-local exactly as before.
            // Twins: :core registerHeadFunctions · web head.globalScripts.
            if a["global"] != nil { JSE.registerGlobalFunctions(node.text ?? "") }
            else { JSE.registerFunctions(node.text ?? "", store: store) }
        case "attribute":
            if let name = a["as"], let def = a["default"], store.attrDefaults[name] == nil {
                store.attrDefaults[name] = def
            }
        case "style":
            if let name = a["as"] {
                var def = a; def["as"] = nil; def["id"] = nil
                store.classes[name] = def
            }
        case "api":
            // Data declarations mount AFTER this whole head pass, so every
            // variable/action/function they reference already exists and the first
            // request cannot observe a half-registered scope. (A component's head is
            // never hoisted — it mounts at render, via StackApiMountView.)
            if let name = a["as"], !name.isEmpty, let url = a["url"], !url.isEmpty {
                if store.apiDeclarations.contains(where: { $0.attrs["as"] == name }) {
                    kernelLog("[Stack] duplicate <api as=\"\(name)\"> ignored (lint_dsx should reject this)")
                } else {
                    store.apiDeclarations.append(node)
                }
            } else {
                kernelLog("[Stack] <api> requires non-empty as= and url=; declaration ignored")
            }
        case "component":
            if let name = a["as"], !name.isEmpty {
                let template = node.children.count == 1
                    ? node.children[0]
                    : StackNode(tag: "vstack", attrs: [:], children: node.children)
                StackComponents.defineNode(name, template: template, scope: scope)
            }
        case "expects":
            if let name = a["variable"], !name.isEmpty { store.expected.insert(name) }
        default:
            break   // <event> is purely declarative; <watch>/<attribute on:change> mount as views
        }
    }
}

// MARK: - Surface (returned by dsx.render) + handles

public final class StackSurface {
    let store = StackStore()
    private let root: StackNode
    private let scope: String?
    private let dsx: Context?
    /// The root head's blocks. The store's own references are weak, so this array is their
    /// one lifecycle owner — a component's blocks are owned by their mount view instead.
    private var apiBlocks: [ApiBlock] = []
    weak var webView: UIView?
    private var overlayContainer: PassthroughView?

    /// FORCE this surface's SwiftUI color scheme. A UIKit `overrideUserInterfaceStyle` on the
    /// controller does NOT reach SwiftUI materials (`surface="glass"`) or `Color(UIColor.label)`
    /// on iOS 26, so a package that needs a FIXED appearance (e.g. the always-dark player) sets
    /// this BEFORE first accessing `controller`. `.unspecified` (default) = follow the system.
    public var forcedStyle: UIUserInterfaceStyle = .unspecified

    /// The view controller a package presents (`.screen` mode). Presented pages inherit the
    /// window metrics published by the Router/window root; they must not replace those values with
    /// a sheet or overlay's smaller presentation bounds.
    public lazy var controller: UIViewController = makeController(publishesWindowMetrics: false)

    /// A controller installed as a UIWindow root (boot gates and the deterministic UI fixture).
    /// Direct roots do not sit beneath RouterHost, so they must publish their own live window
    /// geometry for `dsx.screen.*` on rotation, Split View, and Stage Manager resize.
    public lazy var windowRootController: UIViewController = makeController(publishesWindowMetrics: true)

    private func makeController(publishesWindowMetrics: Bool) -> UIViewController {
        let rootView = StackRootView(
            root: root,
            store: store,
            env: env,
            colorScheme: StackSurface.scheme(for: forcedStyle)
        )
        let hosted: AnyView
        if publishesWindowMetrics {
            hosted = AnyView(rootView.modifier(DSXScreenMetrics()))
        } else {
            hosted = AnyView(rootView)
        }
        return UIHostingController(rootView: hosted)
    }

    /// Map a UIKit interface style to a SwiftUI `ColorScheme?` (`.unspecified` → nil = adapt).
    static func scheme(for style: UIUserInterfaceStyle) -> ColorScheme? {
        switch style { case .dark: return .dark; case .light: return .light; default: return nil }
    }

    private lazy var env = JSERunner(store: store, webView: webView, scope: scope, dsx: dsx)

    /// Present this surface from `presenter`, `.overFullScreen` so the web view
    /// shows through. Pass `animated: false` and an `enter=` slide token to drive the
    /// page transition at the UIKit level — the reliable twin of `dismiss`'s `exit=`:
    /// the presented controller's view starts off the matching screen edge and springs
    /// to place. (A whole presented PAGE slides as one piece here, not via SwiftUI
    /// `StackEntry` — which can flash an off-layout first frame on a full-screen present.)
    /// `slide-right` enters from the right (paired with `exit="slide-right"`, the iOS push).
    public func present(from presenter: UIViewController, animated: Bool = true, enter: String? = nil) {
        controller.modalPresentationStyle = .overFullScreen
        presenter.present(controller, animated: animated)
        // Drive the enter as a UIKit transform (mirrors dismiss's exit): set the start
        // offset SYNCHRONOUSLY — before the first render commit, so there's no identity
        // flash — then spring to identity. Off-screen distance is the full screen, like
        // StackEntry, so the page travels in from the very edge.
        if let enter, !enter.isEmpty, let v = controller.viewIfLoaded {
            // Animate relative to the app window, not the physical display. On iPad the
            // window can be substantially smaller in Split View or Stage Manager.
            let screen = v.window?.bounds ?? presenter.view.window?.bounds ?? presenter.view.bounds
            switch enter {
            case "slide-right":  v.transform = CGAffineTransform(translationX: screen.width,  y: 0)
            case "slide-left":   v.transform = CGAffineTransform(translationX: -screen.width, y: 0)
            case "slide-top":    v.transform = CGAffineTransform(translationX: 0, y: -screen.height)
            case "slide-bottom": v.transform = CGAffineTransform(translationX: 0, y: screen.height)
            default: break
            }
            if v.transform != .identity {
                UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.88,
                               initialSpringVelocity: 0.4, options: [.curveEaseOut, .allowUserInteraction],
                               animations: { v.transform = .identity })
            }
        }
        // `dismissEdge="left"` on the ROOT element → the iOS back-swipe, declaratively, for ANY
        // presented DSX page: a pan that STARTS at the left screen edge follows the finger 1:1,
        // dismisses past ⅓ width (or a fast fling) and runs the root's `on:edgeDismiss` action
        // (else just dismisses); otherwise it springs back. Pairs with enter="slide-right".
        if root.attrs["dismissEdge"] == "left" {
            let dismisser = StackEdgeDismiss(controller: controller) { [weak self] in
                guard let self else { return }
                if let action = self.root.attrs["on:edgeDismiss"] { self.env.run(action, item: nil) }
                else { self.controller.dismiss(animated: false) }
            }
            edgeDismiss = dismisser                                   // retain (the gesture target)
            let edge = UIScreenEdgePanGestureRecognizer(target: dismisser, action: #selector(StackEdgeDismiss.handle(_:)))
            edge.edges = .left
            controller.view.addGestureRecognizer(edge)
        }
    }
    private var edgeDismiss: StackEdgeDismiss?

    /// Dismiss this surface honoring the root's `exit=` animation — the declarative twin of
    /// `enter=` (same vocabulary: slide-top/bottom/left/right, fade). `exit="slide-right"` slides
    /// the page back out to the right (the reverse of an enter="slide-right" page push), exactly
    /// like the iOS back transition; no exit attr (or `animated: false`) → a plain dismiss.
    /// If the view is already off-screen (the edge-dismiss gesture slid it out), the animation
    /// completes instantly — the two paths compose.
    public func dismiss(animated: Bool = true, completion: (() -> Void)? = nil) {
        let exit = root.attrs["exit"] ?? ""
        guard animated, !exit.isEmpty, let v = controller.viewIfLoaded else {
            controller.dismiss(animated: animated, completion: completion); return
        }
        let w = v.bounds.width, h = v.bounds.height
        // Capture the CONTROLLER strongly, not the surface: a package's close path drops
        // its surface reference immediately (`surface = nil`), so by the time the 0.28s
        // exit lands a weak-self completion is gone — the presented controller would stay
        // up forever, invisible and eating every touch (the app reads as frozen/crashed).
        let vc = controller
        UIView.animate(withDuration: 0.28, delay: 0, options: .curveEaseIn, animations: {
            switch exit {
            case "slide-right":  v.transform = CGAffineTransform(translationX: w, y: 0)
            case "slide-left":   v.transform = CGAffineTransform(translationX: -w, y: 0)
            case "slide-top":    v.transform = CGAffineTransform(translationX: 0, y: -h)
            case "slide-bottom": v.transform = CGAffineTransform(translationX: 0, y: h)
            default:             v.alpha = 0
            }
        }, completion: { _ in vc.dismiss(animated: false, completion: completion) })
    }

    // MARK: push — open this surface as a real navigation FRAME (vs. present() as a modal)

    /// Surfaces a module pushed onto the kernel nav stack, keyed by the Router's frame id. The host
    /// (RouterHost) renders the held surface for that frame — so a mounted component becomes a real
    /// route, inheriting the NavigationStack push transition + interactive edge-swipe-back + the live
    /// web view underneath, with its OWN store/handlers intact (the same `store` the module wired).
    /// Main-thread only (navigation + SwiftUI). Mirrors how `DSXWebView.host` is a single held web view
    /// referenced by frames — here each native frame holds its own surface.
    static var pushedFrames: [Int: StackSurface] = [:]

    /// Runs ONCE when this surface's frame leaves the stack (a back-swipe, a `route.pop`, or a replace).
    /// The owning module sets it via `push(onPop:)` — its teardown (stop playback, persist, emit closed),
    /// so a route close runs exactly the cleanup the modal dismiss did.
    var onPop: (() -> Void)?

    /// This surface's screen content as a `View`, for the host to render INSIDE a nav frame — the SAME
    /// tree `controller` wraps (same `store`/`env`, so the module's variables + `.on` handlers stay
    /// live), just hosted in the NavigationStack instead of a modally-presented UIHostingController.
    /// The parameterless spelling is the MODAL consumers' (ModalFrame + the overlay layer — no host
    /// canvas: sheets/covers keep the elevated system backdrop, overlays stay transparent); the host's
    /// ROUTE frames pass `canvas: true`, so a page root's declared background paints the full-bleed
    /// host canvas behind the screen (StackRootView.routeCanvas — the canvas-seam fix).
    var frameView: AnyView { frameView(canvas: false) }
    func frameView(canvas: Bool) -> AnyView {
        AnyView(StackRootView(root: root, store: store, env: env,
                              colorScheme: StackSurface.scheme(for: forcedStyle), routeCanvas: canvas))
    }

    /// Open this surface as a navigation ROUTE instead of a modal: register it and ask the Router to
    /// push a native frame referencing it. The push transition + interactive edge-swipe-back come from
    /// the kernel NavigationStack (RouterHost); the web view stays live underneath. `onPop` runs once
    /// when the frame is popped (by swipe OR `route.pop`). `path` is the display-only route path stamped
    /// on the frame. No-op without the route runtime (a pure web app that excluded it).
    public func push(from dsx: Context, path: String = "", vars: [String: Any]? = nil, onPop: (() -> Void)? = nil) {
        if let vars, !vars.isEmpty { store.set("vars", vars) }   // seed the frame's own store: {{ vars.x }} / bind="vars.x"
        self.onPop = onPop
        Router.shared?.pushNative(self, path: path, component: root.tag, vars: vars)
    }

    // MARK: present — open this surface as a STATE-BACKED modal (vs. present(from:) fire-and-forget UIKit)

    /// Surfaces a module presented as a state-backed MODAL, keyed by the Router's id — the modal twin
    /// of `pushedFrames`. The kernel host (RouterHost) renders the held surface for the top
    /// `global.nav.modal` entry, so a modal is observable state (not a fire-and-forget
    /// `presenter.present`): `dsx.resolve` can never report "opened" while nothing is on screen.
    static var modalFrames: [Int: StackSurface] = [:]

    /// Runs ONCE when this surface's modal leaves `global.nav.modal` — an interactive swipe-away
    /// (reported by the host) OR a `dsx.component.dismiss` / `route.dismiss`. The presented twin of `onPop`.
    var onModalDismiss: (() -> Void)?

    /// Open this surface as a state-backed MODAL instead of a fire-and-forget UIKit present: register
    /// it and ask the Router to append an observable `global.nav.modal` entry the host renders.
    /// `mode` picks the container: `sheet` (default, a drawer) / `cover` (full-screen) / `overlay`
    /// (the state-backed LAYER over the current screen — sheets/covers present above it; `touch`
    /// picks "passthrough", the default where only drawn content is tappable, or "block", the full
    /// overlay that stops every touch — Conformance/router/present.json pins the normalization);
    /// `vars` seed the surface's own store; `detents` (sheet/overlay) pick the resting stops.
    /// `onDismiss` runs once when the modal is removed (swipe OR programmatic). No-op without the route
    /// runtime (a pure web app that excluded it).
    public func presentModal(from dsx: Context, mode: String = "sheet", vars: [String: Any]? = nil,
                             detents: [String]? = nil, touch: String? = nil,
                             attrs: [String: Any]? = nil, onDismiss: (() -> Void)? = nil) {
        if let vars, !vars.isEmpty { store.set("vars", vars) }             // LEGACY seed (documented)
        if let attrs { for (k, v) in attrs { attribute(k, v) } }           // THE input contract
        self.onModalDismiss = onDismiss
        Router.shared?.presentModal(self, mode: mode, component: root.tag, vars: vars, detents: detents,
                                    touch: touch, attrs: attrs)
    }

    /// Pop-time release for a pushed surface (the Router calls this when the frame leaves the stack):
    /// run the surface's `onPop` exactly once, then drop the held reference so it can deallocate (which
    /// cancels its DSX timers). Idempotent — a second release is a no-op.
    ///
    /// The removal is DEFERRED past the pop transition. Dropping the surface synchronously (as the
    /// animation starts) makes RouterHost re-render the still-sliding outgoing frame with no surface to
    /// show — it falls through to an unresolved tag and the white system background flashes at the
    /// rounded corners (the "white slash" on the back-swipe). Keeping the surface registered until the
    /// slide settles means the frame renders its real (now-paused) content the whole way out, then frees
    /// off-screen. `onPop` (teardown: pause / persist / emit) still runs immediately. Frame ids are
    /// monotonic, so a fast re-open mints a new id and is unaffected by the pending removal.
    static func releasePushed(_ id: Int) {
        guard let surface = pushedFrames[id] else { return }
        let pop = surface.onPop
        surface.onPop = nil          // fire at most once even if release is reached twice
        pop?()                       // teardown NOW — stop playback before the slide
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { pushedFrames.removeValue(forKey: id) }
    }

    /// Dismiss-time release for a presented modal (the Router calls this when the entry leaves
    /// `global.nav.modal`): run the surface's `onModalDismiss` exactly once, then drop the held
    /// reference so it deallocates (cancelling its DSX timers). Idempotent. Removal is DEFERRED past
    /// the dismiss transition (same reason as `releasePushed`) so the modal renders its real content
    /// the whole way out instead of blanking mid-animation.
    static func releaseModal(_ id: Int) {
        guard let surface = modalFrames[id] else { return }
        let cb = surface.onModalDismiss
        surface.onModalDismiss = nil
        cb?()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { modalFrames.removeValue(forKey: id) }
    }

    private var sheetDelegate: StackSheetDelegate?

    /// Present a sub-template (e.g. a single component tag, `"<Episodes/>"`) as a
    /// native bottom sheet with drag-to-resize **detents** + a grabber — sharing
    /// THIS surface's store/env, so state, lists and `dsx.event(…)` stay live.
    /// The sheet's own gestures give drag-up-to-expand / snap / swipe-to-dismiss
    /// (1:1 with `.presentationDetents`). `onDismiss` fires only on an interactive
    /// (swipe / tap-away) dismissal, not a programmatic `dismiss(animated:)`.
    @discardableResult
    public func sheet(_ xml: String, from presenter: UIViewController,
                      detents: [StackDetent] = [.half, .full],
                      background: UIColor? = nil,
                      style: UIUserInterfaceStyle = .dark,
                      onDismiss: (() -> Void)? = nil) -> UIViewController {
        let node = StackXML.parse(xml) ?? StackNode(tag: "vstack", attrs: [:], children: [])
        // Render filling + TOP-aligned so the content is anchored to the top: if the
        // sheet ever bounces past its detent, that just reveals dark space below —
        // the content never repositions/relayouts (the "elements jump" weirdness).
        let host = UIHostingController(rootView: StackRootView(root: node, store: store, env: env, fillHeight: true,
                                                               colorScheme: StackSurface.scheme(for: style)))
        host.overrideUserInterfaceStyle = style    // .dark (default) / .light / .unspecified (follow system)
        // Caller pins a background (the paywall passes .systemBackground to adapt);
        // the default is the SEMANTIC system backdrop — system-defaults.md: the unstyled
        // baseline is the platform, never a pinned hex. It resolves under this host's
        // overrideUserInterfaceStyle, so the default .dark sheet stays a dark drawer,
        // and the slot self-updates with the OS instead of rotting at 28/28/30.
        host.view.backgroundColor = background ?? .systemBackground
        host.loadViewIfNeeded()
        if let s = host.sheetPresentationController {
            let availableWidth = presenter.view.bounds.width
            let bottomInset = presenter.view.safeAreaInsets.bottom
            s.detents = detents.map { d -> UISheetPresentationController.Detent in
                // `.content`: measure the content's natural height with a throwaway
                // HUGGING pass, then pin a FIXED custom detent (== SwiftUI
                // `.presentationDetents([.height(x)])` — a single fixed stop iOS won't
                // resize). A *live* resolver is what made it stretchy: iOS re-evaluates
                // the detent mid-drag, re-measures, and the sheet grows + content jumps.
                // (iOS 15 has no arbitrary detent → falls back to `.medium`.)
                if case .content = d, #available(iOS 16.0, *) {
                    var menv = env; menv.measuring = true   // measure intrinsic content height (collapse scroll)
                    let measurer = UIHostingController(rootView: StackRootView(root: node, store: store, env: menv, fillHeight: false))
                    measurer.loadViewIfNeeded()
                    let fit = measurer.sizeThatFits(in: CGSize(width: availableWidth, height: .greatestFiniteMagnitude)).height
                    let h = max(120, fit + 8 + bottomInset)   // hug content: small breathing room + home-indicator safe area
                    return .custom(identifier: .init("content")) { _ in h }
                }
                return d.uiDetent
            }
            s.prefersGrabberVisible = true
            // No preferredCornerRadius override — the system default is concentric
            // with the device's screen corners (what the native player uses).
            // Only allow scroll-to-expand when there's more than one stop; a
            // single-detent sheet stays put (no ugly rubber-band stretch upward).
            s.prefersScrollingExpandsWhenScrolledToEdge = detents.count > 1
        }
        if let onDismiss {
            let d = StackSheetDelegate(onDismiss: onDismiss)
            host.presentationController?.delegate = d
            sheetDelegate = d                                   // retain (delegate is weak)
        }
        presenter.present(host, animated: true)
        return host
    }

    /// Present a sub-template as an **opaque full-screen cover** (no detents, no
    /// grabber, no swipe-to-dismiss) — sharing THIS surface's store/env exactly like
    /// `sheet()`, so state/lists/`dsx.event(…)` stay live. Because there's no
    /// interactive dismissal, the body must carry its own close affordance (the
    /// paywall overlays `<PaywallClose/>`, which raises `close`). `onDismiss` is wired
    /// for completeness but only fires on an interactive dismissal, which a
    /// `.fullScreen` cover never gets — dismiss it programmatically.
    @discardableResult
    public func cover(_ xml: String, from presenter: UIViewController,
                      background: UIColor? = nil,
                      style: UIUserInterfaceStyle = .dark,
                      onDismiss: (() -> Void)? = nil) -> UIViewController {
        let node = StackXML.parse(xml) ?? StackNode(tag: "vstack", attrs: [:], children: [])
        let host = UIHostingController(rootView: StackRootView(root: node, store: store, env: env, fillHeight: true,
                                                               colorScheme: StackSurface.scheme(for: style)))
        host.overrideUserInterfaceStyle = style
        // Caller pins a background; the default is the SEMANTIC system backdrop
        // (system-defaults.md) — resolved AT THE ELEVATED LEVEL: a .fullScreen cover
        // presents at UIUserInterfaceLevel.base, where dark systemBackground is pure
        // black, while sheet() above presents elevated, where it is the pre-law
        // 28/28/30 drawer value. Pinning the level makes both presentation styles
        // agree on the same markup and keeps the dark cover on the drawer value;
        // light is unaffected — light base == light elevated == white. The provider
        // stays DYNAMIC, matching the sheet site's set-once dynamic color: style /
        // contrast re-resolve on trait flips; only the LEVEL is pinned.
        host.view.backgroundColor = background ?? UIColor(dynamicProvider: { traits in
            UIColor.systemBackground.resolvedColor(with: traits.dsxElevatedUserInterfaceLevel)
        })
        host.modalPresentationStyle = .fullScreen
        host.loadViewIfNeeded()
        if let onDismiss {
            let d = StackSheetDelegate(onDismiss: onDismiss)
            host.presentationController?.delegate = d
            sheetDelegate = d                                   // retain (delegate is weak)
        }
        presenter.present(host, animated: true)
        return host
    }

    init(
        root: StackNode,
        webView: UIView?,
        scope: String? = nil,
        dsx: Context? = nil,
        apiFetch: ApiBlock.AsyncFetch? = nil
    ) {
        self.root = root; self.webView = webView; self.scope = scope; self.dsx = dsx
        StackHead.hoist(root, store: store, scope: scope)   // root <head> declarations exist before first render
        // The transport is published on the STORE because blocks are also constructed during
        // the render pass (StackApiMountView), inside components this surface never sees.
        // Cache lifetime stays the surface/session lifetime: deliberately not process-global,
        // so replacing the app surface on sign-in/sign-out cannot expose a previous user's
        // cache entries.
        let baseURL = Self.apiBaseURL()
        store.apiFetch = apiFetch ?? ApiBlock.urlSessionTransport(baseURL: baseURL)
        store.apiCache = ApiBlock.Cache(capacity: 256)
        store.apiCachePartition = apiFetch == nil
            ? ApiBlock.cookieCachePartition(baseURL: baseURL)
            : { _ in "" }
        // The ROOT head mounts here, at construction — a surface driven purely through
        // `surface.action(…)` (never rendered) still has live handles, and a screen's first
        // GET starts before SwiftUI's first pass rather than after it.
        //
        // /web/11: the hoisted head is ONE dependency scope, so the graph is built from the
        // whole declaration set BEFORE the loop and released AFTER it — the mount.ts shape
        // (`new ApiGraph(ir.head.apis)` … loop … `apiGraph.start()`). Two phases, because a
        // block that fired on construction could hit a sibling the loop had not reached yet;
        // with the graph attached no block fires until `startApiGraph()`, and then only the
        // ones whose inputs are whole. A surface with no `needs=` and no cross-api
        // interpolation behaves identically to before — every block is runnable at start.
        store.buildApiGraph()
        for declaration in store.apiDeclarations {
            if let block = store.mountApiBlock(attrs: declaration.attrs, env: env, item: nil) {
                apiBlocks.append(block)
            }
        }
        store.startApiGraph()
    }

    deinit {
        apiBlocks.forEach { $0.dispose() }
    }

    /// AppManifest owns the app's web identity. Relative native `<api>` URLs use
    /// that SAME origin (including the non-production scheme/port override), which
    /// is also the required `via="server"` route for secret-bearing requests.
    private static func apiBaseURL() -> URL? {
        guard var origin = AppManifest.resolvedOriginString()?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !origin.isEmpty else { return nil }
        if !origin.contains("://") { origin = "https://" + origin }
        return URL(string: origin)
    }

    // MARK: Overlay mounting (dsx.stack.render(.., as: .overlay(edge)))

    /// Mount this surface as a sibling ABOVE the web view with passthrough
    /// hit-testing, pinned to `edge`. The container passes touches through
    /// everywhere except over a real native control (see PassthroughView), so the
    /// web view keeps the rest. Tear down with `remove()`.
    func mountOverlay(_ edge: StackEdge) {
        guard let parent = webView?.superview else { return }
        let view = controller.view!                              // the hosting view
        view.backgroundColor = .clear                            // glass shows the page
        view.translatesAutoresizingMaskIntoConstraints = false

        let box = PassthroughView()
        box.backgroundColor = .clear
        box.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(view)
        parent.addSubview(box)                                   // sibling, above the web view

        let g = parent.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            view.topAnchor.constraint(equalTo: box.topAnchor),
            view.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            view.leadingAnchor.constraint(equalTo: box.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: box.trailingAnchor),
        ])
        switch edge {
        case .fill:
            NSLayoutConstraint.activate([
                box.topAnchor.constraint(equalTo: parent.topAnchor),
                box.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
                box.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
                box.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
            ])
        case .bottom:
            NSLayoutConstraint.activate([
                box.leadingAnchor.constraint(equalTo: g.leadingAnchor),
                box.trailingAnchor.constraint(equalTo: g.trailingAnchor),
                box.bottomAnchor.constraint(equalTo: g.bottomAnchor),
            ])
        case .top:
            NSLayoutConstraint.activate([
                box.leadingAnchor.constraint(equalTo: g.leadingAnchor),
                box.trailingAnchor.constraint(equalTo: g.trailingAnchor),
                box.topAnchor.constraint(equalTo: g.topAnchor),
            ])
        case .leading:
            NSLayoutConstraint.activate([
                box.leadingAnchor.constraint(equalTo: g.leadingAnchor),
                box.topAnchor.constraint(equalTo: g.topAnchor),
                box.bottomAnchor.constraint(equalTo: g.bottomAnchor),
            ])
        case .trailing:
            NSLayoutConstraint.activate([
                box.trailingAnchor.constraint(equalTo: g.trailingAnchor),
                box.topAnchor.constraint(equalTo: g.topAnchor),
                box.bottomAnchor.constraint(equalTo: g.bottomAnchor),
            ])
        }
        overlayContainer = box
    }

    /// Remove an overlay surface from the web view.
    public func remove() { overlayContainer?.removeFromSuperview(); overlayContainer = nil }

    // MARK: Reactive API (native, in-process — no bridge, no JS)

    // ── The canonical native trio — mirrors the JSE namespaces 1:1 ──
    //   ui.variable("x", v)        ⇄  dsx.variable.x      (surface state)
    //   ui.action("name", payload) ⇄  dsx.action.name()   (run a markup <action>, dsx.this = payload)
    //   ui.attribute("x", v)       ⇄  dsx.attribute.x     (root-level attributes — set from native)
    /// Write a surface variable (what markup reads as `dsx.variable.key`). Chainable.
    @discardableResult public func variable(_ key: String, _ value: Any) -> StackSurface { store.set(key, value); return self }
    /// Set a root-level attribute: markup reads it as `dsx.attribute.key` wherever a consumer
    /// didn't pass that prop (runtime values win over `<attribute default>` declarations).
    @discardableResult public func attribute(_ key: String, _ value: Any) -> StackSurface {
        var attrs = (store.vars["dsx.attribute"] as? [String: Any]) ?? [:]
        attrs[key] = value
        store.set("dsx.attribute", attrs)
        return self
    }
    @discardableResult public func state(_ key: String, _ value: Any) -> StackSurface { store.set(key, value); return self }   // alias of variable() (legacy call sites)
    public func set(_ key: String, _ value: Any) { store.set(key, value) }
    /// Read a surface variable back (the mirror of `set` — e.g. a package persisting
    /// `time`/`index` at close). Main-thread, like every other store access.
    public func get(_ key: String) -> Any? { store.vars[key] }
    /// Animated set: tweens any animatable bound style (offset/opacity/…) that
    /// reads `key`. Show/hide via `visible-if` animates on its own `transition=`.
    public func set(_ key: String, _ value: Any, animated: Bool) {
        animated ? withAnimation { store.set(key, value) } : store.set(key, value)
    }
    /// Run several mutations inside one animation transaction.
    public func animate(_ animation: Animation = .default, _ changes: () -> Void) {
        withAnimation(animation, changes)
    }
    /// Handle a component/element event raised by `dsx.event(…)`. The handler
    /// receives a payload: the tapped list/grid row's `item`, plus any `arg:*`
    /// attributes on the element (interpolated + coerced). Use the no-arg overload
    /// when you don't need data.
    public func on(_ event: String, _ handler: @escaping ([String: Any]) -> Void) { store.handlers[event] = handler }
    public func on(_ event: String, _ handler: @escaping () -> Void) { store.handlers[event] = { _ in handler() } }
    /// Wildcard tap: see EVERY event this surface raises (`dsx.event` / component events / dsx.send),
    /// named-handled or not — the one-block analytics/relay/logging hook (no name enumeration).
    public func onAny(_ handler: @escaping (String, [String: Any]) -> Void) { store.anyHandlers.append(handler) }
    /// Run a named `<action>` declared in this surface's markup, with `payload` bound as `dsx.this` —
    /// the native→DSX inverse of `ui.on` (DSX→native). Native code delegates LOGIC to the markup:
    /// e.g. the player's analytics webhook is a DSX `<action as="track">` using JSE `await fetch`,
    /// and Swift just calls `ui.action("track", payload)`.
    public func action(_ name: String, _ payload: [String: Any] = [:]) {
        // Main-thread only: the runner walks handler/store state that SwiftUI owns. A call
        // from a package's background completion re-dispatches (same rule as store.set).
        guard Thread.isMainThread else { DispatchQueue.main.async { self.action(name, payload) }; return }
        env.run("\(name)()", item: payload, args: payload)
    }
    public func node(_ id: String) -> StackNodeHandle { StackNodeHandle(id: id.hasPrefix("#") ? String(id.dropFirst()) : id, store: store) }
    public func list(_ key: String) -> StackListHandle { StackListHandle(key: key, store: store) }
}

/// Container that is transparent to touches except where a real native control
/// sits. `point(inside:)` is true only when a subview *deeper* than the bare
/// hosting view claims the point — so empty/transparent regions (a Spacer, a
/// clear background) report "not inside" and UIKit forwards the touch to the
/// web view sibling below. The glass bar's buttons still work normally.
final class PassthroughView: UIView {
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        for sub in subviews {
            let p = sub.convert(point, from: self)
            if let hit = sub.hitTest(p, with: event), hit !== sub { return true }
        }
        return false
    }
}


public struct StackNodeHandle {
    let id: String
    let store: StackStore
    public func set(_ attr: String, _ value: String) {
        guard Thread.isMainThread else { DispatchQueue.main.async { self.set(attr, value) }; return }
        store.overrides[id, default: [:]][attr] = value
        store.objectWillChange.send()
    }
    /// Animated attribute patch — tweens if `attr` drives an animatable style
    /// (offset/opacity/width/…). e.g. `ui.node("#bar").set("offsetY", "0", animated: true)`.
    public func set(_ attr: String, _ value: String, animated: Bool) {
        animated ? withAnimation { set(attr, value) } : set(attr, value)
    }
    /// Run several patches on this node inside one animation transaction.
    public func animate(_ animation: Animation = .default, _ changes: (StackNodeHandle) -> Void) {
        withAnimation(animation) { changes(self) }
    }
}

public struct StackListHandle {
    let key: String
    let store: StackStore
    private let field = "id"

    public func set(_ items: [[String: Any]]) { store.setList(key, items) }
    public func insert(_ item: [String: Any], at index: Int = 0) {
        var items = store.list(key); items.insert(item, at: min(max(index, 0), items.count)); store.setList(key, items)
    }
    public func remove(id: Any) {
        store.setList(key, store.list(key).filter { !equalKey($0[field], id) })
    }
    public func replace(id: Any, with item: [String: Any]) {
        store.setList(key, store.list(key).map { equalKey($0[field], id) ? item : $0 })
    }
    public func update(id: Any, _ mutate: (inout [String: Any]) -> Void) {
        store.setList(key, store.list(key).map { row in
            guard equalKey(row[field], id) else { return row }
            var r = row; mutate(&r); return r
        })
    }
    private func equalKey(_ a: Any?, _ b: Any) -> Bool { "\(a ?? "")" == "\(b)" }
}

// MARK: - Environment (events + package dispatch)

/// Children passed into a component (`<Card> …children… </Card>`), rendered where
/// the component places `<slot/>`. A class (not in the struct) so JSERunner can hold
/// it without value recursion; carries the CONSUMER's env + item so slotted content
/// binds in the caller's scope (React-style).
final class SlotContent {
    let children: [StackNode]
    let env: JSERunner
    let item: [String: Any]?
    let rowWrite: ((String, Any) -> Void)?   // row write-back, so inputs slotted into a
                                             // component inside a list row still edit the row
    init(children: [StackNode], env: JSERunner, item: [String: Any]?,
         rowWrite: ((String, Any) -> Void)? = nil) {
        self.children = children; self.env = env; self.item = item; self.rowWrite = rowWrite
    }
}

/// One consumer-declared `on:<event>` handler, captured WITH the environment that declared it.
/// `dsx.event(name)` runs the matched handler in `env` — the DECLARING env, not the raiser's — so a
/// same-name relay (`on:download="dsx.event('download')"`, `on:ended="dsx.event('ended'); …"`) resolves
/// one level UP per hop and terminates at the native `ui.on`, instead of re-triggering its own
/// entry forever (a 2-frame mutual recursion that overflowed the main stack — the device crashes
/// of 2026-06-10/11). Termination is structural: each hop strictly ascends the mount chain, and
/// the root surface's table is empty. A class so the runner struct can nest it freely; entries
/// reference only ANCESTOR envs, so no retain cycles.
final class OnHandler {
    let action: String
    let env: JSERunner
    /// Optional emitter-identity filter from a companion `from:<event>` attribute on the SAME
    /// binding — `on:select="…" from:select="action=checkout"` (or `component=Cart`, or bare
    /// `checkout` to match any source of that name). The handler runs ONLY when the event's
    /// stamped `__from` matches. This keeps the no-bus model (decision #9): the filter narrows
    /// WHICH emitter the consumer's own `on:` accepts — it never widens reach to a global bus.
    /// (type, name): type is "action" | "component" | "" (bare = any type of that name).
    let from: (type: String, name: String)?
    init(action: String, env: JSERunner, from: (type: String, name: String)? = nil) {
        self.action = action; self.env = env; self.from = from
    }

    /// True when this handler should run for `payload` — always, unless a `from:` filter is set
    /// and the payload's stamped `__from` doesn't match it. Total: a missing/`__from`-less payload
    /// fails a set filter (an unstamped event can't satisfy "from this exact source").
    func accepts(_ payload: [String: Any]) -> Bool {
        guard let from else { return true }
        guard let src = payload["__from"] as? [String: Any] else { return false }
        let name = JSE.string(src["name"] ?? "")
        guard name == from.name else { return false }
        if from.type.isEmpty { return true }                          // bare `from:x` — any source of that name
        return JSE.string(src["type"] ?? "") == from.type
    }

    /// Parse a `from:<event>` attribute value → (type, name). `action=checkout` / `component=Cart`
    /// → typed; a bare `checkout` → ("", "checkout") matching any source of that name. Returns nil
    /// for an empty value (no filter).
    static func parseFrom(_ raw: String) -> (type: String, name: String)? {
        let s = raw.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return nil }
        if let eq = s.firstIndex(of: "=") {
            let t = String(s[..<eq]).trimmingCharacters(in: .whitespaces)
            let n = String(s[s.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            if t == "action" || t == "component" { return (t, n) }
        }
        return ("", s)
    }
}

/// JSERunner — the LOGIC half: the action / statement runner (the expression half is `JSE`).
/// Runs JSE statements (assignment · if · const/let · array methods · await fetch ·
/// dsx.event / dsx.action / dsx.module calls) for on:* / <action> bodies. See OpenSource/Documentation/reference/jse.md.
struct JSERunner {
    let store: StackStore
    weak var webView: UIView?
    var scope: String?                      // rendering package (component resolution)
    var onHandlers: [String: OnHandler] = [:]  // consumer's on:<event> → handler + its DECLARING env (handlers run THERE — relays bubble up, never self-loop)
    var slot: SlotContent?                   // children handed to the current component
    var dsx: Context?                        // the owning call's dsx (event/resolve/error)
    /// True only during the throwaway pass that measures a sheet's `.content` detent.
    /// Vertical scroll containers (scroll/list/grid) then render as their intrinsic
    /// content (no ScrollView — which reports a greedy, full-screen height), so the
    /// measured size is the real content height and the sheet hugs it. The LIVE render
    /// keeps the ScrollView, so content taller than the detent still scrolls. This makes
    /// content-sizing a first-class engine behavior — any package/author gets it free.
    var measuring = false
    /// Component-expansion depth, to stop a self-referencing component (a template that
    /// contains its own tag) from recursing forever and overflowing the stack.
    var depth = 0

    /// Run an `on:` action string — a JSE action body (see jse.md): `;`/newline-separated
    /// statements over the same grammar as `<action>` bodies. State writes `x = e` (incl.
    /// `global.*` / `route.*` → DSXState; navigation is just `route.path = '/home'`), arrays
    /// `arr.push(x)` / `.pop()` / …, package calls `dsx.module.scheme.method({…})`, named actions
    /// `dsx.action.name()`, and the event primitive `dsx.event('name', {…})` — raise a component event
    /// UP to the consumer's `on:<name>` (and native `dsx.events.on`). `{{ … }}` interpolate and
    /// coerce to bool/number/string.
    ///
    /// The only `verb:` forms that remain are EFFECT PRIMITIVES with no JSE-expression form:
    ///   "fetch: …"              → reactive {loading,data,error} envelope
    ///   "remove: arr where …"   → filter-delete
    ///   "animate: key = expr"   → withAnimation { … } around a state write
    ///   "resolve: ?args"        → dsx.resolve(data) — terminal success for the originating call
    ///   "error: code?args"      → dsx.error(code, data) — terminal failure
    /// (The legacy `verb:` aliases predating JSE were removed — see `runVerb` below / jse.md.)
    func run(_ action: String, item: [String: Any]?, args: [String: Any] = [:]) {
        let a = Self.stripJSComments(action).trimmingCharacters(in: .whitespaces)
        // A fresh entry event gets the full bounded-execution ledgers: the loop budget and any
        // stray flow signal (an uncaught throw / a break that unwound to the top) reset here.
        if store.actionDepth == 0 { store.loopWork = 0; store.flowSignal = nil; store.thrownValue = nil; store.returnValue = nil; store.tryDepth = 0 }
        // Uncaught-throw context (reportUncaughtThrow's `snippet`): the body now entering.
        // Restored on a clean exit (run() re-enters for nested handlers via emitEventUp);
        // a throw skips the restore — like the flow signal — so the report attributes the
        // body that actually threw.
        let savedBody = store.entryBody
        store.entryBody = a
        // A bounded-JS action body — `if/else`, `while`/`for`/`for…of` (budgeted), `switch`,
        // `try/catch/finally`, `const`/`let`, and statements (the effect verbs + JS forms
        // `x = e` / `arr.push(x)` / `pkg.m(a=b)` / `name()`) on `;` / newlines. Anything past a
        // single bare verb routes through the brace-JS interpreter.
        if a.contains(";") || a.contains("\n") || a.contains("{")
            || a.hasPrefix("if ") || a.hasPrefix("if(") || a.hasPrefix("const ") || a.hasPrefix("let ")
            || a.hasPrefix("while ") || a.hasPrefix("while(") || a.hasPrefix("for ") || a.hasPrefix("for(")
            || a.hasPrefix("switch ") || a.hasPrefix("switch(") || a.hasPrefix("try ") {
            runActionBody(a, item: item, args: args)
            if store.flowSignal != "throw" { store.entryBody = savedBody }
            reportEntryUncaught()
            return
        }
        runVerb(a, item: item, args: args)
        if store.flowSignal != "throw" { store.entryBody = savedBody }
        reportEntryUncaught()   // a bare action name is an entry too (`on:tap="doWork"`)
    }

    /// An uncaught `throw` that unwound the whole entry used to vanish as one log line —
    /// now it reports through the ambient fan-out with origin "uncaught" (errors corpus):
    /// ledger, module.error, page channel + dsx mirror, reactive keys. Control flow is
    /// already unwound; recording changes nothing. Runs on BOTH entry exits (the brace-JS
    /// body and the bare-verb form) at depth 0 only — a nested action's throw propagates
    /// to its caller and reports once, at the top.
    private func reportEntryUncaught() {
        guard store.actionDepth == 0 else { return }
        if store.flowSignal == "throw" { reportUncaughtThrow(store.thrownValue) }
        store.flowSignal = nil; store.thrownValue = nil
    }

    /// Derive the canonical error fields from an uncaught thrown value (corpus-pinned): a
    /// dict with a string `code` keeps its code/message/recoverable/data; a codeless dict
    /// with a string `message` (a JSE `new Error("…")`, the browser-parity throw) keeps the
    /// message and rides whole as data; any other dict rides as data; anything else records
    /// code "uncaught" with the JSE string coercion as message. Source = the surface's
    /// owning scheme, "app" unscoped. RUNTIME ERROR CONTEXT: the data additionally carries
    /// `snippet` — the first 120 chars of the body that threw (store.entryBody) — so a
    /// ledger entry says WHAT threw (dict data gains the key unless the author set one;
    /// scalar data rides untouched; corpus expects stay green — subset-matched).
    private func reportUncaughtThrow(_ value: Any?) {
        var code = "uncaught"
        var message: String?
        var recoverable = false
        var data: Any?
        if let dict = value as? [String: Any] {
            if let dictCode = dict["code"] as? String, !dictCode.isEmpty {
                code = dictCode
                if let m = dict["message"], !(m is NSNull) { message = JSE.string(m) }
                recoverable = JSE.truthy(dict["recoverable"])
                data = dict["data"]
            } else if let dictMessage = dict["message"] as? String, !dictMessage.isEmpty {
                message = dictMessage
                data = dict
            } else {
                data = dict
            }
        } else {
            message = JSE.string(value ?? "")
        }
        let snippet = String(store.entryBody.prefix(120))
        if var dataDict = data as? [String: Any] {
            if dataDict["snippet"] == nil { dataDict["snippet"] = snippet }
            data = dataDict
        } else if data == nil || data is NSNull {
            data = ["snippet": snippet]
        }
        reportAmbientError(scheme: (scope?.isEmpty == false) ? scope! : "app", code: code,
                           message: message, recoverable: recoverable, data: data,
                           origin: "uncaught")
    }

    /// Run an `on:<event>` action with optional declarative DEBOUNCE / THROTTLE — the `.debounce`
    /// / `.throttle` attribute modifiers (`on:tap.debounce="300"`, `on:submit.throttle="1000"`):
    ///
    ///   • debounce(ms) — coalesce a burst: cancel the pending run and reschedule `ms` ahead, so
    ///     only the LAST call in a quiet-for-ms window fires (search-as-you-type, resize).
    ///   • throttle(ms) — rate-limit: run the FIRST call immediately, then drop calls until `ms`
    ///     has passed (scroll/tap spam, a save button).
    ///
    /// Both lean on the SAME keyed timer machinery as `setTimeout(…, key)` (`store.timers`), so
    /// they're surface-scoped (cancelled when the store deallocates — no run fires into a dead
    /// surface) and bounded. No modifier ⇒ a plain immediate `run`, byte-identical to before, so
    /// existing bindings are unaffected. `gateKey` distinguishes bindings (so two debounced taps
    /// on different elements don't share a window); the action text is folded in as a backstop.
    func runGated(_ action: String, item: [String: Any]?, args: [String: Any] = [:],
                  debounceMs: Double?, throttleMs: Double?, gateKey: String) {
        // Capture a value copy of the runner (struct) so the deferred closure stays valid past this
        // call — it shares the store class reference, the identity that matters (the await contract).
        let runner = self
        if let ms = debounceMs, ms > 0 {
            let key = "__debounce:" + gateKey + ":" + action
            let capItem = item, capArgs = args
            let work = DispatchWorkItem { [weak store] in
                guard let store, store.timers[key] != nil else { return }   // cancelled / surface gone
                store.timers[key] = nil
                runner.run(action, item: capItem, args: capArgs)
            }
            store.timers[key]?.cancel(); store.timers[key] = work           // same key → drop the pending run
            DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000, execute: work)
            return
        }
        if let ms = throttleMs, ms > 0 {
            let key = "__throttle:" + gateKey + ":" + action
            if store.timers[key] != nil { return }                          // inside the window → drop
            run(action, item: item, args: args)                             // leading edge fires now
            let close = DispatchWorkItem { [weak store] in store?.timers[key] = nil }
            store.timers[key] = close                                       // window OPEN until it expires
            DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000, execute: close)
            return
        }
        run(action, item: item, args: args)
    }

    /// Read the `.debounce` / `.throttle` modifier (ms) for an `on:<event>` binding from an attr
    /// bag — `on:tap.debounce="300"`. Static so both the safe component context and the node view
    /// share one parse. Non-numeric / absent → nil (no gating).
    static func gateMs(_ attrs: [String: String], event: String, kind: String) -> Double? {
        attrs["on:\(event).\(kind)"].flatMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    }

    /// A SINGLE non-JSE EFFECT verb — the few primitives with no JSE-expression form — else hand
    /// to the JSE statement runner. The legacy `verb:` ALIAS verbs (predating JSE) have been
    /// REMOVED — write JSE: `x = e` · `dsx.event('x')` · `dsx.action.x()` · `dsx.module.s.m({…})` ·
    /// `arr.push(x)`. See jse.md for the full removed-verb → JSE table.
    private func runVerb(_ a: String, item: [String: Any]?, args: [String: Any]) {
        if a.hasPrefix("fetch:") {                 // reactive {loading,data,error} envelope (no JSE form)
            performFetch(String(a.dropFirst(6)), item: item)
        } else if a.hasPrefix("remove:") {         // filter-delete: `remove: arr where <pred>` (no JSE form)
            performRemove(String(a.dropFirst(7)), item: item)
        } else if a.hasPrefix("animate:") {        // withAnimation { … } wrapper (no JSE form)
            withAnimation { assign(String(a.dropFirst(8)), item: item) }
        } else if a.hasPrefix("resolve:") {        // resolve the originating call — OR reply to an awaiting `dsx.event` (no JSE form)
            let (head, data) = payload(String(a.dropFirst(8)), item: item)
            if let token = replyToken(item, args), let pend = store.eventReplies.removeValue(forKey: token) {
                resumeAwaitEvent(pend, value: data?.foundationValue ?? (head.isEmpty ? NSNull() : coerce(head)))   // an on:<event> handler servicing `await dsx.event(…)` → route the value back to THAT awaiter
            } else {
                dsx?.resolve(data)                  // else terminal success for the originating web/native call (unchanged)
            }
        } else if a.hasPrefix("error:") {          // error the originating call — OR reject an awaiting `dsx.event` (no JSE form)
            let (code, data) = payload(String(a.dropFirst(6)), item: item)
            if let token = replyToken(item, args), let pend = store.eventReplies.removeValue(forKey: token) {
                resumeAwaitEvent(pend, value: NSNull())   // a rejected request settles the awaiter falsy (`if (ok)` → false)
            } else {
                dsx?.error(code.isEmpty ? "error" : code, data)
            }
        } else if Self.bareActionName.firstMatch(in: a, range: NSRange(a.startIndex..., in: a)) != nil, store.actions[a] != nil {
            // a bare registered-action name IS an invocation — `on:tap="copyDemo"` is the
            // author form (no parens). Runs the declared <action> with the entry's payload as
            // its args (the web + Kotlin runners resolve the same way). A no-op today for any
            // bare word that isn't an action, so this only ADDS the sugar.
            runJSStatement(a + "()", item: item, args: args)
        } else {
            runJSStatement(a, item: item, args: args)   // JSE: x = e · arr.push(x) · dsx.module.s.m() · dsx.action.x() · dsx.event(…)
        }
    }

    private static let bareActionName = try! NSRegularExpression(pattern: "^[A-Za-z_][A-Za-z0-9_]*$")

    /// JS-syntax statements (no `verb:` prefix), mapped onto the same operations:
    ///   `x = expr`            → set (store)                       (use `const:`/`let:` for locals)
    ///   `arr.push(x)` / `.pop()` / `.shift()` / `.unshift(x)` / `.splice(…)` → the array verbs
    ///   `pkg.method(a=b)`     → call dispatch                     (package calls use NAMED args)
    ///   `name()`              → `do: name` (a named <action>)
    /// The `verb:` forms still work; this just lets the same things read as JS.
    private func runJSStatement(_ a: String, item: [String: Any]?, args: [String: Any]) {
        let a = Self.jsSugar(a)   // `i++` / `i--` / `x += e` (-=, *=, /=) → their `x = x op (e)` form
        // DESTRUCTURING ASSIGNMENT `[a, b] = [b, a]` (syntax-005) — the declaration-less
        // pattern write. Only the binder differs from a `const`: `write` routes each name
        // as an ordinary assignment (the store-always contract), so the statement writes
        // wherever `a = …` would have. RHS evaluates ONCE before any binding.
        if a.hasPrefix("[") {
            let eq = Self.topLevelAssignIndex(a)
            if eq > 0 {
                let rhs = String(a.dropFirst(eq + 1)).trimmingCharacters(in: .whitespaces)
                let v = JSE.eval(rhs, store: store, item: item)
                JSE.destructureBind(String(a.prefix(eq)).trimmingCharacters(in: .whitespaces), v,
                                    store: store, locals: item ?? [:]) { n, value in
                    write(n, value ?? NSNull())
                }
                return
            }
        }
        // indexed assignment — `name[expr] = rhs` (one index level): evaluate the index,
        // route the write through the dotted path (`arr.0` / `o.key`), same as `set:` paths
        if runIndexedAssign(a, item: item) { return }
        // assignment — `path = expr` (dotted path LHS, not a call/index)
        if let (lhs, rhs) = JSERunner.splitOnAssign(a), !lhs.isEmpty, !lhs.contains("("), !lhs.contains("[") {
            // `ws.onmessage = e => { … }` — a socket HANDLER registration, not a state write:
            // the arrow's body (a string, like timer callbacks — value semantics hold) registers
            // against the keyed native socket; `e` carries { data } / { code, reason, wasClean }.
            for ev in ["onopen", "onmessage", "onerror", "onclose"] where lhs.hasSuffix("." + ev) {
                let receiver = String(lhs.dropLast(ev.count + 1))
                if let h = JSE.eval(receiver, store: store, item: item) as? [String: Any],
                   let skey = h["__socket"] as? String {
                    let (param, body) = JSERunner.parseArrow(rhs)
                    store.sockets[skey]?.on(String(ev.dropFirst(2)), param: param, body: body, item: item)
                    return
                }
            }
            // `dsx.variable.ws = new WebSocket(…)` — the state-stored form of the const binding.
            let trimmedRHS = rhs.trimmingCharacters(in: .whitespaces)
            if trimmedRHS.hasPrefix("new WebSocket("), trimmedRHS.hasSuffix(")") {
                let argStr = String(trimmedRHS.dropFirst("new WebSocket(".count).dropLast())
                write(lhs, openWebSocket(argStr: argStr, locals: item ?? [:]))
                return
            }
            write(lhs, JSE.eval(rhs, store: store, item: item) ?? "")
            return
        }
        guard let lp = a.firstIndex(of: "("), a.hasSuffix(")") else { return }
        var callee = String(a[..<lp]).trimmingCharacters(in: .whitespaces)
        if callee.hasPrefix("dsx.action.") { callee = String(callee.dropFirst(11)) }   // dsx.action.name() → name()
        let argStr = String(a[a.index(after: lp)..<a.index(before: a.endIndex)])
        if callee.hasPrefix("dsx.module.") {
            // Explicit package namespace: dsx.module.scheme.method({ … }) → a package call. The
            // `dsx.module.` marker FORCES dispatch — it skips the array-method / action / state-object
            // routing below — so a package call can never collide with a state object's own
            // `.method()`. The DSX twin of the web SDK's `despia.scheme.method(…)` global, sitting
            // alongside dsx.action / dsx.route / dsx.query in the `dsx.` family.
            dispatch(String(callee.dropFirst("dsx.module.".count)) + "(" + argStr + ")", item: item)
            return
        }
        if callee.hasPrefix("dsx.component.") {
            // The markup presentation sugar — open THIS package's own component (resolved in the
            // caller's `scope`) as a native nav FRAME (`push`) or a state-backed MODAL (`present`),
            // UPDATE an open one's attributes, or DISMISS the top modal. The surface twin of the
            // native `dsx.component.push/present/update/dismiss`, routed through the kernel `route`
            // owner so nav stays ONE subsystem. Never fire-and-forget: push mutates
            // `global.nav.stack`, present mutates `global.nav.modal`, update merges an entry's
            // `attrs` + re-seeds the live surface. Signatures mirror the ADR:
            // push(name, { attrs, vars, path }) · present(name, { as, touch, attrs, vars, detents })
            // · update([target], { attrs }) · dismiss([target]). `attrs` is THE component input
            // contract — the hard-coded-markup twin; `vars` is the legacy seed.
            let verb = String(callee.dropFirst("dsx.component.".count))
            guard verb == "push" || verb == "present" || verb == "dismiss" || verb == "update" else {
                // ONLY the presentation verbs exist in markup — anything else (a typo, or a
                // native-only call like `mount`) must NOT fall through to a default: silently pushing
                // a screen for `dsx.component.mount('X')` would be a brutal surprise. Log + no-op.
                kernelLog("[Stack] dsx.component.\(verb) — unknown verb (markup has push / present / update / dismiss); ignored")
                return
            }
            let parts = JSERunner.splitArgs(argStr)
            if verb == "dismiss" {
                let t = parts.first.map { JSE.string(JSE.eval($0, store: store, item: item)) }
                Router.shared?.dismissModal(target: (t?.isEmpty ?? true) ? nil : t)
                return
            }
            let name = JSE.string(JSE.eval(parts.first ?? "", store: store, item: item))
            let opts = (parts.count > 1 ? JSE.eval(parts[1], store: store, item: item) : nil) as? [String: Any] ?? [:]
            let vars = opts["vars"] as? [String: Any]
            let attrs = opts["attrs"] as? [String: Any]   // THE component input contract (markup twin)
            if verb == "update" {
                Router.shared?.updateComponent(target: name.isEmpty ? nil : name, attrs: attrs ?? [:])
                return
            }
            guard !name.isEmpty else { return }
            if verb == "present" {
                Router.shared?.presentComponent(name: name, scope: scope, mode: (opts["as"] as? String) ?? "sheet",
                                                vars: vars, detents: opts["detents"] as? [String],
                                                touch: opts["touch"] as? String, attrs: attrs)
            } else {   // push
                Router.shared?.pushComponent(name: name, scope: scope, path: (opts["path"] as? String) ?? "",
                                             vars: vars, attrs: attrs)
            }
            return
        }
        if callee == "dsx.error" {
            // The AMBIENT error hat in markup (error-system.md §3.4) — a markup action never
            // holds a call to settle, so this is always the emission form: ledger +
            // module.error + page channel (+ dsx mirror) + global.dsx.* keys. NEVER unwinds
            // control flow — it is not a throw, it records; the next statement still runs.
            // Source = the surface's owning package scheme, "app" when unscoped.
            let parts = JSERunner.splitArgs(argStr)
            var code = JSE.string(JSE.eval(parts.first ?? "", store: store, item: item))
            if code.isEmpty { code = "error" }
            let opts = (parts.count > 1 ? JSE.eval(parts[1], store: store, item: item) : nil) as? [String: Any] ?? [:]
            reportAmbientError(
                scheme: (scope?.isEmpty == false) ? scope! : "app",
                code: code,
                message: opts["message"] as? String,
                recoverable: JSE.truthy(opts["recoverable"]),
                data: opts["data"])
            return
        }
        if callee == "dsx.log" {
            // The unified console primitive (logs corpus): console.log-shaped variadic args,
            // house formatting (JSE coercions + canonical JSON + credential masking), recorded
            // in the log ring attributed to the surface's owning scheme + one kernelLog mirror
            // line (the Xcode console / the armed diagnostics drawer). Records, never unwinds,
            // never throws.
            let values = JSERunner.splitArgs(argStr).map { JSE.eval($0, store: store, item: item) }
            reportLog(scheme: (scope?.isEmpty == false) ? scope! : "app", level: "log",
                      message: JSERunner.formatLogArgs(values))
            return
        }
        if callee == "dsx.screen.settled" {
            // "This screen has settled" — the native readiness REPORT (screen-lifecycle.md). A
            // kernel verb like dsx.log / dsx.error: zero-arg, records, never unwinds. Past tense
            // and only ever in CALL position, so it can never be confused with the read-only
            // reactive PROPERTIES `dsx.screen.ready` (Bool) / `dsx.screen.phase` (String) that
            // live in the same namespace. Off a nav frame (`frameId` nil — a mounted overlay, a
            // bare dsx.render surface) it is a silent no-op; on an `auto` screen it simply
            // settles it a beat early (corpus lifecycle/readiness.json).
            DSXScreenReadiness.settled(store.frameId)
            return
        }
        if callee.hasPrefix("console."), JSECore.handles(callee) {
            // Statement-position console.* routes to the JSE globals sink (JSEConsole + the
            // unified log ring) exactly like expression position and the web runner — it
            // used to fall through to the legacy package dispatch below, where scheme
            // "console" answered not_loaded (caught by the logs corpus).
            _ = JSECore.call(callee, JSERunner.splitArgs(argStr).map { JSE.eval($0, store: store, item: item) })
            return
        }
        if callee == "dsx.event" || callee == "dsx.send" || callee == "dsx.broadcast" {
            // Author event primitive: dsx.event(name, {…}) sends an event UP to the consumer's
            // on:<name> (and to native subscribers) — the payload becomes dsx.this in the handler /
            // action. `dsx.*` is the NATIVE/package spelling of the same machinery and is reserved
            // for native code: dsx.event == dsx.event; dsx.send → a native ui.on handler; dsx.broadcast
            // → the cross-package bus. In DSX templates, always use dsx.event.
            let parts = JSERunner.splitArgs(argStr)
            let name = JSE.string(JSE.eval(parts.first ?? "", store: store, item: item))
            let rawPay = (parts.count > 1 ? JSE.eval(parts[1], store: store, item: item) : nil) as? [String: Any] ?? [:]
            // Stamp the emitter's identity so a consumer's `from:<event>` can filter WHICH source
            // it accepts (no global bus — just metadata on the payload). An event raised from an
            // action body carries `{ type:"action", name:<that action> }`; raised loose (an on:tap
            // with no action on the stack) it's unstamped (a `from:action` filter then won't match).
            let pay = JSERunner.stampFrom(rawPay, type: "action", name: store.actionNameStack.last)
            switch callee {
            case "dsx.send":      store.handlers[name]?(pay)                    // → native ui.on handler
            case "dsx.broadcast": dsx?.broadcast(name, JSON(pay))              // → cross-package bus (+ web)
            default:              emitEventUp(name, pay, item: item)           // dsx.event → UP to the consumer's on:<name> (and native); shared with `await dsx.event`
            }
            store.anyHandlers.forEach { $0(name, pay) }                        // ui.onAny wildcard taps see every dsx.event/dsx.* (consumed or not) — analytics/relay without enumerating names
            return
        }
        if callee == "setTimeout" {
            // setTimeout(() => { … }, ms[, key]) — defer an action body. The arrow's body is parsed
            // like an event handler and run through the statement runner after `ms` (default 0) in
            // the captured scope. An optional string `key` coalesces: scheduling another timer with
            // the same key cancels the pending one (debounce — e.g. a player's controls auto-hide).
            let parts = JSERunner.splitArgs(argStr)
            guard let fnArg = parts.first else { return }
            var body = fnArg.trimmingCharacters(in: .whitespaces)
            if let arrow = body.range(of: "=>") { body = String(body[arrow.upperBound...]).trimmingCharacters(in: .whitespaces) }
            if body.hasPrefix("{"), body.hasSuffix("}") { body = String(body.dropFirst().dropLast()) }   // strip the arrow's block braces
            let ms  = parts.count > 1 ? (JSE.number(JSE.eval(parts[1], store: store, item: item)) ?? 0) : 0
            let key = parts.count > 2 ? JSE.string(JSE.eval(parts[2], store: store, item: item)) : ""
            let capItem = item, capArgs = args
            let work = DispatchWorkItem {
                if !key.isEmpty { store.timers[key] = nil }
                runActionBody(body, item: capItem, args: capArgs)
            }
            if !key.isEmpty { store.timers[key]?.cancel(); store.timers[key] = work }
            DispatchQueue.main.asyncAfter(deadline: .now() + Swift.max(0, ms) / 1000, execute: work)
            return
        }
        if callee == "setInterval" {
            // setInterval(() => { … }, ms[, key]) — a REPEATING timer (polling, tickers, clocks).
            // Keyed like setTimeout (same key replaces the running interval); every interval dies
            // with the surface (the store cancels its timers on deinit). Stop early with
            // clearInterval(key). Min period 250ms — an interval can't busy-spin the main thread.
            let parts = JSERunner.splitArgs(argStr)
            guard let fnArg = parts.first else { return }
            var body = fnArg.trimmingCharacters(in: .whitespaces)
            if let arrow = body.range(of: "=>") { body = String(body[arrow.upperBound...]).trimmingCharacters(in: .whitespaces) }
            if body.hasPrefix("{"), body.hasSuffix("}") { body = String(body.dropFirst().dropLast()) }
            let ms  = Swift.max(250, parts.count > 1 ? (JSE.number(JSE.eval(parts[1], store: store, item: item)) ?? 1000) : 1000)
            let key = parts.count > 2 ? JSE.string(JSE.eval(parts[2], store: store, item: item)) : UUID().uuidString
            let capItem = item, capArgs = args
            func schedule() {
                let work = DispatchWorkItem { [weak store] in
                    guard let store, store.timers[key] != nil else { return }   // cleared / surface gone → stop
                    runActionBody(body, item: capItem, args: capArgs)
                    if store.timers[key] != nil { schedule() }                  // re-arm unless the body cleared it
                }
                store.timers[key]?.cancel(); store.timers[key] = work
                DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000, execute: work)
            }
            schedule()
            return
        }
        if callee == "clearInterval" || callee == "clearTimeout" {
            // clearInterval(key) / clearTimeout(key) — cancel a keyed timer.
            let key = JSE.string(JSE.eval(argStr, store: store, item: item))
            if !key.isEmpty { store.timers[key]?.cancel(); store.timers[key] = nil }
            return
        }
        if let dot = callee.lastIndex(of: ".") {
            let receiver = String(callee[..<dot]), method = String(callee[callee.index(after: dot)...])
            // Declared `<api>` handles — the native twin of the web runner's
            // orders.refresh() / orders.send({...}) / orders.cancel(). Resolve
            // from the weak surface registry before generic object/array/package
            // dispatch, so an API name cannot be mistaken for a package scheme.
            if let block = store.apiHandles[receiver]?.value,
               method == "refresh" || method == "send" || method == "cancel" {
                switch method {
                case "refresh":
                    block.refresh()
                case "send":
                    let raw = argStr.trimmingCharacters(in: .whitespacesAndNewlines)
                    let body = raw.isEmpty
                        ? nil
                        : JSE.eval(raw, store: store, item: item) as? [String: Any]
                    _ = block.send(body)
                default:
                    block.cancel()
                }
                return
            }
            // `ws.send(…)` / `ws.close([code, reason])` — effects on the keyed native socket.
            if method == "send" || method == "close",
               let h = JSE.eval(receiver, store: store, item: item) as? [String: Any],
               let skey = h["__socket"] as? String {
                let parts = JSERunner.splitArgs(argStr).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                if method == "send" {
                    store.sockets[skey]?.send(parts.first.flatMap { JSE.eval($0, store: store, item: item) })
                } else {
                    let code = parts.first.flatMap { JSE.number(JSE.eval($0, store: store, item: item)) }.map(Int.init) ?? 1000
                    let reason = parts.count > 1 ? JSE.string(JSE.eval(parts[1], store: store, item: item)) : ""
                    store.sockets[skey]?.close(code: code, reason: reason)
                    store.sockets[skey] = nil
                }
                return
            }
            // JS core object mutation as a STATEMENT — url.searchParams.set('ref', 'push') /
            // form.append('avatar', file) / headers.set('a', b) / controller.abort(). Value
            // semantics: read the receiver, mutate, write back (the array push/pop pattern).
            // Only OUR marked shapes are claimed — anything else falls through to the package
            // dispatch below exactly as before.
            if JSECore.mutatingMethods.contains(method) {
                let recv = JSE.eval(receiver, store: store, item: item)
                if JSECore.canMutate(method, recv) {
                    let vals = JSERunner.splitArgs(argStr).map { $0.trimmingCharacters(in: .whitespaces) }
                        .filter { !$0.isEmpty }.map { JSE.eval($0, store: store, item: item) }
                    // Params attached to a URL: mutate through the PARENT so href/search resync.
                    if receiver.hasSuffix(".searchParams") {
                        let parent = String(receiver.dropLast(".searchParams".count))
                        if var urlDict = JSE.eval(parent, store: store, item: item) as? [String: Any], urlDict["__url"] != nil {
                            var params: Any = urlDict["searchParams"] ?? [String: Any]()
                            JSECore.mutate(method, &params, args: vals)
                            urlDict["searchParams"] = params
                            JSECore.resyncURL(&urlDict)
                            write(parent, urlDict)
                            return
                        }
                    }
                    mutateValue(receiver, item: item) { v in JSECore.mutate(method, &v, args: vals) }
                    return
                }
            }
            if JSERunner.arrayMethods.contains(method) {
                let parts = JSERunner.splitArgs(argStr).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                func v(_ s: String) -> Any { JSE.eval(s, store: store, item: item) ?? NSNull() }
                switch method {
                case "push":    mutateArray(receiver, item: item) { $0.append(v(parts.first ?? "")) }
                case "unshift": mutateArray(receiver, item: item) { $0.insert(v(parts.first ?? ""), at: 0) }
                case "pop":     mutateArray(receiver, item: item) { if !$0.isEmpty { $0.removeLast() } }
                case "shift":   mutateArray(receiver, item: item) { if !$0.isEmpty { $0.removeFirst() } }
                case "splice":  performSplice(receiver + " = " + parts.joined(separator: ", "), item: item)
                case "sort":    mutateArray(receiver, item: item) { $0 = JSE.sortedArray($0, comparator: v(parts.first ?? ""), store: store) }
                default: break
                }
                return
            }
        }
        if !callee.contains("."), let f = store.actions[callee] {  // action()  /  action(argsObj, { eventCallbacks })
            let argList = JSERunner.splitArgs(argStr)
            var scope = item ?? [:]
            for (k, e) in f.inputs { scope[k] = JSE.eval(e, store: store, item: item) ?? NSNull() }   // declared inputs
            if let first = argList.first, !first.trimmingCharacters(in: .whitespaces).isEmpty,
               let obj = JSE.eval(first, store: store, item: item) as? [String: Any] {
                scope.merge(obj) { _, new in new }                 // 1st arg object → the action's input (overrides)
            }
            if store.actionDepth < 32 {
                store.actionDepth += 1
                let saved = store.actionEvents
                store.actionEvents = argList.count > 1 ? JSERunner.parseHandlers(argList[1]) : [:]   // 2nd arg → event callbacks
                store.actionNameStack.append(callee)                                                 // mark WHICH action is running, so a `dsx.event` it raises is stamped `__from: {type:"action", name}`
                // Isolate the callee's control flow: a `return`/`break`/`continue` is LOCAL to the
                // called action (it ends its body, never the caller's loop/body). A `throw` still
                // propagates (real exception → the caller's try/catch). Actions ARE workflows —
                // one calling another must not inherit its terminator.
                let savedFlow = store.flowSignal
                let savedThrown = store.thrownValue
                let savedBody = store.entryBody
                store.flowSignal = nil
                store.entryBody = f.body                             // uncaught-throw context (snippet)
                let traceStart = JSETrace.shared.enabled ? Date() : nil
                runActionBody(f.body, item: scope, args: args)
                if let traceStart { JSETrace.shared.log("action", "\(callee) (\(Int(Date().timeIntervalSince(traceStart) * 1000))ms)") }
                // RETURNING ACTIONS: surface the callee's OWN `return <expr>` value — visible
                // only when ITS body ended via `return` (the flow signal), so a nested call's
                // leftover can never masquerade as this callee's return. An AWAITING
                // `dsx.action` caller (callActionForValue) binds it; every other call site
                // leaves it for the next branch exit to overwrite.
                let returned = store.flowSignal == "return" ? store.returnValue : nil
                if store.flowSignal != "throw" { store.flowSignal = savedFlow; store.thrownValue = savedThrown; store.entryBody = savedBody }
                store.returnValue = returned
                store.actionNameStack.removeLast()
                store.actionEvents = saved
                store.actionDepth -= 1
            }
            return
        }
        dispatch(a, item: item)                                    // package call: pkg.method(named args)
    }

    /// Bridge a DSX event onto the in-process native bus (`DSXEventBus`), so ANY package can
    /// consume it with `dsx.events.on(scheme) { event, data in … }` — the same API used for
    /// cross-package broadcasts (and the Kotlin/Java mirror). This is how a DSX component (a
    /// video / vertical player, …) sends events to Swift/Kotlin and a package wraps it as its own
    /// event. A namespaced name (`player:seeked`) maps to scheme `player`, event `seeked`; a
    /// bare name (`ended`) uses scheme `dsx`. No-op when nothing is subscribed.
    static func publishNative(_ name: String, _ payload: [String: Any], source: String? = nil) {
        if let i = name.firstIndex(of: ":") {                       // explicit scheme:event wins
            DSXEvents().publish(String(name[..<i]), String(name[name.index(after: i)...]), payload)
        } else {                                                    // else the originating component's tag, else "dsx"
            DSXEvents().publish(source ?? "dsx", name, payload)
        }
    }

    /// Stamp the emitter's identity onto an event payload as `__from = { type, name }`, so a
    /// consumer's `from:<event>` filter (see `OnHandler.from`) can scope to ONE source — the
    /// modern, no-bus twin of the removed `<listener from:action=>`. A nil/empty name (an event
    /// raised with no action/component identity in scope) leaves the payload untouched, so a plain
    /// `dsx.event('x')` is unchanged for the unfiltered 90% case. Never overwrites a `__from` an
    /// inner emit already set (the innermost emitter owns its identity).
    static func stampFrom(_ payload: [String: Any], type: String, name: String?) -> [String: Any] {
        guard let name, !name.isEmpty, payload["__from"] == nil else { return payload }
        var out = payload
        out["__from"] = ["type": type, "name": name]
        return out
    }

    /// Run a `;`/newline-separated sequence with if/else control flow. Verbs run in order;
    /// `if: cond` / `elif: cond` / `else:` / `end:` gate execution via a nestable skip-stack.
    /// (No `if:` ⇒ it's just a sequence.) Conditions are normal expressions evaluated against
    /// the current scope.
    /// Run a bounded-JS action body — `if/else`, `while` / `for` / `for…of` (iteration-budgeted, so
    /// remote DSX can never hang the app), `switch` (JS fallthrough + `break`), `try/catch/finally`
    /// + `throw`, `break`/`continue`/`return`, `const`/`let` locals, and statements (the effect
    /// verbs + JS forms `x = e` / `x += e` / `i++` / `arr.push(x)` / `pkg.m(a=b)` / `name()`)
    /// separated by `;` / newline. Still TOTAL: loops draw on `store.loopWork` (cap `loopCap` per
    /// entry event — past it the loop aborts with a log), recursion stays depth-capped. Control
    /// flow propagates via `store.flowSignal` ("break"/"continue"/"return"/"throw"): a block stops
    /// EXECUTING when a signal is in flight but keeps PARSING (so the walk stays aligned), and the
    /// owning construct consumes it. String-based; leaf statements run through `runVerb`.
    private func runActionBody(_ body: String, item: [String: Any]?, args: [String: Any]) {
        // /web/15: a body beyond the JSE subset ESCALATES to the engine (JavaScriptCore —
        // bound by default on iOS, Tier.swift) instead of mis-running through this
        // interpreter. The seam mirrors JseRunner.kt exactly; with no engine bound the
        // path is js_tier_unavailable through the ambient fan-out — visible, fail-open.
        let verdict = TierClassifier.classify(body)
        if verdict.tier == .js {
            guard let engine = JsTier.engine else {
                reportAmbientError(scheme: "app", code: "js_tier_unavailable",
                                   message: "this body needs the JS tier (\(verdict.reason ?? "beyond the JSE subset")) — no escalation engine is bound on this build",
                                   recoverable: true, data: ["snippet": String(body.prefix(120))],
                                   origin: "uncaught")
                return
            }
            engine.run(body, env: jsTierEnv(item: item), done: {})
            return
        }
        var locals = item ?? [:]
        let c = Array(Self.stripJSComments(body)); var i = 0   // idempotent — direct callers (continuations) may pass pre-stripped text
        runActionBlock(c, &i, &locals, args, execute: true, topLevel: true)
    }

    /// The escalation env (/web/15 law 3) — the engine reaches THIS runner's store
    /// routing, its depth-guarded actions, the ONE module funnel, and the emitters;
    /// never live state, never a capability the JSE tier lacks. Module calls ride the
    /// SAME dispatch funnel authored statements use (JSON args are a valid JSE object
    /// literal); the engine settles the promise with the funnel's envelope contract.
    private func jsTierEnv(item: [String: Any]?) -> JsTierEnvironment {
        // JSERunner is a struct — the copy is cheap and correct: every piece of state it
        // routes to (the store, DSXState, the ledgers) is a class reference it shares.
        struct Env: JsTierEnvironment {
            let runner: JSERunner
            let item: [String: Any]?
            func read(_ path: String) -> Any? { JSE.eval(path, store: runner.store, item: item) }
            func write(_ path: String, _ value: Any?) { runner.write(path, value ?? NSNull()) }
            func callAction(_ name: String, _ args: [String: Any]) -> Any? {
                runner.callActionForValue(name: name, argStr: "", locals: item ?? [:], args: args)
            }
            func callModule(_ chain: String, _ args: [String: Any], _ completion: @escaping (Any?) -> Void) {
                runner.dispatch("\(chain)(\(JSERunner.jsonLiteral(args)))", item: item)
                completion(nil)
            }
            func emitEvent(_ name: String, _ payload: [String: Any]) { runner.emitEventUp(name, payload, item: item) }
            func log(_ message: String) { kernelLog("[dsx.log]", message) }
            func error(_ code: String, _ message: String) {
                reportAmbientError(scheme: "app", code: code, message: message,
                                   recoverable: true, data: nil, origin: "call")
            }
        }
        return Env(runner: self, item: item)
    }

    /// args → a JSON object literal (valid JSE source — the seam's wire form; the Kotlin
    /// twin's jsonLiteral verbatim).
    static func jsonLiteral(_ value: Any?) -> String {
        switch value {
        case nil, is NSNull:
            return "null"
        case let b as Bool:
            return b ? "true" : "false"
        case let n as NSNumber:
            return JSE.string(n)
        case let s as String:
            let escaped = s.replacingOccurrences(of: "\\", with: "\\\\")
                           .replacingOccurrences(of: "\"", with: "\\\"")
                           .replacingOccurrences(of: "\n", with: "\\n")
                           .replacingOccurrences(of: "\r", with: "\\r")
                           .replacingOccurrences(of: "\t", with: "\\t")
            return "\"\(escaped)\""
        case let d as [String: Any]:
            return "{" + d.map { "\(jsonLiteral($0.key)):\(jsonLiteral($0.value))" }.joined(separator: ",") + "}"
        case let a as [Any]:
            return "[" + a.map { jsonLiteral($0) }.joined(separator: ",") + "]"
        default:
            return jsonLiteral(String(describing: value ?? ""))
        }
    }
    private func runActionBlock(_ c: [Character], _ i: inout Int, _ locals: inout [String: Any], _ args: [String: Any], execute: Bool, topLevel: Bool = false) {
        while i < c.count {
            jsSkipWs(c, &i)
            if i >= c.count { break }
            if c[i] == "}" { return }                              // end of this { } block (caller consumes '}')
            if c[i] == ";" { i += 1; continue }
            // A flow signal in flight (break/continue/return/throw) stops EXECUTION for the rest
            // of this block — but parsing continues, so the index walk stays aligned and the
            // construct that owns the signal (loop / switch / try) can consume it.
            let exec = execute && store.flowSignal == nil
            if c[i] == "{" {                                       // a bare `{ … }` scope block
                i += 1; runActionBlock(c, &i, &locals, args, execute: exec)
                jsSkipWs(c, &i); if i < c.count, c[i] == "}" { i += 1 }; continue
            }
            // `const r = await fetch(url, { method, body, headers })` — the web fetch JS API.
            // Suspends: the request runs off the body, `r` gets { data, error, status, ok }, then the
            // REST of the body runs as the continuation (so the `if (r.error)` after it sees the
            // result). Top-level only (a nested await stays a normal expression).
            if topLevel, exec, let af = matchAwaitFetch(c, i) {
                var j = af.after; jsSkipWs(c, &j)
                runAwaitFetch(bind: af.bind, args: af.args, locals: locals, args: args, rest: j < c.count ? String(c[j...]) : "")
                return
            }
            // `const env = await fetch: dest = GET /url` — await the REACTIVE fetch EFFECT inline
            // (the `{ loading, error, data }` envelope verb, distinct from `await fetch(…)` the JS
            // API). The effect writes its envelope to `dest.*` as always (so a bound spinner still
            // works); the await additionally suspends until it settles and binds the settled
            // envelope to the `const`, then the rest of the body runs as the continuation. The
            // colon after `fetch` is what selects this form, vs the open-paren of the JS API above.
            if topLevel, exec, let fe = matchAwaitFetchEffect(c, i) {
                var j = fe.after; jsSkipWs(c, &j)
                runAwaitFetchEffect(bind: fe.bind, spec: fe.spec, locals: locals, args: args,
                                    rest: j < c.count ? String(c[j...]) : "")
                return
            }
            // `const r = await orders.send({...})` — the awaitable `<api>`
            // mutation handle. It resumes this action with the transport envelope,
            // preserving locals and event callbacks across suspension just like
            // await fetch / await dsx.module.
            if topLevel, exec, let aa = matchAwaitApi(c, i) {
                var j = aa.after; jsSkipWs(c, &j)
                runAwaitApi(bind: aa.bind, api: aa.api, verb: aa.verb, argStr: aa.args,
                            locals: locals, args: args,
                            rest: j < c.count ? String(c[j...]) : "")
                return
            }
            // `const r = await dsx.module.scheme.method({ … })` — an AWAITABLE package call: the
            // package's resolve/error lands in `r` with the uniform contract
            //   { ok: true,  data: <resolve payload> }   |   { ok: false, error: <code>, data }
            // then the rest of the body runs as the continuation. `dsx.module.self.…` resolves to
            // the owning package. Unavailable package → { ok: false, error: "unavailable" }.
            if topLevel, exec, let ap = matchAwaitPackage(c, i) {
                var j = ap.after; jsSkipWs(c, &j)
                runAwaitPackage(bind: ap.bind, callee: ap.callee, argStr: ap.args,
                                locals: locals, args: args, rest: j < c.count ? String(c[j...]) : "")
                return
            }
            // `const ok = await dsx.event('confirm', { … })` — REQUEST/RESPONSE events: suspend
            // until a consumer's `on:confirm="resolve: …"` handler replies (else `error:` → falsy). The
            // value routes back to THIS caller via a correlation token stamped on the payload, so N
            // concurrent requests stay distinct. The handler may itself `await` (a confirm sheet)
            // before replying — its continuation preserves the token. See runAwaitEvent.
            if topLevel, exec, let ae = matchAwaitEvent(c, i) {
                var j = ae.after; jsSkipWs(c, &j)
                runAwaitEvent(bind: ae.bind, argStr: ae.args, locals: locals, args: args,
                              rest: j < c.count ? String(c[j...]) : "")
                return
            }
            // `const r = await crypto.subtle.<method>( … )` — the Web Crypto API, 1:1. The args
            // evaluate in scope NOW; the work (digest/encrypt/sign/deriveBits/generateKey/…) runs
            // OFF the main thread (PBKDF2 iterations, RSA keygen are real work), then the rest of
            // the body runs as the continuation with `r` bound — exactly the fetch contract.
            // (In expression position — `{{ }}` / nested — crypto.subtle.* evaluates synchronously.)
            if topLevel, exec, let ac = matchAwaitCrypto(c, i) {
                var j = ac.after; jsSkipWs(c, &j)
                runAwaitCrypto(bind: ac.bind, method: ac.method, argStr: ac.args,
                               locals: locals, args: args, rest: j < c.count ? String(c[j...]) : "")
                return
            }
            // `const [a, b] = await Promise.all([ fetch(u1), fetch(u2), dsx.module.x.y({…}) ])` —
            // the JS combinators, 1:1: the array's async elements (fetch / dsx.module / crypto.subtle)
            // run CONCURRENTLY; plain expressions settle immediately. `all` binds the results in
            // order; `race`/`any` binds the first to settle; `allSettled` wraps each as
            // { status: 'fulfilled', value } (JSE's async ops report errors AS values — fetch
            // returns { ok:false, error }, packages { ok:false } — so nothing ever "rejects").
            if topLevel, exec, let pm = matchAwaitPromise(c, i) {
                var j = pm.after; jsSkipWs(c, &j)
                runAwaitPromise(kind: pm.kind, bind: pm.bind, elements: pm.elements,
                                locals: locals, args: args, rest: j < c.count ? String(c[j...]) : "")
                return
            }
            // `const ws = new WebSocket(url[, { key }])` — KEYED + SURFACE-SCOPED (the timer
            // contract): same key replaces the previous socket (a re-run can't double-connect;
            // default key = the url), and every socket closes when the surface's store
            // deallocates — route changes never leak connections. Synchronous (no suspension):
            // the handle binds and the body continues. Handlers attach via `ws.onopen/onmessage/
            // onerror/onclose = e => { … }` assignments; `ws.send(…)` / `ws.close()` are
            // statements. Background realtime stays a package — core is foreground transport.
            if exec, let w = matchNewWebSocket(c, i) {
                i = w.after
                let handle = openWebSocket(argStr: w.args, locals: locals)
                if let bind = w.bind { locals[bind] = handle }
                continue
            }
            // `const r = await dsx.action.name({ … })` — a RETURNING action call (actions
            // corpus): actions run SYNCHRONOUSLY here (they only suspend at their OWN awaits,
            // which re-enter continuations), so this never suspends — run it via the existing
            // dispatch, read the return-value ledger, bind { ok: true, data } to the target,
            // and continue the walk INLINE (no continuation machinery). The assignment form
            // `r = await dsx.action.x()` writes the STORE (the pinned `x = e` rule). A `throw`
            // that unwinds the callee keeps propagating (no envelope, no bind) — the exec gate
            // stops the rest of this block and the enclosing try's catch sees it, exactly the
            // un-awaited contract. Matched at ANY nesting level (it is synchronous).
            if exec, let aa = matchAwaitAction(c, i) {
                i = aa.after
                if let envelope = callActionForValue(name: aa.name, argStr: aa.args, locals: locals, args: args),
                   let bind = aa.bind {
                    if aa.decl { locals[bind] = envelope } else { write(bind, envelope) }
                }
                continue
            }
            if jsWord(c, i, "if") { runActionIf(c, &i, &locals, args, execute: exec); continue }
            if jsWord(c, i, "while") { runActionWhile(c, &i, &locals, args, execute: exec); continue }
            if jsWord(c, i, "do") { runActionDoWhile(c, &i, &locals, args, execute: exec); continue }
            if jsWord(c, i, "for") { runActionFor(c, &i, &locals, args, execute: exec); continue }
            if jsWord(c, i, "switch") { runActionSwitch(c, &i, &locals, args, execute: exec); continue }
            if jsWord(c, i, "try") { runActionTry(c, &i, &locals, args, execute: exec); continue }
            if jsWord(c, i, "const") || jsWord(c, i, "let") || jsWord(c, i, "var") { runActionDecl(c, &i, &locals, execute: exec); continue }
            let before = i
            let stmt = jsLeaf(c, &i).trimmingCharacters(in: .whitespaces)
            if i == before { i += 1; continue }   // stray char (e.g. a lone ')') — skip; never spin
            guard exec, !stmt.isEmpty else { continue }
            if flowLeaf(stmt, locals: locals) { continue }        // break / continue / return [e] / throw e
            // `await` for the action-callback flow: when an action was called WITH event callbacks,
            // a top-level `fetch:` runs the rest of the body as its completion — so `fetch: x = …;
            // if (x.error) dsx.event(…)` sees the result. Plain actions (no callbacks) keep the
            // existing fire-and-forget fetch, so nothing else changes.
            if topLevel, stmt.hasPrefix("fetch:"), !store.actionEvents.isEmpty {
                var j = i; jsSkipWs(c, &j)
                if j < c.count {
                    let rest = String(c[j...]); let handlers = store.actionEvents; let scope = locals
                    performFetch(String(stmt.dropFirst(6)), item: scope) { [self] in
                        let saved = store.actionEvents
                        store.actionEvents = handlers
                        runActionBody(rest, item: scope, args: args)
                        store.actionEvents = saved
                    }
                    return
                }
            }
            runVerb(stmt, item: locals, args: args)
        }
    }

    /// Match `[const|let|var NAME =] await fetch( … )` at `start` → the bind name (if any), the
    /// call's argument string, and the index just past the statement (incl. a trailing `;`).
    private func matchAwaitFetch(_ c: [Character], _ start: Int) -> (bind: String?, args: String, after: Int)? {
        var p = start; var bind: String? = nil
        for kw in ["const", "let", "var"] where jsWord(c, p, kw) {
            p += kw.count; jsSkipWs(c, &p)
            var name = ""
            while p < c.count, jsIsWord(c[p]) { name.append(c[p]); p += 1 }
            jsSkipWs(c, &p)
            guard p < c.count, c[p] == "=" else { return nil }
            p += 1; jsSkipWs(c, &p); bind = name; break
        }
        guard jsWord(c, p, "await") else { return nil }
        p += 5; jsSkipWs(c, &p)
        guard jsWord(c, p, "fetch") else { return nil }
        p += 5; jsSkipWs(c, &p)
        guard p < c.count, c[p] == "(" else { return nil }
        let args = jsParens(c, &p)
        var q = p; jsSkipWs(c, &q); if q < c.count, c[q] == ";" { q += 1 }
        return (bind, args, q)
    }

    /// Run `await fetch(url, { method, body, headers, signal })`: the request runs off the action
    /// body, `bind` (the `const`) gets the Response-shaped result — { ok, status, statusText,
    /// headers, data, text, error? } with res.json()/res.text() methods — then `rest` runs as the
    /// continuation, the action's event callbacks preserved across the suspension.
    private func runAwaitFetch(bind: String?, args argsStr: String, locals: [String: Any], args: [String: Any], rest: String) {
        let handlers = store.actionEvents
        fetchOp(argsStr, locals: locals) { result in
            // JSERunner is a struct — the closure captures a value copy (no weak; the copy
            // shares the store class reference, which is the identity that matters).
            var scope = locals
            if let bind { scope[bind] = result }
            self.store.actionEvents = handlers
            self.runActionBody(rest, item: scope, args: args)
        }
    }

    /// Match `[const|let|var NAME =] await fetch: <spec>` at `start` → the bind name (if any), the
    /// effect SPEC (`dest = METHOD url [body=…] [headers=…]`, the rest of the leaf statement), and
    /// the index just past it. Selected by the `:` right after `fetch` (the reactive-effect form),
    /// vs the open-paren of `await fetch(…)` the JS API — so the two never collide.
    private func matchAwaitFetchEffect(_ c: [Character], _ start: Int) -> (bind: String?, spec: String, after: Int)? {
        var p = start; var bind: String? = nil
        for kw in ["const", "let", "var"] where jsWord(c, p, kw) {
            p += kw.count; jsSkipWs(c, &p)
            var name = ""
            while p < c.count, jsIsWord(c[p]) { name.append(c[p]); p += 1 }
            jsSkipWs(c, &p)
            guard p < c.count, c[p] == "=" else { return nil }
            p += 1; jsSkipWs(c, &p); bind = name; break
        }
        guard jsWord(c, p, "await") else { return nil }
        p += 5; jsSkipWs(c, &p)
        guard jsWord(c, p, "fetch") else { return nil }
        p += 5; jsSkipWs(c, &p)
        guard p < c.count, c[p] == ":" else { return nil }              // the effect form `fetch:`, not the JS-API call form
        p += 1
        let spec = jsLeaf(c, &p)                                        // rest of the statement: `dest = GET /url …`
        return (bind, spec, p)
    }

    /// Run `await fetch: dest = METHOD url …`: fire the reactive fetch EFFECT (it writes the
    /// `{ loading, error, data }` envelope to `dest.*` as usual — a bound spinner still works), and
    /// when it settles bind the settled envelope (read back from `dest`) to `bind`, then run `rest`
    /// as the continuation. The action's event callbacks are preserved across the suspension, like
    /// `await fetch(…)`. The bound value is the same envelope `{ loading:false, error, data }`, so
    /// `if (env.error)` / `env.data` read inline — sequential logic over the spinner effect.
    private func runAwaitFetchEffect(bind: String?, spec: String, locals: [String: Any], args: [String: Any], rest: String) {
        let handlers = store.actionEvents
        let dest = spec.split(separator: "=").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        performFetch(spec, item: locals) { [self] in
            var scope = locals
            if let bind, !dest.isEmpty { scope[bind] = JSE.eval(dest, store: store, item: locals) ?? NSNull() }
            store.actionEvents = handlers
            runActionBody(rest, item: scope, args: args)
        }
    }

    /// Match `[const|let|var NAME =] await <api>.send(...)` (and refresh).
    /// The name is claimed only when the live surface registry contains it, so
    /// ordinary awaited expressions remain untouched.
    private func matchAwaitApi(
        _ c: [Character],
        _ start: Int
    ) -> (bind: String?, api: String, verb: String, args: String, after: Int)? {
        var p = start
        var bind: String?
        for kw in ["const", "let", "var"] where jsWord(c, p, kw) {
            p += kw.count
            jsSkipWs(c, &p)
            var name = ""
            while p < c.count, jsIsWord(c[p]) { name.append(c[p]); p += 1 }
            jsSkipWs(c, &p)
            guard !name.isEmpty, p < c.count, c[p] == "=" else { return nil }
            p += 1
            jsSkipWs(c, &p)
            bind = name
            break
        }
        guard jsWord(c, p, "await") else { return nil }
        p += 5
        jsSkipWs(c, &p)
        var api = ""
        while p < c.count, jsIsWord(c[p]) { api.append(c[p]); p += 1 }
        guard !api.isEmpty, store.apiHandles[api]?.value != nil, p < c.count, c[p] == "." else { return nil }
        p += 1
        var verb = ""
        while p < c.count, jsIsWord(c[p]) { verb.append(c[p]); p += 1 }
        guard verb == "send" || verb == "refresh" else { return nil }
        jsSkipWs(c, &p)
        guard p < c.count, c[p] == "(" else { return nil }
        let callArgs = jsParens(c, &p)
        var q = p
        jsSkipWs(c, &q)
        if q < c.count, c[q] == ";" { q += 1 }
        return (bind, api, verb, callArgs, q)
    }

    private func runAwaitApi(
        bind: String?,
        api: String,
        verb: String,
        argStr: String,
        locals: [String: Any],
        args: [String: Any],
        rest: String
    ) {
        guard let block = store.apiHandles[api]?.value else {
            var scope = locals
            if let bind { scope[bind] = NSNull() }
            runActionBody(rest, item: scope, args: args)
            return
        }
        let handlers = store.actionEvents
        let resume: (ApiBlock.FetchResult?) -> Void = { result in
            var scope = locals
            if let bind { scope[bind] = result ?? NSNull() }
            self.store.actionEvents = handlers
            self.runActionBody(rest, item: scope, args: args)
        }
        if verb == "refresh" {
            block.refresh(completion: resume)
        } else {
            let raw = argStr.trimmingCharacters(in: .whitespacesAndNewlines)
            let body = raw.isEmpty
                ? nil
                : JSE.eval(raw, store: store, item: locals) as? [String: Any]
            _ = block.send(body, completion: resume)
        }
    }

    /// ONE fetch as a completion-style op (completion on main) — shared by `await fetch` and the
    /// Promise combinators. The full web-fetch shape: a URL string / `new URL(…)` / `new
    /// Request(…)` first argument; `headers` from a plain object or `new Headers(…)`; `body` as a
    /// JSON object, a string (JSON.stringify output — Content-Type text/plain unless set), a
    /// `FormData` (multipart with Blob/File parts), or a `Blob`; `signal` from an AbortController
    /// (abort = the result is discarded and { ok:false, error:'aborted' } settles instead).
    private func fetchOp(_ argsStr: String, locals: [String: Any], completion: @escaping (Any) -> Void) {
        let parts = JSERunner.splitArgs(argsStr)
        let first = JSE.eval(parts.first ?? "", store: store, item: locals)
        var url: String
        var method = "GET"; var bodyData: Data? = nil; var headers: [String: String] = [:]
        var signalId: String? = nil
        if let req = first as? [String: Any], req["__request"] != nil {       // new Request(url, opts)
            url = JSE.string(req["url"])
            method = JSE.string(req["method"] ?? "GET")
            JSECore.applyHeaders(req["headers"], into: &headers)
            bodyData = JSECore.bodyData(req["body"], headers: &headers)
            signalId = (req["signal"] as? [String: Any])?["__signal"] as? String
        } else {
            url = JSE.string(first)                                           // string / new URL(…) → href
        }
        if parts.count > 1, let opts = JSE.eval(parts[1], store: store, item: locals) as? [String: Any] {
            if let m = opts["method"] { method = JSE.string(m) }
            JSECore.applyHeaders(opts["headers"], into: &headers)
            if let b = opts["body"] { bodyData = JSECore.bodyData(b, headers: &headers) }
            if let sig = opts["signal"] as? [String: Any], let id = sig["__signal"] as? String { signalId = id }
        }
        if let signalId, JSECore.aborted(signalId) {
            completion(["__response": true, "ok": false, "error": "aborted"]); return
        }
        let traceStart = Date()
        Task { @MainActor in
            var result: [String: Any] = ["__response": true]
            if let res = await StackTransportSeam.requestFull(url, method, headers, bodyData) {
                if let signalId, JSECore.aborted(signalId) {
                    result["ok"] = false; result["error"] = "aborted"
                } else {
                    result["status"] = Double(res.status)
                    result["ok"] = (200..<300).contains(res.status)
                    result["statusText"] = HTTPURLResponse.localizedString(forStatusCode: res.status)
                    var hdrs: [String: Any] = [:]
                    for (k, v) in res.headers { hdrs[k] = v }
                    hdrs["__headers"] = true
                    result["headers"] = hdrs
                    result["text"] = String(data: res.data, encoding: .utf8) ?? ""
                    // Parsed body regardless of status (res.json() works on 4xx, like the web).
                    result["data"] = (try? JSONSerialization.jsonObject(with: res.data, options: [.fragmentsAllowed])) ?? NSNull()
                    if !(200..<300).contains(res.status) { result["error"] = "http \(res.status)" }
                }
            } else {
                result["ok"] = false; result["error"] = "network"
            }
            if JSETrace.shared.enabled {
                let ms = Int(Date().timeIntervalSince(traceStart) * 1000)
                let outcome = result["status"].map { JSE.string($0) } ?? JSE.string(result["error"] ?? "?")
                JSETrace.shared.log("fetch", "\(method) \(JSERedact.maskURL(url)) → \(outcome) (\(ms)ms)")
            }
            completion(result)
        }
    }

    /// Match `[const|let|var NAME =] await crypto.subtle.method( … )` at `start` → the bind
    /// name, the subtle method, the call's argument string, and the index just past the
    /// statement (incl. a trailing `;`).
    private func matchAwaitCrypto(_ c: [Character], _ start: Int) -> (bind: String?, method: String, args: String, after: Int)? {
        var p = start; var bind: String? = nil
        for kw in ["const", "let", "var"] where jsWord(c, p, kw) {
            p += kw.count; jsSkipWs(c, &p)
            var name = ""
            while p < c.count, jsIsWord(c[p]) { name.append(c[p]); p += 1 }
            jsSkipWs(c, &p)
            guard p < c.count, c[p] == "=" else { return nil }
            p += 1; jsSkipWs(c, &p); bind = name; break
        }
        guard jsWord(c, p, "await") else { return nil }
        p += 5; jsSkipWs(c, &p)
        let prefix = "crypto.subtle."
        for ch in prefix { guard p < c.count, c[p] == ch else { return nil }; p += 1 }
        var method = ""
        while p < c.count, jsIsWord(c[p]) { method.append(c[p]); p += 1 }
        jsSkipWs(c, &p)
        guard !method.isEmpty, p < c.count, c[p] == "(" else { return nil }
        let args = jsParens(c, &p)
        var q = p; jsSkipWs(c, &q); if q < c.count, c[q] == ";" { q += 1 }
        return (bind, method, args, q)
    }

    /// Run `await crypto.subtle.<method>(…)`: args evaluate in the CURRENT scope, the crypto work
    /// runs on a utility queue (never the main thread), then `rest` continues with `bind` holding
    /// the result — bytes as plain number arrays, keys as CryptoKey dicts, verify as Bool.
    /// Total like everything in JSE: an unsupported algorithm/key logs and binds null.
    private func runAwaitCrypto(bind: String?, method: String, argStr: String,
                                locals: [String: Any], args: [String: Any], rest: String) {
        let handlers = store.actionEvents
        cryptoOp(method, argStr, locals: locals) { result in
            var scope = locals
            if let bind { scope[bind] = result }
            self.store.actionEvents = handlers
            self.runActionBody(rest, item: scope, args: args)
        }
    }
    /// ONE crypto.subtle call as a completion-style op (args evaluate NOW in scope; the work runs
    /// on a utility queue; completion on main) — shared by `await crypto.subtle.*` and Promise.
    private func cryptoOp(_ method: String, _ argStr: String, locals: [String: Any], completion: @escaping (Any) -> Void) {
        let values = JSERunner.splitArgs(argStr).map { JSE.eval($0, store: store, item: locals) }
        DispatchQueue.global(qos: .userInitiated).async {
            let result = JSECrypto.call("crypto.subtle." + method, values)
            DispatchQueue.main.async { completion(result ?? NSNull()) }
        }
    }

    /// Match `[const|let|var NAME =] new WebSocket( … )` at `start` → the bind name, the
    /// call's argument string, and the index just past the statement.
    private func matchNewWebSocket(_ c: [Character], _ start: Int) -> (bind: String?, args: String, after: Int)? {
        var p = start; var bind: String? = nil
        for kw in ["const", "let", "var"] where jsWord(c, p, kw) {
            p += kw.count; jsSkipWs(c, &p)
            var name = ""
            while p < c.count, jsIsWord(c[p]) { name.append(c[p]); p += 1 }
            jsSkipWs(c, &p)
            guard p < c.count, c[p] == "=" else { return nil }
            p += 1; jsSkipWs(c, &p); bind = name; break
        }
        guard jsWord(c, p, "new") else { return nil }
        p += 3; jsSkipWs(c, &p)
        guard jsWord(c, p, "WebSocket") else { return nil }
        p += 9; jsSkipWs(c, &p)
        guard p < c.count, c[p] == "(" else { return nil }
        let args = jsParens(c, &p)
        var q = p; jsSkipWs(c, &q); if q < c.count, c[q] == ";" { q += 1 }
        return (bind, args, q)
    }

    /// Open (or replace) a keyed socket on this surface's store and return its handle dict.
    /// The handler scope captured here is the locals at CONSTRUCTION (the closure contract
    /// timers use); the live connection itself lives on the store, not in the value.
    private func openWebSocket(argStr: String, locals: [String: Any]) -> [String: Any] {
        let parts = JSERunner.splitArgs(argStr)
        let url = JSE.string(JSE.eval(parts.first ?? "", store: store, item: locals))
        var key = url
        if parts.count > 1, let opts = JSE.eval(parts[1], store: store, item: locals) as? [String: Any],
           let k = opts["key"] { key = JSE.string(k) }
        store.sockets[key]?.close()                              // same key → replace (no double-connect)
        store.sockets[key] = JSESocket(url: url, key: key, store: store, webView: webView, scope: scope, dsx: dsx)
        return ["__socket": key, "url": url]
    }

    /// Split an arrow handler's source into (param, body) — `e => { … }` / `() => expr`.
    static func parseArrow(_ raw: String) -> (param: String, body: String) {
        let s = raw.trimmingCharacters(in: .whitespaces)
        guard let arrow = s.range(of: "=>") else { return ("e", s) }
        var param = String(s[..<arrow.lowerBound]).trimmingCharacters(in: .whitespaces)
        param = param.trimmingCharacters(in: CharacterSet(charactersIn: "() ")).trimmingCharacters(in: .whitespaces)
        var body = String(s[arrow.upperBound...]).trimmingCharacters(in: .whitespaces)
        if body.hasPrefix("{"), body.hasSuffix("}") { body = String(body.dropFirst().dropLast()) }
        return (param.isEmpty ? "e" : param, body)
    }

    /// Run a socket handler body (already on main) — the registration-time scope plus the
    /// event payload under the arrow's parameter name.
    func runSocketHandler(_ body: String, scope: [String: Any]) {
        runActionBody(body, item: scope, args: [:])
    }

    /// Match `[const|let|var NAME =] await Promise.all|race|any|allSettled([ … ])` at `start` →
    /// the bind name, the combinator, the array's top-level elements, and the index past the
    /// statement.
    private func matchAwaitPromise(_ c: [Character], _ start: Int) -> (bind: String?, kind: String, elements: [String], after: Int)? {
        var p = start; var bind: String? = nil
        for kw in ["const", "let", "var"] where jsWord(c, p, kw) {
            p += kw.count; jsSkipWs(c, &p)
            var name = ""
            while p < c.count, jsIsWord(c[p]) { name.append(c[p]); p += 1 }
            jsSkipWs(c, &p)
            guard p < c.count, c[p] == "=" else { return nil }
            p += 1; jsSkipWs(c, &p); bind = name; break
        }
        guard jsWord(c, p, "await") else { return nil }
        p += 5; jsSkipWs(c, &p)
        let prefix = "Promise."
        for ch in prefix { guard p < c.count, c[p] == ch else { return nil }; p += 1 }
        var kind = ""
        while p < c.count, jsIsWord(c[p]) { kind.append(c[p]); p += 1 }
        guard ["all", "race", "any", "allSettled"].contains(kind) else { return nil }
        jsSkipWs(c, &p)
        guard p < c.count, c[p] == "(" else { return nil }
        let inner = jsParens(c, &p)
        var q = p; jsSkipWs(c, &q); if q < c.count, c[q] == ";" { q += 1 }
        var body = inner.trimmingCharacters(in: .whitespacesAndNewlines)
        guard body.hasPrefix("["), body.hasSuffix("]") else { return nil }
        body = String(body.dropFirst().dropLast())
        let elements = JSERunner.splitArgs(body).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return (bind, kind, elements, q)
    }

    /// Run a Promise combinator: every element starts NOW (concurrent); `all` binds the results
    /// in order, `race`/`any` binds the first to settle, `allSettled` wraps each as
    /// { status: 'fulfilled', value }. All bookkeeping is main-thread (ops complete on main).
    private func runAwaitPromise(kind: String, bind: String?, elements: [String],
                                 locals: [String: Any], args: [String: Any], rest: String) {
        let handlers = store.actionEvents
        let continueWith: (Any) -> Void = { value in
            var scope = locals
            if let bind { scope[bind] = value }
            self.store.actionEvents = handlers
            self.runActionBody(rest, item: scope, args: args)
        }
        let n = elements.count
        guard n > 0 else { continueWith((kind == "race" || kind == "any") ? NSNull() : [Any]()); return }
        var results = [Any](repeating: NSNull(), count: n)
        var remaining = n
        var settled = false
        for (idx, el) in elements.enumerated() {
            startOp(el, locals: locals) { value in
                if kind == "race" || kind == "any" {
                    guard !settled else { return }
                    settled = true
                    continueWith(value)
                    return
                }
                results[idx] = value
                remaining -= 1
                if remaining == 0 {
                    if kind == "allSettled" {
                        let settledResults: [Any] = results.map { ["status": "fulfilled", "value": $0] as [String: Any] }
                        continueWith(settledResults)
                    } else {
                        continueWith(results)
                    }
                }
            }
        }
    }

    /// Start ONE element of a Promise combinator: fetch(…) / dsx.module.… / crypto.subtle.… run
    /// async (concurrently with their siblings); anything else evaluates synchronously and
    /// settles on the next main-thread tick (so the combinator's bookkeeping stays uniform).
    private func startOp(_ raw: String, locals: [String: Any], completion: @escaping (Any) -> Void) {
        var el = raw
        if el.hasPrefix("await ") { el = String(el.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
        if el.hasPrefix("fetch("), el.hasSuffix(")") {
            fetchOp(String(el.dropFirst(6).dropLast()), locals: locals, completion: completion); return
        }
        if el.hasPrefix("dsx.module."), let lp = el.firstIndex(of: "("), el.hasSuffix(")") {
            let callee = String(el[el.index(el.startIndex, offsetBy: 12)..<lp])
            let argStr = String(el[el.index(after: lp)..<el.index(before: el.endIndex)])
            packageOp(callee, argStr, locals: locals, completion: completion); return
        }
        if el.hasPrefix("crypto.subtle."), let lp = el.firstIndex(of: "("), el.hasSuffix(")") {
            let method = String(el[el.index(el.startIndex, offsetBy: 14)..<lp])
            let argStr = String(el[el.index(after: lp)..<el.index(before: el.endIndex)])
            cryptoOp(method, argStr, locals: locals, completion: completion); return
        }
        let v = JSE.eval(el, store: store, item: locals) ?? NSNull()
        DispatchQueue.main.async { completion(v) }
    }

    /// Match `[const|let|var NAME =] await dsx.module.scheme.method( … )` at `start` → the bind
    /// name, the dotted callee (after `dsx.module.`), the call's argument string, and the index
    /// just past the statement (incl. a trailing `;`).
    private func matchAwaitPackage(_ c: [Character], _ start: Int) -> (bind: String?, callee: String, args: String, after: Int)? {
        var p = start; var bind: String? = nil
        for kw in ["const", "let", "var"] where jsWord(c, p, kw) {
            p += kw.count; jsSkipWs(c, &p)
            var name = ""
            while p < c.count, jsIsWord(c[p]) { name.append(c[p]); p += 1 }
            jsSkipWs(c, &p)
            guard p < c.count, c[p] == "=" else { return nil }
            p += 1; jsSkipWs(c, &p); bind = name; break
        }
        guard jsWord(c, p, "await") else { return nil }
        p += 5; jsSkipWs(c, &p)
        let marker = Array("dsx.module.")
        guard p + marker.count < c.count, Array(c[p..<p + marker.count]) == marker else { return nil }
        p += marker.count
        var callee = ""
        while p < c.count, jsIsWord(c[p]) || c[p] == "." { callee.append(c[p]); p += 1 }
        jsSkipWs(c, &p)
        guard !callee.isEmpty, p < c.count, c[p] == "(" else { return nil }
        let args = jsParens(c, &p)
        var q = p; jsSkipWs(c, &q); if q < c.count, c[q] == ";" { q += 1 }
        return (bind, callee, args, q)
    }

    /// Run `await dsx.module.scheme.method({ … })`: dispatch with an onTerminal so the package's
    /// resolve/error suspends the body and lands in `bind` with the uniform contract
    /// `{ ok, data | error }`, then `rest` runs as the continuation (event callbacks preserved,
    /// like `await fetch`). `self` resolves to the owning package; an unregistered scheme
    /// continues immediately with `{ ok: false, error: "unavailable" }`.
    private func runAwaitPackage(bind: String?, callee rawCallee: String, argStr: String,
                                 locals: [String: Any], args: [String: Any], rest: String) {
        let handlers = store.actionEvents
        packageOp(rawCallee, argStr, locals: locals) { result in
            self.store.actionEvents = handlers
            self.continueAwaitPackage(bind: bind, result: (result as? [String: Any]) ?? [:],
                                      locals: locals, args: args, rest: rest)
        }
    }
    /// ONE awaitable package call as a completion-style op (completion on main; `self.` resolves
    /// to the owning scheme) — shared by `await dsx.module.…` and the Promise combinators.
    private func packageOp(_ rawCallee: String, _ argStr: String, locals: [String: Any], completion: @escaping (Any) -> Void) {
        var callee = rawCallee
        if callee == "self" || callee.hasPrefix("self.") {
            guard let me = scope, !me.isEmpty else {
                completion(["ok": false, "error": "unavailable", "call": rawCallee]); return
            }
            callee = me + String(callee.dropFirst(4))
        }
        var payload = (JSE.eval(argStr.isEmpty ? "{}" : argStr, store: store, item: locals) as? [String: Any]) ?? [:]
        if let fid = store.frameId { payload["__frame"] = fid }   // frame identity framing key — see StackStore.frameId
        let traceStart = Date()
        let tracedCallee = callee
        let done: (Any) -> Void = { result in
            if JSETrace.shared.enabled {
                let ms = Int(Date().timeIntervalSince(traceStart) * 1000)
                let ok = ((result as? [String: Any])?["ok"] as? Bool) == true
                JSETrace.shared.log("package", "dsx.module.\(tracedCallee) → \(ok ? "ok" : JSE.string((result as? [String: Any])?["error"] ?? "error")) (\(ms)ms)")
            }
            completion(result)
        }
        var finished = false
        let params = Bridge.Params(dict: payload, onTerminal: { outcome in
            DispatchQueue.main.async {
                guard !finished else { return }
                finished = true
                var result: [String: Any]
                switch outcome {
                case .resolve(let v):
                    result = ["ok": true]
                    result["data"] = v ?? NSNull()
                case .error(let code, let data, _, _):
                    // the markup envelope stays code+data (message/recoverable are the
                    // funnel's fidelity — error-system.md §3.3a; widening is §6/D6, P2)
                    result = ["ok": false, "error": code]
                    if let data { result["data"] = data }
                }
                done(result)
            }
        })
        let dispatched = Self.dispatchCarrier(Self.normalizeCall(callee), params: params)
        if !dispatched.handled {
            finished = true
            // Unhandled: a catalog scheme with NO implementation on this OS settles the awaited
            // form with the STRUCTURED error — { ok:false, error:"unsupported_platform",
            // data:{scheme, platform, supportedPlatforms} } — instead of the generic
            // `unavailable` (OpenSource/Skills/android/api-mapping.md "Unsupported platform").
            // Excluded-by-this-app / unknown schemes keep today's `unavailable`, and the whole
            // branch is inert while ModuleRegistry.platformSupport is empty (the bare kernel).
            if let scheme = dispatched.scheme,
               let supported = ModuleRegistry.shared.unsupportedPlatforms(scheme) {
                done(["ok": false, "error": "unsupported_platform",
                      "data": ModuleRegistry.shared.unsupportedPlatformData(scheme, supported)])
            } else {
                done(["ok": false, "error": "unavailable", "call": callee])
            }
        }
    }
    private func continueAwaitPackage(bind: String?, result: [String: Any],
                                      locals: [String: Any], args: [String: Any], rest: String) {
        var scope = locals
        if let bind { scope[bind] = result }
        runActionBody(rest, item: scope, args: args)
    }

    /// Match `[const|let|var NAME =] await dsx.action.name( … )` — the RETURNING action
    /// call — and its bare-assignment form `path = await dsx.action.name( … )` (no decl
    /// keyword; that bind writes the STORE, the pinned `x = e` rule). Sibling of
    /// matchAwaitPackage; the "dsx.action." marker keeps `dsx.module.…` on its own path.
    private func matchAwaitAction(_ c: [Character], _ start: Int) -> (bind: String?, decl: Bool, name: String, args: String, after: Int)? {
        var p = start; var bind: String? = nil; var decl = false
        for kw in ["const", "let", "var"] where jsWord(c, p, kw) {
            p += kw.count; jsSkipWs(c, &p)
            var name = ""
            while p < c.count, jsIsWord(c[p]) { name.append(c[p]); p += 1 }
            jsSkipWs(c, &p)
            guard p < c.count, c[p] == "=" else { return nil }
            p += 1; jsSkipWs(c, &p); bind = name; decl = true; break
        }
        if bind == nil {
            // bare-assignment form: `path = await …` (never `==`); claimed only when
            // `await dsx.action.` follows — anything else keeps its ordinary path.
            var q = start
            var name = ""
            while q < c.count, jsIsWord(c[q]) || c[q] == "." { name.append(c[q]); q += 1 }
            jsSkipWs(c, &q)
            if !name.isEmpty, q < c.count, c[q] == "=", q + 1 >= c.count || c[q + 1] != "=" {
                q += 1; jsSkipWs(c, &q)
                if jsWord(c, q, "await") { bind = name; decl = false; p = q }
            }
        }
        guard jsWord(c, p, "await") else { return nil }
        p += 5; jsSkipWs(c, &p)
        let marker = Array("dsx.action.")
        guard p + marker.count < c.count, Array(c[p..<p + marker.count]) == marker else { return nil }
        p += marker.count
        var name = ""
        while p < c.count, jsIsWord(c[p]) { name.append(c[p]); p += 1 }
        jsSkipWs(c, &p)
        guard !name.isEmpty, p < c.count, c[p] == "(" else { return nil }
        let args = jsParens(c, &p)
        var q = p; jsSkipWs(c, &q); if q < c.count, c[q] == ";" { q += 1 }
        return (bind, decl, name, args, q)
    }

    /// Run `await dsx.action.<name>(argsObj)` SYNCHRONOUSLY (actions never suspend their
    /// caller here — their own awaits re-enter continuations) via the EXISTING dispatch
    /// (runJSStatement's action branch: declared inputs, args-object merge, event
    /// callbacks, the 32 depth cap, flow isolation), then produce the envelope
    /// `{ ok: true, data: <the action's `return <expr>` value, NSNull when it never
    /// returned> }` from the returnValue ledger the branch scoped to THIS callee. A
    /// `throw` that unwinds the callee yields NO envelope (flowSignal stays "throw") —
    /// the caller's try/catch sees the real exception; never enveloped.
    private func callActionForValue(name: String, argStr: String, locals: [String: Any], args: [String: Any]) -> [String: Any]? {
        runJSStatement("dsx.action.\(name)(\(argStr))", item: locals, args: args)
        if store.flowSignal == "throw" { return nil }
        let v = store.returnValue
        store.returnValue = nil
        return ["ok": true, "data": v ?? NSNull()]
    }

    /// Send a `dsx.event` UP to the consumer's `on:<name>` (else a native `ui.on` host), then to
    /// native packages — the shared dispatch for a bare `dsx.event(…)` statement AND the
    /// `await dsx.event(…)` request form. Both handler branches re-enter the statement runner, so
    /// they draw on the SAME bounded ledger as named actions (`store.actionDepth`, cap 32). The
    /// declaring-env dispatch makes a relay cycle structurally impossible; the budget is
    /// defense-in-depth for the paths an author can still knot (a callback that re-raises its own
    /// event). Past the cap the hop logs and DROPS — bounded JSE never crashes the app.
    private func emitEventUp(_ name: String, _ pay: [String: Any], item: [String: Any]?) {
        if let cb = store.actionEvents[name] {                         // an action callback (passed at the call); dsx.this = payload
            if store.actionDepth < 32 {
                store.actionDepth += 1
                runActionBody(cb, item: pay, args: pay)
                store.actionDepth -= 1
            } else { kernelLog("[Stack] dsx.event('\(name)') dropped — handler depth budget (32) exceeded: callback cycle?") }
        } else if let e = onHandlers[name], e.accepts(pay) {           // else a consumer's on:<name> — run it in the env that DECLARED it (bubbles up; can never re-enter its own entry), honoring its from:<event> source filter
            if store.actionDepth < 32 {
                store.actionDepth += 1
                // payload rides `dsx.this` here too — same contract as the same-env branch above
                // (item: pay) and the native-component path in StackComponentContext.event
                e.env.run(e.action, item: (item ?? [:]).merging(pay) { _, new in new }, args: pay)
                store.actionDepth -= 1
            } else { kernelLog("[Stack] dsx.event('\(name)') dropped — handler depth budget (32) exceeded: relay cycle?") }
        } else if onHandlers[name] == nil {
            store.handlers[name]?(pay)                                 // else a native ui.on host — so dsx.event reaches native too (no dsx.send needed). (A from:-filtered MISS stays consumed, not re-routed to native.)
        }
        JSERunner.publishNative(name, pay)                              // → native packages (dsx.events)
    }

    /// The `await dsx.event` correlation token in scope, if this `resolve:`/`error:` is running
    /// inside an `on:<event>` handler servicing an awaited request. Handler bodies run with the payload as
    /// `args` (so `__reply` rides there); an action callback gets it as `item` too. Preserved
    /// across the handler's own `await` continuations (an inline confirm sheet still routes back).
    private func replyToken(_ item: [String: Any]?, _ args: [String: Any]) -> Int? {
        (args["__reply"] as? Int) ?? (item?["__reply"] as? Int)
    }

    /// Match `[const|let|var NAME =] await dsx.event( … )` at `start` → the bind name (if any), the
    /// args (`'name'[, payload]`), and the index past the statement (incl. a trailing `;`). The
    /// marker is `dsx.event` then `(` — so `dsx.events.on(…)` (the bus) can't mis-match (the `s`).
    private func matchAwaitEvent(_ c: [Character], _ start: Int) -> (bind: String?, args: String, after: Int)? {
        var p = start; var bind: String? = nil
        for kw in ["const", "let", "var"] where jsWord(c, p, kw) {
            p += kw.count; jsSkipWs(c, &p)
            var name = ""
            while p < c.count, jsIsWord(c[p]) { name.append(c[p]); p += 1 }
            jsSkipWs(c, &p)
            guard p < c.count, c[p] == "=" else { return nil }
            p += 1; jsSkipWs(c, &p); bind = name; break
        }
        guard jsWord(c, p, "await") else { return nil }
        p += 5; jsSkipWs(c, &p)
        let marker = Array("dsx.event")
        guard p + marker.count < c.count, Array(c[p..<p + marker.count]) == marker else { return nil }
        p += marker.count; jsSkipWs(c, &p)
        guard p < c.count, c[p] == "(" else { return nil }              // the call form — not `dsx.events.on(…)`
        let args = jsParens(c, &p)
        var q = p; jsSkipWs(c, &q); if q < c.count, c[q] == ";" { q += 1 }
        return (bind, args, q)
    }

    /// Run `await dsx.event(name, payload)` (request/response): mint a correlation token, register
    /// the suspended caller's continuation under it, stamp the token onto the emitted payload, then
    /// send the event UP (the SAME dispatch as a bare `dsx.event`). A consumer's `on:<event>` handling it
    /// `resolve:`s (→ the awaiter resumes with that value) or `error:`s (→ resumes falsy); routing
    /// is by token, so N in-flight requests stay distinct (see runVerb's resolve:/error: →
    /// resumeAwaitEvent). If nothing ever replies the caller stays suspended — like an unresolved
    /// JS promise; bounded (the registry lives on the surface-scoped store).
    private func runAwaitEvent(bind: String?, argStr: String, locals: [String: Any], args: [String: Any], rest: String) {
        store.nextEventReply += 1
        let token = store.nextEventReply
        store.eventReplies[token] = StackStore.PendingEventReply(
            bind: bind, rest: rest, locals: locals, args: args, handlers: store.actionEvents)
        let parts = JSERunner.splitArgs(argStr)
        let name = JSE.string(JSE.eval(parts.first ?? "", store: store, item: locals))
        var pay = (parts.count > 1 ? JSE.eval(parts[1], store: store, item: locals) : nil) as? [String: Any] ?? [:]
        pay = JSERunner.stampFrom(pay, type: "action", name: store.actionNameStack.last)
        pay["__reply"] = token
        emitEventUp(name, pay, item: locals)
        store.anyHandlers.forEach { $0(name, pay) }
    }

    /// Replay a suspended `await dsx.event` caller's continuation with `value` (the handler's
    /// `resolve:` value, NSNull for `error:`), its action callbacks restored across the suspension.
    /// Runs on whichever runner handled the reply — same surface, same store.
    private func resumeAwaitEvent(_ pend: StackStore.PendingEventReply, value: Any?) {
        let saved = store.actionEvents
        store.actionEvents = pend.handlers
        var scope = pend.locals
        if let bind = pend.bind { scope[bind] = value ?? NSNull() }
        runActionBody(pend.rest, item: scope, args: pend.args)
        store.actionEvents = saved
    }

    private func runActionIf(_ c: [Character], _ i: inout Int, _ locals: inout [String: Any], _ args: [String: Any], execute: Bool) {
        i += 2; jsSkipWs(c, &i)                                    // 'if'
        let condStr = jsParens(c, &i)
        let cond = execute && JSE.truthy(JSE.eval(condStr, store: store, item: locals))
        runActionBranch(c, &i, &locals, args, execute: execute && cond)
        jsSkipWs(c, &i)
        if jsWord(c, i, "else") {
            i += 4; jsSkipWs(c, &i)                                // 'else'
            if jsWord(c, i, "if") { runActionIf(c, &i, &locals, args, execute: execute && !cond) }
            else { runActionBranch(c, &i, &locals, args, execute: execute && !cond) }
        }
    }
    private func runActionBranch(_ c: [Character], _ i: inout Int, _ locals: inout [String: Any], _ args: [String: Any], execute: Bool) {
        jsSkipWs(c, &i)
        if i < c.count, c[i] == "{" {
            i += 1
            runActionBlock(c, &i, &locals, args, execute: execute)
            jsSkipWs(c, &i); if i < c.count, c[i] == "}" { i += 1 }
        } else if jsWord(c, i, "if") {
            runActionIf(c, &i, &locals, args, execute: execute)
        } else if jsWord(c, i, "while") {
            runActionWhile(c, &i, &locals, args, execute: execute)
        } else if jsWord(c, i, "for") {
            runActionFor(c, &i, &locals, args, execute: execute)
        } else if jsWord(c, i, "switch") {
            runActionSwitch(c, &i, &locals, args, execute: execute)
        } else if jsWord(c, i, "try") {
            runActionTry(c, &i, &locals, args, execute: execute)
        } else if jsWord(c, i, "const") || jsWord(c, i, "let") || jsWord(c, i, "var") {
            runActionDecl(c, &i, &locals, execute: execute)
        } else {
            let stmt = jsLeaf(c, &i).trimmingCharacters(in: .whitespaces)
            if execute, !stmt.isEmpty, !flowLeaf(stmt, locals: locals) { runVerb(stmt, item: locals, args: args) }
        }
    }
    private func runActionDecl(_ c: [Character], _ i: inout Int, _ locals: inout [String: Any], execute: Bool) {
        while i < c.count, jsIsWord(c[i]) { i += 1 }               // skip const/let/var
        jsSkipWs(c, &i)
        let declText = jsLeaf(c, &i)                               // "a = 1, b = 2" · "{x, y: r} = o" · "[p, q] = arr"
        guard execute else { return }
        // multi-declarators split on top-level commas (patterns' inner commas are depth-protected)
        for part in splitTopLevel(Array(declText), on: ",") {
            let p = part.trimmingCharacters(in: .whitespaces)
            if p.isEmpty { continue }
            let eq = Self.topLevelAssignIndex(p)
            let patternText = (eq >= 0 ? String(p.prefix(eq)) : p).trimmingCharacters(in: .whitespaces)
            let exprText = (eq >= 0 ? String(p.dropFirst(eq + 1)) : "").trimmingCharacters(in: .whitespaces)
            let v = exprText.isEmpty ? nil : JSE.eval(exprText, store: store, item: locals)
            bindDestructure(patternText, v, locals) { n, value in locals[n] = value ?? NSNull() }
        }
    }

    /// The `=` that splits pattern from initializer (never `==`/`<=`/`>=`/`!=`, depth-0 only).
    static func topLevelAssignIndex(_ s: String) -> Int {
        let chars = Array(s); var depth = 0; var q: Character? = nil; var k = 0
        while k < chars.count {
            let ch = chars[k]
            if let qq = q {
                if ch == "\\", k + 1 < chars.count { k += 2; continue }
                if ch == qq { q = nil }
                k += 1; continue
            }
            switch ch {
            case "'", "\"", "`": q = ch
            case "(", "[", "{": depth += 1
            case ")", "]", "}": depth -= 1
            case "=":
                let prev = k > 0 ? chars[k - 1] : " "
                let next = k + 1 < chars.count ? chars[k + 1] : " "
                if depth == 0, next != "=", prev != "=", prev != "!", prev != "<", prev != ">" { return k }
            default: break
            }
            k += 1
        }
        return -1
    }

    /// Bind a declaration/loop pattern from its SOURCE text — DELEGATING to the one
    /// token-level machinery (JSE.destructureBind). This used to be a second, text-level
    /// binder, and it stayed FLAT when patterns learned nesting, defaults and rest
    /// (syntax-004): `const { a: { b } } = row` bound nothing in an ACTION while binding
    /// fine in an expression block. A second binder is a place to fall behind; now there
    /// is one parser and one binder, and the runner cannot drift from the evaluator.
    private func bindDestructure(_ patternText: String, _ value: Any?, _ locals: [String: Any], _ bind: (String, Any?) -> Void) {
        JSE.destructureBind(patternText, value, store: store, locals: locals, bind)
    }

    // ── Bounded statements: while / for / for…of / switch / try-catch / break / continue ──
    //
    // JSE stays TOTAL: every loop iteration anywhere in an action draws on one shared budget
    // (`store.loopWork`, reset per entry event, cap `loopCap`) — past the cap the loop aborts
    // with a log instead of hanging the main thread. Remote DSX can never freeze the app.
    // Classes and imports stay out BY DESIGN: state is plain data in the store, and packages /
    // <action> / <formula> are the module + function system (see jse.md).

    /// Total loop-iteration budget per entry event, shared by every loop in the action.
    static let loopCap = 100_000
    private func loopStep() -> Bool {
        store.loopWork += 1
        if store.loopWork == Self.loopCap + 1 {
            kernelLog("[Stack] loop budget exhausted (\(Self.loopCap) iterations in one action) — aborting. JSE is bounded; restructure with map/filter/reduce or move the work to a package.")
        }
        return store.loopWork <= Self.loopCap
    }
    /// After a loop-body run: `continue` is consumed (next iteration), `break` is consumed
    /// (stop), `return`/`throw` stay in flight (unwind through the enclosing blocks).
    private func loopContinues() -> Bool {
        switch store.flowSignal {
        case "continue": store.flowSignal = nil; return true
        case "break":    store.flowSignal = nil; return false
        case nil:        return true
        default:         return false
        }
    }
    /// `break` / `continue` / `return [e]` / `throw e` as a leaf statement → raise the signal.
    /// RETURNING ACTIONS: `return <expr>` also records its value in the returnValue ledger —
    /// an AWAITING `dsx.action` caller binds `{ ok:true, data: <it> }`; a bare `return`
    /// clears it (its value IS null, and a nested call's leftover must not leak through).
    /// `resolve:` remains how an action answers a bus CALL — unchanged.
    private func flowLeaf(_ stmt: String, locals: [String: Any]) -> Bool {
        if stmt == "break" || stmt == "continue" { store.flowSignal = stmt; return true }
        if stmt == "return" { store.returnValue = nil; store.flowSignal = "return"; return true }
        if stmt.hasPrefix("return ") {
            store.returnValue = JSE.eval(String(stmt.dropFirst(7)), store: store, item: locals)   // evaluated (JS order); the value an AWAITING dsx.action caller binds
            store.flowSignal = "return"; return true
        }
        if stmt.hasPrefix("throw ") {
            store.thrownValue = JSE.eval(String(stmt.dropFirst(6)), store: store, item: locals) ?? NSNull()
            store.flowSignal = "throw"; return true
        }
        return false
    }
    /// Capture a construct's BODY as its own character slice — a `{ … }` block's inner text
    /// (quote-aware, to the matching brace) or a single statement — consuming it from the walk,
    /// so loops re-run the body without re-scanning. (Brace multi-clause bodies: `while (x) { … }`.)
    private func jsCaptureBranch(_ c: [Character], _ i: inout Int) -> [Character] {
        jsSkipWs(c, &i)
        guard i < c.count else { return [] }
        guard c[i] == "{" else { return Array(jsLeaf(c, &i)) }
        i += 1; var depth = 1; var out: [Character] = []; var q: Character? = nil
        while i < c.count {
            let ch = c[i]
            if let qq = q { out.append(ch); i += 1; if ch == qq { q = nil }; continue }
            if ch == "'" || ch == "\"" { q = ch; out.append(ch); i += 1; continue }
            if ch == "{" { depth += 1 }
            else if ch == "}" { depth -= 1; if depth == 0 { i += 1; break } }
            out.append(ch); i += 1
        }
        return out
    }
    /// Split on a separator at depth 0 (quote- and bracket-aware) — `for (init; cond; step)`.
    /// Backtick templates stay opaque too (escape pairs honored, like splitStatements).
    private func splitTopLevel(_ h: [Character], on sep: Character) -> [String] {
        var parts: [String] = []; var cur = ""; var depth = 0; var q: Character? = nil; var esc = false
        for ch in h {
            if let qq = q {
                cur.append(ch)
                if esc { esc = false } else if ch == "\\" { esc = true } else if ch == qq { q = nil }
                continue
            }
            if ch == "'" || ch == "\"" || ch == "`" { q = ch; cur.append(ch); continue }
            if ch == "(" || ch == "[" || ch == "{" { depth += 1 }
            if ch == ")" || ch == "]" || ch == "}" { depth -= 1 }
            if depth == 0, ch == sep { parts.append(cur); cur = ""; continue }
            cur.append(ch)
        }
        parts.append(cur)
        return parts
    }
    /// Run a captured body (one loop iteration / case segment / try clause) against the live locals.
    private func runCaptured(_ body: [Character], _ locals: inout [String: Any], _ args: [String: Any]) {
        var j = 0
        runActionBlock(body, &j, &locals, args, execute: true)
    }

    /// `while (cond) { … }` — budgeted; `break`/`continue` honored.
    private func runActionWhile(_ c: [Character], _ i: inout Int, _ locals: inout [String: Any], _ args: [String: Any], execute: Bool) {
        i += 5; jsSkipWs(c, &i)                                    // 'while'
        let condStr = jsParens(c, &i)
        let body = jsCaptureBranch(c, &i)
        guard execute else { return }
        while JSE.truthy(JSE.eval(condStr, store: store, item: locals)), loopStep() {
            runCaptured(body, &locals, args)
            if !loopContinues() { break }
        }
    }
    /// `do { … } while (cond)` — body-first, budgeted, `break`/`continue` honored.
    private func runActionDoWhile(_ c: [Character], _ i: inout Int, _ locals: inout [String: Any], _ args: [String: Any], execute: Bool) {
        i += 2; jsSkipWs(c, &i)                                    // 'do'
        let body = jsCaptureBranch(c, &i)
        jsSkipWs(c, &i)
        var condStr = ""
        if jsWord(c, i, "while") { i += 5; jsSkipWs(c, &i); condStr = jsParens(c, &i) }
        if i < c.count, c[i] == ";" { i += 1 }
        guard execute else { return }
        repeat {
            guard loopStep() else { break }
            runCaptured(body, &locals, args)
            if !loopContinues() { break }
        } while JSE.truthy(JSE.eval(condStr, store: store, item: locals))
    }

    /// `for (const x of arr) { … }` and classic `for (init; cond; step) { … }` — budgeted.
    private func runActionFor(_ c: [Character], _ i: inout Int, _ locals: inout [String: Any], _ args: [String: Any], execute: Bool) {
        i += 3; jsSkipWs(c, &i)                                    // 'for'
        let head = Array(jsParens(c, &i))
        let body = jsCaptureBranch(c, &i)
        guard execute else { return }
        // for…of — `[const|let|var] pattern of expr` (arrays / strings / Set / Map; the loop
        // var is an ident or a flat `[a, b]` / `{a, b}` pattern)
        if let fo = matchForOf(head) {
            for el in JSE.spreadValues(JSE.eval(fo.expr, store: store, item: locals)) {
                guard loopStep() else { break }
                bindDestructure(fo.name, el, locals) { n, value in locals[n] = value ?? NSNull() }
                runCaptured(body, &locals, args)
                if !loopContinues() { break }
            }
            return
        }
        // for…in — dict OWN keys ("__"-internal skipped) / array indices 0..n-1; gated on a
        // header with NO top-level `;`, because a classic for's condition may contain the
        // `in` OPERATOR (`for (i = 0; 'a' in d; ++i)`).
        let parts = splitTopLevel(head, on: ";")
        if parts.count == 1, let fi = matchForIn(head) {
            for el in JSE.forInKeys(JSE.eval(fi.expr, store: store, item: locals)) {
                guard loopStep() else { break }
                Self.bindDestructure(fi.name, el) { n, value in locals[n] = value ?? NSNull() }
                runCaptured(body, &locals, args)
                if !loopContinues() { break }
            }
            return
        }
        // classic — init; cond; step (an empty cond loops until break / the budget)
        guard parts.count == 3 else { return }
        var locals2 = locals
        runCaptured(Array(parts[0]), &locals2, args)               // init (a decl or statement)
        let cond = parts[1].trimmingCharacters(in: .whitespaces)
        while (cond.isEmpty || JSE.truthy(JSE.eval(cond, store: store, item: locals2))), loopStep() {
            runCaptured(body, &locals2, args)
            if !loopContinues() { break }
            runCaptured(Array(parts[2]), &locals2, args)           // step (`i++` / `i += 1` sugar)
        }
        locals = locals2
    }
    private func matchForOf(_ h: [Character]) -> (name: String, expr: String)? {
        var p = 0; jsSkipWs(h, &p)
        for kw in ["const", "let", "var"] where jsWord(h, p, kw) { p += kw.count; jsSkipWs(h, &p); break }
        var name = ""
        if p < h.count, h[p] == "[" || h[p] == "{" {               // a flat destructuring pattern
            let close: Character = h[p] == "[" ? "]" : "}"
            var depth = 0
            while p < h.count {
                let ch = h[p]
                if ch == "[" || ch == "{" { depth += 1 }
                if ch == "]" || ch == "}" { depth -= 1 }
                name.append(ch); p += 1
                if depth == 0, ch == close { break }
            }
        } else {
            while p < h.count, jsIsWord(h[p]) { name.append(h[p]); p += 1 }
        }
        jsSkipWs(h, &p)
        guard !name.isEmpty, jsWord(h, p, "of") else { return nil }
        p += 2; jsSkipWs(h, &p)
        let expr = String(h[p...]).trimmingCharacters(in: .whitespaces)
        return expr.isEmpty ? nil : (name, expr)
    }
    /// `[const|let|var] name in expr` — the for…in header (the loop var is an ident; the
    /// keys a dict yields are strings, so patterns stay out).
    private func matchForIn(_ h: [Character]) -> (name: String, expr: String)? {
        var p = 0; jsSkipWs(h, &p)
        for kw in ["const", "let", "var"] where jsWord(h, p, kw) { p += kw.count; jsSkipWs(h, &p); break }
        var name = ""
        while p < h.count, jsIsWord(h[p]) { name.append(h[p]); p += 1 }
        jsSkipWs(h, &p)
        guard !name.isEmpty, jsWord(h, p, "in") else { return nil }
        p += 2; jsSkipWs(h, &p)
        let expr = String(h[p...]).trimmingCharacters(in: .whitespaces)
        return expr.isEmpty ? nil : (name, expr)
    }
    /// `switch (subj) { case a: … case b: … default: … }` — JS semantics: first deep-equal case
    /// (else `default`) starts execution, fallthrough until `break` (consumed) / the end;
    /// `return`/`throw`/`continue` unwind to the enclosing construct.
    private func runActionSwitch(_ c: [Character], _ i: inout Int, _ locals: inout [String: Any], _ args: [String: Any], execute: Bool) {
        i += 6; jsSkipWs(c, &i)                                    // 'switch'
        let subjStr = jsParens(c, &i)
        jsSkipWs(c, &i)
        guard i < c.count, c[i] == "{" else { return }
        let body = jsCaptureBranch(c, &i)
        guard execute else { return }
        // Segment the body on `case <expr>:` / `default:` labels (depth-0, quote- and ternary-aware).
        var segments: [(label: String?, body: [Character])] = []
        var cur: [Character] = []; var curLabel: String? = nil; var inSegment = false
        func flush() { if inSegment { segments.append((curLabel, cur)) }; cur = [] }
        var k = 0; var q: Character? = nil; var depth = 0
        while k < body.count {
            let ch = body[k]
            if let qq = q { cur.append(ch); k += 1; if ch == qq { q = nil }; continue }
            if ch == "'" || ch == "\"" { q = ch; cur.append(ch); k += 1; continue }
            if ch == "(" || ch == "[" || ch == "{" { depth += 1; cur.append(ch); k += 1; continue }
            if ch == ")" || ch == "]" || ch == "}" { depth -= 1; cur.append(ch); k += 1; continue }
            if depth == 0, jsWord(body, k, "case") {
                flush(); inSegment = true
                k += 4; jsSkipWs(body, &k)
                var label: [Character] = []; var tern = 0; var lq: Character? = nil; var ld = 0
                while k < body.count {
                    let lc = body[k]
                    if let qq = lq { label.append(lc); k += 1; if lc == qq { lq = nil }; continue }
                    if lc == "'" || lc == "\"" { lq = lc; label.append(lc); k += 1; continue }
                    if lc == "(" || lc == "[" || lc == "{" { ld += 1 }
                    if lc == ")" || lc == "]" || lc == "}" { ld -= 1 }
                    if ld == 0, lc == "?" { tern += 1 }
                    if ld == 0, lc == ":" { if tern > 0 { tern -= 1 } else { k += 1; break } }
                    label.append(lc); k += 1
                }
                curLabel = String(label).trimmingCharacters(in: .whitespaces)
                continue
            }
            if depth == 0, jsWord(body, k, "default") {
                flush(); inSegment = true
                k += 7; jsSkipWs(body, &k); if k < body.count, body[k] == ":" { k += 1 }
                curLabel = nil
                continue
            }
            cur.append(ch); k += 1
        }
        flush()
        let subjKey = JSE.watchKey(JSE.eval(subjStr, store: store, item: locals))
        var start = segments.firstIndex { seg in
            guard let l = seg.label else { return false }
            return JSE.watchKey(JSE.eval(l, store: store, item: locals)) == subjKey
        }
        if start == nil { start = segments.firstIndex { $0.label == nil } }
        guard let s0 = start else { return }
        for seg in segments[s0...] {
            runCaptured(seg.body, &locals, args)
            if store.flowSignal == "break" { store.flowSignal = nil; return }
            if store.flowSignal != nil { return }
        }
    }
    /// `try { … } catch (e) { … } finally { … }` — catches an in-flight `throw` (the thrown value
    /// binds to the catch parameter); `finally` always runs, then any pending signal resumes
    /// (a signal raised IN finally wins, like JS).
    private func runActionTry(_ c: [Character], _ i: inout Int, _ locals: inout [String: Any], _ args: [String: Any], execute: Bool) {
        i += 3                                                     // 'try'
        let tryBody = jsCaptureBranch(c, &i)
        var catchParam = ""; var catchBody: [Character] = []; var hasCatch = false
        var finallyBody: [Character] = []; var hasFinally = false
        jsSkipWs(c, &i)
        if jsWord(c, i, "catch") {
            hasCatch = true; i += 5; jsSkipWs(c, &i)
            if i < c.count, c[i] == "(" { catchParam = jsParens(c, &i).trimmingCharacters(in: .whitespaces) }
            catchBody = jsCaptureBranch(c, &i)
            jsSkipWs(c, &i)
        }
        if jsWord(c, i, "finally") {
            hasFinally = true; i += 7
            finallyBody = jsCaptureBranch(c, &i)
        }
        guard execute else { return }
        store.tryDepth += 1                                        // inside try → a call to an unavailable package / undefined action throws (feature-detection); restored after the body
        runCaptured(tryBody, &locals, args)
        store.tryDepth -= 1
        if store.flowSignal == "throw", hasCatch {
            store.flowSignal = nil
            if !catchParam.isEmpty { locals[catchParam] = store.thrownValue ?? NSNull() }
            store.thrownValue = nil
            runCaptured(catchBody, &locals, args)
        }
        if hasFinally {
            let pending = store.flowSignal; store.flowSignal = nil
            runCaptured(finallyBody, &locals, args)
            if store.flowSignal == nil { store.flowSignal = pending }
        }
    }

    private func jsIsWord(_ ch: Character) -> Bool { ch.isLetter || ch.isNumber || ch == "_" }
    private func jsSkipWs(_ c: [Character], _ i: inout Int) {
        while i < c.count, c[i] == " " || c[i] == "\t" || c[i] == "\n" || c[i] == "\r" { i += 1 }
    }
    private func jsWord(_ c: [Character], _ i: Int, _ w: String) -> Bool {
        let wc = Array(w)
        guard i + wc.count <= c.count else { return false }
        for k in 0..<wc.count where c[i + k] != wc[k] { return false }
        let before = i > 0 ? c[i - 1] : " "
        let after = i + wc.count < c.count ? c[i + wc.count] : " "
        return !jsIsWord(before) && !jsIsWord(after)
    }
    /// Read a `( … )` group's inner text (consumes both parens), quote- and depth-aware.
    private func jsParens(_ c: [Character], _ i: inout Int) -> String {
        guard i < c.count, c[i] == "(" else { return "" }
        i += 1; var depth = 1; var out = ""; var q: Character? = nil
        while i < c.count {
            let ch = c[i]
            if let qq = q { out.append(ch); i += 1; if ch == qq { q = nil }; continue }
            if ch == "'" || ch == "\"" { q = ch; out.append(ch); i += 1; continue }
            if ch == "(" { depth += 1 }
            else if ch == ")" { depth -= 1; if depth == 0 { i += 1; break } }
            out.append(ch); i += 1
        }
        return out
    }
    /// Read one leaf statement up to a top-level `;` / newline / `}` (quote- and bracket-aware).
    /// Consumes a terminating `;`/newline, but NOT a `}` (that ends the enclosing block).
    private func jsLeaf(_ c: [Character], _ i: inout Int) -> String {
        var out = ""; var depth = 0; var q: Character? = nil
        while i < c.count {
            let ch = c[i]
            if let qq = q {
                // backslash pairs stay opaque inside a quoted span (`'it\'s'`, `` `a\`b` ``)
                if ch == "\\", i + 1 < c.count { out.append(ch); out.append(c[i + 1]); i += 2; continue }
                out.append(ch); i += 1; if ch == qq { q = nil }; continue
            }
            if ch == "'" || ch == "\"" || ch == "`" { q = ch; out.append(ch); i += 1; continue }
            if ch == "(" || ch == "[" || ch == "{" { depth += 1; out.append(ch); i += 1; continue }
            if ch == ")" || ch == "]" || ch == "}" { if depth == 0 { break }; depth -= 1; out.append(ch); i += 1; continue }
            if depth == 0, ch == ";" { i += 1; break }
            if depth == 0, ch == "\n" {
                // Multiline statements (ASI): a newline ends the statement UNLESS the line is
                // clearly unfinished or the next line can only be a continuation — so chains,
                // wrapped expressions, and formatted ternaries read exactly like handwritten JS.
                if jsLineContinues(out: out, c: c, after: i) { out.append(" "); i += 1; continue }
                i += 1; break
            }
            out.append(ch); i += 1
        }
        return out
    }
    /// Continuation test for a depth-0 newline inside a statement:
    ///  • look-BEHIND — the line ends in a binary operator / dot / comma (`x = a +` · `cond &&`
    ///    · `obj.`), but NOT `i++` / `i--` (those are complete);
    ///  • look-AHEAD — the next line starts with a token that cannot begin a statement:
    ///    a `.method()` chain, a formatted ternary's `?` / `:`, or `&&` / `||`.
    private func jsLineContinues(out: String, c: [Character], after i: Int) -> Bool {
        let tail = out.reversed().drop(while: { $0 == " " || $0 == "\t" || $0 == "\r" })
        if let last = tail.first {
            let isIncDec = (last == "+" || last == "-") && tail.dropFirst().first == last
            if !isIncDec, "+-*/%&|<>=!?:,.".contains(last) { return true }
        }
        var j = i + 1
        while j < c.count, c[j] == " " || c[j] == "\t" || c[j] == "\n" || c[j] == "\r" { j += 1 }
        guard j < c.count else { return false }
        let ch = c[j]
        if ch == "." || ch == "?" || ch == ":" { return true }
        if (ch == "&" || ch == "|"), j + 1 < c.count, c[j + 1] == ch { return true }
        return false
    }

    /// `key = expr` → evaluate the expression against the store and write it back.
    private func assign(_ s: String, item: [String: Any]?) {
        guard let (key, expr) = JSERunner.splitOnAssign(s), !key.isEmpty else { return }
        write(key, JSE.eval(expr, store: store, item: item) ?? "")
    }

    /// Indexed assignment `name[expr] = rhs` (one index level; quote-aware bracket scan) —
    /// the index evaluates, an integral routes as the array segment (`arr.0`), anything
    /// else as the dict key (`o.key`). Returns false when the statement isn't this shape.
    private func runIndexedAssign(_ a: String, item: [String: Any]?) -> Bool {
        let chars = Array(a)
        var i = 0
        while i < chars.count, chars[i].isLetter || chars[i].isNumber || chars[i] == "_" || chars[i] == "." { i += 1 }
        guard i > 0, i < chars.count, chars[i] == "[" else { return false }
        let name = String(chars[0..<i])
        var depth = 0
        var q: Character? = nil
        var j = i
        var close = -1
        while j < chars.count {
            let ch = chars[j]
            if let qq = q { if ch == qq { q = nil } }
            else if ch == "'" || ch == "\"" { q = ch }
            else if ch == "[" { depth += 1 }
            else if ch == "]" { depth -= 1; if depth == 0 { close = j; break } }
            j += 1
        }
        guard close > i + 1 else { return false }
        var k = close + 1
        while k < chars.count, chars[k] == " " || chars[k] == "\t" { k += 1 }
        guard k < chars.count, chars[k] == "=", k + 1 >= chars.count || chars[k + 1] != "=" else { return false }
        let idx = JSE.eval(String(chars[(i + 1)..<close]), store: store, item: item)
        let seg: String
        if let n = JSE.number(idx), n.isFinite, n == n.rounded(.down), abs(n) < 9.0e15 {
            seg = String(Int(n))
        } else {
            seg = JSE.string(idx)
        }
        write("\(name).\(seg)", JSE.eval(String(chars[(k + 1)...]), store: store, item: item) ?? "")
        return true
    }

    /// Strip JS comments from an action body — the shared JSE preprocessor pass
    /// (quote-, template- AND regex-literal-aware, `://` URL guard), so a
    /// `replace(/\//g, '-')` statement is never half-eaten as a comment. One
    /// implementation: JSE.stripComments (syntax wave 1); this forwarder keeps
    /// every existing call site source-compatible.
    static func stripJSComments(_ s: String) -> String { JSE.stripComments(s) }

    /// Statement sugar: `i++` / `i--` / `++i` / `--i` → `i = i ± 1`, and compound assignment
    /// `x += e` (also `-=` `*=` `/=` `%=` `**=`) → `x = x op (e)` — so the single assignment
    /// path handles them. Statement-level only (an `i++` inside an expression is not JSE).
    /// Quote-/bracket-aware (backtick templates and escape pairs stay opaque).
    static func jsSugar(_ s: String) -> String {
        let t = s.trimmingCharacters(in: .whitespaces)
        if t.hasSuffix("++") || t.hasSuffix("--") {
            let name = String(t.dropLast(2)).trimmingCharacters(in: .whitespaces)
            if !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." }) {
                return "\(name) = \(name) \(t.hasSuffix("++") ? "+" : "-") 1"
            }
        }
        // prefix `++i` / `--i` — the same statement rewrite as the postfix form (wave 3)
        if t.hasPrefix("++") || t.hasPrefix("--") {
            let name = String(t.dropFirst(2)).trimmingCharacters(in: .whitespaces)
            if !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." }) {
                return "\(name) = \(name) \(t.hasPrefix("++") ? "+" : "-") 1"
            }
        }
        let chars = Array(t); var i = 0; var q: Character? = nil; var depth = 0
        while i + 1 < chars.count {
            let ch = chars[i]
            if let qq = q {
                if ch == "\\", i + 1 < chars.count { i += 2; continue }   // escape pair stays opaque
                if ch == qq { q = nil }
                i += 1; continue
            }
            if ch == "'" || ch == "\"" || ch == "`" { q = ch; i += 1; continue }
            if ch == "(" || ch == "[" || ch == "{" { depth += 1 }
            if ch == ")" || ch == "]" || ch == "}" { depth -= 1 }
            // logical assigns `x ??= e` / `x &&= e` / `x ||= e` — pair + '='
            if depth == 0, "?&|".contains(ch), i + 2 < chars.count, chars[i + 1] == ch, chars[i + 2] == "=" {
                let key = String(chars[..<i]).trimmingCharacters(in: .whitespaces)
                let expr = String(chars[(i + 3)...]).trimmingCharacters(in: .whitespaces)
                if !key.isEmpty, !expr.isEmpty, !key.contains("("), !key.contains(" ") {
                    return "\(key) = \(key) \(ch)\(ch) (\(expr))"
                }
                return s
            }
            // `x **= e` — the 2-char op form, checked before the 1-char set
            if depth == 0, ch == "*", i + 2 < chars.count, chars[i + 1] == "*", chars[i + 2] == "=" {
                let key = String(chars[..<i]).trimmingCharacters(in: .whitespaces)
                let expr = String(chars[(i + 3)...]).trimmingCharacters(in: .whitespaces)
                if !key.isEmpty, !expr.isEmpty, !key.contains("("), !key.contains(" ") {
                    return "\(key) = \(key) ** (\(expr))"
                }
                return s
            }
            if depth == 0, "+-*/%".contains(ch), chars[i + 1] == "=", (i + 2 >= chars.count || chars[i + 2] != "=") {
                let key = String(chars[..<i]).trimmingCharacters(in: .whitespaces)
                let expr = String(chars[(i + 2)...]).trimmingCharacters(in: .whitespaces)
                if !key.isEmpty, !expr.isEmpty, !key.contains("("), !key.contains(" ") {
                    return "\(key) = \(key) \(ch) (\(expr))"
                }
                return s
            }
            i += 1
        }
        return s
    }

    /// Split `key = expr` on the assignment `=` (not `==`/`!=`/`<=`/`>=`, so RHS comparisons
    /// survive). Shared by `set:` and the array-mutation verbs.
    static func splitOnAssign(_ s: String) -> (key: String, expr: String)? {
        let chars = Array(s); var i = 0
        while i < chars.count {
            if chars[i] == "=" {
                let next = i + 1 < chars.count ? chars[i + 1] : " "
                let prev = i > 0 ? chars[i - 1] : " "
                if next == "=" { i += 2; continue }
                if prev != "!" && prev != "<" && prev != ">" && prev != "=" {
                    return (String(chars[0..<i]).trimmingCharacters(in: .whitespaces),
                            String(chars[(i + 1)...]).trimmingCharacters(in: .whitespaces))
                }
            }
            i += 1
        }
        return nil
    }
    /// Split a trailing numeric index off a path: `todos.2` → ("todos", 2); else (path, 0).
    static func splitTrailingIndex(_ s: String) -> (path: String, index: Int) {
        guard let dot = s.lastIndex(of: "."), let idx = Int(s[s.index(after: dot)...]) else { return (s, 0) }
        return (String(s[..<dot]), idx)
    }

    /// Write a state path to the right store: `global.*` / `route.*` → the app-wide
    /// DSXState; anything else → the surface store. Both are path-aware (nested + array
    /// index), so `set: feed.data.5.name = …` edits an item in place.
    private func write(_ rawKey: String, _ value: Any) {
        let key = JSE.normalizeScope(rawKey)                          // `dsx.variable`/`dsx.global`/`dsx.route`/`dsx.cookie`/… → canonical
        if key.hasPrefix("global.") { DSX.state.setPath(String(key.dropFirst(7)), value) }
        else if key.hasPrefix("route.") { DSX.state.setPath(key, value) }   // route.* ⇄ global.route.*
        else if key.hasPrefix("cookie.") { DSXCookies.shared.set(String(key.dropFirst(7)), JSE.string(value)) }   // `dsx.cookie.name = "…"` → set a cookie (web + native)
        else { store.setPath(key, value) }
    }

    /// Read the array at a state path (`todos`, `global.cart.items`, `feed.data`), apply
    /// `mutate`, write it back — the basis for the array-mutation verbs (push/pop/insert/…).
    /// Stores rows as `[[String:Any]]` (so `<list>`/`store.list` see them); scalar arrays stay `[Any]`.
    private func mutateArray(_ path: String, item: [String: Any]?, _ mutate: (inout [Any]) -> Void) {
        var arr = JSE.asArray(JSE.eval(path, store: store, item: item))
        mutate(&arr)
        if let rows = arr as? [[String: Any]] { write(path, rows) } else { write(path, arr) }
    }
    /// Read-modify-write for a non-array value at `path` (the JS-core object mutations:
    /// URLSearchParams/FormData/Headers set·append·delete, AbortController.abort).
    private func mutateValue(_ path: String, item: [String: Any]?, _ mutate: (inout Any) -> Void) {
        var v: Any = JSE.eval(path, store: store, item: item) ?? NSNull()
        mutate(&v)
        write(path, v)
    }

    /// `remove: arr where <pred>` — drop rows where the per-row predicate is truthy (`{{ }}`
    /// in the predicate resolves against the OUTER scope; bare names are row fields). Or
    /// `remove: arr = <value> [key=<field>]` — drop rows whose `field` equals the value (default `id`).
    private func performRemove(_ spec: String, item: [String: Any]?) {
        let s = spec.trimmingCharacters(in: .whitespaces)
        if let r = s.range(of: " where ") {
            let path = String(s[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
            let pred = JSE.interpolate(String(s[r.upperBound...]), store: store, item: item)
            mutateArray(path, item: item) { arr in
                arr = arr.filter { !JSE.truthy(JSE.eval(pred, store: store, item: $0 as? [String: Any])) }
            }
            return
        }
        guard let (lhs, rhs) = JSERunner.splitOnAssign(s) else { return }
        var field = "id", valueExpr = rhs
        if let kr = rhs.range(of: " key=") {
            field = String(rhs[kr.upperBound...]).trimmingCharacters(in: .whitespaces)
            valueExpr = String(rhs[..<kr.lowerBound])
        }
        let target = JSE.string(JSE.eval(valueExpr, store: store, item: item))
        mutateArray(lhs, item: item) { arr in
            arr = arr.filter { ($0 as? [String: Any]).map { "\($0[field] ?? "")" != target } ?? true }
        }
    }

    /// `splice: arr = <start> <deleteCount>` — remove `deleteCount` items at `start` (JS
    /// `Array.splice` remove-range; add with `insert:` / `push:`).
    /// `splice: arr = start, deleteCount, ...items` — full JS `Array.splice`: remove
    /// `deleteCount` at `start`, then insert the (comma-separated) items there. Items may be
    /// object/array literals (their inner commas are bracket-protected). Drop the items to
    /// just remove; use `deleteCount = 0` to only insert.
    private func performSplice(_ spec: String, item: [String: Any]?) {
        guard let (path, rest) = JSERunner.splitOnAssign(spec) else { return }
        let args = JSERunner.splitArgs(rest)
        func n(_ i: Int) -> Int {   // clamped — a raw Int(Double) would trap on NaN/∞/huge author input
            guard i < args.count, let v = JSE.number(JSE.eval(args[i], store: store, item: item)), !v.isNaN else { return 0 }
            return Int(Swift.min(Swift.max(v, -9.0e15), 9.0e15))
        }
        let start = n(0), del = n(1)
        let inserts = args.dropFirst(2).map { JSE.eval($0, store: store, item: item) ?? NSNull() }
        mutateArray(path, item: item) { arr in
            let s0 = Swift.min(Swift.max(start, 0), arr.count)
            let e0 = Swift.min(s0 + Swift.max(del, 0), arr.count)
            arr.replaceSubrange(s0..<e0, with: inserts)
        }
    }

    /// Quote-aware top-level split (action sequences: `a; b; c`) — backtick templates
    /// stay opaque too (escape pairs honored, like splitStatements).
    static func splitTopLevel(_ s: String, on sep: Character) -> [String] {
        var parts: [String] = []; var cur = ""; var q: Character? = nil; var esc = false
        for c in s {
            if q != nil {
                cur.append(c)
                if esc { esc = false } else if c == "\\" { esc = true } else if c == q { q = nil }
            }
            else if c == "'" || c == "\"" || c == "`" { q = c; cur.append(c) }
            else if c == sep { parts.append(cur); cur = "" }
            else { cur.append(c) }
        }
        parts.append(cur)
        return parts
    }

    /// Quote-aware split into statements on `;` AND newlines — so a `<action>` body (or any
    /// multi-line action) can use either separator. Mirrors `splitTopLevel` with two seps.
    static func splitStatements(_ s: String) -> [String] {
        // quote-aware (backslash pairs and `` ` `` template spans stay opaque, so a
        // multiline template never splits)
        var parts: [String] = []; var cur = ""; var q: Character? = nil; var esc = false
        for c in s {
            if q != nil {
                cur.append(c)
                if esc { esc = false } else if c == "\\" { esc = true } else if c == q { q = nil }
            }
            else if c == "'" || c == "\"" || c == "`" { q = c; cur.append(c) }
            else if c == ";" || c == "\n" { parts.append(cur); cur = "" }
            else { cur.append(c) }
        }
        parts.append(cur)
        return parts
    }

    /// JS array methods recognized as statements (`arr.push(x)` etc.) → the array verbs.
    static let arrayMethods: Set<String> = ["push", "pop", "shift", "unshift", "splice", "sort"]

    /// The HOUSE log formatter - moved to JSELibrary.swift (JSELogFormat) so
    /// satellite-node targets share it; these forwarders keep every existing
    /// call site (Context.reportLog, the dsx.log statement) source-compatible.
    static func formatLogValue(_ v: Any?) -> String { JSELogFormat.value(v) }

    static func formatLogArgs(_ a: [Any?]) -> String { JSELogFormat.args(a) }

    /// Quote- AND bracket-aware split on top-level commas — so an arg can itself be a nested
    /// `[...]` / `{...}` / `(...)` or a quoted string with commas (e.g. `splice`'s items).
    static func splitArgs(_ s: String) -> [String] {
        var parts: [String] = []; var cur = ""; var depth = 0; var q: Character? = nil
        for c in s {
            if let qq = q { cur.append(c); if c == qq { q = nil } }
            else if c == "'" || c == "\"" { q = c; cur.append(c) }
            else if c == "(" || c == "[" || c == "{" { depth += 1; cur.append(c) }
            else if c == ")" || c == "]" || c == "}" { depth -= 1; cur.append(c) }
            else if c == "," && depth == 0 { parts.append(cur); cur = "" }
            else { cur.append(c) }
        }
        parts.append(cur)
        return parts
    }

    /// Parse an action's handler object — `{ success: () => { … }, error: () => expr }` (the 2nd
    /// arg of `dsx.action.x(args, { … })`) — into eventName → handler-body string. Each body runs
    /// through the action runner with `dsx.this` = the payload when `dsx.event(name, …)` fires.
    static func parseHandlers(_ s: String) -> [String: String] {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("{"), t.hasSuffix("}") else { return [:] }
        var out: [String: String] = [:]
        for entry in splitArgs(String(t.dropFirst().dropLast())) {
            guard let colon = entry.firstIndex(of: ":") else { continue }
            let key = String(entry[..<colon]).trimmingCharacters(in: .whitespaces)
            var rhs = String(entry[entry.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            if let arrow = rhs.range(of: "=>") { rhs = String(rhs[arrow.upperBound...]).trimmingCharacters(in: .whitespaces) }
            if rhs.hasPrefix("{"), rhs.hasSuffix("}") { rhs = String(rhs.dropFirst().dropLast()) }   // strip the arrow's block braces
            if !key.isEmpty { out[key] = rhs }
        }
        return out
    }

    /// `fetch: dest = METHOD url [body=expr] [headers=expr]` — call any HTTP endpoint
    /// (rich JSON body from a state object/array/row), parse the response, and write an
    /// envelope into state: `dest.loading` / `dest.error` / `dest.data`. dsx-free, so it
    /// works in any surface; the request runs in a Task and writes back on the main actor.
    private func performFetch(_ spec: String, item: [String: Any]?, continuation: (() -> Void)? = nil) {
        let s = spec.trimmingCharacters(in: .whitespaces)
        guard let eq = s.firstIndex(of: "=") else { return }
        let dest = String(s[..<eq]).trimmingCharacters(in: .whitespaces)
        var tokens = String(s[s.index(after: eq)...]).split(separator: " ").map(String.init)
        guard !dest.isEmpty, tokens.count >= 2 else { return }
        let method = tokens.removeFirst()
        let url = JSE.interpolate(tokens.removeFirst(), store: store, item: item)
        var headers: [String: String] = [:]
        var bodyData: Data? = nil
        var thenAction: String? = nil, catchAction: String? = nil   // run a named <action> on success / error (sequencing)
        for t in tokens {
            if t.hasPrefix("body="),
               let v = JSE.eval(String(t.dropFirst(5)), store: store, item: item),
               JSONSerialization.isValidJSONObject(v) {
                bodyData = try? JSONSerialization.data(withJSONObject: v)
            } else if t.hasPrefix("headers="),
                      let h = JSE.eval(String(t.dropFirst(8)), store: store, item: item) as? [String: Any] {
                for (k, val) in h { headers[k] = JSE.string(val) }
            } else if t.hasPrefix("then=")  { thenAction  = String(t.dropFirst(5)) }
            else if t.hasPrefix("catch=") { catchAction = String(t.dropFirst(6)) }
        }
        write(dest + ".loading", true)
        write(dest + ".error", "")
        Task { @MainActor in
            guard let res = await StackTransportSeam.request(url, method, headers, bodyData) else {
                write(dest + ".loading", false); write(dest + ".error", "network")
                if let c = catchAction { run("do: " + c, item: item) }
                continuation?()                                           // await: run the rest of the action body
                return
            }
            write(dest + ".loading", false)
            if (200..<300).contains(res.status) {
                write(dest + ".data", (try? JSONSerialization.jsonObject(with: res.data, options: [.fragmentsAllowed])) ?? NSNull())
                if let t = thenAction { run("do: " + t, item: item) }     // success → sequence on
            } else {
                write(dest + ".error", "http \(res.status)")
                if let c = catchAction { run("do: " + c, item: item) }     // error → recovery
            }
            continuation?()                                               // await: run the rest of the action body (it reads the envelope)
        }
    }
    private func dispatch(_ target: String, item: [String: Any]?) {
        // Interpolate {{...}} then dispatch. Accepts the dot-API form so XML matches
        // web's `despia.scheme.method(...)` — `haptic.success`, `haptic.pattern?style=heavy`,
        // `store.checkout(id=42)` — converting it to the internal scheme + method URL.
        // The legacy scheme-host URL form still works (see OpenSource/Documentation/legacy.md).
        var t = target.trimmingCharacters(in: .whitespaces)
        // `dsx.module.self.method(…)` — `self` is the package THIS component lives in (the runner's
        // `scope`), so a packaged component never hard-codes its own scheme (and can't go stale on
        // a rename). Resolve `self` → the owning scheme up front; no owning package → unavailable.
        if t == "self" || t.hasPrefix("self.") || t.hasPrefix("self(") {
            guard let me = scope, !me.isEmpty else { unavailable(target); return }
            t = me + String(t.dropFirst(4))
        }
        // Real JS: pkg.method({ a: b, c: d }) — an options object becomes the named args (values
        // are real expressions, evaluated by the object literal). The `(a=b)` form stays as legacy.
        if let lp = t.firstIndex(of: "("), t.hasSuffix(")") {
            let head = String(t[..<lp])
            let argStr = String(t[t.index(after: lp)..<t.index(before: t.endIndex)]).trimmingCharacters(in: .whitespaces)
            if head.contains("."), argStr.hasPrefix("{"),
               var obj = JSE.eval(argStr, store: store, item: item) as? [String: Any] {
                if let fid = store.frameId { obj["__frame"] = fid }   // frame identity framing key — see StackStore.frameId
                let d = Self.dispatchCarrier(Self.normalizeCall(head),
                                             params: Bridge.Params(dict: obj, onTerminal: { _ in }))
                if !d.handled { unhandled(head, scheme: d.scheme) }
                return
            }
        }
        let resolved = Self.normalizeCall(JSE.interpolate(t, store: store, item: item))
        var args: [String: Any] = [:]
        for (name, raw) in Self.carrierQuery(resolved) {           // a named arg's value is an expression: pkg.m(id=item.id) / (text=dsx.this.msg) — eval it, else keep the literal
            args[name] = JSE.eval(raw, store: store, item: item).map { JSE.string($0) } ?? raw
        }
        if let fid = store.frameId { args["__frame"] = fid }       // frame identity framing key — see StackStore.frameId
        let d = Self.dispatchCarrier(resolved, params: Bridge.Params(dict: args, onTerminal: { _ in }))
        if !d.handled { unhandled(target, scheme: d.scheme) }
    }

    /// A fire-and-forget dispatch fell through: a catalog scheme with NO implementation on this
    /// OS settles the structured `unsupported_platform` error into the call's (void) terminal —
    /// results are ignored by construction on this form, so the settle is a no-op, never an
    /// `unavailable` throw (the awaited form in `packageOp` sees the full error object; contract:
    /// OpenSource/Skills/android/api-mapping.md "Unsupported platform"). Everything else keeps
    /// today's `unavailable` path — and the whole branch is inert while
    /// `ModuleRegistry.platformSupport` is empty (the bare kernel).
    private func unhandled(_ call: String, scheme: String?) {
        if let scheme, ModuleRegistry.shared.unsupportedPlatforms(scheme) != nil { return }
        unavailable(call)
    }

    /// Dispatch a normalized carrier ("scheme://action[/rest][?query]") by STRING SPLIT —
    /// the string funnel (`ModuleRegistry.handle(scheme:actionPath:)`), never
    /// `URL(string:)`: a package scheme is a routing KEY, not URL grammar. `godot_test`'s
    /// underscore and a nested chain's dots (`watch.health://heartRate`) are hostile to
    /// scheme-position URL parsing, and Foundation's strict parser must never adjudicate
    /// a call away into `unavailable` — byte-for-byte the Kotlin mount's law
    /// (Messenger.kt DSXModuleCallMount; review: the phone demo's nested watch calls).
    /// The query slot is dropped here — callers that carry `(a=b)` args parse it with
    /// `carrierQuery` first.
    static func dispatchCarrier(_ carrier: String, params: Bridge.Params) -> (handled: Bool, scheme: String?) {
        guard let sep = carrier.range(of: "://"), sep.lowerBound != carrier.startIndex else {
            return (false, nil)
        }
        let scheme = String(carrier[..<sep.lowerBound])
        let rest = String(carrier[sep.upperBound...])
        let actionPath = String(rest.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        return (ModuleRegistry.shared.handle(scheme: scheme, actionPath: actionPath,
                                             params: params, includeInternal: true), scheme)
    }

    /// The carrier's query pairs ("a=1&b=x"), percent-decoded with '+' kept literal —
    /// URLComponents' semantics without its strict-parser gate (the Kotlin
    /// parseURLComponents twin). Values stay raw strings; call sites eval expressions.
    static func carrierQuery(_ carrier: String) -> [(name: String, value: String)] {
        guard let qm = carrier.firstIndex(of: "?") else { return [] }
        let query = String(carrier[carrier.index(after: qm)...])
        guard !query.isEmpty else { return [] }
        return query.split(separator: "&").compactMap { pair in
            let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let k = kv.first, !k.isEmpty else { return nil }
            let rawValue = kv.count > 1 ? String(kv[1]) : ""
            return (String(k).removingPercentEncoding ?? String(k),
                    rawValue.removingPercentEncoding ?? rawValue)
        }
    }

    /// A package call / action invocation routes through `dispatch`; `handle` returns **false**
    /// when the scheme was never registered (package not installed / not imported) and a bare
    /// `name()` that matched no `<action>` falls through here too. **Inside a `try`** that becomes
    /// a `throw { code: "unavailable", call }` so `catch (e)` can react — universal feature
    /// detection. **Outside a try** it stays a silent no-op (the lenient default: a missing
    /// optional package must never crash the surface).
    private func unavailable(_ call: String) {
        guard store.tryDepth > 0, store.flowSignal == nil else { return }
        let name = String(call.split(separator: "(").first ?? Substring(call))
            .replacingOccurrences(of: "://", with: ".")
            .trimmingCharacters(in: .whitespaces)
        store.thrownValue = ["code": "unavailable", "call": name]
        store.flowSignal = "throw"
    }

    /// Normalize a `call:` target to the internal scheme-host URL form (scheme + `method` + `?args`),
    /// accepting the dot-API form (`scheme.method`, `scheme.method?args`, `scheme.method(a=b, c=d)`).
    /// A target that already contains the `"://"` separator is returned unchanged (legacy URL form).
    static func normalizeCall(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespaces)
        if s.contains("://") { return s }
        // method(a=b, c=d) → method?a=b&c=d   (dot-API call args)
        if let lp = s.firstIndex(of: "("), s.hasSuffix(")") {
            let head = String(s[..<lp])
            let inner = s[s.index(after: lp)..<s.index(before: s.endIndex)]
            let q = inner.split(separator: ",").map { arg -> String in     // trim spaces around `=` so `a = b` parses
                let kv = arg.split(separator: "=", maxSplits: 1)
                return kv.count == 2 ? kv[0].trimmingCharacters(in: .whitespaces) + "=" + kv[1].trimmingCharacters(in: .whitespaces)
                                     : arg.trimmingCharacters(in: .whitespaces)
            }.filter { !$0.isEmpty }.joined(separator: "&")
            s = q.isEmpty ? head : head + "?" + q
        }
        // scheme.method[?args] → scheme + `"://"` + method[?args] — chain-aware: the split
        // point is the end of the LONGEST known identity (ChainResolver — so
        // `watch.health.heartRate` becomes `watch.health://heartRate`, never a phantom
        // `health.heartRate` action on `watch`). Rewrites ONLY when the fold actually
        // consumed segments; an alias-only or unknown head keeps the legacy first-dot
        // split unchanged, preserving the arriving spelling the wire deliberately keeps
        // (alias-scoped tables, catch-all pre-filters). The remainder is cut VERBATIM
        // from the original (dot grammar preserved). The output is a CARRIER for
        // `dispatchCarrier` below — never hand it to `URL(string:)`.
        if let dot = s.firstIndex(of: "."), !s[..<dot].isEmpty, !s[..<dot].contains("/"), !s[..<dot].contains("?") {
            let qIdx = s.firstIndex(of: "?")
            let head = qIdx.map { String(s[..<$0]) } ?? s
            let tail = qIdx.map { String(s[$0...]) } ?? ""
            if let hdot = head.firstIndex(of: ".") {
                let r = ChainResolver.resolveWire(scheme: String(head[..<hdot]),
                                                  actionPath: String(head[head.index(after: hdot)...]),
                                                  table: ModuleRegistry.shared.identityTable())
                if r.folded > 0, r.member == nil {
                    return r.chain + "://" + r.rest + tail
                }
            }
            s = String(s[..<dot]) + "://" + String(s[s.index(after: dot)...])
        }
        return s
    }

    /// Parse `head?k=v&k2=v2` into the head token and a JSON payload (nil when no
    /// query). Values are interpolated and coerced to Bool / Double / String.
    private func payload(_ raw: String, item: [String: Any]?) -> (head: String, data: JSON?) {
        let resolved = JSE.interpolate(raw, store: store, item: item).trimmingCharacters(in: .whitespaces)
        let parts = resolved.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let head = String(parts.first ?? "").trimmingCharacters(in: .whitespaces)
        guard parts.count > 1, !parts[1].isEmpty else { return (head, nil) }
        var dict: [String: Any?] = [:]
        for pair in parts[1].split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            guard let k = kv.first.map(String.init) else { continue }
            dict[k] = coerce(kv.count > 1 ? String(kv[1]) : "")
        }
        return (head, JSON(dict))
    }
    private func coerce(_ s: String) -> Any {
        if s == "true" { return true }
        if s == "false" { return false }
        if let d = Double(s) { return d }
        return s
    }
    func has(_ scheme: String) -> Bool { ModuleRegistry.shared.isAvailable(scheme) }
}

// MARK: - Renderer

struct StackRootView: View {
    let root: StackNode
    @ObservedObject var store: StackStore
    let env: JSERunner
    var fillHeight = true               // screens fill; sheets hug (so content height is measurable)
    var colorScheme: ColorScheme? = nil // when set, FORCE the SwiftUI color scheme — a UIKit
                                        // overrideUserInterfaceStyle alone doesn't reach SwiftUI
                                        // glass/materials on iOS 26; nil = follow the system
    /// ROUTE-hosted surfaces only (the kernel host's screen frames — RouterHost): when the PAGE
    /// ROOT declares a `background`, the HOST canvas behind the page adopts it full-bleed — see
    /// `hostCanvasSpec`. False everywhere else, so every presented surface keeps its contract:
    /// sheets/covers the elevated system backdrop, overlay layers their transparency, the
    /// measuring pass its hug, `controller` presentations their own chrome.
    var routeCanvas = false
    // The ambient scheme as a TRACKED dependency for host-canvas resolution — a root
    // background authored via DSX-CSS can be scheme-conditional, so an appearance flip
    // must re-resolve it (the StackNodeView pattern; an imperative trait read is undefined
    // during body evaluation and would never invalidate).
    @Environment(\.colorScheme) private var ambientScheme
    var body: some View {
        StackNodeView(node: root, store: store, env: env, item: nil)
            .frame(maxWidth: .infinity, maxHeight: fillHeight ? .infinity : nil, alignment: .top)
            .background(pinnedCanvas)
            .preferredColorScheme(colorScheme)
    }
    /// A `theme=`-PINNED root paints its OWN full-bleed adaptive canvas (systemBackground
    /// resolved IN the pinned scheme, safe areas included). A page's content fills only the
    /// SAFE area — the region behind a claimed system bar (a large title is ~a third of the
    /// screen) and a sheet's chrome showed whatever the HOST painted, which follows the
    /// WINDOW trait: a dark-designed page under a light Appearance preference rendered a
    /// LARGE WHITE BAND over its black body (and vice versa). The canvas keys off the root
    /// element's own `theme` attr — a fixed-design page declares exactly this intent —
    /// while un-pinned (adaptive) pages and transparent surfaces (overlay layers, the
    /// passthrough planes, web frames) render byte-for-byte as before: no pin, no canvas.
    /// ROUTE frames add one more source (`hostCanvasSpec`, first — it wins when both apply):
    /// a page root that DECLARES its background gets that background as the full-bleed host
    /// canvas, resolved in the pinned scheme when the root also pins one.
    @ViewBuilder private var pinnedCanvas: some View {
        if let spec = hostCanvasSpec {
            if let pin = spec.pin {
                spec.color.environment(\.colorScheme, pin).ignoresSafeArea()
            } else {
                spec.color.ignoresSafeArea()
            }
        } else if let t = root.attrs["theme"], t == "dark" || t == "light" {
            Color(UIColor.systemBackground)
                .environment(\.colorScheme, t == "dark" ? .dark : .light)
                .ignoresSafeArea()
        }
    }
    /// The ROUTE host-canvas spec — nil (no canvas, today's rendering) unless this surface is
    /// route-hosted AND its PAGE ROOT declares a background the funnel can paint as a canvas.
    ///
    /// THE CANVAS SEAM: a page's content fills only the SAFE area, so the region behind a
    /// claimed system bar (a large title is ~a third of the screen), top/bottom overscroll and
    /// the home-indicator strip all showed the HOST's default canvas — systemBackground, a WHITE
    /// band over a grouped-gray page in light mode. A real system screen (insetGrouped and kin)
    /// is its canvas EDGE-TO-EDGE, so when the page root states its canvas the host adopts it —
    /// the same full-bleed machinery the theme= pin uses, fed by the root's RESOLVED background.
    /// A page with NO root background keeps systemBackground everywhere, unchanged.
    ///
    /// The PAGE ROOT is the surface root resolved THROUGH component references — a pushed
    /// frame's root is the reference `<Name/>`; the page root is that template's root (nested
    /// references followed, bounded; a non-component root — raw markup, the web view — resolves
    /// zero hops and is its own page root). The declared background resolves through the same
    /// layers StackNodeView renders it from — explicit attr, else inline DSX-CSS `style`, else
    /// the component sheet by class — then interpolation, so the canvas can never disagree with
    /// the paint the page itself shows. Only tokens the funnel paints DELIBERATELY become a
    /// canvas (StackStyle.canvasColor: the semantic words + literals); anything else — no
    /// declaration, `clear`, gradients/materials, an unparseable token — fails open to today's
    /// host canvas. `pin` carries the resolved root's `theme=` so a pinned page's semantic
    /// canvas resolves in ITS scheme; an authored literal canvas needs no pin — the
    /// luminance-derived subtree scheme (StackStyle.apply) styles the CONTENT while the canvas
    /// paints the same literal, seamless by construction.
    private var hostCanvasSpec: (color: Color, pin: ColorScheme?)? {
        guard routeCanvas else { return nil }
        var node = root
        var scope = env.scope
        var hops = 0
        while hops < 8, let (template, owningScope) = StackComponents.resolve(node.tag, pkg: scope) {
            node = template
            scope = owningScope ?? scope
            hops += 1
        }
        let a = StackNodeView.resolvePlatform(node.attrs)
        let classSet = Set((a["class"] ?? "").split(separator: " ").map(String.init))
        let isDark = ambientScheme == .dark
        var declared = a["background"]
        if declared == nil, let raw = a["style"], raw.contains(":") {
            let css = JSE.interpolate(raw, store: store, item: nil)
            if css.contains(":") {
                declared = StackStyleSeam.inlineAttributes(css, classSet, a["css-owner"], isDark, nil)["background"]
            }
        }
        if declared == nil, let owner = a["css-owner"], !classSet.isEmpty {
            declared = StackStyleSeam.sheetAttributes(owner, classSet, isDark, [:], nil)["background"]
        }
        guard let declared else { return nil }
        let token = JSE.interpolate(declared, store: store, item: nil).trimmingCharacters(in: .whitespaces)
        guard let color = StackStyle.canvasColor(token) else { return nil }
        let t = node.attrs["theme"] ?? root.attrs["theme"]
        return (color, t == "dark" ? .dark : (t == "light" ? .light : nil))
    }
}

/// Flat, glass-free style for genuinely composed pressable content. A canonical unstyled
/// `<button>` uses SwiftUI's real `.borderless` style in Button.swift; this style remains for
/// `<pressable>`, whose arbitrary authored child tree has no equivalent system control skin.
struct StackButtonStyle: ButtonStyle {
    /// Optional metrics remain available for composed callers, though `<pressable>` deliberately
    /// passes zero because arbitrary author content must never gain implicit padding.
    var paddingInline: CGFloat = 0
    var minHeight: CGFloat = 0
    func makeBody(configuration: Configuration) -> some View {
        metrics(configuration.label)
            .contentShape(Rectangle())
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(StackStyle.motionAnimation(DSXMotion.presetPress), value: configuration.isPressed)
    }

    /// Apply the metrics ONLY when set. A bare `.frame(minHeight: 0)` is NOT a no-op — it wraps
    /// the label in a flexible, center-aligned frame — so an unmetered caller (`<pressable>`, and
    /// every component built on it like `<Chip>`) must keep its exact previous view tree.
    @ViewBuilder
    private func metrics<V: View>(_ label: V) -> some View {
        if paddingInline > 0 || minHeight > 0 {
            label.padding(.horizontal, paddingInline).frame(minHeight: minHeight)
        } else {
            label
        }
    }
}

/// Renderer-neutral state machine for `on:hoverStart` / `on:hoverEnd`. SwiftUI's
/// adapter has one synthetic pointer id; Web and Compose retain their real ids. The
/// shared contract lives in OpenSource/Conformance/input/hover.json.
enum StackHoverLifecycleAction: String { case start, end }

struct StackHoverLifecycle {
    private(set) var activePointers: Set<String> = []

    mutating func enter(pointerID: String, pointerKind: String,
                        hoverCapable: Bool) -> [StackHoverLifecycleAction] {
        guard hoverCapable, pointerKind != "touch", !activePointers.contains(pointerID) else { return [] }
        let wasIdle = activePointers.isEmpty
        activePointers.insert(pointerID)
        return wasIdle ? [.start] : []
    }

    mutating func leave(pointerID: String) -> [StackHoverLifecycleAction] {
        guard activePointers.remove(pointerID) != nil, activePointers.isEmpty else { return [] }
        return [.end]
    }

    mutating func cancel(pointerID: String) -> [StackHoverLifecycleAction] {
        leave(pointerID: pointerID)
    }

    mutating func unmount() -> [StackHoverLifecycleAction] {
        guard !activePointers.isEmpty else { return [] }
        activePointers.removeAll()
        return [.end]
    }
}

/// SwiftUI exposes hover as a balanced Bool rather than raw pointer ids. This modifier
/// still deduplicates duplicate callbacks and, critically, emits End when SwiftUI removes
/// a hovered view before delivering `onHover(false)`.
private struct StackHover: ViewModifier {
    let env: JSERunner
    let item: [String: Any]?
    let onStart: String?
    let onEnd: String?
    @SwiftUI.State var lifecycle = StackHoverLifecycle()

    func body(content: Content) -> some View {
        content
            .onHover { hovering in
                var next = lifecycle
                let actions = hovering
                    ? next.enter(pointerID: "swiftui-hover", pointerKind: "pointer", hoverCapable: true)
                    : next.leave(pointerID: "swiftui-hover")
                lifecycle = next
                dispatch(actions)
            }
            .onDisappear {
                var next = lifecycle
                let actions = next.unmount()
                lifecycle = next
                dispatch(actions)
            }
    }

    private func dispatch(_ actions: [StackHoverLifecycleAction]) {
        for action in actions {
            switch action {
            case .start: if let onStart { env.run(onStart, item: item) }
            case .end:   if let onEnd { env.run(onEnd, item: item) }
            }
        }
    }
}

/// `on:drag` / `on:dragEnd` — a raw drag on any element, so DSX can compose its OWN sliders /
/// seek bars / knobs (no system `Slider`). The handler runs with `dsx.this` = the drag payload:
/// `fraction` (location.x / width, clamped 0–1) · `fractionY` · `x` `y` (local point) · `width`
/// `height` (the element's size, via a background GeometryReader) · `dx` `dy` (translation from
/// the start) · `phase` ("move" | "end"). `minimumDistance` 0 → a tap also fires (tap-to-seek).
private struct StackDrag: ViewModifier {
    let env: JSERunner
    let item: [String: Any]?
    let onStart: String?
    let onDrag: String?
    let onEnd: String?
    // SwiftUI.State qualified (an `enum State` in Host/ shadows it) + non-private so the
    // memberwise init stays callable from decorate() — the WatchView pattern.
    @SwiftUI.State var size: CGSize = .zero
    @SwiftUI.State var active = false
    func body(content: Content) -> some View {
        content
            .background(GeometryReader { g in
                Color.clear.onAppear { size = g.size }.dsxOnChange(of: g.size) { newSize in size = newSize }
            })
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .onChanged { v in
                        if !active { active = true; if let a = onStart { fire(a, v, "start") } }   // first touch = press / grab
                        if let a = onDrag { fire(a, v, "move") }
                    }
                    .onEnded { v in active = false; fire(onEnd ?? onDrag ?? "", v, "end") }          // release
            )
    }
    private func fire(_ action: String, _ v: DragGesture.Value, _ phase: String) {
        guard !action.isEmpty else { return }
        let w = max(size.width, 1), h = max(size.height, 1)
        let p: [String: Any] = [
            "x": Double(v.location.x), "y": Double(v.location.y),
            "width": Double(w), "height": Double(h),
            "fraction":  Double(min(max(v.location.x / w, 0), 1)),
            "fractionY": Double(min(max(v.location.y / h, 0), 1)),
            "dx": Double(v.translation.width), "dy": Double(v.translation.height),
            "phase": phase,
        ]
        env.run(action, item: p, args: p)
    }
}

/// `measure="dsx.variable.k"` — write the element's live `{ width, height }` to a state path (via a
/// background GeometryReader). Size a custom fill/thumb against it: `width="{{ dsx.variable.pos *
/// dsx.variable.k.width }}"`. Cheap — writes only when the size actually changes.
private struct StackMeasure: ViewModifier {
    let env: JSERunner
    let item: [String: Any]?
    let key: String
    // SwiftUI.State qualified (the `enum State` shadow) + non-private (memberwise init).
    @SwiftUI.State var last: CGSize = .zero
    func body(content: Content) -> some View {
        content.background(GeometryReader { g in
            Color.clear.onAppear { write(g.size) }.dsxOnChange(of: g.size) { newSize in write(newSize) }
        })
    }
    private func write(_ s: CGSize) {
        guard s != last else { return }
        last = s
        env.run("\(key) = { width: \(Double(s.width)), height: \(Double(s.height)) }", item: item)
    }
}

/// `dynamicType="true"` — scale a fixed `fontSize` with the user's Dynamic Type setting
/// (the a11y text-size slider), via `@ScaledMetric` so it tracks the setting LIVE (the metric
/// is environment-driven; a category change re-renders + rescales). Opt-in, so pixel-perfect
/// designs are unaffected by default — enable per element, or once in a `<style>` applied with
/// `class=` to scale a whole screen. `dynamicTypeMax` caps the scaled size (points) so an
/// accessibility-size run can't blow out a fixed-height control. Scales relative to `.body`.
private struct DSXScaledFont: ViewModifier {
    @ScaledMetric var size: CGFloat
    let weight: Font.Weight
    let design: Font.Design
    let cap: CGFloat?
    init(size: CGFloat, weight: Font.Weight, design: Font.Design, cap: CGFloat?) {
        self._size = ScaledMetric(wrappedValue: size, relativeTo: .body)
        self.weight = weight; self.design = design; self.cap = cap
    }
    func body(content: Content) -> some View {
        content.font(.system(size: cap.map { Swift.min(size, $0) } ?? size, weight: weight, design: design))
    }
}

// ── Container queries (`dsx.element.*`) ──────────────────────────────────────────────────────
// A `container`-marked element measures itself and injects its live { width, height } into the
// environment; descendants read it as `dsx.element.*` (resolved to `item.__element.*`) — the
// per-container analogue of `dsx.screen.*` (CSS @container). nil outside any container, so the
// scope merge is a no-op and non-container screens are byte-identical.
private struct DSXContainerKey: EnvironmentKey { static let defaultValue: [String: Any]? = nil }
extension EnvironmentValues {
    var dsxContainer: [String: Any]? {
        get { self[DSXContainerKey.self] }
        set { self[DSXContainerKey.self] = newValue }
    }
}

/// TRUE inside a scrolling / hugging container: the Scroll element stamps it around its
/// content, and the sheet's fit-content slot (`detents="content"`) stamps its measured
/// ScrollView. A descendant whose SYSTEM rendering would be a greedy SwiftUI `List`
/// (the unstyled `<list>` default, system-defaults.md) reads it and keeps the flat
/// pre-law path there — under an unbounded proposal a `List` reports ~0 ideal height
/// and collapses (the collapsed-paywall bug class). Pattern precedent: StackListRowKey
/// (StackWatch.swift). Internal on purpose — the List/Scroll/Sheet components consume it.
struct StackInScrollContainerKey: EnvironmentKey {
    static let defaultValue = false
}
extension EnvironmentValues {
    var stackInScrollContainer: Bool {
        get { self[StackInScrollContainerKey.self] }
        set { self[StackInScrollContainerKey.self] = newValue }
    }
}

/// `container` (a bare attribute on any element) — measure this element and publish its live size
/// to descendants as `dsx.element.width` / `dsx.element.height`. Cheap (a background GeometryReader;
/// `dsx.element` is reactive, so `columns="{{ dsx.element.width > 360 ? 2 : 1 }}"` re-flows live).
private struct StackContainer: ViewModifier {
    @SwiftUI.State var size: CGSize = .zero
    func body(content: Content) -> some View {
        content
            .background(GeometryReader { g in
                Color.clear.onAppear { size = g.size }.dsxOnChange(of: g.size) { newSize in size = newSize }
            })
            .environment(\.dsxContainer, ["width": Double(size.width), "height": Double(size.height)])
    }
}

/// Continuous, looping horizontal marquee (`<list axis="horizontal" autoscroll="N">`,
/// N = points/sec). The content is laid out twice end-to-end and offset by a linear
/// repeating animation across one copy's width, so the seam is invisible — a news-
/// ticker / auto-scrolling carousel that needs no manual drag.
struct StackMarquee<Content: View>: View {
    let speed: CGFloat
    let spacing: CGFloat
    @ViewBuilder let content: () -> Content
    @SwiftUI.State private var width: CGFloat = 0
    @SwiftUI.State private var run = false

    init(speed: CGFloat, spacing: CGFloat, @ViewBuilder content: @escaping () -> Content) {
        self.speed = speed
        self.spacing = spacing
        self.content = content
    }

    private struct WidthKey: PreferenceKey {
        // Computed, not stored: a nested type inside a generic (`StackMarquee<Content>`)
        // captures the generic context, and static *stored* properties aren't allowed there.
        static var defaultValue: CGFloat { 0 }
        static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
    }

    var body: some View {
        let shift = width + spacing
        HStack(spacing: spacing) { content(); content() }
            .fixedSize(horizontal: true, vertical: false)
            .background(GeometryReader { g in
                // g spans BOTH copies + the inter-copy spacing; one copy = (w - spacing) / 2.
                Color.clear.preference(key: WidthKey.self, value: (g.size.width - spacing) / 2)
            })
            .onPreferenceChange(WidthKey.self) { w in
                if w > 0, width == 0 { width = w; run = true }   // measure once, then start
            }
            .offset(x: run ? -shift : 0)
            .animation(width > 0 ? .linear(duration: Double(shift / max(speed, 1))).repeatForever(autoreverses: false) : nil, value: run)
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipped()
    }
}

/// Native SF Symbol morph (play ↔ pause, etc.) when the symbol changes — iOS 17+.
/// On older OSes it's a no-op (the icon just swaps), so the catalog stays safe
/// down to the iOS 15.6 deployment target.
struct SymbolReplace: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 17, *) { content.contentTransition(.symbolEffect(.replace)) }
        else { content }
    }
}

/// `enter=` entry animation (HTML `@starting-style`): the element renders at its FINAL
/// layout from the very first frame — safe-area expansion, measurements and full-bleed
/// children all resolved — and animates in purely via offset / opacity / scale, which
/// never touch layout. A slide travels in from the screen edge. This is how a whole
/// "page" animates in (present the surface transparently, root has enter="slide-right").
///
/// It must NOT be an insertion transition (`ZStack { if shown { content.transition } }`):
/// inserting the page meant an empty first frame and a re-layout when the spring
/// settled — a presented player that ignores safe areas sat letterboxed through the
/// whole enter, then visibly "jumped" to full screen at the end.
struct StackEntry: ViewModifier {
    let token: String                       // fade · scale · slide-top/bottom/left/right (unknown → fade)
    let anim: Animation
    let viewport: CGSize?
    @SwiftUI.State private var shown = false

    func body(content: Content) -> some View {
        // Use the live DSX app-window viewport. The scene fallback covers non-DSX callers
        // without ever confusing the iPad's physical screen with its current app window.
        let screen = viewport ?? StackStyleSeam.viewport()
        let dx: CGFloat = token == "slide-right" ? screen.width  : (token == "slide-left" ? -screen.width  : 0)
        let dy: CGFloat = token == "slide-bottom" ? screen.height : (token == "slide-top"  ? -screen.height : 0)
        let slides = dx != 0 || dy != 0
        return content
            .scaleEffect(token == "scale" && !shown ? 0.92 : 1)
            .opacity(slides || shown ? 1 : 0)   // fade/scale (and unknown tokens) fade in; slides stay opaque — they're off-screen
            .offset(x: shown ? 0 : dx, y: shown ? 0 : dy)
            .animation(anim, value: shown)
            .onAppear { shown = true }
    }
}

/// iOS 17 page-snapping for a vertical `<pager>` (`.scrollTargetBehavior(.paging)`);
/// a no-op (plain scroll) below 17, so the catalog stays safe to the deployment target.
struct PagingScroll: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 17, *) { content.scrollTargetBehavior(.paging) } else { content }
    }
}
/// Marks the vertical pager's page stack as the scroll target layout (iOS 17+).
struct PagingTargets: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 17, *) { content.scrollTargetLayout() } else { content }
    }
}

/// `<watch>` — a reactive observer (renders nothing). It re-renders with the store like every
/// node, recomputes `value` in its scope each pass, and runs `on:change` when the value's stable
/// key changes. `immediate` also fires once on mount. Loop backstop: fires are counted per
/// runloop and the budget is cleared async after the cascade settles, so a watcher that rewrites
/// its own dependency aborts (logged once) instead of hanging. iOS 15.6: single-param onChange.
/// (Android twin: a LaunchedEffect keyed on the same value.)
/// Lifecycle mount for a declarative `<api>` block — the Swift twin of Android's
/// `StackApiView` (render/StackApiView.kt), and the ONLY place a block is constructed.
///
/// Mounting from the render pass is what makes `<api>` work inside a COMPONENT: a
/// component's `<head>` is expanded by the consumer's tree, so it never reaches the
/// surface. The previous surface-root-only path (`StackSurface.mountApis`) left every
/// `<api>` in a component silently inert — it rendered, seeded nothing, and issued no
/// request, which is invisible because nothing is malformed.
///
/// `ApiBlock` owns the cross-platform state machine and re-materializes its own request
/// from `spec` on every store publish (StackStore.scheduleApiObservation), so the RAW
/// uninterpolated attrs are passed here deliberately — interpolating them first would
/// freeze the request and silently kill reactivity.
private struct StackApiMountView: View {
    let attrs: [String: String]
    let store: StackStore
    let env: JSERunner
    let item: [String: Any]?
    @StateObject private var mount = MountedStackApi()

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .onAppear { mount.start(attrs: attrs, store: store, env: env, item: item) }
    }
}

/// Owns one mounted block for the lifetime of its view identity. Disposal rides `deinit`
/// rather than `onDisappear` deliberately: a block inside a scrolling container must not
/// cancel and refetch every time its row leaves the screen — the request belongs to the
/// component INSTANCE, not to its visibility.
private final class MountedStackApi: ObservableObject {
    private var block: ApiBlock?
    private var claimed: String?
    /// Held only so the claim can be released on teardown; the store's reference back
    /// is weak (StackApiHandleRef), so this closes the loop without a cycle.
    private weak var owner: StackStore?

    func start(attrs: [String: String], store: StackStore, env: JSERunner, item: [String: Any]?) {
        guard block == nil else { return }   // onAppear fires again when a backgrounded surface returns
        // Returns nil when the name is already owned — which is exactly what happens when the
        // ROOT head renders, since StackSurface already mounted it. Nothing is constructed in
        // that case, so re-rendering a head can never issue a second request.
        guard let mounted = store.mountApiBlock(attrs: attrs, env: env, item: item) else { return }
        block = mounted
        claimed = (attrs["as"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        owner = store
    }

    deinit {
        guard let block else { return }
        block.dispose()
        if let claimed { owner?.releaseApiHandle(claimed, block) }
    }
}

private struct WatchView: View {
    @ObservedObject var store: StackStore
    let env: JSERunner
    let item: [String: Any]?
    let value: String
    let change: String
    let immediate: Bool
    @SwiftUI.State var didImmediate = false   // SwiftUI.State (an `enum State` in Host/ shadows it) + non-private so WatchView's memberwise init stays callable from raw()

    var body: some View {
        let v = JSE.eval(value, store: store, item: item)
        return Color.clear.frame(width: 0, height: 0)
            .onAppear { if immediate, !didImmediate { didImmediate = true; fire(v) } }
            .dsxOnChange(of: JSE.watchKey(v)) { _ in fire(JSE.eval(value, store: store, item: item)) }
    }

    private func fire(_ v: Any?) {
        guard !change.isEmpty else { return }
        store.watchBudget += 1
        if !store.watchResetScheduled {                            // clear the budget once this runloop's cascade drains
            store.watchResetScheduled = true
            DispatchQueue.main.async { store.watchBudget = 0; store.watchResetScheduled = false }
        }
        guard store.watchBudget <= 256 else {
            if store.watchBudget == 257 {
                kernelLog("[Stack] watch loop aborted near value=\(value): a watcher keeps rewriting its own dependency. Use <variable computed> for derived values — a <watch> must not write what it observes.")
            }
            return
        }
        let payload: [String: Any] = (v as? [String: Any]) ?? ["value": v as Any]   // dsx.this = new value (an object as-is, else {value: …})
        // A `<watch>` fires from `.onChange`, INSIDE the view-update pass, and its handler is
        // author JSE (store writes / dsx.event relays / structural visible-if flips). Run it
        // render-safe so the watch just works (the budget above still counts the queuing cascade).
        JSE.afterRender { env.run(change, item: payload, args: payload) }
    }
}

/// Native component builders receive a context whose store is a reference. Without a direct
/// DynamicProperty at this boundary, SwiftUI can treat a stateless child such as `<stars>` or
/// `<Checkbox>` as unchanged when only that referenced store publishes: sibling XML text updates,
/// while the native control's glyphs and accessibility traits remain stale. Re-invoke every native
/// builder from a store-observing host so raw attributes, slot scope and row write-back stay exactly
/// as authored and all native controls share the same reactive contract as `StackNodeView`.
private struct NativeStackComponentHost: View {
    @ObservedObject var store: StackStore
    @ObservedObject var global = DSX.state
    @ObservedObject var cookies = DSXCookies.shared
    let build: (StackComponentContext) -> AnyView
    let context: StackComponentContext

    init(build: @escaping (StackComponentContext) -> AnyView, context: StackComponentContext) {
        self._store = ObservedObject(wrappedValue: context.store)
        self.build = build
        self.context = context
    }

    var body: some View {
        build(
            context.withRenderRevisions(
                local: store.renderRevision,
                global: global.renderRevision,
                cookies: cookies.renderRevision
            )
        )
    }
}

/// Privileged components carry the same reference-backed evaluator contexts as safe native
/// components. In particular a vertical pager must observe an external write to its `value`
/// binding without replacing the pager (which would discard its scroll/@State). Keep the same
/// value-revision host contract at this structural-component boundary.
private struct PrivilegedStackComponentHost: View {
    @ObservedObject var store: StackStore
    @ObservedObject var global = DSX.state
    @ObservedObject var cookies = DSXCookies.shared
    let build: (PrivilegedStackComponentContext) -> AnyView
    let context: PrivilegedStackComponentContext

    init(
        build: @escaping (PrivilegedStackComponentContext) -> AnyView,
        context: PrivilegedStackComponentContext
    ) {
        self._store = ObservedObject(wrappedValue: context.store)
        self.build = build
        self.context = context
    }

    var body: some View {
        build(
            context.withRenderRevisions(
                local: store.renderRevision,
                global: global.renderRevision,
                cookies: cookies.renderRevision
            )
        )
    }
}

struct StackNodeView: View {
    let node: StackNode
    @ObservedObject var store: StackStore
    @ObservedObject var global = DSX.state   // re-render when global.* (DSXState) changes
    @ObservedObject var cookies = DSXCookies.shared   // re-render when the cookie jar changes (dsx.cookie.*)
    let env: JSERunner
    let rawItem: [String: Any]?
    /// Write-back path for the current row's `item` (set by `<list>`/`<grid>` per row,
    /// nil otherwise). Makes `item` a FIRST-CLASS bindable scope: an input bound to
    /// `item.field` edits the row in place, and a nested `<list bind="item.children">`
    /// (which sets this on its own rows) can write back through it — so editable +
    /// hierarchical collections work without flattening into the global store.
    var rowWrite: ((String, Any) -> Void)? = nil

    // Nearest `container`-marked ancestor's live { width, height }, via the environment.
    // `dsx.element.*` resolves against it (the CSS @container analogue). nil outside a container.
    @Environment(\.dsxContainer) private var containerMetrics: [String: Any]?

    // System appearance as a TRACKED dependency: DSX-CSS `@media (prefers-color-scheme)`
    // resolves against this, so an appearance flip re-evaluates every body.
    // (UITraitCollection.current is undefined during SwiftUI body evaluation and,
    // read imperatively, would never invalidate anything.)
    @Environment(\.colorScheme) private var colorScheme

    // `item` is now a COMPUTED scope (rawItem ⊕ the container metrics), so an explicit init is
    // required; it is memberwise-equivalent (same `item:` label) — only the stored name changed.
    init(node: StackNode, store: StackStore, env: JSERunner,
         item: [String: Any]?, rowWrite: ((String, Any) -> Void)? = nil) {
        self.node = node
        self._store = ObservedObject(wrappedValue: store)
        self.env = env
        self.rawItem = item
        self.rowWrite = rowWrite
    }

    /// The eval scope: the row `item` plus the nearest container's metrics under `__element`
    /// (so `dsx.element.width` → `item.__element.width`). Identical to `rawItem` outside a
    /// container, so all non-container rendering is byte-for-byte unchanged.
    var item: [String: Any]? {
        guard let c = containerMetrics else { return rawItem }
        var m = rawItem ?? [:]
        m["__element"] = c
        return m
    }

    /// The live app-window viewport published by DSXScreenMetrics. This is intentionally not
    /// UIScreen: on iPad a Split View/Stage Manager window is smaller than the physical display.
    private var cssViewport: CGSize? {
        func metric(_ key: String) -> CGFloat? {
            let value = global.getPath("screen.\(key)")
            if let number = value as? NSNumber, number.doubleValue.isFinite {
                return CGFloat(number.doubleValue)
            }
            if let number = value as? Double, number.isFinite { return CGFloat(number) }
            if let number = value as? Int { return CGFloat(number) }
            return nil
        }
        guard let width = metric("width"), let height = metric("height"),
              width > 0, height > 0 else { return nil }
        return CGSize(width: width, height: height)
    }

    var body: some View {
        // Two visibility modes:
        //  • default: `visible-if` inserts/removes the element (with `transition=`).
        //  • keep="true": the element stays MOUNTED and just fades opacity — so a
        //    glass/material view stays painted and never re-initializes (no dark/
        //    transparent flash on re-show). Hidden ⇒ opacity 0 + no hit-testing.
        // `enter=` adds an entry animation on first appear (HTML @starting-style):
        // the element renders at its FINAL layout immediately (safe areas + full-bleed
        // children resolved on frame one) and animates in via offset/opacity/scale —
        // same slide/fade/scale + anim vocabulary, reused for "pages".
        if let e = attrs["enter"] {
            visibilityBody.modifier(StackEntry(token: e,
                                               anim: StackStyle.animation(attrs["anim"], duration: attrs["animDuration"]),
                                               viewport: cssViewport))
        } else {
            visibilityBody
        }
    }

    private var visibilityBody: some View {
        Group {
            if keepAlive {
                content.opacity(visible ? 1 : 0).allowsHitTesting(visible)
            } else if visible {
                transitioned(content)
            }
        }
        .animation(visibilityAnimation, value: visible)
    }

    private var content: AnyView {
        decorate(StackStyle.apply(raw(attrs), attrs: attrs, store: store, item: item, tag: node.tag))
    }
    private var keepAlive: Bool { attrs["keep"] == "true" }

    private var visibilityAnimation: Animation? {
        if keepAlive {
            // Snappy fade by default (feels quick, not faded); override with anim=.
            return attrs["anim"] != nil
                ? StackStyle.animation(attrs["anim"], duration: attrs["animDuration"])
                : StackStyle.motionAnimation(DSXMotion.presetKeep)
        }
        return declaredAnimation
    }
    private var declaredAnimation: Animation? {
        guard attrs["transition"] != nil || attrs["anim"] != nil else { return nil }
        return StackStyle.animation(attrs["anim"], duration: attrs["animDuration"])
    }
    private func transitioned(_ v: AnyView) -> AnyView {
        guard let t = attrs["transition"] else { return v }
        return AnyView(v.transition(StackStyle.transition(t)))
    }

    /// Lifecycle + gesture hooks any element can carry: on:tap (on a non-control
    /// element — vstack/hstack/text/image/zstack/…), on:appear / on:disappear
    /// ("load on mount" / "start a 10s refresh"), and on:longpress.
    /// Controls (button / glassButton / transport / pressable / row) wire on:tap
    /// in `raw` via their Button, so we skip them here to avoid a double fire.
    private func decorate(_ v: AnyView) -> AnyView {
        var out = v
        if attrs["on:tap"] != nil || attrs["href"] != nil, !Self.tapControls.contains(node.tag) {
            // contentShape makes even an empty / transparent area hit-testable —
            // a drawer backdrop (`grow` with no background) or a spacer-padded cell.
            // `href=` alone makes any element a link (tap → route.push, the /web/04 contract).
            out = AnyView(out.contentShape(Rectangle()).onTapGesture { tap(); followHref() })
        }
        if let a = attrs["on:appear"]    { out = AnyView(out.onAppear { env.run(a, item: item) }) }
        if let a = attrs["on:disappear"] { out = AnyView(out.onDisappear { env.run(a, item: item) }) }
        if let a = attrs["on:longpress"] { out = AnyView(out.onLongPressGesture { env.run(a, item: item) }) }
        // on:hoverStart / on:hoverEnd — the pointer-hover lifecycle on ANY element
        // (desktop-platforms.md input grammar; the platform corpus pins the names).
        // SwiftUI `.onHover` fires only under a REAL pointer (macOS / Catalyst /
        // iPad pointer); on iPhone touch it simply never fires — Article-7
        // degradation, identical to the web twin's `(hover: hover)` gate and the
        // Compose pointer-events twin (StackNodeView.kt).
        if attrs["on:hoverStart"] != nil || attrs["on:hoverEnd"] != nil {
            out = AnyView(out.modifier(StackHover(env: env, item: item,
                                                  onStart: attrs["on:hoverStart"],
                                                  onEnd: attrs["on:hoverEnd"])))
        }
        // The pointer lifecycle on ANY element (your "div") — `on:dragStart` (press / grab),
        // `on:drag` (move, continuous), `on:dragEnd` (release). The handler gets `dsx.this` = {
        // fraction (x/width, 0–1), fractionY, x, y, width, height, dx, dy, phase }. minimumDistance
        // 0, so a tap fires start+end too. Compose custom sliders / seek bars / knobs /
        // swipe-to-dismiss / press-and-hold — drive a bindable transform (offset/scale/rotation/
        // opacity) from the drag state. `measure="dsx.variable.k"` writes the element's live
        // { width, height } to state, to size a custom fill/thumb against it.
        if attrs["on:drag"] != nil || attrs["on:dragStart"] != nil || attrs["on:dragEnd"] != nil {
            out = AnyView(out.modifier(StackDrag(env: env, item: item,
                                                 onStart: attrs["on:dragStart"], onDrag: attrs["on:drag"], onEnd: attrs["on:dragEnd"])))
        }
        // `on:adjust` — the VoiceOver/assistive adjustable action, so a custom control built from
        // `on:drag` (slider / seek bar / knob / stepper) is operable WITHOUT sight: a swipe-up/-down
        // fires this handler with `dsx.this` = { direction: "increment" | "decrement", phase: "adjust" }.
        // Opt-in (only when present); SwiftUI implies the `.adjustable` trait. Pair with `a11yValue`
        // so the new value is announced. (Android mirror: Compose `Modifier.semantics`
        // setProgress / the same named `adjust` event — Article 8.)
        if let a = attrs["on:adjust"] {
            out = AnyView(out.accessibilityAdjustableAction { direction in
                let dir = direction == .increment ? "increment" : "decrement"
                let p: [String: Any] = ["direction": dir, "phase": "adjust"]
                env.run(a, item: p, args: p)
            })
        }
        // Swipe actions — the REAL SwiftUI `.swipeActions` (a List/ForEach row swipe; the
        // edge-revealed button rail), NOT a context menu. `on:swipeTrailing` (right-edge, the
        // common "Delete"/"Archive" slot) and `on:swipeLeading` (left edge). Each dispatches
        // EXACTLY like `on:tap` — `env.run(action, item: item, args: eventArgs)`, so `arg:*` is the
        // payload and `item` is the row. `swipeLabel{Leading,Trailing}` sets the button text
        // (default "Action"); `swipeIcon{…}` an optional SF Symbol; `swipeRole{…}="destructive"`
        // makes it the red full-swipe action; `swipeColor{…}` tints a non-destructive button;
        // `swipeFullSwipe="false"` disables the swipe-all-the-way shortcut (default on). Trailing
        // is applied first so a single full-swipe maps to it (SwiftUI's full-swipe = first button).
        if attrs["on:swipeTrailing"] != nil { out = swipeDecorated(out, edge: .trailing, side: "Trailing") }
        if attrs["on:swipeLeading"]  != nil { out = swipeDecorated(out, edge: .leading,  side: "Leading") }
        if let m = attrs["measure"] { out = AnyView(out.modifier(StackMeasure(env: env, item: item, key: m))) }
        // `container` → measure + publish this element's size to descendants as `dsx.element.*`.
        if attrs["container"] != nil { out = AnyView(out.modifier(StackContainer())) }
        // `passthrough="true"` → decorative, non-interactive: touches fall through
        // to whatever is behind it (a legibility scrim over a tappable video).
        // iOS `.allowsHitTesting(false)`; Compose: a Box that doesn't consume.
        if attrs["passthrough"] == "true" { out = AnyView(out.allowsHitTesting(false)) }
        return out
    }
    /// Attach one edge's `.swipeActions` button. `side` is the attribute suffix ("Leading" /
    /// "Trailing"). The button fires `on:swipe<side>` through the SAME dispatch as `on:tap`
    /// (`env.run` with `eventArgs` + the row `item`), so it's a first-class action verb, not a new
    /// channel. `swipeRole<side>="destructive"` → the red, full-swipe-eligible role; a
    /// `swipeColor<side>` tints a non-destructive button; an SF Symbol (`swipeIcon<side>`) renders
    /// as a Label alongside the text. `swipeFullSwipe="false"` opts out of the full-swipe shortcut.
    private func swipeDecorated(_ v: AnyView, edge: HorizontalEdge, side: String) -> AnyView {
        guard let action = attrs["on:swipe\(side)"] else { return v }
        let label = attrs["swipeLabel\(side)"].map { JSE.interpolate($0, store: store, item: item) } ?? "Action"
        let icon = attrs["swipeIcon\(side)"].map { JSE.interpolate($0, store: store, item: item) }
        let destructive = (attrs["swipeRole\(side)"] == "destructive")
        let tint = attrs["swipeColor\(side)"].map { StackStyle.color($0) }
        let allowsFull = attrs["swipeFullSwipe"] != "false"
        // Capture the act in a value closure (the runner is a struct; the store reference is what
        // matters) so the Button body stays valid past this render — identical to how `tap()` runs.
        let act = { env.run(action, item: item, args: eventArgs) }
        let button = Button(role: destructive ? .destructive : nil, action: act) {
            if let icon, !icon.isEmpty { Label(label, systemImage: icon) } else { Text(label) }
        }
        return AnyView(v.swipeActions(edge: edge, allowsFullSwipe: allowsFull) {
            if let tint { button.tint(tint) } else { button }
        })
    }

    /// Tags whose `on:tap` is already wired by a Button in `raw` — and whose BOX GEOMETRY
    /// (padding / width / height / min-max / grow) therefore rides INSIDE that Button's label
    /// via `StackComponentContext.controlBox`, so the styled box IS the tappable box
    /// (StackStyle.apply skips those arms for these tags — see `controlBox`).
    static let tapControls: Set<String> = ["button", "glassButton", "transport", "pressable", "row"]

    /// Attributes with any imperative dsx.node overrides applied, resolved
    /// through the DSX-CSS cascade. Layer order, weakest → strongest (the
    /// spec's implicit @layer):
    ///   1. legacy named-style classes (store.classes — the global-ish layer)
    ///   2. the component's compiled DSX-CSS sheet (sidecar Component.css,
    ///      scoped by the css-owner stamp; matched by the element's class set)
    ///   3. inline DSX-CSS (a style value containing ':' — the migration
    ///      heuristic; bare tokens like style="card" stay legacy named styles)
    ///   4. the element's own explicit attributes + dsx.node overrides
    private var attrs: [String: String] {
        var a = node.attrs
        if !node.id.isEmpty, let o = store.overrides[node.id] { a.merge(o) { _, new in new } }
        // Platform-tagged style/class must reach the CSS branches below —
        // probe the exact keys (O(1) lookups; this property has no result
        // cache and runs many times per render) instead of scanning every key.
        // The merged result still resolves fully at the end, covering `key:ios`
        // entries carried by legacy class defs. (:native joined the fold with the
        // desktop targets — desktop-platforms.md; the Mac build additionally
        // probes its own winners.)
        if a["style:ios"] != nil || a["style:android"] != nil || a["style:native"] != nil ||
           a["class:ios"] != nil || a["class:android"] != nil || a["class:native"] != nil ||
           a["style:\(JSE.platformTarget)"] != nil || a["style:desktop"] != nil ||
           a["class:\(JSE.platformTarget)"] != nil || a["class:desktop"] != nil {
            a = Self.resolvePlatform(a)
        }

        // Reactive class formulas: `class="pet {{ petMood }}"` interpolates
        // BEFORE matching — a formula token could never match a sheet rule.
        let clsRaw = a["class"] ?? ""
        let cls = clsRaw.contains("{{") && clsRaw.contains("}}")
            ? JSE.interpolate(clsRaw, store: store, item: item) : clsRaw
        let classSet = Set(cls.split(separator: " ").map(String.init))
        var base: [String: String] = [:]

        // 1 — legacy classes (later class wins within the layer)
        if !cls.isEmpty, !store.classes.isEmpty {
            for name in cls.split(separator: " ") {
                if let def = store.classes[String(name)] { base.merge(def) { _, new in new } }
            }
        }
        // Inline CSS is interpolated + parsed BEFORE the sheet layer so the
        // element's own custom properties (`--card-pad: 20px`) are in scope
        // for sheet declarations — the three-scope token model:
        // theme < component sheet < element.
        var inlineCSS: String? = nil
        if let raw = a["style"], raw.contains(":") {
            let css = JSE.interpolate(raw, store: store, item: item)
            if css.contains(":") {
                a["style"] = nil
                inlineCSS = css
            } else {
                // The ':' lived inside {{ }} (style="{{ sel ? 'card' : 'sheet' }}")
                // and interpolation yielded a bare token — that is a legacy NAMED
                // style; hand it onward instead of swallowing it as empty CSS.
                a["style"] = css
            }
        }
        let elementTokens = inlineCSS.map(StackStyleSeam.customProperties) ?? [:]
        let isDark = colorScheme == .dark
        // 2 — the component sheet (theme + element tokens feed var())
        if let owner = a["css-owner"], !classSet.isEmpty {
            base.merge(StackStyleSeam.sheetAttributes(owner, classSet, isDark, elementTokens, cssViewport)) { _, new in new }
        }
        // 3 — inline CSS (cached parse)
        if let css = inlineCSS {
            base.merge(StackStyleSeam.inlineAttributes(css, classSet, a["css-owner"], isDark, cssViewport)) { _, new in new }
        }
        // 4 — the element itself always wins
        if !base.isEmpty {
            // Structural CSS translations that need the NODE (the bridge is
            // tag-blind). Axis-correct gap: hstack consumes the COLUMN gap
            // (horizontal main axis), vstack/list/grid the ROW gap; the generic
            // <stack> resolves its axis from flex-direction (column when unset;
            // a formula direction interpolates first so the axis matches what
            // the element will actually render). Web-true: ONLY the main
            // axis's gap becomes spacing — a lone cross-axis longhand stays
            // inert exactly as it is on the web. Sitting in `base` keeps
            // precedence exact: an explicit spacing attribute still wins.
            if base["rowGap"] != nil || base["columnGap"] != nil {
                var dir = a["flexDirection"] ?? base["flexDirection"] ?? "column"
                if dir.contains("{{") && dir.contains("}}") {
                    dir = JSE.interpolate(dir, store: store, item: item)
                }
                let horizontal = node.tag == "hstack" || (node.tag == "stack" && dir.hasPrefix("row"))
                if let g = horizontal ? base["columnGap"] : base["rowGap"] {
                    base["spacing"] = g
                }
            }
            // Element attributes always win: an explicit legacy `align` on the
            // element beats CSS align-items from classes/sheets/inline (the
            // two live under different keys, so the merge can't arbitrate).
            if a["align"] != nil { base["alignItems"] = nil }
            // display:none rides its own channel so it ANDs with the element's
            // own visible-if instead of colliding with it in the merge.
            if base["display"] == "none" { base["css-hidden"] = "true" }
            base.merge(a) { _, new in new }
            a = base
        }
        return Self.resolvePlatform(a)
    }

    /// Per-attribute platform override — the FULL LADDER (desktop-platforms.md; the
    /// law is the platform corpus, OpenSource/Conformance/platform/platform.json):
    /// precedence exact target > `:desktop` > `:native` > bare, most-specific wins;
    /// group suffixes fold to their member targets; suffixed keys never survive;
    /// only a recognized *suffix* is a platform tag, so `on:tap` / `arg:rate` are
    /// untouched — and `on:tap:ios` IS a platform tag on base `on:tap`. e.g.
    /// `icon="bell" icon:android="notifications"`. For small tweaks; for
    /// whole-element divergence prefer `visible-if="os == 'ios'"`. Twins: TS
    /// resolvePlatformAttrs (packages/compiler/src/component.ts) · Kotlin :core
    /// PlatformAttrs.resolve. The winner here is the render target — normally
    /// `ios`/`macos`; watchOS uses `watch` while retaining `platform.os == ios`.
    static let platformExactTargets = StackPlatformAttrs.exactTargets
    static let platformGroups = StackPlatformAttrs.groups

    static func resolvePlatform(_ a: [String: String]) -> [String: String] {
        resolvePlatform(a, target: JSE.platformAttributeTarget)
    }

    static func resolvePlatform(_ a: [String: String], target: String) -> [String: String] {
        StackPlatformAttrs.resolve(a, target: target)
    }

    private var visible: Bool {
        let a = attrs
        if a["css-hidden"] == "true" { return false } // CSS display:none — ANDs with visible-if
        guard let cond = a["visible-if"] else { return true }
        if cond.hasPrefix("has:") { return env.has(String(cond.dropFirst(4)).trimmingCharacters(in: .whitespaces)) }
        return JSE.truthy(JSE.eval(cond, store: store, item: item))
    }

    private var childrenView: some View {
        ForEach(node.children.indices, id: \.self) { i in
            StackNodeView(node: node.children[i], store: store, env: env, item: item, rowWrite: rowWrite)
        }
    }

    // `align=` cross-axis alignment, so centering/edge-aligning children is
    // declarative (no spacer gymnastics). vstack: leading(default)/center/trailing;
    // hstack: center(default)/top/bottom; zstack: center(default)/top/bottom/
    // leading/trailing/topLeading/…/bottomTrailing.
    static func hAlign(_ s: String?) -> HorizontalAlignment {
        switch s { case "center": return .center; case "trailing": return .trailing; default: return .leading }
    }
    static func vAlign(_ s: String?) -> VerticalAlignment {
        switch s { case "top": return .top; case "bottom": return .bottom; default: return .center }
    }
    static func zAlign(_ s: String?) -> Alignment {
        switch s {
        case "top": return .top; case "bottom": return .bottom
        case "leading": return .leading; case "trailing": return .trailing
        case "topLeading": return .topLeading; case "topTrailing": return .topTrailing
        case "bottomLeading": return .bottomLeading; case "bottomTrailing": return .bottomTrailing
        default: return .center
        }
    }

    private func raw(_ a: [String: String]) -> AnyView {
        // Privileged components — the structural orchestrators (list/grid/pager/tabs/scaffold).
        // Real library components (Components/Libraries/Mandatory/Structure/), resolved here
        // (before the built-in switch) so they render in THIS node's own scope, but granted
        // engine powers via the privileged dsx: scoped per-row rendering, child-node
        // introspection, collection write-back. They ship compiled-in (never OTA-loadable);
        // a remote screen still references them freely. See OpenSource/Documentation/reference/engine-capabilities.md.
        if let view = privilegedView(node.tag, a) { return view }
        switch node.tag {
        // Every leaf, control and container is now a component — text/image/button/inputs/
        // stacks/spinner/progress → Basics, list/grid/pager/tabs/scaffold/scroll → Structure,
        // video → Media — all resolved via `default:` (→ component) below. The kernel keeps
        // only two irreducible primitives: `slot` (the children bridge) and `node` (the dynamic
        // resolver).
        case "head":
            // The document's declaration section (see dsx-anatomy.md): the FIRST child of the
            // root element, holding the contract (<attribute>/<expects>/<event>) + state
            // (<variable>) + logic (<formula>/<action>/<script>) + reactions (<watch>) +
            // <style>/<component>. Transparent: its children render (declarations register,
            // view-backed ones like <watch> mount). A surface root's <head> is ALSO hoisted at
            // mount (StackHead.hoist) so declarations exist before SwiftUI evaluates anything —
            // re-registration here is idempotent by design.
            //
            // G4 unified input (dsx-game.md §2): a `<input>` CHILD OF THE HEAD is a
            // device-binding declaration (registered by StackHead.register / the hoist),
            // and the BODY tag of the same name stays the text-field component — POSITION
            // is the whole disambiguation, so the head's inputs never reach the component
            // resolver below.
            let visible = node.children.filter { $0.tag != "input" }
            if visible.count != node.children.count {
                return AnyView(ForEach(visible.indices, id: \.self) { i in
                    StackNodeView(node: visible[i], store: store, env: env, item: item, rowWrite: rowWrite)
                })
            }
            return AnyView(childrenView)
        case "event":
            // <event as="name" payload="a b"/> — DECLARES an event this component raises
            // (the defineEmits of DSX). Purely declarative at runtime: lint_dsx.rb checks
            // every dsx.event('x') in a file with a <head> against these, and docs/codegen
            // read them as the component's outbound contract.
            return AnyView(EmptyView())
        case "api":
            // Mounted HERE — wherever the tag renders — so a component's <head> gets its
            // request too (the surface only ever sees the root's). The block is claimed by
            // name, first declaration wins, so re-rendering the transparent <head> can
            // never create a second request. Raw attrs: ApiBlock owns interpolation.
            return AnyView(StackApiMountView(attrs: a, store: store, env: env, item: item))
        case "expects":
            // <expects variable="name"/> — DECLARES state the mounting side must seed
            // (ui.variable / dsx.component.push vars:). Registration is handled by
            // StackHead.hoist for surface roots (with a deferred missing-seed diagnostic);
            // inside a component template it is purely declarative.
            return AnyView(EmptyView())
        case "action":
            // A named, reusable action — optionally PARAMETERIZED like <formula>: the identifier
            // is `as`, and every OTHER attr is an input (an expression bound, in the caller's
            // scope, when the action runs). Body (multi-line verbs, if/else, const:) is invoked
            // with `do: x`. Declare in <head>.
            JSE.registerFunctions(node.text ?? "", store: store)   // register any `function name(){…}` in the body
            if let name = a["as"] {
                var inputs = a; inputs["as"] = nil; inputs["id"] = nil
                store.actions[name] = StackFormula(inputs: inputs, body: node.text ?? "")
            }
            return AnyView(EmptyView())
        case "variable", "var", "let":
            // Declare state from inline code (the element's text — multi-line; a single expression
            // OR a block with if/else + local `set:` + `return:`, like a function body). Two modes,
            // both referenced as plain variables (`{{ name }}` / `bind="name"`):
            //   • plain (default)        → initialize the variable ONCE to the evaluated body (its
            //                              default); `set:`/`push:` take over after.
            //   • `computed="true"`      → a reactive formula re-evaluated on every read in the
            //                              CURRENT scope, so a formula over `item.*` derives per
            //                              list row. Read-only.
            // Renders nothing — declare in <head> so it registers before it's read.
            JSE.registerFunctions(node.text ?? "", store: store)   // register any `function name(){…}` in the body
            if let name = a["as"] {
                if a["computed"] == "true" {
                    store.computed[name] = node.text ?? ""
                } else if store.initials[name] == nil {
                    store.initials[name] = JSE.evalBlock(node.text ?? "", store: store, item: item) ?? ""
                }
            }
            return AnyView(EmptyView())
        case "component":
            // INLINE component definition: <component as="Name"> <tree/> </component> — registers
            // the subtree as a reusable component scoped to the CURRENT package, exactly like a
            // Components/Name.dsx file, and renders nothing where it stands. Multiple top-level
            // children wrap in an implicit vstack (files have the same single-root rule). Define
            // top-level like <variable>/<action>; idempotent across re-renders (same name+scope
            // replaces). A whole page can ship as ONE file: state + actions + UI + components.
            if let name = a["as"], !name.isEmpty {
                let template = node.children.count == 1
                    ? node.children[0]
                    : StackNode(tag: "vstack", attrs: [:], children: node.children)
                StackComponents.defineNode(name, template: template, scope: env.scope)
            }
            return AnyView(EmptyView())
        case "formula":
            // A parameterized reactive formula: `<formula name="x" foo="item.a" bar="qty * price">
            // …uses foo, bar…</formula>`. Each non-reserved attr is an INPUT (an expression
            // evaluated in the use-site scope); the body computes from those names as locals, and
            // is a full block (if/else, const:, return). Referenced as `{{ x }}` / `bind="x"`,
            // recomputed on each read — a function with named, reactive params. The identifier is
            // `as` — every other attribute (even one literally called `name`) is an input.
            // Declare in <head>.
            JSE.registerFunctions(node.text ?? "", store: store)   // register any `function name(){…}` in the body
            if let name = a["as"] {
                var inputs = a; inputs["as"] = nil; inputs["id"] = nil
                store.formulas[name] = StackFormula(inputs: inputs, body: node.text ?? "")
            }
            return AnyView(EmptyView())
        case "script", "functions":
            // A function library — `<script>function discount(cart) { … }</script>`. Registers
            // every `function name(params){ … }` as a callable (positional args, depth-capped at
            // 32 — bounded). Renders nothing; define at the screen's top level. With the
            // `global` attribute (presence; canonical global="true") the block feeds the
            // app-wide GLOBAL FUNCTION LIBRARY instead of this surface's table — one
            // registration, every surface, last write wins (js-core.md "Shared logic";
            // corpus Conformance/functions; StackHead.register is the hoist-time twin).
            if a["global"] != nil { JSE.registerGlobalFunctions(node.text ?? "") }
            else { JSE.registerFunctions(node.text ?? "", store: store) }
            return AnyView(EmptyView())
        case "watch":
            // <watch value="<expr>" on:change="<action>" immediate="true?"> — a reactive OBSERVER.
            // Renders nothing; runs on:change whenever `value` settles to a NEW value, evaluated in
            // THIS scope — so a <watch> inside a list row observes that row's own dsx.this/dsx.item (one
            // observer per row), and a screen-level one observes dsx.variable/dsx.global. In the handler
            // dsx.this = the new value (object/row → dsx.this.key.key; scalar/array → dsx.this.value).
            // Derive with <variable computed> (pure, can't loop); reserve <watch> for SIDE EFFECTS,
            // and never let a watcher rewrite its own dependency (the budget backstop aborts runaways).
            return AnyView(WatchView(store: store, env: env, item: item,
                                     value: a["value"] ?? a["of"] ?? "",
                                     change: a["on:change"] ?? "",
                                     immediate: a["immediate"] == "true"))
        case "attribute":
            // <attribute as="x" default="<expr>" on:change="<action>"/> — DECLARES a component
            // attribute: its default (used when the consumer omits `x` — see attrDefaults in lookup)
            // and an optional change watcher ("dsx.attribute.x with a default, optionally watched").
            if let name = a["as"], let def = a["default"], store.attrDefaults[name] == nil {
                store.attrDefaults[name] = def
            }
            if let name = a["as"], let ch = a["on:change"] {
                return AnyView(WatchView(store: store, env: env, item: item,
                                         value: "dsx.attribute.\(name)", change: ch,
                                         immediate: a["immediate"] == "true"))
            }
            return AnyView(EmptyView())
        case "style":
            // A reusable style class — `<style as="card" padding="16" background="#111" radius="12"/>`.
            // Apply to any element with `class="card"` (multiple: `class="card wide"`); the element's
            // own attrs always win. Renders nothing; declare in <head>.
            if let name = a["as"] {
                var def = a; def["as"] = nil; def["id"] = nil
                store.classes[name] = def
            }
            return AnyView(EmptyView())
        case "slot":
            // Render the children the consumer passed to this component. `<slot/>`
            // = default slot (children with no `slot=` attr); `<slot name="x"/>` =
            // the children marked `slot="x"`. Rendered in the CONSUMER's scope.
            if let slot = env.slot {
                let name = a["name"]
                let kids = slot.children.filter { $0.attrs["slot"] == name }
                return AnyView(ForEach(kids.indices, id: \.self) { i in
                    StackNodeView(node: kids[i], store: store, env: slot.env, item: slot.item, rowWrite: slot.rowWrite)
                })
            }
            return AnyView(EmptyView())
        case "node", "dynamic":
            // A data-driven tag — `<node tag="{{ item.view }}" …/>`. The resolved name is
            // restricted to tags compiled into THIS binary (the capability boundary): an
            // unknown / unshipped tag renders nothing rather than guessing, so a remote
            // route can never name a view the app can't render. A bare `<node>` with no
            // `tag` keeps the old fall-through and just renders its children.
            let dynamicTag = JSE.interpolate(a["tag"] ?? "", store: store, item: item)
            if dynamicTag.isEmpty { return AnyView(childrenView) }
            if let view = privilegedView(dynamicTag, a) { return view }   // a data-driven <node tag="list">
            if let view = component(dynamicTag, a) { return view }
            // The capability boundary stays SILENT (an unshipped tag is legitimate fail-open —
            // a remote route naming an excluded module must no-op). But a tag whose template
            // FAILED TO PARSE is a real error: on test channels render the diagnostic card
            // instead of blank (fail-closed to production — failedToParse gates on isTest).
            if StackDiagnostics.failedToParse(dynamicTag) {
                return AnyView(StackDiagnosticCard(tag: dynamicTag))
            }
            return AnyView(EmptyView())
        default:
            // A Capitalized tag → a reusable component (folder-scoped) or a native global
            // component (Swift-backed). The same resolution backs the dynamic <node> above.
            if let view = component(node.tag, a) { return view }
            // TEST CHANNELS: an unresolved LITERAL component reference with no children to
            // fall back on renders the kernel DIAGNOSTIC CARD instead of a silent blank —
            // the tap opens the in-app drawer (exact parse error + copy-all logs). This is
            // how a dead template surfaces on a TestFlight build with no console attached.
            // Production (and any tag with slot children) renders exactly as before.
            if node.children.isEmpty, StackDiagnostics.flagsUnresolved(node.tag) {
                return AnyView(StackDiagnosticCard(tag: node.tag))
            }
            return AnyView(childrenView)
        }
    }

    /// A privileged orchestrator component for `tag` (list/grid/pager/tabs/scaffold/…), built
    /// with THIS node's own scope — its children (row templates / panes), `item`, and
    /// write-back. nil when `tag` isn't a registered privileged component. Used for a literal
    /// `<list>` (the dispatch above) and a data-driven `<node tag="{{ … }}">` resolving to one.
    private func privilegedView(_ tag: String, _ a: [String: String]) -> AnyView? {
        guard let build = StackComponents.privilegedGlobal(tag) else { return nil }
        let context = PrivilegedStackComponentContext(
            node: node,
            attrs: a,
            store: store,
            env: env,
            item: item,
            rowWrite: rowWrite
        )
        return AnyView(PrivilegedStackComponentHost(build: build, context: context))
    }

    /// Resolve a (possibly data-derived) Capitalized tag to a component — an XML template
    /// first, then a native global — wiring attributes + on:<event> + slot exactly like a
    /// literal tag. Returns nil when the tag isn't shipped in THIS binary, which is the
    /// capability boundary for the dynamic `<node tag="…"/>` above. (`default:` falls back
    /// to rendering children; `<node>` falls back to EmptyView.)
    private func component(_ tag: String, _ a: [String: String]) -> AnyView? {
        if let (template, owningScope) = StackComponents.resolve(tag, pkg: env.scope) {
            // Guard runaway recursion: a component whose template references itself would
            // expand forever. 32 is far beyond any legitimate nesting depth.
            if env.depth >= 32 { return AnyView(EmptyView()) }
            var attributes: [String: Any] = [:]
            var onHandlers: [String: OnHandler] = [:]
            for (k, v) in a {
                if k == "tag" || k == "id" { continue }        // selector / identity, not attributes
                if k.hasPrefix("from:") { continue }           // emitter-identity filter — paired with on:<event> below, not an attribute
                if k.hasPrefix("on:") {
                    // Captured WITH the consumer's env — the handler is the CONSUMER's code and runs
                    // there, so `on:x="dsx.event('x')"` re-resolves one level up (bubbling, not a self-loop).
                    // A companion `from:<event>` narrows WHICH emitter this binding accepts (no bus).
                    let ev = String(k.dropFirst(3))
                    onHandlers[ev] = OnHandler(action: JSE.interpolate(v, store: store, item: item), env: env,
                                               from: a["from:" + ev].flatMap { OnHandler.parseFrom($0) })
                } else {
                    attributes[k] = JSE.interpolate(v, store: store, item: item)
                }
            }
            var childEnv = env
            childEnv.depth = env.depth + 1
            childEnv.scope = owningScope ?? env.scope   // a packaged component runs under ITS OWN scheme — so `dsx.module.self` + nested <Name/> resolve to its package; a global one inherits the consumer's
            childEnv.onHandlers = env.onHandlers.merging(onHandlers) { _, new in new }   // inherit the consumer's on:<event> handlers, own wins → custom events bubble up the component tree (each entry runs in its DECLARING env)
            // Hand this node's children to the component as slot content, captured with
            // the CONSUMER's env + data scope.
            childEnv.slot = node.children.isEmpty
                ? nil : SlotContent(children: node.children, env: env, item: item, rowWrite: rowWrite)
            return AnyView(StackNodeView(node: template, store: store, env: childEnv, item: attributes))
        }
        // A NATIVE global component (Swift-backed). Resolved AFTER XML, so an XML
        // component of the same name wins. Pass RAW attrs so prop reads stay reactive.
        if env.depth < 32, let build = StackComponents.nativeGlobal(tag) {
            var onHandlers: [String: OnHandler] = [:]
            for (k, v) in a where k.hasPrefix("on:") {
                // Same capture as the XML site: the handler runs in the CONSUMER's env, so a native
                // component's relay (`<video on:ended="dsx.event('ended'); …">`) bubbles instead of looping.
                // A companion `from:<event>` narrows WHICH emitter this binding accepts (no bus).
                let ev = String(k.dropFirst(3))
                onHandlers[ev] = OnHandler(action: JSE.interpolate(v, store: store, item: item), env: env,
                                           from: a["from:" + ev].flatMap { OnHandler.parseFrom($0) })
            }
            var childEnv = env
            childEnv.depth = env.depth + 1
            childEnv.onHandlers = env.onHandlers.merging(onHandlers) { _, new in new }   // inherit the consumer's on:<event> handlers, own wins → custom events bubble up the component tree (each entry runs in its DECLARING env)
            let slot = node.children.isEmpty ? nil : SlotContent(children: node.children, env: env, item: item, rowWrite: rowWrite)
            let context = StackComponentContext(
                attrs: a,
                store: store,
                env: childEnv,
                item: item,
                slot: slot,
                nodeText: node.text,
                rowWrite: rowWrite,
                componentTag: tag
            )
            return AnyView(NativeStackComponentHost(build: build, context: context))
        }
        // A package-registered native surface (`dsx.stack.register("feed") { … }`) — the RUNTIME
        // counterpart to a class-walk component (its closure can capture live package state),
        // resolved through the SAME path so `<feed/>` works like any tag. Builder takes raw attrs
        // (no dsx); ship a GlobalStackComponent if the surface wants the dsx. Lowest precedence —
        // an XML or native-global component of the same name wins.
        if let build = StackComponents.registry[tag] { return build(a) }
        return nil
    }

    private func tap() {
        guard let action = attrs["on:tap"] else { return }
        // Declarative debounce/throttle on a tappable non-control element: `on:tap.debounce="300"`.
        env.runGated(action, item: item, args: eventArgs,
                     debounceMs: JSERunner.gateMs(attrs, event: "tap", kind: "debounce"),
                     throttleMs: JSERunner.gateMs(attrs, event: "tap", kind: "throttle"),
                     gateKey: node.tag + ".tap")
    }

    /// `href=` on a non-control element — the generic-tap twin of
    /// StackComponentContext.followHref() (the /web/04 link contract).
    private func followHref() {
        guard let raw = attrs["href"] else { return }
        let path = JSE.interpolate(raw, store: store, item: item)
        guard !path.isEmpty else { return }
        env.run("dsx.module.route.push({ path: __href })", item: item, args: ["__href": path])
    }

    /// `arg:*` attributes → the event payload (interpolated + coerced to
    /// bool/number/string). Sent to an `on:<event>` handler alongside the row item.
    private var eventArgs: [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in attrs where k.hasPrefix("arg:") {
            let s = JSE.interpolate(v, store: store, item: item)
            let value: Any
            if s == "true" { value = true }
            else if s == "false" { value = false }
            else if let d = Double(s) { value = d }
            else { value = s }
            out[String(k.dropFirst(4))] = value
        }
        return out
    }

    // Leaves + controls (button/pressable/inputs/progress) are components now — their
    // builders moved into the component dsx (StackComponentContext gained run / boundValue /
    // setBound / cgFloat / sized; the engine's num/resolve are gone from here). `tap` /
    // `eventArgs` above stay: `decorate` uses them to wire `on:tap` on ANY element.
}

// MARK: - Expression evaluator (JS-LOOKALIKE → NATIVE; NOT JavaScript, NO bridge)
//
// This is NOT JavaScript and there is NO JS engine. `eval` below is the
// interpreter sense — "evaluate this expression in an environment" — NOT
// JSContext.evaluateScript; a string is NEVER handed to a JS runtime. The SYNTAX
// is JS-lookalike (a JS dev reads/writes it 1:1), but it is parsed by the
// hand-written tokenizer + recursive-descent Parser right here and interpreted
// DIRECTLY into native Swift values, read straight from the Swift store dict.
//
// BRIDGELESS — there is no JavaScriptCore / Hermes and no marshaling across a
// JS↔Swift boundary on any read: it is instant, zero overhead. (The same tiny
// evaluator ports 1:1 to Kotlin for the Android renderer.) And BOUNDED / total:
// no unbounded loops, no recursion, no arbitrary runtime — the higher-order fns
// (map/filter/…) are BOUNDED passes over a finite collection — so OTA content
// can't hang or DoS the UI by construction.
//
// Powers {{ interpolation }}, bind=, visible-if= and on: action args; the sibling
// `evalBlock` (function bodies: if/else, const/let, return) and the action runner
// (set/push/splice/JS-style statements) build on this same evaluator.
//
// Grammar (low → high precedence), recursive descent:
//   ternary :  cond ? a : b
//   ||       :  a || b           (returns a if truthy else b — default values)
//   &&       :  a && b           (returns b if a truthy else a)
//   == !=    :  equality (numeric if both numbers, else string)
//   < <= > >=:  numeric comparison
//   + -      :  +  is numeric add or string concat; - is numeric
//   * /      :  numeric
//   unary    :  !x   -x
//   postfix  :  a[i]   a.member   a.length            (JS indexing / member access)
//   primary  :  number  'string'  "string"  true/false/null  path.to.value  ( expr )
//              [a, b] / { id, qty } literals · fn(args) calls (upper/round/…)
//              map/filter/find/some/every/sortBy/sumBy(coll, expr)  bounded higher-order
//
// Paths resolve locals first (a component's attributes / list row `item`, `dsx.this`), then
// the shared store — so {{ title }} is a prop when present, else the store key.

// ── JSE — the expression & logic engine powering DSX ──────────────────────────
// `JSE` (here, the expression evaluator) + `JSERunner` (the statement / action runner) are the
// two halves of JSE — JavaScript Expressions: the JS-expression grammar EVALUATED by the
// platform (not a JS VM). Reactive in {{ … }} / visible-if, executable in on:* / <action>
// bodies; the same grammar runs on every renderer. See OpenSource/Documentation/reference/jse.md.
// MARK: - JSE evaluator moved to OpenSource/Engine/iOS/JSE.swift (extracted UIKit-free into the `logic` kernel tier)


// MARK: - Style + color

enum StackStyle {
    static func apply(_ view: AnyView, attrs: [String: String], store: StackStore, item: [String: Any]?, tag: String? = nil) -> AnyView {
        var v = view
        let style = namedStyle(attrs["style"])
        // Style values interpolate `{{ … }}`, so any style can bind to the store
        // (e.g. offset="{{ barOffset }}", opacity="{{ faded ? 0.4 : 1 }}").
        func val(_ k: String) -> String? {
            guard let raw = attrs[k] ?? style[k] else { return nil }
            return JSE.interpolate(raw, store: store, item: item)
        }
        let num: (String?) -> CGFloat? = { $0.flatMap { Double($0) }.map { CGFloat($0) } }

        // TAP CONTROLS (StackNodeView.tapControls — the Button-cored elements) carry their BOX
        // GEOMETRY *inside* the control's tappable core: StackComponentContext.controlBox runs
        // these same two arms (boxGeometry + flexFrame) around the Button label / gesture
        // surface, so the padded, grown box IS the hit area — CSS button semantics, where a
        // click in the padding is a click on the button. Applying them out here as well would
        // double every padding and leave the inner Button label-sized — the "only the text
        // taps" bug this split exists to fix. Every other tag keeps the exact pipeline below.
        let geometryInside = tag.map { StackNodeView.tapControls.contains($0) } ?? false
        if !geometryInside { v = boxGeometry(v, val: val, num: num) }
        if let fs = num(val("fontSize")) ?? fontSizeFromStyle(style) {
            let fw = weight(val("fontWeight") ?? style["fontWeight"])
            let fd = design(val("fontDesign"))
            if (val("dynamicType") ?? style["dynamicType"]) == "true" {
                // a11y opt-in: scale the fixed size with the user's Dynamic Type setting (capped by
                // `dynamicTypeMax` if given). Default path below is byte-for-byte the original fixed font.
                let cap = num(val("dynamicTypeMax")) ?? style["dynamicTypeMax"].flatMap { Double($0) }.map { CGFloat($0) }
                v = AnyView(v.modifier(DSXScaledFont(size: fs, weight: fw, design: fd, cap: cap)))
            } else {
                v = AnyView(v.font(.system(size: fs, weight: fw, design: fd)))
            }
        }
        if !geometryInside { v = flexFrame(v, val: val, num: num, tag: tag) }
        // Fill layers AFTER the frame blocks so they span the final size. Order is
        // solid background → gradient → material: the LAST `.background` sits
        // furthest back, so `surface` (frosted glass) blurs the content BEHIND the
        // element while the `gradient` reads as a sheen on top of the frost — a
        // proper glass look, not a flat tint. (A `grow` pill / grid card fills too.)
        if let bg = val("background") {
            let r = num(val("radius")) ?? 0
            v = AnyView(v.background(RoundedRectangle(cornerRadius: r, style: .continuous).fill(color(bg))))
        }
        // `gradient="c1|c2|…"` — a linear gradient layer (2+ colors). `gradientDir`
        // = vertical (default) / horizontal / diagonal.
        if let grad = val("gradient") {
            let cols = grad.components(separatedBy: "|").map { color($0) }
            if cols.count >= 2 {
                let (s, e) = gradientPoints(val("gradientDir"))
                v = AnyView(v.background(LinearGradient(colors: cols, startPoint: s, endPoint: e)))
            }
        }
        if let surface = val("surface") {
            let r = num(val("radius")) ?? (surface == "sheet" ? 24 : 16)
            let shape = RoundedRectangle(cornerRadius: r, style: .continuous)
            // Real Liquid Glass on iOS 26+ (the Apple frosted-glass material with
            // its own highlights/refraction); falls back to .ultraThinMaterial on
            // older OSes / SDKs. The compiler guard keeps it building on Xcode < 26.
            //   glassTint="accent|#hex"    color the GLASS itself — a full-color glass
            //                              button, not tinted text. Below 26 it falls
            //                              back to a solid fill of the tint, so the
            //                              full-color read survives on every device.
            //   glassInteractive="true|false"  the system's bouncy press-stretch response
            //                              (the SwiftUI-native liquid feel). Defaults ON
            //                              for tappable elements, removable per element
            //                              or via the `-dsx-glass-*` CSS properties.
            let tint = val("glassTint")
            #if compiler(>=6.2)
            if (surface == "glass" || surface == "ultraThin"), #available(iOS 26.0, *) {
                var glass: Glass = .regular
                if let t = tint { glass = glass.tint(color(t)) }
                // OPT-IN only. #1002 defaulted `.interactive()` on for every tappable, but the
                // engine applies glassEffect per element with NO GlassEffectContainer — on iOS 26
                // a glass-dense sheet (Custom tuning: ~20 interactive chips) leaks a stray platter
                // at the window top (the ghost capsule over the Dynamic Island). Until children
                // render inside a GlassEffectContainer, the press-stretch is per-element opt-in
                // via glassInteractive="true" / `-dsx-glass-interactive`.
                if val("glassInteractive") == "true" {
                    glass = glass.interactive()
                }
                v = AnyView(v.glassEffect(glass, in: shape))
            } else if let t = tint {
                v = AnyView(v.background(shape.fill(color(t))))
            } else {
                v = AnyView(v.background(material(surface), in: shape))
            }
            #else
            if let t = tint {
                v = AnyView(v.background(shape.fill(color(t))))
            } else {
                v = AnyView(v.background(material(surface), in: shape))
            }
            #endif
        }
        if let r = num(val("radius")) {
            v = AnyView(v.clipShape(RoundedRectangle(cornerRadius: r, style: .continuous)))
        }
        if let ar = aspect(val("aspectRatio")) { v = AnyView(v.aspectRatio(ar, contentMode: .fit)) }
        // Full-bleed past the safe area (notch / home indicator). Put it on a
        // background layer (video, dark fill, a bottom sheet) so it reaches the
        // screen edge while the rest of the page stays inset. `edges` = all /
        // top / bottom / horizontal / vertical.
        if let e = val("ignoreSafeArea") ?? val("fullBleed") {
            v = AnyView(v.ignoresSafeArea(.container, edges: Self.safeEdges(e)))
        }
        if let o = num(val("opacity")) { v = AnyView(v.opacity(Double(o))) }
        // Semantic THEME pin (`theme="dark|light"`, attrs ∪ style like every arm): fixes the
        // color scheme for THIS subtree — semantic colors (secondary/tertiary), materials,
        // system controls — AND prefers it on the presentation, so a dark-designed screen
        // pushed as a router frame carries dark system chrome (bar material, large title)
        // instead of clashing with the device's light mode. Root-stack usage is the norm
        // (a page pins its design); any element accepts it. Web twin: the element-scoped
        // `data-dsx-theme` token override (theme.ts).
        if let t = val("theme"), t == "dark" || t == "light" {
            let s: ColorScheme = t == "dark" ? .dark : .light
            // toolbarColorScheme: the SUBTREE pin can't reach UIKit bar chrome — the
            // claimed system bar's material resolves against the WINDOW trait, which the
            // Appearance module overrides to the USER's preference. A dark-pinned page
            // under a light preference rendered a light bar/status strip over black
            // content; pinning the toolbar scheme routes the bar through the same pin.
            // NEVER `.preferredColorScheme` here: that is a PRESENTATION-WIDE preference
            // (it walks up to the enclosing presentation root), and SwiftUI keeps COVERED
            // nav frames alive — so one dark-pinned page anywhere in the stack dragged the
            // whole host dark while the Appearance authority said light. That was the
            // mixed-scheme trio: dark bar glyphs over a light page (the invisible
            // white-on-white back button), a light band over a dark body, sheets on the
            // opposite scheme. The pin is the SUBTREE environment + this screen's own bar;
            // the window stays the Appearance module's alone.
            v = AnyView(v.environment(\.colorScheme, s)
                         .toolbarColorScheme(s, for: .navigationBar))
        } else if val("theme") == nil, let bg = val("background"), let s = derivedScheme(bg) {
            // An authored LITERAL canvas derives its subtree scheme — the explicit form is
            // theme=. A background that parses to a literal color (hex / rgb()/rgba() /
            // the white/black words — NEVER the semantic words, which already follow the
            // ambient scheme, and never gradients/materials) sets the SAME subtree
            // environment the theme= pin sets, from the color's relative luminance:
            // `<vstack background="#0A0A0A"><text>` resolves `label` white exactly as the
            // pre-law pinned default did, and an authored LIGHT card resolves it dark
            // (no more white-on-white). ANY authored theme= suppresses the derivation
            // (the if/else — explicit always wins); overlay-ish paints (alpha < 0.5)
            // never derive. Subtree-only: no toolbarColorScheme — a card must not
            // restyle the bar; a whole dark PAGE states it with theme="dark".
            v = AnyView(v.environment(\.colorScheme, s))
        }
        // Transforms + effects.
        if let rot = num(val("rotation")) { v = AnyView(v.rotationEffect(.degrees(Double(rot)))) }
        if let sc = num(val("scale")) { v = AnyView(v.scaleEffect(sc)) }
        if let bl = num(val("blur")) { v = AnyView(v.blur(radius: bl)) }
        if let bc = val("borderColor") {
            let r = num(val("radius")) ?? 0
            v = AnyView(v.overlay(RoundedRectangle(cornerRadius: r, style: .continuous)
                .stroke(color(bc), lineWidth: num(val("borderWidth")) ?? 1)))
        }
        if let sh = val("shadow") {
            let c = val("shadowColor").map { color($0) } ?? Color.black.opacity(0.25)
            v = AnyView(v.shadow(color: c, radius: num(sh) ?? 8, x: num(val("shadowX")) ?? 0, y: num(val("shadowY")) ?? 2))
        }
        // ACCESSIBILITY — the cross-platform contract (StackReference → Accessibility).
        // One small attribute set that maps 1:1 to SwiftUI accessibility and Compose
        // semantics, on ANY element. Values interpolate like every style attribute.
        // TWO equal spellings per key (StackReference §Accessibility): the DSX one and the
        // WEB-STANDARD aria one — web developers write what they already know, and the web
        // renderer emits it verbatim. aria wins nothing / loses nothing: first present wins.
        //   a11yGroup="true" · role="group"        combine children into ONE element
        //   a11yLabel        · aria-label          what's read aloud   (Compose: contentDescription)
        //   a11yHint         · aria-description    supplemental, read after
        //   a11yValue        · aria-valuetext      current value       (Compose: stateDescription)
        //   a11yTrait        · role                CSV: button/header/image/link/selected/static
        //   a11yHidden       · aria-hidden         invisible to assistive tech
        // Free default: any element carrying on:tap announces as a button.
        let role = val("role")
        // The BUTTON-role variant grammar, never an ARIA trait — system-defaults.md,
        // mirrored from the web renderer: mount keeps exactly the `buttonRoles` words off
        // the DOM role pass-through (web twin: BUTTON_ROLES, elements.ts · Android twin:
        // SystemButton.BUTTON_ROLES). `StackStyle.buttonRoles` (near the color funnel) is
        // THE single source on iOS — the button family maps the same set to the SwiftUI
        // ButtonRole; every other value keeps its a11y meaning below.
        let ariaRole = (role.map { buttonRoles.contains($0) } ?? false) ? nil : role
        if attrs["a11yGroup"] == "true" || role == "group" {
            v = AnyView(v.accessibilityElement(children: .combine))
        }
        if let al = val("a11yLabel") ?? val("aria-label"), !al.isEmpty { v = AnyView(v.accessibilityLabel(Text(al))) }
        if let ah = val("a11yHint") ?? val("aria-description"), !ah.isEmpty { v = AnyView(v.accessibilityHint(Text(ah))) }
        if let av = val("a11yValue") ?? val("aria-valuetext"), !av.isEmpty { v = AnyView(v.accessibilityValue(Text(av))) }
        if let at = val("a11yTrait") ?? (ariaRole == "group" ? nil : ariaRole) {
            v = AnyView(v.accessibilityAddTraits(a11yTraits(at)))
        } else if attrs["on:tap"] != nil {
            v = AnyView(v.accessibilityAddTraits(.isButton))   // tappable ⇒ announced as a button
        }
        if (val("a11yHidden") ?? val("aria-hidden")) == "true" { v = AnyView(v.accessibilityHidden(true)) }
        // Offset LAST — a pure positional adjustment of the FULLY-STYLED element, so the
        // frame, background, border and shadow all ride along (CSS-transform semantics).
        // Applied early it only shifts the inner content: a sized element whose pixels
        // come from `background` (a scrubber thumb) would paint at the un-offset spot.
        // Kept present whenever declared (stable identity) so a bound value tweens
        // under ui.animate / animate:.
        if val("offset") != nil || val("offsetX") != nil || val("offsetY") != nil {
            let ox = num(val("offsetX")) ?? 0
            let oy = num(val("offsetY")) ?? num(val("offset")) ?? 0
            v = AnyView(v.offset(x: ox, y: oy))
        }
        if let z = num(val("zIndex")) { v = AnyView(v.zIndex(Double(z))) }
        return v
    }

    /// The derived-scheme half of the authored-canvas law (see the theme= arm in `apply`):
    /// an authored background that parses to a LITERAL, opaque-ish color yields the subtree
    /// ColorScheme its luminance implies — relative luminance < 0.5 → `.dark`, else `.light`
    /// (sRGB coefficients 0.2126 R + 0.7152 G + 0.0722 B). nil (no derivation) for anything
    /// non-literal and for overlay paints (alpha < 0.5) — deriving a scheme from a translucent
    /// wash over an unknown canvas would be a guess.
    private static func derivedScheme(_ background: String) -> ColorScheme? {
        guard let c = literalRGBA(background), c.a >= 0.5 else { return nil }
        let luminance = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
        return luminance < 0.5 ? .dark : .light
    }

    /// The literal-color reader behind `derivedScheme` — EXACTLY the spellings `color(_:)`
    /// paints literally, in its order: the white/black named literals ARE literal; every
    /// other WORD (accent, clear, the semantic slots — they already follow the ambient
    /// scheme) is NOT; then rgb()/rgba() and 6/8-digit hex with `color(_:)`'s own
    /// normalization. An unparseable token returns nil (never derive from the funnel's
    /// `.white` fallback). Components as 0…1 sRGB + alpha.
    private static func literalRGBA(_ s: String) -> (r: Double, g: Double, b: Double, a: Double)? {
        switch s {
        case "white": return (1, 1, 1, 1)
        case "black": return (0, 0, 0, 1)
        case "accent", "clear", "label", "text", "secondary", "secondaryLabel",
             "tertiary", "tertiaryLabel", "background", "systemBackground",
             "secondaryBackground", "tertiaryBackground", "groupedBackground",
             "secondaryGroupedBackground", "fill", "fillFaint", "separator", "destructive":
            return nil
        default: break
        }
        // The funnel's rgb/rgba call spellings, required WELL-FORMED here — leading call
        // word + open, trailing close. A malformed call the tolerant funnel still paints
        // simply never derives — conservative, the ambient scheme stays.
        if s.hasSuffix(")"), s.range(of: "^rgba?\\(", options: .regularExpression) != nil {
            let n = s.drop { $0 != "(" }.dropFirst().prefix { $0 != ")" }
                .split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespaces)) ?? 0 }
            return n.count >= 3 ? (n[0]/255, n[1]/255, n[2]/255, n.count > 3 ? n[3] : 1) : nil
        }
        var hex = s.hasPrefix("#") ? String(s.dropFirst()) : s
        if hex.count == 6 { hex = "FF" + hex }
        guard hex.count == 8, let u = UInt64(hex, radix: 16) else { return nil }
        return (Double((u >> 16) & 0xFF)/255, Double((u >> 8) & 0xFF)/255,
                Double(u & 0xFF)/255, Double((u >> 24) & 0xFF)/255)
    }

    /// The BOX-GEOMETRY arms shared by `apply()` (every ordinary tag) and `controlBox` (INSIDE
    /// a tap control's Button label / gesture surface). Padding: all-sides `padding`, and/or
    /// per-axis (paddingH/paddingV) and per-edge (paddingTop/Bottom/Leading/Trailing,
    /// …Left/Right aliases). Then the fixed frame for width/height — sizes the element before
    /// its background (a circular 88×88 button gets a background that fills the whole frame) —
    /// and `width="fit"` / `height="fit"` (alias `fit-content`) = FIT-CONTENT: the element
    /// takes its content's IDEAL size on that axis — greedy descendants (scrolls, spacers,
    /// `grow`) collapse to their content instead of expanding; the hug primitive
    /// (`<sheet detents="content">` applies it to its slot automatically). ONE implementation
    /// so the control-inside path can never drift from the pipeline.
    private static func boxGeometry(_ view: AnyView, val: (String) -> String?, num: (String?) -> CGFloat?) -> AnyView {
        var v = view
        if let p = num(val("padding")) { v = AnyView(v.padding(p)) }
        if let px = num(val("paddingH")) ?? num(val("paddingX")) { v = AnyView(v.padding(.horizontal, px)) }
        if let py = num(val("paddingV")) ?? num(val("paddingY")) { v = AnyView(v.padding(.vertical, py)) }
        if let pt = num(val("paddingTop")) { v = AnyView(v.padding(.top, pt)) }
        if let pb = num(val("paddingBottom")) { v = AnyView(v.padding(.bottom, pb)) }
        if let pl = num(val("paddingLeading")) ?? num(val("paddingLeft")) { v = AnyView(v.padding(.leading, pl)) }
        if let pr = num(val("paddingTrailing")) ?? num(val("paddingRight")) { v = AnyView(v.padding(.trailing, pr)) }
        let wTok = val("width"), hTok = val("height")
        let isFit: (String?) -> Bool = { $0 == "fit" || $0 == "fit-content" }
        if let w = num(wTok) { v = AnyView(v.frame(width: w)) }
        if let h = num(hTok) { v = AnyView(v.frame(height: h)) }
        if isFit(wTok) || isFit(hTok) {
            v = AnyView(v.fixedSize(horizontal: isFit(wTok), vertical: isFit(hTok)))
        }
        return v
    }

    /// The FLEXIBLE-FRAME arm shared by `apply()` and `controlBox`: min/max width/height,
    /// `grow="true"` (fill on both axes; `grow="width"` / `grow="height"` fills one — a pill
    /// fills its row's width but keeps its natural height, no ballooning) + the content
    /// anchors. `alignY` anchors the CONTENT inside a flexible frame that ends up taller than
    /// it. WEB-TRUE anchors: unsteered content in a grown frame pins to the TOP-LEADING edge
    /// (CSS block flow / flex-start), never SwiftUI's centering default — the "randomly
    /// centered panel" symptom (a grow="width" card centering its hugged children as a
    /// group) is the disease this kills. Steering still wins, in order: `alignY` (vertical),
    /// legacy `align` (leading/trailing/center; top/bottom for the vertical), and CSS
    /// `align-items` (the cascade lands it in attrs; flex-start/center/flex-end map per
    /// axis). An explicit align="center" keeps BOTH axes centered — "center this" was
    /// stated intent, only the unspecified default changes.
    private static func flexFrame(_ view: AnyView, val: (String) -> String?, num: (String?) -> CGFloat?, tag: String?) -> AnyView {
        var v = view
        let minW = num(val("minWidth")), maxW = num(val("maxWidth"))
        let minH = num(val("minHeight")), maxH = num(val("maxHeight"))
        let grow = val("grow")
        let growW = grow == "true" || grow == "both" || grow == "width"
        let growH = grow == "true" || grow == "both" || grow == "height"
        if minW != nil || maxW != nil || minH != nil || maxH != nil || growW || growH {
            let alignY = val("alignY"), align = val("align")
            // align-items steers the CROSS axis only: horizontal for a column, vertical for a row.
            let isRow = (val("flexDirection") ?? "").hasPrefix("row")
            let itemsH = isRow ? nil : val("alignItems")
            let itemsV = isRow ? val("alignItems") : nil
            // Web-true UA exception: a <button> CENTERS its label (every browser's UA sheet
            // sets text-align:center / flex centering on button). Button-like tags therefore
            // default to CENTER on both axes when unsteered — steering still wins, including
            // an explicit `align-items: flex-start` (the flex-start arms below).
            let buttonLike = tag == "button" || tag == "glassButton" || tag == "transport"
            let anchorH: HorizontalAlignment =
                (align == "leading") ? .leading :
                (align == "trailing") ? .trailing :
                (align == "center" || itemsH == "center") ? .center :
                (itemsH == "flex-end" || itemsH == "end") ? .trailing :
                (itemsH == "flex-start" || itemsH == "start") ? .leading :
                buttonLike ? .center : .leading
            let vRaw = alignY ?? ((align == "top" || align == "bottom") ? align : nil)
            // A LONE alignY="center" anchors CENTER (rendering-1.0 R2.2 — this arm once
            // tested only top/bottom, so "center" fell through to top; the Android twin
            // carried the fall-through as a pinned bug-for-bug divergence, now retired).
            let anchorV: VerticalAlignment =
                vRaw == "top" ? .top :
                vRaw == "bottom" ? .bottom :
                vRaw == "center" ? .center :
                (itemsV == "flex-end" || itemsV == "end") ? .bottom :
                (align == "center" || itemsV == "center") ? .center :
                (itemsV == "flex-start" || itemsV == "start") ? .top :
                buttonLike ? .center : .top
            v = AnyView(v.frame(minWidth: minW, maxWidth: growW ? .infinity : maxW,
                                minHeight: minH, maxHeight: growH ? .infinity : maxH,
                                alignment: Alignment(horizontal: anchorH, vertical: anchorV)))
        }
        return v
    }

    /// A TAP CONTROL's styled box as its OWN tappable core — the same boxGeometry + flexFrame
    /// arms the pipeline runs for every other element, applied INSIDE the control (the Button
    /// label / the pressable gesture surface) and finished with a full-rect content shape.
    /// `apply()` skips exactly these arms for StackNodeView.tapControls, so geometry lands
    /// ONCE — in here — and the padded, grown, glass-backed box IS the button: a tap 30% into
    /// the label-less side of a grow="width" button registers (the "only the text is
    /// tappable" bug). Fill layers (background / surface / radius / border / shadow) stay
    /// OUTSIDE in apply() — they wrap this same box, so painted bounds == tappable bounds.
    static func controlBox(_ view: AnyView, attrs: [String: String], store: StackStore,
                           item: [String: Any]?, tag: String?) -> AnyView {
        let style = namedStyle(attrs["style"])
        func val(_ k: String) -> String? {
            guard let raw = attrs[k] ?? style[k] else { return nil }
            return JSE.interpolate(raw, store: store, item: item)
        }
        let num: (String?) -> CGFloat? = { $0.flatMap { Double($0) }.map { CGFloat($0) } }
        var v = boxGeometry(view, val: val, num: num)
        v = flexFrame(v, val: val, num: num, tag: tag)
        return AnyView(v.contentShape(Rectangle()))
    }

    /// `a11yTrait` CSV → SwiftUI traits (the Compose twins: Role.Button · heading() ·
    /// Role.Image · LinkAnnotation · selected · plain text semantics).
    private static func a11yTraits(_ csv: String) -> AccessibilityTraits {
        var t: AccessibilityTraits = []
        for token in csv.split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            switch token {
            case "button":   t.formUnion(.isButton)
            case "header":   t.formUnion(.isHeader)
            case "image":    t.formUnion(.isImage)
            case "link":     t.formUnion(.isLink)
            case "selected": t.formUnion(.isSelected)
            case "static":   t.formUnion(.isStaticText)
            default:         break
            }
        }
        return t
    }

    /// `aspectRatio` as "W:H" (e.g. 16:9) or a bare number.
    private static func aspect(_ s: String?) -> CGFloat? {
        guard let s = s else { return nil }
        if s.contains(":") {
            let p = s.split(separator: ":").compactMap { Double($0) }
            return p.count == 2 && p[1] != 0 ? CGFloat(p[0] / p[1]) : nil
        }
        return Double(s).map { CGFloat($0) }
    }
    /// `ignoreSafeArea` / `fullBleed` edges: "true"/"all" · top · bottom ·
    /// horizontal · vertical (default all).
    private static func safeEdges(_ s: String) -> Edge.Set {
        switch s {
        case "top": return .top
        case "bottom": return .bottom
        case "horizontal", "sides": return .horizontal
        case "vertical": return .vertical
        default: return .all
        }
    }
    private static func gradientPoints(_ dir: String?) -> (UnitPoint, UnitPoint) {
        switch dir {
        case "horizontal": return (.leading, .trailing)
        case "diagonal":   return (.topLeading, .bottomTrailing)
        default:           return (.top, .bottom)
        }
    }
    /// `fontDesign` = default / rounded / serif / monospaced.
    private static func design(_ s: String?) -> Font.Design {
        switch s { case "rounded": return .rounded; case "serif": return .serif
        case "monospaced", "mono": return .monospaced; default: return .default }
    }

    /// Text-specific styling on `<text>`: italic / underline / strikethrough /
    /// tracking (iOS 16+), lineLimit / lineSpacing / textAlign / textCase.
    static func styleText(_ text: Text, _ a: [String: String], color: Color) -> AnyView {
        var t = text.foregroundColor(color)
        if a["italic"] == "true" { t = t.italic() }
        if #available(iOS 16, *) {
            if a["underline"] == "true" { t = t.underline() }
            if a["strikethrough"] == "true" { t = t.strikethrough() }
            if let tr = a["tracking"].flatMap({ Double($0) }) { t = t.tracking(CGFloat(tr)) }
        }
        var v = AnyView(t)
        if let ll = a["lineLimit"].flatMap({ Int($0) }) { v = AnyView(v.lineLimit(ll)) }
        if let ls = a["lineSpacing"].flatMap({ Double($0) }) { v = AnyView(v.lineSpacing(CGFloat(ls))) }
        if let ta = a["textAlign"] { v = AnyView(v.multilineTextAlignment(textAlign(ta))) }
        if let tc = a["textCase"] {
            v = AnyView(v.textCase(tc == "upper" ? .uppercase : (tc == "lower" ? .lowercase : nil)))
        }
        return v
    }
    private static func textAlign(_ s: String) -> TextAlignment {
        switch s { case "center": return .center; case "trailing", "right": return .trailing; default: return .leading }
    }

    /// `surface` material: liquid-glass (`glass`/`ultraThin`), `thin`, `regular`,
    /// `thick`, or `sheet` (the default dark sheet). Drives `.ultraThinMaterial`
    /// & friends — the native iOS blur/vibrancy used for glass nav bars / sheets.
    private static func material(_ name: String) -> Material {
        switch name {
        case "thin":              return .thinMaterial
        case "regular":           return .regularMaterial
        case "thick":             return .thickMaterial
        case "glass", "ultraThin": return .ultraThinMaterial
        default:                  return .ultraThinMaterial   // "sheet"
        }
    }

    /// `transition=` enter/leave style (each combines with a fade):
    /// slide-top/bottom/left/right (the edge it moves from), fade, scale.
    static func transition(_ name: String) -> AnyTransition {
        let fade = AnyTransition.opacity
        switch name {
        case "fade":         return fade
        case "scale":        return .scale.combined(with: fade)
        case "slide-top":    return .move(edge: .top).combined(with: fade)
        case "slide-bottom": return .move(edge: .bottom).combined(with: fade)
        case "slide-left":   return .move(edge: .leading).combined(with: fade)
        case "slide-right":  return .move(edge: .trailing).combined(with: fade)
        default:             return fade
        }
    }
    /// `anim=` curve (`spring`/`linear`/`easeIn`/`easeOut`/`easeInOut`), with an
    /// optional `animDuration=` in seconds — DERIVED, never decided here. Since the UI
    /// MOTION ENGINE landed (architecture/proposals/ui-motion.md) the grammar, the
    /// defaults (0.35 s curves; spring response 0.4 / damping 0.8 with `animDuration`
    /// setting the RESPONSE) and the unit beziers all live in the SHARED kernel
    /// (`DSXMotion`, Motion.swift), corpus-pinned in OpenSource/Conformance/motion/ and
    /// executed by the TS, Kotlin and Swift runners over the same files. This is the
    /// SwiftUI EDGE only.
    static func animation(_ name: String?, duration: String?) -> Animation {
        motionAnimation(DSXMotion.parse(anim: name, animDuration: duration))
    }

    /// The SwiftUI edge of a kernel motion spec — the ONE place a shared spec becomes an
    /// `Animation`. A spring is SwiftUI's own oscillator (`response`/`dampingFraction`
    /// ARE the kernel's authoring plane, so the match is exact by construction); a curve
    /// is `.timingCurve`, which is the same cubic bezier the kernel solves.
    static func motionAnimation(_ spec: DSXMotionSpec) -> Animation {
        if spec.isSpring {
            return .spring(response: spec.response, dampingFraction: spec.dampingFraction)
        }
        return .timingCurve(spec.x1, spec.y1, spec.x2, spec.y2, duration: spec.durationSeconds)
    }

    private static func fontSizeFromStyle(_ style: [String: String]) -> CGFloat? {
        style["fontSize"].flatMap { Double($0) }.map { CGFloat($0) }
    }
    private static func weight(_ s: String?) -> Font.Weight {
        switch s { case "bold": return .bold; case "semibold": return .semibold
        case "medium": return .medium; case "heavy": return .heavy; default: return .regular }
    }

    private static let styles: [String: [String: String]] = [
        "sheet":      ["padding": "20", "background": "#121212", "radius": "24", "surface": "sheet"],
        "card":       ["padding": "16", "background": "rgba(255,255,255,0.06)", "radius": "16"],
        "heading":    ["fontSize": "24", "fontWeight": "bold"],
        "subheading": ["fontSize": "15"],
        "rowTitle":   ["fontSize": "17", "fontWeight": "semibold"],
        "price":      ["fontSize": "17", "fontWeight": "bold"],
    ]
    private static func namedStyle(_ name: String?) -> [String: String] {
        guard let name = name else { return [:] }
        return name.split(separator: " ").reduce(into: [:]) { acc, n in
            (styles[String(n)] ?? [:]).forEach { acc[$0.key] = $0.value }
        }
    }

    /// The two BUTTON-ROLE words of the variant grammar (system-defaults.md) — THE single
    /// source both iOS consumers read: `apply()`'s a11y pass-through keeps exactly these
    /// words off the ARIA trait mapping, and the button family (Button.swift) gates its
    /// ButtonRole mapping + role-word styling on membership here. Web twin: BUTTON_ROLES
    /// (elements.ts) · Android twin: SystemButton.BUTTON_ROLES (StackButtons.kt).
    static let buttonRoles: Set<String> = ["destructive", "cancel"]

    /// The HOST-CANVAS reading of a declared `background` token (StackRootView's route
    /// canvas): the funnel's Color when the token is a DELIBERATE paint — a semantic word
    /// (each names its adaptive UIColor slot in `color` below, so the canvas follows the
    /// scheme exactly like the page's own fill) or a literal in exactly the spellings
    /// `literalRGBA` reads (hex / rgb()/rgba() / the white/black words). nil for everything
    /// else — no declaration, `clear`/`transparent`, gradients/materials (separate attrs),
    /// an unparseable token (the funnel's `.white` fallback) — because a full-screen canvas
    /// must never paint what the page did not state.
    static func canvasColor(_ s: String) -> Color? {
        switch s {
        case "accent", "label", "text", "secondary", "secondaryLabel",
             "tertiary", "tertiaryLabel", "background", "systemBackground",
             "secondaryBackground", "tertiaryBackground", "groupedBackground",
             "secondaryGroupedBackground", "fill", "fillFaint", "separator", "destructive":
            return color(s)
        default:
            return literalRGBA(s) != nil ? color(s) : nil
        }
    }

    static func color(_ s: String) -> Color {
        switch s {
        case "white": return .white
        case "black": return .black
        // The APP's tint (the AccentColor asset — per-app, adaptive), never a hardcoded
        // brand hex: the snapshot renderers (StackLive gauges etc.) already resolve
        // accent this way, and a white-label app's markup `color="accent"` must match
        // its own tint on every surface, in both color schemes.
        case "accent": return Color.accentColor
        case "clear": return .clear
        // Semantic / adaptive colors — resolve against the view's light/dark trait,
        // so a surface can flip with the system (or an overrideUserInterfaceStyle).
        // The TEN corpus words of the system-defaults law all resolve here — label ·
        // secondary · tertiary · background · groupedBackground · secondaryGroupedBackground ·
        // fill · separator · accent · destructive — each to EXACTLY the UIColor slot the
        // `ios` column of OpenSource/Conformance/defaults/tokens.json names. The OS owns
        // the values, so inherited looks self-update with the OS; pre-corpus spellings
        // stay as aliases of the same slots.
        case "label", "text":              return Color(UIColor.label)
        case "secondary", "secondaryLabel": return Color(UIColor.secondaryLabel)
        case "tertiary", "tertiaryLabel":  return Color(UIColor.tertiaryLabel)
        case "background", "systemBackground": return Color(UIColor.systemBackground)
        case "secondaryBackground":        return Color(UIColor.secondarySystemBackground)
        case "tertiaryBackground":         return Color(UIColor.tertiarySystemBackground)
        case "groupedBackground":          return Color(UIColor.systemGroupedBackground)
        case "secondaryGroupedBackground": return Color(UIColor.secondarySystemGroupedBackground)
        case "fill":                       return Color(UIColor.systemFill)   // the corpus slot — was secondarySystemFill pre-corpus
        case "fillFaint":                  return Color(UIColor.quaternarySystemFill)
        case "separator":                  return Color(UIColor.separator)
        case "destructive":                return Color(UIColor.systemRed)    // the corpus danger slot, adaptive per scheme
        default: break
        }
        if s.hasPrefix("rgba(") || s.hasPrefix("rgb(") {
            let n = s.drop { $0 != "(" }.dropFirst().prefix { $0 != ")" }
                .split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespaces)) ?? 0 }
            if n.count >= 3 { return Color(.sRGB, red: n[0]/255, green: n[1]/255, blue: n[2]/255, opacity: n.count > 3 ? n[3] : 1) }
        }
        var hex = s.hasPrefix("#") ? String(s.dropFirst()) : s
        if hex.count == 6 { hex = "FF" + hex }
        if hex.count == 8, let v = UInt64(hex, radix: 16) {
            return Color(.sRGB, red: Double((v >> 16) & 0xFF)/255, green: Double((v >> 8) & 0xFF)/255,
                         blue: Double(v & 0xFF)/255, opacity: Double((v >> 24) & 0xFF)/255)
        }
        return .white
    }
}

// MARK: - DSXPathMatch (route matching) moved to OpenSource/Engine/iOS/DSXPathMatch.swift
// — extracted UIKit-free so the watch/keyboard RouteResolver compiles the same matcher.

// MARK: - JSE runtime library (crypto · core globals · regex · redact/trace)
// moved VERBATIM to OpenSource/Engine/iOS/JSELibrary.swift so satellite-node
// targets (watch - RUNTIME_TIERS 'logic') compile the same conformance-pinned
// semantics without this file. JSESocket below STAYS: surface-scoped
// (StackStore/UIView/Context), never part of a satellite node.

// MARK: - JSE · WebSocket (1:1) — keyed + surface-scoped (core networking, like fetch)
//
// The standard WebSocket shape with DSX lifecycle rules — the dev-plan contract:
//
//   const ws = new WebSocket(dsx.variable.socketUrl, { key: 'chat' })   // key optional (default = url)
//   ws.onopen    = () => { ws.send(JSON.stringify({ type: 'hello' })) }
//   ws.onmessage = e => { dsx.variable.messages.push(JSON.parse(e.data)) }
//   ws.onerror   = e => { dsx.variable.error = e.message }
//   ws.onclose   = e => { dsx.variable.connected = false }
//   ws.send('…') · ws.send(bytes) · ws.close([code, reason])
//
// Lifecycle (the product): SURFACE-SCOPED — sockets live on the StackStore like keyed
// timers and ALL close when the store deallocates (route changes never leak connections);
// KEYED — the same key replaces the previous socket, so naive re-runs can't double-connect.
// Text frames arrive as strings, binary as byte arrays (the crypto byte convention);
// `ws.send(bytes)` sends binary, anything else sends text (dicts JSON-stringify). No
// background guarantee — the task suspends/dies with the OS and `onclose` fires on return;
// long-lived background realtime (reconnect, presence, push fallback) is a PACKAGE.
// Reconnects are user-coded (`onclose` → keyed setTimeout — composes with the timer rules).
// Statement-only by design (it needs the surface's store/runner): `new WebSocket` in a
// `{{ }}` expression logs and yields null. The handle is a value dict ({ __socket, url });
// liveness is tracked by your own onopen/onclose state writes, not a readyState snapshot.

final class JSESocket: NSObject, URLSessionWebSocketDelegate {
    let url: String
    let key: String
    private var task: URLSessionWebSocketTask?
    // JSERunner is a STRUCT whose `store` is a strong class reference — holding a runner copy
    // here would cycle store → sockets → runner → store and the surface would never deinit.
    // So the socket holds the store WEAKLY plus the pieces to rebuild a runner at fire time;
    // when the store is gone, events are no-ops and deinit already closed us.
    private weak var store: StackStore?
    private weak var webView: UIView?
    private let scope: String?
    private weak var dsx: Context?
    private var handlers: [String: (param: String, body: String, item: [String: Any]?)] = [:]
    private var closedByUs = false

    init(url: String, key: String, store: StackStore, webView: UIView?, scope: String?, dsx: Context?) {
        self.url = url
        self.key = key
        self.store = store
        self.webView = webView
        self.scope = scope
        self.dsx = dsx
        super.init()
        guard let u = URL(string: url), let urlScheme = u.scheme?.lowercased(), urlScheme == "ws" || urlScheme == "wss" else {
            NSLog("[JSE socket] invalid url: %@", url)
            return
        }
        let t = URLSession.shared.webSocketTask(with: u)
        t.delegate = self                                   // task-level delegate: open/close callbacks
        task = t
        t.resume()
        receive()
    }

    /// Register (or replace) a handler — `open` / `message` / `error` / `close`. The
    /// registration-time scope is captured per handler, the closure contract timers use.
    func on(_ event: String, param: String, body: String, item: [String: Any]?) {
        handlers[event] = (param, body, item)
    }

    /// All handler/flag state is read on MAIN only (registration happens on main; receive +
    /// delegate callbacks arrive on session queues, so they hop before touching anything).
    private func fire(_ event: String, _ payload: [String: Any]) {
        if JSETrace.shared.enabled { JSETrace.shared.log("socket", "\(key) \(event)") }
        DispatchQueue.main.async { [weak self] in
            guard let self, let h = self.handlers[event], let store = self.store else { return }
            var handlerScope = h.item ?? [:]
            handlerScope[h.param] = payload
            let runner = JSERunner(store: store, webView: self.webView, scope: self.scope, dsx: self.dsx)
            runner.runSocketHandler(h.body, scope: handlerScope)
        }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let s): self.fire("message", ["data": s])
                case .data(let d):   self.fire("message", ["data": d.map { Double($0) }])
                @unknown default: break
                }
                self.receive()                              // re-arm for the next frame
            case .failure(let error):
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.closedByUs else { return }
                    self.fire("error", ["message": error.localizedDescription])
                    self.fire("close", ["code": Double(1006), "reason": error.localizedDescription, "wasClean": false])
                }
            }
        }
    }

    /// Text by default; a byte array sends a BINARY frame; dicts JSON-stringify (explicit
    /// `ws.send(JSON.stringify(x))` is the 1:1 spelling — this is the forgiving fallback).
    func send(_ value: Any?) {
        if let arr = value as? [Any], !arr.isEmpty, arr.allSatisfy({ JSE.number($0) != nil }),
           let d = JSECrypto.data(arr) {
            task?.send(.data(d)) { _ in }
            return
        }
        if let dict = value as? [String: Any] {
            let clean = JSECore.jsonSanitize(dict)
            if let data = try? JSONSerialization.data(withJSONObject: clean),
               let str = String(data: data, encoding: .utf8) {
                task?.send(.string(str)) { _ in }
                return
            }
        }
        task?.send(.string(JSE.string(value))) { _ in }
    }

    func close(code: Int = 1000, reason: String = "") {
        closedByUs = true
        task?.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure,
                     reason: reason.isEmpty ? nil : Data(reason.utf8))
        task = nil
    }

    // URLSessionWebSocketDelegate — open/close land here (task-level delegate)
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocolName: String?) {
        fire("open", [:])
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let payload: [String: Any] = ["code": Double(closeCode.rawValue),
                                      "reason": reason.flatMap { String(data: $0, encoding: .utf8) } ?? "",
                                      "wasClean": true]
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.closedByUs else { return }
            self.fire("close", payload)
        }
    }
}
