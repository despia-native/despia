package despia.engine.desktop

import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.platform.Font
import despia.engine.StackFonts
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * `fontFamily=` on the desktop lane - the twin of `StackStyle.StackFontBook` (:render) and of
 * Swift's `DSXFontBook`, and the reason all three of `fontFamily`, `fontVariation` and
 * `fontFeature` were catalogued and inert here: this lane had no font-book path AT ALL, so a
 * brand typeface declared by a module was simply absent on Windows and Linux while working on
 * the other three renderers. That is the Article 10 gap this closes, and it closed at the build
 * layer too - prepare_modules writes the registry and the face binaries to a fourth destination
 * now, because unlike the Android asset merge and the iOS synchronized group nothing else would
 * carry them onto this classpath.
 *
 * The SELECTION law - which face answers a requested weight, when italic synthesises, how a
 * variable axis clamps - is the shared pure core :core `StackFonts`, pinned by
 * OpenSource/Conformance/fonts/matching.json. Nothing here reimplements it; this file resolves
 * a name to faces and hands Compose the paths.
 *
 * DESKTOP SEAMS (pinned, none silent):
 *  - Faces load as CLASSPATH RESOURCES (`Font(resource = …)`), which is what the packaged jar
 *    actually carries; the Android twin loads from assets and iOS from the bundle, for the same
 *    reason in each case - the face travels with the module rather than under a mangled name.
 *  - The registry is the SAME JSON bytes the other two destinations get, read with the lane's
 *    own JSON library rather than a TSV twin. One file, four destinations; a second format
 *    would be a second thing to keep in step.
 *  - Compose Desktop's `Font` takes variation settings directly, so a variable axis needs no
 *    version gate here the way it does on Android below API 26.
 */
internal object DesktopFontBook {

    data class Family(
        val faces: List<StackFonts.Face>,
        val variable: Boolean,
        val axes: Map<String, Pair<Double, Double>>,
        val defaults: Map<String, Double>,
        val fallback: List<String>,
    )

    private const val REGISTRY_RESOURCE = "/dsx/DSXFontRegistry.json"
    private const val FACE_RESOURCE_DIR = "/dsx/fonts/"
    private const val REGISTRY_LIMIT = 1_048_576

    @Volatile private var loaded = false
    @Volatile private var families: Map<String, Family> = emptyMap()
    private val resolved = ConcurrentHashMap<String, FontFamily>()

    val declaredNames: List<String> get() = families.keys.sorted()

    fun family(name: String?): Family? = name?.let { families[it] }

    /** True when the family ships a REAL italic face - the signal the text path uses to skip the
     *  synthetic slant, so a declared italic is not obliqued on top of already being one. */
    fun hasItalicFace(name: String?): Boolean = family(name)?.faces?.any { it.italic } == true

    /**
     * Fail-open (Article 7): no registry resource means no families, every `fontFamily` resolves
     * null, and the caller keeps the platform font - which is the last rung of the declared
     * fallback chain anyway.
     */
    private fun load() {
        if (loaded) return
        synchronized(this) {
            if (loaded) return
            families = runCatching {
                DesktopFontBook::class.java.getResourceAsStream(REGISTRY_RESOURCE)?.use { input ->
                    val bytes = input.readNBytes(REGISTRY_LIMIT + 1)
                    if (bytes.size > REGISTRY_LIMIT) emptyMap() else parse(String(bytes, Charsets.UTF_8))
                } ?: emptyMap()
            }.getOrDefault(emptyMap())
            loaded = true
        }
    }

    private val reader = Json { ignoreUnknownKeys = true; isLenient = false }

