//
//  ElementSpec.kt — the ELEMENT PARITY registry: every element this renderer implements
//  declares its parity-relevant constants (attribute defaults, hardcoded geometry, semantic
//  color tokens) as an `ElementSpec`, and the plain-JVM `ElementParityTest` diffs each spec
//  against the cross-platform truth fixture `OpenSource/Conformance/elements/<tag>.json`
//  (extracted line-by-line from the Swift reference renderer — see the corpus README).
//
//  ── ADDING A NEW ELEMENT? READ THIS (yes, you — the agent/dev landing a new tag) ────────
//  1. Your element MUST register an ElementSpec or `ElementParityTest` FAILS the build the
//     moment its fixture leaves the elements-gaps.json allowlist — and your spec MUST have a
//     fixture or the test fails immediately ("spec without fixture"). Fixture first.
//  2. Declare the spec in the `registerBuiltins()` block below (keep it alphabetical) —
//     registration must live HERE, not in your element's file: the JVM test only class-loads
//     this object, so a spec registered from an @Composable file init would be invisible.
//     (Module `android/` facets registering tags via ComposeStackComponents are outside
//     :render's test classpath — their tags ride the gaps file's `module` list instead.)
//  3. Single-source your constants: put the numbers/tokens your composable hardcodes into
//     `ElementDefaults` and reference them from BOTH the spec and the implementation, so the
//     spec can never drift from the code it describes.
//  4. Declare ONLY the cross-platform contract: attribute defaults the fixture pins, geometry
//     the Swift builder (or the native control it wraps) hardcodes, semantic color TOKENS
//     (StackStyle.color vocabulary — never resolved ARGB). Internal Android-only chrome
//     (e.g. the slider's own track/thumb metrics where iOS renders a native UISlider) stays
//     OUT of the spec — a spec key the fixture doesn't know is a test failure by design.
//  5. Enforcement matrix (ElementParityTest.kt): both declare a key -> values must match
//     (FAIL on drift) · spec-only key -> FAIL · fixture-only key -> reported coverage gap ·
//     header-pinned divergence -> `partial` entry in elements-gaps.json (reported, not failed).
//

package despia.engine.render

import despia.engine.AdaptiveShell
import despia.engine.InkCore
import despia.engine.SplitPlan

/// One element's declared parity constants. `attributes` maps attribute name -> default
/// (canonical string form: numbers unpadded, booleans "true"/"false", null = no default);
/// `geometry` maps constant name -> the number the builder hardcodes (dp/sp/fractions);
/// `colors` maps role -> semantic token (StackStyle.color grammar).
class ElementSpec(
    val tag: String,
    val aliases: List<String> = emptyList(),
    val attributes: Map<String, String?> = emptyMap(),
    val geometry: Map<String, Double> = emptyMap(),
    val colors: Map<String, String> = emptyMap(),
)

/// The single source for every constant the :render element implementations hardcode —
/// referenced by BOTH the composables (StackNodeView.kt / StackInputViews.kt) and the
/// ElementSpec registrations below, so spec and implementation cannot drift apart.
/// Values mirror the Swift reference (fixture `_src` lines cite the exact origin).
internal object ElementDefaults {
    // vstack / hstack — SwiftUI system spacing ~= 8pt, pinned to 8dp (StackNodeView header).
    const val STACK_SPACING = 8.0
    // <stack> — web-true: unset gap = 0 (StackContainerElement.swift:32).
    const val GENERIC_STACK_GAP = 0.0
    // System-defaults base pass (system-defaults.md): the no-author-value defaults ride
    // the semantic tokens (theme roles via StackStyle.color), never pinned white/hex —
    // fixtures updated in the same wave (the corpus README's migration order).
    const val TEXT_COLOR = "label"                    // Text.swift color default — system-defaults base pass
    const val IMAGE_ICON_SIZE = 24.0                  // Image.swift:21
    const val IMAGE_COLOR = "label"                   // Image.swift color default — system-defaults base pass
    const val BUTTON_ICON_SIZE = 20.0                 // Button.swift:33 (icon-only)
    // The pressed snap of StackButtonStyle (Stack.swift ~4497): 0.92 on easeOut 0.12 s.
    // Legacy (authored) path only — an unstyled button renders the real M3 control, whose
    // platform state layer IS the twin (system-defaults.md); see StackNodeView.kt.
    const val BUTTON_PRESS_SCALE = 0.92
    const val PRESSABLE_LONG_PRESS_SECONDS = 0.4      // Pressable.swift:57 (onLongPressGesture minimumDuration)
    const val BUTTON_COLOR = "white"                  // Button.swift:19 — the LEGACY (ejected) path's label default; the system path computes its own M3 role colors (StackButtons.kt), so the base-pass `accent` here only leaked accent onto pre-law legacy buttons — reverted
    const val DIVIDER_THICKNESS = 1.0                 // hairline (native SwiftUI Divider)
    const val DIVIDER_COLOR = "separator"             // Divider.swift:10
    const val LIST_SPACING = 0.0                      // List.swift:43
    const val GRID_COLUMNS = 3                        // Grid.swift:14
    const val GRID_SPACING = 10.0                     // Grid.swift:15
    const val TABS_TINT = "accent"                    // Tabs.swift:35
    const val TABS_ITEM_ICON_SIZE = 24.0              // M3 navigation bar/rail item icon (dp)
    const val TOGGLE_WIDTH = 51.0                     // UISwitch metric (Toggle.swift:16 renders the native control)
    const val TOGGLE_HEIGHT = 31.0
    const val TOGGLE_THUMB = 27.0
    const val TOGGLE_THUMB_INSET = 2.0
    const val TOGGLE_TINT = "accent"                  // Toggle.swift:18
    // (TOGGLE_OFF_TRACK_ALPHA retired — the off-track rides the semantic `fill` since the
    // system-defaults base pass; the native UISwitch it approximates is adaptive.)
    const val TEXTFIELD_COLOR = "label"               // TextField.swift color default — system-defaults base pass
    const val TEXTFIELD_PLACEHOLDER_ALPHA = 0.3f      // Android chrome (iOS native prompt styling)
    const val SLIDER_MIN = 0.0                        // Slider.swift:13
    const val SLIDER_MAX = 1.0                        // Slider.swift:13
    const val SLIDER_TINT = "accent"                  // Slider.swift:16
    const val SLIDER_HEIGHT = 28.0                    // Android chrome (iOS: native UISlider)
    const val SLIDER_TRACK = 4.0
    const val SLIDER_THUMB = 20.0
    const val SLIDER_TRACK_ALPHA = 0.2f
    const val PROGRESS_HEIGHT = 6.0                   // Progress.swift:23
    const val PROGRESS_TINT = "accent"                // Progress.swift:15
    const val PROGRESS_TRACK_OPACITY = 0.2            // Progress.swift:19 (tint.opacity(0.2))
    const val SPINNER_SIZE = 20.0                     // UIActivityIndicator medium ~= 20pt
    const val SPINNER_TINT = "secondary"              // SpinnerElement.swift tint default — the system spinner gray (system-defaults)
    const val SPINNER_STROKE = 2.0                    // Android chrome (drawn arc)
    const val SPINNER_SWEEP = 270f
    const val SPINNER_PERIOD_MS = 900

