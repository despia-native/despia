package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The U07 controls conformance runner - executes
 * OpenSource/Conformance/controls/{gradients,gauge,colorpicker,masked}.json through THIS
 * runtime's ControlsCore (parity/U07-controls.md). The TS twin (@despia-native/kernel
 * controls-core.ts) and the Swift reference (Engine/iOS/ControlsCore.swift) run the SAME files,
 * so gradientAngle="135deg" cannot point one way on one renderer and another way on the next,
 * a <gauge> cannot report a different meter value, and a colour cannot be announced by a
 * different name.
 *
 * Missing corpus = loud failure: a silently-skipped conformance suite is how drift starts.
 */
class ControlsConformanceTest {

    private val epsilon = 1e-9

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/controls")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/controls not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(name: String): Map<String, Any?> {
        val file = File(corpusDir(), "$name.json")
        assertTrue(file.isFile, "$name.json missing")
        val root = json(file.readText()).foundationValue as? Map<String, Any?>
            ?: error("$name.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name.json version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun rows(name: String, section: String): List<Map<String, Any?>> {
        val list = doc(name)[section] as? List<Map<String, Any?>> ?: error("$name.json: no $section[]")
        assertTrue(list.isNotEmpty(), "$name.$section must not be empty")
        return list
    }

    private fun num(value: Any?): Double = (value as Number).toDouble()

    private fun near(actual: Double, expected: Double, label: String) {
        assertTrue(Math.abs(actual - expected) < epsilon, "$label: expected $expected, got $actual")
    }

