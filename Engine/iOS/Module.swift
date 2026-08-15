//
//  Module.swift
//  DespiaScript
//
//  Despia LLC-FZ
//  Meydan Grandstand, 6th Floor, Meydan Road,
//  Nad Al Sheba, Dubai, United Arab Emirates
//  support@despia.com
//
//  The Module base class and the registry that discovers and routes to packages.
//

import Foundation
import UIKit

/// Namespace for every DespiaScript package, so a package's entry class can keep a
/// clean name (`DSX.Store`) without colliding with SDK types like `RevenueCat.Store`.
/// Mirrors Android's `package DSX`. Declare a package as:
///     extension DSX { final class Store: Module { override class var scheme: String { "store" } } }
public enum DSX {}

@objc(DespiaModule)
open class Module: NSObject {

    /// URI scheme this package claims (e.g. `"purchase"`). Prefer declaring it
    /// once in `dsx.json` (`"scheme": "purchase"`), bound to this class by
    /// codegen. Override only to set it in code; an override wins over the
    /// manifest. Empty + no manifest binding => "abstract, skip me".
    open class var scheme: String { "" }

    /// Effective scheme used by the registry: the `scheme` override if present,
    /// else the manifest-declared scheme. This is what makes the override optional.
    public class var resolvedScheme: String {
        let declared = scheme
        guard declared.isEmpty else { return declared }
        return KernelTables.moduleSchemeByClassName[String(describing: self)] ?? ""
    }

    /// Extra schemes routed to this package, from `dsx.json` `aliases`
    /// (legacy or data-in-host schemes - e.g. `readhealthkit`, `writehealthkit`).
    /// Handle them in the pre-filter (`dsx.action { }`) by inspecting `dsx.command()`.
    class var resolvedAliases: [String] {
        KernelTables.moduleAliasesByClassName[String(describing: self)] ?? []
    }

    /// This package's registration store (action map, hydrations, schemes).
    let registration: Registration

    /// The package handle: register actions/hydrations in `setup()`, and fire
    /// out-of-band `broadcast` / `variable` / `function` from anywhere (delegate
    /// callbacks, lifecycle hooks). Each per-call handler receives its own `dsx`.
    public var dsx: Context { Context(store: registration) }

    public required override init() {
        self.registration = Registration(primaryScheme: Self.resolvedScheme,
                                          aliases: Self.resolvedAliases)
        super.init()
        setup()
    }

    /// Override to register actions and hydrations. Called once at package
    /// instantiation (before the first navigation). Don't emit from here - the
    /// web view isn't bound yet; emit inside `action` / `hydrate` closures.
    open func setup() {}

    /// BOOT TIER opt-in. `true` → this package is instantiated in `ModuleRegistry.boot()`
    /// — synchronously at the TOP of `didFinishLaunching`, BEFORE the first frame — so it
    /// can claim boot-time events (`boot.splash`). The contract that makes this safe:
    /// a boot-eligible package's `setup()` must be **instant** — listen/action registration
    /// only; no SDK init, no I/O, no network (those are exactly the side effects the
    /// deferred full bootstrap protects the splash paint from — kernelization doc §4).
    open class var bootEligible: Bool { false }

    /// SCHEME-LESS opt-in. `true` → register this package even though it owns no URL scheme,
    /// so a WATCH-ONLY package (no URL-scheme surface — it only `dsx.delegate.listen`s for
    /// lifecycle events, or fills a kernel seam) still gets its `setup()` run and joins the
    /// delegate fan-out. Without this the registry skips schemeless classes (a missing scheme is usually a
    /// misconfiguration). It owns no route map entry (its `schemes` set is empty by construction).
    open class var registersWithoutScheme: Bool { false }
}

public final class ModuleRegistry {

    public static let shared = ModuleRegistry()

    private let lock = NSLock()
    /// Scheme -> package. One package can appear under several schemes (primary
    /// + aliases + legacy action schemes), so this is a route table.
    private var routes: [String: Module] = [:]
    /// Unique package instances, for lifecycle/hydration fan-out (a package
    /// claiming N schemes must still be visited once).
    private var allPackages: [Module] = []
    private var didBootstrap = false

    private init() {}

    // MARK: - Registration

