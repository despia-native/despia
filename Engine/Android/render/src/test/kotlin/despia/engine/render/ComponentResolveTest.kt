//
//  ComponentResolveTest.kt — plain-JVM units for ComposeStackComponents.resolve, the
//  registry's scoped + QUALIFIED tag resolution (the Stack.swift resolve(_:pkg:) twin,
//  Stack.swift ~357-373). The qualified branch is what lets an UNSCOPED env — a
//  Router-presented modal (RouterModalEntry) or a Router-pushed frame (:render's
//  RouterHost), both of which build scope-less JSERunners — reach a packaged
//  component by its wire name: presentComponent("menubar.Bar") / pushComponent
//  ("demo.Launcher"). Registrations use test-unique tags (the registry is process-global
//  and defineNode has no unregister — the other registry tests' convention).
//

package despia.engine.render

import java.io.File
import despia.engine.StackNode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ComponentResolveTest {
    @Test fun componentInvocationKeepsOneRunnerAcrossStoreRecomposition() {
        val source = File(
            "src/main/kotlin/despia/engine/render/StackNodeView.kt",
        ).readText()

        assertTrue(source.contains(
            "remember(env, node, owningScope) { copyEnv(env) }",
        ))
        assertTrue(source.contains(
            "remember(env, node, tag) { copyEnv(env) }",
        ))
        assertFalse(source.contains("val childEnv = copyEnv(env)"))
    }


    private fun node(tag: String) = StackNode(tag, emptyMap(), emptyList())

    // ── bare tags: package-local first, else global (unchanged behavior) ─────────────

    @Test fun bareTagPrefersTheConsumersOwnScopeThenGlobal() {
        ComposeStackComponents.defineNode("CrtPanel", node("vstack"), scope = "crtpkg")
        ComposeStackComponents.defineNode("CrtPanel", node("hstack"), scope = null)
        val local = ComposeStackComponents.resolve("CrtPanel", "crtpkg")
        assertNotNull(local)
        assertEquals("vstack", local!!.first.tag)
        assertEquals("crtpkg", local.second)
        val global = ComposeStackComponents.resolve("CrtPanel", "otherpkg")
        assertNotNull("an unrelated consumer falls back to the global registration", global)
        assertEquals("hstack", global!!.first.tag)
        assertNull(global.second)
    }

    // ── qualified tags: `<namespace.Name/>` addresses ONE scope explicitly ───────────

    @Test fun qualifiedTagResolvesThePackagesComponentFromAnUnscopedConsumer() {
        ComposeStackComponents.defineNode("CrtBar", node("zstack"), scope = "crtmenubar")
        // The Router-presented shape: RouterModalEntry's env has NO scope, the wire tag is
        // qualified — exactly presentComponent("crtmenubar.CrtBar").
        val resolved = ComposeStackComponents.resolve("crtmenubar.CrtBar", null)
        assertNotNull("a scope-less env must reach a packaged component by qualified name", resolved)
        assertEquals("zstack", resolved!!.first.tag)
        assertEquals("crtmenubar", resolved.second)
    }

    @Test fun qualifiedTagBypassesTheConsumersLocalComponent() {
        ComposeStackComponents.defineNode("CrtCard", node("vstack"), scope = "crtconsumer")
        ComposeStackComponents.defineNode("CrtCard", node("scroll"), scope = "crtvendor")
        // Explicit addressing wins over local-first: the consumer's own CrtCard is skipped.
        val resolved = ComposeStackComponents.resolve("crtvendor.CrtCard", "crtconsumer")
        assertNotNull(resolved)
        assertEquals("scroll", resolved!!.first.tag)
        assertEquals("crtvendor", resolved.second)
    }

    @Test fun sharedAndGlobalPrefixesAddressTheUniversalPool() {
        ComposeStackComponents.defineNode("CrtChip", node("hstack"), scope = null)
        ComposeStackComponents.defineNode("CrtChip", node("vstack"), scope = "crtpkg")
        for (prefix in listOf("shared", "global")) {
            val resolved = ComposeStackComponents.resolve("$prefix.CrtChip", "crtpkg")
            assertNotNull("$prefix.CrtChip must reach the scope-less pool", resolved)
            assertEquals("hstack", resolved!!.first.tag)
            assertNull(resolved.second)
        }
    }

    @Test fun unknownQualifiedTagResolvesToNull() {
        assertNull(ComposeStackComponents.resolve("nosuchpkg.CrtGhost", null))
        assertNull(ComposeStackComponents.resolve("shared.CrtGhost", "crtpkg"))
    }

    // The Router capability gate receives the same qualified wire name it will render.
    // It must neither reject a shipped package component nor accidentally accept a
    // same-named component from another scope.
    @Test fun hasAcceptsOnlyTheExplicitlyQualifiedComponentScope() {
        ComposeStackComponents.defineNode("CrtQualifiedGate", node("vstack"), scope = "crtdemo")

        assertTrue(ComposeStackComponents.has("crtdemo.CrtQualifiedGate"))
        assertFalse(ComposeStackComponents.has("crtwrong.CrtQualifiedGate"))
    }

    @Test fun hasKeepsBareNamesScopeBlindAndSharedAliasesGlobal() {
        ComposeStackComponents.defineNode("CrtBareGate", node("hstack"), scope = "crtpkg")
        ComposeStackComponents.defineNode("CrtSharedGate", node("text"), scope = null)

        assertTrue(ComposeStackComponents.has("CrtBareGate"))
        assertTrue(ComposeStackComponents.has("shared.CrtSharedGate"))
        assertTrue(ComposeStackComponents.has("global.CrtSharedGate"))
        assertFalse(ComposeStackComponents.has("shared.CrtBareGate"))
    }
}
