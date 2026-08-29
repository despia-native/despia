//
//  Menus.kt — `<menu>` (tap-to-open action menu), `<contextmenu>` (long-press menu) and
//  `<popover>` (the arrow-anchored bubble). Kotlin twins of Foundation Structure/Menu/
//  Menu.swift, Structure/ContextMenu/ContextMenu.swift and Structure/Popover/Popover.swift.
//
//  MENU/CONTEXTMENU — the REAL Material 3 `DropdownMenu` (system-defaults.md: the unstyled
//  baseline IS the platform — iOS shows the native UIMenu, this shows Android's native
//  action menu; M3 surface/elevation/shape/ripple). There is NO system-defaults gate: the
//  platter is never author-styleable (styling on `<menu>` lands on the trigger wrapper via
//  `elementStyle`; the items are DATA from `menu=`), so the menu always renders M3 — the
//  same "always system chrome" stance as the M3 date dialogs.
//
//  One shared item model (`menu=` is a bound JSON tree, exactly the iOS shape):
//  { title, icon, role: destructive, action, args } · { items: […] } nests as a submenu
//  (indefinitely, ContextMenu.swift menuItems recursion) · { separator: true } draws a
//  divider. A leaf `DropdownMenuItem` dispatches its bus call (dsx.dispatch twin) and
//  closes; `role: destructive` paints the row in the M3 `error` role (iOS's .destructive
//  red). The ONLY difference between the two tags is the OPEN gesture — tap (`<menu>`) vs
//  long-press (`<contextmenu>`) — mirroring Menu.swift's reuse of ContextMenuElement.menuItems.
//  Both keep the DSX gesture+a11y seam (detectTapGestures + dsxAccessibleActivation — the
//  raw-detector rule, AccessibilityModifiers.kt) so the arbitrary trigger slot keeps its own
//  gesture arbitration and gains no Material indication.
//
//  DIVERGENCE (M3, none silent): Material 3 ships no nested/submenu API, so a submenu PUSHES
//  IN PLACE inside the same DropdownMenu — the item navigates into its children behind a
//  "‹ parent" back row (chevron.left) — where iOS/UIKit stacks a fresh panel. Metrics/colors
//  are the M3 component's own (out of the parity spec — the menu/contextmenu fixtures pin
//  only `menu`, ElementSpec rule 4).
//
//  POPOVER — present= (two-way Bool key), arrow= top(default)/bottom/leading/trailing
//  (the edge of the BUBBLE the arrow sprouts from, pointing back at the anchor — SwiftUI
//  arrowEdge), default slot = the always-visible anchor, `content` slot = the bubble,
//  on:dismiss on tap-outside or programmatic present=false. Geometry (iOS UIPopover, pinned
//  approximations): bubble radius 13, regular material, 18×9 arrow triangle on the arrowed
//  edge. (`<popover>` is a DIFFERENT wave's element — the custom bubble is unchanged here.)
//

package despia.engine.render.elements

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import androidx.compose.foundation.Canvas
import despia.engine.DSXStrings
import despia.engine.JSE
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.StackIcon
import despia.engine.render.rememberAnimatorDurationScale
import despia.engine.render.StackStyle
import despia.engine.render.StackTheme
import despia.engine.render.dsxAccessibleActivation

internal fun registerMenuElements() {
    ComposeStackComponents.defineNative("menu") { ctx -> MenuElement(ctx, longPress = false) }
    ComposeStackComponents.defineNative("contextmenu") { ctx -> MenuElement(ctx, longPress = true) }
    ComposeStackComponents.defineNative("popover") { ctx -> PopoverElement(ctx) }
}

// MARK: - the shared item model (ContextMenu.swift item shape)

internal class MenuItem(d: Map<String, Any?>) {
    val separator: Boolean = (d["separator"] as? Boolean) == true
    // `title` is canonical. `label` shipped in early editor/reference examples, so retain
    // it as a read-only compatibility alias while generators now emit only `title`.
    val title: String = (d["title"] as? String) ?: (d["label"] as? String) ?: ""
    val icon: String = (d["icon"] as? String) ?: ""
    val destructive: Boolean = (d["role"] as? String) == "destructive"
    val action: String = (d["action"] as? String) ?: ""
    @Suppress("UNCHECKED_CAST")
    val args: Map<String, Any?> = (d["args"] as? Map<String, Any?>) ?: emptyMap()
    val items: List<MenuItem> = JSE.asRows(d["items"]).map { MenuItem(it) }   // a submenu — recurses
}

// MARK: - <menu> / <contextmenu>

