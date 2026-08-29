//
//  Intents.swift — the SHARED PURE CORE behind Core/Intents (F17.6), and the reference
//  renderer's leg of it. Twin of :core Intents.kt and the web kernel's intents.ts.
//
//  WHY THIS EXISTS ON A PLATFORM THAT HAS NO INTENTS. Because the REFUSAL has to be the same
//  everywhere. A cross-platform caller writing one code path needs
//  `launch({ action: "nonsense" })` to fail identically on iOS and Android, and a developer
//  testing on a Mac needs to find out that their action name is wrong before they get to a
//  device. The `<queries>` generator is here for the same reason the rest of the build logic
//  is: it is a decision, not a platform call.
//
//  THE FLAG NUMBERS ARE PINNED, not read from any SDK: they are ABI-frozen Android constants
//  and changing one would break every APK ever shipped, so hardcoding them is safe the way
//  hardcoding a Unicode code point is safe.
//
//  Pure Foundation. Pinned by OpenSource/Conformance/intents/launch.json.
//
import Foundation

public enum IntentsCore {

    /// Word to the ABI-frozen `Intent` flag bit.
    public static let flags: [String: Int] = [
        "newTask": 0x1000_0000,
        "singleTop": 0x2000_0000,
        "clearTop": 0x0400_0000,
        "clearTask": 0x0000_8000,
        "newDocument": 0x0008_0000,
        "noHistory": 0x4000_0000,
        "excludeFromRecents": 0x0080_0000,
        "grantReadUri": 0x0000_0001,
        "grantWriteUri": 0x0000_0002,
    ]

    /// The canonical order a resolved flag list comes back in, so two equal requests compare equal.
    public static let flagOrder = [
        "newTask", "singleTop", "clearTop", "clearTask", "newDocument",
        "noHistory", "excludeFromRecents", "grantReadUri", "grantWriteUri",
    ]

    public static let messages: [String: String] = [
        "invalid_action": "That is not an intent action. Use a dotted constant like android.intent.action.VIEW.",
        "invalid_data": "That is not a URI an intent can carry.",
        "invalid_type": "That is not a MIME type.",
        "invalid_extras": "Intent extras are scalars or arrays of scalars.",
        "invalid_package": "That is not an Android package name.",
        "unknown_flag": "That is not an intent flag this module knows.",
    ]

    public struct Refusal: Error, Equatable {
        public let code: String
        public let detail: String?
        public init(_ code: String, _ detail: String? = nil) {
            self.code = code
            self.detail = detail
        }
        public var message: String {
            if let detail, !detail.isEmpty { return detail }
            return IntentsCore.messages[code] ?? code
        }
    }

    public struct Flags: Equatable {
        public let mask: Int
        public let words: [String]
    }

    /// NOT Equatable, deliberately: `extras` holds the scalars the caller passed with their
    /// ORIGINAL types (a number stays a number), exactly as the Kotlin and TS twins do.
    /// Stringifying them to win a synthesised `==` would be a semantic divergence in a shared
    /// core, which is the one thing this file exists to prevent.
    public struct Spec {
        public let action: String
        public let package: String
        public let data: String
        public let type: String
        public let categories: [String]
        public let extras: [String: Any]
        public let flags: Flags
    }

    /// One row of the `<queries>` block a module's manifest facet must declare.
    public struct Query: Equatable {
        public let kind: String
        public let action: String
        public let scheme: String
        public let mimeType: String
        public let name: String
    }

    private static func stringOf(_ raw: Any?) -> String {
        switch raw {
        case let v as String: return v
        case let v as NSNumber: return v.stringValue
        case .none: return ""
        case .some(let v): return "\(v)"
        }
    }

    private static func foldKey(_ raw: Any?) -> String {
        let lowered = stringOf(raw).lowercased()
        return String(lowered.filter { !$0.isWhitespace && $0 != "-" && $0 != "_" })
    }

    private static func isIdentChar(_ c: Character) -> Bool {
        (c.isASCII && (c.isLetter || c.isNumber)) || c == "." || c == "_"
    }

