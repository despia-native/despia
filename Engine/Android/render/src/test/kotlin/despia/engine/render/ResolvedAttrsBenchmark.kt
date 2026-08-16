//
//  ResolvedAttrsBenchmark.kt — micro-benchmark for the renderer's per-node attrs cascade
//  (the :render twin of :core's JseBenchmark.kt — same plain warmup+median timing, no JMH).
//  `resolvedAttrs` runs for EVERY node on EVERY recomposition (StackNodeView), so this is
//  the render loop's per-element fixed cost: platform probe → class interpolation →
//  legacy classes → component sheet (CSSEngine, token-memoized) → inline CSS (parse-cached)
//  → element attrs → resolvePlatform.
//
//  A representative node exercises every layer: class set + a reactive class formula,
//  a css-owner component sheet, inline DSX-CSS with a {{ }} span and a custom property,
//  and a platform-tagged attribute. Numbers print with the "JSE-BENCH" prefix (read them
//  from the test XML's <system-out>); the one assertion is a JIT sink.
//

package despia.engine.render

import despia.engine.CSSEngine
import despia.engine.CSSResolver
import despia.engine.StackNode
import despia.engine.StackStore
import org.junit.Assert.assertTrue
import org.junit.Test

class ResolvedAttrsBenchmark {

    private var sink = 0
    private class Scenario(val name: String, val ops: Int, val work: () -> Any?)
    private val scenarios = ArrayList<Scenario>()

    private fun scenario(name: String, ops: Int, work: () -> Any?) {
        scenarios.add(Scenario(name, ops, work))
    }

    /// Same two-phase harness as :core's JseBenchmark: warm ALL scenarios, then measure
    /// median ns/op per scenario (cross-scenario JIT compilation can't skew the first).
    private fun runAll(samples: Int = 15) {
        repeat(3) { for (s in scenarios) repeat(s.ops) { sink += s.work()?.hashCode() ?: 0 } }
        for (s in scenarios) {
            val perOp = DoubleArray(samples)
            for (k in 0 until samples) {
                val t0 = System.nanoTime()
                repeat(s.ops) { sink += s.work()?.hashCode() ?: 0 }
                perOp[k] = (System.nanoTime() - t0).toDouble() / s.ops
            }
            perOp.sort()
            println("JSE-BENCH  %-20s %,10.0f ns/op   (min %,.0f · max %,.0f)"
                .format(s.name, perOp[samples / 2], perOp.first(), perOp.last()))
        }
    }

    @Test
    fun cascade() {
        CSSEngine.registerTheme(
            """{"rules":[{"type":"rule","selector":":root","declarations":[
               {"property":"--bench-accent","value":"#FF2D55","custom":true},
               {"property":"--bench-pad","value":"16px","custom":true}],"children":[]}],"interpolations":[]}"""
        )
        CSSEngine.register(
            "BenchHome",
            """{"rules":[{"type":"rule","selector":".card","declarations":[
               {"property":"padding","value":"var(--bench-pad)"},
               {"property":"background","value":"#FFFFFF"},
               {"property":"border-radius","value":"12px"}],"children":[]},
               {"type":"rule","selector":".highlight","declarations":[
               {"property":"color","value":"var(--bench-accent)"}],"children":[]}],"interpolations":[]}"""
        )
        try {
            val store = StackStore()
            store.vars["petMood"] = "happy"
            store.vars["pad"] = 16.0
            store.classes["chip"] = mapOf("cornerRadius" to "8", "background" to "#EEEEEE")
            val ctx = CSSResolver.Context(isDark = false, windowWidth = 390.0, windowHeight = 844.0,
                                          fontScale = 1.0, reduceMotion = false)

            // The representative node: every cascade layer participates.
            val full = StackNode(
                tag = "vstack",
                attrs = mapOf(
                    "class" to "card highlight chip {{ petMood }}",
                    "style" to "margin-top: {{ pad }}px; --tint: #112233",
                    "css-owner" to "BenchHome",
                    "spacing" to "12",
                    "align" to "center",
                    "padding:android" to "20",
                ),
                children = emptyList(),
            )
            scenario("cascadeFull", 5_000) { resolvedAttrs(full, store, null, ctx) }

            // The common node: plain attributes, no classes, no CSS — the floor.
            val plain = StackNode(tag = "text", attrs = mapOf("size" to "16", "weight" to "bold", "color" to "#111111"), children = emptyList())
            scenario("cascadePlain", 20_000) { resolvedAttrs(plain, store, null, ctx) }

            runAll()
            assertTrue(sink != Int.MIN_VALUE)
        } finally {
            // Neutralize the theme for the rest of the shared JVM (CSSEngine.reset() is
            // :core-internal; an empty theme = empty token table — the GeneratedSheetDeliveryTest
            // hygiene pattern). "BenchHome" is a benchmark-unique sheet name, so it can't collide.
            CSSEngine.registerTheme("""{"rules":[]}""")
        }
    }
}
