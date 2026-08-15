// :glance — W3: the StackLive snapshot dialect's paint backend for Android app widgets
// (androidx.glance:glance-appwidget). Consumes the :core element table (StackLive.kt /
// StackScope.kt — the kernel half) and only PAINTS: layout box, container recursion,
// leaf elements. Twin of StackLive.swift's SwiftUI view half. Depends on :core alone —
// NO :platform, NO compose-ui beyond what Glance itself carries (a widget process is a
// snapshot surface, not the app renderer).
// glance-appwidget PINNED 1.1.1 — Kotlin 1.8.0 metadata (verified against the shipped
// AAR; the Widgets module's dsx.json documents the check), readable across the
// composite's pin range. Compose compiler rides the Kotlin compose plugin (@Composable).
// compileSdk 36 / minSdk 24 — one compileSdk across the composite.
plugins {
    id("com.android.library")
    kotlin("android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "despia.engine.glance"
    compileSdk = 36
    defaultConfig { minSdk = 24 }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    api(project(":core"))
    implementation("androidx.glance:glance-appwidget:1.1.1")
}
