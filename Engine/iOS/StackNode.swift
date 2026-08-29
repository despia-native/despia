//
//  StackNode.swift - the DSX AST + parser: the ONE grammar of the Stack engine.
//
//  Pure Foundation (no WebKit/UIKit), so the SAME parser compiles into the full
//  in-app engine (Stack.swift) AND into the extension-process render profile
//  (StackLive, in widget / Live-Activity targets, via extensionTargets
//  .extraSources). One grammar, one node model - only the render BACKEND differs
//  per surface (full SwiftUI in-app, the WidgetKit-safe subset in an extension,
//  Compose/Glance on Android). Extracted from Stack.swift so the kernel keeps a
//  single source of truth for what DSX means.
//

import Foundation

// MARK: - Node + XML parser

struct StackNode {
    let tag: String
    var attrs: [String: String]
    var children: [StackNode]
    var text: String? = nil
    var id: String { attrs["id"] ?? "" }
}

/// The platform-attribute fold shared by every Apple render product. Deployment
/// identity and render target are deliberately separate: a watch app keeps
/// `dsx.platform.os == "ios"` (it is a node of the phone deployment), while its
/// attributes resolve against the exact `:watch` target. The same distinction is
/// mirrored by Android's Platform.attributeTarget for Wear OS.
enum StackPlatformAttrs {
    static let exactTargets: Set<String> =
        ["ios", "android", "web", "watch", "wear", "macos", "windows", "linux"]
    static let groups: [String: Set<String>] = [
        "native": ["ios", "android", "watch", "wear", "macos", "windows", "linux"],
        "desktop": ["macos", "windows", "linux"],
    ]

    static var runtimeTarget: String {
        #if os(watchOS)
        return "watch"
        #elseif targetEnvironment(macCatalyst) || os(macOS)
        return "macos"
        #else
        return "ios"
        #endif
    }

    static func resolve(_ attrs: [String: String], target: String) -> [String: String] {
        func tag(_ key: String) -> (base: String, suffix: String)? {
            guard let colon = key.lastIndex(of: ":"), colon != key.startIndex else { return nil }
            let suffix = String(key[key.index(after: colon)...])
            guard exactTargets.contains(suffix) || groups[suffix] != nil else { return nil }
            return (String(key[..<colon]), suffix)
        }
        guard attrs.keys.contains(where: { tag($0) != nil }) else { return attrs }
        var out: [String: String] = [:]
        var bySuffix: [String: [String: String]] = [:]
        for (key, value) in attrs {
            if let (base, suffix) = tag(key) { bySuffix[suffix, default: [:]][base] = value }
            else { out[key] = value }
        }
        for group in ["native", "desktop"] where groups[group]?.contains(target) == true {
            if let values = bySuffix[group] { out.merge(values) { _, new in new } }
        }
        if let exact = bySuffix[target] { out.merge(exact) { _, new in new } }
        return out
    }

    static func resolve(_ node: StackNode, target: String) -> StackNode {
        var copy = node
        copy.attrs = resolve(node.attrs, target: target)
        copy.children = node.children.map { resolve($0, target: target) }
        return copy
    }
}

