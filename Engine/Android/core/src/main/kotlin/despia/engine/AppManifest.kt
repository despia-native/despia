@file:Suppress("UNCHECKED_CAST")

//
//  AppManifest.kt — `App.json`: the app-identity manifest (kernel config plane). Kotlin twin
//  of Engine/AppManifest.swift — same names, same arguments, same behaviors.
//
//  THE one file an app author touches to identify their app: the HOST — including per-locale
//  hosts. App.json deliberately stays tiny: identity, not behavior. Hosts are bare domains —
//  no scheme, no www.
//
//      { "host": "myapp.com",
//        "hosts": { "de": "de.myapp.com", "fr-CA": "ca.myapp.fr", "JP": "jp.myapp.com" } }
//
//  RESOLUTION (first match wins; keys matched CASE-INSENSITIVELY):
//      1. the device's preferred language tag ("fr-CA")   2. its bare language ("fr")
//      3. the device REGION code ("JP")                   4. the manifest's default `host`
//      5. the legacy fallback (Dom's `host` config)
//
//  BACKWARD-COMPATIBLE BY CONSTRUCTION: no App.json, an empty one, or a malformed one → step 5,
//  preserving any explicitly configured legacy origin. The committed defaults are empty; with
//  no origin `startURL` returns about:blank. The framework App.json routes blank projects to the
//  compiled native `DSXStartup.dsx` component before Dom is mounted. ROUTING MATCH SEMANTICS (`isHost`/`isExactHost`/
//  `list`): normalized (lowercased, "www." stripped), true-subdomain dot boundary, explicit
//  "*.domain" wildcards — see the Swift header.
//
//  ── SEAMS (PLAN.md ground rule 3; Android wiring lands in :platform) ──
//  • `manifestLoader` / `engineConfigLoader` — Bundle.main's `App.json` / `EngineConfig.json`
//    reads become injectable `() -> String?` text loaders (null/malformed ⇒ `{}`, fail-open).
//    The :platform host installs asset-backed loaders; tests inject JSON text.
//  • Preferred language — reuses `DSXLocale.preferredLanguages` (the State.kt seam; Swift reads
//    `Locale.preferredLanguages.first` — ONLY the first tag runs the ladder, pinned in tests).
//  • `regionCode` — Swift `Locale.current.region?.identifier`; defaults to the JDK default
//    locale's country, settable for tests / the Android host.
//  • `AppEnvironment.detector` — the channel detector (below). iOS detection (simulator build,
//    DEBUG, sandbox receipt, embedded profile) is platform mechanics; the Android detector
//    (BuildConfig/installer) lands in :platform. FAILS CLOSED to `appstore`.
//
//  ── NOTES (pinned decisions; PLAN.md ground rule 1) ──
//  • Swift loads `manifest`/`engineConfig` ONCE (`static let`); here every read recomputes off
//    the loader — a pure function of the seams, so behavior is identical for a fixed bundle,
//    loaders stay swappable in tests, and the :platform loader may cache. No initializer-order
//    footgun (the State.kt precedent).
//  • Swift's `(hosts:, defaultHost:)` tuple → the named `HostSource` class (JVM has no tuples).
//  • `URL` → `java.net.URI` (pure JVM; `java.net.URL` resolves hosts in equals). `startURL`
//    reassembles from RAW components (rawPath/rawQuery/rawFragment) so the base's
//    percent-encoding ships byte-for-byte (the URLComponents behavior — URI's multi-arg
//    constructors would re-quote '%').
//  • Strict casts (`as? [String: String]`, `as? [String: Any]`) are element-checked (erased
//    generics; the Router.kt precedent). `clean` uses Kotlin `trim()` (all whitespace) where
//    Swift trims `.whitespaces` only — divergence is unreachable from sane manifests.
//  • Wiring left to boot (never a type initializer): `JSE.appEnvironment = { AppEnvironment
//    .current.rawValue }`, `RemoteBundleGate.bundleSigningSource = { AppManifest.bundleSigning }`.
//
//  ── OPEN ITEM (channel-name mapping — documented, NOT invented) ──
//  The channel NAMES are the cross-platform contract (Article 8): `simulator / debug /
//  testflight / adhoc / appstore`. The Swift header sketches the Android mapping as emulator /
//  debuggable / Play testing tracks / side-load / Play production, but Android exposes no
//  direct "testing track" bit at runtime: whether a Play internal/closed-track install maps to
//  `testflight` (internal-track ≈ testflight) vs how a non-Play installer splits between
//  `adhoc` and side-load is UNRESOLVED — the :platform detector (BuildConfig.DEBUG, emulator
//  fingerprints, installer package) must pin it. Only the fail-closed default is law here.
//  LANDED MEANWHILE (the declared fill, live-logs.md §3.4): a release BETA build states its
//  channel — manifest meta-data `despia.channel`, read by the hosts (DespiaApp.kt / WearApp.kt),
//  accepted ONLY for `testflight` / `adhoc`, everything else still failing closed. Runtime
//  track detection remains this open item; the fill is a build-variant declaration, not a
//  detector.
//

