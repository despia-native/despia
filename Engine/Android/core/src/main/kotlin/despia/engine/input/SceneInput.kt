//
//  SceneInput.kt - G4 UNIFIED INPUT, the Kotlin twin of
//  OpenSource/Web/packages/kernel/src/input.ts (dsx-game.md §2 G4), corpus
//  OpenSource/Conformance/input/{mappings,axis,attenuation}.json.
//
//  ONE head declaration — `<input as="jump" keys="Space ArrowUp" gamepad="A" touch="tap"/>` —
//  bound to keyboard, gamepad and touch on every target. This file owns the two halves that
//  MUST be identical across the three runtimes:
//
//    1 · RESOLUTION — declaration attributes → one `InputBinding`, every unknown word
//        dropped behind exactly ONE Article-7 diagnostic.
//    2 · THE FOLD — raw device events → per-name pressed/axis values + press-edge events.
//
//  Everything platform-shaped stays OUTSIDE (the render lane binds real KeyEvent /
//  MotionEvent / InputDevice SOURCE_GAMEPAD traffic and pushes it in here). Keeping the
//  DECISION separate from the PLUMBING is what lets one corpus judge three runtimes.
//
//  The law in full: OpenSource/Conformance/input/README.md ("The G4 laws — unified input").
//
package despia.engine.input

import kotlin.math.abs
import kotlin.math.sqrt

/** Analog stick deadzone when a declaration does not name one. */
const val INPUT_DEFAULT_DEADZONE: Double = 0.15

/** Largest deadzone a declaration may ask for; beyond it the stick would be unusable. */
const val INPUT_MAX_DEADZONE: Double = 0.9

/** One resolved binding — the record every runtime folds device events against. */
data class InputBinding(
    val name: String,
    val axis: Boolean,
    val deadzone: Double,
    /** button mode: any-of. axis mode: exactly 0 or 4, positional [up, left, down, right]. */
    val keys: List<String>,
    /** gamepad button words. axis mode: exactly 0 or 4, positional. */
    val buttons: List<String>,
    /** gamepad stick words (axis mode only). */
    val sticks: List<String>,
    /** touch gesture words (button mode only). */
    val touch: List<String>,
)

/** One Article-7 diagnostic; `word` names the offending token when the defect is one word. */
data class InputDiagnostic(val code: String, val name: String, val word: String? = null)

data class InputResolution(val bindings: List<InputBinding>, val diagnostics: List<InputDiagnostic>)

/** A gamepad snapshot as every platform can produce it (button values, axis values). */
data class InputPadSnapshot(val buttons: List<Double>, val axes: List<Double>)

/** A press-edge event; the payload a `on:input.<name>` handler receives. */
data class InputEvent(val name: String, val x: Double, val y: Double)

/** One frame's fold: live values (Boolean for a button, Pair(x, y) for an axis) + edges. */
data class InputCommit(val values: Map<String, Any>, val events: List<InputEvent>)

/** The positional-audio fold's result. */
data class AudioAttenuation(val distance: Double, val gain: Double, val pan: Double)

object SceneInput {

    /** Canonical gamepad button words → the W3C standard-mapping button index. */
    val PAD_BUTTONS: Map<String, Int> = linkedMapOf(
        "A" to 0, "B" to 1, "X" to 2, "Y" to 3, "L" to 4, "R" to 5, "L2" to 6, "R2" to 7,
        "Select" to 8, "Start" to 9, "LStick" to 10, "RStick" to 11,
        "DPadUp" to 12, "DPadDown" to 13, "DPadLeft" to 14, "DPadRight" to 15,
    )

    /** Canonical stick words → their (x, y) indices in the standard-mapping axes array. */
    val PAD_STICKS: Map<String, Pair<Int, Int>> = mapOf(
        "leftStick" to (0 to 1), "rightStick" to (2 to 3),
    )

    /** Shorthand key SETS. The order is POSITIONAL and load-bearing: [up, left, down, right]. */
    val KEY_SETS: Map<String, List<String>> = mapOf(
        "wasd" to listOf("W", "A", "S", "D"),
        "arrows" to listOf("ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"),
        "zqsd" to listOf("Z", "Q", "S", "D"),
        "ijkl" to listOf("I", "J", "K", "L"),
    )

