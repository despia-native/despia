// DSXState.swift
//
// The one app-level reactive store — "global.*".
//
// When DSX is the root app runtime (not the WebView), state cannot live inside a
// single StackSurface or inside the WebView: auth / entitlements / credits / theme
// / route / feature flags are shared by the App.dsx router, native routes, DSXWebView
// (the web route), packages, global components and (later) widget/watch targets.
// This is that shared source of truth.
//
// State layers — do NOT make everything global:
//   • global.*        → DSX.state (this file)        app-wide, cross-route, cross-target
//   • bare names      → the surface's StackStore      per screen / surface
//   • SwiftUI @State  → a native component            per view
//   • web framework   → inside a DSXWebView               per web route
//
// Read in any Stack expression as `global.<path>`:
//     <text>{{ global.session.credits }}</text>
//     <route path="/premium" visible-if="global.session.premium"/>
// Write declaratively (`set: global.session.premium = true`) or natively:
//     dsx.global.set("session.credits", 200)
// The store is observed by the renderer (StackNodeView), so a write re-renders
// every view that reads `global.*` — a native paywall flipping `premium` is seen
// instantly by native routes; the web bridge (the state surface — window.despia.global.*,
// a later phase) mirrors it to DSXWebView so the web app reacts without a reload.

import Foundation
import Combine

extension DSX {
    /// The app-wide reactive store. A `StackStore` so it shares the engine's
    /// reactivity (`@Published vars`) and the exact dictionary shape the `global.`
    /// expression namespace reads. Internal (StackStore is internal); the public
    /// surface is `dsx.global` / the `global.` namespace.
    static let state = StackStore()
}

/// Native read/write API for the global store, reached as `dsx.global` — the SAME store DSX/JSE
/// read as `dsx.global.x.y` (≡ `global.x.y`); this is just its Swift face (XML can't call Swift, so
/// both spellings exist for the one store). Two ways to read:
///   • DOT NOTATION (preferred): `dsx.global.session.credits.int`, `dsx.global.strings.save.string`
///     — mirrors `dsx.global.session.credits` in markup, no stringly paths, no casts.
///   • DOT-PATH STRINGS: `dsx.global.get("session.credits")` / `set("session.credits", 200)` —
///     for writes and dynamic paths.
/// (A global key literally named `get`/`set`/`state` is shadowed by those methods — reach it with
/// the string subscript `dsx.global["get"]`.)
@dynamicMemberLookup
public struct DSXGlobal {
    public init() {}
    /// Read a dot-path (`get("session.credits")`), or nil if absent.
    public func get(_ path: String) -> Any? { DSX.state.getPath(path) }
    /// Write a dot-path (`set("session.credits", 200)`), creating intermediate
    /// dictionaries as needed. `nil` writes an EXPLICIT absence (`NSNull`, the store's
    /// JSON-null) rather than being dropped — a coordinator publishing "no value here"
    /// (e.g. `screen.frame` for a frameless report) must be able to say so, and every
    /// reader already treats `NSNull` as absent (`truthy`, `DSXValue`).
    public func set(_ path: String, _ value: Any?) { DSX.state.setPath(path, value ?? NSNull()) }
    /// Seed / replace a whole top-level key: `state("session", ["userId": "1"])`.
    public func state(_ key: String, _ value: [String: Any]) { DSX.state.set(key, value) }

    /// Dot-notation READ entry: `dsx.global.session` → a `DSXValue` you keep chaining
    /// (`.credits.int`). The Swift twin of `dsx.global.session.credits` in markup.
    public subscript(dynamicMember key: String) -> DSXValue { DSXValue(DSX.state.getPath(key)) }
    /// Same, for a key that isn't a valid Swift identifier.
    public subscript(_ key: String) -> DSXValue { DSXValue(DSX.state.getPath(key)) }
}

/// A node in the global store reached by dot notation — chain deeper with another `.key`, or read
/// the leaf typed. Getters are OPTIONAL on purpose (absent is normal in a shared bag), so the
/// override idiom is a clean `??`:  `dsx.global.strings.save.string ?? "Save"`. The exact value DSX
/// reads as `{{ dsx.global.strings.save }}`. Cross-platform: plain dictionaries the Android twin fills.
@dynamicMemberLookup
public struct DSXValue {
    public let raw: Any?
    public init(_ raw: Any?) { self.raw = raw }

