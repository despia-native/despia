//
//  Diagnostics.swift — the kernel's ON-DEVICE issues panel (TEST channels only).
//
//  The failure philosophy this file exists to kill: "log it and render empty." A component
//  whose markup fails to parse registers as NOTHING, and every push of it renders a silent
//  blank screen — and on a TestFlight build (a RELEASE build) even the kernelLog is invisible
//  (no console, no Xcode). QA then debugs a black rectangle.
//
//  What ships instead, all fail-closed to production (`AppEnvironment.current.isTest` gates
//  every visible behavior; an App Store install renders exactly what it rendered before):
//    · DSXIssue / StackDiagnostics — STRUCTURED issues, code-editor style: the component,
//      the parser's reason, the exact line:column, a source EXCERPT with the offending line
//      marked, and a plain-language hint ("unescaped quote in an attribute — write &quot;").
//      Recorded at the bootstrap/define parse-failure sites in Stack.swift.
//    · AUTO-PRESENT — the moment an issue is recorded on a test install, the issues panel
//      pops over whatever is on screen (debounced, once per new-issues batch, retries until
//      a scene exists so bootstrap-time failures surface right after first frame).
//    · DevOverlay — the dev-surface WINDOW: one dedicated UIWindow above the app's entire
//      hierarchy, hosting the dev center drawer (its own nested nav, off the app route)
//      and this panel, torn down the moment the last sheet leaves. Nothing dev ever opens
//      underneath the UI it inspects.
//    · StackDiagnosticCard — the red in-place placeholder rendered WHERE a component failed
//      to resolve, instead of silent blank. Tap → the panel.
//    · DSXDiagnosticsView — the panel: issue cards + excerpts, the kernel-log tail, with
//      Copy all (UIPasteboard) and Share/Download (.txt via UIActivityViewController) so a
//      tester exports the whole state into a bug report. No console, no Xcode, no setup.
//
//  Kernel-legal: names no package, imports no WebKit; UIKit/SwiftUI only (like RouterHost).
//  Modules reach it as a kernel primitive (DevSettings' Diagnostics row calls `present()`).
//

import SwiftUI
import UIKit

// MARK: - The structured issue

/// One line of a source excerpt (code-editor style: gutter number + text + error marker).
struct DSXIssueLine: Identifiable {
    let no: Int
    let text: String
    let isError: Bool
    var id: Int { no }
}

/// One recorded issue — everything a tester needs to fix the markup without a console.
struct DSXIssue: Identifiable {
    let id: Int
    let component: String        // "demo.Launcher"
    let reason: String           // the parser's error, e.g. "not well-formed (invalid token)"
    let line: Int                // 1-based; 0 = unknown
    let column: Int
    let excerpt: [DSXIssueLine]  // the offending line ± 2, error line marked
    let hint: String             // the plain-language explanation

    var headline: String { "\(component) — failed to parse" }
    var location: String { line > 0 ? "line \(line), column \(column)" : "location unknown" }

    /// The plain-text form (the copy/share report's body). Plain ASCII markers so the
    /// export pastes cleanly anywhere (issue trackers, terminals, mail).
    var text: String {
        var out = ["[error] \(headline) (\(location))", "  reason: \(reason)"]
        for l in excerpt { out.append("  \(l.isError ? ">" : " ") \(l.no) | \(l.text)") }
        out.append("  hint: \(hint)")
        return out.joined(separator: "\n")
    }
}

// MARK: - The ledger + auto-present

public enum StackDiagnostics {

    private static let lock = NSLock()
    private static var issueList: [DSXIssue] = []
    private static var failedNames: Set<String> = []
    private static var issueSeq = 0
    private static var surfacedCount = 0   // issues already auto-presented (once per batch)

    /// Record a template that FAILED TO PARSE (it registers as nothing — every use renders
    /// empty). Re-parses the LINE-STABLE lifted source to capture the exact line:column and
    /// reason, cuts the excerpt from the ORIGINAL source, maps a hint, kernelLogs a summary,
    /// and (test channels) schedules the auto-present.
    static func recordParseFailure(name: String, scope: String, xml: String) {
        let component = scope.isEmpty ? name : "\(scope).\(name)"
        let (line, column, reason) = parseError(in: lineStableLift(xml))
        let issue: DSXIssue
        lock.lock()
        issueSeq += 1
        issue = DSXIssue(id: issueSeq, component: component, reason: reason,
                         line: line, column: column,
                         excerpt: excerpt(of: xml, line: line), hint: hint(for: reason))
        issueList.append(issue)
        failedNames.insert(name)
        failedNames.insert(component)
        lock.unlock()
        kernelLog("[Stack] \(component) FAILED TO PARSE at \(issue.location) — \(reason); not registered, every <\(name)/> renders empty")
        scheduleAutoPresent()
    }

