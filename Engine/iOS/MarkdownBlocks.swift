//
//  MarkdownBlocks.swift — BLOCK-level markdown (A4b): the `<markdown>` element on the
//  Swift reference — parser + prose plane + component in one file.
//
//  THE PARSER EMITS THE NEUTRAL TREE the shared corpus defines
//  (OpenSource/Conformance/markdown/blocks.json — verified by MarkdownBlocksConformance,
//  ConformanceHosts.swift, the record lane; the TS reference and the Kotlin twin run the
//  SAME file), never a View: MarkdownBlocksView below is a consumer of the tree, not the
//  definition of it. Twin of dom/src/markdown-blocks.ts; the INLINE vocabulary
//  (`parseInline` — emphasis · strong · code · strikethrough · links + the
//  http/https/mailto/tel/relative allowlist) is the sink grammar of dom/src/markdown.ts,
//  so every block's inline content has exactly one implementation per runtime.
//
//  THE PROSE PLANE (dom/src/prose.ts twin, MarkdownProse): the design language — the
//  type scale with tightening weight/tracking, fenced code on an elevated rounded
//  surface with the shared syntax tint, inline code as a subtle fill chip, the accent
//  quote rail over its wash, band-header tables, muted tabular list markers, hairline
//  rules — expressed in the platform's idiom (SwiftUI text styles + AttributedString
//  runs), with every color resolving through the semantic-token funnel
//  (StackStyle.color, the system-defaults corpus). The ONE exception is the tint
//  palette, which prose.ts also carries as its own scheme tables inside the sheet: the
//  same light/dark pairs ride here as dynamic UIColors, so they follow the trait.
//
//  SAFETY (the corpus `_safety` pin): raw HTML is TEXT; refused link/image targets
//  render as prose, never live; all passes are bounded (characters/blocks/listDepth).
//
//  `MarkdownElement` registers `<markdown>` globally via the launch class-walk (the
//  GlobalStackComponent sweep) — source precedence bind > inner text > value, the
//  `<text>` element's own reader (dsx.text()).
//

import Foundation
import SwiftUI
import UIKit

// MARK: - the neutral block tree (despia-markdown-blocks-v1)

indirect enum MarkdownBlock {
    case paragraph(inline: String)
    case heading(level: Int, inline: String)
    case code(language: String, text: String)
    case quote(blocks: [MarkdownBlock])
    case rule
    case image(src: String, alt: String)
    case list(ordered: Bool, start: Int, items: [MarkdownListItem])
    case table(header: [String], rows: [[String]])
}

struct MarkdownListItem {
    var inline: String
    var blocks: [MarkdownBlock] = []
}

/** The inline sink — one parser, N emitters (the AttributedString builder below, the
 *  conformance assertions), the same shape as the web's MarkdownSink. `open` tags are
 *  `strong` · `em` · `del` · `code` · `a` (href set for `a` only). */
struct MarkdownInlineSink {
    var text: (String) -> Void
    var open: (String, String?) -> Void
    var close: () -> Void
}

enum MarkdownBlocks {

    /// Hostile-input ceilings — the corpus `limits` block, same numbers.
    static let limitCharacters = 65_536
    static let limitBlocks = 512
    static let limitListDepth = 6

