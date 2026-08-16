//
//  DSXPathMatch.swift - the one DSX route-path matcher.
//
//  Pure Foundation (no WebKit/UIKit), so it is EXTENSION-SAFE: extracted from Stack.swift
//  (which imports UIKit) so the same matcher compiles into an extension process — the
//  watch / keyboard `RouteResolver` uses THIS, instead of reimplementing route matching.
//  Shared by the `matches()` expression helper, the kernel `Router`, and the Routing
//  package's resolver. Patterns: literal segments, `{name}`/`:name` (one segment → param),
//  `*` (one segment), trailing `/*` or `*` (catch-all). Query/hash stripped. Pure and
//  allocation-light — safe to call from the non-blocking expression evaluator.
//

import Foundation

enum DSXPathMatch {
    /// Match a concrete path against a route pattern. Returns the extracted params
    /// (`[:]` when there are none) on a match, or `nil` on no match.
    static func match(_ path: String, _ pattern: String) -> [String: String]? {
        let p = normalize(path)
        let pat = normalize(pattern)
        if pat == "*" || pat == "/*" || pat.isEmpty { return [:] }   // catch-all / empty pattern
        let ps = segments(p)
        let pats = segments(pat)
        var params: [String: String] = [:]
        var i = 0
        while i < pats.count {
            let seg = pats[i]
            if seg == "*" {
                // A trailing '*' soaks up the rest; a mid-path '*' matches one segment.
                if i == pats.count - 1 { return params }
                if i >= ps.count { return nil }
                i += 1; continue
            }
            if i >= ps.count { return nil }
            if seg.count >= 2, seg.hasPrefix("{"), seg.hasSuffix("}") {
                params[String(seg.dropFirst().dropLast())] = ps[i]
            } else if seg.hasPrefix(":") {
                params[String(seg.dropFirst())] = ps[i]
            } else if seg != ps[i] {
                return nil
            }
            i += 1
        }
        return ps.count == pats.count ? params : nil
    }

    /// Boolean convenience — backs the `matches(path, pattern)` expression helper.
    static func matches(_ path: String, _ pattern: String) -> Bool { match(path, pattern) != nil }

    private static func normalize(_ s: String) -> String {
        var x = Substring(s)
        if let cut = x.firstIndex(where: { $0 == "?" || $0 == "#" }) { x = x[..<cut] }
        return String(x)
    }
    private static func segments(_ s: String) -> [String] {
        s.split(separator: "/").map(String.init)
    }
}