    /// All recorded issues, oldest first.
    static var issues: [DSXIssue] { lock.lock(); defer { lock.unlock() }; return issueList }

    /// The recorded parse-issue count — the dev center Console's escalation banner reads
    /// this (public: dev tooling lives in a module, the ledger in the kernel).
    public static var issueCount: Int { issues.count }

    /// Did THIS tag's template fail to parse? (Distinct from "never shipped" — the dynamic
    /// `<node tag=…/>` capability boundary is legitimate fail-open and must stay silent;
    /// only a KNOWN-dead registration earns the card there.)
    static func failedToParse(_ tag: String) -> Bool {
        guard AppEnvironment.current.isTest else { return false }
        lock.lock(); defer { lock.unlock() }
        if failedNames.contains(tag) { return true }
        if let dot = tag.lastIndex(of: ".") {
            return failedNames.contains(String(tag[tag.index(after: dot)...]))
        }
        return false
    }

    /// Should an unresolved LITERAL component reference show the card? Any Capitalized or
    /// dotted tag that resolved to nothing is an authoring error (typo / parse failure /
    /// missing registration) — on test channels that must be visible, never a silent blank.
    static func flagsUnresolved(_ tag: String) -> Bool {
        guard AppEnvironment.current.isTest else { return false }
        return tag.first?.isUppercase == true || tag.contains(".")
    }

    /// Present the panel over whatever is on screen (the DevSettings Diagnostics row, the
    /// dev deep link, or any native caller). Rides the dev overlay WINDOW — above the web
    /// view, native frames and any presented layer — never the app's own view hierarchy.
    /// No-op on production installs (double-gated: here and inside DevOverlay).
    public static func present() {
        guard AppEnvironment.current.isTest else { return }
        DevOverlay.presentSheet(UIHostingController(rootView: DSXDiagnosticsView()), tag: "diagnostics")
    }

    /// AUTO-PRESENT: pop the panel the moment a NEW issue lands on a test install — the
    /// "error becomes visible, copyable UI" contract. The panel rides the dev overlay
    /// window, so it opens over ANYTHING (a modal, the browser tab, a fullscreen web view);
    /// the only wait is boot itself — bootstrap failures record before a scene exists, so
    /// retry until one is up (2 s initial settle, then 1 s steps, ~20 s budget). Once per
    /// new-issues batch: a panel the tester closed does not reopen for the same issues.
    private static func scheduleAutoPresent() {
        guard AppEnvironment.current.isTest else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { attemptAutoPresent(retries: 18) }
    }