    /// Descend: `dsx.global.a.b.c`. A missing/non-dict node yields an empty `DSXValue` (no crash).
    public subscript(dynamicMember key: String) -> DSXValue { DSXValue((raw as? [String: Any])?[key]) }
    public subscript(_ key: String) -> DSXValue { DSXValue((raw as? [String: Any])?[key]) }

    /// Is anything present at this path?
    public var exists: Bool { raw != nil }
    /// Typed leaf reads — nil when absent / wrong type, so `?? default` falls through cleanly.
    public var string: String? { raw as? String }
    public var int: Int?       { (raw as? Int) ?? (raw as? Double).map(Int.init) }
    public var double: Double? { (raw as? Double) ?? (raw as? Int).map(Double.init) }
    public var bool: Bool?     { raw as? Bool }
    public var list: [Any]?    { raw as? [Any] }
    public var dict: [String: Any]? { raw as? [String: Any] }
    /// The raw value, untyped (escape hatch).
    public var any: Any? { raw }
}


/// `dsx.app` — read-only app identity from `App.json` (+ the bundle): the blessed accessor a
/// package uses instead of reaching into `AppManifest` / `Bundle` itself. The SAME values seed the
/// DSX `dsx.app.*` namespace at boot (DSXBoot.rootController), so `dsx.app.host` / `dsx.app.name` read it in
/// markup. Cross-platform by name: the Android twin fills the same fields, so `dsx.app.*` markup ports.
public struct DSXApp {
    public init() {}
    /// The host resolved for THIS device from `App.json` (`host` + per-locale `hosts`), or "" when
    /// App.json names none (an explicit legacy Dom origin may still drive launch; the committed
    /// starter manifest instead routes to the bundled native DSXStartup component).
    public var host: String { AppManifest.resolvedHost() ?? "" }
    /// The app's display name — `App.json`'s `name` when set (author-declared identity), else the
    /// bundle's `CFBundleDisplayName` (the build-time `APP_NAME`), falling back to `CFBundleName`.
    public var name: String {
        if let declared = AppManifest.appName { return declared }
        return (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
            ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? ""
    }
    /// The marketing version (`CFBundleShortVersionString`), e.g. `"2.4.1"` — a display STRING;
    /// don't compare it (lexicographic order lies: "2.10" < "2.9"). Compare `build` instead.
    public var version: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
    }
    /// The build number (`CFBundleVersion`) as an Int — the blessed NUMERIC comparison key
    /// (`visible-if="dsx.app.build >= 260"`). Dotted build numbers ("251.0", "1.2.3" — legal
    /// CFBundleVersion) read their LEADING numeric component, so build-gating keeps working;
    /// 0 only when nothing numeric leads (fail-open).
    public var build: Int {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? ""
        return Int(raw) ?? Int(String(raw.prefix(while: { $0.isNumber }))) ?? 0
    }
    /// The runtime environment channel — the seeded mirror of `dsx.env.channel`
    /// ("simulator" | "debug" | "testflight" | "adhoc" | "appstore"; fail-closed to "appstore").
    /// Markup also reads it as the bare reserved word `env` (JSE), like `os`.
    public var env: String { AppEnvironment.current.rawValue }
    /// `true` on an App Store install — the boolean spelling for markup
    /// (`visible-if="!dsx.app.production"`), mirroring `dsx.env.isProduction`.
    public var production: Bool { AppEnvironment.current.isProduction }
    /// Flat snapshot used to seed the reactive `dsx.app.*` namespace (Android mirrors it).
    public var snapshot: [String: Any] {
        ["host": host, "name": name, "version": version, "build": build,
         "env": env, "production": production]
    }
}

/// `DSXLocale.pick` — resolve a localized config map `["default": …, "<locale>": …]` to the best
/// string for THIS device: walk the user's preferred languages, matching the exact tag (`de-DE`)
/// then its language (`de`), case-insensitively; else `default` (or "" if absent). Mirrors
/// AppManifest's locale ladder. The generated `config` accessor calls this for a localized value;
/// the Android twin resolves the same map shape, so the contract is the data, not the platform.
public enum DSXLocale {
    public static func pick(_ map: [String: String]) -> String {
        let lower = Dictionary(map.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { a, _ in a })
        for tag in Locale.preferredLanguages {
            let t = tag.lowercased()
            if let v = lower[t] { return v }
            let lang = String(t.prefix(while: { $0 != "-" && $0 != "_" }))
            if let v = lower[lang] { return v }
        }
        return map["default"] ?? ""
    }
}