    /// An intent action is a dotted constant name. A BARE WORD IS REFUSED even though
    /// `Intent("VIEW")` compiles on Android: it resolves to nothing at runtime and the developer
    /// sees an empty chooser with no error.
    public static func normalizeAction(_ raw: Any?) -> Result<String, Refusal> {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .failure(Refusal("invalid_action", "an action is required")) }
        if !text.contains(".") {
            return .failure(Refusal("invalid_action",
                                    "an action is a dotted constant, e.g. android.intent.action.VIEW"))
        }
        if text.contains(where: { !isIdentChar($0) }) { return .failure(Refusal("invalid_action", text)) }
        if text.hasPrefix(".") || text.hasSuffix(".") { return .failure(Refusal("invalid_action", text)) }
        return .success(text)
    }

    /// A package name is a dotted identifier chain. A wrong one produces an empty result rather
    /// than an error, so it is checked here.
    public static func normalizePackage(_ raw: Any?) -> Result<String, Refusal> {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .success("") }
        if !text.contains(".") { return .failure(Refusal("invalid_package", "a package name is dotted")) }
        if text.contains(where: { !isIdentChar($0) }) { return .failure(Refusal("invalid_package", text)) }
        if text.hasPrefix(".") || text.hasSuffix(".") { return .failure(Refusal("invalid_package", text)) }
        return .success(text)
    }

    /// The URI an intent carries. Only the SCHEME is validated: `package:`, `content:`, `tel:`
    /// and a vendor's own are all legitimate, and a stricter rule would refuse working intents.
    public static func normalizeData(_ raw: Any?) -> Result<String, Refusal> {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .success("") }
        let chars = Array(text)
        guard let colon = chars.firstIndex(of: ":"), colon > 0 else {
            return .failure(Refusal("invalid_data", "intent data is a URI"))
        }
        let scheme = Array(chars[0..<colon])
        guard let first = scheme.first, first.isASCII, first.isLetter else {
            return .failure(Refusal("invalid_data", text))
        }
        for c in scheme {
            let ok = (c.isASCII && (c.isLetter || c.isNumber)) || c == "+" || c == "." || c == "-"
            if !ok { return .failure(Refusal("invalid_data", text)) }
        }
        if text.contains(where: { $0.isWhitespace }) { return .failure(Refusal("invalid_data", text)) }
        return .success(text)
    }

    /// A MIME type, lowercased. `*` is legal on either half.
    public static func normalizeType(_ raw: Any?) -> Result<String, Refusal> {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.isEmpty { return .success("") }
        let chars = Array(text)
        guard let slash = chars.firstIndex(of: "/"), slash > 0, slash < chars.count - 1 else {
            return .failure(Refusal("invalid_type", "a MIME type is type/subtype"))
        }
        if chars[(slash + 1)...].contains("/") { return .failure(Refusal("invalid_type", text)) }
        for c in chars {
            let ok = (c.isASCII && (c.isLetter || c.isNumber))
                || c == "/" || c == "*" || c == "." || c == "-" || c == "+"
            if !ok { return .failure(Refusal("invalid_type", text)) }
        }
        return .success(text)
    }

    /// Extras are SCALARS or homogeneous scalar arrays, and nothing else. Android's Bundle can
    /// carry a Parcelable graph; the DSX bus cannot, and a nested object would have to be
    /// serialised by a rule each renderer invented. Refusing is the honest answer.
    public static func normalizeExtras(_ raw: Any?) -> Result<[String: Any], Refusal> {
        guard let raw, !(raw is NSNull) else { return .success([:]) }
        guard let map = raw as? [String: Any] else {
            return .failure(Refusal("invalid_extras", "extras is an object of scalars"))
        }
        var out: [String: Any] = [:]
        for (key, value) in map {
            if key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return .failure(Refusal("invalid_extras", "an extra needs a name"))
            }
            if value is NSNull { continue }
            if let list = value as? [Any] {
                for entry in list where !(entry is String || entry is NSNumber) {
                    return .failure(Refusal("invalid_extras", "\(key): an array extra holds scalars"))
                }
                out[key] = list
                continue
            }
            guard value is String || value is NSNumber else {
                return .failure(Refusal("invalid_extras",
                                        "\(key): encode a structured extra as a string yourself"))
            }
            out[key] = value
        }
        return .success(out)
    }

    /// Fold flag words into the bitmask and canonical word list. An unknown flag is refused
    /// rather than dropped: a dropped `newTask` fails only when launched from a service.
    public static func foldFlags(_ raw: Any?) -> Result<Flags, Refusal> {
        var list: [Any?] = []
        if let array = raw as? [Any] { list = array.map { $0 as Any? } }
        else if let text = raw as? String, !text.isEmpty {
            list = text.components(separatedBy: ",").map { $0 as Any? }
        }
        var seen = Set<String>()
        for entry in list {
            let key = foldKey(entry)
            guard let match = flagOrder.first(where: { foldKey($0) == key }) else {
                return .failure(Refusal("unknown_flag", stringOf(entry)))
            }
            seen.insert(match)
        }
        let words = flagOrder.filter { seen.contains($0) }
        var mask = 0
        for word in words { mask |= flags[word] ?? 0 }
        return .success(Flags(mask: mask, words: words))
    }

    public static func normalize(_ raw: [String: Any]) -> Result<Spec, Refusal> {
        let action: String
        switch normalizeAction(raw["action"]) {
        case .success(let v): action = v
        case .failure(let r): return .failure(r)
        }
        let pkg: String
        switch normalizePackage(raw["package"]) {
        case .success(let v): pkg = v
        case .failure(let r): return .failure(r)
        }
        let data: String
        switch normalizeData(raw["data"]) {
        case .success(let v): data = v
        case .failure(let r): return .failure(r)
        }
        let type: String
        switch normalizeType(raw["type"]) {
        case .success(let v): type = v
        case .failure(let r): return .failure(r)
        }
        let extras: [String: Any]
        switch normalizeExtras(raw["extras"]) {
        case .success(let v): extras = v
        case .failure(let r): return .failure(r)
        }
        let resolvedFlags: Flags
        switch foldFlags(raw["flags"]) {
        case .success(let v): resolvedFlags = v
        case .failure(let r): return .failure(r)
        }

        var rawCategories: [Any] = []
        if let array = raw["categories"] as? [Any] { rawCategories = array }
        else if let text = raw["categories"] as? String, !text.isEmpty {
            rawCategories = text.components(separatedBy: ",")
        }
        var categories: [String] = []
        for entry in rawCategories {
            // Same grammar as an action: a dotted constant name.
            switch normalizeAction(entry) {
            case .success(let v): if !categories.contains(v) { categories.append(v) }
            case .failure: return .failure(Refusal("invalid_action", stringOf(entry)))
            }
        }

        return .success(Spec(action: action, package: pkg, data: data, type: type,
                             categories: categories, extras: extras, flags: resolvedFlags))
    }

    /// Derive the `<queries>` rows a set of declared intents needs.
    ///
    /// ANDROID 11 PACKAGE VISIBILITY is the reason this exists. An app can no longer see which
    /// other apps are installed unless its manifest says which it is looking for, and an intent
    /// for an undeclared component does not error: it throws ActivityNotFound. The failure looks
    /// exactly like "no app can handle this".
    public static func queries(_ specs: [Spec]) -> [Query] {
        var rows: [Query] = []
        var seen = Set<String>()

        for spec in specs {
            let row: Query
            if !spec.package.isEmpty {
                row = Query(kind: "package", action: "", scheme: "", mimeType: "", name: spec.package)
            } else {
                var scheme = ""
                if !spec.data.isEmpty {
                    let chars = Array(spec.data)
                    if let colon = chars.firstIndex(of: ":"), colon > 0 {
                        scheme = String(chars[0..<colon]).lowercased()
                    }
                }
                row = Query(kind: "intent", action: spec.action, scheme: scheme,
                            mimeType: spec.type, name: "")
            }
            let key = "\(row.kind)|\(row.action)|\(row.scheme)|\(row.mimeType)|\(row.name)"
            if seen.contains(key) { continue }
            seen.insert(key)
            rows.append(row)
        }

        // Sorted so the emitted manifest fragment is byte-stable across runs.
        return rows.sorted { a, b in
            let ka = "\(a.kind)|\(a.name)|\(a.action)|\(a.scheme)|\(a.mimeType)"
            let kb = "\(b.kind)|\(b.name)|\(b.action)|\(b.scheme)|\(b.mimeType)"
            return ka < kb
        }
    }
}