    private static func attemptAutoPresent(retries: Int) {
        lock.lock(); let pending = issueList.count > surfacedCount; lock.unlock()
        guard pending else { return }
        guard DevOverlay.canHost else {
            if retries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { attemptAutoPresent(retries: retries - 1) }
            }
            return
        }
        lock.lock(); surfacedCount = issueList.count; lock.unlock()
        present()
    }

    /// The full copyable/downloadable report: app identity + channel + every issue (with
    /// excerpt + hint) + the error ledger + the dsx.log ring + the kernel-log tail.
    /// Exactly what Copy all / Share exports — here AND in the dev center Console
    /// (public for the same reason as `issueCount`).
    public static func report() -> String {
        let app = DSXApp()
        var out: [String] = []
        out.append("DSX diagnostics — \(app.name) v\(app.version) (\(app.build)) · channel: \(AppEnvironment.current.rawValue)")
        out.append("host: \(app.host.isEmpty ? "—" : app.host)")
        let list = issues
        out.append("")
        out.append("── issues (\(list.count)) ──")
        out.append(list.isEmpty ? "none — every shipped template parsed and registered"
                                : list.map(\.text).joined(separator: "\n\n"))
        out.append("")
        let errors = DSXErrorLedger.shared.recent()
        out.append("── recent errors (\(errors.count) retained · \(DSXErrorLedger.shared.count()) total) ──")
        out.append(errors.isEmpty ? "none — the error ledger is empty"
                                  : errors.map { e in
                                        var line = "[\(e.origin)] \(e.scheme) → \(e.code)"
                                        if let m = e.message { line += " — \(m)" }
                                        if e.recoverable { line += " (recoverable)" }
                                        if let d = e.delivered { line += d ? "" : " (fire-and-forget — never reached the call site)" }
                                        return line
                                    }.joined(separator: "\n"))
        out.append("")
        let logLines = DSXLogBuffer.shared.recent()
        out.append("── dsx.log ring (\(logLines.count) retained · \(DSXLogBuffer.shared.count()) total · newest last) ──")
        out.append(logLines.isEmpty ? "empty"
                                    : logLines.map { "[\($0.level)] \($0.scheme): \($0.message)" }.joined(separator: "\n"))
        out.append("")
        out.append("── kernel log (newest last; includes [dsx.log] lines) ──")
        let tail = KernelLogBuffer.shared.snapshot()
        out.append(tail.isEmpty ? "empty" : tail.joined(separator: "\n"))
        return out.joined(separator: "\n")
    }

    // MARK: parse-error introspection (code-editor context)

    /// Blank comments + code-element bodies LINE-STABLY (every non-newline char → space),
    /// so a strict re-parse reports SOURCE-TRUE line numbers (raw JS in <script>/<action>
    /// bodies never trips it, and the excerpt lines up with the file the author edits).
    /// Mirrors lint_dsx.rb's lift; the runtime's own liftCode is placeholder-based (not
    /// line-stable), which is fine for rendering but wrong for locating errors.
    private static func lineStableLift(_ xml: String) -> String {
        var s = blank(xml, pattern: "<!--[\\s\\S]*?-->", group: 0)
        s = blank(s, pattern: "<(script|action|formula|variable|var|let)\\b[^>]*?>([\\s\\S]*?)</\\1>", group: 2)
        return s
    }

    private static func blank(_ s: String, pattern: String, group: Int) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return s }
        let ns = NSMutableString(string: s)
        let matches = re.matches(in: s, range: NSRange(location: 0, length: ns.length))
        for m in matches.reversed() {
            let r = m.range(at: group)
            guard r.location != NSNotFound, r.length > 0 else { continue }
            let blanked = ns.substring(with: r).map { $0 == "\n" ? "\n" : " " }.joined()
            ns.replaceCharacters(in: r, with: blanked)
        }
        return ns as String
    }

    /// Strict-parse and return (line, column, reason) of the first error.
    private static func parseError(in lifted: String) -> (Int, Int, String) {
        let p = XMLParser(data: Data(lifted.utf8))
        _ = p.parse()
        let reason = p.parserError?.localizedDescription ?? "malformed XML"
        return (p.lineNumber, p.columnNumber, reason)
    }

    /// The offending line ± 2 from the ORIGINAL source, error line marked. Long lines are
    /// clipped (the panel shows the gutter number, so the author finds the exact spot).
    private static func excerpt(of xml: String, line: Int) -> [DSXIssueLine] {
        guard line > 0 else { return [] }
        let lines = xml.components(separatedBy: "\n")
        guard !lines.isEmpty else { return [] }
        let idx = min(max(line - 1, 0), lines.count - 1)
        let lo = max(0, idx - 2), hi = min(lines.count - 1, idx + 2)
        return (lo...hi).map { i in
            DSXIssueLine(no: i + 1, text: String(lines[i].prefix(300)), isError: i == idx)
        }
    }

    /// The plain-language explanation for the parser's reason — the "what did I do wrong".
    private static func hint(for reason: String) -> String {
        let r = reason.lowercased()
        if r.contains("not well-formed") || r.contains("invalid token") || r.contains("invalid character") {
            return "Usually an unescaped character in an attribute or text: write &amp; for &, &lt; for <, and &quot; for a quote inside a double-quoted attribute (never a C-style \\\")."
        }
        if r.contains("attribute") {
            return "Attribute syntax is name=\"value\" — check for a missing =, an unescaped quote inside the value, or the same attribute written twice on one tag."
        }
        if r.contains("mismatch") || r.contains("tag") {
            return "Open and close tags must match exactly — check for an unclosed element, a stray </…>, or a self-closing tag written without the trailing /."
        }
        if r.contains("entit") {
            return "Unknown entity — only &amp; &lt; &gt; &quot; &apos; are predefined; a bare & must be written &amp;."
        }
        return "Run the CI linter locally for the same verdict: ruby ClosedSource/scripts/lint_dsx.rb --strict"
    }
}

// MARK: - The design tokens (the dev center's palette — Panel.dsx's dark glass language)

private enum DiagTheme {
    static let backdrop  = Color(hex: "#0B0B0D")   // near-black sheet backdrop
    static let card      = Color(hex: "#131316")   // elevated card
    static let code      = Color(hex: "#0A0A0C")   // code-block well
    static let stroke    = Color.white.opacity(0.07)
    static let red       = Color(hex: "#FF453A")
    static let orange    = Color(hex: "#FF9F0A")
    static let green     = Color(hex: "#30D158")
    static let secondary = Color.white.opacity(0.55)
    static let tertiary  = Color.white.opacity(0.35)
}

