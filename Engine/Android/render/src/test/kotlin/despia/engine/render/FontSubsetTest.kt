//
//  FontSubsetTest.kt — pins the bundled Material Symbols SUBSET font to the sf-map: every
//  codepoint a row names must be mapped in the asset's cmap (StackIcons.kt render ladder,
//  rung 1). Without this, a row added WITHOUT regenerating the subset fails silently on
//  devices — the ladder fail-opens to the text fallback and every CI lane stays green
//  (the StackIcons header's "adding an icon" recipe; regen provenance rides sf-map.json's
//  `_subset_provenance` note). Plain JVM: a minimal TTF cmap reader (formats 4 + 12), no
//  font library.
//

package despia.engine.render

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertTrue
import org.junit.Test

class FontSubsetTest {

    private val mapFile = File("../../../Conformance/icons/sf-map.json")
    private val fontFile = File("src/main/assets/despia/icons/MaterialSymbolsOutlined-subset.ttf")

    @Test fun everyMapCodepointIsInTheSubsetCmap() {
        assertTrue("sf-map.json should exist at ${mapFile.absolutePath}", mapFile.exists())
        assertTrue("subset font should exist at ${fontFile.absolutePath}", fontFile.exists())
        val needed = Regex("\"codepoint\":\\s*\"([0-9a-fA-F]+)\"").findAll(mapFile.readText())
            .map { it.groupValues[1].toInt(16) }.toSortedSet()
        assertTrue("expected a populated codepoint set, got ${needed.size}", needed.size >= 80)
        val covered = cmapCodepoints(fontFile.readBytes())
        val missing = needed.filter { it !in covered }
        assertTrue("codepoints named by sf-map.json but MISSING from the bundled subset " +
                   "(regenerate it — StackIcons.kt header): " +
                   missing.joinToString { "0x" + it.toString(16) },
                   missing.isEmpty())
    }

    // MARK: - minimal TTF cmap reader (just enough for this pin: subtable formats 4 and 12)

    private fun cmapCodepoints(bytes: ByteArray): Set<Int> {
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        val numTables = buf.getShort(4).toInt() and 0xFFFF
        var cmapOffset = -1
        for (i in 0 until numTables) {
            val rec = 12 + i * 16
            val tag = String(bytes, rec, 4, Charsets.US_ASCII)
            if (tag == "cmap") { cmapOffset = buf.getInt(rec + 8); break }
        }
        assertTrue("no cmap table in the subset font", cmapOffset >= 0)
        val out = HashSet<Int>()
        val subtables = buf.getShort(cmapOffset + 2).toInt() and 0xFFFF
        for (i in 0 until subtables) {
            val sub = cmapOffset + buf.getInt(cmapOffset + 4 + i * 8 + 4)
            when (buf.getShort(sub).toInt() and 0xFFFF) {
                4 -> {
                    val segX2 = buf.getShort(sub + 6).toInt() and 0xFFFF
                    val endBase = sub + 14
                    val startBase = endBase + segX2 + 2
                    for (s in 0 until segX2 / 2) {
                        val end = buf.getShort(endBase + s * 2).toInt() and 0xFFFF
                        val start = buf.getShort(startBase + s * 2).toInt() and 0xFFFF
                        if (start == 0xFFFF && end == 0xFFFF) continue   // the terminator segment
                        for (c in start..end) out.add(c)
                    }
                }
                12 -> {
                    val groups = buf.getInt(sub + 12)
                    for (g in 0 until groups) {
                        val base = sub + 16 + g * 12
                        for (c in buf.getInt(base)..buf.getInt(base + 4)) out.add(c)
                    }
                }
            }
        }
        return out
    }
}
