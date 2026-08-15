//
//  AppManifest.swift — `App.json`: the app-identity manifest (kernel config plane).
//
//  THE one file an app author touches to identify their app: the HOST — including
//  per-locale hosts (a localized product ships different origins per language/region).
//  Everything else is a PACKAGE's config (see OpenSource/Documentation/architecture/app-manifest.md — the
//  dissolution of the central config.json into package-owned config blocks); App.json
//  deliberately stays tiny: identity, not behavior.
//
//  File: `App.json` in the app bundle (the per-app build pipeline drops it in; see
//  /App.example.json). Hosts are bare domains — no scheme, no www — exactly like
//  `server.host` today.
//
//      {
//        "host": "myapp.com",
//        "hosts": { "de": "de.myapp.com", "fr-CA": "ca.myapp.fr", "JP": "jp.myapp.com" }
//      }
//
//  RESOLUTION (first match wins; keys are matched CASE-INSENSITIVELY):
//      1. the device's preferred language tag      ("fr-CA")
//      2. its bare language                        ("fr")
//      3. the device REGION code                   ("JP")
//      4. the manifest's default `host`
//      5. the legacy fallback (Dom's `host` config — today's build-time value)
//
//  THE RESOLVED HOST DRIVES WHAT LOADS. `startURL(legacyURL:fallbackHost:)` is the
//  single launch-URL authority: Dom's `webview_url` is the BASE (its path/query ship
//  unchanged), and when App.json resolves a host for this device that host is swapped
//  into the base — one value steers a localized fleet. No App.json → an EXPLICIT legacy URL
//  byte-for-byte; a malformed/empty legacy URL falls back to https://<host> instead of
//  crashing the launch. With no origin this returns `about:blank`. The committed framework
//  App.json routes blank projects to the compiled native `DSXStartup.dsx` component, so Dom is
//  never mounted for that state; an explicitly mounted origin-less Dom remains blank.
//
//  BACKWARD-COMPATIBLE BY CONSTRUCTION: no App.json, an empty one, or a malformed one → step 5,
//  preserving any explicitly configured legacy app origin. The committed framework legacy
//  defaults are empty, so a blank project stays local instead of inheriting a vendor website.
//  Static identity lives HERE; *dynamic* URL decisions stay claims
//  (`web.startURL`, `web.mapURL`) — config plane vs kernel events, never mixed.
//
//  ROUTING MATCH SEMANTICS (used by the internal/external link decisions): hosts are
//  compared case-insensitively with a leading "www." stripped from both sides, so
//  myapp.com == www.MyApp.com. `isHost(_:within:)` additionally accepts true
//  subdomains on a DOT BOUNDARY — blog.myapp.com is "within" myapp.com, but
//  evilmyapp.com is NOT (the old hasSuffix check matched it). List entries
//  (`safari_whitelist`, `safari_blacklist`, `never_open_in_app_tab`) are exact
//  normalized matches; an explicit "*.myapp.com" entry opts a domain AND all its
//  subdomains in.
//

import Foundation

public enum AppManifest {

