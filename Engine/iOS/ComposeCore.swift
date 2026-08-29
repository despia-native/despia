//
//  ComposeCore.swift — the shared Core/Compose core: the composer result vocabulary and its
//  fidelity ladder, the (empty) permission surface, the capability disclosure, the recipient cap
//  and the attachment rule. The law is the corpus,
//  `OpenSource/Conformance/compose/result.json` (parity F13); the Kotlin twin is `:core`
//  ComposeCore.kt and the web twin is @despia/kernel's compose-core.ts.
//
//  `dsx.module.compose.{sms,mail}` PRESENT the system composer prefilled and NEVER SEND: the
//  user reads the message in their own messaging or mail app and taps send there. That is why no
//  permission is involved on any renderer, and why no SEND_SMS row exists anywhere.
//
//  No MessageUI import: this file is pure so the record lane can run it headless.
//
import Foundation

/// What a composer settled as, plus what it is honest to say about the body it rendered.
public struct ComposeOutcome: Equatable {
    public let result: String?
    /// false when HTML was asked for and the composer degraded it; nil when nothing degraded.
    public let isHtml: Bool?
    public let error: String?
}

/// What `capabilities` discloses.
public struct ComposeCapabilities: Equatable {
    public let sms: Bool
    public let mail: Bool
    /// Present only where the platform discloses it: Android names the resolving package, iOS
    /// never does, and a browser cannot observe whether a handler exists at all.
    public let defaultMailClient: String?
}

/// A refusal or a go-ahead, in the shape every compose action reports.
public struct ComposeDecision: Equatable {
    public let runs: Bool
    public let error: String?
    public let message: String?
}

public enum ComposeCore {

    /// Everything a composer may settle as. `saved` is a mail-draft outcome only.
    public static let results: [String] = ["sent", "cancelled", "saved", "failed", "unknown"]

    /// renderer -> action -> the results it can actually report.
    ///
    /// iOS MessageUI reports exactly what the user did; Android's ACTION_SENDTO has no result
    /// callback at all and a browser's mailto: link has none either. `unknown` must never be
    /// upgraded to `sent` because the intent launched: a caller that cannot trust `sent` has no
    /// reason to read the field.
    public static let resultFidelity: [String: [String: [String]]] = [
        "ios": ["sms": ["sent", "cancelled", "failed"],
                "mail": ["sent", "saved", "cancelled", "failed"]],
        "android": ["sms": ["unknown"], "mail": ["unknown"]],
        "web": ["sms": ["unknown"], "mail": ["unknown"]],
    ]

    /// Every action on every renderer: none. This table is the contract.
    public static let permissionSurface: [String: String] = [
        "sms": "none",
        "mail": "none",
        "capabilities": "none",
    ]

    /// An SMS permission appearing in the merged manifest is a build regression, not a feature.
    public static let forbiddenPermissions: [String] = [
        "android.permission.SEND_SMS",
        "android.permission.READ_SMS",
        "android.permission.RECEIVE_SMS",
    ]

    /// Renderers whose composer can render an HTML mail body. Everywhere else an `isHtml`
    /// request is served as plain text and SAYS SO, the `applied: false` convention rather than
    /// shipping markup as text.
    private static let htmlCapable: [String] = ["ios"]

    public static let tooManyRecipientsMessage = "Too many recipients for one message."
    public static let attachmentFailedMessage = "An attachment could not be prepared for the composer."

    private static let allowed = ComposeDecision(runs: true, error: nil, message: nil)

    /// The result ladder. A composer that reports gets its word through verbatim; one that
    /// cannot report says `unknown`, which is a different answer from `no_composer` — the first
    /// means the composer opened and this app will never learn what happened, the second means
    /// it never opened.
    public static func outcome(renderer: String,
                               composerResult: String? = nil,
                               launched: Bool = true,
                               isHtml: Bool = false) -> ComposeOutcome {
        guard launched else { return ComposeOutcome(result: nil, isHtml: nil, error: "no_composer") }
        let degraded: Bool? = (isHtml && !htmlCapable.contains(renderer)) ? false : nil
        return ComposeOutcome(result: composerResult ?? "unknown", isHtml: degraded, error: nil)
    }

    /// The Android resolver disambiguation activity resolves as the package `android`, which is
    /// not a real client: offering the button on the strength of it is the bug this filters.
    public static func resolverPackage(_ name: String?) -> String? {
        let text = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty || text == "android" ? nil : text
    }

    /// Ask before offering the button. A page can only promise that a composer may be ATTEMPTED.
    public static func capabilities(renderer: String,
                                    canText: Bool = false,
                                    canMail: Bool = false,
                                    smsResolver: String? = nil,
                                    mailResolver: String? = nil) -> ComposeCapabilities {
        switch renderer {
        case "web":
            return ComposeCapabilities(sms: true, mail: true, defaultMailClient: nil)
        case "android":
            let mail = resolverPackage(mailResolver)
            return ComposeCapabilities(sms: resolverPackage(smsResolver) != nil,
                                       mail: mail != nil, defaultMailClient: mail)
        default:
            return ComposeCapabilities(sms: canText, mail: canMail, defaultMailClient: nil)
        }
    }

    /// The recipient cap is config (`max_recipients`, default 100), because no platform constant
    /// exists and clients truncate silently somewhere past a few dozen. A composer that opens
    /// with half the list is worse than one that refuses. Mail counts to + cc + bcc together.
    public static func recipientDecision(count: Int, cap: Int) -> ComposeDecision {
        count > cap
            ? ComposeDecision(runs: false, error: "too_many_recipients", message: tooManyRecipientsMessage)
            : allowed
    }

    /// Local files only. A remote URL is not fetched on the caller's behalf and the web cannot
    /// attach at all — a composer that opens quietly missing what the caller attached is worse
    /// than one that refuses, so every failure is `attachment_failed`.
    public static func attachmentDecision(renderer: String,
                                          path: String?,
                                          insideRoots: Bool? = nil,
                                          exists: Bool? = nil) -> ComposeDecision {
        let refused = ComposeDecision(runs: false, error: "attachment_failed",
                                      message: attachmentFailedMessage)
        guard renderer != "web" else { return refused }
        let text = (path ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return refused }
        guard text.hasPrefix("/") || text.hasPrefix("file://") else { return refused }
        if exists == false { return refused }
        if insideRoots == false { return refused }
        return allowed
    }
}
