//
//  RiveCore.kt - the shared `<rive>` core (:core, pure JVM): the state-machine input plane,
//  artboard/machine/animation selection, the fit and alignment fold, the playback and
//  residency lifecycle, the event payloads and the accessibility verdict. The law is the
//  corpus, OpenSource/Conformance/rive/ (parity/U12-rive.md). The twin of the web
//  @despia/kernel rive-core.ts and of Swift RiveCore.
//
//  WHY A SHARED CORE WHEN THE RENDERER IS ONE VENDOR LIBRARY. Rive's own runtime draws the
//  same picture on all three platforms, so pixels are the one thing that cannot diverge and
//  the one thing pinned nowhere. What CAN diverge is everything around the vendor library:
//  which artboard a missing name resolves to, whether a trigger fires twice on a re-render,
//  whether an offscreen animation keeps advancing, what a state change looks like when it
//  reaches an author's handler. Those live here, as data folds with no vendor type in sight -
//  this file names no Rive symbol and the :core module gains no dependency. The RUNTIME is a
//  ClosedSource module (Core/Rive, MIT, vendored and pinned there).
//
package despia.engine

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

// -- numbers -----------------------------------------------------------------------------

/** the canonical text of a number, used as the input plane's change token. Six decimals, no
 *  negative zero, integers without a point - the same spelling CanvasCore uses, for the same
 *  reason: three languages must agree on when a value "changed". */
fun riveNumberText(value: Double): String {
    if (!value.isFinite()) return "0"
    val rounded = Math.round(value * 1e6) / 1e6
    if (rounded == 0.0) return "0"
    val whole = rounded.toLong()
    if (rounded == whole.toDouble()) return whole.toString()
    return java.math.BigDecimal.valueOf(rounded).stripTrailingZeros().toPlainString()
}

private fun riveRound6(value: Double): Double = Math.round(value * 1e6) / 1e6

/** the ONE numeric grammar all three renderers accept in a bound input: an optional sign,
 *  decimal digits, an optional exponent. Deliberately narrower than either language's own
 *  parser - JS `Number()` reads `0x10` and Kotlin's `toDouble()` reads `1d`, and a value that
 *  means 16 on the web and nothing here is the exact drift this corpus exists to stop. */
private val RIVE_NUMBER_GRAMMAR = Regex("^[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?$")

private fun riveParseNumber(text: String): Double? {
    val trimmed = text.trim()
    if (!RIVE_NUMBER_GRAMMAR.matches(trimmed)) return null
    val value = trimmed.toDoubleOrNull() ?: return null
    return if (value.isFinite()) value else null
}

// -- the state-machine input plane ---------------------------------------------------------

class RiveDeclaredInput(val name: String, val type: String)

/** `value` is the level to write; null for a trigger, which is an edge and carries none. */
class RiveInputOp(val name: String, val kind: String, val value: Any?)

class RiveInputRefusal(val name: String, val code: String, val message: String)

class RiveInputPlan(
    val ops: List<RiveInputOp>,
    val refusals: List<RiveInputRefusal>,
    /** the token map to feed the NEXT fold: this is the trigger edge detector */
    val values: Map<String, String>,
)

/** the tokens a trigger reads as "not fired yet" */
private val RIVE_FALSY_TOKENS = setOf("", "false", "0")

private fun riveBooleanToken(raw: Any?): Boolean? = when (raw) {
    is Boolean -> raw
    is Number -> if (raw.toDouble().isFinite()) raw.toDouble() != 0.0 else null
    is String -> {
        val low = raw.trim().lowercase()
        when (low) {
            "true" -> true
            "false" -> false
            else -> riveParseNumber(low)?.let { it != 0.0 }
        }
    }
    else -> null
}

private fun riveNumberValue(raw: Any?): Double? = when (raw) {
    is Boolean -> null   // `count: true` is a shape mistake, not a 1
    is Number -> if (raw.toDouble().isFinite()) raw.toDouble() else null
    is String -> riveParseNumber(raw)
    else -> null
}

