@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package despia.engine.desktop

import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.IntrinsicSize
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import despia.engine.CSSEngine
import despia.engine.CSSInline
import despia.engine.CSSResolver
import despia.engine.JSE
import despia.engine.JSERunner
import despia.engine.Platform
import despia.engine.PlatformAttrs
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.writeBound
import java.awt.GraphicsEnvironment
import java.awt.Toolkit
import java.util.WeakHashMap
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.PI
import kotlin.math.pow

/** Per-surface legacy named-style definitions. The weak key preserves the
 * screen lifetime and prevents one mounted app from styling another. */
private object DesktopNamedStyles {
    private val lock = Any()
    private val values = WeakHashMap<StackStore, LinkedHashMap<String, Map<String, String>>>()

    fun register(store: StackStore, name: String, attributes: Map<String, String>) {
        synchronized(lock) {
            values.getOrPut(store) { LinkedHashMap() }[name] = attributes.toMap()
        }
    }

    fun get(store: StackStore, name: String): Map<String, String>? =
        synchronized(lock) { values[store]?.get(name)?.toMap() ?: builtIns[name] }

    /** The six documented legacy presets exist without an authored declaration on
     * every platform. An authored `<style as=...>` deliberately shadows its preset. */
    private val builtIns = mapOf(
        "sheet" to mapOf("padding" to "20", "background" to "#121212", "radius" to "24", "surface" to "sheet"),
        "card" to mapOf("padding" to "16", "background" to "rgba(255,255,255,0.06)", "radius" to "16"),
        "heading" to mapOf("fontSize" to "24", "fontWeight" to "bold"),
        "subheading" to mapOf("fontSize" to "15"),
        "rowTitle" to mapOf("fontSize" to "17", "fontWeight" to "semibold"),
        "price" to mapOf("fontSize" to "17", "fontWeight" to "bold"),
    )
}

private const val MAX_DESKTOP_NODE_OVERRIDES = 4_096
private const val MAX_DESKTOP_NODE_OVERRIDE_ATTRIBUTES = 128
private const val MAX_DESKTOP_NODE_OVERRIDE_VALUE_CHARS = 65_536
private const val MAX_DESKTOP_NODE_OVERRIDE_TOTAL_CHARS = 8 * 1_024 * 1_024
private val desktopNodeIdPattern = Regex("[A-Za-z0-9_.-]{1,128}")
private val desktopNodeAttributePattern = Regex("[A-Za-z_][A-Za-z0-9_.:-]{0,127}")

/** Compose-observable, surface-scoped imperative patches. A weak store key means a
 * dismissed surface cannot be retained by a package holding no other reference. */
private object DesktopNodeOverrides {
    private val lock = Any()
    private val values = WeakHashMap<StackStore, androidx.compose.runtime.snapshots.SnapshotStateMap<String, Map<String, String>>>()
    private val characterTotals = WeakHashMap<StackStore, Int>()

    fun map(store: StackStore) = synchronized(lock) {
        values.getOrPut(store) { mutableStateMapOf() }
    }

    fun set(store: StackStore, id: String, attribute: String, value: String) = synchronized(lock) {
        val all = values.getOrPut(store) { mutableStateMapOf() }
        val previous = all[id].orEmpty()
        if (id !in all && all.size >= MAX_DESKTOP_NODE_OVERRIDES) return@synchronized false
        if (attribute !in previous && previous.size >= MAX_DESKTOP_NODE_OVERRIDE_ATTRIBUTES) {
            return@synchronized false
        }
        val old = previous[attribute]
        val delta = value.length - (old?.length ?: 0) +
            (if (old == null) attribute.length else 0) +
            (if (id !in all) id.length else 0)
        val total = characterTotals[store] ?: 0
        if (delta > 0 && total > MAX_DESKTOP_NODE_OVERRIDE_TOTAL_CHARS - delta) {
            return@synchronized false
        }
        all[id] = previous + (attribute to value)
        characterTotals[store] = (total + delta).coerceAtLeast(0)
        true
    }

    fun clear(store: StackStore, id: String, attribute: String?) = synchronized(lock) {
        val all = values[store] ?: return@synchronized
        val previous = all[id] ?: return@synchronized
        val removed = if (attribute == null) {
            id.length + previous.entries.sumOf { (key, value) -> key.length + value.length }
        } else {
            val value = previous[attribute] ?: return@synchronized
            value.length + attribute.length + if (previous.size == 1) id.length else 0
        }
        if (attribute == null || previous.size == 1) all.remove(id)
        else all[id] = previous - attribute
        characterTotals[store] = ((characterTotals[store] ?: 0) - removed).coerceAtLeast(0)
    }
}

/** Native package escape hatch matching `ui.node("#id").set(...)` on Swift. Every
 * mutation rejoins the desktop UI thread and is bounded before entering Compose. */
