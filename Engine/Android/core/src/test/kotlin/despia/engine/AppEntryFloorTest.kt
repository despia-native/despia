package despia.engine

import org.junit.jupiter.api.AfterEach
import kotlin.test.Test
import kotlin.test.assertEquals

/** Pure policy tests for the native host's empty/malformed/pre-boot entry floor.
 *  ROOT-PLAN law (root-plan.md): the floor mirrors the plan's FIRST candidate verbatim —
 *  view + config.src/config.origin — and an app with no plan derives an EMPTY tag: the
 *  kernel names no surface in either direction (no web floor, no starter literal); the
 *  boot diagnostic owns the empty state. Which views are legal is the BUILD's business
 *  (root_plan_schema.rb), never a kernel branch. */
class AppEntryFloorTest {

    @AfterEach fun teardown() {
        AppManifest.manifestLoader = { null }
        AppManifest.engineConfigLoader = { null }
    }

    @Test fun committedStarterResolvesToCompiledNativeDsxStartup() {
        AppManifest.manifestLoader = {
            """{ "entry": { "root": "/", "surfaces": ["DSXStartup"] } }"""
        }
        val node = AppManifest.entryFloorNode()
        assertEquals("DSXStartup", node.tag)
        assertEquals(mapOf("src" to "", "path" to "/", "origin" to ""), node.attrs)
    }

    @Test fun configuredNativeCandidatePreservesViewSrcRootPathAndOrigin() {
        AppManifest.manifestLoader = {
            """{
                "entry": {
                    "root": "/home",
                    "surfaces": [
                        { "view": "DSXView", "config": { "src": "/dsx/offline/", "origin": "app" } }
                    ]
                }
            }"""
        }
        val node = AppManifest.entryFloorNode()
        assertEquals("DSXView", node.tag)
        assertEquals(
            mapOf("src" to "/dsx/offline/", "path" to "/home", "origin" to "app"),
            node.attrs,
        )
    }

    @Test fun aWebCandidateIsOrdinaryPlanDataNotAKernelPolicy() {
        AppManifest.manifestLoader = {
            """{
                "entry": {
                    "root": "/inbox",
                    "surfaces": [
                        { "view": "DSXWebView", "config": { "src": "/shell", "origin": "https://app.example.com" } }
                    ]
                }
            }"""
        }
        val node = AppManifest.entryFloorNode()
        assertEquals("DSXWebView", node.tag)
        assertEquals(
            mapOf(
                "src" to "/shell",
                "path" to "/inbox",
                "origin" to "https://app.example.com",
            ),
            node.attrs,
        )
    }

    @Test fun missingOrMalformedPlanNamesNoSurfaceAtAll() {
        // Even with a legacy defaults.view present in EngineConfig, the retired web floor
        // never comes back: no plan ⇒ empty tag, and the boot diagnostic owns that state.
        AppManifest.engineConfigLoader = {
            """{ "defaults": { "view": "DSXWebView" } }"""
        }
        val cases = listOf<Pair<String?, String>>(
            null to "/",
            "not json" to "/",
            "{}" to "/",
            """{ "entry": { "root": "/safe" } }""" to "/safe",
            """{ "entry": { "root": "/", "surfaces": [] } }""" to "/",
            """{ "entry": { "surfaces": ["   "] } }""" to "/",
            """{ "entry": { "surfaces": [7] } }""" to "/",
        )
        for ((manifest, expectedPath) in cases) {
            AppManifest.manifestLoader = { manifest }
            val node = AppManifest.entryFloorNode()
            assertEquals("", node.tag, "manifest=$manifest")
            assertEquals(expectedPath, node.attrs["path"], "manifest=$manifest")
            assertEquals("", node.attrs["src"], "manifest=$manifest")
            assertEquals("", node.attrs["origin"], "manifest=$manifest")
        }
    }

    @Test fun anyComponentRidesThePlanVerbatimIncludingWebView() {
        // The old kernel ban on `WebView` as the floor is RETIRED name-policy: the kernel
        // renders what the plan declares; eligibility lives in the build validator.
        AppManifest.manifestLoader = {
            """{
                "entry": {
                    "surfaces": [ { "view": "WebView", "config": { "src": "https://app.example.com" } } ]
                }
            }"""
        }
        val node = AppManifest.entryFloorNode()
        assertEquals("WebView", node.tag)
        assertEquals(
            mapOf("src" to "https://app.example.com", "path" to "/", "origin" to ""),
            node.attrs,
        )
    }
}
