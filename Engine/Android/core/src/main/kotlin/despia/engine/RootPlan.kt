//
//  RootPlan.kt — the ROOT PLAN first-ready fold (root-plan.md; corpus
//  Conformance/router/root-plan.json — its `_note` is the contract, and the TS twin
//  is OpenSource/Web/packages/dom/src/root-plan.ts: keep the two byte-equivalent in
//  behavior). The class is the PRODUCTION engine; `Host` is the seam that lets the
//  conformance harness drive it on a virtual clock while Router.boot wires the real
//  frame mount, bus, and timers.
//
//  Semantics (pinned by the corpus): candidates run in array order; each attempt
//  mounts as ordinary frame-0 content and races frame settle vs a root-attributed
//  `dsx.error` vs its deadline. ready → fire `root.ready` once — the plan is DONE
//  for the process lifetime (later signals dropped: no silent root swap). failed →
//  fire `root.failed` and ALWAYS advance (there is no onFailure key). exhausted →
//  fire `root.exhausted` + the kernel boot diagnostic (NOT a component). While an
//  attempt is live, the frame-0 readiness settle DEADLINE is suspended — the
//  candidate's own timeoutMs is the bounded fail-open (ScreenReadiness.deadline
//  would otherwise force a fail-open "ready" at 10s and defeat surface fallback).
//

package despia.engine

object RootPlan {

    class Attempt(val index: Int, val id: String, val view: String, val code: String, val elapsedMs: Long)

    interface Host {
        /** swap frame-0 content to this candidate (config = component attributes, verbatim) */
        fun mount(candidate: AppManifest.Entry.Surface, index: Int)
        fun now(): Long
        /** schedule `fire` in `ms`; returns cancel */
        fun setTimer(ms: Long, fire: () -> Unit): () -> Unit
        /** bus emission — root.ready / root.failed / root.exhausted (Article-8 names) */
        fun fire(event: String, payload: Map<String, Any?>)
        /** component-registry membership (an absent tag fails as root.component_missing) */
        fun registered(view: String): Boolean
        /** the kernel boot diagnostic — shown on exhaustion */
        fun diagnostic(ledger: List<Attempt>)
    }

    class Fold(val plan: List<AppManifest.Entry.Surface>, private val host: Host, private val target: String) {
        val ledger = mutableListOf<Attempt>()
        var winner: AppManifest.Entry.Surface? = null
            private set
        private var live = -1                 // the live attempt index — the stale-signal token
        private var startedAt = 0L
        private var cancelTimer: (() -> Unit)? = null
        private var done = false

        fun start() = attempt(0)

        /// Tear the fold down (Router.shutdown / a retry replacing it): cancel the pending
        /// attempt timer and close the selector so late timers/signals are inert. Idempotent.
        fun close() {
            cancelTimer?.invoke()
            cancelTimer = null
            done = true
            live = -1
        }

        /// Is an attempt LIVE — the plan still racing, neither crowned nor exhausted? A
        /// level-observing host needs this to tell "the fold refused my signal" from "the fold
        /// is finished and refuses everything"; only the former means the level it read belongs
        /// to a corpse and must be retired (Router.kt / Router.swift observe sinks).
        val active: Boolean get() = !done && live >= 0

        /** frame-0 settle. `attemptIndex` binds the signal to one attempt (stale → dropped). */
        fun settle(attemptIndex: Int? = null) {
            if (done || live < 0) return
            if (attemptIndex != null && attemptIndex != live) return
            val c = plan[live]
            cancelTimer?.invoke()
            done = true
            winner = c
            host.fire("root.ready", mapOf(
                "id" to c.id, "view" to c.view, "index" to live, "target" to target,
                "elapsedMs" to (host.now() - startedAt)))
        }

        /** a dsx.error reaching the fold. Only origin "root" during a live attempt advances. */
        fun rootError(code: String, origin: String, attemptIndex: Int? = null) {
            if (done || live < 0) return
            if (attemptIndex != null && attemptIndex != live) return
            if (origin != "root") return
            fail(code)
        }

        private fun attempt(i: Int) {
            live = i
            if (i >= plan.size) {
                live = -1
                done = true
                host.fire("root.exhausted", mapOf(
                    "target" to target,
                    "attempts" to ledger.map { mapOf(
                        "index" to it.index, "id" to it.id, "view" to it.view,
                        "code" to it.code, "elapsedMs" to it.elapsedMs) }))
                host.diagnostic(ledger.toList())
                return
            }
            val c = plan[i]
            startedAt = host.now()
            if (!host.registered(c.view)) {
                fail("root.component_missing")
                return
            }
            host.mount(c, i)
            // `mount` can drive the fold SYNCHRONOUSLY (a state sink that settles or errors
            // inline — this renderer's sink is exactly that shape). If it did, that later
            // attempt already armed its own deadline and owns it: arming here would overwrite
            // its canceller, orphaning it, and leave a zombie timer for a DEAD candidate to
            // fire against whoever is live.
            if (done || live != i) return
            cancelTimer = host.setTimer(c.timeoutMs.toLong()) { fail("root.timeout", i) }
        }

        private fun fail(code: String, attemptIndex: Int? = null) {
            if (done || live < 0) return   // a timer that slipped past its canceller is inert (first terminal wins)
            if (attemptIndex != null && attemptIndex != live) return   // a deadline from a previous attempt never kills the live one
            val i = live
            val c = plan[i]
            cancelTimer?.invoke()
            cancelTimer = null
            val elapsedMs = host.now() - startedAt
            ledger.add(Attempt(i, c.id, c.view, code, elapsedMs))
            // Close the attempt BEFORE the fire: a hook on root.failed — or any state write it
            // makes — can re-enter the fold synchronously, and with the token still live that
            // re-entry would settle the candidate that just failed, crowning a corpse.
            live = -1
            host.fire("root.failed", mapOf(
                "id" to c.id, "view" to c.view, "index" to i, "target" to target,
                "elapsedMs" to elapsedMs,
                "error" to mapOf("code" to code, "recoverable" to true)))
            attempt(i + 1)   // failure ALWAYS advances — there is no policy key
        }
    }
}
