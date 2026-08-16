//
//  StackLive.swift - the Stack engine's EXTENSION-PROCESS render backend.
//
//  ONE grammar, a backend per surface. StackLive does NOT parse and does NOT
//  fork the language: it consumes the engine's shared AST (StackNode / StackXML)
//  and renders the subset a widget / Live-Activity process may legally run
//  (Apple forbids downloaded code, UIApplication and WebKit there; WidgetKit
//  wants a pure function of serialized state). The full in-app engine
//  (Stack.swift) is the interactive backend of the same grammar; Android renders
//  the same tags in Compose/Glance.
//
//  The element table IS the contract. A tag maps to a tiny `StackElement` whose
//  `body` describes only its own content - exactly the `tag` + `body(dsx)` shape
//  the in-app component registry uses. Adding `<gauge>` is registering one type,
//  never editing a switch; an Android backend implements the same table. The
//  uniform layout box (padding / background / radius / grow / opacity) and child
//  recursion are the backend's job, so elements stay declarative.
//
//  FAIL-OPEN everywhere: unparseable markup -> `parses` is false and the caller
//  shows its built-in view; an unknown tag renders nothing; a missing `{{ dsx.variable.x }}`
//  renders empty.
//

import SwiftUI

// MARK: - Injectable element table (so a surface can render a SUPERSET of tags)

// The active element table flows down the view tree as an environment value. Widgets /
// Live-Activities never set it and get `StackBackend.elements` (the WidgetKit-safe set) —
// byte-identical to before. A richer surface (the watchOS app, `StackWatch`) sets its own
// merged table at the root, so the SAME recursion renders its extra tags without touching
// this file's element registry. One grammar, a table per surface — the constitution's
// "register an element, never grow a switch", made injectable.
struct StackTableKey: EnvironmentKey {
    static let defaultValue: [String: StackElement.Type] = StackBackend.elements
}
extension EnvironmentValues {
    var stackTable: [String: StackElement.Type] {
        get { self[StackTableKey.self] }
        set { self[StackTableKey.self] = newValue }
    }
}

// MARK: - Entry point

/// Render a DSX layout string in a variable scope. Callers gate on `parses`
/// and fall back to their own view when it is false.
struct StackLive: View {
    let root: StackNode?
    let scope: StackScope

    init(layout: String, vars: [String: String]) {
        self.root = StackXML.parse(layout, platformTarget: StackPlatformAttrs.runtimeTarget)
        self.scope = StackScope(vars: vars)
    }

    /// Render an already-parsed node (a slot of a `StackActivity` document, so
    /// the document is parsed once and its slots rendered without re-parsing).
    init(node: StackNode?, vars: [String: String]) {
        self.root = node
        self.scope = StackScope(vars: vars)
    }

    static func parses(_ layout: String) -> Bool {
        !layout.isEmpty && StackXML.parse(layout) != nil
    }

    var body: some View {
        if let root = root {
            StackLiveNodeView(node: root, scope: scope)
        }
    }
}

/// Renders one node and its subtree. Recursion lives here so elements never
/// need to know about the backend. `visibilityChecked` marks a node whose
/// `visible-if` was ALREADY evaluated by a filtering call site (StackBackend.children,
/// the watch's WatchListView rows) so render skips the re-evaluation — one cond
/// evaluation per conditional node per pass. Direct callers leave the default.
struct StackLiveNodeView: View {
    let node: StackNode
    let scope: StackScope
    var visibilityChecked = false
    @Environment(\.stackTable) private var table
    var body: some View {
        StackBackend.render(node, in: scope, table: table, visibilityChecked: visibilityChecked)
    }
}

// MARK: - The backend: element registry + recursion

