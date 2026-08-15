//
//  Errors.kt — the DSX error system's kernel core: the DSXError value, the error LEDGER,
//  and the AMBIENT fan-out (architecture/proposals/error-system.md, ACCEPTED v1).
//  Kotlin twin of Engine/iOS/Errors.swift and the Web kernel's bus.ts (DSXErrors).
//
//  Errors are VALUES on the bus: one shape, recorded in ONE ledger, whether they came from
//  a failed call (origin "call" — fed by Context.reportCallFailure / sendError's web-caller
//  path) or an ambient emission (origin "raised" — `dsx.error`/`dsx.fail` on the module
//  handle, where there is no call to settle). The ledger is a capped ring (the
//  KernelLogBuffer pattern with values instead of lines), ALWAYS on: appending is
//  nanoseconds, and programs — not just testers — read it (`dsx.errors`, the reactive
//  `global.dsx.*` keys, DevSettings). Nothing here ever throws or crashes (Article 7).
//

package despia.engine

/// One recorded error — the wire shape plus ledger metadata.
data class DSXError(
    val code: String,
    val message: String? = null,
    val recoverable: Boolean = false,
    val data: Any? = null,
    /// the SOURCE scheme (whose error this is)
    val scheme: String,
    /// "raised" (ambient emission) | "call" (a failed bus call) | "uncaught" (a throw that
    /// unwound a markup action to the top with no catch)
    val origin: String,
    /// origin "call" only — false = fire-and-forget: the call site never saw the error
    val delivered: Boolean? = null,
    val at: Long = System.currentTimeMillis(),
) {
    /// The wire form — hook payloads, the page channel, `global.dsx.lastError`. `data` and
    /// `delivered` ride only when present; `message` is an explicit null when absent (the
    /// corpus pins the defaults).
    fun wire(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out["code"] = code; out["message"] = message; out["recoverable"] = recoverable
        out["scheme"] = scheme; out["origin"] = origin
        if (data != null) out["data"] = data
        if (delivered != null) out["delivered"] = delivered
        return out
    }
}

/// The error ledger: a capped structured ring, process-global like the registry.
class DSXErrorLedger private constructor() {
    companion object {
        val shared = DSXErrorLedger()
        const val cap = 128
    }

    private val lock = Any()
    private val entries = ArrayList<DSXError>()
    private var total = 0

    fun append(e: DSXError) {
        synchronized(lock) {
            entries.add(e)
            total += 1
            if (entries.size > cap) {
                // ring: keep the newest tail, drop the oldest
                repeat(entries.size - cap) { entries.removeAt(0) }
            }
        }
    }

    /// The retained tail, oldest → newest (snapshot).
    fun recent(): List<DSXError> = synchronized(lock) { ArrayList(entries) }

    /// Monotonic count of every error ever recorded (survives ring eviction) — the value
    /// `global.dsx.errorCount` publishes.
    fun count(): Int = synchronized(lock) { total }

    /// Dev tooling only — drops the retained tail (the monotonic count stays).
    fun clear() { synchronized(lock) { entries.clear() } }
}

/// The AMBIENT fan-out (error-system.md §3.3) — `dsx.error`/`dsx.fail` on the module handle,
/// and the JSE builtin from markup actions, both land here: there is no call to settle, so
/// the error reports to the APP, deterministically and repeatably (no settle guard — the
/// property the old accidental registrar path fatally lacked):
///   1. the ledger (+ the reactive keys `global.dsx.lastError` / `global.dsx.errorCount` —
///      error state IS observable state),
///   2. `module.error` — the semantic hook sibling of the transport-level `module.callFailed`,
///   3. the page channel: `{scheme, event:"error", data:<wire>}` on the module's OWN scheme
///      plus the reserved `dsx` mirror (one global error listener per app).
/// A nested emission from inside a hook / page handler stays LOG-ONLY — the thread-identity
/// guard below (exact under both executor styles: inline in pure-JVM tests, posted on a
/// device looper) keeps the fan-out from ever feeding an observer its own output.
/// PUBLIC because MODULE code emits on the ambient hat, exactly as it does on iOS (where
/// Errors.swift's twin is reachable from Dom.swift because the app is one module). Kotlin's
/// `internal` is per-GRADLE-module, so `:core`-private would have made this the one renderer
/// where a module cannot raise an ambient error — Dom's `web.main_frame_failed` is the first
/// real caller and the root plan depends on it (root-plan.md §7.1).
fun reportAmbientError(scheme: String, code: String, message: String? = null,
                       recoverable: Boolean = false, data: Any? = null,
                       origin: String = "raised") {
    var line = "[dsx.error] $scheme → $code"
    if (origin == "uncaught") line += " (uncaught)"
    if (message != null) line += " — $message"
    kernelLog(line)
    if (Thread.currentThread() === ambientErrorFanoutOn) return   // nested → log-only
    ModuleRegistry.shared.mainExecutor.execute {
        ambientErrorFanoutOn = Thread.currentThread()
        try {
            val err = DSXError(
                code = code, message = message, recoverable = recoverable,
                data = if (data == null) null else JSON.from(data).foundationValue,
                scheme = scheme, origin = origin)
            DSXErrorLedger.shared.append(err)
            val wire = err.wire()
            DSX.state.setPath("dsx.lastError", wire)
            DSX.state.setPath("dsx.errorCount", DSXErrorLedger.shared.count())
            ModuleRegistry.shared.dispatch("module.error", wire, combine = ModuleRegistry.Combine.void)
            deliverErrorEnvelope(scheme, wire)
            if (scheme != "dsx") deliverErrorEnvelope("dsx", wire)
        } finally {
            ambientErrorFanoutOn = null
        }
    }
}

@Volatile
private var ambientErrorFanoutOn: Thread? = null

/// One page-channel delivery — the standard out-of-band broadcast envelope (id null,
/// host ""), to every mounted surface (client-side scheme filter) AND the in-process
/// `dsx.events.on(scheme)` subscribers, exactly like Context.broadcast.
private fun deliverErrorEnvelope(scheme: String, wire: Map<String, Any?>) {
    val envelope: Map<String, Any?> = mapOf(
        "id" to null, "scheme" to scheme, "host" to "",
        "event" to "error", "final" to true, "data" to wire,
    )
    DSXMessenger().deliverBroadcast(
        DSXEgress(target = "*", scheme = scheme, rid = null, payload = envelope))
    DSXEvents().publish(scheme, "error", wire)
}
