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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.AlertDialog
import androidx.compose.material.Button
import androidx.compose.material.ButtonDefaults
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
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
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogWindow
import despia.engine.DSX
import despia.engine.AdaptiveShell
import despia.engine.JSE
import despia.engine.JSERunner
import despia.engine.NSNull
import despia.engine.OnHandler
import despia.engine.Platform
import despia.engine.PlatformAttrs
import despia.engine.SlotContent
import despia.engine.StackFormula
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
    "script", "functions", "style", "attribute", "component", "watch",
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
    "scene",
    "slot",
) + desktopExtendedNativeTags

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
            DesktopNode(root, store, runner, null, components)
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
internal fun prepareDesktopDocument(root: StackNode, store: StackStore): Map<String, StackNode> {
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
                    val value = JSE.evalBlock(node.text ?: attrs["value"] ?: "", store, null) ?: ""
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
            "component" -> Unit
        }
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

internal fun desktopComponentAttributes(attrs: Map<String, String>): Map<String, Any?> =
    attrs.filterKeys { key -> key != "tag" && key != "id" && !key.startsWith("on:") && !key.startsWith("from:") }

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
    val declaredDisabled = attrs["disabled"] == "true" || expressionBoolean(attrs["disabled-if"], store, item)
    val interactionsEnabled = LocalDesktopInteractionsEnabled.current && visible && !declaredDisabled
    val disabled = !interactionsEnabled
    val themePin = attrs["theme"]?.takeIf { it == "light" || it == "dark" } ?: inheritedTheme
    DesktopShortcutRegistration(attrs, item, interactionsEnabled)

    val packageRenderer = DesktopElements.renderer(node.tag)
    val componentTemplate = components[node.tag]

    var modifier = desktopVisibilityModifier(
        desktopStyleModifier(Modifier, attrs),
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
    modifier = desktopUniversalModifier(modifier, node, attrs, store, runner, item, disabled)

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
    val context = DesktopElementContext(node, attrs, store, runner, item, components)

    CompositionLocalProvider(
        LocalDesktopInteractionsEnabled provides interactionsEnabled,
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
                val childRunner = remember(node, runner, store) {
                    JSERunner(
                        store = store,
                        webView = runner.webView,
                        scope = runner.scope,
                        onHandlers = HashMap(runner.onHandlers),
                        dsx = runner.dsx,
                        measuring = runner.measuring,
                        depth = runner.depth + 1,
                    )
                }
                val componentAttributes = desktopComponentAttributes(attrs)
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
                    DesktopNode(componentTemplate, store, childRunner, componentAttributes, components)
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
        "script", "functions", "style", "component" -> Unit
        "attribute" -> DesktopAttribute(attrs, store, runner, item)
        "watch" -> DesktopWatch(attrs, store, runner, item)

        "html", "body", "page", "screen", "view", "template", "section", "group" ->
            Column(modifier) { children(node, store, runner, item, components) }

        "scaffold" -> DesktopScaffold(context, modifier)

        "stack", "vstack", "card" -> {
            val spacing = dimension(attrs["spacing"] ?: attrs["gap"], if (node.tag == "stack") 0f else 8f).dp
            val row = attrs["flexDirection"]?.startsWith("row") == true
            if (row) Row(modifier, horizontalArrangement = Arrangement.spacedBy(spacing), verticalAlignment = verticalAlignment(attrs["align"] ?: attrs["alignItems"])) {
                rowChildren(node, store, runner, item, components)
            } else Column(modifier, verticalArrangement = Arrangement.spacedBy(spacing), horizontalAlignment = horizontalAlignment(attrs["align"] ?: attrs["alignItems"])) {
                columnChildren(node, store, runner, item, components)
            }
        }

        "form" -> DesktopForm(context, modifier, disabled)

        "hstack", "toolbar", "flow" -> Row(
            modifier,
            horizontalArrangement = Arrangement.spacedBy(dimension(attrs["spacing"], 8f).dp),
            verticalAlignment = verticalAlignment(attrs["align"] ?: attrs["alignItems"]),
        ) { rowChildren(node, store, runner, item, components) }

        "zstack", "overlay" -> Box(modifier, contentAlignment = boxAlignment(attrs["align"])) {
            children(node, store, runner, item, components)
        }

        "scroll", "refreshable", "refresh" -> Column(
            modifier.verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(dimension(attrs["spacing"], 0f).dp),
            horizontalAlignment = horizontalAlignment(attrs["align"] ?: attrs["alignItems"]),
        ) { columnChildren(node, store, runner, item, components) }

        "divider" -> Divider(modifier, color = color(attrs["color"] ?: "outline"), thickness = dimension(attrs["height"], 1f).dp)
        "spacer" -> Spacer(modifier.size(dimension(attrs["width"], 8f).dp, dimension(attrs["height"], 8f).dp))

        "text", "label", "heading", "title", "subtitle", "paragraph", "code" -> renderText(node, attrs, modifier, store, item)

        "button", "glassButton", "transport" -> DesktopButton(context, modifier, disabled)

        "pressable", "row" -> Box(
            modifier.clickable(enabled = !disabled) {
                attrs["on:tap"]?.let { desktopRunEvent(node, "tap", it, attrs, store, runner, item) }
            },
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
                modifier = modifier.then(if (node.tag == "textarea") Modifier.heightIn(min = 112.dp) else Modifier),
                enabled = !disabled,
                singleLine = node.tag != "textarea",
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

        "progress", "capsuleProgress" -> LinearProgressIndicator(
            progress = (attrs["bind"]?.let { boundNumber(it, store, item) } ?: number(attrs["value"], 0f)).coerceIn(0f, 1f),
            modifier = modifier.fillMaxWidth(),
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
                        DesktopNode(child, store, slot.runner, slot.item, components)
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
    val fontSize = desktopFontSize(attrs)
    val lineSpacing = boundedNumberOrNull(attrs["lineSpacing"], -1_000f, 1_000f)
    val lineHeight = if (lineSpacing != null && fontSize != androidx.compose.ui.unit.TextUnit.Unspecified) {
        (fontSize.value + lineSpacing).coerceAtLeast(0.5f).sp
    } else androidx.compose.ui.unit.TextUnit.Unspecified
    Text(
        text = when (attrs["textCase"]) { "upper" -> displayed.uppercase(); "lower" -> displayed.lowercase(); else -> displayed },
        modifier = modifier,
        color = color(attrs["color"] ?: "label"),
        fontSize = fontSize,
        fontWeight = fontWeight(attrs["fontWeight"]),
        fontStyle = if (attrs["italic"] == "true") FontStyle.Italic else FontStyle.Normal,
        fontFamily = when (attrs["fontDesign"]) {
            "monospaced", "mono" -> FontFamily.Monospace
            "serif" -> FontFamily.Serif
            "rounded" -> FontFamily.SansSerif
            else -> FontFamily.Default
        },
        textDecoration = decoration,
        textAlign = when (attrs["textAlign"]) { "center" -> TextAlign.Center; "trailing", "right" -> TextAlign.End; else -> TextAlign.Start },
        maxLines = attrs["lineLimit"]?.toIntOrNull()?.coerceIn(1, 100_000) ?: Int.MAX_VALUE,
        lineHeight = lineHeight,
        letterSpacing = boundedNumberOrNull(attrs["tracking"], -1_000f, 1_000f)?.sp
            ?: androidx.compose.ui.unit.TextUnit.Unspecified,
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

@Composable
private fun DesktopTabs(context: DesktopElementContext, modifier: Modifier) {
    val bind = context.attributes["value"].orEmpty()
    val bound = if (bind.isEmpty()) 0 else boundNumber(bind, context.store, context.item).roundToInt()
    var local by remember { mutableStateOf(bound) }
    val selected = (if (bind.isEmpty()) local else bound).coerceIn(0, (context.node.children.size - 1).coerceAtLeast(0))
    Column(modifier) {
        if (context.node.children.isNotEmpty()) {
            TabRow(selectedTabIndex = selected) {
                context.node.children.forEachIndexed { index, child ->
                    Tab(selected = selected == index, onClick = {
                        local = index
                        if (bind.isNotEmpty()) context.store.writeBound(bind, index.toDouble())
                        context.attributes["on:change"]?.let { context.run(it, mapOf("value" to index)) }
                    }, text = { Text(child.attrs["tabTitle"] ?: "Tab ${index + 1}") })
                }
            }
            DesktopNode(context.node.children[selected], context.store, context.runner, context.item, context.components)
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
        DialogWindow(onCloseRequest = ::dismiss, title = attrs["title"] ?: "DSX") {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) { context.Children() }
        }
    }
}

@Composable
internal fun color(raw: String, themeOverride: String? = null): Color {
    val value = raw.trim()
    val pin = themeOverride ?: LocalDesktopThemePin.current
    when (value.lowercase()) {
        "accent", "tint" -> return MaterialTheme.colors.primary
        "onaccent", "on-accent" -> return MaterialTheme.colors.onPrimary
        "label", "primary", "text" -> return when (pin) {
            "light" -> Color.Black
            "dark" -> Color.White
            else -> MaterialTheme.colors.onBackground
        }
        "secondary", "secondarylabel" -> return when (pin) {
            "light" -> Color.Black.copy(alpha = 0.60f)
            "dark" -> Color.White.copy(alpha = 0.60f)
            else -> MaterialTheme.colors.secondary
        }
        "tertiary", "tertiarylabel" -> return when (pin) {
            "light" -> Color.Black.copy(alpha = 0.38f)
            "dark" -> Color.White.copy(alpha = 0.38f)
            else -> MaterialTheme.colors.onBackground.copy(alpha = 0.55f)
        }
        "background", "systembackground", "groupedbackground" -> return when (pin) {
            "light" -> Color.White
            "dark" -> Color.Black
            else -> MaterialTheme.colors.background
        }
        "secondarybackground", "secondarygroupedbackground" -> return when (pin) {
            "light" -> Color(0xFFF2F2F7)
            "dark" -> Color(0xFF1C1C1E)
            else -> MaterialTheme.colors.surface
        }
        "tertiarybackground" -> return when (pin) {
            "light" -> Color(0xFFFFFFFF)
            "dark" -> Color(0xFF2C2C2E)
            else -> MaterialTheme.colors.surface
        }
        "surface", "fill", "fillfaint" -> return when (pin) {
            "light" -> Color(0xFFE5E5EA)
            "dark" -> Color(0xFF2C2C2E)
            else -> MaterialTheme.colors.surface
        }
        "outline", "separator" -> return when (pin) {
            "light" -> Color.Black.copy(alpha = 0.18f)
            "dark" -> Color.White.copy(alpha = 0.18f)
            else -> MaterialTheme.colors.onSurface.copy(alpha = 0.18f)
        }
        "danger", "error", "red" -> return MaterialTheme.colors.error
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
            else -> MaterialTheme.colors.onBackground
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
    return MaterialTheme.colors.onBackground
}

private fun isVisible(attrs: Map<String, String>, store: StackStore, item: Map<String, Any?>?): Boolean {
    if (attrs["hidden"] == "true" || attrs["css-hidden"] == "true") return false
    val expression = attrs["visible-if"] ?: attrs["visible"] ?: return true
    return expressionBoolean(expression, store, item)
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

private fun horizontalAlignment(raw: String?): Alignment.Horizontal = when (raw) {
    "center" -> Alignment.CenterHorizontally
    "trailing", "end", "flex-end" -> Alignment.End
    else -> Alignment.Start
}

private fun verticalAlignment(raw: String?): Alignment.Vertical = when (raw) {
    "top", "start", "flex-start" -> Alignment.Top
    "bottom", "end", "flex-end" -> Alignment.Bottom
    else -> Alignment.CenterVertically
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

@Composable
private fun ColumnScope.columnChildren(node: StackNode, store: StackStore, runner: JSERunner, item: Map<String, Any?>?, components: Map<String, StackNode>) {
    node.children.forEach { child ->
        if (child.tag == "spacer" && child.attrs["height"] == null) Spacer(Modifier.weight(1f))
        else DesktopNode(child, store, runner, item, components)
    }
}

@Composable
private fun RowScope.rowChildren(node: StackNode, store: StackStore, runner: JSERunner, item: Map<String, Any?>?, components: Map<String, StackNode>) {
    node.children.forEach { child ->
        if (child.tag == "spacer" && child.attrs["width"] == null) Spacer(Modifier.weight(1f))
        else DesktopNode(child, store, runner, item, components)
    }
}
