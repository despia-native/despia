//
//  JSE.swift - the DSX expression evaluator (the JSE language core).
//
//  Pure computation, UIKit/WebKit-free -> EXTENSION-SAFE: extracted from the UIKit-coupled
//  Stack.swift into the `logic` kernel tier, so the watch / keyboard can run `<action>` /
//  expression logic in-process. The SAME evaluator the in-app engine (Stack.swift / JSERunner),
//  DSXState and DSXScreen use. Foundation + Security/CryptoKit/Network only; no surface deps.
//

import Foundation
import CryptoKit
import CommonCrypto
import Security
import Network

// ── The evaluator's STATE SEAM (watch-runtime.md W1) ─────────────────────────────────────
// JSE evaluates against a state SURFACE, not the app's concrete store: `JSEState` is the
// nine members the evaluator actually touches (audited — vars + the head-declared metadata
// + the recursion ledgers). The app's `StackStore` conforms (Stack.swift, a one-line
// extension), so the phone path is byte-for-byte unchanged; a SATELLITE node (the watch's
// StackWatch, a keyboard) evaluates against the dictionary-backed `JSEVars` instead —
// full expression grammar over plain pushed vars, none of the app store's machinery.
// This seam is what lets JSE.swift compile STANDALONE into the `logic` runtime tier.
protocol JSEState: AnyObject {
    var vars: [String: Any] { get set }
    var computed: [String: String] { get }                // <variable computed="true"> formulas
    var initials: [String: Any] { get }                   // <variable as="x"> defaults
    var formulas: [String: StackFormula] { get }          // <formula as="x" …> parameterized
    var functions: [String: Any] { get set }              // user `function name(){…}` lambdas
    var attrDefaults: [String: String] { get }            // <attribute as="x" default="…"/>
    var overrideDecls: [String: OverrideDecl] { get }     // <override as="x" type="…" default="…"/>
    var computedDepth: Int { get set }                    // the three recursion ledgers
    var fnDepth: Int { get set }
    var evalDepth: Int { get set }
}

/// A parameterized reactive formula (`<formula as="x" foo="…">…uses foo…</formula>`).
/// Lives here (not Stack.swift) so the `logic` tier is self-contained; the app engine
/// consumes it unchanged.
struct StackFormula { let inputs: [String: String]; let body: String }

/// The dictionary-backed `JSEState` for SATELLITE surfaces (the watch, a keyboard):
/// pushed vars in, the full expression grammar out. No app store, no Combine.
final class JSEVars: JSEState {
    var vars: [String: Any]
    var computed: [String: String] = [:]
    var initials: [String: Any] = [:]
    var formulas: [String: StackFormula] = [:]
    var functions: [String: Any] = [:]
    var attrDefaults: [String: String] = [:]
    var overrideDecls: [String: OverrideDecl] = [:]
    var computedDepth = 0
    var fnDepth = 0
    var evalDepth = 0
    init(_ vars: [String: Any] = [:]) { self.vars = vars }
}

/// One bounded dot-path contract shared by app, satellite, and `<api>` state writes.
/// Authored/remote paths are rejected before copy-on-write allocates any containers.
enum DsxStatePathPolicy {
    static let maxPathBytes = 4_096
    static let maxSegments = 64
    static let maxSegmentBytes = 256
    static let maxArrayIndex = 9_999
    static let maxArrayGrowth = 1_024
    static let maxContainerEntries = 10_000
    static let maxIdentifierBytes = 128

    private static let unsafeKeys: Set<String> = ["__proto__", "constructor", "prototype"]

    private static func isWithinUTF8Limit(_ value: String, _ limit: Int) -> Bool {
        value.utf8.prefix(limit + 1).count <= limit
    }

    private static func isASCIIDigits(_ value: String) -> Bool {
        let scalars = value.unicodeScalars
        return !scalars.isEmpty && scalars.allSatisfy { $0.value >= 48 && $0.value <= 57 }
    }

    static func arrayIndex(_ value: String) -> Int? {
        guard isASCIIDigits(value), let index = Int(value), index <= maxArrayIndex else { return nil }
        return index
    }

    static func segments(_ path: String, allowEmpty: Bool = false) -> [String]? {
        if path.isEmpty { return allowEmpty ? [] : nil }
        guard isWithinUTF8Limit(path, maxPathBytes) else { return nil }
        let parts = path.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count <= maxSegments else { return nil }
        for part in parts {
            guard !part.isEmpty,
                  isWithinUTF8Limit(part, maxSegmentBytes),
                  !unsafeKeys.contains(part) else { return nil }

            let scalars = part.unicodeScalars
            let digits = isASCIIDigits(part)
            let signedDigits = scalars.count > 1
                && (scalars.first?.value == 43 || scalars.first?.value == 45)
                && scalars.dropFirst().allSatisfy { $0.value >= 48 && $0.value <= 57 }
            if signedDigits { return nil }
            if digits && arrayIndex(part) == nil { return nil }
        }
        return parts
    }

    /// `<api as>` owns one top-level store identifier, never an arbitrary dot path.
    static func isIdentifier(_ value: String) -> Bool {
        guard !value.isEmpty, isWithinUTF8Limit(value, maxIdentifierBytes) else { return false }
        let scalars = value.unicodeScalars
        guard let first = scalars.first,
              first.value == 95 || (first.value >= 65 && first.value <= 90)
                  || (first.value >= 97 && first.value <= 122) else { return false }
        return scalars.dropFirst().allSatisfy {
            $0.value == 95 || ($0.value >= 48 && $0.value <= 57)
                || ($0.value >= 65 && $0.value <= 90)
                || ($0.value >= 97 && $0.value <= 122)
        }
    }

    /// Rebuild a validated path without mutating the input. `nil` means the write
    /// exceeded a container/growth budget and the caller must leave state unchanged.
    static func rebuild(_ container: Any?, _ parts: ArraySlice<String>, _ value: Any) -> Any? {
        guard let head = parts.first else { return value }
        let rest = parts.dropFirst()
        if let index = arrayIndex(head) {
            var array = (container as? [Any]) ?? []
            let growth = index >= array.count ? index - array.count + 1 : 0
            guard growth <= maxArrayGrowth else { return nil }
            while array.count <= index { array.append([String: Any]()) }
            guard let child = rebuild(array[index], rest, value) else { return nil }
            array[index] = child
            return array
        }

        var dictionary = (container as? [String: Any]) ?? [:]
        guard dictionary.keys.contains(head) || dictionary.count < maxContainerEntries else { return nil }
        guard let child = rebuild(dictionary[head], rest, value) else { return nil }
        dictionary[head] = child
        return dictionary
    }
}

enum JSE {                  // JSE — the expression evaluator
    // ── APP-STATE SEAMS — the reserved namespaces (`global.*` / `route.*` / `env` /
    // `cookie.*`) read the APP's singletons, which don't exist on a satellite node. The
    // app installs these at boot (DSXBoot); on a satellite they stay nil and the reserved
    // reads fail OPEN to empty — exactly the constitution's kernel-consumes-closures shape.
    static var appVars: (() -> [String: Any])?
    static var envChannel: (() -> String)?
    static var cookieJar: (() -> [String: Any])?

    /// THE RENDER-SAFE INVARIANT — so author logic JUST WORKS however complex.
    ///
    /// Reactive author logic — `on:change` (a state/data change), a `<watch>`, a media event
    /// like `on:ended` arriving as the next clip loads, a programmatic page jump — must NEVER run
    /// synchronously inside SwiftUI's view-update pass: it writes `@Published` store state (and can
    /// mount/unmount heavy subtrees), and SwiftUI forbids publishing changes from within an update
    /// ("publishing changes from within view updates" → AttributeGraph corruption → crash; e.g. a
    /// video feed auto-advancing across its preload window). The engine hops EVERY such edge to the
    /// next runloop tick through this one funnel — so authors write `on:ended`/`on:change` freely
    /// and the framework, not the author, owns getting the timing right.
    ///
    /// NOT for direct gestures (`on:tap`/`on:drag`/`on:longpress`) — those aren't in the update
    /// pass; they run synchronously so authors keep read-after-write. NOT for `measure=` — first
    /// frame sizing needs the immediate write (its no-op de-dupe prevents churn instead).
    ///
    /// SECOND reason this funnel exists — STACK BUDGET: a device crash log showed an authored
    /// `on:ended` cascade running synchronously inside an AVPlayerItem notification callout and
    /// overflowing the main thread's stack (the evaluator's mutually-recursive frames are heavy).
    /// Entering author JSE from a fresh runloop tick gives every cascade the full, empty stack.
    @inline(__always) static func afterRender(_ work: @escaping () -> Void) {
        DispatchQueue.main.async(execute: work)
    }
    /// How deep a component may expand before the renderer stops.
    ///
    /// NOT a budget, and never to be tuned for taste. A component that names itself is a
    /// legitimate and common shape — a tree, an outliner, a comment thread, a file browser —
    /// and it terminates because the DATA terminates. This exists for the one case where the
    /// data does not: a cycle or a corrupt child list, where the only alternatives are an
    /// unbounded render and a dead stack. Bounded output beats a crash, and legitimate
    /// nesting must never reach it. The previous 32 was a guess made before anything
    /// recursive shipped and it capped real trees. Uniform on all three renderers (corpus
    /// Conformance/composition/attribute-binding.json `recursion`).
    static let componentDepthCap = 256

    /// What an author meant by one `name="…"` attribute. Corpus:
    /// OpenSource/Conformance/composition/attribute-binding.json. Twins: the TS
    /// `attributeBinding` and the Kotlin `JSE.attributeBinding`.
    enum AttributeBinding: Equatable {
        case staticText
        case value(String)
        case text
    }

    /// The attribute-binding FOLD — pure syntax, no store, no evaluation.
    ///
    /// A sole `{{ … }}` carries the expression's VALUE; anything mixed carries the string.
    /// Without the distinction every consumer prop arrives interpolated, which is invisible
    /// for a label and fatal for structure: a component that renders its own children cannot
    /// hand them down, so a tree, an outliner or a comment thread is unbuildable.
    ///
    /// A hole ends at the FIRST `}}`, matching `interpolate`'s own scan exactly. The two must
    /// never disagree about where an expression stops — that disagreement is a silent type
    /// change, and one shared wrong answer is repairable where a split one is not.
    static func attributeBinding(_ template: String) -> AttributeBinding {
        guard template.contains("{{") else { return .staticText }
        let t = template.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("{{") else { return .text }
        let afterOpen = t.index(t.startIndex, offsetBy: 2)
        guard let close = t.range(of: "}}", range: afterOpen..<t.endIndex),
              close.upperBound == t.endIndex else { return .text }
        return .value(String(t[afterOpen..<close.lowerBound]))
    }

    /// Resolve one consumer attribute to the value it should carry: typed when the template
    /// is a sole hole, its own text when it has none, the interpolated sentence otherwise.
    static func bindAttribute(_ template: String, store: any JSEState, item: [String: Any]?) -> Any? {
        switch attributeBinding(template) {
        case .staticText: return template
        case .value(let expr): return eval(expr, store: store, item: item)
        case .text: return interpolate(template, store: store, item: item)
        }
    }

    static func interpolate(_ s: String, store: any JSEState, item: [String: Any]?) -> String {
        guard s.contains("{{") else { return s }
        var out = ""; var rest = Substring(s)
        while let open = rest.range(of: "{{") {
            out += rest[..<open.lowerBound]
            guard let close = rest.range(of: "}}", range: open.upperBound..<rest.endIndex) else {
                out += rest[open.lowerBound...]; return out
            }
            let expr = String(rest[open.upperBound..<close.lowerBound])
            out += string(eval(expr, store: store, item: item))
            rest = rest[close.upperBound...]
        }
        out += rest
        return out
    }

    static func eval(_ raw: String, store: any JSEState, item: [String: Any]?) -> Any? {
        let e = raw.trimmingCharacters(in: .whitespaces)
        if e.isEmpty { return nil }
        // Recursion budget: a self-referential computed / <variable> / binding (an expression
        // that reads itself, directly or transitively) re-evaluates forever — a 2-frame mutual
        // recursion that overflows the native stack (the device crashes). Bound it like
        // fnDepth / actionDepth: past the budget the expression yields nil + logs, so a knotted
        // expression is contained instead of fatal. 64 is far beyond any real computed chain
        // (a handful deep); only a cycle climbs here. evalDepth tracks NESTING (defer restores
        // it on every exit), so sequential evals within one action never accumulate.
        guard store.evalDepth < 64 else {
            kernelLog("[JSE] eval recursion budget (64) exceeded — expression cycle (a computed/binding referencing itself?); returning nil: \(e.prefix(80))")
            return nil
        }
        store.evalDepth += 1
        defer { store.evalDepth -= 1 }
        var p = Parser(tokens: cachedTokens(e), store: store, item: item)
        return p.expression()
    }

    // ── the token pre-parse cache ────────────────────────────────────────────────────────
    // A `{{ }}` binding / visible-if / computed formula re-evaluates its SAME expression
    // string on every render pass, and tokenize() re-scans it char-by-char each time —
    // measured at ~40-60% of a typical eval on the Kotlin twin (Engine/Android JseBenchmark.kt:
    // evalCond 1,407→728 ns/op, evalExpr 2,569→1,251). tokenize is a pure function of the
    // string and `[Token]` is a value-semantic array of value-type cases, so memoizing
    // string → token array is semantics-free (Parser/JSEval receive a COW copy). Size 512:
    // the distinct-expression population of an app is its authored binding/handler set
    // (typically low hundreds); eviction is the kernel's clear-on-full shape (JSERegex 128,
    // CSSInline 512), so the worst case degrades to exactly the pre-cache behavior:
    // re-tokenize. Locking mirrors JSERegex's. Kotlin twin: Jse.kt `cachedTokens` — same
    // key (the trimmed expression), same bound, same eviction; keep them in lockstep.
    private static let tokenCacheLock = NSLock()
    private static var tokenCache: [String: [Token]] = [:]
    private static func cachedTokens(_ s: String) -> [Token] {
        tokenCacheLock.lock()
        if let hit = tokenCache[s] { tokenCacheLock.unlock(); return hit }
        tokenCacheLock.unlock()
        let toks = tokenize(s)
        tokenCacheLock.lock()
        if tokenCache.count > 512 { tokenCache.removeAll() }
        tokenCache[s] = toks
        tokenCacheLock.unlock()
        return toks
    }

    /// Evaluate a `<variable>`/function body as a VALUE — a **bounded-JS** block.
    /// A single expression returns directly; a `{ }` block runs `if (…) { } else if { } else { }`,
    /// `const`/`let`, and `return` (early, or the last bare expression as an implicit return) —
    /// exactly like a JS function body. PURE: `const`/`let`/`x = e` write a throwaway local scope
    /// (seeded with `item`), never the store. Total — the full statement grammar incl.
    /// BUDGETED loops (10000 iterations per evaluation, corpus core-004) — so it
    /// always terminates. 1:1 JS, interpreted natively (no JS engine, no bridge).
    static func evalBlock(_ body: String, store: any JSEState, item: [String: Any]?) -> Any? {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        // Fast path: a plain single expression (no block / statements / declarations).
        if !trimmed.contains(";"), !trimmed.contains("\n"), !trimmed.contains("{"),
           !trimmed.hasPrefix("return"), !trimmed.hasPrefix("const "), !trimmed.hasPrefix("let "),
           !trimmed.hasPrefix("if "), !trimmed.hasPrefix("if("), !trimmed.hasPrefix("function") {
            return eval(trimmed, store: store, item: item)
        }
        let e = JSEval(cachedTokens(body), store: store, scope: item ?? [:])   // computed formulas re-run per READ — same cache (value-copied in)
        e.runBlock()
        return e.result
    }

    /// An arrow function captured as a VALUE — `(a, { x, y }) => expr` or `=> { … }`. It is only
    /// ever invoked by the bounded higher-order fns (map/filter/reduce/…) or a user-function call,
    /// so it can never loop on its own. `params` bind positionally; a `{ … }` param destructures.
    /// A named param takes an optional `def` (default-expression tokens — evaluated at CALL time
    /// in the CALLEE scope when the arg is missing/null) and `rest` binds the remaining args as an
    /// array (wave 3). `captured` is the CREATION scope (the row `item`, enclosing lambda params,
    /// block locals) — a value-semantic snapshot, so a nested arrow reads its enclosing scope like
    /// a JS closure.
    /// `pattern` is a DESTRUCTURED param in full — `([k, v]) => …`, `({ a: { b } }) => …`,
    /// defaults and rest included. `keys` only ever expressed a flat `{ a, b }`, so the most
    /// common data idiom in JS (`Object.entries(o).map(([k, v]) => …)`) bound the whole pair to
    /// one name. Present ⇒ it wins over `keys`. (Twins: values.ts LambdaParam, Jse.kt.)
    private struct LambdaParam {
        let name: String?
        let keys: [String]
        var def: [Token]? = nil
        var rest: Bool = false
        var pattern: DeclPattern? = nil
    }
    private struct StackLambda { let params: [LambdaParam]; let body: [Token]; let block: Bool; let captured: [String: Any] }

    /// Invoke a lambda / user function: bind args to params (destructuring `{a,b}`, call-time
    /// defaults, a trailing rest array), then evaluate the body — an expression, or a `{ }`
    /// statement block whose `return` (or last expression) is the value. The body's scope =
    /// caller `base` ⊕ captured creation scope ⊕ params — base fills UNDER the captured
    /// snapshot (capture semantics hold), which is what lets a stored lambda call ITSELF
    /// (`const f = n => … f(n - 1)`: f is not in its own creation snapshot, so the caller's
    /// live scope supplies it).
    private static func callLambda(_ f: StackLambda, _ args: [Any?], store: any JSEState, base: [String: Any]? = nil) -> Any? {
        var scope = base ?? [:]
        for (k, v) in f.captured { scope[k] = v }
        for (k, p) in f.params.enumerated() {
            if p.rest, let nm = p.name {
                // rest binds the REMAINING args as an array (empty when none)
                scope[nm] = k < args.count ? args[k...].map { $0 ?? NSNull() } : [Any]()
                continue
            }
            let a = k < args.count ? args[k] : nil
            if let nm = p.name {
                if isMissing(a), let def = p.def, !def.isEmpty {
                    // default — evaluated at CALL time in the CALLEE scope (earlier params visible)
                    var dp = Parser(tokens: def, store: store, item: scope)
                    scope[nm] = dp.expression() ?? NSNull()
                } else { scope[nm] = a ?? NSNull() }
            }
            else if let pat = p.pattern {
                JSE.bindPattern(pat, a, { n, v in scope[n] = v ?? NSNull() },
                                { toks in var dp = Parser(tokens: toks, store: store, item: scope); return dp.expression() })
            }
            else { let d = (a as? [String: Any]) ?? [:]; for key in p.keys { scope[key] = d[key] ?? NSNull() } }
        }
        if f.block { let e = JSEval(f.body, store: store, scope: scope); e.runBlock(); return e.result }
        var p = Parser(tokens: f.body, store: store, item: scope)
        return p.expression()
    }

