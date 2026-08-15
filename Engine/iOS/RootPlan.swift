//
//  RootPlan.swift — the ROOT PLAN first-ready fold (root-plan.md; corpus
//  Conformance/router/root-plan.json — its `_note` is the contract). REFERENCE
//  implementation; the twins are Engine/Android RootPlan.kt and the web's
//  packages/dom/src/root-plan.ts — keep the three byte-equivalent in behavior.
//  The class is the PRODUCTION engine; `Host` is the seam that lets the
//  conformance verifier (RootPlanConformance) drive it on a virtual clock while
//  Router.boot wires the real frame mount, bus, and timers.
//
//  Semantics (pinned by the corpus): candidates run in array order; each attempt
//  mounts as ordinary frame-0 content and races frame settle vs a root-attributed
//  `dsx.error` vs its deadline. ready → fire `root.ready` once — the plan is DONE
//  for the process lifetime (later signals dropped: no silent root swap). failed →
//  fire `root.failed` and ALWAYS advance (there is no onFailure key). exhausted →
//  fire `root.exhausted` + the kernel boot diagnostic (NOT a component). While an
//  attempt is live, the frame-0 readiness settle DEADLINE is suspended — the
//  candidate's own timeoutMs is the bounded fail-open (DSXScreenReadiness's
//  bounded settle would otherwise force a fail-open "ready" and defeat any longer
//  surface fallback).
//

import Foundation

enum RootPlan {

    struct Attempt {
        let index: Int
        let id: String
        let view: String
        let code: String
        let elapsedMs: Int
    }

    /// The host seam: production = Router (frames/bus/daemon timers); conformance = the
    /// virtual-clock harness in ConformanceHosts.swift.
    struct Host {
        /// swap frame-0 content to this candidate (config = component attributes, verbatim)
        let mount: (AppManifest.Entry.Surface, Int) -> Void
        let now: () -> Int
        /// schedule `fire` in `ms`; returns cancel
        let setTimer: (Int, @escaping () -> Void) -> () -> Void
        /// bus emission — root.ready / root.failed / root.exhausted (Article-8 names)
        let fire: (String, [String: Any]) -> Void
        /// component-registry membership (an absent tag fails as root.component_missing)
        let registered: (String) -> Bool
        /// the kernel boot diagnostic — shown on exhaustion
        let diagnostic: ([Attempt]) -> Void
    }

    final class Fold {
        let plan: [AppManifest.Entry.Surface]
        private(set) var ledger: [Attempt] = []
        private(set) var winner: AppManifest.Entry.Surface?
        private let host: Host
        private let target: String
        private var live = -1                 // the live attempt index — the stale-signal token
        private var startedAt = 0
        private var cancelTimer: (() -> Void)?
        private var done = false

        init(plan: [AppManifest.Entry.Surface], host: Host, target: String) {
            self.plan = plan
            self.host = host
            self.target = target
        }

        func start() { attempt(0) }

        /// Tear the fold down (a retry replacing it): cancel the pending attempt timer and
        /// close the selector so late timers/signals are inert. Idempotent.
        func close() {
            cancelTimer?()
            cancelTimer = nil
            done = true
            live = -1
        }

        /// Is an attempt LIVE — the plan still racing, neither crowned nor exhausted? A
        /// level-observing host needs this to tell "the fold refused my signal" from "the fold
        /// is finished and refuses everything"; only the former means the level it read belongs
        /// to a corpse and must be retired (Router.swift / Router.kt observe sinks).
        var active: Bool { !done && live >= 0 }

        /// frame-0 settle. `attemptIndex` binds the signal to one attempt (stale → dropped).
        func settle(attemptIndex: Int? = nil) {
            if done || live < 0 { return }
            if let idx = attemptIndex, idx != live { return }
            let c = plan[live]
            cancelTimer?()
            done = true
            winner = c
            host.fire("root.ready", [
                "id": c.id, "view": c.view, "index": live, "target": target,
                "elapsedMs": host.now() - startedAt,
            ])
        }

        /// a dsx.error reaching the fold. Only origin "root" during a live attempt advances.
        func rootError(code: String, origin: String, attemptIndex: Int? = nil) {
            if done || live < 0 { return }
            if let idx = attemptIndex, idx != live { return }
            if origin != "root" { return }
            fail(code)
        }

        private func attempt(_ i: Int) {
            live = i
            if i >= plan.count {
                live = -1
                done = true
                host.fire("root.exhausted", [
                    "target": target,
                    "attempts": ledger.map { [
                        "index": $0.index, "id": $0.id, "view": $0.view,
                        "code": $0.code, "elapsedMs": $0.elapsedMs,
                    ] },
                ])
                host.diagnostic(ledger)
                return
            }
            let c = plan[i]
            startedAt = host.now()
            if !host.registered(c.view) {
                fail("root.component_missing")
                return
            }
            host.mount(c, i)
            // `mount` can drive the fold SYNCHRONOUSLY (a state sink that settles or errors
            // inline — the Android sink's normal shape, and the web `screen.ready` hook fires
            // inside `router.start`). If it did, that later attempt already armed its own
            // deadline and owns it: arming here would overwrite its canceller, orphaning it,
            // and leave a zombie timer for a DEAD candidate to fire against whoever is live.
            if done || live != i { return }
            cancelTimer = host.setTimer(c.timeoutMs) { [weak self] in self?.fail("root.timeout", attemptIndex: i) }
        }

        private func fail(_ code: String, attemptIndex: Int? = nil) {
            if done || live < 0 { return }   // a timer that slipped past its canceller is inert (first terminal wins)
            if let idx = attemptIndex, idx != live { return }   // a deadline from a previous attempt never kills the live one
            let i = live
            let c = plan[i]
            cancelTimer?()
            cancelTimer = nil
            let elapsedMs = host.now() - startedAt
            ledger.append(Attempt(index: i, id: c.id, view: c.view, code: code, elapsedMs: elapsedMs))
            // Close the attempt BEFORE the fire: a hook on root.failed — or any state write it
            // makes — can re-enter the fold synchronously, and with the token still live that
            // re-entry would settle the candidate that just failed, crowning a corpse.
            live = -1
            host.fire("root.failed", [
                "id": c.id, "view": c.view, "index": i, "target": target,
                "elapsedMs": elapsedMs,
                "error": ["code": code, "recoverable": true],
            ])
            attempt(i + 1)   // failure ALWAYS advances — there is no policy key
        }
    }
}
