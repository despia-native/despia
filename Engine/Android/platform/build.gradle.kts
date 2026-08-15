// :platform — K2: the Android half of the kernel seams (Context/bus wiring, dsx.fetch
// via OkHttp, generated ModuleRegistry, AppManifest env detection, DSXBoot/BootGate,
// DSXScreen). Everything here WIRES the pure-JVM :core seams to real Android services —
// no kernel logic lives here, and NO Compose (UI is :render's job).
// compileSdk 36 / minSdk 24 — one compileSdk across the composite (the app assembly
// moved to 36 for the PowerSync SDK's AAR floor; the AGP 8.13.x pairing).
plugins {
    id("com.android.library")
    kotlin("android")
}

android {
    namespace = "despia.engine.platform"
    compileSdk = 36
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    api(project(":core"))   // the kernel: modules downstream see despia.engine through us
    // One production HTTP stack for dsx.fetch, author fetch(), <api>, and dsx.content.
    // The closed runtime already pins this coordinate for WebSocket; keeping the same
    // version avoids a second OkHttp/Okio line in composed applications.
    implementation("com.squareup.okhttp3:okhttp:5.3.2")
    // Used directly for API-24-safe Base64 in container/blob envelopes. Pin the exact
    // line OkHttp 5.3.2 resolves so this declaration cannot split the transport graph.
    implementation("com.squareup.okio:okio:3.16.4")
    testImplementation("junit:junit:4.13.2")   // plain-JVM units (fake SharedPreferences over the pure interface — the :render precedent)
    // JVM/Android-compatible loopback server for transport and incremental SSE tests.
    // Keep it on the exact production OkHttp line to avoid test-only API skew.
    testImplementation("com.squareup.okhttp3:mockwebserver:5.3.2")
}
