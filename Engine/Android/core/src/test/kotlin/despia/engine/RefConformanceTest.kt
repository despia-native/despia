package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The `ref=` conformance runner - executes OpenSource/Conformance/input/ref.json through THIS
 * runtime's StackRef + RefRegistry. The TS twin (@despia-native/kernel ref.ts) and the Swift twin run
 * the SAME file, so a recycled list row cannot keep a ref alive on one renderer and drop it on
 * another.
 */
class RefConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val c = File(dir, "OpenSource/Conformance/input/ref.json")
            if (c.isFile) return c
            dir = dir.parentFile ?: error("OpenSource/Conformance/input/ref.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(name: String): List<Map<String, Any?>> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("ref.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "ref.json version")
        return (root[name] as? List<Map<String, Any?>>)?.also {
            assertTrue(it.isNotEmpty(), "$name must not be empty")
        } ?: error("ref.json: no $name[]")
    }

    private class View(val id: Int)

    @Suppress("UNCHECKED_CAST")
    private fun runSteps(steps: List<Map<String, Any?>>): List<Any?> {
        val reg = RefRegistry<View>()
        val views = HashMap<Int, View>()
        fun viewFor(n: Int) = views.getOrPut(n) { View(n) }
        return steps.map { s ->
            val v = viewFor((s["view"] as? Number)?.toInt() ?: 1)
            when {
                s["appear"] != null -> { reg.provide(s["appear"] as String, v); null }
                s["disappear"] != null -> { reg.clear(s["disappear"] as String, v); null }
                s["collect"] != null -> { reg.collect(s["collect"] as String); null }
                s["resolve"] != null -> if (reg.resolve(s["resolve"] as String) != null) "live" else StackRef.UNKNOWN
                s["resolveView"] != null -> reg.resolve(s["resolveView"] as String)?.id
                else -> error("step names no operation")
            }
        }
    }

    @Test
    fun keyDerivationAgreesWithCorpus() {
        for (case in section("keys")) {
            val name = case["name"] as? String ?: "<unnamed>"
            assertEquals(case["expect"] as String?, StackRef.key(case["ref"] as? String), name)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun lifecycleAgreesWithCorpus() {
        for (case in section("lifecycle")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = (case["expect"] as List<Any?>).map { it }
            assertEquals(expect, runSteps(case["steps"] as List<Map<String, Any?>>), name)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun recyclingAgreesWithCorpus() {
        for (case in section("reuse")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = (case["expect"] as List<Any?>).map { (it as? Number)?.toInt() ?: it }
            assertEquals(expect, runSteps(case["steps"] as List<Map<String, Any?>>), name)
        }
    }
}
