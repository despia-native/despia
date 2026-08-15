package despia.engine

import java.io.File
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The SCREEN-LIFECYCLE conformance runner — both halves of
 * `OpenSource/Conformance/lifecycle/`, executed against THIS runtime.
 *
 *  • `readiness.json` (17 rows) drives the real kernel reporter `ScreenReadiness` — the native
 *    frame state machine behind `viewStart` / `viewFinish` (default settle-on-first-render,
 *    opt-in defer, once-per-frame, release/re-mount).
 *  • `phase.json` (15 rows) drives the COORDINATOR translation — `dom*` (web) and `view*`
 *    (native) → the unified `screen.loading` / `screen.ready` fires + `global.screen.phase` /
 *    `global.screen.ready` — through a REAL `Module` on the REAL `ModuleRegistry` bus.
 *
 * DIVERGENCE, documented (the honest limit of this lane): the coordinator SHIPS as the closed
 * `Mandatory/Lifecycle/kotlin/Lifecycle.kt` module, which :core cannot see (the open drop builds
 * without ClosedSource — settings.gradle.kts). So `phase.json` runs against a bus-registered twin
 * declared below, and `lifecycleModuleHasNotDrifted` is the anti-drift gate: it reads the real
 * module's source when the closed drop is present beside the open one and asserts the contract
 * this twin encodes (the five watched names, the two-tag app-surface guard, the url→path→string route
 * fallback). Swift runs the same two files through `ConformanceHosts`; TS through
 * `packages/kernel/src/screen.ts`.
 *
 * Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
 */
class ScreenReadinessTest {

    // MARK: - corpus loading

