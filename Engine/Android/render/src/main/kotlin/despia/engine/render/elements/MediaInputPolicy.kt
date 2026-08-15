// MediaInputPolicy.kt — pure byte/URL/dimension limits shared by native image + SVG.

package despia.engine.render.elements

import android.content.Context
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileDescriptor
import java.io.InputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import kotlin.math.floor
import kotlin.math.sqrt

internal object MediaInputPolicy {
    const val MAXIMUM_URL_BYTES = 8 * 1_024
    const val MAXIMUM_ASSET_PATH_BYTES = 1_024
    const val MAXIMUM_ENCODED_IMAGE_BYTES = 16 * 1_024 * 1_024
    const val MAXIMUM_DECODED_PIXELS = 32_000_000L
    const val MAXIMUM_DECODED_BYTES = 128L * 1_024L * 1_024L
    const val MAXIMUM_PIXEL_DIMENSION = 8_192
    const val MAXIMUM_ANIMATION_FRAMES = 120
    const val MAXIMUM_SVG_BYTES = 1 * 1_024 * 1_024
    const val MAXIMUM_SVG_PRIMITIVES = 4_096
    const val MAXIMUM_SVG_PATH_TOKENS = 100_000

    data class Dimensions(val width: Int, val height: Int, val frames: Int)

    internal data class SandboxedFile(val file: File, val root: File)

    internal fun appPrivateRoots(context: Context): List<File> = listOf(
        context.filesDir,
        context.cacheDir,
        context.noBackupFilesDir,
        context.codeCacheDir,
    )

