package despia.engine

import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.test.assertTrue

/**
 * The cross-runtime conformance runner — executes every fixture in
 * OpenSource/Conformance/jse (every .json file) ({scope, expression, expected} triples) through this
 * runtime's JSE and asserts the result with JSE's own equality (the same coercion table every
 * platform ships). The corpus is platform-count-agnostic (/web/10 W0): Swift is the reference
 * and regenerates it in record mode on Codemagic; Kotlin runs it here on every local build;
 * the TS kernel joins as runtime #3. A JSE change is illegal without a green corpus on every
 * runtime that ships it (/web/07).
 *
 * Fixture location: found by walking up from the working directory to the repo root
 * (the directory containing OpenSource/Conformance). Missing corpus = loud failure —
 * a silently-skipped conformance suite is how drift starts.
 */
class ConformanceTest {

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/jse")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/jse not found walking up from ${System.getProperty("user.dir")}")
        }
    }

    @TestFactory
    fun jseCorpus(): List<DynamicTest> {
        val files = corpusDir().listFiles { f -> f.extension == "json" }?.sorted() ?: emptyList()
        require(files.isNotEmpty()) { "conformance corpus is empty — OpenSource/Conformance/jse/*.json" }
        return files.flatMap { file ->
            val doc = json(file.readText()).foundationValue as? Map<*, *>
                ?: error("${file.name}: not a JSON object")
            @Suppress("UNCHECKED_CAST")
            val cases = doc["cases"] as? List<Map<String, Any?>>
                ?: error("${file.name}: no cases[]")
            cases.map { c ->
                val name = "${file.nameWithoutExtension}/${c["name"]}"
                DynamicTest.dynamicTest(name) {
                    @Suppress("UNCHECKED_CAST")
                    val scope = (c["scope"] as? Map<String, Any?>) ?: emptyMap()
                    val store = StackStore()
                    scope.forEach { (k, v) -> store.vars[k] = v }
                    val actual = JSE.eval(c["expression"] as String, store, null)
                    val expected = c["expected"]
                    assertTrue(
                        JSE.equals(actual, expected),
                        "$name: expression `${c["expression"]}` -> ${JSE.string(actual)} (expected ${JSE.string(expected)})"
                    )
                }
            }
        }
    }
}
