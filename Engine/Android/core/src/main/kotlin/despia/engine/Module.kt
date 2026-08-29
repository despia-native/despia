//
//  Module.kt
//  DespiaScript
//
//  The Module base class and the registry that discovers and routes to packages.
//  Kotlin twin of Engine/Module.swift — same names, same arguments, same behaviors.
//
//  (The `DSX` namespace root — Swift's `public enum DSX {}` declared in Module.swift —
//  lives in State.kt on this side: Kotlin objects can't be reopened per file, so the
//  object is declared once, with its first member.)
//
//  ── DISCOVERY: the GENERATED-REGISTRY seam (replaces the ObjC class walk) ──
//  Swift's `scanClasses()` walks the ObjC runtime's class list; the JVM has no cheap
//  equivalent (classpath scanning is slow and ProGuard-hostile), so discovery is a
//  registry the Android codegen FILLS at boot — default empty:
//
//      ModuleRegistry.shared.register(schemes = mapOf(
//          "battery" to { Battery() },
//          "store"   to { DSXStore() },
//      ), bootEligible = setOf("store"))          // the manifests' `bootEligible` flags
//      ModuleRegistry.shared.boot()               // phase 1: the boot tier only
//      ModuleRegistry.shared.bootstrap()          // phase 2: everything else
//
//  The map key is the manifest scheme (discovery/logging key); the module's ROUTED
//  schemes still come from its own `resolvedScheme` + aliases, exactly like Swift.
//  Codegen also fills `GeneratedModuleSchemes` (the dsx.json scheme→class binding
//  behind `resolvedScheme`) — the same data prepare_modules.rb generates on iOS.
//
//  ── NOTES (pinned decisions; PLAN.md ground rule 1) ──
//  • `scheme` / `bootEligible` / `registersWithoutScheme` are Swift `class var`s read
//    BEFORE init; Kotlin has no overridable statics, so they are open instance vals.
//    Override them WITH A GETTER (`override val scheme get() = "store"`) — `scheme` is
//    read during the base-class constructor, before a subclass backing field exists.
//  • Because `bootEligible` needs an instance, the generated-registry seam carries the
//    manifest's boot flags as the `bootEligible` scheme set instead (codegen knows them).
//  • The no-scheme guard runs AFTER instantiation on the factory path (Swift checks the
//    class var before init) — a schemeless module's `setup()` runs, then it is dropped.
//  • `scanClasses` also registered Stack components (GlobalStackComponent /
//    PrivilegedStackComponent) — Compose territory, rides the `:render` port.
//  • `mainExecutor` is the main-thread funnel seam for the cross-package dispatch path
//    (Context._dispatch / _call — Swift's DispatchQueue.main.sync / .async). Default
//    DIRECT (inline = Swift's already-on-main path). The Android host installs a
//    Looper-backed executor that MUST stay synchronous when already on main and hop
//    SYNCHRONOUSLY for `_dispatch` (its `handled` result is read on return).
//  • `_resetForTests` is a test-only internal (the registry is a process singleton);
//    it is not part of the 1:1 surface.
//

package despia.engine

import java.net.URI
import java.util.concurrent.Executor

/// The dsx.json scheme→class binding behind `Module.resolvedScheme` — on iOS a codegen'd
/// static enum (prepare_modules.rb); here a registry the generated Android boot code
/// FILLS. Default empty ⇒ only in-code `scheme` overrides resolve (exclusion-safe).
object GeneratedModuleSchemes {
    var byClassName: Map<String, String> = emptyMap()
    var aliasesByClassName: Map<String, List<String>> = emptyMap()
}

open class Module {

    /// URI scheme this package claims (e.g. `"purchase"`). Prefer declaring it
    /// once in `dsx.json` (`"scheme": "purchase"`), bound to this class by
    /// codegen (`GeneratedModuleSchemes`). Override only to set it in code; an
    /// override wins over the manifest. Empty + no manifest binding => "abstract,
    /// skip me". OVERRIDE WITH A GETTER — read during the base constructor.
    open val scheme: String get() = ""

    /// Effective scheme used by the registry: the `scheme` override if present,
    /// else the manifest-declared scheme. This is what makes the override optional.
    val resolvedScheme: String
        get() {
            val declared = scheme
            if (declared.isNotEmpty()) return declared
            return GeneratedModuleSchemes.byClassName[javaClass.simpleName] ?: ""
        }

    /// Extra schemes routed to this package, from `dsx.json` `aliases`
    /// (legacy or data-in-host schemes - e.g. `readhealthkit`, `writehealthkit`).
    /// Handle them in the pre-filter (`dsx.action { }`) by inspecting `dsx.command()`.
    internal val resolvedAliases: List<String>
        get() = GeneratedModuleSchemes.aliasesByClassName[javaClass.simpleName] ?: emptyList()

    /// This package's registration store (action map, hydrations, schemes).
    internal val registration: Registration

    /// The package handle: register actions/hydrations in `setup()`, and fire
    /// out-of-band `broadcast` from anywhere (delegate callbacks, lifecycle
    /// hooks). Each per-call handler receives its own `dsx`.
    val dsx: Context get() = Context(registration)

