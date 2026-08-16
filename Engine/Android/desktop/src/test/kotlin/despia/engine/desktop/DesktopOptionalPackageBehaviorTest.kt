package despia.engine.desktop

import despia.engine.Bridge
import despia.engine.GeneratedModuleSchemes
import despia.engine.Module
import despia.engine.ModuleCallError
import despia.engine.ModuleRegistry
import despia.modules.clipboard.DesktopClipboardBridge
import despia.modules.deviceuuid.DesktopDeviceUUID
import despia.modules.externalapps.DesktopExternalApps
import despia.modules.externalapps.desktopExternalAllowedSchemes
import despia.modules.externalapps.desktopExternalSchemeAllowed
import despia.modules.externalapps.desktopShouldHandoffExternalWebUri
import despia.modules.metadata.DesktopMetadata
import despia.modules.valuestore.DesktopValueStore
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.api.parallel.ResourceLock
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** Native behavior evidence for every opt-in package owner advertised as portable
 * by the generated Windows/Linux catalog. These classes compile only in the test
 * source set and therefore cannot widen the production-minimal runtime. */
@ResourceLock("dsx-desktop-persistence")
class DesktopOptionalPackageBehaviorTest {
    @Test
    fun everyAdvertisedOptInOwnerExecutesItsPortableContract(@TempDir temporaryDirectory: Path) {
        DesktopHost.boot("Linux")
        val previousAliases = GeneratedModuleSchemes.aliasesByClassName
        val previousAppId = System.getProperty("dsx.app.id")
        val previousVersion = System.getProperty("dsx.app.version")
        val previousBuild = System.getProperty("dsx.app.build")
        val appId = "dev.dsx.qualification.${UUID.randomUUID()}"
        try {
            DesktopAppIdentity.configure(appId)
            DesktopAppIdentity.setPersistenceTestOverrides(
                lockRoot = temporaryDirectory.resolve("locks"),
            )
            GeneratedModuleSchemes.aliasesByClassName = previousAliases + mapOf(
                "DesktopExternalApps" to listOf(
                    "twitter", "fb", "instagram", "youtube", "coinbase", "uber", "lyft",
                    "mailto", "tel", "sms", "maps", "message", "googlegmail", "comgooglemaps", "lpa",
                ),
                "DesktopValueStore" to listOf("readvalue"),
                "DesktopClipboardBridge" to listOf("getclipboard"),
                "DesktopDeviceUUID" to listOf("get-uuid"),
                "DesktopMetadata" to listOf("getappversion", "getstorelocation", "checknativepushpermissions"),
            )
            ModuleRegistry.shared.register { DesktopExternalApps() }
            ModuleRegistry.shared.register { DesktopValueStore() }
            ModuleRegistry.shared.register { DesktopClipboardBridge() }
            ModuleRegistry.shared.register { DesktopDeviceUUID() }
            ModuleRegistry.shared.register { DesktopMetadata() }

            assertEquals(mapOf("ok" to true), call("writevalue", "write", mapOf("value" to "portable")))
            assertEquals("portable", call("writevalue", "read"))
            assertEquals("portable", call("readvalue", "read"))
            val rawWriteValue = URI("writevalue:/legacy-value")
            assertFalse(caller.handle(rawWriteValue, Bridge.Params(url = rawWriteValue)))
            val rawReadValue = URI("readvalue:/")
            assertFalse(caller.handle(rawReadValue, Bridge.Params(url = rawReadValue)))

            val uuid = assertIs<Map<*, *>>(call("uuid", "value"))["uuid"] as String
            assertTrue(uuid.matches(Regex("[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}")))
            assertEquals(uuid, assertIs<Map<*, *>>(call("uuid", "value"))["uuid"])
            assertEquals(uuid, assertIs<Map<*, *>>(legacyData("get-uuid://value"))["uuid"])

            val inspection = assertIs<Map<*, *>>(call("clipboard", "inspect"))
            assertIs<Boolean>(inspection["hasText"])
            assertIs<Boolean>(inspection["hasURL"])
            assertIs<Boolean>(inspection["hasImage"])
            assertIs<String>(assertIs<Map<*, *>>(call("clipboard", "read"))["text"])
            assertEquals(
                "unknown_action",
                assertFailsWith<ModuleCallError.ActionFailed> {
                    call("getclipboard", "ignored")
                }.code,
            )
            assertEquals(
                "unknown_action",
                assertFailsWith<ModuleCallError.ActionFailed> {
                    call("getclipboard", "")
                }.code,
            )
            assertIs<Map<*, *>>(call("getclipboard", "read"))
            val missingClipboardText = assertFailsWith<ModuleCallError.ActionFailed> {
                call("clipboard", "write")
            }
            assertEquals("missing_param", missingClipboardText.code)
            assertIs<Map<*, *>>(legacyData("getclipboard:/"))

            System.setProperty("dsx.app.version", "1.2.3")
            System.setProperty("dsx.app.build", "42")
            assertEquals(
                mapOf("versionNumber" to "42", "bundleNumber" to "1.2.3"),
                call("metadata", "version"),
            )
            assertEquals(false, assertIs<Map<*, *>>(call("metadata", "pushpermission"))["enabled"])
            val country = assertIs<Map<*, *>>(call("metadata", "storelocation"))["storeLocation"] as String
            assertTrue(country.isEmpty() || country.matches(Regex("[A-Z]{2}")))
            assertEquals(
                mapOf("versionNumber" to "42", "bundleNumber" to "1.2.3"),
                legacyData("getappversion://value"),
            )
            assertEquals(
                mapOf("versionNumber" to "42", "bundleNumber" to "1.2.3"),
                call("getappversion", "ignored"),
            )

            assertTrue(desktopShouldHandoffExternalWebUri(URI("https://whatsapp.com/send")))
            assertTrue(desktopShouldHandoffExternalWebUri(URI("https://chat.whatsapp.com/invite")))
            assertTrue(desktopShouldHandoffExternalWebUri(URI("https://www.google.com/maps")))
            assertTrue(desktopShouldHandoffExternalWebUri(URI("https://www.google.com/maps/place/DSX")))
            assertFalse(desktopShouldHandoffExternalWebUri(URI("https://evilwhatsapp.com/send")))
            assertFalse(desktopShouldHandoffExternalWebUri(URI("https://whatsapp.com.evil.example/send")))
            assertFalse(desktopShouldHandoffExternalWebUri(URI("https://www.google.com/maps-evil")))
            assertFalse(desktopShouldHandoffExternalWebUri(URI("https://www.google.com/mapstuff")))
            assertFalse(desktopShouldHandoffExternalWebUri(URI("https://www.google.com/maps/embed/place")))
            assertFalse(desktopShouldHandoffExternalWebUri(URI("https://www.google.com/maps/embed")))
            assertTrue(desktopShouldHandoffExternalWebUri(URI("https://www.google.com/maps/embedding")))
            assertFalse(desktopShouldHandoffExternalWebUri(URI("file://whatsapp.com/tmp")))
            val generatedExternalSchemes = desktopExternalAllowedSchemes(
                "x",
                GeneratedModuleSchemes.aliasesByClassName.getValue("DesktopExternalApps"),
            )
            generatedExternalSchemes.forEach { scheme ->
                assertTrue(desktopExternalSchemeAllowed(scheme, generatedExternalSchemes), scheme)
            }
            assertTrue(desktopExternalSchemeAllowed("MAILTO", generatedExternalSchemes))
            assertFalse(desktopExternalSchemeAllowed("file", generatedExternalSchemes))
            assertFalse(desktopExternalSchemeAllowed("javascript", generatedExternalSchemes))
            assertFailsWith<IllegalArgumentException> {
                desktopExternalAllowedSchemes("x", listOf("mailto", "mailto"))
            }
            assertFailsWith<IllegalArgumentException> {
                desktopExternalAllowedSchemes("x", listOf("JavaScript"))
            }
        } finally {
            removeCurrentPreferenceAreas("settings", "device")
            removeAppStorage(temporaryDirectory, appId)
            DesktopAppIdentity.setPersistenceTestOverrides()
            GeneratedModuleSchemes.aliasesByClassName = previousAliases
            restoreProperty("dsx.app.id", previousAppId)
            restoreProperty("dsx.app.version", previousVersion)
            restoreProperty("dsx.app.build", previousBuild)
        }
    }

