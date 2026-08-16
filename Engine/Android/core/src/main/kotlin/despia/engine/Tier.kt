//
//  Tier.kt - the W9 execution-tier classifier + escalation seam, the Kotlin twin of the
//  web kernel's compile/tier.ts + jstier.ts (/web/15). Every action-tier body classifies
//  once (cached) as JSE (the portable subset — this interpreter) or JS (a real, sandboxed
//  engine per /web/12). The verdicts MATCH the TS twin's token screen: the beyond-subset
//  keyword set, generator functions, labeled loops, accessor shapes; contextual words
//  (get/set as calls or reads, member-position `.with(...)` — the Array method, ternary
//  colons, object keys) stay JSE. Conservative in the safe direction — a missed construct
//  classifies JSE and runs exactly as today. Verdict equivalence is corpus-gated:
//  OpenSource/Conformance/tier/verdicts.json (TierConformanceTest here, the TS and Swift
//  twins run the same file).
//
//  THE SEAM: `JsTier.engine` is where the Android engine substrate binds
//  (`JavaScriptSandbox` — androidx.javascriptengine, V8 out-of-process — with the QuickJS
//  fallback; the locked-dependency wave, rendering-1.0-finalization.md). Until an engine
//  binds, an escalated body FAILS VISIBLY: `js_tier_unavailable` through the ambient
//  error fan-out (ledger + module.error + page mirror + reactive keys) — never the old
//  silent misbehavior, never a crash (Article 7).
//

package despia.engine

enum class BodyTier { JSE, JS }

data class TierVerdict(val tier: BodyTier, val reason: String?)

/** The engine seam (/web/15 law 3): reads through a scope snapshot, writes recorded as
 *  operations and applied batched on the JSE side, the identical dsx.* surface, the
 *  /web/12 watchdog. Callback-shaped because every Android engine option is async
 *  (out-of-process V8) — `done` fires after the write ops applied. */
interface JsTierEngine {
    fun run(body: String, env: JsTierEnv, done: () -> Unit)
}

/** What an engine may reach — mirrors the web executor's JsTierEnv 1:1. */
interface JsTierEnv {
    fun read(path: String): Any?
    fun write(path: String, value: Any?)
    fun callAction(name: String, args: Map<String, Any?>): Any?
    fun callModule(chain: String, args: Map<String, Any?>, completion: (Any?) -> Unit)
    fun emitEvent(name: String, payload: Map<String, Any?>)
    fun log(message: String)
    fun error(code: String, message: String)
}

object JsTier {
    /** the bound engine, or null — file-presence-shaped: the engine MODULE binds this */
    @Volatile var engine: JsTierEngine? = null
}

/** The OTA escalation policy (/web/15 law 3): "Markup delivered over the air executes
 *  JSE tier only by default. Escalation for OTA content is a flag (aligned with the W0
 *  recommendation that OTA-on-web ships behind a flag). Locally bundled first-party
 *  markup escalates freely." — the spec, verbatim. WIRED ON ANDROID TODAY: the flag
 *  exists with the safe default (off). NOT WIRED: the consult at the escalation site —
 *  the runner cannot tell, inside JseRunner.runActionBody, whether the current body's
 *  markup arrived over the air (per-body provenance is not published; the source-plane
 *  publishing twins are themselves deferred here — android-status.md), so the
 *  escalation site stays unconditional and the consult lands with the source-plane
 *  integration. No fake provenance channel until then. */
object JsTierPolicy {
    /** May OTA-delivered markup escalate to the JS tier? Default false per law 3. */
    @Volatile var otaEscalation = false
}

object TierClassifier {
    private val beyondSubset = setOf("class", "extends", "super", "yield", "with", "debugger")
    private val cache = HashMap<String, TierVerdict>()

    fun classify(body: String): TierVerdict {
        synchronized(cache) { cache[body]?.let { return it } }
        val verdict = screen(body)
        synchronized(cache) { if (cache.size > 1024) cache.clear(); cache[body] = verdict }
        return verdict
    }

    /** The token screen — a strings/comments-aware word walk (the TS twin's rules). */
    private fun screen(body: String): TierVerdict {
        val words = lex(body)
        for (i in words.indices) {
            val w = words[i]
            if (w in beyondSubset) {
                // member-position `with` is the ARRAY METHOD (`[1,2].with(1,9)` — in the
                // JSE method table, corpus stdlib-001), never the statement; only the bare
                // keyword shape escalates (the TS twin's rule — `?.` lexes here as `?` + `.`,
                // so the dot check covers optional chains too). Corpus tier/verdicts.json
                // `array-with-member` pins this cross-runtime.
                if (w == "with" && i >= 1 && words[i - 1] == ".") continue
                return TierVerdict(BodyTier.JS, "'$w' is outside the JSE grammar")
            }
            // accessor shape: `get name (` / `set name (` — plain get(...)/reads stay JSE
            if ((w == "get" || w == "set") && i + 2 < words.size &&
                words[i + 1].isIdentifier() && words[i + 2] == "(") {
                return TierVerdict(BodyTier.JS, "'$w' accessors are outside the JSE grammar")
            }
            // generators: `function *`
            if (w == "function" && i + 1 < words.size && words[i + 1] == "*") {
                return TierVerdict(BodyTier.JS, "generator functions are outside the JSE grammar")
            }
            // labeled statements: `name : (for|while|do)`
            if (w == ":" && i >= 1 && words[i - 1].isIdentifier() && i + 1 < words.size &&
                (words[i + 1] == "for" || words[i + 1] == "while" || words[i + 1] == "do")) {
                return TierVerdict(BodyTier.JS, "labeled loops are outside the JSE grammar")
            }
        }
        return TierVerdict(BodyTier.JSE, null)
    }

    private fun String.isIdentifier(): Boolean =
        isNotEmpty() && (first().isLetter() || first() == '_' || first() == '$') &&
            all { it.isLetterOrDigit() || it == '_' || it == '$' }

    /** identifiers + single punctuation, with string literals and comments skipped —
     *  enough lexing for the keyword screen, deliberately no more. */
    private fun lex(body: String): List<String> {
        val out = ArrayList<String>()
        var i = 0
        val n = body.length
        while (i < n) {
            val c = body[i]
            when {
                c == '/' && i + 1 < n && body[i + 1] == '/' -> { while (i < n && body[i] != '\n') i++ }
                c == '/' && i + 1 < n && body[i + 1] == '*' -> {
                    i += 2
                    while (i + 1 < n && !(body[i] == '*' && body[i + 1] == '/')) i++
                    i = minOf(i + 2, n)
                }
                c == '"' || c == '\'' || c == '`' -> {
                    val quote = c; i++
                    while (i < n && body[i] != quote) { if (body[i] == '\\') i++; i++ }
                    i++
                }
                c.isLetter() || c == '_' || c == '$' -> {
                    val start = i
                    while (i < n && (body[i].isLetterOrDigit() || body[i] == '_' || body[i] == '$')) i++
                    out.add(body.substring(start, i))
                }
                c.isWhitespace() -> i++
                else -> { out.add(c.toString()); i++ }
            }
        }
        return out
    }
}
