package despia.engine

import java.net.URI
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/// THE ENVELOPE SUITE (beginnings) — Module/registry behavior pinned to Module.swift +
/// Context.swift. Every reply envelope is asserted EXACTLY:
///   `{id, scheme, host, event, final, data[, code, recoverable, message]}`
/// The registry is a process singleton, so every test registers its own uniquely-named
/// schemes/events and never resets shared state (except the single boot-phases test,
/// which owns the one-shot boot/bootstrap latches).
class ModuleTest {

    // -- helpers --

    /// Mount the "web" sink (the default reply target) and collect envelopes.
    private fun <T> capturingWeb(body: (MutableList<DSXEgress>) -> T): T {
        val received = mutableListOf<DSXEgress>()
        val mount = DSXMessenger().mount("web") { received.add(it) }
        try { return body(received) } finally { mount.unmount() }
    }

    /// The web relay's dispatch: string-keyed, untrusted tier, origin surface "web".
    private fun webCall(scheme: String, action: String, args: Map<String, Any?> = emptyMap(),
                        rid: String? = "r1"): Boolean =
        ModuleRegistry.shared.handle(
            scheme = scheme, actionPath = action,
            params = Bridge.Params(dict = args, requestID = rid, surfaceID = "web"),
            includeInternal = false)

    // -- resolve envelope --

    private class BatteryMod : Module() {
        override val scheme get() = "mt.battery"
        override fun setup() {
            dsx.action("level") { dsx -> dsx.resolve(JSON(mapOf("percent" to 80))) }
            dsx.action("nothing") { dsx -> dsx.resolve() }
        }
    }

    @Test fun resolveEnvelopeShape() = capturingWeb { received ->
        ModuleRegistry.shared.register { BatteryMod() }
        assertTrue(webCall("mt.battery", "level"))
        assertEquals(1, received.size)
        val e = received[0]
        assertEquals("web", e.target)
        assertEquals("mt.battery", e.scheme)
        assertEquals("r1", e.rid)
        assertEquals(
            mapOf("id" to "r1", "scheme" to "mt.battery", "host" to "level",
                  "event" to "result", "final" to true, "data" to mapOf("percent" to 80)),
            e.payload)
    }

    @Test fun resolveWithNoDataCarriesNullDataKeyPresent() = capturingWeb { received ->
        ModuleRegistry.shared.register { BatteryMod() }
        assertTrue(webCall("mt.battery", "nothing", rid = "r2"))
        val payload = received[0].payload
        assertTrue(payload.containsKey("data"))          // NSNull → null, key PRESENT
        assertNull(payload["data"])
        assertEquals("result", payload["event"])
    }

    // -- error envelope --

    private class FailingMod : Module() {
        override val scheme get() = "mt.failing"
        override fun setup() {
            dsx.action("structured") { dsx ->
                dsx.fail("low_power", message = "Battery too low", recoverable = true,
                         data = mapOf("percent" to 3))
            }
            dsx.action("bare") { dsx -> dsx.error("boom", "details") }
        }
    }

    @Test fun errorEnvelopeShape_structured() = capturingWeb { received ->
        ModuleRegistry.shared.register { FailingMod() }
        assertTrue(webCall("mt.failing", "structured"))
        assertEquals(
            mapOf("id" to "r1", "scheme" to "mt.failing", "host" to "structured",
                  "event" to "error", "final" to true, "data" to mapOf("percent" to 3),
                  "code" to "low_power", "recoverable" to true, "message" to "Battery too low"),
            received[0].payload)
    }

    @Test fun errorEnvelopeShape_bare_hasNoMessageKey() = capturingWeb { received ->
        ModuleRegistry.shared.register { FailingMod() }
        assertTrue(webCall("mt.failing", "bare"))
        assertEquals(
            mapOf("id" to "r1", "scheme" to "mt.failing", "host" to "bare",
                  "event" to "error", "final" to true, "data" to "details",
                  "code" to "boom", "recoverable" to false),
            received[0].payload)                          // message ONLY when given
    }