/// Renderer-neutral desktop input grammar: `shortcut=` accelerator matching + `focusOrder=`
/// traversal resolution. Gated by OpenSource/Conformance/input/{shortcut,focusOrder}.json and
/// executed by all three runtimes (the DOM/Compose/SwiftUI adapters supply the raw event
/// fields; these pure rules decide the outcome identically everywhere).
enum StackDesktopInput {
    /// Parse a `shortcut=` declaration into (key, modifiers): lowercased, split on '+', trimmed,
    /// empties dropped; the LAST token is the key and the rest are modifiers.
    static func parseShortcut(_ shortcut: String) -> (key: String, mods: Set<String>) {
        let parts = shortcut.lowercased()
            .split(separator: "+", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard let key = parts.last else { return ("", []) }
        return (key, Set(parts.dropLast()))
    }

    /// Does this key event fire the accelerator? `cmd` is the primary modifier (matches meta OR
    /// ctrl); `ctrl`/`alt`/`shift` are literal; the key compares case-insensitively; an UNMODIFIED
    /// shortcut is suppressed while an editable target holds focus (typing is never stolen).
    static func matchesShortcut(_ shortcut: String, key: String, meta: Bool, ctrl: Bool,
                                alt: Bool, shift: Bool, editable: Bool) -> Bool {
        let (want, mods) = parseShortcut(shortcut)
        guard !want.isEmpty, key.lowercased() == want else { return false }
        if mods.contains("cmd") && !(meta || ctrl) { return false }
        if mods.contains("ctrl") && !ctrl { return false }
        if mods.contains("alt") && !alt { return false }
        if mods.contains("shift") && !shift { return false }
        if editable && !(mods.contains("cmd") || mods.contains("ctrl")) { return false }
        return true
    }

    /// The Return-key spellings the toolkits use (Compose `Enter`, DOM `Enter`/`NumpadEnter`,
    /// AppKit `Return`).
    static let returnKeys: Set<String> = ["enter", "return", "numpadenter"]

    /// What Return should do in a MULTILINE field. See the corpus for the full reasoning
    /// (OpenSource/Conformance/input/multiline-submit.json); the short version is that Return
    /// already means "newline" in a multiline field and must keep meaning it on a soft
    /// keyboard, so this grammar decides HARDWARE key events only.
    ///
    /// Returns `submit`, `newline`, or `ignore` - and the last two are different answers.
    /// `ignore` means this grammar has no opinion and the caller must NOT consume the event;
    /// `newline` means Return was handled and resolved to a break.
    static func multilineReturn(key: String, shift: Bool, meta: Bool, ctrl: Bool, alt: Bool,
                                submitOnEnter: Bool, hasSubmit: Bool) -> String {
        guard returnKeys.contains(key.lowercased()) else { return "ignore" }
        // The explicit line-break chords win over everything, including an authored
        // submitOnEnter: turning Enter-to-send on must not take away the way out of it.
        if shift || alt { return "newline" }
        if meta || ctrl { return hasSubmit ? "submit" : "ignore" }
        if submitOnEnter && hasSubmit { return "submit" }
        return "newline"
    }

    /// Resolve `focusOrder=` to a traversal index. A disabled control is ALWAYS out of traversal
    /// (-1); otherwise a finite integer order is the explicit index, and absent/non-finite/empty
    /// leaves the toolkit default (nil).
    static func resolveFocusOrder(_ focusOrder: String?, disabled: Bool) -> Int? {
        if disabled { return -1 }
        guard let raw = focusOrder?.trimmingCharacters(in: .whitespaces),
              !raw.isEmpty, let index = Int(raw) else { return nil }
        return index
    }
}

/// Renderer-neutral `tooltip=` / `tooltipSide=` grammar — the universal element hint
/// (design-system.md Wave 3 (c)1). Gated by OpenSource/Conformance/input/tooltip.json and
/// executed by all three runtimes. A resolved tooltip always doubles as the element's
/// accessibility description (aria-describedby on web; the platform hint slots on native —
/// UIToolTipInteraction / `.help` on Apple targets, tooltipText on Android), so its content
/// is never gated behind hover: the visual reveal is the only part that needs a
/// hover-capable fine pointer, which is why a touch surface never fires it (Article 7).
enum StackTooltip {
    static let sides: Set<String> = ["top", "bottom", "leading", "trailing"]

    /// Resolve tooltip= / tooltipSide=: whitespace-only text drops the tooltip; the side
    /// vocabulary is the floating-preference set, exact lowercase after trim, with `top`
    /// the default AND the fallback for anything unrecognized.
    static func resolve(_ tooltip: String?, side: String?) -> (text: String, side: String)? {
        guard let text = tooltip?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else { return nil }
        let trimmed = side?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return (text, sides.contains(trimmed) ? trimmed : "top")
    }
}

/// Renderer-neutral `density=` grammar — the universal subtree density knob
/// (component-library.md W9). Gated by OpenSource/Conformance/input/density.json and
/// executed by all three runtimes. The vocabulary is exactly `comfortable | compact`,
/// exact lowercase after trim; anything else is NO pin, so an element stays transparent
/// to its ancestors' density. `effective` walks the authored chain nearest-first — an
/// invalid nearer value never masks an outer pin — and with no pin the PLATFORM default
/// applies: compact on a desktop fine-pointer surface, comfortable everywhere else (the
/// adapter owns finePointer detection; this renderer presents through the platform's own
/// size system — Stack.swift maps the pin onto the SwiftUI controlSize environment).
enum StackDensity {
    static let comfortable = "comfortable"
    static let compact = "compact"

    /// Resolve density=: exact lowercase vocabulary after trim; anything else is no pin.
    static func resolve(_ density: String?) -> String? {
        guard let trimmed = density?.trimmingCharacters(in: .whitespacesAndNewlines),
              trimmed == comfortable || trimmed == compact else { return nil }
        return trimmed
    }

