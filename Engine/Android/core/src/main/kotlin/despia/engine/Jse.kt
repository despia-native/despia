@file:Suppress("UNCHECKED_CAST")

//
//  Jse.kt - the DSX expression evaluator (the JSE language core). Kotlin twin of
//  Engine/JSE.swift — same names, same arguments, same behaviors.
//
//  Pure computation, android.*-free -> SURFACE-SAFE: the same evaluator compiles into any
//  JVM process (a widget, a keyboard, the test loop) exactly like the Swift original is
//  extension-safe. kotlin-stdlib + JDK only; no surface deps, no JS engine, no bridge.
//
//  ── NUMBER MODEL (the #1 cross-platform fidelity contract; see js-core-parity.md) ──
//  Values are Kotlin `Any?`; every number the evaluator produces is a `Double` (the Swift
//  side is NSNumber-bridged doubles — literals lex as Double, arithmetic is Double).
//    • number(v): Double → itself · Int/Long/Number → toDouble · Bool → 1/0 · String →
//      full-string parse (Swift `Double(String)` grammar: no trim, no Java "1f"/"1d"
//      suffixes, bare hex "0x1F" accepted) · {__date: ms} dict → its ms · else null.
//    • string(v): integral finite doubles print as integers ("2" not "2.0"), other finite
//      doubles as shortest round-trip decimal. Bool prints "1"/"0" — on iOS a Bool
//      dynamic-casts to NSNumber before any Bool case can exist in string(), so "1"/"0"
//      IS the shipped behavior and both platforms pin it. null → "".
//    • truthy(v): Bool → itself · String → non-empty (so "0" and "false" are TRUE) ·
//      number → != 0 (so NaN is TRUE — Swift `doubleValue != 0`) · null → false ·
//      anything else (arrays, dicts, lambdas, NSNull) → true.
//    • equals(a,b) (== and === share it): if BOTH coerce to number → numeric compare
//      (1 == "1" == true; NaN == NaN is false), else string-coercion compare
//      (null == "" is true; null == 0 is false).
//    • compare (< <= > >=): string×string pairs compare lexicographically ('a' < 'b',
//      '10' < '9' — JS); anything else number-coerces with `?? 0` (mixed stays numeric).
//    • arith: `+` is numeric when both sides coerce, else string concat; `-` `*` `/`
//      coerce with `?? 0`; DIVISION BY ZERO YIELDS 0 (not Infinity) — the JSE law.
//  Divergences (documented, not silent): where Swift would TRAP converting a huge/NaN
//  double to Int (String(Int(1e21)), an index of NaN), Kotlin saturates via toLong/toInt
//  and stays total — there is no iOS behavior to match because iOS crashes. Swift's raw
//  "\(x)" descriptions of exotic doubles ("inf", "nan", "1e+21") and of arrays/dicts are
//  descriptive, not contractual; fixtures never assert them beyond the integral rule.
//
//  ── NULL MODEL ──
//  Kotlin `null` is Swift `nil` (absent / no value). `NSNull` (the object below) is the
//  present-but-null SCOPE SENTINEL, kept 1:1 with Foundation's: Swift dictionaries cannot
//  hold nil, so a bound-but-null lambda param / const / destructured key is stored as
//  NSNull — and that is OBSERVABLE: it shadows outer names, it is truthy (Swift's
//  `.some`), it stringifies "<null>", it does not number-coerce. Collapsing it to Kotlin
//  null would flip those fixtures, so the sentinel stays.
//
//  ── SEAMS (the JVM twins of iOS-only dependencies; each is wired by the host at boot) ──
//    • JSECore / JSECrypto — the JS core globals (URL/Date/Intl/JSON/fetch shapes) and
//      Web Crypto live in Stack.swift on iOS; the seam objects below keep JSE's exact
//      dispatch shape (same routing, same entry points) and route to the PORTED
//      implementations in Globals.kt (JSECoreGlobals/JSECryptoGlobals — pinned decisions
//      + divergences documented there). Math.*, the pure constants, the RegExp `test`
//      method, and the byte plumbing (toHex/toBase64) live here, already 1:1.
//      navigator.* still needs host wiring and stays a pending constant.
//    • JSERegex — fully ported on java.util.regex (the parity contract blesses the
//      documented java.util semantics; ICU divergences are corpus-visible, not hidden).
//    • stateVars / cookieJar / appEnvironment / moduleAvailable / afterRenderDispatch —
//      DSX.state.vars, DSXCookies, AppEnvironment, ModuleRegistry and the main runloop
//      are host-side; the seams default inert (empty / "appstore" / false / inline).
//    • `os` / `platform` resolve to "android" here by DESIGN — the Swift source
//      documents that the same markup reads "ios" there and "android" on this renderer.
//

package despia.engine

import java.text.BreakIterator
import java.util.regex.Matcher
import java.util.regex.Pattern
import java.util.regex.PatternSyntaxException

/// Foundation's NSNull, as the JSE scope sentinel (see NULL MODEL above). `toString()`
/// matches NSNull's description so the generic string() fallback coerces identically.
object NSNull {
    override fun toString(): String = "<null>"
}

/// A parameterized reactive formula: `<formula name="x" foo="…" bar="…">…uses foo, bar…</formula>`.
/// `inputs` are attribute name → expression (evaluated in the use-site scope); `body` computes
/// from those names as locals. (Declared with the store — it moves with the Stack.kt port.)
class StackFormula(val inputs: Map<String, String>, val body: String)

/// The evaluator-visible subset of Stack.swift's `StackStore` (the surface's reactive
/// store). The reactive/UI members (@Published vars, handlers, timers, sockets, watch
/// budgets…) ride the Stack.kt port; JSE reads exactly these:
class StackStore {
    var vars: MutableMap<String, Any?> = HashMap()                // live surface state (NSNull marks present-null)
    /// The kernel nav FRAME this surface renders in (the Router/host stamps pushed, presented
    /// and per-frame surfaces). The statement runner forwards it on every package call as the
    /// `__frame` framing key so a frame-scoped verb (route.chrome) targets the CALLING screen —
    /// an `on:appear` re-fired by a resurfacing covered screen must never restyle whatever
    /// frame happens to be top mid-transition (Stack.swift StackStore.frameId, 1:1).
    /// null = not a nav frame (a mounted overlay, a bare surface): top-frame semantics apply.
    var frameId: Int? = null
    /// SCREEN READINESS opt-in (screen-lifecycle.md · Conformance/lifecycle/readiness.json):
    /// this surface's root declared `settle="manual"`, so it reports readiness ITSELF
    /// (`dsx.screen.settled()`) instead of settling on its first render. Recorded here (not
    /// reported straight to `ScreenReadiness`) because a surface is often built BEFORE its frame
    /// mounts; the frame host reads the flag at its mount seam. `<DSXView/>` sets it too — an
    /// async loader that paints a spinner first must never settle blank. Twin: Stack.swift
    /// `StackStore.settleManual`.
    var settleManual = false
    /// HYBRID ORDERING gate (Conformance/lifecycle/readiness.json rule 9): this surface MOUNTED the
    /// app's `<DSXWebView/>` web surface, which is blank until the page loads — so the frame must not
    /// report settled on its first render (Splash would reveal over an empty web view and the
    /// page's own `domStart` would re-open the phase). Recorded here for the same reason
    /// `settleManual` is: the component composes BEFORE the host's mount effect runs. NOT an author
    /// opt-in — `<DSXWebView/>` sets it. Twin: Stack.swift `StackStore.hostsWebSurface`.
    var hostsWebSurface = false
    var computed: MutableMap<String, String> = HashMap()          // reactive formulas: <variable computed="true">
    var computedDepth = 0                                         // guards self-referential computed values
    var initials: MutableMap<String, Any?> = HashMap()            // declared defaults: <variable as="x">expr</variable> (set once)
    var formulas: MutableMap<String, StackFormula> = HashMap()    // parameterized reactive formulas: <formula as="x" foo="…">
    var functions: MutableMap<String, Any> = HashMap()            // user functions: function name(args){…} → a callable JSE.StackLambda (type-erased)
    var fnDepth = 0                                               // guards user-function recursion (capped at 32 — bounded, can't hang)
    var evalDepth = 0                                             // guards expression-evaluator recursion (capped at 64 in JSE.eval — past it the expression yields null + logs)
    var attrDefaults: MutableMap<String, String> = HashMap()      // declared prop defaults: <attribute as="x" default="…"/>
    var overrideDecls: MutableMap<String, OverrideDecl> = LinkedHashMap()  // declared style knobs: <override as="x" type="…" default="…"/>
}

object JSE {                  // JSE — the expression evaluator

    // ── host seams (see the header) ─────────────────────────────────────────────────────
    /** DSX.state.vars — the app-wide reactive store (`global.*` / `route.*` / `env`). */
    var stateVars: () -> Map<String, Any?> = { emptyMap() }
    /** DSXCookies.shared.jar — the live cookie jar (`cookie.*`). */
    var cookieJar: () -> Map<String, Any?> = { emptyMap() }
    /** AppEnvironment.current.rawValue — detection fails CLOSED to "appstore" (AppManifest). */
    var appEnvironment: () -> String = { "appstore" }
    /** ModuleRegistry.shared.isAvailable — the `has(scheme)` capability check. */
    var moduleAvailable: (String) -> Boolean = { false }
    /**
     * The COMPONENT-TABLE half of the capability boundary — Swift's `StackComponents.has(tag)`.
     * Kept separate from `moduleAvailable` on purpose: that one is the UNION (a package scheme
     * OR a component tag) behind route `requires` and the `has()` builtin, while this answers
     * the narrower question "is this TAG a component in the build?" — which is the only thing
     * the ROOT PLAN may ask, because a plan candidate is a component, never a scheme.
     *
     * `:core` has no component table (`ComposeStackComponents` lives in :render, and :core
     * compiles SDK-free), so the registry binds itself in at boot — a LAZY predicate, never a
     * snapshot: the tables fill in three waves and the last of them lands after this is set.
     *
     * TYPED ABSENCE (durability.md P4): `null` means "no registry to consult", NOT "no such
     * component". A runtime with no render layer — the bare-kernel tests, a headless JVM host —
     * must not fail every root candidate as `root.component_missing`; it fails open, which is
     * exactly the behavior this seam replaced. A host that HAS a table binds one and gets the
     * honest answer.
     */
    var componentAvailable: ((String) -> Boolean)? = null
    /** DispatchQueue.main.async — the Android host swaps in a main-Looper dispatcher at boot;
     *  the pure-JVM default runs inline (the DSXSharedRegistry.mainThread seam pattern). */
    var afterRenderDispatch: (work: () -> Unit) -> Unit = { it() }

    /// THE RENDER-SAFE INVARIANT — so author logic JUST WORKS however complex.
    /// Reactive author logic (an on:change, a <watch>, a media event) must never run
    /// synchronously inside the UI framework's update pass; the engine hops every such
    /// edge to the next runloop tick through this one funnel. (Second reason: STACK
    /// BUDGET — entering author JSE from a fresh tick gives every cascade the full,
    /// empty stack.) Direct gestures and measure= stay synchronous, exactly like iOS.
    fun afterRender(work: () -> Unit) = afterRenderDispatch(work)

    /**
     * How deep a component may expand before the renderer stops.
     *
     * NOT a budget, and never to be tuned for taste. A component that names itself is a
     * legitimate and common shape - a tree, an outliner, a comment thread, a file browser -
     * and it terminates because the DATA terminates. This exists for the one case where the
     * data does not: a cycle or a corrupt child list, where the only alternatives are an
     * unbounded render and a dead stack. Bounded output beats a crash, and legitimate
     * nesting must never reach it. The previous 32 was a guess made before anything
     * recursive shipped and it capped real trees. Uniform on all three renderers (corpus
     * Conformance/composition/attribute-binding.json `recursion`). It lives in :core rather
     * than beside its one caller so the SDK-free lane can gate it against the corpus.
     */
    const val COMPONENT_DEPTH_CAP = 256

    /** What an author meant by one `name="..."` attribute. Corpus:
     *  OpenSource/Conformance/composition/attribute-binding.json. Twins: the TS
     *  `attributeBinding` and the Swift `JSE.attributeBinding`. */
    sealed class AttributeBinding {
        object Static : AttributeBinding()
        data class Value(val expr: String) : AttributeBinding()
        object Text : AttributeBinding()
    }

    /**
     * The attribute-binding FOLD - pure syntax, no store, no evaluation.
     *
     * A sole `{{ ... }}` carries the expression's VALUE; anything mixed carries the string.
     * Without the distinction every consumer prop arrives interpolated, which is invisible
     * for a label and fatal for structure: a component that renders its own children cannot
     * hand them down, so a tree, an outliner or a comment thread is unbuildable.
     *
     * A hole ends at the FIRST `}}`, matching `interpolate`'s own scan exactly. The two must
     * never disagree about where an expression stops - that disagreement is a silent type
     * change, and one shared wrong answer is repairable where a split one is not.
     */
    fun attributeBinding(template: String): AttributeBinding {
        if (!template.contains("{{")) return AttributeBinding.Static
        val t = template.trim()
        if (!t.startsWith("{{")) return AttributeBinding.Text
        val close = t.indexOf("}}", 2)
        if (close < 0 || close != t.length - 2) return AttributeBinding.Text
        return AttributeBinding.Value(t.substring(2, close))
    }

    /** Resolve one consumer attribute to the value it should carry: typed when the template
     *  is a sole hole, its own text when it has none, the interpolated sentence otherwise. */
    fun bindAttribute(template: String, store: StackStore, item: Map<String, Any?>?): Any? =
        when (val b = attributeBinding(template)) {
            is AttributeBinding.Static -> template
            is AttributeBinding.Value -> eval(b.expr, store, item)
            is AttributeBinding.Text -> interpolate(template, store, item)
        }

    fun interpolate(s: String, store: StackStore, item: Map<String, Any?>?): String {
        if (!s.contains("{{")) return s
        val out = StringBuilder()
        var idx = 0
        while (true) {
            val open = s.indexOf("{{", idx)
            if (open < 0) break
            out.append(s, idx, open)
            val close = s.indexOf("}}", open + 2)
            if (close < 0) { out.append(s, open, s.length); return out.toString() }
            val expr = s.substring(open + 2, close)
            out.append(string(eval(expr, store, item)))
            idx = close + 2
        }
        out.append(s, idx, s.length)
        return out.toString()
    }

    fun eval(raw: String, store: StackStore, item: Map<String, Any?>?): Any? {
        val e = trimWhitespaceOnly(raw)                       // Swift .whitespaces (no newlines)
        if (e.isEmpty()) return null
        // Recursion budget: a self-referential computed / <variable> / binding (an expression
        // that reads itself, directly or transitively) re-evaluates forever — a 2-frame mutual
        // recursion that overflows the native stack. Bound it like fnDepth / actionDepth:
        // past the budget the expression yields null + logs, so a knotted expression is
        // contained instead of fatal. 64 is far beyond any real computed chain; only a cycle
        // climbs here. evalDepth tracks NESTING (restored on every exit), so sequential evals
        // within one action never accumulate.
        if (store.evalDepth >= 64) {
            kernelLog("[JSE] eval recursion budget (64) exceeded — expression cycle (a computed/binding referencing itself?); returning nil: ${e.take(80)}")
            return null
        }
        store.evalDepth += 1
        try {
            val p = Parser(cachedTokens(e), store, item)
            return p.expression()
        } catch (t: Throwable) {
            // belt-and-braces: an evaluator failure (incl. StackOverflowError on
            // adversarial input) is contained, never fatal — the parser depth cap
            // should make this unreachable
            kernelLog("[JSE] eval failed — returning nil: ${t.javaClass.simpleName} in ${e.take(80)}")
            return null
        } finally {
            store.evalDepth -= 1
        }
    }

    // ── the token pre-parse cache ────────────────────────────────────────────────────────
    // A `{{ }}` binding / visible-if / computed formula re-evaluates its SAME expression
    // string on every recomposition, and tokenize() re-scans it char-by-char each time —
    // measured at ~half of a typical binding eval (JseBenchmark.kt: evalCond 1,407→728
    // ns/op, evalExpr 2,569→1,251 with this cache). tokenize is a pure function
    // of the string and every Token is an immutable data class that Parser/JSEval only READ
    // (capture/arrowBody build new lists sharing the token refs), so memoizing string →
    // token list is semantics-free. Size 512: the distinct-expression population of an app
    // is its authored binding/handler set (typically low hundreds); eviction is the kernel's
    // clear-on-full shape (JSERegex 128 / CSSInline 512 — same on iOS), so the worst case
    // degrades to exactly the pre-cache behavior: re-tokenize. Thread-safe like JSERegex.
    // iOS twin: JSE.swift `cachedTokens` — same key (the trimmed expression), same bound,
    // same eviction; keep them in lockstep.
    private val tokenCacheLock = Any()
    private val tokenCache = HashMap<String, List<Token>>()
    private fun cachedTokens(s: String): List<Token> {
        synchronized(tokenCacheLock) { tokenCache[s] }?.let { return it }
        val toks = tokenize(s)
        synchronized(tokenCacheLock) {
            if (tokenCache.size > 512) tokenCache.clear()
            tokenCache[s] = toks
        }
        return toks
    }

