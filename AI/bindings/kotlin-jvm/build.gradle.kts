// Despia AI - com.despia:ai-jvm.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The version DERIVES from the package VERSION file; a literal here is the drift.
//
// NO third-party dependencies at runtime. The package ships its own JSON for the
// same reason the C++ core does: a JSON library would need a pin, a NOTICE line,
// an SBOM component and a CVE watch, and this reads exactly one document shape.
//
// THE ARTIFACT SHAPE (P·c). An AAR cannot serve Compose Desktop or a server-side
// JVM, so `com.despia:ai-jvm` is a second DESIGNED artifact, not a repackaging:
// a plain JAR of classes, plus one jar per OS carrying that OS's native under a
// Maven CLASSIFIER. A consumer declares the plain artifact and whichever
// classifiers it ships for; the loader (Native.kt) finds whatever is on the
// classpath and answers a typed absence for whatever is not.
//
// TWO NATIVES ARE BUILT HERE AND THEY ARE DIFFERENT THINGS.
//
//   · the TEST native - mock backends only (-DDESPIA_AI_LLAMA=OFF
//     -DDESPIA_AI_WHISPER=OFF), which is what the corpus needs and all it needs.
//     Seconds to build, so `gradle test` stays a loop and not an errand.
//   · the SHIPPING native - the full core, llama + whisper + mock, staged into
//     the classifier jar.
//
// Both are built by the package's OWN CMakeLists with -DDESPIA_AI_JNI=ON. That
// is the point of routing even the cheap one through cmake: the artifact the
// tests load is linked exactly like the artifact that ships - same export map,
// same warning wall, same library NAME - so a linkage bug cannot hide until
// release day. The library is `despia_ai` in both, because the JNI door is
// compiled INTO it rather than into a second .so beside it.

import java.security.MessageDigest
import java.time.Duration
import org.gradle.internal.os.OperatingSystem

plugins {
    kotlin("jvm") version "2.3.21"
    `maven-publish`
}

group = "com.despia"
version = file("../../VERSION").readText().trim()

repositories { mavenCentral() }

dependencies {
    testImplementation(kotlin("test"))
}

kotlin { jvmToolchain(21) }

val packageRoot = file("../..")

// ──────────────────────────────────────────────────────────────────────────────
// The host platform, in the CLASSIFIER vocabulary
//
// The same normalization Native.kt performs at runtime, because a build script
// cannot call into the classes it is compiling. Keep the two in step: the jar
// coordinate, the resource path and the cache directory all spell the platform
// this way, and a disagreement here shows up as "engine_absent" on a machine
// that has the native sitting right there.
// ──────────────────────────────────────────────────────────────────────────────

val hostOs: String = System.getProperty("os.name").lowercase().let {
    when {
        it.startsWith("windows") -> "windows"
        it.startsWith("mac") || it.contains("darwin") -> "macos"
        it.startsWith("linux") -> "linux"
        else -> error("com.despia:ai-jvm has no classifier for os.name=${System.getProperty("os.name")}")
    }
}

val hostArch: String = when (System.getProperty("os.arch").lowercase()) {
    "amd64", "x86_64", "x64" -> "x64"
    "aarch64", "arm64" -> "arm64"
    else -> error("com.despia:ai-jvm has no classifier for os.arch=${System.getProperty("os.arch")}")
}

val hostClassifier = "$hostOs-$hostArch"

val hostLibrary = when (hostOs) {
    "windows" -> "despia_ai.dll"
    "macos" -> "libdespia_ai.dylib"
    else -> "libdespia_ai.so"
}

// ──────────────────────────────────────────────────────────────────────────────
// cmake
//
// Searched rather than assumed: the release lanes have it on PATH, and the
// Android lanes have the SDK's copy under $ANDROID_HOME/cmake/<version>/bin.
// A lane with neither gets cmake's own "command not found", which is a better
// error than a build script pretending to know why.
// ──────────────────────────────────────────────────────────────────────────────

val cmakeExecutable: String = run {
    val exe = if (OperatingSystem.current().isWindows) "cmake.exe" else "cmake"
    fun usable(f: File?) = f != null && f.isFile && f.canExecute()

    System.getenv("CMAKE")?.let { if (usable(File(it))) return@run it }
    System.getenv("PATH").orEmpty().split(File.pathSeparator)
        .map { File(it, exe) }.firstOrNull { usable(it) }?.let { return@run it.absolutePath }
    (System.getenv("ANDROID_HOME") ?: System.getenv("ANDROID_SDK_ROOT"))?.let { sdk ->
        File(sdk, "cmake").listFiles()?.sortedByDescending { it.name }?.forEach { home ->
            val candidate = File(home, "bin/$exe")
            if (usable(candidate)) return@run candidate.absolutePath
        }
    }
    exe
}