class DesktopNodeHandle internal constructor(
    private val id: String,
    private val store: StackStore,
) {
    fun set(attribute: String, value: String, animated: Boolean = false): DesktopNodeHandle {
        require(desktopNodeAttributePattern.matches(attribute)) { "Invalid DSX node attribute" }
        require(value.length <= MAX_DESKTOP_NODE_OVERRIDE_VALUE_CHARS) { "DSX node override value is too large" }
        DesktopUiDispatcher.dispatch {
            val change: () -> Unit = { DesktopNodeOverrides.set(store, id, attribute, value); Unit }
            if (animated) JSERunner.withAnimation(change) else change()
        }
        return this
    }

    fun clear(attribute: String? = null): DesktopNodeHandle {
        require(attribute == null || desktopNodeAttributePattern.matches(attribute)) { "Invalid DSX node attribute" }
        DesktopUiDispatcher.dispatch {
            DesktopNodeOverrides.clear(store, id, attribute)
        }
        return this
    }
}

fun StackStore.desktopNode(id: String): DesktopNodeHandle {
    val canonical = id.removePrefix("#")
    require(desktopNodeIdPattern.matches(canonical)) { "Invalid DSX node id" }
    return DesktopNodeHandle(canonical, this)
}

internal fun registerDesktopNamedStyle(store: StackStore, attrs: Map<String, String>) {
    val name = attrs["as"]?.trim().orEmpty()
    if (name.isEmpty()) return
    DesktopNamedStyles.register(store, name, attrs.filterKeys { it != "as" && it != "id" })
}

/** Tracked Compose Desktop environment for the shared DSX-CSS engine. */
@Composable
internal fun desktopCssEnvironment(): CSSResolver.Context {
    val dark = isSystemInDarkTheme()
    val density = LocalDensity.current
    val size = LocalWindowInfo.current.containerSize
    val reduceMotion = remember { desktopReduceMotionEnabled() }
    return CSSResolver.Context(
        isDark = dark,
        windowWidth = with(density) { size.width.toDp().value.toDouble() },
        windowHeight = with(density) { size.height.toDp().value.toDouble() },
        fontScale = density.fontScale.toDouble(),
        reduceMotion = reduceMotion,
    )
}

internal fun desktopReduceMotionEnabled(): Boolean =
    System.getProperty("dsx.reduceMotion")?.equals("true", ignoreCase = true) == true ||
        runCatching {
            !GraphicsEnvironment.isHeadless() &&
                Toolkit.getDefaultToolkit().getDesktopProperty("awt.reduceMotion") == true
        }.getOrDefault(false)

@Composable
internal fun desktopFontSize(attrs: Map<String, String>): TextUnit {
    val points = boundedNumberOrNull(attrs["fontSize"], 0.5f, 512f) ?: return TextUnit.Unspecified
    val fontScale = LocalDensity.current.fontScale.takeIf(Float::isFinite)?.coerceIn(0.01f, 10f) ?: 1f
    val dynamicMaximum = boundedNumberOrNull(attrs["dynamicTypeMax"], 0.5f, 512f) ?: 512f
    val effective = if (attrs["dynamicType"] == "true") {
        (points * fontScale).coerceAtMost(dynamicMaximum)
    } else points
    // Compose Desktop applies fontScale to sp. Divide here for the fixed-size
    // default; opt-in Dynamic Type restores the scaled effective size above.
    return (effective / fontScale).sp
}

/** Explicit runtime inventory for the legacy DSX style vocabulary. These are
 * executable classifications, not release-label substitutions: the focused tests
 * exercise each pure parser and the Compose UI suite exercises every paint family. */
internal val desktopStyleDeterministicDegradations: Map<String, String> = linkedMapOf(
    "fontDesign:rounded" to "platform sans-serif fallback (no bundled rounded family)",
    "surface" to "native Compose translucent material fallback (no browser/WebView)",
    "glassInteractive" to "static material on Windows/Linux; activation remains native",
    "shadowX" to "Compose elevation light has a platform-owned x offset",
    "shadowY" to "Compose elevation light has a platform-owned y offset",
    "ignoreSafeArea" to "desktop windows report zero mobile safe-area insets",
)

internal fun desktopAspectRatio(raw: String?): Float? {
    if (raw == null) return null
    val ratio = if (':' in raw) {
        val parts = raw.split(':')
        if (parts.size != 2) return null
        val width = parts[0].toDoubleOrNull()?.takeIf(Double::isFinite) ?: return null
        val height = parts[1].toDoubleOrNull()?.takeIf(Double::isFinite) ?: return null
        if (height == 0.0) return null
        width / height
    } else raw.toDoubleOrNull()?.takeIf(Double::isFinite) ?: return null
    return ratio.toFloat().takeIf { it.isFinite() && it > 0f && it <= 1_000_000f }
}

internal fun desktopGradientColors(raw: String?): List<String>? {
    val values = raw?.split('|')?.map(String::trim)?.filter(String::isNotEmpty) ?: return null
    return values.takeIf { it.size in 2..64 }
}

