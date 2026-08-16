package despia.engine

import java.io.File
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The platform-identity + attribute-suffix-fold conformance runner — executes
 * OpenSource/Conformance/platform/platform.json through THIS runtime's fold
 * (PlatformAttrs.resolve) and identity constants (Platform + the JSE reserved words).
 * The TS runner and the Swift reference run the SAME file; the law is the corpus
 * `_note` (desktop-platforms.md; /web/14): precedence exact > :desktop > :native >
 * bare, identity is the deploy target, `desktop` is derived and never an os value.
 *
 * The fold here runs the FULL target matrix (the pure function takes the target),
 * exactly like the TS runner — the render layer's resolvePlatform is this function
 * bound to Platform.os.
 *
 * Missing corpus = loud failure — a silently-skipped conformance suite is how drift
 * starts.
 */
class PlatformConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/platform/platform.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/platform/platform.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpus(): Map<String, Any?> =
        json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("platform.json: not a JSON object")

    @AfterEach
    fun restorePlatform() {
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    // MARK: - Vocabulary pinning (drift gate)

    @Test
    @Suppress("UNCHECKED_CAST")
    fun vocabularyMatchesCorpus() {
        val targets = corpus()["targets"] as? Map<String, Any?> ?: error("platform.json: no targets")
        val exact = (targets["exact"] as? List<*> ?: emptyList<Any?>()).map { JSE.string(it) }
        assertEquals(exact, PlatformAttrs.exactTargets, "exact-target vocabulary drifted from platform.json")
        val groups = (targets["groups"] as? Map<String, Any?> ?: emptyMap())
            .mapValues { (_, v) -> (v as? List<*> ?: emptyList<Any?>()).map { JSE.string(it) } }
        assertEquals(groups, PlatformAttrs.groups, "group vocabulary drifted from platform.json")
        assertEquals(groups["desktop"], Platform.desktopOses, "Platform.desktopOses drifted from platform.json")
    }

    // MARK: - The fold matrix (every case, every target it pins)

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun foldCorpus(): List<DynamicTest> {
        val cases = corpus()["fold"] as? List<Map<String, Any?>> ?: error("platform.json: no fold[]")
        assertTrue(cases.isNotEmpty(), "fold section must not be empty")
        val tests = ArrayList<DynamicTest>()
        for (c in cases) {
            val name = JSE.string(c["name"])
            val attrs = (c["attrs"] as? Map<String, Any?> ?: emptyMap()).mapValues { JSE.string(it.value) }
            val expect = c["expect"] as? Map<String, Any?> ?: emptyMap()
            for ((target, expectedRaw) in expect) {
                val expected = (expectedRaw as? Map<String, Any?> ?: emptyMap()).mapValues { JSE.string(it.value) }
                tests.add(DynamicTest.dynamicTest("platform-fold/$name/$target") {
                    assertEquals(expected, PlatformAttrs.resolve(attrs, target).toMap())
                })
            }
        }
        return tests
    }

    // MARK: - Identity (Platform + the JSE reserved words, per os)

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun identityCorpus(): List<DynamicTest> {
        val cases = corpus()["identity"] as? List<Map<String, Any?>> ?: error("platform.json: no identity[]")
        assertTrue(cases.isNotEmpty(), "identity section must not be empty")
        val tests = ArrayList<DynamicTest>()
        for (c in cases) {
            val os = JSE.string(c["os"])
            val expect = c["expect"] as? Map<String, Any?> ?: emptyMap()
            val native = expect["native"] as? Boolean ?: error("identity/$os: no native")
            val desktop = expect["desktop"] as? Boolean ?: error("identity/$os: no desktop")
            tests.add(DynamicTest.dynamicTest("platform-identity/$os") {
                val saved = Platform.os
                val savedNode = Platform.nodeTarget
                try {
                    Platform.nodeTarget = null
                    Platform.os = os
                    val store = StackStore()
                    assertEquals(os, JSE.eval("os", store, null))
                    assertEquals(os, JSE.eval("platform.os", store, null))
                    assertEquals(native, JSE.eval("platform.native", store, null))
                    assertEquals(desktop, JSE.eval("platform.desktop", store, null))
                    assertEquals(desktop, Platform.isDesktop(os))
                } finally {
                    Platform.os = saved
                    Platform.nodeTarget = savedNode
                }
            })
        }
        return tests
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun nodeTargetCorpus(): List<DynamicTest> {
        val cases = corpus()["nodes"] as? List<Map<String, Any?>> ?: error("platform.json: no nodes[]")
        assertTrue(cases.isNotEmpty(), "nodes section must not be empty")
        return cases.map { c ->
            val os = JSE.string(c["os"])
            val node = c["node"]?.let { JSE.string(it) }?.takeIf { it.isNotEmpty() }
            val expected = JSE.string(c["attributeTarget"])
            DynamicTest.dynamicTest("platform-node/$os/${node ?: "phone"}") {
                val savedOs = Platform.os
                val savedNode = Platform.nodeTarget
                try {
                    Platform.os = os
                    Platform.nodeTarget = node
                    assertEquals(os, JSE.eval("platform.os", StackStore(), null))
                    assertEquals(expected, Platform.attributeTarget)
                } finally {
                    Platform.os = savedOs
                    Platform.nodeTarget = savedNode
                }
            }
        }
    }
}
