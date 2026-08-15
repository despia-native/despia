package despia.engine

import java.util.PriorityQueue
import java.util.concurrent.Callable
import java.util.concurrent.Delayed
import java.util.concurrent.Future
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/// Conformance tests for JSERunner — behavior pinned to Engine/Stack.swift §JSERunner
/// (lines ~1581–3356). Timers ride a VIRTUAL scheduler (no real sleeps); every async seam
/// defaults inline, so each test is deterministic.
class JseRunnerTest {

    // ── a manual/virtual ScheduledExecutorService (deterministic time) ──────────────────

    private class VirtualScheduler : ScheduledExecutorService {
        var now = 0L
        private var seq = 0L
        private class Task(val at: Long, val seq: Long, val r: Runnable)
        private val queue = PriorityQueue<Task>(compareBy({ it.at }, { it.seq }))

        fun advance(ms: Long) {
            val target = now + ms
            while (true) {
                val t = queue.peek() ?: break
                if (t.at > target) break
                queue.poll()
                now = t.at
                t.r.run()
            }
            now = target
        }

        private class StubFuture : ScheduledFuture<Any?> {
            override fun getDelay(unit: TimeUnit) = 0L
            override fun compareTo(other: Delayed) = 0
            override fun cancel(mayInterruptIfRunning: Boolean) = false
            override fun isCancelled() = false
            override fun isDone() = true
            override fun get(): Any? = null
            override fun get(timeout: Long, unit: TimeUnit): Any? = null
        }

        override fun schedule(command: Runnable, delay: Long, unit: TimeUnit): ScheduledFuture<*> {
            queue.add(Task(now + unit.toMillis(delay), seq++, command))
            return StubFuture()
        }
        override fun <V> schedule(callable: Callable<V>, delay: Long, unit: TimeUnit): ScheduledFuture<V> =
            throw UnsupportedOperationException()
        override fun scheduleAtFixedRate(command: Runnable, initialDelay: Long, period: Long, unit: TimeUnit): ScheduledFuture<*> =
            throw UnsupportedOperationException()
        override fun scheduleWithFixedDelay(command: Runnable, initialDelay: Long, delay: Long, unit: TimeUnit): ScheduledFuture<*> =
            throw UnsupportedOperationException()
        override fun execute(command: Runnable) { command.run() }
        override fun shutdown() {}
        override fun shutdownNow(): MutableList<Runnable> = ArrayList()
        override fun isShutdown() = false
        override fun isTerminated() = false
        override fun awaitTermination(timeout: Long, unit: TimeUnit) = true
        override fun <T> submit(task: Callable<T>): Future<T> = throw UnsupportedOperationException()
        override fun <T> submit(task: Runnable, result: T): Future<T> = throw UnsupportedOperationException()
        override fun submit(task: Runnable): Future<*> = throw UnsupportedOperationException()
        override fun <T> invokeAll(tasks: MutableCollection<out Callable<T>>): MutableList<Future<T>> =
            throw UnsupportedOperationException()
        override fun <T> invokeAll(tasks: MutableCollection<out Callable<T>>, timeout: Long, unit: TimeUnit): MutableList<Future<T>> =
            throw UnsupportedOperationException()
        override fun <T> invokeAny(tasks: MutableCollection<out Callable<T>>): T = throw UnsupportedOperationException()
        override fun <T> invokeAny(tasks: MutableCollection<out Callable<T>>, timeout: Long, unit: TimeUnit): T =
            throw UnsupportedOperationException()
    }

    // ── fixtures + seam reset ───────────────────────────────────────────────────────────

    private lateinit var store: StackStore
    private lateinit var runner: JSERunner
    private lateinit var clock: VirtualScheduler

    @BeforeTest fun setUp() {
        store = StackStore()
        runner = JSERunner(store)
        clock = VirtualScheduler()
        JSERunner.scheduler = clock
    }

    @AfterTest fun resetSeams() {
        JSERunner.scheduler = VirtualScheduler()
        JSERunner.mainExecutor = java.util.concurrent.Executor { it.run() }
        JSERunner.backgroundExecutor = java.util.concurrent.Executor { it.run() }
        JSERunner.fetch = JSEFetch { _, _, _, _, completion -> completion(null) }
        JSERunner.withAnimation = { it() }
        JSERunner.moduleHandle = { _, _, _ -> false }
        JSERunner.router = null
        JSERunner.cookieSet = { _, _ -> }
        JSE.stateVars = { emptyMap() }
        JSE.afterRenderDispatch = { it() }
        DSX.state.vars.clear()
    }

    private fun num(v: Any?): Double? = JSE.number(v)

    @Test fun tapStyleAssignmentPromotesAnInitialAndPublishesTheWrite() {
        store.initials["taps"] = 0.0
        val seen = ArrayList<Any?>()
        val subscription = store.sink { seen += it["taps"] }

        runner.run("taps = taps + 1", null)

        assertEquals(1.0, num(store.vars["taps"]))
        assertEquals(listOf<Any?>(null, 1.0), seen)
        subscription.cancel()
    }

    // ── statements: if / else chains ────────────────────────────────────────────────────

    @Test fun ifElseChainPicksTheRightBranch() {
        store.vars["x"] = 5.0
        runner.run("if (x > 2) { r = 'big' } else if (x > 0) { r = 'small' } else { r = 'none' }", null)
        assertEquals("big", store.vars["r"])
        store.vars["x"] = 1.0
        runner.run("if (x > 2) { r = 'big' } else if (x > 0) { r = 'small' } else { r = 'none' }", null)
        assertEquals("small", store.vars["r"])
        store.vars["x"] = -1.0
        runner.run("if (x > 2) { r = 'big' } else if (x > 0) { r = 'small' } else { r = 'none' }", null)
        assertEquals("none", store.vars["r"])
    }

    @Test fun bracelessIfElseRunsSingleStatements() {
        store.vars["ok"] = true
        runner.run("if (ok) r = 1; else r = 2", null)
        assertEquals(1.0, num(store.vars["r"]))
        store.vars["ok"] = false
        runner.run("if (ok) r = 1; else r = 2", null)
        assertEquals(2.0, num(store.vars["r"]))
    }

    @Test fun skippedBranchStaysAligned() {
        // The false branch is PARSED (never executed) so statements after it still run.
        runner.run("if (false) { a = 1; if (true) { b = 2 } } else { c = 3 }\nd = 4", null)
        assertNull(store.vars["a"]); assertNull(store.vars["b"])
        assertEquals(3.0, num(store.vars["c"]))
        assertEquals(4.0, num(store.vars["d"]))
    }

