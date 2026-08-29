//
//  ContactsCore.swift — the shared Core/Contacts core: the permission surface, the paging
//  arithmetic, the read/write access decisions, the label vocabulary and the picker fold. The
//  law is the corpus, `OpenSource/Conformance/contacts/{crud,pick}.json` (parity F12); the
//  Kotlin twin is `:core` ContactsCore.kt and the web twin is @despia-native/kernel's contacts-core.ts.
//
//  Everything platform-shaped lives OUTSIDE this file: CNContactStore, ContactsContract and
//  navigator.contacts are per-renderer plumbing. What is pinned here is the part that must be
//  IDENTICAL on all three — how far a page reaches, what a grant permits, what a label is
//  called, and what the picker hands back.
//
//  No Contacts import: this file is pure so the record lane can run it headless.
//
import Foundation

/// A refusal or a go-ahead, in the shape every action reports.
public struct ContactsDecision: Equatable {
    public let runs: Bool
    /// The access word to report alongside a successful read: "granted" or "limited".
    public let access: String?
    public let error: String?
    public let message: String?
    public let recoverable: Bool
    /// Always false: no action in this module prompts on the caller's behalf.
    public let prompted: Bool
}

/// What one `list` page reports.
public struct ContactPage: Equatable {
    public let returned: Int
    public let hasNextPage: Bool
    public let endCursor: String?
}

/// What `pick` settles with.
public struct ContactPickOutcome {
    public let contacts: [[String: Any]]
    public let cancelled: Bool
    /// Always false: the system picker needs no grant and must never raise one.
    public let prompted: Bool
    /// false when the caller asked for multi-select and the platform has none; nil otherwise.
    public let multiple: Bool?
    public let error: String?
}

public enum ContactsCore {

    /// The shared label vocabulary. A platform constant folds into one of these five.
    public static let labels: [String] = ["home", "work", "mobile", "main", "other"]

    /// A contact with no name at all still needs something to render.
    public static let unnamed = "Unnamed Contact"

    /// One page may never fetch the world, and may never be unbounded.
    public static let maxPage = 500

    /// Which grant each action requires before it will run.
    ///
    /// `none` is the CONTRACT, not an implementation detail: an action listed as `none` that
    /// starts prompting is a regression, and an action listed as read/write that stops refusing
    /// is a privacy bug. `pick` is `none` on every renderer because the user hand-picks and the
    /// OS returns only what was picked.
    public static let permissionSurface: [String: String] = [
        "pick": "none",
        "permission": "none",
        "list": "read",
        "get": "read",
        "groups": "read",
        "add": "write",
        "update": "write",
        "remove": "write",
        "read": "read",
    ]

    /// The refusal messages. A caller that cannot find the fix retries the same call forever, so
    /// each one names the specific escalation that would work.
    public static let readRefusal =
        "Contacts access has not been granted. Call dsx.module.contacts.permission with level "
        + "\"read\" first, or use dsx.module.contacts.pick, which needs no permission."
    public static let writeRefusal =
        "Writing contacts has not been granted. Call dsx.module.contacts.permission with level "
        + "\"write\" first."
    public static let restrictedMessage = "Contacts access is restricted on this device."
    public static let invalidMessage =
        "A contact needs at least one of displayName, givenName, familyName, phones or emails."

    private static func allow(_ access: String) -> ContactsDecision {
        ContactsDecision(runs: true, access: access, error: nil, message: nil,
                         recoverable: true, prompted: false)
    }

    private static func refuse(_ error: String, _ message: String, _ recoverable: Bool) -> ContactsDecision {
        ContactsDecision(runs: false, access: nil, error: error, message: message,
                         recoverable: recoverable, prompted: false)
    }

    /// A limit past the cap clamps rather than fetching the world; zero or negative clamps to 1,
    /// never to unbounded.
    public static func clampLimit(_ requested: Int?, fallback: Int) -> Int {
        min(max(requested ?? fallback, 1), maxPage)
    }

    /// The paging arithmetic — the same on all three renderers even though the underlying cursor
    /// is not (an enumeration offset on iOS, a SQL LIMIT/OFFSET on Android).
    ///
    /// `endCursor` is present only when there IS a next page, so a caller that loops until the
    /// cursor is absent terminates instead of asking for an empty page forever.
    public static func page(total: Int, limit: Int?, offset: Int) -> ContactPage {
        let size = clampLimit(limit, fallback: maxPage)
        let start = max(0, offset)
        let returned = max(0, min(size, total - start))
        return collectedPage(offset: start, returned: returned, sawMore: start + returned < total)
    }

    /// The same page, reported by a store that ENUMERATED rather than counted: neither
    /// CNContactStore nor a content-provider query knows the total, but both learn whether one
    /// more row exists. `page` is defined in terms of this, so the corpus judges the code the
    /// modules call.
    public static func collectedPage(offset: Int, returned: Int, sawMore: Bool) -> ContactPage {
        let start = max(0, offset)
        let count = max(0, returned)
        return ContactPage(returned: count, hasNextPage: sawMore,
                           endCursor: sawMore ? String(start + count) : nil)
    }

