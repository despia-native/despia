//
//  ParityCaptureInstrumentedTest.kt — the ANDROID CAPTURE LANE of the parity contract
//  (OpenSource/Conformance/parity/README.md, "The native capture planes"). Renders the
//  parity specimen set — the same fixtures the web reference plane records, listed from
//  the build-copied assets, never a hand list — through the REAL renderer (StackXML →
//  StackRootView) at both locked planes (390x844 and 1366x1024 CSS px @2x) in both
//  schemes, and writes per-fixture-per-width metrics JSON in the web plane's node shape
//  (path / id / box / radius / light / dark / text) into the app's external files dir
//  (parity-native/), where the lane's driver (ClosedSource/scripts/
//  android_parity_capture.sh) pulls them off the emulator for the host-side diff
//  (ClosedSource/scripts/parity_native_diff.rb) against reference/web/.
//
//  This test asserts HARNESS sanity only (fixtures found, parse, render, capture
//  non-empty): budget comparisons live in the host-side diff
//  (ClosedSource/scripts/parity_native_diff.rb), staged per the README — report first,
//  enforcing when DSX_PARITY_NATIVE_ENFORCE=1. Scheme-law drift (dark moved a box) is
//  recorded into the capture's schemeLaw list for the diff to surface, not asserted
//  here, so an unproven budget can never flake the release lane.
//