    init {
        registration = Registration(primaryScheme = resolvedScheme, aliases = resolvedAliases)
        // setup() is deliberately NOT called here: a Kotlin base-class init block runs
        // BEFORE the subclass's field initializers, so a module binding a stored relay
        // in setup() (Dom's DomWebClient/DomWebChrome) NPE'd at boot. The registry calls
        // setup() right after construction instead — the Swift twin's observable order
        // (Swift two-phase init runs stored-property initializers before super.init, so
        // iOS setup() always sees initialized fields; Kotlin now matches).
    }

    /// Override to register actions and hydrations. Called once by the registry right
    /// after construction (before the first navigation) — subclass fields ARE
    /// initialized, same as the Swift twin. Don't emit from here - the
    /// web view isn't bound yet; emit inside `action` / `hydrate` closures.
    open fun setup() {}

    /// BOOT TIER opt-in. `true` → this package is instantiated in `ModuleRegistry.boot()`
    /// — synchronously at the TOP of launch, BEFORE the first frame — so it can claim
    /// boot-time events (`boot.splash`). The contract that makes this safe: a
    /// boot-eligible package's `setup()` must be **instant** — hook/action registration
    /// only; no SDK init, no I/O, no network. (On the generated-registry path the
    /// manifest flag rides `register(schemes:bootEligible:)` — see the header.)
    open val bootEligible: Boolean get() = false

    /// SCHEME-LESS opt-in. `true` → register this package even though it owns no URL scheme,
    /// so a WATCH-ONLY package (no URL-scheme surface — it only `dsx.delegate.listen`s for
    /// lifecycle events, or fills a kernel seam) still gets its `setup()` run and joins the
    /// delegate fan-out. Without
    /// this the registry skips schemeless classes (the default — a missing scheme is usually a
    /// misconfiguration). It owns no route map entry (its `schemes` set is empty by construction).
    open val registersWithoutScheme: Boolean get() = false
}

class ModuleRegistry private constructor() {

    companion object {
        val shared = ModuleRegistry()
    }

    private val lock = Any()
    /// Scheme -> package. One package can appear under several schemes (primary
    /// + aliases + legacy action schemes), so this is a route table.
    private val routes = HashMap<String, Module>()
    /// Unique package instances, for lifecycle/hydration fan-out (a package
    /// claiming N schemes must still be visited once).
    private val allPackages = ArrayList<Module>()
    private var didBootstrap = false

    /// The main-thread funnel seam for the cross-package dispatch path (see header
    /// NOTES). DIRECT by default; the Android host installs a Looper-backed executor
    /// that runs inline when already on main and posts SYNCHRONOUSLY otherwise.
    @Volatile
    var mainExecutor: Executor = Executor { it.run() }

    // MARK: - Registration

    /// Manually register a package. Rarely needed - the generated registry +
    /// `bootstrap()` cover every shipped module. Useful for tests or for
    /// late-binding packages constructed with non-default arguments.
    fun register(packageType: () -> Module) {
        val plugin = packageType()
        if (plugin.registration.schemes.isEmpty() && !plugin.registersWithoutScheme) {
            kernelLog("[ModuleRegistry] Ignoring ${plugin.javaClass.simpleName} - no scheme (manifest or override)")
            return
        }
        // `dsx` is RESERVED (the error-system's global mirror channel, error-system.md §3.3b) —
        // a module claiming it would shadow every app's global error listener. Refused, loudly.
        if (plugin.registration.schemes.any { it.equals("dsx", ignoreCase = true) }) {
            kernelLog("[ModuleRegistry] Refusing ${plugin.javaClass.simpleName} — scheme \"dsx\" is reserved (the error-system mirror)")
            return
        }
        plugin.setup()   // post-construction: subclass fields are live (see Module.init note)
        synchronized(lock) {
            allPackages.add(plugin)
            for (rawScheme in plugin.registration.schemes) {
                val scheme = rawScheme.lowercase()   // URL schemes are case-insensitive (RFC 3986) — key lowercase
                routes[scheme]?.let { existing ->
                    kernelLog("[ModuleRegistry] Replacing ${existing.javaClass.simpleName} with ${plugin.javaClass.simpleName} for scheme '$scheme'")
                }
                routes[scheme] = plugin
            }
            aliasReverseCache = null   // the alias fan-out view follows the route table
        }
    }

    /// THE GENERATED-REGISTRY SEAM (see header): the Android codegen fills the module
    /// map at boot — scheme -> factory, plus the manifests' boot-tier flags. Default
    /// empty (nothing registers on a bare kernel). Entries land in the discovery stash
    /// consumed by `boot()` / `bootstrap()`; a call arriving after `bootstrap()` has
    /// already run registers immediately (late-loaded feature packs).
    fun register(schemes: Map<String, () -> Module>, bootEligible: Set<String> = emptySet()) {
        val lateEntries = ArrayList<() -> Module>()
        synchronized(lock) {
            for ((scheme, factory) in schemes) {
                when {
                    didBootstrap -> lateEntries.add(factory)
                    didBoot && scheme !in bootEligible -> deferredPackageFactories.add(factory)
                    didBoot -> lateEntries.add(factory)              // boot tier arriving post-boot: register now
                    else -> {
                        discovered.add(scheme to factory)
                        if (scheme in bootEligible) bootSchemes.add(scheme)
                    }
                }
            }
        }
        for (factory in lateEntries) register(factory)
    }