    internal fun parse(text: String): Map<String, Family> {
        val root = runCatching { reader.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return emptyMap()
        val declared = root["families"] as? JsonObject ?: return emptyMap()
        val out = LinkedHashMap<String, Family>()
        for ((name, value) in declared) {
            val row = value as? JsonObject ?: continue
            val faceList = row["faces"] as? JsonArray ?: continue
            val faces = faceList.mapNotNull { entry ->
                val face = entry as? JsonObject ?: return@mapNotNull null
                val weight = number(face["weight"])?.toInt() ?: return@mapNotNull null
                StackFonts.Face(
                    weight = weight,
                    italic = (face["italic"] as? JsonPrimitive)?.booleanOrNull == true,
                    file = text(face["file"]),
                    postscriptName = text(face["postscriptName"]),
                )
            }
            if (faces.isEmpty()) continue
            val axes = LinkedHashMap<String, Pair<Double, Double>>()
            (row["axes"] as? JsonObject)?.forEach { (tag, range) ->
                val pair = range as? JsonArray ?: return@forEach
                if (pair.size != 2) return@forEach
                val lo = number(pair[0]) ?: return@forEach
                val hi = number(pair[1]) ?: return@forEach
                axes[tag] = lo to hi
            }
            val defaults = LinkedHashMap<String, Double>()
            (row["defaults"] as? JsonObject)?.forEach { (tag, v) -> number(v)?.let { defaults[tag] = it } }
            val fallback = (row["fallback"] as? JsonArray)?.mapNotNull { text(it) }.orEmpty()
            out[name] = Family(
                faces = faces,
                variable = (row["variable"] as? JsonPrimitive)?.booleanOrNull == true,
                axes = axes,
                defaults = defaults,
                fallback = fallback.ifEmpty { listOf("system") },
            )
        }
        return out
    }

    private fun text(value: JsonElement?): String? =
        (value as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() }

    private fun number(value: JsonElement?): Double? =
        (value as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() }

    /**
     * The cache key for a (family, axes) pair, and the axis set behind it - the whole decision
     * `resolve` makes before it touches Compose. Split out because it is the part worth testing
     * without a real typeface on disk.
     */
    internal fun axisSettings(name: String, variation: String?): Pair<String, Map<String, Double>>? {
        val family = families[name] ?: return null
        val requested = StackFonts.parseVariation(variation)
        val axes = LinkedHashMap<String, Double>(family.defaults)
        if (requested.isNotEmpty()) axes.putAll(StackFonts.resolveVariation(family.axes, requested).applied)
        val key = "$name|" + axes.entries.sortedBy { it.key }.joinToString(",") { "${it.key} ${it.value}" }
        return key to axes
    }

    /**
     * Resolve a declared family to a Compose `FontFamily`. null means the caller keeps the
     * platform font.
     *
     * One `FontFamily` per (family, axes) key, cached: constructing a `Font` opens and parses the
     * face, and doing that inside composition would re-read it on every recomposition.
     */
    fun resolve(name: String, variation: String?): FontFamily? {
        load()
        val (cacheKey, resolvedAxes) = axisSettings(name, variation) ?: return null
        resolved[cacheKey]?.let { return it }

        val settings = resolvedAxes.entries.sortedBy { it.key }
            .map { FontVariation.Setting(it.key, it.value.toFloat()) }
        val variationSettings = if (settings.isEmpty()) FontVariation.Settings()
                                else FontVariation.Settings(*settings.toTypedArray())
        val fonts = families[name]?.faces.orEmpty().mapNotNull { face ->
            val file = face.file ?: return@mapNotNull null
            runCatching {
                Font(
                    resource = FACE_RESOURCE_DIR + file,
                    weight = FontWeight(face.weight),
                    style = if (face.italic) FontStyle.Italic else FontStyle.Normal,
                    variationSettings = variationSettings,
                )
            }.getOrNull()
        }
        if (fonts.isEmpty()) return null
        val family = FontFamily(fonts)
        resolved[cacheKey] = family
        return family
    }

    /** Test seam: the registry is a build artifact, so a test needs a way to stand one up. */
    internal fun loadForTesting(text: String?) {
        synchronized(this) {
            families = text?.let { parse(it) } ?: emptyMap()
            resolved.clear()
            loaded = true
        }
    }
}
