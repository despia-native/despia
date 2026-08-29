package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The COMPONENT FOLD conformance runner — executes every OpenSource/Conformance/components/<name>.json
 * against the shipped Foundation `.dsx` files themselves. The TS runner
 * (packages/compiler/test/component-fold-conformance.test.ts) and the Swift runner
 * (ComponentFoldConformance, record lane) read the SAME json and the SAME documents.
 *
 * WHY THE COMPONENT AND NOT A PURE CORE: a markup component's law lives in the
 * `<variable computed="true">` and `<formula>` bodies of its own head, and those bodies ARE the
 * one implementation all three renderers execute. A kernel core would be a second owner of the
 * same decision. So this mounts the head — the same ten lines StackNodeView's head walk runs —
 * and evaluates the corpus's expressions against it. The reasoning, and the four defects this
 * caught on the day it was written, are in that corpus's README.
 *
 * Missing corpus = loud failure. The one legitimate skip is a genuine open drop with no
 * ClosedSource/ tree at all.
 */
class ComponentFoldConformanceTest {

    private fun repoRoot(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            if (File(dir, "OpenSource/Conformance").isDirectory) return dir
            dir = dir.parentFile ?: error("repo root not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun obj(any: Any?): Map<String, Any?> = any as? Map<String, Any?> ?: emptyMap()

    @Suppress("UNCHECKED_CAST")
    private fun list(any: Any?): List<Any?> = any as? List<Any?> ?: emptyList()

    /** The head walk, 1:1 with StackNodeView's (`"variable" | "formula" | "attribute"`) and with
     *  the TS twin in dom/src/mount.ts: attribute defaults, head functions, computed variables,
     *  then parameterized formulas. Returns the mounted store and the ROOT element's attributes. */
    private fun mountHead(
        source: String,
        attributes: Map<String, Any?>,
        vars: Map<String, Any?>,
    ): Pair<StackStore, Map<String, String>> {
        val root = StackXML.parse(source) ?: error("document did not parse")
        val head = root.children.firstOrNull { it.tag == "head" }
            ?: error("document has no <head>")
        val store = StackStore()
        store.vars["dsx.attribute"] = HashMap(attributes)
        for (node in head.children) {
            if (node.tag != "attribute") continue
            val name = node.attrs["as"] ?: continue
            val def = node.attrs["default"] ?: continue
            if (store.attrDefaults[name] == null) store.attrDefaults[name] = def
        }
        for (node in head.children) {
            when (node.tag) {
                "script", "functions" -> JSE.registerFunctions(node.text ?: "", store)
                "variable", "var", "let" -> {
                    JSE.registerFunctions(node.text ?: "", store)
                    val name = node.attrs["as"] ?: continue
                    if (node.attrs["computed"] == "true") store.computed[name] = node.text ?: ""
                    else if (store.initials[name] == null) {
                        store.initials[name] = JSE.evalBlock(node.text ?: "", store, attributes) ?: ""
                    }
                }
                "formula" -> {
                    JSE.registerFunctions(node.text ?: "", store)
                    val name = node.attrs["as"] ?: continue
                    val inputs = HashMap(node.attrs); inputs.remove("as"); inputs.remove("id")
                    store.formulas[name] = StackFormula(inputs, node.text ?: "")
                }
            }
        }
        for ((k, v) in vars) store.vars[k] = v
        return store to root.attrs
    }

    private fun quote(s: String): String {
        val out = StringBuilder("\"")
        for (c in s) when (c) {
            '"' -> out.append("\\\"")
            '\\' -> out.append("\\\\")
            '\n' -> out.append("\\n")
            '\r' -> out.append("\\r")
            '\t' -> out.append("\\t")
            else -> if (c < ' ') out.append(String.format("\\u%04x", c.code)) else out.append(c)
        }
        return out.append('"').toString()
    }

    /** Canonical rendering for cross-runtime comparison: NSNull is null, an integral number
     *  prints as an integer (this runtime hands back Doubles for every number), keys sorted. */
    private fun canonical(value: Any?): String {
        val out = StringBuilder()
        fun walk(v: Any?) {
            when (v) {
                null, NSNull -> out.append("null")
                is Boolean -> out.append(if (v) "true" else "false")
                is Number -> {
                    val d = v.toDouble()
                    if (d.isFinite() && d == Math.floor(d) && Math.abs(d) < 1e15) {
                        out.append(d.toLong().toString())
                    } else out.append(d.toString())
                }
                is String -> out.append(quote(v))
                is List<*> -> {
                    out.append('[')
                    v.forEachIndexed { i, e -> if (i > 0) out.append(','); walk(e) }
                    out.append(']')
                }
                is Map<*, *> -> {
                    @Suppress("UNCHECKED_CAST") val m = v as Map<String, Any?>
                    if (m["__nsnull"] == true) { out.append("null"); return }
                    out.append('{')
                    m.keys.sorted().forEachIndexed { i, k ->
                        if (i > 0) out.append(',')
                        out.append(quote(k)).append(':')
                        walk(m[k])
                    }
                    out.append('}')
                }
                else -> out.append(quote(v.toString()))
            }
        }
        walk(value)
        return out.toString()
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun componentFoldCorpus() {
        val root = repoRoot()
        val dir = File(root, "OpenSource/Conformance/components")
        assertTrue(dir.isDirectory, "OpenSource/Conformance/components is missing")
        val files = (dir.listFiles() ?: emptyArray()).filter { it.name.endsWith(".json") }.sortedBy { it.name }
        assertTrue(files.isNotEmpty(), "OpenSource/Conformance/components holds no fixtures")
        val closedSource = File(root, "ClosedSource")
        var checks = 0
        for (file in files) {
            val corpus = obj(json(file.readText()).foundationValue)
            if (corpus.isEmpty()) error("${file.name}: not a JSON object")
            assertEquals(1, (corpus["version"] as? Number)?.toInt(), "${file.name}: unsupported version")
            val cases = list(corpus["cases"])
            assertTrue(cases.isNotEmpty(), "${file.name}: no cases")
            val relative = corpus["source"] as? String ?: error("${file.name}: no source")
            val document = File(root, relative)
            if (!closedSource.isDirectory) continue      // a genuine open drop, nothing to execute
            assertTrue(document.isFile, "${file.name}: $relative does not exist")
            val source = document.readText()
            for (raw in cases) {
                val case = obj(raw)
                val name = case["name"] as? String ?: "(unnamed)"
                val (store, rootAttrs) = mountHead(source, obj(case["attributes"]), obj(case["vars"]))
                val item = case["item"]?.let { obj(it) }
                val expectations = list(case["expect"])
                val rootExpectations = list(case["root"])
                assertTrue(expectations.isNotEmpty() || rootExpectations.isNotEmpty(),
                           "${file.name}/$name: no expectations")
                for (e in expectations) {
                    val row = obj(e)
                    val expr = row["expr"] as? String ?: error("${file.name}/$name: expectation has no expr")
                    assertEquals(canonical(row["value"]), canonical(JSE.eval(expr, store, item)),
                                 "${file.name} · $name · $expr")
                    checks += 1
                }
                for (e in rootExpectations) {
                    val row = obj(e)
                    val attr = row["attr"] as? String ?: error("${file.name}/$name: root row has no attr")
                    val bound = rootAttrs[attr]
                        ?: error("${file.name} · $name: root has no $attr=")
                    assertEquals(row["value"] as? String, JSE.interpolate(bound, store, item),
                                 "${file.name} · $name · root $attr")
                    checks += 1
                }
            }
            for (raw in list(corpus["css"])) {
                val rule = obj(raw)
                val sheet = File(root, rule["file"] as? String ?: error("${file.name}: css row has no file"))
                assertTrue(sheet.isFile, "${file.name}: ${rule["file"]} does not exist")
                val text = sheet.readText()
                var at = 0
                for (fragment in list(rule["ordered"])) {
                    val needle = fragment as? String ?: continue
                    val found = text.indexOf(needle, at)
                    assertTrue(found >= 0, "${file.name} · css ${rule["name"]}: missing \"$needle\"")
                    at = found + needle.length
                    checks += 1
                }
            }
        }
        if (closedSource.isDirectory) {
            assertTrue(checks > 0, "the component fold corpus executed nothing")
        }
    }
}