/// A tinted rounded-square leading icon — the iOS-Settings-row / dev-center visual anchor.
private struct DiagIconBadge: View {
    let symbol: String
    let tint: Color
    var size: CGFloat = 32
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(tint.opacity(0.16))
            Image(systemName: symbol)
                .font(.system(size: size * 0.44, weight: .semibold))
                .foregroundColor(tint)
        }
        .frame(width: size, height: size)
    }
}

// MARK: - The in-place card

/// The placeholder where a component failed to render — TEST channels only (the caller
/// gates on `flagsUnresolved`/`failedToParse`, both fail-closed to production).
/// Deliberately visible, quietly styled: a tinted card with the failure named, tappable
/// to the issues panel. Adaptive colors (it renders over arbitrary app content).
struct StackDiagnosticCard: View {
    let tag: String
    @State private var showPanel = false
    var body: some View {
        Button { showPanel = true } label: {
            HStack(alignment: .center, spacing: 10) {
                DiagIconBadge(symbol: "exclamationmark.triangle.fill", tint: .red, size: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("<\(tag)/> failed to render")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.red)
                    Text("Malformed markup or a missing component — tap for the exact error. Test builds only.")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.red.opacity(0.6))
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.red.opacity(0.07))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color.red.opacity(0.35), lineWidth: 1))
            )
            .padding(6)
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showPanel) { DSXDiagnosticsView() }
    }
}

// MARK: - The issues panel

/// The panel — the dev center's design language (deep black, elevated glass cards, tinted
/// icon squares, SF Symbols throughout): issue cards with code-editor excerpts, the
/// kernel-log tail, Copy all (UIPasteboard) and Export (.txt via the system share sheet).
/// A tester on TestFlight reads the exact error and exports the whole state — no console,
/// no Xcode, no setup.
struct DSXDiagnosticsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false
    private let issues = StackDiagnostics.issues
    private let recentErrors = DSXErrorLedger.shared.recent()
    private let logTail = KernelLogBuffer.shared.snapshot()
    private let app = DSXApp()

    var body: some View {
        ZStack {
            DiagTheme.backdrop.ignoresSafeArea()
            VStack(spacing: 0) {
                header
                    .padding(.horizontal, 20)
                    .padding(.top, 24)
                    .padding(.bottom, 14)
                actionRow
                    .padding(.horizontal, 20)
                    .padding(.bottom, 16)
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if issues.isEmpty { emptyState } else {
                            ForEach(issues) { IssueCard(issue: $0) }
                        }
                        errorSection
                        logSection
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 32)
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    /// The error LEDGER (error-system.md P2 "Recent errors"): every recorded DSXError —
    /// ambient dsx.error emissions, failed bus calls (with the fire-and-forget flag), and
    /// uncaught markup throws — newest first, capped by the ring (128).
    private var errorSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                DiagIconBadge(symbol: "exclamationmark.bubble.fill", tint: DiagTheme.orange, size: 26)
                Text("Recent errors")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white)
                Text("\(recentErrors.count) retained · \(DSXErrorLedger.shared.count()) total")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(DiagTheme.tertiary)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(Color.white.opacity(0.06)))
                Spacer()
            }
            .padding(.top, 12)
            if recentErrors.isEmpty {
                Text("none — the error ledger is empty")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(DiagTheme.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(DiagTheme.code)
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(DiagTheme.stroke, lineWidth: 1)))
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(recentErrors.enumerated().reversed()), id: \.offset) { _, e in
                        ErrorRow(error: e)
                    }
                }
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(DiagTheme.code)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(DiagTheme.stroke, lineWidth: 1)))
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            DiagIconBadge(symbol: issues.isEmpty ? "checkmark.seal.fill" : "exclamationmark.triangle.fill",
                          tint: issues.isEmpty ? DiagTheme.green : DiagTheme.red, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(issues.isEmpty ? "Diagnostics" : "\(issues.count) issue\(issues.count == 1 ? "" : "s")")
                    .font(.system(size: 22, weight: .heavy))
                    .foregroundColor(.white)
                Text("\(app.name) v\(app.version) (\(app.build)) · \(AppEnvironment.current.rawValue)")
                    .font(.system(size: 12))
                    .foregroundColor(DiagTheme.secondary)
            }
            Spacer()
            Button { dismiss() } label: {
                ZStack {
                    Circle().fill(Color.white.opacity(0.08))
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(DiagTheme.secondary)
                }
                .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
        }
    }

    private var actionRow: some View {
        HStack(spacing: 10) {
            actionButton(symbol: copied ? "checkmark" : "doc.on.doc",
                         title: copied ? "Copied" : "Copy all",
                         tint: copied ? DiagTheme.green : .white) {
                UIPasteboard.general.string = StackDiagnostics.report()
                copied = true
            }
            actionButton(symbol: "square.and.arrow.up", title: "Export .txt", tint: .white) { share() }
        }
    }

    private func actionButton(symbol: String, title: String, tint: Color,
                              _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: symbol).font(.system(size: 13, weight: .semibold))
                Text(title).font(.system(size: 14, weight: .semibold))
            }
            .foregroundColor(tint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Capsule().fill(Color.white.opacity(0.08)))
        }
        .buttonStyle(.plain)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            DiagIconBadge(symbol: "checkmark.seal.fill", tint: DiagTheme.green, size: 52)
            Text("No issues")
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(.white)
            Text("Every shipped template parsed and registered.")
                .font(.system(size: 13))
                .foregroundColor(DiagTheme.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(DiagTheme.card)
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(DiagTheme.stroke, lineWidth: 1)))
    }

    private var logSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                DiagIconBadge(symbol: "terminal.fill", tint: Color(hex: "#0A84FF"), size: 26)
                Text("Kernel log")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white)
                Text("\(logTail.count) lines")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(DiagTheme.tertiary)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(Color.white.opacity(0.06)))
                Spacer()
            }
            .padding(.top, 12)
            Text(logTail.isEmpty ? "empty" : logTail.joined(separator: "\n"))
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(DiagTheme.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(DiagTheme.code)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(DiagTheme.stroke, lineWidth: 1)))
        }
    }

    /// Export the report as a text FILE through the system share sheet (save to Files,
    /// AirDrop, mail it — the "download the whole log" path).
    private func share() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("dsx-diagnostics.txt")
        try? StackDiagnostics.report().data(using: .utf8)?.write(to: url)
        guard let top = UIApplication.topViewController() else { return }
        let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        activity.popoverPresentationController?.sourceView = top.view   // iPad anchor
        top.present(activity, animated: true)
    }
}

