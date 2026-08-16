package despia.engine.desktop

import despia.engine.JSE
import despia.engine.JSEModuleOutcome
import despia.engine.JSERunner
import despia.engine.DSXMessenger
import despia.engine.DSXMessengerMount
import despia.engine.Module
import despia.engine.ModuleCallError
import despia.engine.ModuleRegistry
import despia.engine.Platform
import despia.engine.PlatformAttrs
import despia.engine.StackStore
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.api.parallel.ResourceLock
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The desktop bootloader seed's contract (desktop-platforms.md): the host names the
 * deploy target once, and the WHOLE kernel answers for it — identity words, derived
 * constants, and the suffix fold — because :core is the same bytes the corpora pin.
 */
@ResourceLock("despia-engine-runtime-executors")
class DesktopHostTest {

    @TempDir
    lateinit var temporary: Path

    @AfterEach
    fun restore() {
        Platform.os = "android"
    }

    @Test
    fun detectOsMapsTheJvmNames() {
        assertEquals("windows", DesktopHost.detectOs("Windows 11"))
        assertEquals("linux", DesktopHost.detectOs("Linux"))
        assertEquals("macos", DesktopHost.detectOs("Mac OS X"))
        assertEquals(null, DesktopHost.detectOs("FreeBSD"))
    }

    @Test
    fun bootStampsIdentityAndTheKernelAnswers() {
        DesktopHost.boot("Windows 11")
        val store = StackStore()
        assertEquals("windows", JSE.eval("os", store, null))
        assertEquals(true, JSE.eval("platform.desktop", store, null))
        assertEquals(true, JSE.eval("platform.native", store, null))
    }

    private class BootBindingProbe : Module() {
        override val scheme get() = "desktop.host.binding-probe"

        override fun setup() {
            dsx.action("echo") { call ->
                call.resolve(mapOf("echo" to call.args("value")))
            }
        }
    }

    @Test
    fun bootBindsSurfaceMarkupAndAvailabilityToTheLiveRegistry() {
        val previousSurfaceDispatch = DSXMessengerMount.dispatch
        val previousMarkupDispatch = JSERunner.moduleHandle
        val previousAvailability = JSE.moduleAvailable
        DesktopHost.boot("Linux")
        val installedSurfaceDispatch = DSXMessengerMount.dispatch
        val installedMarkupDispatch = JSERunner.moduleHandle
        val installedAvailability = JSE.moduleAvailable
        var surface: despia.engine.DSXMessengerMount? = null
        try {
            ModuleRegistry.shared.register { BootBindingProbe() }
            assertTrue(JSE.moduleAvailable("desktop.host.binding-probe"))
            assertEquals(
                true,
                JSE.eval("has('desktop.host.binding-probe')", StackStore(), null),
            )

            val surfaceReply = ArrayList<despia.engine.DSXEgress>()
            val surfaceDone = CountDownLatch(1)
            surface = DSXMessenger().mount("desktop-host-binding-surface") { egress ->
                surfaceReply += egress
                surfaceDone.countDown()
            }
            surface.receive(
                scheme = "desktop.host.binding-probe",
                action = "echo",
                args = mapOf("value" to "surface"),
                rid = "surface-rid",
            )
            assertTrue(surfaceDone.await(5, TimeUnit.SECONDS))
            assertEquals("desktop-host-binding-surface", surfaceReply.single().target)
            assertEquals("surface-rid", surfaceReply.single().rid)
            assertEquals(mapOf("echo" to "surface"), surfaceReply.single().payload["data"])

            var markupOutcome: JSEModuleOutcome? = null
            val markupDone = CountDownLatch(1)
            assertTrue(JSERunner.moduleHandle(
                "desktop.host.binding-probe://echo",
                mapOf("value" to "markup"),
            ) { outcome ->
                markupOutcome = outcome
                markupDone.countDown()
            })
            assertTrue(markupDone.await(5, TimeUnit.SECONDS))
            val resolved = markupOutcome as JSEModuleOutcome.Resolve
            assertEquals(mapOf("echo" to "markup"), resolved.value)
        } finally {
            surface?.unmount()
            // Tests restore only seams still owned by this boot. A deliberate newer
            // embedding owner is never overwritten during cleanup.
            if (DSXMessengerMount.dispatch === installedSurfaceDispatch) {
                DSXMessengerMount.dispatch = previousSurfaceDispatch
            }
            if (JSERunner.moduleHandle === installedMarkupDispatch) {
                JSERunner.moduleHandle = previousMarkupDispatch
            }
            if (JSE.moduleAvailable === installedAvailability) {
                JSE.moduleAvailable = previousAvailability
            }
        }
    }

