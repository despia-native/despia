//
//  KernelLog.kt — DEBUG-only kernel logging. Kotlin twin of Engine/KernelLog.swift —
//  same names, same arguments, same behaviors.
//

package despia.engine

import java.time.LocalTime
import java.time.format.DateTimeFormatter

/**
 * The debug gate for [kernelLog]. Swift gates the print with `#if DEBUG`; pure JVM has no
 * BuildConfig, so the gate is this settable flag — OFF by default (shipping consoles stay
 * clean). This is the JVM seam for the Android wiring later: the app target sets
 * `KernelLog.enabled = BuildConfig.DEBUG` at boot, and :core stays android.*-free.
 */
object KernelLog {
    var enabled: Boolean = false
}

/**
 * Kernel diagnostic log — PRINTED only when [KernelLog.enabled] (debug builds), and
 * CAPTURED into the in-memory [KernelLogBuffer] on armed installs. Store/sideload test
 * builds are RELEASE builds, so without the capture every kernel diagnostic (a
 * malformed-DSX parse error, a routing no-op, a gate denial) is invisible on exactly the
 * builds QA runs — no console, no IDE. The buffer feeds the on-device debug drawer. The
 * app target arms it at boot on TEST channels only; production installs never capture.
 * Names no package, so it is a pure kernel primitive per the constitution.
 */
fun kernelLog(vararg items: Any?, separator: String = " ") {
    val line = items.joinToString(separator)
    if (KernelLog.enabled) println(line)
    KernelLogBuffer.shared.append(line)   // no-op until armed (test channels, app target only)
}

/**
 * The in-memory tail of kernel diagnostics. SELF-CONTAINED (references no other engine file),
 * so KernelLog.kt stays mirrorable into other targets exactly like its Swift twin. Capture is
 * OFF until [arm] — extension targets and production installs never arm it, so they never
 * buffer a byte.
 */
class KernelLogBuffer private constructor() {
    companion object {
        val shared = KernelLogBuffer()

        private const val cap = 600   // ring: keep the newest tail, drop the oldest

        // Swift uses a DateFormatter; DateTimeFormatter is its thread-safe JVM twin.
        private val clock = DateTimeFormatter.ofPattern("HH:mm:ss.SSS")
        private fun stamp(): String = LocalTime.now().format(clock)
    }

    private val lock = Any()
    private var armed = false
    private val lines = ArrayList<String>()

    /** Arm capture (the app target, at boot, on test channels only). Idempotent. */
    fun arm() {
        synchronized(lock) { armed = true }
    }

    internal fun append(line: String) {
        synchronized(lock) {
            if (!armed) return
            lines.add(stamp() + " " + line)
            if (lines.size > cap) lines.subList(0, lines.size - cap).clear()
        }
    }

    /** The captured tail, oldest → newest. Empty when never armed (production / extensions). */
    fun snapshot(): List<String> = synchronized(lock) { lines.toList() }
}
