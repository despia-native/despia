package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The tooltip grammar conformance runner — executes
 * OpenSource/Conformance/input/tooltip.json through THIS runtime's StackTooltip fold and
 * StackTooltipLifecycle state machine (design-system.md Wave 3 (c)1). The TS twin
 * (@despia-native/dom resolveTooltip/TooltipLifecycle, tooltip.test.ts) and the Swift reference
 * (StackTooltip + the record lane) run the SAME file, so the universal hint attribute
 * cannot drift between renderers: touch never reveals, Escape dismisses, and a resolved
 * tooltip always doubles as the element's accessibility description.
 *
 * Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
 */
class TooltipConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/input/tooltip.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/input/tooltip.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(): Map<String, Any?> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("tooltip.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "tooltip.json version")
        return root
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun resolveAgreesWithCorpus() {
        val cases = root()["resolve"] as? List<Map<String, Any?>> ?: error("tooltip.json: no resolve[]")
        assertTrue(cases.isNotEmpty(), "resolve corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val got = StackTooltip.resolve(case["tooltip"] as? String, case["tooltipSide"] as? String)
            val expect = case["expect"] as? Map<String, Any?>
            if (expect == null) {
                assertNull(got, "tooltip/$name")
            } else {
                assertNotNull(got, "tooltip/$name")
                assertEquals(expect["text"] as? String, got.text, "tooltip/$name text")
                assertEquals(expect["side"] as? String, got.side, "tooltip/$name side")
                assertEquals(true, expect["described"], "tooltip/$name: a resolved tooltip must describe its element")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun lifecycleAgreesWithCorpus() {
        val cases = root()["lifecycle"] as? List<Map<String, Any?>> ?: error("tooltip.json: no lifecycle[]")
        assertTrue(cases.isNotEmpty(), "lifecycle corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val machine = StackTooltipLifecycle()
            val actions = mutableListOf<String>()
            for (event in case["events"] as? List<Map<String, Any?>> ?: emptyList()) {
                val capable = event["hoverCapable"] as? Boolean ?: false
                actions += when (val type = event["type"] as? String) {
                    "hoverStart" -> machine.hoverStart(capable)
                    "hoverEnd" -> machine.hoverEnd()
                    "focus" -> machine.focus(capable)
                    "blur" -> machine.blur()
                    "escape" -> machine.escape()
                    "unmount" -> machine.unmount()
                    else -> error("tooltip/$name: unknown event $type")
                }
            }
            assertEquals(case["expect"] as? List<String> ?: emptyList<String>(), actions, "tooltip/$name")
            assertEquals(case["expectVisible"] as? Boolean ?: false, machine.visible, "tooltip/$name visible")
        }
    }
}
