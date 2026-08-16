//
//  SceneIR.kt - the DSX Scene IR, Kotlin twin of
//  OpenSource/Web/packages/kernel/src/scene/ir.ts (dsx-scene.md P2): a parsed <scene>
//  subtree as typed nodes, platform-neutral and store-agnostic. The markup arrives
//  ALREADY parsed by this runtime's own XML parser — despia.engine.StackNode, the tree
//  StackXML.parse produces and every renderer walks — never a second XML parser (the
//  ir.ts law, verbatim). Attribute values keep their JSE holes verbatim; a resolver
//  callback interpolates at use time (the element wires the live store through
//  JSE.interpolate, the corpus wires a plain map). Defaults and the Article-7 fallback
//  law are pinned by OpenSource/Conformance/scene/parse.json.
//

package despia.engine.scene

import despia.engine.StackNode
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sqrt

enum class SceneNodeKind(val tag: String) {
    CAMERA("camera"), LIGHT("light"), GROUP("group"), BOX("box"), SPHERE("sphere"),
    PLANE("plane"), MODEL("model"), TEXT3D("text3d"), ANCHOR("anchor"), ANIMATE("animate"),
    SPRITE("sprite");

    companion object {
        fun fromTag(tag: String): SceneNodeKind? = entries.firstOrNull { it.tag == tag }
    }
}

enum class SceneMode(val word: String) { THREE_D("3d"), TWO_D("2d"), AR("ar") }

/** identity-keyed on purpose (a plain class, not data) — worldMatrices maps by node
 *  identity exactly like the TS Map<SceneNode, Mat4>. */
class SceneNode(
    val kind: SceneNodeKind,
    val id: String?,
    /** authored attribute strings, holes verbatim */
    val attrs: Map<String, String>,
    /** mutable for exactly one consumer: the bound-group reconciler swaps a
     *  `<group bind>`'s children for its instantiated rows (the web element's cast) */
    var children: List<SceneNode>,
    /** the originating markup node (parseScene sets it) — the renderer's way back to its
     *  own binding/handler machinery; hand-built IR (tests, corpora) may omit it */
    val source: StackNode? = null,
    /** G1 (prefab.json): set on a prefab-instance EXPANSION ROOT (an implicit group).
     *  `scope` holds the instance's parameter strings RAW — holes resolve at the
     *  INSTANCE SITE (the enclosing scope); body holes under this node resolve
     *  scope-first. */
    val prefab: ScenePrefabRef? = null,
    /** G6 (sprite.json): the enclosing scene's mode is "2d". Stamped by parseScene so the
     *  node-level folds honour the 2D conventions (a 2-number `position` means z = 0)
     *  without every signature growing a mode parameter. */
    val mode2d: Boolean = false,
)

class SceneIR(
    val mode: SceneMode,
    /** the <scene> element's own authored attrs (background, …), holes verbatim */
    val attrs: Map<String, String>,
    val nodes: List<SceneNode>,
)

enum class SceneDiagnosticCode {
    UNKNOWN_TAG, UNKNOWN_MODE, MALFORMED_VECTOR, MALFORMED_NUMBER, UNKNOWN_LIGHT_KIND,
    // P5 (the ir.ts names, SCREAMING_SNAKE): malformed-animation · bind-overflow ·
    // light-cap · malformed-fog · unknown-collide
    MALFORMED_ANIMATION, BIND_OVERFLOW, LIGHT_CAP, MALFORMED_FOG, UNKNOWN_COLLIDE,
    // G2 (physics.ts): unknown-physics · physics-nested
    UNKNOWN_PHYSICS, PHYSICS_NESTED,
    // G3 (skin.ts): unknown-clip
    UNKNOWN_CLIP, PREFAB_IGNORED,
    // G1 prefabs (ir.ts): prefab-not-scene · prefab-depth
    PREFAB_NOT_SCENE, PREFAB_DEPTH,
    // G6 the 2D engine (sprite.ts): malformed-sprite
    MALFORMED_SPRITE
}

class SceneDiagnostic(val code: SceneDiagnosticCode, val message: String)

typealias SceneDiag = (SceneDiagnostic) -> Unit

/** resolve one authored attribute string for one node (null node = the <scene> root).
 *  The element's resolver evaluates holes through the live store; the corpus resolver
 *  substitutes from a plain variable map. A resolver returns the RESOLVED string. */
typealias SceneResolve = (node: SceneNode?, name: String, raw: String) -> String

private val HOLE = Regex("\\{\\{(.*?)\\}\\}", RegexOption.DOT_MATCHES_ALL)

/** the store-agnostic hole interpolator: replaces every {{ expr }} with
 *  String(evalHole(trimmed expr)) — what a map-backed corpus resolver uses.
 *  Numbers stringify JS-style (45 → "45", 1.5 → "1.5") to match the TS twin. */
fun interpolateSceneHoles(raw: String, evalHole: (expr: String) -> Any?): String =
    HOLE.replace(raw) { match ->
        when (val value = evalHole(match.groupValues[1].trim())) {
            null -> ""
            is Number -> sceneNumberString(value.toDouble())
            is Boolean -> value.toString()          // JS String(true) = "true"
            else -> value.toString()
        }
    }

/** parse a <scene> markup subtree into the typed IR. Unknown tags are SKIPPED with a
 *  diagnostic — never a phantom node, never a crash (Article 7). A `prefabs` lookup
 *  (G1, dsx-game.md §2) lets locally-declared COMPONENT tags instantiate as prefabs —
 *  the kernel never learns a component name (rule 18: the lookup is the seam). */
fun parseScene(markup: StackNode, diag: SceneDiag? = null, prefabs: ScenePrefabLookup? = null): SceneIR {
    val modeRaw = markup.attrs["mode"] ?: "3d"
    val mode = SceneMode.entries.firstOrNull { it.word == modeRaw } ?: run {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.UNKNOWN_MODE,
            "<scene mode=\"$modeRaw\"> is not 3d, 2d or ar — using 3d",
        ))
        SceneMode.THREE_D
    }
    return SceneIR(mode, markup.attrs, parseNodes(markup.children, diag, prefabs, 0, mode == SceneMode.TWO_D))
}

private fun parseNodes(
    children: List<StackNode>, diag: SceneDiag?, prefabs: ScenePrefabLookup? = null, depth: Int = 0,
    mode2d: Boolean = false,
): List<SceneNode> {
    val nodes = ArrayList<SceneNode>()
    for (child in children) {
        val kind = SceneNodeKind.fromTag(child.tag)
        if (kind == null) {
            val def = prefabs?.invoke(child.tag)
            if (def != null) {
                expandScenePrefab(child, def, diag, prefabs, depth, mode2d)?.let { nodes.add(it) }
                continue
            }
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.UNKNOWN_TAG, "<${child.tag}> is not a scene node — skipped",
            ))
            continue
        }
        nodes.add(SceneNode(
            kind = kind,
            id = child.attrs["id"],
            attrs = child.attrs,
            children = parseNodes(child.children, diag, prefabs, depth, mode2d),
            source = child,
            mode2d = mode2d,
        ))
    }
    return nodes
}