    private fun corpus(name: String): Map<String, Any?> {
        val file = File("../../../Conformance/lifecycle/$name")
        assertTrue(file.isFile, "missing corpus ${file.absolutePath}")
        @Suppress("UNCHECKED_CAST")
        return json(file.readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")
    }

    @Suppress("UNCHECKED_CAST")
    private fun cases(name: String): List<Map<String, Any?>> =
        (corpus(name)["cases"] as? List<Any?> ?: error("$name: no cases"))
            .map { it as Map<String, Any?> }

    private fun int(v: Any?): Int = (v as? Number)?.toInt() ?: error("expected a number, got $v")

    // MARK: - readiness.json — the native reporter state machine

    /// Every armed bounded deadline of the row under test, in arming order — the corpus drives the
    /// `deadline` step directly, so the real clock is stubbed out and this list is what proves the
    /// MACHINE (not the call site) arms one timer per frame instance at the pinned delay.
    private val armed = ArrayList<Long>()
    private var cancelled = 0

    private fun stubDeadlineClock() {
        armed.clear()
        cancelled = 0
        ScreenReadiness.scheduleDeadline = { ms, _ ->
            armed.add(ms)
            val cancel: () -> Unit = { cancelled += 1 }
            cancel
        }
    }

    @BeforeEach fun resetReporter() {
        ScreenReadiness.resetForTesting()
        stubDeadlineClock()
    }

    @AfterEach fun restoreReporterSeam() {
        ScreenReadiness.resetForTesting()
        ScreenReadiness.emit = { name, payload -> ModuleRegistry.shared.dispatch(name, payload, combine = ModuleRegistry.Combine.void) }
        ScreenReadiness.scheduleDeadline = ScreenReadiness.defaultScheduleDeadline
    }

    @Test fun nativeReadinessMatchesTheSharedConformanceCorpus() {
        val rows = cases("readiness.json")
        assertEquals(38, rows.size, "readiness.json row count drifted")
        for (case in rows) {
            val name = case["name"] as String
            ScreenReadiness.resetForTesting()
            stubDeadlineClock()
            val fired = ArrayList<Triple<String, Int, String?>>()
            ScreenReadiness.emit = { event, payload ->
                fired.add(Triple(event, int(payload["frame"]), payload["path"] as? String))
            }
            @Suppress("UNCHECKED_CAST")
            for (raw in (case["steps"] as List<Any?>)) {
                val step = raw as Map<String, Any?>
                when (val verb = step["do"] as String) {
                    "mount" -> ScreenReadiness.mount(int(step["frame"]), step["path"] as? String,
                                                     step["surface"] as? String ?: "native")
                    "manual" -> ScreenReadiness.manual(int(step["frame"]))
                    "hostsWeb" -> ScreenReadiness.hostsWeb(int(step["frame"]))
                    "rendered" -> ScreenReadiness.rendered(int(step["frame"]))
                    "settled" -> ScreenReadiness.settled(int(step["frame"]))
                    "deadline" -> ScreenReadiness.deadline(int(step["frame"]))
                    "release" -> ScreenReadiness.release(int(step["frame"]))
                    "webStart" -> ScreenReadiness.webStart()
                    "webSettled" -> ScreenReadiness.webSettled()
                    else -> error("$name: unknown step verb $verb")
                }
            }
            @Suppress("UNCHECKED_CAST")
            val expect = (case["expect"] as List<Any?>).map { raw ->
                val e = raw as Map<String, Any?>
                Triple(e["event"] as String, int(e["frame"]), e["path"] as? String)
            }
            assertEquals(expect, fired.toList(), name)
            @Suppress("UNCHECKED_CAST")
            val pending = (case["expectPending"] as? List<Any?> ?: emptyList()).map { int(it) }
            assertEquals(pending, ScreenReadiness.pendingFrames, "$name (pending frames)")
            // one armed deadline per tracked frame INSTANCE (1:1 with `viewStart`), at the pinned delay
            val starts = fired.count { it.first == "surface.viewStart" }
            assertEquals(List(starts) { ScreenReadiness.SETTLE_DEADLINE_MS }, armed.toList(),
                         "$name (deadlines armed)")
        }
    }

    @Test fun theBoundedDeadlineIsTheCorpusValueAndSettlesTheFrameItself() {
        assertEquals((corpus("readiness.json")["settleDeadlineMs"] as Number).toLong(),
                     ScreenReadiness.SETTLE_DEADLINE_MS,
                     "SETTLE_DEADLINE_MS drifted from readiness.json")

        var elapse: (() -> Unit)? = null
        var cancels = 0
        ScreenReadiness.scheduleDeadline = { _, fire ->
            elapse = fire
            val cancel: () -> Unit = { cancels += 1 }
            cancel
        }
        val fired = ArrayList<String>()
        ScreenReadiness.emit = { event, _ -> fired.add(event) }

        // a `settle="manual"` screen that never reports: the armed timer is what settles it
        ScreenReadiness.mount(1, "/orders", "native")
        ScreenReadiness.manual(1)
        ScreenReadiness.rendered(1)
        assertEquals(listOf("surface.viewStart"), fired.toList(), "a manual screen must not settle on render")
        val fireDeadline = elapse ?: error("mount must arm the bounded deadline")
        fireDeadline()
        assertEquals(listOf("surface.viewStart", "surface.viewFinish"), fired.toList(),
                     "the elapsed deadline must settle the frame (fail-open)")
        assertEquals(emptyList(), ScreenReadiness.pendingFrames)

        // a frame that settles (or leaves) normally spends its timer instead of leaking it
        ScreenReadiness.resetForTesting()
        cancels = 0
        ScreenReadiness.mount(2, "/", "native")
        ScreenReadiness.rendered(2)
        assertEquals(1, cancels, "a settled frame must cancel its deadline")
        ScreenReadiness.mount(3, "/", "native")
        ScreenReadiness.release(3)
        assertEquals(2, cancels, "a released frame must cancel its deadline")
    }

    @Test fun payloadCarriesTheNativeSurfaceTagAndOmitsAnAbsentPath() {
        val seen = ArrayList<Pair<String, Map<String, Any?>>>()
        ScreenReadiness.emit = { event, payload -> seen.add(event to payload) }
        ScreenReadiness.mount(7, null, "native")
        ScreenReadiness.rendered(7)
        assertEquals(listOf("surface.viewStart", "surface.viewFinish"), seen.map { it.first })
        for ((_, payload) in seen) {
            assertEquals("native", payload["surface"])
            assertEquals(7, payload["frame"])
            assertTrue("path" !in payload.keys, "a routeless frame must omit `path` (phase.json: null input)")
        }
    }

    // MARK: - phase.json — the coordinator translation

    /**
     * A bus-registered twin of `Mandatory/Lifecycle/kotlin/Lifecycle.kt` — the coordinator whose
     * translation `phase.json` is the law for. Hook bodies, guard and route fallback are the
     * module's verbatim; `lifecycleModuleHasNotDrifted` pins that equivalence.
     */
    private class LifecycleCoordinatorTwin : Module() {
        override val registersWithoutScheme get() = true

        override fun setup() {
            dsx.delegate.listen("surface.domStart") { input ->
                if (!isAppSurface(input)) return@listen null
                publish("loading", ready = false, frame = reportFrame(input)); dsx.delegate.send("screen.loading", routeString(input), combine = ModuleRegistry.Combine.void); null
            }
            dsx.delegate.listen("surface.domFinish") { input ->
                if (!isAppSurface(input)) return@listen null
                publish("ready", ready = true, frame = reportFrame(input)); dsx.delegate.send("screen.ready", routeString(input), combine = ModuleRegistry.Combine.void); null
            }
            dsx.delegate.listen("surface.domFail") { input ->
                if (!isAppSurface(input)) return@listen null
                publish("ready", ready = true, frame = reportFrame(input)); dsx.delegate.send("screen.ready", routeString(input), combine = ModuleRegistry.Combine.void); null
            }
            dsx.delegate.listen("surface.viewStart") { input ->
                if (!isAppSurface(input)) return@listen null
                publish("loading", ready = false, frame = reportFrame(input)); dsx.delegate.send("screen.loading", routeString(input), combine = ModuleRegistry.Combine.void); null
            }
            dsx.delegate.listen("surface.viewFinish") { input ->
                if (!isAppSurface(input)) return@listen null
                publish("ready", ready = true, frame = reportFrame(input)); dsx.delegate.send("screen.ready", routeString(input), combine = ModuleRegistry.Combine.void); null
            }
        }

        private fun publish(phase: String, ready: Boolean, frame: Int?) {
            dsx.global.set("screen.frame", frame)
            dsx.global.set("screen.phase", phase)
            dsx.global.set("screen.ready", ready)
        }

        private companion object {
            @Suppress("UNCHECKED_CAST")
            fun isAppSurface(input: Any?): Boolean {
                val tag = (input as? Map<String, Any?>)?.get("surface") as? String ?: "web"
                return tag == "web" || tag == "native"
            }

            @Suppress("UNCHECKED_CAST")
            fun routeString(input: Any?): String? {
                val map = input as? Map<String, Any?>
                return (map?.get("url") as? String) ?: (map?.get("path") as? String) ?: input as? String
            }

            @Suppress("UNCHECKED_CAST")
            fun reportFrame(input: Any?): Int? = (input as? Map<String, Any?>)?.get("frame") as? Int
        }
    }

    /** Captures the UNIFIED vocabulary the consumers hook — the only thing packages ever see. */
    private class ScreenFireCapture(val fires: MutableList<Pair<String, Any?>>) : Module() {
        override val registersWithoutScheme get() = true
        override fun setup() {
            dsx.delegate.listen("screen.loading") { input -> fires.add("screen.loading" to input); null }
            dsx.delegate.listen("screen.ready") { input -> fires.add("screen.ready" to input); null }
        }
    }

    @Test fun screenPhaseTranslationMatchesTheSharedConformanceCorpus() {
        val rows = cases("phase.json")
        assertEquals(15, rows.size, "phase.json row count drifted")
        for (case in rows) {
            val name = case["name"] as String
            // The registry is a process singleton — reset so the twin is the ONLY coordinator on
            // the bus for this row (the RouterTest `_resetForTests` precedent).
            ModuleRegistry.shared._resetForTests()
            val fires = ArrayList<Pair<String, Any?>>()
            ModuleRegistry.shared.register { LifecycleCoordinatorTwin() }
            ModuleRegistry.shared.register { ScreenFireCapture(fires) }

            @Suppress("UNCHECKED_CAST")
            val seed = (case["seedState"] as? Map<String, Any?>)?.get("screen") as? Map<String, Any?>
            DSX.state.set("screen", seed ?: emptyMap<String, Any?>())

            @Suppress("UNCHECKED_CAST")
            for (raw in (case["steps"] as List<Any?>)) {
                val step = raw as Map<String, Any?>
                ModuleRegistry.shared.dispatch(step["fire"] as String, step["input"], combine = ModuleRegistry.Combine.void)
            }

            @Suppress("UNCHECKED_CAST")
            val expect = (case["expect"] as List<Any?>).map { raw ->
                val e = raw as Map<String, Any?>
                (e["fire"] as String) to e["input"]
            }
            assertEquals(expect, fires.toList(), name)

            @Suppress("UNCHECKED_CAST")
            val expectState = case["expectState"] as? Map<String, Any?> ?: emptyMap()
            for ((key, value) in expectState) {
                val actual = DSX.state.getPath(key)
                if (value == null) assertEquals(null, actual, "$name ($key)")
                else assertEquals(normalize(value), normalize(actual), "$name ($key)")
            }
        }
        ModuleRegistry.shared._resetForTests()
        DSX.state.set("screen", emptyMap<String, Any?>())
    }

    /** JSON numbers arrive as Double; state carries what the writer wrote. Compare by value. */
    private fun normalize(v: Any?): Any? = if (v is Number && v !is Double) v.toDouble() else v

    /**
     * ANTI-DRIFT gate for the twin above. The real coordinator lives in the closed drop; when it
     * is present beside the open one, pin the contract `phase.json` encodes so a change to the
     * module can never silently pass this suite. Skipped (not failed) on an open-only checkout —
     * the corpus itself is still executed there.
     */
    @Test fun lifecycleModuleHasNotDrifted() {
        val module = File("../../../../ClosedSource/DSX/Modules/Mandatory/Lifecycle/kotlin/Lifecycle.kt")
        if (!module.isFile) return                       // open-only drop: nothing to compare against
        val src = module.readText()
        val watched = Regex("""dsx\.delegate\.listen\("([^"]+)"\)""")
            .findAll(src).map { it.groupValues[1] }.toSet()
        assertEquals(setOf("surface.domStart", "surface.domFinish", "surface.domFail", "surface.viewStart", "surface.viewFinish"), watched,
                     "Lifecycle.kt watched-event set drifted from phase.json")
        assertTrue("""tag == "web" || tag == "native"""" in src,
                   "Lifecycle.kt app-surface guard must accept BOTH web and native (phase.json)")
        assertTrue("routeString" in src && "urlString" !in src,
                   "Lifecycle.kt must use routeString (url ?? path ?? string), not the web-only urlString")
        assertTrue(Regex("""get\("url"\).*\?:.*get\("path"\)""", RegexOption.DOT_MATCHES_ALL).containsMatchIn(src),
                   "Lifecycle.kt routeString must prefer `url` over `path` (phase.json)")
        assertTrue("""dsx.global.set("screen.frame"""" in src && "reportFrame" in src,
                   "Lifecycle.kt must publish screen.frame — the report identity the root plan binds (phase.json rule 5)")
    }
}
