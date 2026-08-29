@file:OptIn(
    androidx.compose.ui.test.ExperimentalTestApi::class,
    androidx.compose.ui.InternalComposeUiApi::class,
)

//
//  DesktopParityCaptureTest.kt — the DESKTOP CAPTURE LANE of the parity contract
//  (OpenSource/Conformance/parity/README.md, "The native capture planes" and "The
//  desktop capture plane"). Renders the parity specimen set — the same fixtures the web
//  reference plane records, GLOBBED from Conformance/parity/fixtures, never a hand list
//  — through the REAL desktop renderer (StackXML -> DesktopSurface, inside the shipped
//  MaterialTheme palette) at both locked planes (390x844 and 1366x1024 CSS px @2x) in
//  both schemes, and writes per-fixture-per-width metrics JSON in the web plane's node
//  shape (path / id / box / radius / light / dark / text) into
//  Conformance/parity/reference/desktop/, where the host-side diff
//  (ClosedSource/scripts/parity_native_diff.rb) compares it against reference/web/.
//
//  SCOPE: this is Compose Desktop on the JVM (Skia, offscreen). It executes the Compose
//  element layer and :core resolution. It is NOT an Android device capture and NOT an
//  iOS capture, and it can never stand in for either.
//
//  Like its Android twin this test asserts HARNESS sanity only (fixtures found, parse,
//  plane geometry, capture non-empty): budget comparisons live in the host-side diff,
//  staged report-first per the README. Scheme-law drift (dark moved a box) is recorded
//  into the capture's schemeLaw list for the diff to surface, not asserted here, so an
//  unproven budget can never flake the lane.
//

package despia.engine.desktop

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.LocalSystemTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.SystemTheme
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.test.runSkikoComposeUiTest
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntSize
import despia.engine.DSX
import despia.engine.Platform
import despia.engine.StackStore
import despia.engine.StackXML
import despia.engine.getPath
import despia.engine.screenMetrics
import despia.engine.screenState
import despia.engine.setPath
import java.io.File
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertTrue

class DesktopParityCaptureTest {

    private data class Plane(val key: String, val width: Int, val height: Int)

    private class Pass(val nodes: List<DesktopParityCapture.Measured>, val scene: IntSize)

    private val planes = listOf(Plane("w390", 390, 844), Plane("w1366", 1366, 1024))

    /** The plane is CSS px at @2x, exactly as the web oracle and the Android lane record
     * it, so one differ reads all three without a coordinate conversion. */
    private val planeDensity = 2f

    private var restoreReduceMotion: String? = null

    @BeforeEach
    fun armRestState() {
        DesktopUiTestEnvironment.assumeRenderable()
        // Rest state (README): references are captured under reduced motion, so the
        // plane pins settled geometry rather than a frame of an entrance.
        restoreReduceMotion = System.getProperty("dsx.reduceMotion")
        System.setProperty("dsx.reduceMotion", "true")
        DesktopHost.boot("Linux")
    }