    // -- event (stream) envelope --

    private class StreamMod : Module() {
        override val scheme get() = "mt.stream"
        override fun setup() {
            dsx.action("ticks") { dsx ->
                dsx.event("tick", 1)
                dsx.event("tick", 2)
                dsx.resolve(mapOf("done" to true))
                dsx.event("tick", 3)                     // after settle: dropped
            }
            dsx.action("errevent") { dsx -> dsx.event("error", "bad") }
        }
    }

    @Test fun eventEnvelopesStreamThenFinalResult() = capturingWeb { received ->
        ModuleRegistry.shared.register { StreamMod() }
        assertTrue(webCall("mt.stream", "ticks", rid = "s1"))
        assertEquals(3, received.size)                   // 2 ticks + result; post-settle tick dropped
        assertEquals(
            mapOf("id" to "s1", "scheme" to "mt.stream", "host" to "ticks",
                  "event" to "tick", "final" to false, "data" to 1),
            received[0].payload)
        assertEquals(2, received[1].payload["data"])
        assertEquals("result", received[2].payload["event"])
        assertEquals(true, received[2].payload["final"])
    }

    @Test fun eventNamedErrorClosesTheStream() = capturingWeb { received ->
        ModuleRegistry.shared.register { StreamMod() }
        assertTrue(webCall("mt.stream", "errevent"))
        // `final` follows the terminal rule — an event NAMED "error" is final.
        assertEquals(true, received[0].payload["final"])
        assertEquals("error", received[0].payload["event"])
    }

    // -- terminal is once --

    private class TwiceMod : Module() {
        override val scheme get() = "mt.twice"
        override fun setup() {
            dsx.action("both") { dsx ->
                dsx.resolve(mapOf("first" to true))
                dsx.resolve(mapOf("second" to true))
                dsx.error("late")
            }
        }
    }

    @Test fun firstTerminalWins() = capturingWeb { received ->
        ModuleRegistry.shared.register { TwiceMod() }
        assertTrue(webCall("mt.twice", "both"))
        assertEquals(1, received.size)
        assertEquals(mapOf("first" to true), received[0].payload["data"])
    }

    // -- broadcast envelope --

    private class NoisyMod : Module() {
        override val scheme get() = "mt.noisy"
        fun shout() { dsx.broadcast("started", mapOf("level" to 5)) }
    }

    @Test fun broadcastEnvelopeShape_andNativeFanout() {
        val noisy = NoisyMod()
        ModuleRegistry.shared.register { noisy }
        val native = mutableListOf<Pair<String, Any?>>()
        val sub = DSXEvents().on("mt.noisy") { event, data -> native.add(event to data) }
        try {
            capturingWeb { received ->
                noisy.shout()
                assertEquals(1, received.size)
                val e = received[0]
                assertEquals("*", e.target)              // broadcast fans out to EVERY mounted sink
                assertNull(e.rid)                        // out-of-band: no correlation id
                assertEquals(
                    mapOf("id" to null, "scheme" to "mt.noisy", "host" to "",
                          "event" to "started", "final" to true, "data" to mapOf("level" to 5)),
                    e.payload)
            }
            assertEquals(listOf<Pair<String, Any?>>("started" to mapOf("level" to 5)), native)
        } finally { sub.cancel() }
    }

    // -- unknown action / unowned scheme --

    private class PrefilteredMod : Module() {
        override val scheme get() = "mt.pre"
        override fun setup() {
            dsx.action { dsx -> if (dsx.action.name == "mine") dsx.resolve("pre") else dsx.skip() }
            dsx.action("named") { dsx -> dsx.resolve("named") }
        }
    }