enum StackBackend {
    /// The cross-platform contract. Register an element; never grow a switch.
    /// list/scroll/divider live HERE (not per surface): on every snapshot surface a
    /// `list` is a styled vstack (dynamic rows were expanded by the phone before the
    /// layout shipped), `scroll` lays out vertically (the surface root owns any real
    /// scrolling), and `divider` is a one-liner — one implementation, every tier.
    static let elements: [String: StackElement.Type] = {
        var t: [String: StackElement.Type] = [
            LiveVStackElement.tag:    LiveVStackElement.self,
            LiveHStackElement.tag:    LiveHStackElement.self,
            LiveZStackElement.tag:    LiveZStackElement.self,
            GenericStackElement.tag: GenericStackElement.self,
            LiveTextElement.tag:      LiveTextElement.self,
            CountdownElement.tag: CountdownElement.self,
            LiveImageElement.tag:     LiveImageElement.self,
            LiveProgressElement.tag:  LiveProgressElement.self,
            GaugeElement.tag:     GaugeElement.self,
            LiveSpacerElement.tag:    LiveSpacerElement.self,
            LiveListElement.tag:      LiveListElement.self,
            LiveScrollElement.tag:    LiveScrollElement.self,
            LiveDividerElement.tag:   LiveDividerElement.self,
        ]
        #if canImport(AppIntents) && !os(watchOS)
        // The snapshot <button> (compiled interactions) — declared under the same gate below.
        // Registered in the BASE table so widget/Live-Activity surfaces render it (the Kotlin
        // twin's shared table registers it unconditionally); the element itself degrades to an
        // inert label below iOS 17. The watch table shadows this with its own richer button —
        // and watchOS is excluded here outright: LiveActivityIntent doesn't exist there
        // (AppIntents itself does, so canImport alone is not a watch gate).
        t[LiveButtonElement.tag] = LiveButtonElement.self
        #endif
        return t
    }()

    /// Dispatch a node to its element, then wrap it in the uniform layout box —
    /// unless the element declares it OWNS its box (`ownsLayoutBox`): a keyboard key
    /// draws its own cap/background/shadow, and the generic box re-consuming the same
    /// `bg`/`radius` attributes would paint a square slab behind the rounded cap and
    /// clip the cap's under-edge shadow away.
    /// `table` defaults to the WidgetKit-safe registry; a surface passes its own
    /// (the watch app passes `StackWatch.elements`) so child recursion — which reads
    /// the table from the environment — renders the surface's full vocabulary.
    /// `visibilityChecked`: the filtering call sites (children below, the watch List's
    /// rows) evaluated `visible-if` already — pass true to skip the guard's
    /// RE-evaluation (each conditional node evaluates once per pass). The default
    /// keeps the guard: for a DIRECT render (a surface root) it is the ONLY check,
    /// and the fail-open semantics are unchanged.
    static func render(_ node: StackNode, in scope: StackScope,
                       table: [String: StackElement.Type] = elements,
                       visibilityChecked: Bool = false) -> AnyView {
        guard visibilityChecked || visible(node, in: scope) else { return AnyView(EmptyView()) }
        let reader = StackReader(node: node, scope: scope)
        guard let element = table[node.tag] else {
            return AnyView(EmptyView().modifier(StackLayoutBox(reader: reader)))
        }
        let content = element.body(reader)
        guard !element.ownsLayoutBox else { return content }
        return AnyView(content.modifier(StackLayoutBox(reader: reader)))
    }

    /// `visible-if`, honored wherever a surface installed the condition seam
    /// (`StackScope.cond` — the watch: full JSE on the wrist, watch-runtime.md's
    /// documented wrist surface). Snapshot surfaces never install it, so widgets /
    /// Live Activities render every node exactly as before (fail-open by construction).
    static func visible(_ node: StackNode, in scope: StackScope) -> Bool {
        guard let cond = node.attrs["visible-if"], !cond.isEmpty,
              let test = scope.cond else { return true }
        return test(cond)
    }

    /// Render a node's children in order (used by the container elements). A child hidden
    /// by `visible-if` is skipped HERE (not rendered empty), so stack spacing never
    /// reserves a slot for it — inert without the seam (visible is then always true).
    /// The rendered child carries `visibilityChecked` so render never re-evaluates the
    /// condition this filter just evaluated.
    @ViewBuilder static func children(of node: StackNode, in scope: StackScope) -> some View {
        ForEach(Array(node.children.enumerated()), id: \.offset) { _, child in
            if visible(child, in: scope) {
                StackLiveNodeView(node: child, scope: scope, visibilityChecked: true)
            }
        }
    }

    /// The ONE column-axis predicate the snapshot tiers share (the watch's spine
    /// detection, the generic `<stack>` element below, StackWidgetKit's `stack` case —
    /// three drifted copies folded): `vstack`/`scroll` are columns; a generic `stack`
    /// is a column unless `display="grid"` or a row `flexDirection` steers it.
    /// PRIMITIVES in (tag + the two steering strings), because the callers differ in
    /// node model and resolution: StackWidgetKit has its own StackWNode, the watch
    /// spine reads RAW attrs, and GenericStackElement passes its RESOLVED strings —
    /// resolution stays the caller's job. (Stack.swift's two in-app variants are
    /// deliberately un-migrated — the app tier resolves through its CSS engine.)
    static func isColumn(tag: String, display: String?, flexDirection: String?) -> Bool {
        if tag == "vstack" || tag == "scroll" { return true }
        return tag == "stack" && display != "grid"
            && !(flexDirection?.hasPrefix("row") ?? false)
    }
}

