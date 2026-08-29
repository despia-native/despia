//
//  SharedTransitionConformance.swift — the Swift runner for
//  OpenSource/Conformance/router/shared.json (parity/U03-shared-transitions.md §6). The third
//  of three: TS runs it per-PR (packages/kernel/test/shared-transition-conformance.test.ts),
//  Kotlin runs it under gradle (:core SharedTransitionConformanceTest), and this runs it in the
//  record lane (RecordMain.swift).
//
//  It exists because the shared-element contract is the kind that looks fine in a screenshot and
//  wrong in the hand: which ids pair, where the pair is at 40% of the flight, and — the case the
//  whole feature is judged on — what happens when a back-swipe interrupts a push mid-air. None
//  of those is visible to a single-platform diff.
//
//  Pure Foundation, no UIKit — the record lane runs headless.
//
import Foundation

enum SharedTransitionConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    private static let tolerance = 1e-6

    /// Run every section of shared.json through the shared `StackSharedTransition` core.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["version"] as? Int) == 1 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported version")
        }
        var count = 0
        count += try verifyConstants(root)
        count += try verifyMatch(root["match"] as? [[String: Any]] ?? [])
        count += try verifyInterpolate(root["interpolate"] as? [[String: Any]] ?? [])
        count += try verifyMachine(root["machine"] as? [[String: Any]] ?? [])
        guard count > 0 else { throw Failure(description: "\(corpusFile.lastPathComponent): no cases") }
        return count
    }

    // MARK: - reading the corpus

    private static func number(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? .nan }

    private static func element(_ raw: [String: Any]) throws -> StackSharedTransition.Element {
        guard let id = raw["id"] as? String, let frame = raw["frame"] as? [String: Any] else {
            throw Failure(description: "shared.json: an element without an id or a frame")
        }
        return StackSharedTransition.Element(
            id: id,
            frame: StackSharedTransition.Rect(x: number(frame["x"]), y: number(frame["y"]),
                                              width: number(frame["width"]), height: number(frame["height"])),
            radius: (raw["radius"] as? NSNumber)?.doubleValue ?? 0,
            opacity: (raw["opacity"] as? NSNumber)?.doubleValue ?? 1,
            contentMode: raw["contentMode"] as? String ?? "fill",
            laid: raw["laid"] as? Bool ?? true,
            order: (raw["order"] as? NSNumber)?.intValue,
            mode: raw["mode"] as? String,
            anim: raw["anim"] as? String)
    }

    private static func geometry(_ raw: [String: Any]) -> StackSharedTransition.Geometry {
        StackSharedTransition.Geometry(x: number(raw["x"]), y: number(raw["y"]),
                                       width: number(raw["width"]), height: number(raw["height"]),
                                       radius: number(raw["radius"]), opacity: number(raw["opacity"]),
                                       contentMode: raw["contentMode"] as? String ?? "fill")
    }

    private static func near(_ actual: Double, _ expected: Double, _ what: String) throws {
        guard abs(actual - expected) <= tolerance else {
            throw Failure(description: "\(what): expected \(expected), got \(actual)")
        }
    }

    private static func same<T: Equatable>(_ actual: T, _ expected: T, _ what: String) throws {
        guard actual == expected else {
            throw Failure(description: "\(what): expected \(expected), got \(actual)")
        }
    }

    // MARK: - the sections

    private static func verifyConstants(_ root: [String: Any]) throws -> Int {
        try same(StackSharedTransition.modes, (root["modes"] as? [String]) ?? [], "modes")
        try near(StackSharedTransition.handoffStart, number(root["handoffStart"]), "handoffStart")
        let a11y = root["a11y"] as? [String: Any] ?? [:]
        try same(StackSharedTransition.a11yFocusTarget, a11y["focus"] as? String ?? "", "a11y focus target")
        try same(StackSharedTransition.a11yFocusAt, a11y["at"] as? String ?? "", "a11y focus timing")
        try near(tolerance, number(root["tolerance"]), "tolerance")
        return 1
    }

    private static func verifyMatch(_ cases: [[String: Any]]) throws -> Int {
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let source = try (raw["source"] as? [[String: Any]] ?? []).map(element)
            let destination = try (raw["destination"] as? [[String: Any]] ?? []).map(element)
            let actual = StackSharedTransition.match(source: source, destination: destination,
                                                     reducedMotion: raw["reducedMotion"] as? Bool ?? false,
                                                     frameAnim: raw["frameAnim"] as? String)
            let expect = raw["expect"] as? [String: Any] ?? [:]
            let wanted = expect["pairs"] as? [[String: Any]] ?? []
            try same(actual.pairs.count, wanted.count, "\(name): pair count")

            for (index, got) in actual.pairs.enumerated() {
                let want = wanted[index]
                let at = "\(name): pair \(index)"
                try same(got.id, want["id"] as? String ?? "",
                         "\(at): id (order is sharedOrder then destination document order)")
                try same(got.order, (want["order"] as? NSNumber)?.intValue ?? 0, "\(at): order")
                try same(got.mode, want["mode"] as? String ?? "", "\(at): mode")
                try same(got.anim, want["anim"] as? String, "\(at): anim")
                try same(got.deferred, want["deferred"] as? Bool ?? false, "\(at): deferred")
                for (label, ends) in [("from", (got.from, geometry(want["from"] as? [String: Any] ?? [:]))),
                                      ("to", (got.to, geometry(want["to"] as? [String: Any] ?? [:])))] {
                    try near(ends.0.x, ends.1.x, "\(at): \(label).x")
                    try near(ends.0.y, ends.1.y, "\(at): \(label).y")
                    try near(ends.0.width, ends.1.width, "\(at): \(label).width")
                    try near(ends.0.height, ends.1.height, "\(at): \(label).height")
                    try near(ends.0.radius, ends.1.radius, "\(at): \(label).radius")
                    try near(ends.0.opacity, ends.1.opacity, "\(at): \(label).opacity")
                    try same(ends.0.contentMode, ends.1.contentMode, "\(at): \(label).contentMode")
                }
                if got.deferred, got.to.width <= 0 || got.to.height <= 0 {
                    throw Failure(description: "\(at): an unrealised destination must never produce a zero rect")
                }
            }
            try same(actual.unmatchedSource, expect["unmatchedSource"] as? [String] ?? [], "\(name): unmatchedSource")
            try same(actual.unmatchedDestination, expect["unmatchedDestination"] as? [String] ?? [],
                     "\(name): unmatchedDestination")
            try same(actual.duplicates, expect["duplicates"] as? [String] ?? [], "\(name): duplicates")
        }
        return cases.count
    }

    private static func verifyInterpolate(_ cases: [[String: Any]]) throws -> Int {
        var count = 0
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let p = raw["pair"] as? [String: Any] ?? [:]
            let pair = StackSharedTransition.Pair(id: p["id"] as? String ?? "",
                                                  order: (p["order"] as? NSNumber)?.intValue ?? 0,
                                                  mode: p["mode"] as? String ?? "move",
                                                  anim: p["anim"] as? String,
                                                  deferred: p["deferred"] as? Bool ?? false,
                                                  from: geometry(p["from"] as? [String: Any] ?? [:]),
                                                  to: geometry(p["to"] as? [String: Any] ?? [:]))
            for step in raw["samples"] as? [[String: Any]] ?? [] {
                let progress = number(step["progress"])
                let expect = step["expect"] as? [String: Any] ?? [:]
                let got = StackSharedTransition.sample(pair, progress: progress)
                let at = "\(name) @ \(progress)"
                try near(got.x, number(expect["x"]), "\(at): x")
                try near(got.y, number(expect["y"]), "\(at): y")
                try near(got.width, number(expect["width"]), "\(at): width")
                try near(got.height, number(expect["height"]), "\(at): height")
                try near(got.radius, number(expect["radius"]), "\(at): radius")
                try near(got.alpha, number(expect["alpha"]), "\(at): alpha")
                try near(got.sourceOpacity, number(expect["sourceOpacity"]), "\(at): sourceOpacity")
                try near(got.destinationOpacity, number(expect["destinationOpacity"]), "\(at): destinationOpacity")
                try same(got.contentMode, expect["contentMode"] as? String ?? "", "\(at): contentMode")
                try same(got.scaleContent, expect["scaleContent"] as? Bool ?? true, "\(at): scaleContent")
                count += 1
            }
        }
        return count
    }

    private static func verifyMachine(_ cases: [[String: Any]]) throws -> Int {
        var count = 0
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let machine = SharedTransitionMachine()
            var previous = machine.snapshot().progress
            var maxStep: Double?
            var gesture = false

            for (index, step) in (raw["steps"] as? [[String: Any]] ?? []).enumerated() {
                let event = step["event"] as? [String: Any] ?? [:]
                let at = "\(name): step \(index)"
                let got: StackSharedTransition.Snapshot
                if let begin = event["begin"] as? String {
                    got = machine.begin(begin == "forward" ? .forward : .reverse)
                } else if let tick = event["tick"] as? NSNumber {
                    got = machine.tick(tick.doubleValue)
                } else if let interrupt = event["interrupt"] as? NSNumber {
                    got = machine.interrupt(at: interrupt.doubleValue)
                } else if let drag = event["drag"] as? NSNumber {
                    got = machine.drag(to: drag.doubleValue)
                } else if let release = event["release"] as? String {
                    got = machine.release(commit: release == "commit")
                } else if event["settle"] != nil {
                    got = machine.settle()
                } else {
                    throw Failure(description: "\(at) names no event")
                }

                let expect = step["expect"] as? [String: Any] ?? [:]
                try same(got.state.rawValue, expect["state"] as? String ?? "", "\(at): state")
                try same(got.direction.rawValue, expect["direction"] as? String ?? "", "\(at): direction")
                try near(got.progress, number(expect["progress"]), "\(at): progress")
                try near(got.target, number(expect["target"]), "\(at): target")
                try near(got.remaining, number(expect["remaining"]), "\(at): remaining")
                try same(got.outcome?.rawValue, expect["outcome"] as? String, "\(at): outcome")
                // the snapshot must be a READ, not a mutation — asking twice cannot move the machine
                try same(machine.snapshot(), got, "\(at): snapshot is stable")

                // THE GESTURE WINDOW: from the interrupt that hands the transition to the finger
                // through the release that gives it back. Progress inside it may only move as far
                // as the finger did — a snap is a jump of the whole remaining distance.
                let delta = abs(got.progress - previous)
                if event["interrupt"] != nil {
                    maxStep = gesture ? max(maxStep ?? 0, delta) : delta
                    gesture = true
                    guard delta <= tolerance else {
                        throw Failure(description: "\(at): an interruption must ADOPT the transition at its current progress, not restart or snap it (progress moved \(delta))")
                    }
                } else if gesture {
                    maxStep = max(maxStep ?? 0, delta)
                    if event["release"] != nil { gesture = false }
                }
                previous = got.progress
                count += 1
            }

            if let pinned = (raw["maxStep"] as? NSNumber)?.doubleValue {
                guard let worst = maxStep else {
                    throw Failure(description: "\(name): maxStep is pinned but no gesture ran")
                }
                guard worst <= pinned + tolerance else {
                    throw Failure(description: "\(name): the transition SNAPPED — largest single-step progress delta was \(worst), the corpus allows \(pinned)")
                }
            }
        }
        return count
    }
}