    /// Evaluate a `<variable>`/function body as a VALUE — a **bounded-JS** block.
    /// A single expression returns directly; a `{ }` block runs `if (…) { } else if { } else { }`,
    /// `const`/`let`, and `return` (early, or the last bare expression as an implicit return) —
    /// exactly like a JS function body. PURE: `const`/`let`/`x = e` write a throwaway local scope
    /// (seeded with `item`), never the store. Total — the full statement grammar incl.
    /// BUDGETED loops (10000 iterations per evaluation, corpus core-004) — so it
    /// always terminates. 1:1 JS, interpreted natively (no JS engine, no bridge).
    fun evalBlock(body: String, store: StackStore, item: Map<String, Any?>?): Any? {
        val trimmed = body.trim()                             // Swift .whitespacesAndNewlines
        if (trimmed.isEmpty()) return null
        // Fast path: a plain single expression (no block / statements / declarations).
        if (!trimmed.contains(";") && !trimmed.contains("\n") && !trimmed.contains("{") &&
            !trimmed.startsWith("return") && !trimmed.startsWith("const ") && !trimmed.startsWith("let ") &&
            !trimmed.startsWith("if ") && !trimmed.startsWith("if(") && !trimmed.startsWith("function")
        ) {
            return eval(trimmed, store, item)
        }
        val e = JSEval(cachedTokens(body), store, item ?: emptyMap())   // computed formulas re-run per READ — same cache (JSEval only reads its tokens)
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
    /// one name. Present ⇒ it wins over `keys`. (TS twin: values.ts LambdaParam.)
    private class LambdaParam(
        val name: String?,
        val keys: List<String>,
        val def: List<Token>? = null,
        val rest: Boolean = false,
        val pattern: DeclPattern? = null,
    )
    private class StackLambda(val params: List<LambdaParam>, val body: List<Token>, val block: Boolean, val captured: Map<String, Any?>)

    /// Invoke a lambda / user function: bind args to params (destructuring `{a,b}`, call-time
    /// defaults, a trailing rest array), then evaluate the body — an expression, or a `{ }`
    /// statement block whose `return` (or last expression) is the value. The body's scope =
    /// caller `base` ⊕ captured creation scope ⊕ params — base fills UNDER the captured
    /// snapshot (capture semantics hold), which is what lets a stored lambda call ITSELF
    /// (`const f = n => … f(n - 1)`: f is not in its own creation snapshot, so the caller's
    /// live scope supplies it).
    private fun callLambda(f: StackLambda, args: List<Any?>, store: StackStore, base: Map<String, Any?>? = null): Any? {
        val scope = if (base != null) HashMap<String, Any?>(base) else HashMap<String, Any?>()
        scope.putAll(f.captured)
        for ((k, p) in f.params.withIndex()) {
            if (p.rest && p.name != null) {
                // rest binds the REMAINING args as an array (empty when none)
                scope[p.name] = if (k < args.size) args.drop(k).map { it ?: NSNull } else emptyList<Any?>()
                continue
            }
            val a = if (k < args.size) args[k] else null
            if (p.name != null) {
                val def = p.def
                if (isMissing(a) && def != null && def.isNotEmpty()) {
                    // default — evaluated at CALL time in the CALLEE scope (earlier params visible)
                    scope[p.name] = Parser(def, store, scope).expression() ?: NSNull
                } else scope[p.name] = a ?: NSNull
            }
            else {
                val pat = p.pattern
                if (pat != null) {
                    bindPattern(pat, a, { n, v -> scope[n] = v ?: NSNull },
                                { toks -> Parser(toks, store, scope).expression() })
                } else {
                    val d = (a as? Map<String, Any?>) ?: emptyMap()
                    for (key in p.keys) scope[key] = d[key] ?: NSNull
                }
            }
        }
        if (f.block) { val e = JSEval(f.body, store, scope); e.runBlock(); return e.result }
        val p = Parser(f.body, store, scope)
        return p.expression()
    }

    /// Register every top-level `function name(params) { … }` in `body` as a callable user
    /// function — positional args, **depth-capped at 32** (so even an accidental recursion is
    /// bounded, never a hang). String-scanned so it's available the moment the node is processed.
    fun registerFunctions(body: String, store: StackStore) {
        scanFunctions(body) { name, fn -> store.functions[name] = fn }
    }

    /// The GLOBAL FUNCTION LIBRARY (js-core.md "Shared logic") — ONE app-wide function
    /// table shared by every surface. Resolved AFTER the surface's own `store.functions`
    /// (a surface-local name SHADOWS the global) and BEFORE the builtins.
    private val globalFunctions = HashMap<String, Any>()

    /// Register `body`'s top-level functions into the APP-WIDE table — validation/pricing/
    /// formatting written ONCE, callable from every surface. Same scanner, same shapes as
    /// registerFunctions; global registration does NOT capture scope (free names resolve
    /// against the CALLING surface's live store, exactly like top-level surface functions).
    /// Same fnDepth 32 guard at call time. Boot/modules call this once at startup;
    /// re-registration replaces (last write wins).
    fun registerGlobalFunctions(body: String) {
        scanFunctions(body) { name, fn -> globalFunctions[name] = fn }
    }

    /// Drop every globally registered function (tests; a full app reload).
    fun clearGlobalFunctions() {
        globalFunctions.clear()
    }

    /// The app-wide table's read side (the executors' shared lookup seam).
    fun globalFunction(name: String): Any? = globalFunctions[name]

    /// THE one function-declaration scanner (registerFunctions / registerGlobalFunctions
    /// both ride it): finds every top-level `function name(params) { … }` in `body` and
    /// hands the built lambda to `register`. Top-level functions are NOT closures —
    /// captured stays empty; free names resolve against the live store at call time.
    private fun scanFunctions(body: String, register: (String, StackLambda) -> Unit) {
        if (!body.contains("function")) return
        val s = body.toCharArray()
        var i = 0
        val kw = "function".toCharArray()
        fun isWord(c: Char): Boolean = c.isLetter() || c.isDigit() || c == '_'
        while (i < s.size) {
            val isKw = i + kw.size <= s.size &&
                (0 until kw.size).all { s[i + it] == kw[it] } &&
                (i == 0 || !isWord(s[i - 1])) &&
                (i + kw.size >= s.size || !isWord(s[i + kw.size]))
            if (!isKw) { i += 1; continue }
            var j = i + kw.size
            while (j < s.size && s[j].isWhitespace()) j += 1
            val name = StringBuilder()
            while (j < s.size && isWord(s[j])) { name.append(s[j]); j += 1 }
            while (j < s.size && s[j].isWhitespace()) j += 1
            if (j >= s.size || s[j] != '(') { i += 1; continue }
            var depth = 0
            val paramStr = StringBuilder()
            while (j < s.size) {                                      // params ( … )
                val ch = s[j]
                if (ch == '(') { depth += 1; if (depth == 1) { j += 1; continue } }
                if (ch == ')') { depth -= 1; if (depth == 0) { j += 1; break } }
                paramStr.append(ch); j += 1
            }
            while (j < s.size && s[j].isWhitespace()) j += 1
            if (j >= s.size || s[j] != '{') { i = j; continue }
            var bdepth = 0
            val bodyStr = StringBuilder()
            while (j < s.size) {                                      // body { … }
                val ch = s[j]
                if (ch == '{') { bdepth += 1; if (bdepth == 1) { j += 1; continue } }
                if (ch == '}') { bdepth -= 1; if (bdepth == 0) { j += 1; break } }
                bodyStr.append(ch); j += 1
            }
            val params = paramStr.toString().split(",")
                .map { LambdaParam(trimWhitespaceOnly(it), emptyList()) }
                .filter { !(it.name ?: "").isEmpty() }
            // Top-level functions are NOT closures (free names resolve against the live store) —
            // captured stays empty; only arrow values snapshot their creation scope.
            if (name.isNotEmpty()) register(name.toString(), StackLambda(params, tokenize(bodyStr.toString()), block = true, captured = emptyMap()))
            i = j
        }
    }

    /// The bounded-JS statement interpreter for a `{ }` body — `if (…) { } else if { } else { }`,
    /// braceless `if (c) return x`, `const`/`let`, `return`, nested `function` decls (skipped here;
    /// registered at the node), and bare expression statements (the last is the implicit value).
    /// Branches + BUDGETED loops (10000 iterations per evaluation, core-004) — a block
    /// is always total.
    private class LoopBudget { var used = 0 }

    private class JSEval(
        val t: List<Token>, val store: StackStore, scope: Map<String, Any?>,
        share: MutableMap<String, Any?>? = null, budget: LoopBudget? = null,
    ) {
        var i = 0
        var scope: MutableMap<String, Any?> = share ?: HashMap(scope)   // Swift value-copies the dict
        var result: Any? = null
        var done = false
        var flow: String? = null                                  // "break" | "continue" — consumed by the owning loop
        val budget: LoopBudget = budget ?: LoopBudget()

        fun cur(): Token? = if (i < t.size) t[i] else null
        fun isOp(s: String): Boolean { val tk = cur(); return tk is Token.Op && tk.v == s }
        fun isKw(s: String): Boolean { val tk = cur(); return tk is Token.Ident && tk.v == s }

        /// Run statements until end-of-tokens or a closing `}` (left for the caller to consume).
        fun runBlock() {
            while (!done && flow == null) {
                val tk = cur() ?: return
                if (tk is Token.Op && tk.v == "}") return
                if (tk is Token.Op && tk.v == ";") { i += 1; continue }
                val before = i
                statement(execute = true)
                if (i == before) i += 1   // guard a non-advancing statement (malformed) — never spin
            }
        }
        private fun skipBranch() {
            if (isOp("{")) {
                var d = 0
                while (true) {
                    val tk = cur() ?: return
                    if (tk is Token.Op && tk.v == "{") d += 1
                    else if (tk is Token.Op && tk.v == "}") { d -= 1; i += 1; if (d == 0) return; continue }
                    i += 1
                }
            } else {
                while (true) {
                    val tk = cur() ?: return
                    if (tk is Token.Op && tk.v == ";") { i += 1; return }
                    if (tk is Token.Op && tk.v == "}") return
                    i += 1
                }
            }
        }
        private fun branch(execute: Boolean) {
            if (!execute) { skipBranch(); return }
            if (isOp("{")) { i += 1; runBlock(); if (isOp("}")) i += 1 }
            else statement(execute = true)
        }
        private fun statement(execute: Boolean) {
            if (isKw("function")) { skipFunction(); return }
            if (isKw("if")) { ifStmt(execute); return }
            if (isKw("for")) { forStmt(execute); return }
            if (isKw("while")) { whileStmt(execute); return }
            if (isKw("do")) { doStmt(execute); return }
            if (isKw("break")) { i += 1; if (isOp(";")) i += 1; if (execute) flow = "break"; return }
            if (isKw("continue")) { i += 1; if (isOp(";")) i += 1; if (execute) flow = "continue"; return }
            if (isKw("const") || isKw("let") || isKw("var")) { declStmt(execute); return }
            if (isKw("return")) { returnStmt(execute); return }
            val toks = capture(setOf(";")); if (isOp(";")) i += 1
            if (execute && !done) exprStatement(toks)
        }
        private fun ifStmt(execute: Boolean) {
            i += 1                                                   // 'if'
            var cond = false
            val c = captureParen()
            if (execute) cond = truthy(evalExpr(c))
            branch(execute && cond)
            if (isKw("else")) {
                i += 1
                if (isKw("if")) ifStmt(execute && !cond)
                else branch(execute && !cond)
            }
        }
        private fun declStmt(execute: Boolean) {
            i += 1                                                   // 'const' / 'let' / 'var'
            val toks = capture(setOf(";")); if (isOp(";")) i += 1
            if (!execute) return
            // multi-declarators + NESTED destructuring with defaults and rest:
            // `let a = 1, b = 2` · `const { a: { b } } = o` · `const { a = 5, ...rest } = o` · `const [p, ...q] = arr`
            for (d in parseDeclarators(toks)) {
                val v = if (d.expr.isEmpty()) null else evalExpr(d.expr)
                bindPattern(
                    d.pattern, v,
                    { n, value -> scope[n] = value ?: NSNull },
                    // A `= default` evaluates in the SCOPE BEING BUILT, so an earlier position
                    // in the same pattern is visible to a later one's default — the JS rule.
                    { toks2 -> evalExpr(toks2) },
                )
            }
        }
        private fun returnStmt(execute: Boolean) {
            i += 1                                                   // 'return'
            val toks = capture(setOf(";")); if (isOp(";")) i += 1
            if (execute) { result = if (toks.isEmpty()) null else evalExpr(toks); done = true }
        }
        /// One loop iteration on the SHARED ledger — 10000 per block evaluation, the
        /// action runner's bounded-execution law. Past it every loop stops; total stays.
        private fun loopStep(): Boolean { budget.used += 1; return budget.used <= 10000 }

        /// Capture a loop body: a `{ … }` group (braces consumed) or one bare statement.
        private fun captureBranchTokens(): List<Token> {
            if (isOp("{")) {
                i += 1
                val out = ArrayList<Token>()
                var d = 1
                while (true) {
                    val tk = cur() ?: break
                    if (tk is Token.Op && tk.v == "{") d += 1
                    else if (tk is Token.Op && tk.v == "}") { d -= 1; if (d == 0) { i += 1; break } }
                    out.add(tk); i += 1
                }
                return out
            }
            val out = capture(setOf(";")); if (isOp(";")) i += 1
            return out
        }

        /// Run captured statements against THIS block's scope (shared, not copied) and
        /// its shared budget; a `return` settles this block, break/continue surface as
        /// flow for the owning loop to consume.
        private fun runCaptured(body: List<Token>) {
            val e = JSEval(body, store, emptyMap(), share = scope, budget = budget)
            e.runBlock()
            if (e.done) { result = e.result; done = true }
            flow = e.flow
        }

        private fun splitOnSemis(toks: List<Token>): List<List<Token>> {
            val out = ArrayList<List<Token>>()
            var cur = ArrayList<Token>()
            var d = 0
            for (tk in toks) {
                if (tk is Token.Op) {
                    if (tk.v == "(" || tk.v == "[" || tk.v == "{") d += 1
                    else if (tk.v == ")" || tk.v == "]" || tk.v == "}") d -= 1
                    else if (d == 0 && tk.v == ";") { out.add(cur); cur = ArrayList(); continue }
                }
                cur.add(tk)
            }
            out.add(cur)
            return out
        }

        /// `for (init; cond; step)` · `for ([const] pattern of expr)` · `for ([const] k
        /// in expr)` — the loop grammar in expression blocks (corpus core-004), budgeted,
        /// with the classic form gated on top-level `;` (a classic cond may contain the
        /// `in` OPERATOR).
        private fun forStmt(execute: Boolean) {
            i += 1                                                 // 'for'
            val head = captureParen()
            val body = captureBranchTokens()
            if (!execute) return
            val parts = splitOnSemis(head)
            if (parts.size == 3) {
                runCaptured(parts[0])
                if (done) return
                flow = null
                while (true) {
                    if (parts[1].isNotEmpty() && !truthy(evalExpr(parts[1]))) break
                    if (!loopStep()) break
                    runCaptured(body)
                    if (done) return
                    if (flow == "break") { flow = null; break }
                    flow = null
                    runCaptured(parts[2])
                    if (done) return
                    flow = null
                }
                return
            }
            var p = 0
            val first = head.getOrNull(p)
            if (first is Token.Ident && (first.v == "const" || first.v == "let" || first.v == "var")) p += 1
            var kwAt = -1
            var kind: String? = null
            var d = 0
            var k = p
            while (k < head.size) {
                val tk = head[k]
                if (tk is Token.Op) {
                    if (tk.v == "(" || tk.v == "[" || tk.v == "{") d += 1
                    else if (tk.v == ")" || tk.v == "]" || tk.v == "}") d -= 1
                }
                if (d == 0 && tk is Token.Ident && (tk.v == "of" || tk.v == "in")) { kwAt = k; kind = tk.v; break }
                k += 1
            }
            if (kwAt < 0 || kind == null) return
            val patToks = head.subList(p, kwAt)
            val exprToks = head.subList(kwAt + 1, head.size)
            val decls = parseDeclarators(patToks + listOf(Token.Op("="), Token.Num(0.0)))
            if (decls.size != 1) return
            val pattern = decls[0].pattern
            val seq = if (kind == "of") spreadValues(evalExpr(exprToks)) else forInKeys(evalExpr(exprToks))
            for (el in seq) {
                if (!loopStep()) break
                bindPattern(pattern, el, { n, value -> scope[n] = value ?: NSNull }, { toks2 -> evalExpr(toks2) })
                runCaptured(body)
                if (done) return
                if (flow == "break") { flow = null; break }
                flow = null
            }
        }

        private fun whileStmt(execute: Boolean) {
            i += 1                                                 // 'while'
            val cond = captureParen()
            val body = captureBranchTokens()
            if (!execute) return
            while (truthy(evalExpr(cond))) {
                if (!loopStep()) break
                runCaptured(body)
                if (done) return
                if (flow == "break") { flow = null; break }
                flow = null
            }
        }

        private fun doStmt(execute: Boolean) {
            i += 1                                                 // 'do'
            val body = captureBranchTokens()
            var cond: List<Token> = emptyList()
            if (isKw("while")) {
                i += 1
                cond = captureParen()
                if (isOp(";")) i += 1
            }
            if (!execute) return
            do {
                if (!loopStep()) break
                runCaptured(body)
                if (done) return
                if (flow == "break") { flow = null; break }
                flow = null
            } while (truthy(evalExpr(cond)))
        }

        private fun skipFunction() {
            while (true) {
                val tk = cur() ?: break
                if (tk is Token.Op && tk.v == "{") break
                i += 1
            }
            skipBranch()
        }
        private fun exprStatement(toks: List<Token>) {
            // destructuring assignment `[a, b] = [b, a]` — the declaration-less pattern write
            // (syntax-005): the same parseDeclarators shape a `const` reads, bound with the
            // assignment writer. RHS evaluates ONCE before any binding, so a swap is a swap.
            if (toks.size >= 4 && (toks[0] as? Token.Op)?.v == "[") {
                val decls = parseDeclarators(toks)
                val d0 = if (decls.size == 1) decls[0] else null
                val pat = d0?.pattern
                if (d0 != null && pat is DeclPattern.Arr && d0.expr.isNotEmpty() &&
                    (pat.items.any { it != null } || pat.rest != null)
                ) {
                    val v = evalExpr(d0.expr)
                    bindPattern(pat, v, { n, value -> scope[n] = value ?: NSNull },
                                { toks2 -> evalExpr(toks2) })
                    return
                }
            }
            // local assignment `x = e` (single ident LHS), else a bare expression (implicit value).
            if (toks.size >= 2) {
                val t0 = toks[0]; val t1 = toks[1]
                if (t0 is Token.Ident && !t0.v.contains(".") && t1 is Token.Op && t1.v == "=") {
                    scope[t0.v] = evalExpr(toks.drop(2)) ?: NSNull; return
                }
            }
            // BLOCK-SCOPE MUTATION (corpus core-003): dotted / computed-key / indexed
            // assignment into a scope name, compound assignment, ++/--, and statement-
            // position `.push(…)` all REBUILD the local (value semantics — never an
            // alias, never the store). The accumulator idioms, made real.
            val lead = toks.getOrNull(0)
            if (lead is Token.Op && (lead.v == "++" || lead.v == "--")) {
                if (pathMutation(toks.drop(1) + lead)) return      // prefix form → the postfix shape
            }
            if (pathMutation(toks)) return
            result = evalExpr(toks)
        }

        /// Parse and perform `NAME(seg…) op= rhs` / `NAME(seg…).push(args)`; true when
        /// handled. A dotted ident is ONE token (the tokenizer's dotted-ident rule), so
        /// static segments split out of the leading token and every post-bracket run.
        private fun pathMutation(toks: List<Token>): Boolean {
            val t0 = toks.getOrNull(0)
            if (toks.size < 2 || t0 !is Token.Ident) return false
            val head = t0.v.split(".")
            val name = head[0]
            // dsx.* / global.* / route.* / cookie.* are NAMESPACES, not block locals —
            // a block body never writes them (the evalBlock purity contract).
            if (name.isEmpty() || name == "dsx" || name == "global" || name == "route" || name == "cookie") return false
            val segs = ArrayList<Any>()                              // String (static) | List<Token> (computed)
            for (part in head.drop(1)) segs.add(part)
            var j = 1
            while (true) {
                val a = toks.getOrNull(j); val b = toks.getOrNull(j + 1)
                if (a is Token.Op && a.v == "." && b is Token.Ident) {
                    for (part in b.v.split(".")) segs.add(part); j += 2; continue
                }
                if (a is Token.Op && a.v == "[") {
                    val inner = ArrayList<Token>(); var d = 1; var k = j + 1
                    while (k < toks.size) {
                        val tk = toks[k]
                        if (tk is Token.Op && (tk.v == "[" || tk.v == "(" || tk.v == "{")) d += 1
                        if (tk is Token.Op && (tk.v == "]" || tk.v == ")" || tk.v == "}")) { d -= 1; if (d == 0) break }
                        inner.add(tk); k += 1
                    }
                    if (k >= toks.size) return false
                    segs.add(inner); j = k + 1; continue
                }
                break
            }
            val opTok = toks.getOrNull(j)
            // `x++` / `m.n--` — read-modify-write through the same path law.
            if (opTok is Token.Op && (opTok.v == "++" || opTok.v == "--") && j == toks.size - 1) {
                val parts = evalSegs(segs)
                val value = arith(getInLocal(baseFor(name), parts), 1.0, if (opTok.v == "++") "+" else "-")
                if (parts.isEmpty()) scope[name] = value ?: NSNull
                else scope[name] = setInLocal(baseFor(name), parts, value ?: NSNull)
                return true
            }
            // `path.push(a, b)` — statement-position growth of the local array (push has
            // no pure reading; pop/shift stay pure reads, stdlib-002). The whole
            // statement must be exactly the call.
            if (segs.isNotEmpty() && segs.last() == "push" && opTok is Token.Op && opTok.v == "(") {
                val inner = ArrayList<Token>(); var d = 1; var k = j + 1
                while (k < toks.size) {
                    val tk = toks[k]
                    if (tk is Token.Op && (tk.v == "(" || tk.v == "[" || tk.v == "{")) d += 1
                    if (tk is Token.Op && (tk.v == ")" || tk.v == "]" || tk.v == "}")) { d -= 1; if (d == 0) break }
                    inner.add(tk); k += 1
                }
                if (d != 0 || k != toks.size - 1) return false
                segs.removeAt(segs.size - 1)
                val parts = evalSegs(segs)
                val arr = ArrayList(asArray(getInLocal(baseFor(name), parts)))
                for (run in splitTopLevelTokens(inner)) if (run.isNotEmpty()) arr.add(evalExpr(run) ?: NSNull)
                scope[name] = setInLocal(baseFor(name), parts, arr)
                return true
            }
            if (opTok !is Token.Op) return false
            if (opTok.v != "=" && opTok.v != "+=" && opTok.v != "-=" && opTok.v != "*=" && opTok.v != "/=" && opTok.v != "%=") return false
            val rhsToks = toks.drop(j + 1)
            if (rhsToks.isEmpty()) return false
            val rhs = evalExpr(rhsToks)
            val parts = evalSegs(segs)
            val value = if (opTok.v == "=") rhs
                        else arith(getInLocal(baseFor(name), parts), rhs, opTok.v.substring(0, 1))
            if (parts.isEmpty()) { scope[name] = value ?: NSNull; return true }
            scope[name] = setInLocal(baseFor(name), parts, value ?: NSNull)
            return true
        }

        /// The container a path write rebuilds from: the block's own binding, else the
        /// normal lookup (a caller-scope name copies in on first write — the evalBlock
        /// purity contract: reads shadow, writes stay local).
        private fun baseFor(name: String): Any? =
            if (scope.containsKey(name)) scope[name] else evalExpr(listOf(Token.Ident(name)))

        /// Path segments to keys: a static ident stays a string, a computed `[e]`
        /// evaluates in this scope.
        private fun evalSegs(segs: List<Any>): List<Any?> = segs.map { seg ->
            if (seg is String) seg else @Suppress("UNCHECKED_CAST") evalExpr(seg as List<Token>)
        }

        /// Walk `parts` into `container` — the read twin of setInLocal; missing → null.
        private fun getInLocal(container: Any?, parts: List<Any?>): Any? {
            var cur: Any? = container
            for (p in parts) {
                cur = when {
                    cur is List<*> -> {
                        val idx = number(p)
                        if (idx != null && idx >= 0 && idx < cur.size) cur[idx.toInt()] else null
                    }
                    cur is Map<*, *> -> @Suppress("UNCHECKED_CAST") (cur as Map<String, Any?>)[string(p)]
                    else -> return null
                }
            }
            return cur
        }

        /// Rebuild `container` with `parts` set to `value` — BY COPY at every level
        /// (value semantics: a block-scope path write never aliases another binding).
        /// A numeric part indexes an array (in bounds, or appends at exactly length);
        /// anything else keys a dict; a missing nest is created — total, never a throw.
        private fun setInLocal(container: Any?, parts: List<Any?>, value: Any?): Any? {
            if (parts.isEmpty()) return value
            val headSeg = parts[0]
            val rest = parts.drop(1)
            if (container is List<*>) {
                val idx = number(headSeg)
                if (idx != null) {
                    val iN = idx.toInt()
                    val copy = ArrayList<Any?>(container)
                    if (iN in 0 until copy.size) copy[iN] = setInLocal(copy[iN], rest, value)
                    else if (iN == copy.size) copy.add(setInLocal(null, rest, value))
                    return copy
                }
            }
            @Suppress("UNCHECKED_CAST")
            val d = if (container is Map<*, *>) LinkedHashMap(container as Map<String, Any?>)
                    else LinkedHashMap<String, Any?>()
            val key = string(headSeg)
            d[key] = setInLocal(d[key], rest, value)
            return d
        }

        /// Split a token run on top-level commas (argument lists in block statements).
        private fun splitTopLevelTokens(toks: List<Token>): List<List<Token>> {
            val out = ArrayList<List<Token>>()
            var cur = ArrayList<Token>()
            var d = 0
            for (tk in toks) {
                if (tk is Token.Op) {
                    if (tk.v == "(" || tk.v == "[" || tk.v == "{") d += 1
                    else if (tk.v == ")" || tk.v == "]" || tk.v == "}") d -= 1
                    else if (d == 0 && tk.v == ",") { out.add(cur); cur = ArrayList(); continue }
                }
                cur.add(tk)
            }
            out.add(cur)
            return out
        }
        /// Collect tokens up to a top-level stop op (depth-aware); does NOT consume the stop.
        private fun capture(stops: Set<String>): List<Token> {
            val out = ArrayList<Token>()
            var d = 0
            while (true) {
                val tk = cur() ?: break
                if (tk is Token.Op) {
                    val o = tk.v
                    if (o == "(" || o == "[" || o == "{") { d += 1; out.add(tk); i += 1; continue }
                    if (o == ")" || o == "]" || o == "}") { if (d == 0) break; d -= 1; out.add(tk); i += 1; continue }
                    if (d == 0 && o in stops) break
                }
                out.add(tk); i += 1
            }
            return out
        }
        /// Collect the contents of a `( … )` group (consumes both parens), depth-aware.
        private fun captureParen(): List<Token> {
            val out = ArrayList<Token>()
            if (!isOp("(")) return out
            i += 1
            var d = 1
            while (true) {
                val tk = cur() ?: break
                if (tk is Token.Op && tk.v == "(") d += 1
                else if (tk is Token.Op && tk.v == ")") { d -= 1; if (d == 0) { i += 1; break } }
                out.add(tk); i += 1
            }
            return out
        }
        private fun evalExpr(toks: List<Token>): Any? {
            val p = Parser(toks, store, scope)
            return p.expression()
        }
    }

    // MARK: tokens + parser

    private sealed class TemplatePart {
        data class Lit(val s: String) : TemplatePart()
        data class Expr(val toks: List<Token>) : TemplatePart()
    }

    private sealed class Token {
        data class Num(val v: Double) : Token()
        data class Str(val v: String) : Token()
        data class Ident(val v: String) : Token()
        data class Op(val v: String) : Token()
        data class Regex(val pattern: String, val flags: String) : Token()
        data class Template(val parts: List<TemplatePart>) : Token()
    }

    // ── the shared source preprocessor (comments, then ASI) — twin of tokens.ts ──────
    // Every tokenize entry runs it; the statement runner additionally runs the comment
    // pass at the string level before jsLeaf (JseRunner.stripJSComments).

    /// `/` starts a regex literal at CHAR level — prefix position = no previous
    /// significant char, or an operator char that is not a value terminator.
    private fun charAllowsRegex(prev: Char?): Boolean {
        if (prev == null) return true
        if (prev.isLetter() || prev.isDigit() || prev == '_') return false
        return prev != ')' && prev != ']' && prev != '\'' && prev != '"' && prev != '`'
    }

    /// Keywords a regex literal may DIRECTLY follow (`return /ab/.test(s)`, `case /a/…`,
    /// `typeof /x/`) — shared by the char-level scanners and the token-level rule.
    private val regexKeywords = setOf("return", "case", "typeof", "in", "of", "do", "else", "throw")

    /// Char-level companion to charAllowsRegex: when the previous significant char is a
    /// word char, scan the word back in the emitted buffer (bounded) — a keyword still
    /// puts the `/` in regex position (`return /ab/`), an ident/number does not (`x / 2`).
    private fun regexAfterKeyword(out: StringBuilder): Boolean {
        var t = out.length - 1
        while (t >= 0 && out[t].isWhitespace()) t -= 1
        val w = StringBuilder()
        while (t >= 0 && isWordChar(out[t]) && w.length <= 8) { w.insert(0, out[t]); t -= 1 }
        if (t >= 0 && isWordChar(out[t])) return false            // longer word — not one of ours
        return w.toString() in regexKeywords
    }

    private fun isWordChar(c: Char): Boolean = c.isLetter() || c.isDigit() || c == '_'

    /// Scan a regex literal starting at the `/` at `i` (backslash pairs + [class] aware).
    /// Returns the index one past the flags, or -1 if unterminated (→ it was division).
    private fun scanRegexEnd(c: CharArray, i: Int): Int {
        var j = i + 1
        var inClass = false
        var closed = false
        while (j < c.size) {
            val rc = c[j]
            if (rc == '\\' && j + 1 < c.size) { j += 2; continue }
            if (rc == '[') inClass = true
            if (rc == ']') inClass = false
            if (rc == '/' && !inClass) { closed = true; j += 1; break }
            if (rc == '\n') break                               // literals don't span lines
            j += 1
        }
        if (!closed || j == i + 1) return -1
        while (j < c.size && c[j].isLetter()) j += 1
        return j
    }

    /// Copy a quoted span (`'` / `"`) verbatim, honoring backslash pairs.
    private fun copyQuoted(c: CharArray, i: Int, out: StringBuilder): Int {
        val q = c[i]
        out.append(q)
        var j = i + 1
        while (j < c.size) {
            val ch = c[j]
            if (ch == '\\' && j + 1 < c.size) { out.append(ch); out.append(c[j + 1]); j += 2; continue }
            out.append(ch)
            j += 1
            if (ch == q) break
        }
        return j
    }

    /// Copy a template span verbatim (`` ` `` … `` ` ``), honoring backslash pairs and
    /// `${ }` hole depth so a `}` or backtick inside a hole doesn't close it. Inside a
    /// hole, quoted spans delegate to copyQuoted and nested backticks recurse (a `'{'`
    /// string literal in a hole must not skew the depth); recursion is depth-capped
    /// (past ~32 a backtick copies as a plain char — bounded, never a stack overflow).
    private fun copyTemplate(c: CharArray, i: Int, out: StringBuilder, depth: Int = 0): Int {
        out.append('`')
        var j = i + 1
        var hole = 0
        while (j < c.size) {
            val ch = c[j]
            if (ch == '\\' && j + 1 < c.size) { out.append(ch); out.append(c[j + 1]); j += 2; continue }
            if (hole == 0 && ch == '`') { out.append(ch); j += 1; break }
            if (hole > 0 && (ch == '\'' || ch == '"')) { j = copyQuoted(c, j, out); continue }
            if (hole > 0 && ch == '`' && depth < 32) { j = copyTemplate(c, j, out, depth + 1); continue }
            if (ch == '$' && j + 1 < c.size && c[j + 1] == '{') { out.append("\${"); hole += 1; j += 2; continue }
            if (hole > 0 && ch == '{') hole += 1
            if (hole > 0 && ch == '}') hole -= 1
            out.append(ch)
            j += 1
        }
        return j
    }

    /// Pass 1 — strip JS comments: `// …` to end of line (newline kept — it is the
    /// statement break) and `/* … */` to ONE space. Quote-, template- and regex-literal-
    /// aware; `://` is protocol syntax, never a comment.
    internal fun stripComments(s: String): String {
        if (!s.contains("//") && !s.contains("/*")) return s
        val c = s.toCharArray()
        val out = StringBuilder()
        var i = 0
        var prevSig: Char? = null
        while (i < c.size) {
            val ch = c[i]
            if (ch == '\'' || ch == '"') { i = copyQuoted(c, i, out); prevSig = ch; continue }
            if (ch == '`') { i = copyTemplate(c, i, out); prevSig = '`'; continue }
            if (ch == '/' && i + 1 < c.size && c[i + 1] == '/' && prevSig != ':') {
                while (i < c.size && c[i] != '\n') i += 1       // drop to EOL (keep the newline)
                continue
            }
            if (ch == '/' && i + 1 < c.size && c[i + 1] == '*') {
                i += 2
                while (i + 1 < c.size && !(c[i] == '*' && c[i + 1] == '/')) i += 1
                i = minOf(i + 2, c.size)
                out.append(' ')                                 // never glue the surrounding tokens
                continue
            }
            if (ch == '/' && (charAllowsRegex(prevSig) || (prevSig != null && isWordChar(prevSig) && regexAfterKeyword(out)))) {
                val end = scanRegexEnd(c, i)
                if (end > 0) {
                    var k = i
                    while (k < end) { out.append(c[k]); k += 1 }
                    prevSig = c[end - 1]
                    i = end
                    continue
                }
            }
            out.append(ch)
            if (!ch.isWhitespace()) prevSig = ch
            i += 1
        }
        return out.toString()
    }

    /// Pass 0 — decode the XML OPERATOR entities. A code body arrives RAW from the markup
    /// reader on every renderer (code tags are lifted 1:1), so an author who spells `&&`
    /// as `&amp;&amp;` (attribute muscle memory) hands the lexer `& amp ; & amp ;`:
    /// bitwise ops over an `amp` identifier that silently evaluate to 0 (the wave-7 F4
    /// "0" write). The three entities with OPERATOR meaning decode here, outside
    /// string/template/regex literals only. `&quot;`/`&apos;` stay untouched (decoding
    /// them would move literal boundaries) and a bare `&` stays literal — the markup
    /// reader's smart-entity rule, mirrored. Corpus: jse/syntax-006.json (three runners).
    internal fun decodeOperatorEntities(s: String): String {
        if (!s.contains("&amp;") && !s.contains("&lt;") && !s.contains("&gt;")) return s
        val c = s.toCharArray()
        val out = StringBuilder()
        var i = 0
        var prevSig: Char? = null
        while (i < c.size) {
            val ch = c[i]
            if (ch == '\'' || ch == '"') { i = copyQuoted(c, i, out); prevSig = ch; continue }
            if (ch == '`') { i = copyTemplate(c, i, out); prevSig = '`'; continue }
            if (ch == '/' && (charAllowsRegex(prevSig) || (prevSig != null && isWordChar(prevSig) && regexAfterKeyword(out)))) {
                val end = scanRegexEnd(c, i)
                if (end > 0) {
                    var k = i
                    while (k < end) { out.append(c[k]); k += 1 }
                    prevSig = c[end - 1]
                    i = end
                    continue
                }
            }
            if (ch == '&') {
                val rest = String(c, i + 1, minOf(4, c.size - i - 1))
                val op = when {
                    rest.startsWith("amp;") -> '&'
                    rest.startsWith("lt;") -> '<'
                    rest.startsWith("gt;") -> '>'
                    else -> null
                }
                if (op != null) {
                    out.append(op)
                    prevSig = op
                    i += if (op == '&') 5 else 4
                    continue
                }
            }
            out.append(ch)
            if (!ch.isWhitespace()) prevSig = ch
            i += 1
        }
        return out.toString()
    }

    /// The jsLeaf continuation heuristic (the statement runners' ASI rule), char-level.
    private fun lineContinues(out: StringBuilder, c: CharArray, after: Int): Boolean {
        var t = out.length - 1
        while (t >= 0 && (out[t] == ' ' || out[t] == '\t' || out[t] == '\r')) t -= 1
        if (t >= 0) {
            val last = out[t]
            val isIncDec = (last == '+' || last == '-') && t >= 1 && out[t - 1] == last
            if (!isIncDec && last in "+-*/%&|<>=!?:,.") return true
        }
        var j = after + 1
        while (j < c.size && c[j].isWhitespace()) j += 1
        if (j >= c.size) return false
        val ch = c[j]
        if (ch == '.' || ch == '?' || ch == ':') return true
        if ((ch == '&' || ch == '|') && j + 1 < c.size && c[j + 1] == ch) return true
        return false
    }

    /// Scan the WORD that starts the next line (past whitespace) — bounded.
    private fun nextWord(c: CharArray, after: Int): String {
        var j = after + 1
        while (j < c.size && c[j].isWhitespace()) j += 1
        val w = StringBuilder()
        while (j < c.size && isWordChar(c[j]) && w.length <= 8) { w.append(c[j]); j += 1 }
        return w.toString()
    }

    /// True when the `{` being pushed opens a `do` block (the word before it is `do`).
    private fun braceOpensDo(out: StringBuilder): Boolean {
        var t = out.length - 1
        while (t >= 0 && out[t].isWhitespace()) t -= 1
        if (t < 1 || out[t] != 'o' || out[t - 1] != 'd') return false
        return t - 2 < 0 || !isWordChar(out[t - 2])
    }

    /// A newline here must NOT become `;` because the next line's keyword ATTACHES to the
    /// just-closed `{ }` block: `}` + `else`/`catch`/`finally` (an if/try branch), and `}`
    /// + `while` when that brace closed a `do` block. Braceless branches keep the `;` —
    /// there the separator is load-bearing (the statement capture stops at it).
    private fun keywordJoinsBlock(c: CharArray, after: Int, prevSig: Char?, closedDo: Boolean): Boolean {
        if (prevSig != '}') return false
        val w = nextWord(c, after)
        if (w == "else" || w == "catch" || w == "finally") return true
        return w == "while" && closedDo
    }

    /// Pass 2 — ASI: replace each statement-boundary newline with `;`. A newline is a
    /// boundary only at bracket-stack depth zero or directly inside a `{ }` body (never
    /// inside `( )` / `[ ]`, where newlines stay soft), and only when the continuation
    /// heuristic says the statement is complete. Never before a line whose
    /// `else`/`while`/`catch`/`finally` attaches to the `}` block just closed.
    internal fun asiSemicolons(s: String): String {
        if (!s.contains('\n')) return s
        val c = s.toCharArray()
        val out = StringBuilder()
        val stack = ArrayList<Char>()                        // '(' / '[' / '{' / 'D' (a `{` opened by `do`)
        var i = 0
        var prevSig: Char? = null
        var justClosedDo = false                             // the last significant char was a `}` closing a do-block
        while (i < c.size) {
            val ch = c[i]
            if (ch == '\'' || ch == '"') { i = copyQuoted(c, i, out); prevSig = ch; justClosedDo = false; continue }
            if (ch == '`') { i = copyTemplate(c, i, out); prevSig = '`'; justClosedDo = false; continue }
            if (ch == '/' && (charAllowsRegex(prevSig) || (prevSig != null && isWordChar(prevSig) && regexAfterKeyword(out)))) {
                val end = scanRegexEnd(c, i)
                if (end > 0) {
                    var k = i
                    while (k < end) { out.append(c[k]); k += 1 }
                    prevSig = c[end - 1]
                    justClosedDo = false
                    i = end
                    continue
                }
            }
            var closesDo = false
            if (ch == '(' || ch == '[' || ch == '{') stack.add(if (ch == '{' && braceOpensDo(out)) 'D' else ch)
            else if (ch == ')' || ch == ']' || ch == '}') {
                if (stack.isNotEmpty()) {
                    val p = stack.removeAt(stack.size - 1)
                    closesDo = ch == '}' && p == 'D'
                }
            }
            else if (ch == '\n') {
                val innermost = stack.lastOrNull()
                if ((innermost == null || innermost == '{' || innermost == 'D') && !lineContinues(out, c, i) &&
                    !keywordJoinsBlock(c, i, prevSig, justClosedDo)
                ) {
                    out.append(';')
                    i += 1
                    continue
                }
            }
            out.append(ch)
            if (!ch.isWhitespace()) { prevSig = ch; justClosedDo = closesDo }
            i += 1
        }
        return out.toString()
    }

    /// The shared entry: lone `\r` line endings normalized, operator entities decoded,
    /// comments out, then statement-boundary newlines to `;`.
    internal fun preprocessSource(s: String): String {
        val normalized = if (s.contains('\r')) s.replace(Regex("\\r(?!\\n)"), "\n") else s
        return asiSemicolons(stripComments(decodeOperatorEntities(normalized)))
    }

    // ── string-literal escapes (the JS set; unknown escape = the char itself) ────────

    private fun isHexChar(ch: Char): Boolean = ch.isDigit() || ch in 'a'..'f' || ch in 'A'..'F'

    /// `c[j]` is the char AFTER the backslash; appends the unescaped text and returns
    /// the next index to resume at.
    private fun unescapeInto(str: StringBuilder, c: CharArray, j: Int): Int {
        when (val e = c[j]) {
            'n' -> { str.append('\n'); return j + 1 }
            't' -> { str.append('\t'); return j + 1 }
            'r' -> { str.append('\r'); return j + 1 }
            'b' -> { str.append('\b'); return j + 1 }
            'f' -> { str.append('\u000C'); return j + 1 }
            'v' -> { str.append('\u000B'); return j + 1 }
            '0' -> { str.append('\u0000'); return j + 1 }
            '\n' -> return j + 1                                // line continuation
            'x' -> {
                if (j + 2 < c.size && isHexChar(c[j + 1]) && isHexChar(c[j + 2])) {
                    str.append(String(charArrayOf(c[j + 1], c[j + 2])).toInt(16).toChar())
                    return j + 3
                }
                str.append(e); return j + 1
            }
            'u' -> {
                if (j + 1 < c.size && c[j + 1] == '{') {
                    var k = j + 2
                    val hex = StringBuilder()
                    while (k < c.size && isHexChar(c[k])) { hex.append(c[k]); k += 1 }
                    if (k < c.size && c[k] == '}' && hex.length in 1..6) {
                        val cp = hex.toString().toInt(16)
                        if (cp <= 0x10FFFF) { str.appendCodePoint(cp); return k + 1 }
                    }
                    str.append(e); return j + 1
                }
                if (j + 4 < c.size && isHexChar(c[j + 1]) && isHexChar(c[j + 2]) &&
                    isHexChar(c[j + 3]) && isHexChar(c[j + 4])) {
                    str.append(String(c, j + 1, 4).toInt(16).toChar())
                    return j + 5
                }
                str.append(e); return j + 1
            }
            else -> { str.append(e); return j + 1 }             // \' \" \` \\ \/ and every unknown → the char
        }
    }

    // ── numeric literals ─────────────────────────────────────────────────────────────

    /// ASCII digits only — the number path must never trigger on Unicode numerics (½ ٣),
    /// which lex as plain op chars on every kernel (Char.isDigit() is Unicode Nd).
    private fun isAsciiDigit(ch: Char): Boolean = ch in '0'..'9'

    /// Scan a numeric literal at `i` (a digit, or `.` + digit). Underscore separators
    /// are consumed only BETWEEN digits of the active alphabet. Returns value + next index.
    private fun scanNumber(c: CharArray, i: Int): Pair<Double, Int> {
        fun radix(pfx: Char, digit: (Char) -> Boolean, base: Int): Pair<Double, Int>? {
            if (!(c[i] == '0' && i + 1 < c.size && (c[i + 1] == pfx || c[i + 1] == pfx.uppercaseChar()))) return null
            var j = i + 2
            var any = false
            var v = 0.0
            while (j < c.size) {
                val ch = c[j]
                if (digit(ch)) { v = v * base + Character.digit(ch, base); any = true; j += 1; continue }
                if (ch == '_' && any && j + 1 < c.size && digit(c[j + 1])) { j += 1; continue }
                break
            }
            if (!any) return null                               // bare `0x` → the plain 0, `x…` lexes on
            return Pair(v, j)
        }
        radix('x', ::isHexChar, 16)?.let { return it }
        radix('b', { it == '0' || it == '1' }, 2)?.let { return it }
        radix('o', { it in '0'..'7' }, 8)?.let { return it }
        // decimal: digits [. digits] [ (e|E) [+-] digits ] with `_` between digits —
        // ASCII digits only (a trailing ٣ must lex on as its own op char, like TS/Swift)
        var j = i
        val n = StringBuilder()
        var seenDot = false
        while (j < c.size) {
            val ch = c[j]
            if (isAsciiDigit(ch)) { n.append(ch); j += 1; continue }
            if (ch == '.' && !seenDot && j + 1 < c.size && isAsciiDigit(c[j + 1])) { seenDot = true; n.append(ch); j += 1; continue }
            if (ch == '.' && !seenDot && n.isNotEmpty()) { seenDot = true; n.append(ch); j += 1; continue } // trailing `1.`
            if (ch == '_' && n.isNotEmpty() && isAsciiDigit(c[j - 1]) && j + 1 < c.size && isAsciiDigit(c[j + 1])) { j += 1; continue }
            break
        }
        if (j < c.size && (c[j] == 'e' || c[j] == 'E')) {
            var k = j + 1
            if (k < c.size && (c[k] == '+' || c[k] == '-')) k += 1
            if (k < c.size && isAsciiDigit(c[k])) {
                n.append(c[j])
                var m = j + 1
                while (m < c.size && (isAsciiDigit(c[m]) || ((c[m] == '+' || c[m] == '-') && m == j + 1))) { n.append(c[m]); m += 1 }
                j = m
            }
        }
        return Pair(swiftDouble(n.toString()) ?: 0.0, j)
    }

    // ── the tokenizer ────────────────────────────────────────────────────────────────

    private fun tokenize(s: String): List<Token> = tokenizeRaw(preprocessSource(s))

    private fun tokenizeRaw(s: String, holeDepth: Int = 0): List<Token> {
        val toks = ArrayList<Token>()
        val c = s.toCharArray()
        var i = 0
        val threeCharOps = listOf("===", "!==", ">>>", "**=", "...")
        val twoCharOps = listOf(
            "==", "!=", "<=", ">=", "&&", "||", "=>",
            "**", "??", "?.", "<<", ">>", "++", "--", "+=", "-=", "*=", "/=", "%=",
        )
        while (i < c.size) {
            val ch = c[i]
            if (ch.isWhitespace()) { i += 1; continue }
            if (ch == '\'' || ch == '"') {                     // string literal — JS escape grammar
                val q = ch; i += 1
                val str = StringBuilder()
                while (i < c.size && c[i] != q) {
                    if (c[i] == '\\' && i + 1 < c.size) { i = unescapeInto(str, c, i + 1); continue }
                    str.append(c[i]); i += 1
                }
                if (i < c.size) i += 1                          // closing quote
                toks.add(Token.Str(str.toString())); continue
            }
            if (ch == '`') {                                    // template literal
                i += 1
                val parts = ArrayList<TemplatePart>()
                var lit = StringBuilder()
                while (i < c.size && c[i] != '`') {
                    if (c[i] == '\\' && i + 1 < c.size) { i = unescapeInto(lit, c, i + 1); continue }
                    if (c[i] == '$' && i + 1 < c.size && c[i + 1] == '{') {
                        if (lit.isNotEmpty()) { parts.add(TemplatePart.Lit(lit.toString())); lit = StringBuilder() }
                        i += 2
                        var depth = 1
                        val src = StringBuilder()
                        while (i < c.size) {
                            val hc = c[i]
                            if (hc == '\'' || hc == '"') { i = copyQuoted(c, i, src); continue }
                            if (hc == '`') { i = copyTemplate(c, i, src); continue }
                            if (hc == '{') depth += 1
                            else if (hc == '}') { depth -= 1; if (depth == 0) { i += 1; break } }
                            src.append(hc)
                            i += 1
                        }
                        // hole recursion is depth-capped (~32): past it the hole rides as
                        // literal text — bounded, never a stack overflow on adversarial nesting
                        if (holeDepth < 32) parts.add(TemplatePart.Expr(tokenizeRaw(src.toString(), holeDepth + 1)))
                        else parts.add(TemplatePart.Lit(src.toString()))
                        continue
                    }
                    lit.append(c[i]); i += 1
                }
                if (i < c.size) i += 1                          // closing backtick
                if (lit.isNotEmpty()) parts.add(TemplatePart.Lit(lit.toString()))
                toks.add(Token.Template(parts)); continue
            }
            if (isAsciiDigit(ch) || (ch == '.' && i + 1 < c.size && isAsciiDigit(c[i + 1]))) {
                val (v, next) = scanNumber(c, i)
                if (next == i) { i += 1; continue }        // belt-and-braces: never stall
                toks.add(Token.Num(v)); i = next; continue
            }
            if (ch.isLetter() || ch == '_') {      // identifier / dotted path (dsx.this, item.index…)
                val id = StringBuilder()
                while (i < c.size && (c[i].isLetter() || c[i].isDigit() || c[i] == '_' || c[i] == '.')) { id.append(c[i]); i += 1 }
                toks.add(Token.Ident(id.toString())); continue
            }
            if (ch == '/') {
                // Regex literal vs division — the standard JS lexer heuristic: a `/` in PREFIX
                // position starts a regex; after a value (or postfix `++`/`--`) it's division.
                // A keyword ident (`return` / `case` / `typeof` / …) is prefix position too.
                // `//` and `/*` never start a regex (comments — already stripped upstream).
                val prevAllowsRegex = when (val last = toks.lastOrNull()) {
                    null -> true
                    is Token.Op -> last.v != ")" && last.v != "]" && last.v != "++" && last.v != "--"
                    is Token.Ident -> last.v in regexKeywords
                    else -> false
                }
                if (prevAllowsRegex && i + 1 < c.size && c[i + 1] != '/' && c[i + 1] != '*') {
                    var j = i + 1
                    val pat = StringBuilder()
                    var inClass = false
                    var closed = false
                    while (j < c.size) {
                        val rc = c[j]
                        if (rc == '\\' && j + 1 < c.size) { pat.append(rc); pat.append(c[j + 1]); j += 2; continue }
                        if (rc == '[') inClass = true
                        if (rc == ']') inClass = false
                        if (rc == '/' && !inClass) { closed = true; j += 1; break }
                        if (rc == '\n') break                   // literals don't span lines
                        pat.append(rc); j += 1
                    }
                    if (closed && pat.isNotEmpty()) {
                        val flags = StringBuilder()
                        while (j < c.size && c[j].isLetter()) { flags.append(c[j]); j += 1 }
                        toks.add(Token.Regex(pat.toString(), flags.toString())); i = j; continue
                    }
                }
            }
            if (i + 2 < c.size && String(charArrayOf(ch, c[i + 1], c[i + 2])) in threeCharOps) {
                toks.add(Token.Op(String(charArrayOf(ch, c[i + 1], c[i + 2])))); i += 3; continue
            }
            if (i + 1 < c.size && String(charArrayOf(ch, c[i + 1])) in twoCharOps) {
                val two = String(charArrayOf(ch, c[i + 1]))
                // `?.` followed by a digit is a ternary + number (`x ?.5 : y`), the JS lookahead rule
                if (two == "?." && i + 2 < c.size && c[i + 2].isDigit()) {
                    toks.add(Token.Op("?")); i += 1; continue
                }
                toks.add(Token.Op(two)); i += 2; continue
            }
            toks.add(Token.Op(ch.toString())); i += 1          // single-char op / paren
        }
        return toks
    }

    private class Parser(val tokens: List<Token>, val store: StackStore, val item: Map<String, Any?>?) {
        var pos = 0
        var depth = 0                                        // expression-nesting budget — see expression()

        fun peek(): Token? = if (pos < tokens.size) tokens[pos] else null
        fun advance() { pos += 1 }
        fun op(s: String): Boolean { val t = peek(); return t is Token.Op && t.v == s }
        fun anyOp(list: List<String>): String? {
            val t = peek()
            return if (t is Token.Op && t.v in list) t.v else null
        }

        fun expression(): Any? {
            // a leading `;` is statement residue (a stripped comment's newline) — skip it
            while (op(";")) advance()
            // recursion budget: 500 nested parens must yield null, never a blown stack
            // (the twins share the 200 cap; past it the parse abandons — total, not fatal)
            if (depth >= 200) return null
            depth += 1
            val v = ternary()
            depth -= 1
            return v
        }

        fun ternary(): Any? {
            val cond = nullish()
            if (!op("?")) return cond
            advance(); val a = expression()
            if (op(":")) advance()
            val b = expression()
            return if (truthy(cond)) a else b
        }
        fun nullish(): Any? {
            var l = logicalOr()
            while (op("??")) { advance(); val r = logicalOr(); l = if (isMissing(l)) r else l }
            return l
        }
        fun logicalOr(): Any? {
            var l = logicalAnd()
            while (op("||")) { advance(); val r = logicalAnd(); l = if (truthy(l)) l else r }
            return l
        }
        fun logicalAnd(): Any? {
            var l = bitOr()
            while (op("&&")) { advance(); val r = bitOr(); l = if (truthy(l)) r else l }
            return l
        }
        fun bitOr(): Any? {
            var l = bitXor()
            while (op("|")) { advance(); l = bitOp(l, bitXor(), "|") }
            return l
        }
        fun bitXor(): Any? {
            var l = bitAnd()
            while (op("^")) { advance(); l = bitOp(l, bitAnd(), "^") }
            return l
        }
        fun bitAnd(): Any? {
            var l = equality()
            while (op("&")) { advance(); l = bitOp(l, equality(), "&") }
            return l
        }
        fun equality(): Any? {
            // `===`/`!==` share equals(): JSE values are already typed (Bool/Double/String),
            // so the loose/strict distinction has no coercion gap to encode here — but the
            // tokenizer MUST know the three-char forms, else `a !== b` lexes as `a != = b`.
            var l = comparison()
            while (true) {
                val o = anyOp(listOf("===", "!==", "==", "!=")) ?: break
                advance(); val r = comparison(); val eq = equals(l, r); l = if (o.startsWith("!")) !eq else eq
            }
            return l
        }
        fun comparison(): Any? {
            var l = shift()
            while (true) {
                val o = anyOp(listOf("<", "<=", ">", ">="))
                if (o != null) { advance(); l = compare(l, shift(), o); continue }
                val t = peek()
                if (t is Token.Ident && t.v == "in") {           // JS `in` — relational level
                    advance(); l = inOp(l, shift()); continue
                }
                break
            }
            return l
        }
        fun shift(): Any? {
            var l = additive()
            while (true) {
                val o = anyOp(listOf("<<", ">>", ">>>")) ?: break
                advance(); l = bitOp(l, additive(), o)
            }
            return l
        }
        fun additive(): Any? {
            var l = multiplicative()
            while (true) {
                val o = anyOp(listOf("+", "-")) ?: break
                advance(); l = arith(l, multiplicative(), o)
            }
            return l
        }
        fun multiplicative(): Any? {
            var l = power()
            while (true) {
                val o = anyOp(listOf("*", "/", "%")) ?: break
                advance(); l = arith(l, power(), o)
            }
            return l
        }
        fun power(): Any? {
            val l = unary()
            if (!op("**")) return l
            advance()
            return powOp(l, power())                            // right-associative: 2 ** 3 ** 2 = 512
        }
        fun unary(): Any? {
            if (op("!")) { advance(); return !truthy(unary()) }
            if (op("-")) { advance(); return -(number(unary()) ?: 0.0) }
            if (op("+")) { advance(); return number(unary()) ?: 0.0 }
            if (op("~")) { advance(); return bitNot(unary()) }
            // JS `typeof x` — a reserved unary word (never an author variable), so runtime type
            // branching works on heterogeneous data: 'number'/'string'/'boolean'/'object'/
            // 'function'/'undefined'. `typeof(x)` parses the same way (operator + paren expr).
            val t = peek()
            if (t is Token.Ident && t.v == "typeof") { advance(); return typeofString(unary()) }
            return primary()
        }
        fun primary(): Any? {
            var base = primaryBase()
            // Postfix chaining — JS `arr[i]`, `obj['k']`, `x.length`, and method calls
            // `coll.map(fn)` / `arr.includes(x)`. (Contiguous dotted paths `a.b.c` stay one token.)
            while (true) {
                if (op("[")) {
                    advance(); val idx = expression(); if (op("]")) advance()
                    base = index(base, idx)
                } else if (op(".") || op("?.")) {
                    // `?.` is pure sugar over the already-total member/index ops (`?.[i]` included)
                    val optional = op("?.")
                    advance()
                    if (optional && op("(")) {
                        // OPTIONAL CALL `o.f?.(…)` (syntax-005): a nullish callee answers null with
                        // the ARGS UNEVALUATED — the JS rule — and a non-lambda callee answers the
                        // same null where JS would throw, because JSE is total. A lambda callee
                        // falls through to the call-on-value arm below, which consumes the `(`.
                        if (base is StackLambda) continue
                        skipBalanced("(", ")")
                        base = null
                        continue
                    }
                    if (optional && op("[")) {
                        advance(); val idx = expression(); if (op("]")) advance()
                        base = index(base, idx)
                        continue
                    }
                    val mt = peek()
                    if (mt !is Token.Ident) break
                    var m = mt.v
                    advance()
                    if (op("(")) {                                // method call: base.m(args)
                        // a dotted run before the call (`arr[0].items.join(…)` — "items.join"
                        // is ONE ident token): walk the leading segments, dispatch on the last
                        if (m.contains('.')) {
                            val dot = m.lastIndexOf('.')
                            for (seg in m.substring(0, dot).split(".")) base = member(base, seg)
                            m = m.substring(dot + 1)
                        }
                        advance()
                        if (m in higherOrderFns) {
                            var fn: Any? = null; var initVal: Any? = null; var hasInit = false
                            if (!op(")")) { fn = expression(); if (op(",")) { advance(); initVal = expression(); hasInit = true } }
                            if (op(")")) advance()
                            base = higherOrder(m, base, fn as? StackLambda, store, initial = initVal, hasInitial = hasInit)
                        } else {
                            val args = ArrayList<Any?>()
                            if (!op(")")) { pushArg(args); while (op(",")) { advance(); pushArg(args) } }
                            if (op(")")) advance()
                            base = applyMethod(m, base, args)
                        }
                    } else if (m.contains('.')) {
                        // `arr[0].x.y` — the postfix member is a dotted RUN; walk each segment
                        for (seg in m.split(".")) base = member(base, seg)
                    } else {
                        base = member(base, m)
                    }
                } else if (op("(") && base is StackLambda) {
                    // call-on-value: `((x) => x + 1)(4)` / `fs[1](5)` / curried `f(1)(2)` — the
                    // `(` consumes ONLY for a lambda base (a non-lambda keeps the existing
                    // no-consume behavior exactly); same 32-frame guard as the named-call route.
                    advance()
                    val args = ArrayList<Any?>()
                    if (!op(")")) { pushArg(args); while (op(",")) { advance(); pushArg(args) } }
                    if (op(")")) advance()
                    if (store.fnDepth >= 32) { base = null; continue }
                    store.fnDepth += 1
                    val v = callLambda(base, args, store)
                    store.fnDepth -= 1
                    base = v
                } else break
            }
            return base
        }

        /// One call argument — `...expr` splices the coerced iterable (call-position spread,
        /// wave 3); shared by every arg-collection loop.
        fun pushArg(args: ArrayList<Any?>) {
            if (op("...")) { advance(); args.addAll(spreadValues(expression())) }
            else args.add(expression())
        }
        fun primaryBase(): Any? {
            val t = peek() ?: return null
            when (t) {
                is Token.Num -> { advance(); return t.v }
                is Token.Str -> { advance(); return t.v }
                is Token.Regex -> {                               // /…/flags → a RegExp value
                    advance()
                    return mapOf<String, Any?>("__regex" to true, "source" to t.pattern, "flags" to t.flags)
                }
                is Token.Template -> {
                    // parts string-coerce and CONCATENATE (never the numeric-first `+`): `${1}${2}` = "12"
                    advance()
                    val out = StringBuilder()
                    for (part in t.parts) {
                        when (part) {
                            is TemplatePart.Lit -> out.append(part.s)
                            is TemplatePart.Expr -> out.append(string(Parser(part.toks, store, item).expression()))
                        }
                    }
                    return out.toString()
                }
                is Token.Ident -> {
                    val id = t.v
                    advance()
                    // JS keyword transparency: `new X(…)` calls X (constructors are plain calls here —
                    // Uint8Array / TextEncoder / …), and `await expr` in expression position is the
                    // value itself (crypto.subtle.* evaluate synchronously under the hood; the spec's
                    // `await v` on a non-promise is `v`). Statement-level awaits that genuinely
                    // suspend (fetch / dsx.module / crypto.subtle) are matched by the runner first.
                    if (id == "new" || id == "await") return primaryBase()
                    if (op("=>")) { advance(); return arrowBody(listOf(LambdaParam(id, emptyList()))) }   // x => body (consume `=>`, like tryArrow's paren path)
                    if (op("(")) {
                        // JS statics that take a LAMBDA arg — matched by FULL name before the dotted
                        // split (else `Object` would parse as the collection). `Object.groupBy` is the
                        // ES2024 standard spelling of groupBy; `Array.from(arrayLike, mapFn)` is the
                        // JS repeat-N idiom (`Array.from({ length: 5 }, (_, i) => i)`).
                        if (id == "Object.groupBy" || id == "Array.from") {
                            advance()
                            val args = ArrayList<Any?>()
                            if (!op(")")) { pushArg(args); while (op(",")) { advance(); pushArg(args) } }
                            if (op(")")) advance()
                            if (id == "Object.groupBy") {
                                return higherOrder("groupBy", args.getOrNull(0), args.getOrNull(1) as? StackLambda, store)
                            }
                            return arrayFrom(args, store)
                        }
                        // method on a dotted path — `cart.lines.reduce(…)` tokenizes as ONE ident (the
                        // tokenizer keeps dots in names), so split the trailing `.method` off and
                        // dispatch on it (`base.method(args)`); leading method chains start here.
                        val dot = if (JSECore.handles(id)) -1 else id.lastIndexOf('.')   // a JSECore STATIC is never a <base>.method()
                        if (dot >= 0) {
                            val method = id.substring(dot + 1)
                            if (method in higherOrderFns || method in methodFns) {
                                val baseVal = lookup(id.substring(0, dot), store, item)
                                advance()
                                if (method in higherOrderFns) {
                                    var fn: Any? = null; var initVal: Any? = null; var hasInit = false
                                    if (!op(")")) { fn = expression(); if (op(",")) { advance(); initVal = expression(); hasInit = true } }
                                    if (op(")")) advance()
                                    return higherOrder(method, baseVal, fn as? StackLambda, store, initial = initVal, hasInitial = hasInit)
                                }
                                val args = ArrayList<Any?>()
                                if (!op(")")) { pushArg(args); while (op(",")) { advance(); pushArg(args) } }
                                if (op(")")) advance()
                                return applyMethod(method, baseVal, args)
                            }
                        }
                        // higher-order with an arrow/expr arg: map(coll, fn) / reduce(coll, fn, init)
                        if (id in higherOrderFns) {
                            advance()
                            val coll = expression()
                            var fn: Any? = null; var initVal: Any? = null; var hasInit = false
                            if (op(",")) { advance(); fn = expression() }
                            if (op(",")) { advance(); initVal = expression(); hasInit = true }
                            if (op(")")) advance()
                            return higherOrder(id, coll, fn as? StackLambda, store, initial = initVal, hasInitial = hasInit)
                        }
                        // a SCOPE VALUE that is a lambda is callable: `const f = x => …; f(2)` —
                        // checked before the function table (JS shadowing); same 32-frame guard.
                        // A scope lambda gets the CALLER's live scope as `base` (under its
                        // snapshot), so free names — including the lambda's OWN name, absent
                        // from its creation snapshot — resolve and self-recursion works; user
                        // functions stay store-resolved (no base).
                        // Lookup order: scope lambda → the surface table → the GLOBAL function
                        // library (a surface-local name shadows the global) → builtins.
                        val scopeFn = lookup(id, store, item)
                        val fromScope = scopeFn is StackLambda
                        val any = if (fromScope) scopeFn else (store.functions[id] ?: globalFunction(id))
                        if (any is StackLambda) {
                            advance()
                            val args = ArrayList<Any?>()
                            if (!op(")")) { pushArg(args); while (op(",")) { advance(); pushArg(args) } }
                            if (op(")")) advance()
                            if (store.fnDepth >= 32) return null
                            store.fnDepth += 1
                            val v = callLambda(any, args, store, base = if (fromScope) item else null)
                            store.fnDepth -= 1
                            return v
                        }
                        // built-in: upper(s), round(n), count(x), …
                        advance()
                        val args = ArrayList<Any?>()
                        if (!op(")")) { pushArg(args); while (op(",")) { advance(); pushArg(args) } }
                        if (op(")")) advance()
                        return apply(id, args)
                    }
                    return when (id) {
                        "true" -> true
                        "false" -> false
                        "null", "nil", "undefined" -> null
                        else -> lookup(id, store, item) ?: JSECore.constant(id)   // Math.PI / Number.MAX_SAFE_INTEGER / Infinity / NaN
                    }
                }
                is Token.Op -> when (t.v) {
                    "[" -> {                           // array literal (spread splices in — array/string/Set/Map)
                        advance()
                        val arr = ArrayList<Any?>()
                        while (peek() != null && !op("]")) {
                            if (op("...")) { advance(); arr.addAll(spreadValues(expression())) }
                            else arr.add(expression() ?: NSNull)
                            if (op(",")) advance()
                        }
                        if (op("]")) advance()
                        return arr
                    }
                    "{" -> {                           // object literal: { key: expr, … }
                        advance()
                        val obj = LinkedHashMap<String, Any?>()
                        while (peek() != null && !op("}")) {
                            if (op("...")) {                       // `...dict` merges keys, last-wins
                                advance()
                                val src = expression()
                                if (src is Map<*, *>) for ((k, v) in src) obj[string(k)] = v
                                if (op(",")) advance()
                                continue
                            }
                            if (op("[")) {                         // computed key `{ [expr]: v }`
                                advance()
                                val ck = string(expression())
                                if (op("]")) advance()
                                if (op(":")) { advance(); obj[ck] = expression() ?: NSNull }
                                else obj[ck] = NSNull               // `{ [k] }` is not shorthand — no name to read
                                if (op(",")) advance()
                                continue
                            }
                            val kt = peek()
                            val key: String
                            when (kt) {
                                is Token.Ident -> { key = kt.v; advance() }
                                is Token.Str -> { key = kt.v; advance() }
                                is Token.Num -> { key = string(kt.v); advance() }
                                else -> { advance(); continue }
                            }
                            if (op(":")) { advance(); obj[key] = expression() ?: NSNull }
                            else obj[key] = lookup(key, store, item) ?: NSNull   // JS shorthand { id } == { id: id }
                            if (op(",")) advance()
                        }
                        if (op("}")) advance()
                        return obj
                    }
                    "(" -> {
                        val lam = tryArrow()
                        if (lam != null) return lam                   // (a, {x,y}) => body
                        advance(); val v = expression(); if (op(")")) advance(); return v
                    }
                    else -> { advance(); return null }
                }
            }
        }

        /// `(params) => body` — detected by an `=>` after the matching `)`. Parses params (names
        /// and `{a,b}` destructuring) and captures the body as a `StackLambda` value. A named
        /// param takes an optional `= default` (call-time, callee scope) and a `...rest` binds
        /// the remaining args as an array; destructured params take neither (wave 3).
        fun tryArrow(): Any? {
            var d = 0
            var j = pos
            while (j < tokens.size) {
                val tk = tokens[j]
                if (tk is Token.Op && tk.v == "(") d += 1
                else if (tk is Token.Op && tk.v == ")") { d -= 1; if (d == 0) break }
                j += 1
            }
            val after = if (j + 1 < tokens.size) tokens[j + 1] else null
            if (!(after is Token.Op && after.v == "=>")) return null
            advance()                                              // '('
            val params = ArrayList<LambdaParam>()
            while (!op(")") && peek() != null) {
                if (op("{") || op("[")) {
                    // ONE pattern reader for params and declarations alike — a destructured
                    // param must not mean something different from the same shape in a `const`.
                    val group = balancedGroup()
                    val decls = parseDeclarators(group)
                    val pattern = if (decls.isNotEmpty()) decls[0].pattern else null
                    params.add(LambdaParam(null, emptyList(), pattern = pattern))
                } else if (op("...")) {
                    // rest param — binds the remaining args as an array
                    advance()
                    val nt = peek()
                    if (nt is Token.Ident) { advance(); params.add(LambdaParam(nt.v, emptyList(), rest = true)) } else advance()
                } else {
                    val nt = peek()
                    if (nt is Token.Ident) {
                        advance()
                        var def: List<Token>? = null
                        if (op("=")) { advance(); def = defaultTokens() }   // call-time default
                        params.add(LambdaParam(nt.v, emptyList(), def = def))
                    } else advance()
                }
                if (op(",")) advance()
            }
            if (op(")")) advance()
            if (op("=>")) advance()
            return arrowBody(params)
        }
        /// Capture one arrow-param default's tokens — to the next top-level `,` or the params'
        /// closing `)` (nested brackets stay whole).
        /// Skip past one balanced group WITHOUT evaluating anything inside — the optional-call
        /// short-circuit, where JS specifies the arguments are never evaluated.
        fun skipBalanced(open: String, close: String) {
            if (!op(open)) return
            var d = 0
            while (true) {
                val tk = peek() ?: return
                if (tk is Token.Op) {
                    if (tk.v == open) d += 1
                    else if (tk.v == close) { d -= 1; if (d == 0) { advance(); return } }
                }
                advance()
            }
        }

        /// Capture a balanced `{…}` / `[…]` group INCLUDING its brackets — the twin of the
        /// TS parser's, so destructured params read through the one pattern parser.
        fun balancedGroup(): List<Token> {
            val out = ArrayList<Token>()
            var d = 0
            while (true) {
                val tk = peek() ?: break
                if (tk is Token.Op) {
                    if (tk.v == "{" || tk.v == "[" || tk.v == "(") d += 1
                    else if (tk.v == "}" || tk.v == "]" || tk.v == ")") d -= 1
                }
                out.add(tk)
                advance()
                if (d == 0) break
            }
            return out
        }

        fun defaultTokens(): List<Token> {
            val body = ArrayList<Token>()
            var d = 0
            while (true) {
                val tk = peek() ?: break
                if (tk is Token.Op) {
                    val o = tk.v
                    if (o == "(" || o == "[" || o == "{") d += 1
                    else if (o == ")" || o == "]" || o == "}") { if (d == 0) break; d -= 1 }
                    else if (d == 0 && o == ",") break
                }
                body.add(tk); advance()
            }
            return body
        }
        /// After `=>`: capture the body — a `{ }` block or one expression — as a StackLambda value.
        fun arrowBody(params: List<LambdaParam>): Any? {
            if (op("{")) {
                advance()
                val body = ArrayList<Token>()
                var d = 1
                while (true) {
                    val tk = peek() ?: break
                    if (tk is Token.Op && tk.v == "{") d += 1
                    else if (tk is Token.Op && tk.v == "}") { d -= 1; if (d == 0) { advance(); break } }
                    body.add(tk); advance()
                }
                return StackLambda(params, body, block = true, captured = item ?: emptyMap())
            }
            val body = ArrayList<Token>()
            var d = 0
            while (true) {
                val tk = peek() ?: break
                if (tk is Token.Op) {
                    val o = tk.v
                    if (o == "(" || o == "[" || o == "{") d += 1
                    else if (o == ")" || o == "]" || o == "}") { if (d == 0) break; d -= 1 }
                    else if (d == 0 && o == ",") break
                }
                body.add(tk); advance()
            }
            return StackLambda(params, body, block = false, captured = item ?: emptyMap())
        }
    }

    /// Coerce any stored collection to `List<Any?>` for the collection functions / array verbs.
    /// (Swift needs two branches — `[Any]` and `[[String: Any]]` — the JVM's erased List is both.)
    fun asArray(v: Any?): List<Any?> {
        if (v is List<*>) return v
        return emptyList()
    }

    /// Coerce any stored/evaluated collection to ROW form (`List<Map<String, Any?>>`) — the lenient
    /// counterpart to `asArray`, for `<list>`/`<grid>`/`store.list`. `.map`/`filter`/array
    /// literals yield plain lists, so funnel element-wise: non-dict / NSNull elements drop
    /// (matching the Swift strict cast's intent for malformed rows), real rows survive.
    fun asRows(v: Any?): List<Map<String, Any?>> {
        if (v is List<*>) return v.mapNotNull { it as? Map<String, Any?> }
        return emptyList()
    }

    /// JS `base[idx]` — numeric index into an array (bounds-checked), or string key into an object.
    fun index(base: Any?, idx: Any?): Any? {
        val n = number(idx)
        if (n != null) {
            val i = n.toInt()                                  // Swift Int(n) truncates; toInt also saturates NaN/huge instead of trapping
            val arr = asArray(base)
            return if (i >= 0 && i < arr.size) arr[i] else null
        }
        return (base as? Map<String, Any?>)?.get(string(idx))
    }
    /// JS `base.member` (postfix) — `.length` on an array/string, else an object key.
    fun member(base: Any?, m: String): Any? {
        if (m == "length") {
            if (base is String) return charCount(base).toDouble()
            if (base is List<*>) return asArray(base).size.toDouble()
        }
        return (base as? Map<String, Any?>)?.get(m)
    }

    /// Bounded higher-order collection functions — JS `map`/`filter`/`reduce`/… . Each iterates a
    /// FINITE collection exactly once (total — guaranteed to terminate), invoking the **arrow
    /// function** `fn` per element: `map(coll, x => …)` · `coll.filter(p => …)` · `reduce(coll,
    /// (acc, x) => …, init)`. The 2nd arg through `index` is passed too (`(x, i) => …`). No
    /// unbounded computation — composes via nesting.
    val higherOrderFns: Set<String> = setOf("filter", "reject", "map", "find", "some", "every", "sortBy", "sumBy", "reduce", "forEach",
                                            "sort", "flatMap", "findIndex", "groupBy", "keyBy",
                                            "findLast", "findLastIndex", "reduceRight", "toSorted")
    val methodFns: Set<String> = setOf("includes", "indexOf", "join", "reverse", "slice", "toUpperCase", "toLowerCase", "trim",
                                       "startsWith", "endsWith", "localeCompare",
                                       "toString", "padStart", "padEnd", "toHex", "toBase64", "encode", "decode",
                                       "repeat", "substring", "lastIndexOf", "trimStart", "trimEnd", "charAt", "charCodeAt",
                                       "codePointAt", "normalize", "matchAll", "fill", "toReversed", "with", "toSpliced",
                                       "pop", "shift",
                                       "entries", "keys", "values", "toFixed",
                                       "getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCDay", "getUTCHours",
                                       "getUTCMinutes", "getUTCSeconds", "getUTCMilliseconds", "getTimezoneOffset",
                                       "setTime", "setFullYear", "setMonth", "setDate", "setHours", "setMinutes",
                                       "setSeconds", "setMilliseconds",
                                       // JS core objects (URL/Date/Intl/fetch companions — see JSECore)
                                       "get", "getAll", "has", "set", "append", "delete", "format", "json", "text", "abort",
                                       "getTime", "toISOString", "toJSON", "getFullYear", "getMonth", "getDate", "getDay",
                                       "getHours", "getMinutes", "getSeconds", "getMilliseconds",
                                       "toLocaleDateString", "toLocaleTimeString", "toLocaleString",
                                       "flat", "concat", "at", "add",
                                       "test", "match", "replace", "replaceAll", "split", "search")
    private fun higherOrder(id: String, coll: Any?, fn: StackLambda?, store: StackStore, initial: Any? = null, hasInitial: Boolean = false): Any? {
        val arr = asArray(coll)
        fun call(args: List<Any?>): Any? { val f = fn ?: return null; return callLambda(f, args, store) }
        when (id) {
            "map" -> return arr.withIndex().map { call(listOf(it.value, it.index.toDouble())) ?: NSNull }
            "filter" -> return arr.withIndex().filter { truthy(call(listOf(it.value, it.index.toDouble()))) }.map { it.value }
            "reject" -> return arr.withIndex().filter { !truthy(call(listOf(it.value, it.index.toDouble()))) }.map { it.value }
            "find" -> return arr.withIndex().firstOrNull { truthy(call(listOf(it.value, it.index.toDouble()))) }?.value
            "some" -> return arr.withIndex().any { truthy(call(listOf(it.value, it.index.toDouble()))) }
            "every" -> return arr.withIndex().all { truthy(call(listOf(it.value, it.index.toDouble()))) }
            "forEach" -> { for ((o, e) in arr.withIndex()) call(listOf(e, o.toDouble())); return null }
            "sumBy" -> return arr.withIndex().fold(0.0) { acc, p -> acc + (number(call(listOf(p.value, p.index.toDouble()))) ?: 0.0) }
            "sortBy" -> {
                // sortBy(coll, fn[, 'desc']) — ascending by default; the optional 3rd arg flips the
                // comparator (not a post-reverse, so equal keys keep source order in both directions).
                val desc = hasInitial && string(initial) == "desc"
                return arr.withIndex().sortedWith(Comparator { l, r ->
                    val x = call(listOf(l.value, l.index.toDouble()))
                    val y = call(listOf(r.value, r.index.toDouble()))
                    val nx = number(x); val ny = number(y)
                    val cmp = if (nx != null && ny != null) {
                        val a: Double = nx; val b: Double = ny        // primitive compare (Swift `nx < ny`)
                        if (a < b) -1 else if (b < a) 1 else 0
                    } else {
                        val sx = string(x); val sy = string(y)
                        if (sx < sy) -1 else if (sy < sx) 1 else 0
                    }
                    if (desc) -cmp else cmp
                }).map { it.value }
            }
            "groupBy" -> {   // groupBy(coll, fn) → { key: [elements] } — bounded single pass (sectioned lists)
                val groups = LinkedHashMap<String, Any?>()
                for ((o, e) in arr.withIndex()) {
                    val k = string(call(listOf(e, o.toDouble())))
                    @Suppress("UNCHECKED_CAST")
                    val bucket = (groups[k] as? MutableList<Any?>) ?: ArrayList<Any?>().also { groups[k] = it }
                    bucket.add(e)
                }
                return groups
            }
            "keyBy" -> {     // keyBy(coll, fn) → { key: element } — last wins (O(1) lookup tables)
                val keyed = LinkedHashMap<String, Any?>()
                for ((o, e) in arr.withIndex()) keyed[string(call(listOf(e, o.toDouble())))] = e
                return keyed
            }
            "reduce" -> {
                var acc: Any? = if (hasInitial) initial else arr.firstOrNull()
                var k = if (hasInitial) 0 else 1
                while (k < arr.size) { acc = call(listOf(acc, arr[k], k.toDouble())); k += 1 }
                return acc
            }
            "sort" ->     // JS sort: comparator (a,b) → number; none → lexicographic. Returns a sorted COPY (value semantics).
                return sortedArray(arr, fn, store)
            "flatMap" ->  // map, then flatten one level
                return arr.withIndex().flatMap {
                    val v = call(listOf(it.value, it.index.toDouble())) ?: NSNull
                    (v as? List<Any?>) ?: listOf(v)
                }
            "findIndex" ->
                return (arr.withIndex().firstOrNull { truthy(call(listOf(it.value, it.index.toDouble()))) }?.index ?: -1).toDouble()
            "findLast" -> {
                for (i in arr.indices.reversed()) if (truthy(call(listOf(arr[i], i.toDouble())))) return arr[i]
                return null
            }
            "findLastIndex" -> {
                for (i in arr.indices.reversed()) if (truthy(call(listOf(arr[i], i.toDouble())))) return i.toDouble()
                return -1.0
            }
            "reduceRight" -> {
                var acc: Any? = if (hasInitial) initial else arr.lastOrNull()
                var k = if (hasInitial) arr.size - 1 else arr.size - 2
                while (k >= 0) { acc = call(listOf(acc, arr[k], k.toDouble())); k -= 1 }
                return acc
            }
            "toSorted" -> return sortedArray(arr, fn, store)   // JS ES2023 — sort was already a copy here
            else -> return null
        }
    }
    /// JS `Array.from` — 1:1: an array (copied), or the `{ length: n }` array-like, with an
    /// optional `(x, i) => …` mapFn. `Array.from({ length: 5 }, (_, i) => i)` is the standard
    /// JS repeat-N idiom (`range(a, b)` is the prefix convenience over the same ladder; both
    /// cap at 10 000 — bounded like all of JSE). Any other input falls through to the crypto
    /// companion (`Array.from(new Uint8Array(hash))` — bytes ride as plain number arrays).
    private fun arrayFrom(a: List<Any?>, store: StackStore): Any? {
        val src = a.getOrNull(0)
        val items: List<Any?>
        if (src is List<*>) items = src
        else if (src is Map<*, *> && src.size == 1) {
            @Suppress("UNCHECKED_CAST")
            val len = number((src as Map<String, Any?>)["length"])
            if (len == null || !len.isFinite()) return JSECrypto.call("Array.from", a)
            val n = maxOf(0, minOf(len.toInt(), 10_000))
            items = List(n) { NSNull }
        } else return JSECrypto.call("Array.from", a)
        val fn = a.getOrNull(1) as? StackLambda ?: return items
        return items.withIndex().map { callLambda(fn, listOf(it.value, it.index.toDouble()), store) ?: NSNull }
    }

    /// JS Array.prototype.sort semantics, shared by the expression form and the statement
    /// mutation (`arr.sort()` / `arr.sort((a, b) => …)`).
    fun sortedArray(arr: List<Any?>, comparator: Any?, store: StackStore): List<Any?> {
        if (comparator is StackLambda) {
            // Swift sorts by the less-predicate `number(fn(a,b)) ?? 0 < 0`; the JVM Comparator
            // form maps the same comparator to -1/0/1 — identical ordering, both sorts stable.
            return arr.sortedWith(Comparator { a, b ->
                val v = number(callLambda(comparator, listOf(a, b), store)) ?: 0.0
                if (v < 0) -1 else if (v > 0) 1 else 0
            })
        }
        return arr.sortedWith(Comparator { a, b -> string(a).compareTo(string(b)) })
    }

    /// JS array/string methods called method-style: `arr.includes(x)` · `.indexOf(x)` · `.join(sep)`
    /// · `.reverse()` · `.slice(n)` · `s.toUpperCase()` / `.toLowerCase()` / `.trim()`.
    fun applyMethod(m: String, base: Any?, a: List<Any?>): Any? {
        // JS core objects first (URL/searchParams get·set, Date getters, Intl format, res.json()…):
        // JSECore claims the call only for ITS dict shapes, so plain values fall through below.
        val handled = JSECore.method(m, base, a)
        if (handled != null) return handled.value
        when (m) {
            "includes" -> {
                if (asArray(base).any { equals(it, a.getOrNull(0)) }) return true
                val needle = string(a.getOrNull(0))
                return needle.isNotEmpty() && string(base).contains(needle)   // Swift contains("") is false
            }
            "indexOf" -> {
                if (base is String) {              // JS String.indexOf — first match or -1 (grapheme offset, like .length/.at)
                    val needle = string(a.getOrNull(0))
                    if (needle.isEmpty()) return 0.0
                    val h = graphemes(base); val nd = graphemes(needle)
                    for (i in 0..(h.size - nd.size)) {
                        var ok = true
                        for (j in nd.indices) if (h[i + j] != nd[j]) { ok = false; break }
                        if (ok) return i.toDouble()
                    }
                    return -1.0
                }
                return (asArray(base).indexOfFirst { equals(it, a.getOrNull(0)) }.let { if (it < 0) -1 else it }).toDouble()
            }
            "localeCompare" -> {
                // The comparator half of string sorting: -1/0/1, ordering by the platform's
                // collation. TS twin: jse.ts applyMethod "localeCompare".
                val l = string(base)
                val r = string(a.getOrNull(0))
                return if (l == r) 0.0 else if (l.compareTo(r) < 0) -1.0 else 1.0
            }
            "startsWith" -> return string(base).startsWith(string(a.getOrNull(0)))
            "endsWith" -> return string(base).endsWith(string(a.getOrNull(0)))
            "join" -> {
                val sep = a.getOrNull(0)?.let { string(it) } ?: ","
                return asArray(base).joinToString(sep) { string(it) }
            }
            "reverse" -> return asArray(base).reversed()
            "slice" -> {       // full JS slice(start[, end]) — negatives count from the end; arrays AND strings
                fun bound(v: Double?, len: Int, def: Int): Int {
                    if (v == null || !v.isFinite()) return def
                    val i = minOf(maxOf(v, -9.0e15), 9.0e15).toInt()
                    return if (i < 0) maxOf(len + i, 0) else minOf(i, len)
                }
                if (base is String) {
                    val chars = graphemes(base)    // graphemes — matches .length/.at semantics
                    val lo = bound(number(a.getOrNull(0)), chars.size, 0)
                    val hi = bound(if (a.size > 1) number(a[1]) else null, chars.size, chars.size)
                    return if (lo < hi) chars.subList(lo, hi).joinToString("") else ""
                }
                val arr = asArray(base)
                val lo = bound(number(a.getOrNull(0)), arr.size, 0)
                val hi = bound(if (a.size > 1) number(a[1]) else null, arr.size, arr.size)
                return if (lo < hi) arr.subList(lo, hi).toList() else emptyList<Any?>()
            }
            "toUpperCase" -> return string(base).uppercase()
            "toLowerCase" -> return string(base).lowercase()
            "trim" -> return trimWhitespaceOnly(string(base))     // Swift .whitespaces (no newlines)
            "flat" -> {        // arr.flat([depth]) — flatten nested arrays (default depth 1; Infinity = full)
                val raw = number(a.getOrNull(0)) ?: 1.0
                val depth = if (raw.isFinite()) raw.toInt() else 512
                fun flatten(v: List<Any?>, d: Int): List<Any?> =
                    v.flatMap { e ->
                        if (e is List<*> && d > 0) flatten(e, d - 1)
                        else listOf(e)
                    }
                return flatten(asArray(base), depth)
            }
            "concat" -> {      // arr.concat(b, c, …) — arrays splice in, scalars append (a COPY)
                val out = ArrayList<Any?>(asArray(base))
                for (v in a) { if (v is List<*>) out.addAll(v) else if (v != null) out.add(v) }
                return out
            }
            "at" -> {          // arr.at(-1) — negative indices from the end (arrays + strings)
                val i = (number(a.getOrNull(0)) ?: 0.0).toInt()
                if (base is String) {
                    val chars = graphemes(base)
                    val idx = if (i < 0) chars.size + i else i
                    return if (idx >= 0 && idx < chars.size) chars[idx] else null
                }
                val arr = asArray(base)
                val idx = if (i < 0) arr.size + i else i
                return if (idx >= 0 && idx < arr.size) arr[idx] else null
            }
            "match" -> return JSERegex.match(string(base), a.getOrNull(0))
            "search" -> return JSERegex.search(string(base), a.getOrNull(0))
            "replace" -> return JSERegex.replace(string(base), a.getOrNull(0), template = string(a.getOrNull(1)), all = false)
            "replaceAll" -> return JSERegex.replace(string(base), a.getOrNull(0), template = string(a.getOrNull(1)), all = true)
            "split" -> {
                val limit = if (a.size > 1) (number(a[1]) ?: 0.0).toInt() else 0
                return JSERegex.split(string(base), a.getOrNull(0), limit = limit)
            }
            "toString" -> {    // n.toString(16) — radix form (the Web Crypto hex idiom); default = string()
                val radix = number(a.getOrNull(0))?.toInt()
                if (radix != null && radix in 2..36 && radix != 10) {
                    val v = number(base)
                    if (v != null) return v.toLong().toString(radix)
                }
                return string(base)
            }
            "padStart", "padEnd" -> {     // s.padStart(2, '0') — the other half of the hex idiom
                val len = minOf(safeIntI(number(a.getOrNull(0)) ?: 0.0), 10_000)   // bounded like repeat (Infinity saturates)
                val pad = if (a.size > 1) string(a[1]) else " "
                val str = string(base)
                val strG = graphemes(str)
                if (pad.isEmpty() || strG.size >= len) return str
                val fill = ArrayList<String>()
                while (fill.size + strG.size < len) fill.addAll(graphemes(pad))
                val f = fill.take(len - strG.size).joinToString("")
                return if (m == "padStart") f + str else str + f
            }
            "toHex" -> return JSECrypto.data(base)?.joinToString("") { String.format("%02x", it.toInt() and 0xFF) }
            "toBase64" -> return JSECrypto.data(base)?.let { java.util.Base64.getEncoder().encodeToString(it) }
            "encode" -> {      // (new TextEncoder()).encode(str) → UTF-8 byte array
                if ((base as? Map<String, Any?>)?.get("__textEncoder") != null) {
                    return JSECrypto.bytes(string(a.getOrNull(0)).toByteArray(Charsets.UTF_8))
                }
                return null
            }
            "decode" -> {      // (new TextDecoder()).decode(bytes) → string
                if ((base as? Map<String, Any?>)?.get("__textDecoder") != null) {
                    val d = JSECrypto.data(a.getOrNull(0)) ?: return null
                    return String(d, Charsets.UTF_8)   // seam: invalid UTF-8 replaces (JVM) vs Swift's ""
                }
                return null
            }
            "repeat" -> {
                val n = maxOf(0, minOf(safeIntI(number(a.getOrNull(0)) ?: 0.0), 10_000))
                val s = string(base)
                val out = StringBuilder()
                repeat(n) { out.append(s) }
                return out.toString()
            }
            "substring" -> {
                val chars = graphemes(string(base))
                fun clamp(v: Double?): Int {
                    if (v == null || v.isNaN()) return 0
                    return maxOf(0, minOf(safeIntI(v), chars.size))
                }
                var lo = clamp(number(a.getOrNull(0)))
                var hi = if (a.size > 1) clamp(number(a.getOrNull(1))) else chars.size
                if (lo > hi) { val tmp = lo; lo = hi; hi = tmp }
                return chars.subList(lo, hi).joinToString("")
            }
            "lastIndexOf" -> {
                if (base is String) {
                    val h = graphemes(base)
                    val nd = graphemes(string(a.getOrNull(0)))
                    if (nd.isEmpty()) return h.size.toDouble()
                    for (i in (h.size - nd.size) downTo 0) {
                        var ok = true
                        for (j in nd.indices) if (h[i + j] != nd[j]) { ok = false; break }
                        if (ok) return i.toDouble()
                    }
                    return -1.0
                }
                val arr = asArray(base)
                for (i in arr.indices.reversed()) if (equals(arr[i], a.getOrNull(0))) return i.toDouble()
                return -1.0
            }
            "trimStart" -> {
                val s = string(base)
                var start = 0
                while (start < s.length && isWhitespaceOnly(s[start])) start += 1
                return s.substring(start)
            }
            "trimEnd" -> {
                val s = string(base)
                var end = s.length
                while (end > 0 && isWhitespaceOnly(s[end - 1])) end -= 1
                return s.substring(0, end)
            }
            "charAt" -> {
                val chars = graphemes(string(base))
                val i = safeIntI(number(a.getOrNull(0)) ?: 0.0)
                return if (i in chars.indices) chars[i] else ""
            }
            "charCodeAt", "codePointAt" -> {
                // the CODE POINT of the i-th grapheme's first scalar — JSE has no UTF-16 halves
                val chars = graphemes(string(base))
                val i = safeIntI(number(a.getOrNull(0)) ?: 0.0)
                if (i !in chars.indices) return null
                return chars[i].codePointAt(0).toDouble()
            }
            "normalize" -> {
                val form = if (a.isNotEmpty()) string(a[0]) else "NFC"
                val f = when (form) {
                    "NFC" -> java.text.Normalizer.Form.NFC
                    "NFD" -> java.text.Normalizer.Form.NFD
                    "NFKC" -> java.text.Normalizer.Form.NFKC
                    "NFKD" -> java.text.Normalizer.Form.NFKD
                    else -> return string(base)
                }
                return java.text.Normalizer.normalize(string(base), f)
            }
            "matchAll" -> return JSERegex.matchAll(string(base), a.getOrNull(0))
            "fill" -> {
                val arr = ArrayList<Any?>(asArray(base))
                fun bound(v: Double?, def: Int): Int {
                    if (v == null || !v.isFinite()) return def
                    val i = safeIntI(v)
                    return if (i < 0) maxOf(arr.size + i, 0) else minOf(i, arr.size)
                }
                val v = if (a.isNotEmpty()) (a[0] ?: NSNull) else NSNull
                val lo = bound(if (a.size > 1) number(a[1]) else null, 0)
                val hi = bound(if (a.size > 2) number(a[2]) else null, arr.size)
                for (i in lo until hi) arr[i] = v
                return arr
            }
            "toReversed" -> return asArray(base).reversed()
            // JS pop()/shift() mutate; JSE values are value-typed on the native runtimes, so
            // the JSE spelling is the PURE read (the toReversed/toSpliced family's law): last/
            // first element out, receiver untouched. Corpus: stdlib-002.
            "pop" -> return asArray(base).lastOrNull()
            "shift" -> return asArray(base).firstOrNull()
            "with" -> {
                val arr = ArrayList<Any?>(asArray(base))
                var i = safeIntI(number(a.getOrNull(0)) ?: 0.0)
                if (i < 0) i += arr.size
                if (i in arr.indices) arr[i] = a.getOrNull(1) ?: NSNull
                return arr
            }
            "toSpliced" -> {
                val arr = ArrayList<Any?>(asArray(base))
                val start = maxOf(0, minOf(safeIntI(number(a.getOrNull(0)) ?: 0.0), arr.size))
                val del = if (a.size > 1) maxOf(safeIntI(number(a[1]) ?: 0.0), 0) else arr.size - start
                val removed = minOf(del, arr.size - start)
                repeat(removed) { arr.removeAt(start) }
                arr.addAll(start, a.drop(2).map { it ?: NSNull })
                return arr
            }
            "entries" -> return asArray(base).withIndex().map { listOf(it.index.toDouble(), it.value ?: NSNull) }
            "keys" -> return asArray(base).indices.map { it.toDouble() }
            "values" -> return ArrayList<Any?>(asArray(base))
            "toLocaleString" -> {
                // NUMBER grouping (corpus stdlib-002): deterministic en-US-style thousands
                // separators over the JSE string of the value — hand-rolled, so no platform
                // locale reaches it and three renderers print one string. Date dicts keep
                // the real locale formatting below; any other receiver keeps the null law.
                val v = number(base)
                if (v != null && base !is Map<*, *>) {
                    val txt = string(v)
                    val neg = txt.startsWith("-")
                    val bare = if (neg) txt.substring(1) else txt
                    val dot = bare.indexOf('.')
                    val whole = if (dot < 0) bare else bare.substring(0, dot)
                    val frac = if (dot < 0) "" else bare.substring(dot)
                    val grouped = StringBuilder()
                    for (k in whole.indices) {
                        if (k > 0 && (whole.length - k) % 3 == 0) grouped.append(',')
                        grouped.append(whole[k])
                    }
                    return (if (neg) "-" else "") + grouped.toString() + frac
                }
                return null                                       // non-number receivers keep the old path (dates intercept earlier)
            }
            "toFixed" -> {
                val v = number(base)
                if (v == null || !v.isFinite()) return string(base)
                if (Math.abs(v) >= 9007199254740992.0) return string(v)   // past 2^53 fraction digits are noise — the plain coercion
                val dPlaces = maxOf(0, minOf(safeIntI(number(a.getOrNull(0)) ?: 0.0), 100))
                val shift = Math.pow(10.0, dPlaces.toDouble())
                val scaled = Math.abs(v) * shift
                val f = Math.floor(scaled)
                val r = if (scaled - f >= 0.5) f + 1 else f          // half away from zero (JSE round)
                val whole = Math.floor(r / shift)
                var out = string(whole)
                if (dPlaces > 0) {
                    val frac = string(r - whole * shift).padStart(dPlaces, '0')
                    out += "." + frac
                }
                return (if (v < 0 && r > 0) "-" else "") + out
            }
            else -> return null
        }
    }

    // MARK: value ops

    fun number(v: Any?): Double? = when (v) {
        is Double -> v
        is Int -> v.toDouble()
        is Boolean -> if (v) 1.0 else 0.0
        is Number -> v.toDouble()                              // Swift NSNumber (Long/Float/…)
        is String -> swiftDouble(v)
        is Map<*, *> -> v["__date"] as? Double                 // JS Date coerces to its ms (sort/diff/compare)
        else -> null
    }

    /// Pure built-in functions for `{{ … }}` — string, number, and a couple of helpers.
    /// No side effects, no I/O (keeps the evaluator safe + non-blocking). e.g.
    /// `{{ upper(name) }}`, `{{ round(price) }}`, `{{ pad(mins,2) }}:{{ pad(secs,2) }}`.
    fun apply(name: String, a: List<Any?>): Any? {
        fun s(i: Int): String = if (i < a.size) string(a[i]) else ""
        fun n(i: Int): Double = if (i < a.size) (number(a[i]) ?: 0.0) else 0.0
        // Web Crypto + its companion globals (Uint8Array / TextEncoder / TextDecoder /
        // Array.from / btoa / atob) — the 1:1 JS surface. Dotted callees arrive as one name
        // ("crypto.subtle.digest"). Pending on this runtime — rides the Stack.kt port.
        if (name.startsWith("crypto.") || name == "Uint8Array" || name.startsWith("Uint8Array.") ||
            name == "TextEncoder" || name == "TextDecoder" || name == "Array.from" ||
            name == "btoa" || name == "atob"
        ) {
            return JSECrypto.call(name, a)
        }
        // The JS core globals (URL / Date / Intl / JSON / Math / Blob / FormData / …) —
        // generic computation, 1:1 syntax, native under the hood. See JSECore below.
        if (JSECore.handles(name)) return JSECore.call(name, a)
        when (name) {
            // SOURCE, DRAWN. The `<code>` surface needs token spans in markup, and a page
            // cannot reach the scanner any other way - so the kernel exposes it instead of
            // every caller shipping a fourth tokenizer. Pure: text in, rows of spans out.
            "highlight" -> return Highlight.jseValue(s(0))
            "upper" -> return s(0).uppercase()
            "lower" -> return s(0).lowercase()
            "cap", "capitalize" -> return capitalizedSwift(s(0))
            "trim" -> return trimWhitespaceOnly(s(0))
            "len", "count" -> {
                val f = a.getOrNull(0)
                if (f is List<*>) return f.size.toDouble()
                return charCount(s(0)).toDouble()
            }
            "abs" -> return Math.abs(n(0))
            "round" -> return roundedAwayFromZero(n(0))        // Swift .rounded() — half away from zero
            "floor" -> return Math.floor(n(0))
            "ceil" -> return Math.ceil(n(0))
            "min" -> return swiftMin(n(0), n(1))
            "max" -> return swiftMax(n(0), n(1))
            "int" -> return safeInt(n(0)).toDouble()
            "pad" -> {                                          // zero-pad to width (clamped)
                val width = minOf(maxOf(safeInt(n(1)), 0L), 64L).toInt()
                val value = safeInt(n(0))
                return if (width == 0) value.toString() else String.format("%0${width}d", value)
            }
            "mmss", "clock" -> return clockFormat(safeInt(n(0)))
            "if" -> return if (truthy(a.getOrNull(0))) (if (a.size > 1) a[1] else null) else (if (a.size > 2) a[2] else null)
            "typeof" -> return typeofString(a.getOrNull(0))   // function spelling of the unary operator (rarely reached — the operator form consumes `typeof(x)` too)
            "Array.isArray" -> return a.getOrNull(0) is List<*>
            "range" -> {
                // range(n) / range(a, b) / range(a, b, step) → the half-open number ladder [a, a+step, …)
                // — the declarative repeat-N driver (`<list bind="range(1, 8)">`). Bounded like all of
                // JSE: capped at 10 000 elements, step 0 / non-finite input yields [].
                var lo = 0.0; var hi = n(0); var step = 1.0
                if (a.size >= 2) { lo = n(0); hi = n(1) }
                if (a.size >= 3) step = n(2)
                if (step == 0.0 || !lo.isFinite() || !hi.isFinite() || !step.isFinite()) return emptyList<Any?>()
                val ladder = ArrayList<Any?>()
                var v = lo
                while ((if (step > 0) v < hi else v > hi) && ladder.size < 10_000) { ladder.add(v); v += step }
                return ladder
            }
            "String.fromCharCode" -> {
                val out = StringBuilder()
                for (c in a) {
                    val code = safeIntI(number(c) ?: 0.0)
                    if (code in 0..0x10FFFF) out.append(code.toChar())
                }
                return out.toString()
            }
            "Array.of" -> return a.map { it ?: NSNull }
            "Number.isInteger" -> { val v = a.getOrNull(0); return v is Double && v.isFinite() && Math.floor(v) == v || v is Int }
            "Number.isFinite" -> { val v = a.getOrNull(0); return v is Double && v.isFinite() || v is Int }
            "Number.isSafeInteger" -> {
                val v = a.getOrNull(0)
                val d = when (v) { is Double -> v; is Int -> v.toDouble(); else -> return false }
                return d.isFinite() && Math.floor(d) == d && Math.abs(d) <= 9007199254740991.0
            }
            "Number.isNaN" -> { val v = a.getOrNull(0); return v is Double && v.isNaN() }
            "Number.parseInt" -> return JSECore.call("parseInt", a)
            "Number.parseFloat" -> return JSECore.call("parseFloat", a)
            "matches" -> return DSXPathMatch.matches(s(0), s(1))   // route-path match: * / {param} / :param
            "has" -> return moduleAvailable(s(0))   // capability check — is the named package in THIS build? The callable twin of visible-if="has:scheme".
            // ── collection utilities (bounded, total — no per-element predicate) ──
            "first" -> return asArray(a.getOrNull(0)).firstOrNull()
            "last" -> return asArray(a.getOrNull(0)).lastOrNull()
            "reverse" -> return asArray(a.getOrNull(0)).reversed()
            "sum" -> return asArray(a.getOrNull(0)).fold(0.0) { acc, e -> acc + (number(e) ?: 0.0) }
            "join" -> return asArray(a.getOrNull(0)).joinToString(if (a.size > 1) s(1) else ", ") { string(it) }
            "contains" -> return asArray(a.getOrNull(0)).any { string(it) == s(1) }
            "keys" -> return (a.getOrNull(0) as? Map<String, Any?>)?.keys?.toList()
            "values" -> return (a.getOrNull(0) as? Map<String, Any?>)?.values?.toList()
            // ── form validators (pure predicates → Bool; compose in a computed `errors` block) ──
            "required" -> {
                val v = a.getOrNull(0)
                if (v is List<*>) return v.isNotEmpty()
                if (v is String) return trimWhitespaceOnly(v).isNotEmpty()
                return truthy(v)
            }
            "minLength" -> return ((a.getOrNull(0) as? List<*>)?.size ?: charCount(s(0))) >= safeInt(n(1))
            "maxLength" -> return ((a.getOrNull(0) as? List<*>)?.size ?: charCount(s(0))) <= safeInt(n(1))
            "regex" -> {
                val pat = s(1)
                if (JSERegex.reDoSProne(pat)) { kernelLog("[JSE] regex() rejected a potentially-catastrophic pattern: /$pat/"); return false }
                return try { Pattern.compile(pat).matcher(s(0)).find() } catch (_: Exception) { false }
            }
            "email" -> return emailPattern.matcher(s(0)).find()
            "phone" -> return phonePattern.matcher(s(0)).find()
            "url" -> {
                val u = try { java.net.URI(s(0)) } catch (_: Exception) { null }
                return u != null && !u.scheme.isNullOrEmpty() && u.host != null
            }
            else -> return null
        }
    }
    private val emailPattern = Pattern.compile("^[A-Z0-9._%+\\-]+@[A-Z0-9.\\-]+\\.[A-Z]{2,}$", Pattern.CASE_INSENSITIVE)
    private val phonePattern = Pattern.compile("^[+]?[0-9 ()\\-]{7,}$")

    /// Double → Long without trapping on NaN / ±inf / out-of-range values (every numeric
    /// here is author-controllable via `{{ }}`, so a stray huge/NaN value must not crash).
    /// seconds → "m:ss" ("h:mm:ss" past an hour); negatives keep the sign (e.g. "-3:21").
    /// The ONE duration formatter — the `mmss`/`clock` builtin above and the Glance
    /// countdown painter both render through it, never a per-surface copy (JseTest pins it).
    fun clockFormat(total: Long): String {
        val neg = total < 0; val t = Math.abs(total)
        val body = if (t >= 3600) String.format("%d:%02d:%02d", t / 3600, (t % 3600) / 60, t % 60)
                   else String.format("%d:%02d", t / 60, t % 60)
        return if (neg) "-$body" else body
    }

    /// NaN → 0; ±Infinity SATURATES to ±9.0e18 (so `substring(0, Infinity)` / `toSpliced`
    /// clamp toward "the end", never toward index 0) — the TS/Swift safeInt contract.
    private fun safeInt(d: Double): Long {
        if (d.isNaN()) return 0
        return minOf(maxOf(d, -9.0e18), 9.0e18).toLong()   // within Int64 range
    }

    /// safeInt, narrowed to Int — SATURATING (a bare Long.toInt() would truncate bits,
    /// turning the ±9e18 saturation into garbage low words).
    private fun safeIntI(d: Double): Int =
        safeInt(d).coerceIn(Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong()).toInt()
    fun equals(a: Any?, b: Any?): Boolean {   // internal: JSECore's Map/Set share it
        // The scope sentinel reads as null here: a bound-but-null lambda param / const /
        // destructured key is stored as NSNull, and `x == null` is the guard every author
        // writes. Without this the sentinel fell through to string coercion ("<null>" != "")
        // and the guard was silently false. Null equals only null — includes/indexOf/switch/
        // Map/Set all ride this function, so they inherit the law. Corpus: core-002.
        val an = if (a === NSNull) null else a
        val bn = if (b === NSNull) null else b
        if (an == null || bn == null) return an == null && bn == null
        val x = number(an); val y = number(bn)
        if (x != null && y != null) {
            val xv: Double = x; val yv: Double = y             // primitive ==: NaN != NaN, -0.0 == 0.0 (Swift semantics)
            return xv == yv
        }
        // Structural equality for plain dicts/arrays — deep, key-order-insensitive (watchKey
        // sorts keys): `{ a: 1 } == { a: 1 }`, `[1, 2] == [1, 2]`. String-coercible value
        // objects (Date→ISO, URL→href, params→query, …) keep coerced-string equality below,
        // so `u == 'https://…'` still holds. Without this branch collections fell through to
        // toString() descriptions — platform-dependent, and false for equal dicts.
        fun structural(v: Any?): Boolean {
            if (v is Map<*, *>) {
                @Suppress("UNCHECKED_CAST")
                return JSECore.stringCoerce(v as Map<String, Any?>) == null
            }
            return v is List<*>
        }
        if (structural(a) || structural(b)) return watchKey(a) == watchKey(b)
        return string(a) == string(b)
    }
    private fun compare(a: Any?, b: Any?, o: String): Boolean {
        // Both operands strings → JS lexicographic ordering ('a' < 'b', '10' < '9'), which also
        // agrees with sortBy/sort's string fallback. Anything else compares numerically
        // (null/bool coerce; a MIXED string-number pair stays numeric — '5' < 10).
        if (a is String && b is String) {
            return when (o) { "<" -> a < b; "<=" -> a <= b; ">" -> a > b; else -> a >= b }
        }
        val x: Double = number(a) ?: 0.0; val y: Double = number(b) ?: 0.0
        return when (o) { "<" -> x < y; "<=" -> x <= y; ">" -> x > y; else -> x >= y }
    }
    private fun arith(a: Any?, b: Any?, o: String): Any? {
        if (o == "+") {
            val x = number(a); val y = number(b)
            if (x != null && y != null) return x + y
            return string(a) + string(b)                       // string concat
        }
        val x: Double = number(a) ?: 0.0; val y: Double = number(b) ?: 0.0
        return when (o) {
            "-" -> x - y
            "*" -> x * y
            "/" -> if (y == 0.0) 0.0 else x / y
            "%" -> if (y == 0.0) 0.0 else x % y                // JS % (sign of dividend, = Swift truncatingRemainder); %0 → 0 like /0
            else -> 0.0
        }
    }
    /// The ONE missing value (`??` / `?.` nullish test): null, undefined, and the
    /// present-null scope sentinel all count — JSE does not split them.
    private fun isMissing(v: Any?): Boolean = v == null || v === NSNull
    /// JS ToInt32 — trunc, wrap mod 2^32 into the signed range. NaN/±inf → 0.
    private fun toInt32(v: Any?): Int {
        val n = number(v) ?: 0.0
        if (n.isNaN() || n.isInfinite()) return 0
        var t = (if (n < 0) kotlin.math.ceil(n) else kotlin.math.floor(n)) % 4294967296.0
        if (t >= 2147483648.0) t -= 4294967296.0
        else if (t < -2147483648.0) t += 4294967296.0
        return t.toLong().toInt()
    }
    /// JS ToUint32 — trunc, wrap mod 2^32 into [0, 2^32). NaN/±inf → 0.
    private fun toUint32(v: Any?): Long {
        val n = number(v) ?: 0.0
        if (n.isNaN() || n.isInfinite()) return 0L
        var t = (if (n < 0) kotlin.math.ceil(n) else kotlin.math.floor(n)) % 4294967296.0
        if (t < 0) t += 4294967296.0
        return t.toLong()
    }
    /// Bitwise / shift operators — JS semantics: Int32 operands (Uint32 for `>>>`),
    /// shift counts masked to 5 bits, results back as Double numbers.
    private fun bitOp(a: Any?, b: Any?, o: String): Double {
        val s = (toUint32(b) and 31L).toInt()
        return when (o) {
            "&" -> (toInt32(a) and toInt32(b)).toDouble()
            "|" -> (toInt32(a) or toInt32(b)).toDouble()
            "^" -> (toInt32(a) xor toInt32(b)).toDouble()
            "<<" -> (toInt32(a) shl s).toDouble()
            ">>" -> (toInt32(a) shr s).toDouble()
            ">>>" -> (toUint32(a) ushr s).toDouble()
            else -> 0.0
        }
    }
    /// JS `~` — bitwise NOT over ToInt32 (−int32 − 1, the twins' spelling).
    private fun bitNot(v: Any?): Double = (-toInt32(v) - 1).toDouble()
    /// JS `**` — operands number-coerced with `?? 0`, exactly like `*` (the arith table).
    private fun powOp(a: Any?, b: Any?): Double = Math.pow(number(a) ?: 0.0, number(b) ?: 0.0)
    /// The iterable coercion shared by spread (`[...x]`) and `for…of`: arrays as-is,
    /// strings → graphemes, Set → its values, Map → its entry pairs, anything else empty.
    internal fun spreadValues(v: Any?): List<Any?> {
        if (v is List<*>) return v
        if (v is String) return graphemes(v)
        if (v is Map<*, *>) {
            (v["__set"] as? List<Any?>)?.let { return it }
            (v["__map"] as? List<Any?>)?.let { return it }
        }
        return emptyList()
    }
    /// The `for…in` key coercion (wave 3): a dict's OWN keys (insertion order, "__"-internal
    /// keys skipped — so Set/Map/Date value objects iterate empty), an array's indices
    /// 0..n-1 (as numbers); anything else contributes nothing.
    internal fun forInKeys(v: Any?): List<Any?> {
        if (v is List<*>) return v.indices.map { it.toDouble() }
        if (v is Map<*, *>) return v.keys.map { string(it) }.filter { !it.startsWith("__") }
        return emptyList()
    }
    /// JS `in` — dict key / array index membership (relational precedence, like the twins).
    private fun inOp(l: Any?, r: Any?): Boolean {
        if (r is List<*>) {
            val n = number(l) ?: return false
            val i = safeInt(n)
            return i >= 0 && i < r.size
        }
        if (r is Map<*, *>) return r.containsKey(string(l))
        return false
    }

    // ── declaration grammar (wave 2): multi-declarators + flat destructuring patterns ──

    private sealed class DeclPattern {
        data class Id(val name: String) : DeclPattern()
        data class ObjEntry(val key: String, val value: DeclPattern, val def: List<Token>?)
        data class ArrItem(val value: DeclPattern, val def: List<Token>?)
        data class Obj(val entries: List<ObjEntry>, val rest: String?) : DeclPattern()
        data class Arr(val items: List<ArrItem?>, val rest: String?) : DeclPattern()   // null item = hole
    }
    private class Declarator(val pattern: DeclPattern, val expr: List<Token>)

    /// Parse `pattern [= expr] (, pattern [= expr])*` from the token slice AFTER the
    /// `const`/`let`/`var` keyword.
    ///
    /// Patterns NEST, and each position takes an optional `= default` and a trailing `...rest`
    /// (TS twin: jse.ts parseDeclarators). They used to be flat, which made three everyday
    /// shapes unwritable: `const { a: { b } } = row`, `const { a = 5 } = opts`, and
    /// `const { id, ...rest } = row` — all data-shaping rather than exotic syntax.
    private fun parseDeclarators(toks: List<Token>): List<Declarator> {
        val out = ArrayList<Declarator>()
        var i = 0
        fun cur(): Token? = if (i < toks.size) toks[i] else null
        fun isOp(v: String): Boolean { val t = cur(); return t is Token.Op && t.v == v }

        /// Capture tokens up to the next TOP-LEVEL member of `stops` (nesting-aware).
        fun captureUntil(stops: Set<String>): List<Token> {
            val acc = ArrayList<Token>()
            var d = 0
            while (i < toks.size) {
                val tk = toks[i]
                if (tk is Token.Op) {
                    if (tk.v == "(" || tk.v == "[" || tk.v == "{") d += 1
                    else if (tk.v == ")" || tk.v == "]" || tk.v == "}") {
                        if (d == 0 && stops.contains(tk.v)) break
                        d -= 1
                    } else if (d == 0 && stops.contains(tk.v)) break
                }
                acc.add(tk)
                i += 1
            }
            return acc
        }

        fun parsePattern(): DeclPattern? {
            val t = cur()
            if (t is Token.Ident) { i += 1; return DeclPattern.Id(t.v) }
            if (isOp("{")) {
                i += 1
                val entries = ArrayList<DeclPattern.ObjEntry>()
                var rest: String? = null
                while (cur() != null && !isOp("}")) {
                    if (isOp("...")) {
                        i += 1
                        val rt = cur()
                        if (rt is Token.Ident) { rest = rt.v; i += 1 }
                        if (isOp(",")) i += 1
                        continue
                    }
                    val kt = cur()
                    val key = when (kt) {
                        is Token.Ident -> kt.v
                        is Token.Str -> kt.v
                        else -> null
                    }
                    if (key == null) { i += 1; continue }
                    i += 1
                    var value: DeclPattern = DeclPattern.Id(key)
                    if (isOp(":")) { i += 1; value = parsePattern() ?: DeclPattern.Id(key) }
                    var def: List<Token>? = null
                    if (isOp("=")) { i += 1; val d = captureUntil(setOf(",", "}")); if (d.isNotEmpty()) def = d }
                    entries.add(DeclPattern.ObjEntry(key, value, def))
                    if (isOp(",")) i += 1
                }
                if (isOp("}")) i += 1
                return DeclPattern.Obj(entries, rest)
            }
            if (isOp("[")) {
                i += 1
                val items = ArrayList<DeclPattern.ArrItem?>()
                var rest: String? = null
                var expectItem = true
                while (cur() != null && !isOp("]")) {
                    if (isOp(",")) { if (expectItem) items.add(null); expectItem = true; i += 1; continue }
                    if (isOp("...")) {
                        i += 1
                        val rt = cur()
                        if (rt is Token.Ident) { rest = rt.v; i += 1 }
                        expectItem = false
                        continue
                    }
                    val value = parsePattern()
                    if (value == null) { i += 1; continue }
                    var def: List<Token>? = null
                    if (isOp("=")) { i += 1; val d = captureUntil(setOf(",", "]")); if (d.isNotEmpty()) def = d }
                    items.add(DeclPattern.ArrItem(value, def))
                    expectItem = false
                }
                if (isOp("]")) i += 1
                return DeclPattern.Arr(items, rest)
            }
            return null
        }

        while (i < toks.size) {
            val pattern = parsePattern()
            if (pattern == null) { i += 1; continue }
            var expr: List<Token> = emptyList()
            if (isOp("=")) { i += 1; expr = captureUntil(setOf(",")) }
            out.add(Declarator(pattern, expr))
            if (isOp(",")) i += 1
        }
        return out
    }

    /// THE RUNNER'S DOOR into the one pattern machinery (JseRunner.bindDestructure delegates
    /// here). It exists because the runner had a SECOND, text-level binder that stayed FLAT
    /// when patterns learned nesting, defaults and rest — the same body meant different things
    /// in an action and in an expression block. One parser, one binder, no second opinion.
    /// `patternText` may be a bare pattern (`[a, ...rest]`) or carry an initializer; only the
    /// pattern half is read here — the caller owns evaluating its own RHS.
    internal fun destructureBind(
        patternText: String,
        value: Any?,
        store: StackStore,
        locals: Map<String, Any?>,
        bind: (String, Any?) -> Unit,
    ) {
        val decls = parseDeclarators(tokenize(patternText))
        val pattern = decls.firstOrNull()?.pattern ?: return
        bindPattern(pattern, value, bind) { toks -> Parser(toks, store, locals).expression() }
    }

    /// Bind one declarator's VALUE through its pattern. `evalDefault` evaluates a `= default`
    /// when the position is MISSING (null — JSE's one absent value); callers that cannot
    /// evaluate pass null and simply bind the missing value.
    private fun bindPattern(
        p: DeclPattern,
        value: Any?,
        bind: (String, Any?) -> Unit,
        evalDefault: ((List<Token>) -> Any?)? = null,
    ) {
        fun withDefault(v: Any?, def: List<Token>?): Any? {
            if (def == null || evalDefault == null) return v
            return if (v == null || v === NSNull) evalDefault(def) else v
        }
        when (p) {
            is DeclPattern.Id -> bind(p.name, value)
            is DeclPattern.Obj -> {
                val taken = HashSet<String>()
                for (e in p.entries) {
                    taken.add(e.key)
                    bindPattern(e.value, withDefault(member(value, e.key), e.def), bind, evalDefault)
                }
                val rest = p.rest
                if (rest != null) {
                    val outMap = LinkedHashMap<String, Any?>()
                    val src = value
                    if (src is Map<*, *>) {
                        for ((k, v) in src) {
                            val key = k as? String ?: continue
                            if (!taken.contains(key)) outMap[key] = v
                        }
                    }
                    bind(rest, outMap)
                }
            }
            is DeclPattern.Arr -> {
                p.items.forEachIndexed { k, item ->
                    if (item != null) {
                        bindPattern(item.value, withDefault(index(value, k.toDouble()), item.def), bind, evalDefault)
                    }
                }
                val rest = p.rest
                if (rest != null) {
                    val src = value as? List<*> ?: emptyList<Any?>()
                    bind(rest, if (p.items.size >= src.size) emptyList<Any?>() else src.drop(p.items.size))
                }
            }
        }
    }

    /// JS `typeof` — with one deliberate divergence: JSE does not distinguish null from
    /// undefined (both are nil), so both report "undefined" (JS's `typeof null == "object"`
    /// wart would make the useful missing-value branch impossible). Arrays and dicts are
    /// "object" (JS), arrow-function values are "function".
    private fun typeofString(v: Any?): String = when (v) {
        null, NSNull -> "undefined"
        is String -> "string"
        is Boolean -> "boolean"                                // before Number (Swift splits via CFBoolean identity)
        is Number -> "number"
        is StackLambda -> "function"
        else -> "object"
    }

    /// Normalize an explicit `dsx.`-namespace prefix to its canonical scope path — the opt-in
    /// "professional" spelling layered over the bare scopes. Purely additive / non-breaking:
    /// bare names, `global.*`, `route.*`, `item.*`, `attribute.*` and `dsx.this`/`dsx.event` are
    /// unchanged; the `dsx.`-prefixed aliases simply expand to them.
    ///
    ///   `dsx.variable.x` → `x` (this surface's state)  ·  `dsx.global.x` → `global.x`  ·  `dsx.route.x` → `route.x`
    ///   `dsx.params.x` → `route.params.x`  ·  `dsx.query.x` → `route.query.x`  ·  `dsx.path` → `route.path`
    ///   `dsx.attribute.x` → `attribute.x` (a component's attributes)  ·  `dsx.item.x` → `item.x`  ·  `dsx.formula.x` → `x` (a formula by name)
    fun normalizeScope(path: String): String {
        // `dsx.` is the ONE universal root on both surfaces (markup `{{ dsx.global.x }}` ⇄
        // native `dsx.global.x`). Strip it, then the FIRST segment names the scope.
        if (!path.startsWith("dsx.")) return path
        val body = path.substring(4)
        val head: String
        val rest: String
        val dot = body.indexOf('.')
        if (dot >= 0) { head = body.substring(0, dot); rest = body.substring(dot + 1) }
        else { head = body; rest = "" }
        fun join(base: String): String = if (rest.isEmpty()) base else "$base.$rest"
        return when (head) {
            "variable", "formula" -> if (rest.isEmpty()) body else rest   // surface state (dsx.variable) / a formula, by name
            "global" -> join("global")
            // app-wide constants (App.json `consts`; networking.md N0) live on the app store
            // under `const`: dsx.const.api_url folds to global.const.api_url, so the reserved
            // `global` branch serves it (reactive via storeChanged) with no extra dispatch.
            "const" -> join("global.const")
            // strings / theme are NOT scopes — they live UNDER global: dsx.global.strings /
            // dsx.global.theme (white-label text / design tokens; see OpenSource/Skills/white-label.md).
            "screen" -> join("global.screen")            // reactive window metrics: width/height/sizeClass/orientation/breakpoint
            // G4 unified input (dsx-game.md §2): `dsx.input.jump` / `dsx.input.move.x` is an
            // ordinary tracked read of the app store — the input runtime publishes each declared
            // binding under `global.input.<name>`, so a markup read is reactive for free and no
            // new dispatch path exists. (`<input>` in the BODY is still the form element.)
            "input" -> join("global.input")
            "source" -> join("global.source")            // provenance plane: dsx.source.<plane>.{state,serving,at} + online/boot (iOS Source.swift; publishing twins deferred — android-status.md)
            "app" -> join("global.app")                  // app identity from App.json — dsx.app.host / dsx.app.name; seeded at boot
            "route" -> join("route")
            "cookie" -> join("cookie")                   // web/native cookie jar — dsx.cookie.name (a value) / dsx.cookie (the whole jar)
            "attribute" -> join("attribute")             // a component's ATTRIBUTES — dsx.attribute.name (never "props")
            "override" -> join("override")               // a component's STYLE contract — dsx.override.name (Conformance/overrides)
            "item", "this" -> join("item")               // dsx.this ≡ dsx.item — the current <list>/<grid> row
            "element" -> join("item.__element")          // dsx.element.* — the nearest `container`-marked ancestor's live { width, height }
            "params" -> join("route.params")
            "query" -> join("route.query")
            "path" -> "route.path"
            else -> body                                 // dsx.event / dsx.action / unknown — handled elsewhere
        }
    }

    private fun lookup(rawPath: String, store: StackStore, item: Map<String, Any?>?): Any? {
        // EXPLICIT namespace: `dsx.variable.x` means the surface store, full stop — inside a list/grid
        // row whose item happens to carry the same field name (`item.index` vs `dsx.variable.index`),
        // the row must NOT shadow it. Bare names keep the shadow (that's the props rule).
        val explicitStore = rawPath.startsWith("dsx.variable.") || rawPath.startsWith("dsx.formula.")
        val path = normalizeScope(rawPath)
        val parts = path.split(".").filter { it.isNotEmpty() }   // Swift split(separator:) drops empties
        val first = parts.firstOrNull() ?: return null
        // Reserved: `os` / `platform` → the running DEPLOY TARGET, so
        // `visible-if="os == 'ios'"` gates an element to one platform. "android" here
        // by default; the desktop host boots Platform.os to "windows" | "linux"
        // (desktop-platforms.md). The same XML returns "ios" / "macos" on the Swift
        // renderer and "web" on the web kernel — the platform corpus pins all of it.
        if (parts.size == 1 && (first == "os" || first == "platform")) return Platform.os
        // The dsx.platform kernel constant (/web/14 + desktop-platforms.md):
        // platform.os / platform.native / platform.desktop / platform.embed. Unknown
        // second segments fall through to ordinary lookup (an author's own variable).
        if (first == "platform" && parts.size == 2) {
            when (parts[1]) {
                "os" -> return Platform.os
                "native" -> return Platform.native
                "desktop" -> return Platform.desktop
                "embed" -> return Platform.embed
            }
        }
        // Reserved: `env` → the runtime environment channel ("simulator" | "debug" |
        // "testflight" | "adhoc" | "appstore"), so `visible-if="env != 'appstore'"` gates
        // an element OFF production. Resolved from the boot-seeded `global.app.env` — ONE
        // source of truth with `dsx.app.env` — falling back to the live detector pre-seed.
        // Detection fails CLOSED to "appstore". Unlike `os`, an EXPLICIT `dsx.variable.env`
        // read keeps the author's variable.
        if (parts.size == 1 && !explicitStore && first == "env") {
            return walk(listOf("app", "env"), stateVars()) ?: appEnvironment()
        }
        // App-wide reactive store (DSXState): `global.session.credits` etc. Reserved,
        // so a `global.*` read never falls through to a row/prop or the surface store.
        // `dsx.const.*` (App.json `consts`; networking.md N0) folds here via normalizeScope
        // → `global.const.*` — seeded at boot, optionally sharpened by a remote fetch, and
        // reactive (a const change republishes → every reading `<api>` re-materializes).
        if (first == "global") return walk(parts.drop(1), stateVars())
        // Reserved: `route.*` is a view into `global.route` (the navigation state), so
        // `{{ route.path }}` / `{{ route.params.id }}` read the current route without the
        // `global.` prefix. Maintained by the Routing package; null until routing is on.
        if (first == "route") return walk(parts, stateVars())
        // Reserved: `cookie.*` — the live cookie jar (DSXCookies), kept in sync with the web
        // layer. `{{ dsx.cookie.session }}` reads one; `{{ dsx.cookie }}` the lot.
        if (first == "cookie") {
            val jar = cookieJar()
            return if (parts.size == 1) jar else walk(parts.drop(1), jar)
        }
        // The style-override plane: `dsx.override.<name>` — the component's declared style
        // knobs, resolved through the shared core (item __overrides -> store var -> default,
        // typed fail-open coercion; corpus OpenSource/Conformance/overrides).
        if (first == "override") {
            @Suppress("UNCHECKED_CAST")
            val itemOv = item?.get("__overrides") as? Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val storeOv = store.vars["dsx.override"] as? Map<String, Any?>
            if (parts.size == 1) return StyleOverrides.resolvePlane(store.overrideDecls.values, itemOv, storeOv)
            val name = parts[1]
            val decl = store.overrideDecls[name] ?: return null
            val raw = itemOv?.get(name) ?: storeOv?.get(name)
            val v = StyleOverrides.resolve(decl, raw)
            return if (parts.size == 2) v else walk(parts.drop(2), v)
        }
        // Explicit local scope: `item.*` (list row) / `attribute.*` (a component's attributes).
        if (first == "item" || first == "attribute") {
            val v = walk(parts.drop(1), item)
            // When the consumer omitted the attribute: native runtime values (`ui.attribute("x", v)`
            // → the reactive `dsx.attribute` dict) win, then the markup-declared default
            // (`<attribute as="x" default="…"/>`, re-evaluated on read like an inline `|| default`).
            if (v == null && first == "attribute" && parts.size >= 2) {
                val av = store.vars["dsx.attribute"] as? Map<String, Any?>
                if (av != null) {
                    val runtime = walk(parts.drop(1), av)
                    if (runtime != null) return runtime
                }
            }
            if (v == null && first == "attribute" && parts.size == 2) {
                val def = store.attrDefaults[parts[1]]
                //  `default=""` MEANS THE EMPTY STRING (the TS/Swift twins say the same): an
                //  empty expression evaluated to null, so every attribute declared with an
                //  empty default read as ABSENT and the usual `!= ''` guard fired for one
                //  nobody set.
                if (def != null) return if (def.trim().isEmpty()) "" else eval(def, store, item)
            }
            return v
        }
        // Bare name: locals (attributes / row) shadow the shared store, then fall back —
        // so `{{ title }}` is a prop when present, else the shared store key.
        if (!explicitStore) {
            val local = item?.get(first)
            if (local != null) return walk(parts.drop(1), local)
        }
        // Computed value: a name registered by `<variable computed="true">`. Evaluate its
        // formula lazily in the CURRENT scope (a formula over `item.*` derives per row);
        // reactive (re-evaluated on every read), depth-guarded against self-reference. A real
        // store var of the same name wins.
        if (store.vars[first] == null) {
            val formula = store.computed[first]
            if (formula != null && store.computedDepth < 32) {
                store.computedDepth += 1
                val v = evalBlock(formula, store, item)
                store.computedDepth -= 1
                return if (parts.size == 1) v else walk(parts.drop(1), v)
            }
        }
        // A parameterized `<formula>`: bind each input attr (evaluated in THIS scope) as a local,
        // then run the body against those locals — reactive, depth-guarded.
        if (store.vars[first] == null) {
            val f = store.formulas[first]
            if (f != null && store.computedDepth < 32) {
                store.computedDepth += 1
                val scope = HashMap<String, Any?>()
                for ((k, e) in f.inputs) scope[k] = evalBlock(e, store, item) ?: NSNull
                val v = evalBlock(f.body, store, scope)
                store.computedDepth -= 1
                return if (parts.size == 1) v else walk(parts.drop(1), v)
            }
        }
        // A `<variable>`-declared default (evaluated once; superseded the moment `set:`/`push:`
        // writes a live value to the store).
        if (store.vars[first] == null) {
            val initial = store.initials[first]
            if (initial != null) return if (parts.size == 1) initial else walk(parts.drop(1), initial)
        }
        return walk(parts.drop(1), store.vars[first])
    }
    private fun walk(parts: List<String>, value: Any?): Any? {
        var cur = value
        for (p in parts) {
            // `.length` on an array/string → count (JS). A dict is left alone — it may have a
            // real "length" key.
            if (p == "length" && cur !is Map<*, *>) {
                if (cur is String) { cur = charCount(cur).toDouble(); continue }
                if (cur is List<*>) { cur = asArray(cur).size.toDouble(); continue }
            }
            // A numeric segment indexes an array (`routes.0.path`, `cart.items.2.price`),
            // bounds-checked; otherwise walk a dictionary key (`a.b.c`). A dict whose key
            // happens to be numeric still resolves — the array cast simply fails first.
            val i = p.toIntOrNull()
            cur = if (i != null && cur is List<*>) {
                if (i >= 0 && i < cur.size) cur[i] else null
            } else {
                (cur as? Map<String, Any?>)?.get(p)
            }
        }
        return cur
    }

    fun truthy(v: Any?): Boolean = when (v) {
        is Boolean -> v
        is String -> v.isNotEmpty()
        is Number -> v.toDouble() != 0.0                       // NaN != 0 → NaN is truthy (Swift semantics)
        null -> false
        else -> true                                           // arrays, dicts, lambdas, NSNull — Swift `.some`
    }
    fun string(v: Any?): String {
        if (v is Map<*, *>) {
            val c = JSECore.stringCoerce(v as Map<String, Any?>)   // Date→ISO, URL→href, params→query
            if (c != null) return c
        }
        return when (v) {
            is String -> v
            is Boolean -> if (v) "1" else "0"                  // Swift: Bool dynamic-casts to NSNumber first — "1"/"0" is the shipped behavior
            is Number -> {
                val d = v.toDouble()
                if (d.isFinite() && d == Math.floor(d)) d.toLong().toString()   // integral → no ".0" (saturates where Swift would trap)
                else if (d.isNaN()) "nan"                      // Swift "\(Double.nan)"
                else if (d == Double.POSITIVE_INFINITY) "inf"
                else if (d == Double.NEGATIVE_INFINITY) "-inf"
                else d.toString()
            }
            null -> ""
            else -> v.toString()                               // Swift "\(x)" — descriptive, not contractual
        }
    }
    /// A stable, deep key for `<watch>` equality — changes iff the value meaningfully changes
    /// (dict keys sorted so ordering never churns). `.onChange` compares it to fire on real changes.
    fun watchKey(v: Any?): String = when (v) {
        null, NSNull -> "∅"
        is String -> "s\u0001" + v
        is Boolean -> if (v) "b1" else "b0"
        is Number -> "n\u0001" + string(v)
        is List<*> -> "[" + v.joinToString("\u0001") { watchKey(it) } + "]"
        is Map<*, *> -> {
            val d = v as Map<String, Any?>
            "{" + d.keys.sorted().joinToString("\u0001") { k -> "$k=" + watchKey(d[k]) } + "}"
        }
        else -> "x\u0001" + v.toString()
    }
}

// MARK: - file-local helpers (the Swift String/Character semantics the evaluator leans on)

/// Swift `.whitespaces` (space separators + tab — NO newlines): the trim used by JSE.eval,
/// the `trim` builtins and `required`. Distinct from the package `String.trim()`
/// (Swift `.whitespacesAndNewlines`), which evalBlock uses.
private fun isWhitespaceOnly(c: Char): Boolean =
    c == '\t' || Character.getType(c) == Character.SPACE_SEPARATOR.toInt()

private fun trimWhitespaceOnly(s: String): String {
    var start = 0
    var end = s.length
    while (start < end && isWhitespaceOnly(s[start])) start += 1
    while (end > start && isWhitespaceOnly(s[end - 1])) end -= 1
    return s.substring(start, end)
}

/// Swift `String.count` counts extended grapheme clusters; JVM `length` counts UTF-16 units.
/// BreakIterator is the JVM's grapheme segmenter — they agree on all BMP text the corpus
/// uses; exotic cluster edge cases are a documented seam, not a silent divergence.
private fun graphemes(s: String): List<String> {
    if (s.isEmpty()) return emptyList()
    val it = BreakIterator.getCharacterInstance()
    it.setText(s)
    val out = ArrayList<String>()
    var start = it.first()
    var end = it.next()
    while (end != BreakIterator.DONE) {
        out.add(s.substring(start, end))
        start = end
        end = it.next()
    }
    return out
}

private fun charCount(s: String): Int {
    // fast path: no surrogates / combining marks → length is the grapheme count
    var simple = true
    for (ch in s) if (ch.code >= 0x0300) { simple = false; break }
    if (simple) return s.length
    return graphemes(s).size
}

/// Swift `Double(String)` grammar (the `number()` string coercion): full-string parse, no
/// whitespace tolerance, no Java "1f"/"1d" suffixes, "inf"/"infinity"/"nan" case-insensitive,
/// bare hex ("0x1F") accepted. Partial numbers ("12px") are null — like Swift, unlike JS.
private fun swiftDouble(s: String): Double? {
    if (s.isEmpty()) return null
    if (s.first().isWhitespace() || s.last().isWhitespace()) return null   // Swift: no whitespace tolerance (Java trims — reject it)
    val neg = s.startsWith("-")
    val body = if (s.startsWith("+") || neg) s.substring(1) else s
    if (body.isEmpty()) return null
    val lower = body.lowercase()
    if (lower == "inf" || lower == "infinity") return if (neg) Double.NEGATIVE_INFINITY else Double.POSITIVE_INFINITY
    if (lower == "nan") return Double.NaN
    if (lower.startsWith("0x")) {
        val hex = if (lower.contains('p')) s else s + "p0"      // Java hex floats require the binary exponent; Swift doesn't
        return try { java.lang.Double.parseDouble(hex) } catch (_: NumberFormatException) { null }
    }
    val last = body.last().lowercaseChar()
    if (last == 'f' || last == 'd') return null                 // Java suffix tolerance Swift rejects
    return s.toDoubleOrNull()
}

/// Swift `Double.rounded()` — .toNearestOrAwayFromZero (schoolbook), computed without the
/// classic `floor(x + 0.5)` precision bug (0.49999999999999994 must round to 0).
private fun roundedAwayFromZero(x: Double): Double {
    if (x.isNaN() || x.isInfinite()) return x
    val a = Math.abs(x)
    val f = Math.floor(a)
    val r = if (a - f >= 0.5) f + 1 else f
    return if (x < 0) -r else r
}

/// Swift `Swift.min` / `Swift.max` exactly (their NaN behavior is positional, unlike Math.min).
private fun swiftMin(a: Double, b: Double): Double = if (b < a) b else a
private fun swiftMax(a: Double, b: Double): Double = if (b >= a) b else a

/// Foundation `.capitalized`: each letter-run starts uppercase, the rest lowercased
/// ("hello WORLD" → "Hello World", "don't" → "Don'T"). Word boundary = any non-letter.
private fun capitalizedSwift(s: String): String {
    val out = StringBuilder(s.length)
    var prevLetter = false
    for (ch in s) {
        val isLetter = ch.isLetter()
        out.append(
            if (isLetter && !prevLetter) ch.uppercaseChar()
            else if (isLetter) ch.lowercaseChar()
            else ch
        )
        prevLetter = isLetter
    }
    return out.toString()
}

// MARK: - JSECore (SEAM — the JS core globals ride the Stack.kt port)
//
// On iOS, JSECore lives in Stack.swift: URL / URLSearchParams / Date / Intl / JSON / Math /
// Blob / FormData / Headers / Request / Map / Set / structuredClone / parseInt / … . The
// entry points below keep JSE's exact dispatch shape today: Math.*, the pure constants and
// the RegExp `test` method are already 1:1; every pending piece logs and yields null (JSE
// is total — bad/absent capability never throws). navigator.* metadata needs the host
// platform, so it stays null until the Android wiring lands.

internal object JSECore {
    class Handled(val value: Any?)

