//
//  SfIconMap.kt — the PURE half of the cross-platform icon contract: the parsed sf-map
//  table (StackReference.md: `icon` is a semantic token, resolved by the SAME name on
//  every platform — never a per-platform id). Moved here from :render's StackIcons.kt
//  so it exists ONCE for every consumer: :render's StackIcon, the wear APK's WearIcon
//  (which must not depend on :render), and module code (MenuBar) — all resolve through
//  this one class over the one data file.
//
//  THE DATA is one copy, never forked: OpenSource/Conformance/icons/sf-map.json —
//  SF name → { material (Material Symbols name), codepoint (its PUA cmap slot),
//  fallback (plain unicode/text) } — packaged per-artifact by each build's
//  `copySfMapJson` task (:render AAR assets, the wear APK's generated assets).
//
//  The @Composable PAINT halves (asset loading + the render ladder: subset font glyph →
//  unicode/text fallback → drawn placeholder) stay per-module — :render StackIcons.kt,
//  :wear StackWear.kt WearIcon — with their own header pins; this class is pure JVM
//  (:core law: no android.*), so its units run in the fast local loop (SfIconMapTest
//  against the REAL Conformance JSON).
//

package despia.engine

/// The parsed sf-map: SF Symbol name → glyph resolution. Fail-open: bad JSON or a bad
/// row parses to an empty/partial map (a consumer then walks down the render ladder).
class SfIconMap private constructor(private val icons: Map<String, Glyph>) {

    /// One icon's resolution: `glyph` = the Material Symbols codepoint as a renderable
    /// string (empty when the row carries no valid codepoint), `fallback` = the plain
    /// unicode/text stand-in (may be empty).
    data class Glyph(val material: String, val glyph: String, val fallback: String)

    val size: Int get() = icons.size

    /// The SF name's resolution, or null when unmapped (the caller's placeholder).
    fun resolve(name: String): Glyph? = icons[name]

    companion object {
        fun parse(text: String): SfIconMap {
            val root = json(text).foundationValue as? Map<*, *> ?: return SfIconMap(emptyMap())
            val rows = root["icons"] as? Map<*, *> ?: return SfIconMap(emptyMap())
            val out = LinkedHashMap<String, Glyph>()
            for ((k, v) in rows) {
                val name = k as? String ?: continue
                val row = v as? Map<*, *> ?: continue
                val codepoint = (row["codepoint"] as? String)?.toIntOrNull(16)
                out[name] = Glyph(
                    material = row["material"] as? String ?: "",
                    glyph = codepoint?.let { String(Character.toChars(it)) } ?: "",
                    fallback = row["fallback"] as? String ?: "")
            }
            return SfIconMap(out)
        }
    }
}
