//
//  Payment.swift — the SHARED PURE CORE behind Core/Pay (F17.2), and the reference renderer's
//  leg of it. Twin of :core Payment.kt and the web kernel's payment.ts.
//
//  THE MONEY IS THE WHOLE POINT. PassKit, the Google Pay API and the Payment Request API take
//  three differently-shaped requests and each hides a bad one differently: one shows a wrong
//  number, one throws, one silently drops a row. So the arithmetic, the currency exponents,
//  the network vocabulary and the SUM CHECK live here and are pinned by
//  OpenSource/Conformance/pay/request.json. The platform sheets are plumbing.
//
//  BINARY FLOATS ARE REFUSED FOR FRACTIONAL AMOUNTS. An amount is a DECIMAL STRING in the
//  currency's major unit ("12.34"), or a JSON number only when it is a whole integer. A
//  fractional Double is refused with a message that says to quote it, because a checkout that
//  is off by a cent for one customer in a thousand is unfixable after the fact.
//
//  Pure Foundation: no PassKit here, so nothing about this file is Apple-shaped and the same
//  decisions serve the Android and web twins.
//
import Foundation

public enum PaymentCore {

    /// A payment larger than this is a data-entry error, not a purchase. In minor units.
    public static let maxMinor: Int64 = 1_000_000_000_000

    /// Currencies whose minor unit is not 1/100. Absent means exponent 2, the ISO default.
    private static let currencyExponents: [String: Int] = [
        "BIF": 0, "CLP": 0, "DJF": 0, "GNF": 0, "ISK": 0, "JPY": 0, "KMF": 0, "KRW": 0,
        "PYG": 0, "RWF": 0, "UGX": 0, "UYI": 0, "VND": 0, "VUV": 0, "XAF": 0, "XOF": 0,
        "XPF": 0,
        "BHD": 3, "IQD": 3, "JOD": 3, "KWD": 3, "LYD": 3, "OMR": 3, "TND": 3,
    ]

    public static let networks: [String] = [
        "amex", "cartesBancaires", "discover", "eftpos", "electron", "elo", "girocard",
        "interac", "jcb", "maestro", "mada", "mastercard", "unionPay", "visa",
    ]

    private static let networkAliases: [String: String] = [
        "amex": "amex", "americanexpress": "amex",
        "cartesbancaires": "cartesBancaires", "cb": "cartesBancaires",
        "discover": "discover",
        "eftpos": "eftpos", "eftposaustralia": "eftpos",
        "electron": "electron", "visaelectron": "electron",
        "elo": "elo",
        "girocard": "girocard",
        "interac": "interac",
        "jcb": "jcb",
        "maestro": "maestro",
        "mada": "mada",
        "mastercard": "mastercard", "master": "mastercard",
        "unionpay": "unionPay", "chinaunionpay": "unionPay",
        "visa": "visa",
    ]

    public static let capabilities: [String] = ["threeDS", "debit", "credit", "emv"]

    private static let capabilityAliases: [String: String] = [
        "3ds": "threeDS", "threeds": "threeDS", "3dsecure": "threeDS",
        "debit": "debit", "credit": "credit", "emv": "emv",
    ]

    public static let fields: [String] = ["name", "email", "phone", "postalAddress"]

    private static let fieldAliases: [String: String] = [
        "name": "name", "fullname": "name",
        "email": "email", "emailaddress": "email",
        "phone": "phone", "phonenumber": "phone",
        "postaladdress": "postalAddress", "address": "postalAddress",
        "shippingaddress": "postalAddress",
    ]

    public static let statuses: [String] = [
        "success", "failure", "invalidBillingAddress", "invalidShippingAddress",
        "invalidShippingContact", "pinRequired", "pinIncorrect", "pinLockout",
    ]

    private static let statusAliases: [String: String] = [
        "success": "success", "ok": "success", "succeeded": "success",
        "failure": "failure", "failed": "failure", "error": "failure",
        "invalidbillingaddress": "invalidBillingAddress",
        "invalidshippingaddress": "invalidShippingAddress",
        "invalidshippingcontact": "invalidShippingContact",
        "pinrequired": "pinRequired", "pinincorrect": "pinIncorrect",
        "pinlockout": "pinLockout",
    ]