// MARK: - Element contract

/// One DSX tag's render. `body` describes only the element's own content; the
/// backend applies the shared layout box and drives child recursion. An element
/// that renders its own box (background/radius/shadow — e.g. a keyboard key cap)
/// opts out of the shared one with `ownsLayoutBox`.
protocol StackElement {
    static var tag: String { get }
    static var ownsLayoutBox: Bool { get }
    static func body(_ r: StackReader) -> AnyView
}

extension StackElement {
    static var ownsLayoutBox: Bool { false }
}

/// The layout box every node carries: padding, background, corner radius,
/// width-grow and opacity - read uniformly so each element stays focused.
struct StackLayoutBox: ViewModifier {
    let reader: StackReader
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, reader.cgFloat("paddingh", reader.cgFloat("padding", 0)))
            .padding(.vertical, reader.cgFloat("paddingv", reader.cgFloat("padding", 0)))
            .frame(maxWidth: reader.growsWidth ? .infinity : nil, alignment: boxAlignment)
            .background(reader.string("bg").map(StackColor.parse) ?? Color.clear)
            .cornerRadius(reader.cgFloat("radius", 0))
            .opacity(reader.double("opacity", 1))
    }

    /// The grown frame's content anchor — the in-app engine's WEB-TRUE law
    /// (Stack.swift `flexFrame`), applied to the snapshot box: UNSTEERED content
    /// in a `grow="width"` frame pins to the LEADING edge (CSS block flow /
    /// flex-start), never SwiftUI's centering default — so on an activity card
    /// every grown row shares the card's one left inset with its siblings instead
    /// of floating mid-card (the lock-screen "inconsistent insets" symptom).
    /// Steering still wins (`align="leading|trailing|center"`), and a <button>
    /// keeps the UA centering (every browser centers a button label — the same
    /// exception the app tier carves). The VERTICAL component stays `.center`:
    /// the snapshot frame is width-only, so it engages ONLY when a surface hands
    /// the box extra height (an imposed activity-card height) — and there the
    /// balanced middle, never a top-pinned block over dead space, is the
    /// lock-screen look. (`reader.frameAlignment`'s center default remains the
    /// grid/overlay-axis semantic — GenericStackElement — unchanged.)
    private var boxAlignment: Alignment {
        switch reader.string("align") ?? "" {
        case "leading", "left":   return .leading
        case "trailing", "right": return .trailing
        case "center":            return .center
        default:                  return reader.node.tag == "button" ? .center : .leading
        }
    }
}

// MARK: - Elements (one tag each)

enum LiveVStackElement: StackElement {
    static let tag = "vstack"
    static func body(_ r: StackReader) -> AnyView {
        AnyView(VStack(alignment: r.horizontalAlignment, spacing: r.cgFloat("spacing", 4)) {
            StackBackend.children(of: r.node, in: r.scope)
        })
    }
}

enum LiveHStackElement: StackElement {
    static let tag = "hstack"
    static func body(_ r: StackReader) -> AnyView {
        AnyView(HStack(alignment: r.verticalAlignment, spacing: r.cgFloat("spacing", 6)) {
            StackBackend.children(of: r.node, in: r.scope)
        })
    }
}

enum LiveZStackElement: StackElement {
    static let tag = "zstack"
    static func body(_ r: StackReader) -> AnyView {
        AnyView(ZStack { StackBackend.children(of: r.node, in: r.scope) })
    }
}

