//
//  StackKeys.swift - the Stack engine's KEYBOARD-EXTENSION render backend.
//
//  ONE grammar, a backend per surface (StackNode.swift header). StackKeys is the
//  keyboard sibling of `StackWatch`: it consumes the same shared AST (StackNode /
//  StackXML / StackScope) and renders a keyboard's rows of keys, while staying inside
//  what a keyboard extension may legally run (no downloaded code, no WebKit, no
//  UIApplication - pure SwiftUI over serialized state; UIKit stays in the extension
//  target's own controller). It REUSES StackLive's element registry and recursion
//  verbatim and only OVERRIDES the tags a keyboard reads differently (`button` = a
//  key; `hstack` = a weighted key row ONLY when the row opts in - a key child or a
//  `flex=` child - so a plain hstack keeps StackLive's container semantics and
//  arbitrary pushed layouts render 1:1 with every other surface).
//
//  A key never runs code. Its tap collapses to ONE typed `StackKeyAction`, and the
//  keyboard target injects the closure that performs it against the real text proxy
//  (`UIInputViewController.textDocumentProxy` - UIKit, so it lives in the target,
//  never here). Key semantics are plain attributes on `button`:
//
//    insert="q"                 type this text (shift-aware for single letters)
//    action="delete"            backspace (press-and-hold repeats)
//    action="space" / "return"  whitespace / newline
//    action="globe"             next system keyboard (hidden when iOS says it's not needed)
//    action="shift"             toggle shift (the TARGET owns the state; see stackKeyShifted)
//    action="layer:symbols"     switch to the layout's `layer="symbols"` subtree
//    action="dismiss"           dismiss the keyboard
//    event="name"               relay an event NAME to the host app (StackReader.tapEvent -
//                               the same `event=` / on:tap="dsx.event('x')" contract as the
//                               watch); `payload="…"` rides along as { value: "…" }
//
//  `flex="1.5"` weights a key's width inside its row (default 1; interpolated like any
//  attribute) - `weight` stays the FONT weight, exactly as everywhere else in the
//  grammar. FAIL-OPEN throughout: an unknown action renders an inert key, an
//  unparseable layout is the caller's fallback.
//

import SwiftUI

// MARK: - The typed key action (names/values out, no code)

/// Everything a tapped key can mean. The keyboard target injects `stackKeyPerform`
/// to run these against its text proxy; the kernel only ever emits values.
enum StackKeyAction: Equatable {
    case insert(String)
    case delete
    case space
    case newline
    case globe
    case shift
    case layer(String)
    case dismiss
    case emit(String, payload: [String: String])
}

// MARK: - Environment (injected by the keyboard target)

/// The closure a tapped key calls with its resolved action. Default is a no-op so a
/// layout renders inert in previews.
struct StackKeyPerformKey: EnvironmentKey {
    static let defaultValue: (StackKeyAction) -> Void = { _ in }
}
/// Whether shift is active. The TARGET owns this state (it also decides how long it
/// lasts); the kernel only uses it to uppercase single-letter key labels.
struct StackKeyShiftedKey: EnvironmentKey {
    static let defaultValue: Bool = false
}
/// Whether iOS requires a globe (next-keyboard) key on this device
/// (`UIInputViewController.needsInputModeSwitchKey`). When false, `action="globe"`
/// keys render as empty space so bundled layouts work on every device.
struct StackKeyNeedsGlobeKey: EnvironmentKey {
    static let defaultValue: Bool = true
}
/// The locale shifted key CAPS uppercase with (the keyboard's PrimaryLanguage), so a
/// Turkish layout's shifted "i" displays "İ", matching what the target will type.
struct StackKeyLocaleKey: EnvironmentKey {
    static let defaultValue: Locale = .current
}
extension EnvironmentValues {
    var stackKeyPerform: (StackKeyAction) -> Void {
        get { self[StackKeyPerformKey.self] }
        set { self[StackKeyPerformKey.self] = newValue }
    }
    var stackKeyShifted: Bool {
        get { self[StackKeyShiftedKey.self] }
        set { self[StackKeyShiftedKey.self] = newValue }
    }
    var stackKeyNeedsGlobe: Bool {
        get { self[StackKeyNeedsGlobeKey.self] }
        set { self[StackKeyNeedsGlobeKey.self] = newValue }
    }
    var stackKeyLocale: Locale {
        get { self[StackKeyLocaleKey.self] }
        set { self[StackKeyLocaleKey.self] = newValue }
    }
}

// MARK: - Entry point

/// Render one keyboard layer (an already-selected subtree - the target owns layer
/// selection, like the watch target owns routing). Installs the keys element table
/// and the action/shift/globe/locale environment once at the root.
struct StackKeysView: View {
    let root: StackNode?
    let scope: StackScope
    let perform: (StackKeyAction) -> Void
    let shifted: Bool
    let needsGlobe: Bool
    let locale: Locale