package despia.engine

import java.net.URI

object AppManifest {

    // MARK: - Loader seams (see SEAMS)

    /// `App.json` text from the app bundle; null when none ships (fail-open to `{}`).
    var manifestLoader: () -> String? = { null }

    /// `EngineConfig.json` text (platform config, SEPARATE from per-app App.json identity).
    var engineConfigLoader: () -> String? = { null }

    /// `routes.json` text from the app bundle — the BUNDLED route table, the native OFFLINE
    /// FLOOR of the unified table (/web/04-routing.md; Swift: `AppManifest.bundledRoutesText`
    /// reads the bundle resource beside App.json). The :app host installs an asset-backed
    /// loader (prepare_modules_android ships Config/routes.json into assets); tests inject
    /// text. null when the app ships none (fail-open — no floor, prior behavior).
    var routesLoader: () -> String? = { null }

    /// The bundled routes.json TEXT (null ⇒ none ships / empty). Raw text — the Router owns
    /// the table grammar (both manifest shapes) and parses it.
    val bundledRoutesText: String? get() = routesLoader()?.takeIf { it.isNotEmpty() }

    /// The device region code (Swift: `Locale.current.region?.identifier`).
    var regionCode: () -> String? = { java.util.Locale.getDefault().country.takeIf { it.isNotEmpty() } }

    /// The parsed manifest (empty when no App.json ships / it is malformed).
    val manifest: Map<String, Any?> get() = parsed(manifestLoader())

    /// Engine-level defaults — fail-open to `{}` so a missing/malformed file falls through to
    /// the in-engine fail-safes. This is where the default surface is set — never a literal.
    private val engineConfig: Map<String, Any?> get() = parsed(engineConfigLoader())

    private fun parsed(text: String?): Map<String, Any?> {
        val t = text ?: return emptyMap()
        return anyMap(json(t).foundationValue) ?: emptyMap()
    }

    /// Swift `as? [String: Any]` (element-checked — see NOTES).
    private fun anyMap(v: Any?): Map<String, Any?>? {
        val m = v as? Map<*, *> ?: return null
        if (!m.keys.all { it is String }) return null
        return m as Map<String, Any?>
    }

    /// Swift `as? [String: String]` — whole-cast semantics.
    private fun stringMap(v: Any?): Map<String, String> {
        val m = v as? Map<*, *> ?: return emptyMap()
        if (!m.keys.all { it is String } || !m.values.all { it is String }) return emptyMap()
        return m as Map<String, String>
    }

    /// The app's display NAME declared in App.json (`name`) — identity, exactly like `host`.
    /// null when App.json names none (the caller falls back to the build-time app label).
    val appName: String? get() = clean(manifest["name"] as? String)

    /// Per-locale hosts, keyed lowercase once so lookups are case-insensitive
    /// ("JP", "jp" and "Jp" in a client's file all resolve).
    private val localeHosts: Map<String, String>
        get() {
            val raw = stringMap(manifest["hosts"])
            val out = HashMap<String, String>()
            for ((k, v) in raw) out[k.lowercase()] = v
            return out
        }

    /// EVERY host the bundled App.json declares — the default `host` plus all per-locale
    /// `hosts` values, unfiltered by locale: a declared host is app identity on ANY device.
    /// Bundled App.json data only (Article 5); the live-resolved host is `resolvedHost()`,
    /// consulted separately.
    val declaredHosts: List<String>
        get() {
            val out = ArrayList(localeHosts.values)
            clean(manifest["host"] as? String)?.let { out.add(it) }
            return out
        }