    /// Register every top-level `function name(params) { … }` in `body` as a callable user
    /// function — positional args, **depth-capped at 32** (so even an accidental recursion is
    /// bounded, never a hang). String-scanned so it's available the moment the node is processed.
    static func registerFunctions(_ body: String, store: any JSEState) {
        scanFunctions(body) { name, fn in store.functions[name] = fn }
    }

    /// The GLOBAL FUNCTION LIBRARY (js-core.md "Shared logic") — ONE app-wide function
    /// table shared by every surface (satellite-safe: plain static state, no app store,
    /// no new imports). Resolved AFTER the surface's own `store.functions` (a
    /// surface-local name SHADOWS the global) and BEFORE the builtins.
    static var globalFunctions: [String: Any] = [:]

    /// Register `body`'s top-level functions into the APP-WIDE table — validation/pricing/
    /// formatting written ONCE, callable from every surface. Same scanner, same shapes as
    /// registerFunctions; global registration does NOT capture scope (free names resolve
    /// against the CALLING surface's live store, exactly like top-level surface functions).
    /// Same fnDepth 32 guard at call time. Boot/modules call this once at startup;
    /// re-registration replaces (last write wins).
    static func registerGlobalFunctions(_ body: String) {
        scanFunctions(body) { name, fn in globalFunctions[name] = fn }
    }

    /// Drop every globally registered function (tests; a full app reload).
    static func clearGlobalFunctions() {
        globalFunctions.removeAll()
    }

