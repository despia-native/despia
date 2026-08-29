//
//  DSXFilePaths.swift — the shared `files` core: the root vocabulary, the per-platform physical
//  base each token maps to, path normalisation, and the containment check that IS the sandbox.
//  The law is the corpus, `OpenSource/Conformance/files/{paths,errors}.json`
//  (parity/F03-files.md); the Kotlin twin is `:core` DSXFilePaths.kt and the web twin is
//  @despia/kernel's parseFilePath / filePathContains.
//
//  This is a SECURITY boundary, not a convenience. Markup never names an absolute path: it
//  names `root:relative`, and everything a facet is allowed to touch follows from what this
//  file returns. Two halves, and both matter:
//
//    • parse    — the TEXTUAL half. Trim, match the root EXACT CASE against the closed
//      five-word vocabulary, then normalise the relative part (`.` dropped, `..` popped, empty
//      segments collapsed) BEFORE testing for escape, because testing first is the classic
//      bypass. Percent escapes are never decoded into structure: a segment that decodes to a
//      dot segment or to a separator is refused outright.
//    • contains — the PHYSICAL half, asked AFTER the OS has resolved symlinks on both sides
//      (`URL.resolvingSymlinksInPath()`). `/a/bc` is not inside `/a/b`; forgetting the
//      separator there is the bug every hand-rolled containment check ships at least once.
//
//  Everything platform-shaped lives OUTSIDE this file. The Files module turns a base token into
//  a real container URL (FileManager) and does the I/O; keeping the DECISION separate from the
//  PLUMBING is what lets one corpus judge three renderers.
//
//  No UIKit import: this file is pure so the record lane can run it headless.
//
import Foundation

public enum DSXFilePaths {

    /// The closed root vocabulary. A path is `root:relative`, and nothing else is addressable.
    public static let roots: [String] = ["documents", "cache", "temp", "shared", "bundle"]

    /// The action surface, shared so a fixture cannot name an action no renderer implements.
    public static let actions: [String] = [
        "info", "read", "write", "delete", "move", "copy", "mkdir", "list",
        "download", "upload", "free", "hash", "zip", "unzip", "exclude"
    ]

    /// The platforms the base table answers for.
    public static let platforms: [String] = ["ios", "android", "web"]

    /// The physical base each root resolves to, as a platform TOKEN rather than a container
    /// path: the container path is a runtime value, the choice of directory is the decision,
    /// and the decision is what has to agree on three renderers. A nil base is the typed
    /// absence — that platform has no such place, so the facet resolves `unsupported_platform`.
    private static let bases: [String: [String: String?]] = [
        "documents": ["ios": "Documents", "android": "filesDir", "web": "opfs"],
        "cache":     ["ios": "Caches",    "android": "cacheDir", "web": "cacheStorage"],
        "temp":      ["ios": "tmp",       "android": "cacheDir/tmp", "web": "memory"],
        "shared":    ["ios": "AppGroup",  "android": "externalFilesDir", "web": nil],
        "bundle":    ["ios": "Bundle",    "android": "assets", "web": "origin"]
    ]

    /// The read-only root. A write, mkdir, delete or move-to against it is `permission_denied`.
    private static let writableRoots: [String: Bool] = [
        "documents": true, "cache": true, "temp": true, "shared": true, "bundle": false
    ]

    /// Every code the module settles with, and whether a retry is worth offering. Pinned by
    /// errors.json so `recoverable` cannot mean one thing on one renderer and another elsewhere.
    public static let errorRecoverable: [String: Bool] = [
        "not_found": false,
        "permission_denied": false,
        "no_space": true,
        "is_directory": false,
        "not_directory": false,
        "exists": true,
        "hash_mismatch": true,
        "network_failed": true,
        "http_error": true,
        "unsupported_root": false,
        "unsupported_platform": false
    ]

    /// The typed-absence roster: capabilities a platform genuinely lacks, which resolve
    /// `unsupported_platform` with a real message rather than a silent no-op (durability P4).
    public static let unsupportedByPlatform: [String: [String]] = [
        "ios": [],
        "android": ["exclude"],
        "web": ["shared", "zip", "unzip", "exclude", "background"]
    ]

    /// A path this module will not address — one condition with one code, whatever shape the
    /// attempt took, because a probing caller learns nothing from a finer distinction.
    public enum Refusal: String, Error, Equatable {
        case unsupportedRoot = "unsupported_root"

        /// The stable machine id the module reports and the corpus pins.
        public var code: String { rawValue }
    }

    /// A parsed document path: the root token, and the normalised relative path inside it
    /// (`""` for the root itself).
    public struct Parsed: Equatable {
        public let root: String
        public let relative: String
        public init(root: String, relative: String) {
            self.root = root
            self.relative = relative
        }
    }

    /// Parse a `root:relative` document path.
    ///
    /// The root is matched exact-case against `roots` — a case-insensitive vocabulary is a
    /// vocabulary nobody can lint. The relative part is normalised, then tested for escape; a
    /// `..` that stays inside the root is legal and folded away, a `..` that climbs out throws.
    /// A backslash, a colon, a control character, a `~` segment and any percent escape that
    /// decodes to a dot segment or a separator are all refused: none of them can name something
    /// inside the sandbox, and every one of them is somebody's traversal attempt.
    public static func parse(_ raw: String?) throws -> Parsed {
        let text = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw Refusal.unsupportedRoot }

        guard let colon = text.firstIndex(of: ":"), colon != text.startIndex else {
            throw Refusal.unsupportedRoot
        }
        let root = String(text[text.startIndex..<colon])
        guard roots.contains(root) else { throw Refusal.unsupportedRoot }

