// Despia MCP - com.despia:mcp-jvm.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The version DERIVES from the package VERSION file; a literal here is the drift
// between the two Kotlin faces that nobody notices until a consumer does.
//
// NO third-party dependencies. The registry, the schema derivation and the
// bounded listener need a JDK and nothing else. The official MCP Kotlin SDK is
// pinned in vendor/VERSIONS for the client transport, and it enters this file in
// the diff that adds that transport, not before: a dependency listed ahead of
// the code that uses it is an unpinned promise.

plugins {
    kotlin("jvm") version "2.3.21"
}

group = "com.despia"
version = file("../../VERSION").readText().trim()

repositories { mavenCentral() }

dependencies {
    testImplementation(kotlin("test"))
}

kotlin { jvmToolchain(21) }

// The server answers `initialize` with its own version, and the only defensible
// source for that string is the one the artifact was built from. Stamping it on
// the jar manifest means the running code reads it back rather than carrying a
// literal that drifts from VERSION the first time nobody remembers to bump it.
tasks.jar {
    manifest {
        attributes(
            "Implementation-Title" to "despia-mcp",
            "Implementation-Version" to project.version.toString(),
        )
    }
}

tasks.test {
    useJUnitPlatform()
    testLogging { showStandardStreams = true }
}
