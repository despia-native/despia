//
//  TelemetryPolicy.swift — the shared telemetry core: the SCRUBBER and the QUEUE POLICY. The law
//  is the corpus, `OpenSource/Conformance/telemetry/{scrub,queue}.json`
//  (parity/F10-telemetry.md); the Kotlin twin is `:core` TelemetryPolicy.kt and the web twin is
//  @despia/kernel's telemetry.ts.
//
//  Everything platform-shaped lives OUTSIDE this file — crash handlers, the ANR watchdog, the
//  on-disk queue, the transports. What is here is the half that decides WHAT LEAVES THE DEVICE,
//  which is exactly the half that must not drift between renderers: a redaction rule that fires on
//  iOS and not on Android is a privacy incident with a platform column.
//
//  This file records nothing and sends nothing. Core/Telemetry is a SINK ADAPTER over the kernel
//  error ledger (`dsx.errors`, error-system.md); it never becomes a second error system.
//
//  No UIKit import: this file is pure so the record lane can run it headless.
//
import Foundation

public enum TelemetryScrub {

    /// The placeholder each rule leaves behind. Pinned by the corpus — a sink's grouping keys are
    /// built from scrubbed text, so changing one re-groups every historical issue.
    public static let placeholders: [String: String] = [
        "email": "[email]",
        "bearer": "Bearer [token]",
        "jwt": "[jwt]",
        "phone": "[phone]",
        "card": "[card]",
        "home": "[user]",
        "key": "[redacted]",
    ]

    /// One ordered redaction rule. `check` (card rules only) rejects a match the regex shape alone
    /// cannot judge, so a Luhn-failing 16-digit order number stays readable.
    private struct Rule {
        let id: String
        let regex: NSRegularExpression
        let replacement: String
        let check: ((String) -> Bool)?
    }