private fun riveTriggerToken(raw: Any?): String = when (raw) {
    is Boolean -> if (raw) "true" else "false"
    is Number -> riveNumberText(raw.toDouble())
    else -> raw.toString().trim()
}

/**
 * Turn a bound `inputs` object into the smallest set of writes the machine needs.
 *
 * The DECLARED list is authority (an undeclared key is refused, never guessed at), LEVELS are
 * diffed against `previous` so an unchanged re-render writes nothing, and a TRIGGER is an
 * EDGE: it fires when its token changes to a truthy one. That last rule is the whole reason
 * `inputs` can be declarative - `{ celebrate: order.justPlaced }` fires once per order rather
 * than once per frame, with no imperative call anywhere.
 *
 * A refusal never aborts the plan: one bad binding must not freeze an animation.
 */
fun riveInputPlan(
    declared: List<RiveDeclaredInput>,
    bound: Map<String, Any?>,
    previous: Map<String, String>,
): RiveInputPlan {
    val ops = ArrayList<RiveInputOp>()
    val refusals = ArrayList<RiveInputRefusal>()
    val values = LinkedHashMap(previous)
    val seen = HashSet<String>()

    for (input in declared) {
        val name = input.name
        seen.add(name)
        if (!bound.containsKey(name)) continue
        val raw = bound[name] ?: continue          // an unresolved binding is not an error
        val prev = previous[name]

        when (input.type) {
            "boolean" -> {
                val flag = riveBooleanToken(raw)
                if (flag == null) {
                    refusals.add(RiveInputRefusal(name, "input_type", "input '$name' expects a boolean"))
                } else {
                    val token = if (flag) "true" else "false"
                    if (token != prev) {
                        ops.add(RiveInputOp(name, "boolean", flag))
                        values[name] = token
                    }
                }
            }
            "number" -> {
                val value = riveNumberValue(raw)
                if (value == null) {
                    refusals.add(RiveInputRefusal(name, "input_type", "input '$name' expects a number"))
                } else {
                    val token = riveNumberText(value)
                    if (token != prev) {
                        ops.add(RiveInputOp(name, "number", riveRound6(value)))
                        values[name] = token
                    }
                }
            }
            "trigger" -> {
                val token = riveTriggerToken(raw)
                if (token != prev && !RIVE_FALSY_TOKENS.contains(token.lowercase())) {
                    ops.add(RiveInputOp(name, "trigger", null))
                }
                values[name] = token               // the falling edge is recorded too
            }
            else -> refusals.add(
                RiveInputRefusal(name, "input_type", "input '$name' has an unknown input type"),
            )
        }
    }

    for (name in bound.keys.filter { !seen.contains(it) }.sorted()) {
        refusals.add(
            RiveInputRefusal(name, "unknown_input", "the state machine declares no input named '$name'"),
        )
    }

    return RiveInputPlan(ops, refusals, values)
}

// -- artboard / machine / animation selection ----------------------------------------------

class RiveArtboard(
    val name: String,
    val isDefault: Boolean = false,
    val stateMachines: List<String> = emptyList(),
    val animations: List<String> = emptyList(),
)

class RiveSelectionError(val code: String, val message: String)

class RiveSelection(
    val artboard: String?,
    val stateMachine: String?,
    val animation: String?,
    val mode: String,
    val error: RiveSelectionError?,
)

private fun riveAttrText(attrs: Map<String, Any?>, name: String): String =
    attrs[name]?.toString()?.trim() ?: ""

/** A refusal is TOTAL: nothing half-mounts a selection it was told to reject. */
private fun riveRefused(code: String, message: String): RiveSelection =
    RiveSelection(null, null, null, "idle", RiveSelectionError(code, message))

