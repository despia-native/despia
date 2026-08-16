//
//  ChainResolver.swift — derived module identity: the longest-known-prefix FOLD.
//
//  A module's identity is its dotted CHAIN (watch.health), derived at build time from
//  `Modules/` nesting (facet-contracts.md) — the manifest declares only its LOCAL segment.
//  The chain is BOTH the API face (dsx.module.watch.health.heartRate) and the wire scheme
//  token (watch.health://heartRate). This file is the REFERENCE implementation of the
//  resolution law executed by OpenSource/Conformance/chains/chains.json on all three
//  runtimes (TS vitest · Kotlin :core JUnit · Swift, this file):
//
//    1. Normalize the arriving HEAD spelling through the alias map to its primary chain
//       (watchhealth → watch.health). An unknown head stays itself (known = false) — the
//       module_not_found path reports against the head token, never a silent no-op.
//    2. While the remaining path is non-empty and `chain + "." + parts[0]` is in the
//       IDENTITY SET (registered chains ∪ build-excluded chains — the honest universe, so
//       an excluded child still gets correct attribution instead of becoming a phantom
//       action on its parent), fold that segment into the chain.
//    3. What remains is the action path (slash-joined, the array-path convention; empty =
//       the bare pre-filter call) — UNLESS its first token is a reserved member, which
//       routes to the MEMBER plane and is never an action.
//
//  The build-time bidirectional ban (dsx_graph chain_errors: a child segment can never
//  equal a parent action/group first-segment or a reserved member, and vice versa) is what
//  makes the fold total and unambiguous — intelligence.rag.add can only ever mean the rag
//  GROUP, because a child named rag could not have built.
//
//  The reserved set is CLOSED and FROZEN: these are REAL members on the typed proxies,
//  and real members shadow dynamic lookup (SE-0195) — a new word could silently steal a
//  module's action name, so growth is a major-version event, never a patch.
//

import Foundation

public enum ChainResolver {

    /// The module-proxy reserved members — the frozen nine (dsx_graph RESERVED_MEMBERS twin).
    public static let reservedMembers: Set<String> =
        ["on", "available", "excluded", "state", "context", "object", "delegate", "dsx", "then"]

    /// The identity view the fold runs against — built by ModuleRegistry from live
    /// registrations plus the build's excluded overlay (never hand-assembled by callers).
    public struct Table {
        /// Primary identity chains (registered modules).
        public let chains: Set<String>
        /// Legacy spelling → primary chain (aliases route at HEAD position only).
        public let aliases: [String: String]
        /// Build-excluded identities (chains that exist in the product but not this build).
        public let excluded: Set<String>
        /// The honest universe: everything that IS an identity, shipped or not —
        /// PRECOMPUTED at construction (the fold probes it once per segment; a
        /// computed union would allocate O(catalog) per probe).
        let identity: Set<String>
        /// chain → its legacy alias spellings (the reverse of `aliases`, sorted for
        /// determinism) — the emission fan-out reads this so an alias handle hears
        /// a module's events no matter when it subscribed.
        public let aliasesByChain: [String: [String]]
        public init(chains: Set<String>, aliases: [String: String] = [:], excluded: Set<String> = []) {
            self.chains = chains
            self.aliases = aliases
            self.excluded = excluded
            self.identity = chains.union(excluded)
            var reverse: [String: [String]] = [:]
            for (alias, chain) in aliases { reverse[chain, default: []].append(alias) }
            self.aliasesByChain = reverse.mapValues { $0.sorted() }
        }
    }

    public struct Resolution {
        /// The resolved PRIMARY identity (or the arriving head itself when unknown).
        public let chain: String
        /// Slash-joined action path ("" = the bare pre-filter call). Empty when `member`
        /// routes. ADVISORY spelling only — a funnel that must preserve the caller's
        /// grammar (dotted group keys, case) cuts the ORIGINAL string with
        /// `consume(_:folded:)` instead.
        public let action: String
        /// The arriving spelling of the folded chain. This equals the caller's
        /// dotted chain for primary names; a legacy alias remains its one head token.
        public let spelling: String
        /// False when the head names no known identity (module_not_found attribution).
        public let known: Bool
        /// True when the resolved identity sits under the build's excluded overlay.
        public let excluded: Bool
        /// A reserved member routed instead of an action (never dispatched as a call
        /// on the MODERN faces; the wire face dispatches it as a plain action).
        public let member: String?
        /// The dot-joined remainder after a member route ("bpm" in …state.bpm).
        public let rest: String
        /// How many ACTION segments the fold consumed into the chain (0 = nothing
        /// folded — the caller keeps its verbatim route, bit-for-bit).
        public let folded: Int
    }

    /// Step 2 alone — the incremental fold shared by `resolve` (the corpus's pre-split
    /// reference face) and `resolveWire` (the wire funnel), the Kotlin
    /// `ChainResolver.fold` twin: from `base`, consume leading `tokens` while
    /// `chain + "." + token` is in the identity set; returns how many folded. Tokens
    /// arrive LOWERCASED. An EMPTY token never folds (a malformed path stays the
    /// action plane's own error answer, never a half-folded route).
    static func fold(base: String, tokens: [String], table: Table) -> Int {
        var chain = base
        var n = 0
        while n < tokens.count {
            let token = tokens[n]
            if token.isEmpty { break }
            let next = "\(chain).\(token)"
            guard table.identity.contains(next) else { break }
            chain = next
            n += 1
        }
        return n
    }

