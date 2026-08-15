//
//  TierClassifierTest.kt - the W9 classifier twin (/web/15 law 4): verdicts MATCH the
//  web kernel's tier.ts token screen — beyond-subset keywords, generators, labeled
//  loops, accessor shapes escalate; portable bodies and the scary-looking contextuals
//  (get/set calls, ternary colons, object keys, keywords inside strings) stay JSE.
//  The escalation path itself: an escalated body with NO engine bound reports
//  js_tier_unavailable through the ambient fan-out instead of mis-running (JseRunnerTest
//  covers the runner side; this suite pins the verdicts).
//

package despia.engine

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TierClassifierTest {

    @Test fun portableBodiesClassifyJse() {
        listOf(
            "count = count + 1",
            "if (a > 3) { b = a * 2 } else { b = 0 }",
            "for (const x of items) { total = total + x.price }",
            "dsx.variable.name = 'x'; dsx.action.save()",
        ).forEach { body ->
            assertEquals(BodyTier.JSE, TierClassifier.classify(body).tier, body)
        }
    }

    @Test fun beyondSubsetConstructsClassifyJsWithAReason() {
        listOf(
            "class Foo { constructor() {} }",
            "function* gen() { yield 1 }",
            "label: while (true) { break label }",
            "with (obj) { x = 1 }",
            "debugger",
        ).forEach { body ->
            val v = TierClassifier.classify(body)
            assertEquals(BodyTier.JS, v.tier, body)
            assertTrue((v.reason ?: "").isNotEmpty(), body)
        }
    }

    @Test fun contextualShapesStayJse() {
        listOf(
            "get('key')",                       // a call named get
            "settings = dsx.variable.set",      // set as a property-ish read
            "x = a ? b : c",                    // ternary colon
            "obj = { label: 'x', pin: 1 }",     // object keys
            "msg = 'a class act'",              // keyword inside a string literal
            "note = \"yield curve\" // with flair", // keyword in string + comment
        ).forEach { body ->
            assertEquals(BodyTier.JSE, TierClassifier.classify(body).tier, body)
        }
    }
}
