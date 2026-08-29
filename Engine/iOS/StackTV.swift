//
//  StackTV.swift - the Stack engine's tvOS render backend.
//
//  ONE grammar, a backend per surface (StackNode.swift header). StackTV is the
//  tvOS sibling of `StackWatch`: it consumes the same shared AST (StackNode /
//  StackXML / StackScope) and renders the subset that reads NICELY from ten feet,
//  while staying inside the kernel-product rules (rule 8: no UIKit, no WebKit —
//  pure SwiftUI over serialized state, which is also exactly what a tvOS process
//  wants; tvOS ships NO WebKit at all, so this surface is always native DSX —
//  the web-optional runtime's purest case, tv-runtime.md). The full in-app engine
//  (Stack.swift) is the phone's interactive backend of the same grammar; Android
//  TV renders the same tags in Compose (StackTv.kt, the :tv module).
//
//  It REUSES StackLive's element registry and recursion verbatim and ADDS the
//  TV-interactive tags on top (`button`, `toggle`/`switch`) plus a TV `text`
//  override (the 10-foot type ramp) - so a `.dsx` authored once is 1:1 across
//  iOS / watchOS / tvOS / Android. The element table is injected through the
//  environment (StackLive's `stackTable`), so child recursion renders this
//  superset without forking StackLive.
//
//  FOCUS IS THE SYSTEM'S (tv-runtime.md — no new grammar words this tier): the
//  SwiftUI focus engine drives Button/Toggle natively — the platform highlight,
//  D-pad/remote traversal, parallax — with nothing authored. Focus grammar
//  (autofocus, focus groups) is authoring surface and lands corpus-first later.
//
//  SYSTEM DEFAULTS (system-defaults.md — defaults live in the RENDERER): an
//  element with NO author styles renders tvOS's own system component, and every
//  authored attribute keeps working ABOVE the defaults (the ladder):
//   • `list`  → a REAL SwiftUI `List` when the screen's SPINE is an unstyled
//     list (TVListSpine below — the WatchListSpine gate word-for-word, drift
//     pinned in both headers until the style-catalog TV gate lands). Rows whose
//     root is interactive drop the double chrome exactly like the wrist.
//   • `text`  → the system type ramp: no font/color/lineLimit modifiers at all
//     when unstyled (inherits tvOS's body ramp + semantic label color + wraps).
//     ANY authored text attribute renders the full authored path with the TV
//     ramp's own base (29pt body — the wrist's 13pt would vanish at ten feet;
//     a renderer's defaults are its own by law) above the authored values.
//   • `button`→ tvOS's own focusable system button (the platform default style —
//     inherited, never re-specified, so it self-updates with the OS). `tint`
//     applies only when authored; `bg`/`radius` eject to the custom layout-box
//     path. Inside a List row the row IS the button: plain style, leading
//     label, full-row focus target.
//   • `toggle` (alias `switch`) → the native Toggle: `bind="key"` reads the
//     store truthily via the cond seam; a flip writes SYNCHRONOUSLY through the
//     store-write seam and ONLY the `on:change` body rides the action runner
//     (the write-window fix, StackWatch verbatim).
//   • DEFERRED (pinned): the `variant=`/`role=` system words are NOT yet
//     consumed here (the wrists' deferral, shared); the unstyled system look is
//     the only system rendering this tier picks.
//
//  FULL JSE ON THE TV: the TV target compiles the `logic` tier, so `{{ … }}`
//  spans evaluate through the REAL evaluator (StackScope.expr installed below)
//  and `visible-if` gates through real value truthiness. Statements/actions ride
//  the runner seam; taps without a runner emit names only (snapshot behavior).
//
//  A tapped element does two surface-boundary-safe things, NEVER running code:
//   - `route="/x"`  -> navigate the TV's own router locally (offline screens).
//   - `event="x"` / `on:tap="…"` -> the runner (installed) or the name relay.
//  FAIL-OPEN throughout, exactly like StackLive.
//

import SwiftUI

// MARK: - Tap dispatch (names out, no code) — per-backend seams, the StackKeys precedent

