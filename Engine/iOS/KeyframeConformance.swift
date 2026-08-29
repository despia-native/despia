//
//  KeyframeConformance.swift — the Swift runner for OpenSource/Conformance/motion/keyframes.json
//  (runtime-pressure R28). The third of three: TS runs it per-PR
//  (packages/kernel/test/keyframes-conformance.test.ts), Kotlin runs it under gradle
//  (:core KeyframeConformanceTest), and this runs it in the record lane.
//
//  THE REFERENCE IS THE BROWSER, and that is unusual enough to say plainly: the web renderer
//  never calls a DSX motion core, because a browser owns its own animations. Every expectation
//  in the corpus is what CSS itself does, and these three runners exist to prove the two native
//  lanes agree with it. That is the whole shape of R28 — `@keyframes` reached the generated
//  native sheets VERBATIM and both resolvers dropped it, so the DSX-CSS catalogue promised the
//  author motion on every target while two targets silently disagreed. A loop that runs at a
//  different rate, or an `alternate` that does not alternate, is not a crash and not a log line.
//
//  Pure Foundation, no SwiftUI — the record lane runs headless.
//
import Foundation

enum KeyframeConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    private static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(description: "motion/\(message)") }
    }

    private static func number(_ value: Any?) -> Double {
        (value as? NSNumber)?.doubleValue ?? 0
    }

    private static func strings(_ value: Any?) -> [String: String] {
        (value as? [String: Any] ?? [:]).mapValues { "\($0)" }
    }

    private static func rules(_ value: Any?) -> [(selector: String, declarations: [String: String])] {
        (value as? [[String: Any]] ?? []).map {
            ($0["selector"] as? String ?? "", strings($0["declarations"]))
        }
    }

    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure(description: "keyframes.json: not a JSON object")
        }
        try require((root["version"] as? NSNumber)?.intValue == 1, "keyframes.json: unsupported version")

        var checked = 0
        checked += try verifyParse(root)
        checked += try verifyNormalize(root)
        checked += try verifySample(root)
        checked += try verifySpec(root)
        checked += try verifyAttributes(root)
        try verifyInvariants(root)
        return checked
    }

    private static func verifyParse(_ root: [String: Any]) throws -> Int {
        let cases = root["parse"] as? [[String: Any]] ?? []
        try require(!cases.isEmpty, "keyframes.json: no parse group")
        for c in cases {
            let note = c["note"] as? String ?? ""
            let got = MotionCore.parseAnimation(c["shorthand"] as? String ?? "")
            let want = c["expect"] as? [String: Any] ?? [:]
            try require(got.name == (want["name"] as? String ?? ""), "\(note): name")
            try require(got.duration == number(want["duration"]), "\(note): duration")
            try require(got.delay == number(want["delay"]), "\(note): delay")
            try require(got.easing == (want["easing"] as? String ?? ""), "\(note): easing")
            try require(got.iterations == number(want["iterations"]), "\(note): iterations")
            try require(got.direction == (want["direction"] as? String ?? ""), "\(note): direction")
            try require(got.fill == (want["fill"] as? String ?? ""), "\(note): fill")
            try require(got.paused == (want["paused"] as? Bool ?? false), "\(note): paused")
            try require(got.none == (want["none"] as? Bool ?? false), "\(note): none")
        }
        return cases.count
    }

    private static func verifyNormalize(_ root: [String: Any]) throws -> Int {
        let cases = root["normalize"] as? [[String: Any]] ?? []
        try require(!cases.isEmpty, "keyframes.json: no normalize group")
        for c in cases {
            let name = c["name"] as? String ?? ""
            let got = MotionCore.keyframeTimeline(rules(c["rules"]))
            let want = c["expect"] as? [[String: Any]] ?? []
            try require(got.count == want.count, "\(name): stop count \(got.count) != \(want.count)")
            for (i, stop) in got.enumerated() {
                try require(stop.offset == number(want[i]["offset"]), "\(name): stop \(i) offset")
                try require(stop.declarations == strings(want[i]["declarations"]),
                            "\(name): stop \(i) declarations")
            }
        }
        return cases.count
    }

    private static func verifySample(_ root: [String: Any]) throws -> Int {
        var timelines: [String: [(selector: String, declarations: [String: String])]] = [:]
        for c in root["normalize"] as? [[String: Any]] ?? [] {
            timelines[c["name"] as? String ?? ""] = rules(c["rules"])
        }
        let cases = root["sample"] as? [[String: Any]] ?? []
        try require(!cases.isEmpty, "keyframes.json: no sample group")
        for c in cases {
            let note = c["note"] as? String ?? ""
            let key = c["timeline"] as? String ?? ""
            guard let source = timelines[key] else {
                throw Failure(description: "motion/\(key) is not a corpus timeline")
            }
            let spec = MotionCore.parseAnimation(c["shorthand"] as? String ?? "")
            let got = MotionCore.sampleMotion(
                MotionCore.keyframeTimeline(source), spec, number(c["elapsed"]),
            )
            let want = c["expect"] as? [String: Any] ?? [:]
            let where_ = "\(note) — \(key) \(c["shorthand"] ?? "") @\(number(c["elapsed"]))ms"
            try require(got.values == strings(want["values"]), "\(where_): values")
            try require(got.dropped == (want["dropped"] as? [String] ?? []), "\(where_): dropped")
            try require(got.active == (want["active"] as? Bool ?? false), "\(where_): active")
        }
        return cases.count
    }

    /// All nine `animation-*` properties sit in the DSX-CSS catalogue as Tier B, so all nine
    /// have to mean something or the catalogue is lying again, one layer down from the defect
    /// R28 exists to end. A longhand ALONE is a complete declaration.
    private static func verifySpec(_ root: [String: Any]) throws -> Int {
        let cases = root["spec"] as? [[String: Any]] ?? []
        try require(!cases.isEmpty, "keyframes.json: no spec group")
        for c in cases {
            let note = c["note"] as? String ?? ""
            let got = MotionCore.animationSpec(strings(c["attrs"]))
            let want = c["expect"] as? [String: Any] ?? [:]
            try require(got.name == (want["name"] as? String ?? ""), "\(note): name")
            try require(got.duration == number(want["duration"]), "\(note): duration")
            try require(got.delay == number(want["delay"]), "\(note): delay")
            try require(got.easing == (want["easing"] as? String ?? ""), "\(note): easing")
            try require(got.iterations == number(want["iterations"]), "\(note): iterations")
            try require(got.direction == (want["direction"] as? String ?? ""), "\(note): direction")
            try require(got.fill == (want["fill"] as? String ?? ""), "\(note): fill")
            try require(got.paused == (want["paused"] as? Bool ?? false), "\(note): paused")
            try require(got.none == (want["none"] as? Bool ?? false), "\(note): none")
        }
        return cases.count
    }

    /// The last mile: a sampled frame decomposed into the style attributes the SwiftUI ladder
    /// already applies. A `transform` that cannot decompose exactly is refused and reported
    /// rather than approximated, which is the same promise `dropped` makes one layer up.
    private static func verifyAttributes(_ root: [String: Any]) throws -> Int {
        let cases = root["attributes"] as? [[String: Any]] ?? []
        try require(!cases.isEmpty, "keyframes.json: no attributes group")
        for c in cases {
            let note = c["note"] as? String ?? ""
            let got = MotionCore.motionAttributes(strings(c["values"]))
            let want = c["expect"] as? [String: Any] ?? [:]
            try require(got.attributes == strings(want["attributes"]), "\(note): attributes")
            try require(got.unsupported == (want["unsupported"] as? [String] ?? []),
                        "\(note): unsupported")
        }
        return cases.count
    }

    /// The two facts a corpus row cannot state: that `infinite` is a NUMBER (JSON has no
    /// spelling for it), and that the property allowlist IS the promise — anything outside it is
    /// dropped rather than half-applied.
    private static func verifyInvariants(_ root: [String: Any]) throws {
        try require(MotionCore.infinite == -1, "infinite must be -1")
        try require(MotionCore.parseAnimation("x 1s infinite").iterations == MotionCore.infinite,
                    "`infinite` must parse to the sentinel")
        try require(MotionCore.properties == (root["animatable"] as? [String] ?? []),
                    "the animatable allowlist moved without a named reason")
        try require(MotionCore.animationKeys == (root["animationKeys"] as? [String] ?? []),
                    "the bridged `animation-*` attribute keys moved without a named reason")

        // A loop is periodic to the millisecond, which is what makes it a loop.
        let timeline = MotionCore.keyframeTimeline([
            ("0%, 80%, 100%", ["opacity": "0.28", "transform": "scale(0.82)"]),
            ("40%", ["opacity": "1", "transform": "scale(1)"]),
        ])
        let spec = MotionCore.parseAnimation("pulse 1.2s ease-in-out infinite")
        for t in [0.0, 137.0, 450.0, 900.0, 1199.0] {
            try require(
                MotionCore.sampleMotion(timeline, spec, t).values
                    == MotionCore.sampleMotion(timeline, spec, t + 1200).values,
                "t=\(t) and t+period disagree",
            )
            try require(MotionCore.sampleMotion(timeline, spec, t + 1_200_000).active,
                        "an infinite loop never ends")
        }
    }
}
