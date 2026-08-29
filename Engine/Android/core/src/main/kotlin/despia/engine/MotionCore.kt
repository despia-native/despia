package despia.engine

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sign

/**
 * MotionCore - the keyframe sampler: `@keyframes` plus an `animation` shorthand, folded to the
 * property values one frame should show. The Kotlin twin of `@despia/kernel motion-core.ts`,
 * judged by the same corpus (`OpenSource/Conformance/motion/keyframes.json`).
 *
 * WHY IT EXISTS (runtime-pressure R28). `@keyframes` and `animation` parse, lint, sit in the
 * DSX-CSS catalogue, and reach the generated native sheets VERBATIM - the IR in
 * DSXCSSStyles.generated.kt already carries every stop. Then [CssResolver] falls through on any
 * at-rule that is not `@media` and the declarations are inert. The catalogue promised the author
 * motion on every target and two targets silently disagreed, which left DSX with no way to
 * express a LOOP or a STAGGER off the web.
 *
 * WHAT IT DELIBERATELY IS NOT: a CSS animation engine. Only the COMPOSITOR properties both
 * native bridges can apply without a layout pass animate - `opacity` and the transform family -
 * and every other property in a keyframe is DROPPED and REPORTED rather than half-applied,
 * because an animated `width` that only moves on the web is the exact defect this ends.
 *
 * Sampling is a PURE function of elapsed milliseconds, never a state machine, which is what lets
 * a frame loop, a backgrounded app and a deterministic test all reduce to a different number.
 */
object MotionCore {

    /** `animation-iteration-count: infinite`, as a number three languages can put in JSON. */
    const val INFINITE = -1.0

    /** The only properties a keyframe may animate. Anything else is dropped and reported. */
    val PROPERTIES: List<String> = listOf("opacity", "transform")

    /**
     * The attribute keys [animationSpec] reads - the bridged spelling of all nine `animation-*`
     * properties in the DSX-CSS catalogue. A renderer keys its driving loop on exactly these, so
     * an author editing any one of them restarts the animation, which is what CSS does.
     */
    val ANIMATION_KEYS: List<String> = listOf(
        "animation", "animationName", "animationDuration", "animationDelay",
        "animationEasing", "animationIterations", "animationDirection",
        "animationFill", "animationPlayState",
    )

    data class Spec(
        val name: String,
        val duration: Double,      // milliseconds
        val delay: Double,         // milliseconds; negative starts part-way in
        val easing: String,
        val iterations: Double,    // or INFINITE
        val direction: String,     // normal | reverse | alternate | alternate-reverse
        val fill: String,          // none | forwards | backwards | both
        val paused: Boolean,       // animation-play-state: the driver holds elapsed still
        val none: Boolean,
    )

    data class Stop(val offset: Double, val declarations: Map<String, String>)

    data class Sample(
        val values: Map<String, String>,
        val dropped: List<String>,
        val active: Boolean,
    )

    private val NAMED_EASINGS: Map<String, List<Double>> = mapOf(
        "linear" to listOf(0.0, 0.0, 1.0, 1.0),
        "ease" to listOf(0.25, 0.1, 0.25, 1.0),
        "ease-in" to listOf(0.42, 0.0, 1.0, 1.0),
        "ease-out" to listOf(0.0, 0.0, 0.58, 1.0),
        "ease-in-out" to listOf(0.42, 0.0, 0.58, 1.0),
    )

    private val DIRECTIONS = setOf("normal", "reverse", "alternate", "alternate-reverse")
    private val FILLS = setOf("none", "forwards", "backwards", "both")

