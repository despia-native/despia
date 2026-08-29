//
//  Context.swift
//  DespiaScript
//
//  Despia LLC-FZ
//  Meydan Grandstand, 6th Floor, Meydan Road,
//  Nad Al Sheba, Dubai, United Arab Emirates
//  support@despia.com
//
//  The dsx surface handed to every package handler, plus the registration store behind it.
//

import Foundation

/// What a *claim* hook returns when its answer is async: a producer the host
/// awaits. The sync part of the hook decides "is this mine?" (return nil to pass);
/// the producer does the async work and returns the result. Runs on the main
/// thread, like every watcher — see `Context.register` and `ModuleRegistry.dispatch`.
public typealias HookProducer = @MainActor () async -> Any?

public final class Registration {

    /// The package's stable primary scheme (from dsx.json).
    let primaryScheme: String

    /// Every URI scheme routed to this package: primary + manifest `aliases`
    /// (legacy / data-in-host schemes like `readhealthkit`).
    var schemes: Set<String>

    /// Pre-filter: runs first on every call. Handle the call, or `dsx.skip()`
    /// to defer to a named action. Set by `dsx.action { ... }`.
    var prefilter: ((Context) -> Void)?

    /// Named action handlers keyed by URL host. Set by `dsx.action("name") { }`.
    var named: [String: (Context) -> Void] = [:]

    /// INTERNAL (not-exposed) action handlers — `dsx.action("name", exposed: false) { }`. Reachable
    /// ONLY by in-process `dsx.module` calls (the package's own DSX components via `dsx.module.self.…`,
    /// and native callers); the web/URL bus dispatches with `includeInternal: false`, so
    /// `window.despia.*` and deep-link URLs never reach them. For package-private helpers / privileged
    /// logic that must not be web-callable. Keyed by host (group-prefixed like `named`).
    var internalNamed: [String: (Context) -> Void] = [:]

    /// Registration-time prefix for nested action groups (`dsx.group("rag") { … }`), e.g. "rag.".
    /// Empty outside a group; a named action registers under `groupPrefix + name` (host "rag.add").
    var groupPrefix: String = ""

    /// Actions scoped to a SECONDARY scheme the package owns (`dsx.scheme("rag") { … }`), keyed by
    /// scheme then host. A package can front multiple schemes (its primary in `named` + extras here),
    /// each with its own isolated action set — so `despia.rag.add` ≠ `despia.intelligence.add`.
    var schemeNamed: [String: [String: (Context) -> Void]] = [:]

    /// The scheme currently being populated by a `dsx.scheme(name) { … }` block (nil = primary).
    var currentScheme: String?

    /// Blocks run once per page load (after the runtime is installed).
    var hydrations: [(Context) -> Void] = []

    /// Blocks run once per page load, AFTER the page has finished loading
    /// (didFinish equivalent - `<body>` is parsed, the page is interactive).
    var readyBlocks: [(Context) -> Void] = []

    // `configurators` / `injectedScripts` are gone — modules contribute scripts via the dom module
    // (`dsx.module.dom.inject`), so the kernel registration holds no web-view setup.

    /// Handlers for named host events (lifecycle, push, navigation, deep links),
    /// keyed by event name — the general, dynamic replacement for hardcoded delegate
    /// methods. Folded by the host via `ModuleRegistry.dispatch`. Set by `dsx.delegate.listen`.
    var hooks: [String: [(priority: Int, handler: (Any?) -> Any?)]] = [:]

    init(primaryScheme: String, aliases: [String]) {
        self.primaryScheme = primaryScheme
        var set = Set<String>()
        if !primaryScheme.isEmpty { set.insert(primaryScheme) }
        for alias in aliases where !alias.isEmpty { set.insert(alias) }
        self.schemes = set
    }

    /// Run the active call through pre-filter -> named dispatch. Returns `true`
    /// when this package handled the call (so the host stops its fall-through).
    ///
    /// Order:
    ///   1. pre-filter runs first. If it settles (resolve/error) -> handled.
    ///      If it does NOT call `skip()` -> it's the effective handler (handled),
    ///      even if it answers asynchronously.
    ///   2. otherwise route to the handler for `host` — from this `scheme`'s scoped table when the
    ///      package owns the scheme via `dsx.scheme` (isolated), else the primary `named` table.
    ///   3. pre-filter skipped (or a scoped scheme) + no match -> auto `error(unknown_action)`.
    ///   4. no pre-filter + no match -> not ours (`false`).
    /// `includeInternal` is the trust gate: the in-process `dsx.module` path passes `true` (so a
    /// package's own components / native callers reach its `internalNamed` actions); the web/URL
    /// relay leaves it `false`, so internal actions are invisible to `window.despia.*` and deep links.
    func dispatch(scheme: String, host: String, url: URL,
                  params: Bridge.Params, includeInternal: Bool = false) -> Bool {
        let dsx = Context(store: self, scheme: scheme, host: host,
                          url: url, params: params)
        if let prefilter = prefilter {
            prefilter(dsx)
            if dsx.isSettled { return true }
            if !dsx.didSkip { return true }
        }
        // A scheme with its own `dsx.scheme` table is isolated (no fallback to `named`); any other
        // scheme the package owns (primary, or a plain alias) uses the shared `named` table.
        let scoped = schemeNamed[scheme]
        let internalHandler = includeInternal ? internalNamed[host] : nil
        if let handler = internalHandler ?? scoped?[host] ?? (scoped == nil ? named[host] : nil) {
            // Declarative veto GATE (delegates.md §5): when dsx.json declares `methods.<action>.gate`,
            // fold the named `<scheme>.<gate>` veto delegate BEFORE the handler. Any listener returning
            // false blocks the action — the call resolves { ok: false, blocked: <event> } and the
            // handler never runs. No gate ⇒ a single dictionary miss, then straight through.
            if let gate = KernelTables.actionGate(scheme: scheme, action: host) {
                let allowed = (ModuleRegistry.shared.dispatch(scheme + "." + gate, dsx.args(), .veto) as? Bool) ?? true
                if !allowed {
                    dsx.resolve(JSON(["ok": false, "blocked": gate]))
                    return true
                }
            }
            handler(dsx)
            return true
        }
        if prefilter != nil || scoped != nil {
            dsx.error("unknown_action", JSON.obj().put("action", host))
            return true
        }
        return false
    }
}

// MARK: - Context (the `dsx` handle)

public final class Context {

    let store: Registration

    // Per-call state. Inert for the registrar `dsx` (empty params, nil url),
    // so registration-time and out-of-band use is always safe.
    private let callScheme: String
    private let callHost: String
    private let callURL: URL?
    private let callParams: Bridge.Params
    private let isCall: Bool

    // Routing + settle state. One Context per dispatch, reused across the
    // pre-filter -> named handoff, so these flags track the whole call.
    fileprivate var didSkip = false
    private let settleLock = NSLock()
    private var settled = false

    /// The most recent surface this context `dsx.component.mount`ed, if any. Lets a boot gate
    /// (`dsx.boot.gate`) show its screen without a return value — the gate runner reads it. Nil for
    /// contexts that never mounted.
    var lastMount: StackSurface?

    /// Registrar context: used in `setup()` to register, and anywhere in the
    /// package for out-of-band `broadcast` / `variable` / `function`.
    init(store: Registration) {
        self.store = store
        self.callScheme = store.primaryScheme
        self.callHost = ""
        self.callURL = nil
        self.callParams = Bridge.Params(dict: [:], requestID: nil)
        self.isCall = false
    }

    /// Per-call context, built by the registry for each dispatched URL.
    init(store: Registration, scheme: String, host: String, url: URL,
         params: Bridge.Params) {
        self.store = store
        self.callScheme = scheme
        self.callHost = host
        self.callURL = url
        self.callParams = params
        self.isCall = true
    }

    private var proxyScheme: String { isCall ? callScheme : store.primaryScheme }

    // MARK: Registration (setup)

    /// Register actions, or read the active action name. `dsx.action { }`
    /// registers the pre-filter; `dsx.action("name") { }` a named handler;
    /// `dsx.action.name` reads which action fired inside a handler.
    public var action: ActionAPI { ActionAPI(dsx: self) }

    /// Group nested actions under a dotted namespace — the web calls them as
    /// `despia.<scheme>.<group>.<action>(…)`. `build` runs at registration with the group prefix
    /// active, so `dsx.action("add") { … }` inside it registers the host `<group>.add`. Nestable.
    ///   dsx.group("rag") {
    ///       dsx.action("add")   { c in … }   // -> despia.<scheme>.rag.add
    ///       dsx.action("query") { c in … }   // -> despia.<scheme>.rag.query
    ///   }
    public func group(_ name: String, _ build: () -> Void) {
        let saved = store.groupPrefix
        store.groupPrefix = saved + name + "."
        build()
        store.groupPrefix = saved
    }

    /// Scope actions to one of the package's schemes — `despia.<scheme>.<action>(…)`. A package can
    /// front MORE THAN ONE scheme (its primary, plus extras declared in `dsx.json` `aliases`): wrap
    /// each extra scheme's actions in its own block, and they stay isolated from the primary.
    ///   dsx.scheme("rag") {
    ///       dsx.action("add")   { c in … }   // -> despia.rag.add
    ///       dsx.action("query") { c in … }   // -> despia.rag.query
    ///   }
    public func scheme(_ name: String, _ build: () -> Void) {
        let saved = store.currentScheme
        store.currentScheme = name.lowercased()   // dispatch receives RFC-lowercased schemes — key alike
        build()
        store.currentScheme = saved
    }

    /// Register a block to run once per page load (after the runtime installs).
    public func hydrate(_ handler: @escaping (Context) -> Void) {
        store.hydrations.append(handler)
    }

    /// Register a block to run once per page load, AFTER the page has finished
    /// loading. Sibling to `hydrate`, fired at `didFinish` instead of
    /// `didCommit` - `<body>` is parsed, the page is interactive, any
    /// documentEnd user scripts have already run. Use when a native push
    /// needs a fully-formed document (e.g. inline-style writes that the page
    /// might otherwise race past during initial parse).
    public func ready(_ handler: @escaping (Context) -> Void) {
        store.readyBlocks.append(handler)
    }

    // `dsx.configure` (raw WKWebViewConfiguration) and `dsx.inject` are gone — the kernel holds no
    // web-view verb. A module contributes a document script via `dsx.module.dom.inject(["script": …])`
    // and a custom scheme via `dsx.module.dom.serveScheme(…)`; the dom module owns all WebKit.

    /// THE append — the register half of the delegate primitive (delegates.md §2 `register`).
    /// Kernel-internal by design: the ONE authoring spelling is `dsx.delegate.listen(event) { … }`,
    /// which forwards straight here in one hop. The former public `dsx.hook` verb was deleted by
    /// phase 4, the collapse — one idiom for attaching, not two. Untyped in/out so the same shape
    /// works on Swift/Kotlin; return non-nil to answer a claim-style fold. Attach in `setup()`,
    /// like `dsx.action`. `priority` orders watchers of the same event: higher runs first (globally
    /// across packages), equal priority keeps registration order. Default 0 — behavior-neutral.
    func register(_ event: String, priority: Int = 0, _ handler: @escaping (Any?) -> Any?) {
        store.hooks[event, default: []].append((priority: priority, handler: handler))
    }

    public struct ActionAPI {
        let dsx: Context

        /// Inside a handler: the action name that fired (URL host). "" otherwise.
        public var name: String { dsx.callHost }

        /// Inside a handler: the ARRIVING scheme of this call — the spelling the caller
        /// used (the primary, or a manifest alias). "" otherwise. True on EVERY face:
        /// real URL navigations keep their scheme, and the STRUCTURED/string-tuple
        /// dispatch passes the arriving spelling into the per-call context even though
        /// its `command()` is the synthesized `dsx-call` CARRIER url — so a pre-filter
        /// that disambiguates alias spellings matches THIS, never `command()?.scheme`
        /// (the carrier can never equal a module scheme). The web twin is the module
        /// ctx's `scheme` (bus.ts `ModuleCallCtx.scheme`).
        public var scheme: String { dsx.isCall ? dsx.callScheme : "" }

