//
//  StackWatch.swift - the Stack engine's watchOS render backend.
//
//  ONE grammar, a backend per surface (StackNode.swift header). StackWatch is the
//  watchOS sibling of `StackLive`: it consumes the same shared AST (StackNode /
//  StackXML / StackScope) and renders the subset that reads NICELY on a watch, while
//  staying inside what a watch process may legally run (no downloaded code, no WebKit,
//  no UIApplication - pure SwiftUI over serialized state). The full in-app engine
//  (Stack.swift) is the interactive backend of the same grammar; Android renders the
//  same tags in Compose (Wear OS).
//
//  It REUSES StackLive's element registry and recursion verbatim and ADDS the
//  watch-interactive tags on top (`button`, `toggle`/`switch`) plus a watch `text`
//  override (`list`/`scroll`/`divider` live in the shared base table) - so a `.dsx`
//  authored once is 1:1 across iOS / watchOS / Android. The element table is injected
//  through the environment (StackLive's `stackTable`), so child recursion renders this
//  superset without forking StackLive.
//
//  SYSTEM DEFAULTS (system-defaults.md — the wrist slice): an element with NO author
//  styles renders the watch's own system component, and every authored attribute keeps
//  working ABOVE the defaults (the ladder: defaults < author styles):
//   • `list`  → a REAL SwiftUI `List` (`.automatic` — the watch platter rows), when the
//     screen's SPINE is an unstyled list (WatchListSpine below). Siblings before/after
//     the list ride along as clear rows (header/footer), so one screen = one List.
//     An authored look ANYWHERE on the spine — the list, the root, a row, or a riding
//     sibling (bg/radius/padding/paddingh/paddingv/spacing/align/opacity) — is the
//     author taking over → the hand-drawn stack path (the spec's explicit ejection).
//   • `text`  → the system type ramp: no font/color/lineLimit modifiers at all when
//     unstyled (inherits the watch body ramp + semantic label color + wrapping); ANY
//     authored text attribute (size/weight/color/lines) renders the full legacy path
//     (13pt base + primary + 1-line clamp) with the authored values above it.
//   • `button`→ the watch's own bordered system button (the watchOS default style —
//     inherited, never re-specified, so it self-updates with the OS). The shared
//     `variant="bordered|prominent"` and `role="destructive|cancel"` words select real
//     SwiftUI system styles/roles. Unknown words keep the inherited default. `tint`
//     applies only when authored; `bg`/`radius` eject to the custom (layout-box) path.
//     Inside a List row the row IS the button: plain style, leading label, full-row tap
//     target; role semantics remain, while variant chrome stays off the row.
//   • `toggle` (alias `switch`) → the native watch Toggle: `bind="key"` reads the store
//     truthily via the cond seam; a flip writes `key = <bool>` SYNCHRONOUSLY through the
//     store-write seam (stackSetVar — the runtime's vars + publish, so get/re-render
//     agree immediately) and then runs ONLY the `on:change` body through the SAME action
//     runner taps use (the handler sees the NEW value) — no runner/writer (snapshot)
//     renders it inert.
//  W1 (watch-runtime.md): the watch target ALSO compiles the `logic` tier, so `{{ … }}`
//  spans here evaluate through the REAL JSE evaluator (StackScope.expr — installed in the
//  init below) over the pushed vars: expressions, ternaries, formatting, on the wrist.
//  The `cond` seam (StackScope.cond) rides beside it, so `visible-if` gates elements on
//  the wrist with real value truthiness (StackBackend.visible — inert on snapshot tiers).
//  Statements/actions ride the runner seam (W2); taps without a runner relay names only.
//
//  A tapped element does two surface-boundary-safe things, NEVER running code:
//   - `route="/x"`  -> navigate the watch's own router locally (offline multi-screen).
//   - `event="x"` / `on:tap="dsx.event('x')"` -> relay the NAME to the phone, which
//     re-fires it on the bus. A button may carry either or both.
//  FAIL-OPEN throughout, exactly like StackLive.
//

import SwiftUI

// MARK: - Tap dispatch (names out, no code)

