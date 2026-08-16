// Native.kt - finding, extracting and loading the desktop native.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// WHY THIS FILE EXISTS. On Android the native rides inside the APK and
// System.loadLibrary finds it. On desktop - Compose Desktop, a server-side JVM,
// a CLI - there is no APK: the artifact is a plain JAR, the native arrives in a
// SECOND jar carrying a per-OS Maven classifier, and something has to get it out
// of the classpath and onto a filesystem path before System.load can be handed
// one. That something is this file, and everything it does is a consequence of
// two failures it exists to prevent.
//
//   1. A STALE NATIVE AFTER AN UPGRADE. The extracted copy is cached, or every
//      process start pays to unpack megabytes. A cache keyed only on the file
//      NAME serves 0.1.0's library to 0.2.0's classes for as long as the machine
//      lives, and the resulting crash names neither version. So the cache key
//      leads with the PACKAGE VERSION, and the recorded digest settles the case
//      the version cannot (a rebuilt snapshot). A version bump can never read a
//      previous install's bytes, because it never looks in that directory.
//
//   2. AN UnsatisfiedLinkError WITH NOTHING IN IT. A missing native is a
//      perfectly ordinary state - an app that ships the linux classifier and
//      runs on Windows, a slim build, a platform this package has no artifact
//      for - and the JVM's answer to it is a stack trace naming a path. This
//      package's answer is a TYPED ABSENCE instead: the same shape the corpus
//      pins for an engine that is not in the build (code `not_available`, a
//      reason that says WHICH way it is absent, data naming the platform and
//      everything that was searched). Absence is a value, never a crash -
//      constitution Article 7, error-system.md.
//
// The resolution itself is a pure function over (platform, version, source) so
// that BOTH of those properties are tested rather than asserted: the tests drive
// it with a Windows platform and an empty classpath and read the answer back.

package com.despia.ai

import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/** Where a classifier's native lives inside the classpath. */
private const val RESOURCE_ROOT = "com/despia/ai/natives"

/** Where the build stamps the version the classes were compiled at. */
private const val VERSION_RESOURCE = "com/despia/ai/version.txt"

/**
 * The OS/arch pair this JVM runs on, in the package's own words.
 *
 * The vocabulary is the Maven CLASSIFIER vocabulary (`linux-x64`), not the JVM's
 * (`amd64`, `x86_64`, `Mac OS X`): one name per platform, chosen once, so the
 * jar coordinate and the resource path and the cache directory all spell it the
 * same way.
 */
data class NativePlatform(val os: String, val arch: String) {

    val classifier: String get() = "$os-$arch"

    /** What the linker calls the library on this OS. */
    val libraryFileName: String get() = when (os) {
        "windows" -> "despia_ai.dll"
        "macos" -> "libdespia_ai.dylib"
        else -> "libdespia_ai.so"
    }

    val resourcePath: String get() = "$RESOURCE_ROOT/$classifier/$libraryFileName"

    override fun toString(): String = classifier

    companion object {
        /**
         * Every classifier this loader knows how to resolve. Which of them a
         * given RELEASE actually publishes is a packaging question and is
         * answered in docs/desktop.md - this list is what the code can find, not
         * a promise about what exists.
         */
        val KNOWN = listOf("linux-x64", "linux-arm64", "windows-x64", "macos-arm64", "macos-x64")

        /** The running platform, or null if this package names no classifier for it. */
        fun of(osName: String, osArch: String): NativePlatform? {
            val os = normalizeOs(osName) ?: return null
            val arch = normalizeArch(osArch) ?: return null
            return NativePlatform(os, arch)
        }

        fun current(): NativePlatform? =
            of(System.getProperty("os.name") ?: "", System.getProperty("os.arch") ?: "")

        private fun normalizeOs(raw: String): String? {
            val name = raw.lowercase()
            return when {
                name.startsWith("windows") -> "windows"
                name.startsWith("mac") || name.contains("darwin") -> "macos"
                name.startsWith("linux") -> "linux"
                else -> null
            }
        }

        private fun normalizeArch(raw: String): String? = when (raw.lowercase()) {
            "amd64", "x86_64", "x64" -> "x64"
            "aarch64", "arm64" -> "arm64"
            else -> null
        }
    }
}

