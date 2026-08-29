//
//  OrientationBindingConformance.swift — the Swift runner for
//  OpenSource/Conformance/input/orientation-binding.json (parity/F07-orientation.md §3a). The
//  third of three: TS runs it per-PR (packages/kernel/test/orientation-binding-conformance.test.ts),
//  Kotlin runs it under gradle (:core OrientationBindingConformanceTest), and this runs it in the
//  record lane (RecordMain.swift).
//
//  It drives the reconcile AND feeds the resulting plan into the real `OrientationClaimStack`, so
//  the two halves of `lockOrientation=` are pinned against each other: a plan that looks right
//  but leaves the stack holding a dead claim fails here rather than on a device that will not
//  rotate back.
//
//  Pure Foundation, no UIKit — the record lane runs headless.
//
import Foundation

enum OrientationBindingConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["version"] as? Int) == 1 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported version")
        }
        var count = try verifySurfaceIDs(root["surfaceIds"] as? [String: Any] ?? [:])
        count += try verifyReconcile(root["reconcile"] as? [[String: Any]] ?? [])
        guard count > 0 else { throw Failure(description: "\(corpusFile.lastPathComponent): no cases") }
        return count
    }

    private static func same<T: Equatable>(_ actual: T, _ expected: T, _ what: String) throws {
        guard actual == expected else {
            throw Failure(description: "\(what): expected \(expected), got \(actual)")
        }
    }

    private static func surfaces(_ raw: Any?) -> [StackOrientationBinding.Surface] {
        (raw as? [[String: Any]] ?? []).compactMap {
            guard let surface = $0["surface"] as? String, let to = $0["to"] as? String else { return nil }
            return StackOrientationBinding.Surface(surface: surface, to: to)
        }
    }

    private static func ops(_ raw: Any?) -> [StackOrientationBinding.Op] {
        (raw as? [[String: Any]] ?? []).compactMap {
            guard let op = $0["op"] as? String, let surface = $0["surface"] as? String else { return nil }
            return StackOrientationBinding.Op(op: op, surface: surface, to: $0["to"] as? String)
        }
    }

    private static func verifySurfaceIDs(_ ids: [String: Any]) throws -> Int {
        let frame = (ids["frame"] as? String ?? "").replacingOccurrences(of: "<frameId>", with: "4")
        let modal = (ids["modal"] as? String ?? "").replacingOccurrences(of: "<modalId>", with: "4")
        try same(StackOrientationBinding.frameSurface(4), frame, "frame surface id")
        try same(StackOrientationBinding.modalSurface(4), modal, "modal surface id")
        guard StackOrientationBinding.frameSurface(4) != StackOrientationBinding.modalSurface(4) else {
            throw Failure(description: "a frame and a presentation with the same id must not collide")
        }
        return 1
    }

    private static func verifyReconcile(_ cases: [[String: Any]]) throws -> Int {
        var count = 0
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            // the SHIPPED claim stack, driven by the plan — the two halves pinned against each other
            let stack = OrientationClaimStack()
            if let imperative = raw["imperative"] as? String {
                stack.claim(OrientationClaimStack.imperativeID, to: imperative)
            }
            var ledger: [StackOrientationBinding.Surface] = []

            for (index, step) in (raw["steps"] as? [[String: Any]] ?? []).enumerated() {
                let at = "\(name): publish \(index) (\(step["publish"] as? String ?? "?"))"
                let live = surfaces(step["live"])
                let plan = StackOrientationBinding.plan(live: live, claimed: ledger)
                try same(plan.ops, ops(step["expectOps"]), "\(at): ops")
                try same(plan.ledger, surfaces(step["expectLedger"]), "\(at): ledger")

                for op in plan.ops {
                    if op.op == "release" { stack.release(op.surface) }
                    else { stack.claim(op.surface, to: op.to ?? "") }
                }
                try same(stack.effective, step["expectEffective"] as? String, "\(at): the stack's effective lock")

                // the reconcile must be a FIXED POINT: re-running it against the same live set
                // changes nothing. That is the becomeActive re-assert, and the reason a merely
                // covered screen is safe.
                try same(StackOrientationBinding.plan(live: live, claimed: plan.ledger).ops, [],
                         "\(at): re-running the reconcile must be a no-op")
                ledger = plan.ledger
                count += 1
            }
        }
        return count
    }
}