    public static let messages: [String: String] = [
        "invalid_currency": "That is not an ISO 4217 currency code.",
        "invalid_amount": "That is not an amount this currency can express.",
        "no_items": "A payment sheet needs at least one line item.",
        "total_mismatch": "The line items do not add up to the total.",
        "missing_merchant": "A payment needs a merchant identifier.",
        "unknown_network": "That is not a card network this sheet knows.",
        "unknown_capability": "That is not a merchant capability this sheet knows.",
        "unknown_field": "That is not a field the sheet can collect.",
        "unknown_status": "That is not an outcome the sheet understands.",
        "invalid_label": "Every line the customer sees needs a label.",
    ]

    /// A refusal carries a stable CODE and an optional human detail naming the offender.
    public struct Refusal: Error, Equatable {
        public let code: String
        public let detail: String?
        public init(_ code: String, _ detail: String? = nil) {
            self.code = code
            self.detail = detail
        }
        /// The sentence to show, preferring the specific detail over the generic message.
        public var message: String {
            if let detail, !detail.isEmpty { return detail }
            return PaymentCore.messages[code] ?? code
        }
    }

    /// integer minor units; a negative line is a discount, which is legal on a line, not a total
    public struct Line: Equatable {
        public let label: String
        public let amountMinor: Int64
        public let kind: String
    }

    public struct Plan: Equatable {
        public let merchant: String
        public let currency: String
        public let exponent: Int
        public let items: [Line]
        public let total: Line
        public let networks: [String]
        public let capabilities: [String]
        public let shipping: [String]
        public let contact: [String]
    }

    private static func foldKey(_ raw: Any?) -> String {
        let text = stringOf(raw).lowercased()
        return String(text.filter { !$0.isWhitespace && $0 != "-" && $0 != "_" })
    }

    private static func stringOf(_ raw: Any?) -> String {
        switch raw {
        case let v as String: return v
        case let v as NSNumber: return v.stringValue
        case .none: return ""
        case .some(let v): return "\(v)"
        }
    }

    /// The minor-unit exponent for an ISO 4217 code, or -1 when the code is not one.
    public static func currencyExponent(_ raw: Any?) -> Int {
        let code = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard code.count == 3, code.allSatisfy({ $0.isASCII && $0.isLetter }) else { return -1 }
        return currencyExponents[code] ?? 2
    }

    private static func pow10(_ n: Int) -> Int64 {
        var out: Int64 = 1
        var i = 0
        while i < n { out *= 10; i += 1 }
        return out
    }

    /// Parse a money amount into integer minor units. Accepts a decimal string in the major
    /// unit, or a number ONLY when it is whole. A fractional number is refused: `0.1` is not
    /// `0.1` in binary, and a checkout off by a cent is unfixable after the fact.
    public static func parseAmountMinor(_ raw: Any?, exponent: Int) -> Result<Int64, Refusal> {
        if exponent < 0 { return .failure(Refusal("invalid_currency")) }

        // A JSON string arrives as String; only a genuine numeric takes the number path.
        if !(raw is String), let number = raw as? NSNumber {
            let d = number.doubleValue
            guard d.isFinite else { return .failure(Refusal("invalid_amount", "not a finite number")) }
            guard d == d.rounded(.towardZero) else {
                return .failure(Refusal("invalid_amount",
                    "quote a fractional amount as a string — binary floats cannot hold it exactly"))
            }
            let minor = Int64(d) * pow10(exponent)
            if abs(minor) > maxMinor { return .failure(Refusal("invalid_amount", "out of range")) }
            return .success(minor)
        }

        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = splitDecimal(text) else {
            return .failure(Refusal("invalid_amount", "not a decimal amount"))
        }
        if parsed.fraction.count > exponent {
            return .failure(Refusal("invalid_amount", "this currency has \(exponent) decimal place(s)"))
        }
        if parsed.whole.count > 15 { return .failure(Refusal("invalid_amount", "out of range")) }
        let padded = String((parsed.fraction + String(repeating: "0", count: exponent)).prefix(exponent))
        let wholeValue = Int64(parsed.whole) ?? 0
        let fracValue = exponent > 0 ? (Int64(padded) ?? 0) : 0
        let minor = Int64(parsed.sign) * (wholeValue * pow10(exponent) + fracValue)
        if abs(minor) > maxMinor { return .failure(Refusal("invalid_amount", "out of range")) }
        return .success(minor)
    }