    // ── routing (the exact Swift switch — kept whole so dispatch shape never drifts) ──────
    fun handles(name: String): Boolean {
        if (name.startsWith("Math.") || name.startsWith("Intl.") || name.startsWith("JSON.") ||
            name.startsWith("Date.") || name.startsWith("Promise.") ||
            name.startsWith("Object.") || name.startsWith("console.") ||
            name.startsWith("performance.")
        ) return true
        return when (name) {
            "URL", "URLSearchParams", "Headers", "Request", "Blob", "File", "FormData",
            "Date", "AbortController", "structuredClone",
            "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
            "parseInt", "parseFloat", "isNaN", "isFinite", "Number", "String", "Boolean",
            "Map", "Set", "Error", "RegExp", "WebSocket" -> true
            else -> false
        }
    }

    fun call(name: String, a: List<Any?>): Any? {
        if (name.startsWith("Math.")) return math(name.substring(5), a)
        return JSECoreGlobals.call(name, a)          // the JS core globals — ported in Globals.kt
    }

    /// Constants the evaluator can't reach as calls (bare member reads on a namespace).
    fun constant(id: String): Any? = when (id) {
        "Math.PI" -> Math.PI
        "Math.E" -> Math.E
        "Number.MAX_SAFE_INTEGER" -> 9007199254740991.0
        "Number.MIN_SAFE_INTEGER" -> -9007199254740991.0
        "Number.EPSILON" -> Math.ulp(1.0)
        "Infinity" -> Double.POSITIVE_INFINITY
        "NaN" -> Double.NaN
        // navigator.* — read-only host METADATA; rides the Android host wiring (seam)
        else -> null
    }

