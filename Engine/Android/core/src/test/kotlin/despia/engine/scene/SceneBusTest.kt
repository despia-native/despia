package despia.engine.scene

import despia.engine.StackXML
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * SceneRegistry.kt units — the `scene` BUS surface's :core half (dsx-game.md §2 G5):
 * the SceneRegistry seam (register/resolve/emit — the door the Core/Scene module
 * drives elements through) and the ONE shared SceneBusAdapter both JVM `<scene>`
 * elements construct (nodes · set · camera/flyTo · pick · contacts · stats). Every
 * markup fixture parses through StackXML.parse — the runtime's own parser, never a
 * second one; every number the adapter answers folds through the corpus-pinned kernel.
 */
class SceneBusTest {

    @AfterTest
    fun reset() {
        SceneRegistry.clearForTest()
    }

    private fun ir(markup: String): SceneIR {
        val root = StackXML.parse(markup)
        assertNotNull(root, "fixture markup must parse")
        return parseScene(root, diag = { d -> error("unexpected parse diagnostic: ${d.message}") })
    }

    private fun adapter(markup: String, vars: MutableMap<String, Any?> = HashMap()): SceneBusAdapter {
        val parsed = ir(markup)
        val animator = SceneAnimator()
        val reconciler = SceneBindReconciler(evalBind = { expr, _ -> vars[expr] }, animator = animator)
        reconciler.register(parsed.nodes, null)
        val bus = SceneBusAdapter(parsed, animator, reconciler)
        bus.rawBase = { _, _, raw -> interpolateSceneHoles(raw) { expr -> vars[expr] } }
        animator.attach(parsed.nodes, null, bus.resolveBase)
        return bus
    }

    private val RIG = """
        <scene id="world" background="#0b1020">
          <camera position="0 0 5" look-at="0 0 0"/>
          <light kind="ambient" intensity="0.5"/>
          <group id="rig">
            <box id="crate" position="-1 0 0" color="#2563eb" collide="box"/>
            <sphere id="ball" position="0 0 0" radius="0.5" collide="sphere"/>
          </group>
        </scene>
    """.trimIndent()

    // ── the registry seam ────────────────────────────────────────────────────────────

    @Test
    fun registryKeysResolveAndUnregister() {
        val a = adapter(RIG)
        val key = SceneRegistry.register(a)
        assertEquals("world", key, "the scene root's id attr is the registry key")
        assertEquals(a, SceneRegistry.resolve("world"))
        assertEquals(a, SceneRegistry.resolve(null), "absent target = the FIRST mounted scene")
        val b = adapter("<scene><box id=\"panel\"/></scene>")
        val bKey = SceneRegistry.register(b)
        assertTrue(bKey.startsWith("scene#"), "an id-less scene takes the auto key, saw $bKey")
        assertEquals(a, SceneRegistry.resolve(null), "the first mount stays the default")
        SceneRegistry.unregister(key)
        assertNull(SceneRegistry.resolve("world"), "unregister removes the key")
        assertEquals(b, SceneRegistry.resolve(null), "the next mounted scene becomes the default")
    }

    @Test
    fun duplicateIdsStayAddressable() {
        val a = adapter(RIG)
        val b = adapter(RIG)
        assertEquals("world", SceneRegistry.register(a))
        val second = SceneRegistry.register(b)
        assertTrue(second.startsWith("scene#"), "a duplicate id falls back to the auto key, saw $second")
        assertEquals(a, SceneRegistry.resolve("world"))
        assertEquals(b, SceneRegistry.resolve(second))
    }

    @Test
    fun emitReachesListenersAndSurvivesAThrowingOne() {
        val seen = ArrayList<String>()
        val off = SceneRegistry.listen { scene, kind, _ -> error("bad observer $scene.$kind") }
        SceneRegistry.listen { scene, kind, payload -> seen.add("$scene.$kind:${payload["id"]}") }
        SceneRegistry.emit("world", "collide", mapOf("id" to "crate"))
        assertEquals(listOf("world.collide:crate"), seen, "the throwing listener never blocks the fan-out")
        off()
    }

    // ── the adapter: nodes ───────────────────────────────────────────────────────────

