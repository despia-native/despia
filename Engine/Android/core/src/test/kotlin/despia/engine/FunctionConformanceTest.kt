package despia.engine

import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import java.util.concurrent.Executor
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The global-function-library corpus — executes OpenSource/Conformance/functions/functions.json
 * through THIS runtime (TS twin: function-conformance.test.ts; the Swift reference is the
 * Stack.swift head mount + JSE.registerGlobalFunctions, record-lane execution pending — the
 * actions-corpus arrangement). Each case mounts its `blocks` IN DOCUMENT ORDER through the
 * :core head seam (StackStore.registerHeadFunctions — global:true rides the `global` attr,
 * the `<functions global="true">` head block), then runs the actions-corpus contract:
 * run / expectStore / expectEvents. The global table clears between cases (the app-reload
 * contract; it is process-static by design — dynamic tests clear EXPLICITLY at entry because
 * JUnit lifecycle callbacks wrap the factory, not each dynamic case).
 */
class FunctionConformanceTest {

    @AfterTest fun clearGlobals() { JSE.clearGlobalFunctions() }

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/functions/functions.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/functions/functions.json not found")
        }
    }

    private fun nil(v: Any?): Any? = if (v == NSNull) null else v

    @TestFactory
    fun functionCorpus(): List<DynamicTest> {
        val doc = json(corpusFile().readText()).foundationValue as? Map<*, *>
            ?: error("functions.json: not a JSON object")
        @Suppress("UNCHECKED_CAST")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("functions.json: no cases[]")
        return cases.map { c ->
            val name = "function-corpus/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                JSE.clearGlobalFunctions()
                JSERunner.mainExecutor = Executor { it.run() }
                JSERunner.backgroundExecutor = Executor { it.run() }

                val store = StackStore()
                @Suppress("UNCHECKED_CAST")
                val scope = (c["scope"] as? Map<String, Any?>) ?: emptyMap()
                scope.forEach { (k, v) -> store.vars[k] = v }

                // the head blocks, in document order — `<functions>` / `<functions global="true">`
                @Suppress("UNCHECKED_CAST")
                val blocks = (c["blocks"] as? List<Map<String, Any?>>) ?: emptyList()
                for (b in blocks) {
                    val attrs = if (b["global"] == true) mapOf("global" to "true") else emptyMap()
                    store.registerHeadFunctions(attrs, JSE.string(b["body"]))
                }

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

    @Test
    fun headMarkupMountsThroughTheSeam() {
        // `<functions global="true">` in real markup: parse with the ONE parser, walk the
        // head, route each block through the seam — the renderer head-dispatch shape
        // (StackNodeView's "script","functions" case grows the same one-line routing).
        val root = StackXML.parse(
            "<vstack><head>" +
                "<functions global=\"true\">function gk(n) { return n * 3 }</functions>" +
                "<functions>function lk(n) { return n < 4 ? n + 1 : 0 }</functions>" +
                "</head><text value=\"x\"/></vstack>",
        ) ?: error("markup did not parse")
        val store = StackStore()
        val head = root.children.first { it.tag == "head" }
        for (child in head.children) {
            if (child.tag == "functions" || child.tag == "script") {
                store.registerHeadFunctions(child.attrs, child.text ?: "")
            }
        }
        assertEquals(9.0, JSE.eval("gk(3)", store, null))          // global: this surface…
        assertEquals(9.0, JSE.eval("gk(3)", StackStore(), null))   // …and every OTHER surface
        assertEquals(4.0, JSE.eval("lk(3)", store, null))          // surface-local: this one
        assertEquals(0.0, JSE.eval("lk(4)", store, null))          // raw `<` in functions survived parsing
        assertNull(nil(JSE.eval("lk(3)", StackStore(), null)))     // …and ONLY this one
    }
}