    /** Touch gesture words (authored lowercase → canonical). */
    val TOUCH_WORDS: Map<String, String> = mapOf(
        "tap" to "tap", "hold" to "hold",
        "swipeleft" to "swipeLeft", "swiperight" to "swipeRight",
        "swipeup" to "swipeUp", "swipedown" to "swipeDown",
    )

    /** The momentary touch words — pressed for exactly the frame they arrive in. */
    val MOMENTARY_TOUCH: List<String> = listOf("tap", "swipeLeft", "swipeRight", "swipeUp", "swipeDown")

    private val KEY_ALIASES: Map<String, String> = mapOf(
        "space" to "Space",
        "arrowup" to "ArrowUp", "up" to "ArrowUp",
        "arrowdown" to "ArrowDown", "down" to "ArrowDown",
        "arrowleft" to "ArrowLeft", "left" to "ArrowLeft",
        "arrowright" to "ArrowRight", "right" to "ArrowRight",
        "enter" to "Enter", "return" to "Enter",
        "escape" to "Escape", "esc" to "Escape",
        "tab" to "Tab", "shift" to "Shift",
        "control" to "Control", "ctrl" to "Control",
        "alt" to "Alt", "option" to "Alt",
        "meta" to "Meta", "cmd" to "Meta", "command" to "Meta",
        "backspace" to "Backspace",
    )

    private val PAD_ALIASES: Map<String, String> = mapOf(
        "a" to "A", "b" to "B", "x" to "X", "y" to "Y",
        "l" to "L", "l1" to "L", "lb" to "L", "r" to "R", "r1" to "R", "rb" to "R",
        "l2" to "L2", "lt" to "L2", "r2" to "R2", "rt" to "R2",
        "select" to "Select", "back" to "Select", "start" to "Start",
        "lstick" to "LStick", "l3" to "LStick", "rstick" to "RStick", "r3" to "RStick",
        "dpadup" to "DPadUp", "dpaddown" to "DPadDown", "dpadleft" to "DPadLeft", "dpadright" to "DPadRight",
    )

    private val IDENTIFIER = Regex("^[A-Za-z_][A-Za-z0-9_]{0,63}$")

    /** One authored key word → its canonical key(s), or null when it is not vocabulary. */
    fun canonicalKeys(word: String): List<String>? {
        val low = word.lowercase()
        KEY_SETS[low]?.let { return it.toList() }
        KEY_ALIASES[low]?.let { return listOf(it) }
        if (word.length == 1) {
            val c = word[0]
            if (c in 'A'..'Z' || c in 'a'..'z') return listOf(word.uppercase())
            if (c in '0'..'9') return listOf(word)
        }
        return null
    }

    private fun words(raw: String?): List<String> =
        (raw ?: "").split(Regex("\\s+")).filter { it.isNotEmpty() }

