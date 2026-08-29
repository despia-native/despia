//
//  DateElements.kt — the date family, two Kotlin twins on the system-defaults ladder
//  (system-defaults.md; the StackSystemControls.kt philosophy):
//
//  `<datepicker>` / `<date>` (DatePicker.swift): a two-way date/time bound to an ISO-8601
//  STRING (the wire shape both platforms share). `mode="date"` (default) / `time` /
//  `datetime`; optional `label` (leading); `color` (default accent) tints the value
//  pill(s). Both paths draw the SwiftUI-COMPACT chrome — label + `fill`-token value pills
//  (radius 8, padding 11×6, tint text), the shared `DatePill`. UNSTYLED → tapping a pill
//  opens the REAL Material 3 pickers: `DatePickerDialog` wrapping `DatePicker` (date), an
//  M3 `AlertDialog` hosting `TimePicker` (time — M3 ships no TimePickerDialog, so the
//  standard AlertDialog wrap). ANY authored look ejects to the LEGACY path
//  (`SelectionControl.rendersSystem` — SelectionSystem.kt), byte-identical to the pre-M3
//  rendering: the same pills opening the PLATFORM dialogs (android.app.DatePickerDialog /
//  TimePickerDialog — framework widgets). Writes are the iOS ISO8601DateFormatter shape
//  (`yyyy-MM-dd'T'HH:mm:ss'Z'`, UTC) through the bind seam on both paths.
//  DIVERGENCE (pinned, none silent): the M3 date/time dialogs own the PLATFORM accent (the
//  themed primary); `color` tints the compact trigger pill (the iOS pill tint), not the
//  dialog — the system component owns its look, the system-defaults contract.
//
//  `<calendar>` (Calendar.swift): the full MONTH GRID — two-way `yyyy-MM-dd` selection,
//  `min`/`max` inclusive range (outside days dimmed + inert), localized weekday symbols +
//  first-weekday, chevron month paging (fires `on:month` with { month: "yyyy-MM" }), a
//  today ring, and data-driven dot marks (`marks` list; `markDateField`/`markColorField`).
//  DIVERGENCE (pinned, none silent): Material 3's `DatePicker` IS an inline month grid, but
//  it exposes NO per-day decoration slot — the `marks` dots (and the min/max + today-ring
//  composition) are core to `<calendar>`'s contract and have no drop-in M3 twin (checked
//  against the material3-android public composable set). So `<calendar>` retains its custom
//  grid in every case (no gate), dressed in M3 TOKENS (the `label`/`secondary` roles →
//  onSurface/onSurfaceVariant; the selection circle rides the `color` tint → primary); the
//  white selected-day text is the iOS cross-platform contract (Calendar.swift:137), kept
//  as-is rather than re-specified to onPrimary. The Swift numbers verbatim: VStack spacing
//  10 · header chevrons 15pt semibold in 36×36 targets · month title 17 semibold · weekday
//  caption 11 semibold secondary · 7-column grid, 6dp row gap, 40dp cells · day text 16
//  (bold selected) · 34dp selection circle · 1.5dp today ring · 5dp mark dot (3dp below) ·
//  disabled = secondary at 35%. The month parser accepts BOTH `yyyy-MM-dd` and the full ISO
//  datetimes `<datepicker>` writes. Month math lives in CalendarMath (pure, plain-JVM tested).
//

package despia.engine.render.elements

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog as ComposeDatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import despia.engine.DSXStrings
import despia.engine.JSE
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.StackIcon
import despia.engine.render.StackStyle
import despia.engine.render.dsxAccessibleActivation
import despia.engine.render.dsxAccessibleSelectable
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal fun registerDateElements() {
    ComposeStackComponents.defineNative("datepicker") { ctx -> DatePickerView(ctx) }
    ComposeStackComponents.defineNative("date") { ctx -> DatePickerView(ctx) }
    ComposeStackComponents.defineNative("calendar") { ctx -> CalendarGridView(ctx) }
}

// MARK: - the pure date math (plain-JVM tested — ElementsLogicTest.kt)

internal object CalendarMath {

