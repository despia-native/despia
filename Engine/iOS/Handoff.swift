//
//  Handoff.swift — the SHARED PURE CORE behind Core/Handoff (F17.8), and the reference
//  renderer's leg of it. Twin of :core Handoff.kt and the web kernel's handoff.ts.
//
//  WHY A CORE. Handoff's real constraint is a SIZE LIMIT nobody documents precisely: Apple
//  transports the activity's userInfo over Bluetooth LE advertisement plus a short exchange, and
//  an oversized payload does not error — it silently stops appearing on the other device. A
//  limit that is only enforced on one platform, or measured differently on two, is not a limit.
//
//  THE CANONICAL FORM IS EXACT ON PURPOSE. Three languages must agree on the byte count to the
//  byte, so: keys are ASCII and SORTED BY UTF-8 BYTE, numbers are integers only (a binary float
//  has no single decimal spelling), and the escapes are written out rather than delegated to
//  each platform's JSON encoder. Note the sort in particular: Swift's default `String <` is
//  Unicode-canonical and would NOT match JavaScript's or Kotlin's UTF-16 ordering, which is why
//  keys are restricted to ASCII and compared as bytes here.
//
//  Pure Foundation, no NSUserActivity: the same decisions serve the Android and web twins.
//  Pinned by OpenSource/Conformance/handoff/activity.json.
//
import Foundation

public enum HandoffCore {

    /// The practical ceiling on an NSUserActivity's userInfo before the OS quietly stops
    /// advertising it. Apple documents no number; this is the size below which continuity is
    /// reliable, and it is enforced on every platform.
    public static let maxPayloadBytes = 3072

    public static let maxTitleChars = 256

