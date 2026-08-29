//
//  StyleOverridesConformance.swift - the style-override corpus runner (the Swift twin
//  of packages/kernel/test/style-overrides-conformance.test.ts and :core
//  StyleOverridesConformanceTest). Executes the `split` and `resolve` sections of
//  OpenSource/Conformance/overrides/style-overrides.json against StyleOverrides.swift.
//
//  APPLE-FREE ON PURPOSE (Foundation + JSONSerialization only): this file runs per-PR
//  on the Linux lane through swift_conformance_run_test.rb, beside the record lane.
//  The corpus's `read` section needs the real JSE evaluator, so its Swift runner lives
//  in ConformanceHosts.swift (StyleOverridesReadConformance) and rides the record lane
//  with the rest of the engine-coupled hosts.
//

import Foundation

enum StyleOverridesConformance {
    struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ text: String) { description = text }
    }

    private static func doc(_ corpusFile: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure("style-overrides.json: not a JSON object")
        }
        return doc
    }

    private static func decl(_ map: [String: Any]) -> OverrideDecl {
        OverrideDecl(name: (map["as"] as? String) ?? "x",
                     type: map["type"] as? String,
                     default: map["default"] as? String,
                     options: map["options"] as? String,
                     min: map["min"],
                     max: map["max"])
    }

    /// TRUE booleans only — on Linux corelibs a JSON 0/1 NSNumber answers `as? Bool`,
    /// so the type identity is the discriminator (the same rule the core applies).
    private static func isBooleanValue(_ v: Any) -> Bool {
        if type(of: v) == Bool.self { return true }
        let t = String(describing: type(of: v))
        return t == "__NSCFBoolean" || t == "NSCFBoolean" || t == "Boolean"
    }

    /// Numbers compare numerically (Double vs Int vs NSNumber spellings), null as null.
    private static func numeric(_ v: Any?) -> Double? {
        guard let v = v, !isBooleanValue(v) else { return nil }
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let i = v as? Int64 { return Double(i) }
        if let f = v as? Float { return Double(f) }
        if let n = v as? NSNumber { return n.doubleValue }
        return nil
    }

    private static func matches(_ got: Any?, _ expect: Any?) -> Bool {
        let g: Any? = (got is NSNull) ? nil : got
        let e: Any? = (expect is NSNull) ? nil : expect
        if g == nil && e == nil { return true }
        guard let g = g, let e = e else { return false }
        if isBooleanValue(g) || isBooleanValue(e) {
            return isBooleanValue(g) && isBooleanValue(e) && (g as? Bool) == (e as? Bool)
        }
        if let gs = g as? String, let es = e as? String { return gs == es }
        if let gn = numeric(g), let en = numeric(e) { return gn == en }
        return false
    }

    /// The per-PR verify: the split fold + the typed fail-open resolve, every case.
    static func verify(corpusFile: URL) throws -> Int {
        let root = try doc(corpusFile)
        let reserved = Set(root["reserved"] as? [String] ?? [])
        let platformWords: Set<String> = ["ios", "android", "web", "watch", "wear", "macos", "windows", "linux", "native", "desktop"]
        guard reserved == platformWords else {
            throw Failure("the reserved list drifted from the platform-suffix vocabulary: \(reserved.sorted())")
        }

        guard let splitCases = root["split"] as? [[String: Any]], !splitCases.isEmpty else {
            throw Failure("style-overrides.json: empty split[]")
        }
        for c in splitCases {
            let name = (c["name"] as? String) ?? "?"
            guard let attrsAny = c["attrs"] as? [String: Any],
                  let expect = c["expect"] as? [String: Any],
                  let expectOverrides = expect["overrides"] as? [String: Any],
                  let expectProps = expect["props"] as? [String: Any] else {
                throw Failure("split/\(name): malformed case")
            }
            var attrs: [String: String] = [:]
            for (k, v) in attrsAny { attrs[k] = (v as? String) ?? String(describing: v) }
            let got = StyleOverrides.split(attrs)
            let expOv = expectOverrides.mapValues { ($0 as? String) ?? String(describing: $0) }
            let expPr = expectProps.mapValues { ($0 as? String) ?? String(describing: $0) }
            guard got.overrides == expOv else {
                throw Failure("split/\(name): overrides \(got.overrides) != \(expOv)")
            }
            guard got.props == expPr else {
                throw Failure("split/\(name): props \(got.props) != \(expPr)")
            }
        }

        guard let resolveCases = root["resolve"] as? [[String: Any]], !resolveCases.isEmpty else {
            throw Failure("style-overrides.json: empty resolve[]")
        }
        for c in resolveCases {
            let name = (c["name"] as? String) ?? "?"
            guard let declMap = c["decl"] as? [String: Any] else { throw Failure("resolve/\(name): no decl") }
            let raw: Any? = c.keys.contains("raw") ? c["raw"] : nil
            let got = StyleOverrides.resolve(decl(declMap), raw)
            guard matches(got, c["expect"]) else {
                throw Failure("resolve/\(name): got \(String(describing: got)) expected \(String(describing: c["expect"]))")
            }
        }
        return splitCases.count + resolveCases.count
    }
}