        /// Register the pre-filter - runs first on every call; `dsx.skip()`
        /// to defer to the named handlers below.
        public func callAsFunction(_ handler: @escaping (Context) -> Void) {
            dsx.store.prefilter = handler
        }

        /// Register a named handler for the action `<name>` on the package's scheme — prefixed when
        /// inside `dsx.group`, and scoped to the current `dsx.scheme` (else the package's primary scheme).
        ///
        /// The key is stored LOWERCASED — action names are case-INSENSITIVE by construction. Every
        /// dispatch path lowercases the action segment before lookup (URL hosts are case-insensitive
        /// per RFC 3986: Foundation lowercases `url.host`, and the string-keyed
        /// `ModuleRegistry.handle(scheme:actionPath:)` keeps that contract), so a case-preserved
        /// camelCase registration ("pushComponent") was unreachable from EVERY caller — the
        /// `dsx.module` proxy, the web bridge, markup, deep links — and the miss surfaced only as
        /// `unknown_action`/`notLoaded`, silently swallowed by `try?` call sites. Lowercasing here
        /// mirrors the scheme table (ModuleRegistry lowercases schemes at registration the same way).
        public func callAsFunction(_ name: String, _ handler: @escaping (Context) -> Void) {
            let key = (dsx.store.groupPrefix + name).lowercased()
            if let scheme = dsx.store.currentScheme {
                dsx.store.schemeNamed[scheme, default: [:]][key] = handler
            } else {
                dsx.store.named[key] = handler
            }
        }

        /// Register an INTERNAL action — NOT exposed on the web/URL bus (`window.despia.<scheme>.<name>`
        /// and deep links never reach it). Reachable only by in-process `dsx.module` calls: the
        /// package's own DSX components (`dsx.module.self.<name>`) and native callers. Use for
        /// package-private helpers and privileged logic that must not be web-callable. `exposed: true`
        /// is the normal public registration. (In-process is full-trust — by convention the owning
        /// package; see the container security model.)
        public func callAsFunction(_ name: String, exposed: Bool, _ handler: @escaping (Context) -> Void) {
            guard !exposed else { return callAsFunction(name, handler) }
            dsx.store.internalNamed[(dsx.store.groupPrefix + name).lowercased()] = handler   // case-insensitive, like `named`
        }
    }

    // MARK: Per-call reads

    /// One input value, already smart-parsed to its native type at ingestion -
    /// String / number / Bool / array / object - so you use it directly, no
    /// coercion suffix. `nil` for a missing key (or an explicit JSON null). It
    /// drops straight back into a payload: `dsx.resolve(JSON(["echo": dsx.args("x")]))`.
    /// In Swift you cast only when an SDK needs a concrete static type
    /// (`dsx.args("name") as? String`).
    public func args(_ key: String) -> Any? {
        let value = callParams.raw(key)
        return value is NSNull ? nil : value
    }

    /// The whole inbound payload as a native dictionary - a forwarding escape
    /// hatch for subsystems that route their own way (keeps `[Any?]` etc. intact).
    /// Internal framing keys (`__rid`, `__stop`) are stripped; read those via
    /// `dsx.id()` / `dsx.stopped()`.
    public func args() -> [String: Any] {
        callParams.all.filter { !$0.key.hasPrefix("__") }
    }

    /// A file param's local URL. A `File`/`Blob` passed from web -
    /// `window.despia.<scheme>.upload({ image: fileObject })` - is stream-uploaded to the
    /// local CDN by runtime.js (multipart, never base64) and arrives here as a
    /// URL the handler can read or stream straight off disk. nil if absent or
    /// unparseable. (`dsx.args("image")` is the same local URL as a String.)
    public func file(_ key: String) -> URL? { callParams.file(key) }

    /// A list param as `[String]`: a real array (a structured array, or a
    /// smart-parsed comma-list like `?types=a,b,c`) maps element-wise; a single
    /// scalar wraps to one element; a missing key yields `[]`. Saves every
    /// package re-coercing `dsx.args(key)` for the common list case.
    public func list(_ key: String) -> [String] {
        if let arr = callParams.raw(key) as? [Any] {
            return arr.compactMap { $0 as? String ?? ($0 as? NSNumber)?.stringValue }
        }
        if let s = callParams.raw(key) as? String { return s.isEmpty ? [] : [s] }
        if let n = callParams.raw(key) as? NSNumber { return [n.stringValue] }
        return []
    }

    /// The raw URL that triggered this call (e.g. from `window.despia.healthkit.workouts({ days: 7 })`).
    /// Use it when the host slot carries data (the legacy `readhealthkit` data-in-host form that
    /// packs `A,B` into the host slot — see OpenSource/Documentation/legacy.md).
    public func command() -> URL? { callURL }

    /// The `__rid`. Rarely needed - `resolve` / `error` / `event` correlate it
    /// to the request for you. Reach for it only to key a stream subscription for
    /// stop-correlation (matching a later `dsx.stopped()` re-dispatch), or to log.
    public func id() -> String? { callParams.requestID }

    /// `true` when the JS caller stopped a stream subscription (`.stop()`).
    public func stopped() -> Bool { callParams.isStop }

    /// Capability flags (degrade gracefully on stripped builds).
    public func flags() -> Flags { Flags() }

    /// iOS-only handle to the app's shared **container** - the one reserved App
    /// Group (`group.<bundleid>.container`). This is *your* subcontainer (a folder
    /// named after the package scheme); read and write it directly. Reach another
    /// package's folder by name: `dsx.container.onesignal` (or, for dynamic /
    /// colliding names, `dsx.container["onesignal"]`). See containers.md.
    public var container: Container { Container(store.primaryScheme, own: true) }

    /// App-wide reactive store (`global.*` / DSXState) — the same store the web reads via
    /// `window.despia.global`, Stack views read as `{{ global.* }}`, and components reach as
    /// `dsx.global`. Dot-paths: `dsx.global.set("session.credits", 200)` /
    /// `dsx.global.get("session")`. See DSXState.swift.
    public var global: DSXGlobal { DSXGlobal() }
    /// `dsx.context` — THIS package's own data face: the variables it PUBLISHES to others (declared in
    /// its dsx.json `context` block). Read its own vars as `dsx.context.<var>.bool`, PUBLISH a live one
    /// with `dsx.context.set("<var>", value)` (string-keyed like `dsx.global.set` — writes the reactive
    /// `DSX.state`, so consumers and the web layer see it). Consumers read it back via
    /// `dsx.module.<scheme>.context.<var>`. A package's *decisions* are the separate `dsx.delegate`; its
    /// outward *messages* are `dsx.broadcast(…)`. The app-global cross-screen store is `dsx.global`.
    public var context: DSXStateProxy { DSXStateProxy(scheme: store.primaryScheme) }

    /// `dsx.app` — read-only app identity from App.json (+ the bundle): `dsx.app.host` (the
    /// per-locale-resolved host) / `dsx.app.name`. The blessed accessor instead of reading
    /// `AppManifest` / `Bundle` directly; the same values back the DSX `dsx.app.*` namespace. See DSXState.swift.
    public var app: DSXApp { DSXApp() }

    /// `dsx.env` — the read-only runtime environment channel: `dsx.env.channel`
    /// ("simulator" | "debug" | "testflight" | "adhoc" | "appstore") and the gate
    /// `dsx.env.isProduction`. Detection FAILS CLOSED to production (ambiguous ⇒
    /// "appstore"), so dev-only features are off when in doubt — the first line of a
    /// dev-only `setup()` is `guard !dsx.env.isProduction else { return }`. Markup reads
    /// the same value as the reserved word `env` / `dsx.app.env`; the web reads
    /// `global.app.env`. See AppManifest.swift (AppEnvironment).
    public var env: DSXEnv { DSXEnv() }

    /// `dsx.content` — the kernel CONTENT primitive: folder-shaped, generation-versioned,
    /// offline-first app-authored content (Content.swift). `dsx.content.folder("/runner")` returns
    /// the last-known-good generation SYNCHRONOUSLY (render-safe, never network); `try await
    /// dsx.content.prepare("/runner")` resolves + freshens (stale-while-revalidate — a new
    /// generation applies on the NEXT open and announces itself as the `content.updated` kernel
    /// event). Hosted folders live under the app host's content root (App.json
    /// `hosting.content_root`, default `/dsx`).
    public var content: DSXContent.Type { DSXContent.self }

    /// `dsx.source` — the kernel PROVENANCE plane (reserved namespace `source.*` in the reactive
    /// store): per remote-loaded plane `{ state: never|stale|live, serving: origin|cache|bundle,
    /// at }`, plus the kernel facts `source.online` / `source.boot`. An OWNER seeds its plane at
    /// launch (`dsx.source.track("web", key: host)` → never|stale from the persisted first-load
    /// stamp) and reports serves (`dsx.source.publish("web", serving: "origin", fresh: true,
    /// key: host)` → live + the stamp). Markup reads `dsx.source.<plane>.state` reactively; the
    /// page watches `despia.global.watch("source", …)`; native hooks `source.changed`. Publish
    /// ONLY your own plane — the namespace is reserved. See Source.swift + the proposal doc.
    public var source: DSXSourceFace { DSXSourceFace() }

    /// `dsx.config` — introspect THIS package's config by key: `dsx.config.usage_description.value`
    /// (resolved for the device), `.default`, `.isLocalized`, `.locales`, `.forLocale("de-DE")`,
    /// `.byLocale`, plus typed `.bool` / `.int` / … . Works for ANY key — a plain string or a
    /// localized `{ default, <locale>… }` map. `self.config.<key>` stays the typed, resolved
    /// accessor for the common path; this is the locale-aware / metadata view. Bound to the
    /// package's primary scheme; backed by generated data. See DSXState.swift.
    public var config: DSXConfigProxy { DSXConfigProxy(scheme: store.primaryScheme) }

    /// `dsx.state` — transitional alias of `dsx.context` (a package's own data face). Prefer `dsx.context`;
    /// both bind to the primary scheme and return the same DSXStateProxy. Kept so existing `dsx.state`
    /// call-sites keep compiling through the `state` → `context` rename. See `dsx.context` above.
    public var state: DSXStateProxy { DSXStateProxy(scheme: store.primaryScheme) }

    /// Shared in-process context registry (live handles). One node provides a handle under a key,
    /// any node consumes it: `dsx.shared.provide("key", handle)` / `dsx.shared.use("key")`. For the
    /// web surface, packages go through its OWNER — `dsx.module.dom.object("view") as? WKWebView`
    /// (Dom exports it) — not this kernel-internal handle directly. See DSXShared.swift.
    public var shared: DSXShared { DSXShared() }

    /// EXPORT a live native object for other packages — owner-namespaced under THIS package's
    /// scheme. A consumer reads it with `dsx.module.<thisScheme>.object("name")` and casts to the
    /// concrete type. The kernel stores it OPAQUELY (`AnyObject`) and never names the type, so the
    /// SAME primitive vends a WKWebView, an AVPlayer, an SFSafariViewController, any native object —
    /// there is no kernel exemption for the web view (an app may have none). Backed by the same
    /// in-process handle store as `dsx.shared` (weak ref); the owner-namespaced API is canonical.
    public func export(_ name: String, _ object: AnyObject?) {
        shared.provide("\(store.primaryScheme).\(name)", object)
    }

    /// Shared in-process VALUE state (strong-ref). The native package-coordination store: a
    /// Bool/String/Dict a package publishes for others to read synchronously while handling
    /// hooks/actions — e.g. `dsx.values.set("auth.inProgress", true)` then, in another package's
    /// `web.decidePolicy` hook, `dsx.values.bool("auth.inProgress")`. Contrast `dsx.shared` (weak
    /// OBJECT handles, which can't hold a transient value); NOT DSX `dsx.variable`/route/UI state.
    /// See DSXShared.swift.
    public var values: DSXValues { DSXValues() }

    /// Out-of-band event bus (the native mirror of `window.despia.on`). Subscribe to a
    /// scheme's broadcasts: `dsx.events.on("audio") { event, data in … }` — keep the
    /// returned handle and `cancel()` it. The delivery side is `dsx.broadcast(...)`. See
    /// DSXEvents.swift.
    public var events: DSXEvents { DSXEvents() }

