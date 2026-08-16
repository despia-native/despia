//
//  SvgElements.kt — `<svg>` (Kotlin twin of SVG.swift). A NATIVE SVG renderer — SVG is
//  just markup the Stack renders; no WebView, no dependency. The SAME practical subset
//  as iOS: rect / circle / ellipse / line / polygon / polyline / path with
//  M L H V C S Q T Z (absolute + relative, implicit repeats); fill / stroke /
//  stroke-width / opacity (+ fill-opacity); viewBox (else width/height, else 0..100) —
//  parsed into pure command lists (SvgModel — plain-JVM tested) and drawn in a Compose
//  Canvas, aspect-fit + centered, stroke widths scaled, SVG-default BLACK fill.
//
//  Source, in iOS priority order:
//    asset="logo"            → `logo.svg` from the APK assets.
//    src="<raw markup>"      → inline SVG markup (or an asset resource name).
//    d="M0 0 L10 10 Z" …     → a single path; `viewBox` + `fill` ride the tag.
//
//  Sizing: `width`/`height` land through the universal style chain like iOS; unset, the
//  canvas fills its width at the viewBox's aspect (PINNED: SwiftUI's Canvas takes every
//  proposed axis — in an unbounded Compose column that proposal doesn't exist, so the
//  aspect keeps the element measurable). Static SVG only, like iOS (loaders later).
//

package despia.engine.render.elements

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.StackStyle

internal fun registerSvgElements() {
    ComposeStackComponents.defineNative("svg") { ctx -> SvgView(ctx) }
}

@Composable
private fun SvgView(ctx: ComposeStackComponentContext) {
    val context = LocalContext.current
    val asset = ctx.interp("asset") ?: ""
    val src = ctx.interp("src") ?: ""
    val dAttr = ctx.attrs["d"]?.let { ctx.interp("d") ?: "" }
    val viewBox = ctx.str("viewBox", "0 0 100 100")
    val fill = ctx.str("fill", "#000000")
    val markup = remember(asset, src, dAttr, viewBox, fill) {
        resolveSvgSource(asset, src, dAttr, viewBox, fill) { name ->
            loadSvgAsset(context, name)
        }
    }
    val doc = remember(markup) { SvgModel.parse(markup) } ?: return
    // `fill=` on the single-path convenience form is a DSX-facing color attribute, so semantic
    // design tokens must follow the live Material scheme. Keep raw inline SVG markup on the SVG
    // grammar (including #rrggbbaa) and override only known DSX semantic words.
    val semanticFill =
        if (dAttr != null && isDsxSemanticSvgColor(fill)) StackStyle.color(fill) else null
    val hasW = ctx.attrs["width"] != null
    val hasH = ctx.attrs["height"] != null
    val aspect = if (doc.viewBox.w > 0 && doc.viewBox.h > 0) (doc.viewBox.w / doc.viewBox.h).toFloat() else 1f
    val sizing = if (hasW || hasH) Modifier else Modifier.fillMaxWidth().aspectRatio(aspect)
    Canvas(Modifier.elementModifier(ctx).then(sizing)) {
        val vb = doc.viewBox
        if (vb.w <= 0 || vb.h <= 0) return@Canvas
        val scale = minOf(size.width / vb.w.toFloat(), size.height / vb.h.toFloat())
        val dx = (size.width - vb.w.toFloat() * scale) / 2 - vb.x.toFloat() * scale
        val dy = (size.height - vb.h.toFloat() * scale) / 2 - vb.y.toFloat() * scale
        val m = Matrix().apply { translate(dx, dy); scale(scale, scale) }
        for (p in doc.prims) {
            val path = SvgModel.toPath(p.commands).apply { transform(m) }
            val resolvedFill = if (semanticFill != null && p.fill != null) semanticFill else p.fill
            resolvedFill?.let {
                drawPath(path, it.copy(alpha = it.alpha * p.opacity.toFloat()))
            }
            if (p.stroke != null && p.strokeWidth > 0) {
                drawPath(path, p.stroke.copy(alpha = p.stroke.alpha * p.opacity.toFloat()),
                         style = Stroke(width = p.strokeWidth.toFloat() * scale))
            }
        }
    }
}

