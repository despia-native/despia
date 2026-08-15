package despia.engine

import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.lang.ref.WeakReference
import java.net.URI
import java.util.Collections
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.parallel.ResourceLock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/// THE ENVELOPE SUITE (beginnings) — the dsx handle pinned to Context.swift: smart-typed
/// per-call reads, the dsx.module chain (operator-get) incl. the three ModuleCallError
/// cases, the exposed:false trust gate, delegate fold, container/fetch/cookie seams.
/// Unique schemes/events per test (the registry is a process singleton).
@ResourceLock("despia-engine-runtime-executors")
class ContextTest {

    /// A detached caller handle — Swift's "any dsx reaches the bus".
    private val dsx: Context = Module().dsx

    private fun <T> capturingWeb(body: (MutableList<DSXEgress>) -> T): T {
        val received = mutableListOf<DSXEgress>()
        val mount = DSXMessenger().mount("web") { received.add(it) }
        try { return body(received) } finally { mount.unmount() }
    }

    // -- smart-typed args (URL ingestion) --

    private class SmartMod : Module() {
        override val scheme get() = "ct.smart"
        override fun setup() {
            dsx.action("probe") { dsx ->
                seen = mapOf(
                    "test" to dsx.args("test"), "on" to dsx.args("on"),
                    "tags" to dsx.args("tags"), "ids" to dsx.args("ids"),
                    "name" to dsx.args("name"), "price" to dsx.args("price"),
                    "pct" to dsx.args("pct"), "empty" to dsx.args("empty"),
                    "nul" to dsx.args("nul"),
                    "plus" to dsx.args("plus"), "zeroLed" to dsx.args("zeroLed"),
                    "missing" to dsx.args("missing"),
                )
                all = dsx.args()
                tagsList = dsx.list("tags")
                nameList = dsx.list("name")
                rid = dsx.id()
                actionName = dsx.action.name
                command = dsx.command()
                dsx.resolve()
            }
        }
        companion object {
            var seen: Map<String, Any?> = emptyMap()
            var all: Map<String, Any?> = emptyMap()
            var tagsList: List<String> = emptyList()
            var nameList: List<String> = emptyList()
            var rid: String? = null
            var actionName = ""
            var command: URI? = null
        }
    }

    @Test fun smartTypedArgsFromURLQuery() = capturingWeb { _ ->
        ModuleRegistry.shared.register { SmartMod() }
        val url = URI("ct.smart://probe?test=123&on=true&tags=a,b&ids=1,2&name=Ada" +
                      "&price=9.99&pct=50%25%20off&empty=&nul=null&plus=a+b&zeroLed=01234&__rid=q1")
        assertTrue(ModuleRegistry.shared.handle(url = url, params = Bridge.Params(url = url, surfaceID = "web")))
        assertEquals(123, SmartMod.seen["test"])                     // number promotes
        assertEquals(true, SmartMod.seen["on"])                      // bool promotes
        assertEquals(listOf("a", "b"), SmartMod.seen["tags"])        // comma-list → array
        assertEquals(listOf(1, 2), SmartMod.seen["ids"])             // …element-wise smart-parsed
        assertEquals("Ada", SmartMod.seen["name"])                   // plain word stays a string
        assertEquals(9.99, SmartMod.seen["price"])
        assertEquals("50% off", SmartMod.seen["pct"])                // stray % preserved (+ %20 decoded)
        assertEquals("", SmartMod.seen["empty"])
        assertNull(SmartMod.seen["nul"])                             // literal null → args() null
        assertEquals("a b", SmartMod.seen["plus"])                   // + is space (form encoding)
        assertEquals("01234", SmartMod.seen["zeroLed"])              // leading zero: NOT a number
        assertNull(SmartMod.seen["missing"])
        assertFalse(SmartMod.all.keys.any { it.startsWith("__") })   // framing keys stripped
        assertEquals("q1", SmartMod.rid)
        assertEquals(listOf("a", "b"), SmartMod.tagsList)            // list(): array maps element-wise
        assertEquals(listOf("Ada"), SmartMod.nameList)               // list(): scalar wraps
        assertEquals("probe", SmartMod.actionName)
        assertEquals(url, SmartMod.command)                          // raw trigger URL
    }

    // -- structured reads: id / stopped / args() --

    private class ReadsMod : Module() {
        override val scheme get() = "ct.reads"
        override fun setup() {
            dsx.action("read") { dsx ->
                stopped = dsx.stopped(); rid = dsx.id(); all = dsx.args(); dsx.resolve()
            }
        }
        companion object { var stopped = false; var rid: String? = null; var all: Map<String, Any?> = emptyMap() }
    }

    @Test fun structuredFramingReads() = capturingWeb { _ ->
        ModuleRegistry.shared.register { ReadsMod() }
        assertTrue(ModuleRegistry.shared.handle(
            scheme = "ct.reads", actionPath = "read",
            params = Bridge.Params(dict = mapOf("k" to 1, "__stop" to true), requestID = "r7", surfaceID = "web")))
        assertTrue(ReadsMod.stopped)
        assertEquals("r7", ReadsMod.rid)
        assertEquals(mapOf<String, Any?>("k" to 1), ReadsMod.all)    // __stop stripped from args()
    }

    // -- dsx.module chain: awaitable + the three ModuleCallError cases --

    private class EchoMod : Module() {
        override val scheme get() = "ct.echo"
        override fun setup() {
            dsx.action("say") { dsx -> dsx.resolve(JSON(mapOf("echo" to dsx.args("text")))) }
            dsx.action("explode") { dsx -> dsx.error("kaboom", mapOf("why" to "test")) }
            dsx.action("track") { dsx -> dsx.resolve(mapOf("path" to dsx.command()?.path)) }
            dsx.group("rag") { dsx.action("add") { dsx -> dsx.resolve("rag-added") } }
        }
    }

    @Test fun moduleChainAwaitsResolvePayload() = runBlocking {
        ModuleRegistry.shared.register { EchoMod() }
        val res = dsx.module["ct.echo"]["say"](mapOf("text" to "hi"))
        assertEquals(mapOf("echo" to "hi"), res.foundationValue)
        // JSON-arg overload (the 1:1 register)
        val res2 = dsx.module["ct.echo"]["say"](JSON.obj().put("text", "yo"))
        assertEquals(mapOf("echo" to "yo"), res2.foundationValue)
    }

    @Test fun moduleChainThrowsActionFailed() = runBlocking<Unit> {
        ModuleRegistry.shared.register { EchoMod() }
        val e = assertFailsWith<ModuleCallError.ActionFailed> {
            dsx.module["ct.echo"]["explode"]()
        }
        assertEquals("kaboom", e.code)
        assertEquals(mapOf("why" to "test"), e.data)
    }

    @Test fun moduleChainThrowsNotLoaded() = runBlocking<Unit> {
        val e = assertFailsWith<ModuleCallError.NotLoaded> {
            dsx.module["ct.ghost"]["anything"]()
        }
        assertEquals("ct.ghost", e.scheme)
    }

    @Test fun moduleChainThrowsInvalidURI() = runBlocking<Unit> {
        val e = assertFailsWith<ModuleCallError.InvalidURI> {
            dsx.module[""]["orphan"]()
        }
        assertEquals("://orphan", e.uri)
        assertFailsWith<ModuleCallError.InvalidURI> { dsx.module[""]["orphan"].post() }
    }

    @Test fun moduleFireAndForgetPostRoutes() {
        ModuleRegistry.shared.register { EchoMod() }
        dsx.module["ct.echo"]["say"].post(mapOf("text" to "bye"))    // no throw = routed
        assertFailsWith<ModuleCallError.NotLoaded> { dsx.module["ct.gone"]["x"].post() }
    }