    public static let messages: [String: String] = [
        "invalid_activity": "That is not a reverse-DNS activity type.",
        "invalid_url": "A handoff fallback is an http or https URL.",
        "invalid_payload": "A handoff payload holds strings, whole numbers and booleans.",
        "payload_too_large": "That payload is too large to advertise; hand over an identifier instead.",
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
            return HandoffCore.messages[code] ?? code
        }
    }

    public struct Activity {
        public let activity: String
        public let title: String
        public let url: String
        public let payload: [String: Any]
        /// the canonical serialisation's UTF-8 length, which is what the ceiling measures
        public let payloadBytes: Int
    }

    private static func stringOf(_ raw: Any?) -> String {
        switch raw {
        case let v as String: return v
        case let v as NSNumber: return v.stringValue
        case .none: return ""
        case .some(let v): return "\(v)"
        }
    }

    /// An activity type is reverse-DNS with at least two labels. Apple additionally requires it
    /// to appear in `NSUserActivityTypes`, and one that is not listed is advertised to nobody,
    /// silently; the module's manifest carries a config token for that list and this function
    /// only guards the grammar.
    public static func normalizeActivityType(_ raw: Any?) -> Result<String, Refusal> {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .failure(Refusal("invalid_activity", "an activity type is required")) }
        if text.count > 128 {
            return .failure(Refusal("invalid_activity", "an activity type is at most 128 characters"))
        }
        let labels = text.components(separatedBy: ".")
        if labels.count < 2 {
            return .failure(Refusal("invalid_activity",
                                    "an activity type is reverse-DNS, e.g. com.example.viewing"))
        }
        for label in labels {
            if label.isEmpty { return .failure(Refusal("invalid_activity", "an empty label")) }
            for c in label {
                let ok = (c.isASCII && (c.isLetter || c.isNumber)) || c == "-"
                if !ok { return .failure(Refusal("invalid_activity", text)) }
            }
        }
        return .success(text)
    }

    /// The fallback a device without the app opens. http(s) only: a custom scheme on a Mac that
    /// never installed the app opens nothing, which is the same as having no fallback.
    public static func normalizeUrl(_ raw: Any?) -> Result<String, Refusal> {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .success("") }
        let lower = text.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            return .failure(Refusal("invalid_url", "a handoff fallback is an http or https URL"))
        }
        if text.contains(where: { $0.isWhitespace }) { return .failure(Refusal("invalid_url", text)) }
        return .success(text)
    }

    private static func canonicalString(_ value: String) -> String {
        var out = "\""
        for c in value {
            switch c {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{0008}": out += "\\b"
            case "\u{000C}": out += "\\f"
            default:
                let code = c.unicodeScalars.first?.value ?? 0
                if c.unicodeScalars.count == 1 && (code < 0x20 || code == 0x7f) {
                    out += String(format: "\\u%04x", code)
                } else {
                    out.append(c)
                }
            }
        }
        return out + "\""
    }

    private static func isAsciiKey(_ key: String) -> Bool {
        if key.isEmpty { return false }
        for c in key {
            let ok = (c.isASCII && (c.isLetter || c.isNumber)) || c == "_" || c == "." || c == "-"
            if !ok { return false }
        }
        return true
    }

    /// ASCII keys compared BYTE BY BYTE, because Swift's default `String <` is
    /// Unicode-canonical and would order differently from JavaScript and Kotlin.
    private static func asciiLess(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8)
        let y = Array(b.utf8)
        var i = 0
        while i < x.count && i < y.count {
            if x[i] != y[i] { return x[i] < y[i] }
            i += 1
        }
        return x.count < y.count
    }

    /// Serialise a payload the same way in every language, so the byte count is the same number.
    /// Refuses what cannot be spelled identically three times: a non-integer number, a non-ASCII
    /// key, and anything nested more deeply than one array of scalars.
    public static func canonicalJson(_ value: Any?, depth: Int = 0) -> Result<String, Refusal> {
        guard let value, !(value is NSNull) else { return .success("null") }

        // NSNumber carries Bool and every numeric kind; the Bool test must come FIRST, because
        // on Apple platforms a boolean bridges to NSNumber and would otherwise print as 1.
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                return .success(number.boolValue ? "true" : "false")
            }
            let d = number.doubleValue
            if !d.isFinite || d != d.rounded(.towardZero) {
                return .failure(Refusal("invalid_payload",
                                        "a handoff payload carries whole numbers; quote anything else"))
            }
            return .success("\(Int64(d))")
        }
        if let text = value as? String { return .success(canonicalString(text)) }

        if let list = value as? [Any] {
            // An array is a VALUE of the payload object, so exactly depth 1.
            if depth != 1 {
                return .failure(Refusal("invalid_payload", "a handoff payload nests one level, not two"))
            }
            var parts: [String] = []
            for entry in list {
                switch canonicalJson(entry, depth: depth + 1) {
                case .success(let one): parts.append(one)
                case .failure(let refusal): return .failure(refusal)
                }
            }
            return .success("[" + parts.joined(separator: ",") + "]")
        }

        if let map = value as? [String: Any] {
            // The payload itself is the ONLY object: a handoff payload is a pointer to state.
            if depth != 0 {
                return .failure(Refusal("invalid_payload", "a handoff payload nests one level, not two"))
            }
            for key in map.keys where !isAsciiKey(key) {
                return .failure(Refusal("invalid_payload",
                                        "\(key): a payload key is ASCII letters, digits, . _ or -"))
            }
            let keys = map.keys.sorted(by: asciiLess)
            var parts: [String] = []
            for key in keys {
                switch canonicalJson(map[key], depth: depth + 1) {
                case .success(let one): parts.append("\(canonicalString(key)):\(one)")
                case .failure(let refusal): return .failure(refusal)
                }
            }
            return .success("{" + parts.joined(separator: ",") + "}")
        }

        return .failure(Refusal("invalid_payload",
                                "a handoff payload holds strings, whole numbers and booleans"))
    }

    /// UTF-8 byte length, counted by hand so no platform's encoder can disagree.
    public static func utf8ByteLength(_ text: String) -> Int {
        var bytes = 0
        for scalar in text.unicodeScalars {
            let code = scalar.value
            if code < 0x80 { bytes += 1 }
            else if code < 0x800 { bytes += 2 }
            else if code < 0x10000 { bytes += 3 }
            else { bytes += 4 }
        }
        return bytes
    }

    /// What the ceiling measures: the canonical serialisation's UTF-8 length.
    public static func payloadBytes(_ payload: Any?) -> Result<Int, Refusal> {
        switch canonicalJson(payload ?? [String: Any]()) {
        case .success(let canonical): return .success(utf8ByteLength(canonical))
        case .failure(let refusal): return .failure(refusal)
        }
    }

    /// Validate an activity before it is advertised. THE SIZE CHECK IS THE POINT: an oversized
    /// userInfo does not error on Apple's side, the activity simply stops appearing on the other
    /// device and the developer has nothing to debug.
    public static func normalize(_ raw: [String: Any]) -> Result<Activity, Refusal> {
        let activity: String
        switch normalizeActivityType(raw["activity"]) {
        case .success(let v): activity = v
        case .failure(let r): return .failure(r)
        }
        let url: String
        switch normalizeUrl(raw["url"]) {
        case .success(let v): url = v
        case .failure(let r): return .failure(r)
        }

        var payload: [String: Any] = [:]
        if let rawPayload = raw["payload"], !(rawPayload is NSNull) {
            guard let map = rawPayload as? [String: Any] else {
                return .failure(Refusal("invalid_payload", "a payload is an object"))
            }
            payload = map
        }

        let bytes: Int
        switch payloadBytes(payload) {
        case .success(let v): bytes = v
        case .failure(let r): return .failure(r)
        }
        if bytes > maxPayloadBytes {
            return .failure(Refusal("payload_too_large",
                "\(bytes) bytes; the ceiling is \(maxPayloadBytes). Hand over an identifier and fetch the rest."))
        }

        let title = String(stringOf(raw["title"])
            .trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxTitleChars))
        return .success(Activity(activity: activity, title: title, url: url,
                                 payload: payload, payloadBytes: bytes))
    }

    /// What arrives on the receiving device, normalised into the same shape the sender
    /// advertised so an app writes one handler rather than one per platform.
    public static func parseContinuation(_ raw: [String: Any]) -> Result<Activity, Refusal> {
        let activity: String
        switch normalizeActivityType(raw["activity"]) {
        case .success(let v): activity = v
        case .failure(let r): return .failure(r)
        }
        // A malformed incoming URL is DROPPED rather than refused: the continuation still
        // carries a usable activity and payload, and losing the whole handoff over a bad
        // fallback would be a worse outcome than losing the fallback.
        var url = ""
        if case let .success(v) = normalizeUrl(raw["url"]) { url = v }
        let payload = (raw["payload"] as? [String: Any]) ?? [:]
        var bytes = 0
        if case let .success(v) = payloadBytes(payload) { bytes = v }
        let title = String(stringOf(raw["title"])
            .trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxTitleChars))
        return .success(Activity(activity: activity, title: title, url: url,
                                 payload: payload, payloadBytes: bytes))
    }
}
