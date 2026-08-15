//
//  SceneSprite.kt - the DSX Scene 2D primitive, the Kotlin twin of the web kernel's
//  scene/sprite.ts (dsx-game.md G6), corpus OpenSource/Conformance/scene/sprite.json.
//  Pure JVM, zero dependencies — the NUMBERS only; SceneRaster paints them and each
//  element owns the texture I/O.
//
//  - THE QUAD LAW: `<sprite src size position rotation scale color anchor flip>` is a
//    TEXTURED QUAD in the node's LOCAL XY plane facing +Z, riding the node's world
//    transform exactly like `<plane>`. In mode="2d" that IS camera-facing (the
//    orthographic camera looks down −Z); BILLBOARDING IN 3D IS A NAMED ABSENCE.
//  - THE SIZE DEFAULT: unauthored, the quad is 1 unit TALL and as wide as the TEXTURE
//    ASPECT (1 when the texture is unknown or still loading — the honest square).
//  - THE ANCHOR LAW: the quad CENTER sits at (−ax·w, −ay·h, 0) from the node origin.
//  - THE SHEET LAW: `frames` is "N" (a single row) or "cols rows" (2-D packed,
//    EXPLICIT — the kernel never guesses); frame n maps ROW-MAJOR to a UV rectangle
//    whose v0 is the frame's TOP edge (the P4 UV law verbatim). `flip` mirrors it.
//  - THE FPS LAW: a positive `fps` OWNS the index — advanced = floor(elapsed × fps),
//    wrapped by `loop` — riding the SAME frame clock on:frame rides, never a second loop.
//  - THE 2D DRAW ORDER: z IS the draw order; `sceneDrawOrder2d` sorts world z ASCENDING
//    (stable) and the rasterizer paints in that order with the z-buffer OFF.
//

package despia.engine.scene

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** the unauthored quad height in scene units — the width follows the texture aspect */
const val SPRITE_DEFAULT_HEIGHT = 1.0

/** the sprite quad's layout in the node's LOCAL frame */
class SpriteQuad(
    /** the quad CENTER's offset from the node origin (the anchor law) */
    val center: Vec3,
    val halfWidth: Double,
    val halfHeight: Double,
    /** the frame's UV rectangle [u0, v0, u1, v1]; v0 is the frame's TOP edge */
    val uv: DoubleArray,
)

/** THE SIZE LAW: an authored `size` wins; otherwise height = SPRITE_DEFAULT_HEIGHT and
 *  width = the texture aspect (image width / height) at that height, falling back to a
 *  square when the aspect is unknown, non-finite or non-positive. */
fun spriteSizeOf(props: SceneNodeProps, textureAspect: Double? = null): DoubleArray {
    if (props.spriteSizeAuthored) return doubleArrayOf(props.spriteSize[0], props.spriteSize[1])
    val aspect = textureAspect ?: 1.0
    val width = if (aspect.isFinite() && aspect > 0.0) aspect else 1.0
    return doubleArrayOf(width * SPRITE_DEFAULT_HEIGHT, SPRITE_DEFAULT_HEIGHT)
}

/** THE ANCHOR LAW: the quad CENTER offset from the node origin */
fun spriteAnchorOffset(props: SceneNodeProps, width: Double, height: Double): Vec3 {
    val anchor = SPRITE_ANCHORS[props.spriteAnchor] ?: doubleArrayOf(0.0, 0.0)
    return doubleArrayOf(-anchor[0] * width, -anchor[1] * height, 0.0)
}

/** the sheet's total cell count (cols · rows; 1 when no sheet is authored) */
fun spriteFrameCount(props: SceneNodeProps): Int = props.spriteFrames[0] * props.spriteFrames[1]

/** THE UV RECTANGLE LAW: frame n row-major over the [cols, rows] grid, `flip` swapping
 *  the u and/or v ends. The index arrives already floored + clamped (resolvedProps). */
fun spriteUvRect(props: SceneNodeProps, frame: Int): DoubleArray {
    val cols = props.spriteFrames[0]
    val rows = props.spriteFrames[1]
    val index = min(max(frame, 0), cols * rows - 1)
    val col = index % cols
    val row = index / cols
    var u0 = col.toDouble() / cols
    var u1 = (col + 1).toDouble() / cols
    var v0 = row.toDouble() / rows
    var v1 = (row + 1).toDouble() / rows
    if (props.spriteFlip.contains('x')) { val t = u0; u0 = u1; u1 = t }
    if (props.spriteFlip.contains('y')) { val t = v0; v0 = v1; v1 = t }
    return doubleArrayOf(u0, v0, u1, v1)
}

/** THE FPS LAW: a positive `fps` derives the index from the elapsed SECONDS on the
 *  shared frame clock — advanced = floor(elapsed × fps), wrapped (loop) or held
 *  (loop="false"); a non-positive elapsed reads frame 0. fps ≤ 0 (unauthored or
 *  malformed) hands back the authored/bound `frame` prop unchanged. */
fun spriteFrameAt(props: SceneNodeProps, elapsedSeconds: Double): Int {
    val total = spriteFrameCount(props)
    if (props.spriteFps <= 0.0 || total <= 0) return props.spriteFrame
    if (!(elapsedSeconds > 0.0) || !elapsedSeconds.isFinite()) return 0
    val advanced = floor(elapsedSeconds * props.spriteFps).toInt()
    if (advanced <= 0) return 0
    return if (props.spriteLoop) advanced % total else min(advanced, total - 1)
}

/** the whole layout in one call: size (texture-aspect aware) → anchor offset → UV rect */
fun spriteQuad(props: SceneNodeProps, textureAspect: Double? = null, frame: Int? = null): SpriteQuad {
    val size = spriteSizeOf(props, textureAspect)
    return SpriteQuad(
        spriteAnchorOffset(props, size[0], size[1]),
        size[0] / 2.0,
        size[1] / 2.0,
        spriteUvRect(props, frame ?: props.spriteFrame),
    )
}

/** THE 2D DRAW-ORDER LAW: higher z draws IN FRONT, so painting runs world z ASCENDING
 *  with a STABLE sort — equal z keeps document order. The rasterizer walks this order
 *  with the z-buffer OFF (the painter's algorithm) inside `mode="2d"`. */
fun sceneDrawOrder2d(zs: List<Double>): List<Int> =
    zs.indices.sortedWith(compareBy({ zs[it] }, { it }))