    @Test
    fun theSuffixFoldPicksTheDesktopWinners() {
        DesktopHost.boot("Linux")
        val resolved = PlatformAttrs.resolve(
            mapOf("padding" to "16", "padding:native" to "12", "padding:desktop" to "8", "padding:windows" to "6"),
            Platform.os,
        )
        assertEquals(mapOf("padding" to "8"), resolved)   // linux: :desktop wins, :windows drops
    }

    @Test
    fun unknownOperatingSystemsFailClosed() {
        assertFailsWith<UnsupportedOperationException> { DesktopHost.boot("FreeBSD 15") }
        assertEquals("android", Platform.os)
    }

    @Test
    fun generatedCatalogLoadsOnlyAllowlistedDesktopFacetsAndKeepsUnsupportedFailuresStructured() = runBlocking {
        DesktopHost.boot("Linux")
        assertEquals(listOf("ios"), ModuleRegistry.shared.unsupportedPlatforms("scene3d"))
        val failure = assertFailsWith<ModuleCallError.ActionFailed> {
            Module().dsx.module["scene3d"]["show"]()
        }
        assertEquals("unsupported_platform", failure.code)
        assertEquals(
            mapOf<String, Any?>(
                "scheme" to "scene3d",
                "platform" to "linux",
                "supportedPlatforms" to listOf("ios"),
            ),
            failure.data,
        )
        val linuxKeys = DesktopPackageCatalog.implementations
            .filter { "linux" in it.targets }
            .map { it.key }
            .toSet()
        assertTrue("global" in linuxKeys)
        assertTrue("multiapicall" in linuxKeys)
        assertTrue("linux" in DesktopPackageCatalog.byScheme.getValue("global"))
        assertTrue("linux" in DesktopPackageCatalog.byScheme.getValue("multiapicall"))
        assertTrue(ModuleRegistry.shared.isAvailable("global"))
        assertTrue(ModuleRegistry.shared.isAvailable("multiapicall"))
    }

    @Test
    fun entryLoaderIsBoundedExtensionCheckedAndDoesNotFollowFinalSymlinks() {
        val entry = temporary.resolve("Home.dsx")
        Files.writeString(entry, "<text value=\"native\"/>")
        assertEquals("<text value=\"native\"/>", DesktopHost.loadEntry(entry).markup)

        val wrong = temporary.resolve("Home.xml")
        Files.writeString(wrong, "<text/>")
        assertFailsWith<IllegalArgumentException> { DesktopHost.loadEntry(wrong) }

        val link = temporary.resolve("Alias.dsx")
        Files.createSymbolicLink(link, entry.fileName)
        assertFailsWith<IllegalArgumentException> { DesktopHost.loadEntry(link) }
    }

    @Test
    fun selfTestWritesTheInstalledRuntimeContractAtomically() {
        val output = temporary.resolve("self-test.json")
        assertEquals(0, DesktopHost.selfTest(osName = "Linux", output = output))
        val json = Files.readString(output).trim()
        assertEquals(
            "{\"schema\":\"dev.dsx.desktop-self-test/v1\",\"status\":\"ok\",\"os\":\"linux\",\"desktop\":true,\"native\":true,\"renderer\":\"compose\"}",
            json,
        )
        assertTrue(Files.isRegularFile(output))
    }

