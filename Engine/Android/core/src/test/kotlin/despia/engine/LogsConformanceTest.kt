package despia.engine

import java.io.File
import java.util.concurrent.Executor
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The log-corpus conformance runner — executes OpenSource/Conformance/logs/logs.json
 * through THIS runtime's statement runner + log ring (the TS runner and the Swift
 * reference run the SAME file). The law under test (logs/README.md): `dsx.log` house
 * formatting + redaction, source-scheme attribution (markup / module handle / console.* /
 * the kernel `dsx.log` bus verb behind the page's `dsx.log`), and the log ring (cap 500).
 */
class LogsConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/logs/logs.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/logs/logs.json not found")
        }
    }

    private companion object {
        /** Constructor stash — the ErrorsConformanceTest discipline (Module.<init> resolves
         *  `scheme` before subclass properties assign; tests are single-threaded). */
        var pendingScheme = ""
        val emitters = HashMap<String, Module>()
    }

    private class LogModule : Module() {
        private var schemeName: String? = null
        override val scheme get() = schemeName ?: pendingScheme
        init { schemeName = pendingScheme }
        override fun setup() {}
    }

    /** A bare module whose dsx IS the module handle for `scheme` — the module-handle
     *  `dsx.log` form needs no registered actions, only a primary scheme. */
    private fun handleDsx(scheme: String): Context {
        emitters[scheme]?.let { return it.dsx }
        pendingScheme = scheme
        val mod = LogModule()
        ModuleRegistry.shared.register { mod }
        emitters[scheme] = mod
        return mod.dsx
    }

    private fun subset(actual: Any?, expected: Any?): Boolean = when (expected) {
        null, NSNull -> actual == null || actual == NSNull
        is Map<*, *> -> (actual as? Map<*, *>)?.let { a ->
            expected.entries.all { (k, v) -> subset(a[k], v) }
        } ?: false
        is List<*> -> (actual as? List<*>)?.takeIf { it.size == expected.size }
            ?.let { a -> expected.indices.all { subset(a[it], expected[it]) } } ?: false
        else -> JSE.equals(actual, expected)
    }

    private fun assertSubset(actual: Any?, expected: Any?, label: String) {
        assertTrue(subset(actual, expected), "$label: expected subset $expected — got $actual")
    }

    @TestFactory
    fun logsCorpus(): List<DynamicTest> {
        val doc = json(corpusFile().readText()).foundationValue as? Map<*, *>
            ?: error("logs.json: not a JSON object")
        @Suppress("UNCHECKED_CAST")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("logs.json: no cases[]")
        return cases.map { c ->
            val name = "logs-corpus/${c["name"]}"
            DynamicTest.dynamicTest(name) { runCase(name, c) }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun runCase(name: String, c: Map<String, Any?>) {
        ModuleRegistry.shared.mainExecutor = Executor { it.run() }
        JSERunner.mainExecutor = Executor { it.run() }
        JSERunner.backgroundExecutor = Executor { it.run() }

        val expect = (c["expect"] as? Map<String, Any?>) ?: emptyMap()
        val countBefore = DSXLogBuffer.shared.count()
        val callErrors = ArrayList<String>()
        var jseStore: StackStore? = null

        for (step in (c["steps"] as? List<Map<String, Any?>>) ?: emptyList()) {
            (step["jse"] as? Map<String, Any?>)?.let { j ->
                val store = StackStore()
                jseStore = store
                store.registerAction("corpuscase", emptyMap(), JSE.string(j["body"]))
                val runner = JSERunner(store, scope = j["scheme"] as? String)
                runner.run("corpuscase", null)
            }
            (step["log"] as? Map<String, Any?>)?.let { l ->
                val args = (l["args"] as? List<Any?>) ?: emptyList()
                handleDsx(JSE.string(l["scheme"])).log(*args.toTypedArray())
            }
            (step["logRepeat"] as? Map<String, Any?>)?.let { r ->
                val dsx = handleDsx(JSE.string(r["scheme"]))
                val count = (JSE.number(r["count"]) ?: 0.0).toInt()
                val prefix = JSE.string(r["prefix"])
                repeat(count) { i -> dsx.log("$prefix$i") }
            }
            (step["call"] as? Map<String, Any?>)?.let { k ->
                val callArgs = k["args"] as? Map<String, Any?>
                val caller = Module().dsx
                runBlocking {
                    try { caller.module[JSE.string(k["scheme"])][JSE.string(k["action"])](callArgs) }
                    catch (e: ModuleCallError) {
                        callErrors.add(when (e) {
                            is ModuleCallError.ActionFailed -> e.code
                            is ModuleCallError.NotLoaded -> "not_loaded"
                            is ModuleCallError.InvalidURI -> "invalid_uri"
                        })
                    }
                }
            }
        }

        (expect["logs"] as? List<Map<String, Any?>>)?.let { exp ->
            val appended = DSXLogBuffer.shared.count() - countBefore
            assertEquals(exp.size, appended, "$name: appended log entries")
            val tail = DSXLogBuffer.shared.recent().takeLast(appended)
            exp.forEachIndexed { i, e -> assertSubset(tail[i].wire(), e, "$name: logs[$i]") }
        }
        (expect["logCount"] as? Number)?.let {
            assertEquals(it.toInt(), DSXLogBuffer.shared.recent().size, "$name: retained log total")
        }
        (expect["logsTail"] as? List<Map<String, Any?>>)?.let { exp ->
            val tail = DSXLogBuffer.shared.recent().takeLast(exp.size)
            exp.forEachIndexed { i, e -> assertSubset(tail[i].wire(), e, "$name: logsTail[$i]") }
        }
        (expect["callErrors"] as? List<Any?>)?.let {
            assertEquals(it.map(JSE::string), callErrors, "$name: callErrors")
        }
        for ((path, exp) in (expect["jseStore"] as? Map<String, Any?>) ?: emptyMap()) {
            val store = jseStore ?: error("$name: no jse step ran")
            val actual = JSE.eval(path, store, null)
            assertSubset(if (actual == NSNull) null else actual, exp, "$name: jseStore $path")
        }
    }
}
