//
//  SceneRegistry.kt — the SceneRegistry seam (dsx-game.md §2 G5): the kernel-side door
//  between mounted `<scene>` ELEMENTS and the `scene` bus MODULE (Core/Scene). The
//  JsTier.engine / SceneAR.provider shape, Kotlin-spelled: elements register a
//  [SceneBusHandle] on mount (keyed by their `id` attr, or the auto key `scene#N`) and
//  unregister on unmount; the module's actions resolve a target by that key (absent =
//  the FIRST mounted scene) and drive the element through the handle — never the other
//  way around. The kernel names no module; an excluded Core/Scene simply leaves this
//  registry unread, and scenes render untouched.
//
//  [SceneBusAdapter] is the ONE shared handle implementation both JVM `<scene>`
//  elements construct (the SceneRaster / SceneAnimator stance: runtime halves the two
//  lanes share live in :core, pure JVM, plain-JVM-tested). The elements contribute only
//  their platform edges: [SceneBusAdapter.rawBase] (the live-store resolver),
//  [SceneBusAdapter.invalidate] (recompose/re-raster) and [SceneBusAdapter.capture]
//  (framebuffer → PNG — javax.imageio on desktop, android.graphics on :render).
//
//  THE WRITE PLANE: `set` lands on a bus-owned BASE overlay underneath the animator's
//  override plane (busBase → rawBase), so SceneAnimator.noteBase sees the change and an
//  authored `transition=` glides it — the P5 plane, never a second mutation path.
//  `camera flyTo` rides SceneAnimator.glide (the P5 transition evaluator, EASE-OUT —
//  the documented choice) while the base holds the destination.
//
//  Events ride the seam too: elements emit `ready` / `collide` through [SceneRegistry.emit];
//  the Core/Scene module subscribes once and re-fires them on the standard bus planes
//  as `scene.ready` / `scene.collide` (modules provide, surfaces consume).
//

package despia.engine.scene

/** one frame of capture evidence — `image` is base64 PNG bytes on the JVM lanes */
class SceneBusCapture(val image: String, val width: Int, val height: Int)

/** one resolved node of the bus-facing tree (props are RESOLVED strings — overrides
 *  applied, the same plane the renderer draws from) */
class SceneBusNode(
    val kind: String,
    val id: String,
    val props: Map<String, String>,
    /** world position [x, y, z] (the corpus world matrix's translation); null for
     *  kinds without a world entry */
    val world: DoubleArray?,
    val children: List<SceneBusNode>,
)

class SceneBusContact(val a: String, val b: String, val depth: Double)

class SceneBusStats(val nodes: Int, val animations: Int, val lastFrameDt: Double, val boundRows: Int)

class SceneBusCameraState(val position: String, val lookAt: String, val fov: Double, val authored: Boolean)

class SceneBusPickHit(val id: String, val kind: String)

/** what a mounted `<scene>` element binds into the registry */
interface SceneBusHandle {
    /** the element's authored `id` attr, or null */
    val sceneId: String?
    fun nodes(): List<SceneBusNode>
    /** "ok" | "node_not_found" | "bad_attr" */
    fun set(id: String, attr: String, value: String): String
    fun camera(): SceneBusCameraState
    /** "ok" | "no_camera" | "bad_value" — flyTo rides the P5 transition path (EASE-OUT) */
    fun cameraSet(position: String?, lookAt: String?, flyTo: String?, durationMs: Double?): String
    /** null = no live framebuffer → the module's typed capture_failed */
    fun capture(): SceneBusCapture?
    /** normalized (x, y) ∈ [0,1] — the pick math of on:tap, WITHOUT firing handlers */
    fun pick(x: Double, y: Double): SceneBusPickHit?
    fun contacts(): List<SceneBusContact>
    fun stats(): SceneBusStats
}

/** the seam. Registration order is mount order; the module resolves absent targets to
 *  the FIRST mounted scene. Synchronized: elements bind on the main thread, bus calls
 *  may arrive elsewhere. */
object SceneRegistry {
    private val lock = Any()
    private val surfaces = LinkedHashMap<String, SceneBusHandle>()
    private val listeners = LinkedHashSet<(scene: String, kind: String, payload: Map<String, Any?>) -> Unit>()
    private var serial = 0

    /** register a mounted scene; returns its key (the id attr, or `scene#N`). A
     *  duplicate id keeps BOTH scenes addressable — the later one takes the auto key. */
    fun register(handle: SceneBusHandle): String = synchronized(lock) {
        serial += 1
        var key = handle.sceneId?.takeIf { it.isNotEmpty() } ?: "scene#$serial"
        if (surfaces.containsKey(key)) key = "scene#$serial"
        surfaces[key] = handle
        key
    }

    fun unregister(key: String) {
        synchronized(lock) { surfaces.remove(key) }
    }

    /** an explicit key, or the FIRST mounted scene when none is named. null =
     *  scene_not_found. */
    fun resolve(scene: String?): SceneBusHandle? = synchronized(lock) {
        if (!scene.isNullOrEmpty()) surfaces[scene]
        else surfaces.values.firstOrNull()
    }