    /**
     * Parse an `animation` shorthand. CSS orders it loosely: the FIRST time is the duration and
     * the second is the delay, and every other word is identified by what it is. A word this
     * cannot classify becomes the name, which is why `animation: 2s spin` and `animation: spin
     * 2s` are the same declaration.
     */
    fun parseAnimation(shorthand: String): Spec {
        val text = shorthand.trim()
        val off = Spec("", 0.0, 0.0, "ease", 1.0, "normal", "none", false, true)
        if (text.isEmpty() || text == "none") return off

        var name = ""
        var duration = 0.0
        var delay = 0.0
        var easing = "ease"
        var iterations = 1.0
        var direction = "normal"
        var fill = "none"
        var paused = false
        var seenTime = 0

        for (word in splitTopLevel(text)) {
            val lower = word.lowercase()
            val time = parseTime(lower)
            if (time != null) {
                if (seenTime == 0) duration = time else if (seenTime == 1) delay = time
                seenTime += 1
                continue
            }
            if (lower == "infinite") { iterations = INFINITE; continue }
            if (NAMED_EASINGS.containsKey(lower) || lower.startsWith("cubic-bezier(") ||
                lower.startsWith("steps(")
            ) { easing = lower; continue }
            if (lower in DIRECTIONS) { direction = lower; continue }
            if (lower in FILLS && lower != "none") { fill = lower; continue }
            val count = lower.toDoubleOrNull()
            if (count != null && count >= 0.0 && !lower.endsWith("s")) { iterations = count; continue }
            if (lower == "running") { paused = false; continue }
            if (lower == "paused") { paused = true; continue }
            if (name.isEmpty()) name = word
        }
        if (name.isEmpty()) return off
        return Spec(name, duration, delay, easing, iterations, direction, fill, paused, false)
    }

    /**
     * The spec an element's resolved attributes describe: the `animation` shorthand, then every
     * longhand that overrides it. All nine `animation-*` properties sit in the DSX-CSS catalogue
     * as Tier B, so all nine have to mean something here or the catalogue is lying again - which
     * is the defect R28 exists to end, one layer down.
     *
     * A longhand ALONE is a complete declaration (`animation-name: spin; animation-duration:
     * 2s`), so a name arriving that way turns the OFF spec on. That is CSS: the shorthand is a
     * shorthand.
     */
    fun animationSpec(attrs: Map<String, String>): Spec {
        var spec = parseAnimation(attrs["animation"] ?: "")
        val name = attrs["animationName"]?.trim()
        if (name != null && name.isNotEmpty() && name != "none") {
            spec = spec.copy(name = name, none = false)
        }
        parseTime((attrs["animationDuration"] ?: "").trim().lowercase())
            ?.let { spec = spec.copy(duration = it) }
        parseTime((attrs["animationDelay"] ?: "").trim().lowercase())
            ?.let { spec = spec.copy(delay = it) }
        attrs["animationEasing"]?.trim()?.lowercase()
            ?.takeIf { it.isNotEmpty() }?.let { spec = spec.copy(easing = it) }
        val iterations = attrs["animationIterations"]?.trim()?.lowercase()
        if (iterations == "infinite") {
            spec = spec.copy(iterations = INFINITE)
        } else if (iterations != null && iterations.isNotEmpty()) {
            iterations.toDoubleOrNull()?.takeIf { it >= 0.0 }?.let { spec = spec.copy(iterations = it) }
        }
        attrs["animationDirection"]?.trim()?.lowercase()
            ?.takeIf { it in DIRECTIONS }?.let { spec = spec.copy(direction = it) }
        attrs["animationFill"]?.trim()?.lowercase()
            ?.takeIf { it in FILLS }?.let { spec = spec.copy(fill = it) }
        when (attrs["animationPlayState"]?.trim()?.lowercase()) {
            "paused" -> spec = spec.copy(paused = true)
            "running" -> spec = spec.copy(paused = false)
        }
        if (spec.name.isEmpty()) spec = spec.copy(none = true)
        return spec
    }

    /**
     * Normalize a `@keyframes` body into ordered stops. `from` is 0, `to` is 1, `40%` is 0.4,
     * and one rule may carry several. Later stops at the same offset win: that is the cascade
     * inside a keyframes block.
     */
    fun keyframeTimeline(rules: List<Pair<String, Map<String, String>>>): List<Stop> {
        val byOffset = LinkedHashMap<Double, MutableMap<String, String>>()
        for ((selector, declarations) in rules) {
            for (part in selector.split(",")) {
                val offset = parseOffset(part.trim()) ?: continue
                byOffset.getOrPut(offset) { LinkedHashMap() }.putAll(declarations)
            }
        }
        return byOffset.entries.map { Stop(it.key, it.value.toMap()) }.sortedBy { it.offset }
    }