    private fun clean(s: String?): String? {
        val t = s?.trim() ?: return null
        return t.ifEmpty { null }
    }

    // MARK: - Dynamic host override (kernel SEAM — a package fills it)

    /// Swift's `(hosts: [String: String], defaultHost: String?)` tuple (see NOTES).
    class HostSource(val hosts: Map<String, String>, val defaultHost: String?)

    /// A package may supply a FRESHER host source at runtime — a remotely fetched, locally
    /// cached `{ host, hosts }` map — so a client can migrate domains WITHOUT a store rebuild.
    /// `resolvedHost()` applies the SAME locale ladder to this source FIRST; any miss falls
    /// through to the bundled App.json. EMPTY SEAM by default — nil/absent means bundled-only.
    var dynamicHostSource: (() -> HostSource?)? = null

    /// DEV-ONLY full-ORIGIN override (scheme+host+port) — the staging-environment seam. Null by
    /// default; only the (optional, excludable) DevSettings package fills it, and the kernel
    /// consults it ONLY off production — `devOrigin` double-gates on `AppEnvironment`, so even a
    /// filled seam is inert on a store install. Sits ABOVE `dynamicHostSource` (a tester's
    /// explicit choice beats the live migration manifest).
    var devOriginSource: (() -> URI?)? = null

    /// The gated read of the dev-origin seam: null on production, whatever the seam says
    /// otherwise. Every consult point goes through THIS, never the seam directly.
    private val devOrigin: URI?
        get() {
            if (AppEnvironment.current.isProduction) return null
            return devOriginSource?.invoke()
        }

    /// The LEGACY build-time web origin — the pre-App.json value that still configures most
    /// shipping apps (the web-surface package's `webview_url` base / bare `host` config). It is
    /// the LAST rung of the host ladder and it is the caller's to supply: `host(fallback)` and
    /// `startURL(legacyURL, fallbackHost)` take it as a PARAMETER precisely so the kernel never
    /// names, reads, or depends on a module's config (Article 5 / binding rule 1).
    ///
    /// `bootsToEntryFallback` has no caller to take it from — it runs inside the kernel's own
    /// boot decision — so the value arrives through this SEAM instead, exactly like
    /// `dynamicHostSource` / `devOriginSource`: null by default (no kernel hardcoding, no module
    /// named), filled by whichever package owns the legacy origin. Accepts either a bare host
    /// (`"myapp.com"`) or a full URL (`"https://myapp.com/app"`) — only the ORIGIN is read.
    ///
    /// FAIL-OPEN, and deliberately so: an unfilled seam only makes the boot predicate treat the
    /// build as origin-less, and the predicate's native arm ALSO requires an explicitly authored
    /// `entry.fallback.view`, so an unfilled seam can never by itself take a web app off its
    /// route table. (Swift parity: `AppManifest.legacyOriginSource`.)
    var legacyOriginSource: (() -> String?)? = null

    /// Optional URL (App.json `refresh_url`) that serves the SAME `{ host, hosts }` shape as
    /// App.json itself, for runtime refresh. The kernel only SURFACES it; the optional
    /// RemoteHosts package fetches, caches, and fills the seam above. Empty/absent ⇒ static.
    val refreshURL: String? get() = clean(manifest["refresh_url"] as? String)

    /// The app-authored REMOTE-BUNDLE trust anchor — App.json `bundle_signing` (the PUBLIC
    /// key[s] the app verifies remote manifests against; see `RemoteBundleGate`). The kernel
    /// only SURFACES the raw block; the engine's load gate parses + enforces it. ABSENT ⇒ null
    /// ⇒ signing OFF (fail-open, today's behavior).
    val bundleSigning: Map<String, Any?>? get() = anyMap(manifest["bundle_signing"])

    /// The CONTENT ROOT — where app-authored content folders live on the app's host (App.json
    /// `hosting.content_root`). Defaults to `/dsx`; an explicit "" or "/" means the host root.
    /// Normalized to a leading-slash, no-trailing-slash form.
    val contentRoot: String
        get() {
            val raw = (anyMap(manifest["hosting"])?.get("content_root") as? String) ?: "/dsx"
            var p = raw.trim()
            if (p.isEmpty() || p == "/") return ""
            if (!p.startsWith("/")) p = "/$p"
            while (p.endsWith("/")) p = p.dropLast(1)
            return p
        }