    // ── the STRUCTURE/OVERLAY wave (elements/Sheets|Dialogs|Menus|Lightbox|Containers|
    //    Forms|Displays.kt — each family header cites the Swift line) ──
    const val ACCORDION_HEADER_SPACING = 8.0          // Accordion.swift:63
    const val ACCORDION_CHEVRON_OPEN = 90.0           // Accordion.swift:68
    const val ACCORDION_TINT = "accent"               // Accordion.swift:67
    const val CAROUSEL_PEEK = 0.0                     // Carousel.swift:33
    const val CAROUSEL_SPACING = 12.0                 // Carousel.swift:34
    const val CAROUSEL_TINT = "accent"                // Carousel.swift:31
    const val CHAT_MAX_WIDTH = 280.0                  // ChatBubble.swift:34
    const val CHAT_PADDING_H = 14.0                   // ChatBubble.swift:58
    const val CHAT_PADDING_V = 10.0                   // ChatBubble.swift:59
    const val CHAT_RADIUS = 20.0                      // ChatBubble.swift:70-74 (shape rung `sheet`)
    const val CHAT_TAIL_RADIUS = 4.0                  // ChatBubble.swift:71-72
    const val CHAT_LEFT = "#2C2C2E"                   // ChatBubble.swift:33
    const val CHAT_RIGHT = "accent"                   // ChatBubble.swift:33
    const val DRAWER_HANDLE_W = 36.0                  // Drawer.swift:34
    const val DRAWER_HANDLE_H = 5.0                   // Drawer.swift:34
    const val DRAWER_HANDLE_PAD_V = 8.0               // Drawer.swift:35
    const val DRAWER_CONTENT_SPACING = 12.0           // Drawer.swift:36
    const val DRAWER_CONTENT_PAD_H = 20.0             // Drawer.swift:37
    const val DRAWER_CONTENT_PAD_B = 12.0             // Drawer.swift:38
    const val DRAWER_RADIUS = 20.0                    // Drawer.swift:42 (shape rung `sheet`)
    const val DRAWER_DISMISS = 120.0                  // Drawer.swift:48
    const val DRAWER_HANDLE = "fill"                  // Drawer.swift (the semantic grabber slot — was white 25%; W12 red sweep)
    const val DRAWER_PANEL = "secondaryBackground"    // Drawer.swift (the elevated-surface slot — was Color(white: 0.11); W12 red sweep)
    const val FIELD_STACK_SPACING = 4.0               // Field.swift:55
    const val FIELD_ERROR = "destructive"             // Field.swift:153 — system-defaults base pass phase 3: rides the semantic token (theme-less resolves the same #FF453A — byte-identical)
    const val FIELD_LABEL = "secondary"               // Field.swift:60 (.footnote)
    const val FIELD_COLOR = "label"                   // Field.swift color default — system-defaults base pass
    const val FLOW_SPACING = 8.0                      // Flow.swift:25
    const val FLOW_LINE_SPACING = 8.0                 // Flow.swift:26
    const val FORM_SPACING = 12.0                     // Form.swift:39
    const val FORM_INVALID_OPACITY = 0.5              // Form.swift:43
    const val SCAFFOLD_SIDEBAR_LABEL = "Sidebar"
    const val SCAFFOLD_CONTENT_LABEL = "Content"
    const val SCAFFOLD_INSPECTOR_LABEL = "Inspector"
    const val LIGHTBOX_TINT = "white"                 // Lightbox.swift:41
    const val LIGHTBOX_SRC_FIELD = "src"              // Lightbox.swift:33
    const val RING_SIZE = 88.0                        // ProgressRing.swift:36
    const val RING_LINE = 10.0                        // ProgressRing.swift:33
    const val RING_TINT = "accent"                    // ProgressRing.swift:34
    const val RING_TRACK = "#2C2C2E"                  // ProgressRing.swift:35
    const val SEARCHBAR_SPACING = 6.0                 // SearchBar.swift:38
    const val SEARCHBAR_PAD_H = 12.0                  // SearchBar.swift:59
    const val SEARCHBAR_PAD_V = 8.0                   // SearchBar.swift:60
    const val SEARCHBAR_TINT = "accent"               // SearchBar.swift:36
    const val SHEET_CARD_INSET = 14.0                 // Sheet.swift:79
    const val SHEET_DETENTS = "half,full"             // Sheet.swift:43-44
    // <Signature> — the PAD's own chrome. The ink law it draws with is not here: it lives
    // ONCE, in :core InkCore (the `<ink>` primitive both Compose renderers, the TS kernel and
    // the Swift twin share), and the two ink numbers below are aliases of it so the spec and
    // the element cannot drift from the primitive.
    const val SIGNATURE_HEIGHT = 180.0                                // Signature.swift:120
    const val SIGNATURE_RADIUS = 12.0                                 // Signature.swift:121
    const val SIGNATURE_BORDER = 1.0                                  // Signature.swift:181
    const val SIGNATURE_BASELINE_INSET = 24.0                         // Signature.swift:133
    const val SIGNATURE_BASELINE_BOTTOM = 36.0                        // Signature.swift:132
    const val SIGNATURE_PLACEHOLDER_FONT = 15.0                       // Signature.swift:140
    const val SIGNATURE_INK = "label"                                 // Signature.swift:119
    const val SIGNATURE_RULE = "separator"                            // Signature.swift:126
    const val SIGNATURE_PLACEHOLDER = "secondary"                     // Signature.swift:141
    const val SIGNATURE_STROKE = InkCore.STROKE_WIDTH                 // the ink primitive's default
    const val SKELETON_HEIGHT = 14.0                  // Skeleton.swift:22
    const val SKELETON_RADIUS = 8.0                   // Skeleton.swift:23
    const val SKELETON_FILL_OPACITY = 0.08            // Skeleton.swift:35
    const val SKELETON_SHIMMER_OPACITY = 0.1          // Skeleton.swift:37
    const val SKELETON_SHIMMER_WIDTH = 0.6            // Skeleton.swift:39
    const val SKELETON_SHIMMER_DURATION = 1.1         // Skeleton.swift:47 (seconds, linear, repeatForever)
    const val TABLE_HEADER_FONT = 13.0                // Table.swift:34
    const val TABLE_ROW_FONT = 15.0                   // Table.swift:46
    const val TABLE_CELL_SPACING = 8.0                // Table.swift:31,43
    const val TABLE_HEADER_PAD_V = 8.0                // Table.swift:40
    const val TABLE_ROW_PAD_V = 9.0                   // Table.swift:52
    const val TABLE_TEXT = "label"                    // Table.swift:28
    const val TABLE_HEADER = "secondary"              // Table.swift:35
    const val TOOLBAR_SPACING = 12.0                  // Toolbar.swift:27
    const val TOOLBAR_PAD_H = 16.0                    // Toolbar.swift:30
    const val TOOLBAR_PAD_V = 10.0                    // Toolbar.swift:31
    const val TOOLBAR_HAIRLINE = 0.5                  // Toolbar.swift:37