    @Test
    fun selfTestOutputCannotBeSelectedWithoutTheSelfTestMode() {
        assertFailsWith<IllegalArgumentException> {
            DesktopHost.parseOptions(arrayOf("--dsx-self-test-output", temporary.resolve("x.json").toString()), emptyMap())
        }
    }

    @Test
    fun appIdentityAndAssetRootOptionsAreValidatedAndParsed() {
        val options = DesktopHost.parseOptions(
            arrayOf("--app-id", "com.example.major-app", "--assets-root", temporary.toString()),
            emptyMap(),
            emptyMap(),
        )
        assertEquals("com.example.major-app", options.appId)
        assertEquals(temporary, options.assetsRoot)
        assertFailsWith<IllegalArgumentException> {
            DesktopHost.parseOptions(arrayOf("--app-id", "bad app id"), emptyMap(), emptyMap())
        }
        assertEquals(DesktopAppIdentity.namespaceFor("com.example.major-app"), DesktopAppIdentity.namespaceFor("COM.EXAMPLE.MAJOR-APP"))
        assertTrue(DesktopAppIdentity.namespaceFor("com.example.major-app") != DesktopAppIdentity.namespaceFor("com.example.other-app"))
    }

    @Test
    fun packagedApplicationIdentityAndEntryAreBuildOwnedDefaults() {
        val options = DesktopHost.parseOptions(
            emptyArray(),
            emptyMap(),
            mapOf(
                "dsx.app.id" to "com.example.shipped-app",
                "dsx.app.title" to "Example App",
                "dsx.app.entry.resource" to DesktopHost.APP_ENTRY_RESOURCE,
            ),
        )
        assertEquals("com.example.shipped-app", options.appId)
        assertEquals("Example App", options.title)
        assertEquals(DesktopHost.APP_ENTRY_RESOURCE, options.entryResource)

        assertFailsWith<IllegalArgumentException> {
            DesktopHost.parseOptions(
                arrayOf("--entry-resource", "/arbitrary/resource.dsx"),
                emptyMap(),
                emptyMap(),
            )
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopHost.parseOptions(emptyArray(), mapOf("DSX_APP_TITLE" to "bad\nwindow"), emptyMap())
        }
    }

    @Test
    fun lockedPackagedIdentityEntryAndAssetsCannotBeReplacedAtRuntime() {
        val properties = mapOf(
            "dsx.app.id" to "com.example.shipped-app",
            "dsx.app.title" to "Example App",
            "dsx.app.entry.resource" to DesktopHost.APP_ENTRY_RESOURCE,
            "dsx.app.identity.locked" to "true",
        )
        val options = DesktopHost.parseOptions(emptyArray(), emptyMap(), properties)
        assertEquals("com.example.shipped-app", options.appId)
        assertEquals("Example App", options.title)
        assertEquals(DesktopHost.APP_ENTRY_RESOURCE, options.entryResource)
        assertTrue(options.identityLocked)

        listOf(
            arrayOf("--entry", temporary.resolve("Other.dsx").toString()),
            arrayOf("--entry-resource", "/dsx/DesktopWelcome.dsx"),
            arrayOf("--title", "Impostor"),
            arrayOf("--app-id", "com.example.impostor"),
            arrayOf("--assets-root", temporary.toString()),
        ).forEach { args ->
            assertFailsWith<IllegalArgumentException>(args.contentToString()) {
                DesktopHost.parseOptions(args, emptyMap(), properties)
            }
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopHost.parseOptions(emptyArray(), mapOf("DSX_ENTRY" to "Other.dsx"), properties)
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopHost.parseOptions(emptyArray(), mapOf("DSX_ASSETS_ROOT" to temporary.toString()), properties)
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopHost.parseOptions(emptyArray(), emptyMap(), properties + ("dsx.assets.root" to temporary.toString()))
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopHost.parseOptions(emptyArray(), mapOf("DSX_APP_TITLE" to "Impostor"), properties)
        }
    }