    /// `^([+-]?)(\d+)(?:\.(\d+))?$` written out, so the three runtimes share one grammar rather
    /// than three regex engines' interpretations of it.
    private static func splitDecimal(_ text: String) -> (sign: Int, whole: String, fraction: String)? {
        var chars = Array(text)
        if chars.isEmpty { return nil }
        var sign = 1
        if chars[0] == "+" || chars[0] == "-" {
            if chars[0] == "-" { sign = -1 }
            chars.removeFirst()
        }
        var whole = ""
        var i = 0
        while i < chars.count, chars[i].isASCII, chars[i].isNumber { whole.append(chars[i]); i += 1 }
        if whole.isEmpty { return nil }
        if i == chars.count { return (sign, whole, "") }
        guard chars[i] == "." else { return nil }
        i += 1
        var fraction = ""
        while i < chars.count, chars[i].isASCII, chars[i].isNumber { fraction.append(chars[i]); i += 1 }
        if fraction.isEmpty || i != chars.count { return nil }
        return (sign, whole, fraction)
    }

    /// Render minor units back as the major-unit decimal string the sheet shows. Pinned so
    /// three renderers cannot disagree about whether it is `5`, `5.0` or `5.00`.
    public static func formatAmountMinor(_ minor: Int64, exponent: Int) -> String {
        let negative = minor < 0
        let value = minor < 0 ? -minor : minor
        if exponent <= 0 { return "\(negative ? "-" : "")\(value)" }
        let unit = pow10(exponent)
        let whole = value / unit
        let rest = value - whole * unit
        let restText = String(repeating: "0", count: max(0, exponent - "\(rest)".count)) + "\(rest)"
        return "\(negative ? "-" : "")\(whole).\(restText)"
    }

    private static func asList(_ raw: Any?) -> [Any?]? {
        if let list = raw as? [Any?] { return list }
        if let list = raw as? [Any] { return list.map { $0 as Any? } }
        if let text = raw as? String, !text.isEmpty { return text.components(separatedBy: ",").map { $0 as Any? } }
        return nil
    }

    private static func foldVocabulary(_ raw: Any?, _ aliases: [String: String],
                                       _ canonicalOrder: [String], _ refusalCode: String,
                                       _ fallback: [String]) -> Result<[String], Refusal> {
        let list = asList(raw) ?? []
        if list.isEmpty { return .success(fallback) }
        var seen = Set<String>()
        for entry in list {
            guard let canonical = aliases[foldKey(entry)] else {
                return .failure(Refusal(refusalCode, stringOf(entry)))
            }
            seen.insert(canonical)
        }
        return .success(canonicalOrder.filter { seen.contains($0) })
    }

    /// An empty request means "everything this device can do" — the only default that does not
    /// silently exclude a customer's card.
    public static func foldNetworks(_ raw: Any?) -> Result<[String], Refusal> {
        foldVocabulary(raw, networkAliases, networks, "unknown_network", networks)
    }

    public static func foldCapabilities(_ raw: Any?) -> Result<[String], Refusal> {
        foldVocabulary(raw, capabilityAliases, capabilities, "unknown_capability",
                       ["threeDS", "debit", "credit"])
    }

    public static func foldFields(_ raw: Any?) -> Result<[String], Refusal> {
        foldVocabulary(raw, fieldAliases, fields, "unknown_field", [])
    }

    /// Unknown is refused rather than treated as failure: a typo that reads as "declined" is a
    /// support ticket nobody can explain.
    public static func foldStatus(_ raw: Any?) -> Result<String, Refusal> {
        let text = stringOf(raw)
        let effective = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "success" : text
        guard let canonical = statusAliases[foldKey(effective)] else {
            return .failure(Refusal("unknown_status", effective))
        }
        return .success(canonical)
    }