    /// The subtree law (density.json `effective[]`): `chain` is the authored raw density
    /// attributes from the root to the element (nil = not authored); the NEAREST
    /// resolving pin wins, else the platform default (compact iff finePointer).
    static func effective(_ chain: [String?], finePointer: Bool) -> String {
        for raw in chain.reversed() {
            if let pinned = resolve(raw) { return pinned }
        }
        return finePointer ? compact : comfortable
    }
}

enum StackTooltipAction: String { case show, hide }

/// The show/dismiss state machine for a resolved tooltip. Events are INTENT-qualified —
/// the UI adapter owns its hover-intent delay and pointer identity, then reports each
/// source with its own hover capability: a non-capable source (touch) is never even
/// tracked. visible = (hovered || focused) && !dismissed; Escape dismisses and suppresses
/// re-show until hover and focus have BOTH cleared. No authored events exist.
struct StackTooltipLifecycle {
    private var hovered = false
    private var focused = false
    private var dismissed = false

    var visible: Bool { (hovered || focused) && !dismissed }

    mutating func hoverStart(hoverCapable: Bool) -> [StackTooltipAction] {
        let before = visible
        if hoverCapable { hovered = true }
        return settle(before)
    }

    mutating func hoverEnd() -> [StackTooltipAction] {
        let before = visible
        hovered = false
        return settle(before)
    }

    mutating func focus(hoverCapable: Bool) -> [StackTooltipAction] {
        let before = visible
        if hoverCapable { focused = true }
        return settle(before)
    }

    mutating func blur() -> [StackTooltipAction] {
        let before = visible
        focused = false
        return settle(before)
    }

    mutating func escape() -> [StackTooltipAction] {
        let before = visible
        if visible { dismissed = true }
        return settle(before)
    }

    mutating func unmount() -> [StackTooltipAction] {
        let before = visible
        hovered = false
        focused = false
        return settle(before)
    }

    /// The shared post-transition fold: dismissal clears once hover and focus are BOTH
    /// gone, and only a visibility EDGE emits an action.
    private mutating func settle(_ before: Bool) -> [StackTooltipAction] {
        if !hovered && !focused { dismissed = false }
        let after = visible
        return before == after ? [] : [after ? .show : .hide]
    }
}

enum StackXML {
    static func parse(_ xml: String, platformTarget: String? = nil) -> StackNode? {
        var bodies: [String] = []                       // code-element bodies, lifted out 1:1 before parse
        let p = XMLParser(data: Data(normalizeEntities(liftCode(xml, &bodies)).utf8))
        let d = Delegate()
        p.delegate = d
        guard p.parse(), var root = d.root else {
            // Surface the failure instead of silently rendering an empty surface. Bare `&` (both
            // contexts) and `<` INSIDE attribute values are auto-normalized above, so the classic
            // `&&`-in-`visible-if` trap is gone — what still voids a template is structural:
            // mismatched tags, a stray quote, or a bare `<` in TEXT content (it reads as a tag).
            kernelLog("[Stack] XML parse failed at line \(p.lineNumber):\(p.columnNumber) — \(p.parserError?.localizedDescription ?? "malformed XML"). Check tag pairing/quotes; a bare < in text content must be &lt;. Surface will be empty.")
            return nil
        }
        if !bodies.isEmpty { reinject(&root, bodies) }
        if let platformTarget { root = StackPlatformAttrs.resolve(root, target: platformTarget) }
        return root
    }