/// The closure a tapped element calls with its event name. The TV app injects its
/// handler (kernel-event fan-out is local — there is no companion link on a TV).
struct StackTVEmitKey: EnvironmentKey {
    static let defaultValue: (String) -> Void = { _ in }
}
/// The closure a tapped element calls with a `route` to navigate the TV LOCALLY,
/// so a bundled multi-screen app works fully offline.
struct StackTVNavigateKey: EnvironmentKey {
    static let defaultValue: (String) -> Void = { _ in }
}
/// The FULL-GRAMMAR action runner: the TV app installs TvRuntime.run, so a raw
/// `on:tap` body executes the portable statement grammar in-process. nil keeps
/// the name-scan relay behavior (plain snapshots).
struct StackTVRunKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}
/// The SYNCHRONOUS store-write seam (the toggle's `bind` write) — the TV app
/// installs TvRuntime.setVar; nil renders toggles disabled (fail-open display).
struct StackTVSetVarKey: EnvironmentKey {
    static let defaultValue: ((String, Any) -> Void)? = nil
}
/// True while rendering a DIRECT row of the TV List whose row root is an
/// interactive tag: the row platter is the control (no second chrome inside).
struct StackTVListRowKey: EnvironmentKey {
    static let defaultValue = false
}
extension EnvironmentValues {
    var stackTVEmit: (String) -> Void {
        get { self[StackTVEmitKey.self] }
        set { self[StackTVEmitKey.self] = newValue }
    }
    var stackTVNavigate: (String) -> Void {
        get { self[StackTVNavigateKey.self] }
        set { self[StackTVNavigateKey.self] = newValue }
    }
    var stackTVRun: ((String) -> Void)? {
        get { self[StackTVRunKey.self] }
        set { self[StackTVRunKey.self] = newValue }
    }
    var stackTVSetVar: ((String, Any) -> Void)? {
        get { self[StackTVSetVarKey.self] }
        set { self[StackTVSetVarKey.self] = newValue }
    }
    var stackTVListRow: Bool {
        get { self[StackTVListRowKey.self] }
        set { self[StackTVListRowKey.self] = newValue }
    }
}

// MARK: - Entry point

/// Render a DSX layout string for the TV. A screen whose spine is an unstyled
/// `<list>` renders as ONE real List (the system default look — focus-driven
/// rows, the List owns scrolling); every other screen keeps a single ScrollView
/// root. The TV element table and the tap/route seams install once at the root.
struct StackTVView: View {
    let root: StackNode?
    let spine: TVListSpine?
    let scope: StackScope
    let emit: (String) -> Void
    let navigate: (String) -> Void
    let run: ((String) -> Void)?
    let set: ((String, Any) -> Void)?

    /// One-entry parse memo (StackWatchView verbatim): the view is reconstructed
    /// on EVERY store change with the SAME layout string — re-parsing per tick is
    /// pure waste, and so is re-walking for the list SPINE. Main-thread only.
    private static var lastLayout = ""
    private static var lastRoot: StackNode?
    private static var lastSpine: TVListSpine?
    private static func parsed(_ layout: String) -> (root: StackNode?, spine: TVListSpine?) {
        if layout != lastLayout {
            let root = StackXML.parse(layout)
            lastLayout = layout
            lastRoot = root
            lastSpine = root.flatMap(TVListSpine.find)
        }
        return (lastRoot, lastSpine)
    }

    init(layout: String, vars: [String: String],
         state: (any JSEState)? = nil,
         run: ((String) -> Void)? = nil,
         set: ((String, Any) -> Void)? = nil,
         emit: @escaping (String) -> Void = { _ in },
         navigate: @escaping (String) -> Void = { _ in }) {
        (self.root, self.spine) = Self.parsed(layout)
        // FULL JSE ON THE TV: this target compiles the `logic` tier, so every
        // `{{ … }}` span evaluates through the real, corpus-pinned evaluator.
        // Reserved app namespaces (`global.*` etc.) read through nil seams here
        // and fail open — the TV's app state lives in its own store vars.
        let jse: any JSEState = state ?? JSEVars(vars.reduce(into: [String: Any]()) { $0[$1.key] = $1.value })
        var scope = StackScope(vars: vars)
        scope.expr = { e in JSE.string(JSE.eval(e, store: jse, item: nil)) }
        scope.cond = { e in JSE.truthy(JSE.eval(e, store: jse, item: nil)) }
        self.scope = scope
        self.run = run
        self.set = set
        self.emit = emit
        self.navigate = navigate
    }

