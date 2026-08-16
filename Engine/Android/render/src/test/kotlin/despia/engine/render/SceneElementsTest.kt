//
//  SceneElementsTest.kt — plain-JVM units for the `<scene>` element's pure halves
//  (elements/SceneElements.kt + the shared :core rasterizer it paints). The :render test
//  harness is plain-JVM JUnit (no Robolectric, no display), so what runs here is exactly
//  what the harness supports: registration, the live-store resolver (JSE.interpolate —
//  the corpus vars-map with the store playing the map), the reactive re-raster key, the
//  raster cap, non-blank pixels through the element's own resolver path, a store write
//  changing the framebuffer, and tap → pick → handler execution through a real JSERunner.
//  DEVICE-ONLY remainder (androidTest/instrumented): the android.graphics.Bitmap paint,
//  Compose recomposition of the composable itself, and the real gesture pipeline — the
//  Compose adapter is compile-gated by :render:assembleDebug like every element wave.
//

package despia.engine.render

import despia.engine.JSERunner
import despia.engine.StackStore
import despia.engine.StackXML
import despia.engine.getPath
import despia.engine.render.elements.InputElements
import despia.engine.render.elements.SCENE_RASTER_MAX_EDGE
import despia.engine.render.elements.sceneRasterSize
import despia.engine.render.elements.sceneResolvedKey
import despia.engine.render.elements.sceneResolver
import despia.engine.render.elements.sceneScheduledNotice
import despia.engine.JSE
import despia.engine.scene.SceneAnimator
import despia.engine.scene.SceneBindReconciler
import despia.engine.scene.SceneIR
import despia.engine.scene.SceneResolve
import despia.engine.scene.parseScene
import despia.engine.scene.rasterizeScene
import despia.engine.scene.resolvedProps
import despia.engine.scene.scenePickAction
import despia.engine.setPath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SceneElementsTest {

    private fun ir(markup: String): SceneIR {
        val root = StackXML.parse(markup) ?: error("fixture markup must parse")
        return parseScene(root, diag = { d -> error("unexpected parse diagnostic: ${d.message}") })
    }

    private val rigMarkup = """
        <scene background="#0b1020">
          <camera position="0 1 4" look-at="0 0 0"/>
          <light kind="ambient" intensity="0.4"/>
          <light kind="directional" position="3 5 2" intensity="0.8"/>
          <box id="cube" rotation="0 {{ dsx.variable.spin }} 0" size="1 1 1" color="#2563eb"
               on:tap="dsx.variable.picked = 'cube'"/>
          <sphere position="1.6 0 0" radius="0.4" color="#f59e0b"/>
          <plane position="0 -0.5 0" size="10 10" rotation="-90 0 0" color="#1e293b"/>
        </scene>
    """.trimIndent()

    // ── registration: the wave lands `scene`, idempotently ──────────────────────────

    @Test fun registerPopulatesTheRegistry() {
        InputElements.register()
        InputElements.register()   // idempotent (defines replace; the flag short-circuits)
        assertNotNull("native scene", ComposeStackComponents.nativeGlobal("scene"))
    }

    // ── the live-store resolver + the reactive re-raster key ────────────────────────

    @Test fun storeWriteChangesTheResolvedKeyAndTheFramebuffer() {
        val store = StackStore()
        store.setPath("spin", 0.0)
        val scene = ir(rigMarkup)
        val resolve = sceneResolver(store, null)

        val keyAtZero = sceneResolvedKey(scene, resolve)
        val frameAtZero = rasterizeScene(scene, resolve, 160, 90)
        store.setPath("spin", 45.0)
        val keyAtFortyFive = sceneResolvedKey(scene, resolve)
        val frameAtFortyFive = rasterizeScene(scene, resolve, 160, 90)

        assertNotEquals("spin 0 → 45 must change the remember key (it drives re-raster)",
            keyAtZero, keyAtFortyFive)
        assertTrue("spin 0 → 45 must change the 160x90 framebuffer",
            !frameAtZero.contentEquals(frameAtFortyFive))

        store.setPath("unrelated", "value")
        assertEquals("an unrelated store write must NOT change the key (no useless re-raster)",
            keyAtFortyFive, sceneResolvedKey(scene, resolve))
    }

    @Test fun elementResolverRendersNonBlank() {
        val store = StackStore()
        store.setPath("spin", 30.0)
        val scene = ir(rigMarkup)
        val pixels = rasterizeScene(scene, sceneResolver(store, null), 320, 180)
        val colors = pixels.toSet()
        assertTrue("the rig should rasterize many shades at 320x180, saw ${colors.size} distinct color(s)",
            colors.size >= 8)
    }

    // ── tap → pick → handler through a real JSERunner ───────────────────────────────

    @Test fun tapOverTheBoxFiresItsHandlerThroughTheRunner() {
        val store = StackStore()
        store.setPath("spin", 0.0)
        val scene = ir(rigMarkup)
        val resolve = sceneResolver(store, null)
        val w = 320; val h = 180

        // the box sits at the origin; camera (0 1 4) looks at it — the frame center hits
        val hit = scenePickAction(scene, resolve, w, h, w / 2.0, h / 2.0)
        assertNotNull("a tap at the frame center (${w / 2}, ${h / 2}) must pick the box", hit)
        assertEquals("the pick payload id is the node's authored id", "cube", hit!!.second)

        JSERunner(store).run(hit.first, null, mapOf("id" to hit.second))
        assertEquals("the on:tap statement must have executed against the store",
            "cube", store.getPath("picked"))

        // the sky corner has no geometry — no handler fires
        assertNull("a tap in the empty top-left corner (4, 4) must miss",
            scenePickAction(scene, resolve, w, h, 4.0, 4.0))
    }

    // ── the raster cap + the scheduled notice ───────────────────────────────────────

    @Test fun rasterSizeCapsTheLongEdgeAndPreservesAspect() {
        assertEquals(SCENE_RASTER_MAX_EDGE, 640)
        val capped = sceneRasterSize(2560, 1440)
        assertEquals("long edge capped at 640, saw ${capped.width}", 640, capped.width)
        assertEquals("short edge scales with aspect (2560x1440 → 640x360), saw ${capped.height}",
            360, capped.height)
        val small = sceneRasterSize(320, 180)
        assertEquals("under the cap stays 1:1 (width)", 320, small.width)
        assertEquals("under the cap stays 1:1 (height)", 180, small.height)
        val floored = sceneRasterSize(0, -5)
        assertTrue("degenerate sizes floor at 1x1, saw ${floored.width}x${floored.height}",
            floored.width == 1 && floored.height == 1)
    }

    @Test fun scheduledKindsProduceTheHonestNotice() {
        val scheduled = ir(
            """<scene mode="ar"><model src="w.glb"/><text3d value="hi"/><anchor kind="plane"><box/></anchor></scene>""",
        )
        val notice = sceneScheduledNotice(scheduled)
        for (expected in listOf("mode=\"ar\" (P3)", "<anchor> (P3)")) {
            assertTrue("notice should name $expected, saw '$notice'", notice.contains(expected))
        }
        // P4 landed: model/text3d render for real — the notice must NOT name them
        for (dropped in listOf("<model>", "<text3d>")) {
            assertTrue("notice must no longer name $dropped, saw '$notice'", !notice.contains(dropped))
        }
        assertEquals("a fully-rendered scene shows no notice", "",
            sceneScheduledNotice(ir("""<scene><box/><model src="w.glb"/><text3d value="hi"/></scene>""")))
    }

    // ── P4 pure halves: the text raster width law + the asset-keyed re-raster ───────

    @Test fun texture3dAttributesRideTheResolvedKey() {
        // a texture/model/text3d attribute is an authored attribute like any other:
        // changing its resolved value must change the re-raster key
        val store = StackStore()
        store.setPath("skin", "a.png")
        val scene = ir("""<scene><box texture="{{ dsx.variable.skin }}"/><text3d value="{{ dsx.variable.label }}"/></scene>""")
        val resolve = sceneResolver(store, null)
        val before = sceneResolvedKey(scene, resolve)
        store.setPath("skin", "b.png")
        assertNotEquals("a texture swap must change the re-raster key", before, sceneResolvedKey(scene, resolve))
        val labelled = sceneResolvedKey(scene, resolve)
        store.setPath("label", "Hello")
        assertNotEquals("a text3d value write must change the re-raster key", labelled, sceneResolvedKey(scene, resolve))
    }

    // ── P5: the keyed bound-group reconcile (the element's exact runtime path) ──────

    private fun reconcilerRig(store: StackStore, markup: String): Triple<SceneIR, SceneBindReconciler, SceneResolve> {
        val scene = ir(markup)
        val animator = SceneAnimator()
        val reconciler = SceneBindReconciler({ expr, item -> JSE.eval(expr, store, item) }, animator)
        reconciler.register(scene.nodes, null)
        val base: SceneResolve = { n, _, raw ->
            JSE.interpolate(raw, store, n?.let { reconciler.itemFor(it) })
        }
        return Triple(scene, reconciler, base)
    }

    @Test fun boundGroupSpawnsKeyedRowsWithRowScopedResolution() {
        val store = StackStore()
        store.setPath("enemies", listOf(
            mapOf("id" to "a", "x" to 1.0), mapOf("id" to "b", "x" to 2.5),
        ))
        val (scene, reconciler, base) = reconcilerRig(store,
            """<scene><group bind="dsx.variable.enemies" key="id"><box position="{{ item.x }} 0 0" color="#ff0000"/></group></scene>""")
        val group = scene.nodes.first()
        assertEquals("template children leave the static tree at register", 0, group.children.size)

        assertTrue("the first reconcile changes the tree", reconciler.reconcile(base))
        assertEquals("two keyed rows instantiate", 2, group.children.size)
        // ROW-SCOPED RESOLUTION: item.* resolves against each row (the <list> law)
        assertEquals("row 0 resolves its own item.x", 1.0, resolvedProps(group.children[0], base).position[0], 1e-9)
        assertEquals("row 1 resolves its own item.x", 2.5, resolvedProps(group.children[1], base).position[0], 1e-9)
        assertTrue("an unchanged value reconciles to no change", !reconciler.reconcile(base))
    }

    @Test fun reorderKeepsRowNodeIdentityAndRemovalDropsIt() {
        val store = StackStore()
        store.setPath("enemies", listOf(mapOf("id" to "a"), mapOf("id" to "b")))
        val (scene, reconciler, base) = reconcilerRig(store,
            """<scene><group bind="dsx.variable.enemies" key="id"><box color="#ff0000"/></group></scene>""")
        val group = scene.nodes.first()
        reconciler.reconcile(base)
        val nodeA = group.children[0]
        val nodeB = group.children[1]

        // THE KEYED-IDENTITY LAW: a reorder keeps each key's instantiated SceneNode
        store.setPath("enemies", listOf(mapOf("id" to "b"), mapOf("id" to "a")))
        reconciler.reconcile(base)
        assertSame("key b keeps its node across the reorder", nodeB, group.children[0])
        assertSame("key a keeps its node across the reorder", nodeA, group.children[1])

        // removal unmounts the subtree
        store.setPath("enemies", listOf(mapOf("id" to "a")))
        reconciler.reconcile(base)
        assertEquals("one row remains", 1, group.children.size)
        assertSame("the surviving row is key a's node", nodeA, group.children[0])
        assertNull("the removed row's item scope is dropped", reconciler.itemFor(nodeB))
    }

    @Test fun removingABoundRowStopsItsAnimations() {
        val store = StackStore()
        store.setPath("enemies", listOf(mapOf("id" to "a")))
        val scene = ir(
            """<scene><group bind="dsx.variable.enemies" key="id"><box color="#ff0000"><animate target="rotation" to="0 360 0" duration="1s" loop="true"/></box></group></scene>""",
        )
        val animator = SceneAnimator()
        val reconciler = SceneBindReconciler({ expr, item -> JSE.eval(expr, store, item) }, animator)
        reconciler.register(scene.nodes, null)
        val base: SceneResolve = { n, _, raw ->
            JSE.interpolate(raw, store, n?.let { reconciler.itemFor(it) })
        }
        assertTrue("no rows yet, no animations", !animator.wantsTick(base))
        reconciler.reconcile(base)
        assertTrue("the spawned row's looping <animate> wants the frame loop", animator.wantsTick(base))
        assertTrue("a tick drives the row's animation", animator.tick(500.0, base))

        store.setPath("enemies", emptyList<Any?>())
        reconciler.reconcile(base)
        assertTrue("removing the row STOPS its animations (the bind law)", !animator.wantsTick(base))
    }

    @Test fun spawnedRowsRasterizeThroughTheRowScope() {
        val store = StackStore()
        store.setPath("enemies", emptyList<Any?>())
        val (scene, reconciler, base) = reconcilerRig(store,
            """<scene background="#000000"><group bind="dsx.variable.enemies" key="id"><box position="{{ item.x }} 0 0" size="1 1 1" color="#ff0000"/></group></scene>""")
        reconciler.reconcile(base)
        val w = 160; val h = 90
        val empty = rasterizeScene(scene, base, w, h)
        assertTrue("no rows → only background", empty.all { it == 0xFF000000.toInt() })

        store.setPath("enemies", listOf(mapOf("id" to "e1", "x" to 0.0)))
        assertTrue(reconciler.reconcile(base))
        val spawned = rasterizeScene(scene, base, w, h)
        assertTrue("the spawned row paints its exact ambient-lit red pixels",
            spawned.any { it == 0xFFFF0000.toInt() })
    }

    @Test fun busAdapterDrivesTheElementResolverPath() {
        // G5 (dsx-game.md §2): the Android element's bus wiring, plain-JVM half — the
        // :core SceneBusAdapter over the SAME live-store resolver the composable
        // constructs (JSE.interpolate; the bus base overlay layered underneath), so a
        // bus `set` re-resolves exactly like a store write and pick/stats fold through
        // the corpus kernel. The android.graphics PNG encoder (androidScenePng) and the
        // DisposableEffect registration are device-only (the instrumented remainder).
        val store = StackStore()
        store.setPath("spin", 0.0)
        val scene = ir(rigMarkup)
        val animator = SceneAnimator()
        val reconciler = SceneBindReconciler(evalBind = { expr, item -> JSE.eval(expr, store, item) },
            animator = animator)
        reconciler.register(scene.nodes, null)
        val bus = despia.engine.scene.SceneBusAdapter(scene, animator, reconciler)
        bus.rawBase = { n, _, raw -> JSE.interpolate(raw, store, n?.let { reconciler.itemFor(it) }) }
        animator.attach(scene.nodes, null, bus.resolveBase)

        val registryKey = despia.engine.scene.SceneRegistry.register(bus)
        try {
            assertSame("the registered handle resolves as the default target",
                bus, despia.engine.scene.SceneRegistry.resolve(null))
            assertEquals("camera + 2 lights + box + sphere + plane", 6, bus.stats().nodes)
            // a STORE write and a BUS write land on the same resolved plane
            store.setPath("spin", 45.0)
            val cube = bus.nodes().first { it.id == "cube" }
            assertEquals("the store hole resolves through the bus tree", "0 45 0", cube.props["rotation"])
            assertEquals("ok", bus.set("cube", "color", "#00ff00"))
            assertEquals("the bus write reads back resolved", "#00ff00",
                bus.nodes().first { it.id == "cube" }.props["color"])
            // pick: the camera at 0 1 4 looks at the origin cube — dead center hits it
            bus.viewWidth = 320
            bus.viewHeight = 180
            val hit = bus.pick(0.5, 0.5)
            assertNotNull("a center pick must hit", hit)
            assertEquals("cube", hit!!.id)
            assertNull("no encoder bound (device-only) = capture answers null", bus.capture())
        } finally {
            despia.engine.scene.SceneRegistry.unregister(registryKey)
        }
    }

    // ── G2 physics: the element's exact runtime fold (:core ScenePhysicsRuntime) under
    // a hand-driven clock — the plain-JVM half of the loop the composable drives; the
    // corpus (SceneConformanceTest) pins the solver, THESE pin the wiring + pixels.

    private val physicsRigMarkup = """
        <scene background="#000000">
          <camera position="0 1 6" look-at="0 0.5 0" fov="60"/>
          <box physics="static" position="0 -0.5 0" size="20 1 20" color="#1e293b"/>
          <sphere id="ball" physics="dynamic" position="0 1 0" radius="0.5" color="#ff0000"/>
        </scene>
    """.trimIndent()

    private class PhysicsRig(
        val scene: SceneIR,
        val animator: SceneAnimator,
        val physics: despia.engine.scene.ScenePhysicsRuntime,
        val resolveBase: SceneResolve,
        val resolve: SceneResolve,
    )

    private fun physicsRig(store: StackStore, markup: String = physicsRigMarkup): PhysicsRig {
        val scene = ir(markup)
        val animator = SceneAnimator()
        val physics = despia.engine.scene.ScenePhysicsRuntime(scene, animator)
        val base: SceneResolve = { _, _, raw -> JSE.interpolate(raw, store, null) }
        return PhysicsRig(scene, animator, physics, base, animator.resolve(base))
    }

    /** drive the loop's exact per-frame body at a fixed 60 Hz hand clock */
    private fun advanceFrames(rig: PhysicsRig, frames: Int): List<despia.engine.scene.ScenePhysicsStepResult> {
        val out = ArrayList<despia.engine.scene.ScenePhysicsStepResult>()
        repeat(frames) {
            out.addAll(rig.physics.advance(1.0 / 60.0, rig.resolve, rig.resolveBase).ticks)
        }
        return out
    }

    @Test fun droppedBallRestsAtTheCorpusHeightInTheFramebuffer() {
        // the corpus resting law (physics.json sim/sleep): a 0.5-radius ball dropped
        // from y=1 onto the ground box converges to center y = 0.494319 and sleeps.
        // The framebuffer must show the ball's exact ambient-lit red at the projected
        // rest center — the pixel half of the fixed-tick law on this surface.
        val store = StackStore()
        val rig = physicsRig(store)
        rig.physics.noteBase(rig.resolveBase)
        assertTrue("a dynamic body must want the loop", rig.physics.wants(rig.resolveBase))
        advanceFrames(rig, 240)

        val ball = rig.scene.nodes.first { it.id == "ball" }
        val rendered = resolvedProps(ball, rig.resolve).position
        assertEquals("the solver-owned override must show the corpus rest height",
            0.494319, rendered[1], 1.5e-6)
        assertEquals("rest keeps x", 0.0, rendered[0], 1.5e-6)

        // the regional sample: project the rest center, expect the ball's red there
        val w = 320; val h = 180
        val camera = despia.engine.scene.sceneCamera(rig.scene, rig.resolve, w.toDouble() / h)
        val ndc = despia.engine.scene.projectToNdc(camera.proj, camera.view, doubleArrayOf(0.0, 0.494319, 0.0))
        val px = ((ndc[0] + 1.0) / 2.0 * w).toInt()
        val py = ((1.0 - (ndc[1] + 1.0) / 2.0) * h).toInt()
        val pixels = rasterizeScene(rig.scene, rig.resolve, w, h)
        var red = 0
        for (dy in -3..3) {
            for (dx in -3..3) {
                val x = px + dx; val y = py + dy
                if (x in 0 until w && y in 0 until h && pixels[y * w + x] == 0xFFFF0000.toInt()) red += 1
            }
        }
        assertTrue("the framebuffer must show the resting ball's red at the projected rest " +
            "center ($px, $py) — saw $red red pixel(s) in the 7x7 window", red > 0)
    }

    @Test fun tickCountsToSleepMatchTheCorpusUnderAHandDrivenClock() {
        // the corpus sleep case (physics.json sim/sleep): |v| < 0.05 for 60 consecutive
        // ticks — the ball sleeps AFTER tick 77's step, and the loop-existence law then
        // turns the loop off (wants() false = no more on:tick)
        val store = StackStore()
        val rig = physicsRig(store)
        rig.physics.noteBase(rig.resolveBase)
        var sleepTick = -1
        var ticksSeen = 0
        for (frame in 0 until 240) {
            for (step in advanceFrames(rig, 1)) {
                ticksSeen += 1
                assertEquals("on:tick dt is exactly 1/60", 1.0 / 60.0, step.dt, 0.0)
                assertEquals("tick indices are the zero-based step sequence", ticksSeen - 1, step.tick)
                val ball = rig.physics.nodeFor("ball")!!
                if (sleepTick < 0 && rig.physics.info(ball)!!.sleeping) sleepTick = step.tick
            }
            if (sleepTick >= 0) break
        }
        assertEquals("the ball must sleep after the corpus-pinned tick (sim/sleep: " +
            "awake at 76, sleeping at 77)", 77, sleepTick)
        // the loop-existence law: the element's gate reads wants() — false means the
        // LaunchedEffect leaves composition, so no further advance() call happens and
        // on:tick stops with the loop
        assertTrue("a fully-asleep world must stop the loop (wants() false — on:tick stops)",
            !rig.physics.wants(rig.resolveBase))
    }

    @Test fun busVelocityWriteLaunchesAndResettles() {
        // the write law (physics.json sim/sleep, ticks 180/190): a bus `set velocity`
        // on the SLEEPING ball wakes it, the next step reads velocity 2.8365 at
        // position 0.541594 (the corpus numbers verbatim), and the ball re-settles
        val store = StackStore()
        val scene = ir(physicsRigMarkup)
        val animator = SceneAnimator()
        val reconciler = SceneBindReconciler({ expr, item -> JSE.eval(expr, store, item) }, animator)
        reconciler.register(scene.nodes, null)
        val bus = despia.engine.scene.SceneBusAdapter(scene, animator, reconciler)
        bus.rawBase = { n, _, raw -> JSE.interpolate(raw, store, n?.let { reconciler.itemFor(it) }) }
        val physics = despia.engine.scene.ScenePhysicsRuntime(scene, animator)
        bus.physicsInfo = { n -> physics.info(n) }
        val resolveBase = bus.resolveBase
        val resolve = animator.resolve(resolveBase)
        fun frames(n: Int) = (0 until n).flatMap { physics.advance(1.0 / 60.0, resolve, resolveBase).ticks }

        physics.noteBase(resolveBase)
        frames(180)   // settle + sleep (corpus: sleeping from tick 77)
        val ball = physics.nodeFor("ball")!!
        assertTrue("the ball must be asleep before the write", physics.info(ball)!!.sleeping)
        assertEquals("the bus read must expose sleeping=true", "true",
            bus.nodes().first { it.id == "ball" }.props["sleeping"])

        // the impulse verb: jump() IS `set velocity "0 <v> 0"` through the bus
        assertEquals("ok", bus.set("ball", "velocity", "0 3 0"))
        physics.noteBase(resolveBase)   // the composition scan applies the write law
        assertTrue("the velocity write must wake the body (the loop restarts)",
            physics.wants(resolveBase))
        val launch = frames(1)
        assertEquals("the wake step runs", 1, launch.size)
        assertEquals("tick 180 is the corpus write tick", 180, launch[0].tick)
        val info = physics.info(ball)!!
        assertEquals("corpus velocity after the write step", 2.8365, info.velocity[1], 1.5e-6)
        // THE INTERPOLATION LAW: alpha 0 shows the PREVIOUS step, so tick 180's corpus
        // end position (0.541594) is the rendered plane's anchor one frame later
        frames(1)
        assertEquals("corpus position after the write step rides the next frame's anchor",
            0.541594, resolvedProps(ball, resolve).position[1], 1.5e-6)

        frames(200)   // the launch decays and the ball re-settles to the rest height
        assertTrue("the relaunched ball must re-settle and sleep again",
            physics.info(ball)!!.sleeping)
        assertEquals("re-settled at the corpus rest height",
            0.494319, resolvedProps(ball, resolve).position[1], 1.5e-6)
    }

    @Test fun frameClockAppliesTheBudgetTheElementLoopRides() {
        // the exact clock the LaunchedEffect drives (corpus frame.json law): first tick
        // emits {0,0,0}; a tick under 1000/60 ms after the last EMIT coalesces
        val clock = despia.engine.scene.SceneFrameClock()
        val first = clock.tick(0.0)
        assertNotNull("first tick emits", first)
        assertEquals("first dt is 0", 0.0, first!!.dt, 1e-9)
        assertNull("8 ms later coalesces (120 Hz)", clock.tick(8.0))
        val second = clock.tick(24.0)
        assertNotNull("24 ms later emits", second)
        assertEquals("dt spans the full gap since the last EMIT", 0.024, second!!.dt, 1e-9)
        assertEquals("frame increments", 1, second.frame)
    }
}
