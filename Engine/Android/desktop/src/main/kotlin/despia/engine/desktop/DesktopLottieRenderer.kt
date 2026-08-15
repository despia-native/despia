package despia.engine.desktop

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import despia.engine.JSE
import io.github.alexzhirkevich.compottie.Compottie
import io.github.alexzhirkevich.compottie.LottieCompositionSpec
import io.github.alexzhirkevich.compottie.animateLottieCompositionAsState
import io.github.alexzhirkevich.compottie.rememberLottieComposition
import io.github.alexzhirkevich.compottie.rememberLottiePainter
import io.github.alexzhirkevich.compottie.DotLottie
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal const val DESKTOP_LOTTIE_MAX_SOURCE_BYTES = 8 * 1024 * 1024
internal const val DESKTOP_LOTTIE_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
internal const val DESKTOP_LOTTIE_MAX_ARCHIVE_ENTRIES = 512
internal const val DESKTOP_LOTTIE_MAX_JSON_NODES = 250_000
internal const val DESKTOP_LOTTIE_MAX_JSON_DEPTH = 128

private sealed interface DesktopLottieSource {
    data object Loading : DesktopLottieSource
    data class Ready(val bytes: ByteArray, val json: String?, val dotLottie: Boolean) : DesktopLottieSource
    data class Failure(val reason: String) : DesktopLottieSource
}

/** Pure Compose/Skia Lottie playback. No browser, temporary file, authored script,
 * or renderer-owned network client participates in this path. Remote bytes use the
 * credential-free DSX transport and are admitted structurally before Compottie sees them. */
@Composable
internal fun DesktopNativeLottie(context: DesktopElementContext, modifier: Modifier) {
    val source = context.value("src")?.trim().orEmpty()
    if (source.isEmpty()) {
        // Canonical iOS/Android behavior for a missing source is a clear zero frame.
        Box(Modifier.size(0.dp))
        return
    }
    val state by produceState<DesktopLottieSource>(DesktopLottieSource.Loading, source) {
        value = try {
            withContext(Dispatchers.IO) { loadDesktopLottieSource(source) }
        } catch (failure: Throwable) {
            DesktopLottieSource.Failure(safeDesktopLottieFailure(failure))
        }
    }
    val sized = desktopMediaSize(modifier, context.attributes, 180f)
        .semantics { contentDescription = context.value("a11yLabel") ?: "Lottie animation" }
    when (val current = state) {
        DesktopLottieSource.Loading -> Box(sized, contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
        }
        is DesktopLottieSource.Failure -> DesktopMediaStateCard(
            sized,
            context.attributes,
            "Animation unavailable",
            current.reason,
            "DSX rejected or could not decode this animation",
            180f,
        )
        is DesktopLottieSource.Ready -> {
            val specification = remember(current) {
                if (current.dotLottie) {
                    LottieCompositionSpec.DotLottie(current.bytes)
                } else {
                    LottieCompositionSpec.JsonString(requireNotNull(current.json))
                }
            }
            val compositionResult = rememberLottieComposition(specification)
            val composition = compositionResult.value
            val loop = desktopMediaBool(context.value("loop"), true)
            val autoplay = desktopMediaBool(context.value("autoplay"), true)
            val speed = (context.value("speed")?.let(JSE::number) ?: 1.0)
                .takeIf(Double::isFinite)?.coerceIn(-16.0, 16.0)?.toFloat() ?: 1f
            val animation = animateLottieCompositionAsState(
                composition = composition,
                isPlaying = autoplay && speed != 0f,
                iterations = if (loop) Compottie.IterateForever else 1,
                speed = speed,
            )
            var finishDelivered by remember(current) { mutableStateOf(false) }
            LaunchedEffect(animation.isAtEnd, animation.isPlaying, loop, composition) {
                if (!loop && composition != null && animation.isAtEnd && !animation.isPlaying &&
                    animation.progress > 0f && !finishDelivered
                ) {
                    finishDelivered = true
                    context.attributes["on:finish"]?.let { context.run(it) }
                }
            }
            when {
                compositionResult.isFailure -> DesktopMediaStateCard(
                    sized,
                    context.attributes,
                    "Animation unavailable",
                    "Animation decode failed",
                    "No partial animation was rendered",
                    180f,
                )
                composition == null -> Box(sized, contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
                }
                else -> Image(
                    painter = rememberLottiePainter(
                        composition = composition,
                        progress = { animation.progress },
                        // Authored After Effects expressions are executable programs.
                        // DSX remote media is data-only, so the desktop renderer keeps
                        // expression execution disabled for untrusted/bundled parity.
                        enableExpressions = false,
                    ),
                    contentDescription = context.value("a11yLabel"),
                    modifier = sized,
                    contentScale = ContentScale.Fit,
                )
            }
        }
    }
}

