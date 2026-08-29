@file:OptIn(
    androidx.compose.foundation.ExperimentalFoundationApi::class,
    androidx.compose.ui.ExperimentalComposeUiApi::class,
)

package despia.engine.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.AlertDialog
import androidx.compose.material.Button
import androidx.compose.material.ButtonDefaults
import androidx.compose.material.LocalTextStyle
import androidx.compose.material.Checkbox
import androidx.compose.material.CircularProgressIndicator
import androidx.compose.material.Divider
import androidx.compose.material.DropdownMenu
import androidx.compose.material.DropdownMenuItem
import androidx.compose.material.LinearProgressIndicator
import androidx.compose.material.MaterialTheme
import androidx.compose.material.OutlinedTextField
import androidx.compose.material.OutlinedButton
import androidx.compose.material.Slider
import androidx.compose.material.Switch
import androidx.compose.material.Tab
import androidx.compose.material.TabRow
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import despia.engine.DSX
import despia.engine.AdaptiveShell
import despia.engine.StackDesktopInput
import despia.engine.JSE
import despia.engine.JSERunner
import despia.engine.LayoutSemantics
import despia.engine.NSNull
import despia.engine.OnHandler
import despia.engine.OverrideDecl
import despia.engine.Platform
import despia.engine.PlatformAttrs
import despia.engine.SlotContent
import despia.engine.StyleOverrides
import despia.engine.StackFormula
import despia.engine.StackFonts
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.getPath
import despia.engine.registerAction
import despia.engine.registerHeadFunctions
import despia.engine.setPath
import despia.engine.varsFlow
import despia.engine.writeBound
import kotlin.math.roundToInt
import java.util.IdentityHashMap
import kotlinx.coroutines.delay

/** Extension point for desktop-capable packages. Registration happens at process boot;
 * unknown/unshipped elements remain empty by contract, while their children can still
 * degrade through a wrapper component. */
object DesktopElements {
    private val lock = Any()
    private val renderers = LinkedHashMap<String, @Composable (DesktopElementContext) -> Unit>()

    fun register(tag: String, renderer: @Composable (DesktopElementContext) -> Unit) {
        val key = tag.trim()
        require(key.matches(Regex("[A-Za-z][A-Za-z0-9_.-]{0,127}"))) { "Invalid DSX desktop element tag" }
        synchronized(lock) { renderers[key] = renderer }
    }

    internal fun renderer(tag: String): (@Composable (DesktopElementContext) -> Unit)? =
        synchronized(lock) { renderers[tag] }
}

/** The tags whose semantics are owned by the desktop binary rather than by an
 * authored component table. Keep the core dispatch vocabulary in one executable
 * catalog so a remote component cannot get in front of a `when (node.tag)` branch.
 * Package renderers are checked dynamically because they register during boot. */
internal val desktopRendererOwnedTags: Set<String> = linkedSetOf(
    "head", "api", "event", "expects", "action", "variable", "var", "let", "formula",
    "script", "functions", "style", "attribute", "override", "component", "watch",
    "html", "body", "page", "screen", "view", "template", "section", "group",
    "scaffold", "stack", "vstack", "card", "form", "hstack", "toolbar", "flow",
    "zstack", "overlay", "scroll", "refreshable", "refresh", "divider", "spacer",
    "text", "label", "heading", "title", "subtitle", "paragraph", "code",
    "button", "glassButton", "transport", "pressable", "row",
    "textfield", "input", "textarea", "toggle", "switch", "checkbox", "slider",
    "rangeSlider", "progress", "capsuleProgress", "spinner", "activity",
    "picker", "combobox", "segmented", "segmentedButton", "stepper", "tabs", "tabview",
    "list", "grid", "sheet", "cover", "alert", "confirmDialog", "node", "dynamic",
    "audio", "video", "image", "svg", "qrcode", "map", "chart", "lottie",
    "scene", "canvas",
    "slot",
) + desktopExtendedNativeTags

/** The container tags whose `align`/`align-items` word aligns their CHILDREN (the
 * DsxFlex crossAlign / Box contentAlignment consumer), so the style onion must never
 * read it as a self-anchor for the grown box. */
internal val desktopFlexContainerTags: Set<String> = setOf(
    "html", "body", "page", "screen", "view", "template", "section", "group",
    "scaffold", "stack", "vstack", "card", "form", "hstack", "toolbar", "flow",
    "zstack", "overlay", "scroll", "refreshable", "refresh", "pressable", "row",
    "list", "grid",
)

/// The renderer's full tag vocabulary: the literals above plus whatever the capability table
/// declares. Deliberately a FUNCTION, not `desktopRendererOwnedTags + DesktopCapabilities.tags`
/// folded into the top-level `val`: the table reads a classpath resource and validates it
/// strictly, so resolving it inside this file's `<clinit>` would turn a stripped or malformed
/// `/dsx/DesktopCapabilities.tsv` into an ExceptionInInitializerError — after which every later
/// touch of ANY top-level member here throws a causeless NoClassDefFoundError and the whole
/// desktop renderer is dead for the process, with the validation message visible only in the
/// first stack trace. That is the opposite of the honest per-tag failure surface the table
/// exists to serve. Keeping the read out of class init means a bad table surfaces where it can
/// be reported, and the literals above stay infallible exactly as they were before the table.
internal fun desktopRendererOwnsTag(tag: String): Boolean =
    tag in desktopRendererOwnedTags ||
        tag in DesktopCapabilities.tags ||
        DesktopElements.renderer(tag) != null

class DesktopElementContext internal constructor(
    val node: StackNode,
    val attributes: Map<String, String>,
    val store: StackStore,
    val runner: JSERunner,
    val item: Map<String, Any?>?,
    internal val components: Map<String, StackNode>,
) {
    @Composable
    fun Children() {
        node.children.forEach { DesktopNode(it, store, runner, item, components) }
    }

    fun value(name: String): String? = attributes[name]?.let { JSE.interpolate(it, store, item) }
    fun run(action: String, arguments: Map<String, Any?> = emptyMap()) = runner.run(action, item, arguments)
}

private data class DesktopFocusLink(
    val requester: FocusRequester,
    val previous: FocusRequester?,
    val next: FocusRequester?,
)

private val LocalDesktopFocusPlan = compositionLocalOf<Map<StackNode, DesktopFocusLink>> { emptyMap() }
private val LocalDesktopShortcutRegistry = compositionLocalOf<DesktopShortcutRegistry?> { null }
private val LocalDesktopInteractionsEnabled = compositionLocalOf { true }

/** `passthrough="true"` — the subtree is decorative and the pointer falls through it. Distinct
 *  from LocalDesktopInteractionsEnabled on purpose: `disabled` renders a control in its DISABLED
 *  treatment, while passthrough renders normally and simply is not a target. The twin of iOS
 *  `.allowsHitTesting(false)` and of `:render`'s LocalDsxPassthrough; consumed by
 *  desktopUniversalModifier, which withholds the arms rather than adding an occluding one. */
internal val LocalDesktopPassthrough = compositionLocalOf { false }
/** Inside a structurally mounted but hidden pane (DesktopHiddenPane): the parity
 * capture reports the web's display:none convention (all-zero rects). */
private val LocalDesktopHiddenPane = compositionLocalOf { false }
internal val LocalDesktopThemePin = compositionLocalOf<String?> { null }
/** The nearest `container="true"` ancestor's live dimensions.  JSE exposes this
 * through `dsx.element.width/height`; keeping it composition-local makes nested
 * containers shadow their parent without mutating a list row's authored item. */
private val LocalDesktopContainerElement = compositionLocalOf<Map<String, Any?>?> { null }
internal const val MAX_DESKTOP_COMPONENT_DEPTH = 32

private data class DesktopSlotContext(
    val children: List<StackNode>,
    val runner: JSERunner,
    val item: Map<String, Any?>?,
    val focusPlan: Map<StackNode, DesktopFocusLink>,
    val interactionsEnabled: Boolean,
    val parent: DesktopSlotContext?,
)

/** The twin of `DSXFoundationInputPolicy.textAreaLineCount` (Swift) and `textAreaLineCount`
 *  (TypeScript): a bounded positive integer, where a missing or unreadable value falls back
 *  and a reversed pair normalizes at the call site by min/max rather than trapping. */
internal fun textAreaLineCount(value: String?, fallback: Int): Int {
    val parsed = value?.trim()?.toDoubleOrNull() ?: return fallback
    if (parsed.isNaN() || parsed.isInfinite()) return fallback
    return parsed.toInt().coerceIn(1, 64)
}

private val LocalDesktopSlot = compositionLocalOf<DesktopSlotContext?> { null }
private val naturallyFocusableTags = setOf(
    "button", "glassButton", "transport", "textfield", "input", "textarea",
    "toggle", "switch", "checkbox", "slider", "picker", "combobox", "segmented",
) + desktopExtendedFocusableTags

private data class ShortcutBinding(
    val shortcut: DesktopShortcut,
    val action: String,
    val item: Map<String, Any?>?,
)

/** Composition-owned registry rather than a raw-document scan. Only nodes that are
 * actually mounted, visible, and enabled can install a binding, and disposal removes
 * it before a hidden branch can receive another window key event. */
private class DesktopShortcutRegistry {
    private val bindings = LinkedHashMap<Any, ShortcutBinding>()

    fun replace(token: Any, action: DesktopShortcutAction?, item: Map<String, Any?>?) {
        if (action == null) bindings.remove(token)
        else bindings[token] = ShortcutBinding(action.shortcut, action.action, item)
    }

    fun remove(token: Any) {
        bindings.remove(token)
    }

    fun matching(event: androidx.compose.ui.input.key.KeyEvent): ShortcutBinding? =
        bindings.values.firstOrNull { matchesShortcut(event, it.shortcut) }
}