    /// Resolve dotted-callee segments ([head, part, part…]) against the table. Segments
    /// arrive pre-split — callers split their surface's spelling ("/" and "." are both
    /// path separators on the wire; a segment name can contain neither). Tokens compare
    /// LOWERCASED against the lowercase identity table (twin parity: Kotlin lowercases
    /// before its fold, TS folds case-insensitively); the membership check is the ONLY
    /// oracle — folding never depends on the head's own standing.
    public static func resolve(_ segments: [String], table: Table) -> Resolution {
        guard let head = segments.first, !head.isEmpty else {
            return Resolution(chain: "", action: "", spelling: "", known: false,
                              excluded: false, member: nil, rest: "", folded: 0)
        }
        var spelling = head
        let headKey = head.lowercased()
        let alias = table.aliases[headKey]
        var chain = alias ?? headKey
        let tokens = segments.dropFirst().map { $0.lowercased() }
        let folded = fold(base: chain, tokens: tokens, table: table)
        for i in 0..<folded {
            chain += ".\(tokens[i])"
            // A dotted primary call exposes the complete arriving spelling to
            // ctx.scheme. A legacy alias is one indivisible wire token.
            if alias == nil { spelling += ".\(segments[i + 1])" }
        }
        let known = table.identity.contains(chain)
        let parts = Array(segments.dropFirst(1 + folded))
        let excluded = table.excluded.contains(chain)
            || table.excluded.contains(where: { chain.hasPrefix("\($0).") })
        if let first = parts.first, reservedMembers.contains(first.lowercased()) {
            return Resolution(chain: chain, action: "", spelling: spelling, known: known,
                              excluded: excluded, member: first.lowercased(),
                              rest: parts.dropFirst().joined(separator: "."), folded: folded)
        }
        return Resolution(chain: chain, action: parts.joined(separator: "/"),
                          spelling: spelling, known: known, excluded: excluded,
                          member: nil, rest: "", folded: folded)
    }

    /// One resolved WIRE callee — the Kotlin `ModuleRegistry.resolveChain` twin,
    /// sized for the string/URL funnels: `chain` the folded primary identity,
    /// `rest` the action-path remainder cut VERBATIM from the original (separators
    /// and case preserved, so dotted group keys keep their registration grammar),
    /// `folded` how many segments the fold consumed (0 ⇒ the caller keeps its
    /// bit-for-bit pre-fold route), `member` the reserved word leading the
    /// post-fold remainder (lowercased), when there is one.
    public struct WireResolution {
        public let chain: String
        public let rest: String
        public let folded: Int
        public let member: String?
    }

    /// THE funnel-shaped fold over a wire spelling — every Swift fold site
    /// (`handle(url:)`, the string funnel, `foldRoute`, `normalizeCall`) resolves
    /// through THIS one helper, byte-for-byte the Kotlin funnel's law:
    /// strip ONE leading "/" (the array-path spelling), tokenize on "/" and "."
    /// KEEPING empty tokens with each token's past-separator boundary recorded,
    /// alias-normalize the head, fold while the identity set knows the deeper
    /// chain — an EMPTY token never folds (a malformed path stays the action
    /// plane's own error answer, never a half-folded route) — then cut the
    /// remainder VERBATIM at the recorded boundary. Counting separator
    /// CHARACTERS instead desyncs from an empty-omitting split on doubled or
    /// leading separators and re-dispatches a folded segment (review round 3).
    /// `dsx` is the reserved kernel channel, not a module — it never folds.
    public static func resolveWire(scheme: String, actionPath: String, table: Table) -> WireResolution {
        let key = scheme.lowercased()
        let path = actionPath.hasPrefix("/") ? String(actionPath.dropFirst()) : actionPath
        if key.isEmpty || key == "dsx" { return WireResolution(chain: key, rest: path, folded: 0, member: nil) }
        var tokens: [String] = []
        var after: [String.Index] = []     // index PAST token i's separator (== endIndex at the tail)
        var start = path.startIndex
        while start < path.endIndex {
            var cut = start
            while cut < path.endIndex, path[cut] != "/", path[cut] != "." { cut = path.index(after: cut) }
            tokens.append(path[start..<cut].lowercased())
            let next = cut < path.endIndex ? path.index(after: cut) : cut
            after.append(next)
            start = next
        }
        var chain = table.aliases[key] ?? key
        var folded = 0
        while folded < tokens.count {
            let token = tokens[folded]
            if token.isEmpty { break }
            let next = "\(chain).\(token)"
            guard table.identity.contains(next) else { break }
            chain = next
            folded += 1
        }
        let rest = folded == 0 ? path : String(path[after[folded - 1]...])
        let member = folded < tokens.count && reservedMembers.contains(tokens[folded]) ? tokens[folded] : nil
        return WireResolution(chain: chain, rest: rest, folded: folded, member: member)
    }
}