/**
 * Resolve which artboard, and which machine or animation inside it, this `<rive>` plays.
 *
 * Every miss is `not_found` NAMING what was asked for and where it was looked up, because a
 * mistyped artboard rendering a blank box is the single worst failure mode this component has
 * (plan §7). `stateMachine` and `animation` together is a conflict rather than a silent
 * precedence rule - the kind of rule an author never finds when it goes the other way.
 */
fun riveSelection(artboards: List<RiveArtboard>, attrs: Map<String, Any?>): RiveSelection {
    if (artboards.isEmpty()) return riveRefused("not_found", "this .riv file declares no artboard")

    val wantBoard = riveAttrText(attrs, "artboard")
    val wantMachine = riveAttrText(attrs, "stateMachine")
    val wantAnimation = riveAttrText(attrs, "animation")
    if (wantMachine.isNotEmpty() && wantAnimation.isNotEmpty()) {
        return riveRefused("conflict", "<rive> takes stateMachine or animation, not both")
    }

    val board: RiveArtboard = if (wantBoard.isNotEmpty()) {
        artboards.firstOrNull { it.name == wantBoard }
            ?: return riveRefused("not_found", "no artboard named '$wantBoard' in this .riv file")
    } else {
        artboards.firstOrNull { it.isDefault } ?: artboards[0]
    }

    if (wantAnimation.isNotEmpty()) {
        if (!board.animations.contains(wantAnimation)) {
            return riveRefused("not_found", "no animation named '$wantAnimation' on artboard '${board.name}'")
        }
        return RiveSelection(board.name, null, wantAnimation, "animation", null)
    }
    if (wantMachine.isNotEmpty()) {
        if (!board.stateMachines.contains(wantMachine)) {
            return riveRefused("not_found", "no state machine named '$wantMachine' on artboard '${board.name}'")
        }
        return RiveSelection(board.name, wantMachine, null, "machine", null)
    }
    if (board.stateMachines.isNotEmpty()) {
        return RiveSelection(board.name, board.stateMachines[0], null, "machine", null)
    }
    if (board.animations.isNotEmpty()) {
        return RiveSelection(board.name, null, board.animations[0], "animation", null)
    }
    // An artboard with neither is a static drawing. Legal, and not an error.
    return RiveSelection(board.name, null, null, "idle", null)
}

// -- fit and alignment ----------------------------------------------------------------------

val RIVE_FIT_WORDS: Map<String, String> = linkedMapOf(
    "cover" to "cover", "contain" to "contain", "fill" to "fill",
    "fitwidth" to "fitWidth", "fitheight" to "fitHeight", "none" to "none",
)

val RIVE_ALIGNMENT_WORDS: Map<String, String> = linkedMapOf(
    "center" to "center", "centre" to "center",
    "top" to "topCenter", "topcenter" to "topCenter", "topleft" to "topLeft", "topright" to "topRight",
    "bottom" to "bottomCenter", "bottomcenter" to "bottomCenter",
    "bottomleft" to "bottomLeft", "bottomright" to "bottomRight",
    "left" to "centerLeft", "centerleft" to "centerLeft",
    "right" to "centerRight", "centerright" to "centerRight",
)

private val RIVE_ALIGNMENT_FACTORS: Map<String, DoubleArray> = mapOf(
    "topLeft" to doubleArrayOf(0.0, 0.0),
    "topCenter" to doubleArrayOf(0.5, 0.0),
    "topRight" to doubleArrayOf(1.0, 0.0),
    "centerLeft" to doubleArrayOf(0.0, 0.5),
    "center" to doubleArrayOf(0.5, 0.5),
    "centerRight" to doubleArrayOf(1.0, 0.5),
    "bottomLeft" to doubleArrayOf(0.0, 1.0),
    "bottomCenter" to doubleArrayOf(0.5, 1.0),
    "bottomRight" to doubleArrayOf(1.0, 1.0),
)