    // -- module-call diagnostics: the failure funnel (Context.reportCallFailure twin) --

    private class TypoMod : Module() {
        override val scheme get() = "ct.typo"
        override fun setup() { dsx.action("inject") { dsx -> dsx.resolve("ok") } }
    }

    /// A typo'd action on a LOADED module answers `unknown_action` — never `NotLoaded` (that
    /// means "the module is absent") and never a silent miss: the `injct` typo class stays
    /// diagnosable. Same code + data shape as the prefilter path (Registration.dispatch) and
    /// the web twin (bus.ts), on BOTH call forms; `actionNames` backs the funnel's hint line.
    @Test fun unknownActionOnLoadedModuleThrowsActionFailed() = runBlocking<Unit> {
        ModuleRegistry.shared.register { TypoMod() }
        val e = assertFailsWith<ModuleCallError.ActionFailed> { dsx.module["ct.typo"]["injct"]() }
        assertEquals("unknown_action", e.code)
        assertEquals(mapOf("action" to "injct"), e.data)
        val p = assertFailsWith<ModuleCallError.ActionFailed> { dsx.module["ct.typo"]["injct"].post() }
        assertEquals("unknown_action", p.code)
        assertEquals(listOf("inject"), ModuleRegistry.shared.actionNames("ct.typo"))
        assertTrue(ModuleRegistry.shared.actionNames("ct.typo-neverwas").isEmpty())
    }

    private class DiscardMod : Module() {
        override val scheme get() = "ct.discard"
        override fun setup() { dsx.action("explode") { dsx -> dsx.error("boom", mapOf("why" to "t")) } }
    }

    private class DiscardWatchMod : Module() {
        override val scheme get() = "ct.discard-watch"
        override fun setup() {
            dsx.delegate.listen("module.callFailed") { input ->
                @Suppress("UNCHECKED_CAST") val p = input as? Map<String, Any?>
                if (p?.get("scheme") == "ct.discard") events.add(p)
                null
            }
        }
        companion object { val events = mutableListOf<Map<String, Any?>>() }
    }

    /// A fire-and-forget error terminal structurally can't reach the call site (`.post`
    /// returned long ago) — the funnel is its ONLY surface: the kernel-log line plus the
    /// `module.callFailed` event with `delivered=false`. Success terminals stay silent.
    /// (The log assertion observes stdout via the print gate — order-free; arming the
    /// KernelLogBuffer singleton is reserved for KernelLogTest's one arming test.)
    @Test fun fireAndForgetErrorLandsInTheFunnel() {
        ModuleRegistry.shared.register { DiscardMod() }
        ModuleRegistry.shared.register { DiscardWatchMod() }
        val original = System.out
        val captured = ByteArrayOutputStream()
        System.setOut(PrintStream(captured, true))
        try {
            KernelLog.enabled = true
            dsx.module["ct.discard"]["explode"].post()
        } finally {
            System.setOut(original)
            KernelLog.enabled = false
        }
        assertEquals(1, DiscardWatchMod.events.size)
        val event = DiscardWatchMod.events[0]
        assertEquals("explode", event["action"])
        assertEquals("boom", event["code"])
        assertEquals(false, event["delivered"])
        assertEquals(mapOf("why" to "t"), event["data"])
        val logged = captured.toString()
        assertTrue(logged.contains("[dsx.module] ct.discard.explode → boom"), "missing funnel line: $logged")
        assertTrue(logged.contains("fire-and-forget"), "missing discard marker: $logged")
    }

    private class VanishWatchMod : Module() {
        override val scheme get() = "ct.vanish-watch"
        override fun setup() {
            dsx.delegate.listen("module.callFailed") { input ->
                @Suppress("UNCHECKED_CAST") val p = input as? Map<String, Any?>
                if (p?.get("scheme") == "ct.vanished") events.add(p)
                null
            }
        }
        companion object { val events = mutableListOf<Map<String, Any?>>() }
    }

    /// Failures DELIVERED to the caller (typed throw) still fire the funnel event with
    /// `delivered=true` — a `try?`-style swallowing catch is silent, and dev tooling wants
    /// the trace either way. `not_loaded` reports too: the swallowed skip, made visible.
    @Test fun deliveredFailuresAlsoFireTheFunnelEvent() = runBlocking<Unit> {
        ModuleRegistry.shared.register { VanishWatchMod() }
        assertFailsWith<ModuleCallError.NotLoaded> { dsx.module["ct.vanished"]["go"]() }
        assertEquals(1, VanishWatchMod.events.size)
        assertEquals("not_loaded", VanishWatchMod.events[0]["code"])
        assertEquals("go", VanishWatchMod.events[0]["action"])
        assertEquals(true, VanishWatchMod.events[0]["delivered"])
    }

    private class LoopWatchMod : Module() {
        override val scheme get() = "ct.loop-watch"
        override fun setup() {
            dsx.delegate.listen("module.callFailed") { input ->
                @Suppress("UNCHECKED_CAST") val p = input as? Map<String, Any?>
                when (p?.get("scheme")) {
                    "ct.loopy" -> {
                        fires += 1
                        // The hook's own body makes a FAILING cross-package call — the loop
                        // this funnel's guard exists to break (fire → hook → failure → fire → …).
                        try { dsx.module["ct.loopy-absent"]["x"].post() } catch (_: ModuleCallError) {}
                    }
                    "ct.loopy-absent" -> nestedFires += 1
                }
                null
            }
        }
        companion object { var fires = 0; var nestedFires = 0 }
    }

    /// A failure reported from INSIDE a `module.callFailed` hook stays log-only — the nested
    /// fire is suppressed (thread-identity guard), so the funnel can never feed a hook its
    /// own output. Later, unrelated failures fire again (the guard releases).
    @Test fun callFailedHookFailuresDoNotRecurse() {
        ModuleRegistry.shared.register { LoopWatchMod() }
        try { dsx.module["ct.loopy"]["anything"].post() } catch (_: ModuleCallError) {}
        assertEquals(1, LoopWatchMod.fires)         // the original failure fired once
        assertEquals(0, LoopWatchMod.nestedFires)   // the hook's own failing call stayed log-only
        try { dsx.module["ct.loopy"]["again"].post() } catch (_: ModuleCallError) {}
        assertEquals(2, LoopWatchMod.fires)         // guard released — the next failure fires
    }

    @Test fun moduleEnvelopeRootCall_arrayMethodPath() = runBlocking {
        ModuleRegistry.shared.register { EchoMod() }
        // Single-segment method path.
        val res = dsx.module(JSON.obj()
            .put("scheme", "ct.echo")
            .put("method", JSON.arr("say"))
            .put("args", JSON.obj().put("text", "env")))
        assertEquals(mapOf("echo" to "env"), res.foundationValue)
        // Multi-segment path routes on the FIRST segment (the URL-host contract);
        // the rest rides the carrier URL's path — pinned Swift behavior.
        val deep = dsx.module(JSON.obj()
            .put("scheme", "ct.echo")
            .put("method", JSON.arr("track", "event")))
        assertEquals(mapOf("path" to "/event"), deep.foundationValue)
    }

    @Test fun groupActionsUseDottedHosts() = runBlocking {
        ModuleRegistry.shared.register { EchoMod() }
        val res = dsx.module["ct.echo"]["rag.add"]()                 // group key: "rag.add"
        assertEquals("rag-added", res.foundationValue)
    }

    @Test fun hasReportsLoadedSchemes() {
        ModuleRegistry.shared.register { EchoMod() }
        assertTrue(dsx.has("ct.echo"))
        assertFalse(dsx.has("ct.absent"))
    }

    // -- exposed:false — off the untrusted bus, reachable in-process --