    /// Manually register a package. Rarely needed - `bootstrap()` finds
    /// every Module subclass automatically. Useful for tests or for
    /// late-binding packages constructed with non-default arguments.
    public func register(_ packageType: Module.Type) {
        guard !packageType.resolvedScheme.isEmpty || packageType.registersWithoutScheme else {
            kernelLog("[ModuleRegistry] Ignoring \(packageType) - no scheme (manifest or override)")
            return
        }
        let plugin = packageType.init()
        // `dsx` is RESERVED (the error-system's global mirror channel, error-system.md §3.3b) —
        // a module claiming it would shadow every app's global error listener. Refused, loudly.
        if plugin.registration.schemes.contains(where: { $0.lowercased() == "dsx" }) {
            kernelLog("[ModuleRegistry] Refusing \(packageType) — scheme \"dsx\" is reserved (the error-system mirror)")
            return
        }
        lock.lock(); defer { lock.unlock() }
        allPackages.append(plugin)
        for rawScheme in plugin.registration.schemes {
            let scheme = rawScheme.lowercased()   // URL schemes are case-insensitive (RFC 3986) — key lowercase
            if let existing = routes[scheme] {
                kernelLog("[ModuleRegistry] Replacing \(type(of: existing)) with \(packageType) for scheme '\(scheme)'")
            }
            routes[scheme] = plugin
        }
        identityCache = nil
    }

    /// Currently-registered scheme names (snapshot, sorted).
    public var registeredSchemes: [String] {
        lock.lock(); defer { lock.unlock() }
        return Array(routes.keys).sorted()
    }

    /// `true` if a Module claiming `scheme` is loaded in this build. The
    /// generic answer to "should I run code that depends on a specific
    /// package?" - if the package's been excluded via DSX/Modules/Config/excluded.json
    /// the scheme isn't registered and this returns false. Host code wraps
    /// the package-specific branch in this check; surrounding work (caching
    /// the file, returning the response, …) runs regardless.
    ///
    ///     // Cache always; let any loaded package decorate the event.
    ///     self.cacheFile(at: path)
    ///     NotificationCenter.default.post(name: .downloadStarted,
    ///                                     object: nil, userInfo: payload)
    ///     if ModuleRegistry.shared.isAvailable("liveactivity") {
    ///         // optional: any extra work that's only meaningful when the
    ///         // package is on (analytics tag, log line, prefetch a token …)
    ///     }
    ///
    /// Pure runtime - no compile-time coupling, no `#if`, no shared-kernel
    /// slot named after the package.
    public func isAvailable(_ scheme: String) -> Bool {
        let key = scheme.lowercased()
        lock.lock(); defer { lock.unlock() }
        return routes.keys.contains(key)
    }

    // MARK: - Derived identity (ChainResolver — Conformance/chains)

    /// Build-known identities NOT in this build (the excluded overlay): chain → its
    /// DespiaExcluded entry (`reason` "excluded" | "cascade" [+ `from`]). Set once by the
    /// host bootstrap so chain resolution and the `.excluded` build fact stay honest for
    /// modules that exist in the product but not this binary.
    private var excludedIdentities: [String: [String: Any]] = [:]
    private var identityCache: ChainResolver.Table?

    public func setExcludedIdentities(_ map: [String: [String: Any]]) {
        lock.lock(); defer { lock.unlock() }
        excludedIdentities = Dictionary(uniqueKeysWithValues: map.map { ($0.key.lowercased(), $0.value) })
        identityCache = nil
    }

    /// The DespiaExcluded entry for `chain`, or nil when it ships (or never existed) —
    /// backs `dsx.module.<chain>.excluded`. LEGACY ALIAS spellings answer the same
    /// honest fact: an excluded module is unregistered, so the live alias table can
    /// never normalize its spellings — the overlay entries carry them instead
    /// ("aliases", comma-joined, straight from the manifest) and the page's
    /// matchesEntry answers them 1:1, so the native member must too.
    public func excludedEntry(for chain: String) -> [String: Any]? {
        let key = chain.lowercased()
        lock.lock(); defer { lock.unlock() }
        if let direct = excludedIdentities[key] { return direct }
        return excludedIdentities.values.first { entry in
            guard let spelled = entry["aliases"] as? String else { return false }
            return spelled.lowercased().split(separator: ",")
                .contains { $0.trimmingCharacters(in: .whitespaces) == key }
        }
    }