/// `<stack>` — the generic container. Snapshot surfaces have no CSS engine, so
/// the axis comes from the plain `flexDirection` attribute (the phone renderer
/// resolves `flex-direction:`/gap CSS into these same attribute names); column
/// is the default, and gap defaults to 0 (web-true), unlike the legacy stacks.
enum GenericStackElement: StackElement {
    static let tag = "stack"
    static func body(_ r: StackReader) -> AnyView {
        let spacing = r.cgFloat("spacing", 0)
        let display = r.string("display")
        if display == "grid" {
            return AnyView(ZStack(alignment: r.frameAlignment) {
                StackBackend.children(of: r.node, in: r.scope)
            })
        }
        // The shared axis predicate (StackBackend.isColumn) over the RESOLVED strings —
        // this element interpolates its attributes; resolution stays here.
        if StackBackend.isColumn(tag: r.node.tag, display: display,
                                 flexDirection: r.string("flexDirection")) {
            return AnyView(VStack(alignment: r.horizontalAlignment, spacing: spacing) {
                StackBackend.children(of: r.node, in: r.scope)
            })
        }
        return AnyView(HStack(alignment: r.verticalAlignment, spacing: spacing) {
            StackBackend.children(of: r.node, in: r.scope)
        })
    }
}

enum LiveTextElement: StackElement {
    static let tag = "text"
    static func body(_ r: StackReader) -> AnyView {
        AnyView(Text(r.text)
            .font(.system(size: r.cgFloat("size", 13), weight: r.fontWeight))
            .foregroundColor(r.color("color", .primary))
            .lineLimit(Int(r.cgFloat("lines", 1))))
    }
}

/// The LIVE TOKEN element (watch-runtime.md §Snapshot nodes): a countdown the OS RENDERS
/// AND TICKS with zero process executions — the one form of "dynamic" a snapshot node
/// (widget / Live Activity / Dynamic Island) can carry, because the ticking is the
/// system's, not ours. `until` = epoch seconds or ISO-8601; past deadlines pin at zero.
/// Styled like text (size/weight/color). Compose twin: StackLiveRender.Countdown.
enum CountdownElement: StackElement {
    static let tag = "countdown"
    static func body(_ r: StackReader) -> AnyView {
        let end = parseUntil(r.string("until") ?? "")
        let start = min(Date(), end)
        return AnyView(Text(timerInterval: start...end, countsDown: true)
            .font(.system(size: r.cgFloat("size", 13), weight: r.fontWeight))
            .foregroundColor(r.color("color", .primary))
            .monospacedDigit()
            .lineLimit(1))
    }
    static func parseUntil(_ raw: String) -> Date {
        let s = raw.trimmingCharacters(in: .whitespaces)
        if let epoch = Double(s), epoch > 0 { return Date(timeIntervalSince1970: epoch) }
        // Two ISO passes — Foundation's ISO8601DateFormatter rejects fractional seconds
        // unless asked (the parseDateMS twins pin the same dance); the Kotlin twin's
        // Instant.parse accepts both shapes, so both passes are owed here for 1:1.
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: s) { return d }
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: s) { return d }
        return Date()   // unparsable → an already-elapsed countdown (0:00), never a crash
    }
}

enum LiveImageElement: StackElement {
    static let tag = "image"
    static func body(_ r: StackReader) -> AnyView {
        AnyView(Image(systemName: r.string("symbol") ?? "circle")
            .font(.system(size: r.cgFloat("size", 16)))
            .foregroundColor(r.color("color", .accentColor)))
    }
}

/// `<progress>` — the SAME height-bounded capsule bar the in-app engine
/// (Basics/Progress `ProgressElement`) and the widget backend (StackWidgetKit
/// `capsuleProgress`) draw: track at 20% tint, fill measured off the proposed
/// width, the whole bar pinned to `height` (default 6 — the app tier's attribute
/// and default). NEVER the bare system `ProgressView(value:)` here: on the
/// Live-Activity lock-screen sizing pass the OS-resolved bar reported a greedy
/// height, so the CARD was sized taller than the rows actually drew and the
/// content sat top-pinned over dead space (the "bottom third empty" field bug).
/// Bounded by construction, the card hugs its content again. `tint` stays the
/// live-surface spelling; the app/widget `color` spelling is honored beneath it
/// so one markup renders 1:1 across tiers.
enum LiveProgressElement: StackElement {
    static let tag = "progress"
    static func body(_ r: StackReader) -> AnyView {
        let v = CGFloat(r.unit("value"))
        let tint = r.color("tint", r.color("color", .accentColor))
        return AnyView(GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(tint.opacity(0.2))
                Capsule().fill(tint).frame(width: g.size.width * v)
            }
        }
        .frame(height: r.cgFloat("height", 6)))
    }
}

