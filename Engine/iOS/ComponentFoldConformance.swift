//
//  ComponentFoldConformance.swift — the Swift runner for OpenSource/Conformance/components/*.json
//  (parity/U11-foundation-kit.md). The third of three: TS runs it per-PR
//  (packages/compiler/test/component-fold-conformance.test.ts), Kotlin runs it under gradle
//  (:core ComponentFoldConformanceTest), and this runs it in the record lane (RecordMain.swift).
//
//  WHY THE COMPONENT AND NOT A PURE CORE. A markup component has no kernel function to call:
//  its law lives in the `<variable computed="true">` and `<formula>` bodies of its own head,
//  and those bodies ARE the one implementation all three renderers execute. A kernel twin
//  would be a second owner of the same decision. So this mounts the head — attribute
//  defaults, head functions, computed variables, parameterized formulas, exactly the cases
//  StackHead.register handles — and evaluates the corpus's expressions against it.
//
//  Pure Foundation, no UIKit and no Combine: the store is `JSEVars`, the dictionary-backed
//  JSEState the satellite tier already uses, so the record lane runs this headless.
//
import Foundation

enum ComponentFoldConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    /// `corpusDir` is OpenSource/Conformance/components; `repoRoot` resolves each fixture's
    /// `source` and any `css` companion, since those live in the closed tree.
    static func verify(corpusDir: URL, repoRoot: URL) throws -> Int {
        let names = try FileManager.default.contentsOfDirectory(atPath: corpusDir.path)
            .filter { $0.hasSuffix(".json") }.sorted()
        guard !names.isEmpty else {
            throw Failure(description: "components/: no fixtures")
        }
        let closedSource = repoRoot.appendingPathComponent("ClosedSource")
        var checks = 0
        for name in names {
            checks += try verify(file: corpusDir.appendingPathComponent(name),
                                 repoRoot: repoRoot,
                                 hasClosedSource: directoryExists(closedSource))
        }
        if directoryExists(closedSource), checks == 0 {
            throw Failure(description: "components/: the corpus executed nothing")
        }
        return checks
    }

    private static func directoryExists(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        let there = FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
        return there && isDirectory.boolValue
    }

    private static func verify(file: URL, repoRoot: URL, hasClosedSource: Bool) throws -> Int {
        let label = file.lastPathComponent
        let data = try Data(contentsOf: file)
        guard let corpus = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (corpus["version"] as? NSNumber)?.intValue == 1 else {
            throw Failure(description: "\(label): unsupported version")
        }
        let cases = corpus["cases"] as? [[String: Any]] ?? []
        guard !cases.isEmpty else { throw Failure(description: "\(label): no cases") }
        guard let relative = corpus["source"] as? String else {
            throw Failure(description: "\(label): no source")
        }
        guard hasClosedSource else { return 0 }   // a genuine open drop, nothing to execute
        let document = repoRoot.appendingPathComponent(relative)
        guard let source = try? String(contentsOf: document, encoding: .utf8) else {
            throw Failure(description: "\(label): \(relative) does not exist")
        }

        var checks = 0
        for raw in cases {
            let name = raw["name"] as? String ?? "(unnamed)"
            let attributes = raw["attributes"] as? [String: Any] ?? [:]
            let vars = raw["vars"] as? [String: Any] ?? [:]
            let item = raw["item"] as? [String: Any]
            let (store, rootAttrs) = try mountHead(source, attributes: attributes, vars: vars,
                                                   at: "\(label) · \(name)")
            let expectations = raw["expect"] as? [[String: Any]] ?? []
            let rootExpectations = raw["root"] as? [[String: Any]] ?? []
            guard !expectations.isEmpty || !rootExpectations.isEmpty else {
                throw Failure(description: "\(label)/\(name): no expectations")
            }
            for e in expectations {
                guard let expr = e["expr"] as? String else {
                    throw Failure(description: "\(label)/\(name): expectation has no expr")
                }
                let got = canonical(JSE.eval(expr, store: store, item: item))
                let want = canonical(e["value"])
                guard got == want else {
                    throw Failure(description: "\(label) · \(name) · \(expr): expected \(want), got \(got)")
                }
                checks += 1
            }
            for e in rootExpectations {
                guard let attr = e["attr"] as? String else {
                    throw Failure(description: "\(label)/\(name): root row has no attr")
                }
                guard let bound = rootAttrs[attr] else {
                    throw Failure(description: "\(label) · \(name): root has no \(attr)=")
                }
                let got = JSE.interpolate(bound, store: store, item: item)
                let want = e["value"] as? String ?? ""
                guard got == want else {
                    throw Failure(description: "\(label) · \(name) · root \(attr): expected \"\(want)\", got \"\(got)\"")
                }
                checks += 1
            }
        }
        for rule in corpus["css"] as? [[String: Any]] ?? [] {
            guard let relativeSheet = rule["file"] as? String else {
                throw Failure(description: "\(label): css row has no file")
            }
            let sheet = repoRoot.appendingPathComponent(relativeSheet)
            guard let text = try? String(contentsOf: sheet, encoding: .utf8) else {
                throw Failure(description: "\(label): \(relativeSheet) does not exist")
            }
            var cursor = text.startIndex
            for fragment in rule["ordered"] as? [String] ?? [] {
                guard let found = text.range(of: fragment, range: cursor ..< text.endIndex) else {
                    throw Failure(description: "\(label) · css \(rule["name"] as? String ?? "?"): missing \"\(fragment)\"")
                }
                cursor = found.upperBound
                checks += 1
            }
        }
        return checks
    }

    /// The head walk, 1:1 with StackHead.register's `variable`/`formula`/`attribute` cases and
    /// with the twins in dom/src/mount.ts and StackNodeView.kt. Everything below the head is
    /// body rendering, which a screenshot test judges — this pins only the fold.
    private static func mountHead(_ source: String, attributes: [String: Any],
                                  vars: [String: Any], at: String)
        throws -> (JSEVars, [String: String]) {
        guard let root = StackXML.parse(source) else {
            throw Failure(description: "\(at): document did not parse")
        }
        guard let head = root.children.first(where: { $0.tag == "head" }) else {
            throw Failure(description: "\(at): document has no <head>")
        }
        let store = JSEVars()
        store.vars["dsx.attribute"] = attributes
        for node in head.children where node.tag == "attribute" {
            if let name = node.attrs["as"], let def = node.attrs["default"],
               store.attrDefaults[name] == nil {
                store.attrDefaults[name] = def
            }
        }
        for node in head.children {
            switch node.tag {
            case "script", "functions":
                JSE.registerFunctions(node.text ?? "", store: store)
            case "variable", "var", "let":
                JSE.registerFunctions(node.text ?? "", store: store)
                if let name = node.attrs["as"] {
                    if node.attrs["computed"] == "true" {
                        store.computed[name] = node.text ?? ""
                    } else if store.initials[name] == nil {
                        store.initials[name] = JSE.evalBlock(node.text ?? "", store: store,
                                                             item: attributes) ?? ""
                    }
                }
            case "formula":
                JSE.registerFunctions(node.text ?? "", store: store)
                if let name = node.attrs["as"] {
                    var inputs = node.attrs; inputs["as"] = nil; inputs["id"] = nil
                    store.formulas[name] = StackFormula(inputs: inputs, body: node.text ?? "")
                }
            default:
                break
            }
        }
        for (key, value) in vars { store.vars[key] = value }
        return (store, root.attrs)
    }

    /// Canonical rendering for cross-runtime comparison: NSNull is null, an integral number
    /// prints as an integer (the twins hand back Doubles for every number), keys sorted.
    private static func canonical(_ value: Any?) -> String {
        guard let value = value, !(value is NSNull) else { return "null" }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
            let d = number.doubleValue
            if d.isFinite, d == d.rounded(), abs(d) < 1e15 { return String(Int64(d)) }
            return String(d)
        }
        if let flag = value as? Bool { return flag ? "true" : "false" }
        if let text = value as? String { return quote(text) }
        if let list = value as? [Any] { return "[" + list.map { canonical($0) }.joined(separator: ",") + "]" }
        if let dict = value as? [String: Any] {
            if dict["__nsnull"] != nil { return "null" }
            let body = dict.keys.sorted().map { "\(quote($0)):\(canonical(dict[$0]))" }
            return "{" + body.joined(separator: ",") + "}"
        }
        return quote("\(value)")
    }

    private static func quote(_ s: String) -> String {
        var out = "\""
        for c in s.unicodeScalars {
            switch c {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if c.value < 0x20 { out += String(format: "\\u%04x", c.value) } else { out.unicodeScalars.append(c) }
            }
        }
        return out + "\""
    }
}
