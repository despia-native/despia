package despia.engine

import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The `<api>` block conformance runner — executes OpenSource/Conformance/api/
 * api-blocks.json through THIS runtime's ApiBlock (the TS kernel and the Swift twin run
 * the SAME file — /web/05 W5: fixtures first, every runtime codes toward them).
 * Deterministic by construction: seamed fetch (a response queue), injected clock, and
 * the sync JVM block (settle steps are no-ops here; the async races are the web unit
 * suite's job). Missing corpus = loud failure.
 */
class ApiConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/api/api-blocks.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/api/api-blocks.json not found")
        }
    }

    /** expected leaf values compare as ABSENT null (the corpus runner contract) */
    private fun unwrapNull(v: Any?): Any? = if (v == NSNull) null else v

    /** dotted-path read over a plain materialized-request value (no store involved) */
    private fun requestPath(value: Any?, path: String): Any? {
        var cur: Any? = value
        for (part in path.split(".")) {
            if (cur == null) return null
            cur = when {
                cur is List<*> && part == "length" -> cur.size.toDouble()
                cur is String && part == "length" -> cur.length.toDouble()
                cur is List<*> -> part.toIntOrNull()?.let { if (it in cur.indices) cur[it] else null }
                else -> (cur as? Map<*, *>)?.get(part)
            }
        }
        return cur
    }

    @TestFactory
    fun apiCorpus(): List<DynamicTest> {
        val doc = json(corpusFile().readText()).foundationValue as? Map<*, *>
            ?: error("api-blocks.json: not a JSON object")
        @Suppress("UNCHECKED_CAST")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("api-blocks.json: no cases[]")
        return cases.map { c ->
            val name = "api-corpus/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                ApiBlock.clearCache()
                // /web/11: a case declares EITHER one `spec` or an ORDERED `specs` list
                // (the dependency-graph cases) — one scope, one graph.
                @Suppress("UNCHECKED_CAST")
                val specsRaw = (c["specs"] as? List<Map<String, Any?>>)
                    ?: listOf((c["spec"] as? Map<String, Any?>) ?: emptyMap())
                val specs = specsRaw.map { raw -> raw.mapValues { JSE.string(it.value) } }
                @Suppress("UNCHECKED_CAST")
                val scope = (c["scope"] as? Map<String, Any?>) ?: emptyMap()
                @Suppress("UNCHECKED_CAST")
                val responses = ArrayDeque((c["responses"] as? List<Map<String, Any?>>) ?: emptyList())
                @Suppress("UNCHECKED_CAST")
                val responsesByUrl = ((c["responsesByUrl"] as? Map<String, Any?>) ?: emptyMap())
                    .mapValues { entry ->
                        @Suppress("UNCHECKED_CAST")
                        ArrayDeque((entry.value as? List<Map<String, Any?>>) ?: emptyList())
                    }
                val calls = ArrayList<String>()
                val bodies = ArrayList<Any?>()
                val requests = ArrayList<Map<String, Any?>>()
                val events = ArrayList<String>()
                var fakeNow = 1_000_000L

                val store = StackStore()
                scope.forEach { (k, v) -> store.vars[k] = v }

                // networking.md N0: seed the app-wide `dsx.const.*` plane (it rides the same
                // stateVars() app store as global/env). Saved/restored so the process-global
                // seam stays isolated between cases.
                @Suppress("UNCHECKED_CAST")
                val consts = HashMap<String, Any?>((c["consts"] as? Map<String, Any?>) ?: emptyMap())
                val savedStateVars = JSE.stateVars
                JSE.stateVars = { mapOf("const" to consts) }
                // networking.md N1: the component scope an <api>-in-a-component reads.
                @Suppress("UNCHECKED_CAST")
                val item = c["item"] as? Map<String, Any?>

                val fetch: (String, Map<String, Any?>) -> Map<String, Any?> = { url, req ->
                    calls.add(url)
                    bodies.add(req["body"])
                    requests.add(req)
                    (responsesByUrl[url]?.removeFirstOrNull() ?: responses.removeFirstOrNull())
                        ?: linkedMapOf("ok" to false, "status" to 0.0, "data" to null)
                }
                val blocks = LinkedHashMap<String, ApiBlock>()
                val make: () -> ApiBlock = {
                    blocks.clear()
                    val graph = ApiGraph(specs)
                    for (one in specs) {
                        blocks[one["as"] ?: "api"] = ApiBlock(
                            one, store, item, fetch, { fakeNow }, { n, _ -> events.add(n) },
                            graph = graph,
                        )
                    }
                    graph.start()
                    blocks.values.first()
                }
                val pick: (Any?) -> ApiBlock = { target ->
                    blocks[JSE.string(target)] ?: blocks.values.first()
                }
                var block = make()

                try {
                @Suppress("UNCHECKED_CAST")
                val steps = (c["steps"] as? List<Map<String, Any?>>) ?: emptyList()
                for (step in steps) {
                    @Suppress("UNCHECKED_CAST")
                    val set = step["set"] as? Map<String, Any?>
                    @Suppress("UNCHECKED_CAST")
                    val setConst = step["setConst"] as? Map<String, Any?>
                    when {
                        set != null -> {
                            DsxPaths.set(store, JSE.string(set["path"]), set["value"])
                            // the watch machinery's publish → every block re-materializes
                            for (b in blocks.values.toList()) b.storeChanged()
                        }
                        setConst != null -> {
                            consts[JSE.string(setConst["name"])] = setConst["value"]
                            for (b in blocks.values.toList()) b.storeChanged() // dsx.const reactivity
                        }
                        step["settle"] != null -> { /* sync runtime — nothing pending */ }
                        JSE.string(step["call"]) == "refresh" -> pick(step["target"]).refresh()
                        JSE.string(step["call"]) == "cancel" -> pick(step["target"]).cancel()
                        JSE.string(step["call"]) == "remount" -> {
                            for (b in blocks.values.toList()) b.dispose()
                            block = make()
                        }
                        step["send"] != null -> {
                            @Suppress("UNCHECKED_CAST")
                            val result = pick(step["target"]).send(step["send"] as? Map<String, Any?>)
                            // /web/11: the last send envelope is observable at `sendResult`
                            store.set("sendResult", result)
                        }
                        step["advance"] != null -> {
                            fakeNow += ((JSE.number(step["advance"]) ?: 0.0) * 1000).toLong()
                        }
                    }
                }

                @Suppress("UNCHECKED_CAST")
                val expect = (c["expect"] as? Map<String, Any?>) ?: emptyMap()
                for ((path, raw) in expect) {
                    val expected = unwrapNull(raw)
                    val actual = JSE.eval(path, store, null)
                    assertTrue(
                        JSE.equals(actual, expected),
                        "$name: $path -> ${JSE.string(actual)} (expected ${JSE.string(expected)})",
                    )
                }
                @Suppress("UNCHECKED_CAST")
                val expectCalls = ((c["expectCalls"] as? List<Any?>) ?: emptyList()).map { JSE.string(it) }
                assertEquals(expectCalls, calls, "$name: seam call urls")
                @Suppress("UNCHECKED_CAST")
                val expectBodies = c["expectBodies"] as? List<Any?>
                expectBodies?.forEachIndexed { i, b ->
                    assertTrue(JSE.equals(bodies.getOrNull(i), b), "$name: body[$i] -> ${JSE.string(bodies.getOrNull(i))}")
                }
                @Suppress("UNCHECKED_CAST")
                val expectRequests = c["expectRequests"] as? List<Any?>
                expectRequests?.forEachIndexed { i, raw ->
                    @Suppress("UNCHECKED_CAST")
                    val expectations = raw as? Map<String, Any?> ?: emptyMap()
                    for ((path, expected) in expectations) {
                        val actual = requestPath(requests.getOrNull(i), path)
                        assertTrue(
                            JSE.equals(actual, expected),
                            "$name: request[$i].$path -> ${JSE.string(actual)} (expected ${JSE.string(expected)})",
                        )
                    }
                }
                @Suppress("UNCHECKED_CAST")
                val expectEvents = ((c["expectEvents"] as? List<Any?>) ?: emptyList()).map { JSE.string(it) }
                assertEquals(expectEvents, events, "$name: event order")
                for (b in blocks.values.toList()) b.dispose()
                ApiBlock.clearCache()
                } finally {
                    JSE.stateVars = savedStateVars // isolate the app-wide const plane between cases
                }
            }
        }
    }
}
