//
//  FontsConformance.swift — the Swift runner for OpenSource/Conformance/fonts/matching.json
//  (parity/F01-fonts.md §6). The third of three: TS runs it per-PR
//  (packages/kernel/test/fonts-conformance.test.ts), Kotlin runs it under gradle
//  (:core FontsConformanceTest), and this runs it in the record lane.
//
//  It exists because the font face-selection law is the one place where "close enough" is
//  invisible until a customer sees it: a heading that comes out semibold on iOS and bold on
//  Android is not a crash, not a log line, and not something a screenshot diff of one platform
//  catches. Same file, three runners, no drift.
//
//  Pure Foundation, no UIKit — the record lane runs headless.
//
import Foundation

enum FontsConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run every section of matching.json through the shared `StackFonts` core.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["version"] as? Int) == 1 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported version")
        }
        var count = 0
        count += try verifyMatching(root["matching"] as? [[String: Any]] ?? [])
        count += try verifyItalic(root["italic"] as? [[String: Any]] ?? [])
        count += try verifyVariation(root["variation"] as? [[String: Any]] ?? [])
        count += try verifyParse(root["parse"] as? [[String: Any]] ?? [])
        count += try verifyFeatures(root["features"] as? [[String: Any]] ?? [])
        guard count > 0 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases")
        }
        return count
    }

    private static func verifyMatching(_ cases: [[String: Any]]) throws -> Int {
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let available = (raw["faces"] as? [Int]) ?? []
            let desired = raw["request"] as? Int ?? 400
            let got = StackFonts.matchWeight(available, desired: desired)
            let expect = raw["expect"] as? Int
            guard got == expect else {
                throw Failure(description: "fonts/matching/\(name): \(String(describing: got)) (expected \(String(describing: expect)))")
            }
        }
        return cases.count
    }

    private static func verifyItalic(_ cases: [[String: Any]]) throws -> Int {
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let faces = ((raw["faces"] as? [[String: Any]]) ?? []).map {
                StackFonts.Face(weight: $0["w"] as? Int ?? 400, italic: $0["i"] as? Bool ?? false)
            }
            let request = raw["request"] as? [String: Any] ?? [:]
            let got = StackFonts.selectFace(faces,
                                            weight: request["w"] as? Int ?? 400,
                                            italic: request["i"] as? Bool ?? false)
            guard let expect = raw["expect"] as? [String: Any] else {
                guard got == nil else { throw Failure(description: "fonts/italic/\(name): expected no face") }
                continue
            }
            guard let got else {
                throw Failure(description: "fonts/italic/\(name): resolved no face, corpus expects one")
            }
            guard got.face.weight == expect["w"] as? Int,
                  got.face.italic == expect["i"] as? Bool,
                  got.synthesized == expect["synthesized"] as? Bool else {
                throw Failure(description: "fonts/italic/\(name): \(got.face.weight)/\(got.face.italic)/\(got.synthesized) disagrees with the corpus")
            }
        }
        return cases.count
    }

    private static func verifyVariation(_ cases: [[String: Any]]) throws -> Int {
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            var declared: [String: (Double, Double)]?
            if let axes = raw["axes"] as? [String: [Double]] {
                declared = axes.compactMapValues { $0.count == 2 ? ($0[0], $0[1]) : nil }
            }
            let requested = (raw["request"] as? [String: Double]) ?? [:]
            let resolved = StackFonts.resolveVariation(declared: declared, requested: requested)
            let expect = raw["expect"] as? [String: Any] ?? [:]
            let wantApplied = (expect["applied"] as? [String: Double]) ?? [:]
            guard resolved.applied == wantApplied else {
                throw Failure(description: "fonts/variation/\(name): applied \(resolved.applied) (expected \(wantApplied))")
            }
            // `clamped`/`dropped` are asserted only where the corpus states them: a case that
            // pins one report is not implicitly pinning the other empty.
            if let clamped = expect["clamped"] as? [String], resolved.clamped != clamped {
                throw Failure(description: "fonts/variation/\(name): clamped \(resolved.clamped) (expected \(clamped))")
            }
            if let dropped = expect["dropped"] as? [String], resolved.dropped != dropped {
                throw Failure(description: "fonts/variation/\(name): dropped \(resolved.dropped) (expected \(dropped))")
            }
        }
        return cases.count
    }

    private static func verifyParse(_ cases: [[String: Any]]) throws -> Int {
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let got = StackFonts.parseVariation(raw["input"] as? String)
            let expect = (raw["expect"] as? [String: Double]) ?? [:]
            guard got == expect else {
                throw Failure(description: "fonts/parse/\(name): \(got) (expected \(expect))")
            }
        }
        return cases.count
    }

    private static func verifyFeatures(_ cases: [[String: Any]]) throws -> Int {
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let got = StackFonts.parseFeatures(raw["input"] as? String)
            let expect = (raw["expect"] as? [String]) ?? []
            guard got == expect else {
                throw Failure(description: "fonts/features/\(name): \(got) (expected \(expect))")
            }
        }
        return cases.count
    }
}
