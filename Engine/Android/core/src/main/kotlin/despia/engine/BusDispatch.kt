package despia.engine

//
//  BusDispatch.kt — the native-component → module bus call, and the VERDICT it answers
//  (X1 H5). Kernel, not render: the verdict is a bus fact, the two renderers only forward
//  to it, and :core is the module a test can reach without an Android SDK.
//
//  Twin: OpenSource/Engine/iOS/Stack.swift `DSXDispatchVerdict` / `DSXBusDispatch`.
//

/// What a native component learns when it calls a module action over the bus.
///
/// NOT a Boolean, and that is the entire point of the type. The Swift twin used to answer
/// `Bool`, and that Bool reported the CLAIM — "some module took this call" — never the SETTLE,
/// so every component that gated a side effect on it failed OPEN: a REFUSED call is still a
/// claimed one. This lane's `dispatchCall` answered `Unit`, which cannot be mistaken for a
/// settle but discards the refusal entirely, so a Kotlin component had no way to gate at all.
///
/// **Gate on [succeeded].** False when the action refused, false when nothing claimed the call,
/// and false while the answer is still in flight — fail-closed in all three.
///
/// DIVERGENCE (deliberate): the Swift verdict also carries the refusal's human `message`.
/// This lane's terminal seam is `JSEModuleOutcome.Error(code, data)`, which carries no message
/// — widening it is a kernel change with its own producers to update, and inventing a field
/// that is structurally always null would be the success-shaped negative in another costume.
data class DSXDispatchVerdict(
    /// A module took the call. Says nothing about whether it worked.
    val claimed: Boolean,
    /// The action reached a terminal answer before this value was handed back.
    val settled: Boolean,
    /// The action settled SUCCESSFULLY — the gate value, false unless proven otherwise.
    val succeeded: Boolean,
    /// The declared error code when the action refused; `unavailable` when nothing claimed the
    /// call (the spelling the markup path raises for an unshipped package); else null.
    val code: String?,
    /// The resolved value on success, or the error's `data` payload on a refusal.
    val value: Any?,
    /// Who was asked and for what, as routed — so a log line can name them.
    val scheme: String?,
    val action: String?,
)

/// The ONE reading of a native component's bus call on this lane — the twin of Swift's
/// `DSXBusDispatch`, kept in the kernel so no component grows a private verdict of its own.
object DSXBusDispatch {
    fun run(call: String, args: Map<String, Any?>,
            then: ((DSXDispatchVerdict) -> Unit)? = null): DSXDispatchVerdict {
        if (call.isEmpty()) {
            val empty = verdict(false, null, null, null)
            then?.invoke(empty)
            return empty
        }
        val carrier = JSERunner.normalizeCall(call)
        // Split the same way the mount does, and BEFORE the call: the terminal callback names
        // who was asked and cannot read the dispatch's own result.
        val separator = carrier.indexOf("://")
        val scheme = if (separator > 0) carrier.substring(0, separator) else null
        val action = if (separator > 0) carrier.substring(separator + 3).substringBefore('?') else null
        var settle: JSEModuleOutcome? = null
        var handedBack = false
        val claimed = JSERunner.moduleHandle(carrier, args) { outcome ->
            settle = outcome
            // Before the return, the synchronous verdict below already carries this settle;
            // delivering here as well would call `then` twice for the common case.
            if (handedBack) then?.invoke(verdict(true, outcome, scheme, action))
        }
        handedBack = true
        val answer = verdict(claimed, settle, scheme, action)
        // Final right here: a settle that already arrived, or a call nothing claimed (nothing
        // will ever settle that one). Anything else is in flight and `then` waits for it.
        if (settle != null || !claimed) then?.invoke(answer)
        return answer
    }

    private fun verdict(claimed: Boolean, settle: JSEModuleOutcome?,
                        scheme: String?, action: String?): DSXDispatchVerdict = when (settle) {
        is JSEModuleOutcome.Resolve ->
            DSXDispatchVerdict(claimed, settled = true, succeeded = true, code = null,
                               value = settle.value, scheme = scheme, action = action)
        is JSEModuleOutcome.Error ->
            DSXDispatchVerdict(claimed, settled = true, succeeded = false, code = settle.code,
                               value = settle.data, scheme = scheme, action = action)
        null ->
            DSXDispatchVerdict(claimed, settled = false, succeeded = false,
                               code = if (claimed) null else "unavailable",
                               value = null, scheme = scheme, action = action)
    }
}
