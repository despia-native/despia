package despia.engine

import java.io.File
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test

/**
 * The dataviz conformance runner - executes OpenSource/Conformance/dataviz/ (all SIX files:
 * scales, marks, interaction, a11y, camera, cluster) through THIS runtime's Dataviz core
 * (parity/U09-dataviz.md). The TS twin (@despia/kernel dataviz.ts,
 * dataviz-conformance.test.ts) and the Swift reference (DatavizConformance, the record lane)
 * run the SAME files, so a chart cannot put a datum in one place on one renderer and
 * somewhere else on another, five hundred pins cannot group two ways at the same zoom, and
 * the accessible table cannot say something the picture does not.
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
 */
class DatavizConformanceTest {

    private val tolerance = 1e-9

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/dataviz")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/dataviz not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpus(file: String): Map<String, Any?> {
        val root = json(File(corpusDir(), file).readText()).foundationValue as? Map<String, Any?>
            ?: error("$file: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$file: version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(doc: Map<String, Any?>, file: String, key: String): List<Map<String, Any?>> {
        val rows = doc[key] as? List<Map<String, Any?>> ?: error("$file: no $key[]")
        assertTrue(rows.isNotEmpty(), "$file: $key[] must not be empty")
        return rows
    }

    private fun num(v: Any?): Double = (v as Number).toDouble()

    private fun int(v: Any?): Int = (v as Number).toInt()

    private fun str(v: Any?): String = v as String

    @Suppress("UNCHECKED_CAST")
    private fun nums(v: Any?): List<Double> = (v as List<Any?>).map { num(it) }

    @Suppress("UNCHECKED_CAST")
    private fun obj(v: Any?): Map<String, Any?> = v as Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    private fun objs(v: Any?): List<Map<String, Any?>> = v as List<Map<String, Any?>>

    private fun close(actual: Double, expected: Double, label: String) {
        assertTrue(
            actual.isFinite() && abs(actual - expected) <= tolerance,
            "$label: $actual != $expected",
        )
    }

    private fun closeList(actual: List<Double>, expected: List<Double>, label: String) {
        assertEquals(expected.size, actual.size, "$label: length ($actual)")
        for (i in expected.indices) close(actual[i], expected[i], "$label[$i]")
    }

    // -- scales.json ---------------------------------------------------------------------

    @Test
    fun decimalExponentAgreesWithCorpus() {
        val doc = corpus("scales.json")
        for (c in section(doc, "scales.json", "decExp")) {
            assertEquals(
                int(c["expect"]),
                Dataviz.decimalExponent(num(c["x"])),
                "decExp/${str(c["name"])}",
            )
        }
    }

    @Test
    fun powerOfTenAgreesWithCorpus() {
        val doc = corpus("scales.json")
        for (c in section(doc, "scales.json", "pow10")) {
            close(Dataviz.powerOfTen(int(c["n"])), num(c["expect"]), "pow10/${str(c["name"])}")
        }
    }

    @Test
    fun niceNumberAgreesWithCorpus() {
        val doc = corpus("scales.json")
        for (c in section(doc, "scales.json", "niceNum")) {
            close(
                Dataviz.niceNumber(num(c["x"]), c["round"] as Boolean),
                num(c["expect"]),
                "niceNum/${str(c["name"])}",
            )
        }
    }

    private fun assertDomain(got: Dataviz.NiceDomain, expect: Map<String, Any?>, at: String) {
        close(got.lo, num(expect["lo"]), "$at: lo")
        close(got.hi, num(expect["hi"]), "$at: hi")
        close(got.step, num(expect["step"]), "$at: step")
        closeList(got.ticks, nums(expect["ticks"]), "$at: ticks")
    }

    @Test
    fun niceLinearDomainAgreesWithCorpus() {
        val doc = corpus("scales.json")
        for (c in section(doc, "scales.json", "niceDomain")) {
            val got = Dataviz.niceLinearDomain(num(c["lo"]), num(c["hi"]), int(c["count"]))
            assertDomain(got, obj(c["expect"]), "niceDomain/${str(c["name"])}")
        }
    }

    @Test
    fun valueDomainAgreesWithCorpus() {
        val doc = corpus("scales.json")
        for (c in section(doc, "scales.json", "valueDomain")) {
            val got = Dataviz.valueDomain(
                nums(c["values"]),
                c["includeZero"] as Boolean,
                int(c["count"]),
            )
            assertDomain(got, obj(c["expect"]), "valueDomain/${str(c["name"])}")
        }
    }