/// One error-ledger row: origin badge (raised / call / uncaught), `scheme → code`, the
/// message, and the advisory flags (recoverable, fire-and-forget). Newest rows render
/// first (the section reverses).
private struct ErrorRow: View {
    let error: DSXError

    private var tint: Color {
        switch error.origin {
        case "uncaught": return DiagTheme.red
        case "call":     return DiagTheme.orange
        default:          return Color(hex: "#0A84FF")
        }
    }

    private var flags: String {
        var parts: [String] = []
        if error.recoverable { parts.append("recoverable") }
        if error.delivered == false { parts.append("fire-and-forget") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(error.origin)
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundColor(tint)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Capsule().fill(tint.opacity(0.14)))
                .frame(width: 72, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(error.scheme) → \(error.code)")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundColor(.white)
                if let m = error.message, !m.isEmpty {
                    Text(m)
                        .font(.system(size: 10))
                        .foregroundColor(DiagTheme.secondary)
                        .lineLimit(3)
                }
                if !flags.isEmpty {
                    Text(flags)
                        .font(.system(size: 9))
                        .foregroundColor(DiagTheme.tertiary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .textSelection(.enabled)
    }
}

/// One issue, code-editor style: tinted icon square + headline, the location pill, the
/// parser's reason, the gutter-numbered source excerpt with the offending line highlighted,
/// and the plain-language hint.
private struct IssueCard: View {
    let issue: DSXIssue
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                DiagIconBadge(symbol: "xmark.octagon.fill", tint: DiagTheme.red, size: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(issue.component)
                        .font(.system(size: 14, weight: .semibold, design: .monospaced))
                        .foregroundColor(.white)
                    Text("failed to parse — not registered")
                        .font(.system(size: 11))
                        .foregroundColor(DiagTheme.red)
                }
                Spacer()
                Text(issue.location)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(DiagTheme.secondary)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Capsule().fill(Color.white.opacity(0.06)))
            }
            Text(issue.reason)
                .font(.system(size: 12))
                .foregroundColor(DiagTheme.secondary)
            if !issue.excerpt.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(issue.excerpt) { l in
                        HStack(alignment: .top, spacing: 10) {
                            Text("\(l.no)")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(l.isError ? DiagTheme.red : DiagTheme.tertiary)
                                .frame(width: 32, alignment: .trailing)
                            Text(l.text)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(l.isError ? DiagTheme.red : Color.white.opacity(0.85))
                                .lineLimit(3)
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 2)
                        .padding(.horizontal, 6)
                        .background(l.isError ? DiagTheme.red.opacity(0.10) : Color.clear)
                    }
                }
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(DiagTheme.code)
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(DiagTheme.stroke, lineWidth: 1)))
                .textSelection(.enabled)
            }
            HStack(alignment: .top, spacing: 8) {
                DiagIconBadge(symbol: "lightbulb.fill", tint: DiagTheme.orange, size: 22)
                Text(issue.hint)
                    .font(.system(size: 11))
                    .foregroundColor(DiagTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(DiagTheme.card)
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(DiagTheme.stroke, lineWidth: 1)))
    }
}

