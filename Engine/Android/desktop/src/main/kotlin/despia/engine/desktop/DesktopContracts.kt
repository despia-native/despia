package despia.engine.desktop

import despia.engine.JSE
import despia.engine.JSERunner
import despia.engine.Container
import despia.engine.ModuleRegistry
import despia.engine.StackNode
import despia.engine.Platform
import despia.engine.PlatformAttrs
import despia.engine.StackStorePublisher
import despia.engine.DSXCookies
import despia.engine.DSXEvents
import despia.engine.DSXMessenger
import despia.engine.DSXShared
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executor
import java.util.concurrent.FutureTask
import java.util.concurrent.atomic.AtomicBoolean
import javax.swing.SwingUtilities

/** Default accessibility labels for the adaptive shell's panes — the desktop twin of
 *  :render's `ElementDefaults.SCAFFOLD_*_LABEL`. Named constants rather than literals at
 *  the render site for the same reason the Android renderer uses them: the defaults are an
 *  element CATALOG, and one of them ("Sidebar") also happens to be a shipped component tag,
 *  which the renderer's selection path must never appear to branch on (root-plan.md rule 18). */
internal object DesktopElementDefaults {
    const val SCAFFOLD_SIDEBAR_LABEL = "Sidebar"  // rule18-ok: user-facing a11y STRING in an element defaults catalog, never tag selection
    const val SCAFFOLD_CONTENT_LABEL = "Content"
    const val SCAFFOLD_INSPECTOR_LABEL = "Inspector"
}

/** The one desktop UI-thread bridge. Compose Desktop/AWT owns the EDT; every timer,
 * network completion and after-render state mutation rejoins it through this seam. */
object DesktopUiDispatcher {
    private val executor = Executor { work -> dispatch { work.run() } }
    // Context dispatch is synchronous: callers read `handled` on return, and all
    // downstream event/surface egress inherits that dispatch thread. Keep ordinary
    // render/timer work asynchronous, but use an EDT sync hop for the registry exactly
    // as the Android host uses main.sync off-main.
    private val synchronousExecutor = Executor { work -> dispatchSynchronously { work.run() } }
    private val afterRender: ((() -> Unit) -> Unit) = { work -> dispatch(work) }
    private val installationLock = Any()
    private var installationCount = 0
    private var previousSeams: PreviousSeams? = null

    private data class PreviousSeams(
        val afterRender: ((() -> Unit) -> Unit),
        val runnerMain: Executor,
        val storeMain: Executor,
        val cookieMain: Executor,
        val eventMain: Executor,
        val sharedMain: Executor,
        val messengerInboundMain: Executor,
        val messengerOutboundMain: Executor,
        val registryMain: Executor,
        val containerObserverMain: Executor,
    )

    fun dispatch(work: () -> Unit) {
        if (SwingUtilities.isEventDispatchThread()) work() else SwingUtilities.invokeLater(work)
    }