/**
 * What the loader found - a VALUE, so a caller can ask whether inference is
 * possible here without catching anything.
 */
sealed interface NativeResolution {

    /** The library is on disk at [file] and [origin] says how it got there. */
    data class Present(val file: File, val origin: String) : NativeResolution

    /**
     * The library is not available, and this says exactly which way.
     *
     * `code` is always `not_available` - the corpus's word for a capability the
     * build does not carry (Conformance/ai/absence). `reason` is the diagnosis:
     *
     *  · `unsupported_platform` - this package names no classifier for the
     *    running os/arch at all.
     *  · `engine_absent`        - the platform is named, but no native for it is
     *    on the classpath. The ordinary "you did not add the classifier jar" case.
     *  · `native_missing`       - `despia.ai.native` pointed somewhere explicit
     *    and the library is not there. Distinct because the operator SAID where.
     *  · `version_unknown`      - the packaged version stamp is missing, so no
     *    cache key can be built. Refused rather than risk serving stale bytes.
     *  · `digest_mismatch`      - the extracted bytes are not the bytes the build
     *    recorded.
     *  · `extract_failed`       - the cache directory could not be written.
     *  · `native_load_failed`   - found, extracted, and the dynamic linker
     *    refused it. Carries the linker's own message.
     */
    data class Absent(val reason: String, val data: Json) : NativeResolution {
        val code: String get() = "not_available"

        fun toJson(): Json = jsonOf(
            "code" to Json.Str(code),
            "reason" to Json.Str(reason),
            "data" to data,
        )

        /** One line, in the order a reader needs it: what, why, where it looked. */
        fun message(): String {
            val where = data["searched"].strings()
            val tail = if (where.isEmpty()) "" else " (searched: ${where.joinToString(", ")})"
            val platform = data["platform"].stringOrNull() ?: "this platform"
            return "the Despia AI native is not available for $platform: $reason$tail"
        }
    }
}

/** A place resources come from. The tests supply their own; production reads the classpath. */
internal interface NativeSource {
    fun exists(path: String): Boolean
    /** Byte length WITHOUT reading the bytes, or null when the length is not known cheaply. */
    fun size(path: String): Long?
    fun open(path: String): InputStream?
    fun text(path: String): String? = open(path)?.use { it.readBytes().toString(Charsets.UTF_8).trim() }
}

internal class ClasspathSource(private val loader: ClassLoader) : NativeSource {
    override fun exists(path: String): Boolean = loader.getResource(path) != null

    // Asked so the cached copy can be checked against the packaged one without
    // reading megabytes back out of the jar. A jar entry knows its own length; a
    // source that does not is answered null and re-extracted rather than guessed
    // at - and in practice the build's digest settles it before this is reached.
    override fun size(path: String): Long? {
        val url = loader.getResource(path) ?: return null
        return try {
            val connection = url.openConnection()
            connection.connect()
            connection.contentLengthLong.takeIf { it >= 0 }
        } catch (_: Exception) {
            null
        }
    }

    override fun open(path: String): InputStream? = loader.getResourceAsStream(path)
}

/**
 * The desktop native: found, extracted, loaded - once per process.
 *
 * [probe] answers without throwing and without loading, which is what a UI asks
 * before it offers a feature. [ensureLoaded] is the same resolution with the
 * absence raised as a [DespiaAiError] carrying the same code and reason, for the
 * call paths that cannot continue without the library.
 */
object Native {

    @Volatile private var loaded: NativeResolution.Present? = null

    /** Overrides, in the order they win. Set by an operator, never by the package. */
    private const val PROPERTY_DIR = "despia.ai.native"
    private const val PROPERTY_CACHE = "despia.ai.cache"

    /** The package version these classes were built at, from the build's own stamp. */
    fun version(): String? = ClasspathSource(javaClass.classLoader).text(VERSION_RESOURCE)?.ifEmpty { null }

    /** True when this build can run inference on this machine. Never throws. */
    fun isAvailable(): Boolean = probe() is NativeResolution.Present