    /// Currently-registered scheme names (snapshot, sorted).
    val registeredSchemes: List<String>
        get() = synchronized(lock) { routes.keys.sorted() }

    // MARK: - Chain identity (the chains corpus law — ChainResolver.kt)

    /// The EXCLUDED-IDENTITIES overlay: chains that exist in the app's module catalog but were
    /// excluded from THIS build, in the full DespiaExcluded shape — chain →
    /// `{ reason: "excluded" | "cascade" [, from: parentChain] }` — the 1:1 twin of iOS
    /// `GeneratedModuleSchemes.excludedIdentities` and the page's `despia.excluded` entries.
    /// The Android build generator assigns exactly this map in `GeneratedModules.register()`;
    /// default empty = today's behavior. Keys are stored lowercased (chains are routing keys,
    /// like the route table's). The fold consults registered chains ∪ these keys, so a call
    /// into an excluded child resolves to the child's identity (correct attribution —
    /// `not_loaded` against `off.grid`) instead of becoming a phantom action on its parent;
    /// the entry VALUE answers the `excluded` reserved member (the honest build fact).
    @Volatile
    var knownExcludedIdentities: Map<String, Map<String, String>> = emptyMap()
        set(value) { field = value.mapKeys { it.key.lowercase() } }

    /// The identity-SET view over the overlay (what the fold and `resolveChain` consult) —
    /// COMPUTED from the map's keys; `knownExcludedIdentities` is the one source of truth.
    val knownExcludedChains: Set<String>
        get() = knownExcludedIdentities.keys

    /// The overlay entry for `chain`, or null when shipped / never existed — the Swift twin
    /// of `ModuleRegistry.excludedEntry(for:)`. Case-insensitive (keys stored lowercase).
    /// LEGACY ALIAS spellings answer the same honest fact: an excluded module is
    /// unregistered, so the live alias view can never normalize its spellings — the
    /// overlay entries carry them instead ("aliases", comma-joined, straight from the
    /// manifest) and the page's matchesEntry answers them 1:1, so this member must too.
    fun excludedEntry(chain: String): Map<String, String>? {
        val key = chain.lowercase()
        knownExcludedIdentities[key]?.let { return it }
        return knownExcludedIdentities.values.firstOrNull { entry ->
            entry["aliases"]?.lowercase()?.split(',')?.any { it.trim() == key } == true
        }
    }

    /// chain → its legacy alias spellings (the reverse of the live alias view, sorted for
    /// determinism) — the emission fan-out reads this so an alias handle hears a module's
    /// events no matter when it subscribed. Cached; `register` invalidates.
    @Volatile
    private var aliasReverseCache: Map<String, List<String>>? = null

    internal fun aliasesForChain(chain: String): List<String> {
        val cache = aliasReverseCache ?: run {
            val reverse = HashMap<String, MutableList<String>>()
            synchronized(lock) {
                for ((spelling, plugin) in routes) {
                    val primary = plugin.registration.primaryScheme.lowercase()
                    if (primary.isNotEmpty() && primary != spelling) {
                        reverse.getOrPut(primary) { mutableListOf() }.add(spelling)
                    }
                }
            }
            val built: Map<String, List<String>> = reverse.mapValues { it.value.sorted() }
            aliasReverseCache = built
            built
        }
        return cache[chain.lowercase()] ?: emptyList()
    }

    /// The alias spellings of a module-scoped event name: the LONGEST dot-boundary prefix
    /// that is a chain with aliases rewrites to each alias + the verbatim remainder.
    /// Empty for non-module names (no chain prefix, or none aliased).
    internal fun aliasSpellingsOf(event: String): List<String> {
        var idx = event.length
        while (idx > 0) {
            val dot = event.lastIndexOf('.', idx - 1)
            if (dot < 0) return emptyList()
            val aliases = aliasesForChain(event.substring(0, dot))
            if (aliases.isNotEmpty()) {
                val rest = event.substring(dot)
                return aliases.map { it + rest }
            }
            idx = dot
        }
        return emptyList()
    }

    /// The live identity view the fold runs against: the route table (every registered scheme
    /// IS a chain — depth-1 or dotted) ∪ the excluded overlay. Alias normalization reads the
    /// owner's `primaryScheme` off the route entry — the registry has no separate alias map;
    /// a routed spelling whose primary differs IS an alias spelling. Keys lowercase throughout.
    private val chainIdentity = object : ChainResolver.Identity {
        override fun primaryFor(head: String): String? {
            val primary = synchronized(lock) { routes[head]?.registration?.primaryScheme }
                ?.lowercase() ?: return null
            return if (primary.isNotEmpty() && primary != head) primary else null
        }
        override fun contains(chain: String): Boolean =
            synchronized(lock) { routes.containsKey(chain) } || chain in knownExcludedChains
        override fun isExcluded(chain: String): Boolean = chain in knownExcludedChains
    }

