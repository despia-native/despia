//
//  OtaConformance.swift — the Swift leg of the OTA runtime-safety corpus
//  (OpenSource/Conformance/ota/rollout.json, parity/P05-ota.md 4b + 4c). Runs every pinned
//  case through the REAL `OtaGeneration`, the reference implementation the TS runner
//  (ota-conformance.test.ts) and the Kotlin runner (:core OtaConformanceTest) execute over the
//  SAME file. Driven from the Codemagic record lane by RecordMain.swift; a mismatch fails the
//  recorder outright, exactly like the other expectation corpora.
//
//  Kept in its own file rather than folded into ConformanceHosts.swift so the OTA leg lands
//  without touching a shared kernel file.
//
import Foundation

public enum OtaConformance {
    public struct Failure: Error, CustomStringConvertible { public let description: String }

    /// Run the corpus. Returns the number of cases verified; throws on the first mismatch, or
    /// on a malformed / empty corpus — a silently-skipped suite is how drift starts.
    public static func verify(corpusFile: URL) throws -> Int {
        let name = corpusFile.lastPathComponent
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(name): not a JSON object")
        }
        guard (doc["version"] as? NSNumber)?.intValue == 1 else {
            throw Failure(description: "\(name): version must be 1")
        }

        var verified = 0
        verified += try verifyHash(doc, name)
        verified += try verifyRollout(doc, name)
        verified += try verifyMonotonic(doc, name)
        verified += try verifyCompare(doc, name)
        verified += try verifyGeneration(doc, name)
        return verified
    }

    private static func block(_ doc: [String: Any], _ key: String, _ name: String) throws -> [String: Any] {
        guard let value = doc[key] as? [String: Any] else {
            throw Failure(description: "\(name): no \(key){}")
        }
        return value
    }

    private static func cases(_ doc: [String: Any], _ key: String, _ name: String) throws -> [[String: Any]] {
        guard let list = try block(doc, key, name)["cases"] as? [[String: Any]], !list.isEmpty else {
            throw Failure(description: "\(name): no \(key).cases[]")
        }
        return list
    }

    // MARK: - hash

    private static func verifyHash(_ doc: [String: Any], _ name: String) throws -> Int {
        let hash = try block(doc, "hash", name)
        guard hash["algorithm"] as? String == "fnv1a32",
              (hash["offsetBasis"] as? NSNumber)?.uint32Value == 2166136261,
              (hash["prime"] as? NSNumber)?.uint32Value == 16777619,
              (hash["divisor"] as? NSNumber)?.doubleValue == OtaGeneration.bucketDivisor,
              hash["inputTemplate"] as? String == "{installationId}:{salt}" else {
            throw Failure(description: "\(name): the hash constants drifted from the corpus")
        }

        var verified = 0
        for entry in try cases(doc, "hash", name) {
            let label = entry["name"] as? String ?? "<unnamed>"
            guard let id = entry["installationId"] as? String,
                  let salt = entry["salt"] as? String,
                  let expectedHash = (entry["hash"] as? NSNumber)?.uint32Value,
                  let expectedBucket = (entry["bucket"] as? NSNumber)?.doubleValue else {
                throw Failure(description: "\(name): malformed hash case '\(label)'")
            }
            let actualHash = OtaGeneration.hash32("\(id):\(salt)")
            guard actualHash == expectedHash else {
                throw Failure(description: "\(name): \(label): hash \(actualHash) != \(expectedHash)")
            }
            let actualBucket = OtaGeneration.bucket(installationId: id, salt: salt)
            guard abs(actualBucket - expectedBucket) < 1e-12 else {
                throw Failure(description: "\(name): \(label): bucket \(actualBucket) != \(expectedBucket)")
            }
            guard actualBucket >= 0, actualBucket < 1 else {
                throw Failure(description: "\(name): \(label): bucket left the unit interval")
            }
            verified += 1
        }
        return verified
    }

    // MARK: - rollout

    private static func verifyRollout(_ doc: [String: Any], _ name: String) throws -> Int {
        var verified = 0
        for entry in try cases(doc, "rollout", name) {
            let label = entry["name"] as? String ?? "<unnamed>"
            guard let id = entry["installationId"] as? String,
                  let salt = entry["salt"] as? String,
                  let fraction = (entry["fraction"] as? NSNumber)?.doubleValue,
                  let expected = entry["applies"] as? Bool else {
                throw Failure(description: "\(name): malformed rollout case '\(label)'")
            }
            let actual = OtaGeneration.rolloutApplies(installationId: id, salt: salt, fraction: fraction)
            guard actual == expected else {
                throw Failure(description: "\(name): \(label): applies \(actual) != \(expected)")
            }
            verified += 1
        }
        return verified
    }

    // MARK: - monotonic

    /// Raising the fraction must only ever GROW the population. Asserted as a property on top
    /// of the pinned values, because it is a property, not a case.
    private static func verifyMonotonic(_ doc: [String: Any], _ name: String) throws -> Int {
        let monotonic = try block(doc, "monotonic", name)
        guard let fractions = (monotonic["fractions"] as? [NSNumber])?.map({ $0.doubleValue }),
              !fractions.isEmpty else {
            throw Failure(description: "\(name): no monotonic.fractions[]")
        }

        var verified = 0
        for entry in try cases(doc, "monotonic", name) {
            let label = entry["name"] as? String ?? "<unnamed>"
            guard let id = entry["installationId"] as? String,
                  let salt = entry["salt"] as? String,
                  let expected = entry["applies"] as? [Bool],
                  expected.count == fractions.count else {
                throw Failure(description: "\(name): malformed monotonic case '\(label)'")
            }
            var previous = false
            for (index, fraction) in fractions.enumerated() {
                let actual = OtaGeneration.rolloutApplies(installationId: id, salt: salt, fraction: fraction)
                guard actual == expected[index] else {
                    throw Failure(description: "\(name): \(label): fraction \(fraction) applies \(actual) != \(expected[index])")
                }
                guard !(previous && !actual) else {
                    throw Failure(description: "\(name): \(label): fraction \(fraction) dropped a device already in")
                }
                previous = actual
            }
            verified += 1
        }
        return verified
    }

    // MARK: - compare

    private static func verifyCompare(_ doc: [String: Any], _ name: String) throws -> Int {
        var verified = 0
        for entry in try cases(doc, "compare", name) {
            let label = entry["name"] as? String ?? "<unnamed>"
            guard let a = entry["a"] as? String, let b = entry["b"] as? String else {
                throw Failure(description: "\(name): malformed compare case '\(label)'")
            }
            let expected = (entry["expect"] as? NSNumber)?.intValue
            let actual = OtaGeneration.compareVersions(a, b)
            guard actual == expected else {
                throw Failure(description: "\(name): \(label): compare(\(a), \(b)) = \(String(describing: actual)) != \(String(describing: expected))")
            }
            if let expected = expected {
                // Antisymmetry is a property, not a corpus case.
                guard OtaGeneration.compareVersions(b, a) == -expected else {
                    throw Failure(description: "\(name): \(label): compare is not antisymmetric")
                }
                guard OtaGeneration.runtimeVersionSatisfied(required: b, current: a) == (expected >= 0) else {
                    throw Failure(description: "\(name): \(label): satisfied disagrees with compare")
                }
            } else {
                guard OtaGeneration.runtimeVersionSatisfied(required: b, current: a) == nil else {
                    throw Failure(description: "\(name): \(label): satisfied decided an undecidable pair")
                }
                guard !OtaGeneration.isParseableVersion(a) || !OtaGeneration.isParseableVersion(b) else {
                    throw Failure(description: "\(name): \(label): a null compare with two parseable sides")
                }
            }
            verified += 1
        }
        return verified
    }

    // MARK: - generation

    private static func verifyGeneration(_ doc: [String: Any], _ name: String) throws -> Int {
        let generation = try block(doc, "generation", name)
        guard let vocabulary = generation["verdicts"] as? [String], !vocabulary.isEmpty else {
            throw Failure(description: "\(name): no generation.verdicts[]")
        }
        let list = try cases(doc, "generation", name)

        var verified = 0
        for entry in list {
            let label = entry["name"] as? String ?? "<unnamed>"
            guard let expected = entry["expect"] as? String, vocabulary.contains(expected) else {
                throw Failure(description: "\(name): \(label): expect is outside the declared vocabulary")
            }
            let manifest = entry["manifest"] as? [String: Any] ?? [:]
            let client = entry["client"] as? [String: Any] ?? [:]
            let decision = OtaGeneration.evaluate(manifest: manifest,
                                                  installedRuntimeVersion: client["runtimeVersion"] as? String,
                                                  installationId: client["installationId"] as? String)
            guard decision.verdict.rawValue == expected else {
                throw Failure(description: "\(name): \(label): verdict \(decision.verdict.rawValue) != \(expected)")
            }
            verified += 1
        }

        // Every declared verdict must be reachable, or the vocabulary is aspirational.
        for verdict in vocabulary {
            guard list.contains(where: { ($0["expect"] as? String) == verdict }) else {
                throw Failure(description: "\(name): no case reaches '\(verdict)'")
            }
        }
        return verified
    }
}