private suspend fun loadDesktopLottieSource(source: String): DesktopLottieSource.Ready {
    val remote = source.startsWith("https://", ignoreCase = true) ||
        source.startsWith("http://", ignoreCase = true)
    val bytes: ByteArray
    val contentType: String
    if (remote) {
        val response = DesktopNetwork.fetchAnonymousMedia(source, DESKTOP_LOTTIE_MAX_SOURCE_BYTES.toLong())
        require(response.status in 200..299) { "http_status" }
        bytes = response.body
        contentType = response.contentType.substringBefore(';').trim().lowercase(Locale.ROOT)
    } else {
        bytes = loadDesktopAsset(
            source,
            listOf("", ".json", ".lottie"),
            DESKTOP_LOTTIE_MAX_SOURCE_BYTES.toLong(),
        ) ?: throw IllegalArgumentException("asset_missing")
        contentType = ""
    }
    require(bytes.isNotEmpty()) { "empty_animation" }
    val isZip = bytes.size >= 4 && bytes[0] == 0x50.toByte() && bytes[1] == 0x4b.toByte() &&
        bytes[2] == 0x03.toByte() && bytes[3] == 0x04.toByte()
    if (isZip) {
        require(
            contentType.isEmpty() || contentType in setOf(
                "application/zip",
                "application/octet-stream",
                "application/dotlottie",
                "application/x-dotlottie",
            )
        ) { "mime_blocked" }
        validateDesktopDotLottie(bytes)
        return DesktopLottieSource.Ready(bytes, null, dotLottie = true)
    }
    require(
        contentType.isEmpty() || contentType == "application/json" ||
            contentType.endsWith("+json") || contentType == "application/octet-stream" ||
            contentType == "text/plain"
    ) { "mime_blocked" }
    val json = validateDesktopLottieJson(bytes)
    return DesktopLottieSource.Ready(bytes, json, dotLottie = false)
}

/** Admission pass for ordinary Lottie JSON. It bounds nesting/object count before
 * the JSON parser recurses, validates the animation envelope, and rejects every known
 * external resource shape. Desktop deliberately installs no resource/network loader. */
internal fun validateDesktopLottieJson(bytes: ByteArray): String {
    require(bytes.isNotEmpty() && bytes.size <= 16 * 1024 * 1024) { "animation_size" }
    val text = strictDesktopUtf8(bytes)
    preflightDesktopJson(text)
    val root = desktopLottieJson.parseToJsonElement(text).jsonObject
    validateDesktopJsonTree(root)
    require(root["v"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true) { "animation_version" }
    val frameRate = root["fr"]?.jsonPrimitive?.doubleOrNull
    val inPoint = root["ip"]?.jsonPrimitive?.doubleOrNull
    val outPoint = root["op"]?.jsonPrimitive?.doubleOrNull
    val width = root["w"]?.jsonPrimitive?.doubleOrNull
    val height = root["h"]?.jsonPrimitive?.doubleOrNull
    require(frameRate != null && frameRate.isFinite() && frameRate in 0.01..1_000.0) { "animation_rate" }
    require(inPoint != null && outPoint != null && inPoint.isFinite() && outPoint.isFinite() &&
        outPoint > inPoint && outPoint - inPoint <= frameRate * 86_400.0
    ) { "animation_duration" }
    require(width != null && height != null && width.isFinite() && height.isFinite() &&
        width in 1.0..16_384.0 && height in 1.0..16_384.0 && width * height <= 67_108_864.0
    ) { "animation_dimensions" }
    val layers = root["layers"] as? JsonArray ?: throw IllegalArgumentException("animation_layers")
    require(layers.size <= 20_000) { "animation_layers" }
    validateDesktopLottieResourceIsolation(root)
    return text
}

/** Validates dotLottie as an in-memory archive before Compottie mounts it. Nothing is
 * extracted to disk; traversal, duplicate names, unsupported compression, zip bombs,
 * malformed manifests, and malformed animation JSON all fail the whole element closed. */
internal fun validateDesktopDotLottie(bytes: ByteArray) {
    require(bytes.isNotEmpty() && bytes.size <= DESKTOP_LOTTIE_MAX_SOURCE_BYTES) { "animation_archive_size" }
    val names = HashSet<String>()
    val documents = LinkedHashMap<String, ByteArray>()
    var entries = 0
    var expanded = 0L
    ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
        while (true) {
            val entry = zip.nextEntry ?: break
            entries += 1
            require(entries <= DESKTOP_LOTTIE_MAX_ARCHIVE_ENTRIES) { "animation_archive_entries" }
            val name = safeDesktopArchiveName(entry.name)
            require(names.add(name)) { "animation_archive_duplicate" }
            require(entry.method == ZipEntry.STORED || entry.method == ZipEntry.DEFLATED) {
                "animation_archive_compression"
            }
            entry.size.takeIf { it >= 0 }?.let { require(it <= 16L * 1024L * 1024L) { "animation_entry_size" } }
            if (entry.isDirectory) {
                require(name == "animations/") { "animation_archive_directory" }
                zip.closeEntry()
                continue
            }
            require(name == "manifest.json" || DESKTOP_LOTTIE_ANIMATION_ENTRY.matches(name)) {
                "animation_archive_unsupported_entry"
            }
            val captured = ByteArrayOutputStream()
            val buffer = ByteArray(16 * 1024)
            var entryBytes = 0L
            while (true) {
                val count = zip.read(buffer)
                if (count < 0) break
                entryBytes = Math.addExact(entryBytes, count.toLong())
                expanded = Math.addExact(expanded, count.toLong())
                require(entryBytes <= 16L * 1024L * 1024L) { "animation_entry_size" }
                require(expanded <= DESKTOP_LOTTIE_MAX_ARCHIVE_BYTES) { "animation_archive_expanded" }
                captured.write(buffer, 0, count)
            }
            documents[name] = captured.toByteArray()
            zip.closeEntry()
        }
    }
    val manifest = documents.remove("manifest.json") ?: throw IllegalArgumentException("animation_archive_contents")
    require(manifest.size <= 1024 * 1024) { "animation_manifest_size" }
    val manifestRoot = parseDesktopJsonObject(manifest)
    validateDesktopLottieResourceIsolation(manifestRoot)
    val manifestAnimations = manifestRoot["animations"] as? JsonArray
        ?: throw IllegalArgumentException("animation_manifest")
    require(manifestAnimations.isNotEmpty() && manifestAnimations.size <= DESKTOP_LOTTIE_MAX_ARCHIVE_ENTRIES - 1) {
        "animation_manifest"
    }
    val expectedEntries = manifestAnimations.mapTo(LinkedHashSet()) { animation ->
        val id = (animation as? JsonObject)?.get("id")?.jsonPrimitive?.contentOrNull
            ?: throw IllegalArgumentException("animation_manifest")
        require(DESKTOP_LOTTIE_ANIMATION_ID.matches(id) && id != "." && id != "..") {
            "animation_manifest_id"
        }
        "animations/$id.json"
    }
    require(expectedEntries.size == manifestAnimations.size && documents.keys == expectedEntries) {
        "animation_archive_contents"
    }
    documents.values.forEach { validateDesktopLottieJson(it) }
}