    // ── while + the loop budget ─────────────────────────────────────────────────────────

    @Test fun whileLoopRunsToConditionExit() {
        runner.run("x = 0; while (x < 5) { x += 1 }", null)
        assertEquals(5.0, num(store.vars["x"]))
    }

    @Test fun whileTrueBreachesTheLoopBudgetAndAborts() {
        runner.run("while (true) { }", null)   // must terminate — the budget, not a hang
        assertTrue(store.loopWork > JSERunner.loopCap)
    }

    @Test fun loopBudgetIsSharedAcrossLoopsButResetPerEntryEvent() {
        runner.run("x = 0; while (x < 10) { x += 1 }", null)
        val afterFirst = store.loopWork
        assertTrue(afterFirst >= 10)
        runner.run("y = 0; while (y < 3) { y += 1 }", null)   // fresh entry → ledger reset
        assertTrue(store.loopWork < afterFirst)
    }

    @Test fun breakAndContinueAreConsumedByTheLoop() {
        runner.run("x = 0; while (x < 10) { x += 1; if (x == 3) break }", null)
        assertEquals(3.0, num(store.vars["x"]))
        assertNull(store.flowSignal)
        runner.run("c = 0; n = 0; while (n < 5) { n += 1; if (n == 2) continue; c += 1 }", null)
        assertEquals(4.0, num(store.vars["c"]))
    }

    // ── for / for…of ────────────────────────────────────────────────────────────────────

    @Test fun forOfIteratesArraysBindingTheLocal() {
        runner.run("total = 0; for (const x of [1, 2, 3]) { total += x }", null)
        assertEquals(6.0, num(store.vars["total"]))
    }

    @Test fun forOfOverAStoreArrayOfRows() {
        store.vars["rows"] = listOf(mapOf("v" to 2.0), mapOf("v" to 5.0))
        runner.run("sum = 0; for (const row of rows) { sum += row.v }", null)
        assertEquals(7.0, num(store.vars["sum"]))
    }

    @Test fun forOfOverAnObjectIteratesNothing() {
        // Swift casts the collection `as? [Any]` — a dict yields no iterations.
        store.vars["obj"] = mapOf("a" to 1.0, "b" to 2.0)
        runner.run("total = 0; for (const x of obj) { total += x }", null)
        assertEquals(0.0, num(store.vars["total"]))
    }

    @Test fun classicForWithStoreCounter() {
        // `i = 0` writes the STORE (assignments never write block locals — see the port
        // header NOTES); bare `i` reads fall through to it, so the classic form works.
        runner.run("c = 0; for (i = 0; i < 4; i++) { c += 1 }", null)
        assertEquals(4.0, num(store.vars["c"]))
        assertEquals(4.0, num(store.vars["i"]))
    }

    @Test fun classicForHonorsBreakAndContinue() {
        runner.run("c = 0; for (i = 0; i < 5; i++) { if (i == 2) continue; if (i == 4) break; c += 1 }", null)
        assertEquals(3.0, num(store.vars["c"]))
    }

    @Test fun forOfBreakStopsIteration() {
        runner.run("n = 0; for (const x of [1, 2, 3, 4]) { n += x; if (x == 2) break }", null)
        assertEquals(3.0, num(store.vars["n"]))
    }

    // ── switch: JS fallthrough semantics ────────────────────────────────────────────────

    @Test fun switchFallsThroughUntilBreak() {
        store.vars["x"] = 1.0
        runner.run("switch (x) { case 1: a = 'one'; case 2: b = 'two'; break; default: d = 'def' }", null)
        assertEquals("one", store.vars["a"])      // matched case runs …
        assertEquals("two", store.vars["b"])      // … falls through into the next …
        assertNull(store.vars["d"])               // … and `break` stops before default
        assertNull(store.flowSignal)
    }

    @Test fun switchMatchesTheExactCaseAndDefault() {
        store.vars["x"] = 2.0
        runner.run("switch (x) { case 1: a = 1; case 2: b = 2; break; default: d = 1 }", null)
        assertNull(store.vars["a"]); assertEquals(2.0, num(store.vars["b"]))
        store.vars["x"] = 9.0
        runner.run("switch (x) { case 1: a2 = 1; break; default: d = 1 }", null)
        assertNull(store.vars["a2"]); assertEquals(1.0, num(store.vars["d"]))
    }

    @Test fun switchLabelEqualityIsDeepTyped() {
        // watchKey equality: the STRING '1' does not match the NUMBER 1.
        store.vars["x"] = "1"
        runner.run("switch (x) { case 1: n = 1; break; case '1': s = 1; break; }", null)
        assertNull(store.vars["n"]); assertEquals(1.0, num(store.vars["s"]))
    }

    @Test fun switchStringSubject() {
        store.vars["mode"] = "edit"
        runner.run("switch (mode) { case 'view': r = 'v'; break; case 'edit': r = 'e'; break; default: r = 'd' }", null)
        assertEquals("e", store.vars["r"])
    }

    // ── try / catch / finally / throw ───────────────────────────────────────────────────

    @Test fun throwIsCaughtBindsTheValueAndFinallyRuns() {
        runner.run("try { throw {code: 'boom'}; x = 1 } catch (e) { err = e.code } finally { fin = true }", null)
        assertEquals("boom", store.vars["err"])
        assertEquals(true, store.vars["fin"])
        assertNull(store.vars["x"])               // statements after the throw never execute
        assertNull(store.flowSignal)
    }

    @Test fun uncaughtThrowIsClearedAtTheTopLevel() {
        runner.run("throw 'oops'; x = 1", null)
        assertNull(store.vars["x"])
        assertNull(store.flowSignal)              // the entry point logs + clears the signal
        assertNull(store.thrownValue)
    }

    @Test fun unavailablePackageThrowsInsideTryOnly() {
        runner.run("try { missing.call() } catch (e) { err = e.code; c = e.call }", null)
        assertEquals("unavailable", store.vars["err"])
        assertEquals("missing.call", store.vars["c"])
        // Outside a try it stays a silent no-op.
        runner.run("missing.call(); after = 1", null)
        assertEquals(1.0, num(store.vars["after"]))
        assertNull(store.flowSignal)
    }