/// One config value seen through `dsx.config.<key>` — the introspection wrapper over a package's
/// raw config entry. The entry is EITHER a scalar (a plain `"string"`, `true`, `42`, `[…]`) OR a
/// localized map `{ "default": …, "<locale>": … }`. `self.config.<key>` stays the typed, already-
/// resolved accessor for the common path; THIS is the "I also need the default / the locale list /
/// a specific locale / to know if it's localized" view — and it works for ANY key, localized or a
/// plain string, so `dsx.config.any_value` is always valid (an undefined key reads as `.exists == false`).
///
/// Cross-platform by construction: the backing data (`GeneratedConfigRaw`) is plain dictionaries the
/// Android twin fills identically, so the same `dsx.config` semantics port.
public struct DSXConfigValue {
    /// The raw entry exactly as codegen emitted it: a scalar, or a `[locale: String]` map (localized).
    /// `nil` when the key is not defined for this package.
    public let raw: Any?
    public init(_ raw: Any?) { self.raw = raw }

    /// The localized map IFF this value is localized — a `[String: String]` carrying a `"default"`
    /// key. `nil` for a scalar (a non-string / structured dict is NOT considered localized).
    private var map: [String: String]? {
        guard let m = raw as? [String: String], m["default"] != nil else { return nil }
        return m
    }

    /// Is the key defined at all for this package? (`false` for an unknown `dsx.config.<typo>`.)
    public var exists: Bool { raw != nil }

    /// Does this value carry per-locale variants? `false` for a plain scalar.
    public var isLocalized: Bool { map != nil }

    /// The locale tags present, EXCLUDING `"default"` (e.g. `["de-DE", "fr"]`); `[]` for a scalar.
    public var locales: [String] { (map?.keys.filter { $0 != "default" }.sorted()) ?? [] }

    /// The full per-locale map INCLUDING `"default"`. For a plain string scalar this is
    /// `["default": value]` (so callers can treat every string value uniformly); for a non-string
    /// scalar it is empty. Handy to enumerate or forward a whole table at once.
    public var byLocale: [String: String] {
        if let m = map { return m }
        if let s = raw as? String { return ["default": s] }
        return [:]
    }

    /// The development-language / fallback value — the `"default"` key of a localized map, or the
    /// scalar itself. UNIFORM by design: `dsx.config.x.default` is valid whether `x` is localized or
    /// a plain string, and an empty string stays `""`. `nil` only when the key is absent or a
    /// non-string scalar (a Bool/Int has no string default — read `.bool` / `.int` instead).
    public var `default`: String? { map?["default"] ?? raw as? String }

    /// The value resolved for THIS device: the best locale match for a localized value
    /// (`DSXLocale.pick`), otherwise the scalar as a string. This equals what `self.config.<key>`
    /// returns for a localized String key — the same resolution, just reachable generically.
    public var value: String { map.map(DSXLocale.pick) ?? (raw as? String ?? "") }

    /// The exact value for a SPECIFIC locale (BCP-47, e.g. `"de-DE"`): exact tag, then its bare
    /// language (`"de"`), then `"default"`. For a scalar, always the scalar. `nil` if nothing matches.
    public func forLocale(_ tag: String) -> String? {
        guard let m = map else { return raw as? String }
        if let v = m[tag] { return v }
        let lang = String(tag.prefix { $0 != "-" && $0 != "_" })
        return m[lang] ?? m["default"]
    }

    // Typed reads for NON-string scalars — localization only applies to strings, so these simply
    // surface the underlying scalar (`dsx.config.enabled.bool`, `dsx.config.max.int`, …).
    public var string: String { value }
    public var bool: Bool { (raw as? Bool) ?? false }
    public var int: Int { (raw as? Int) ?? Int((raw as? Double) ?? 0) }
    public var double: Double { (raw as? Double) ?? Double((raw as? Int) ?? 0) }
    public var list: [Any] { (raw as? [Any]) ?? [] }
    /// A string list — config/state list values are emitted as `[String]`; falls back to filtering a
    /// heterogeneous `[Any]`. `[]` when absent/wrong type. (`dsx.module.appsflyer.context.domains.strings`.)
    public var strings: [String] { (raw as? [String]) ?? (raw as? [Any])?.compactMap { $0 as? String } ?? [] }
}

