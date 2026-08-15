//
//  Delivery.swift - the four locks that make arbitrary-origin models a feature.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  The Swift twin of bindings/ts/src/delivery.ts and Delivery.kt. An app may
//  allow ANY model URL, which is the feature and the attack surface in one
//  sentence, so four locks apply to every model regardless of source: an origin
//  allowlist the app declares (https only, wildcards, and EMPTY MEANS NOTHING -
//  fail closed or the lock is opt-out), digest discipline (declared verifies;
//  undeclared is pinned on first download and verified forever after; a mismatch
//  DELETES rather than leaving the file to be retried into the loader), the
//  pre-flight validator, and fit plus quarantine.
//

import Foundation

public struct DownloadOutcome: Sendable {
    public let ok: Bool
    public let sha256: String?
    public let url: String?
    public let pinned: Bool
    public let code: String?
    public let data: JSONObject

    init(ok: Bool, sha256: String? = nil, url: String? = nil, pinned: Bool = false,
         code: String? = nil, data: JSONObject = JSONObject()) {
        self.ok = ok
        self.sha256 = sha256
        self.url = url
        self.pinned = pinned
        self.code = code
        self.data = data
    }
}

public enum Delivery {
    /// The DevSettings wildcard-host grammar. `*.example.com` matches a
    /// SUBDOMAIN and not the apex, and never matches a host that merely ends
    /// with the same letters - `notexample.com` is a different domain, and
    /// treating it as a match is the classic suffix bug.
    public static func hostAllowed(_ host: String, _ patterns: [String]) -> Bool {
        patterns.contains { pattern in
            if pattern == host { return true }
            guard pattern.hasPrefix("*.") else { return false }
            let suffix = String(pattern.dropFirst())        // ".example.com"
            return host.hasSuffix(suffix) && host.count > suffix.count
        }
    }

    /// Lock 1. Returns nil when the URL is allowed, or the refusal.
    public static func checkOrigin(_ url: String, allowed: [String]) -> DownloadOutcome? {
        // URLComponents rather than URL: `URL.host` is deprecated on current
        // SDKs, and the components view answers scheme and host without it.
        let parsed = URLComponents(string: url)
        guard let parsed, let host = parsed.host, !host.isEmpty else {
            var data = JSONObject()
            data.set("reason", .string("malformed_url"))
            data.set("url", .string(url))
            return DownloadOutcome(ok: false, code: "origin_not_allowed", data: data)
        }
        if parsed.scheme != "https" {
            // Plaintext would let anyone on the path swap the bytes, and the
            // digest is checked after the transfer rather than during it.
            var data = JSONObject()
            data.set("reason", .string("insecure_scheme"))
            data.set("host", .string(host))
            return DownloadOutcome(ok: false, code: "origin_not_allowed", data: data)
        }
        if !hostAllowed(host, allowed) {
            var data = JSONObject()
            data.set("host", .string(host))
            return DownloadOutcome(ok: false, code: "origin_not_allowed", data: data)
        }
        return nil
    }

    /// Runs locks 1 to 3 for one catalog entry.
    ///
    /// The mirror list is tried in order: one host being down is not an outage,
    /// and a mirror is not a trust shortcut - whichever URL answers, the same
    /// digest and the same pre-flight parse apply.
    public static func deliver(entry: JSON, allowed: [String], pinned: inout [String: String],
                               fetch: (String) -> JSON?,
                               onAttempt: (String) -> Void,
                               onDelete: (String) -> Void) -> DownloadOutcome {
        let id = entry["id"].string()
        let file = entry["files"][0]
        let urls = file["urls"].strings
        if file.isNull || urls.isEmpty {
            var data = JSONObject()
            data.set("model", .string(id))
            return DownloadOutcome(ok: false, code: "no_files", data: data)
        }

        // Lock 1 first, and BEFORE any request goes out. A refusal that has
        // already contacted the host has told it the app exists, which is most
        // of what an unwanted origin wanted.
        for url in urls {
            if let refusal = checkOrigin(url, allowed: allowed) { return refusal }
        }

        let declared = file["sha256"].stringOrNull?.lowercased()
        let expected = declared ?? pinned[id]

        var lastFailure: DownloadOutcome = {
            var data = JSONObject()
            data.set("model", .string(id))
            return DownloadOutcome(ok: false, code: "download_failed", data: data)
        }()

        for url in urls {
            onAttempt(url)
            let response = fetch(url)
            guard let response, !response["unreachable"].bool() else {
                var data = JSONObject()
                data.set("model", .string(id))
                data.set("url", .string(url))
                lastFailure = DownloadOutcome(ok: false, code: "download_failed", data: data)
                continue   // the next mirror
            }
            let actual = response["sha256"].string().lowercased()

            // Lock 2, verified BEFORE the engine ever sees the file.
            if let expected, actual != expected {
                onDelete(id)
                var data = JSONObject()
                data.set("model", .string(id))
                data.set("expected", .string(expected))
                data.set("actual", .string(actual))
                if declared == nil { data.set("reason", .string("pinned_on_first_download")) }
                return DownloadOutcome(ok: false, code: "digest_mismatch", data: data)
            }

            // Lock 3. The digest says the bytes are the bytes someone named; it
            // says nothing about whether they are a model.
            if response.has("gguf"), !response["gguf"].bool() {
                onDelete(id)
                var data = JSONObject()
                data.set("model", .string(id))
                return DownloadOutcome(ok: false, code: "format_unrecognized", data: data)
            }

            if expected == nil {
                // No declared digest: a bring-your-own model pins one on first
                // download and is verified against it forever after.
                pinned[id] = actual
                return DownloadOutcome(ok: true, sha256: actual, url: url, pinned: true)
            }
            return DownloadOutcome(ok: true, sha256: actual, url: url)
        }
        return lastFailure
    }
}