internal fun desktopGradientAxis(raw: String?): Pair<Offset, Offset> = when (raw) {
    "horizontal" -> Offset.Zero to Offset(Float.POSITIVE_INFINITY, 0f)
    "diagonal" -> Offset.Zero to Offset.Infinite
    else -> Offset.Zero to Offset(0f, Float.POSITIVE_INFINITY)
}

internal fun desktopMaterialColor(name: String): Color = when (name) {
    "thin" -> Color(0xB3252525)
    "regular" -> Color(0xD1252525)
    "thick" -> Color(0xE6252525)
    else -> Color(0x8C252525)
}

private fun Modifier.desktopGrowAlignment(
    growWidth: Boolean,
    growHeight: Boolean,
    horizontal: String?,
    vertical: String?,
): Modifier = layout { measurable, constraints ->
    val child = measurable.measure(
        constraints.copy(
            minWidth = if (growWidth) 0 else constraints.minWidth,
            minHeight = if (growHeight) 0 else constraints.minHeight,
        ),
    )
    val width = if (growWidth && constraints.hasBoundedWidth) constraints.maxWidth else child.width
    val height = if (growHeight && constraints.hasBoundedHeight) constraints.maxHeight else child.height
    val x = when (horizontal) {
        "center" -> (width - child.width) / 2
        "trailing", "right", "end", "flex-end" -> width - child.width
        else -> 0
    }.coerceAtLeast(0)
    val y = when (vertical) {
        "center" -> (height - child.height) / 2
        "bottom", "end", "flex-end" -> height - child.height
        else -> 0
    }.coerceAtLeast(0)
    layout(width.coerceIn(constraints.minWidth, constraints.maxWidth), height.coerceIn(constraints.minHeight, constraints.maxHeight)) {
        child.place(x, y)
    }
}

/** The Windows/Linux style onion. Every numeric path is finite and bounded before
 * it reaches a Compose measurement, layer or Skia allocation. */
