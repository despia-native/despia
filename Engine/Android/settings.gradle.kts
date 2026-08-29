// The Kotlin kernel build — standalone so the OPEN drop builds without ClosedSource.
// ClosedSource/RuntimeAndroid later composes this via includeBuild (the app assembly).
rootProject.name = "despia-engine-android"

pluginManagement {
    repositories {
        google()                // AGP + the Kotlin compose plugin resolve from here
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()                // androidx / Compose artifacts
        mavenCentral()
    }
}

include(":core")        // K1 — pure JVM (the fast local loop; NO android.*)
include(":platform")    // K2 — Android seam wiring (needs the SDK; no Compose)
include(":render")      // K4 — the Compose Stack renderer
include(":glance")      // W3 — the StackLive snapshot dialect's Glance paint backend
// D0 — the desktop build seed: pure JVM, :core verbatim, boot-stamped identity
// (desktop-platforms.md; D1 adds the CMP renderer). MONOREPO-GATED by file presence: its
// build script fans in ClosedSource desktop packages and pins repository-relative QA entry
// paths, so a standalone checkout (the despia-kernel mirror, a `dsx export` vendored kernel)
// has nothing to configure it against — this keeps the first line's standalone promise true.
if (file("../../../ClosedSource/DSX/Modules").isDirectory && file("desktop/build.gradle.kts").isFile) {
    include(":desktop")
}
