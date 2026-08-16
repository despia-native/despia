package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The SOFT-KEYBOARD VIEWPORT conformance runner — executes
 * OpenSource/Conformance/keyboard/viewport.json through this runtime (the TS and Swift runners
 * run the SAME file). The law and the reasoning are in that corpus's README.
 *
 * The rule worth restating, because it is the one that makes a page portable across modes:
 * `insetHeight` reports what the keyboard obscures OF THE LAYOUT VIEWPORT, not how tall the
 * keyboard is. Under RESIZE the viewport has already shrunk, so the answer is 0 — publishing the
 * raw height there would double-count and push content off screen — while `boundingRect` stays
 * real, because it answers the different question of where the keyboard is.
 *
 * Missing corpus = loud failure; a silently-skipped conformance suite is how drift starts.
 */
class KeyboardViewportConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/keyboard/viewport.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/keyboard/viewport.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun cases(): List<Map<String, Any?>> {
        val doc = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("viewport.json: not a JSON object")
        return (doc["cases"] as? List<*> ?: error("viewport.json: no cases"))
            .map { it as Map<String, Any?> }
    }

    private fun int(any: Any?): Int = when (any) {
        is Number -> any.toInt()
        else -> error("expected a number, got $any")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun corpus() {
        val all = cases()
        assertTrue(all.isNotEmpty(), "corpus is empty")
        for (case in all) {
            val name = case["name"] as? String ?: "(unnamed)"
            val keyboard = case["keyboard"] as Map<String, Any?>
            val viewport = case["viewport"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val rect = expect["boundingRect"] as Map<String, Any?>

            val got = KeyboardViewport.resolve(
                declared = case["declared"] as? String,
                platform = case["platform"] as String,
                api = (case["api"] as? Number)?.toInt(),
                keyboardVisible = keyboard["visible"] as Boolean,
                keyboardHeight = int(keyboard["height"]),
                viewportWidth = int(viewport["width"]),
                viewportHeight = int(viewport["height"]),
                requested = case["requested"] as? Boolean,
            )

            assertEquals(expect["mode"] as String, got.mode.word, "$name — mode")
            assertEquals(expect["degraded"] as Boolean, got.degraded, "$name — degraded")
            assertEquals(int(expect["insetHeight"]), got.insetHeight, "$name — insetHeight")
            assertEquals(expect["overlaysContent"] as Boolean, got.overlaysContent, "$name — overlaysContent")
            assertEquals(
                KeyboardRect(int(rect["x"]), int(rect["y"]), int(rect["width"]), int(rect["height"])),
                got.boundingRect,
                "$name — boundingRect",
            )
        }
    }

    @Test
    fun modeParsingIsTotal() {
        assertEquals(KeyboardMode.RESIZE, KeyboardViewport.parseMode("resize"))
        assertEquals(KeyboardMode.RESIZE, KeyboardViewport.parseMode("  ReSize "))
        assertEquals(KeyboardMode.OVERLAY, KeyboardViewport.parseMode("OVERLAY"))
        // A dashboard typo must not fail a build or half-apply a mode.
        for (junk in listOf(null, "", "   ", "shrink", "true", "1", "resize;overlay")) {
            assertEquals(KeyboardMode.LEGACY, KeyboardViewport.parseMode(junk), "junk: $junk")
        }
    }

    @Test
    fun onlyAndroidHasAnApiFloorAndItIsThirty() {
        assertFalse(KeyboardViewport.supportsViewportModes("android", 29))
        assertTrue(KeyboardViewport.supportsViewportModes("android", 30))
        assertTrue(KeyboardViewport.supportsViewportModes("android", 36))
        // An unknown level fails CLOSED — a mode that half-works is worse than legacy.
        assertFalse(KeyboardViewport.supportsViewportModes("android", null))
        assertTrue(KeyboardViewport.supportsViewportModes("ios", null))
        assertTrue(KeyboardViewport.supportsViewportModes("web", null))
    }

    @Test
    fun theInsetNeverGoesNegativeAndNeverExceedsTheViewport() {
        val viewportHeight = 800
        for (height in listOf(-10_000, -1, 0, 799, 800, 801, 10_000, Int.MAX_VALUE, Int.MIN_VALUE)) {
            for (mode in listOf("legacy", "overlay")) {
                val got = KeyboardViewport.resolve(
                    declared = mode, platform = "ios",
                    keyboardVisible = true, keyboardHeight = height,
                    viewportWidth = 400, viewportHeight = viewportHeight,
                )
                assertTrue(got.insetHeight >= 0, "inset went negative for $height")
                assertTrue(got.insetHeight <= viewportHeight, "inset exceeded the viewport for $height")
                assertTrue(got.boundingRect.y >= 0, "rect origin went negative for $height")
                assertTrue(
                    got.boundingRect.y + got.boundingRect.height <= viewportHeight,
                    "rect overflowed the viewport for $height",
                )
            }
        }
    }

    @Test
    fun theRuntimePlaneReachesTheTwoLiveStatesAndNeverLegacy() {
        assertEquals(KeyboardMode.OVERLAY, KeyboardViewport.modeForOverlaysContent(true))
        assertEquals(KeyboardMode.RESIZE, KeyboardViewport.modeForOverlaysContent(false))
    }

    @Test
    fun aRuntimeAssignmentOutranksEveryDeclaredWord() {
        for (declared in listOf("legacy", "resize", "overlay", "shrink", "", null)) {
            fun resolve(requested: Boolean?) = KeyboardViewport.resolve(
                declared = declared, platform = "ios",
                keyboardVisible = true, keyboardHeight = 300,
                viewportWidth = 400, viewportHeight = 800,
                requested = requested,
            )
            assertEquals(KeyboardMode.RESIZE, resolve(false).mode, "declared: $declared")
            assertEquals(KeyboardMode.OVERLAY, resolve(true).mode, "declared: $declared")
            // Absent, not merely falsy: `false` is a real request and must not read as "never asked".
            assertEquals(KeyboardViewport.parseMode(declared), resolve(null).mode, "declared: $declared")
        }
    }

    @Test
    fun resizePublishesAZeroInsetButARealRect() {
        val got = KeyboardViewport.resolve(
            declared = "resize", platform = "ios",
            keyboardVisible = true, keyboardHeight = 300,
            viewportWidth = 400, viewportHeight = 800,
        )
        assertEquals(0, got.insetHeight, "the viewport already shrank; a non-zero inset double-counts")
        assertFalse(got.overlaysContent)
        assertEquals(KeyboardRect(0, 500, 400, 300), got.boundingRect)
    }
}