/// `dsx.config` — read THIS package's config by key as `DSXConfigValue`s, with dynamic member
/// lookup so `dsx.config.foo` needs no generated-per-key boilerplate (an unknown key yields an
/// empty value, never a crash). Bound to the package's PRIMARY scheme, so it always reads this
/// package's own config no matter which action/alias is dispatching. The data comes from the
/// generated `GeneratedConfigRaw` — the SAME source `self.config` is generated from, so the typed
/// path and this introspection path can never drift.
@dynamicMemberLookup
public struct DSXConfigProxy {
    /// The owning package's primary scheme (the registry key).
    public let scheme: String
    public init(scheme: String) { self.scheme = scheme }

    public subscript(dynamicMember key: String) -> DSXConfigValue {
        DSXConfigValue(KernelTables.configByScheme[scheme]?[key])
    }
    /// String-keyed access for a config key that isn't a valid Swift identifier (rare).
    public subscript(_ key: String) -> DSXConfigValue {
        DSXConfigValue(KernelTables.configByScheme[scheme]?[key])
    }
}

/// A package's STATE — the typed, declared variables it PUBLISHES for other packages (and can update
/// live). `dsx.module.<scheme>.context.<var>` reads another package's; `dsx.context.<var>` is the owner's
/// own. Declared in the owner's `dsx.json` `context` block (so it's discoverable + typed), replacing
/// stringly-typed `dsx.values("a.b")` cross-package coordination.
///
/// Reads like `dsx.config`, writes/subscribes like `dsx.global` — the same two dsx idioms, kept aligned:
///   • READ      — `dsx.module.x.context.flag.bool`   (typed DOT access, like `dsx.config`; nested `.a.b.c`)
///   • PUBLISH   — `dsx.context.set("flag", true)`      (string-keyed verb, like `dsx.global.set`; nested key "a.b")
///   • SUBSCRIBE — `dsx.module.x.context.on("flag") { v in v.bool }`   (string-keyed verb, like `dsx.shared.on`)
///
/// Where it sits: `dsx.config` is a package's PRIVATE, static, read-only values; `dsx.global` is the raw,
/// un-namespaced, untyped reactive store. `state` is the middle — config's CROSS-PACKAGE, can-be-live
/// sibling. A var is STATIC (mirrors one of the owner's config values — `GeneratedConfigRaw`) or LIVE (a
/// runtime value the owner publishes via `set` — stored in the reactive `DSX.state` at `"<scheme>.<var>"`,
/// the declared default until set; nested vars live nested there). Exclusion-safe: an absent/excluded
/// owner has no `GeneratedStateRegistry` entry, so every read is the declared default (`.exists == false`)
/// — never a crash. Leaf reads delegate to `DSXConfigValue`, so typing + locale resolution never drift
/// from `dsx.config` — and, like `dsx.config`, an absent value reads as the typed default (`false`/`""`),
/// NOT an optional (that's `dsx.global`'s shape, for its "absent is normal" bag). A var named like a leaf
/// member (bool/string/set/on/…) is shadowed by it — reach it with the string subscript,
/// `dsx.module.x.context["bool"].bool`.
@dynamicMemberLookup
public struct DSXStateProxy {
    /// The owning/target package's primary scheme (the registry key).
    public let scheme: String
    /// The accumulated dot-path being addressed ("" at the root `dsx.context` / `….context`).
    public let path: String
    public init(scheme: String, path: String = "") { self.scheme = scheme; self.path = path }

    /// Drill one level deeper (`.foo` ⇒ path "foo", then `.bar` ⇒ "foo.bar"). The explicit leaf members
    /// below win over this, so `.bool` / `.set` / … resolve the value rather than drilling.
    public subscript(dynamicMember key: String) -> DSXStateProxy { descend(key) }
    /// String-keyed drill for a var/segment that isn't a valid Swift identifier (rare).
    public subscript(_ key: String) -> DSXStateProxy { descend(key) }
    private func descend(_ key: String) -> DSXStateProxy {
        DSXStateProxy(scheme: scheme, path: path.isEmpty ? key : "\(path).\(key)")
    }

