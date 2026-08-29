//
//  Spotlight.swift — the SHARED PURE CORE behind Core/Spotlight (F17.7), and the reference
//  renderer's leg of it. Twin of :core Spotlight.kt and the web kernel's spotlight.ts.
//
//  THE ROUND TRIP IS THE PRODUCT. Indexing content into the system search field is only half
//  the feature; the half that matters is the TAP, which arrives as an opaque identifier the app
//  must turn back into a route. Core Spotlight calls that `uniqueIdentifier`, AppSearch calls it
//  a namespaced document id, and if each platform invented its own encoding then a deep link
//  that worked on iOS would 404 on Android. So the encoding lives here and
//  `Mandatory/PushRouting` receives the same route either way.
//
//  Pure Foundation, no CoreSpotlight: the same decisions serve the Android and web twins.
//  Pinned by OpenSource/Conformance/spotlight/index.json.
//
import Foundation

public enum SpotlightCore {

    /// Both indexers degrade on a single huge transaction. 100 is the chunk both handle.
    public static let batchMax = 100

    public static let maxIdChars = 256
    public static let maxTitleChars = 256
    public static let maxDescriptionChars = 2000

    /// Beyond this, keyword matching gets worse rather than better on both platforms.
    public static let maxKeywords = 32

    public static let messages: [String: String] = [
        "invalid_id": "That is not a usable item id.",
        "invalid_title": "Every indexed item needs a title the OS can show.",
        "invalid_route": "Every indexed item needs the absolute route its tap opens.",
        "invalid_domain": "That is not a usable index domain.",
        "too_many_items": "That is more items than one call can index.",
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
            return SpotlightCore.messages[code] ?? code
        }
    }

    public struct Item: Equatable {
        public let id: String
        public let title: String
        public let description: String
        public let keywords: [String]
        public let image: String
        public let route: String
        public let domain: String
        /// epoch milliseconds, or 0 for "no expiry"
        public let expires: Int64
    }

    private static func stringOf(_ raw: Any?) -> String {
        switch raw {
        case let v as String: return v
        case let v as NSNumber: return v.stringValue
        case .none: return ""
        case .some(let v): return "\(v)"
        }
    }

    private static func hasControlCharacter(_ text: String) -> Bool {
        for scalar in text.unicodeScalars where scalar.value < 0x20 || scalar.value == 0x7f {
            return true
        }
        return false
    }

    /// A domain groups items so `clear({ domain })` removes a whole feature's index at once.
    /// It may not contain a colon, and that is load-bearing: the unique identifier is
    /// `<domain>:<id>` split at the FIRST colon, which is what lets an id contain colons freely
    /// (a URL, a compound key) while the round trip stays exact.
    public static func normalizeDomain(_ raw: Any?) -> Result<String, Refusal> {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .success("default") }
        if text.contains(":") {
            return .failure(Refusal("invalid_domain", "a domain cannot contain a colon; it is the separator"))
        }
        if text.count > 64 { return .failure(Refusal("invalid_domain", "a domain is at most 64 characters")) }
        if hasControlCharacter(text) {
            return .failure(Refusal("invalid_domain", "a domain holds no control characters"))
        }
        return .success(text)
    }

    /// `<domain>:<id>`. The one encoding both platforms use, so a tap resolves the same route.
    public static func uniqueId(_ domain: String, _ id: String) -> String { "\(domain):\(id)" }

    /// The inverse. Split at the FIRST colon, so an id containing colons round-trips exactly.
    public static func parseUniqueId(_ raw: Any?) -> (domain: String, id: String)? {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        let chars = Array(text)
        guard let colon = chars.firstIndex(of: ":"), colon > 0, colon < chars.count - 1 else { return nil }
        return (String(chars[0..<colon]), String(chars[(colon + 1)...]))
    }

    /// Trimmed, lowercased, deduped and capped. Case folding matters: both indexers match
    /// case-insensitively, so keeping "Recipe" and "recipe" spends the cap on nothing.
    public static func normalizeKeywords(_ raw: Any?) -> [String] {
        var list: [Any?] = []
        if let array = raw as? [Any] { list = array.map { $0 as Any? } }
        else if let text = raw as? String, !text.isEmpty {
            list = text.components(separatedBy: ",").map { $0 as Any? }
        }
        var out: [String] = []
        for entry in list {
            let word = stringOf(entry).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if word.isEmpty || out.contains(word) { continue }
            out.append(word)
            if out.count >= maxKeywords { break }
        }
        return out
    }

    /// Validate and normalize one indexable item.
    ///
    /// THE ROUTE IS REQUIRED AND MUST BE ABSOLUTE. An indexed item with no route is worse than
    /// no item at all: it appears in the OS search field, the user taps it, and the app opens on
    /// its home screen with no explanation. Refusing at index time is the only place that
    /// failure can still be fixed.
    public static func normalizeItem(_ raw: [String: Any]) -> Result<Item, Refusal> {
        let id = stringOf(raw["id"]).trimmingCharacters(in: .whitespacesAndNewlines)
        if id.isEmpty { return .failure(Refusal("invalid_id", "an item needs an id")) }
        if id.count > maxIdChars {
            return .failure(Refusal("invalid_id", "an id is at most \(maxIdChars) characters"))
        }
        if hasControlCharacter(id) {
            return .failure(Refusal("invalid_id", "an id holds no control characters"))
        }

        let title = stringOf(raw["title"]).trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty { return .failure(Refusal("invalid_title", "an item needs a title to show")) }
        if title.count > maxTitleChars {
            return .failure(Refusal("invalid_title", "a title is at most \(maxTitleChars) characters"))
        }

        let domain: String
        switch normalizeDomain(raw["domain"]) {
        case .success(let v): domain = v
        case .failure(let r): return .failure(r)
        }

        let route = stringOf(raw["route"]).trimmingCharacters(in: .whitespacesAndNewlines)
        if route.isEmpty {
            return .failure(Refusal("invalid_route", "an indexed item needs the route its tap opens"))
        }
        if !route.hasPrefix("/") {
            return .failure(Refusal("invalid_route", "a route is absolute, starting with /"))
        }
        if hasControlCharacter(route) {
            return .failure(Refusal("invalid_route", "a route holds no control characters"))
        }

        let description = String(stringOf(raw["description"])
            .trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxDescriptionChars))
        let image = stringOf(raw["image"]).trimmingCharacters(in: .whitespacesAndNewlines)

        // A malformed or negative expiry means "no expiry" rather than an error: an item that
        // refuses to index because a timestamp was malformed is a worse outcome than one that
        // simply never expires.
        var expires: Int64 = 0
        if let rawExpires = raw["expires"], !(rawExpires is NSNull) {
            var n: Double = 0
            if let number = rawExpires as? NSNumber { n = number.doubleValue }
            else if let text = rawExpires as? String { n = Double(text.trimmingCharacters(in: .whitespaces)) ?? 0 }
            if n.isFinite && n > 0 { expires = Int64(n.rounded(.down)) }
        }

        return .success(Item(id: id, title: title, description: description,
                             keywords: normalizeKeywords(raw["keywords"]), image: image,
                             route: route, domain: domain, expires: expires))
    }

    /// Validate a whole batch, refusing on the FIRST bad item with its index in the detail: a
    /// partial index is the hardest state to reason about, so the batch is all-or-nothing.
    public static func normalizeItems(_ raw: Any?) -> Result<[Item], Refusal> {
        let list = (raw as? [Any]) ?? []
        var out: [Item] = []
        for (i, entry) in list.enumerated() {
            let row = (entry as? [String: Any]) ?? [:]
            switch normalizeItem(row) {
            case .success(let item): out.append(item)
            case .failure(let refusal):
                return .failure(Refusal(refusal.code, "item \(i): \(refusal.message)"))
            }
        }
        return .success(out)
    }

    /// Split a batch into transactions both indexers handle reliably.
    public static func chunk<T>(_ items: [T], max: Int = batchMax) -> [[T]] {
        let size = max > 0 ? max : batchMax
        var out: [[T]] = []
        var i = 0
        while i < items.count {
            out.append(Array(items[i..<Swift.min(i + size, items.count)]))
            i += size
        }
        return out
    }
}
