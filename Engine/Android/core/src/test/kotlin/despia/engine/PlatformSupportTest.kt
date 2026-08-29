package despia.engine

import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/// THE UNSUPPORTED-PLATFORM ENVELOPE SUITE — the graceful catalog answer, pinned for both
/// kernels (the envelope contract lives in OpenSource/Skills/android/api-mapping.md).
/// `ModuleRegistry.platformSupport` (default empty = today's behavior) is the pure-JVM seam:
/// each test installs a catalog map and asserts the THREE-WAY distinction on every surface —
///   • unsupported_platform — scheme in the catalog, no implementation on this OS
///   • not_loaded           — implemented on this OS but excluded by THIS app
///   • not_loaded           — unknown scheme (not in the catalog at all)
/// `dsx.has` stays FALSE for all three (feature detection remains the primary pattern).
/// Unique schemes per test where a module registers (the registry is a process singleton);
/// "scene3d" is the real D-class example the generator emits as ["ios"].
class PlatformSupportTest {

    /// A detached caller handle — Swift's "any dsx reaches the bus".
    private val dsx: Context = Module().dsx

    /// The pinned envelope pieces for the canonical example.
    private val scene3dData = mapOf<String, Any?>(
        "scheme" to "scene3d", "platform" to "android", "supportedPlatforms" to listOf("ios"))
    private val scene3dMessage = "Scene3d is not supported on Android"

