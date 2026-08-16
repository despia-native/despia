// Router.kt - task hint to model, deterministically.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The Kotlin twin of bindings/ts/src/router.ts. Nothing here is heuristic: the
// table is data, the filters are stated, and every decision carries a reason a
// surface can show. That is the honest counter to confidence-based cloud
// hand-off - we route across YOUR models on MEASURED fit, and the only remote
// is the app's own backend.

package com.despia.ai

sealed interface Decision {
    val task: String
    val reason: String

    data class Local(override val task: String, val model: String, override val reason: String) : Decision
    data class Remote(override val task: String, override val reason: String) : Decision
    data class None(override val task: String, override val reason: String) : Decision
}

object Router {
    fun route(
        task: String,
        table: Json,
        installed: List<String>,
        entries: Map<String, Json>,
        verdicts: Map<String, Verdict>,
        caps: Json,
        loaded: String?,
    ): Decision {
        val policy = table["remote"]["policy"].string("local")

        // remote-only does not consult local models at all. The policy IS the
        // decision, and the reason says so rather than letting it look silent.
        if (policy == "remote-only") return Decision.Remote(task, "policy-remote-only")

        val known = table["tasks"]
        val usedDefault = !known.has(task)
        val resolvedTask = if (usedDefault) table["default"].string(task) else task
        val spec = known[resolvedTask]

        val needCaps = spec["require_caps"].strings()
        val features = caps["features"].strings()
        val candidates = spec["prefer"].strings().filter { id ->
            if (id !in installed) return@filter false
            val entry = entries[id] ?: return@filter false
            // A required capability has to hold on BOTH sides: the build reports
            // it, and the entry declares it can use it. A model that never
            // claimed constrained decoding is not a candidate for a task that
            // needs it, however good it is at chatting.
            val declared = entry["requires"]["engine_caps"].strings()
            if (needCaps.any { it !in features || it !in declared }) return@filter false
            val verdict = verdicts[id] ?: return@filter false
            Fit.meetsFloor(verdict.verdict, spec["min_verdict"].stringOrNull())
        }

        if (candidates.isNotEmpty()) {
            // Stickiness is real economics: a swap costs seconds and hundreds of
            // megabytes, so a resident model that satisfies the task wins. It
            // never overrides the capability filter or the verdict floor above -
            // cheapness does not beat correctness.
            if (table["stickiness"]["prefer_loaded"].bool() && loaded != null && loaded in candidates) {
                return Decision.Local(task, loaded, "sticky-loaded")
            }
            return Decision.Local(task, candidates.first(), if (usedDefault) "default-chain" else "preference-order")
        }

        if (policy == "prefer-local") return Decision.Remote(task, "no-local-candidate")
        // policy `local` never leaves the device, even with an endpoint configured.
        return Decision.None(task, "no_candidate")
    }
}
