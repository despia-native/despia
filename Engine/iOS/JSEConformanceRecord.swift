//
//  JSEConformanceRecord.swift - RECORD MODE for the JSE conformance corpus.
//
//  Swift is the REFERENCE implementation of JSE (OpenSource/Engine/Android/PLAN.md ground-rule 5,
//  android-status.md §4 item 5): the corpus in OpenSource/Conformance/jse/*.json was seeded from
//  the pinned Kotlin twin + hand-read Swift behavior, and this recorder is the machine that makes
//  the Swift kernel AUTHORITATIVE over it. It loads every corpus file, evaluates each case's
//  `expression` against its `scope` through the REAL evaluator (JSE.eval + a real StackStore —
//  the exact seeding the Kotlin ConformanceTest mirrors), and re-emits the corpus with
//  `expected` = what the Swift kernel actually returned.
//
//  Output is BYTE-STABLE: the emitter reproduces the committed corpus format exactly (2-space
//  indent, `": "` separators, `{}`/`[]` inline when empty, raw UTF-8, integral numbers printed
//  as integers, case keys in name/scope/expression/expected order, scope keys sorted, no
//  trailing newline) — so when kernel behavior agrees with the committed corpus, the regenerated
//  files are byte-identical and `diff` is the drift alarm. Corpus authors keep scope keys
//  alphabetical; record mode canonicalizes them regardless.
//
//  NOT part of any app or extension target: the committed Xcode project does not reference this
//  file (OpenSource/Engine members are explicit file references, not a synchronized folder), and
//  prepare_modules.rb only ever prunes stranded engine refs — it never adds them. It compiles
//  ONLY in the Codemagic `conformance-record` lane, via
//  ClosedSource/scripts/conformance/record_jse_conformance.sh, together with the rest of
//  OpenSource/Engine (so JSE semantics — JSE.swift plus the JSECore/JSECrypto/JSERegex globals in
//  JSELibrary.swift — are the real, shipped code; only the per-app generated registries are shimmed).
//  Foundation-only; pure computation + file IO; no UI, no network.
//

import Foundation

enum JSEConformanceRecord {

    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Regenerate every `*.json` corpus file in `corpusDir` into `outDir` (same file names).
    /// Returns the number of files written. Throws on a malformed fixture or a result JSON
    /// cannot represent — the corpus contract is JSON-only values (NaN/Infinity stay behind
    /// coercions in expressions, never as raw `expected` values).
    static func record(corpusDir: URL, outDir: URL) throws -> Int {
        let fm = FileManager.default
        let names: [String]
        do { names = try fm.contentsOfDirectory(atPath: corpusDir.path).filter { $0.hasSuffix(".json") }.sorted() }
        catch { throw Failure(description: "cannot list corpus dir \(corpusDir.path): \(error)") }
        guard !names.isEmpty else {
            throw Failure(description: "conformance corpus is empty — \(corpusDir.path)/*.json (a silently-skipped conformance suite is how drift starts)")
        }
        try fm.createDirectory(at: outDir, withIntermediateDirectories: true)
        for name in names {
            let data = try Data(contentsOf: corpusDir.appendingPathComponent(name))
            let out = try regenerate(file: name, data: data)
            try out.write(to: outDir.appendingPathComponent(name), options: .atomic)
        }
        return names.count
    }

    // MARK: - Per-file regeneration