    @AfterTest fun restoreSeams() {
        ModuleRegistry.shared.platformSupport = emptyMap()
        ModuleRegistry.shared.platformSupportByAction = emptyMap()
        JSERunner.moduleHandle = { _, _, _ -> false }
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    // -- the seam itself --

    @Test fun defaultEmptyMapIsTodaysBehavior() {
        assertNull(ModuleRegistry.shared.unsupportedPlatforms("scene3d"))
        assertEquals("android", ModuleRegistry.shared.currentPlatform)
    }

    // -- the ACTION rows (X2 §4 `platforms`) --

    @Test fun anActionWithNoNarrowingAnswersExactlyAsItsModuleDoes() {
        ModuleRegistry.shared.platformSupport = mapOf("scene3d" to listOf("ios"))
        ModuleRegistry.shared.platformSupportByAction = mapOf("scene3d.load" to listOf("ios"))
        // no row for `unload` — it inherits, byte for byte
        assertEquals(listOf("ios"), ModuleRegistry.shared.unsupportedPlatforms("scene3d", "unload"))
        assertEquals(listOf("ios"), ModuleRegistry.shared.unsupportedPlatforms("scene3d", null))
        assertEquals(listOf("ios"), ModuleRegistry.shared.unsupportedPlatforms("scene3d", ""))
    }

    @Test fun anActionRowOutranksItsModuleRowInBothDirections() {
        // The module IS implemented here; ONE action is not. The scheme-only lookup cannot see
        // this, which is the whole reason the action table exists.
        ModuleRegistry.shared.platformSupport = mapOf("health" to listOf("ios", "android"))
        ModuleRegistry.shared.platformSupportByAction = mapOf("health.workouts" to listOf("ios"))
        assertNull(ModuleRegistry.shared.unsupportedPlatforms("health"))
        assertNull(ModuleRegistry.shared.unsupportedPlatforms("health", "read"))
        assertEquals(listOf("ios"), ModuleRegistry.shared.unsupportedPlatforms("health", "workouts"))
        // …and the other way: the module is off-platform, one action is not
        ModuleRegistry.shared.platformSupport = mapOf("wallet" to listOf("ios"))
        ModuleRegistry.shared.platformSupportByAction = mapOf("wallet.status" to listOf("ios", "android"))
        assertEquals(listOf("ios"), ModuleRegistry.shared.unsupportedPlatforms("wallet", "add"))
        assertNull(ModuleRegistry.shared.unsupportedPlatforms("wallet", "status"))
    }

    @Test fun actionKeysAreCaseInsensitiveAndSlashFolded() {
        ModuleRegistry.shared.platformSupportByAction = mapOf("watch.health.heartrate" to listOf("ios"))
        assertEquals(listOf("ios"), ModuleRegistry.shared.unsupportedPlatforms("Watch.Health", "HeartRate"))
        assertEquals(listOf("ios"), ModuleRegistry.shared.unsupportedPlatforms("watch.health", "heartRate"))
        // the wire spells a nested action path with '/', the manifest with '.'
        ModuleRegistry.shared.platformSupportByAction = mapOf("files.pick.image" to listOf("ios"))
        assertEquals(listOf("ios"), ModuleRegistry.shared.unsupportedPlatforms("files", "pick/image"))
    }

    @Test fun theLadderPutsAnActionNarrowingAheadOfUnknownAction() {
        // A module that is present and correct here still cannot run an action its manifest
        // declares impossible — and `unknown_action` would blame the caller for it.
        assertEquals("unsupported_platform",
                     FacetLadder.resolve(FacetFacts(module = true, offPlatformAction = true)).code)
        assertEquals("unknown_action", FacetLadder.resolve(FacetFacts(module = true)).code)
        assertEquals("unsupported_platform", FacetLadder.resolve(FacetFacts(offPlatform = true)).code)
        // rung one still wins: a local handler never consults the catalog
        assertEquals(FacetLadder.Rung.LOCAL,
                     FacetLadder.resolve(FacetFacts(local = true, offPlatformAction = true)).rung)
    }

    @Test fun lookupIsCaseInsensitiveAndDataLowercases() {
        ModuleRegistry.shared.platformSupport = mapOf("scene3d" to listOf("ios"))
        assertEquals(listOf("ios"), ModuleRegistry.shared.unsupportedPlatforms("Scene3D"))
        assertEquals(scene3dData, ModuleRegistry.shared.unsupportedPlatformData("Scene3D", listOf("ios")))
        assertEquals(scene3dMessage, ModuleRegistry.shared.unsupportedPlatformMessage("Scene3D"))
    }

    @Test fun desktopBootIdentityDrivesHonestUnsupportedPlatformEnvelopes() {
        ModuleRegistry.shared.platformSupport = mapOf(
            "appleonly" to listOf("ios", "macos"),
            "desktopopen" to listOf("windows", "linux"),
        )

        Platform.os = "linux"
        assertEquals("linux", ModuleRegistry.shared.currentPlatform)
        assertEquals(listOf("ios", "macos"), ModuleRegistry.shared.unsupportedPlatforms("appleonly"))
        assertNull(ModuleRegistry.shared.unsupportedPlatforms("desktopopen"))
        assertEquals(
            mapOf<String, Any?>(
                "scheme" to "appleonly",
                "platform" to "linux",
                "supportedPlatforms" to listOf("ios", "macos"),
            ),
            ModuleRegistry.shared.unsupportedPlatformData("appleonly", listOf("ios", "macos")),
        )
        assertEquals("Appleonly is not supported on Linux", ModuleRegistry.shared.unsupportedPlatformMessage("appleonly"))

        Platform.os = "windows"
        assertEquals("windows", ModuleRegistry.shared.currentPlatform)
        assertNull(ModuleRegistry.shared.unsupportedPlatforms("desktopopen"))
        assertEquals("Appleonly is not supported on Windows", ModuleRegistry.shared.unsupportedPlatformMessage("appleonly"))
    }

    @Test fun malformedPlatformIdentityCannotMasqueradeAsADeclaredTarget() {
        ModuleRegistry.shared.platformSupport = mapOf("sample" to listOf("linux"))
        for (identity in listOf("freebsd", "ios", "web", "watch", "wear", "", "LINUX")) {
            Platform.os = identity
            assertEquals("android", ModuleRegistry.shared.currentPlatform, identity)
            assertEquals(listOf("linux"), ModuleRegistry.shared.unsupportedPlatforms("sample"), identity)
        }
    }

    @Test fun hasStaysFalseForUnsupportedSchemes() {
        // Feature detection remains the primary pattern — the map never fakes availability.
        ModuleRegistry.shared.platformSupport = mapOf("scene3d" to listOf("ios"))
        assertFalse(dsx.has("scene3d"))
    }

    // -- native chain (dsx.module) --

    @Test fun moduleChainThrowsStructuredUnsupportedPlatform() = runBlocking<Unit> {
        ModuleRegistry.shared.platformSupport = mapOf("scene3d" to listOf("ios"))
        val e = kotlin.test.assertFailsWith<ModuleCallError.ActionFailed> {
            dsx.module["scene3d"]["show"](mapOf("src" to "model.usdz"))
        }
        assertEquals("unsupported_platform", e.code)
        assertEquals(scene3dData, e.data)
    }

    @Test fun moduleChainPostThrowsStructuredUnsupportedPlatform() {
        ModuleRegistry.shared.platformSupport = mapOf("liveactivity" to listOf("ios"))
        val e = kotlin.test.assertFailsWith<ModuleCallError.ActionFailed> {
            dsx.module["liveactivity"]["start"].post()
        }
        assertEquals("unsupported_platform", e.code)
        assertEquals(mapOf<String, Any?>("scheme" to "liveactivity", "platform" to "android",
                                         "supportedPlatforms" to listOf("ios")), e.data)
    }

    @Test fun excludedButSupportedSchemeKeepsNotLoaded() = runBlocking<Unit> {
        // Implemented on Android, just not shipped by THIS app — a different situation,
        // and it keeps today's answer.
        ModuleRegistry.shared.platformSupport = mapOf("pst.excluded" to listOf("ios", "android"))
        val e = kotlin.test.assertFailsWith<ModuleCallError.NotLoaded> {
            dsx.module["pst.excluded"]["anything"]()
        }
        assertEquals("pst.excluded", e.scheme)
    }

    @Test fun unknownSchemeKeepsNotLoaded() = runBlocking<Unit> {
        // Not in the catalog at all — today's behavior, untouched.
        ModuleRegistry.shared.platformSupport = mapOf("scene3d" to listOf("ios"))
        val e = kotlin.test.assertFailsWith<ModuleCallError.NotLoaded> {
            dsx.module["pst.ghost"]["anything"]()
        }
        assertEquals("pst.ghost", e.scheme)
    }

    private class RegisteredAnyway : Module() {
        override val scheme get() = "pst.reg"
        override fun setup() { dsx.action("ping") { dsx -> dsx.resolve("pong") } }
    }

    @Test fun aRegisteredModuleAlwaysWinsOverTheMap() = runBlocking {
        // The consult happens only AFTER dispatch came back unhandled — a module that IS
        // loaded routes normally even if a stale map claims it's ios-only.
        ModuleRegistry.shared.platformSupport = mapOf("pst.reg" to listOf("ios"))
        ModuleRegistry.shared.register { RegisteredAnyway() }
        assertEquals("pong", dsx.module["pst.reg"]["ping"]().foundationValue)
    }

    // -- surface mounts (the web promise rides the "web" mount) --

    @Test fun mountSynthesizesTheFullUnsupportedPlatformEnvelope() {
        ModuleRegistry.shared.platformSupport = mapOf("scene3d" to listOf("ios"))
        val received = mutableListOf<DSXEgress>()
        val mount = DSXMessenger().mount("pst.surface") { received.add(it) }
        try {
            mount.receive("scene3d", "show", mapOf("src" to "model.usdz"), rid = "r1")
            val e = received.single()
            assertEquals("r1", e.rid)
            assertEquals(
                mapOf<String, Any?>(
                    "id" to "r1", "scheme" to "scene3d", "host" to "show",
                    "event" to "error", "final" to true, "data" to scene3dData,
                    "code" to "unsupported_platform", "recoverable" to false,
                    "message" to scene3dMessage,
                ),
                e.payload,
            )
        } finally { mount.unmount() }
    }

    @Test fun mountKeepsNotLoadedForExcludedAndUnknownSchemes() {
        ModuleRegistry.shared.platformSupport = mapOf("pst.both" to listOf("ios", "android"))
        val received = mutableListOf<DSXEgress>()
        val mount = DSXMessenger().mount("pst.surface2") { received.add(it) }
        try {
            mount.receive("pst.both", "x", rid = "r2")      // supported here, excluded by the app
            mount.receive("pst.never", "x", rid = "r3")     // unknown — not in the catalog
            assertEquals(2, received.size)
            for (e in received) {
                assertEquals("not_loaded", e.payload["code"])
                assertFalse(e.payload.containsKey("message"))   // the plain envelope, unchanged
                assertNull(e.payload["data"])
            }
        } finally { mount.unmount() }
    }

    // -- markup (the JSE runner's moduleHandle seam, bound by DSXModuleCallMount) --

    @Test fun markupBindingSettlesUnsupportedPlatformStructured() {
        ModuleRegistry.shared.platformSupport = mapOf("scene3d" to listOf("ios"))
        DSXModuleCallMount.bindRegistry()
        var outcome: JSEModuleOutcome? = null
        val handled = JSERunner.moduleHandle("scene3d://show", mapOf("src" to "m.usdz")) { outcome = it }
        assertTrue(handled)                                 // settled, not the generic `unavailable`
        val err = outcome as JSEModuleOutcome.Error
        assertEquals("unsupported_platform", err.code)
        assertEquals(scene3dData, err.data)
    }

    @Test fun markupBindingKeepsUnavailableForExcludedAndUnknown() {
        ModuleRegistry.shared.platformSupport = mapOf("pst.both2" to listOf("ios", "android"))
        DSXModuleCallMount.bindRegistry()
        var settled = false
        // Supported here but excluded by the app → false (the runner's unavailable path).
        assertFalse(JSERunner.moduleHandle("pst.both2://x", emptyMap()) { settled = true })
        // Unknown scheme → false, same as today.
        assertFalse(JSERunner.moduleHandle("pst.never2://x", emptyMap()) { settled = true })
        assertFalse(settled)
    }
}
