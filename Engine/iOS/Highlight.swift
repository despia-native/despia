import Foundation

//
//  Highlight.swift - source spans for the `<code>` surface. Swift reference for
//  packages/kernel/src/jse/highlight.ts and Highlight.kt; the shared corpus is
//  OpenSource/Conformance/code/tokens.json.
//
//  THIS IS NOT `JSE.tokenize`. The evaluator's lexer strips comments, runs ASI and hands back
//  values with no idea where they came from - correct for running code, useless for drawing
//  it. A highlighter needs the opposite: every character accounted for, comments and
//  whitespace included, in source order, with offsets. So it is its own scanner, and it
//  shares the ONE rule that must not drift - whether a `/` opens a regex or divides.
//
//  The output TILES the source: contiguous, non-overlapping, index 0 to length. That is what
//  lets the corpus be a MASK of one letter per character, readable against the source by eye.
//

public enum HiKind: String, CaseIterable {
    case plain, comment, string, number, regex, keyword, literal, call, property, ident, operatorTok, punct

    /// The corpus letter. `operator` is a Swift keyword, so the case is spelled
    /// `operatorTok` and the wire word is restored here - the corpus never sees the rename.
    public var letter: Character {
        switch self {
        case .plain: return "."
        case .comment: return "c"
        case .string: return "s"
        case .number: return "n"
        case .regex: return "r"
        case .keyword: return "k"
        case .literal: return "l"
        case .call: return "f"
        case .property: return "p"
        case .ident: return "i"
        case .operatorTok: return "o"
        case .punct: return "x"
        }
    }

    public var word: String { self == .operatorTok ? "operator" : rawValue }
}

public struct HiToken: Equatable {
    public let start: Int
    public let end: Int
    public let kind: HiKind
}

public struct HiSpan: Equatable {
    public let text: String
    public let kind: HiKind
}

public struct HiLine: Equatable {
    public let line: Int
    public let spans: [HiSpan]
}

public enum Highlight {

    private static let keywords: Set<String> = [
        "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
        "break", "continue", "switch", "case", "default", "try", "catch", "finally", "throw",
        "new", "typeof", "instanceof", "in", "of", "delete", "void", "await", "async", "yield",
        "this",
    ]
    private static let literals: Set<String> = ["true", "false", "null", "undefined"]
    private static let punct: Set<Character> = ["(", ")", "[", "]", "{", "}", ",", ";"]
    private static let operators: Set<Character> = ["+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~", "?", ":", "."]

