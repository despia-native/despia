//
//  SceneRaster.kt - the DSX Scene SOFTWARE rasterizer (dsx-scene.md P2 + P4): ONE
//  pure-JVM renderer shared by BOTH Kotlin surfaces — the Android `<scene>` element
//  (:render paints the framebuffer into a Bitmap) and the desktop `<scene>` element
//  (:desktop paints it into a Skia ImageBitmap) — so the two JVM lanes are 1:1 by
//  construction, with zero new dependencies and CI-verifiable pixels (no GPU, no
//  display server). Filament remains the named PBR/performance upgrade (dsx-scene.md §3).
//
//  The NUMBERS all come from the corpus-pinned kernel in this package (SceneMath /
//  SceneIR / SceneGltf / SceneFrame — OpenSource/Conformance/scene/); this file owns
//  only the pixel pipeline: geometry (unit box 12 tris · UV-sphere 16×24 · plane
//  2 tris) → model = world · S(geometry) → clip via proj·view → NDC → viewport,
//  z-buffered, flat-shaded Lambert per triangle matching the web shader's model
//  (packages/dom/src/scene.ts): color * (ambient + lightColor * max(0, dot(n,
//  lightDir))) with the normal flipped toward the eye (two-sided planes).
//
//  P4 additions, all fed through the SceneAssets SEAM (the elements own platform I/O —
//  :core stays pure JVM and geometry-only, the checkPureJvm stance):
//    • TEXTURES (`texture="url"` on box/sphere/plane): perspective-correct UV
//      interpolation, NEAREST sampling clamped to the edge, the texel MODULATING the
//      lit color — the UV law pinned in the corpus README (per-face u = x_face + 0.5,
//      v = 0.5 − y_face; sphere u = φ/2π, v = θ/π);
//    • MODELS (`<model src>`): the kernel-parsed GLB draw list rendered through the
//      same pipeline — model = sceneWorld · draw.world, flat face normals (the raster's
//      P2 stance; authored normals ride the web/GL lanes), baseColorFactor × node color;
//    • TEXT3D: the corpus quad law (text3dQuad) on a BILLBOARD (view rotation
//      transposed — the quad always faces the camera), the value rasterized by the
//      element's text seam (android.graphics / java.awt), drawn UNLIT with alpha-cutout
//      glyph edges so labels stay legible.
//  mode="ar"/<anchor> draw nothing here — the element overlays the honest labelled
//  placeholder (the P3 row). Exact pixel parity with WebGL is NOT claimed: the corpus
//  pins the MATH, SceneRasterTest pins non-blank + reactivity + relative geometry +
//  occlusion + the P4 texture/model/text3d evidence.
//

package despia.engine.scene

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// ── the asset seam (the elements provide platform I/O; :core stays pure) ─────────────

/** an ARGB pixel grid — texture uploads and text rasters cross the seam in this shape */
class SceneTexture(val pixels: IntArray, val width: Int, val height: Int)

/** what a consuming element can provide the rasterizer. Every member may answer null —
 *  a not-yet-loaded/failed asset simply doesn't draw (never a crash, never a fake). */
interface SceneAssets {
    /** decoded pixels for a `texture="url"` word (the element fetches + decodes + caches) */
    fun texture(url: String): SceneTexture? = null
    /** the parsed GLB for a `<model src>` (the element fetches bytes; parseGlb is kernel) */
    fun model(src: String): GlbModel? = null
    /** the platform text raster for a text3d value: WHITE glyphs on transparent pixels
     *  (the node color modulates), canvas aspect already matching the quad law */
    fun text(value: String, widthPx: Int, heightPx: Int): SceneTexture? = null
    /** G3: the model node's sampled clip pose (the element owns the SceneClipMixer);
     *  null = no animation authored — the P4 static draw path, byte-identical */
    fun pose(node: SceneNode): GlbPose? = null
}

/** the text3d raster height law (pixels; width follows the quad aspect = 0.6/char) */
const val SCENE_TEXT3D_RASTER_HEIGHT = 64

// ── geometry (unit shapes; per-node size/radius rides an extra model scale) ──────────

/** flat triangle list: 9 doubles per triangle (three xyz vertices) + 6 per triangle
 *  (three uv pairs, the corpus-README UV law), the web geometry builders' triangles
 *  flattened (buildBoxGeometry/buildSphereGeometry/buildPlaneGeometry) */
internal class SceneTriangles(val vertices: DoubleArray, val uvs: DoubleArray) {
    val count: Int get() = vertices.size / 9
}

/** the per-face UV pattern (README law): u = x_face + 0.5, v = 0.5 − y_face — texel
 *  row 0 is the image's TOP, so the image reads upright on a +Z-facing surface */
private val FACE_UVS = arrayOf(
    doubleArrayOf(0.0, 1.0), doubleArrayOf(1.0, 1.0), doubleArrayOf(1.0, 0.0), doubleArrayOf(0.0, 0.0),
)