    private static func parseLine(_ raw: Any?, exponent: Int,
                                  allowPending: Bool) -> Result<Line, Refusal> {
        guard let map = raw as? [String: Any] else {
            return .failure(Refusal("invalid_amount", "a line item must be an object"))
        }
        let label = stringOf(map["label"]).trimmingCharacters(in: .whitespacesAndNewlines)
        if label.isEmpty {
            return .failure(Refusal("invalid_label", "every line the customer sees needs a label"))
        }
        let amount = parseAmountMinor(map["amount"], exponent: exponent)
        guard case let .success(minor) = amount else {
            if case let .failure(refusal) = amount { return .failure(refusal) }
            return .failure(Refusal("invalid_amount"))
        }
        let kindRaw = foldKey(map["kind"] ?? map["type"] ?? "")
        let kind = kindRaw.isEmpty ? "final" : kindRaw
        if kind != "final" && kind != "pending" {
            return .failure(Refusal("invalid_amount", "a line is `final` or `pending`"))
        }
        if kind == "pending" && !allowPending {
            return .failure(Refusal("invalid_amount", "the total cannot be pending"))
        }
        return .success(Line(label: label, amountMinor: minor, kind: kind))
    }

    /// Validate and normalize a payment request into the plan every platform sheet is built
    /// from. THE SUM CHECK IS THE REASON THIS FUNCTION EXISTS: a request whose line items do
    /// not add up to its total is the most common wallet bug, and each platform hides it
    /// differently. Here it is `total_mismatch` before a sheet ever appears.
    ///
    /// A PENDING line (a shipping cost still being computed) is exempt from the sum, because
    /// its amount is by definition not yet known. The total itself may never be pending.
    public static func normalizeRequest(_ raw: [String: Any]) -> Result<Plan, Refusal> {
        let merchant = stringOf(raw["merchant"]).trimmingCharacters(in: .whitespacesAndNewlines)
        if merchant.isEmpty { return .failure(Refusal("missing_merchant")) }

        let currency = stringOf(raw["currency"]).trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let exponent = currencyExponent(currency)
        if exponent < 0 { return .failure(Refusal("invalid_currency", currency)) }

        let rawItems = (raw["items"] as? [Any]) ?? []
        if rawItems.isEmpty { return .failure(Refusal("no_items")) }

        var items: [Line] = []
        for entry in rawItems {
            switch parseLine(entry, exponent: exponent, allowPending: true) {
            case .success(let line): items.append(line)
            case .failure(let refusal): return .failure(refusal)
            }
        }

        guard let rawTotal = raw["total"], !(rawTotal is NSNull) else {
            return .failure(Refusal("invalid_amount", "a payment sheet needs a total line"))
        }
        let total: Line
        switch parseLine(rawTotal, exponent: exponent, allowPending: false) {
        case .success(let line): total = line
        case .failure(let refusal): return .failure(refusal)
        }
        if total.amountMinor < 0 {
            return .failure(Refusal("invalid_amount", "a total cannot be negative"))
        }

        var sum: Int64 = 0
        for item in items where item.kind != "pending" { sum += item.amountMinor }
        if sum != total.amountMinor {
            return .failure(Refusal("total_mismatch",
                "items add up to \(formatAmountMinor(sum, exponent: exponent)) but the total says "
                    + formatAmountMinor(total.amountMinor, exponent: exponent)))
        }

        let networksResult = foldNetworks(raw["networks"])
        guard case let .success(resolvedNetworks) = networksResult else {
            if case let .failure(refusal) = networksResult { return .failure(refusal) }
            return .failure(Refusal("unknown_network"))
        }
        let capabilitiesResult = foldCapabilities(raw["capabilities"])
        guard case let .success(resolvedCapabilities) = capabilitiesResult else {
            if case let .failure(refusal) = capabilitiesResult { return .failure(refusal) }
            return .failure(Refusal("unknown_capability"))
        }
        let shippingResult = foldFields(raw["shipping"])
        guard case let .success(resolvedShipping) = shippingResult else {
            if case let .failure(refusal) = shippingResult { return .failure(refusal) }
            return .failure(Refusal("unknown_field"))
        }
        let contactResult = foldFields(raw["contact"])
        guard case let .success(resolvedContact) = contactResult else {
            if case let .failure(refusal) = contactResult { return .failure(refusal) }
            return .failure(Refusal("unknown_field"))
        }

        return .success(Plan(merchant: merchant, currency: currency, exponent: exponent,
                             items: items, total: total, networks: resolvedNetworks,
                             capabilities: resolvedCapabilities, shipping: resolvedShipping,
                             contact: resolvedContact))
    }
}
