package despia.engine.desktop

import despia.engine.StackFonts
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The desktop font book. `fontFamily`, `fontVariation` and `fontFeature` are all catalogued style
 * attributes, and until this lane had a font book they were inert here while working on the other
 * three renderers - so a brand typeface declared by a module was simply absent on Windows and
 * Linux (constitution Article 10).
 *
 * The registry is a BUILD ARTIFACT, so what is asserted here is everything that happens before
 * Compose is handed a path: the parse, the face selection, the axis fold, and the fail-open. The
 * `Font(resource = …)` construction itself is two lines and needs a real typeface on the
 * classpath, which is the packaged app's business rather than this suite's.
 */
class DesktopFontBookTest {

    private val registry = """
        {
          "families": {
            "Brand": {
              "faces": [
                { "weight": 400, "italic": false, "file": "Brand-Regular.ttf", "postscriptName": "Brand-Regular" },
                { "weight": 400, "italic": true,  "file": "Brand-Italic.ttf",  "postscriptName": "Brand-Italic" },
                { "weight": 700, "italic": false, "file": "Brand-Bold.ttf",    "postscriptName": "Brand-Bold" }
              ],
              "variable": false,
              "fallback": ["system"]
            },
            "Flex": {
              "faces": [
                { "weight": 400, "italic": false, "file": "Flex.ttf", "postscriptName": "Flex-Regular" }
              ],
              "variable": true,
              "axes": { "wght": [300, 800], "SOFT": [0, 100] },
              "defaults": { "wght": 420 }
            }
          }
        }
    """.trimIndent()

    private fun withRegistry(text: String?, body: () -> Unit) {
        try {
            DesktopFontBook.loadForTesting(text)
            body()
        } finally {
            DesktopFontBook.loadForTesting(null)
        }
    }

    @Test
    fun theRegistryParsesIntoFamiliesFacesAndAxes() = withRegistry(registry) {
        assertEquals(listOf("Brand", "Flex"), DesktopFontBook.declaredNames)
        val brand = DesktopFontBook.family("Brand")!!
        assertEquals(3, brand.faces.size)
        assertEquals(listOf("system"), brand.fallback)
        assertTrue(DesktopFontBook.hasItalicFace("Brand"), "a real italic face must be visible")
        assertTrue(!DesktopFontBook.hasItalicFace("Flex"), "Flex ships no italic")

        val flex = DesktopFontBook.family("Flex")!!
        assertTrue(flex.variable)
        assertEquals(300.0 to 800.0, flex.axes["wght"])
        assertEquals(420.0, flex.defaults["wght"])
        // An undeclared fallback chain still ends at the platform, never at nothing.
        assertEquals(listOf("system"), flex.fallback)
    }

    @Test
    fun anUnknownFamilyResolvesToNothingSoTheCallerKeepsThePlatformFont() = withRegistry(registry) {
        assertNull(DesktopFontBook.family("Nope"))
        assertNull(DesktopFontBook.axisSettings("Nope", null))
        assertNull(DesktopFontBook.resolve("Nope", null), "Article 7: absence fails open")
    }

    /** No registry resource at all is the ordinary case for an app that ships no fonts. */
    @Test
    fun noRegistryIsNotAnError() = withRegistry(null) {
        assertEquals(emptyList(), DesktopFontBook.declaredNames)
        assertNull(DesktopFontBook.resolve("Brand", null))
    }

    @Test
    fun malformedRegistryTextDegradesToNoFamilies() {
        assertEquals(emptyMap(), DesktopFontBook.parse("{ not json"))
        assertEquals(emptyMap(), DesktopFontBook.parse("""{"families":{"X":{"faces":[]}}}"""))
        assertEquals(emptyMap(), DesktopFontBook.parse("""{"nope":1}"""))
    }

    /**
     * The axis fold is the shared core's (StackFonts.resolveVariation), so what matters here is
     * that this lane feeds it the family's DECLARED ranges and its defaults - a requested axis
     * clamps, an undeclared axis drops, and the default survives when nothing is requested.
     */
    @Test
    fun requestedAxesClampAgainstTheFamilyAndDefaultsSurvive() = withRegistry(registry) {
        val (_, defaults) = DesktopFontBook.axisSettings("Flex", null)!!
        assertEquals(mapOf("wght" to 420.0), defaults, "the declared default applies unasked")

        val (_, clamped) = DesktopFontBook.axisSettings("Flex", "wght 2000")!!
        assertEquals(800.0, clamped["wght"], "a request past the range clamps to it")

        val (_, dropped) = DesktopFontBook.axisSettings("Flex", "GRAD 50")!!
        assertTrue(!dropped.containsKey("GRAD"), "an axis the family does not declare is dropped")
        assertEquals(420.0, dropped["wght"], "dropping one axis must not lose the others")

        val (_, static) = DesktopFontBook.axisSettings("Brand", "wght 600")!!
        assertTrue(static.isEmpty(), "a static family declares no axes, so every axis drops")
    }

    /** The cache key has to move with the axes or two different instances share one typeface. */
    @Test
    fun theCacheKeyDistinguishesAxisSets() = withRegistry(registry) {
        val (a, _) = DesktopFontBook.axisSettings("Flex", "wght 500")!!
        val (b, _) = DesktopFontBook.axisSettings("Flex", "wght 700")!!
        val (c, _) = DesktopFontBook.axisSettings("Flex", "wght 500")!!
        assertTrue(a != b, "two axis sets must not share a cache entry")
        assertEquals(a, c, "the same axis set must hit the same entry")
    }

    /** The selection law lives in :core; this pins that the book hands it the right pool. */
    @Test
    fun faceSelectionRunsThroughTheSharedCore() = withRegistry(registry) {
        val faces = DesktopFontBook.family("Brand")!!.faces
        assertEquals(700, StackFonts.selectFace(faces, 700, italic = false)!!.face.weight)
        assertEquals(400, StackFonts.selectFace(faces, 400, italic = true)!!.face.weight)
        assertTrue(StackFonts.selectFace(faces, 400, italic = true)!!.face.italic)
    }
}