    private fun math(fn: String, a: List<Any?>): Any? {
        val nums = a.map { JSE.number(it) ?: Double.NaN }
        fun n(i: Int): Double = if (i < nums.size) nums[i] else Double.NaN
        return when (fn) {
            "floor" -> Math.floor(n(0))
            "ceil" -> Math.ceil(n(0))
            "round" -> Math.floor(n(0) + 0.5)                  // JS half-up (incl. negatives) — the Swift line
            "trunc" -> { val x = n(0); if (x.isNaN()) x else if (x < 0) Math.ceil(x) else Math.floor(x) }
            "abs" -> Math.abs(n(0))
            "sign" -> { val x = n(0); if (x == 0.0) 0.0 else if (x > 0) 1.0 else -1.0 }
            "min" -> if (nums.isEmpty()) Double.POSITIVE_INFINITY else nums.reduce { m, x -> if (x < m) x else m }
            "max" -> if (nums.isEmpty()) Double.NEGATIVE_INFINITY else nums.reduce { m, x -> if (m < x) x else m }
            "pow" -> Math.pow(n(0), n(1))
            "sqrt" -> if (n(0) < 0) Double.NaN else Math.sqrt(n(0))
            "cbrt" -> Math.cbrt(n(0))
            "hypot" -> Math.hypot(n(0), n(1))
            "random" -> Math.random()
            "log" -> Math.log(n(0))
            "log2" -> kotlin.math.log2(n(0))
            "log10" -> Math.log10(n(0))
            "exp" -> Math.exp(n(0))
            "sin" -> Math.sin(n(0))
            "cos" -> Math.cos(n(0))
            "tan" -> Math.tan(n(0))
            "atan2" -> Math.atan2(n(0), n(1))
            "atan" -> Math.atan(n(0))
            "asin" -> Math.asin(n(0))
            "acos" -> Math.acos(n(0))
            "sinh" -> Math.sinh(n(0))
            "cosh" -> Math.cosh(n(0))
            "tanh" -> Math.tanh(n(0))
            "asinh" -> { val x = n(0); Math.log(x + Math.sqrt(x * x + 1)) }
            "acosh" -> { val x = n(0); if (x < 1) Double.NaN else Math.log(x + Math.sqrt(x * x - 1)) }
            "atanh" -> { val x = n(0); if (x <= -1 || x >= 1) (if (x == -1.0) Double.NEGATIVE_INFINITY else if (x == 1.0) Double.POSITIVE_INFINITY else Double.NaN) else 0.5 * Math.log((1 + x) / (1 - x)) }
            "log1p" -> Math.log1p(n(0))
            "expm1" -> Math.expm1(n(0))
            "fround" -> n(0).toFloat().toDouble()
            "clz32" -> {
                val u = run { var x = n(0); if (x.isNaN() || x.isInfinite()) 0L else { var tt = Math.floor(Math.abs(x)).let { f -> if (x < 0) -f else f } % 4294967296.0; if (tt < 0) tt += 4294967296.0; tt.toLong() } }
                Integer.numberOfLeadingZeros(u.toInt()).toDouble()
            }
            "imul" -> {
                fun i32(x: Double): Int { if (x.isNaN() || x.isInfinite()) return 0; var tt = (if (x < 0) Math.ceil(x) else Math.floor(x)) % 4294967296.0; if (tt >= 2147483648.0) tt -= 4294967296.0 else if (tt < -2147483648.0) tt += 4294967296.0; return tt.toLong().toInt() }
                (i32(n(0)) * i32(n(1))).toDouble()
            }
            else -> null
        }
    }