/// The closure a tapped element calls with its event name. The watch app injects its
/// relay (-> WatchConnectivity -> the phone's `dsx`); the default is a no-op.
struct StackEmitKey: EnvironmentKey {
    static let defaultValue: (String) -> Void = { _ in }
}
/// The closure a tapped element calls with a `route` to navigate the watch LOCALLY (no
/// phone round-trip), so a bundled multi-screen app works fully offline.
struct StackNavigateKey: EnvironmentKey {
    static let defaultValue: (String) -> Void = { _ in }
}
/// The FULL-GRAMMAR action runner (watch-runtime.md W2): a runtime-capable surface (the
/// watch app installs WatchRuntime.run) receives the RAW `on:tap` body and executes the
/// portable statement grammar in-process — dsx.event / state writes / awaits included.
/// nil (the default — widgets, plain snapshots) keeps the name-scan relay behavior.
struct StackRunKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}
/// The SYNCHRONOUS store-write seam (the toggle's `bind` write): the watch app installs
/// WatchRuntime.setVar (state.vars write + publish — the WearStore.setVar analogue), so
/// a flip lands in the ONE state universe IN the tap's own main-actor turn. The async
/// runner path left a write window: Binding.get returned a stale constant until the
/// Task ran, so a second tap re-ran the on:change body with the un-flipped value (a
/// duplicate capability call). nil (widgets, plain snapshots) keeps the toggle disabled.
struct StackSetVarKey: EnvironmentKey {
    static let defaultValue: ((String, Any) -> Void)? = nil
}
/// True while rendering a DIRECT row of the watch List whose row root is an interactive
/// tag (`button`/`toggle`): the row platter is the control, so the button drops its
/// bordered chrome (plain style, leading label, full-row tap) instead of drawing a
/// second platter inside the row. Container rows keep it false, so a button NESTED in
/// an hstack row still renders the system bordered shape.
struct StackListRowKey: EnvironmentKey {
    static let defaultValue = false
}
extension EnvironmentValues {
    var stackEmit: (String) -> Void {
        get { self[StackEmitKey.self] }
        set { self[StackEmitKey.self] = newValue }
    }
    var stackNavigate: (String) -> Void {
        get { self[StackNavigateKey.self] }
        set { self[StackNavigateKey.self] = newValue }
    }
    var stackRun: ((String) -> Void)? {
        get { self[StackRunKey.self] }
        set { self[StackRunKey.self] = newValue }
    }
    var stackSetVar: ((String, Any) -> Void)? {
        get { self[StackSetVarKey.self] }
        set { self[StackSetVarKey.self] = newValue }
    }
    var stackListRow: Bool {
        get { self[StackListRowKey.self] }
        set { self[StackListRowKey.self] = newValue }
    }
}

// MARK: - Entry point

/// Render a DSX layout string for the watch. A screen whose spine is an unstyled
/// `<list>` renders as ONE real watch `List` (the system default look — rows platter,
/// the List owns scrolling); every other screen keeps the single ScrollView root
/// (nested scrolling reads badly on a watch). The watch element table and the
/// tap/route relays are installed once at the root, and every descendant inherits them.
struct StackWatchView: View {
    let root: StackNode?
    let spine: WatchListSpine?
    let scope: StackScope
    let emit: (String) -> Void
    let navigate: (String) -> Void
    let run: ((String) -> Void)?
    let set: ((String, Any) -> Void)?

