//
//  SceneElements.kt — `<scene>` (dsx-scene.md P2): the DSX-native 3D/2D engine's Android
//  surface. Every NUMBER lives in the corpus-pinned :core kernel (despia.engine.scene —
//  SceneMath/SceneIR, corpus OpenSource/Conformance/scene/), and the PIXELS come from the
//  ONE shared software rasterizer (SceneRaster.kt) the desktop `<scene>` paints too — the
//  two JVM lanes are 1:1 by construction, zero new dependencies, CI-pixel-tested
//  (SceneRasterTest). This file owns only the Compose adapter:
//
//    • the framebuffer → android.graphics.Bitmap → Canvas paint (raster resolution capped
//      at 640 on the long edge; the draw scales — scenes are small, software raster is
//      O(pixels), and the corpus pins math, not device pixels);
//    • reactive re-rasterization: the element subscribes to the store flows directly
//      (`varsFlow.collectAsState()`, the standalone-node precedent in StackNodeView) —
//      child-node holes (`rotation="0 {{ dsx.variable.spin }} 0"`) never pass through the
//      scene root's own resolvedAttrs, so the root-bundle invalidation cannot be relied
//      on. The resolved-attribute SNAPSHOT is the remember key: a write that changes any
//      authored value re-rasterizes, an unrelated write re-composes but re-draws nothing.
//    • on:tap picking v0 through the kernel's shared pickSceneNode (pickRay/raySphere vs
//      world bounding spheres — the exact web-element walk), handlers through the normal
//      runner path (`env.run`, payload `id`);
//    • P4 assets through the :core SceneAssets seam: `texture="url"` and `<model src>`
//      bytes ride the CONTENT PLANE (DSXContent cached-then-fresh — the dsx-scene.md §2
//      asset law), decoded here with android.graphics (BitmapFactory) off the main
//      thread, cached per element, re-rasterizing on arrival; text3d values rasterize
//      through android.graphics Paint/Canvas (WHITE glyphs, the node color modulates);
//    • on:frame (P4) + ANIMATIONS (P5): ONE withFrameNanos loop that exists ONLY while
//      an on:frame handler is authored OR at least one animation/transition is active
//      (the zero-cost static law; LaunchedEffect cancellation IS the unmount law), the
//      :core SceneFrameClock applying the 60/s budget to handler dispatch AND animation
//      advance, the { dt, elapsed, frame } payload through the same runner path as
//      on:tap. The animation state machine is the :core SceneAnimator (shared with the
//      desktop element — the SceneRaster stance): implicit `transition=` retargets +
//      explicit `<animate>` tweens override at the RESOLVED-ATTRIBUTE plane, so the
//      corpus-pinned kernel folds stay untouched; on:done rides the runner path;
//    • BOUND GROUPS (P5): `<group bind key>` through the :core SceneBindReconciler —
//      keyed rows with surviving node identity, row-scoped `item.*` resolution (the
//      resolver consults itemFor(node)), nested binds, removal stops row animations;
//    • COLLISIONS (P5): the :core SceneCollisionPass rides each rendered frame (a
//      LaunchedEffect keyed on the same raster keys — never its own loop) while any
//      on:collide is authored, payload {id, other, depth} both directions on enter;
//    • ORBIT (P5): `controls="orbit"` on <camera> — touch drag through the kernel
//      orbit math (0.4°/px, pitch ±89°), written through the same override plane
//      (pinch-zoom is the desktop scroll's named follow-up on this surface);
//    • PHYSICS (G2): the fixed-tick accumulator joins the SAME loop (the :core
//      ScenePhysicsRuntime — every NUMBER in ScenePhysics.kt, corpus physics.json): the
//      loop also exists while any dynamic body is awake or a character exists, and a
//      fully-asleep world stops it; solver-owned positions ride the animator override
//      plane INTERPOLATED; base position/velocity writes (store OR bus set) are the
//      teleport / impulse verbs (noteBase scans them each composition);
//      on:tick/on:collision/on:enter/on:exit dispatch through the runner path;
//      grounded/sleeping/velocity ride the bus nodes() read;
//    • the honest labelled placeholder for the P3 rows (mode="ar", <anchor>) INSIDE the
//      scene box — never blank, never fake (model/text3d render for real since P4);
//    • Article-7 diagnostics: fall back + say so ONCE per distinct message per element
//      (kernelLog — the dev channel; SceneKit/Filament stay the named upgrades).
//
//  Registered by InputElements.register() (the wave aggregator) via defineNative, so a
//  module setup() that defines `scene` later still wins, exactly like iOS launch ordering.
//