    /// `dsx.errors` — the error LEDGER read API (error-system.md): `recent()` (the retained
    /// ring, cap 128), `count()` (monotonic), `clear()` (dev tooling). Call failures and
    /// ambient `dsx.error` emissions both land here; the reactive twins are
    /// `global.dsx.lastError` / `global.dsx.errorCount`. See Errors.swift.
    public var errors: DSXErrorLedger { DSXErrorLedger.shared }

    /// `dsx.log(…)` — the unified console primitive (the logs corpus): console.log-shaped
    /// variadic formatting (JSE coercions + canonical JSON + credential masking), recorded
    /// in the log ring attributed to THIS module's scheme, mirrored to kernelLog (the
    /// Xcode console / the armed diagnostics drawer). Never throws. See Logs.swift.
    public func log(_ args: Any?...) {
        let scheme = store.primaryScheme.isEmpty ? "app" : store.primaryScheme
        reportLog(scheme: scheme, level: "log", message: JSERunner.formatLogArgs(args))
    }

    /// `dsx.logs` — the log ring read API: `recent()` (the retained ring, cap 500),
    /// `count()` (monotonic), `clear()` (dev tooling). `dsx.log`, the console.* builtin,
    /// and the page bridge (`despia.log`) all land here. See Logs.swift.
    public var logs: DSXLogBuffer { DSXLogBuffer.shared }

    /// `dsx.messenger` — mount a native surface onto the bus (the multi-surface
    /// bridge; Messenger.swift). A surface owner mounts ONE sink, feeds its
    /// content's calls in via `mount.receive`, and the kernel routes replies /
    /// streams / broadcasts back to it — the exact standing the web surface has.
    public var messenger: DSXMessenger { DSXMessenger() }
    /// `dsx.on(name) { phase, payload in }` — subscribe to a loose broadcast signal (the canonical
    /// name from the native-bus surface for `dsx.events.on`). Pairs with `dsx.broadcast(name, payload)`.
    @discardableResult
    public func on(_ scheme: String, _ handler: @escaping (String, Any?) -> Void) -> DSXEventSubscription {
        events.on(scheme, handler)
    }

    // MARK: Cross-package calls
    //
    // Three small primitives let a package depend on another at runtime
    // without `import`-ing its class (so the dependency is excludable):
    //   - `dsx.has("appsflyer")`                          - is the package loaded?
    //   - `try? dsx.module.appsflyer.set_user_id([…])`   - fire-and-forget.
    //   - `try await dsx.module.appsflyer.get_uid()`     - awaits resolve(...).
    //
    // `dsx.module` is the native twin of DSX's `dsx.module.<scheme>.<method>(…)` — one root for
    // both forms (await = result, bare = fire-and-forget), so native and markup read the same.
    // Identifiers map straight to the target's scheme + action; use the subscript form for
    // dynamic strings or non-identifier names:
    //   - `try? dsx.module["appsflyer"]["set_user_id"]([…])`
    //   - `try? dsx.module.appsflyer["get-attribution"]()`
    //
    // All routes go through the same `ModuleRegistry`
    // dispatch path the JS bridge uses, so the target package's existing
    // `dsx.action("name") { … }` handlers are reused as-is. The handler's
    // `dsx.resolve` / `dsx.error` settle the caller's continuation instead
    // of writing back to a JS promise; side-effect deliveries (`dsx.variable`,
    // `dsx.function`, `dsx.broadcast`) still fire on the web view.

    /// `true` if a Module claiming `scheme` is loaded in this build. Lets
    /// a caller branch before dispatching, e.g. to skip optional decoration
    /// rather than catching `ModuleCallError.notLoaded`.
    public func has(_ scheme: String) -> Bool {
        ModuleRegistry.shared.isAvailable(scheme)
    }

    /// Dot/subscript chain root for calling another package — the native twin of DSX's
    /// `dsx.module.<scheme>.<method>(…)`. ONE root for both forms, like `dsx.module`: `await`
    /// gets the result, a bare call is fire-and-forget.
    ///
    ///     try await dsx.module.revenuecat.purchase(["product": id])   // ⇄  await dsx.module.revenuecat.purchase({...})
    ///     try?      dsx.module.appsflyer.set_user_id(["id": userId])   // ⇄  dsx.module.appsflyer.set_user_id({...})
    ///
    /// The awaitable leaf returns the handler's `dsx.resolve(...)` payload as `JSON` (throws
    /// `ModuleCallError` — `.actionFailed` on `dsx.error`, `.notLoaded` when no package owns the
    /// scheme); the fire-and-forget leaf just routes (`try?` = safe-fail). Subscript form for
    /// dynamic / non-identifier names: `dsx.module["appsflyer"]["get-attribution"]()`.
    public var module: ModuleProxy { ModuleProxy(dsx: self) }

    // MARK: Kernel bus (the delegate plane — `dsx.delegate`)
    //
    // The bus primitive is surfaced on `dsx` so an OS-delegate relay and other kernel-adjacent
    // code reach the bus THROUGH dsx — never `ModuleRegistry.shared` directly. There is exactly
    // ONE pair of verbs (delegates.md phase 4, the collapse): `dsx.delegate.listen(name) { … }`
    // attaches, `dsx.delegate.send(name, payload, combine:)` folds. The four old emit spellings
    // (`dsx.fire` / `dsx.claim` / `dsx.fireAny` / `dsx.collect`) and the `dsx.hook` attach verb
    // are GONE — the combine policy carries what the verb name used to. Most package code needs
    // neither: to make a package you can NAME do something, use `dsx.module.<scheme>.<action>()`,
    // and `send` is never a disguised point-to-point call (Skills/cross-module-calls.md).

    /// `dsx.delegate` — the declared, typed delegate primitive (one fold over the same hook pipeline).
    /// `dsx.delegate.<event> { input in … }` ATTACHES a handler; `dsx.delegate.<event>(payload)`
    /// INVOKES the fold, combining every attacher's answer per the owner's declared policy
    /// (claim/veto/any/collect/void) from its `dsx.json` `delegate` block (→ GeneratedDelegateRegistry).
    /// A module's own delegate points are reached scheme-namespaced via `dsx.module.<scheme>.delegate.<event>`.
    public var delegate: DSXDelegateProxy { DSXDelegateProxy(dsx: self, prefix: "") }

    /// First-dibs custom-scheme dispatch for a raw URL (the navigation relay's pre-claim step):
    /// hands the URL to the package that owns its scheme. `true` if a package took it.
    @discardableResult
    public func handle(url: URL, params: Bridge.Params) -> Bool {
        ModuleRegistry.shared.handle(url: url, params: params)
    }

    /// Run every module's hydrate blocks for a freshly committed page (the dom relay's parity step).
    public func runHydrations() { ModuleRegistry.shared.runHydrations() }
    /// Run every module's ready blocks for a settled page (the dom relay's parity step).
    public func runReady() { ModuleRegistry.shared.runReady() }

    // MARK: Internal dispatch implementation

    /// The derived-identity FOLD (ChainResolver, Conformance/chains) at the MODERN-face
    /// funnel: alias-normalize the head, then fold action segments into the chain while
    /// the registry knows the deeper identity — so every modern call face (the dot proxy,
    /// the envelope form, markup-lowered calls, generated accessors) resolves `watch` +
    /// `health/heartRate` to `watch.health` + `heartRate` identically. The WIRE faces run
    /// the SAME fold at their own funnels (`handle(url:)` and the string funnel both
    /// resolve through `ChainResolver.resolveWire` — a nested chain reaches its owner on
    /// every face); what differs is only the CONSEQUENCE of a reserved member (the corpus
    /// face-split): here — the modern faces — one can never dispatch as a call (the typed
    /// proxies answer members before a call can form), so one arriving is a caller bug,
    /// refused with the cross-runtime code `reserved_member`; the wire faces dispatch it
    /// as a plain action (code-only legacy shims keep answering shipped pages).
    private static func foldRoute(scheme: String, action: String) throws -> (scheme: String, action: String) {
        let r = ChainResolver.resolveWire(scheme: scheme, actionPath: action,
                                          table: ModuleRegistry.shared.identityTable())
        if let member = r.member {
            reportCallFailure(scheme: r.chain, action: member, code: "reserved_member", data: nil,
                              delivered: true, hint: "reserved members never dispatch — proxy plane only")
            throw ModuleCallError.actionFailed(code: "reserved_member", data: nil)
        }
        // NOTHING FOLDED ⇒ bit-for-bit today's route: the ARRIVING spelling dispatches
        // (an alias-scoped `dsx.scheme(alias)` table stays reachable, a catch-all sees
        // the caller's grammar — twin parity with Kotlin/TS spelling preservation) and
        // the action rides VERBATIM (dotted group keys like "index.add" keep the exact
        // grammar their registration used — never re-joined).
        guard r.folded > 0 else { return (scheme, action) }
        return (r.chain, r.rest)
    }

    fileprivate func _dispatch(scheme rawScheme: String, action rawAction: String, args: [String: Any]?) throws {
        let (scheme, action) = try Context.foldRoute(scheme: rawScheme, action: rawAction)
        try Self.requireScheme(scheme, action: action)
        // Fire-and-forget still OBSERVES the terminal outcome. By shape the caller never sees
        // it — so a handler's `dsx.error`/`dsx.fail` used to vanish into a `{ _ in }` no-op:
        // the "button does nothing, nothing anywhere says why" class of bug. Route error
        // terminals into the diagnostics funnel instead (success stays silent — not noise).
        let params = Bridge.Params(dict: args ?? [:], onTerminal: { outcome in
            if case .error(let code, let data, let message, let recoverable) = outcome {
                Context.reportCallFailure(scheme: scheme, action: action, code: code,
                                          data: data, delivered: false,
                                          message: message, recoverable: recoverable)
            }
        })
        // Action handlers render UI and touch the web view, so they must run on the
        // main thread — the web→bridge path always delivers there. A cross-package
        // `dispatch` can originate on a background thread, so hop explicitly.
        let handled: Bool
        if Thread.isMainThread {
            handled = ModuleRegistry.shared.handle(scheme: scheme, actionPath: action,
                                                   params: params, includeInternal: true)
        } else {
            handled = DispatchQueue.main.sync {
                ModuleRegistry.shared.handle(scheme: scheme, actionPath: action,
                                             params: params, includeInternal: true)
            }
        }
        guard handled else { throw Self.unhandledCallError(scheme: scheme, action: action, delivered: false) }
    }

    fileprivate func _call(scheme rawScheme: String, action rawAction: String, args: [String: Any]?) async throws -> JSON {
        let (scheme, action) = try Context.foldRoute(scheme: rawScheme, action: rawAction)
        try Self.requireScheme(scheme, action: action)
        return try await withCheckedThrowingContinuation { continuation in
            // Wrap the continuation so a misbehaved handler firing both
            // resolve and error (or neither) can't crash.
            let once = Once()
            let params = Bridge.Params(dict: args ?? [:]) { outcome in
                guard once.claim() else { return }
                switch outcome {
                case .resolve(let payload):
                    continuation.resume(returning: JSON.from(payload))
                case .error(let code, let data, let message, let recoverable):
                    // Delivered to the awaiting caller (typed throw) — but STILL funneled:
                    // `try? await` swallows silently, and the diagnostics drawer wants the
                    // trace either way. Observing never swallows; handling stays the caller's.
                    Context.reportCallFailure(scheme: scheme, action: action, code: code,
                                              data: data, delivered: true,
                                              message: message, recoverable: recoverable)
                    continuation.resume(throwing: ModuleCallError.actionFailed(code: code, data: data))
                }
            }
            // Action handlers render UI (UIViewController/UIHostingController) and touch
            // the web view, so they must run on the main thread — the web→bridge path
            // always delivers there. A cross-package `call` may be awaited from a
            // background Task, and resuming the continuation runs this on a cooperative
            // thread; without hopping, a handler that presents (e.g. the store package's paywall
            // action → setOverrideUserInterfaceStyle) aborts off-main. So invoke on main.
            let invoke = {
                let handled = ModuleRegistry.shared.handle(scheme: scheme, actionPath: action, params: params, includeInternal: true)
                if !handled {
                    guard once.claim() else { return }
                    continuation.resume(throwing: Self.unhandledCallError(scheme: scheme, action: action))
                }
            }
            if Thread.isMainThread {
                invoke()
            } else {
                // `Bridge.Params` intentionally carries dynamic `[String: Any]` values and a
                // terminal callback, so it cannot truthfully conform to `Sendable`. Transfer the
                // complete invocation as one owned unit instead: after publication only the main
                // actor can take and execute it. The Dispatch closure therefore moves a
                // synchronization-safe token, never the non-Sendable payload itself.
                let work = MainThreadWork(invoke)
                DispatchQueue.main.async { work.run() }
            }
        }
    }

