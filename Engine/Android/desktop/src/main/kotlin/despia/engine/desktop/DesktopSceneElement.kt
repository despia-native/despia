//
//  DesktopSceneElement.kt — `<scene>` (dsx-scene.md P2): the DSX-native 3D/2D engine's
//  desktop surface. Every NUMBER lives in the corpus-pinned :core kernel
//  (despia.engine.scene — corpus OpenSource/Conformance/scene/), and the PIXELS come
//  from the ONE shared software rasterizer (SceneRaster.kt) the Android `<scene>` paints
//  too — the two JVM lanes are 1:1 by construction, zero new dependencies (no GPU, no
//  display server: the framebuffer renders identically in CI and in the packaged app).
//  This file owns only the Compose-desktop adapter:
//
//    • framebuffer IntArray → BGRA bytes → Skia Image → ImageBitmap → Canvas paint
//      (raster long edge capped at 640; the draw scales);
//    • reactive re-rasterization: the element collects the store flows itself (the
//      DesktopSurface root already collects, but child-node holes such as
//      `rotation="0 {{ dsx.variable.spin }} 0"` deserve their own subscription so a
//      skipped recomposition can never strand stale pixels); the resolved-attribute
//      snapshot is the remember key — equal key, no re-raster;
//    • on:tap picking v0 through the kernel's shared scenePickAction (pickRay/raySphere
//      vs world bounding spheres), handlers through the normal runner path;
//    • P4 assets through the :core SceneAssets seam: `texture="url"` and `<model src>`
//      bytes ride the CONTENT PLANE (DSXContent cached-then-fresh — the dsx-scene.md §2
//      asset law), decoded off the main thread with Skia (makeFromEncoded → pixel map),
//      cached per element, re-rasterizing on arrival; text3d values rasterize through
//      java.awt (BufferedImage/Graphics2D — headless-safe, WHITE glyphs, the node color
//      modulates);
//    • on:frame (P4) + ANIMATIONS (P5): ONE withFrameNanos loop that exists ONLY while
//      an on:frame handler is authored OR at least one animation/transition is active
//      (the zero-cost static law; LaunchedEffect cancellation IS the unmount law), the
//      :core SceneFrameClock applying the 60/s budget to handler dispatch AND animation
//      advance — deterministic under the Skiko test mainClock. The animation state
//      machine is the :core SceneAnimator (shared with the Android element — the
//      SceneRaster stance): implicit `transition=` retargets + explicit `<animate>`
//      tweens override at the RESOLVED-ATTRIBUTE plane; on:done rides the runner path;
//    • BOUND GROUPS (P5): `<group bind key>` through the :core SceneBindReconciler —
//      keyed rows with surviving node identity, row-scoped `item.*` resolution, nested
//      binds, removal stops row animations;
//    • COLLISIONS (P5): the :core SceneCollisionPass rides each rendered frame (a
//      LaunchedEffect keyed on the same raster keys — never its own loop) while any
//      on:collide is authored, payload {id, other, depth} both directions on enter;
//    • ORBIT (P5): `controls="orbit"` on <camera> — mouse drag (0.4°/px, pitch ±89°)
//      + scroll-wheel zoom (one wheel line ≈ the web's ~100 px deltaY) through the
//      kernel orbit math, written through the same override plane;
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
//    • Article-7 diagnostics: fall back + say so ONCE per distinct message (kernelLog).
//
//  Deliberately NOT a DesktopCapabilities row: Scene3D/Scene360 (the ratified-absent
//  native 3D embeddings) stay capability-dispatched; `<scene>` ships a real first-party
//  renderer in this binary, so it is binary-owned like image/svg/qrcode.
//