package despia.engine.render.elements

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.foundation.focusable
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.nativeKeyCode
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.runtime.DisposableEffect
import despia.engine.input.DsxInputRuntime
import despia.engine.input.androidKeyToCanonical
import despia.engine.input.androidPadButtonToCanonical
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import despia.engine.DSX
import despia.engine.DSXContent
import despia.engine.JSE
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.kernelLog
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import androidx.compose.foundation.gestures.detectDragGestures
import despia.engine.scene.GlbModel
import despia.engine.scene.SceneAnimator
import despia.engine.scene.SceneAssets
import despia.engine.scene.SceneBindReconciler
import despia.engine.scene.SceneBusAdapter
import despia.engine.scene.SceneBusCapture
import despia.engine.scene.SceneClipMixers
import despia.engine.scene.SceneCollisionPass
import despia.engine.scene.SceneRegistry
import despia.engine.scene.SceneDiag
import despia.engine.scene.SceneFrameClock
import despia.engine.scene.SceneIR
import despia.engine.scene.SceneMode
import despia.engine.scene.SceneNode
import despia.engine.scene.SceneNodeKind
import despia.engine.scene.ScenePhysicsPairEvent
import despia.engine.scene.ScenePhysicsRuntime
import despia.engine.scene.ScenePrefabDef
import despia.engine.scene.ScenePrefabItems
import despia.engine.scene.ScenePrefabLookup
import despia.engine.scene.SceneResolve
import despia.engine.scene.scenePrefabDefFromTemplate
import despia.engine.scene.GlbPose
import despia.engine.scene.SceneTexture
import despia.engine.scene.formatSceneAnimValue
import despia.engine.scene.sceneModelHalfExtents
import despia.engine.scene.orbitDrag
import despia.engine.scene.orbitFromCamera
import despia.engine.scene.orbitPosition
import despia.engine.scene.parseGlb
import despia.engine.scene.parseScene
import despia.engine.scene.rasterizeScene
import despia.engine.scene.resolvedProps
import despia.engine.scene.sceneAnyCollideHandler
import despia.engine.scene.scenePickHitNode
import despia.engine.varsFlow
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal fun registerSceneElements() {
    ComposeStackComponents.defineNative("scene") { ctx -> SceneElementView(ctx) }
}

/** the long-edge cap for the software raster buffer (the draw scales the Bitmap up) */
internal const val SCENE_RASTER_MAX_EDGE = 640

// ── the pure halves (plain-JVM tested — SceneElementsTest.kt) ────────────────────────

/** the live-store resolver: JSE holes interpolate through the SAME evaluator every other
 *  attribute uses — the corpus's vars-map resolver with the store playing the map */
internal fun sceneResolver(store: StackStore, item: Map<String, Any?>?): SceneResolve =
    { _, _, raw -> JSE.interpolate(raw, store, item) }

/** the reactive re-raster key: every authored attribute (root + all nodes, document
 *  order) resolved to its current value. Handlers/ids are excluded — they never change
 *  pixels. Equal key = equal frame (rasterizeScene is deterministic — SceneRasterTest). */
internal fun sceneResolvedKey(ir: SceneIR, resolve: SceneResolve): String {
    val out = StringBuilder()
    fun addAttrs(node: SceneNode?, attrs: Map<String, String>) {
        for ((name, raw) in attrs) {
            if (name.startsWith("on:") || name == "id" || name == "__css") continue
            out.append(name).append('=').append(resolve(node, name, raw)).append('\u001F')
        }
        out.append('\u001E')
    }
    addAttrs(null, ir.attrs)
    fun walk(nodes: List<SceneNode>) {
        for (node in nodes) { addAttrs(node, node.attrs); walk(node.children) }
    }
    walk(ir.nodes)
    return out.toString()
}

