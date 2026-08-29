//
//  LinkPreview.swift — the SHARED PURE CORE behind Core/Preview (F17.1), and the reference
//  renderer's leg of it. Twin of :core LinkPreview.kt and the web kernel's linkpreview.ts.
//
//  Four decisions live here because every hand-written OG scraper answers them differently:
//  which URLs are fetchable at all, how a reference resolves against the document that
//  carried it, which tag wins per field, and the fetch budget. The law is the corpus,
//  OpenSource/Conformance/preview/metadata.json.
//
//  NO Foundation.URL AS THE PARSER. `URL`, `java.net.URI` and the WHATWG parser disagree on
//  empty paths, uppercase hosts, backslashes and userinfo. A preview that resolves to a
//  different origin on one renderer is exactly the bug this core exists to prevent, so the
//  parser and the relative-reference resolver are written out longhand and corpus-pinned.
//
//  Pure Foundation, no UIKit, no WebKit: the fetch is platform plumbing and lives in the
//  module's swift/ facet. On iOS that facet prefers LPMetadataProvider and falls back to this
//  parser; on every other target this IS the implementation.
//
import Foundation

public enum LinkPreviewCore {

    /// A single response ceiling. An unbounded read of an attacker-chosen URL is a
    /// memory-exhaustion primitive, and the head is all a preview ever needs.
    public static let maxBytes = 262144
    public static let maxRedirects = 5
    public static let defaultTimeoutMs = 8000
    public static let minTimeoutMs = 1000
    public static let maxTimeoutMs = 30000

    /// Why a URL was refused before a single byte moved.
    public enum Refusal: String, Error {
        case invalidURL = "invalid_url"
        case unsupportedScheme = "unsupported_scheme"
        case credentialsInURL = "credentials_in_url"
    }

    public static let messages: [String: String] = [
        "invalid_url": "That is not a URL a preview can be fetched from.",
        "unsupported_scheme": "Link previews are only fetched over http and https.",
        "credentials_in_url": "A URL carrying a username or password is never fetched.",
    ]

    /// A validated fetch target, split the way every renderer needs it.
    public struct Target: Equatable {
        public let url: String
        public let origin: String
        public let host: String
        public let scheme: String
        public let path: String
    }

    public struct Preview: Equatable {
        public let title: String
        public let description: String
        public let image: String
        public let siteName: String
        public let favicon: String
        public let type: String
        public let canonical: String
    }

    /// What a scan of a document head found, before precedence is applied.
    public struct Tags {
        public let meta: [String: String]
        public let links: [String: String]
        public let documentTitle: String
    }

    /// Clamp an author-supplied timeout into the band the module honours. Outside the band is
    /// clamped, never refused: a caller asking for five minutes wants "as long as you can".
    public static func clampTimeout(_ raw: Any?) -> Int {
        var n: Double
        switch raw {
        case let v as Double: n = v
        case let v as Int: n = Double(v)
        case let v as NSNumber: n = v.doubleValue
        case let v as String: n = Double(v.trimmingCharacters(in: .whitespaces)) ?? 0
        default: return defaultTimeoutMs
        }
        guard n.isFinite, n > 0 else { return defaultTimeoutMs }
        if n < Double(minTimeoutMs) { return minTimeoutMs }
        if n > Double(maxTimeoutMs) { return maxTimeoutMs }
        return Int((n).rounded())
    }

    private static func defaultPort(for scheme: String) -> String { scheme == "https" ? "443" : "80" }

    private static func isSchemeToken(_ s: String) -> Bool {
        guard let first = s.first else { return false }
        guard first.isASCII, first.isLetter else { return false }
        for c in s {
            let ok = (c.isASCII && (c.isLetter || c.isNumber)) || c == "+" || c == "." || c == "-"
            if !ok { return false }
        }
        return true
    }