    @Test
    fun linearScaleAgreesWithCorpus() {
        val doc = corpus("scales.json")
        for (c in section(doc, "scales.json", "linear")) {
            close(
                Dataviz.linearScale(num(c["v"]), nums(c["domain"]), nums(c["range"])),
                num(c["expect"]),
                "linear/${str(c["name"])}",
            )
        }
    }

    @Test
    fun bandScaleAgreesWithCorpus() {
        val doc = corpus("scales.json")
        for (c in section(doc, "scales.json", "band")) {
            val got = Dataviz.bandScale(
                int(c["count"]),
                nums(c["range"]),
                num(c["paddingInner"]),
                num(c["paddingOuter"]),
                num(c["align"]),
            )
            val expect = obj(c["expect"])
            val at = "band/${str(c["name"])}"
            close(got.step, num(expect["step"]), "$at: step")
            close(got.bandwidth, num(expect["bandwidth"]), "$at: bandwidth")
            close(got.start, num(expect["start"]), "$at: start")
            closeList(got.positions, nums(expect["positions"]), "$at: positions")
            closeList(got.centers, nums(expect["centers"]), "$at: centers")
        }
    }

    @Test
    fun logDomainRefusesANonPositiveDomain() {
        val doc = corpus("scales.json")
        for (c in section(doc, "scales.json", "log")) {
            val got = Dataviz.logDomain(num(c["lo"]), num(c["hi"]), int(c["maxTicks"]))
            val expect = obj(c["expect"])
            val at = "log/${str(c["name"])}"
            assertEquals(expect["valid"] as Boolean, got.valid, "$at: valid")
            assertEquals(str(expect["reason"]), got.reason, "$at: reason")
            close(got.lo, num(expect["lo"]), "$at: lo")
            close(got.hi, num(expect["hi"]), "$at: hi")
            closeList(got.ticks, nums(expect["ticks"]), "$at: ticks")
        }
    }

    @Test
    fun logScaleAgreesWithCorpus() {
        val doc = corpus("scales.json")
        for (c in section(doc, "scales.json", "logScale")) {
            close(
                Dataviz.logScale(num(c["v"]), nums(c["domain"]), nums(c["range"])),
                num(c["expect"]),
                "logScale/${str(c["name"])}",
            )
        }
    }

    @Test
    fun timeTicksAgreeWithCorpus() {
        val doc = corpus("scales.json")
        for (c in section(doc, "scales.json", "time")) {
            val got = Dataviz.timeTicks(num(c["lo"]), num(c["hi"]), int(c["count"]))
            val expect = obj(c["expect"])
            val at = "time/${str(c["name"])}"
            close(got.step, num(expect["step"]), "$at: step")
            closeList(got.ticks, nums(expect["ticks"]), "$at: ticks")
        }
    }

    // -- marks.json ----------------------------------------------------------------------

    @Test
    fun pieGeometryAgreesWithCorpus() {
        val doc = corpus("marks.json")
        for (c in section(doc, "marks.json", "pie")) {
            val got = Dataviz.pieSlices(
                nums(c["values"]),
                num(c["outerRadius"]),
                num(c["innerRadius"]),
                num(c["startAngle"]),
                num(c["padAngle"]),
                c["clockwise"] as Boolean,
            )
            val expect = obj(c["expect"])
            val at = "pie/${str(c["name"])}"
            close(got.total, num(expect["total"]), "$at: total")
            assertEquals(expect["empty"] as Boolean, got.empty, "$at: empty")
            close(got.innerRadius, num(expect["innerRadius"]), "$at: innerRadius")
            close(got.outerRadius, num(expect["outerRadius"]), "$at: outerRadius")
            val slices = objs(expect["slices"])
            assertEquals(slices.size, got.slices.size, "$at: slice count")
            for (i in slices.indices) {
                val a = got.slices[i]
                val e = slices[i]
                assertEquals(int(e["index"]), a.index, "$at[$i]: index")
                close(a.value, num(e["value"]), "$at[$i]: value")
                close(a.fraction, num(e["fraction"]), "$at[$i]: fraction")
                close(a.startAngle, num(e["startAngle"]), "$at[$i]: startAngle")
                close(a.endAngle, num(e["endAngle"]), "$at[$i]: endAngle")
                close(a.sweep, num(e["sweep"]), "$at[$i]: sweep")
                close(a.centroidX, num(e["centroidX"]), "$at[$i]: centroidX")
                close(a.centroidY, num(e["centroidY"]), "$at[$i]: centroidY")
                assertEquals(e["full"] as Boolean, a.full, "$at[$i]: full")
            }
        }
    }

