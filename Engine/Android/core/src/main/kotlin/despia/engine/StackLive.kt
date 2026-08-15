//
//  StackLive.kt - the Stack engine's SNAPSHOT-SURFACE render backend, kernel half.
//  Kotlin twin of OpenSource/Engine/iOS/StackLive.swift (the Swift file is the reference
//  implementation - same element table, same defaults, same fail-open behaviors).
//
//  ONE grammar, a backend per surface. StackLive does NOT parse and does NOT fork the
//  language: it consumes the engine's shared AST (StackNode / StackXML) and describes
//  the subset a widget / snapshot process may legally run (no downloaded code, no JS -
//  a pure function of serialized state). The element table IS the contract: a tag maps
//  to a tiny `StackElement` whose `body` describes only its own content; adding
//  `<gauge>` is registering one type, never editing a switch. The uniform layout box
//  (padding / background / radius / grow / opacity) and child recursion are the paint
//  backend's job, so elements stay declarative.
//
//  ── THE PINNED SPLIT (PLAN.md ground rule 1) ─────────────────────────────────────────
//  Swift's `StackElement.body` returns a SwiftUI view; pure-JVM `:core` cannot construct
//  views, so `body` here returns a `StackLiveRender` DESCRIPTION - the same per-element
//  reads, the same defaults, as data. A paint backend (`:glance` for app widgets; any
//  richer surface later) walks `StackBackend.resolve` + `node.children` and draws. The
//  injectable table survives 1:1: Swift flows a table down the view tree as an
//  environment value so a richer surface renders a SUPERSET of tags; here the backend
//  passes its table through the recursion (same default, same override point).
//
//  FAIL-OPEN everywhere: unparseable markup -> `parses` is false and the caller shows
//  its built-in view; an unknown tag renders nothing (layout box still applies, Swift
//  verbatim); a missing `{{ dsx.variable.x }}` renders empty.
//

package despia.engine

// MARK: - Entry point

/// A DSX layout bound to a variable scope. Callers gate on `parses` and fall back to
/// their own view when it is false; a paint backend renders `root` in `scope`.
class StackLive {
    val root: StackNode?
    val scope: StackScope

    constructor(layout: String, vars: Map<String, String>) {
        this.root = StackXML.parse(layout)
        this.scope = StackScope(vars)
    }

    /// Bind an already-parsed node (a slot of a `StackActivity` document, so the
    /// document is parsed once and its slots rendered without re-parsing).
    constructor(node: StackNode?, vars: Map<String, String>) {
        this.root = node
        this.scope = StackScope(vars)
    }

    companion object {
        fun parses(layout: String): Boolean = layout.isNotEmpty() && StackXML.parse(layout) != null
    }
}

// MARK: - The backend contract: element registry + dispatch

/// What one node renders as, backend-agnostically. Containers carry axis + spacing +
/// alignment; the backend recurses `node.children` itself (elements never know the
/// backend). Colors are ARGB Longs, sizes points (dp/sp at the paint site) - the
/// pinned platform-type mappings of StackScope.kt.
sealed class StackLiveRender {
    /// vstack/hstack/zstack/stack/list/scroll - the one container shape. `frameAlign`
    /// only steers the DEPTH (overlay) axis; zstack pins CENTER (Swift `ZStack { }`),
    /// the generic `display="grid"` reads the align attribute (Swift verbatim).
    data class Stack(
        val axis: StackAxis,
        val spacing: Double,
        val hAlign: StackHAlign,
        val vAlign: StackVAlign,
        val frameAlign: StackHAlign,
    ) : StackLiveRender()