    /// Parse and normalize an absolute http(s) URL.
    ///
    /// Refuses before the network: anything that is not http/https (`file:` and `data:` are how
    /// a preview scraper becomes a local-file exfiltration gadget), and userinfo (the credential
    /// would be logged, cached and handed to a redirect target).
    public static func resolveTarget(_ raw: Any?) -> Result<Target, Refusal> {
        let input = ((raw as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if input.isEmpty { return .failure(.invalidURL) }

        let chars = Array(input)
        guard let colon = chars.firstIndex(of: ":"), colon > 0 else { return .failure(.invalidURL) }
        let scheme = String(chars[0..<colon]).lowercased()
        if !isSchemeToken(scheme) { return .failure(.invalidURL) }
        if scheme != "http" && scheme != "https" { return .failure(.unsupportedScheme) }
        guard chars.count >= colon + 3, chars[colon + 1] == "/", chars[colon + 2] == "/" else {
            return .failure(.invalidURL)
        }

        let rest = Array(chars[(colon + 3)...])
        var cut = rest.count
        for i in 0..<rest.count {
            let c = rest[i]
            if c == "/" || c == "?" || c == "#" || c == "\\" { cut = i; break }
        }
        var authority = String(rest[0..<cut])
        let tail = String(rest[cut...])

        if authority.contains("@") { return .failure(.credentialsInURL) }
        if authority.isEmpty { return .failure(.invalidURL) }

        var port = ""
        let authorityChars = Array(authority)
        let portCut = authorityChars.lastIndex(of: ":")
        // Escaped rather than literal so the repo's crude bracket-balance backstop stays honest.
        let closeBracket: Character = "\u{005D}"
        let bracketEnd = authorityChars.lastIndex(of: closeBracket) ?? -1
        if let pc = portCut, pc > bracketEnd {
            port = String(authorityChars[(pc + 1)...])
            authority = String(authorityChars[0..<pc])
            if !port.isEmpty, port.contains(where: { !$0.isASCII || !$0.isNumber }) {
                return .failure(.invalidURL)
            }
        }
        let host = authority.lowercased()
        if host.isEmpty { return .failure(.invalidURL) }
        if host.contains(where: { $0.isWhitespace || "<>\"{}|^`".contains($0) }) { return .failure(.invalidURL) }
        if port == defaultPort(for: scheme) { port = "" }

        let hostPort = port.isEmpty ? host : "\(host):\(port)"
        let origin = "\(scheme)://\(hostPort)"

        var pathAndTail = tail.replacingOccurrences(of: "\\", with: "/")
        if pathAndTail.isEmpty || (pathAndTail.first != "/" && pathAndTail.first != "?" && pathAndTail.first != "#") {
            pathAndTail = "/" + pathAndTail
        }
        if pathAndTail.first == "?" || pathAndTail.first == "#" { pathAndTail = "/" + pathAndTail }

        let patChars = Array(pathAndTail)
        let qCut = patChars.firstIndex(where: { $0 == "?" || $0 == "#" })
        var path = qCut == nil ? pathAndTail : String(patChars[0..<qCut!])
        if path.isEmpty { path = "/" }
        path = normalizePath(path)
        let suffix = qCut == nil ? "" : String(patChars[qCut!...])

        return .success(Target(url: "\(origin)\(path)\(suffix)", origin: origin,
                               host: hostPort, scheme: scheme, path: path))
    }

    /// RFC 3986 §5.2.4 remove_dot_segments, restricted to the absolute-path case we ever hold.
    public static func normalizePath(_ path: String) -> String {
        var out: [String] = []
        let trailing = path.hasSuffix("/") || path.hasSuffix("/.") || path.hasSuffix("/..")
        for segment in path.components(separatedBy: "/") {
            if segment.isEmpty || segment == "." { continue }
            if segment == ".." { if !out.isEmpty { out.removeLast() }; continue }
            out.append(segment)
        }
        var result = "/" + out.joined(separator: "/")
        if trailing && result != "/" { result += "/" }
        return result
    }

    /// Resolve a reference found in a document against the document's own URL. Returns "" for
    /// anything that cannot become an absolute http(s) URL, so a hostile page cannot smuggle a
    /// `javascript:` or `data:` scheme through the image or favicon slot.
    public static func resolveReference(_ base: Target, _ ref: Any?) -> String {
        let value = ((ref as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return "" }

        if value.hasPrefix("//") {
            if case let .success(t) = resolveTarget("\(base.scheme):\(value)") { return t.url }
            return ""
        }
        let chars = Array(value)
        if let schemeCut = chars.firstIndex(of: ":"), schemeCut > 0,
           isSchemeToken(String(chars[0..<schemeCut])) {
            if case let .success(t) = resolveTarget(value) { return t.url }
            return ""
        }
        if value.hasPrefix("#") || value.hasPrefix("?") { return "\(base.origin)\(base.path)\(value)" }

        let cut = chars.firstIndex(where: { $0 == "?" || $0 == "#" })
        let rawPath = cut == nil ? value : String(chars[0..<cut!])
        let suffix = cut == nil ? "" : String(chars[cut!...])

        if value.hasPrefix("/") { return "\(base.origin)\(normalizePath(rawPath))\(suffix)" }

        let baseChars = Array(base.path)
        let lastSlash = baseChars.lastIndex(of: "/")
        let dir = lastSlash == nil ? "/" : String(baseChars[0...lastSlash!])
        return "\(base.origin)\(normalizePath(dir + rawPath))\(suffix)"
    }

    // MARK: - the document scan

    private static let namedEntities: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'",
        "nbsp": "\u{00A0}", "hellip": "\u{2026}", "mdash": "\u{2014}", "ndash": "\u{2013}",
        "rsquo": "\u{2019}", "lsquo": "\u{2018}", "ldquo": "\u{201C}", "rdquo": "\u{201D}",
        "copy": "\u{00A9}", "reg": "\u{00AE}", "trade": "\u{2122}",
    ]

    /// Decode the entity set a real page uses in a title. An unknown entity is left verbatim
    /// rather than dropped: `AT&T` written badly must not become `ATT`.
    public static func decodeEntities(_ input: String) -> String {
        let chars = Array(input)
        var out = ""
        var i = 0
        while i < chars.count {
            guard let amp = indexOf(chars, "&", from: i) else {
                out += String(chars[i...])
                break
            }
            out += String(chars[i..<amp])
            guard let semi = indexOf(chars, ";", from: amp), semi - amp <= 10 else {
                out += "&"; i = amp + 1; continue
            }
            let body = String(chars[(amp + 1)..<semi])
            var decoded: String?
            if body.hasPrefix("#x") || body.hasPrefix("#X") {
                if let code = UInt32(String(body.dropFirst(2)), radix: 16), code > 0,
                   let scalar = Unicode.Scalar(code) { decoded = String(Character(scalar)) }
            } else if body.hasPrefix("#") {
                if let code = UInt32(String(body.dropFirst(1))), code > 0,
                   let scalar = Unicode.Scalar(code) { decoded = String(Character(scalar)) }
            } else {
                decoded = namedEntities[body.lowercased()]
            }
            guard let value = decoded else { out += "&"; i = amp + 1; continue }
            out += value
            i = semi + 1
        }
        return out
    }

    /// Collapse the whitespace a hand-written `<title>` carries across three source lines.
    public static func collapseText(_ input: String) -> String {
        var out = ""
        var pendingSpace = false
        for c in input {
            if c.isWhitespace || c == "\u{00A0}" { pendingSpace = !out.isEmpty; continue }
            if pendingSpace { out += " "; pendingSpace = false }
            out.append(c)
        }
        return out
    }

    private static func isSpaceChar(_ c: Character) -> Bool {
        c == " " || c == "\t" || c == "\n" || c == "\r" || c == "\u{000C}"
    }

    private static func indexOf(_ chars: [Character], _ needle: Character, from: Int) -> Int? {
        var i = max(0, from)
        while i < chars.count {
            if chars[i] == needle { return i }
            i += 1
        }
        return nil
    }

    /// Case-insensitive forward search. A lowercased COPY of the document would change its
    /// length for some Unicode, drifting every index against the Kotlin and TS twins.
    private static func indexOfCI(_ chars: [Character], _ needle: String, from: Int) -> Int? {
        let want = Array(needle.lowercased()).map(String.init)
        if want.isEmpty || chars.count < want.count { return nil }
        var i = max(0, from)
        while i + want.count <= chars.count {
            var hit = true
            for k in 0..<want.count {
                if chars[i + k].lowercased() != want[k] { hit = false; break }
            }
            if hit { return i }
            i += 1
        }
        return nil
    }

    /// Scan a document for its preview tags. Deliberately NOT a DOM parse: this runs over the
    /// first 256 KB of an untrusted response on three runtimes, so it is a forward character
    /// scan that never backtracks, executes nothing, and stops at `<body>` or `</head>`.
    ///
    /// FIRST OCCURRENCE WINS for every key — the alternative lets an injected comment thread
    /// override the publisher's own og:image.
    public static func scanTags(_ html: String) -> Tags {
        var meta: [String: String] = [:]
        var links: [String: String] = [:]
        var documentTitle = ""

        let chars = Array(html)
        let n = chars.count
        var i = 0
        while i < n {
            guard let lt = indexOf(chars, "<", from: i) else { break }
            i = lt + 1

            if i + 3 <= n, chars[i] == "!", chars[i + 1] == "-", chars[i + 2] == "-" {
                if let end = indexOfCI(chars, "-->", from: i + 3) { i = end + 3 } else { i = n }
                continue
            }
            var closing = false
            if i < n, chars[i] == "/" { closing = true; i += 1 }

            var nameEnd = i
            while nameEnd < n, !isSpaceChar(chars[nameEnd]), chars[nameEnd] != ">", chars[nameEnd] != "/" {
                nameEnd += 1
            }
            let tag = String(chars[i..<nameEnd]).lowercased()
            i = nameEnd

            if closing {
                if tag == "head" { break }
                if let gt = indexOf(chars, ">", from: i) { i = gt + 1 } else { i = n }
                continue
            }

            var attrs: [String: String] = [:]
            while i < n {
                while i < n, isSpaceChar(chars[i]) { i += 1 }
                if i >= n { break }
                if chars[i] == ">" { i += 1; break }
                if chars[i] == "/", i + 1 < n, chars[i + 1] == ">" { i += 2; break }
                var keyEnd = i
                while keyEnd < n, !isSpaceChar(chars[keyEnd]), chars[keyEnd] != "=", chars[keyEnd] != ">" {
                    keyEnd += 1
                }
                let key = String(chars[i..<keyEnd]).lowercased()
                i = keyEnd
                while i < n, isSpaceChar(chars[i]) { i += 1 }
                var value = ""
                if i < n, chars[i] == "=" {
                    i += 1
                    while i < n, isSpaceChar(chars[i]) { i += 1 }
                    let quote: Character = i < n ? chars[i] : " "
                    if quote == "\"" || quote == "'" {
                        i += 1
                        if let end = indexOf(chars, quote, from: i) {
                            value = String(chars[i..<end]); i = end + 1
                        } else {
                            value = String(chars[i...]); i = n
                        }
                    } else {
                        var end = i
                        while end < n, !isSpaceChar(chars[end]), chars[end] != ">" { end += 1 }
                        value = String(chars[i..<end])
                        i = end
                    }
                }
                if !key.isEmpty, attrs[key] == nil { attrs[key] = decodeEntities(value) }
            }

            if tag == "body" { break }

            if tag == "title" {
                let close = indexOfCI(chars, "</title", from: i)
                let text = close == nil ? String(chars[i...]) : String(chars[i..<close!])
                if documentTitle.isEmpty { documentTitle = collapseText(decodeEntities(text)) }
                i = close ?? n
                continue
            }
            if tag == "script" || tag == "style" {
                let close = indexOfCI(chars, "</\(tag)", from: i)
                i = close ?? n
                continue
            }
            if tag == "meta" {
                let key = (attrs["property"] ?? attrs["name"] ?? attrs["itemprop"] ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if !key.isEmpty, let content = attrs["content"], meta[key] == nil {
                    meta[key] = collapseText(content)
                }
                continue
            }
            if tag == "link" {
                let rel = (attrs["rel"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if let href = attrs["href"], !rel.isEmpty {
                    for token in rel.split(whereSeparator: { $0.isWhitespace }) {
                        let key = String(token)
                        if !key.isEmpty, links[key] == nil {
                            links[key] = href.trimmingCharacters(in: .whitespacesAndNewlines)
                        }
                    }
                }
                continue
            }
        }

        return Tags(meta: meta, links: links, documentTitle: documentTitle)
    }

    private static func firstMeta(_ tags: Tags, _ keys: [String]) -> String {
        for key in keys {
            if let v = tags.meta[key], !v.isEmpty { return v }
        }
        return ""
    }

    private static func firstLink(_ tags: Tags, _ keys: [String]) -> String {
        for key in keys {
            if let v = tags.links[key], !v.isEmpty { return v }
        }
        return ""
    }

    /// The site-name fallback. `www.` is dropped because no publisher calls itself that.
    public static func siteFallback(_ host: String) -> String {
        let bare = host.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? host
        return bare.hasPrefix("www.") ? String(bare.dropFirst(4)) : bare
    }

    /// Fold a scanned document into the preview a caller receives. THE PRECEDENCE IS THE
    /// PRODUCT and every row is pinned in the corpus:
    ///
    ///   title        og:title → twitter:title → <title>             → ""
    ///   description  og:description → twitter:description → description → ""
    ///   image        og:image → og:image:url → og:image:secure_url → twitter:image
    ///                → twitter:image:src → link[rel=image_src]      → ""   (resolved absolute)
    ///   siteName     og:site_name → application-name → host without `www.`
    ///   favicon      link[rel=icon|shortcut|apple-touch-icon|mask-icon] → <origin>/favicon.ico
    ///   type         og:type → "website"
    ///   canonical    link[rel=canonical] → og:url → the request URL        (resolved absolute)
    ///
    /// Absence is "" everywhere, never nil: a preview card renders the same on three renderers
    /// only if "no image" has one spelling.
    public static func fold(_ tags: Tags, _ target: Target) -> Preview {
        var title = firstMeta(tags, ["og:title", "twitter:title"])
        if title.isEmpty { title = tags.documentTitle }
        let description = firstMeta(tags, ["og:description", "twitter:description", "description"])
        var rawImage = firstMeta(tags, ["og:image", "og:image:url", "og:image:secure_url",
                                        "twitter:image", "twitter:image:src"])
        if rawImage.isEmpty { rawImage = firstLink(tags, ["image_src"]) }
        var rawCanonical = firstLink(tags, ["canonical"])
        if rawCanonical.isEmpty { rawCanonical = firstMeta(tags, ["og:url"]) }
        let rawFavicon = firstLink(tags, ["icon", "shortcut", "apple-touch-icon", "mask-icon"])

        var canonical = resolveReference(target, rawCanonical)
        if canonical.isEmpty { canonical = target.url }
        let image = resolveReference(target, rawImage)
        var favicon = resolveReference(target, rawFavicon)
        if favicon.isEmpty { favicon = "\(target.origin)/favicon.ico" }
        var siteName = firstMeta(tags, ["og:site_name", "application-name"])
        if siteName.isEmpty { siteName = siteFallback(target.host) }
        var type = firstMeta(tags, ["og:type"])
        if type.isEmpty { type = "website" }

        return Preview(title: title, description: description, image: image,
                       siteName: siteName, favicon: favicon, type: type, canonical: canonical)
    }

    /// The whole read, once the bytes are in hand.
    public static func parse(_ html: String, _ target: Target) -> Preview {
        fold(scanTags(html), target)
    }
}