    private static let headingRe = try! NSRegularExpression(pattern: #"^(#{1,6})\s+(.*)$"#)
    private static let fenceRe = try! NSRegularExpression(pattern: #"^(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$"#)
    private static let ruleRe = try! NSRegularExpression(pattern: #"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$"#)
    private static let bulletRe = try! NSRegularExpression(pattern: #"^(\s*)([-*+])\s+(.*)$"#)
    private static let orderedRe = try! NSRegularExpression(pattern: #"^(\s*)(\d{1,9})[.)]\s+(.*)$"#)
    private static let quoteRe = try! NSRegularExpression(pattern: #"^\s*>\s?(.*)$"#)
    private static let imageOnlyRe = try! NSRegularExpression(pattern: #"^!\[([^\]]*)\]\(([^)\s]+)\)$"#)
    private static let tableDividerRe = try! NSRegularExpression(
        pattern: #"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$"#)

    /// Whole-string match → capture groups (index 0 = the whole match, "" for unmatched).
    private static func match(_ re: NSRegularExpression, _ s: String) -> [String]? {
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        guard let m = re.firstMatch(in: s, options: [], range: range) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            guard let r = Range(m.range(at: i), in: s) else { return "" }
            return String(s[r])
        }
    }

    private static func cells(_ line: String) -> [String] {
        var row = line.trimmingCharacters(in: .whitespaces)
        if row.hasPrefix("|") { row = String(row.dropFirst()) }
        if row.hasSuffix("|") { row = String(row.dropLast()) }
        return row.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// Indentation in spaces, tabs counted as two — the width lists are authored at.
    private static func indentOf(_ raw: String) -> Int {
        var n = 0
        for ch in raw {
            if ch == " " { n += 1 } else if ch == "\t" { n += 2 } else { break }
        }
        return n
    }

    /// Would this line open a NEW block in the main loop (rather than lazily continuing
    /// an open paragraph)? Branch order mirrors parseLines exactly, so laziness can
    /// never swallow a construct the outer loop would have taken.
    private static func startsBlock(_ lines: [String], at i: Int) -> Bool {
        let line = lines[i]
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return true }
        if match(fenceRe, trimmed) != nil { return true }
        if match(ruleRe, line) != nil && match(bulletRe, line) == nil { return true }
        if match(headingRe, trimmed) != nil { return true }
        if match(quoteRe, line) != nil { return true }
        if trimmed.contains("|"), i + 1 < lines.count, match(tableDividerRe, lines[i + 1]) != nil { return true }
        if match(bulletRe, line) != nil || match(orderedRe, line) != nil { return true }
        if let image = match(imageOnlyRe, trimmed) { return safeMarkdownHref(image[2]) != nil }
        return false
    }

    /// Does `prev` (the last line inside an open container) leave a PARAGRAPH open?
    /// Lazy continuation is a paragraph law: only then may an unmarked line keep its
    /// container.
    private static func leavesParagraphOpen(_ prev: String) -> Bool {
        let trimmed = prev.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return false }
        if match(fenceRe, trimmed) != nil { return false }
        if match(ruleRe, prev) != nil && match(bulletRe, prev) == nil { return false }
        if match(headingRe, trimmed) != nil { return false }
        if let image = match(imageOnlyRe, trimmed) { return safeMarkdownHref(image[2]) == nil }
        return true
    }

    /// Parse a markdown document into the neutral block tree the corpus defines.
    static func parse(_ source: String) -> [MarkdownBlock] {
        let text = source.count > limitCharacters ? String(source.prefix(limitCharacters)) : source
        let lines = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        return parseLines(lines, depth: 0)
    }

    private static func parseLines(_ lines: [String], depth: Int) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []

        func flush() {
            if paragraph.isEmpty { return }
            let inline = paragraph.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            paragraph = []
            if !inline.isEmpty && blocks.count < limitBlocks { blocks.append(.paragraph(inline: inline)) }
        }
        func push(_ block: MarkdownBlock) {
            if blocks.count < limitBlocks { blocks.append(block) }
        }

        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty { flush(); i += 1; continue }

            // A fence wins over everything: its contents are bytes, never markdown. An
            // unterminated fence closes at the end of the document rather than swallowing it.
            if let fence = match(fenceRe, trimmed) {
                flush()
                let marker = fence[1]
                let language = fence[2]
                var body: [String] = []
                i += 1
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces) != marker {
                    body.append(lines[i]); i += 1
                }
                if i < lines.count { i += 1 }
                push(.code(language: language, text: body.joined(separator: "\n")))
                continue
            }

            if match(ruleRe, line) != nil && match(bulletRe, line) == nil {
                flush(); push(.rule); i += 1; continue
            }

            if let heading = match(headingRe, trimmed) {
                flush()
                push(.heading(level: heading[1].count, inline: heading[2].trimmingCharacters(in: .whitespaces)))
                i += 1
                continue
            }

            if let quote = match(quoteRe, line) {
                flush()
                var inner: [String] = [quote[1]]
                i += 1
                while i < lines.count {
                    if let next = match(quoteRe, lines[i]) {
                        inner.append(next[1])
                        i += 1
                        continue
                    }
                    // CommonMark laziness: an unmarked paragraph line keeps the quote
                    // open, but only while its innermost open block is still a paragraph.
                    if startsBlock(lines, at: i) || !leavesParagraphOpen(inner[inner.count - 1]) { break }
                    inner.append(lines[i])
                    i += 1
                }
                push(.quote(blocks: depth >= limitListDepth ? [] : parseLines(inner, depth: depth + 1)))
                continue
            }

            // A table needs its divider on the NEXT line; without one these are ordinary
            // paragraph lines that happen to contain pipes.
            if trimmed.contains("|"), i + 1 < lines.count, match(tableDividerRe, lines[i + 1]) != nil {
                flush()
                let header = cells(trimmed)
                i += 2
                var rows: [[String]] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).contains("|") {
                    var row = cells(lines[i])
                    // Padded rather than dropped: a short row is an authoring slip, and
                    // dropping it loses content the author wrote.
                    while row.count < header.count { row.append("") }
                    rows.append(Array(row.prefix(header.count)))
                    i += 1
                }
                push(.table(header: header, rows: rows))
                continue
            }

            if match(bulletRe, line) != nil || match(orderedRe, line) != nil {
                flush()
                let consumed = parseList(lines, start: i, depth: depth)
                push(consumed.block)
                i = consumed.next
                continue
            }

            if let image = match(imageOnlyRe, trimmed) {
                if let src = safeMarkdownHref(image[2]) {
                    flush()
                    push(.image(src: src, alt: image[1]))
                    i += 1
                    continue
                }
                // A refused target falls through to prose: the label survives, nothing becomes live.
            }

            paragraph.append(trimmed)
            i += 1
        }
        flush()
        return blocks
    }

    /// One list, from `start`, including any nested lists its items carry.
    private static func parseList(_ lines: [String], start: Int, depth: Int) -> (block: MarkdownBlock, next: Int) {
        let first = lines[start]
        let firstOrdered = match(orderedRe, first)
        let ordered = firstOrdered != nil
        let baseIndent = indentOf(first)
        var items: [MarkdownListItem] = []
        let startNumber = firstOrdered.flatMap { Int($0[2]) } ?? 0

        var i = start
        while i < lines.count {
            let line = lines[i]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { break }
            guard let m = ordered ? match(orderedRe, line) : match(bulletRe, line) else {
                // No marker: CommonMark laziness — an unmarked line that opens no new
                // block is the previous item's paragraph continuing, at any indent.
                if items.isEmpty || startsBlock(lines, at: i) { break }
                items[items.count - 1].inline += " " + line.trimmingCharacters(in: .whitespaces)
                i += 1
                continue
            }
            let indent = indentOf(line)
            if indent < baseIndent { break }
            if indent > baseIndent {
                // Deeper: belongs to the item just emitted, as a nested list.
                let nested = parseList(lines, start: i, depth: depth + 1)
                if !items.isEmpty, depth + 1 < limitListDepth {
                    items[items.count - 1].blocks.append(nested.block)
                }
                i = nested.next
                continue
            }
            items.append(MarkdownListItem(inline: m[3].trimmingCharacters(in: .whitespaces)))
            i += 1
        }

        return (.list(ordered: ordered, start: startNumber, items: items), i)
    }

    // MARK: - the inline vocabulary (dom/src/markdown.ts twin)

    /// Inline hostile-input ceilings — MARKDOWN_LIMITS in markdown.ts, same numbers.
    static let inlineLimitCharacters = 16_384
    static let inlineLimitNodes = 512
    static let inlineLimitDepth = 8

    private static let safeLinkSchemeRe = try! NSRegularExpression(
        pattern: #"^(?:https?:|mailto:|tel:)"#, options: [.caseInsensitive])
    private static let anySchemeRe = try! NSRegularExpression(
        pattern: #"^[a-z][a-z0-9+.-]*:"#, options: [.caseInsensitive])
    private static let controlCharsRe = try! NSRegularExpression(pattern: #"[\x{0000}-\x{001f}\x{007f}]"#)

    private static func tests(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, options: [], range: NSRange(s.startIndex..<s.endIndex, in: s)) != nil
    }

    /// The link allowlist: absolute http(s)/mailto/tel, or a relative/same-document
    /// target. Anything else (javascript:, data:, an unknown scheme, a protocol-relative
    /// origin) is refused and the label renders as plain text.
    static func safeMarkdownHref(_ raw: String) -> String? {
        let href = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if href.isEmpty || href.count > 2_048 { return nil }
        if tests(controlCharsRe, href) { return nil }
        if tests(safeLinkSchemeRe, href) { return href }
        if tests(anySchemeRe, href) { return nil }
        if href.hasPrefix("//") { return nil }   // protocol-relative — an absolute origin in disguise
        return href
    }

    // Longest-first so `**` wins over `*` and `~~` over a stray `~`.
    private static let markers: [(token: [Character], tag: String)] = [
        (["*", "*"], "strong"), (["_", "_"], "strong"), (["~", "~"], "del"), (["*"], "em"), (["_"], "em"),
    ]

    private final class NodeBudget {
        var nodes: Int
        init(_ nodes: Int) { self.nodes = nodes }
    }

    private static let nullSink = MarkdownInlineSink(text: { _ in }, open: { _, _ in }, close: {})

    /// Drive `sink` over the inline markdown of `source`.
    static func parseInline(_ source: String, _ sink: MarkdownInlineSink) {
        let chars = Array(source)
        let bounded = chars.count > inlineLimitCharacters ? Array(chars.prefix(inlineLimitCharacters)) : chars
        _ = scanInline(bounded, start: 0, sink: sink, closer: nil, depth: 0, budget: NodeBudget(inlineLimitNodes))
        if bounded.count < chars.count { sink.text(String(chars[bounded.count...])) }
    }

    private static func starts(_ chars: [Character], _ token: [Character], at i: Int) -> Bool {
        guard i + token.count <= chars.count else { return false }
        for (k, ch) in token.enumerated() where chars[i + k] != ch { return false }
        return true
    }

    private static func indexOf(_ chars: [Character], _ ch: Character, from i: Int) -> Int? {
        var j = i
        while j < chars.count { if chars[j] == ch { return j }; j += 1 }
        return nil
    }

    /// Scan `chars` from `start` into `sink` until `closer` (or the end). Returns the
    /// index just past the closer, or nil when the closer was never found — the caller
    /// then emits its own opening marker literally, exactly like CommonMark.
    private static func scanInline(
        _ chars: [Character], start: Int, sink: MarkdownInlineSink,
        closer: [Character]?, depth: Int, budget: NodeBudget
    ) -> Int? {
        var i = start
        var literal = ""
        func flush() {
            if literal.isEmpty { return }
            sink.text(literal)
            literal = ""
        }
        scan: while i < chars.count {
            let ch = chars[i]

            if ch == "\\" && i + 1 < chars.count {
                // A backslash escape makes the next character literal — the one way an
                // author writes a real asterisk or bracket inside markdown copy.
                literal.append(chars[i + 1])
                i += 2
                continue
            }

            if let closer = closer, starts(chars, closer, at: i) {
                flush()
                return i + closer.count
            }

            if ch == "`" && budget.nodes > 0 {
                if let end = indexOf(chars, "`", from: i + 1) {
                    budget.nodes -= 1
                    flush()
                    sink.open("code", nil)
                    sink.text(String(chars[(i + 1)..<end]))
                    sink.close()
                    i = end + 1
                    continue
                }
            }

            if ch == "[" && budget.nodes > 0 && depth < inlineLimitDepth {
                if let close = indexOf(chars, "]", from: i + 1), close + 1 < chars.count, chars[close + 1] == "(" {
                    if let paren = indexOf(chars, ")", from: close + 2) {
                        if let href = safeMarkdownHref(String(chars[(close + 2)..<paren])) {
                            budget.nodes -= 1
                            flush()
                            sink.open("a", href)
                            _ = scanInline(chars, start: i + 1, sink: sink, closer: ["]"], depth: depth + 1, budget: budget)
                            sink.close()
                            i = paren + 1
                            continue
                        }
                    }
                }
            }

            if depth < inlineLimitDepth && budget.nodes > 0 {
                if let marker = markers.first(where: { starts(chars, $0.token, at: i) }) {
                    // An emphasis run needs content: a marker immediately followed by its
                    // own closer is literal text, matching CommonMark over an empty tag.
                    if !starts(chars, marker.token, at: i + marker.token.count) {
                        // Look ahead on a THROWAWAY sink first: an unterminated run must
                        // render as literal text, and nothing may have been emitted for it.
                        let spent = budget.nodes
                        let end = scanInline(chars, start: i + marker.token.count, sink: nullSink,
                                             closer: marker.token, depth: depth + 1, budget: NodeBudget(spent))
                        if let end = end {
                            budget.nodes = spent - 1
                            flush()
                            sink.open(marker.tag, nil)
                            _ = scanInline(chars, start: i + marker.token.count, sink: sink,
                                           closer: marker.token, depth: depth + 1, budget: budget)
                            sink.close()
                            i = end
                            continue scan
                        }
                        literal += String(marker.token)
                        i += marker.token.count
                        continue
                    }
                }
            }

            literal.append(ch)
            i += 1
        }
        flush()
        return closer == nil ? i : nil
    }

    // MARK: - the syntax tint (prose.ts tokenizeCode twin)

    enum CodeTokenKind { case kw, str, com, num, typ, pun, plain }
    struct CodeToken: Equatable {
        let kind: CodeTokenKind
        let text: String
    }

    /// Tint ceiling — past it the remainder is one plain token (CODE_TINT_LIMITS).
    static let tintLimitCharacters = 65_536

    private struct Lexicon {
        let keywords: Set<String>
        let capitalTypes: Bool
        let lineComments: [String]
        var blockComment: (open: String, close: String)? = nil
        var quotes: [Character] = []
        var sigils: [Character] = []
        var unitNumbers = false
    }

    private static let tsKeywords: Set<String> = [
        "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch", "class",
        "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
        "extends", "false", "finally", "for", "from", "function", "get", "if", "implements",
        "import", "in", "instanceof", "interface", "keyof", "let", "namespace", "new", "null",
        "number", "object", "of", "private", "protected", "public", "readonly", "return", "satisfies",
        "set", "static", "string", "super", "switch", "this", "throw", "true", "try", "type",
        "typeof", "undefined", "unknown", "var", "void", "while", "yield",
    ]
    private static let swiftKeywords: Set<String> = [
        "actor", "as", "associatedtype", "async", "await", "break", "case", "catch", "class",
        "continue", "default", "defer", "deinit", "do", "else", "enum", "extension", "fallthrough",
        "false", "fileprivate", "final", "for", "func", "guard", "if", "import", "in", "init",
        "inout", "internal", "is", "lazy", "let", "mutating", "nil", "open", "operator", "override",
        "private", "protocol", "public", "repeat", "required", "rethrows", "return", "self", "some",
        "static", "struct", "subscript", "super", "switch", "throw", "throws", "true", "try",
        "typealias", "var", "weak", "where", "while",
    ]
    private static let kotlinKeywords: Set<String> = [
        "abstract", "as", "break", "by", "catch", "class", "companion", "const", "continue",
        "data", "do", "else", "enum", "false", "final", "finally", "for", "fun", "if", "import",
        "in", "init", "inline", "interface", "internal", "is", "lateinit", "null", "object",
        "open", "operator", "out", "override", "package", "private", "protected", "public",
        "return", "sealed", "super", "suspend", "this", "throw", "true", "try", "typealias",
        "val", "var", "when", "while",
    ]
    private static let javaKeywords: Set<String> = [
        "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class",
        "const", "continue", "default", "do", "double", "else", "enum", "extends", "false",
        "final", "finally", "float", "for", "if", "implements", "import", "instanceof", "int",
        "interface", "long", "native", "new", "null", "package", "private", "protected",
        "public", "record", "return", "short", "static", "super", "switch", "synchronized",
        "this", "throw", "throws", "transient", "true", "try", "var", "void", "volatile", "while",
    ]
    private static let rubyKeywords: Set<String> = [
        "alias", "and", "begin", "break", "case", "class", "def", "defined?", "do", "else",
        "elsif", "end", "ensure", "false", "for", "if", "in", "module", "next", "nil", "not",
        "or", "raise", "redo", "require", "require_relative", "rescue", "retry", "return",
        "self", "super", "then", "true", "undef", "unless", "until", "when", "while", "yield",
    ]
    private static let bashKeywords: Set<String> = [
        "case", "do", "done", "elif", "else", "esac", "exit", "export", "fi", "for", "function",
        "if", "in", "local", "return", "select", "set", "shift", "then", "until", "while",
    ]
    private static let pythonKeywords: Set<String> = [
        "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
        "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
        "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while",
        "with", "yield", "False", "None", "True",
    ]

    private static let lexicons: [String: Lexicon] = {
        var table: [String: Lexicon] = [:]
        func add(_ names: [String], _ lexicon: Lexicon) { for name in names { table[name] = lexicon } }
        add(["ts", "tsx", "typescript", "js", "jsx", "javascript"], Lexicon(
            keywords: tsKeywords, capitalTypes: true, lineComments: ["//"],
            blockComment: ("/*", "*/"), quotes: ["\"", "'", "`"]))
        add(["swift"], Lexicon(
            keywords: swiftKeywords, capitalTypes: true, lineComments: ["//"],
            blockComment: ("/*", "*/"), quotes: ["\""]))
        add(["kotlin", "kt", "kts"], Lexicon(
            keywords: kotlinKeywords, capitalTypes: true, lineComments: ["//"],
            blockComment: ("/*", "*/"), quotes: ["\""]))
        add(["java"], Lexicon(
            keywords: javaKeywords, capitalTypes: true, lineComments: ["//"],
            blockComment: ("/*", "*/"), quotes: ["\""]))
        add(["json", "jsonc"], Lexicon(
            keywords: ["true", "false", "null"], capitalTypes: false, lineComments: ["//"],
            quotes: ["\""]))
        add(["css"], Lexicon(
            keywords: ["important"], capitalTypes: false, lineComments: [],
            blockComment: ("/*", "*/"), quotes: ["\"", "'"], unitNumbers: true))
        add(["bash", "sh", "shell", "zsh", "console"], Lexicon(
            keywords: bashKeywords, capitalTypes: false, lineComments: ["#"],
            quotes: ["\"", "'"], sigils: ["$"]))
        add(["ruby", "rb"], Lexicon(
            keywords: rubyKeywords, capitalTypes: true, lineComments: ["#"],
            quotes: ["\"", "'"], sigils: ["@", "$"]))
        add(["yaml", "yml"], Lexicon(
            keywords: ["true", "false", "null", "yes", "no"], capitalTypes: false,
            lineComments: ["#"], quotes: ["\"", "'"]))
        add(["python", "py"], Lexicon(
            keywords: pythonKeywords, capitalTypes: true, lineComments: ["#"], quotes: ["\"", "'"]))
        return table
    }()

    private static let markupLanguages: Set<String> = ["dsx", "xml", "html", "svg"]

    private static func isIdentStart(_ ch: Character) -> Bool {
        ("a"..."z").contains(ch) || ("A"..."Z").contains(ch) || ch == "_" || ch == "$"
    }
    private static func isIdentPart(_ ch: Character) -> Bool {
        isIdentStart(ch) || ("0"..."9").contains(ch) || ch == "-" || ch == "?"
    }
    private static func isDigit(_ ch: Character) -> Bool { ("0"..."9").contains(ch) }
    private static func isPunct(_ ch: Character) -> Bool { "()[]{}<>,;:.=+-*/%&|!?~^#@\\".contains(ch) }
    private static func isHexLetter(_ ch: Character) -> Bool {
        ("a"..."f").contains(ch) || ("A"..."F").contains(ch)
    }

    /// Token sink with same-kind coalescing — adjacent runs become ONE token, so the
    /// attributed runs and the web's DOM/SSR nodes stay congruent.
    private final class Tokens {
        var out: [CodeToken] = []
        func push(_ kind: CodeTokenKind, _ text: String) {
            if text.isEmpty { return }
            if let last = out.last, last.kind == kind {
                out[out.count - 1] = CodeToken(kind: kind, text: last.text + text)
            } else {
                out.append(CodeToken(kind: kind, text: text))
            }
        }
    }

    private static func find(_ chars: [Character], _ needle: [Character], from i: Int) -> Int? {
        guard !needle.isEmpty else { return nil }
        var j = i
        while j + needle.count <= chars.count {
            if starts(chars, needle, at: j) { return j }
            j += 1
        }
        return nil
    }

    private static func tokenizeMarkup(_ chars: [Character]) -> [CodeToken] {
        let tokens = Tokens()
        let commentOpen = Array("<!--"), commentClose = Array("-->")
        var i = 0
        while i < chars.count {
            if starts(chars, commentOpen, at: i) {
                let end = find(chars, commentClose, from: i + 4)
                let stop = end.map { $0 + 3 } ?? chars.count
                tokens.push(.com, String(chars[i..<stop]))
                i = stop
                continue
            }
            if chars[i] == "<" {
                // the tag: "<" or "</" dimmed, the name accented, then the attribute run
                var j = i + 1
                if j < chars.count && (chars[j] == "/" || chars[j] == "!" || chars[j] == "?") { j += 1 }
                tokens.push(.pun, String(chars[i..<j]))
                i = j
                while i < chars.count && isIdentPart(chars[i]) { i += 1 }
                tokens.push(.kw, String(chars[j..<i]))
                // inside the tag until ">": attr names, "=", quoted values
                while i < chars.count && chars[i] != ">" {
                    let ch = chars[i]
                    if ch == "\"" || ch == "'" {
                        var k = i + 1
                        while k < chars.count && chars[k] != ch { k += 1 }
                        if k < chars.count { k += 1 }
                        tokens.push(.str, String(chars[i..<k]))
                        i = k
                    } else if isIdentStart(ch) {
                        var k = i + 1
                        while k < chars.count && (isIdentPart(chars[k]) || chars[k] == ":" || chars[k] == ".") { k += 1 }
                        tokens.push(.typ, String(chars[i..<k]))
                        i = k
                    } else if ch == "=" || ch == "/" {
                        tokens.push(.pun, String(ch))
                        i += 1
                    } else {
                        tokens.push(.plain, String(ch))
                        i += 1
                    }
                }
                if i < chars.count { tokens.push(.pun, ">"); i += 1 }
                continue
            }
            let stop = indexOf(chars, "<", from: i) ?? chars.count
            tokens.push(.plain, String(chars[i..<stop]))
            i = stop
        }
        return tokens.out
    }

    private static func tokenizeWithLexicon(_ chars: [Character], _ lexicon: Lexicon) -> [CodeToken] {
        let tokens = Tokens()
        let lineComments = lexicon.lineComments.map(Array.init)
        let blockComment = lexicon.blockComment.map { (Array($0.open), Array($0.close)) }
        var i = 0
        scan: while i < chars.count {
            let ch = chars[i]
            for opener in lineComments where starts(chars, opener, at: i) {
                let stop = indexOf(chars, "\n", from: i) ?? chars.count
                tokens.push(.com, String(chars[i..<stop]))
                i = stop
                continue scan
            }
            if let (open, close) = blockComment, starts(chars, open, at: i) {
                let end = find(chars, close, from: i + open.count)
                let stop = end.map { $0 + close.count } ?? chars.count
                tokens.push(.com, String(chars[i..<stop]))
                i = stop
                continue
            }
            if lexicon.quotes.contains(ch) {
                var j = i + 1
                while j < chars.count && chars[j] != ch {
                    // a backslash escape keeps an embedded quote inside the string run
                    j += (chars[j] == "\\" && j + 1 < chars.count) ? 2 : 1
                    // plain quotes never span lines; template literals do
                    if ch != "`" && j - 1 < chars.count && chars[j - 1] == "\n" { j -= 1; break }
                }
                if j < chars.count && chars[j] == ch { j += 1 }
                tokens.push(.str, String(chars[i..<j]))
                i = j
                continue
            }
            if lexicon.sigils.contains(ch) && i + 1 < chars.count
                && (isIdentStart(chars[i + 1]) || chars[i + 1] == "{") {
                var j = i + 1
                if chars[j] == "{" {
                    j = indexOf(chars, "}", from: j).map { $0 + 1 } ?? chars.count
                } else {
                    while j < chars.count && isIdentPart(chars[j]) { j += 1 }
                }
                tokens.push(.typ, String(chars[i..<j]))
                i = j
                continue
            }
            let hexColor = ch == "#" && lexicon.unitNumbers && i + 1 < chars.count
                && (isDigit(chars[i + 1]) || isHexLetter(chars[i + 1]))
            if isDigit(ch) || hexColor {
                var j = i + (hexColor ? 1 : 0)
                while j < chars.count && (isDigit(chars[j]) || chars[j] == "." || chars[j] == "_"
                    || isHexLetter(chars[j]) || chars[j] == "x" || chars[j] == "X") { j += 1 }
                if lexicon.unitNumbers {
                    while j < chars.count && (isIdentStart(chars[j]) || chars[j] == "%") { j += 1 }
                }
                tokens.push(.num, String(chars[i..<j]))
                i = j
                continue
            }
            if isIdentStart(ch) || (ch == "@" && lexicon.blockComment != nil && lexicon.lineComments.isEmpty) {
                // css at-rules keep their "@" with the word so `@media` tints as one keyword
                var j = i + (ch == "@" ? 1 : 0)
                while j < chars.count && isIdentPart(chars[j]) { j += 1 }
                let word = String(chars[i..<j])
                let bare = ch == "@" ? String(word.dropFirst()) : word
                if ch == "@" || lexicon.keywords.contains(bare) {
                    tokens.push(.kw, word)
                } else if lexicon.capitalTypes, let f = bare.first, ("A"..."Z").contains(f) {
                    tokens.push(.typ, word)
                } else {
                    tokens.push(.plain, word)
                }
                i = j
                continue
            }
            if isPunct(ch) {
                tokens.push(.pun, String(ch))
                i += 1
                continue
            }
            tokens.push(.plain, String(ch))
            i += 1
        }
        return tokens.out
    }

    /// Tint `text` for `language`. Unknown languages (and anything past the ceiling)
    /// come back as plain tokens, so the consumer's fallback is the exact pre-tint
    /// output. The concatenated token text is ALWAYS the input.
    static func tokenizeCode(language: String, text: String) -> [CodeToken] {
        let id = language.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let chars = Array(text)
        let capped = chars.count > tintLimitCharacters ? Array(chars.prefix(tintLimitCharacters)) : chars
        let rest = String(chars[capped.count...])
        var out: [CodeToken]
        if markupLanguages.contains(id) {
            out = tokenizeMarkup(capped)
        } else if let lexicon = lexicons[id] {
            out = tokenizeWithLexicon(capped, lexicon)
        } else {
            out = capped.isEmpty ? [] : [CodeToken(kind: .plain, text: String(capped))]
        }
        if !rest.isEmpty {
            if let last = out.last, last.kind == .plain {
                out[out.count - 1] = CodeToken(kind: .plain, text: last.text + rest)
            } else {
                out.append(CodeToken(kind: .plain, text: rest))
            }
        }
        return out
    }
}

// MARK: - the design language (MarkdownProse — the prose sheet's numbers, at native scale)

enum MarkdownProse {

    /// One text role: size in points (the sheet's rem values at the 16pt body, fluid
    /// clamps taken at their phone-width minimum), tracking in em, CSS-number weight.
    struct TypeSpec {
        let size: CGFloat
        let weight: Font.Weight
        let trackingEm: CGFloat
        let lineHeight: CGFloat
    }

    static let bodySize: CGFloat = 16

    /// Body flow — 1rem / 1.7 / -0.009em over the `label` token.
    static let paragraph = TypeSpec(size: 16, weight: .regular, trackingEm: -0.009, lineHeight: 1.7)

    /// The lede convention: the first paragraph after the page h1 reads as a deck
    /// (1.125em / 1.6 / -0.011em, `tertiary` ink).
    static let lede = TypeSpec(size: 18, weight: .regular, trackingEm: -0.011, lineHeight: 1.6)

    /// The type scale: tracking tightens and weight rises as the level climbs.
    static func heading(_ level: Int) -> TypeSpec {
        switch max(1, min(level, 6)) {
        case 1: return TypeSpec(size: 28, weight: .bold, trackingEm: -0.022, lineHeight: 1.15)
        case 2: return TypeSpec(size: 22, weight: .semibold, trackingEm: -0.018, lineHeight: 1.25)
        case 3: return TypeSpec(size: 18, weight: .semibold, trackingEm: -0.014, lineHeight: 1.3)
        case 4: return TypeSpec(size: 17, weight: .semibold, trackingEm: -0.01, lineHeight: 1.4)
        default: return TypeSpec(size: 15, weight: .semibold, trackingEm: -0.006, lineHeight: 1.4)
        }
    }

    /// Heading ink — `label`, except h6 which drops to `secondary` (the sheet's h6).
    static func headingInk(_ level: Int) -> String { level >= 6 ? "secondary" : "label" }

    // Surfaces + inks as semantic-token WORDS (StackStyle.color vocabulary).
    static let bodyInk = "label"
    static let ledeInk = "tertiary"
    static let linkInk = "accent"
    static let chipSurface = "fill"                        // inline code chip — --dsx-fill
    static let codeSurface = "groupedBackground"           // fenced code — --dsx-secondary-background
    static let cardSurface = "secondaryGroupedBackground"  // table card — --dsx-surface-raised
    static let bandSurface = "fill"                        // table header band — --dsx-fill
    static let bandInk = "secondary"
    static let markerInk = "tertiary"                      // list markers — muted, tabular
    static let hairlineInk = "separator"

    /// Soft hairlines (code ring, table row rules) — the separator token at reduced
    /// alpha, the --dsx-outline-soft stand-in the Table twins already established.
    static let softHairlineAlpha: CGFloat = 0.5

    /// The quote rail is the accent at 55%, its wash the accent at 12% — off the app's
    /// own tint so a white-label accent carries into its prose.
    static let quoteRailAlpha: CGFloat = 0.55
    static let quoteWashAlpha: CGFloat = 0.12
    static let quoteRailWidth: CGFloat = 3

    // Metrics, in points (the sheet's px values).
    static let codeRadius: CGFloat = 12          // fenced code + images
    static let cardRadius: CGFloat = 14          // table card — --dsx-radius-card
    static let chipRadius: CGFloat = 6           // inline chip + band caps — --dsx-radius-sm
    static let codePadV: CGFloat = 16            // --dsx-space-4
    static let codePadH: CGFloat = 20            // --dsx-space-5
    static let codeFontSize: CGFloat = 14        // 0.875em
    static let codeLineHeight: CGFloat = 1.65
    static let chipFontScale: CGFloat = 0.9      // inline code — 0.9em of its run
    static let cardPad: CGFloat = 8              // --dsx-space-2
    static let bandHeight: CGFloat = 36          // 2.25rem
    static let bandFontSize: CGFloat = 12
    static let bandTrackingEm: CGFloat = 0.02    // the one tracking that WIDENS — band caps
    static let bandGap: CGFloat = 5              // the spacer between band and rows
    static let tableFontSize: CGFloat = 15       // 0.9375em
    static let tableCellPadV: CGFloat = 8        // --dsx-space-2
    static let tableCellPadH: CGFloat = 12       // --dsx-space-3
    static let quotePadV: CGFloat = 12           // --dsx-space-3
    static let quotePadH: CGFloat = 20           // --dsx-space-5
    static let listIndent: CGFloat = 24          // 1.5em
    static let listItemGap: CGFloat = 6          // 0.375em
    static let imageRadius: CGFloat = 12

    /// Vertical rhythm: the sheet's per-block margins (em of the block's own size,
    /// precomputed to points). Adjacent blocks collapse to the larger edge (gap).
    static func spaceAbove(_ block: MarkdownBlock) -> CGFloat {
        switch block {
        case .heading(let level, _):
            switch max(1, min(level, 6)) {
            case 1: return 0
            case 2: return 1.9 * 22
            case 3: return 1.7 * 18
            case 4: return 1.6 * 17
            default: return 1.5 * 15
            }
        case .paragraph, .list: return 1.1 * bodySize
        case .rule: return 2.5 * bodySize
        default: return 1.5 * bodySize
        }
    }

    static func spaceBelow(_ block: MarkdownBlock) -> CGFloat {
        switch block {
        case .heading(let level, _):
            switch max(1, min(level, 6)) {
            case 1: return 0.6 * 28
            case 2: return 0.65 * 22
            case 3: return 0.6 * 18
            case 4: return 0.5 * 17
            default: return 0.5 * 15
            }
        case .paragraph, .list: return 1.1 * bodySize
        case .rule: return 2.5 * bodySize
        default: return 1.5 * bodySize
        }
    }

    /// The gap between two adjacent blocks: CSS-collapse (the larger of the meeting
    /// margins), zero before the first block, and the subtitle rule — a heading
    /// directly after a heading closes up to 0.35em of its own size.
    static func gap(previous: MarkdownBlock?, current: MarkdownBlock) -> CGFloat {
        guard let previous = previous else { return 0 }
        if case .heading(let prevLevel, _) = previous, prevLevel <= 4,
           case .heading(let level, _) = current {
            return 0.35 * heading(level).size
        }
        return max(spaceBelow(previous), spaceAbove(current))
    }

    /// Is this paragraph the lede — the first paragraph, directly after the page h1?
    static func isLede(previous: MarkdownBlock?, current: MarkdownBlock) -> Bool {
        if case .paragraph = current, case .heading(let level, _)? = previous, level == 1 { return true }
        return false
    }

    /// The extra line spacing that lands a Text on the sheet's line-height multiple —
    /// the SwiftUI idiom for CSS line-height (target minus the font's own line height).
    static func lineSpacing(size: CGFloat, multiple: CGFloat, mono: Bool = false) -> CGFloat {
        let font = mono ? UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
                        : UIFont.systemFont(ofSize: size)
        return max(0, size * multiple - font.lineHeight)
    }

    /// The tint palette — the prose sheet's own scheme tables (--dsx-code-*), as
    /// dynamic colors so a trait flip re-resolves without a second signal. Comments
    /// additionally italicize (the renderer's job).
    static func tint(_ kind: MarkdownBlocks.CodeTokenKind) -> Color? {
        let pair: (light: String, dark: String)
        switch kind {
        case .kw: pair = ("#5A4FB5", "#AAB1F2")
        case .str: pair = ("#2F6D4F", "#84C8A2")
        case .com: pair = ("#69707D", "#9094A0")
        case .num: pair = ("#8F5310", "#D3A878")
        case .typ: pair = ("#0E6A74", "#72C6D4")
        case .pun: pair = ("#5F6068", "#A8A8B0")
        case .plain: return nil
        }
        return Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: pair.dark) : UIColor(hex: pair.light)
        })
    }
}

// MARK: - the SwiftUI consumer (the prose plane rendered)

struct MarkdownBlocksView: View {
    let source: String
    let store: StackStore
    let env: JSERunner
    let item: [String: Any]?
    let rowWrite: ((String, Any) -> Void)?

