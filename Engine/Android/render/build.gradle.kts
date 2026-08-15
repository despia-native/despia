// :render — K4: the Stack renderer in Jetpack Compose (StackNodeView + the style engine
// in the exact 18-step modifier order of stack-style-properties.json applicationOrder,
// + the full RouterHost — push/pop transitions and predictive back, RouterHost.kt).
// Twin of Stack.swift's renderer section. Depends on :core (kernel)
// + :platform (Android seams). Compose compiler rides the Kotlin compose plugin.
// compileSdk 36 / minSdk 24 — one compileSdk across the composite (the app assembly
// moved to 36 for the PowerSync SDK's AAR floor; the AGP 8.13.x pairing).
plugins {
    id("com.android.library")
    kotlin("android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "despia.engine.render"
    compileSdk = 36
    defaultConfig {
        minSdk = 24
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets {
        getByName("main") {
            // src/main/assets carries the bundled Material Symbols SUBSET font (+ its
            // Apache-2.0 license text); despiaAssets carries build-copied shared data
            // (the app assembly's generated-assets precedent).
            assets.srcDirs("src/main/assets", layout.buildDirectory.dir("generated/despiaAssets"))
        }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

// Kernel stability contracts for the Compose compiler — :core compiles without it, so
// StackNode/StackStore/JSERunner would otherwise infer UNSTABLE at every composable
// boundary. The conf (one copy, Engine/Android root — the closed :app names the same
// file) documents each class's contract; see its header before adding lines.
composeCompiler {
    stabilityConfigurationFiles.add(rootProject.layout.projectDirectory.file("compose_compiler_config.conf"))
}

// ── THE ONE-COPY RULE (the runtime.js precedent) ────────────────────────────────────────
// sf-map.json — the SF Symbol → Material Symbols/fallback icon table behind `icon=`
// (StackIcons.kt) — exists ONCE, at OpenSource/Conformance/icons/sf-map.json (shared
// conformance data, every runtime resolves the same names). This task packages the SAME
// file into the AAR's assets (assets/despia/icons/sf-map.json). Never fork or vendor a
// copy; edit the Conformance file only — and when adding icons, regenerate the font
// subset beside it (see the provenance notes in StackIcons.kt / the JSON's _note).
val copySfMapJson = tasks.register<Copy>("copySfMapJson") {
    from("${projectDir}/../../../Conformance/icons/sf-map.json")
    into(layout.buildDirectory.dir("generated/despiaAssets/despia/icons"))
}
tasks.matching {
    (it.name.startsWith("merge") || it.name.startsWith("generate") || it.name.startsWith("package")) &&
        it.name.endsWith("Assets")
}.configureEach { dependsOn(copySfMapJson) }
// Lint's model/analysis tasks (generate*LintModel, lintVitalAnalyze* — triggered by an app
// consumer's release build via lint-vital) snapshot the asset source dirs too, and Gradle's
// implicit-dependency validation fails the build if they can run before the copy.
// ignoreCase: the task family mixes "Lint" (generateReleaseLintModel) and leading-lowercase
// "lint" (lintVitalAnalyzeRelease) spellings.
tasks.matching { it.name.contains("lint", ignoreCase = true) }.configureEach { dependsOn(copySfMapJson) }

dependencies {
    api(project(":core"))
    api(project(":platform"))
    implementation(platform("androidx.compose:compose-bom:2026.03.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")   // BasicText, layouts, gestures — the custom-path visuals
    implementation("androidx.compose.material3:material3")     // the SYSTEM baseline (system-defaults.md): dynamicColorScheme roles + the real M3 controls (StackTheme.kt / StackButtons.kt); custom-styled elements stay foundation-drawn
    implementation("androidx.activity:activity-compose:1.9.3") // BackHandler + LocalOnBackPressedDispatcherOwner for the native callback; version = the app/wear assemblies' checksum-verified pin
    implementation("com.google.zxing:core:3.5.3")               // pure-Java QR encoder behind <qrcode> (elements/QrElements.kt — the CIQRCodeGenerator twin)
    testImplementation("junit:junit:4.13.2")                    // plain-JVM units for the pure halves (color/platform maps)
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
}