@Composable
fun DesktopSurface(root: StackNode, store: StackStore = remember { StackStore() }) {
    // Collecting the authoritative core flow gives desktop the same reactive contract as
    // Android: JSE/state writes invalidate rendering without a renderer-local state fork.
    store.varsFlow.collectAsState().value
    DSX.state.varsFlow.collectAsState().value
    DesktopScreenStatePublisher()
    val runner = remember(store) { JSERunner(store) }
    val components = remember(root, store) { prepareDesktopDocument(root, store) }
    val focusPlan = remember(root) { buildFocusPlan(root) }
    val shortcuts = remember(root) { DesktopShortcutRegistry() }
    val windowFocus = remember { FocusRequester() }
    DisposableEffect(Unit) {
        val dispatcher = DesktopUiDispatcher.install()
        onDispose { dispatcher.close() }
    }
    val windowKeys = Modifier.onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        val binding = shortcuts.matching(event)
            ?: return@onPreviewKeyEvent false
        runner.run(binding.action, binding.item)
        true
    }
    androidx.compose.runtime.LaunchedEffect(windowFocus) { windowFocus.requestFocus() }
    CompositionLocalProvider(
        LocalDesktopFocusPlan provides focusPlan,
        LocalDesktopShortcutRegistry provides shortcuts,
        LocalDesktopInteractionsEnabled provides true,
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .then(windowKeys)
                .focusRequester(windowFocus)
                .focusable()
                .background(MaterialTheme.colors.background),
        ) {
            // The frame law (theme.ts `.dsx-frame > * { flex: 1 1 auto }` + the frame's
            // own stretch): the root element fills the window on both axes, so a hug
            // root cannot collapse the whole document to its content size.
            Box(Modifier.fillMaxSize(), propagateMinConstraints = true) {
                DesktopNode(root, store, runner, null, components)
            }
        }
    }
}

private fun buildFocusPlan(root: StackNode): Map<StackNode, DesktopFocusLink> {
    val ordered = orderedFocusNodes(root)
    val requesters = ordered.map { FocusRequester() }
    val plan = IdentityHashMap<StackNode, DesktopFocusLink>()
    ordered.forEachIndexed { index, node ->
        plan[node] = DesktopFocusLink(
            requester = requesters[index],
            previous = requesters.getOrNull(index - 1),
            next = requesters.getOrNull(index + 1),
        )
    }
    return plan
}

@Composable
private fun DesktopShortcutRegistration(
    attrs: Map<String, String>,
    item: Map<String, Any?>?,
    interactive: Boolean,
) {
    val registry = LocalDesktopShortcutRegistry.current
    val token = remember { Any() }
    val action = desktopShortcutAction(attrs, interactive)
    DisposableEffect(registry, token) {
        onDispose { registry?.remove(token) }
    }
    androidx.compose.runtime.SideEffect {
        registry?.replace(token, action, item)
    }
}

/** Admit one DSX document into a store and return its authored component table.
 * Remote native DSX screens deliberately reuse this exact path so their variables,
 * actions, styles, attributes, and components do not become a second renderer dialect. */
internal fun prepareDesktopDocument(root: StackNode, store: StackStore, item: Map<String, Any?>? = null): Map<String, StackNode> {
    val components = desktopDeclaredComponents(root)
    val pending = java.util.ArrayDeque<StackNode>()
    pending.addLast(root)
    while (pending.isNotEmpty()) {
        val node = pending.removeLast()
        val attrs = PlatformAttrs.resolve(node.attrs, Platform.attributeTarget)
        when (node.tag) {
            "action" -> attrs["as"]?.let { name ->
                val inputs = attrs.filterKeys { it != "as" && it != "id" }
                JSE.registerFunctions(node.text ?: "", store)
                store.registerAction(name, inputs, node.text ?: "")
            }
            "variable", "var", "let" -> attrs["as"]?.let { name ->
                JSE.registerFunctions(node.text ?: "", store)
                if (attrs["computed"] == "true") store.computed[name] = node.text ?: ""
                else if (!store.initials.containsKey(name)) {
                    val value = JSE.evalBlock(node.text ?: attrs["value"] ?: "", store, item) ?: ""
                    store.initials[name] = value
                    if (store.getPath(name) == null) store.setPath(name, value)
                }
            }
            "formula" -> attrs["as"]?.let { name ->
                store.formulas[name] = StackFormula(attrs.filterKeys { it != "as" && it != "id" }, node.text ?: "")
            }
            "script", "functions" -> store.registerHeadFunctions(attrs, node.text ?: "")
            "style" -> registerDesktopNamedStyle(store, attrs)
            "attribute" -> attrs["as"]?.takeIf { it.isNotBlank() }?.let { name ->
                attrs["default"]?.let { value -> store.attrDefaults.putIfAbsent(name, value) }
            }
            // <override as=/> — the style contract's declaration (Conformance/overrides):
            // register the typed knob so dsx.override.<name> resolves through the shared core.
            "override" -> attrs["as"]?.takeIf { it.isNotBlank() }?.let { name ->
                if (!store.overrideDecls.containsKey(name)) {
                    store.overrideDecls[name] = OverrideDecl(
                        name = name, type = attrs["type"], default = attrs["default"],
                        options = attrs["options"], min = attrs["min"], max = attrs["max"],
                    )
                }
            }
            "component" -> Unit
        }
        // A component TEMPLATE's head registers per instance (the instance-store law),
        // never into the document store - only the document's own tree is walked.
        if (node.tag == "component" && node !== root) continue
        for (index in node.children.indices.reversed()) pending.addLast(node.children[index])
    }
    return components
}

/** Pure component-table extraction used both by normal document preparation and
 * by remote admission before any declarations are allowed to mutate the store. */
internal fun desktopDeclaredComponents(root: StackNode): Map<String, StackNode> {
    val components = LinkedHashMap<String, StackNode>()
    val pending = java.util.ArrayDeque<StackNode>()
    pending.addLast(root)
    while (pending.isNotEmpty()) {
        val node = pending.removeLast()
        if (node.tag == "component") {
            val attrs = PlatformAttrs.resolve(node.attrs, Platform.attributeTarget)
            attrs["as"]?.takeIf(String::isNotBlank)?.let { name ->
                components[name] = if (node.children.size == 1) node.children.single()
                else StackNode("vstack", emptyMap(), node.children)
            }
        }
        for (index in node.children.indices.reversed()) pending.addLast(node.children[index])
    }
    return components
}

internal fun desktopComponentAttributes(
    attrs: Map<String, String>,
    doorOverrides: Map<*, *>? = null,
): Map<String, Any?> {
    val out = LinkedHashMap<String, Any?>()
    val overrides = LinkedHashMap<String, Any?>()
    for ((key, value) in attrs) {
        if (key == "tag" || key == "id" || key.startsWith("on:") || key.startsWith("from:")) continue
        // The style-override split (corpus Conformance/overrides): `override:<name>`
        // leaves the props plane and rides the item scope's __overrides dict.
        val override = StyleOverrides.overrideAttrName(key)
        if (override != null) overrides[override] = value else out[key] = value
    }
    // The VERB door (the outer store's dsx.override dict, seeded by dsx.component.push/
    // present/update): folds under the tag spellings — the read chain's item-beats-store
    // law. Only verb-seeded surface stores carry the var.
    doorOverrides?.forEach { (k, v) ->
        val name = k as? String ?: return@forEach
        if (!overrides.containsKey(name)) overrides[name] = v
    }
    if (overrides.isNotEmpty()) out["__overrides"] = overrides
    return out
}