    /// SMART ENTITIES — the HTML5 "ambiguous ampersand" rule, applied to the LIFTED doc before
    /// the strict Foundation XMLParser: a bare `&` that does not begin a real entity reads as a
    /// literal ampersand (so `visible-if="a && b"` needs no escaping), and `<` INSIDE a quoted
    /// attribute value reads as a literal less-than (`visible-if="n < 3"`). Real entities
    /// (`&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&#…;` `&#x…;`) pass through untouched, comments
    /// and CDATA are copied verbatim, and a bare `<` in TEXT still needs `&lt;` (it opens a tag —
    /// genuinely ambiguous). The linter runs the SAME rule (lint_dsx `normalize_entities`), so
    /// what lints is exactly what parses.
    static func normalizeEntities(_ s: String) -> String {
        let c = Array(s)
        var out = ""; out.reserveCapacity(c.count + 16)
        var i = 0
        var quote: Character? = nil     // inside an attribute value, holding its quote char
        var inTag = false               // between an unquoted `<` and its `>`
        func entityAhead(_ j: Int) -> Bool {            // c[j] == "&" — does a real entity start here?
            var k = j + 1, name = ""
            while k < c.count, name.count <= 8, c[k] != ";" { name.append(c[k]); k += 1 }
            guard k < c.count, c[k] == ";", !name.isEmpty else { return false }
            if ["amp", "lt", "gt", "quot", "apos"].contains(name) { return true }
            if name.hasPrefix("#x") || name.hasPrefix("#X") {
                let digits = name.dropFirst(2)
                return !digits.isEmpty && digits.allSatisfy { $0.isHexDigit }
            }
            if name.hasPrefix("#") {
                let digits = name.dropFirst()
                return !digits.isEmpty && digits.allSatisfy { $0.isNumber }
            }
            return false
        }
        while i < c.count {
            if quote == nil, c[i] == "<" {              // comments/CDATA verbatim (same guard as liftCode)
                var skipped = false
                for (open, close) in [("<!--", "-->"), ("<![CDATA[", "]]>")] {
                    let o = Array(open)
                    guard i + o.count <= c.count, Array(c[i..<i + o.count]) == o else { continue }
                    let cl = Array(close)
                    var k = i + o.count
                    while k + cl.count <= c.count, Array(c[k..<k + cl.count]) != cl { k += 1 }
                    let end = (k + cl.count <= c.count) ? k + cl.count : c.count
                    out += String(c[i..<end]); i = end; skipped = true; break
                }
                if skipped { continue }
            }
            let ch = c[i]
            if let q = quote {
                if ch == q { quote = nil; out.append(ch) }
                else if ch == "&", !entityAhead(i) { out += "&amp;" }
                else if ch == "<" { out += "&lt;" }
                else { out.append(ch) }
            } else if inTag {
                if ch == "\"" || ch == "'" { quote = ch }
                else if ch == ">" { inTag = false }
                out.append(ch)
            } else {
                if ch == "<" { inTag = true; out.append(ch) }
                else if ch == "&", !entityAhead(i) { out += "&amp;" }
                else { out.append(ch) }
            }
            i += 1
        }
        return out
    }