    private static func isDigit(_ c: Character) -> Bool { c >= "0" && c <= "9" }
    private static func isWordStart(_ c: Character) -> Bool { c.isLetter || c == "_" || c == "$" }
    private static func isWordChar(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" || c == "$" }

    /// The regex-vs-division rule, identical to the evaluator's: a `/` is a regex when nothing
    /// valued precedes it, and a keyword does not count as a value.
    private static func opensRegex(_ c: [Character], _ at: Int) -> Bool {
        var i = at - 1
        while i >= 0 && c[i].isWhitespace { i -= 1 }
        if i < 0 { return true }
        let prev = c[i]
        if prev == ")" || prev == "]" || prev == "'" || prev == "\"" || prev == "`" { return false }
        if !isWordChar(prev) { return true }
        var j = i
        while j >= 0 && isWordChar(c[j]) { j -= 1 }
        let word = String(c[(j + 1)...i])
        return keywords.contains(word) && word != "this"
    }

    private static func endOfRegex(_ c: [Character], _ at: Int) -> Int {
        var i = at + 1
        var inClass = false
        while i < c.count {
            let ch = c[i]
            if ch == "\\" { i = min(i + 2, c.count); continue }
            if ch == "\n" { return i }
            if ch == "[" { inClass = true; i += 1; continue }
            if ch == "]" { inClass = false; i += 1; continue }
            if ch == "/" && !inClass { i += 1; break }
            i += 1
        }
        while i < c.count && c[i] >= "a" && c[i] <= "z" { i += 1 }
        return i
    }

    private static func endOfNumber(_ c: [Character], _ at: Int) -> Int {
        var i = at
        if c[i] == "0" && i + 1 < c.count && "xXbBoO".contains(c[i + 1]) {
            i += 2
            while i < c.count && (isDigit(c[i]) || "abcdefABCDEF_".contains(c[i])) { i += 1 }
            return i
        }
        while i < c.count && (isDigit(c[i]) || c[i] == "_") { i += 1 }
        if i < c.count && c[i] == "." && i + 1 < c.count && isDigit(c[i + 1]) {
            i += 1
            while i < c.count && (isDigit(c[i]) || c[i] == "_") { i += 1 }
        }
        if i < c.count && (c[i] == "e" || c[i] == "E") {
            var k = i + 1
            if k < c.count && (c[k] == "+" || c[k] == "-") { k += 1 }
            if k < c.count && isDigit(c[k]) {
                k += 1
                while k < c.count && isDigit(c[k]) { k += 1 }
                i = k
            }
        }
        return i
    }

    /// Spans covering every character of `source`, in order, with no gaps and no overlap.
    public static func scan(_ source: String) -> [HiToken] {
        let c = Array(source)
        var out: [HiToken] = []
        func push(_ start: Int, _ end: Int, _ kind: HiKind) {
            guard end > start else { return }
            if let last = out.last, last.kind == kind, last.end == start {
                out[out.count - 1] = HiToken(start: last.start, end: end, kind: kind)
                return
            }
            out.append(HiToken(start: start, end: end, kind: kind))
        }

        var holes: [Int] = []
        var depth = 0
        var i = 0

        while i < c.count {
            let ch = c[i]

            if ch.isWhitespace {
                let s = i
                while i < c.count && c[i].isWhitespace { i += 1 }
                push(s, i, .plain)
                continue
            }

            if ch == "/" && i + 1 < c.count && c[i + 1] == "/" {
                let s = i
                while i < c.count && c[i] != "\n" { i += 1 }
                push(s, i, .comment)
                continue
            }
            if ch == "/" && i + 1 < c.count && c[i + 1] == "*" {
                let s = i
                var close = -1
                var k = i + 2
                while k + 1 < c.count {
                    if c[k] == "*" && c[k + 1] == "/" { close = k; break }
                    k += 1
                }
                i = close < 0 ? c.count : close + 2
                push(s, i, .comment)
                continue
            }
            if ch == "/" && opensRegex(c, i) {
                let s = i
                i = endOfRegex(c, i)
                push(s, i, .regex)
                continue
            }

            if ch == "'" || ch == "\"" {
                let s = i
                i += 1
                while i < c.count {
                    if c[i] == "\\" { i = min(i + 2, c.count); continue }
                    if c[i] == ch { i += 1; break }
                    if c[i] == "\n" { break }
                    i += 1
                }
                push(s, i, .string)
                continue
            }

            if ch == "`" {
                let s = i
                i += 1
                while i < c.count {
                    if c[i] == "\\" { i = min(i + 2, c.count); continue }
                    if c[i] == "`" { i += 1; break }
                    if c[i] == "$" && i + 1 < c.count && c[i + 1] == "{" { break }
                    i += 1
                }
                push(s, i, .string)
                if i + 1 < c.count && c[i] == "$" && c[i + 1] == "{" {
                    push(i, i + 2, .operatorTok)
                    i += 2
                    holes.append(depth)
                    depth = 0
                }
                continue
            }

            if isDigit(ch) || (ch == "." && i + 1 < c.count && isDigit(c[i + 1])) {
                let s = i
                i = endOfNumber(c, i)
                push(s, i, .number)
                continue
            }

            if isWordStart(ch) {
                let s = i
                while i < c.count && isWordChar(c[i]) { i += 1 }
                let word = String(c[s..<i])
                var j = i
                while j < c.count && (c[j] == " " || c[j] == "\t") { j += 1 }
                var k = s - 1
                while k >= 0 && (c[k] == " " || c[k] == "\t") { k -= 1 }
                let kind: HiKind
                if keywords.contains(word) { kind = .keyword }
                else if literals.contains(word) { kind = .literal }
                else if j < c.count && c[j] == "(" { kind = .call }
                else if k >= 0 && c[k] == "." && (k == 0 || c[k - 1] != ".") { kind = .property }
                else { kind = .ident }
                push(s, i, kind)
                continue
            }

            if ch == "}" && !holes.isEmpty && depth == 0 {
                push(i, i + 1, .operatorTok)
                i += 1
                depth = holes.removeLast()
                let s = i
                while i < c.count {
                    if c[i] == "\\" { i = min(i + 2, c.count); continue }
                    if c[i] == "`" { i += 1; break }
                    if c[i] == "$" && i + 1 < c.count && c[i + 1] == "{" { break }
                    i += 1
                }
                push(s, i, .string)
                if i + 1 < c.count && c[i] == "$" && c[i + 1] == "{" {
                    push(i, i + 2, .operatorTok)
                    i += 2
                    holes.append(depth)
                    depth = 0
                }
                continue
            }

            if punct.contains(ch) {
                if ch == "{" || ch == "[" || ch == "(" { depth += 1 }
                else if ch == "}" || ch == "]" || ch == ")" { depth = max(0, depth - 1) }
                push(i, i + 1, .punct)
                i += 1
                continue
            }
            if operators.contains(ch) {
                let s = i
                while i < c.count && operators.contains(c[i]) { i += 1 }
                push(s, i, .operatorTok)
                continue
            }

            push(i, i + 1, .plain)
            i += 1
        }
        return out
    }

    /// The corpus form: one letter per character. A wrong length fails before a wrong colour.
    public static func mask(_ source: String) -> String {
        var out = ""
        for tok in scan(source) {
            out += String(repeating: String(tok.kind.letter), count: tok.end - tok.start)
        }
        return out
    }

    /// The markup-facing shape: one row per source line, each a run of `{ text, kind }`.
    /// A code editor draws line by line, so the builtin hands back exactly that rather than
    /// offsets a page would have to slice.
    public static func lines(_ source: String) -> [HiLine] {
        let c = Array(source)
        var rows: [[HiSpan]] = [[]]
        for tok in scan(source) {
            let parts = String(c[tok.start..<tok.end]).components(separatedBy: "\n")
            for (index, part) in parts.enumerated() {
                if index > 0 { rows.append([]) }
                if part.isEmpty { continue }
                if let last = rows[rows.count - 1].last, last.kind == tok.kind {
                    rows[rows.count - 1][rows[rows.count - 1].count - 1] =
                        HiSpan(text: last.text + part, kind: tok.kind)
                    continue
                }
                rows[rows.count - 1].append(HiSpan(text: part, kind: tok.kind))
            }
        }
        return rows.enumerated().map { HiLine(line: $0.offset + 1, spans: $0.element) }
    }

    /// The JSE `highlight(source)` value: plain dictionaries and arrays the store can render.
    public static func jseValue(_ source: String) -> [[String: Any]] {
        lines(source).map { row in
            [
                "line": row.line,
                "spans": row.spans.map { ["text": $0.text, "kind": $0.kind.word] },
            ]
        }
    }
}
