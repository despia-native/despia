@file:OptIn(
    androidx.compose.foundation.ExperimentalFoundationApi::class,
    androidx.compose.ui.ExperimentalComposeUiApi::class,
)

package despia.engine.desktop

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.MaterialTheme
import androidx.compose.material.DropdownMenu
import androidx.compose.material.DropdownMenuItem
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.isCtrlPressed
import androidx.compose.ui.input.pointer.isMetaPressed
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import despia.engine.DSXEventSubscription
import despia.engine.DSXEvents
import despia.engine.JSE
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.pow

internal const val MAX_DESKTOP_STUDIO_ROWS = 2_048
internal const val MAX_DESKTOP_STUDIO_PEAKS = 4_096
private const val MAX_DESKTOP_STUDIO_SECONDS = 36_000.0

internal data class DesktopStudioClip(
    val id: Int,
    val track: Int,
    val start: Double,
    val duration: Double,
    val sourceStart: Double,
    val sourceDuration: Double,
    val peaks: List<Double>,
)

internal data class DesktopStudioNote(
    val id: Int,
    val start: Double,
    val duration: Double,
    val detectedMidi: Double,
    val targetMidi: Double,
)

internal data class DesktopStudioTrack(
    val id: Int,
    val name: String,
    val armed: Boolean,
    val muted: Boolean,
    val solo: Boolean,
)

internal data class DesktopStudioTrimCommit(
    val sourceStart: Double,
    val duration: Double,
    val start: Double,
)

internal fun desktopStudioNumber(value: Any?, fallback: Double = 0.0): Double = when (value) {
    is Number -> value.toDouble().takeIf(Double::isFinite) ?: fallback
    is String -> value.toDoubleOrNull()?.takeIf(Double::isFinite) ?: fallback
    else -> fallback
}

internal fun desktopStudioPeaks(values: Iterable<Any?>): List<Double> =
    values.asSequence().take(MAX_DESKTOP_STUDIO_PEAKS)
        .map { desktopStudioNumber(it).coerceIn(0.0, 1.0) }
        .toList()

internal fun desktopStudioSeedPeaks(seed: Int, count: Int = 48): List<Double> =
    (0 until count.coerceIn(1, MAX_DESKTOP_STUDIO_PEAKS)).map { index ->
        val t = ((index * 9 + seed * 17) % 23) / 23.0
        val envelope = if (count <= 1) 1.0 else sin(index / (count - 1.0) * PI)
        (0.15 + 0.85 * abs(sin(t * PI * 2.0)) * envelope).coerceIn(0.0, 1.0)
    }

internal fun desktopStudioPeakWindow(
    peaks: List<Double>,
    sourceDuration: Double,
    from: Double,
    to: Double,
): List<Double> {
    if (peaks.isEmpty() || !sourceDuration.isFinite() || sourceDuration <= 0.0 || to <= from) return emptyList()
    val low = ((from.coerceIn(0.0, sourceDuration) / sourceDuration) * peaks.size)
        .toInt().coerceIn(0, peaks.lastIndex)
    val high = ((to.coerceIn(0.0, sourceDuration) / sourceDuration) * peaks.size)
        .toInt().coerceIn(low + 1, peaks.size)
    return peaks.subList(low, high)
}

internal fun desktopStudioTimecode(seconds: Double): String {
    val bounded = seconds.takeIf(Double::isFinite)?.coerceIn(0.0, MAX_DESKTOP_STUDIO_SECONDS) ?: 0.0
    val whole = bounded.toInt()
    val tenth = floor((bounded - whole) * 10.0 + 1e-8).toInt().coerceIn(0, 9)
    return String.format(java.util.Locale.US, "%d:%02d.%d", whole / 60, whole % 60, tenth)
}

internal fun desktopStudioSnapTime(time: Double, tempo: Double, snap: Boolean): Double {
    val bounded = time.takeIf(Double::isFinite)?.coerceIn(0.0, MAX_DESKTOP_STUDIO_SECONDS) ?: 0.0
    if (!snap) return bounded
    val beat = 60.0 / tempo.takeIf(Double::isFinite)?.coerceIn(1.0, 1_000.0).orFallback(120.0)
    return ((bounded / beat).roundToInt() * beat).coerceIn(0.0, MAX_DESKTOP_STUDIO_SECONDS)
}

private fun Double?.orFallback(fallback: Double): Double = this ?: fallback

internal fun desktopStudioTrimStart(
    clip: DesktopStudioClip,
    deltaSeconds: Double,
    tempo: Double,
    snap: Boolean,
): DesktopStudioTrimCommit {
    val delta = deltaSeconds.takeIf(Double::isFinite).orFallback(0.0)
        .coerceIn(max(-clip.sourceStart, -clip.start), max(0.0, clip.duration - 0.05))
    var sourceStart = clip.sourceStart + delta
    var duration = clip.duration - delta
    var start = clip.start + delta
    if (snap) {
        val quantized = desktopStudioSnapTime(start, tempo, true)
        val adjustment = (quantized - start).coerceIn(-sourceStart, duration - 0.05)
        if (abs(start + adjustment - clip.start) > 1e-4) {
            start += adjustment
            sourceStart += adjustment
            duration -= adjustment
        }
    }
    return DesktopStudioTrimCommit(
        sourceStart.coerceAtLeast(0.0),
        duration.coerceAtLeast(0.05),
        start.coerceAtLeast(0.0),
    )
}

internal fun desktopStudioTrimEnd(
    clip: DesktopStudioClip,
    deltaSeconds: Double,
    tempo: Double,
    snap: Boolean,
): DesktopStudioTrimCommit {
    val maxExtend = max(0.0, (clip.sourceDuration - clip.sourceStart) - clip.duration)
    val delta = deltaSeconds.takeIf(Double::isFinite).orFallback(0.0)
        .coerceIn(-(clip.duration - 0.05), maxExtend)
    var duration = clip.duration + delta
    if (snap) {
        val beat = 60.0 / tempo.takeIf(Double::isFinite)?.coerceIn(1.0, 1_000.0).orFallback(120.0)
        val quantized = (((clip.start + duration) / beat).roundToInt() * beat - clip.start)
            .coerceIn(0.05, max(0.05, clip.sourceDuration - clip.sourceStart))
        if (abs(quantized - clip.duration) > 1e-4) duration = quantized
    }
    return DesktopStudioTrimCommit(clip.sourceStart, duration.coerceAtLeast(0.05), clip.start)
}

internal fun desktopStudioSnapMidi(
    raw: Double,
    root: Int,
    scale: Set<Int>,
    snap: Boolean,
): Double {
    val rounded = raw.takeIf(Double::isFinite)?.roundToInt()?.toDouble() ?: 60.0
    if (!snap || scale.isEmpty()) return rounded.coerceIn(36.0, 96.0)
    return (-3..3).asSequence()
        .map { rounded + it }
        .filter { candidate -> (((candidate.roundToInt() - root) % 12 + 12) % 12) in scale }
        .minByOrNull { candidate -> abs(candidate - raw) }
        .orFallback(rounded)
        .coerceIn(36.0, 96.0)
}

