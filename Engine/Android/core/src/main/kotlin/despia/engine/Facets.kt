//
//  Facets.kt - THE FACET RESOLUTION LADDER (facet-contracts.md).
//
//  "A call resolves local → declared `reach` over the link → typed `unavailable`. The caller
//  never spells the route; markup ships identically on every surface." That is the whole
//  point: the same DSX ships on the phone, the wrist, a widget and a clip, and moving an
//  action between facets changes no call site.
//
//  THE KERNEL KNOWS NO FACET WORD. A runtime binds one REGISTERED word (`FacetSeam.facet`)
//  and consumes a compiled capability table (`FacetSeam.rows`) — both build data, arriving
//  through the same empty-seam discipline the rest of this kernel uses. An UNBOUND runtime
//  with an empty table answers exactly what `Context.unhandledCallError` answered before this
//  file existed: every facet-dependent rung is skipped and the build-fact rungs (`excluded` /
//  `not_loaded`) remain. An unfilled seam is not a failure mode — it is the default.
//
//  THE LADDER, in order, at the ONE dispatch funnel:
//    1. LOCAL  — a registered module answering this action wins before anything else is
//                consulted, so a partly-local chain never pays for the table.
//    2. REACH  — the row admits THIS facet ⇒ invoke over the link; admitted with no transport
//                installed ⇒ the typed `unreachable`, never a hang and never a silent no-op.
//    3. TYPED UNAVAILABLE — the reason IS the code (durability.md P4), always through the
//                ordinary call-failure path into the error ledger, never a side channel:
//                `unknown_action` (the module IS here — a caller bug, not absence) >
//                `unsupported_platform` (the platform catalog, then a row that neither
//                provides nor reaches us — the NEVER-ON-THIS-FACET class, which KEEPS its
//                shipping name; the draft spelling `never_on_facet` is retired grammar) >
//                `excluded` (a build fact beats a runtime one) > `prerequisites_missing`
//                (the row promised a local implementation nothing stood up) > `not_loaded`.
//
//  Pure JVM, dependency-free, unit-testable: `FacetLadder.resolve` takes FACTS, never a
//  registry, so the corpus states them literally and the live funnel resolves them once.
//  Corpus: OpenSource/Conformance/facets/facets.json (TS + Kotlin execute every case).
//

package despia.engine

/// One compiled capability row — the generated per-facet twin of an action's manifest
/// contract (`provides` / `reach` in its `dsx.json`).
data class FacetRow(
    /// the facets whose runtime implements this action LOCALLY
    val provides: List<String> = emptyList(),
    /// the facets that may invoke it OVER THEIR LINK. Fail-closed: `null` admits nobody —
    /// the manifest's absent `reach` AND its explicit `false` (the deny) land here alike,
    /// because they mean the same thing at runtime ("a call a table doesn't admit never fires").
    val reach: List<String>? = null,
)

/// What the far node answered. Public on purpose: the transport seam is filled by whoever
/// boots the surface, and it must not need `Bridge`'s internal outcome type.
sealed class FacetOutcome {
    class Resolve(val payload: Any?) : FacetOutcome()
    class Failure(
        val code: String,
        val data: Any? = null,
        val message: String? = null,
        val recoverable: Boolean = false,
    ) : FacetOutcome()
}

/// The call as it crosses the link — the resolved identity, never the caller's spelling.
data class FacetCall(val chain: String, val action: String, val facet: String)

/// The build seam. Empty by default; a host installs it at boot exactly like the generated
/// registry installs `ModuleRegistry.platformSupport`.
object FacetSeam {
    /// the registered facet word THIS runtime binds; null = unbound (the honest default)
    @Volatile
    @JvmStatic
    var facet: String? = null

    /// the compiled capability table: chain → action → row. EXCLUSION-BLIND, like the
    /// platform catalog — a row survives its module being dropped from this build, so an
    /// absence can be attributed instead of guessed.
    @Volatile
    @JvmStatic
    var rows: Map<String, Map<String, FacetRow>> = emptyMap()

    /// the reach transport; null = no link, and the ladder answers the typed `unreachable`
    /// rather than hanging (facet-contracts.md: absence is load-bearing). Callback-shaped so
    /// the funnel can settle a continuation from it without a coroutine boundary.
    @Volatile
    @JvmStatic
    var invoke: ((FacetCall, Map<String, Any?>, (FacetOutcome) -> Unit) -> Unit)? = null