    @Test fun prefilterHandlesOrSkipsToNamed_unknownActionEnvelope() = capturingWeb { received ->
        ModuleRegistry.shared.register { PrefilteredMod() }
        assertTrue(webCall("mt.pre", "mine"))            // prefilter settles
        assertEquals("pre", received[0].payload["data"])
        assertTrue(webCall("mt.pre", "named"))           // skip() → named handler
        assertEquals("named", received[1].payload["data"])
        assertTrue(webCall("mt.pre", "nope", rid = "u1"))  // skip() + no match → auto error
        assertEquals(
            mapOf("id" to "u1", "scheme" to "mt.pre", "host" to "nope",
                  "event" to "error", "final" to true, "data" to mapOf("action" to "nope"),
                  "code" to "unknown_action", "recoverable" to false),
            received[2].payload)
    }

    @Test fun unownedSchemeIsNotHandled() {
        assertFalse(webCall("mt.ghost", "anything"))
    }

    // -- fire / hook fan-out --

    private class HookModA : Module() {
        override val scheme get() = "mt.hooka"
        override fun setup() { dsx.delegate.listen("mt.evt.ping") { input -> log.add("A:$input"); null } }
        companion object { val log = mutableListOf<String>() }
    }
    private class HookModB : Module() {
        override val scheme get() = "mt.hookb"
        override fun setup() { dsx.delegate.listen("mt.evt.ping") { input -> log.add("B:$input"); "consumed" } }
        companion object { val log = mutableListOf<String>() }
    }

    @Test fun fireFansOutToEveryHook_resultsIgnored() {
        ModuleRegistry.shared.register { HookModA() }
        ModuleRegistry.shared.register { HookModB() }
        HookModA.log.clear(); HookModB.log.clear()
        ModuleRegistry.shared.dispatch("mt.evt.ping", 7, combine = ModuleRegistry.Combine.void)
        assertEquals(listOf("A:7"), HookModA.log)
        assertEquals(listOf("B:7"), HookModB.log)
    }

    // -- fireAny: consumed-if-any-non-nil, every watcher still runs --
    // (One module registering N hooks: hooks fold in registration order within a
    //  package exactly as across packages — priority 0 keeps registration order.)

    private class AnyMod : Module() {
        override val scheme get() = "mt.any"
        override fun setup() {
            dsx.delegate.listen("mt.evt.open") { runs.add("n1"); null }
            dsx.delegate.listen("mt.evt.open") { runs.add("c"); "took-it" }
            dsx.delegate.listen("mt.evt.open") { runs.add("n2"); null }
        }
        companion object { val runs = mutableListOf<String>() }
    }

    @Test fun fireAnyRunsAllAndReportsConsumed() {
        ModuleRegistry.shared.register { AnyMod() }
        AnyMod.runs.clear()
        assertTrue(((ModuleRegistry.shared.dispatch("mt.evt.open", "u", combine = ModuleRegistry.Combine.any) as? Boolean) ?: false))
        assertEquals(listOf("n1", "c", "n2"), AnyMod.runs)   // NO short-circuit
        assertFalse(((ModuleRegistry.shared.dispatch("mt.evt.never", combine = ModuleRegistry.Combine.any) as? Boolean) ?: false))   // nobody hooked
    }

    // -- claim: first non-nil in registration order; priority reorders --

    private class ClaimMod : Module() {
        override val scheme get() = "mt.claim"
        override fun setup() {
            dsx.delegate.listen("mt.evt.claim") { runs.add("abstain"); null }
            dsx.delegate.listen("mt.evt.claim") { runs.add("winner"); "W" }
            dsx.delegate.listen("mt.evt.claim") { runs.add("never"); "L" }
        }
        companion object { val runs = mutableListOf<String>() }
    }

    @Test fun claimFirstNonNilInRegistrationOrder_shortCircuits() {
        ModuleRegistry.shared.register { ClaimMod() }
        ClaimMod.runs.clear()
        assertEquals("W", ModuleRegistry.shared.dispatch("mt.evt.claim", combine = ModuleRegistry.Combine.claim))
        assertEquals(listOf("abstain", "winner"), ClaimMod.runs)   // short-circuits before "never"
        assertNull(ModuleRegistry.shared.dispatch("mt.evt.unclaimed", combine = ModuleRegistry.Combine.claim))
    }