/** Native desktop wheel/trackpad zoom law. One bounded exponential step works for
 * coarse mouse wheels and high-resolution trackpads without letting hostile event
 * magnitudes create an unbounded canvas. Negative delta zooms in, as on the system. */
internal fun desktopStudioWheelZoom(
    current: Double,
    delta: Float,
    minimum: Double,
    maximum: Double,
): Double {
    if (!current.isFinite() || !delta.isFinite() || minimum <= 0.0 || maximum < minimum) return minimum
    val steps = (-delta.toDouble()).coerceIn(-8.0, 8.0)
    return (current * 1.12.pow(steps)).coerceIn(minimum, maximum)
}

internal fun desktopPitchClasses(scale: String): Set<Int> = when (scale) {
    "major" -> setOf(0, 2, 4, 5, 7, 9, 11)
    "minor" -> setOf(0, 2, 3, 5, 7, 8, 10)
    "harmonicMinor" -> setOf(0, 2, 3, 5, 7, 8, 11)
    "melodicMinor" -> setOf(0, 2, 3, 5, 7, 9, 11)
    "dorian" -> setOf(0, 2, 3, 5, 7, 9, 10)
    "phrygian" -> setOf(0, 1, 3, 5, 7, 8, 10)
    "lydian" -> setOf(0, 2, 4, 6, 7, 9, 11)
    "mixolydian" -> setOf(0, 2, 4, 5, 7, 9, 10)
    "locrian" -> setOf(0, 1, 3, 5, 6, 8, 10)
    "pentatonicMajor" -> setOf(0, 2, 4, 7, 9)
    "pentatonicMinor" -> setOf(0, 3, 5, 7, 10)
    "blues" -> setOf(0, 3, 5, 6, 7, 10)
    "wholeTone" -> setOf(0, 2, 4, 6, 8, 10)
    "diminished" -> setOf(0, 2, 3, 5, 6, 8, 9, 11)
    else -> (0..11).toSet()
}

private fun desktopKeyRoot(key: String): Int = mapOf(
    "C" to 0, "C#" to 1, "Db" to 1, "D" to 2, "D#" to 3, "Eb" to 3,
    "E" to 4, "F" to 5, "F#" to 6, "Gb" to 6, "G" to 7, "G#" to 8,
    "Ab" to 8, "A" to 9, "A#" to 10, "Bb" to 10, "B" to 11,
)[key] ?: 0

private fun DesktopElementContext.rows(name: String): List<Map<String, Any?>> =
    JSE.asRows(JSE.eval(attributes[name].orEmpty(), store, item)).take(MAX_DESKTOP_STUDIO_ROWS)

private fun DesktopElementContext.clips(): List<DesktopStudioClip> = rows("clips").map { row ->
    val duration = desktopStudioNumber(row["duration"]).coerceIn(0.0, MAX_DESKTOP_STUDIO_SECONDS)
    DesktopStudioClip(
        id = desktopStudioNumber(row["id"]).roundToInt(),
        track = desktopStudioNumber(row["track"]).roundToInt(),
        start = desktopStudioNumber(row["start"]).coerceIn(0.0, MAX_DESKTOP_STUDIO_SECONDS),
        duration = duration,
        sourceStart = desktopStudioNumber(row["sourceStart"]).coerceIn(0.0, MAX_DESKTOP_STUDIO_SECONDS),
        sourceDuration = desktopStudioNumber(row["sourceDuration"], duration)
            .coerceIn(0.0, MAX_DESKTOP_STUDIO_SECONDS),
        peaks = desktopStudioPeaks((row["peaks"] as? Iterable<*>)?.toList().orEmpty()),
    )
}

private fun DesktopElementContext.tracks(): List<DesktopStudioTrack> = rows("tracks").map { row ->
    DesktopStudioTrack(
        id = desktopStudioNumber(row["id"]).roundToInt(),
        name = JSE.string(row["name"]).take(256),
        armed = JSE.truthy(row["armed"]),
        muted = JSE.truthy(row["muted"]),
        solo = JSE.truthy(row["solo"]),
    )
}

private fun DesktopElementContext.notes(): List<DesktopStudioNote> = rows("notes").map { row ->
    DesktopStudioNote(
        id = desktopStudioNumber(row["id"]).roundToInt(),
        start = desktopStudioNumber(row["start"]).coerceIn(0.0, MAX_DESKTOP_STUDIO_SECONDS),
        duration = desktopStudioNumber(row["duration"]).coerceIn(0.0, MAX_DESKTOP_STUDIO_SECONDS),
        detectedMidi = desktopStudioNumber(row["detectedMidi"], 60.0).coerceIn(0.0, 127.0),
        targetMidi = desktopStudioNumber(row["targetMidi"], 60.0).coerceIn(0.0, 127.0),
    )
}

private fun DesktopElementContext.attributeNumber(name: String, fallback: Double): Double =
    desktopStudioNumber(attributes[name]?.let { raw -> JSE.eval(raw, store, item) } ?: attributes[name], fallback)

private fun DesktopElementContext.attributeBoolean(name: String, fallback: Boolean = false): Boolean =
    attributes[name]?.let { JSE.truthy(JSE.eval(it, store, item)) } ?: fallback

private fun DesktopElementContext.attributeString(name: String, fallback: String = ""): String =
    value(name)?.take(65_536) ?: fallback

private fun DesktopElementContext.fire(name: String, payload: Map<String, Any?>) {
    attributes["on:$name"]?.takeIf(String::isNotBlank)?.let { run(it, payload) }
}

private fun DesktopElementContext.emit(name: String, payload: Map<String, Any?>) {
    fire(name, payload)
    despia.engine.JSERunner.publishNative(
        name,
        despia.engine.JSERunner.stampFrom(payload, "component", node.tag),
    )
}

internal fun desktopStudioDispatch(call: String, payload: Map<String, Any?>): Boolean {
    if (!call.startsWith("studio.") || !call.matches(Regex("studio\\.[A-Za-z][A-Za-z0-9_]{0,63}"))) return false
    return despia.engine.JSERunner.moduleHandle(
        despia.engine.JSERunner.normalizeCall(call),
        payload,
    ) { }
}

@Composable
internal fun DesktopStudioElement(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    when (context.node.tag) {
        "Waveform" -> DesktopWaveform(context, modifier)
        "StudioTimecode" -> DesktopStudioTimecode(context, modifier)
        "StudioTimeline" -> DesktopStudioTimeline(context, modifier, disabled)
        "StudioTrim" -> DesktopStudioTrim(context, modifier, disabled)
        "StudioPitchEditor" -> DesktopStudioPitchEditor(context, modifier, disabled)
        "StudioShow" -> DesktopStudioShow(context, modifier)
    }
}