    /// The raw value at (scheme, path). The TOP segment selects the var: STATIC ⇒ its config value
    /// (a leaf — config-backed vars don't nest); LIVE ⇒ the reactive store at the full path (nested-
    /// capable), falling back to the declared default at the leaf. Unknown/excluded var ⇒ nil.
    public var raw: Any? {
        guard !path.isEmpty else { return nil }
        let top = String(path.prefix { $0 != "." })
        guard let field = KernelTables.stateByScheme[scheme]?[top] else { return nil }
        if let source = field["source"] as? String {                          // static: mirrors a config key
            return path == top ? KernelTables.configByScheme[scheme]?[source] : nil
        }
        return DSX.state.getPath("\(scheme).\(path)") ?? (path == top ? field["default"] : nil)   // live (+ default)
    }

    /// Typed leaf reads — delegate to `DSXConfigValue` so typing + locale resolution match `dsx.config`.
    private var leaf: DSXConfigValue { DSXConfigValue(raw) }
    public var exists: Bool { leaf.exists }
    public var bool: Bool { leaf.bool }
    public var string: String { leaf.value }   // device-locale resolved, like self.config.<key>
    public var int: Int { leaf.int }
    public var double: Double { leaf.double }
    public var list: [Any] { leaf.list }
    public var strings: [String] { leaf.strings }

    /// PUBLISH a LIVE var (the `setState` of the model) — `dsx.context.set("flag", true)`, nested via a
    /// dot-path key `set("a.b", v)`. String-keyed to match `dsx.global.set` / `dsx.values.set` and the
    /// event verbs. Writes the reactive `DSX.state`, so consumers — and `dsx.global` / the web layer —
    /// see it. Owner-only; a static (config-sourced) var has no live slot, so a write there is inert.
    public func set(_ key: String, _ value: Any) {
        let p = path.isEmpty ? key : "\(path).\(key)"
        #if DEBUG
        // Catch the footgun: writing a STATIC var (config-mirror) is inert — reads come from config,
        // not the live store. Either declare it live (drop the config source) or stop writing it.
        let top = String(p.prefix { $0 != "." })
        if let src = KernelTables.stateByScheme[scheme]?[top]?["source"] as? String {
            print("[dsx.context] ⚠️ set(\"\(p)\") on '\(scheme)': '\(top)' is STATIC (mirrors config '\(src)') — this write is inert; reads resolve from config. Make it a live var to publish at runtime.")
        }
        #endif
        DSX.state.setPath("\(scheme).\(p)", value)
    }

    /// SUBSCRIBE to a var — `dsx.module.x.context.on("flag") { v in v.bool }`. String-keyed to match the
    /// event verbs (`dsx.delegate.listen`). Fires NOW with the current value (like `useEffect`'s first run), then on
    /// every change. Returns an `AnyCancellable` — keep it to stay subscribed, drop it to stop. A static
    /// var fires once (never changes); a live var re-fires when the owner publishes a new value.
    @discardableResult
    public func on(_ key: String, _ handler: @escaping (DSXStateProxy) -> Void) -> AnyCancellable {
        let target = descend(key)
        let (s, p) = (target.scheme, target.path)
        handler(target)
        var last = target.raw
        return DSX.state.$vars
            .receive(on: DispatchQueue.main)
            .sink { _ in
                let now = DSXStateProxy(scheme: s, path: p)
                guard !DSXStateProxy.sameRaw(last, now.raw) else { return }
                last = now.raw
                handler(now)
            }
    }

    /// Dedupe successive resolves so `on` only fires on a real change (DSX.state is a `[String: Any]`,
    /// not Equatable — bridge to `NSObject` for the comparison; scalars/strings/arrays bridge cleanly).
    private static func sameRaw(_ a: Any?, _ b: Any?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (x?, y?): return (x as AnyObject).isEqual(y)
        default: return false
        }
    }
}

