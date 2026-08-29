package despia.engine

import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import java.util.concurrent.Executor
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The watch-dispatch conformance runner — executes
 * OpenSource/Conformance/actions/watch-dispatch.json through THIS runtime's dispatch funnel:
 * the WatchView evaluate loop (Compose StackNodeView.WatchView — evaluate `value`, compare
 * JSE.watchKey, fire on meaningful change, never on subscribe) feeding the REAL
 * `JSERunner.fireWatch` (payload rule + budget + afterRender dispatch). The TS harness
 * (watch-conformance.test.ts, store.watch → ActionRunner) and the Swift reference
 * (WatchConformance, ConformanceHosts.swift, record lane) run the SAME file.
 *
 * Pinned after the W12 stale-snapshot investigation: a watch handler observes the POST-WRITE
 * store — `run(change, payload, payload)` executes against the live shared store, so every
 * store read inside the handler sees the state that triggered the fire. (The filed 2026-08-17
 * starter toggle revert was the wave-7 F4 entity lexing assigning 0 through this path, never
 * a snapshot — jse/syntax-006 pins the decode, the corpus's entity-spelled row pins the hold.)
 *
 * The evaluate loop here is the :core stand-in for recomposition: after the bound-control
 * `pre` writes and after the entry, re-evaluate every watch and fire the changed ones until a
 * quiet round (bounded — corpus rows are synchronous, matching the natives' settled-fire
 * timing; fire COUNT within one multi-write entry stays unpinned by the corpus).
 */
class WatchConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/actions/watch-dispatch.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/actions/watch-dispatch.json not found")
        }
    }

    private fun nil(v: Any?): Any? = if (v == NSNull) null else v

    @TestFactory
    fun watchCorpus(): List<DynamicTest> {
        val doc = json(corpusFile().readText()).foundationValue as? Map<*, *>
            ?: error("watch-dispatch.json: not a JSON object")
        @Suppress("UNCHECKED_CAST")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("watch-dispatch.json: no cases[]")
        return cases.map { c ->
            val name = "watch-corpus/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                JSERunner.mainExecutor = Executor { it.run() }
                JSERunner.backgroundExecutor = Executor { it.run() }
                // The app-wide plane: DSX.state is a process singleton — bind the boot seam,
                // snapshot + restore its vars so `global.*` writes stay isolated per case.
                val savedStateVars = JSE.stateVars
                val savedDispatch = JSE.afterRenderDispatch
                val savedState = HashMap(DSX.state.vars)
                JSE.stateVars = { DSX.state.vars }
                JSE.afterRenderDispatch = { it() }
                try {
                    DSX.state.vars.clear()
                    @Suppress("UNCHECKED_CAST")
                    val globalSeed = (c["global"] as? Map<String, Any?>) ?: emptyMap()
                    globalSeed.forEach { (k, v) -> DSX.state.vars[k] = v }

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

                    // Subscribe: evaluate once, record the key, NEVER fire (no corpus row
                    // declares `immediate` — the WatchView prev==null arm).
                    @Suppress("UNCHECKED_CAST")
                    val watches = (c["watches"] as? List<Map<String, Any?>>) ?: emptyList()
                    val exprs = watches.map { JSE.string(it["value"]) }
                    val handlers = watches.map { JSE.string(it["handler"]) }
                    val last = exprs.map { JSE.watchKey(JSE.eval(it, store, null)) }.toMutableList()

                    // One recomposition settle: re-evaluate every watch, fire the meaningfully
                    // changed ones through the REAL dispatch funnel, repeat until quiet.
                    fun settle() {
                        for (round in 0 until 32) {
                            var fired = false
                            for (i in exprs.indices) {
                                val v = JSE.eval(exprs[i], store, null)
                                val key = JSE.watchKey(v)
                                if (key != last[i]) {
                                    last[i] = key
                                    fired = true
                                    runner.fireWatch(v, handlers[i], exprs[i])
                                }
                            }
                            if (!fired) break
                        }
                    }

                    @Suppress("UNCHECKED_CAST")
                    val pre = (c["pre"] as? List<Map<String, Any?>>) ?: emptyList()
                    for (p in pre) store.writeBound(JSE.string(p["path"]), p["value"] ?: NSNull)
                    settle()

                    @Suppress("UNCHECKED_CAST")
                    val runItem = c["runItem"] as? Map<String, Any?>
                    runner.run(JSE.string(c["run"]), runItem)
                    settle()

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
                    val expectGlobal = (c["expectGlobal"] as? Map<String, Any?>) ?: emptyMap()
                    for ((path, expected) in expectGlobal) {
                        val actual = DSX.state.getPath(path)
                        assertTrue(
                            JSE.equals(nil(actual), nil(expected)),
                            "$name: global.$path -> ${JSE.string(actual)} (expected ${JSE.string(expected)})",
                        )
                    }
                    @Suppress("UNCHECKED_CAST")
                    val expectEvents = ((c["expectEvents"] as? List<Any?>) ?: emptyList()).map { JSE.string(it) }
                    assertEquals(expectEvents, events, "$name: event order")
                } finally {
                    DSX.state.vars.clear()
                    DSX.state.vars.putAll(savedState)
                    JSE.stateVars = savedStateVars
                    JSE.afterRenderDispatch = savedDispatch
                }
            }
        }
    }
}
