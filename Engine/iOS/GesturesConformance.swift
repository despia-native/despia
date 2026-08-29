//
//  GesturesConformance.swift - VERIFY MODE for the U02 gesture corpus.
//
//  Runs OpenSource/Conformance/input/gestures.json through the REAL Swift pure core
//  (StackGestures + StackPressTracker + StackHoverMotion + StackTransformTracker) and
//  throws on the first disagreement, so the reference renderer executes the same file as
//  the TS runner (@despia/dom gestures.test.ts) and the Kotlin twin
//  (GesturesConformanceTest). Recognition thresholds, velocity derivation, swipe
//  classification, transform accumulation, the gestureAxis claim and the composition
//  resolver therefore cannot drift between renderers.
//
//  Like ConformanceHosts.swift / JSEConformanceRecord.swift: NOT part of any app or
//  extension target - it compiles only in the Codemagic `conformance-record` lane,
//  alongside the rest of OpenSource/Engine, via RecordMain.swift. Foundation-only, pure
//  computation plus one file read.
//

import Foundation

enum GesturesConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Execute every section of the corpus. Returns the number of cases verified; an
    /// empty section is a failure, never a silent skip.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard (root["version"] as? NSNumber)?.intValue == 1 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported version")
        }
        guard let constants = root["constants"] as? [String: Any] else {
            throw Failure(description: "gestures.json: no constants{}")
        }
        let tolerance = num(constants["tolerance"]) ?? 1e-9

        var count = 0
        try verifyConstants(constants)
        count += try verifyVelocity(section(root, "velocity"), tolerance: tolerance)
        count += try verifyVelocity2D(section(root, "velocity2D"), tolerance: tolerance)
        count += try verifyPress(section(root, "press"))
        count += try verifyHover(section(root, "hover"), tolerance: tolerance)
        count += try verifySwipe(section(root, "swipe"), tolerance: tolerance)
        count += try verifyAxisClaim(section(root, "axisClaim"))
        count += try verifyTransform(section(root, "transform"), tolerance: tolerance)
        count += try verifyDrag(section(root, "drag"), tolerance: tolerance)
        count += try verifyComposition(section(root, "composition"))
        count += try verifyDegradation(root)
        return count
    }

    // MARK: - helpers

    private static func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

    private static func number(_ v: Any?, _ label: String) throws -> Double {
        guard let d = num(v) else { throw Failure(description: "\(label): not a number") }
        return d
    }

    private static func section(_ root: [String: Any], _ name: String) -> (String, [[String: Any]]) {
        let block = root[name] as? [String: Any]
        return (name, (block?["cases"] as? [[String: Any]]) ?? [])
    }

    private static func close(_ actual: Double, _ expected: Any?, _ tolerance: Double, _ label: String) throws {
        let want = try number(expected, label)
        guard actual.isFinite else { throw Failure(description: "\(label): \(actual) is not finite") }
        guard abs(actual - want) <= tolerance else {
            throw Failure(description: "\(label): \(actual) != \(want)")
        }
    }

    private static func cases(_ input: (String, [[String: Any]])) throws -> [[String: Any]] {
        guard !input.1.isEmpty else { throw Failure(description: "\(input.0): empty corpus section") }
        return input.1
    }

    private static func samples1D(_ raw: Any?) -> [StackGestures.Sample1D] {
        ((raw as? [[String: Any]]) ?? []).map {
            StackGestures.Sample1D(t: num($0["t"]) ?? 0, value: num($0["value"]) ?? 0)
        }
    }

    private static func samples2D(_ raw: Any?) -> [StackGestures.Sample2D] {
        ((raw as? [[String: Any]]) ?? []).map {
            StackGestures.Sample2D(t: num($0["t"]) ?? 0, x: num($0["x"]) ?? 0, y: num($0["y"]) ?? 0)
        }
    }

    // MARK: - sections

    private static func verifyConstants(_ constants: [String: Any]) throws {
        let pairs: [(String, Double, Double)] = [
            ("tapSlop", StackGestures.tapSlop, num(constants["tapSlop"]) ?? .nan),
            ("axisSlop", StackGestures.axisSlop, num(constants["axisSlop"]) ?? .nan),
            ("swipeMinDistance", StackGestures.swipeMinDistance, num(constants["swipeMinDistance"]) ?? .nan),
            ("swipeMinVelocity", StackGestures.swipeMinVelocity, num(constants["swipeMinVelocity"]) ?? .nan),
            ("velocityWindowMs", StackGestures.velocityWindowMs, num(constants["velocityWindowMs"]) ?? .nan),
            ("velocitySamples", Double(StackGestures.velocitySamples), num(constants["velocitySamples"]) ?? .nan),
            ("pinchSlop", StackGestures.pinchSlop, num(constants["pinchSlop"]) ?? .nan),
            ("rotateSlop", StackGestures.rotateSlop, num(constants["rotateSlop"]) ?? .nan),
        ]
        for (name, mine, theirs) in pairs where mine != theirs {
            throw Failure(description: "gestures/constants: \(name) \(mine) != corpus \(theirs)")
        }
        guard (constants["precedence"] as? [String]) == StackGestures.precedence else {
            throw Failure(description: "gestures/constants: precedence drifted from the corpus")
        }
        guard (constants["continuous"] as? [String]) == StackGestures.continuous.sorted() else {
            throw Failure(description: "gestures/constants: continuous drifted from the corpus")
        }
        guard (constants["directional"] as? [String]) == StackGestures.directional.sorted() else {
            throw Failure(description: "gestures/constants: directional drifted from the corpus")
        }
    }

    private static func verifyVelocity(_ input: (String, [[String: Any]]), tolerance: Double) throws -> Int {
        let list = try cases(input)
        for c in list {
            let name = c["name"] as? String ?? "?"
            try close(StackGestures.velocity1D(samples1D(c["samples"])), c["expect"], tolerance, "velocity/\(name)")
        }
        return list.count
    }

    private static func verifyVelocity2D(_ input: (String, [[String: Any]]), tolerance: Double) throws -> Int {
        let list = try cases(input)
        for c in list {
            let name = c["name"] as? String ?? "?"
            let got = StackGestures.velocity2D(samples2D(c["samples"]))
            guard let expect = c["expect"] as? [String: Any] else {
                throw Failure(description: "velocity2D/\(name): no expect{}")
            }
            try close(got.vx, expect["vx"], tolerance, "velocity2D/\(name) vx")
            try close(got.vy, expect["vy"], tolerance, "velocity2D/\(name) vy")
        }
        return list.count
    }

    private static func verifyPress(_ input: (String, [[String: Any]])) throws -> Int {
        let list = try cases(input)
        for c in list {
            let name = c["name"] as? String ?? "?"
            var tracker = StackPressTracker()
            var actions: [String] = []
            for event in c["events"] as? [[String: Any]] ?? [] {
                let id = event["id"] as? String ?? "p1"
                let x = num(event["x"]) ?? 0
                let y = num(event["y"]) ?? 0
                switch event["type"] as? String {
                case "down": actions += tracker.down(pointer: id, x: x, y: y)
                case "move": actions += tracker.move(pointer: id, x: x, y: y)
                case "up": actions += tracker.up(pointer: id, x: x, y: y)
                case "cancel": actions += tracker.cancel(pointer: id)
                case "unmount": actions += tracker.unmount()
                default:
                    throw Failure(description: "press/\(name): unknown event \(String(describing: event["type"]))")
                }
            }
            let expected = c["expect"] as? [String] ?? []
            guard actions == expected else {
                throw Failure(description: "press/\(name): \(actions) (expected \(expected))")
            }
            let dragging = c["expectDragging"] as? Bool ?? false
            guard tracker.dragging == dragging else {
                throw Failure(description: "press/\(name): dragging \(tracker.dragging) (expected \(dragging))")
            }
        }
        return list.count
    }

    private static func verifyHover(_ input: (String, [[String: Any]]), tolerance: Double) throws -> Int {
        let list = try cases(input)
        for c in list {
            let name = c["name"] as? String ?? "?"
            var motion = StackHoverMotion()
            var emitted: [StackHoverMotion.Emission] = []
            for event in c["events"] as? [[String: Any]] ?? [] {
                let x = num(event["x"]) ?? 0
                let y = num(event["y"]) ?? 0
                switch event["type"] as? String {
                case "enter": emitted += motion.enter(hoverCapable: event["hoverCapable"] as? Bool ?? false, x: x, y: y)
                case "move": emitted += motion.move(x: x, y: y)
                case "leave": emitted += motion.leave(x: x, y: y)
                case "unmount": emitted += motion.unmount()
                default:
                    throw Failure(description: "hover/\(name): unknown event \(String(describing: event["type"]))")
                }
            }
            let expected = c["expect"] as? [[String: Any]] ?? []
            guard emitted.count == expected.count else {
                throw Failure(description: "hover/\(name): \(emitted.count) emission(s) (expected \(expected.count))")
            }
            for (i, want) in expected.enumerated() {
                guard emitted[i].action == want["action"] as? String else {
                    throw Failure(description: "hover/\(name)[\(i)]: action \(emitted[i].action)")
                }
                try close(emitted[i].x, want["x"], tolerance, "hover/\(name)[\(i)] x")
                try close(emitted[i].y, want["y"], tolerance, "hover/\(name)[\(i)] y")
            }
        }
        return list.count
    }

    private static func verifySwipe(_ input: (String, [[String: Any]]), tolerance: Double) throws -> Int {
        let list = try cases(input)
        for c in list {
            let name = c["name"] as? String ?? "?"
            let got = StackGestures.resolveSwipe(
                dx: try number(c["dx"], "swipe/\(name) dx"),
                dy: try number(c["dy"], "swipe/\(name) dy"),
                vx: try number(c["vx"], "swipe/\(name) vx"),
                vy: try number(c["vy"], "swipe/\(name) vy"),
                axis: c["axis"] as? String ?? "both"
            )
            guard let expect = c["expect"] as? [String: Any] else {
                if got != nil { throw Failure(description: "swipe/\(name): recognized a non-swipe") }
                continue
            }
            guard let swipe = got else { throw Failure(description: "swipe/\(name): missed a swipe") }
            guard swipe.direction == expect["direction"] as? String else {
                throw Failure(description: "swipe/\(name): direction \(swipe.direction)")
            }
            try close(swipe.velocity, expect["velocity"], tolerance, "swipe/\(name) velocity")
            try close(swipe.distance, expect["distance"], tolerance, "swipe/\(name) distance")
        }
        return list.count
    }

    private static func verifyAxisClaim(_ input: (String, [[String: Any]])) throws -> Int {
        let list = try cases(input)
        for c in list {
            let name = c["name"] as? String ?? "?"
            let got = StackGestures.claimAxis(c["axis"] as? String ?? "both",
                                              dx: try number(c["dx"], "axisClaim/\(name) dx"),
                                              dy: try number(c["dy"], "axisClaim/\(name) dy"))
            guard got == c["expect"] as? String else {
                throw Failure(description: "axisClaim/\(name): \(got) (expected \(String(describing: c["expect"])))")
            }
        }
        return list.count
    }

    private static func verifyTransform(_ input: (String, [[String: Any]]), tolerance: Double) throws -> Int {
        let list = try cases(input)
        for c in list {
            let name = c["name"] as? String ?? "?"
            var tracker = StackTransformTracker()
            var emitted: [StackTransformTracker.Emission] = []
            for event in c["events"] as? [[String: Any]] ?? [] {
                if event["type"] as? String == "cancel" {
                    emitted += tracker.cancel()
                    continue
                }
                let points = (event["points"] as? [[String: Any]] ?? []).map {
                    StackGestures.Point(id: $0["id"] as? String ?? "", x: num($0["x"]) ?? 0, y: num($0["y"]) ?? 0)
                }
                emitted += tracker.update(t: num(event["t"]) ?? 0, points: points)
            }
            let expected = c["expect"] as? [[String: Any]] ?? []
            guard emitted.count == expected.count else {
                throw Failure(description: "transform/\(name): \(emitted.count) emission(s) (expected \(expected.count))")
            }
            for (i, want) in expected.enumerated() {
                let got = emitted[i]
                guard got.phase == want["phase"] as? String else {
                    throw Failure(description: "transform/\(name)[\(i)]: phase \(got.phase)")
                }
                try close(got.scale, want["scale"], tolerance, "transform/\(name)[\(i)] scale")
                try close(got.rotation, want["rotation"], tolerance, "transform/\(name)[\(i)] rotation")
                try close(got.focusX, want["focusX"], tolerance, "transform/\(name)[\(i)] focusX")
                try close(got.focusY, want["focusY"], tolerance, "transform/\(name)[\(i)] focusY")
                try close(got.scaleVelocity, want["scaleVelocity"], tolerance, "transform/\(name)[\(i)] scaleVelocity")
                try close(got.rotationVelocity, want["rotationVelocity"], tolerance,
                          "transform/\(name)[\(i)] rotationVelocity")
            }
        }
        return list.count
    }

    private static func verifyDrag(_ input: (String, [[String: Any]]), tolerance: Double) throws -> Int {
        let list = try cases(input)
        for c in list {
            let name = c["name"] as? String ?? "?"
            let got = StackGestures.dragPayload(
                width: try number(c["width"], "drag/\(name) width"),
                height: try number(c["height"], "drag/\(name) height"),
                x: try number(c["x"], "drag/\(name) x"),
                y: try number(c["y"], "drag/\(name) y"),
                startX: try number(c["startX"], "drag/\(name) startX"),
                startY: try number(c["startY"], "drag/\(name) startY"),
                samples: samples2D(c["samples"]),
                phase: c["phase"] as? String ?? "move"
            )
            guard let expect = c["expect"] as? [String: Any] else {
                throw Failure(description: "drag/\(name): no expect{}")
            }
            guard Set(got.keys) == Set(expect.keys) else {
                throw Failure(description: "drag/\(name): payload keys \(got.keys.sorted()) != \(expect.keys.sorted())")
            }
            for (key, want) in expect {
                if let text = want as? String {
                    guard got[key] as? String == text else {
                        throw Failure(description: "drag/\(name) \(key): \(String(describing: got[key]))")
                    }
                } else {
                    try close(got[key] as? Double ?? .nan, want, tolerance, "drag/\(name) \(key)")
                }
            }
        }
        return list.count
    }

    private static func verifyComposition(_ input: (String, [[String: Any]])) throws -> Int {
        let list = try cases(input)
        for c in list {
            let name = c["name"] as? String ?? "?"
            let tree = (c["tree"] as? [[String: Any]] ?? []).map {
                StackGestures.Node(id: $0["id"] as? String ?? "",
                                   recognizers: $0["recognizers"] as? [String] ?? [],
                                   gesture: $0["gesture"] as? String ?? "exclusive",
                                   axis: $0["axis"] as? String ?? "both")
            }
            guard let raw = c["attempt"] as? [String: Any] else {
                throw Failure(description: "composition/\(name): no attempt{}")
            }
            let attempt = StackGestures.Attempt(kinds: Set(raw["kinds"] as? [String] ?? []),
                                                axis: raw["axis"] as? String ?? "none",
                                                claimedBy: raw["claimedBy"] as? String)
            let got = StackGestures.resolveComposition(tree: tree, attempt: attempt)
            guard let expect = c["expect"] as? [String: Any] else {
                throw Failure(description: "composition/\(name): no expect{}")
            }
            let wantFire = (expect["fire"] as? [[String: Any]] ?? []).map {
                StackGestures.Fired(node: $0["node"] as? String ?? "", kind: $0["kind"] as? String ?? "")
            }
            let wantBlocked = (expect["blocked"] as? [[String: Any]] ?? []).map {
                StackGestures.Blocked(node: $0["node"] as? String ?? "",
                                      kind: $0["kind"] as? String ?? "",
                                      reason: $0["reason"] as? String ?? "")
            }
            guard got.fire == wantFire else {
                throw Failure(description: "composition/\(name): fire \(got.fire) (expected \(wantFire))")
            }
            guard got.blocked == wantBlocked else {
                throw Failure(description: "composition/\(name): blocked \(got.blocked) (expected \(wantBlocked))")
            }
        }
        return list.count
    }

    private static func verifyDegradation(_ root: [String: Any]) throws -> Int {
        let rows = (root["degradation"] as? [String: Any])?["rows"] as? [[String: Any]] ?? []
        guard !rows.isEmpty else { throw Failure(description: "degradation: empty corpus section") }
        guard rows.count == StackGestures.degradation.count else {
            throw Failure(description: "degradation: \(StackGestures.degradation.count) row(s) != corpus \(rows.count)")
        }
        for (i, want) in rows.enumerated() {
            let got = StackGestures.degradation[i]
            for key in ["gesture", "requires", "whenAbsent", "alternative"] {
                guard got[key] == want[key] as? String else {
                    throw Failure(description: "degradation[\(i)] \(key): \(String(describing: got[key]))")
                }
            }
            guard got["whenAbsent"] == "never-fires" else {
                throw Failure(description: "degradation[\(i)]: a gesture never fakes its input")
            }
            guard !(got["alternative"] ?? "").isEmpty else {
                throw Failure(description: "degradation[\(i)]: needs a reachable alternative")
            }
        }
        return rows.count
    }
}