/** Rejects all URL schemes and all fields Compottie can interpret as a resource path.
 * This deliberately rejects embedded data-URI images too: accepting them would hand a
 * second, separately compressed image format to a decoder outside DSX's pixel bounds. */
private fun validateDesktopLottieResourceIsolation(root: JsonElement) {
    val pending = java.util.ArrayDeque<Pair<String?, JsonElement>>()
    pending.add(null to root)
    while (pending.isNotEmpty()) {
        val (key, value) = pending.removeLast()
        when (value) {
            is JsonObject -> value.forEach { (childKey, child) -> pending.add(childKey to child) }
            is JsonArray -> value.forEach { child -> pending.add(key to child) }
            is JsonPrimitive -> if (value.isString) {
                val content = value.content.trim()
                val normalized = content.lowercase(Locale.ROOT)
                val external = normalized.startsWith("http:") || normalized.startsWith("https:") ||
                    normalized.startsWith("file:") || normalized.startsWith("jar:") ||
                    normalized.startsWith("ftp:") || normalized.startsWith("data:") ||
                    normalized.startsWith("blob:") || normalized.startsWith("content:") ||
                    normalized.startsWith("//") || normalized.startsWith("url(")
                val resourcePathField = key.equals("p", ignoreCase = true) ||
                    key.equals("u", ignoreCase = true) || key.equals("fPath", ignoreCase = true)
                require(!external && !(resourcePathField && content.isNotEmpty())) {
                    "external_animation_asset"
                }
            }
        }
    }
}

private fun parseDesktopJsonObject(bytes: ByteArray): JsonObject {
    val text = strictDesktopUtf8(bytes)
    preflightDesktopJson(text)
    val root = desktopLottieJson.parseToJsonElement(text).jsonObject
    validateDesktopJsonTree(root)
    return root
}

private fun safeDesktopArchiveName(raw: String): String {
    require(raw.isNotBlank() && raw.length <= 1_024 && !raw.startsWith('/') &&
        !raw.contains('\\') && !raw.contains('\u0000') && !raw.contains(':')
    ) { "animation_archive_path" }
    val value = raw.removeSuffix("/")
    require(value.split('/').none { it.isEmpty() || it == "." || it == ".." }) { "animation_archive_path" }
    return raw
}