package despia.engine.desktop

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import despia.engine.DSX
import despia.engine.DSXContent
import despia.engine.JSE
import despia.engine.kernelLog
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.ui.input.pointer.PointerEventType
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
import despia.engine.scene.ScenePrefabItems
import despia.engine.scene.ScenePrefabLookup
import despia.engine.scene.SceneResolve
import despia.engine.scene.scenePrefabDefFromTemplate
import despia.engine.scene.GlbPose
import despia.engine.scene.SceneTexture
import despia.engine.scene.formatSceneAnimValue
import despia.engine.scene.orbitDrag
import despia.engine.scene.orbitFromCamera
import despia.engine.scene.orbitPosition
import despia.engine.scene.orbitZoom
import despia.engine.scene.parseGlb
import despia.engine.scene.parseScene
import despia.engine.scene.rasterizeScene
import despia.engine.scene.resolvedProps
import despia.engine.scene.sceneAnyCollideHandler
import despia.engine.scene.sceneModelHalfExtents
import despia.engine.scene.scenePickHitNode
import despia.engine.varsFlow
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.jetbrains.skia.ColorAlphaType
import org.jetbrains.skia.ColorType
import org.jetbrains.skia.Image
import org.jetbrains.skia.ImageInfo

/** the long-edge cap for the software raster buffer (the draw scales the image up) */
internal const val DESKTOP_SCENE_RASTER_MAX_EDGE = 640

// ── the pure halves (plain-JVM tested — DesktopSceneUiTest asserts the pixels) ───────

/** raster-buffer size: the composed pixel size capped on the long edge, aspect kept */
internal fun desktopSceneRasterSize(width: Int, height: Int): IntSize {
    val w = max(1, width); val h = max(1, height)
    val long = max(w, h)
    if (long <= DESKTOP_SCENE_RASTER_MAX_EDGE) return IntSize(w, h)
    val scale = DESKTOP_SCENE_RASTER_MAX_EDGE.toDouble() / long
    return IntSize(max(1, (w * scale).roundToInt()), max(1, (h * scale).roundToInt()))
}

/** the reactive re-raster key: every authored attribute (root + all nodes, document
 *  order) resolved to its current value; handlers/ids excluded — they never move pixels */