    /**
     * Declarations → bindings. Pure and total: a malformed word never throws and never takes
     * the rest of the binding with it — it drops behind ONE diagnostic (Article 7).
     */
    fun resolveDeclarations(decls: List<Map<String, String?>>): InputResolution {
        val bindings = mutableListOf<InputBinding>()
        val diagnostics = mutableListOf<InputDiagnostic>()
        val seen = mutableSetOf<String>()
        for (d in decls) {
            val name = (d["as"] ?: "").trim()
            if (name.isEmpty() || !IDENTIFIER.matches(name)) {
                diagnostics.add(InputDiagnostic("input-as", name))
                continue
            }
            if (!seen.add(name)) {
                diagnostics.add(InputDiagnostic("input-duplicate", name))
                continue
            }

            val rawAxis = d["axis"] ?: ""
            var axis = false
            if (rawAxis.isNotEmpty()) {
                when (rawAxis) {
                    "true" -> axis = true
                    "false" -> Unit
                    else -> diagnostics.add(InputDiagnostic("input-axis", name, rawAxis))
                }
            }

            var deadzone = INPUT_DEFAULT_DEADZONE
            val rawDz = (d["deadzone"] ?: "").trim()
            if (rawDz.isNotEmpty()) {
                val v = rawDz.toDoubleOrNull()
                if (v == null || !v.isFinite() || v < 0.0 || v > INPUT_MAX_DEADZONE) {
                    diagnostics.add(InputDiagnostic("input-deadzone", name, rawDz))
                } else {
                    deadzone = v
                }
            }

            val keys = mutableListOf<String>()
            for (w in words(d["keys"])) {
                val got = canonicalKeys(w)
                if (got == null) { diagnostics.add(InputDiagnostic("input-key", name, w)); continue }
                for (k in got) if (k !in keys) keys.add(k)
            }

            val buttons = mutableListOf<String>()
            val sticks = mutableListOf<String>()
            for (w in words(d["gamepad"])) {
                val low = w.lowercase()
                if (low == "leftstick" || low == "rightstick") {
                    val stick = if (low == "leftstick") "leftStick" else "rightStick"
                    if (stick !in sticks) sticks.add(stick)
                    continue
                }
                val button = PAD_ALIASES[low]
                if (button != null) {
                    if (button !in buttons) buttons.add(button)
                    continue
                }
                diagnostics.add(InputDiagnostic("input-gamepad", name, w))
            }

            val touch = mutableListOf<String>()
            for (w in words(d["touch"])) {
                val canonical = TOUCH_WORDS[w.lowercase()]
                if (canonical == null) { diagnostics.add(InputDiagnostic("input-touch", name, w)); continue }
                if (canonical !in touch) touch.add(canonical)
            }

            // Mode constraints — an axis reads its legs POSITIONALLY, so a wrong count is not
            // a usable axis and drops loudly rather than half-working.
            var axisKeys: List<String> = keys
            var axisButtons: List<String> = buttons
            var axisSticks: List<String> = sticks
            var axisTouch: List<String> = touch
            if (axis) {
                if (axisKeys.isNotEmpty() && axisKeys.size != 4) {
                    diagnostics.add(InputDiagnostic("input-axis-keys", name)); axisKeys = emptyList()
                }
                if (axisButtons.isNotEmpty() && axisButtons.size != 4) {
                    diagnostics.add(InputDiagnostic("input-axis-buttons", name)); axisButtons = emptyList()
                }
                if (axisTouch.isNotEmpty()) {
                    diagnostics.add(InputDiagnostic("input-touch-axis", name)); axisTouch = emptyList()
                }
            } else if (axisSticks.isNotEmpty()) {
                diagnostics.add(InputDiagnostic("input-stick-button", name)); axisSticks = emptyList()
            }

            bindings.add(InputBinding(name, axis, deadzone, axisKeys, axisButtons, axisSticks, axisTouch))
        }
        return InputResolution(bindings, diagnostics)
    }

    /** The DIGITAL fold: four booleans → a vector, +x right / +y up, diagonals normalized. */
    fun digitalAxis(up: Boolean, left: Boolean, down: Boolean, right: Boolean): Pair<Double, Double> {
        var x = (if (right) 1.0 else 0.0) - (if (left) 1.0 else 0.0)
        var y = (if (up) 1.0 else 0.0) - (if (down) 1.0 else 0.0)
        // sqrt-of-squares, never hypot — the physics precedent: IEEE doubles must agree
        // across runtimes, and hypot()'s intermediate scaling is implementation-defined.
        val len = sqrt(x * x + y * y)
        if (len > 1.0) { x /= len; y /= len }
        return x to y
    }

    /**
     * The ANALOG fold: a raw stick pair → a vector. Raw Y is DOWN-positive on every platform,
     * so it is negated here and the +y-up convention holds everywhere. The deadzone applies
     * RADIALLY and then rescales, so the live range stays a full 0..1 and the magnitude never
     * exceeds 1 (an overshooting stick clamps to the unit circle).
     */
    fun analogAxis(rawX: Double, rawY: Double, deadzone: Double): Pair<Double, Double> {
        val x = rawX
        val y = -rawY
        val len = sqrt(x * x + y * y)
        if (len <= deadzone) return 0.0 to 0.0
        val clamped = if (len > 1.0) 1.0 else len
        val scale = ((clamped - deadzone) / (1.0 - deadzone)) / len
        return (x * scale) to (y * scale)
    }