    /**
     * Resolves the native, extracting it from the classpath if that is where it
     * lives, and loads it. Idempotent: the library is loaded at most once.
     */
    @Synchronized
    fun probe(): NativeResolution {
        loaded?.let { return it }
        val resolution = resolve(
            platform = NativePlatform.current(),
            version = version(),
            explicitDir = System.getProperty(PROPERTY_DIR)?.let { File(it) },
            cacheRoot = cacheRoot(),
            source = ClasspathSource(javaClass.classLoader),
        )
        if (resolution !is NativeResolution.Present) return resolution

        return try {
            System.load(resolution.file.absolutePath)
            loaded = resolution
            resolution
        } catch (t: Throwable) {
            // The one failure the JVM reports as an Error rather than an
            // exception, and the one people paste into an issue with no context.
            // It becomes a value like every other absence, with the linker's own
            // words kept verbatim.
            NativeResolution.Absent(
                "native_load_failed",
                jsonOf(
                    "platform" to Json.Str(NativePlatform.current()?.classifier ?: "unknown"),
                    "path" to Json.Str(resolution.file.absolutePath),
                    "message" to Json.Str(t.message ?: t.javaClass.name),
                ),
            )
        }
    }

    /** [probe], with absence raised. The code and reason survive onto the error. */
    fun ensureLoaded() {
        when (val resolution = probe()) {
            is NativeResolution.Present -> Unit
            is NativeResolution.Absent -> throw DespiaAiError(
                resolution.code, resolution.message(), resolution.toJson(),
            )
        }
    }

    // ── resolution ────────────────────────────────────────────────────────────

    /**
     * Pure over its inputs, which is the point: the tests drive it with a
     * platform this machine is not and a classpath that carries nothing, and
     * read the typed absence back rather than trusting a comment about it.
     */
    internal fun resolve(
        platform: NativePlatform?,
        version: String?,
        explicitDir: File?,
        cacheRoot: File?,
        source: NativeSource,
    ): NativeResolution {
        val searched = mutableListOf<String>()

        // 1. An explicit directory. A developer building the native locally, and
        //    the gradle test task, both take this path - and if they named a
        //    directory that has no library in it, that is THEIR mistake and it
        //    gets its own reason rather than being reported as a missing package.
        if (explicitDir != null) {
            val names = if (platform != null) listOf(platform.libraryFileName)
                        else listOf("libdespia_ai.so", "libdespia_ai.dylib", "despia_ai.dll")
            for (name in names) {
                val candidate = File(explicitDir, name)
                searched.add(candidate.path)
                if (candidate.isFile) return NativeResolution.Present(candidate, "explicit")
            }
            return NativeResolution.Absent(
                "native_missing",
                jsonOf(
                    "platform" to Json.Str(platform?.classifier ?: "unknown"),
                    "property" to Json.Str(PROPERTY_DIR),
                    "searched" to Json.Arr(searched.map { Json.Str(it) }),
                ),
            )
        }

        // 2. A platform this package has no word for. Named separately from an
        //    absent artifact because the answers differ: one is "add the
        //    classifier jar", the other is "this package has no build for you".
        if (platform == null) {
            return NativeResolution.Absent(
                "unsupported_platform",
                jsonOf(
                    "os" to Json.Str(System.getProperty("os.name") ?: ""),
                    "arch" to Json.Str(System.getProperty("os.arch") ?: ""),
                    "known" to Json.Arr(NativePlatform.KNOWN.map { Json.Str(it) }),
                ),
            )
        }

        val resource = platform.resourcePath
        searched.add("classpath:$resource")
        if (!source.exists(resource)) {
            return NativeResolution.Absent(
                "engine_absent",
                jsonOf(
                    "platform" to Json.Str(platform.classifier),
                    "artifact" to Json.Str("com.despia:ai-jvm:${version ?: "?"}:${platform.classifier}"),
                    "searched" to Json.Arr(searched.map { Json.Str(it) }),
                ),
            )
        }

        // 3. The cache key. The VERSION leads it, so an upgrade cannot read the
        //    previous install's directory - it is not the directory it looks in.
        if (version.isNullOrEmpty()) {
            return NativeResolution.Absent(
                "version_unknown",
                jsonOf(
                    "platform" to Json.Str(platform.classifier),
                    "resource" to Json.Str(VERSION_RESOURCE),
                ),
            )
        }
        if (cacheRoot == null) {
            return NativeResolution.Absent(
                "extract_failed",
                jsonOf(
                    "platform" to Json.Str(platform.classifier),
                    "message" to Json.Str("no writable cache directory"),
                ),
            )
        }

        val expected = source.text("$resource.sha256")?.takeIf { it.isNotEmpty() }
        val home = File(File(cacheRoot, version), platform.classifier)
        val target = File(home, platform.libraryFileName)
        val stamp = File(home, ".despia-ai-stamp")

        // A cached copy is reused when the build's recorded digest matches the
        // stamp written beside it - and, when this build recorded no digest,
        // when the byte length matches. Reading the stamp is a few bytes; the
        // point of caching is not to read the megabytes.
        if (target.isFile) {
            val recorded = runCatching { stamp.readText().trim() }.getOrNull()
            val fresh = if (expected != null) recorded == expected
                        else source.size(resource)?.let { it == target.length() } ?: false
            if (fresh) return NativeResolution.Present(target, "cache")
        }

        return extract(source, resource, platform, home, target, stamp, expected)
    }