/** the scheduled-row placeholder text (dsx-scene.md P3) — empty when nothing is
 *  scheduled; the web element's `.dsx-scene-scheduled` notice, worded identically.
 *  model/text3d left this list when P4 landed — they render for real now. */
internal fun sceneScheduledNotice(ir: SceneIR): String {
    val scheduled = LinkedHashSet<String>()
    if (ir.mode == SceneMode.AR) scheduled.add("mode=\"ar\" (P3)")
    fun walk(nodes: List<SceneNode>) {
        for (node in nodes) {
            if (node.kind == SceneNodeKind.ANCHOR) scheduled.add("<anchor> (P3)")
            walk(node.children)
        }
    }
    walk(ir.nodes)
    return if (scheduled.isEmpty()) "" else "Scheduled per dsx-scene.md: ${scheduled.joinToString(" · ")}"
}

/** raster-buffer size: the composed pixel size capped at [SCENE_RASTER_MAX_EDGE] on the
 *  long edge, aspect preserved, floored at 1×1 */
internal fun sceneRasterSize(width: Int, height: Int): IntSize {
    val w = max(1, width); val h = max(1, height)
    val long = max(w, h)
    if (long <= SCENE_RASTER_MAX_EDGE) return IntSize(w, h)
    val scale = SCENE_RASTER_MAX_EDGE.toDouble() / long
    return IntSize(max(1, (w * scale).roundToInt()), max(1, (h * scale).roundToInt()))
}

// ── the P4 asset seam (android.graphics decode + content-plane bytes) ────────────────

/** decoded ARGB pixels from encoded image bytes (BitmapFactory — the image element's
 *  decoder family), null when the bytes are not an image */
internal fun decodeSceneTexture(bytes: ByteArray): SceneTexture? = runCatching {
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return@runCatching null
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    SceneTexture(pixels, bitmap.width, bitmap.height)
}.getOrNull()

/** the text3d glyph raster: WHITE glyphs on transparency (the node color modulates),
 *  android.graphics Paint/Canvas — the platform text stack, per the corpus README's
 *  honest scope line (glyph pixels are deliberately unpinned) */
internal fun rasterizeAndroidText(value: String, widthPx: Int, heightPx: Int): SceneTexture? = runCatching {
    val bitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(bitmap)
    val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.WHITE
        textSize = heightPx * 0.78f
        textAlign = android.graphics.Paint.Align.CENTER
    }
    val measured = paint.measureText(value)
    if (measured > widthPx && measured > 0f) paint.textSize = paint.textSize * widthPx / measured
    val baseline = heightPx / 2f - (paint.descent() + paint.ascent()) / 2f
    canvas.drawText(value, widthPx / 2f, baseline, paint)
    val pixels = IntArray(widthPx * heightPx)
    bitmap.getPixels(pixels, 0, widthPx, 0, 0, widthPx, heightPx)
    SceneTexture(pixels, widthPx, heightPx)
}.getOrNull()

/** the SceneAssets seam for the Android element: texture/model BYTES ride the content
 *  plane (DSXContent cached-then-fresh — the dsx-scene.md §2 asset law), decoded off the
 *  main thread; a finished load bumps [invalidate] so the element re-rasterizes. Text
 *  rasters are synchronous and cached. Absent/failed assets answer null — nothing draws,
 *  nothing crashes (Article 7). */
