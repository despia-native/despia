// Despia MCP - the external-host handshake: a 0600 file and a launcher.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The problem this solves is small and specific. A desktop agent host is
// configured by a static file a human edits. Our port is ephemeral by design
// (§1 of docs/security.md: a fixed port is a fixed target) and our token is
// minted per run. Something has to bridge "static config" to "dynamic
// endpoint", and the something must not become a place a credential leaks.
//
// So: a DISCOVERY FILE the app writes while consent stands, and a LAUNCHER
// script that carries no secret and reads that file at run time.
//
// Four rules, each enforced by code below rather than by convention:
//
//   1. MODE 0600, and the mode is set BEFORE any content is written. Creating a
//      file at the default mode and chmod-ing it afterwards leaves a window in
//      which the token is world-readable, and a window is all it takes.
//   2. INSTALLED ATOMICALLY. The staged file is renamed into place, so a reader
//      sees either the previous generation or the new one, never a half-written
//      one it will parse as a port of 5 and a truncated token.
//   3. IT CARRIES THE PAIRING TOKEN, never the session token. Withdrawing
//      external consent must not log the app out of itself.
//   4. THE LAUNCHER CARRIES NOTHING. It is exactly the kind of file people
//      paste into an issue when something does not work.
//
// If the filesystem cannot express owner-only permissions, writing FAILS. A
// discovery file that might be readable is worse than no external pairing at
// all, and "best effort" is not a security posture.

package com.despia.mcp

import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions

/** The wire protocol revision this package speaks. */
public const val MCP_PROTOCOL_VERSION: String = "2025-11-25"

/** The single endpoint path the Streamable-HTTP transport serves. */
public const val MCP_ENDPOINT_PATH: String = "/mcp"

/**
 * The discovery file, its directory, and the launcher beside it.
 *
 * [home] is the app container. Everything this class touches lives under
 * `home/despia-mcp/`, which it creates owner-only.
 */
public class McpDiscovery(private val home: File) {

    public companion object {
        public const val DIRECTORY_NAME: String = "despia-mcp"
        public const val FILE_NAME: String = "discovery.json"
        public const val LAUNCHER_NAME: String = "despia-mcp-stdio"

        private val OWNER_ONLY_FILE: Set<PosixFilePermission> = setOf(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE,
        )
        private val OWNER_ONLY_DIRECTORY: Set<PosixFilePermission> = setOf(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE,
            PosixFilePermission.OWNER_EXECUTE,
        )
        private val OWNER_ONLY_EXECUTABLE: Set<PosixFilePermission> = setOf(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE,
            PosixFilePermission.OWNER_EXECUTE,
        )
    }

    public val directory: File get() = File(home, DIRECTORY_NAME)
    public val file: File get() = File(directory, FILE_NAME)
    public val launcher: File get() = File(directory, LAUNCHER_NAME)

    /** The file's POSIX mode as four octal digits, or null when it is absent. */
    public fun mode(target: File = file): String? {
        val path = target.toPath()
        if (!Files.exists(path)) return null
        val supported = path.fileSystem.supportedFileAttributeViews().contains("posix")
        if (!supported) return null
        var bits = 0
        for (permission in Files.getPosixFilePermissions(path)) {
            bits = bits or when (permission) {
                PosixFilePermission.OWNER_READ -> 0x100
                PosixFilePermission.OWNER_WRITE -> 0x080
                PosixFilePermission.OWNER_EXECUTE -> 0x040
                PosixFilePermission.GROUP_READ -> 0x020
                PosixFilePermission.GROUP_WRITE -> 0x010
                PosixFilePermission.GROUP_EXECUTE -> 0x008
                PosixFilePermission.OTHERS_READ -> 0x004
                PosixFilePermission.OTHERS_WRITE -> 0x002
                PosixFilePermission.OTHERS_EXECUTE -> 0x001
            }
        }
        return "0" + Integer.toOctalString(bits).padStart(3, '0')
    }

    /**
     * Writes the discovery file for the current port and pairing token.
     *
     * Throws when owner-only permissions cannot be applied. That is the correct
     * failure: the caller's next move is to refuse external pairing, not to
     * write the token anyway and hope.
     */
    public fun write(port: Int, pairingToken: String, processId: Long = ProcessHandle.current().pid()) {
        require(port in 1..65_535) { "a discovery file needs the real port" }
        require(pairingToken.isNotEmpty()) { "a discovery file without a token pairs nothing" }

        val directoryPath = ensureDirectory()
        val payload = Json.encode(
            linkedMapOf(
                "port" to port,
                "token" to pairingToken,
                "protocol" to MCP_PROTOCOL_VERSION,
                "pid" to processId,
                // Named so a host can tell which app it paired with when three
                // Despia apps are installed. Deliberately not a user-facing
                // name: this file is machine input.
                "endpoint" to MCP_ENDPOINT_PATH,
            ),
        )

        // Staged in the SAME directory, so the rename is a rename and not a
        // cross-device copy that would silently lose the mode.
        val staged = Files.createTempFile(directoryPath, ".discovery", ".staging", ownerOnlyFileAttributes())
        try {
            enforceOwnerOnly(staged, OWNER_ONLY_FILE)
            Files.write(staged, payload.toByteArray(StandardCharsets.UTF_8))
            Files.move(
                staged,
                file.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE,
            )
        } catch (e: Exception) {
            Files.deleteIfExists(staged)
            throw e
        }
        // Re-asserted on the installed path: REPLACE_EXISTING on some platforms
        // keeps the destination's inode, and the destination might be a file an
        // earlier version of this code created at a different mode.
        enforceOwnerOnly(file.toPath(), OWNER_ONLY_FILE)
    }