    /// The live identity view the dispatch fold runs against: every registered module's
    /// PRIMARY chain, every other registered spelling as an alias to it, plus the excluded
    /// overlay. Cached; `register()` / `setExcludedIdentities` invalidate.
    public func identityTable() -> ChainResolver.Table {
        lock.lock(); defer { lock.unlock() }
        if let cached = identityCache { return cached }
        var chains = Set<String>()
        var aliases: [String: String] = [:]
        for plugin in allPackages {
            let primary = type(of: plugin).resolvedScheme.lowercased()
            guard !primary.isEmpty else { continue }
            chains.insert(primary)
            for spelling in plugin.registration.schemes where spelling.lowercased() != primary {
                aliases[spelling.lowercased()] = primary
            }
        }
        let table = ChainResolver.Table(chains: chains, aliases: aliases,
                                        excluded: Set(excludedIdentities.keys))
        identityCache = table
        return table
    }

    /// The action names `scheme` answers IN-PROCESS right now — the diagnostics companion to
    /// `isAvailable`: the unknown-action funnel line names what WOULD have routed, so a typo'd
    /// call (`injct`) reads as "known actions: inject, eval, …" instead of a bare miss. Mirrors
    /// `Registration.dispatch` resolution exactly: a scheme with its own `dsx.scheme` table is
    /// isolated (that table only), any other owned scheme reads the shared `named` table, and
    /// in-process callers additionally reach `internalNamed`. Keys are stored lowercased at
    /// registration; sorted here for stable log lines. Empty for an unregistered scheme.
    public func actionNames(_ scheme: String) -> [String] {
        let key = scheme.lowercased()
        lock.lock()
        let plugin = routes[key]
        lock.unlock()
        guard let plugin else { return [] }
        let reg = plugin.registration
        var names = Set(reg.internalNamed.keys)
        if let scoped = reg.schemeNamed[key] {
            names.formUnion(scoped.keys)
        } else {
            names.formUnion(reg.named.keys)
        }
        return names.sorted()
    }

    // MARK: - Platform support (the graceful unsupported-platform answer)

    /// FULL-CATALOG platform support: scheme/alias (lowercase) → the platforms that implement
    /// the owning module (e.g. "barcodescanner" → ["android"]). Filled by the generated registry —
    /// `boot()` installs the map prepare_config.rb computes from concrete lane source
    /// (including fail-closed macOS/Windows/Linux facets) into
    /// Registry/ModulePlatformSupport.generated.swift. DEFAULT EMPTY = today's behavior: a bare
    /// kernel answers not_loaded for everything unhandled.
    ///
    /// Every not_loaded answer consults this FIRST, so the three unhandled situations stay
    /// distinct (constitution Article 7 — honest degradation):
    ///   • in the catalog, NO implementation on this OS → `unsupported_platform` (structured)
    ///   • implemented here but excluded by THIS app    → `not_loaded` (the app's choice)
    ///   • not in the catalog at all (unknown scheme)   → `not_loaded` (today's behavior)
    /// `isAvailable` / `dsx.has` stays FALSE for all three — feature detection remains the
    /// primary pattern; `unsupported_platform` is the honest answer when someone calls anyway.
    public var platformSupport: [String: [String]] = [:]

    /// This kernel's deployment target in `platformSupport` lists. A Catalyst build is a
    /// macOS product even though it uses UIKit compatibility, so it must never report iOS or
    /// accept an iOS-only package as supported. Keep this compile-time and immutable: the
    /// kernel is still the platform; Catalyst simply gives the Swift lane a second target.
    public var currentPlatform: String {
        #if targetEnvironment(macCatalyst) || os(macOS)
        return "macos"
        #else
        return "ios"
        #endif
    }

    /// Non-nil ⇒ `scheme` exists in the FULL module catalog but has NO implementation on this
    /// platform — the returned list names the platforms that DO implement it. Nil ⇒ supported
    /// here, or unknown scheme, or no catalog installed: the caller falls through to today's
    /// `not_loaded` behavior. Case-insensitive (schemes are routing keys, keyed lowercase).
    public func unsupportedPlatforms(_ scheme: String) -> [String]? {
        lock.lock(); let supported = platformSupport[scheme.lowercased()]; lock.unlock()
        guard let supported, !supported.contains(currentPlatform) else { return nil }
        return supported
    }