    // ── the INPUT/DISPLAY wave (elements/Rating|Otp|RangeSlider|Choice|Stepper|Picker|
    //    Date|Image|Svg|Qr|ListElements.kt — each family header cites the Swift lines) ──
    const val STARS_COUNT = 5                         // Stars.swift:32 (clamped >= 1)
    const val STARS_SIZE = 24.0                       // Stars.swift:33
    const val STARS_TINT = "#FFCC00"                  // Stars.swift:34
    const val STARS_SPACING_FRACTION = 0.18           // Stars.swift:36 (HStack spacing = size * 0.18)
    const val STARS_EMPTY_OPACITY = 0.3               // Stars.swift:51 (tint.opacity(0.3) outline)
    const val OTP_LENGTH = 6                          // OTP.swift:30
    const val OTP_BOX = 48.0                          // OTP.swift:31
    const val OTP_BOX_SPACING = 8.0                   // OTP.swift:51
    const val OTP_RADIUS = 10.0                       // OTP.swift:55
    const val OTP_FONT_FRACTION = 0.42                // OTP.swift:59 (fontSize = boxSize * 0.42)
    const val OTP_IDLE_BORDER = 1.0                   // OTP.swift:57
    const val OTP_ACTIVE_BORDER = 2.0                 // OTP.swift:57
    const val OTP_IDLE_BORDER_COLOR = "separator"     // OTP.swift:56 — system-defaults base pass: rides the semantic separator (was Color.white.opacity(0.2) — invisible on light; OTP_IDLE_BORDER_OPACITY retired with it)
    const val OTP_TINT = "accent"                     // OTP.swift:32 (active-box highlight)
    const val OTP_DIGIT = "label"                     // OTP.swift digit default — system-defaults base pass
    const val RANGE_THUMB = 24.0                      // RangeSlider.swift:40
    const val RANGE_TRACK = 4.0                       // RangeSlider.swift:41
    const val RANGE_HEIGHT = 28.0                     // RangeSlider.swift:42
    const val RANGE_TRACK_OPACITY = 0.18              // RangeSlider.swift:66 (Color.primary.opacity(0.18))
    const val RANGE_TINT = "accent"                   // RangeSlider.swift:51
    const val SEG_FONT = 15.0                         // SegmentedButton.swift:72 (.medium)
    const val SEG_ICON_SPACING = 6.0                  // SegmentedButton.swift:66
    const val SEG_PAD_V = 9.0                         // SegmentedButton.swift:75
    const val SEG_RADIUS = 10.0                       // SegmentedButton.swift:82
    const val SEG_BORDER = 1.0                        // SegmentedButton.swift:85
    const val SEG_TINT = "accent"                     // SegmentedButton.swift:29,76 (selected fill)
    const val SEG_SELECTED_TEXT = "white"             // SegmentedButton.swift:73
    const val SEG_UNSELECTED_TEXT = "label"           // SegmentedButton.swift:73 (UIColor.label)
    const val SEG_BORDER_COLOR = "separator"          // SegmentedButton.swift:85
    const val STEPPER_MIN = 0.0                       // Stepper.swift:13
    const val STEPPER_MAX = 100.0                     // Stepper.swift:14
    const val STEPPER_STEP = 1.0                      // Stepper.swift:15
    const val STEPPER_TINT = "accent"                 // Stepper.swift:20
    const val CHECKBOX_SPACING = 8.0                  // Checkbox.swift:42
    const val CHECKBOX_CHECKED = "accent"             // Checkbox.swift:37,44
    const val CHECKBOX_UNCHECKED = "secondary"        // Checkbox.swift:44
    const val RADIO_ROW_SPACING = 12.0                // RadioGroup.swift:50
    const val RADIO_MARK_SPACING = 10.0               // RadioGroup.swift:56
    const val RADIO_SELECTED = "accent"               // RadioGroup.swift:49,58
    const val RADIO_UNSELECTED = "secondary"          // RadioGroup.swift:58
    const val WHEEL_TINT = "accent"                   // WheelPicker.swift:28
    const val COMBO_MAX_ROWS = 6                      // Combobox.swift:31
    const val COMBO_ROW_HEIGHT = 44.0                 // Combobox.swift (44 min row + card maxHeight = min(rows,6) * 44 — the W12 coarse-pointer floor)
    const val COMBO_ROW_PAD_H = 12.0                  // Combobox.swift:71
    const val COMBO_ROW_PAD_V = 10.0                  // Combobox.swift:72
    const val COMBO_RADIUS = 12.0                     // Combobox.swift:82
    const val COMBO_TINT = "accent"                   // Combobox.swift:38
    const val DATE_TINT = "accent"                    // DatePicker.swift:22
    const val CALENDAR_TINT = "accent"                // Calendar.swift:72
    const val QR_SIZE = 200.0                         // QRCode.swift:42 (width/height aliases)
    const val QR_QUIET_FRACTION = 0.06                // QRCode.swift:58 (padding = size * 0.06)
    const val QR_MODULES = "black"                    // QRCode.swift:44
    const val QR_BACKGROUND = "white"                 // QRCode.swift:45
    const val IMAGE_PLACEHOLDER_OPACITY = 0.06        // Image.swift:46 (Color.white.opacity(0.06))
}