private val DSX_SEMANTIC_SVG_COLORS = setOf(
    "accent",
    "label",
    "text",
    "secondary",
    "secondaryLabel",
    "tertiary",
    "tertiaryLabel",
    "background",
    "systemBackground",
    "secondaryBackground",
    "tertiaryBackground",
    "groupedBackground",
    "secondaryGroupedBackground",
    "fill",
    "fillFaint",
    "separator",
    "destructive",
)

internal fun isDsxSemanticSvgColor(raw: String): Boolean =
    DSX_SEMANTIC_SVG_COLORS.contains(raw)

/// asset → src (inline markup or asset name) → d (single-path convenience) — SVG.swift.
internal fun resolveSvgSource(asset: String, src: String, d: String?, viewBox: String,
                              fill: String, loadAsset: (String) -> String?): String {
    if (asset.isNotEmpty()) loadAsset(asset)?.takeIf(MediaInputPolicy::acceptsSvgMarkup)?.let { return it }
    if (src.isNotEmpty()) {
        if (src.contains("<svg") || src.contains("<path")) {
            return src.takeIf(MediaInputPolicy::acceptsSvgMarkup) ?: ""
        }
        loadAsset(src)?.takeIf(MediaInputPolicy::acceptsSvgMarkup)?.let { return it }
    }
    if (d != null) {
        val generated = "<svg viewBox=\"$viewBox\"><path d=\"$d\" fill=\"$fill\"/></svg>"
        return generated.takeIf(MediaInputPolicy::acceptsSvgMarkup) ?: ""
    }
    return ""
}

/// Load `<name>.svg` (or `<name>`) from the APK assets — the Bundle.main twin.
private fun loadSvgAsset(context: android.content.Context, name: String): String? {
    val normalized = MediaInputPolicy.normalizedAssetPath(name) ?: return null
    val base = if (normalized.endsWith(".svg")) normalized.dropLast(4) else normalized
    for (candidate in listOf("$base.svg", normalized).distinct()) {
        runCatching {
            context.assets.open(candidate).use {
                val bytes = MediaInputPolicy.readBounded(it, MediaInputPolicy.MAXIMUM_SVG_BYTES)
                    ?: return@use null
                return MediaInputPolicy.strictUTF8(bytes)
            }
        }
    }
    return null
}

// MARK: - the pure model + parser (plain-JVM tested — ElementsLogicTest.kt)

internal object SvgModel {

    data class ViewBox(val x: Double, val y: Double, val w: Double, val h: Double)
    /// One path command in viewBox space — the pure, testable form of a SwiftUI Path.
    sealed class Cmd {
        data class Move(val x: Double, val y: Double) : Cmd()
        data class Line(val x: Double, val y: Double) : Cmd()
        data class Cubic(val x1: Double, val y1: Double, val x2: Double, val y2: Double,
                         val x: Double, val y: Double) : Cmd()
        data class Quad(val cx: Double, val cy: Double, val x: Double, val y: Double) : Cmd()
        object Close : Cmd()
    }
    class Prim(val commands: List<Cmd>, val fill: Color?, val stroke: Color?,
               val strokeWidth: Double, val opacity: Double)
    class Doc(val viewBox: ViewBox, val prims: List<Prim>)

    private val shapeTags = setOf("path", "circle", "ellipse", "rect", "line", "polygon", "polyline")