class RivePlacement(
    val fit: String,
    val alignment: String,
    val scaleX: Double,
    val scaleY: Double,
    val x: Double,
    val y: Double,
    val diagnostics: List<String>,
)

/** lowercase, strip every separator, then look the word up: `Bottom-Right` is `bottomright`. */
private fun riveFoldWord(
    raw: Any?, table: Map<String, String>, fallback: String,
    diagnostics: MutableList<String>, kind: String,
): String {
    if (raw == null) return fallback
    val text = raw.toString().trim()
    val key = text.lowercase().filter { it in 'a'..'z' || it in '0'..'9' }
    if (key.isEmpty()) return fallback              // absent is not a diagnostic
    val word = table[key]
    if (word == null) {
        diagnostics.add("unknown $kind '$text'")
        return fallback
    }
    return word
}

/**
 * Place an artboard of `content` size inside a `box`. Scale is per-fit; placement is
 * `align * (box - content * scale)`, so the same nine factors serve all six fits.
 *
 * An unknown word FOLDS to the default and is diagnosed rather than refused: a typo in a
 * presentation attribute must not blank an animation, and must not be silent either. A
 * zero-sized artboard is diagnosed and placed at scale 1, because a NaN transform is an
 * invisible animation nobody can debug.
 */
fun riveFit(
    fit: Any?, alignment: Any?,
    contentWidth: Double, contentHeight: Double, boxWidth: Double, boxHeight: Double,
): RivePlacement {
    val diagnostics = ArrayList<String>()
    val fitWord = riveFoldWord(fit, RIVE_FIT_WORDS, "contain", diagnostics, "fit")
    val alignWord = riveFoldWord(alignment, RIVE_ALIGNMENT_WORDS, "center", diagnostics, "alignment")
    val factors = RIVE_ALIGNMENT_FACTORS[alignWord] ?: doubleArrayOf(0.5, 0.5)
    val ax = factors[0]
    val ay = factors[1]

    val sane = contentWidth.isFinite() && contentHeight.isFinite() &&
        boxWidth.isFinite() && boxHeight.isFinite() &&
        contentWidth > 0.0 && contentHeight > 0.0 && boxWidth >= 0.0 && boxHeight >= 0.0
    if (!sane) {
        diagnostics.add("the artboard has no intrinsic size")
        return RivePlacement(
            fitWord, alignWord, 1.0, 1.0,
            riveRound6(ax * max(if (boxWidth.isFinite()) boxWidth else 0.0, 0.0)),
            riveRound6(ay * max(if (boxHeight.isFinite()) boxHeight else 0.0, 0.0)),
            diagnostics,
        )
    }

    val scaleX: Double
    val scaleY: Double
    when (fitWord) {
        "cover" -> {
            val s = max(boxWidth / contentWidth, boxHeight / contentHeight); scaleX = s; scaleY = s
        }
        "fill" -> { scaleX = boxWidth / contentWidth; scaleY = boxHeight / contentHeight }
        "fitWidth" -> { val s = boxWidth / contentWidth; scaleX = s; scaleY = s }
        "fitHeight" -> { val s = boxHeight / contentHeight; scaleX = s; scaleY = s }
        "none" -> { scaleX = 1.0; scaleY = 1.0 }
        else -> {
            val s = min(boxWidth / contentWidth, boxHeight / contentHeight); scaleX = s; scaleY = s
        }
    }
    return RivePlacement(
        fitWord, alignWord, riveRound6(scaleX), riveRound6(scaleY),
        riveRound6(ax * (boxWidth - contentWidth * scaleX)),
        riveRound6(ay * (boxHeight - contentHeight * scaleY)),
        diagnostics,
    )
}

// -- playback lifecycle ---------------------------------------------------------------------

const val RIVE_FRAME_MIN_INTERVAL_MS = 1000.0 / 60.0

class RiveAdvance(val time: Double, val delta: Double, val frame: Int)