@Composable
internal fun DesktopNode(
    node: StackNode,
    store: StackStore,
    runner: JSERunner,
    sourceItem: Map<String, Any?>?,
    components: Map<String, StackNode>,
) {
    val inheritedElement = LocalDesktopContainerElement.current
    val inheritedTheme = LocalDesktopThemePin.current
    val item = if (inheritedElement == null) sourceItem else remember(sourceItem, inheritedElement) {
        LinkedHashMap<String, Any?>(sourceItem.orEmpty()).apply {
            put("__element", inheritedElement)
        }
    }
    var attrs = desktopResolvedAttributes(node, store, item)
    val visible = isVisible(attrs, store, item)
    val keepAlive = attrs["keep"] == "true"
    // A bare `anim=` arms the platform-default fade just as it does on Swift and
    // Android. `exit=` is retained for the root/window-close contract.
    val exitMotion = attrs["transition"] != null || attrs["anim"] != null || attrs["exit"] != null
    var mountedForExit by remember(node) { mutableStateOf(visible) }
    val animateOnMount = visible && !mountedForExit &&
        (attrs["transition"] != null || attrs["anim"] != null)
    val exitDurationMillis = if (desktopReduceMotionEnabled()) 0 else desktopMotionDurationMillis(attrs)
    androidx.compose.runtime.LaunchedEffect(visible, exitMotion, exitDurationMillis) {
        mountedForExit = if (visible) true else if (exitMotion) {
            delay(exitDurationMillis.toLong())
            false
        } else false
    }
    // Keep a disappearing node in the real scene until its declarative exit has
    // completed. A node initially hidden never flashes into composition.
    if (!visible && !keepAlive && (!exitMotion || !mountedForExit)) return
    if (!visible) attrs = attrs + mapOf("disabled" to "true", "a11yHidden" to "true")
    // The strict component-boolean predicate the other renderers share (iOS dsx.bool, web
    // declaredBool, phone Kotlin SelectionControl.declaredBool): `"true"` or any non-zero
    // number - a bound {{ locked }} arrives "1"/"" on the interpolated lanes.
    val declaredDisabled = declaredControlBool(attrs["disabled"]) || expressionBoolean(attrs["disabled-if"], store, item)
    // Read BEFORE the provider below, and OR-ed with this element's own attribute: the modifier
    // chain is built here, outside the provider it installs, so an element carrying
    // `passthrough="true"` itself must see it without waiting for its own subtree scope.
    val passthrough = LocalDesktopPassthrough.current || attrs["passthrough"] == "true"
    val interactionsEnabled = LocalDesktopInteractionsEnabled.current && visible && !declaredDisabled
    val disabled = !interactionsEnabled
    val themePin = attrs["theme"]?.takeIf { it == "light" || it == "dark" } ?: inheritedTheme
    DesktopShortcutRegistration(attrs, item, interactionsEnabled)

    val packageRenderer = DesktopElements.renderer(node.tag)
    val componentTemplate = components[node.tag]

    var modifier = desktopVisibilityModifier(
        desktopStyleModifier(Modifier, attrs, flexContainer = node.tag in desktopFlexContainerTags),
        node,
        attrs,
        visible,
        keepAlive,
        animateOnMount,
    )
    val isContainer = attrs["container"] == "true"
    var containerElement by remember(node) { mutableStateOf<Map<String, Any?>?>(null) }
    if (isContainer) {
        val density = LocalDensity.current
        modifier = Modifier.onSizeChanged { size ->
            val next = with(density) {
                mapOf(
                    "width" to size.width.toDp().value.toDouble(),
                    "height" to size.height.toDp().value.toDouble(),
                )
            }
            if (containerElement != next) containerElement = next
        }.then(modifier)
    }

    val accessibility = desktopAccessibility(node.tag, attrs)
    modifier = Modifier.semantics(mergeDescendants = accessibility.group) {
        val spoken = listOfNotNull(accessibility.label, accessibility.hint).filter(String::isNotBlank)
        if (spoken.isNotEmpty()) contentDescription = spoken.joinToString(". ")
        accessibility.value?.takeIf(String::isNotBlank)?.let { stateDescription = it }
        when (accessibility.role?.lowercase()) {
            "button", "link" -> Role.Button
            "switch" -> Role.Switch
            "checkbox" -> Role.Checkbox
            "image" -> Role.Image
            "tab" -> Role.Tab
            else -> null
        }?.let { role = it }
        if (accessibility.hidden) hideFromAccessibility()
        if (accessibility.heading) heading()
        if (accessibility.selected) selected = true
    }.then(modifier)

    val callerFocusPlan = LocalDesktopFocusPlan.current
    callerFocusPlan[node]?.let { link ->
        var focusEnvelope = Modifier
            .focusRequester(link.requester)
            .focusProperties {
                next = link.next ?: FocusRequester.Default
                previous = link.previous ?: FocusRequester.Default
            }
        if (node.tag !in naturallyFocusableTags) focusEnvelope = focusEnvelope.focusable()
        modifier = focusEnvelope.then(modifier)
    }
    if (disabled) modifier = Modifier.semantics { disabled() }.then(modifier)
    modifier = desktopUniversalModifier(modifier, node, attrs, store, runner, item, disabled, passthrough)

    val hoverStart = attrs["on:hoverStart"]
    val hoverEnd = attrs["on:hoverEnd"]
    val hover = remember(node, hoverStart, hoverEnd, runner, item) {
        DesktopHoverLifecycle(
            start = { hoverStart?.let { runner.run(it, item) } },
            end = { hoverEnd?.let { runner.run(it, item) } },
        )
    }
    if (hoverStart != null || hoverEnd != null) {
        modifier = Modifier
            .onPointerEvent(PointerEventType.Enter) { hover.enter() }
            .onPointerEvent(PointerEventType.Exit) { hover.exit() }
            .then(modifier)
        DisposableEffect(hover) { onDispose { hover.dispose() } }
    }
    val compactViewport = desktopCssEnvironment().windowWidth < LayoutSemantics.COMPACT_BELOW
    // The parity-capture seam (DesktopParityCapture.kt): armed only by the capture
    // harness, one @Volatile null read per element otherwise. Outermost, so the reported
    // bounds are the element's full styled box. A pressable row's skin radius
    // (`.dsx-pressable` border-radius: --dsx-radius-control, 8 fine / 10 coarse) rounds
    // only its own paint - CSS clips nothing without overflow - so it joins the
    // REPORTED attrs here rather than the style onion, whose radius path also clips
    // children (which would cut the authored negative-margin bleed pattern).
    DesktopParityCapture.session?.let { session ->
        if (session.capturesNode(node)) {
            val reported =
                if ((node.tag == "pressable" || node.tag == "row") && attrs["radius"] == null) {
                    attrs + ("radius" to if (compactViewport) "10" else "8")
                } else attrs
            modifier = desktopParityCaptureModifier(
                session, node, reported,
                hidden = LocalDesktopHiddenPane.current,
            ).then(modifier)
        }
    }
    // The element's flex facts for a DsxFlex parent (LayoutSemantics — the corpus-gated
    // decisions; inert parent data under any other container). progress/slider carry the
    // skin's own `align-self: stretch` / width:100% resting law; progress contributes its
    // `.dsx-progress` min-width (8rem) to a hugging column's settled content size. The
    // stack laws (fields/rows always, buttons/forms/vertical stacks on compact) ride
    // defaultSelfStretch against the live window width.
    modifier = Modifier.dsxFlexChild(
        DsxFlexChildData(
            selfAlign = LayoutSemantics.selfAlignment(attrs),
            fillsWidthIfStretched = LayoutSemantics.childFillsCross(true, attrs, "width"),
            fillsHeightIfStretched = LayoutSemantics.childFillsCross(true, attrs, "height"),
            elementStretchWidth = node.tag in flexSelfStretchTags,
            minCrossDp = if (node.tag == "progress" || node.tag == "capsuleProgress") 128f else 0f,
            lawStretchWidth = LayoutSemantics.defaultSelfStretch(node.tag, attrs, compactViewport),
            stretchWhenOnlyChild = node.tag == "scroll" || node.tag == "refreshable" || node.tag == "refresh",
            growWidth = attrs["grow"] == "width" || attrs["grow"] == "true" || attrs["grow"] == "both",
            growHeight = attrs["grow"] == "height" || attrs["grow"] == "true" || attrs["grow"] == "both",
            spacerAutoWidth = node.tag == "spacer" && attrs["width"] == null,
            spacerAutoHeight = node.tag == "spacer" && attrs["height"] == null,
            flexGrow = number(attrs["flexGrow"], 0f).coerceAtLeast(0f),
            sizedWidth = boundedNumberOrNull(attrs["width"], 0f, MAX_DESKTOP_LAYOUT_DP) != null,
            sizedHeight = boundedNumberOrNull(attrs["height"], 0f, MAX_DESKTOP_LAYOUT_DP) != null,
            marginLeftDp = number(attrs["marginLeft"], 0f),
            marginTopDp = number(attrs["marginTop"], 0f),
            marginRightDp = number(attrs["marginRight"], 0f),
            marginBottomDp = number(attrs["marginBottom"], 0f),
        ),
    ).then(modifier)
    val context = DesktopElementContext(node, attrs, store, runner, item, components)

    CompositionLocalProvider(
        LocalDesktopInteractionsEnabled provides interactionsEnabled,
        LocalDesktopPassthrough provides passthrough,
        LocalDesktopContainerElement provides if (isContainer) containerElement else inheritedElement,
        LocalDesktopThemePin provides themePin,
    ) {
    if (packageRenderer != null) {
        // The framework owns this outer surface so package renderers cannot bypass
        // DSX visibility, style, focus, accessibility, interaction, or hover policy.
        Box(modifier) { packageRenderer(context) }
    } else if (componentTemplate != null) {
        // Component attributes/events/slot content execute in a bounded child
        // environment while the use-site keeps the framework-owned outer envelope.
        // Each expansion gets its own focus plan, avoiding one template AST attaching
        // the same FocusRequester to every list/component instance.
        Box(modifier) {
            if (runner.depth < MAX_DESKTOP_COMPONENT_DEPTH) {
                val componentAttributes = desktopComponentAttributes(attrs, store.vars["dsx.override"] as? Map<*, *>)
                // THE INSTANCE STORE (composition law; the web renderer is the reference):
                // a component instance OWNS its state - its head declarations register in
                // a store born with the instance, so two instances hold independent state.
                // Attributes ride the item scope, handlers keep the consumer's runner, and
                // slot content renders in the consumer's scope and store.
                val instanceStore = remember(node) {
                    StackStore().also { prepareDesktopDocument(componentTemplate, it, componentAttributes) }
                }
                val childRunner = remember(node, runner, instanceStore) {
                    JSERunner(
                        store = instanceStore,
                        webView = runner.webView,
                        scope = runner.scope,
                        onHandlers = HashMap(runner.onHandlers),
                        dsx = runner.dsx,
                        measuring = runner.measuring,
                        depth = runner.depth + 1,
                    )
                }
                val handlers = HashMap(runner.onHandlers)
                attrs.forEach { (key, action) ->
                    if (key.startsWith("on:") && action.isNotBlank()) {
                        val event = key.substring(3)
                        handlers[event] = OnHandler(action, runner, attrs["from:$event"]?.let { OnHandler.parseFrom(it) })
                    }
                }
                val slotContent = node.children.takeIf { it.isNotEmpty() }?.let {
                    SlotContent(it, runner, item)
                }
                childRunner.scope = runner.scope
                childRunner.onHandlers = handlers
                childRunner.slot = slotContent
                childRunner.dsx = runner.dsx
                childRunner.measuring = runner.measuring
                childRunner.depth = runner.depth + 1
                val componentFocusPlan = remember(componentTemplate, childRunner) { buildFocusPlan(componentTemplate) }
                val parentSlot = LocalDesktopSlot.current
                val desktopSlot = slotContent?.let {
                    DesktopSlotContext(it.children, it.env, it.item, callerFocusPlan, interactionsEnabled, parentSlot)
                }
                CompositionLocalProvider(
                    LocalDesktopFocusPlan provides componentFocusPlan,
                    LocalDesktopSlot provides desktopSlot,
                ) {
                    DesktopNode(componentTemplate, instanceStore, childRunner, componentAttributes, components)
                }
            }
        }
    } else when (node.tag) {
        // Head declarations paint no pixels, but lifecycle declarations such as <api>
        // must still enter composition. Their siblings remain inert below.
        "head" -> children(node, store, runner, item, components)
        "api" -> DesktopApiView(
            attrs,
            store,
            runner,
            item,
        )
        "event", "expects", "action", "variable", "var", "let", "formula",
        "script", "functions", "style", "override", "component" -> Unit
        "attribute" -> DesktopAttribute(attrs, store, runner, item)
        "watch" -> DesktopWatch(attrs, store, runner, item)

        "html", "body", "page", "screen", "view", "template", "section", "group" ->
            Column(modifier) { children(node, store, runner, item, components) }

        "scaffold" -> DesktopScaffold(context, modifier)

        "stack", "vstack", "card" -> {
            val spacing = dimension(attrs["spacing"] ?: attrs["gap"], if (node.tag == "stack") 0f else 8f)
            val row = attrs["flexDirection"]?.startsWith("row") == true
            DsxFlex(
                modifier,
                horizontal = row,
                spacingDp = spacing,
                // The skin's stack keeps `align-items: start` even as a row; only the
                // dedicated hstack centers (theme.ts `.dsx-hstack`).
                crossAlign = flexCrossAlign(attrs["align"] ?: attrs["alignItems"], "start"),
                crossStretch = LayoutSemantics.crossStretch(attrs),
            ) { children(node, store, runner, item, components) }
        }

        "form" -> DesktopForm(context, modifier, disabled)

        // A BOUND `<flow>` repeats its template per row (runtime-pressure R29); an unbound one
        // lays out its authored children. Either way it is the same wrapping flex box, which is
        // what keeps the repeater from being a second element.
        "flow" -> DesktopFlow(context, modifier)

        "hstack", "toolbar" -> DsxFlex(
            modifier,
            horizontal = true,
            spacingDp = dimension(attrs["spacing"], 8f),
            crossAlign = flexCrossAlign(attrs["align"] ?: attrs["alignItems"], "center"),
            crossStretch = LayoutSemantics.crossStretch(attrs),
        ) { children(node, store, runner, item, components) }

        "zstack", "overlay" -> Box(modifier, contentAlignment = boxAlignment(attrs["align"])) {
            children(node, store, runner, item, components)
        }

        // `.dsx-scroll` is `flex: 1 1 auto` inside the frame and declares no align-items,
        // so it fills its slot and its children STRETCH by flex's own default (the one
        // container where stretch is the resting state — theme.ts + globals.ts).
        // The window-derived ceiling is the LazyColumn recipe above: verticalScroll
        // rejects an infinite max-height, and a scroll authored inside another scrolling
        // surface (the FX sheet's content cell) is measured with exactly that.
        // `axis="horizontal"` is the RAIL form (the FX node rail, preset chip rows): a
        // flex ROW panning on the main axis, height wrapped to its content.
        "scroll", "refreshable", "refresh" -> if (attrs["axis"] == "horizontal") DsxFlex(
            modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontal = true,
            spacingDp = dimension(attrs["spacing"], 0f),
            crossAlign = flexCrossAlign(attrs["align"] ?: attrs["alignItems"], "start"),
            crossStretch = LayoutSemantics.crossStretch(attrs, defaultStretch = true),
        ) { children(node, store, runner, item, components) } else DsxFlex(
            Modifier
                .heightIn(
                    max = desktopCollectionViewportDp(
                        windowHeightPx = LocalWindowInfo.current.containerSize.height,
                        density = LocalDensity.current.density,
                    ).dp,
                )
                .then(modifier)
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
            horizontal = false,
            spacingDp = dimension(attrs["spacing"], 0f),
            crossAlign = flexCrossAlign(attrs["align"] ?: attrs["alignItems"], "start"),
            crossStretch = LayoutSemantics.crossStretch(attrs, defaultStretch = true),
        ) { children(node, store, runner, item, components) }

        "divider" -> Divider(modifier, color = color(attrs["color"] ?: "outline"), thickness = dimension(attrs["height"], 1f).dp)
        // Explicit sizes arrive through the style modifier; a bare axis is `flex: 1 1 0`
        // (absorb-or-zero, the DsxFlex parent data attached above).
        "spacer" -> Spacer(modifier)

        "text", "label", "heading", "title", "subtitle", "paragraph", "code" -> renderText(node, attrs, modifier, store, item)

        "button", "glassButton", "transport" -> DesktopButton(context, modifier, disabled)

        // `.dsx-pressable` is a flex COLUMN with `align-items: stretch` (theme.ts), so a
        // row's content spans the row — the chevron reaches the trailing edge.
        "pressable", "row" -> DsxFlex(
            // `pressable`/`row` is a non-control element, so its arm is withheld under a
            // passthrough ancestor like every other universal arm (iOS allowsHitTesting(false)).
            if (passthrough) modifier
            else modifier.clickable(enabled = !disabled) {
                attrs["on:tap"]?.let { desktopRunEvent(node, "tap", it, attrs, store, runner, item) }
            },
            horizontal = false,
            spacingDp = 0f,
            crossAlign = "start",
            crossStretch = true,
        ) { children(node, store, runner, item, components) }

        "textfield", "input", "textarea" -> {
            val bind = attrs["bind"].orEmpty()
            val value = boundString(bind, store, item)
            OutlinedTextField(
                value = value,
                onValueChange = { next ->
                    if (bind.isNotEmpty()) store.writeBound(bind, next)
                    attrs["on:change"]?.let { runner.run(it, item, mapOf("value" to next)) }
                },
                modifier = modifier
                    // `on:submit` on the MULTILINE tag. A desktop keyboard is the case this
                    // grammar exists for, and the singleLine branch below already routes
                    // Return through the IME Done action, so only `textarea` needs it.
                    // `ignore`/`newline` both mean "not mine": returning false leaves the key
                    // to the field, which is what keeps Return inserting a line break.
                    .then(
                        if (node.tag != "textarea" || attrs["on:submit"] == null) Modifier
                        else Modifier.onPreviewKeyEvent { event ->
                            if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                            val action = StackDesktopInput.multilineReturn(
                                key = if (event.key == Key.Enter || event.key == Key.NumPadEnter) "enter" else "",
                                shift = event.isShiftPressed,
                                meta = event.isMetaPressed,
                                ctrl = event.isCtrlPressed,
                                alt = event.isAltPressed,
                                submitOnEnter = attrs["submitOnEnter"] == "true",
                                hasSubmit = true,
                            )
                            if (action != "submit") return@onPreviewKeyEvent false
                            attrs["on:submit"]?.let { runner.run(it, item) }
                            true
                        },
                    ),
                enabled = !disabled,
                singleLine = node.tag != "textarea",
                // GROWTH IS THE AUTHOR'S NUMBERS, not a fixed floor. This was
                // `heightIn(min = 112.dp)` - three lines by coincidence - which ignored
                // minLines and maxLines outright: a one-line field still reserved three lines
                // of empty well and a capped field grew without end. Compose grows the box
                // with its RENDERED lines between these bounds, which is what iOS's
                // lineLimit(min...max) does and what the web twin now measures.
                // a reversed pair normalizes by min/max, exactly as the Swift twin's
                // lineLimit(min(a,b)...max(a,b)) and the web's Math.min/Math.max do -
                // Compose would otherwise throw on minLines > maxLines
                minLines = if (node.tag == "textarea") {
                    minOf(textAreaLineCount(attrs["minLines"], 3), textAreaLineCount(attrs["maxLines"], 8))
                } else 1,
                maxLines = if (node.tag == "textarea") {
                    maxOf(textAreaLineCount(attrs["minLines"], 3), textAreaLineCount(attrs["maxLines"], 8))
                } else 1,
                label = attrs["label"]?.let { { Text(it) } },
                placeholder = attrs["placeholder"]?.let { { Text(it) } },
                visualTransformation = if (attrs["secure"] == "true") PasswordVisualTransformation() else VisualTransformation.None,
                keyboardOptions = KeyboardOptions(
                    keyboardType = when (attrs["type"]) {
                        "number" -> KeyboardType.Number
                        "email" -> KeyboardType.Email
                        "url" -> KeyboardType.Uri
                        "phone" -> KeyboardType.Phone
                        else -> KeyboardType.Text
                    },
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { attrs["on:submit"]?.let { runner.run(it, item) } }),
            )
        }

        "toggle", "switch" -> {
            val bind = attrs["bind"].orEmpty()
            val checked = boundBoolean(bind, store, item)
            fun change(next: Boolean) {
                if (bind.isNotEmpty()) store.writeBound(bind, next)
                attrs["on:change"]?.let { runner.run(it, item, mapOf("value" to next)) }
            }
            // The labeled row is the authored DSX control (it owns id, style and
            // focusOrder), so it must also own the native focus/toggle semantics.
            // Leaving interactivity on the nested Switch made Tab skip the row's
            // FocusRequester and produced two competing accessibility targets.
            Row(
                modifier.toggleable(
                    value = checked,
                    enabled = !disabled,
                    role = Role.Switch,
                    onValueChange = ::change,
                ),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Switch(
                    checked = checked,
                    onCheckedChange = null,
                    enabled = !disabled,
                )
                attrs["label"]?.let { Text(it) }
            }
        }

        "checkbox" -> {
            val bind = attrs["bind"].orEmpty()
            val checked = boundBoolean(bind, store, item)
            fun change(next: Boolean) {
                if (bind.isNotEmpty()) store.writeBound(bind, next)
                attrs["on:change"]?.let { runner.run(it, item, mapOf("value" to next)) }
            }
            Row(
                modifier.toggleable(
                    value = checked,
                    enabled = !disabled,
                    role = Role.Checkbox,
                    onValueChange = ::change,
                ),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(
                    checked = checked,
                    onCheckedChange = null,
                    enabled = !disabled,
                )
                Text(attrs["label"] ?: node.text.orEmpty())
            }
        }

        "slider", "rangeSlider" -> {
            val bind = attrs["bind"].orEmpty()
            val min = scalar(attrs["min"], 0f)
            val max = scalar(attrs["max"], 1f).coerceAtLeast(min)
            Slider(
                value = boundNumber(bind, store, item).coerceIn(min, max),
                onValueChange = { next ->
                    if (bind.isNotEmpty()) store.writeBound(bind, next.toDouble())
                    attrs["on:change"]?.let { runner.run(it, item, mapOf("value" to next.toDouble())) }
                },
                modifier = modifier,
                enabled = !disabled,
                valueRange = min..max,
            )
        }

        // Width comes from the flex parent data (`align-self: stretch` + the 8rem
        // minimum, the skin's `.dsx-progress` law) — a forced fill here inflated
        // hugging containers to the window width (the W17 1150px breach class).
        "progress", "capsuleProgress" -> LinearProgressIndicator(
            progress = (attrs["bind"]?.let { boundNumber(it, store, item) } ?: number(attrs["value"], 0f)).coerceIn(0f, 1f),
            modifier = modifier,
            color = color(attrs["color"] ?: "accent"),
        )
        "spinner", "activity" -> CircularProgressIndicator(modifier.size(dimension(attrs["size"], 28f).dp), color = color(attrs["color"] ?: "accent"))

        "picker", "combobox", "segmented", "segmentedButton" -> DesktopPicker(context, modifier, disabled)
        "stepper" -> DesktopStepper(context, modifier, disabled)
        "tabs", "tabview" -> DesktopTabs(context, modifier)
        "list", "grid" -> DesktopCollection(context, modifier, grid = node.tag == "grid")
        "sheet", "cover", "alert", "confirmDialog" -> DesktopModal(context)

        in desktopExtendedNativeTags -> DesktopExtendedElement(context, modifier, disabled)

        "node", "dynamic" -> {
            val tag = attrs["tag"].orEmpty()
            if (tag.isEmpty()) children(node, store, runner, item, components)
            else {
                val dynamicNode = remember(node, tag) {
                    StackNode(tag, node.attrs - "tag", node.children, node.text)
                }
                DesktopNode(dynamicNode, store, runner, item, components)
            }
        }

        // Native media/data surfaces. Unsupported JVM decoders are represented by an
        // explicit first-party Compose status surface; no recognized tag goes blank
        // and no branch embeds a WebView.
        "audio", "video", "image", "svg", "qrcode", "map", "chart", "lottie" ->
            DesktopMediaElement(context, modifier, disabled)

        // The DSX-native 3D/2D engine (dsx-scene.md P2): the SAME :core software
        // rasterizer the Android element paints, into a Skia ImageBitmap here — one
        // Kotlin pixel pipeline for both JVM lanes. NOT a `DesktopCapabilities` row:
        // this build ships a real renderer, so the tag is binary-owned like every
        // media surface above (Scene3D/Scene360 stay capability-dispatched rows).
        "scene" -> DesktopSceneElement(context, modifier)

        // `<canvas>` (U04) and with it `<ink>`. Same reasoning as `<scene>` directly above:
        // this build ships a REAL renderer over the shared :core kernel (CanvasCore/InkCore,
        // corpus OpenSource/Conformance/canvas/), so the tag is binary-owned rather than a
        // `DesktopCapabilities` row answering with a failure surface. It left that table when
        // the renderer landed - a capability row is for a runtime this build does not bundle,
        // never for one nobody had written yet.
        "canvas" -> DesktopCanvasElement(context, modifier)

        // CAPABILITY DISPATCH, not name dispatch (root-plan.md rule 18). A tag the capability
        // table claims renders through whatever implementation this build bound for the
        // capability it requires — and when the build bundles none, through the first-party
        // failure surface carrying that capability's code/message. Shipping a desktop 3D or
        // web runtime is a `DesktopCapabilities.bind(...)` call: no branch here changes, and
        // no surface name appears in this file.
        in DesktopCapabilities.tags ->
            DesktopCapabilities.renderer(context.node.tag)?.invoke(context, modifier)
                ?: DesktopUnavailableElement(context, modifier)

        "slot" -> {
            val slot = LocalDesktopSlot.current
            if (slot == null) {
                children(node, store, runner, item, components)
            } else {
                val name = attrs["name"]
                CompositionLocalProvider(
                    LocalDesktopFocusPlan provides slot.focusPlan,
                    LocalDesktopInteractionsEnabled provides slot.interactionsEnabled,
                    LocalDesktopSlot provides slot.parent,
                ) {
                    slot.children.filter { child -> child.attrs["slot"] == name }.forEach { child ->
                        DesktopNode(child, slot.runner.store, slot.runner, slot.item, components)
                    }
                }
            }
        }
        else -> if (node.children.isNotEmpty()) children(node, store, runner, item, components)
    }
    }

    attrs["on:appear"]?.let { action -> androidx.compose.runtime.LaunchedEffect(node) { runner.run(action, item) } }
    attrs["on:disappear"]?.let { action -> DisposableEffect(node) { onDispose { runner.run(action, item) } } }
}