private fun strictDesktopUtf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
    .onMalformedInput(CodingErrorAction.REPORT)
    .onUnmappableCharacter(CodingErrorAction.REPORT)
    .decode(ByteBuffer.wrap(bytes)).toString()

private fun preflightDesktopJson(text: String) {
    require(text.length <= 16 * 1024 * 1024) { "animation_json_size" }
    val stack = CharArray(DESKTOP_LOTTIE_MAX_JSON_DEPTH)
    var depth = 0
    var structural = 0
    var inString = false
    var escaped = false
    var stringLength = 0
    var rootSeen = false
    var rootClosed = false
    text.forEach { character ->
        if (inString) {
            require(character >= ' ' || escaped) { "animation_json_control" }
            if (escaped) escaped = false
            else if (character == '\\') escaped = true
            else if (character == '"') inString = false
            else {
                stringLength += 1
                require(stringLength <= 1024 * 1024) { "animation_json_string" }
            }
            return@forEach
        }
        when (character) {
            '"' -> {
                require(!rootClosed) { "animation_json_trailing" }
                inString = true
                stringLength = 0
            }
            '{', '[' -> {
                require(!rootClosed && depth < DESKTOP_LOTTIE_MAX_JSON_DEPTH) { "animation_json_depth" }
                if (!rootSeen) {
                    require(character == '{') { "animation_json_root" }
                    rootSeen = true
                }
                stack[depth++] = character
                structural += 1
            }
            '}', ']' -> {
                require(depth > 0 && (character == '}' && stack[depth - 1] == '{' ||
                    character == ']' && stack[depth - 1] == '[')
                ) { "animation_json_structure" }
                depth -= 1
                structural += 1
                if (depth == 0) rootClosed = true
            }
            ',', ':' -> {
                require(depth > 0 && !rootClosed) { "animation_json_structure" }
                structural += 1
            }
            else -> if (!character.isWhitespace()) {
                require(rootSeen && !rootClosed) { "animation_json_structure" }
            }
        }
        require(structural <= DESKTOP_LOTTIE_MAX_JSON_NODES * 4) { "animation_json_structure" }
    }
    require(rootSeen && rootClosed && depth == 0 && !inString && !escaped) { "animation_json_incomplete" }
}

private fun validateDesktopJsonTree(root: JsonElement) {
    val pending = java.util.ArrayDeque<Pair<JsonElement, Int>>()
    pending.add(root to 1)
    var nodes = 0
    while (pending.isNotEmpty()) {
        val (value, depth) = pending.removeLast()
        nodes += 1
        require(nodes <= DESKTOP_LOTTIE_MAX_JSON_NODES && depth <= DESKTOP_LOTTIE_MAX_JSON_DEPTH) {
            "animation_json_complexity"
        }
        when (value) {
            is JsonObject -> {
                require(value.size <= 20_000) { "animation_json_object" }
                value.forEach { (key, child) ->
                    require(key.length <= 16_384) { "animation_json_key" }
                    pending.add(child to depth + 1)
                }
            }
            is JsonArray -> {
                require(value.size <= DESKTOP_LOTTIE_MAX_JSON_NODES) { "animation_json_array" }
                value.forEach { pending.add(it to depth + 1) }
            }
            is JsonPrimitive -> require(value.content.length <= 1024 * 1024) { "animation_json_value" }
        }
    }
}

internal fun desktopMediaBool(raw: String?, fallback: Boolean): Boolean {
    if (raw == null) return fallback
    return raw == "true" || (JSE.number(raw)?.let { it != 0.0 } ?: false)
}

private fun safeDesktopLottieFailure(failure: Throwable): String {
    val message = generateSequence(failure) { it.cause }.mapNotNull(Throwable::message).firstOrNull().orEmpty()
    return when {
        message.contains("asset_missing") -> "Bundled animation was not found"
        message.contains("mime_blocked") -> "Server returned a non-animation media type"
        message.contains("external_animation_asset") -> "External animation assets are not permitted"
        message.contains("archive") -> "Unsafe or malformed dotLottie archive"
        message.contains("http_status") -> "Animation request failed"
        message.contains("InvalidURL") -> "Animation source was blocked by DSX transport policy"
        message.contains("animation_") -> "Unsafe or malformed animation data"
        else -> "Animation request or decode failed"
    }
}

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
private val desktopLottieJson = Json {
    isLenient = false
    ignoreUnknownKeys = false
    allowSpecialFloatingPointValues = false
    allowTrailingComma = false
}

private val DESKTOP_LOTTIE_ANIMATION_ID = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
private val DESKTOP_LOTTIE_ANIMATION_ENTRY = Regex("animations/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.json")