internal class AndroidSceneAssets(
    private val scope: CoroutineScope,
    private val invalidate: () -> Unit,
) : SceneAssets {
    private val textures = HashMap<String, SceneTexture?>()
    private val models = HashMap<String, GlbModel?>()
    private val texts = HashMap<String, SceneTexture?>()
    private val pending = HashSet<String>()

    /** G3: the element's SceneClipMixers answers through this hook (null = static) */
    var poseFor: ((SceneNode) -> GlbPose?)? = null

    override fun pose(node: SceneNode): GlbPose? = poseFor?.invoke(node)

    private fun <T> fetch(key: String, url: String, decode: (ByteArray) -> T?, store: (T?) -> Unit) {
        if (!pending.add(key)) return
        scope.launch(Dispatchers.IO) {
            val decoded = runCatching {
                (DSXContent.cachedFile(url) ?: DSXContent.freshFile(url))?.let(decode)
            }.getOrNull()
            withContext(Dispatchers.Main) {
                store(decoded)
                invalidate()
            }
        }
    }

    override fun texture(url: String): SceneTexture? {
        if (textures.containsKey(url)) return textures[url]
        val validated = MediaInputPolicy.validatedHttpURL(url)
        if (validated == null) { textures[url] = null; return null }
        fetch("texture:$url", validated, ::decodeSceneTexture) { textures[url] = it }
        return null
    }

    override fun model(src: String): GlbModel? {
        if (models.containsKey(src)) return models[src]
        val validated = MediaInputPolicy.validatedHttpURL(src)
        if (validated == null) { models[src] = null; return null }
        fetch("model:$src", validated, { bytes -> parseGlb(bytes).model }) { models[src] = it }
        return null
    }

    override fun text(value: String, widthPx: Int, heightPx: Int): SceneTexture? =
        texts.getOrPut("$widthPx×$heightPx:$value") { rasterizeAndroidText(value, widthPx, heightPx) }
}

// ── the Compose adapter ──────────────────────────────────────────────────────────────

/** ARGB IntArray → PNG bytes through android.graphics (the platform encoder) — the
 *  scene bus `capture` encoder (dsx-game.md G5). Null only when compress refuses. */
internal fun androidScenePng(pixels: IntArray, width: Int, height: Int): ByteArray? = runCatching {
    val bitmap = Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
    val out = java.io.ByteArrayOutputStream()
    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) return@runCatching null
    out.toByteArray()
}.getOrNull()

/** the per-element P5 runtime bundle — parsed once per node, shared by every closure */
private class SceneRuntime(
    val ir: SceneIR,
    val animator: SceneAnimator,
    val reconciler: SceneBindReconciler,
    val collisions: SceneCollisionPass,
    /** the G5 bus handle (:core SceneBusAdapter) this element registers on mount */
    val bus: SceneBusAdapter,
    /** the G2 fixed-tick solver runtime (:core ScenePhysicsRuntime — the shared fold) */
    val physics: ScenePhysicsRuntime,
    /** the G3 clip mixers (:core SceneClipMixers — one per `<model animation>` node) */
    val mixers: SceneClipMixers,
    /** the G1 prefab item plane (:core ScenePrefabItems — per-instance scopes) */
    val prefabItems: ScenePrefabItems,
) {
    /** the LIVE item scope a node resolves/handles in: the innermost of its prefab
     *  instance scope and its bound-row scope (the G1 item-plane law) */
    fun itemFor(node: SceneNode, surface: Map<String, Any?>?): Map<String, Any?>? =
        prefabItems.itemFor(node, { reconciler.itemFor(it) }, surface)
}