    /**
     * The positional-audio FOLD (corpus attenuation.json). Pure math: no platform audio API
     * is touched here, and none is touched by this rung at all — playing the folded numbers
     * back through a real 3D mixer is the named absence in the G4 landing record.
     */
    fun audioAttenuation(
        listener: DoubleArray,
        source: DoubleArray,
        ref: Double = 1.0,
        max: Double = 50.0,
        rolloff: Double = 1.0,
    ): AudioAttenuation {
        val dx = source[0] - listener[0]
        val dy = source[1] - listener[1]
        val dz = source[2] - listener[2]
        val distance = sqrt(dx * dx + dy * dy + dz * dz)
        val clamped = if (distance < ref) ref else if (distance > max) max else distance
        val gain = ref / (ref + rolloff * (clamped - ref))
        val raw = if (distance == 0.0) 0.0 else dx / distance
        val pan = if (raw < -1.0) -1.0 else if (raw > 1.0) 1.0 else raw
        return AudioAttenuation(distance, gain, pan)
    }
}

/**
 * The fold, as a small mutable machine. Every platform pushes raw events in and calls
 * `commit()` once per frame; the machine owns the edge law and the momentary-touch pulse.
 */
class InputMachine(bindings: List<InputBinding>) {
    var bindings: List<InputBinding> = bindings
        private set
    private val down = mutableSetOf<String>()
    private var pad: InputPadSnapshot? = null
    private var pulse = mutableSetOf<String>()
    private val held = mutableSetOf<String>()
    private val prev = mutableMapOf<String, Boolean>()

    init { for (b in bindings) prev[b.name] = false }

    /** Replace the whole binding table (a re-declared surface), keeping no stale edges. */
    fun reset(next: List<InputBinding>) {
        bindings = next
        prev.clear()
        for (b in next) prev[b.name] = false
    }

    fun keyDown(key: String) { down.add(key) }
    fun keyUp(key: String) { down.remove(key) }
    /** Every held key released — the window-blur / app-background case. */
    fun releaseKeys() { down.clear() }
    fun gamepad(snapshot: InputPadSnapshot?) { pad = snapshot }
    /** A touch gesture arrived. `hold` becomes sustained; everything else is a one-frame pulse. */
    fun touch(word: String) { if (word == "hold") held.add(word) else pulse.add(word) }
    fun touchRelease(word: String) { held.remove(word) }

    private fun padButton(word: String): Boolean {
        val snapshot = pad ?: return false
        val index = SceneInput.PAD_BUTTONS[word] ?: return false
        if (index >= snapshot.buttons.size) return false
        return snapshot.buttons[index] > 0.0
    }

    /** Fold one frame: live values + the press-edge events, then clear the momentary pulse. */
    fun commit(): InputCommit {
        val values = LinkedHashMap<String, Any>()
        val events = mutableListOf<InputEvent>()
        for (b in bindings) {
            val pressed: Boolean
            val persistentPressed: Boolean
            var x = 0.0
            var y = 0.0
            if (b.axis) {
                var vec: Pair<Double, Double>? = null
                val snapshot = pad
                if (snapshot != null) {
                    for (stick in b.sticks) {
                        val idx = SceneInput.PAD_STICKS[stick] ?: continue
                        val rx = if (idx.first < snapshot.axes.size) snapshot.axes[idx.first] else 0.0
                        val ry = if (idx.second < snapshot.axes.size) snapshot.axes[idx.second] else 0.0
                        val candidate = SceneInput.analogAxis(rx, ry, b.deadzone)
                        if (candidate.first != 0.0 || candidate.second != 0.0) { vec = candidate; break }
                    }
                }
                if (vec == null) {
                    val k = if (b.keys.size == 4) b.keys else null
                    val p = if (b.buttons.size == 4) b.buttons else null
                    fun dir(i: Int): Boolean =
                        (k != null && down.contains(k[i])) || (p != null && padButton(p[i]))
                    vec = SceneInput.digitalAxis(dir(0), dir(1), dir(2), dir(3))
                }
                x = vec.first
                y = vec.second
                values[b.name] = x to y
                pressed = x != 0.0 || y != 0.0
                persistentPressed = pressed
            } else {
                val keyOrPad = b.keys.any { down.contains(it) } || b.buttons.any { padButton(it) }
                val heldTouch = b.touch.any { held.contains(it) }
                val momentaryTouch = b.touch.any { pulse.contains(it) }
                persistentPressed = keyOrPad || heldTouch
                pressed = persistentPressed || momentaryTouch
                values[b.name] = pressed
            }
            if (pressed && prev[b.name] != true) events.add(InputEvent(b.name, x, y))
            // A momentary touch exists for this commit only. Rearm it immediately while
            // retaining genuinely held key/pad/hold state; contact hosts commit on edges.
            prev[b.name] = persistentPressed
        }
        pulse = mutableSetOf()
        return InputCommit(values, events)
    }
}