/** JNI headers belong to a development JDK. Android Studio may launch Gradle
 *  with its runtime-only JBR, which has a Java 21 VM but deliberately carries
 *  no `include/jni.h`. Prefer the launcher when it is a full JDK, then the
 *  standard Homebrew Java 21 locations used by macOS release hosts. CMake still
 *  performs its normal discovery when none of these exists. */
val jniIncludeDirs: String? = run {
    val homes = listOfNotNull(
        System.getenv("JAVA_HOME")?.takeIf { it.isNotBlank() }?.let(::File),
        System.getProperty("java.home")?.takeIf { it.isNotBlank() }?.let(::File),
        File("/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"),
        File("/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"),
    ).distinctBy { it.absolutePath }
    homes.firstOrNull { File(it, "include/jni.h").isFile }?.let { home ->
        listOf("include", "include/linux", "include/darwin", "include/win32")
            .map { File(home, it) }
            .filter { it.isDirectory }
            .joinToString(";") { it.absolutePath }
    }
}

/** The cmake configure arguments both natives share. */
fun configureArgs(buildDir: File, outputDir: File, backends: Boolean): List<String> {
    val flag = { on: Boolean -> if (on) "ON" else "OFF" }
    return buildList {
        addAll(listOf(
        cmakeExecutable,
        "-S", packageRoot.absolutePath,
        "-B", buildDir.absolutePath,
        "-DCMAKE_BUILD_TYPE=Release",
        "-DDESPIA_AI_JNI=ON",
        "-DDESPIA_AI_BUILD_TESTS=OFF",
        "-DDESPIA_AI_LLAMA=${flag(backends)}",
        "-DDESPIA_AI_WHISPER=${flag(backends)}",
        // A .dll is a RUNTIME artifact and a .so/.dylib is a LIBRARY one, and a
        // multi-config generator appends the config name unless the per-config
        // variable is set too. All four, so the file lands in one known place on
        // every generator this package is built with.
        "-DCMAKE_LIBRARY_OUTPUT_DIRECTORY=${outputDir.absolutePath}",
        "-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${outputDir.absolutePath}",
        "-DCMAKE_LIBRARY_OUTPUT_DIRECTORY_RELEASE=${outputDir.absolutePath}",
        "-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${outputDir.absolutePath}",
        ))
        jniIncludeDirs?.let { add("-DDESPIA_AI_JNI_INCLUDE_DIRS=$it") }
    }
}

fun buildArgs(buildDir: File): List<String> = listOf(
    cmakeExecutable, "--build", buildDir.absolutePath,
    "--config", "Release",
    "--parallel", Runtime.getRuntime().availableProcessors().toString(),
)

// ──────────────────────────────────────────────────────────────────────────────
// The TEST native - mock backends only
//
// The Kotlin lane loads the REAL C++ MockEngine through the real C ABI. There is
// no Kotlin port of the mock and there must not be one: a second native mock is
// a second thing to keep honest, and the corpus exists precisely so the lanes
// cannot drift.
// ──────────────────────────────────────────────────────────────────────────────

val testNativeDir = layout.buildDirectory.dir("native")
val testNativeBuild = layout.buildDirectory.dir("cmake/test")

val configureTestNative by tasks.registering(Exec::class) {
    val out = testNativeDir.get().asFile
    val work = testNativeBuild.get().asFile
    doFirst { out.mkdirs(); work.mkdirs() }
    commandLine(configureArgs(work, out, backends = false))
}

val buildTestNative by tasks.registering(Exec::class) {
    dependsOn(configureTestNative)
    inputs.dir(packageRoot.resolve("engine"))
    inputs.dir(packageRoot.resolve("mock"))
    inputs.dir(packageRoot.resolve("bindings/jni"))
    inputs.file(packageRoot.resolve("CMakeLists.txt"))
    outputs.file(testNativeDir.map { it.file(hostLibrary) })
    commandLine(buildArgs(testNativeBuild.get().asFile))
}

// The G2P corpus is driven by the native frontend itself.  It is header-only,
// so building its strict corpus runner directly keeps the JVM loop small while
// making the 63 shared cases a required part of `test` instead of a platform
// skip.  Missing C++ tooling is a failing build, as it is for the JNI native.
val g2pCorpusBinary = layout.buildDirectory.file(
    if (hostOs == "windows") "g2p/g2p_corpus.exe" else "g2p/g2p_corpus"
)
val g2pCompiler = System.getenv("CXX")?.takeIf { it.isNotBlank() }
    ?: if (hostOs == "windows") "clang++.exe" else "c++"

