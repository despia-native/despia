//
//  RouterChromeTest.kt — plain-JVM units for the chrome host's pure half
//  (elements/RouterChrome.kt `RouterChromeSpec.derive`): the TOP-frame claim lookup over the
//  published `global.nav.*` shapes (RouterTest pins the writer side), the RouterHost.swift
//  fail-open rules (no claim / empty-title claim → no bar), and the back-affordance flag.
//  The composables themselves are gated by compilation (:render:assembleDebug).
//

package despia.engine.render

import despia.engine.StackXML
import despia.engine.render.elements.RouterChromeSpec
import despia.engine.render.elements.RouterChromeInsetsPolicy
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RouterChromeTest {

    @Test fun routeChromeUsesRealMaterialAppBars() {
        val source = File(
            "src/main/kotlin/despia/engine/render/elements/RouterChrome.kt",
        ).readText()
        assertTrue(source.contains("TopAppBar("))
        assertTrue(source.contains("LargeTopAppBar("))
        assertTrue(source.contains("TopAppBarDefaults.exitUntilCollapsedScrollBehavior()"))
        assertTrue(source.contains(".nestedScroll(scrollBehavior.nestedScrollConnection)"))
        assertTrue(source.contains("scrollBehavior = scrollBehavior"))
        assertTrue(source.contains("WindowInsets.safeDrawing.only("))
        assertTrue(source.contains("WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom"))
        assertTrue(source.contains("WindowInsetsSides.Top + WindowInsetsSides.Horizontal"))
        assertTrue(source.contains(".background(MaterialTheme.colorScheme.background)"))
        assertTrue(source.contains("IconButton("))
        assertFalse(source.contains("BasicText("))
        assertFalse(source.contains("detectTapGestures"))
    }

    @Test fun frameOwnsTheStatusBarInsetOnlyWhenNoSystemBarConsumesIt() {
        assertTrue(RouterChromeInsetsPolicy.frameOwnsTopInset(hasSystemBar = false))
        assertFalse(RouterChromeInsetsPolicy.frameOwnsTopInset(hasSystemBar = true))
    }

    @Test fun largeChromeAdaptsToCompactWindowHeight() {
        assertFalse(RouterChromeSpec.usesLargeBar(requested = false, windowHeightDp = 900.0))
        assertFalse(RouterChromeSpec.usesLargeBar(requested = true, windowHeightDp = 479.99))
        assertTrue(RouterChromeSpec.usesLargeBar(requested = true, windowHeightDp = 480.0))
        assertTrue(RouterChromeSpec.usesLargeBar(requested = true, windowHeightDp = 900.0))
    }

    private fun nav(stack: List<Map<String, Any?>>, chrome: Map<String, Any?>,
                    canPop: Boolean = stack.size > 1): Map<String, Any?> =
        mapOf("nav" to mapOf("stack" to stack, "chrome" to chrome,
                             "canPop" to canPop, "depth" to stack.size,
                             "modal" to emptyList<Any?>()))

    private fun frame(id: Any): Map<String, Any?> = mapOf("id" to id, "path" to "/", "view" to "DSXView")

    // ── the claim lookup: TOP frame only, string-keyed like the Router publishes ────────

    @Test fun derivesTheTopFramesClaim() {
        val vars = nav(listOf(frame(1), frame(2)),
                       mapOf("2" to mapOf("title" to "Cart", "large" to true)))
        val spec = RouterChromeSpec.derive(vars)!!
        assertEquals("Cart", spec.title)
        assertEquals(true, spec.large)
        assertEquals(true, spec.canPop)
    }

    @Test fun aCoveredFramesClaimDrawsNoBar() {
        // The claim belongs to frame 1, but frame 2 is on top → no bar (chrome targets the top).
        val vars = nav(listOf(frame(1), frame(2)),
                       mapOf("1" to mapOf("title" to "Under", "large" to false)))
        assertNull(RouterChromeSpec.derive(vars))
    }

    // ── fail-open (Article 7 — RouterHost.swift parity) ─────────────────────────────────

    @Test fun noClaimAndEmptyTitleClaimDrawNoBar() {
        assertNull(RouterChromeSpec.derive(emptyMap()))                              // no nav at all
        assertNull(RouterChromeSpec.derive(nav(emptyList(), emptyMap())))            // empty stack
        assertNull(RouterChromeSpec.derive(nav(listOf(frame(1)), emptyMap())))       // no claim
        assertNull(RouterChromeSpec.derive(                                          // empty title = no claim
            nav(listOf(frame(1)), mapOf("1" to mapOf("title" to "", "large" to true)))))
    }

    @Test fun defaultsAreSmallBarAndNoBackAtRoot() {
        val spec = RouterChromeSpec.derive(
            nav(listOf(frame(1)), mapOf("1" to mapOf("title" to "Home"))))!!
        assertEquals(false, spec.large)                        // large absent → small bar
        assertEquals(false, spec.canPop)                       // root → no back affordance
    }

    // ── the BACK-relay flag: claim or no claim, fail-open to false ──────────────────────

    @Test fun canPopDerivesWithOrWithoutAClaim() {
        assertEquals(false, RouterChromeSpec.canPop(emptyMap()))                       // no nav
        assertEquals(false, RouterChromeSpec.canPop(nav(listOf(frame(1)), emptyMap())))
        assertEquals(true, RouterChromeSpec.canPop(nav(listOf(frame(1), frame(2)), emptyMap())))
    }

    @Test fun componentChromeHintIsDataOwnedAndFailsOpenForDynamicOrCustomClaims() {
        val chrome = requireNotNull(StackXML.parse(
            """<stack><head><action as="claim">dsx.module.route.chrome({ title: dsx.attribute.title })</action></head></stack>"""
        ))
        ComposeStackComponents.defineNode("QualificationChromeProbe", chrome, null)

        val literal = requireNotNull(StackXML.parse(
            """<stack><QualificationChromeProbe title="System &amp; app" large="true"/></stack>"""
        ))
        ComposeStackComponents.defineNode("QualificationLiteralPage", literal, "qualification")
        assertEquals(
            mapOf<String, Any?>("title" to "System & app", "large" to true),
            ComposeStackComponents.systemChromeHint(
                "qualification.QualificationLiteralPage",
                null,
            ),
        )

        val dynamic = requireNotNull(StackXML.parse(
            """<stack><QualificationChromeProbe title="{{ dsx.variable.title }}"/></stack>"""
        ))
        ComposeStackComponents.defineNode("QualificationDynamicPage", dynamic, "qualification")
        assertNull(
            ComposeStackComponents.systemChromeHint(
                "qualification.QualificationDynamicPage",
                null,
            ),
        )

        val custom = requireNotNull(StackXML.parse(
            """<stack><QualificationChromeProbe title="Owned" system="false"/></stack>"""
        ))
        ComposeStackComponents.defineNode("QualificationCustomPage", custom, "qualification")
        assertNull(
            ComposeStackComponents.systemChromeHint(
                "qualification.QualificationCustomPage",
                null,
            ),
        )
    }
}