    private class PrioMod : Module() {
        override val scheme get() = "mt.prio"
        override fun setup() {
            dsx.delegate.listen("mt.evt.prio", priority = 0) { "low" }      // registered first
            dsx.delegate.listen("mt.evt.prio", priority = 5) { "high" }     // higher priority runs FIRST
        }
    }

    @Test fun claimHonorsPriorityOverRegistrationOrder() {
        ModuleRegistry.shared.register { PrioMod() }
        assertEquals("high", ModuleRegistry.shared.dispatch("mt.evt.prio", combine = ModuleRegistry.Combine.claim))
    }

    // -- collect / veto folds --

    private class FoldMod : Module() {
        override val scheme get() = "mt.fold"
        override fun setup() {
            dsx.delegate.listen("mt.evt.fold") { "a" }
            dsx.delegate.listen("mt.evt.fold") { null }
            dsx.delegate.listen("mt.evt.fold") { "b" }
        }
    }

    @Test fun collectKeepsEveryNonNilAnswerInOrder() {
        ModuleRegistry.shared.register { FoldMod() }
        assertEquals(listOf<Any>("a", "b"), ((ModuleRegistry.shared.dispatch("mt.evt.fold", combine = ModuleRegistry.Combine.collect) as? List<Any>) ?: emptyList()))
    }

    private class VetoTrueMod : Module() {
        override val scheme get() = "mt.veto.granter"
        override fun setup() { dsx.delegate.listen("mt.evt.veto") { true } }
    }
    private class VetoFalseMod : Module() {
        override val scheme get() = "mt.veto.denier"
        override fun setup() { dsx.delegate.listen("mt.evt.veto") { false } }
    }

    @Test fun vetoDeniesOnlyWhenSomeWatcherReturnsFalse() {
        ModuleRegistry.shared.register { VetoTrueMod() }
        assertEquals(true, ModuleRegistry.shared.dispatch("mt.evt.veto", null, ModuleRegistry.Combine.veto))
        ModuleRegistry.shared.register { VetoFalseMod() }
        assertEquals(false, ModuleRegistry.shared.dispatch("mt.evt.veto", null, ModuleRegistry.Combine.veto))
        // an unwatched event always proceeds
        assertEquals(true, ModuleRegistry.shared.dispatch("mt.evt.vetoless", null, ModuleRegistry.Combine.veto))
    }

    // -- scheme case-insensitivity (RFC 3986) + URL dispatch --

    private class CasedMod : Module() {
        override val scheme get() = "MT.Case"
        override fun setup() { dsx.action("probe") { dsx -> dsx.resolve("cased") } }
    }

    @Test fun schemesAreCaseInsensitive_urlAndStringKeyed() = capturingWeb { received ->
        ModuleRegistry.shared.register { CasedMod() }
        assertTrue(ModuleRegistry.shared.isAvailable("mt.case"))
        assertTrue(ModuleRegistry.shared.isAvailable("MT.CASE"))
        // URL path (Foundation lowercases scheme + host; the port lowercases explicitly)
        assertTrue(ModuleRegistry.shared.handle(
            url = URI("MT.CASE://PROBE?__rid=c1"), params = Bridge.Params(url = URI("MT.CASE://PROBE?__rid=c1"), surfaceID = "web")))
        assertEquals("probe", received[0].payload["host"])
        assertEquals("cased", received[0].payload["data"])
        // string-keyed path
        assertTrue(webCall("MT.Case", "Probe", rid = "c2"))
        assertEquals("cased", received[1].payload["data"])
    }

    // -- schemeless modules --

    private class HookOnlyMod : Module() {
        override val registersWithoutScheme get() = true
        override fun setup() { dsx.delegate.listen("mt.evt.hookonly") { "here" } }
    }
    private class LostMod : Module() {           // no scheme, no opt-in → ignored
        override fun setup() { dsx.delegate.listen("mt.evt.lost") { "never" } }
    }

