package despia.engine

import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SplitConformanceTest {
    @Test
    fun sharedCorpus() {
        val root = parseJSONFoundationPreservingNumbers(corpusPath().readText()) as Map<*, *>
        val cases = root["cases"] as List<*>
        assertEquals(29, cases.size)
        for (rawCase in cases) {
            val case = rawCase as Map<*, *>
            val name = case["name"] as String
            val attrs = strings(case["attrs"] as Map<*, *>)
            val childRoles = (case["childRoles"] as List<*>).map { it as String? }
            val width = when (val rawWidth = case["width"]) {
                is Number -> rawWidth.toDouble()
                "nonfinite" -> Double.NaN
                else -> error("$name: width must be a number or nonfinite")
            }
            val plan = SplitPlan.resolve(attrs, childRoles, width)
            val expect = case["expect"] as Map<*, *>
            (expect["panes"] as? Number)?.let { assertEquals(it.toInt(), plan.panes, "$name panes") }
            (expect["roles"] as? List<*>)?.let { assertEquals(it, plan.roles, "$name roles") }
            (expect["presentation"] as? String)?.let { assertEquals(it, plan.presentation, "$name presentation") }
            (expect["columns"] as? List<*>)?.let { assertEquals(it, plan.columns, "$name columns") }
            (expect["host"] as? String)?.let { assertEquals(it, plan.host, "$name host") }
            (expect["overlay"] as? Boolean)?.let { assertEquals(it, plan.overlay, "$name overlay") }
            (expect["detail"] as? Boolean)?.let { assertEquals(it, plan.detail, "$name detail") }
            (expect["resizable"] as? Boolean)?.let { assertEquals(it, plan.resizable, "$name resizable") }
            (expect["collapseAt"] as? Number)?.let { assertEquals(it.toDouble(), plan.collapseAt, "$name collapseAt") }
            (expect["expandAt"] as? Number)?.let { assertEquals(it.toDouble(), plan.expandAt, "$name expandAt") }
            (expect["detailMin"] as? Number)?.let { assertEquals(it.toDouble(), plan.detailMin, "$name detailMin") }
            assertWidths(name, "sidebar", expect["sidebar"], plan.sidebar)
            assertWidths(name, "content", expect["content"], plan.content)
        }
        val selection = root["selection"] as List<*>
        assertEquals(7, selection.size)
        for (rawCase in selection) {
            val case = rawCase as Map<*, *>
            val name = case["name"] as String
            assertEquals(case["active"] as Boolean, SplitPlan.selectionActive(case["value"]), name)
        }
    }

    @Test
    fun fiftyThousandHostilePlansPreservePlannerInvariants() {
        val random = Random(0x53504c54)
        val words = listOf(null, "sidebar", "content", "detail", " DETAIL ", "primary", "")
        val numbers = listOf(
            "-5", "0", "319", "320", "760", "1104", "4096", "99999",
            "NaN", "Infinity", "", "not-a-number", " 500 ", ".5e3",
        )
        repeat(50_000) {
            val childRoles = List(random.nextInt(5)) { words.random(random) }
            val attrs = mapOf(
                "panes" to numbers.random(random),
                "collapseAt" to numbers.random(random),
                "expandAt" to numbers.random(random),
                "resizable" to listOf("true", "false", " FALSE ", "").random(random),
                "sidebarMin" to numbers.random(random),
                "sidebarIdeal" to numbers.random(random),
                "sidebarMax" to numbers.random(random),
                "contentMin" to numbers.random(random),
                "contentIdeal" to numbers.random(random),
                "contentMax" to numbers.random(random),
                "detailMin" to numbers.random(random),
            )
            val width = when (random.nextInt(8)) {
                0 -> Double.NaN
                1 -> Double.POSITIVE_INFINITY
                2 -> Double.NEGATIVE_INFINITY
                else -> random.nextDouble(-2_000.0, 8_000.0)
            }
            val plan = SplitPlan.resolve(attrs, childRoles, width)

            assertEquals(minOf(childRoles.size, 3), plan.panes)
            assertEquals(plan.panes, plan.roles.size)
            assertEquals(plan.roles.size, plan.roles.toSet().size, "roles are unique")
            assertTrue(plan.collapseAt in 320.0..4096.0)
            assertTrue(plan.expandAt in plan.collapseAt..4096.0)
            assertTrue(plan.sidebar.min in 120.0..1024.0)
            assertTrue(plan.sidebar.ideal in plan.sidebar.min..1600.0)
            assertTrue(plan.sidebar.max in plan.sidebar.ideal..1600.0)
            assertTrue(plan.content.min in 120.0..1024.0)
            assertTrue(plan.content.ideal in plan.content.min..1600.0)
            assertTrue(plan.content.max in plan.content.ideal..1600.0)
            assertTrue(plan.detailMin in 120.0..1024.0)
            if (plan.presentation == "stack") assertTrue(plan.columns.isEmpty())
            else assertEquals(SplitPlan.ROLE_ORDER.filter { it in plan.columns }, plan.columns, "canonical order")
            assertTrue(plan.columns.all { it in plan.roles })
            if (plan.resizable) assertTrue(plan.presentation == "columns" && plan.columns.size >= 2)
            if (plan.overlay) assertTrue("sidebar" in plan.roles)
            if (plan.panes > 0) assertTrue(plan.host in plan.roles)
        }
    }

    private fun assertWidths(name: String, role: String, raw: Any?, actual: SplitPlan.Widths) {
        val expected = raw as? Map<*, *> ?: return
        assertEquals((expected["min"] as Number).toDouble(), actual.min, "$name $role min")
        assertEquals((expected["ideal"] as Number).toDouble(), actual.ideal, "$name $role ideal")
        assertEquals((expected["max"] as Number).toDouble(), actual.max, "$name $role max")
    }

    private fun strings(map: Map<*, *>): Map<String, String> =
        map.entries.associate { it.key as String to it.value as String }

    private fun corpusPath(): Path {
        var current: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (current != null) {
            val candidate = current.resolve("OpenSource/Conformance/split/split.json")
            if (Files.isRegularFile(candidate)) return candidate
            current = current.parent
        }
        error("Could not locate OpenSource/Conformance/split/split.json")
    }
}
