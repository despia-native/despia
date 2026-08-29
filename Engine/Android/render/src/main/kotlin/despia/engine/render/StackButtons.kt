//
//  StackButtons.kt — the SYSTEM BUTTON path (system-defaults.md): a button-family
//  element with NO author styling renders the REAL Material 3 control, and the ratified
//  variant words select AMONG system renderings without ejecting:
//
//    (unstyled)              → TextButton            (iOS: borderless / web: .dsx-button)
//    variant="bordered"      → FilledTonalButton     (iOS: .bordered / web: tonal skin)
//    variant="prominent"     → Button (filled)       (iOS: .borderedProminent / web: filled)
//    role="destructive"      → the M3 error emphasis (iOS: .destructive / web: danger skin)
//    role="cancel"           → the dismissive weight (semibold label — the web's 600)
//
//  BUTTON_ROLES mirrors the web reference (packages/dom/src/elements.ts): ONLY these two
//  role words are button-role grammar — every other `role=` value keeps its accessibility
//  meaning (StackStyle.apply's a11y block, which excludes exactly these two words).
//
//  THE INERT-LANDING INVARIANT (the law's migration step 1), RECONCILED: any
//  author-specified style wins exactly as before — `rendersSystem` is an ALLOWLIST with
//  the variant/role WORDS as the author's explicit OPT-IN (no pre-law markup carries
//  these words):
//    • no words → system ONLY for the fully-unstyled button (every attr in SAFE_BASE);
//      `color=`/`iconSize=` EJECT to the legacy box path in StackNodeView.kt
//      byte-identically (pre-law they styled that box — hijacking them into M3 broke
//      the byte-identical promise).
//    • words → system when every attr is SAFE_BASE ∪ LAYOUT ∪ {color, iconSize}:
//      `color` is the documented compatible tint, LAYOUT attrs thread onto the M3
//      control inside its tap target (the iOS controlBox twin — StackNodeView.kt).
//    • words + a LOOK attr (background/radius/font/shadow/…) → eject.
//  `pressable`/`row` never come here (bare containers — the web's .dsx-pressable twin),
//  and neither does a button with markup children (composed custom content).
//
//  ── DEVIATIONS from the Swift twin (pinned, none silent) ────────────────────────────
//  • A word + a LOOK attr EJECTS on Android (the whole element drops to the legacy box,
//    the word inert) pending the systemPath catalog wave; iOS layers the variant
//    rendering above author styles. Cross-renderer divergence, pinned here.
//  • The unstyled palettes come from ButtonDefaults, not a hand-copied ColorScheme
//    reconstruction. Authored tint/destructive semantics override only the roles they
//    actually own; disabled colors, state layers, typography, and shape stay M3-owned.
//  • `color=` is the compatible tint tweak (spec: applies ONTO the system component,
//    never ejects — but ONLY under a variant/role word, see the gate): content color on
//    text/tonal, container on filled — the iOS `.tint` contract.
//  • iconSize keeps the DSX default (ElementDefaults.BUTTON_ICON_SIZE, 20) rather than
//    M3's 18dp ButtonDefaults.IconSize — the cross-platform fixture pins 20.
//

package despia.engine.render

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/// The pure halves of the system-button decision — plain-JVM tested (StackButtonsTest).
object SystemButton {

    /// The button ROLE words — the web BUTTON_ROLES twin (elements.ts): `destructive` and
    /// `cancel` are button-role grammar on button-family elements; anything else stays an
    /// accessibility role (StackStyle.apply consumes it, excluding exactly these two).
    val BUTTON_ROLES: Set<String> = setOf("destructive", "cancel")

    enum class Variant { Text, Tonal, Filled }

    /// variant word → the M3 component tier. Unknown words keep the base rendering, the
    /// web behavior (an unmatched data-dsx-variant selects no skin).
    fun variant(word: String?): Variant = when (word?.trim()) {
        "bordered" -> Variant.Tonal
        "prominent" -> Variant.Filled
        else -> Variant.Text
    }

    // The always-safe base — identity, content, the word grammar itself, navigation,
    // visibility/motion (they wrap OUTSIDE raw()), and accessibility. NOT color/iconSize:
    // those styled the pre-law legacy box, so without a word they must keep doing exactly
    // that (the hijack fix). The cascade (resolvedAttrs) has already folded classes/
    // sheets/inline CSS into plain attribute keys, so any authored styling — from ANY
    // layer — appears here as a key outside the allowed set and ejects to the legacy
    // path. Unknown attributes eject too: the safe direction is always "render exactly
    // as before".
    private val SAFE_BASE = setOf(
        "id", "key", "label", "icon", "variant", "role", "href", "disabled",
        "disabled-if", "density",
        "class", "css-owner", "visible-if", "keep", "enter", "anim", "animDuration",
        "transition", "a11yGroup", "a11yLabel", "a11yHint", "a11yValue", "a11yTrait",
        "a11yHidden",
    )
    private val COMPAT_PREFIXES = listOf("on:", "arg:", "aria-")

