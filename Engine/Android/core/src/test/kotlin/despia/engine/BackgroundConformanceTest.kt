package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The background-task conformance runner - executes
 * OpenSource/Conformance/background/{declaration,constraints,budget}.json through THIS
 * runtime's BackgroundPlan (parity/F08-background.md). The TS twin (@despia/kernel
 * background.ts, background-conformance.test.ts) and the Swift reference (Engine/iOS
 * BackgroundPlan) run the SAME files, so a declared task cannot mean one thing on one
 * renderer and something else on another: the same clamp, the same constraint translation,
 * the same budget, and the same honest run record when the OS kills the process mid-flight.
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
 */
class BackgroundConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/background/$name.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/background/$name.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name.json version")
        return root
    }

    private fun strings(value: Any?): List<String> =
        (value as? List<Any?>)?.map { it as String } ?: emptyList()

    @Suppress("UNCHECKED_CAST")
    private fun stringMap(value: Any?): Map<String, String> =
        (value as? Map<String, Any?>)?.entries?.associate { (k, v) -> k to (v as String) } ?: emptyMap()

    @Test
    fun vocabularyAgreesWithCorpus() {
        val doc = root("declaration")
        assertEquals(strings(doc["kinds"]), BackgroundPlan.KINDS, "kinds")
        assertEquals(strings(doc["requirements"]), BackgroundPlan.REQUIREMENTS, "requirements")
        assertEquals(strings(doc["buckets"]), BackgroundPlan.BUCKETS, "buckets")
        assertEquals(
            (doc["periodicFloorSeconds"] as Number).toInt(), BackgroundPlan.PERIODIC_FLOOR_SECONDS,
            "periodic floor",
        )
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun declarationFoldAgreesWithCorpus() {
        val cases = root("declaration")["declare"] as? List<Map<String, Any?>>
            ?: error("declaration.json: no declare[]")
        assertTrue(cases.isNotEmpty(), "declare corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val row = (case["row"] as? Map<String, Any?>)?.entries
                ?.associate { (k, v) -> k to (v as? String) } ?: emptyMap()
            val result = BackgroundPlan.resolveTask(
                case["id"] as? String, row, strings(case["declaredActions"]),
            )
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")

            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertTrue(result.isFailure, "$name: expected refusal $expectedError, got ${result.getOrNull()}")
                val failure = result.exceptionOrNull() as? BackgroundPlan.RefusalError
                assertEquals(expectedError, BackgroundPlan.code(failure!!.refusal), "$name: refusal code")
                continue
            }

            assertTrue(result.isSuccess, "$name: expected a resolved task, got ${result.exceptionOrNull()?.message}")
            val task = result.getOrThrow()
            assertEquals(case["id"] as String, task.id, "$name: id")
            assertEquals(expect["action"] as String, task.action, "$name: action")
            assertEquals(expect["kind"] as String, task.kind, "$name: kind")
            assertEquals(
                (expect["minIntervalSeconds"] as Number).toInt(), task.minIntervalSeconds,
                "$name: minIntervalSeconds",
            )
            assertEquals(expect["clamped"] as Boolean, task.clamped, "$name: clamped")
            assertEquals(strings(expect["requires"]), task.requires, "$name: requires")
            assertEquals(expect["expedited"] as Boolean, task.expedited, "$name: expedited")
            assertEquals(expect["bucket"] as String, task.bucket, "$name: bucket")
            assertTrue(task.bucket in BackgroundPlan.BUCKETS, "$name: bucket is one of the fixed five")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun constraintTranslationAgreesWithCorpus() {
        val rows = root("constraints")["map"] as? List<Map<String, Any?>>
            ?: error("constraints.json: no map[]")
        assertEquals(BackgroundPlan.REQUIREMENTS.size, rows.size, "every requirement is mapped")
        for (row in rows) {
            val requirement = row["requirement"] as String
            val folded = BackgroundPlan.constraints(listOf(requirement))
            assertEquals(stringMap(row["ios"]), folded.ios, "$requirement: iOS constraints")
            assertEquals(stringMap(row["android"]), folded.android, "$requirement: Android constraints")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun constraintFoldAgreesWithCorpus() {
        val cases = root("constraints")["fold"] as? List<Map<String, Any?>>
            ?: error("constraints.json: no fold[]")
        assertTrue(cases.isNotEmpty(), "fold corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val folded = BackgroundPlan.constraints(strings(case["requires"]))
            assertEquals(stringMap(case["ios"]), folded.ios, "$name: iOS")
            assertEquals(stringMap(case["android"]), folded.android, "$name: Android")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun constraintSatisfactionAgreesWithCorpus() {
        val cases = root("constraints")["satisfy"] as? List<Map<String, Any?>>
            ?: error("constraints.json: no satisfy[]")
        assertTrue(cases.isNotEmpty(), "satisfy corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val stateRow = case["state"] as? Map<String, Any?> ?: emptyMap()
            val state = BackgroundPlan.DeviceState(
                network = stateRow["network"] as? String ?: "none",
                charging = stateRow["charging"] as? Boolean ?: false,
                batteryLow = stateRow["batteryLow"] as? Boolean ?: false,
                storageLow = stateRow["storageLow"] as? Boolean ?: false,
                idle = stateRow["idle"] as? Boolean ?: false,
            )
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val unmet = BackgroundPlan.unmet(strings(case["requires"]), state)
            assertEquals(strings(expect["unmet"]), unmet, "$name: unmet")
            assertEquals(expect["satisfied"] as Boolean, unmet.isEmpty(), "$name: satisfied")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun budgetCountdownAgreesWithCorpus() {
        val doc = root("budget")
        val budgets = (doc["budgets"] as? Map<String, Any?>)?.entries
            ?.associate { (k, v) -> k to (v as Number).toLong() } ?: emptyMap()
        assertEquals(budgets, BackgroundPlan.BUDGET_MS, "budgets")

        val cases = doc["countdown"] as? List<Map<String, Any?>> ?: error("budget.json: no countdown[]")
        assertTrue(cases.isNotEmpty(), "countdown corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val budget = BackgroundPlan.budget(
                case["platform"] as String, (case["elapsedMs"] as Number).toLong(),
            )
            assertEquals((expect["remainingMs"] as Number).toLong(), budget.remainingMs, "$name: remainingMs")
            assertEquals(expect["expired"] as Boolean, budget.expired, "$name: expired")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun runRecordAgreesWithCorpus() {
        val cases = root("budget")["record"] as? List<Map<String, Any?>> ?: error("budget.json: no record[]")
        assertTrue(cases.isNotEmpty(), "record corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val record = BackgroundPlan.runRecord(strings(case["events"]))
            assertEquals(expect["result"] as String, record.result, "$name: result")
            assertEquals(expect["failure"] as Boolean, record.failure, "$name: failure")
            assertEquals(expect["running"] as Boolean, record.running, "$name: running")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun debugGateAgreesWithCorpus() {
        val cases = root("budget")["debugGate"] as? List<Map<String, Any?>>
            ?: error("budget.json: no debugGate[]")
        assertTrue(cases.isNotEmpty(), "debugGate corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val allowed = BackgroundPlan.runAllowed(case["channel"] as? String)
            assertEquals(expect["allowed"] as Boolean, allowed, "$name: allowed")
            if (expect["allowed"] == false) {
                assertEquals("debug_only", expect["error"] as String, "$name: the refusal is typed")
            }
        }
    }
}