enum GaugeElement: StackElement {
    static let tag = "gauge"
    static func body(_ r: StackReader) -> AnyView {
        let diameter = r.cgFloat("size2", r.cgFloat("diameter", 38))
        let line = r.cgFloat("line", 2.5)
        // The ring is INSET by half the stroke: a stroke straddles the path, so an
        // un-inset Circle() (which fills the frame) pokes line/2 outside it on every
        // side — and activity/widget slots hard-clip to bounds, cutting the ring by
        // 1–2px all around. Inset keeps the full stroke inside `diameter`.
        return AnyView(ZStack {
            Circle().inset(by: line / 2)
                .stroke(r.color("track", Color.accentColor.opacity(0.15)), lineWidth: line)
            Circle().inset(by: line / 2)
                .trim(from: 0, to: CGFloat(r.unit("value")))
                .stroke(r.color("tint", .accentColor), style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(r.text)
                .font(.system(size: r.cgFloat("size", 9), weight: .bold))
                .foregroundColor(r.color("tint", .accentColor))
        }
        .frame(width: diameter, height: diameter))
    }
}

enum LiveSpacerElement: StackElement {
    static let tag = "spacer"
    static func body(_ r: StackReader) -> AnyView { AnyView(Spacer(minLength: 0)) }
}

/// `list` on a snapshot surface is a styled vertical stack: the dynamic rows were
/// already expanded into children by the phone before the layout was shipped (the
/// snapshot model), so there is no in-process binding to evaluate. Same tag, 1:1
/// with the in-app `<list>`. (Hoisted from the watch table — every tier renders it.)
enum LiveListElement: StackElement {
    static let tag = "list"
    static func body(_ r: StackReader) -> AnyView {
        AnyView(VStack(alignment: r.horizontalAlignment, spacing: r.cgFloat("spacing", 6)) {
            StackBackend.children(of: r.node, in: r.scope)
        })
    }
}

/// `scroll` is a passthrough container on snapshot surfaces: the surface root owns
/// any real scrolling (the watch's StackWatchView provides the one ScrollView), so
/// a `<scroll>` lays its children out vertically instead of dropping the subtree.
enum LiveScrollElement: StackElement {
    static let tag = "scroll"
    static func body(_ r: StackReader) -> AnyView {
        AnyView(VStack(alignment: r.horizontalAlignment, spacing: r.cgFloat("spacing", 4)) {
            StackBackend.children(of: r.node, in: r.scope)
        })
    }
}

enum LiveDividerElement: StackElement {
    static let tag = "divider"
    static func body(_ r: StackReader) -> AnyView {
        // Default is a FAINT rule (secondary at 25%), not full secondary: on the
        // watch's OLED black a solid grey bar reads as a harsh white line. The
        // phone renderer's divider uses the system separator for the same reason;
        // this is the snapshot twin of that choice (Kotlin: StackColor.DIVIDER).
        // `color=` still overrides for an intentionally strong rule.
        AnyView(
            Rectangle()
                .fill(r.color("color", Color.secondary.opacity(0.25)))
                .frame(height: 0.5)
                .frame(maxWidth: .infinity)
                .accessibilityHidden(true)
        )
    }
}

// MARK: - COMPILED INTERACTIONS (watch-runtime.md §Snapshot nodes, LANDED)
//
// A snapshot button's `on:tap` is ONE literal `dsx.module.<scheme>.<action>({json?})` call —
// no JSE in the node, ever. The parse below is that single shape (the JSEActions
// parseModuleCall's snapshot twin, deliberately smaller); the per-role capability table
// (capabilities.json, baked into the extension bundle by generate_node_capabilities) gates
// which calls render as INTERACTIVE at all. Execution:
//   • Live Activities → DSXActivityCallIntent (LiveActivityIntent: the OS runs perform()
//     IN THE APP PROCESS, launching it in the background if needed) → the bus, directly.
//   • Widgets → DSXWidgetCallIntent (AppIntent: runs in the EXTENSION process) → the call
//     is queued in the App Group + a Darwin notification pokes the app; the app drains at
//     launch/foreground/poke (DSXBoot installs the drain). Coalesce-free FIFO, cap 32.
// An unadmitted or unparsable on:tap renders the button INERT (label only) — fail-open
// display, never a silent capability escalation.

/// The node-side call plumbing: the parser, the capability gate, the queue, and the
/// app-side seam. Foundation-only; the APP installs `invoke` at boot (extensions leave it
/// nil and queue instead).
public enum DSXNodeCalls {
    /// Installed by DSXBoot with the real bus dispatch. nil in extension processes.
    public static var invoke: ((String, String, [String: Any]) -> Void)?