    fun dispatchSynchronously(work: () -> Unit) {
        if (SwingUtilities.isEventDispatchThread()) {
            work()
            return
        }
        val task = FutureTask<Unit> { work() }
        SwingUtilities.invokeLater(task)
        var interrupted = false
        try {
            while (true) {
                try {
                    task.get()
                    return
                } catch (_: InterruptedException) {
                    // invokeLater has already accepted the action. Returning now would
                    // let a caller retry while the first side effect still executes.
                    // Join exactly once, then restore the caller's interrupt status.
                    interrupted = true
                } catch (failure: ExecutionException) {
                    throw failure.cause ?: failure
                }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt()
        }
    }

    fun install(): AutoCloseable {
        synchronized(installationLock) {
            if (installationCount == 0) {
                previousSeams = PreviousSeams(
                    afterRender = JSE.afterRenderDispatch,
                    runnerMain = JSERunner.mainExecutor,
                    storeMain = StackStorePublisher.mainExecutor,
                    cookieMain = DSXCookies.shared.mainExecutor,
                    eventMain = DSXEvents.mainExecutor,
                    sharedMain = DSXShared.mainExecutor,
                    messengerInboundMain = DSXMessenger.inboundMainExecutor,
                    messengerOutboundMain = DSXMessenger.outboundMainExecutor,
                    registryMain = ModuleRegistry.shared.mainExecutor,
                    containerObserverMain = Container.observerMainExecutor,
                )
                JSE.afterRenderDispatch = afterRender
                JSERunner.mainExecutor = executor
                StackStorePublisher.mainExecutor = executor
                DSXCookies.shared.mainExecutor = executor
                DSXEvents.mainExecutor = executor
                DSXShared.mainExecutor = executor
                DSXMessenger.inboundMainExecutor = executor
                DSXMessenger.outboundMainExecutor = synchronousExecutor
                ModuleRegistry.shared.mainExecutor = synchronousExecutor
                Container.observerMainExecutor = executor
            }
            installationCount += 1
        }
        val closed = AtomicBoolean(false)
        return AutoCloseable {
            if (!closed.compareAndSet(false, true)) return@AutoCloseable
            synchronized(installationLock) {
                installationCount -= 1
                if (installationCount == 0) {
                    val previous = checkNotNull(previousSeams)
                    previousSeams = null
                    // Do not overwrite a newer platform owner that deliberately replaced
                    // one of these global seams while the desktop surface was alive.
                    if (JSE.afterRenderDispatch === afterRender) JSE.afterRenderDispatch = previous.afterRender
                    if (JSERunner.mainExecutor === executor) JSERunner.mainExecutor = previous.runnerMain
                    if (StackStorePublisher.mainExecutor === executor) StackStorePublisher.mainExecutor = previous.storeMain
                    if (DSXCookies.shared.mainExecutor === executor) DSXCookies.shared.mainExecutor = previous.cookieMain
                    if (DSXEvents.mainExecutor === executor) DSXEvents.mainExecutor = previous.eventMain
                    if (DSXShared.mainExecutor === executor) DSXShared.mainExecutor = previous.sharedMain
                    if (DSXMessenger.inboundMainExecutor === executor) {
                        DSXMessenger.inboundMainExecutor = previous.messengerInboundMain
                    }
                    if (DSXMessenger.outboundMainExecutor === synchronousExecutor) {
                        DSXMessenger.outboundMainExecutor = previous.messengerOutboundMain
                    }
                    if (ModuleRegistry.shared.mainExecutor === synchronousExecutor) {
                        ModuleRegistry.shared.mainExecutor = previous.registryMain
                    }
                    if (Container.observerMainExecutor === executor) {
                        Container.observerMainExecutor = previous.containerObserverMain
                    }
                }
            }
        }
    }
}

/** Balanced pointer-hover state. Disposal after a recognized enter emits one matching
 * end, so removing a hovered node can never strand authored hover state. */
internal class DesktopHoverLifecycle(
    private val start: () -> Unit,
    private val end: () -> Unit,
) {
    var hovering: Boolean = false
        private set

    fun enter() {
        if (hovering) return
        hovering = true
        start()
    }

    fun exit() {
        if (!hovering) return
        hovering = false
        end()
    }

    fun dispose() = exit()
}

internal data class DesktopShortcut(
    val key: String,
    val primary: Boolean,
    val shift: Boolean,
    val alt: Boolean,
) {
    companion object {
        fun parse(raw: String): DesktopShortcut? {
            val parts = raw.lowercase().split('+').map(String::trim).filter(String::isNotEmpty)
            if (parts.isEmpty()) return null
            val key = parts.last()
            if (key !in setOf("enter", "return", "escape", "esc", "space", "tab", "up", "down", "left", "right") &&
                !(key.length == 1 && key.single().isLetterOrDigit())
            ) return null
            val modifiers = parts.dropLast(1)
            if (modifiers.any { it !in setOf("cmd", "meta", "ctrl", "primary", "shift", "alt", "option") }) return null
            val primary = modifiers.any { it in setOf("cmd", "meta", "ctrl", "primary") }
            // Window-global shortcuts run in the preview phase. Except for Escape,
            // unmodified keys would steal typing, caret movement, focus traversal, or
            // default activation from the focused native control.
            if (key !in setOf("escape", "esc") && !primary) return null
            return DesktopShortcut(
                key = key,
                primary = primary,
                shift = "shift" in modifiers,
                alt = modifiers.any { it == "alt" || it == "option" },
            )
        }
    }
}

internal data class DesktopShortcutAction(
    val shortcut: DesktopShortcut,
    val action: String,
)

/** Produces a global shortcut only for an actively interactive node. The renderer
 * supplies the fully resolved visibility/disabled state, including inherited hidden
 * state, so an invisible or disabled control can never remain in the window registry. */
internal fun desktopShortcutAction(
    attrs: Map<String, String>,
    interactive: Boolean,
): DesktopShortcutAction? {
    if (!interactive) return null
    val action = attrs["on:tap"]?.takeIf(String::isNotBlank) ?: return null
    val shortcut = attrs["shortcut"]?.let(DesktopShortcut::parse) ?: return null
    return DesktopShortcutAction(shortcut, action)
}

internal data class DesktopAccessibility(
    val label: String?,
    val hint: String?,
    val value: String?,
    val role: String?,
    val group: Boolean,
    val hidden: Boolean,
    val heading: Boolean,
    val selected: Boolean,
    val staticText: Boolean,
)

internal fun desktopAccessibility(tag: String, attrs: Map<String, String>): DesktopAccessibility {
    val traits = attrs["a11yTrait"].orEmpty().split(',')
        .map { it.trim().lowercase() }
        .filter { it in setOf("button", "header", "image", "link", "selected", "static") }
        .toSet()
    val staticText = "static" in traits
    val explicitRole = attrs["a11yRole"] ?: attrs["role"]?.takeUnless { it == "group" }
    return DesktopAccessibility(
        label = attrs["a11yLabel"] ?: attrs["accessibilityLabel"] ?: attrs["aria-label"],
        hint = attrs["a11yHint"] ?: attrs["accessibilityHint"] ?: attrs["aria-description"],
        value = attrs["a11yValue"] ?: attrs["accessibilityValue"] ?: attrs["aria-valuetext"],
        role = explicitRole ?: when {
            "link" in traits -> "link"
            "button" in traits -> "button"
            "image" in traits -> "image"
            staticText -> null
            else -> when (tag) {
            "button", "glassButton", "transport", "pressable", "row" -> "button"
            "toggle", "switch" -> "switch"
            "checkbox", "Checkbox" -> "checkbox"  // rule18-ok: tag -> ARIA role registration row (data); the renderer reads the role, not the name
            "image", "svg" -> "image"
            else -> if (attrs["on:tap"]?.isNotBlank() == true) "button" else null
            }
        },
        group = attrs["a11yGroup"] == "true" || attrs["role"] == "group",
        hidden = attrs["aria-hidden"] == "true" || attrs["a11yHidden"] == "true",
        heading = attrs["a11yHeading"] == "true" || "header" in traits || tag in setOf("heading", "title"),
        selected = "selected" in traits || attrs["selected"] == "true",
        staticText = staticText,
    )
}

/** Stable explicit traversal: numeric focusOrder first, authored document order as the
 * tie-break. Nodes without focusOrder stay in Compose's natural traversal. */
internal fun orderedFocusNodes(root: StackNode): List<StackNode> {
    val entries = ArrayList<Triple<Double, Int, StackNode>>()
    var authored = 0
    val pending = java.util.ArrayDeque<StackNode>()
    pending.addLast(root)
    while (pending.isNotEmpty()) {
        val node = pending.removeLast()
        val index = authored++
        PlatformAttrs.resolve(node.attrs, Platform.attributeTarget)["focusOrder"]
            ?.toDoubleOrNull()?.takeIf(Double::isFinite)?.let { entries += Triple(it, index, node) }
        for (childIndex in node.children.indices.reversed()) pending.addLast(node.children[childIndex])
    }
    return entries.sortedWith(compareBy({ it.first }, { it.second })).map { it.third }
}