    fun parse(markup: String): Doc? {
        if (!MediaInputPolicy.acceptsSvgMarkup(markup)) return null
        val src = markup.trim()
        if (src.isEmpty()) return null

        var viewBox = ViewBox(0.0, 0.0, 100.0, 100.0)
        val svgTag = firstTag("svg", src)
        val vb = attr("viewBox", svgTag ?: src)
        if (vb != null) {
            val n = numbers(vb)
            if (n.size != 4 || !n.all(::validScalar)) return null
            viewBox = ViewBox(n[0], n[1], n[2], n[3])
        } else if (svgTag != null) {
            val w = attr("width", svgTag)?.let { numericPrefix(it).toDoubleOrNull() }
            val h = attr("height", svgTag)?.let { numericPrefix(it).toDoubleOrNull() }
            if (w != null && h != null && validScalar(w) && validScalar(h) && w > 0 && h > 0) {
                viewBox = ViewBox(0.0, 0.0, w, h)
            }
        }
        if (!validScalar(viewBox.x) || !validScalar(viewBox.y) ||
            !validScalar(viewBox.w) || !validScalar(viewBox.h) ||
            viewBox.w < 1e-9 || viewBox.h < 1e-9) return null

        val prims = ArrayList<Prim>()
        for ((tag, body) in elements(src) ?: return null) {
            val commands = shapeCommands(tag, body) ?: continue
            val fillRaw = attr("fill", body)
            val strokeRaw = attr("stroke", body)
            val fill: Color? = when {
                fillRaw == null -> Color.Black                    // SVG default fill is black
                fillRaw == "none" -> null
                else -> color(fillRaw)
            }
            val stroke: Color? = if (strokeRaw == null || strokeRaw == "none") null else color(strokeRaw)
            val sw = attr("stroke-width", body)?.let { numericPrefix(it).toDoubleOrNull() } ?: 1.0
            val op = attr("opacity", body)?.toDoubleOrNull()
                ?: attr("fill-opacity", body)?.toDoubleOrNull() ?: 1.0
            if (!validScalar(sw) || !validScalar(op) || sw < 0) return null
            prims.add(Prim(commands, fill, stroke, sw, op.coerceIn(0.0, 1.0)))
        }
        return if (prims.isEmpty()) null else Doc(viewBox, prims)
    }

    /// The paint half's bridge: command list → a Compose Path.
    fun toPath(commands: List<Cmd>): Path {
        val p = Path()
        for (c in commands) when (c) {
            is Cmd.Move -> p.moveTo(c.x.toFloat(), c.y.toFloat())
            is Cmd.Line -> p.lineTo(c.x.toFloat(), c.y.toFloat())
            is Cmd.Cubic -> p.cubicTo(c.x1.toFloat(), c.y1.toFloat(),
                                      c.x2.toFloat(), c.y2.toFloat(), c.x.toFloat(), c.y.toFloat())
            is Cmd.Quad -> p.quadraticTo(c.cx.toFloat(), c.cy.toFloat(),
                                         c.x.toFloat(), c.y.toFloat())
            Cmd.Close -> p.close()
        }
        return p
    }

    // ── shapes → commands ──
    private fun shapeCommands(tag: String, body: String): List<Cmd>? {
        fun d(k: String): Double = attr(k, body)?.let { numericPrefix(it).toDoubleOrNull() } ?: 0.0
        return when (tag) {
            "path" -> attr("d", body)?.let { parsePathData(it).takeIf { commands -> commands.isNotEmpty() } }
            "circle" -> {
                val r = d("r"); if (r <= 0) null else ellipseCommands(d("cx"), d("cy"), r, r)
            }
            "ellipse" -> {
                val rx = d("rx"); val ry = d("ry")
                if (rx <= 0 || ry <= 0) null else ellipseCommands(d("cx"), d("cy"), rx, ry)
            }
            "rect" -> {
                val w = d("width"); val h = d("height")
                if (w <= 0 || h <= 0) return null
                val x = d("x"); val y = d("y")
                val r = maxOf(d("rx"), d("ry")).coerceAtMost(minOf(w, h) / 2)
                if (r <= 0) listOf(Cmd.Move(x, y), Cmd.Line(x + w, y), Cmd.Line(x + w, y + h),
                                   Cmd.Line(x, y + h), Cmd.Close)
                else roundedRectCommands(x, y, w, h, r)
            }
            "line" -> listOf(Cmd.Move(d("x1"), d("y1")), Cmd.Line(d("x2"), d("y2")))
            "polygon", "polyline" -> {
                val n = attr("points", body)?.let { numbers(it) } ?: return null
                if (n.size < 4) return null
                val out = ArrayList<Cmd>()
                out.add(Cmd.Move(n[0], n[1]))
                var i = 2
                while (i + 1 < n.size) { out.add(Cmd.Line(n[i], n[i + 1])); i += 2 }
                if (tag == "polygon") out.add(Cmd.Close)
                out
            }
            else -> null
        }
    }