class RivePlaybackFold(
    val emitted: List<RiveAdvance>,
    val starts: Int,
    val pauses: Int,
    val instantiations: Int,
    val disposals: Int,
    val drops: Int,
    val advancing: Boolean,
    val live: Boolean,
)

/**
 * A Rive artboard is a live scene, not a decoded image: an offscreen one that keeps advancing
 * is a battery bug, and twenty of them retained in a list is a memory bug. The machine
 * advances only while it is LIVE (mounted), WANTED (autoplay or an explicit play), ON SCREEN,
 * and the app is FOREGROUND; a tick arriving otherwise is DROPPED, never queued, so `time` is
 * accumulated delta and excludes the offscreen interval.
 *
 * Unmount DISPOSES, and a remount is a fresh instance: the clock restarts at zero and the
 * wanted-state returns to `autoplay`, because an imperative play() belongs to the scene that
 * received it.
 */
class RivePlayback(private val autoplay: Boolean) {
    private var visible = true
    private var active = true
    private var wanted = autoplay
    private var liveFlag = false
    private var advancingFlag = false
    private var lastTick: Double? = null
    private var time = 0.0
    private var frame = 0

    var starts = 0
        private set
    var pauses = 0
        private set
    var instantiations = 0
        private set
    var disposals = 0
        private set
    var drops = 0
        private set

    val live: Boolean get() = liveFlag
    val advancing: Boolean get() = advancingFlag

    fun setMounted(value: Boolean) {
        if (value) {
            if (!liveFlag) { liveFlag = true; instantiations += 1 }
            settle()
            return
        }
        if (liveFlag) { liveFlag = false; disposals += 1 }
        settle()
        wanted = autoplay            // a fresh instance forgets the imperative state
        time = 0.0
        frame = 0
        lastTick = null
    }

    fun setVisible(value: Boolean) { visible = value; settle() }

    fun setActive(value: Boolean) { active = value; settle() }

    fun play() { wanted = true; settle() }

    fun pause() { wanted = false; settle() }

    private fun settle() {
        val want = liveFlag && wanted && visible && active
        if (want && !advancingFlag) {
            advancingFlag = true
            starts += 1
            lastTick = null
        } else if (!want && advancingFlag) {
            advancingFlag = false
            pauses += 1
        }
    }

    /** one raw platform tick (ms); the advance to apply, or null when dropped or coalesced */
    fun tick(nowMs: Double): RiveAdvance? {
        if (!advancingFlag) { drops += 1; return null }
        val last = lastTick
        if (last == null) {
            lastTick = nowMs
            val advance = RiveAdvance(riveRound6(time), 0.0, frame)
            frame += 1
            return advance
        }
        val gap = nowMs - last
        if (gap < RIVE_FRAME_MIN_INTERVAL_MS) { drops += 1; return null }
        lastTick = nowMs
        val delta = gap / 1000.0
        time += delta
        val advance = RiveAdvance(riveRound6(time), riveRound6(delta), frame)
        frame += 1
        return advance
    }
}

/** the pure fold the corpus pins: an autoplay flag plus a lifecycle/tick event list */
fun rivePlaybackSchedule(autoplay: Boolean, events: List<Map<String, Any?>>): RivePlaybackFold {
    val loop = RivePlayback(autoplay)
    val emitted = ArrayList<RiveAdvance>()
    for (event in events) {
        when (event["type"]?.toString()) {
            "mount" -> loop.setMounted(true)
            "unmount" -> loop.setMounted(false)
            "visible" -> loop.setVisible(event["value"] == true)
            "active" -> loop.setActive(event["value"] == true)
            "play" -> loop.play()
            "pause" -> loop.pause()
            "tick" -> loop.tick((event["at"] as? Number)?.toDouble() ?: 0.0)?.let { emitted.add(it) }
        }
    }
    return RivePlaybackFold(
        emitted, loop.starts, loop.pauses, loop.instantiations, loop.disposals, loop.drops,
        loop.advancing, loop.live,
    )
}

