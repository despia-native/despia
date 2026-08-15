package despia.engine

import java.io.File
import java.util.concurrent.Executor
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * The module-identity CHAIN conformance runner — executes
 * OpenSource/Conformance/chains/chains.json through THIS runtime's resolver (the TS runner
 * and the Swift reference run the SAME file). The law under test (the corpus `_note`):
 * identity is a dotted chain; resolution is the incremental FOLD at the ONE dispatch
 * funnel — alias-normalize the head, fold segments while `chain + "." + parts[0]` is in
 * the identity set (registered ∪ excluded), remainder = action path; a leading reserved
 * word routes to the MEMBER plane, never an action.
 *
 * The corpus's `proxySafety` block is SKIPPED here by contract: it asserts the JS planes'
 * proxy denylist (property gets of then/toString/… return undefined), and Kotlin has no
 * dynamic get plane — reserved members are REAL members, real members shadow dynamic
 * lookup, so the native runtime is immune by construction (the `_note` says exactly this).
 *
 * FROZEN contract addition (the corpus `_note`): a reserved member arriving at a MODERN
 * call face — the typed proxies / the native _call/_dispatch funnel, a caller bug — is
 * REFUSED with the cross-runtime code `reserved_member` (module.callFailed +
 * ModuleCallError), never dispatched as an action, never a silent unknown_action. Every
 * member-route corpus case is additionally driven through the LIVE native call face to
 * assert exactly that refusal. The LEGACY WIRE face (the registry's string funnel) is
 * EXEMPT from the refusal: reserved words are banned from manifests, never from the
 * wire, so code-only legacy shims (`biometric://available`, `bluetooth://state`) keep
 * answering shipped pages — and the FOLD still applies for ROUTING there, so a nested
 * chain reaches its owner even through a reserved remainder (`chfx://sub/state` →
 * action `state` on `chfx.sub`). Asserted below with the same spelling on both faces.
 *
 * The funnel-wiring tests below prove the same fold live at the registry funnel
 * (ModuleRegistry.handle / Context._call) — parent-spelled calls route to the nested
 * child, dotted group actions stay actions, an excluded chain attributes honestly, and
 * the reserved spelling splits by face (wire answers, modern refuses).
 */
class ChainsConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/chains/chains.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/chains/chains.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpus(): Map<String, Any?> =
        json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("chains.json: not a JSON object")

    /** The corpus's synthetic identity table, exactly as the fixture states it. */
    @Suppress("UNCHECKED_CAST")
    private fun table(doc: Map<String, Any?>): ChainResolver.Table {
        val t = doc["table"] as? Map<String, Any?> ?: error("chains.json: no table")
        val chains = (t["chains"] as? List<*> ?: emptyList<Any?>()).map { JSE.string(it) }.toSet()
        val aliases = (t["aliases"] as? Map<String, Any?> ?: emptyMap())
            .mapValues { JSE.string(it.value) }
        val excluded = (t["excluded"] as? List<*> ?: emptyList<Any?>()).map { JSE.string(it) }.toSet()
        return ChainResolver.Table(chains = chains, aliases = aliases, excluded = excluded)
    }

    // MARK: - The corpus runner (every case, resolver semantics)

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun chainsCorpus(): List<DynamicTest> {
        val doc = corpus()
        val identity = table(doc)
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("chains.json: no cases[]")
        val tests = ArrayList<DynamicTest>()
        // The reserved-member set is CLOSED and FROZEN — the corpus and the resolver must
        // never drift (growth is a major-version event on both sides at once).
        tests.add(DynamicTest.dynamicTest("chains-corpus/reserved-set-frozen") {
            val reserved = (doc["reserved"] as? List<*> ?: emptyList<Any?>()).map { JSE.string(it) }.toSet()
            assertEquals(reserved, ChainResolver.reservedMembers, "reserved members drifted from chains.json")
        })
        for (c in cases) {
            val name = "chains-corpus/${c["name"]}"
            tests.add(DynamicTest.dynamicTest(name) {
                val input = JSE.string(c["input"])
                val expect = c["expect"] as? Map<String, Any?> ?: error("$name: no expect")
                val res = ChainResolver.resolve(input.split("."), identity)
                assertEquals(JSE.string(expect["chain"]), res.chain, "$name: chain")
                // expect.spelling is stated only when it differs from the chain (alias heads).
                assertEquals(JSE.string(expect["spelling"] ?: expect["chain"]), res.spelling, "$name: spelling")
                assertEquals((expect["known"] as? Boolean) ?: true, res.known, "$name: known")
                assertEquals((expect["excluded"] as? Boolean) ?: false, res.excluded, "$name: excluded")
                if (expect.containsKey("member")) {
                    // MEMBER route: member + rest instead of action — never an action.
                    assertEquals(JSE.string(expect["member"]), res.member, "$name: member")
                    assertEquals(JSE.string(expect["rest"] ?: ""), res.rest.joinToString("/"), "$name: rest")
                    assertTrue(res.action.isEmpty(), "$name: a member route exposes no action")
                    // THE REFUSAL (frozen in the corpus _note): the same member arriving at the
                    // LIVE call funnel is a caller bug — refused with the cross-runtime code
                    // `reserved_member`, thrown as ModuleCallError, never dispatched, never a
                    // silent unknown_action. The corpus table rides in as the excluded overlay
                    // (identity without registration — the refusal precedes route existence).
                    assertRefusedLive(name, input)
                } else {
                    // CALL route: slash-joined action ('' = the bare pre-filter call).
                    assertEquals(JSE.string(expect["action"] ?: ""), res.action.joinToString("/"), "$name: action")
                    assertNull(res.member, "$name: a call route has no member")
                    assertTrue(res.rest.isEmpty(), "$name: a call route has no member rest")
                }
            })
        }
        return tests
        // (The corpus's proxySafety block is intentionally not iterated — JS-plane only; see
        // the class doc.)
    }

    /** Set-run-restore for the PROCESS-GLOBAL excluded overlay — every test that injects
     *  the overlay rides this (never a bare assignment): a forgotten or mis-scoped reset
     *  leaks phantom identities into whichever suite runs next in the same JVM —
     *  order-dependent failures that pass in isolation. */
    private fun withExcludedOverlay(map: Map<String, Map<String, String>>, body: () -> Unit) {
        ModuleRegistry.shared.knownExcludedIdentities = map
        try { body() } finally { ModuleRegistry.shared.knownExcludedIdentities = emptyMap() }
    }

    /** Set-run-restore for the codegen alias seam (aliasesByClassName) — the same
     *  process-global law as the overlay helper above. */
    private fun withAliases(entries: Map<String, List<String>>, body: () -> Unit) {
        val saved = GeneratedModuleSchemes.aliasesByClassName
        GeneratedModuleSchemes.aliasesByClassName = saved + entries
        try { body() } finally { GeneratedModuleSchemes.aliasesByClassName = saved }
    }

    /** Run a member-route corpus input through the LIVE native call face and assert the
     *  `reserved_member` refusal. The corpus's chains ∪ excluded are injected as the
     *  registry's excluded overlay — identity without registration, which is exactly why
     *  the refusal must precede route existence (it wins over not_loaded on every twin). */
    @Suppress("UNCHECKED_CAST")
    private fun assertRefusedLive(name: String, input: String) {
        inlineExecutors()
        val t = corpus()["table"] as? Map<String, Any?> ?: error("$name: no table")
        val identities =
            (t["chains"] as? List<*> ?: emptyList<Any?>()).map { JSE.string(it) }.toSet() +
            (t["excluded"] as? List<*> ?: emptyList<Any?>()).map { JSE.string(it) }.toSet()
        withExcludedOverlay(identities.associateWith { mapOf("reason" to "excluded") }) {
            val segments = input.split(".")
            val caller = Module().dsx
            runBlocking {
                try {
                    caller.module[segments.first()][segments.drop(1).joinToString("/")]()
                    fail("$name: a member route must refuse dispatch")
                } catch (e: ModuleCallError.ActionFailed) {
                    assertEquals("reserved_member", e.code, "$name: refusal code")
                }
            }
        }
    }

    // MARK: - Funnel wiring (the same fold, live at the ONE dispatch funnel)

    /** Parent chain — a plain depth-1 module with a normal action, a dotted GROUP key
     *  (`sync.start` — the group grammar the fold must never eat, because `chfx.sync` is no
     *  registered chain), and a CODE-ONLY legacy shim under a reserved spelling
     *  (`available` — the Biometric-bridge pattern: banned from manifests, legal in code,
     *  reachable from the legacy wire face only). */
    private class ParentMod : Module() {
        override val scheme get() = "chfx"
        override fun setup() {
            dsx.action("render") { it.resolve("parent-render") }
            dsx.action("sync.start") { it.resolve("group-start") }
            dsx.action("available") { it.resolve("shim-available") }
        }
    }

    /** Nested child chain — registered under its full dotted identity, exactly how the
     *  generated registry registers a `Modules/` child. Carries a CODE-ONLY shim under a
     *  reserved spelling (`state` — the bluetooth://state pattern) plus a skipping
     *  prefilter, so an unregistered name answers unknown_action ATTRIBUTED TO THE CHILD
     *  (the parent has no prefilter — a mis-route there would answer `false` instead,
     *  which is what makes the wire-face control test structural proof). */
    private class ChildMod : Module() {
        override val scheme get() = "chfx.sub"
        override fun setup() {
            dsx.action { it.skip() }
            dsx.action("ping") { it.resolve("pong") }
            dsx.action("state") { it.resolve("child-state") }
        }
    }

    private fun inlineExecutors() {
        ModuleRegistry.shared.mainExecutor = Executor { it.run() }
        JSERunner.mainExecutor = Executor { it.run() }
    }

    /** Register fresh instances every test — the registry is a process singleton and another
     *  suite may have `_resetForTests`-wiped it; re-registering just replaces the routes. */
    private fun registerChains() {
        ModuleRegistry.shared.register { ParentMod() }
        ModuleRegistry.shared.register { ChildMod() }
    }

    @Test
    fun foldRoutesParentSpelledCallToNestedChild() {
        inlineExecutors(); registerChains()
        val caller = Module().dsx
        // dsx.module["chfx"]["sub"]["ping"] lowers to ("chfx", "sub/ping") — the funnel folds
        // `sub` into the chain (chfx.sub is registered) and dispatches `ping` on the child.
        val out = runBlocking { caller.module["chfx"]["sub"]["ping"]() }
        assertEquals("pong", out.foundationValue, "parent-spelled call must resolve on the nested child")
    }

    @Test
    fun foldLeavesNonChainSegmentsToTheActionPlane() {
        inlineExecutors(); registerChains()
        val caller = Module().dsx
        // A plain action on the parent is untouched (nothing folds) …
        val direct = runBlocking { caller.module["chfx"]["render"]() }
        assertEquals("parent-render", direct.foundationValue)
        // … and a dotted GROUP key keeps its grammar: `sync` extends no registered chain, so
        // the whole `sync.start` stays the action host (the ban makes this unambiguous).
        val grouped = runBlocking { caller.module["chfx"]["sync.start"]() }
        assertEquals("group-start", grouped.foundationValue)
    }

    @Test
    fun excludedChainAttributesHonestly() {
        inlineExecutors(); registerChains()
        // The build-excluded overlay: `chfx.gone` exists in the catalog but not in this build.
        // TYPED ABSENCE (durability.md P4, corpus errors/errors.json): the reason IS the code —
        // an overlay chain answers `excluded` (split out of not_loaded), the DespiaExcluded
        // entry riding verbatim as data; attribution still names the CHAIN — never a phantom
        // `gone/run` action on chfx (the ledger's `scheme` carries it — ActionFailed is code+data).
        withExcludedOverlay(mapOf("chfx.gone" to mapOf("reason" to "excluded"))) {
            val caller = Module().dsx
            runBlocking {
                try {
                    caller.module["chfx"]["gone"]["run"]()
                    fail("an excluded chain must not resolve")
                } catch (e: ModuleCallError.ActionFailed) {
                    assertEquals("excluded", e.code, "the typed-absence code for a build-excluded chain")
                    assertEquals(mapOf("reason" to "excluded"), e.data, "the overlay entry rides verbatim as data")
                }
            }
            val entry = DSXErrorLedger.shared.recent().last()
            assertEquals("chfx.gone", entry.scheme, "the funnel must attribute the excluded chain")
            assertEquals("excluded", entry.code, "the ledger records the typed-absence code")
        }
    }

    @Test
    fun legacyWireFaceRoutesReservedWordDirectToShim() {
        inlineExecutors(); registerChains()
        // The LEGACY WIRE face is EXEMPT from the reserved_member refusal (corpus `_note`):
        // the v3 string transport routes DIRECT to the owner, so a code-only shim registered
        // under a reserved spelling (`chfx://available` — the biometric://available pattern)
        // keeps answering shipped pages. Never `reserved_member`, never unknown_action.
        var resolved: Any? = null
        var errorCode: String? = null
        val params = Bridge.Params(dict = emptyMap(), onTerminal = { outcome ->
            when (outcome) {
                is Bridge.Outcome.Resolve -> resolved = outcome.payload
                is Bridge.Outcome.Error -> errorCode = outcome.code
            }
        })
        val handled = ModuleRegistry.shared.handle(scheme = "chfx", actionPath = "available",
                                                   params = params, includeInternal = false)
        assertTrue(handled, "the wire face must route the reserved spelling direct")
        assertNull(errorCode, "the wire face must not refuse a reserved spelling")
        assertEquals("shim-available", resolved, "the code-only shim must answer")
    }

    @Test
    fun wireFaceFoldsThroughReservedRemainderToChild() {
        inlineExecutors(); registerChains()
        // THE PIN (cross-runtime divergence caught in review): on the wire face the FOLD
        // still applies for ROUTING even when the remainder starts with a reserved word —
        // chfx://sub/state must dispatch action `state` on chfx.sub (the child's code-only
        // shim answers), never route verbatim to the PARENT. Only the refusal is face-gated.
        var resolved: Any? = null
        var errorCode: String? = null
        var params = Bridge.Params(dict = emptyMap(), onTerminal = { outcome ->
            when (outcome) {
                is Bridge.Outcome.Resolve -> resolved = outcome.payload
                is Bridge.Outcome.Error -> errorCode = outcome.code
            }
        })
        val handled = ModuleRegistry.shared.handle(scheme = "chfx", actionPath = "sub/state",
                                                   params = params, includeInternal = false)
        assertTrue(handled, "the wire face must fold-route the reserved remainder to the child")
        assertNull(errorCode, "the wire face never refuses — the child's shim answers")
        assertEquals("child-state", resolved, "chfx://sub/state dispatches `state` on chfx.sub")
        // CONTROL: an unregistered name on the same folded route answers unknown_action
        // attributed to the CHILD — the parent has no prefilter, so a verbatim mis-route
        // to it would have answered `false` (structurally distinguishable).
        resolved = null; errorCode = null
        params = Bridge.Params(dict = emptyMap(), onTerminal = { outcome ->
            when (outcome) {
                is Bridge.Outcome.Resolve -> resolved = outcome.payload
                is Bridge.Outcome.Error -> errorCode = outcome.code
            }
        })
        val controlHandled = ModuleRegistry.shared.handle(scheme = "chfx", actionPath = "sub/nope",
                                                          params = params, includeInternal = false)
        assertTrue(controlHandled, "the folded route owns the miss — chfx.sub answers, not false")
        assertEquals("unknown_action", errorCode, "the miss attributes to the child chain")
        assertNull(resolved, "the control must not resolve")
    }

    @Test
    fun modernFaceStillRefusesReservedSpelling() {
        inlineExecutors(); registerChains()
        // The SAME spelling through the modern native face is a caller bug — the typed
        // proxies answer members before a call can form, so Context._call refuses it with
        // the frozen cross-runtime code (even though the wire shim above exists).
        val caller = Module().dsx
        runBlocking {
            try {
                caller.module["chfx"]["available"]()
                fail("the modern face must refuse a reserved member as an action")
            } catch (e: ModuleCallError.ActionFailed) {
                assertEquals("reserved_member", e.code, "the modern-face refusal code")
            }
        }
    }

    @Test
    fun unknownHeadKeepsTodayAttribution() {
        inlineExecutors(); registerChains()
        val caller = Module().dsx
        runBlocking {
            try {
                caller.module["chfx-nope"]["send"]()
                fail("an unknown head must not resolve")
            } catch (e: ModuleCallError.NotLoaded) {
                assertEquals("chfx-nope", e.scheme, "module_not_found reports against the head token")
            }
        }
    }

    // MARK: - Reserved members on the module handle (available / excluded / on)

    @Test
    fun availableAndExcludedAnswerHonestly() {
        inlineExecutors(); registerChains()
        val caller = Module().dsx
        // A LIVE module: available, and `excluded` is the honest false (never an entry).
        assertTrue(caller.module["chfx"].available, "a registered chain is available")
        assertEquals(false, caller.module["chfx"].excluded.foundationValue,
                     "a shipped chain answers excluded=false")
        // An EXCLUDED overlay entry: not available, and `excluded` is the DespiaExcluded
        // entry itself ({ reason[, from] }) — the page's despia.excluded twin.
        withExcludedOverlay(mapOf("chfx.gone" to mapOf("reason" to "cascade", "from" to "chfx"))) {
            assertTrue(!caller.module["chfx.gone"].available, "an excluded chain is not available")
            val entry = caller.module["chfx.gone"].excluded.foundationValue as? Map<*, *>
            assertEquals("cascade", entry?.get("reason"), "the overlay entry's reason rides through")
            assertEquals("chfx", entry?.get("from"), "the cascade parent rides through")
        }
        // A NEVER-EXISTED name: false at BOTH — the honest split (unknown is not excluded).
        assertTrue(!caller.module["chfx-void"].available, "a never-existed name is not available")
        assertEquals(false, caller.module["chfx-void"].excluded.foundationValue,
                     "a never-existed name answers excluded=false, never an entry")
    }

    /** Aliased fixture for the `.on` channel test — primary chain `chxa`, legacy alias
     *  `chxa-legacy` (bound the manifest way, via GeneratedModuleSchemes by class name). */
    private class AliasedMod : Module() {
        override val scheme get() = "chxa"
        override fun setup() {
            dsx.action("noop") { it.resolve() }
        }
    }

    @Test
    fun aliasHandleHearsPrimaryChannelViaOn() {
        inlineExecutors()
        // Bind the alias the way the generated registry does — BEFORE construction (the
        // Registration reads resolvedAliases in Module.init).
        withAliases(mapOf("AliasedMod" to listOf("chxa-legacy"))) {
            val mod = AliasedMod()
            ModuleRegistry.shared.register { mod }
            // The ALIAS handle subscribes — `.on` must alias-normalize to the PRIMARY chain,
            // because modules emit under their resolvedScheme: an alias handle hears the
            // same channel (`chxa.evt`), never a dead `chxa-legacy.evt` one.
            var heard: Any? = null
            mod.dsx.module["chxa-legacy"].on("evt") { payload -> heard = payload; null }
            mod.dsx.delegate.send("chxa.evt", "ping-payload", combine = ModuleRegistry.Combine.void)
            assertEquals("ping-payload", heard, "an alias handle hears the primary chain's channel")
            // And the alias spelling answers availability through the same normalization.
            assertTrue(mod.dsx.module["chxa-legacy"].available, "an alias handle is available")
        }
    }

    /** Subscriber fixture for the boot-order test — hooks only count for REGISTERED
     *  modules (the fan-out walks allPackages), so the pre-registration subscription
     *  below must come from a registered module, not a bare Module(). */
    private class ListenerMod : Module() {
        override val scheme get() = "chxl"
        override fun setup() {
            dsx.action("noop") { it.resolve() }
        }
    }

    @Test
    fun aliasHookSubscribedBeforeRegistrationStillHears() {
        inlineExecutors()
        withAliases(mapOf("AliasedMod" to listOf("chxa-legacy"))) {
            // Subscribe under the ALIAS spelling BEFORE the alias's OWNER registers — the
            // live table can't normalize yet, so the hook keys the verbatim spelling. The
            // EMISSION-side alias fan-out (the ModuleRegistry .void fold) must still deliver:
            // boot order never decides whether a hook hears (review round 3).
            val listener = ListenerMod()
            ModuleRegistry.shared.register { listener }
            var heard: Any? = null
            listener.dsx.module["chxa-legacy"].on("evt") { payload -> heard = payload; null }
            val mod = AliasedMod()
            ModuleRegistry.shared.register { mod }
            mod.dsx.delegate.send("chxa.evt", "late-owner-payload", combine = ModuleRegistry.Combine.void)
            assertEquals("late-owner-payload", heard,
                         "an alias-keyed hook installed pre-registration hears via the emission fan-out")
        }
    }

    @Test
    fun excludedOverlayAnswersLegacyAliasSpellings() {
        inlineExecutors(); registerChains()
        val caller = Module().dsx
        withExcludedOverlay(mapOf("chfx.gone" to
                mapOf("reason" to "excluded", "aliases" to "gonelegacy, gone-old"))) {
            // The alias spelling answers the SAME honest entry — an excluded module is
            // unregistered, so only the overlay knows its spellings (matchesEntry 1:1).
            val viaAlias = caller.module["gonelegacy"].excluded.foundationValue as? Map<*, *>
            assertEquals("excluded", viaAlias?.get("reason"), "an overlay alias answers the owning entry")
            assertTrue(!caller.module["gonelegacy"].available, "an excluded alias spelling is not available")
            // Comma-joined + spacing + case tolerant (the generator emits the joined form).
            val trimmed = caller.module["Gone-Old"].excluded.foundationValue as? Map<*, *>
            assertEquals("excluded", trimmed?.get("reason"), "joined-list spellings trim and case-fold")
        }
        // Outside the overlay the same spelling answers the never-existed shape again.
        assertEquals(false, caller.module["gonelegacy"].excluded.foundationValue,
                     "the alias answer follows the overlay's lifetime")
    }
}