    @Test
    fun nodesAnswersTheResolvedTree() {
        val a = adapter(RIG)
        val tree = a.nodes()
        assertEquals(listOf("camera", "light", "group"), tree.map { it.kind })
        val group = tree[2]
        assertEquals("rig", group.id)
        assertEquals(listOf("crate", "ball"), group.children.map { it.id })
        val crate = group.children[0]
        assertEquals("-1 0 0", crate.props["position"], "resolved authored position")
        assertEquals("#2563eb", crate.props["color"])
        val world = assertNotNull(crate.world, "a box carries a world entry")
        assertEquals(-1.0, world[0], 1e-9)
        assertEquals(0.0, world[1], 1e-9)
        assertEquals(0.0, world[2], 1e-9)
    }

    // ── set: the base overlay + the P5 glide plane ───────────────────────────────────

    @Test
    fun setWritesTheBasePlaneAndValidates() {
        val a = adapter(RIG)
        assertEquals("bad_attr", a.set("ball", "on:tap", "x()"))
        assertEquals("bad_attr", a.set("ball", "id", "other"))
        assertEquals("node_not_found", a.set("ghost", "color", "#fff"))
        var invalidated = 0
        a.invalidate = { invalidated += 1 }
        assertEquals("ok", a.set("ball", "position", "0 2 0"))
        assertEquals(1, invalidated, "a bus set invalidates the element")
        val ball = a.nodes()[2].children[1]
        assertEquals("0 2 0", ball.props["position"], "the write is visible on the resolved plane")
        assertEquals(2.0, assertNotNull(ball.world)[1], 1e-9, "the world fold sees the write")
    }

    @Test
    fun setOnATransitionCoveredPropertyGlides() {
        val a = adapter(
            """
            <scene>
              <camera position="0 0 5"/>
              <box id="crate" position="0 0 0" transition="position 200ms linear"/>
            </scene>
            """.trimIndent(),
        )
        val animator = run {
            // drive the SAME animator the adapter writes through: read it back via stats
            assertEquals(0, a.stats().animations, "no animation before the write")
            assertEquals("ok", a.set("crate", "position", "4 0 0"))
            a
        }
        assertEquals(1, animator.stats().animations,
            "a set on a transition-covered property starts the P5 glide")
    }

    // ── camera: read, write, flyTo ───────────────────────────────────────────────────

    @Test
    fun cameraReadsWritesAndFliesThroughTheP5Plane() {
        val a = adapter(RIG)
        val read = a.camera()
        assertEquals("0 0 5", read.position)
        assertEquals("0 0 0", read.lookAt)
        assertEquals(60.0, read.fov, 1e-9)
        assertTrue(read.authored)
        assertEquals("bad_value", a.cameraSet(null, null, "not a triple", null))
        assertEquals("ok", a.cameraSet("0 1 8", null, null, null))
        assertEquals("0 1 8", a.camera().position, "an immediate write answers the new camera")
        assertEquals("ok", a.cameraSet(null, null, "0 0 12", 200.0))
        assertEquals(1, a.stats().animations, "flyTo seeds one glide on the transition plane")
        // the glide starts from the CURRENT rendered position (never snap) …
        assertEquals("0 1 8", a.camera().position, "the override holds the pre-fly position at t=0")
    }

    @Test
    fun cameraLessSceneReadsDefaultsAndRefusesWrites() {
        val a = adapter("<scene><box id=\"panel\"/></scene>")
        val read = a.camera()
        assertEquals("0 0 5", read.position, "the corpus camera default")
        assertEquals(false, read.authored)
        assertEquals("no_camera", a.cameraSet("0 1 8", null, null, null))
    }

    // ── pick: the tap math, no handlers fired ────────────────────────────────────────

    @Test
    fun pickAnswersTheNearestHitWithoutHandlers() {
        val a = adapter(RIG)
        a.viewWidth = 320
        a.viewHeight = 180
        val hit = assertNotNull(a.pick(0.5, 0.5), "dead center hits the origin ball")
        assertEquals("ball", hit.id)
        assertEquals("sphere", hit.kind)
        assertNull(a.pick(0.02, 0.02), "a corner tap hits nothing")
    }

    // ── contacts: the current overlap read ───────────────────────────────────────────

    @Test
    fun contactsReadsCurrentOverlaps() {
        val a = adapter(RIG)
        assertEquals(emptyList(), a.contacts().map { it.a }, "crate at -1 and ball at 0 do not overlap")
        assertEquals("ok", a.set("crate", "position", "0 0 0"))
        val touching = a.contacts()
        assertEquals(1, touching.size)
        assertEquals("crate", touching[0].a)
        assertEquals("ball", touching[0].b)
        assertTrue(touching[0].depth > 0.0, "an overlap carries a positive depth, saw ${touching[0].depth}")
    }