    private static func rule(_ id: String, _ pattern: String, _ replacement: String,
                             check: ((String) -> Bool)? = nil) -> Rule? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        return Rule(id: id, regex: regex, replacement: replacement, check: check)
    }

    /// ORDER IS CONTRACT (corpus `order`):
    ///   bearer before jwt — an Authorization header collapses to ONE placeholder rather than
    ///                       `Bearer [jwt]`, which reads like the header survived;
    ///   card before phone — a card number is never reported as a phone number;
    ///   home before phone — a path is redacted as a path.
    ///
    /// The `bearer` prefix is spelled as explicit character classes rather than a case-insensitive
    /// option: the three regex engines disagree about inline modifiers and agree about character
    /// classes, and one scrubber that behaves differently per platform is worse than none.
    private static let rules: [Rule] = {
        let card = placeholders["card"] ?? "[card]"
        let home = placeholders["home"] ?? "[user]"
        let built: [Rule?] = [
            rule("bearer", "[Bb][Ee][Aa][Rr][Ee][Rr] [A-Za-z0-9._~+/=-]{8,}", placeholders["bearer"] ?? ""),
            rule("jwt", "eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}(\\.[A-Za-z0-9_-]+)?", placeholders["jwt"] ?? ""),
            rule("email", "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", placeholders["email"] ?? ""),
            rule("homeUnix", "/Users/[^/\\s\"']+", "/Users/" + home),
            rule("homeLinux", "/home/[^/\\s\"']+", "/home/" + home),
            rule("homeWindows", "Users\\\\[^\\\\/\\s\"']+", "Users\\" + home),
            rule("cardAmex", "[0-9]{4}[ -][0-9]{6}[ -][0-9]{5}", card, check: cardShaped),
            rule("cardGrouped", "[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{1,7}", card, check: cardShaped),
            // Greedy on purpose: a maximal digit run longer than 19 fails `cardShaped` and stays
            // readable, which is how a 23-digit reference number survives without a lookbehind
            // (three engines, one behavior).
            rule("cardPlain", "[0-9]{14,}", card, check: cardShaped),
            rule("phoneInternational", "\\+[0-9][0-9 ().-]{6,18}[0-9]", placeholders["phone"] ?? ""),
            rule("phoneGrouped", "\\(?[0-9]{3}\\)?[ .-][0-9]{3}[ .-][0-9]{4}", placeholders["phone"] ?? ""),
        ]
        return built.compactMap { $0 }
    }()

    /// The rule ids in application order — the corpus asserts this list, so a rule cannot be
    /// reordered on one renderer only.
    public static var order: [String] { rules.map { $0.id } }

    /// Keys whose VALUE is dropped whole, whatever it looks like.
    ///
    /// Matching is on the normalized key (lowercased, non-alphanumerics removed) and is EXACT,
    /// never a substring: `token` redacts, `tokenCount` does not, because a scrubber that eats
    /// metric names gets switched off. `email` and `phone` are deliberately absent — their values
    /// are still scrubbed by the text pass, and `identify` passes its explicit fields around the
    /// scrubber entirely, which is what "opt-in per field" means.
    private static let sensitiveKeys: Set<String> = [
        "password", "passwd", "secret", "token", "accesstoken", "refreshtoken", "idtoken", "apikey",
        "authorization", "cookie", "setcookie", "sessionid", "ssn", "creditcard", "cardnumber",
        "cvv", "cvc", "pin", "privatekey", "clientsecret",
    ]

    /// The Luhn check every card rule gates on. Without it a 16-digit order number reads as a card
    /// and the developer loses the one field that would have identified the order.
    public static func luhn(_ digits: String) -> Bool {
        guard !digits.isEmpty else { return false }
        var sum = 0
        var alternate = false
        for character in digits.reversed() {
            guard let digit = character.wholeNumberValue else { return false }
            var value = digit
            if alternate {
                value *= 2
                if value > 9 { value -= 9 }
            }
            sum += value
            alternate.toggle()
        }
        return sum % 10 == 0
    }

    private static func cardShaped(_ match: String) -> Bool {
        let digits = String(match.filter { $0.isASCII && $0.isNumber })
        return digits.count >= 14 && digits.count <= 19 && luhn(digits)
    }

    private static func normalizeKey(_ key: String) -> String {
        String(key.lowercased().filter { ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") })
    }

    /// Is this a key whose value never leaves the device?
    public static func isSensitiveKey(_ key: String) -> Bool {
        sensitiveKeys.contains(normalizeKey(key))
    }

    /// Redact one string. Applied at ENQUEUE, never at send — a crash during flush must not be
    /// able to leak an unredacted buffer, so the buffer never holds one.
    public static func text(_ input: String) -> String {
        var current = input
        for rule in rules {
            current = apply(rule, to: current)
        }
        return current
    }

    /// One rule over one string. Matches are rewritten back-to-front so earlier ranges stay valid;
    /// a `check` that refuses leaves the match exactly as it was.
    private static func apply(_ rule: Rule, to input: String) -> String {
        let ns = input as NSString
        let matches = rule.regex.matches(in: input, range: NSRange(location: 0, length: ns.length))
        guard !matches.isEmpty else { return input }
        let result = NSMutableString(string: input)
        for match in matches.reversed() {
            let hit = ns.substring(with: match.range)
            if let check = rule.check, !check(hit) { continue }
            result.replaceCharacters(in: match.range, with: rule.replacement)
        }
        return result as String
    }

    /// Redact one key/value pair: a sensitive key drops the value whole, everything else is
    /// scrubbed as text.
    public static func value(key: String, value: String) -> String {
        isSensitiveKey(key) ? (placeholders["key"] ?? "[redacted]") : text(value)
    }

    /// The ARG SHAPE of a failed `dsx.module` call: keys and value TYPES, never values. What is
    /// diagnostic about a failed call is which fields were present, and that is exactly the part
    /// that carries no secrets.
    public static func argShape(_ args: [String: Any]?) -> [String: String] {
        guard let args else { return [:] }
        var out: [String: String] = [:]
        for key in args.keys.sorted() {
            let value = args[key]
            if value == nil || value is NSNull {
                out[key] = "null"
            } else if value is [Any] {
                out[key] = "array"
            } else if let number = value as? NSNumber {
                // objCType, not CFGetTypeID: the livelogs conformance runner compiles this file
                // on Linux, where Foundation no longer re-exports CoreFoundation. "c" is the
                // boolean discriminator on both Foundations (ScrollCore.finite).
                out[key] = String(cString: number.objCType) == "c" ? "boolean" : "number"
            } else if value is Bool {
                out[key] = "boolean"
            } else if value is String {
                out[key] = "string"
            } else if value is Int || value is Double || value is Float {
                out[key] = "number"
            } else {
                out[key] = "object"
            }
        }
        return out
    }
}

public enum TelemetryQueuePolicy {

    private static let hexRun = try? NSRegularExpression(pattern: "0[xX][0-9a-fA-F]+")
    private static let digitRun = try? NSRegularExpression(pattern: "[0-9]+")
    private static let whitespaceRun = try? NSRegularExpression(pattern: "\\s+")

    /// Collapse the varying parts of a message so a crash loop folds to one fingerprint:
    /// addresses become `<addr>`, digit runs become `#`, whitespace collapses, tail capped.
    public static func collapseMessage(_ message: String?) -> String {
        guard let message, !message.isEmpty else { return "" }
        var folded = replaceAll(hexRun, in: message, with: "<addr>")
        folded = replaceAll(digitRun, in: folded, with: "#")
        folded = replaceAll(whitespaceRun, in: folded, with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return folded.count > 200 ? String(folded.prefix(200)) : folded
    }

    private static func replaceAll(_ regex: NSRegularExpression?, in input: String, with replacement: String) -> String {
        guard let regex else { return input }
        let range = NSRange(location: 0, length: (input as NSString).length)
        let template = NSRegularExpression.escapedTemplate(for: replacement)
        return regex.stringByReplacingMatches(in: input, range: range, withTemplate: template)
    }

    /// The dedupe/grouping key: source, code and the collapsed message. Two crashes at different
    /// addresses are ONE issue, which is the difference between a count and ten thousand events.
    public static func fingerprint(source: String, code: String, message: String? = nil) -> String {
        source + "|" + code + "|" + collapseMessage(message)
    }

    /// FNV-1a 32-bit over UTF-8 — the one hash all three renderers compute identically.
    public static func fnv1a32(_ input: String) -> UInt32 {
        var hash: UInt32 = 0x811c9dc5
        for byte in Array(input.utf8) {
            hash ^= UInt32(byte)
            hash = hash &* 0x01000193
        }
        return hash
    }

    /// Deterministic sampling: a pure function of the fingerprint, not a random draw, so one
    /// device's sample decision is every device's and a corpus can pin it.
    public static func sampled(_ fingerprint: String, rate: Double) -> Bool {
        if rate <= 0 { return false }
        if rate >= 1 { return true }
        return Int(fnv1a32(fingerprint) % 10000) < Int((rate * 10000).rounded())
    }

    /// Exponential backoff, capped at five minutes. No jitter: a corpus cannot pin a random
    /// number, and the platform half is free to add jitter where it schedules the retry.
    public static func backoffMs(_ attempt: Int) -> Int {
        guard attempt > 0 else { return 0 }
        var delay = 1000
        var step = 1
        while step < attempt && delay < 300000 {
            delay *= 2
            step += 1
        }
        return delay > 300000 ? 300000 : delay
    }
}

/// What `TelemetryQueue.offer` decided. `.evicted` means the event was accepted AND the oldest one
/// fell out.
public enum TelemetryOfferOutcome: String {
    case accepted
    case deduped
    case evicted
}

public struct TelemetryOfferResult: Equatable {
    public let outcome: TelemetryOfferOutcome
    public let size: Int
    public let dropped: Int
    public let count: Int
}

/// The bounded, de-duplicating event ring — pure, so the corpus judges it on every renderer.
///
/// The platform half persists it to disk and drives the flush timer; nothing here does IO. A
/// repeat of a live fingerprint inside the window increments a COUNT and slides the window, so a
/// crash loop reports "this happened 4,182 times" instead of filling the queue with itself.
/// Overflow drops the OLDEST and counts the drop, because the newest crash is the one being
/// debugged and a silent drop is a lie to the sink.
public final class TelemetryQueue {

    private struct Item {
        let fingerprint: String
        var at: Int
        var count: Int
    }

    public let capacity: Int
    public let windowMs: Int
    public let maxBatch: Int
    private var items: [Item] = []
    private var droppedCount = 0

    public init(capacity: Int, windowMs: Int, maxBatch: Int) {
        self.capacity = capacity
        self.windowMs = windowMs
        self.maxBatch = maxBatch
    }

    public var size: Int { items.count }

    /// Events lost to the bound, ever. Reported to the sink so it sees its own blind spot.
    public var dropped: Int { droppedCount }

    @discardableResult
    public func offer(_ fingerprint: String, at: Int) -> TelemetryOfferResult {
        for index in items.indices where items[index].fingerprint == fingerprint && at - items[index].at < windowMs {
            items[index].count += 1
            items[index].at = at
            return TelemetryOfferResult(outcome: .deduped, size: items.count,
                                        dropped: droppedCount, count: items[index].count)
        }
        items.append(Item(fingerprint: fingerprint, at: at, count: 1))
        var outcome = TelemetryOfferOutcome.accepted
        if items.count > capacity {
            items.removeFirst()
            droppedCount += 1
            outcome = .evicted
        }
        return TelemetryOfferResult(outcome: outcome, size: items.count, dropped: droppedCount, count: 1)
    }

    /// The next batch's fingerprints, oldest first, capped at `maxBatch`.
    public func batch() -> [String] {
        items.prefix(maxBatch).map { $0.fingerprint }
    }

    /// How many times a live fingerprint has been seen, or 0 when it is not queued.
    public func countOf(_ fingerprint: String) -> Int {
        items.first(where: { $0.fingerprint == fingerprint })?.count ?? 0
    }

    /// Drop the first `n` events — called after the sink accepted them. Never underflows.
    @discardableResult
    public func ack(_ n: Int) -> Int {
        let take = max(0, min(n, items.count))
        items.removeFirst(take)
        return items.count
    }

    /// Revoked consent drops everything pending, and the drop is NOT counted: those events were
    /// never the sink's to know about.
    public func clear() {
        items.removeAll()
    }
}