    @Test fun finallyPreservesAPendingSignalUnlessItRaisesItsOwn() {
        runner.run("x = 0; while (x < 5) { x += 1; try { if (x == 2) break } finally { fin = x } }", null)
        assertEquals(2.0, num(store.vars["x"]))   // the break survived finally and stopped the loop
        assertEquals(2.0, num(store.vars["fin"]))
    }

    // ── assignments: compound ops, sugar, dot paths ─────────────────────────────────────

    @Test fun compoundAssignmentsAndIncDecSugar() {
        runner.run("x = 1; x += 2; x *= 3; x -= 1; x /= 2", null)
        assertEquals(4.0, num(store.vars["x"]))
        runner.run("n = 5; n++; n++; n--", null)
        assertEquals(6.0, num(store.vars["n"]))
    }

    @Test fun dotPathWritesCreateAndEditNestedState() {
        runner.run("user.name = 'Ada'; user.age = 40", null)
        assertEquals("Ada", store.getPath("user.name"))
        assertEquals(40.0, num(store.getPath("user.age")))
        store.vars["todos"] = listOf(mapOf("done" to false), mapOf("done" to false))
        runner.run("todos.1.done = true", null)
        assertEquals(true, store.getPath("todos.1.done"))
        assertEquals(false, store.getPath("todos.0.done"))
    }

    @Test fun globalWritesGoToTheAppStore() {
        JSE.stateVars = { DSX.state.vars }
        runner.run("global.counter = 7", null)
        assertEquals(7.0, num(DSX.state.vars["counter"]))
        runner.run("y = global.counter + 1", null)
        assertEquals(8.0, num(store.vars["y"]))
    }

    @Test fun cookieWritesGoThroughTheSeam() {
        val set = ArrayList<Pair<String, String>>()
        JSERunner.cookieSet = { k, v -> set.add(k to v) }
        runner.run("dsx.cookie.session = 'abc'", null)
        assertEquals(listOf("session" to "abc"), set)
    }

    @Test fun assignmentOfNilExpressionWritesEmptyString() {
        runner.run("x = undefined", null)                   // Swift `?? ""`
        assertEquals("", store.vars["x"])
    }

    // ── array verbs ─────────────────────────────────────────────────────────────────────

    @Test fun pushPopShiftUnshift() {
        store.vars["a"] = listOf(1.0, 2.0)
        runner.run("a.push(3)", null)
        assertEquals(listOf(1.0, 2.0, 3.0), store.vars["a"])
        runner.run("a.unshift(0)", null)
        assertEquals(listOf(0.0, 1.0, 2.0, 3.0), store.vars["a"])
        runner.run("a.pop()", null)
        assertEquals(listOf(0.0, 1.0, 2.0), store.vars["a"])
        runner.run("a.shift()", null)
        assertEquals(listOf(1.0, 2.0), store.vars["a"])
    }

    @Test fun spliceRemovesAndInserts() {
        store.vars["a"] = listOf(1.0, 2.0, 3.0, 4.0)
        runner.run("a.splice(1, 2, 9)", null)
        assertEquals(listOf(1.0, 9.0, 4.0), store.vars["a"])
        runner.run("a.splice(1, 0, 7, 8)", null)
        assertEquals(listOf(1.0, 7.0, 8.0, 9.0, 4.0), store.vars["a"])
    }

    @Test fun sortStatementWithAndWithoutComparator() {
        store.vars["a"] = listOf(3.0, 1.0, 2.0)
        runner.run("a.sort((x, y) => x - y)", null)
        assertEquals(listOf(1.0, 2.0, 3.0), store.vars["a"])
        runner.run("a.sort((x, y) => y - x)", null)
        assertEquals(listOf(3.0, 2.0, 1.0), store.vars["a"])
    }

    // ── effect verbs: remove / animate / resolve / error ────────────────────────────────

    @Test fun removeByValueDropsMatchingRows() {
        store.vars["todos"] = listOf(mapOf("id" to 1.0), mapOf("id" to 2.0), mapOf("id" to 3.0))
        runner.run("remove: todos = 2", null)
        assertEquals(listOf(mapOf("id" to 1.0), mapOf("id" to 3.0)), store.vars["todos"])
    }

    @Test fun removeByCustomKeyAndWherePredicate() {
        store.vars["rows"] = listOf(mapOf("sku" to "a"), mapOf("sku" to "b"))
        runner.run("remove: rows = 'b' key=sku", null)
        assertEquals(listOf(mapOf("sku" to "a")), store.vars["rows"])
        store.vars["todos"] = listOf(
            mapOf("t" to "x", "done" to true), mapOf("t" to "y", "done" to false), mapOf("t" to "z", "done" to true)
        )
        runner.run("remove: todos where done", null)
        assertEquals(listOf(mapOf("t" to "y", "done" to false)), store.vars["todos"])
    }

    @Test fun animateWrapsTheAssignInTheAnimationSeam() {
        var animated = 0
        JSERunner.withAnimation = { body -> animated += 1; body() }
        runner.run("animate: x = 5", null)
        assertEquals(1, animated)
        assertEquals(5.0, num(store.vars["x"]))
    }

    @Test fun resolveAndErrorReachTheOwningCallsDsx() {
        var resolved: JSON? = null
        var errCode: String? = null
        var errData: JSON? = null
        runner.dsx = object : JSERunnerDsx {
            override fun resolve(data: JSON?) { resolved = data }
            override fun error(code: String, data: JSON?) { errCode = code; errData = data }
            override fun broadcast(name: String, data: JSON) {}
        }
        runner.run("resolve: ?ok=true&n=2", null)
        assertEquals(mapOf("ok" to true, "n" to 2), resolved?.foundationValue)   // JSON collapses whole doubles (NSNumber semantics)
        runner.run("error: denied?reason=no", null)
        assertEquals("denied", errCode)
        assertEquals(mapOf("reason" to "no"), errData?.foundationValue)
        runner.run("error:", null)                          // empty code → "error"
        assertEquals("error", errCode)
        assertNull(errData)
    }

    // ── fetch: the reactive envelope ────────────────────────────────────────────────────

    private class RecordedRequest(val url: String, val method: String, val headers: Map<String, String>, val body: ByteArray?)

    private fun installFetch(status: Int, body: String, record: MutableList<RecordedRequest>? = null) {
        JSERunner.fetch = JSEFetch { url, method, headers, reqBody, completion ->
            record?.add(RecordedRequest(url, method, headers, reqBody))
            completion(JSEFetchResponse(status, mapOf("Content-Type" to "application/json"), body.toByteArray()))
        }
    }