    private class SecretsMod : Module() {
        override val scheme get() = "ct.sec"
        override fun setup() {
            dsx.action { dsx -> dsx.skip() }                          // prefilter present → misses error out
            dsx.action("public") { dsx -> dsx.resolve("pub") }
            dsx.action("secret", exposed = false) { dsx -> dsx.resolve("classified") }
        }
    }

    @Test fun internalActionRejectedForWebRelayOrigin() = capturingWeb { received ->
        ModuleRegistry.shared.register { SecretsMod() }
        // Web relay (includeInternal = false): the internal action is INVISIBLE —
        // the miss settles as unknown_action, never the handler.
        assertTrue(ModuleRegistry.shared.handle(
            scheme = "ct.sec", actionPath = "secret",
            params = Bridge.Params(dict = emptyMap(), requestID = "w1", surfaceID = "web"),
            includeInternal = false))
        assertEquals(
            mapOf("id" to "w1", "scheme" to "ct.sec", "host" to "secret",
                  "event" to "error", "final" to true, "data" to mapOf("action" to "secret"),
                  "code" to "unknown_action", "recoverable" to false),
            received[0].payload)
        // In-process dsx.module (includeInternal = true): reachable.
        runBlocking {
            assertEquals("classified", dsx.module["ct.sec"]["secret"]().foundationValue)
        }
    }

    private class NoPrefilterSecretsMod : Module() {
        override val scheme get() = "ct.sec2"
        override fun setup() {
            dsx.action("secret", exposed = false) { dsx -> dsx.resolve("classified") }
        }
    }

    @Test fun internalActionWithoutPrefilterIsNotOursOnTheWebBus() {
        ModuleRegistry.shared.register { NoPrefilterSecretsMod() }
        // No prefilter + no public named match → "not ours" (false): the web relay
        // falls through exactly as if the action didn't exist.
        assertFalse(ModuleRegistry.shared.handle(
            scheme = "ct.sec2", actionPath = "secret",
            params = Bridge.Params(dict = emptyMap(), requestID = "w2", surfaceID = "web"),
            includeInternal = false))
        runBlocking {
            assertEquals("classified", dsx.module["ct.sec2"]["secret"]().foundationValue)
        }
    }

    // -- dsx.scheme scoping: aliases isolate action tables --

    private class MultiMod : Module() {
        override val scheme get() = "ct.multi"
        override fun setup() {
            dsx.action("add") { dsx -> dsx.resolve("primary-add") }
            dsx.scheme("ct.multirag") {
                dsx.action("add") { dsx -> dsx.resolve("rag-add") }
            }
        }
    }

    @Test fun scopedSchemeIsIsolatedFromPrimary() = runBlocking {
        val saved = GeneratedModuleSchemes.aliasesByClassName
        GeneratedModuleSchemes.aliasesByClassName = saved + ("MultiMod" to listOf("ct.multirag"))
        try {
            ModuleRegistry.shared.register { MultiMod() }
            assertEquals("primary-add", dsx.module["ct.multi"]["add"]().foundationValue)
            assertEquals("rag-add", dsx.module["ct.multirag"]["add"]().foundationValue)
            // The scoped scheme does NOT fall back to the primary table.
            val e = assertFailsWith<ModuleCallError.ActionFailed> {
                dsx.module["ct.multirag"]["orphan"]()
            }
            assertEquals("unknown_action", e.code)
        } finally { GeneratedModuleSchemes.aliasesByClassName = saved }
    }

    // -- dsx.delegate: listen / send / allows + the typed event fold --

    private class DelegateMod : Module() {
        override val scheme get() = "ct.del"
        override fun setup() {
            dsx.delegate.listen("ct.evt.pick") { "first" }
            dsx.delegate.listen("ct.evt.pick") { "second" }
            dsx.delegate.listen("ct.evt.gate") { input -> (input as? Int ?: 0) < 10 }
            dsx.delegate.listen("ct.evt.gather") { 1 }
            dsx.delegate.listen("ct.evt.gather") { 2 }
            dsx.delegate["ct.evt.enrich"] { _ -> JSON.obj().put("extra", 1) }
        }
    }

    private companion object {
        /// Hooks fold across allPackages, so registering DelegateMod once keeps the
        /// two delegate tests from doubling each other's answers (order-independent).
        private val delegateModRegistration by lazy {
            ModuleRegistry.shared.register { DelegateMod() }
        }
    }
    private fun registerDelegateModOnce() { delegateModRegistration }

    @Test fun delegateListenSendAllows() {
        registerDelegateModOnce()
        assertEquals("first", dsx.delegate.send("ct.evt.pick"))       // undeclared → claim
        assertEquals(true, dsx.delegate.allows("ct.evt.gate", 3))     // veto passes
        assertEquals(false, dsx.delegate.allows("ct.evt.gate", 50))   // vetoed
        assertEquals(true, dsx.delegate.allows("ct.evt.unwatched"))   // ungated always proceeds
        assertEquals(listOf<Any>(1, 2),
            dsx.delegate.send("ct.evt.gather", combine = ModuleRegistry.Combine.collect))
    }

    @Test fun delegateEventAttachAndInvoke_declaredCombine() {
        registerDelegateModOnce()
        // Undeclared → claim: the attach answers.
        assertEquals(mapOf("extra" to 1), dsx.delegate["ct.evt.enrich"](JSON.obj())?.foundationValue)
        // Declared collect (GeneratedDelegateRegistry) folds every answer.
        val saved = GeneratedDelegateRegistry.byEvent
        GeneratedDelegateRegistry.byEvent = saved +
            ("ct.evt.gather" to GeneratedDelegateRegistry.Spec(combine = "collect"))
        try {
            assertEquals(listOf(1, 2), dsx.delegate["ct.evt.gather"]()?.foundationValue)
        } finally { GeneratedDelegateRegistry.byEvent = saved }
    }

    // -- declarative action gate (manifest veto) --

    private class GatedMod : Module() {
        override val scheme get() = "ct.gated"
        override fun setup() {
            dsx.action("track") { dsx -> ran = true; dsx.resolve("tracked") }
        }
        companion object { var ran = false }
    }
    private class GateKeeperMod : Module() {
        override val scheme get() = "ct.gatekeeper"
        override fun setup() { dsx.delegate.listen("ct.gated.willTrack") { false } }   // deny
    }

    @Test fun declaredGateBlocksActionBeforeHandler() = capturingWeb { received ->
        val saved = GeneratedActionGates.byScheme
        GeneratedActionGates.byScheme = saved + ("ct.gated" to mapOf("track" to "willTrack"))
        try {
            ModuleRegistry.shared.register { GatedMod() }
            ModuleRegistry.shared.register { GateKeeperMod() }
            GatedMod.ran = false
            assertTrue(ModuleRegistry.shared.handle(
                scheme = "ct.gated", actionPath = "track",
                params = Bridge.Params(dict = emptyMap(), requestID = "g1", surfaceID = "web")))
            assertFalse(GatedMod.ran)                                 // the handler never ran
            assertEquals(mapOf("ok" to false, "blocked" to "willTrack"), received[0].payload["data"])
            assertEquals("result", received[0].payload["event"])      // gate denial RESOLVES
        } finally { GeneratedActionGates.byScheme = saved }
    }

    // -- export / object --

    private class ExporterMod : Module() {
        override val scheme get() = "ct.exp"
        fun publish(handle: Any) { dsx.export("thing", handle) }
    }

    @Test fun exportedObjectIsOwnerNamespaced() {
        val exporter = ExporterMod()
        ModuleRegistry.shared.register { exporter }
        val handle = Any()
        exporter.publish(handle)
        assertSame(handle, dsx.module["ct.exp"].`object`("thing"))
        assertNull(dsx.module["ct.exp"].`object`("other"))
    }