    /// The content store's size budget in MB — `EngineConfig.json` `content.budget_mb` (engine
    /// plane, per-app overridable by editing the JSON). 0 disables eviction.
    val contentBudgetMB: Int
        get() = (anyMap(engineConfig["content"])?.get("budget_mb") as? Number)?.toInt() ?: 300

    /// Maximum single native content-blob download in MiB. Both the advertised length and the
    /// actual streamed bytes are enforced by platform transports. Clamp hostile/mistyped config
    /// to 1...2048 MiB; the shared EngineConfig default is 240 MiB.
    val contentMaxBlobMB: Int
        get() {
            val raw = (anyMap(engineConfig["content"])?.get("max_blob_mb") as? Number)
                ?.toLong() ?: 240L
            return raw.coerceIn(1L, 2_048L).toInt()
        }

    /// Run the locale ladder (steps 1–4) against ONE host source. Swift reads ONLY the first
    /// preferred language (see SEAMS).
    private fun resolve(hosts: Map<String, String>, defaultHost: String?): String? {
        val tag = DSXLocale.preferredLanguages().firstOrNull()?.lowercase()    // "fr-ca"
        if (tag != null) {
            clean(hosts[tag])?.let { return it }
            val lang = tag.takeWhile { it != '-' && it != '_' }                // "fr"
            clean(hosts[lang])?.let { return it }
        }
        regionCode()?.lowercase()?.let { r -> clean(hosts[r])?.let { return it } }  // "jp"
        return clean(defaultHost)
    }

    /// The host-resolved host for THIS device, or null when nothing provides one — the caller's
    /// legacy value then stands. Dev-origin override first (non-prod only), then a
    /// package-supplied dynamic source, then the bundled App.json.
    fun resolvedHost(): String? {
        devOrigin?.let { dev -> clean(dev.host)?.let { return it } }
        dynamicHostSource?.invoke()?.let { source ->
            val keyed = HashMap<String, String>()
            for ((k, v) in source.hosts) keyed[k.lowercase()] = v
            resolve(keyed, source.defaultHost)?.let { return it }
        }
        return resolve(localeHosts, manifest["host"] as? String)
    }

    /// The app's host for THIS device. `fallback` is the legacy build-time value — callers pass
    /// Dom's `host` config.
    fun host(fallback: String): String = resolvedHost() ?: fallback

    /// The resolved ORIGIN for consumers that BUILD absolute URLs. Normally identical to
    /// `resolvedHost()` — a bare host the caller prefixes with `https://`. When the dev-origin
    /// override is active (non-production only), the override's scheme + port ride along
    /// (`http://192.168.1.20:3000`) so every URL-building consumer follows the SAME origin the
    /// web view loads.
    fun resolvedOriginString(): String? {
        val dev = devOrigin
        if (dev != null) {
            val h = clean(dev.host)
            if (h != null) {
                var origin = "${clean(dev.scheme) ?: "https"}://$h"
                if (dev.port != -1) origin += ":${dev.port}"
                return origin
            }
        }
        return resolvedHost()
    }

