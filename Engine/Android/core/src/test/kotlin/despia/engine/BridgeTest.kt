package despia.engine

import java.net.URI
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class BridgeTest {

    @Test fun mountedParamsCarryTheExactMessengerGeneration() {
        val generation = DSXMessengerRegistration { }
        val params = Bridge.Params(
            dict = mapOf("value" to 7),
            requestID = "r-generation",
            surfaceID = "surface-stable-id",
            messengerRegistration = generation,
        )

        assertEquals("surface-stable-id", params.surfaceID)
        assertEquals("r-generation", params.requestID)
        assertTrue(params.hasMessengerRegistration)
        assertSame(generation, params.messengerRegistration)
    }

    @Test fun legacyStructuredAndUrlParamsDoNotAcquireAGeneration() {
        val structured = Bridge.Params(
            dict = emptyMap(),
            requestID = null,
            surfaceID = "web",
        )
        val url = Bridge.Params(URI("probe://run?__rid=legacy"), surfaceID = "web")

        assertNull(structured.messengerRegistration)
        assertNull(url.messengerRegistration)
        assertFalse(structured.hasMessengerRegistration)
        assertFalse(url.hasMessengerRegistration)
    }

    @Test fun paramsNeverStronglyRetainAMountedSurfaceGeneration() {
        assertFalse(
            Bridge.Params::class.java.declaredFields.any {
                it.type == DSXMessengerRegistration::class.java
            },
            "Bridge.Params must not keep a torn-down surface sink alive",
        )
    }
}
