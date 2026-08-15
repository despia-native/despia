package despia.engine

import java.io.File
import java.util.concurrent.Executor
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The error-system conformance runner — executes OpenSource/Conformance/errors/errors.json
 * through THIS runtime's bus + ledger (the TS runner and the Swift reference run the SAME
 * file). The law under test (error-system.md, ACCEPTED v1): the ambient `dsx.error` hat
 * (repeatable, records + fans out, never unwinds), the ledger ring (cap 128), the
 * `module.error` / `module.callFailed` hooks, the page channel + reserved `dsx` mirror,
 * the reactive `global.dsx.*` keys, and hat isolation (terminal stays first-call-wins).
 */
class ErrorsConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/errors/errors.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/errors/errors.json not found")
        }
    }

    private companion object {
        /** Constructor stash: `Module.<init>` resolves `scheme` BEFORE a subclass's own
         *  constructor properties assign, so a corpus-driven (dynamic) scheme must be
         *  readable during that window. Tests are single-threaded; set right before
         *  construction via [corpusModule]. */
        var pendingScheme = ""
        var pendingTable: Map<String, Map<String, Any?>> = emptyMap()
    }

    /** Fixture module — action kinds per the corpus README (resolve / error / errorTwice).
     *  `Module.<init>` resolves `scheme` AND runs `setup()` before this subclass's own
     *  properties assign, so BOTH read the single-threaded companion stash (set immediately
     *  before construction by [corpusModule]). */
    private class CorpusModule : Module() {
        private var schemeName: String? = null
        override val scheme get() = schemeName ?: pendingScheme
        init { schemeName = pendingScheme }

        override fun setup() {
            for ((name, kind) in pendingTable) {
                val twice = kind["errorTwice"] as? List<*>
                val err = kind["error"] as? List<*>
                when {
                    twice != null -> dsx.action(name) { dsx ->
                        dsx.error(JSE.string(twice[0])); dsx.error(JSE.string(twice[1]))
                    }
                    err != null -> dsx.action(name) { dsx ->
                        dsx.error(JSE.string(err[0]), err.getOrNull(1))
                    }
                    else -> dsx.action(name) { dsx -> dsx.resolve(kind["resolve"]) }
                }
            }
        }
    }

    private fun corpusModule(scheme: String, table: Map<String, Map<String, Any?>> = emptyMap()): CorpusModule {
        pendingScheme = scheme
        pendingTable = table
        return CorpusModule()
    }

    /** The ONE registered harness observer (the registry is a process singleton — hooks are
     *  registered once; each case swaps the delegate lambdas in and out). */
    private object Harness : Module() {
        override val scheme get() = "errfx.harness"
        var onModuleError: ((Map<String, Any?>) -> Unit)? = null
        var onCallFailed: ((Map<String, Any?>) -> Unit)? = null
        override fun setup() {
            dsx.action("noop") { it.resolve() }
            dsx.delegate.listen("module.error") { input ->
                @Suppress("UNCHECKED_CAST") (input as? Map<String, Any?>)?.let { onModuleError?.invoke(it) }
                null
            }
            dsx.delegate.listen("module.callFailed") { input ->
                @Suppress("UNCHECKED_CAST") (input as? Map<String, Any?>)?.let { onCallFailed?.invoke(it) }
                null
            }
        }
        private var registered = false
        fun ensure() { if (!registered) { registered = true; ModuleRegistry.shared.register { this } } }
    }

    private val emitters = HashMap<String, Module>()

    /** The ambient handle for `scheme` — a fixtured module's dsx, or a bare registered one. */
    private fun emitterDsx(scheme: String): Context {
        emitters[scheme]?.let { return it.dsx }
        val mod = corpusModule(scheme)
        ModuleRegistry.shared.register { mod }
        emitters[scheme] = mod
        return mod.dsx
    }

    /** SUBSET match: every key in `expected` must match in `actual`; unlisted keys ignored;
     *  JSON null expects absent/null/NSNull; primitives compare JSE-loosely (1 == 1.0). */
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
    fun errorsCorpus(): List<DynamicTest> {
        val doc = json(corpusFile().readText()).foundationValue as? Map<*, *>
            ?: error("errors.json: not a JSON object")
        @Suppress("UNCHECKED_CAST")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("errors.json: no cases[]")
        return cases.map { c ->
            val name = "errors-corpus/${c["name"]}"
            DynamicTest.dynamicTest(name) { runCase(name, c) }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun runCase(name: String, c: Map<String, Any?>) {
        ModuleRegistry.shared.mainExecutor = Executor { it.run() }
        JSERunner.mainExecutor = Executor { it.run() }
        JSERunner.backgroundExecutor = Executor { it.run() }
        Harness.ensure()

        // TYPED ABSENCE (durability.md P4): seed the case's build-excluded overlay — the
        // DespiaExcluded shape, chain → { reason [, from, aliases] } — and reset to empty
        // when the case declares none, so overlay state never leaks between cases (the
        // registry is a process singleton; the `finally` below clears it for whatever
        // suite runs next in this JVM — ChainsConformanceTest.withExcludedOverlay's law).
        ModuleRegistry.shared.knownExcludedIdentities =
            ((c["excludedOverlay"] as? Map<String, Map<String, Any?>>) ?: emptyMap())
                .mapValues { (_, entry) -> entry.mapValues { JSE.string(it.value) } }

        for (reg in (c["register"] as? List<Map<String, Any?>>) ?: emptyList()) {
            val scheme = JSE.string(reg["scheme"])
            val mod = corpusModule(scheme, (reg["actions"] as? Map<String, Map<String, Any?>>) ?: emptyMap())
            ModuleRegistry.shared.register { mod }
            emitters[scheme] = mod
        }

        val expect = (c["expect"] as? Map<String, Any?>) ?: emptyMap()
        val countBefore = DSXErrorLedger.shared.count()
        val stateBefore = HashMap<String, Double>()
        for (path in ((expect["stateDelta"] as? Map<String, Any?>) ?: emptyMap()).keys) {
            stateBefore[path] = JSE.number(DSX.state.getPath(path)) ?: 0.0
        }
        val hooksExpected = (expect["hooks"] as? Map<String, List<Map<String, Any?>>>) ?: emptyMap()
        val hookSeen = HashMap<String, MutableList<Map<String, Any?>>>()
        var nestedProbe: Triple<String, String, String>? = null   // onCode, scheme, code
        Harness.onModuleError = { payload ->
            if (hooksExpected.containsKey("module.error")) {
                hookSeen.getOrPut("module.error") { ArrayList() }.add(payload)
            }
            nestedProbe?.let { (onCode, scheme, code) ->
                if (payload["code"] == onCode) {
                    nestedProbe = null   // once
                    emitterDsx(scheme).error(code)
                }
            }
        }
        Harness.onCallFailed = { payload ->
            if (hooksExpected.containsKey("module.callFailed")) {
                hookSeen.getOrPut("module.callFailed") { ArrayList() }.add(payload)
            }
        }
        val eventsExpected = (expect["events"] as? List<Map<String, Any?>>) ?: emptyList()
        val eventSchemes = eventsExpected.map { JSE.string(it["scheme"]) }.toSet()
        val eventSeen = ArrayList<Map<String, Any?>>()
        val mount = DSXMessenger().mount("errfx-observer") { egress ->
            val p = egress.payload
            if (p["event"] == "error" && eventSchemes.contains(p["scheme"])) {
                eventSeen.add(mapOf("scheme" to p["scheme"], "event" to p["event"], "data" to p["data"]))
            }
        }

        val callErrors = ArrayList<String>()
        var jseStore: StackStore? = null

        try {
            for (step in (c["steps"] as? List<Map<String, Any?>>) ?: emptyList()) {
                (step["emit"] as? Map<String, Any?>)?.let { e ->
                    (e["nestedEmitFromHook"] as? Map<String, Any?>)?.let { n ->
                        nestedProbe = Triple(JSE.string(e["code"]), JSE.string(n["scheme"]), JSE.string(n["code"]))
                    }
                    emitterDsx(JSE.string(e["scheme"])).fail(
                        JSE.string(e["code"]),
                        message = e["message"] as? String,
                        recoverable = e["recoverable"] == true,
                        data = e["data"])
                }
                (step["emitRepeat"] as? Map<String, Any?>)?.let { r ->
                    val dsx = emitterDsx(JSE.string(r["scheme"]))
                    val count = (JSE.number(r["count"]) ?: 0.0).toInt()
                    val prefix = JSE.string(r["codePrefix"])
                    repeat(count) { i -> dsx.error("$prefix$i") }
                }
                (step["jse"] as? Map<String, Any?>)?.let { j ->
                    val store = StackStore()
                    jseStore = store
                    store.registerAction("corpuscase", emptyMap(), JSE.string(j["body"]))
                    val runner = JSERunner(store, scope = j["scheme"] as? String)
                    runner.run("corpuscase", null)
                }
                (step["call"] as? Map<String, Any?>)?.let { k ->
                    val scheme = JSE.string(k["scheme"]); val action = JSE.string(k["action"])
                    val callArgs = k["args"] as? Map<String, Any?>
                    val caller = Module().dsx
                    if (k["mode"] == "post") {
                        try { caller.module[scheme][action].post(callArgs) } catch (_: ModuleCallError) {}
                    } else {
                        runBlocking {
                            try { caller.module[scheme][action](callArgs) } catch (e: ModuleCallError) {
                                callErrors.add(when (e) {
                                    is ModuleCallError.ActionFailed -> e.code
                                    is ModuleCallError.NotLoaded -> "not_loaded"
                                    is ModuleCallError.InvalidURI -> "invalid_uri"
                                })
                            }
                        }
                    }
                }
            }

            // ── assertions ──
            (expect["ledger"] as? List<Map<String, Any?>>)?.let { exp ->
                val appended = DSXErrorLedger.shared.count() - countBefore
                assertEquals(exp.size, appended, "$name: appended ledger entries")
                val tail = DSXErrorLedger.shared.recent().takeLast(appended)
                exp.forEachIndexed { i, e -> assertSubset(tail[i].wire(), e, "$name: ledger[$i]") }
            }
            (expect["ledgerCount"] as? Number)?.let {
                assertEquals(it.toInt(), DSXErrorLedger.shared.recent().size, "$name: retained ledger total")
            }
            (expect["ledgerTail"] as? List<Map<String, Any?>>)?.let { exp ->
                val tail = DSXErrorLedger.shared.recent().takeLast(exp.size)
                exp.forEachIndexed { i, e -> assertSubset(tail[i].wire(), e, "$name: ledgerTail[$i]") }
            }
            for ((hook, exp) in hooksExpected) {
                val seen = hookSeen[hook] ?: emptyList()
                assertEquals(exp.size, seen.size, "$name: $hook fire count")
                exp.forEachIndexed { i, e -> assertSubset(seen[i], e, "$name: $hook[$i]") }
            }
            if (eventsExpected.isNotEmpty()) {
                assertEquals(eventsExpected.size, eventSeen.size, "$name: page-channel deliveries")
                eventsExpected.forEachIndexed { i, e ->
                    assertEquals(JSE.string(e["scheme"]), eventSeen[i]["scheme"], "$name: events[$i].scheme")
                    assertSubset(eventSeen[i]["data"], e["data"], "$name: events[$i].data")
                }
            }
            for ((path, exp) in (expect["state"] as? Map<String, Any?>) ?: emptyMap()) {
                assertSubset(DSX.state.getPath(path), exp, "$name: state $path")
            }
            for ((path, delta) in (expect["stateDelta"] as? Map<String, Any?>) ?: emptyMap()) {
                val now = JSE.number(DSX.state.getPath(path)) ?: 0.0
                assertEquals((JSE.number(delta) ?: 0.0), now - stateBefore.getValue(path), "$name: stateDelta $path")
            }
            (expect["callErrors"] as? List<Any?>)?.let {
                assertEquals(it.map(JSE::string), callErrors, "$name: callErrors")
            }
            for ((path, exp) in (expect["jseStore"] as? Map<String, Any?>) ?: emptyMap()) {
                val store = jseStore ?: error("$name: no jse step ran")
                val actual = JSE.eval(path, store, null)
                assertSubset(if (actual == NSNull) null else actual, exp, "$name: jseStore $path")
            }
            for ((scheme, avail) in (expect["schemeAvailable"] as? Map<String, Any?>) ?: emptyMap()) {
                assertEquals(avail == true, ModuleRegistry.shared.isAvailable(scheme), "$name: schemeAvailable $scheme")
            }
        } finally {
            Harness.onModuleError = null
            Harness.onCallFailed = null
            ModuleRegistry.shared.knownExcludedIdentities = emptyMap()
            mount.unmount()
        }
    }
}