    static func parses(_ layout: String) -> Bool {
        !layout.isEmpty && StackXML.parse(layout) != nil
    }

    var body: some View {
        Group {
            // The spine is STRUCTURAL (memoized per layout); its VISIBILITY is
            // scope-dependent, so the root's and the list's `visible-if` gate
            // here, per render pass (the StackWatchView fix, inherited).
            if let root = root, let spine = spine,
               StackBackend.visible(root, in: scope),
               StackBackend.visible(spine.list, in: scope) {
                TVListView(spine: spine, scope: scope)
            } else {
                ScrollView {
                    if let root = root {
                        StackLiveNodeView(node: root, scope: scope)
                    }
                }
            }
        }
        .environment(\.stackTable, StackTV.elements)
        .environment(\.stackTVEmit, emit)
        .environment(\.stackTVNavigate, navigate)
        .environment(\.stackTVRun, run)
        .environment(\.stackTVSetVar, set)
    }
}

// MARK: - The list spine (system-defaults: an unstyled <list> IS the screen's List)

/// The screen's list spine — WatchListSpine's contract on the TV: the root (or
/// the root column container's direct child) `<list>`, with flow siblings as
/// header/footer rows. Detection is SHALLOW, STRUCTURAL (memoized per layout)
/// and STYLE-GATED: an authored look ANYWHERE on the spine — the list, the
/// root, a ROW, or a riding sibling — or a data-bound list ejects the WHOLE
/// spine to the hand-drawn stack path (the ladder: the author's custom look
/// always wins over the system component). The gate's word set is pinned to
/// StackWatch's (one spine law, every surface — the TV row in the style-gate
/// parity check is staged, tv-runtime.md P3).
struct TVListSpine {
    /// The `<list>` node itself — the body re-reads its `visible-if` per pass.
    let list: StackNode
    let pre: [StackNode]
    let rows: [StackNode]
    let post: [StackNode]

    /// The gate's word set — every look word the hand-drawn path consumes
    /// (StackWatch's set, byte-for-byte; drift is a bug).
    private static let look = ["bg", "radius", "padding", "paddingh", "paddingv",
                               "spacing", "align", "opacity"]
    private static func unstyled(_ n: StackNode) -> Bool {
        look.allSatisfy { n.attrs[$0] == nil }
    }
    private static func eligible(_ n: StackNode) -> Bool {
        n.tag == "list" && n.attrs["bind"] == nil && unstyled(n)
            && n.children.allSatisfy(unstyled)
    }

    static func find(_ root: StackNode) -> TVListSpine? {
        if eligible(root) { return TVListSpine(list: root, pre: [], rows: root.children, post: []) }
        guard StackBackend.isColumn(tag: root.tag, display: root.attrs["display"],
                                    flexDirection: root.attrs["flexDirection"]),
              unstyled(root) else { return nil }
        let kids = root.children.filter { $0.tag != "head" }
        guard let i = kids.firstIndex(where: { $0.tag == "list" }), eligible(kids[i]),
              kids.allSatisfy(unstyled) else { return nil }
        return TVListSpine(list: kids[i], pre: Array(kids[..<i]),
                           rows: kids[i].children, post: Array(kids[(i + 1)...]))
    }
}

/// The real List (tvOS's own focus-driven row anatomy, inherited — never
/// re-specified, so platform looks arrive by OS update). Header/footer siblings
/// render as clear rows; hidden rows are FILTERED, enumerated BEFORE filtering
/// so a row's identity is its authored position (the StackWatch fix, inherited).
private struct TVListView: View {
    let spine: TVListSpine
    let scope: StackScope

    private func visibleRows(_ nodes: [StackNode]) -> [(offset: Int, element: StackNode)] {
        Array(nodes.enumerated()).filter { StackBackend.visible($0.element, in: scope) }
    }