@Composable
private fun DesktopButton(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val attrs = context.attributes
    val click: () -> Unit = {
        attrs["on:tap"]?.let {
            desktopRunEvent(context.node, "tap", it, attrs, context.store, context.runner, context.item)
        }
        Unit
    }
    val content: @Composable () -> Unit = {
        if (context.node.children.isNotEmpty()) context.Children()
        else Text(attrs["label"] ?: iconLabel(attrs["icon"]) ?: context.node.text.orEmpty())
    }
    when (attrs["variant"]) {
        "bordered" -> OutlinedButton(
            onClick = click,
            modifier = modifier,
            enabled = !disabled,
            content = { content() },
        )
        "prominent" -> Button(
            onClick = click,
            modifier = modifier,
            enabled = !disabled,
            colors = ButtonDefaults.buttonColors(
                backgroundColor = color(attrs["background"] ?: "accent"),
                contentColor = color(attrs["color"] ?: "onAccent"),
            ),
            content = { content() },
        )
        else -> Button(onClick = click, modifier = modifier, enabled = !disabled, content = { content() })
    }
}

@Composable
private fun DesktopScaffold(context: DesktopElementContext, modifier: Modifier) {
    val children = context.node.children
    val resolvedChildren = children.map { PlatformAttrs.resolve(it.attrs, Platform.attributeTarget) }
    val partition = AdaptiveShell.partition(resolvedChildren)
    fun nodes(indexes: List<Int>) = indexes.map(children::get)
    val top = nodes(partition.top)
    val bottom = nodes(partition.bottom)
    val authored = nodes(partition.authored)
    val sidebar = nodes(partition.sidebar)
    val content = nodes(partition.content)
    val inspector = nodes(partition.inspector)
    val sidebarLabel = context.attributes["sidebarLabel"] ?: DesktopElementDefaults.SCAFFOLD_SIDEBAR_LABEL
    val contentLabel = context.attributes["contentLabel"] ?: DesktopElementDefaults.SCAFFOLD_CONTENT_LABEL
    val inspectorLabel = context.attributes["inspectorLabel"] ?: DesktopElementDefaults.SCAFFOLD_INSPECTOR_LABEL

    Column(modifier.fillMaxSize().testTag("dsx.scaffold")) {
        DesktopScaffoldPane(
            top, context, Modifier.fillMaxWidth().testTag("dsx.scaffold.pin.top"), null, null,
        )
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val plan = AdaptiveShell.resolve(
                attrs = context.attributes,
                widthDp = maxWidth.value.toDouble(),
                nativeAvailable = false,
                hasSidebar = sidebar.isNotEmpty(),
                hasContent = content.isNotEmpty(),
                hasInspector = inspector.isNotEmpty(),
            )
            when (plan.layout) {
                "custom" -> DesktopScaffoldPane(authored, context, Modifier.fillMaxSize(), null, null)
                "content" -> DesktopScaffoldPane(
                    content, context, Modifier.fillMaxSize(), "content", contentLabel,
                )
                "stack" -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                    DesktopScaffoldPane(sidebar, context, Modifier.fillMaxWidth(), "sidebar", sidebarLabel)
                    DesktopScaffoldPane(content, context, Modifier.fillMaxWidth(), "content", contentLabel)
                    if (inspector.isNotEmpty()) {
                        DesktopScaffoldPane(
                            inspector, context, Modifier.fillMaxWidth(), "inspector", inspectorLabel,
                        )
                    }
                }
                else -> Row(Modifier.fillMaxSize()) {
                    DesktopScaffoldPane(
                        sidebar,
                        context,
                        Modifier.fillMaxHeight()
                            .width(plan.sidebar.ideal.dp)
                            .widthIn(min = plan.sidebar.min.dp, max = plan.sidebar.max.dp),
                        "sidebar",
                        sidebarLabel,
                    )
                    DesktopScaffoldDivider()
                    DesktopScaffoldPane(
                        content, context, Modifier.weight(1f).fillMaxHeight(),
                        "content",
                        contentLabel,
                    )
                    if (plan.layout.endsWith("3") && inspector.isNotEmpty()) {
                        DesktopScaffoldDivider()
                        DesktopScaffoldPane(
                            inspector,
                            context,
                            Modifier.fillMaxHeight()
                                .width(plan.inspector.ideal.dp)
                                .widthIn(min = plan.inspector.min.dp, max = plan.inspector.max.dp),
                            "inspector",
                            inspectorLabel,
                        )
                    }
                }
            }
        }
        DesktopScaffoldPane(
            bottom, context, Modifier.fillMaxWidth().testTag("dsx.scaffold.pin.bottom"), null, null,
        )
    }
}