internal fun buildBoxTriangles(): SceneTriangles {
    // 6 faces × 4 corners, unit cube centered at the origin — the web face table verbatim
    val faces = arrayOf(
        arrayOf(doubleArrayOf(-0.5, -0.5, 0.5), doubleArrayOf(0.5, -0.5, 0.5), doubleArrayOf(0.5, 0.5, 0.5), doubleArrayOf(-0.5, 0.5, 0.5)),
        arrayOf(doubleArrayOf(0.5, -0.5, -0.5), doubleArrayOf(-0.5, -0.5, -0.5), doubleArrayOf(-0.5, 0.5, -0.5), doubleArrayOf(0.5, 0.5, -0.5)),
        arrayOf(doubleArrayOf(0.5, -0.5, 0.5), doubleArrayOf(0.5, -0.5, -0.5), doubleArrayOf(0.5, 0.5, -0.5), doubleArrayOf(0.5, 0.5, 0.5)),
        arrayOf(doubleArrayOf(-0.5, -0.5, -0.5), doubleArrayOf(-0.5, -0.5, 0.5), doubleArrayOf(-0.5, 0.5, 0.5), doubleArrayOf(-0.5, 0.5, -0.5)),
        arrayOf(doubleArrayOf(-0.5, 0.5, 0.5), doubleArrayOf(0.5, 0.5, 0.5), doubleArrayOf(0.5, 0.5, -0.5), doubleArrayOf(-0.5, 0.5, -0.5)),
        arrayOf(doubleArrayOf(-0.5, -0.5, -0.5), doubleArrayOf(0.5, -0.5, -0.5), doubleArrayOf(0.5, -0.5, 0.5), doubleArrayOf(-0.5, -0.5, 0.5)),
    )
    val out = ArrayList<Double>(6 * 2 * 9)
    val uvs = ArrayList<Double>(6 * 2 * 6)
    for (corners in faces) {
        for (tri in arrayOf(intArrayOf(0, 1, 2), intArrayOf(0, 2, 3))) {
            for (i in tri) {
                out.add(corners[i][0]); out.add(corners[i][1]); out.add(corners[i][2])
                uvs.add(FACE_UVS[i][0]); uvs.add(FACE_UVS[i][1])
            }
        }
    }
    return SceneTriangles(out.toDoubleArray(), uvs.toDoubleArray())
}

internal fun buildSphereTriangles(latBands: Int = 16, lonBands: Int = 24): SceneTriangles {
    val grid = Array(latBands + 1) { lat ->
        Array(lonBands + 1) { lon ->
            val theta = lat * PI / latBands
            val phi = lon * 2.0 * PI / lonBands
            // the sphere UV law: u = φ/2π (+X meridian toward +Z), v = θ/π (0 at +Y pole)
            doubleArrayOf(
                sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi),
                lon.toDouble() / lonBands, lat.toDouble() / latBands,
            )
        }
    }
    val out = ArrayList<Double>(latBands * lonBands * 2 * 9)
    val uvs = ArrayList<Double>(latBands * lonBands * 2 * 6)
    fun push(v: DoubleArray) {
        out.add(v[0]); out.add(v[1]); out.add(v[2])
        uvs.add(v[3]); uvs.add(v[4])
    }
    for (lat in 0 until latBands) {
        for (lon in 0 until lonBands) {
            val a = grid[lat][lon]; val b = grid[lat + 1][lon]
            val c = grid[lat][lon + 1]; val d = grid[lat + 1][lon + 1]
            // the web index order: (first, second, first+1) + (second, second+1, first+1)
            push(a); push(b); push(c)
            push(b); push(d); push(c)
        }
    }
    return SceneTriangles(out.toDoubleArray(), uvs.toDoubleArray())
}

internal fun buildPlaneTriangles(): SceneTriangles = SceneTriangles(
    doubleArrayOf(
        // unit quad in XY facing +Z (the corpus law: rotate -90° about X for a ground plane)
        -0.5, -0.5, 0.0, 0.5, -0.5, 0.0, 0.5, 0.5, 0.0,
        -0.5, -0.5, 0.0, 0.5, 0.5, 0.0, -0.5, 0.5, 0.0,
    ),
    doubleArrayOf(
        0.0, 1.0, 1.0, 1.0, 1.0, 0.0,
        0.0, 1.0, 1.0, 0.0, 0.0, 0.0,
    ),
)

/** G6: the sprite quad — the PLANE triangles with the frame's UV rectangle substituted
 *  (the sheet is geometry here, a uniform on the GL lane; the LAW is the same rect) */
internal fun spritePlaneTriangles(uv: DoubleArray): SceneTriangles {
    val plane = buildPlaneTriangles()
    val uvs = DoubleArray(plane.uvs.size)
    for (i in uvs.indices step 2) {
        uvs[i] = uv[0] + plane.uvs[i] * (uv[2] - uv[0])
        uvs[i + 1] = uv[1] + plane.uvs[i + 1] * (uv[3] - uv[1])
    }
    return SceneTriangles(plane.vertices, uvs)
}

// shared immutable geometry — built once per process (scenes are small; perf is not a gate)
private val BOX: SceneTriangles by lazy { buildBoxTriangles() }
private val SPHERE: SceneTriangles by lazy { buildSphereTriangles() }
private val PLANE: SceneTriangles by lazy { buildPlaneTriangles() }