    /// The pinned `unsupported_platform` envelope message — "<Name> is not supported on
    /// iOS" (Name = the scheme, first letter uppercased). Byte-identical on both
    /// platforms by contract: OpenSource/Skills/android/api-mapping.md "Unsupported platform".
    public func unsupportedPlatformMessage(_ scheme: String) -> String {
        let lower = scheme.lowercased()
        let name = lower.prefix(1).uppercased() + lower.dropFirst()
        return "\(name) is not supported on \(Self.platformDisplayName(currentPlatform))"
    }

    /// The pinned `unsupported_platform` envelope data — { scheme, platform,
    /// supportedPlatforms } (same contract as the message above).
    public func unsupportedPlatformData(_ scheme: String, _ supported: [String]) -> [String: Any] {
        ["scheme": scheme.lowercased(), "platform": currentPlatform,
         "supportedPlatforms": supported]
    }

    /// Human display names for the platform ids used in `platformSupport` lists
    /// (the desktop ids join per desktop-platforms.md; unknown ids keep the
    /// capitalize fallback so a future target degrades readably, never crashes).
    private static func platformDisplayName(_ id: String) -> String {
        switch id {
        case "ios":     return "iOS"
        case "android": return "Android"
        case "web":     return "Web"
        case "macos":   return "macOS"
        case "windows": return "Windows"
        case "linux":   return "Linux"
        default:        return id.prefix(1).uppercased() + id.dropFirst()
        }
    }

    // MARK: - Host-event hooks (the dynamic, cross-platform delegate surface)

    /// The fold policy for a delegate event — how `dispatch` collapses every watcher's answer.
    /// This single enum *is* what the four deleted fire-verbs used to encode in their NAMES:
    /// `void` = the old fire, `any` = fireAny, `claim` = claim, `collect` = collect, plus `veto`
    /// (deny if any answers `false`). `dsx.delegate.send(name, combine:)` takes it directly. Nested under
    /// ModuleRegistry on purpose — a top-level `Combine` would collide with Apple's Combine
    /// framework (imported in DSXState/Router and several modules).
    public enum Combine {
        case void, any, claim, collect, veto

        /// Map a `dsx.json`-declared policy string ("veto", "any", …) to the typed case, so the
        /// `send` primitive can read the emitter's declared `combine` from GeneratedDelegateRegistry.
        /// `nil` for an unknown/absent string ⇒ the caller falls back to `.claim` (the
        /// undeclared default).
        public init?(declared raw: String?) {
            switch raw {
            case "void":    self = .void
            case "any":     self = .any
            case "claim":   self = .claim
            case "collect": self = .collect
            case "veto":    self = .veto
            default:        return nil
            }
        }
    }

    /// THE delegate fold — the ONE and ONLY place every cross-module event collapses. A watcher
    /// attaches via `dsx.delegate.listen` (priority-ordered); `dispatch` runs them all and combines
    /// per `combine`. `dsx.delegate.send` lowers straight here in ONE hop — there is no other
    /// pipeline and no verb in between (delegates.md phase 4, the collapse: the four legacy
    /// fire-verbs `fire`/`fireAny`/`claim`/`collect` are DELETED; `combine` *is* the difference
    /// they used to spell out, and that difference now lives only here):
    ///   .void    run all, ignore answers (notification) + ALIAS fan-out → nil
    ///   .any     run all; `true` if any answered non-nil (consumed)  → Bool   (openURL parity — NOT Bool-true)
    ///   .claim   first non-nil answer wins (ownership)               → Any?   (short-circuits)
    ///   .collect every non-nil answer, in priority order             → [Any]
    ///   .veto    `false` if any watcher returned Bool `false`        → Bool   (short-circuits on first denier)
    ///
    /// ALIAS fan-out (the module-events plane, `.void` ONLY): a module-scoped event name —
    /// "<chain>.<kind>" — ALSO folds under each legacy alias spelling of that chain
    /// ("watchhealth.heartRate"), so an alias handle's `.on` watcher hears the module's events
    /// regardless of WHEN it subscribed — the live table cannot normalize an alias whose owner
    /// registers later, and boot order must never decide whether a watcher hears (review round 3).
    /// Broadcast (`.void`) only — claim/veto planes answer OWNERSHIP and must never double-invoke.
    /// Alias spellings are never chains, so the fan-out cannot recurse. It lives INSIDE the fold,
    /// not in a caller-side wrapper: the deleted `fire` shim carried it, and deleting a shim must
    /// never drop behavior — `dsx.delegate.send(…, combine: .void)` keeps it.
    @discardableResult
    public func dispatch(_ event: String, _ input: Any? = nil, _ combine: Combine = .void) -> Any? {
        let handlers = orderedHooks(event)
        switch combine {
        case .void:
            for h in handlers { _ = h(input) }
            for spelled in aliasSpellings(of: event) {
                for h in orderedHooks(spelled) { _ = h(input) }
            }
            return nil
        case .any:
            // Non-nil (not Bool-true) = "handled": some openURL/continueActivity watchers consume
            // by returning the URL or `true`, so anything non-nil counts. Every watcher still runs.
            var handled = false
            for h in handlers { if h(input) != nil { handled = true } }
            return handled
        case .claim:
            for h in handlers { if let result = h(input) { return result } }
            return nil
        case .collect:
            return handlers.compactMap { $0(input) }
        case .veto:
            return !handlers.contains { ($0(input) as? Bool) == false }
        }
    }