    // -- mounted-surface generation routing --

    private class DelayedMessengerMod : Module() {
        override val scheme get() = "ct.delayed-messenger"

        override fun setup() {
            dsx.action("hold") { call ->
                val slot = call.args("slot") as? String ?: error("missing slot")
                pending[slot] = call
            }
        }

        companion object {
            val pending = LinkedHashMap<String, Context>()
        }
    }

    @Test fun delayedMountedRepliesNeverRetargetAReplacementWithTheSameRid() {
        val previousDispatch = DSXMessengerMount.dispatch
        val previousMountedDispatch = DSXMessengerMount.mountedDispatch
        val previousInbound = DSXMessenger.inboundMainExecutor
        val previousOutbound = DSXMessenger.outboundMainExecutor
        DSXMessenger.inboundMainExecutor = Executor { it.run() }
        DSXMessenger.outboundMainExecutor = Executor { it.run() }
        DSXMessengerMount.bindRegistry()
        try {
            if (!ModuleRegistry.shared.isAvailable("ct.delayed-messenger")) {
                ModuleRegistry.shared.register { DelayedMessengerMod() }
            }

            fun exercise(
                label: String,
                expectedEvent: String,
                settle: (Context) -> Unit,
            ) {
                val surfaceID = "ct-generation-$label"
                val staleReceived = ArrayList<DSXEgress>()
                val currentReceived = ArrayList<DSXEgress>()
                val stale = DSXMessenger().mount(surfaceID) { staleReceived += it }
                var current: DSXMessengerMount? = null
                try {
                    stale.receive(
                        "ct.delayed-messenger",
                        "hold",
                        mapOf("slot" to "$label-stale"),
                        "same-rid",
                    )
                    val staleCall = checkNotNull(DelayedMessengerMod.pending["$label-stale"])

                    current = DSXMessenger().mount(surfaceID) { currentReceived += it }
                    current.receive(
                        "ct.delayed-messenger",
                        "hold",
                        mapOf("slot" to "$label-current"),
                        "same-rid",
                    )
                    val currentCall = checkNotNull(DelayedMessengerMod.pending["$label-current"])

                    settle(staleCall)
                    assertTrue(staleReceived.isEmpty())
                    assertTrue(
                        currentReceived.isEmpty(),
                        "old $label reply must not settle the replacement's reused rid",
                    )

                    settle(currentCall)
                    assertEquals(listOf(expectedEvent), currentReceived.map { it.payload["event"] })
                    assertEquals(listOf("same-rid"), currentReceived.map { it.rid })
                    assertEquals(listOf(surfaceID), currentReceived.map { it.target })
                } finally {
                    stale.unmount()
                    current?.unmount()
                }
            }

            exercise("resolve", "result") { it.resolve("done") }
            exercise("error", "error") { it.error("delayed_failure") }
            exercise("event", "progress") { it.event("progress", 1) }
        } finally {
            DelayedMessengerMod.pending.clear()
            DSXMessengerMount.dispatch = previousDispatch
            DSXMessengerMount.mountedDispatch = previousMountedDispatch
            DSXMessenger.inboundMainExecutor = previousInbound
            DSXMessenger.outboundMainExecutor = previousOutbound
        }
    }

    @Test fun clearedMountedGenerationMarkerDropsInsteadOfFallingBackToPublicId() {
        val previousDispatch = DSXMessengerMount.dispatch
        val previousMountedDispatch = DSXMessengerMount.mountedDispatch
        val previousInbound = DSXMessenger.inboundMainExecutor
        val previousOutbound = DSXMessenger.outboundMainExecutor
        DSXMessenger.inboundMainExecutor = Executor { it.run() }
        DSXMessenger.outboundMainExecutor = Executor { it.run() }
        var admittedParams: Bridge.Params? = null
        DSXMessengerMount.mountedDispatch = { scheme, action, args, rid, surfaceID, registration ->
            val params = Bridge.Params(args, rid, surfaceID, registration)
            admittedParams = params
            ModuleRegistry.shared.handle(scheme, action, params, includeInternal = false)
        }
        val replacementReceived = ArrayList<DSXEgress>()
        val stale = DSXMessenger().mount("ct-generation-cleared") { }
        var replacement: DSXMessengerMount? = null
        try {
            if (!ModuleRegistry.shared.isAvailable("ct.delayed-messenger")) {
                ModuleRegistry.shared.register { DelayedMessengerMod() }
            }
            stale.receive(
                "ct.delayed-messenger",
                "hold",
                mapOf("slot" to "cleared-stale"),
                "same-rid",
            )
            val staleCall = checkNotNull(DelayedMessengerMod.pending["cleared-stale"])
            val params = checkNotNull(admittedParams)
            replacement = DSXMessenger().mount("ct-generation-cleared") {
                replacementReceived += it
            }

            val referenceField = Bridge.Params::class.java
                .getDeclaredField("messengerRegistrationRef")
                .apply { isAccessible = true }
            (referenceField.get(params) as WeakReference<*>).clear()
            assertTrue(params.hasMessengerRegistration)
            assertNull(params.messengerRegistration)

            staleCall.resolve("must-drop")
            assertTrue(replacementReceived.isEmpty())
        } finally {
            DelayedMessengerMod.pending.clear()
            stale.unmount()
            replacement?.unmount()
            DSXMessengerMount.dispatch = previousDispatch
            DSXMessengerMount.mountedDispatch = previousMountedDispatch
            DSXMessenger.inboundMainExecutor = previousInbound
            DSXMessenger.outboundMainExecutor = previousOutbound
        }
    }

    // -- broadcasts: native-only + explicit scheme --

    private class TickerMod : Module() {
        override val scheme get() = "ct.ticker"
        fun tickNative() { dsx.broadcastNative("tick", 60) }
        fun appearOn() { dsx.broadcast("ct.dsx-view", "appear", mapOf("route" to "/home")) }
    }

    private class MainFunnelMod : Module() {
        override val scheme get() = "ct.main-funnel"
        fun emit() { dsx.broadcast("frame", 1) }
        fun emitNative() { dsx.broadcastNative("native-frame", 2) }
    }

    @Test fun broadcastNativeSkipsTheMountedSurfaces() = capturingWeb { received ->
        val ticker = TickerMod()
        ModuleRegistry.shared.register { ticker }
        val native = mutableListOf<Pair<String, Any?>>()
        val sub = DSXEvents().on("ct.ticker") { event, data -> native.add(event to data) }
        try {
            ticker.tickNative()
            assertEquals(listOf<Pair<String, Any?>>("tick" to 60), native)
            assertEquals(0, received.size)                            // NO web/messenger round-trip
        } finally { sub.cancel() }
    }

    @Test fun broadcastOnExplicitSchemeCarriesThatScheme() = capturingWeb { received ->
        val ticker = TickerMod()
        ModuleRegistry.shared.register { ticker }
        ticker.appearOn()
        assertEquals(
            mapOf("id" to null, "scheme" to "ct.dsx-view", "host" to "",
                  "event" to "appear", "final" to true, "data" to mapOf("route" to "/home")),
            received[0].payload)
    }

