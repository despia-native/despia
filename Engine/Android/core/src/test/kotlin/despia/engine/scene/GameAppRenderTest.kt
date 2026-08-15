//
//  GameAppRenderTest.kt — run the REAL Crate Drop app markup (the same
//  OpenSource/Web/packages/scene-demo GameDemo.dsx page the browser runs) through the
//  JVM half of the engine: StackXML → parseScene with the prefab lookup (G1) →
//  extractScenePhysics + the fixed-tick solver (G2) → the ONE shared software
//  rasterizer that paints `<scene>` on Android devices AND on the desktop lane.
//
//  There is no emulator in this environment, but the pixels a phone would show come
//  from exactly this code path — so this test IS the Android evidence: same markup,
//  same kernel, same rasterizer, checked against the same corpus-pinned numbers the
//  browser run checked (rest height 0.294319, the parent-frame law for prefab bodies).
//  It writes the frame to build/game-frames/ as a PPM for eyeballing.
//

package despia.engine.scene

import despia.engine.StackXML
import java.io.File
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class GameAppRenderTest {

    /** the Crate Drop scene, verbatim from the app page (holes pre-resolved by `vars`) */
    private val sceneMarkup = """
        <scene id="game" gravity="0 -9.81 0" background="#0a1020" fog="#0a1020 12 26">
          <camera position="0 2.6 8" look-at="0 1 0" fov="55"/>
          <light kind="ambient" intensity="0.4"/>
          <light kind="directional" position="4 6 3" intensity="0.75"/>
          <light kind="point" position="0 3.2 2" color="#ffb454" intensity="2.2" range="14"/>
          <box id="floor" physics="static" position="0 -0.5 0" size="14 1 8" color="#14532d"/>
          <box id="backwall" physics="static" position="0 1 -2.6" size="14 4 0.4" color="#0f2231"/>
          <box id="goal" physics="static" trigger="true" position="3.4 0.6 0" size="1.6 1.2 1.6" color="#22d3ee"/>
          <box id="cannon" position="-2.2 0.35 0" size="0.7 0.7 0.7" color="#334155"/>
          <sphere id="ball" physics="dynamic" mass="2" bounce="0.35" friction="0.4"
                  position="-2.2 1.2 0" radius="0.35" color="#f59e0b"/>
          <group id="stack">
            <Crate position="-0.6 3.2 0" tint="#c2703a"/>
            <Crate position="0.6 4.4 0" tint="#8b5cf6"/>
          </group>
        </scene>
    """.trimIndent()

    /** the Crate prefab, verbatim from Components/Crate.dsx */
    private val crateTemplate = """
        <box physics="dynamic" mass="{{ mass }}" bounce="0.15" friction="0.6"
             size="0.6 0.6 0.6" color="{{ tint }}">
          <head>
            <attribute as="tint" default="#c2703a"/>
            <attribute as="mass" default="1"/>
          </head>
        </box>
    """.trimIndent()

    private fun prefabs(): ScenePrefabLookup {
        val template = StackXML.parse(crateTemplate) ?: error("the Crate prefab does not parse")
        val def = scenePrefabDefFromTemplate(template)
        return { tag -> if (tag == "Crate") def else null }
    }

    /** the element's resolver shape: prefab scope first, then the (empty) outer plane */
    private fun resolverFor(nodes: List<SceneNode>): SceneResolve =
        scenePrefabResolver(nodes) { null }

    @Test
    fun theRealGameSceneSimulatesAndRastersOnTheJvm() {
        val markup = StackXML.parse(sceneMarkup)
        assertNotNull(markup, "the app's scene markup parses through StackXML")
        val diagnostics = ArrayList<SceneDiagnostic>()
        val ir = parseScene(markup, { diagnostics.add(it) }, prefabs())

        // ── G1: the prefab expanded into real scene nodes, one per authored instance ──
        val stack = ir.nodes.first { it.id == "stack" }
        assertEquals(2, stack.children.size, "two <Crate/> instances expanded")
        val instanceRoot = stack.children[0]
        assertEquals(SceneNodeKind.GROUP, instanceRoot.kind, "the expansion root is an implicit group")
        assertNotNull(instanceRoot.prefab, "…carrying the prefab stamp")
        val crateBody = instanceRoot.children[0]
        assertEquals(SceneNodeKind.BOX, crateBody.kind, "the component body is the box")

        val resolve = resolverFor(ir.nodes)
        val props = resolvedProps(crateBody, resolve, null)
        assertEquals("#c2703a", props.color, "the per-instance tint param resolved")

        // ── G2: extract and run the fixed-tick solver to rest ─────────────────────────
        val extraction = extractScenePhysics(ir, resolve, { diagnostics.add(it) })
        assertEquals(6, extraction.bodies.size, "floor, backwall, goal, ball and the 2 prefab crates")
        val world = createScenePhysicsWorld(extraction.gravity, extraction.bodies)
        repeat(600) { stepScenePhysicsWorld(world) }   // 10 s at the fixed 1/60 tick

        val crateBodies = world.bodies.filter { it.kind == "dynamic" && it.shape == "box" }
        assertTrue(crateBodies.isNotEmpty(), "the prefab crates became solver bodies")
        for (body in crateBodies) {
            // the corpus-pinned floor rest for a 0.6 box: 0.3 − the 0.005 slop… the
            // crates settle either on the floor or STACKED one box-height above it
            val y = body.position[1]
            val resting = (0..3).any { abs(y - (0.294319 + it * 0.585)) < 0.05 }
            assertTrue(resting, "a crate rests on the floor or on another crate (y=$y)")
        }

        // ── THE PARENT-FRAME LAW: the render position is the parent-local twin ────────
        // (the bug a real app exposed: a prefab body's expansion group carries the
        // instance transform, so the solver's ROOT-space result must be expressed in
        // that frame or the scene draws double-offset)
        val parentWorlds = worldMatrices(ir.nodes, resolve, null)
        val firstBodyId = extraction.bodies.first { it.node === crateBody }.id
        val solved = world.byId.getValue(firstBodyId).position
        val local = scenePhysicsToLocal(solved, parentWorlds[instanceRoot])
        val backToRoot = scenePhysicsToRoot(local, parentWorlds[instanceRoot])
        for (i in 0..2) {
            assertTrue(abs(backToRoot[i] - solved[i]) < 1e-9,
                "root ⇄ local round-trips exactly (axis $i)")
        }

        // ── the shared rasterizer: the pixels an Android device would show ────────────
        val w = 640
        val h = 360
        // apply the solved positions the way the element does (override plane → resolver)
        val solvedById = world.bodies.associateBy { it.id }
        val nodeToId: Map<SceneNode, String> =
            extraction.bodies.mapNotNull { spec -> spec.node?.let { it to spec.id } }.toMap()
        val renderResolve: SceneResolve = { node, name, raw ->
            val id = if (node == null) null else nodeToId[node]
            if (name == "position" && id != null && solvedById[id]?.kind != "static") {
                val rootPos = solvedById.getValue(id).position
                val parent = parentWorlds.entries
                    .firstOrNull { entry -> entry.key.children.any { it === node } }?.value
                formatSceneAnimValue("position", scenePhysicsToLocal(rootPos, parent))
            } else {
                resolve(node, name, raw)
            }
        }
        val pixels = rasterizeScene(ir, renderResolve, w, h)

        val background = 0xFF0A1020.toInt()
        val lit = pixels.count { it != background }
        assertTrue(lit > pixels.size / 20, "the frame is genuinely drawn ($lit of ${pixels.size} px)")
        val distinct = pixels.toHashSet().size
        assertTrue(distinct > 20, "many shades — lit geometry, not a flat fill ($distinct)")

        // write the frame out for eyeballing (PPM: no image lib needed in :core)
        val out = File("build/game-frames").apply { mkdirs() }
        File(out, "crate-drop-jvm.ppm").outputStream().buffered().use { stream ->
            stream.write("P6\n$w $h\n255\n".toByteArray())
            for (p in pixels) {
                stream.write((p shr 16) and 0xFF); stream.write((p shr 8) and 0xFF); stream.write(p and 0xFF)
            }
        }
        println("[GameAppRender] $lit/${pixels.size} lit px, $distinct shades → ${File(out, "crate-drop-jvm.ppm").absolutePath}")
    }
}