// ── prefabs (G1, dsx-game.md §2): components instantiate inside <scene> subtrees ─────
//
// The Kotlin twin of ir.ts's prefab section, corpus prefab.json. A PREFAB IS A
// COMPONENT whose body is scene content — no second concept. The kernel owns only the
// STRUCTURAL law; each renderer derives the definition from ITS OWN component registry
// (ComposeStackComponents / the desktop component table) and hands parseScene a
// lookup, so no component name ever appears in kernel code (constitution rule 18).

/** the runaway self-reference guard — prefab expansion nests at most this deep */
const val SCENE_PREFAB_DEPTH_LIMIT = 8

/** instance words that are the node TRANSFORM, never scope parameters */
val SCENE_PREFAB_TRANSFORM_WORDS: List<String> = listOf("position", "rotation", "scale")

/** head/declaration tags that never join a prefab body (the dsx-anatomy head words) */
private val SCENE_PREFAB_DECLARATION_TAGS: Set<String> = setOf(
    "head", "attribute", "variable", "var", "let", "action", "formula", "script", "functions",
    "event", "expects", "watch", "api", "style", "component", "slot",
)

/** instance attrs that never enter the scope (identity/presentation/reserved words) */
private val SCENE_PREFAB_RESERVED_WORDS: Set<String> = setOf("id", "__css", "css-owner", "slot", "bind", "key")

class ScenePrefabParam(val name: String, val default: String? = null)

class ScenePrefabDef(
    /** declared `<attribute>` words (name + optional default raw string) */
    val params: List<ScenePrefabParam>,
    /** the component body's top-level markup nodes */
    val roots: List<StackNode>,
    /** THE DEFINING-SCOPE LAW: nested tags inside this body resolve where the
     *  component was DECLARED (its own package/scope), exactly as component expansion
     *  outside scenes does — a renderer with scoped registries binds this to the
     *  owning scope's resolution. Null = the instance site's lookup (flat registries). */
    val lookup: ScenePrefabLookup? = null,
)

/** tag → definition (null = not a component). Each renderer wires its own registry. */
typealias ScenePrefabLookup = (tag: String) -> ScenePrefabDef?

/** the stamp a prefab EXPANSION ROOT carries (SceneNode.prefab) */
class ScenePrefabRef(
    /** the instance tag (diagnostics/tooling — never dispatch) */
    val tag: String,
    /** parameter name → RAW instance string (holes resolve at the INSTANCE SITE) */
    val scope: Map<String, String>,
)

/** derive a prefab definition from a component TEMPLATE — the shape each lane's
 *  registry holds: a bare scene root, or a wrapper whose non-declaration children are
 *  the body roots (the inline `<component as>` wrap, a .dsx file root). Declared
 *  `<attribute as default>` params are scanned from the head/declarations EITHER way —
 *  a bare scene root may carry its `<head>` as a child (registries that keep templates
 *  verbatim), so declarations are scanned AND stripped there too. */
fun scenePrefabDefFromTemplate(template: StackNode): ScenePrefabDef {
    val params = ArrayList<ScenePrefabParam>()
    fun scanParams(children: List<StackNode>) {
        for (child in children) {
            if (child.tag == "head") { scanParams(child.children); continue }
            if (child.tag != "attribute") continue
            val name = child.attrs["as"] ?: continue
            if (name.isEmpty()) continue
            params.add(ScenePrefabParam(name, child.attrs["default"]))
        }
    }
    if (SceneNodeKind.fromTag(template.tag) != null) {
        scanParams(template.children)
        val body = template.children.filter { it.tag !in SCENE_PREFAB_DECLARATION_TAGS }
        val root = if (body.size == template.children.size) template
            else StackNode(template.tag, template.attrs, body)
        return ScenePrefabDef(params, listOf(root))
    }
    scanParams(template.children)
    return ScenePrefabDef(params, template.children.filter { it.tag !in SCENE_PREFAB_DECLARATION_TAGS })
}

/** THE SCOPE LAW: every non-reserved, non-transform, non-handler instance attribute
 *  enters the scope RAW; declared params missing from the instance fall to their
 *  declared default string. */
fun scenePrefabScope(instance: StackNode, def: ScenePrefabDef): Map<String, String> {
    val scope = LinkedHashMap<String, String>()
    for ((name, value) in instance.attrs) {
        if (name in SCENE_PREFAB_RESERVED_WORDS || name.startsWith("on:")) continue
        if (name in SCENE_PREFAB_TRANSFORM_WORDS) continue
        scope[name] = value
    }
    for (p in def.params) {
        if (scope[p.name] == null && p.default != null) scope[p.name] = p.default
    }
    return scope
}

/** THE EXPANSION-ROOT LAW: an instance ALWAYS expands to one implicit `group` carrying
 *  the instance's transform words + id (instance transforms COMPOSE with body-authored
 *  transforms — never clobber), children = the body roots. A body that is not scene
 *  content skips the WHOLE instance with one `prefab-not-scene` diagnostic; expansion
 *  past SCENE_PREFAB_DEPTH_LIMIT skips with one `prefab-depth` diagnostic (Article 7). */
private fun expandScenePrefab(
    instance: StackNode, def: ScenePrefabDef,
    diag: SceneDiag?, prefabs: ScenePrefabLookup?, depth: Int, mode2d: Boolean = false,
): SceneNode? {
    if (depth >= SCENE_PREFAB_DEPTH_LIMIT) {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.PREFAB_DEPTH,
            "<${instance.tag}> nests prefabs deeper than $SCENE_PREFAB_DEPTH_LIMIT — skipped",
        ))
        return null
    }
    // the body resolves in its DEFINING scope when the renderer provides one (the
    // defining-scope law) — a packaged prefab's nested tags mean what they meant
    // where the component was declared, exactly as expansion outside scenes
    val bodyLookup = def.lookup ?: prefabs
    val notScene = def.roots.isEmpty() || def.roots.any {
        SceneNodeKind.fromTag(it.tag) == null && bodyLookup?.invoke(it.tag) == null
    }
    if (notScene) {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.PREFAB_NOT_SCENE,
            "<${instance.tag}> is a component but its body is not scene content — skipped",
        ))
        return null
    }
    // bind/key/on:* on an instance tag do nothing — say so (Article 7, never silent):
    // spawning is <group bind> around the instance; handlers live inside the body
    val ignored = instance.attrs.keys.filter { it == "bind" || it == "key" || it.startsWith("on:") }
    if (ignored.isNotEmpty()) {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.PREFAB_IGNORED,
            "<${instance.tag}> ${ignored.joinToString(", ")} ignored — wrap the instance in <group bind key> to spawn; attach handlers inside the component body",
        ))
    }
    val attrs = LinkedHashMap<String, String>()
    for (name in SCENE_PREFAB_TRANSFORM_WORDS) instance.attrs[name]?.let { attrs[name] = it }
    val id = instance.attrs["id"]
    if (id != null) attrs["id"] = id
    return SceneNode(
        kind = SceneNodeKind.GROUP,
        id = id,
        attrs = attrs,
        children = parseNodes(def.roots, diag, bodyLookup, depth + 1, mode2d),
        source = instance,
        prefab = ScenePrefabRef(instance.tag, scenePrefabScope(instance, def)),
        mode2d = mode2d,
    )
}