@Composable
private fun DesktopScaffoldPane(
    nodes: List<StackNode>,
    context: DesktopElementContext,
    modifier: Modifier,
    role: String?,
    label: String?,
) {
    val paneModifier = if (role == null || label == null) modifier else {
        modifier.testTag("dsx.scaffold.$role").semantics { contentDescription = label }
    }
    Column(paneModifier) {
        nodes.forEach { DesktopNode(it, context.store, context.runner, context.item, context.components) }
    }
}

@Composable
private fun DesktopScaffoldDivider() {
    Divider(Modifier.fillMaxHeight().width(1.dp), color = MaterialTheme.colors.onSurface.copy(alpha = 0.16f))
}

@Composable
private fun renderText(node: StackNode, attrs: Map<String, String>, modifier: Modifier, store: StackStore, item: Map<String, Any?>?) {
    val raw = attrs["bind"]?.let { JSE.eval(it, store, item) } ?: attrs["value"] ?: node.text.orEmpty()
    val displayed = if (raw === NSNull) "" else JSE.string(raw)
    val decoration = buildList {
        if (attrs["underline"] == "true") add(TextDecoration.Underline)
        if (attrs["strikethrough"] == "true") add(TextDecoration.LineThrough)
    }.let { if (it.isEmpty()) null else TextDecoration.combine(it) }
    // The web text law (theme.ts `.dsx-text`): body size is the type-body token
    // (0.9375rem = 15px) and line-height is 1.5x the size at every size. Compose's
    // platform default (a tighter per-font leading) accumulated a y drift down every
    // text column of the W17 capture; authored lineSpacing still wins.
    val declaredSize = desktopFontSize(attrs)
    val fontSize = if (declaredSize == androidx.compose.ui.unit.TextUnit.Unspecified) {
        DESKTOP_TEXT_BODY_SP.sp
    } else declaredSize
    val lineSpacing = boundedNumberOrNull(attrs["lineSpacing"], -1_000f, 1_000f)
    val lineHeight = if (lineSpacing != null) {
        (fontSize.value + lineSpacing).coerceAtLeast(0.5f).sp
    } else (fontSize.value * DESKTOP_TEXT_LINE_RATIO).sp
    // A DECLARED family (a `fonts` block on some enabled module) beats the system design axis,
    // exactly as it does on the other three renderers; `fontDesign` keeps its meaning on the
    // system fallback, which is what the `when` below still paints when nothing resolves.
    val declaredFamily = attrs["fontFamily"]
    val customFamily = declaredFamily?.let { DesktopFontBook.resolve(it, attrs["fontVariation"]) }
    // OpenType features: Skia takes the same four-character tags the shared parser validates.
    val features = StackFonts.parseFeatures(attrs["fontFeature"])
    Text(
        text = when (attrs["textCase"]) { "upper" -> displayed.uppercase(); "lower" -> displayed.lowercase(); else -> displayed },
        modifier = modifier,
        color = color(attrs["color"] ?: "label"),
        fontSize = fontSize,
        fontWeight = fontWeight(attrs["fontWeight"]),
        // A declared family shipping a REAL italic face already selected it; asking for a slant
        // on top of that obliques an italic.
        fontStyle = if (attrs["italic"] == "true" &&
            !(customFamily != null && DesktopFontBook.hasItalicFace(declaredFamily))
        ) FontStyle.Italic else FontStyle.Normal,
        fontFamily = customFamily ?: when (attrs["fontDesign"]) {
            "monospaced", "mono" -> FontFamily.Monospace
            "serif" -> FontFamily.Serif
            "rounded" -> FontFamily.SansSerif
            else -> FontFamily.Default
        },
        style = if (features.isEmpty()) LocalTextStyle.current
                else LocalTextStyle.current.copy(fontFeatureSettings = features.joinToString(", ")),
        textDecoration = decoration,
        textAlign = when (attrs["textAlign"]) { "center" -> TextAlign.Center; "trailing", "right" -> TextAlign.End; else -> TextAlign.Start },
        maxLines = attrs["lineLimit"]?.toIntOrNull()?.coerceIn(1, 100_000) ?: Int.MAX_VALUE,
        lineHeight = lineHeight,
        // The web text law: `letter-spacing: normal` unless authored. Unspecified would
        // INHERIT the ambient Material typography's tracking (body1 0.5sp; a button
        // label's 1.25sp), which widened every text run of the W17/W18 captures by a
        // per-character constant the web never applies.
        letterSpacing = boundedNumberOrNull(attrs["tracking"], -1_000f, 1_000f)?.sp ?: 0.sp,
    )
}

