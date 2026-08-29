package despia.engine

import java.io.File
import java.util.concurrent.Executor
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * The FACET RESOLUTION LADDER conformance runner — executes
 * OpenSource/Conformance/facets/facets.json through THIS runtime's ladder (the TS runner
 * runs the SAME file). The law under test (facet-contracts.md, the corpus `_note`):
 * a call resolves **local → declared `reach` over the link → typed unavailable**, and the
 * reason IS the code (durability.md P4) — `unknown_action` > `unsupported_platform` (which
 * KEEPS the never-on-this-facet meaning; `never_on_facet` is retired grammar) > `excluded`
 * > `prerequisites_missing` > `not_loaded`, with `unreachable` for "admitted but no
 * transport". Never a hang, never an untyped throw.
 *
 * Cases state the call as `chain/action` directly, so the ladder is gated independently of
 * the identity FOLD (that is `ChainsConformanceTest`'s job). The corpus's `linked` rung is
 * never asserted: Android ships no client link yet (A0-SWEEP L-10), which is a DECLARED
 * divergence carried in `FacetFacts.linked`, not a silent gap.
 *
 * The funnel tests below prove the same ladder live at `Context._call`: the reach transport
 * is invoked with the resolved identity, an absent transport answers the typed `unreachable`
 * instead of hanging, and the EMPTY seam answers exactly what this funnel answered before
 * the ladder existed.
 */
class FacetsConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/facets/facets.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/facets/facets.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpus(): Map<String, Any?> =
        json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("facets.json: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun world(doc: Map<String, Any?>): Map<String, Any?> =
        doc["world"] as? Map<String, Any?> ?: error("facets.json: no world")

    /** The corpus's compiled capability table, exactly as the fixture states it. */
    @Suppress("UNCHECKED_CAST")
    private fun table(doc: Map<String, Any?>): Map<String, Map<String, FacetRow>> {
        val raw = world(doc)["table"] as? Map<String, Any?> ?: error("facets.json: no world.table")
        return raw.mapValues { (_, actions) ->
            (actions as Map<String, Any?>).mapValues { (_, spec) ->
                val row = spec as Map<String, Any?>
                val provides = (row["provides"] as? List<*> ?: emptyList<Any?>()).map { JSE.string(it) }
                // `reach: false` (the explicit deny) and an ABSENT reach are the same fact at
                // runtime — both admit nobody — so both land as null here.
                val reach = (row["reach"] as? List<*>)?.map { JSE.string(it) }
                FacetRow(provides = provides, reach = reach)
            }
        }
    }

    /** `chain/action` — the corpus's one call spelling (the native array-path convention). */
    private fun split(call: String): Pair<String, String> {
        val i = call.indexOf('/')
        return if (i < 0) call to "" else call.substring(0, i) to call.substring(i + 1)
    }

    /** The corpus world + one case, as the eight facts the pure ladder consumes. */
    @Suppress("UNCHECKED_CAST")
    private fun facts(doc: Map<String, Any?>, c: Map<String, Any?>): FacetFacts {
        val (chain, action) = split(JSE.string(c["call"]))
        val local = c["local"] as? Map<String, Any?> ?: emptyMap()
        val actions = (local[chain] as? List<*> ?: emptyList<Any?>()).map { JSE.string(it) }
        val excluded = world(doc)["excluded"] as? Map<String, Any?> ?: emptyMap()
        val platforms = world(doc)["platforms"] as? Map<String, Any?> ?: emptyMap()
        val platformActions = world(doc)["platformActions"] as? Map<String, Any?> ?: emptyMap()
        return FacetFacts(
            local = actions.contains(action),
            module = local.containsKey(chain),
            facet = c["facet"]?.let { JSE.string(it) },
            row = table(doc)[chain]?.get(action),
            transport = c["transport"] == true,
            linked = false,
            excluded = excluded.containsKey(chain),
            offPlatform = platforms.containsKey(chain),
            // The ACTION-level narrowing (X2 §4). Read here for the same reason `offPlatform`
            // is: both are PRE-FILTERED build data, so the ladder never asks what OS it is on.
            offPlatformAction = platformActions.containsKey("$chain.$action"),
        )
    }

    // MARK: - The corpus runner (every case, ladder semantics)

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun facetsCorpus(): List<DynamicTest> {
        val doc = corpus()
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("facets.json: no cases[]")
        val codes = (doc["codes"] as? List<*> ?: emptyList<Any?>()).map { JSE.string(it) }.toSet()
        val tests = ArrayList<DynamicTest>()
        // The frozen unavailable vocabulary must never drift from the corpus on either side.
        tests.add(DynamicTest.dynamicTest("facets-corpus/frozen-codes") {
            assertEquals(codes, FacetLadder.codes, "the unavailable vocabulary drifted from facets.json")
            // durability P4 retired `never_on_facet`; the kept spelling must be present.
            val retired = doc["retired"] as? Map<String, Any?> ?: emptyMap()
            for ((old, kept) in retired) {
                assertTrue(old !in FacetLadder.codes, "$old is retired grammar")
                assertTrue(JSE.string(kept) in FacetLadder.codes, "$kept must be a frozen code")
            }
        })
        for (c in cases) {
            val name = "facets-corpus/${c["name"]}"
            tests.add(DynamicTest.dynamicTest(name) {
                val expect = c["expect"] as? Map<String, Any?> ?: error("$name: no expect")
                val v = FacetLadder.resolve(facts(doc, c))
                assertEquals(JSE.string(expect["rung"]).uppercase(), v.rung.name, "$name: rung (code ${v.code})")
                assertEquals(expect["code"]?.let { JSE.string(it) }, v.code, "$name: code")
                if (v.rung == FacetLadder.Rung.UNAVAILABLE) {
                    assertTrue(v.code in codes, "$name: ${v.code} is not a frozen code")
                    assertNull(v.via, "$name: only the reach rung names a transport")
                } else {
                    assertNull(v.code, "$name: only the unavailable rung carries a code")
                    if (v.rung == FacetLadder.Rung.REACH) assertNotNull(v.via, "$name: the reach rung names its transport")
                }
            })
        }
        return tests
    }

    @Test
    fun theLadderIsTotal() {
        // Every combination of the boolean facts, against every row shape the world declares
        // plus the row-less case: the answer is always one rung, and an `unavailable` always
        // carries a frozen code. This is the "never a hang, never an untyped throw" law as a
        // fixture — the TS twin runs the identical sweep.
        val doc = corpus()
        val rows = ArrayList<FacetRow?>().apply {
            add(null)
            for (actions in table(doc).values) addAll(actions.values)
        }
        var seen = 0
        for (row in rows) {
            for (facet in listOf(null, "app", "watch", "widget", "activity", "unregistered")) {
                for (bits in 0 until 128) {
                    val v = FacetLadder.resolve(FacetFacts(
                        local = bits and 1 != 0, module = bits and 2 != 0, facet = facet, row = row,
                        transport = bits and 4 != 0, linked = bits and 8 != 0,
                        excluded = bits and 16 != 0, offPlatform = bits and 32 != 0,
                        offPlatformAction = bits and 64 != 0))
                    seen += 1
                    if (v.rung == FacetLadder.Rung.UNAVAILABLE)
                        assertTrue(v.code in FacetLadder.codes, "untyped absence ${v.code}")
                    else assertNull(v.code)
                }
            }
        }
        assertEquals(rows.size * 6 * 128, seen)
    }

    // MARK: - Funnel wiring (the same ladder, live at Context._call)

    /** A partly-local chain: `locate` runs here, `relayOnly` never does. */
    private class LocMod : Module() {
        override val scheme get() = "loc"
        override fun setup() {
            dsx.action("locate") { it.resolve("here") }
        }
    }

    private fun inlineExecutors() {
        ModuleRegistry.shared.mainExecutor = Executor { it.run() }
        JSERunner.mainExecutor = Executor { it.run() }
    }

    /** Set-run-restore for the PROCESS-GLOBAL facet seam — never a bare assignment: a leaked
     *  facet word would give whichever suite runs next in this JVM a phantom runtime identity
     *  (order-dependent failures that pass in isolation). */
    private fun withSeam(facet: String?, invoke: ((FacetCall, Map<String, Any?>, (FacetOutcome) -> Unit) -> Unit)?,
                         body: () -> Unit) {
        FacetSeam.facet = facet
        FacetSeam.rows = table(corpus())
        FacetSeam.invoke = invoke
        try { body() } finally {
            FacetSeam.facet = null
            FacetSeam.rows = emptyMap()
            FacetSeam.invoke = null
        }
    }

    private fun withExcludedOverlay(map: Map<String, Map<String, String>>, body: () -> Unit) {
        ModuleRegistry.shared.knownExcludedIdentities = map
        try { body() } finally { ModuleRegistry.shared.knownExcludedIdentities = emptyMap() }
    }

    /** The diagnostics observer — a REGISTERED module, because that is the only place a hook
     *  attaches (the Harness pattern `ErrorsConformanceTest` uses). */
    private class FunnelObserver : Module() {
        override val scheme get() = "facetfunnel"
        override fun setup() {
            dsx.delegate.listen("module.callFailed") { input ->
                @Suppress("UNCHECKED_CAST") (input as? Map<String, Any?>)?.let { onCallFailed?.invoke(it) }
                null
            }
        }
        companion object {
            var onCallFailed: ((Map<String, Any?>) -> Unit)? = null
            private var registered = false
            /** Register EXACTLY once per JVM: every `register` attaches another hook, and a
             *  second copy would double every funnel record this suite counts. */
            fun ensure() { if (!registered) { registered = true; ModuleRegistry.shared.register { FunnelObserver() } } }
        }
    }

    /** Drive one call to its typed failure and hand back the code + the funnel record. */
    private fun failureOf(chain: String, action: String): Pair<String, Map<String, Any?>> {
        FunnelObserver.ensure()
        val seen = ArrayList<Map<String, Any?>>()
        FunnelObserver.onCallFailed = { seen.add(it) }
        val caller = Module().dsx
        try {
            return runBlocking {
                try {
                    caller.module[chain][action]()
                    fail("$chain.$action resolved — expected a typed failure")
                } catch (e: ModuleCallError.ActionFailed) {
                    assertEquals(1, seen.size, "every failure reports to the ONE diagnostics funnel")
                    e.code to seen.first()
                } catch (e: ModuleCallError.NotLoaded) {
                    assertEquals(1, seen.size, "every failure reports to the ONE diagnostics funnel")
                    "not_loaded" to seen.first()
                }
            }
        } finally { FunnelObserver.onCallFailed = null }
    }

    @Test
    fun rungOneStillWinsWithASeamInstalled() {
        inlineExecutors(); ModuleRegistry.shared.register { LocMod() }
        val reached = ArrayList<FacetCall>()
        withSeam("app", { call, _, settle -> reached.add(call); settle(FacetOutcome.Resolve(null)) }) {
            val caller = Module().dsx
            val out = runBlocking { caller.module["loc"]["locate"]() }
            assertEquals("here", out.foundationValue)
            assertTrue(reached.isEmpty(), "the transport must not be touched when the action is local")
        }
    }

    @Test
    fun rungTwoInvokesTheTransportWithTheResolvedIdentity() {
        inlineExecutors(); ModuleRegistry.shared.register { LocMod() }
        val reached = ArrayList<Pair<FacetCall, Map<String, Any?>>>()
        withSeam("widget", { call, args, settle -> reached.add(call to args); settle(FacetOutcome.Resolve("far")) }) {
            val caller = Module().dsx
            // `loc` IS registered here, but `relayOnly` is reach-only for the widget facet:
            // rung two applies per ACTION, never merely per chain.
            val out = runBlocking { caller.module["loc"]["relayOnly"](mapOf("q" to 1)) }
            assertEquals("far", out.foundationValue)
            assertEquals(1, reached.size)
            assertEquals(FacetCall("loc", "relayOnly", "widget"), reached.first().first)
            assertEquals(1.0, JSE.number(reached.first().second["q"]))
        }
    }

    @Test
    fun admittedByReachWithNoTransportIsTheTypedUnreachable() {
        inlineExecutors(); ModuleRegistry.shared.register { LocMod() }
        withSeam("widget", null) {
            val (code, funnel) = failureOf("loc", "relayOnly")
            assertEquals("unreachable", code)
            assertEquals("unreachable", JSE.string(funnel["code"]))
            @Suppress("UNCHECKED_CAST")
            val data = funnel["data"] as? Map<String, Any?> ?: error("no data")
            assertEquals("loc", JSE.string(data["scheme"]))
            assertEquals("relayOnly", JSE.string(data["action"]))
            assertEquals("widget", JSE.string(data["facet"]))
        }
    }

    @Test
    fun aTransportFailurePassesItsOwnTypedAnswerThrough() {
        inlineExecutors(); ModuleRegistry.shared.register { LocMod() }
        withSeam("widget", { _, _, settle -> settle(FacetOutcome.Failure("unauthenticated", null, "no token")) }) {
            val (code, _) = failureOf("loc", "relayOnly")
            assertEquals("unauthenticated", code, "a far node's typed answer is never flattened to unreachable")
        }
        // …and a transport that THROWS synchronously must not unwind the funnel
        withSeam("widget", { _, _, _ -> throw IllegalStateException("socket closed") }) {
            val (code, _) = failureOf("loc", "relayOnly")
            assertEquals("unreachable", code)
        }
    }

    @Test
    fun neverOnThisFacetAndPrerequisitesMissingAreDistinct() {
        inlineExecutors(); ModuleRegistry.shared.register { LocMod() }
        // `beacon` has a row and no local module: from a facet it neither provides nor
        // reaches, that is NEVER-ON-THIS-FACET (unsupported_platform, the kept spelling)…
        withSeam("activity", null) {
            val (code, funnel) = failureOf("beacon", "ping")
            assertEquals("unsupported_platform", code)
            @Suppress("UNCHECKED_CAST")
            val data = funnel["data"] as? Map<String, Any?> ?: error("no data")
            assertEquals("activity", JSE.string(data["facet"]), "the FACET-shaped envelope, not the catalog one")
        }
        // …while from the facet it PROMISES, the same absence is prerequisites_missing.
        withSeam("app", null) {
            val (code, _) = failureOf("beacon", "ping")
            assertEquals("prerequisites_missing", code)
        }
        // A chain that IS registered here keeps answering unknown_action for a name it does
        // not register: the module is present, so that is a caller bug, never absence.
        withSeam("app", null) {
            assertEquals("unknown_action", failureOf("loc", "geofence").first)
        }
    }

    @Test
    fun aBuildFactStillBeatsARuntimeOne() {
        inlineExecutors()
        withExcludedOverlay(mapOf("quarantined" to mapOf("reason" to "excluded"))) {
            withSeam("app", null) {
                // `quarantined.ping` PROVIDES "app" — yet this build dropped the module, and
                // `excluded` (a build fact) outranks `prerequisites_missing` (a runtime one).
                val (code, funnel) = failureOf("quarantined", "ping")
                assertEquals("excluded", code)
                @Suppress("UNCHECKED_CAST")
                val data = funnel["data"] as? Map<String, Any?> ?: error("no data")
                assertEquals("excluded", JSE.string(data["reason"]), "the DespiaExcluded entry rides verbatim")
            }
        }
    }

    @Test
    fun theEmptySeamAnswersExactlyWhatTheFunnelAnsweredBefore() {
        // No facet word, no table, no transport: every facet rung is skipped and the
        // build-fact rungs are all that remain — unchanged from before the ladder existed.
        inlineExecutors(); ModuleRegistry.shared.register { LocMod() }
        assertNull(FacetSeam.facet)
        assertTrue(FacetSeam.rows.isEmpty())
        assertEquals("unknown_action", failureOf("loc", "geofence").first, "the module IS here")
        assertEquals("not_loaded", failureOf("ghost", "run").first)
        withExcludedOverlay(mapOf("quarantined" to mapOf("reason" to "excluded"))) {
            assertEquals("excluded", failureOf("quarantined", "ping").first)
        }
    }
}