/** the corpus/tooling resolver over an expanded tree: body holes under a prefab root
 *  resolve SCOPE-FIRST (an expr that is exactly a scope key reads the per-instance
 *  value, resolved at the instance site), everything else falls through to `evalHole`
 *  (the outer plane). Renderers implement the same law on their live item planes. */
fun scenePrefabResolver(nodes: List<SceneNode>, evalHole: (expr: String) -> Any?): SceneResolve {
    val scopes = HashMap<SceneNode, Map<String, String>>()
    fun walk(list: List<SceneNode>, enclosing: Map<String, String>?) {
        for (node in list) {
            // the root's OWN attrs (the instance transforms) resolve at the INSTANCE SITE
            if (enclosing != null) scopes[node] = enclosing
            var inner = enclosing
            val ref = node.prefab
            if (ref != null) {
                val site: (String) -> Any? = { expr ->
                    if (enclosing != null && enclosing.containsKey(expr)) enclosing[expr] else evalHole(expr)
                }
                inner = ref.scope.mapValues { (_, raw) -> interpolateSceneHoles(raw, site) }
            }
            walk(node.children, inner)
        }
    }
    walk(nodes, null)
    return { node, _, raw ->
        interpolateSceneHoles(raw) { expr ->
            val scope = node?.let { scopes[it] }
            if (scope != null && scope.containsKey(expr)) scope[expr] else evalHole(expr)
        }
    }
}

/** THE RUNTIME ITEM PLANE (both JVM `<scene>` elements + the iOS twin's shape): the
 *  per-instance scope rides the same item plane bound rows use. [stamp] records each
 *  node's chain of enclosing prefab ROOTS (structural, once per mount/instantiation);
 *  [itemFor] computes the LIVE effective item for a node — scope values re-resolve at
 *  the instance site on every read, so a store-bound instance attribute stays
 *  reactive. A prefab root whose site is a bound row resolves against the ROW item
 *  (rows always instantiate deeper than the enclosing prefab); a row INSIDE a prefab
 *  body wins over the outer scope by map identity (the row item spreads the scope). */
class ScenePrefabItems(
    /** interpolate one raw attr string in an item scope (the element wires JSE) */
    private val interpolate: (raw: String, item: Map<String, Any?>?) -> String,
) {
    private val chains = HashMap<SceneNode, List<SceneNode>>()

    /** the per-pass cache of resolved instance scopes, keyed by prefab ROOT — [itemFor]
     *  runs once per attribute read per node, so re-deriving the (unchanged) scope each
     *  time is pure waste (the review's 144k-interpolations-a-second scenario). The
     *  element calls [beginPass] once per render pass; structural changes clear too. */
    private val rootScopes = HashMap<SceneNode, Map<String, Any?>>()

    /** invalidate the resolved-scope cache — call at the top of every render pass */
    fun beginPass() = rootScopes.clear()

    fun stamp(nodes: List<SceneNode>, chain: List<SceneNode> = emptyList()) {
        rootScopes.clear()
        for (node in nodes) {
            if (chain.isNotEmpty()) chains[node] = chain
            val inner = if (node.prefab != null) chain + node else chain
            stampInner(node.children, inner)
        }
    }

    private fun stampInner(nodes: List<SceneNode>, chain: List<SceneNode>) {
        for (node in nodes) {
            if (chain.isNotEmpty()) chains[node] = chain
            val inner = if (node.prefab != null) chain + node else chain
            stampInner(node.children, inner)
        }
    }

    fun drop(nodes: List<SceneNode>) {
        rootScopes.clear()
        for (node in nodes) {
            chains.remove(node)
            drop(node.children)
        }
    }

    fun chainOf(node: SceneNode): List<SceneNode> = chains[node] ?: emptyList()

    fun itemFor(
        node: SceneNode,
        rowItem: (SceneNode) -> Map<String, Any?>?,
        surface: Map<String, Any?>?,
    ): Map<String, Any?>? {
        val chain = chains[node] ?: return rowItem(node) ?: surface
        val nodeRow = rowItem(node)
        // a row instantiated INSIDE the innermost prefab body stamps the prefab root
        // with the same item map; a differing (or absent) stamp means the row is the
        // deeper scope and wins
        if (nodeRow != null && rowItem(chain.last()) !== nodeRow) return nodeRow
        var item: Map<String, Any?>? = null
        for (root in chain) {
            val cached = rootScopes[root]
            if (cached != null) { item = cached; continue }
            val site = rowItem(root) ?: item ?: surface
            item = root.prefab!!.scope.mapValues { (_, raw) -> interpolate(raw, site) }
            rootScopes[root] = item
        }
        return item
    }
}

// ── typed attribute resolution (the corpus defaults) ─────────────────────────────────

/** JS-Number-aligned parse for AUTHORED numeric attrs — the cross-renderer number law.
 *  Kotlin's toDoubleOrNull (Java parseDouble) ACCEPTS trailing f/F/d/D suffixes the
 *  web (Number()) and iOS (Double()) twins reject, and REJECTS the 0x hex integers
 *  both accept — one markup must parse the same everywhere, so this is the ONE parse
 *  every scene attr number goes through. */
internal fun sceneAttrDouble(part: String): Double? {
    if (part.isEmpty()) return null
    val last = part.last()
    if (last == 'f' || last == 'F' || last == 'd' || last == 'D') return null
    val hex = if (part.startsWith("0x") || part.startsWith("0X")) part.substring(2)
        else if ((part.startsWith("+0x") || part.startsWith("-0x") ||
                  part.startsWith("+0X") || part.startsWith("-0X"))) null  // JS Number rejects signed hex
        else ""
    if (hex == null) return null
    if (hex.isNotEmpty()) {
        if (!hex.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) return null
        return hex.toLongOrNull(16)?.toDouble()
    }
    return part.toDoubleOrNull()
}

