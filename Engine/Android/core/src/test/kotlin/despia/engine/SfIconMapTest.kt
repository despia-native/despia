package despia.engine

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/// Plain-JVM units for the pure half of the icon seam (SfIconMap.kt — moved here from
/// :render with the class, so the ONE parse implementation tests in the fast local
/// loop): the sf-map table parses, resolves, and fails open. Runs against the REAL
/// shared table — OpenSource/Conformance/icons/sf-map.json, the same bytes :render's
/// copySfMapJson packages into the AAR and the wear APK bundles — so a malformed edit
/// to the ONE file breaks here first. (The @Composable paint halves stay per-module:
/// :render StackIcons.kt, :wear WearIcon — no paint tests ride this suite.)
class SfIconMapTest {

    // Located by walking up from the working directory (the ConformanceTest idiom) —
    // robust to whichever project dir Gradle runs the suite from.
    private fun sourceFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/icons/sf-map.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/icons/sf-map.json not found walking up from ${System.getProperty("user.dir")}")
        }
    }

    private val source = sourceFile()
    private val map = SfIconMap.parse(source.readText())

    @Test fun theSharedTableParses() {
        assertTrue(source.exists(), "sf-map.json should exist at ${source.absolutePath}")
        // The shipped corpus + StackReference defaults land ~98 rows; never shrink silently.
        assertTrue(map.size >= 90, "expected a populated map, got ${map.size}")
    }

    @Test fun everyRowIsRenderable() {
        val json = source.readText()
        val names = Regex("\"([a-z0-9.]+)\":\\s*\\{").findAll(json).map { it.groupValues[1] }
            .filter { it != "icons" }.toList()
        for (name in names) {
            val glyph = map.resolve(name)
            assertTrue(glyph != null, "row $name missing from parsed map")
            assertTrue(glyph.material.isNotEmpty(), "$name: material name empty")
            assertTrue(glyph.glyph.isNotEmpty(), "$name: codepoint did not parse to a glyph")
            assertTrue(glyph.fallback.isNotEmpty(), "$name: fallback empty")
        }
    }

    @Test fun resolvesTheCoreVocabulary() {
        val check = map.resolve("checkmark")!!
        assertEquals("check", check.material)
        assertEquals("\uE668", check.glyph)         // check = e668 (Material Symbols cmap)
        assertEquals("✓", check.fallback)
        assertEquals("close", map.resolve("xmark")!!.material)
        assertEquals("add", map.resolve("plus")!!.material)
        assertEquals("home", map.resolve("house")!!.material)
        assertEquals("search", map.resolve("magnifyingglass")!!.material)
        assertEquals("shopping_cart", map.resolve("cart")!!.material)
        assertEquals("person", map.resolve("person.fill")!!.material)
        assertEquals("more_horiz", map.resolve("ellipsis")!!.material)
        assertEquals("\uE5D3", map.resolve("ellipsis")!!.glyph)
        // The system-chrome back glyph (RouterChrome.kt) — the platform's arrow_back (e5c4).
        assertEquals("arrow_back", map.resolve("arrow.backward")!!.material)
        assertEquals("\uE5C4", map.resolve("arrow.backward")!!.glyph)
        assertEquals("inbox", map.resolve("tray")!!.material)          // the EmptyState default
        assertEquals("radio_button_unchecked", map.resolve("circle")!!.material)
        // .fill pairs that must stay visually distinct map to DIFFERENT glyphs
        assertEquals("fiber_manual_record", map.resolve("circle.fill")!!.material)
    }

    @Test fun unknownNamesFailOpenToNull() {
        assertNull(map.resolve("not.a.symbol"))
        assertNull(map.resolve(""))
    }

    @Test fun malformedJsonFailsOpenToAnEmptyMap() {
        assertEquals(0, SfIconMap.parse("not json").size)
        assertEquals(0, SfIconMap.parse("{}").size)
        assertEquals(0, SfIconMap.parse("""{"icons": 3}""").size)
    }

    @Test fun aPartialRowStillParses() {
        val m = SfIconMap.parse("""{"icons":{"x":{"fallback":"?"}}}""")
        val g = m.resolve("x")!!
        assertEquals("", g.material)
        assertEquals("", g.glyph)                    // no codepoint → font rung skipped
        assertEquals("?", g.fallback)                // fallback rung still renders
    }
}
