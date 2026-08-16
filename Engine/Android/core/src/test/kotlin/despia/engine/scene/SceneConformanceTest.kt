package despia.engine.scene

import despia.engine.StackNode
import despia.engine.StackXML
import despia.engine.json
import java.io.File
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

/**
 * The SHARED DSX Scene numeric corpus (OpenSource/Conformance/scene/
 * {transforms,projection,parse}.json) through THIS runtime's scene kernel — the Kotlin
 * leg of the dsx-scene.md P2 row. The TS reference (packages/kernel/test/
 * scene-conformance.test.ts) and the Swift twin (record lane) run the SAME files, so the
 * three implementations cannot drift on a single matrix element. Expected numbers were
 * computed by an independent scratch implementation, never by any kernel under test.
 *
 * parse.json markup parses through StackXML.parse — this runtime's OWN XML parser, the
 * exact tree every renderer walks (the "never a second parser" law from ir.ts / the
 * corpus README). transforms.json trees are hand-built SceneNodes (they are JSON scene
 * nodes, not markup), matching the TS runner's toSceneNodes shape.
 */
class SceneConformanceTest {

    private val tolerance = 1.5e-6

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/scene")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/scene not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun loadCases(file: String, minimum: Int): List<Map<String, Any?>> {
        val doc = json(File(corpusDir(), file).readText()).foundationValue as? Map<String, Any?>
            ?: error("$file: not a JSON object")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("$file: no cases[]")
        assertTrue(cases.size >= minimum, "$file: corpus is suspiciously small (${cases.size})")
        return cases
    }

    private fun num(v: Any?): Double = (v as Number).toDouble()

    @Suppress("UNCHECKED_CAST")
    private fun nums(v: Any?): DoubleArray =
        (v as List<Any?>).map { num(it) }.toDoubleArray()

    private fun mapResolver(vars: Map<String, Any?>?): SceneResolve =
        { _, _, raw -> interpolateSceneHoles(raw) { expr -> (vars ?: emptyMap())[expr] } }

    private fun assertClose(actual: DoubleArray, expected: DoubleArray, label: String) {
        assertEquals(expected.size, actual.size, "$label: length")
        for (i in expected.indices) {
            assertTrue(
                abs(actual[i] - expected[i]) <= tolerance,
                "$label[$i]: ${actual[i]} !~ ${expected[i]}",
            )
        }
    }

    // ── transforms.json — corpus trees are JSON scene nodes, not markup ──────────────

    @Suppress("UNCHECKED_CAST")
    private fun toSceneNode(tree: Map<String, Any?>): SceneNode {
        val attrs = LinkedHashMap<String, String>()
        (tree["id"] as? String)?.let { attrs["id"] = it }
        for (name in listOf("position", "rotation", "scale")) {
            (tree[name] as? String)?.let { attrs[name] = it }
        }
        val kind = SceneNodeKind.fromTag(tree["kind"] as String)
            ?: error("unknown corpus node kind '${tree["kind"]}'")
        val children = (tree["children"] as? List<Map<String, Any?>> ?: emptyList()).map { toSceneNode(it) }
        return SceneNode(kind, tree["id"] as? String, attrs, children)
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun transformsCorpus(): List<DynamicTest> =
        loadCases("transforms.json", 12).map { c ->
            val name = "scene-transforms/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                val diagnostics = ArrayList<SceneDiagnostic>()
                val root = toSceneNode(c["tree"] as Map<String, Any?>)
                val worlds = worldMatrices(
                    listOf(root),
                    mapResolver(c["vars"] as? Map<String, Any?>),
                ) { diagnostics.add(it) }
                val target = findSceneNode(listOf(root), c["node"] as String)
                assertNotNull(target, "$name: target node '${c["node"]}' exists")
                val world = worlds[target]
                assertNotNull(world, "$name: world matrix computed")
                assertClose(world, nums(c["world"]), "world")
                val point = c["point"] as? Map<String, Any?>
                if (point != null) {
                    val local = nums(point["local"])
                    val p = doubleArrayOf(
                        world[0] * local[0] + world[4] * local[1] + world[8] * local[2] + world[12],
                        world[1] * local[0] + world[5] * local[1] + world[9] * local[2] + world[13],
                        world[2] * local[0] + world[6] * local[1] + world[10] * local[2] + world[14],
                    )
                    assertClose(p, nums(point["world"]), "point")
                }
                val expected = (c["diagnostics"] as? Number)?.toInt() ?: 0
                assertEquals(expected, diagnostics.size,
                    "$name: diagnostics ${diagnostics.map { it.message }}")
            }
        }

    // ── projection.json ──────────────────────────────────────────────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun projectionCorpus(): List<DynamicTest> =
        loadCases("projection.json", 6).map { c ->
            val name = "scene-projection/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                val cam = c["camera"] as Map<String, Any?>
                val attrs = LinkedHashMap<String, String>()
                attrs["position"] = cam["position"] as String
                attrs["look-at"] = cam["look-at"] as String
                attrs["near"] = sceneNumberString(num(cam["near"]))
                attrs["far"] = sceneNumberString(num(cam["far"]))
                (cam["fov"] as? Number)?.let { attrs["fov"] = sceneNumberString(it.toDouble()) }
                (cam["size"] as? Number)?.let { attrs["size"] = sceneNumberString(it.toDouble()) }
                val markup = StackNode(
                    tag = "scene",
                    attrs = if (cam["mode"] == "2d") mapOf("mode" to "2d") else emptyMap(),
                    children = listOf(StackNode("camera", attrs, emptyList())),
                )
                val diagnostics = ArrayList<SceneDiagnostic>()
                val ir = parseScene(markup, diag = { diagnostics.add(it) })
                val camera = sceneCamera(ir, mapResolver(null), num(cam["aspect"])) { diagnostics.add(it) }
                for (point in c["points"] as List<Map<String, Any?>>) {
                    val world = nums(point["world"])
                    assertClose(
                        projectToNdc(camera.proj, camera.view, world),
                        nums(point["ndc"]),
                        "ndc(${world.joinToString(",")})",
                    )
                }
                assertEquals(0, diagnostics.size,
                    "$name: no diagnostics expected, got ${diagnostics.map { it.message }}")
            }
        }

    // ── parse.json — markup through StackXML.parse (never a second parser) ───────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun parseCorpus(): List<DynamicTest> =
        loadCases("parse.json", 8).map { c ->
            val name = "scene-parse/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                val diagnostics = ArrayList<SceneDiagnostic>()
                val diag: SceneDiag = { diagnostics.add(it) }
                val markup = StackXML.parse(c["markup"] as String)
                assertNotNull(markup, "$name: markup parses through StackXML")
                val ir = parseScene(markup, diag)
                val resolver = mapResolver(c["vars"] as? Map<String, Any?>)
                val expect = c["expect"] as Map<String, Any?>
                (expect["mode"] as? String)?.let { assertEquals(it, ir.mode.word, "mode") }
                (expect["background"] as? String)?.let { want ->
                    val raw = ir.attrs["background"] ?: "#000000"
                    assertEquals(want, resolver(null, "background", raw), "background")
                }
                (expect["nodes"] as? List<Map<String, Any?>>)?.let {
                    checkNodes(ir.nodes, it, "nodes", resolver, diag)
                }
                val expected = (c["diagnostics"] as? Number)?.toInt() ?: 0
                assertEquals(expected, diagnostics.size,
                    "$name: diagnostics ${diagnostics.map { it.message }}")
            }
        }

    // ── model.json — GLB fixtures through the P4 parser (embedded buffers only) ──────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun modelCorpus(): List<DynamicTest> {
        val doc = json(File(corpusDir(), "model.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("model.json: not a JSON object")
        val fixtures = doc["fixtures"] as? Map<String, Any?> ?: error("model.json: no fixtures{}")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("model.json: no cases[]")
        assertTrue(cases.size >= 6, "model.json: corpus is suspiciously small (${cases.size})")
        return cases.map { c ->
            val name = "scene-model/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                val b64 = fixtures[c["fixture"]] as? String
                assertNotNull(b64, "$name: fixture '${c["fixture"]}' exists")
                val result = parseGlb(java.util.Base64.getDecoder().decode(b64))
                val error = c["error"] as? String
                if (error != null) {
                    assertEquals(error, result.error?.code, "$name: expected error '$error'")
                    return@dynamicTest
                }
                val model = result.model
                assertNotNull(model, "$name: parses (${result.error?.code})")
                val want = c["expect"] as? Map<String, Any?> ?: emptyMap()
                (want["meshCount"] as? Number)?.let { assertEquals(it.toInt(), model.meshes.size, "meshCount") }
                (want["drawCount"] as? Number)?.let { assertEquals(it.toInt(), model.draws.size, "drawCount") }
                for (meshWant in want["meshes"] as? List<Map<String, Any?>> ?: emptyList()) {
                    val index = (meshWant["index"] as Number).toInt()
                    val primitive = model.meshes.getOrNull(index)?.primitives?.firstOrNull()
                    assertNotNull(primitive, "mesh[$index] primitive 0 exists")
                    (meshWant["vertexCount"] as? Number)?.let {
                        assertEquals(it.toInt(), primitive.positions.size / 3, "mesh[$index].vertexCount")
                    }
                    (meshWant["indexCount"] as? Number)?.let {
                        assertEquals(it.toInt(), primitive.indices.size, "mesh[$index].indexCount")
                    }
                    (meshWant["positions"] as? List<Any?>)?.let { assertClose(primitive.positions, nums(it), "mesh[$index].positions") }
                    (meshWant["normals"] as? List<Any?>)?.let { assertClose(primitive.normals, nums(it), "mesh[$index].normals") }
                    (meshWant["indices"] as? List<Any?>)?.let { wantIndices ->
                        assertEquals(wantIndices.map { (it as Number).toInt() }, primitive.indices.toList(), "mesh[$index].indices")
                    }
                    (meshWant["baseColor"] as? List<Any?>)?.let { assertClose(primitive.baseColor, nums(it), "mesh[$index].baseColor") }
                }
                for (drawWant in want["draws"] as? List<Map<String, Any?>> ?: emptyList()) {
                    val index = (drawWant["index"] as Number).toInt()
                    val draw = model.draws.getOrNull(index)
                    assertNotNull(draw, "draw[$index] exists")
                    assertEquals((drawWant["mesh"] as Number).toInt(), draw.mesh, "draw[$index].mesh")
                    assertClose(draw.world, nums(drawWant["world"]), "draw[$index].world")
                }
                for (t in want["transformed"] as? List<Map<String, Any?>> ?: emptyList()) {
                    val draw = model.draws[(t["draw"] as Number).toInt()]
                    val primitive = model.meshes[draw.mesh].primitives.first()
                    val vertex = (t["vertex"] as Number).toInt()
                    val m = draw.world
                    val lx = primitive.positions[vertex * 3]
                    val ly = primitive.positions[vertex * 3 + 1]
                    val lz = primitive.positions[vertex * 3 + 2]
                    val world = doubleArrayOf(
                        m[0] * lx + m[4] * ly + m[8] * lz + m[12],
                        m[1] * lx + m[5] * ly + m[9] * lz + m[13],
                        m[2] * lx + m[6] * ly + m[10] * lz + m[14],
                    )
                    assertClose(world, nums(t["world"]), "transformed[draw ${t["draw"]} vertex $vertex]")
                }
            }
        }
    }

    // ── text3d.json — the billboard-quad layout law ──────────────────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun text3dCorpus(): List<DynamicTest> =
        loadCases("text3d.json", 4).map { c ->
            val name = "scene-text3d/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                val diagnostics = ArrayList<SceneDiagnostic>()
                val attrs = (c["attrs"] as Map<String, Any?>).mapValues { it.value as String }
                val node = SceneNode(SceneNodeKind.TEXT3D, null, attrs, emptyList())
                val props = resolvedProps(node, mapResolver(c["vars"] as? Map<String, Any?>)) { diagnostics.add(it) }
                val quad = text3dQuad(props)
                val expect = c["expect"] as? Map<String, Any?>
                if (!c.containsKey("expect") || expect == null) {
                    assertEquals(null, quad, "$name: empty value lays out no quad")
                } else {
                    assertNotNull(quad, "$name: quad exists")
                    assertClose(quad.center, nums(expect["center"]), "center")
                    assertTrue(abs(quad.halfWidth - num(expect["halfWidth"])) <= tolerance,
                        "halfWidth: ${quad.halfWidth} !~ ${expect["halfWidth"]}")
                    assertTrue(abs(quad.halfHeight - num(expect["halfHeight"])) <= tolerance,
                        "halfHeight: ${quad.halfHeight} !~ ${expect["halfHeight"]}")
                }
                val expected = (c["diagnostics"] as? Number)?.toInt() ?: 0
                assertEquals(expected, diagnostics.size,
                    "$name: diagnostics ${diagnostics.map { it.message }}")
            }
        }

    // ── frame.json — the on:frame schedule law (the budget fold) ─────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun frameCorpus(): List<DynamicTest> =
        loadCases("frame.json", 3).map { c ->
            val name = "scene-frame/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                val ticks = (c["ticks"] as List<Any?>).map { num(it) }
                val expect = c["expect"] as List<Map<String, Any?>>
                val emitted = sceneFrameSchedule(ticks)
                assertEquals(expect.size, emitted.size,
                    "$name: emitted count (${emitted.map { "${it.dt}/${it.elapsed}/${it.frame}" }})")
                expect.forEachIndexed { i, want ->
                    val got = emitted[i]
                    assertTrue(abs(got.dt - num(want["dt"])) <= tolerance, "[$i].dt: ${got.dt} !~ ${want["dt"]}")
                    assertTrue(abs(got.elapsed - num(want["elapsed"])) <= tolerance,
                        "[$i].elapsed: ${got.elapsed} !~ ${want["elapsed"]}")
                    assertEquals((want["frame"] as Number).toInt(), got.frame, "[$i].frame")
                }
                // the stated semantics a runner CAN assert: monotonic elapsed/frame, dt ≥ 0
                emitted.forEachIndexed { i, payload ->
                    assertTrue(payload.dt >= 0.0, "[$i].dt non-negative")
                    if (i > 0) {
                        assertTrue(payload.elapsed > emitted[i - 1].elapsed, "[$i].elapsed strictly increases")
                        assertEquals(emitted[i - 1].frame + 1, payload.frame, "[$i].frame increments")
                    }
                }
            }
        }

    // ── the P5 lanes (dsx-scene.md P5): animation · bind · collide · orbit · lighting ─

    private val noHoles: SceneResolve = { _, _, raw -> raw }

    private fun animNode(attrs: Map<String, String>): SceneNode =
        SceneNode(SceneNodeKind.ANIMATE, null, attrs, emptyList())

    private class TweenSetup(val spec: SceneTweenSpec, val from: DoubleArray, val base: DoubleArray)

    @Suppress("UNCHECKED_CAST")
    private fun tweenSetup(c: Map<String, Any?>, name: String): TweenSetup {
        val diagnostics = ArrayList<SceneDiagnostic>()
        val attrs = (c["spec"] as Map<String, Any?>).mapValues { it.value as String }
        val spec = parseSceneTween(animNode(attrs), noHoles) { diagnostics.add(it) }
        assertNotNull(spec, "$name: spec parses (${diagnostics.map { it.message }})")
        assertEquals(0, diagnostics.size, "$name: no diagnostics ${diagnostics.map { it.message }}")
        val base = parseSceneAnimValue(spec!!.target, c["base"] as String)
        assertNotNull(base, "$name: base parses")
        return TweenSetup(spec, spec.from ?: base!!, base!!)
    }

    // ── animation.json — tweens · the when gate · transitions ────────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun animationCorpus(): List<DynamicTest> {
        val doc = json(File(corpusDir(), "animation.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("animation.json: not a JSON object")
        val tweens = doc["tweens"] as? List<Map<String, Any?>> ?: error("animation.json: no tweens[]")
        val gated = doc["gated"] as? List<Map<String, Any?>> ?: error("animation.json: no gated[]")
        val transitions = doc["transitions"] as? List<Map<String, Any?>> ?: error("animation.json: no transitions[]")
        assertTrue(tweens.size + gated.size + transitions.size >= 14,
            "animation.json: corpus is suspiciously small")
        val out = ArrayList<DynamicTest>()

        for (c in tweens) {
            val name = "scene-animation/tween/${c["name"]}"
            out.add(DynamicTest.dynamicTest(name) {
                val setup = tweenSetup(c, name)
                for (want in c["samples"] as List<Map<String, Any?>>) {
                    val t = num(want["t"])
                    val got = sceneTweenValue(setup.spec, setup.from, setup.base, t)
                    assertClose(got.value, nums(want["value"]), "value@$t")
                    assertEquals(want["overriding"] as Boolean, got.overriding, "overriding@$t")
                    assertEquals(want["done"] as Boolean, got.done, "done@$t")
                }
                (c["format"] as? Map<String, Any?>)?.let { format ->
                    val got = sceneTweenValue(setup.spec, setup.from, setup.base, num(format["t"]))
                    assertEquals(format["value"] as String,
                        formatSceneAnimValue(setup.spec.target, got.value), "formatted override string")
                }
            })
        }

        for (c in gated) {
            val name = "scene-animation/gated/${c["name"]}"
            out.add(DynamicTest.dynamicTest(name) {
                val setup = tweenSetup(c, name)
                // THE GATE LAW (the corpus _note): falsy ⇒ base; each falsy→truthy edge
                // restarts the clock. The fold below IS the law each surface implements.
                val events = c["events"] as List<Map<String, Any?>>
                for (want in c["samples"] as List<Map<String, Any?>>) {
                    val t = num(want["t"])
                    var playing = false
                    var startMs = 0.0
                    for (event in events) {
                        if (num(event["t"]) > t) break
                        val open = event["when"] as Boolean
                        if (open && !playing) startMs = num(event["t"])
                        playing = open
                    }
                    val value: DoubleArray
                    val overriding: Boolean
                    if (playing) {
                        val got = sceneTweenValue(setup.spec, setup.from, setup.base, t - startMs)
                        value = got.value; overriding = got.overriding
                    } else {
                        value = setup.base; overriding = false
                    }
                    assertClose(value, nums(want["value"]), "value@$t")
                    assertEquals(want["overriding"] as Boolean, overriding, "overriding@$t")
                }
            })
        }

        for (c in transitions) {
            val name = "scene-animation/transition/${c["name"]}"
            out.add(DynamicTest.dynamicTest(name) {
                val diagnostics = ArrayList<SceneDiagnostic>()
                val entries = parseSceneTransitions(c["entry"] as String) { diagnostics.add(it) }
                assertEquals(1, entries.size, "$name: entry parses ${diagnostics.map { it.message }}")
                assertEquals(0, diagnostics.size, "$name: no diagnostics")
                val entry = entries[0]
                fun parse(raw: String): DoubleArray {
                    val v = parseSceneAnimValue(entry.property, raw)
                    assertNotNull(v, "$name: $raw parses as ${entry.property}")
                    return v!!
                }
                var state: SceneTransitionState? = null
                fun rendered(t: Double): SceneTransitionSample {
                    val s = state ?: return SceneTransitionSample(parse(c["base0"] as String), done = true)
                    return sceneTransitionValue(entry, s, t)
                }
                val events = c["events"] as List<Map<String, Any?>>
                var next = 0
                for (want in c["samples"] as List<Map<String, Any?>>) {
                    val t = num(want["t"])
                    while (next < events.size && num(events[next]["t"]) <= t) {
                        val event = events[next]
                        // THE RETARGET LAW: the new glide starts from the CURRENT RENDERED value
                        state = SceneTransitionState(
                            rendered(num(event["t"])).value, parse(event["base"] as String), num(event["t"]),
                        )
                        next += 1
                    }
                    val got = rendered(t)
                    assertClose(got.value, nums(want["value"]), "value@$t")
                    assertEquals(want["done"] as Boolean, got.done, "done@$t")
                }
            })
        }
        return out
    }

    // ── bind.json — rows · keyed diff · row scope · nesting · the cap ────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun bindCorpus(): List<DynamicTest> =
        loadCases("bind.json", 6).map { c ->
            val name = "scene-bind/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                val diagnostics = ArrayList<SceneDiagnostic>()
                val diag: SceneDiag = { diagnostics.add(it) }
                val key = c["key"] as String
                val expect = c["expect"] as Map<String, Any?>
                when (c["kind"] as String) {
                    "rows" -> {
                        val rows = sceneBindRows(c["value"], key, diag)
                        assertEquals(expect["keys"], rows.map { it.key }, "keys")
                        assertEquals((expect["indices"] as List<Any?>).map { (it as Number).toInt() },
                            rows.map { it.index }, "indices")
                        assertEquals(0, diagnostics.size)
                    }
                    "diff" -> {
                        val rows = sceneBindRows(c["value"], key, diag)
                        val diff = diffSceneBindRows(c["previous"] as List<String>, rows)
                        assertEquals(expect["added"], diff.added, "added")
                        assertEquals(expect["removed"], diff.removed, "removed")
                        assertEquals(expect["retained"], diff.retained, "retained")
                    }
                    "scope" -> {
                        val templateSpec = c["template"] as Map<String, Any?>
                        val template = SceneNode(
                            SceneNodeKind.fromTag(templateSpec["kind"] as String)!!,
                            null,
                            (templateSpec["attrs"] as Map<String, Any?>).mapValues { it.value as String },
                            emptyList(),
                        )
                        val rows = sceneBindRows(c["value"], key, diag)
                        val positions = ArrayList<List<Double>>()
                        val colors = ArrayList<String>()
                        for (row in rows) {
                            val instance = instantiateSceneRow(listOf(template)).first()
                            // the row scope: item.* resolves against the row value (the <list> row law)
                            val rowResolve: SceneResolve = { _, _, raw ->
                                interpolateSceneHoles(raw) { expr ->
                                    when {
                                        expr == "item" -> row.item
                                        expr == "item.index" -> row.index
                                        expr.startsWith("item.") -> (row.item as? Map<String, Any?>)?.get(expr.substring(5))
                                        else -> null
                                    }
                                }
                            }
                            val props = resolvedProps(instance, rowResolve, diag)
                            positions.add(props.position.toList())
                            colors.add(props.color)
                        }
                        assertEquals((expect["positions"] as List<List<Any?>>).map { p -> p.map { num(it) } },
                            positions, "positions")
                        assertEquals(expect["colors"], colors, "colors")
                        assertEquals(0, diagnostics.size)
                    }
                    "nested" -> {
                        val outer = sceneBindRows(c["value"], key, diag)
                        assertEquals(expect["outerKeys"], outer.map { it.key }, "outer keys")
                        val inner = outer.map { r ->
                            sceneBindRows(
                                (r.item as Map<String, Any?>)[c["innerField"] as String],
                                c["innerKey"] as String, diag,
                            ).map { it.key }
                        }
                        assertEquals(expect["innerKeys"], inner, "inner keys")
                        assertEquals(0, diagnostics.size)
                    }
                    else -> { // cap: the runner builds the oversized array (a corpus file
                        // should not carry 300 rows)
                        val count = (c["count"] as Number).toInt()
                        val rows = sceneBindRows(List(count) { it }, key, diag)
                        assertEquals((expect["rowCount"] as Number).toInt(), rows.size, "rowCount")
                        assertEquals(expect["firstKey"], rows.first().key, "firstKey")
                        assertEquals(expect["lastKey"], rows.last().key, "lastKey")
                        assertEquals((expect["diagnostics"] as Number).toInt(), diagnostics.size, "diagnostics")
                        assertTrue(diagnostics.all { it.code == SceneDiagnosticCode.BIND_OVERFLOW })
                    }
                }
            }
        }

    // ── collide.json — depth laws · world AABB · the enter fold ──────────────────────

    @Suppress("UNCHECKED_CAST")
    private fun toColliderShape(spec: Map<String, Any?>): SceneColliderShape {
        val id = spec["id"] as String
        return if (spec["kind"] == "sphere") {
            SceneColliderShape.Sphere(id, nums(spec["center"]), num(spec["radius"]))
        } else {
            SceneColliderShape.Box(id, nums(spec["min"]), nums(spec["max"]))
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun collideCorpus(): List<DynamicTest> =
        loadCases("collide.json", 6).map { c ->
            val name = "scene-collide/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                when (c["kind"] as String) {
                    "contacts" -> {
                        val got = sceneContacts((c["shapes"] as List<Map<String, Any?>>).map { toColliderShape(it) })
                        val want = c["expect"] as List<Map<String, Any?>>
                        assertEquals(want.size, got.size,
                            "$name: contact count (${got.map { "${it.a}/${it.b}/${it.depth}" }})")
                        want.forEachIndexed { i, w ->
                            assertEquals(w["a"], got[i].a, "[$i].a")
                            assertEquals(w["b"], got[i].b, "[$i].b")
                            assertTrue(abs(got[i].depth - num(w["depth"])) <= tolerance,
                                "[$i].depth: ${got[i].depth} !~ ${w["depth"]}")
                        }
                    }
                    "aabb" -> {
                        val trs = c["trs"] as Map<String, Any?>
                        val world = mat4Trs(nums(trs["position"]), nums(trs["rotation"]), nums(trs["scale"]))
                        val got = worldAabb(world, nums(c["half"]))
                        val want = c["expect"] as Map<String, Any?>
                        assertClose(got.min, nums(want["min"]), "min")
                        assertClose(got.max, nums(want["max"]), "max")
                    }
                    else -> { // track: the enter law as frame data
                        val tracker = SceneCollisionTracker()
                        val want = c["expect"] as List<List<Map<String, Any?>>>
                        (c["frames"] as List<List<Map<String, Any?>>>).forEachIndexed { i, frame ->
                            val events = tracker.step(frame.map { toColliderShape(it) })
                            assertEquals(want[i].size, events.size,
                                "frame $i: event count (${events.map { "${it.id}/${it.other}" }})")
                            want[i].forEachIndexed { j, w ->
                                assertEquals(w["id"], events[j].id, "frame $i[$j].id")
                                assertEquals(w["other"], events[j].other, "frame $i[$j].other")
                                assertTrue(abs(events[j].depth - num(w["depth"])) <= tolerance,
                                    "frame $i[$j].depth")
                            }
                        }
                    }
                }
            }
        }

    // ── orbit.json — the spherical/drag/zoom laws ────────────────────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun orbitCorpus(): List<DynamicTest> =
        loadCases("orbit.json", 4).map { c ->
            val name = "scene-orbit/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                val camera = c["camera"] as Map<String, Any?>
                val lookAt = nums(camera["lookAt"])
                var state = orbitFromCamera(nums(camera["position"]), lookAt)
                for (op in c["ops"] as List<Map<String, Any?>>) {
                    val drag = op["drag"] as? List<Any?>
                    state = if (drag != null) orbitDrag(state, num(drag[0]), num(drag[1]))
                    else {
                        val zoom = op["zoom"] as Map<String, Any?>
                        orbitZoom(state, num(zoom["deltaY"]), num(zoom["near"]), num(zoom["far"]))
                    }
                }
                val expect = c["expect"] as Map<String, Any?>
                assertClose(
                    doubleArrayOf(state.yawDeg, state.pitchDeg, state.distance),
                    doubleArrayOf(num(expect["yawDeg"]), num(expect["pitchDeg"]), num(expect["distance"])),
                    "state",
                )
                assertClose(orbitPosition(state, lookAt), nums(expect["position"]), "position")
            }
        }

    // ── lighting.json — attenuation · lit color · the cap · fog ──────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun lightingCorpus(): List<DynamicTest> =
        loadCases("lighting.json", 5).map { c ->
            val name = "scene-lighting/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                when (c["kind"] as String) {
                    "attenuation" -> {
                        for (s in c["samples"] as List<Map<String, Any?>>) {
                            val got = scenePointAttenuation(num(s["d"]), num(c["range"]))
                            assertTrue(abs(got - num(s["value"])) <= tolerance,
                                "att(${s["d"]}): $got !~ ${s["value"]}")
                        }
                    }
                    "lit" -> {
                        val directional = (c["directional"] as? Map<String, Any?>)?.let {
                            SceneDirectionalResolved(nums(it["dir"]), nums(it["color"]))
                        }
                        val points = (c["points"] as List<Map<String, Any?>>).map {
                            ScenePointLightResolved(
                                nums(it["position"]), nums(it["color"]), num(it["intensity"]), num(it["range"]),
                            )
                        }
                        val got = sceneLitColor(
                            nums(c["base"]), nums(c["normal"]), nums(c["point"]), nums(c["ambient"]),
                            directional, points,
                        )
                        assertClose(got, nums(c["expect"]), "lit")
                    }
                    "cap" -> {
                        val diagnostics = ArrayList<SceneDiagnostic>()
                        val ir = SceneIR(
                            SceneMode.THREE_D, emptyMap(),
                            (c["lights"] as List<Map<String, Any?>>).map { attrs ->
                                SceneNode(SceneNodeKind.LIGHT, null,
                                    attrs.mapValues { it.value as String }, emptyList())
                            },
                        )
                        val lighting = sceneLighting(ir, noHoles) { diagnostics.add(it) }
                        val want = c["expect"] as Map<String, Any?>
                        assertEquals((want["pointCount"] as Number).toInt(), lighting.points.size, "pointCount")
                        val positions = want["positions"] as List<Any?>
                        lighting.points.forEachIndexed { i, p ->
                            assertClose(p.position, nums(positions[i]), "points[$i]")
                        }
                        assertEquals((want["diagnostics"] as Number).toInt(), diagnostics.size,
                            "diagnostics ${diagnostics.map { it.message }}")
                        assertTrue(diagnostics.all { it.code == SceneDiagnosticCode.LIGHT_CAP })
                    }
                    "fog-factor" -> {
                        for (s in c["samples"] as List<Map<String, Any?>>) {
                            val got = sceneFogFactor(num(s["d"]), num(c["near"]), num(c["far"]))
                            assertTrue(abs(got - num(s["value"])) <= tolerance,
                                "fog(${s["d"]}): $got !~ ${s["value"]}")
                        }
                    }
                    else -> { // fog-blend: final = f·lit + (1 − f)·fogColor (the blend law verbatim)
                        val f = sceneFogFactor(num(c["d"]), num(c["near"]), num(c["far"]))
                        val lit = nums(c["lit"])
                        val fogColor = nums(c["fogColor"])
                        val got = DoubleArray(3) { i -> f * lit[i] + (1.0 - f) * fogColor[i] }
                        assertClose(got, nums(c["expect"]), "blend")
                    }
                }
            }
        }

    // ── physics.json — the G2 fixed-tick solver (dsx-game.md §2 G2) ──────────────────

    @Suppress("UNCHECKED_CAST")
    private fun physicsBodySpec(spec: Map<String, Any?>): ScenePhysicsBodySpec {
        val shape = spec["shape"] as Map<String, Any?>
        return ScenePhysicsBodySpec(
            id = spec["id"] as String,
            kind = spec["kind"] as String,
            shape = if (shape["kind"] == "sphere") ScenePhysicsShape.Sphere(num(shape["radius"]))
            else ScenePhysicsShape.Box(nums(shape["half"])),
            position = (spec["position"] as? List<Any?>)?.let { nums(it) } ?: doubleArrayOf(0.0, 0.0, 0.0),
            velocity = (spec["velocity"] as? List<Any?>)?.let { nums(it) } ?: doubleArrayOf(0.0, 0.0, 0.0),
            rotation = (spec["rotation"] as? List<Any?>)?.let { nums(it) } ?: doubleArrayOf(0.0, 0.0, 0.0),
            angularVelocity = (spec["angularVelocity"] as? List<Any?>)?.let { nums(it) } ?: doubleArrayOf(0.0, 0.0, 0.0),
            torque = (spec["torque"] as? List<Any?>)?.let { nums(it) } ?: doubleArrayOf(0.0, 0.0, 0.0),
            angularDamping = (spec["angularDamping"] as? Number)?.toDouble()
                ?: SCENE_PHYSICS_DEFAULT_ANGULAR_DAMPING,
            mass = (spec["mass"] as? Number)?.toDouble() ?: 1.0,
            bounce = (spec["bounce"] as? Number)?.toDouble() ?: 0.0,
            friction = (spec["friction"] as? Number)?.toDouble() ?: 0.5,
            trigger = spec["trigger"] as? Boolean ?: false,
            layer = spec["layer"] as? String ?: "default",
            collides = (spec["collides"] as? List<Any?>)?.map { it as String },
            speed = (spec["speed"] as? Number)?.toDouble() ?: SCENE_PHYSICS_DEFAULT_SPEED,
            jump = (spec["jump"] as? Number)?.toDouble() ?: SCENE_PHYSICS_DEFAULT_JUMP,
        )
    }

    private class PhysicsSample(
        val position: DoubleArray, val velocity: DoubleArray,
        val rotation: DoubleArray, val angularVelocity: DoubleArray,
        val angularMomentum: DoubleArray,
        val grounded: Boolean, val sleeping: Boolean,
    )

    private fun physicsBodyAngularMomentum(body: ScenePhysicsBody): DoubleArray {
        val x = body.orientation[0]
        val y = body.orientation[1]
        val z = body.orientation[2]
        val w = body.orientation[3]
        val axes = arrayOf(
            doubleArrayOf(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
            doubleArrayOf(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
            doubleArrayOf(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)),
        )
        val out = doubleArrayOf(0.0, 0.0, 0.0)
        for (axis in 0 until 3) {
            val basis = axes[axis]
            val component = body.angularVelocity[0] * basis[0] +
                body.angularVelocity[1] * basis[1] + body.angularVelocity[2] * basis[2]
            val inertia = if (body.invInertia[axis] > 0.0) 1.0 / body.invInertia[axis] else 0.0
            for (k in 0 until 3) out[k] += basis[k] * component * inertia
        }
        return out
    }

    private class PhysicsSimRun(
        val world: ScenePhysicsWorld,
        val samples: Map<String, PhysicsSample>,
        /** "tick name id other" lines — the exact event sequence */
        val events: List<String>,
    )

    /** the corpus sim driver (the TS runner's runPhysicsSim, verbatim): writes land
     *  BEFORE their tick's step; kinematic drives position the body at
     *  start + velocity·dt·(tick+1); samples record state AFTER the named tick's step */
    @Suppress("UNCHECKED_CAST")
    private fun runPhysicsSim(c: Map<String, Any?>): PhysicsSimRun {
        val gravity = (c["gravity"] as? List<Any?>)?.let { nums(it) } ?: doubleArrayOf(0.0, -9.81, 0.0)
        val world = createScenePhysicsWorld(
            gravity, (c["bodies"] as List<Map<String, Any?>>).map { physicsBodySpec(it) },
            c["mode2d"] == true,
        )
        val wanted = HashMap<Int, MutableList<String>>()
        for (s in c["samples"] as? List<Map<String, Any?>> ?: emptyList()) {
            wanted.getOrPut((s["tick"] as Number).toInt()) { ArrayList() }.add(s["id"] as String)
        }
        val samples = HashMap<String, PhysicsSample>()
        val events = ArrayList<String>()
        val drivenRotations = LinkedHashMap<String, DoubleArray>()
        val ticks = (c["ticks"] as Number).toInt()
        for (n in 0 until ticks) {
            for (w in c["writes"] as? List<Map<String, Any?>> ?: emptyList()) {
                if ((w["tick"] as Number).toInt() != n) continue
                when (w["attr"]) {
                    "velocity" -> scenePhysicsWriteVelocity(world, w["id"] as String, nums(w["value"]))
                    "angular-velocity" -> scenePhysicsWriteAngularVelocity(world, w["id"] as String, nums(w["value"]))
                    "torque" -> scenePhysicsWriteTorque(world, w["id"] as String, nums(w["value"]))
                    "rotation" -> scenePhysicsTeleportRotation(world, w["id"] as String, nums(w["value"]))
                    else -> scenePhysicsTeleport(world, w["id"] as String, nums(w["value"]))
                }
            }
            val intents = HashMap<String, ScenePhysicsIntent>()
            for (d in c["drives"] as? List<Map<String, Any?>> ?: emptyList()) {
                val start = nums(d["start"])
                val velocity = nums(d["velocity"])
                intents[d["id"] as String] = ScenePhysicsIntent(position = doubleArrayOf(
                    start[0] + velocity[0] * (SCENE_PHYSICS_DT * (n + 1)),
                    start[1] + velocity[1] * (SCENE_PHYSICS_DT * (n + 1)),
                    start[2] + velocity[2] * (SCENE_PHYSICS_DT * (n + 1)),
                ))
            }
            for (drive in c["rotationDrives"] as? List<Map<String, Any?>> ?: emptyList()) {
                if ((drive["tick"] as Number).toInt() == n) {
                    drivenRotations[drive["id"] as String] = nums(drive["value"])
                }
            }
            for ((id, rotation) in drivenRotations) {
                val prior = intents[id]
                intents[id] = ScenePhysicsIntent(
                    move = prior?.move, position = prior?.position, rotation = rotation,
                )
            }
            for (m in c["moves"] as? List<Map<String, Any?>> ?: emptyList()) {
                val from = (m["from"] as Number).toInt()
                val to = (m["to"] as Number).toInt()
                if (n in from..to) intents[m["id"] as String] = ScenePhysicsIntent(move = nums(m["move"]))
            }
            val result = stepScenePhysicsWorld(world, intents)
            assertEquals(n, result.tick, "tick is the zero-based step index")
            assertEquals(SCENE_PHYSICS_DT, result.dt, "dt is exactly 1/60")
            for ((name, list) in listOf(
                "collision" to result.collisions, "enter" to result.enters, "exit" to result.exits,
            )) {
                for (e in list) events.add("$n $name ${e.id} ${e.other}")
            }
            for (id in wanted[n] ?: emptyList<String>()) {
                val body = world.byId[id] ?: error("sample body '$id' exists")
                samples["$n:$id"] = PhysicsSample(
                    body.position.copyOf(), body.velocity.copyOf(), body.rotation.copyOf(),
                    body.angularVelocity.copyOf(), physicsBodyAngularMomentum(body),
                    body.grounded, body.sleeping,
                )
            }
        }
        return PhysicsSimRun(world, samples, events)
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun physicsCorpus(): List<DynamicTest> {
        val doc = json(File(corpusDir(), "physics.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("physics.json: not a JSON object")
        val constants = doc["constants"] as? Map<String, Any?> ?: error("physics.json: no constants{}")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("physics.json: no cases[]")
        assertTrue(cases.size >= 16, "physics.json: corpus is suspiciously small (${cases.size})")
        val out = ArrayList<DynamicTest>()

        out.add(DynamicTest.dynamicTest("scene-physics/constants — the pinned constants match the kernel") {
            assertTrue(abs(num(constants["dt"]) - SCENE_PHYSICS_DT) <= tolerance, "dt")
            assertEquals((constants["maxStepsPerFrame"] as Number).toInt(), SCENE_PHYSICS_MAX_STEPS, "maxStepsPerFrame")
            assertClose(SCENE_PHYSICS_DEFAULT_GRAVITY, nums(constants["gravity"]), "gravity")
            assertEquals(num(constants["correctionPercent"]), SCENE_PHYSICS_CORRECTION_PERCENT, "correctionPercent")
            assertEquals(num(constants["slop"]), SCENE_PHYSICS_SLOP, "slop")
            assertEquals(num(constants["restitutionMinSpeed"]), SCENE_PHYSICS_RESTITUTION_MIN_SPEED, "restitutionMinSpeed")
            assertEquals(num(constants["groundNormalY"]), SCENE_PHYSICS_GROUND_NORMAL_Y, "groundNormalY")
            assertEquals(num(constants["sleepSpeed"]), SCENE_PHYSICS_SLEEP_SPEED, "sleepSpeed")
            assertEquals((constants["sleepTicks"] as Number).toInt(), SCENE_PHYSICS_SLEEP_TICKS, "sleepTicks")
            assertEquals((constants["characterSlideIterations"] as Number).toInt(), SCENE_PHYSICS_SLIDE_ITERATIONS, "characterSlideIterations")
            assertEquals((constants["manifoldIterations"] as Number).toInt(), SCENE_PHYSICS_MANIFOLD_ITERATIONS, "manifoldIterations")
            assertEquals(num(constants["defaultMass"]), 1.0, "defaultMass")
            assertEquals(num(constants["defaultBounce"]), 0.0, "defaultBounce")
            assertEquals(num(constants["defaultFriction"]), 0.5, "defaultFriction")
            assertEquals(num(constants["defaultSpeed"]), SCENE_PHYSICS_DEFAULT_SPEED, "defaultSpeed")
            assertEquals(num(constants["defaultJump"]), SCENE_PHYSICS_DEFAULT_JUMP, "defaultJump")
            assertEquals(num(constants["defaultAngularDamping"]), SCENE_PHYSICS_DEFAULT_ANGULAR_DAMPING,
                "defaultAngularDamping")
            assertEquals(num(constants["radiansToDegrees"]), SCENE_PHYSICS_RADIANS_TO_DEGREES,
                "radiansToDegrees")
        })

        for (c in cases) {
            val name = "scene-physics/${c["name"]}"
            out.add(DynamicTest.dynamicTest(name) {
                when (c["kind"] as String) {
                    "world" -> {
                        val diagnostics = ArrayList<SceneDiagnostic>()
                        val diag: SceneDiag = { diagnostics.add(it) }
                        val markup = StackXML.parse(c["markup"] as String)
                        assertNotNull(markup, "$name: markup parses through StackXML")
                        val ir = parseScene(markup!!, diag)
                        val extraction = extractScenePhysics(ir, mapResolver(c["vars"] as? Map<String, Any?>), diag)
                        val want = c["expect"] as Map<String, Any?>
                        assertClose(extraction.gravity, nums(want["gravity"]), "gravity")
                        // build the world from the extraction — the corpus pins the BODY records
                        val world = createScenePhysicsWorld(extraction.gravity, extraction.bodies)
                        val wantBodies = want["bodies"] as List<Map<String, Any?>>
                        assertEquals(wantBodies.size, world.bodies.size, "$name: body count")
                        wantBodies.forEachIndexed { i, w ->
                            val body = world.bodies[i]
                            assertEquals(w["id"], body.id, "[$i].id")
                            assertEquals(w["kind"], body.kind, "[$i].kind")
                            assertEquals(w["shape"], body.shape, "[$i].shape")
                            if (w["shape"] == "sphere") {
                                assertTrue(abs(body.radius - num(w["radius"])) <= tolerance,
                                    "[$i].radius: ${body.radius} !~ ${w["radius"]}")
                            } else {
                                assertClose(body.half, nums(w["half"]), "[$i].half")
                            }
                            assertClose(body.position, nums(w["position"]), "[$i].position")
                            assertClose(body.velocity, nums(w["velocity"]), "[$i].velocity")
                            (w["rotation"] as? List<Any?>)?.let { assertClose(body.rotation, nums(it), "[$i].rotation") }
                            (w["angularVelocity"] as? List<Any?>)?.let {
                                assertClose(body.angularVelocity, nums(it), "[$i].angularVelocity")
                            }
                            (w["torque"] as? List<Any?>)?.let { assertClose(body.torque, nums(it), "[$i].torque") }
                            (w["invInertia"] as? List<Any?>)?.let {
                                assertClose(body.invInertia, nums(it), "[$i].invInertia")
                            }
                            (w["angularDamping"] as? Number)?.let {
                                assertEquals(it.toDouble(), body.angularDamping, "[$i].angularDamping")
                            }
                            assertTrue(abs(body.invMass - num(w["invMass"])) <= tolerance, "[$i].invMass")
                            assertEquals(num(w["bounce"]), body.bounce, "[$i].bounce")
                            assertEquals(num(w["friction"]), body.friction, "[$i].friction")
                            assertEquals(w["trigger"], body.trigger, "[$i].trigger")
                            assertEquals(w["layer"], body.layer, "[$i].layer")
                            assertEquals(w["collides"], body.collides, "[$i].collides")
                            assertEquals(num(w["speed"]), body.speed, "[$i].speed")
                            assertEquals(num(w["jump"]), body.jump, "[$i].jump")
                        }
                        assertEquals((c["diagnostics"] as? Number)?.toInt() ?: 0, diagnostics.size,
                            "$name: diagnostics ${diagnostics.map { it.message }}")
                        (c["corners"] as? List<List<Any?>>)?.let { corners ->
                            assertEquals(1, world.bodies.size, "corner containment cases own one body")
                            val body = world.bodies[0]
                            val rotationMatrix = mat4Trs(
                                doubleArrayOf(0.0, 0.0, 0.0), body.rotation,
                                doubleArrayOf(1.0, 1.0, 1.0),
                            )
                            val axes = arrayOf(
                                doubleArrayOf(rotationMatrix[0], rotationMatrix[1], rotationMatrix[2]),
                                doubleArrayOf(rotationMatrix[4], rotationMatrix[5], rotationMatrix[6]),
                                doubleArrayOf(rotationMatrix[8], rotationMatrix[9], rotationMatrix[10]),
                            )
                            corners.forEachIndexed { cornerIndex, raw ->
                                val corner = nums(raw)
                                val delta = DoubleArray(3) { corner[it] - body.position[it] }
                                for (axis in 0 until 3) {
                                    val projection = abs(delta[0] * axes[axis][0] +
                                        delta[1] * axes[axis][1] + delta[2] * axes[axis][2])
                                    assertTrue(projection <= body.half[axis] + tolerance,
                                        "corner $cornerIndex axis $axis: $projection > ${body.half[axis]}")
                                }
                            }
                        }
                    }
                    "sim" -> {
                        val run = runPhysicsSim(c)
                        for (want in c["samples"] as? List<Map<String, Any?>> ?: emptyList()) {
                            val at = "@${want["tick"]} ${want["id"]}"
                            val got = run.samples["${(want["tick"] as Number).toInt()}:${want["id"]}"]
                            assertNotNull(got, "sample $at recorded")
                            assertClose(got!!.position, nums(want["position"]), "$at position")
                            assertClose(got.velocity, nums(want["velocity"]), "$at velocity")
                            (want["rotation"] as? List<Any?>)?.let {
                                assertClose(got.rotation, nums(it), "$at rotation")
                            }
                            (want["angularVelocity"] as? List<Any?>)?.let {
                                assertClose(got.angularVelocity, nums(it), "$at angularVelocity")
                            }
                            (want["angularMomentum"] as? List<Any?>)?.let {
                                assertClose(got.angularMomentum, nums(it), "$at angularMomentum")
                            }
                            assertEquals(want["grounded"], got.grounded, "$at grounded")
                            assertEquals(want["sleeping"], got.sleeping, "$at sleeping")
                        }
                        (c["events"] as? List<Map<String, Any?>>)?.let { wantEvents ->
                            assertEquals(
                                wantEvents.map { "${(it["tick"] as Number).toInt()} ${it["name"]} ${it["id"]} ${it["other"]}" },
                                run.events, "the exact event sequence",
                            )
                        }
                        if (c["replay"] == true) {
                            // THE DETERMINISM LAW: a second identical run ends BIT-identical
                            val again = runPhysicsSim(c)
                            for (body in run.world.bodies) {
                                val twin = again.world.byId[body.id]!!
                                assertTrue(twin.position.contentEquals(body.position),
                                    "${body.id} replay position bit-identical")
                                assertTrue(twin.velocity.contentEquals(body.velocity),
                                    "${body.id} replay velocity bit-identical")
                                assertTrue(twin.rotation.contentEquals(body.rotation),
                                    "${body.id} replay rotation bit-identical")
                                assertTrue(twin.angularVelocity.contentEquals(body.angularVelocity),
                                    "${body.id} replay angular velocity bit-identical")
                            }
                        }
                        if (c["mode2d"] == true) {
                            for (body in run.world.bodies) {
                                assertEquals(body.zLock, body.position[2], "${body.id}: z stayed exactly at its lock")
                                assertEquals(body.zLock, body.previous[2], "${body.id}: interpolation anchor stayed")
                                assertEquals(body.vzLock, body.velocity[2], "${body.id}: vz stayed exactly at its lock")
                            }
                        }
                    }
                    "contact" -> {
                        val world = createScenePhysicsWorld(
                            doubleArrayOf(0.0, 0.0, 0.0),
                            (c["bodies"] as List<Map<String, Any?>>).map { physicsBodySpec(it) },
                        )
                        val got = scenePhysicsContact(world.bodies[0], world.bodies[1])
                        assertNotNull(got, "contact exists")
                        val want = c["expect"] as Map<String, Any?>
                        assertTrue(abs(got!!.depth - num(want["depth"])) <= tolerance,
                            "depth ${got.depth} !~ ${want["depth"]}")
                        assertClose(got.normal, nums(want["normal"]), "normal")
                        assertEquals((want["pointCount"] as Number).toInt(), got.points.size, "pointCount")
                        val centroid = doubleArrayOf(0.0, 0.0, 0.0)
                        for (point in got.points) for (k in 0 until 3) centroid[k] += point[k] / got.points.size
                        assertClose(centroid, nums(want["centroid"]), "centroid")
                        if (want["symmetric"] == true) {
                            val reverse = scenePhysicsContact(world.bodies[1], world.bodies[0])
                            assertNotNull(reverse, "reverse contact exists")
                            assertEquals(got.points.size, reverse!!.points.size, "reverse pointCount")
                            assertClose(reverse.normal, DoubleArray(3) { -got.normal[it] }, "reverse normal")
                            val reverseCentroid = doubleArrayOf(0.0, 0.0, 0.0)
                            for (point in reverse.points) for (k in 0 until 3) {
                                reverseCentroid[k] += point[k] / reverse.points.size
                            }
                            assertClose(reverseCentroid, centroid, "reverse centroid")
                        }
                    }
                    "accumulator" -> {
                        val got = scenePhysicsSchedule((c["frames"] as List<Any?>).map { num(it) })
                        val want = c["expect"] as List<Map<String, Any?>>
                        assertEquals(want.size, got.size, "frame count")
                        want.forEachIndexed { i, w ->
                            assertEquals((w["steps"] as Number).toInt(), got[i].steps, "[$i].steps")
                            assertTrue(abs(got[i].alpha - num(w["alpha"])) <= tolerance,
                                "[$i].alpha: ${got[i].alpha} !~ ${w["alpha"]}")
                        }
                    }
                    "parentframe" -> {
                        // THE PARENT-FRAME LAW: this runner composes the parent with its
                        // OWN mat4Trs — the root⇄local pair every nested body rides
                        val spec = c["parent"] as Map<String, Any?>?
                        val parentWorld = spec?.let {
                            mat4Trs(nums(it["position"]), nums(it["rotation"]), nums(it["scale"]))
                        }
                        val root = nums(c["root"])
                        val local = nums(c["local"])
                        assertClose(scenePhysicsToLocal(root, parentWorld), local, "toLocal")
                        if (c["noRoundTrip"] != true) {
                            assertClose(scenePhysicsToRoot(local, parentWorld), root, "toRoot")
                        }
                    }
                    "orientationframe" -> {
                        val spec = c["parent"] as Map<String, Any?>?
                        val parentWorld = spec?.let {
                            mat4Trs(nums(it["position"]), nums(it["rotation"]), nums(it["scale"]))
                        }
                        val local = nums(c["localRotation"])
                        val root = nums(c["rootRotation"])
                        assertClose(scenePhysicsRotationToRoot(local, parentWorld, root), root, "rotationToRoot")
                        if (c["noRoundTrip"] != true) {
                            val expectedLocal = (c["localRoundTrip"] as? List<Any?>)?.let { nums(it) } ?: local
                            assertClose(
                                scenePhysicsRotationToLocal(root, parentWorld, expectedLocal),
                                expectedLocal, "rotationToLocal",
                            )
                        }
                    }
                    else -> { // interpolate
                        assertClose(
                            scenePhysicsInterpolate(nums(c["prev"]), nums(c["curr"]), num(c["alpha"])),
                            nums(c["expect"]), "interpolated",
                        )
                    }
                }
            })
        }
        return out
    }

    // ── skin.json — the G3 skeletal corpus (dsx-game.md §2 G3) ───────────────────────

    @Suppress("UNCHECKED_CAST")
    private fun skinNodes(raw: List<Map<String, Any?>>): List<GlbNode> = raw.map { n ->
        GlbNode(
            translation = (n["translation"] as? List<Any?>)?.let { nums(it) } ?: doubleArrayOf(0.0, 0.0, 0.0),
            rotation = (n["rotation"] as? List<Any?>)?.let { nums(it) } ?: doubleArrayOf(0.0, 0.0, 0.0, 1.0),
            scale = (n["scale"] as? List<Any?>)?.let { nums(it) } ?: doubleArrayOf(1.0, 1.0, 1.0),
            matrix = null,
            children = (n["children"] as? List<Any?>)?.map { (it as Number).toInt() }?.toIntArray() ?: IntArray(0),
            mesh = (n["mesh"] as? Number)?.toInt(),
            skin = (n["skin"] as? Number)?.toInt(),
        )
    }

    @Suppress("UNCHECKED_CAST")
    private fun skinPose(raw: Map<String, Any?>?): GlbPose {
        val pose = GlbPose()
        for ((index, entry) in raw ?: emptyMap()) {
            val e = entry as Map<String, Any?>
            pose[index.toInt()] = GlbTrsOverride(
                t = (e["t"] as? List<Any?>)?.let { nums(it) },
                r = (e["r"] as? List<Any?>)?.let { nums(it) },
                s = (e["s"] as? List<Any?>)?.let { nums(it) },
            )
        }
        return pose
    }

    @Suppress("UNCHECKED_CAST")
    private fun skinInlineModel(c: Map<String, Any?>): GlbModel {
        val source = c["model"] as Map<String, Any?>
        val clips = (source["clips"] as List<Map<String, Any?>>).map { clip ->
            GlbClip(
                name = clip["name"] as String,
                duration = num(clip["duration"]),
                channels = (clip["channels"] as List<Map<String, Any?>>).map { ch ->
                    GlbChannel(
                        node = (ch["node"] as Number).toInt(),
                        path = ch["path"] as String,
                        interpolation = ch["interpolation"] as String,
                        times = nums(ch["times"]),
                        values = nums(ch["values"]),
                    )
                },
            )
        }
        return GlbModel(emptyList(), emptyList(), skinNodes(source["nodes"] as List<Map<String, Any?>>),
            emptyList(), clips)
    }

    /** re-assert the CURRENT name between events — a per-frame update with an unchanged
     *  name must be a no-op (the surfaces call update every frame) */
    @Suppress("UNCHECKED_CAST")
    private fun mixerCurrentName(c: Map<String, Any?>, model: GlbModel, ms: Double): String {
        var name = ""
        for (event in c["events"] as List<Map<String, Any?>>) {
            if (num(event["ms"]) > ms) break
            val set = event["set"] as String
            // an unknown-name event keeps the previous name (the mixer law) — mirror it
            if (set.isEmpty() || model.clips.any { it.name == set }) name = set
        }
        return name
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun skinCorpus(): List<DynamicTest> {
        val doc = json(File(corpusDir(), "skin.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("skin.json: not a JSON object")
        val constants = doc["constants"] as? Map<String, Any?> ?: error("skin.json: no constants{}")
        val fixtures = doc["fixtures"] as? Map<String, Any?> ?: error("skin.json: no fixtures{}")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("skin.json: no cases[]")
        assertTrue(cases.size >= 16, "skin.json: corpus is suspiciously small (${cases.size})")
        val out = ArrayList<DynamicTest>()

        out.add(DynamicTest.dynamicTest("scene-skin/constants — the pinned constants match the kernel") {
            assertEquals(num(constants["slerpNlerpThreshold"]), SCENE_SLERP_NLERP_THRESHOLD, "slerpNlerpThreshold")
            assertEquals(num(constants["weightEpsilon"]), SCENE_SKIN_WEIGHT_EPSILON, "weightEpsilon")
            assertEquals(num(constants["defaultBlendMs"]), SCENE_CLIP_DEFAULT_BLEND_MS, "defaultBlendMs")
            assertEquals(constants["defaultLoop"], SCENE_CLIP_DEFAULT_LOOP, "defaultLoop")
        })

        for (c in cases) {
            val name = "scene-skin/${c["name"]}"
            out.add(DynamicTest.dynamicTest(name) {
                val diagnostics = ArrayList<SceneDiagnostic>()
                val diag: SceneDiag = { diagnostics.add(it) }
                when (c["kind"] as String) {
                    "parse" -> {
                        val b64 = fixtures[c["fixture"]] as? String
                        assertNotNull(b64, "$name: fixture '${c["fixture"]}' exists")
                        val result = parseGlb(java.util.Base64.getDecoder().decode(b64))
                        val model = result.model
                        assertNotNull(model, "$name: parses (${result.error?.code})")
                        val want = c["expect"] as Map<String, Any?>
                        assertEquals((want["nodeCount"] as Number).toInt(), model.nodes.size, "nodeCount")
                        assertEquals((want["meshCount"] as Number).toInt(), model.meshes.size, "meshCount")
                        assertEquals((want["drawCount"] as Number).toInt(), model.draws.size, "drawCount")
                        for (drawWant in want["draws"] as List<Map<String, Any?>>) {
                            val draw = model.draws[(drawWant["index"] as Number).toInt()]
                            assertEquals((drawWant["mesh"] as Number).toInt(), draw.mesh, "draw.mesh")
                            assertEquals((drawWant["node"] as Number).toInt(), draw.node, "draw.node")
                            assertEquals((drawWant["skin"] as? Number)?.toInt(), draw.skin, "draw.skin")
                        }
                        val wantSkins = want["skins"] as List<Map<String, Any?>>
                        assertEquals(wantSkins.size, model.skins.size, "skinCount")
                        wantSkins.forEachIndexed { i, skinWant ->
                            assertEquals((skinWant["joints"] as List<Any?>).map { (it as Number).toInt() },
                                model.skins[i].joints.toList(), "skins[$i].joints")
                            val ibms = skinWant["ibms"] as List<Any?>
                            assertEquals(ibms.size, model.skins[i].inverseBindMatrices.size, "skins[$i].ibm count")
                            ibms.forEachIndexed { j, ibm ->
                                assertClose(model.skins[i].inverseBindMatrices[j], nums(ibm), "skins[$i].ibms[$j]")
                            }
                        }
                        for (p in want["primitives"] as List<Map<String, Any?>>) {
                            val primitive = model.meshes[(p["mesh"] as Number).toInt()]
                                .primitives[(p["primitive"] as Number).toInt()]
                            assertEquals((p["joints"] as List<Any?>).map { (it as Number).toInt() },
                                primitive.joints.toList(), "primitive.joints")
                            assertClose(primitive.weights, nums(p["weights"]), "primitive.weights")
                        }
                        val wantClips = want["clips"] as List<Map<String, Any?>>
                        assertEquals(wantClips.size, model.clips.size, "clipCount")
                        wantClips.forEachIndexed { i, clipWant ->
                            val clip = model.clips[i]
                            assertEquals(clipWant["name"], clip.name, "clips[$i].name")
                            assertTrue(abs(clip.duration - num(clipWant["duration"])) <= tolerance,
                                "clips[$i].duration: ${clip.duration} !~ ${clipWant["duration"]}")
                            val wantChannels = clipWant["channels"] as List<Map<String, Any?>>
                            assertEquals(wantChannels.size, clip.channels.size, "clips[$i].channel count")
                            wantChannels.forEachIndexed { j, chWant ->
                                val channel = clip.channels[j]
                                assertEquals((chWant["node"] as Number).toInt(), channel.node, "clips[$i][$j].node")
                                assertEquals(chWant["path"], channel.path, "clips[$i][$j].path")
                                assertEquals(chWant["interpolation"], channel.interpolation, "clips[$i][$j].interpolation")
                                assertEquals((chWant["keys"] as Number).toInt(), channel.times.size, "clips[$i][$j].keys")
                            }
                        }
                    }
                    "jointMatrices" -> {
                        val skin = c["skin"] as Map<String, Any?>
                        val joints = (skin["joints"] as List<Any?>).map { (it as Number).toInt() }
                        val model = GlbModel(
                            emptyList(), emptyList(), skinNodes(c["nodes"] as List<Map<String, Any?>>),
                            listOf(GlbSkin(joints.toIntArray(), (skin["ibms"] as List<Any?>).map { nums(it) })),
                            emptyList(),
                        )
                        val worlds = glbNodeWorlds(model, skinPose(c["pose"] as? Map<String, Any?>))
                        val want = c["expect"] as Map<String, Any?>
                        (want["worlds"] as List<Any?>).forEachIndexed { i, w ->
                            assertClose(worlds[joints[i]], nums(w), "worlds[joint $i]")
                        }
                        val matrices = glbJointMatrices(model, 0, (c["meshNode"] as Number).toInt(), worlds)
                        val wantMatrices = want["jointMatrices"] as List<Any?>
                        assertEquals(wantMatrices.size, matrices.size, "joint matrix count")
                        wantMatrices.forEachIndexed { i, m -> assertClose(matrices[i], nums(m), "jointMatrices[$i]") }
                    }
                    "skinVertex" -> {
                        val matrices = (c["matrices"] as List<Any?>).map { nums(it) }
                        for (v in c["vertices"] as List<Map<String, Any?>>) {
                            val got = skinPosition(
                                nums(v["position"]),
                                (v["joints"] as List<Any?>).map { (it as Number).toInt() }.toIntArray(),
                                nums(v["weights"]), matrices,
                            )
                            assertClose(got, nums(v["expect"]), "skin(${(v["position"] as List<Any?>).joinToString(",")})")
                        }
                    }
                    "sample" -> {
                        val ch = c["channel"] as Map<String, Any?>
                        val channel = GlbChannel(0, ch["path"] as String, ch["interpolation"] as String,
                            nums(ch["times"]), nums(ch["values"]))
                        val duration = num(c["duration"])
                        for (s in c["samples"] as List<Map<String, Any?>>) {
                            val wrapped = glbClipTime(num(s["time"]), duration, s["loop"] == true)
                            assertClose(sampleGlbChannel(channel, wrapped), nums(s["expect"]), "sample@${s["time"]}")
                        }
                    }
                    "crossfade" -> {
                        fun trs(raw: Map<String, Any?>) = GlbTrs(nums(raw["t"]), nums(raw["r"]), nums(raw["s"]))
                        val from = trs(c["from"] as Map<String, Any?>)
                        val to = trs(c["to"] as Map<String, Any?>)
                        for (s in c["samples"] as List<Map<String, Any?>>) {
                            val got = blendGlbTrs(from, to, num(s["progress"]))
                            assertClose(got.t, nums(s["t"]), "t@${s["progress"]}")
                            assertClose(got.r, nums(s["r"]), "r@${s["progress"]}")
                            assertClose(got.s, nums(s["s"]), "s@${s["progress"]}")
                        }
                    }
                    "progress" -> {
                        for (s in c["samples"] as List<Map<String, Any?>>) {
                            val got = sceneCrossfadeProgress(num(s["elapsedMs"]), num(s["blendMs"]))
                            assertTrue(abs(got - num(s["progress"])) <= tolerance,
                                "progress(${s["elapsedMs"]}, ${s["blendMs"]}): $got !~ ${s["progress"]}")
                        }
                    }
                    "mixer" -> {
                        val model = skinInlineModel(c)
                        val mixer = SceneClipMixer(model, diag)
                        val loop = c["loop"] == true
                        val blendMs = num(c["blendMs"])
                        val events = c["events"] as List<Map<String, Any?>>
                        var next = 0
                        for (s in c["samples"] as List<Map<String, Any?>>) {
                            val ms = num(s["ms"])
                            while (next < events.size && num(events[next]["ms"]) <= ms) {
                                mixer.update(events[next]["set"] as String, loop, blendMs, num(events[next]["ms"]))
                                next += 1
                            }
                            mixer.update(mixerCurrentName(c, model, ms), loop, blendMs, ms)
                            val pose = mixer.pose(ms)
                            val nodeIndex = (s["node"] as Number).toInt()
                            val trs = glbEffectiveTrs(model.nodes[nodeIndex], pose[nodeIndex])
                            (s["t"] as? List<Any?>)?.let { assertClose(trs.t, nums(it), "t@$ms") }
                            (s["r"] as? List<Any?>)?.let { assertClose(trs.r, nums(it), "r@$ms") }
                            (s["active"] as? Boolean)?.let { assertEquals(it, mixer.active(ms), "active@$ms") }
                        }
                        assertEquals((c["diagnostics"] as? Number)?.toInt() ?: 0, diagnostics.size,
                            "$name: diagnostics ${diagnostics.map { it.message }}")
                    }
                    else -> { // props: markup through StackXML (never a second parser)
                        val markup = StackXML.parse(c["markup"] as String)
                        assertNotNull(markup, "$name: markup parses through StackXML")
                        val ir = parseScene(markup!!, diag)
                        val modelNode = ir.nodes.first { it.kind == SceneNodeKind.MODEL }
                        val props = resolvedProps(modelNode, mapResolver(c["vars"] as? Map<String, Any?>), diag)
                        val want = c["expect"] as Map<String, Any?>
                        assertEquals(want["animation"], props.animation, "animation")
                        assertEquals(want["loop"], props.clipLoop, "loop")
                        assertTrue(abs(props.blendMs - num(want["blendMs"])) <= tolerance,
                            "blendMs: ${props.blendMs} !~ ${want["blendMs"]}")
                        assertEquals((c["diagnostics"] as? Number)?.toInt() ?: 0, diagnostics.size,
                            "$name: diagnostics ${diagnostics.map { it.message }}")
                    }
                }
            })
        }
        return out
    }

    // ── prefab.json — components as prefabs inside <scene> subtrees (dsx-game.md G1) ─

    /** the case's component table as a prefab lookup: templates parse through
     *  StackXML.parse (never a second parser); explicit `params` override the
     *  template-derived declaration (the web ComponentIR shape); a per-component
     *  `components` sub-table becomes the def's OWN lookup (the defining-scope law). */
    @Suppress("UNCHECKED_CAST")
    private fun prefabLookupOver(table: Map<String, Any?>): ScenePrefabLookup {
        val defs = HashMap<String, ScenePrefabDef?>()
        fun lookup(tag: String): ScenePrefabDef? = defs.getOrPut(tag) {
            val entry = table[tag] as? Map<String, Any?> ?: return@getOrPut null
            val template = StackXML.parse(entry["template"] as String)
                ?: error("prefab template for '$tag' does not parse")
            val derived = scenePrefabDefFromTemplate(template)
            val params = (entry["params"] as? List<Map<String, Any?>>)?.map {
                ScenePrefabParam(it["name"] as String, it["default"] as? String)
            }
            val nested = (entry["components"] as? Map<String, Any?>)?.let { prefabLookupOver(it) }
            ScenePrefabDef(params ?: derived.params, derived.roots, nested)
        }
        return ::lookup
    }

    @Suppress("UNCHECKED_CAST")
    private fun prefabLookupFor(c: Map<String, Any?>): ScenePrefabLookup =
        prefabLookupOver(c["components"] as Map<String, Any?>)

    private fun prefabNodeAtPath(nodes: List<SceneNode>, path: List<Int>): SceneNode {
        var list = nodes
        var node: SceneNode? = null
        for (index in path) {
            node = list.getOrNull(index) ?: error("path $path does not resolve")
            list = node.children
        }
        return node ?: error("path is empty")
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun prefabCorpus(): List<DynamicTest> =
        loadCases("prefab.json", 10).map { c ->
            val name = "scene-prefab/${c["name"]}"
            DynamicTest.dynamicTest(name) {
                val diagnostics = ArrayList<SceneDiagnostic>()
                val diag: SceneDiag = { diagnostics.add(it) }
                val lookup = prefabLookupFor(c)
                val markup = StackXML.parse(c["markup"] as String)
                assertNotNull(markup, "$name: markup parses through StackXML")
                val ir = parseScene(markup, diag, lookup)
                val vars = c["vars"] as? Map<String, Any?>
                val outer: (String) -> Any? = { expr -> (vars ?: emptyMap())[expr] }

                val rows = c["rows"] as? Map<String, Any?>
                if (rows != null) {
                    // the keyed-spawn leg: rows of prefab instances at the IR plane
                    val group = ir.nodes.first {
                        it.kind == SceneNodeKind.GROUP && it.attrs.containsKey("bind")
                    }
                    val template = group.children
                    assertTrue(template.isNotEmpty() && template[0].prefab != null,
                        "the template child is a prefab expansion root")
                    val keyField = group.attrs["key"] ?: "id"
                    val expect = rows["expect"] as Map<String, Any?>
                    val firstRows = sceneBindRows(rows["first"], keyField, diag)
                    assertEquals(expect["firstKeys"] as List<String>, firstRows.map { it.key }, "first keys")
                    val instances = firstRows.map { row ->
                        val nodes = instantiateSceneRow(template)
                        // fresh identity per spawn, the prefab stamp preserved
                        assertTrue(nodes[0] !== template[0], "fresh node identity")
                        assertNotNull(nodes[0].prefab, "prefab stamp survives instantiation")
                        val rowEval: (String) -> Any? = { expr ->
                            if (expr.startsWith("item.")) (row.item as Map<String, Any?>)[expr.substring(5)]
                            else outer(expr)
                        }
                        nodes to scenePrefabResolver(nodes, rowEval)
                    }
                    if (instances.size > 1) {
                        assertTrue(instances[0].first[0] !== instances[1].first[0], "instances are distinct")
                    }
                    (expect["radius"] as List<Any?>).forEachIndexed { i, wantRaw ->
                        val (nodes, resolver) = instances[i]
                        val sphere = nodes[0].children[0]
                        val props = resolvedProps(sphere, resolver, diag)
                        assertTrue(abs(props.radius - num(wantRaw)) <= tolerance,
                            "row[$i].radius: ${props.radius} !~ $wantRaw")
                    }
                    val diff = diffSceneBindRows(
                        firstRows.map { it.key }, sceneBindRows(rows["next"], keyField, diag))
                    assertEquals(expect["nextRemoved"] as List<String>, diff.removed, "despawned keys")
                    assertEquals(expect["nextRetained"] as List<String>, diff.retained, "retained keys")
                    assertEquals((c["diagnostics"] as? Number)?.toInt() ?: 0, diagnostics.size,
                        "$name: diagnostics ${diagnostics.map { it.message }}")
                    return@dynamicTest
                }

                val resolver = scenePrefabResolver(ir.nodes, outer)
                (c["expect"] as? Map<String, Any?>)?.let { expect ->
                    (expect["nodes"] as? List<Map<String, Any?>>)?.let {
                        checkNodes(ir.nodes, it, "nodes", resolver, diag)
                    }
                }
                for (w in c["worlds"] as? List<Map<String, Any?>> ?: emptyList()) {
                    val worlds = worldMatrices(ir.nodes, resolver, diag)
                    val target = (w["node"] as? String)?.let { findSceneNode(ir.nodes, it) }
                        ?: prefabNodeAtPath(ir.nodes, (w["path"] as List<Any?>).map { (it as Number).toInt() })
                    assertNotNull(target, "world target exists")
                    val world = worlds[target]
                    assertNotNull(world, "world matrix computed")
                    assertClose(world, nums(w["world"]), "world")
                    (w["point"] as? Map<String, Any?>)?.let { point ->
                        val local = nums(point["local"])
                        val p = doubleArrayOf(
                            world[0] * local[0] + world[4] * local[1] + world[8] * local[2] + world[12],
                            world[1] * local[0] + world[5] * local[1] + world[9] * local[2] + world[13],
                            world[2] * local[0] + world[6] * local[1] + world[10] * local[2] + world[14],
                        )
                        assertClose(p, nums(point["world"]), "point")
                    }
                }
                assertEquals((c["diagnostics"] as? Number)?.toInt() ?: 0, diagnostics.size,
                    "$name: diagnostics ${diagnostics.map { it.message }}")
            }
        }

    @Suppress("UNCHECKED_CAST")
    private fun checkNodes(
        nodes: List<SceneNode>, expected: List<Map<String, Any?>>, path: String,
        resolver: SceneResolve, diag: SceneDiag,
    ) {
        assertEquals(expected.size, nodes.size, "$path: node count")
        expected.forEachIndexed { i, want ->
            val node = nodes[i]
            assertEquals(want["kind"] as String, node.kind.tag, "$path[$i].kind")
            (want["id"] as? String)?.let { assertEquals(it, node.id, "$path[$i].id") }
            (want["raw"] as? Map<String, Any?>)?.forEach { (attr, value) ->
                assertEquals(value as String, node.attrs[attr], "$path[$i].raw.$attr kept verbatim")
            }
            val props = resolvedProps(node, resolver, diag)
            (want["position"] as? List<Any?>)?.let { assertClose(props.position, nums(it), "$path[$i].position") }
            (want["rotation"] as? List<Any?>)?.let { assertClose(props.rotation, nums(it), "$path[$i].rotation") }
            (want["scale"] as? List<Any?>)?.let { assertClose(props.scale, nums(it), "$path[$i].scale") }
            (want["lookAt"] as? List<Any?>)?.let { assertClose(props.lookAt, nums(it), "$path[$i].lookAt") }
            want["size"]?.let { size ->
                // `size` is per-kind (the shared word): camera scalar / plane pair / box triple
                val wantSize = if (size is List<*>) nums(size) else doubleArrayOf(num(size))
                when (node.kind) {
                    SceneNodeKind.CAMERA -> assertClose(doubleArrayOf(props.size2d), wantSize, "$path[$i].size")
                    SceneNodeKind.PLANE -> assertClose(props.planeSize, wantSize, "$path[$i].size")
                    else -> assertClose(props.boxSize, wantSize, "$path[$i].size")
                }
            }
            val scalars = mapOf(
                "fov" to props.fov, "near" to props.near, "far" to props.far,
                "radius" to props.radius, "intensity" to props.intensity,
            )
            for ((key, actual) in scalars) {
                (want[key] as? Number)?.let { wantValue ->
                    assertTrue(abs(actual - wantValue.toDouble()) <= tolerance,
                        "$path[$i].$key: $actual !~ $wantValue")
                }
            }
            (want["lightKind"] as? String)?.let { assertEquals(it, props.lightKind, "$path[$i].lightKind") }
            (want["anchorKind"] as? String)?.let { assertEquals(it, props.anchorKind, "$path[$i].anchorKind") }
            (want["color"] as? String)?.let { assertEquals(it, props.color, "$path[$i].color") }
            (want["src"] as? String)?.let { assertEquals(it, props.src, "$path[$i].src") }
            (want["value"] as? String)?.let { assertEquals(it, props.value, "$path[$i].value") }
            (want["children"] as? List<Map<String, Any?>>)?.let {
                checkNodes(node.children, it, "$path[$i].children", resolver, diag)
            }
        }
    }

    // ── sprite.json — the 2D engine (dsx-game.md G6): quad · sheets · fps · the 2D
    // conventions · the z-lock solver ────────────────────────────────────────────────

    @Suppress("UNCHECKED_CAST")
    private fun spriteNode(attrs: Map<String, Any?>): SceneNode = SceneNode(
        SceneNodeKind.SPRITE, null,
        attrs.entries.associate { (k, v) -> k to (v as String) }, emptyList(), mode2d = true,
    )

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun spriteConstants(): List<DynamicTest> = listOf(
        DynamicTest.dynamicTest("scene-sprite/constants — the pinned constants match the kernel") {
            val doc = json(File(corpusDir(), "sprite.json").readText()).foundationValue as Map<String, Any?>
            val k = doc["constants"] as Map<String, Any?>
            assertEquals(SPRITE_DEFAULT_HEIGHT, num(k["defaultHeight"]), "defaultHeight")
            assertEquals(SCENE_SPRITE_COLLIDER_HALF_Z, num(k["colliderHalfZ"]), "colliderHalfZ")
            assertEquals(SPRITE_DEFAULT_ANCHOR, k["defaultAnchor"], "defaultAnchor")
            assertEquals(true, k["defaultLoop"], "defaultLoop")
            val anchors = k["anchors"] as Map<String, Any?>
            assertEquals(anchors.size, SPRITE_ANCHORS.size, "anchor word count")
            for ((word, want) in anchors) {
                val got = SPRITE_ANCHORS[word]
                assertNotNull(got, "anchor '$word' exists")
                assertClose(got!!, nums(want), "anchor $word")
            }
        },
    )

    @TestFactory
    @Suppress("UNCHECKED_CAST", "LongMethod", "CyclomaticComplexMethod")
    fun spriteCorpus(): List<DynamicTest> =
        loadCases("sprite.json", 30).map { c ->
            val name = c["name"] as String
            DynamicTest.dynamicTest("scene-sprite/$name") {
                val diagnostics = ArrayList<SceneDiagnostic>()
                val diag: SceneDiag = { diagnostics.add(it) }
                val vars = c["vars"] as? Map<String, Any?>
                val wantDiagnostics = { ->
                    assertEquals((c["diagnostics"] as? Number)?.toInt() ?: 0, diagnostics.size,
                        "$name: diagnostics ${diagnostics.map { it.message }}")
                }
                when (c["kind"]) {
                    "quad" -> {
                        val props = resolvedProps(spriteNode(c["attrs"] as Map<String, Any?>), mapResolver(vars), diag)
                        val aspect = (c["aspect"] as? Number)?.toDouble()
                        val quad = spriteQuad(props, aspect)
                        val want = c["expect"] as Map<String, Any?>
                        assertClose(quad.center, nums(want["offset"]), "quad center offset")
                        assertTrue(abs(quad.halfWidth - num(want["halfWidth"])) <= tolerance,
                            "halfWidth: ${quad.halfWidth} !~ ${want["halfWidth"]}")
                        assertTrue(abs(quad.halfHeight - num(want["halfHeight"])) <= tolerance,
                            "halfHeight: ${quad.halfHeight} !~ ${want["halfHeight"]}")
                        val size = spriteSizeOf(props, aspect)
                        assertClose(doubleArrayOf(size[0] / 2.0, size[1] / 2.0),
                            doubleArrayOf(num(want["halfWidth"]), num(want["halfHeight"])), "spriteSizeOf")
                        wantDiagnostics()
                    }
                    "uv" -> {
                        val props = resolvedProps(spriteNode(c["attrs"] as Map<String, Any?>), mapResolver(vars), diag)
                        assertClose(spriteUvRect(props, props.spriteFrame), nums(c["expect"]), "uv rect")
                        assertClose(spriteQuad(props).uv, nums(c["expect"]), "quad.uv")
                        wantDiagnostics()
                    }
                    "sheet" -> {
                        val props = resolvedProps(spriteNode(c["attrs"] as Map<String, Any?>), mapResolver(vars), diag)
                        val want = c["expect"] as Map<String, Any?>
                        assertEquals((want["cols"] as Number).toInt(), props.spriteFrames[0], "cols")
                        assertEquals((want["rows"] as Number).toInt(), props.spriteFrames[1], "rows")
                        assertEquals((want["total"] as Number).toInt(), spriteFrameCount(props), "total")
                        assertEquals((want["frame"] as Number).toInt(), props.spriteFrame, "frame")
                        wantDiagnostics()
                    }
                    "fps" -> {
                        val props = resolvedProps(spriteNode(c["attrs"] as Map<String, Any?>), mapResolver(vars), diag)
                        for (sample in c["samples"] as List<Map<String, Any?>>) {
                            assertEquals((sample["frame"] as Number).toInt(),
                                spriteFrameAt(props, num(sample["elapsed"])),
                                "frame @${sample["elapsed"]}s")
                        }
                        wantDiagnostics()
                    }
                    "order" -> {
                        assertEquals((c["expect"] as List<Any?>).map { (it as Number).toInt() },
                            sceneDrawOrder2d((c["z"] as List<Any?>).map { num(it) }), "draw order")
                    }
                    "parse" -> {
                        val markup = StackXML.parse(c["markup"] as String)
                        assertNotNull(markup, "$name: markup parses through StackXML")
                        val ir = parseScene(markup!!, diag)
                        val resolver = mapResolver(vars)
                        val want = c["expect"] as Map<String, Any?>
                        (want["mode"] as? String)?.let { assertEquals(it, ir.mode.word, "mode") }
                        (want["nodes"] as? List<Map<String, Any?>>)?.forEachIndexed { i, expected ->
                            val node = ir.nodes[i]
                            assertEquals(expected["kind"] as String, node.kind.tag, "nodes[$i].kind")
                            val props = resolvedProps(node, resolver, diag)
                            (expected["position"] as? List<Any?>)?.let { assertClose(props.position, nums(it), "nodes[$i].position") }
                            (expected["rotation"] as? List<Any?>)?.let { assertClose(props.rotation, nums(it), "nodes[$i].rotation") }
                            (expected["scale"] as? List<Any?>)?.let { assertClose(props.scale, nums(it), "nodes[$i].scale") }
                            (expected["spriteSize"] as? List<Any?>)?.let { assertClose(props.spriteSize, nums(it), "nodes[$i].spriteSize") }
                            (expected["frames"] as? List<Any?>)?.let {
                                assertClose(doubleArrayOf(props.spriteFrames[0].toDouble(), props.spriteFrames[1].toDouble()),
                                    nums(it), "nodes[$i].frames")
                            }
                            (expected["frame"] as? Number)?.let { assertEquals(it.toInt(), props.spriteFrame, "nodes[$i].frame") }
                            (expected["fps"] as? Number)?.let {
                                assertTrue(abs(props.spriteFps - it.toDouble()) <= tolerance, "nodes[$i].fps")
                            }
                            (expected["loop"] as? Boolean)?.let { assertEquals(it, props.spriteLoop, "nodes[$i].loop") }
                            (expected["anchor"] as? String)?.let { assertEquals(it, props.spriteAnchor, "nodes[$i].anchor") }
                            (expected["flip"] as? String)?.let { assertEquals(it, props.spriteFlip, "nodes[$i].flip") }
                            (expected["src"] as? String)?.let { assertEquals(it, props.src, "nodes[$i].src") }
                            (expected["color"] as? String)?.let { assertEquals(it, props.color, "nodes[$i].color") }
                        }
                        for (w in c["worlds"] as? List<Map<String, Any?>> ?: emptyList()) {
                            val worlds = worldMatrices(ir.nodes, resolver, diag)
                            val target = findSceneNode(ir.nodes, w["node"] as String)
                            assertNotNull(target, "world target exists")
                            val world = worlds[target]
                            assertNotNull(world, "world matrix computed")
                            assertClose(world!!, nums(w["world"]), "world")
                        }
                        wantDiagnostics()
                    }
                    "physics-world" -> {
                        val markup = StackXML.parse(c["markup"] as String)
                        assertNotNull(markup, "$name: markup parses through StackXML")
                        val ir = parseScene(markup!!, diag)
                        val extraction = extractScenePhysics(ir, mapResolver(vars), diag)
                        val want = c["expect"] as Map<String, Any?>
                        assertClose(extraction.gravity, nums(want["gravity"]), "gravity")
                        assertEquals(want["mode2d"], extraction.mode2d, "mode2d")
                        val world = createScenePhysicsWorld(extraction.gravity, extraction.bodies, extraction.mode2d)
                        assertEquals(want["mode2d"], world.mode2d, "world.mode2d")
                        val wantBodies = want["bodies"] as List<Map<String, Any?>>
                        assertEquals(wantBodies.size, world.bodies.size, "$name: body count")
                        wantBodies.forEachIndexed { i, w ->
                            val body = world.bodies[i]
                            assertEquals(w["id"], body.id, "[$i].id")
                            assertEquals(w["kind"], body.kind, "[$i].kind")
                            assertEquals(w["shape"], body.shape, "[$i].shape")
                            if (w["shape"] == "sphere") {
                                assertTrue(abs(body.radius - num(w["radius"])) <= tolerance,
                                    "[$i].radius: ${body.radius} !~ ${w["radius"]}")
                            } else {
                                assertClose(body.half, nums(w["half"]), "[$i].half")
                            }
                            assertClose(body.position, nums(w["position"]), "[$i].position")
                            assertClose(body.velocity, nums(w["velocity"]), "[$i].velocity")
                            assertTrue(abs(body.invMass - num(w["invMass"])) <= tolerance, "[$i].invMass")
                            assertEquals(num(w["bounce"]), body.bounce, "[$i].bounce")
                            assertEquals(num(w["friction"]), body.friction, "[$i].friction")
                            assertEquals(w["trigger"], body.trigger, "[$i].trigger")
                            assertEquals(w["layer"], body.layer, "[$i].layer")
                            assertEquals(w["collides"], body.collides, "[$i].collides")
                            assertEquals(num(w["speed"]), body.speed, "[$i].speed")
                            assertEquals(num(w["jump"]), body.jump, "[$i].jump")
                        }
                        wantDiagnostics()
                    }
                    else -> {
                        // physics-sim: the physics.json driver shape plus the mode2d flag
                        val gravity = (c["gravity"] as? List<Any?>)?.let { nums(it) }
                            ?: doubleArrayOf(0.0, -9.81, 0.0)
                        val mode2d = c["mode2d"] == true
                        val world = createScenePhysicsWorld(
                            gravity, (c["bodies"] as List<Map<String, Any?>>).map { physicsBodySpec(it) }, mode2d,
                        )
                        val samples = c["samples"] as? List<Map<String, Any?>> ?: emptyList()
                        val wanted = HashMap<Int, MutableList<String>>()
                        for (sample in samples) {
                            wanted.getOrPut((sample["tick"] as Number).toInt()) { ArrayList() }
                                .add(sample["id"] as String)
                        }
                        val recorded = HashMap<String, PhysicsSample>()
                        for (n in 0 until (c["ticks"] as Number).toInt()) {
                            for (w in c["writes"] as? List<Map<String, Any?>> ?: emptyList()) {
                                if ((w["tick"] as Number).toInt() != n) continue
                                if (w["attr"] == "velocity") {
                                    scenePhysicsWriteVelocity(world, w["id"] as String, nums(w["value"]))
                                } else {
                                    scenePhysicsTeleport(world, w["id"] as String, nums(w["value"]))
                                }
                            }
                            stepScenePhysicsWorld(world, emptyMap())
                            for (id in wanted[n] ?: emptyList<String>()) {
                                val body = world.byId[id] ?: error("sample body '$id' exists")
                                recorded["$n:$id"] = PhysicsSample(
                                    body.position.copyOf(), body.velocity.copyOf(), body.rotation.copyOf(),
                                    body.angularVelocity.copyOf(), physicsBodyAngularMomentum(body),
                                    body.grounded, body.sleeping,
                                )
                            }
                        }
                        for (want in samples) {
                            val at = "@${want["tick"]} ${want["id"]}"
                            val got = recorded["${(want["tick"] as Number).toInt()}:${want["id"]}"]
                            assertNotNull(got, "sample $at recorded")
                            assertClose(got!!.position, nums(want["position"]), "$at position")
                            assertClose(got.velocity, nums(want["velocity"]), "$at velocity")
                            assertEquals(want["grounded"], got.grounded, "$at grounded")
                            assertEquals(want["sleeping"], got.sleeping, "$at sleeping")
                        }
                        // THE Z-LOCK LAW as an invariant, not only as pinned samples
                        if (mode2d) {
                            for (body in world.bodies) {
                                assertEquals(body.zLock, body.position[2], "${body.id}: z stayed exactly at its lock")
                                assertEquals(body.zLock, body.previous[2], "${body.id}: the interpolation anchor stayed")
                                assertEquals(body.vzLock, body.velocity[2], "${body.id}: vz stayed exactly at its lock")
                            }
                        }
                    }
                }
            }
        }
}