    var body: some View {
        List {
            ForEach(visibleRows(spine.pre), id: \.offset) { _, n in
                StackLiveNodeView(node: n, scope: scope, visibilityChecked: true)
                    .listRowBackground(Color.clear)
            }
            ForEach(visibleRows(spine.rows), id: \.offset) { _, n in
                StackLiveNodeView(node: n, scope: scope, visibilityChecked: true)
                    .environment(\.stackTVListRow,
                                 n.tag == "button" || n.tag == "toggle" || n.tag == "switch")
            }
            ForEach(visibleRows(spine.post), id: \.offset) { _, n in
                StackLiveNodeView(node: n, scope: scope, visibilityChecked: true)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.automatic)
    }
}

// MARK: - The TV element table (StackLive's set + the interactive tags)

enum StackTV {
    /// The shared base set (list/scroll/divider live there), plus the tags a TV
    /// screen needs that a snapshot can't have: the interactive `button`, the
    /// native `toggle` (+ its documented alias `switch`), and the TV `text`
    /// override (the 10-foot type ramp). Last-writer-wins on a key, exactly the
    /// StackWatch merge.
    static let elements: [String: StackElement.Type] =
        StackBackend.elements.merging([
            TVButtonElement.tag: TVButtonElement.self,
            TVTextElement.tag:   TVTextElement.self,
            TVToggleElement.tag: TVToggleElement.self,
            "switch":            TVToggleElement.self,
        ]) { _, added in added }

    /// The ONE size/weight Text ladder every TV label shares (the StackWatch
    /// styledText contract with the TV ramp's own bases): authored `size` → the
    /// full system font at that size (+ weight); authored `weight` alone →
    /// weight above the inherited font; neither → untouched. `alwaysFont` pins
    /// the authored-text path to the TV base so weight-only text renders the
    /// 10-foot ramp instead of drifting.
    static func styledText(_ text: Text, _ r: StackReader,
                           base: CGFloat, alwaysFont: Bool = false) -> Text {
        if alwaysFont || r.node.attrs["size"] != nil {
            return text.font(.system(size: r.cgFloat("size", base), weight: r.fontWeight))
        }
        if r.node.attrs["weight"] != nil {
            return text.fontWeight(r.fontWeight)
        }
        return text
    }

    /// The TV type-ramp bases (system-defaults.md: a renderer's defaults are its
    /// OWN): 29pt is tvOS's body — the authored-text fallback base — and 31pt
    /// the button-label base. The wrist's 13/15 would vanish at ten feet.
    static let textBase: CGFloat = 29
    static let labelBase: CGFloat = 31
}

// MARK: - TV-only elements (one tag each, same StackElement contract as StackLive)

/// The TV `text` — the system type ramp as the default: an unstyled `<text>`
/// carries NO font/color/line modifiers at all, so it inherits the context's
/// system style (tvOS body ramp in a screen, the button label style inside a
/// button, semantic label color everywhere) and WRAPS like system text. ANY
/// authored text attribute is the author leaving the ramp: the full authored
/// path renders — the TV base (29pt), `.primary`, the 1-line clamp — with each
/// authored value above its default (the StackWatch contract, TV bases).
enum TVTextElement: StackElement {
    static let tag = "text"
    static func body(_ r: StackReader) -> AnyView {
        let authored = r.node.attrs["size"] != nil || r.node.attrs["weight"] != nil
            || r.node.attrs["color"] != nil || r.node.attrs["lines"] != nil
        guard authored else { return AnyView(Text(r.text)) }
        return AnyView(
            StackTV.styledText(Text(r.text), r, base: StackTV.textBase, alwaysFont: true)
                .foregroundColor(r.color("color", .primary))
                .lineLimit(Int(r.cgFloat("lines", 1))))
    }
}

enum TVButtonElement: StackElement {
    static let tag = "button"
    static func body(_ r: StackReader) -> AnyView { AnyView(StackTVButton(reader: r)) }
}

/// A button that navigates locally (`route=`) and/or runs its handler through
/// the installed runner (`on:tap` — full statement grammar) or emits its event
/// name. SYSTEM DEFAULT: tvOS's own focusable button style — inherited, never
/// re-specified. `tint` applies only when authored; an authored box
/// (`bg`/`radius`) ejects to the plain custom path where the shared layout box
/// paints the author's chrome. Inside a List row the ROW is the button: plain
/// style, leading label, full-row focus target (the platform list anatomy).
private struct StackTVButton: View {
    let reader: StackReader
    @Environment(\.stackTVEmit) private var emit
    @Environment(\.stackTVNavigate) private var navigate
    @Environment(\.stackTVRun) private var run
    @Environment(\.stackTVListRow) private var isListRow

