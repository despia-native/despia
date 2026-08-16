// Despia Local - com.despia:local-jvm.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The version DERIVES from the package VERSION file; a literal here is the drift.
//
// NO third-party dependencies at runtime. The package ships its own JSON for the
// same reason the C++ core does: a JSON library would need a pin, a NOTICE line,
// an SBOM component and a CVE watch, and what crosses this seam is one
// well-known document shape.
//
// P·c decided the artifact matrix: an AAR cannot serve Compose Desktop or a
// server-side consumer, so this is a SECOND designed artifact beside the Android
// face rather than an afterthought - and the corpus is the reason it earns its
// keep, because a second runner over the same fixtures is what catches a
// divergence that one runner hides.

plugins {
    kotlin("jvm") version "2.3.21"
}

group = "com.despia"
version = file("../../VERSION").readText().trim()

repositories { mavenCentral() }

dependencies {
    testImplementation(kotlin("test"))
}

kotlin { jvmToolchain(21) }

val packageRoot = file("../..")
val nativeDir = layout.buildDirectory.dir("native")
val cmakeDir = layout.buildDirectory.dir("native/cmake")

val isMac = System.getProperty("os.name").lowercase().contains("mac")
val sharedSuffix = if (isMac) "dylib" else "so"
val loaderPath = if (isMac) "@loader_path" else "\$ORIGIN"

// 1. The REAL library, built by the package's own CMakeLists with the export map
//    applied. Nothing about this lane is special-cased in it: this is the same
//    libdespia_local the phone lanes link, which is the point - a binding that
//    built its own private variant would prove nothing about the shipped one.
val cmakeConfigure by tasks.registering(Exec::class) {
    val out = cmakeDir.get().asFile
    doFirst { out.mkdirs() }
    inputs.file(packageRoot.resolve("CMakeLists.txt"))
    commandLine(
        "cmake", "-S", packageRoot.path, "-B", out.path,
        "-DDESPIA_LOCAL_BUILD_TESTS=OFF", "-DDESPIA_LOCAL_VEC=ON",
        "-DCMAKE_BUILD_TYPE=Release",
    )
}

val cmakeBuild by tasks.registering(Exec::class) {
    dependsOn(cmakeConfigure)
    inputs.dir(packageRoot.resolve("engine"))
    inputs.dir(packageRoot.resolve("vendor"))
    outputs.file(cmakeDir.map { it.file("libdespia_local.$sharedSuffix") })
    commandLine("cmake", "--build", cmakeDir.get().asFile.path, "-j")
}

// The engine library sits beside the shim so a $ORIGIN/@loader_path rpath finds
// it: the JVM opens the shim, and the dynamic linker pulls its dependency from
// the same directory without an absolute path baked into anything.
val stageEngine by tasks.registering(Copy::class) {
    dependsOn(cmakeBuild)
    from(cmakeDir.map { it.file("libdespia_local.$sharedSuffix") })
    into(nativeDir)
}

// 2. The shim, linked against the SHARED library rather than compiled with the
//    engine sources. That is deliberate and load-bearing: this translation unit
//    can only reach the eight symbols the export map lets out, so a binding that
//    started depending on a ninth would fail to LINK instead of quietly widening
//    the surface that keeps a sync vendor's own SQLite out of our way.
val buildJni by tasks.registering(Exec::class) {
    dependsOn(stageEngine)
    val out = nativeDir.get().asFile
    val javaHome = System.getProperty("java.home")
    val shim = file("src/main/jni/despia_local_jni.cpp")
    doFirst { out.mkdirs() }
    inputs.file(shim)
    inputs.file(packageRoot.resolve("engine/include/despia_local.h"))
    outputs.file(File(out, "libdespia_local_jni.$sharedSuffix"))
    commandLine(
        buildList {
            addAll(listOf("clang++", "-std=c++17", "-shared", "-fPIC", "-O1"))
            addAll(listOf("-I$javaHome/include", "-I$javaHome/include/linux", "-I$javaHome/include/darwin"))
            add("-I" + packageRoot.resolve("engine/include").path)
            add(shim.path)
            addAll(listOf("-L" + out.path, "-ldespia_local"))
            add("-Wl,-rpath,$loaderPath")
            addAll(listOf("-o", File(out, "libdespia_local_jni.$sharedSuffix").path))
        }
    )
}

tasks.test {
    dependsOn(buildJni)
    systemProperty("despia.base.native", nativeDir.get().asFile.absolutePath)
    useJUnitPlatform()
    testLogging { showStandardStreams = true }
}
