package despia.engine.scene

import despia.engine.StackXML
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * SceneRaster.kt units — the pixel gate for the ONE software rasterizer both JVM `<scene>`
 * surfaces paint (Android :render Bitmap · desktop Skia ImageBitmap). The corpus pins the
 * MATH (SceneConformanceTest); these tests pin what the corpus cannot: non-blank output,
 * reactive re-rasterization through a changed resolve value, relative screen geometry
 * (the silhouette lands in the expected quadrant), and z-buffer occlusion. Every markup
 * fixture parses through StackXML.parse — the runtime's own parser, never a second one.
 *
 * Every assertion message names the sampled coordinate and the pixel it saw (the
 * DesktopRendererUiTest lesson): a bare failure at the call line costs a blind rerun.
 */
class SceneRasterTest {

    private fun scene(markup: String): SceneIR {
        val root = StackXML.parse(markup)
        assertNotNull(root, "fixture markup must parse")
        return parseScene(root, diag = { d -> error("unexpected parse diagnostic: ${d.message}") })
    }

    private fun mapResolver(vars: Map<String, Any?> = emptyMap()): SceneResolve =
        { _, _, raw -> interpolateSceneHoles(raw) { expr -> vars[expr] } }

    private fun hex(argb: Int): String = "#%08X".format(argb)

    // ── non-blank: the corpus-derived proposal scene actually paints ─────────────────

    @Test
    fun proposalSceneRendersNonBlank() {
        // the dsx-scene.md §2 example, minus the P3/P4 kinds — the same rig the web
        // screenshot walk drives
        val ir = scene(
            """
            <scene mode="3d" background="#0b1020">
              <camera position="0 1.5 4" look-at="0 0 0" fov="60"/>
              <light kind="ambient" intensity="0.4"/>
              <light kind="directional" position="3 5 2" intensity="0.8"/>
              <group id="rig" rotation="0 30 0">
                <box position="-1 0 0" size="1 1 1" color="#2563eb"/>
                <sphere position="1 0 0" radius="0.5" color="#f59e0b"/>
                <plane position="0 -0.5 0" size="10 10" rotation="-90 0 0" color="#1e293b"/>
              </group>
            </scene>
            """.trimIndent(),
        )
        val w = 320; val h = 180
        val pixels = rasterizeScene(ir, mapResolver(), w, h)
        val colors = pixels.toSet()
        // background + lit plane + box faces + many sphere facets — a blank/one-fill
        // buffer means the pipeline never drew
        assertTrue(colors.size >= 8,
            "corpus-derived scene should rasterize many shades at ${w}x$h, saw ${colors.size} " +
                "distinct color(s): ${colors.take(8).joinToString { hex(it) }}")
        val background = pixels[0]
        assertTrue(pixels.count { it != background } > (w * h) / 20,
            "geometry should cover more than 5% of the ${w}x$h frame; background=${hex(background)}")
    }

    // ── relative geometry: a known camera/box setup lands in the expected quadrant ───

    @Test
    fun boxSilhouetteLandsInTheUpperRightQuadrant() {
        // camera default (0 0 5) → origin; box centered at (1.2, 1.2, 0). Projected center:
        // ndc = cot(30°)·1.2/5 ≈ (0.4157, 0.4157) → screen ≈ (141.6, 58.4) on 200×200 —
        // the upper-right quadrant. No lights → full-ambient default, so the box paints
        // its EXACT authored color.
        val ir = scene(
            """
            <scene background="#000000">
              <box position="1.2 1.2 0" size="1 1 1" color="#ff0000"/>
            </scene>
            """.trimIndent(),
        )
        val w = 200; val h = 200
        val pixels = rasterizeScene(ir, mapResolver(), w, h)
        val red = 0xFFFF0000.toInt()
        val black = 0xFF000000.toInt()
        fun at(x: Int, y: Int) = pixels[y * w + x]
        assertEquals(red, at(141, 58),
            "projected box center (141, 58) should be the exact ambient-lit box color, saw ${hex(at(141, 58))}")
        assertEquals(black, at(5, 195),
            "bottom-left corner (5, 195) should be untouched background, saw ${hex(at(5, 195))}")
        assertEquals(black, at(50, 150),
            "the opposite (lower-left) quadrant (50, 150) should be background, saw ${hex(at(50, 150))}")
        assertEquals(black, at(100, 100),
            "the frame center (100, 100) sits outside the off-axis box, saw ${hex(at(100, 100))}")
    }