@Composable
private fun DesktopWaveform(context: DesktopElementContext, modifier: Modifier) {
    val authored = context.attributeString("peaks").take(65_536)
    // Waveform's canonical string grammar drops malformed samples; it does not turn
    // them into silent bars. A wholly malformed list therefore gets the deterministic
    // seed silhouette, exactly like the Apple/Android elements.
    val real = authored.splitToSequence(',')
        .mapNotNull { sample -> sample.trim().toDoubleOrNull()?.takeIf(Double::isFinite) }
        .take(MAX_DESKTOP_STUDIO_PEAKS)
        .map { sample -> sample.coerceIn(0.0, 1.0) }
        .toList()
    val peaks = if (real.isNotEmpty()) real else desktopStudioSeedPeaks(
        context.attributeNumber("seed", 1.0).roundToInt(),
    )
    val selected = context.attributeBoolean("selected")
    val muted = context.attributeBoolean("muted")
    val tint = when {
        muted -> color("tertiary")
        selected -> color("accent")
        else -> color("secondary")
    }
    val fill = color("fill")
    Canvas(
        modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .semantics {
                stateDescription = buildString {
                    append(peaks.size).append(" waveform samples")
                    if (selected) append(", selected")
                    if (muted) append(", muted")
                }
            },
    ) {
        drawRoundRect(
            fill.copy(alpha = if (selected) 0.90f else 0.50f),
            cornerRadius = CornerRadius(8.dp.toPx()),
        )
        drawDesktopStudioWave(peaks, tint, Offset.Zero, size)
    }
}

private fun DrawScope.drawDesktopStudioWave(
    peaks: List<Double>,
    tint: Color,
    origin: Offset,
    extent: Size,
    shimmer: Float? = null,
) {
    if (peaks.isEmpty() || extent.width <= 0f || extent.height <= 0f) return
    val pad = 6.dp.toPx()
    val spacing = 2.dp.toPx()
    val target = min(peaks.size, max(8, (extent.width / 3.dp.toPx()).toInt()))
    val bars = if (target >= peaks.size) peaks else (0 until target).map { index ->
        val low = index * peaks.size / target
        val high = max(low + 1, (index + 1) * peaks.size / target)
        peaks.subList(low, min(high, peaks.size)).maxOrNull() ?: 0.0
    }
    val width = max(1f, (extent.width - pad * 2f - spacing * (bars.size - 1)) / bars.size)
    bars.forEachIndexed { index, raw ->
        val height = max(2.dp.toPx(), extent.height * 0.80f * raw.toFloat().coerceIn(0f, 1f))
        val x = origin.x + pad + index * (width + spacing)
        val center = (x - origin.x) / extent.width
        val bright = shimmer?.let { phase ->
            val distance = abs(center - phase)
            if (distance >= 0.18f) 0f else (1f - distance / 0.18f) * 0.7f
        } ?: 0f
        drawRoundRect(
            color = if (bright > 0f) Color.White.copy(alpha = bright) else tint,
            topLeft = Offset(x, origin.y + (extent.height - height) / 2f),
            size = Size(width, height),
            cornerRadius = CornerRadius(width / 2f),
        )
    }
}

private class DesktopStudioClock {
    var playhead by mutableDoubleStateOf(0.0)
    var recording by mutableStateOf(false)
    var playing by mutableStateOf(false)
    private var subscription: DSXEventSubscription? = null

    fun bind() {
        if (subscription != null) return
        subscription = DSXEvents().on("studio") { event, payload ->
            if (event != "tick") return@on
            val row = payload as? Map<*, *> ?: return@on
            val next = desktopStudioNumber(row["playhead"], playhead)
            val nextRecording = row["recording"] == true
            val nextPlaying = row["playing"] == true
            DesktopUiDispatcher.dispatch {
                if (next != playhead) playhead = next
                if (nextRecording != recording) recording = nextRecording
                if (nextPlaying != playing) playing = nextPlaying
            }
        }
    }

    fun unbind() {
        subscription?.cancel()
        subscription = null
    }
}

@Composable
private fun DesktopStudioTimecode(context: DesktopElementContext, modifier: Modifier) {
    val clock = remember { DesktopStudioClock() }
    DisposableEffect(clock) {
        clock.bind()
        onDispose { clock.unbind() }
    }
    val label = desktopStudioTimecode(clock.playhead)
    Text(
        text = label,
        modifier = modifier.semantics { stateDescription = label },
        color = if (clock.recording) Color(0xFFFF453A) else MaterialTheme.colors.onBackground,
        fontSize = context.attributeNumber("fontSize", 30.0).coerceIn(8.0, 256.0).sp,
        fontWeight = FontWeight.SemiBold,
        fontStyle = FontStyle.Italic,
        fontFamily = FontFamily.Monospace,
    )
}

