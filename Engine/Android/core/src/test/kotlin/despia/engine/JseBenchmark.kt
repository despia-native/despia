//
//  JseBenchmark.kt — micro-benchmark for the kernel's per-render hot paths (plain JUnit
//  timing: global warmup + median-of-samples; no JMH dependency — the numbers guide
//  optimization decisions, they are not asserted). Scenarios mirror the REAL render call
//  shapes:
//
//    • eval*        — JSE.eval of the same expression string over and over, exactly like a
//                     `{{ }}` binding / visible-if re-evaluated on every recomposition
//                     (StackNodeView.resolvedAttrs → JSE.interpolate → JSE.eval per span).
//    • interpolate  — a multi-span attribute template, the StackNodeView `interp` shape.
//    • scopeSubstitute — StackScope.substitute on a widget/Glance template (the snapshot
//                     surface path: prefix lookup only, no JSE).
//
//  The Compose-side resolvedAttrs cascade has its own twin benchmark in
//  :render (ResolvedAttrsBenchmark.kt) — it needs the render module's internals.
//
//  Output lines are prefixed "JSE-BENCH" (grep the test XML's <system-out>). The single
//  assertion is a sink check so the JIT cannot dead-code the measured work. ALL scenarios
//  warm up before ANY measures, so cross-scenario JIT compilation doesn't skew the first.
//

package despia.engine

import org.junit.jupiter.api.Test
import kotlin.test.assertTrue

class JseBenchmark {

    private var sink = 0
    private class Scenario(val name: String, val ops: Int, val work: () -> Any?)
    private val scenarios = ArrayList<Scenario>()

    private fun scenario(name: String, ops: Int, work: () -> Any?) {
        scenarios.add(Scenario(name, ops, work))
    }

    /// Plain timing: after a global warmup of every scenario, run `samples` timed batches
    /// of `ops` calls each; report the median ns/op (median over batches absorbs GC/JIT
    /// outliers without a benchmark framework).
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
            println("JSE-BENCH  %-16s %,10.0f ns/op   (min %,.0f · max %,.0f)"
                .format(s.name, perOp[samples / 2], perOp.first(), perOp.last()))
        }
    }

    private fun store(): StackStore {
        val s = StackStore()
        s.vars["count"] = 5.0
        s.vars["status"] = "active"
        s.vars["price"] = 19.99
        s.vars["qty"] = 3.0
        s.vars["pad"] = 16.0
        s.vars["petMood"] = "happy"
        s.vars["user"] = mapOf("name" to "Ada", "email" to "ada@example.com", "plan" to "pro")
        s.vars["cart"] = mapOf("items" to List(20) { i ->
            mapOf("name" to "item$i", "qty" to (i % 4).toDouble(), "price" to 4.5 + i)
        })
        return s
    }

    @Test
    fun renderHotPaths() {
        val store = store()

        // (a) repeated JSE.eval of the same strings — the binding / visible-if shapes
        scenario("evalIdent", 20_000) { JSE.eval("count", store, null) }
        scenario("evalPath", 20_000) { JSE.eval("user.name", store, null) }
        scenario("evalCond", 20_000) { JSE.eval("count > 0 && status == 'active'", store, null) }
        scenario("evalExpr", 20_000) { JSE.eval("price * qty * 1.08 + (count > 3 ? 10 : 0)", store, null) }
        scenario("evalLambda", 5_000) { JSE.eval("cart.items.filter(i => i.qty > 0).length", store, null) }

        // (a, in row scope) the same shapes inside a <list> row (item non-null)
        val row = mapOf<String, Any?>("name" to "item3", "qty" to 3.0, "price" to 7.5, "index" to 3.0)
        scenario("evalRowExpr", 20_000) { JSE.eval("price * qty", store, row) }

        // the multi-span attribute template (StackNodeView's `interp`)
        scenario("interpolate", 10_000) {
            JSE.interpolate("Hello {{ user.name }} — {{ cart.items.length }} items · total {{ price * qty }}", store, null)
        }

        // (b) StackScope.substitute — the snapshot-surface (widget/Glance) template path
        val scope = StackScope(mapOf("title" to "Departures", "line1" to "RE 7 · 12:31", "line2" to "S 46 · 12:38", "badge" to "3"))
        scenario("scopeSubstitute", 20_000) {
            scope.substitute("{{ dsx.variable.title }}: {{ dsx.variable.line1 }} / {{ dsx.variable.line2 }} ({{ dsx.variable.badge }})")
        }

        runAll()
        assertTrue(sink != Int.MIN_VALUE)   // consume the sink — keeps the JIT honest
    }
}