    fun keys(): List<String> = synchronized(lock) { surfaces.keys.toList() }

    /** the module's event subscription (ready/collide → the bus planes). Returns the
     *  unsubscribe function. */
    fun listen(listener: (scene: String, kind: String, payload: Map<String, Any?>) -> Unit): () -> Unit {
        synchronized(lock) { listeners.add(listener) }
        return { synchronized(lock) { listeners.remove(listener) } }
    }

    /** the element-side event door — a listener that throws is skipped (one bad
     *  observer never breaks the element; the delegate-fold stance) */
    fun emit(scene: String, kind: String, payload: Map<String, Any?>) {
        val snapshot = synchronized(lock) { listeners.toList() }
        for (listener in snapshot) {
            runCatching { listener(scene, kind, payload) }
        }
    }

    /** test hygiene only — the JVM suites reset the seam between cases */
    fun clearForTest() {
        synchronized(lock) {
            surfaces.clear()
            listeners.clear()
            serial = 0
        }
    }
}

/** the fly-to duration default (ms) when the caller names none */
const val SCENE_BUS_FLYTO_DEFAULT_MS = 600.0

/**
 * The ONE shared [SceneBusHandle] implementation both JVM `<scene>` elements construct.
 * Pure JVM: every answer folds through the corpus-pinned kernel (resolvedProps ·
 * worldMatrices · sceneCamera · pickRay/raySphere · sceneContacts) with the element's
 * live resolver underneath and the animator's override plane on top.
 */