    @Test fun fetchVerbWritesTheLoadingDataEnvelope() {
        val reqs = ArrayList<RecordedRequest>()
        installFetch(200, """{"n": 7}""", reqs)
        runner.run("fetch: res = GET https://api/x", null)
        assertEquals(false, store.getPath("res.loading"))
        assertEquals("", store.getPath("res.error"))
        assertEquals(7.0, num(store.getPath("res.data.n")))
        assertEquals("GET", reqs.single().method)
        assertEquals("https://api/x", reqs.single().url)
    }

    @Test fun fetchVerbErrorAndNetworkShapes() {
        installFetch(500, "{}")
        runner.run("fetch: res = GET https://api/x", null)
        assertEquals(false, store.getPath("res.loading"))
        assertEquals("http 500", store.getPath("res.error"))
        JSERunner.fetch = JSEFetch { _, _, _, _, completion -> completion(null) }   // the default stub shape
        runner.run("fetch: r2 = GET https://api/x", null)
        assertEquals("network", store.getPath("r2.error"))
    }

    @Test fun fetchVerbSendsBodyAndHeaders() {
        val reqs = ArrayList<RecordedRequest>()
        installFetch(200, "{}", reqs)
        store.vars["payload"] = mapOf("sku" to "gold")
        runner.run("fetch: res = POST https://api/buy body=payload headers={'X-K':'v'}", null)
        val r = reqs.single()
        assertEquals("POST", r.method)
        assertEquals("v", r.headers["X-K"])
        assertEquals("""{"sku":"gold"}""", r.body?.toString(Charsets.UTF_8))
    }

    @Test fun fetchUrlInterpolates() {
        val reqs = ArrayList<RecordedRequest>()
        installFetch(200, "{}", reqs)
        store.vars["id"] = 42.0
        // NB: the spec tokenizes on spaces, so the interpolation must be space-free ({{id}}) —
        // `{{ id }}` would split into three tokens on iOS too.
        runner.run("fetch: res = GET https://api/items/{{id}}", null)
        assertEquals("https://api/items/42", reqs.single().url)
    }

    // ── declarative <api> handles ──────────────────────────────────────────────────────

    @Test fun apiRefreshSendAndCancelStatementsReachTheMountedHandle() {
        var refreshes = 0
        var cancels = 0
        val bodies = ArrayList<Map<String, Any?>?>()
        val registration = store.registerApiHandle("orders", object : StackApiHandle {
            override fun refresh(completion: ((Map<String, Any?>?) -> Unit)?) {
                refreshes += 1
                completion?.invoke(mapOf("ok" to true, "status" to 200.0))
            }
            override fun send(args: Map<String, Any?>?, completion: ((Map<String, Any?>?) -> Unit)?) {
                bodies += args
                completion?.invoke(mapOf("ok" to true, "data" to args))
            }
            override fun cancel() { cancels += 1 }
        })

        runner.run("orders.refresh(); orders.send({ id: 7 }); orders.cancel()", null)

        assertEquals(1, refreshes)
        val expectedBodies: List<Map<String, Any?>?> =
            listOf(mapOf<String, Any?>("id" to 7.0))
        assertEquals(expectedBodies, bodies)
        assertEquals(1, cancels)
        registration.cancel()
    }

    @Test fun awaitedApiSendBindsEnvelopeAndContinuesTheAction() {
        val registration = store.registerApiHandle("save", object : StackApiHandle {
            override fun refresh(completion: ((Map<String, Any?>?) -> Unit)?) {
                completion?.invoke(mapOf("ok" to true, "status" to 204.0))
            }
            override fun send(args: Map<String, Any?>?, completion: ((Map<String, Any?>?) -> Unit)?) {
                completion?.invoke(mapOf(
                    "ok" to true,
                    "status" to 201.0,
                    "data" to mapOf("id" to args?.get("draft")),
                ))
            }
            override fun cancel() {}
        })

        runner.run(
            "const r = await save.send({ draft: 42 }); saved = r.data.id; status = r.status",
            null,
        )

        assertEquals(42.0, num(store.vars["saved"]))
        assertEquals(201.0, num(store.vars["status"]))
        registration.cancel()
    }

    @Test fun awaitedApiRefreshBindsEnvelopeAndContinuesTheAction() {
        var refreshes = 0
        val registration = store.registerApiHandle("orders", object : StackApiHandle {
            override fun refresh(completion: ((Map<String, Any?>?) -> Unit)?) {
                refreshes += 1
                completion?.invoke(mapOf(
                    "ok" to true,
                    "status" to 200.0,
                    "data" to mapOf("count" to 9.0),
                ))
            }
            override fun send(
                args: Map<String, Any?>?,
                completion: ((Map<String, Any?>?) -> Unit)?,
            ) {
                completion?.invoke(null)
            }
            override fun cancel() {}
        })

        runner.run(
            "const r = await orders.refresh(); refreshed = r.data.count; status = r.status",
            null,
        )

        assertEquals(1, refreshes)
        assertEquals(9.0, num(store.vars["refreshed"]))
        assertEquals(200.0, num(store.vars["status"]))
        registration.cancel()
    }

    // ── await continuations ─────────────────────────────────────────────────────────────

    @Test fun awaitFetchBindsTheResponseAndRunsTheRest() {
        installFetch(200, """{"ok": true, "n": 3}""")
        runner.run("const r = await fetch('https://a'); n = r.data.n; s = r.status; if (r.ok) flag = 1", null)
        assertEquals(3.0, num(store.vars["n"]))
        assertEquals(200.0, num(store.vars["s"]))
        assertEquals(1.0, num(store.vars["flag"]))
    }

    @Test fun awaitFetchResponseShape() {
        installFetch(404, """{"msg": "nope"}""")
        runner.run("const r = await fetch('https://a'); e = r.error; ok = r.ok; t = r.statusText; txt = r.text", null)
        assertEquals("http 404", store.vars["e"])
        assertEquals(false, store.vars["ok"])
        assertEquals("Not Found", store.vars["t"])
        assertEquals("""{"msg": "nope"}""", store.vars["txt"])
    }

    @Test fun awaitFetchWithOptionsObject() {
        val reqs = ArrayList<RecordedRequest>()
        installFetch(200, "{}", reqs)
        runner.run("const r = await fetch('https://a', { method: 'POST', headers: { 'X-A': '1' }, body: { q: 2 } }); done = 1", null)
        val r = reqs.single()
        assertEquals("POST", r.method)
        assertEquals("1", r.headers["X-A"])
        assertEquals("""{"q":2}""", r.body?.toString(Charsets.UTF_8))
        assertEquals(1.0, num(store.vars["done"]))
    }