    /// Can a read run, and what does it report?
    ///
    /// `limited` (iOS 17+ limited contact access) is a REAL GRANT over a shared subset, not a
    /// soft denial: the read runs and reports access:"limited" rather than pretending it
    /// enumerated the book. `restricted` is a device-policy denial and is NOT recoverable by
    /// asking again.
    public static func readDecision(_ access: String?) -> ContactsDecision {
        switch (access ?? "").trimmingCharacters(in: .whitespacesAndNewlines) {
        case "granted":    return allow("granted")
        case "limited":    return allow("limited")
        case "restricted": return refuse("restricted", restrictedMessage, false)
        default:           return refuse("permission_denied", readRefusal, true)
        }
    }

    /// How many rows a read may see: the whole book on a full grant, the shared subset on a
    /// limited one, and nothing at all when the read did not run.
    public static func readCount(access: String?, shared: Int, total: Int) -> Int {
        let decision = readDecision(access)
        guard decision.runs else { return 0 }
        return decision.access == "limited" ? max(0, shared) : max(0, total)
    }

    /// At least one of these makes a contact worth saving; an empty object is refused before any
    /// store call.
    public static func isMeaningful(_ contact: [String: Any]?) -> Bool {
        guard let contact else { return false }
        for key in ["displayName", "givenName", "familyName"] {
            if let value = contact[key] as? String,
               !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        }
        for key in ["phones", "emails"] {
            if let value = contact[key] as? [Any], !value.isEmpty { return true }
        }
        return false
    }

    /// Can a write run?
    ///
    /// A limited read grant carries NO write right, and the refusal names the WRITE level
    /// specifically — a caller told to ask for "read" again would loop. Validity is checked
    /// after permission, so an unauthorised caller never learns whether its payload was
    /// well-formed.
    public static func writeDecision(_ access: String?,
                                     contact: [String: Any]? = nil,
                                     validate: Bool = false) -> ContactsDecision {
        let word = (access ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if word == "restricted" { return refuse("restricted", restrictedMessage, false) }
        guard word == "granted" else { return refuse("permission_denied", writeRefusal, true) }
        if validate, !isMeaningful(contact) { return refuse("invalid_contact", invalidMessage, true) }
        return allow("granted")
    }

    /// A platform label to the shared vocabulary. Apple wraps its constants as `_$!<Word>!$_`;
    /// Android hands over its own word already. Anything unrecognised is `other`.
    public static func normalizeLabel(_ raw: String?) -> String {
        var text = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let open = "_$!<"
        let close = ">!$_"
        if text.hasPrefix(open), text.hasSuffix(close), text.count > open.count + close.count {
            text = String(text.dropFirst(open.count).dropLast(close.count))
        }
        switch text.lowercased() {
        case "home":                       return "home"
        case "work":                       return "work"
        case "mobile", "iphone", "cell":   return "mobile"
        case "main":                       return "main"
        default:                           return "other"
        }
    }

    /// A birthday is an ISO date, never a locale string.
    public static func birthday(year: Int?, month: Int?, day: Int?) -> String? {
        guard let year, let month, let day else { return nil }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// A nameless contact still has a display name. `formatted` is the platform's own full-name
    /// rendering where it has one; the given/family join is the fallback.
    public static func displayName(givenName: String?, familyName: String?,
                                   formatted: String? = nil) -> String {
        let platform = (formatted ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !platform.isEmpty { return platform }
        let given = (givenName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let family = (familyName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let joined = "\(given) \(family)".trimmingCharacters(in: .whitespacesAndNewlines)
        return joined.isEmpty ? unnamed : joined
    }

    /// `fields` subsets the hydrated shape and drops nothing else in: `id` always survives, and
    /// the requested fields keep the order the caller asked for.
    public static func subset(_ contact: [String: Any], fields: [String]?) -> [String: Any] {
        guard let fields, !fields.isEmpty else { return contact }
        var out: [String: Any] = [:]
        if let id = contact["id"] { out["id"] = id }
        for field in fields where field != "id" {
            if let value = contact[field] { out[field] = value }
        }
        return out
    }

    /// The ORDER `subset` produces, which a Swift dictionary cannot carry. The corpus pins the
    /// key list, so the ordering rule lives here rather than in whatever the platform's map
    /// happens to iterate.
    public static func subsetKeys(_ contact: [String: Any], fields: [String]?) -> [String] {
        guard let fields, !fields.isEmpty else { return Array(contact.keys) }
        var out: [String] = []
        if contact["id"] != nil { out.append("id") }
        for field in fields where field != "id" {
            if contact[field] != nil { out.append(field) }
        }
        return out
    }

    /// The picker fold.
    ///
    /// A dismissal RESOLVES cancelled — the user declining is an outcome the caller branches on,
    /// not an error it should log. A platform with no multi-select SAYS SO (`multiple: false`)
    /// rather than quietly returning a one-element array, and a browser with no Contact Picker
    /// API refuses in type rather than resolving an empty list.
    public static func pickOutcome(multiple: Bool = false,
                                   fields: [String]? = nil,
                                   picked: [[String: Any]]? = nil,
                                   multiSelect: Bool? = nil,
                                   pickerAvailable: Bool? = nil) -> ContactPickOutcome {
        if pickerAvailable == false {
            return ContactPickOutcome(contacts: [], cancelled: false, prompted: false,
                                      multiple: nil, error: "unsupported_platform")
        }
        let degraded: Bool? = (multiple && multiSelect == false) ? false : nil
        guard let picked else {
            return ContactPickOutcome(contacts: [], cancelled: true, prompted: false,
                                      multiple: degraded, error: nil)
        }
        return ContactPickOutcome(contacts: picked.map { subset($0, fields: fields) },
                                  cancelled: false, prompted: false, multiple: degraded, error: nil)
    }
}
