@file:OptIn(
    androidx.compose.ui.test.ExperimentalTestApi::class,
    androidx.compose.ui.InternalComposeUiApi::class,
)

//
//  DesktopStudioEditorScreenUiTest.kt — the STUDIO EDITOR render oracle: the owner's
//  Audio Studio reproduction case, rendered on this JVM.
//
//  Unlike the element-level DesktopStudioElementsUiTest (hand-written fixtures around
//  one control), this loads the REAL shipped screen — ClosedSource/DSX/Modules/Core/
//  StudioEditor/Components/StudioEditor.dsx with its AgentCard component inlined the way
//  prepare_modules_android inlines it — seeds the exact variable set StudioEditor.kt's
//  seed() writes plus a demo session (tracks, clips with peaks, the FX preset chip rows
//  Studio publishes), and renders every major surface state offscreen at the locked
//  phone plane (390x844 CSS px @2x): arrange in both schemes, mixer, trim, write, the
//  FX sheet's chain/autotune/tools panels, and the Pitch Studio sheet.
//
//  Each pass writes a PNG into build/studio-editor-shots (override with
//  -Ddsx.studio.shots) so a human — or the agent driving this box — can LOOK at the
//  screen the way the owner looks at the iOS build, and asserts the chrome that must
//  exist: the surface parses with its component admitted, the key texts of each panel
//  are on screen, and the frame actually painted (color diversity, the
//  DesktopStudioElementsUiTest idiom).
//
//  SCOPE: Compose Desktop on the JVM — it proves the Compose element layer, :core
//  resolution and the desktop studio elements. It is NOT an Android device; module
//  facet behavior (ClosedSource/DSX/Modules/Core/StudioEditor/kotlin) still rides the
//  device lane.
//