    @ResourceLock("ModuleRegistry.mainExecutor")
    @Test fun broadcastsHopAsOneMainTaskWithPrimaryAliasAtomicOrder() {
        val savedRegistryExecutor = ModuleRegistry.shared.mainExecutor
        val savedMessengerExecutor = DSXMessenger.outboundMainExecutor
        val savedEventExecutor = DSXEvents.mainExecutor
        val savedAliases = GeneratedModuleSchemes.aliasesByClassName
        val queued = ArrayDeque<Runnable>()
        val order = ArrayList<String>()
        val callbackThreads = ArrayList<Thread>()
        val testThread = Thread.currentThread()
        var mount: DSXMessengerMount? = null
        var primary: DSXEventSubscription? = null
        var alias: DSXEventSubscription? = null
        try {
            GeneratedModuleSchemes.aliasesByClassName = savedAliases +
                (MainFunnelMod::class.java.simpleName to listOf("ct.main-funnel-alias"))
            val module = MainFunnelMod()
            ModuleRegistry.shared.register { module }
            DSXMessenger.outboundMainExecutor = Executor { it.run() }
            DSXEvents.mainExecutor = Executor { it.run() }
            mount = DSXMessenger().mount("ct-main-funnel-surface") { egress ->
                callbackThreads += Thread.currentThread()
                order += "surface:${egress.scheme}:${egress.payload["event"]}"
            }
            primary = DSXEvents().on("ct.main-funnel") { event, _ ->
                callbackThreads += Thread.currentThread()
                order += "native:ct.main-funnel:$event"
            }
            alias = DSXEvents().on("ct.main-funnel-alias") { event, _ ->
                callbackThreads += Thread.currentThread()
                order += "native:ct.main-funnel-alias:$event"
            }
            ModuleRegistry.shared.mainExecutor = Executor { queued.addLast(it) }

            Thread(module::emit).also { it.start(); it.join(10_000); assertFalse(it.isAlive) }
            assertTrue(order.isEmpty())
            assertEquals(1, queued.size)
            queued.removeFirst().run()
            assertEquals(
                listOf(
                    "surface:ct.main-funnel:frame",
                    "native:ct.main-funnel:frame",
                    "surface:ct.main-funnel-alias:frame",
                    "native:ct.main-funnel-alias:frame",
                ),
                order,
            )

            Thread(module::emitNative).also { it.start(); it.join(10_000); assertFalse(it.isAlive) }
            assertEquals(1, queued.size)
            queued.removeFirst().run()
            assertEquals("native:ct.main-funnel:native-frame", order.last())
            assertTrue(callbackThreads.all { it === testThread })
        } finally {
            alias?.cancel()
            primary?.cancel()
            mount?.unmount()
            GeneratedModuleSchemes.aliasesByClassName = savedAliases
            DSXEvents.mainExecutor = savedEventExecutor
            DSXMessenger.outboundMainExecutor = savedMessengerExecutor
            ModuleRegistry.shared.mainExecutor = savedRegistryExecutor
        }
    }

    // -- container (KV seam, in-memory default) --

    private class StorerMod : Module() {
        override val scheme get() = "ct.store"
    }

    @Test fun containerScopedKVAndForeignGuard() {
        val savedBackend = Container.backend
        Container.backend = InMemoryContainerKV()
        try {
            val own = StorerMod().dsx.container
            assertEquals("ct.store", own.name)
            own.set("player_id", "p1")
            own.set("count", 3)
            own.set("ratio", 1.5)
            own.set("flag", true)
            assertEquals("p1", own.string("player_id"))
            assertEquals(3, own.int("count"))
            assertEquals(1.5, own.double("ratio"))
            assertEquals(true, own.bool("flag"))
            // Another package READS by name, but cannot write/remove/post.
            val foreign = Module().dsx.container["ct.store"]
            assertEquals("p1", foreign.string("player_id"))
            foreign.set("player_id", "hacked")                        // denied, no-op
            assertEquals("p1", own.string("player_id"))
            own.set("player_id", null)                                // null removes
            assertNull(own.string("player_id"))
            assertFalse(own.isAvailable)                              // no file container on pure JVM
            assertNull(own.url())
        } finally { Container.backend = savedBackend }
    }

    @Test fun containerObserveSignalsOncePerBatch() {
        val savedBackend = Container.backend
        Container.backend = InMemoryContainerKV()
        try {
            val own = StorerMod().dsx.container
            var signals = 0
            val sub = own.observe { signals += 1 }
            try {
                own.set("a", 1)                                       // auto-post
                assertEquals(1, signals)
                own.batch { it.set("b", 2); it.set("c", 3) }          // ONE signal for the batch
                assertEquals(2, signals)
                own.post()                                            // signal without writing
                assertEquals(3, signals)
            } finally { sub.cancel() }
            own.set("d", 4)                                           // cancelled: no signal
            assertEquals(3, signals)
        } finally { Container.backend = savedBackend }
    }

    @Test fun queuedContainerSignalDoesNotInvokeObserverAfterCancelReturns() {
        val queued = ArrayDeque<Runnable>()
        val previousExecutor = Container.observerMainExecutor
        val own = StorerMod().dsx.container
        var signals = 0
        Container.observerMainExecutor = java.util.concurrent.Executor { queued.addLast(it) }
        val subscription = own.observe { signals += 1 }
        try {
            val signalName = "${own.group}.changed.${own.name}"
            ContainerObservers.shared.fire(signalName)
            assertEquals(1, queued.size)

            subscription.cancel()
            queued.removeFirst().run()

            assertEquals(0, signals)
        } finally {
            Container.observerMainExecutor = previousExecutor
            subscription.cancel()
        }
    }

    // -- dsx.fetch seam --

    @Test fun fetchDefaultRejects_installedSeamServes() = runBlocking {
        val saved = Context.fetchImpl
        Context.fetchImpl = null
        try {
            val e = assertFailsWith<FetchError.Transport> { dsx.fetch("https://api.example.com/x") }
            assertEquals("network", e.code)
            Context.fetchImpl = { url, method, headers, query, body, _ ->
                assertEquals("https://api.example.com/x", url)
                assertEquals("POST", method)
                assertEquals(mapOf("Authorization" to "Bearer t"), headers)
                assertEquals(mapOf("q" to "1"), query)
                assertEquals(mapOf("balance" to 50), body)
                FetchResponse(status = 200, headers = mapOf("Content-Type" to "application/json"),
                              body = """{"ok":true,"n":2}""".toByteArray())
            }
            val res = dsx.fetch("https://api.example.com/x", method = "POST",
                                headers = mapOf("Authorization" to "Bearer t"),
                                query = mapOf("q" to "1"), body = mapOf("balance" to 50))
            assertTrue(res.ok)
            assertEquals(200, res.status)
            assertEquals(mapOf("ok" to true, "n" to 2), res.dictionary)
            assertEquals("""{"ok":true,"n":2}""", res.text())
        } finally { Context.fetchImpl = saved }
    }

    @Test fun controlFetchPrefersBoundedSeamAndFallsBackForPureJvmHosts() = runBlocking {
        val savedAPI = Context.fetchImpl
        val savedControl = Context.controlFetchImpl
        try {
            Context.fetchImpl = { _, _, _, _, _, _ ->
                FetchResponse(status = 201, headers = emptyMap(), body = "api".toByteArray())
            }
            Context.controlFetchImpl = { _, _, _, _, _, _ ->
                FetchResponse(status = 202, headers = emptyMap(), body = "control".toByteArray())
            }
            assertEquals(202, dsx.fetchControl("https://app.example/routes.json").status)

            Context.controlFetchImpl = null
            assertEquals(201, dsx.fetchControl("https://app.example/routes.json").status)
        } finally {
            Context.fetchImpl = savedAPI
            Context.controlFetchImpl = savedControl
        }
    }

    // -- cookies (settable seam) --

    private class CookieWatcherMod : Module() {
        override val scheme get() = "ct.cookiewatch"
        override fun setup() { dsx.delegate.listen("cookie.webWrite") { input -> webWrites.add(input); null } }
        companion object { val webWrites = Collections.synchronizedList(mutableListOf<Any?>()) }
    }

    private class CookieRejectionWatcherMod : Module() {
        override val scheme get() = "ct.cookie-rejection-watch"
        override fun setup() { dsx.delegate.listen("cookie.webWrite") { input -> webWrites.add(input); null } }
        companion object { val webWrites = Collections.synchronizedList(mutableListOf<Any?>()) }
    }