    fun validatedHttpURL(raw: String): String? {
        if (raw.isEmpty() || raw.toByteArray(Charsets.UTF_8).size > MAXIMUM_URL_BYTES ||
            raw.any { it.isWhitespace() || it.isISOControl() }) return null
        val uri = runCatching { URI(raw) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase()
        if ((scheme != "http" && scheme != "https") || uri.host.isNullOrEmpty() ||
            uri.rawUserInfo != null || uri.port == 0 || uri.port > 65_535) return null
        return uri.toASCIIString()
    }

    fun normalizedAssetPath(raw: String): String? {
        if (raw.isEmpty() || raw != raw.trim() ||
            raw.toByteArray(Charsets.UTF_8).size > MAXIMUM_ASSET_PATH_BYTES ||
            raw.startsWith('/') || raw.contains('\\') || raw.contains(':') || raw.contains('%') ||
            raw.any { it.code == 0 || it.code < 0x20 || it.code == 0x7f }) return null
        val parts = raw.split('/', ignoreCase = false, limit = 0)
        if (parts.isEmpty() || parts.any { it.isEmpty() || it == "." || it == ".." }) return null
        return parts.joinToString("/")
    }

    fun readBounded(input: InputStream, maximumBytes: Int): ByteArray? {
        if (maximumBytes < 0) return null
        val output = ByteArrayOutputStream(minOf(maximumBytes, 64 * 1_024))
        val buffer = ByteArray(64 * 1_024)
        var total = 0
        while (true) {
            val remaining = maximumBytes - total
            val wanted = if (remaining >= buffer.size) buffer.size else remaining + 1
            val count = input.read(buffer, 0, wanted)
            if (count < 0) return output.toByteArray()
            if (count == 0) {
                val byte = input.read()
                if (byte < 0) return output.toByteArray()
                if (total >= maximumBytes) return null
                output.write(byte)
                total += 1
                continue
            }
            if (count > maximumBytes - total) return null
            output.write(buffer, 0, count)
            total += count
        }
    }

    fun strictUTF8(bytes: ByteArray, maximumBytes: Int = MAXIMUM_SVG_BYTES): String? {
        if (bytes.size > maximumBytes) return null
        return runCatching {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString()
        }.getOrNull()
    }

    fun acceptsSvgMarkup(markup: String): Boolean =
        markup.toByteArray(Charsets.UTF_8).size <= MAXIMUM_SVG_BYTES

    /**
     * Reads an absolute local file only when it resolves to an ordinary file below an app-private root.
     *
     * Android's public [Os] API has no `openat`, including on current releases. We therefore combine the
     * API-21 [Os.open] `O_NOFOLLOW` boundary with post-open `/proc/self/fd` identity verification and
     * descriptor-only stat/read operations. Callers must pass roots that another app cannot rename; the
     * renderer intentionally excludes external storage on API 24 where a path-component swap could race
     * the public API's missing `openat`. Static traversal and symlinks fail before open; a last-moment final
     * symlink fails at `O_NOFOLLOW`; a directory-component swap opens a descriptor whose resolved path does
     * not equal the prevalidated canonical path and is rejected before any byte is read.
     */
    fun readSandboxedRegularFile(
        raw: String,
        roots: List<File>,
        maximumBytes: Int,
        beforeDescriptorOpen: (() -> Unit)? = null,
    ): ByteArray? = runCatching {
        val sandboxed = validatedSandboxedFile(raw, roots, maximumBytes) ?: return@runCatching null
        beforeDescriptorOpen?.invoke() // deterministic instrumentation seam; production always passes null
        readValidatedDescriptor(sandboxed, maximumBytes)
    }.getOrNull()

    internal fun validatedSandboxedFile(raw: String, roots: List<File>, maximumBytes: Int): SandboxedFile? =
        runCatching {
            if (maximumBytes < 0) return@runCatching null
            val candidate = when {
                raw.startsWith("file:", ignoreCase = true) -> {
                    val uri = URI(raw)
                    if (uri.scheme?.lowercase() != "file" || uri.rawAuthority != null ||
                        uri.rawQuery != null || uri.rawFragment != null) return@runCatching null
                    File(uri)
                }
                raw.startsWith('/') -> File(raw)
                else -> return@runCatching null
            }
            val absolute = candidate.absoluteFile
            val canonical = candidate.canonicalFile
            roots.firstNotNullOfOrNull { root ->
                val rootAbsolute = root.absoluteFile.path.trimEnd(File.separatorChar)
                val rootCanonicalFile = root.canonicalFile
                val rootCanonical = rootCanonicalFile.path.trimEnd(File.separatorChar)
                listOf(rootAbsolute, rootCanonical).distinct().firstNotNullOfOrNull { visibleRoot ->
                    val prefix = visibleRoot + File.separator
                    if (!absolute.path.startsWith(prefix)) return@firstNotNullOfOrNull null
                    val relative = absolute.path.removePrefix(prefix)
                    if (relative.isEmpty() || File(rootCanonical, relative).absoluteFile.path != canonical.path) {
                        return@firstNotNullOfOrNull null
                    }
                    if (!canonical.isFile || canonical.length() !in 0..maximumBytes.toLong()) {
                        return@firstNotNullOfOrNull null
                    }
                    SandboxedFile(canonical, rootCanonicalFile)
                }
            }
        }.getOrNull()

    private fun readValidatedDescriptor(sandboxed: SandboxedFile, maximumBytes: Int): ByteArray? {
        var descriptor: FileDescriptor? = null
        return try {
            descriptor = Os.open(
                sandboxed.file.path,
                OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW,
                0,
            )
            val stat = Os.fstat(descriptor)
            if (!OsConstants.S_ISREG(stat.st_mode) ||
                !acceptsRegularDescriptor(stat.st_nlink, stat.st_size, maximumBytes)) return null

            val openedPath = ParcelFileDescriptor.dup(descriptor).use { duplicate ->
                Os.readlink("/proc/self/fd/${duplicate.fd}")
            }
            val rootPrefix = sandboxed.root.path.trimEnd(File.separatorChar) + File.separator
            if (openedPath != sandboxed.file.path || !openedPath.startsWith(rootPrefix)) return null

            readBoundedDescriptor(descriptor, maximumBytes)
        } finally {
            descriptor?.let(Os::close)
        }
    }

    internal fun acceptsRegularDescriptor(linkCount: Long, size: Long, maximumBytes: Int): Boolean =
        maximumBytes >= 0 && linkCount == 1L && size in 0..maximumBytes.toLong()

    private fun readBoundedDescriptor(descriptor: FileDescriptor, maximumBytes: Int): ByteArray? {
        val output = ByteArrayOutputStream(minOf(maximumBytes, 64 * 1_024))
        val buffer = ByteArray(64 * 1_024)
        var total = 0
        while (true) {
            val remaining = maximumBytes - total
            val wanted = if (remaining >= buffer.size) buffer.size else remaining + 1
            val count = Os.read(descriptor, buffer, 0, wanted)
            if (count == 0) return output.toByteArray()
            if (count > maximumBytes - total) return null
            output.write(buffer, 0, count)
            total += count
        }
    }

    fun targetDimensions(width: Int, height: Int, frames: Int = 1): Dimensions? {
        if (width <= 0 || height <= 0 || frames !in 1..MAXIMUM_ANIMATION_FRAMES) return null
        val pixels = width.toLong() * height.toLong()
        if (pixels <= 0L) return null
        val perFrameLimit = MAXIMUM_DECODED_PIXELS / frames.toLong()
        if (perFrameLimit <= 0L) return null
        val scale = minOf(
            1.0,
            MAXIMUM_PIXEL_DIMENSION.toDouble() / width.toDouble(),
            MAXIMUM_PIXEL_DIMENSION.toDouble() / height.toDouble(),
            sqrt(perFrameLimit.toDouble() / pixels.toDouble()),
        )
        var targetWidth = maxOf(1, floor(width.toDouble() * scale).toInt())
        var targetHeight = maxOf(1, floor(height.toDouble() * scale).toInt())
        while (targetWidth.toLong() * targetHeight.toLong() > perFrameLimit) {
            if (targetWidth >= targetHeight) targetWidth -= 1 else targetHeight -= 1
        }
        return Dimensions(targetWidth, targetHeight, frames)
    }

    fun decodedCostBytes(dimensions: Dimensions): Long? {
        val pixels = dimensions.width.toLong() * dimensions.height.toLong()
        if (pixels <= 0L || pixels > MAXIMUM_DECODED_PIXELS / dimensions.frames.toLong()) return null
        val bytes = pixels * dimensions.frames.toLong() * 4L
        return bytes.takeIf { it in 1..MAXIMUM_DECODED_BYTES }
    }

    /** Returns 1 for a static image, an exact supported animation frame count, or null if malformed. */
    fun encodedFrameCount(bytes: ByteArray): Int? = when {
        bytes.size >= 6 && (bytes.copyOfRange(0, 6).contentEquals("GIF87a".toByteArray()) ||
            bytes.copyOfRange(0, 6).contentEquals("GIF89a".toByteArray())) -> gifFrameCount(bytes)
        bytes.size >= 12 && ascii(bytes, 0, 4) == "RIFF" && ascii(bytes, 8, 4) == "WEBP" ->
            webpFrameCount(bytes)
        bytes.size >= 8 && bytes.copyOfRange(0, 8).contentEquals(
            byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) ->
            pngFrameCount(bytes)
        else -> 1
    }

    private fun gifFrameCount(bytes: ByteArray): Int? {
        if (bytes.size < 13) return null
        var at = 13
        val packed = bytes[10].toInt() and 0xff
        if (packed and 0x80 != 0) at += 3 * (1 shl ((packed and 0x07) + 1))
        var frames = 0
        fun skipBlocks(start: Int): Int? {
            var cursor = start
            while (cursor < bytes.size) {
                val size = bytes[cursor].toInt() and 0xff
                cursor += 1
                if (size == 0) return cursor
                if (size > bytes.size - cursor) return null
                cursor += size
            }
            return null
        }
        while (at < bytes.size) {
            when (bytes[at].toInt() and 0xff) {
                0x3b -> return maxOf(1, frames)
                0x21 -> {
                    if (at + 2 > bytes.size) return null
                    at = skipBlocks(at + 2) ?: return null
                }
                0x2c -> {
                    if (at + 10 > bytes.size) return null
                    frames += 1
                    if (frames > MAXIMUM_ANIMATION_FRAMES) return frames
                    val imagePacked = bytes[at + 9].toInt() and 0xff
                    at += 10
                    if (imagePacked and 0x80 != 0) at += 3 * (1 shl ((imagePacked and 0x07) + 1))
                    if (at >= bytes.size) return null
                    at = skipBlocks(at + 1) ?: return null // LZW minimum-code byte, then sub-blocks
                }
                else -> return null
            }
        }
        return null
    }

    private fun webpFrameCount(bytes: ByteArray): Int? {
        var at = 12
        var animated = false
        var frames = 0
        while (at + 8 <= bytes.size) {
            val type = ascii(bytes, at, 4)
            val size = littleUInt32(bytes, at + 4) ?: return null
            if (size > Int.MAX_VALUE.toLong()) return null
            val padded = size + (size and 1L)
            if (padded > bytes.size.toLong() - at.toLong() - 8L) return null
            if (type == "ANIM") animated = true
            if (type == "ANMF") {
                frames += 1
                if (frames > MAXIMUM_ANIMATION_FRAMES) return frames
            }
            at += 8 + padded.toInt()
        }
        return if (animated) frames.takeIf { it > 0 } else 1
    }

    private fun pngFrameCount(bytes: ByteArray): Int? {
        var at = 8
        var frames = 0
        while (at + 12 <= bytes.size) {
            val size = bigUInt32(bytes, at) ?: return null
            if (size > Int.MAX_VALUE.toLong() || size > bytes.size.toLong() - at.toLong() - 12L) return null
            val type = ascii(bytes, at + 4, 4)
            if (type == "fcTL") {
                frames += 1
                if (frames > MAXIMUM_ANIMATION_FRAMES) return frames
            }
            at += 12 + size.toInt()
            if (type == "IEND") return maxOf(1, frames)
        }
        return null
    }

    private fun ascii(bytes: ByteArray, at: Int, count: Int): String =
        String(bytes, at, count, Charsets.US_ASCII)

    private fun littleUInt32(bytes: ByteArray, at: Int): Long? {
        if (at < 0 || at + 4 > bytes.size) return null
        return (bytes[at].toLong() and 0xffL) or
            ((bytes[at + 1].toLong() and 0xffL) shl 8) or
            ((bytes[at + 2].toLong() and 0xffL) shl 16) or
            ((bytes[at + 3].toLong() and 0xffL) shl 24)
    }

    private fun bigUInt32(bytes: ByteArray, at: Int): Long? {
        if (at < 0 || at + 4 > bytes.size) return null
        return ((bytes[at].toLong() and 0xffL) shl 24) or
            ((bytes[at + 1].toLong() and 0xffL) shl 16) or
            ((bytes[at + 2].toLong() and 0xffL) shl 8) or
            (bytes[at + 3].toLong() and 0xffL)
    }
}
