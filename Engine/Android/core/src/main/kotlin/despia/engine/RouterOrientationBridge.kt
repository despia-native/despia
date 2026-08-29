//
//  RouterOrientationBridge.kt - the ONE seam the Android router uses to hand a
//  `lockOrientation=` reconcile plan (StackOrientationBinding, corpus
//  OpenSource/Conformance/input/orientation-binding.json) to the Orientation module.
//
//  It exists because the plan is computed in :render (the host composes the frame stack) while
//  the bus call has to be built in :core (Bridge.Params' structured constructors are internal to
//  this module). One public function keeps :render free of bus mechanics and keeps the mechanics
//  out of the composable.
//
//  The module is EXCLUDABLE: `handle` simply answers false when the `orientation` scheme is not
//  in the build, so the app keeps its build-time orientation set and behaves exactly as it did
//  before the attribute existed (Article 7). Nothing here holds the module's claim stack, and
//  nothing here names its internals.
//
package despia.engine

object RouterOrientationBridge {

    /// Apply a reconcile plan. Ordered: the plan already emits releases before claims, so an
    /// arriving surface is never buried under a departing one. Every call hops to the main
    /// thread, because the module's applier touches the hosting Activity.
    fun apply(ops: List<StackOrientationBinding.Op>) {
        if (ops.isEmpty()) return
        for (op in ops) {
            val args: Map<String, Any?> = if (op.op == "release") {
                mapOf("surface" to op.surface)
            } else {
                mapOf("surface" to op.surface, "to" to (op.to ?: ""))
            }
            // Fire-and-forget by shape (the router has no answer to wait for), but a refusal
            // still reaches the diagnostics funnel through the module's own dsx.fail.
            val params = Bridge.Params(dict = args, onTerminal = { })
            ModuleRegistry.shared.mainExecutor.execute {
                ModuleRegistry.shared.handle(scheme = "orientation", actionPath = op.op,
                                             params = params, includeInternal = true)
            }
        }
    }
}