    private class CookieOrderingWatcherMod : Module() {
        override val scheme get() = "ct.cookie-ordering-watch"
        override fun setup() {
            dsx.delegate.listen("cookie.webWrite") { input ->
                (input as? java.net.HttpCookie)?.let { onWrite?.invoke(it) }
                null
            }
        }
        companion object {
            @Volatile var onWrite: ((java.net.HttpCookie) -> Unit)? = null
        }
    }

    @ResourceLock("DSXCookies.shared")
    @Test fun cookieJarIngestAndSeamedSet() {
        // ONE method owns the process-global DSXCookies.shared (domain-hint ordering).
        val mirrored = mutableListOf<java.net.HttpCookie>()
        val savedStore = DSXCookies.shared.nativeStore
        val savedExecutor = DSXCookies.shared.mainExecutor
        val published = mutableListOf<Map<String, String>>()
        DSXCookies.shared.resetForTests()
        DSXCookies.shared.mainExecutor = java.util.concurrent.Executor { it.run() }
        DSXCookies.shared.nativeStore = { mirrored.add(it) }
        val subscription = DSXCookies.shared.sink { published += it }
        try {
            // Before any host is known: set() no-ops (logs).
            DSXCookies.shared.set("early", "x")
            assertNull(DSXCookies.shared.jar["early"])

            val session = java.net.HttpCookie("session", "abc").also { it.domain = ".app.example.com" }
            val serverCredential = java.net.HttpCookie("server-token", "must-not-leak").also {
                it.domain = ".app.example.com"
                it.isHttpOnly = true
            }
            DSXCookies.shared.ingest(listOf(session, serverCredential))
            assertEquals(mapOf("session" to "abc"), DSXCookies.shared.jar)
            assertEquals(listOf(session, serverCredential), mirrored)
            assertEquals(2, mirrored.size)                            // both remain available to native HTTP

            CookieWatcherMod.webWrites.clear()
            ModuleRegistry.shared.register { CookieWatcherMod() }
            DSXCookies.shared.set("sid", "42")                        // domain defaults to the ingested hint
            assertEquals("42", DSXCookies.shared.jar["sid"])
            assertEquals(3, mirrored.size)
            assertEquals("app.example.com", mirrored[2].domain)       // leading dot stripped from the hint
            assertEquals(1, CookieWatcherMod.webWrites.size)          // fired for the dom module to mirror

            DSXCookies.shared.set(
                "sid",
                "expired",
                expires = java.util.Date(System.currentTimeMillis() - 1_000),
            )
            assertNull(DSXCookies.shared.jar["sid"])
            assertNull(DSXCookies.shared.jarFlow.value["sid"])
            assertTrue(published.last()["sid"] == null)
        } finally {
            subscription.cancel()
            DSXCookies.shared.resetForTests()
            DSXCookies.shared.nativeStore = savedStore
            DSXCookies.shared.mainExecutor = savedExecutor
        }
    }

    @ResourceLock("DSXCookies.shared")
    @Test fun cookieSinkCancelSuppressesAQueuedCurrentSnapshot() {
        val savedExecutor = DSXCookies.shared.mainExecutor
        DSXCookies.shared.resetForTests()
        DSXCookies.shared.mainExecutor = java.util.concurrent.Executor { it.run() }
        val queued = ArrayDeque<Runnable>()
        DSXCookies.shared.mainExecutor = java.util.concurrent.Executor { queued.addLast(it) }
        var subscription: AnyCancellable? = null
        try {
            var calls = 0
            val activeSubscription = DSXCookies.shared.sink { calls += 1 }
            subscription = activeSubscription
            assertEquals(1, queued.size)

            activeSubscription.cancel()
            queued.removeFirst().run()

            assertEquals(0, calls)
        } finally {
            subscription?.cancel()
            DSXCookies.shared.resetForTests()
            DSXCookies.shared.mainExecutor = savedExecutor
        }
    }

    @ResourceLock("DSXCookies.shared")
    @Test fun earlierCookieSinkCanCancelALaterSinkInTheSamePublication() {
        val savedStore = DSXCookies.shared.nativeStore
        val savedExecutor = DSXCookies.shared.mainExecutor
        DSXCookies.shared.resetForTests()
        DSXCookies.shared.nativeStore = {}
        DSXCookies.shared.mainExecutor = java.util.concurrent.Executor { it.run() }
        var later: AnyCancellable? = null
        var laterUpdates = 0
        val earlier = DSXCookies.shared.sink { snapshot ->
            if (snapshot.containsKey("lifecycle-cookie")) later?.cancel()
        }
        try {
            later = DSXCookies.shared.sink { snapshot ->
                if (snapshot.containsKey("lifecycle-cookie")) laterUpdates += 1
            }
            val cookie = java.net.HttpCookie("lifecycle-cookie", "1").also {
                it.domain = "app.example.com"
            }

            DSXCookies.shared.ingest(listOf(cookie))

            assertEquals(0, laterUpdates)
        } finally {
            later?.cancel()
            earlier.cancel()
            DSXCookies.shared.resetForTests()
            DSXCookies.shared.nativeStore = savedStore
            DSXCookies.shared.mainExecutor = savedExecutor
        }
    }

