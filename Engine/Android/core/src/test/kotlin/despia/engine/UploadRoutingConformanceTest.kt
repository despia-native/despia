package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The FILE-INPUT ROUTING conformance runner — executes OpenSource/Conformance/upload/routing.json
 * through this runtime (the TS and Swift runners run the SAME file). The law and the reasoning are
 * in the corpus `_note`.
 *
 * The case worth restating: `accept="image/∗"` with `capture` must open a STILLS-ONLY camera. The
 * media-type array, not the capture mode, is what draws the PHOTO/VIDEO toggle — which is how a
 * stills-only page ended up being handed a .mov despite the mode being correctly pinned.
 */
class UploadRoutingConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/upload/routing.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/upload/routing.json not found")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun corpus() {
        val doc = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("routing.json: not a JSON object")
        val cases = (doc["cases"] as? List<*> ?: error("routing.json: no cases"))
            .map { it as Map<String, Any?> }
        assertTrue(cases.isNotEmpty(), "corpus is empty")

        for (case in cases) {
            val name = case["name"] as? String ?: "(unnamed)"
            val expect = case["expect"] as Map<String, Any?>
            val got = UploadRouting.route(
                accept = case["accept"] as? String,
                capture = case["capture"] as? String,
                nativeInterception = case["nativeInterception"] as? Boolean ?: true,
            )
            assertEquals(expect["route"] as String, got.word, "$name — route")
            when (got) {
                is FilePickerRoute.Camera -> {
                    assertEquals(expect["front"] as Boolean, got.front, "$name — front")
                    assertEquals(expect["scope"] as String, got.scope.word, "$name — scope")
                }
                is FilePickerRoute.PhotoLibrary ->
                    assertEquals(expect["scope"] as String, got.scope.word, "$name — scope")
                is FilePickerRoute.Documents ->
                    assertEquals(expect["types"] as List<String>, got.types, "$name — types")
                FilePickerRoute.SourceSheet -> Unit
            }
        }
    }

    @Test
    fun anAcceptListIsNormalizedNeverTrustedAsWritten() {
        assertEquals(listOf(".pdf", "image/png"), UploadRouting.acceptEntries(" .PDF ,, image/PNG ,"))
        assertEquals(emptyList(), UploadRouting.acceptEntries(null))
        assertEquals(emptyList(), UploadRouting.acceptEntries(",,,"))
    }

    @Test
    fun aDocumentRouteNeverHandsBackAnEmptyTypeList() {
        // An empty list would be a picker that can select nothing at all — worse than unfiltered.
        for (accept in listOf(".pdf", "application/octet-stream", "image/*,.pdf", "text/plain")) {
            val got = UploadRouting.route(accept, null)
            if (got is FilePickerRoute.Documents) assertTrue(got.types.isNotEmpty(), accept)
        }
    }
}