    /// The alias spellings of a module-scoped event name: the LONGEST dot-boundary
    /// prefix that is a chain with aliases rewrites to each alias + the verbatim
    /// remainder. Empty for non-module names (no chain prefix, or none aliased).
    func aliasSpellings(of event: String) -> [String] {
        let table = identityTable()
        guard !table.aliasesByChain.isEmpty else { return [] }
        var idx = event.endIndex
        while let dot = event[..<idx].lastIndex(of: ".") {
            let prefix = String(event[..<dot]).lowercased()
            if let aliases = table.aliasesByChain[prefix] {
                let rest = String(event[dot...])
                return aliases.map { $0 + rest }
            }
            idx = dot
        }
        return []
    }

    // The four legacy fire-verbs (`fire` / `claim` / `fireAny` / `collect`) were DELETED by
    // delegates.md phase 4 — the collapse. Every emitter now names its fold explicitly:
    //   fire(e, i)     → dispatch(e, i, .void)      (dsx.delegate.send(e, i, combine: .void))
    //   claim(e, i)    → dispatch(e, i, .claim)     (dsx.delegate.send(e, i, combine: .claim))
    //   fireAny(e, i)  → (dispatch(e, i, .any)     as? Bool)  ?? false
    //   collect(e, i)  → (dispatch(e, i, .collect) as? [Any]) ?? []
    // ONE fold, ONE spelling; the combine policy carries the meaning the verb name used to.

    /// Every watcher registered for `event` across ALL packages, ordered by priority (desc),
    /// ties broken by registration order (stable). Sorts GLOBALLY across packages — not within
    /// one — because the fold needs a single ordered pipeline; the naive per-package
    /// sort would be wrong since this iterates `allPackages` first. Priority 0 reproduces today's
    /// exact `allPackages` × registration order (behavior-neutral). `n` per event is tiny.
    private func orderedHooks(_ event: String) -> [(Any?) -> Any?] {
        let snapshot: [Module]
        lock.lock(); snapshot = allPackages; lock.unlock()
        var entries: [(priority: Int, order: Int, handler: (Any?) -> Any?)] = []
        var order = 0
        for pkg in snapshot {
            for entry in pkg.registration.hooks[event] ?? [] {
                entries.append((entry.priority, order, entry.handler)); order += 1
            }
        }
        entries.sort { $0.priority != $1.priority ? $0.priority > $1.priority : $0.order < $1.order }
        return entries.map { $0.handler }
    }

    // MARK: - Dispatch