    private static func regenerate(file: String, data: Data) throws -> Data {
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(file): not a JSON object")
        }
        for key in doc.keys where key != "_note" && key != "cases" {
            // The corpus README also names action-sequence fixtures — when those land, teach
            // the recorder their shape EXPLICITLY instead of passing unknown keys through.
            throw Failure(description: "\(file): unknown top-level key '\(key)' — extend JSEConformanceRecord for new fixture shapes")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(file): no cases[]")
        }
        var pairs: [(String, JVal)] = []
        if let rawNote = doc["_note"] {
            guard let note = rawNote as? String else { throw Failure(description: "\(file): _note is not a string") }
            pairs.append(("_note", .string(note)))
        }
        pairs.append(("cases", .array(try cases.map { try recordCase($0, file: file) })))
        // Keep regenerated fixtures byte-stable with the checked-in JSON corpus.
        // `diff -u` correctly treats a missing terminal newline as a difference,
        // even when every semantic value is identical.
        return Data((emit(.object(pairs), indent: 0) + "\n").utf8)
    }

    /// One case: seed a fresh real store with `scope` (exactly how the Kotlin ConformanceTest
    /// seeds its StackStore), evaluate through the real JSE, and rebuild the case object with
    /// `expected` = the actual result. Key order is the corpus schema order.
    private static func recordCase(_ c: [String: Any], file: String) throws -> JVal {
        guard let name = c["name"] as? String else {
            throw Failure(description: "\(file): case without a string 'name'")
        }
        // `_note` is a case-level comment the corpus authors use to pin WHY a case is
        // spelled the way it is; the TS and Kotlin runners already ignore it. It is
        // carried through verbatim, in its committed position after `expected`, so a
        // re-record stays byte-identical to the checked-in fixture.
        let known = ["name", "scope", "expression", "expected", "_note"]
        for key in c.keys where !known.contains(key) {
            throw Failure(description: "\(file)/\(name): unknown case key '\(key)' — extend JSEConformanceRecord for new fixture shapes")
        }
        guard let expression = c["expression"] as? String else {
            throw Failure(description: "\(file)/\(name): case without a string 'expression'")
        }
        let scope = (c["scope"] as? [String: Any]) ?? [:]
        let store = StackStore()
        for (k, v) in scope { store.vars[k] = v }
        let actual = JSE.eval(expression, store: store, item: nil)
        var pairs: [(String, JVal)] = [
            ("name", .string(name)),
            ("scope", try jval(scope, context: "\(file)/\(name) scope")),
            ("expression", .string(expression)),
            ("expected", try jval(actual, context: "\(file)/\(name) result of `\(expression)`")),
        ]
        if let rawNote = c["_note"] {
            guard let note = rawNote as? String else {
                throw Failure(description: "\(file)/\(name): _note is not a string")
            }
            pairs.append(("_note", .string(note)))
        }
        return .object(pairs)
    }

    // MARK: - Canonical JSON (byte-stable against the committed corpus)

    private indirect enum JVal {
        case null
        case bool(Bool)
        case int(Int64)
        case double(Double)
        case string(String)
        case array([JVal])
        case object([(String, JVal)])
    }

    /// Foundation value → JVal. Booleans are told apart from 0/1 numbers by CFBoolean type id
    /// (an `as? Bool` cast on Darwin would happily match NSNumber 0/1 and corrupt the corpus).
    /// Generic dictionaries (scope internals, object results) emit with SORTED keys — the
    /// canonical order; only the schema-ordered case/document pairs are built by hand above.
    private static func jval(_ v: Any?, context: String) throws -> JVal {
        switch v {
        case nil, is NSNull:
            return .null
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            let d = n.doubleValue
            guard d.isFinite else {
                throw Failure(description: "\(context): non-finite number (\(d)) is not JSON-representable — keep NaN/Infinity behind coercions in the expression")
            }
            // The JSE number model: all values are Double, integral doubles print as ints.
            if d == d.rounded() && abs(d) < 9_007_199_254_740_992 { return .int(Int64(d)) }
            return .double(d)
        case let s as String:
            return .string(s)
        case let a as [Any]:
            return .array(try a.map { try jval($0, context: context) })
        case let o as [String: Any]:
            return .object(try o.keys.sorted().map { ($0, try jval(o[$0], context: context)) })
        default:
            throw Failure(description: "\(context): value of type \(type(of: v as Any)) is not JSON-representable — corpus cases must produce plain JSON values")
        }
    }

    private static func emit(_ v: JVal, indent: Int) -> String {
        switch v {
        case .null:            return "null"
        case .bool(let b):     return b ? "true" : "false"
        case .int(let i):      return String(i)
        case .double(let d):   return String(d)          // Swift's shortest round-trip form
        case .string(let s):   return quote(s)
        case .array(let items):
            if items.isEmpty { return "[]" }
            let pad = String(repeating: " ", count: indent + 2)
            let body = items.map { pad + emit($0, indent: indent + 2) }.joined(separator: ",\n")
            return "[\n" + body + "\n" + String(repeating: " ", count: indent) + "]"
        case .object(let pairs):
            if pairs.isEmpty { return "{}" }
            let pad = String(repeating: " ", count: indent + 2)
            let body = pairs.map { pad + quote($0.0) + ": " + emit($0.1, indent: indent + 2) }.joined(separator: ",\n")
            return "{\n" + body + "\n" + String(repeating: " ", count: indent) + "}"
        }
    }

    /// Minimal JSON string escaping, raw UTF-8 passthrough — the committed corpus keeps
    /// non-ASCII (e.g. 'héllo') unescaped.
    private static func quote(_ s: String) -> String {
        var out = "\""
        for ch in s.unicodeScalars {
            switch ch {
            case "\"":     out += "\\\""
            case "\\":     out += "\\\\"
            case "\n":     out += "\\n"
            case "\r":     out += "\\r"
            case "\t":     out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if ch.value < 0x20 { out += String(format: "\\u%04x", ch.value) }
                else { out.unicodeScalars.append(ch) }
            }
        }
        return out + "\""
    }
}