    init(node: StackNode?, vars: [String: String],
         shifted: Bool = false, needsGlobe: Bool = true, locale: Locale = .current,
         perform: @escaping (StackKeyAction) -> Void = { _ in }) {
        self.root = node
        self.scope = StackScope(vars: vars)
        self.perform = perform
        self.shifted = shifted
        self.needsGlobe = needsGlobe
        self.locale = locale
    }

    var body: some View {
        if let root = root {
            StackLiveNodeView(node: root, scope: scope)
                .environment(\.stackTable, StackKeys.elements)
                .environment(\.stackKeyPerform, perform)
                .environment(\.stackKeyShifted, shifted)
                .environment(\.stackKeyNeedsGlobe, needsGlobe)
                .environment(\.stackKeyLocale, locale)
        }
    }
}

// MARK: - The keys element table (StackLive's set + the keyboard overrides)

enum StackKeys {
    /// The shared base set (which carries list/scroll/divider), with `button` re-read
    /// as a key and `hstack` as a key row when the row opts in. Last-writer-wins,
    /// same as StackWatch.
    static let elements: [String: StackElement.Type] =
        StackBackend.elements.merging([
            KeyElement.tag:    KeyElement.self,
            KeyRowElement.tag: KeyRowElement.self,
        ]) { _, added in added }

    /// Parse a key's attributes into its ONE action. `insert` wins, then `action`;
    /// a key with neither (an `event=`-only key) emits its relay event on tap, with
    /// an optional `payload=` string riding along as { value: … }.
    static func action(of reader: StackReader) -> StackKeyAction? {
        if let text = reader.string("insert"), !text.isEmpty { return .insert(text) }
        switch reader.string("action") ?? "" {
        case "":         break
        case "delete":   return .delete
        case "space":    return .space
        case "return":   return .newline
        case "globe":    return .globe
        case "shift":    return .shift
        case "dismiss":  return .dismiss
        case let named where named.hasPrefix("layer:"):
            return .layer(String(named.dropFirst("layer:".count)))
        default:         break   // unknown action -> inert key (fail-open)
        }
        if let event = reader.tapEvent {
            var payload: [String: String] = [:]
            if let value = reader.string("payload"), !value.isEmpty { payload["value"] = value }
            return .emit(event, payload: payload)
        }
        return nil
    }
}

// MARK: - Key row (`hstack` with flex weights, opt-in)

/// A keyboard row: children share the row width by `flex` (default 1), so a shift
/// key can be 1.4 keys wide and a half-key inset is `<spacer flex="0.5"/>` - the
/// exact geometry a system keyboard needs, which equal-split HStacks can't express.
/// An hstack with NO key children and NO flex weights is NOT a key row - it renders
/// through StackLive's plain hstack, so pushed layouts can still use hstack as an
/// ordinary container (suggestion strips, grouped caps) 1:1 with other surfaces.
enum KeyRowElement: StackElement {
    static let tag = "hstack"
    static func body(_ r: StackReader) -> AnyView {
        let optedIn = r.node.children.contains { $0.tag == "button" || $0.attrs["flex"] != nil }
        guard optedIn else { return LiveHStackElement.body(r) }
        return AnyView(StackKeyRow(reader: r))
    }
}

private struct StackKeyRow: View {
    let reader: StackReader

    /// Stable per-slot identity derived from the key's MEANING, not just its position,
    /// so a layer switch or layout push tears the old key's view (and its press state /
    /// repeat timer) down instead of migrating it into whatever lands at that offset.
    private struct Slot: Identifiable {
        let id: String
        let node: StackNode
        let flex: Double
    }

    private var slots: [Slot] {
        reader.node.children.filter { $0.tag != "head" }.enumerated().map { index, child in
            let semantic = [child.tag,
                            child.attrs["insert"] ?? "", child.attrs["action"] ?? "",
                            child.attrs["event"] ?? "", child.attrs["label"] ?? "",
                            child.attrs["symbol"] ?? ""].joined(separator: "|")
            let flex = Double(reader.scope.substitute(child.attrs["flex"] ?? "")) ?? 1
            return Slot(id: "\(index)#\(semantic)", node: child, flex: max(flex, 0.01))
        }
    }

    var body: some View {
        let spacing = reader.cgFloat("spacing", 5)
        let items = slots
        let total = items.reduce(0.0) { $0 + $1.flex }
        GeometryReader { geo in
            let usable = max(geo.size.width - spacing * CGFloat(max(items.count - 1, 0)), 0)
            HStack(alignment: .center, spacing: spacing) {
                ForEach(items) { slot in
                    StackLiveNodeView(node: slot.node, scope: reader.scope)
                        .frame(width: usable * CGFloat(slot.flex / max(total, 0.01)),
                               height: geo.size.height)
                }
            }
        }
        .frame(height: reader.cgFloat("height", 42))
    }
}

