package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The SNACKBAR conformance runner — executes OpenSource/Conformance/overlays/snackbar.json
 * through this runtime (the TS and Swift runners run the SAME file). The law and the reasoning
 * are in that corpus's README.
 *
 * The rule worth restating: `show` resolves on OUTCOME, so every card must settle EXACTLY ONCE.
 * A card that never settles is a leaked promise; one that settles twice is a double undo.
 *
 * Missing corpus = loud failure; a silently-skipped conformance suite is how drift starts.
 */
class SnackbarConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/overlays/snackbar.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/overlays/snackbar.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(name: String): List<Map<String, Any?>> {
        val doc = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("snackbar.json: not a JSON object")
        return (doc[name] as? List<*> ?: error("snackbar.json: no $name"))
            .map { it as Map<String, Any?> }
    }

    private fun int(any: Any?): Int = when (any) {
        is Number -> any.toInt()
        else -> error("expected a number, got $any")
    }

    @Test
    fun durationCorpus() {
        val cases = section("durationCases")
        assertTrue(cases.isNotEmpty(), "durationCases is empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "(unnamed)"
            val got = SnackbarQueue.resolveDuration(case["duration"], case["hasAction"] as? Boolean ?: false)
            assertEquals(int(case["expect"]), got, name)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun queueCorpus() {
        val cases = section("queueCases")
        assertTrue(cases.isNotEmpty(), "queueCases is empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "(unnamed)"
            var state = SnackbarState()
            for (rawOp in case["ops"] as List<Map<String, Any?>>) {
                state = SnackbarQueue.applyOp(state, opFrom(rawOp))
            }
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["current"] as? String, state.current?.id, "$name — current")
            assertEquals(
                (expect["pending"] as List<*>).map { it as String },
                state.queue.map { it.id },
                "$name — pending",
            )
            assertEquals(
                (expect["settled"] as List<*>).map { it as Map<String, Any?> }
                    .map { (it["id"] as String) to (it["result"] as String) },
                state.settled.map { it.id to it.result.word },
                "$name — settled",
            )
            assertEquals(state.queue.size, state.pending, "$name — pending count")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun opFrom(raw: Map<String, Any?>): SnackbarOp {
        val id = raw["id"] as? String
        return when (raw["op"] as? String) {
            "show" -> {
                val action = (raw["action"] as? Map<String, Any?>)?.let {
                    SnackbarAction(it["label"] as? String ?: "", it["id"] as? String ?: "")
                }
                // The corpus omits `message` where it does not matter; the reducer treats an empty
                // message as a no-op, so the runner supplies the id as the text unless a case is
                // deliberately testing emptiness.
                SnackbarOp.Show(
                    SnackbarRequest(
                        id = id ?: "",
                        message = raw["message"] as? String ?: (id ?: "x"),
                        action = action,
                        duration = raw["duration"],
                        tone = raw["tone"] as? String,
                        icon = raw["icon"] as? String,
                        position = raw["position"] as? String,
                        dismissible = raw["dismissible"] as? Boolean,
                        replace = raw["replace"] as? Boolean ?: false,
                    ),
                )
            }
            "elapse" -> SnackbarOp.Elapse
            "action" -> SnackbarOp.Action
            "dismiss" -> SnackbarOp.Dismiss
            "hide" -> SnackbarOp.Hide(id)
            else -> error("unknown op ${raw["op"]}")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun liftCorpus() {
        val cases = section("liftCases")
        assertTrue(cases.isNotEmpty(), "liftCases is empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "(unnamed)"
            val lift = case["lift"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val got = SnackbarQueue.resolveLift(
                SnackbarQueue.Chrome(
                    position = lift["position"] as? String,
                    safeAreaTop = int(lift["safeAreaTop"]),
                    safeAreaBottom = int(lift["safeAreaBottom"]),
                    bottomBar = int(lift["bottomBar"]),
                    fab = int(lift["fab"]),
                    keyboard = int(lift["keyboard"]),
                ),
            )
            assertEquals(expect["edge"] as String, got.edge.word, "$name — edge")
            assertEquals(int(expect["inset"]), got.inset, "$name — inset")
            assertEquals(expect["clearsHomeIndicator"] as Boolean, got.clearsHomeIndicator, "$name — clearsHomeIndicator")
        }
    }

    @Test
    fun durationParsingIsTotal() {
        for (junk in listOf(null, "", "   ", "soon", "NaN", true, emptyList<String>())) {
            assertEquals(SnackbarQueue.DEFAULT_MS, SnackbarQueue.resolveDuration(junk), "junk: $junk")
            assertEquals(SnackbarQueue.SHORT_MS, SnackbarQueue.resolveDuration(junk, true), "junk: $junk")
        }
        for (bad in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            assertEquals(SnackbarQueue.DEFAULT_MS, SnackbarQueue.resolveDuration(bad), "bad: $bad")
        }
        assertEquals(SnackbarQueue.MIN_MS, SnackbarQueue.resolveDuration(-1_000_000))
    }

    @Test
    fun theCardNeverCoversTheHomeIndicator() {
        val values = listOf(-10_000, -1, 0, 12, 34, 400, 10_000)
        for (safeBottom in values) {
            for (keyboard in values) {
                for (bar in listOf(0, 49, -49)) {
                    val got = SnackbarQueue.resolveLift(
                        SnackbarQueue.Chrome(
                            position = "bottom", safeAreaTop = 47, safeAreaBottom = safeBottom,
                            bottomBar = bar, fab = 0, keyboard = keyboard,
                        ),
                    )
                    val safe = if (safeBottom > 0) safeBottom else 0
                    assertTrue(got.inset >= safe + SnackbarQueue.GAP, "inset ${got.inset} sits on the home indicator")
                    assertTrue(got.clearsHomeIndicator, "clearsHomeIndicator went false")
                }
            }
        }
    }

    @Test
    fun oneAtATimeAndTheQueueDrainsInOrder() {
        var state = SnackbarState()
        val ids = listOf("a", "b", "c", "d", "e")
        for (id in ids) state = SnackbarQueue.applyOp(state, SnackbarOp.Show(SnackbarRequest(id = id, message = id)))
        assertEquals("a", state.current?.id)
        assertEquals(4, state.pending)
        val seen = mutableListOf<String>()
        repeat(ids.size) {
            seen.add(state.current?.id ?: "")
            state = SnackbarQueue.applyOp(state, SnackbarOp.Elapse)
        }
        assertEquals(ids, seen)
        assertNull(state.current)
        assertEquals(ids.map { SnackbarResult.TIMEOUT }, state.settled.map { it.result })
    }

    @Test
    fun everyCardSettlesExactlyOnce() {
        var state = SnackbarState()
        state = SnackbarQueue.applyOp(
            state,
            SnackbarOp.Show(SnackbarRequest(id = "a", message = "a", action = SnackbarAction("Undo", "u"))),
        )
        state = SnackbarQueue.applyOp(state, SnackbarOp.Show(SnackbarRequest(id = "b", message = "b")))
        for (op in listOf(SnackbarOp.Action, SnackbarOp.Action, SnackbarOp.Dismiss, SnackbarOp.Elapse, SnackbarOp.Hide())) {
            state = SnackbarQueue.applyOp(state, op)
        }
        assertEquals(mapOf("a" to 1, "b" to 1), state.settled.groupingBy { it.id }.eachCount())
    }

    @Test
    fun anActionButtonWithNoLabelIsNotAnActionButton() {
        val entry = SnackbarQueue.normalize(
            SnackbarRequest(id = "a", message = "m", action = SnackbarAction("", "u")),
        )
        assertNull(entry.action)
        assertEquals(SnackbarQueue.DEFAULT_MS, entry.durationMs, "no action means the wordless default stays 2s")
    }
}