    @Test fun awaitFetchEffectBindsTheSettledEnvelope() {
        installFetch(200, """{"n": 9}""")
        runner.run("const env = await fetch: res = GET https://a\nx = env.data.n; l = env.loading", null)
        assertEquals(9.0, num(store.vars["x"]))
        assertEquals(false, store.vars["l"])
        assertEquals(9.0, num(store.getPath("res.data.n")))   // the envelope still landed at dest.*
    }

    @Test fun awaitPackageResolvesWithTheUniformContract() {
        val calls = ArrayList<Pair<String, Map<String, Any?>>>()
        JSERunner.moduleHandle = { url, args, onTerminal ->
            calls.add(url to args)
            onTerminal(JSEModuleOutcome.Resolve(mapOf("credits" to 5.0)))
            true
        }
        runner.run("const r = await dsx.module.wallet.get({ user: 'u1' }); c = r.data.credits; okv = r.ok", null)
        assertEquals(5.0, num(store.vars["c"]))
        assertEquals(true, store.vars["okv"])
        assertEquals("wallet://get", calls.single().first)
        assertEquals(mapOf("user" to "u1"), calls.single().second)
    }

    @Test fun awaitPackageErrorAndUnavailableShapes() {
        JSERunner.moduleHandle = { _, _, onTerminal ->
            onTerminal(JSEModuleOutcome.Error("declined", mapOf("hint" to "card")))
            true
        }
        runner.run("const r = await dsx.module.pay.buy({}); e = r.error; h = r.data.hint; okv = r.ok", null)
        assertEquals("declined", store.vars["e"])
        assertEquals("card", store.vars["h"])
        assertEquals(false, store.vars["okv"])
        JSERunner.moduleHandle = { _, _, _ -> false }                 // unregistered scheme
        runner.run("const r2 = await dsx.module.ghost.walk({}); e2 = r2.error", null)
        assertEquals("unavailable", store.vars["e2"])
    }

    @Test fun promiseAllBindsResultsInOrder() {
        runner.run("const rs = await Promise.all([1 + 1, 2 * 3]); total = rs.0 + rs.1; n = rs.length", null)
        assertEquals(8.0, num(store.vars["total"]))
        assertEquals(2.0, num(store.vars["n"]))
    }

    @Test fun promiseAllSettledWrapsEachValue() {
        runner.run("const rs = await Promise.allSettled(['a']); s = rs.0.status; v = rs.0.value", null)
        assertEquals("fulfilled", store.vars["s"])
        assertEquals("a", store.vars["v"])
    }

    @Test fun promiseCombinatorDsxModuleElementKeepsTheOffsetQuirk() {
        // PARITY-PINNED (Stack.swift:2476): the callee slice starts one char past the prefix,
        // so the scheme loses its first character and the element settles "unavailable".
        val urls = ArrayList<String>()
        JSERunner.moduleHandle = { url, _, _ -> urls.add(url); false }
        runner.run("const r = await Promise.all([dsx.module.pay.buy({})]); e = r.0.error", null)
        assertEquals("unavailable", store.vars["e"])
        assertEquals(listOf("ay://buy"), urls)
    }

    // ── keyed timers ────────────────────────────────────────────────────────────────────

    @Test fun setTimeoutFiresAfterTheDelay() {
        runner.run("setTimeout(() => { fired = 1 }, 100)", null)
        clock.advance(99)
        assertNull(store.vars["fired"])
        clock.advance(1)
        assertEquals(1.0, num(store.vars["fired"]))
    }

    @Test fun keyedSetTimeoutReplacesThePendingTimer() {
        runner.run("setTimeout(() => { v = 'first' }, 100, 'k')", null)
        runner.run("setTimeout(() => { v = 'second' }, 100, 'k')", null)
        clock.advance(200)
        assertEquals("second", store.vars["v"])
        assertTrue(store.timers.isEmpty())                            // the fire cleared its key
    }

    @Test fun clearTimeoutCancelsAKeyedTimer() {
        runner.run("setTimeout(() => { fired = 1 }, 100, 'k')", null)
        runner.run("clearTimeout('k')", null)
        clock.advance(500)
        assertNull(store.vars["fired"])
        assertTrue(store.timers.isEmpty())
    }

    @Test fun setTimeoutCapturesTheDeclaringScope() {
        runner.run("const v = 9; setTimeout(() => { copy = v }, 10)", null)
        clock.advance(10)
        assertEquals(9.0, num(store.vars["copy"]))
    }

    @Test fun setIntervalRepeatsUntilCleared() {
        store.vars["n"] = 0.0
        runner.run("setInterval(() => { n += 1 }, 300, 'tick')", null)
        clock.advance(300)
        assertEquals(1.0, num(store.vars["n"]))
        clock.advance(600)
        assertEquals(3.0, num(store.vars["n"]))
        runner.run("clearInterval('tick')", null)
        clock.advance(900)
        assertEquals(3.0, num(store.vars["n"]))
    }

    @Test fun setIntervalClampsTo250msMinimum() {
        store.vars["n"] = 0.0
        runner.run("setInterval(() => { n += 1 }, 10, 'fast')", null)
        clock.advance(249)
        assertEquals(0.0, num(store.vars["n"]))
        clock.advance(1)
        assertEquals(1.0, num(store.vars["n"]))
        runner.run("clearInterval('fast')", null)
    }

    @Test fun intervalBodyCanClearItself() {
        store.vars["n"] = 0.0
        runner.run("setInterval(() => { n += 1; if (n == 2) clearInterval('t') }, 250, 't')", null)
        clock.advance(2000)
        assertEquals(2.0, num(store.vars["n"]))
    }

    // ── debounce / throttle ─────────────────────────────────────────────────────────────

    @Test fun debounceCoalescesABurstToTheLastCall() {
        store.vars["d"] = 0.0
        repeat(3) { runner.runGated("d += 1", null, debounceMs = 100.0, throttleMs = null, gateKey = "g") }
        assertEquals(0.0, num(store.vars["d"]))                       // nothing ran yet
        clock.advance(100)
        assertEquals(1.0, num(store.vars["d"]))                       // exactly ONE run
    }