    /// Cross-package calls route by the (scheme, action) STRING tuple — a scheme
    /// is a routing key, not URL grammar, so identifier names (`godot_test`) are
    /// legal. Only an empty scheme is unroutable.
    private static func requireScheme(_ scheme: String, action: String) throws {
        guard !scheme.isEmpty else {
            reportCallFailure(scheme: "", action: action, code: "invalid_uri", data: nil,
                              delivered: true, hint: "empty scheme — caller bug")
            throw ModuleCallError.invalidURI("://\(action)")
        }
    }

    /// The unhandled answer for the native chain — now four-way distinct, and NEVER silent
    /// (every branch reports to the diagnostics funnel before the caller's `try?` can swallow it):
    ///   • scheme LOADED here but no handler took the action → the caller named a wrong or
    ///     unregistered action (the `injct` typo class) → `.actionFailed("unknown_action",
    ///     { action })` — the same code + data shape the prefilter path (Registration.dispatch)
    ///     and the web twin (bus.ts) already answer, so all three renderers agree and
    ///     `.notLoaded` stays honest: it means "the module is absent", never "the module
    ///     silently ignored you".
    ///   • catalog scheme with NO implementation on this OS → the STRUCTURED
    ///     `.actionFailed("unsupported_platform", { scheme, platform, supportedPlatforms })`
    ///     (the `ModuleRegistry.platformSupport` contract).
    ///   • implemented here but EXCLUDED BY THIS APP → `excluded` (durability.md P4, typed
    ///     absence — the reason IS the code), the DespiaExcluded overlay entry riding
    ///     verbatim as data ({ reason, from?, aliases? }: the same fact `.excluded`
    ///     introspection answers — corpus errors/errors.json). An unknown scheme keeps
    ///     throwing `.notLoaded`. `dsx.has` stays false for all of these: feature
    ///     detection remains the primary pattern; this is the honest answer when someone
    ///     calls anyway. `delivered` mirrors the call shape (the TS law: a post caller
    ///     discards the rejection by shape, so its funnel record says false).
    private static func unhandledCallError(scheme: String, action: String, delivered: Bool = true) -> ModuleCallError {
        // What dispatch actually looked up: the first path segment, lowercased (URL-host contract).
        let host = action.split(separator: "/").first.map { String($0).lowercased() } ?? action.lowercased()
        // THE ACTION-LEVEL NARROWING OUTRANKS `unknown_action`. A module present on this
        // platform whose manifest says THIS action cannot run here did not lose an action to a
        // typo — the caller asked for something declared impossible, and `unknown_action` would
        // read as a caller bug it is not (X2 §1). Only the action-keyed table can answer this;
        // the scheme-level check below stays where it was, after the loaded-module branch.
        if let supported = ModuleRegistry.shared.unsupportedPlatforms(scheme, action: host),
           ModuleRegistry.shared.unsupportedPlatforms(scheme) == nil {
            let data = ModuleRegistry.shared.unsupportedPlatformData(scheme, supported)
            reportCallFailure(scheme: scheme, action: action, code: "unsupported_platform",
                              data: data, delivered: delivered,
                              hint: "action implemented on: \(supported.joined(separator: ", "))")
            return .actionFailed(code: "unsupported_platform", data: data)
        }
        if ModuleRegistry.shared.isAvailable(scheme) {
            let known = ModuleRegistry.shared.actionNames(scheme)
            let hint = known.isEmpty
                ? "module is loaded but registers no named actions on this platform"
                : "module is loaded — known actions: \(known.joined(separator: ", "))"
            reportCallFailure(scheme: scheme, action: action, code: "unknown_action",
                              data: ["action": host], delivered: delivered, hint: hint)
            return .actionFailed(code: "unknown_action", data: ["action": host])
        }
        if let supported = ModuleRegistry.shared.unsupportedPlatforms(scheme, action: host) {
            let data = ModuleRegistry.shared.unsupportedPlatformData(scheme, supported)
            reportCallFailure(scheme: scheme, action: action, code: "unsupported_platform",
                              data: data, delivered: delivered,
                              hint: "implemented on: \(supported.joined(separator: ", "))")
            return .actionFailed(code: "unsupported_platform", data: data)
        }
        if let entry = ModuleRegistry.shared.excludedEntry(for: scheme) {
            reportCallFailure(scheme: scheme, action: action, code: "excluded",
                              data: entry, delivered: delivered,
                              hint: "excluded from this build (reason: \(entry["reason"] as? String ?? "excluded"))")
            return .actionFailed(code: "excluded", data: entry)
        }
        reportCallFailure(scheme: scheme, action: action, code: "not_loaded", data: nil,
                          delivered: delivered,
                          hint: "module not in this build (expected when excluded — `try?` no-ops)")
        return .notLoaded(scheme: scheme)
    }

    // MARK: Module-call diagnostics (the ONE failure funnel)

    /// Reentrancy guard: a `module.callFailed` hook whose own body makes a failing cross-package
    /// call must not feed the funnel its own output (fire → hook → failing call → fire → …).
    /// True EXACTLY while the fire below is delivering hooks; only ever read/written on main
    /// (the fire runs on the main queue, and the entry check below reads it on main only).
    private static var reportingCallFailure = false

    /// EVERY `dsx.module` call failure lands here, so nothing on the native chain fails
    /// invisibly anymore (Article 7 keeps *degrading* legal — invisible was never the point):
    ///   · `kernelLog` — the DEBUG console + the on-device diagnostics drawer's ring buffer,
    ///     so a tester exports the exact `scheme.action → code` line instead of reporting
    ///     "the button did nothing".
    ///   · `module.callFailed` bus event — the global observer seam
    ///     (`dsx.delegate.listen("module.callFailed")`) for dev tooling / crash reporting; payload
    ///     `{ scheme, action, code, data?, delivered }`. Fired async on main (hook contract)
    ///     behind the reentrancy guard above.
    /// `delivered: false` marks a fire-and-forget terminal error — the call site has already
    /// returned, so this funnel is the ONLY place that failure can surface. Observing never
    /// swallows: handling stays the caller's job (`do/catch` on the typed `ModuleCallError`).
    private static func reportCallFailure(scheme: String, action: String, code: String,
                                          data: Any?, delivered: Bool, hint: String? = nil,
                                          message: String? = nil, recoverable: Bool = false) {
        var line = "[dsx.module] \(scheme).\(action) → \(code)"
        if !delivered { line += " (fire-and-forget — the error never reaches the call site)" }
        if let hint { line += " — \(hint)" }
        kernelLog(line)
        // A failure reported from INSIDE a module.callFailed hook stays log-only. Hooks run
        // synchronously on main inside the fire below, so that nested report arrives here on
        // main with the flag still set — queueing it anyway would deliver after the flag
        // resets and spin the loop forever. Off-main reports can never be mid-fire (main is
        // serial), so they always queue.
        if Thread.isMainThread, reportingCallFailure { return }
        DispatchQueue.main.async {
            reportingCallFailure = true
            defer { reportingCallFailure = false }
            // The unified record (error-system.md §3.3a): every native/markup-caller failure —
            // handler-settled AND the thrown kernel errors — with the full fidelity the
            // widened internal Outcome now carries. `dsx.errorCount` tracks the ledger's
            // monotonic total from EVERY feeder (a stale counter between ambient emissions
            // would jump unpredictably); `dsx.lastError` stays ambient-only (semantic errors,
            // not transport noise like card_declined).
            DSXErrorLedger.shared.append(DSXError(
                code: code, message: message, recoverable: recoverable, data: data,
                scheme: scheme, origin: "call", delivered: delivered))
            DSX.state.setPath("dsx.errorCount", DSXErrorLedger.shared.count())
            var payload: [String: Any] = ["scheme": scheme, "action": action,
                                          "code": code, "delivered": delivered]
            if let data { payload["data"] = data }
            ModuleRegistry.shared.dispatch("module.callFailed", payload, .void)
        }
    }

    // MARK: Routing outcome

    /// From the pre-filter: "not mine" - continue to the named handlers.
    public func skip() { didSkip = true }

    // MARK: Output (terminal; first call wins)

    /// Terminal success - resolves the JS `await despia(...)` for this call,
    /// or the awaiting `dsx.module(...)` continuation when this dispatch was
    /// initiated by another package.
    public func resolve(_ data: JSONConvertible? = nil) {
        guard claimTerminal() else { return }
        let payload = data?.asJSON.foundationValue
        if let onTerminal = callParams.onTerminal {
            onTerminal(.resolve(payload))
            return
        }
        let envelope: [String: Any] = [
            "id": callParams.requestID ?? NSNull(), "scheme": proxyScheme, "host": callHost,
            "event": "result", "final": true, "data": payload ?? NSNull()
        ]
        // Deliver to the ORIGIN surface's mounted sink (dsx.messenger). Every surface
        // rides this one seam now — the web included (DSXWebView mounts "web", the default
        // target for calls with no surface origin). No sink mounted = silent no-op
        // (pure-native app / surface torn down) — the kernel names NO module here.
        let target = callParams.surfaceID ?? "web"
        messenger.deliver(to: target,
            DSXEgress(target: target, scheme: proxyScheme, rid: callParams.requestID, payload: envelope))
    }

    /// Terminal failure - rejects the JS `await window.despia(...)` (or the
    /// awaiting `dsx.module(...)` continuation). `code` is a stable,
    /// machine-readable identifier (e.g. "payment_failed"); `data` is
    /// optional free-form metadata (a String, a JSON object, anything) the
    /// catch handler can read. Web sees a uniform `catch (e) { e.code; e.data }`;
    /// a Swift caller receives `ModuleCallError.actionFailed(code, data)`.
    public func error(_ code: String = "error", _ data: JSONConvertible? = nil) {
        sendError(code, message: nil, recoverable: false, data: data)
    }

    /// Canonical SUCCESS — the `{ ok, data }` half of the uniform package result contract: resolves
    /// the await with `data`. An alias of `resolve`, paired with `fail` so a package reads
    /// `dsx.ok(...)` / `dsx.fail(...)` symmetrically. (Web success = the promise resolving with
    /// `data`; there's no `ok` wrapper key — resolving IS the ok signal, rejecting is the error one.)
    public func ok(_ data: JSONConvertible? = nil) { resolve(data) }

    /// Canonical FAILURE with the uniform error shape — the `{ ok: false, error }` half of the
    /// contract. The catch handler reads a stable, predictable object on EVERY package:
    ///   • `code`        — stable machine id to branch on (e.g. `"permission_denied"`)
    ///   • `message`     — human-readable, safe to show
    ///   • `recoverable` — whether a retry / alternate path is worth offering (else it's terminal)
    ///   • `data`        — optional extra metadata
    /// Web: `catch (e) { e.code; e.message; e.recoverable; e.data }`. Native callers receive
    /// `ModuleCallError.actionFailed(code, data)` (message/recoverable ride the web envelope; the
    /// native enum stays source-stable). Prefer `fail` over bare `error(code,)` for any failure the
    /// caller must branch on — it's the contract the whole catalog is converging on.
    public func fail(_ code: String, message: String? = nil, recoverable: Bool = false,
                     data: JSONConvertible? = nil) {
        sendError(code, message: message, recoverable: recoverable, data: data)
    }

    /// `dsx.reject(code, message:, recoverable:, data:)` — the canonical native-bus name for the
    /// structured terminal error (`{code, message, recoverable, data}`); an alias of `fail`. A Swift
    /// caller of `dsx.module.x.y()` receives it as `ModuleCallError.actionFailed(code, data)`.
    public func reject(_ code: String, message: String? = nil, recoverable: Bool = false,
                       data: JSONConvertible? = nil) {
        sendError(code, message: message, recoverable: recoverable, data: data)
    }

