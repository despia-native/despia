package despia.engine

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test

/**
 * THE ANDROID COLUMN OF `Conformance/defaults/type.json`, held to the corpus.
 *
 * The twelve type roles are ratified once and consumed three times - `TYPE_ROLE_RULES` on
 * web, `TypeRamp` here, `Text.typeRole` on the Apple reference. Each reads its OWN column,
 * so nothing copies a number across a platform boundary; what has to stay true is that the
 * three consume the same twelve rows. This test is that sentence for the Kotlin column, and
 * it runs SDK-free in :core on purpose: a mapping that can only be checked on a device is a
 * mapping that drifts between devices.
 */
class TypeRampConformanceTest {

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/defaults")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/defaults not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun tokens(): Map<String, Map<String, Any?>> {
        val root = json(File(corpusDir(), "type.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("type.json: not a JSON object")
        return root["tokens"] as? Map<String, Map<String, Any?>> ?: error("type.json: no tokens")
    }

    @Test
    fun everyCorpusRoleHasAMaterialTwin() {
        val corpus = tokens()
        assertEquals(corpus.keys.toList(), TypeRamp.MATERIAL.keys.toList(),
            "TypeRamp.MATERIAL must carry the corpus roles, in corpus order")
        for ((role, row) in corpus) {
            assertEquals(row["android"] as? String, TypeRamp.MATERIAL[role],
                "$role: the map must be the corpus's own android column")
        }
    }

    @Test
    fun wearReadsTheSameRampUntilItDoesNot() {
        // One map serves both columns because they are identical today. The day Wear's scale
        // diverges this fails, and the split happens then with a reason rather than as a
        // second copy nobody was maintaining.
        for ((role, row) in tokens()) {
            assertEquals(row["wear"] as? String, TypeRamp.MATERIAL[role],
                "$role: wear has diverged from android - split TypeRamp and say why")
        }
    }

    @Test
    fun aWordThatIsNotARungResolvesToNothing() {
        assertNull(TypeRamp.material("headlin"), "a typo must not resolve")
        assertNull(TypeRamp.material(""), "empty is not a rung")
        assertNull(TypeRamp.material(null), "absent is not a rung")
        assertEquals("labelLarge", TypeRamp.material(" label "), "surrounding space is trimmed")
    }

    @Test
    fun everyMaterialRoleNamedIsARealOne() {
        // The corpus is prose until something checks the words are Material's own. These are
        // the fifteen M3 typography roles; a typo here would render as the default forever.
        val m3 = setOf(
            "displayLarge", "displayMedium", "displaySmall",
            "headlineLarge", "headlineMedium", "headlineSmall",
            "titleLarge", "titleMedium", "titleSmall",
            "bodyLarge", "bodyMedium", "bodySmall",
            "labelLarge", "labelMedium", "labelSmall",
        )
        for ((role, material) in TypeRamp.MATERIAL) {
            assertTrue(material in m3, "$role maps to $material, which is not a Material 3 role")
        }
    }
}
