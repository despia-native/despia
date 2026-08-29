package despia.engine

import java.io.File
import kotlin.math.abs
import kotlin.math.max
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The U03 shared-element conformance runner - executes OpenSource/Conformance/router/shared.json
 * through THIS runtime's StackSharedTransition (parity/U03-shared-transitions.md). The TS twin
 * (@despia/kernel shared-transition.ts, shared-transition-conformance.test.ts) and the Swift
 * reference (StackSharedTransition, via the record lane) run the SAME file, so `shared="cover-3"`
 * cannot pair one way on one renderer and another way on the next.
 *
 * Missing corpus = loud failure; a silently-skipped conformance suite is how drift starts.
 */
class SharedTransitionConformanceTest {

    private val tolerance = 1e-6

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/router/shared.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/router/shared.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(): Map<String, Any?> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("shared.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "shared.json version")
        return root
    }

    private fun near(actual: Double, expected: Double, what: String) {
        assertTrue(abs(actual - expected) <= tolerance, "$what: expected $expected, got $actual")
    }

    private fun num(value: Any?): Double = (value as Number).toDouble()

    @Suppress("UNCHECKED_CAST")
    private fun element(raw: Map<String, Any?>): StackSharedTransition.Element {
        val frame = raw["frame"] as Map<String, Any?>
        return StackSharedTransition.Element(
            id = raw["id"] as String,
            frame = StackSharedTransition.Rect(
                num(frame["x"]), num(frame["y"]), num(frame["width"]), num(frame["height"]),
            ),
            radius = (raw["radius"] as? Number)?.toDouble() ?: 0.0,
            opacity = (raw["opacity"] as? Number)?.toDouble() ?: 1.0,
            contentMode = raw["contentMode"] as? String ?: "fill",
            laid = raw["laid"] as? Boolean ?: true,
            order = (raw["order"] as? Number)?.toInt(),
            mode = raw["mode"] as? String,
            anim = raw["anim"] as? String,
        )
    }

    @Suppress("UNCHECKED_CAST")
    private fun geometry(raw: Map<String, Any?>): StackSharedTransition.Geometry =
        StackSharedTransition.Geometry(
            num(raw["x"]), num(raw["y"]), num(raw["width"]), num(raw["height"]),
            num(raw["radius"]), num(raw["opacity"]), raw["contentMode"] as String,
        )

    @Suppress("UNCHECKED_CAST")
    private fun pair(raw: Map<String, Any?>): StackSharedTransition.Pair =
        StackSharedTransition.Pair(
            id = raw["id"] as String,
            order = (raw["order"] as Number).toInt(),
            mode = raw["mode"] as String,
            anim = raw["anim"] as? String,
            deferred = raw["deferred"] as Boolean,
            from = geometry(raw["from"] as Map<String, Any?>),
            to = geometry(raw["to"] as Map<String, Any?>),
        )