    /// The COMPILED INTERACTION (watch-runtime.md §Snapshot nodes): a snapshot button whose
    /// on:tap parsed as the ONE literal `dsx.module.<s>.<a>({json?})` shape. The Glance
    /// painter renders it interactive only when the app-installed capability seam admits
    /// scheme.action (the per-role table); otherwise — and when scheme is empty (no/bad
    /// on:tap) — it renders as the inert label. No JSE in the node, ever.
    data class Button(val label: String, val size: Double, val weight: StackFontWeight,
                      val color: Long, val scheme: String, val action: String,
                      val argsJSON: String) : StackLiveRender()
    /// The LIVE TOKEN (watch-runtime.md §Snapshot nodes): a countdown the OS renders.
    /// `until` = epoch SECONDS (ISO-8601 already normalized by the element). The Glance
    /// painter renders the REMAINING time at paint (re-painted on the widget's refresh
    /// cadence — Glance has no ticking text; the RemoteViews Chronometer upgrade is a
    /// documented deviation), while the SwiftUI twin ticks natively via Text(timerInterval:).
    data class Countdown(val untilEpochSeconds: Double, val size: Double,
                         val weight: StackFontWeight, val color: Long) : StackLiveRender()
    data class Text(val text: String, val size: Double, val weight: StackFontWeight,
                    val color: Long, val lines: Int) : StackLiveRender()
    data class Image(val symbol: String, val size: Double, val color: Long) : StackLiveRender()
    data class Progress(val value: Double, val tint: Long) : StackLiveRender()
    data class Gauge(val value: Double, val diameter: Double, val line: Double,
                     val track: Long, val tint: Long, val label: String,
                     val labelSize: Double) : StackLiveRender()
    object Spacer : StackLiveRender()
    data class Divider(val color: Long) : StackLiveRender()
    /// Unknown tag - renders nothing (the layout box still applies, Swift verbatim).
    object None : StackLiveRender()
}

enum class StackAxis { VERTICAL, HORIZONTAL, DEPTH }

/// One DSX tag's render. `body` describes only the element's own content; the backend
/// applies the shared layout box and drives child recursion. An element that renders
/// its own box (background/radius/shadow — e.g. a keyboard key cap) opts out of the
/// shared one with `ownsLayoutBox`.
interface StackElement {
    val tag: String
    val ownsLayoutBox: Boolean get() = false
    fun body(r: StackReader): StackLiveRender
}

/// The layout box every node carries: padding, background, corner radius, width-grow
/// and opacity - read uniformly so each element stays focused. `bg` null = clear.
data class StackLayoutBox(
    val padH: Double,
    val padV: Double,
    val growsWidth: Boolean,
    val frameAlignment: StackHAlign,
    val bg: Long?,
    val radius: Double,
    val opacity: Double,
) {
    companion object {
        fun of(r: StackReader) = StackLayoutBox(
            padH = r.double("paddingh", r.double("padding", 0.0)),
            padV = r.double("paddingv", r.double("padding", 0.0)),
            growsWidth = r.growsWidth,
            frameAlignment = r.frameAlignment,
            bg = r.string("bg")?.let { StackColor.parse(it) },
            radius = r.double("radius", 0.0),
            opacity = r.double("opacity", 1.0),
        )
    }
}

/// One resolved node: the element's content description + the uniform layout box the
/// backend must wrap it in (null when the element owns its box).
data class StackResolved(val render: StackLiveRender, val box: StackLayoutBox?)

object StackBackend {
    /// The cross-platform contract. Register an element; never grow a switch.
    /// list/scroll/divider live HERE (not per surface): on every snapshot surface a
    /// `list` is a styled vstack (dynamic rows were expanded by the phone before the
    /// layout shipped), `scroll` lays out vertically (the surface root owns any real
    /// scrolling), and `divider` is a one-liner — one implementation, every tier.
    val elements: Map<String, StackElement> = listOf(
        VStackElement,
        HStackElement,
        ZStackElement,
        GenericStackElement,
        TextElement,
        CountdownElement,
        LiveButtonElement,
        ImageElement,
        ProgressElement,
        GaugeElement,
        SpacerElement,
        ListElement,
        ScrollElement,
        DividerElement,
    ).associateBy { it.tag }

    /// Dispatch a node to its element, pairing the content description with the uniform
    /// layout box — unless the element declares it OWNS its box (`ownsLayoutBox`).
    /// `table` defaults to the snapshot-safe registry; a richer surface passes its own
    /// merged table through the recursion so the SAME dispatch renders its extra tags.
    fun resolve(node: StackNode, scope: StackScope,
                table: Map<String, StackElement> = elements): StackResolved {
        val reader = StackReader(node, scope)
        val element = table[node.tag]
            ?: return StackResolved(StackLiveRender.None, StackLayoutBox.of(reader))
        val render = element.body(reader)
        return StackResolved(render, if (element.ownsLayoutBox) null else StackLayoutBox.of(reader))
    }
}