val buildG2pCorpus by tasks.registering(Exec::class) {
    val source = packageRoot.resolve("engine/test/g2p_corpus.cpp")
    val output = g2pCorpusBinary.get().asFile
    inputs.file(source)
    inputs.file(packageRoot.resolve("engine/src/json.hpp"))
    inputs.dir(packageRoot.resolve("engine/src/backends/g2p"))
    outputs.file(output)
    doFirst { output.parentFile.mkdirs() }
    commandLine(g2pCompiler, "-std=c++17", "-O1", "-Wall", "-Wextra",
        "-o", output.absolutePath, source.absolutePath)
}

// ──────────────────────────────────────────────────────────────────────────────
// The SHIPPING native - the full core, staged for its classifier jar
// ──────────────────────────────────────────────────────────────────────────────

val stageDir = layout.buildDirectory.dir("natives/$hostClassifier")
val shipNativeBuild = layout.buildDirectory.dir("cmake/ship")

val configureShipNative by tasks.registering(Exec::class) {
    val out = stageDir.get().asFile
    val work = shipNativeBuild.get().asFile
    doFirst { out.mkdirs(); work.mkdirs() }
    commandLine(configureArgs(work, out, backends = true))
}

val buildShipNative by tasks.registering(Exec::class) {
    dependsOn(configureShipNative)
    inputs.dir(packageRoot.resolve("engine"))
    inputs.dir(packageRoot.resolve("mock"))
    inputs.dir(packageRoot.resolve("bindings/jni"))
    inputs.file(packageRoot.resolve("CMakeLists.txt"))
    outputs.file(stageDir.map { it.file(hostLibrary) })
    commandLine(buildArgs(shipNativeBuild.get().asFile))
}

/**
 * The digest the loader checks the extracted copy against. Written by the BUILD
 * so nothing has to be kept in step by hand: the loader compares the bytes it
 * unpacked to the bytes this task measured, and a same-version rebuild is
 * therefore never served out of a stale cache directory.
 */
val stampShipNative by tasks.registering {
    dependsOn(buildShipNative)
    val library = stageDir.map { it.file(hostLibrary) }
    val digestFile = stageDir.map { it.file("$hostLibrary.sha256") }
    outputs.file(digestFile)
    doLast {
        val bytes = library.get().asFile.readBytes()
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        digestFile.get().asFile.writeText(digest.joinToString("") { byte -> "%02x".format(byte) })
    }
}

// The classes jar and the native jar are a PAIR and read as one: same base name,
// same version, one classifier apart. The published coordinate is
// `com.despia:ai-jvm` either way - the publication renames both.
val nativeJar by tasks.registering(Jar::class) {
    dependsOn(stampShipNative)
    archiveClassifier.set(hostClassifier)
    from(stageDir) { into("com/despia/ai/natives/$hostClassifier") }
}

// ──────────────────────────────────────────────────────────────────────────────
// The version stamp
//
// The loader's cache key LEADS with this string, so it cannot be a literal in
// Kotlin any more than the coordinate above can: two places to bump means one of
// them eventually serves an old native to new classes.
// ──────────────────────────────────────────────────────────────────────────────

val versionStampDir = layout.buildDirectory.dir("generated/version")

val stampVersion by tasks.registering {
    val out = versionStampDir.get().asFile
    val text = version.toString()
    inputs.property("version", text)
    outputs.dir(out)
    doLast {
        val file = File(out, "com/despia/ai/version.txt")
        file.parentFile.mkdirs()
        file.writeText(text)
    }
}

sourceSets.named("main") { resources.srcDir(stampVersion) }

// Kotlin's diagnostic task normally reports its clean state as `SKIPPED`.
// This repository treats every skip token in a required lane as a blocker, so
// execute the task even when its diagnostics set is empty. Its original action
// still fails the build when the plugin records an actual configuration error.
tasks.named("checkKotlinGradlePluginConfigurationErrors") {
    setOnlyIf("required conformance lanes execute every scheduled check") { true }
}

// ──────────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// The live-weights lane
//
// The corpus proves the binding against the MockEngine, which is deterministic
// and identical on three runners and cannot tell anybody whether a REAL
// generation survives the trip: hundreds of small events, arriving over minutes,
// from a thread the JVM did not create. That claim needs actual weights, and
// actual weights are hundreds of megabytes that no CI runner has.
//
// So it is its own explicit task, and the two halves are conditional in DIFFERENT ways,
// which is the whole design:
//
//   · the full native (llama on) is only built when a model is actually on
//     disk, because `gradle test` staying a loop matters more than a lane
//     nobody can run;
//   · when the TASK is explicitly invoked it always runs. When there is no
//     model the case prints the reason it declined and passes. It is not part of
//     `test`: repository conformance cannot manufacture external model evidence,
//     and an optional smoke must not introduce a skip into the required lane.
// ──────────────────────────────────────────────────────────────────────────────

