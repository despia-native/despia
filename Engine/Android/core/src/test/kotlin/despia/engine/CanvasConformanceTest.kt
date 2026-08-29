package despia.engine

import java.io.File
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail
import org.junit.jupiter.api.Test

/**
 * The canvas conformance runner - executes
 * OpenSource/Conformance/canvas/{path,transform,gradient,fillrule,displaylist,frames,tier2,
 * a11y,ink}.json through THIS runtime (parity/U04-canvas.md). The TS twin is
 * packages/kernel/test/canvas-conformance.test.ts and the Swift reference is
 * Engine/iOS/CanvasCore.swift.
 *
 * The determinism split: PIXELS are toleranced and belong to the rasteriser, so nothing here
 * asserts one. GEOMETRY is exact everywhere and is asserted to 1e-6 - a path's segment list, a
 * transform's matrix, a display list's keys and diff, a tier-2 command stream. The SSR SVG is
 * asserted BYTE for byte, because a server-rendered frame that differs from the web one flashes
 * on hydration.
 *
 * Missing corpus = loud failure.
 */
class CanvasConformanceTest {

    private val tolerance = 1e-6

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/canvas/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/canvas/$name not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpus(name: String): Map<String, Any?> =
        json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun rows(file: String, key: String, minimum: Int): List<Map<String, Any?>> {
        val list = corpus(file)[key] as? List<Map<String, Any?>> ?: error("$file: no $key[]")
        assertTrue(list.size >= minimum, "$file.$key: corpus is suspiciously small (${list.size})")
        return list
    }

    private fun label(case: Map<String, Any?>): String = case["name"]?.toString() ?: "?"

    private fun diagnosticCount(value: Any?): Int = (value as? Number)?.toInt() ?: 0

    /** deep structural equality with a numeric tolerance - the corpus stores 6-decimal roundings
     *  of exact folds, so a bit-exact compare would fail on arithmetic that is right. Key sets
     *  are compared BOTH ways: an extra field is a drift too. */
    private fun like(actual: Any?, expected: Any?, where: String) {
        when (expected) {
            null -> assertNull(actual, "$where: expected null, got $actual")
            is Boolean -> assertEquals(expected, actual, where)
            is Number -> {
                val got = actual as? Number ?: fail("$where: expected a number, got $actual")
                assertTrue(
                    abs(got.toDouble() - expected.toDouble()) <= tolerance,
                    "$where: ${got.toDouble()} !~ ${expected.toDouble()}",
                )
            }
            is List<*> -> {
                val got = actual as? List<*> ?: fail("$where: expected a list, got $actual")
                assertEquals(expected.size, got.size, "$where: length")
                expected.forEachIndexed { i, value -> like(got[i], value, "$where[$i]") }
            }
            is Map<*, *> -> {
                val got = actual as? Map<*, *> ?: fail("$where: expected a map, got $actual")
                assertEquals(
                    expected.keys.map { it.toString() }.sorted(),
                    got.keys.map { it.toString() }.sorted(),
                    "$where: field set",
                )
                for ((key, value) in expected) like(got[key.toString()], value, "$where.$key")
            }
            else -> assertEquals(expected, actual, where)
        }
    }

    // -- corpus -> core inputs ---------------------------------------------------------------

    @Suppress("UNCHECKED_CAST")
    private fun markup(node: Map<String, Any?>): CanvasMarkupNode = CanvasMarkupNode(
        kind = node["kind"]?.toString() ?: "",
        attrs = (node["attrs"] as? Map<String, Any?>) ?: emptyMap(),
        children = ((node["children"] as? List<Map<String, Any?>>) ?: emptyList()).map { markup(it) },
    )

    @Suppress("UNCHECKED_CAST")
    private fun tree(case: Map<String, Any?>, key: String): List<CanvasMarkupNode> =
        ((case[key] as? List<Map<String, Any?>>) ?: emptyList()).map { markup(it) }

    private fun doubles(value: Any?): List<Double> =
        ((value as? List<*>) ?: emptyList<Any?>()).map { (it as Number).toDouble() }