    /// The parsed manifest (empty when no App.json ships). Loaded once, lazily.
    public static let manifest: [String: Any] = {
        guard let url = Bundle.main.url(forResource: "App", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        return obj
    }()

    /// Engine-level defaults — `EngineConfig.json` in the app bundle (platform config, SEPARATE from
    /// per-app `App.json` identity; wired as a Copy-Bundle-Resources entry, `DSX/Engine/OpenSource/`).
    /// Loaded once, fail-open to `[:]` so a missing/malformed file falls through to the in-engine
    /// fail-safes. This is where the default surface is set — never a Swift literal, never App.json.
    private static let engineConfig: [String: Any] = {
        guard let url = Bundle.main.url(forResource: "EngineConfig", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        return obj
    }()

    /// The BUNDLED route table — `routes.json` in the app bundle (the build ships the app's
    /// `DSX/Modules/Config/routes.json` beside App.json). This is the native OFFLINE FLOOR of the
    /// unified route table (/web/04-routing.md: ONE declaration maps URLs ↔ components on every
    /// renderer — the web build compiles this same file in): the kernel Router consults it whenever
    /// no fresher table has been PUBLISHED (the OTA plane, `global.routes` / `routes_signed`).
    /// Bundled data is code-signed app content, taken on faith exactly like App.json itself
    /// (Article 5) — it is never load-gated. nil when the app ships none (fail-open: no floor,
    /// today's behavior byte-for-byte). Raw TEXT — the Router owns the table grammar and parses.
    public static let bundledRoutesText: String? = {
        guard let url = Bundle.main.url(forResource: "routes", withExtension: "json"),
              let text = try? String(contentsOf: url, encoding: .utf8), !text.isEmpty else { return nil }
        return text
    }()

    /// The app's display NAME declared in App.json (`name`) — identity, exactly like `host`. nil when
    /// App.json names none, so `dsx.app.name` falls back to the bundle's `CFBundleDisplayName` (the
    /// build-time `APP_NAME`). Read via `dsx.app.name`; no package reads this — or `Bundle` — directly.
    public static var appName: String? { clean(manifest["name"] as? String) }

    /// Per-locale hosts, keyed lowercase once so lookups are case-insensitive
    /// ("JP", "jp" and "Jp" in a client's file all resolve).
    private static let localeHosts: [String: String] = {
        let raw = (manifest["hosts"] as? [String: String]) ?? [:]
        var out: [String: String] = [:]
        for (k, v) in raw { out[k.lowercased()] = v }
        return out
    }()

    /// EVERY host the bundled App.json declares — the default `host` plus all per-locale `hosts`
    /// values, unfiltered by locale: a declared host is app identity on ANY device (a fr-CA user
    /// tapping a link to the JP host is still on the app's own site). Surfaced for origin-anchored
    /// consumers (the Dom bridge gate) that must recognize the app's own hosts beyond the one
    /// resolved for THIS device. Bundled App.json data only (Article 5 — the one input on faith);
    /// the live-resolved host — dev origin, dynamic source — is `resolvedHost()`, consulted
    /// separately so a runtime origin switch is never defeated by this static list.
    public static let declaredHosts: [String] = {
        var out = Array(localeHosts.values)
        if let h = clean(manifest["host"] as? String) { out.append(h) }
        return out
    }()

    private static func clean(_ s: String?) -> String? {
        guard let s = s?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        return s
    }

    // MARK: - Dynamic host override (kernel SEAM — a package fills it)

    /// A package may supply a FRESHER host source at runtime — a remotely
    /// fetched, locally cached `{ host, hosts }` map — so a client can migrate
    /// domains WITHOUT an App Store rebuild. `resolvedHost()` applies the SAME
    /// locale ladder to this source FIRST; any miss falls through to the bundled
    /// App.json, and a nil/absent provider means bundled-only (today's behavior).
    ///
    /// This is an EMPTY SEAM by default — no kernel hardcoding. The kernel knows
    /// nothing about URLs, fetching, caching, or refresh policy; that is wholly
    /// the (optional, excludable) package's concern. It installs a closure here
    /// in its `setup()`; excluding the package leaves the seam nil and the host
    /// resolution exactly as it ships.
    public static var dynamicHostSource: (() -> (hosts: [String: String], defaultHost: String?)?)?

    /// DEV-ONLY full-ORIGIN override (scheme+host+port) — the staging-environment seam
    /// (`Documentation/guides/staging-and-testing.md`). Nil by default; only the (optional, excludable)
    /// DevSettings package fills it, and the kernel consults it ONLY off production —
    /// `devOrigin` below double-gates on `AppEnvironment`, so even a filled seam is inert
    /// on an App Store install. Sits ABOVE `dynamicHostSource` (a tester's explicit choice
    /// beats the live migration manifest). Nil / excluded / prod ⇒ today's ladder, byte-for-byte.
    public static var devOriginSource: (() -> URL?)?

    /// The gated read of the dev-origin seam: nil on production, whatever the seam
    /// says otherwise. Every consult point goes through THIS, never the seam directly.
    private static var devOrigin: URL? {
        guard !AppEnvironment.current.isProduction else { return nil }
        return devOriginSource?()
    }

    /// The LEGACY build-time web origin — the pre-App.json value that still configures most
    /// shipping apps (the web-surface package's `webview_url` base / bare `host` config). It is
    /// the LAST rung of the host ladder and it is the caller's to supply: `host(fallback:)` and
    /// `startURL(legacyURL:fallbackHost:)` take it as a PARAMETER precisely so the kernel never
    /// names, reads, or depends on a module's config (Article 5 / binding rule 1).
    ///
    /// `hasWebOrigin` (kernel-side introspection — the retired boot predicate's successor) has
    /// no caller to take it from, so the value arrives through this SEAM instead, exactly like
    /// `dynamicHostSource` / `devOriginSource`: nil by default (no kernel hardcoding, no module
    /// named), filled by whichever package owns the legacy origin. Accepts either a bare host
    /// (`"myapp.com"`) or a full URL (`"https://myapp.com/app"`) — only the ORIGIN is read.
    ///
    /// FAIL-OPEN, and deliberately so: an unfilled seam only makes the boot predicate treat the
    /// build as origin-less, and the predicate's native arm ALSO requires an explicitly authored
    /// `entry.fallback.view`, so an unfilled seam can never by itself take a web app off its
    /// route table.
    public static var legacyOriginSource: (() -> String?)?

    /// Optional URL (App.json `refresh_url`) that serves the SAME `{ host, hosts }`
    /// shape as App.json itself, for runtime refresh — one manifest, one shape, a
    /// live copy. The kernel only SURFACES it (app-provided data, no hardcoding);
    /// the optional `RemoteHosts` package reads it, fetches, caches, and fills the
    /// seam above. Empty/absent ⇒ static, bundled-only.
    public static var refreshURL: String? { clean(manifest["refresh_url"] as? String) }

    /// The app-authored REMOTE-BUNDLE trust anchor — App.json `bundle_signing` (the PUBLIC key[s] the
    /// app verifies remote manifests against; see `RemoteBundleGate` + `architecture/remote-bundle-signing.md`).
    /// The kernel only SURFACES the raw block (App.json is the trust anchor — Article 5); the engine's
    /// load gate parses + enforces it. ABSENT ⇒ nil ⇒ signing OFF (fail-open, today's behavior). Kept
    /// here, beside `host`/`refresh_url`, because a verification key is build-time IDENTITY (who signs
    /// this app's content), not behavior — and like every App.json input it is taken on faith.
    public static var bundleSigning: [String: Any]? { manifest["bundle_signing"] as? [String: Any] }

    /// The CONTENT ROOT — where app-authored content folders live on the app's host (App.json
    /// `hosting.content_root`). Identity, like `host`: `dsx.content` resolves a relative content
    /// path as `https://<resolvedHost()><contentRoot><path>/`. Defaults to `/dsx`; an explicit ""
    /// or "/" means the host root. Normalized to a leading-slash, no-trailing-slash form.
    public static var contentRoot: String {
        let raw = ((manifest["hosting"] as? [String: Any])?["content_root"] as? String) ?? "/dsx"
        var p = raw.trimmingCharacters(in: .whitespaces)
        if p.isEmpty || p == "/" { return "" }
        if !p.hasPrefix("/") { p = "/" + p }
        while p.hasSuffix("/") { p.removeLast() }
        return p
    }

    /// The content store's size budget in MB — `EngineConfig.json` `content.budget_mb` (engine
    /// plane, per-app overridable by editing the JSON; never a Swift literal). The store evicts
    /// least-recently-used folders at GENERATION granularity past this. 0 disables eviction.
    public static var contentBudgetMB: Int {
        ((engineConfig["content"] as? [String: Any])?["budget_mb"] as? NSNumber)?.intValue ?? 300
    }

    /// Maximum bytes accepted for one content blob. Public engine config lets media/pack apps opt
    /// above the conservative 240 MiB default, while a 1...2048 MiB clamp prevents a malformed
    /// build-time value from disabling transport bounds through integer overflow or absurd scale.
    public static var contentMaxBlobMB: Int {
        let configured = ((engineConfig["content"] as? [String: Any])?["max_blob_mb"] as? NSNumber)?.intValue
        return DSXContentTransportPolicy.clampedBlobMB(configured)
    }

    /// Run the locale ladder (steps 1–4) against ONE host source.
    private static func resolve(in hosts: [String: String], default defaultHost: String?) -> String? {
        if let tag = Locale.preferredLanguages.first?.lowercased() {            // "fr-ca"
            if let h = clean(hosts[tag]) { return h }
            let lang = String(tag.prefix(while: { $0 != "-" && $0 != "_" }))    // "fr"
            if let h = clean(hosts[lang]) { return h }
        }
        let region: String?
        if #available(iOS 16.0, *) { region = Locale.current.region?.identifier }
        else { region = Locale.current.regionCode }
        if let r = region?.lowercased(), let h = clean(hosts[r]) { return h }   // "jp"
        return clean(defaultHost)
    }

    /// The host-resolved host for THIS device, or nil when nothing provides one —
    /// the caller's legacy value then stands, which keeps every pre-App.json app
    /// byte-for-byte unchanged. A package-supplied dynamic source (e.g. a remote
    /// manifest) is consulted FIRST, then the bundled App.json.
    public static func resolvedHost() -> String? {
        // Dev-origin override first (non-prod only; see devOrigin): the whole host plane —
        // deep-link mapping, same-site checks, ContentServer sync, the content plane —
        // follows the tester's staging origin with zero per-consumer changes.
        if let dev = devOrigin, let h = clean(dev.host) { return h }
        if let source = dynamicHostSource?() {
            var keyed: [String: String] = [:]
            for (k, v) in source.hosts { keyed[k.lowercased()] = v }
            if let h = resolve(in: keyed, default: source.defaultHost) { return h }
        }
        return resolve(in: localeHosts, default: manifest["host"] as? String)
    }

    /// The app's host for THIS device. `fallback` is the legacy build-time value —
    /// callers pass Dom's `host` config.
    public static func host(fallback: String) -> String {
        resolvedHost() ?? fallback
    }

    /// The resolved ORIGIN for consumers that BUILD absolute URLs (content plane, route-table
    /// fetch, bundle sync). Normally identical to `resolvedHost()` — a bare host the caller
    /// prefixes with `https://` exactly as it always did. When the dev-origin override is
    /// active (non-production only), the override's **scheme + port ride along**
    /// (`http://192.168.1.20:3000`), so every URL-building consumer follows the SAME origin
    /// the web view loads — no https/443 split-brain on local-dev or non-443 staging origins.
    public static func resolvedOriginString() -> String? {
        if let dev = devOrigin, let h = clean(dev.host) {
            var origin = "\(clean(dev.scheme) ?? "https")://\(h)"
            if let port = dev.port { origin += ":\(port)" }
            return origin
        }
        return resolvedHost()
    }

    /// THE launch URL — the single authority for what the web view loads.
    ///
    /// `legacyURL` (Dom's `webview_url`) is the base: its path/query/fragment ship
    /// unchanged. When App.json resolves a host for this device, that host replaces
    /// the base's — per-locale origins with one config value. No App.json preserves an
    /// explicitly configured legacy URL. An empty or unparsable base falls back to
    /// `https://<resolved-or-fallback host>`, then `about:blank` when no origin exists. The
    /// framework starter manifest selects native DSX before Dom is mounted. Nothing here can
    /// crash a launch.
    public static func startURL(legacyURL: String, fallbackHost: String) -> URL {
        // A usable base must be an absolute URL with a host ("myapp.com" alone
        // parses as a pathless relative URL - not a base).
        let base = clean(legacyURL).flatMap { URL(string: $0) }.flatMap { $0.host != nil ? $0 : nil }

        guard let manifestHost = resolvedHost() else {
            if let base = base { return base }                                   // legacy, byte-for-byte
            if let h = clean(fallbackHost), let u = URL(string: "https://\(h)") { return u }
            return URL(string: "about:blank")!                                   // constant, always parses
        }

        var comps = base.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) } ?? URLComponents()
        if clean(comps.scheme) == nil { comps.scheme = "https" }
        comps.host = manifestHost
        // Dev-origin override (non-prod only; see devOrigin): resolvedHost() already returned
        // the override's host above — its scheme + port ride the SAME ladder here (an
        // ORIGIN-level swap, so `http://192.168.1.20:3000` local dev servers work) while the
        // base's path/query still ship unchanged. One assembly path: the override can never
        // half-apply (dev host with a prod scheme/port).
        if let dev = devOrigin, clean(dev.host)?.caseInsensitiveCompare(manifestHost) == .orderedSame {
            comps.scheme = clean(dev.scheme) ?? "https"
            comps.port = dev.port
        }
        if let u = comps.url, u.host != nil { return u }
        if let u = URL(string: "https://\(manifestHost)") { return u }
        return URL(string: "about:blank")!
    }

