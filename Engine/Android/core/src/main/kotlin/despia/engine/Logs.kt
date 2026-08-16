//
//  Logs.kt — the DSX log system's kernel core: the structured LOG RING behind `dsx.log`
//  (OpenSource/Conformance/logs/logs.json — the unified console primitive). Kotlin twin of
//  Engine/iOS/Logs.swift and the Web kernel's logs.ts.
//
//  `dsx.log` is `console.log` with a home: one formatted line per call, attributed to its
//  source scheme, recorded here (ring, cap 500, always on — appending is nanoseconds and
//  programs, not just testers, read it via `dsx.logs`), and mirrored to `kernelLog` (logcat
//  on debug builds; the armed diagnostics ring on test installs — the drawer + Copy-all see
//  it). Logs are NOT errors: nothing here touches the error ledger, the hooks, or the
//  reactive `global.dsx.*` keys. Names no package, imports no android.* — a pure kernel
//  primitive per the constitution; nothing here ever throws (Article 7).
//

package despia.engine

/// One recorded log line — source scheme + console level + the formatted message.
/// scheme: a package scheme, "app" (unscoped markup), "console" (the console.* builtin),
/// or "page" (the DSXWebView page / the kernel `dsx.log` bus verb).
data class DSXLogEntry(
    val scheme: String,
    /// "log" for dsx.log; the console.* builtin records its own level
    val level: String,
    val message: String,
    val at: Long = System.currentTimeMillis(),
) {
    /// The read form (dev tooling, the conformance hosts) — mirrors DSXError.wire().
    fun wire(): Map<String, Any?> = linkedMapOf(
        "scheme" to scheme, "level" to level, "message" to message)
}

/// The log ring: a capped structured ring, process-global like the registry.
class DSXLogBuffer private constructor() {
    companion object {
        val shared = DSXLogBuffer()
        const val cap = 500
    }

    private val lock = Any()
    private val entries = ArrayList<DSXLogEntry>()
    private var total = 0

    fun append(e: DSXLogEntry) {
        synchronized(lock) {
            entries.add(e)
            total += 1
            if (entries.size > cap) {
                // ring: keep the newest tail, drop the oldest
                entries.subList(0, entries.size - cap).clear()
            }
        }
    }

    /// The retained tail, oldest → newest (snapshot).
    fun recent(): List<DSXLogEntry> = synchronized(lock) { ArrayList(entries) }

    /// Monotonic count of every line ever recorded (survives ring eviction).
    fun count(): Int = synchronized(lock) { total }

    /// Dev tooling only — drops the retained tail (the monotonic count stays).
    fun clear() { synchronized(lock) { entries.clear() } }
}

/// Record one log line: the ring + one `[dsx.log] scheme: message` kernelLog line (logcat
/// on debug builds, the armed diagnostics ring on test installs). Message arrives
/// pre-formatted (the house coercions — formatLogArgs below). Never throws.
internal fun reportLog(scheme: String, level: String, message: String) {
    DSXLogBuffer.shared.append(DSXLogEntry(scheme = scheme, level = level, message = message))
    kernelLog("[dsx.log] $scheme: $message")
}

/// The HOUSE log formatter — console.log-shaped variadic formatting, shared by the
/// `console.*` builtin, the `dsx.log` statement, and the module-handle `dsx.log` (the logs
/// corpus pins it): a dict/array serializes as canonical minified JSON with
/// credential-looking keys masked (JSERedact); anything else takes the JSE string coercion.
internal fun formatLogArgs(args: List<Any?>): String = args.joinToString(" ") { v ->
    when (v) {
        is Map<*, *> -> JSECoreGlobals.jsonWrite(JSERedact.mask(JSECoreGlobals.jsonSanitize(v)), pretty = false, sortKeys = false) ?: JSE.string(v)
        is List<*> -> JSECoreGlobals.jsonWrite(JSERedact.mask(JSECoreGlobals.jsonSanitize(v)), pretty = false, sortKeys = false) ?: JSE.string(v)
        else -> JSE.string(v)
    }
}
