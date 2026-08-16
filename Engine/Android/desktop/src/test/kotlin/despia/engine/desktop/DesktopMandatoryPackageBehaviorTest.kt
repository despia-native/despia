package despia.engine.desktop

import despia.engine.Bridge
import despia.engine.Module
import despia.engine.ModuleCallError
import despia.engine.ModuleRegistry
import java.net.URI
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Behavior evidence for the two package facets in the production-minimal
 * Windows/Linux graph. Catalog rows and reflection alone are not qualification. */
class DesktopMandatoryPackageBehaviorTest {
    private class ProbeA : Module() {
        override val scheme get() = "desktopmatrixprobea"
        override fun setup() {
            dsx.action { call ->
                probeACalls.incrementAndGet()
                call.resolve()
            }
        }
    }

    private class ProbeB : Module() {
        override val scheme get() = "desktopmatrixprobeb"
        override fun setup() {
            dsx.action { call ->
                probeBCalls.incrementAndGet()
                call.resolve()
            }
        }
    }

    @Test
    fun stateFacetReadsWritesAndRejectsMissingKeys() {
        DesktopHost.boot("Linux")
        val key = "desktopQualification.${UUID.randomUUID()}"

        assertNull(call("global", "set", mapOf("key" to key, "value" to mapOf("ready" to true))))
        assertEquals(mapOf("ready" to true), call("global", "get", mapOf("key" to key)))

        val missing = assertFailsWith<ModuleCallError.ActionFailed> {
            call("global", "set", emptyMap())
        }
        assertEquals("missing_key", missing.code)
    }

    @Test
    fun multiApiCallBoundsFanoutAndNeverRecursesIntoItself() {
        DesktopHost.boot("Linux")
        ModuleRegistry.shared.register { ProbeA() }
        ModuleRegistry.shared.register { ProbeB() }
        probeACalls.set(0)
        probeBCalls.set(0)

        val result = callLegacyUrl(
            URI("multiapicall://desktopmatrixprobea,desktopmatrixprobeb,1invalid,multiapicall"),
        )
        assertEquals("result", result["event"])
        assertEquals(1, probeACalls.get())
        assertEquals(1, probeBCalls.get())

        val tooMany = (1..65).joinToString(",") { "desktopmatrixprobea" }
        val countFailure = callLegacyUrl(URI("multiapicall://$tooMany"))
        assertEquals("error", countFailure["event"])
        assertEquals("fanout_too_large", countFailure["code"])

        val oversized = "a".repeat(8 * 1024)
        val byteFailure = callLegacyUrl(URI("multiapicall://$oversized"))
        assertEquals("error", byteFailure["event"])
        assertEquals("fanout_too_large", byteFailure["code"])
        assertEquals(1, probeACalls.get())
        assertEquals(1, probeBCalls.get())
    }

    private fun call(scheme: String, action: String, args: Map<String, Any?>): Any? = runBlocking {
        caller.module[scheme][action](args).foundationValue
    }

    private fun callLegacyUrl(uri: URI): Map<String, Any?> {
        val received = ArrayList<Map<String, Any?>>()
        val surface = "desktop-package-${UUID.randomUUID()}"
        val mount = caller.messenger.mount(surface) { received += it.payload }
        try {
            assertTrue(caller.handle(uri, Bridge.Params(url = uri, surfaceID = surface)))
            return assertIs<Map<String, Any?>>(received.single())
        } finally {
            mount.unmount()
        }
    }

    private companion object {
        val caller = Module().dsx
        val probeACalls = AtomicInteger()
        val probeBCalls = AtomicInteger()
    }
}
