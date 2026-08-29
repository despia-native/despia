@file:OptIn(
    androidx.compose.foundation.ExperimentalFoundationApi::class,
    androidx.compose.ui.ExperimentalComposeUiApi::class,
)

package despia.engine.desktop

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.Button
import androidx.compose.material.Checkbox
import androidx.compose.material.CheckboxDefaults
import androidx.compose.material.CircularProgressIndicator
import androidx.compose.material.Divider
import androidx.compose.material.DropdownMenu
import androidx.compose.material.DropdownMenuItem
import androidx.compose.material.LinearProgressIndicator
import androidx.compose.material.MaterialTheme
import androidx.compose.material.OutlinedTextField
import androidx.compose.material.RadioButton
import androidx.compose.material.RadioButtonDefaults
import androidx.compose.material.Surface
import androidx.compose.material.Text
import androidx.compose.material.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogWindow
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import despia.engine.JSE
import despia.engine.LayoutSemantics
import despia.engine.NSNull
import despia.engine.SplitPlan
import despia.engine.StackNode
import despia.engine.InkCore
import despia.engine.getPath
import despia.engine.setPath
import despia.engine.varsFlow
import despia.engine.writeBound
import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.OpenOption
import java.nio.file.Path as NioPath
import java.nio.file.StandardOpenOption
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalTime
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.format.TextStyle
import java.time.temporal.WeekFields
import java.util.IdentityHashMap
import java.util.Locale
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Canonical DSX tags with a first-party Compose Desktop implementation. Keeping this
 * list executable prevents a tag from being counted merely because its spelling appears
 * in a comment or a fallback branch. */
internal val desktopStudioNativeTags: Set<String> = linkedSetOf(
    "StudioPitchEditor", "StudioShow", "StudioTimecode", "StudioTimeline", "StudioTrim", "Waveform",
)

internal val desktopExtendedNativeTags: Set<String> = linkedSetOf(
    "Accordion", "ChatBubble", "Checkbox", "Drawer", "LevelMeter", "MenuBar",
    "ProgressRing", "RadioGroup", "Signature", "Skeleton", "Table", "calendar", "carousel",
    "contextmenu", "datepicker", "field", "lightbox", "menu", "otp", "pager",
    "popover", "rangeslider", "searchbar", "split", "stars", "wheelpicker",
) + desktopStudioNativeTags

internal val desktopExtendedFocusableTags: Set<String> = setOf(
    "Checkbox", "carousel", "contextmenu", "menu", "pager", "rangeslider",
    "searchbar", "wheelpicker",
) + setOf("StudioPitchEditor", "StudioTimeline", "StudioTrim")

internal const val MAX_DESKTOP_TABLE_ROWS = 10_000
internal const val MAX_DESKTOP_TABLE_COLUMNS = 128
// The `<Signature>` pad's own chrome, mirroring :render ElementDefaults.SIGNATURE_* (the ink
// law it draws with lives in :core InkCore, shared with every other renderer).
internal const val SIGNATURE_PAD_HEIGHT = 180.0
internal const val SIGNATURE_PAD_RADIUS = 12.0
internal const val SIGNATURE_PAD_BORDER = 1.0
internal const val SIGNATURE_PAD_BASELINE_INSET = 24.0
internal const val SIGNATURE_PAD_BASELINE_BOTTOM = 36.0
internal const val SIGNATURE_PAD_PLACEHOLDER_FONT = 15.0
internal const val SIGNATURE_PAD_INK = "label"
internal const val SIGNATURE_PAD_RULE = "separator"
internal const val SIGNATURE_PAD_PLACEHOLDER = "secondary"
internal const val MAX_DESKTOP_SIGNATURE_STROKES = 2_000
internal const val MAX_DESKTOP_SIGNATURE_POINTS = 20_000
internal const val MAX_DESKTOP_OTP_LENGTH = 32
internal const val MAX_DESKTOP_STAR_COUNT = 20
internal const val MAX_DESKTOP_BOUND_ROWS = 10_000
private const val MAX_DESKTOP_OPTIONS = 1_024
private const val MAX_DESKTOP_PAGES = 1_000
private const val MAX_DESKTOP_MENU_ITEMS = 512
private const val MAX_DESKTOP_MENU_DEPTH = 16
private const val MAX_DESKTOP_CSV_CHARS = 65_536
private const val MAX_DESKTOP_CELL_CHARS = 4_096
private const val MAX_DESKTOP_LOCAL_IMAGE_BYTES = 8L * 1024L * 1024L
private const val MAX_DESKTOP_AUTHORED_SCALAR = 1_000_000_000.0

@Composable
internal fun DesktopExtendedElement(
    context: DesktopElementContext,
    modifier: Modifier,
    disabled: Boolean,
) {
    if (context.node.tag in desktopStudioNativeTags) {
        DesktopStudioElement(context, modifier, disabled)
        return
    }
    when (context.node.tag) {
        "Accordion" -> DesktopAccordion(context, modifier, disabled)
        "ChatBubble" -> DesktopChatBubble(context, modifier)
        "Checkbox" -> DesktopCanonicalCheckbox(context, modifier, disabled)
        "Drawer" -> DesktopDrawer(context, modifier, disabled)
        "LevelMeter" -> DesktopLevelMeter(context, modifier)
        "MenuBar" -> DesktopMenuBar(context, modifier, disabled)
        "ProgressRing" -> DesktopProgressRing(context, modifier)
        "RadioGroup" -> DesktopRadioGroup(context, modifier, disabled)
        "Signature" -> DesktopSignature(context, modifier, disabled)
        "Skeleton" -> DesktopSkeleton(context, modifier)
        "Table" -> DesktopTable(context, modifier)
        "calendar" -> DesktopCalendar(context, modifier, disabled)
        "carousel" -> DesktopPager(context, modifier, disabled, dataBound = false)
        "contextmenu" -> DesktopMenu(context, modifier, disabled, longPress = true)
        "datepicker" -> DesktopDatePicker(context, modifier, disabled)
        "field" -> DesktopField(context, modifier, disabled)
        "lightbox" -> DesktopLightbox(context, modifier, disabled)
        "menu" -> DesktopMenu(context, modifier, disabled, longPress = false)
        "otp" -> DesktopOtp(context, modifier, disabled)
        "pager" -> DesktopPager(context, modifier, disabled, dataBound = true)
        "popover" -> DesktopPopover(context, modifier, disabled)
        "rangeslider" -> DesktopRangeSlider(context, modifier, disabled)
        "searchbar" -> DesktopSearchBar(context, modifier, disabled)
        "split" -> DesktopSplit(context, modifier, disabled)
        "stars" -> DesktopStars(context, modifier, disabled)
        "wheelpicker" -> DesktopWheelPicker(context, modifier, disabled)
    }
}

private fun DesktopElementContext.bound(key: String): Any? =
    key.takeIf(String::isNotBlank)?.let { JSE.eval(it, store, item) }

private fun valuesEqual(left: Any?, right: Any?): Boolean = when {
    left is Number && right is Number -> left.toDouble() == right.toDouble()
    left === NSNull && right == null -> true
    else -> left == right
}

private fun DesktopElementContext.write(key: String, value: Any, event: String = "on:change") {
    if (key.isBlank() || valuesEqual(bound(key), value)) return
    store.writeBound(key, value)
    attributes[event]?.let { run(it, mapOf("value" to value)) }
}

private fun DesktopElementContext.fire(event: String, arguments: Map<String, Any?> = emptyMap()) {
    attributes["on:$event"]?.let { run(it, arguments) }
}

private fun DesktopElementContext.bool(name: String, default: Boolean = false): Boolean {
    val raw = attributes[name] ?: return default
    return JSE.truthy(JSE.eval(raw, store, item))
}

private fun DesktopElementContext.num(name: String, default: Double): Double {
    val raw = attributes[name] ?: return default
    val fallback = default.takeIf(Double::isFinite)?.coerceIn(-MAX_DESKTOP_AUTHORED_SCALAR, MAX_DESKTOP_AUTHORED_SCALAR) ?: 0.0
    return (JSE.number(JSE.eval(raw, store, item)) ?: raw.toDoubleOrNull())
        ?.takeIf(Double::isFinite)
        ?.coerceIn(-MAX_DESKTOP_AUTHORED_SCALAR, MAX_DESKTOP_AUTHORED_SCALAR)
        ?: fallback
}

private fun DesktopElementContext.textValue(key: String): String {
    val raw = bound(key)
    return if (raw == null || raw === NSNull) "" else JSE.string(raw)
}

private fun csv(raw: String?, limit: Int = MAX_DESKTOP_OPTIONS): List<String> =
    raw.orEmpty().take(MAX_DESKTOP_CSV_CHARS).splitToSequence(',')
        .map(String::trim).filter(String::isNotEmpty).take(limit.coerceIn(0, MAX_DESKTOP_BOUND_ROWS)).toList()

internal fun desktopOtpClamp(raw: String, length: Int): String =
    raw.filter(Char::isDigit).take(length.coerceAtLeast(1))