    /// One resolved dispatch target — `resolveChain`'s answer, sized for the funnel:
    /// `chain` is the primary identity (route key), `spelled` the ARRIVING spelling of that
    /// chain (what the module sees as `ctx.scheme` — differs only for alias heads), `rest`
    /// the action-path remainder VERBATIM (separators and case preserved, so dotted group
    /// keys keep their grammar), `folded` how many segments moved into the chain (0 ⇒ the
    /// caller's pre-fold behavior applies bit for bit), `member` the RESERVED word leading
    /// the remainder, when there is one. The member CONSEQUENCE is face-split (frozen
    /// contract): the MODERN faces (typed proxies, Context._call/_dispatch) refuse it with
    /// the cross-runtime code `reserved_member` before route existence; the LEGACY WIRE face
    /// (this registry's string funnel) is EXEMPT from the refusal and dispatches — the FOLD
    /// still routes a nested chain to its owner either way (`rest` keeps the member word +
    /// verbatim tail), so code-only legacy shims (`biometric://available`,
    /// `chfx://sub/state`) keep answering shipped pages: reserved words are banned from
    /// manifests, never from the wire.
    class ResolvedCall(val chain: String, val spelled: String, val rest: String,
                       val folded: Int, val member: String? = null)

    /// THE FOLD, funnel-shaped (chains.json `_note`): (1) alias-normalize the arriving head to
    /// its primary chain; (2) while `chain + "." + parts[0]` is in the identity set, fold that
    /// segment out of the action path; (3) the remainder is the action path. The action path
    /// tokenizes on '/' (the native array-path separator) AND '.' (the dot plane — markup hands
    /// the dotted callee tail through whole), but the remainder is returned from the ORIGINAL
    /// string, so nothing downstream sees re-joined grammar. Never dot-counting, never a
    /// first-dot split — membership in the identity set is the only oracle, which is what
    /// keeps the fold strictly ADDITIVE: no chain registered ⇒ nothing ever folds. `dsx` is
    /// the reserved kernel channel, not a module — it never resolves as a chain head.
    fun resolveChain(scheme: String, actionPath: String): ResolvedCall {
        val key = scheme.lowercase()
        val path = if (actionPath.startsWith("/")) actionPath.substring(1) else actionPath
        if (key.isEmpty() || key == "dsx") return ResolvedCall(key, key, path, 0)
        // Tokenize at chain granularity, remembering each token's end (past its separator)
        // so the remainder can be cut verbatim.
        val tokens = ArrayList<String>()
        val after = ArrayList<Int>()
        var start = 0
        while (start < path.length) {
            var cut = start
            while (cut < path.length && path[cut] != '/' && path[cut] != '.') cut += 1
            tokens.add(path.substring(start, cut).lowercase())   // schemes are keyed lowercase
            after.add(if (cut < path.length) cut + 1 else cut)
            start = cut + 1
        }
        val base = chainIdentity.primaryFor(key) ?: key
        val folded = ChainResolver.fold(base, tokens, chainIdentity)
        var chain = base
        var spelled = key
        for (n in 0 until folded) {
            chain = "$chain.${tokens[n]}"
            spelled = "$spelled.${tokens[n]}"
        }
        val rest = if (folded == 0) path else path.substring(after[folded - 1])
        // Post-fold member classification (funnel-shaped: tokens are already lowercased, the
        // case-insensitive reading of the action plane): a leading reserved word in the
        // remainder is a MEMBER route — the caller's funnel refuses it as an action.
        val member = tokens.getOrNull(folded)?.takeIf { it in ChainResolver.reservedMembers }
        return ResolvedCall(chain, spelled, rest, folded, member)
    }

    /// `true` if a Module claiming `scheme` is loaded in this build. The
    /// generic answer to "should I run code that depends on a specific
    /// package?" - if the package's been excluded the scheme isn't registered
    /// and this returns false. Pure runtime - no compile-time coupling, no
    /// build flag, no shared-kernel slot named after the package.
    fun isAvailable(scheme: String): Boolean {
        val key = scheme.lowercase()
        return synchronized(lock) { routes.containsKey(key) }
    }

    /// The action names `scheme` answers IN-PROCESS right now — the diagnostics companion to
    /// `isAvailable`: the unknown-action funnel line names what WOULD have routed, so a typo'd
    /// call (`injct`) reads as "known actions: inject, eval, …" instead of a bare miss. Mirrors
    /// `Registration.dispatch` resolution exactly: a scheme with its own `dsx.scheme` table is
    /// isolated (that table only), any other owned scheme reads the shared `named` table, and
    /// in-process callers additionally reach `internalNamed`. Keys are stored lowercased at
    /// registration; sorted here for stable log lines. Empty for an unregistered scheme.
    fun actionNames(scheme: String): List<String> {
        val key = scheme.lowercase()
        val plugin = synchronized(lock) { routes[key] } ?: return emptyList()
        val reg = plugin.registration
        val names = HashSet(reg.internalNamed.keys)
        val scoped = reg.schemeNamed[key]
        if (scoped != null) names.addAll(scoped.keys) else names.addAll(reg.named.keys)
        return names.sorted()
    }

    // MARK: - Platform support (the graceful unsupported-platform answer)