    /// `state`: the surface's LIVE JSEState (the watch app passes its WatchRuntime state —
    /// ONE state universe for expressions AND actions, rich values included). nil builds a
    /// per-render JSEVars from the string vars (the W1 shape, still full-grammar reads).
    /// `run`: the action runner hookup (W2) — nil keeps the snapshot name-scan taps.
    /// `set`: the SYNCHRONOUS store-write hookup (the toggle's bind seam) — nil renders
    /// toggles disabled (StackSetVarKey header).
    /// One-entry parse memo: the view is reconstructed on EVERY store change (a 1Hz timer
    /// tick included, an 80ms crown merge) with the SAME layout string — re-parsing the
    /// XML per tick is pure waste, and so is re-walking it for the list SPINE, so the
    /// memo carries BOTH: root + the structural spine, computed once per layout-string
    /// change. Main-thread only (SwiftUI view init), so plain statics are safe.
    private static var lastLayout = ""
    private static var lastRoot: StackNode?
    private static var lastSpine: WatchListSpine?
    private static func parsed(_ layout: String) -> (root: StackNode?, spine: WatchListSpine?) {
        if layout != lastLayout {
            let root = StackXML.parse(layout, platformTarget: "watch")
            lastLayout = layout
            lastRoot = root
            lastSpine = root.flatMap(WatchListSpine.find)
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
        // FULL JSE ON THE WRIST (watch-runtime.md W1): this target compiles the `logic`
        // tier, so every `{{ … }}` span evaluates through the real, corpus-pinned
        // evaluator — `{{ pos * 100 }}`, ternaries, formatting — instead of the snapshot
        // simple-reference form (which remains the widget / Live-Activity behavior; those
        // targets carry no runtime by taxonomy). Reserved app namespaces (`global.*` etc.)
        // read through nil seams here and fail open — the watch's app state arrives as vars.
        let jse: any JSEState = state ?? JSEVars(vars.reduce(into: [String: Any]()) { $0[$1.key] = $1.value })
        var scope = StackScope(vars: vars)
        scope.expr = { e in JSE.string(JSE.eval(e, store: jse, item: nil)) }
        // The cond seam: `visible-if` + the toggle's bind read evaluate with the
        // executors' VALUE truthiness (StackScope.cond header) — same store, same timing.
        scope.cond = { e in JSE.truthy(JSE.eval(e, store: jse, item: nil)) }
        self.scope = scope
        self.run = run
        self.set = set
        self.emit = emit
        self.navigate = navigate
    }

    static func parses(_ layout: String) -> Bool {
        // The shell calls this on every reactive redraw to distinguish trustworthy DSX
        // from a corrupt bundled asset. Reuse the same one-entry memo as init so a timer,
        // crown tick, or state push never reparses an unchanged wrist screen.
        !layout.isEmpty && parsed(layout).root != nil
    }

    var body: some View {
        Group {
            // The spine is STRUCTURAL (memoized per layout); its VISIBILITY is
            // scope-dependent, so the root's and the list's `visible-if` gate here,
            // per render pass — a hidden root/list falls to the stack path below,
            // where render's own guard hides it (a visible-if'd spine used to render
            // its List regardless).
            if let root = root, let spine = spine,
               StackBackend.visible(root, in: scope),
               StackBackend.visible(spine.list, in: scope) {
                WatchListView(spine: spine, scope: scope)
            } else {
                ScrollView {
                    if let root = root {
                        StackLiveNodeView(node: root, scope: scope)
                    }
                }
            }
        }
        .environment(\.stackTable, StackWatch.elements)
        .environment(\.stackEmit, emit)
        .environment(\.stackNavigate, navigate)
        .environment(\.stackRun, run)
        .environment(\.stackSetVar, set)
    }
}

// MARK: - The list spine (system-defaults: an unstyled <list> IS the screen's List)

/// The screen's list spine: the root — or the root column container's direct child —
/// `<list>`, with the flow siblings before/after it as header/footer rows. Detection is
/// deliberately SHALLOW (root level only), STRUCTURAL (memoized per layout string —
/// StackWatchView.parsed; the root's/list's `visible-if` gates at the BODY, per render)
/// and STYLE-GATED: an authored look ANYWHERE on the spine — the list, the root, a ROW,
/// or a riding pre/post SIBLING — or a data-bound list ejects the WHOLE spine to the
/// hand-drawn stack path, so every pre-defaults screen renders byte-identically and the
/// author's custom look always wins over the system component (the ladder). Rows used
/// to slip the gate and drew their authored boxes ON the system platter (double
/// chrome); `align`/`opacity` used to slip it and were silently dropped — ejection is
/// the inert-true handling for both.
struct WatchListSpine {
    /// The `<list>` node itself — the body re-reads its `visible-if` per render pass.
    let list: StackNode
    let pre: [StackNode]
    let rows: [StackNode]
    let post: [StackNode]