/// Resolves `{{ dsx.* }}` references embedded in a config STRING value at READ time, against the
/// live store — the SAME `dsx.` root markup uses. So `webview_url: "https://{{ dsx.app.host }}/app"`
/// yields the per-locale host on this device, exactly as `{{ dsx.app.host }}` would in a `.dsx`.
/// Runtime-only by design: `dsx.app.host` is per-locale, so it can't bake at build time the way the
/// pipeline's `{{ env.* }}` plist substitution does (that's a separate plane, untouched here). The
/// generated config accessor calls this when a string carries `{{ dsx.… }}`; see prepare_config.rb.
///
/// A config read is ONE stage of a token's pipeline, and it consumes ONLY the tokens addressed to
/// it: the app-store scopes (`dsx.app.*` / `dsx.global.*` / `dsx.screen.*` — whatever normalizes to
/// `global.*`). Every other `{{ … }}` span is PRESERVED verbatim, because it belongs to a LATER
/// stage — a Live-Activity / widget layout sourced into config carries `{{ dsx.variable.* }}`
/// bindings that only the EXTENSION's renderer can resolve (StackScope, against the ContentState
/// vars). Eating those here shipped layouts whose every binding was already blanked — the lock
/// screen rendered structure with no name/status and a dead gauge.
public enum DSXConfigTemplate {
    private static let token = try! NSRegularExpression(pattern: #"\{\{\s*([^}]+?)\s*\}\}"#)

    /// Substitute every STORE-scoped `{{ dsx.<scope>.<path> }}` span (absent path → empty, the
    /// markup semantics); any other span — `{{ dsx.variable.x }}`, `{{ env.X }}` — passes through
    /// untouched for its own stage. A string with no "{{" is returned as-is (the cheap common case).
    public static func resolve(_ s: String) -> String {
        guard s.contains("{{") else { return s }
        let ns = s as NSString
        var out = ""
        var cursor = 0
        for m in token.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
            out += lookup(ns.substring(with: m.range(at: 1))) ?? ns.substring(with: m.range)
            cursor = m.range.location + m.range.length
        }
        return out + ns.substring(from: cursor)
    }

    /// The store value for an addressed token, or nil for a token this stage must not consume.
    private static func lookup(_ tok: String) -> String? {
        // Reuse the engine's own scope mapping so a config token resolves identically to the same
        // read in markup: dsx.app.host -> global.app.host -> DSX.state. Non-store scopes are NOT
        // ours (dsx.variable.* is the surface/extension namespace) -> preserve the span.
        guard tok.hasPrefix("dsx.") else { return nil }
        let norm = JSE.normalizeScope(tok)
        guard norm.hasPrefix("global.") else { return nil }
        let v = DSX.state.getPath(String(norm.dropFirst("global.".count)))
        return (v as? String) ?? (v.map { "\($0)" } ?? "")
    }
}

extension StackStore {
    /// Read a dot-path against `vars` — walks nested dictionaries AND arrays (a numeric
    /// segment indexes an array, bounds-checked), mirroring the expression resolver.
    func getPath(_ path: String) -> Any? {
        guard let parts = DsxStatePathPolicy.segments(path, allowEmpty: true) else { return nil }
        var cur: Any? = vars
        for seg in parts {
            if let i = DsxStatePathPolicy.arrayIndex(seg), let arr = cur as? [Any] {
                cur = i < arr.count ? arr[i] : nil
            } else { cur = (cur as? [String: Any])?[seg] }
        }
        return cur
    }

    /// Write a dot-path into `vars`, creating intermediate dictionaries/arrays. Numeric
    /// segments index arrays (`feed.data.5.name`), growing with empty dicts as needed —
    /// the write counterpart to getPath, so state is editable wherever it's readable.
    /// Re-publishes the affected TOP-LEVEL key (coarse but glitch-free for UI).
    func setPath(_ path: String, _ value: Any) {
        guard let parts = DsxStatePathPolicy.segments(path) else { return }
        guard let head = parts.first else { return }
        guard vars[head] != nil || vars.count < DsxStatePathPolicy.maxContainerEntries else { return }
        if parts.count == 1 { set(head, value); return }
        guard let rebuilt = DsxStatePathPolicy.rebuild(vars[head], parts.dropFirst(), value) else { return }
        set(head, rebuilt)   // re-publishes vars[head]
    }

    /// Write a BOUND value to the right scope, PATH-AWARE: `global.*` / `route.*` → the app
    /// store (DSXState), else this (surface) store — nested + array-index, so `bind="user.email"`
    /// edits the `email` key of the `user` object var in place (`bind="x"` stays a flat var).
    /// `$`-namespaces normalize first. Mirrors `set:` / expression writes, so bindings, verbs and
    /// `{{ }}` reads all agree on where a path lives.
    func writeBound(_ rawKey: String, _ value: Any) {
        let key = JSE.normalizeScope(rawKey)
        if key.hasPrefix("global.") { DSX.state.setPath(String(key.dropFirst(7)), value) }
        else if key.hasPrefix("route.") { DSX.state.setPath(key, value) }
        else { setPath(key, value) }
    }

}