// MARK: - Elements (one tag each; defaults are StackLive.swift verbatim)

object VStackElement : StackElement {
    override val tag = "vstack"
    override fun body(r: StackReader) = StackLiveRender.Stack(
        StackAxis.VERTICAL, r.double("spacing", 4.0),
        r.horizontalAlignment, r.verticalAlignment, StackHAlign.CENTER)
}

object HStackElement : StackElement {
    override val tag = "hstack"
    override fun body(r: StackReader) = StackLiveRender.Stack(
        StackAxis.HORIZONTAL, r.double("spacing", 6.0),
        r.horizontalAlignment, r.verticalAlignment, StackHAlign.CENTER)
}

object ZStackElement : StackElement {
    override val tag = "zstack"
    // Swift `ZStack { }` - alignment stays the default CENTER (align= is not read).
    override fun body(r: StackReader) = StackLiveRender.Stack(
        StackAxis.DEPTH, 0.0, r.horizontalAlignment, r.verticalAlignment, StackHAlign.CENTER)
}

/// `<stack>` — the generic container. Snapshot surfaces have no CSS engine, so the
/// axis comes from the plain `flexDirection` attribute (the phone renderer resolves
/// `flex-direction:`/gap CSS into these same attribute names); column is the default,
/// and gap defaults to 0 (web-true), unlike the legacy stacks.
object GenericStackElement : StackElement {
    override val tag = "stack"
    override fun body(r: StackReader): StackLiveRender {
        val spacing = r.double("spacing", 0.0)
        val axis = when {
            r.string("display") == "grid" -> StackAxis.DEPTH
            r.string("flexDirection")?.startsWith("row") == true -> StackAxis.HORIZONTAL
            else -> StackAxis.VERTICAL
        }
        return StackLiveRender.Stack(axis, spacing,
            r.horizontalAlignment, r.verticalAlignment, r.frameAlignment)
    }
}

object TextElement : StackElement {
    override val tag = "text"
    override fun body(r: StackReader) = StackLiveRender.Text(
        r.text, r.double("size", 13.0), r.fontWeight,
        r.color("color", StackColor.PRIMARY), r.double("lines", 1.0).toInt())
}

/// The snapshot call plumbing — the Swift DSXNodeCalls' :core half: the ONE literal call
/// shape a snapshot on:tap may carry. Pure parsing (testable SDK-free); execution and the
/// capability gate live app-side (:glance seam + the generated role table).
object StackNodeCalls {
    data class Call(val scheme: String, val action: String, val argsJSON: String)

    /// `dsx.module.<chain>.<action>()` / `({literal json, single quotes tolerated})` —
    /// anything else (JSE, chains, statements) is null: snapshot nodes never run code.
    /// Depth is UNBOUNDED past two segments (the Swift twin's law): a nested chain
    /// spelling (`dsx.module.watch.health.workout(...)`) parses whole — scheme = head,
    /// action = the dotted remainder; the dispatch funnel's fold resolves
    /// identity-vs-action (ChainResolver, Conformance/chains), never this parser.
    fun parse(handler: String): Call? {
        val s = handler.trim()
        if (!s.startsWith("dsx.module.")) return null
        val after = s.removePrefix("dsx.module.")
        val paren = after.indexOf('(')
        if (paren < 0) return null
        val chain = after.substring(0, paren).split('.')
        if (chain.size < 2 || chain.any { it.isEmpty() }) return null
        val close = after.lastIndexOf(')')
        if (close < paren) return null
        // NOTHING may follow the call (an optional single `;` aside) — `…show(); x=1`
        // must be refused whole, never silently truncated to the call.
        val tail = after.substring(close + 1).trim().removePrefix(";").trim()
        if (tail.isNotEmpty()) return null
        val inner = after.substring(paren + 1, close).trim()
        val json = if (inner.isEmpty()) "{}" else inner.replace('\'', '"')
        // LITERAL JSON OBJECT only (single quotes tolerated) — STRICT-parsed, the Swift
        // twin's JSONSerialization gate: an unquoted key or trailing comma is inert on
        // BOTH platforms, never interactive on one (a shape-only brace check drifted).
        if (inner.isNotEmpty() && JSECoreGlobals.jsonParse(json) !is Map<*, *>) return null
        // scheme = head, action = the DOTTED REMAINDER — the gate key
        // "$scheme.$action" is then the full authored spelling, exactly what
        // the baked role tables carry (the Swift twin returns the same shape).
        return Call(chain[0], chain.drop(1).joinToString("."), json)
    }
}

