package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The U02 gesture conformance runner - executes OpenSource/Conformance/input/gestures.json
 * through THIS runtime's StackGestures pure core (parity/U02-gestures.md). The TS twin
 * (@despia/dom gestures.ts, gestures.test.ts) and the Swift reference (StackGestures.swift,
 * the record lane) run the SAME file, so recognition thresholds, velocity derivation, swipe
 * classification, transform accumulation, the gestureAxis claim and the composition
 * resolver cannot drift between renderers.
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
 */
class GesturesConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/input/gestures.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/input/gestures.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(): Map<String, Any?> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("gestures.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "gestures.json version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(name: String): Pair<List<Map<String, Any?>>, Double> {
        val doc = root()
        val block = doc[name] as? Map<String, Any?> ?: error("gestures.json: no $name{}")
        val cases = block["cases"] as? List<Map<String, Any?>> ?: error("gestures.json: no $name.cases[]")
        assertTrue(cases.isNotEmpty(), "$name: empty corpus section")
        val constants = doc["constants"] as? Map<String, Any?> ?: error("gestures.json: no constants{}")
        return cases to num(constants["tolerance"])
    }

    private fun num(v: Any?): Double = (v as Number).toDouble()

    private fun close(actual: Double, expected: Any?, tolerance: Double, label: String) {
        val want = num(expected)
        assertTrue(actual.isFinite(), "$label: $actual is not finite")
        assertTrue(kotlin.math.abs(actual - want) <= tolerance, "$label: $actual != $want")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun constantsMatchTheCorpus() {
        val constants = root()["constants"] as? Map<String, Any?> ?: error("gestures.json: no constants{}")
        assertEquals(StackGestures.TAP_SLOP, num(constants["tapSlop"]), "tapSlop")
        assertEquals(StackGestures.AXIS_SLOP, num(constants["axisSlop"]), "axisSlop")
        assertEquals(StackGestures.SWIPE_MIN_DISTANCE, num(constants["swipeMinDistance"]), "swipeMinDistance")
        assertEquals(StackGestures.SWIPE_MIN_VELOCITY, num(constants["swipeMinVelocity"]), "swipeMinVelocity")
        assertEquals(StackGestures.VELOCITY_WINDOW_MS, num(constants["velocityWindowMs"]), "velocityWindowMs")
        assertEquals(StackGestures.VELOCITY_SAMPLES, num(constants["velocitySamples"]).toInt(), "velocitySamples")
        assertEquals(StackGestures.PINCH_SLOP, num(constants["pinchSlop"]), "pinchSlop")
        assertEquals(StackGestures.ROTATE_SLOP, num(constants["rotateSlop"]), "rotateSlop")
        assertEquals(constants["precedence"] as? List<String>, StackGestures.PRECEDENCE, "precedence")
        assertEquals(constants["continuous"] as? List<String>, StackGestures.CONTINUOUS.sorted(), "continuous")
        assertEquals(constants["directional"] as? List<String>, StackGestures.DIRECTIONAL.sorted(), "directional")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun velocityAgreesWithCorpus() {
        val (cases, tolerance) = section("velocity")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val samples = (case["samples"] as? List<Map<String, Any?>> ?: emptyList())
                .map { StackGestures.Sample1D(num(it["t"]), num(it["value"])) }
            close(StackGestures.velocity1D(samples), case["expect"], tolerance, "velocity/$name")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun velocity2DAgreesWithCorpus() {
        val (cases, tolerance) = section("velocity2D")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val samples = (case["samples"] as? List<Map<String, Any?>> ?: emptyList())
                .map { StackGestures.Sample2D(num(it["t"]), num(it["x"]), num(it["y"])) }
            val got = StackGestures.velocity2D(samples)
            val expect = case["expect"] as? Map<String, Any?> ?: error("velocity2D/$name: no expect{}")
            close(got.vx, expect["vx"], tolerance, "velocity2D/$name vx")
            close(got.vy, expect["vy"], tolerance, "velocity2D/$name vy")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun pressAgreesWithCorpus() {
        val (cases, _) = section("press")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val tracker = StackPressTracker()
            val actions = mutableListOf<String>()
            for (event in case["events"] as? List<Map<String, Any?>> ?: emptyList()) {
                val id = event["id"] as? String ?: "p1"
                val x = num(event["x"] ?: 0)
                val y = num(event["y"] ?: 0)
                actions += when (val type = event["type"] as? String) {
                    "down" -> tracker.down(id, x, y)
                    "move" -> tracker.move(id, x, y)
                    "up" -> tracker.up(id, x, y)
                    "cancel" -> tracker.cancel(id)
                    "unmount" -> tracker.unmount()
                    else -> error("press/$name: unknown event $type")
                }
            }
            assertEquals(case["expect"] as? List<String> ?: emptyList<String>(), actions, "press/$name")
            assertEquals(case["expectDragging"] as? Boolean ?: false, tracker.dragging, "press/$name dragging")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun hoverMotionAgreesWithCorpus() {
        val (cases, tolerance) = section("hover")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val motion = StackHoverMotion()
            val emitted = mutableListOf<StackHoverMotion.Emission>()
            for (event in case["events"] as? List<Map<String, Any?>> ?: emptyList()) {
                val x = num(event["x"] ?: 0)
                val y = num(event["y"] ?: 0)
                emitted += when (val type = event["type"] as? String) {
                    "enter" -> motion.enter(event["hoverCapable"] as? Boolean ?: false, x, y)
                    "move" -> motion.move(x, y)
                    "leave" -> motion.leave(x, y)
                    "unmount" -> motion.unmount()
                    else -> error("hover/$name: unknown event $type")
                }
            }
            val expect = case["expect"] as? List<Map<String, Any?>> ?: emptyList()
            assertEquals(expect.size, emitted.size, "hover/$name: emission count")
            expect.forEachIndexed { i, want ->
                assertEquals(want["action"] as? String, emitted[i].action, "hover/$name[$i] action")
                close(emitted[i].x, want["x"], tolerance, "hover/$name[$i] x")
                close(emitted[i].y, want["y"], tolerance, "hover/$name[$i] y")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun swipeAgreesWithCorpus() {
        val (cases, tolerance) = section("swipe")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val got = StackGestures.resolveSwipe(
                num(case["dx"]), num(case["dy"]), num(case["vx"]), num(case["vy"]),
                case["axis"] as? String ?: "both",
            )
            val expect = case["expect"] as? Map<String, Any?>
            if (expect == null) {
                assertNull(got, "swipe/$name")
            } else {
                assertNotNull(got, "swipe/$name")
                assertEquals(expect["direction"] as? String, got.direction, "swipe/$name direction")
                close(got.velocity, expect["velocity"], tolerance, "swipe/$name velocity")
                close(got.distance, expect["distance"], tolerance, "swipe/$name distance")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun axisClaimAgreesWithCorpus() {
        val (cases, _) = section("axisClaim")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val got = StackGestures.claimAxis(case["axis"] as? String ?: "both", num(case["dx"]), num(case["dy"]))
            assertEquals(case["expect"] as? String, got, "axisClaim/$name")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun transformAgreesWithCorpus() {
        val (cases, tolerance) = section("transform")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val tracker = StackTransformTracker()
            val emitted = mutableListOf<StackTransformTracker.Emission>()
            for (event in case["events"] as? List<Map<String, Any?>> ?: emptyList()) {
                emitted += if (event["type"] as? String == "cancel") {
                    tracker.cancel()
                } else {
                    val points = (event["points"] as? List<Map<String, Any?>> ?: emptyList())
                        .map { StackGestures.Point(it["id"] as String, num(it["x"]), num(it["y"])) }
                    tracker.update(num(event["t"] ?: 0), points)
                }
            }
            val expect = case["expect"] as? List<Map<String, Any?>> ?: emptyList()
            assertEquals(expect.size, emitted.size, "transform/$name: emission count")
            expect.forEachIndexed { i, want ->
                val got = emitted[i]
                assertEquals(want["phase"] as? String, got.phase, "transform/$name[$i] phase")
                close(got.scale, want["scale"], tolerance, "transform/$name[$i] scale")
                close(got.rotation, want["rotation"], tolerance, "transform/$name[$i] rotation")
                close(got.focusX, want["focusX"], tolerance, "transform/$name[$i] focusX")
                close(got.focusY, want["focusY"], tolerance, "transform/$name[$i] focusY")
                close(got.scaleVelocity, want["scaleVelocity"], tolerance, "transform/$name[$i] scaleVelocity")
                close(got.rotationVelocity, want["rotationVelocity"], tolerance, "transform/$name[$i] rotationVelocity")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun dragPayloadStaysAdditive() {
        val (cases, tolerance) = section("drag")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val samples = (case["samples"] as? List<Map<String, Any?>> ?: emptyList())
                .map { StackGestures.Sample2D(num(it["t"]), num(it["x"]), num(it["y"])) }
            val got = StackGestures.dragPayload(
                num(case["width"]), num(case["height"]), num(case["x"]), num(case["y"]),
                num(case["startX"]), num(case["startY"]), samples, case["phase"] as? String ?: "move",
            )
            val expect = case["expect"] as? Map<String, Any?> ?: error("drag/$name: no expect{}")
            assertEquals(expect.keys.sorted(), got.keys.sorted(), "drag/$name: payload keys")
            for ((key, want) in expect) {
                if (want is String) assertEquals(want, got[key], "drag/$name $key")
                else close(got[key] as Double, want, tolerance, "drag/$name $key")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun compositionAgreesWithCorpus() {
        val (cases, _) = section("composition")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val tree = (case["tree"] as? List<Map<String, Any?>> ?: emptyList()).map {
                StackGestures.Node(
                    it["id"] as String,
                    (it["recognizers"] as? List<String>) ?: emptyList(),
                    it["gesture"] as? String ?: "exclusive",
                    it["axis"] as? String ?: "both",
                )
            }
            val raw = case["attempt"] as? Map<String, Any?> ?: error("composition/$name: no attempt{}")
            val attempt = StackGestures.Attempt(
                ((raw["kinds"] as? List<String>) ?: emptyList()).toSet(),
                raw["axis"] as? String ?: "none",
                raw["claimedBy"] as? String,
            )
            val got = StackGestures.resolveComposition(tree, attempt)
            val expect = case["expect"] as? Map<String, Any?> ?: error("composition/$name: no expect{}")
            val wantFire = (expect["fire"] as? List<Map<String, Any?>> ?: emptyList())
                .map { StackGestures.Fired(it["node"] as String, it["kind"] as String) }
            val wantBlocked = (expect["blocked"] as? List<Map<String, Any?>> ?: emptyList())
                .map { StackGestures.Blocked(it["node"] as String, it["kind"] as String, it["reason"] as String) }
            assertEquals(wantFire, got.fire, "composition/$name fire")
            assertEquals(wantBlocked, got.blocked, "composition/$name blocked")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun degradationTableMatchesTheCorpus() {
        val block = root()["degradation"] as? Map<String, Any?> ?: error("gestures.json: no degradation{}")
        val rows = block["rows"] as? List<Map<String, Any?>> ?: error("gestures.json: no degradation.rows[]")
        assertTrue(rows.isNotEmpty(), "degradation: empty corpus section")
        assertEquals(rows.size, StackGestures.DEGRADATION.size, "degradation: row count")
        rows.forEachIndexed { i, want ->
            val got = StackGestures.DEGRADATION[i]
            assertEquals(want["gesture"], got["gesture"], "degradation[$i] gesture")
            assertEquals(want["requires"], got["requires"], "degradation[$i] requires")
            assertEquals(want["whenAbsent"], got["whenAbsent"], "degradation[$i] whenAbsent")
            assertEquals(want["alternative"], got["alternative"], "degradation[$i] alternative")
            assertEquals("never-fires", got["whenAbsent"], "degradation[$i]: a gesture never fakes its input")
            assertTrue((got["alternative"] ?: "").isNotEmpty(), "degradation[$i]: needs a reachable alternative")
        }
    }
}