/** Android key-event plumbing helper: the platform key label → the canonical kernel word,
 *  or null when the key is outside the vocabulary. The render lane calls this with
 *  `KeyEvent.keyCodeToString(...)`-derived labels; keeping the table here means the render
 *  lane never re-invents the vocabulary. */
fun androidKeyToCanonical(keyCode: Int, unicodeChar: Char?): String? {
    // The numeric constants are the platform's, spelled out rather than imported so :core
    // stays SDK-free (the whole module runs on a bare JVM in CI).
    return when (keyCode) {
        62 -> "Space"          // KEYCODE_SPACE
        19 -> "ArrowUp"        // KEYCODE_DPAD_UP
        20 -> "ArrowDown"      // KEYCODE_DPAD_DOWN
        21 -> "ArrowLeft"      // KEYCODE_DPAD_LEFT
        22 -> "ArrowRight"     // KEYCODE_DPAD_RIGHT
        66 -> "Enter"          // KEYCODE_ENTER
        111 -> "Escape"        // KEYCODE_ESCAPE
        61 -> "Tab"            // KEYCODE_TAB
        59, 60 -> "Shift"      // KEYCODE_SHIFT_LEFT / RIGHT
        113, 114 -> "Control"  // KEYCODE_CTRL_LEFT / RIGHT
        57, 58 -> "Alt"        // KEYCODE_ALT_LEFT / RIGHT
        117, 118 -> "Meta"     // KEYCODE_META_LEFT / RIGHT
        67 -> "Backspace"      // KEYCODE_DEL
        in 29..54 -> ('A' + (keyCode - 29)).toString()   // KEYCODE_A … KEYCODE_Z
        in 7..16 -> ('0' + (keyCode - 7)).toString()     // KEYCODE_0 … KEYCODE_9
        else -> unicodeChar?.let { c ->
            when {
                c in 'a'..'z' || c in 'A'..'Z' -> c.uppercaseChar().toString()
                c in '0'..'9' -> c.toString()
                else -> null
            }
        }
    }
}

/** Android gamepad plumbing helper: the platform button keycode → the canonical word. */
fun androidPadButtonToCanonical(keyCode: Int): String? = when (keyCode) {
    96 -> "A"; 97 -> "B"; 99 -> "X"; 100 -> "Y"          // BUTTON_A/B/X/Y
    102 -> "L"; 103 -> "R"; 104 -> "L2"; 105 -> "R2"     // BUTTON_L1/R1/L2/R2
    109 -> "Select"; 108 -> "Start"                      // BUTTON_SELECT / BUTTON_START
    106 -> "LStick"; 107 -> "RStick"                     // BUTTON_THUMBL / THUMBR
    19 -> "DPadUp"; 20 -> "DPadDown"; 21 -> "DPadLeft"; 22 -> "DPadRight"
    else -> null
}

/** Pointer-gesture recognition thresholds, shared by the Compose and desktop lanes so the
 *  touch words mean the same thing on both (the web recognizer uses the same numbers). */
object InputGestureLimits {
    const val TAP_MAX_MS = 250L
    const val TAP_MAX_PX = 10.0
    const val HOLD_MS = 350L
    const val SWIPE_MIN_PX = 32.0
    const val SWIPE_MAX_MS = 600L

    /** Classify a completed pointer stroke into a touch word, or null when it is neither. */
    fun classify(dx: Double, dy: Double, dtMs: Long): String? {
        val adx = abs(dx)
        val ady = abs(dy)
        if (dtMs <= TAP_MAX_MS && adx <= TAP_MAX_PX && ady <= TAP_MAX_PX) return "tap"
        if (dtMs <= SWIPE_MAX_MS && (adx >= SWIPE_MIN_PX || ady >= SWIPE_MIN_PX)) {
            return if (adx >= ady) { if (dx > 0) "swipeRight" else "swipeLeft" }
            else { if (dy > 0) "swipeDown" else "swipeUp" }
        }
        return null
    }
}