    // MARK: - Entry (App.json `entry` — the app's DEFAULT ENTRY)

    /// The app's default entry, declared in App.json — the single declarative source of "where the
    /// app starts". The KERNEL mounts the universal host (`RouterHost`); the `Router` seeds the first
    /// screen by resolving `root` against the route table (`ota`, filled by the Routing package) and
    /// shows `fallback` when nothing resolves. A package can never own the launch cycle — this is the
    /// kernel's config plane.
    ///
    ///     "entry": { "root": "/", "ota": "/manifest.json", "fallback": { "view": "DSXWebView" } }
    ///     // `ota` → a { assets:[…] } manifest; the route TABLE is its asset ending in routes.json
    ///     "entry": { }                                     // no table → the fallback → the web view
    ///
    /// There is no surface to name: the host is universal and navigation is kernel-owned. The first
    /// screen is whatever `root` resolves to (a route, else `fallback`); `fallback` is also the
    /// no-match / offline surface. Fail-open everywhere.
    public struct Entry {
        public let root: String
        public let ota: String?
        public let fallback: Fallback
        public let surfaces: [Surface]

        /// What to show when nothing resolves — no route matches, or there's no table yet. DATA, not
        /// hardcode: a component tag (+ optional src/origin) from App.json — `{ "view": "DSXWebView" }`
        /// (web, the default) or `{ "view": "DSXView", "src": "/dsx/offline/" }` (a native screen), or
        /// any shipped component — changeable by editing JSON. `DSXWebView` is the irreducible web floor.
        public struct Fallback { public let view: String; public let src: String; public let origin: String }