object ElementSpecs {
    private val specs = LinkedHashMap<String, ElementSpec>()

    /// Idempotent (same tag replaces). Call ONLY from registerBuiltins() below — see header.
    fun register(spec: ElementSpec) { synchronized(specs) { specs[spec.tag] = spec } }
    fun spec(tag: String): ElementSpec? = synchronized(specs) { specs[tag] }
    fun all(): Map<String, ElementSpec> = synchronized(specs) { LinkedHashMap(specs) }

    init { registerBuiltins() }

    /// Every element the :render dispatch implements today (StackNodeView.kt raw() branches +
    /// StackInputViews.kt), one spec each, alphabetical. New elements append here (header rule 2).
    private fun registerBuiltins() {
        val d = ElementDefaults
        register(ElementSpec("button", aliases = listOf("glassButton", "transport"),
            attributes = mapOf("label" to null, "icon" to null,
                               "iconSize" to canon(d.BUTTON_ICON_SIZE), "color" to d.BUTTON_COLOR,
                               "variant" to null, "role" to null,   // the system-space words (system-defaults.md; StackButtons.kt)
                               "on:tap" to null,
                               "disabled" to "false"),
            geometry = mapOf("iconSize" to d.BUTTON_ICON_SIZE,
                             "pressScale" to d.BUTTON_PRESS_SCALE),
            colors = mapOf("content" to d.BUTTON_COLOR)))
        register(ElementSpec("divider",
            attributes = mapOf("color" to d.DIVIDER_COLOR),
            geometry = mapOf("thickness" to d.DIVIDER_THICKNESS),
            colors = mapOf("line" to d.DIVIDER_COLOR)))
        register(ElementSpec("grid",
            attributes = mapOf("bind" to null, "key" to "id",
                               "columns" to canon(d.GRID_COLUMNS.toDouble()),
                               "spacing" to canon(d.GRID_SPACING),
                               "scroll" to "true", "on:reachEnd" to null),
            geometry = mapOf("columns" to d.GRID_COLUMNS.toDouble(), "spacing" to d.GRID_SPACING)))
        register(ElementSpec("hstack",
            attributes = mapOf("spacing" to canon(d.STACK_SPACING), "align" to "center"),
            geometry = mapOf("spacing" to d.STACK_SPACING)))
        register(ElementSpec("image",
            attributes = mapOf("icon" to null, "systemImage" to null,
                               "iconSize" to canon(d.IMAGE_ICON_SIZE),
                               "fontSize" to canon(d.IMAGE_ICON_SIZE),
                               "color" to d.IMAGE_COLOR,
                               "asset" to null, "src" to null, "cache" to "default",
                               "a11yLabel" to null),   // absent = decorative (Image.swift:17; ImageElements.kt header)
            geometry = mapOf("iconSize" to d.IMAGE_ICON_SIZE,
                             "placeholderOpacity" to d.IMAGE_PLACEHOLDER_OPACITY),
            colors = mapOf("icon" to d.IMAGE_COLOR)))
        register(ElementSpec("list",
            attributes = mapOf("bind" to null, "key" to "id",
                               "spacing" to canon(d.LIST_SPACING),
                               "scroll" to "true", "on:reachEnd" to null,
                               "axis" to "vertical", "direction" to "vertical",
                               "autoscroll" to null,
                               // `align` = row cross-axis alignment (leading|center|trailing) —
                               // the List.swift flat-VStack `hAlign(align)` twin (BoundList).
                               "align" to "leading",
                               // the LIST CONSTRUCTS (elements/ListElements.kt ConstructList):
                               // sections, swipe row actions, drag reorder + its move report.
                               // The button-dict shape and the {from,to} payload are pinned in
                               // the fixture's notes — this map carries only the attr defaults.
                               "group_by" to null,
                               "swipeLeading" to null, "swipeTrailing" to null,
                               "swipeFullLeading" to "false", "swipeFullTrailing" to "false",
                               "reorder" to "false", "on:move" to null),
            geometry = mapOf("spacing" to d.LIST_SPACING)))
        register(ElementSpec("pager",
            attributes = mapOf("value" to null, "bind" to null,
                               "axis" to "horizontal", "on:change" to null)))
        register(ElementSpec("pressable", aliases = listOf("row"),
            attributes = mapOf("on:tap" to null, "on:doubleTap" to null,
                               "on:longPress" to null, "on:longPressEnd" to null,
                               "href" to null,
                               "disabled" to "false"),
            geometry = mapOf("longPressMinDuration" to d.PRESSABLE_LONG_PRESS_SECONDS)))
        register(ElementSpec("progress", aliases = listOf("capsuleProgress"),
            attributes = mapOf("bind" to null, "value" to "0",
                               "height" to canon(d.PROGRESS_HEIGHT), "color" to d.PROGRESS_TINT),
            geometry = mapOf("height" to d.PROGRESS_HEIGHT, "trackOpacity" to d.PROGRESS_TRACK_OPACITY),
            colors = mapOf("tint" to d.PROGRESS_TINT)))
        register(ElementSpec("scroll",
            attributes = mapOf("axis" to "vertical")))
        register(ElementSpec("slider",
            attributes = mapOf("bind" to null, "min" to canon(d.SLIDER_MIN),
                               "max" to canon(d.SLIDER_MAX), "color" to d.SLIDER_TINT,
                               "disabled" to "false"),
            colors = mapOf("tint" to d.SLIDER_TINT)))
        register(ElementSpec("spacer"))
        register(ElementSpec("spinner", aliases = listOf("activity"),
            attributes = mapOf("color" to d.SPINNER_TINT),
            geometry = mapOf("size" to d.SPINNER_SIZE),
            colors = mapOf("tint" to d.SPINNER_TINT)))
        register(ElementSpec("split",
            // the shared planner's defaults (:core SplitPlan — corpus Conformance/split/split.json);
            // the readable-inset geometry stays out of the spec (chrome metric, header rule 4:
            // iOS pins 20pt, the Compose pane rides M3's own 24dp expanded margin)
            attributes = mapOf("value" to null, "on:change" to null, "paneRole" to null,
                               "panes" to null,
                               "collapseAt" to canon(SplitPlan.DEFAULT_COLLAPSE_AT),
                               "expandAt" to canon(SplitPlan.DEFAULT_EXPAND_AT),
                               "resizable" to "true",
                               "sidebarMin" to canon(SplitPlan.DEFAULT_SIDEBAR.min),
                               "sidebarIdeal" to canon(SplitPlan.DEFAULT_SIDEBAR.ideal),
                               "sidebarMax" to canon(SplitPlan.DEFAULT_SIDEBAR.max),
                               "contentMin" to canon(SplitPlan.DEFAULT_CONTENT.min),
                               "contentIdeal" to canon(SplitPlan.DEFAULT_CONTENT.ideal),
                               "contentMax" to canon(SplitPlan.DEFAULT_CONTENT.max),
                               "detailMin" to canon(SplitPlan.DEFAULT_DETAIL_MIN))))
        register(ElementSpec("stack",
            attributes = mapOf("spacing" to canon(d.GENERIC_STACK_GAP),
                               "flexDirection" to "column", "align" to null),
            geometry = mapOf("spacing" to d.GENERIC_STACK_GAP)))
        register(ElementSpec("tabs", aliases = listOf("tabview"),
            attributes = mapOf("value" to null, "color" to d.TABS_TINT,   // value= = the two-way selected index (Tabs.swift:30); bind= stays a doc'd Android-only alias (StackNodeView.kt Tabs header), out of the spec
                               "tabTitle" to null, "on:change" to null),
            colors = mapOf("tint" to d.TABS_TINT)))
        register(ElementSpec("text", aliases = listOf("label"),
            attributes = mapOf("bind" to null, "value" to null,
                               "markdown" to "false",
                               "color" to d.TEXT_COLOR, "lineLimit" to null),
            colors = mapOf("content" to d.TEXT_COLOR)))
        register(ElementSpec("textfield", aliases = listOf("input"),
            attributes = mapOf("bind" to null, "secure" to "false", "placeholder" to null,
                               "color" to d.TEXTFIELD_COLOR, "keyboard" to null,
                               "on:change" to null, "on:submit" to null,
                               "on:focus" to null, "on:blur" to null,
                               "disabled" to "false"),
            colors = mapOf("text" to d.TEXTFIELD_COLOR)))
        register(ElementSpec("toggle", aliases = listOf("switch"),
            attributes = mapOf("bind" to null, "color" to d.TOGGLE_TINT,
                               "disabled" to "false"),
            geometry = mapOf("width" to d.TOGGLE_WIDTH, "height" to d.TOGGLE_HEIGHT,
                             "thumb" to d.TOGGLE_THUMB, "thumbInset" to d.TOGGLE_THUMB_INSET),
            colors = mapOf("tint" to d.TOGGLE_TINT)))
        register(ElementSpec("vstack",
            attributes = mapOf("spacing" to canon(d.STACK_SPACING), "align" to "leading"),
            geometry = mapOf("spacing" to d.STACK_SPACING)))
        register(ElementSpec("zstack",
            attributes = mapOf("align" to "center")))
        registerOverlayWave()
        registerInputWave()
        registerMediaWaveSpecs()   // the MEDIA wave: video · audio (ElementSpecMediaWave.kt)
        registerPlainWaveSpecs()   // textarea · picker · segmented · refreshable (ElementSpecPlainWave.kt)
    }

