package despia.engine

import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AdaptiveShellConformanceTest {
    @Test
    fun sharedCorpus() {
        val root = parseJSONFoundationPreservingNumbers(corpusPath().readText()) as Map<*, *>
        val cases = root["cases"] as List<*>
        assertEquals(17, cases.size)
        for (rawCase in cases) {
            val case = rawCase as Map<*, *>
            val name = case["name"] as String
            val attrs = strings(case["attrs"] as Map<*, *>)
            val panes = case["panes"] as Map<*, *>
            val width = when (val rawWidth = case["width"]) {
                is Number -> rawWidth.toDouble()
                "nonfinite" -> Double.NaN
                else -> error("$name: width must be a number or nonfinite")
            }
            val plan = AdaptiveShell.resolve(
                attrs = attrs,
                widthDp = width,
                nativeAvailable = case["nativeAvailable"] as Boolean,
                hasSidebar = panes["sidebar"] as Boolean,
                hasContent = panes["content"] as Boolean,
                hasInspector = panes["inspector"] as Boolean,
            )
            val expect = case["expect"] as Map<*, *>
            assertEquals(expect["layout"], plan.layout, "$name layout")
            assertEquals(expect["mode"], plan.mode, "$name mode")
            assertEquals(expect["collapse"], plan.collapse, "$name collapse")
            assertEquals(expect["compact"], plan.compact, "$name compact")
            (expect["compactAt"] as? Number)?.let {
                assertEquals(it.toDouble(), plan.compactAt, "$name compactAt")
            }
            assertWidths(name, "sidebar", expect["sidebar"], plan.sidebar)
            assertWidths(name, "inspector", expect["inspector"], plan.inspector)
        }
    }

    @Test
    fun pinsPartitionBeforePanesAndUntaggedBodyDefaultsToContent() {
        val partition = AdaptiveShell.partition(
            listOf(
                mapOf("pin" to "top", "pane" to "sidebar"),
                mapOf("pane" to "sidebar"),
                emptyMap(),
                mapOf("pane" to "content"),
                mapOf("pane" to "inspector"),
                mapOf("pin" to "sideways"),
                mapOf("pin" to "bottom"),
            )
        )
        assertEquals(listOf(0), partition.top)
        assertEquals(listOf(6), partition.bottom)
        assertEquals(listOf(1, 2, 3, 4), partition.authored)
        assertEquals(listOf(1), partition.sidebar)
        assertEquals(listOf(2, 3), partition.content)
        assertEquals(listOf(4), partition.inspector)
    }

    @Test
    fun composeNativePreferenceRemainsAnHonestSemanticSplit() {
        val plan = AdaptiveShell.resolve(
            attrs = mapOf("shell" to "native"),
            widthDp = 1200.0,
            nativeAvailable = false,
            hasSidebar = true,
            hasContent = true,
            hasInspector = true,
        )
        assertEquals("split3", plan.layout)
    }

    @Test
    fun numericAttributesTrimAuthoringWhitespaceAndRejectNonfiniteValues() {
        val plan = AdaptiveShell.resolve(
            attrs = mapOf(
                "shell" to " automatic ",
                "compactAt" to " 900 ",
                "sidebarMin" to " 500 ",
                "sidebarIdeal" to " NaN ",
                "sidebarMax" to " Infinity ",
            ),
            widthDp = 1_200.0,
            nativeAvailable = false,
            hasSidebar = true,
            hasContent = true,
            hasInspector = false,
        )
        assertEquals("split2", plan.layout)
        assertEquals(900.0, plan.compactAt)
        assertEquals(AdaptiveShell.Widths(500.0, 500.0, 500.0), plan.sidebar)
    }

    @Test
    fun fiftyThousandMalformedAndBoundaryPlansPreservePlannerInvariants() {
        val random = Random(0x445358)
        val modes = listOf("custom", "automatic", "native", " AUTOMATIC ", "", "unknown")
        val collapses = listOf("platform", "stack", "content", "none", " PLATFORM ", "bad")
        val numbers = listOf(
            "-100000", "0", "119.999", "120", " 500 ", "1024", "1600", "4096",
            "999999", "NaN", "Infinity", "-Infinity", "", "not-a-number",
            "0x200", "0b1000000000", "1_024", ".5e3", "+6e2",
        )
        val layouts = setOf("custom", "stack", "content", "split2", "split3", "native2", "native3")

        repeat(50_000) {
            val attrs = mutableMapOf(
                "shell" to modes.random(random),
                "collapse" to collapses.random(random),
                "compactAt" to numbers.random(random),
                "sidebarMin" to numbers.random(random),
                "sidebarIdeal" to numbers.random(random),
                "sidebarMax" to numbers.random(random),
                "inspectorMin" to numbers.random(random),
                "inspectorIdeal" to numbers.random(random),
                "inspectorMax" to numbers.random(random),
            )
            val width = when (random.nextInt(8)) {
                0 -> Double.NaN
                1 -> Double.POSITIVE_INFINITY
                2 -> Double.NEGATIVE_INFINITY
                else -> random.nextDouble(-2_000.0, 8_000.0)
            }
            val nativeAvailable = random.nextBoolean()
            val hasSidebar = random.nextBoolean()
            val hasContent = random.nextBoolean()
            val hasInspector = random.nextBoolean()
            val plan = AdaptiveShell.resolve(
                attrs, width, nativeAvailable, hasSidebar, hasContent, hasInspector,
            )

            assertTrue(plan.layout in layouts)
            assertTrue(plan.compactAt in 320.0..4096.0)
            assertTrue(plan.sidebar.min in 120.0..1024.0)
            assertTrue(plan.sidebar.ideal in plan.sidebar.min..1600.0)
            assertTrue(plan.sidebar.max in plan.sidebar.ideal..1600.0)
            assertTrue(plan.inspector.min in 120.0..1024.0)
            assertTrue(plan.inspector.ideal in plan.inspector.min..1600.0)
            assertTrue(plan.inspector.max in plan.inspector.ideal..1600.0)
            if (plan.mode == "custom" || !hasSidebar || !hasContent) {
                assertEquals("custom", plan.layout)
            }
            if (plan.layout.startsWith("native")) assertTrue(nativeAvailable)
            if (plan.layout.startsWith("split")) {
                assertTrue(!nativeAvailable || (plan.compact && plan.collapse == "none"))
            }
        }
    }

    private fun assertWidths(
        name: String,
        role: String,
        raw: Any?,
        actual: AdaptiveShell.Widths,
    ) {
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
            val candidate = current.resolve("OpenSource/Conformance/layout/adaptive-shell.json")
            if (Files.isRegularFile(candidate)) return candidate
            current = current.parent
        }
        error("Could not locate OpenSource/Conformance/layout/adaptive-shell.json")
    }
}
