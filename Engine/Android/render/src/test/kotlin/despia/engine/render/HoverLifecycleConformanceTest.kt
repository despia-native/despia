//
// HoverLifecycleConformanceTest.kt — Kotlin consumer of the shared renderer-neutral
// OpenSource/Conformance/input/hover.json contract. This drives the exact state machine
// used by StackNodeView's Compose pointer adapter, not a test-only duplicate.
//

package despia.engine.render

import despia.engine.json
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HoverLifecycleConformanceTest {
    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/input/hover.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile
                ?: error("OpenSource/Conformance/input/hover.json not found walking up from ${System.getProperty("user.dir")}")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun sharedHoverLifecycleCorpus() {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("hover.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt())
        val cases = root["cases"] as? List<Map<String, Any?>> ?: error("hover.json: no cases[]")
        assertTrue("hover corpus must not be empty", cases.isNotEmpty())

        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val hover = HoverLifecycle()
            val actions = ArrayList<String>()
            for (event in case["events"] as? List<Map<String, Any?>> ?: emptyList()) {
                val emitted = when (event["type"] as? String) {
                    "enter" -> hover.enter(
                        event["pointer"] as? String ?: "",
                        event["kind"] as? String ?: "unknown",
                        event["hoverCapable"] as? Boolean ?: false,
                    )
                    "leave" -> hover.leave(event["pointer"] as? String ?: "")
                    "cancel" -> hover.cancel(event["pointer"] as? String ?: "")
                    "unmount" -> hover.unmount()
                    else -> error("hover/$name: unknown event ${event["type"]}")
                }
                actions.addAll(emitted.map { it.wireName })
            }

            val expected = (case["expect"] as? List<*>)?.map { it as String } ?: emptyList()
            val expectedActive = (case["expectActive"] as? List<*>)?.map { it as String } ?: emptyList()
            assertEquals("hover/$name actions", expected, actions)
            assertEquals("hover/$name active pointers", expectedActive.toSet(), hover.activePointers)
        }
    }
}