@Composable
private fun DesktopPicker(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val attrs = context.attributes
    val bind = attrs["bind"].orEmpty()
    val options = attrs["options"].orEmpty().take(65_536).splitToSequence(',')
        .map(String::trim).filter(String::isNotEmpty).take(1_024).toList()
    var expanded by remember { mutableStateOf(false) }
    val selected = boundString(bind, context.store, context.item)
    Box(modifier) {
        Button(onClick = { expanded = true }, enabled = !disabled) { Text(selected.ifEmpty { attrs["label"] ?: "Select" }) }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { option ->
                DropdownMenuItem(onClick = {
                    expanded = false
                    if (bind.isNotEmpty()) context.store.writeBound(bind, option)
                    attrs["on:change"]?.let { context.run(it, mapOf("value" to option)) }
                }) { Text(option) }
            }
        }
    }
}

@Composable
private fun DesktopStepper(context: DesktopElementContext, modifier: Modifier, disabled: Boolean) {
    val attrs = context.attributes
    val bind = attrs["bind"].orEmpty()
    val min = scalar(attrs["min"], 0f)
    val max = scalar(attrs["max"], 100f).coerceAtLeast(min)
    val step = boundedNumber(attrs["step"], 1f, 0.000001f, MAX_DESKTOP_SCALAR)
    val current = boundNumber(bind, context.store, context.item)
    fun write(next: Float) {
        val value = next.coerceIn(min, max).toDouble()
        if (bind.isNotEmpty()) context.store.writeBound(bind, value)
        attrs["on:change"]?.let { context.run(it, mapOf("value" to value)) }
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        attrs["label"]?.let { Text(it) }
        Button(onClick = { write(current - step) }, enabled = !disabled && current > min) { Text("−") }
        Text(if (current == current.roundToInt().toFloat()) current.roundToInt().toString() else current.toString())
        Button(onClick = { write(current + step) }, enabled = !disabled && current < max) { Text("+") }
    }
}

/** The web tabs contract's desktop numbers (structural-controls.ts): the wide face
 * engages at `TABS_WIDE_MEDIA` (69rem) with a `--dsx-tabs-rail` (15rem) leading rail;
 * below it the bottom dock band is 3.25rem tall. */
internal const val DESKTOP_TABS_WIDE_AT_DP = 1104f
internal const val DESKTOP_TABS_RAIL_DP = 240f
internal const val DESKTOP_TABS_DOCK_DP = 52f

/** A structurally mounted but hidden pane (tabs' unselected panes, split's collapsed
 * columns). The web keeps these in the DOM at zero size (`[hidden]` panels measure
 * 0x0), so the native plane mounts them the same way: composed, inert, zero-boxed —
 * the parity capture then reports the same node set on both sides, and pane state
 * (scroll positions, field text) survives a tab switch exactly as it does on web. */
@Composable
internal fun DesktopHiddenPane(content: @Composable () -> Unit) {
    CompositionLocalProvider(
        LocalDesktopInteractionsEnabled provides false,
        LocalDesktopHiddenPane provides true,
    ) {
        Box(Modifier.requiredSize(0.dp).clipToBounds()) { content() }
    }
}

@Composable
private fun DesktopTabs(context: DesktopElementContext, modifier: Modifier) {
    // Head/declaration children are never panes (LayoutSemantics.paneChildren — the
    // flex-semantics corpus row): counting `<head>` made pane 0 an empty declaration
    // and collapsed the whole shell (W17 defect D6). Declarations still enter
    // composition so `<api>`/`<watch>` lifecycles run.
    val panes = remember(context.node) { LayoutSemantics.paneChildren(context.node.children) }
    context.node.children.forEach { child ->
        if (child.tag in LayoutSemantics.declarationTags) {
            DesktopNode(child, context.store, context.runner, context.item, context.components)
        }
    }
    if (panes.isEmpty()) return
    val bind = context.attributes["value"].orEmpty()
    val bound = if (bind.isEmpty()) 0 else boundNumber(bind, context.store, context.item).roundToInt()
    var local by remember { mutableStateOf(bound) }
    val selected = (if (bind.isEmpty()) local else bound).coerceIn(0, panes.size - 1)
    fun choose(index: Int) {
        local = index
        if (bind.isNotEmpty()) context.store.writeBound(bind, index.toDouble())
        context.attributes["on:change"]?.let { context.run(it, mapOf("value" to index)) }
    }
    val density = LocalDensity.current
    val wide = with(density) { LocalWindowInfo.current.containerSize.width.toDp().value } >= DESKTOP_TABS_WIDE_AT_DP
    if (wide) Row(modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxHeight().width(DESKTOP_TABS_RAIL_DP.dp)
                .background(MaterialTheme.colors.surface)
                .padding(10.dp),
        ) {
            panes.forEachIndexed { index, pane ->
                val active = selected == index
                Text(
                    pane.attrs["tabTitle"] ?: "Tab ${index + 1}",
                    Modifier.fillMaxWidth()
                        .clickable { choose(index) }
                        .background(
                            if (active) MaterialTheme.colors.primary.copy(alpha = 0.10f) else Color.Transparent,
                            RoundedCornerShape(8.dp),
                        )
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    color = if (active) MaterialTheme.colors.primary else MaterialTheme.colors.onSurface,
                )
            }
        }
        Box(Modifier.weight(1f).fillMaxHeight()) {
            DesktopNode(panes[selected], context.store, context.runner, context.item, context.components)
        }
        DesktopHiddenTabPanes(panes, selected, context)
    } else Column(modifier.fillMaxSize()) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            DesktopNode(panes[selected], context.store, context.runner, context.item, context.components)
        }
        TabRow(selectedTabIndex = selected, modifier = Modifier.height(DESKTOP_TABS_DOCK_DP.dp)) {
            panes.forEachIndexed { index, pane ->
                Tab(
                    selected = selected == index,
                    onClick = { choose(index) },
                    text = { Text(pane.attrs["tabTitle"] ?: "Tab ${index + 1}") },
                )
            }
        }
        DesktopHiddenTabPanes(panes, selected, context)
    }
}

@Composable
private fun DesktopHiddenTabPanes(panes: List<StackNode>, selected: Int, context: DesktopElementContext) {
    panes.forEachIndexed { index, pane ->
        if (index != selected) {
            DesktopHiddenPane {
                DesktopNode(pane, context.store, context.runner, context.item, context.components)
            }
        }
    }
}