    // ── reactivity: a changed resolve value re-rasterizes to different pixels ────────

    @Test
    fun changedResolveValueChangesTheFramebuffer() {
        val ir = scene(
            """
            <scene background="#0b1020">
              <camera position="0 1 4" look-at="0 0 0"/>
              <light kind="ambient" intensity="0.4"/>
              <light kind="directional" position="3 5 2" intensity="0.8"/>
              <box rotation="0 {{ spin }} 0" size="1 1 1" color="#2563eb"/>
            </scene>
            """.trimIndent(),
        )
        val w = 160; val h = 90
        val zero = rasterizeScene(ir, mapResolver(mapOf("spin" to 0)), w, h)
        val again = rasterizeScene(ir, mapResolver(mapOf("spin" to 0)), w, h)
        assertTrue(zero.contentEquals(again),
            "the rasterizer must be deterministic: identical resolve values → identical pixels")
        val spun = rasterizeScene(ir, mapResolver(mapOf("spin" to 45)), w, h)
        assertTrue(!zero.contentEquals(spun),
            "spin 0 → 45 must change the ${w}x$h framebuffer (the reactive-store contract: " +
                "a written hole re-renders)")
    }

    // ── z-buffer: the near box occludes the far one regardless of document order ─────

    @Test
    fun zBufferLetsTheNearBoxOccludeTheFarOne() {
        // red at z=1 (near, small), blue at z=-2 (far, wide). Red is authored FIRST, so a
        // painter's-algorithm bug would overdraw it with blue; the z-buffer must keep red
        // at the overlapping center pixel while blue still shows where only it projects.
        val ir = scene(
            """
            <scene background="#000000">
              <box id="near" position="0 0 1" size="1 1 1" color="#ff0000"/>
              <box id="far" position="0 0 -2" size="3 3 1" color="#0000ff"/>
            </scene>
            """.trimIndent(),
        )
        val w = 200; val h = 200
        val pixels = rasterizeScene(ir, mapResolver(), w, h)
        val red = 0xFFFF0000.toInt()
        val blue = 0xFF0000FF.toInt()
        fun at(x: Int, y: Int) = pixels[y * w + x]
        // red front face spans ndc ±cot30°·0.5/4 ≈ ±0.2165 → x,y ∈ [78.3, 121.7]
        assertEquals(red, at(100, 100),
            "overlapping center (100, 100) must keep the NEAR box (z-buffer), saw ${hex(at(100, 100))}")
        // blue spans ndc ±cot30°·1.5/7 ≈ ±0.371 → x ∈ [62.9, 137.1]; (130, 100) is blue-only
        assertEquals(blue, at(130, 100),
            "blue-only column (130, 100) must show the far box, saw ${hex(at(130, 100))}")
        assertEquals(0xFF000000.toInt(), at(10, 10),
            "corner (10, 10) must stay background, saw ${hex(at(10, 10))}")
    }

    // ── picking rides the same kernel: the shared pickSceneNode helper ───────────────

    @Test
    fun pickSceneNodeHitsTheNodeUnderTheNdcPoint() {
        val ir = scene(
            """
            <scene background="#0b1020">
              <camera position="0 0 5" look-at="0 0 0"/>
              <box id="left" position="-1.2 0 0" size="1 1 1"/>
              <sphere id="right" position="1.2 0 0" radius="0.5"/>
            </scene>
            """.trimIndent(),
        )
        val resolve = mapResolver()
        // box center at ndc x = -cot30°·1.2/5 ≈ -0.4157
        val hitLeft = pickSceneNode(ir, resolve, 1.0, -0.4157, 0.0)
        assertEquals("left", hitLeft?.id, "the pick at the box's projected center hits the box")
        val hitRight = pickSceneNode(ir, resolve, 1.0, 0.4157, 0.0)
        assertEquals("right", hitRight?.id, "the pick at the sphere's projected center hits the sphere")
        val miss = pickSceneNode(ir, resolve, 1.0, 0.0, 0.9)
        assertEquals(null, miss, "a pick far above both shapes misses")
        // the filter is the element's handler gate: excluding the sphere re-routes the hit
        val filtered = pickSceneNode(ir, resolve, 1.0, 0.4157, 0.0) { it.id != "right" }
        assertNotEquals("right", filtered?.id ?: "", "a filtered-out node can never be picked")
    }