    // -- core outputs -> the corpus shape -----------------------------------------------------

    private fun segments(list: List<CanvasSegment>?): List<Any>? = list?.map { it.toList() }

    private fun paint(value: CanvasPaint?): Any? = when (value) {
        null -> null
        is CanvasPaint.Rgba -> mapOf("kind" to "rgba", "rgba" to value.toList())
        is CanvasPaint.Token -> mapOf("kind" to "token", "token" to value.token)
        is CanvasPaint.Gradient -> mapOf("kind" to "gradient", "id" to value.id)
    }

    private fun effect(value: CanvasEffect): Map<String, Any?> = when (value) {
        is CanvasEffect.Blur -> mapOf("kind" to "blur", "radius" to value.radius)
        is CanvasEffect.Blend -> mapOf("kind" to "blend", "mode" to value.mode)
        is CanvasEffect.Shadow -> mapOf(
            "kind" to "shadow", "dx" to value.dx, "dy" to value.dy,
            "radius" to value.radius, "color" to paint(value.color),
        )
    }

    private fun opMap(op: CanvasOp): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out["key"] = op.key
        out["kind"] = op.kind
        out["transform"] = op.transform.toList()
        out["opacity"] = op.opacity
        when (op.kind) {
            "text" -> {
                out["text"] = op.text
                out["x"] = op.x
                out["y"] = op.y
                out["fontSize"] = op.fontSize
                out["textAnchor"] = op.textAnchor
                out["fill"] = paint(op.fill)
            }
            "image" -> {
                out["src"] = op.src
                out["x"] = op.x
                out["y"] = op.y
                out["width"] = op.width
                out["height"] = op.height
            }
            else -> {
                out["path"] = segments(op.path)
                out["fill"] = paint(op.fill)
                out["stroke"] = paint(op.stroke)
                out["strokeWidth"] = op.strokeWidth
                out["fillRule"] = op.fillRule
                out["strokeLinecap"] = op.strokeLinecap
                out["strokeLinejoin"] = op.strokeLinejoin
            }
        }
        op.clip?.let {
            out["clip"] = mapOf("path" to segments(it.path), "transform" to it.transform.toList())
        }
        if (op.effects.isNotEmpty()) out["effects"] = op.effects.map { effect(it) }
        return out
    }

    private fun stopMap(stop: CanvasStop): Map<String, Any?> {
        val rgba = stop.rgba
        return if (rgba != null) mapOf("offset" to stop.offset, "rgba" to rgba.toList())
        else mapOf("offset" to stop.offset, "token" to stop.token, "opacity" to stop.opacity)
    }

    private fun diffMap(entry: CanvasDiffEntry): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out["op"] = entry.op
        out["key"] = entry.key
        if (entry.op == "move") out["from"] = entry.from
        if (entry.op != "remove") out["to"] = entry.to
        return out
    }

    private fun drawMap(entry: CanvasDrawEntry): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out["alpha"] = entry.alpha
        out["ctm"] = entry.ctm.toList()
        entry.clip?.let { out["clip"] = mapOf("path" to segments(it.path), "rule" to it.rule) }
        entry.shadow?.let {
            out["shadow"] = mapOf(
                "dx" to it.dx, "dy" to it.dy, "radius" to it.radius, "color" to paint(it.color),
            )
        }
        entry.blend?.let { out["blend"] = it }
        out["op"] = entry.op
        when (entry.op) {
            "fill" -> {
                out["path"] = segments(entry.path)
                out["style"] = paint(entry.style)
                out["rule"] = entry.rule
            }
            "stroke" -> {
                out["path"] = segments(entry.path)
                out["style"] = paint(entry.style)
                out["lineWidth"] = entry.lineWidth
                out["cap"] = entry.cap
                out["join"] = entry.join
            }
            "clear" -> out["rect"] = entry.rect?.toList()
            "drawImage" -> {
                out["src"] = entry.src
                out["x"] = entry.x
                out["y"] = entry.y
                out["width"] = entry.width
                out["height"] = entry.height
            }
            else -> {
                out["text"] = entry.text
                out["x"] = entry.x
                out["y"] = entry.y
                out["style"] = paint(entry.style)
                out["fontSize"] = entry.fontSize
                if (entry.op == "strokeText") out["lineWidth"] = entry.lineWidth
            }
        }
        return out
    }

    // -- path.json ---------------------------------------------------------------------------

    @Test
    fun pathParsingAgreesWithCorpus() {
        for (case in rows("path.json", "cases", 25)) {
            val name = label(case)
            val parsed = parseCanvasPath(case["d"]?.toString())
            like(segments(parsed.segments), case["segments"], "$name.segments")
            like(canvasPathBBox(parsed.segments)?.toList(), case["bbox"], "$name.bbox")
            assertEquals(
                diagnosticCount(case["diagnostics"]), parsed.diagnostics.size,
                "$name diagnostics: ${parsed.diagnostics}",
            )
        }
    }

    // -- transform.json ----------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun transformParsingAgreesWithCorpus() {
        for (case in rows("transform.json", "parse", 15)) {
            val name = label(case)
            val parsed = parseCanvasTransform(case["transform"]?.toString())
            like(parsed.matrix.toList(), case["matrix"], "$name.matrix")
            for (point in (case["points"] as? List<Map<String, Any?>> ?: emptyList())) {
                val input = doubles(point["in"])
                like(
                    canvasApply(parsed.matrix, input[0], input[1]).toList(),
                    point["out"], "$name.point$input",
                )
            }
            assertEquals(
                diagnosticCount(case["diagnostics"]), parsed.diagnostics.size,
                "$name diagnostics: ${parsed.diagnostics}",
            )
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun transformCompositionAgreesWithCorpus() {
        for (case in rows("transform.json", "compose", 3)) {
            val name = label(case)
            val list = buildCanvasDisplayList(tree(case, "tree"))
            for (want in (case["nodes"] as List<Map<String, Any?>>)) {
                val key = want["key"].toString()
                val op = list.ops.firstOrNull { it.key == key }
                    ?: fail("$name: no op keyed $key (got ${list.ops.map { it.key }})")
                like(op.transform.toList(), want["transform"], "$name.$key.transform")
                for (point in (want["points"] as? List<Map<String, Any?>> ?: emptyList())) {
                    val input = doubles(point["in"])
                    like(
                        canvasApply(op.transform, input[0], input[1]).toList(),
                        point["out"], "$name.$key.point$input",
                    )
                }
            }
        }
    }

    // -- fillrule.json -----------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun fillRulesAgreeWithCorpus() {
        for (case in rows("fillrule.json", "cases", 5)) {
            val name = label(case)
            val path = parseCanvasPath(case["d"]?.toString()).segments
            like(canvasPathArea(path), case["area"], "$name.area")
            for (point in (case["points"] as List<Map<String, Any?>>)) {
                val at = doubles(point["at"])
                like(canvasWindingAt(path, at[0], at[1]), point["winding"], "$name.at$at.winding")
                assertEquals(
                    point["nonzero"], canvasContains(path, at[0], at[1], "nonzero"),
                    "$name.at$at.nonzero",
                )
                assertEquals(
                    point["evenodd"], canvasContains(path, at[0], at[1], "evenodd"),
                    "$name.at$at.evenodd",
                )
            }
        }
    }

    // -- gradient.json -----------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun gradientStopsAgreeWithCorpus() {
        for (case in rows("gradient.json", "cases", 12)) {
            val name = label(case)
            val inputs = (case["stops"] as List<Map<String, Any?>>).map {
                CanvasStopInput(it["offset"], it["color"]?.toString(), it["opacity"])
            }
            val parsed = normalizeCanvasStops(inputs)
            like(parsed.stops.map { stopMap(it) }, case["normalized"], "$name.normalized")
            assertEquals(
                diagnosticCount(case["diagnostics"]), parsed.diagnostics.size,
                "$name diagnostics: ${parsed.diagnostics}",
            )
            for (sample in (case["samples"] as? List<Map<String, Any?>> ?: emptyList())) {
                val t = (sample["t"] as Number).toDouble()
                like(sampleCanvasStops(parsed.stops, t)?.toList(), sample["rgba"], "$name.sample($t)")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun gradientProjectionAgreesWithCorpus() {
        for (case in rows("gradient.json", "projection", 6)) {
            val name = label(case)
            val kind = case["kind"].toString()
            val geom = doubles(case["geom"])
            for (point in (case["points"] as List<Map<String, Any?>>)) {
                val at = doubles(point["at"])
                like(canvasGradientT(kind, geom, at[0], at[1]), point["t"], "$name.at$at")
            }
        }
    }

    // -- displaylist.json --------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun displayListAgreesWithCorpus() {
        for (case in rows("displaylist.json", "cases", 9)) {
            val name = label(case)
            val list = buildCanvasDisplayList(tree(case, "tree"))
            like(list.ops.map { opMap(it) }, case["ops"], "$name.ops")
            assertEquals(
                diagnosticCount(case["diagnostics"]), list.diagnostics.size,
                "$name diagnostics: ${list.diagnostics}",
            )
            val gradients = case["gradients"] as? Map<String, Any?>
            if (gradients != null) {
                val got = list.gradients.mapValues { (_, g) ->
                    mapOf("kind" to g.kind, "geom" to g.geom, "stops" to g.stops.map { stopMap(it) })
                }
                like(got, gradients, "$name.gradients")
            }
            val canvas = case["canvas"] as Map<String, Any?>
            assertEquals(
                case["svg"],
                canvasToSvg(
                    list,
                    (canvas["width"] as Number).toDouble(),
                    (canvas["height"] as Number).toDouble(),
                ),
                "$name.svg",
            )
        }
    }

    @Test
    fun displayListDiffAgreesWithCorpus() {
        for (case in rows("displaylist.json", "diff", 9)) {
            val name = label(case)
            val before = buildCanvasDisplayList(tree(case, "before")).ops
            val after = buildCanvasDisplayList(tree(case, "after")).ops
            assertEquals(case["beforeKeys"], before.map { it.key }, "$name.beforeKeys")
            assertEquals(case["afterKeys"], after.map { it.key }, "$name.afterKeys")
            like(diffCanvasDisplayList(before, after).map { diffMap(it) }, case["diff"], "$name.diff")
        }
    }

    // -- frames.json -------------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun frameScheduleAgreesWithCorpus() {
        for (case in rows("frames.json", "cases", 7)) {
            val name = label(case)
            val fold = canvasFrameSchedule(
                case["bound"] == true,
                case["events"] as List<Map<String, Any?>>,
            )
            like(
                fold.emitted.map {
                    mapOf("time" to it.time, "delta" to it.delta, "frame" to it.frame)
                },
                case["emitted"], "$name.emitted",
            )
            assertEquals((case["installs"] as Number).toInt(), fold.installs, "$name.installs")
            assertEquals((case["uninstalls"] as Number).toInt(), fold.uninstalls, "$name.uninstalls")
            assertEquals(case["installed"], fold.installed, "$name.installed")
        }
    }

    // -- tier2.json --------------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun commandStreamAgreesWithCorpus() {
        for (case in rows("tier2.json", "cases", 20)) {
            val name = label(case)
            val result = runCanvasScript(case["script"] as List<List<Any?>>)
            like(result.log.map { drawMap(it) }, case["log"], "$name.log")
            like(
                result.measurements.map {
                    mapOf(
                        "text" to it.text, "width" to it.width,
                        "ascent" to it.ascent, "descent" to it.descent,
                    )
                },
                case["measurements"] ?: emptyList<Any?>(), "$name.measurements",
            )
            assertEquals(
                diagnosticCount(case["diagnostics"]), result.diagnostics.size,
                "$name diagnostics: ${result.diagnostics}",
            )
        }
    }

    // -- a11y.json ---------------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun accessibilityVerdictAgreesWithCorpus() {
        for (case in rows("a11y.json", "cases", 9)) {
            val name = label(case)
            val verdict = canvasA11y(
                case["attrs"] as Map<String, Any?>,
                case["a11yChildren"] as? List<Map<String, Any?>>,
            )
            val got = mapOf(
                "interactive" to verdict.interactive,
                "label" to verdict.label,
                "children" to verdict.children.map {
                    mapOf("role" to it.role, "label" to it.label, "value" to it.value)
                },
                "role" to verdict.role,
                "hidden" to verdict.hidden,
                "lint" to verdict.lint?.let {
                    mapOf("code" to it.code, "level" to it.level, "message" to it.message)
                },
            )
            like(got, case["verdict"], "$name.verdict")
        }
    }

    // ── ink.json ─────────────────────────────────────────────────────────────────────
    //
    // `<ink>` is the canvas's pointer-capture primitive: the committed drawing is ordinary
    // tier 1 (`nodes`), and only the in-flight stroke is transient native paint. What is
    // asserted here is everything a renderer must NOT decide for itself.

    private fun point(row: Any?): InkCore.Point {
        val pair = row as? List<*> ?: error("expected an [x, y] pair, got $row")
        return InkCore.Point(JSE.number(pair[0])!!, JSE.number(pair[1])!!)
    }

    private fun box(row: Any?): Pair<Double, Double> {
        val pair = row as? List<*> ?: error("expected a [w, h] pair, got $row")
        return Pair(JSE.number(pair[0])!!, JSE.number(pair[1])!!)
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun inkCaptureFoldsAgreeWithCorpus() {
        val constants = corpus("ink.json")["constants"] as Map<String, Any?>
        assertEquals(JSE.number(constants["strokeWidth"]), InkCore.STROKE_WIDTH)
        assertEquals(JSE.number(constants["minPointDistance"]), InkCore.MIN_POINT_DISTANCE)
        assertEquals(JSE.number(constants["coordinateScale"]), InkCore.COORDINATE_SCALE)
        assertEquals(constants["linecap"], InkCore.LINECAP)
        assertEquals(constants["linejoin"], InkCore.LINEJOIN)

        for (case in rows("ink.json", "capture", 5)) {
            val (w, h) = box(case["box"])
            val p = point(case["point"])
            val got = InkCore.point(p.x, p.y, w, h)
            like(listOf(got.x, got.y), case["out"], "${label(case)}.point")
        }
        for (case in rows("ink.json", "coalesce", 4)) {
            val (w, h) = box(case["box"])
            assertEquals(case["keep"], InkCore.farEnough(point(case["last"]), point(case["next"]), w, h),
                         "${label(case)}.keep")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun inkValueAndCurveAgreeWithCorpus() {
        for (case in rows("ink.json", "decode", 5)) {
            val got = InkCore.decode(JSE.asRows(case["value"])).map { stroke ->
                mapOf("points" to stroke.points.map { listOf(it.x, it.y) }, "width" to stroke.width)
            }
            like(got, case["out"], "${label(case)}.decode")
        }
        for (case in rows("ink.json", "ops", 5)) {
            val (w, h) = box(case["box"])
            val points = (case["points"] as List<Any?>).map { point(it) }
            val got = InkCore.ops(points, w, h).map { op ->
                when (op.verb) {
                    InkCore.Verb.QUAD -> listOf("Q", op.cx, op.cy, op.x, op.y)
                    InkCore.Verb.MOVE -> listOf("M", op.x, op.y)
                    InkCore.Verb.LINE -> listOf("L", op.x, op.y)
                }
            }
            like(got, case["ops"], "${label(case)}.ops")
            assertEquals(case["d"], InkCore.pathData(points, w, h), "${label(case)}.d")
        }
        for (case in rows("ink.json", "nodes", 3)) {
            val (w, h) = box(case["box"])
            val strokes = InkCore.decode(JSE.asRows(case["strokes"]))
            val got = InkCore.nodes(strokes, w, h, case["stroke"].toString()).map { node ->
                mapOf("kind" to node.kind, "attrs" to node.attrs)
            }
            like(got, case["nodes"], "${label(case)}.nodes")
        }
    }
}