    public static let queueKey = "dsx.node.calls"
    public static let darwinName = "despia.dsx.node.calls"

    /// The one snapshot call shape: `dsx.module.<scheme>.<action>()` / `({literal json})`.
    public static func parse(_ handler: String) -> (scheme: String, action: String, args: [String: Any])? {
        let s = handler.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.hasPrefix("dsx.module.") else { return nil }
        let after = s.dropFirst("dsx.module.".count)
        guard let paren = after.firstIndex(of: "(") else { return nil }
        // Keep empty subsequences so `toast..show` FAILS the isEmpty guard (a typo is inert,
        // never reinterpreted) — the Kotlin twin's split keeps empties the same way.
        // Depth is UNBOUNDED past two segments: a nested chain spelling
        // (`dsx.module.watch.health.workout(...)`) parses whole — scheme = head, action =
        // the dotted remainder; the dispatch funnel's fold resolves identity-vs-action
        // (ChainResolver, Conformance/chains), never this parser.
        let chain = after[..<paren].split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard chain.count >= 2, chain.allSatisfy({ !$0.isEmpty }) else { return nil }
        var inner = String(after[after.index(after: paren)...])
        guard let close = inner.lastIndex(of: ")") else { return nil }
        // NOTHING may follow the call (an optional single `;` aside) — `…show(); x=1`
        // must be refused whole, never silently truncated to the call.
        var tail = String(inner[inner.index(after: close)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        if tail.hasPrefix(";") { tail = String(tail.dropFirst()).trimmingCharacters(in: .whitespaces) }
        guard tail.isEmpty else { return nil }
        inner = String(inner[..<close]).trimmingCharacters(in: .whitespacesAndNewlines)
        var args: [String: Any] = [:]
        if !inner.isEmpty {
            // LITERAL JSON only (single quotes tolerated) — statically checkable, no JSE.
            let json = inner.replacingOccurrences(of: "'", with: "\"")
            guard let data = json.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
            args = obj
        }
        // scheme = head, action = the DOTTED REMAINDER (all segments after the first) —
        // the gate key "\(scheme).\(action)" is then the full authored spelling
        // ("watch.health.workout"), exactly what the baked role tables carry.
        return (chain[0], chain.dropFirst().joined(separator: "."), args)
    }

    /// The ONE decoder of the generated `{relay:[…]}` capability artifact — every consumer
    /// (this bundle's table below, the watch effects, WatchBridge's host copy) parses through
    /// it, so the payload schema has exactly one reader. Fail-closed: no file, nothing relays.
    public static func loadTable(resource: String = "capabilities") -> Set<String> {
        guard let url = Bundle.main.url(forResource: resource, withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let list = obj["relay"] as? [String] else { return [] }
        return Set(list)
    }

    /// The role table baked into THIS bundle (extension or app) — fail-closed (watch law).
    public static let relayTable: Set<String> = loadTable()

    /// The App-Group suite shared with the app — DERIVED, never hardcoded (Container.groupID's
    /// convention, `group.${APP_BUNDLE_ID}.container`; the CI bundle-id rewrite never touches
    /// OpenSource, so a literal here would split the queue from the drain on every white-label
    /// build). In an extension (.appex) the app's id is this bundle's id minus its last
    /// segment; the template literal survives only as the empty-id fallback.
    public static var defaultAppGroup: String {
        var id = Bundle.main.bundleIdentifier ?? ""
        if Bundle.main.bundleURL.pathExtension == "appex", let dot = id.lastIndex(of: ".") {
            id = String(id[..<dot])
        }
        return id.isEmpty ? "group.com.despia.despiaadmin.container" : "group.\(id).container"
    }

    /// Execute (app process) or queue + poke (extension process).
    public static func perform(scheme: String, action: String, args: [String: Any],
                               appGroup: String = DSXNodeCalls.defaultAppGroup) {
        if let invoke {
            invoke(scheme, action, args)
            return
        }
        guard let d = UserDefaults(suiteName: appGroup) else { return }
        var queue = (d.array(forKey: queueKey) as? [[String: Any]]) ?? []
        queue.append(["scheme": scheme, "action": action, "args": args,
                      "at": Date().timeIntervalSince1970])
        if queue.count > 32 { queue.removeFirst(queue.count - 32) }
        d.set(queue, forKey: queueKey)
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(darwinName as CFString), nil, nil, true)
    }

    /// The app-side drain (DSXBoot: launch, foreground, Darwin poke). FIFO through `invoke`.
    public static func drain(appGroup: String) {
        guard let invoke, let d = UserDefaults(suiteName: appGroup) else { return }
        let queue = (d.array(forKey: queueKey) as? [[String: Any]]) ?? []
        guard !queue.isEmpty else { return }
        d.set([], forKey: queueKey)
        for call in queue {
            guard let s = call["scheme"] as? String, let a = call["action"] as? String else { continue }
            invoke(s, a, (call["args"] as? [String: Any]) ?? [:])
        }
    }
}

#if canImport(AppIntents) && !os(watchOS)
// watchOS gate: AppIntents EXISTS on watchOS (canImport passes) but LiveActivityIntent
// does not — the watch target compiles this file for DSXNodeCalls/StackLive and takes
// interactions through its own richer button in the watch table instead.
import AppIntents

/// The Live-Activity button's intent — LiveActivityIntent runs IN THE APP PROCESS
/// (background-launching it if needed), so the bus call is direct; the queue is only the
/// no-boot fallback. NO table re-check here: the capability gate already ran at RENDER
/// time in the extension (LiveButtonElement — the only constructor of this intent), and
/// the APP bundle carries no capabilities.json (the generator writes extension-dir copies
/// the app target excepts), so an app-side lookup would fail closed and swallow every
/// admitted tap — the same trust model as the widget queue's drain.
@available(iOS 17.0, *)
public struct DSXActivityCallIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource { "DSX action" }
    @Parameter(title: "Scheme") public var scheme: String
    @Parameter(title: "Action") public var action: String
    @Parameter(title: "Args") public var argsJSON: String
    public init() {}
    public init(scheme: String, action: String, argsJSON: String) {
        self.scheme = scheme; self.action = action; self.argsJSON = argsJSON
    }
    public func perform() async throws -> some IntentResult {
        let args = (argsJSON.data(using: .utf8)
            .flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
        DSXNodeCalls.perform(scheme: scheme, action: action, args: args)
        return .result()
    }
}

/// The widget button's intent — runs in the widget EXTENSION; always queues + pokes.
@available(iOS 17.0, *)
public struct DSXWidgetCallIntent: AppIntent {
    public static var title: LocalizedStringResource { "DSX action" }
    @Parameter(title: "Scheme") public var scheme: String
    @Parameter(title: "Action") public var action: String
    @Parameter(title: "Args") public var argsJSON: String
    public init() {}
    public init(scheme: String, action: String, argsJSON: String) {
        self.scheme = scheme; self.action = action; self.argsJSON = argsJSON
    }
    public func perform() async throws -> some IntentResult {
        let args = (argsJSON.data(using: .utf8)
            .flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
        guard DSXNodeCalls.relayTable.contains("\(scheme).\(action)") else { return .result() }
        DSXNodeCalls.perform(scheme: scheme, action: action, args: args)
        return .result()
    }
}

/// The snapshot button (live/activity tiers; StackWatch's own button SHADOWS this in the
/// watch table by the last-writer-wins merge, unchanged). Interactive ONLY when its
/// on:tap parses as the one literal call shape AND the bundle's role table admits it —
/// else the label renders inert.
enum LiveButtonElement: StackElement {
    static let tag = "button"
    static func body(_ r: StackReader) -> AnyView {
        let label = Text(r.string("label") ?? r.text)
            .font(.system(size: r.cgFloat("size", 13), weight: r.fontWeight))
            .foregroundColor(r.color("color", .primary))
        guard #available(iOS 17.0, *),
              let handler = r.node.attrs["on:tap"],
              let call = DSXNodeCalls.parse(handler),
              DSXNodeCalls.relayTable.contains("\(call.scheme).\(call.action)") else {
            return AnyView(label)
        }
        let argsJSON = (try? JSONSerialization.data(withJSONObject: call.args))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let isActivity = r.node.attrs["intent"] == "activity"
        if isActivity {
            return AnyView(Button(intent: DSXActivityCallIntent(
                scheme: call.scheme, action: call.action, argsJSON: argsJSON)) { label })
        }
        return AnyView(Button(intent: DSXWidgetCallIntent(
            scheme: call.scheme, action: call.action, argsJSON: argsJSON)) { label })
    }
}
#endif