    /// THE launch URL — the single authority for what the web view loads.
    ///
    /// `legacyURL` (Dom's `webview_url`) is the base: its path/query/fragment ship unchanged.
    /// When App.json resolves a host for this device, that host replaces the base's. No
    /// App.json preserves an explicitly configured legacy URL. An empty or unparsable base
    /// falls back to `https://<resolved-or-fallback host>`, then `about:blank` when no origin
    /// exists. The framework starter manifest selects native DSX before Dom is mounted.
    /// Nothing here can crash.
    fun startURL(legacyURL: String, fallbackHost: String): URI {
        // A usable base must be an absolute URL with a host ("myapp.com" alone parses as a
        // pathless relative URL — not a base).
        val base = clean(legacyURL)
            ?.let { runCatching { URI(it) }.getOrNull() }
            ?.takeIf { it.host != null }

        val manifestHost = resolvedHost() ?: run {
            base?.let { return it }                                            // legacy, byte-for-byte
            clean(fallbackHost)?.let { h ->
                runCatching { URI("https://$h") }.getOrNull()?.let { return it }
            }
            return URI("about:blank")                                          // constant, always parses
        }

        var scheme = clean(base?.scheme) ?: "https"
        var port = base?.port ?: -1
        // Dev-origin override (non-prod only): resolvedHost() already returned the override's
        // host above — its scheme + port ride the SAME ladder here (an ORIGIN-level swap) while
        // the base's path/query still ship unchanged. One assembly path: the override can never
        // half-apply (dev host with a prod scheme/port).
        val dev = devOrigin
        if (dev != null && clean(dev.host)?.equals(manifestHost, ignoreCase = true) == true) {
            scheme = clean(dev.scheme) ?: "https"
            port = dev.port
        }
        // Reassemble from RAW components so the base's percent-encoding ships byte-for-byte
        // (see NOTES — URI's multi-arg constructors would re-quote '%').
        val sb = StringBuilder(scheme).append("://")
        base?.rawUserInfo?.let { sb.append(it).append('@') }
        sb.append(manifestHost)
        if (port != -1) sb.append(':').append(port)
        sb.append(base?.rawPath ?: "")
        base?.rawQuery?.let { sb.append('?').append(it) }
        base?.rawFragment?.let { sb.append('#').append(it) }
        runCatching { URI(sb.toString()) }.getOrNull()?.takeIf { it.host != null }?.let { return it }
        runCatching { URI("https://$manifestHost") }.getOrNull()?.let { return it }
        return URI("about:blank")
    }

    // MARK: - Entry (App.json `entry` — the app's DEFAULT ENTRY)

    /// The app's default entry, declared in App.json — the single declarative source of "where
    /// the app starts". The Router seeds the first screen by resolving `root` against the route
    /// table and shows `fallback` when nothing resolves. Fail-open everywhere.
    ///
    ///     "entry": { "root": "/", "ota": "/manifest.json", "fallback": { "view": "DSXWebView" } }
    class Entry(val root: String, val ota: String?, val fallback: Fallback, val surfaces: List<Surface>) {
        /// What to show when nothing resolves — DATA, not hardcode: a component tag (+ optional
        /// src/origin) from App.json. `DSXWebView` is the irreducible web floor.
        class Fallback(val view: String, val src: String, val origin: String)

        /// ONE candidate of the ordered ROOT PLAN (`entry.surfaces` — root-plan.md). `config`
        /// rides the mount verbatim as component attributes; `timeoutMs` bounds the settle race
        /// (default [rootSettleTimeoutMs]); a derived `id` is the view name, numbered `view#k`
        /// (1-based occurrence) when the view repeats, explicit ids ride verbatim. Normalization
        /// MUST stay byte-identical to Conformance/router/root-plan.json `expect.normalized`
        /// and scripts/root_plan_schema.rb — the corpus pins all three runtimes.
        class Surface(val view: String, val id: String, val timeoutMs: Int, val config: Map<String, Any?>)
    }

    /// The settle deadline a root-plan candidate gets when `timeoutMs` is omitted — identical
    /// on every runtime, pinned by the root-plan corpus.
    const val rootSettleTimeoutMs = 15_000

    /// The resolved entry for this build. `surfaces` is the ordered ROOT PLAN — the ONLY root
    /// grammar (`entry.fallback` is retired and aborts at prepare, root_plan_schema.rb V8).
    /// `fallback` survives as a DERIVED alias of the plan's first candidate for the floor and
    /// no-match consumers; an empty plan derives an empty view — the kernel names no surface,
    /// and the boot diagnostic owns that state. Fail-open everywhere else (`root: "/"`).
    val entry: Entry
        get() {
            val raw = anyMap(manifest["entry"]) ?: emptyMap()
            val root = clean(raw["root"] as? String) ?: "/"
            val ota = clean(raw["ota"] as? String)
            val surfaces = normalizeSurfaces(raw["surfaces"] as? List<*> ?: emptyList<Any>())
            val first = surfaces.firstOrNull()
            val fallback = Entry.Fallback(
                view = first?.view ?: "",
                src = clean(first?.config?.get("src") as? String) ?: "",
                origin = clean(first?.config?.get("origin") as? String) ?: "")
            return Entry(root, ota, fallback, surfaces)
        }