/** the web geometryScale twin: model = world · S(geometry) keeps the corpus-pinned world
 *  matrices free of geometry-local scale */
internal fun geometryScale(node: SceneNode, props: SceneNodeProps): Vec3? = when (node.kind) {
    SceneNodeKind.BOX -> props.boxSize
    SceneNodeKind.SPHERE -> doubleArrayOf(props.radius, props.radius, props.radius)
    SceneNodeKind.PLANE -> doubleArrayOf(props.planeSize[0], props.planeSize[1], 1.0)
    else -> null
}

private fun modelMatrix(world: Mat4, scale: Vec3): Mat4 {
    val m = world.copyOf()
    for (i in 0 until 3) {
        m[0 + i] = m[0 + i] * scale[0]
        m[4 + i] = m[4 + i] * scale[1]
        m[8 + i] = m[8 + i] * scale[2]
    }
    return m
}

/** the BILLBOARD law (web billboardMatrix twin): model = T(world position) · R(view
 *  rotation transposed) · S(quad size · largest world basis) — always camera-facing */
internal fun sceneBillboardMatrix(world: Mat4, view: Mat4, width: Double, height: Double): Mat4 {
    val scale = mat4LargestBasis(world)
    val rotation = doubleArrayOf(
        view[0], view[4], view[8], 0.0,
        view[1], view[5], view[9], 0.0,
        view[2], view[6], view[10], 0.0,
        0.0, 0.0, 0.0, 1.0,
    )
    val t = mat4Translation(world[12], world[13], world[14])
    return modelMatrix(mat4Multiply(t, rotation), doubleArrayOf(width * scale, height * scale, 1.0))
}

// ── the pixel pipeline ───────────────────────────────────────────────────────────────

private fun packArgb(r: Double, g: Double, b: Double): Int {
    fun channel(v: Double): Int = (min(1.0, max(0.0, v)) * 255.0 + 0.5).toInt().coerceIn(0, 255)
    return (0xFF shl 24) or (channel(r) shl 16) or (channel(g) shl 8) or channel(b)
}

/**
 * Render a resolved scene into a width×height ARGB framebuffer. Every number rides the
 * corpus law (worldMatrices · sceneCamera · sceneLighting · text3dQuad · parseGlb);
 * malformed colors fall back with one diagnostic exactly like the web renderer
 * (Article 7). P4 assets (textures, models, text rasters) arrive through [assets] —
 * a null/absent asset simply doesn't draw. mode="ar" and <anchor> paint nothing here —
 * the consuming element owns the honest labelled placeholder overlay.
 */