    /** Removes the discovery file. Absent is success - withdrawal is idempotent. */
    public fun remove() {
        Files.deleteIfExists(file.toPath())
    }

    /** Removes the launcher too. Used when the server stops for good. */
    public fun removeAll() {
        remove()
        Files.deleteIfExists(launcher.toPath())
    }

    /** True when a discovery file is present right now. */
    public fun exists(): Boolean = file.exists()

    /**
     * Reads the discovery file back.
     *
     * Used by the stdio bridge, and by a test that refuses to believe a mode
     * without reading the content it protects.
     */
    public fun read(): Map<String, Any?>? {
        val path = file.toPath()
        if (!Files.exists(path)) return null
        return runCatching {
            Json.decodeObject(String(Files.readAllBytes(path), StandardCharsets.UTF_8))
        }.getOrNull()
    }

    /**
     * Writes the stdio launcher.
     *
     * [command] is the argv an agent host's static config will end up running.
     * The default is this JVM re-invoking the bridge in this package, which is
     * what a desktop build wants; a caller with its own packaging passes its
     * own. The script substitutes nothing secret - it passes the DISCOVERY PATH
     * and the bridge reads the token itself, at run time, from a file only the
     * owner can open.
     */
    public fun writeStdioLauncher(command: List<String> = defaultBridgeCommand()): File {
        val directoryPath = ensureDirectory()
        val quoted = command.joinToString(" ") { shellQuote(it) } + " " + shellQuote(file.absolutePath)
        val script = buildString {
            append("#!/bin/sh\n")
            append("# Despia MCP stdio launcher - GENERATED. Carries no credential.\n")
            append("#\n")
            append("# An agent host runs this and speaks newline-delimited JSON-RPC on stdin\n")
            append("# and stdout. The bridge reads the port and the pairing token from the\n")
            append("# 0600 discovery file below at run time, so this script stays safe to\n")
            append("# paste into a bug report and keeps working across restarts and ports.\n")
            append("#\n")
            append("# Withdrawing external consent removes the discovery file and rotates the\n")
            append("# pairing token; this script then fails, which is the intended behaviour.\n")
            append("set -eu\n")
            append("exec ").append(quoted).append('\n')
        }
        val path = launcher.toPath()
        Files.deleteIfExists(path)
        Files.write(Files.createFile(path, ownerOnlyExecutableAttributes()), script.toByteArray(StandardCharsets.UTF_8))
        enforceOwnerOnly(path, OWNER_ONLY_EXECUTABLE)
        return launcher
    }

    /** This JVM, this classpath, this package's bridge entry point. */
    public fun defaultBridgeCommand(): List<String> = listOf(
        File(File(System.getProperty("java.home"), "bin"), "java").absolutePath,
        "-cp",
        System.getProperty("java.class.path"),
        "com.despia.mcp.McpStdioBridge",
    )

    // --- internals -------------------------------------------------------

    private fun ensureDirectory(): Path {
        val path = directory.toPath()
        if (!Files.exists(path)) {
            if (posix(path)) Files.createDirectories(path, ownerOnlyDirectoryAttributes())
            else Files.createDirectories(path)
        }
        enforceOwnerOnly(path, OWNER_ONLY_DIRECTORY)
        return path
    }

    private fun posix(path: Path): Boolean =
        path.fileSystem.supportedFileAttributeViews().contains("posix")

    private fun ownerOnlyFileAttributes() =
        PosixFilePermissions.asFileAttribute(OWNER_ONLY_FILE)

    private fun ownerOnlyDirectoryAttributes() =
        PosixFilePermissions.asFileAttribute(OWNER_ONLY_DIRECTORY)

    private fun ownerOnlyExecutableAttributes() =
        PosixFilePermissions.asFileAttribute(OWNER_ONLY_EXECUTABLE)

    /**
     * Applies the permissions and then READS THEM BACK.
     *
     * Setting a mode and trusting it is how a file ends up group-readable on a
     * filesystem that quietly ignored the request. This refuses instead.
     */
    private fun enforceOwnerOnly(path: Path, permissions: Set<PosixFilePermission>) {
        if (!posix(path)) {
            throw IOException(
                "the discovery file needs owner-only permissions and this filesystem cannot " +
                    "express them; external pairing is refused rather than written unprotected",
            )
        }
        Files.setPosixFilePermissions(path, permissions)
        val applied = Files.getPosixFilePermissions(path)
        if (applied != permissions) {
            Files.deleteIfExists(path)
            throw IOException("owner-only permissions were not applied to $path (got $applied)")
        }
    }

    private fun shellQuote(value: String): String = "'" + value.replace("'", "'\\''") + "'"
}