    /// The INPUT/DISPLAY wave (elements/ — Rating/Otp/RangeSlider/Choice/Stepper/Picker/
    /// Date/Svg/QrElements.kt), Capitalized then lowercase, alphabetical within each.
    /// Constants single-sourced from ElementDefaults; fixtures cite the Swift lines.
    private fun registerInputWave() {
        val d = ElementDefaults
        register(ElementSpec("Checkbox",   // Capitalized ONLY — the Android-only lowercase alias was dropped to match Checkbox.swift exactly
            attributes = mapOf("bind" to null, "label" to null, "color" to d.CHECKBOX_CHECKED,
                               "disabled" to "false"),
            geometry = mapOf("labelSpacing" to d.CHECKBOX_SPACING),
            colors = mapOf("checked" to d.CHECKBOX_CHECKED, "unchecked" to d.CHECKBOX_UNCHECKED)))
        register(ElementSpec("RadioGroup",
            attributes = mapOf("bind" to null, "options" to null, "optionsKey" to null,
                               "valueField" to "id", "labelField" to "label",
                               "color" to d.RADIO_SELECTED,
                               "disabled" to "false"),
            geometry = mapOf("rowSpacing" to d.RADIO_ROW_SPACING,
                             "markSpacing" to d.RADIO_MARK_SPACING),
            colors = mapOf("selectedMark" to d.RADIO_SELECTED, "unselectedMark" to d.RADIO_UNSELECTED)))
        register(ElementSpec("calendar",
            attributes = mapOf("bind" to null, "min" to null, "max" to null,
                               "color" to d.CALENDAR_TINT, "marks" to null,
                               "markDateField" to "date", "markColorField" to "color",
                               "on:month" to null,
                               "disabled" to "false"),
            colors = mapOf("tint" to d.CALENDAR_TINT)))
        register(ElementSpec("combobox",
            attributes = mapOf("bind" to null, "options" to null, "optionsKey" to null,
                               "valueField" to "id", "labelField" to "label",
                               "placeholder" to null, "color" to d.COMBO_TINT,
                               "on:select" to null,
                               "disabled" to "false"),
            geometry = mapOf("maxVisibleRows" to d.COMBO_MAX_ROWS.toDouble(),
                             "rowHeight" to d.COMBO_ROW_HEIGHT,
                             "rowPaddingH" to d.COMBO_ROW_PAD_H,
                             "rowPaddingV" to d.COMBO_ROW_PAD_V,
                             "cardCornerRadius" to d.COMBO_RADIUS),
            colors = mapOf("tint" to d.COMBO_TINT)))
        register(ElementSpec("datepicker", aliases = listOf("date"),
            attributes = mapOf("bind" to null, "mode" to "date",
                               "label" to null, "color" to d.DATE_TINT,
                               "disabled" to "false"),
            colors = mapOf("tint" to d.DATE_TINT)))
        register(ElementSpec("otp",
            attributes = mapOf("bind" to null, "length" to canon(d.OTP_LENGTH.toDouble()),
                               "boxSize" to canon(d.OTP_BOX), "color" to d.OTP_TINT,
                               "on:complete" to null,
                               "disabled" to "false"),
            geometry = mapOf("length" to d.OTP_LENGTH.toDouble(), "boxSize" to d.OTP_BOX,
                             "boxSpacing" to d.OTP_BOX_SPACING, "cornerRadius" to d.OTP_RADIUS,
                             "digitFontFraction" to d.OTP_FONT_FRACTION,
                             "idleBorderWidth" to d.OTP_IDLE_BORDER,
                             "activeBorderWidth" to d.OTP_ACTIVE_BORDER),
            colors = mapOf("activeBorder" to d.OTP_TINT, "digit" to d.OTP_DIGIT,
                           "idleBorder" to d.OTP_IDLE_BORDER_COLOR)))
        register(ElementSpec("qrcode",
            attributes = mapOf("value" to null, "size" to canon(d.QR_SIZE),
                               "color" to d.QR_MODULES, "background" to d.QR_BACKGROUND,
                               "correction" to "M"),
            geometry = mapOf("size" to d.QR_SIZE, "quietZoneFraction" to d.QR_QUIET_FRACTION),
            colors = mapOf("modules" to d.QR_MODULES, "background" to d.QR_BACKGROUND)))
        register(ElementSpec("rangeslider",
            attributes = mapOf("bindLow" to null, "bindHigh" to null,
                               "min" to canon(0.0), "max" to canon(1.0),
                               "step" to null, "color" to d.RANGE_TINT,
                               "disabled" to "false"),
            geometry = mapOf("thumb" to d.RANGE_THUMB, "track" to d.RANGE_TRACK,
                             "controlHeight" to d.RANGE_HEIGHT,
                             "trackOpacity" to d.RANGE_TRACK_OPACITY),
            colors = mapOf("tint" to d.RANGE_TINT)))
        register(ElementSpec("segmentedButton",
            attributes = mapOf("bind" to null, "options" to null, "icons" to null,
                               "multiple" to "true", "color" to d.SEG_TINT,
                               "disabled" to "false"),
            geometry = mapOf("fontSize" to d.SEG_FONT, "iconSpacing" to d.SEG_ICON_SPACING,
                             "paddingV" to d.SEG_PAD_V, "cornerRadius" to d.SEG_RADIUS,
                             "borderWidth" to d.SEG_BORDER),
            colors = mapOf("selectedFill" to d.SEG_TINT, "selectedText" to d.SEG_SELECTED_TEXT,
                           "unselectedText" to d.SEG_UNSELECTED_TEXT, "border" to d.SEG_BORDER_COLOR)))
        register(ElementSpec("stars",
            attributes = mapOf("bind" to null, "count" to canon(d.STARS_COUNT.toDouble()),
                               "size" to canon(d.STARS_SIZE), "color" to d.STARS_TINT,
                               "readonly" to "false",
                               "disabled" to "false"),
            geometry = mapOf("count" to d.STARS_COUNT.toDouble(), "size" to d.STARS_SIZE,
                             "spacingFraction" to d.STARS_SPACING_FRACTION,
                             "emptyOpacity" to d.STARS_EMPTY_OPACITY),
            colors = mapOf("fill" to d.STARS_TINT)))
        register(ElementSpec("stepper",
            attributes = mapOf("bind" to null, "min" to canon(d.STEPPER_MIN),
                               "max" to canon(d.STEPPER_MAX), "step" to canon(d.STEPPER_STEP),
                               "label" to null, "color" to d.STEPPER_TINT,
                               "disabled" to "false"),
            colors = mapOf("tint" to d.STEPPER_TINT)))
        register(ElementSpec("svg",
            attributes = mapOf("asset" to null, "src" to null, "d" to null,
                               "width" to null, "height" to null,
                               "viewBox" to null, "fill" to null)))
        register(ElementSpec("wheelpicker",
            attributes = mapOf("bind" to null, "options" to null, "optionsKey" to null,
                               "valueField" to "id", "labelField" to "label",
                               "label" to null, "color" to d.WHEEL_TINT,
                               "disabled" to "false"),
            colors = mapOf("tint" to d.WHEEL_TINT)))
    }