/** Where the live model is, in the order the test itself looks. */
val liveModel: File = File(
    (project.findProperty("despia.ai.model") as String?)
        ?: System.getProperty("despia.ai.model")
        ?: System.getenv("DESPIA_AI_MODEL")
        ?: "/tmp/models/gemma-3-1b-it-Q4_K_M.gguf",
)
val liveModelPresent = liveModel.isFile

val liveTest by tasks.registering(Test::class) {
    group = "verification"
    description = "Runs the real-weights case against the full native. Declines loudly without a model."
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    filter { includeTestsMatching("com.despia.ai.RealModelTest") }

    // The full native when there is something to run against it, and the cheap
    // mock-only one otherwise - so the task still starts, and the case still
    // gets to say out loud why it is declining.
    val nativeDir = if (liveModelPresent) stageDir.get().asFile else testNativeDir.get().asFile
    dependsOn(if (liveModelPresent) buildShipNative else buildTestNative)
    systemProperty("despia.ai.native", nativeDir.absolutePath)
    systemProperty("despia.ai.cache", layout.buildDirectory.dir("native-cache").get().asFile.absolutePath)
    systemProperty("despia.ai.model", liveModel.absolutePath)
    // A real generation is not a five-second affair, and neither is mapping a
    // multi-gigabyte file the first time.
    timeout.set(Duration.ofMinutes(20))
    useJUnitPlatform()
    testLogging { showStandardStreams = true }
    outputs.upToDateWhen { false }
}

tasks.test {
    dependsOn(buildTestNative, buildG2pCorpus)
    systemProperty("despia.ai.native", testNativeDir.get().asFile.absolutePath)
    systemProperty("despia.ai.g2p.corpus", g2pCorpusBinary.get().asFile.absolutePath)
    // The loader's cache is a USER-level directory in production. A test run
    // must not write into one, and must not read a previous release out of one.
    systemProperty("despia.ai.cache", layout.buildDirectory.dir("native-cache").get().asFile.absolutePath)
    // The mock-only native carries no gguf engine, so the real-weights case
    // belongs to the explicit liveTest task, either for real or declining out
    // loud when an operator invokes it without the digest-pinned model.
    filter { excludeTestsMatching("com.despia.ai.RealModelTest") }
    // The JVM's own audit of the seam. A binding is exactly the place where a
    // wrong ref, a stale local, or a string that is not valid where the runtime
    // thinks it is buys silence on one machine and a crash on another - and the
    // serious findings are fatal here, so this is a gate and not a report.
    jvmArgs("-Xcheck:jni")
    useJUnitPlatform()
    testLogging { showStandardStreams = true }
}

publishing {
    publications {
        create<MavenPublication>("jvm") {
            artifactId = "ai-jvm"
            from(components["java"])
            // One classifier per OS, produced by the lane running ON that OS.
            // Cross-building a JNI native is not a thing this package pretends
            // to do: the runner that builds windows-x64 is a Windows runner.
            artifact(nativeJar)
            pom {
                name.set("Despia AI (JVM)")
                description.set(
                    "On-device inference for desktop and server JVMs: completions, streaming, " +
                        "tools, speech, vision."
                )
                // The project url Central requires alongside name and description.
                // It points at the MIRROR, because that is the tree a consumer can
                // actually read at the version they resolved.
                url.set("https://github.com/despia-native/despia-ai")
                licenses {
                    license {
                        name.set("The Apache License, Version 2.0")
                        url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                    }
                }
                scm {
                    url.set("https://github.com/despia-native/despia-ai")
                }
                // Central requires developer information: at minimum one entry with
                // a name and a way to reach it (an email, or an organization url).
                //
                // THE ENTRY IS THE COMPANY, NOT A PERSON. A POM is immutable once it
                // is on Central: an individual's name and inbox in one outlives that
                // individual's involvement by years, cannot be corrected in place,
                // and collects support mail that was never theirs to answer. Kept
                // identical to the Android face's block - two faces of one package
                // must not disagree about who publishes them.
                developers {
                    developer {
                        id.set("despia")
                        name.set("Despia")
                        email.set("support@despia.com")
                        organization.set("Despia LLC-FZ")
                        organizationUrl.set("https://despia.com")
                    }
                }
            }
        }
    }
    // No remote repository, no signing config, no credentials, and no publish
    // task in CI. CI stages registry-neutral bundles; the OPERATOR signs and
    // uploads with 2FA from a machine that holds the key.
}
