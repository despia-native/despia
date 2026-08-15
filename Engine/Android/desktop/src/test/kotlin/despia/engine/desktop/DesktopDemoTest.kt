package despia.engine.desktop

import despia.engine.Platform
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class DesktopDemoTest {
    @TempDir
    lateinit var temporary: Path

    @AfterEach
    fun restorePlatform() {
        Platform.os = "android"
    }

    private fun markup(): String = checkNotNull(javaClass.getResourceAsStream("/DesktopDemo.dsx")) {
        "DesktopDemo.dsx was not added to the test resources"
    }.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }

    @Test
    fun exactQaFixturePassesTheNativeWindowsLinuxIntersectionContract() {
        DesktopHost.boot("Linux")
        val root = DesktopDemoContract.validate(DesktopHost.Document("DesktopDemo.dsx", markup()))
        assertEquals("stack", root.tag)
        assertEquals("qa-root", root.attrs["id"])
        assertTrue(markup().contains("dsx.screen.breakpoint"))
        assertTrue(markup().contains("shortcut=\"primary+k\""))
        assertTrue(!markup().contains("WebView"))
    }

    @Test
    fun contractRejectsAWebOnlyOrUnreviewedElement() {
        DesktopHost.boot("Windows 11")
        val failure = assertFailsWith<IllegalArgumentException> {
            DesktopDemoContract.validate(
                DesktopHost.Document("bad", "<stack><WebView src=\"https://example.com\"/></stack>"),
            )
        }
        assertTrue(failure.message.orEmpty().contains("outside the Windows/Linux native intersection"))
    }

    @Test
    fun displayFreeDemoSelfTestUsesTheExactSourceEntry() {
        val entry = temporary.resolve("DesktopDemo.dsx")
        Files.writeString(entry, markup(), StandardCharsets.UTF_8)
        val bytes = ByteArrayOutputStream()
        val result = DesktopDemoHost.selfTest(entry, "Linux", PrintStream(bytes, true, StandardCharsets.UTF_8))
        assertEquals(0, result)
        assertEquals(
            "DSX_DESKTOP_DEMO_SELF_TEST {\"schema\":\"dev.dsx.desktop-demo/v1\",\"status\":\"ok\",\"os\":\"linux\",\"native\":true,\"renderer\":\"compose\"}",
            bytes.toString(StandardCharsets.UTF_8).trim(),
        )
    }

    @Test
    fun uiSmokeProbeIsBoundedMachineReadableAndExcludesUnrelatedState() {
        val line = DesktopUiSmokeProbe.snapshot(
            local = mapOf(
                "name" to "QA \"operator\"\n",
                "notifications" to false,
                "volume" to 43.0,
                "density" to "Comfortable",
                "count" to 1,
                "status" to "Native action 1 completed",
                "hovered" to true,
                "secret" to "must-not-leak",
            ),
            screen = mapOf(
                "width" to 1024.0,
                "height" to 720.0,
                "sizeClass" to "regular",
                "orientation" to "landscape",
                "breakpoint" to "xl",
            ),
            index = 7,
        )
        assertTrue(line.startsWith(DesktopUiSmokeProbe.PREFIX + "{"))
        assertTrue(line.contains("\"sequence\":7"))
        assertTrue(line.contains("\"name\":\"QA \\\"operator\\\"\\n\""))
        assertTrue(line.contains("\"count\":1"))
        assertTrue(line.contains("\"breakpoint\":\"xl\""))
        assertTrue(!line.contains("must-not-leak"))
    }
}