internal fun desktopSceneResolvedKey(ir: SceneIR, resolve: SceneResolve): String {
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

/** the scheduled-row placeholder text (dsx-scene.md P3), worded like the web notice.
 *  model/text3d left this list when P4 landed — they render for real now. */
internal fun desktopSceneScheduledNotice(ir: SceneIR): String {
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

/** ARGB IntArray → PNG bytes through javax.imageio (pure JVM, headless-safe) — the
 *  scene bus `capture` encoder (dsx-game.md G5). Null only when ImageIO refuses. */
internal fun desktopScenePng(pixels: IntArray, width: Int, height: Int): ByteArray? = runCatching {
    val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
    image.setRGB(0, 0, width, height, pixels, 0, width)
    val out = java.io.ByteArrayOutputStream()
    if (!javax.imageio.ImageIO.write(image, "png", out)) return@runCatching null
    out.toByteArray()
}.getOrNull()

/** ARGB IntArray → a Compose ImageBitmap via an explicit BGRA_8888 Skia raster (no
 *  endianness assumption — the byte order is spelled out, alpha is always opaque) */
internal fun desktopSceneImage(pixels: IntArray, width: Int, height: Int): ImageBitmap {
    val bytes = ByteArray(pixels.size * 4)
    for (i in pixels.indices) {
        val argb = pixels[i]
        bytes[i * 4] = (argb and 0xFF).toByte()             // B
        bytes[i * 4 + 1] = ((argb shr 8) and 0xFF).toByte() // G
        bytes[i * 4 + 2] = ((argb shr 16) and 0xFF).toByte() // R
        bytes[i * 4 + 3] = ((argb shr 24) and 0xFF).toByte() // A (always 0xFF)
    }
    val info = ImageInfo(width, height, ColorType.BGRA_8888, ColorAlphaType.PREMUL)
    return Image.makeRaster(info, bytes, width * 4).toComposeImageBitmap()
}

// ── the P4 asset seam (Skia decode + awt text + content-plane bytes) ─────────────────

/** decoded ARGB pixels from encoded image bytes (Skia makeFromEncoded → pixel map),
 *  null when the bytes are not an image */
internal fun decodeDesktopSceneTexture(bytes: ByteArray): SceneTexture? = runCatching {
    val bitmap = Image.makeFromEncoded(bytes).toComposeImageBitmap()
    val map = bitmap.toPixelMap()
    val pixels = IntArray(map.width * map.height)
    for (y in 0 until map.height) {
        for (x in 0 until map.width) pixels[y * map.width + x] = map[x, y].toArgb()
    }
    SceneTexture(pixels, map.width, map.height)
}.getOrNull()

/** the text3d glyph raster: WHITE glyphs on transparency (the node color modulates),
 *  java.awt BufferedImage/Graphics2D — headless-safe, the platform text stack per the
 *  corpus README's honest scope line (glyph pixels are deliberately unpinned) */
internal fun rasterizeDesktopText(value: String, widthPx: Int, heightPx: Int): SceneTexture? = runCatching {
    val image = BufferedImage(widthPx, heightPx, BufferedImage.TYPE_INT_ARGB)
    val graphics = image.createGraphics()
    graphics.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
    graphics.color = java.awt.Color.WHITE
    graphics.font = java.awt.Font(java.awt.Font.SANS_SERIF, java.awt.Font.PLAIN, (heightPx * 0.78).toInt())
    val metrics = graphics.fontMetrics
    val measured = metrics.stringWidth(value)
    if (measured > widthPx && measured > 0) {
        graphics.font = graphics.font.deriveFont(graphics.font.size2D * widthPx / measured)
    }
    val finalMetrics = graphics.fontMetrics
    val x = (widthPx - finalMetrics.stringWidth(value)) / 2
    val y = (heightPx - finalMetrics.height) / 2 + finalMetrics.ascent
    graphics.drawString(value, x, y)
    graphics.dispose()
    val pixels = IntArray(widthPx * heightPx)
    image.getRGB(0, 0, widthPx, heightPx, pixels, 0, widthPx)
    SceneTexture(pixels, widthPx, heightPx)
}.getOrNull()

/** the SceneAssets seam for the desktop element: texture/model BYTES ride the content
 *  plane (DSXContent cached-then-fresh — the dsx-scene.md §2 asset law), decoded off the
 *  main thread; a finished load bumps [invalidate] so the element re-rasterizes. Text
 *  rasters are synchronous and cached. Absent/failed assets answer null — nothing draws,
 *  nothing crashes (Article 7). */
internal class DesktopSceneAssets(
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
        if (!url.startsWith("https://") && !url.startsWith("http://")) { textures[url] = null; return null }
        fetch("texture:$url", url, ::decodeDesktopSceneTexture) { textures[url] = it }
        return null
    }

    override fun model(src: String): GlbModel? {
        if (models.containsKey(src)) return models[src]
        if (!src.startsWith("https://") && !src.startsWith("http://")) { models[src] = null; return null }
        fetch("model:$src", src, { bytes -> parseGlb(bytes).model }) { models[src] = it }
        return null
    }

    override fun text(value: String, widthPx: Int, heightPx: Int): SceneTexture? =
        texts.getOrPut("$widthPx×$heightPx:$value") { rasterizeDesktopText(value, widthPx, heightPx) }
}

// ── the Compose-desktop adapter ──────────────────────────────────────────────────────

/** the per-element P5 runtime bundle — parsed once per node, shared by every closure */
private class DesktopSceneRuntime(
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
internal fun DesktopSceneElement(context: DesktopElementContext, modifier: Modifier) {
    val node = context.node
    val store = context.store
    val item = context.item

    // own subscription (see header): a store publish always reaches this element even if
    // an outer composable skips — the Android element does the same
    store.varsFlow.collectAsState().value
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
        // desktop component table (the same map DesktopNode dispatches through); the
        // kernel only sees the lookup seam (rule 18)
        val prefabs: ScenePrefabLookup = { tag ->
            context.components[tag]?.let { scenePrefabDefFromTemplate(it) }
        }
        val ir = parseScene(node, diag, prefabs)
        val animator = SceneAnimator(diag)
        val prefabItems = ScenePrefabItems { raw, scope -> JSE.interpolate(raw, store, scope) }
        val reconciler = SceneBindReconciler(
            evalBind = { expr, rowItem -> JSE.eval(expr, store, rowItem) },
            animator = animator, diag = diag, prefabItems = prefabItems,
        )
        prefabItems.stamp(ir.nodes)
        reconciler.register(ir.nodes, item)
        // the G5 bus adapter LAYERS its base overlay under the live-store resolver, so
        // a bus `set` IS a base change (noteBase retargets authored transitions) —
        // attach/noteBase/resolve all speak bus.resolveBase from here on
        val bus = SceneBusAdapter(ir, animator, reconciler, diag)
        reconciler.onDrop = { bus.dropNode(it) }   // despawned rows drop their bus writes
        val built = DesktopSceneRuntime(
            ir, animator, reconciler, SceneCollisionPass(), bus,
            ScenePhysicsRuntime(ir, animator, diag), SceneClipMixers(diag), prefabItems,
        )
        bus.rawBase = { n, _, raw ->
            JSE.interpolate(raw, store, n?.let { built.itemFor(it, item) } ?: item)
        }
        animator.attach(ir.nodes, null, bus.resolveBase)
        // G2: the fixed-tick solver rides the same animator override plane (solver-owned
        // positions are interpolated overrides); the bus read exposes its body state
        bus.physicsInfo = { n -> built.physics.info(n) }
        bus.forcePhysicsWrite = { n, attr -> built.physics.forceWrite(n, attr) }
        built
    }
    val ir = runtime.ir
    // the base plane (what animations retarget toward) + the override plane on top —
    // row/prefab-scoped (a bound-row node resolves item.* against ITS row; a prefab
    // body resolves its instance scope — G1), with the bus's base overlay underneath
    // (a module `scene.set` writes it)
    runtime.bus.rawBase = { n, _, raw ->
        JSE.interpolate(raw, store, n?.let { runtime.itemFor(it, item) } ?: item)
    }
    val resolveBase: SceneResolve = runtime.bus.resolveBase
    val resolve: SceneResolve = runtime.animator.resolve(resolveBase)

    // P5 per composition: reconcile bound groups against the live store (the noteBase
    // pair runs below, once the asset seam has bound the model-collider hook)
    var animEpoch by remember(node) { mutableStateOf(0) }
    runtime.reconciler.reconcile(resolveBase)

    // fill-width 16:9 is the unstyled default (the web `.dsx-scene` box); an authored
    // width/height already rides the desktop style modifier passed in
    val hasAuthoredSize = context.attributes.containsKey("width") || context.attributes.containsKey("height")
    val sizeDefault = if (hasAuthoredSize) Modifier else Modifier.fillMaxWidth().aspectRatio(16f / 9f)

    var sizePx by remember(node) { mutableStateOf(IntSize.Zero) }
    // P4 assets: loads bump assetEpoch, which keys the raster remember — arrival redraws
    var assetEpoch by remember(node) { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    val assets = remember(node) { DesktopSceneAssets(scope) { assetEpoch += 1 } }
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
            desktopSceneRasterSize(sizePx.width, sizePx.height) else IntSize(320, 180)
        val pixels = rasterizeScene(ir, resolve, raster.width, raster.height, assets, diag)
        desktopScenePng(pixels, raster.width, raster.height)?.let { png ->
            SceneBusCapture(java.util.Base64.getEncoder().encodeToString(png), raster.width, raster.height)
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

    val resolvedKey = desktopSceneResolvedKey(ir, resolve)
    val frame: ImageBitmap? = remember(node, resolvedKey, sizePx, assetEpoch, animEpoch) {
        if (sizePx.width <= 0 || sizePx.height <= 0) null
        else {
            runtime.mixers.advance(ir, resolveBase, { src -> assets.model(src) }, System.nanoTime() / 1e6)
            val raster = desktopSceneRasterSize(sizePx.width, sizePx.height)
            val pixels = rasterizeScene(ir, resolve, raster.width, raster.height, assets, diag)
            desktopSceneImage(pixels, raster.width, raster.height)
        }
    }

    // P5 orbit: `controls="orbit"` on the camera — mouse drag + wheel zoom fold through
    // the kernel orbit math into a camera-position override (the animations' plane)
    val cameraNode: SceneNode? = remember(node) { ir.nodes.firstOrNull { it.kind == SceneNodeKind.CAMERA } }

    Box(
        modifier
            .then(sizeDefault)
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
                    context.runner.run(action, runtime.itemFor(hit, item),
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
            }
            .pointerInput(node) {
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent()
                        if (event.type != PointerEventType.Scroll) continue
                        val cam = cameraNode ?: continue
                        if (resolvedProps(cam, resolveBase, diag).controls != "orbit") continue
                        // one wheel line ≈ the web's ~100 px deltaY (the zoom law's unit)
                        val deltaY = event.changes.fold(0f) { acc, ch -> acc + ch.scrollDelta.y } * 100.0
                        if (deltaY == 0.0) continue
                        val props = resolvedProps(cam, resolve, diag)
                        val state = orbitZoom(
                            orbitFromCamera(props.position, props.lookAt), deltaY, props.near, props.far,
                        )
                        runtime.animator.setOverride(
                            cam, "position", formatSceneAnimValue("position", orbitPosition(state, props.lookAt)),
                        )
                        animEpoch += 1
                        event.changes.forEach { it.consume() }
                    }
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
        val notice = desktopSceneScheduledNotice(ir)
        if (notice.isNotEmpty()) {
            // the honest scheduled placeholder INSIDE the scene box (never blank, never fake)
            Text(
                text = notice,
                fontSize = 11.sp,
                color = MaterialTheme.colors.onSurface,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            )
        }
    }

    // on:ready — after the first composition (the web element's post-first-draw event)
    context.attributes["on:ready"]?.takeIf { it.isNotBlank() }?.let { action ->
        LaunchedEffect(node) { context.runner.run(action, item) }
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
                context.runner.run(action, runtime.itemFor(hit.node, item), payload)
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
    // inside it — the Compose frame clock is the tick source (deterministic under the
    // Skiko test mainClock). When a tick moves any override, animEpoch re-rasters, and
    // the recomposition re-evaluates whether the loop may keep existing.
    val frameAction = context.attributes["on:frame"]?.takeIf { it.isNotBlank() }
    val tickAction = context.attributes["on:tick"]?.takeIf { it.isNotBlank() }
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
                context.runner.run(action, runtime.itemFor(bodyNode, item), mapOf(
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
                            context.runner.run(action, item, mapOf(
                                "dt" to payload.dt, "elapsed" to payload.elapsed, "frame" to payload.frame,
                            ))
                        }
                        val changed = runtime.animator.tick(nowMs, resolveBase) { animNode, target ->
                            // on:done fires ONCE per completion (never per loop iteration);
                            // payload {id} = the ANIMATED target's id (the iOS shape)
                            animNode.source?.attrs?.get("on:done")?.takeIf { it.isNotBlank() }?.let { done ->
                                context.runner.run(done, runtime.itemFor(animNode, item),
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
                                context.runner.run(action, item, mapOf("dt" to step.dt, "tick" to step.tick))
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
