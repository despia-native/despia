package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The connectivity conformance runner - executes
 * OpenSource/Conformance/net/{status,transitions}.json through THIS runtime's NetCore fold and
 * NetDebounce machine (parity/F05-net.md). The TS twin (@despia/kernel net-core.ts,
 * net-conformance.test.ts) and the Swift reference (NetConformance) run the SAME files, so a
 * captive portal, a personal hotspot and a flapping interface cannot mean one thing on one
 * renderer and something else on another.
 *
 * Missing corpus = loud failure, and so is an empty section: a runner that reads three of five
 * case arrays is the same defect as a corpus nobody runs.
 */
class NetConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/net/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/net/$name not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(root: Map<String, Any?>, name: String, file: String): List<Map<String, Any?>> {
        val raw = root[name]
        val rows = (raw as? List<Any?>) ?: ((raw as? Map<String, Any?>)?.get("cases") as? List<Any?>)
        val cases = rows?.map { it as Map<String, Any?> }
        assertTrue(cases != null && cases.isNotEmpty(), "$file: $name must be a non-empty case array")
        return cases!!
    }

    private fun bool(value: Any?): Boolean = value == true

    @Test
    @Suppress("UNCHECKED_CAST")
    fun classifyAgreesWithCorpus() {
        for (case in section(root("status.json"), "classify", "status.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val actual = NetCore.classify(
                satisfied = bool(given["satisfied"]),
                interfaces = (given["interfaces"] as? List<Any?>)?.map { it as String } ?: emptyList(),
                transports = (given["transports"] as? List<Any?>)?.map { it as String } ?: emptyList(),
                metered = bool(given["metered"]),
                dataSaver = bool(given["dataSaver"]),
            )
            assertEquals(expect["reachable"], actual.reachable, "$name: reachable")
            assertEquals(expect["type"], actual.type, "$name: type")
            assertEquals(expect["expensive"], actual.expensive, "$name: expensive")
            assertEquals(expect["constrained"], actual.constrained, "$name: constrained")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun onlineSplitAgreesWithCorpus() {
        for (case in section(root("status.json"), "online", "status.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val reachable = bool(given["reachable"])
            val snapshot = NetSnapshot(reachable, if (reachable) "wifi" else "none", false, false)
            assertEquals(
                (case["expect"] as Map<String, Any?>)["online"],
                NetCore.online(snapshot, bool(given["probeFailed"])),
                "$name: online",
            )
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun generationAgreesWithCorpus() {
        for (case in section(root("status.json"), "generation", "status.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            assertEquals(
                (case["expect"] as Map<String, Any?>)["generation"],
                NetCore.generation(given["type"] as String, given["radio"] as? String),
                "$name: generation",
            )
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun probeVerdictAgreesWithCorpus() {
        for (case in section(root("status.json"), "probe", "status.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            assertEquals(
                (case["expect"] as Map<String, Any?>)["reachable"],
                NetCore.probeReachable(
                    (given["status"] as Number).toInt(),
                    given["requestHost"] as? String,
                    given["location"] as? String,
                ),
                "$name: reachable",
            )
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun debounceTimelinesAgreeWithCorpus() {
        val doc = root("transitions.json")
        val debounceMs = (doc["debounceMs"] as? Number)?.toLong() ?: error("transitions.json: no debounceMs")

        for (timeline in section(doc, "timelines", "transitions.json")) {
            val name = timeline["name"] as? String ?: "<unnamed>"
            val steps = (timeline["steps"] as? List<Any?>)?.map { it as Map<String, Any?> }
                ?: error("$name: no steps")
            assertTrue(steps.isNotEmpty(), "$name: no steps")

            val machine = NetDebounce(debounceMs)
            val emitted = ArrayList<Map<String, Any?>>()

            for (step in steps) {
                val at = (step["at"] as Number).toLong()
                machine.advance(at)
                val path = step["path"] as? Map<String, Any?>
                if (path != null) {
                    machine.path(at, NetSnapshot(
                        reachable = bool(path["reachable"]),
                        type = path["type"] as String,
                        expensive = bool(path["expensive"]),
                        constrained = bool(path["constrained"]),
                    ))
                } else if (step.containsKey("probeFailed")) {
                    machine.probe(at, bool(step["probeFailed"]))
                }
                for (change in machine.drain()) {
                    emitted.add(mapOf(
                        "at" to change.at,
                        "event" to "change",
                        "data" to mapOf(
                            "online" to change.online,
                            "reachable" to change.snapshot.reachable,
                            "type" to change.snapshot.type,
                            "expensive" to change.snapshot.expensive,
                            "constrained" to change.snapshot.constrained,
                            "previous" to change.previous,
                        ),
                    ))
                }
            }

            val expect = timeline["expect"] as Map<String, Any?>
            val expectedEvents = (expect["events"] as List<Any?>).map { row ->
                val event = row as Map<String, Any?>
                val data = event["data"] as Map<String, Any?>
                mapOf(
                    "at" to (event["at"] as Number).toLong(),
                    "event" to event["event"],
                    "data" to mapOf(
                        "online" to data["online"],
                        "reachable" to data["reachable"],
                        "type" to data["type"],
                        "expensive" to data["expensive"],
                        "constrained" to data["constrained"],
                        "previous" to data["previous"],
                    ),
                )
            }
            assertEquals(expectedEvents, emitted.toList(), "$name: events")

            val context = expect["context"] as Map<String, Any?>
            assertEquals(context["online"], machine.online, "$name: context.online")
            assertEquals(context["type"], machine.settled.type, "$name: context.type")
            assertEquals(context["expensive"], machine.settled.expensive, "$name: context.expensive")
            assertEquals(context["constrained"], machine.settled.constrained, "$name: context.constrained")
        }
    }
}