    @Test
    fun bubbleRadiusInterpolatesArea() {
        val doc = corpus("marks.json")
        for (c in section(doc, "marks.json", "bubble")) {
            close(
                Dataviz.bubbleRadius(
                    num(c["v"]), num(c["min"]), num(c["max"]), num(c["rMin"]), num(c["rMax"]),
                ),
                num(c["expect"]),
                "bubble/${str(c["name"])}",
            )
        }
    }

    @Test
    fun radarPointsAgreeWithCorpus() {
        val doc = corpus("marks.json")
        for (c in section(doc, "marks.json", "radar")) {
            val center = nums(c["center"])
            val got = Dataviz.radarPoints(
                nums(c["values"]), num(c["max"]), num(c["radius"]), center[0], center[1],
            )
            val expect = objs(c["expect"])
            val at = "radar/${str(c["name"])}"
            assertEquals(expect.size, got.size, "$at: count")
            for (i in expect.indices) {
                val a = got[i]
                val e = expect[i]
                assertEquals(int(e["index"]), a.index, "$at[$i]: index")
                close(a.fraction, num(e["fraction"]), "$at[$i]: fraction")
                close(a.angle, num(e["angle"]), "$at[$i]: angle")
                close(a.x, num(e["x"]), "$at[$i]: x")
                close(a.y, num(e["y"]), "$at[$i]: y")
            }
        }
    }

    @Test
    fun funnelStagesAgreeWithCorpus() {
        val doc = corpus("marks.json")
        for (c in section(doc, "marks.json", "funnel")) {
            val got = Dataviz.funnelStages(
                nums(c["values"]), num(c["width"]), num(c["height"]), num(c["gap"]),
            )
            val expect = objs(c["expect"])
            val at = "funnel/${str(c["name"])}"
            assertEquals(expect.size, got.size, "$at: count")
            for (i in expect.indices) {
                val a = got[i]
                val e = expect[i]
                assertEquals(int(e["index"]), a.index, "$at[$i]: index")
                close(a.topWidth, num(e["topWidth"]), "$at[$i]: topWidth")
                close(a.bottomWidth, num(e["bottomWidth"]), "$at[$i]: bottomWidth")
                close(a.top, num(e["top"]), "$at[$i]: top")
                close(a.bottom, num(e["bottom"]), "$at[$i]: bottom")
                close(a.ofFirst, num(e["ofFirst"]), "$at[$i]: ofFirst")
                close(a.ofPrevious, num(e["ofPrevious"]), "$at[$i]: ofPrevious")
            }
        }
    }

    @Test
    fun candleBucketsSkipEmptyBuckets() {
        val doc = corpus("marks.json")
        for (c in section(doc, "marks.json", "candleBuckets")) {
            val points = objs(c["points"]).map { Dataviz.TimePoint(num(it["t"]), num(it["v"])) }
            val got = Dataviz.candleBuckets(points, num(c["interval"]), num(c["origin"]))
            val expect = objs(c["expect"])
            val at = "candleBuckets/${str(c["name"])}"
            assertEquals(expect.size, got.size, "$at: count")
            for (i in expect.indices) {
                val a = got[i]
                val e = expect[i]
                assertEquals(int(e["bucket"]).toLong(), a.bucket, "$at[$i]: bucket")
                close(a.start, num(e["start"]), "$at[$i]: start")
                close(a.open, num(e["open"]), "$at[$i]: open")
                close(a.high, num(e["high"]), "$at[$i]: high")
                close(a.low, num(e["low"]), "$at[$i]: low")
                close(a.close, num(e["close"]), "$at[$i]: close")
                assertEquals(int(e["count"]), a.count, "$at[$i]: count")
                assertEquals(str(e["direction"]), a.direction, "$at[$i]: direction")
            }
        }
    }