    @Test fun debounceReschedulesFromTheLastCall() {
        store.vars["d"] = 0.0
        runner.runGated("d += 1", null, debounceMs = 100.0, throttleMs = null, gateKey = "g")
        clock.advance(50)
        runner.runGated("d += 1", null, debounceMs = 100.0, throttleMs = null, gateKey = "g")
        clock.advance(50)
        assertEquals(0.0, num(store.vars["d"]))                       // the window restarted at t=50
        clock.advance(50)
        assertEquals(1.0, num(store.vars["d"]))                       // fires at t=150
    }

    @Test fun throttleRunsTheLeadingEdgeAndDropsTheRest() {
        store.vars["t"] = 0.0
        repeat(3) { runner.runGated("t += 1", null, debounceMs = null, throttleMs = 100.0, gateKey = "g") }
        assertEquals(1.0, num(store.vars["t"]))                       // first ran immediately, rest dropped
        clock.advance(100)                                            // window closes
        runner.runGated("t += 1", null, debounceMs = null, throttleMs = 100.0, gateKey = "g")
        assertEquals(2.0, num(store.vars["t"]))
    }

    @Test fun noModifierRunsImmediately() {
        runner.runGated("x = 1", null, debounceMs = null, throttleMs = null, gateKey = "g")
        assertEquals(1.0, num(store.vars["x"]))
    }

    @Test fun gateMsParsesTheModifierAttribute() {
        assertEquals(300.0, JSERunner.gateMs(mapOf("on:tap.debounce" to "300"), "tap", "debounce"))
        assertEquals(50.0, JSERunner.gateMs(mapOf("on:submit.throttle" to " 50 "), "submit", "throttle"))
        assertNull(JSERunner.gateMs(mapOf("on:tap.debounce" to "fast"), "tap", "debounce"))
        assertNull(JSERunner.gateMs(emptyMap(), "tap", "debounce"))
    }

    // ── dsx.event: statement + await request/response ───────────────────────────────────

    @Test fun dsxEventRunsTheConsumersHandlerWithThePayloadAsScope() {
        val consumer = JSERunner(store)
        runner.onHandlers["save"] = OnHandler("saved = dsx.this.id", consumer)
        runner.run("dsx.event('save', { id: 3 })", null)
        assertEquals(3.0, num(store.vars["saved"]))
    }

    @Test fun dsxEventFallsThroughToTheNativeHandlerWhenNoOnHandler() {
        var got: Map<String, Any?>? = null
        store.handlers["ping"] = { got = it }
        runner.run("dsx.event('ping', { a: 1 })", null)
        assertEquals(1.0, num(got?.get("a")))
    }

    @Test fun dsxSendReachesTheNativeHandlerDirectly() {
        var got: Map<String, Any?>? = null
        store.handlers["ping"] = { got = it }
        runner.run("dsx.send('ping', { a: 2 })", null)
        assertEquals(2.0, num(got?.get("a")))
    }

    @Test fun anyHandlersSeeEveryEvent() {
        val seen = ArrayList<String>()
        store.anyHandlers.add { name, _ -> seen.add(name) }
        runner.run("dsx.event('one'); dsx.send('two')", null)
        assertEquals(listOf("one", "two"), seen)
    }

    @Test fun fromFilterGatesTheHandler() {
        val h = OnHandler("x = 1", runner, OnHandler.From("action", "checkout"))
        assertFalse(h.accepts(mapOf("v" to 1)))                       // unstamped payload fails a set filter
        assertTrue(h.accepts(mapOf("__from" to mapOf("type" to "action", "name" to "checkout"))))
        assertFalse(h.accepts(mapOf("__from" to mapOf("type" to "component", "name" to "checkout"))))
        val bare = OnHandler("x = 1", runner, OnHandler.parseFrom("checkout"))
        assertTrue(bare.accepts(mapOf("__from" to mapOf("type" to "component", "name" to "checkout"))))
        assertNull(OnHandler.parseFrom("  "))
    }

    @Test fun awaitEventResumesWithTheResolveValue() {
        runner.onHandlers["confirm"] = OnHandler("resolve: ok?value=42", runner)
        runner.run("const ans = await dsx.event('confirm', { q: 'sure' }); out = ans.value", null)
        assertEquals(42.0, num(store.vars["out"]))
        assertTrue(store.eventReplies.isEmpty())                      // the token was consumed
    }

    @Test fun awaitEventBareResolveHeadCoerces() {
        runner.onHandlers["ask"] = OnHandler("resolve: true", runner)
        runner.run("const ok = await dsx.event('ask'); if (ok) yes = 1", null)
        assertEquals(1.0, num(store.vars["yes"]))
    }

    @Test fun awaitEventErrorReplySettlesNSNull() {
        // The awaiter resumes with the NSNull sentinel (present-but-null) — pinned: NSNull is
        // TRUTHY in JSE (Swift `.some`), so authors branch on a value field, not the binding.
        runner.onHandlers["ask"] = OnHandler("error: denied", runner)
        runner.run("const ok = await dsx.event('ask'); got = ok", null)
        assertSame(NSNull, store.vars["got"])
        assertTrue(store.eventReplies.isEmpty())
    }

    @Test fun awaitEventWithNoConsumerStaysSuspended() {
        runner.run("const ok = await dsx.event('nobody'); after = 1", null)
        assertNull(store.vars["after"])                               // like an unresolved JS promise
        assertEquals(1, store.eventReplies.size)                      // parked on the surface store
    }

    @Test fun concurrentAwaitEventsRouteByToken() {
        // Two suspended awaiters; replies resolve the RIGHT one via the stamped token.
        runner.run("const a = await dsx.event('q1'); ra = a", null)
        runner.run("const b = await dsx.event('q2'); rb = b", null)
        assertEquals(2, store.eventReplies.size)
        // Service the SECOND request first: its handler sees __reply in args.
        val secondToken = store.nextEventReply
        runner.run("resolve: ?v=2", mapOf("__reply" to secondToken))
        assertEquals(2.0, num((store.vars["rb"] as? Map<*, *>)?.get("v")))
        assertNull(store.vars["ra"])
        runner.run("resolve: ?v=1", mapOf("__reply" to secondToken - 1))
        assertEquals(1.0, num((store.vars["ra"] as? Map<*, *>)?.get("v")))
    }

    // ── run(action): named actions, args, depth ─────────────────────────────────────────

    @Test fun namedActionRunsWithDeclaredInputsAndArgsObject() {
        store.actions["greet"] = StackFormula(mapOf("prefix" to "'Hi '"), "message = prefix + name")
        runner.run("greet({ name: 'Ada' })", null)
        assertEquals("Hi Ada", store.vars["message"])
    }

