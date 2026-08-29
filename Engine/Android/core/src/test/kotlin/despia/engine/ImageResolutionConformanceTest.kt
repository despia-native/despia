package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The <image> resolution conformance runner - executes
 * OpenSource/Conformance/image/resolution.json through THIS runtime's ImageCore
 * (parity/U05-image.md). The TS twin (@despia/kernel image-core.ts, image-core.test.ts) and
 * the Swift reference (Engine/iOS/ImageCore.swift) run the SAME file, so `contentFit="cover"`
 * cannot crop one way on one renderer and another way on the next, a memory-cache hit cannot
 * fade on one platform and appear instantly on another, and a blurhash placeholder cannot
 * decode to different pixels.
 *
 * Missing corpus = loud failure: a silently-skipped conformance suite is how drift starts.
 */
class ImageResolutionConformanceTest {

    private val epsilon = 1e-6

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/image/resolution.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/image/resolution.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(): Map<String, Any?> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("resolution.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "resolution.json version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun rows(section: String): List<Map<String, Any?>> {
        val list = root()[section] as? List<Map<String, Any?>> ?: error("resolution.json: no $section[]")
        assertTrue(list.isNotEmpty(), "$section corpus must not be empty")
        return list
    }

    private fun num(value: Any?): Double = (value as Number).toDouble()

    @Suppress("UNCHECKED_CAST")
    private fun size(value: Any?): ImageCore.Size {
        val map = value as Map<String, Any?>
        return ImageCore.Size(num(map["width"]), num(map["height"]))
    }

    private fun near(actual: Double, expected: Double, label: String) {
        assertTrue(Math.abs(actual - expected) < epsilon, "$label: expected $expected, got $actual")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun vocabulariesAgreeWithCorpus() {
        val doc = root()
        assertEquals((doc["contentFits"] as List<Any?>).map { it as String }, ImageCore.CONTENT_FITS)
        assertEquals((doc["cachePolicies"] as List<Any?>).map { it as String }, ImageCore.CACHE_POLICIES)
        assertEquals((doc["transitionEffects"] as List<Any?>).map { it as String }, ImageCore.TRANSITION_EFFECTS)
        assertEquals((doc["priorities"] as List<Any?>).map { it as String }, ImageCore.PRIORITIES)
        val anchors = doc["positionAnchors"] as Map<String, Any?>
        assertEquals(anchors.keys.sorted(), ImageCore.POSITION_ANCHORS.keys.sorted())
        for ((name, raw) in anchors) {
            val point = raw as Map<String, Any?>
            val got = ImageCore.resolveContentPosition(name)
            near(got.x, num(point["x"]), "anchor $name x")
            near(got.y, num(point["y"]), "anchor $name y")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun defaultsAgreeWithCorpus() {
        val defaults = root()["defaults"] as Map<String, Any?>
        assertEquals(defaults["cachePolicy"], ImageCore.resolveCachePolicy(null, null).policy)
        assertEquals(defaults["priority"], ImageCore.resolveImagePriority(null))
        val transition = defaults["transition"] as Map<String, Any?>
        val resolved = ImageCore.resolveTransition(null)
        assertEquals((transition["duration"] as Number).toInt(), resolved.duration)
        assertEquals(transition["effect"], resolved.effect)
        assertEquals(true, defaults["allowDownscaling"])
        assertEquals(ImageCore.CONTENT_FIT_DEFAULT, defaults["contentFit"])
        assertEquals(ImageCore.CONTENT_POSITION_DEFAULT, defaults["contentPosition"])
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun geometrySolverAgreesWithCorpus() {
        for (case in rows("geometry")) {
            val name = case["name"] as String
            val got = ImageCore.solveImageRect(
                case["fit"] as? String, case["position"] as? String,
                size(case["source"]), size(case["container"]),
            )
            val expect = case["expect"] as Map<String, Any?>
            near(got.x, num(expect["x"]), "$name: x")
            near(got.y, num(expect["y"]), "$name: y")
            near(got.width, num(expect["width"]), "$name: width")
            near(got.height, num(expect["height"]), "$name: height")
            near(got.scale, num(expect["scale"]), "$name: scale")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun cachePolicyLadderAgreesWithCorpus() {
        for (case in rows("cache")) {
            val name = case["name"] as String
            val got = ImageCore.resolveCachePolicy(case["cachePolicy"] as? String, case["cache"] as? String)
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["policy"], got.policy, "$name: policy")
            assertEquals(expect["memory"], got.memory, "$name: memory")
            assertEquals(expect["disk"], got.disk, "$name: disk")
            assertEquals(expect["revalidate"], got.revalidate, "$name: revalidate")
        }
        // The legacy binary attribute still routes - the whole point of the fold.
        assertEquals("none", ImageCore.resolveCachePolicy(null, "none").policy)
        assertEquals("memoryDisk", ImageCore.resolveCachePolicy(null, "default").policy)
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun transitionFoldAndGateAgreeWithCorpus() {
        for (case in rows("transition")) {
            val name = case["name"] as String
            val got = ImageCore.resolveTransition(case["transition"])
            val expect = case["expect"] as Map<String, Any?>
            assertEquals((expect["duration"] as Number).toInt(), got.duration, "$name: duration")
            assertEquals(expect["effect"], got.effect, "$name: effect")
            val gate = case["gate"] as Map<String, Any?>
            for (kind in listOf("memory", "disk", "none")) {
                assertEquals(gate[kind], ImageCore.shouldTransition(got, kind), "$name: gate/$kind")
            }
        }
    }

    @Test
    fun aMemoryCacheHitNeverFades() {
        val resolved = ImageCore.resolveTransition(300)
        assertEquals(false, ImageCore.shouldTransition(resolved, "memory"))
        assertEquals(true, ImageCore.shouldTransition(resolved, "disk"))
        assertEquals(true, ImageCore.shouldTransition(resolved, "none"))
        val policy = ImageCore.resolveCachePolicy("memoryDisk", null)
        assertEquals("memory", ImageCore.cacheTypeFor(policy, inMemory = true, onDisk = true))
        assertEquals("disk", ImageCore.cacheTypeFor(policy, inMemory = false, onDisk = true))
        assertEquals("none", ImageCore.cacheTypeFor(policy, inMemory = false, onDisk = false))
        assertEquals("none", ImageCore.cacheTypeFor(
            ImageCore.resolveCachePolicy("none", null), inMemory = true, onDisk = true))
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun decodeAtDisplaySizeAgreesWithCorpus() {
        for (case in rows("downscale")) {
            val name = case["name"] as String
            val got = ImageCore.resolveDecodeSize(
                case["fit"] as? String, size(case["source"]), size(case["display"]),
                num(case["scale"]), case["allowDownscaling"] as Boolean,
            )
            val expect = case["expect"] as Map<String, Any?>
            assertEquals((expect["width"] as Number).toInt(), got.width, "$name: width")
            assertEquals((expect["height"] as Number).toInt(), got.height, "$name: height")
            assertEquals(expect["downscaled"], got.downscaled, "$name: downscaled")
        }
    }

    @Test
    fun aFourThousandPixelSourceInAnAvatarDecodesAtNinetySix() {
        val got = ImageCore.resolveDecodeSize(
            "cover", ImageCore.Size(4000.0, 4000.0), ImageCore.Size(48.0, 48.0), 2.0, true)
        assertEquals(96, got.width)
        assertEquals(96, got.height)
        assertTrue(got.downscaled)
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun placeholderClassificationAgreesWithCorpus() {
        for (case in rows("placeholder")) {
            val name = case["name"] as String
            val got = ImageCore.classifyPlaceholder(case["placeholder"] as? String)
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["kind"], got.kind, "$name: kind")
            assertEquals(expect["value"], got.value, "$name: value")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun recyclingIdentityAgreesWithCorpus() {
        for (case in rows("recycling")) {
            val name = case["name"] as String
            val got = ImageCore.resolveRecycling(
                case["recyclingKey"] as? String, case["rowKey"] as? String,
                case["src"] as? String, case["asset"] as? String, case["previousKey"] as? String,
            )
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["key"], got.key, "$name: key")
            assertEquals(expect["clear"], got.clear, "$name: clear")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun blurhashDecoderProducesThePinnedPixels() {
        for (case in rows("blurhash")) {
            val name = case["name"] as String
            val width = (case["width"] as Number).toInt()
            val height = (case["height"] as Number).toInt()
            val decoded = ImageCore.decodeBlurhash(case["hash"] as String, width, height)
            assertNotNull(decoded, "$name: decoded")
            assertEquals(width, decoded.width, "$name: width")
            assertEquals(height, decoded.height, "$name: height")
            val expected = (case["rgba"] as List<Any?>).map { (it as Number).toInt() }
            assertEquals(expected, decoded.rgba.toList(), "$name: pixels")
        }
        assertNull(ImageCore.decodeBlurhash("nope", 4, 4), "a malformed hash degrades, never throws")
        assertNull(ImageCore.decodeBlurhash("LEHV6nWB2yk8pyo0adR*.7kCMdnj", 0, 4))
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun thumbhashDecoderProducesThePinnedPixels() {
        for (case in rows("thumbhash")) {
            val name = case["name"] as String
            val hash = case["hash"] as String
            val expect = case["expect"] as Map<String, Any?>
            val decoded = ImageCore.decodeThumbhash(hash)
            assertNotNull(decoded, "$name: decoded")
            assertEquals((expect["width"] as Number).toInt(), decoded.width, "$name: width")
            assertEquals((expect["height"] as Number).toInt(), decoded.height, "$name: height")
            val expected = (expect["rgba"] as List<Any?>).map { (it as Number).toInt() }
            assertEquals(expected, decoded.rgba.toList(), "$name: pixels")
            // The transport prefix is accepted and stripped.
            assertEquals(expected, ImageCore.decodeThumbhash("thumbhash:$hash")!!.rgba.toList())
        }
        assertNull(ImageCore.decodeThumbhash("!!!!"), "a malformed hash degrades, never throws")
    }

    @Test
    fun mediaTypeMapsByExtensionAndPassesTypesThrough() {
        assertEquals("image/jpeg", ImageCore.imageMediaType("jpg"))
        assertEquals("image/png", ImageCore.imageMediaType(".PNG"))
        assertEquals("image/webp", ImageCore.imageMediaType("image/webp"))
        assertEquals("unknown", ImageCore.imageMediaType("xyz"))
        assertEquals("unknown", ImageCore.imageMediaType(null))
    }
}