internal fun desktopRangeValue(raw: Double, min: Double, max: Double, step: Double?): Double {
    if (!min.isFinite() || !max.isFinite()) return 0.0
    if (!raw.isFinite()) return min.coerceAtMost(max)
    val lo = min.coerceAtMost(max)
    val hi = max.coerceAtLeast(min)
    val clamped = raw.coerceIn(lo, hi)
    val snapped = step?.takeIf { it.isFinite() && it > 0.0 }
        ?.let { lo + (kotlin.math.round((clamped - lo) / it) * it) } ?: clamped
    return snapped.coerceIn(lo, hi)
}

internal fun desktopParseDay(raw: String?): LocalDate? {
    val value = raw?.trim().orEmpty()
    if (value.length < 10) return null
    return try { LocalDate.parse(value.take(10), DateTimeFormatter.ISO_LOCAL_DATE) }
    catch (_: DateTimeParseException) { null }
}

internal fun desktopMonthCells(month: YearMonth, firstDay: DayOfWeek): List<LocalDate?> {
    val leading = (month.atDay(1).dayOfWeek.value - firstDay.value + 7) % 7
    val cells = MutableList<LocalDate?>(leading) { null }
    (1..month.lengthOfMonth()).forEach { cells += month.atDay(it) }
    while (cells.size % 7 != 0) cells += null
    return cells
}

private fun DesktopElementContext.options(): List<Pair<String, String>> {
    attributes["optionsKey"]?.let { expression ->
        val idField = attributes["valueField"] ?: "id"
        val labelField = attributes["labelField"] ?: "label"
        return desktopBoundedRows(JSE.eval(expression, store, item), MAX_DESKTOP_OPTIONS).mapNotNull { row ->
            val id = row[idField]?.let(JSE::string)?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
            id to (row[labelField]?.let(JSE::string) ?: id)
        }
    }
    return csv(attributes["options"]).map { it to it }
}

internal fun desktopBoundedRows(value: Any?, limit: Int = MAX_DESKTOP_BOUND_ROWS): List<Map<String, Any?>> {
    val source = value as? List<*> ?: return emptyList()
    val inspected = minOf(source.size, limit.coerceIn(0, MAX_DESKTOP_BOUND_ROWS + 1))
    return buildList(inspected) {
        for (index in 0 until inspected) {
            @Suppress("UNCHECKED_CAST")
            (source[index] as? Map<String, Any?>)?.let(::add)
        }
    }
}

private fun DesktopElementContext.rows(
    expressionName: String,
    limit: Int = MAX_DESKTOP_BOUND_ROWS,
): List<Map<String, Any?>> = attributes[expressionName]
    ?.let { desktopBoundedRows(JSE.eval(it, store, item), limit) }
    .orEmpty()

internal data class DesktopLocalImagePayload(val bytes: ByteArray, val contentType: String)

/** Reads only from an explicitly granted app asset root. The path is resolved through
 * the real filesystem, the selected file may not be a symlink, and pre/post identity
 * checks close the ordinary path-swap window. Bundled classpath assets use the separate
 * loader below; an arbitrary authored absolute/file URL is never ambient authority. */
internal fun readDesktopLocalImage(source: String, grantedRoot: NioPath?): DesktopLocalImagePayload? {
    val trimmed = source.trim()
    if (trimmed.isEmpty() || trimmed.length > 4_096 || grantedRoot == null) return null
    return runCatching {
        val realRoot = grantedRoot.toRealPath()
        if (!Files.isDirectory(realRoot, LinkOption.NOFOLLOW_LINKS)) return@runCatching null
        val requested = when {
            trimmed.startsWith("file:", ignoreCase = true) -> NioPath.of(URI(trimmed))
            Regex("^[A-Za-z][A-Za-z0-9+.-]*:").containsMatchIn(trimmed) -> return@runCatching null
            else -> NioPath.of(trimmed)
        }
        val lexical = (if (requested.isAbsolute) requested else realRoot.resolve(requested)).normalize()
        // macOS file: URIs may use /var while toRealPath() canonicalizes the granted
        // root to /private/var. Relative paths must remain lexically confined; absolute
        // paths are confined by the canonical target check immediately below.
        if ((!requested.isAbsolute && !lexical.startsWith(realRoot)) || Files.isSymbolicLink(lexical)) {
            return@runCatching null
        }
        val real = lexical.toRealPath()
        if (!real.startsWith(realRoot)) return@runCatching null
        val extension = real.fileName.toString().substringAfterLast('.', "").lowercase(Locale.ROOT)
        val contentType = when (extension) {
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "bmp" -> "image/bmp"
            "wbmp" -> "image/vnd.wap.wbmp"
            "webp" -> "image/webp"
            else -> return@runCatching null
        }
        val before = Files.readAttributes(real, java.nio.file.attribute.BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        if (!before.isRegularFile || before.size() !in 1..MAX_DESKTOP_LOCAL_IMAGE_BYTES) return@runCatching null
        val options: Set<OpenOption> = setOf(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)
        val bytes = Files.newByteChannel(real, options).use { channel ->
            val output = ByteArrayOutputStream(minOf(before.size(), 64L * 1024L).toInt())
            val buffer = ByteBuffer.allocate(16 * 1024)
            var total = 0L
            while (true) {
                buffer.clear()
                val count = channel.read(buffer)
                if (count < 0) break
                total += count
                if (total > MAX_DESKTOP_LOCAL_IMAGE_BYTES) return@use null
                output.write(buffer.array(), 0, count)
            }
            output.toByteArray()
        } ?: return@runCatching null
        val after = Files.readAttributes(real, java.nio.file.attribute.BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        if (!after.isRegularFile || before.fileKey() != after.fileKey() || before.lastModifiedTime() != after.lastModifiedTime() || after.size() != bytes.size.toLong()) {
            return@runCatching null
        }
        DesktopLocalImagePayload(bytes, contentType)
    }.getOrNull()
}

private fun loadDesktopBundledLightboxImage(source: String): DesktopLocalImagePayload? {
    val normalized = normalizedDesktopAssetName(source) ?: return null
    val names = if (normalized.substringAfterLast('/', "").contains('.')) listOf(normalized)
    else listOf("$normalized.png", "$normalized.jpg", "$normalized.jpeg", "$normalized.webp", "$normalized.gif")
    for (name in names) {
        val extension = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        val contentType = when (extension) {
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            else -> continue
        }
        for (candidate in desktopBundledAssetCandidates(name)) {
            val bytes = DesktopHost::class.java.getResourceAsStream(candidate)?.use { input ->
                input.readNBytes((MAX_DESKTOP_LOCAL_IMAGE_BYTES + 1).toInt())
            } ?: continue
            if (bytes.size.toLong() in 1..MAX_DESKTOP_LOCAL_IMAGE_BYTES) {
                return DesktopLocalImagePayload(bytes, contentType)
            }
        }
    }
    return null
}

private fun configuredDesktopAssetRoot(): NioPath? =
    System.getProperty("dsx.assets.root")?.trim()?.takeIf(String::isNotEmpty)?.let { raw ->
        runCatching { NioPath.of(raw) }.getOrNull()
    }

private fun DesktopElementContext.slot(name: String?): List<StackNode> = node.children.filter { child ->
    val slot = child.attrs["slot"]
    if (name == null) slot == null || slot == "default" else slot == name
}

private val LocalDesktopForm = compositionLocalOf { "form" }

@Composable
internal fun DesktopForm(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val namespace = context.attributes["as"]?.takeIf(String::isNotBlank) ?: "form"
    LaunchedEffect(namespace) {
        if (context.store.getPath("$namespace.valid") == null) context.store.setPath("$namespace.valid", true)
    }
    fun submit() {
        val valid = JSE.truthy(context.store.getPath("$namespace.valid"))
        if (valid) context.fire("submit")
        else {
            val fields = context.store.getPath("$namespace.fields") as? Map<*, *> ?: emptyMap<Any?, Any?>()
            fields.keys.filterIsInstance<String>().forEach { name ->
                context.store.setPath("$namespace.fields.$name.touched", true)
            }
            context.store.setPath("$namespace.submitted", true)
        }
    }
    CompositionLocalProvider(LocalDesktopForm provides namespace) {
        Column(
            modifier,
            verticalArrangement = Arrangement.spacedBy(dimension(context.attributes["spacing"], 12f).dp),
        ) {
            context.render(context.slot(null))
            context.attributes["submit"]?.let { label ->
                Button(::submit, enabled = !disabled) { Text(label) }
            }
        }
    }
}

@Composable
private fun DesktopElementContext.render(nodes: List<StackNode>) {
    nodes.forEach { DesktopNode(it, store, runner, item, components) }
}

private fun actionKeyHandler(action: () -> Unit): Modifier = Modifier.onPreviewKeyEvent { event ->
    if (event.type == KeyEventType.KeyDown && (event.key == Key.Enter || event.key == Key.Spacebar)) {
        action()
        true
    } else false
}

@Composable
private fun DesktopAccordion(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    var open by remember(context.node) { mutableStateOf(context.attributes["open"] == "true") }
    fun toggle() {
        if (disabled) return
        open = !open
        context.fire("toggle", mapOf("open" to open))
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            Modifier.fillMaxWidth().then(actionKeyHandler(::toggle))
                .clickable(enabled = !disabled, role = Role.Button, onClick = ::toggle)
                .padding(vertical = 6.dp)
                .semantics { stateDescription = if (open) "Expanded" else "Collapsed" },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val header = context.slot("header")
            if (header.isNotEmpty()) context.render(header)
            else {
                Text(context.attributes["title"].orEmpty(), Modifier.weight(1f), fontSize = 17.sp)
                Text(if (open) "⌄" else "›", color = color(context.attributes["color"] ?: "accent"), fontSize = 20.sp)
            }
        }
        if (open) context.render(context.slot(null))
    }
}

@Composable
private fun DesktopChatBubble(context: DesktopElementContext, modifier: Modifier) {
    val right = context.attributes["side"] == "right"
    val shape = if (right) RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp)
    else RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp)
    Box(modifier.fillMaxWidth(), contentAlignment = if (right) Alignment.CenterEnd else Alignment.CenterStart) {
        Column(
            Modifier.widthIn(max = dimension(context.attributes["maxWidth"], 280f).dp)
                .background(color(context.attributes["color"] ?: if (right) "accent" else "#2C2C2E"), shape)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) { context.render(context.slot(null)) }
    }
}

