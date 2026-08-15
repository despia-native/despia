package despia.engine

import java.io.File
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The W9 tier-verdict conformance runner — executes
 * OpenSource/Conformance/tier/verdicts.json through THIS runtime's classifier
 * (`TierClassifier.classify`, Tier.kt); the TS reference (tier-conformance.test.ts over
 * `classifyBody`) and the Swift leg (ConformanceHosts.TierConformance) run the SAME file.
 * The law under test (the corpus `_note`): every action-tier body classifies once as JSE
 * (the portable subset) or JS (the escalation tier), and the three classifiers must never
 * drift — since the strict-rejection hardening the TS verdict is also the compiler's
 * subset gate, so a disagreement means a body compiles on one renderer and escalates (or
 * is rejected) on another.
 *
 * `reasonContains` is matched as a SUBSTRING: the wording legitimately differs per runner
 * (this twin says "'get' accessors are outside the JSE grammar" where TS says "'get' is
 * outside the JSE grammar"); the corpus pins only the stable fragment. A JSE verdict must
 * carry NO reason — asserted too, so a runner can never smuggle a half-escalation.
 */
class TierConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/tier/verdicts.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/tier/verdicts.json not found")
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun tierCorpus(): List<DynamicTest> {
        val doc = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("verdicts.json: not a JSON object")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("verdicts.json: no cases[]")
        assertTrue(cases.size >= 20, "tier corpus is suspiciously small (${cases.size})")
        return cases.map { c ->
            val name = "tier-corpus/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                val body = JSE.string(c["body"])
                val want = JSE.string(c["tier"])
                val v = TierClassifier.classify(body)
                val got = if (v.tier == BodyTier.JS) "js" else "jse"
                assertEquals(want, got, "$name: classified $got (reason ${v.reason})")
                if (want == "js") {
                    // corpus discipline: every js case names its stable reason fragment —
                    // a missing substring is a malformed case, never a skippable one.
                    val substring = c["reasonContains"] as? String
                        ?: error("$name: a js case must state reasonContains")
                    assertTrue((v.reason ?: "").contains(substring),
                        "$name: reason '${v.reason}' does not contain '$substring'")
                } else {
                    assertNull(v.reason, "$name: a jse verdict carries no reason")
                }
            }
        }
    }
}
