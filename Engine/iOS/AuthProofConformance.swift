//
//  AuthProofConformance.swift — VERIFY MODE for the A1 authentication-proof corpus.
//
//  Runs OpenSource/Conformance/auth/{trigger,pkce}.json through the REAL Swift pure core
//  (AuthProof) and throws on the first disagreement, so the reference renderer executes the same
//  files as the TS runner (@despia/kernel auth-proof-conformance.test.ts) and the Kotlin twin
//  (:core AuthProofConformanceTest). The login-trigger origin pin, the RFC 7636 ABNF, the S256
//  encoding, the proof plan, the URL it builds and the callback verdict therefore cannot drift.
//
//  Like NetConformance.swift / GesturesConformance.swift: NOT part of any app or extension
//  target — it compiles only in the Codemagic `conformance-record` lane, alongside the rest of
//  OpenSource/Engine, via RecordMain.swift. Foundation-only, pure computation plus two file
//  reads.
//
//  THE DIGEST CROSS-CHECK IS PLATFORM-GATED. The challenge rows carry both the verifier and its
//  SHA-256; the encoding is checked from the recorded digest everywhere, and where CryptoKit
//  exists the verifier is ALSO hashed here and asserted to reproduce that digest — the same
//  double check the TS and Kotlin runners do with node's crypto and MessageDigest. On a
//  toolchain without CryptoKit (a Linux parse/type-check box) the encoding half still runs, so
//  this file is never a silent skip; it is a narrower check that says so.
//
import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