    /// FULL-CATALOG platform support: scheme/alias (lowercase) → the platforms that implement
    /// the owning module (e.g. "scene3d" to listOf("ios")). Filled by the generated registry —
    /// GeneratedModules.register() installs the map prepare_modules_android.rb computes from
    /// concrete lane source (including fail-closed macOS/Windows/Linux facets).
    /// DEFAULT EMPTY = today's behavior: a bare kernel answers not_loaded for everything
    /// unhandled (which also keeps this pure-JVM testable — the envelope tests install a map).
    ///
    /// Every not_loaded answer consults this FIRST, so the three unhandled situations stay
    /// distinct (constitution Article 7 — honest degradation):
    ///   • in the catalog, NO implementation on this OS → `unsupported_platform` (structured)
    ///   • implemented here but excluded by THIS app    → `not_loaded` (the app's choice)
    ///   • not in the catalog at all (unknown scheme)   → `not_loaded` (today's behavior)
    /// `isAvailable` / `dsx.has` stays FALSE for all three — feature detection remains the
    /// primary pattern; `unsupported_platform` is the honest answer when someone calls anyway.
    @Volatile
    var platformSupport: Map<String, List<String>> = emptyMap()

    /// "<scheme>.<action>" → the platforms that ACTION supports. Sparse: only actions whose
    /// manifest NARROWS their module's set (X2 §4 `platforms`) appear, and an action-level row
    /// OUTRANKS its module's, because it is the more specific claim — a module implemented here
    /// whose one action has no twin on this platform must answer `unsupported_platform` for that
    /// action and nothing else. The Swift twin: ModuleRegistry.platformSupportByAction.
    @Volatile
    var platformSupportByAction: Map<String, List<String>> = emptyMap()

    private val kotlinDeployTargets = setOf("android", "macos", "windows", "linux")

    /// This kernel's id in `platformSupport` lists. Android keeps the default boot value;
    /// the Compose desktop host stamps the concrete deploy target before any package call.
    /// Fail closed to Android if a malformed/experimental value reaches this boundary — an
    /// unknown id must never gain access to another target's declared implementation.
    val currentPlatform: String
        get() = Platform.os.takeIf { it in kotlinDeployTargets } ?: "android"

    /// Non-null ⇒ `scheme` exists in the FULL module catalog but has NO implementation on this
    /// platform — the returned list names the platforms that DO implement it. Null ⇒ supported
    /// here, or unknown scheme, or no catalog installed: the caller falls through to today's
    /// `not_loaded` behavior. Case-insensitive (schemes are routing keys, keyed lowercase).
    fun unsupportedPlatforms(scheme: String): List<String>? {
        val supported = platformSupport[scheme.lowercase()] ?: return null
        return if (currentPlatform in supported) null else supported
    }

    /// The ACTION-AWARE read. An action-level narrowing decides on its own — including when the
    /// module IS implemented here, the case the scheme-only lookup structurally cannot see. With
    /// no action row the answer is the module's, byte for byte.
    fun unsupportedPlatforms(scheme: String, action: String?): List<String>? {
        if (!action.isNullOrEmpty()) {
            val key = "${scheme.lowercase()}.${action.lowercase().replace('/', '.')}"
            val declared = platformSupportByAction[key]
            if (declared != null) return if (currentPlatform in declared) null else declared
        }
        return unsupportedPlatforms(scheme)
    }

    /// The pinned `unsupported_platform` envelope message — "<Name> is not supported on
    /// Android" (Name = the scheme, first letter uppercased). Byte-identical on both
    /// platforms by contract: OpenSource/Skills/android/api-mapping.md "Unsupported platform".
    fun unsupportedPlatformMessage(scheme: String): String {
        val name = scheme.lowercase().replaceFirstChar { it.uppercase() }
        return "$name is not supported on ${platformDisplayName(currentPlatform)}"
    }

    /// The pinned `unsupported_platform` envelope data — { scheme, platform,
    /// supportedPlatforms } (same contract as the message above).
    fun unsupportedPlatformData(scheme: String, supported: List<String>): Map<String, Any?> =
        mapOf("scheme" to scheme.lowercase(), "platform" to currentPlatform,
              "supportedPlatforms" to supported)

    /// Human display names for the platform ids used in `platformSupport` lists
    /// (the desktop ids join per desktop-platforms.md; unknown ids keep the
    /// capitalize fallback so a future target degrades readably, never crashes).
    private fun platformDisplayName(id: String): String = when (id) {
        "ios" -> "iOS"
        "android" -> "Android"
        "web" -> "Web"
        "macos" -> "macOS"
        "windows" -> "Windows"
        "linux" -> "Linux"
        else -> id.replaceFirstChar { it.uppercase() }
    }

    // MARK: - Host-event hooks (the dynamic, cross-platform delegate surface)

    /// The fold policy for a delegate event — how `dispatch` collapses every watcher's answer.
    /// This single enum *is* what the four deleted fire-verbs used to encode in their NAMES:
    /// `void` = the old fire, `any` = fireAny, `claim` = claim, `collect` = collect, plus `veto` (deny if any answers
    /// `false`). `dsx.delegate.send(name, combine:)` takes it directly. Nested under
    /// ModuleRegistry like the Swift original (which dodges Apple's Combine framework).
    enum class Combine {
        void, any, claim, collect, veto;

        companion object {
            /// Map a `dsx.json`-declared policy string ("veto", "any", …) to the typed case
            /// (Swift's failable `init?(declared:)`). `null` for an unknown/absent string ⇒
            /// the caller falls back to `claim` (today's undeclared default).
            fun declared(raw: String?): Combine? = when (raw) {
                "void" -> void
                "any" -> any
                "claim" -> claim
                "collect" -> collect
                "veto" -> veto
                else -> null
            }
        }
    }