    private var authoredBox: Bool {
        reader.node.attrs["bg"] != nil || reader.node.attrs["radius"] != nil
    }

    var body: some View {
        Group {
            if isListRow {
                Button(action: tap) {
                    HStack(spacing: 0) {
                        labelContent
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else if authoredBox {
                // The author drew this button's chrome — the custom path: plain
                // content, the shared layout box paints the authored bg/radius.
                Button(action: tap) { labelContent }
                    .buttonStyle(.plain)
            } else {
                Button(action: tap) { labelContent }
            }
        }
        .modifier(TVTintIfAuthored(reader: reader))
    }

    @ViewBuilder private var labelContent: some View {
        if reader.node.children.isEmpty {
            StackTV.styledText(Text(reader.string("label") ?? reader.text),
                               reader, base: StackTV.labelBase)
                .frame(maxWidth: reader.growsWidth ? .infinity : nil)
        } else {
            StackBackend.children(of: reader.node, in: reader.scope)
        }
    }

    private func tap() {
        if let route = reader.string("route"), !route.isEmpty { navigate(route) }
        // With a runner installed, the RAW handler body runs the portable
        // statement grammar in-process. `event=` keeps the direct emit; without
        // a runner, the snapshot name-scan is the behavior, unchanged.
        if let e = reader.node.attrs["event"], !e.isEmpty { emit(e) }
        else if let run, let handler = reader.node.attrs["on:tap"] ?? reader.node.attrs["on:press"], !handler.isEmpty {
            run(handler)
        } else if let name = reader.tapEvent { emit(name) }
    }
}

enum TVToggleElement: StackElement {
    static let tag = "toggle"
    static func body(_ r: StackReader) -> AnyView { AnyView(StackTVToggle(reader: r)) }
}

/// The NATIVE toggle — the two-way `bind` contract on the TV: `bind="key"`
/// reads the store truthily through the cond seam; a flip writes SYNCHRONOUSLY
/// through the store-write seam and ONLY the `on:change` body rides the runner
/// (the write-window fix, StackWatch verbatim: the handler sees the NEW value).
/// Without a runner, a store writer, or a bind key the toggle renders DISABLED
/// at its current value — fail-open display, never a fake interaction.
private struct StackTVToggle: View {
    let reader: StackReader
    @Environment(\.stackTVRun) private var run
    @Environment(\.stackTVSetVar) private var setVar

    private var bindKey: String {
        let key = reader.node.attrs["bind"] ?? ""
        // A store IDENTIFIER only (the seam writes it as a store key): anything
        // richer than letters/digits/underscore is refused whole — inert, never
        // a reinterpreted statement.
        return key.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) ? key : ""
    }

    var body: some View {
        let key = bindKey
        let isOn = !key.isEmpty && (reader.scope.cond?(key) ?? false)
        let binding = Binding<Bool>(
            get: { isOn },
            set: { next in
                guard let setVar, !key.isEmpty else { return }
                setVar(key, next)                       // the bind write, synchronous
                if let run, let change = reader.node.attrs["on:change"], !change.isEmpty {
                    run(change)                         // ONLY the handler body is async
                }
            })
        let label = reader.string("label") ?? reader.text
        return AnyView(
            Toggle(isOn: binding) {
                StackTV.styledText(Text(label), reader, base: StackTV.labelBase)
            }
            .modifier(TVTintIfAuthored(reader: reader))
            .disabled(run == nil || setVar == nil || key.isEmpty)
        )
    }
}

/// `tint` above the system default, only when authored (the ladder) — shared by
/// the button (every path) and the toggle (the WatchTintIfAuthored twin).
private struct TVTintIfAuthored: ViewModifier {
    let reader: StackReader
    @ViewBuilder func body(content: Content) -> some View {
        if reader.node.attrs["tint"] != nil {
            content.tint(reader.color("tint", .accentColor))
        } else {
            content
        }
    }
}
