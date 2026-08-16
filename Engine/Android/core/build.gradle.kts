// :core — the pure-JVM half of the Kotlin kernel (K1): JSE, JSON, AST, path match,
// events, messenger, shared handles, strings. ZERO android.* imports — this module
// compiles and runs its tests on any JVM, giving the framework its only fast local
// test loop (Swift compiles solely on Codemagic). Enforced below.
plugins {
    kotlin("jvm")
    `maven-publish`
}

// The DSX kernel package (K1 — the kernel-distribution face): group carries the company-verified
// domain, the artifact carries the technology; ONE version source — Engine/VERSION —
// shared with the npm/SPM faces. `gradle :core:publishToMavenLocal` is the local
// verification; the registry publish is a CI lane.
group = "com.despia.dsx"
version = rootProject.file("../VERSION").readText().trim()

kotlin { jvmToolchain(21) }

java { withSourcesJar() }

publishing {
    publications {
        create<MavenPublication>("dsxKernelCore") {
            artifactId = "kernel-core"   // the pure-JVM half; the assembled android `kernel` rides :platform/:render later
            from(components["java"])
            pom {
                name.set("DSX Kernel (core)")
                description.set("The pure-JVM half of the DSX Kotlin kernel: JSE, JSON, AST, path match, events, messenger, shared handles.")
                licenses { license { name.set("The Apache License, Version 2.0"); url.set("https://www.apache.org/licenses/LICENSE-2.0.txt") } }
            }
        }
    }
}

dependencies {
    // Pure-JVM reactive seam for DSXState (StateFlow) — kotlinx-coroutines is a JVM lib,
    // not android.*; allowed in :core per PLAN.md ground rule 2.
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test { useJUnitPlatform() }

// The pure-JVM law (STRUCTURE.md rule + Engine/Android/README): no android.* anywhere in :core.
tasks.register("checkPureJvm") {
    doLast {
        val bad = fileTree("src") { include("**/*.kt") }.filter { f ->
            f.readText().lineSequence().any { it.trimStart().startsWith("import android.") }
        }.files
        if (bad.isNotEmpty()) throw GradleException("android.* import in pure-JVM :core -> ${bad.map { it.name }}")
    }
}
tasks.named("check") { dependsOn("checkPureJvm") }