    /// The STRUCTURE/OVERLAY wave (elements/ — Sheets/Dialogs/Menus/Lightbox/Containers/
    /// Forms/Displays.kt), alphabetical within the block. Constants single-sourced from
    /// ElementDefaults; fixtures cite the Swift lines.
    private fun registerOverlayWave() {
        val d = ElementDefaults
        register(ElementSpec("Accordion",
            attributes = mapOf("title" to null, "open" to "false",
                               "color" to d.ACCORDION_TINT, "on:toggle" to null),
            geometry = mapOf("headerSpacing" to d.ACCORDION_HEADER_SPACING,
                             "chevronOpenRotation" to d.ACCORDION_CHEVRON_OPEN),
            colors = mapOf("chevron" to d.ACCORDION_TINT)))
        register(ElementSpec("ChatBubble",
            attributes = mapOf("side" to "left",
                               "color" to "${d.CHAT_LEFT} left / ${d.CHAT_RIGHT} right",   // the fixture's side-split default
                               "maxWidth" to canon(d.CHAT_MAX_WIDTH)),
            geometry = mapOf("maxWidth" to d.CHAT_MAX_WIDTH, "paddingH" to d.CHAT_PADDING_H,
                             "paddingV" to d.CHAT_PADDING_V, "radius" to d.CHAT_RADIUS,
                             "tailRadius" to d.CHAT_TAIL_RADIUS),
            colors = mapOf("leftBubble" to d.CHAT_LEFT, "rightBubble" to d.CHAT_RIGHT)))
        register(ElementSpec("Drawer",
            attributes = mapOf("on:close" to null),
            geometry = mapOf("handleWidth" to d.DRAWER_HANDLE_W, "handleHeight" to d.DRAWER_HANDLE_H,
                             "handlePaddingV" to d.DRAWER_HANDLE_PAD_V,
                             "contentSpacing" to d.DRAWER_CONTENT_SPACING, "contentPaddingH" to d.DRAWER_CONTENT_PAD_H,
                             "contentPaddingB" to d.DRAWER_CONTENT_PAD_B, "cornerRadius" to d.DRAWER_RADIUS,
                             "dismissThreshold" to d.DRAWER_DISMISS),
            colors = mapOf("panel" to d.DRAWER_PANEL, "handle" to d.DRAWER_HANDLE)))
        register(ElementSpec("ProgressRing",
            attributes = mapOf("value" to "0", "max" to "1", "lineWidth" to canon(d.RING_LINE),
                               "color" to d.RING_TINT, "trackColor" to d.RING_TRACK,
                               "size" to canon(d.RING_SIZE), "label" to null),
            geometry = mapOf("size" to d.RING_SIZE, "lineWidth" to d.RING_LINE),
            colors = mapOf("arc" to d.RING_TINT, "track" to d.RING_TRACK)))
        register(ElementSpec("Signature",
            attributes = mapOf("bind" to null, "strokeWidth" to canon(d.SIGNATURE_STROKE),
                               "color" to d.SIGNATURE_INK, "height" to canon(d.SIGNATURE_HEIGHT),
                               "radius" to canon(d.SIGNATURE_RADIUS), "baseline" to "true",
                               "placeholder" to null, "readOnly" to "false",
                               "on:begin" to null, "on:end" to null, "on:change" to null),
            geometry = mapOf("height" to d.SIGNATURE_HEIGHT, "radius" to d.SIGNATURE_RADIUS,
                             "strokeWidth" to d.SIGNATURE_STROKE, "borderWidth" to d.SIGNATURE_BORDER,
                             "baselineInset" to d.SIGNATURE_BASELINE_INSET,
                             "baselineBottom" to d.SIGNATURE_BASELINE_BOTTOM,
                             "placeholderFontSize" to d.SIGNATURE_PLACEHOLDER_FONT),
            colors = mapOf("ink" to d.SIGNATURE_INK, "border" to d.SIGNATURE_RULE,
                           "baseline" to d.SIGNATURE_RULE, "placeholder" to d.SIGNATURE_PLACEHOLDER)))
        register(ElementSpec("Skeleton",
            attributes = mapOf("height" to canon(d.SKELETON_HEIGHT), "radius" to canon(d.SKELETON_RADIUS)),
            geometry = mapOf("height" to d.SKELETON_HEIGHT, "radius" to d.SKELETON_RADIUS,
                             "fillOpacity" to d.SKELETON_FILL_OPACITY,
                             "shimmerOpacity" to d.SKELETON_SHIMMER_OPACITY,
                             "shimmerWidthFraction" to d.SKELETON_SHIMMER_WIDTH,
                             "shimmerDuration" to d.SKELETON_SHIMMER_DURATION)))
        register(ElementSpec("Table",
            attributes = mapOf("bind" to null, "columns" to null, "fields" to null,
                               "color" to d.TABLE_TEXT),
            geometry = mapOf("headerFontSize" to d.TABLE_HEADER_FONT, "rowFontSize" to d.TABLE_ROW_FONT,
                             "cellSpacing" to d.TABLE_CELL_SPACING, "headerPaddingV" to d.TABLE_HEADER_PAD_V,
                             "rowPaddingV" to d.TABLE_ROW_PAD_V),
            colors = mapOf("text" to d.TABLE_TEXT, "header" to d.TABLE_HEADER)))
        register(ElementSpec("alert",
            attributes = mapOf("present" to null, "title" to null, "message" to null,
                               "buttons" to null, "on:dismiss" to null)))
        register(ElementSpec("canvas",
            attributes = mapOf("opaque" to "false", "scale" to "device", "commands" to null,
                               "a11yLabel" to null, "a11yChildren" to null,
                               "on:draw" to null, "on:frame" to null, "on:layout" to null,
                               "on:strokeStart" to null, "on:strokeEnd" to null)))
        register(ElementSpec("carousel",
            attributes = mapOf("value" to null, "dots" to "true", "peek" to canon(d.CAROUSEL_PEEK),
                               "spacing" to canon(d.CAROUSEL_SPACING), "color" to d.CAROUSEL_TINT,
                               "on:change" to null),
            geometry = mapOf("peek" to d.CAROUSEL_PEEK, "spacing" to d.CAROUSEL_SPACING),
            colors = mapOf("tint" to d.CAROUSEL_TINT)))
        register(ElementSpec("confirmDialog",
            attributes = mapOf("present" to null, "title" to null, "message" to null,
                               "buttons" to null, "on:dismiss" to null)))
        register(ElementSpec("contextmenu",
            attributes = mapOf("menu" to null)))
        register(ElementSpec("field",
            attributes = mapOf("name" to null, "form" to "form (inherited from enclosing <form as=>)",
                               "type" to "text", "label" to null, "placeholder" to null,
                               "validate" to null, "pattern" to null, "message" to null,
                               "secure" to "false", "color" to d.FIELD_COLOR,
                               "disabled" to "false"),
            geometry = mapOf("stackSpacing" to d.FIELD_STACK_SPACING),
            colors = mapOf("error" to d.FIELD_ERROR, "label" to d.FIELD_LABEL)))
        register(ElementSpec("flow",
            attributes = mapOf("spacing" to canon(d.FLOW_SPACING), "lineSpacing" to canon(d.FLOW_LINE_SPACING),
                               "bind" to null, "key" to "id"),
            geometry = mapOf("spacing" to d.FLOW_SPACING, "lineSpacing" to d.FLOW_LINE_SPACING)))
        register(ElementSpec("form",
            attributes = mapOf("as" to "form", "spacing" to canon(d.FORM_SPACING), "submit" to null,
                               "scroll" to "false", "on:submit" to null),
            geometry = mapOf("spacing" to d.FORM_SPACING, "invalidSubmitOpacity" to d.FORM_INVALID_OPACITY)))
        register(ElementSpec("lightbox",
            attributes = mapOf("present" to null, "images" to null, "srcField" to d.LIGHTBOX_SRC_FIELD,
                               "urls" to null, "index" to null, "color" to d.LIGHTBOX_TINT)))
        register(ElementSpec("menu",
            attributes = mapOf("menu" to null)))
        register(ElementSpec("popover",
            attributes = mapOf("present" to null, "arrow" to "top", "on:dismiss" to null)))
        register(ElementSpec("scaffold",
            attributes = mapOf(
                "pin" to null,
                "pane" to "content for an unpinned child without pane",
                "shell" to AdaptiveShell.DEFAULT_MODE,
                "collapse" to AdaptiveShell.DEFAULT_COLLAPSE,
                "compactAt" to canon(AdaptiveShell.DEFAULT_COMPACT_AT),
                "sidebarMin" to canon(AdaptiveShell.DEFAULT_SIDEBAR.min),
                "sidebarIdeal" to canon(AdaptiveShell.DEFAULT_SIDEBAR.ideal),
                "sidebarMax" to canon(AdaptiveShell.DEFAULT_SIDEBAR.max),
                "inspectorMin" to canon(AdaptiveShell.DEFAULT_INSPECTOR.min),
                "inspectorIdeal" to canon(AdaptiveShell.DEFAULT_INSPECTOR.ideal),
                "inspectorMax" to canon(AdaptiveShell.DEFAULT_INSPECTOR.max),
                "sidebarLabel" to d.SCAFFOLD_SIDEBAR_LABEL,
                "contentLabel" to d.SCAFFOLD_CONTENT_LABEL,
                "inspectorLabel" to d.SCAFFOLD_INSPECTOR_LABEL,
            )))
        register(ElementSpec("searchbar",
            attributes = mapOf("bind" to null, "placeholder" to "Search", "color" to d.SEARCHBAR_TINT,
                               "on:submit" to null, "on:clear" to null,
                               "disabled" to "false"),
            geometry = mapOf("contentSpacing" to d.SEARCHBAR_SPACING, "paddingH" to d.SEARCHBAR_PAD_H,
                             "paddingV" to d.SEARCHBAR_PAD_V),
            colors = mapOf("tint" to d.SEARCHBAR_TINT,
                           "chrome" to "secondarySystemFill")))   // the iOS chrome slot; Android rides the engine `fill` token (themed: surfaceContainerHighest; theme-less now the systemFill dark pin — one step up since the fill-fallback align)
        register(ElementSpec("sheet",
            attributes = mapOf("present" to null, "mode" to "sheet", "detents" to d.SHEET_DETENTS,
                               "inset" to canon(d.SHEET_CARD_INSET), "background" to "background",
                               "title" to null, "close" to "leading", "action" to null,
                               "actionIcon" to null, "actionSide" to "trailing", "on:dismiss" to null),
            geometry = mapOf("cardInset" to d.SHEET_CARD_INSET)))
        register(ElementSpec("toolbar",
            attributes = mapOf("position" to "bottom", "spacing" to canon(d.TOOLBAR_SPACING)),
            geometry = mapOf("spacing" to d.TOOLBAR_SPACING, "paddingH" to d.TOOLBAR_PAD_H,
                             "paddingV" to d.TOOLBAR_PAD_V, "hairlineThickness" to d.TOOLBAR_HAIRLINE)))
    }

    /// Canonical string form for a numeric default ("8", not "8.0") — the fixture diff
    /// normalizes both sides through the same rule (ElementParityTest.canon).
    fun canon(v: Double): String =
        if (v == Math.floor(v) && !v.isInfinite()) v.toLong().toString() else v.toString()
}
