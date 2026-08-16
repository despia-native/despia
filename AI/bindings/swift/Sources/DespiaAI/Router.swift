//
//  Router.swift - task hint to model, deterministically.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  The Swift twin of bindings/ts/src/router.ts and Router.kt. Nothing here is
//  heuristic: the table is data, the filters are stated, and every decision
//  carries a reason a surface can show. That is the honest counter to
//  confidence-based cloud hand-off - we route across YOUR models on MEASURED
//  fit, and the only remote is the app's own backend.
//

import Foundation

public enum Decision: Sendable, Equatable {
    case local(task: String, model: String, reason: String)
    case remote(task: String, reason: String)
    /// No candidate and no policy that leaves the device.
    case unresolved(task: String, reason: String)

    public var reason: String {
        switch self {
        case .local(_, _, let reason), .remote(_, let reason), .unresolved(_, let reason):
            return reason
        }
    }
}

public enum Router {
    public static func route(task: String, table: JSON, installed: [String],
                             entries: [String: JSON], verdicts: [String: Verdict],
                             caps: JSON, loaded: String?) -> Decision {
        let policy = table["remote"]["policy"].string("local")

        // remote-only does not consult local models at all. The policy IS the
        // decision, and the reason says so rather than letting it look silent.
        if policy == "remote-only" { return .remote(task: task, reason: "policy-remote-only") }

        let known = table["tasks"]
        let usedDefault = !known.has(task)
        let resolvedTask = usedDefault ? table["default"].string(task) : task
        let spec = known[resolvedTask]

        let needCaps = spec["require_caps"].strings
        let features = caps["features"].strings
        let candidates = spec["prefer"].strings.filter { id in
            guard installed.contains(id) else { return false }
            guard let entry = entries[id] else { return false }
            // A required capability has to hold on BOTH sides: the build reports
            // it, and the entry declares it can use it. A model that never
            // claimed constrained decoding is not a candidate for a task that
            // needs it, however good it is at chatting.
            let declared = entry["requires"]["engine_caps"].strings
            if needCaps.contains(where: { !features.contains($0) || !declared.contains($0) }) {
                return false
            }
            guard let verdict = verdicts[id] else { return false }
            return Fit.meetsFloor(verdict.verdict, spec["min_verdict"].stringOrNull)
        }

        if let first = candidates.first {
            // Stickiness is real economics: a swap costs seconds and hundreds of
            // megabytes, so a resident model that satisfies the task wins. It
            // never overrides the capability filter or the verdict floor above -
            // cheapness does not beat correctness.
            if table["stickiness"]["prefer_loaded"].bool(),
               let loaded, candidates.contains(loaded) {
                return .local(task: task, model: loaded, reason: "sticky-loaded")
            }
            return .local(task: task, model: first,
                          reason: usedDefault ? "default-chain" : "preference-order")
        }

        if policy == "prefer-local" { return .remote(task: task, reason: "no-local-candidate") }
        // policy `local` never leaves the device, even with an endpoint
        // configured.
        return .unresolved(task: task, reason: "no_candidate")
    }
}