    var body: some View {
        let blocks = MarkdownBlocks.parse(source)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(blocks.indices, id: \.self) { i in
                let previous = i > 0 ? blocks[i - 1] : nil
                blockView(blocks[i], lede: MarkdownProse.isLede(previous: previous, current: blocks[i]))
                    .padding(.top, MarkdownProse.gap(previous: previous, current: blocks[i]))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // ── inline runs: ONE parser, emitted as AttributedString ──────────────────────────

    private struct InlineStyle {
        var bold = false
        var italic = false
        var strike = false
        var code = false
        var link: String? = nil
    }

    /// The inline vocabulary as attributed runs: code spans are the chip (mono at 0.9em
    /// over the `fill` token), links are accent + underline — live only for the absolute
    /// allowlisted schemes (a relative target has no base in an app surface).
    private func inlineAttributed(_ source: String, size: CGFloat, weight: Font.Weight,
                                  strongWeight: Font.Weight, ink: Color) -> AttributedString {
        var out = AttributedString()
        var stack = [InlineStyle()]
        let chip = StackStyle.color(MarkdownProse.chipSurface)
        let accent = StackStyle.color(MarkdownProse.linkInk)
        MarkdownBlocks.parseInline(source, MarkdownInlineSink(
            text: { value in
                let style = stack.last ?? InlineStyle()
                var run = AttributedString(value)
                var font: Font = .system(size: style.code ? size * MarkdownProse.chipFontScale : size,
                                         weight: style.bold ? strongWeight : weight,
                                         design: style.code ? .monospaced : .default)
                if style.italic { font = font.italic() }
                run.font = font
                run.foregroundColor = style.link != nil ? accent : ink
                if style.code { run.backgroundColor = chip }
                if style.strike { run.strikethroughStyle = .single }
                if let link = style.link {
                    run.underlineStyle = .single
                    let lower = link.lowercased()
                    if lower.hasPrefix("http") || lower.hasPrefix("mailto:") || lower.hasPrefix("tel:"),
                       let url = URL(string: link) {
                        run.link = url
                    }
                }
                out.append(run)
            },
            open: { tag, href in
                var style = stack.last ?? InlineStyle()
                switch tag {
                case "strong": style.bold = true
                case "em": style.italic = true
                case "del": style.strike = true
                case "code": style.code = true
                default: style.link = href
                }
                stack.append(style)
            },
            close: { if stack.count > 1 { stack.removeLast() } }
        ))
        return out
    }

    private func inlineText(_ inline: String, spec: MarkdownProse.TypeSpec,
                            strongWeight: Font.Weight = .semibold, ink: Color) -> some View {
        Text(inlineAttributed(inline, size: spec.size, weight: spec.weight,
                              strongWeight: strongWeight, ink: ink))
            .tracking(spec.trackingEm * spec.size)
            .lineSpacing(MarkdownProse.lineSpacing(size: spec.size, multiple: spec.lineHeight))
            .fixedSize(horizontal: false, vertical: true)
    }

    private func softHairline() -> Color {
        StackStyle.color(MarkdownProse.hairlineInk).opacity(MarkdownProse.softHairlineAlpha)
    }

    // ── blocks ────────────────────────────────────────────────────────────────────────

    private func blockView(_ block: MarkdownBlock, lede: Bool) -> AnyView {
        switch block {
        case .paragraph(let inline):
            let spec = lede ? MarkdownProse.lede : MarkdownProse.paragraph
            let ink = StackStyle.color(lede ? MarkdownProse.ledeInk : MarkdownProse.bodyInk)
            return AnyView(inlineText(inline, spec: spec, ink: ink))

        case .heading(let level, let inline):
            let spec = MarkdownProse.heading(level)
            let ink = StackStyle.color(MarkdownProse.headingInk(level))
            return AnyView(inlineText(inline, spec: spec, strongWeight: .bold, ink: ink)
                .accessibilityAddTraits(.isHeader))

        case .code(let language, let text):
            return AnyView(codeView(language: language, text: text))

        case .quote(let blocks):
            return AnyView(quoteView(blocks))

        case .rule:
            return AnyView(Rectangle()
                .fill(StackStyle.color(MarkdownProse.hairlineInk))
                .frame(height: 1)
                .frame(maxWidth: .infinity))

        case .image(let src, let alt):
            // The REAL `<image>` element (content-plane cache, unsized → full width at
            // its intrinsic aspect), with the sheet's radius riding the style chain.
            var attrs = ["src": src, "radius": "\(Int(MarkdownProse.imageRadius))"]
            if !alt.isEmpty { attrs["a11yLabel"] = alt }
            return AnyView(StackNodeView(node: StackNode(tag: "image", attrs: attrs, children: []),
                                         store: store, env: env, item: item, rowWrite: rowWrite))

        case .list(let ordered, let start, let items):
            return AnyView(listView(ordered: ordered, start: start, items: items))

        case .table(let header, let rows):
            return AnyView(tableView(header: header, rows: rows))
        }
    }

    /// Fenced code: an elevated surface — secondary surface, soft hairline ring,
    /// radius 12, mono type with the shared syntax tint, horizontal overflow scrolls.
    private func codeView(language: String, text: String) -> some View {
        var tinted = AttributedString()
        for token in MarkdownBlocks.tokenizeCode(language: language, text: text) {
            var run = AttributedString(token.text)
            var font: Font = .system(size: MarkdownProse.codeFontSize, design: .monospaced)
            if token.kind == .com { font = font.italic() }
            run.font = font
            run.foregroundColor = MarkdownProse.tint(token.kind) ?? StackStyle.color(MarkdownProse.bodyInk)
            tinted.append(run)
        }
        let shape = RoundedRectangle(cornerRadius: MarkdownProse.codeRadius, style: .continuous)
        return ScrollView(.horizontal, showsIndicators: false) {
            Text(tinted)
                .lineSpacing(MarkdownProse.lineSpacing(size: MarkdownProse.codeFontSize,
                                                       multiple: MarkdownProse.codeLineHeight, mono: true))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, MarkdownProse.codePadV)
                .padding(.horizontal, MarkdownProse.codePadH)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StackStyle.color(MarkdownProse.codeSurface))
        .clipShape(shape)
        .overlay(shape.strokeBorder(softHairline(), lineWidth: 1))
    }

    /// Blockquote: accent start rail over a quiet accent wash, end corners rounded.
    private func quoteView(_ blocks: [MarkdownBlock]) -> some View {
        let accent = StackStyle.color(MarkdownProse.linkInk)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(blocks.indices, id: \.self) { i in
                let previous = i > 0 ? blocks[i - 1] : nil
                blockView(blocks[i], lede: false)
                    .padding(.top, MarkdownProse.gap(previous: previous, current: blocks[i]))
            }
        }
        .padding(.vertical, MarkdownProse.quotePadV)
        .padding(.horizontal, MarkdownProse.quotePadH)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(accent.opacity(MarkdownProse.quoteWashAlpha))
        .overlay(alignment: .leading) {
            Rectangle().fill(accent.opacity(MarkdownProse.quoteRailAlpha))
                .frame(width: MarkdownProse.quoteRailWidth)
        }
        .clipShape(UnevenRoundedRectangle(
            topLeadingRadius: 0, bottomLeadingRadius: 0,
            bottomTrailingRadius: MarkdownProse.chipRadius,
            topTrailingRadius: MarkdownProse.chipRadius, style: .continuous))
    }