package despia.engine.render

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.WindowInfo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import despia.engine.JSERunner
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.StackXML
import java.io.File
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ParityCaptureInstrumentedTest {

    private data class Plane(val key: String, val width: Int, val height: Int)

    private val planes = listOf(Plane("w390", 390, 844), Plane("w1366", 1366, 1024))
    private val fixturesAssetDir = "despia/parity/fixtures"

    private class Pass(
        val nodes: List<ParityCapture.Measured>,
    )

    @Test
    fun captureParitySpecimens() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val assets = instrumentation.context.assets
        val fixtures = (assets.list(fixturesAssetDir) ?: emptyArray())
            .filter { it.endsWith(".dsx") }.sorted()
        assertTrue("no parity fixtures in test assets — copyParityFixtures did not run", fixtures.isNotEmpty())

        val outDir = File(instrumentation.targetContext.getExternalFilesDir(null), "parity-native")
        outDir.deleteRecursively()
        assertTrue(outDir.mkdirs())

        for (file in fixtures) {
            val fixture = file.removeSuffix(".dsx")
            val source = assets.open("$fixturesAssetDir/$file").bufferedReader().use { it.readText() }
            for (plane in planes) {
                val light = renderPass(source, fixture, plane, dark = false)
                val dark = renderPass(source, fixture, plane, dark = true)
                val schemeLaw = schemeLawBreaches(light, dark)
                val json = emitJson(fixture, plane, light, dark, schemeLaw)
                File(outDir, "$fixture.${plane.key}.json").writeText(json)
                assertTrue("$fixture@${plane.key}: capture recorded no nodes", light.nodes.isNotEmpty())
            }
        }
    }

    /** One settled rest render of a fixture at one plane in one scheme, through the real
     * StackRootView path, captured via the ParityCapture seam. A fresh activity per pass
     * keeps overlay windows (sheet Dialogs) from leaking between passes. */
    private fun renderPass(source: String, fixture: String, plane: Plane, dark: Boolean): Pass {
        val root = StackXML.parse(source)
            ?: throw AssertionError("$fixture: fixture did not parse")
        val session = ParityCapture.Session(root)
        val origin = AtomicReference(Offset.Zero)
        ParityCapture.session = session
        try {
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.enableEdgeToEdge()
                    activity.setContent {
                        val base = LocalConfiguration.current
                        val themed = Configuration(base).apply {
                            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                                (if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
                            screenWidthDp = plane.width
                            screenHeightDp = plane.height
                        }
                        val windowInfo = object : WindowInfo {
                            override val isWindowFocused: Boolean get() = true
                            override val containerSize: IntSize get() = IntSize(plane.width * 2, plane.height * 2)
                        }
                        CompositionLocalProvider(
                            LocalConfiguration provides themed,
                            LocalDensity provides Density(2f, 1f),
                            LocalWindowInfo provides windowInfo,
                        ) {
                            Box(
                                Modifier
                                    .wrapContentSize(Alignment.TopStart, unbounded = true)
                                    .requiredSize(plane.width.dp, plane.height.dp)
                                    .onGloballyPositioned { origin.set(it.positionInRoot()) },
                            ) {
                                val store = StackStore()
                                StackRootView(root, store, JSERunner(store))
                            }
                        }
                    }
                }
                settle(session, origin)
            }
            return Pass(session.measured(origin.get(), density = 2f))
        } finally {
            ParityCapture.session = null
        }
    }

    /** Rest-state settle: idle the main looper, then require two consecutive identical
     * capture snapshots (the emulator step already zeroes animator scales; this guards
     * late layout passes the idle sync cannot see). */
    private fun settle(session: ParityCapture.Session, origin: AtomicReference<Offset>) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        var previous = -1
        var stable = 0
        for (attempt in 0 until 100) {
            instrumentation.waitForIdleSync()
            val counted = session.measured(origin.get(), density = 2f).size
            if (counted == previous && counted > 0) {
                stable += 1
                if (stable >= 2) return
            } else {
                stable = 0
            }
            previous = counted
            Thread.sleep(100)
        }
    }

    private fun schemeLawBreaches(light: Pass, dark: Pass): List<String> {
        val out = mutableListOf<String>()
        if (light.nodes.size != dark.nodes.size) {
            out.add("scheme law: light renders ${light.nodes.size} nodes, dark ${dark.nodes.size}")
            return out
        }
        for (i in light.nodes.indices) {
            val l = light.nodes[i]
            val d = dark.nodes[i]
            if (l.path != d.path || l.tag != d.tag) {
                out.add("scheme law: index $i is ${l.path} ${l.tag} in light, ${d.path} ${d.tag} in dark")
                continue
            }
            val drift = l.box.indices.map { Math.abs(l.box[it] - d.box[it]) }
            if (drift.any { it > 0.5 }) {
                out.add("scheme law [${l.path} ${l.tag}]: dark moved the box " +
                    "[${l.box.joinToString(", ")}] -> [${d.box.joinToString(", ")}]")
            }
        }
        return out
    }

    // ── the emitter: the web plane's node shape, keys in the web order ────────────────

    private fun emitJson(
        fixture: String,
        plane: Plane,
        light: Pass,
        dark: Pass,
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
        val darkByPath = dark.nodes.associateBy { it.path }
        val sb = StringBuilder()
        sb.append("{\n")
        sb.append(" \"_note\": \"GENERATED by ParityCaptureInstrumentedTest (Engine/Android :render) - the Android capture plane of the parity contract (Conformance/parity/README.md, native capture planes). Boxes are CSS px (dp) in plane coordinates at ${plane.width}x${plane.height}@2x; id is the authored DSX tag; the diff script owns the tag-to-web-host mapping.\",\n")
        sb.append(" \"fixture\": \"${esc(fixture)}\",\n")
        sb.append(" \"renderer\": \"android\",\n")
        sb.append(" \"engine\": \"compose\",\n")
        sb.append(" \"viewport\": {\n  \"width\": ${plane.width},\n  \"height\": ${plane.height},\n  \"deviceScaleFactor\": 2\n },\n")
        sb.append(" \"schemeLaw\": [")
        sb.append(schemeLaw.joinToString(", ") { "\"${esc(it)}\"" })
        sb.append("],\n")
        sb.append(" \"nodes\": [\n")
        light.nodes.forEachIndexed { i, n ->
            val d = darkByPath[n.path]
            sb.append("  {\n")
            sb.append("   \"path\": \"${esc(n.path)}\",\n")
            sb.append("   \"id\": \"${esc(n.tag)}\",\n")
            sb.append("   \"box\": [${n.box.joinToString(", ") { num(it) }}],\n")
            sb.append("   \"radius\": \"${esc(n.radius)}\",\n")
            sb.append("   \"light\": { \"color\": \"${ParityCapture.cssColor(n.color)}\", \"background\": \"${ParityCapture.cssColor(n.background)}\" },\n")
            val dc = d ?: n
            sb.append("   \"dark\": { \"color\": \"${ParityCapture.cssColor(dc.color)}\", \"background\": \"${ParityCapture.cssColor(dc.background)}\" },\n")
            val t = n.text
            if (t == null) {
                sb.append("   \"text\": null\n")
            } else {
                fun field(v: String?): String = if (v == null) "null" else "\"${esc(v)}\""
                sb.append("   \"text\": { \"size\": ${field(t.size)}, \"weight\": ${field(t.weight)}, \"line\": ${field(t.line)} }\n")
            }
            sb.append("  }")
            sb.append(if (i == light.nodes.size - 1) "\n" else ",\n")
        }
        sb.append(" ]\n}\n")
        return sb.toString()
    }
}