    /// THE one function-declaration scanner (registerFunctions / registerGlobalFunctions
    /// both ride it): finds every top-level `function name(params) { … }` in `body` and
    /// hands the built lambda to `register`. Top-level functions are NOT closures —
    /// captured stays empty; free names resolve against the live store at call time.
    private static func scanFunctions(_ body: String, register: (String, StackLambda) -> Void) {
        guard body.contains("function") else { return }
        let s = Array(body); var i = 0
        let kw = Array("function")
        func isWord(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" }
        while i < s.count {
            guard i + kw.count <= s.count, Array(s[i..<i + kw.count]) == kw,
                  (i == 0 || !isWord(s[i - 1])),
                  (i + kw.count >= s.count || !isWord(s[i + kw.count])) else { i += 1; continue }
            var j = i + kw.count
            while j < s.count, s[j].isWhitespace { j += 1 }
            var name = ""
            while j < s.count, isWord(s[j]) { name.append(s[j]); j += 1 }
            while j < s.count, s[j].isWhitespace { j += 1 }
            guard j < s.count, s[j] == "(" else { i += 1; continue }
            var depth = 0; var paramStr = ""
            while j < s.count {                                       // params ( … )
                let ch = s[j]
                if ch == "(" { depth += 1; if depth == 1 { j += 1; continue } }
                if ch == ")" { depth -= 1; if depth == 0 { j += 1; break } }
                paramStr.append(ch); j += 1
            }
            while j < s.count, s[j].isWhitespace { j += 1 }
            guard j < s.count, s[j] == "{" else { i = j; continue }
            var bdepth = 0; var bodyStr = ""
            while j < s.count {                                       // body { … }
                let ch = s[j]
                if ch == "{" { bdepth += 1; if bdepth == 1 { j += 1; continue } }
                if ch == "}" { bdepth -= 1; if bdepth == 0 { j += 1; break } }
                bodyStr.append(ch); j += 1
            }
            let params = paramStr.split(separator: ",")
                .map { LambdaParam(name: $0.trimmingCharacters(in: .whitespaces), keys: []) }
                .filter { !($0.name ?? "").isEmpty }
            // Top-level functions are NOT closures (free names resolve against the live store) —
            // captured stays empty; only arrow values snapshot their creation scope.
            if !name.isEmpty { register(name, StackLambda(params: params, body: tokenize(bodyStr), block: true, captured: [:])) }
            i = j
        }
    }

    /// The bounded-JS statement interpreter for a `{ }` body — `if (…) { } else if { } else { }`,
    /// braceless `if (c) return x`, `const`/`let`, `return`, nested `function` decls (skipped here;
    /// registered at the node), and bare expression statements (the last is the implicit value).
    /// Branches + BUDGETED loops (10000 iterations per evaluation, core-004) — a block
    /// is always total.
    private final class LoopBudget { var used = 0 }

    private final class JSEval {
        let t: [Token]; var i = 0
        let store: any JSEState
        var scope: [String: Any]
        var result: Any? = nil
        var done = false
        var flow: String? = nil                                  // "break" | "continue" — consumed by the owning loop
        let budget: LoopBudget
        init(_ t: [Token], store: any JSEState, scope: [String: Any], budget: LoopBudget? = nil) {
            self.t = t; self.store = store; self.scope = scope; self.budget = budget ?? LoopBudget()
        }

        func cur() -> Token? { i < t.count ? t[i] : nil }
        func isOp(_ s: String) -> Bool { if case .op(let o)? = cur() { return o == s }; return false }
        func isKw(_ s: String) -> Bool { if case .ident(let o)? = cur() { return o == s }; return false }

        /// Run statements until end-of-tokens or a closing `}` (left for the caller to consume).
        func runBlock() {
            while !done, flow == nil, let tk = cur() {
                if case .op("}") = tk { return }
                if case .op(";") = tk { i += 1; continue }
                let before = i
                statement(execute: true)
                if i == before { i += 1 }   // guard a non-advancing statement (malformed) — never spin
            }
        }
        private func skipBranch() {
            if isOp("{") {
                var d = 0
                while let tk = cur() {
                    if case .op("{") = tk { d += 1 }
                    else if case .op("}") = tk { d -= 1; i += 1; if d == 0 { return }; continue }
                    i += 1
                }
            } else {
                while let tk = cur() {
                    if case .op(";") = tk { i += 1; return }
                    if case .op("}") = tk { return }
                    i += 1
                }
            }
        }
        private func branch(execute: Bool) {
            if !execute { skipBranch(); return }
            if isOp("{") { i += 1; runBlock(); if isOp("}") { i += 1 } }
            else { statement(execute: true) }
        }
        private func statement(execute: Bool) {
            if isKw("function") { skipFunction(); return }
            if isKw("if") { ifStmt(execute: execute); return }
            if isKw("for") { forStmt(execute: execute); return }
            if isKw("while") { whileStmt(execute: execute); return }
            if isKw("do") { doStmt(execute: execute); return }
            if isKw("break") { i += 1; if isOp(";") { i += 1 }; if execute { flow = "break" }; return }
            if isKw("continue") { i += 1; if isOp(";") { i += 1 }; if execute { flow = "continue" }; return }
            if isKw("const") || isKw("let") || isKw("var") { declStmt(execute: execute); return }
            if isKw("return") { returnStmt(execute: execute); return }
            let toks = capture(until: [";"]); if isOp(";") { i += 1 }
            if execute, !done { exprStatement(toks) }
        }
        private func ifStmt(execute: Bool) {
            i += 1                                                   // 'if'
            var cond = false
            let c = captureParen()
            if execute { cond = JSE.truthy(evalExpr(c)) }
            branch(execute: execute && cond)
            if isKw("else") {
                i += 1
                if isKw("if") { ifStmt(execute: execute && !cond) }
                else { branch(execute: execute && !cond) }
            }
        }
        private func declStmt(execute: Bool) {
            i += 1                                                   // 'const' / 'let' / 'var'
            let toks = capture(until: [";"]); if isOp(";") { i += 1 }
            guard execute else { return }
            // multi-declarators + NESTED destructuring with defaults and rest:
            // `let a = 1, b = 2` · `const { a: { b } } = o` · `const { a = 5, ...rest } = o` · `const [p, ...q] = arr`
            for d in JSE.parseDeclarators(toks) {
                let v = d.expr.isEmpty ? nil : evalExpr(d.expr)
                JSE.bindPattern(d.pattern, v, { n, value in scope[n] = value ?? NSNull() },
                                // A `= default` evaluates in the SCOPE BEING BUILT, so an earlier
                                // position in the same pattern is visible to a later one's default.
                                { toks2 in self.evalExpr(toks2) })
            }
        }
        private func returnStmt(execute: Bool) {
            i += 1                                                   // 'return'
            let toks = capture(until: [";"]); if isOp(";") { i += 1 }
            if execute { result = toks.isEmpty ? nil : evalExpr(toks); done = true }
        }
        /// One loop iteration on the SHARED ledger — 10000 per block evaluation, the
        /// action runner's bounded-execution law. Past it every loop stops; total stays.
        private func loopStep() -> Bool { budget.used += 1; return budget.used <= 10000 }

        /// Capture a loop body: a `{ … }` group (braces consumed) or one bare statement.
        private func captureBranchTokens() -> [Token] {
            if isOp("{") {
                i += 1
                var out: [Token] = []
                var d = 1
                while let tk = cur() {
                    if case .op("{") = tk { d += 1 }
                    else if case .op("}") = tk { d -= 1; if d == 0 { i += 1; break } }
                    out.append(tk); i += 1
                }
                return out
            }
            let out = capture(until: [";"])
            if isOp(";") { i += 1 }
            return out
        }

        /// Run captured statements against THIS block's scope and its shared budget;
        /// a `return` settles this block, break/continue surface as flow for the owning
        /// loop to consume. The scope round-trips through the sub-eval (value semantics).
        private func runCaptured(_ body: [Token]) {
            let e = JSEval(body, store: store, scope: scope, budget: budget)
            e.runBlock()
            scope = e.scope
            if e.done { result = e.result; done = true }
            flow = e.flow
        }

        private func splitOnSemis(_ toks: [Token]) -> [[Token]] {
            var out: [[Token]] = []
            var run: [Token] = []
            var d = 0
            for tk in toks {
                if case .op(let o) = tk {
                    if o == "(" || o == "[" || o == "{" { d += 1 }
                    else if o == ")" || o == "]" || o == "}" { d -= 1 }
                    else if d == 0, o == ";" { out.append(run); run = []; continue }
                }
                run.append(tk)
            }
            out.append(run)
            return out
        }

        /// `for (init; cond; step)` · `for ([const] pattern of expr)` · `for ([const] k
        /// in expr)` — the loop grammar in expression blocks (corpus core-004), budgeted,
        /// with the classic form gated on top-level `;` (a classic cond may contain the
        /// `in` OPERATOR).
        private func forStmt(execute: Bool) {
            i += 1                                                 // 'for'
            let head = captureParen()
            let body = captureBranchTokens()
            guard execute else { return }
            let parts = splitOnSemis(head)
            if parts.count == 3 {
                runCaptured(parts[0])
                if done { return }
                flow = nil
                while true {
                    if !parts[1].isEmpty, !JSE.truthy(evalExpr(parts[1])) { break }
                    if !loopStep() { break }
                    runCaptured(body)
                    if done { return }
                    if flow == "break" { flow = nil; break }
                    flow = nil
                    runCaptured(parts[2])
                    if done { return }
                    flow = nil
                }
                return
            }
            var p = 0
            if p < head.count, case .ident(let kw0) = head[p], kw0 == "const" || kw0 == "let" || kw0 == "var" { p += 1 }
            var kwAt = -1
            var kind: String? = nil
            var d = 0
            var k = p
            while k < head.count {
                if case .op(let o) = head[k] {
                    if o == "(" || o == "[" || o == "{" { d += 1 }
                    else if o == ")" || o == "]" || o == "}" { d -= 1 }
                }
                if d == 0, case .ident(let w) = head[k], w == "of" || w == "in" { kwAt = k; kind = w; break }
                k += 1
            }
            guard kwAt >= 0, let kindWord = kind else { return }
            let patToks = Array(head[p..<kwAt])
            let exprToks = Array(head[(kwAt + 1)...])
            let decls = JSE.parseDeclarators(patToks + [.op("="), .num(0)])
            guard decls.count == 1 else { return }
            let pattern = decls[0].pattern
            let seq = kindWord == "of" ? JSE.spreadValues(evalExpr(exprToks)) : JSE.forInKeys(evalExpr(exprToks))
            for el in seq {
                if !loopStep() { break }
                JSE.bindPattern(pattern, el, { n, value in self.scope[n] = value ?? NSNull() },
                                { toks2 in self.evalExpr(toks2) })
                runCaptured(body)
                if done { return }
                if flow == "break" { flow = nil; break }
                flow = nil
            }
        }

        private func whileStmt(execute: Bool) {
            i += 1                                                 // 'while'
            let cond = captureParen()
            let body = captureBranchTokens()
            guard execute else { return }
            while JSE.truthy(evalExpr(cond)) {
                if !loopStep() { break }
                runCaptured(body)
                if done { return }
                if flow == "break" { flow = nil; break }
                flow = nil
            }
        }

        private func doStmt(execute: Bool) {
            i += 1                                                 // 'do'
            let body = captureBranchTokens()
            var cond: [Token] = []
            if isKw("while") {
                i += 1
                cond = captureParen()
                if isOp(";") { i += 1 }
            }
            guard execute else { return }
            repeat {
                if !loopStep() { break }
                runCaptured(body)
                if done { return }
                if flow == "break" { flow = nil; break }
                flow = nil
            } while JSE.truthy(evalExpr(cond))
        }

        private func skipFunction() {
            while let tk = cur() { if case .op("{") = tk { break }; i += 1 }
            skipBranch()
        }
        private func exprStatement(_ toks: [Token]) {
            // destructuring assignment `[a, b] = [b, a]` — the declaration-less pattern write
            // (syntax-005): the same parseDeclarators shape a `const` reads, bound with the
            // assignment writer. RHS evaluates ONCE before any binding, so a swap is a swap.
            if toks.count >= 4, case .op("[") = toks[0] {
                let decls = JSE.parseDeclarators(toks)
                if decls.count == 1, case .arr(let items, let rest) = decls[0].pattern,
                   !decls[0].expr.isEmpty, items.contains(where: { $0 != nil }) || rest != nil {
                    let v = evalExpr(decls[0].expr)
                    JSE.bindPattern(decls[0].pattern, v, { n, value in scope[n] = value ?? NSNull() },
                                    { toks2 in self.evalExpr(toks2) })
                    return
                }
            }
            // local assignment `x = e` (single ident LHS), else a bare expression (implicit value).
            if toks.count >= 2, case .ident(let n) = toks[0], !n.contains("."), case .op("=") = toks[1] {
                scope[n] = evalExpr(Array(toks.dropFirst(2))) ?? NSNull(); return
            }
            // BLOCK-SCOPE MUTATION (corpus core-003): dotted / computed-key / indexed
            // assignment into a scope name, compound assignment, ++/--, and statement-
            // position `.push(…)` all REBUILD the local (value semantics — never an
            // alias, never the store). The accumulator idioms, made real.
            if case .op(let leadOp)? = toks.first, leadOp == "++" || leadOp == "--" {
                if pathMutation(Array(toks.dropFirst()) + [toks[0]]) { return }   // prefix form → the postfix shape
            }
            if pathMutation(toks) { return }
            result = evalExpr(toks)
        }

        /// Parse and perform `NAME(seg…) op= rhs` / `NAME(seg…).push(args)`; true when
        /// handled. A dotted ident is ONE token (the tokenizer's dotted-ident rule), so
        /// static segments split out of the leading token and every post-bracket run.
        private enum PathSeg { case fixed(String); case computed([Token]) }
        private func pathMutation(_ toks: [Token]) -> Bool {
            guard toks.count >= 2, case .ident(let leading) = toks[0] else { return false }
            let head = leading.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
            guard let name = head.first, !name.isEmpty else { return false }
            // dsx.* / global.* / route.* / cookie.* are NAMESPACES, not block locals —
            // a block body never writes them (the evalBlock purity contract).
            if name == "dsx" || name == "global" || name == "route" || name == "cookie" { return false }
            var segs: [PathSeg] = head.dropFirst().map { .fixed($0) }
            var j = 1
            while true {
                if j + 1 < toks.count, case .op(".") = toks[j], case .ident(let b) = toks[j + 1] {
                    for part in b.split(separator: ".", omittingEmptySubsequences: false) { segs.append(.fixed(String(part))) }
                    j += 2; continue
                }
                if j < toks.count, case .op("[") = toks[j] {
                    var inner: [Token] = []; var d = 1; var k = j + 1
                    while k < toks.count {
                        if case .op(let o) = toks[k] {
                            if o == "[" || o == "(" || o == "{" { d += 1 }
                            if o == "]" || o == ")" || o == "}" { d -= 1; if d == 0 { break } }
                        }
                        inner.append(toks[k]); k += 1
                    }
                    if k >= toks.count { return false }
                    segs.append(.computed(inner)); j = k + 1; continue
                }
                break
            }
            // `x++` / `m.n--` — read-modify-write through the same path law.
            if j == toks.count - 1, case .op(let bump) = toks[j], bump == "++" || bump == "--" {
                let parts = evalSegs(segs)
                let value = JSE.arith(getInLocal(baseFor(name), parts), 1.0, bump == "++" ? "+" : "-")
                if parts.isEmpty { scope[name] = value ?? NSNull() }
                else { scope[name] = setInLocal(baseFor(name), parts, value ?? NSNull()) ?? NSNull() }
                return true
            }
            // `path.push(a, b)` — statement-position growth of the local array (push has
            // no pure reading; pop/shift stay pure reads, stdlib-002). The whole
            // statement must be exactly the call.
            var lastIsPush = false
            if case .fixed("push")? = segs.last { lastIsPush = true }
            if lastIsPush, j < toks.count, case .op("(") = toks[j] {
                var inner: [Token] = []; var d = 1; var k = j + 1
                while k < toks.count {
                    if case .op(let o) = toks[k] {
                        if o == "(" || o == "[" || o == "{" { d += 1 }
                        if o == ")" || o == "]" || o == "}" { d -= 1; if d == 0 { break } }
                    }
                    inner.append(toks[k]); k += 1
                }
                if d != 0 || k != toks.count - 1 { return false }
                segs.removeLast()
                let parts = evalSegs(segs)
                var arr = JSE.asArray(getInLocal(baseFor(name), parts))
                for run in Self.splitTopLevelTokens(inner) where !run.isEmpty { arr.append(evalExpr(run) ?? NSNull()) }
                scope[name] = setInLocal(baseFor(name), parts, arr) ?? NSNull()
                return true
            }
            guard j < toks.count, case .op(let opV) = toks[j] else { return false }
            guard opV == "=" || opV == "+=" || opV == "-=" || opV == "*=" || opV == "/=" || opV == "%=" else { return false }
            let rhsToks = Array(toks.dropFirst(j + 1))
            if rhsToks.isEmpty { return false }
            let rhs = evalExpr(rhsToks)
            let parts = evalSegs(segs)
            let value: Any? = opV == "="
                ? rhs
                : JSE.arith(getInLocal(baseFor(name), parts), rhs, String(opV.prefix(1)))
            if parts.isEmpty { scope[name] = value ?? NSNull(); return true }
            scope[name] = setInLocal(baseFor(name), parts, value ?? NSNull()) ?? NSNull()
            return true
        }

        /// The container a path write rebuilds from: the block's own binding, else the
        /// normal lookup (a caller-scope name copies in on first write — the evalBlock
        /// purity contract: reads shadow, writes stay local).
        private func baseFor(_ name: String) -> Any? {
            if let own = scope[name] { return own }
            return evalExpr([.ident(name)])
        }

        /// Path segments to keys: a static ident stays a string, a computed `[e]`
        /// evaluates in this scope.
        private func evalSegs(_ segs: [PathSeg]) -> [Any?] {
            segs.map { seg in
                switch seg {
                case .fixed(let k): return k
                case .computed(let toks): return evalExpr(toks)
                }
            }
        }

        /// Walk `parts` into `container` — the read twin of setInLocal; missing → null.
        private func getInLocal(_ container: Any?, _ parts: [Any?]) -> Any? {
            var cur: Any? = container
            for p in parts {
                if let arr = cur as? [Any] {
                    if let idx = JSE.number(p), idx >= 0, Int(idx) < arr.count { cur = arr[Int(idx)] } else { return nil }
                } else if let d = cur as? [String: Any] {
                    cur = d[JSE.string(p)]
                } else {
                    return nil
                }
            }
            return cur
        }

        /// Rebuild `container` with `parts` set to `value` — BY COPY at every level
        /// (Swift dictionaries and arrays are value types, so the copy is the language;
        /// the TS/Kotlin twins copy explicitly to match). A numeric part indexes an
        /// array (in bounds, or appends at exactly length); anything else keys a dict;
        /// a missing nest is created — total, never a throw.
        private func setInLocal(_ container: Any?, _ parts: [Any?], _ value: Any?) -> Any? {
            if parts.isEmpty { return value }
            let headSeg = parts[0]
            let rest = Array(parts.dropFirst())
            if var arr = container as? [Any], let idx = JSE.number(headSeg) {
                let iN = Int(idx)
                if iN >= 0 && iN < arr.count { arr[iN] = setInLocal(arr[iN], rest, value) ?? NSNull() }
                else if iN == arr.count { arr.append(setInLocal(nil, rest, value) ?? NSNull()) }
                return arr
            }
            var d = (container as? [String: Any]) ?? [:]
            let key = JSE.string(headSeg)
            d[key] = setInLocal(d[key], rest, value) ?? NSNull()
            return d
        }

        /// Split a token run on top-level commas (argument lists in block statements).
        private static func splitTopLevelTokens(_ toks: [Token]) -> [[Token]] {
            var out: [[Token]] = []
            var cur: [Token] = []
            var d = 0
            for tk in toks {
                if case .op(let o) = tk {
                    if o == "(" || o == "[" || o == "{" { d += 1 }
                    else if o == ")" || o == "]" || o == "}" { d -= 1 }
                    else if d == 0 && o == "," { out.append(cur); cur = []; continue }
                }
                cur.append(tk)
            }
            out.append(cur)
            return out
        }
        /// Collect tokens up to a top-level stop op (depth-aware); does NOT consume the stop.
        private func capture(until stops: Set<String>) -> [Token] {
            var out: [Token] = []; var d = 0
            while let tk = cur() {
                if case .op(let o) = tk {
                    if o == "(" || o == "[" || o == "{" { d += 1; out.append(tk); i += 1; continue }
                    if o == ")" || o == "]" || o == "}" { if d == 0 { break }; d -= 1; out.append(tk); i += 1; continue }
                    if d == 0, stops.contains(o) { break }
                }
                out.append(tk); i += 1
            }
            return out
        }
        /// Collect the contents of a `( … )` group (consumes both parens), depth-aware.
        private func captureParen() -> [Token] {
            var out: [Token] = []; var d = 0
            guard isOp("(") else { return out }
            i += 1; d = 1
            while let tk = cur() {
                if case .op("(") = tk { d += 1 }
                else if case .op(")") = tk { d -= 1; if d == 0 { i += 1; break } }
                out.append(tk); i += 1
            }
            return out
        }
        private func evalExpr(_ toks: [Token]) -> Any? {
            var p = Parser(tokens: toks, store: store, item: scope)
            return p.expression()
        }
    }

    // MARK: tokens + parser

    private enum TemplatePart: Equatable { case lit(String), expr([Token]) }

    private enum Token: Equatable {
        case num(Double), str(String), ident(String), op(String), regex(String, String)
        case template([TemplatePart])
    }

    // ── the shared source preprocessor (comments, then ASI) — twin of tokens.ts ──────
    // Every tokenize entry runs it; the statement runner additionally runs the comment
    // pass at the string level before jsLeaf (JSERunner.stripJSComments forwards here).

    private static func isAsciiDigit(_ ch: Character) -> Bool { ch >= "0" && ch <= "9" }
    private static func isHexChar(_ ch: Character) -> Bool {
        isAsciiDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F")
    }

    /// `/` starts a regex literal at CHAR level — prefix position = no previous
    /// significant char, or an operator char that is not a value terminator.
    private static func charAllowsRegex(_ prev: Character?) -> Bool {
        guard let p = prev else { return true }
        if p.isLetter || p.isNumber || p == "_" { return false }
        return p != ")" && p != "]" && p != "'" && p != "\"" && p != "`"
    }

    /// Keywords a regex literal may DIRECTLY follow (`return /ab/.test(s)`, `case /a/…`,
    /// `typeof /x/`) — shared by the char-level scanners and the token-level rule.
    private static let regexKeywords: Set<String> = ["return", "case", "typeof", "in", "of", "do", "else", "throw"]

    private static func isWordChar(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" }

    /// Char-level companion to charAllowsRegex: when the previous significant char is a
    /// word char, scan the word back in the emitted buffer (bounded) — a keyword still
    /// puts the `/` in regex position (`return /ab/`), an ident/number does not (`x / 2`).
    /// Generic over String / [Character] (the two emit buffers the scanners keep).
    private static func regexAfterKeyword<S: BidirectionalCollection>(_ out: S) -> Bool where S.Element == Character {
        var w = ""
        var started = false
        for ch in out.reversed() {
            if !started {
                if ch.isWhitespace { continue }
                started = true
            }
            if isWordChar(ch) {
                w = String(ch) + w
                if w.count > 8 { return false }               // longer than any keyword here
            } else { break }
        }
        return regexKeywords.contains(w)
    }

    /// Scan a regex literal starting at the `/` at `i` (backslash pairs + [class] aware).
    /// Returns the index one past the flags, or nil if unterminated (→ it was division).
    private static func scanRegexEnd(_ c: [Character], _ i: Int) -> Int? {
        var j = i + 1; var inClass = false; var closed = false
        while j < c.count {
            let rc = c[j]
            if rc == "\\", j + 1 < c.count { j += 2; continue }
            if rc == "[" { inClass = true }
            if rc == "]" { inClass = false }
            if rc == "/", !inClass { closed = true; j += 1; break }
            if rc == "\n" { break }                             // literals don't span lines
            j += 1
        }
        if !closed || j == i + 1 { return nil }
        while j < c.count, c[j].isLetter { j += 1 }
        return j
    }

    /// Copy a quoted span (`'` / `"`) verbatim, honoring backslash pairs.
    private static func copyQuoted(_ c: [Character], _ i: Int, _ out: inout String) -> Int {
        let q = c[i]
        out.append(q)
        var j = i + 1
        while j < c.count {
            let ch = c[j]
            if ch == "\\", j + 1 < c.count { out.append(ch); out.append(c[j + 1]); j += 2; continue }
            out.append(ch)
            j += 1
            if ch == q { break }
        }
        return j
    }

    /// Copy a template span verbatim (`` ` `` … `` ` ``), honoring backslash pairs and
    /// `${ }` hole depth so a `}` or backtick inside a hole doesn't close it. Inside a
    /// hole, quoted spans delegate to copyQuoted and nested backticks recurse (a `'{'`
    /// string literal in a hole must not skew the depth); recursion is depth-capped
    /// (past ~32 a backtick copies as a plain char — bounded, never a stack overflow).
    private static func copyTemplate(_ c: [Character], _ i: Int, _ out: inout String, depth: Int = 0) -> Int {
        out.append("`")
        var j = i + 1; var hole = 0
        while j < c.count {
            let ch = c[j]
            if ch == "\\", j + 1 < c.count { out.append(ch); out.append(c[j + 1]); j += 2; continue }
            if hole == 0, ch == "`" { out.append(ch); j += 1; break }
            if hole > 0, ch == "'" || ch == "\"" { j = copyQuoted(c, j, &out); continue }
            if hole > 0, ch == "`", depth < 32 { j = copyTemplate(c, j, &out, depth: depth + 1); continue }
            if ch == "$", j + 1 < c.count, c[j + 1] == "{" { out.append("${"); hole += 1; j += 2; continue }
            if hole > 0, ch == "{" { hole += 1 }
            if hole > 0, ch == "}" { hole -= 1 }
            out.append(ch)
            j += 1
        }
        return j
    }

    /// Pass 1 — strip JS comments: `// …` to end of line (newline kept — it is the
    /// statement break) and `/* … */` to ONE space. Quote-, template- and regex-literal-
    /// aware; `://` is protocol syntax (the fetch-effect URL form), never a comment.
    static func stripComments(_ s: String) -> String {
        guard s.contains("//") || s.contains("/*") else { return s }
        let c = Array(s); var out = ""; var i = 0
        var prevSig: Character? = nil
        while i < c.count {
            let ch = c[i]
            if ch == "'" || ch == "\"" { i = copyQuoted(c, i, &out); prevSig = ch; continue }
            if ch == "`" { i = copyTemplate(c, i, &out); prevSig = "`"; continue }
            if ch == "/", i + 1 < c.count, c[i + 1] == "/", prevSig != ":" {
                while i < c.count, c[i] != "\n" { i += 1 }      // drop to EOL (keep the newline)
                continue
            }
            if ch == "/", i + 1 < c.count, c[i + 1] == "*" {
                i += 2
                while i + 1 < c.count, !(c[i] == "*" && c[i + 1] == "/") { i += 1 }
                i = min(i + 2, c.count)
                out.append(" ")                                 // never glue the surrounding tokens
                continue
            }
            if ch == "/",
               charAllowsRegex(prevSig) || (prevSig.map { isWordChar($0) } == true && regexAfterKeyword(out)),
               let end = scanRegexEnd(c, i) {
                var k = i
                while k < end { out.append(c[k]); k += 1 }
                prevSig = c[end - 1]
                i = end
                continue
            }
            out.append(ch)
            if !ch.isWhitespace { prevSig = ch }
            i += 1
        }
        return out
    }

    /// The jsLeaf continuation heuristic (the statement runners' ASI rule), char-level.
    private static func lineContinues(_ out: [Character], _ c: [Character], after: Int) -> Bool {
        var t = out.count - 1
        while t >= 0, out[t] == " " || out[t] == "\t" || out[t] == "\r" { t -= 1 }
        if t >= 0 {
            let last = out[t]
            let isIncDec = (last == "+" || last == "-") && t >= 1 && out[t - 1] == last
            if !isIncDec, "+-*/%&|<>=!?:,.".contains(last) { return true }
        }
        var j = after + 1
        while j < c.count, c[j].isWhitespace { j += 1 }
        guard j < c.count else { return false }
        let ch = c[j]
        if ch == "." || ch == "?" || ch == ":" { return true }
        if (ch == "&" || ch == "|"), j + 1 < c.count, c[j + 1] == ch { return true }
        return false
    }

    /// Scan the WORD that starts the next line (past whitespace) — bounded.
    private static func nextWord(_ c: [Character], _ after: Int) -> String {
        var j = after + 1
        while j < c.count, c[j].isWhitespace { j += 1 }
        var w = ""
        while j < c.count, isWordChar(c[j]), w.count <= 8 { w.append(c[j]); j += 1 }
        return w
    }

    /// Pass 0 — decode the XML OPERATOR entities. A code body arrives RAW from the markup
    /// reader on every renderer (code tags are lifted 1:1 — StackNode.liftCode here), so
    /// an author who spells `&&` as `&amp;&amp;` (attribute muscle memory) hands the
    /// lexer `& amp ; & amp ;`: bitwise ops over an `amp` identifier that silently
    /// evaluate to 0 (the wave-7 F4 "0" write). The three entities with OPERATOR meaning
    /// decode here, outside string/template/regex literals only. `&quot;`/`&apos;` stay
    /// untouched (decoding them would move literal boundaries) and a bare `&` stays
    /// literal — the markup reader's smart-entity rule, mirrored.
    /// Corpus: OpenSource/Conformance/jse/syntax-006.json (three runners).
    static func decodeOperatorEntities(_ s: String) -> String {
        guard s.contains("&amp;") || s.contains("&lt;") || s.contains("&gt;") else { return s }
        let c = Array(s); var out = ""; var i = 0
        var prevSig: Character? = nil
        while i < c.count {
            let ch = c[i]
            if ch == "'" || ch == "\"" { i = copyQuoted(c, i, &out); prevSig = ch; continue }
            if ch == "`" { i = copyTemplate(c, i, &out); prevSig = "`"; continue }
            if ch == "/",
               charAllowsRegex(prevSig) || (prevSig.map { isWordChar($0) } == true && regexAfterKeyword(out)),
               let end = scanRegexEnd(c, i) {
                var k = i
                while k < end { out.append(c[k]); k += 1 }
                prevSig = c[end - 1]
                i = end
                continue
            }
            if ch == "&" {
                let rest = String(c[(i + 1)..<min(i + 5, c.count)])
                let op: Character? = rest.hasPrefix("amp;") ? "&" : rest.hasPrefix("lt;") ? "<" : rest.hasPrefix("gt;") ? ">" : nil
                if let op {
                    out.append(op)
                    prevSig = op
                    i += op == "&" ? 5 : 4
                    continue
                }
            }
            out.append(ch)
            if !ch.isWhitespace { prevSig = ch }
            i += 1
        }
        return out
    }

    /// True when the `{` being pushed opens a `do` block (the word before it is `do`).
    private static func braceOpensDo(_ out: [Character]) -> Bool {
        var t = out.count - 1
        while t >= 0, out[t].isWhitespace { t -= 1 }
        guard t >= 1, out[t] == "o", out[t - 1] == "d" else { return false }
        return t - 2 < 0 || !isWordChar(out[t - 2])
    }

    /// A newline here must NOT become `;` because the next line's keyword ATTACHES to the
    /// just-closed `{ }` block: `}` + `else`/`catch`/`finally` (an if/try branch), and `}`
    /// + `while` when that brace closed a `do` block. Braceless branches keep the `;` —
    /// there the separator is load-bearing (the statement capture stops at it).
    private static func keywordJoinsBlock(_ c: [Character], _ after: Int, _ prevSig: Character?, _ closedDo: Bool) -> Bool {
        guard prevSig == "}" else { return false }
        let w = nextWord(c, after)
        if w == "else" || w == "catch" || w == "finally" { return true }
        return w == "while" && closedDo
    }

    /// Pass 2 — ASI: replace each statement-boundary newline with `;`. A newline is a
    /// boundary only at bracket-stack depth zero or directly inside a `{ }` body (never
    /// inside `( )` / `[ ]`, where newlines stay soft), and only when the continuation
    /// heuristic says the statement is complete. Never before a line whose
    /// `else`/`while`/`catch`/`finally` attaches to the `}` block just closed.
    static func asiSemicolons(_ s: String) -> String {
        guard s.contains("\n") else { return s }
        let c = Array(s); var out = ""; var outChars: [Character] = []
        var stack: [Character] = []; var i = 0                 // "(" / "[" / "{" / "D" (a `{` opened by `do`)
        var prevSig: Character? = nil
        var justClosedDo = false                               // the last significant char was a `}` closing a do-block
        func emit(_ ch: Character) { out.append(ch); outChars.append(ch) }
        func emitRange(_ from: Int, _ to: Int) { var k = from; while k < to { emit(c[k]); k += 1 } }
        while i < c.count {
            let ch = c[i]
            if ch == "'" || ch == "\"" || ch == "`" {
                var span = ""
                let end = ch == "`" ? copyTemplate(c, i, &span) : copyQuoted(c, i, &span)
                for sc in span { outChars.append(sc) }
                out.append(span)
                prevSig = ch
                justClosedDo = false
                i = end
                continue
            }
            if ch == "/",
               charAllowsRegex(prevSig) || (prevSig.map { isWordChar($0) } == true && regexAfterKeyword(outChars)),
               let end = scanRegexEnd(c, i) {
                emitRange(i, end)
                prevSig = c[end - 1]
                justClosedDo = false
                i = end
                continue
            }
            var closesDo = false
            if ch == "(" || ch == "[" || ch == "{" { stack.append(ch == "{" && braceOpensDo(outChars) ? "D" : ch) }
            else if ch == ")" || ch == "]" || ch == "}" {
                if !stack.isEmpty {
                    let p = stack.removeLast()
                    closesDo = ch == "}" && p == "D"
                }
            }
            else if ch == "\n" {
                let innermost = stack.last
                if (innermost == nil || innermost == "{" || innermost == "D"), !lineContinues(outChars, c, after: i),
                   !keywordJoinsBlock(c, i, prevSig, justClosedDo) {
                    emit(";")
                    i += 1
                    continue
                }
            }
            emit(ch)
            if !ch.isWhitespace { prevSig = ch; justClosedDo = closesDo }
            i += 1
        }
        return out
    }

    /// The shared entry: lone `\r` line endings normalized, operator entities decoded,
    /// comments out, then statement-boundary newlines to `;`.
    static func preprocessSource(_ s: String) -> String {
        let normalized = s.contains("\r")
            ? s.replacingOccurrences(of: "\\r(?!\\n)", with: "\n", options: .regularExpression)
            : s
        return asiSemicolons(stripComments(decodeOperatorEntities(normalized)))
    }

    // ── string-literal escapes (the JS set; unknown escape = the char itself) ────────

    /// `c[j]` is the char AFTER the backslash; appends the unescaped text and returns
    /// the next index to resume at. `\uXXXX` surrogate PAIRS combine into one scalar
    /// (Swift strings cannot hold a lone surrogate; a lone one falls back to the char).
    private static func unescapeInto(_ str: inout String, _ c: [Character], _ j: Int) -> Int {
        func hex4(_ at: Int) -> UInt32? {
            guard at + 3 < c.count, isHexChar(c[at]), isHexChar(c[at + 1]), isHexChar(c[at + 2]), isHexChar(c[at + 3]) else { return nil }
            return UInt32(String(c[at...(at + 3)]), radix: 16)
        }
        let e = c[j]
        switch e {
        case "n": str.append("\n"); return j + 1
        case "t": str.append("\t"); return j + 1
        case "r": str.append("\r"); return j + 1
        case "b": str.append("\u{0008}"); return j + 1
        case "f": str.append("\u{000C}"); return j + 1
        case "v": str.append("\u{000B}"); return j + 1
        case "0": str.append("\u{0000}"); return j + 1
        case "\n": return j + 1                                 // line continuation
        case "x":
            if j + 2 < c.count, isHexChar(c[j + 1]), isHexChar(c[j + 2]),
               let v = UInt32(String([c[j + 1], c[j + 2]]), radix: 16), let sc = Unicode.Scalar(v) {
                str.append(Character(sc)); return j + 3
            }
            str.append(e); return j + 1
        case "u":
            if j + 1 < c.count, c[j + 1] == "{" {
                var k = j + 2; var hex = ""
                while k < c.count, isHexChar(c[k]) { hex.append(c[k]); k += 1 }
                if k < c.count, c[k] == "}", hex.count >= 1, hex.count <= 6,
                   let cp = UInt32(hex, radix: 16), let sc = Unicode.Scalar(cp) {
                    str.append(Character(sc)); return k + 1
                }
                str.append(e); return j + 1
            }
            if let hi = hex4(j + 1) {
                // a UTF-16 surrogate pair written as two escapes combines into one scalar
                if (0xD800...0xDBFF).contains(hi), j + 10 < c.count, c[j + 5] == "\\", c[j + 6] == "u",
                   let lo = hex4(j + 7), (0xDC00...0xDFFF).contains(lo),
                   let sc = Unicode.Scalar(0x10000 + (hi - 0xD800) * 0x400 + (lo - 0xDC00)) {
                    str.append(Character(sc)); return j + 11
                }
                if let sc = Unicode.Scalar(hi) { str.append(Character(sc)); return j + 5 }
                str.append(e); return j + 1
            }
            str.append(e); return j + 1
        default: str.append(e); return j + 1                    // \' \" \` \\ \/ and every unknown → the char
        }
    }

    // ── numeric literals ─────────────────────────────────────────────────────────────

    /// Scan a numeric literal at `i` (a digit, or `.` + digit). Underscore separators
    /// are consumed only BETWEEN digits of the active alphabet. Returns value + next index.
    private static func scanNumber(_ c: [Character], _ i: Int) -> (Double, Int) {
        func digitValue(_ ch: Character) -> Double? {
            guard let v = ch.hexDigitValue else { return nil }
            return Double(v)
        }
        func radix(_ pfx: Character, _ digit: (Character) -> Bool, _ base: Double) -> (Double, Int)? {
            guard c[i] == "0", i + 1 < c.count,
                  c[i + 1] == pfx || c[i + 1] == Character(pfx.uppercased()) else { return nil }
            var j = i + 2; var any = false; var v = 0.0
            while j < c.count {
                let ch = c[j]
                if digit(ch), let d = digitValue(ch) { v = v * base + d; any = true; j += 1; continue }
                if ch == "_", any, j + 1 < c.count, digit(c[j + 1]) { j += 1; continue }
                break
            }
            if !any { return nil }                              // bare `0x` → the plain 0, `x…` lexes on
            return (v, j)
        }
        if let hex = radix("x", isHexChar, 16) { return hex }
        if let bin = radix("b", { $0 == "0" || $0 == "1" }, 2) { return bin }
        if let oct = radix("o", { $0 >= "0" && $0 <= "7" }, 8) { return oct }
        // decimal: digits [. digits] [ (e|E) [+-] digits ] with `_` between digits
        var j = i; var n = ""; var seenDot = false
        while j < c.count {
            let ch = c[j]
            if isAsciiDigit(ch) { n.append(ch); j += 1; continue }
            if ch == ".", !seenDot, j + 1 < c.count, isAsciiDigit(c[j + 1]) { seenDot = true; n.append(ch); j += 1; continue }
            if ch == ".", !seenDot, !n.isEmpty { seenDot = true; n.append(ch); j += 1; continue } // trailing `1.`
            if ch == "_", !n.isEmpty, isAsciiDigit(c[j - 1]), j + 1 < c.count, isAsciiDigit(c[j + 1]) { j += 1; continue }
            break
        }
        if j < c.count, c[j] == "e" || c[j] == "E" {
            var k = j + 1
            if k < c.count, c[k] == "+" || c[k] == "-" { k += 1 }
            if k < c.count, isAsciiDigit(c[k]) {
                n.append(c[j])
                var m = j + 1
                while m < c.count, isAsciiDigit(c[m]) || ((c[m] == "+" || c[m] == "-") && m == j + 1) { n.append(c[m]); m += 1 }
                j = m
            }
        }
        return (Double(n) ?? 0, j)
    }

    // ── the tokenizer ────────────────────────────────────────────────────────────────

    private static func tokenize(_ s: String) -> [Token] {
        tokenizeRaw(preprocessSource(s))
    }

    private static func tokenizeRaw(_ s: String, holeDepth: Int = 0) -> [Token] {
        var toks: [Token] = []
        let c = Array(s); var i = 0
        let threeCharOps = ["===", "!==", ">>>", "**=", "..."]
        let twoCharOps = [
            "==", "!=", "<=", ">=", "&&", "||", "=>",
            "**", "??", "?.", "<<", ">>", "++", "--", "+=", "-=", "*=", "/=", "%=",
        ]
        func isIdent(_ ch: Character) -> Bool { ch.isLetter || ch.isNumber || ch == "_" || ch == "." }
        while i < c.count {
            let ch = c[i]
            if ch.isWhitespace { i += 1; continue }
            if ch == "'" || ch == "\"" {                       // string literal — JS escape grammar
                let q = ch; i += 1; var str = ""
                while i < c.count, c[i] != q {
                    if c[i] == "\\", i + 1 < c.count { i = unescapeInto(&str, c, i + 1); continue }
                    str.append(c[i]); i += 1
                }
                if i < c.count { i += 1 }                       // closing quote
                toks.append(.str(str)); continue
            }
            if ch == "`" {                                      // template literal
                i += 1
                var parts: [TemplatePart] = []
                var lit = ""
                while i < c.count, c[i] != "`" {
                    if c[i] == "\\", i + 1 < c.count { i = unescapeInto(&lit, c, i + 1); continue }
                    if c[i] == "$", i + 1 < c.count, c[i + 1] == "{" {
                        if !lit.isEmpty { parts.append(.lit(lit)); lit = "" }
                        i += 2
                        var depth = 1; var src = ""
                        while i < c.count {
                            let hc = c[i]
                            if hc == "'" || hc == "\"" { i = copyQuoted(c, i, &src); continue }
                            if hc == "`" { i = copyTemplate(c, i, &src); continue }
                            if hc == "{" { depth += 1 }
                            else if hc == "}" { depth -= 1; if depth == 0 { i += 1; break } }
                            src.append(hc)
                            i += 1
                        }
                        // hole recursion is depth-capped (~32): past it the hole rides as
                        // literal text — bounded, never a stack overflow on adversarial nesting
                        if holeDepth < 32 { parts.append(.expr(tokenizeRaw(src, holeDepth: holeDepth + 1))) }
                        else { parts.append(.lit(src)) }
                        continue
                    }
                    lit.append(c[i]); i += 1
                }
                if i < c.count { i += 1 }                       // closing backtick
                if !lit.isEmpty { parts.append(.lit(lit)) }
                toks.append(.template(parts)); continue
            }
            // ASCII digits only — `½` / `٣` are Character.isNumber but scanNumber consumes
            // only ASCII, which used to stall the loop (i never advanced): they lex as
            // plain op chars on every kernel instead.
            if isAsciiDigit(ch) || (ch == "." && i + 1 < c.count && isAsciiDigit(c[i + 1])) {
                let (v, next) = scanNumber(c, i)
                if next == i { i += 1; continue }              // belt-and-braces: never stall
                toks.append(.num(v)); i = next; continue
            }
            if ch.isLetter || ch == "_" {          // identifier / dotted path (dsx.this, item.index…)
                var id = ""
                while i < c.count, isIdent(c[i]) { id.append(c[i]); i += 1 }
                toks.append(.ident(id)); continue
            }
            if ch == "/" {
                // Regex literal vs division — the standard JS lexer heuristic: a `/` in PREFIX
                // position starts a regex; after a value (or postfix `++`/`--`) it's division.
                // A keyword ident (`return` / `case` / `typeof` / …) is prefix position too.
                // `//` and `/*` never start a regex (comments — already stripped upstream).
                let prevAllowsRegex: Bool = {
                    guard let last = toks.last else { return true }
                    if case .op(let o) = last { return o != ")" && o != "]" && o != "++" && o != "--" }
                    if case .ident(let w) = last { return regexKeywords.contains(w) }
                    return false
                }()
                if prevAllowsRegex, i + 1 < c.count, c[i + 1] != "/", c[i + 1] != "*" {
                    var j = i + 1; var pat = ""; var inClass = false; var closed = false
                    while j < c.count {
                        let rc = c[j]
                        if rc == "\\", j + 1 < c.count { pat.append(rc); pat.append(c[j + 1]); j += 2; continue }
                        if rc == "[" { inClass = true }
                        if rc == "]" { inClass = false }
                        if rc == "/", !inClass { closed = true; j += 1; break }
                        if rc == "\n" { break }                   // literals don't span lines
                        pat.append(rc); j += 1
                    }
                    if closed, !pat.isEmpty {
                        var flags = ""
                        while j < c.count, c[j].isLetter { flags.append(c[j]); j += 1 }
                        toks.append(.regex(pat, flags)); i = j; continue
                    }
                }
            }
            if i + 2 < c.count, threeCharOps.contains(String([ch, c[i + 1], c[i + 2]])) {
                toks.append(.op(String([ch, c[i + 1], c[i + 2]]))); i += 3; continue
            }
            if i + 1 < c.count, twoCharOps.contains(String([ch, c[i + 1]])) {
                let two = String([ch, c[i + 1]])
                // `?.` followed by a digit is a ternary + number (`x ?.5 : y`), the JS lookahead rule
                if two == "?.", i + 2 < c.count, isAsciiDigit(c[i + 2]) {
                    toks.append(.op("?")); i += 1; continue
                }
                toks.append(.op(two)); i += 2; continue
            }
            toks.append(.op(String(ch))); i += 1               // single-char op / paren
        }
        return toks
    }

    private struct Parser {
        let tokens: [Token]; var pos = 0
        var depth = 0                                          // expression-nesting budget — see expression()
        let store: any JSEState; let item: [String: Any]?

        func peek() -> Token? { pos < tokens.count ? tokens[pos] : nil }
        mutating func advance() { pos += 1 }
        func op(_ s: String) -> Bool { if case .op(let o)? = peek() { return o == s }; return false }
        func anyOp(_ list: [String]) -> String? {
            if case .op(let o)? = peek(), list.contains(o) { return o }; return nil
        }

        mutating func expression() -> Any? {
            // a leading `;` is statement residue (a stripped comment's newline) — skip it
            while op(";") { advance() }
            // recursion budget: 500 nested parens must yield nil, never a blown native
            // stack (Swift cannot catch an overflow, so this cap is the ONLY guard; the
            // twins share the 200 value — past it the parse abandons, total not fatal)
            if depth >= 200 { return nil }
            depth += 1
            let v = ternary()
            depth -= 1
            return v
        }

        mutating func ternary() -> Any? {
            let cond = nullish()
            guard op("?") else { return cond }
            advance(); let a = expression()
            if op(":") { advance() }
            let b = expression()
            return truthy(cond) ? a : b
        }
        mutating func nullish() -> Any? {
            var l = logicalOr()
            while op("??") { advance(); let r = logicalOr(); l = JSE.isMissing(l) ? r : l }
            return l
        }
        mutating func logicalOr() -> Any? {
            var l = logicalAnd()
            while op("||") { advance(); let r = logicalAnd(); l = truthy(l) ? l : r }
            return l
        }
        mutating func logicalAnd() -> Any? {
            var l = bitOr()
            while op("&&") { advance(); let r = bitOr(); l = truthy(l) ? r : l }
            return l
        }
        mutating func bitOr() -> Any? {
            var l = bitXor()
            while op("|") { advance(); l = JSE.bitOp(l, bitXor(), "|") }
            return l
        }
        mutating func bitXor() -> Any? {
            var l = bitAnd()
            while op("^") { advance(); l = JSE.bitOp(l, bitAnd(), "^") }
            return l
        }
        mutating func bitAnd() -> Any? {
            var l = equality()
            while op("&") { advance(); l = JSE.bitOp(l, equality(), "&") }
            return l
        }
        mutating func equality() -> Any? {
            // `===`/`!==` share equals(): JSE values are already typed (Bool/Double/String),
            // so the loose/strict distinction has no coercion gap to encode here — but the
            // tokenizer MUST know the three-char forms, else `a !== b` lexes as `a != = b`.
            var l = comparison()
            while let o = anyOp(["===", "!==", "==", "!="]) {
                advance(); let r = comparison(); let eq = equals(l, r); l = o.hasPrefix("!") ? !eq : eq
            }
            return l
        }
        mutating func comparison() -> Any? {
            var l = shift()
            while true {
                if let o = anyOp(["<", "<=", ">", ">="]) { advance(); l = compare(l, shift(), o); continue }
                if case .ident("in")? = peek() {                  // JS `in` — relational level
                    advance(); l = JSE.inOp(l, shift()); continue
                }
                break
            }
            return l
        }
        mutating func shift() -> Any? {
            var l = additive()
            while let o = anyOp(["<<", ">>", ">>>"]) { advance(); l = JSE.bitOp(l, additive(), o) }
            return l
        }
        mutating func additive() -> Any? {
            var l = multiplicative()
            while let o = anyOp(["+", "-"]) { advance(); l = arith(l, multiplicative(), o) }
            return l
        }
        mutating func multiplicative() -> Any? {
            var l = power()
            while let o = anyOp(["*", "/", "%"]) { advance(); l = arith(l, power(), o) }
            return l
        }
        mutating func power() -> Any? {
            let l = unary()
            guard op("**") else { return l }
            advance()
            return JSE.powOp(l, power())                          // right-associative: 2 ** 3 ** 2 = 512
        }
        mutating func unary() -> Any? {
            if op("!") { advance(); return !truthy(unary()) }
            if op("-") { advance(); return -(number(unary()) ?? 0) }
            if op("+") { advance(); return number(unary()) ?? 0 }
            if op("~") { advance(); return JSE.bitNot(unary()) }
            // JS `typeof x` — a reserved unary word (never an author variable), so runtime type
            // branching works on heterogeneous data: 'number'/'string'/'boolean'/'object'/
            // 'function'/'undefined'. `typeof(x)` parses the same way (operator + paren expr).
            if case .ident("typeof")? = peek() { advance(); return JSE.typeofString(unary()) }
            return primary()
        }
        mutating func primary() -> Any? {
            var base = primaryBase()
            // Postfix chaining — JS `arr[i]`, `obj['k']`, `x.length`, and method calls
            // `coll.map(fn)` / `arr.includes(x)`. (Contiguous dotted paths `a.b.c` stay one token.)
            while true {
                if op("[") {
                    advance(); let idx = expression(); if op("]") { advance() }
                    base = JSE.index(base, idx)
                } else if op(".") || op("?.") {
                    // `?.` is pure sugar over the already-total member/index ops (`?.[i]` included)
                    let optional = op("?.")
                    advance()
                    if optional, op("(") {
                        // OPTIONAL CALL `o.f?.(…)` (syntax-005): a nullish callee answers null with
                        // the ARGS UNEVALUATED — the JS rule — and a non-lambda callee answers the
                        // same null where JS would throw, because JSE is total. A lambda callee
                        // falls through to the call-on-value arm below, which consumes the `(`.
                        if base is StackLambda { continue }
                        skipBalanced("(", ")")
                        base = nil
                        continue
                    }
                    if optional, op("[") {
                        advance(); let idx = expression(); if op("]") { advance() }
                        base = JSE.index(base, idx)
                        continue
                    }
                    guard case .ident(let mIdent)? = peek() else { break }
                    var m = mIdent
                    advance()
                    if op("(") {                                  // method call: base.m(args)
                        // a dotted run before the call (`arr[0].items.join(…)` — "items.join"
                        // is ONE ident token): walk the leading segments, dispatch on the last
                        if let dot = m.lastIndex(of: ".") {
                            for seg in m[m.startIndex..<dot].split(separator: ".") { base = JSE.member(base, String(seg)) }
                            m = String(m[m.index(after: dot)...])
                        }
                        advance()
                        if JSE.higherOrderFns.contains(m) {
                            var fn: Any? = nil, initVal: Any? = nil, hasInit = false
                            if !op(")") { fn = expression(); if op(",") { advance(); initVal = expression(); hasInit = true } }
                            if op(")") { advance() }
                            base = JSE.higherOrder(m, base, fn as? StackLambda, store: store, initial: initVal, hasInitial: hasInit)
                        } else {
                            var args: [Any?] = []
                            if !op(")") { pushArg(&args); while op(",") { advance(); pushArg(&args) } }
                            if op(")") { advance() }
                            base = JSE.applyMethod(m, base, args)
                        }
                    } else if m.contains(".") {
                        // `arr[0].x.y` — the postfix member is a dotted RUN; walk each segment
                        for seg in m.split(separator: ".") { base = JSE.member(base, String(seg)) }
                    } else {
                        base = JSE.member(base, m)
                    }
                } else if op("("), let f = base as? StackLambda {
                    // call-on-value: `((x) => x + 1)(4)` / `fs[1](5)` / curried `f(1)(2)` — the
                    // `(` consumes ONLY for a lambda base (a non-lambda keeps the existing
                    // no-consume behavior exactly); same 32-frame guard as the named-call route.
                    advance()
                    var args: [Any?] = []
                    if !op(")") { pushArg(&args); while op(",") { advance(); pushArg(&args) } }
                    if op(")") { advance() }
                    guard store.fnDepth < 32 else { base = nil; continue }
                    store.fnDepth += 1
                    base = JSE.callLambda(f, args, store: store)
                    store.fnDepth -= 1
                } else { break }
            }
            return base
        }

        /// One call argument — `...expr` splices the coerced iterable (call-position spread,
        /// wave 3); shared by every arg-collection loop.
        mutating func pushArg(_ args: inout [Any?]) {
            if op("...") {
                advance()
                for el in JSE.spreadValues(expression()) { args.append(el) }
            } else {
                args.append(expression())
            }
        }
        mutating func primaryBase() -> Any? {
            guard let t = peek() else { return nil }
            switch t {
            case .num(let n): advance(); return n
            case .str(let s): advance(); return s
            case .regex(let pat, let flags):                      // /…/flags → a RegExp value
                advance()
                return ["__regex": true, "source": pat, "flags": flags] as [String: Any]
            case .template(let parts):
                // parts string-coerce and CONCATENATE (never the numeric-first `+`): `${1}${2}` = "12"
                advance()
                var out = ""
                for part in parts {
                    switch part {
                    case .lit(let s): out += s
                    case .expr(let toks):
                        var p = Parser(tokens: toks, store: store, item: item)
                        out += JSE.string(p.expression())
                    }
                }
                return out
            case .ident(let id):
                advance()
                // JS keyword transparency: `new X(…)` calls X (constructors are plain calls here —
                // Uint8Array / TextEncoder / …), and `await expr` in expression position is the
                // value itself (crypto.subtle.* evaluate synchronously under the hood; the spec's
                // `await v` on a non-promise is `v`). Statement-level awaits that genuinely
                // suspend (fetch / dsx.module / crypto.subtle) are matched by the runner first.
                if id == "new" || id == "await" { return primaryBase() }
                if op("=>") { advance(); return arrowBody(params: [LambdaParam(name: id, keys: [])]) }   // x => body (consume `=>`, like tryArrow's paren path)
                if op("(") {
                    // JS statics that take a LAMBDA arg — matched by FULL name before the dotted
                    // split (else `Object` would parse as the collection). `Object.groupBy` is the
                    // ES2024 standard spelling of groupBy; `Array.from(arrayLike, mapFn)` is the
                    // JS repeat-N idiom (`Array.from({ length: 5 }, (_, i) => i)`).
                    if id == "Object.groupBy" || id == "Array.from" {
                        advance()
                        var args: [Any?] = []
                        if !op(")") { pushArg(&args); while op(",") { advance(); pushArg(&args) } }
                        if op(")") { advance() }
                        if id == "Object.groupBy" {
                            return JSE.higherOrder("groupBy", args.first ?? nil, (args.count > 1 ? args[1] : nil) as? StackLambda, store: store)
                        }
                        return JSE.arrayFrom(args, store: store)
                    }
                    // method on a dotted path — `cart.lines.reduce(…)` tokenizes as ONE ident (the
                    // tokenizer keeps dots in names), so split the trailing `.method` off and
                    // dispatch on it (`base.method(args)`); leading method chains start here.
                    if let dot = id.lastIndex(of: "."), !JSECore.handles(id) {   // a JSECore STATIC is never a <base>.method()
                        let method = String(id[id.index(after: dot)...])
                        if JSE.higherOrderFns.contains(method) || JSE.methodFns.contains(method) {
                            let baseVal = lookup(String(id[..<dot]), store: store, item: item)
                            advance()
                            if JSE.higherOrderFns.contains(method) {
                                var fn: Any? = nil, initVal: Any? = nil, hasInit = false
                                if !op(")") { fn = expression(); if op(",") { advance(); initVal = expression(); hasInit = true } }
                                if op(")") { advance() }
                                return JSE.higherOrder(method, baseVal, fn as? StackLambda, store: store, initial: initVal, hasInitial: hasInit)
                            }
                            var args: [Any?] = []
                            if !op(")") { pushArg(&args); while op(",") { advance(); pushArg(&args) } }
                            if op(")") { advance() }
                            return JSE.applyMethod(method, baseVal, args)
                        }
                    }
                    // higher-order with an arrow/expr arg: map(coll, fn) / reduce(coll, fn, init)
                    if JSE.higherOrderFns.contains(id) {
                        advance()
                        let coll = expression()
                        var fn: Any? = nil, initVal: Any? = nil, hasInit = false
                        if op(",") { advance(); fn = expression() }
                        if op(",") { advance(); initVal = expression(); hasInit = true }
                        if op(")") { advance() }
                        return JSE.higherOrder(id, coll, fn as? StackLambda, store: store, initial: initVal, hasInitial: hasInit)
                    }
                    // a SCOPE VALUE that is a lambda is callable: `const f = x => …; f(2)` —
                    // checked before the function table (JS shadowing); same 32-frame guard.
                    // A scope lambda gets the CALLER's live scope as `base` (under its
                    // snapshot), so free names — including the lambda's OWN name, absent from
                    // its creation snapshot — resolve and self-recursion works; user
                    // functions stay store-resolved (no base).
                    // Lookup order: scope lambda → the surface table → the GLOBAL function
                    // library (a surface-local name shadows the global) → builtins.
                    let scopeFn = lookup(id, store: store, item: item)
                    let fromScope = scopeFn is StackLambda
                    if let any = (fromScope ? scopeFn : (store.functions[id] ?? JSE.globalFunctions[id])), let f = any as? StackLambda {
                        advance()
                        var args: [Any?] = []
                        if !op(")") { pushArg(&args); while op(",") { advance(); pushArg(&args) } }
                        if op(")") { advance() }
                        guard store.fnDepth < 32 else { return nil }
                        store.fnDepth += 1
                        let v = JSE.callLambda(f, args, store: store, base: fromScope ? item : nil)
                        store.fnDepth -= 1
                        return v
                    }
                    // built-in: upper(s), round(n), count(x), …
                    advance()
                    var args: [Any?] = []
                    if !op(")") { pushArg(&args); while op(",") { advance(); pushArg(&args) } }
                    if op(")") { advance() }
                    return JSE.apply(id, args)
                }
                switch id {
                case "true": return true
                case "false": return false
                case "null", "nil", "undefined": return nil
                default: return lookup(id, store: store, item: item) ?? JSECore.constant(id)   // Math.PI / Number.MAX_SAFE_INTEGER / Infinity / NaN
                }
            case .op("["):                           // array literal (spread splices in — array/string/Set/Map)
                advance()
                var arr: [Any] = []
                while peek() != nil, !op("]") {
                    if op("...") { advance(); arr.append(contentsOf: JSE.spreadValues(expression())) }
                    else { arr.append(expression() ?? NSNull()) }
                    if op(",") { advance() }
                }
                if op("]") { advance() }
                return arr
            case .op("{"):                           // object literal: { key: expr, … }
                advance()
                var obj: [String: Any] = [:]
                while peek() != nil, !op("}") {
                    if op("...") {                                 // `...dict` merges keys, last-wins
                        advance()
                        if let src = expression() as? [String: Any] {
                            for (k, v) in src { obj[k] = v }
                        }
                        if op(",") { advance() }
                        continue
                    }
                    if op("[") {                                   // computed key `{ [expr]: v }`
                        advance()
                        let ck = JSE.string(expression())
                        if op("]") { advance() }
                        if op(":") { advance(); obj[ck] = expression() ?? NSNull() }
                        else { obj[ck] = NSNull() }                // `{ [k] }` is not shorthand — no name to read
                        if op(",") { advance() }
                        continue
                    }
                    let key: String
                    switch peek() {
                    case .ident(let k)?: key = k; advance()
                    case .str(let k)?:   key = k; advance()
                    case .num(let k)?:   key = JSE.string(k); advance()
                    default: advance(); continue
                    }
                    if op(":") { advance(); obj[key] = expression() ?? NSNull() }
                    else { obj[key] = lookup(key, store: store, item: item) ?? NSNull() }   // JS shorthand { id } == { id: id }
                    if op(",") { advance() }
                }
                if op("}") { advance() }
                return obj
            case .op("("):
                if let lam = tryArrow() { return lam }            // (a, {x,y}) => body
                advance(); let v = expression(); if op(")") { advance() }; return v
            default: advance(); return nil
            }
        }

        /// `(params) => body` — detected by an `=>` after the matching `)`. Parses params (names
        /// and `{a,b}` destructuring) and captures the body as a `StackLambda` value. A named
        /// param takes an optional `= default` (call-time, callee scope) and a `...rest` binds
        /// the remaining args as an array; destructured params take neither (wave 3).
        mutating func tryArrow() -> Any? {
            var d = 0, j = pos
            while j < tokens.count {
                if case .op("(") = tokens[j] { d += 1 }
                else if case .op(")") = tokens[j] { d -= 1; if d == 0 { break } }
                j += 1
            }
            guard j + 1 < tokens.count, case .op("=>") = tokens[j + 1] else { return nil }
            advance()                                              // '('
            var params: [LambdaParam] = []
            while !op(")"), peek() != nil {
                if op("{") || op("[") {
                    // ONE pattern reader for params and declarations alike — a destructured
                    // param must not mean something different from the same shape in a `const`.
                    let group = balancedGroup()
                    let decls = JSE.parseDeclarators(group)
                    params.append(LambdaParam(name: nil, keys: [], pattern: decls.first?.pattern))
                } else if op("...") {
                    // rest param — binds the remaining args as an array
                    advance()
                    if case .ident(let n)? = peek() { advance(); params.append(LambdaParam(name: n, keys: [], rest: true)) } else { advance() }
                } else if case .ident(let n)? = peek() {
                    advance()
                    var def: [Token]? = nil
                    if op("=") { advance(); def = defaultTokens() }     // call-time default
                    params.append(LambdaParam(name: n, keys: [], def: def))
                } else { advance() }
                if op(",") { advance() }
            }
            if op(")") { advance() }
            if op("=>") { advance() }
            return arrowBody(params: params)
        }
        /// Capture one arrow-param default's tokens — to the next top-level `,` or the params'
        /// closing `)` (nested brackets stay whole).
        /// Skip past one balanced group WITHOUT evaluating anything inside — the optional-call
        /// short-circuit, where JS specifies the arguments are never evaluated.
        mutating func skipBalanced(_ open: String, _ close: String) {
            guard op(open) else { return }
            var d = 0
            while let tk = peek() {
                if case .op(let o) = tk {
                    if o == open { d += 1 }
                    else if o == close { d -= 1; if d == 0 { advance(); return } }
                }
                advance()
            }
        }

        /// Capture a balanced `{…}` / `[…]` group INCLUDING its brackets — the twin of the
        /// TS/Kotlin parsers', so destructured params read through the one pattern parser.
        mutating func balancedGroup() -> [Token] {
            var out: [Token] = []
            var d = 0
            while true {
                guard let tk = peek() else { break }
                if case .op(let o) = tk {
                    if o == "{" || o == "[" || o == "(" { d += 1 }
                    else if o == "}" || o == "]" || o == ")" { d -= 1 }
                }
                out.append(tk)
                advance()
                if d == 0 { break }
            }
            return out
        }

        mutating func defaultTokens() -> [Token] {
            var body: [Token] = []; var d = 0
            while let tk = peek() {
                if case .op(let o) = tk {
                    if o == "(" || o == "[" || o == "{" { d += 1 }
                    else if o == ")" || o == "]" || o == "}" { if d == 0 { break }; d -= 1 }
                    else if d == 0, o == "," { break }
                }
                body.append(tk); advance()
            }
            return body
        }
        /// After `=>`: capture the body — a `{ }` block or one expression — as a StackLambda value.
        mutating func arrowBody(params: [LambdaParam]) -> Any? {
            if op("{") {
                advance()
                var body: [Token] = []; var d = 1
                while let tk = peek() {
                    if case .op("{") = tk { d += 1 }
                    else if case .op("}") = tk { d -= 1; if d == 0 { advance(); break } }
                    body.append(tk); advance()
                }
                return StackLambda(params: params, body: body, block: true, captured: item ?? [:])
            }
            var body: [Token] = []; var d = 0
            while let tk = peek() {
                if case .op(let o) = tk {
                    if o == "(" || o == "[" || o == "{" { d += 1 }
                    else if o == ")" || o == "]" || o == "}" { if d == 0 { break }; d -= 1 }
                    else if d == 0, o == "," { break }
                }
                body.append(tk); advance()
            }
            return StackLambda(params: params, body: body, block: false, captured: item ?? [:])
        }
    }

    /// Coerce any stored collection (`[Any]` or `[[String:Any]]`) to `[Any]` for the
    /// collection functions / array verbs.
    static func asArray(_ v: Any?) -> [Any] {
        if let a = v as? [Any] { return a }
        if let a = v as? [[String: Any]] { return a.map { $0 as Any } }
        return []
    }

    /// Coerce any stored/evaluated collection to ROW form (`[[String:Any]]`) — the lenient
    /// counterpart to `asArray`, for `<list>`/`<grid>`/`store.list`. `.map`/`filter`/array
    /// literals yield `[Any]` (see line `case "map"`), so a *strict* `as? [[String:Any]]`
    /// silently drops EVERY row when the array is `[Any]`-typed even though its elements are
    /// dicts — the cause of "truthy `.length` but zero rendered rows". Funnel element-wise
    /// instead: non-dict / `NSNull` elements drop (matching the strict cast's intent for
    /// malformed rows), real rows survive. The fast path (already `[[String:Any]]`) is unchanged.
    static func asRows(_ v: Any?) -> [[String: Any]] {
        if let rows = v as? [[String: Any]] { return rows }
        if let arr = v as? [Any] { return arr.compactMap { $0 as? [String: Any] } }
        return []
    }

    /// JS `base[idx]` — numeric index into an array (bounds-checked), or string key into an object.
    static func index(_ base: Any?, _ idx: Any?) -> Any? {
        if let n = number(idx).map({ Int($0) }) {
            let arr = asArray(base)
            return (n >= 0 && n < arr.count) ? arr[n] : nil
        }
        return (base as? [String: Any])?[string(idx)]
    }
    /// JS `base.member` (postfix) — `.length` on an array/string, else an object key.
    static func member(_ base: Any?, _ m: String) -> Any? {
        if m == "length" {
            if let s = base as? String { return Double(s.count) }
            if base is [Any] || base is [[String: Any]] { return Double(asArray(base).count) }
        }
        return (base as? [String: Any])?[m]
    }

    /// Bounded higher-order collection functions — JS `map`/`filter`/`reduce`/… . Each iterates a
    /// FINITE collection exactly once (total — guaranteed to terminate), invoking the **arrow
    /// function** `fn` per element: `map(coll, x => …)` · `coll.filter(p => …)` · `reduce(coll,
    /// (acc, x) => …, init)`. The 2nd arg through `index` is passed too (`(x, i) => …`). No
    /// unbounded computation — composes via nesting.
    static let higherOrderFns: Set<String> = ["filter", "reject", "map", "find", "some", "every", "sortBy", "sumBy", "reduce", "forEach",
                                              "sort", "flatMap", "findIndex", "groupBy", "keyBy",
                                              "findLast", "findLastIndex", "reduceRight", "toSorted"]
    static let methodFns: Set<String> = ["includes", "indexOf", "join", "reverse", "slice", "toUpperCase", "toLowerCase", "trim",
                                         "startsWith", "endsWith", "localeCompare",
                                         "toString", "padStart", "padEnd", "toHex", "toBase64", "encode", "decode",
                                         // JS core objects (URL/Date/Intl/fetch companions — see JSECore)
                                         "get", "getAll", "has", "set", "append", "delete", "format", "json", "text", "abort",
                                         "getTime", "toISOString", "toJSON", "getFullYear", "getMonth", "getDate", "getDay",
                                         "getHours", "getMinutes", "getSeconds", "getMilliseconds",
                                         "getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCDay", "getUTCHours",
                                         "getUTCMinutes", "getUTCSeconds", "getUTCMilliseconds", "getTimezoneOffset",
                                         "setTime", "setFullYear", "setMonth", "setDate", "setHours", "setMinutes",
                                         "setSeconds", "setMilliseconds",
                                         "toLocaleDateString", "toLocaleTimeString", "toLocaleString",
                                         "flat", "concat", "at", "add",
                                         "test", "match", "replace", "replaceAll", "split", "search",
                                         "repeat", "substring", "lastIndexOf", "trimStart", "trimEnd", "charAt", "charCodeAt",
                                         "codePointAt", "normalize", "matchAll", "fill", "toReversed", "with", "toSpliced",
                                         "pop", "shift",
                                         "entries", "keys", "values", "toFixed"]
    private static func higherOrder(_ id: String, _ coll: Any?, _ fn: StackLambda?, store: any JSEState, initial: Any? = nil, hasInitial: Bool = false) -> Any? {
        let arr = asArray(coll)
        func call(_ args: [Any?]) -> Any? { guard let fn else { return nil }; return callLambda(fn, args, store: store) }
        switch id {
        case "map":     return arr.enumerated().map { call([$0.element, Double($0.offset)]) ?? NSNull() }
        case "filter":  return arr.enumerated().filter { truthy(call([$0.element, Double($0.offset)])) }.map { $0.element }
        case "reject":  return arr.enumerated().filter { !truthy(call([$0.element, Double($0.offset)])) }.map { $0.element }
        case "find":    return arr.enumerated().first { truthy(call([$0.element, Double($0.offset)])) }?.element
        case "some":    return arr.enumerated().contains { truthy(call([$0.element, Double($0.offset)])) }
        case "every":   return arr.enumerated().allSatisfy { truthy(call([$0.element, Double($0.offset)])) }
        case "forEach": for (o, e) in arr.enumerated() { _ = call([e, Double(o)]) }; return nil
        case "sumBy":   return arr.enumerated().reduce(0.0) { $0 + (number(call([$1.element, Double($1.offset)])) ?? 0) }
        case "sortBy":
            // sortBy(coll, fn[, 'desc']) — ascending by default; the optional 3rd arg flips the
            // comparator (not a post-reverse, so equal keys keep source order in both directions).
            let desc = hasInitial && string(initial) == "desc"
            return arr.enumerated().sorted { l, r in
                let x = call([l.element, Double(l.offset)]), y = call([r.element, Double(r.offset)])
                if let nx = number(x), let ny = number(y) { return desc ? ny < nx : nx < ny }
                return desc ? string(y) < string(x) : string(x) < string(y)
            }.map { $0.element }
        case "groupBy":   // groupBy(coll, fn) → { key: [elements] } — bounded single pass (sectioned lists)
            var groups: [String: Any] = [:]
            for (o, e) in arr.enumerated() {
                let k = string(call([e, Double(o)]))
                var bucket = (groups[k] as? [Any]) ?? []
                bucket.append(e); groups[k] = bucket
            }
            return groups
        case "keyBy":     // keyBy(coll, fn) → { key: element } — last wins (O(1) lookup tables)
            var keyed: [String: Any] = [:]
            for (o, e) in arr.enumerated() { keyed[string(call([e, Double(o)]))] = e }
            return keyed
        case "reduce":
            var acc: Any? = hasInitial ? initial : arr.first
            var k = hasInitial ? 0 : 1
            while k < arr.count { acc = call([acc, arr[k], Double(k)]); k += 1 }
            return acc
        case "sort":      // JS sort: comparator (a,b) → number; none → lexicographic. Returns a sorted COPY (value semantics).
            return sortedArray(arr, comparator: fn, store: store)
        case "flatMap":   // map, then flatten one level
            return arr.enumerated().flatMap { pair -> [Any] in
                let v = call([pair.element, Double(pair.offset)]) ?? NSNull()
                return (v as? [Any]) ?? [v]
            }
        case "findIndex":
            return Double(arr.enumerated().first { truthy(call([$0.element, Double($0.offset)])) }?.offset ?? -1)
        case "findLast":
            for i in stride(from: arr.count - 1, through: 0, by: -1) where truthy(call([arr[i], Double(i)])) { return arr[i] }
            return nil
        case "findLastIndex":
            for i in stride(from: arr.count - 1, through: 0, by: -1) where truthy(call([arr[i], Double(i)])) { return Double(i) }
            return Double(-1)
        case "reduceRight":
            var acc: Any? = hasInitial ? initial : arr.last
            var k = hasInitial ? arr.count - 1 : arr.count - 2
            while k >= 0 { acc = call([acc, arr[k], Double(k)]); k -= 1 }
            return acc
        case "toSorted":   // JS ES2023 — sort was already a copy here
            return sortedArray(arr, comparator: fn, store: store)
        default: return nil
        }
    }
    /// JS `Array.from` — 1:1: an array (copied), or the `{ length: n }` array-like, with an
    /// optional `(x, i) => …` mapFn. `Array.from({ length: 5 }, (_, i) => i)` is the standard
    /// JS repeat-N idiom (`range(a, b)` is the prefix convenience over the same ladder; both
    /// cap at 10 000 — bounded like all of JSE). Any other input falls through to the crypto
    /// companion (`Array.from(new Uint8Array(hash))` — bytes ride as plain number arrays).
    private static func arrayFrom(_ a: [Any?], store: any JSEState) -> Any? {
        let src = a.first ?? nil
        var items: [Any]
        if let arr = src as? [Any] { items = arr }
        else if let d = src as? [String: Any], d.count == 1, let len = number(d["length"]), len.isFinite {
            items = Array(repeating: NSNull(), count: Swift.max(0, Swift.min(Int(len), 10_000)))
        } else { return JSECrypto.call("Array.from", a) }
        guard a.count > 1, let fn = a[1] as? StackLambda else { return items }
        return items.enumerated().map { callLambda(fn, [$0.element, Double($0.offset)], store: store) ?? NSNull() }
    }

    /// JS Array.prototype.sort semantics, shared by the expression form and the statement
    /// mutation (`arr.sort()` / `arr.sort((a, b) => …)`).
    static func sortedArray(_ arr: [Any], comparator: Any?, store: any JSEState) -> [Any] {
        if let fn = comparator as? StackLambda {
            return arr.sorted { (number(callLambda(fn, [$0, $1], store: store)) ?? 0) < 0 }
        }
        return arr.sorted { string($0) < string($1) }
    }

    /// JS array/string methods called method-style: `arr.includes(x)` · `.indexOf(x)` · `.join(sep)`
    /// · `.reverse()` · `.slice(n)` · `s.toUpperCase()` / `.toLowerCase()` / `.trim()`.
    static func applyMethod(_ m: String, _ base: Any?, _ a: [Any?]) -> Any? {
        // JS core objects first (URL/searchParams get·set, Date getters, Intl format, res.json()…):
        // JSECore claims the call only for ITS dict shapes, so plain values fall through below.
        if let handled = JSECore.method(m, base, a) { return handled.value }
        switch m {
        case "includes":    return asArray(base).contains { equals($0, a.first ?? nil) } || string(base).contains(string(a.first ?? nil))
        case "indexOf":
            if let s = base as? String {              // JS String.indexOf — first match or -1 (Character offset, like .length/.at)
                let needle = string(a.first ?? nil)
                if needle.isEmpty { return 0.0 }
                guard let r = s.range(of: needle) else { return -1.0 }
                return Double(s.distance(from: s.startIndex, to: r.lowerBound))
            }
            return Double(asArray(base).firstIndex { equals($0, a.first ?? nil) } ?? -1)
        case "localeCompare":
            // The comparator half of string sorting: -1/0/1, ordering by the platform's
            // collation. Twins: jse.ts / Jse.kt applyMethod "localeCompare".
            let lhs = JSE.string(base)
            let rhs = JSE.string(a.first ?? nil)
            return lhs == rhs ? 0.0 : (lhs < rhs ? -1.0 : 1.0)
        case "startsWith":  return string(base).hasPrefix(string(a.first ?? nil))
        case "endsWith":    return string(base).hasSuffix(string(a.first ?? nil))
        case "join":
            let sep = (a.first ?? nil).map { string($0) } ?? ","
            return asArray(base).map { string($0) }.joined(separator: sep)
        case "reverse":     return Array(asArray(base).reversed())
        case "slice":       // full JS slice(start[, end]) — negatives count from the end; arrays AND strings
            func bound(_ v: Double?, _ len: Int, _ def: Int) -> Int {
                guard let v, v.isFinite else { return def }
                let i = Int(Swift.min(Swift.max(v, -9.0e15), 9.0e15))
                return i < 0 ? Swift.max(len + i, 0) : Swift.min(i, len)
            }
            if let s = base as? String {
                let chars = Array(s)                  // Characters — matches .length/.at grapheme semantics
                let lo = bound(number(a.first ?? nil), chars.count, 0)
                let hi = bound(a.count > 1 ? number(a[1]) : nil, chars.count, chars.count)
                return lo < hi ? String(chars[lo..<hi]) : ""
            }
            let arr = asArray(base)
            let lo = bound(number(a.first ?? nil), arr.count, 0)
            let hi = bound(a.count > 1 ? number(a[1]) : nil, arr.count, arr.count)
            return lo < hi ? Array(arr[lo..<hi]) : [Any]()
        case "toUpperCase": return string(base).uppercased()
        case "toLowerCase": return string(base).lowercased()
        case "trim":        return string(base).trimmingCharacters(in: .whitespaces)
        case "flat":        // arr.flat([depth]) — flatten nested arrays (default depth 1; Infinity = full)
            let rawDepth = number(a.first ?? nil) ?? 1
            let depth = rawDepth.isFinite ? safeInt(rawDepth) : 512   // clamped — Int(1e19) would trap
            func flatten(_ v: [Any], _ d: Int) -> [Any] {
                v.flatMap { e -> [Any] in
                    if let sub = e as? [Any], d > 0 { return flatten(sub, d - 1) }
                    return [e]
                }
            }
            return flatten(asArray(base), depth)
        case "concat":      // arr.concat(b, c, …) — arrays splice in, scalars append (a COPY)
            var out = asArray(base)
            for v in a { if let sub = v as? [Any] { out.append(contentsOf: sub) } else if let v { out.append(v) } }
            return out
        case "at":          // arr.at(-1) — negative indices from the end (arrays + strings)
            let i = safeInt(number(a.first ?? nil) ?? 0)       // clamped — Int(∞/NaN) would trap
            if let str = base as? String {
                let idx = i < 0 ? str.count + i : i
                guard idx >= 0, idx < str.count else { return nil }
                return String(str[str.index(str.startIndex, offsetBy: idx)])
            }
            let arr = asArray(base)
            let idx = i < 0 ? arr.count + i : i
            return arr.indices.contains(idx) ? arr[idx] : nil
        case "match":       return JSERegex.match(string(base), a.first ?? nil)
        case "search":      return JSERegex.search(string(base), a.first ?? nil)
        case "replace":     return JSERegex.replace(string(base), a.first ?? nil, template: string(a.count > 1 ? a[1] : nil), all: false)
        case "replaceAll":  return JSERegex.replace(string(base), a.first ?? nil, template: string(a.count > 1 ? a[1] : nil), all: true)
        case "split":
            let limit = a.count > 1 ? safeInt(number(a[1]) ?? 0) : 0   // clamped — Int(∞/NaN) would trap
            return JSERegex.split(string(base), a.first ?? nil, limit: limit)
        case "toString":    // n.toString(16) — radix form (the Web Crypto hex idiom); default = string()
            if let radix = number(a.first ?? nil).map({ Int($0) }), (2...36).contains(radix), radix != 10,
               let v = number(base) { return String(Int(v), radix: radix) }
            return string(base)
        case "padStart", "padEnd":     // s.padStart(2, '0') — the other half of the hex idiom
            let len = Swift.min(safeInt(number(a.first ?? nil) ?? 0), 10_000)   // bounded like repeat (Infinity saturates)
            let pad = a.count > 1 ? string(a[1]) : " "
            var str = string(base)
            guard !pad.isEmpty, str.count < len else { return str }
            var fill = ""
            while fill.count + str.count < len { fill += pad }
            fill = String(fill.prefix(len - str.count))
            str = (m == "padStart") ? fill + str : str + fill
            return str
        case "toHex":       return JSECrypto.data(base)?.map { String(format: "%02x", $0) }.joined()
        case "toBase64":    return JSECrypto.data(base)?.base64EncodedString()
        case "encode":      // (new TextEncoder()).encode(str) → UTF-8 byte array
            if (base as? [String: Any])?["__textEncoder"] != nil { return JSECrypto.bytes(Data(string(a.first ?? nil).utf8)) }
            return nil
        case "decode":      // (new TextDecoder()).decode(bytes) → string
            if (base as? [String: Any])?["__textDecoder"] != nil, let d = JSECrypto.data(a.first ?? nil) {
                return String(data: d, encoding: .utf8) ?? ""
            }
            return nil
        case "repeat":
            let n = max(0, min(Int(safeInt(number(a.first ?? nil) ?? 0)), 10_000))
            return String(repeating: string(base), count: n)
        case "substring":
            let chars = Array(string(base))
            func clamp(_ v: Double?) -> Int {
                guard let v, !v.isNaN else { return 0 }
                return max(0, min(Int(safeInt(v)), chars.count))
            }
            var lo = clamp(number(a.first ?? nil))
            var hi = a.count > 1 ? clamp(number(a[1])) : chars.count
            if lo > hi { swap(&lo, &hi) }
            return String(chars[lo..<hi])
        case "lastIndexOf":
            if let s = base as? String {
                let h = Array(s)
                let nd = Array(string(a.first ?? nil))
                if nd.isEmpty { return Double(h.count) }
                if h.count >= nd.count {
                    for i in stride(from: h.count - nd.count, through: 0, by: -1) {
                        var ok = true
                        for j in 0..<nd.count where h[i + j] != nd[j] { ok = false; break }
                        if ok { return Double(i) }
                    }
                }
                return Double(-1)
            }
            let arr = asArray(base)
            for i in stride(from: arr.count - 1, through: 0, by: -1) where equals(arr[i], a.first ?? nil) { return Double(i) }
            return Double(-1)
        case "trimStart":
            var view = Substring(string(base))
            while let f = view.first, f == "\t" || f.isWhitespace && !f.isNewline { view = view.dropFirst() }
            return String(view)
        case "trimEnd":
            var view = Substring(string(base))
            while let l = view.last, l == "\t" || l.isWhitespace && !l.isNewline { view = view.dropLast() }
            return String(view)
        case "charAt":
            let chars = Array(string(base))
            let i = Int(safeInt(number(a.first ?? nil) ?? 0))
            return i >= 0 && i < chars.count ? String(chars[i]) : ""
        case "charCodeAt", "codePointAt":
            // the CODE POINT of the i-th grapheme's first scalar — JSE has no UTF-16 halves
            let chars = Array(string(base))
            let i = Int(safeInt(number(a.first ?? nil) ?? 0))
            guard i >= 0, i < chars.count, let sc = chars[i].unicodeScalars.first else { return nil }
            return Double(sc.value)
        case "normalize":
            let form = a.isEmpty ? "NFC" : string(a[0])
            let s = string(base)
            switch form {
            case "NFC": return s.precomposedStringWithCanonicalMapping
            case "NFD": return s.decomposedStringWithCanonicalMapping
            case "NFKC": return s.precomposedStringWithCompatibilityMapping
            case "NFKD": return s.decomposedStringWithCompatibilityMapping
            default: return s
            }
        case "matchAll":    return JSERegex.matchAll(string(base), a.first ?? nil)
        case "fill":
            var arr = asArray(base)
            func bound(_ v: Double?, _ def: Int) -> Int {
                guard let v, v.isFinite else { return def }
                let i = Int(safeInt(v))
                return i < 0 ? max(arr.count + i, 0) : min(i, arr.count)
            }
            let v: Any = a.isEmpty ? NSNull() : (a[0] ?? NSNull())
            let lo = bound(a.count > 1 ? number(a[1]) : nil, 0)
            let hi = bound(a.count > 2 ? number(a[2]) : nil, arr.count)
            if lo < hi { for i in lo..<hi { arr[i] = v } }
            return arr
        case "toReversed":  return Array(asArray(base).reversed())
        // JS pop()/shift() mutate; JSE values are value-typed on the native runtimes, so
        // the JSE spelling is the PURE read (the toReversed/toSpliced family's law): last/
        // first element out, receiver untouched. Corpus: stdlib-002.
        case "pop":         return asArray(base).last
        case "shift":       return asArray(base).first
        case "with":
            var arr = asArray(base)
            var i = Int(safeInt(number(a.first ?? nil) ?? 0))
            if i < 0 { i += arr.count }
            if i >= 0 && i < arr.count { arr[i] = a.count > 1 ? (a[1] ?? NSNull()) : NSNull() }
            return arr
        case "toSpliced":
            var arr = asArray(base)
            let start = max(0, min(Int(safeInt(number(a.first ?? nil) ?? 0)), arr.count))
            let del = a.count > 1 ? max(Int(safeInt(number(a[1]) ?? 0)), 0) : arr.count - start
            let removed = min(del, arr.count - start)
            arr.removeSubrange(start..<(start + removed))
            arr.insert(contentsOf: a.dropFirst(2).map { $0 ?? NSNull() }, at: start)
            return arr
        case "entries":     return asArray(base).enumerated().map { [Double($0.offset), $0.element] as [Any] }
        case "keys":        return asArray(base).enumerated().map { Double($0.offset) }
        case "values":      return asArray(base)
        case "toLocaleString":
            // NUMBER grouping (corpus stdlib-002): deterministic en-US-style thousands
            // separators over the JSE string of the value — hand-rolled, so no platform
            // locale reaches it and three renderers print one string. Date dicts keep
            // the real locale formatting below; any other receiver keeps the null law.
            if let v = number(base), !(base is [String: Any]) {
                let txt = string(v)
                let neg = txt.hasPrefix("-")
                let bare = neg ? String(txt.dropFirst()) : txt
                let parts = bare.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
                let whole = String(parts[0])
                let frac = parts.count > 1 ? "." + String(parts[1]) : ""
                var grouped = ""
                for (k, ch) in whole.enumerated() {
                    if k > 0 && (whole.count - k) % 3 == 0 { grouped.append(",") }
                    grouped.append(ch)
                }
                return (neg ? "-" : "") + grouped + frac
            }
            return nil                                            // non-number receivers keep the old path (dates intercept earlier)
        case "toFixed":
            guard let v = number(base), v.isFinite else { return string(base) }
            if abs(v) >= 9007199254740992.0 { return string(v) }   // past 2^53 fraction digits are noise — the plain coercion
            let places = max(0, min(Int(safeInt(number(a.first ?? nil) ?? 0)), 100))
            let shift = pow(10.0, Double(places))
            let scaled = abs(v) * shift
            let f = scaled.rounded(.down)
            let r = scaled - f >= 0.5 ? f + 1 : f                  // half away from zero (JSE round)
            let whole = (r / shift).rounded(.down)
            var out = string(whole)
            if places > 0 {
                let frac = String(string(r - whole * shift))
                out += "." + String(repeating: "0", count: max(0, places - frac.count)) + frac
            }
            return (v < 0 && r > 0 ? "-" : "") + out
        default:            return nil
        }
    }

    // MARK: value ops

    static func number(_ v: Any?) -> Double? {
        switch v {
        case let d as Double: return d
        case let i as Int: return Double(i)
        case let b as Bool: return b ? 1 : 0
        case let n as NSNumber: return n.doubleValue
        case let s as String: return Double(s)
        case let d as [String: Any]: return d["__date"] as? Double   // JS Date coerces to its ms (sort/diff/compare)
        default: return nil
        }
    }

    /// Pure built-in functions for `{{ … }}` — string, number, and a couple of helpers.
    /// No side effects, no I/O (keeps the evaluator safe + non-blocking). e.g.
    /// `{{ upper(name) }}`, `{{ round(price) }}`, `{{ pad(mins,2) }}:{{ pad(secs,2) }}`.
    static func apply(_ name: String, _ a: [Any?]) -> Any? {
        func s(_ i: Int) -> String { i < a.count ? string(a[i]) : "" }
        func n(_ i: Int) -> Double { i < a.count ? (number(a[i]) ?? 0) : 0 }
        // Web Crypto + its companion globals (Uint8Array / TextEncoder / TextDecoder /
        // Array.from / btoa / atob) — the 1:1 JS surface, mapped to CryptoKit/CommonCrypto/
        // SecKey. Dotted callees arrive as one name ("crypto.subtle.digest").
        if name.hasPrefix("crypto.") || name == "Uint8Array" || name.hasPrefix("Uint8Array.")
            || name == "TextEncoder" || name == "TextDecoder" || name == "Array.from"
            || name == "btoa" || name == "atob" {
            return JSECrypto.call(name, a)
        }
        // The JS core globals (URL / Date / Intl / JSON / Math / Blob / FormData / …) —
        // generic computation, 1:1 syntax, native under the hood. See JSECore below.
        if JSECore.handles(name) { return JSECore.call(name, a) }
        switch name {
        // SOURCE, DRAWN. The `<code>` surface needs token spans in markup, and a page cannot
        // reach the scanner any other way - so the kernel exposes it instead of every caller
        // shipping a fourth tokenizer. Pure: text in, rows of spans out.
        case "highlight":          return Highlight.jseValue(s(0))
        case "upper":              return s(0).uppercased()
        case "lower":              return s(0).lowercased()
        case "cap", "capitalize":  return s(0).capitalized
        case "trim":               return s(0).trimmingCharacters(in: .whitespaces)
        case "len", "count":
            if let arr = (a.first ?? nil) as? [Any] { return Double(arr.count) }
            return Double(s(0).count)
        case "abs":                return Swift.abs(n(0))
        case "round":              return n(0).rounded()
        case "floor":              return n(0).rounded(.down)
        case "ceil":               return n(0).rounded(.up)
        case "min":                return Swift.min(n(0), n(1))
        case "max":                return Swift.max(n(0), n(1))
        case "int":                return Double(safeInt(n(0)))
        case "pad":                return String(format: "%0\(Swift.min(Swift.max(safeInt(n(1)), 0), 64))d", safeInt(n(0)))   // zero-pad to width (clamped)
        case "mmss", "clock":      // seconds → "m:ss" (or "h:mm:ss" past an hour); negatives keep the sign (e.g. "-3:21")
            let total = safeInt(n(0)), neg = total < 0, t = Swift.abs(total)
            let body = t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, (t % 3600) / 60, t % 60)
                                 : String(format: "%d:%02d", t / 60, t % 60)
            return neg ? "-" + body : body
        case "if":                 return truthy(a.first ?? nil) ? (a.count > 1 ? a[1] : nil) : (a.count > 2 ? a[2] : nil)
        case "typeof":             return typeofString(a.first ?? nil)   // function spelling of the unary operator (rarely reached — the operator form consumes `typeof(x)` too)
        case "Array.isArray":      return ((a.first ?? nil) as? [Any]) != nil || ((a.first ?? nil) as? [[String: Any]]) != nil
        case "range":
            // range(n) / range(a, b) / range(a, b, step) → the half-open number ladder [a, a+step, …)
            // — the declarative repeat-N driver (`<list bind="range(1, 8)">`). Bounded like all of
            // JSE: capped at 10 000 elements, step 0 / non-finite input yields [].
            var lo = 0.0, hi = n(0), step = 1.0
            if a.count >= 2 { lo = n(0); hi = n(1) }
            if a.count >= 3 { step = n(2) }
            guard step != 0, lo.isFinite, hi.isFinite, step.isFinite else { return [Any]() }
            var ladder: [Any] = []; var v = lo
            while (step > 0 ? v < hi : v > hi), ladder.count < 10_000 { ladder.append(v); v += step }
            return ladder
        case "String.fromCharCode":
            var units: [UInt16] = []
            for c in a {
                let code = Int(safeInt(number(c) ?? 0))
                if code >= 0 && code <= 0x10FFFF { units.append(UInt16(truncatingIfNeeded: code)) }
            }
            return String(utf16CodeUnits: units, count: units.count)
        case "Array.of":           return a.map { $0 ?? NSNull() }
        case "Number.isInteger", "Number.isFinite", "Number.isSafeInteger", "Number.isNaN":
            // STRICT (no coercion): only a real number qualifies — never a bool/string
            guard let nn = (a.first ?? nil) as? NSNumber, nn !== kCFBooleanTrue, nn !== kCFBooleanFalse else { return false }
            let d = nn.doubleValue
            switch name {
            case "Number.isInteger": return d.isFinite && d.rounded(.towardZero) == d
            case "Number.isFinite": return d.isFinite
            case "Number.isSafeInteger": return d.isFinite && d.rounded(.towardZero) == d && abs(d) <= 9007199254740991.0
            default: return d.isNaN
            }
        case "Number.parseInt":    return JSECore.call("parseInt", a)
        case "Number.parseFloat":  return JSECore.call("parseFloat", a)
        case "matches":            return DSXPathMatch.matches(s(0), s(1))   // route-path match: * / {param} / :param
        case "has":
            // Capability check — is the named package in THIS build? The callable twin of
            // visible-if="has:scheme" (usable anywhere an expression runs: {{ }}, on:*, computed).
            #if os(watchOS)
            // Satellite node: ModuleRegistry doesn't compile here — the node's capability
            // truth is the relay table (watch-runtime.md W4; DSXNodeCalls rides StackLive.swift
            // in this target): a scheme is "available" when any of its actions may relay.
            let scheme = s(0)
            return DSXNodeCalls.relayTable.contains { $0.hasPrefix(scheme + ".") }
            #else
            return ModuleRegistry.shared.isAvailable(s(0))
            #endif
        // ── collection utilities (bounded, total — no per-element predicate) ──
        case "first":              return JSE.asArray(a.first ?? nil).first
        case "last":               return JSE.asArray(a.first ?? nil).last
        case "reverse":            return Array(JSE.asArray(a.first ?? nil).reversed())
        case "sum":                return JSE.asArray(a.first ?? nil).reduce(0.0) { $0 + (number($1) ?? 0) }
        case "join":               return JSE.asArray(a.first ?? nil).map { string($0) }.joined(separator: a.count > 1 ? s(1) : ", ")
        case "contains":           return JSE.asArray(a.first ?? nil).contains { string($0) == s(1) }
        case "keys":               return ((a.first ?? nil) as? [String: Any]).map { Array($0.keys) }
        case "values":             return ((a.first ?? nil) as? [String: Any]).map { Array($0.values) }
        // ── form validators (pure predicates → Bool; compose in a computed `errors` block) ──
        case "required":
            let v = a.first ?? nil
            if let arr = v as? [Any] { return !arr.isEmpty }
            if let str = v as? String { return !str.trimmingCharacters(in: .whitespaces).isEmpty }
            return truthy(v)
        case "minLength":          return (((a.first ?? nil) as? [Any])?.count ?? s(0).count) >= safeInt(n(1))
        case "maxLength":          return (((a.first ?? nil) as? [Any])?.count ?? s(0).count) <= safeInt(n(1))
        case "regex":              return JSERegex.reDoSProne(s(1)) ? false : (s(0).range(of: s(1), options: .regularExpression) != nil)
        case "email":              return s(0).range(of: #"^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$"#, options: [.regularExpression, .caseInsensitive]) != nil
        case "phone":              return s(0).range(of: #"^[+]?[0-9 ()\-]{7,}$"#, options: .regularExpression) != nil
        case "url":
            if let u = URLComponents(string: s(0)), let sch = u.scheme, !sch.isEmpty, u.host != nil { return true }
            return false
        default:                   return nil
        }
    }

    /// Double → Int without trapping on NaN / ±inf / out-of-range values (every numeric
    /// here is author-controllable via `{{ }}`, so a stray huge/NaN value must not crash).
    /// NaN → 0; ±Infinity SATURATES to ±9.0e18 (so `substring(0, Infinity)` / `toSpliced`
    /// clamp toward "the end", never toward index 0) — the TS/Kotlin safeInt contract.
    private static func safeInt(_ d: Double) -> Int {
        guard !d.isNaN else { return 0 }
        return Int(Swift.min(Swift.max(d, -9.0e18), 9.0e18))   // within Int64 range
    }
    static func equals(_ a: Any?, _ b: Any?) -> Bool {   // internal: JSECore's Map/Set share it
        // The scope sentinel reads as null here: a bound-but-null lambda param / const /
        // destructured key is stored as NSNull, and `x == null` is the guard every author
        // writes. Without this the sentinel fell through to string coercion ("<null>" != "")
        // and the guard was silently false. Null equals only null — includes/indexOf/switch/
        // Map/Set all ride this function, so they inherit the law. Corpus: core-002.
        let aNil = a == nil || a is NSNull
        let bNil = b == nil || b is NSNull
        if aNil || bNil { return aNil && bNil }
        if let x = number(a), let y = number(b) { return x == y }
        // Structural equality for plain dicts/arrays — deep, key-order-insensitive (watchKey
        // sorts keys): `{ a: 1 } == { a: 1 }`, `[1, 2] == [1, 2]`. String-coercible value
        // objects (Date→ISO, URL→href, params→query, …) keep coerced-string equality below,
        // so `u == 'https://…'` still holds. Without this branch collections fell through to
        // Swift description strings — platform-dependent, and false for equal dicts.
        func structural(_ v: Any?) -> Bool {
            if let d = v as? [String: Any] { return JSECore.stringCoerce(d) == nil }
            return (v as? [Any]) != nil
        }
        if structural(a) || structural(b) { return watchKey(a) == watchKey(b) }
        return string(a) == string(b)
    }
    private static func compare(_ a: Any?, _ b: Any?, _ o: String) -> Bool {
        // Both operands strings → JS lexicographic ordering ('a' < 'b', '10' < '9'), which also
        // agrees with sortBy/sort's string fallback. Anything else compares numerically
        // (null/bool coerce; a MIXED string-number pair stays numeric — '5' < 10).
        if let sa = a as? String, let sb = b as? String {
            switch o { case "<": return sa < sb; case "<=": return sa <= sb; case ">": return sa > sb; default: return sa >= sb }
        }
        let x = number(a) ?? 0, y = number(b) ?? 0
        switch o { case "<": return x < y; case "<=": return x <= y; case ">": return x > y; default: return x >= y }
    }
    private static func arith(_ a: Any?, _ b: Any?, _ o: String) -> Any? {
        if o == "+" {
            if let x = number(a), let y = number(b) { return x + y }
            return string(a) + string(b)                          // string concat
        }
        let x = number(a) ?? 0, y = number(b) ?? 0
        switch o {
        case "-": return x - y
        case "*": return x * y
        case "/": return y == 0 ? 0 : x / y
        case "%": return y == 0 ? 0 : x.truncatingRemainder(dividingBy: y)   // JS % (sign of dividend); %0 → 0 like /0
        default: return 0
        }
    }
    /// The ONE missing value (`??` / `?.` nullish test): nil and the present-null scope
    /// sentinel both count — JSE does not split null from undefined.
    private static func isMissing(_ v: Any?) -> Bool { v == nil || v is NSNull }
    /// JS ToInt32 — trunc, wrap mod 2^32 into the signed range. NaN/±inf → 0.
    private static func toInt32(_ v: Any?) -> Int32 {
        let n = number(v) ?? 0
        if n.isNaN || n.isInfinite { return 0 }
        var t = n.rounded(.towardZero).truncatingRemainder(dividingBy: 4294967296.0)
        if t >= 2147483648.0 { t -= 4294967296.0 }
        else if t < -2147483648.0 { t += 4294967296.0 }
        return Int32(t)
    }
    /// JS ToUint32 — trunc, wrap mod 2^32 into [0, 2^32). NaN/±inf → 0.
    private static func toUint32(_ v: Any?) -> UInt32 {
        let n = number(v) ?? 0
        if n.isNaN || n.isInfinite { return 0 }
        var t = n.rounded(.towardZero).truncatingRemainder(dividingBy: 4294967296.0)
        if t < 0 { t += 4294967296.0 }
        return UInt32(t)
    }
    /// Bitwise / shift operators — JS semantics: Int32 operands (Uint32 for `>>>`),
    /// shift counts masked to 5 bits, results back as Double numbers.
    private static func bitOp(_ a: Any?, _ b: Any?, _ o: String) -> Double {
        let s = Int(toUint32(b) & 31)
        switch o {
        case "&": return Double(toInt32(a) & toInt32(b))
        case "|": return Double(toInt32(a) | toInt32(b))
        case "^": return Double(toInt32(a) ^ toInt32(b))
        case "<<": return Double(toInt32(a) &<< s)
        case ">>": return Double(toInt32(a) >> s)
        case ">>>": return Double(toUint32(a) >> s)
        default: return 0
        }
    }
    /// JS `~` — bitwise NOT over ToInt32 (−int32 − 1, the twins' spelling).
    private static func bitNot(_ v: Any?) -> Double { Double(-Int64(toInt32(v)) - 1) }
    /// JS `**` — operands number-coerced with `?? 0`, exactly like `*` (the arith table).
    private static func powOp(_ a: Any?, _ b: Any?) -> Double { pow(number(a) ?? 0, number(b) ?? 0) }
    /// The iterable coercion shared by spread (`[...x]`) and `for…of`: arrays as-is,
    /// strings → graphemes (Characters), Set → its values, Map → its entry pairs.
    static func spreadValues(_ v: Any?) -> [Any] {
        if let arr = v as? [Any] { return arr }
        if let s = v as? String { return s.map { String($0) } }
        if let d = v as? [String: Any] {
            if let values = d["__set"] as? [Any] { return values }
            if let entries = d["__map"] as? [Any] { return entries }
        }
        return []
    }
    /// The `for…in` key coercion (wave 3): a dict's OWN keys ("__"-internal keys skipped — so
    /// Set/Map/Date value objects iterate empty), an array's indices 0..n-1 (as numbers);
    /// anything else contributes nothing. SEAM: Swift's Dictionary has no insertion order, so
    /// the keys walk SORTED here (the watchKey stability precedent); the TS/Kotlin twins walk
    /// insertion order — corpus fixtures keep insertion order alphabetical so all three agree.
    static func forInKeys(_ v: Any?) -> [Any] {
        if let arr = v as? [Any] { return arr.indices.map { Double($0) } }
        if let d = v as? [String: Any] { return d.keys.sorted().filter { !$0.hasPrefix("__") } }
        return []
    }
    /// JS `in` — dict key / array index membership (relational precedence, like the twins).
    private static func inOp(_ l: Any?, _ r: Any?) -> Bool {
        if let arr = r as? [Any] {
            guard let n = number(l) else { return false }
            let i = Int(safeInt(n))
            return i >= 0 && i < arr.count
        }
        if let d = r as? [String: Any] { return d[string(l)] != nil }
        return false
    }

    // ── declaration grammar (wave 2): multi-declarators + flat destructuring patterns ──

    private indirect enum DeclPattern {
        case id(String)
        case obj(entries: [ObjEntry], rest: String?)
        case arr(items: [ArrItem?], rest: String?)             // nil item = hole
    }
    private struct ObjEntry { let key: String; let value: DeclPattern; let def: [Token]? }
    private struct ArrItem { let value: DeclPattern; let def: [Token]? }
    private struct Declarator { let pattern: DeclPattern; let expr: [Token] }

    /// Parse `pattern [= expr] (, pattern [= expr])*` from the token slice AFTER the
    /// `const`/`let`/`var` keyword.
    ///
    /// Patterns NEST, and each position takes an optional `= default` and a trailing `...rest`
    /// (twins: jse.ts parseDeclarators, Jse.kt parseDeclarators). They used to be flat, which
    /// made three everyday shapes unwritable: `const { a: { b } } = row`,
    /// `const { a = 5 } = opts`, and `const { id, ...rest } = row` — all data-shaping rather
    /// than exotic syntax.
    private static func parseDeclarators(_ toks: [Token]) -> [Declarator] {
        var out: [Declarator] = []
        var i = 0
        func cur() -> Token? { i < toks.count ? toks[i] : nil }
        func isOp(_ v: String) -> Bool { if case .op(let o)? = cur() { return o == v }; return false }

        /// Capture tokens up to the next TOP-LEVEL member of `stops` (nesting-aware).
        func captureUntil(_ stops: Set<String>) -> [Token] {
            var acc: [Token] = []
            var d = 0
            while i < toks.count {
                let tk = toks[i]
                if case .op(let o) = tk {
                    if o == "(" || o == "[" || o == "{" { d += 1 }
                    else if o == ")" || o == "]" || o == "}" {
                        if d == 0, stops.contains(o) { break }
                        d -= 1
                    } else if d == 0, stops.contains(o) { break }
                }
                acc.append(tk)
                i += 1
            }
            return acc
        }

        func parsePattern() -> DeclPattern? {
            if case .ident(let n)? = cur() { i += 1; return .id(n) }
            if isOp("{") {
                i += 1
                var entries: [ObjEntry] = []
                var rest: String? = nil
                while cur() != nil, !isOp("}") {
                    if isOp("...") {
                        i += 1
                        if case .ident(let rn)? = cur() { rest = rn; i += 1 }
                        if isOp(",") { i += 1 }
                        continue
                    }
                    var key: String? = nil
                    if case .ident(let k)? = cur() { key = k }
                    else if case .str(let k)? = cur() { key = k }
                    guard let k = key else { i += 1; continue }
                    i += 1
                    var value: DeclPattern = .id(k)
                    if isOp(":") { i += 1; value = parsePattern() ?? .id(k) }
                    var def: [Token]? = nil
                    if isOp("=") { i += 1; let d = captureUntil([",", "}"]); if !d.isEmpty { def = d } }
                    entries.append(ObjEntry(key: k, value: value, def: def))
                    if isOp(",") { i += 1 }
                }
                if isOp("}") { i += 1 }
                return .obj(entries: entries, rest: rest)
            }
            if isOp("[") {
                i += 1
                var items: [ArrItem?] = []
                var rest: String? = nil
                var expectItem = true
                while cur() != nil, !isOp("]") {
                    if isOp(",") { if expectItem { items.append(nil) }; expectItem = true; i += 1; continue }
                    if isOp("...") {
                        i += 1
                        if case .ident(let rn)? = cur() { rest = rn; i += 1 }
                        expectItem = false
                        continue
                    }
                    guard let value = parsePattern() else { i += 1; continue }
                    var def: [Token]? = nil
                    if isOp("=") { i += 1; let d = captureUntil([",", "]"]); if !d.isEmpty { def = d } }
                    items.append(ArrItem(value: value, def: def))
                    expectItem = false
                }
                if isOp("]") { i += 1 }
                return .arr(items: items, rest: rest)
            }
            return nil
        }

        while i < toks.count {
            guard let pattern = parsePattern() else { i += 1; continue }
            var expr: [Token] = []
            if isOp("=") { i += 1; expr = captureUntil([","]) }
            out.append(Declarator(pattern: pattern, expr: expr))
            if isOp(",") { i += 1 }
        }
        return out
    }

    /// THE RUNNER'S DOOR into the one pattern machinery (Stack.swift bindDestructure delegates
    /// here). It exists because the runner had a SECOND, text-level binder that stayed FLAT
    /// when patterns learned nesting, defaults and rest — the same body meant different things
    /// in an action and in an expression block. One parser, one binder, no second opinion.
    /// `patternText` may be a bare pattern (`[a, ...rest]`) or carry an initializer; only the
    /// pattern half is read here — the caller owns evaluating its own RHS.
    static func destructureBind(
        _ patternText: String,
        _ value: Any?,
        store: any JSEState,
        locals: [String: Any],
        _ bind: (String, Any?) -> Void
    ) {
        let decls = parseDeclarators(cachedTokens(patternText))
        guard let pattern = decls.first?.pattern else { return }
        bindPattern(pattern, value, bind) { toks in
            var dp = Parser(tokens: toks, store: store, item: locals)
            return dp.expression()
        }
    }

    /// Bind one declarator's VALUE through its pattern. `evalDefault` evaluates a `= default`
    /// when the position is MISSING (nil — JSE's one absent value); callers that cannot
    /// evaluate pass nil and simply bind the missing value.
    private static func bindPattern(
        _ p: DeclPattern,
        _ value: Any?,
        _ bind: (String, Any?) -> Void,
        _ evalDefault: (([Token]) -> Any?)? = nil
    ) {
        func withDefault(_ v: Any?, _ def: [Token]?) -> Any? {
            guard let def = def, let evalDefault = evalDefault else { return v }
            if v == nil || v is NSNull { return evalDefault(def) }
            return v
        }
        switch p {
        case .id(let n): bind(n, value)
        case .obj(let entries, let rest):
            var taken = Set<String>()
            for e in entries {
                taken.insert(e.key)
                bindPattern(e.value, withDefault(member(value, e.key), e.def), bind, evalDefault)
            }
            if let rest = rest {
                var outMap: [String: Any?] = [:]
                if let dict = value as? [String: Any?] {
                    for (k, v) in dict where !taken.contains(k) { outMap[k] = v }
                }
                bind(rest, outMap)
            }
        case .arr(let items, let rest):
            for (k, item) in items.enumerated() {
                guard let item = item else { continue }
                bindPattern(item.value, withDefault(index(value, Double(k)), item.def), bind, evalDefault)
            }
            if let rest = rest {
                let src = (value as? [Any?]) ?? []
                bind(rest, items.count >= src.count ? [] : Array(src.dropFirst(items.count)))
            }
        }
    }

    /// JS `typeof` — with one deliberate divergence: JSE does not distinguish null from
    /// undefined (both are nil), so both report "undefined" (JS's `typeof null == "object"`
    /// wart would make the useful missing-value branch impossible). Arrays and dicts are
    /// "object" (JS), arrow-function values are "function".
    private static func typeofString(_ v: Any?) -> String {
        switch v {
        case .none, is NSNull: return "undefined"
        case is String: return "string"
        case let n as NSNumber:   // Swift Bool/Double/Int all bridge here; CFBoolean identity splits bool from number
            return (n === kCFBooleanTrue || n === kCFBooleanFalse) ? "boolean" : "number"
        case is StackLambda: return "function"
        default: return "object"
        }
    }

    /// Normalize an explicit `$`-namespace prefix to its canonical scope path — the opt-in
    /// "professional" spelling layered over the bare scopes. Purely additive / non-breaking:
    /// bare names, `global.*`, `route.*`, `item.*`, `attribute.*` and `dsx.this`/`dsx.event` are
    /// unchanged; the `$`-prefixed aliases simply expand to them.
    ///
    ///   `dsx.variable.x` → `x` (this surface's state)  ·  `dsx.global.x` → `global.x`  ·  `dsx.route.x` → `route.x`
    ///   `dsx.params.x` → `route.params.x`  ·  `dsx.query.x` → `route.query.x`  ·  `dsx.path` → `route.path`
    ///   `dsx.attribute.x` → `attribute.x` (a component's attributes)  ·  `dsx.item.x` → `item.x`  ·  `dsx.formula.x` → `x` (a formula by name)
    static func normalizeScope(_ path: String) -> String {
        // `dsx.` is the ONE universal root on both surfaces (markup `{{ dsx.global.x }}` ⇄
        // native `dsx.global.x`). Strip it, then the FIRST segment names the scope. (The old
        // `$`-sigil family — dsx.global / dsx.app / dsx.variable / … — was removed; `dsx.` replaces it.)
        guard path.hasPrefix("dsx.") else { return path }
        let body = String(path.dropFirst(4))
        let head: String, rest: String
        if let dot = body.firstIndex(of: ".") {
            head = String(body[..<dot]); rest = String(body[body.index(after: dot)...])
        } else { head = body; rest = "" }
        func join(_ base: String) -> String { rest.isEmpty ? base : base + "." + rest }
        switch head {
        case "variable", "formula": return rest.isEmpty ? body : rest   // surface state (dsx.variable) / a formula, by name
        case "global":           return join("global")
        // app-wide constants (App.json `consts`; networking.md N0) live on the app store
        // under `const`: dsx.const.api_url folds to global.const.api_url, so the reserved
        // `global` branch serves it (reactive via storeChanged) with no extra dispatch.
        case "const":            return join("global.const")
        // strings / theme are NOT scopes — they live UNDER global: dsx.global.strings /
        // dsx.global.theme (white-label text / design tokens; see OpenSource/Skills/white-label.md).
        case "screen":           return join("global.screen")           // reactive window metrics: width/height/sizeClass/orientation/breakpoint
        // G4 unified input (dsx-game.md §2): `dsx.input.jump` / `dsx.input.move.x` is an
        // ordinary tracked read of the app store — the input runtime publishes each declared
        // binding under `global.input.<name>`, so a markup read is reactive for free and no
        // new dispatch path exists. (`<input>` in the BODY is still the form element.)
        case "input":            return join("global.input")
        case "source":           return join("global.source")           // provenance plane: dsx.source.<plane>.{state,serving,at} + online/boot (Source.swift)
        case "app":              return join("global.app")              // app identity from App.json — dsx.app.host (per-locale resolved) / dsx.app.name; seeded at boot
        case "route":            return join("route")
        case "cookie":           return join("cookie")           // web/native cookie jar — dsx.cookie.name (a value) / dsx.cookie (the whole { name: value } jar)
        case "attribute":        return join("attribute")        // a component's ATTRIBUTES — dsx.attribute.name, like a web component's HTML attributes (never "props")
        case "override":         return join("override")         // a component's STYLE contract — dsx.override.name (Conformance/overrides)
        case "item", "this":     return join("item")             // dsx.this ≡ dsx.item — the current <list>/<grid> row
        case "element":          return join("item.__element")   // dsx.element.* — the nearest `container`-marked ancestor's live { width, height } (CSS @container)
        case "params":           return join("route.params")
        case "query":            return join("route.query")
        case "path":             return "route.path"
        default:                 return body                            // dsx.event / dsx.action / unknown — handled elsewhere
        }
    }

    /// The running DEPLOY TARGET — the Catalyst identity rule (desktop-platforms.md):
    /// a Mac build reports "macos" even while UIKit-compat runs underneath, so `:ios`
    /// markup never matches on a Mac. The wrist is a NODE of the phone deployment
    /// (watch-runtime.md), so watchOS keeps the phone's identity; only attribute
    /// resolution uses the separate exact `watch` render target. The platform corpus
    /// (OpenSource/Conformance/platform/platform.json) pins both identities.
    #if targetEnvironment(macCatalyst) || os(macOS)
    static let platformTarget = "macos"
    static let platformIsDesktop = true
    #else
    static let platformTarget = "ios"
    static let platformIsDesktop = false
    #endif

    /// Exact target used only by the attribute-suffix fold. This is `watch` in a
    /// watchOS process while `platformTarget` remains the deployment identity `ios`.
    static let platformAttributeTarget = StackPlatformAttrs.runtimeTarget

    private static func lookup(_ rawPath: String, store: any JSEState, item: [String: Any]?) -> Any? {
        // EXPLICIT namespace: `dsx.variable.x` means the surface store, full stop — inside a list/grid
        // row whose item happens to carry the same field name (`item.index` vs `dsx.variable.index`),
        // the row must NOT shadow it (that made `item.index == dsx.variable.index` read as i == i —
        // every episode cell showed "current"). Bare names keep the shadow (that's the props rule).
        let explicitStore = rawPath.hasPrefix("dsx.variable.") || rawPath.hasPrefix("dsx.formula.")
        let path = normalizeScope(rawPath)
        let parts = path.split(separator: ".").map(String.init)
        guard let first = parts.first else { return nil }
        // Reserved: `os` / `platform` → the running DEPLOY TARGET, so
        // `visible-if="os == 'ios'"` gates an element to one platform. "ios" here —
        // or "macos" on the Mac build (the Catalyst identity rule). The same XML
        // returns "android" / "windows" / "linux" on the Kotlin renderer and "web"
        // on the web kernel — the platform corpus pins all of it.
        if parts.count == 1, first == "os" || first == "platform" { return JSE.platformTarget }
        // The dsx.platform kernel constant (/web/14 + desktop-platforms.md):
        // platform.os / platform.native / platform.desktop / platform.embed. Unknown
        // second segments fall through to ordinary lookup (an author's own variable).
        if first == "platform", parts.count == 2 {
            switch parts[1] {
            case "os":      return JSE.platformTarget
            case "native":  return true    // this kernel never renders the web
            case "desktop": return JSE.platformIsDesktop
            case "embed":   return false   // the web lane's separate-artifact seam
            default:        break
            }
        }
        // Reserved: `env` → the runtime environment channel ("simulator" | "debug" |
        // "testflight" | "adhoc" | "appstore"), so `visible-if="env != 'appstore'"` gates
        // an element OFF production. Resolved from the boot-seeded `global.app.env` — ONE
        // source of truth with `dsx.app.env` / web `global.app.env` (the DEBUG-only
        // `simulatedChannel` test hook can't desync the spellings) — falling back to the
        // live detector pre-seed. Detection fails CLOSED to "appstore" (AppManifest.swift).
        // Unlike `os`, an EXPLICIT `dsx.variable.env` read keeps the author's variable.
        if parts.count == 1, !explicitStore, first == "env" {
            return walk(["app", "env"], in: Self.appVars?() ?? [:]) ?? Self.envChannel?() ?? "appstore"
        }
        // App-wide reactive store (DSXState): `global.session.credits` etc. Reserved,
        // so a `global.*` read never falls through to a row/prop or the surface store.
        // `dsx.const.*` (App.json `consts`; networking.md N0) folds here via normalizeScope
        // → `global.const.*` — seeded at boot, optionally sharpened by a remote fetch, and
        // reactive (a const change republishes → every reading `<api>` re-materializes).
        if first == "global" { return walk(Array(parts.dropFirst()), in: Self.appVars?() ?? [:]) }
        // Reserved: `route.*` is a view into `global.route` (the navigation state), so
        // `{{ route.path }}` / `{{ route.params.id }}` read the current route without the
        // `global.` prefix. Maintained by the Routing package; nil until routing is on.
        if first == "route" { return walk(parts, in: Self.appVars?() ?? [:]) }
        // Reserved: `cookie.*` — the live cookie jar (DSXCookies), kept in sync with the web
        // layer + HTTPCookieStorage. `{{ dsx.cookie.session }}` reads one; `{{ dsx.cookie }}` the lot.
        if first == "cookie" {
            let jar = Self.cookieJar?() ?? [:]
            return parts.count == 1 ? jar : walk(Array(parts.dropFirst()), in: jar)
        }
        // The style-override plane: `dsx.override.<name>` — the component's declared style
        // knobs, resolved through the shared core (item __overrides -> store var -> default,
        // typed fail-open coercion; corpus OpenSource/Conformance/overrides).
        if first == "override" {
            let itemOv = item?["__overrides"] as? [String: Any]
            let storeOv = store.vars["dsx.override"] as? [String: Any]
            if parts.count == 1 {
                return StyleOverrides.resolvePlane(Array(store.overrideDecls.values), itemOv, storeOv)
            }
            let name = parts[1]
            guard let decl = store.overrideDecls[name] else { return nil }
            let fromItem = itemOv?[name]
            let raw = (fromItem != nil && !(fromItem is NSNull)) ? fromItem : storeOv?[name]
            let v = StyleOverrides.resolve(decl, raw)
            return parts.count == 2 ? v : walk(Array(parts.dropFirst(2)), in: v)
        }
        // Explicit local scope: `item.*` (list row) / `attribute.*` (a component's attributes).
        if first == "item" || first == "attribute" {
            let v = walk(Array(parts.dropFirst()), in: item)
            // When the consumer omitted the attribute: native runtime values (`ui.attribute("x", v)`
            // → the reactive `dsx.attribute` dict) win, then the markup-declared default
            // (`<attribute as="x" default="…"/>`, re-evaluated on read like an inline `|| default`).
            if v == nil, first == "attribute", parts.count >= 2, let av = store.vars["dsx.attribute"] as? [String: Any] {
                if let runtime = walk(Array(parts.dropFirst()), in: av) { return runtime }
            }
            if v == nil, first == "attribute", parts.count == 2, let def = store.attrDefaults[parts[1]] {
                //  `default=""` MEANS THE EMPTY STRING (the TS/Kotlin twins say the same): an
                //  empty expression evaluated to nil, so every attribute declared with an empty
                //  default read as ABSENT and the usual `!= ''` guard fired for one nobody set.
                if def.trimmingCharacters(in: .whitespaces).isEmpty { return "" }
                return eval(def, store: store, item: item)
            }
            return v
        }
        // Bare name: locals (attributes / row) shadow the shared store, then fall back —
        // so `{{ title }}` is a prop when present, else the shared store key.
        if !explicitStore, let local = item?[first] {
            return walk(Array(parts.dropFirst()), in: local)
        }
        // Computed value: a name registered by `<variable computed="true">`. Evaluate its
        // formula lazily in the CURRENT scope (a formula over `item.*` derives per row);
        // reactive (re-evaluated on every read), depth-guarded against self-reference. A real
        // store var of the same name wins.
        if store.vars[first] == nil, let formula = store.computed[first], store.computedDepth < 32 {
            store.computedDepth += 1
            let v = evalBlock(formula, store: store, item: item)
            store.computedDepth -= 1
            return parts.count == 1 ? v : walk(Array(parts.dropFirst()), in: v)
        }
        // A parameterized `<formula>`: bind each input attr (evaluated in THIS scope) as a local,
        // then run the body against those locals — reactive, depth-guarded.
        if store.vars[first] == nil, let f = store.formulas[first], store.computedDepth < 32 {
            store.computedDepth += 1
            var scope: [String: Any] = [:]
            for (k, e) in f.inputs { scope[k] = evalBlock(e, store: store, item: item) ?? NSNull() }
            let v = evalBlock(f.body, store: store, item: scope)
            store.computedDepth -= 1
            return parts.count == 1 ? v : walk(Array(parts.dropFirst()), in: v)
        }
        // A `<variable>`-declared default (evaluated once; superseded the moment `set:`/`push:`
        // writes a live value to the store).
        if store.vars[first] == nil, let initial = store.initials[first] {
            return parts.count == 1 ? initial : walk(Array(parts.dropFirst()), in: initial)
        }
        return walk(Array(parts.dropFirst()), in: store.vars[first])
    }
    private static func walk(_ parts: [String], in value: Any?) -> Any? {
        var cur = value
        for p in parts {
            // `.length` on an array/string → count (JS). A dict is left alone — it may have a
            // real "length" key.
            if p == "length", !(cur is [String: Any]) {
                if let s = cur as? String { cur = Double(s.count); continue }
                if cur is [Any] || cur is [[String: Any]] { cur = Double(asArray(cur).count); continue }
            }
            // A numeric segment indexes an array (`routes.0.path`, `cart.items.2.price`),
            // bounds-checked; otherwise walk a dictionary key (`a.b.c`). A dict whose key
            // happens to be numeric still resolves — the array cast simply fails first.
            if let i = Int(p), let arr = cur as? [Any] {
                cur = (i >= 0 && i < arr.count) ? arr[i] : nil
            } else {
                cur = (cur as? [String: Any])?[p]
            }
        }
        return cur
    }

    static func truthy(_ v: Any?) -> Bool {
        switch v {
        case let b as Bool: return b
        case let s as String: return !s.isEmpty
        case let n as NSNumber: return n.doubleValue != 0
        case .some: return true
        case .none: return false
        }
    }
    static func string(_ v: Any?) -> String {
        if let d = v as? [String: Any], let c = JSECore.stringCoerce(d) { return c }   // Date→ISO, URL→href, params→query
        switch v {
        case let s as String: return s
        case let n as NSNumber:
            let d = n.doubleValue
            // `Int(d)` TRAPS on ±Infinity, NaN, and any magnitude ≥ 2^63 — reachable from
            // watchKey/interpolate on `<api>` keys and url params (e.g. a u64-scale id or a
            // divide-by-zero formula), so guard before the cast. Non-finite → the JS
            // spelling; an integral past Int64 → a plain decimal (no exponent), matching the
            // TS/Kotlin twins instead of Swift's "9.5e+18".
            if !d.isFinite { return d.isNaN ? "NaN" : (d < 0 ? "-Infinity" : "Infinity") }
            if d == d.rounded() { return abs(d) < 9.2e18 ? String(Int(d)) : String(format: "%.0f", d) }
            return "\(d)"
        case .some(let x): return "\(x)"
        case .none: return ""
        }
    }
    /// A stable, deep key for `<watch>` equality — changes iff the value meaningfully changes
    /// (dict keys sorted so ordering never churns). `.onChange` compares it to fire on real changes.
    static func watchKey(_ v: Any?) -> String {
        switch v {
        case .none, is NSNull:       return "∅"
        case let s as String:        return "s\u{1}" + s
        // A REAL boolean is only the CFBoolean singleton. A bare `as Bool` would also match
        // NSNumber 0/1 (a JSON-parsed int bridges to Bool), keying them "b0"/"b1" while the
        // SAME value computed by the JSE (a Swift Double) keys "n␁0" — so equals() called
        // [0, 1] ≠ [0.0, 1.0] and <watch> saw phantom changes. The twins never conflate
        // (Kotlin `is Boolean`, TS `typeof v === "boolean"`); this pins Swift to them.
        case let n as NSNumber where CFGetTypeID(n) == CFBooleanGetTypeID():
                                     return n.boolValue ? "b1" : "b0"
        case let n as NSNumber:      return "n\u{1}" + string(n)
        case let a as [Any]:         return "[" + a.map { watchKey($0) }.joined(separator: "\u{1}") + "]"
        case let d as [String: Any]: return "{" + d.keys.sorted().map { "\($0)=" + watchKey(d[$0]) }.joined(separator: "\u{1}") + "}"
        case .some(let x):           return "x\u{1}" + String(describing: x)
        }
    }
}