@Composable
internal fun desktopStyleModifier(base: Modifier, attrs: Map<String, String>): Modifier {
    var modifier = base
    fun wrap(step: Modifier) { modifier = step.then(modifier) }

    // Resolve the shorthand once, then let axis/edge values replace it. Stacking
    // multiple padding modifiers would add the values (16 + 8) instead of applying
    // the DSX/CSS cascade (top = 8), and would inflate both layout and hit targets.
    val padding = boundedNumberOrNull(attrs["padding"], 0f, MAX_DESKTOP_LAYOUT_DP)
    val paddingH = boundedNumberOrNull(attrs["paddingH"] ?: attrs["paddingX"], 0f, MAX_DESKTOP_LAYOUT_DP)
    val paddingV = boundedNumberOrNull(attrs["paddingV"] ?: attrs["paddingY"], 0f, MAX_DESKTOP_LAYOUT_DP)
    val paddingTop = boundedNumberOrNull(attrs["paddingTop"], 0f, MAX_DESKTOP_LAYOUT_DP) ?: paddingV ?: padding
    val paddingBottom = boundedNumberOrNull(attrs["paddingBottom"], 0f, MAX_DESKTOP_LAYOUT_DP) ?: paddingV ?: padding
    val paddingStart = boundedNumberOrNull(
        attrs["paddingLeading"] ?: attrs["paddingLeft"],
        0f,
        MAX_DESKTOP_LAYOUT_DP,
    ) ?: paddingH ?: padding
    val paddingEnd = boundedNumberOrNull(
        attrs["paddingTrailing"] ?: attrs["paddingRight"],
        0f,
        MAX_DESKTOP_LAYOUT_DP,
    ) ?: paddingH ?: padding
    if (paddingTop != null || paddingBottom != null || paddingStart != null || paddingEnd != null) {
        wrap(Modifier.padding(
            start = (paddingStart ?: 0f).dp,
            top = (paddingTop ?: 0f).dp,
            end = (paddingEnd ?: 0f).dp,
            bottom = (paddingBottom ?: 0f).dp,
        ))
    }

    val width = attrs["width"]
    val height = attrs["height"]
    boundedNumberOrNull(width, 0f, MAX_DESKTOP_LAYOUT_DP)?.let { wrap(Modifier.width(it.dp)) }
    boundedNumberOrNull(height, 0f, MAX_DESKTOP_LAYOUT_DP)?.let { wrap(Modifier.height(it.dp)) }
    if (width == "fit" || width == "fit-content") wrap(Modifier.width(IntrinsicSize.Max))
    if (height == "fit" || height == "fit-content") wrap(Modifier.height(IntrinsicSize.Min))

    val minWidth = boundedNumberOrNull(attrs["minWidth"], 0f, MAX_DESKTOP_LAYOUT_DP)
    val maxWidth = boundedNumberOrNull(attrs["maxWidth"], 0f, MAX_DESKTOP_LAYOUT_DP)
    val minHeight = boundedNumberOrNull(attrs["minHeight"], 0f, MAX_DESKTOP_LAYOUT_DP)
    val maxHeight = boundedNumberOrNull(attrs["maxHeight"], 0f, MAX_DESKTOP_LAYOUT_DP)
    val grow = attrs["grow"]
    val growWidth = grow == "true" || grow == "both" || grow == "width"
    val growHeight = grow == "true" || grow == "both" || grow == "height"
    if (minWidth != null || maxWidth != null) {
        wrap(Modifier.widthIn(
            min = (minWidth ?: 0f).dp,
            max = (maxWidth ?: MAX_DESKTOP_LAYOUT_DP).coerceAtLeast(minWidth ?: 0f).dp,
        ))
    }
    if (minHeight != null || maxHeight != null) {
        wrap(Modifier.heightIn(
            min = (minHeight ?: 0f).dp,
            max = (maxHeight ?: MAX_DESKTOP_LAYOUT_DP).coerceAtLeast(minHeight ?: 0f).dp,
        ))
    }
    val horizontalAnchor = attrs["alignItems"] ?: attrs["align"]
    val verticalAnchor = attrs["alignY"] ?: attrs["align"]
    if ((growWidth || growHeight) && (horizontalAnchor != null || verticalAnchor != null)) {
        wrap(Modifier.desktopGrowAlignment(growWidth, growHeight, horizontalAnchor, verticalAnchor))
    } else when (grow) {
        "true", "both" -> wrap(Modifier.fillMaxSize())
        "width" -> wrap(Modifier.fillMaxWidth())
        "height" -> wrap(Modifier.fillMaxHeight())
    }

    val radius = boundedNumberOrNull(attrs["radius"], 0f, MAX_DESKTOP_LAYOUT_DP) ?: 0f
    val shape = if (radius > 0f) RoundedCornerShape(radius.dp) else RectangleShape
    attrs["background"]?.let { wrap(Modifier.background(color(it, attrs["theme"]), shape)) }
    desktopGradientColors(attrs["gradient"])?.let { stops ->
        val (start, end) = desktopGradientAxis(attrs["gradientDir"])
        wrap(Modifier.background(Brush.linearGradient(stops.map { color(it, attrs["theme"]) }, start = start, end = end)))
    }
    attrs["surface"]?.let { surface ->
        val surfaceRadius = boundedNumberOrNull(attrs["radius"], 0f, MAX_DESKTOP_LAYOUT_DP)
            ?: if (surface == "sheet") 24f else 16f
        val fill = attrs["glassTint"]?.let { color(it, attrs["theme"]) } ?: desktopMaterialColor(surface)
        wrap(Modifier.background(fill, RoundedCornerShape(surfaceRadius.dp)))
    }
    if (radius > 0f) wrap(Modifier.clip(shape))
    desktopAspectRatio(attrs["aspectRatio"])?.let { wrap(Modifier.aspectRatio(it)) }
    // A top-level Windows/Linux window has no mobile safe-area insets. Accepting
    // ignoreSafeArea/fullBleed is therefore a deterministic identity transform.
    boundedNumberOrNull(attrs["opacity"], 0f, 1f)?.let { wrap(Modifier.alpha(it)) }
    boundedNumberOrNull(attrs["rotation"], -360_000f, 360_000f)?.let { wrap(Modifier.rotate(it)) }
    boundedNumberOrNull(attrs["scale"], 0f, 100f)?.let { scale ->
        wrap(Modifier.graphicsLayer { scaleX = scale; scaleY = scale })
    }
    boundedNumberOrNull(attrs["blur"], 0f, 1_024f)?.let { wrap(Modifier.blur(it.dp)) }
    attrs["borderColor"]?.let { border ->
        val borderWidth = boundedNumber(attrs["borderWidth"], 1f, 0f, 1_024f)
        wrap(Modifier.border(borderWidth.dp, color(border, attrs["theme"]), shape))
    }
    attrs["shadow"]?.let { raw ->
        val elevation = boundedNumber(raw, 8f, 0f, 1_024f)
        val shadowColor = attrs["shadowColor"]?.let { color(it, attrs["theme"]) } ?: Color.Black.copy(alpha = 0.25f)
        wrap(Modifier.shadow(elevation.dp, shape, clip = false, ambientColor = shadowColor, spotColor = shadowColor))
    }
    if (attrs["offset"] != null || attrs["offsetX"] != null || attrs["offsetY"] != null) {
        val x = boundedNumber(attrs["offsetX"], 0f, -MAX_DESKTOP_LAYOUT_DP, MAX_DESKTOP_LAYOUT_DP)
        val y = boundedNumber(attrs["offsetY"] ?: attrs["offset"], 0f, -MAX_DESKTOP_LAYOUT_DP, MAX_DESKTOP_LAYOUT_DP)
        wrap(Modifier.offset(x.dp, y.dp))
    }
    boundedNumberOrNull(attrs["zIndex"], -1_000_000f, 1_000_000f)?.let { wrap(Modifier.zIndex(it)) }
    return modifier
}

