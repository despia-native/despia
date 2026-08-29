package despia.engine

import java.io.File
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The attribute-binding conformance runner — executes
 * OpenSource/Conformance/composition/attribute-binding.json through THIS runtime's fold
 * (the TS runner and the Swift reference run the SAME file).
 *
 * The law under test (the corpus `_note`): markup has one way to write a consumer
 * attribute and three things an author can mean by it. A sole `{{ ... }}` carries the
 * expression's VALUE, a mixed template carries the sentence, a template with no hole is
 * its own text. Before the fold every .dsx component prop arrived interpolated, so a
 * component could not be handed structure and a self-recursive component — a tree, an
 * outliner, a comment thread — was unbuildable.
 *
 * The `recursion` block pins the depth floor. It is asserted against JSE.COMPONENT_DEPTH_CAP
 * here (rather than in :render beside its caller) so the SDK-free lane gates it.
 */
class CompositionConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/composition/attribute-binding.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("composition/attribute-binding.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpus(): Map<String, Any?> =
        json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("attribute-binding.json: not a JSON object")

    /** The cross-language type name for a resolved attribute value. TS and Swift name the
     *  same six categories; anything outside them is a divergence, not a detail. */
    private fun typeName(v: Any?): String = when (v) {
        null -> "null"
        is List<*> -> "array"
        is Map<*, *> -> "object"
        is Boolean -> "boolean"
        is Number -> "number"
        is String -> "string"
        else -> v::class.simpleName ?: "unknown"
    }

    /** Canonical JSON for the deep-equality check, so the three runners compare the same
     *  bytes rather than three languages' idea of a number. */
    private fun canonical(v: Any?): String = when (v) {
        null -> "null"
        is List<*> -> v.joinToString(",", "[", "]") { canonical(it) }
        is Map<*, *> -> v.entries.sortedBy { JSE.string(it.key) }
            .joinToString(",", "{", "}") { "\"${JSE.string(it.key)}\":${canonical(it.value)}" }
        is Boolean -> if (v) "true" else "false"
        is Number -> JSE.string(v)
        else -> "\"${JSE.string(v)}\""
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun foldCorpus(): List<DynamicTest> {
        val cases = corpus()["fold"] as? List<Map<String, Any?>>
            ?: error("attribute-binding.json: no fold[]")
        assertTrue(cases.isNotEmpty(), "fold table is empty")
        return cases.map { c ->
            val name = "composition-fold/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                val template = JSE.string(c["template"])
                val got = JSE.attributeBinding(template)
                val kind = when (got) {
                    is JSE.AttributeBinding.Static -> "static"
                    is JSE.AttributeBinding.Value -> "value"
                    is JSE.AttributeBinding.Text -> "text"
                }
                assertEquals(JSE.string(c["kind"]), kind, "$name: kind of ${'$'}template")
                if (c.containsKey("expr")) {
                    assertEquals(
                        JSE.string(c["expr"]),
                        (got as? JSE.AttributeBinding.Value)?.expr,
                        "$name: expr",
                    )
                }
            }
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun typedCorpus(): List<DynamicTest> {
        val cases = corpus()["typed"] as? List<Map<String, Any?>>
            ?: error("attribute-binding.json: no typed[]")
        assertTrue(cases.isNotEmpty(), "typed table is empty")
        return cases.map { c ->
            val name = "composition-typed/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                val store = StackStore()
                val vars = c["vars"] as? Map<String, Any?> ?: emptyMap()
                for ((k, v) in vars) store.vars[k] = v
                val got = JSE.bindAttribute(JSE.string(c["template"]), store, null)
                assertEquals(JSE.string(c["type"]), typeName(got), "$name: type (value=$got)")
                if (c.containsKey("json")) {
                    assertEquals(canonical(c["json"]), canonical(got), "$name: value")
                }
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun recursionFloorMatchesTheCorpus() {
        val recursion = corpus()["recursion"] as? Map<String, Any?>
            ?: error("attribute-binding.json: no recursion block")
        val cap = (JSE.number(recursion["cap"]) ?: error("no cap")).toInt()
        assertEquals(cap, JSE.COMPONENT_DEPTH_CAP, "the depth floor drifted from the corpus")
        val cases = recursion["cases"] as? List<Map<String, Any?>> ?: error("no recursion cases")
        for (c in cases) {
            val depth = (JSE.number(c["depth"]) ?: error("no depth")).toInt()
            assertEquals(
                c["expands"] as? Boolean ?: true,
                depth < JSE.COMPONENT_DEPTH_CAP,
                "recursion case ${c["name"]}",
            )
        }
    }
}