    /// Code elements (`<script>`/`<functions>`/`<action>`/`<formula>`/`<variable>`/`<var>`/`<let>`)
    /// hold RAW JS. Their bodies are read **1:1** — never interpreted as XML — so `<` / `&&` / `&`
    /// (and even a literal `]]>`) need NO escaping and the author never writes `<![CDATA[ … ]]>`.
    /// `liftCode` pulls each body out (trimmed) and leaves an XML-safe placeholder, so XMLParser
    /// only sees the structure; `reinject` re-attaches the raw bodies to their nodes afterwards.
    /// (Inline `on:` ATTRIBUTES are NOT lifted — they don't need to be: `normalizeEntities`
    /// makes bare `&`/`&&` and `<` inside attribute values legal as-written.)
    static let codeTags: Set<String> = ["script", "functions", "action", "formula", "variable", "var", "let"]
    private static func liftCode(_ xml: String, _ bodies: inout [String]) -> String {
        let c = Array(xml); var out = ""; var i = 0
        func boundary(_ ch: Character) -> Bool { ch == ">" || ch == " " || ch == "\t" || ch == "\n" || ch == "\r" || ch == "/" }
        while i < c.count {
            if c[i] != "<" { out.append(c[i]); i += 1; continue }
            // XML comments + CDATA are OPAQUE to code-lifting — copy them VERBATIM. A code-tag NAME
            // mentioned inside one (e.g. the literal text "<action>" in a `<!-- … -->` comment) must
            // NOT be lifted: doing so swallows the comment up to the next real `</action>`, voids the
            // whole template's XML, and the surface renders EMPTY (a black screen). The scan below is
            // not XML-aware, so guard these regions here. (Regression: a `<!-- … <action> … -->`
            // comment silently broke a component's parse — lint missed it because it strips comments.)
            var skipped = false
            for (open, close) in [("<!--", "-->"), ("<![CDATA[", "]]>")] {
                let o = Array(open)
                guard i + o.count <= c.count, Array(c[i..<i + o.count]) == o else { continue }
                let cl = Array(close)
                var k = i + o.count
                while k + cl.count <= c.count, Array(c[k..<k + cl.count]) != cl { k += 1 }
                let end = (k + cl.count <= c.count) ? k + cl.count : c.count   // unterminated → copy to end
                out += String(c[i..<end]); i = end; skipped = true; break
            }
            if skipped { continue }
            var match: String? = nil
            for t in codeTags {
                let o = Array("<" + t)
                if i + o.count < c.count, Array(c[i..<i + o.count]) == o, boundary(c[i + o.count]) { match = t; break }
            }
            guard let t = match else { out.append(c[i]); i += 1; continue }
            var q: Character? = nil                                    // copy the open tag through its '>' (quote-aware)
            while i < c.count {
                let ch = c[i]; out.append(ch); i += 1
                if let qq = q { if ch == qq { q = nil } }
                else if ch == "\"" || ch == "'" { q = ch }
                else if ch == ">" { break }
            }
            if out.hasSuffix("/>") { continue }                        // self-closing — no body
            let close = Array("</" + t + ">")                          // raw body up to the matching close tag
            var k = i, end = c.count
            while k + close.count <= c.count {
                if Array(c[k..<k + close.count]) == close { end = k; break }
                k += 1
            }
            var body = String(c[i..<end]).trimmingCharacters(in: .whitespacesAndNewlines)   // 1:1, just trimmed
            if body.hasPrefix("<![CDATA[") && body.hasSuffix("]]>") {                        // tolerate explicit CDATA
                body = String(body.dropFirst(9).dropLast(3)).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            out += "\u{E000}\(bodies.count)\u{E000}"                   // XML-safe placeholder where the body was
            bodies.append(body)
            if end < c.count { out += String(c[end..<min(end + close.count, c.count)]) }     // copy the close tag
            i = end + close.count
        }
        return out
    }
    /// Re-attach each lifted code body to its node (placeholder `\u{E000}N\u{E000}` → `bodies[N]`),
    /// walking the parsed tree.
    private static func reinject(_ node: inout StackNode, _ bodies: [String]) {
        if let t = node.text, t.hasPrefix("\u{E000}"), t.hasSuffix("\u{E000}"), t.count > 2,
           let n = Int(t.dropFirst().dropLast()), n >= 0, n < bodies.count {
            node.text = bodies[n]
        }
        for j in node.children.indices { reinject(&node.children[j], bodies) }
    }

    private final class Delegate: NSObject, XMLParserDelegate {
        var root: StackNode?
        private var stack: [StackNode] = []

        func parser(_ parser: XMLParser, didStartElement el: String, namespaceURI: String?,
                    qualifiedName qn: String?, attributes attrs: [String: String]) {
            stack.append(StackNode(tag: el, attrs: attrs, children: []))
        }
        func parser(_ parser: XMLParser, foundCharacters s: String) {
            // Accumulate RAW — do NOT trim per chunk. XMLParser delivers a text node in MULTIPLE
            // foundCharacters calls, split around entities (`&amp;` → a separate "&" chunk) and at
            // arbitrary buffer boundaries. Trimming each chunk ate the space adjacent to the split —
            // "key &amp; tunes" rendered "key&tunes", "note — naturally" rendered "note— naturally".
            // We assemble the whole node here and trim leading/trailing ONCE in didEndElement (which
            // still drops the pretty-print indentation between child elements, but keeps inner spaces).
            guard !stack.isEmpty else { return }
            stack[stack.count - 1].text = (stack[stack.count - 1].text ?? "") + s
        }
        /// CDATA — raw text the XML parser does NOT interpret. The clean way to embed code
        /// (`<script>`, `<formula>`, `<action>`) so JS `<` / `&&` / `&` need no
        /// XML escaping: `<script><![CDATA[ if (a < b && c) … ]]></script>`. (Only `]]>` can't
        /// appear inside.) Without this the block would be dropped — XMLParser delivers CDATA here,
        /// not via foundCharacters.
        func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
            guard let s = String(data: CDATABlock, encoding: .utf8), !stack.isEmpty else { return }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { return }
            stack[stack.count - 1].text = (stack[stack.count - 1].text ?? "") + t
        }
        func parser(_ parser: XMLParser, didEndElement el: String, namespaceURI: String?,
                    qualifiedName qn: String?) {
            guard var node = stack.popLast() else { return }
            // Trim the assembled text ONCE: drops the pretty-print indentation a container collects
            // between its children (whitespace-only → nil), while preserving every inner space of a
            // real text node (including those next to `&amp;` / em-dashes split across chunks above).
            if let t = node.text {
                let trimmed = t.trimmingCharacters(in: .whitespacesAndNewlines)
                node.text = trimmed.isEmpty ? nil : trimmed
            }
            if stack.isEmpty { root = node }
            else { stack[stack.count - 1].children.append(node) }
        }
    }
}