    /// The gate's word set — every look word the hand-drawn path consumes.
    private static let look = ["bg", "radius", "padding", "paddingh", "paddingv",
                               "spacing", "align", "opacity"]
    private static func unstyled(_ n: StackNode) -> Bool {
        look.allSatisfy { n.attrs[$0] == nil }
    }
    private static func eligible(_ n: StackNode) -> Bool {
        n.tag == "list" && n.attrs["bind"] == nil && unstyled(n)
            && n.children.allSatisfy(unstyled)
    }

    static func find(_ root: StackNode) -> WatchListSpine? {
        if eligible(root) { return WatchListSpine(list: root, pre: [], rows: root.children, post: []) }
        guard StackBackend.isColumn(tag: root.tag, display: root.attrs["display"],
                                    flexDirection: root.attrs["flexDirection"]),
              unstyled(root) else { return nil }
        let kids = root.children.filter { $0.tag != "head" }
        guard let i = kids.firstIndex(where: { $0.tag == "list" }), eligible(kids[i]),
              kids.allSatisfy(unstyled) else { return nil }
        return WatchListSpine(list: kids[i], pre: Array(kids[..<i]),
                              rows: kids[i].children, post: Array(kids[(i + 1)...]))
    }
}

/// The real watch `List` (`.automatic` = the watchOS platter rows, inherited — never
/// re-specified, so Liquid-Glass-era looks arrive by OS update). Header/footer siblings
/// render as clear rows; list children are the platter rows. A row hidden by
/// `visible-if` is FILTERED (an AnyView(EmptyView()) row would still platter empty).
private struct WatchListView: View {
    let spine: WatchListSpine
    let scope: StackScope