fun rasterizeScene(
    ir: SceneIR, resolve: SceneResolve, width: Int, height: Int, assets: SceneAssets? = null,
    diag: SceneDiag? = null, spriteClockSeconds: Double = 0.0,
): IntArray {
    val w = max(1, width); val h = max(1, height)
    val pixels = IntArray(w * h)
    val zbuffer = FloatArray(w * h) { Float.POSITIVE_INFINITY }

    val backgroundRaw = ir.attrs["background"]?.let { resolve(null, "background", it) } ?: "#000000"
    var background = parseSceneColor(backgroundRaw)
    if (background == null) {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_NUMBER,
            "background=\"$backgroundRaw\" is not a #hex color — using #000000",
        ))
        background = doubleArrayOf(0.0, 0.0, 0.0)
    }
    pixels.fill(packArgb(background[0], background[1], background[2]))

    val aspect = w.toDouble() / h.toDouble()
    val camera = sceneCamera(ir, resolve, aspect, diag)
    val lighting = sceneLighting(ir, resolve, diag)
    val ambientColor = parseSceneColor(lighting.ambientColor) ?: doubleArrayOf(1.0, 1.0, 1.0)
    val directionalColor = parseSceneColor(lighting.directionalColor) ?: doubleArrayOf(1.0, 1.0, 1.0)
    // the web uniforms verbatim: uAmbient = ambientColor·ambientIntensity,
    // uLightColor = directionalColor·(direction == null ? 0 : directionalIntensity)
    val ambient = DoubleArray(3) { ambientColor[it] * lighting.ambientIntensity }
    val lightScale = if (lighting.direction == null) 0.0 else lighting.directionalIntensity
    val lightColor = DoubleArray(3) { directionalColor[it] * lightScale }
    val lightDir = vec3Normalize(lighting.direction ?: doubleArrayOf(0.0, 1.0, 0.0))
    // P5: point lights (≤4, kernel-capped — the pinned window²/(1+d²) falloff) and
    // linear fog, both evaluated PER PIXEL against the interpolated world position
    // (the web fragment shader's plane; the flat per-triangle normal stays the raster's
    // P2 stance)
    val points = lighting.points.map { p ->
        ScenePointLightResolved(
            p.position, parseSceneColor(p.color) ?: doubleArrayOf(1.0, 1.0, 1.0), p.intensity, p.range,
        )
    }
    val fog = sceneFog(ir, resolve, diag)
    val fogColor: Vec3? = fog?.let { parseSceneColor(it.color) ?: doubleArrayOf(0.0, 0.0, 0.0) }
    val fogNear = fog?.near ?: 0.0
    val fogFar = fog?.far ?: 0.0
    val pv = mat4Multiply(camera.proj, camera.view)
    val eye = camera.eye

    fun nodeColor(props: SceneNodeProps): Vec3 {
        val color = parseSceneColor(props.color)
        if (color != null) return color
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_NUMBER,
            "color=\"${props.color}\" is not a #hex color — using #ffffff",
        ))
        return doubleArrayOf(1.0, 1.0, 1.0)
    }

    val worlds = worldMatrices(ir.nodes, resolve, diag)
    // G6 THE 2D DRAW-ORDER LAW: inside mode="2d" z IS the draw order — paint world z
    // ASCENDING (stable, document order breaking ties) with the z-buffer OFF, so a
    // higher z lands in front and coplanar sprites never fight. 3D keeps the z-buffer.
    val painter = ir.mode == SceneMode.TWO_D
    val entries = worlds.entries.toList()
    val drawList = if (!painter) entries
    else sceneDrawOrder2d(entries.map { it.value[14] }).map { entries[it] }
    val depthTest = !painter
    for ((node, world) in drawList.map { it.key to it.value }) {
        val props = resolvedProps(node, resolve, diag)
        when (node.kind) {
            SceneNodeKind.SPRITE -> {
                // G6 THE QUAD LAW: a textured quad in the node's LOCAL XY plane facing
                // +Z, riding the node's world transform (in mode="2d" the orthographic
                // camera looks down −Z, so that IS camera-facing; billboarding in 3D is
                // a named absence). model = world · T(anchor offset) · S(w, h, 1).
                val texture = if (props.src.isEmpty()) null else assets?.texture(props.src)
                // an authored src draws NOTHING until its texture arrives (the <model>
                // posture); a src-less sprite is an honest flat `color` rectangle
                if (props.src.isNotEmpty() && texture == null) continue
                val aspect = if (texture != null && texture.height > 0)
                    texture.width.toDouble() / texture.height.toDouble() else null
                val size = spriteSizeOf(props, aspect)
                val frame = spriteFrameAt(props, spriteClockSeconds)
                val offset = spriteAnchorOffset(props, size[0], size[1])
                val model = modelMatrix(
                    mat4Multiply(world, mat4Trs(offset, doubleArrayOf(0.0, 0.0, 0.0), doubleArrayOf(1.0, 1.0, 1.0))),
                    doubleArrayOf(size[0], size[1], 1.0),
                )
                val geometry = if (texture == null) PLANE else spritePlaneTriangles(spriteUvRect(props, frame))
                rasterizeTriangles(geometry, model, pv, eye, nodeColor(props), ambient, lightColor,
                    lightDir, twoSided = true, texture = texture, cutout = texture != null,
                    unlit = false, points = points, fogColor = fogColor,
                    fogNear = fogNear, fogFar = fogFar, depthTest = depthTest,
                    pixels = pixels, zbuffer = zbuffer, w = w, h = h)
            }
            SceneNodeKind.BOX, SceneNodeKind.SPHERE, SceneNodeKind.PLANE -> {
                val geometry = when (node.kind) {
                    SceneNodeKind.BOX -> BOX
                    SceneNodeKind.SPHERE -> SPHERE
                    else -> PLANE
                }
                val scale = geometryScale(node, props) ?: continue
                val model = modelMatrix(world, scale)
                val texture = if (props.texture.isNotEmpty()) assets?.texture(props.texture) else null
                rasterizeTriangles(geometry, model, pv, eye, nodeColor(props), ambient, lightColor,
                    lightDir, twoSided = node.kind == SceneNodeKind.PLANE, texture = texture,
                    cutout = false, unlit = false, points = points, fogColor = fogColor,
                    fogNear = fogNear, fogFar = fogFar, depthTest = depthTest,
                    pixels = pixels, zbuffer = zbuffer, w = w, h = h)
            }
            SceneNodeKind.MODEL -> {
                // P4: the GLB draw list — model = sceneWorld · draw.world, flat facets,
                // baseColorFactor × the node color (default white). G3: a sampled clip
                // pose (the element's mixer through the seam) recomputes the node
                // worlds — animated transforms move unskinned draws too — and CPU-skins
                // JOINTS_0/WEIGHTS_0 draws BEFORE rasterization (the web renderer's
                // shape; the pose-less path stays byte-identical to P4).
                if (props.src.isEmpty()) continue
                val glb = assets?.model(props.src) ?: continue
                val color = nodeColor(props)
                val pose = assets?.pose(node)
                val poseWorlds = if (pose != null) glbNodeWorlds(glb, pose) else null
                for (draw in glb.draws) {
                    val mesh = glb.meshes.getOrNull(draw.mesh) ?: continue
                    val drawWorld = poseWorlds?.getOrNull(draw.node) ?: draw.world
                    val model = mat4Multiply(world, drawWorld)
                    val skinMatrices = if (poseWorlds != null && draw.skin != null)
                        glbJointMatrices(glb, draw.skin, draw.node, poseWorlds) else null
                    for (primitive in mesh.primitives) {
                        val soup = if (skinMatrices != null) {
                            val skinned = skinnedPrimitivePositions(primitive, skinMatrices)
                            if (skinned != null) skinnedTriangles(primitive, skinned)
                            else primitiveTriangles(primitive)
                        } else primitiveTriangles(primitive)
                        if (soup == null) continue
                        val shaded = doubleArrayOf(
                            color[0] * primitive.baseColor[0],
                            color[1] * primitive.baseColor[1],
                            color[2] * primitive.baseColor[2],
                        )
                        rasterizeTriangles(soup, model, pv, eye, shaded, ambient, lightColor,
                            lightDir, twoSided = false, texture = null, cutout = false,
                            unlit = false, points = points, fogColor = fogColor,
                            fogNear = fogNear, fogFar = fogFar,
                            pixels = pixels, zbuffer = zbuffer, w = w, h = h)
                    }
                }
            }
            SceneNodeKind.TEXT3D -> {
                // P4: the corpus quad law on a billboard, UNLIT, alpha-cutout glyphs
                val quad = text3dQuad(props) ?: continue
                val characters = props.value.codePointCount(0, props.value.length)
                val widthPx = max(1, Math.round(SCENE_TEXT3D_RASTER_HEIGHT * TEXT3D_ADVANCE * characters).toInt())
                val texture = assets?.text(props.value, widthPx, SCENE_TEXT3D_RASTER_HEIGHT) ?: continue
                val model = sceneBillboardMatrix(world, camera.view, quad.halfWidth * 2, quad.halfHeight * 2)
                rasterizeTriangles(PLANE, model, pv, eye, nodeColor(props), ambient, lightColor,
                    lightDir, twoSided = true, texture = texture, cutout = true, unlit = true,
                    points = points, fogColor = fogColor, fogNear = fogNear, fogFar = fogFar,
                    depthTest = depthTest, pixels = pixels, zbuffer = zbuffer, w = w, h = h)
            }
            else -> continue
        }
    }
    return pixels
}