        /// ONE candidate of the ordered ROOT PLAN (`entry.surfaces` — root-plan.md). `config` rides
        /// the mount verbatim as component attributes; `timeoutMs` bounds the settle race (default
        /// `rootSettleTimeoutMs`); a derived `id` is the view name, numbered `view#k` (1-based
        /// occurrence) when the view repeats in the plan, and explicit ids ride verbatim.
        /// Normalization MUST stay byte-identical to Conformance/router/root-plan.json
        /// `expect.normalized` and scripts/root_plan_schema.rb — the corpus pins all three runtimes.
        public struct Surface {
            public let view: String
            public let id: String
            public let timeoutMs: Int
            public let config: [String: Any]
        }
    }

    /// The settle deadline a root-plan candidate gets when `timeoutMs` is omitted — identical on
    /// every runtime, pinned by the root-plan corpus (case "timeoutMs omitted pins the engine default").
    public static let rootSettleTimeoutMs = 15_000

    /// The resolved entry for this build. `surfaces` is the ordered ROOT PLAN — the ONLY root
    /// grammar (`entry.fallback` is retired and aborts at prepare, root_plan_schema.rb V8).
    /// `fallback` survives as a DERIVED alias of the plan's first candidate for the floor and
    /// no-match consumers; an empty plan derives an empty view — the kernel names no surface,
    /// and the boot diagnostic owns that state. Fail-open everywhere else (`root: "/"`).
    public static var entry: Entry {
        let raw = (manifest["entry"] as? [String: Any]) ?? [:]
        let root = clean(raw["root"] as? String) ?? "/"
        let ota = clean(raw["ota"] as? String)
        let surfaces = normalizeSurfaces((raw["surfaces"] as? [Any]) ?? [])
        let first = surfaces.first
        let fallback = Entry.Fallback(view: first?.view ?? "",
                                      src: clean(first?.config["src"] as? String) ?? "",
                                      origin: clean(first?.config["origin"] as? String) ?? "")
        return Entry(root: root, ota: ota, fallback: fallback, surfaces: surfaces)
    }