class SceneBusAdapter(
    private val ir: SceneIR,
    private val animator: SceneAnimator,
    private val reconciler: SceneBindReconciler?,
    private val diag: SceneDiag? = null,
) : SceneBusHandle {

    /** the element's live-store resolver (assigned per composition — item scope moves) */
    var rawBase: SceneResolve = { _, _, raw -> raw }
    /** recompose/re-raster (the element bumps its epoch state) */
    var invalidate: () -> Unit = {}
    /** framebuffer → PNG (element-owned encoder; null answer = capture_failed) */
    var captureFrame: (() -> SceneBusCapture?)? = null
    /** the pick/camera plane's pixel size (the element's live raster size) */
    var viewWidth: Int = 16
    var viewHeight: Int = 9
    /** the stats() honest profiler read — the element stamps each emitted frame tick */
    var lastFrameDt: Double = 0.0
    /** the G2 read plane: the element binds its physics runtime so nodes() exposes
     *  grounded/sleeping/velocity per body (null = not a body) */
    var physicsInfo: (SceneNode) -> ScenePhysicsNodeInfo? = { null }
    /** G6: the element binds its physics runtime's forceWrite here — a bus write of the
     *  SAME base string is still a teleport/impulse command while the solver owns the
     *  rendered value (the base cache holds the SPAWN string) */
    var forcePhysicsWrite: (SceneNode, String) -> Unit = { _, _ -> }

    override val sceneId: String? get() = ir.attrs["id"]

    /** the bus-owned BASE overlay: consulted before the element's raw resolver, so a
     *  bus write IS a base change (noteBase retargets authored transitions from it) */
    private val busBase = HashMap<SceneNode, HashMap<String, String>>()

    /** the BASE plane the element must resolve/attach/noteBase with */
    val resolveBase: SceneResolve = { node, name, raw ->
        (if (node != null) busBase[node]?.get(name) else null) ?: rawBase(node, name, raw)
    }

    /** an unmounted row node's bus writes die with it (SceneBindReconciler.onDrop) —
     *  a retained entry is a leak that strongly holds the dead SceneNode */
    fun dropNode(node: SceneNode) { busBase.remove(node) }

    /** the RENDER plane (overrides first) — what the bus reads back */
    private val resolve: SceneResolve get() = animator.resolve(resolveBase)

    override fun nodes(): List<SceneBusNode> {
        val r = resolve
        val worlds = worldMatrices(ir.nodes, r, diag)
        fun toBus(list: List<SceneNode>): List<SceneBusNode> =
            list.filter { it.kind != SceneNodeKind.ANIMATE }.map { node ->
                val p = resolvedProps(node, r, diag)
                val props = LinkedHashMap<String, String>()
                props["position"] = formatSceneAnimValue("position", p.position)
                props["rotation"] = formatSceneAnimValue("rotation", p.rotation)
                props["scale"] = formatSceneAnimValue("scale", p.scale)
                props["color"] = p.color
                for ((name, raw) in node.attrs) {
                    if (name.startsWith("on:") || name == "id" || name == "__css") continue
                    props[name] = r(node, name, raw)
                }
                // G2: a physics body's solver state rides the read (grounded exposed here)
                physicsInfo(node)?.let { info ->
                    props["grounded"] = info.grounded.toString()
                    props["sleeping"] = info.sleeping.toString()
                    props["velocity"] = formatSceneAnimValue("position", info.velocity)
                }
                val world = worlds[node]
                SceneBusNode(
                    kind = node.kind.tag, id = node.id ?: "", props = props,
                    world = world?.let { doubleArrayOf(it[12], it[13], it[14]) },
                    children = toBus(node.children),
                )
            }
        return toBus(ir.nodes)
    }

    /** a bus write lands on the BASE plane (busBase → noteBase retargets authored
     *  transitions — the P5 glide), then invalidates the element */
    private fun writeBase(node: SceneNode, name: String, value: String) {
        busBase.getOrPut(node) { HashMap() }[name] = value
        if (name == "position" || name == "velocity") forcePhysicsWrite(node, name)
        animator.noteBase(resolveBase)
        invalidate()
    }

    override fun set(id: String, attr: String, value: String): String {
        if (attr.startsWith("on:") || attr == "id" || attr == "__css") return "bad_attr"
        val node = findSceneNode(ir.nodes, id) ?: return "node_not_found"
        writeBase(node, attr, value)
        return "ok"
    }

    private fun cameraNode(): SceneNode? = ir.nodes.firstOrNull { it.kind == SceneNodeKind.CAMERA }

    override fun camera(): SceneBusCameraState {
        val node = cameraNode() ?: return SceneBusCameraState("0 0 5", "0 0 0", 60.0, authored = false)
        val p = resolvedProps(node, resolve, diag)
        return SceneBusCameraState(
            formatSceneAnimValue("position", p.position),
            formatSceneAnimValue("position", p.lookAt),
            p.fov, authored = true,
        )
    }

    override fun cameraSet(position: String?, lookAt: String?, flyTo: String?, durationMs: Double?): String {
        val node = cameraNode() ?: return "no_camera"
        if (lookAt != null) {
            val parsed = parseSceneAnimValue("position", lookAt) ?: return "bad_value"
            if (parsed.size < 3) return "bad_value"
            writeBase(node, "look-at", formatSceneAnimValue("position", parsed))
        }
        if (position != null) {
            val parsed = parseSceneAnimValue("position", position) ?: return "bad_value"
            if (parsed.size < 3) return "bad_value"
            writeBase(node, "position", formatSceneAnimValue("position", parsed))
        }
        if (flyTo != null) {
            val to = parseSceneAnimValue("position", flyTo) ?: return "bad_value"
            if (to.size < 3) return "bad_value"
            // the P5 transition path, EASE-OUT (the documented choice): glide from the
            // CURRENT RENDERED position (never snap); the base holds the destination
            val from = resolvedProps(node, resolve, diag).position.copyOf()
            val ms = if (durationMs != null && durationMs > 0) durationMs else SCENE_BUS_FLYTO_DEFAULT_MS
            animator.glide(node, "position", from, to, ms, parseSceneEasing("ease-out"))
            busBase.getOrPut(node) { HashMap() }["position"] = formatSceneAnimValue("position", to)
            invalidate()
        }
        return "ok"
    }

    override fun capture(): SceneBusCapture? = captureFrame?.invoke()

    override fun pick(x: Double, y: Double): SceneBusPickHit? {
        val r = resolve
        val aspect = viewWidth.coerceAtLeast(1).toDouble() / viewHeight.coerceAtLeast(1).toDouble()
        val camera = sceneCamera(ir, r, aspect, diag)
        val ray = pickRay(camera.proj, camera.view, x * 2.0 - 1.0, -(y * 2.0 - 1.0)) ?: return null
        var best: SceneNode? = null
        var bestT = Double.MAX_VALUE
        for ((node, world) in worldMatrices(ir.nodes, r, diag)) {
            val props = resolvedProps(node, r, diag)
            val localRadius = nodeBoundingRadius(node, props) ?: continue
            val sphere = worldBoundingSphere(world, localRadius)
            val t = raySphere(ray.origin, ray.dir, sphere.center, sphere.radius) ?: continue
            if (t < bestT) { bestT = t; best = node }
        }
        return best?.let { SceneBusPickHit(it.id ?: "", it.kind.tag) }
    }

    override fun contacts(): List<SceneBusContact> {
        val r = resolve
        val shapes = ArrayList<SceneColliderShape>()
        val authoredIds = HashMap<String, String>()
        var serial = 0
        for ((node, world) in worldMatrices(ir.nodes, r, diag)) {
            val props = resolvedProps(node, r, diag)
            if (props.collide.isEmpty()) continue
            serial += 1
            val tid = "c$serial"
            val shape = sceneColliderFor(node, props, world, tid) ?: continue
            shapes.add(shape)
            authoredIds[tid] = node.id ?: ""
        }
        return sceneContacts(shapes).map {
            SceneBusContact(authoredIds[it.a] ?: "", authoredIds[it.b] ?: "", it.depth)
        }
    }

    override fun stats(): SceneBusStats {
        fun count(list: List<SceneNode>): Int =
            list.sumOf { if (it.kind == SceneNodeKind.ANIMATE) 0 else 1 + count(it.children) }
        return SceneBusStats(
            nodes = count(ir.nodes),
            animations = animator.activeAnimationCount(resolveBase),
            lastFrameDt = lastFrameDt,
            boundRows = reconciler?.rowCount() ?: 0,
        )
    }
}