    @Suppress("UNCHECKED_CAST")
    private fun point(value: Any?): Pair<Double, Double> {
        val map = value as Map<String, Any?>
        return num(map["x"]) to num(map["y"])
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun gradientVocabularyAgreesWithCorpus() {
        val root = doc("gradients")
        assertEquals((root["types"] as List<Any?>).map { it as String }, ControlsCore.GRADIENT_TYPES)
        val aliases = root["directionAliases"] as Map<String, Any?>
        assertEquals(aliases.keys.sorted(), ControlsCore.GRADIENT_DIRECTION_ALIASES.keys.sorted())
        for ((token, angle) in aliases) {
            near(ControlsCore.GRADIENT_DIRECTION_ALIASES.getValue(token), num(angle), "alias $token")
            near(ControlsCore.parseGradientAngle(token)!!, num(angle), "parse $token")
        }
        val defaults = root["defaults"] as Map<String, Any?>
        near(ControlsCore.GRADIENT_ANGLE_DEFAULT, num(defaults["angle"]), "default angle")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun gradientResolverAgreesWithCorpus() {
        for (case in rows("gradients", "cases")) {
            val name = case["name"] as String
            val attrs = case["attrs"] as Map<String, Any?>
            val got = ControlsCore.resolveGradient(
                gradient = attrs["gradient"] as? String,
                gradientType = attrs["gradientType"] as? String,
                gradientStops = attrs["gradientStops"] as? String,
                gradientAngle = attrs["gradientAngle"],
                gradientDir = attrs["gradientDir"] as? String,
                gradientCenter = attrs["gradientCenter"] as? String,
                gradientRadius = attrs["gradientRadius"],
                gradientPoints = attrs["gradientPoints"] as? String,
            )
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["type"], got.type, "$name: type")
            assertEquals((expect["colors"] as List<Any?>).map { it as String }, got.colors, "$name: colors")
            val stops = (expect["stops"] as List<Any?>).map { num(it) }
            assertEquals(stops.size, got.stops.size, "$name: stop count")
            stops.forEachIndexed { index, value -> near(got.stops[index], value, "$name: stop $index") }
            near(got.angle, num(expect["angle"]), "$name: angle")
            val (sx, sy) = point(expect["start"]); near(got.start.x, sx, "$name: start.x"); near(got.start.y, sy, "$name: start.y")
            val (ex, ey) = point(expect["end"]); near(got.end.x, ex, "$name: end.x"); near(got.end.y, ey, "$name: end.y")
            val (cx, cy) = point(expect["center"]); near(got.center.x, cx, "$name: center.x"); near(got.center.y, cy, "$name: center.y")
            near(got.radius, num(expect["radius"]), "$name: radius")
            assertEquals(expect["valid"], got.valid, "$name: valid")

            val mesh = expect["mesh"] as? Map<String, Any?>
            if (mesh == null) {
                assertNull(got.mesh, "$name: mesh")
                assertNull(got.meshFallback, "$name: meshFallback")
            } else {
                val grid = got.mesh
                assertNotNull(grid, "$name: mesh")
                assertEquals((mesh["columns"] as Number).toInt(), grid.columns, "$name: mesh columns")
                assertEquals((mesh["rows"] as Number).toInt(), grid.rows, "$name: mesh rows")
                val points = mesh["points"] as List<Map<String, Any?>>
                assertEquals(points.size, grid.points.size, "$name: mesh point count")
                points.forEachIndexed { index, raw ->
                    val actual = grid.points[index]
                    near(actual.x, num(raw["x"]), "$name: point $index x")
                    near(actual.y, num(raw["y"]), "$name: point $index y")
                    assertEquals(raw["color"], actual.color, "$name: point $index color")
                }
                val fallback = expect["meshFallback"] as Map<String, Any?>
                val degradation = got.meshFallback
                assertNotNull(degradation, "$name: meshFallback")
                assertEquals(fallback["base"], degradation.base, "$name: fallback base")
                val layers = fallback["layers"] as List<Map<String, Any?>>
                assertEquals(layers.size, degradation.layers.size, "$name: fallback layer count")
                layers.forEachIndexed { index, raw ->
                    val actual = degradation.layers[index]
                    val (lx, ly) = point(raw["center"])
                    near(actual.center.x, lx, "$name: layer $index x")
                    near(actual.center.y, ly, "$name: layer $index y")
                    near(actual.radius, num(raw["radius"]), "$name: layer $index radius")
                    assertEquals(raw["color"], actual.color, "$name: layer $index color")
                }
            }
        }
    }

    @Test
    fun zeroDegreesPointsUpAndTheAngleIncreasesClockwise() {
        val up = ControlsCore.gradientUnitPoints(0.0)
        near(up.first.x, 0.5, "0deg start x"); near(up.first.y, 1.0, "0deg start y")
        near(up.second.x, 0.5, "0deg end x"); near(up.second.y, 0.0, "0deg end y")
        val right = ControlsCore.gradientUnitPoints(90.0)
        near(right.first.x, 0.0, "90deg start x"); near(right.second.x, 1.0, "90deg end x")
        val down = ControlsCore.gradientUnitPoints(180.0)
        near(down.first.y, 0.0, "180deg start y"); near(down.second.y, 1.0, "180deg end y")
        val left = ControlsCore.gradientUnitPoints(270.0)
        near(left.first.x, 1.0, "270deg start x"); near(left.second.x, 0.0, "270deg end x")
    }

    @Test
    fun meshRefusesARaggedGridAndDegradesToLinear() {
        assertNull(ControlsCore.parseMeshPoints("0 0 #F00, 1 0 #0F0; 0 1 #00F"), "ragged")
        assertNull(ControlsCore.parseMeshPoints("0 0 #F00, 1 0 #0F0"), "one row is not a mesh")
        assertNull(ControlsCore.parseMeshPoints("0 0 #F00; 0 1 #00F"), "one column is not a mesh")
        assertNull(ControlsCore.parseMeshPoints("0 0; 0 1"), "a point without a colour")
        val degraded = ControlsCore.resolveGradient(
            gradient = "#F00|#00F", gradientType = "mesh", gradientPoints = "0 0 #F00")
        assertEquals("linear", degraded.type)
        assertEquals(true, degraded.valid)
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun gaugeStyleMetricsAgreeWithCorpus() {
        val styles = doc("gauge")["styles"] as Map<String, Any?>
        assertEquals(styles.keys.sorted(), ControlsCore.GAUGE_STYLES.keys.sorted())
        for ((name, raw) in styles) {
            val expect = raw as Map<String, Any?>
            val metrics = ControlsCore.GAUGE_STYLES.getValue(name)
            near(metrics.arcStart, num(expect["arcStart"]), "$name: arcStart")
            near(metrics.arcSweep, num(expect["arcSweep"]), "$name: arcSweep")
            near(metrics.thickness, num(expect["thickness"]), "$name: thickness")
            assertEquals(expect["showsCurrentLabel"], metrics.showsCurrentLabel, "$name: showsCurrentLabel")
            assertEquals(expect["showsBoundLabels"], metrics.showsBoundLabels, "$name: showsBoundLabels")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun gaugeResolutionAgreesWithCorpus() {
        for (case in rows("gauge", "cases")) {
            val name = case["name"] as String
            val got = ControlsCore.resolveGauge(
                num(case["value"]), num(case["min"]), num(case["max"]),
                case["style"] as? String, case["currentLabel"] as? String,
            )
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["style"], got.style, "$name: style")
            near(got.fraction, num(expect["fraction"]), "$name: fraction")
            near(got.clampedValue, num(expect["clampedValue"]), "$name: clampedValue")
            near(got.arcStart, num(expect["arcStart"]), "$name: arcStart")
            near(got.arcSweep, num(expect["arcSweep"]), "$name: arcSweep")
            near(got.valueAngle, num(expect["valueAngle"]), "$name: valueAngle")
            near(got.thickness, num(expect["thickness"]), "$name: thickness")
            assertEquals(expect["showsCurrentLabel"], got.showsCurrentLabel, "$name: showsCurrentLabel")
            assertEquals(expect["showsBoundLabels"], got.showsBoundLabels, "$name: showsBoundLabels")
            val a11y = expect["a11y"] as Map<String, Any?>
            assertEquals(a11y["role"], got.a11y.role, "$name: role")
            near(got.a11y.min, num(a11y["min"]), "$name: a11y min")
            near(got.a11y.max, num(a11y["max"]), "$name: a11y max")
            near(got.a11y.now, num(a11y["now"]), "$name: a11y now")
            assertEquals((a11y["percent"] as Number).toInt(), got.a11y.percent, "$name: a11y percent")
            assertEquals(a11y["valueText"], got.a11y.valueText, "$name: a11y valueText")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun gaugeTintAgreesWithCorpus() {
        for (case in rows("gauge", "tint")) {
            val name = case["name"] as String
            val colors = ControlsCore.parseGradientColors(case["tint"] as? String)
            val stops = ControlsCore.parseGradientStops(case["stops"] as? String, colors.size)
            val got = ControlsCore.gaugeTintSegment(colors, stops, num(case["fraction"]))
            val expect = case["expect"] as? Map<String, Any?>
            if (expect == null) { assertNull(got, name); continue }
            assertNotNull(got, name)
            assertEquals((expect["fromIndex"] as Number).toInt(), got.fromIndex, "$name: fromIndex")
            assertEquals((expect["toIndex"] as Number).toInt(), got.toIndex, "$name: toIndex")
            near(got.t, num(expect["t"]), "$name: t")
        }
        assertNull(ControlsCore.gaugeTintSegment(emptyList(), emptyList(), 0.5))
    }

    @Test
    fun anEmptyOrInvertedRangeIsAZeroFractionNeverNaN() {
        for ((lo, hi) in listOf(10.0 to 10.0, 10.0 to 5.0, 0.0 to 0.0)) {
            val got = ControlsCore.resolveGauge(7.0, lo, hi, "circular")
            near(got.fraction, 0.0, "fraction")
            assertTrue(got.valueAngle.isFinite(), "valueAngle finite")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun colorNamesAndModesAgreeWithCorpus() {
        val root = doc("colorpicker")
        val names = root["names"] as List<Map<String, Any?>>
        assertEquals(names.map { it["name"] as String }, ControlsCore.COLOR_NAMES.map { it.first })
        assertEquals(names.map { it["hex"] as String }, ControlsCore.COLOR_NAMES.map { it.second })
        assertEquals((root["modes"] as List<Any?>).map { it as String }, ControlsCore.COLOR_PICKER_MODES)
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun hexRoundTripAgreesWithCorpus() {
        for (case in rows("colorpicker", "parse")) {
            val name = case["name"] as String
            val parsed = ControlsCore.parseHexColor(case["input"] as String)
            val expect = case["expect"] as? Map<String, Any?>
            if (expect == null) { assertNull(parsed, name); continue }
            assertNotNull(parsed, name)
            val rgba = expect["rgba"] as Map<String, Any?>
            assertEquals((rgba["r"] as Number).toInt(), parsed.r, "$name: r")
            assertEquals((rgba["g"] as Number).toInt(), parsed.g, "$name: g")
            assertEquals((rgba["b"] as Number).toInt(), parsed.b, "$name: b")
            assertEquals((rgba["a"] as Number).toInt(), parsed.a, "$name: a")
            assertEquals(expect["hex"], ControlsCore.formatHexColor(parsed, false), "$name: hex")
            assertEquals(expect["hexWithAlpha"], ControlsCore.formatHexColor(parsed, true), "$name: hex+alpha")
            assertEquals(expect["name"], ControlsCore.nearestColorName(parsed), "$name: name")
            assertEquals(parsed, ControlsCore.parseHexColor(ControlsCore.formatHexColor(parsed, true)),
                "$name: round-trip")
        }
    }

    @Test
    fun announcedNameAgreesWithCorpus() {
        for (case in rows("colorpicker", "nearestName")) {
            val name = case["name"] as String
            val parsed = ControlsCore.parseHexColor(case["input"] as String)!!
            assertEquals(case["expect"], ControlsCore.nearestColorName(parsed), name)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun swatchNormalisationAgreesWithCorpus() {
        for (case in rows("colorpicker", "swatches")) {
            val name = case["name"] as String
            val got = ControlsCore.resolveSwatches(case["swatches"] as? String, case["alpha"] as Boolean)
            assertEquals((case["expect"] as List<Any?>).map { it as String }, got, name)
        }
        val many = (0 until 40).joinToString(",") { "#" + String.format(java.util.Locale.ROOT, "%06x", it) }
        assertEquals(24, ControlsCore.resolveSwatches(many).size, "the list caps at 24")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun colorModeDefaultAgreesWithCorpus() {
        for (case in rows("colorpicker", "mode")) {
            val alpha = case["alpha"] as Boolean
            val count = (case["swatchCount"] as Number).toInt()
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["mode"], ControlsCore.resolveColorPickerMode(case["mode"] as? String, alpha, count))
            assertEquals(expect["webNeedsCustomPanel"], ControlsCore.webNeedsCustomColorPanel(alpha, count))
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun maskFoldAgreesWithCorpus() {
        for (case in rows("masked", "cases")) {
            val name = case["name"] as String
            val got = ControlsCore.resolveMask(case["mode"] as? String, case["invert"])
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["mode"], got.mode, "$name: mode")
            assertEquals(expect["invert"], got.invert, "$name: invert")
            assertEquals(expect["blend"], got.blend, "$name: blend")
            assertEquals(expect["cssMaskMode"], got.cssMaskMode, "$name: cssMaskMode")
            assertEquals(expect["maskChildHidden"], got.maskChildHidden, "$name: maskChildHidden")
            assertEquals(expect["contentSemanticsPreserved"], got.contentSemanticsPreserved,
                "$name: contentSemanticsPreserved")
            val layers = expect["webLayers"] as List<Map<String, Any?>>
            assertEquals(layers.size, got.webLayers.size, "$name: layer count")
            layers.forEachIndexed { index, raw ->
                assertEquals(raw["image"], got.webLayers[index].image, "$name: layer $index image")
                assertEquals(raw["composite"], got.webLayers[index].composite, "$name: layer $index composite")
            }
        }
    }

    @Test
    fun theMaskChildIsAlwaysHiddenAndTheContentKeepsItsSemantics() {
        for (mode in listOf(null, "alpha", "luminance", "bogus")) {
            for (invert in listOf(true, false)) {
                val got = ControlsCore.resolveMask(mode, invert)
                assertTrue(got.maskChildHidden)
                assertTrue(got.contentSemanticsPreserved)
            }
        }
    }
}