private fun finiteNumbers(resolved: String): DoubleArray? {
    val parts = resolved.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    val numbers = DoubleArray(parts.size)
    for ((i, part) in parts.withIndex()) {
        val value = sceneAttrDouble(part)
        if (value == null || !value.isFinite()) return null
        numbers[i] = value
    }
    return numbers
}

// THE TOTAL-RESOLVE LAW (P5): an UNAUTHORED attribute still consults the resolver,
// with its formatted DEFAULT as the raw value. A pure hole-interpolating resolver
// (the corpus map resolver) returns that default string unchanged — identical numbers
// to the pre-P5 early-return — while a renderer's OVERRIDE PLANE (animations, orbit)
// can now reach properties the author never wrote (`<animate target="rotation">` on a
// node with no rotation= attribute).

// readVec/readScalar/readString are `internal`, not private: the physics extraction
// (ScenePhysics.kt) shares them exactly like the TS ir.ts exports them to physics.ts —
// sibling kernel modules only, never a renderer surface.

internal fun readVec(
    node: SceneNode?, name: String, fallback: DoubleArray,
    resolve: SceneResolve, diag: SceneDiag?, attrs: Map<String, String>,
): DoubleArray {
    val raw = attrs[name] ?: fallback.joinToString(" ") { sceneNumberString(it) }
    val resolved = resolve(node, name, raw)
    val numbers = finiteNumbers(resolved)
    if (numbers == null || numbers.size != fallback.size) {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_VECTOR,
            "$name=\"$resolved\" is not ${fallback.size} numbers — using \"${fallback.joinToString(" ") { sceneNumberString(it) }}\"",
        ))
        return fallback.copyOf()
    }
    return numbers
}

internal fun readScalar(
    node: SceneNode?, name: String, fallback: Double,
    resolve: SceneResolve, diag: SceneDiag?, attrs: Map<String, String>,
): Double {
    val raw = attrs[name] ?: sceneNumberString(fallback)
    val resolved = resolve(node, name, raw)
    val trimmed = resolved.trim()
    val value = sceneAttrDouble(trimmed)
    if (trimmed.isEmpty() || value == null || !value.isFinite()) {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_NUMBER,
            "$name=\"$resolved\" is not a number — using ${sceneNumberString(fallback)}",
        ))
        return fallback
    }
    return value
}

internal fun readString(
    node: SceneNode?, name: String, fallback: String,
    resolve: SceneResolve, attrs: Map<String, String>,
): String {
    val raw = attrs[name] ?: fallback
    return resolve(node, name, raw)
}

/** THE 2D PAIR LAW (G6, sprite.json): inside `mode="2d"` a `position` of TWO numbers
 *  means z = 0; a triple still means what it always did, and every OTHER vector word
 *  (rotation, scale, velocity) stays a triple — a named absence. Outside 2D a pair is
 *  malformed exactly as before (readVec's shared law). */
internal fun readPosition(
    node: SceneNode?, fallback: DoubleArray,
    resolve: SceneResolve, diag: SceneDiag?, attrs: Map<String, String>,
): Vec3 {
    if (node?.mode2d == true) {
        val raw = attrs["position"] ?: fallback.joinToString(" ") { sceneNumberString(it) }
        val pair = finiteNumbers(resolve(node, "position", raw))
        if (pair != null && pair.size == 2) return doubleArrayOf(pair[0], pair[1], 0.0)
    }
    return readVec(node, "position", fallback, resolve, diag, attrs)
}

// ── the sprite grammar (G6, corpus sprite.json) ──────────────────────────────────────
//
// These three live HERE, beside the other attribute grammars, so `resolvedProps` needs
// no import from SceneSprite.kt — the quad/UV/fps folds use THEM (one direction, the
// text3d precedent).

/** which point of the quad `position` names → the anchor point's offset from the quad
 *  CENTER as a fraction of (width, height): ax ∈ {−½ left, 0 center, +½ right},
 *  ay ∈ {+½ top, 0 center, −½ bottom} */
val SPRITE_ANCHORS: Map<String, DoubleArray> = linkedMapOf(
    "center" to doubleArrayOf(0.0, 0.0),
    "top" to doubleArrayOf(0.0, 0.5),
    "bottom" to doubleArrayOf(0.0, -0.5),
    "left" to doubleArrayOf(-0.5, 0.0),
    "right" to doubleArrayOf(0.5, 0.0),
    "top-left" to doubleArrayOf(-0.5, 0.5),
    "top-right" to doubleArrayOf(0.5, 0.5),
    "bottom-left" to doubleArrayOf(-0.5, -0.5),
    "bottom-right" to doubleArrayOf(0.5, -0.5),
)

const val SPRITE_DEFAULT_ANCHOR = "center"

/** THE SHEET GRAMMAR: ONE number N = a SINGLE ROW (cols = N, rows = 1); TWO numbers =
 *  "cols rows" EXPLICITLY. The kernel never guesses a grid — `cols = ceil(√N)` is WRONG
 *  and is not the law. Anything else (a fraction, < 1, three numbers, a word) is null
 *  and the caller falls back to 1×1 with one diagnostic (Article 7). */
fun parseSpriteFrames(raw: String): IntArray? {
    val parts = raw.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (parts.size != 1 && parts.size != 2) return null
    val numbers = IntArray(parts.size)
    for ((i, part) in parts.withIndex()) {
        val value = sceneAttrDouble(part)
        if (value == null || !value.isFinite() || value < 1.0 || value != kotlin.math.floor(value)) return null
        numbers[i] = value.toInt()
    }
    return if (parts.size == 1) intArrayOf(numbers[0], 1) else intArrayOf(numbers[0], numbers[1])
}

/** the `flip` word: "" or any arrangement of the letters x and y ("yx" IS "xy" — the
 *  word is a SET), normalized to "" · "x" · "y" · "xy". null = not a flip word. */
fun normalizeSpriteFlip(raw: String): String? {
    if (raw.isEmpty()) return ""
    if (raw.length > 2) return null
    var x = false
    var y = false
    for (letter in raw) {
        if (letter == 'x' && !x) x = true
        else if (letter == 'y' && !y) y = true
        else return null
    }
    return if (x) (if (y) "xy" else "x") else "y"
}

val LIGHT_KINDS: Set<String> = setOf("ambient", "directional", "point")

val COLLIDE_KINDS: Set<String> = setOf("sphere", "box")

