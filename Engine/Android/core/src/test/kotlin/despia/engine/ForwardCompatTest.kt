package despia.engine

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/// THE FORWARD-COMPAT SUITE — Article 7 (fail-open) + Article 8 (the wire is names, not
/// platforms), pinned so a NEWER dashboard / signed bundle targeting a FUTURE runtime never
/// hard-breaks an OLDER Android app. Every case feeds a SYNTHETIC unknown the current build
/// can't know about (a future envelope field, an unowned scheme, an unknown-shaped param, an
/// unknown markup tag) and asserts the SAME graceful degradation iOS gives:
///   • unknown INBOUND field  → ignored; routing survives; the reply carries EXACTLY the pinned
///     envelope key set (no future field leaks in OR out) — Context.swift resolve/sendError.
///   • unknown SCHEME         → the `not_loaded` envelope settles the call (never a silent hang),
///     even when the call carries future fields — VirtualBridge.swift / Messenger.swift.
///   • unknown-shaped PARAM   → Bridge.Params typed reads stay total (absent/foreign → null/false,
///     never a throw) — Bridge.swift Params.
///   • unknown markup TAG     → parses to an inert AST node the renderer has no branch for, so it
///     renders nothing — StackLive.swift ("an unknown tag renders nothing").
/// The web capability wire (`window.virtual` caps {version, structured, events, subscribe}) is the
/// BYTE-IDENTICAL shared runtime.js on both platforms: an ABSENT capability reads falsy → the cheap
/// fallback, a NEW capability an older runtime never reads is simply ignored — forward-compat by
/// construction (see runtime.js `despia.supports` / `fire`), so it needs no per-platform fixture.
/// Unique `fwd.*` schemes (the registry is a process singleton).
class ForwardCompatTest {

    private val dsx: Context = Module().dsx

    private fun <T> capturingWeb(body: (MutableList<DSXEgress>) -> T): T {
        val received = mutableListOf<DSXEgress>()
        val mount = DSXMessenger().mount("web") { received.add(it) }
        try { return body(received) } finally { mount.unmount() }
    }

    // -- unknown INBOUND envelope field: ignored, routing survives, reply stays pinned --

    private class EchoKnownMod : Module() {
        override val scheme get() = "fwd.echo"
        override fun setup() {
            dsx.action("probe") { dsx -> dsx.resolve(dsx.args("known")) }
        }
    }

    @Test fun unknownEnvelopeFieldIsIgnored_routingSurvives_replyStaysPinned() = capturingWeb { received ->
        ModuleRegistry.shared.register { EchoKnownMod() }
        // A FUTURE dashboard adds fields this build has never heard of (a scalar + a nested object).
        // They must not wedge routing, and must NOT appear in the reply — the reply is the pinned set.
        val future = mapOf<String, Any?>(
            "known" to "v",
            "future_field" to "surprise",
            "future_obj" to mapOf("nested" to listOf(1, 2, 3)),
        )
        assertTrue(ModuleRegistry.shared.handle(
            scheme = "fwd.echo", actionPath = "probe",
            params = Bridge.Params(dict = future, requestID = "w1", surfaceID = "web"),
            includeInternal = false))
        assertEquals(
            mapOf<String, Any?>(
                "id" to "w1", "scheme" to "fwd.echo", "host" to "probe",
                "event" to "result", "final" to true, "data" to "v",
            ),
            received.single().payload,
        )
    }

    // -- unknown SCHEME carrying future fields still settles not_loaded (never a silent hang) --

    @Test fun unknownSchemeWithFutureFieldsSettlesNotLoaded() {
        val received = mutableListOf<DSXEgress>()
        val mount = DSXMessenger().mount("fwd.surface") { received.add(it) }
        try {
            // A newer bundle calls a scheme this OLDER build doesn't ship, and passes a future arg.
            mount.receive("fwd.ghost", "do", mapOf("future_field" to "x"), rid = "r1")
            assertEquals(
                mapOf<String, Any?>(
                    "id" to "r1", "scheme" to "fwd.ghost", "host" to "do",
                    "event" to "error", "final" to true, "data" to null,
                    "code" to "not_loaded", "recoverable" to false,
                ),
                received.single().payload,
            )
        } finally { mount.unmount() }
    }

    // -- unknown-shaped / absent params: Bridge.Params typed reads stay total --

    @Test fun bridgeParamsToleratesUnknownAndAbsentKeys() {
        val p = Bridge.Params(
            dict = mapOf("known" to 7, "future_obj" to mapOf("x" to 1)),
            requestID = "r")
        // Known key reads through the typed accessor.
        assertEquals(7, p.int("known"))
        // A foreign-shaped value is preserved raw (a handler that DOES understand it can read it).
        assertNotNull(p.raw("future_obj"))
        // Absent keys never throw — the every-answer-is-optional contract (Article 7).
        assertNull(p.string("absent"))
        assertNull(p.int("absent"))
        assertFalse(p.bool("absent"))
        assertNull(p.array("absent"))
        assertNull(p.`object`("absent"))
        // The whole payload survives, unknown keys and all (forwarding stays lossless).
        assertTrue(p.all.containsKey("future_obj"))
    }

    // -- unknown markup TAG: parses to an inert AST node (renderer has no branch → renders nothing) --

    @Test fun unknownMarkupTagParsesToAnInertNode() {
        val root = StackXML.parse(
            """<future-widget foo="bar"><text value="hi"/></future-widget>""")
        assertNotNull(root)
        // The AST is generic — a tag is just a string, so a future element parses without loss.
        assertEquals("future-widget", root.tag)
        assertEquals("bar", root.attrs["foo"])
        // Its children survive too, so a known child inside a future wrapper still resolves.
        assertEquals(listOf("text"), root.children.map { it.tag })
        // The renderer's element `when` has NO branch for "future-widget" → it renders nothing
        // (StackNodeView.kt: "unknown tags render nothing"), byte-for-byte iOS's StackLive rule.
    }
}