    /// THE delegate fold — the ONE and ONLY place every cross-module event collapses. A watcher
    /// attaches via `dsx.delegate.listen` (priority-ordered); `dispatch` runs them all and combines
    /// per `combine`. `dsx.delegate.send` lowers straight here in ONE hop — there is no other
    /// pipeline and no verb in between (delegates.md phase 4, the collapse: the four legacy
    /// fire-verbs `fire`/`fireAny`/`claim`/`collect` are DELETED; `combine` *is* the difference
    /// they used to spell out):
    ///   void    run all, ignore answers (notification) + ALIAS fan-out → null
    ///   any     run all; `true` if any answered non-null (consumed) → Boolean (openURL parity — NOT Bool-true)
    ///   claim   first non-null answer wins (ownership)              → Any?    (short-circuits)
    ///   collect every non-null answer, in priority order            → List<Any>
    ///   veto    `false` if any watcher returned Boolean `false`     → Boolean (short-circuits on first denier)
    ///
    /// ALIAS fan-out (the module-events plane, `void` ONLY): a module-scoped event name —
    /// "<chain>.<kind>" — ALSO folds under each legacy alias spelling of that chain
    /// ("watchhealth.heartRate"), so an alias handle's `.on` watcher hears the module's events
    /// regardless of WHEN it subscribed — the live table cannot normalize an alias whose owner
    /// registers later, and boot order must never decide whether a watcher hears (review round 3).
    /// Broadcast (`void`) only — claim/veto planes answer OWNERSHIP and must never double-invoke.
    /// Alias spellings are never chains, so the fan-out cannot recurse. It lives INSIDE the fold,
    /// not in a caller-side wrapper: the deleted `fire` shim carried it, and deleting a shim must
    /// never drop behavior — `dsx.delegate.send(…, combine = Combine.void)` keeps it.
    fun dispatch(event: String, input: Any? = null, combine: Combine = Combine.void): Any? {
        val handlers = orderedHooks(event)
        return when (combine) {
            Combine.void -> {
                for (h in handlers) h(input)
                for (spelled in aliasSpellingsOf(event)) {
                    for (h in orderedHooks(spelled)) h(input)
                }
                null
            }
            Combine.any -> {
                // Non-null (not Bool-true) = "handled": some openURL/continueActivity watchers
                // consume by returning the URL or `true`, so anything non-null counts. Every
                // watcher still runs.
                var handled = false
                for (h in handlers) if (h(input) != null) handled = true
                handled
            }
            Combine.claim -> {
                for (h in handlers) h(input)?.let { return it }
                null
            }
            Combine.collect -> handlers.mapNotNull { it(input) }
            Combine.veto -> !handlers.any { (it(input) as? Boolean) == false }
        }
    }

    // The four legacy fire-verbs (`fire` / `claim` / `fireAny` / `collect`) were DELETED by
    // delegates.md phase 4 — the collapse. Every emitter now names its fold explicitly:
    //   fire(e, i)     → dispatch(e, i, Combine.void)
    //   claim(e, i)    → dispatch(e, i, Combine.claim)
    //   fireAny(e, i)  → (dispatch(e, i, Combine.any)     as? Boolean)   ?: false
    //   collect(e, i)  → (dispatch(e, i, Combine.collect) as? List<Any>) ?: emptyList()
    // ONE fold, ONE spelling; the combine policy carries the meaning the verb name used to.

    /// Every watcher registered for `event` across ALL packages, ordered by priority (desc),
    /// ties broken by registration order (stable). Sorts GLOBALLY across packages — not within
    /// one — because the fold needs a single ordered pipeline. Priority 0 reproduces
    /// the plain `allPackages` × registration order (behavior-neutral). `n` per event is tiny.
    private fun orderedHooks(event: String): List<(Any?) -> Any?> {
        val snapshot = synchronized(lock) { allPackages.toList() }
        class Entry(val priority: Int, val order: Int, val handler: (Any?) -> Any?)
        val entries = ArrayList<Entry>()
        var order = 0
        for (pkg in snapshot) {
            for (entry in pkg.registration.hooks[event].orEmpty()) {
                entries.add(Entry(entry.priority, order, entry.handler)); order += 1
            }
        }
        entries.sortWith(compareByDescending<Entry> { it.priority }.thenBy { it.order })
        return entries.map { it.handler }
    }

    // MARK: - Dispatch

    /// Returns `true` if a package handled this URL. `false` means no package
    /// owns the scheme, or the scheme is owned but neither a pre-filter nor a
    /// named action took it - both fall through to the inline handler chain.
    /// `includeInternal` is forwarded to the package's `dispatch`: the in-process `dsx.module`
    /// path passes `true` (so a package reaches its own `dsx.action(exposed:false)` internals);
    /// the web/URL relay leaves it `false`, keeping internal actions off the untrusted bus.
    fun handle(url: URI, params: Bridge.Params, includeInternal: Boolean = false): Boolean {
        val scheme = url.scheme?.lowercase() ?: return false   // case-insensitive (RFC 3986): `LPA:` → `lpa`

        val plugin = synchronized(lock) { routes[scheme] } ?: return false

        // The registry hands a fresh per-call `dsx` to the package's pre-filter
        // / named handler. There is no ambient bound state: async tails simply
        // capture the `dsx` they were given.
        // (Foundation lowercases url.host; java.net.URI preserves case, so lower here.
        //  A non-hostname authority — `readhealthkit://A,B` — parses registry-based on
        //  the JVM: host is null, the authority carries the data slot.)
        val host = (url.host ?: url.authority ?: "").lowercase()
        return plugin.registration.dispatch(scheme = scheme, host = host, url = url,
                                            params = params, includeInternal = includeInternal)
    }

