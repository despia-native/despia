//
//  RootPlanConformanceTest.kt — the SHARED root-plan corpus
//  (OpenSource/Conformance/router/root-plan.json) through the REAL Kotlin fold
//  (RootPlan.Fold). The corpus `_note` is the contract; this harness implements its
//  deterministic virtual-clock simulation exactly like the TS runner
//  (packages/dom/test/router-conformance.test.ts): attempt 0 mounts at t=0, attempt
//  N+1 at the instant N fails, deadline = mountAt + timeoutMs, a live attempt whose
//  deadline ≤ the next event's atMs times out FIRST, and after the last event a
//  still-live attempt times out at its deadline. Swift's RootPlanConformance is the
//  reference twin.
//

package despia.engine

import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RootPlanConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/router/root-plan.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("root-plan corpus not found")
        }
    }

    private class Timer(val at: Long, val fire: () -> Unit) { var cancelled = false }

    @TestFactory
    fun rootPlanCorpus(): List<DynamicTest> {
        val doc = json(corpusFile().readText()).foundationValue as? Map<*, *>
            ?: error("root-plan corpus is not an object")
        val cases = doc["cases"] as? List<*> ?: error("root-plan corpus has no cases")
        assertTrue(cases.isNotEmpty(), "root-plan corpus is empty")

        return cases.map { raw ->
            val case = raw as Map<*, *>
            DynamicTest.dynamicTest("root-plan/${case["name"]}") { runCase(case) }
        }
    }

    private fun runCase(case: Map<*, *>) {
        val components = (case["components"] as List<*>).map { it as String }
        val expect = case["expect"] as Map<*, *>

        var now = 0L
        val timers = mutableListOf<Timer>()
        val fired = mutableListOf<String>()
        val payloads = mutableListOf<Map<String, Any?>>()
        val mountedAttrs = mutableMapOf<String, Map<String, Any?>>()
        var sawDiagnostic = false

        val plan = AppManifest.normalizeSurfaces(case["surfaces"] as List<*>)

        // ── the normalized plan pins (expect.normalized) ──
        val expNorm = (expect["normalized"] as List<*>).map { it as Map<*, *> }
        assertEquals(expNorm.size, plan.size, "normalized count")
        for (i in plan.indices) {
            assertEquals(expNorm[i]["view"], plan[i].view, "normalized[$i].view")
            assertEquals(expNorm[i]["id"], plan[i].id, "normalized[$i].id")
            assertEquals((expNorm[i]["timeoutMs"] as Number).toInt(), plan[i].timeoutMs, "normalized[$i].timeoutMs")
            val expConfig = (expNorm[i]["config"] as? Map<*, *>) ?: emptyMap<Any?, Any?>()
            assertEquals(expConfig, plan[i].config, "normalized[$i].config")
        }

        val host = object : RootPlan.Host {
            override fun mount(candidate: AppManifest.Entry.Surface, index: Int) {
                @Suppress("UNCHECKED_CAST")
                mountedAttrs[candidate.id] = candidate.config as Map<String, Any?>
            }
            override fun now(): Long = now
            override fun setTimer(ms: Long, fire: () -> Unit): () -> Unit {
                val t = Timer(now + ms, fire)
                timers.add(t)
                return { t.cancelled = true }
            }
            override fun fire(event: String, payload: Map<String, Any?>) {
                fired.add(event)
                payloads.add(mapOf<String, Any?>("event" to event) + payload)
            }
            override fun registered(view: String): Boolean = components.contains(view)
            override fun diagnostic(ledger: List<RootPlan.Attempt>) { sawDiagnostic = true }
        }

        val fold = RootPlan.Fold(plan, host, "web")
        fold.start()

        fun nextTimer(): Timer? = timers.filter { !it.cancelled }.minByOrNull { it.at }
        fun runTimersThrough(limit: Long) {
            while (true) {
                val t = nextTimer() ?: return
                if (t.at > limit) return
                now = t.at
                t.cancelled = true
                t.fire()
            }
        }

        val ordered = (case["events"] as List<*>).map { it as Map<*, *> }
            .sortedBy { (it["atMs"] as Number).toLong() }
        for (e in ordered) {
            val at = (e["atMs"] as Number).toLong()
            runTimersThrough(at)   // a deadline ≤ the event's atMs fires FIRST
            now = maxOf(now, at)
            val attempt = (e["attempt"] as? Number)?.toInt()
            when (e["kind"]) {
                "settle" -> fold.settle(attempt)
                "error" -> fold.rootError(e["code"] as? String ?: "error", e["origin"] as? String ?: "root", attempt)
            }
        }
        runTimersThrough(Long.MAX_VALUE)   // the fold always terminates

        val attempts = payloads.filter { it["event"] == "root.failed" || it["event"] == "root.ready" }
            .map { it["id"] as String }
        val failures = payloads.filter { it["event"] == "root.failed" }
            .map { mapOf<String, Any?>("id" to it["id"], "code" to ((it["error"] as Map<*, *>)["code"])) }
        val ready = payloads.firstOrNull { it["event"] == "root.ready" }?.get("id") as String?

        assertEquals((expect["attempts"] as List<*>).map { it as String }, attempts, "attempt order")
        val expFailures = (expect["failures"] as List<*>).map { f ->
            val o = f as Map<*, *>
            mapOf<String, Any?>("id" to o["id"], "code" to o["code"])
        }
        assertEquals(expFailures, failures, "failures")
        assertEquals(expect["ready"] as String?, ready, "ready")
        assertEquals((expect["fired"] as List<*>).map { it as String }, fired, "fired order")
        assertEquals(expect["diagnostic"] as Boolean, sawDiagnostic, "diagnostic")
        if (expect.containsKey("winnerView")) assertEquals(expect["winnerView"], fold.winner?.view, "winnerView")
        (expect["mountedAttrs"] as? Map<*, *>)?.forEach { (id, attrs) ->
            assertEquals(attrs, mountedAttrs[id], "mountedAttrs[$id]")
        }
        assertEquals(expFailures.map { it["id"] }, fold.ledger.map { it.id }, "ledger mirrors failures")
    }
}