@Composable
internal fun desktopVisibilityModifier(
    base: Modifier,
    node: StackNode,
    attrs: Map<String, String>,
    visible: Boolean,
    keepAlive: Boolean,
    animateOnMount: Boolean = false,
): Modifier {
    val css = desktopCssEnvironment()
    val reduceMotion = css.reduceMotion
    // `keep=true` has one deliberately snappier default in the canonical Swift/
    // Android contract. An explicitly authored curve rejoins the normal grammar.
    val profile = when {
        reduceMotion -> DesktopMotionProfile("linear", 0)
        keepAlive && attrs["anim"] == null -> DesktopMotionProfile("easeOut", 180)
        else -> desktopMotionProfile(attrs)
    }
    var entered by remember(node) {
        mutableStateOf((attrs["enter"] == null && !animateOnMount) || reduceMotion)
    }
    LaunchedEffect(node, animateOnMount, reduceMotion) { entered = true }
    val active = visible && entered
    val motion = if (visible) attrs["enter"] ?: attrs["transition"] else attrs["exit"] ?: attrs["transition"]
    val spec = desktopMotionSpec(profile)
    val alpha by animateFloatAsState(if (active) 1f else 0f, spec, label = "dsx-desktop-visibility")
    val scale by animateFloatAsState(
        if (!active && motion == "scale") 0.94f else 1f,
        spec,
        label = "dsx-desktop-motion-scale",
    )
    val x by animateFloatAsState(
        if (!active) when (motion) {
            "slide-left" -> -css.windowWidth.toFloat().coerceIn(0f, MAX_DESKTOP_LAYOUT_DP)
            "slide-right" -> css.windowWidth.toFloat().coerceIn(0f, MAX_DESKTOP_LAYOUT_DP)
            else -> 0f
        } else 0f,
        spec,
        label = "dsx-desktop-motion-x",
    )
    val y by animateFloatAsState(
        if (!active) when (motion) {
            "slide-top" -> -css.windowHeight.toFloat().coerceIn(0f, MAX_DESKTOP_LAYOUT_DP)
            "slide-bottom" -> css.windowHeight.toFloat().coerceIn(0f, MAX_DESKTOP_LAYOUT_DP)
            else -> 0f
        } else 0f,
        spec,
        label = "dsx-desktop-motion-y",
    )
    return base.alpha(alpha).scale(scale).offset(x.dp, y.dp)
}

internal data class DesktopMotionProfile(
    val curve: String,
    val durationMillis: Int,
    val dampingRatio: Float? = null,
    val stiffness: Float? = null,
)

/** Bounded once for both the animation and the exit-hold lifetime. Spring's
 * documented response defaults to 0.4 s; authored animDuration replaces it. */
internal fun desktopMotionDurationMillis(attrs: Map<String, String>): Int {
    val default = if (attrs["anim"] == "spring") 0.4 else 0.35
    val seconds = attrs["animDuration"]?.toDoubleOrNull()?.takeIf(Double::isFinite) ?: default
    return (seconds.coerceIn(0.0, 10.0) * 1_000.0).toInt()
}

internal fun desktopMotionProfile(
    attrs: Map<String, String>,
    durationMillis: Int = desktopMotionDurationMillis(attrs),
): DesktopMotionProfile {
    val curve = attrs["anim"].takeIf { it in setOf("spring", "linear", "easeIn", "easeOut", "easeInOut") }
        ?: "easeInOut"
    if (curve != "spring") return DesktopMotionProfile(curve, durationMillis)
    if (durationMillis <= 0) return DesktopMotionProfile("linear", 0)
    // Compose uses stiffness while SwiftUI documents response. For a unit-mass
    // oscillator response is one natural period: stiffness = (2pi / response)^2.
    val response = (durationMillis / 1_000.0).coerceIn(0.001, 10.0)
    val stiffness = ((2.0 * PI) / response).pow(2.0).toFloat().coerceIn(0.01f, 100_000f)
    return DesktopMotionProfile(curve, durationMillis, dampingRatio = 0.8f, stiffness = stiffness)
}

private fun desktopMotionSpec(profile: DesktopMotionProfile): AnimationSpec<Float> =
    when (profile.curve) {
        "spring" -> spring(
            dampingRatio = profile.dampingRatio ?: 0.8f,
            stiffness = profile.stiffness ?: 246.74f,
        )
        "linear" -> tween(profile.durationMillis, easing = LinearEasing)
        "easeIn" -> tween(profile.durationMillis, easing = CubicBezierEasing(0.42f, 0f, 1f, 1f))
        "easeOut" -> tween(profile.durationMillis, easing = CubicBezierEasing(0f, 0f, 0.58f, 1f))
        else -> tween(profile.durationMillis, easing = CubicBezierEasing(0.42f, 0f, 0.58f, 1f))
    }

