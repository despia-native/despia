package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/**
 * The desktop input grammar conformance runner — executes
 * OpenSource/Conformance/input/{shortcut,focusOrder,multiline-submit}.json through THIS runtime's
 * StackDesktopInput. The TS twin (@despia-native/dom matchShortcut/resolveFocusOrder) and the Swift
 * reference (StackDesktopInput + the record lane) run the SAME files; the shared matcher is
 * what the Compose Desktop renderer binds its key events to, so the accelerators can't drift.
 *
 * Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
 */
class DesktopInputConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/input/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/input/$name not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun cases(name: String): List<Map<String, Any?>> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name version")
        return (root["cases"] as? List<*> ?: error("$name: no cases[]")).map { it as Map<String, Any?> }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun shortcutMatchingAgreesWithCorpus() {
        for (case in cases("shortcut.json")) {
            val name = case["name"] as? String ?: "?"
            val event = case["event"] as Map<String, Any?>
            val got = StackDesktopInput.matchesShortcut(
                case["shortcut"] as String,
                key = event["key"] as? String ?: "",
                meta = event["meta"] as? Boolean ?: false,
                ctrl = event["ctrl"] as? Boolean ?: false,
                alt = event["alt"] as? Boolean ?: false,
                shift = event["shift"] as? Boolean ?: false,
                editable = event["editable"] as? Boolean ?: false,
            )
            assertEquals(case["fires"] as Boolean, got, "shortcut/$name")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun multilineReturnAgreesWithCorpus() {
        val root = json(corpusFile("multiline-submit.json").readText())
            .foundationValue as Map<String, Any?>
        assertEquals(
            (root["returnKeys"] as List<*>).map { it.toString() }.toSet(),
            StackDesktopInput.RETURN_KEYS,
            "the Return spellings are a shared fact, not a per-toolkit guess",
        )
        for (case in cases("multiline-submit.json")) {
            val name = case["name"] as? String ?: "?"
            val event = case["event"] as Map<String, Any?>
            val got = StackDesktopInput.multilineReturn(
                key = event["key"] as? String ?: "",
                shift = event["shift"] as? Boolean ?: false,
                meta = event["meta"] as? Boolean ?: false,
                ctrl = event["ctrl"] as? Boolean ?: false,
                alt = event["alt"] as? Boolean ?: false,
                submitOnEnter = case["submitOnEnter"] as? Boolean ?: false,
                hasSubmit = case["hasSubmit"] as? Boolean ?: false,
            )
            assertEquals(case["expect"] as String, got, "multiline-submit/$name")
        }
    }

    @Test
    fun focusOrderResolutionAgreesWithCorpus() {
        for (case in cases("focusOrder.json")) {
            val name = case["name"] as? String ?: "?"
            val expected = (case["index"] as? Number)?.toInt()
            val got = StackDesktopInput.resolveFocusOrder(case["focusOrder"] as? String, case["disabled"] as? Boolean ?: false)
            assertEquals(expected, got, "focusOrder/$name")
        }
    }
}