    /// Shared error delivery for `error` / `fail` / `reject` — the HAT decides
    /// (error-system.md §3.2):
    ///   · call hat (a handler's per-call dsx) — TERMINAL, first call wins, byte-identical
    ///     to before. The web envelope always carries `code` + `recoverable`; `message` only
    ///     when given; native `onTerminal` now ALSO carries message/recoverable (internal
    ///     widening — the funnel records full fidelity, callers see code+data unchanged).
    ///   · ambient hat (the module/registrar handle — no call to settle) — the SAME verb is
    ///     the out-of-band EMISSION: ledger + module.error + page channel + reactive keys,
    ///     REPEATABLE (never rides claimTerminal). Replaces the old accidental
    ///     one-shot-broadcast-then-dead registrar behavior outright.
    private func sendError(_ code: String, message: String?, recoverable: Bool, data: JSONConvertible?) {
        guard isCall else {
            reportAmbientError(scheme: store.primaryScheme.isEmpty ? "app" : store.primaryScheme,
                               code: code, message: message, recoverable: recoverable,
                               data: data?.asJSON.foundationValue)
            return
        }
        guard claimTerminal() else { return }
        let payload = data?.asJSON.foundationValue
        if let onTerminal = callParams.onTerminal {
            onTerminal(.error(code: code, data: payload, message: message, recoverable: recoverable))
            return
        }
        var envelope: [String: Any] = [
            "id": callParams.requestID ?? NSNull(), "scheme": proxyScheme, "host": callHost,
            "event": "error", "final": true, "data": payload ?? NSNull(),
            "code": code, "recoverable": recoverable
        ]
        if let message { envelope["message"] = message }
        // WEB-caller terminal errors feed the ledger HERE — the one point that still holds
        // full fidelity; native/markup callers feed via reportCallFailure instead (the two
        // paths are disjoint, so no double entries — error-system.md §3.3a). The web caller
        // receives the rejection envelope, hence delivered = true. `dsx.errorCount` stays in
        // sync from every feeder; `dsx.lastError` stays ambient-only (semantic errors, not
        // transport noise like card_declined).
        DSXErrorLedger.shared.append(DSXError(
            code: code, message: message, recoverable: recoverable, data: payload,
            scheme: proxyScheme, origin: "call", delivered: true))
        DSX.state.setPath("dsx.errorCount", DSXErrorLedger.shared.count())
        // Deliver to the ORIGIN surface's mounted sink (dsx.messenger; "web" default —
        // DSXWebView mounts it). onTerminal (native callers) above is unchanged.
        let target = callParams.surfaceID ?? "web"
        messenger.deliver(to: target,
            DSXEgress(target: target, scheme: proxyScheme, rid: callParams.requestID, payload: envelope))
    }

    // MARK: Events (non-terminal, repeatable - stream this call's rid)

    public func event(_ name: String, _ value: JSONConvertible? = nil) {
        if isSettled { return }
        // `final` follows the terminal rule `isFinal(false) || event=="error"`, so an
        // event named "error" still closes the stream.
        let envelope: [String: Any] = [
            "id": callParams.requestID ?? NSNull(), "scheme": proxyScheme, "host": callHost,
            "event": name, "final": name == "error", "data": value?.asJSON.foundationValue ?? NSNull()
        ]
        // Stream to the ORIGIN surface's mounted sink (dsx.messenger; "web" default —
        // DSXWebView mounts it). Per-call events reach every surface the same way now.
        let target = callParams.surfaceID ?? "web"
        messenger.deliver(to: target,
            DSXEgress(target: target, scheme: proxyScheme, rid: callParams.requestID, payload: envelope))
    }

    // MARK: Broadcast (out-of-band, no rid - fans out to scheme subscribers)

    public func broadcast(_ name: String, _ value: JSONConvertible? = nil) {
        broadcast(on: proxyScheme, name, value)
    }

    /// Broadcast out-of-band on an EXPLICIT surface scheme rather than this Context's own scheme —
    /// for a bound coordinator that emits a named surface's events on that surface's behalf. The only
    /// difference from `broadcast(_:_:)` is the `scheme` the envelope/native bus carry; web subscribers
    /// still see it via `window.despia.on(<scheme>)` and native via `dsx.events.on(<scheme>)`. Used by
    /// the `<DSXView/>` native screen so its lifecycle rides a STABLE `dsx-view` scheme even though the
    /// Context binding it (Routing) owns a different (here scheme-less) name. Identical envelope shape to
    /// `broadcast`, so the web wire format is unchanged — only the scheme is chosen by the caller.
    public func broadcast(on scheme: String, _ name: String, _ value: JSONConvertible? = nil) {
        let payload = value?.asJSON.foundationValue
        // Out-of-band envelope (id:nil, host:"").
        let envelope: [String: Any] = [
            "id": NSNull(), "scheme": scheme, "host": "",
            "event": name, "final": true, "data": payload ?? NSNull()
        ]
        // Every MOUNTED surface first (dsx.messenger) — the web included (DSXWebView's
        // "web" sink → window.despia.on) — each filtering client-side by scheme.
        // BEFORE the native bus, preserving the pre-messenger relative order
        // (web envelope enqueued, then in-process handlers).
        messenger.deliverBroadcast(
            DSXEgress(target: "*", scheme: scheme, rid: nil, payload: envelope))
        events.publish(scheme, name, payload)   // in-process native subscribers (dsx.events.on)
        // ALIAS fan-out (the ModuleRegistry .void fold's broadcast twin): when the scheme is a
        // module chain with legacy aliases, the same envelope also rides each alias
        // channel — a shipped page's despia.on("watchhealth") and a native
        // dsx.events.on(alias) keep hearing the module they always heard. Non-module
        // schemes (dsx-view, …) miss the table and fan nowhere.
        for alias in ModuleRegistry.shared.identityTable().aliasesByChain[scheme.lowercased()] ?? [] {
            let aliased: [String: Any] = [
                "id": NSNull(), "scheme": alias, "host": "",
                "event": name, "final": true, "data": payload ?? NSNull()
            ]
            messenger.deliverBroadcast(
                DSXEgress(target: "*", scheme: alias, rid: nil, payload: aliased))
            events.publish(alias, name, payload)
        }
    }

    /// NATIVE-ONLY broadcast — fans out to in-process `dsx.events.on(scheme)` subscribers WITHOUT the
    /// web round-trip (`dom.proxy`). For a HIGH-FREQUENCY native stream (e.g. a 30–60 Hz playhead/level
    /// tick a native component renders) where evaluating JS on the web view every frame would be
    /// wasteful and the web isn't a consumer. Web-facing events still use `broadcast` (which does both).
    /// Same scheme/event/data contract, so a subscriber written for `broadcast` works unchanged.
    public func broadcastNative(_ name: String, _ value: JSONConvertible? = nil) {
        events.publish(proxyScheme, name, value?.asJSON.foundationValue)
    }

    // MARK: Webview window globals — REMOVED from the kernel. The LEGACY `window.<name> = value`
    // and `window.<name>(payload)` projections now live in the DSXWebView package (the sole web egress):
    // `dsx.module.dom.set(["name":…,"value":…])` / `dsx.module.dom.call(["fn":…,"args":[…]])`.
    // Prefer the MODERN reply path anyway — `dsx.resolve` / `dsx.broadcast` / `dsx.event` (despia.on).

    // `dsx.css` was REMOVED from the kernel: the CSS-var projection lives ONLY in the DSXWebView
    // package (the sole web egress) — call `dsx.module.dom.css(["property":…,"value":…])` directly.

    // MARK: Settle helpers

    private func claimTerminal() -> Bool {
        settleLock.lock(); defer { settleLock.unlock() }
        if settled { return false }
        settled = true
        return true
    }

    fileprivate var isSettled: Bool {
        settleLock.lock(); defer { settleLock.unlock() }
        return settled
    }
}

// MARK: - Capability flags

public struct Flags {
    /// App loads only from the bundled local HTML (no remote origin). Read from the kernel's OWN
    /// store (constitution Art. 1 — the kernel names no ClosedSource symbol); the ContentServer
    /// package seeds `server.onlyLocal` at setup. Absent (package excluded) → false (remote), the
    /// fail-open default.
    public func onlyLocalServer() -> Bool { (DSX.state.getPath("server.onlyLocal") as? Bool) ?? false }
    /// Bridge wire-format version.
    public func bridgeVersion() -> Int { VirtualBridge.bridgeVersion }
}

public struct EmptyConfig {
    public init() {}
}

// MARK: - Shared container (the one reserved App Group)

/// A view of the app's shared App Group container - the single reserved
/// `group.<bundleid>.container` that every package and the app's extensions
/// share. Inside that one group each package gets a **subcontainer**: a folder
/// (for files) and a key prefix (for values) named after the package scheme, so
/// packages never collide and no package hardcodes the group name. iOS-only.
///
/// `dsx.container` is *your* subcontainer (named after your scheme); read and
/// write it directly. Reach another package's subcontainer by name -
/// `dsx.container.onesignal` (typed dot form, like `dsx.module.<scheme>`) or
/// `dsx.container["onesignal"]` (string form, and the escape hatch when a name
/// collides with a member below).
///
/// ```swift
/// dsx.container.set("player_id", id)                   // your folder, key "<scheme>.player_id"
/// let id = dsx.container.onesignal.string("player_id") // onesignal's folder
/// let dir = dsx.container.url()                         // your folder on disk
/// ```
///
/// One reserved group replaces the per-package groups (`.onesignal`,
/// `.sharetarget`, …): the App ID provisions it once, CI checks one group, and a
/// package opts in with `"container": true` in its manifest (its subcontainer is
/// its `scheme`) - no new provisioning. You write only your own folder; to use
/// another package's data, call its exposed feature (`dsx.module.<scheme>.<action>`)
/// rather than reaching into its folder. Packages share the app process, so this
/// is encapsulation by convention, not a kernel boundary - keep real secrets in
/// the Keychain. Full security model: OpenSource/Skills/containers.md.
@dynamicMemberLookup
public struct Container {

    /// The one reserved App Group id for this build, derived from the app's
    /// bundle id - matches the `group.${BUNDLE_ID}.container` the CI provisions.
    public static var groupID: String {
        "group.\(Bundle.main.bundleIdentifier ?? "").container"
    }

    /// The App Group id this container resolves to. Use it instead of hardcoding
    /// the string anywhere app-side, e.g. `dsx.container.group`.
    public var group: String { Container.groupID }

    /// This subcontainer's name (a package scheme). "" addresses the shared root
    /// (unprefixed); prefer a named subcontainer and don't write to the root.
    public let name: String
    /// `true` only for `dsx.container` (your own folder). A named view
    /// (`dsx.container.<other>`) is `false`: read-only, so a package can't write,
    /// remove, or signal inside another package's folder through this API.
    private let isOwn: Bool
    /// Whether a `set` / `remove` auto-signals observers. `true` by default (the
    /// container is for shared data, so a write notifies); `batch { }` turns it
    /// off so a group of writes signals once.
    private let autoPost: Bool
    private let defaults: UserDefaults?

    init(_ name: String, own: Bool, autoPost: Bool = true) {
        self.name = Container.sanitize(name)
        self.isOwn = own
        self.autoPost = autoPost
        self.defaults = UserDefaults(suiteName: Container.groupID)
    }

    /// Blocks a write/signal aimed at another package's folder (`own == false`).
    /// In-process packages *can* still bypass this via raw `UserDefaults` - it's
    /// an API guardrail and a clear nudge, not a process boundary (containers.md).
    private func deniesForeign(_ op: String) -> Bool {
        guard !isOwn else { return false }
        #if DEBUG
        print("[container] '\(op)' is not allowed on another package's folder '\(name)'. Write your own via dsx.container, or use \(name)'s exposed feature: dsx.module.\(name).<action>.")
        #endif
        return true
    }

    // MARK: Subcontainers (the folders inside the one shared group)

