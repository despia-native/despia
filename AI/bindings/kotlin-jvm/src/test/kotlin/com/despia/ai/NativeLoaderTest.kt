// NativeLoaderTest.kt - the desktop loader's two promises, proved.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The loader (Native.kt) exists to prevent two failures, and a comment claiming
// it does is worth nothing, so both are driven here against the real resolution
// function:
//
//   · a native this build does not carry for the running platform answers a
//     TYPED ABSENCE - the corpus's `not_available` shape, with a reason and the
//     platform named - rather than an UnsatisfiedLinkError with a path in it.
//     Driven on a platform this machine is not, with an empty classpath.
//
//   · the extract cache is keyed on the PACKAGE VERSION, so an upgrade cannot
//     read the previous install's bytes. Driven by extracting two different
//     libraries under two versions and reading both back.
//
// The tests print the absence they got. A reason that reads badly is a bug in
// the reason, and it is only visible if somebody has to look at it.

package com.despia.ai

import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.fail

/** A classpath that carries exactly what a case says it carries. */
private class MemorySource(private val entries: Map<String, ByteArray>) : NativeSource {
    override fun exists(path: String): Boolean = entries.containsKey(path)
    override fun size(path: String): Long? = entries[path]?.size?.toLong()
    override fun open(path: String): InputStream? = entries[path]?.let { ByteArrayInputStream(it) }
}

private fun sha256(bytes: ByteArray): String =
    java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

private fun <T> withTempDir(block: (File) -> T): T {
    val dir = Files.createTempDirectory("despia-ai-loader").toFile()
    try {
        return block(dir)
    } finally {
        dir.deleteRecursively()
    }
}

private fun absent(resolution: NativeResolution, what: String): NativeResolution.Absent =
    when (resolution) {
        is NativeResolution.Absent -> resolution
        is NativeResolution.Present -> fail("$what resolved to ${resolution.file} instead of an absence")
    }

private fun present(resolution: NativeResolution, what: String): NativeResolution.Present =
    when (resolution) {
        is NativeResolution.Present -> resolution
        is NativeResolution.Absent -> fail("$what answered ${resolution.toJson().render()}")
    }

class NativeLoaderTest {

    // --- typed absence ----------------------------------------------------

    @Test
    fun `a platform this build carries no native for answers a typed absence`() {
        val windows = NativePlatform.of("Windows 11", "amd64")
            ?: fail("windows-x64 is a classifier this package names")

        val resolution = Native.resolve(
            platform = windows,
            version = "0.1.0",
            explicitDir = null,
            cacheRoot = File("/nonexistent-cache-that-is-never-touched"),
            source = MemorySource(emptyMap()),
        )
        val answer = absent(resolution, "a missing windows-x64 native")

        println("[typed absence] ${answer.message()}")
        println("[typed absence] ${answer.toJson().render()}")

        if (answer.code != "not_available") fail("code ${answer.code}, expected not_available")
        if (answer.reason != "engine_absent") fail("reason ${answer.reason}, expected engine_absent")
        if (answer.data["platform"].string() != "windows-x64") {
            fail("the absence does not name the platform: ${answer.toJson().render()}")
        }
        // The answer has to be actionable: the coordinate that would fix it.
        if (answer.data["artifact"].string() != "com.despia:ai-jvm:0.1.0:windows-x64") {
            fail("the absence does not name the artifact: ${answer.toJson().render()}")
        }
        if (answer.data["searched"].strings().none { it.contains("windows-x64") }) {
            fail("the absence does not say where it looked: ${answer.toJson().render()}")
        }
    }

    @Test
    fun `an os this package names no classifier for is its own reason`() {
        // Not the same failure as a missing artifact, and not the same fix: one
        // is "add the classifier jar", the other is "there is no build for you".
        if (NativePlatform.of("SunOS", "sparcv9") != null) fail("sparc is not a classifier")

        val answer = absent(
            Native.resolve(
                platform = null,
                version = "0.1.0",
                explicitDir = null,
                cacheRoot = File("/nonexistent-cache-that-is-never-touched"),
                source = MemorySource(emptyMap()),
            ),
            "an unnamed platform",
        )
        println("[typed absence] ${answer.toJson().render()}")
        if (answer.reason != "unsupported_platform") fail("reason ${answer.reason}")
        if (answer.data["known"].strings().isEmpty()) fail("the absence lists no known classifiers")
    }

    @Test
    fun `an explicit directory with no library in it blames the directory`() = withTempDir { dir ->
        val answer = absent(
            Native.resolve(
                platform = NativePlatform.of("Linux", "amd64"),
                version = "0.1.0",
                explicitDir = dir,
                cacheRoot = dir,
                source = MemorySource(emptyMap()),
            ),
            "an empty explicit directory",
        )
        println("[typed absence] ${answer.toJson().render()}")
        if (answer.reason != "native_missing") fail("reason ${answer.reason}, expected native_missing")
        if (answer.data["property"].string() != "despia.ai.native") {
            fail("the absence does not name the property that was set: ${answer.toJson().render()}")
        }
    }

    @Test
    fun `a build with no version stamp refuses to key a cache`() = withTempDir { dir ->
        // Serving from an unversioned key is the exact failure the version key
        // exists to prevent, so the loader declines rather than inventing one.
        val linux = NativePlatform.of("Linux", "amd64")!!
        val answer = absent(
            Native.resolve(
                platform = linux,
                version = null,
                explicitDir = null,
                cacheRoot = dir,
                source = MemorySource(mapOf(linux.resourcePath to "bytes".toByteArray())),
            ),
            "a build with no version stamp",
        )
        println("[typed absence] ${answer.toJson().render()}")
        if (answer.reason != "version_unknown") fail("reason ${answer.reason}")
    }