    @Test
    fun entryTextMustBeStrictUtf8AndDesktopAstAdmissionIsBounded() {
        val invalid = temporary.resolve("Invalid.dsx")
        Files.write(invalid, byteArrayOf(0x3c, 0x74, 0x80.toByte(), 0x3e))
        assertFailsWith<java.nio.charset.CharacterCodingException> { DesktopHost.loadEntry(invalid) }

        assertNotNull(DesktopHost.parseDocument(DesktopHost.Document("valid", "<vstack><text/></vstack>")))
        val tooDeep = "<vstack>".repeat(DesktopHost.DOCUMENT_LIMITS.maximumDepth + 1) +
            "</vstack>".repeat(DesktopHost.DOCUMENT_LIMITS.maximumDepth + 1)
        assertNull(DesktopHost.parseDocument(DesktopHost.Document("too-deep", tooDeep)))
        val tooMany = buildString {
            append("<vstack>")
            repeat(DesktopHost.DOCUMENT_LIMITS.maximumNodes) { append("<text/>") }
            append("</vstack>")
        }
        assertNull(DesktopHost.parseDocument(DesktopHost.Document("too-many", tooMany)))
    }

    @Test
    fun packagedIdentityIsExactEmbeddedAndCannotBeReplacedByJvmInjection() {
        val identityText = """
            dsx.identity.schema=${DesktopHost.APP_IDENTITY_SCHEMA}
            dsx.app.id=com.example.shipped-app
            dsx.app.title=Example App
            dsx.app.version=255.255.65535
            dsx.app.build=qa-42
            dsx.app.identity.locked=true
            dsx.app.entry.resource=${DesktopHost.APP_ENTRY_RESOURCE}
            dsx.app.assets.prefix=${DesktopHost.APP_ASSETS_PREFIX}
        """.trimIndent() + "\n"
        val identity = DesktopHost.parsePackagedIdentity(identityText)
        assertEquals("com.example.shipped-app", identity["dsx.app.id"])
        assertEquals(DesktopHost.APP_ENTRY_RESOURCE, identity["dsx.app.entry.resource"])

        val merged = DesktopHost.runtimeProperties(
            systemProperties = mapOf("dsx.app.id" to "com.example.shipped-app"),
            packagedIdentity = identity,
        )
        assertEquals("true", merged["dsx.app.identity.locked"])
        assertFailsWith<IllegalArgumentException> {
            DesktopHost.runtimeProperties(
                systemProperties = mapOf("dsx.app.identity.locked" to "false"),
                packagedIdentity = identity,
            )
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopHost.runtimeProperties(
                systemProperties = mapOf("dsx.app.id" to "com.example.injected"),
                packagedIdentity = identity,
            )
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopHost.parsePackagedIdentity(identityText + "dsx.app.id=com.example.duplicate\n")
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopHost.parsePackagedIdentity(identityText.replace("255.255.65535", "256.0.0"))
        }

        val generated = assertNotNull(DesktopHost.loadPackagedIdentity())
        assertEquals(DesktopHost.APP_IDENTITY_SCHEMA, generated["dsx.identity.schema"])
        assertEquals("true", generated["dsx.app.identity.locked"])
    }

