package despia.engine.render

import despia.engine.CSSResolver
import despia.engine.StackStore
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RenderSubscriptionPolicyTest {
    @Test
    fun nodesReuseOnlyTheirOwnSurfaceRootsSubscriptionBundle() {
        val surface = StackStore()

        assertTrue(RenderSubscriptionPolicy.usesRootSubscription(surface, surface))
        assertFalse(RenderSubscriptionPolicy.usesRootSubscription(null, surface))
        assertFalse(
            RenderSubscriptionPolicy.usesRootSubscription(StackStore(), surface)
        )
    }

    @Test
    fun nodesReuseTheRootCssEnvironmentAndStandaloneNodesCreateTheirOwn() {
        val inherited = CSSResolver.Context(
            isDark = false,
            windowWidth = 400.0,
            windowHeight = 800.0,
            fontScale = 1.0,
            reduceMotion = false,
        )

        assertTrue(RenderEnvironmentPolicy.usesRootEnvironment(inherited))
        assertFalse(RenderEnvironmentPolicy.usesRootEnvironment(null))
    }

    @Test
    fun growParticipatesOnlyOnTheParentStacksMainAxis() {
        listOf("true", "both").forEach { grow ->
            assertTrue(FlexChildPolicy.growsOnMainAxis(grow, horizontal = true))
            assertTrue(FlexChildPolicy.growsOnMainAxis(grow, horizontal = false))
        }
        assertTrue(FlexChildPolicy.growsOnMainAxis("width", horizontal = true))
        assertFalse(FlexChildPolicy.growsOnMainAxis("width", horizontal = false))
        assertTrue(FlexChildPolicy.growsOnMainAxis("height", horizontal = false))
        assertFalse(FlexChildPolicy.growsOnMainAxis("height", horizontal = true))
        assertFalse(FlexChildPolicy.growsOnMainAxis(null, horizontal = true))
        assertFalse(FlexChildPolicy.growsOnMainAxis("1", horizontal = false))
    }

    @Test
    fun onlyHeightOwningPlainVerticalScrollStacksVirtualize() {
        val safe = despia.engine.StackNode(
            "stack",
            emptyMap(),
            listOf(despia.engine.StackNode("text", mapOf("value" to "Visible"), emptyList())),
        )
        assertTrue(ScrollVirtualizationPolicy.outerOwnsHeight(mapOf("grow" to "true")))
        assertTrue(ScrollVirtualizationPolicy.canVirtualize(safe, emptyMap()))

        assertFalse(ScrollVirtualizationPolicy.outerOwnsHeight(emptyMap()))
        assertFalse(
            ScrollVirtualizationPolicy.canVirtualize(
                safe,
                mapOf("flexDirection" to "row"),
            ),
        )
        assertFalse(
            ScrollVirtualizationPolicy.canVirtualize(
                despia.engine.StackNode(
                    "stack",
                    emptyMap(),
                    listOf(despia.engine.StackNode("head", emptyMap(), emptyList())),
                ),
                emptyMap(),
            ),
        )
        assertFalse(
            ScrollVirtualizationPolicy.canVirtualize(
                despia.engine.StackNode(
                    "stack",
                    emptyMap(),
                    listOf(despia.engine.StackNode("spacer", emptyMap(), emptyList())),
                ),
                emptyMap(),
            ),
        )
        assertFalse(
            ScrollVirtualizationPolicy.canVirtualize(
                safe,
                mapOf("on:appear" to "ready = true"),
            ),
        )
    }

    @Test
    fun outerVerticalViewportOwnsNestedDsxScrolls() {
        assertTrue(ScrollNestingPolicy.ownsVerticalViewport(false))
        assertFalse(ScrollNestingPolicy.ownsVerticalViewport(true))
    }

    @Test
    fun nestedGridUsesEagerRowsWhileRootGridRemainsVirtualized() {
        assertTrue(GridScrollPolicy.usesEagerRows(scroll = null, inVerticalScrollContainer = true))
        assertTrue(GridScrollPolicy.usesEagerRows(scroll = "false", inVerticalScrollContainer = false))
        assertFalse(GridScrollPolicy.usesEagerRows(scroll = null, inVerticalScrollContainer = false))
        assertFalse(GridScrollPolicy.usesEagerRows(scroll = "true", inVerticalScrollContainer = false))
    }

    @Test
    fun cssRowWrapUsesTheBoundedFlowLayoutOnlyForRows() {
        assertTrue(FlexWrapPolicy.wrapsRows("row", "wrap"))
        assertTrue(FlexWrapPolicy.wrapsRows("row-reverse", "wrap"))
        assertFalse(FlexWrapPolicy.wrapsRows("row", "nowrap"))
        assertFalse(FlexWrapPolicy.wrapsRows("column", "wrap"))
    }
}