@Composable
private fun SceneElementView(ctx: ComposeStackComponentContext) {
    val node: StackNode = ctx.node ?: return

    // the standalone-node subscription (StackNodeView's safe local path): child-node holes
    // resolve OUTSIDE the root attr bundle, so this element observes the stores itself
    ctx.store.varsFlow.collectAsState().value
    DSX.state.varsFlow.collectAsState().value

    // Article 7: fall back + say so ONCE per distinct message per element instance
    val reported = remember(node) { HashSet<String>() }
    val diag: SceneDiag = remember(node) {
        { d -> if (reported.add(d.message)) kernelLog("[dsx scene]", d.message) }
    }
    // parse + P5 runtime, once per node: the reconciler captures `<group bind>` templates
    // FIRST (template children leave the static tree), then the animator registers the
    // remaining <animate>/transition= carriers. Bound rows attach/detach as they spawn.
    val runtime = remember(node) {
        // G1 prefabs: component tags inside the scene expand through the EXISTING
        // component registry (ComposeStackComponents — the same resolution the
        // component() dispatch uses); the kernel only sees the lookup seam (rule 18).
        // Per-scope lookups: a component's BODY resolves nested tags where the
        // component was DECLARED (its owning scope) — the defining-scope law
        val prefabDefs = HashMap<String?, HashMap<String, ScenePrefabDef?>>()
        fun prefabLookupFor(scope: String?): ScenePrefabLookup = fun(tag: String): ScenePrefabDef? {
            val scoped = prefabDefs.getOrPut(scope) { HashMap() }
            if (scoped.containsKey(tag)) return scoped[tag]
            val def = ComposeStackComponents.resolve(tag, scope)?.let { (template, owningScope) ->
                val derived = scenePrefabDefFromTemplate(template)
                ScenePrefabDef(derived.params, derived.roots, prefabLookupFor(owningScope))
            }
            scoped[tag] = def
            return def
        }
        val prefabs: ScenePrefabLookup = prefabLookupFor(ctx.env.scope)
        val ir = parseScene(node, diag, prefabs)
        val animator = SceneAnimator(diag)
        val prefabItems = ScenePrefabItems { raw, item -> JSE.interpolate(raw, ctx.store, item) }
        val reconciler = SceneBindReconciler(
            evalBind = { expr, item -> JSE.eval(expr, ctx.store, item) },
            animator = animator, diag = diag, prefabItems = prefabItems,
        )
        prefabItems.stamp(ir.nodes)
        reconciler.register(ir.nodes, ctx.item)
        // the G5 bus adapter LAYERS its base overlay under the live-store resolver, so
        // a bus `set` IS a base change (noteBase retargets authored transitions) —
        // attach/noteBase/resolve all speak bus.resolveBase from here on
        val bus = SceneBusAdapter(ir, animator, reconciler, diag)
        reconciler.onDrop = { bus.dropNode(it) }   // despawned rows drop their bus writes
        val runtime = SceneRuntime(
            ir, animator, reconciler, SceneCollisionPass(), bus,
            ScenePhysicsRuntime(ir, animator, diag), SceneClipMixers(diag), prefabItems,
        )
        bus.rawBase = { n, _, raw ->
            JSE.interpolate(raw, ctx.store, n?.let { runtime.itemFor(it, ctx.item) } ?: ctx.item)
        }
        animator.attach(ir.nodes, null, bus.resolveBase)
        // G2: the fixed-tick solver rides the same animator override plane (solver-owned
        // positions are interpolated overrides); the bus read exposes its body state
        bus.physicsInfo = { n -> runtime.physics.info(n) }
        bus.forcePhysicsWrite = { n, attr -> runtime.physics.forceWrite(n, attr) }
        runtime
    }
    val ir = runtime.ir
    // the base plane (what animations retarget toward) + the override plane on top —
    // row/prefab-scoped (a bound-row node resolves item.* against ITS row; a prefab
    // body resolves its instance scope — G1), with the bus's base overlay underneath
    // (a module `scene.set` writes it)
    runtime.bus.rawBase = { n, _, raw ->
        JSE.interpolate(raw, ctx.store, n?.let { runtime.itemFor(it, ctx.item) } ?: ctx.item)
    }
    val resolveBase: SceneResolve = runtime.bus.resolveBase
    val resolve: SceneResolve = runtime.animator.resolve(resolveBase)

    // P5 per composition: reconcile bound groups against the live store (the noteBase
    // pair runs below, once the asset seam has bound the model-collider hook)
    var animEpoch by remember(node) { mutableStateOf(0) }
    runtime.reconciler.reconcile(resolveBase)

    // fill-width 16:9 is the unstyled default (the web `.dsx-scene` box); an authored
    // width/height rides the universal style chain in elementModifier instead
    val hasAuthoredSize = ctx.attrs.containsKey("width") || ctx.attrs.containsKey("height")
    val sizeDefault = if (hasAuthoredSize) Modifier else Modifier.fillMaxWidth().aspectRatio(16f / 9f)

    var sizePx by remember(node) { mutableStateOf(IntSize.Zero) }
    // P4 assets: loads bump assetEpoch, which keys the raster remember — arrival redraws
    var assetEpoch by remember(node) { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    val assets = remember(node) { AndroidSceneAssets(scope) { assetEpoch += 1 } }
    // G2: a loaded model's collider bounds ([0.5 0.5 0.5] until known — arrival bumps
    // assetEpoch, the recomposition re-extracts and the collider re-freezes)
    runtime.physics.modelHalf = { n ->
        resolvedProps(n, resolveBase, diag).src.takeIf { it.isNotEmpty() }
            ?.let { src -> assets.model(src)?.let { sceneModelHalfExtents(it) } }
    }
    // G2 write laws FIRST (a base position write on a dynamic/character body TELEPORTS
    // — it must never turn into a retarget glide), then the P5 retarget detector
    runtime.physics.noteBase(resolveBase)
    runtime.animator.noteBase(resolveBase)

    // ── the G5 bus registration: the SceneRegistry seam (the module drives this
    // element through the adapter); the platform edges rebind per composition
    runtime.bus.invalidate = { animEpoch += 1 }
    runtime.bus.captureFrame = {
        val raster = if (sizePx.width > 0 && sizePx.height > 0)
            sceneRasterSize(sizePx.width, sizePx.height) else IntSize(320, 180)
        val pixels = rasterizeScene(ir, resolve, raster.width, raster.height, assets, diag)
        androidScenePng(pixels, raster.width, raster.height)?.let { png ->
            SceneBusCapture(android.util.Base64.encodeToString(png, android.util.Base64.NO_WRAP), raster.width, raster.height)
        }
    }
    if (sizePx.width > 0 && sizePx.height > 0) {
        runtime.bus.viewWidth = sizePx.width
        runtime.bus.viewHeight = sizePx.height
    }
    var busKey by remember(node) { mutableStateOf<String?>(null) }
    DisposableEffect(node) {
        val key = SceneRegistry.register(runtime.bus)
        busKey = key
        // the bus event door — ready at mount (the JVM twin of the web first-draw
        // emission; the module re-fires it as scene.ready)
        SceneRegistry.emit(key, "ready", mapOf("scene" to key))
        onDispose { SceneRegistry.unregister(key) }
    }

    // G3: the clip mixers answer the SceneAssets.pose seam; they ADVANCE inside the
    // raster path below (asset arrival re-rasters, and each loop tick bumps animEpoch),
    // on the monotonic JVM clock — never a second frame loop
    assets.poseFor = { n -> runtime.mixers.pose(n) }

    val resolvedKey = sceneResolvedKey(ir, resolve)
    val frame: ImageBitmap? = remember(node, resolvedKey, sizePx, assetEpoch, animEpoch) {
        if (sizePx.width <= 0 || sizePx.height <= 0) null
        else {
            runtime.mixers.advance(ir, resolveBase, { src -> assets.model(src) }, System.nanoTime() / 1e6)
            val raster = sceneRasterSize(sizePx.width, sizePx.height)
            val pixels = rasterizeScene(ir, resolve, raster.width, raster.height, assets, diag)
            Bitmap.createBitmap(pixels, raster.width, raster.height, Bitmap.Config.ARGB_8888)
                .asImageBitmap()
        }
    }

    // P5 orbit: `controls="orbit"` on the camera — touch drags fold through the kernel
    // orbit math into a camera-position override (the same plane animations ride)
    val cameraNode: SceneNode? = remember(node) { ir.nodes.firstOrNull { it.kind == SceneNodeKind.CAMERA } }

    // ── G4 unified input (dsx-game.md §2): `on:input.<name>` on this <scene> subscribes to
    // the declared binding's press EDGE and dispatches through the ordinary runner path.
    // The DECLARATIONS registered from the head (StackNodeView); this is the CONSUMER half.
    val inputHandlers = remember(node) {
        ctx.attrs.entries
            .filter { it.key.startsWith("on:input.") && it.value.isNotBlank() }
            .associate { it.key.removePrefix("on:input.") to it.value }
    }
    if (inputHandlers.isNotEmpty()) {
        DisposableEffect(node, inputHandlers) {
            val token = Any()
            for ((name, action) in inputHandlers) {
                DsxInputRuntime.subscribe(name, token) { event ->
                    ctx.env.run(action, ctx.item,
                        mapOf("name" to event.name, "x" to event.x, "y" to event.y))
                }
            }
            onDispose { for (name in inputHandlers.keys) DsxInputRuntime.unsubscribe(name, token) }
        }
    }
    // Hardware keys and gamepad BUTTONS arrive as Compose key events once the scene holds
    // focus; each one folds through the shared machine and commits on the spot (the edge
    // law is the machine's, never this lane's). ANALOG STICKS are the named Android
    // absence — joystick axes ride MotionEvent, which Compose does not surface here.
    val focusRequester = remember(node) { FocusRequester() }
    LaunchedEffect(node) { runCatching { focusRequester.requestFocus() } }

    Box(
        Modifier
            .elementModifier(ctx)
            .then(sizeDefault)
            .focusRequester(focusRequester)
            .focusable()
            .onKeyEvent { event ->
                val code = event.key.nativeKeyCode
                val word = androidPadButtonToCanonical(code)?.let { pad ->
                    // a pad button is not a KEY — feed it as a one-button snapshot
                    val index = despia.engine.input.SceneInput.PAD_BUTTONS[pad] ?: return@let null
                    val buttons = MutableList(16) { 0.0 }
                    if (event.type == KeyEventType.KeyDown) buttons[index] = 1.0
                    DsxInputRuntime.gamepad(despia.engine.input.InputPadSnapshot(buttons, emptyList()))
                    DsxInputRuntime.commit()
                    pad
                }
                if (word != null) return@onKeyEvent true
                val key = androidKeyToCanonical(code, null) ?: return@onKeyEvent false
                when (event.type) {
                    KeyEventType.KeyDown -> DsxInputRuntime.keyDown(key)
                    KeyEventType.KeyUp -> DsxInputRuntime.keyUp(key)
                    else -> return@onKeyEvent false
                }
                DsxInputRuntime.commit()
                true
            }
            .onSizeChanged { if (it != sizePx) sizePx = it }
            .pointerInput(node) {
                detectTapGestures { offset ->
                    // a drag never reaches here (the tap detector cancels past slop) —
                    // the drag-suppresses-pick law holds by construction
                    val hit = scenePickHitNode(
                        ir, resolve, size.width, size.height, offset.x.toDouble(), offset.y.toDouble(),
                    ) ?: return@detectTapGestures
                    val action = hit.source?.attrs?.get("on:tap") ?: return@detectTapGestures
                    // a bound-row node's handler runs in the ROW scope (the bind law)
                    ctx.env.run(action, runtime.itemFor(hit, ctx.item),
                        mapOf("id" to (hit.id ?: "")))
                }
            }
            .pointerInput(node) {
                detectDragGestures { change, dragAmount ->
                    val cam = cameraNode ?: return@detectDragGestures
                    if (resolvedProps(cam, resolveBase, diag).controls != "orbit") return@detectDragGestures
                    change.consume()
                    val props = resolvedProps(cam, resolve, diag)
                    val state = orbitDrag(
                        orbitFromCamera(props.position, props.lookAt),
                        (dragAmount.x / density).toDouble(), (dragAmount.y / density).toDouble(),
                    )
                    runtime.animator.setOverride(
                        cam, "position", formatSceneAnimValue("position", orbitPosition(state, props.lookAt)),
                    )
                    animEpoch += 1
                }
            },
        contentAlignment = Alignment.BottomStart,
    ) {
        frame?.let { image ->
            Canvas(Modifier.matchParentSize()) {
                drawImage(
                    image,
                    dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()),
                )
            }
        }
        val notice = sceneScheduledNotice(ir)
        if (notice.isNotEmpty()) {
            // the honest scheduled placeholder INSIDE the scene box (never blank, never fake)
            androidx.compose.material3.Text(
                text = notice,
                fontSize = 11.sp,
                color = androidx.compose.material3.MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            )
        }
    }

    // on:ready — after the first composition, the web element's post-first-draw event
    ctx.attrs["on:ready"]?.takeIf { it.isNotBlank() }?.let { action ->
        LaunchedEffect(node) { ctx.env.run(action, ctx.item) }
    }

    // P5 collisions: the pass RIDES the render (keyed on the same raster keys — never
    // its own loop) and only while an on:collide handler is authored; enter events
    // dispatch both directions through the ordinary runner path, in the row scope
    if (sceneAnyCollideHandler(ir.nodes)) {
        LaunchedEffect(node, resolvedKey, animEpoch, assetEpoch) {
            for (hit in runtime.collisions.step(ir, resolve, diag)) {
                val payload = mapOf(
                    "id" to (hit.node.id ?: ""), "other" to (hit.otherNode?.id ?: ""), "depth" to hit.depth,
                )
                // the bus event door — the module re-fires this as scene.collide
                busKey?.let { SceneRegistry.emit(it, "collide", mapOf("scene" to it) + payload) }
                val action = hit.node.source?.attrs?.get("on:collide")?.takeIf { it.isNotBlank() } ?: continue
                ctx.env.run(action, runtime.itemFor(hit.node, ctx.item), payload)
            }
        }
    }

    // THE ONE frame loop (P4 on:frame + P5 animations + G2 physics): it exists ONLY
    // while an on:frame handler is authored, at least one animation/transition is
    // active, OR any dynamic body is awake / any character exists (the G2 extension of
    // the loop-existence law) — a static scene never spins (the P1 law; LaunchedEffect
    // cancellation IS the unmount law), and a fully-asleep physics world stops the loop
    // (and on:tick with it). The :core SceneFrameClock applies the 60/s budget (corpus
    // frame.json) to handler dispatch AND animation advance; the physics accumulator
    // (corpus physics.json) decouples the fixed 60 Hz simulation from the rendered rate
    // inside it. When a tick moves any override, animEpoch re-rasters, and the
    // recomposition re-evaluates whether the loop may keep existing.
    val frameAction = ctx.attrs["on:frame"]?.takeIf { it.isNotBlank() }
    val tickAction = ctx.attrs["on:tick"]?.takeIf { it.isNotBlank() }
    if (frameAction != null || runtime.animator.wantsTick(resolveBase) ||
        runtime.physics.wants(resolveBase) || runtime.mixers.wantsTick()
    ) {
        LaunchedEffect(node, frameAction, tickAction) {
            val clock = SceneFrameClock()
            // G2 event dispatch: on:collision/on:enter/on:exit on the BODY's node, both
            // directions per pair, in the row scope — the same runner path as on:tap
            fun firePair(event: String, e: ScenePhysicsPairEvent) {
                val bodyNode = runtime.physics.nodeFor(e.id) ?: return
                val action = bodyNode.source?.attrs?.get("on:$event")?.takeIf { it.isNotBlank() } ?: return
                ctx.env.run(action, runtime.itemFor(bodyNode, ctx.item), mapOf(
                    "id" to (bodyNode.id ?: ""),
                    "other" to (runtime.physics.nodeFor(e.other)?.id ?: ""),
                ))
            }
            while (true) {
                withFrameNanos { frameTimeNanos ->
                    val nowMs = frameTimeNanos / 1_000_000.0
                    clock.tick(nowMs)?.let { payload ->
                        runtime.bus.lastFrameDt = payload.dt   // the stats() profiler read
                        frameAction?.let { action ->
                            ctx.env.run(action, ctx.item, mapOf(
                                "dt" to payload.dt, "elapsed" to payload.elapsed, "frame" to payload.frame,
                            ))
                        }
                        val changed = runtime.animator.tick(nowMs, resolveBase) { animNode, target ->
                            // on:done fires ONCE per completion (never per loop iteration);
                            // payload {id} = the ANIMATED target's id (the iOS shape)
                            animNode.source?.attrs?.get("on:done")?.takeIf { it.isNotBlank() }?.let { done ->
                                ctx.env.run(done, runtime.itemFor(animNode, ctx.item),
                                    mapOf("id" to (target.id ?: "")))
                            }
                        }
                        // G2: the fixed-tick solver rides the same loop AFTER animations
                        // (kinematics read animation overrides written this frame),
                        // interpolating solver-owned positions into overrides
                        val physicsFrame = runtime.physics.advance(payload.dt, resolve, resolveBase)
                        for (step in physicsFrame.ticks) {
                            for (e in step.collisions) firePair("collision", e)
                            for (e in step.enters) firePair("enter", e)
                            for (e in step.exits) firePair("exit", e)
                            tickAction?.let { action ->
                                ctx.env.run(action, ctx.item, mapOf("dt" to step.dt, "tick" to step.tick))
                            }
                        }
                        // G3: an active clip/crossfade re-rasters every emitted tick
                        // (the raster path advances the mixers with a fresh clock read)
                        if (changed || physicsFrame.changed || runtime.mixers.wantsTick()) animEpoch += 1
                    }
                }
            }
        }
    }
}