// MARK: - DevOverlay — the dev-surface window (a drawer OVER everything)

/// The kernel's DEV presentation layer: one dedicated `UIWindow` ABOVE the app's entire
/// hierarchy — web view, native frames, UIKit-presented layers (in-app browser tab, file
/// picker, alerts) — so a dev drawer can never open underneath the UI it inspects. TEST
/// channels only: every entry is gated on `AppEnvironment.current.isTest`; production
/// never creates the window. The window exists only while something is presented in it —
/// the moment the last sheet leaves it is torn down and the previous key window restored,
/// so it can never eat a touch afterwards.
///
/// Two entries:
///   · `present(component:)` / `push` / `pop` / `dismiss` — the DSX drawer: a sheet
///     hosting the overlay's OWN navigation stack of component surfaces. The dev center's
///     nested pages live here, deliberately OFF the app's route — pushing dev pages onto
///     `nav.stack` would mutate the very navigation state the panel exists to inspect.
///   · `presentSheet(_:tag:)` — any native controller (the diagnostics panel) as a sheet
///     on top of whatever the overlay already shows, deduped by `tag`.
enum DevOverlay {

    private static var window: UIWindow?
    private static weak var restoreKey: UIWindow?
    private static weak var nav: DevOverlayNav?

    /// Is the DSX drawer up? (The dev module's "already open — never stack" guard.
    /// Distinct from the window existing: a lone diagnostics sheet is not the drawer.)
    static var isDrawerOpen: Bool { nav != nil }

    /// Can a sheet present right now? Mid-boot there may be no foreground scene yet —
    /// the auto-present retry loop probes this instead of presenting into nothing.
    static var canHost: Bool {
        window != nil || UIApplication.shared.connectedScenes.contains {
            ($0 as? UIWindowScene)?.activationState == .foregroundActive
        }
    }

    /// One NATIVE bar button on a dev page — kernel mechanism, module policy: the module
    /// names it (title and/or SF Symbol) and supplies the handler; the kernel renders a
    /// REAL `UIBarButtonItem` in the REAL navigation bar. No hand-rolled header pills.
    struct BarItem {
        let title: String?
        let icon: String?
        let handler: () -> Void
        init(title: String? = nil, icon: String? = nil, handler: @escaping () -> Void) {
            self.title = title; self.icon = icon; self.handler = handler
        }
    }

    // MARK: the DSX drawer

    /// Open the drawer with `component` (a QUALIFIED tag, e.g. "dev.Panel") as its root
    /// page. No-op when the drawer is already up, the channel is production, or the tag
    /// won't parse (the parse-failure ledger + card already surface the why).
    ///
    /// NATIVE CHROME: the drawer shows the REAL `UINavigationBar` — large `title`,
    /// `subtitle` under it on iOS 26, a system Close item (`UIBarButtonItem(systemItem:
    /// .close)`), module-supplied `barItems`, and the system back chevron + edge-swipe on
    /// every pushed page. Pages carry CONTENT only; headers/back buttons in markup are gone.
    static func present(component: String, vars: [String: Any]? = nil,
                        title: String? = nil, subtitle: String? = nil,
                        barItems: [BarItem] = [], dsx: Context) {
        guard AppEnvironment.current.isTest else { return }
        DispatchQueue.main.async {
            guard nav == nil, let host = host(),
                  let page = pageController(component, vars: vars, dsx: dsx) else { return }
            configure(page, title: title, subtitle: subtitle, barItems: barItems,
                      large: true, close: { dismiss() })
            let stack = DevOverlayNav(rootViewController: page)
            stack.modalPresentationStyle = .pageSheet
            // HALF-STACKED (the player-drawer feel, requested UX): the dev center opens at the
            // MEDIUM detent — the app stays visible behind it — and drags to full. An inner
            // sheet (Console / diagnostics) expands this drawer to LARGE and stacks itself at
            // medium over it (presentSheet), so the layers nest the way system sheets do.
            if let sheet = stack.sheetPresentationController {
                sheet.detents = [.medium(), .large()]
                sheet.selectedDetentIdentifier = .medium
                sheet.prefersGrabberVisible = true
                sheet.prefersScrollingExpandsWhenScrolledToEdge = true
            }
            nav = stack
            host.present(stack, animated: true)
        }
    }