/** every typed property a renderer needs, resolved per the parse-corpus defaults */
class SceneNodeProps(
    val position: Vec3,
    val rotation: Vec3,
    val scale: Vec3,
    val color: String,
    /** camera */
    val lookAt: Vec3, val fov: Double, val near: Double, val far: Double, val size2d: Double,
    /** light */
    val lightKind: String, val intensity: Double,
    /** point-light falloff distance (the P5 attenuation law; default 10) */
    val range: Double,
    /** camera controls word ("" = none; "orbit" is the P5 word) */
    val controls: String,
    /** collision opt-in ("" = not a collider; "sphere" | "box" — the P5 collide law) */
    val collide: String,
    /** geometry */
    val boxSize: Vec3, val radius: Double, val planeSize: DoubleArray,
    /** P4 kinds */
    val src: String, val value: String, val anchorKind: String,
    /** text3d glyph height in scene units (the quad law, text3d.json) */
    val text3dSize: Double,
    /** texture URL for box/sphere/plane ("" = untextured; the UV law lives in the corpus README) */
    val texture: String,
    /** G3 (skin.json): the model's clip NAME ("" = bind pose) */
    val animation: String = "",
    /** G3: clip time wrap — true = modulo duration (the default), false = clamp at end */
    val clipLoop: Boolean = true,
    /** G3: crossfade duration for an `animation` switch (default 0 = hard cut) */
    val blendMs: Double = 0.0,
    /** G6 (sprite.json): the sprite quad's authored `size` (w h; default 1 1) */
    val spriteSize: DoubleArray = doubleArrayOf(1.0, 1.0),
    /** G6: whether `size` was AUTHORED — unauthored derives width from the texture aspect */
    val spriteSizeAuthored: Boolean = false,
    /** G6: the sheet grid [cols, rows] (default 1 1 = the whole texture) */
    val spriteFrames: IntArray = intArrayOf(1, 1),
    /** G6: the 0-based frame index, floored and CLAMPED into [0, cols·rows − 1] */
    val spriteFrame: Int = 0,
    /** G6: frames per second for auto-advance (0 = none; a positive fps OWNS the index) */
    val spriteFps: Double = 0.0,
    /** G6: whether an fps-driven strip wraps (true) or holds its last frame (false) */
    val spriteLoop: Boolean = true,
    /** G6: which point of the quad `position` names (the anchor words) */
    val spriteAnchor: String = SPRITE_DEFAULT_ANCHOR,
    /** G6: the normalized UV mirror word — "" · "x" · "y" · "xy" */
    val spriteFlip: String = "",
)

fun resolvedProps(node: SceneNode, resolve: SceneResolve, diag: SceneDiag? = null): SceneNodeProps {
    val a = node.attrs
    val cameraDefault = doubleArrayOf(0.0, 0.0, 5.0)
    val kindRaw = readString(node, "kind", "", resolve, a)
    var lightKind = "ambient"
    if (node.kind == SceneNodeKind.LIGHT && kindRaw.isNotEmpty()) {
        if (kindRaw in LIGHT_KINDS) lightKind = kindRaw
        else diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.UNKNOWN_LIGHT_KIND,
            "<light kind=\"$kindRaw\"> is not ambient, directional or point — using ambient",
        ))
    }
    val geometryNode = node.kind == SceneNodeKind.BOX || node.kind == SceneNodeKind.SPHERE ||
        node.kind == SceneNodeKind.PLANE
    var collide = ""
    if (geometryNode) {
        val collideRaw = readString(node, "collide", "", resolve, a)
        if (collideRaw.isNotEmpty()) {
            if (collideRaw in COLLIDE_KINDS) collide = collideRaw
            else diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.UNKNOWN_COLLIDE,
                "collide=\"$collideRaw\" is not sphere or box — not a collider",
            ))
        }
    }
    // `size` and every camera scalar read PER KIND — the word is shared (camera scalar,
    // box triple, plane pair), so an unconditional read would mis-diagnose valid markup.
    val camera = node.kind == SceneNodeKind.CAMERA
    // G3 model clip words (skin.json props cases): animation name, loop, blend
    val model = node.kind == SceneNodeKind.MODEL
    var clipLoop = true
    if (model) {
        val loopRaw = readString(node, "loop", "true", resolve, a)
        if (loopRaw == "false") clipLoop = false
        else if (loopRaw != "true") diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_ANIMATION,
            "loop=\"$loopRaw\" is not true or false — using true",
        ))
    }
    var blendMs = 0.0
    if (model && a.containsKey("blend")) {
        val blendRaw = readString(node, "blend", "0", resolve, a)
        val parsed = parseSceneDuration(blendRaw)
        if (parsed == null) diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_ANIMATION,
            "blend=\"$blendRaw\" is not ms|s — using 0",
        ))
        else blendMs = parsed
    }
    // G6 (sprite.json): the `<sprite>` words. Every read is gated on the kind — `size`,
    // `loop` and `frame` are shared words, so an unconditional read would mis-diagnose.
    val sprite = node.kind == SceneNodeKind.SPRITE
    val spriteSize = if (sprite) readVec(node, "size", doubleArrayOf(1.0, 1.0), resolve, diag, a)
        else doubleArrayOf(1.0, 1.0)
    var spriteFrames = intArrayOf(1, 1)
    if (sprite) {
        val framesRaw = readString(node, "frames", "1 1", resolve, a)
        val parsed = parseSpriteFrames(framesRaw)
        if (parsed == null) diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_SPRITE,
            "frames=\"$framesRaw\" is not a frame count or \"cols rows\" of whole numbers ≥ 1 — using the whole texture",
        ))
        else spriteFrames = parsed
    }
    var spriteFrame = 0
    if (sprite) {
        val total = spriteFrames[0] * spriteFrames[1]
        val floored = kotlin.math.floor(readScalar(node, "frame", 0.0, resolve, diag, a))
        val clamped = kotlin.math.min(kotlin.math.max(floored, 0.0), (total - 1).toDouble())
        spriteFrame = clamped.toInt()
        if (floored != clamped) diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_SPRITE,
            "frame=\"${sceneNumberString(floored)}\" is outside 0..${total - 1} — clamped to $spriteFrame",
        ))
    }
    var spriteLoop = true
    var spriteAnchor = SPRITE_DEFAULT_ANCHOR
    var spriteFlip = ""
    if (sprite) {
        val loopRaw = readString(node, "loop", "true", resolve, a)
        if (loopRaw == "false") spriteLoop = false
        else if (loopRaw != "true") diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_SPRITE, "loop=\"$loopRaw\" is not true or false — using true",
        ))
        val anchorRaw = readString(node, "anchor", SPRITE_DEFAULT_ANCHOR, resolve, a)
        if (SPRITE_ANCHORS.containsKey(anchorRaw)) spriteAnchor = anchorRaw
        else diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_SPRITE,
            "anchor=\"$anchorRaw\" is not a sprite anchor word — using $SPRITE_DEFAULT_ANCHOR",
        ))
        val flipRaw = readString(node, "flip", "", resolve, a).trim()
        val flip = normalizeSpriteFlip(flipRaw)
        if (flip == null) diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_SPRITE,
            "flip=\"$flipRaw\" is not \"\", \"x\", \"y\" or \"xy\" — not mirrored",
        ))
        else spriteFlip = flip
    }
    return SceneNodeProps(
        position = readPosition(node, if (camera) cameraDefault else doubleArrayOf(0.0, 0.0, 0.0), resolve, diag, a),
        rotation = readVec(node, "rotation", doubleArrayOf(0.0, 0.0, 0.0), resolve, diag, a),
        scale = readVec(node, "scale", doubleArrayOf(1.0, 1.0, 1.0), resolve, diag, a),
        color = readString(node, "color", "#ffffff", resolve, a),
        lookAt = if (camera) readVec(node, "look-at", doubleArrayOf(0.0, 0.0, 0.0), resolve, diag, a) else doubleArrayOf(0.0, 0.0, 0.0),
        fov = if (camera) readScalar(node, "fov", 60.0, resolve, diag, a) else 60.0,
        near = if (camera) readScalar(node, "near", 0.1, resolve, diag, a) else 0.1,
        far = if (camera) readScalar(node, "far", 1000.0, resolve, diag, a) else 1000.0,
        size2d = if (camera) readScalar(node, "size", 5.0, resolve, diag, a) else 5.0,
        lightKind = lightKind,
        intensity = if (node.kind == SceneNodeKind.LIGHT) readScalar(node, "intensity", 1.0, resolve, diag, a) else 1.0,
        range = if (node.kind == SceneNodeKind.LIGHT && lightKind == "point")
            readScalar(node, "range", POINT_LIGHT_DEFAULT_RANGE, resolve, diag, a) else POINT_LIGHT_DEFAULT_RANGE,
        controls = if (camera) readString(node, "controls", "", resolve, a) else "",
        collide = collide,
        boxSize = if (node.kind == SceneNodeKind.BOX) readVec(node, "size", doubleArrayOf(1.0, 1.0, 1.0), resolve, diag, a) else doubleArrayOf(1.0, 1.0, 1.0),
        radius = if (node.kind == SceneNodeKind.SPHERE) readScalar(node, "radius", 1.0, resolve, diag, a) else 1.0,
        planeSize = if (node.kind == SceneNodeKind.PLANE) readVec(node, "size", doubleArrayOf(1.0, 1.0), resolve, diag, a) else doubleArrayOf(1.0, 1.0),
        src = readString(node, "src", "", resolve, a),
        value = readString(node, "value", "", resolve, a),
        anchorKind = if (node.kind == SceneNodeKind.ANCHOR) readString(node, "kind", "", resolve, a) else "",
        text3dSize = if (node.kind == SceneNodeKind.TEXT3D)
            readScalar(node, "size", TEXT3D_DEFAULT_SIZE, resolve, diag, a) else TEXT3D_DEFAULT_SIZE,
        texture = if (node.kind == SceneNodeKind.BOX || node.kind == SceneNodeKind.SPHERE || node.kind == SceneNodeKind.PLANE)
            readString(node, "texture", "", resolve, a) else "",
        animation = if (model) readString(node, "animation", "", resolve, a) else "",
        clipLoop = clipLoop,
        blendMs = blendMs,
        spriteSize = spriteSize,
        spriteSizeAuthored = sprite && a.containsKey("size"),
        spriteFrames = spriteFrames,
        spriteFrame = spriteFrame,
        spriteFps = if (sprite) readScalar(node, "fps", 0.0, resolve, diag, a) else 0.0,
        spriteLoop = spriteLoop,
        spriteAnchor = spriteAnchor,
        spriteFlip = spriteFlip,
    )
}