    @Test
    fun aDojiStillGetsAVisibleBody() {
        val doc = corpus("marks.json")
        for (c in section(doc, "marks.json", "candleGeometry")) {
            val ohlc = nums(c["ohlc"])
            val got = Dataviz.candleGeometry(
                ohlc[0], ohlc[1], ohlc[2], ohlc[3],
                nums(c["domain"]), nums(c["range"]), num(c["minBody"]),
            )
            val expect = obj(c["expect"])
            val at = "candleGeometry/${str(c["name"])}"
            close(got.bodyTop, num(expect["bodyTop"]), "$at: bodyTop")
            close(got.bodyBottom, num(expect["bodyBottom"]), "$at: bodyBottom")
            close(got.wickTop, num(expect["wickTop"]), "$at: wickTop")
            close(got.wickBottom, num(expect["wickBottom"]), "$at: wickBottom")
            assertEquals(str(expect["direction"]), got.direction, "$at: direction")
        }
    }

    @Test
    fun theLastHeatmapBinOwnsItsUpperEdge() {
        val doc = corpus("marks.json")
        for (c in section(doc, "marks.json", "heatmap")) {
            val points = objs(c["points"]).map {
                Dataviz.WeightedPoint(num(it["x"]), num(it["y"]), num(it["w"]))
            }
            val got = Dataviz.heatmapCells(
                points, int(c["xBins"]), int(c["yBins"]), nums(c["xDomain"]), nums(c["yDomain"]),
            )
            val expect = obj(c["expect"])
            val at = "heatmap/${str(c["name"])}"
            close(got.max, num(expect["max"]), "$at: max")
            val cells = objs(expect["cells"])
            assertEquals(cells.size, got.cells.size, "$at: cell count")
            for (i in cells.indices) {
                val a = got.cells[i]
                val e = cells[i]
                assertEquals(int(e["xBin"]), a.xBin, "$at[$i]: xBin")
                assertEquals(int(e["yBin"]), a.yBin, "$at[$i]: yBin")
                close(a.value, num(e["value"]), "$at[$i]: value")
                close(a.intensity, num(e["intensity"]), "$at[$i]: intensity")
            }
        }
    }

    // -- interaction.json ------------------------------------------------------------------

    @Test
    fun nearestIndexAgreesWithCorpus() {
        val doc = corpus("interaction.json")
        for (c in section(doc, "interaction.json", "nearestIndex")) {
            assertEquals(
                int(c["expect"]),
                Dataviz.nearestIndex(num(c["fraction"]), int(c["count"])),
                "nearestIndex/${str(c["name"])}",
            )
        }
    }

    @Test
    fun nearestValueIndexBreaksTiesLow() {
        val doc = corpus("interaction.json")
        for (c in section(doc, "interaction.json", "nearestValueIndex")) {
            assertEquals(
                int(c["expect"]),
                Dataviz.nearestValueIndex(num(c["value"]), nums(c["values"])),
                "nearestValueIndex/${str(c["name"])}",
            )
        }
    }

    @Test
    fun aTapClearsTheBrush() {
        val doc = corpus("interaction.json")
        for (c in section(doc, "interaction.json", "brush")) {
            val got = Dataviz.brushWindow(num(c["from"]), num(c["to"]), nums(c["domain"]))
            val expect = obj(c["expect"])
            val at = "brush/${str(c["name"])}"
            close(got.start, num(expect["start"]), "$at: start")
            close(got.end, num(expect["end"]), "$at: end")
            assertEquals(expect["cleared"] as Boolean, got.cleared, "$at: cleared")
        }
    }

    @Test
    fun zoomClampsToTheDataExtent() {
        val doc = corpus("interaction.json")
        for (c in section(doc, "interaction.json", "zoom")) {
            val got = Dataviz.zoomDomain(
                nums(c["domain"]), nums(c["full"]), num(c["factor"]), num(c["anchor"]),
            )
            val expect = obj(c["expect"])
            val at = "zoom/${str(c["name"])}"
            close(got.lo, num(expect["lo"]), "$at: lo")
            close(got.hi, num(expect["hi"]), "$at: hi")
        }
    }

    @Test
    fun panKeepsItsSpanAtBothEdges() {
        val doc = corpus("interaction.json")
        for (c in section(doc, "interaction.json", "pan")) {
            val got = Dataviz.panDomain(nums(c["domain"]), nums(c["full"]), num(c["delta"]))
            val expect = obj(c["expect"])
            val at = "pan/${str(c["name"])}"
            close(got.lo, num(expect["lo"]), "$at: lo")
            close(got.hi, num(expect["hi"]), "$at: hi")
        }
    }