@Composable
private fun MenuElement(ctx: ComposeStackComponentContext, longPress: Boolean) {
    val el = El(ctx)
    var open by remember { mutableStateOf(false) }
    val show = { open = true }
    val trigger = defaultSlot(ctx)
    val triggerLabel = menuTriggerAccessibilityLabel(el, trigger, longPress)
    Box(Modifier.elementStyle(el).then(
        Modifier
            .dsxAccessibleActivation(
                role = Role.Button,
                contentDescription = triggerLabel,
                onClickLabel = if (longPress) null else DSXStrings.localize("Open menu"),
                onLongClickLabel =
                    if (longPress) DSXStrings.localize("Open context menu") else null,
                // A nested native Button is its own semantics boundary and cannot merge into
                // this wrapper. Replace only the accessibility tree with one truthful menu
                // trigger while preserving the authored child pixels and pointer behavior.
                clearDescendants = true,
                onClick = if (!longPress) show else null,
                onLongClick = if (longPress) show else null,
            ),
    )) {
        SlotNodes(ctx, trigger)                                           // authored trigger pixels
        // The menu wrapper owns the gesture. Putting the recognizer only on the parent
        // lets a nested native Button consume the pointer before the wrapper can open.
        // This transparent, topmost hit plane preserves the authored child appearance
        // while giving <menu>/<contextmenu> the same reliable activation contract for
        // Text, Button, Image, and composed triggers.
        Box(
            Modifier
                .matchParentSize()
                .pointerInput(longPress) {
                    detectTapGestures(
                        onTap = if (!longPress) { { _ -> show() } } else null,
                        onLongPress = if (longPress) { { _ -> show() } } else null,
                    )
                },
        )
        M3Menu(el.list("menu").map { MenuItem(it) }, expanded = open) { open = false }
    }
}

private fun menuTriggerAccessibilityLabel(
    el: El,
    trigger: List<despia.engine.StackNode>,
    longPress: Boolean,
): String {
    val authored = el.str("a11yLabel")
    if (authored.isNotEmpty()) return authored
    val attributes = trigger.firstOrNull()?.attrs.orEmpty()
    for (key in listOf("a11yLabel", "label", "value")) {
        attributes[key]?.takeIf { it.isNotEmpty() }?.let { return it }
    }
    return DSXStrings.localize(if (longPress) "Context menu" else "Menu")
}

/// The real M3 `DropdownMenu` of the item tree, anchored to the trigger Box. Submenus PUSH
/// IN PLACE (a `trail` of levels + a "‹ parent" back row) because Material 3 ships no nested
/// menu API (header divergence); a leaf `DropdownMenuItem` dispatches its bus call and
/// closes; `role: destructive` paints the M3 `error` role. `trail` resets on each OPEN
/// (`remember(expanded)`), so a reopened menu always starts at the root level.
@Composable
internal fun M3Menu(items: List<MenuItem>, expanded: Boolean, onDismiss: () -> Unit) {
    val trail = remember(expanded) { mutableStateListOf<Pair<String, List<MenuItem>>>() }
    val level = trail.lastOrNull()?.second ?: items
    val cs = StackTheme.scheme ?: MaterialTheme.colorScheme
    val iconColor = cs.onSurfaceVariant                                   // M3 menu-item icon role
    val errorColor = cs.error                                            // destructive (iOS's .destructive red)
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        trail.lastOrNull()?.let { (parentTitle, _) ->                     // the submenu back row
            DropdownMenuItem(
                text = { Text(parentTitle) },
                leadingIcon = { StackIcon("chevron.left", MENU_ICON_SIZE, iconColor) },
                onClick = { trail.removeAt(trail.size - 1) },
            )
            HorizontalDivider()
        }
        for (item in level) {
            when {
                item.separator -> HorizontalDivider()                     // the section divider
                item.items.isNotEmpty() -> DropdownMenuItem(              // a submenu → push in place
                    text = { Text(item.title) },
                    leadingIcon = if (item.icon.isEmpty()) null
                                  else ({ StackIcon(item.icon, MENU_ICON_SIZE, iconColor) }),
                    trailingIcon = { StackIcon("chevron.right", MENU_ICON_SIZE, iconColor) },
                    onClick = { trail.add(item.title to item.items) },
                )
                else -> DropdownMenuItem(                                 // a leaf → dispatch + close
                    text = { if (item.destructive) Text(item.title, color = errorColor) else Text(item.title) },
                    leadingIcon = if (item.icon.isEmpty()) null
                                  else ({ StackIcon(item.icon, MENU_ICON_SIZE, if (item.destructive) errorColor else iconColor) }),
                    onClick = {
                        if (item.action.isNotEmpty()) dispatchCall(item.action, item.args)
                        onDismiss()
                    },
                )
            }
        }
    }
}

private const val MENU_ICON_SIZE = 20.0   // M3 DropdownMenuItem icon (OS chrome — out of the parity spec)

// MARK: - <popover>

/// `arrow` → the bubble edge the arrow sprouts from (SwiftUI arrowEdge): the default
/// `top` puts the bubble BELOW the anchor, `bottom` above, `leading` to its trailing
/// side, `trailing` to its leading side.
internal fun popoverArrowEdge(token: String): String = when (token) {
    "bottom", "leading", "trailing" -> token
    else -> "top"
}