@Composable
private fun DesktopCanonicalCheckbox(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val key = context.attributes["bind"].orEmpty()
    val checked = JSE.truthy(context.bound(key))
    Row(
        modifier.toggleable(checked, enabled = !disabled, role = Role.Checkbox) { context.write(key, it) },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Checkbox(
            checked,
            null,
            enabled = !disabled,
            colors = CheckboxDefaults.colors(checkedColor = color(context.attributes["color"] ?: "accent")),
        )
        context.attributes["label"]?.let { Text(it) }
    }
}

@Composable
private fun DesktopDrawer(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    var drag by remember(context.node) { mutableStateOf(0f) }
    val scope = rememberCoroutineScope()
    Column(
        modifier.fillMaxWidth().offset { IntOffset(0, drag.coerceAtLeast(0f).roundToInt()) }
            .clip(RoundedCornerShape(24.dp)).background(color("secondaryBackground"))   // the elevated-surface slot (Drawer.swift twin — was the pinned #1C1C1C)
            .pointerInput(disabled) {
                if (!disabled) detectDragGestures(
                    onDragEnd = {
                        if (drag > 120.dp.toPx()) context.fire("close")
                        drag = 0f
                    },
                    onDragCancel = { drag = 0f },
                ) { change, amount ->
                    change.consume()
                    drag = (drag + amount.y).coerceAtLeast(0f)
                }
            }
            .onPreviewKeyEvent { event ->
                if (!disabled && event.type == KeyEventType.KeyDown && event.key == Key.Escape) {
                    scope.launch { context.fire("close") }
                    true
                } else false
            },
    ) {
        Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.size(36.dp, 5.dp).background(Color.White.copy(alpha = 0.25f), RoundedCornerShape(3.dp)))
        }
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) { context.render(context.slot(null)) }
    }
}

@Composable
private fun DesktopLevelMeter(context: DesktopElementContext, modifier: Modifier) {
    val level = context.num("level", 0.0).toFloat().coerceIn(0f, 1f)
    val tint = when {
        level >= 0.9f -> color("danger")
        level >= 0.7f -> Color(0xFFFFCC00)
        else -> color(context.attributes["color"] ?: "accent")
    }
    LinearProgressIndicator(
        progress = level,
        modifier = modifier.fillMaxWidth().height(dimension(context.attributes["height"], 8f).dp)
            .semantics { stateDescription = "${(level * 100).roundToInt()} percent" },
        color = tint,
        backgroundColor = color("outline"),
    )
}

@Composable
private fun DesktopMenuBar(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val items = context.rows("items", MAX_DESKTOP_OPTIONS)
    val selected = context.num("selected", 0.0).roundToInt().coerceIn(0, (items.size - 1).coerceAtLeast(0))
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
            .background(if (context.bool("dark")) Color(0xFF1C1C1E) else MaterialTheme.colors.surface, RoundedCornerShape(18.dp))
            .padding(6.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items.forEachIndexed { index, row ->
            val label = JSE.string(row["name"] ?: row["label"] ?: row["id"] ?: index)
            TextButton(
                enabled = !disabled,
                onClick = {
                    val payload = LinkedHashMap(row)
                    payload["index"] = index
                    context.fire("select", payload)
                },
                modifier = Modifier.background(
                    if (index == selected) color("accent").copy(alpha = 0.18f) else Color.Transparent,
                    RoundedCornerShape(14.dp),
                ).semantics { if (index == selected) stateDescription = "Selected" },
            ) { Text(label, color = if (index == selected) color("accent") else MaterialTheme.colors.onSurface) }
        }
    }
}

@Composable
private fun DesktopProgressRing(context: DesktopElementContext, modifier: Modifier) {
    val max = context.num("max", 1.0)
    val value = context.num("value", 0.0)
    val fraction = if (!value.isFinite() || !max.isFinite() || max <= 0.0) 0f else (value / max).toFloat().coerceIn(0f, 1f)
    val size = dimension(context.attributes["size"], 88f).coerceAtLeast(1f)
    val stroke = dimension(context.attributes["lineWidth"], 10f).coerceIn(0.5f, size / 2f)
    val trackColor = color(context.attributes["trackColor"] ?: "#2C2C2E")
    val arcColor = color(context.attributes["color"] ?: "accent")
    Box(modifier.size(size.dp).semantics { stateDescription = "${(fraction * 100).roundToInt()} percent" }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val px = stroke.dp.toPx()
            val inset = px / 2f
            val arcSize = Size(this.size.width - px, this.size.height - px)
            drawArc(trackColor, -90f, 360f, false,
                Offset(inset, inset), arcSize, style = Stroke(px, cap = StrokeCap.Round))
            drawArc(arcColor, -90f, fraction * 360f, false,
                Offset(inset, inset), arcSize, style = Stroke(px, cap = StrokeCap.Round))
        }
        context.attributes["label"]?.let { Text(it, fontSize = 17.sp) }
    }
}

@Composable
private fun DesktopRadioGroup(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val key = context.attributes["bind"].orEmpty()
    val selected = context.textValue(key)
    Column(modifier.semantics { role = Role.RadioButton }, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        context.options().forEach { (id, label) ->
            Row(
                Modifier.fillMaxWidth().selectable(selected == id, enabled = !disabled, role = Role.RadioButton) { context.write(key, id) },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                RadioButton(
                    selected == id,
                    null,
                    enabled = !disabled,
                    colors = RadioButtonDefaults.colors(selectedColor = color(context.attributes["color"] ?: "accent")),
                )
                Text(label)
            }
        }
    }
}

/** The Kotlin twin of `<Signature/>` on the desktop: the SAME :core ink law, a Compose Canvas,
 *  and the mouse or pen as the pointer. Geometry mirrors Foundation Core/Signature.swift through
 *  InkCore, so the pad is the same object on all four renderers. */