/// The COMPILED-INTERACTION element — the Swift LiveButtonElement's twin. Parsing here
/// (pure, tested); interactivity is the painter's call (the seam + role table are app
/// concepts). A button with no parseable call carries empty scheme/action = inert label.
object LiveButtonElement : StackElement {
    override val tag = "button"
    override fun body(r: StackReader): StackLiveRender {
        val call = r.node.attrs["on:tap"]?.let { StackNodeCalls.parse(it) }
        return StackLiveRender.Button(
            r.string("label") ?: r.text, r.double("size", 13.0), r.fontWeight,
            r.color("color", StackColor.PRIMARY),
            call?.scheme ?: "", call?.action ?: "", call?.argsJSON ?: "{}")
    }
}

/// The LIVE TOKEN element — the Swift CountdownElement's twin. `until` accepts epoch
/// seconds or ISO-8601 (normalized HERE so the render variant carries plain epoch);
/// unparsable → already elapsed (renders 0:00), never a crash.
object CountdownElement : StackElement {
    override val tag = "countdown"
    override fun body(r: StackReader): StackLiveRender {
        val raw = (r.string("until") ?: "").trim()
        val epoch = raw.toDoubleOrNull()
            ?: runCatching { java.time.Instant.parse(raw).epochSecond.toDouble() }.getOrNull()
            ?: 0.0
        return StackLiveRender.Countdown(
            if (epoch > 0) epoch else 0.0,
            r.double("size", 13.0), r.fontWeight, r.color("color", StackColor.PRIMARY))
    }
}

object ImageElement : StackElement {
    override val tag = "image"
    override fun body(r: StackReader) = StackLiveRender.Image(
        r.string("symbol") ?: "circle", r.double("size", 16.0),
        r.color("color", StackColor.ACCENT))
}

object ProgressElement : StackElement {
    override val tag = "progress"
    override fun body(r: StackReader) = StackLiveRender.Progress(
        r.unit("value"), r.color("tint", StackColor.ACCENT))
}

object GaugeElement : StackElement {
    override val tag = "gauge"
    // Track default = accent at 15% opacity (Swift's Color.accentColor.opacity(0.15)).
    override fun body(r: StackReader) = StackLiveRender.Gauge(
        value = r.unit("value"),
        diameter = r.double("size2", r.double("diameter", 38.0)),
        line = r.double("line", 2.5),
        track = r.color("track", 0x26007AFFL),
        tint = r.color("tint", StackColor.ACCENT),
        label = r.text,
        labelSize = r.double("size", 9.0))
}

object SpacerElement : StackElement {
    override val tag = "spacer"
    override fun body(r: StackReader) = StackLiveRender.Spacer
}

/// `list` on a snapshot surface is a styled vertical stack: the dynamic rows were
/// already expanded into children by the phone before the layout was shipped (the
/// snapshot model), so there is no in-process binding to evaluate. Same tag, 1:1
/// with the in-app `<list>`.
object ListElement : StackElement {
    override val tag = "list"
    override fun body(r: StackReader) = StackLiveRender.Stack(
        StackAxis.VERTICAL, r.double("spacing", 6.0),
        r.horizontalAlignment, r.verticalAlignment, StackHAlign.CENTER)
}

/// `scroll` is a passthrough container on snapshot surfaces: the surface root owns
/// any real scrolling, so a `<scroll>` lays its children out vertically instead of
/// dropping the subtree.
object ScrollElement : StackElement {
    override val tag = "scroll"
    override fun body(r: StackReader) = StackLiveRender.Stack(
        StackAxis.VERTICAL, r.double("spacing", 4.0),
        r.horizontalAlignment, r.verticalAlignment, StackHAlign.CENTER)
}

object DividerElement : StackElement {
    override val tag = "divider"
    override fun body(r: StackReader) = StackLiveRender.Divider(
        r.color("color", StackColor.DIVIDER))
}