enum AuthProofConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Execute every section of both files. Returns the number of cases verified; an empty
    /// section is a failure, never a silent skip.
    static func verify(corpusDir: URL) throws -> Int {
        var count = 0
        let trigger = try object(corpusDir.appendingPathComponent("trigger.json"), "trigger.json")
        count += try verifyTriggerMatch(try cases(trigger, "matchesConfiguredTrigger", "trigger.json"))
        count += try verifyAuthorizationUrl(try cases(trigger, "isAllowedAuthorizationUrl", "trigger.json"))

        let pkce = try object(corpusDir.appendingPathComponent("pkce.json"), "pkce.json")
        count += try verifyVerifier(pkce)
        count += try verifyBase64Url(try cases(pkce, "base64url", "pkce.json"))
        count += try verifyMint(pkce)
        count += try verifyChallenge(pkce)
        count += try verifyPlan(pkce)
        count += try verifyApply(try cases(pkce, "apply", "pkce.json"))
        count += try verifyCallback(pkce)
        count += try verifyConstantTime(try cases(pkce, "constantTime", "pkce.json"))
        count += try verifyIdToken(try cases(pkce, "idToken", "pkce.json"))
        count += try verifyTokenEndpoint(try cases(pkce, "tokenEndpoint", "pkce.json"))
        return count
    }

    // MARK: - helpers

    private static func object(_ url: URL, _ label: String) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure(description: "\(label): not a JSON object")
        }
        guard (root["version"] as? NSNumber)?.intValue == 1 else {
            throw Failure(description: "\(label): unsupported version")
        }
        return root
    }

    private static func section(_ root: [String: Any], _ name: String, _ label: String) throws -> [String: Any] {
        guard let value = root[name] as? [String: Any] else {
            throw Failure(description: "\(label): no \(name){}")
        }
        return value
    }

    private static func cases(_ root: [String: Any], _ name: String, _ label: String) throws -> [[String: Any]] {
        let rows = (root[name] as? [String: Any])?["cases"] as? [[String: Any]]
        guard let rows, !rows.isEmpty else {
            throw Failure(description: "\(label): \(name) must carry a non-empty case array")
        }
        return rows
    }

    private static func array(_ section: [String: Any], _ key: String, _ label: String) throws -> [[String: Any]] {
        guard let items = section[key] as? [[String: Any]], !items.isEmpty else {
            throw Failure(description: "\(label): \(key) must be a non-empty array")
        }
        return items
    }

    private static func name(_ row: [String: Any]) -> String { (row["name"] as? String) ?? "<unnamed>" }

    private static func flag(_ raw: Any?) -> Bool { (raw as? NSNumber)?.boolValue == true }

    private static func strings(_ raw: Any?) -> [String] { (raw as? [String]) ?? [] }

    private static func ints(_ raw: Any?) -> [Int] { ((raw as? [NSNumber]) ?? []).map { $0.intValue } }

    private static func same<T: Equatable>(_ actual: T, _ expected: T, _ label: String) throws {
        guard actual == expected else {
            throw Failure(description: "\(label): \(actual) != \(expected)")
        }
    }

    private static func hexBytes(_ hex: String) throws -> [Int] {
        let chars = Array(hex)
        guard chars.count % 2 == 0 else { throw Failure(description: "odd hex length") }
        var out: [Int] = []
        var i = 0
        while i < chars.count {
            guard let byte = Int(String(chars[i...(i + 1)]), radix: 16) else {
                throw Failure(description: "not hex: \(hex)")
            }
            out.append(byte)
            i += 2
        }
        return out
    }

    // MARK: - 1 · the trigger fold

    private static func verifyTriggerMatch(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            try same(AuthProof.matchesConfiguredTrigger(row["candidate"] as? String, row["prefix"] as? String),
                     flag(row["expect"]), "matchesConfiguredTrigger/\(name(row))")
        }
        return rows.count
    }

    private static func verifyAuthorizationUrl(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            try same(AuthProof.isAllowedAuthorizationUrl(row["url"] as? String),
                     flag(row["expect"]), "isAllowedAuthorizationUrl/\(name(row))")
        }
        return rows.count
    }

    // MARK: - 2 · the verifier ABNF, the alphabet, the entropy floors

    private static func verifyVerifier(_ root: [String: Any]) throws -> Int {
        let block = try section(root, "verifier", "pkce.json")
        try same((block["minLength"] as? NSNumber)?.intValue ?? -1, AuthProof.pkceVerifierMinLength, "verifier/minLength")
        try same((block["maxLength"] as? NSNumber)?.intValue ?? -1, AuthProof.pkceVerifierMaxLength, "verifier/maxLength")
        for ch in (block["unreserved"] as? String) ?? "" {
            try same(AuthProof.isCodeVerifier(String(repeating: String(ch), count: AuthProof.pkceVerifierMinLength)),
                     true, "verifier/unreserved \(ch)")
        }
        let rows = try cases(root, "verifier", "pkce.json")
        for row in rows {
            try same(AuthProof.isCodeVerifier(row["value"] as? String), flag(row["expect"]),
                     "verifier/\(name(row))")
        }
        return rows.count
    }

    private static func verifyBase64Url(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            try same(AuthProof.base64UrlNoPad(ints(row["bytes"])), (row["expect"] as? String) ?? "",
                     "base64url/\(name(row))")
        }
        return rows.count
    }

    private static func verifyMint(_ root: [String: Any]) throws -> Int {
        let block = try section(root, "mint", "pkce.json")
        try same((block["verifierEntropyBytes"] as? NSNumber)?.intValue ?? -1,
                 AuthProof.pkceVerifierEntropyBytes, "mint/verifierEntropyBytes")
        try same((block["proofEntropyBytes"] as? NSNumber)?.intValue ?? -1,
                 AuthProof.authProofEntropyBytes, "mint/proofEntropyBytes")
        let rows = try cases(root, "mint", "pkce.json")
        for row in rows {
            let label = "mint/\(name(row))"
            let bytes = ints(row["bytes"])
            let actual = (row["fold"] as? String) == "codeVerifierFromEntropy"
                ? AuthProof.codeVerifierFromEntropy(bytes) : AuthProof.opaqueProof(bytes)
            try same(actual ?? "<nil>", (row["expect"] as? String) ?? "<nil>", label)
        }
        guard let minted = AuthProof.codeVerifierFromEntropy([Int](repeating: 0xff, count: AuthProof.pkceVerifierEntropyBytes)),
              AuthProof.isCodeVerifier(minted) else {
            throw Failure(description: "mint: a minted verifier must satisfy the ABNF it is measured against")
        }
        return rows.count
    }

    // MARK: - 3 · the S256 challenge

    private static func verifyChallenge(_ root: [String: Any]) throws -> Int {
        let block = try section(root, "challenge", "pkce.json")
        try same((block["method"] as? String) ?? "", AuthProof.pkceChallengeMethod, "challenge/method")
        let rows = try cases(root, "challenge", "pkce.json")
        for row in rows {
            let label = "challenge/\(name(row))"
            let verifier = (row["verifier"] as? String) ?? ""
            let recorded = (row["sha256Hex"] as? String) ?? ""
            #if canImport(CryptoKit)
            let digest = SHA256.hash(data: Data(verifier.utf8)).map { Int($0) }
            let hex = digest.map { String(format: "%02x", $0) }.joined()
            try same(hex, recorded, "\(label): the corpus digest is not SHA-256 of the verifier")
            #else
            let digest = try hexBytes(recorded)
            #endif
            try same(AuthProof.codeChallengeS256(digest) ?? "<nil>", (row["expect"] as? String) ?? "",
                     label)
            guard !((row["expect"] as? String) ?? "").contains("=") else {
                throw Failure(description: "\(label): a challenge never carries padding")
            }
        }
        for row in try array(block, "lengthRefusals", "pkce.json") {
            let length = (row["length"] as? NSNumber)?.intValue ?? -1
            guard AuthProof.codeChallengeS256([Int](repeating: 0, count: length)) == nil else {
                throw Failure(description: "challenge/\(name(row)): a \(length)-byte digest was encoded")
            }
        }
        return rows.count
    }

    // MARK: - 4 · the proof plan and the URL it builds

    private static func verifyPlan(_ root: [String: Any]) throws -> Int {
        let block = try section(root, "plan", "pkce.json")
        let declared = Set(strings(block["refusals"]))
        let rows = try cases(root, "plan", "pkce.json")
        for row in rows {
            let label = "plan/\(name(row))"
            guard let expect = row["expect"] as? [String: Any] else {
                throw Failure(description: "\(label): no expect{}")
            }
            let plan = AuthProof.planAuthorizeProofs(row["url"] as? String, wantsPkce: flag(row["wantsPkce"]))
            if let refusal = expect["refusal"] as? String {
                guard declared.contains(refusal) else {
                    throw Failure(description: "\(label): undeclared refusal \(refusal)")
                }
                try same(plan.refusal ?? "<nil>", refusal, "\(label): refusal")
                try same(plan.mintPkce, false, "\(label): a refused plan mints nothing")
                try same(plan.mintState, false, "\(label): a refused plan mints nothing")
                continue
            }
            try same(plan.refusal ?? "<nil>", "<nil>", "\(label): refusal")
            try same(plan.mintState, flag(expect["mintState"]), "\(label): mintState")
            try same(plan.adoptedState ?? "<nil>", (expect["adoptedState"] as? String) ?? "<nil>",
                     "\(label): adoptedState")
            try same(plan.mintNonce, flag(expect["mintNonce"]), "\(label): mintNonce")
            try same(plan.mintPkce, flag(expect["mintPkce"]), "\(label): mintPkce")
            if expect.index(forKey: "adoptedNonce") != nil {
                try same(plan.adoptedNonce ?? "<nil>", (expect["adoptedNonce"] as? String) ?? "<nil>",
                         "\(label): adoptedNonce")
            }
        }
        return rows.count
    }

    private static func verifyApply(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let minted = (row["minted"] as? [String: Any]) ?? [:]
            let actual = AuthProof.applyAuthorizeProofs(row["url"] as? String,
                                                        state: minted["state"] as? String,
                                                        nonce: minted["nonce"] as? String,
                                                        challenge: minted["challenge"] as? String)
            try same(actual, (row["expect"] as? String) ?? "", "apply/\(name(row))")
        }
        return rows.count
    }

    // MARK: - 5 · the callback verdict

    private static func verifyCallback(_ root: [String: Any]) throws -> Int {
        let block = try section(root, "verify", "pkce.json")
        let declared = Set(strings(block["verdicts"]))
        let rows = try cases(root, "verify", "pkce.json")
        for row in rows {
            let label = "verify/\(name(row))"
            let verdict = AuthProof.verifyCallbackProofs(expectedState: row["expected"] as? String,
                                                         consumedStates: strings(row["consumed"]),
                                                         receivedState: row["received"] as? String,
                                                         expectedNonce: row["expectedNonce"] as? String,
                                                         idTokenNonce: row["idTokenNonce"] as? String)
            let expect = (row["expect"] as? String) ?? ""
            guard declared.contains(expect) else {
                throw Failure(description: "\(label): undeclared verdict \(expect)")
            }
            try same(verdict.rawValue, expect, label)
        }
        return rows.count
    }

    private static func verifyConstantTime(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            try same(AuthProof.constantTimeEquals(row["a"] as? String, row["b"] as? String),
                     flag(row["expect"]), "constantTime/\(name(row))")
        }
        return rows.count
    }

    private static func verifyIdToken(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            try same(AuthProof.idTokenPayload(row["jwt"] as? String) ?? "<nil>",
                     (row["expect"] as? String) ?? "<nil>", "idToken/\(name(row))")
        }
        return rows.count
    }

    private static func verifyTokenEndpoint(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            try same(AuthProof.tokenEndpointAllowed(row["url"] as? String,
                                                    declaredOrigins: strings(row["declared"])),
                     flag(row["expect"]), "tokenEndpoint/\(name(row))")
        }
        return rows.count
    }
}