@Composable
private fun DesktopSignature(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val strokes = InkCore.decode(context.rows("bind", MAX_DESKTOP_SIGNATURE_STROKES))
    val key = context.attributes["bind"].orEmpty()
    val width = context.num("strokeWidth", InkCore.STROKE_WIDTH)
    val radius = dimension(context.attributes["radius"], SIGNATURE_PAD_RADIUS.toFloat())
    val height = dimension(context.attributes["height"], SIGNATURE_PAD_HEIGHT.toFloat())
    val placeholder = context.value("placeholder").orEmpty()
    val readOnly = disabled || context.bool("readOnly")
    val ink = color(context.attributes["color"] ?: SIGNATURE_PAD_INK)
    val rule = color(SIGNATURE_PAD_RULE)
    var live by remember { mutableStateOf(emptyList<InkCore.Point>()) }
    val empty = strokes.isEmpty() && live.isEmpty()
    val shape = RoundedCornerShape(radius.dp)
    Box(
        modifier.fillMaxWidth().height(height.dp).clip(shape)
            .border(SIGNATURE_PAD_BORDER.dp, rule, shape)
            .pointerInput(readOnly, key, width) {
                if (readOnly) return@pointerInput
                val minDistancePx = InkCore.MIN_POINT_DISTANCE.dp.toPx().toDouble()
                awaitEachGesture {
                    val boxW = size.width.toDouble()
                    val boxH = size.height.toDouble()
                    val down = awaitFirstDown(requireUnconsumed = false)
                    live = listOf(desktopCapture(down.position, boxW, boxH))
                    context.fire("begin", mapOf("strokes" to strokes.size))
                    var event = awaitPointerEvent()
                    while (event.changes.any { it.pressed }) {
                        for (change in event.changes) {
                            if (!change.pressed) continue
                            val point = desktopCapture(change.position, boxW, boxH)
                            val last = live.last()
                            val dx = (point.x - last.x) * boxW
                            val dy = (point.y - last.y) * boxH
                            if (dx * dx + dy * dy >= minDistancePx * minDistancePx) live = live + point
                            change.consume()
                        }
                        event = awaitPointerEvent()
                    }
                    val captured = live.take(MAX_DESKTOP_SIGNATURE_POINTS)
                    live = emptyList()
                    if (captured.isNotEmpty()) {
                        val next = strokes + InkCore.Stroke(captured, width)
                        context.write(key, InkCore.encode(next))
                        context.fire("end", mapOf("strokes" to next.size, "points" to captured.size))
                    }
                }
            }
            .semantics(mergeDescendants = true) {
                contentDescription = context.value("a11yLabel")
                    ?: placeholder.ifEmpty { "Signature" }
                stateDescription = if (empty) "Empty" else "Signed"
            },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            if (context.bool("baseline", true)) {
                val inset = SIGNATURE_PAD_BASELINE_INSET.dp.toPx()
                val y = size.height - SIGNATURE_PAD_BASELINE_BOTTOM.dp.toPx()
                drawLine(rule, Offset(inset, y), Offset(size.width - inset, y),
                    strokeWidth = SIGNATURE_PAD_BORDER.dp.toPx())
            }
            for (stroke in strokes) {
                drawPath(desktopInkPath(stroke.points, size), color = ink,
                    style = Stroke(stroke.width.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
            if (live.isNotEmpty()) {
                drawPath(desktopInkPath(live, size), color = ink,
                    style = Stroke(width.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
        }
        if (empty && placeholder.isNotEmpty()) {
            Text(placeholder, color = color(SIGNATURE_PAD_PLACEHOLDER),
                 fontSize = SIGNATURE_PAD_PLACEHOLDER_FONT.sp)
        }
    }
}

private fun desktopCapture(position: Offset, width: Double, height: Double): InkCore.Point =
    InkCore.point(position.x.toDouble(), position.y.toDouble(), width, height)


@Composable
private fun DesktopSkeleton(context: DesktopElementContext, modifier: Modifier) {
    val height = dimension(context.attributes["height"], 14f)
    val radius = dimension(context.attributes["radius"], 8f)
    val transition = rememberInfiniteTransition(label = "dsxDesktopSkeleton")
    val phase by transition.animateFloat(-0.6f, 1f, infiniteRepeatable(tween(1100, easing = LinearEasing)), label = "phase")
    val shimmerBase = MaterialTheme.colors.onBackground
    Box(
        modifier.fillMaxWidth().height(height.dp).clip(RoundedCornerShape(radius.dp))
            .background(shimmerBase.copy(alpha = 0.08f))
            .drawBehind {
                val shimmer = size.width * 0.6f
                val start = phase * (size.width + shimmer) - shimmer
                drawRect(Brush.horizontalGradient(
                    listOf(Color.Transparent, shimmerBase.copy(alpha = 0.10f), Color.Transparent),
                    startX = start, endX = start + shimmer,
                ))
            }.semantics { hideFromAccessibility() },
    )
}

@Composable
private fun DesktopTable(context: DesktopElementContext, modifier: Modifier) {
    val columns = csv(context.attributes["columns"]).take(MAX_DESKTOP_TABLE_COLUMNS)
    val fields = csv(context.attributes["fields"]).ifEmpty { columns.map(String::lowercase) }
    val rows = context.rows("bind", MAX_DESKTOP_TABLE_ROWS + 1)
    val visibleRows = rows.take(MAX_DESKTOP_TABLE_ROWS)
    Column(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            columns.forEach { Text(it, Modifier.weight(1f), color = MaterialTheme.colors.onSurface.copy(alpha = 0.65f),
                fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        Divider()
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp)) {
            itemsIndexed(visibleRows) { index, row ->
                Column {
                    Row(Modifier.fillMaxWidth().padding(vertical = 9.dp).semantics(mergeDescendants = true) {},
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        fields.take(MAX_DESKTOP_TABLE_COLUMNS).forEach { field ->
                            Text(JSE.string(row[field] ?: "").take(MAX_DESKTOP_CELL_CHARS), Modifier.weight(1f),
                                color = color(context.attributes["color"] ?: "label"), fontSize = 15.sp,
                                maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    if (index != visibleRows.lastIndex) Divider(color = MaterialTheme.colors.onSurface.copy(alpha = 0.09f))
                }
            }
        }
        if (rows.size > visibleRows.size) {
            Text(
                "Showing the first ${visibleRows.size} rows",
                Modifier.padding(top = 8.dp),
                color = MaterialTheme.colors.onSurface.copy(alpha = 0.65f),
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun DesktopCalendar(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val key = context.attributes["bind"].orEmpty()
    val selected = desktopParseDay(context.textValue(key))
    var month by remember(context.node) { mutableStateOf(YearMonth.from(selected ?: LocalDate.now())) }
    val min = desktopParseDay(context.attributes["min"])
    val max = desktopParseDay(context.attributes["max"])
    val first = WeekFields.of(Locale.getDefault()).firstDayOfWeek
    val weekdays = (0..6).map { first.plus(it.toLong()) }
    val marked = context.rows("marks", 3_660).mapNotNull {
        desktopParseDay(JSE.string(it[context.attributes["markDateField"] ?: "date"] ?: ""))
    }.toSet()
    fun page(delta: Long) {
        month = month.plusMonths(delta)
        context.fire("month", mapOf("month" to month.toString()))
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextButton({ page(-1) }, enabled = !disabled, modifier = Modifier.semantics { contentDescription = "Previous month" }) { Text("‹") }
            Text(month.month.getDisplayName(TextStyle.FULL, Locale.getDefault()) + " ${month.year}",
                Modifier.weight(1f), textAlign = TextAlign.Center, fontWeight = FontWeight.SemiBold)
            TextButton({ page(1) }, enabled = !disabled, modifier = Modifier.semantics { contentDescription = "Next month" }) { Text("›") }
        }
        Row(Modifier.fillMaxWidth()) {
            weekdays.forEach { day -> Text(day.getDisplayName(TextStyle.NARROW, Locale.getDefault()), Modifier.weight(1f),
                textAlign = TextAlign.Center, fontSize = 11.sp, fontWeight = FontWeight.SemiBold) }
        }
        desktopMonthCells(month, first).chunked(7).forEach { week ->
            Row(Modifier.fillMaxWidth()) {
                week.forEach { date ->
                    if (date == null) Spacer(Modifier.weight(1f).height(40.dp))
                    else {
                        val selectedDay = date == selected
                        val unavailable = disabled || (min != null && date < min) || (max != null && date > max)
                        Column(
                            Modifier.weight(1f).height(40.dp)
                                .clickable(enabled = !unavailable, role = Role.Button) { context.write(key, date.toString()) }
                                .semantics { contentDescription = date.format(DateTimeFormatter.ofPattern("MMMM d, yyyy")) },
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Box(Modifier.size(32.dp).background(if (selectedDay) color(context.attributes["color"] ?: "accent") else Color.Transparent, CircleShape),
                                contentAlignment = Alignment.Center) {
                                Text(date.dayOfMonth.toString(), color = when {
                                    selectedDay -> Color.White
                                    unavailable -> MaterialTheme.colors.onSurface.copy(alpha = 0.35f)
                                    else -> MaterialTheme.colors.onSurface
                                }, fontWeight = if (selectedDay) FontWeight.Bold else FontWeight.Normal)
                            }
                            Box(Modifier.size(4.dp).background(if (date in marked) color(context.attributes["color"] ?: "accent") else Color.Transparent, CircleShape))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DesktopPager(
    context: DesktopElementContext,
    modifier: Modifier,
    disabled: Boolean,
    dataBound: Boolean,
) {
    val rows = if (dataBound) context.rows("bind", MAX_DESKTOP_PAGES) else emptyList()
    val template = if (dataBound) context.slot(null).firstOrNull() else null
    val pageCount = if (dataBound) rows.size else context.slot(null).size
    if (pageCount == 0) return
    val indexKey = context.attributes["value"].orEmpty()
    val boundIndex = (JSE.number(context.bound(indexKey))?.takeIf(Double::isFinite) ?: 0.0)
        .roundToInt().coerceIn(0, pageCount - 1)
    val state = rememberPagerState(initialPage = boundIndex) { pageCount }
    var initialized by remember(context.node) { mutableStateOf(false) }
    LaunchedEffect(state.settledPage) {
        if (!initialized) initialized = true
        else if (!disabled && state.settledPage != boundIndex) {
            if (indexKey.isNotBlank()) context.write(indexKey, state.settledPage.toDouble())
            else context.fire("change", mapOf("value" to state.settledPage))
        }
    }
    LaunchedEffect(boundIndex, pageCount) {
        if (!state.isScrollInProgress && state.currentPage != boundIndex) state.scrollToPage(boundIndex)
    }
    val pagerModifier = modifier.fillMaxWidth().onPreviewKeyEvent { event ->
        if (disabled || event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        val target = when (event.key) {
            Key.DirectionRight, Key.DirectionDown -> (state.currentPage + 1).coerceAtMost(pageCount - 1)
            Key.DirectionLeft, Key.DirectionUp -> (state.currentPage - 1).coerceAtLeast(0)
            else -> return@onPreviewKeyEvent false
        }
        if (target != state.currentPage) context.write(indexKey, target.toDouble())
        true
    }.focusable().semantics { stateDescription = "Page ${state.currentPage + 1} of $pageCount" }
    Column {
        if (context.attributes["axis"] == "vertical") {
            VerticalPager(state, pagerModifier) { index -> DesktopPage(context, rows, template, index, dataBound) }
        } else {
            HorizontalPager(
                state,
                pagerModifier,
                contentPadding = PaddingValues(horizontal = dimension(context.attributes["peek"], 0f).dp),
                pageSpacing = dimension(context.attributes["spacing"], 12f).dp,
                userScrollEnabled = !disabled,
            ) { index -> DesktopPage(context, rows, template, index, dataBound) }
        }
        if (context.attributes["dots"] != "false" && pageCount in 2..50) {
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.Center) {
                repeat(pageCount) { index ->
                    Box(Modifier.padding(4.dp).size(7.dp).background(
                        if (index == state.currentPage) color(context.attributes["color"] ?: "accent")
                        else MaterialTheme.colors.onSurface.copy(alpha = 0.25f), CircleShape))
                }
            }
        } else if (context.attributes["dots"] != "false" && pageCount > 50) {
            Text(
                "Page ${state.currentPage + 1} of $pageCount",
                Modifier.fillMaxWidth().padding(top = 8.dp),
                textAlign = TextAlign.Center,
                color = MaterialTheme.colors.onSurface.copy(alpha = 0.65f),
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun DesktopPage(
    context: DesktopElementContext,
    rows: List<Map<String, Any?>>,
    template: StackNode?,
    index: Int,
    dataBound: Boolean,
) {
    if (dataBound) template?.let { DesktopNode(it, context.store, context.runner, rows[index], context.components) }
    else context.slot(null).getOrNull(index)?.let { DesktopNode(it, context.store, context.runner, context.item, context.components) }
}

internal data class DesktopMenuItem(
    val title: String,
    val action: String,
    val args: Map<String, Any?>,
    val destructive: Boolean,
    val separator: Boolean,
    val depth: Int,
)

internal fun flattenMenu(rows: List<Map<String, Any?>>): List<DesktopMenuItem> {
    val result = ArrayList<DesktopMenuItem>(minOf(rows.size, MAX_DESKTOP_MENU_ITEMS))
    val visited = IdentityHashMap<Any, Boolean>()
    fun visit(items: List<Map<String, Any?>>, depth: Int) {
        if (depth > MAX_DESKTOP_MENU_DEPTH || result.size >= MAX_DESKTOP_MENU_ITEMS) return
        for (row in items) {
            if (result.size >= MAX_DESKTOP_MENU_ITEMS) break
            val nestedSource = row["items"]
            val nested = if (nestedSource != null && visited.put(nestedSource, true) == null) {
                desktopBoundedRows(nestedSource, MAX_DESKTOP_MENU_ITEMS - result.size)
            } else emptyList()
            if (nested.isNotEmpty() && depth < MAX_DESKTOP_MENU_DEPTH) {
                result += DesktopMenuItem(JSE.string(row["title"] ?: ""), "", emptyMap(), false, false, depth)
                visit(nested, depth + 1)
            } else {
                @Suppress("UNCHECKED_CAST")
                result += DesktopMenuItem(
                    title = JSE.string(row["title"] ?: ""),
                    action = JSE.string(row["action"] ?: ""),
                    args = row["args"] as? Map<String, Any?> ?: emptyMap(),
                    destructive = row["role"] == "destructive",
                    separator = row["separator"] == true,
                    depth = depth,
                )
            }
        }
    }
    visit(rows.take(MAX_DESKTOP_MENU_ITEMS), 0)
    return result
}

@Composable
private fun DesktopMenu(context: DesktopElementContext, modifier: Modifier, disabled: Boolean, longPress: Boolean) {
    var expanded by remember(context.node) { mutableStateOf(false) }
    val menuItems = flattenMenu(context.rows("menu", MAX_DESKTOP_MENU_ITEMS))
    Box(
        modifier.pointerInput(disabled, longPress) {
            if (!disabled) detectTapGestures(
                onTap = if (!longPress) ({ expanded = true }) else null,
                onLongPress = if (longPress) ({ expanded = true }) else null,
            )
        }.then(actionKeyHandler { if (!disabled) expanded = true }).focusable(),
    ) {
        context.render(context.slot(null))
        DropdownMenu(expanded, { expanded = false }) {
            menuItems.forEach { entry ->
                if (entry.separator) Divider()
                else DropdownMenuItem(
                    onClick = {
                        if (entry.action.isNotBlank()) context.run(entry.action, entry.args)
                        expanded = false
                    },
                    enabled = entry.action.isNotBlank(),
                ) {
                    Text("  ".repeat(entry.depth) + entry.title,
                        color = if (entry.destructive) color("danger") else MaterialTheme.colors.onSurface)
                }
            }
        }
    }
}

@Composable
private fun DesktopDatePicker(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val key = context.attributes["bind"].orEmpty()
    val mode = context.attributes["mode"] ?: "date"
    val raw = context.textValue(key)
    var open by remember(context.node) { mutableStateOf(false) }
    val label = context.attributes["label"]
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        label?.let { Text(it) }
        Spacer(Modifier.weight(1f))
        Button({ open = true }, enabled = !disabled) { Text(raw.ifBlank { if (mode == "time") "Select time" else "Select date" }) }
    }
    if (open) {
        DialogWindow(onCloseRequest = { open = false }, title = label ?: "Select ${if (mode == "time") "time" else "date"}") {
            Surface(Modifier.padding(12.dp), shape = RoundedCornerShape(12.dp), elevation = 8.dp) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (mode != "time") {
                        val selected = desktopParseDay(raw)
                        var month by remember { mutableStateOf(YearMonth.from(selected ?: LocalDate.now())) }
                        InlineCalendar(month, selected, disabled, onPage = { month = month.plusMonths(it) }) { day ->
                            val next = when (mode) {
                                "datetime" -> day.toString() + "T" + (raw.substringAfter('T', "00:00:00").take(8)) + "Z"
                                else -> day.toString()
                            }
                            context.write(key, next)
                            if (mode == "date") open = false
                        }
                    }
                    if (mode == "time" || mode == "datetime") {
                        var time by remember(raw) { mutableStateOf(runCatching {
                            LocalTime.parse(raw.substringAfter('T').removeSuffix("Z").take(8).ifBlank { raw.take(8) })
                        }.getOrDefault(LocalTime.NOON)) }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton({ time = time.minusHours(1) }) { Text("−") }
                            Text(time.format(DateTimeFormatter.ofPattern("HH:mm")), fontSize = 20.sp)
                            TextButton({ time = time.plusHours(1) }) { Text("+") }
                            TextButton({
                                val next = if (mode == "time") time.format(DateTimeFormatter.ofPattern("HH:mm:ss"))
                                else (desktopParseDay(raw) ?: LocalDate.now()).toString() + "T" + time.format(DateTimeFormatter.ofPattern("HH:mm:ss")) + "Z"
                                context.write(key, next)
                                open = false
                            }) { Text("Done") }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun InlineCalendar(
    month: YearMonth,
    selected: LocalDate?,
    disabled: Boolean,
    onPage: (Long) -> Unit,
    onPick: (LocalDate) -> Unit,
) {
    val first = WeekFields.of(Locale.getDefault()).firstDayOfWeek
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextButton({ onPage(-1) }, enabled = !disabled) { Text("‹") }
            Text("${month.month.getDisplayName(TextStyle.FULL, Locale.getDefault())} ${month.year}", Modifier.weight(1f), textAlign = TextAlign.Center)
            TextButton({ onPage(1) }, enabled = !disabled) { Text("›") }
        }
        desktopMonthCells(month, first).chunked(7).forEach { week ->
            Row(Modifier.fillMaxWidth()) {
                week.forEach { day ->
                    if (day == null) Spacer(Modifier.weight(1f).height(32.dp))
                    else TextButton({ onPick(day) }, Modifier.weight(1f), enabled = !disabled) {
                        Text(day.dayOfMonth.toString(), fontWeight = if (day == selected) FontWeight.Bold else FontWeight.Normal)
                    }
                }
            }
        }
    }
}

internal fun desktopSafeRegexMatches(value: String, pattern: String): Boolean {
    if (value.length > 4_096 || pattern.isEmpty() || pattern.length > 256 || pattern.any { it == '\u0000' || it == '\n' || it == '\r' }) return false
    if (pattern.any { it == '(' || it == ')' || it == '|' }) return false
    var escaped = false
    var inClass = false
    var variableQuantifiers = 0
    var index = 0
    while (index < pattern.length) {
        val char = pattern[index]
        if (escaped) {
            if (!inClass && char.isDigit()) return false // backreferences
            escaped = false
            index += 1
            continue
        }
        if (char == '\\') {
            escaped = true
            index += 1
            continue
        }
        if (char == '[') inClass = true
        else if (char == ']') inClass = false
        else if (!inClass && char in listOf('*', '+', '?')) {
            variableQuantifiers += 1
            if (variableQuantifiers > 1 || index == 0 || pattern[index - 1] == '.') return false
        } else if (!inClass && char == '{') {
            val end = pattern.indexOf('}', startIndex = index + 1)
            if (end < 0) return false
            val bounds = pattern.substring(index + 1, end).split(',', limit = 2)
            val lower = bounds.firstOrNull()?.toIntOrNull() ?: return false
            val upper = bounds.getOrNull(1)?.takeIf(String::isNotEmpty)?.toIntOrNull()
            if (lower !in 0..128 || (upper != null && upper !in lower..128)) return false
            if (bounds.size == 2 && upper == null && ++variableQuantifiers > 1) return false
            index = end
        }
        index += 1
    }
    if (escaped || inClass) return false
    return runCatching { Regex(pattern).containsMatchIn(value) }.getOrDefault(false)
}

internal fun desktopFieldError(value: String, rules: String, pattern: String?, override: String?): String {
    for (rule in csv(rules)) {
        val parts = rule.split(':', limit = 2)
        val name = parts[0]
        val arg = parts.getOrNull(1).orEmpty()
        val valid = when (name) {
            "required" -> value.isNotBlank()
            "email" -> value.isEmpty() || Regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$").matches(value)
            "url" -> value.isEmpty() || runCatching { URI(value).let { it.scheme in setOf("http", "https") && it.host != null } }.getOrDefault(false)
            "phone" -> value.isEmpty() || Regex("^[+() 0-9.-]{7,}$").matches(value)
            "minLength" -> value.length >= (arg.toIntOrNull() ?: 0)
            "maxLength" -> value.length <= (arg.toIntOrNull() ?: Int.MAX_VALUE)
            "regex", "pattern" -> value.isEmpty() || pattern.isNullOrEmpty() || desktopSafeRegexMatches(value, pattern)
            else -> true
        }
        if (!valid) return override?.takeIf(String::isNotEmpty) ?: when (name) {
            "required" -> "Required"
            "email" -> "Enter a valid email"
            "url" -> "Enter a valid URL"
            "phone" -> "Enter a valid phone number"
            "minLength" -> "Must be at least $arg characters"
            "maxLength" -> "Must be at most $arg characters"
            else -> "Invalid format"
        }
    }
    return ""
}

@Composable
private fun DesktopField(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val form = context.attributes["form"] ?: LocalDesktopForm.current
    val name = context.attributes["name"].orEmpty()
    val valuePath = "$form.values.$name"
    val metaPath = "$form.fields.$name"
    val type = context.attributes["type"] ?: "text"
    val value = JSE.string(context.store.getPath(valuePath) ?: "")
    val rules = context.attributes["validate"].orEmpty()
    fun validate(next: String): String {
        val error = desktopFieldError(next, rules, context.attributes["pattern"], context.attributes["message"])
        context.store.setPath("$metaPath.error", error)
        val fields = context.store.getPath("$form.fields") as? Map<*, *> ?: emptyMap<Any?, Any?>()
        context.store.setPath("$form.valid", fields.values.all { ((it as? Map<*, *>)?.get("error") as? String).isNullOrEmpty() })
        return error
    }
    fun write(next: Any) {
        context.store.setPath(valuePath, next)
        context.store.setPath("$metaPath.dirty", true)
        validate(JSE.string(next))
        context.attributes["on:change"]?.let { context.run(it, mapOf("value" to next)) }
    }
    LaunchedEffect(name, rules) {
        val order = (context.store.getPath("$form.fieldOrder") as? List<*>)?.filterIsInstance<String>().orEmpty()
        if (name.isNotBlank() && name !in order) context.store.setPath("$form.fieldOrder", order + name)
        validate(value)
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        context.attributes["label"]?.let { Text(it, fontSize = 13.sp, color = MaterialTheme.colors.onSurface.copy(alpha = 0.65f)) }
        when (type) {
            "toggle" -> {
                val checked = JSE.truthy(context.store.getPath(valuePath))
                Row(
                    Modifier.toggleable(checked, enabled = !disabled, role = Role.Checkbox) { write(it) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(checked, null, enabled = !disabled)
                    context.attributes["placeholder"]?.let { Text(it) }
                }
            }
            "picker" -> {
                var expanded by remember { mutableStateOf(false) }
                Box {
                    Button({ expanded = true }, enabled = !disabled) { Text(value.ifBlank { context.attributes["placeholder"] ?: "Select" }) }
                    DropdownMenu(expanded, { expanded = false }) {
                        context.options().forEach { (id, label) -> DropdownMenuItem({ write(id); expanded = false }) { Text(label) } }
                    }
                }
            }
            else -> OutlinedTextField(
                value,
                { write(it) },
                Modifier.fillMaxWidth().onFocusChanged { if (!it.isFocused) context.store.setPath("$metaPath.touched", true) },
                enabled = !disabled,
                singleLine = true,
                placeholder = context.attributes["placeholder"]?.let { { Text(it) } },
                visualTransformation = if (type == "secure" || context.attributes["secure"] == "true") PasswordVisualTransformation() else VisualTransformation.None,
                keyboardOptions = KeyboardOptions(
                    keyboardType = when (type) {
                        "email" -> KeyboardType.Email
                        "number" -> KeyboardType.Number
                        "phone" -> KeyboardType.Phone
                        "url" -> KeyboardType.Uri
                        else -> KeyboardType.Text
                    },
                    imeAction = ImeAction.Next,
                ),
                keyboardActions = KeyboardActions(onNext = { context.attributes["on:submit"]?.let { context.run(it) } }),
            )
        }
        val touched = JSE.truthy(context.store.getPath("$metaPath.touched")) || JSE.truthy(context.store.getPath("$form.submitted"))
        val error = JSE.string(context.store.getPath("$metaPath.error") ?: "")
        if (touched && error.isNotEmpty()) Text(error, color = color("danger"), fontSize = 13.sp)
    }
}

@Composable
private fun DesktopLightbox(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val presentKey = context.attributes["present"].orEmpty()
    val presented = context.bool("present")
    val rows = context.rows("images", MAX_DESKTOP_OPTIONS)
    val field = context.attributes["srcField"] ?: "src"
    val sources = rows.mapNotNull { it[field]?.let(JSE::string) }.ifEmpty { csv(context.attributes["urls"]) }
    val indexKey = context.attributes["index"].orEmpty()
    val index = (JSE.number(context.bound(indexKey))?.takeIf(Double::isFinite) ?: 0.0)
        .roundToInt().coerceIn(0, (sources.size - 1).coerceAtLeast(0))
    Box(modifier) { context.render(context.slot(null)) }
    if (!presented || sources.isEmpty()) return
    fun dismiss() {
        if (presentKey.isNotBlank()) context.write(presentKey, false, event = "")
        context.fire("dismiss")
    }
    DialogWindow(onCloseRequest = ::dismiss, title = "DSX Lightbox") {
        Surface(Modifier.fillMaxSize(), color = Color.Black) {
            Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("${index + 1} / ${sources.size}", color = Color.White, modifier = Modifier.weight(1f))
                    TextButton(::dismiss) { Text("Close", color = Color.White) }
                }
                DesktopLocalImage(sources[index], Modifier.weight(1f).fillMaxWidth())
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                    TextButton({ if (!disabled && index > 0) context.write(indexKey, (index - 1).toDouble()) }, enabled = !disabled && index > 0) { Text("Previous") }
                    TextButton({ if (!disabled && index < sources.lastIndex) context.write(indexKey, (index + 1).toDouble()) }, enabled = !disabled && index < sources.lastIndex) { Text("Next") }
                }
            }
        }
    }
}

@Composable
private fun DesktopLocalImage(source: String, modifier: Modifier) {
    val raster by produceState<DesktopRaster?>(null, source) {
        val local = withContext(Dispatchers.IO) {
            loadDesktopBundledLightboxImage(source) ?: readDesktopLocalImage(source, configuredDesktopAssetRoot())
        }
        value = if (local != null) {
            withContext(Dispatchers.Default) { decodeDesktopRaster(local.bytes, local.contentType) }
        } else loadDesktopRemoteRaster(source)
    }
    Box(modifier, contentAlignment = Alignment.Center) {
        if (raster != null) Image(raster!!.image, "Lightbox image", Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        else Text("The image could not be loaded securely.", color = Color.White, textAlign = TextAlign.Center)
    }
}

@Composable
private fun DesktopOtp(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val key = context.attributes["bind"].orEmpty()
    val length = context.num("length", 6.0).roundToInt().coerceIn(1, MAX_DESKTOP_OTP_LENGTH)
    val box = context.num("boxSize", 48.0).toFloat().coerceIn(24f, 128f)
    val bound = context.textValue(key)
    val digits = desktopOtpClamp(bound, length)
    val focus = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    Box(modifier) {
        OutlinedTextField(
            bound,
            { raw ->
                val next = desktopOtpClamp(raw, length)
                context.write(key, next)
                if (next.length == length && digits.length != length) context.fire("complete", mapOf("value" to next))
            },
            Modifier.matchParentSize().alpha(0.01f).focusRequester(focus).onFocusChanged { focused = it.isFocused },
            enabled = !disabled,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            singleLine = true,
        )
        Row(Modifier.clickable(enabled = !disabled) { focus.requestFocus() }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            repeat(length) { index ->
                val active = focused && index == digits.length.coerceAtMost(length - 1) && digits.length < length
                Box(
                    Modifier.size(box.dp).border(if (active) 2.dp else 1.dp,
                        if (active) color(context.attributes["color"] ?: "accent") else color("separator"), RoundedCornerShape(10.dp)),
                    contentAlignment = Alignment.Center,
                ) { Text(digits.getOrNull(index)?.toString().orEmpty(), fontSize = (box * 0.42f).sp, fontWeight = FontWeight.SemiBold) }
            }
        }
    }
}

@Composable
private fun DesktopPopover(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val key = context.attributes["present"].orEmpty()
    val presented = context.bool("present")
    Box(modifier) {
        Box(Modifier.clickable(enabled = !disabled) { if (key.isNotBlank()) context.write(key, true) }) { context.render(context.slot(null)) }
        if (presented) Popup(
            alignment = when (context.attributes["arrow"]) {
                "bottom" -> Alignment.TopCenter
                "leading" -> Alignment.CenterEnd
                "trailing" -> Alignment.CenterStart
                else -> Alignment.BottomCenter
            },
            onDismissRequest = {
                if (key.isNotBlank()) context.write(key, false, event = "")
                context.fire("dismiss")
            },
            properties = PopupProperties(focusable = true),
        ) {
            Surface(shape = RoundedCornerShape(13.dp), elevation = 10.dp) {
                Column(Modifier.padding(12.dp)) { context.render(context.slot("content")) }
            }
        }
    }
}

@Composable
private fun DesktopRangeSlider(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val lowKey = context.attributes["bindLow"].orEmpty()
    val highKey = context.attributes["bindHigh"].orEmpty()
    val min = context.num("min", 0.0)
    val max = context.num("max", 1.0).coerceAtLeast(min)
    val step = context.attributes["step"]?.toDoubleOrNull()
        ?.takeIf { it.isFinite() && it > 0.0 }
        ?.coerceAtMost(MAX_DESKTOP_AUTHORED_SCALAR)
    val low = (JSE.number(context.bound(lowKey))?.takeIf(Double::isFinite) ?: min).coerceIn(min, max)
    val high = (JSE.number(context.bound(highKey))?.takeIf(Double::isFinite) ?: max).coerceIn(low, max)
    var shownLow by remember(context.node) { mutableStateOf(low) }
    var shownHigh by remember(context.node) { mutableStateOf(high) }
    var width by remember { mutableStateOf(1f) }
    var activeLow by remember { mutableStateOf(true) }
    val trackColor = MaterialTheme.colors.onSurface.copy(alpha = 0.18f)
    val tint = color(context.attributes["color"] ?: "accent")
    LaunchedEffect(low) { shownLow = low }
    LaunchedEffect(high) { shownHigh = high }
    fun fromX(x: Float): Double = desktopRangeValue(min + (x / width.coerceAtLeast(1f)).coerceIn(0f, 1f) * (max - min), min, max, step)
    fun update(x: Float, commit: Boolean) {
        if (activeLow) {
            shownLow = fromX(x).coerceAtMost(shownHigh)
            if (commit) context.write(lowKey, shownLow)
        } else {
            shownHigh = fromX(x).coerceAtLeast(shownLow)
            if (commit) context.write(highKey, shownHigh)
        }
    }
    Canvas(
        modifier.fillMaxWidth().height(28.dp).onSizeChanged { width = it.width.toFloat() }
            .pointerInput(disabled, min, max, step, width) {
                var lastCommit = 0L
                var latestX = 0f
                if (!disabled) detectDragGestures(
                    onDragStart = { start ->
                        val lowX = ((shownLow - min) / (max - min).coerceAtLeast(0.000001) * width).toFloat()
                        val highX = ((shownHigh - min) / (max - min).coerceAtLeast(0.000001) * width).toFloat()
                        activeLow = kotlin.math.abs(start.x - lowX) <= kotlin.math.abs(start.x - highX)
                        latestX = start.x
                        update(latestX, commit = true)
                        lastCommit = System.nanoTime()
                    },
                    onDragEnd = { update(latestX, commit = true) },
                ) { change, _ ->
                    change.consume()
                    latestX = change.position.x
                    val now = System.nanoTime()
                    val commit = now - lastCommit >= 80_000_000L
                    update(latestX, commit)
                    if (commit) lastCommit = now
                }
            }.onPreviewKeyEvent { event ->
                if (disabled || event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val delta = step?.takeIf { it > 0.0 } ?: ((max - min) / 100.0)
                when (event.key) {
                    Key.Spacebar -> { activeLow = !activeLow; true }
                    Key.DirectionLeft, Key.DirectionDown -> {
                        if (activeLow) context.write(lowKey, desktopRangeValue(shownLow - delta, min, shownHigh, step))
                        else context.write(highKey, desktopRangeValue(shownHigh - delta, shownLow, max, step)); true
                    }
                    Key.DirectionRight, Key.DirectionUp -> {
                        if (activeLow) context.write(lowKey, desktopRangeValue(shownLow + delta, min, shownHigh, step))
                        else context.write(highKey, desktopRangeValue(shownHigh + delta, shownLow, max, step)); true
                    }
                    else -> false
                }
            }.focusable().semantics { stateDescription = "$shownLow to $shownHigh; Space selects the other thumb" },
    ) {
        val y = size.height / 2f
        val lowX = ((shownLow - min) / (max - min).coerceAtLeast(0.000001) * size.width).toFloat()
        val highX = ((shownHigh - min) / (max - min).coerceAtLeast(0.000001) * size.width).toFloat()
        drawLine(trackColor, Offset(0f, y), Offset(size.width, y), 4.dp.toPx(), StrokeCap.Round)
        drawLine(tint, Offset(lowX, y), Offset(highX, y), 4.dp.toPx(), StrokeCap.Round)
        listOf(lowX, highX).forEach { x ->
            drawCircle(Color.White, 12.dp.toPx(), Offset(x, y))
            drawCircle(tint, 12.dp.toPx(), Offset(x, y), style = Stroke(2.dp.toPx()))
        }
    }
}

@Composable
private fun DesktopSearchBar(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val key = context.attributes["bind"].orEmpty()
    val value = context.textValue(key)
    OutlinedTextField(
        value,
        { context.write(key, it) },
        modifier.fillMaxWidth(),
        enabled = !disabled,
        singleLine = true,
        leadingIcon = { Text("⌕", fontSize = 20.sp, color = MaterialTheme.colors.onSurface.copy(alpha = 0.6f)) },
        trailingIcon = if (value.isNotEmpty()) ({
            TextButton({ context.write(key, ""); context.fire("clear") }, enabled = !disabled) { Text("×") }
        }) else null,
        placeholder = { Text(context.attributes["placeholder"] ?: "Search") },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { context.fire("submit", mapOf("value" to value)) }),
        shape = RoundedCornerShape(22.dp),
    )
}

/** The head vocabulary: contract, state and logic, never a pane. A structural container counts
 * its BODY children only (dsx-anatomy.md), and the declarations themselves are already registered
 * eagerly by `prepareDesktopDocument` before any of this renders. The one table lives in :core
 * (LayoutSemantics, flex-semantics corpus) so the render lanes cannot drift. */
internal val desktopDocumentDeclarationTags: Set<String> = LayoutSemantics.declarationTags

/** `<split>` — the two/three-pane adaptive container. The decisions belong to the shared
 * planner (`:core SplitPlan`, corpus OpenSource/Conformance/split/split.json, the same file the
 * TS and Swift twins execute); this function only spends them on Compose pixels, exactly as the
 * Android `:render SplitElement` twin does. Desktop adds what the pointer earns: a draggable
 * hairline between columns, clamped to the planner's own min/max, and Escape to pop a pushed
 * detail the way the platform Back does on the phone hosts. */
@Composable
private fun DesktopSplit(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val declarations = context.node.children.filter { it.tag in desktopDocumentDeclarationTags }
    val children = context.node.children.filterNot { it.tag in desktopDocumentDeclarationTags }.take(3)
    if (children.isEmpty()) return
    val declaredRoles = children.map { it.attrs["paneRole"] }
    val planAttributes = context.attributes.mapValues { (_, raw) -> JSE.interpolate(raw, context.store, context.item) }
    val valueKey = context.attributes["value"].orEmpty()
    var sidebarOpen by remember(context.node) { mutableStateOf(false) }
    val paneDelta = remember(context.node) { mutableStateMapOf<String, Float>() }

    BoxWithConstraints(modifier.fillMaxSize().testTag("dsx.split")) {
        // BoxWithConstraints subcomposes during layout, so this body does not inherit the
        // surface's state subscription — it has to track the store itself or a selection
        // write would never re-plan the panes.
        context.store.varsFlow.collectAsState().value
        if (declarations.isNotEmpty()) context.render(declarations)
        val plan = SplitPlan.resolve(planAttributes, declaredRoles, maxWidth.value.toDouble())
        val selected = plan.detail && valueKey.isNotEmpty() &&
            SplitPlan.selectionActive(context.bound(valueKey))
        val resizable = plan.resizable && !disabled

        @Composable
        fun Pane(role: String, paneModifier: Modifier) {
            val index = plan.roles.indexOf(role)
            if (index < 0) return
            // The pane is a sized cell whose authored child FILLS it (the web split's
            // grid cells): min-propagation keeps a hug pane stack from collapsing to
            // its content while the web twin spans the full pane.
            Box(
                paneModifier.testTag("dsx.split.$role")
                    .semantics { contentDescription = role.replaceFirstChar(Char::uppercaseChar) },
                propagateMinConstraints = true,
            ) { context.render(listOf(children[index])) }
        }

        fun paneWidth(role: String): Float {
            val widths = if (role == SplitPlan.SIDEBAR) plan.sidebar else plan.content
            return (widths.ideal.toFloat() + (paneDelta[role] ?: 0f))
                .coerceIn(widths.min.toFloat(), widths.max.toFloat())
        }

        if (plan.presentation == "stack") {
            Pane(plan.host, Modifier.fillMaxSize())
            if (plan.host != SplitPlan.DETAIL && selected) {
                // A pushed detail takes the keyboard the way the platform hosts hand it to a
                // pushed column, which is also what makes Escape reachable at all.
                val detailFocus = remember(context.node) { FocusRequester() }
                LaunchedEffect(detailFocus) { runCatching { detailFocus.requestFocus() } }
                Column(Modifier.fillMaxSize().background(color("background"))) {
                    // The web's pushed-detail Back band (`.dsx-split-back`, a 48px row):
                    // the pointer affordance Escape already mirrors, and the 48px content
                    // offset the parity plane measures.
                    Row(
                        Modifier.fillMaxWidth().height(48.dp)
                            .testTag("dsx.split.back")
                            .clickable { context.write(valueKey, "") }
                            .padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("‹", color = color("accent"))
                        Text(context.attributes["backLabel"] ?: "Back", color = color("accent"))
                    }
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        // The keyboard envelope stays ON the pane node (the tagged cell),
                        // so assistive focus and the Escape pop address the same target.
                        Pane(
                            SplitPlan.DETAIL,
                            Modifier.fillMaxSize()
                                .focusRequester(detailFocus)
                                .focusable()
                                .onPreviewKeyEvent { event ->
                                    if (event.type == KeyEventType.KeyDown && event.key == Key.Escape) {
                                        context.write(valueKey, "")
                                        true
                                    } else false
                                },
                        )
                    }
                }
            }
        } else {
            Row(Modifier.fillMaxSize()) {
                plan.columns.forEachIndexed { position, role ->
                    if (position > 0) {
                        val resized = plan.columns[position - 1]
                        DesktopSplitDivider(resizable) { travel ->
                            val widths = if (resized == SplitPlan.SIDEBAR) plan.sidebar else plan.content
                            paneDelta[resized] = ((paneDelta[resized] ?: 0f) + travel)
                                .coerceIn(
                                    (widths.min - widths.ideal).toFloat(),
                                    (widths.max - widths.ideal).toFloat(),
                                )
                        }
                    }
                    if (position == plan.columns.size - 1) {
                        val floor = if (role == SplitPlan.DETAIL) plan.detailMin.toFloat().dp else 0.dp
                        Pane(role, Modifier.weight(1f).fillMaxHeight().widthIn(min = floor))
                    } else {
                        Pane(role, Modifier.fillMaxHeight().width(paneWidth(role).dp))
                    }
                }
            }
        }

        // The web keeps every pane mounted (hidden panels measure 0x0); mirror that so
        // the node set matches structurally and pane state survives a plan change.
        val visible = buildSet {
            if (plan.presentation == "stack") {
                add(plan.roles.indexOf(plan.host))
                if (plan.host != SplitPlan.DETAIL && selected) add(plan.roles.indexOf(SplitPlan.DETAIL))
            } else {
                plan.columns.forEach { add(plan.roles.indexOf(it)) }
            }
            if (plan.overlay && sidebarOpen) add(plan.roles.indexOf(SplitPlan.SIDEBAR))
        }
        children.indices.forEach { index ->
            if (index !in visible) {
                DesktopHiddenPane { context.render(listOf(children[index])) }
            }
        }

        if (plan.overlay) {
            if (sidebarOpen) {
                Box(
                    Modifier.fillMaxSize().background(Color(0f, 0f, 0f, 0.32f))
                        .testTag("dsx.split.scrim")
                        .clickable { sidebarOpen = false },
                )
                Pane(
                    SplitPlan.SIDEBAR,
                    Modifier.fillMaxHeight().width(paneWidth(SplitPlan.SIDEBAR).dp)
                        .background(color("secondaryBackground")),
                )
            }
            Column(
                Modifier.padding(8.dp).size(40.dp)
                    .testTag("dsx.split.toggle")
                    .semantics {
                        role = Role.Button
                        contentDescription = if (sidebarOpen) "Hide sidebar" else "Show sidebar"
                    }
                    .clickable { sidebarOpen = !sidebarOpen }
                    .padding(11.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                repeat(3) {
                    Box(Modifier.fillMaxWidth().height(2.dp).background(color("secondaryLabel")))
                }
            }
        }
    }
}

/** The column hairline. Inert (a 1dp rule) unless the plan says the split is resizable, in which
 * case it becomes a 9dp horizontal drag target reporting its travel in dp. */
@Composable
private fun DesktopSplitDivider(resizable: Boolean, onDrag: (Float) -> Unit) {
    if (!resizable) {
        Box(Modifier.width(1.dp).fillMaxHeight().background(color("outline")).testTag("dsx.split.divider"))
        return
    }
    Box(
        Modifier.width(9.dp).fillMaxHeight()
            .testTag("dsx.split.divider")
            .semantics { contentDescription = "Resize panes" }
            .pointerInput(Unit) {
                detectDragGestures { change, amount ->
                    change.consume()
                    onDrag(amount.x.toDp().value)
                }
            },
        contentAlignment = Alignment.Center,
    ) { Box(Modifier.width(1.dp).fillMaxHeight().background(color("outline"))) }
}

@Composable
private fun DesktopStars(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val key = context.attributes["bind"].orEmpty()
    val value = JSE.number(context.bound(key))?.takeIf(Double::isFinite) ?: 0.0
    val count = context.num("count", 5.0).roundToInt().coerceIn(1, MAX_DESKTOP_STAR_COUNT)
    val size = context.num("size", 24.0).toFloat().coerceIn(8f, 128f)
    val readonly = disabled || context.bool("readonly")
    val tint = color(context.attributes["color"] ?: "#FFCC00")
    Row(modifier.semantics { stateDescription = "$value of $count stars" }, horizontalArrangement = Arrangement.spacedBy((size * 0.18f).dp)) {
        repeat(count) { index ->
            val fraction = (value - index).coerceIn(0.0, 1.0).toFloat()
            Canvas(
                Modifier.size(size.dp).clickable(enabled = !readonly, role = Role.Button) { context.write(key, (index + 1).toDouble()) }
                    .semantics { contentDescription = "${index + 1} stars" },
            ) {
                val path = starPath(this.size)
                drawPath(path, tint.copy(alpha = 0.3f), style = Stroke(this.size.width * 0.07f))
                if (fraction > 0f) clipRect(right = this.size.width * fraction) { drawPath(path, tint) }
            }
        }
    }
}

private fun starPath(size: Size): Path = Path().apply {
    val cx = size.width / 2f
    val cy = size.height / 2f
    val outer = size.minDimension / 2f
    repeat(10) { index ->
        val radius = if (index % 2 == 0) outer else outer * 0.4f
        val angle = PI / 2 + index * PI / 5
        val x = cx + (radius * cos(angle)).toFloat()
        val y = cy - (radius * sin(angle)).toFloat()
        if (index == 0) moveTo(x, y) else lineTo(x, y)
    }
    close()
}

@Composable
private fun DesktopWheelPicker(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val key = context.attributes["bind"].orEmpty()
    val options = context.options()
    if (options.isEmpty()) return
    val selected = context.textValue(key)
    val current = options.indexOfFirst { it.first == selected }.coerceAtLeast(0)
    val state = rememberLazyListState(initialFirstVisibleItemIndex = current)
    var interacted by remember(context.node) { mutableStateOf(false) }
    LaunchedEffect(state.isScrollInProgress) {
        if (state.isScrollInProgress) interacted = true
        else if (interacted) {
            val settled = state.firstVisibleItemIndex.coerceIn(0, options.lastIndex)
            context.write(key, options[settled].first)
            interacted = false
        }
    }
    LaunchedEffect(current) {
        if (!state.isScrollInProgress) state.scrollToItem(current)
    }
    LazyColumn(
        state = state,
        flingBehavior = rememberSnapFlingBehavior(state),
        modifier = modifier.height(216.dp).widthIn(min = 160.dp)
            .onPreviewKeyEvent { event ->
                if (disabled || event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val next = when (event.key) {
                    Key.DirectionUp -> (current - 1).coerceAtLeast(0)
                    Key.DirectionDown -> (current + 1).coerceAtMost(options.lastIndex)
                    else -> return@onPreviewKeyEvent false
                }
                if (next != current) context.write(key, options[next].first)
                true
            }.focusable().semantics { stateDescription = options[current].second },
        contentPadding = PaddingValues(vertical = 92.dp),
    ) {
        itemsIndexed(options) { index, option ->
            val isSelected = index == current
            Box(
                Modifier.fillMaxWidth().height(32.dp)
                    .background(if (isSelected) color("fill") else Color.Transparent, RoundedCornerShape(8.dp))
                    .clickable(enabled = !disabled) { context.write(key, option.first) }
                    .alpha(if (isSelected) 1f else 0.45f),
                contentAlignment = Alignment.Center,
            ) { Text(option.second, fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal) }
        }
    }
}