    // ── methods on JS-core dict shapes (expression position) ─────────────────────────────
    /// applyMethod's first stop. Returns null = "not mine" (plain values fall through to the
    /// generic string/array methods); `Handled(value:)` = the method's result (which may be null).
    fun method(m: String, base: Any?, a: List<Any?>): Handled? {
        val d = base as? Map<*, *> ?: return null
        // RegExp — re.test(s) (string-side match/replace/split live on applyMethod's string cases)
        if (d["__regex"] != null && m == "test") {
            return Handled(JSERegex.test(JSE.string(a.getOrNull(0)), d))
        }
        // URLSearchParams / FormData / Map / Set / Headers / Response / Date / Intl / URL
        // dict shapes — ported in Globals.kt; null = "not mine".
        return JSECoreGlobals.method(m, d, a)
    }

    /// `'' + date` / `{{ url }}` string coercion for the core shapes (Date→ISO, URL→href,
    /// params→query). Ported in Globals.kt; null = no coercion (the generic fallback runs).
    fun stringCoerce(d: Map<String, Any?>): String? = JSECoreGlobals.stringCoerce(d)
}

// MARK: - JSECrypto (SEAM — Web Crypto rides the Stack.kt port; byte plumbing is 1:1 now)

internal object JSECrypto {
    // ── value plumbing ─────────────────────────────────────────────────────────────────────
    /// BufferSource coercion: a JSE number array (bytes), a String (UTF-8), or a key dict's
    /// raw material. Returns null for anything else.
    fun data(v: Any?): ByteArray? {
        if (v is List<*>) {
            val d = ByteArray(v.size)
            for ((i, e) in v.withIndex()) {
                val n = JSE.number(e) ?: return null
                d[i] = n.toLong().toByte()                     // Swift UInt8(truncatingIfNeeded: Int(n)) — low byte
            }
            return d
        }
        if (v is String) return v.toByteArray(Charsets.UTF_8)
        return null
    }
    /// ByteArray → the JSE byte array ([Double] 0–255) every result travels as.
    fun bytes(d: ByteArray): List<Any?> = d.map { (it.toInt() and 0xFF).toDouble() }