@Composable
private fun PopoverElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val key = ctx.attrs["present"] ?: ""
    val present = el.presented(key)
    FireOnDismiss(present, el)
    val edge = popoverArrowEdge(el.str("arrow"))
    // Presentation motion — the web dsx-float-zoom twin (scale 0.95 → 1 + fade, 200ms
    // dur-base) / the iOS popover fade; collapses under reduced motion. The popup stays
    // mounted through the exit (MutableTransitionState) so dismissal animates too.
    val reduceMotion = rememberAnimatorDurationScale() == 0f
    val visibleState = remember { MutableTransitionState(false) }
    visibleState.targetState = present
    Box(Modifier.elementStyle(el)) {
        SlotNodes(ctx, defaultSlot(ctx))                                  // the anchor renders inline
        if (reduceMotion) {
            if (present) {
                Popup(popupPositionProvider = PopoverPosition(edge),
                      onDismissRequest = { el.dismissBound() },           // tap-outside / BACK
                      properties = PopupProperties(focusable = true)) {
                    PopoverBubble(edge) { SlotNodes(ctx, namedSlot(ctx, "content")) }
                }
            }
        } else if (present || visibleState.currentState || !visibleState.isIdle) {
            Popup(popupPositionProvider = PopoverPosition(edge),
                  onDismissRequest = { el.dismissBound() },               // tap-outside / BACK
                  properties = PopupProperties(focusable = true)) {
                AnimatedVisibility(
                    visibleState = visibleState,
                    enter = scaleIn(tween(POPOVER_MOTION_MS), initialScale = POPOVER_ZOOM_FROM) +
                        fadeIn(tween(POPOVER_MOTION_MS)),
                    exit = scaleOut(tween(POPOVER_MOTION_MS), targetScale = POPOVER_ZOOM_FROM) +
                        fadeOut(tween(POPOVER_MOTION_MS)),
                ) {
                    PopoverBubble(edge) { SlotNodes(ctx, namedSlot(ctx, "content")) }
                }
            }
        }
    }
}

private const val POPOVER_MOTION_MS = 200      // the web --dsx-dur-base
private const val POPOVER_ZOOM_FROM = 0.95f    // the web dsx-float-zoom starting scale

/// Bubble beside the arrowed edge: arrow 18×9 (regular material, like the bubble),
/// bubble radius 13. Column for top/bottom, Row for leading/trailing.
@Composable
private fun PopoverBubble(edge: String, content: @Composable () -> Unit) {
    val fill = StackStyle.material("regular")
    val bubble: @Composable () -> Unit = {
        Box(Modifier.clip(RoundedCornerShape(13.dp)).background(fill)) { content() }
    }
    when (edge) {
        "top" -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
            PopoverArrow(edge, fill); bubble()
        }
        "bottom" -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
            bubble(); PopoverArrow(edge, fill)
        }
        "leading" -> Row(verticalAlignment = Alignment.CenterVertically) {
            PopoverArrow(edge, fill); bubble()
        }
        else -> Row(verticalAlignment = Alignment.CenterVertically) {
            bubble(); PopoverArrow(edge, fill)
        }
    }
}

/// The arrow triangle pointing back at the anchor — 18×9 on top/bottom, 9×18 on the sides.
@Composable
private fun PopoverArrow(edge: String, fill: Color) {
    val m = if (edge == "top" || edge == "bottom") Modifier.size(18.dp, 9.dp) else Modifier.size(9.dp, 18.dp)
    Canvas(m) { drawArrow(edge, fill) }
}

private fun DrawScope.drawArrow(edge: String, fill: Color) {
    val p = Path()
    val w = size.width; val h = size.height
    when (edge) {
        "top" ->    { p.moveTo(w / 2, 0f); p.lineTo(w, h); p.lineTo(0f, h) }          // points up
        "bottom" -> { p.moveTo(0f, 0f); p.lineTo(w, 0f); p.lineTo(w / 2, h) }         // points down
        "leading" -> { p.moveTo(0f, h / 2); p.lineTo(w, 0f); p.lineTo(w, h) }         // points left
        else ->     { p.moveTo(0f, 0f); p.lineTo(w, h / 2); p.lineTo(0f, h) }         // points right
    }
    p.close()
    drawPath(p, fill)
}

/// Popup placement per arrow edge — centered on the anchor's cross axis, flush on the
/// arrowed side, clamped into the window.
private class PopoverPosition(private val edge: String) : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize,
                                   layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val cx = anchorBounds.left + (anchorBounds.width - popupContentSize.width) / 2
        val cy = anchorBounds.top + (anchorBounds.height - popupContentSize.height) / 2
        val (x, y) = when (edge) {
            "top" -> cx to anchorBounds.bottom
            "bottom" -> cx to anchorBounds.top - popupContentSize.height
            "leading" -> anchorBounds.right to cy
            else -> anchorBounds.left - popupContentSize.width to cy
        }
        return IntOffset(x.coerceIn(0, maxOf(0, windowSize.width - popupContentSize.width)),
                         y.coerceIn(0, maxOf(0, windowSize.height - popupContentSize.height)))
    }
}