    /// A **read-only** view of another package's subcontainer, by name. Typed dot
    /// form: `dsx.container.onesignal`. Reads are an escape hatch; writes / posts
    /// are blocked - write only your own folder. For anything real, use the owning
    /// package's exposed feature: `dsx.module.onesignal.<action>`. A real member
    /// name shadows the dot form, so for a colliding name use the subscript:
    /// `dsx.container["data"]`. Routing is root-relative (top-level folders, one
    /// per scheme); don't chain past one level.
    public subscript(dynamicMember name: String) -> Container { Container(name, own: false) }

    /// A read-only view of another package's subcontainer, by string - for dynamic
    /// names or names that collide with a member (`dsx.container["data"]`).
    public subscript(_ name: String) -> Container { Container(name, own: false) }

    /// Explicit read-only named-subcontainer accessor (same as the subscript).
    public func sub(_ name: String) -> Container { Container(name, own: false) }

    // MARK: Key/value (scoped to this subcontainer)

    private func scoped(_ key: String) -> String { name.isEmpty ? key : "\(name).\(key)" }

    /// `true` when the App Group is actually provisioned for this build - the
    /// shared container exists (entitlement present + the profile carries the
    /// group). When `false`, reads return defaults and writes are dropped, so a
    /// package degrades gracefully on a build that didn't ship the container.
    public var isAvailable: Bool {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Container.groupID) != nil
    }

    public func string(_ key: String) -> String? { defaults?.string(forKey: scoped(key)) }
    public func bool(_ key: String) -> Bool { defaults?.bool(forKey: scoped(key)) ?? false }
    public func int(_ key: String) -> Int { defaults?.integer(forKey: scoped(key)) ?? 0 }
    public func double(_ key: String) -> Double { defaults?.double(forKey: scoped(key)) ?? 0 }
    public func data(_ key: String) -> Data? { defaults?.data(forKey: scoped(key)) }
    /// The raw stored value (any property-list type), or `nil`.
    public func value(_ key: String) -> Any? { defaults?.object(forKey: scoped(key)) }

    /// Store a value in *your own* folder **and signal observers** - one call,
    /// because the container is for shared data, so a write notifies. Passing
    /// `nil` removes the key. Several writes at once: `batch { }` (signals once).
    /// Signal without writing: `post()`. A no-op on another package's folder.
    public func set(_ key: String, _ value: Any?) {
        if deniesForeign("set") { return }
        if let value = value { defaults?.set(value, forKey: scoped(key)) }
        else { defaults?.removeObject(forKey: scoped(key)) }
        if autoPost { ContainerObservers.shared.post(signalName) }
    }

    /// Remove a value from *your own* folder (and signal observers, like `set`).
    /// A no-op on another package's folder.
    public func remove(_ key: String) {
        if deniesForeign("remove") { return }
        defaults?.removeObject(forKey: scoped(key))
        if autoPost { ContainerObservers.shared.post(signalName) }
    }

    /// Group several writes into a single change signal: the writes inside don't
    /// each notify; observers are signalled once when the block returns. Own
    /// folder only.
    ///
    ///     dsx.container.batch { $0.set("url", u); $0.set("refresh", 15) }
    public func batch(_ body: (Container) -> Void) {
        if deniesForeign("batch") { return }
        body(Container(name, own: true, autoPost: false))
        ContainerObservers.shared.post(signalName)
    }

    // MARK: Files (this subcontainer's folder in the shared container)

    /// This subcontainer's folder in the shared file container, created on
    /// demand. `nil` when the container isn't provisioned. Use it to hand files
    /// between the app and its extensions.
    public func url() -> URL? {
        guard let base = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: Container.groupID) else { return nil }
        guard !name.isEmpty else { return base }
        let dir = name.split(separator: ".").reduce(base) {
            $0.appendingPathComponent(String($1), isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // MARK: Observe (cross-process change signals)

    /// Darwin notification name for this subcontainer's change signal.
    private var signalName: String { "\(Container.groupID).changed.\(name)" }

    /// Signal that this subcontainer changed - a name-only cross-process ping
    /// (Darwin notification) that observers in any *running* process pick up.
    /// Call it after writing. App Group `UserDefaults` changes are NOT delivered
    /// across processes by KVO or `NSUserDefaultsDidChange` (those fire only for
    /// same-process writes), so this is how a writer tells readers to re-read.
    /// An extension that can't reach `dsx` posts the same name directly via
    /// `CFNotificationCenterPostNotification` (see containers.md).
    public func post() {
        if deniesForeign("post") { return }
        ContainerObservers.shared.post(signalName)
    }

    /// Observe cross-process changes to this subcontainer (writes signalled via
    /// `post()` from this app or an extension). The handler runs on the main
    /// thread while the app is alive - re-read the container inside it and deliver
    /// (e.g. `dsx.broadcast`). Returns a subscription; keep it to `cancel()`, or
    /// ignore it to observe for the app's lifetime. The app only receives signals
    /// while running; on cold launch, re-read in `hydrate` / `onBecomeActive`.
    @discardableResult
    public func observe(_ handler: @escaping () -> Void) -> ContainerSubscription {
        if deniesForeign("observe") { return ContainerSubscription(name: "", token: UUID()) }
        let token = ContainerObservers.shared.add(name: signalName, handler)
        return ContainerSubscription(name: signalName, token: token)
    }

    // MARK: Bulletproofing

    /// Keep names safe for UserDefaults keys and folder paths: letters, digits,
    /// `.`, `_`, `-`; drop everything else. (URL schemes are already safe.)
    private static func sanitize(_ raw: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        return String(raw.filter { allowed.contains($0) })
    }
}

// MARK: - Cookies — one jar across the web layer, native HTTP, and DSX

/// **DSXCookies** — bridges cookies between the three worlds, JS-style, the web layer as source
/// of truth. When the DSX DOM (`WKWebView`) sets a cookie, we:
///   1. **mirror it to `HTTPCookieStorage.shared`** — so native `fetch` (the default URLSession,
///      which uses `.shared`) sends it automatically: auth survives the web→native boundary; and
///   2. **publish a non-HttpOnly reactive snapshot** the markup reads as
///      **`dsx.cookie.name`** (one value) or **`dsx.cookie`** (the whole jar,
///      `{ name: value, … }`) — re-rendering on change without exposing server-only credentials.
///
/// As close to JS as the platform allows (`document.cookie`, but typed + reactive). Read-only
/// from DSX in v1 (the web/native sets them); a `dsx.module.cookie.set(…)` write is a follow-up.
public final class DSXCookies: NSObject, ObservableObject {
    public static let shared = DSXCookies()
    /// Monotonic input token used by native DSX component contexts. The cookie jar remains the
    /// source of truth; this only makes a rebuilt value context differ without replacing views.
    private(set) var renderRevision: UInt64 = 0
    /// name → value, the reactive snapshot DSX reads. (`dsx.cookie` = this dict; `dsx.cookie.x` = `jar["x"]`.)
    @Published public private(set) var jar: [String: String] = [:] {
        didSet { renderRevision &+= 1 }
    }
    private var domainHint: String?         // last-known web host (view URL / existing cookies), the `set` default

    private override init() { super.init() }

    /// The dom module's cookie observer reports the bound web view's host (the default write domain) —
    /// no `WKWebView` in the kernel.
    public func setDomainHint(_ host: String?) { if let host, !host.isEmpty { domainHint = host } }

    /// The dom module's cookie observer pushes the web cookie store's cookies here (web → native):
    /// mirror every cookie to `HTTPCookieStorage.shared` (so native `fetch`/URLSession sends
    /// HttpOnly credentials) and publish only script-readable cookies in the reactive `jar`.
    /// This preserves the browser's `document.cookie` confidentiality boundary.
    public func ingest(_ cookies: [HTTPCookie]) {
        var snap: [String: String] = [:]
        let native = HTTPCookieStorage.shared
        for c in cookies {
            native.setCookie(c)                                      // mirror → native URLSession fetch
            if !c.isHTTPOnly { snap[c.name] = c.value }               // never expose server-only credentials to DSX
        }
        if domainHint == nil, let d = cookies.first?.domain { domainHint = d.hasPrefix(".") ? String(d.dropFirst()) : d }
        DispatchQueue.main.async { if self.jar != snap { self.jar = snap } }
    }

    /// **Set** a cookie — `dsx.cookie.name = "…"` from markup, or `DSXCookies.shared.set(…)` natively.
    /// Written to `HTTPCookieStorage.shared` (so the native fetch URLSession sends it) + the reactive
    /// jar, and fired as `cookie.webWrite` so the dom module mirrors it into the web cookie store.
    /// Domain defaults to the web app's host (Dom's reported hint). No host known yet → logs, no-ops.
    public func set(_ name: String, _ value: String, domain: String? = nil, path: String = "/", expires: Date? = nil) {
        guard let host = domain ?? domainHint, !host.isEmpty else {
            kernelLog("[DSXCookies] cannot set '\(name)': no web host known yet — set it after the web layer has loaded, or pass a domain.")
            return
        }
        var props: [HTTPCookiePropertyKey: Any] = [.name: name, .value: value, .path: path, .domain: host]
        if let expires { props[.expires] = expires }
        guard let cookie = HTTPCookie(properties: props) else { return }
        HTTPCookieStorage.shared.setCookie(cookie)              // native URLSession fetch sends it
        if jar[name] != value { jar[name] = value }             // optimistic, so a same-action read sees it
        // The dom module hooks "cookie.webWrite" to write into the web cookie store (kernel holds no WKWebView).
        ModuleRegistry.shared.dispatch("cookie.webWrite", cookie, .void)
    }
}

/// A handle to a `dsx.container.observe { }` registration; `cancel()` to stop.
public struct ContainerSubscription {
    fileprivate let name: String
    fileprivate let token: UUID
    public func cancel() { ContainerObservers.shared.remove(name: name, token: token) }
}

/// Cross-process change signals for the shared container, over Darwin
/// notifications - the only reliable app<->extension signal on iOS (KVO and
/// `NSUserDefaultsDidChange` fire only for same-process writes). Maps each Darwin
/// name to its Swift handlers and dispatches them on the main thread. A name is
/// registered with the Darwin center on its first observer and removed with its
/// last, so an unused signal costs nothing.
final class ContainerObservers {
    static let shared = ContainerObservers()
    private let lock = NSLock()
    private var handlers: [String: [UUID: () -> Void]] = [:]

    func add(name: String, _ handler: @escaping () -> Void) -> UUID {
        let token = UUID()
        lock.lock()
        let isFirst = handlers[name]?.isEmpty ?? true
        handlers[name, default: [:]][token] = handler
        lock.unlock()
        if isFirst { registerDarwin(name) }
        return token
    }

    func remove(name: String, token: UUID) {
        lock.lock()
        handlers[name]?.removeValue(forKey: token)
        let nowEmpty = handlers[name]?.isEmpty ?? true
        if nowEmpty { handlers.removeValue(forKey: name) }
        lock.unlock()
        if nowEmpty { unregisterDarwin(name) }
    }

    func post(_ name: String) {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name as CFString), nil, nil, true)
    }

    fileprivate func fire(_ name: String) {
        lock.lock(); let blocks = Array((handlers[name] ?? [:]).values); lock.unlock()
        guard !blocks.isEmpty else { return }
        DispatchQueue.main.async { blocks.forEach { $0() } }
    }

    private func registerDarwin(_ name: String) {
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            { _, _, cfName, _, _ in
                guard let cfName = cfName else { return }
                ContainerObservers.shared.fire(cfName.rawValue as String)
            },
            name as CFString, nil, .deliverImmediately)
    }

    private func unregisterDarwin(_ name: String) {
        CFNotificationCenterRemoveObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            CFNotificationName(name as CFString), nil)
    }
}

// MARK: - Cross-package call proxies (dsx.module dot chains)
//
// Each chain step (`dsx.module` -> `.appsflyer` -> `.set_user_id` -> `(args)`)
// is a tiny stateless wrapper. The dynamic-member subscript powers the dot
// form ("typed-feeling" for code), the plain string subscript powers the
// `[…]` form (dynamic strings / non-identifier names). callAsFunction at
// the leaf invokes the actual dispatch / call. Same shape on Kotlin via
// `operator fun get` + `operator fun invoke` (see runtime-api.md).

