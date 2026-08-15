//
//  StackIcons.kt — SF Symbol resolution for the Compose renderer: the Android half of
//  the cross-platform icon contract (StackReference.md: `icon` is a semantic token,
//  resolved by the SAME name on every platform — never a per-platform id).
//
//  THE #1 .dsx PORTABILITY SEAM: the shipped corpus names SF Symbols
//  (`icon="checkmark.circle.fill"`), which exist only on Apple platforms. The map that
//  closes it is DATA, one file, never forked: OpenSource/Conformance/icons/sf-map.json —
//  SF name → { material (Material Symbols name), codepoint (its PUA cmap slot),
//  fallback (plain unicode/text) }. PACKAGING DECISION (the two documented options were
//  a packaged :render asset vs generated Kotlin): the JSON rides into the AAR as an
//  ASSET, copied at build from Conformance by the `copySfMapJson` task in this module's
//  build.gradle.kts (the runtime.js ONE-copy precedent) — no codegen step, the file
//  stays byte-shared with every other runtime, and a map edit needs no Kotlin rebuild
//  of anything but resources.
//
//  RENDER LADDER (fail-open at every rung):
//    1. the bundled Material Symbols font — a 14 KB STATIC SUBSET of the variable font
//       (google/material-design-icons, Apache-2.0 — license text ships beside it at
//       assets/despia/icons/LICENSE-MaterialSymbols.txt), instanced at the default axes
//       (wght 400, FILL 0, GRAD 0, opsz 24) and subset to exactly the map's codepoints.
//       The FULL variable font is ~10 MB — NOT trivially embeddable; the subset is.
//       Rendered as the glyph's PUA codepoint char in that font. (SF `.fill` variants
//       share their outline sibling's glyph — the FILL axis is pinned at 0; pairs that
//       must stay distinct map to two different material glyphs. See the JSON's notes.)
//    2. the map's `fallback` unicode/text stand-in (system font).
//    3. a drawn placeholder (a soft outlined box) — unknown SF name / empty map.
//  ADDING AN ICON to markup = adding its row to sf-map.json AND regenerating the font
//  subset so the new codepoint is covered (pyftsubset over the instanced variable font
//  with the map's codepoint set — the asset's provenance note travels with the JSON).
//
//  SPLIT for testability: `SfIconMap` (parse + resolve) is pure JVM and lives in :core
//  (despia.engine.SfIconMap — ONE copy for :render, the wear APK's WearIcon, and module
//  consumers; its plain-JVM units run there, SfIconMapTest, against the REAL
//  Conformance JSON); only `StackIcon` (the paint half: asset loading +
//  BasicText/placeholder) touches Android and stays here.
//
//  Pinned deviation: iOS draws SF icons at weight semibold (StackReference); the static
//  subset is instanced at wght 400 (the Material default look) — one weight for all.
//

package despia.engine.render

import android.content.Context
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.Typeface
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// MARK: - the pure half: the sf-map table (moved to :core — despia.engine.SfIconMap)

/// The historical :render spelling, kept as an alias so existing consumers
/// (`import despia.engine.render.SfIconMap` — module code like MenuBar) keep
/// compiling; the ONE class now lives in :core beside the other pure-JVM kernel
/// halves. New code should import despia.engine.SfIconMap directly.
typealias SfIconMap = despia.engine.SfIconMap

// MARK: - the paint half: asset loading + the icon element

private const val SF_MAP_ASSET = "despia/icons/sf-map.json"
private const val ICON_FONT_ASSET = "despia/icons/MaterialSymbolsOutlined-subset.ttf"

/// Process-wide icon assets, loaded once on first icon (both loads fail open to null —
/// the render ladder degrades per rung, never throws into composition).
internal object StackIconAssets {
    @Volatile private var loaded = false
    @Volatile var map: SfIconMap? = null; private set
    @Volatile var font: FontFamily? = null; private set

    fun load(context: Context) {
        if (loaded) return
        synchronized(this) {
            if (loaded) return
            map = runCatching {
                context.assets.open(SF_MAP_ASSET).use { SfIconMap.parse(it.readBytes().toString(Charsets.UTF_8)) }
            }.getOrNull()
            font = runCatching {
                FontFamily(Typeface(android.graphics.Typeface.createFromAsset(context.assets, ICON_FONT_ASSET)))
            }.getOrNull()
            loaded = true
        }
    }
}

/// One icon, resolved through the sf-map render ladder (header). `name` is the SF
/// Symbol name straight off the markup (already interpolated by the caller); `size`
/// in points (iconSize semantics), `color` the tint.
@Composable
internal fun StackIcon(name: String, size: Double, color: Color, modifier: Modifier = Modifier) {
    val context = LocalContext.current.applicationContext
    remember { StackIconAssets.load(context); true }
    val glyph = StackIconAssets.map?.resolve(name)
    val font = StackIconAssets.font
    when {
        glyph != null && glyph.glyph.isNotEmpty() && font != null ->
            BasicText(glyph.glyph, modifier,
                      style = TextStyle(color = color, fontSize = size.sp, fontFamily = font))
        glyph != null && glyph.fallback.isNotEmpty() ->
            BasicText(glyph.fallback, modifier,
                      style = TextStyle(color = color, fontSize = size.sp))
        else ->
            // The drawn placeholder: a soft outlined box holding the icon's layout slot
            // (fail-open — unmapped names render structure, never an error).
            Box(modifier.size(size.dp)
                .border(1.dp, color.copy(alpha = 0.35f), RoundedCornerShape((size / 4).dp)))
    }
}