    /// The `yyyy-MM-dd` WIRE format (en_US_POSIX twin) — display stays localized.
    fun isoDayFormatter(): SimpleDateFormat =
        SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            isLenient = false
            // A bare calendar day is a timezone-free wire value. Parse it at UTC midnight
            // because the M3 trigger and output formatter also read UTC; otherwise devices
            // east of UTC turn 2026-01-15 into a visible Jan 14.
            timeZone = TimeZone.getTimeZone("UTC")
        }

    /// The iOS ISO8601DateFormatter wire shape `<datepicker>` writes (UTC instant).
    fun iso8601Formatter(): SimpleDateFormat =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }

    /// Parse a day out of a wire date — accepts BOTH `yyyy-MM-dd` AND full ISO-8601
    /// datetimes ("2026-07-02T00:00:00Z" → its date part), the Calendar.swift contract.
    fun parseDay(s: String?): Date? {
        val t = s?.trim() ?: return null
        if (t.length < 10) return null
        return runCatching { isoDayFormatter().parse(t.take(10)) }.getOrNull()
    }

    /// Parse a full ISO-8601 datetime (seconds optional, `Z` or numeric offset), else the
    /// bare day — the lenient read half of the `<datepicker>` bind.
    fun parseInstant(s: String?): Date? {
        val t = s?.trim() ?: return null
        if (t.isEmpty()) return null
        for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ssXXX",
                               "yyyy-MM-dd'T'HH:mm'Z'", "yyyy-MM-dd'T'HH:mmXXX")) {
            val f = SimpleDateFormat(pattern, Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            runCatching { f.parse(t) }.getOrNull()?.let { return it }
        }
        return parseDay(t)
    }

    /// The displayed month's day count + how many blank cells pad before day 1 —
    /// Calendar.swift `monthDays` verbatim (`(weekday - firstWeekday + 7) % 7`).
    fun monthDays(monthFirst: Date, cal: Calendar): Pair<Int, Int> {
        val c = cal.clone() as Calendar
        c.time = monthFirst
        val count = c.getActualMaximum(Calendar.DAY_OF_MONTH)
        val weekday = c.get(Calendar.DAY_OF_WEEK)                    // 1…7 (Sun=1)
        val blanks = (weekday - c.firstDayOfWeek + 7) % 7
        return count to blanks
    }

    /// Weekday symbols starting at the locale's first weekday (Mon-first in Europe) —
    /// Calendar.swift `rotatedWeekdays`.
    fun rotatedWeekdays(symbols: List<String>, firstWeekday: Int): List<String> {
        val first = firstWeekday - 1
        if (symbols.size != 7 || first !in 0..6) return symbols
        return symbols.drop(first) + symbols.take(first)
    }
}

// MARK: - datepicker / date (system: M3 dialogs · legacy: framework dialogs)

/// Unstyled → the real M3 date/time dialogs; any authored look ejects to the legacy
/// framework-dialog path (header). The compact trigger pills are shared (`DatePill`).
@Composable
private fun DatePickerView(ctx: ComposeStackComponentContext) {
    if (SelectionControl.rendersSystem(ctx.attrs, SelectionControl.DATEPICKER)) M3DatePickerView(ctx)
    else LegacyDatePickerView(ctx)
}