    @ResourceLock("DSXCookies.shared")
    @Test fun reorderedCurrentCookieSnapshotDrainsBeforeEveryNewerPublication() {
        val savedStore = DSXCookies.shared.nativeStore
        val savedExecutor = DSXCookies.shared.mainExecutor
        DSXCookies.shared.resetForTests()
        DSXCookies.shared.nativeStore = {}
        DSXCookies.shared.mainExecutor = java.util.concurrent.Executor { it.run() }
        val executor = FirstSubmissionLastExecutor()
        val seen = ArrayList<Map<String, String>>()
        var subscription: AnyCancellable? = null
        var failure: Throwable? = null
        var mutationFailure: Throwable? = null
        var ingesting: Thread? = null
        DSXCookies.shared.mainExecutor = executor
        val subscribing = Thread {
            try {
                subscription = DSXCookies.shared.sink { seen += it }
            } catch (error: Throwable) {
                failure = error
            }
        }.apply { isDaemon = true }
        subscribing.start()
        try {
            assertTrue(executor.awaitFirstSubmission())
            val cookie = java.net.HttpCookie("revision-cookie", "new").also {
                it.domain = "app.example.com"
            }
            ingesting = Thread {
                try {
                    DSXCookies.shared.ingest(listOf(cookie)) // queued before the blocked current snapshot
                } catch (error: Throwable) {
                    mutationFailure = error
                }
            }.apply { isDaemon = true; start() }
            val enqueueDeadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10)
            while (executor.queuedCount() != 1 && System.nanoTime() < enqueueDeadline) Thread.yield()
            assertEquals(1, executor.queuedCount())
            executor.releaseFirstSubmission()
            subscribing.join(10_000)
            assertFalse(subscribing.isAlive)
            failure?.let { throw AssertionError("subscription failed", it) }
            assertEquals(2, executor.queuedCount())

            executor.drain()
            ingesting?.join(10_000)
            assertFalse(ingesting?.isAlive == true)
            mutationFailure?.let { throw AssertionError("cookie mutation failed", it) }

            assertEquals(listOf(emptyMap(), mapOf("revision-cookie" to "new")), seen)
        } finally {
            executor.releaseFirstSubmission()
            executor.drain()
            subscribing.join(10_000)
            ingesting?.join(10_000)
            subscription?.cancel()
            DSXCookies.shared.resetForTests()
            DSXCookies.shared.nativeStore = savedStore
            DSXCookies.shared.mainExecutor = savedExecutor
        }
    }

    @ResourceLock("DSXCookies.shared")
    @Test fun rejectedCookieSinkSchedulingRemovesTheRegistration() {
        val savedStore = DSXCookies.shared.nativeStore
        val savedExecutor = DSXCookies.shared.mainExecutor
        DSXCookies.shared.resetForTests()
        var calls = 0
        try {
            DSXCookies.shared.nativeStore = {}
            DSXCookies.shared.mainExecutor = Executor {
                throw RejectedExecutionException("intentional cookie sink rejection")
            }
            assertFailsWith<RejectedExecutionException> {
                DSXCookies.shared.sink { calls += 1 }
            }

            DSXCookies.shared.mainExecutor = Executor { it.run() }
            DSXCookies.shared.ingest(listOf(java.net.HttpCookie("after-rejection", "1")))
            assertEquals(0, calls)
        } finally {
            DSXCookies.shared.resetForTests()
            DSXCookies.shared.nativeStore = savedStore
            DSXCookies.shared.mainExecutor = savedExecutor
        }
    }

    @ResourceLock("DSXCookies.shared")
    @Test fun throwingInlineCookieInitialHandlerRemovesTheRegistration() {
        val savedStore = DSXCookies.shared.nativeStore
        val savedExecutor = DSXCookies.shared.mainExecutor
        DSXCookies.shared.resetForTests()
        var calls = 0
        try {
            DSXCookies.shared.nativeStore = {}
            DSXCookies.shared.mainExecutor = Executor { it.run() }
            assertFailsWith<IllegalStateException> {
                DSXCookies.shared.sink {
                    calls += 1
                    throw IllegalStateException("intentional cookie initial failure")
                }
            }
            assertEquals(1, calls)

            DSXCookies.shared.ingest(listOf(java.net.HttpCookie("after-handler-failure", "1")))
            assertEquals(1, calls)
        } finally {
            DSXCookies.shared.resetForTests()
            DSXCookies.shared.nativeStore = savedStore
            DSXCookies.shared.mainExecutor = savedExecutor
        }
    }

    @ResourceLock("DSXCookies.shared")
    @Test fun rejectedCookieMutationIsFailClosedAndCanRetryCleanly() {
        val savedStore = DSXCookies.shared.nativeStore
        val savedExecutor = DSXCookies.shared.mainExecutor
        DSXCookies.shared.resetForTests()
        val nativeWrites = Collections.synchronizedList(mutableListOf<java.net.HttpCookie>())
        try {
            CookieRejectionWatcherMod.webWrites.clear()
            ModuleRegistry.shared.register { CookieRejectionWatcherMod() }
            DSXCookies.shared.nativeStore = { nativeWrites.add(it) }
            DSXCookies.shared.mainExecutor = Executor { it.run() }
            DSXCookies.shared.setDomainHint("app.example.com")
            DSXCookies.shared.mainExecutor = Executor {
                throw RejectedExecutionException("intentional cookie publication rejection")
            }
            assertFailsWith<RejectedExecutionException> {
                DSXCookies.shared.set("rollback-cookie", "new")
            }
            assertEquals(emptyMap(), DSXCookies.shared.jar)
            assertEquals(emptyMap(), DSXCookies.shared.jarFlow.value)
            assertEquals(emptyList(), nativeWrites)
            assertEquals(emptyList(), CookieRejectionWatcherMod.webWrites)

            DSXCookies.shared.mainExecutor = Executor { it.run() }
            DSXCookies.shared.set("rollback-cookie", "new")
            assertEquals(mapOf("rollback-cookie" to "new"), DSXCookies.shared.jar)
            assertEquals(DSXCookies.shared.jar, DSXCookies.shared.jarFlow.value)
            assertEquals(listOf("new"), nativeWrites.map { it.value })
            assertEquals(
                listOf("new"),
                CookieRejectionWatcherMod.webWrites.map { (it as java.net.HttpCookie).value },
            )
        } finally {
            DSXCookies.shared.resetForTests()
            DSXCookies.shared.nativeStore = savedStore
            DSXCookies.shared.mainExecutor = savedExecutor
        }
    }

    @ResourceLock("DSXCookies.shared")
    @Test fun concurrentSameNameCookieWritesHaveOneCrossPlaneOrderAndWinner() {
        val savedStore = DSXCookies.shared.nativeStore
        val savedExecutor = DSXCookies.shared.mainExecutor
        DSXCookies.shared.resetForTests()
        val events = Collections.synchronizedList(mutableListOf<String>())
        val nativeValues = Collections.synchronizedList(mutableListOf<String>())
        val webValues = Collections.synchronizedList(mutableListOf<String>())
        val firstNativeEntered = java.util.concurrent.CountDownLatch(1)
        val releaseFirstNative = java.util.concurrent.CountDownLatch(1)
        val secondNativeEntered = java.util.concurrent.CountDownLatch(1)
        val firstFailure = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        val secondFailure = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        var subscription: AnyCancellable? = null
        var first: Thread? = null
        var second: Thread? = null
        try {
            ModuleRegistry.shared.register { CookieOrderingWatcherMod() }
            CookieOrderingWatcherMod.onWrite = { cookie ->
                webValues.add(cookie.value)
                events.add("web:${cookie.value}")
            }
            DSXCookies.shared.mainExecutor = Executor { it.run() }
            DSXCookies.shared.setDomainHint("app.example.com")
            DSXCookies.shared.nativeStore = { cookie ->
                nativeValues.add(cookie.value)
                events.add("native:${cookie.value}")
                if (cookie.value == "first") {
                    firstNativeEntered.countDown()
                    check(releaseFirstNative.await(10, java.util.concurrent.TimeUnit.SECONDS)) {
                        "timed out releasing the first native cookie write"
                    }
                } else if (cookie.value == "second") {
                    secondNativeEntered.countDown()
                }
            }
            subscription = DSXCookies.shared.sink { snapshot ->
                snapshot["same-name"]?.let { events.add("sink:$it") }
            }

            val firstThread = Thread {
                try {
                    DSXCookies.shared.set("same-name", "first")
                } catch (error: Throwable) {
                    firstFailure.set(error)
                }
            }.apply { isDaemon = true }
            first = firstThread
            firstThread.start()
            assertTrue(firstNativeEntered.await(10, java.util.concurrent.TimeUnit.SECONDS))

            val secondThread = Thread {
                try {
                    DSXCookies.shared.set("same-name", "second")
                } catch (error: Throwable) {
                    secondFailure.set(error)
                }
            }.apply { isDaemon = true }
            second = secondThread
            secondThread.start()

            // The old split transaction reached nativeStore concurrently here, letting
            // native, jar and web storage choose different same-name winners.
            assertFalse(secondNativeEntered.await(250, java.util.concurrent.TimeUnit.MILLISECONDS))
            releaseFirstNative.countDown()
            firstThread.join(10_000)
            secondThread.join(10_000)
            assertFalse(firstThread.isAlive)
            assertFalse(secondThread.isAlive)
            firstFailure.get()?.let { throw AssertionError("first cookie write failed", it) }
            secondFailure.get()?.let { throw AssertionError("second cookie write failed", it) }

            assertEquals(
                listOf(
                    "native:first", "sink:first", "web:first",
                    "native:second", "sink:second", "web:second",
                ),
                events.toList(),
            )
            assertEquals(listOf("first", "second"), nativeValues.toList())
            assertEquals(listOf("first", "second"), webValues.toList())
            assertEquals("second", DSXCookies.shared.jar["same-name"])
            assertEquals("second", DSXCookies.shared.jarFlow.value["same-name"])
        } finally {
            releaseFirstNative.countDown()
            first?.join(10_000)
            second?.join(10_000)
            subscription?.cancel()
            CookieOrderingWatcherMod.onWrite = null
            DSXCookies.shared.resetForTests()
            DSXCookies.shared.nativeStore = savedStore
            DSXCookies.shared.mainExecutor = savedExecutor
        }
    }

    @ResourceLock("DSXCookies.shared")
    @Test fun concurrentCookieSetsDoNotLoseKeysAndPublicationsNeverRegress() {
        val savedStore = DSXCookies.shared.nativeStore
        val savedExecutor = DSXCookies.shared.mainExecutor
        DSXCookies.shared.resetForTests()
        val seenSizes = Collections.synchronizedList(mutableListOf<Int>())
        val flowSizes = Collections.synchronizedList(mutableListOf<Int>())
        var subscription: AnyCancellable? = null
        try {
            DSXCookies.shared.nativeStore = {}
            DSXCookies.shared.mainExecutor = Executor { it.run() }
            DSXCookies.shared.setDomainHint("app.example.com")
            subscription = DSXCookies.shared.sink { snapshot ->
                seenSizes += snapshot.size
                flowSizes += DSXCookies.shared.jarFlow.value.size
            }
            val workers = (0 until 32).map { index ->
                Thread { DSXCookies.shared.set("concurrent-$index", "$index") }.apply { isDaemon = true }
            }
            workers.forEach(Thread::start)
            workers.forEach { it.join(10_000) }
            assertTrue(workers.none(Thread::isAlive))

            assertEquals((0..32).toList(), seenSizes.toList())
            assertEquals(seenSizes.toList(), flowSizes.toList())
            assertEquals(32, DSXCookies.shared.jar.size)
            assertEquals(DSXCookies.shared.jar, DSXCookies.shared.jarFlow.value)
        } finally {
            subscription?.cancel()
            DSXCookies.shared.resetForTests()
            DSXCookies.shared.nativeStore = savedStore
            DSXCookies.shared.mainExecutor = savedExecutor
        }
    }

    @ResourceLock("DSXCookies.shared")
    @Test fun reentrantCookieSetJoinsTheCurrentPublicationFifo() {
        val savedStore = DSXCookies.shared.nativeStore
        val savedExecutor = DSXCookies.shared.mainExecutor
        DSXCookies.shared.resetForTests()
        val seen = ArrayList<Map<String, String>>()
        var subscription: AnyCancellable? = null
        var reentered = false
        try {
            DSXCookies.shared.nativeStore = {}
            DSXCookies.shared.mainExecutor = Executor { it.run() }
            DSXCookies.shared.setDomainHint("app.example.com")
            subscription = DSXCookies.shared.sink { snapshot ->
                seen += snapshot
                if (snapshot["outer"] == "1" && !reentered) {
                    reentered = true
                    DSXCookies.shared.set("inner", "2")
                }
            }
            DSXCookies.shared.set("outer", "1")

            assertEquals(
                listOf(
                    emptyMap(),
                    mapOf("outer" to "1"),
                    mapOf("outer" to "1", "inner" to "2"),
                ),
                seen,
            )
            assertEquals(seen.last(), DSXCookies.shared.jarFlow.value)
        } finally {
            subscription?.cancel()
            DSXCookies.shared.resetForTests()
            DSXCookies.shared.nativeStore = savedStore
            DSXCookies.shared.mainExecutor = savedExecutor
        }
    }

    @ResourceLock("DSXCookies.shared")
    @Test fun asyncCookieMutationWaitsForItsReentrantChildEffects() {
        val savedStore = DSXCookies.shared.nativeStore
        val savedExecutor = DSXCookies.shared.mainExecutor
        val executor = java.util.concurrent.Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "cookie-transaction-test").apply { isDaemon = true }
        }
        DSXCookies.shared.resetForTests()
        val nativeValues = Collections.synchronizedList(mutableListOf<String>())
        val innerNativeEntered = java.util.concurrent.CountDownLatch(1)
        val releaseInnerNative = java.util.concurrent.CountDownLatch(1)
        val callerReturned = java.util.concurrent.CountDownLatch(1)
        val callerFailure = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        var subscription: AnyCancellable? = null
        var caller: Thread? = null
        try {
            DSXCookies.shared.mainExecutor = executor
            DSXCookies.shared.setDomainHint("app.example.com")
            DSXCookies.shared.nativeStore = { cookie ->
                nativeValues.add(cookie.value)
                if (cookie.value == "inner") {
                    innerNativeEntered.countDown()
                    check(releaseInnerNative.await(10, java.util.concurrent.TimeUnit.SECONDS)) {
                        "timed out releasing the nested native cookie write"
                    }
                }
            }
            subscription = DSXCookies.shared.sink { snapshot ->
                if (snapshot["outer"] == "outer" && snapshot["inner"] == null) {
                    DSXCookies.shared.set("inner", "inner")
                }
            }

            val callerThread = Thread {
                try {
                    DSXCookies.shared.set("outer", "outer")
                } catch (error: Throwable) {
                    callerFailure.set(error)
                } finally {
                    callerReturned.countDown()
                }
            }.apply { isDaemon = true }
            caller = callerThread
            callerThread.start()

            assertTrue(innerNativeEntered.await(10, java.util.concurrent.TimeUnit.SECONDS))
            assertEquals(1L, callerReturned.count) // outer call still owns its nested group
            releaseInnerNative.countDown()
            callerThread.join(10_000)
            assertFalse(callerThread.isAlive)
            callerFailure.get()?.let { throw AssertionError("outer cookie mutation failed", it) }
            assertEquals(listOf("outer", "inner"), nativeValues.toList())
            assertEquals("inner", DSXCookies.shared.jar["inner"])
            assertEquals(DSXCookies.shared.jar, DSXCookies.shared.jarFlow.value)
        } finally {
            releaseInnerNative.countDown()
            caller?.join(10_000)
            subscription?.cancel()
            DSXCookies.shared.resetForTests()
            DSXCookies.shared.nativeStore = savedStore
            DSXCookies.shared.mainExecutor = savedExecutor
            executor.shutdownNow()
        }
    }

    // -- Params typed accessors (structured + string coercions) --

    @Test fun paramsTypedAccessors() {
        val p = Bridge.Params(dict = mapOf(
            "s" to "text", "n" to 7, "d" to 1.25, "b" to true, "bs" to "yes",
            "arr" to listOf("x", 2), "csv" to "a, b ,c", "obj" to mapOf("k" to 1),
            "objs" to """[{"a":1},{"a":2}]""", "file" to "https://cdn.local/f.png",
            "__rid" to "hidden"), requestID = "p1")
        assertEquals("text", p.string("s"))
        assertEquals("7", p.string("n"))
        assertEquals("true", p.string("b"))
        assertEquals("x,2", p.string("arr"))                          // arrays rejoin for legacy readers
        assertEquals(7, p.int("n"))
        assertEquals(1.25, p.double("d"))
        assertEquals(true, p.bool("b"))
        assertEquals(true, p.bool("bs"))                              // "yes" coerces
        assertEquals(false, p.bool("missing"))
        assertEquals(listOf<Any?>("x", 2), p.array("arr"))
        assertEquals(listOf<Any?>("a", "b", "c"), p.array("csv"))     // split + trimmed
        assertNull(p.array("missing"))
        assertEquals(listOf("x", "2"), p.stringArray("arr"))
        assertEquals(mapOf("k" to 1), p.`object`("obj"))
        assertEquals(listOf(mapOf("a" to 1), mapOf("a" to 2)), p.objectArray("objs"))
        assertEquals(URI("https://cdn.local/f.png"), p.file("file"))
        assertEquals("p1", p.requestID)
        assertFalse(p.strings.containsKey("__rid"))                   // framing keys dropped
        assertEquals("a, b ,c", p.strings["csv"])
    }
}