/** Full desktop attribute cascade: named styles, compiled component sheets,
 * inline DSX-CSS, explicit attributes, platform suffixes, then interpolation. */
@Composable
internal fun desktopResolvedAttributes(
    node: StackNode,
    store: StackStore,
    item: Map<String, Any?>?,
): Map<String, String> {
    val overrides = node.id.takeIf(String::isNotEmpty)
        ?.let { id -> DesktopNodeOverrides.map(store)[id] }
        .orEmpty()
    var authored: Map<String, String> = node.attrs + overrides
    authored = PlatformAttrs.resolve(authored, Platform.attributeTarget)
    val css = desktopCssEnvironment()
    val classText = authored["class"]?.let { JSE.interpolate(it, store, item) }.orEmpty()
    val styleText = authored["style"]?.let { JSE.interpolate(it, store, item) }
    val named = buildList {
        addAll(classText.split(Regex("\\s+")).filter(String::isNotEmpty))
        if (styleText != null && !styleText.contains(':')) {
            addAll(styleText.split(Regex("\\s+")).filter(String::isNotEmpty))
        }
    }
    val classes = named.toSet()
    val base = LinkedHashMap<String, String>()
    named.forEach { name -> DesktopNamedStyles.get(store, name)?.let(base::putAll) }

    val inline = styleText?.takeIf { it.contains(':') }
    val elementTokens = inline?.let(CSSInline::customProperties).orEmpty()
    authored["css-owner"]?.takeIf { classes.isNotEmpty() }?.let { owner ->
        base.putAll(CSSEngine.sheetAttributes(owner, css.copy(classes = classes), elementTokens))
    }
    inline?.let { source ->
        base.putAll(CSSEngine.inlineAttributes(source, css.copy(classes = classes), authored["css-owner"]))
        authored = authored - "style"
    }
    // Gap translation is necessarily node-aware: CSS row/column gaps describe
    // physical axes while the legacy renderer consumes one main-axis `spacing`.
    // Keep this in the CSS layer so an explicit DSX spacing= attribute below wins.
    if (base["rowGap"] != null || base["columnGap"] != null) {
        val direction = authored["flexDirection"] ?: base["flexDirection"] ?: "column"
        val horizontal = node.tag in setOf("hstack", "toolbar", "flow") ||
            node.tag in setOf("stack", "vstack", "card") && direction.startsWith("row")
        (if (horizontal) base["columnGap"] else base["rowGap"])?.let { base["spacing"] = it }
    }
    base.putAll(authored)
    // Imperative id patches are the final authored layer. In particular a
    // `set("width", ...)` must beat an existing `width:windows`/`width:linux`
    // suffix; parsing class/style above still lets those two patch forms enter
    // the same canonical CSS cascade rather than bypassing it.
    base.putAll(PlatformAttrs.resolve(overrides, Platform.attributeTarget))
    var resolved = PlatformAttrs.resolve(base, Platform.attributeTarget)
        .mapValues { (_, value) -> JSE.interpolate(value, store, item) }
    if (resolved["display"] == "none") resolved = resolved + ("css-hidden" to "true")
    return resolved
}

/** `<watch value=… on:change=…/>` is headless but reactive and budgeted by
 * JSERunner, matching the existing Android/Swift contract. */
@Composable
internal fun DesktopWatch(
    attrs: Map<String, String>,
    store: StackStore,
    runner: JSERunner,
    item: Map<String, Any?>?,
) {
    val expression = attrs["value"].orEmpty()
    val value = JSE.eval(expression, store, item)
    val key = JSE.watchKey(value)
    val previous = remember { mutableStateOf<String?>(null) }
    SideEffect {
        val old = previous.value
        previous.value = key
        if ((old == null && attrs["immediate"] == "true") || (old != null && old != key)) {
            runner.fireWatch(value, attrs["on:change"].orEmpty(), expression)
        }
    }
}

/** `<attribute as=x on:change=...>` is the component-input observer twin of
 * DesktopWatch. The value resolves consumer attrs, live `dsx.attribute`, then the
 * registered default through JSE's one canonical lookup path. */
@Composable
internal fun DesktopAttribute(
    attrs: Map<String, String>,
    store: StackStore,
    runner: JSERunner,
    item: Map<String, Any?>?,
) {
    val name = attrs["as"]?.takeIf(String::isNotBlank) ?: return
    attrs["default"]?.let { store.attrDefaults.putIfAbsent(name, it) }
    val change = attrs["on:change"].orEmpty()
    if (change.isEmpty()) return
    val expression = "dsx.attribute.$name"
    val value = JSE.eval(expression, store, item)
    val key = JSE.watchKey(value)
    val previous = remember(name) { mutableStateOf<String?>(null) }
    SideEffect {
        val old = previous.value
        previous.value = key
        if ((old == null && attrs["immediate"] == "true") || (old != null && old != key)) {
            runner.fireWatch(value, change, expression)
        }
    }
}