    // ── P4: textures — the UV law's pixel evidence ───────────────────────────────────

    @Test
    fun texturedBoxShowsDistinctTexelColorsWhereFlatShowedOne() {
        // camera default (0 0 5) → origin, no lights → full ambient, white box: the
        // front face paints EXACT texels. 2×2 texture, bottom row red|blue (v=0.5 →
        // row 1 under the README law: v = 0.5 − y_face, texel row 0 = image top).
        val red = 0xFFFF0000.toInt(); val blue = 0xFF0000FF.toInt()
        val white = 0xFFFFFFFF.toInt()
        val checker = SceneTexture(intArrayOf(white, white, red, blue), 2, 2)
        val assets = object : SceneAssets {
            override fun texture(url: String): SceneTexture? = if (url == "checker.png") checker else null
        }
        val markup = { texture: String ->
            """<scene background="#000000"><box size="1 1 1" color="#ffffff"$texture/></scene>"""
        }
        val w = 200; val h = 200
        // front face spans ndc ±cot30°·0.5/4.5 ≈ ±0.1925 → screen x ∈ [80.8, 119.2]
        val flat = rasterizeScene(scene(markup("")), mapResolver(), w, h, assets)
        val textured = rasterizeScene(scene(markup(""" texture="checker.png"""")), mapResolver(), w, h, assets)
        fun at(pixels: IntArray, x: Int, y: Int) = pixels[y * w + x]
        assertEquals(at(flat, 90, 100), at(flat, 110, 100),
            "the flat box face is ONE color at (90,100)/(110,100), saw ${hex(at(flat, 90, 100))} vs ${hex(at(flat, 110, 100))}")
        assertEquals(red, at(textured, 90, 100),
            "textured face left half (90,100) samples texel row1/col0 = red, saw ${hex(at(textured, 90, 100))}")
        assertEquals(blue, at(textured, 110, 100),
            "textured face right half (110,100) samples texel row1/col1 = blue, saw ${hex(at(textured, 110, 100))}")
        assertNotEquals(at(textured, 90, 100), at(textured, 110, 100),
            "the textured face shows ≥2 distinct sampled colors where flat showed 1")
    }

    // ── P4: a model triangle lands at its corpus-computed screen position ────────────

    @Test
    fun modelTriangleRendersAtItsCorpusComputedScreenPosition() {
        // the corpus triangle (0,0,0)(1,0,0)(0,1,0), identity draw, default camera
        // (0 0 5) fov 60 at 200×200: v0 → (100,100), v1 → (134.64,100), v2 → (100,65.36)
        // (the projection.json law: ndc = cot(30°)·x/5). baseColor red × white node color
        // under full ambient → the EXACT base color inside the silhouette.
        val model = GlbModel(
            meshes = listOf(GlbMesh(listOf(GlbPrimitive(
                positions = doubleArrayOf(0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0),
                normals = doubleArrayOf(0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0),
                indices = intArrayOf(0, 1, 2),
                baseColor = doubleArrayOf(1.0, 0.0, 0.0, 1.0),
            )))),
            draws = listOf(GlbDraw(0, mat4Identity())),
        )
        val assets = object : SceneAssets {
            override fun model(src: String): GlbModel? = if (src == "tri.glb") model else null
        }
        val ir = scene("""<scene background="#000000"><model src="tri.glb"/></scene>""")
        val w = 200; val h = 200
        val pixels = rasterizeScene(ir, mapResolver(), w, h, assets)
        fun at(x: Int, y: Int) = pixels[y * w + x]
        val red = 0xFFFF0000.toInt(); val black = 0xFF000000.toInt()
        assertEquals(red, at(110, 90),
            "(110,90) sits inside the projected triangle — expected the exact baseColor, saw ${hex(at(110, 90))}")
        assertEquals(red, at(105, 95),
            "(105,95) sits inside the projected triangle, saw ${hex(at(105, 95))}")
        assertEquals(black, at(90, 90),
            "(90,90) is left of the triangle's vertical edge (x=100) — background, saw ${hex(at(90, 90))}")
        assertEquals(black, at(125, 80),
            "(125,80) lies beyond the hypotenuse — background, saw ${hex(at(125, 80))}")
        // without the asset the model draws nothing — never a crash, never a fake
        val absent = rasterizeScene(ir, mapResolver(), w, h)
        assertTrue(absent.all { it == black }, "no assets → the model paints nothing (honest absence)")
    }

    // ── G3: a sampled pose CPU-skins the model before rasterization ──────────────────

    @Test
    fun skinnedModelMovesWithItsPoseAndBindPoseMatchesStatic() {
        // the corpus triangle again, now skinned to ONE joint (skin joints [node 1],
        // identity IBM). Bind pose = the P4 static frame exactly; a pose translating
        // the joint by (0.5, 0, 0) shifts the silhouette right by 0.5 world units
        // (≈ 17.3 px at 200×200 under the default camera).
        val model = GlbModel(
            meshes = listOf(GlbMesh(listOf(GlbPrimitive(
                positions = doubleArrayOf(0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0),
                normals = doubleArrayOf(0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0),
                indices = intArrayOf(0, 1, 2),
                baseColor = doubleArrayOf(1.0, 0.0, 0.0, 1.0),
                joints = intArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
                weights = doubleArrayOf(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0),
            )))),
            draws = listOf(GlbDraw(0, mat4Identity(), node = 0, skin = 0)),
            nodes = listOf(
                GlbNode(doubleArrayOf(0.0, 0.0, 0.0), doubleArrayOf(0.0, 0.0, 0.0, 1.0),
                    doubleArrayOf(1.0, 1.0, 1.0), null, IntArray(0), 0, 0),
                GlbNode(doubleArrayOf(0.0, 0.0, 0.0), doubleArrayOf(0.0, 0.0, 0.0, 1.0),
                    doubleArrayOf(1.0, 1.0, 1.0), null, IntArray(0), null, null),
            ),
            skins = listOf(GlbSkin(intArrayOf(1), listOf(mat4Identity()))),
        )
        var currentPose: GlbPose? = null
        val assets = object : SceneAssets {
            override fun model(src: String): GlbModel? = if (src == "skin.glb") model else null
            override fun pose(node: SceneNode): GlbPose? = currentPose
        }
        val ir = scene("""<scene background="#000000"><model src="skin.glb"/></scene>""")
        val w = 200; val h = 200
        val static = rasterizeScene(ir, mapResolver(), w, h, assets)
        currentPose = GlbPose()   // the BIND pose (empty) through the skinning path
        val bind = rasterizeScene(ir, mapResolver(), w, h, assets)
        assertTrue(static.contentEquals(bind), "the bind pose renders the static frame exactly")
        currentPose = GlbPose().apply { put(1, GlbTrsOverride(t = doubleArrayOf(0.5, 0.0, 0.0))) }
        val posed = rasterizeScene(ir, mapResolver(), w, h, assets)
        fun at(pixels: IntArray, x: Int, y: Int) = pixels[y * w + x]
        val red = 0xFFFF0000.toInt(); val black = 0xFF000000.toInt()
        assertEquals(red, at(static, 110, 90), "the unposed triangle covers (110,90)")
        assertEquals(black, at(posed, 110, 90),
            "the posed triangle left (110,90) — the joint moved the vertices, saw ${hex(at(posed, 110, 90))}")
        assertEquals(red, at(posed, 125, 95),
            "the posed triangle now covers (125,95), saw ${hex(at(posed, 125, 95))}")
    }

    // ── P4: text3d paints inside its corpus-computed quad, cutout stays transparent ──

    @Test
    fun text3dPaintsInsideItsCorpusQuadAndCutsOutTransparentTexels() {
        // value "Hi" size 1 at the origin: quad halfWidth = 1·0.6·2/2 = 0.6, halfHeight
        // = 0.5 (text3d.json law). Default camera on +Z → billboard rotation identity;
        // ndc x = ±cot30°·0.6/5 ≈ ±0.2078 → screen x ∈ [79.2, 120.8]; y ∈ [82.7, 117.3].
        // The seam texture is 2×1: LEFT texel transparent (cutout), RIGHT opaque white.
        val texture = SceneTexture(intArrayOf(0x00000000, 0xFFFFFFFF.toInt()), 2, 1)
        var askedWidth = -1; var askedHeight = -1
        val assets = object : SceneAssets {
            override fun text(value: String, widthPx: Int, heightPx: Int): SceneTexture? {
                askedWidth = widthPx; askedHeight = heightPx
                return if (value == "Hi") texture else null
            }
        }
        val ir = scene("""<scene background="#000000"><text3d value="Hi" size="1" color="#ffffff"/></scene>""")
        val w = 200; val h = 200
        val pixels = rasterizeScene(ir, mapResolver(), w, h, assets)
        fun at(x: Int, y: Int) = pixels[y * w + x]
        val white = 0xFFFFFFFF.toInt(); val black = 0xFF000000.toInt()
        assertEquals(SCENE_TEXT3D_RASTER_HEIGHT, askedHeight, "the raster height law is 64 px")
        assertEquals(Math.round(SCENE_TEXT3D_RASTER_HEIGHT * TEXT3D_ADVANCE * 2).toInt(), askedWidth,
            "the raster width follows the quad aspect (0.6·chars)")
        assertEquals(white, at(110, 100),
            "(110,100) sits in the quad's right (opaque) half — unlit white, saw ${hex(at(110, 100))}")
        assertEquals(white, at(110, 90),
            "(110,90) also inside the opaque half, saw ${hex(at(110, 90))}")
        assertEquals(black, at(90, 100),
            "(90,100) sits in the quad's left half — a transparent texel CUTS OUT to background, saw ${hex(at(90, 100))}")
        assertEquals(black, at(70, 100),
            "(70,100) is outside the quad entirely — background, saw ${hex(at(70, 100))}")
        assertEquals(black, at(100, 78),
            "(100,78) is above the quad (y < 82.7) — background, saw ${hex(at(100, 78))}")
        // an empty value lays out no quad — nothing asked of the seam, nothing drawn
        val empty = rasterizeScene(
            scene("""<scene background="#000000"><text3d value=""/></scene>"""),
            mapResolver(), 40, 40, assets,
        )
        assertTrue(empty.all { it == black }, "empty value → no quad, no seam call, no pixels")
    }

    // ── P5: a point light paints a radial falloff gradient (the pinned attenuation) ──

    @Test
    fun pointLightPaintsARadialFalloffGradientMatchingThePinnedMath() {
        // camera default (0 0 5); an 8×8 plane at z=0 facing +Z; ONE point light at
        // (0 0 2) — ambient stays 0 (a point light IS a light), so every pixel is
        // base · intensity·att(d)·(n·L), the lighting.json law evaluated PER PIXEL.
        val ir = scene(
            """
            <scene background="#000000">
              <light kind="point" position="0 0 2" intensity="2" range="10"/>
              <plane size="8 8" color="#808080"/>
            </scene>
            """.trimIndent(),
        )
        val w = 200; val h = 200
        val pixels = rasterizeScene(ir, mapResolver(), w, h)
        fun red(x: Int, y: Int) = pixels[y * w + x] shr 16 and 0xFF
        // the brightness must fall RADIALLY from the screen center (the light's axis)
        val center = red(100, 100)
        val mid = red(140, 100)
        val edge = red(180, 100)
        assertTrue(center > mid && mid > edge,
            "point-light brightness must decrease radially: center=$center mid=$mid edge=$edge")
        assertTrue(edge > 0, "the far sample still catches light inside range, saw $edge")
        // pinned math at a sampled pixel: unproject its center to the z=0 plane
        // (independent scratch math), then window²/(1+d²) · n·L · intensity · base
        fun expectedByte(px: Int, py: Int): Int {
            val tanHalf = kotlin.math.tan(Math.toRadians(30.0))
            val wx = ((px + 0.5) / w * 2.0 - 1.0) * tanHalf * 5.0
            val wy = -((py + 0.5) / h * 2.0 - 1.0) * tanHalf * 5.0
            val dx = 0.0 - wx; val dy = 0.0 - wy; val dz = 2.0
            val d = kotlin.math.sqrt(dx * dx + dy * dy + dz * dz)
            val ratio = d / 10.0
            val window = 1.0 - ratio * ratio * ratio * ratio
            val att = window * window / (1.0 + d * d)
            val lambert = dz / d          // n = (0,0,1)
            val channel = (0x80 / 255.0) * (2.0 * att * lambert)
            return (channel * 255.0 + 0.5).toInt()
        }
        for ((x, y) in listOf(100 to 100, 140 to 100, 180 to 100, 100 to 160)) {
            val want = expectedByte(x, y)
            val got = red(x, y)
            assertTrue(kotlin.math.abs(got - want) <= 2,
                "($x,$y): point-lit channel $got !~ pinned $want (window²/(1+d²) law)")
        }
    }

    // ── P5: linear fog blends a far object toward the fog color (the pinned blend) ───

    @Test
    fun fogBlendsTheFarFaceTowardTheFogColorByThePinnedFactor() {
        // camera default (0 0 5); the green box's front face sits at z=0.5 → d ≈ 4.5.
        // fog="#ff0000 1 8" → f = (8 − 4.5)/7 ≈ 0.5: final ≈ ½·green + ½·red.
        val ir = scene(
            """
            <scene background="#000000" fog="#ff0000 1 8">
              <box size="1 1 1" color="#00ff00"/>
            </scene>
            """.trimIndent(),
        )
        val w = 200; val h = 200
        val pixels = rasterizeScene(ir, mapResolver(), w, h)
        fun at(x: Int, y: Int) = pixels[y * w + x]
        val center = at(100, 100)
        val f = sceneFogFactor(4.5, 1.0, 8.0)   // the pinned factor at the face depth
        val wantR = ((1.0 - f) * 255.0 + 0.5).toInt()
        val wantG = (f * 255.0 + 0.5).toInt()
        val gotR = center shr 16 and 0xFF
        val gotG = center shr 8 and 0xFF
        val gotB = center and 0xFF
        assertTrue(kotlin.math.abs(gotR - wantR) <= 2,
            "center red must be (1−f)·fog ≈ $wantR, saw $gotR (${hex(center)})")
        assertTrue(kotlin.math.abs(gotG - wantG) <= 2,
            "center green must be f·lit ≈ $wantG, saw $gotG (${hex(center)})")
        assertTrue(gotB <= 2, "center blue stays 0, saw $gotB")
        assertEquals(0xFF000000.toInt(), at(5, 5),
            "fog never touches the background clear color, saw ${hex(at(5, 5))}")
        // an unfogged control: near ≥ face depth → f = 1 → the exact lit green
        val unfogged = rasterizeScene(
            scene("""<scene background="#000000" fog="#ff0000 6 8"><box size="1 1 1" color="#00ff00"/></scene>"""),
            mapResolver(), w, h,
        )
        assertEquals(0xFF00FF00.toInt(), unfogged[100 * w + 100],
            "inside fog-near the face keeps its exact color, saw ${hex(unfogged[100 * w + 100])}")
    }

    // ── Article 7: a malformed background falls back with exactly one diagnostic ─────

    @Test
    fun malformedBackgroundFallsBackToBlackWithOneDiagnostic() {
        val ir = scene("""<scene background="chartreuse"><box color="#00ff00"/></scene>""")
        val diagnostics = ArrayList<SceneDiagnostic>()
        val pixels = rasterizeScene(ir, mapResolver(), 40, 40, diag = { diagnostics.add(it) })
        assertEquals(1, diagnostics.size,
            "one malformed-background diagnostic expected, got ${diagnostics.map { it.message }}")
        assertEquals(0xFF000000.toInt(), pixels[0],
            "corner pixel should be the black fallback, saw ${hex(pixels[0])}")
        assertTrue(pixels.any { it != 0xFF000000.toInt() },
            "the scene still draws its geometry after the fallback — never a blank frame")
    }
}