    private fun removeAppStorage(temporaryDirectory: Path, appId: String) {
        // EVERY area this app persisted, not just "settings" — the durable device UUID now has
        // its own app-scoped "device" file, and naming one area leaves the parent non-empty so
        // its delete throws. Walk bottom-up so a future area cannot reintroduce the gap.
        val root = temporaryDirectory.resolve("app-data")
        val app = root.resolve(DesktopAppIdentity.namespaceFor(appId))
        if (Files.exists(app)) {
            Files.walk(app).use { paths ->
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(Files::deleteIfExists)
            }
        }
        // Another app's data may still live here; the shared root goes only once it is empty.
        if (Files.isDirectory(root) && Files.newDirectoryStream(root).use { it.none() }) {
            Files.deleteIfExists(root)
        }
    }

    private fun removeCurrentPreferenceAreas(vararg areas: String) {
        var namespaceNode: java.util.prefs.Preferences? = null
        areas.forEach { area ->
            val node = requireNotNull(DesktopAppIdentity.preferenceNode(area))
            val parent = node.parent()
            namespaceNode = parent
            node.removeNode()
            parent.flush()
            parent.sync()
        }
        val namespace = namespaceNode ?: return
        check(namespace.childrenNames().isEmpty()) {
            "Unexpected preference areas remain under ${namespace.absolutePath()}"
        }
        val apps = namespace.parent()
        namespace.removeNode()
        apps.flush()
        apps.sync()
    }

    private fun call(
        scheme: String,
        action: String,
        args: Map<String, Any?> = emptyMap(),
    ): Any? = runBlocking { caller.module[scheme][action](args).foundationValue }

    private fun legacyData(raw: String): Any? {
        val uri = URI(raw)
        val received = CopyOnWriteArrayList<Map<String, Any?>>()
        val terminal = CountDownLatch(1)
        val surface = "desktop-opt-in-${UUID.randomUUID()}"
        val mount = caller.messenger.mount(surface) {
            received += it.payload
            terminal.countDown()
        }
        try {
            assertTrue(caller.handle(uri, Bridge.Params(url = uri, surfaceID = surface)))
            assertTrue(terminal.await(10, TimeUnit.SECONDS), "legacy action did not settle")
            val envelope = received.single()
            assertEquals("result", envelope["event"])
            return envelope["data"]
        } finally {
            mount.unmount()
        }
    }

    private fun restoreProperty(name: String, value: String?) {
        if (value == null) System.clearProperty(name) else System.setProperty(name, value)
    }

    private companion object {
        val caller = Module().dsx
    }
}