    @Test fun namedActionArgsObjectOverridesDeclaredInputs() {
        store.actions["greet"] = StackFormula(mapOf("prefix" to "'Hi '"), "message = prefix + name")
        runner.run("greet({ name: 'Bo', prefix: 'Yo ' })", null)
        assertEquals("Yo Bo", store.vars["message"])
    }

    @Test fun dsxActionPrefixIsTheSameCall() {
        store.actions["ping"] = StackFormula(emptyMap(), "p = 1")
        runner.run("dsx.action.ping()", null)
        assertEquals(1.0, num(store.vars["p"]))
    }

    @Test fun actionRecursionIsDepthCapped() {
        store.vars["cnt"] = 0.0
        store.actions["loop"] = StackFormula(emptyMap(), "cnt += 1; loop()")
        runner.run("loop()", null)                                    // must terminate
        assertEquals(32.0, num(store.vars["cnt"]))
    }

    @Test fun actionEventCallbacksReceiveDsxEvents() {
        store.actions["notify"] = StackFormula(emptyMap(), "dsx.event('done', { v: 2 })")
        runner.run("notify({}, { done: () => { dv = dsx.this.v } })", null)
        assertEquals(2.0, num(store.vars["dv"]))
    }

    @Test fun eventsRaisedInsideAnActionAreStampedWithItsName() {
        val stamped = ArrayList<Map<String, Any?>>()
        store.handlers["sig"] = { stamped.add(it) }
        store.actions["checkout"] = StackFormula(emptyMap(), "dsx.event('sig', { ok: 1 })")
        runner.run("checkout()", null)
        val from = stamped.single()["__from"] as? Map<*, *>
        assertEquals("action", from?.get("type"))
        assertEquals("checkout", from?.get("name"))
    }

    // ── package dispatch (run → dispatch → moduleHandle) ────────────────────────────────

    @Test fun dotApiCallDispatchesSchemeMethodAndNamedArgs() {
        val calls = ArrayList<Pair<String, Map<String, Any?>>>()
        JSERunner.moduleHandle = { url, args, _ -> calls.add(url to args); true }
        runner.run("haptic.play(style=heavy)", null)
        assertEquals("haptic://play?style=heavy", calls.single().first)
        assertEquals(mapOf("style" to "heavy"), calls.single().second)
    }

    @Test fun objectArgsCallEvaluatesTheOptionsObject() {
        val calls = ArrayList<Pair<String, Map<String, Any?>>>()
        JSERunner.moduleHandle = { url, args, _ -> calls.add(url to args); true }
        store.vars["sku"] = "gold"
        runner.run("dsx.module.pay.buy({ sku: sku, qty: 2 })", null)
        assertEquals("pay://buy", calls.single().first)
        assertEquals(mapOf("sku" to "gold", "qty" to 2.0), calls.single().second)
    }

    @Test fun namedArgValuesAreExpressionsEvaluatedInScope() {
        val calls = ArrayList<Pair<String, Map<String, Any?>>>()
        JSERunner.moduleHandle = { url, args, _ -> calls.add(url to args); true }
        runner.run("store.checkout(id=item.id)", mapOf("id" to 42.0))
        assertEquals("store://checkout?id=item.id", calls.single().first)
        assertEquals(mapOf("id" to "42"), calls.single().second)      // evaluated then stringified
    }

    @Test fun selfResolvesToTheOwningScope() {
        val calls = ArrayList<String>()
        JSERunner.moduleHandle = { url, _, _ -> calls.add(url); true }
        runner.scope = "player"
        runner.run("dsx.module.self.pause({})", null)
        assertEquals(listOf("player://pause"), calls)
    }

    @Test fun selfWithoutAScopeThrowsInsideTry() {
        runner.scope = null
        runner.run("try { dsx.module.self.pause({}) } catch (e) { err = e.code }", null)
        assertEquals("unavailable", store.vars["err"])
    }

    @Test fun dsxComponentVerbsRouteThroughTheRouterSeam() {
        val log = ArrayList<String>()
        JSERunner.router = object : JSERunnerRouter {
            override fun dismissModal(target: String?) { log.add("dismiss:$target") }
            override fun presentComponent(name: String, scope: String?, mode: String, vars: Map<String, Any?>?,
                                          detents: List<String>?, touch: String?, attrs: Map<String, Any?>?) {
                log.add("present:$name:$mode:$touch:${attrs?.get("id")}")
            }
            override fun pushComponent(name: String, scope: String?, path: String, vars: Map<String, Any?>?,
                                       attrs: Map<String, Any?>?) {
                log.add("push:$name:$path:${attrs?.get("id")}")
            }
            override fun updateComponent(target: String?, attrs: Map<String, Any?>) {
                log.add("update:$target:${attrs["id"]}")
            }
        }
        runner.run("dsx.component.push('Cart', { path: '/cart', attrs: { id: '42' } })", null)
        runner.run("dsx.component.present('Login', { as: 'fullscreen' })", null)
        runner.run("dsx.component.present('Bar', { as: 'overlay', touch: 'block' })", null)
        runner.run("dsx.component.update('Bar', { attrs: { id: '7' } })", null)
        runner.run("dsx.component.dismiss()", null)
        runner.run("dsx.component.mount('X')", null)                  // unknown verb → log + no-op
        assertEquals(listOf("push:Cart:/cart:42", "present:Login:fullscreen:null:null",
                            "present:Bar:overlay:block:null", "update:Bar:7", "dismiss:null"), log)
    }

    // ── watch scheduling (fireWatch = WatchView.fire) ───────────────────────────────────

    @Test fun fireWatchRunsTheChangeHandlerRenderSafe() {
        store.vars["wcount"] = 0.0
        runner.fireWatch(mapOf("fresh" to true), "wcount += 1; seen = dsx.this.fresh")
        assertEquals(1.0, num(store.vars["wcount"]))
        assertEquals(true, store.vars["seen"])
    }

    @Test fun fireWatchWrapsScalarValues() {
        runner.fireWatch(7.0, "got = dsx.this.value")
        assertEquals(7.0, num(store.vars["got"]))
    }

