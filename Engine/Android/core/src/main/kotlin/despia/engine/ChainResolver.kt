//
//  ChainResolver.kt - module-identity CHAIN resolution (the chains corpus law).
//
//  A module's identity is its dotted chain derived from Modules/ nesting (`watch.health`);
//  the chain is BOTH the API face (`dsx.module.watch.health.heartRate`) and the wire scheme
//  token (`watch.health://heartRate`). Resolution is NEVER dot-counting and never a first-dot
//  split — it is the incremental FOLD at each runtime's ONE dispatch funnel:
//
//    1. normalize the arriving HEAD spelling through the alias map to its primary chain
//       (`watchhealth` → `watch.health`; an unknown head stays itself, `known = false` — so
//       module_not_found reports against the head token, never a silent no-op);
//    2. while the remaining action path is non-empty and `chain + "." + parts[0]` is in the
//       IDENTITY SET — registered chains ∪ build-excluded chains, the honest universe, so an
//       excluded child still gets correct attribution instead of becoming a phantom action on
//       its parent — fold that segment into the chain;
//    3. what remains is the action path (empty = the bare pre-filter call).
//
//  The build-time bidirectional ban (a child segment can never equal a parent action/group
//  first-segment or a reserved member — dsx_graph chain_errors) is what makes the fold total
//  and unambiguous: `intelligence.rag.add` can only ever mean the `rag` GROUP, because a child
//  named `rag` could not have built. Aliases are consulted at HEAD position only (they route
//  legacy wire tokens — hyphens fine — never the modern dot plane); the arriving spelling stays
//  visible to the module (`ctx.scheme` — catch-all routing) while identity (state, events,
//  config) is always the primary chain.
//
//  RESERVED MEMBERS are never actions: after the fold, a leading reserved word in the
//  remainder routes to the MEMBER plane — the call parser refuses it as an action. One that
//  nevertheless arrives at a MODERN call face — the typed proxies, the dotted-callee face,
//  the native _call/_dispatch funnel (impossible through the proxies themselves — a caller
//  bug) — is REFUSED with the cross-runtime error code `reserved_member`: reported through
//  the module.callFailed funnel, thrown as the runtime's ModuleCallError, never dispatched
//  as an action and never a silent unknown_action (frozen in the corpus `_note`; the TS bus
//  and Swift Context.foldRoute spell it identically). The LEGACY WIRE face (URL navigations,
//  the v3 string transport) is EXEMPT from the refusal: reserved words are banned from
//  MANIFESTS, never from the wire, so a code-only legacy shim registered under a reserved
//  spelling (`biometric://available`, `bluetooth://state`, `scanningmode://on`) keeps
//  answering shipped pages — the compat those shims exist for. On the wire face the FOLD
//  still applies for ROUTING — a nested chain reaches its owner even when the remainder
//  starts with a reserved word (`chfx://sub/state` dispatches action `state` on `chfx.sub`) —
//  so owner and attribution are the same on every runtime; only the refusal is face-gated.
//  The set is
//  CLOSED and FROZEN (growth is a major-version event): native runtimes are proxy-safe by
//  construction (reserved members are REAL members, and real members shadow dynamic lookup),
//  so the JS planes' proxy denylist (`then`/`toString`/…) has no twin here.
//
//  Pure JVM, dependency-free, unit-testable: we take an identity VIEW (an interface), so the
//  same fold runs against the corpus's synthetic table (ChainsConformanceTest) AND the live
//  route table (ModuleRegistry adapts itself). The kernel names no modules — every chain in
//  here arrives as data. Corpus: OpenSource/Conformance/chains/chains.json (TS + Kotlin
//  execute every case; Swift is the reference lane).
//

package despia.engine

object ChainResolver {

    /// The FROZEN member plane — never actions, closed set (growth = major-version event).
    /// Mirrors `chains.json` `reserved`; the corpus runner asserts the two stay identical.
    val reservedMembers: Set<String> = setOf(
        "on", "available", "excluded", "state", "context", "object", "delegate", "dsx", "then")