// -- residency: a list of animations, bounded -------------------------------------------------

class RiveResidencyFold(val live: List<String>, val instantiated: Int, val disposed: Int)

/**
 * At most `capacity` live artboards, most-recently-visible first. An offscreen row is DEMOTED
 * rather than disposed (it keeps its instance while there is room) and is evicted before any
 * visible one; eviction disposes, and a returning row is re-instantiated. That re-instantiation
 * is the price of the cap and the corpus counts it, because "bounded memory" is a number a
 * fixture can assert while an allocation is not.
 */
fun riveResidency(capacity: Double, events: List<Map<String, Any?>>): RiveResidencyFold {
    val cap = max(1.0, floor(if (capacity.isFinite()) capacity else 1.0)).toInt()
    val live = ArrayList<String>()
    var instantiated = 0
    var disposed = 0
    for (event in events) {
        val key = event["key"]?.toString() ?: continue
        val visible = event["visible"] == true
        val at = live.indexOf(key)
        if (!visible) {
            if (at >= 0) { live.removeAt(at); live.add(key) }
            continue
        }
        if (at >= 0) live.removeAt(at) else instantiated += 1
        live.add(0, key)
        while (live.size > cap) { live.removeAt(live.size - 1); disposed += 1 }
    }
    return RiveResidencyFold(live, instantiated, disposed)
}

// -- event payloads ---------------------------------------------------------------------------

class RiveStateChange(val machine: String, val state: String)

/** `on:stateChange` fires on a TRANSITION, never on an advance: a state that survives sixty
 *  frames is one emission, and returning to a previous state emits again. */
fun riveStateChanges(machine: String, states: List<Any?>): List<RiveStateChange> {
    val out = ArrayList<RiveStateChange>()
    var last: String? = null
    for (raw in states) {
        val name = raw?.toString()?.trim() ?: ""
        if (name.isEmpty() || name == last) continue
        last = name
        out.add(RiveStateChange(machine, name))
    }
    return out
}

class RiveEventPayload(val name: String, val properties: Map<String, Any?>)

class RiveEventFold(val payload: RiveEventPayload?, val dropped: Int)

/**
 * `on:event` is `{name, properties}`. Properties keep booleans, finite numbers and strings, in
 * sorted key order so three renderers agree; anything else is DROPPED and counted, because a
 * bus payload is data and a nested handle is not portable.
 *
 * A Rive `openUrl` event arrives here as ordinary properties (`url`, `target`) and NOTHING
 * NAVIGATES. The .riv file is an asset, and an asset that could open a URL by itself would be
 * a hole an OTA-delivered animation walks straight through.
 */
fun riveEventPayload(name: Any?, properties: Map<String, Any?>?): RiveEventFold {
    val trimmed = name?.toString()?.trim() ?: ""
    if (trimmed.isEmpty()) return RiveEventFold(null, 0)
    val out = LinkedHashMap<String, Any?>()
    var dropped = 0
    for (key in (properties ?: emptyMap()).keys.sorted()) {
        when (val value = properties?.get(key)) {
            is Boolean -> out[key] = value
            is String -> out[key] = value
            is Number -> if (value.toDouble().isFinite()) out[key] = riveRound6(value.toDouble()) else dropped += 1
            else -> dropped += 1
        }
    }
    return RiveEventFold(RiveEventPayload(trimmed, out), dropped)
}

class RiveLoadPayload(
    val artboard: String?,
    val stateMachine: String?,
    val animation: String?,
    val width: Double,
    val height: Double,
)

/** `on:load` carries the resolved selection plus the artboard's INTRINSIC size, which is what
 *  a caller needs to size a box around it. */
fun riveLoadPayload(selection: RiveSelection, width: Double, height: Double): RiveLoadPayload =
    RiveLoadPayload(
        selection.artboard, selection.stateMachine, selection.animation,
        riveRound6(if (width.isFinite()) width else 0.0),
        riveRound6(if (height.isFinite()) height else 0.0),
    )

