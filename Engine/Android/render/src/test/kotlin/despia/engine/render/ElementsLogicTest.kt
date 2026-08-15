//
//  ElementsLogicTest.kt — plain-JVM units for the INPUT/DISPLAY element wave's pure halves
//  (elements/*.kt): ElementMath (CSV grammar, star fractions, OTP clamp, segmented toggle,
//  range snap), CalendarMath (wire dates, month grid math, weekday rotation), SvgModel
//  (viewBox, shapes, the path `d` grammar, the SVG color grammar), and the ZXing-backed
//  QR matrix (pure Java — encodable on a bare JVM). The composables themselves are gated
//  by compilation (RenderSmokeInputs.kt — the RenderSmoke rule).
//

package despia.engine.render

import despia.engine.render.elements.CalendarMath
import despia.engine.render.elements.ElementMath
import despia.engine.render.elements.MediaInputPolicy
import despia.engine.render.elements.SvgModel
import despia.engine.render.elements.isDsxSemanticSvgColor
import despia.engine.render.elements.qrMatrix
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

class ElementsLogicTest {

    // ── ElementMath ────────────────────────────────────────────────────────────────────

    @Test fun csvTrimsAndDropsBlanks() {
        assertEquals(listOf("Day", "Week", "Month"), ElementMath.csv(" Day, Week ,Month"))
        assertEquals(emptyList<String>(), ElementMath.csv(""))
        assertEquals(listOf("a", "b"), ElementMath.csv("a,,b"))
    }

    @Test fun starFractionClamps() {
        // clamp(value - index, 0, 1) — Stars.swift.
        assertEquals(1f, ElementMath.starFraction(3.5, 2), 1e-6f)
        assertEquals(0.5f, ElementMath.starFraction(3.5, 3), 1e-6f)
        assertEquals(0f, ElementMath.starFraction(3.5, 4), 1e-6f)
        assertEquals(0f, ElementMath.starFraction(-1.0, 0), 1e-6f)
    }

    @Test fun otpClampFiltersDigitsAndLength() {
        assertEquals("123456", ElementMath.otpClamp("1 2-3a4b5c6789", 6))
        assertEquals("", ElementMath.otpClamp("abc", 4))
    }

    @Test fun segmentedToggleMultiPreservesOptionOrder() {
        val opts = listOf("Day", "Week", "Month")
        // flip Month ON — stored CSV re-joins in option order, not tap order.
        assertEquals("Day,Month", ElementMath.segmentedToggle("Day", "Month", opts, multiple = true))
        // flip Day OFF.
        assertEquals("Week", ElementMath.segmentedToggle("Day,Week", "Day", opts, multiple = true))
    }

    @Test fun segmentedToggleSingleReplacesAndClears() {
        val opts = listOf("List", "Grid")
        assertEquals("Grid", ElementMath.segmentedToggle("List", "Grid", opts, multiple = false))
        assertEquals("", ElementMath.segmentedToggle("Grid", "Grid", opts, multiple = false))
    }

    @Test fun rangeValueSnapsOnMinAnchoredGridAndClamps() {
        // grid anchored at min (RangeSlider.swift value(at:)) — never at 0.
        assertEquals(12.0, ElementMath.rangeValue(0.5, 2.0, 20.0, 5.0, 2.0, 22.0), 1e-9)
        // clamped into the thumb's sub-window (low never crosses high).
        assertEquals(10.0, ElementMath.rangeValue(1.0, 0.0, 100.0, null, 0.0, 10.0), 1e-9)
        assertEquals(0.0, ElementMath.rangeValue(-0.5, 0.0, 1.0, null, 0.0, 1.0), 1e-9)
    }

    // ── CalendarMath ───────────────────────────────────────────────────────────────────

    @Test fun parseDayAcceptsBareAndFullIso() {
        val bare = CalendarMath.parseDay("2026-07-10")
        val full = CalendarMath.parseDay("2026-07-10T00:00:00Z")
        assertNotNull(bare); assertNotNull(full)
        assertEquals(CalendarMath.isoDayFormatter().format(bare!!),
                     CalendarMath.isoDayFormatter().format(full!!))
        assertNull(CalendarMath.parseDay("bad"))
        assertNull(CalendarMath.parseDay(null))
    }

    @Test fun parseInstantReadsIso8601Utc() {
        val d = CalendarMath.parseInstant("2026-07-10T12:30:00Z")
        assertNotNull(d)
        assertEquals("2026-07-10T12:30:00Z", CalendarMath.iso8601Formatter().format(d!!))
    }