    @Test fun registersWithoutSchemeJoinsHookFanoutButOwnsNoRoute() {
        ModuleRegistry.shared.register { HookOnlyMod() }
        assertEquals("here", ModuleRegistry.shared.dispatch("mt.evt.hookonly", combine = ModuleRegistry.Combine.claim))
        ModuleRegistry.shared.register { LostMod() }
        assertNull(ModuleRegistry.shared.dispatch("mt.evt.lost", combine = ModuleRegistry.Combine.claim))   // dropped: no scheme, no opt-in
    }

    // -- manifest scheme binding (GeneratedModuleSchemes) --

    private class ManifestBoundMod : Module() {  // no override — the manifest binds the scheme
        override fun setup() { dsx.action("ping") { dsx -> dsx.resolve("bound") } }
    }

    @Test fun manifestBindsSchemeWhenNoOverride() = capturingWeb { received ->
        val saved = GeneratedModuleSchemes.byClassName
        GeneratedModuleSchemes.byClassName = saved + ("ManifestBoundMod" to "mt.bound")
        try {
            ModuleRegistry.shared.register { ManifestBoundMod() }
            assertTrue(webCall("mt.bound", "ping"))
            assertEquals("bound", received[0].payload["data"])
        } finally { GeneratedModuleSchemes.byClassName = saved }
    }

    // -- 2-phase boot via the generated-registry seam --

    private class BootTierMod : Module() {
        override val scheme get() = "mt.boot.tier"
        override fun setup() { setups += 1 }
        companion object { var setups = 0 }
    }
    private class DeferredMod : Module() {
        override val scheme get() = "mt.boot.deferred"
        override fun setup() { setups += 1 }
        companion object { var setups = 0 }
    }
    private class LateMod : Module() {
        override val scheme get() = "mt.boot.late"
    }

    @Test fun generatedRegistryBootPhases() {
        // ONE test owns the process-wide boot/bootstrap latches (see class doc).
        ModuleRegistry.shared.register(
            schemes = mapOf(
                "mt.boot.tier" to { BootTierMod() },
                "mt.boot.deferred" to { DeferredMod() },
            ),
            bootEligible = setOf("mt.boot.tier"))
        // Discovery alone registers nothing.
        assertFalse(ModuleRegistry.shared.isAvailable("mt.boot.tier"))
        assertEquals(0, BootTierMod.setups)

        ModuleRegistry.shared.boot()                     // phase 1: the boot tier ONLY
        assertTrue(ModuleRegistry.shared.isAvailable("mt.boot.tier"))
        assertFalse(ModuleRegistry.shared.isAvailable("mt.boot.deferred"))
        assertEquals(1, BootTierMod.setups)
        assertEquals(0, DeferredMod.setups)

        ModuleRegistry.shared.boot()                     // idempotent
        assertEquals(1, BootTierMod.setups)

        ModuleRegistry.shared.bootstrap()                // phase 2: everything else
        assertTrue(ModuleRegistry.shared.isAvailable("mt.boot.deferred"))
        assertEquals(1, DeferredMod.setups)

        ModuleRegistry.shared.bootstrap()                // idempotent
        assertEquals(1, DeferredMod.setups)

        // A generated-registry call landing AFTER bootstrap registers immediately
        // (late-loaded feature pack).
        ModuleRegistry.shared.register(schemes = mapOf("mt.boot.late" to { LateMod() }))
        assertTrue(ModuleRegistry.shared.isAvailable("mt.boot.late"))
    }

    // -- hydration / ready fan-out --

    private class PageMod : Module() {
        override val scheme get() = "mt.page"
        override fun setup() {
            dsx.hydrate { hydrations += 1 }
            dsx.ready { readies += 1 }
        }
        companion object { var hydrations = 0; var readies = 0 }
    }

    @Test fun runHydrationsAndReadyVisitEveryBlock() {
        ModuleRegistry.shared.register { PageMod() }
        val h = PageMod.hydrations; val r = PageMod.readies
        ModuleRegistry.shared.runHydrations()
        ModuleRegistry.shared.runReady()
        assertEquals(h + 1, PageMod.hydrations)
        assertEquals(r + 1, PageMod.readies)
    }
}