    /**
     * The values at [elapsed] milliseconds since the animation was installed.
     *
     * A zero-duration animation shows its LAST stop and stops being active, which is what a
     * browser does and what keeps `animation: spin 0s` from dividing by zero. Before the delay
     * the element shows the first stop only under `backwards`/`both`, and after the last
     * iteration the last stop only under `forwards`/`both` - CSS's fill rules, because half of
     * them would make an element jump at the end.
     */
    fun sampleMotion(timeline: List<Stop>, spec: Spec, elapsed: Double): Sample {
        val dropped = droppedProperties(timeline)
        if (spec.none || timeline.isEmpty()) return Sample(emptyMap(), dropped, false)

        val infinite = spec.iterations == INFINITE
        val total = if (infinite) Double.POSITIVE_INFINITY else spec.duration * spec.iterations
        val since = elapsed - spec.delay

        if (since < 0) {
            val fills = spec.fill == "backwards" || spec.fill == "both"
            val values = if (fills) valuesAt(timeline, startFraction(spec)) else emptyMap()
            return Sample(values, dropped, true)
        }
        if (spec.duration <= 0.0 || (!infinite && since >= total)) {
            val fills = spec.fill == "forwards" || spec.fill == "both"
            val values = if (fills) valuesAt(timeline, endFraction(spec)) else emptyMap()
            return Sample(values, dropped, false)
        }

        val iteration = floor(since / spec.duration).toInt()
        val within = (since % spec.duration) / spec.duration
        val eased = ease(spec.easing, directed(within, iteration, spec.direction))
        return Sample(valuesAt(timeline, eased), dropped, true)
    }

    /** What a sampled frame becomes here, plus the transform functions that could not come. */
    data class Attributes(
        val attributes: Map<String, String>,
        val unsupported: List<String>,
    )

    /**
     * Turn a sampled frame into the style attributes the render ladder ALREADY applies.
     *
     * Compose has no `transform` attribute and is not getting one for this: StackStyle has
     * `opacity`, `rotation`, uniform `scale` and `offsetX`/`offsetY`, and those four are what
     * its graphicsLayer ladder is built out of. So the driver DECOMPOSES rather than adding a
     * parallel transform pipeline that would then disagree with the static `rotation=`/`scale=`
     * an author can already write on the same element.
     *
     * The decomposition is exact or it is refused. CSS composes transform functions as a matrix
     * chain, leftmost outermost, and the ladder is fixed at rotation -> scale -> offset (inner
     * to outer). A uniform scale and a rotation about the same centre commute, so their order is
     * free; a translate does not, so it must come first to mean the same thing. One occurrence
     * per family, `px` translations, angle units CSS knows. Anything else yields NO attributes
     * and is reported, for the same reason `dropped` exists.
     */
    fun motionAttributes(values: Map<String, String>): Attributes {
        val attributes = LinkedHashMap<String, String>()
        val unsupported = ArrayList<String>()
        values["opacity"]?.let { attributes["opacity"] = it }

        val transform = values["transform"] ?: return Attributes(attributes, unsupported)
        val functions = parseTransform(transform)
            ?: return Attributes(attributes, listOf(transform.trim()))

        var x = 0.0
        var y = 0.0
        var scale: Double? = null
        var rotation: Double? = null
        var translated = false
        var shaped = false
        var refused = false
        fun refuse(name: String) {
            refused = true
            if (name !in unsupported) unsupported.add(name)
        }

        for (fn in functions) {
            when (val name = fn.name.lowercase()) {
                "translate", "translatex", "translatey" -> {
                    // A translate after a scale or a rotation is a different matrix than the
                    // ladder builds, so it is refused rather than reordered.
                    if (translated || shaped) { refuse(fn.name); continue }
                    val lengths = fn.args.map { px(it) }
                    if (lengths.any { it == null }) { refuse(fn.name); continue }
                    when (name) {
                        "translatex" -> x = lengths.getOrNull(0) ?: 0.0
                        "translatey" -> y = lengths.getOrNull(0) ?: 0.0
                        else -> { x = lengths.getOrNull(0) ?: 0.0; y = lengths.getOrNull(1) ?: 0.0 }
                    }
                    translated = true
                }
                "scale" -> {
                    val a = fn.args.getOrNull(0)
                    val b = fn.args.getOrNull(1)
                    if (scale != null || a == null || a.unit != "" ||
                        (b != null && (b.unit != "" || b.n != a.n))
                    ) { refuse(fn.name); continue }
                    scale = a.n
                    shaped = true
                }
                "rotate", "rotatez" -> {
                    val degrees = if (fn.args.size == 1) deg(fn.args[0]) else null
                    if (rotation != null || degrees == null) { refuse(fn.name); continue }
                    rotation = degrees
                    shaped = true
                }
                else -> refuse(fn.name)
            }
        }
        if (refused) return Attributes(attributes, unsupported.sorted())

        if (translated) {
            attributes["offsetX"] = format(x)
            attributes["offsetY"] = format(y)
        }
        scale?.let { attributes["scale"] = format(it) }
        rotation?.let { attributes["rotation"] = format(it) }
        return Attributes(attributes, unsupported)
    }