    /// The LAYOUT attrs a variant/role word admits onto the M3 control — exactly the
    /// box-geometry arms StackStyle.apply implements (padding family, fixed frame,
    /// min/max clamps, grow; the `margin`/flex spellings have no apply() arm today).
    /// Threaded INSIDE the tap target at the dispatch site — the iOS controlBox twin.
    val LAYOUT: Set<String> = setOf(
        "padding", "paddingH", "paddingX", "paddingV", "paddingY",
        "paddingTop", "paddingBottom", "paddingLeading", "paddingLeft",
        "paddingTrailing", "paddingRight",
        "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "grow",
    )

    /// The system-path gate — the RECONCILED rule (system-defaults.md): a variant/role
    /// WORD is the author's explicit opt-in to the system path (no pre-law markup
    /// carries these words; a `role=` outside BUTTON_ROLES stays pure accessibility and
    /// opts into nothing). Without a word only a fully-unstyled button renders system —
    /// `color=`/`iconSize=` eject with every other styling attr, keeping the pre-law
    /// legacy box byte-identical. With a word, `color` (the compatible tint), `iconSize`,
    /// and the LAYOUT attrs are admitted onto the M3 control; any LOOK attr still ejects.
    fun rendersSystem(attrs: Map<String, String>): Boolean {
        val words = attrs.containsKey("variant") || (attrs["role"]?.trim() ?: "") in BUTTON_ROLES
        return attrs.keys.all { k ->
            k in SAFE_BASE || COMPAT_PREFIXES.any { k.startsWith(it) } ||
                (words && (k in LAYOUT || k == "color" || k == "iconSize"))
        }
    }
}

/// The real M3 control. All inputs arrive RESOLVED (interpolated) from the dispatch
/// site in StackNodeView.kt; `m` carries decorate (longpress) + the a11y semantics of
/// StackStyle.apply — with no style attrs present, that chain contributes no visuals.
/// `box` is the LAYOUT slice of the chain (words path only), applied around the CONTENT
/// inside the control — the iOS controlBox twin: the padded/grown box IS the tap target,
/// M3's own content padding wrapping outside it exactly like the iOS control inset.
@Composable
internal fun M3ButtonView(
    modifier: Modifier,
    box: Modifier = Modifier,
    label: String?,
    icon: String?,
    iconSize: Double,
    authorTint: Color?,
    variantWord: String?,
    roleWord: String?,
    disabled: Boolean,
    onTap: (() -> Unit)?,
) {
    val m = modifier
    val cs = StackTheme.scheme ?: MaterialTheme.colorScheme
    val variant = SystemButton.variant(variantWord)
    val destructive = roleWord?.trim() == "destructive"
    val cancel = roleWord?.trim() == "cancel"
    val colors: ButtonColors = when (variant) {
        SystemButton.Variant.Text -> {
            if (authorTint != null || destructive) {
                ButtonDefaults.textButtonColors(
                    contentColor = authorTint ?: cs.error,
                )
            } else {
                ButtonDefaults.textButtonColors()
            }
        }
        SystemButton.Variant.Tonal -> {
            if (authorTint != null || destructive) {
                ButtonDefaults.filledTonalButtonColors(
                    containerColor = if (destructive) cs.errorContainer else cs.secondaryContainer,
                    contentColor = authorTint ?: cs.onErrorContainer,
                )
            } else {
                ButtonDefaults.filledTonalButtonColors()
            }
        }
        SystemButton.Variant.Filled -> {
            if (authorTint != null || destructive) {
                ButtonDefaults.buttonColors(
                    containerColor = authorTint ?: cs.error,
                    contentColor = if (destructive) cs.onError else cs.onPrimary,
                )
            } else {
                ButtonDefaults.buttonColors()
            }
        }
    }
    val content = colors.contentColor
    val click = onTap ?: {}
    val body: @Composable RowScope.() -> Unit = {
        // The controlBox: `box` (the layout arms) frames the icon/label group INSIDE the
        // control's tappable core — content centers in the grown/padded box like the
        // SwiftUI frame default; Modifier (the no-layout case) collapses to a plain hug.
        Box(box, contentAlignment = Alignment.Center) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (!icon.isNullOrEmpty()) {
                    StackIcon(icon, iconSize, content)
                    if (!label.isNullOrEmpty()) Spacer(Modifier.width(8.dp))   // M3 icon-to-label gap
                }
                if (!label.isNullOrEmpty()) {
                    Text(label, fontWeight = if (cancel) FontWeight.SemiBold else null)
                }
            }
        }
    }
    when (variant) {
        SystemButton.Variant.Text ->
            TextButton(onClick = click, modifier = m, enabled = !disabled, colors = colors, content = body)
        SystemButton.Variant.Tonal ->
            FilledTonalButton(onClick = click, modifier = m, enabled = !disabled, colors = colors, content = body)
        SystemButton.Variant.Filled ->
            Button(onClick = click, modifier = m, enabled = !disabled, colors = colors, content = body)
    }
}