    /// The row for one call, or null. Action keys are matched verbatim first, then lowercased
    /// (the funnel's own host convention), so a camelCase manifest action still resolves.
    fun row(chain: String, action: String): FacetRow? {
        val forChain = rows[chain.lowercase()] ?: return null
        return forChain[action] ?: forChain[action.lowercase()]
    }
}

/// The eight facts the ladder consumes — stated, never fetched. The corpus writes them
/// literally; `Context` resolves them once per unhandled call.
data class FacetFacts(
    /// a registered module answers THIS action here
    val local: Boolean = false,
    /// a module is registered for this chain (even if it does not answer this action)
    val module: Boolean = false,
    /// the registered facet word this runtime binds; null = unbound
    val facet: String? = null,
    /// the compiled capability row for this call, or null
    val row: FacetRow? = null,
    /// a reach transport is installed
    val transport: Boolean = false,
    /// a generated CLIENT-LINK route exists for this call AND its transport is installed.
    /// DIVERGENCE (tracked, not silent): Android ships no client link yet — the Kotlin twin
    /// of `LinkSeam` is A0-SWEEP L-10 — so this is always false here today. The fact exists
    /// so the ladder's shape is identical across runtimes the day the twin lands.
    val linked: Boolean = false,
    /// the chain is in the build-excluded overlay
    val excluded: Boolean = false,
    /// the platform catalog knows this scheme but not on this OS (the X-tier)
    val offPlatform: Boolean = false,
    /// the platform catalog knows THIS ACTION and it is declared off this OS (X2 §4
    /// `platforms`). Separate from `offPlatform` because it outranks `unknown_action`: the
    /// module can be here and still not run this action, and calling a declared-impossible
    /// action is not the caller bug `unknown_action` names.
    val offPlatformAction: Boolean = false,
)

object FacetLadder {

    enum class Rung { LOCAL, REACH, UNAVAILABLE }

    /// Which transport rung two chose. FACET = the facet link; LINK = the generated
    /// client-link table (never produced on Android today — see `FacetFacts.linked`).
    enum class Via { FACET, LINK }

    /// The ladder's answer: `LOCAL`/`REACH` carry no code, `UNAVAILABLE` carries exactly one
    /// frozen spelling from `codes` below.
    data class Verdict(val rung: Rung, val code: String? = null, val via: Via? = null)

    /// The frozen unavailable vocabulary (durability.md P4). `never_on_facet` is RETIRED —
    /// `unsupported_platform` keeps the never-on-this-facet meaning it always had on the wire.
    val codes: Set<String> = setOf(
        "unknown_action", "unsupported_platform", "excluded", "prerequisites_missing",
        "unreachable", "not_loaded")

    private val LOCAL = Verdict(Rung.LOCAL)
    private val REACH_FACET = Verdict(Rung.REACH, via = Via.FACET)
    private val REACH_LINK = Verdict(Rung.REACH, via = Via.LINK)

    /// THE LADDER, pure — `OpenSource/Conformance/facets/facets.json` drives exactly this.
    /// Total by construction: every input answers one rung, and every UNAVAILABLE answer
    /// carries a frozen code. Never a hang, never an untyped failure.
    fun resolve(f: FacetFacts): Verdict {
        if (f.local) return LOCAL

        val facet = f.facet
        val reach = f.row?.reach
        // fail-closed: an absent (or denied) `reach` admits nobody
        if (facet != null && reach != null && reach.contains(facet)) {
            return if (f.transport) REACH_FACET else Verdict(Rung.UNAVAILABLE, "unreachable")
        }
        if (f.linked) return REACH_LINK

        val code = when {
            // the ACTION-level narrowing first: it is the more specific claim, and the only
            // rung that can be true while the module itself is present and correct
            f.offPlatformAction -> "unsupported_platform"
            f.module -> "unknown_action"
            f.offPlatform -> "unsupported_platform"
            // the facet half of rung three sits BETWEEN the platform catalog and the excluded
            // overlay, which is exactly the frozen precedence: a row that neither provides nor
            // reaches us is NEVER-ON-THIS-FACET and outranks `excluded`, while a row that
            // promises a local implementation yields to `excluded` (a build fact beats a
            // runtime one).
            facet != null && f.row != null && !f.row.provides.contains(facet) -> "unsupported_platform"
            f.excluded -> "excluded"
            facet != null && f.row != null -> "prerequisites_missing"
            else -> "not_loaded"
        }
        return Verdict(Rung.UNAVAILABLE, code)
    }
}