    // --- the version-keyed cache -----------------------------------------

    @Test
    fun `the extract cache is keyed on the package version`() = withTempDir { cache ->
        val linux = NativePlatform.of("Linux", "x86_64")!!
        val old = "the 0.1.0 native".toByteArray()
        val new = "the 0.2.0 native, which is a different library".toByteArray()

        fun resolveAt(version: String, bytes: ByteArray) = Native.resolve(
            platform = linux,
            version = version,
            explicitDir = null,
            cacheRoot = cache,
            source = MemorySource(mapOf(
                linux.resourcePath to bytes,
                "${linux.resourcePath}.sha256" to sha256(bytes).toByteArray(),
            )),
        )

        val first = present(resolveAt("0.1.0", old), "0.1.0")
        if (first.origin != "extracted") fail("the first resolution should extract, not ${first.origin}")
        if (!first.file.readBytes().contentEquals(old)) fail("0.1.0 extracted the wrong bytes")

        // The upgrade. Same classifier, same file name, different version - and
        // it must not read what 0.1.0 left behind.
        val second = present(resolveAt("0.2.0", new), "0.2.0")
        if (second.origin != "extracted") fail("the upgrade should extract, not ${second.origin}")
        if (!second.file.readBytes().contentEquals(new)) {
            fail("0.2.0 was served ${second.file.readBytes().size} stale bytes from ${second.file}")
        }
        if (second.file.absolutePath == first.file.absolutePath) {
            fail("both versions cached to one path: ${second.file}")
        }
        if (!second.file.absolutePath.contains("0.2.0")) {
            fail("the cache path does not carry the version: ${second.file}")
        }

        // And the downgrade, which is the same bug in the other direction.
        val back = present(resolveAt("0.1.0", old), "0.1.0 again")
        if (!back.file.readBytes().contentEquals(old)) fail("0.1.0 was served 0.2.0's bytes")

        println("[cache] 0.1.0 -> ${first.file}")
        println("[cache] 0.2.0 -> ${second.file}")
    }

    @Test
    fun `an extracted native is reused rather than unpacked again`() = withTempDir { cache ->
        val linux = NativePlatform.of("Linux", "amd64")!!
        val bytes = "a native".toByteArray()
        val source = MemorySource(mapOf(
            linux.resourcePath to bytes,
            "${linux.resourcePath}.sha256" to sha256(bytes).toByteArray(),
        ))
        fun once() = Native.resolve(linux, "0.1.0", null, cache, source)

        if (present(once(), "the first run").origin != "extracted") fail("the first run must extract")
        val second = present(once(), "the second run")
        if (second.origin != "cache") fail("the second run re-extracted (origin ${second.origin})")
    }

    @Test
    fun `bytes that do not match the recorded digest are refused`() = withTempDir { cache ->
        val linux = NativePlatform.of("Linux", "amd64")!!
        val answer = absent(
            Native.resolve(
                platform = linux,
                version = "0.1.0",
                explicitDir = null,
                cacheRoot = cache,
                source = MemorySource(mapOf(
                    linux.resourcePath to "not what the build measured".toByteArray(),
                    "${linux.resourcePath}.sha256" to sha256("what the build measured".toByteArray()).toByteArray(),
                )),
            ),
            "a native whose bytes do not match its digest",
        )
        println("[typed absence] ${answer.toJson().render()}")
        if (answer.reason != "digest_mismatch") fail("reason ${answer.reason}")
        if (File(File(cache, "0.1.0"), "${linux.classifier}/${linux.libraryFileName}").exists()) {
            fail("a native that failed its digest was left in the cache")
        }
    }

    // --- the real thing ---------------------------------------------------

    @Test
    fun `the running build carries its version stamp and its native`() {
        // The build wiring, end to end: the version resource the cache key is
        // built from is really on the classpath, and the loader really loaded
        // the library the rest of this suite drives.
        val version = Native.version() ?: fail("com/despia/ai/version.txt is not on the classpath")
        if (!version.matches(Regex("""\d+\.\d+\.\d+.*"""))) fail("the version stamp reads $version")

        when (val availability = Engine.availability()) {
            is NativeResolution.Present -> println("[native] $version from ${availability.origin}: ${availability.file}")
            is NativeResolution.Absent -> fail("the test native is absent: ${availability.toJson().render()}")
        }
    }

    @Test
    fun `every classifier this loader names has a library file name`() {
        for (classifier in NativePlatform.KNOWN) {
            val (os, arch) = classifier.split("-", limit = 2).let { it[0] to it[1] }
            val platform = NativePlatform(os, arch)
            if (platform.classifier != classifier) fail("$classifier does not round-trip")
            val expected = when (os) {
                "windows" -> "despia_ai.dll"
                "macos" -> "libdespia_ai.dylib"
                else -> "libdespia_ai.so"
            }
            if (platform.libraryFileName != expected) {
                fail("$classifier maps to ${platform.libraryFileName}, expected $expected")
            }
            if (!platform.resourcePath.endsWith("$classifier/$expected")) {
                fail("$classifier resolves to ${platform.resourcePath}")
            }
        }
    }
}