    /// `entry.surfaces` → the normalized ordered root plan. Malformed rows are a BUILD abort
    /// (scripts/root_plan_schema.rb V-rules) — runtime parsing fail-opens by skipping them.
    internal fun normalizeSurfaces(raw: List<*>): List<Entry.Surface> {
        data class Cand(val view: String, val id: String?, val timeoutMs: Int?, val config: Map<String, Any?>)
        val cands = raw.mapNotNull { item ->
            when (item) {
                is String -> clean(item)?.let { Cand(it, null, null, emptyMap()) }
                is Map<*, *> -> clean(item["view"] as? String)?.let { v ->
                    // INTEGERS only (twin parity: TS Number.isInteger, Swift as? Int, Ruby aborts) —
                    // a fractional timeout is skipped to the default, never truncated.
                    val t = when (val n = item["timeoutMs"]) {
                        is Int -> n
                        // NEVER truncate: `toInt()` turned 4294968296 into 1000, silently giving
                        // this renderer a one-second deadline where the others honored the
                        // authored value. Out of Int range → treated as absent (the default),
                        // and the build gates it anyway (root_plan_schema.rb caps at Int32).
                        is Long -> if (n in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) n.toInt() else null
                        else -> null
                    }?.takeIf { it > 0 }
                    val cfg = anyMap(item["config"]) ?: emptyMap()
                    Cand(v, clean(item["id"] as? String), t, cfg)
                }
                else -> null
            }
        }
        val counts = cands.groupingBy { it.view }.eachCount()
        val seen = mutableMapOf<String, Int>()
        return cands.map { c ->
            val k = (seen[c.view] ?: 0) + 1
            seen[c.view] = k
            val id = c.id ?: if ((counts[c.view] ?: 0) > 1) "${c.view}#$k" else c.view
            Entry.Surface(c.view, id, c.timeoutMs ?: rootSettleTimeoutMs, c.config)
        }
    }

