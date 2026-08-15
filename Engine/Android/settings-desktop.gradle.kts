// Production desktop build graph. Keep this settings file independent from the
// Android host graph so native Windows/Linux packaging never configures AGP, the
// Android SDK, Wear, Glance, or renderer projects that are not shipped in the
// Compose desktop application.
rootProject.name = "despia-engine-desktop"

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

include(":core")
include(":desktop")