    /// `entry.surfaces` → the normalized ordered root plan. Malformed rows are a BUILD abort
    /// (scripts/root_plan_schema.rb V-rules) — runtime parsing fail-opens by skipping them.
    static func normalizeSurfaces(_ raw: [Any]) -> [Entry.Surface] {
        struct Cand { let view: String; let id: String?; let timeoutMs: Int?; let config: [String: Any] }
        var cands: [Cand] = []
        for item in raw {
            if let s = item as? String, let v = clean(s) {
                cands.append(Cand(view: v, id: nil, timeoutMs: nil, config: [:]))
            } else if let o = item as? [String: Any], let v = clean(o["view"] as? String) {
                let t = (o["timeoutMs"] as? Int).flatMap { $0 > 0 ? $0 : nil }
                cands.append(Cand(view: v, id: clean(o["id"] as? String), timeoutMs: t,
                                  config: (o["config"] as? [String: Any]) ?? [:]))
            }
        }
        var counts: [String: Int] = [:]
        for c in cands { counts[c.view, default: 0] += 1 }
        var seen: [String: Int] = [:]
        return cands.map { c in
            let k = (seen[c.view] ?? 0) + 1
            seen[c.view] = k
            let id = c.id ?? ((counts[c.view] ?? 0) > 1 ? "\(c.view)#\(k)" : c.view)
            return Entry.Surface(view: c.view, id: id,
                                 timeoutMs: c.timeoutMs ?? rootSettleTimeoutMs, config: c.config)
        }
    }

