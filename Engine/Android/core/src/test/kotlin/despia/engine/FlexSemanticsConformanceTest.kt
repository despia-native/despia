package despia.engine

import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals

/** Runs OpenSource/Conformance/layout/flex-semantics.json — the shared container-semantics
 * decision corpus (LayoutSemantics.kt header). The rows' geometry mirrors run in the browser
 * leg (ClosedSource/scripts/dsxcss/fixtures 08–17, `npm run layout-oracle`), so this table is
 * pinned against a real CSS engine on the web side and against :core here. */
class FlexSemanticsConformanceTest {

    @Test
    fun paneRows() {
        val corpus = corpus()
        val rows = corpus["panes"] as List<*>
        assertEquals(5, rows.size)
        for (raw in rows) {
            val row = raw as Map<*, *>
            val name = row["name"] as String
            val children = (row["children"] as List<*>).map { StackNode(it as String, emptyMap(), emptyList()) }
            val expect = (row["expect"] as List<*>).map { (it as Number).toInt() }
            val panes = LayoutSemantics.paneChildren(children)
            assertEquals(expect.map { children[it] }, panes, name)
        }
    }

    @Test
    fun selfAlignRows() {
        for (raw in corpus()["selfAlign"] as List<*>) {
            val row = raw as Map<*, *>
            val attrs = strings(row["attrs"] as Map<*, *>)
            assertEquals(row["expect"], LayoutSemantics.selfAlignment(attrs), "selfAlign $attrs")
        }
    }

    @Test
    fun crossStretchRows() {
        for (raw in corpus()["crossStretch"] as List<*>) {
            val row = raw as Map<*, *>
            val attrs = strings(row["attrs"] as Map<*, *>)
            val defaultStretch = row["defaultStretch"] as Boolean
            assertEquals(
                row["expect"],
                LayoutSemantics.crossStretch(attrs, defaultStretch),
                "crossStretch $attrs default=$defaultStretch",
            )
        }
    }

    @Test
    fun defaultSelfStretchRows() {
        val rows = corpus()["defaultSelfStretch"] as List<*>
        assertEquals(18, rows.size) // +2: the divider stretch-law rows (W18)
        for (raw in rows) {
            val row = raw as Map<*, *>
            val tag = row["tag"] as String
            val attrs = strings(row["attrs"] as Map<*, *>)
            val compact = row["compact"] as Boolean
            assertEquals(
                row["expect"],
                LayoutSemantics.defaultSelfStretch(tag, attrs, compact),
                "defaultSelfStretch $tag $attrs compact=$compact",
            )
        }
    }

    @Test
    fun childFillsCrossRows() {
        for (raw in corpus()["childFillsCross"] as List<*>) {
            val row = raw as Map<*, *>
            val attrs = strings(row["attrs"] as Map<*, *>)
            val parentStretch = row["parentStretch"] as Boolean
            val axis = row["axis"] as String
            assertEquals(
                row["expect"],
                LayoutSemantics.childFillsCross(parentStretch, attrs, axis),
                "childFillsCross parentStretch=$parentStretch $attrs axis=$axis",
            )
        }
    }

    private fun corpus(): Map<*, *> =
        parseJSONFoundationPreservingNumbers(corpusPath().readText()) as Map<*, *>

    private fun strings(raw: Map<*, *>): Map<String, String> =
        raw.entries.associate { (k, v) -> k as String to v as String }

    private fun corpusPath(): Path {
        var current: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (current != null) {
            val candidate = current.resolve("OpenSource/Conformance/layout/flex-semantics.json")
            if (Files.isRegularFile(candidate)) return candidate
            current = current.parent
        }
        error("Could not locate OpenSource/Conformance/layout/flex-semantics.json")
    }
}
