package despia.engine.desktop

import java.util.Base64
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DesktopMediaRendererTest {
    @Test
    fun mediaSourcePolicyIsTlsFirstLoopbackOnlyAndDiagnosticSafe() {
        val accepted = desktopMediaSourceStatus("https://cdn.example.com/private/cover.png?token=secret#fragment")
        assertTrue(accepted.allowed)
        assertEquals("cdn.example.com", accepted.host)
        assertFalse(accepted.toString().contains("secret"))
        assertTrue(desktopMediaSourceStatus("http://127.0.0.1:8080/image.png").allowed)
        assertFalse(desktopMediaSourceStatus("http://example.com/image.png").allowed)
        assertFalse(desktopMediaSourceStatus("https://user:secret@example.com/image.png").allowed)
        assertEquals("source_missing", desktopMediaSourceStatus(null).reason)
    }

    @Test
    fun bundledAssetNamesCannotEscapeTheApplicationResources() {
        assertEquals("images/logo.png", normalizedDesktopAssetName("/images/logo.png"))
        assertNull(normalizedDesktopAssetName("../private.key"))
        assertNull(normalizedDesktopAssetName("images/../private.key"))
        assertNull(normalizedDesktopAssetName("images\\logo.png"))
        assertNull(normalizedDesktopAssetName("images//logo.png"))
        assertEquals(
            "/dsx/app-assets/images/logo.png",
            desktopBundledAssetCandidates("images/logo.png").first(),
        )
        assertTrue("/dsx/app-assets/images/logo.png" in desktopBundledAssetCandidates("images/logo.png"))
    }

    @Test
    fun svgPolicyAllowsStaticNativeMarkupAndRejectsActiveOrExternalContent() {
        assertTrue(isSafeDesktopSvg("<svg viewBox='0 0 10 10'><circle cx='5' cy='5' r='4'/></svg>"))
        assertFalse(isSafeDesktopSvg("<!DOCTYPE svg><svg/>"))
        assertFalse(isSafeDesktopSvg("<svg><script>alert(1)</script></svg>"))
        assertFalse(isSafeDesktopSvg("<svg><image href='https://example.com/a.png'/></svg>"))
        assertFalse(isSafeDesktopSvg("<svg><image\nhref='https://example.com/a.png'/></svg>"))
        assertFalse(isSafeDesktopSvg("<svg><use\nxlink:href='#remote'/></svg>"))
        assertFalse(isSafeDesktopSvg("<svg><rect style='fill:url(https://example.com/a.png)'/></svg>"))
        assertFalse(isSafeDesktopSvg("<svg onload='alert(1)'/>"))
        assertFalse(isSafeDesktopSvg("<svg><style>@import 'https://example.com/a.css';</style></svg>"))
        val generated = resolveDesktopSvgMarkup(mapOf("d" to "M0 0 L10 10", "fill" to "#ff0000"))
        assertNotNull(generated)
        assertTrue(generated.contains("<path"))
        assertTrue(isSafeDesktopSvg(generated))
    }

    @Test
    fun qrEncoderProducesBoundedStandardsShapedMatricesForEveryCorrectionLevel() {
        for (correction in listOf("L", "M", "Q", "H")) {
            val matrix = assertNotNull(DesktopQrEncoder.encode("DSX desktop production", correction))
            assertTrue(matrix.size in 21..177)
            assertEquals(0, (matrix.size - 17) % 4)
            assertTrue(matrix.all { it.size == matrix.size })
            assertFinder(matrix, 0, 0)
            assertFinder(matrix, matrix.size - 7, 0)
            assertFinder(matrix, 0, matrix.size - 7)
        }
        assertNull(DesktopQrEncoder.encode(""))
        assertNull(DesktopQrEncoder.encode("x".repeat(10_000), "H"))
    }

    @Test
    fun qrCanvasAlwaysReservesTheFourModuleQuietZone() {
        for (modules in listOf(21, 57, 177)) {
            val geometry = desktopQrGeometry(side = 317f, moduleCount = modules)
            assertEquals(DESKTOP_QR_QUIET_ZONE_MODULES.toFloat(), geometry.quiet / geometry.cell, 0.0001f)
            assertEquals(317f, geometry.totalSpan, 0.001f)
            assertEquals(
                (modules + DESKTOP_QR_QUIET_ZONE_MODULES * 2).toFloat(),
                geometry.totalSpan / geometry.cell,
                0.001f,
            )
        }
    }

    @Test
    fun chartModelRejectsNonNumericRowsAndKeepsStableSeriesOrder() {
        val raw = listOf(
            mapOf("month" to "Jan", "amount" to 2, "team" to "A"),
            mapOf("month" to "Feb", "amount" to "bad", "team" to "A"),
            mapOf("month" to "Jan", "amount" to 5.5, "team" to "B"),
        )
        val result = desktopChartSeries(raw, mapOf("x" to "month", "y" to "amount", "series" to "team"))
        assertEquals(listOf("A", "B"), result.map { it.name })
        assertEquals(listOf(2.0), result[0].points.map { it.y })
        assertEquals("Jan", result[1].points.single().x)
    }

    @Test
    fun mapModelBoundsCoordinatesAndDropsMalformedPins() {
        val model = desktopMapModel(
            mapOf("lat" to "95", "lon" to "-250", "zoom" to "99"),
            listOf(
                mapOf("lat" to 25.2, "lng" to 55.3, "title" to "Dubai"),
                mapOf("lat" to "not-a-number", "lng" to 1),
            ),
        )
        assertEquals(85.0, model.latitude)
        assertEquals(-180.0, model.longitude)
        assertEquals(22.0, model.zoom)
        assertEquals(listOf("Dubai"), model.pins.map { it.title })
    }

    @Test
    fun boundedSkiaRasterDecodeAcceptsARealPngAndRejectsGarbage() {
        val png = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        )
        val decoded = assertNotNull(decodeDesktopRaster(png, "image/png"))
        assertEquals(1, decoded.width)
        assertEquals(1, decoded.height)
        assertNull(decodeDesktopRaster("not-an-image".toByteArray(), "image/png"))
    }

    private fun assertFinder(matrix: Array<BooleanArray>, left: Int, top: Int) {
        for (y in 0 until 7) for (x in 0 until 7) {
            val expected = x == 0 || x == 6 || y == 0 || y == 6 || x in 2..4 && y in 2..4
            assertEquals(expected, matrix[top + y][left + x], "finder module $x,$y")
        }
    }
}