    /// STRING-KEYED dispatch — the routing entry for every STRUCTURED call path
    /// (the web's object-body transport, native `dsx.module` calls, messenger
    /// mounts). A package scheme is a routing KEY, not URL grammar: identifier
    /// names like `godot_test` are fully legal here even though RFC 3986 forbids
    /// `_` in a URL scheme. Internally a carrier URL is synthesized under the fixed
    /// `dsx-call` scheme purely so handlers keep their url.host/path view of the
    /// action — the app-defined scheme never has to survive a URL parser again.
    fun handle(scheme: String, actionPath: String,
               params: Bridge.Params, includeInternal: Boolean = false): Boolean {
        val key = scheme.lowercase()
        if (key.isEmpty()) return false

        // The KERNEL answers the reserved scheme's verbs (`dsx.log` / `dsx.error` — dot
        // notation IS the API; the scheme is only a bus routing key)
        // before any module route — `dsx` is refused to modules at register() above, so
        // there is never a collision. This is how the web PAGE reaches the log ring and
        // the ambient error fan-out (`despia.log(...)` / window.onerror forwarding in
        // runtime.js), and how any bus caller does; an unknown verb answers
        // `unknown_action` honestly through the shared Registration fall-through.
        // `dsx.has("dsx")` stays false — a kernel channel, not a module.
        //
        // Everything else runs THE FOLD first (`resolveChain` — the chains corpus law at the
        // ONE dispatch funnel, so every face benefits: markup, native `dsx.module`, messenger
        // mounts, the web transport). Nothing folded ⇒ the verbatim pre-fold route (bit for
        // bit today's behavior — the fold is strictly additive). Folded ⇒ route the CHAIN's
        // owner and dispatch under the ARRIVING spelling: `ctx.scheme` keeps the caller's
        // grammar (catch-all routing) while identity stays the primary chain. A folded chain
        // with no route (the excluded overlay) answers `false` honestly — attribution against
        // the CHAIN, not a phantom action on its parent, rides the caller's own `resolveChain`
        // (Context's unhandled answer does exactly that).
        val registration: Registration
        var dispatchScheme = key
        var trimmed = if (actionPath.startsWith("/")) actionPath.substring(1) else actionPath
        if (key == "dsx") {
            registration = kernelVerbs
        } else {
            val res = resolveChain(key, actionPath)
            // The reserved_member refusal is a MODERN-face law ONLY (the typed proxies and
            // Context._call/_dispatch refuse it before a call can form). THIS funnel is also
            // the LEGACY WIRE face (the v3 string transport), which is EXEMPT from the
            // refusal: reserved words are banned from MANIFESTS, never from the wire, so a
            // code-only legacy shim registered under a reserved spelling
            // (biometric://available, bluetooth://state, scanningmode://on) keeps answering
            // shipped pages — the compat those shims exist for (corpus `_note`). The FOLD
            // still applies for ROUTING regardless — a nested chain reaches its owner even
            // when the remainder starts with a reserved word (chfx://sub/state dispatches
            // action `state` on chfx.sub, where a shim answers and an unregistered name
            // answers unknown_action on the CHILD) — so owner and attribution are the same
            // on every runtime; ONLY the refusal is face-gated. `res.rest` already carries
            // the member word plus the verbatim tail (the fold cuts at chain segments only).
            if (res.folded > 0) {
                val plugin = synchronized(lock) { routes[res.chain] } ?: return false
                registration = plugin.registration
                dispatchScheme = res.spelled
                trimmed = res.rest
            } else {
                registration = (synchronized(lock) { routes[key] } ?: return false).registration
            }
        }
        val segments = trimmed.split("/").filter { it.isNotEmpty() }
        // Foundation lowercases url.host, so the URL path delivered actions
        // lowercased — keep that contract for the first segment.
        val host = (segments.firstOrNull() ?: "").lowercase()
        val rest = segments.drop(1).joinToString("/")
        var raw = "dsx-call://" + host + (if (rest.isEmpty()) "" else "/$rest")
        val rid = params.requestID
        if (!rid.isNullOrEmpty()) {
            raw += "?__rid=" + percentEncodeQueryValue(rid)
        }
        val url = try { URI(raw) } catch (_: Exception) { return false }
        return registration.dispatch(scheme = dispatchScheme, host = host, url = url,
                                     params = params, includeInternal = includeInternal)
    }

