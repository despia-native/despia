// Plugin versions for every module (each module applies what it needs).
// AGP 8.13.x pairs with Gradle 8.14.5 (AGP 8.13's floor is Gradle 8.13; AGP 9.x needs
// Gradle 9) / Kotlin 2.3.21; the compose plugin ships WITH Kotlin (same version) since
// 2.0 — no standalone compose-compiler pin.
plugins {
    kotlin("jvm") version "2.3.21" apply false
    kotlin("android") version "2.3.21" apply false
    id("com.android.library") version "8.13.2" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.3.21" apply false
    // Compose Multiplatform deliberately matches the Android renderer's Compose 1.10
    // generation.  Keeping the desktop host on the same renderer generation avoids a
    // second input/layout contract while still allowing host-native distributions.
    id("org.jetbrains.compose") version "1.10.3" apply false
}

fun String.isStableExternalClasspath(): Boolean {
    // Compose creates host-local hot-reload/development graphs even while a release
    // target is being resolved explicitly. They are tooling inputs, not shipped
    // runtime classpaths, and locking them would leak the resolver host (for example
    // macOS Skiko) into a Linux or Windows production lock.
    val isComposeDeveloperClasspath =
        equals("devRuntimeClasspath", ignoreCase = true) ||
            startsWith("composeHotReloadDev", ignoreCase = true)
    return !isComposeDeveloperClasspath && (
        endsWith("runtimeClasspath", ignoreCase = true) ||
            endsWith("annotationProcessorClasspath", ignoreCase = true) ||
            this == "coreLibraryDesugaring"
        )
}

fun String.stableLockResolutionPriority(): Int =
    when {
        endsWith("runtimeClasspath", ignoreCase = true) -> 0
        endsWith("compileClasspath", ignoreCase = true) -> 1
        endsWith("annotationProcessorClasspath", ignoreCase = true) -> 2
        else -> 3
    }

// Lock shipped runtime classpaths (plus processors/desugaring). Android/JVM compile
// classpaths resolve consistently from runtime; independently locking both can produce
// an impossible pair when API-only dependency constraints differ from runtime.
// AGP also creates late synthetic configurations
// (for example androidApis and _internal-unified-test-platform-*) that cannot be
// safely covered by lockAllConfigurations() in a composite build.
allprojects {
    // Declaring the artifact views as task inputs retains their producer-task
    // dependencies. Resolving a project artifact for the first time in doLast
    // is too late for Gradle to schedule :core:jar on a clean checkout.
    val stableLockFiles = objects.fileCollection()
    val selectedStableConfigurations = linkedMapOf<String, Configuration>()
    dependencyLocking {
        lockMode.set(org.gradle.api.artifacts.dsl.LockMode.STRICT)
    }
    configurations.configureEach {
        if (name.isStableExternalClasspath()) {
            resolutionStrategy.activateDependencyLocking()
        }
    }
    // Android variants create runtime configurations in late evaluation callbacks.
    // Finalize after all projects (rather than this script's early afterEvaluate
    // callback), while task dependencies can still be inferred before graph creation.
    gradle.projectsEvaluated {
        // Reassert the narrow policy after Android/JVM plugin variant creation; plugins
        // may replace resolution strategies while realizing their configurations.
        configurations
            .filter { it.name.isStableExternalClasspath() }
            .forEach { it.resolutionStrategy.activateDependencyLocking() }
        // Compile graphs stay unlocked, but every shared dependency must use the
        // version selected by its locked runtime twin. Compile-only artifacts remain
        // available without creating a second, potentially contradictory lock.
        configurations
            .filter { it.isCanBeResolved && it.name.endsWith("CompileClasspath", ignoreCase = true) }
            .forEach { compileConfiguration ->
                val runtimeName = compileConfiguration.name.replace(
                    Regex("CompileClasspath$", RegexOption.IGNORE_CASE),
                    "RuntimeClasspath"
                )
                configurations.findByName(runtimeName)?.let { runtimeConfiguration ->
                    compileConfiguration.shouldResolveConsistentlyWith(runtimeConfiguration)
                }
            }
        configurations
            .filter { it.isCanBeResolved && it.name.isStableExternalClasspath() }
            .sortedWith(compareBy({ it.name.stableLockResolutionPriority() }, { it.name }))
            .forEach { configuration ->
                selectedStableConfigurations[configuration.name] = configuration
                val isAndroidConfiguration = configuration.attributes.keySet()
                    .any { attribute ->
                        attribute.name == "com.android.build.api.attributes.AgpVersionAttr"
                    }
                stableLockFiles.from(
                    if (isAndroidConfiguration) {
                        configuration.incoming.artifactView {
                            attributes {
                                attribute(
                                    Attribute.of("artifactType", String::class.java),
                                    "android-classes-jar"
                                )
                            }
                        }.files
                    } else {
                        configuration
                    }
                )
            }
    }
    tasks.register("resolveAndLockStableDependencies") {
        notCompatibleWithConfigurationCache("Resolves the explicitly selected stable classpaths")
        inputs.files(stableLockFiles)
        doFirst {
            require(gradle.startParameter.isWriteDependencyLocks) {
                "$path requires --write-locks"
            }
            val current = configurations
                .filter { it.isCanBeResolved && it.name.isStableExternalClasspath() }
                .map { it.name }
                .sorted()
            val selected = selectedStableConfigurations.keys.sorted()
            require(selected == current) {
                "$path stable dependency-lock inventory was finalized too early; " +
                    "selected=$selected current=$current"
            }
        }
        doLast {
            stableLockFiles.files
            val unresolved = selectedStableConfigurations.values
                .filter { it.state != Configuration.State.RESOLVED }
                .map { it.name }
                .sorted()
            require(unresolved.isEmpty()) {
                "$path did not resolve stable dependency-lock configurations: $unresolved"
            }
            logger.lifecycle(
                "[dependency-lock] $path resolved ${selectedStableConfigurations.size} " +
                    "stable configurations and ${stableLockFiles.files.size} artifacts"
            )
        }
    }
}