// `dsx.module` — the unified, DSX-aligned root. The chain `dsx.module.<scheme>.<method>(args)`
// resolves to a `ModuleAction` whose leaf has TWO `callAsFunction` overloads: an `async throws`
// one (selected by `await` — returns the resolve payload) and a sync `throws` one (selected
// without `await` — fire-and-forget). So `await` vs no-`await` picks the form, exactly like
// `await dsx.module.x.y()` vs a bare `dsx.module.x.y()` in DSX. Same shape on Kotlin via
// `operator fun get` + a suspend / non-suspend `invoke`.
@dynamicMemberLookup
public struct ModuleProxy {
    internal let dsx: Context   // internal (not fileprivate) so the generated typed accessors (ModuleAccessors.generated.swift) can build `<Scheme>Module(dsx:)`
    public subscript(dynamicMember scheme: String) -> ModuleScheme { ModuleScheme(dsx: dsx, scheme: scheme) }
    public subscript(_ scheme: String) -> ModuleScheme { ModuleScheme(dsx: dsx, scheme: scheme) }

    /// The canonical call contract — ONE JSON envelope: `{ scheme, method: […], args }`.
    /// `method` is an ARRAY path (never a dotted string — no separator can collide), lowered to
    /// the registry's `scheme://a/b/c` route. The dot / named-arg / subscript sugar
    /// (`dsx.module.x.a.b(args)`) lowers to exactly this. Awaitable; returns the handler's
    /// `dsx.resolve(...)` payload, throws `ModuleCallError` like the dot form.
    ///
    ///     try await dsx.module(JSON.obj()
    ///         .put("scheme", "airbridge")
    ///         .put("method", JSON.arr("track", "event"))
    ///         .put("args",   JSON.obj().put("name", "purchase")))
    @discardableResult
    public func callAsFunction(_ envelope: JSON) async throws -> JSON {
        let dict   = envelope.foundationValue as? [String: Any] ?? [:]
        let scheme = dict["scheme"] as? String ?? ""
        let path   = (dict["method"] as? [Any])?.compactMap { $0 as? String } ?? []
        let args   = dict["args"] as? [String: Any]
        return try await dsx._call(scheme: scheme, action: path.joined(separator: "/"), args: args)
    }
}

@dynamicMemberLookup
public struct ModuleScheme {
    fileprivate let dsx: Context
    fileprivate let scheme: String
    public subscript(dynamicMember action: String) -> ModuleAction { ModuleAction(dsx: dsx, scheme: scheme, action: action) }
    public subscript(_ action: String) -> ModuleAction { ModuleAction(dsx: dsx, scheme: scheme, action: action) }

    /// The live native object this package EXPORTED under `name` (via `dsx.export`), or nil — cast
    /// it to the concrete type (the caller imports the framework; the kernel never names it). Owner-
    /// namespaced, so `dsx.module.dom.object("view")` is unambiguously Dom's exported "view".
    public func object(_ name: String) -> Any? { dsx.shared.use("\(scheme).\(name)") }

    /// `dsx.module.<scheme>.context` — READ this package's published context (data), typed + exclusion-safe:
    /// `dsx.module.metaads.context.facebookAds.bool` (pull, nested via dot) or
    /// `dsx.module.metaads.context.on("facebookAds") { … }` (subscribe). An excluded owner has no registry
    /// entry, so every read is the declared default (fail-open). See DSXStateProxy.
    public var context: DSXStateProxy { DSXStateProxy(scheme: scheme) }
    /// Transitional alias of `dsx.module.<scheme>.context` — kept so existing `.state` reads keep compiling.
    public var state: DSXStateProxy { DSXStateProxy(scheme: scheme) }

    /// `dsx.module.<scheme>.delegate.<event>` — ATTACH to (or INVOKE) a delegate point this package
    /// owns, scheme-namespaced (`<scheme>.<event>`) so two packages' same-named points never collide.
    /// The owner declares it in `dsx.json` `delegate`; a consumer attaches `{ input in … }`. Mirrors
    /// `dsx.delegate` (host events) but scoped to a named package. See DSXDelegateProxy.
    public var delegate: DSXDelegateProxy { DSXDelegateProxy(dsx: dsx, prefix: scheme + ".") }

    /// The PRIMARY chain this handle's spelling resolves to (alias → chain; a primary
    /// or unknown spelling stays itself) — the ONE normalization point every reserved
    /// member reads (the Kotlin twin's `primaryChain`), so an alias handle can never
    /// answer build facts under one spelling and hear events under another.
    private var primaryChain: String {
        let key = scheme.lowercased()
        return ModuleRegistry.shared.identityTable().aliases[key] ?? key
    }

    /// `dsx.module.<chain>.available` — TRUE when this identity is registered in THIS build
    /// and not under the excluded overlay. The generic pre-flight for optional modules; a
    /// never-existed name answers false here AND false at `.excluded` (the honest split).
    /// Non-throwing by design (Rule 9 allowlists the reserved members).
    public var available: Bool {
        ModuleRegistry.shared.isAvailable(primaryChain) && ModuleRegistry.shared.excludedEntry(for: primaryChain) == nil
    }

    /// `dsx.module.<chain>.excluded` — the honest build fact: `false` when shipped (or when
    /// the name never existed), else the DespiaExcluded entry (`{ reason: "excluded" |
    /// "cascade", from? }`) — the 1:1 twin of the page's `despia.excluded` entries
    /// (excludedEntry itself answers legacy alias spellings, matching matchesEntry).
    public var excluded: JSON {
        guard let entry = ModuleRegistry.shared.excludedEntry(for: primaryChain) else { return JSON.from(false) }
        return JSON.from(entry)
    }

    /// `dsx.module.<chain>.on("kind") { payload in … }` — subscribe to this module's OWN
    /// events. Subscribes under the PRIMARY chain — the channel modules EMIT on
    /// (resolvedScheme-scoped) — so an ALIAS handle hears the same events (twin parity
    /// with the TS chain proxy). When the owner registers LATER than this subscription
    /// the table can't normalize yet and the watcher keys the verbatim spelling — the
    /// emission-side alias fan-out (ModuleRegistry.dispatch `.void` / dsx.broadcast) still
    /// delivers, so boot order never decides whether a watcher hears. Reserved member (real —
    /// it shadows dynamic lookup, so no action can ever be named `on`); non-throwing.
    public func on(_ kind: String, _ handler: @escaping (Any?) -> Any?) {
        dsx.register("\(primaryChain).\(kind)", handler)
    }
}

@dynamicMemberLookup
@dynamicCallable
public struct ModuleAction {
    fileprivate let dsx: Context
    fileprivate let scheme: String
    fileprivate let action: String

    /// N-level chaining — `dsx.module.store.products.subscriptions.buy(args)` accumulates the path
    /// (`products/subscriptions/buy`), the array path of the envelope one segment per step, lowered
    /// to the registry route `store://products/subscriptions/buy`. Additive: the one-level form is
    /// just a one-segment path; the subscript form `[…]` carries a dynamic / non-identifier segment.
    public subscript(dynamicMember segment: String) -> ModuleAction {
        ModuleAction(dsx: dsx, scheme: scheme, action: "\(action)/\(segment)")
    }
    public subscript(_ segment: String) -> ModuleAction {
        ModuleAction(dsx: dsx, scheme: scheme, action: "\(action)/\(segment)")
    }

    /// Awaitable — the native twin of `await dsx.module.scheme.action({…})`. Returns the handler's
    /// `dsx.resolve(...)` payload; throws `ModuleCallError` (`.actionFailed` on `dsx.error`,
    /// `.notLoaded` when no package owns the scheme). Chosen when the call site uses `await`.
    @discardableResult
    public func callAsFunction(_ args: [String: Any]? = nil) async throws -> JSON {
        try await dsx._call(scheme: scheme, action: action, args: args)
    }
    /// Fire-and-forget — the native twin of a bare `dsx.module.scheme.action({…})` (no await).
    /// Chosen when the call site omits `await`; `try?` is the safe-fail idiom (a missing optional
    /// package never crashes the caller).
    public func callAsFunction(_ args: [String: Any]? = nil) throws {
        try dsx._dispatch(scheme: scheme, action: action, args: args)
    }

    /// JSON-arg overloads — the 1:1 cross-language register (`dsx.module.x.y(JSON.obj().put(…))`),
    /// what the generated typed accessors (ModuleAccessors.generated.swift) lower into. Additive:
    /// a dict literal `(["k": v])` still picks the `[String: Any]?` overload (JSON isn't literal-
    /// expressible, so there's no ambiguity); `await` picks the awaitable form.
    @discardableResult
    public func callAsFunction(_ args: JSON) async throws -> JSON {
        try await dsx._call(scheme: scheme, action: action, args: args.foundationValue as? [String: Any])
    }
    public func callAsFunction(_ args: JSON) throws {
        try dsx._dispatch(scheme: scheme, action: action, args: args.foundationValue as? [String: Any])
    }

    /// Named-field calls — `dsx.module.airbridge.track.event(name: "purchase", revenue: 9.99)`.
    /// FREE on Swift via `@dynamicCallable`: the labels arrive as the args map at runtime, no
    /// declaration needed. `await` picks the awaitable form; a bare call is fire-and-forget. The
    /// dict-literal floor `action(["name": …])` keeps routing through `callAsFunction` above.
    @discardableResult
    public func dynamicallyCall(withKeywordArguments pairs: KeyValuePairs<String, Any>) async throws -> JSON {
        try await dsx._call(scheme: scheme, action: action, args: ModuleAction.args(from: pairs))
    }
    public func dynamicallyCall(withKeywordArguments pairs: KeyValuePairs<String, Any>) throws {
        try dsx._dispatch(scheme: scheme, action: action, args: ModuleAction.args(from: pairs))
    }
    private static func args(from pairs: KeyValuePairs<String, Any>) -> [String: Any] {
        var out: [String: Any] = [:]
        for (key, value) in pairs { out[key] = value }
        return out
    }
}

// MARK: - dsx.delegate (the declared, typed delegate primitive — one fold, five policies)

/// `dsx.delegate.<event>` / `dsx.module.<scheme>.delegate.<event>`. The chain step; `prefix` is empty
/// for host events and `"<scheme>."` for a package's own declared delegate points (so they namespace).
@dynamicMemberLookup
public struct DSXDelegateProxy {
    fileprivate let dsx: Context
    fileprivate let prefix: String
    public subscript(dynamicMember event: String) -> DSXDelegateEvent { DSXDelegateEvent(dsx: dsx, event: prefix + event) }
    public subscript(_ event: String) -> DSXDelegateEvent { DSXDelegateEvent(dsx: dsx, event: prefix + event) }

    // MARK: listen / send — the two-verb delegate primitive (delegates.md §2)
    //
    // `listen`/`send` are the ONLY primitives, and they lower STRAIGHT to the kernel fold — the
    // `hook`/`fire`/`fireAny`/`claim`/`collect` verbs that used to sit in between are DELETED
    // (delegates.md phase 4 — the combine policy IS what those verb names encoded). `listen` is
    // the consume side (no declaration — listening is reading
    // the global event namespace); `send` is the expose side (the emitter declares the point in its
    // `dsx.json` `delegate` block), with `allows` as its plain-Bool veto-gate form. Methods win over
    // @dynamicMemberLookup, so `dsx.delegate.listen(…)` calls this, while `dsx.delegate.<event>(…)`
    // stays the typed-invoke sugar above. ("listen"/"send"/"allows" are therefore reserved event
    // names — none exist.)

    /// LISTEN — attach a handler to a delegate event (the CONSUME side). Zero declaration: listening is
    /// just reading the global, namespaced event surface. The handler IS a raw kernel hook — return a
    /// value to answer (a `Bool` to veto, a payload to claim/collect) or `nil` to abstain; higher
    /// `priority` runs first. One hop to the kernel append, so there is nothing between you and the
    /// fold. (Distinct from the web/value verb `watch`: `global.watch(...)` streams a value, while a
    /// delegate is a native event you `listen` for.)
    ///
    ///     dsx.delegate.listen("airbridge.willTrackEvent") { [self] _ in granted }                 // veto: a Bool
    ///     dsx.delegate.listen("lifecycle.openURL")        { input in self.onOpenURL(input); return nil }
    public func listen(_ event: String, priority: Int = 0, _ handler: @escaping (Any?) -> Any?) {
        dsx.register(prefix + event, priority: priority, handler)
    }