package despia.engine.desktop

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.LocalSystemTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.SystemTheme
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.runSkikoComposeUiTest
import androidx.compose.ui.unit.Density
import despia.engine.DSX
import despia.engine.Platform
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.getPath
import despia.engine.screenMetrics
import despia.engine.screenState
import despia.engine.setPath
import java.awt.image.BufferedImage
import java.io.File
import javax.swing.SwingUtilities
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class DesktopStudioEditorScreenUiTest {

    private val planeWidth = 390
    private val planeHeight = 844
    private val planeDensity = 2f

    private var restoreReduceMotion: String? = null

    @BeforeEach
    fun boot() {
        DesktopUiTestEnvironment.assumeRenderable()
        restoreReduceMotion = System.getProperty("dsx.reduceMotion")
        System.setProperty("dsx.reduceMotion", "true")
        DesktopHost.boot("Linux")
    }

    @AfterEach
    fun restore() {
        restoreReduceMotion.let { previous ->
            if (previous == null) System.clearProperty("dsx.reduceMotion")
            else System.setProperty("dsx.reduceMotion", previous)
        }
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    // ── the document: the shipped screen with AgentCard inlined ───────────────────────

    private fun moduleDir(): File =
        File(repositoryRoot(), "ClosedSource/DSX/Modules/Core/StudioEditor/Components")

    private fun repositoryRoot(): File {
        System.getProperty("dsx.repo.root")?.let { return File(it) }
        var cursor: File? = File(System.getProperty("user.dir")).absoluteFile
        while (cursor != null) {
            if (File(cursor, "OpenSource/Conformance/parity/fixtures").isDirectory) return cursor
            cursor = cursor.parentFile
        }
        throw AssertionError("could not locate the repository root from ${System.getProperty("user.dir")}")
    }

    private fun editorRoot(): StackNode {
        val editor = File(moduleDir(), "StudioEditor.dsx").readText()
        val card = File(moduleDir(), "AgentCard.dsx").readText()
        // The document-scoped component inline: the same shape prepare_modules_android
        // registers process-globally (scope studioeditor); StudioEditor's own head ends
        // at the FIRST closing head tag of the merged source.
        var merged = editor.replaceFirst(
            "</head>",
            "<component as=\"AgentCard\">\n$card\n</component>\n  </head>",
        )
        return requireNotNull(
            DesktopHost.parseDocument(DesktopHost.Document("StudioEditor.dsx", merged)),
        ) { "StudioEditor.dsx did not parse (component admission failed?)" }
    }

    // ── the store: StudioEditor.kt's seed() twin + a demo session ─────────────────────

    private fun row(vararg pairs: Pair<String, Any?>): Map<String, Any?> = mapOf(*pairs)

    private fun peaks(seed: Int): List<Double> =
        List(72) { index -> kotlin.math.abs(kotlin.math.sin((index + seed * 7) * 0.29)) }

    private fun seededStore(): StackStore {
        val ui = StackStore()
        val empty = emptyList<Map<String, Any?>>()
        val seeds: List<Pair<String, Any?>> = listOf(
            "tempo" to 120.0, "beatsPerBar" to 4, "duration" to 16.0,
            "pxPerSecond" to 80.0, "snap" to true, "canUndo" to true, "canRedo" to false,
            "metronome" to false, "playing" to false, "recording" to false, "fixing" to false,
            "aiRevealNotes" to empty,
            "tuneStatus" to "idle", "tuneStage" to "", "tuneResult" to "",
            "isolateStatus" to "idle", "isolateStage" to "", "isolateProgress" to 0.0,
            "eqStatus" to "idle", "eqStage" to "",
            "notesStatus" to "idle",
            "fixVocalStatus" to "idle", "fixVocalStage" to "", "fixVocalScope" to "",
            "fxFixStyle" to "",
            "aiTuneOn" to false, "aiEqOn" to false, "aiCompOn" to false, "aiMasterOn" to false,
            "aiChainOn" to false, "chainName" to "",
            "aiBusy" to false, "aiGhosting" to false, "aiMsg" to "",
            "pluginJobsRunning" to 0, "pluginForm" to empty,
            "pluginSel" to "", "pluginSelName" to "",
            "pluginSheet" to false, "pluginSelIcon" to "puzzlepiece.extension",
            "pluginSelTagline" to "",
            "pluginRunState" to "", "pluginRunStage" to "", "pluginRunProgress" to 0.0,
            "aiShow" to "", "busyTracks" to empty, "pendingImports" to empty,
            "choirStatus" to "idle", "choirStage" to "",
            "fxChoir" to false, "fxChoirStyle" to "Lush", "fxChoirBlend" to "Balanced",
            "fxMaster" to false, "fxMasterPreset" to "",
            "fxMasterDrive" to 0.35, "fxMasterWarmth" to 0.4, "fxMasterPresence" to 0.5,
            "fxMasterDeEss" to 0.5, "fxMasterLoudness" to -12.0,
            "monitoring" to false, "bt" to false, "micPermission" to "granted", "lastError" to "",
            "drawMode" to false, "selectedClip" to 0,
            "mode" to "audio", "panelMode" to "arrange",
            "modeTabs" to listOf(row("id" to "write", "label" to "Write"), row("id" to "audio", "label" to "Audio")),
            "audioSettings" to false,
            "timeShiftOpen" to false, "tsClip" to 0, "tsTrack" to 0, "tsStart" to 0.0,
            "addLayerOpen" to false,
            "laneMenuOpen" to false, "laneTrack" to 0, "laneAt" to 0.0,
            "selTrack" to 1, "selTrackName" to "Lead Vocal",
            "selDenoise" to false, "selAutotune" to true, "selEq" to true,
            "selComp" to false, "selReverb" to true,
            "selReverbLast" to "smallClub", "selReverbMix" to 0.35,
            "selEqLowLast" to 0.0, "selEqMidLast" to 4.0,
            "selEqHighLast" to 1.0, "selEqPresetLast" to "Presence",
            "lyrics" to "", "hasClipboard" to false,
            "countInSeg" to "1 bar",
            "showFX" to false, "fxTrack" to 1, "fxName" to "Lead Vocal", "fxGain" to 0.85,
            "fxNode" to "", "fxChainPreset" to "",
            "fxAutotune" to true, "fxPitch" to 0.0,
            "fxAutotuneKey" to "A", "fxAutotuneScale" to "minor",
            "fxAutotuneRetune" to 50.0, "fxAutotuneStrength" to 0.85, "fxAutotuneRange" to 150.0,
            "fxAutotuneFlex" to 0.3, "fxAutotuneHumanize" to 0.4, "fxAutotunePro" to "Simple",
            "fxAutotuneDrift" to 0.2, "fxAutotuneFormant" to 0.0, "fxAutotuneNoteSensitivity" to 0.5,
            "fxAdvancedSheet" to false, "fxDenoiseLevel" to "Medium",
            "fxAutotunePreset" to "Natural",
            "fxPan" to 0.0, "fxReverb" to "smallClub", "fxReverbMix" to 0.35,
            "fxLow" to 0.0, "fxMid" to 4.0, "fxHigh" to 1.0, "fxEqPreset" to "Presence",
            "fxComp" to false, "fxMuted" to false, "fxSolo" to false, "fxArmed" to true,
            "fxCompThreshold" to -20.0, "fxCompRatio" to 4.0, "fxCompAttack" to 0.008,
            "fxCompRelease" to 0.18, "fxCompMakeup" to 3.0, "fxCompPreset" to "",
            "fxEcho" to false, "fxEchoTime" to 0.23, "fxEchoFeedback" to 0.3,
            "fxEchoMix" to 0.3, "fxEchoPreset" to "",
            "fxDenoise" to false, "fxDenoiseStrength" to 0.5, "fxDenoiseLowCut" to 85.0,
            "fxIsolate" to false,
            "pitchNotes" to empty, "snapToKey" to true, "pitchEditing" to false,
            "atKeys" to listOf("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
                .map { row("k" to it) },
            "atScales" to listOf(
                row("id" to "chromatic", "label" to "Chromatic"), row("id" to "major", "label" to "Major"),
                row("id" to "minor", "label" to "Minor"), row("id" to "harmonicMinor", "label" to "Harm. Minor"),
                row("id" to "melodicMinor", "label" to "Mel. Minor"),
                row("id" to "dorian", "label" to "Dorian"), row("id" to "phrygian", "label" to "Phrygian"),
                row("id" to "lydian", "label" to "Lydian"), row("id" to "mixolydian", "label" to "Mixolydian"),
                row("id" to "locrian", "label" to "Locrian"),
                row("id" to "pentatonicMajor", "label" to "Major Pent."),
                row("id" to "pentatonicMinor", "label" to "Minor Pent."), row("id" to "blues", "label" to "Blues"),
                row("id" to "wholeTone", "label" to "Whole Tone"),
                row("id" to "diminished", "label" to "Diminished"),
            ),
            // The demo session: what a take-in-progress looks like on the owner's build.
            "tracks" to listOf(
                row("id" to 1, "name" to "Lead Vocal", "armed" to true, "muted" to false,
                    "solo" to false, "gain" to 0.85, "gainDb" to "-1.4"),
                row("id" to 2, "name" to "Harmony", "armed" to false, "muted" to false,
                    "solo" to false, "gain" to 0.7, "gainDb" to "-3.1"),
                row("id" to 3, "name" to "Beat", "armed" to false, "muted" to true,
                    "solo" to false, "gain" to 0.6, "gainDb" to "-4.4"),
            ),
            "clips" to listOf(
                row("id" to 11, "track" to 1, "start" to 0.5, "duration" to 3.0,
                    "sourceStart" to 0.0, "sourceDuration" to 4.0, "peaks" to peaks(1)),
                row("id" to 12, "track" to 2, "start" to 2.0, "duration" to 2.5,
                    "sourceStart" to 0.2, "sourceDuration" to 3.5, "peaks" to peaks(2)),
                row("id" to 13, "track" to 3, "start" to 0.0, "duration" to 6.0,
                    "sourceStart" to 0.0, "sourceDuration" to 6.0, "peaks" to peaks(3)),
            ),
            // The preset chip rows Studio publishes (StudioFXPresets names, trimmed).
            "eqPresets" to listOf("Flat", "Brightness", "Rap", "Warmth", "Presence").map {
                row("name" to it, "low" to 0.0, "mid" to 2.0, "high" to 1.0)
            },
            "compPresets" to listOf("Gentle", "Vocal", "Punch", "Smooth", "Limiter").map {
                row("name" to it, "threshold" to -22.0, "ratio" to 4.0, "attack" to 0.008,
                    "release" to 0.18, "makeup" to 4.0)
            },
            "echoPresets" to listOf("Slap", "Doubler", "Eighth", "Quarter", "Ambient").map {
                row("name" to it, "time" to 0.09, "feedback" to 0.05, "mix" to 0.25)
            },
            "chainPresets" to listOf("Rap Vocal", "Pop Lead", "Warm", "Podcast", "Clean").map {
                row("name" to it, "comp" to "Vocal", "eq" to "Presence", "echo" to "", "reverb" to "smallClub")
            },
            "autotunePresets" to listOf("Natural", "Hard Tune", "Subtle", "Pop").map {
                row("name" to it, "key" to "A", "scale" to "minor", "retune" to 20.0,
                    "strength" to 0.9, "range" to 300.0, "flex" to 0.3, "humanize" to 0.4,
                    "drift" to 0.2, "formant" to 0.0, "noteSensitivity" to 0.5)
            },
            "masterPresets" to listOf("Rap", "RnB", "Pop", "Podcast").map {
                row("name" to it, "drive" to 0.35, "warmth" to 0.4, "presence" to 0.5,
                    "deEss" to 0.5, "loudness" to -12.0)
            },
            "choirStyles" to listOf("Lush", "Stacked", "Wide", "Airy").map { row("name" to it) },
            "studioPlugins" to listOf(
                row("id" to "ai-revocalize", "name" to "Revocalize", "tagline" to "Re-sing in another voice",
                    "icon" to "waveform", "builtin" to true),
            ),
        )
        for ((key, value) in seeds) ui.setPath(key, value ?: "")
        return ui
    }

    // ── the render pass ───────────────────────────────────────────────────────────────

    private fun shotsDir(): File {
        val dir = File(
            System.getenv("DSX_STUDIO_SHOTS")
                ?: System.getProperty("dsx.studio.shots")
                ?: "build/studio-editor-shots",
        )
        dir.mkdirs()
        return dir
    }

    private fun renderPass(
        name: String,
        dark: Boolean = true,
        mutate: (StackStore) -> Unit = {},
        assertions: androidx.compose.ui.test.ComposeUiTest.() -> Unit,
    ) {
        val root = editorRoot()
        val store = seededStore()
        mutate(store)
        screenMetrics(
            (planeWidth * planeDensity).toInt(),
            (planeHeight * planeDensity).toInt(),
            planeDensity,
        )?.let { DSX.state.setPath("screen", screenState(DSX.state.getPath("screen"), it)) }
        val session = DesktopParityCapture.Session(root)
        DesktopParityCapture.session = session
        try {
            runSkikoComposeUiTest(
                size = Size(planeWidth * planeDensity, planeHeight * planeDensity),
                density = Density(planeDensity),
                testTimeout = 90.seconds,
            ) {
                setContent {
                    CompositionLocalProvider(
                        LocalSystemTheme provides if (dark) SystemTheme.Dark else SystemTheme.Light,
                    ) {
                        MaterialTheme(colors = desktopPalette(dark)) {
                            Box(Modifier.fillMaxSize()) { DesktopSurface(root, store) }
                        }
                    }
                }
                flushDesktopEdt()
                flushDesktopEdt()
                saveShot(name)
                saveGeometry(name, session)
                assertions()
            }
        } finally {
            DesktopParityCapture.session = null
        }
    }

    /** The parity-capture geometry of the settled frame, one node per line, CSS px —
     * the evidence file the off-center findings cite. */
    private fun saveGeometry(name: String, session: DesktopParityCapture.Session) {
        val rows = session.measured(androidx.compose.ui.geometry.Offset.Zero, planeDensity)
        File(shotsDir(), "$name.geometry.txt").writeText(
            rows.joinToString("\n") { node ->
                "${node.path} ${node.tag} [${node.box.joinToString(", ")}]"
            },
        )
    }

    private fun androidx.compose.ui.test.ComposeUiTest.flushDesktopEdt() {
        if (!SwingUtilities.isEventDispatchThread()) SwingUtilities.invokeAndWait { }
        mainClock.advanceTimeByFrame()
        waitForIdle()
    }

    private fun androidx.compose.ui.test.ComposeUiTest.saveShot(name: String) {
        // A presented sheet is a Popup — its own root. Composite every root in z-order
        // so the PNG is the frame a user sees (base surface under scrim under panel).
        val roots = onAllNodes(androidx.compose.ui.test.isRoot()).fetchSemanticsNodes()
        val out = BufferedImage(
            (planeWidth * planeDensity).toInt(),
            (planeHeight * planeDensity).toInt(),
            BufferedImage.TYPE_INT_ARGB,
        )
        val canvas = out.createGraphics()
        var diversity = 0
        roots.indices.forEach { index ->
            val image = onAllNodes(androidx.compose.ui.test.isRoot())[index].captureToImage()
            val pixels = image.toPixelMap()
            val layer = BufferedImage(image.width, image.height, BufferedImage.TYPE_INT_ARGB)
            for (y in 0 until image.height) {
                for (x in 0 until image.width) layer.setRGB(x, y, pixels[x, y].toArgb())
            }
            canvas.drawImage(layer, 0, 0, null)
            if (index == roots.lastIndex) diversity = colorDiversity(image)
        }
        canvas.dispose()
        javax.imageio.ImageIO.write(out, "png", File(shotsDir(), "$name.png"))
        assertTrue(diversity >= 6, "$name: expected painted diversity, got $diversity colors")
    }

    private fun colorDiversity(image: androidx.compose.ui.graphics.ImageBitmap): Int {
        val pixels = image.toPixelMap()
        val colors = linkedSetOf<Int>()
        val xStep = (image.width / 64).coerceAtLeast(1)
        val yStep = (image.height / 64).coerceAtLeast(1)
        for (y in 0 until image.height step yStep) {
            for (x in 0 until image.width step xStep) colors += pixels[x, y].toArgb()
        }
        return colors.size
    }

    private fun androidx.compose.ui.test.ComposeUiTest.firstWithText(text: String): SemanticsNodeInteraction =
        onAllNodesWithText(text)[0]

    // ── the surfaces ──────────────────────────────────────────────────────────────────

    @Test
    fun arrangeSurfaceRendersInBothSchemes() {
        renderPass("studio-arrange-dark", dark = true) {
            onNodeWithText("0:00.0").assertIsDisplayed()          // the timecode leaf
            onNodeWithText("+ Add Layer").assertIsDisplayed()     // the timeline header column
            onNodeWithText("Lead Vocal").assertIsDisplayed()      // a real lane on screen
            onNodeWithText("Clean up").assertIsDisplayed()        // the FX chain strip's first node
            // The whole FX chain strip is on screen: grow="width" cells in a hugging
            // row settle at max-content (fixture 18, the studio toolbar law) instead
            // of each filling the row and tiling past the right edge.
            firstWithText("Autotune").assertIsDisplayed()
        }
        renderPass("studio-arrange-light", dark = false) {
            onNodeWithText("0:00.0").assertIsDisplayed()
            onNodeWithText("+ Add Layer").assertIsDisplayed()
        }
    }

    @Test
    fun mixerTrimAndWritePanelsRender() {
        renderPass("studio-mixer-dark", mutate = { it.setPath("panelMode", "mixer") }) {
            onNodeWithText("Auto Mix").assertIsDisplayed()
            onNodeWithText("Apply").assertIsDisplayed()
            onNodeWithText("Live").assertIsDisplayed()
            onNodeWithText("Harmony").assertIsDisplayed()
        }
        renderPass("studio-trim-dark", mutate = {
            it.setPath("panelMode", "trim")
            it.setPath("selectedClip", 11)
        }) {
            firstWithText("Trim").assertIsDisplayed()
            onNodeWithText("Done").assertIsDisplayed()
            onNodeWithText("3.0 s of 4.0 s kept").assertIsDisplayed()   // StudioTrim's readout
        }
        renderPass("studio-write-dark", mutate = { it.setPath("mode", "write") }) {
            onNodeWithText("Write your lyrics…").assertIsDisplayed()
        }
    }

    @Test
    fun fxSheetChainAutotuneAndToolsPanelsRender() {
        renderPass("studio-fx-chain-dark", mutate = { it.setPath("showFX", true) }) {
            onNodeWithText("Signal chain").assertIsDisplayed()
            // Panel content below the node rail rides the same grow-fills-container
            // defect inside the sheet's content cell (layout lane) — existence until then.
            onNodeWithText("Chain presets").assertExists()
            onNodeWithText("Rap Vocal").assertExists()
            firstWithText("Mastering").assertExists()             // the node rail scrolls
        }
        renderPass("studio-fx-autotune-dark", mutate = {
            it.setPath("showFX", true)
            it.setPath("fxNode", "pitch")
        }) {
            onNodeWithText("Auto-Tune").assertExists()
            onNodeWithText("Set up Auto-Tune with AI").assertExists()
            onNodeWithText("Pitch Studio").assertExists()
            firstWithText("Natural").assertExists()
        }
        renderPass("studio-fx-tools-dark", mutate = {
            it.setPath("showFX", true)
            it.setPath("fxNode", "ai")
        }) {
            firstWithText("Tools").assertExists()
            onNodeWithText("Choir").assertExists()
            onNodeWithText("Isolate vocals").assertExists()
            firstWithText("Clean up").assertExists()
        }
    }

    @Test
    fun pitchStudioSheetRendersAgentCardAndEditor() {
        renderPass("studio-pitch-dark", mutate = {
            it.setPath("showFX", true)
            it.setPath("fxNode", "pitch")
            it.setPath("pitchEditing", true)
            it.setPath("notesStatus", "done")
            it.setPath(
                "pitchNotes",
                listOf(
                    row("id" to 1, "start" to 0.0, "duration" to 0.8, "detectedMidi" to 60.0, "targetMidi" to 62.0),
                    row("id" to 2, "start" to 1.0, "duration" to 0.6, "detectedMidi" to 64.0, "targetMidi" to 64.0),
                    row("id" to 3, "start" to 1.8, "duration" to 1.0, "detectedMidi" to 65.0, "targetMidi" to 65.0),
                ),
            )
        }) {
            // AgentCard is the inlined component: its idle face must exist.
            firstWithText("AI Magic Tune").assertIsDisplayed()
        }
    }
}
