package despia.engine

import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import java.util.concurrent.Executor
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The action/workflow conformance runner — executes OpenSource/Conformance/actions/actions.json
 * through THIS runtime's JSERunner (the TS runner and the Swift reference run the SAME file).
 * DSX actions ARE workflows: they chain, call each other with args, sequence, branch, loop, and
 * emit events; recursion is depth-capped at 32 (bounded, never a hang). Synchronous grammar only,
 * so every runtime is deterministic. Missing corpus = loud failure.
 */
class ActionConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/actions/actions.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/actions/actions.json not found")
        }
    }

    private fun nil(v: Any?): Any? = if (v == NSNull) null else v

    @TestFactory
    fun actionCorpus(): List<DynamicTest> {
        val doc = json(corpusFile().readText()).foundationValue as? Map<*, *>
            ?: error("actions.json: not a JSON object")
        @Suppress("UNCHECKED_CAST")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("actions.json: no cases[]")
        return cases.map { c ->
            val name = "action-corpus/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                JSERunner.mainExecutor = Executor { it.run() }
                JSERunner.backgroundExecutor = Executor { it.run() }

                val store = StackStore()
                @Suppress("UNCHECKED_CAST")
                val scope = (c["scope"] as? Map<String, Any?>) ?: emptyMap()
                scope.forEach { (k, v) -> store.vars[k] = v }

                @Suppress("UNCHECKED_CAST")
                val actions = (c["actions"] as? Map<String, Map<String, Any?>>) ?: emptyMap()
                for ((actionName, decl) in actions) {
                    @Suppress("UNCHECKED_CAST")
                    val inputs = ((decl["inputs"] as? Map<String, Any?>) ?: emptyMap())
                        .mapValues { JSE.string(it.value) }
                    store.registerAction(actionName, inputs, JSE.string(decl["body"]))
                }

                val events = ArrayList<String>()
                store.anyHandlers.add { evName, _ -> events.add(evName) }

                val runner = JSERunner(store)
                @Suppress("UNCHECKED_CAST")
                val runItem = c["runItem"] as? Map<String, Any?>
                runner.run(JSE.string(c["run"]), runItem)

                @Suppress("UNCHECKED_CAST")
                val expectStore = (c["expectStore"] as? Map<String, Any?>) ?: emptyMap()
                for ((path, expected) in expectStore) {
                    val actual = JSE.eval(path, store, null)
                    assertTrue(
                        JSE.equals(nil(actual), nil(expected)),
                        "$name: $path -> ${JSE.string(actual)} (expected ${JSE.string(expected)})",
                    )
                }
                @Suppress("UNCHECKED_CAST")
                val expectEvents = ((c["expectEvents"] as? List<Any?>) ?: emptyList()).map { JSE.string(it) }
                assertEquals(expectEvents, events, "$name: event order")
            }
        }
    }
}
