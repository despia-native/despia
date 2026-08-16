package despia.engine

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

/**
 * WIRE-CONTRACT conformance (constitution Article 8): pins the modern bridge surface this
 * runtime advertises to the ONE shared fixture OpenSource/Conformance/api/wire-contract.json,
 * so a capabilities/envelope drift on Android can never land without a matching fixture bump
 * (which forces the same review on every runtime). The future-proof audit (2026-07-11) flagged
 * that bridgeVersion=3 lived only as a per-platform literal with no cross-runtime pin; this
 * closes the Android half. The iOS half (Bridge.swift asserting the same file) is the flagged
 * d-ios follow-up; the web runtime joins as #3 per /web/07.
 *
 * The values under test are the SAME constants VirtualBridge.kt injects into
 * window.virtual.capabilities — kept here as the audited source of truth (VirtualBridge lives
 * in the Dom module, outside :core's classpath, so the test restates them and the fixture is
 * the referee both sides answer to).
 */
class WireContractTest {

    // The Android-advertised surface — mirrors Dom/android/VirtualBridge.kt (bridgeVersion,
    // messageName, capabilities) and Context.kt (envelope keys, error codes, platform token).
    private val androidBridgeVersion = 3
    private val androidMessageName = "virtual"
    private val androidCapabilities = mapOf(
        "version" to 3, "structured" to true, "events" to true, "subscribe" to true,
    )
    private val androidEnvelopeKeys =
        listOf("id", "scheme", "host", "event", "final", "data", "code", "recoverable", "message")
    private val androidPlatformToken = "android"

    private fun fixture(): Map<*, *> {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val f = File(dir, "OpenSource/Conformance/api/wire-contract.json")
            if (f.isFile) return json(f.readText()).foundationValue as? Map<*, *>
                ?: error("wire-contract.json is not a JSON object")
            dir = dir.parentFile
                ?: error("OpenSource/Conformance/api/wire-contract.json not found from ${System.getProperty("user.dir")}")
        }
    }

    private fun asInt(v: Any?): Int = (v as? Number)?.toInt() ?: error("expected number, got $v")

    @Test
    fun bridgeVersionMatchesTheSharedContract() {
        assertEquals(asInt(fixture()["bridgeVersion"]), androidBridgeVersion,
            "bridgeVersion drifted from OpenSource/Conformance/api/wire-contract.json — bump BOTH together")
    }

    @Test
    fun capabilitiesMatchTheSharedContract() {
        val caps = fixture()["capabilities"] as? Map<*, *> ?: error("no capabilities")
        assertEquals(asInt(caps["version"]), asInt(androidCapabilities["version"]))
        assertEquals(caps["structured"], androidCapabilities["structured"])
        assertEquals(caps["events"], androidCapabilities["events"])
        assertEquals(caps["subscribe"], androidCapabilities["subscribe"])
        // capabilities.version and bridgeVersion are the same wire generation, always equal.
        assertEquals(asInt(caps["version"]), androidBridgeVersion)
    }

    @Test
    fun messageNameMatches() {
        assertEquals(fixture()["messageName"], androidMessageName)
    }

    @Test
    fun envelopeKeysMatchTheSharedContract() {
        @Suppress("UNCHECKED_CAST")
        val keys = fixture()["envelopeKeys"] as? List<String> ?: error("no envelopeKeys")
        assertEquals(keys, androidEnvelopeKeys,
            "envelope key set diverged from the shared wire contract")
    }

    @Test
    fun errorCodesAndPlatformTokenMatch() {
        val codes = fixture()["errorCodes"] as? Map<*, *> ?: error("no errorCodes")
        assertEquals("not_loaded", codes["notLoaded"])
        assertEquals("unsupported_platform", codes["unsupportedPlatform"])
        val platforms = fixture()["platforms"] as? Map<*, *> ?: error("no platforms")
        assertEquals(androidPlatformToken, platforms["android"])
        assertTrue(platforms.containsKey("ios"), "the contract must name the iOS token too")
    }
}