        let rest = String(text[text.index(after: colon)...])
        guard !hasControlCharacter(rest) else { throw Refusal.unsupportedRoot }
        guard !rest.contains("\\"), !rest.contains(":") else { throw Refusal.unsupportedRoot }

        var stack: [String] = []
        for segment in rest.components(separatedBy: "/") {
            if segment.isEmpty || segment == "." { continue }
            if segment == ".." {
                guard !stack.isEmpty else { throw Refusal.unsupportedRoot }
                stack.removeLast()
                continue
            }
            guard !segment.hasPrefix("~") else { throw Refusal.unsupportedRoot }
            let decoded = decodeSegment(segment)
            guard decoded != ".", decoded != ".." else { throw Refusal.unsupportedRoot }
            guard !decoded.contains("/"), !decoded.contains("\\") else { throw Refusal.unsupportedRoot }
            stack.append(segment)
        }
        return Parsed(root: root, relative: stack.joined(separator: "/"))
    }

    /// The physical base token for a root on a platform, or nil when the platform has no such
    /// place (the typed absence). An unknown root or platform is also nil.
    public static func base(_ root: String, platform: String) -> String? {
        guard let row = bases[root], let value = row[platform] else { return nil }
        return value
    }

    /// Whether a root accepts writes. An unknown root is not writable.
    public static func writable(_ root: String) -> Bool { writableRoots[root] == true }

    /// Whether a platform lacks a capability outright (so it resolves `unsupported_platform`).
    public static func unsupported(_ platform: String, _ capability: String) -> Bool {
        (unsupportedByPlatform[platform] ?? []).contains(capability)
    }

    /// Is `candidate` inside `base`? Asked after the facet has resolved symlinks on both sides,
    /// so a symlink pointing out of the sandbox fails here instead of being followed.
    ///
    /// Both sides must be absolute. `/a/bc` is NOT inside `/a/b`: the separator is load-bearing,
    /// and omitting it is the prefix bug. Comparison is byte-exact — on a case-insensitive
    /// filesystem a mismatch means the OS resolved something we did not expect, which is
    /// precisely when to refuse.
    public static func contains(base: String, candidate: String) -> Bool {
        guard base.hasPrefix("/"), candidate.hasPrefix("/") else { return false }
        let root = normalizeAbsolute(base)
        let target = normalizeAbsolute(candidate)
        if target == root { return true }
        return root == "/" ? target.hasPrefix("/") : target.hasPrefix(root + "/")
    }

    /// Collapse `.`, `..` and duplicate separators in an ABSOLUTE path. A `..` at the top stays
    /// at the top (POSIX `/..` is `/`). Keeps the leading `/`, drops any trailing one.
    private static func normalizeAbsolute(_ path: String) -> String {
        var stack: [String] = []
        for segment in path.components(separatedBy: "/") {
            if segment.isEmpty || segment == "." { continue }
            if segment == ".." {
                if !stack.isEmpty { stack.removeLast() }
                continue
            }
            stack.append(segment)
        }
        return "/" + stack.joined(separator: "/")
    }

    /// Percent-decode a single segment, tolerantly: a malformed escape stays literal. Used ONLY
    /// to ask whether a segment is hiding structure — the decoded form is never used as a name.
    private static func decodeSegment(_ segment: String) -> String {
        guard segment.contains("%") else { return segment }
        let chars = Array(segment)
        var out = ""
        var i = 0
        while i < chars.count {
            if chars[i] == "%", i + 2 < chars.count,
               let high = chars[i + 1].hexDigitValue, let low = chars[i + 2].hexDigitValue,
               let scalar = Unicode.Scalar(UInt32(high * 16 + low)) {
                out.append(Character(scalar))
                i += 3
                continue
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    /// `list`'s `glob` filter, matched against the path RELATIVE to the listed directory.
    ///
    /// A tiny, closed grammar on purpose: `*` matches any run of characters within one segment,
    /// `?` matches one character within one segment, and a whole segment of `**` matches zero or
    /// more segments. Brace expansion, character classes and negation are deliberately absent —
    /// they are where every hand-rolled matcher starts disagreeing with every other, and a
    /// listing filter needs none of them. Anchored (the whole relative path) and case-exact.
    public static func globMatch(_ pattern: String, _ path: String) -> Bool {
        matchSegments(pattern.components(separatedBy: "/"), path.components(separatedBy: "/"), 0, 0)
    }

    private static func matchSegments(_ pattern: [String], _ path: [String], _ p: Int, _ i: Int) -> Bool {
        if p == pattern.count { return i == path.count }
        if pattern[p] == "**" {
            for skip in i...path.count where matchSegments(pattern, path, p + 1, skip) { return true }
            return false
        }
        if i == path.count { return false }
        guard matchSegment(pattern[p], path[i]) else { return false }
        return matchSegments(pattern, path, p + 1, i + 1)
    }

    /// One segment against one segment: `*` is any run, `?` is one character, neither crosses `/`.
    private static func matchSegment(_ pattern: String, _ segment: String) -> Bool {
        let pat = Array(pattern)
        let seg = Array(segment)
        var p = 0
        var s = 0
        var star = -1
        var mark = 0
        while s < seg.count {
            if p < pat.count, pat[p] == "?" || pat[p] == seg[s] {
                p += 1
                s += 1
            } else if p < pat.count, pat[p] == "*" {
                star = p
                mark = s
                p += 1
            } else if star >= 0 {
                p = star + 1
                mark += 1
                s = mark
            } else {
                return false
            }
        }
        while p < pat.count, pat[p] == "*" { p += 1 }
        return p == pat.count
    }

    private static func hasControlCharacter(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    }
}