// ── the text3d quad law (dsx-scene.md P4, corpus text3d.json) ────────────────────────

/** the glyph height default (scene units) */
const val TEXT3D_DEFAULT_SIZE = 0.5
/** the LAW's fixed per-character advance: width = size × 0.6 × codePointCount */
const val TEXT3D_ADVANCE = 0.6

class Text3dQuad(val center: Vec3, val halfWidth: Double, val halfHeight: Double)

/** the billboard quad's layout: center = position, height = size, width = size · 0.6 ·
 *  codePointCount; an empty value lays out NO quad (null — the node draws nothing).
 *  Characters are Unicode CODE POINTS (the surrogate-pair corpus case). The BILLBOARD
 *  law (the quad always faces the camera) is draw-time behavior, not layout. */
fun text3dQuad(props: SceneNodeProps): Text3dQuad? {
    val characters = props.value.codePointCount(0, props.value.length)
    if (characters == 0) return null
    return Text3dQuad(
        props.position.copyOf(),
        props.text3dSize * TEXT3D_ADVANCE * characters / 2.0,
        props.text3dSize / 2.0,
    )
}

// ── world transforms (the transform-corpus law) ──────────────────────────────────────

/** every node's world matrix: world = parentWorld · (T · Rz · Ry · Rx · S), root down.
 *  Cameras and lights get world matrices too (their position rides the same plane).
 *  `<animate>` nodes are CONTROLLERS, not transforms — skipped entirely (P5).
 *  Identity-keyed (SceneNode has reference equality) and insertion-ordered — document
 *  order, exactly like the TS Map. */
fun worldMatrices(
    nodes: List<SceneNode>, resolve: SceneResolve, diag: SceneDiag? = null,
): LinkedHashMap<SceneNode, Mat4> {
    val out = LinkedHashMap<SceneNode, Mat4>()
    fun walk(list: List<SceneNode>, parent: Mat4) {
        for (node in list) {
            if (node.kind == SceneNodeKind.ANIMATE) continue
            val props = resolvedProps(node, resolve, diag)
            val world = mat4Multiply(parent, mat4Trs(props.position, props.rotation, props.scale))
            out[node] = world
            walk(node.children, world)
        }
    }
    walk(nodes, mat4Identity())
    return out
}

fun findSceneNode(nodes: List<SceneNode>, id: String): SceneNode? {
    for (node in nodes) {
        if (node.id == id) return node
        val inner = findSceneNode(node.children, id)
        if (inner != null) return inner
    }
    return null
}

// ── the camera fold (the projection-corpus law) ──────────────────────────────────────

class SceneCamera(val view: Mat4, val proj: Mat4, val eye: Vec3)

/** the first authored <camera> wins; an unauthored camera uses every default. mode="2d"
 *  projects orthographically (`size` = vertical half-extent); 3d and ar perspective. */