@Composable
private fun DesktopCollection(context: DesktopElementContext, modifier: Modifier, grid: Boolean) {
    val raw = context.attributes["bind"]?.let { JSE.eval(it, context.store, context.item) }
    val source = raw as? List<*> ?: emptyList<Any?>()
    val inspected = minOf(source.size, MAX_DESKTOP_BOUND_ROWS)
    val rows = buildList(inspected) {
        for (index in 0 until inspected) {
            when (val value = source[index]) {
                is Map<*, *> -> add(value.entries.asSequence().filter { it.key is String }
                    .take(256).associate { it.key as String to it.value })
                null -> Unit
                else -> add(mapOf("value" to value, "index" to index))
            }
        }
    }
    val template = context.node.children.firstOrNull()
    val spacing = dimension(context.attributes["spacing"], 8f).dp
    val columns = context.attributes["columns"]?.toIntOrNull()?.coerceIn(1, 12) ?: 3
    val scroll = context.attributes["scroll"] != "false"
    val chunks = if (grid) rows.chunked(columns) else emptyList()
    // `.dsx-list` is a flex column with NO align-items — flex's own default, so rows
    // stretch to the list's settled width and the list hugs the widest row (the web
    // contract; DsxFlex implements it). Short lists render eagerly on that geometry;
    // only a long bound list virtualizes (LazyColumn cannot hug-to-widest — a named
    // divergence of the virtualized path, sized by its viewport instead).
    if (!grid && rows.size <= MAX_DESKTOP_EAGER_ROWS) {
        DsxFlex(modifier, horizontal = false, spacingDp = spacing.value, crossAlign = "start", crossStretch = true) {
            rows.forEach { row ->
                template?.let { DesktopNode(it, context.store, context.runner, row, context.components) }
            }
        }
        return
    }
    val scrollingModifier = Modifier
        .heightIn(
            max = desktopCollectionViewportDp(
                windowHeightPx = LocalWindowInfo.current.containerSize.height,
                density = LocalDensity.current.density,
            ).dp,
        )
        .then(modifier)
    if (scroll) LazyColumn(scrollingModifier, verticalArrangement = Arrangement.spacedBy(spacing)) {
        if (grid) {
            itemsIndexed(chunks) { _, chunk ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(spacing)) {
                    chunk.forEach { row -> Box(Modifier.weight(1f)) { template?.let { DesktopNode(it, context.store, context.runner, row, context.components) } } }
                    repeat(columns - chunk.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        } else itemsIndexed(rows) { _, row ->
            template?.let { DesktopNode(it, context.store, context.runner, row, context.components) }
        }
    } else Column(modifier, verticalArrangement = Arrangement.spacedBy(spacing)) {
        // A non-scrolling collection must compose every child in its parent, so cap
        // that eager branch more tightly. Authors needing more rows must use the
        // virtualized default or paginate explicitly.
        if (grid) chunks.take(512).forEach { chunk ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(spacing)) {
                chunk.forEach { row -> Box(Modifier.weight(1f)) { template?.let { DesktopNode(it, context.store, context.runner, row, context.components) } } }
                repeat(columns - chunk.size) { Spacer(Modifier.weight(1f)) }
            }
        } else rows.take(512).forEach { row ->
            template?.let { DesktopNode(it, context.store, context.runner, row, context.components) }
        }
    }
}

/** Eager (CSS-faithful) list rendering bound: at or below it a list lays out on the
 * real flex geometry; above it the virtualized LazyColumn takes over. */
internal const val MAX_DESKTOP_EAGER_ROWS = 64

internal const val DEFAULT_DESKTOP_COLLECTION_VIEWPORT_DP = 720f
internal const val MAX_DESKTOP_COLLECTION_VIEWPORT_DP = 4_096f

/** LazyColumn rejects an infinite main-axis constraint. A window-derived ceiling keeps
 * collections virtualized and safe even when authored inside another scrolling node. */
internal fun desktopCollectionViewportDp(windowHeightPx: Int, density: Float): Float {
    if (windowHeightPx <= 0 || !density.isFinite() || density <= 0f) {
        return DEFAULT_DESKTOP_COLLECTION_VIEWPORT_DP
    }
    return (windowHeightPx.toDouble() / density.toDouble())
        .coerceIn(1.0, MAX_DESKTOP_COLLECTION_VIEWPORT_DP.toDouble())
        .toFloat()
}

@Composable
private fun DesktopModal(context: DesktopElementContext) {
    val attrs = context.attributes
    val presentKey = attrs["present"].orEmpty()
    val presented = when (context.node.tag) {
        "alert", "confirmDialog" -> attrs["visible"]?.let { expressionBoolean(it, context.store, context.item) } ?: true
        else -> boundBoolean(presentKey, context.store, context.item)
    }
    if (!presented) return
    fun dismiss() {
        if (presentKey.isNotEmpty()) context.store.writeBound(presentKey, false)
        attrs["on:dismiss"]?.let { context.run(it) }
    }
    if (context.node.tag == "alert" || context.node.tag == "confirmDialog") {
        AlertDialog(
            onDismissRequest = ::dismiss,
            title = attrs["title"]?.let { { Text(it) } },
            text = { if (context.node.children.isNotEmpty()) context.Children() else Text(attrs["message"].orEmpty()) },
            confirmButton = { Button(onClick = { attrs["on:confirm"]?.let { context.run(it) }; dismiss() }) { Text(attrs["confirm"] ?: "OK") } },
            dismissButton = if (context.node.tag == "confirmDialog") ({ Button(onClick = ::dismiss) { Text(attrs["cancel"] ?: "Cancel") } }) else null,
        )
    } else {
        DesktopSheet(context, ::dismiss)
    }
}

/** The presented `<sheet>`/`<cover>` surface, IN-SCENE (an overlay layer over the app
 * surface, the web overlay portal's twin) rather than a separate OS window: the
 * presentation contract the parity fixture pins is scrim + bottom detent panel over
 * the base screen (overlay-controls.ts `.dsx-sheet-panel` and its media steps), and a
 * detached window can express none of it. Panel geometry mirrors the web skin:
 * full-width below the 48rem step, centered `min(100vw - 48, 44rem)` above it; the
 * half detent is 50dvh, raised to `min(60dvh, 42rem)` on the desktop-density plane;
 * grabber band 28, chrome min 48 (53 with coarse 44px controls), content padded
 * 12/16 with children stretched (the content cell's grid default). */
@Composable
private fun DesktopSheet(context: DesktopElementContext, dismiss: () -> Unit) {
    val attrs = context.attributes
    val cover = context.node.tag == "cover"
    val detent = attrs["detents"]?.split(",")?.firstOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: "half"
    Popup(alignment = Alignment.TopStart, onDismissRequest = dismiss, properties = PopupProperties(focusable = true)) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val vw = maxWidth
            val vh = maxHeight
            val compact = vw.value < LayoutSemantics.COMPACT_BELOW
            Box(
                Modifier.fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.32f))
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = dismiss),
            )
            val panelWidth = if (cover || compact) vw else minOf(vw - 48.dp, 704.dp)
            val panelHeight: Dp? = when {
                cover -> vh
                detent == "full" -> vh - 8.dp
                detent == "half" -> if (vw.value >= 1024f) minOf(vh * 0.6f, 672.dp) else vh * 0.5f
                else -> null // content detent: wrap, capped below
            }
            val shape = if (cover) RectangleShape else RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)
            var panel = Modifier.align(Alignment.BottomCenter).width(panelWidth)
            panel = if (panelHeight != null) panel.height(panelHeight) else panel.heightIn(max = vh * 0.9f)
            DesktopParityCapture.session?.let { session ->
                if (session.capturesNode(context.node)) {
                    // The panel IS the sheet node's box; the skin radius joins the
                    // resolved attrs so the capture reports what the shape paints.
                    panel = panel.then(
                        desktopParityCaptureModifier(session, context.node, attrs + ("radius" to if (cover) "0" else "20")),
                    )
                }
            }
            Column(panel.background(color(attrs["background"] ?: "background"), shape)) {
                val chromeMin = if (compact) 53.dp else 48.dp
                val controlMin = if (compact) 44.dp else 36.dp
                if (!cover) {
                    Box(Modifier.fillMaxWidth().height(28.dp), contentAlignment = Alignment.Center) {
                        Box(Modifier.size(36.dp, 5.dp).background(color("tertiary").copy(alpha = 0.62f), RoundedCornerShape(999.dp)))
                    }
                }
                Box(Modifier.fillMaxWidth().heightIn(min = chromeMin)) {
                    Row(
                        Modifier.fillMaxWidth().align(Alignment.Center).padding(horizontal = 12.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier.size(controlMin)
                                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = dismiss)
                                .semantics { role = Role.Button; contentDescription = "Close" },
                            contentAlignment = Alignment.Center,
                        ) { Text("✕", color = color("secondary"), fontSize = 15.sp) }
                        Text(
                            attrs["title"].orEmpty(),
                            Modifier.weight(1f),
                            color = color("label"),
                            fontSize = 17.sp,
                            fontWeight = FontWeight.SemiBold,
                            textAlign = TextAlign.Center,
                            maxLines = 1,
                        )
                        Box(Modifier.sizeIn(minWidth = controlMin, minHeight = controlMin), contentAlignment = Alignment.Center) {
                            attrs["action"]?.let { label ->
                                Text(
                                    label,
                                    Modifier.clickable(
                                        interactionSource = remember { MutableInteractionSource() },
                                        indication = null,
                                    ) { attrs["on:action"]?.let { context.run(it) } },
                                    color = color("accent"),
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.Medium,
                                )
                            }
                        }
                    }
                    Divider(Modifier.align(Alignment.BottomStart), color = color("separator"), thickness = 1.dp)
                }
                DsxFlex(
                    Modifier.fillMaxWidth().weight(1f, fill = panelHeight != null)
                        .verticalScroll(rememberScrollState())
                        .padding(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 16.dp),
                    horizontal = false,
                    spacingDp = 0f,
                    crossAlign = "start",
                    crossStretch = true,
                ) { context.Children() }
            }
        }
    }
}

@Composable
internal fun color(raw: String, themeOverride: String? = null): Color =
    resolveColor(raw, themeOverride ?: LocalDesktopThemePin.current, MaterialTheme.colors)