/// datepicker/date — the REAL Material 3 pickers: `DatePickerDialog` wrapping `DatePicker`
/// (date), an `AlertDialog` hosting `TimePicker` (time — M3 has no TimePickerDialog). The
/// pills open them; a confirm writes the iso8601 shape through the bind seam. `color` tints
/// the pills — the M3 dialogs own the platform accent (the pinned divergence).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun M3DatePickerView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val mode = ctx.attrs["mode"]
    val label = ctx.str("label")
    val tint = StackStyle.color(ctx.str("color", ElementDefaults.DATE_TINT))
    val context = LocalContext.current
    val iso = CalendarMath.iso8601Formatter()
    val current = CalendarMath.parseInstant((ctl.boundValue(key) as? String)) ?: Date()
    // disabled= / disabled-if= (W9): the pills gate their dialogs
    val disabled = SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    var showDate by remember { mutableStateOf(false) }
    var showTime by remember { mutableStateOf(false) }

    fun commit(mutate: (Calendar) -> Unit) {
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { time = current }
        mutate(c)
        ctl.setBound(key, iso.format(c.time))       // on:change from the write seam
    }

    val dateText = remember(current) {
        SimpleDateFormat("MMM d, yyyy", Locale.getDefault())
            .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(current)
    }
    val timeText = remember(current) {
        SimpleDateFormat("h:mm a", Locale.getDefault())
            .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(current)
    }

    Row(Modifier.elementModifier(ctx).then(Modifier.fillMaxWidth()),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (label.isNotEmpty()) {
            BasicText(label, style = StackStyle.styleText(ctx.attrs, ctx.store, ctx.item,
                                                          StackStyle.color("label")))
        }
        Spacer(Modifier.weight(1f))
        if (mode != "time") DatePill(dateText, tint, enabled = !disabled) { showDate = true }
        if (mode == "time" || mode == "datetime") DatePill(timeText, tint, enabled = !disabled) { showTime = true }
    }

    if (showDate) {
        val dateState = rememberDatePickerState(initialSelectedDateMillis = current.time)
        ComposeDatePickerDialog(
            onDismissRequest = { showDate = false },
            confirmButton = {
                TextButton(onClick = {
                    dateState.selectedDateMillis?.let { ms ->
                        val picked = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = ms }
                        commit {
                            it.set(Calendar.YEAR, picked.get(Calendar.YEAR))
                            it.set(Calendar.MONTH, picked.get(Calendar.MONTH))
                            it.set(Calendar.DAY_OF_MONTH, picked.get(Calendar.DAY_OF_MONTH))
                        }
                    }
                    showDate = false
                }) { Text(DSXStrings.localize("Done")) }
            },
            dismissButton = {
                TextButton(onClick = { showDate = false }) { Text(DSXStrings.localize("Cancel")) }
            },
        ) {
            DatePicker(state = dateState)
        }
    }

    if (showTime) {
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { time = current }
        val timeState = rememberTimePickerState(
            initialHour = c.get(Calendar.HOUR_OF_DAY),
            initialMinute = c.get(Calendar.MINUTE),
            is24Hour = android.text.format.DateFormat.is24HourFormat(context),
        )
        AlertDialog(
            onDismissRequest = { showTime = false },
            confirmButton = {
                TextButton(onClick = {
                    commit {
                        it.set(Calendar.HOUR_OF_DAY, timeState.hour)
                        it.set(Calendar.MINUTE, timeState.minute)
                        it.set(Calendar.SECOND, 0)
                    }
                    showTime = false
                }) { Text(DSXStrings.localize("Done")) }
            },
            dismissButton = {
                TextButton(onClick = { showTime = false }) { Text(DSXStrings.localize("Cancel")) }
            },
            text = { TimePicker(state = timeState) },
        )
    }
}

// MARK: - datepicker / date (legacy — the framework dialogs, the styled-eject path)

@Composable
private fun LegacyDatePickerView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val mode = ctx.attrs["mode"]
    val label = ctx.str("label")
    val tint = StackStyle.color(ctx.str("color", ElementDefaults.DATE_TINT))
    val context = LocalContext.current
    val iso = CalendarMath.iso8601Formatter()
    val current = CalendarMath.parseInstant((ctl.boundValue(key) as? String)) ?: Date()
    // disabled= / disabled-if= (W9): the pills gate their dialogs
    val disabled = SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))

    fun commit(mutate: (Calendar) -> Unit) {
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { time = current }
        mutate(c)
        ctl.setBound(key, iso.format(c.time))       // on:change from the write seam
    }
    fun openDate() {
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { time = current }
        DatePickerDialog(context, { _, y, m, d ->
            commit { it.set(y, m, d) }
        }, c.get(Calendar.YEAR), c.get(Calendar.MONTH), c.get(Calendar.DAY_OF_MONTH)).show()
    }
    fun openTime() {
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { time = current }
        TimePickerDialog(context, { _, h, min ->
            commit { it.set(Calendar.HOUR_OF_DAY, h); it.set(Calendar.MINUTE, min); it.set(Calendar.SECOND, 0) }
        }, c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE), false).show()
    }

    val dateText = remember(current) {
        SimpleDateFormat("MMM d, yyyy", Locale.getDefault())
            .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(current)
    }
    val timeText = remember(current) {
        SimpleDateFormat("h:mm a", Locale.getDefault())
            .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(current)
    }

    Row(Modifier.elementModifier(ctx).then(Modifier.fillMaxWidth()),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (label.isNotEmpty()) {
            BasicText(label, style = StackStyle.styleText(ctx.attrs, ctx.store, ctx.item,
                                                          StackStyle.color("label")))
        }
        Spacer(Modifier.weight(1f))
        if (mode != "time") DatePill(dateText, tint, enabled = !disabled) { openDate() }
        if (mode == "time" || mode == "datetime") DatePill(timeText, tint, enabled = !disabled) { openTime() }
    }
}