    /// Is there a web origin for this build by ANY route? Web-origin INTROSPECTION (the retired boot predicate's test, kept: the legacy-origin seam feeds it and future consumers ask the same question) —
    /// deliberately WIDER than `resolvedHost()`, which only answers "which host did the locale
    /// ladder pick for THIS device":
    ///   • `host` — `resolvedHost()`: the dev origin, the dynamic source, App.json `host`/`hosts`;
    ///   • `legacyOrigin` — the legacy build-time origin (`legacyOriginSource`, a bare host or a
    ///     full URL): the ONLY origin a pre-App.json app configures, and a live hybrid shape;
    ///   • `declaredHosts` — every App.json host, unfiltered by locale: a manifest that declares
    ///     only per-locale `hosts` still resolves nothing on a device matching none of them, yet
    ///     the app plainly HAS web origins.
    /// Blank/whitespace values, and a URL with no host (`"https://"`), are no origin at all.
    static func hasWebOrigin(host: String?, legacyOrigin: String?, declaredHosts: [String]) -> Bool {
        if clean(host) != nil { return true }
        if originHost(legacyOrigin) != nil { return true }
        return declaredHosts.contains { clean($0) != nil }
    }

    /// The host of a legacy origin value — accepts a bare host (`"myapp.com"`) or a full URL
    /// (`"https://myapp.com/app"`), mirroring `startURL`'s "a usable base is an absolute URL with
    /// a host" rule. nil for empty, whitespace, or a hostless URL.
    private static func originHost(_ raw: String?) -> String? {
        guard let s = clean(raw) else { return nil }
        guard s.contains("://") else { return s }
        return URL(string: s).flatMap { clean($0.host) }
    }



    // MARK: - Routing match semantics

    /// Lowercased, trimmed, leading "www." stripped — DNS is case-insensitive and
    /// www is an alias of the apex in practice. Nil/empty stays nil (never matches).
    private static func normalized(_ s: String?) -> String? {
        guard var h = clean(s)?.lowercased() else { return nil }
        if h.hasPrefix("www.") { h = String(h.dropFirst(4)) }
        return h.isEmpty ? nil : h
    }

    /// Same-site test for internal/external routing: equal after normalization, or
    /// `candidate` is a TRUE subdomain of `site` (dot boundary — "blog.myapp.com"
    /// is within "myapp.com"; "evilmyapp.com" is not).
    public static func isHost(_ candidate: String?, within site: String?) -> Bool {
        guard let c = normalized(candidate), let s = normalized(site) else { return false }
        return c == s || c.hasSuffix("." + s)
    }

    /// EXACT same-origin test — equal after normalization, WITHOUT the subdomain-boundary match
    /// `isHost` grants. `www.myapp.com` still equals `myapp.com` (normalization strips `www.` +
    /// lowercases — exact-ORIGIN, not exact-string), but `blog.myapp.com` does NOT. The Dom bridge
    /// gate uses this (vs `isHost`) under `bridge_subdomains: false` so a subdomain renders
    /// bridge-less while the configured host bridges. Navigation/auth/cookie identity keep `isHost`
    /// — this is a bridge-trust choice, not a same-site one.
    public static func isExactHost(_ candidate: String?, within site: String?) -> Bool {
        guard let c = normalized(candidate), let s = normalized(site) else { return false }
        return c == s
    }