    // ── stats: the honest v0 profiler read ───────────────────────────────────────────

    @Test
    fun statsCountsNodesAnimationsAndBoundRows() {
        val vars = HashMap<String, Any?>()
        vars["rows"] = listOf(mapOf("id" to "e1"), mapOf("id" to "e2"))
        val parsed = ir(
            """
            <scene>
              <camera position="0 0 5"/>
              <group bind="rows" key="id"><box position="0 0 0"/></group>
            </scene>
            """.trimIndent(),
        )
        val animator = SceneAnimator()
        val reconciler = SceneBindReconciler(evalBind = { expr, _ -> vars[expr.trim()] }, animator = animator)
        reconciler.register(parsed.nodes, null)
        val bus = SceneBusAdapter(parsed, animator, reconciler)
        bus.rawBase = { _, _, raw -> interpolateSceneHoles(raw) { expr -> vars[expr] } }
        animator.attach(parsed.nodes, null, bus.resolveBase)
        reconciler.reconcile(bus.resolveBase)
        val stats = bus.stats()
        assertEquals(2, stats.boundRows, "two live rows")
        assertEquals(4, stats.nodes, "camera + group + two instantiated boxes")
        assertEquals(0, stats.animations)
        assertEquals(0.0, stats.lastFrameDt, 1e-9)
        bus.lastFrameDt = 16.7
        assertEquals(16.7, bus.stats().lastFrameDt, 1e-9, "the element stamps each emitted tick")
    }

    // ── capture: element-owned encoder seam ──────────────────────────────────────────

    @Test
    fun captureAnswersNullUntilAnElementBindsItsEncoder() {
        val a = adapter(RIG)
        assertNull(a.capture(), "no encoder bound = the module's typed capture_failed")
        a.captureFrame = { SceneBusCapture("QUJD", 320, 180) }
        val captured = assertNotNull(a.capture())
        assertEquals("QUJD", captured.image)
        assertEquals(320, captured.width)
        assertEquals(180, captured.height)
    }

    // ── G6: a bus write of the SPAWN pose is still a COMMAND (the 2D-walk finding) ───

    @Test
    fun aBusPositionWriteOfTheUNCHANGEDSpawnStringStillTeleportsASolverOwnedBody() {
        val parsed = ir(
            """
            <scene id="drop" mode="2d" gravity="0 -9.81 0">
              <sprite id="crate" physics="dynamic" position="0 3.5 0.5" size="1 1"/>
            </scene>
            """.trimIndent(),
        )
        val animator = SceneAnimator()
        val reconciler = SceneBindReconciler(evalBind = { _, _ -> null }, animator = animator)
        reconciler.register(parsed.nodes, null)
        val bus = SceneBusAdapter(parsed, animator, reconciler)
        bus.rawBase = { _, _, raw -> raw }
        animator.attach(parsed.nodes, null, bus.resolveBase)
        val physics = ScenePhysicsRuntime(parsed, animator, diag = null)
        bus.physicsInfo = { n -> physics.info(n) }
        bus.forcePhysicsWrite = { n, attr -> physics.forceWrite(n, attr) }
        physics.noteBase(bus.resolveBase)

        // fall for a second — the solver owns the rendered position, the BASE cache
        // still holds the authored spawn string "0 3.5 0.5"
        val render = animator.resolve(bus.resolveBase)
        repeat(60) { physics.advance(1.0 / 60.0, render, bus.resolveBase) }
        val node = findSceneNode(parsed.nodes, "crate")!!
        val fell = resolvedProps(node, animator.resolve(bus.resolveBase))
        assertTrue(fell.position[1] < 3.0, "the 2D crate fell (y ${fell.position[1]})")
        assertEquals(0.5, fell.position[2], "the z-lock held z at its spawn layer")

        // writing the SAME spawn string back is "put it where it started" — it must
        // teleport, not dedupe away
        assertEquals("ok", bus.set("crate", "position", "0 3.5 0.5"))
        physics.noteBase(bus.resolveBase)   // the element's invalidate → the next scan
        val reset = resolvedProps(node, animator.resolve(bus.resolveBase))
        assertEquals(3.5, reset.position[1], 1e-9, "the spawn-pose write teleported the body back")
        assertEquals(0.5, reset.position[2], "…and re-anchored on the same z layer")
    }
}