fun sceneCamera(ir: SceneIR, resolve: SceneResolve, aspect: Double, diag: SceneDiag? = null): SceneCamera {
    val node = ir.nodes.firstOrNull { it.kind == SceneNodeKind.CAMERA }
    val position: Vec3; val lookAt: Vec3; val fov: Double; val near: Double; val far: Double; val size2d: Double
    if (node != null) {
        val props = resolvedProps(node, resolve, diag)
        position = props.position; lookAt = props.lookAt
        fov = props.fov; near = props.near; far = props.far; size2d = props.size2d
    } else {
        position = doubleArrayOf(0.0, 0.0, 5.0); lookAt = doubleArrayOf(0.0, 0.0, 0.0)
        fov = 60.0; near = 0.1; far = 1000.0; size2d = 5.0
    }
    val safeAspect = if (aspect.isFinite() && aspect > 0.0) aspect else 1.0
    val view = mat4LookAt(position, lookAt)
    val proj = if (ir.mode == SceneMode.TWO_D) mat4Orthographic(size2d, safeAspect, near, far)
    else mat4Perspective(fov, safeAspect, near, far)
    return SceneCamera(view, proj, position)
}

// ── lights (P1: ambient + one directional; P5 adds point lights + fog) ───────────────

const val POINT_LIGHT_DEFAULT_RANGE = 10.0

/** the point-light cap: the first 4 in document order; a 5th+ drops with one diagnostic */
const val SCENE_MAX_POINT_LIGHTS = 4

class ScenePointLight(
    /** scene-root lights read their authored position as world (the root-light law) */
    val position: Vec3,
    val color: String,
    val intensity: Double,
    val range: Double,
)

class SceneLighting(
    val ambientIntensity: Double,
    val ambientColor: String,
    /** unit direction the directional light shines FROM (its position toward the origin),
     *  null when the scene authors none */
    val direction: Vec3?,
    val directionalIntensity: Double,
    val directionalColor: String,
    /** P5: up to SCENE_MAX_POINT_LIGHTS point lights, document order */
    val points: List<ScenePointLight>,
)

fun sceneLighting(ir: SceneIR, resolve: SceneResolve, diag: SceneDiag? = null): SceneLighting {
    var ambientIntensity = 0.0
    var ambientColor = "#ffffff"
    var direction: Vec3? = null
    var directionalIntensity = 0.0
    var directionalColor = "#ffffff"
    val points = ArrayList<ScenePointLight>()
    var sawAmbient = false
    var droppedPoints = 0
    for (node in ir.nodes) {
        if (node.kind != SceneNodeKind.LIGHT) continue
        val props = resolvedProps(node, resolve, diag)
        if (props.lightKind == "point") {
            if (points.size >= SCENE_MAX_POINT_LIGHTS) { droppedPoints += 1; continue }
            points.add(ScenePointLight(props.position.copyOf(), props.color, props.intensity, props.range))
        } else if (props.lightKind == "directional") {
            if (direction != null) continue // P1: the first directional wins
            val length = vec3Length(props.position)
            direction = if (length == 0.0) doubleArrayOf(0.0, 1.0, 0.0) else doubleArrayOf(
                props.position[0] / length, props.position[1] / length, props.position[2] / length,
            )
            directionalIntensity = props.intensity
            directionalColor = props.color
        } else if (!sawAmbient) {
            sawAmbient = true
            ambientIntensity = props.intensity
            ambientColor = props.color
        }
    }
    if (droppedPoints > 0) {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.LIGHT_CAP,
            "${points.size + droppedPoints} point lights authored — the cap is $SCENE_MAX_POINT_LIGHTS, $droppedPoints dropped",
        ))
    }
    // an unlit scene still shows its shapes: full ambient is the honest default
    if (!sawAmbient && direction == null && points.isEmpty()) ambientIntensity = 1.0
    return SceneLighting(
        ambientIntensity, ambientColor, direction, directionalIntensity, directionalColor, points,
    )
}

// ── the P5 lighting math (corpus lighting.json) ──────────────────────────────────────

/** THE POINT FALLOFF LAW (inverse-square with a smooth range window, pinned):
 *  attenuation(d, range) = window² / (1 + d²) with window = max(0, 1 − (d/range)⁴).
 *  1 at d = 0, exactly 0 at and past `range`. A non-positive range attenuates to 0. */
fun scenePointAttenuation(distance: Double, range: Double): Double {
    if (range <= 0.0) return 0.0
    val ratio = distance / range
    val window = max(0.0, 1.0 - ratio * ratio * ratio * ratio)
    return window * window / (1.0 + distance * distance)
}

/** one resolved point light on the numeric plane (color premultiplied by nothing —
 *  intensity stays explicit so the corpus pins each factor) */
class ScenePointLightResolved(val position: Vec3, val color: Vec3, val intensity: Double, val range: Double)

/** the resolved directional term of the lit fold */
class SceneDirectionalResolved(val dir: Vec3, val color: Vec3)

/** THE LIT-COLOR LAW (the flat-Lambert model all renderers share, extended by P5):
 *  lit = base · (ambient + dirColor·max(0, n·dirL) + Σᵢ colorᵢ·intensityᵢ·att(dᵢ)·max(0, n·Lᵢ))
 *  with Lᵢ = normalize(positionᵢ − point), dᵢ = |positionᵢ − point|; each channel
 *  clamps to [0, 1] at the end (the shader's min(c, 1)). n is normalized here. */
fun sceneLitColor(
    base: Vec3, normal: Vec3, point: Vec3,
    ambient: Vec3,
    directional: SceneDirectionalResolved?,
    points: List<ScenePointLightResolved>,
): Vec3 {
    val nLen = vec3Length(normal)
    val n = if (nLen == 0.0) doubleArrayOf(0.0, 0.0, 0.0)
    else doubleArrayOf(normal[0] / nLen, normal[1] / nLen, normal[2] / nLen)
    val light = doubleArrayOf(ambient[0], ambient[1], ambient[2])
    if (directional != null) {
        val lambert = max(0.0, n[0] * directional.dir[0] + n[1] * directional.dir[1] + n[2] * directional.dir[2])
        for (c in 0 until 3) light[c] += directional.color[c] * lambert
    }
    for (p in points) {
        val tx = p.position[0] - point[0]
        val ty = p.position[1] - point[1]
        val tz = p.position[2] - point[2]
        val distance = sqrt(tx * tx + ty * ty + tz * tz)
        if (distance == 0.0) continue // L is undefined at the light's own position — contributes 0
        val lambert = max(0.0, (n[0] * tx + n[1] * ty + n[2] * tz) / distance)
        val factor = p.intensity * scenePointAttenuation(distance, p.range) * lambert
        for (c in 0 until 3) light[c] += p.color[c] * factor
    }
    return doubleArrayOf(
        kotlin.math.min(1.0, base[0] * light[0]),
        kotlin.math.min(1.0, base[1] * light[1]),
        kotlin.math.min(1.0, base[2] * light[2]),
    )
}

class SceneFog(val color: String, val near: Double, val far: Double)

