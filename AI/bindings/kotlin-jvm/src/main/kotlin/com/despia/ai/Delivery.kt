// Delivery.kt - the four locks that make arbitrary-origin models a feature.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The Kotlin twin of bindings/ts/src/delivery.ts. An app may allow ANY model
// URL, which is the feature and the attack surface in one sentence, so four
// locks apply to every model regardless of source: an origin allowlist the app
// declares (https only, wildcards, and EMPTY MEANS NOTHING - fail closed or the
// lock is opt-out), digest discipline (declared verifies; undeclared is pinned
// on first download and verified forever after; a mismatch DELETES rather than
// leaving the file to be retried into the loader), the pre-flight validator,
// and fit plus quarantine.

package com.despia.ai

import java.net.URI

data class DownloadOutcome(
    val ok: Boolean,
    val sha256: String? = null,
    val url: String? = null,
    val pinned: Boolean = false,
    val code: String? = null,
    val data: Map<String, Json> = emptyMap(),
)

object Delivery {
    /** The DevSettings wildcard-host grammar. `*.example.com` matches a
     *  SUBDOMAIN and not the apex, and never matches a host that merely ends
     *  with the same letters - `notexample.com` is a different domain, and
     *  treating it as a match is the classic suffix bug. */
    fun hostAllowed(host: String, patterns: List<String>): Boolean = patterns.any { pattern ->
        if (pattern == host) return@any true
        if (!pattern.startsWith("*.")) return@any false
        val suffix = pattern.substring(1)          // ".example.com"
        host.endsWith(suffix) && host.length > suffix.length
    }

    /** Lock 1. Returns null when the URL is allowed, or the refusal. */
    fun checkOrigin(url: String, allowed: List<String>): DownloadOutcome? {
        val parsed = runCatching { URI(url) }.getOrNull()
        val host = parsed?.host
        if (parsed == null || host == null) {
            return DownloadOutcome(false, code = "origin_not_allowed",
                data = mapOf("reason" to Json.Str("malformed_url"), "url" to Json.Str(url)))
        }
        if (parsed.scheme != "https") {
            // Plaintext would let anyone on the path swap the bytes, and the
            // digest is checked after the transfer rather than during it.
            return DownloadOutcome(false, code = "origin_not_allowed",
                data = mapOf("reason" to Json.Str("insecure_scheme"), "host" to Json.Str(host)))
        }
        if (!hostAllowed(host, allowed)) {
            return DownloadOutcome(false, code = "origin_not_allowed",
                data = mapOf("host" to Json.Str(host)))
        }
        return null
    }

    /**
     * Runs locks 1 to 3 for one catalog entry.
     *
     * The mirror list is tried in order: one host being down is not an outage,
     * and a mirror is not a trust shortcut - whichever URL answers, the same
     * digest and the same pre-flight parse apply.
     */
    fun deliver(
        entry: Json,
        allowed: List<String>,
        pinned: MutableMap<String, String>,
        fetch: (String) -> Json?,
        onAttempt: (String) -> Unit,
        onDelete: (String) -> Unit,
    ): DownloadOutcome {
        val id = entry["id"].string()
        val file = entry["files"][0]
        val urls = file["urls"].strings()
        if (file.isNull || urls.isEmpty()) {
            return DownloadOutcome(false, code = "no_files", data = mapOf("model" to Json.Str(id)))
        }

        // Lock 1 first, and BEFORE any request goes out. A refusal that has
        // already contacted the host has told it the app exists, which is most
        // of what an unwanted origin wanted.
        for (url in urls) checkOrigin(url, allowed)?.let { return it }

        val declared = file["sha256"].stringOrNull()?.lowercase()
        val expected = declared ?: pinned[id]

        var lastFailure = DownloadOutcome(false, code = "download_failed",
            data = mapOf("model" to Json.Str(id)))
        for (url in urls) {
            onAttempt(url)
            val response = fetch(url)
            if (response == null || response["unreachable"].bool()) {
                lastFailure = DownloadOutcome(false, code = "download_failed",
                    data = mapOf("model" to Json.Str(id), "url" to Json.Str(url)))
                continue   // the next mirror
            }
            val actual = response["sha256"].string().lowercase()

            // Lock 2, verified BEFORE the engine ever sees the file.
            if (expected != null && actual != expected) {
                onDelete(id)
                val data = mutableMapOf<String, Json>(
                    "model" to Json.Str(id),
                    "expected" to Json.Str(expected),
                    "actual" to Json.Str(actual),
                )
                if (declared == null) data["reason"] = Json.Str("pinned_on_first_download")
                return DownloadOutcome(false, code = "digest_mismatch", data = data)
            }

            // Lock 3. The digest says the bytes are the bytes someone named; it
            // says nothing about whether they are a model.
            if (response.has("gguf") && !response["gguf"].bool()) {
                onDelete(id)
                return DownloadOutcome(false, code = "format_unrecognized",
                    data = mapOf("model" to Json.Str(id)))
            }

            if (expected == null) {
                // No declared digest: a bring-your-own model pins one on first
                // download and is verified against it forever after.
                pinned[id] = actual
                return DownloadOutcome(true, sha256 = actual, url = url, pinned = true)
            }
            return DownloadOutcome(true, sha256 = actual, url = url)
        }
        return lastFailure
    }
}