private val desktopSelfHandlingTapTags = setOf(
    "button", "glassButton", "transport", "pressable", "row",
)

/** Native controls already own activation/focus semantics. Normal taps are observed
 * without consumption. Once a long press is recognized, its trailing pointer changes
 * are consumed in the Initial pass so the nested native clickable cannot also emit a
 * release click (the recognizer still leaves focus/keyboard semantics to the control). */
private val desktopNativeInteractionTags = setOf(
    "button", "glassButton", "transport", "pressable", "row", "textfield", "input", "textarea",
    "toggle", "switch", "checkbox", "slider", "rangeSlider", "picker", "combobox", "segmented",
    "segmentedButton", "stepper", "tabs", "tabview", "alert", "confirmDialog",
) + desktopExtendedNativeTags

internal fun desktopEventArguments(
    attrs: Map<String, String>,
    store: StackStore,
    item: Map<String, Any?>?,
): Map<String, Any?> {
    val result = LinkedHashMap<String, Any?>()
    attrs.forEach { (key, raw) ->
        if (!key.startsWith("arg:") || key.length == 4) return@forEach
        val value = JSE.interpolate(raw, store, item)
        result[key.substring(4)] = when (value) {
            "true" -> true
            "false" -> false
            else -> JSE.number(value) ?: value
        }
    }
    return result
}

internal fun desktopRunEvent(
    node: StackNode,
    event: String,
    action: String,
    attrs: Map<String, String>,
    store: StackStore,
    runner: JSERunner,
    item: Map<String, Any?>?,
    extra: Map<String, Any?> = emptyMap(),
) {
    val arguments = desktopEventArguments(attrs, store, item) + extra
    // Event payload is both the action argument bag and the current `dsx.this`
    // context. This is what lets direct handlers, named actions, drag handlers,
    // and emitted events observe the same typed arg:* values; an explicit event
    // value wins over a same-named row field, matching event-payload semantics.
    val eventItem = when {
        arguments.isEmpty() -> item
        item == null -> arguments
        else -> item + arguments
    }
    val identity = node.id.ifEmpty { Integer.toUnsignedString(System.identityHashCode(node), 16) }
    runner.runGated(
        action,
        eventItem,
        arguments,
        debounceMs = JSERunner.gateMs(attrs, event, "debounce"),
        throttleMs = JSERunner.gateMs(attrs, event, "throttle"),
        gateKey = "${node.tag}:$identity:$event",
    )
}

private fun Modifier.observeDesktopNativeGesture(
    key: Any,
    onTap: (() -> Unit)?,
    onLongPress: (() -> Unit)?,
): Modifier = pointerInput(key, onTap, onLongPress) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        var moved = false
        var pressed = true
        val releasedBeforeLongPress = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
            while (pressed) {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                moved = moved || event.changes.any { it.positionChange().getDistance() > viewConfiguration.touchSlop }
                pressed = event.changes.any { it.pressed }
            }
            true
        }
        if (releasedBeforeLongPress == null) {
            if (!moved) onLongPress?.invoke()
            while (pressed) {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                if (!moved && onLongPress != null) event.changes.forEach { it.consume() }
                pressed = event.changes.any { it.pressed }
            }
        } else if (!moved) {
            onTap?.invoke()
        }
        // Normal taps are never consumed: the native control remains the owner of
        // selection/click and keyboard semantics. A recognized long press consumes
        // only its trailing changes so release cannot also dispatch the native click.
    }
}

/** Universal pointer/measurement/accessibility modifier for ordinary elements.
 * Native controls retain their own click semantics to prevent double dispatch. */