    @AfterEach
    fun restoreEnvironment() {
        DesktopParityCapture.session = null
        restoreReduceMotion.let { previous ->
            if (previous == null) System.clearProperty("dsx.reduceMotion")
            else System.setProperty("dsx.reduceMotion", previous)
        }
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    @Test
    fun captureParitySpecimens() {
        val fixturesDir = File(repositoryRoot(), "OpenSource/Conformance/parity/fixtures")
        assertTrue(fixturesDir.isDirectory, "no parity fixtures directory at $fixturesDir")
        val fixtures = fixturesDir.listFiles { file -> file.isFile && file.name.endsWith(".dsx") }
            .orEmpty().sortedBy { it.name }
        assertTrue(fixtures.isNotEmpty(), "no parity fixtures in $fixturesDir")

        val outDir = File(
            System.getProperty("dsx.parity.capture.out")
                ?: File(repositoryRoot(), "OpenSource/Conformance/parity/reference/desktop").path,
        )
        outDir.mkdirs()
        val written = LinkedHashSet<String>()
        val problems = mutableListOf<String>()

        for (file in fixtures) {
            val fixture = file.name.removeSuffix(".dsx")
            val source = file.readText()
            for (plane in planes) {
                val light = renderPass(source, fixture, plane, dark = false)
                val dark = renderPass(source, fixture, plane, dark = true)
                val name = "$fixture.${plane.key}.json"
                File(outDir, name).writeText(
                    emitJson(fixture, plane, light.nodes, dark.nodes, schemeLawBreaches(light.nodes, dark.nodes)),
                )
                written += name
                if (light.nodes.isEmpty()) problems += "$fixture@${plane.key}: capture recorded no nodes"
                for (pass in listOf("light" to light, "dark" to dark)) {
                    val scene = pass.second.scene
                    val width = scene.width / planeDensity
                    val height = scene.height / planeDensity
                    if (abs(width - plane.width) > 0.5 || abs(height - plane.height) > 0.5) {
                        problems += "$fixture@${plane.key} ${pass.first}: scene measured ${width}x${height} CSS px, " +
                            "plane is ${plane.width}x${plane.height} - built at the wrong density or size"
                    }
                }
            }
        }

        // A fixture dropped from the corpus must not leave a stale capture behind: the
        // differ enforces the reference/capture pairing both ways.
        outDir.listFiles { file -> file.isFile && file.name.endsWith(".json") }.orEmpty()
            .filter { it.name !in written }
            .forEach { it.delete() }

        assertTrue(problems.isEmpty(), "desktop parity capture is not sane:\n" + problems.joinToString("\n"))
    }

    /** One settled rest render of a fixture at one plane in one scheme, through the real
     * DesktopSurface path inside the shipped palette, captured via the
     * DesktopParityCapture seam. */
    private fun renderPass(
        source: String,
        fixture: String,
        plane: Plane,
        dark: Boolean,
    ): Pass {
        val root = StackXML.parse(source) ?: throw AssertionError("$fixture: fixture did not parse")
        val session = DesktopParityCapture.Session(root)
        val origin = AtomicReference(Offset.Zero)
        val scene = AtomicReference(IntSize.Zero)
        // Seed the reactive screen plane the way the host publishes it, BEFORE the first
        // composition. DSX.state is process-global and the publisher writes it from an
        // effect, so an unseeded pass can settle on the previous plane's breakpoint and
        // report a different column count per scheme.
        screenMetrics(
            (plane.width * planeDensity).toInt(),
            (plane.height * planeDensity).toInt(),
            planeDensity,
        )?.let { DSX.state.setPath("screen", screenState(DSX.state.getPath("screen"), it)) }
        DesktopParityCapture.session = session
        try {
            runSkikoComposeUiTest(
                size = Size(plane.width * planeDensity, plane.height * planeDensity),
                density = Density(planeDensity),
            ) {
                setContent {
                    CompositionLocalProvider(
                        LocalSystemTheme provides if (dark) SystemTheme.Dark else SystemTheme.Light,
                    ) {
                        MaterialTheme(colors = desktopPalette(dark)) {
                            Box(
                                Modifier
                                    .fillMaxSize()
                                    .onGloballyPositioned {
                                        origin.set(it.positionInRoot())
                                        scene.set(it.size)
                                    },
                            ) { DesktopSurface(root, StackStore()) }
                        }
                    }
                }
                // Rest state: settle on two consecutive identical capture snapshots, so a
                // late layout pass cannot be mistaken for the settled frame.
                var previous = ""
                var stable = 0
                for (attempt in 0 until 60) {
                    waitForIdle()
                    val snapshot = session.measured(origin.get(), planeDensity)
                        .joinToString(";") { "${it.path}:${it.box.joinToString(",")}" }
                    stable = if (snapshot.isNotEmpty() && snapshot == previous) stable + 1 else 0
                    previous = snapshot
                    if (stable >= 3 && attempt >= 6) break
                    mainClock.advanceTimeByFrame()
                }
            }
            return Pass(session.measured(origin.get(), planeDensity), scene.get())
        } finally {
            DesktopParityCapture.session = null
        }
    }

    private fun schemeLawBreaches(
        light: List<DesktopParityCapture.Measured>,
        dark: List<DesktopParityCapture.Measured>,
    ): List<String> {
        val out = mutableListOf<String>()
        if (light.size != dark.size) {
            out.add("scheme law: light renders ${light.size} nodes, dark ${dark.size}")
            return out
        }
        for (i in light.indices) {
            val l = light[i]
            val d = dark[i]
            if (l.path != d.path || l.tag != d.tag) {
                out.add("scheme law: index $i is ${l.path} ${l.tag} in light, ${d.path} ${d.tag} in dark")
                continue
            }
            if (l.box.indices.any { abs(l.box[it] - d.box[it]) > 0.5 }) {
                out.add(
                    "scheme law [${l.path} ${l.tag}]: dark moved the box " +
                        "[${l.box.joinToString(", ")}] -> [${d.box.joinToString(", ")}]",
                )
            }
        }
        return out
    }

    /** The repository root, so the harness reads the ONE fixture corpus rather than a
     * copy. Gradle pins it; a bare IDE run walks up from the working directory. */
    private fun repositoryRoot(): File {
        System.getProperty("dsx.repo.root")?.let { return File(it) }
        var cursor: File? = File(System.getProperty("user.dir")).absoluteFile
        while (cursor != null) {
            if (File(cursor, "OpenSource/Conformance/parity/fixtures").isDirectory) return cursor
            cursor = cursor.parentFile
        }
        throw AssertionError("could not locate the repository root from ${System.getProperty("user.dir")}")
    }

    // ── the emitter: the web plane's node shape, keys in the web order ────────────────

    private fun emitJson(
        fixture: String,
        plane: Plane,
        light: List<DesktopParityCapture.Measured>,
        dark: List<DesktopParityCapture.Measured>,
        schemeLaw: List<String>,
    ): String {
        fun esc(s: String): String = buildString {
            for (c in s) when (c) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                else -> if (c.code < 0x20) append("\\u%04x".format(c.code)) else append(c)
            }
        }
        fun num(v: Double): String =
            if (v == Math.floor(v) && !v.isInfinite()) v.toLong().toString() else v.toString()
        val darkByPath = dark.associateBy { it.path }
        val sb = StringBuilder()
        sb.append("{\n")
        sb.append(
            " \"_note\": \"GENERATED by DesktopParityCaptureTest (Engine/Android :desktop) - the " +
                "COMPOSE DESKTOP capture plane of the parity contract (Conformance/parity/README.md, " +
                "the desktop capture plane). JVM/Skia offscreen, NOT an Android device and NOT iOS. " +
                "Boxes are CSS px in plane coordinates at ${plane.width}x${plane.height}@2x; id is the " +
                "authored DSX tag; the diff script owns the tag-to-web-host mapping.\",\n",
        )
        sb.append(" \"fixture\": \"${esc(fixture)}\",\n")
        sb.append(" \"renderer\": \"desktop\",\n")
        sb.append(" \"engine\": \"compose-desktop\",\n")
        sb.append(" \"viewport\": {\n  \"width\": ${plane.width},\n  \"height\": ${plane.height},\n  \"deviceScaleFactor\": 2\n },\n")
        sb.append(" \"schemeLaw\": [")
        sb.append(schemeLaw.joinToString(", ") { "\"${esc(it)}\"" })
        sb.append("],\n")
        sb.append(" \"nodes\": [\n")
        light.forEachIndexed { i, n ->
            val d = darkByPath[n.path] ?: n
            sb.append("  {\n")
            sb.append("   \"path\": \"${esc(n.path)}\",\n")
            sb.append("   \"id\": \"${esc(n.tag)}\",\n")
            sb.append("   \"box\": [${n.box.joinToString(", ") { num(it) }}],\n")
            sb.append("   \"radius\": \"${esc(n.radius)}\",\n")
            sb.append("   \"light\": { \"color\": \"${DesktopParityCapture.cssColor(n.color)}\", \"background\": \"${DesktopParityCapture.cssColor(n.background)}\" },\n")
            sb.append("   \"dark\": { \"color\": \"${DesktopParityCapture.cssColor(d.color)}\", \"background\": \"${DesktopParityCapture.cssColor(d.background)}\" },\n")
            val t = n.text
            if (t == null) {
                sb.append("   \"text\": null\n")
            } else {
                fun field(v: String?): String = if (v == null) "null" else "\"${esc(v)}\""
                sb.append("   \"text\": { \"size\": ${field(t.size)}, \"weight\": ${field(t.weight)}, \"line\": ${field(t.line)} }\n")
            }
            sb.append("  }")
            sb.append(if (i == light.size - 1) "\n" else ",\n")
        }
        sb.append(" ]\n}\n")
        return sb.toString()
    }
}