/** `fog="#color near far"` on `<scene>` — linear fog. Malformed (bad color, non-finite
 *  numbers, far ≤ near) rejects the WHOLE attribute with one diagnostic — never a
 *  half-applied fog. null = no fog authored. */
fun sceneFog(ir: SceneIR, resolve: SceneResolve, diag: SceneDiag? = null): SceneFog? {
    val raw = ir.attrs["fog"] ?: return null
    val resolved = resolve(null, "fog", raw)
    val parts = resolved.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    val color = if (parts.size == 3) parseSceneColor(parts[0]) else null
    val near = if (parts.size == 3) sceneAttrDouble(parts[1]) else null
    val far = if (parts.size == 3) sceneAttrDouble(parts[2]) else null
    if (color == null || near == null || !near.isFinite() || far == null || !far.isFinite() || far <= near) {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_FOG,
            "fog=\"$resolved\" is not \"#color near far\" with far > near — no fog",
        ))
        return null
    }
    return SceneFog(parts[0], near, far)
}

/** THE LINEAR FOG LAW: f = clamp((far − d)/(far − near), 0, 1) for d = the distance
 *  from the EYE to the fragment; final = f·lit + (1 − f)·fogColor (f = 1 unfogged at
 *  and before near, 0 fully fogged at and past far). */
fun sceneFogFactor(distance: Double, near: Double, far: Double): Double =
    kotlin.math.min(kotlin.math.max((far - distance) / (far - near), 0.0), 1.0)

private val HEX_COLOR = Regex("^#([0-9a-f]{3}|[0-9a-f]{6})$", RegexOption.IGNORE_CASE)

/** #rgb/#rrggbb → [r, g, b] in 0..1, or null (the caller diags + falls back) */
fun parseSceneColor(color: String): Vec3? {
    val hex = HEX_COLOR.find(color.trim()) ?: return null
    val body = hex.groupValues[1]
    val wide = if (body.length == 6) body else body.map { "$it$it" }.joinToString("")
    return doubleArrayOf(
        wide.substring(0, 2).toInt(16) / 255.0,
        wide.substring(2, 4).toInt(16) / 255.0,
        wide.substring(4, 6).toInt(16) / 255.0,
    )
}

/** the picking bounding radius in LOCAL units for a geometry node (null = unpickable).
 *  The world-space radius scales by the world matrix's largest basis length. */
fun nodeBoundingRadius(node: SceneNode, props: SceneNodeProps): Double? = when (node.kind) {
    SceneNodeKind.BOX -> sqrt(props.boxSize[0] * props.boxSize[0] + props.boxSize[1] * props.boxSize[1] + props.boxSize[2] * props.boxSize[2]) / 2.0
    SceneNodeKind.SPHERE -> props.radius
    SceneNodeKind.PLANE -> hypot(props.planeSize[0], props.planeSize[1]) / 2.0
    // G6: a sprite picks by its quad's bounding circle (the resolved `size` — the
    // texture-aspect refinement is a render-time detail)
    SceneNodeKind.SPRITE -> hypot(props.spriteSize[0], props.spriteSize[1]) / 2.0
    else -> null
}

class SceneBoundingSphere(val center: Vec3, val radius: Double)

/** world-space bounding sphere: center = world · origin, radius scaled by the largest
 *  world basis column (uniform-enough for v0 picking) */
fun worldBoundingSphere(world: Mat4, localRadius: Double): SceneBoundingSphere {
    val center = doubleArrayOf(world[12], world[13], world[14])
    val scale = max(
        max(
            sqrt(world[0] * world[0] + world[1] * world[1] + world[2] * world[2]),
            sqrt(world[4] * world[4] + world[5] * world[5] + world[6] * world[6]),
        ),
        sqrt(world[8] * world[8] + world[9] * world[9] + world[10] * world[10]),
    )
    return SceneBoundingSphere(center, localRadius * scale)
}

/** on:tap picking v0, shared by the Android and desktop `<scene>` elements (and the
 *  rasterizer tests): unproject the NDC point, nearest bounding-sphere hit among nodes
 *  the filter admits (the element passes "has an on:tap handler"). Mirrors the web
 *  element's click walk (packages/dom/src/scene.ts) so all three surfaces pick alike. */
fun pickSceneNode(
    ir: SceneIR, resolve: SceneResolve, aspect: Double, ndcX: Double, ndcY: Double,
    diag: SceneDiag? = null, filter: (SceneNode) -> Boolean = { true },
): SceneNode? {
    val camera = sceneCamera(ir, resolve, aspect, diag)
    val ray = pickRay(camera.proj, camera.view, ndcX, ndcY) ?: return null
    val worlds = worldMatrices(ir.nodes, resolve, diag)
    var best: SceneNode? = null
    var bestT = Double.MAX_VALUE
    for ((node, world) in worlds) {
        if (!filter(node)) continue
        val props = resolvedProps(node, resolve, diag)
        val localRadius = nodeBoundingRadius(node, props) ?: continue
        val sphere = worldBoundingSphere(world, localRadius)
        val t = raySphere(ray.origin, ray.dir, sphere.center, sphere.radius) ?: continue
        if (t < bestT) { bestT = t; best = node }
    }
    return best
}

/** the tap glue shared by BOTH JVM `<scene>` elements (:render and :desktop): pointer
 *  offset in element pixels → NDC → the nearest node bearing an `on:tap` handler on its
 *  source markup → (action, id payload). Null when the tap hits no handler-bearing node
 *  — the miss is silent, exactly like the web element's click walk. */
fun scenePickAction(
    ir: SceneIR, resolve: SceneResolve, width: Int, height: Int, x: Double, y: Double,
    diag: SceneDiag? = null,
): Pair<String, String>? {
    val hit = scenePickHitNode(ir, resolve, width, height, x, y, diag) ?: return null
    val action = hit.source?.attrs?.get("on:tap") ?: return null
    return action to (hit.id ?: "")
}

/** the node-returning half of [scenePickAction] — the P5 elements use it so a tap on a
 *  BOUND-ROW node can run its handler in the ROW scope (the bind law: on:tap carries
 *  the row item; the reconciler's itemFor(node) supplies the scope) */
fun scenePickHitNode(
    ir: SceneIR, resolve: SceneResolve, width: Int, height: Int, x: Double, y: Double,
    diag: SceneDiag? = null,
): SceneNode? {
    if (width <= 0 || height <= 0) return null
    val ndcX = (x / width) * 2.0 - 1.0
    val ndcY = -((y / height) * 2.0 - 1.0)
    val aspect = width.toDouble() / height.toDouble()
    return pickSceneNode(ir, resolve, aspect, ndcX, ndcY, diag) { node ->
        node.source?.attrs?.get("on:tap")?.isNotBlank() == true
    }
}
