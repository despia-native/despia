package despia.engine

import java.io.ByteArrayOutputStream
import java.io.PrintStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * KernelLogBuffer.shared is a process singleton and arming is one-way (Swift has no
 * disarm), so ALL order-sensitive buffer assertions live in ONE test method — the only
 * one that arms. The print-gate tests observe stdout instead, so they are order-free.
 */
class KernelLogTest {

    @Test fun enabledDefaultsFalse() {
        // Every mutating test restores the flag, so this holds in any order.
        assertFalse(KernelLog.enabled)
    }

    @Test fun printIsGatedByEnabled() {
        val original = System.out
        val captured = ByteArrayOutputStream()
        System.setOut(PrintStream(captured, true))
        try {
            KernelLog.enabled = false
            kernelLog("hidden")
            assertEquals("", captured.toString())

            KernelLog.enabled = true
            kernelLog("shown", 1, true)                       // default separator " "
            kernelLog("a", "b", separator = "|")              // custom separator
            val out = captured.toString().split("\n").map { it.trim() }.filter { it.isNotEmpty() }
            assertEquals(listOf("shown 1 true", "a|b"), out)
        } finally {
            System.setOut(original)
            KernelLog.enabled = false
        }
    }

    @Test fun bufferCapturesOnlyWhenArmedThenStampsAndRings() {
        val buffer = KernelLogBuffer.shared

        // 1. Never armed → nothing captured (production / extension behavior).
        kernelLog("before-arm")
        assertTrue(buffer.snapshot().isEmpty())

        // 2. Armed (idempotent) → lines are captured with an HH:mm:ss.SSS stamp.
        buffer.arm()
        buffer.arm()
        kernelLog("after-arm", 42)
        val snap = buffer.snapshot()
        assertEquals(1, snap.size)
        assertTrue(snap[0].endsWith(" after-arm 42"), "unexpected line: ${snap[0]}")
        assertTrue(Regex("""^\d{2}:\d{2}:\d{2}\.\d{3} """).containsMatchIn(snap[0]),
            "missing clock stamp: ${snap[0]}")

        // 3. Ring: keep the newest 600, drop the oldest.
        repeat(700) { kernelLog("line", it) }
        val tail = buffer.snapshot()
        assertEquals(600, tail.size)
        assertTrue(tail.first().endsWith(" line 100"))   // 701 appended, oldest 101 dropped
        assertTrue(tail.last().endsWith(" line 699"))
    }
}
