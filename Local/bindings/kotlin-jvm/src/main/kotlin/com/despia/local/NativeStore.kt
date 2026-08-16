// NativeStore.kt - the raw C ABI, one Kotlin declaration per exported symbol.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Nothing above this file knows JNI and nothing below it knows Kotlin. The
// mapping is deliberately one-for-one with despia_local.h so that reading the
// header tells you what this can do: eight symbols, no more, and a ninth would
// have to be added to the header, the export map and the shim before it could
// appear here.
//
// The handle is a jlong rather than a wrapper object because ownership is the
// caller's problem exactly once, in Store, which is the only thing that may hold
// one.

package com.despia.local

import java.io.File

internal object NativeStore {

    /** Where the loader looked, kept for the failure message: a missing native
     *  library is a build problem, and a build problem should say which path it
     *  expected rather than only that something was not found. */
    private val searched = mutableListOf<String>()

    init {
        // Android packages the shim into the APK's jniLibs, where the loader
        // finds it by NAME and a file path would be wrong. Everywhere else it is
        // a build product at a path the build tells us. Trying the name first
        // means one source serves both faces instead of two that agree by
        // inspection.
        var loaded = runCatching { System.loadLibrary("despia_local_jni") }.isSuccess
        if (!loaded) {
            val explicit = System.getProperty("despia.base.native")
            val candidates = buildList {
                if (explicit != null) add(File(explicit))
                add(File(System.getProperty("user.dir"), "build/native"))
            }
            for (dir in candidates) {
                val lib = File(dir, System.mapLibraryName("despia_local_jni"))
                searched.add(lib.path)
                if (!lib.isFile) continue
                System.load(lib.absolutePath)
                loaded = true
                break
            }
        }
        if (!loaded) {
            error("libdespia_local_jni was not found by name or at ${searched.joinToString(", ")}. " +
                "It is a BUILD PRODUCT: the gradle `test` task links it on the JVM face and " +
                "externalNativeBuild packages it on the Android face.")
        }
    }

    external fun abiVersion(): Int
    external fun capabilities(): String?

    external fun open(configJson: String): Long
    external fun close(handle: Long)
    external fun reopen(handle: Long): Int

    /** The result JSON, or null - and null is failure and ONLY failure. */
    external fun call(handle: Long, action: String, argsJson: String): String?

    /** Handle-owned and valid until the next call on that handle; 0 reads the
     *  global open-time error. */
    external fun lastError(handle: Long): String?
}