    /// SEND — emit a delegate event and return the RAW folded answer (the EXPOSE side). The fold
    /// `combine` is resolved in this order: an explicit `combine:` argument, else the emitter's
    /// declared `dsx.json` `delegate` policy (GeneratedDelegateRegistry), else `.claim`. Returns the
    /// value straight from `dispatch` — `Bool` for `.any`/`.veto`, `[Any]` for `.collect`, the
    /// claimant for `.claim`, `nil` for `.void`. For a yes/no veto gate, reach for `allows` (below) —
    /// it reads as a plain `Bool` with no cast.
    ///
    /// PASS `combine:` EXPLICITLY when the fold must not depend on a declaration surviving into
    /// THIS build: an excluded owner contributes no `delegate` block and the silent fallback is
    /// `.claim`, which SHORT-CIRCUITS. Every site the phase-4 collapse rewrote from a fire-verb
    /// therefore names its policy — the declaration then documents the contract and powers the
    /// `dsx.delegate.<event>()` sugar, but never silently decides a fan-out.
    @discardableResult
    public func send(_ event: String, _ payload: Any? = nil, combine: ModuleRegistry.Combine? = nil) -> Any? {
        let name   = prefix + event
        let policy = combine ?? ModuleRegistry.Combine(declared: KernelTables.delegateByEvent[name]?.combine) ?? .claim
        return ModuleRegistry.shared.dispatch(name, payload, policy)
    }

    /// ALLOWS — a veto gate read as a plain `Bool` (the pretty form of a `willTrackEvent`-style
    /// guard). Sends `event` with the `veto` fold: `false` only if some watcher vetoed (returned
    /// `false`), `true` when none did — including no watchers — so an ungated event always proceeds.
    /// Like `send`, `event` must be declared in the owner's `dsx.json` `delegate` block.
    ///
    ///     guard dsx.delegate.allows("airbridge.willTrackEvent", ["category": cat]) else { return }
    public func allows(_ event: String, _ payload: Any? = nil) -> Bool {
        (send(event, payload, combine: .veto) as? Bool) ?? true
    }
}

/// One delegate point. ATTACH a handler (closure arg) or INVOKE the fold (payload arg); both flow
/// through the same kernel watcher pipeline, so any number of packages fold together. The combine
/// policy + default come from the owner's `dsx.json` `delegate` block (→ GeneratedDelegateRegistry);
/// an undeclared event folds as `claim` (first answer).
public struct DSXDelegateEvent {
    fileprivate let dsx: Context
    fileprivate let event: String

    /// ATTACH — `dsx.delegate.<event> { input in … }`. `input` is the raw payload (cast it, e.g.
    /// `input as? [String: Any]`, like any `dsx.delegate.listen` watcher); return a `JSON` answer
    /// or `nil` to abstain. Registered on the one kernel watcher table (so it folds with every
    /// other attacher), priority-ordered.
    public func callAsFunction(_ handler: @escaping (Any?) -> JSON?) {
        dsx.register(event) { input in handler(input)?.foundationValue }
    }

    /// INVOKE — `dsx.delegate.<event>(payload)`. Runs every attacher and COMBINES per the declared
    /// policy: `claim` first answer · `any` Bool (any answered) · `veto` Bool (denied if any answers
    /// `false`) · `collect` array of answers · `void` broadcast (nil). No handler → the declared default.
    @discardableResult
    public func callAsFunction(_ payload: JSON = .obj()) -> JSON? {
        let spec  = KernelTables.delegateByEvent[event]
        let input = payload.foundationValue
        let fold  = { (c: ModuleRegistry.Combine) in ModuleRegistry.shared.dispatch(event, input, c) }
        switch spec?.combine ?? "claim" {
        case "void":    _ = fold(.void); return nil
        case "any":     return .bool((fold(.any) as? Bool) ?? false)
        case "collect": return .array(((fold(.collect) as? [Any]) ?? []).map { JSON.from($0) })
        // `.collect`, NOT `.veto`: this sugar has always folded veto WITHOUT short-circuiting, so
        // every attacher runs even after a denial. Kept bit-for-bit by the collapse
        // (`dsx.delegate.allows` is the short-circuiting form, and it is unchanged).
        case "veto":    return .bool(!((fold(.collect) as? [Any]) ?? []).contains { ($0 as? Bool) == false })
        default:        return fold(.claim).map { JSON.from($0) } ?? spec?.fallback
        }
    }
}

// `dsx.context` now returns DSXStateProxy directly — a package's DATA face (the vars it publishes). Its
// DECISIONS are the separate `dsx.delegate` (a standalone root), and a consumer reaches a named package's
// data via `dsx.module.<scheme>.context`. The former DSXContextProxy umbrella (context.state +
// context.delegate) was flattened — see dsx-native-bus.md (Option B: context = data, delegate = its own).

// Legacy `dsx.dispatch` / `dsx.call` proxies were removed — use `dsx.module` (ModuleProxy),
// which provides BOTH the awaitable leaf (`try await …`) and the fire-and-forget leaf
// (`try? …`) over the same _call / _dispatch routing.

/// Ownership-transfer box for legacy dynamic payloads that must enter UIKit's main actor.
/// The body is initialized before publication, is private, and can be consumed only once on the
/// main actor. `@unchecked Sendable` is justified by that confinement invariant; callers can
/// neither read nor mutate the stored closure after construction.
private final class MainThreadWork: @unchecked Sendable {
    private var body: (() -> Void)?

    init(_ body: @escaping () -> Void) {
        self.body = body
    }

    @MainActor func run() {
        let body = body
        self.body = nil
        body?()
    }
}

/// One-shot latch. Backs `dsx.module`'s "resolve OR error, never both, never twice"
/// guarantee in the face of misbehaving handlers.
/// Every access to mutable state is protected by `lock`, so the latch is safe to capture in
/// completion handlers that may settle from different executors.
final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if claimed { return false }
        claimed = true
        return true
    }
}

// MARK: - URLSchemeResponder (WebKit-free custom-scheme serving)
//
// A module serves a custom URL scheme to the web view WITHOUT touching WebKit: it conforms to
// this and registers via `dsx.module.dom.serveScheme(["scheme": "cdn", "responder": self])`. The
// dom module wraps it in a `WKURLSchemeHandler` — the ONE place WebKit knows the scheme. Request
// in, `(Data, HTTPURLResponse)` out; `nil` ⇒ fail. Foundation-only, so the kernel stays
// WebKit-free and the responder compiles on any surface (this is what lets ContentServer's CDN
// handler drop `WKURLSchemeHandler`).
public protocol URLSchemeResponder: AnyObject {
    func respond(to request: URLRequest) async -> (Data, HTTPURLResponse)?
}

/// Optional bounded streaming extension for responders that serve files. Dom
/// detects this protocol before the legacy Data-returning seam and forwards
/// file chunks incrementally to WebKit, so a video/PDF never materializes as a
/// second in-memory copy. Existing responders remain source compatible.
public enum URLSchemeResponseBody {
    case data(Data)
    case file(url: URL, offset: UInt64, length: UInt64)
}

public struct URLSchemeStreamingResponse {
    public let response: HTTPURLResponse
    public let body: URLSchemeResponseBody

    public init(response: HTTPURLResponse, body: URLSchemeResponseBody) {
        self.response = response
        self.body = body
    }
}

public protocol URLSchemeStreamingResponder: URLSchemeResponder {
    func streamingResponse(to request: URLRequest) async -> URLSchemeStreamingResponse?
}

// MARK: - dsx.fetch (cross-platform HTTP)
//
// A single native HTTP surface every package shares instead of hand-rolling
// URLSession. Runs natively (works backgrounded, carries auth headers) and
// mirrors 1:1 to the Android runtime:
//
//     let res = try await dsx.fetch("https://api…/x",
//                                   method: "POST",
//                                   headers: ["Authorization": "Bearer \(token)"],
//                                   query:   ["current_show": id],
//                                   body:    ["balance": 50])
//     if res.ok { let json = res.json() }

/// Result of `dsx.fetch`. Same field shape across iOS/Android.
public struct FetchResponse {
    /// HTTP status code (e.g. 200, 404). 0 only for non-HTTP responses.
    public let status: Int
    /// Response header fields (as returned by the server).
    public let headers: [String: String]
    /// Raw response body.
    public let body: Data

    /// 2xx convenience flag — mirrors the JS `Response.ok`.
    public var ok: Bool { (200..<300).contains(status) }

    /// Body decoded as UTF-8 text ("" if it isn't valid UTF-8).
    public func text() -> String { String(data: body, encoding: .utf8) ?? "" }

    /// Body parsed as JSON (`.null` if the body isn't valid JSON).
    public func json() -> JSON {
        guard !body.isEmpty,
              let obj = try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed])
        else { return .null }
        return JSON.from(obj)
    }

    /// Body parsed as a JSON object (empty dict on failure) — the common case.
    public var dictionary: [String: Any] {
        (json().foundationValue as? [String: Any]) ?? [:]
    }
}

/// Errors thrown by `dsx.fetch`. Codes match the Android runtime so callers can
/// branch identically on both platforms.
public enum FetchError: Error {
    case invalidURL(String)     // "invalid_url"
    case transport(Error)       // "network" (no connection, timeout, TLS, …)
    case noResponse             // "no_response"

    public var code: String {
        switch self {
        case .invalidURL: return "invalid_url"
        case .transport:  return "network"
        case .noResponse: return "no_response"
        }
    }
}

extension Context {

    /// Shared bounded transport for all package HTTP. The default URLCache/cookie
    /// configuration is preserved, while delegate-time byte checks cancel a response
    /// before an absent or dishonest Content-Length can grow past 16 MiB.
    private static let fetchTransport: DSXBoundedDataTransport = {
        let cfg = URLSessionConfiguration.default
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .useProtocolCachePolicy
        return DSXBoundedDataTransport(configuration: cfg)
    }()

    /// Perform an HTTP request natively. `query` is appended to the URL; a non-nil
    /// `body` is JSON-encoded (with `Content-Type: application/json` unless the
    /// caller set one). Throws `FetchError` on a bad URL or transport failure;
    /// a non-2xx status is returned normally (check `res.ok` / `res.status`).
    @discardableResult
    public func fetch(_ url: String,
                      method: String = "GET",
                      headers: [String: String] = [:],
                      query: [String: String] = [:],
                      body: JSONConvertible? = nil,
                      timeout: Double = 30) async throws -> FetchResponse {
        guard let finalURL = DSXFetchPolicy.validatedURL(
            url,
            query: query,
            allowCleartext: AppEnvironment.current.isTest
        ) else { throw FetchError.invalidURL(url) }
        guard let requestMethod = DSXFetchPolicy.validatedMethod(method) else {
            throw FetchError.transport(DSXFetchPolicyError.invalidMethod)
        }
        guard DSXFetchPolicy.headersAreValid(headers) else {
            throw FetchError.transport(DSXFetchPolicyError.invalidHeaders)
        }

        var req = URLRequest(url: finalURL)
        req.httpMethod = requestMethod
        req.timeoutInterval = DSXFetchPolicy.clampedTimeout(timeout)
        for (key, value) in headers { req.setValue(value, forHTTPHeaderField: key) }

        if let body {
            do {
                req.httpBody = try DSXFetchPolicy.encodedBody(body.asJSON)
            } catch {
                throw FetchError.transport(error)
            }
            if req.value(forHTTPHeaderField: "Content-Type") == nil {
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
        }

        let data: Data, response: URLResponse
        do {
            (data, response) = try await Context.fetchTransport.data(
                for: req,
                maximumBytes: DSXFetchPolicy.maximumResponseBytes
            )
        } catch {
            throw FetchError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else { throw FetchError.noResponse }
        var headerMap: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let k = key as? String, let v = value as? String { headerMap[k] = v }
        }
        return FetchResponse(status: http.statusCode, headers: headerMap, body: data)
    }
}