@Composable
private fun DesktopStudioTimeline(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val clips = context.clips()
    val authoredTracks = context.tracks()
    val tracks = if (authoredTracks.isNotEmpty()) authoredTracks else clips.map(DesktopStudioClip::track)
        .distinct().map { DesktopStudioTrack(it, "Track", false, false, false) }
    val duration = context.attributeNumber("duration", 16.0).coerceIn(8.0, MAX_DESKTOP_STUDIO_SECONDS)
    val pixelsPerSecond = context.attributeNumber("pxPerSecond", 80.0).coerceIn(16.0, 400.0)
    var zoomMultiplier by remember(pixelsPerSecond) { mutableFloatStateOf(1f) }
    val logicalPixelsPerSecond = (pixelsPerSecond * zoomMultiplier).coerceIn(16.0, 400.0)
    val density = LocalDensity.current
    val renderPixelsPerSecond = logicalPixelsPerSecond * density.density
    val tempo = context.attributeNumber("tempo", 120.0).coerceIn(20.0, 400.0)
    val snap = context.attributeBoolean("snap", true)
    val drawMode = context.attributeBoolean("drawMode")
    val displayTracks = tracks.asReversed().take(MAX_DESKTOP_STUDIO_ROWS).ifEmpty {
        listOf(DesktopStudioTrack(0, "Track", false, false, false))
    }
    val clock = remember { DesktopStudioClock() }
    DisposableEffect(clock) {
        clock.bind()
        onDispose { clock.unbind() }
    }
    var selected by remember { mutableIntStateOf(0) }
    var scrollX by remember { mutableFloatStateOf(0f) }
    var viewport by remember { mutableStateOf(IntSize.Zero) }
    var dragMode by remember { mutableIntStateOf(0) } // 1 move, 2 trim-in, 3 trim-out, 4 scrub, 5 automation, 6 pan
    var dragClip by remember { mutableIntStateOf(0) }
    var dragStart by remember { mutableStateOf(Offset.Zero) }
    var dragDelta by remember { mutableStateOf(Offset.Zero) }
    var drawLane by remember { mutableIntStateOf(-1) }
    var drawPoints by remember { mutableStateOf<List<Offset>>(emptyList()) }
    var scrubTime by remember { mutableStateOf<Double?>(null) }
    var menuClipId by remember { mutableIntStateOf(0) }
    var menuTrackId by remember { mutableIntStateOf(0) }
    val ruler = with(density) { 28.dp.toPx() }
    val lane = with(density) { 62.dp.toPx() }
    val header = min(
        with(density) { 190.dp.toPx() },
        max(with(density) { 120.dp.toPx() }, viewport.width * 0.40f),
    )
    val headerWidth = with(density) { header.toDp() }
    val laneTop = max(ruler, viewport.height - lane * displayTracks.size)
    val contentWidth = (duration * renderPixelsPerSecond).toFloat().coerceAtMost(4_000_000f)
    val maxScroll = max(0f, header + contentWidth - viewport.width)
    scrollX = scrollX.coerceIn(0f, maxScroll)
    val selectedLabel = clips.firstOrNull { it.id == selected }?.let { "Selected clip ${it.id}" }
        ?: "${clips.size} clips on ${displayTracks.size} tracks"
    val background = color("background")
    val separator = color("separator")
    val fill = color("fill")
    val accent = color("accent")

    fun contentTime(x: Float): Double = ((x + scrollX - header) / renderPixelsPerSecond)
        .coerceIn(0.0, duration)
    fun displayLane(y: Float): Int = ((y - laneTop) / lane).toInt()
    fun clipAt(point: Offset): DesktopStudioClip? {
        if (point.x < header || point.y < laneTop) return null
        val laneIndex = displayLane(point.y)
        val track = displayTracks.getOrNull(laneIndex)?.id ?: return null
        val time = contentTime(point.x)
        return clips.lastOrNull { clip ->
            clip.track == track && time >= clip.start &&
                time <= clip.start + max(clip.duration, 12.0 / renderPixelsPerSecond)
        }
    }
    fun deselect() {
        if (selected == 0) return
        selected = 0
        context.emit("clipSelected", mapOf("id" to 0, "track" to 0, "start" to 0))
    }
    fun tap(point: Offset) {
        if (drawMode) return
        if (point.x < header) {
            val track = displayTracks.getOrNull(displayLane(point.y))
            if (track != null) {
                if (track.armed) context.emit("trackFX", mapOf("id" to track.id))
                else desktopStudioDispatch("studio.armTrack", mapOf("id" to track.id))
            } else if (point.y in (laneTop - 44f)..laneTop) {
                context.emit("addLayer", emptyMap())
            }
            return
        }
        val hit = clipAt(point)
        if (hit != null) {
            selected = hit.id
            context.emit(
                "clipSelected",
                mapOf("id" to hit.id, "track" to hit.track, "start" to hit.start),
            )
            return
        }
        val time = contentTime(point.x)
        if (point.y < ruler) {
            deselect()
            desktopStudioDispatch("studio.seek", mapOf("to" to desktopStudioSnapTime(time, tempo, snap)))
            return
        }
        val track = displayTracks.getOrNull(displayLane(point.y))
        if (track != null) {
            deselect()
            if (track.armed) context.emit("laneMenu", mapOf("track" to track.id, "at" to time))
            else desktopStudioDispatch("studio.armTrack", mapOf("id" to track.id))
        } else {
            deselect()
            desktopStudioDispatch("studio.seek", mapOf("to" to desktopStudioSnapTime(time, tempo, snap)))
        }
    }

    Box(
        modifier
            .fillMaxWidth()
            .heightIn(min = 220.dp)
            .clipToBounds()
            .background(background, RoundedCornerShape(10.dp))
            .onSizeChanged { viewport = it }
            .semantics { stateDescription = selectedLabel }
            .onPointerEvent(PointerEventType.Scroll) { event ->
                if (disabled) return@onPointerEvent
                val change = event.changes.firstOrNull() ?: return@onPointerEvent
                val delta = change.scrollDelta
                if (event.keyboardModifiers.isCtrlPressed || event.keyboardModifiers.isMetaPressed) {
                    val nextLogical = desktopStudioWheelZoom(
                        logicalPixelsPerSecond,
                        delta.y.takeIf { it != 0f } ?: delta.x,
                        16.0,
                        400.0,
                    )
                    if (nextLogical != logicalPixelsPerSecond) {
                        val cursor = change.position.x
                        val secondsAtCursor = ((scrollX + cursor - header) / renderPixelsPerSecond)
                            .coerceAtLeast(0.0)
                        val nextRender = nextLogical * density.density
                        val nextContentWidth = (duration * nextRender).toFloat().coerceAtMost(4_000_000f)
                        val nextMaximum = max(0f, header + nextContentWidth - viewport.width)
                        scrollX = (secondsAtCursor * nextRender - (cursor - header)).toFloat()
                            .coerceIn(0f, nextMaximum)
                        zoomMultiplier = (nextLogical / pixelsPerSecond).toFloat()
                        context.emit("zoom", mapOf("pxPerSecond" to nextLogical))
                    }
                    change.consume()
                } else if (maxScroll > 0f) {
                    val wheel = if (abs(delta.x) >= abs(delta.y)) delta.x else delta.y
                    scrollX = (scrollX + wheel * 48f * density.density).coerceIn(0f, maxScroll)
                    change.consume()
                }
            }
            .pointerInput(disabled, clips, scrollX, renderPixelsPerSecond, displayTracks, snap, drawMode, viewport) {
                if (!disabled) detectTapGestures(
                    onTap = ::tap,
                    onLongPress = { point ->
                        clipAt(point)?.let { clip ->
                            selected = clip.id
                            menuClipId = clip.id
                            context.emit(
                                "clipSelected",
                                mapOf("id" to clip.id, "track" to clip.track, "start" to clip.start),
                            )
                        }
                    },
                )
            }
            // scrollX is deliberately not a pointerInput key. Pan updates it for
            // every drag sample; restarting the detector on that state change would
            // cancel the gesture after its first movement. The remembered state
            // delegate remains live inside contentTime/clipAt.
            .pointerInput(disabled, clips, renderPixelsPerSecond, displayTracks, snap, drawMode, viewport) {
                if (!disabled) detectDragGestures(
                    onDragStart = { point ->
                        dragStart = point
                        dragDelta = Offset.Zero
                        val laneIndex = displayLane(point.y)
                        if (drawMode && displayTracks.getOrNull(laneIndex) != null) {
                            dragMode = 5
                            drawLane = laneIndex
                            drawPoints = emptyList()
                        } else {
                            val hit = clipAt(point)
                            if (hit != null) {
                                val wasSelected = selected == hit.id
                                selected = hit.id
                                dragClip = hit.id
                                val left = header + (hit.start * renderPixelsPerSecond).toFloat() - scrollX
                                val width = max(12f * density.density, (hit.duration * renderPixelsPerSecond).toFloat())
                                dragMode = when {
                                    wasSelected && point.x - left <= 18f -> 2
                                    wasSelected && left + width - point.x <= 18f -> 3
                                    else -> 1
                                }
                            } else if (point.y < ruler && point.x >= header) {
                                dragMode = 4
                                scrubTime = contentTime(point.x)
                            } else {
                                dragMode = 6
                            }
                        }
                    },
                    onDragCancel = {
                        dragMode = 0; dragClip = 0; dragDelta = Offset.Zero
                        drawLane = -1; drawPoints = emptyList(); scrubTime = null
                    },
                    onDragEnd = {
                        val clip = clips.firstOrNull { it.id == dragClip }
                        when (dragMode) {
                            1 -> if (clip != null) {
                                val oldLane = displayTracks.indexOfFirst { it.id == clip.track }.coerceAtLeast(0)
                                val nextLane = (oldLane + (dragDelta.y / lane).roundToInt())
                                    .coerceIn(0, displayTracks.lastIndex)
                                desktopStudioDispatch(
                                    "studio.moveClip",
                                    mapOf(
                                        "id" to clip.id,
                                        "track" to displayTracks[nextLane].id,
                                        "start" to desktopStudioSnapTime(
                                            clip.start + dragDelta.x / renderPixelsPerSecond,
                                            tempo,
                                            snap,
                                        ),
                                    ),
                                )
                            }
                            2 -> if (clip != null) {
                                val commit = desktopStudioTrimStart(
                                    clip,
                                    dragDelta.x / renderPixelsPerSecond,
                                    tempo,
                                    snap,
                                )
                                desktopStudioDispatch(
                                    "studio.trimClip",
                                    mapOf(
                                        "id" to clip.id,
                                        "sourceStart" to commit.sourceStart,
                                        "duration" to commit.duration,
                                        "start" to commit.start,
                                    ),
                                )
                            }
                            3 -> if (clip != null) {
                                val commit = desktopStudioTrimEnd(
                                    clip,
                                    dragDelta.x / renderPixelsPerSecond,
                                    tempo,
                                    snap,
                                )
                                desktopStudioDispatch(
                                    "studio.trimClip",
                                    mapOf(
                                        "id" to clip.id,
                                        "sourceStart" to commit.sourceStart,
                                        "duration" to commit.duration,
                                        "start" to commit.start,
                                    ),
                                )
                            }
                            4 -> scrubTime?.let { desktopStudioDispatch("studio.seek", mapOf("to" to it)) }
                            5 -> if (drawLane in displayTracks.indices && drawPoints.size >= 2) {
                                val points = drawPoints.sortedBy(Offset::x).flatMap { point ->
                                    listOf(
                                        contentTime(point.x),
                                        (1.0 - ((point.y - (laneTop + drawLane * lane + 4f)) / (lane - 8f)))
                                            .coerceIn(0.0, 1.0),
                                    )
                                }
                                desktopStudioDispatch(
                                    "studio.setTrackAutomation",
                                    mapOf("id" to displayTracks[drawLane].id, "points" to points),
                                )
                            }
                        }
                        dragMode = 0; dragClip = 0; dragDelta = Offset.Zero
                        drawLane = -1; drawPoints = emptyList(); scrubTime = null
                    },
                    onDrag = { change, delta ->
                        change.consume()
                        dragDelta += delta
                        when (dragMode) {
                            4 -> scrubTime = contentTime(change.position.x)
                            5 -> if (drawPoints.size < 2_048) {
                                val next = change.position
                                drawPoints = if (drawPoints.lastOrNull()?.let { abs(it.x - next.x) < 4f } == true) {
                                    drawPoints.dropLast(1) + next
                                } else drawPoints + next
                            }
                            6 -> scrollX = (scrollX - delta.x).coerceIn(0f, maxScroll)
                        }
                    },
                )
            },
    ) {
        Canvas(Modifier.fillMaxSize()) {
            drawRect(background)
            val pxPerBeat = (renderPixelsPerSecond * 60.0 / tempo).toFloat().coerceAtLeast(4f)
            val firstBeat = floor(scrollX / pxPerBeat).toInt().coerceAtLeast(0)
            val beatCount = min(10_000, (size.width / pxPerBeat).toInt() + 3)
            repeat(beatCount) { offset ->
                val beat = firstBeat + offset
                val x = header + beat * pxPerBeat - scrollX
                drawLine(
                    color = if (beat % 4 == 0) separator else fill,
                    start = Offset(x, 0f),
                    end = Offset(x, size.height),
                    strokeWidth = if (beat % 4 == 0) 1.5f else 1f,
                )
            }
            drawRect(fill.copy(alpha = 0.45f), Offset(0f, 0f), Size(header, size.height))
            drawLine(separator, Offset(0f, ruler), Offset(size.width, ruler), 1f)
            displayTracks.forEachIndexed { index, track ->
                val top = laneTop + index * lane
                if (track.armed) drawRect(accent.copy(alpha = 0.10f), Offset(0f, top), Size(size.width, lane))
                if (track.muted) drawRect(Color.Black.copy(alpha = 0.18f), Offset(header, top), Size(size.width - header, lane))
                drawLine(separator, Offset(0f, top + lane), Offset(size.width, top + lane), 1f)
            }
            clips.forEach { clip ->
                val trackIndex = displayTracks.indexOfFirst { it.id == clip.track }
                if (trackIndex < 0 || clip.duration <= 0.0) return@forEach
                var start = clip.start
                var durationPreview = clip.duration
                var trackPreview = clip.track
                if (clip.id == dragClip) when (dragMode) {
                    1 -> {
                        start = max(0.0, clip.start + dragDelta.x / renderPixelsPerSecond)
                        val lanePreview = (trackIndex + (dragDelta.y / lane).roundToInt())
                            .coerceIn(0, displayTracks.lastIndex)
                        trackPreview = displayTracks[lanePreview].id
                    }
                    2 -> desktopStudioTrimStart(clip, dragDelta.x / renderPixelsPerSecond, tempo, snap).let {
                        start = it.start; durationPreview = it.duration
                    }
                    3 -> desktopStudioTrimEnd(clip, dragDelta.x / renderPixelsPerSecond, tempo, snap).let {
                        durationPreview = it.duration
                    }
                }
                val previewTrackIndex = displayTracks.indexOfFirst { it.id == trackPreview }
                val left = header + (start * renderPixelsPerSecond).toFloat() - scrollX
                val width = max(12f * density.density, (durationPreview * renderPixelsPerSecond).toFloat())
                if (left > size.width || left + width < 0f) return@forEach
                val top = laneTop + previewTrackIndex * lane + 6f
                val extent = Size(width, lane - 12f)
                drawRoundRect(
                    color = accent.copy(alpha = if (clip.id == selected) 0.90f else 0.55f),
                    topLeft = Offset(left, top),
                    size = extent,
                    cornerRadius = CornerRadius(8f),
                )
                val waveform = if (clip.peaks.isEmpty()) desktopStudioSeedPeaks(clip.id, 32) else clip.peaks
                drawDesktopStudioWave(waveform, Color.White.copy(alpha = 0.82f), Offset(left, top), extent)
            }
            val playhead = scrubTime ?: clock.playhead
            val playheadX = header + (playhead * renderPixelsPerSecond).toFloat() - scrollX
            if (playheadX in 0f..size.width) {
                drawLine(accent, Offset(playheadX, 0f), Offset(playheadX, size.height), 2f)
            }
            if (drawLane in displayTracks.indices && drawPoints.size >= 2) {
                for (index in 1 until drawPoints.size) {
                    drawLine(Color.Yellow, drawPoints[index - 1], drawPoints[index], 2f, StrokeCap.Round)
                }
            }
        }
        Column(
            Modifier.align(Alignment.BottomStart).width(headerWidth),
        ) {
            Box(
                Modifier.fillMaxWidth().height(44.dp)
                    .clickable(enabled = !disabled) { context.emit("addLayer", emptyMap()) }
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text("+ Add Layer", color = accent, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            displayTracks.forEach { track ->
                Column(
                    Modifier.fillMaxWidth().height(62.dp)
                        .combinedClickable(
                            enabled = !disabled,
                            onClick = {
                                if (track.armed) context.emit("trackFX", mapOf("id" to track.id))
                                else desktopStudioDispatch("studio.armTrack", mapOf("id" to track.id))
                            },
                            onLongClick = { menuTrackId = track.id },
                        )
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(
                        track.name.ifBlank { "Track ${track.id}" },
                        color = if (track.armed) accent else MaterialTheme.colors.onBackground,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                    )
                    if (track.muted || track.solo) Text(
                        if (track.muted) "Muted" else "Solo",
                        color = color("secondary"),
                        fontSize = 10.sp,
                    )
                }
            }
        }
        val menuClip = clips.firstOrNull { it.id == menuClipId }
        DropdownMenu(
            expanded = menuClip != null,
            onDismissRequest = { menuClipId = 0 },
        ) {
            if (menuClip != null) {
                DropdownMenuItem(onClick = {
                    context.emit("trackFX", mapOf("id" to menuClip.track)); menuClipId = 0
                }) { Text("FX & Volume") }
                DropdownMenuItem(onClick = {
                    context.emit(
                        "timeShift",
                        mapOf("id" to menuClip.id, "track" to menuClip.track, "start" to menuClip.start),
                    ); menuClipId = 0
                }) { Text("Time Shift") }
                DropdownMenuItem(onClick = {
                    desktopStudioDispatch("studio.copyClip", mapOf("id" to menuClip.id)); menuClipId = 0
                }) { Text("Copy") }
                DropdownMenuItem(onClick = {
                    desktopStudioDispatch(
                        "studio.pasteClip",
                        mapOf("track" to menuClip.track, "at" to menuClip.start + menuClip.duration),
                    ); menuClipId = 0
                }) { Text("Paste") }
                DropdownMenuItem(onClick = {
                    desktopStudioDispatch("studio.deleteClip", mapOf("id" to menuClip.id)); menuClipId = 0
                }) { Text("Remove", color = Color(0xFFFF453A)) }
            }
        }
        val menuTrack = tracks.firstOrNull { it.id == menuTrackId }
        DropdownMenu(
            expanded = menuTrack != null,
            onDismissRequest = { menuTrackId = 0 },
        ) {
            if (menuTrack != null) {
                DropdownMenuItem(onClick = {
                    context.emit("trackFX", mapOf("id" to menuTrack.id)); menuTrackId = 0
                }) { Text("Track settings") }
                DropdownMenuItem(
                    enabled = tracks.size > 1,
                    onClick = {
                        desktopStudioDispatch("studio.deleteTrack", mapOf("id" to menuTrack.id)); menuTrackId = 0
                    },
                ) { Text("Delete track", color = Color(0xFFFF453A)) }
            }
        }
    }
}

@Composable
private fun DesktopStudioTrim(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val clips = context.clips()
    val clipId = context.attributeNumber("clip", 0.0).roundToInt()
    val clip = clips.firstOrNull { it.id == clipId }
    if (clip == null || clip.sourceDuration <= 0.0) {
        Box(modifier.fillMaxWidth().heightIn(min = 180.dp), contentAlignment = Alignment.Center) {
            Text("Select a clip on the timeline to trim.", color = color("secondary"))
        }
        return
    }
    val tempo = context.attributeNumber("tempo", 120.0).coerceIn(20.0, 400.0)
    val snap = context.attributeBoolean("snap", false)
    var preview by remember(clip.id, clip.sourceStart, clip.duration, clip.start, clip.sourceDuration) {
        mutableStateOf(DesktopStudioTrimCommit(clip.sourceStart, clip.duration, clip.start))
    }
    var width by remember { mutableFloatStateOf(1f) }
    var dragSide by remember { mutableIntStateOf(0) }
    var dragPixels by remember { mutableFloatStateOf(0f) }
    val start = preview.sourceStart
    val end = (preview.sourceStart + preview.duration).coerceAtMost(clip.sourceDuration)
    val visiblePeaks = desktopStudioPeakWindow(clip.peaks, clip.sourceDuration, start, end)
    val fill = color("fill")
    val accent = color("accent")
    val secondary = color("secondary")
    Column(
        modifier.fillMaxWidth().heightIn(min = 220.dp).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Canvas(
            Modifier.fillMaxWidth().height(116.dp)
                .background(fill.copy(alpha = 0.45f), RoundedCornerShape(14.dp)),
        ) { drawDesktopStudioWave(visiblePeaks, accent, Offset.Zero, size) }
        Canvas(
            Modifier.fillMaxWidth().height(64.dp).onSizeChanged { width = it.width.toFloat().coerceAtLeast(1f) }
                .pointerInput(disabled, clip, width, tempo, snap) {
                    if (!disabled) detectDragGestures(
                        onDragStart = { point ->
                            val left = (clip.sourceStart / clip.sourceDuration * width).toFloat()
                            val right = ((clip.sourceStart + clip.duration) / clip.sourceDuration * width).toFloat()
                            dragSide = when {
                                abs(point.x - left) <= 28f -> -1
                                abs(point.x - right) <= 28f -> 1
                                else -> 0
                            }
                            dragPixels = 0f
                        },
                        onDrag = { change, delta ->
                            if (dragSide == 0) return@detectDragGestures
                            change.consume()
                            dragPixels += delta.x
                            val seconds = dragPixels / width * clip.sourceDuration
                            preview = if (dragSide < 0) {
                                desktopStudioTrimStart(clip, seconds, tempo, snap)
                            } else desktopStudioTrimEnd(clip, seconds, tempo, snap)
                        },
                        onDragEnd = {
                            if (dragSide != 0) desktopStudioDispatch(
                                "studio.trimClip",
                                mapOf(
                                    "id" to clip.id,
                                    "sourceStart" to preview.sourceStart,
                                    "duration" to preview.duration,
                                    "start" to preview.start,
                                ),
                            )
                            dragSide = 0
                            dragPixels = 0f
                        },
                        onDragCancel = {
                            preview = DesktopStudioTrimCommit(clip.sourceStart, clip.duration, clip.start)
                            dragSide = 0
                            dragPixels = 0f
                        },
                    )
                },
        ) {
            drawRoundRect(fill.copy(alpha = 0.40f), cornerRadius = CornerRadius(9.dp.toPx()))
            drawDesktopStudioWave(clip.peaks, secondary, Offset.Zero, size)
            val left = (start / clip.sourceDuration * size.width).toFloat()
            val right = (end / clip.sourceDuration * size.width).toFloat()
            drawRoundRect(
                accent.copy(alpha = 0.24f),
                topLeft = Offset(left, 0f),
                size = Size(max(6.dp.toPx(), right - left), size.height),
                cornerRadius = CornerRadius(6.dp.toPx()),
            )
            drawLine(Color.White, Offset(left, 6.dp.toPx()), Offset(left, size.height - 6.dp.toPx()), 5.dp.toPx(), StrokeCap.Round)
            drawLine(Color.White, Offset(right, 6.dp.toPx()), Offset(right, size.height - 6.dp.toPx()), 5.dp.toPx(), StrokeCap.Round)
        }
        Text(
            String.format(java.util.Locale.US, "%.1f s of %.1f s kept", end - start, clip.sourceDuration),
            modifier = Modifier.fillMaxWidth(),
            color = secondary,
            fontSize = 12.sp,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun DesktopStudioPitchEditor(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val notes = context.notes()
    val scale = desktopPitchClasses(context.attributeString("musicScale", "chromatic"))
    val root = desktopKeyRoot(context.attributeString("musicKey", "C"))
    val snap = context.attributeBoolean("snapToKey", true)
    val trackId = context.attributeNumber("trackId", 0.0).roundToInt()
    val density = LocalDensity.current
    val high = ((notes.maxOfOrNull { max(it.detectedMidi, it.targetMidi) } ?: 71.0).roundToInt() + 2).coerceAtMost(127)
    val low = ((notes.minOfOrNull { min(it.detectedMidi, it.targetMidi) } ?: 55.0).roundToInt() - 2).coerceAtLeast(0)
    val rows = max(8, high - low + 1)
    val duration = max(1.0, (notes.maxOfOrNull { it.start + it.duration } ?: 6.0) + 0.5)
    var zoom by remember { mutableFloatStateOf(1f) }
    var selected by remember { mutableIntStateOf(0) }
    var viewport by remember { mutableStateOf(IntSize.Zero) }
    var scrollX by remember { mutableFloatStateOf(0f) }
    var dragMode by remember { mutableIntStateOf(0) } // 1 retune, 2 scroll
    var dragId by remember { mutableIntStateOf(0) }
    var dragStartTarget by remember { mutableDoubleStateOf(0.0) }
    var dragTarget by remember { mutableDoubleStateOf(0.0) }
    var dragTotal by remember { mutableStateOf(Offset.Zero) }
    val clock = remember { DesktopStudioClock() }
    DisposableEffect(clock) {
        clock.bind()
        onDispose { clock.unbind() }
    }
    val gutter = with(density) { 46.dp.toPx() }
    val ruler = with(density) { 20.dp.toPx() }
    val canvasWidth = max(1f, viewport.width - gutter)
    val rowHeight = (max(1f, viewport.height - ruler) / rows).coerceIn(
        with(density) { 10.dp.toPx() },
        with(density) { 38.dp.toPx() },
    )
    val fitPps = canvasWidth / duration
    val pps = fitPps * zoom
    val maxScroll = max(0f, (duration * pps).toFloat() - canvasWidth)
    scrollX = scrollX.coerceIn(0f, maxScroll)
    val background = color("background")
    val accent = color("accent")
    val separator = color("separator")

    fun noteAt(point: Offset): DesktopStudioNote? {
        if (point.x < gutter || point.y < ruler) return null
        val time = (point.x - gutter + scrollX) / pps
        val midi = high - ((point.y - ruler) / rowHeight)
        return notes.asSequence().filter { note ->
            val padding = max(0.0, (22.0 - note.duration * pps) / 2.0) / max(1.0, pps)
            time >= note.start - padding && time <= note.start + note.duration + padding &&
                abs(note.targetMidi - midi) < 1.4
        }.minByOrNull { note -> abs(note.targetMidi - midi) }
    }

    Canvas(
        modifier.fillMaxWidth().heightIn(min = 260.dp).clipToBounds().onSizeChanged { viewport = it }
            .semantics { stateDescription = "${notes.size} pitch notes, ${String.format(java.util.Locale.US, "%.2f", zoom)}x zoom" }
            .onPointerEvent(PointerEventType.Scroll) { event ->
                if (disabled) return@onPointerEvent
                val change = event.changes.firstOrNull() ?: return@onPointerEvent
                val delta = change.scrollDelta
                if (event.keyboardModifiers.isCtrlPressed || event.keyboardModifiers.isMetaPressed) {
                    val nextZoom = desktopStudioWheelZoom(
                        zoom.toDouble(),
                        delta.y.takeIf { it != 0f } ?: delta.x,
                        1.0,
                        16.0,
                    ).toFloat()
                    if (nextZoom != zoom) {
                        val rollX = (change.position.x - gutter).coerceAtLeast(0f)
                        val secondsAtCursor = (scrollX + rollX) / pps
                        val nextPps = fitPps * nextZoom
                        val nextMaximum = max(0f, (duration * nextPps).toFloat() - canvasWidth)
                        scrollX = (secondsAtCursor * nextPps - rollX).toFloat().coerceIn(0f, nextMaximum)
                        zoom = nextZoom
                    }
                    change.consume()
                } else if (maxScroll > 0f) {
                    val wheel = if (abs(delta.x) >= abs(delta.y)) delta.x else delta.y
                    scrollX = (scrollX + wheel * 48f * density.density).coerceIn(0f, maxScroll)
                    change.consume()
                }
            }
            .pointerInput(disabled, notes, viewport, high, rowHeight, pps, scrollX) {
                if (!disabled) detectTapGestures(
                    onDoubleTap = { zoom = 1f; scrollX = 0f },
                    onTap = { point -> noteAt(point)?.let { selected = it.id } },
                )
            }
            // As above, scrollX is mutable during a pan and must not restart the
            // recognizer which is producing that pan.
            .pointerInput(disabled, notes, viewport, high, rowHeight, pps, snap, trackId) {
                if (!disabled) detectDragGestures(
                    onDragStart = { point ->
                        dragTotal = Offset.Zero
                        val hit = noteAt(point)
                        if (hit == null) {
                            dragMode = 2
                        } else {
                            dragMode = 1
                            dragId = hit.id
                            dragStartTarget = hit.targetMidi
                            dragTarget = hit.targetMidi
                            selected = hit.id
                        }
                    },
                    onDrag = { change, delta ->
                        change.consume()
                        dragTotal += delta
                        if (dragMode == 1) {
                            dragTarget = desktopStudioSnapMidi(
                                dragStartTarget - dragTotal.y / rowHeight,
                                root,
                                scale,
                                snap,
                            )
                        } else if (dragMode == 2) {
                            scrollX = (scrollX - delta.x).coerceIn(0f, maxScroll)
                        }
                    },
                    onDragEnd = {
                        if (dragMode == 1 && dragId != 0) desktopStudioDispatch(
                            "studio.setNoteTarget",
                            mapOf("id" to trackId, "noteId" to dragId, "targetMidi" to dragTarget),
                        )
                        dragMode = 0; dragId = 0; dragTotal = Offset.Zero
                    },
                    onDragCancel = {
                        dragMode = 0; dragId = 0; dragTotal = Offset.Zero
                    },
                )
            },
    ) {
        drawRect(background)
        repeat(rows) { index ->
            val midi = high - index
            val y = ruler + index * rowHeight
            val pitchClass = ((midi - root) % 12 + 12) % 12
            if (pitchClass in scale) drawRect(
                accent.copy(alpha = 0.06f),
                Offset(gutter, y),
                Size(size.width - gutter, rowHeight),
            )
            val black = midi % 12 in setOf(1, 3, 6, 8, 10)
            drawRect(
                if (black) Color.Black.copy(alpha = 0.55f) else Color.White.copy(alpha = 0.08f),
                Offset(0f, y),
                Size(gutter, rowHeight),
            )
            drawLine(separator.copy(alpha = 0.35f), Offset(0f, y), Offset(size.width, y), 1f)
        }
        repeat(min(10_000, duration.toInt() + 2)) { second ->
            val x = gutter + second * pps.toFloat() - scrollX
            drawLine(separator.copy(alpha = 0.5f), Offset(x, 0f), Offset(x, size.height), 1f)
        }
        notes.forEach { note ->
            val target = if (note.id == dragId && dragMode == 1) dragTarget else note.targetMidi
            val left = gutter + (note.start * pps).toFloat() - scrollX
            val top = ruler + (high - target).toFloat() * rowHeight + rowHeight * 0.14f
            val width = max(5f, (note.duration * pps).toFloat())
            val height = rowHeight * 0.72f
            if (note.detectedMidi != target) {
                val ghostY = ruler + (high - note.detectedMidi).toFloat() * rowHeight + rowHeight * 0.34f
                drawRoundRect(
                    accent.copy(alpha = 0.35f),
                    Offset(left, ghostY),
                    Size(width, rowHeight * 0.32f),
                    CornerRadius(4f),
                )
                drawLine(accent.copy(alpha = 0.45f), Offset(left, ghostY), Offset(left, top), 1f)
            }
            drawRoundRect(
                if (note.id == selected) Color.White else accent,
                Offset(left, top),
                Size(width, height),
                CornerRadius(5f),
                style = if (note.id == selected) Stroke(1.2f) else androidx.compose.ui.graphics.drawscope.Fill,
            )
        }
        // Show the snapped key at the gutter edge; this is a visual truth marker,
        // not a fake editing claim. Actual retune commits require the studio package.
        if (snap) drawLine(accent, Offset(gutter - 3f, ruler), Offset(gutter - 3f, size.height), 3f)
        val playheadX = gutter + (clock.playhead * pps).toFloat() - scrollX
        if (playheadX in gutter..size.width) {
            drawLine(accent.copy(alpha = 0.85f), Offset(playheadX, ruler), Offset(playheadX, size.height), 1.5f)
        }
    }
}

@Composable
private fun DesktopStudioShow(context: DesktopElementContext, modifier: Modifier) {
    val track = context.attributeNumber("track", 0.0).roundToInt()
    val peaks = context.clips().filter { it.track == track }.sortedBy(DesktopStudioClip::start).flatMap { it.peaks }
        .take(MAX_DESKTOP_STUDIO_PEAKS).ifEmpty { desktopStudioSeedPeaks(track + 1, 64) }
    val reduceMotion = desktopCssEnvironment().reduceMotion
    val secondary = color("secondary")
    val clock = remember { DesktopStudioShowClock() }
    DisposableEffect(clock, track) {
        clock.bind(track)
        onDispose { clock.unbind() }
    }
    val phase = if (reduceMotion) 0.5f else {
        val motion = rememberInfiniteTransition(label = "dsx-studio-show")
        val value by motion.animateFloat(
            initialValue = -0.2f,
            targetValue = 1.2f,
            animationSpec = infiniteRepeatable(tween(1_500, easing = LinearEasing), RepeatMode.Restart),
            label = "dsx-studio-show-shimmer",
        )
        value
    }
    Row(
        modifier.fillMaxWidth().heightIn(min = 56.dp)
            .background(color("fill").copy(alpha = 0.35f), RoundedCornerShape(14.dp))
            .border(
                if (clock.terminal) 2.dp else 0.dp,
                color("accent").copy(alpha = if (clock.terminal) 0.95f else 0f),
                RoundedCornerShape(14.dp),
            )
            .semantics {
                stateDescription = if (clock.terminal) "Studio processing complete" else "Studio processing"
            }
            .padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            when (context.attributeString("kind", "tune")) {
                "eq" -> "EQ"
                "comp" -> "COMP"
                "master" -> "MASTER"
                else -> "TUNE"
            },
            color = color("accent"),
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
        )
        Canvas(Modifier.weight(1f).fillMaxSize()) {
            drawDesktopStudioWave(peaks, secondary, Offset.Zero, size, phase)
        }
    }
}

private class DesktopStudioShowClock {
    var terminal by mutableStateOf(false)
    private var subscription: DSXEventSubscription? = null

    fun bind(track: Int) {
        unbind()
        terminal = false
        subscription = DSXEvents().on("studio") { event, payload ->
            if (event != "show") return@on
            val row = payload as? Map<*, *> ?: return@on
            if (desktopStudioNumber(row["track"]).roundToInt() != track) return@on
            val next = row["terminal"] == true
            DesktopUiDispatcher.dispatch { terminal = next }
        }
    }

    fun unbind() {
        subscription?.cancel()
        subscription = null
    }
}