    /// The identity view the fold runs against — the resolver never owns the table, it asks.
    /// Implementations: [Table] (the corpus's synthetic table, exact-match) and the
    /// ModuleRegistry adapter (live routes ∪ the build's excluded overlay, keyed lowercase).
    interface Identity {
        /// The primary chain `head` is an ALIAS of, or null when `head` is not an alias
        /// (i.e. it is already a primary spelling, or unknown). Consulted at HEAD position only.
        fun primaryFor(head: String): String?
        /// Membership in the IDENTITY SET: registered chains ∪ build-excluded chains.
        fun contains(chain: String): Boolean
        /// True when `chain` resolves through the excluded overlay (build fact, not a route).
        fun isExcluded(chain: String): Boolean
    }

    /// The corpus-shaped identity table: chains + alias→chain + the excluded overlay.
    class Table(
        private val chains: Set<String>,
        private val aliases: Map<String, String> = emptyMap(),
        private val excluded: Set<String> = emptySet(),
    ) : Identity {
        override fun primaryFor(head: String): String? = aliases[head]
        override fun contains(chain: String): Boolean = chain in chains || chain in excluded
        override fun isExcluded(chain: String): Boolean = chain in excluded
    }

    /// One resolved callee. Exactly the corpus's expectation shape: a CALL route carries
    /// `action` (member null); a MEMBER route carries `member` + `rest` (action empty — the
    /// call parser refuses a reserved word as an action, so we never expose it as one).
    class Resolution(
        /// The resolved primary identity — the dotted chain (state, events, config key).
        val chain: String,
        /// The action path segments after the fold ("" segments never occur; empty list = the
        /// bare pre-filter call). Empty when this is a member route.
        val action: List<String>,
        /// The ARRIVING spelling of the chain — equals `chain` except when the head arrived as
        /// an alias (`watchhealth`, `get-uuid`): legacy grammar, kept visible for catch-all
        /// routing (`ctx.scheme`) while identity stays the primary chain.
        val spelling: String,
        /// False when the head resolved into nothing we know — the honest module_not_found
        /// attribution target is then `chain` (the head token), never a silent no-op.
        val known: Boolean,
        /// True when identity resolved through the excluded overlay — the module is real but
        /// not in this build; attribution and build facts (`available`/`excluded`) still answer.
        val excluded: Boolean,
        /// The reserved member word leading the post-fold remainder, or null for a call route.
        val member: String?,
        /// The member-plane tail after the member word (empty for call routes).
        val rest: List<String>,
        /// How many action-path segments the fold moved into the chain (0 = head-only). Lets a
        /// dispatch adapter fall back to its verbatim pre-fold behavior when nothing folded.
        val folded: Int,
    )

    /// Step 2 alone — the incremental fold, shared verbatim by [resolve] and the dispatch
    /// funnel (which walks a separator-preserving cursor instead of a pre-split list): from
    /// `base`, consume leading `tokens` while `chain + "." + token` is in the identity set.
    /// Returns how many tokens folded. An empty token never folds (malformed path — leave it
    /// to the action plane's own error answer).
    fun fold(base: String, tokens: List<String>, identity: Identity): Int {
        var chain = base
        var n = 0
        while (n < tokens.size) {
            val token = tokens[n]
            if (token.isEmpty()) break
            val next = "$chain.$token"
            if (!identity.contains(next)) break
            chain = next
            n += 1
        }
        return n
    }

    /// Resolve one dotted callee (the segments after `dsx.module.`; a single segment = the
    /// bare scheme-only call) against `identity`. Pure — no registry, no dispatch, no I/O.
    fun resolve(segments: List<String>, identity: Identity): Resolution {
        val head = segments.firstOrNull() ?: ""
        // (1) alias-normalize the HEAD — and only the head — to its primary chain.
        val primary = identity.primaryFor(head)
        var chain = primary ?: head
        var spelling = head
        // (2) the fold: longest KNOWN prefix wins, one segment at a time.
        val tail = segments.drop(1)
        val folded = fold(chain, tail, identity)
        for (i in 0 until folded) {
            chain = "$chain.${tail[i]}"
            spelling = "$spelling.${tail[i]}"
        }
        // (3) the remainder — a leading reserved word routes to the MEMBER plane, never an action.
        val remainder = tail.drop(folded)
        val member = remainder.firstOrNull()?.takeIf { it in reservedMembers }
        return Resolution(
            chain = chain,
            action = if (member == null) remainder else emptyList(),
            spelling = spelling,
            known = identity.contains(chain),
            excluded = identity.isExcluded(chain),
            member = member,
            rest = if (member == null) emptyList() else remainder.drop(1),
            folded = folded)
    }
}