/** a GLB primitive → de-indexed triangle soup (flat facets — the raster's P2 stance;
 *  no UVs, model textures are a named absence). Null for a degenerate primitive. */
private fun primitiveTriangles(primitive: GlbPrimitive): SceneTriangles? =
    positionsTriangles(primitive.indices, primitive.positions)

/** the G3 skinned variant: the SAME de-index over CPU-skinned positions */
private fun skinnedTriangles(primitive: GlbPrimitive, skinned: DoubleArray): SceneTriangles? =
    positionsTriangles(primitive.indices, skinned)

private fun positionsTriangles(indices: IntArray, positions: DoubleArray): SceneTriangles? {
    if (indices.size < 3) return null
    val triangleCount = indices.size / 3
    val vertices = DoubleArray(triangleCount * 9)
    for (t in 0 until triangleCount) {
        for (i in 0 until 3) {
            val vertex = indices[t * 3 + i]
            if (vertex * 3 + 2 >= positions.size) return null
            vertices[t * 9 + i * 3] = positions[vertex * 3]
            vertices[t * 9 + i * 3 + 1] = positions[vertex * 3 + 1]
            vertices[t * 9 + i * 3 + 2] = positions[vertex * 3 + 2]
        }
    }
    return SceneTriangles(vertices, DoubleArray(triangleCount * 6))
}