    @Test fun bareWireDayDoesNotShiftWhenTheDeviceTimezoneIsAheadOfUtc() {
        val previous = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Dubai"))
            val parsed = CalendarMath.parseInstant("2026-01-15")
            assertNotNull(parsed)
            assertEquals(
                "2026-01-15T00:00:00Z",
                CalendarMath.iso8601Formatter().format(parsed!!),
            )
        } finally {
            TimeZone.setDefault(previous)
        }
    }

    @Test fun monthDaysCountsAndLeadingBlanks() {
        // July 2026: 31 days, July 1st is a Wednesday.
        val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        cal.firstDayOfWeek = Calendar.SUNDAY
        cal.clear(); cal.set(2026, Calendar.JULY, 1)
        val (count, blanks) = CalendarMath.monthDays(cal.time, cal)
        assertEquals(31, count)
        assertEquals(3, blanks)   // Sun-first: Sun Mon Tue blank, Wed = day 1
        cal.firstDayOfWeek = Calendar.MONDAY
        val (_, blanksMon) = CalendarMath.monthDays(cal.time, cal)
        assertEquals(2, blanksMon)   // Mon-first: Mon Tue blank
    }

    @Test fun rotatedWeekdaysStartsAtFirstWeekday() {
        val symbols = listOf("S", "M", "T", "W", "T2", "F", "S2")
        assertEquals(symbols, CalendarMath.rotatedWeekdays(symbols, Calendar.SUNDAY))
        assertEquals(listOf("M", "T", "W", "T2", "F", "S2", "S"),
                     CalendarMath.rotatedWeekdays(symbols, Calendar.MONDAY))
    }

    // ── SvgModel ───────────────────────────────────────────────────────────────────────

    @Test fun svgParsesViewBoxShapesAndDefaults() {
        val doc = SvgModel.parse(
            """<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20"/>""" +
            """<circle cx="12" cy="12" r="10" fill="none" stroke="#fff" stroke-width="2"/></svg>""")
        assertNotNull(doc)
        assertEquals(24.0, doc!!.viewBox.w, 1e-9)
        assertEquals(2, doc.prims.size)
        // SVG default fill is BLACK (never StackStyle's white fallback).
        assertNotNull(doc.prims[0].fill)
        // fill="none" + stroke → stroke only, width 2.
        assertNull(doc.prims[1].fill)
        assertNotNull(doc.prims[1].stroke)
        assertEquals(2.0, doc.prims[1].strokeWidth, 1e-9)
    }

    @Test fun svgPathGrammarHandlesRelativeAndImplicitRepeats() {
        val cmds = SvgModel.parsePathData("M10 10 l5 0 5 5 H0 V0 Z")
        // M, L(implicit repeat = two Lines), H, V, Z
        assertEquals(6, cmds.size)
        assertTrue(cmds[0] is SvgModel.Cmd.Move)
        val l2 = cmds[2] as SvgModel.Cmd.Line
        assertEquals(20.0, l2.x, 1e-9); assertEquals(15.0, l2.y, 1e-9)   // relative accumulation
        assertTrue(cmds[5] is SvgModel.Cmd.Close)
    }

    @Test fun svgColorGrammar() {
        assertEquals(SvgModel.color("#fff"), SvgModel.color("#ffffff"))   // 3-digit expands
        assertEquals(1f, SvgModel.color("#ff000080").red, 1e-6f)          // SVG #rrggbbaa — alpha LAST
        assertEquals(0x80 / 255f, SvgModel.color("#ff000080").alpha, 1e-6f)
        assertEquals(SvgModel.color("black"), SvgModel.color("unknown-token"))   // unknown → black
    }

    @Test fun svgConvenienceFillRecognizesOnlyDsxSemanticColorWords() {
        assertTrue(isDsxSemanticSvgColor("accent"))
        assertTrue(isDsxSemanticSvgColor("label"))
        assertTrue(isDsxSemanticSvgColor("secondaryGroupedBackground"))
        assertTrue(isDsxSemanticSvgColor("destructive"))
        // SVG literals and names stay in the SVG parser, preserving #rrggbbaa and unknown→black.
        assertFalse(isDsxSemanticSvgColor("#ff000080"))
        assertFalse(isDsxSemanticSvgColor("white"))
        assertFalse(isDsxSemanticSvgColor("red"))
        assertFalse(isDsxSemanticSvgColor("none"))
        assertFalse(isDsxSemanticSvgColor("unknown-token"))
    }

    @Test fun svgEmptyOrShapelessIsNull() {
        assertNull(SvgModel.parse(""))
        assertNull(SvgModel.parse("<svg viewBox=\"0 0 10 10\"></svg>"))
    }

    @Test fun svgResourceAndParserBudgetsFailClosed() {
        assertNull(SvgModel.parse("<svg>" + " ".repeat(MediaInputPolicy.MAXIMUM_SVG_BYTES) + "</svg>"))
        val tooManyShapes = buildString {
            append("<svg>")
            repeat(MediaInputPolicy.MAXIMUM_SVG_PRIMITIVES + 1) { append("<rect width=\"1\" height=\"1\"/>") }
            append("</svg>")
        }
        assertNull(SvgModel.parse(tooManyShapes))
        val tokenBomb = buildString {
            append("M0 0 ")
            repeat(MediaInputPolicy.MAXIMUM_SVG_PATH_TOKENS + 1) { append("1 ") }
        }
        assertTrue(SvgModel.parsePathData(tokenBomb).isEmpty())
        assertNull(SvgModel.parse("<svg viewBox=\"0 0 1e999 10\"><rect width=\"1\" height=\"1\"/></svg>"))
        assertNull(SvgModel.parse("<svg viewBox=\"0 0 1e-300 10\"><rect width=\"1\" height=\"1\"/></svg>"))
    }

    // ── qrcode (ZXing-core, pure Java) ─────────────────────────────────────────────────

    @Test fun qrMatrixEncodesAndCaches() {
        val m = qrMatrix("https://despia.com", "M")
        assertNotNull(m)
        assertTrue(m!!.size >= 21)                     // version 1 = 21 modules minimum
        assertEquals(m.size, m[0].size)                // square
        assertTrue(m[0][0])                            // finder pattern corner is dark
        // higher correction can not shrink below the same version floor
        assertNotNull(qrMatrix("https://despia.com", "H"))
    }
}