    @Test
    fun componentExpansionIsCycleDepthAndSizeBoundedBeforeCompose() {
        val recursive = """
            <vstack>
              <component as="Loop"><Loop/></component>
              <Loop/>
            </vstack>
        """.trimIndent()
        assertNull(DesktopHost.parseDocument(DesktopHost.Document("recursive-component", recursive)))

        val duplicateSlot = """
            <vstack>
              <component as="Twice"><vstack><slot/><slot/></vstack></component>
              <Twice><text value="one"/></Twice>
            </vstack>
        """.trimIndent()
        // Mirrored/repeated outlets are valid DSX; the expansion walker accounts
        // for every copy and rejects only when the finite global bounds are crossed.
        assertNotNull(DesktopHost.parseDocument(DesktopHost.Document("duplicate-slot", duplicateSlot)))

        var mirroredContent = "<text value=\"leaf\"/>"
        repeat(16) { mirroredContent = "<Mirror>$mirroredContent</Mirror>" }
        val mirroredExplosion = """
            <vstack>
              <component as="Mirror"><vstack><slot/><slot/></vstack></component>
              $mirroredContent
            </vstack>
        """.trimIndent()
        assertNull(DesktopHost.parseDocument(DesktopHost.Document("mirrored-slot-explosion", mirroredExplosion)))

        val validNamedSlots = """
            <vstack>
              <component as="Card"><vstack><slot name="header"/><slot/></vstack></component>
              <Card><text slot="header" value="Title"/><text value="Body"/></Card>
            </vstack>
        """.trimIndent()
        assertNotNull(DesktopHost.parseDocument(DesktopHost.Document("named-slots", validNamedSlots)))

        val namedStyleSelectedDynamicComponent = """
            <vstack>
              <component as="Card"><text value="Card"/></component>
              <style as="componentSelector" tag="Card"/>
              <dynamic style="componentSelector"/>
            </vstack>
        """.trimIndent()
        assertNull(
            DesktopHost.parseDocument(
                DesktopHost.Document("named-style-selected-dynamic-component", namedStyleSelectedDynamicComponent),
            ),
        )

        val classSelectedDynamicComponent = """
            <vstack>
              <component as="Card"><text value="Card"/></component>
              <style as="componentSelector" tag="Card"/>
              <dynamic class="componentSelector"/>
            </vstack>
        """.trimIndent()
        assertNull(
            DesktopHost.parseDocument(
                DesktopHost.Document("class-selected-dynamic-component", classSelectedDynamicComponent),
            ),
        )

        val interpolatedNamedStyleSelectedDynamicComponent = """
            <vstack>
              <component as="Card"><text value="Card"/></component>
              <style as="componentSelector" tag="Card"/>
              <dynamic style="{{true ? 'componentSelector' : 'padding: 8px'}}"/>
            </vstack>
        """.trimIndent()
        assertNull(
            DesktopHost.parseDocument(
                DesktopHost.Document(
                    "interpolated-named-style-selected-dynamic-component",
                    interpolatedNamedStyleSelectedDynamicComponent,
                ),
            ),
        )

        var namedSlotContent = "<text slot=\"header\" value=\"leaf\"/>"
        repeat(16) { namedSlotContent = "<Mirror slot=\"header\">$namedSlotContent</Mirror>" }
        val interpolatedNamedStyleSelectedSlotExplosion = """
            <vstack>
              <style as="headerSelector" name="header"/>
              <component as="Mirror">
                <vstack>
                  <slot style="{{true ? 'headerSelector' : 'padding: 8px'}}"/>
                  <slot style="{{true ? 'headerSelector' : 'padding: 8px'}}"/>
                </vstack>
              </component>
              $namedSlotContent
            </vstack>
        """.trimIndent()
        assertNull(
            DesktopHost.parseDocument(
                DesktopHost.Document(
                    "interpolated-named-style-selected-slot-explosion",
                    interpolatedNamedStyleSelectedSlotExplosion,
                ),
            ),
        )

        val inlineCssCannotSelectAComponent = """
            <vstack>
              <component as="Card"><text value="Card"/></component>
              <dynamic style="padding: 8px" css-owner="Card"><text value="ordinary child"/></dynamic>
            </vstack>
        """.trimIndent()
        assertNotNull(
            DesktopHost.parseDocument(
                DesktopHost.Document("inline-css-dynamic-node", inlineCssCannotSelectAComponent),
            ),
        )

        val exponential = buildString {
            append("<vstack><component as=\"C0\"><text/></component>")
            for (index in 1..16) {
                append("<component as=\"C$index\"><vstack><C${index - 1}/><C${index - 1}/></vstack></component>")
            }
            append("<C16/></vstack>")
        }
        assertNull(DesktopHost.parseDocument(DesktopHost.Document("exponential-component", exponential)))
    }

    @Test
    fun portableDesktopTitlesRejectWindowsDeviceNames() {
        listOf("CON", "nul.txt", "Title.").forEach { title ->
            assertFailsWith<IllegalArgumentException>(title) {
                DesktopHost.parseOptions(arrayOf("--title", title), emptyMap(), emptyMap())
            }
        }
    }
}