    /// The empty-stack / malformed-frame / pre-boot floor used by a native host before the
    /// Router has published a valid frame: the ROOT PLAN's first candidate, rendered through
    /// the normal Stack tag dispatch. The kernel names no surface here — an app with no plan
    /// derives an empty tag (renders nothing) and the boot diagnostic owns that state.
    /// Router.boot remains the authority as soon as it publishes nav.stack.
    fun entryFloorNode(): StackNode {
        val resolved = entry
        return StackNode(
            tag = resolved.fallback.view,
            attrs = linkedMapOf(
                "src" to resolved.fallback.src,
                "path" to resolved.root,
                "origin" to resolved.fallback.origin,
            ),
            children = emptyList(),
        )
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
    internal fun hasWebOrigin(host: String?, legacyOrigin: String?, declaredHosts: List<String>): Boolean {
        if (clean(host) != null) return true
        if (originHost(legacyOrigin) != null) return true
        return declaredHosts.any { clean(it) != null }
    }

    /// The host of a legacy origin value — accepts a bare host (`"myapp.com"`) or a full URL
    /// (`"https://myapp.com/app"`), mirroring `startURL`'s "a usable base is an absolute URL with
    /// a host" rule. Null for empty, whitespace, or a hostless URL.
    private fun originHost(raw: String?): String? {
        val s = clean(raw) ?: return null
        if (!s.contains("://")) return s
        return clean(runCatching { URI(s) }.getOrNull()?.host)
    }

    // MARK: - Routing match semantics

    /// Lowercased, trimmed, leading "www." stripped — DNS is case-insensitive and www is an
    /// alias of the apex in practice. Null/empty stays null (never matches).
    private fun normalized(s: String?): String? {
        var h = clean(s)?.lowercase() ?: return null
        if (h.startsWith("www.")) h = h.substring(4)
        return h.ifEmpty { null }
    }

    /// Same-site test for internal/external routing: equal after normalization, or `candidate`
    /// is a TRUE subdomain of `within` (dot boundary — "blog.myapp.com" is within "myapp.com";
    /// "evilmyapp.com" is not).
    fun isHost(candidate: String?, within: String?): Boolean {
        val c = normalized(candidate) ?: return false
        val s = normalized(within) ?: return false
        return c == s || c.endsWith(".$s")
    }

    /// EXACT same-origin test — equal after normalization, WITHOUT the subdomain-boundary match
    /// `isHost` grants. `www.myapp.com` still equals `myapp.com`; `blog.myapp.com` does NOT.
    /// A bridge-trust choice (`bridge_subdomains: false`), not a same-site one.
    fun isExactHost(candidate: String?, within: String?): Boolean {
        val c = normalized(candidate) ?: return false
        val s = normalized(within) ?: return false
        return c == s
    }

    /// List membership for the routing lists (`safari_whitelist`, `safari_blacklist`,
    /// `never_open_in_app_tab`). A bare entry matches its normalized host exactly; a "*.domain"
    /// entry matches the domain and every subdomain (the explicit, opt-in wildcard).
    fun list(entries: List<String>, contains: String?): Boolean {
        val h = normalized(contains) ?: return false
        for (raw in entries) {
            val entry = clean(raw)?.lowercase() ?: continue
            if (entry.startsWith("*.")) {
                val s = normalized(entry.substring(2)) ?: continue
                if (h == s || h.endsWith(".$s")) return true
            } else if (normalized(entry) == h) {
                return true
            }
        }
        return false
    }
}

// MARK: - Runtime environment channel (`dsx.env`)

/// WHERE this install is running — the runtime environment channel. The safety INVERSE of the
/// platform's fail-open rule applies here: detection FAILS CLOSED to `appstore` (production),
/// so anything gated on a non-production channel is OFF whenever the answer is ambiguous.
///
/// The channel NAMES are the cross-platform contract (Article 8) — see the file-header OPEN
/// ITEM for the unresolved Android track mapping. Markup reads the same value as the reserved
/// word `env` (JSE) and `dsx.app.env`; the web reads `global.app.env`.
enum class AppEnvironment(val rawValue: String) {
    simulator("simulator"),     // emulator (iOS: Xcode simulator)
    debug("debug"),             // device, DEBUG/debuggable build
    testflight("testflight"),   // test-distribution install (iOS: sandbox receipt; Android: OPEN ITEM)
    adhoc("adhoc"),             // dev-signed / side-load install
    appstore("appstore");       // production — the default whenever nothing above matched

    companion object {
        /// Test hook: force a channel so prod-inertness acceptance tests can assert `appstore`
        /// behavior on a debug build. Swift compiles this out of release (`#if DEBUG`); the JVM
        /// twin honors it ONLY under `KernelLog.enabled` (the port's DEBUG seam) — off (the
        /// shipping default) it cannot be flipped, mirroring "cannot exist in a shipping binary".
        var simulatedChannel: AppEnvironment? = null

        /// The detector SEAM (see the file header): iOS detection is compile-time + receipt
        /// mechanics; the Android detector (BuildConfig/installer) lands in :platform and must
        /// be constant for the process. The DEFAULT — and any detector failure — is the
        /// fail-closed `appstore`.
        var detector: () -> AppEnvironment = { appstore }

        /// The channel for THIS install (fail-closed: uncertain ⇒ `appstore`).
        val current: AppEnvironment
            get() {
                if (KernelLog.enabled) simulatedChannel?.let { return it }
                return runCatching { detector() }.getOrDefault(appstore)
            }
    }

    /// THE gate every dev-only feature checks. `true` on a store install — and on anything the
    /// detector couldn't classify, so dev features default to off.
    val isProduction: Boolean get() = this == appstore

    /// Convenience inverse (reads better in guards): any non-production channel.
    val isTest: Boolean get() = !isProduction
}

/// `dsx.env` — the read-only accessor packages use instead of naming `AppEnvironment` directly
/// (the blessed read path, like `dsx.app` over `AppManifest`). Exposed on the package context
/// when Context.kt lands (`Context.env`).
class DSXEnv {
    /// `"simulator" | "debug" | "testflight" | "adhoc" | "appstore"`.
    val channel: String get() = AppEnvironment.current.rawValue

    /// `true` on a store install (fail-closed: ambiguous ⇒ production).
    val isProduction: Boolean get() = AppEnvironment.current.isProduction

    /// `true` on any non-production channel.
    val isTest: Boolean get() = !isProduction
}
