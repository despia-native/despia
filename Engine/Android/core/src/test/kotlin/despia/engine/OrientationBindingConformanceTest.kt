package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * The `lockOrientation=` router-binding conformance runner - executes
 * OpenSource/Conformance/input/orientation-binding.json through THIS runtime's
 * StackOrientationBinding (parity/F07-orientation.md section 3a). The TS twin (@despia/kernel
 * orientation-binding.ts) and the Swift reference (OrientationBindingConformance, record lane)
 * run the SAME file.
 *
 * The corpus drives the reconcile AND feeds its plan into the real OrientationClaimStack, so the
 * two halves of the feature are pinned against each other: a plan that looks right but leaves the
 * stack holding a dead claim fails here, not on a device.
 *
 * Missing corpus = loud failure; a silently-skipped conformance suite is how drift starts.
 */
class OrientationBindingConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/input/orientation-binding.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/input/orientation-binding.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(): Map<String, Any?> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("orientation-binding.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "orientation-binding.json version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun surfaces(raw: Any?): List<StackOrientationBinding.Surface> =
        (raw as? List<Map<String, Any?>> ?: emptyList()).map {
            StackOrientationBinding.Surface(it["surface"] as String, it["to"] as String)
        }

    @Suppress("UNCHECKED_CAST")
    private fun ops(raw: Any?): List<StackOrientationBinding.Op> =
        (raw as? List<Map<String, Any?>> ?: emptyList()).map {
            StackOrientationBinding.Op(it["op"] as String, it["surface"] as String, it["to"] as? String)
        }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun surfaceIdsAgreeWithCorpus() {
        val ids = root()["surfaceIds"] as Map<String, Any?>
        assertEquals((ids["frame"] as String).replace("<frameId>", "4"),
                     StackOrientationBinding.frameSurface(4), "frame surface id")
        assertEquals((ids["modal"] as String).replace("<modalId>", "4"),
                     StackOrientationBinding.modalSurface(4), "modal surface id")
        assertNotEquals(StackOrientationBinding.frameSurface(4), StackOrientationBinding.modalSurface(4),
                        "a frame and a presentation with the same id must not collide")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun reconcileAgreesWithCorpus() {
        val cases = root()["reconcile"] as? List<Map<String, Any?>>
            ?: error("orientation-binding.json: no reconcile[]")
        assertTrue(cases.isNotEmpty(), "reconcile corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            // the SHIPPED claim stack, driven by the plan - the two halves pinned against each other
            val stack = OrientationClaimStack()
            (case["imperative"] as? String)?.let { stack.claim(OrientationClaimStack.IMPERATIVE_ID, it) }
            var ledger: List<StackOrientationBinding.Surface> = emptyList()

            (case["steps"] as List<Map<String, Any?>>).forEachIndexed { index, step ->
                val at = "$name: publish $index (${step["publish"]})"
                val live = surfaces(step["live"])
                val plan = StackOrientationBinding.plan(live, ledger)
                assertEquals(ops(step["expectOps"]), plan.ops, "$at: ops")
                assertEquals(surfaces(step["expectLedger"]), plan.ledger, "$at: ledger")

                for (op in plan.ops) {
                    if (op.op == "release") stack.release(op.surface) else stack.claim(op.surface, op.to!!)
                }
                assertEquals(step["expectEffective"] as? String, stack.effective,
                             "$at: the stack's effective lock")

                // the reconcile must be a FIXED POINT: re-running it against the same live set
                // changes nothing. That is the becomeActive re-assert, and the reason a merely
                // covered screen is safe.
                assertEquals(emptyList(), StackOrientationBinding.plan(live, plan.ledger).ops,
                             "$at: re-running the reconcile must be a no-op")
                ledger = plan.ledger
            }
        }
    }
}