    /// Push a nested page inside the drawer (no-op without an open drawer). `replace`
    /// swaps the TOP page for a fresh one instead (the dev center's Refresh). The page
    /// gets the system bar: inline `title`, the REAL back chevron (free), `barItems`.
    static func push(component: String, vars: [String: Any]? = nil, replace: Bool = false,
                     title: String? = nil, barItems: [BarItem] = [], dsx: Context) {
        guard AppEnvironment.current.isTest else { return }
        DispatchQueue.main.async {
            guard let stack = nav, let page = pageController(component, vars: vars, dsx: dsx) else { return }
            configure(page, title: title, barItems: barItems, large: false, close: nil)
            if replace, stack.viewControllers.count > 1 {
                stack.setViewControllers(Array(stack.viewControllers.dropLast()) + [page], animated: false)
            } else {
                stack.pushViewController(page, animated: true)
            }
        }
    }

    /// Back one page; at the drawer's root there is nothing to go back to, so the whole
    /// drawer closes instead (back == leave).
    static func pop() {
        DispatchQueue.main.async {
            guard let stack = nav else { return }
            if stack.viewControllers.count > 1 { stack.popViewController(animated: true) }
            else { dismiss() }
        }
    }

    /// Close the whole overlay: everything presented in the window dismisses, then the
    /// window tears down (restoring the previous key window).
    static func dismiss() {
        DispatchQueue.main.async {
            guard let root = window?.rootViewController else { return }
            if let presented = root.presentedViewController {
                presented.dismiss(animated: true) { teardownIfEmpty() }
            } else {
                teardownIfEmpty()
            }
        }
    }

    // MARK: any native controller (the diagnostics panel)

    /// Present `vc` as a sheet in the overlay window, above whatever it already shows.
    /// `tag` dedupes: the same sheet already up anywhere in the window → no-op.
    /// STACKING: the drawer beneath expands to LARGE and the new sheet opens at MEDIUM
    /// (drag to full) — the nested system-sheet look the dev center's inner layers share.
    static func presentSheet(_ vc: UIViewController, tag: String) {
        guard AppEnvironment.current.isTest else { return }
        DispatchQueue.main.async {
            var walk = window?.rootViewController
            while let c = walk {
                if (c as? DevOverlaySheet)?.tag == tag { return }
                walk = c.presentedViewController
            }
            guard let host = host() else { return }
            if let drawer = nav?.sheetPresentationController {
                drawer.animateChanges { drawer.selectedDetentIdentifier = .large }
            }
            let sheet = DevOverlaySheet(vc, tag: tag)
            if let sp = sheet.sheetPresentationController {
                sp.detents = [.medium(), .large()]
                sp.selectedDetentIdentifier = .medium
                sp.prefersGrabberVisible = true
                sp.prefersScrollingExpandsWhenScrolledToEdge = true
            }
            host.present(sheet, animated: true)
        }
    }

    /// Present a COMPONENT surface as a stacked sheet (the Console) — the DSX twin of
    /// `presentSheet(_:tag:)`: builds the page controller for the qualified tag, seeds
    /// `vars`, and stacks it with the same detent choreography — wrapped in its OWN
    /// navigation controller so the sheet gets the REAL system bar: inline `title`,
    /// module `barItems`, and the system Close item (closes THIS sheet, the drawer stays).
    static func presentSheet(component: String, vars: [String: Any]? = nil, dsx: Context, tag: String,
                             title: String? = nil, barItems: [BarItem] = []) {
        guard AppEnvironment.current.isTest else { return }
        DispatchQueue.main.async {
            guard let page = pageController(component, vars: vars, dsx: dsx) else { return }
            if title != nil || !barItems.isEmpty {
                configure(page, title: title, barItems: barItems, large: false, close: { dismissTopSheet() })
                presentSheet(UINavigationController(rootViewController: page), tag: tag)
            } else {
                presentSheet(page, tag: tag)
            }
        }
    }

    /// Dismiss ONLY the topmost stacked sheet (the Console's ✕) — the drawer beneath stays
    /// up. A plain `dismiss()` would tear the whole overlay down.
    static func dismissTopSheet() {
        DispatchQueue.main.async {
            var top = window?.rootViewController
            while let presented = top?.presentedViewController { top = presented }
            if top is DevOverlaySheet { top?.dismiss(animated: true) }
        }
    }

    // MARK: plumbing