    /// Lists: muted tabular markers in a fixed gutter, items on the body rhythm,
    /// nested blocks indented under their item.
    private func listView(ordered: Bool, start: Int, items: [MarkdownListItem]) -> some View {
        let spec = MarkdownProse.paragraph
        let marker = StackStyle.color(MarkdownProse.markerInk)
        return VStack(alignment: .leading, spacing: MarkdownProse.listItemGap) {
            ForEach(items.indices, id: \.self) { index in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(ordered ? "\(start + index)." : "•")
                        .font(.system(size: spec.size).monospacedDigit())
                        .foregroundColor(marker)
                        .frame(width: MarkdownProse.listIndent - 6, alignment: .trailing)
                    VStack(alignment: .leading, spacing: MarkdownProse.listItemGap) {
                        inlineText(items[index].inline, spec: spec,
                                   ink: StackStyle.color(MarkdownProse.bodyInk))
                        ForEach(items[index].blocks.indices, id: \.self) { j in
                            blockView(items[index].blocks[j], lede: false)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Tables: a padded raised card whose header is a BAND, not a border — equal
    /// flexible columns (the Table element's own layout), soft hairlines between rows.
    private func tableView(header: [String], rows: [[String]]) -> some View {
        let spec = MarkdownProse.paragraph
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 0) {
                ForEach(header.indices, id: \.self) { c in
                    Text(inlineAttributed(header[c], size: MarkdownProse.bandFontSize,
                                          weight: .semibold, strongWeight: .bold,
                                          ink: StackStyle.color(MarkdownProse.bandInk)))
                        .tracking(MarkdownProse.bandTrackingEm * MarkdownProse.bandFontSize)
                        .padding(.horizontal, MarkdownProse.tableCellPadH)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(height: MarkdownProse.bandHeight)
            .background(StackStyle.color(MarkdownProse.bandSurface))
            .clipShape(RoundedRectangle(cornerRadius: MarkdownProse.chipRadius, style: .continuous))
            .accessibilityAddTraits(.isHeader)
            .padding(.bottom, MarkdownProse.bandGap)
            ForEach(rows.indices, id: \.self) { r in
                HStack(alignment: .top, spacing: 0) {
                    ForEach(rows[r].indices, id: \.self) { c in
                        inlineText(rows[r][c],
                                   spec: MarkdownProse.TypeSpec(size: MarkdownProse.tableFontSize,
                                                                weight: .regular,
                                                                trackingEm: spec.trackingEm,
                                                                lineHeight: 1.5),
                                   ink: StackStyle.color(MarkdownProse.bodyInk))
                            .padding(.horizontal, MarkdownProse.tableCellPadH)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.vertical, MarkdownProse.tableCellPadV)
                .accessibilityElement(children: .combine)   // a row reads as ONE element
                if r < rows.count - 1 {
                    Rectangle().fill(softHairline()).frame(height: 1)
                }
            }
        }
        .padding(MarkdownProse.cardPad)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StackStyle.color(MarkdownProse.cardSurface))
        .clipShape(RoundedRectangle(cornerRadius: MarkdownProse.cardRadius, style: .continuous))
        .shadow(color: Color.black.opacity(0.06), radius: 5, x: 0, y: 2)
    }
}

// MARK: - `<markdown>` (Basics vocabulary) — the class-walk registration

/// `<markdown>` — the BLOCK vocabulary: headings, paragraphs, lists, fenced code,
/// blockquotes, tables, standalone images, rules. The inline twin stays on
/// `<text markdown="true">` (Text.swift), which renders what SwiftUI's Text renders and
/// nothing more. Class is `MarkdownElement` (tag lowercase, like `text`).
final class MarkdownElement: GlobalStackComponent {
    override class var tag: String { "markdown" }
    override class func body(_ dsx: StackComponentContext) -> AnyView {
        AnyView(MarkdownBlocksView(source: dsx.text(), store: dsx.store, env: dsx.env,
                                   item: dsx.item, rowWrite: dsx.rowWrite))
    }
}