    /// crypto.subtle.* + the companion globals (Uint8Array / TextEncoder / TextDecoder /
    /// Array.from / btoa / atob) — ported in Globals.kt on java.security/javax.crypto per
    /// js-core-parity.md. Total: unsupported algorithm/key/params log `[JSE crypto]` + null.
    fun call(name: String, a: List<Any?>): Any? = JSECryptoGlobals.call(name, a)
}

// MARK: - JSERegex (1:1 port on java.util.regex — the parity contract's documented mapping)

internal object JSERegex {
    private val lock = Any()
    private val cache = HashMap<String, Pattern>()

    private class Compiled(val re: Pattern, val global: Boolean)

    /** If position [i] begins an UNBOUNDED quantifier (`*`, `+`, or `{n,}`), return the index
     *  just past it (incl. a trailing lazy `?`); else -1. `{n}`/`{n,m}` are BOUNDED, not counted.
     *  Twin of regex.ts `unboundedQuantAt`. */
    private fun unboundedQuantAt(source: String, i: Int): Int {
        if (i >= source.length) return -1
        val ch = source[i]
        if (ch == '*' || ch == '+') return if (i + 1 < source.length && source[i + 1] == '?') i + 2 else i + 1
        if (ch == '{') {
            val close = source.indexOf('}', i)
            if (close < 0) return -1
            val inner = source.substring(i + 1, close)
            if (Regex("^\\d+,$").matches(inner)) return if (close + 1 < source.length && source[close + 1] == '?') close + 2 else close + 1
        }
        return -1
    }

