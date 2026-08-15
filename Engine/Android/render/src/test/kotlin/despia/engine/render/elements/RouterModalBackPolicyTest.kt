package despia.engine.render.elements

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RouterModalBackPolicyTest {
    @Test
    fun blockingOverlayConsumesBack() {
        assertTrue(
            RouterModalBackPolicy.blocks(
                listOf(mapOf("as" to "overlay", "touch" to "block")),
            ),
        )
    }

    @Test
    fun passthroughAndChainSurfacesDoNotConsumeBack() {
        assertFalse(
            RouterModalBackPolicy.blocks(
                listOf(
                    mapOf("as" to "overlay", "touch" to "passthrough"),
                    mapOf("as" to "sheet", "touch" to "block"),
                    mapOf("as" to "cover"),
                ),
            ),
        )
    }

    @Test
    fun oneBlockingOverlayLocksAMixedPresentationLedger() {
        assertTrue(
            RouterModalBackPolicy.blocks(
                listOf(
                    mapOf("as" to "sheet"),
                    mapOf("as" to "overlay", "touch" to "block"),
                    mapOf("as" to "overlay", "touch" to "passthrough"),
                ),
            ),
        )
    }

    @Test
    fun emptyAndMalformedRestoredStateFailsOpen() {
        assertFalse(RouterModalBackPolicy.blocks(emptyList()))
        assertFalse(
            RouterModalBackPolicy.blocks(
                listOf(
                    emptyMap<String, Any?>(),
                    mapOf("as" to 1, "touch" to true),
                ),
            ),
        )
    }
}
