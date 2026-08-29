//
//  StackOrientationBinding.swift — the `lockOrientation=` ROUTER BINDING core: given the
//  surfaces the router just published and the ledger of what the router has already claimed,
//  which release/claim calls bring the shared `OrientationClaimStack` in line. The law is the
//  corpus, OpenSource/Conformance/input/orientation-binding.json (parity/F07-orientation.md
//  §3a); the Kotlin twin is :core StackOrientationBinding.kt and the web twin is
//  @despia/kernel's orientation-binding.ts.
//
//  WHY A RECONCILE AND NOT A PAIR OF CALLBACKS. `lockOrientation` leaks precisely where a screen
//  is dismissed by a gesture instead of a button, and an appear/disappear pair has to be correct
//  five separate times (button pop · edge-swipe back · modal drag-dismiss · deep-link stack
//  replacement · a backgrounded app returning). Deriving the claims from the LIVE SET collapses
//  all five into one funnel: the router publishes its stack, this fold says what changed, and a
//  path nobody thought about produces the same plan as one everybody did. It also fixes the bug
//  the callback shape ships by construction — SwiftUI calls `onDisappear` on a merely COVERED
//  screen, and a covered frame is still in the published stack.
//
//  The claim stack itself is StackOrientation.swift (already corpus-pinned); this file never
//  touches it. No UIKit import: pure, so the record lane can run it headless.
//
import Foundation

public enum StackOrientationBinding {

    /// One surface the router published that declares `lockOrientation`.
    public struct Surface: Equatable {
        /// the router's claim id — `frame:<id>` for a pushed frame, `modal:<id>` for a presentation
        public let surface: String
        /// the declared `to` word, unresolved: the module folds it against the allowed set
        public let to: String
        public init(surface: String, to: String) { self.surface = surface; self.to = to }
    }

    /// A release names only a surface; a claim carries the word to claim it with.
    public struct Op: Equatable {
        public let op: String
        public let surface: String
        public let to: String?
        public init(op: String, surface: String, to: String? = nil) {
            self.op = op; self.surface = surface; self.to = to
        }
    }

    public struct Plan: Equatable {
        public let ops: [Op]
        /// the router's ledger after the plan is applied — feed it back in on the next publish
        public let ledger: [Surface]
    }

    /// The claim id for a pushed route frame. One derivation on three renderers, so a frame and a
    /// presentation with the same numeric id can never collide in the shared stack.
    public static func frameSurface(_ frameId: Int) -> String { "frame:\(frameId)" }

    /// The claim id for a presented surface (sheet, cover or overlay).
    public static func modalSurface(_ modalId: Int) -> String { "modal:\(modalId)" }

    /// Reconcile the router's orientation claims against the surfaces it just published.
    ///
    /// Releases are emitted BEFORE claims, so an arriving surface is never buried under a
    /// departing one. A live surface whose `to` changed re-claims IN PLACE (`route.updateComponent`
    /// can rewrite the attribute under a screen that never left) rather than release-then-claim,
    /// which would send it to the top of the stack past a sheet it is already under. An unchanged
    /// live set produces an EMPTY plan, which is what makes the re-assert on `becomeActive`
    /// idempotent.
    ///
    /// The imperative slot (`orientation.lock()` / `unlock()`) is never named here: the router
    /// only ever releases surfaces it claimed itself, so the escape hatch survives every change.
    public static func plan(live: [Surface], claimed: [Surface]) -> Plan {
        let liveIDs = Set(live.map { $0.surface })
        var ops: [Op] = []

        for entry in claimed where !liveIDs.contains(entry.surface) {
            ops.append(Op(op: "release", surface: entry.surface))
        }
        var ledger = claimed.filter { liveIDs.contains($0.surface) }

        for entry in live {
            if let index = ledger.firstIndex(where: { $0.surface == entry.surface }) {
                if ledger[index].to != entry.to {
                    ops.append(Op(op: "claim", surface: entry.surface, to: entry.to))
                    ledger[index] = Surface(surface: entry.surface, to: entry.to)
                }
            } else {
                ops.append(Op(op: "claim", surface: entry.surface, to: entry.to))
                ledger.append(Surface(surface: entry.surface, to: entry.to))
            }
        }
        return Plan(ops: ops, ledger: ledger)
    }
}