    /** Every property a timeline mentions that this engine will not animate, sorted and unique. */
    fun droppedProperties(timeline: List<Stop>): List<String> {
        val out = sortedSetOf<String>()
        for (stop in timeline) {
            for (property in stop.declarations.keys) if (property !in PROPERTIES) out.add(property)
        }
        return out.toList()
    }

    // ------------------------------------------------------------------ internals

    private fun directed(within: Double, iteration: Int, direction: String): Double = when (direction) {
        "reverse" -> 1.0 - within
        "alternate" -> if (iteration % 2 == 0) within else 1.0 - within
        "alternate-reverse" -> if (iteration % 2 == 0) 1.0 - within else within
        else -> within
    }

    private fun startFraction(spec: Spec): Double =
        if (spec.direction == "reverse" || spec.direction == "alternate-reverse") 1.0 else 0.0

    private fun endFraction(spec: Spec): Double {
        val last = if (spec.iterations == INFINITE) 0 else max(0, ceil(spec.iterations).toInt() - 1)
        return directed(1.0, last, spec.direction)
    }

    private fun valuesAt(timeline: List<Stop>, fraction: Double): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (property in PROPERTIES) {
            val stops = timeline.filter { it.declarations.containsKey(property) }
            if (stops.isEmpty()) continue
            interpolate(stops, property, fraction)?.let { out[property] = it }
        }
        return out
    }

    private fun interpolate(stops: List<Stop>, property: String, fraction: Double): String? {
        var before = stops.first()
        var after = stops.last()
        for (stop in stops) {
            if (stop.offset <= fraction) before = stop
            if (stop.offset >= fraction) { after = stop; break }
        }
        val a = before.declarations[property] ?: return null
        val b = after.declarations[property] ?: return null
        if (before === after || after.offset == before.offset) return a
        val t = (fraction - before.offset) / (after.offset - before.offset)
        return if (property == "opacity") mixNumber(a, b, t) else mixTransform(a, b, t)
    }

    private fun mixNumber(a: String, b: String, t: Double): String {
        val from = a.trim().toDoubleOrNull() ?: return a
        val to = b.trim().toDoubleOrNull() ?: return a
        return format(from + (to - from) * t)
    }

    /**
     * Transforms interpolate FUNCTION BY FUNCTION and only when both sides list the same
     * functions in the same order, which is CSS's own rule. A mismatched pair snaps at the
     * midpoint rather than blending to a shape the author never wrote.
     */
    private fun mixTransform(a: String, b: String, t: Double): String {
        val from = parseTransform(a)
        val to = parseTransform(b)
        if (from == null || to == null || from.size != to.size) return if (t < 0.5) a else b
        val out = ArrayList<String>(from.size)
        for (i in from.indices) {
            val f = from[i]
            val g = to[i]
            if (f.name != g.name || f.args.size != g.args.size) return if (t < 0.5) a else b
            val args = f.args.mapIndexed { j, value ->
                val other = g.args[j]
                if (value.unit != other.unit) format(value.n) + value.unit
                else format(value.n + (other.n - value.n) * t) + value.unit
            }
            out.add(f.name + "(" + args.joinToString(", ") + ")")
        }
        return out.joinToString(" ")
    }

    private data class TransformArg(val n: Double, val unit: String)
    private data class TransformFn(val name: String, val args: List<TransformArg>)

    private val TRANSFORM_FN = Regex("([a-zA-Z0-9]+)\\(([^)]*)\\)")
    private val TRAILING_UNIT = Regex("[a-z%]+$", RegexOption.IGNORE_CASE)

    private fun parseTransform(source: String): List<TransformFn>? {
        val matches = TRANSFORM_FN.findAll(source).toList()
        if (matches.isEmpty()) return if (source.trim() == "none") emptyList() else null
        val out = ArrayList<TransformFn>(matches.size)
        for (match in matches) {
            val args = ArrayList<TransformArg>()
            for (raw in match.groupValues[2].split(",")) {
                val text = raw.trim()
                if (text.isEmpty()) continue
                val unit = TRAILING_UNIT.find(text)?.value ?: ""
                val n = (if (unit.isEmpty()) text else text.dropLast(unit.length)).toDoubleOrNull()
                    ?: return null
                args.add(TransformArg(n, unit))
            }
            out.add(TransformFn(match.groupValues[1], args))
        }
        return out
    }

    /** A translation length in points. `0` is unitless in CSS; a percentage needs a box. */
    private fun px(arg: TransformArg): Double? = when {
        arg.unit == "px" -> arg.n
        arg.unit == "" && arg.n == 0.0 -> 0.0
        else -> null
    }

    /** An angle in degrees, in the units CSS writes them. */
    private fun deg(arg: TransformArg): Double? = when (arg.unit) {
        "deg" -> arg.n
        "rad" -> arg.n * 180.0 / PI
        "turn" -> arg.n * 360.0
        "grad" -> arg.n * 360.0 / 400.0
        "" -> if (arg.n == 0.0) 0.0 else null
        else -> null
    }

    private val STEPS = Regex("^steps\\(\\s*(\\d+)")
    private val BEZIER = Regex("^cubic-bezier\\(([^)]*)\\)$")

    /** The cubic-bezier solve by bisection - the shape every engine uses. */
    private fun ease(easing: String, t: Double): Double {
        if (t <= 0.0) return 0.0
        if (t >= 1.0) return 1.0
        // `linear` is IDENTITY, short-circuited rather than solved: the bisection converges to
        // about 1e-6, invisible on screen and very visible in a corpus of compared strings.
        if (easing == "linear") return t
        STEPS.find(easing)?.let { match ->
            val n = max(1, match.groupValues[1].toInt())
            return if (easing.contains("start")) ceil(t * n) / n else floor(t * n) / n
        }
        val p = NAMED_EASINGS[easing]
            ?: BEZIER.find(easing)?.groupValues?.get(1)
                ?.split(",")?.mapNotNull { it.trim().toDoubleOrNull() }
            ?: NAMED_EASINGS.getValue("ease")
        if (p.size != 4) return t
        val (x1, y1, x2, y2) = p
        fun bez(a: Double, b: Double, u: Double): Double {
            val v = 1 - u
            return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u
        }
        var lo = 0.0
        var hi = 1.0
        var u = t
        for (i in 0 until 24) {
            val x = bez(x1, x2, u)
            if (abs(x - t) < 1e-6) break
            if (x < t) lo = u else hi = u
            u = (lo + hi) / 2
        }
        return bez(y1, y2, u)
    }

    private fun parseTime(word: String): Double? {
        if (word.endsWith("ms")) return word.dropLast(2).toDoubleOrNull()
        if (word.endsWith("s")) return word.dropLast(1).toDoubleOrNull()?.times(1000.0)
        return null
    }

    private fun parseOffset(selector: String): Double? {
        val lower = selector.lowercase()
        if (lower == "from") return 0.0
        if (lower == "to") return 1.0
        if (!lower.endsWith("%")) return null
        val n = lower.dropLast(1).toDoubleOrNull() ?: return null
        return min(1.0, max(0.0, n / 100.0))
    }

    /** Split on whitespace, but never inside `cubic-bezier(…)` or `steps(…)`. */
    private fun splitTopLevel(source: String): List<String> {
        val out = ArrayList<String>()
        var depth = 0
        val current = StringBuilder()
        for (ch in source) {
            if (ch == '(') depth += 1
            if (ch == ')') depth -= 1
            if (depth == 0 && (ch == ' ' || ch == '\t' || ch == '\n')) {
                if (current.isNotEmpty()) { out.add(current.toString()); current.clear() }
                continue
            }
            current.append(ch)
        }
        if (current.isNotEmpty()) out.add(current.toString())
        return out
    }

    /**
     * Four decimals, trailing zeros trimmed, negative zero normalised - the same rule the
     * scroll-linked plane formats by, and for the same reason: three languages compare these
     * strings against one corpus.
     */
    private fun format(value: Double): String {
        if (!value.isFinite()) return "0"
        val rounded = Math.round(abs(value) * 10000.0) / 10000.0 * (if (value == 0.0) 1.0 else sign(value))
        if (rounded == 0.0) return "0"
        var text = String.format(java.util.Locale.ROOT, "%.4f", rounded)
        text = text.trimEnd('0').trimEnd('.')
        return if (text == "-0") "0" else text
    }
}
