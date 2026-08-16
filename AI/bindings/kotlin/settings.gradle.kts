// Despia AI - the Android face, as its own Gradle build.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Standalone on purpose, exactly as bindings/kotlin-jvm is. This project builds
// `com.despia:ai`, the AAR, and it is the `project` the Maven artifact matrix
// (ClosedSource/release/maven/artifacts.json) runs
// `publishReleasePublicationToMavenLocal` in - stage_bundle.rb chdirs HERE and
// invokes gradle, so this directory has to be a build root in its own right.
//
// WHY THIS FILE HAD TO EXIST, stated plainly because its absence read as "the
// project has no sources" rather than as what it was. `com.android.library` is
// not a Gradle core plugin, and build.gradle.kts declares no version for it
// (versions belong in one place, not in every consumer). With no settings file
// there is no pluginManagement block, so Gradle has neither a repository to
// resolve AGP from nor a version to ask for, and `gradle tasks` dies on the
// `plugins {}` block before it reads another line:
//
//   Plugin [id: 'com.android.library'] was not found in any of the following
//   sources: - Gradle Core Plugins - Included Builds - Plugin Repositories
//   (plugin dependency must include a version number for this source)
//
// The Base package's Android face was unbuildable for the identical reason. One
// missing file each, not two different problems.
//
// THE PINS MATCH THE REST OF THE REPO ON PURPOSE. AGP 8.13.2 / Kotlin 2.3.21 are
// what OpenSource/Engine/Android/build.gradle.kts pins and what
// ClosedSource/RuntimeAndroid composes against. A binding published from a
// different AGP generation than the app that links it is a class-file-version
// argument discovered at a consumer's assemble time.

pluginManagement {
    repositories {
        google()                // AGP
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        id("com.android.library") version "8.13.2"
        id("org.jetbrains.kotlin.android") version "2.3.21"
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "despia-ai-android"