    /// An ellipse as four cubic arcs (kappa) — the Path(ellipseIn:) twin.
    private fun ellipseCommands(cx: Double, cy: Double, rx: Double, ry: Double): List<Cmd> {
        val k = 0.5522847498307936
        val ox = rx * k; val oy = ry * k
        return listOf(
            Cmd.Move(cx + rx, cy),
            Cmd.Cubic(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry),
            Cmd.Cubic(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy),
            Cmd.Cubic(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry),
            Cmd.Cubic(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy),
            Cmd.Close,
        )
    }

    /// A rounded rect from lines + corner quads — the Path(roundedRect:) twin.
    private fun roundedRectCommands(x: Double, y: Double, w: Double, h: Double, r: Double): List<Cmd> =
        listOf(
            Cmd.Move(x + r, y),
            Cmd.Line(x + w - r, y), Cmd.Quad(x + w, y, x + w, y + r),
            Cmd.Line(x + w, y + h - r), Cmd.Quad(x + w, y + h, x + w - r, y + h),
            Cmd.Line(x + r, y + h), Cmd.Quad(x, y + h, x, y + h - r),
            Cmd.Line(x, y + r), Cmd.Quad(x, y, x + r, y),
            Cmd.Close,
        )

    // ── the path `d` grammar (M L H V C S Q T Z, abs+rel, implicit repeats) ──
    fun parsePathData(d: String): List<Cmd> {
        val out = ArrayList<Cmd>()
        var curX = 0.0; var curY = 0.0
        var startX = 0.0; var startY = 0.0
        var lastCtrlX: Double? = null; var lastCtrlY: Double? = null   // for S/T smoothing
        var lastCmd = ' '
        val toks = tokenizePath(d)
        if (toks.size > MediaInputPolicy.MAXIMUM_SVG_PATH_TOKENS) return emptyList()
        var i = 0
        fun num(): Double { val v = if (i < toks.size) toks[i].num ?: 0.0 else 0.0; i += 1; return v }

        while (i < toks.size) {
            val cmd = toks[i].cmd
            if (cmd == null) { i += 1; continue }
            i += 1
            val rel = cmd.isLowerCase()
            val c = cmd.uppercaseChar()
            do {
                when (c) {
                    'M' -> {
                        val x = num(); val y = num()
                        curX = if (rel) curX + x else x; curY = if (rel) curY + y else y
                        out.add(Cmd.Move(curX, curY)); startX = curX; startY = curY
                        lastCtrlX = null; lastCtrlY = null
                    }
                    'L' -> {
                        val x = num(); val y = num()
                        curX = if (rel) curX + x else x; curY = if (rel) curY + y else y
                        out.add(Cmd.Line(curX, curY)); lastCtrlX = null; lastCtrlY = null
                    }
                    'H' -> {
                        val x = num(); curX = if (rel) curX + x else x
                        out.add(Cmd.Line(curX, curY)); lastCtrlX = null; lastCtrlY = null
                    }
                    'V' -> {
                        val y = num(); curY = if (rel) curY + y else y
                        out.add(Cmd.Line(curX, curY)); lastCtrlX = null; lastCtrlY = null
                    }
                    'C' -> {
                        val x1 = if (rel) curX + num() else num(); val y1 = if (rel) curY + num() else num()
                        val x2 = if (rel) curX + num() else num(); val y2 = if (rel) curY + num() else num()
                        val x = if (rel) curX + num() else num(); val y = if (rel) curY + num() else num()
                        out.add(Cmd.Cubic(x1, y1, x2, y2, x, y))
                        lastCtrlX = x2; lastCtrlY = y2; curX = x; curY = y
                    }
                    'S' -> {
                        val smooth = lastCmd == 'C' || lastCmd == 'S'
                        val rx = if (smooth) 2 * curX - (lastCtrlX ?: curX) else curX
                        val ry = if (smooth) 2 * curY - (lastCtrlY ?: curY) else curY
                        val x2 = if (rel) curX + num() else num(); val y2 = if (rel) curY + num() else num()
                        val x = if (rel) curX + num() else num(); val y = if (rel) curY + num() else num()
                        out.add(Cmd.Cubic(rx, ry, x2, y2, x, y))
                        lastCtrlX = x2; lastCtrlY = y2; curX = x; curY = y
                    }
                    'Q' -> {
                        val cx = if (rel) curX + num() else num(); val cy = if (rel) curY + num() else num()
                        val x = if (rel) curX + num() else num(); val y = if (rel) curY + num() else num()
                        out.add(Cmd.Quad(cx, cy, x, y))
                        lastCtrlX = cx; lastCtrlY = cy; curX = x; curY = y
                    }
                    'T' -> {
                        val smooth = lastCmd == 'Q' || lastCmd == 'T'
                        val cx = if (smooth) 2 * curX - (lastCtrlX ?: curX) else curX
                        val cy = if (smooth) 2 * curY - (lastCtrlY ?: curY) else curY
                        val x = if (rel) curX + num() else num(); val y = if (rel) curY + num() else num()
                        out.add(Cmd.Quad(cx, cy, x, y))
                        lastCtrlX = cx; lastCtrlY = cy; curX = x; curY = y
                    }
                    'Z' -> {
                        out.add(Cmd.Close); curX = startX; curY = startY
                        lastCtrlX = null; lastCtrlY = null
                    }
                    else -> i += 1
                }
                lastCmd = c
                // implicit repeated coordinate sets follow until the next command token
            } while (c != 'Z' && i < toks.size && toks[i].cmd == null)
        }
        return out
    }