    @Test
    @Suppress("UNCHECKED_CAST")
    fun constantsAgreeWithCorpus() {
        val doc = root()
        assertEquals((doc["modes"] as List<Any?>).map { it as String }, StackSharedTransition.MODES, "modes")
        near(StackSharedTransition.HANDOFF_START, num(doc["handoffStart"]), "handoffStart")
        val a11y = doc["a11y"] as Map<String, Any?>
        assertEquals(a11y["focus"] as String, StackSharedTransition.A11Y_FOCUS_TARGET, "a11y focus target")
        assertEquals(a11y["at"] as String, StackSharedTransition.A11Y_FOCUS_AT, "a11y focus timing")
        near(tolerance, num(doc["tolerance"]), "tolerance")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun matchingAgreesWithCorpus() {
        val cases = root()["match"] as? List<Map<String, Any?>> ?: error("shared.json: no match[]")
        assertTrue(cases.isNotEmpty(), "match corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val source = (case["source"] as List<Map<String, Any?>>).map(::element)
            val destination = (case["destination"] as List<Map<String, Any?>>).map(::element)
            val actual = StackSharedTransition.match(
                source, destination,
                reducedMotion = case["reducedMotion"] as? Boolean ?: false,
                frameAnim = case["frameAnim"] as? String,
            )
            val expect = case["expect"] as Map<String, Any?>
            val wanted = (expect["pairs"] as List<Map<String, Any?>>).map(::pair)

            assertEquals(wanted.size, actual.pairs.size, "$name: pair count")
            actual.pairs.forEachIndexed { index, got ->
                val want = wanted[index]
                val at = "$name: pair $index"
                assertEquals(want.id, got.id,
                             "$at: id (order is sharedOrder then destination document order)")
                assertEquals(want.order, got.order, "$at: order")
                assertEquals(want.mode, got.mode, "$at: mode")
                assertEquals(want.anim, got.anim, "$at: anim")
                assertEquals(want.deferred, got.deferred, "$at: deferred")
                for ((label, ends) in listOf("from" to (want.from to got.from), "to" to (want.to to got.to))) {
                    val (w, g) = ends
                    near(g.x, w.x, "$at: $label.x")
                    near(g.y, w.y, "$at: $label.y")
                    near(g.width, w.width, "$at: $label.width")
                    near(g.height, w.height, "$at: $label.height")
                    near(g.radius, w.radius, "$at: $label.radius")
                    near(g.opacity, w.opacity, "$at: $label.opacity")
                    assertEquals(w.contentMode, g.contentMode, "$at: $label.contentMode")
                }
                if (got.deferred) {
                    assertTrue(got.to.width > 0.0 && got.to.height > 0.0,
                               "$at: an unrealised destination must never produce a zero rect")
                }
            }
            assertEquals((expect["unmatchedSource"] as List<Any?>).map { it as String },
                         actual.unmatchedSource, "$name: unmatchedSource")
            assertEquals((expect["unmatchedDestination"] as List<Any?>).map { it as String },
                         actual.unmatchedDestination, "$name: unmatchedDestination")
            assertEquals((expect["duplicates"] as List<Any?>).map { it as String },
                         actual.duplicates, "$name: duplicates")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun interpolationAgreesWithCorpus() {
        val cases = root()["interpolate"] as? List<Map<String, Any?>> ?: error("shared.json: no interpolate[]")
        assertTrue(cases.isNotEmpty(), "interpolate corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val subject = pair(case["pair"] as Map<String, Any?>)
            for (step in case["samples"] as List<Map<String, Any?>>) {
                val progress = num(step["progress"])
                val expect = step["expect"] as Map<String, Any?>
                val got = StackSharedTransition.sample(subject, progress)
                val at = "$name @ $progress"
                near(got.x, num(expect["x"]), "$at: x")
                near(got.y, num(expect["y"]), "$at: y")
                near(got.width, num(expect["width"]), "$at: width")
                near(got.height, num(expect["height"]), "$at: height")
                near(got.radius, num(expect["radius"]), "$at: radius")
                near(got.alpha, num(expect["alpha"]), "$at: alpha")
                near(got.sourceOpacity, num(expect["sourceOpacity"]), "$at: sourceOpacity")
                near(got.destinationOpacity, num(expect["destinationOpacity"]), "$at: destinationOpacity")
                assertEquals(expect["contentMode"] as String, got.contentMode, "$at: contentMode")
                assertEquals(expect["scaleContent"] as Boolean, got.scaleContent, "$at: scaleContent")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun interruptionMachineAgreesWithCorpus() {
        val cases = root()["machine"] as? List<Map<String, Any?>> ?: error("shared.json: no machine[]")
        assertTrue(cases.isNotEmpty(), "machine corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val machine = SharedTransitionMachine()
            var previous = machine.snapshot().progress
            var maxStep: Double? = null
            var gesture = false

            (case["steps"] as List<Map<String, Any?>>).forEachIndexed { index, step ->
                val event = step["event"] as Map<String, Any?>
                val at = "$name: step $index"
                val got = when {
                    event.containsKey("begin") ->
                        machine.begin(
                            if (event["begin"] == "forward") StackSharedTransition.Direction.FORWARD
                            else StackSharedTransition.Direction.REVERSE
                        )
                    event.containsKey("tick") -> machine.tick(num(event["tick"]))
                    event.containsKey("interrupt") -> machine.interrupt(num(event["interrupt"]))
                    event.containsKey("drag") -> machine.drag(num(event["drag"]))
                    event.containsKey("release") -> machine.release(event["release"] == "commit")
                    event.containsKey("settle") -> machine.settle()
                    else -> error("$at names no event")
                }
                val expect = step["expect"] as Map<String, Any?>
                assertEquals(expect["state"] as String, StackSharedTransition.word(got.state), "$at: state")
                assertEquals(expect["direction"] as String, StackSharedTransition.word(got.direction), "$at: direction")
                near(got.progress, num(expect["progress"]), "$at: progress")
                near(got.target, num(expect["target"]), "$at: target")
                near(got.remaining, num(expect["remaining"]), "$at: remaining")
                assertEquals(expect["outcome"] as? String, StackSharedTransition.word(got.outcome), "$at: outcome")
                // the snapshot must be a READ, not a mutation - asking twice cannot move the machine
                assertEquals(got, machine.snapshot(), "$at: snapshot is stable")

                // THE GESTURE WINDOW: from the interrupt that hands the transition to the finger
                // through the release that gives it back. Progress inside it may only move as far
                // as the finger did - a snap is a jump of the whole remaining distance.
                val delta = abs(got.progress - previous)
                if (event.containsKey("interrupt")) {
                    maxStep = if (gesture) max(maxStep ?: 0.0, delta) else delta
                    gesture = true
                    assertTrue(delta <= tolerance,
                               "$at: an interruption must ADOPT the transition at its current " +
                                   "progress, not restart or snap it (progress moved $delta)")
                } else if (gesture) {
                    maxStep = max(maxStep ?: 0.0, delta)
                    if (event.containsKey("release")) gesture = false
                }
                previous = got.progress
            }

            val pinned = (case["maxStep"] as? Number)?.toDouble()
            if (pinned != null) {
                assertNotNull(maxStep, "$name: maxStep is pinned but no gesture ran")
                assertTrue((maxStep ?: 0.0) <= pinned + tolerance,
                           "$name: the transition SNAPPED - largest single-step progress delta " +
                               "was $maxStep, the corpus allows $pinned")
            }
        }
    }
}