    /// The topmost controller IN THE OVERLAY WINDOW to present from — creates the window
    /// on first use. nil = no scene to attach to (backgrounded); callers simply skip.
    private static func host() -> UIViewController? {
        if window == nil {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
            else { return nil }
            restoreKey = scene.windows.first { $0.isKeyWindow }
            let w = UIWindow(windowScene: scene)
            w.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.alert.rawValue + 1)
            w.backgroundColor = .clear
            let root = UIViewController()
            root.view.backgroundColor = .clear
            w.rootViewController = root
            w.makeKeyAndVisible()   // key: the panel's alerts/keyboard/share sheets land HERE (topViewController walks the key window)
            window = w
        }
        var top = window?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }

    /// Build the hosting controller for a QUALIFIED component tag (the Router's name-only
    /// recipe: parse `<tag/>`, seed `vars` into the surface's store). The controller's
    /// root view retains the store/env, so the page lives exactly as long as it is shown —
    /// its timers/sockets cancel when it leaves the drawer (StackStore.deinit).
    private static func pageController(_ component: String, vars: [String: Any]?, dsx: Context) -> UIViewController? {
        let tag = component.trimmingCharacters(in: .whitespaces)
        guard !tag.isEmpty, let root = StackXML.parse("<\(tag)/>") else {
            kernelLog("[DevOverlay] \"\(component)\" no-op — empty or unparsable component tag")
            return nil
        }
        let surface = StackSurface(root: root, webView: dsx.shared.use("web") as? UIView, scope: nil, dsx: dsx)
        if let vars, !vars.isEmpty { surface.store.set("vars", vars) }
        let page = surface.controller
        // OPAQUE ADAPTIVE backdrop on the HOST view — the system grouped background (black in
        // dark, grouped grey in light), following the trait/appearance override like every
        // other native surface. Dev markup paints CONTENT only (cards, rows), never a page
        // fill: an unset host background left the sheet's opacity to a hardcoded #000000
        // SwiftUI layer, which both broke light mode (transparent Console over a system sheet)
        // and met the sheet's corner mask as a hard un-antialiased edge.
        page.view.backgroundColor = .systemGroupedBackground
        return page
    }

    /// Give a dev page its NATIVE bar: title (large on the drawer root, inline on pushed
    /// pages/sheets), iOS 26 subtitle, module bar items as real `UIBarButtonItem`s, and —
    /// when `close` is set — the system Close item (trailing-most, the standard sheet spot).
    private static func configure(_ page: UIViewController, title: String?, subtitle: String? = nil,
                                  barItems: [BarItem], large: Bool, close: (() -> Void)?) {
        if let title { page.navigationItem.title = title }
        page.navigationItem.largeTitleDisplayMode = large ? .always : .never
        #if compiler(>=6.2)
        if #available(iOS 26.0, *), let subtitle, !subtitle.isEmpty {
            page.navigationItem.subtitle = subtitle
        }
        #endif
        var trailing: [UIBarButtonItem] = []
        if let close {
            trailing.append(UIBarButtonItem(systemItem: .close,
                                            primaryAction: UIAction { _ in close() }))
        }
        for item in barItems {
            trailing.append(UIBarButtonItem(primaryAction: UIAction(
                title: item.title ?? "",
                image: item.icon.flatMap(UIImage.init(systemName:))) { _ in item.handler() }))
        }
        if !trailing.isEmpty { page.navigationItem.rightBarButtonItems = trailing }   // first = trailing-most (Close at the edge)
    }

    /// Tear the window down once NOTHING is presented in it any more — the window must
    /// never outlive its content (an empty top window would eat every touch).
    fileprivate static func teardownIfEmpty() {
        guard let w = window, w.rootViewController?.presentedViewController == nil else { return }
        w.isHidden = true
        window = nil
        restoreKey?.makeKey()
    }
}

/// The drawer's navigation stack: the REAL `UINavigationBar` — large title on the root,
/// the system back chevron + native edge-swipe on pushed pages (UIKit provides both because
/// the bar is visible; the old hidden-bar + gesture-delegate shim is gone) — plus the
/// dismissal hook: `viewDidDisappear` catches EVERY way the drawer can leave (grabber swipe,
/// the system Close item, a dismissal cascade) so the overlay can tear its window down.
private final class DevOverlayNav: UINavigationController {
    override func viewDidLoad() {
        super.viewDidLoad()
        navigationBar.prefersLargeTitles = true
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed { DevOverlay.teardownIfEmpty() }
    }
}

/// A sheet container for any native dev controller: embeds the child full-bleed, carries
/// the dedupe `tag`, and reports its own dismissal (swipe, an embedded SwiftUI `dismiss()`,
/// a programmatic dismiss — `viewDidDisappear` catches every path) so the overlay window
/// tears down after the last sheet leaves.
private final class DevOverlaySheet: UIViewController {
    let tag: String
    private let child: UIViewController

    init(_ child: UIViewController, tag: String) {
        self.child = child
        self.tag = tag
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("DevOverlaySheet is code-only") }

    override func viewDidLoad() {
        super.viewDidLoad()
        addChild(child)
        child.view.frame = view.bounds
        child.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(child.view)
        child.didMove(toParent: self)
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed { DevOverlay.teardownIfEmpty() }
    }
}