/// One compact-style value pill: tertiary-fill background, radius 8, padding 11×6 —
/// the UIDatePicker compact chrome.
@Composable
private fun DatePill(text: String, tint: Color, enabled: Boolean = true, tap: () -> Unit) {
    Box(Modifier
            .background(StackStyle.color("fill"), RoundedCornerShape(8.dp))
            .dsxAccessibleActivation(enabled = enabled, role = Role.Button, onClick = tap)
            .pointerInput(text, enabled) { detectTapGestures { if (enabled) tap() } }
            .padding(horizontal = 11.dp, vertical = 6.dp)
            .alpha(if (enabled) 1f else 0.5f)) {
        BasicText(text, style = TextStyle(color = tint, fontSize = 17.sp))
    }
}

// MARK: - calendar (the month grid)

@Composable
private fun CalendarGridView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val iso = CalendarMath.isoDayFormatter()
    val cal = remember { Calendar.getInstance() }
    val selected = CalendarMath.parseDay(JSE.string(ctl.boundValue(key)))
    val tint = StackStyle.color(ctx.str("color", ElementDefaults.CALENDAR_TINT))
    val minDate = CalendarMath.parseDay(ctx.str("min"))
    val maxDate = CalendarMath.parseDay(ctx.str("max"))
    // disabled= / disabled-if= (W9): a globally disabled calendar gates paging + picks
    // (the Calendar.swift twin — every day dims like an out-of-range one).
    val globallyDisabled = SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))

    // The displayed month follows the SELECTED date on open (else today), then pages.
    var month by remember {
        val anchor = Calendar.getInstance().apply { time = selected ?: Date() }
        anchor.set(Calendar.DAY_OF_MONTH, 1)
        zeroTime(anchor)
        mutableStateOf(anchor.time)
    }

    // ISO date → dot color for the `marks` list (empty color field → the accent tint).
    val marks = HashMap<String, Color>()
    ctx.attrs["marks"]?.let { lk ->
        val dateField = ctx.attrs["markDateField"] ?: "date"
        val colorField = ctx.attrs["markColorField"] ?: "color"
        for (row in bindList(lk, ctx.store, ctx.item)) {
            val d = JSE.string(row[dateField] ?: "")
            if (d.length < 10) continue
            val c = JSE.string(row[colorField] ?: "")
            marks[d.take(10)] = if (c.isEmpty()) tint else StackStyle.color(c)
        }
    }

    fun page(delta: Int) {
        val c = Calendar.getInstance().apply { time = month }
        c.add(Calendar.MONTH, delta)
        month = c.time
        val ym = iso.format(c.time).take(7)                       // "yyyy-MM"
        ctx.attrs["on:month"]?.let { ctx.env.run(it, ctx.item, mapOf("month" to ym)) }
    }

    val monthTitle = remember(month) {
        SimpleDateFormat("LLLL yyyy", Locale.getDefault()).format(month)
    }
    val (dayCount, leadingBlanks) = CalendarMath.monthDays(month, cal)
    val symbols = CalendarMath.rotatedWeekdays(narrowWeekdays(), cal.firstDayOfWeek)

    Column(Modifier.elementModifier(ctx), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // ── Month header: ‹ July 2026 › ──
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Chevron(
                "chevron.left",
                tint,
                DSXStrings.localize("Previous month"),
                enabled = !globallyDisabled,
            ) { page(-1) }
            Spacer(Modifier.weight(1f))
            BasicText(monthTitle, style = TextStyle(color = StackStyle.color("label"),
                                                    fontSize = 17.sp,
                                                    fontWeight = StackStyle.weight("semibold")))
            Spacer(Modifier.weight(1f))
            Chevron(
                "chevron.right",
                tint,
                DSXStrings.localize("Next month"),
                enabled = !globallyDisabled,
            ) { page(1) }
        }
        // ── Weekday symbols, rotated to the locale's first weekday ──
        Row(Modifier.fillMaxWidth()) {
            for (s in symbols) {
                Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    BasicText(s, style = TextStyle(color = StackStyle.color("secondary"),
                                                   fontSize = 11.sp,
                                                   fontWeight = StackStyle.weight("semibold"),
                                                   textAlign = TextAlign.Center))
                }
            }
        }
        // ── Day grid: leading blanks + the month's days (7 columns, 6dp row gap) ──
        val today = zeroTime(Calendar.getInstance()).time
        var day = 1
        Column(
            Modifier.fillMaxWidth().selectableGroup(),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            var cell = 0
            while (day <= dayCount) {
                Row(Modifier.fillMaxWidth()) {
                    for (col in 0 until 7) {
                        Box(Modifier.weight(1f).height(40.dp), contentAlignment = Alignment.TopCenter) {
                            if (cell >= leadingBlanks && day <= dayCount) {
                                val c = Calendar.getInstance().apply { time = month }
                                c.add(Calendar.DAY_OF_MONTH, day - 1)
                                zeroTime(c)
                                DayCell(day = day, date = c.time, iso = iso, selected = selected,
                                        today = today, tint = tint, minDate = minDate,
                                        maxDate = maxDate, forcedDisabled = globallyDisabled,
                                        mark = marks[iso.format(c.time)]) { picked ->
                                    ctl.setBound(key, picked)     // on:change via the write seam
                                }
                                day += 1
                            }
                        }
                        cell += 1
                    }
                }
            }
        }
    }
}