    /// Enumerate BEFORE filtering: a row's ForEach id is its POSITION in the authored
    /// markup, stable while `visible-if` flips (filter-then-enumerate re-packed the
    /// offsets, so every row below a hidden one changed identity — dropped row state,
    /// broken removal animations). Per-section offsets are fine: pre/rows/post are
    /// separate ForEach blocks. The rendered node carries `visibilityChecked` so the
    /// backend never re-evaluates the condition this filter just evaluated.
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
                    .environment(\.stackListRow,
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

// MARK: - The watch element table (StackLive's set + the interactive tags)

enum StackWatch {
    /// The shared base set (which carries list/scroll/divider), plus the tags a watch
    /// screen needs that a widget can't have: the interactive `button`, the native
    /// `toggle` (+ its documented phone alias `switch`), and the watch `text` override
    /// (the wrist type ramp — WatchTextElement). Last-writer-wins on a key, so a watch
    /// override shadows a base element — `button` here: the runtime-backed watch button
    /// (JSE `on:tap`, any statement) replaces the base snapshot button (one compiled
    /// `dsx.module` call via intents).
    static let elements: [String: StackElement.Type] =
        StackBackend.elements.merging([
            ButtonElement.tag:      ButtonElement.self,
            WatchTextElement.tag:   WatchTextElement.self,
            WatchToggleElement.tag: WatchToggleElement.self,
            "switch":               WatchToggleElement.self,
        ]) { _, added in added }

    /// The ONE size/weight Text ladder every wrist label shares (the button label's
    /// three branches, the toggle's label, WatchTextElement's authored path — three
    /// drifted copies folded): authored `size` → the full system font at that size
    /// (+ weight); authored `weight` alone → weight above the inherited font; neither →
    /// untouched. `alwaysFont` is the LEGACY TEXT path's pin: the font applies at
    /// size-or-`base` regardless, so weight-only text renders the 13pt legacy base
    /// instead of drifting to the body ramp. Concrete Text in/out (.font/.fontWeight
    /// both return Text) — chainable before a single AnyView erasure.
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
}

// MARK: - Watch-only elements (one tag each, same StackElement contract as StackLive)

/// The watch `text` — the system type ramp as the default (system-defaults.md): an
/// unstyled `<text>` carries NO font/color/line modifiers at all, so it inherits the
/// context's system style (the body ramp in a screen, the button label style inside a
/// button, semantic label color everywhere) and WRAPS like system text. ANY authored
/// text attribute (size/weight/color/lines) is the author leaving the ramp: the FULL
/// legacy path renders, exactly as the base LiveTextElement — 13pt system font (the
/// pre-law TEXT base; 15 is the button-LABEL base), `.primary`, the 1-line clamp —
/// with each authored value above its default. A per-attribute hybrid was neither law
/// (size alone lost the 1-line clamp; weight alone rode the body ramp instead of
/// 13pt). One concrete Text chain, ONE AnyView erasure.
enum WatchTextElement: StackElement {
    static let tag = "text"
    static func body(_ r: StackReader) -> AnyView {
        let authored = r.node.attrs["size"] != nil || r.node.attrs["weight"] != nil
            || r.node.attrs["color"] != nil || r.node.attrs["lines"] != nil
        guard authored else { return AnyView(Text(r.text)) }
        return AnyView(
            StackWatch.styledText(Text(r.text), r, base: 13, alwaysFont: true)
                .foregroundColor(r.color("color", .primary))
                .lineLimit(Int(r.cgFloat("lines", 1))))
    }
}

enum ButtonElement: StackElement {
    static let tag = "button"
    static func body(_ r: StackReader) -> AnyView { AnyView(StackWatchButton(reader: r)) }
}

/// A button that navigates locally (`route=`) and/or relays its `tapEvent` name to the
/// phone. The label is the element's children when it has any, else its `label`/text.
/// SYSTEM DEFAULT (system-defaults.md): the watchOS default button style — the OS's own
/// bordered platter, inherited rather than re-specified. The two shared variant words
/// select SwiftUI's real `.bordered` / `.borderedProminent` styles and the two button
/// role words map to `ButtonRole`; an unknown word leaves the inherited look untouched.
/// `role="cancel"` supplies its dismissive semibold weight unless the author supplied a
/// weight. `tint` applies only when authored — on EVERY path (the list-row and
/// authored-box shapes tint too, exactly as the pre-law button tinted unconditionally);
/// `size`/`weight` style the label only when authored (StackWatch.styledText); an
/// authored box (`bg`/`radius`) ejects to the plain custom path where the shared layout
/// box paints the author's chrome. Inside a List row (stackListRow) the ROW is the
/// button: plain style, leading label, full-row tap target — the real watch list-row
/// anatomy. Variant chrome never creates a second control inside that row.
private struct StackWatchButton: View {
    let reader: StackReader
    @Environment(\.stackEmit) private var emit
    @Environment(\.stackNavigate) private var navigate
    @Environment(\.stackRun) private var run
    @Environment(\.stackListRow) private var isListRow

    private var authoredBox: Bool {
        reader.node.attrs["bg"] != nil || reader.node.attrs["radius"] != nil
    }

    private var roleWord: String {
        (reader.node.attrs["role"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var variantWord: String {
        (reader.node.attrs["variant"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var buttonRole: ButtonRole? {
        switch roleWord {
        case "destructive": return .destructive
        case "cancel": return .cancel
        default: return nil
        }
    }

    var body: some View {
        Group {
            if isListRow {
                Button(role: buttonRole, action: tap) {
                    HStack(spacing: 0) {
                        labelContent
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else if authoredBox {
                // The author drew this button's chrome — the custom path: plain content,
                // the shared layout box paints the authored bg/radius (no system platter
                // underneath it).
                Button(role: buttonRole, action: tap) { labelContent }
                    .buttonStyle(.plain)
            } else {
                systemButton
            }
        }
        .modifier(WatchTintIfAuthored(reader: reader))
    }

    @ViewBuilder private var systemButton: some View {
        let button = Button(role: buttonRole, action: tap) { labelContent }
        switch variantWord {
        case "bordered":
            button.buttonStyle(.bordered)
        case "prominent":
            button.buttonStyle(.borderedProminent)
        default:
            button
        }
    }

    @ViewBuilder private var labelContent: some View {
        if reader.node.children.isEmpty {
            StackWatch.styledText(Text(reader.string("label") ?? reader.text),
                                  reader, base: 15)
                .fontWeight(roleWord == "cancel" && reader.node.attrs["weight"] == nil
                            ? .semibold : nil)
                .frame(maxWidth: reader.growsWidth ? .infinity : nil)
        } else {
            StackBackend.children(of: reader.node, in: reader.scope)
                .modifier(WatchCancelWeight(
                    active: roleWord == "cancel" && reader.node.attrs["weight"] == nil))
        }
    }

    private func tap() {
        if let route = reader.string("route"), !route.isEmpty { navigate(route) }
        // W2: with a runner installed, the RAW handler body runs the portable statement
        // grammar in-process (dsx.event / state writes / awaits — the runner handles the
        // event form too, so behavior is a superset). `event=` keeps the direct relay;
        // without a runner, the snapshot name-scan is the behavior, unchanged.
        if let e = reader.node.attrs["event"], !e.isEmpty { emit(e) }
        else if let run, let handler = reader.node.attrs["on:tap"] ?? reader.node.attrs["on:press"], !handler.isEmpty {
            run(handler)
        } else if let name = reader.tapEvent { emit(name) }
    }
}

private struct WatchCancelWeight: ViewModifier {
    let active: Bool

    @ViewBuilder func body(content: Content) -> some View {
        if active { content.fontWeight(.semibold) }
        else { content }
    }
}

enum WatchToggleElement: StackElement {
    static let tag = "toggle"
    static func body(_ r: StackReader) -> AnyView { AnyView(StackWatchToggle(reader: r)) }
}

/// The NATIVE watch toggle (system-defaults.md: "toggle → native") — the phone tier's
/// two-way `bind` contract on the wrist: `bind="key"` reads the store truthily through
/// the cond seam; a flip writes `key = true|false` SYNCHRONOUSLY through the
/// store-write seam (stackSetVar — the runtime's state.vars + publish, the
/// WearStore.setVar analogue), so the publish re-renders the screen IN the tap's own
/// main-actor turn and get/re-render agree immediately; ONLY the `on:change` body then
/// rides the SAME statement runner taps use — it still sees the NEW value (the
/// documented ordering), because the write above landed first. (The old path ran the
/// write through the async runner too: Binding.get stayed a stale constant for the
/// Task's window, so a second tap re-ran the on:change body with the un-flipped value —
/// a duplicate capability call.) The system Toggle look is inherited untouched; `tint`
/// applies only when authored, the label styles like watch text (system ramp unless
/// authored — the shared styledText ladder, which gives the label the weight-only
/// branch the drifted copy lacked). Without a runner, a store writer, or a bind key
/// the toggle renders DISABLED at its current value — fail-open display, never a fake
/// interaction.
private struct StackWatchToggle: View {
    let reader: StackReader
    @Environment(\.stackRun) private var run
    @Environment(\.stackSetVar) private var setVar

    private var bindKey: String {
        let key = reader.node.attrs["bind"] ?? ""
        // A store IDENTIFIER only (the seam writes it as a store key): anything
        // richer than letters/digits/underscore is refused whole — inert, never a
        // reinterpreted statement.
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
                StackWatch.styledText(Text(label), reader, base: 15)
            }
            .modifier(WatchTintIfAuthored(reader: reader))
            .disabled(run == nil || setVar == nil || key.isEmpty)
        )
    }
}

/// `tint` above the system default, only when authored (the ladder) — shared by the
/// button (every path) and the toggle; the plain modifier keeps the call sites
/// declarative. (@ViewBuilder because ViewModifier.body, unlike View.body, is not
/// implicitly one — the WatchCrownReader precedent.)
private struct WatchTintIfAuthored: ViewModifier {
    let reader: StackReader
    @ViewBuilder func body(content: Content) -> some View {
        if reader.node.attrs["tint"] != nil {
            content.tint(reader.color("tint", .accentColor))
        } else {
            content
        }
    }
}

// (`list`, `scroll` and `divider` moved into StackBackend.elements — StackLive.swift —
// so every snapshot tier renders them identically; the watch adds `button`, `toggle`
// and its `text` ramp override on top, and renders an unstyled list SPINE as the real
// system List at the root — WatchListSpine above.)