    // -- a11y.json -------------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theAccessibleTablePivotsTheSeries() {
        val doc = corpus("a11y.json")
        for (c in section(doc, "a11y.json", "table")) {
            val got = Dataviz.accessibleTable(
                objs(c["rows"]),
                Dataviz.AccessibleTableSpec(
                    x = str(c["x"]),
                    y = str(c["y"]),
                    series = str(c["series"]),
                    type = str(c["type"]),
                    xTitle = str(c["xTitle"]),
                    yTitle = str(c["yTitle"]),
                ),
            )
            val expect = obj(c["expect"])
            val at = "a11y/${str(c["name"])}"
            assertEquals(str(expect["caption"]), got.caption, "$at: caption")
            assertEquals(
                (expect["columns"] as List<Any?>).map { str(it) },
                got.columns,
                "$at: columns",
            )
            assertEquals(
                (expect["rows"] as List<Any?>).map { row -> (row as List<Any?>).map { str(it) } },
                got.rows,
                "$at: rows",
            )
            assertEquals(str(expect["summary"]), got.summary, "$at: summary")
        }
    }

    // -- camera.json -----------------------------------------------------------------------

    @Test
    fun cameraDefaultsAgreeWithCorpus() {
        val defaults = obj(corpus("camera.json")["defaults"])
        close(Dataviz.MAP_TILE_SIZE, num(defaults["tileSize"]), "camera: tileSize")
        close(Dataviz.MAP_MIN_ZOOM, num(defaults["minZoom"]), "camera: minZoom")
        close(Dataviz.MAP_MAX_ZOOM, num(defaults["maxZoom"]), "camera: maxZoom")
        close(Dataviz.MAP_DEFAULT_ZOOM, num(defaults["defaultZoom"]), "camera: defaultZoom")
        close(
            Dataviz.MAP_MAX_MERCATOR_LATITUDE,
            num(defaults["maxMercatorLatitude"]),
            "camera: maxMercatorLatitude",
        )
    }

    @Test
    fun theProjectionAgreesWithCorpus() {
        val doc = corpus("camera.json")
        for (c in section(doc, "camera.json", "project")) {
            val at = "project/${str(c["name"])}"
            val lon = c["lon"]
            val expectX = c["expectWorldX"]
            if (lon != null && expectX != null) {
                close(Dataviz.mercatorX(num(lon)), num(expectX), "$at: worldX")
            }
            val lat = c["lat"]
            val expectY = c["expectWorldY"]
            if (lat != null && expectY != null) {
                close(Dataviz.mercatorY(num(lat)), num(expectY), "$at: worldY")
            }
        }
    }

    @Test
    fun theProjectionRoundTrips() {
        val doc = corpus("camera.json")
        for (c in section(doc, "camera.json", "roundTrip")) {
            val at = "roundTrip/${str(c["name"])}"
            close(
                Dataviz.latitudeAtWorldY(Dataviz.mercatorY(num(c["lat"]))),
                num(c["lat"]),
                "$at: lat",
            )
            close(
                Dataviz.longitudeAtWorldX(Dataviz.mercatorX(num(c["lon"]))),
                num(c["lon"]),
                "$at: lon",
            )
        }
    }

    @Test
    fun longitudeNormalisationWrapsWest() {
        val doc = corpus("camera.json")
        for (c in section(doc, "camera.json", "normalizeLon")) {
            close(
                Dataviz.normalizeLongitude(num(c["lon"])),
                num(c["expect"]),
                "normalizeLon/${str(c["name"])}",
            )
        }
    }

    @Test
    fun fitToTakesTheShortWayRound() {
        val doc = corpus("camera.json")
        for (c in section(doc, "camera.json", "fitTo")) {
            val coords = objs(c["coords"]).map { Dataviz.GeoPoint(num(it["lat"]), num(it["lon"])) }
            val padding = obj(c["padding"])
            val got = Dataviz.fitCamera(
                coords,
                num(c["width"]),
                num(c["height"]),
                Dataviz.EdgePadding(
                    top = num(padding["top"]),
                    right = num(padding["right"]),
                    bottom = num(padding["bottom"]),
                    left = num(padding["left"]),
                ),
            )
            val expect = obj(c["expect"])
            val at = "fitTo/${str(c["name"])}"
            assertEquals(expect["valid"] as Boolean, got.valid, "$at: valid")
            close(got.lat, num(expect["lat"]), "$at: lat")
            close(got.lon, num(expect["lon"]), "$at: lon")
            close(got.zoom, num(expect["zoom"]), "$at: zoom")
        }
    }

    @Test
    fun theRegionPayloadAgreesWithCorpus() {
        val doc = corpus("camera.json")
        for (c in section(doc, "camera.json", "region")) {
            val got = Dataviz.mapRegion(
                num(c["lat"]), num(c["lon"]), num(c["zoom"]), num(c["width"]), num(c["height"]),
            )
            val expect = obj(c["expect"])
            val at = "region/${str(c["name"])}"
            close(got.centerLat, num(expect["centerLat"]), "$at: centerLat")
            close(got.centerLon, num(expect["centerLon"]), "$at: centerLon")
            close(got.zoom, num(expect["zoom"]), "$at: zoom")
            close(got.latSpan, num(expect["latSpan"]), "$at: latSpan")
            close(got.lonSpan, num(expect["lonSpan"]), "$at: lonSpan")
        }
    }

    // -- cluster.json ----------------------------------------------------------------------

    private fun pins(raw: Any?): List<Dataviz.GeoPoint> =
        objs(raw).map { Dataviz.GeoPoint(num(it["lat"]), num(it["lon"])) }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun pinMembershipAgreesWithCorpus() {
        val doc = corpus("cluster.json")
        val maxZoom = int(obj(doc["defaults"])["maxZoom"])
        val membership = obj(doc["membership"])
        val pinSet = pins(membership["pins"])
        val cases = objs(membership["cases"])
        assertTrue(cases.isNotEmpty(), "cluster.json: membership.cases[] must not be empty")
        for (c in cases) {
            val got = Dataviz.clusterPins(pinSet, num(c["zoom"]), num(c["radius"]), maxZoom)
            val expect = objs(c["expect"])
            val at = "cluster/membership z=${num(c["zoom"])} r=${num(c["radius"])}"
            assertEquals(expect.size, got.size, "$at: node count")
            for (i in expect.indices) {
                val a = got[i]
                val e = expect[i]
                assertEquals(str(e["id"]), a.id, "$at[$i]: id")
                assertEquals(e["cluster"] as Boolean, a.cluster, "$at[$i]: cluster")
                close(a.lat, num(e["lat"]), "$at[$i]: lat")
                close(a.lon, num(e["lon"]), "$at[$i]: lon")
                assertEquals(int(e["count"]), a.count, "$at[$i]: count")
                assertEquals(
                    (e["members"] as List<Any?>).map { int(it) },
                    a.members,
                    "$at[$i]: members",
                )
                assertEquals(int(e["expansionZoom"]), a.expansionZoom, "$at[$i]: expansionZoom")
            }
        }
    }

    @Test
    fun membershipDoesNotFlickerInsideOneLevel() {
        val doc = corpus("cluster.json")
        val defaults = obj(doc["defaults"])
        val radius = num(defaults["clusterRadius"])
        val maxZoom = int(defaults["maxZoom"])
        val stability = obj(doc["stability"])
        val pinSet = pins(stability["pins"])
        val sweep = nums(stability["sameLevel"])
        assertTrue(sweep.size > 1, "cluster.json: stability.sameLevel needs a sweep")
        val reference = Dataviz.clusterPins(pinSet, sweep[0], radius, maxZoom).map { it.id }
        for (zoom in sweep) {
            val ids = Dataviz.clusterPins(pinSet, zoom, radius, maxZoom).map { it.id }
            assertEquals(reference, ids, "cluster/stability: zoom $zoom must not re-cluster")
        }
        val next = Dataviz.clusterPins(pinSet, num(stability["nextLevel"]), radius, maxZoom)
            .map { it.id }
        assertTrue(next != reference, "cluster/stability: the next level must re-cluster")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun fiveHundredPinsProduceTheSameDigest() {
        val doc = corpus("cluster.json")
        val maxZoom = int(obj(doc["defaults"])["maxZoom"])
        val scale = obj(doc["scale"])
        val pinSet = pins(scale["pins"])
        assertTrue(pinSet.size >= 500, "cluster.json: scale.pins must be the 500-pin lattice")
        for (c in objs(scale["cases"])) {
            val digest = Dataviz.clusterPins(pinSet, num(c["zoom"]), num(c["radius"]), maxZoom)
                .map { listOf(it.id, it.count.toString()) }
            val expect = (c["expect"] as List<Any?>).map { row ->
                val pair = row as List<Any?>
                listOf(str(pair[0]), int(pair[1]).toString())
            }
            assertEquals(expect, digest, "cluster/scale z=${num(c["zoom"])}: digest")
        }
    }
}