    /** Reject catastrophic-backtracking patterns — star height ≥ 2 (a group whose body holds an
     *  unbounded quantifier and which is itself unbounded-quantified: `(a+)+`, `(a*)*`, `(.*)*`).
     *  Conservative by design; graceful no-match, never a hang. Twin of regex.ts `reDoSProne`. */
    fun reDoSProne(source: String): Boolean {
        val bodyUnbounded = ArrayList<Boolean>()
        var inClass = false
        var i = 0
        val n = source.length
        while (i < n) {
            val ch = source[i]
            if (ch == '\\') { i += 2; continue }
            if (inClass) { if (ch == ']') inClass = false; i += 1; continue }
            if (ch == '[') { inClass = true; i += 1; continue }
            if (ch == '(') { bodyUnbounded.add(false); i += 1; continue }
            if (ch == ')') {
                val inner = if (bodyUnbounded.isNotEmpty()) bodyUnbounded.removeAt(bodyUnbounded.size - 1) else false
                val q = unboundedQuantAt(source, i + 1)
                if (q >= 0) {
                    if (inner) return true
                    if (bodyUnbounded.isNotEmpty()) bodyUnbounded[bodyUnbounded.size - 1] = true
                    i = q; continue
                }
                i += 1; continue
            }
            val q = unboundedQuantAt(source, i)
            if (q >= 0) {
                if (bodyUnbounded.isNotEmpty()) bodyUnbounded[bodyUnbounded.size - 1] = true
                i = q; continue
            }
            i += 1
        }
        return false
    }