    /// Returns `true` if a package handled this URL. `false` means no package
    /// owns the scheme, or the scheme is owned but neither a pre-filter nor a
    /// named action took it - both fall through to the inline handler chain.
    /// `includeInternal` is forwarded to the package's `dispatch`: the in-process `dsx.module` path
    /// passes `true` (so a package reaches its own `dsx.action(exposed:false)` internals); the web/URL
    /// relay leaves it `false`, keeping internal actions off the untrusted bus.
    public func handle(url: URL, params: Bridge.Params, includeInternal: Bool = false) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }   // case-insensitive (RFC 3986): `LPA:` → `lpa`

        // Derived-identity FOLD for the URL wire (ChainResolver, Conformance/chains): a
        // legacy navigation can spell a nested call as `watch://health.heartRate` — when
        // leading action segments name a DEEPER known identity, delegate to the string
        // funnel under the folded owner with the VERBATIM remainder (original separators
        // and case — dotted group keys keep their grammar; a reserved word simply
        // dispatches as a plain action there, the wire face never refuses). Nothing
        // folded ⇒ the direct URL route below, arriving spelling preserved for
        // catch-all pre-filters (the legacy contract).
        let urlPath = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
        let actionPath = [url.host ?? "", urlPath].filter { !$0.isEmpty }.joined(separator: "/")
        if !actionPath.isEmpty {
            let r = ChainResolver.resolveWire(scheme: scheme, actionPath: actionPath, table: identityTable())
            if r.folded > 0 {
                return handle(scheme: r.chain, actionPath: r.rest,
                              params: params, includeInternal: includeInternal)
            }
        }

        lock.lock()
        let plugin = routes[scheme]
        lock.unlock()

        guard let plugin = plugin else { return false }

        // The registry hands a fresh per-call `dsx` to the package's pre-filter
        // / named handler. There is no ambient bound state: async tails simply
        // capture the `dsx` they were given.
        let host = url.host ?? ""
        return plugin.registration.dispatch(scheme: scheme, host: host, url: url,
                                            params: params, includeInternal: includeInternal)
    }

    /// STRING-KEYED dispatch — the routing entry for every STRUCTURED call path
    /// (the web's object-body transport, native `dsx.module` calls, messenger
    /// mounts). A package scheme is a routing KEY, not URL grammar: identifier
    /// names like `godot_test` are fully legal here even though RFC 3986 forbids
    /// `_` in a URL scheme (only the LEGACY literal `scheme://` navigation path,
    /// which parses real URLs, stays bound by URL grammar — browsers can't emit
    /// those anyway). Internally a carrier URL is synthesized under the fixed
    /// `dsx-call` scheme purely so handlers keep their url.host/path view of the
    /// action — the app-defined scheme never has to survive a URL parser again.
    public func handle(scheme rawScheme: String, actionPath rawActionPath: String,
                       params: Bridge.Params, includeInternal: Bool = false) -> Bool {
        var scheme = rawScheme.lowercased()
        var actionPath = rawActionPath
        guard !scheme.isEmpty else { return false }

        // The derived-identity FOLD at the string funnel (Kotlin twin parity —
        // Conformance/chains): when leading action segments name a DEEPER known identity,
        // route to the folded owner with the VERBATIM remainder (original separators and
        // case — dotted group keys keep their registration grammar). NO reserved_member
        // refusal here — this funnel also serves the page's structured transport and the
        // wire, and only the MODERN faces refuse (the corpus face-split): a member word
        // simply dispatches as a plain action on the folded chain (a code-only shim
        // answers; an unregistered name answers unknown_action). Nothing folded ⇒
        // bit-for-bit today's route under the arriving spelling.
        if !actionPath.isEmpty, scheme != "dsx" {
            let r = ChainResolver.resolveWire(scheme: scheme, actionPath: actionPath, table: identityTable())
            if r.folded > 0 {
                scheme = r.chain
                actionPath = r.rest
            }
        }

        // The KERNEL answers the reserved scheme's verbs (`dsx.log` / `dsx.error` — dot
        // notation IS the API; the scheme is only a bus routing key)
        // before any module route — `dsx` is refused to modules at register() above, so
        // there is never a collision. This is how the web PAGE reaches the log ring and
        // the ambient error fan-out (`despia.log(...)` / window.onerror forwarding in
        // runtime.js), and how any bus caller does; an unknown verb answers
        // `unknown_action` honestly through the shared Registration fall-through.
        // `dsx.has("dsx")` stays false — a kernel channel, not a module.
        let registration: Registration
        if scheme == "dsx" {
            registration = Self.kernelVerbs
        } else {
            lock.lock()
            let plugin = routes[scheme]
            lock.unlock()
            guard let plugin = plugin else { return false }
            registration = plugin.registration
        }

        let trimmed = actionPath.hasPrefix("/") ? String(actionPath.dropFirst()) : actionPath
        let segments = trimmed.split(separator: "/").map(String.init)
        // Foundation lowercases url.host, so the URL path delivered actions
        // lowercased — keep that contract for the first segment.
        let host = (segments.first ?? "").lowercased()
        let rest = segments.dropFirst().joined(separator: "/")
        var raw = "dsx-call://" + host + (rest.isEmpty ? "" : "/" + rest)
        if let rid = params.requestID, !rid.isEmpty {
            raw += "?__rid=" + (rid.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? rid)
        }
        guard let url = URL(string: raw) else { return false }
        return registration.dispatch(scheme: scheme, host: host, url: url,
                                     params: params, includeInternal: includeInternal)
    }

    /// The reserved scheme's kernel verbs (logs corpus / errors corpus): `log` records one
    /// line ({ message, scheme? } — source defaults to "page", the bridge's caller),
    /// `error` runs the ambient fan-out ({ code, message?, recoverable?, data?, scheme? }).
    /// Both resolve null. The skip-prefilter makes an unknown verb fall through to the
    /// Registration's `unknown_action` answer — never a misleading not_loaded.
    private static let kernelVerbs: Registration = {
        let reg = Registration(primaryScheme: "dsx", aliases: [])
        reg.prefilter = { dsx in dsx.skip() }
        reg.named["log"] = { dsx in
            var source = (dsx.args("scheme") as? String) ?? ""
            if source.isEmpty { source = "page" }
            reportLog(scheme: source, level: "log",
                      message: JSE.string(dsx.args("message") ?? ""))
            dsx.resolve()
        }
        reg.named["error"] = { dsx in
            var source = (dsx.args("scheme") as? String) ?? ""
            if source.isEmpty { source = "page" }
            var code = JSE.string(dsx.args("code") ?? "")
            if code.isEmpty { code = "error" }
            var message: String?
            if let m = dsx.args("message"), !(m is NSNull) { message = JSE.string(m) }
            reportAmbientError(scheme: source, code: code, message: message,
                               recoverable: JSE.truthy(dsx.args("recoverable")),
                               data: dsx.args("data"))
            dsx.resolve()
        }
        return reg
    }()

    // MARK: - Hydration

    /// Run every module's registered `runtime.hydrate { ... }` block — called after `runtime.js` is
    /// in place (`window.virtual` exists, emits land cleanly). WebKit-free: the dom module publishes
    /// the `"web"` shared handle and calls this; the kernel names no web view.
    public func runHydrations() {
        let snapshot: [Module]
        lock.lock()
        snapshot = allPackages
        lock.unlock()

        for plugin in snapshot {
            for block in plugin.registration.hydrations {
                block(plugin.dsx)
            }
        }
    }

    /// Run every module's registered `dsx.ready { ... }` block — the page has settled, `<body>` is
    /// parsed. WebKit-free (the dom module owns the web view).
    public func runReady() {
        let snapshot: [Module]
        lock.lock()
        snapshot = allPackages
        lock.unlock()

        for plugin in snapshot {
            for block in plugin.registration.readyBlocks {
                block(plugin.dsx)
            }
        }
    }

    // MARK: - Bootstrap (two phases: the BOOT tier, then everything)

    /// Module types found by the class walk but NOT boot-eligible — instantiated by
    /// `bootstrap()` (the deferred phase). Filled by `boot()`.
    private var deferredPackageTypes: [Module.Type] = []
    private var didBoot = false

    /// PHASE 1 — the BOOT TIER. One class walk (sub-millisecond, bundle-filtered):
    /// registers every Stack component (table inserts — no instances, so a boot-claimed
    /// DSX surface can render any shipped tag) and instantiates ONLY packages that declare
    /// `bootEligible` (their `setup()` must be instant — see the contract on the property).
    /// Everything else is stashed for `bootstrap()`. Call synchronously at the very top of
    /// `didFinishLaunching`, then `dispatch("boot.splash", nil, .claim)` — a package can own the first
    /// frame without dragging every SDK init ahead of the splash paint.
    public func boot() {
        lock.lock()
        if didBoot { lock.unlock(); return }
        didBoot = true
        lock.unlock()
        // The class walk installs the BUILD TABLES first (KernelTables.swift), then registers
        // modules — that order is load-bearing: a module's `resolvedScheme` reads
        // `KernelTables.moduleSchemeByClassName` the instant it registers, so tables installed
        // afterwards would leave every boot-tier module schemeless.
        scanClasses()
        lock.lock()
        // The FULL-catalog platform map (the graceful `unsupported_platform` answer), read from
        // the now-installed tables. Before the first frame, so every surface's not_loaded path
        // can already consult it. Both twins now fill this the same way — through a seam the
        // build installs, never a symbol the kernel names (the Kotlin twin always did).
        platformSupport = KernelTables.platformSupportByScheme
        lock.unlock()
    }

    /// PHASE 2 — everything else. Idempotent - subsequent calls are no-ops. Runs the
    /// boot phase if it hasn't (a background wakeup never paints, so phase order is moot
    /// there), then instantiates the deferred (non-boot-tier) packages — the `setup()`
    /// side effects the splash paint is protected from. Call from
    /// `AppDelegate.didFinishLaunching`'s deferred block (and before any registry consumer).
    public func bootstrap() {
        boot()                       // ensure the walk + boot tier happened (no-op when it has)
        lock.lock()
        if didBootstrap { lock.unlock(); return }
        didBootstrap = true
        let pending = deferredPackageTypes
        deferredPackageTypes = []
        lock.unlock()
        for type in pending { register(type) }
        // The excluded-identity overlay (facet-contracts.md build visibility): identities
        // that exist in the product but not this binary — keeps chain resolution and the
        // `.excluded` build fact honest. Generated by prepare_config from the SAME
        // resolve_disabled computation that decided what compiled.
        setExcludedIdentities(KernelTables.excludedIdentities)
        kernelLog("[ModuleRegistry] Bootstrapped \(allPackages.count) plugin(s): \(registeredSchemes)")
    }

    /// The shared class walk. Registers components/privileged components always (cheap
    /// table inserts), boot-eligible packages immediately, and stashes the rest in
    /// `deferredPackageTypes` for `bootstrap()`.
    private func scanClasses() {
        let packageBase: AnyClass = Module.self
        let componentBase: AnyClass = GlobalStackComponent.self   // native global Stack components
        let privilegedBase: AnyClass = PrivilegedStackComponent.self   // engine-powered orchestrators
        let tablesBase: AnyClass = DSXGeneratedTables.self        // the build's generated tables
        let count = objc_getClassList(nil, 0)
        guard count > 0 else { return }

        let buffer = UnsafeMutablePointer<AnyClass>.allocate(capacity: Int(count))
        defer { buffer.deallocate() }

        let actualCount = objc_getClassList(AutoreleasingUnsafeMutablePointer(buffer), count)

        // PASS 1 — the build tables, before anything reads them. The walk order objc gives us is
        // arbitrary, so this cannot be folded into the pass below: a module registered before
        // its scheme table exists would resolve to "" and vanish from the registry. Two passes
        // over a pointer array is microseconds; the walk never realizes a class.
        for i in 0..<Int(actualCount) {
            let cls: AnyClass = buffer[i]
            if cls == tablesBase { continue }
            var sup: AnyClass? = class_getSuperclass(cls)
            while let s = sup {
                if s == tablesBase {
                    (cls as? DSXGeneratedTables.Type)?.install()
                    break
                }
                sup = class_getSuperclass(s)
            }
        }

        for i in 0..<Int(actualCount) {
            let cls: AnyClass = buffer[i]
            if cls == packageBase || cls == componentBase || cls == privilegedBase { continue }
            // Identify Module / GlobalStackComponent subclasses by walking the
            // superclass chain (raw pointer compares). Doing Bundle(for:) or a Swift
            // `as?` for every class in the process costs seconds at launch once the app
            // links many SDK frameworks; the chain walk only reads superclass pointers
            // and never realizes a class, so it stays in the millisecond range.
            var sup: AnyClass? = class_getSuperclass(cls)
            var isPackage = false
            var isComponent = false
            var isPrivileged = false
            while let s = sup {
                if s == packageBase { isPackage = true; break }
                if s == componentBase { isComponent = true; break }
                if s == privilegedBase { isPrivileged = true; break }
                sup = class_getSuperclass(s)
            }
            if isPrivileged, let privilegedType = cls as? PrivilegedStackComponent.Type {
                StackComponents.registerPrivileged(privilegedType)
                continue
            }
            if isComponent, let componentType = cls as? GlobalStackComponent.Type {
                StackComponents.registerNative(componentType)
                continue
            }
            guard isPackage,
                  let packageType = cls as? Module.Type,
                  (!packageType.resolvedScheme.isEmpty || packageType.registersWithoutScheme) else { continue }
            if packageType.bootEligible {
                register(packageType)               // boot tier: instant-safe setup() by contract
            } else {
                lock.lock(); deferredPackageTypes.append(packageType); lock.unlock()
            }
        }
    }
}
