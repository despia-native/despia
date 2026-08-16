// Despia Local - the Kotlin/Android face.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The version DERIVES from the package's VERSION file: a literal here is the
// drift, and ai_package_gate.rb fails the build if this line stops deriving.

plugins {
    id("com.android.library")
    kotlin("android")
    `maven-publish`
}

group = "com.despia"
version = file("../../VERSION").readText().trim()

android {
    namespace = "com.despia.local"
    compileSdk = 35
    defaultConfig {
        minSdk = 24
        // Unique .so name, and NO exported sqlite3 symbols. A Despia app can
        // carry a sync vendor that ships its own SQLite; two copies exporting
        // the same symbols is a load-order coin flip. This coexistence is
        // documented rather than discovered.
        ndk { moduleName = "despia_local" }
    }

    // The Kotlin above the seam is SHARED with the JVM face rather than copied.
    // Two faces of one binding that agree only by inspection is exactly the
    // divergence the corpus exists to catch, and the cheapest way not to have it
    // is not to have two files. The JVM lane is where those sources are actually
    // COMPILED AND TESTED on every PR (`gradle test`, 26/26 base fixtures), so
    // this face inherits a tested body and adds only the Android packaging.
    sourceSets {
        getByName("main") {
            kotlin.srcDir("../kotlin-jvm/src/main/kotlin")
        }
    }

    // The engine and the JNI shim, built by the package's own CMakeLists through
    // the wrapper in src/main/jni. Nothing about the recipe is restated here -
    // the export map, the visibility default and the 16 KiB page-size floor come
    // from the package, so the Android .so cannot drift from the one every other
    // lane links.
    externalNativeBuild {
        cmake {
            path = file("src/main/jni/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    // AGP otherwise leaves Java at 1.8 while Kotlin inherits the build JDK
    // (21 in the locked lane), and the plugin refuses the inconsistent AAR.
    // Match the repository's Android libraries at the supported Java 17 floor.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The publishable variant. AGP creates no publishing component unless a
    // build asks for one, and a MavenPublication with no component publishes a
    // POM and nothing else - `<packaging>pom</packaging>`, no AAR in the local
    // repository, and stage_bundle.rb failing at "the aar is missing" AFTER a
    // green preflight. Named `release` because that is the publication and the
    // task the artifact matrix declares. No withSourcesJar(): the stager builds
    // the sources jar itself from the matrix's `sources` roots and verifies the
    // bundle against an exact file inventory, so a second one would be a
    // duplicate the verify step rejects.
    publishing {
        singleVariant("release")
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

publishing {
    publications {
        create<MavenPublication>("release") {
            artifactId = "base"
            // afterEvaluate: AGP registers `components["release"]` during its own
            // afterEvaluate pass, so it does not exist while this block runs.
            afterEvaluate { from(components["release"]) }
            pom {
                name.set("Despia Local")
                description.set("The on-device data plane: SQLite with vectors and snapshots.")
                // The project url Central requires alongside name and description.
                // It points at the MIRROR, because that is the tree a consumer can
                // actually read at the version they resolved.
                url.set("https://github.com/despia-native/despia-local")
                licenses {
                    license {
                        name.set("The Apache License, Version 2.0")
                        url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                    }
                }
                scm { url.set("https://github.com/despia-native/despia-local") }
                // Central requires developer information: at minimum one entry with
                // a name and a way to reach it (an email, or an organization url).
                //
                // THE ENTRY IS THE COMPANY, NOT A PERSON. A POM is immutable once it
                // is on Central: an individual's name and inbox in one outlives that
                // individual's involvement by years, cannot be corrected in place,
                // and collects support mail that was never theirs to answer.
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
    // CI stages registry-neutral bundles; the OPERATOR signs and publishes.
}