/**
 * A colour resolver captured OUT of composition, for the one caller that cannot be in it: a
 * `DrawScope` lambda. `<canvas>` discovers its tokens while building the display list, which
 * happens inside the draw with the surface size in hand, so it takes this closure rather than
 * calling [color] per op. One vocabulary either way - both spellings end in [resolveColor].
 */
@Composable
internal fun rememberColorResolver(themeOverride: String? = null): (String) -> Color {
    val pin = themeOverride ?: LocalDesktopThemePin.current
    val colors = MaterialTheme.colors
    return remember(pin, colors) { { raw: String -> resolveColor(raw, pin, colors) } }
}

/**
 * The token vocabulary itself: pure, so a draw scope and a composable can share it. Splitting
 * it out of [color] changed no word and no value - the body below is verbatim what [color]
 * was, with the two composition reads lifted into parameters.
 */
internal fun resolveColor(
    raw: String, pin: String?, materialColors: androidx.compose.material.Colors,
): Color {
    val value = raw.trim()
    when (value.lowercase()) {
        "accent", "tint" -> return materialColors.primary
        "onaccent", "on-accent" -> return materialColors.onPrimary
        "label", "primary", "text" -> return when (pin) {
            "light" -> Color.Black
            "dark" -> Color.White
            else -> materialColors.onBackground
        }
        "secondary", "secondarylabel" -> return when (pin) {
            "light" -> Color.Black.copy(alpha = 0.60f)
            "dark" -> Color.White.copy(alpha = 0.60f)
            else -> materialColors.secondary
        }
        "tertiary", "tertiarylabel" -> return when (pin) {
            "light" -> Color.Black.copy(alpha = 0.38f)
            "dark" -> Color.White.copy(alpha = 0.38f)
            else -> materialColors.onBackground.copy(alpha = 0.55f)
        }
        "background", "systembackground", "groupedbackground" -> return when (pin) {
            "light" -> Color.White
            "dark" -> Color.Black
            else -> materialColors.background
        }
        "secondarybackground", "secondarygroupedbackground" -> return when (pin) {
            "light" -> Color(0xFFF2F2F7)
            "dark" -> Color(0xFF1C1C1E)
            else -> materialColors.surface
        }
        "tertiarybackground" -> return when (pin) {
            "light" -> Color(0xFFFFFFFF)
            "dark" -> Color(0xFF2C2C2E)
            else -> materialColors.surface
        }
        "surface", "fill", "fillfaint" -> return when (pin) {
            "light" -> Color(0xFFE5E5EA)
            "dark" -> Color(0xFF2C2C2E)
            else -> materialColors.surface
        }
        "outline", "separator" -> return when (pin) {
            "light" -> Color.Black.copy(alpha = 0.18f)
            "dark" -> Color.White.copy(alpha = 0.18f)
            else -> materialColors.onSurface.copy(alpha = 0.18f)
        }
        "danger", "error", "red" -> return materialColors.error
        "white" -> return Color.White
        "black" -> return Color.Black
        "clear", "transparent" -> return Color.Transparent
    }
    if (value.startsWith("#")) {
        val hex = value.drop(1)
        val parsed = hex.toLongOrNull(16)
        if (parsed != null) return when (hex.length) {
            6 -> Color(0xFF000000L or parsed)
            8 -> Color(parsed)
            else -> materialColors.onBackground
        }
    }
    val rgba = Regex("rgba?\\(([^)]+)\\)", RegexOption.IGNORE_CASE).matchEntire(value)
    if (rgba != null) {
        val parts = rgba.groupValues[1].split(',').map(String::trim)
        if (parts.size in 3..4) {
            val r = boundedNumberOrNull(parts[0], 0f, 255f)?.div(255f)
            val g = boundedNumberOrNull(parts[1], 0f, 255f)?.div(255f)
            val b = boundedNumberOrNull(parts[2], 0f, 255f)?.div(255f)
            val a = parts.getOrNull(3)?.let { boundedNumberOrNull(it, 0f, 1f) } ?: 1f
            if (r != null && g != null && b != null) return Color(r, g, b, a)
        }
    }
    return materialColors.onBackground
}

private fun isVisible(attrs: Map<String, String>, store: StackStore, item: Map<String, Any?>?): Boolean {
    if (attrs["hidden"] == "true" || attrs["css-hidden"] == "true") return false
    val expression = attrs["visible-if"] ?: attrs["visible"] ?: return true
    return expressionBoolean(expression, store, item)
}

private fun declaredControlBool(value: String?): Boolean {
    val v = value?.trim() ?: return false
    if (v == "true") return true
    val n = v.toDoubleOrNull() ?: return false
    return n != 0.0
}

private fun expressionBoolean(raw: String?, store: StackStore, item: Map<String, Any?>?): Boolean {
    if (raw == null) return false
    val expression = raw.removePrefix("{{").removeSuffix("}}").trim()
    return JSE.truthy(JSE.eval(expression, store, item))
}

private fun boundString(bind: String, store: StackStore, item: Map<String, Any?>?): String {
    if (bind.isEmpty()) return ""
    val value = JSE.eval(bind, store, item)
    return if (value == null || value === NSNull) "" else JSE.string(value)
}

private fun boundBoolean(bind: String, store: StackStore, item: Map<String, Any?>?): Boolean =
    bind.isNotEmpty() && JSE.truthy(JSE.eval(bind, store, item))

private fun boundNumber(bind: String, store: StackStore, item: Map<String, Any?>?): Float {
    if (bind.isEmpty()) return 0f
    return (JSE.number(JSE.eval(bind, store, item)) ?: 0.0).toFloat().takeIf(Float::isFinite) ?: 0f
}

internal const val MAX_DESKTOP_LAYOUT_DP = 100_000f
internal const val MAX_DESKTOP_SCALAR = 1_000_000f

internal fun boundedNumberOrNull(raw: String?, min: Float, max: Float): Float? =
    raw?.toFloatOrNull()?.takeIf(Float::isFinite)?.coerceIn(min, max)

internal fun boundedNumber(raw: String?, default: Float, min: Float, max: Float): Float {
    val fallback = default.takeIf(Float::isFinite)?.coerceIn(min, max) ?: min
    return boundedNumberOrNull(raw, min, max) ?: fallback
}

internal fun dimension(raw: String?, default: Float): Float =
    boundedNumber(raw, default, 0f, MAX_DESKTOP_LAYOUT_DP)

internal fun scalar(raw: String?, default: Float): Float =
    boundedNumber(raw, default, -MAX_DESKTOP_SCALAR, MAX_DESKTOP_SCALAR)

internal fun number(raw: String?, default: Float): Float =
    raw?.toFloatOrNull()?.takeIf(Float::isFinite) ?: default.takeIf(Float::isFinite) ?: 0f

private fun fontWeight(raw: String?): FontWeight = when (raw) {
    "light" -> FontWeight.Light
    "medium" -> FontWeight.Medium
    "semibold" -> FontWeight.SemiBold
    "bold" -> FontWeight.Bold
    "heavy" -> FontWeight.ExtraBold
    else -> FontWeight.Normal
}

/** The elements whose resting cross-axis law is the skin's own `align-self: stretch` /
 * width:100% (theme.ts `.dsx-progress`, `.dsx-slider`): they stretch to the settled
 * content width of a hugging container instead of forcing it wider. */
private val flexSelfStretchTags = setOf("progress", "capsuleProgress", "slider", "rangeSlider")

/** The web text law (theme.ts `.dsx-text`): `--dsx-type-body-size` 0.9375rem and a
 * 1.5 line-height at every size. */
internal const val DESKTOP_TEXT_BODY_SP = 15f
internal const val DESKTOP_TEXT_LINE_RATIO = 1.5f

/** Container align-items word → the DsxFlex placement word. `stretch` is carried by
 * crossStretch, so placement falls back to the container default. */
private fun flexCrossAlign(raw: String?, default: String): String = when (raw) {
    "center" -> "center"
    "trailing", "end", "flex-end", "bottom" -> "end"
    "leading", "start", "flex-start", "top" -> "start"
    else -> default
}

private fun boxAlignment(raw: String?): Alignment = when (raw) {
    "top" -> Alignment.TopCenter
    "bottom" -> Alignment.BottomCenter
    "leading" -> Alignment.CenterStart
    "trailing" -> Alignment.CenterEnd
    "topLeading" -> Alignment.TopStart
    "topTrailing" -> Alignment.TopEnd
    "bottomLeading" -> Alignment.BottomStart
    "bottomTrailing" -> Alignment.BottomEnd
    else -> Alignment.Center
}

private fun iconLabel(name: String?): String? = when (name) {
    null, "" -> null
    "plus" -> "+"
    "minus" -> "−"
    "xmark", "close" -> "×"
    "checkmark" -> "✓"
    "chevron.left" -> "‹"
    "chevron.right" -> "›"
    else -> name
}

private fun matchesShortcut(event: androidx.compose.ui.input.key.KeyEvent, shortcut: DesktopShortcut): Boolean {
    val primary = if (Platform.os == "macos") event.isMetaPressed else event.isCtrlPressed
    if (shortcut.primary != primary) return false
    if (shortcut.shift != event.isShiftPressed) return false
    if (shortcut.alt != event.isAltPressed) return false
    val keyName = shortcut.key
    val expected = when (keyName) {
        "enter", "return" -> Key.Enter
        "escape", "esc" -> Key.Escape
        "space" -> Key.Spacebar
        "tab" -> Key.Tab
        "up" -> Key.DirectionUp
        "down" -> Key.DirectionDown
        "left" -> Key.DirectionLeft
        "right" -> Key.DirectionRight
        else -> null
    }
    if (expected != null) return event.key == expected
    return keyName.length == 1 && event.utf16CodePoint != 0 &&
        event.utf16CodePoint.toChar().lowercaseChar() == keyName.single()
}

@Composable
private fun children(node: StackNode, store: StackStore, runner: JSERunner, item: Map<String, Any?>?, components: Map<String, StackNode>) {
    node.children.forEach { DesktopNode(it, store, runner, item, components) }
}

