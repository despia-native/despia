// Despia AI - the Kotlin/Android face.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The version DERIVES from the package's VERSION file. A literal here is the
// drift: two places to bump means one of them is eventually wrong, and
// ai_package_gate.rb fails the build if this line stops deriving.

plugins {
    id("com.android.library")
    kotlin("android")
    `maven-publish`
}

group = "com.despia"
version = file("../../VERSION").readText().trim()

// ─────────────────────────────────────────────────────────────────────────────
// ONE PRODUCER FOR THE NATIVE
//
// This project is built two ways and they want different payloads, so the
// question it asks is which of the two it is IN, and nothing else.
//
//   · STANDALONE (`gradle publishReleasePublicationToMavenLocal` in this
//     directory - what release/maven/stage_bundle.rb does, and what a consumer
//     cloning the mirror does). Nothing else builds libdespia_ai.so, so this
//     build does: the AAR's payload is the JNI library, exactly as
//     release/maven/artifacts.json describes it.
//   · COMPOSED into an app (`includeBuild` from ClosedSource/RuntimeAndroid).
//     The app ALREADY carries libdespia_ai.so - a Despia module declares the
//     same CMake project in its own dsx.json `build` entry and mounts the
//     result on jniLibs - so building it a second time here would (a) run the
//     NDK over the vendored engines again for no new bytes and (b) put two
//     `lib/<abi>/libdespia_ai.so` into one merge, which fails packaging. The
//     app owns the native; this face contributes the Kotlin.
//
// `gradle.parent` is exactly that question: it is null for a build that is the
// whole build and non-null for one that another build included. Nothing here
// branches on a property someone has to remember to pass.
// ─────────────────────────────────────────────────────────────────────────────
val composed = gradle.parent != null

android {
    namespace = "com.despia.ai"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
        if (!composed) {
            // 16 KiB page alignment is required by Google Play. A library that is
            // not aligned fails a CONSUMER's submission, which is not a first
            // impression worth having, so it is a link flag and not a hope.
            externalNativeBuild {
                cmake {
                    arguments += listOf("-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON")
                    cppFlags += "-std=c++17"
                }
            }
        }
        // The JNI library name is unique across every module in a Despia app:
        // two modules shipping libai.so would collide at load time, and
        // dependencies are linked statically inside so nothing leaks symbols
        // (notably: no exported sqlite3 symbols, so Despiabase and a sync
        // vendor's own SQLite can coexist).
        ndk { moduleName = "despia_ai" }
    }

    if (!composed) {
        externalNativeBuild {
            cmake {
                path = file("../../CMakeLists.txt")
            }
        }
    }

    // THE KOTLIN ABOVE THE SEAM IS SHARED WITH THE JVM FACE RATHER THAN COPIED,
    // the same way the Base package's Android face shares its own. One body is
    // compiled and TESTED on the JVM lane (`gradle test` there drives the real
    // C++ core over JNI and runs the conformance corpus) and packaged twice, so
    // the two faces cannot answer a corpus case differently.
    //
    // THREE FILES ARE EXCLUDED, and each for a structural reason rather than a
    // convenience one. They are the ENGINE SEAM, which is the one thing about
    // this package that is genuinely not the same on the two platforms:
    //
    //   · Native.kt  - the DESKTOP loader. It extracts the library out of a
    //     per-OS Maven CLASSIFIER jar, which is how a plain JAR ships a native
    //     and is not how an APK does; on Android the .so rides inside the app
    //     and System.loadLibrary finds it. It also uses java.nio.file.Files and
    //     ProcessHandle - API 26 and later against this library's minSdk 24 -
    //     so sharing it would compile here and throw on a device, which is the
    //     one outcome worse than not shipping it.
    //   · Engine.kt  - declares `com.despia.ai.NativeEngine` and
    //     `com.despia.ai.EventListener`. The ABI's JNI layer registers against
    //     that exact class name (Java_com_despia_ai_NativeEngine_*), so the app
    //     that OWNS the .so declares them, and an AAR carrying a second copy
    //     would put one JVM class in a dex twice. It follows Native.kt anyway:
    //     it is that loader's only caller.
    //   · Host.kt    - the conformance REFERENCE host. It drives Engine, so it
    //     goes where Engine goes; the corpus runs on the JVM lane.
    //
    // What ships here is therefore the POLICY half - the catalog synthesis, the
    // fit function, the router, the four delivery locks and the JSON they speak
    // - which is platform-neutral by construction and is what a consumer above
    // the seam actually calls.
    sourceSets {
        getByName("main") {
            kotlin.srcDir("../kotlin-jvm/src/main/kotlin")
        }
    }

    // Java and Kotlin must agree on the bytecode they emit or the Kotlin plugin
    // refuses the build outright ("Inconsistent JVM-target compatibility"): AGP
    // defaults Java to 1.8 and Kotlin follows the running JDK. 17 is what every
    // other Android library in this repository pins (the kernel's :platform,
    // :render and :glance), so a consumer never meets two answers.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Lint scans the whole external Kotlin root even though Kotlin's source-set
    // exclude below removes the desktop loader from the AAR. Scope the minSdk
    // exception to that one proven-unshipped file; all packaged sources remain gated.
    lint { lintConfig = file("lint.xml") }

    publishing {
        singleVariant("release")
    }
}

// The exclusion has to be stated on KOTLIN's own source set, not on AGP's Java
// bridge: filtering the bridge leaves the Kotlin compiler with the unfiltered
// roots and the excluded files compile anyway (the same lesson the app build
// records above its module srcDirs).
kotlin {
    sourceSets.getByName("main").kotlin.exclude(
        "**/Native.kt",
        "**/Engine.kt",
        "**/Host.kt",
    )
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

publishing {
    publications {
        create<MavenPublication>("release") {
            artifactId = "ai"
            // afterEvaluate: AGP registers `components["release"]` during its own
            // afterEvaluate pass, so it does not exist while this block runs.
            // Without a component the publication is a POM and nothing else, and
            // stage_bundle.rb fails at "the aar is missing" AFTER a green
            // preflight. No withSourcesJar(): the stager builds the sources jar
            // itself and verifies the bundle against an exact file inventory.
            afterEvaluate { from(components["release"]) }
            pom {
                name.set("Despia AI")
                description.set("On-device inference: completions, streaming, tools, speech, vision.")
                // The project url Central requires alongside name and description.
                // It points at the MIRROR, because that is the tree a consumer can
                // actually read at the version they resolved: the monorepo path is
                // not public and a marketing page is not "more, human readable,
                // information" about this artifact.
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
                // THE ENTRY IS THE COMPANY, NOT A PERSON, and that is a decision
                // rather than an omission. A POM is immutable once it is on Central:
                // an individual's name and inbox in one outlives that individual's
                // involvement by years, cannot be corrected in place, and collects
                // support mail that was never theirs to answer. The organisation is
                // the honest maintainer of a company package, and support@ is a
                // mailbox that survives a departure.
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
