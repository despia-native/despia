package despia.engine.desktop

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.YearMonth
import java.nio.file.Files
import java.nio.file.Path
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DesktopExtendedElementsTest {
    @TempDir
    lateinit var temporary: Path

    @Test
    fun everyRequestedCanonicalTagHasAnExecutableNativeRoute() {
        assertEquals(
            linkedSetOf(
                "Accordion", "ChatBubble", "Checkbox", "Drawer", "LevelMeter", "MenuBar",
                "ProgressRing", "RadioGroup", "Signature", "Skeleton", "Table", "calendar", "carousel",
                "contextmenu", "datepicker", "field", "lightbox", "menu", "otp", "pager",
                "popover", "rangeslider", "searchbar", "split", "stars", "wheelpicker",
            ) + desktopStudioNativeTags,
            desktopExtendedNativeTags,
        )
        assertTrue(desktopExtendedFocusableTags.all { it in desktopExtendedNativeTags })
    }

    @Test
    fun otpInputKeepsOnlyTheBoundedDigitSequence() {
        assertEquals("123456", desktopOtpClamp("1a2 3-456789", 6))
        assertEquals("7", desktopOtpClamp("789", 0))
    }

    @Test
    fun rangeValuesClampAndSnapOnAGridAnchoredAtTheMinimum() {
        assertEquals(1.25, desktopRangeValue(1.21, 0.25, 2.25, 0.5))
        assertEquals(2.25, desktopRangeValue(8.0, 0.25, 2.25, 0.5))
        assertEquals(0.25, desktopRangeValue(Double.NaN, 0.25, 2.25, 0.5))
        assertEquals(0.0, desktopRangeValue(1.0, Double.NaN, 2.25, 0.5))
        assertTrue(desktopRangeValue(1.0e9, -1.0e9, 1.0e9, 1.0e-9).isFinite())
    }

    @Test
    fun calendarWireParsingAcceptsDatePickerInstantsAndRejectsMalformedDays() {
        assertEquals(LocalDate.of(2026, 7, 22), desktopParseDay("2026-07-22T10:20:30Z"))
        assertNull(desktopParseDay("2026-02-30"))
        assertNull(desktopParseDay("not-a-date"))
    }

    @Test
    fun calendarGridHonorsTheRequestedFirstWeekdayAndCompletesWeeks() {
        val cells = desktopMonthCells(YearMonth.of(2026, 7), DayOfWeek.MONDAY)
        assertEquals(35, cells.size)
        assertEquals(2, cells.indexOf(LocalDate.of(2026, 7, 1)))
        assertEquals(LocalDate.of(2026, 7, 31), cells.filterNotNull().last())
    }

    @Test
    fun fieldValidationReturnsTheFirstStableUserFacingError() {
        assertEquals("Required", desktopFieldError("", "required,email", null, null))
        assertEquals("Enter a valid email", desktopFieldError("broken", "email", null, null))
        assertEquals("Custom", desktopFieldError("x", "minLength:3", null, "Custom"))
        assertEquals("", desktopFieldError("dev@despia.dev", "required,email,minLength:3", null, null))
        assertEquals("Invalid format", desktopFieldError("abc", "pattern", "^[0-9]+$", null))
        assertTrue(desktopSafeRegexMatches("12345", "^[0-9]+$"))
        assertFalse(desktopSafeRegexMatches("a".repeat(4_096) + "!", "^(a+)+$"))
        assertFalse(desktopSafeRegexMatches("a".repeat(4_096) + "!", "a*a*a*a*b"))
        assertFalse(desktopSafeRegexMatches("abc", "(?=abc)abc"))
        assertFalse(desktopSafeRegexMatches("aa", "(a)\\1"))
    }

    @Test
    fun lightboxLocalFilesRequireAnExplicitRootAndNeverEscapeOrFollowLinks() {
        val image = temporary.resolve("safe.png")
        Files.write(image, byteArrayOf(1, 2, 3))
        assertNull(readDesktopLocalImage(image.toString(), null))
        assertEquals(byteArrayOf(1, 2, 3).toList(), readDesktopLocalImage("safe.png", temporary)?.bytes?.toList())
        assertEquals(byteArrayOf(1, 2, 3).toList(), readDesktopLocalImage(image.toUri().toString(), temporary)?.bytes?.toList())
        assertNull(readDesktopLocalImage("https://example.com/private.png", temporary))
        assertNull(readDesktopLocalImage("../outside.png", temporary))

        val wrong = temporary.resolve("safe.txt")
        Files.writeString(wrong, "not an image")
        assertNull(readDesktopLocalImage(wrong.toString(), temporary))

        val link = temporary.resolve("linked.png")
        Files.createSymbolicLink(link, image.fileName)
        assertNull(readDesktopLocalImage(link.toString(), temporary))
    }

    @Test
    fun authoredCountsAndTableLimitsHaveHardProductionCeilings() {
        assertEquals(MAX_DESKTOP_OTP_LENGTH, desktopOtpClamp("1".repeat(100), MAX_DESKTOP_OTP_LENGTH).length)
        assertEquals(10_000, MAX_DESKTOP_TABLE_ROWS)
        assertEquals(128, MAX_DESKTOP_TABLE_COLUMNS)
        assertEquals(32, MAX_DESKTOP_OTP_LENGTH)
        assertEquals(20, MAX_DESKTOP_STAR_COUNT)
    }

    @Test
    fun boundCollectionsStopBeforeWholeInputConversionAndCyclicMenusTerminate() {
        val oversized = List(MAX_DESKTOP_BOUND_ROWS + 500) { mapOf<String, Any?>("index" to it) }
        assertEquals(MAX_DESKTOP_BOUND_ROWS, desktopBoundedRows(oversized).size)
        assertEquals(MAX_DESKTOP_TABLE_ROWS + 1, desktopBoundedRows(oversized, MAX_DESKTOP_TABLE_ROWS + 1).size)

        val cyclicRows = mutableListOf<Map<String, Any?>>()
        val cyclicRow = mutableMapOf<String, Any?>("title" to "Cycle")
        cyclicRow["items"] = cyclicRows
        cyclicRows += cyclicRow
        val flattened = flattenMenu(cyclicRows)
        assertTrue(flattened.isNotEmpty())
        assertTrue(flattened.size <= 512)
    }
}