    /// The reserved scheme's kernel verbs (logs corpus / errors corpus): `log` records one
    /// line ({ message, scheme? } — source defaults to "page", the bridge's caller),
    /// `error` runs the ambient fan-out ({ code, message?, recoverable?, data?, scheme? }).
    /// Both resolve null. The skip-prefilter makes an unknown verb fall through to the
    /// Registration's `unknown_action` answer — never a misleading not_loaded.
    private val kernelVerbs: Registration by lazy {
        val reg = Registration(primaryScheme = "dsx", aliases = emptyList())
        reg.prefilter = { dsx -> dsx.skip() }
        reg.named["log"] = { dsx ->
            val source = (dsx.args("scheme") as? String ?: "").ifEmpty { "page" }
            reportLog(scheme = source, level = "log",
                      message = JSE.string(dsx.args("message") ?: ""))
            dsx.resolve()
        }
        reg.named["error"] = { dsx ->
            val source = (dsx.args("scheme") as? String ?: "").ifEmpty { "page" }
            val code = JSE.string(dsx.args("code") ?: "").ifEmpty { "error" }
            reportAmbientError(
                scheme = source, code = code,
                message = dsx.args("message")?.takeIf { it != NSNull }?.let { JSE.string(it) },
                recoverable = JSE.truthy(dsx.args("recoverable")),
                data = dsx.args("data"))
            dsx.resolve()
        }
        reg
    }

    /// `addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)` for the rid slot.
    private fun percentEncodeQueryValue(s: String): String {
        val allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@/?"
        val out = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xFF
            if (c < 128 && allowed.indexOf(c.toChar()) >= 0) out.append(c.toChar())
            else out.append('%').append("0123456789ABCDEF"[c shr 4]).append("0123456789ABCDEF"[c and 0xF])
        }
        return out.toString()
    }

    // MARK: - Hydration

    /// Run every module's registered `hydrate { ... }` block — called after the page runtime is
    /// in place (`window.virtual` exists, emits land cleanly). WebKit-free: the dom module
    /// publishes the `"web"` shared handle and calls this; the kernel names no web view.
    fun runHydrations() {
        val snapshot = synchronized(lock) { allPackages.toList() }
        for (plugin in snapshot) {
            for (block in plugin.registration.hydrations) {
                block(plugin.dsx)
            }
        }
    }

    /// Run every module's registered `dsx.ready { ... }` block — the page has settled, `<body>`
    /// is parsed. WebKit-free (the dom module owns the web view).
    fun runReady() {
        val snapshot = synchronized(lock) { allPackages.toList() }
        for (plugin in snapshot) {
            for (block in plugin.registration.readyBlocks) {
                block(plugin.dsx)
            }
        }
    }

    // MARK: - Bootstrap (two phases: the BOOT tier, then everything)

    /// Discovery stash filled by the generated-registry seam, consumed by `boot()`.
    private val discovered = ArrayList<Pair<String, () -> Module>>()
    /// Schemes flagged boot-eligible by the generated registry (the manifests' flags).
    private val bootSchemes = HashSet<String>()
    /// Module factories found by discovery but NOT boot-eligible — instantiated by
    /// `bootstrap()` (the deferred phase). Filled by `boot()`.
    private val deferredPackageFactories = ArrayList<() -> Module>()
    private var didBoot = false

    /// PHASE 1 — the BOOT TIER. Consumes the generated registry: instantiates ONLY the
    /// packages whose schemes are flagged boot-eligible (their `setup()` must be instant
    /// — see the contract on `bootEligible`). Everything else is stashed for
    /// `bootstrap()`. Call synchronously at the very top of launch, then
    /// `claim("boot.splash", …)` — a package can own the first frame without dragging
    /// every SDK init ahead of the splash paint.
    fun boot() {
        val entries: List<Pair<String, () -> Module>>
        synchronized(lock) {
            if (didBoot) return
            didBoot = true
            entries = discovered.toList()
            discovered.clear()
        }
        for ((scheme, factory) in entries) {
            if (scheme in bootSchemes) {
                register(factory)               // boot tier: instant-safe setup() by contract
            } else {
                synchronized(lock) { deferredPackageFactories.add(factory) }
            }
        }
    }

    /// PHASE 2 — everything else. Idempotent - subsequent calls are no-ops. Runs the
    /// boot phase if it hasn't (a background wakeup never paints, so phase order is moot
    /// there), then instantiates the deferred (non-boot-tier) packages — the `setup()`
    /// side effects the splash paint is protected from. Call from the host's deferred
    /// launch block (and before any registry consumer).
    fun bootstrap() {
        boot()                       // ensure discovery + the boot tier happened (no-op when it has)
        val pending: List<() -> Module>
        synchronized(lock) {
            if (didBootstrap) return
            didBootstrap = true
            pending = deferredPackageFactories.toList()
            deferredPackageFactories.clear()
        }
        for (factory in pending) register(factory)
        kernelLog("[ModuleRegistry] Bootstrapped ${synchronized(lock) { allPackages.size }} plugin(s): $registeredSchemes")
    }

    /// TEST-ONLY (not part of the 1:1 surface — see header NOTES): clear the process
    /// singleton so a suite can exercise the boot phases from scratch.
    internal fun _resetForTests() {
        synchronized(lock) {
            routes.clear(); allPackages.clear()
            discovered.clear(); bootSchemes.clear(); deferredPackageFactories.clear()
            didBoot = false; didBootstrap = false
            platformSupport = emptyMap()
            platformSupportByAction = emptyMap()
            knownExcludedIdentities = emptyMap()
        }
    }
}
