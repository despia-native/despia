package despia.engine

import java.io.File
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The localization kernel-seam conformance runner — executes
 * OpenSource/Conformance/strings/cases.json through THIS runtime's DSXStrings (the TS
 * runner and the Swift reference run the SAME file). The laws under test are the corpus
 * `_note`: the locale ladder (global.locale over the device language, `en` is the
 * source), full-tag-then-bare candidate order with the first non-empty merged table
 * winning outright, the runtime tier merging OVER the bundle tier, the (lang, version)
 * reload key (a runtime writer must bump global.strings.version to be seen), and
 * fail-open identity for every miss, absent table, invalid table JSON, and empty input.
 *
 * The seams are driven exactly as the web runner drives them: `statePath` reads the
 * case's dot-keyed state map, `loader` serves the case's bundle-table TEXT (text, so
 * invalid JSON is expressible), `deviceLang` is the case's device.
 */
class StringsConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/strings/cases.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/strings/cases.json not found")
        }
    }

    private val savedDeviceLang = DSXStrings.deviceLang

    @AfterEach
    fun restore() {
        DSXStrings.loader = null
        DSXStrings.statePath = { null }
        DSXStrings.deviceLang = savedDeviceLang
        // force the next lookup to reload: the cache keys on (lang, version), and a
        // fresh case may resolve the same pair with different seams
        DSXStrings.localize("")
        DSXStrings.deviceLang = "__reset"
        DSXStrings.localize("x")
        DSXStrings.deviceLang = savedDeviceLang
    }

    @Suppress("UNCHECKED_CAST")
    @TestFactory
    fun corpusCases(): List<DynamicTest> {
        val doc = json(corpusFile().readText()).foundationValue as? Map<*, *>
            ?: error("strings/cases.json: not a JSON object")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("strings/cases.json: no cases")
        assertTrue(cases.size >= 15, "expected the full case set, found ${cases.size}")
        return cases.map { c ->
            DynamicTest.dynamicTest(c["name"] as String) {
                val state = HashMap<String, Any?>((c["state"] as? Map<String, Any?>) ?: emptyMap())
                val tables = (c["tables"] as? Map<String, Any?>) ?: emptyMap()
                // invalidate the cache across cases: a lang the runtime has never seen
                DSXStrings.statePath = { null }
                DSXStrings.deviceLang = "__cache-break-${c["name"]}"
                DSXStrings.localize("x")
                DSXStrings.loader = { lang -> tables[lang] as? String }
                DSXStrings.statePath = { path -> if (state.containsKey(path)) state[path] else null }
                DSXStrings.deviceLang = (c["device"] as? String) ?: "en"
                val steps: List<Map<String, Any?>> = (c["steps"] as? List<Map<String, Any?>>)
                    ?: listOf(mapOf("input" to c["input"], "expect" to c["expect"]))
                steps.forEachIndexed { index, step ->
                    (step["state"] as? Map<String, Any?>)?.let { state.putAll(it) }
                    assertEquals(
                        step["expect"] as String,
                        DSXStrings.localize(step["input"] as String),
                        "${c["name"]}: step ${index + 1}",
                    )
                }
            }
        }
    }
}