    @Test fun fireWatchBudgetAbortsARewriteLoopWithinOneTick() {
        // Defer afterRender so the whole cascade lands in ONE tick (like a runloop pass).
        val queued = ArrayList<() -> Unit>()
        JSE.afterRenderDispatch = { queued.add(it) }
        store.vars["wcount"] = 0.0
        repeat(300) { runner.fireWatch(it.toDouble(), "wcount += 1") }
        assertEquals(300, store.watchBudget)                          // every fire counted …
        var i = 0
        while (i < queued.size) { queued[i]() ; i += 1 }              // drain the tick (reset job runs too)
        assertEquals(256.0, num(store.vars["wcount"]))                // … but only 256 ran
        assertEquals(0, store.watchBudget)                            // the queued reset cleared the budget
        assertFalse(store.watchResetScheduled)
    }

    // ── the statics ─────────────────────────────────────────────────────────────────────

    @Test fun jsSugarRewritesCompoundAndIncDecForms() {
        assertEquals("i = i + 1", JSERunner.jsSugar("i++"))
        assertEquals("cart.qty = cart.qty - 1", JSERunner.jsSugar("cart.qty--"))
        assertEquals("x = x + (2)", JSERunner.jsSugar("x += 2"))
        assertEquals("x = x / (2)", JSERunner.jsSugar("x /= 2"))
        assertEquals("f(a += 1)", JSERunner.jsSugar("f(a += 1)"))     // bracket-protected: untouched
        assertEquals("a == b", JSERunner.jsSugar("a == b"))
    }

    @Test fun splitOnAssignSkipsComparisons() {
        assertEquals("x" to "y == 2", JSERunner.splitOnAssign("x = y == 2"))
        assertEquals("x" to "y != 2", JSERunner.splitOnAssign("x = y != 2"))
        assertNull(JSERunner.splitOnAssign("a == b"))
        assertNull(JSERunner.splitOnAssign("a <= b"))
        assertEquals("a.b.c" to "1", JSERunner.splitOnAssign("a.b.c = 1"))
    }

    @Test fun splitArgsIsQuoteAndBracketAware() {
        assertEquals(listOf("'a,b'", " [1, 2]", " { x: 1, y: 2 }"), JSERunner.splitArgs("'a,b', [1, 2], { x: 1, y: 2 }"))
    }

    @Test fun splitTrailingIndexPeelsNumericTails() {
        assertEquals("todos" to 2, JSERunner.splitTrailingIndex("todos.2"))
        assertEquals("a.b" to 10, JSERunner.splitTrailingIndex("a.b.10"))
        assertEquals("todos.x" to 0, JSERunner.splitTrailingIndex("todos.x"))
    }

    @Test fun normalizeCallBuildsTheSchemeHostForm() {
        assertEquals("haptic://success", JSERunner.normalizeCall("haptic.success"))
        assertEquals("store://checkout?id=42", JSERunner.normalizeCall("store.checkout(id = 42)"))
        assertEquals("a://b?x=1&y=2", JSERunner.normalizeCall("a.b(x=1, y=2)"))
        assertEquals("legacy://call?x=1", JSERunner.normalizeCall("legacy://call?x=1"))   // URL form untouched
    }

    @Test fun parseArrowSplitsParamAndBody() {
        assertEquals("e" to " x = 1 ", JSERunner.parseArrow("e => { x = 1 }"))   // Swift strips braces but not the inner padding
        assertEquals("msg" to "y = msg", JSERunner.parseArrow("(msg) => y = msg"))
        assertEquals("e" to "z = 1", JSERunner.parseArrow("() => z = 1"))
        assertEquals("e" to "plain", JSERunner.parseArrow("plain"))
    }

    @Test fun parseHandlersExtractsEventBodies() {
        val h = JSERunner.parseHandlers("{ success: () => { a = 1; b = 2 }, error: () => c = 3 }")
        assertEquals("a = 1; b = 2", h["success"]?.trim())
        assertEquals("c = 3", h["error"]?.trim())
        assertTrue(JSERunner.parseHandlers("not an object").isEmpty())
    }

    @Test fun stripJSCommentsKeepsUrlsAndQuotes() {
        assertEquals("a = 1 \nb = 2", JSERunner.stripJSComments("a = 1 // note\nb = 2"))
        assertEquals("x = 'a // b'", JSERunner.stripJSComments("x = 'a // b'"))
        assertEquals("fetch: r = GET https://x/y", JSERunner.stripJSComments("fetch: r = GET https://x/y"))
        // a block comment becomes ONE space (never glues the surrounding tokens)
        assertEquals("a = 1;   b = 2", JSERunner.stripJSComments("a = 1; /* gone\ngone */ b = 2"))
        // a regex literal is never a comment — `/\//g` survives whole (syntax wave 1)
        assertEquals("g = 'a/b'.replace(/\\//g, '-')", JSERunner.stripJSComments("g = 'a/b'.replace(/\\//g, '-')"))
    }

    @Test fun stampFromNeverOverwritesAnInnerStamp() {
        val stamped = JSERunner.stampFrom(mapOf("v" to 1), "action", "pay")
        assertEquals(mapOf("type" to "action", "name" to "pay"), stamped["__from"])
        val inner = mapOf("__from" to mapOf("type" to "action", "name" to "inner"))
        assertSame(inner, JSERunner.stampFrom(inner, "action", "outer"))
        val plain = mapOf<String, Any?>("v" to 1)
        assertSame(plain, JSERunner.stampFrom(plain, "action", null))
    }

    @Test fun splitStatementsAndTopLevelAreQuoteAware() {
        assertEquals(listOf("a = 'x;y'", " b = 1"), JSERunner.splitStatements("a = 'x;y'; b = 1"))
        assertEquals(listOf("a", "b"), JSERunner.splitTopLevel("a;b", ';'))
    }

    // ── comments, multiline bodies, ASI ─────────────────────────────────────────────────

    @Test fun multilineBodiesSplitOnNewlinesWithAsiContinuations() {
        runner.run("x = 1 +\n    2\ny = x * 2", null)                 // trailing `+` continues the line
        assertEquals(3.0, num(store.vars["x"]))
        assertEquals(6.0, num(store.vars["y"]))
        runner.run("z = true\n  ? 'yes'\n  : 'no'", null)             // leading `?` / `:` continue
        assertEquals("yes", store.vars["z"])
    }

    @Test fun commentsInsideActionBodiesAreStripped() {
        runner.run("// leading note\na = 1; /* mid */ b = 2 // tail", null)
        assertEquals(1.0, num(store.vars["a"]))
        assertEquals(2.0, num(store.vars["b"]))
    }

    @Test fun strayClosingParenNeverSpins() {
        runner.run(") ; x = 1", null)                                 // the non-advancing guard
        assertEquals(1.0, num(store.vars["x"]))
    }
}