@Composable
internal fun desktopUniversalModifier(
    base: Modifier,
    node: StackNode,
    attrs: Map<String, String>,
    store: StackStore,
    runner: JSERunner,
    item: Map<String, Any?>?,
    disabled: Boolean,
): Modifier {
    var modifier = base

    val density = LocalDensity.current
    val measureKey = attrs["measure"]
    if (!measureKey.isNullOrBlank()) {
        modifier = Modifier.onSizeChanged { size ->
            val value = with(density) {
                mapOf("width" to size.width.toDp().value.toDouble(), "height" to size.height.toDp().value.toDouble())
            }
            if (JSE.eval(measureKey, store, item) != value) store.writeBound(measureKey, value)
        }.then(modifier)
    }

    val adjust = attrs["on:adjust"]
    val nativeLongPress = attrs["on:longpress"]?.takeIf(String::isNotBlank)
        ?.takeIf { node.tag in desktopNativeInteractionTags && !disabled }
    if ((!adjust.isNullOrBlank() || nativeLongPress != null) && !disabled) {
        modifier = Modifier.semantics {
            customActions = buildList {
                if (!adjust.isNullOrBlank()) {
                    add(CustomAccessibilityAction("Increment") {
                        desktopRunEvent(
                            node, "adjust", adjust, attrs, store, runner, item,
                            mapOf("direction" to "increment", "phase" to "adjust"),
                        )
                        true
                    })
                    add(CustomAccessibilityAction("Decrement") {
                        desktopRunEvent(
                            node, "adjust", adjust, attrs, store, runner, item,
                            mapOf("direction" to "decrement", "phase" to "adjust"),
                        )
                        true
                    })
                }
                nativeLongPress?.let { action ->
                    add(CustomAccessibilityAction("Long press") {
                        desktopRunEvent(node, "longpress", action, attrs, store, runner, item); true
                    })
                }
            }
        }.then(modifier)
    }

    val ownsTap = node.tag in desktopSelfHandlingTapTags
    val nativeInteraction = node.tag in desktopNativeInteractionTags
    val tap = attrs["on:tap"]?.takeIf(String::isNotBlank).takeUnless { ownsTap || disabled }
    val longPress = attrs["on:longpress"]?.takeIf(String::isNotBlank).takeUnless { disabled }
    if (!nativeInteraction && (tap != null || longPress != null)) {
        // combinedClickable is the Compose-native interaction primitive: unlike a
        // pointer recognizer it exposes click/long-click semantics to assistive tech,
        // participates in focus traversal, and activates from Enter/Space. Native
        // controls in desktopSelfHandlingTapTags keep their own single handler.
        modifier = Modifier.combinedClickable(
            enabled = true,
            onLongClick = longPress?.let { action ->
                { desktopRunEvent(node, "longpress", action, attrs, store, runner, item) }
            },
            onClick = {
                tap?.let { desktopRunEvent(node, "tap", it, attrs, store, runner, item) }
            },
        ).then(modifier)
    } else if (nativeInteraction && (tap != null || longPress != null)) {
        modifier = Modifier.observeDesktopNativeGesture(
            key = node,
            onTap = tap?.let { action ->
                { desktopRunEvent(node, "tap", action, attrs, store, runner, item) }
            },
            onLongPress = longPress?.let { action ->
                { desktopRunEvent(node, "longpress", action, attrs, store, runner, item) }
            },
        ).then(modifier)
    }

    val drag = attrs["on:drag"].takeUnless { disabled }
    val dragEnd = attrs["on:dragEnd"].takeUnless { disabled }
    if (drag != null || dragEnd != null) {
        var size by remember(node) { mutableStateOf(IntSize.Zero) }
        var position by remember(node) { mutableStateOf(Offset.Zero) }
        modifier = Modifier
            .onSizeChanged { size = it }
            .pointerInput(node, drag, dragEnd, size) {
                detectDragGestures(
                    onDragStart = { start ->
                        position = start
                        drag?.let {
                            desktopRunEvent(
                                node, "drag", it, attrs, store, runner, item,
                                dragPayload(position, Offset.Zero, size, "start"),
                            )
                        }
                    },
                    onDrag = { change, amount ->
                        position += amount
                        drag?.let {
                            desktopRunEvent(
                                node, "drag", it, attrs, store, runner, item,
                                dragPayload(position, amount, size, "drag"),
                            )
                        }
                        change.consume()
                    },
                    onDragEnd = {
                        val payload = dragPayload(position, Offset.Zero, size, "end")
                        dragEnd?.let {
                            desktopRunEvent(node, "dragEnd", it, attrs, store, runner, item, payload)
                        }
                    },
                    onDragCancel = {
                        val payload = dragPayload(position, Offset.Zero, size, "cancel")
                        dragEnd?.let {
                            desktopRunEvent(node, "dragEnd", it, attrs, store, runner, item, payload)
                        }
                    },
                )
            }
            .then(modifier)
    }
    // Keep the test/automation identity outside every universal interaction and
    // layout envelope. Compose then exposes the tagged node's complete bounds and
    // merged click/long-click actions instead of a tagged child underneath the
    // clickable semantics node.
    attrs["id"]?.takeIf(String::isNotBlank)?.let { modifier = Modifier.testTag(it).then(modifier) }
    return modifier
}

private fun dragPayload(position: Offset, delta: Offset, size: IntSize, phase: String): Map<String, Any?> {
    val width = size.width.coerceAtLeast(1).toDouble()
    val height = size.height.coerceAtLeast(1).toDouble()
    return mapOf(
        "fraction" to (position.x.toDouble() / width).coerceIn(0.0, 1.0),
        "fractionY" to (position.y.toDouble() / height).coerceIn(0.0, 1.0),
        "x" to position.x.toDouble(), "y" to position.y.toDouble(),
        "width" to width, "height" to height,
        "dx" to delta.x.toDouble(), "dy" to delta.y.toDouble(),
        "phase" to phase,
    )
}