    /// The arg can be a regex dict or a plain string (string-arg replace/split are LITERAL,
    /// per JS — handled by the callers; this resolves only real regex values).
    private fun compiled(v: Any?): Compiled? {
        val d = v as? Map<*, *> ?: return null
        if (d["__regex"] == null) return null
        val pattern = JSE.string(d["source"])
        val flags = JSE.string(d["flags"])
        val key = flags + "\u0001" + pattern
        synchronized(lock) {
            val hit = cache[key]
            if (hit != null) return Compiled(hit, flags.contains("g"))
        }
        if (reDoSProne(pattern)) {
            kernelLog("[JSE regex] rejected a potentially-catastrophic pattern (nested unbounded quantifier): /$pattern/$flags")
            return null
        }
        var opts = 0
        if (flags.contains("i")) opts = opts or Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE   // ICU's `i` is Unicode-aware
        if (flags.contains("m")) opts = opts or Pattern.MULTILINE
        if (flags.contains("s")) opts = opts or Pattern.DOTALL
        val re = try { Pattern.compile(pattern, opts) } catch (_: PatternSyntaxException) {
            kernelLog("[JSE regex] invalid pattern: /$pattern/$flags")
            return null
        }
        synchronized(lock) {
            if (cache.size > 128) cache.clear()
            cache[key] = re
        }
        return Compiled(re, flags.contains("g"))
    }

    fun test(s: String, regex: Any?): Boolean {
        val c = compiled(regex) ?: return false
        return c.re.matcher(s).find()
    }

    fun match(s: String, regex: Any?): Any? {
        val c = compiled(regex) ?: return null
        val m = c.re.matcher(s)
        if (c.global) {
            val all = ArrayList<Any?>()
            while (m.find()) all.add(m.group())
            return if (all.isEmpty()) null else all
        }
        if (!m.find()) return null
        val out = ArrayList<Any?>()
        for (i in 0..m.groupCount()) out.add(m.group(i) ?: NSNull)   // unmatched group → NSNull (Swift NSNotFound)
        return out
    }

    /// Every match as a match ARRAY ([full, g1, …] — unmatched group → NSNull), always
    /// global semantics (the JS matchAll contract; the `g` flag is implied).
    fun matchAll(s: String, regex: Any?): List<Any?> {
        val c = compiled(regex) ?: return emptyList()
        val m = c.re.matcher(s)
        val all = ArrayList<Any?>()
        var guard = 0
        // Java's find() self-advances past a zero-width match — no early break needed
        // (`'abc123'.matchAll(/\d*/g)` yields 5 matches, like the TS/Swift twins); the
        // guard increments EVERY iteration and bounds the total.
        while (m.find() && guard < 10_000) {
            val out = ArrayList<Any?>()
            for (i in 0..m.groupCount()) out.add(m.group(i) ?: NSNull)
            all.add(out)
            guard += 1
        }
        return all
    }

    fun search(s: String, regex: Any?): Double {
        val c = compiled(regex) ?: return -1.0
        val m = c.re.matcher(s)
        return if (m.find()) m.start().toDouble() else -1.0     // UTF-16 index, like JS/NSString
    }

    fun replace(s: String, pattern: Any?, template: String, all: Boolean): String {
        val c = compiled(pattern)
        if (c != null) {
            val m = c.re.matcher(s)
            val out = StringBuilder()
            var last = 0
            while (m.find()) {
                out.append(s, last, m.start())
                out.append(expand(template, m))
                last = m.end()
                if (!(all || c.global)) break                   // first match only (JS `replace` with no /g)
            }
            out.append(s, last, s.length)
            return out.toString()
        }
        // String pattern — LITERAL (JS semantics: replace = first occurrence, replaceAll = every)
        val find = JSE.string(pattern)
        if (find.isEmpty()) return s
        if (all) return s.replace(find, template)
        val r = s.indexOf(find)
        if (r < 0) return s
        return s.substring(0, r) + template + s.substring(r + find.length)
    }

    /// NSRegularExpression's template semantics: `$0…$n` group refs (longest valid digit
    /// run), `\$` a literal dollar, `\\` a literal backslash; an unmatched/out-of-range
    /// group expands empty (Java's own appendReplacement would throw — so expand by hand).
    private fun expand(template: String, m: Matcher): String {
        val out = StringBuilder()
        var i = 0
        while (i < template.length) {
            val ch = template[i]
            if (ch == '\\' && i + 1 < template.length) { out.append(template[i + 1]); i += 2; continue }
            if (ch == '$' && i + 1 < template.length && template[i + 1].isDigit()) {
                var j = i + 1
                var g = template[j] - '0'                       // first digit always consumed
                j += 1
                while (j < template.length && template[j].isDigit()) {
                    val cand = g * 10 + (template[j] - '0')
                    if (cand > m.groupCount()) break
                    g = cand; j += 1
                }
                if (g <= m.groupCount()) out.append(m.group(g) ?: "")
                i = j
                continue
            }
            out.append(ch); i += 1
        }
        return out.toString()
    }

    fun split(s: String, pattern: Any?, limit: Int): List<Any?> {
        var parts: List<String>
        val c = compiled(pattern)
        if (c != null) {
            val m = c.re.matcher(s)
            val out = ArrayList<String>()
            var start = 0
            while (m.find()) {
                out.add(s.substring(start, m.start()))
                start = m.end()
            }
            out.add(s.substring(start))
            parts = out
        } else {
            val sep = JSE.string(pattern)
            parts = if (sep.isEmpty()) graphemes(s) else s.split(sep)   // Swift s.map(String.init) = per-Character
        }
        if (limit > 0 && parts.size > limit) parts = parts.subList(0, limit)
        return parts
    }
}