@Suppress("LongParameterList")
private fun rasterizeTriangles(
    geometry: SceneTriangles, model: Mat4, pv: Mat4, eye: Vec3,
    color: Vec3, ambient: DoubleArray, lightColor: DoubleArray, lightDir: Vec3,
    twoSided: Boolean, texture: SceneTexture?, cutout: Boolean, unlit: Boolean,
    points: List<ScenePointLightResolved>, fogColor: Vec3?, fogNear: Double, fogFar: Double,
    pixels: IntArray, zbuffer: FloatArray, w: Int, h: Int, depthTest: Boolean = true,
) {
    val v = geometry.vertices
    val worldV = DoubleArray(9)
    for (t in 0 until geometry.count) {
        // model is affine (bottom row 0 0 0 1): transform the three vertices to world
        for (i in 0 until 3) {
            val x = v[t * 9 + i * 3]; val y = v[t * 9 + i * 3 + 1]; val z = v[t * 9 + i * 3 + 2]
            worldV[i * 3] = model[0] * x + model[4] * y + model[8] * z + model[12]
            worldV[i * 3 + 1] = model[1] * x + model[5] * y + model[9] * z + model[13]
            worldV[i * 3 + 2] = model[2] * x + model[6] * y + model[10] * z + model[14]
        }
        val a = doubleArrayOf(worldV[0], worldV[1], worldV[2])
        val b = doubleArrayOf(worldV[3], worldV[4], worldV[5])
        val c = doubleArrayOf(worldV[6], worldV[7], worldV[8])
        // flat face normal from the WORLD triangle (geometrically exact under any scale)
        var n = vec3Normalize(vec3Cross(vec3Sub(b, a), vec3Sub(c, a)))
        if (vec3Length(n) == 0.0) continue                               // degenerate
        val centroid = doubleArrayOf((a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0)
        val toEye = vec3Sub(eye, centroid)
        val facing = vec3Dot(n, toEye)
        if (facing < 0.0) {
            // back face: cull closed geometry; a plane shades from either side with the
            // normal flipped toward the eye (the web fragment shader's two-sided rule)
            if (!twoSided) continue
            n = doubleArrayOf(-n[0], -n[1], -n[2])
        }
        val diffuse = max(0.0, vec3Dot(n, lightDir))
        // the per-triangle material factor: lit Lambert, or the raw color when unlit
        // (text3d stays legible); a texel multiplies it per pixel
        val factorR = if (unlit) color[0] else color[0] * (ambient[0] + lightColor[0] * diffuse)
        val factorG = if (unlit) color[1] else color[1] * (ambient[1] + lightColor[1] * diffuse)
        val factorB = if (unlit) color[2] else color[2] * (ambient[2] + lightColor[2] * diffuse)
        // clip via proj·view; drop triangles crossing/behind the near plane (v0 — no
        // polygon clipping; scenes frame their content, and the corpus pins the math)
        val sx = DoubleArray(3); val sy = DoubleArray(3); val sz = DoubleArray(3)
        val invW = DoubleArray(3)
        var behind = false
        for (i in 0 until 3) {
            val x = worldV[i * 3]; val y = worldV[i * 3 + 1]; val z = worldV[i * 3 + 2]
            val cw = pv[3] * x + pv[7] * y + pv[11] * z + pv[15]
            if (cw <= 1e-9) { behind = true; break }
            val cx = (pv[0] * x + pv[4] * y + pv[8] * z + pv[12]) / cw
            val cy = (pv[1] * x + pv[5] * y + pv[9] * z + pv[13]) / cw
            val cz = (pv[2] * x + pv[6] * y + pv[10] * z + pv[14]) / cw
            sx[i] = (cx + 1.0) / 2.0 * w
            sy[i] = (1.0 - cy) / 2.0 * h
            sz[i] = cz
            invW[i] = 1.0 / cw
        }
        if (behind) continue
        // the P5 per-pixel plane (point lights + fog) engages only when authored — a
        // P1-shaped scene keeps its exact pre-P5 fill paths (and pixels)
        val shaded = points.isNotEmpty() || fogColor != null
        if (shaded) {
            val shade = ScenePixelShade(
                worldV = worldV, invW = invW, normal = n,
                color = color, ambient = ambient, lightColor = lightColor,
                diffuse = diffuse, unlit = unlit, points = points,
                fogColor = fogColor, fogNear = fogNear, fogFar = fogFar, eye = eye,
            )
            if (texture == null) {
                fillTriangleShaded(sx, sy, sz, shade, null, null, null, false, pixels, zbuffer, w, h, depthTest)
            } else {
                val u = doubleArrayOf(geometry.uvs[t * 6], geometry.uvs[t * 6 + 2], geometry.uvs[t * 6 + 4])
                val uvV = doubleArrayOf(geometry.uvs[t * 6 + 1], geometry.uvs[t * 6 + 3], geometry.uvs[t * 6 + 5])
                fillTriangleShaded(sx, sy, sz, shade, u, uvV, texture, cutout, pixels, zbuffer, w, h, depthTest)
            }
        } else if (texture == null) {
            fillTriangleFlat(sx, sy, sz, packArgb(factorR, factorG, factorB), pixels, zbuffer, w, h, depthTest)
        } else {
            val u = doubleArrayOf(geometry.uvs[t * 6], geometry.uvs[t * 6 + 2], geometry.uvs[t * 6 + 4])
            val uvV = doubleArrayOf(geometry.uvs[t * 6 + 1], geometry.uvs[t * 6 + 3], geometry.uvs[t * 6 + 5])
            fillTriangleTextured(sx, sy, sz, invW, u, uvV, texture, cutout,
                factorR, factorG, factorB, pixels, zbuffer, w, h, depthTest)
        }
    }
}

// ── the P5 per-pixel shading path (point lights + fog — the web shader's plane) ──────

/** everything one triangle's pixels need for the P5 fold: the three WORLD vertices +
 *  1/w for perspective-correct position interpolation, the flat face normal (already
 *  eye-flipped), the material factors, the resolved point lights, and the fog words */
@Suppress("LongParameterList")
private class ScenePixelShade(
    val worldV: DoubleArray, val invW: DoubleArray, val normal: Vec3,
    val color: Vec3, val ambient: DoubleArray, val lightColor: DoubleArray,
    val diffuse: Double, val unlit: Boolean,
    val points: List<ScenePointLightResolved>,
    val fogColor: Vec3?, val fogNear: Double, val fogFar: Double,
    val eye: Vec3,
)

/** the P5 fill: per-pixel world position (perspective-correct), the pinned point-light
 *  fold (Σ colorᵢ·intensityᵢ·att(dᵢ)·max(0, n·Lᵢ) — scenePointAttenuation verbatim),
 *  clamp, then linear fog (f·c + (1−f)·fogColor with d = |eye − world|). The texel
 *  MODULATES before the clamp exactly like the web shader; cutout skips alpha < 128
 *  texels without writing depth. */
@Suppress("LongParameterList")
private fun fillTriangleShaded(
    sx: DoubleArray, sy: DoubleArray, sz: DoubleArray, shade: ScenePixelShade,
    u: DoubleArray?, v: DoubleArray?, texture: SceneTexture?, cutout: Boolean,
    pixels: IntArray, zbuffer: FloatArray, w: Int, h: Int, depthTest: Boolean = true,
) {
    val invW = shade.invW
    val worldV = shade.worldV
    val xOverW = doubleArrayOf(worldV[0] * invW[0], worldV[3] * invW[1], worldV[6] * invW[2])
    val yOverW = doubleArrayOf(worldV[1] * invW[0], worldV[4] * invW[1], worldV[7] * invW[2])
    val zOverW = doubleArrayOf(worldV[2] * invW[0], worldV[5] * invW[1], worldV[8] * invW[2])
    val uOverW = if (texture != null && u != null)
        doubleArrayOf(u[0] * invW[0], u[1] * invW[1], u[2] * invW[2]) else null
    val vOverW = if (texture != null && v != null)
        doubleArrayOf(v[0] * invW[0], v[1] * invW[1], v[2] * invW[2]) else null
    val n = shade.normal
    walkTriangle(sx, sy, sz, zbuffer, w, h, depthTest) { index, z, l0, l1, l2 ->
        val iw = l0 * invW[0] + l1 * invW[1] + l2 * invW[2]
        if (iw > 0.0) {
            var texR = 1.0
            var texG = 1.0
            var texB = 1.0
            var covered = true
            if (texture != null && uOverW != null && vOverW != null) {
                val su = (l0 * uOverW[0] + l1 * uOverW[1] + l2 * uOverW[2]) / iw
                val sv = (l0 * vOverW[0] + l1 * vOverW[1] + l2 * vOverW[2]) / iw
                val tx = kotlin.math.floor(su * texture.width).toInt().coerceIn(0, texture.width - 1)
                val ty = kotlin.math.floor(sv * texture.height).toInt().coerceIn(0, texture.height - 1)
                val texel = texture.pixels[ty * texture.width + tx]
                if (cutout && (texel ushr 24) < 128) covered = false
                else {
                    texR = (texel shr 16 and 0xFF) / 255.0
                    texG = (texel shr 8 and 0xFF) / 255.0
                    texB = (texel and 0xFF) / 255.0
                }
            }
            if (covered) {
                // perspective-correct world position at this pixel
                val px = (l0 * xOverW[0] + l1 * xOverW[1] + l2 * xOverW[2]) / iw
                val py = (l0 * yOverW[0] + l1 * yOverW[1] + l2 * yOverW[2]) / iw
                val pz = (l0 * zOverW[0] + l1 * zOverW[1] + l2 * zOverW[2]) / iw
                // Σᵢ colorᵢ · intensityᵢ · att(dᵢ) · max(0, n·Lᵢ) — the pinned laws
                var plR = 0.0
                var plG = 0.0
                var plB = 0.0
                for (p in shade.points) {
                    val tx2 = p.position[0] - px
                    val ty2 = p.position[1] - py
                    val tz2 = p.position[2] - pz
                    val d = kotlin.math.sqrt(tx2 * tx2 + ty2 * ty2 + tz2 * tz2)
                    if (d <= 0.0) continue
                    val lambert = max(0.0, (n[0] * tx2 + n[1] * ty2 + n[2] * tz2) / d)
                    val factor = p.intensity * scenePointAttenuation(d, p.range) * lambert
                    plR += p.color[0] * factor
                    plG += p.color[1] * factor
                    plB += p.color[2] * factor
                }
                var r = if (shade.unlit) shade.color[0]
                else shade.color[0] * (shade.ambient[0] + shade.lightColor[0] * shade.diffuse + plR)
                var g = if (shade.unlit) shade.color[1]
                else shade.color[1] * (shade.ambient[1] + shade.lightColor[1] * shade.diffuse + plG)
                var b = if (shade.unlit) shade.color[2]
                else shade.color[2] * (shade.ambient[2] + shade.lightColor[2] * shade.diffuse + plB)
                r = min(1.0, r * texR)
                g = min(1.0, g * texG)
                b = min(1.0, b * texB)
                val fogColor = shade.fogColor
                if (fogColor != null && shade.fogFar > shade.fogNear) {
                    val dx = shade.eye[0] - px
                    val dy = shade.eye[1] - py
                    val dz = shade.eye[2] - pz
                    val f = sceneFogFactor(kotlin.math.sqrt(dx * dx + dy * dy + dz * dz), shade.fogNear, shade.fogFar)
                    r = f * r + (1.0 - f) * fogColor[0]
                    g = f * g + (1.0 - f) * fogColor[1]
                    b = f * b + (1.0 - f) * fogColor[2]
                }
                zbuffer[index] = z
                pixels[index] = packArgb(r, g, b)
            }
        }
    }
}

/** the barycentric edge-function walk shared by both fill paths — invokes [plot] with
 *  the classic (λ0, λ1, λ2) for every covered, depth-passing pixel */
private inline fun walkTriangle(
    sx: DoubleArray, sy: DoubleArray, sz: DoubleArray,
    zbuffer: FloatArray, w: Int, h: Int, depthTest: Boolean = true,
    plot: (index: Int, z: Float, l0: Double, l1: Double, l2: Double) -> Unit,
) {
    val area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0])
    if (area == 0.0 || !area.isFinite()) return
    val minX = max(0, kotlin.math.floor(min(sx[0], min(sx[1], sx[2]))).toInt())
    val maxX = min(w - 1, kotlin.math.ceil(max(sx[0], max(sx[1], sx[2]))).toInt())
    val minY = max(0, kotlin.math.floor(min(sy[0], min(sy[1], sy[2]))).toInt())
    val maxY = min(h - 1, kotlin.math.ceil(max(sy[0], max(sy[1], sy[2]))).toInt())
    if (minX > maxX || minY > maxY) return
    for (py in minY..maxY) {
        val yc = py + 0.5
        for (px in minX..maxX) {
            val xc = px + 0.5
            // barycentric via edge functions (sign-normalized by the total area, so both
            // windings fill — culling already happened in world space)
            val w0 = ((sx[1] - sx[0]) * (yc - sy[0]) - (xc - sx[0]) * (sy[1] - sy[0])) / area
            val w1 = ((sx[2] - sx[1]) * (yc - sy[1]) - (xc - sx[1]) * (sy[2] - sy[1])) / area
            val w2 = ((sx[0] - sx[2]) * (yc - sy[2]) - (xc - sx[2]) * (sy[0] - sy[2])) / area
            if (w0 < 0.0 || w1 < 0.0 || w2 < 0.0) continue
            // barycentric weights: w1 belongs to vertex 0's opposite edge fold — recover
            // the classic (λ0, λ1, λ2) from the three edge functions
            val l0 = w1; val l1 = w2; val l2 = w0
            val z = l0 * sz[0] + l1 * sz[1] + l2 * sz[2]
            if (z < -1.0 || z > 1.0) continue                           // outside near/far
            val index = py * w + px
            // G6: the painter's algorithm (mode="2d") skips the test — the draw ORDER
            // decides, so coplanar sprites layer by z instead of z-fighting
            if (depthTest && z.toFloat() >= zbuffer[index]) continue     // z-buffer: nearer wins
            plot(index, z.toFloat(), l0, l1, l2)
        }
    }
}