    // ── the tiny XML scan (attributes only — SVG is flat enough for logos + loaders) ──
    private fun elements(s: String): List<Pair<String, String>>? {
        val out = ArrayList<Pair<String, String>>()
        var i = 0
        while (i < s.length) {
            if (s[i] != '<') { i += 1; continue }
            var j = i + 1
            val name = StringBuilder()
            while (j < s.length && (s[j].isLetter() || s[j].isDigit())) { name.append(s[j]); j += 1 }
            var k = j
            while (k < s.length && s[k] != '>') k += 1
            if (name.toString() in shapeTags) {
                if (out.size >= MediaInputPolicy.MAXIMUM_SVG_PRIMITIVES) return null
                out.add(name.toString() to s.substring(j, minOf(k, s.length)))
            }
            i = maxOf(k, i + 1)
        }
        return out
    }

    private fun firstTag(name: String, s: String): String? {
        val at = s.indexOf("<$name")
        if (at < 0) return null
        val rest = s.substring(at + name.length + 1)
        val end = rest.indexOf('>')
        return if (end < 0) null else rest.substring(0, end)
    }

    /// `key="value"` (or `key='value'`) within an attribute string.
    private fun attr(key: String, body: String): String? {
        for (q in listOf('"', '\'')) {
            val marker = "$key=$q"
            val at = body.indexOf(marker)
            if (at < 0) continue
            val rest = body.substring(at + marker.length)
            val end = rest.indexOf(q)
            if (end >= 0) return rest.substring(0, end)
        }
        return null
    }