    /// List membership for the routing lists (`safari_whitelist`,
    /// `safari_blacklist`, `never_open_in_app_tab`). A bare entry matches its
    /// normalized host exactly; a "*.domain" entry matches the domain and every
    /// subdomain (the explicit, opt-in wildcard).
    public static func list(_ entries: [String], contains host: String?) -> Bool {
        guard let h = normalized(host) else { return false }
        for raw in entries {
            guard let entry = clean(raw)?.lowercased() else { continue }
            if entry.hasPrefix("*.") {
                let site = String(entry.dropFirst(2))
                guard let s = normalized(site) else { continue }
                if h == s || h.hasSuffix("." + s) { return true }
            } else if normalized(entry) == h {
                return true
            }
        }
        return false
    }
}

// MARK: - Runtime environment channel (`dsx.env`)

/// WHERE this install is running — the runtime environment channel
/// (`Documentation/guides/staging-and-testing.md`). The safety INVERSE of the platform's fail-open rule
/// applies here: detection FAILS CLOSED to `.appstore` (production), so anything gated on a
/// non-production channel is OFF whenever the answer is ambiguous. Computed once,
/// synchronously (usable in `setup()` and at boot); the channel cannot change mid-process.
///
/// The channel NAMES are the cross-platform contract (Article 8): the Android twin maps the
/// same strings (emulator / debuggable / Play testing tracks / side-load / Play production);
/// per-OS detection differs freely. Markup reads the same value as the reserved word `env`
/// (JSE) and `dsx.app.env`; the web reads `global.app.env`.
public enum AppEnvironment: String {
    case simulator      // Xcode simulator
    case debug          // device, DEBUG build (an Xcode run)
    case testflight     // device, release build, sandbox receipt
    case adhoc          // device, release build, embedded provisioning profile (ad-hoc / dev-signed install)
    case appstore       // production — the default whenever nothing above matched

    #if DEBUG
    /// DEBUG-only test hook: force a channel so the prod-inertness acceptance tests can
    /// assert `.appstore` behavior on a debug build (the release checklist's prod-inertness
    /// row — guides/staging-and-testing.md). Compiled out of
    /// release entirely — it cannot exist, let alone be flipped, in a shipping binary.
    public static var simulatedChannel: AppEnvironment?
    #endif

    private static let detected: AppEnvironment = {
        #if targetEnvironment(simulator)
        return .simulator
        #elseif DEBUG
        return .debug
        #else
        // TestFlight installs run against the sandbox receipt; iOS 18 deprecates this
        // read but it still functions — a StoreKit 2 AppTransaction confirmation may
        // tighten it later (a scheduled refinement). Ambiguity falls through to .appstore.
        if Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" { return .testflight }
        if Bundle.main.path(forResource: "embedded", ofType: "mobileprovision") != nil { return .adhoc }
        return .appstore
        #endif
    }()

    /// The channel for THIS install (fail-closed: uncertain ⇒ `.appstore`).
    public static var current: AppEnvironment {
        #if DEBUG
        if let forced = simulatedChannel { return forced }
        #endif
        return detected
    }

    /// THE gate every dev-only feature checks. `true` on an App Store install — and on
    /// anything the detector couldn't classify, so dev features default to off.
    public var isProduction: Bool { self == .appstore }
    /// Convenience inverse (reads better in guards): any non-production channel.
    public var isTest: Bool { !isProduction }
}

/// `dsx.env` — the read-only accessor packages use instead of naming `AppEnvironment`
/// directly (the blessed read path, like `dsx.app` over `AppManifest`). See `Context.env`.
public struct DSXEnv {
    public init() {}
    /// `"simulator" | "debug" | "testflight" | "adhoc" | "appstore"`.
    public var channel: String { AppEnvironment.current.rawValue }
    /// `true` on an App Store install (fail-closed: ambiguous ⇒ production).
    public var isProduction: Bool { AppEnvironment.current.isProduction }
    /// `true` on any non-production channel.
    public var isTest: Bool { !isProduction }
}