private fun fillTriangleFlat(
    sx: DoubleArray, sy: DoubleArray, sz: DoubleArray, argb: Int,
    pixels: IntArray, zbuffer: FloatArray, w: Int, h: Int, depthTest: Boolean = true,
) {
    walkTriangle(sx, sy, sz, zbuffer, w, h, depthTest) { index, z, _, _, _ ->
        zbuffer[index] = z
        pixels[index] = argb
    }
}

/** perspective-correct UV interpolation (u/w, v/w, 1/w per vertex), NEAREST sampling
 *  clamped to the edge, texel × material factor; cutout skips alpha < 128 texels
 *  WITHOUT writing depth (glyph holes stay transparent) — the UV law's sampling half */
@Suppress("LongParameterList")
private fun fillTriangleTextured(
    sx: DoubleArray, sy: DoubleArray, sz: DoubleArray, invW: DoubleArray,
    u: DoubleArray, v: DoubleArray, texture: SceneTexture, cutout: Boolean,
    factorR: Double, factorG: Double, factorB: Double,
    pixels: IntArray, zbuffer: FloatArray, w: Int, h: Int, depthTest: Boolean = true,
) {
    val uOverW = doubleArrayOf(u[0] * invW[0], u[1] * invW[1], u[2] * invW[2])
    val vOverW = doubleArrayOf(v[0] * invW[0], v[1] * invW[1], v[2] * invW[2])
    walkTriangle(sx, sy, sz, zbuffer, w, h, depthTest) { index, z, l0, l1, l2 ->
        val iw = l0 * invW[0] + l1 * invW[1] + l2 * invW[2]
        if (iw > 0.0) {
            val su = (l0 * uOverW[0] + l1 * uOverW[1] + l2 * uOverW[2]) / iw
            val sv = (l0 * vOverW[0] + l1 * vOverW[1] + l2 * vOverW[2]) / iw
            val tx = kotlin.math.floor(su * texture.width).toInt().coerceIn(0, texture.width - 1)
            val ty = kotlin.math.floor(sv * texture.height).toInt().coerceIn(0, texture.height - 1)
            val texel = texture.pixels[ty * texture.width + tx]
            val alpha = texel ushr 24
            if (!cutout || alpha >= 128) {
                zbuffer[index] = z
                pixels[index] = packArgb(
                    factorR * ((texel shr 16 and 0xFF) / 255.0),
                    factorG * ((texel shr 8 and 0xFF) / 255.0),
                    factorB * ((texel and 0xFF) / 255.0),
                )
            }
        }
    }
}