    /**
     * Writes the library into the cache. Written to a unique temporary name in
     * the SAME directory and moved into place atomically, so two processes
     * starting at once cannot hand each other a half-written file - the loser of
     * the race replaces identical bytes with identical bytes.
     */
    private fun extract(
        source: NativeSource,
        resource: String,
        platform: NativePlatform,
        home: File,
        target: File,
        stamp: File,
        expected: String?,
    ): NativeResolution {
        val failure = { message: String ->
            NativeResolution.Absent(
                "extract_failed",
                jsonOf(
                    "platform" to Json.Str(platform.classifier),
                    "path" to Json.Str(target.absolutePath),
                    "message" to Json.Str(message),
                ),
            )
        }

        if (!home.isDirectory && !home.mkdirs() && !home.isDirectory) {
            return failure("could not create ${home.absolutePath}")
        }

        val temporary = File(home, "${target.name}.${ProcessHandle.current().pid()}.${System.nanoTime()}")
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            val input = source.open(resource) ?: return failure("the resource disappeared: $resource")
            input.use { stream ->
                temporary.outputStream().use { out ->
                    val buffer = ByteArray(1 shl 16)
                    while (true) {
                        val read = stream.read(buffer)
                        if (read < 0) break
                        digest.update(buffer, 0, read)
                        out.write(buffer, 0, read)
                    }
                }
            }

            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (expected != null && !expected.equals(actual, ignoreCase = true)) {
                temporary.delete()
                return NativeResolution.Absent(
                    "digest_mismatch",
                    jsonOf(
                        "platform" to Json.Str(platform.classifier),
                        "expected" to Json.Str(expected),
                        "actual" to Json.Str(actual),
                    ),
                )
            }

            temporary.setExecutable(true, true)
            Files.move(
                temporary.toPath(), target.toPath(),
                StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE,
            )
            runCatching { stamp.writeText(expected ?: actual) }
            return NativeResolution.Present(target, "extracted")
        } catch (e: Exception) {
            temporary.delete()
            return failure(e.message ?: e.javaClass.name)
        }
    }

    // ── the cache root ────────────────────────────────────────────────────────

    private fun cacheRoot(): File? {
        System.getProperty(PROPERTY_CACHE)?.let { return File(it) }
        val platform = NativePlatform.current()
        val home = System.getProperty("user.home")
        val base = when (platform?.os) {
            "windows" -> System.getenv("LOCALAPPDATA")
                ?: System.getenv("APPDATA")
                ?: home?.let { "$it${File.separator}AppData${File.separator}Local" }
            "macos" -> home?.let { "$it${File.separator}Library${File.separator}Caches" }
            else -> System.getenv("XDG_CACHE_HOME") ?: home?.let { "$it${File.separator}.cache" }
        } ?: System.getProperty("java.io.tmpdir")
        base ?: return null
        return File(File(base, "despia"), "ai")
    }
}