    private fun numericPrefix(s: String): String {
        val out = StringBuilder()
        for (c in s.trim()) {
            if (c.isDigit() || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E') out.append(c)
            else break
        }
        return out.toString()
    }

    /// All numbers in a string (commas/whitespace/sign, the Swift scanner verbatim).
    fun numbers(s: String): List<Double> {
        val out = ArrayList<Double>()
        val cur = StringBuilder()
        fun flush() {
            if (cur.isNotEmpty()) cur.toString().toDoubleOrNull()?.takeIf(::validScalar)?.let {
                if (out.size <= MediaInputPolicy.MAXIMUM_SVG_PATH_TOKENS) out.add(it)
            }
            cur.setLength(0)
        }
        for (c in s) {
            when {
                c.isDigit() || c == '.' -> cur.append(c)
                c == '-' || c == '+' -> {
                    if (cur.isNotEmpty() && cur.last() != 'e' && cur.last() != 'E') flush()
                    cur.append(c)
                }
                c == 'e' || c == 'E' -> cur.append(c)
                else -> flush()
            }
        }
        flush()
        return if (out.size > MediaInputPolicy.MAXIMUM_SVG_PATH_TOKENS) emptyList() else out
    }

    private data class Tok(val cmd: Char?, val num: Double?)
    private fun tokenizePath(d: String): List<Tok> {
        val out = ArrayList<Tok>()
        val cur = StringBuilder()
        fun flush() {
            if (cur.isNotEmpty()) cur.toString().toDoubleOrNull()?.takeIf(::validScalar)?.let {
                if (out.size <= MediaInputPolicy.MAXIMUM_SVG_PATH_TOKENS) out.add(Tok(null, it))
            }
            cur.setLength(0)
        }
        for (c in d) {
            when {
                c.isLetter() && c != 'e' && c != 'E' -> {
                    flush()
                    if (out.size <= MediaInputPolicy.MAXIMUM_SVG_PATH_TOKENS) out.add(Tok(c, null))
                }
                c.isDigit() || c == '.' -> cur.append(c)
                c == '-' || c == '+' -> {
                    if (cur.isNotEmpty() && cur.last() != 'e' && cur.last() != 'E') flush()
                    cur.append(c)
                }
                c == 'e' || c == 'E' -> cur.append(c)
                else -> flush()
            }
        }
        flush()
        return if (out.size > MediaInputPolicy.MAXIMUM_SVG_PATH_TOKENS) emptyList() else out
    }

    private fun validScalar(value: Double): Boolean = value.isFinite() && kotlin.math.abs(value) <= 1_000_000_000.0

    /// hex (#rgb / #rrggbb / #rrggbbaa) or a few named colors — the SVG.swift grammar
    /// (unknown → black, SVG's default paint; NOT the StackStyle white fallback).
    fun color(raw: String): Color {
        val s = raw.trim().lowercase()
        when (s) {
            "white" -> return Color.White
            "black" -> return Color.Black
            "none", "transparent" -> return Color.Transparent
        }
        if (!s.startsWith("#")) return Color.Black
        var hex = s.drop(1)
        if (hex.length == 3) hex = hex.map { "$it$it" }.joinToString("")
        if (hex.length != 6 && hex.length != 8) return Color.Black
        val v = hex.toLongOrNull(16) ?: return Color.Black
        return if (hex.length == 8) {
            Color(red = ((v shr 24) and 0xFF).toFloat() / 255f,
                  green = ((v shr 16) and 0xFF).toFloat() / 255f,
                  blue = ((v shr 8) and 0xFF).toFloat() / 255f,
                  alpha = (v and 0xFF).toFloat() / 255f)          // SVG #rrggbbaa — alpha LAST
        } else {
            Color(red = ((v shr 16) and 0xFF).toFloat() / 255f,
                  green = ((v shr 8) and 0xFF).toFloat() / 255f,
                  blue = (v and 0xFF).toFloat() / 255f)
        }
    }
}