val RIVE_ERROR_MESSAGES: Map<String, String> = linkedMapOf(
    "not_found" to "the artboard, state machine or animation this <rive> names is not in the file",
    "no_source" to "<rive> has no src",
    "decode_failed" to "this .riv file could not be decoded",
    "load_failed" to "the .riv file could not be loaded",
    "unsupported_platform" to "this platform ships no Rive runtime",
)

class RiveErrorPayload(val code: String, val message: String)

/** `on:error` over a closed code set; an unknown code keeps the code and takes the generic
 *  message rather than vanishing, and a blank code IS `load_failed`. */
fun riveErrorPayload(code: Any?): RiveErrorPayload {
    var resolved = code?.toString()?.trim() ?: ""
    if (resolved.isEmpty()) resolved = "load_failed"
    return RiveErrorPayload(resolved, RIVE_ERROR_MESSAGES[resolved] ?: "this <rive> could not be played")
}

// -- accessibility -----------------------------------------------------------------------------

/** the same ten gesture words `<canvas>` uses. `on:stateChange` and `on:event` are absent on
 *  purpose: an animation reporting what it did is not a control. */
val RIVE_GESTURE_HANDLERS: List<String> = listOf(
    "on:tap", "on:doubletap", "on:longpress", "on:drag", "on:pan",
    "on:pinch", "on:rotate", "on:swipe", "on:press", "on:adjust",
)

const val RIVE_A11Y_LINT_CODE = "rive-a11y-label"
const val RIVE_A11Y_LINT_MESSAGE =
    "<rive> with a gesture handler needs a11yLabel — an animation is opaque to assistive tech"

class RiveA11yChild(val role: String, val label: String, val value: String?)

class RiveA11yLint(val code: String, val level: String, val message: String)

class RiveA11yVerdict(
    val interactive: Boolean,
    val label: String?,
    val children: List<RiveA11yChild>,
    val role: String,
    val hidden: Boolean,
    val lint: RiveA11yLint?,
)

/**
 * The `<canvas>` verdict shape applied to an animation: same six fields, same three-surface
 * fold, one extra input. A Rive state machine can carry its OWN pointer listeners inside the
 * .riv file, so the component can be interactive with no `on:` handler in sight. That flips
 * `interactive` and the role but emits NO lint, because the linter reads markup and markup
 * cannot see inside an asset. Two verdicts, one fold, and the difference is stated rather than
 * fudged.
 */
fun riveA11y(
    attrs: Map<String, Any?>,
    a11yChildren: List<Map<String, Any?>>? = null,
    hasListeners: Boolean = false,
): RiveA11yVerdict {
    val handled = RIVE_GESTURE_HANDLERS.any { name ->
        val raw = attrs[name]
        raw != null && raw.toString().trim().isNotEmpty()
    }
    val interactive = handled || hasListeners
    val trimmed = attrs["a11yLabel"]?.toString()?.trim() ?: ""
    val label = if (trimmed.isEmpty()) null else trimmed
    val children = (a11yChildren ?: emptyList()).map {
        RiveA11yChild(
            it["role"]?.toString() ?: "image",
            it["label"]?.toString() ?: "",
            it["value"]?.toString(),
        )
    }
    val declared = label != null || children.isNotEmpty()
    val role = when {
        children.isNotEmpty() -> "group"
        interactive -> if (label != null) "button" else "group"
        else -> if (label != null) "image" else "none"
    }
    return RiveA11yVerdict(
        interactive = interactive,
        label = label,
        children = children,
        role = role,
        hidden = !interactive && !declared,
        lint = if (handled && !declared)
            RiveA11yLint(RIVE_A11Y_LINT_CODE, "error", RIVE_A11Y_LINT_MESSAGE) else null,
    )
}
