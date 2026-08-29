package despia.engine

import java.io.File
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The style-override corpus runner - executes
 * OpenSource/Conformance/overrides/style-overrides.json through THIS runtime's core (the
 * TS runner and the Swift twin run the SAME file). Three laws (the corpus `_note`): the
 * usage-site SPLIT (`override:<identifier>` leaves the props plane), the typed fail-open
 * RESOLVE (raw -> coerced -> declaration default -> null, min/max clamped), and the READ
 * chain (`dsx.override.<name>`: item `__overrides` -> store `dsx.override` var ->
 * default; undeclared reads null; the whole-plane read returns the declared contract
 * resolved).
 */
class StyleOverridesConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/overrides/style-overrides.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/overrides/style-overrides.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpus(): Map<String, Any?> =
        json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("style-overrides.json: not a JSON object")

    private fun decl(map: Map<String, Any?>): OverrideDecl = OverrideDecl(
        name = JSE.string(map["as"] ?: "x"),
        type = (map["type"] as? String),
        default = (map["default"] as? String),
        options = (map["options"] as? String),
        min = map["min"],
        max = map["max"],
    )

    /** Numbers compare numerically (this runtime hands back Doubles); null stays null. */
    private fun canon(v: Any?): Any? = when (v) {
        is Number -> v.toDouble()
        else -> v
    }

    @Test
    fun corpusIsPresentAndPopulated() {
        val doc = corpus()
        assertTrue((doc["split"] as List<*>).isNotEmpty(), "split table is empty")
        assertTrue((doc["resolve"] as List<*>).isNotEmpty(), "resolve table is empty")
        assertTrue((doc["read"] as List<*>).isNotEmpty(), "read table is empty")
        val reserved = (doc["reserved"] as List<*>).map { JSE.string(it) }.sorted()
        assertEquals(
            listOf("android", "desktop", "ios", "linux", "macos", "native", "watch", "wear", "web", "windows"),
            reserved,
            "the reserved list is the platform-suffix vocabulary",
        )
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun splitCorpus(): List<DynamicTest> {
        val cases = corpus()["split"] as? List<Map<String, Any?>> ?: error("no split[]")
        return cases.map { c ->
            DynamicTest.dynamicTest("split/${c["name"]}") {
                val attrs = (c["attrs"] as Map<String, Any?>).mapValues { JSE.string(it.value) }
                val expect = c["expect"] as Map<String, Any?>
                val (overrides, props) = StyleOverrides.split(attrs)
                assertEquals(expect["overrides"] as Map<String, Any?>, overrides, "overrides")
                assertEquals(expect["props"] as Map<String, Any?>, props, "props")
            }
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun resolveCorpus(): List<DynamicTest> {
        val cases = corpus()["resolve"] as? List<Map<String, Any?>> ?: error("no resolve[]")
        return cases.map { c ->
            DynamicTest.dynamicTest("resolve/${c["name"]}") {
                val d = decl(c["decl"] as Map<String, Any?>)
                val raw = if (c.containsKey("raw")) c["raw"] else null
                assertEquals(canon(c["expect"]), canon(StyleOverrides.resolve(d, raw)))
            }
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun readCorpus(): List<DynamicTest> {
        val cases = corpus()["read"] as? List<Map<String, Any?>> ?: error("no read[]")
        return cases.map { c ->
            DynamicTest.dynamicTest("read/${c["name"]}") {
                val store = StackStore()
                for (raw in (c["declarations"] as List<Map<String, Any?>>)) {
                    val d = decl(raw)
                    store.overrideDecls[d.name] = d
                }
                val item = HashMap<String, Any?>()
                (c["attributes"] as? Map<String, Any?>)?.let { item.putAll(it) }
                (c["overrides"] as? Map<String, Any?>)?.let { item["__overrides"] = it }
                (c["storeOverrides"] as? Map<String, Any?>)?.let { store.vars["dsx.override"] = it }
                for (e in (c["expect"] as List<Map<String, Any?>>)) {
                    val got = JSE.eval(JSE.string(e["expr"]), store, item)
                    assertEquals(canon(e["value"]), canon(got), "expr ${e["expr"]}")
                }
            }
        }
    }
}