@Composable
private fun DayCell(day: Int, date: Date, iso: SimpleDateFormat, selected: Date?, today: Date,
                    tint: Color, minDate: Date?, maxDate: Date?, forcedDisabled: Boolean,
                    mark: Color?, pick: (String) -> Unit) {
    val isSelected = selected != null && iso.format(selected) == iso.format(date)
    val isToday = iso.format(today) == iso.format(date)
    val disabled = forcedDisabled ||
        (minDate != null && date.before(minDate)) || (maxDate != null && date.after(maxDate))
    val spokenDate = remember(date) {
        SimpleDateFormat("EEEE, MMMM d, yyyy", Locale.getDefault()).format(date)
    }
    Column(
        Modifier
            .dsxAccessibleSelectable(
                selected = isSelected,
                enabled = !disabled,
                role = Role.RadioButton,
                contentDescription = spokenDate,
                onSelect = { pick(iso.format(date)) },
            )
            .pointerInput(day, isSelected, disabled) {
                detectTapGestures { if (!disabled) pick(iso.format(date)) }
            },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Box(Modifier.size(34.dp)
                .background(if (isSelected) tint else Color.Transparent, CircleShape)
                .border(1.5.dp, if (isToday && !isSelected) tint else Color.Transparent, CircleShape),
            contentAlignment = Alignment.Center) {
            BasicText("$day", style = TextStyle(
                color = when {
                    isSelected -> Color.White
                    disabled -> StackStyle.color("secondary").copy(alpha = 0.35f)
                    else -> StackStyle.color("label")
                },
                fontSize = 16.sp,
                fontWeight = if (isSelected) StackStyle.weight("bold") else StackStyle.weight(null)))
        }
        Box(Modifier.size(5.dp).background(mark ?: Color.Transparent, CircleShape))
    }
}

@Composable
private fun Chevron(icon: String, tint: Color, description: String, enabled: Boolean = true,
                    tap: () -> Unit) {
    Box(Modifier.size(36.dp)
        .dsxAccessibleActivation(
            enabled = enabled,
            role = Role.Button,
            contentDescription = description,
            onClick = tap,
        )
        .pointerInput(icon, enabled) { detectTapGestures { if (enabled) tap() } }
        .alpha(if (enabled) 1f else 0.5f),
        contentAlignment = Alignment.Center) {
        StackIcon(icon, 15.0, tint)
    }
}

/// Localized single-letter weekday symbols, Sunday-first (the `veryShortStandalone` twin) —
/// android.icu narrow standalone symbols (API 24+); index 0 = Sunday after the ICU shift.
private fun narrowWeekdays(): List<String> {
    return runCatching {
        val dfs = android.icu.text.DateFormatSymbols.getInstance(Locale.getDefault())
        val w = dfs.getWeekdays(android.icu.text.DateFormatSymbols.STANDALONE,
                                android.icu.text.DateFormatSymbols.NARROW)
        // ICU weekday arrays are 1-based (index 1 = Sunday).
        (1..7).map { w.getOrNull(it) ?: "" }
    }.getOrNull()?.takeIf { it.all { s -> s.isNotEmpty() } }
        ?: listOf("S", "M", "T", "W", "T", "F", "S")
}

/// Zero the time-of-day parts (the `startOfDay` twin); returns the same instance.
private fun zeroTime(c: Calendar): Calendar {
    c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0)
    c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
    return c
}