// MARK: - The key (`button`)

enum KeyElement: StackElement {
    static let tag = "button"
    /// The key draws its own cap (background, radius, shadow) - the generic layout
    /// box must not re-consume `bg`/`radius` on top of it (a square slab behind the
    /// rounded cap) or clip the cap's under-edge shadow away.
    static var ownsLayoutBox: Bool { true }
    static func body(_ r: StackReader) -> AnyView { AnyView(StackKey(reader: r)) }
}

private struct StackKey: View {
    let reader: StackReader
    @Environment(\.stackKeyPerform) private var perform
    @Environment(\.stackKeyShifted) private var shifted
    @Environment(\.stackKeyNeedsGlobe) private var needsGlobe
    @Environment(\.stackKeyLocale) private var locale
    @Environment(\.colorScheme) private var colorScheme

    /// Press tracking lives in @GestureState so SYSTEM CANCELLATION (incoming call,
    /// home-indicator gesture, the view leaving the hierarchy) resets it - the one
    /// path plain onChanged/onEnded never reports. The repeat timer's lifecycle is
    /// driven off this reset (onChange) plus onDisappear, so a held delete can never
    /// leave an orphaned timer erasing text with no finger down.
    @GestureState private var pressing = false
    @State private var repeatTimer: Timer?
    @State private var didRepeat = false

    private var action: StackKeyAction? { StackKeys.action(of: reader) }

    /// Control keys (delete/shift/globe/layer/return/dismiss) get the darker system
    /// key color; typing keys the lighter one. Overridable per key via `bg=`.
    private var isControl: Bool {
        switch action {
        case .insert, .space, .emit, nil: return false
        default:                          return true
        }
    }

    private var keyBackground: Color {
        if let bg = reader.string("bg") { return StackColor.parse(bg) }
        if colorScheme == .dark {
            return isControl ? Color(white: 0.26) : Color(white: 0.42)
        }
        return isControl ? Color(red: 0.68, green: 0.71, blue: 0.75) : .white
    }

    /// The visible label: `label=` / body text, uppercased for single letters while
    /// shifted - with the layout's locale, and only when the case change stays one
    /// character (ß stays ß), so the cap always shows exactly what the target types.
    private var label: String {
        let raw = reader.string("label") ?? reader.text
        guard shifted, raw.count == 1 else { return raw }
        let upper = raw.uppercased(with: locale)
        return upper.count == raw.count ? upper : raw
    }

    var body: some View {
        // A globe key on a device that doesn't need one renders as blank space, so
        // the row's geometry (and the bundled layout) is device-independent.
        if action == .globe && !needsGlobe {
            Color.clear
        } else {
            keyBody
        }
    }

    private var keyBody: some View {
        ZStack {
            RoundedRectangle(cornerRadius: reader.cgFloat("radius", 5))
                .fill(keyBackground)
                .shadow(color: .black.opacity(0.25), radius: 0, x: 0, y: 1)
            if !reader.node.children.isEmpty {
                // Composed cap - the same children-as-label contract as the watch's
                // button, so one markup renders 1:1 on both surfaces.
                StackBackend.children(of: reader.node, in: reader.scope)
            } else if let symbol = reader.string("symbol"), !symbol.isEmpty {
                Image(systemName: shifted && symbol == "shift" ? "shift.fill" : symbol)
                    .font(.system(size: reader.cgFloat("size", 16)))
                    .foregroundColor(reader.color("color", .primary))
            } else {
                Text(label)
                    .font(.system(size: reader.cgFloat("size", 22), weight: reader.fontWeight))
                    .foregroundColor(reader.color("color", .primary))
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .opacity(pressing ? 0.6 : 1)
        .gesture(pressGesture)
        .dsxOnChange(of: pressing) { down in
            if down {
                didRepeat = false
                if action == .delete { scheduleRepeat() }
            } else {
                stopRepeat()   // runs on release AND on cancellation (@GestureState reset)
            }
        }
        .onDisappear { stopRepeat() }   // view torn down mid-press (layer switch, layout push)
    }

    /// Tap = press + release (so keys feel instant); `delete` repeats while held.
    /// The ACTION fires only from onEnded (a cancelled touch must not type); the
    /// timer/visuals reset from the @GestureState pipeline above, which fires even
    /// when onEnded never will.
    private var pressGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($pressing) { _, state, _ in state = true }
            .onEnded { _ in
                let fired = didRepeat
                stopRepeat()
                didRepeat = false
                if !fired, let action { perform(action) }
            }
    }

    private func scheduleRepeat() {
        repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: false) { _ in
            didRepeat = true
            perform(.delete)
            repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.09, repeats: true) { _ in
                perform(.delete)
            }
        }
    }

    private func stopRepeat() {
        repeatTimer?.invalidate()
        repeatTimer = nil
    }
}
