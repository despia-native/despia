//
//  LiveLogs.swift — the LIVE LOGS wire core: the pure half of dev.stream (proposals/live-logs.md).
//  The law is the corpus, `OpenSource/Conformance/livelogs/{wire,report}.json`; the Kotlin twin is
//  `:core` LiveLogs.kt and the web twin is @despia/kernel's livelogs.ts.
//
//  Everything platform-shaped lives OUTSIDE this file — the flush timer, dsx.fetch, the drawer
//  consent UI, the relay's storage. What is here is the half both ends of the wire must agree on:
//  how a ring entry becomes a wire row (scrubbed AT the fold — the telemetry law: a buffer never
//  holds an unredacted byte), the batch body, the ack fold that paces a device (viewers watching →
//  send; nobody watching → pause the wire, keep recording; pairing expired → stop), the bounded
//  device queue (drop-oldest, counted), the relay's cursor ring (monotonic seq, bounded replay,
//  the gap told to a lagging reader), and the `.dsxreport` seal (canonical bytes + sha256) with
//  its verifier verdicts.
//
//  CANONICAL BYTES, exactly: JSON with keys sorted by code point, no whitespace, minimal escaping
//  (`"` `\` \b \f \n \r \t, other controls as \u00xx), unicode raw, integers only — a non-integer
//  number has no canonical form and is refused, so a hash can never depend on float formatting.
//
//  No UIKit, no CryptoKit, no CommonCrypto: the Apple-free runner compiles this file on Linux
//  (swift_conformance_run_test.rb), so the digest is the classic 64-round SHA-256 spelled out here
//  over UTF-8 bytes, pinned by report.json against the standard vectors.
//
//  This file records nothing and sends nothing.
//
import Foundation

public enum LiveLogs {

    public static let wireVersion = 1
    public static let messageCap = 2000
    public static let batchMaxRows = 200
    public static let queueCap = 1000
    public static let idleAckPause = 30
    public static let ringCap = 2000

    /// Scrub first, then cap: redaction must see the whole text, and a clipped token must never
    /// be a leaked one.
    /// The cap counts UTF-16 CODE UNITS on every renderer (the corpus pins the boundary), and a
    /// cut that would strand a high surrogate retreats one unit — a lone surrogate has no UTF-8
    /// encoding, so it must never reach the wire or the canonical bytes.
    private static func foldMessage(_ text: String) -> String {
        let scrubbed = TelemetryScrub.text(text)
        let units = Array(scrubbed.utf16)
        if units.count <= messageCap { return scrubbed }
        let last = units[messageCap - 1]
        let cut = (0xD800...0xDBFF).contains(Int(last)) ? messageCap - 1 : messageCap
        return String(decoding: units[0..<cut], as: UTF16.self)
    }

    // ------------------------------------------------------------------ the row folds

    public static func rowFromLog(scheme: String, level: String, message: String, at: Int) -> [String: Any] {
        ["kind": "log", "scheme": scheme, "level": level, "message": foldMessage(message), "at": at]
    }

    /// A nil message OMITS the key rather than sending null — the wire never carries a value the
    /// entry did not have.
    public static func rowFromError(
        scheme: String, code: String, message: String?, recoverable: Bool, origin: String, at: Int
    ) -> [String: Any] {
        var row: [String: Any] = [
            "kind": "error", "scheme": scheme, "code": code,
            "recoverable": recoverable, "origin": origin, "at": at,
        ]
        if let message { row["message"] = foldMessage(message) }
        return row
    }

    public static func rowFromKernel(line: String, at: Int) -> [String: Any] {
        ["kind": "kernel", "message": foldMessage(line), "at": at]
    }

    /// The batch body a device POSTs: `n` is the device's monotonic batch index, the relay's
    /// idempotency key — a retried batch can never double rows.
    public static func batchBody(sid: String, n: Int, rows: [[String: Any]]) -> [String: Any] {
        ["v": wireVersion, "sid": sid, "n": n, "rows": rows]
    }

    // ------------------------------------------------------------------ the ack fold

    /// What a device knows about its session, folded from relay acks. The fold never STOPS a
    /// session — pausing is reversible (a heartbeat still carries acks, so a returning viewer
    /// resumes the wire); only the deadline passing stops it, and only `ackExpire` says so.
    public struct AckState: Equatable {
        public let idle: Int
        public let paused: Bool
        public let stopped: Bool
        public let reason: String
        public let deadline: Int

        public init(idle: Int, paused: Bool, stopped: Bool, reason: String, deadline: Int) {
            self.idle = idle
            self.paused = paused
            self.stopped = stopped
            self.reason = reason
            self.deadline = deadline
        }
    }

    public static func ackStart() -> AckState {
        AckState(idle: 0, paused: false, stopped: false, reason: "", deadline: 0)
    }

    /// A refused ack changes nothing — transport failure belongs to the queue's backoff, never to
    /// the session state.
    public static func ackFold(_ state: AckState, ok: Bool, viewers: Int, ttlMs: Int, at: Int) -> AckState {
        if !ok || state.stopped { return state }
        let deadline = at + ttlMs
        if viewers > 0 {
            return AckState(idle: 0, paused: false, stopped: false, reason: "", deadline: deadline)
        }
        let idle = state.idle + 1
        return AckState(idle: idle, paused: idle >= idleAckPause, stopped: false, reason: "",
                        deadline: deadline)
    }

    public static func ackExpire(_ state: AckState, at: Int) -> AckState {
        if state.stopped || state.deadline <= 0 || at <= state.deadline { return state }
        return AckState(idle: state.idle, paused: state.paused, stopped: true, reason: "expired",
                        deadline: state.deadline)
    }

    // ------------------------------------------------------------------ canonical bytes

    public struct CanonicalError: Error, CustomStringConvertible {
        public let description: String
    }

    /// The one canonical serialization. Refuses what has no canonical form (a non-integer number,
    /// a non-JSON value) rather than guessing one — a hash must never depend on float formatting.
    ///
    /// The NSNumber branch leads and discriminates booleans by `objCType`, never `is Bool`: an
    /// NSNumber wrapping 0 answers TRUE to `is Bool` on both Apple and corelibs Foundation
    /// (ScrollCore.finite carries the same note). The native branches behind it are for corelibs,
    /// whose JSONSerialization hands back Swift types rather than NSNumber.
    public static func canonical(_ value: Any?) throws -> String {
        guard let value, !(value is NSNull) else { return "null" }
        if let number = value as? NSNumber {
            if String(cString: number.objCType) == "c" { return number.boolValue ? "true" : "false" }
            return try integerText(number.doubleValue)
        }
        if let flag = value as? Bool { return flag ? "true" : "false" }
        if let int = value as? Int { return try integerText(Double(int)) }
        if let int64 = value as? Int64 { return try integerText(Double(int64)) }
        if let double = value as? Double { return try integerText(double) }
        if let text = value as? String { return escape(text) }
        if let list = value as? [Any] {
            return "[" + (try list.map { try canonical($0) }).joined(separator: ",") + "]"
        }
        if let record = value as? [String: Any] {
            let fields = try record.keys.sorted().map { key in
                escape(key) + ":" + (try canonical(record[key]))
            }
            return "{" + fields.joined(separator: ",") + "}"
        }
        throw CanonicalError(description: "livelogs canonical: unsupported value")
    }

    /// SAFE integers only (|n| <= 2^53-1): past that the three runtimes disagree — double text
    /// turns exponential, Long refuses, Int64 wraps — and one seal with three spellings is
    /// exactly the verdict drift the verifier exists to prevent.
    private static let safeIntegerMax = 9_007_199_254_740_991.0

    private static func integerText(_ double: Double) throws -> String {
        guard double.isFinite, double == double.rounded(),
              double >= -safeIntegerMax, double <= safeIntegerMax else {
            throw CanonicalError(description: "livelogs canonical: safe integers only")
        }
        return String(Int64(double))
    }

    /// Minimal escaping, scalar by scalar: the mandatory shorthands, other controls as lowercase
    /// `\u00xx`, everything else raw — the slash included, so a path reads as a path.
    private static func escape(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    let hex = String(scalar.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    out.append(Character(scalar))
                }
            }
        }
        return out + "\""
    }

    // ------------------------------------------------------------------ sha256 (sync)

    private static let sha256Round: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    private static func rotr(_ value: UInt32, _ by: UInt32) -> UInt32 {
        (value >> by) | (value << (32 - by))
    }

    /// Self-contained on purpose: CryptoKit would bar the Apple-free runner from compiling this
    /// file, and a seal and its verifier must work identically wherever the wire does. Pinned by
    /// the corpus against the standard vectors, byte-for-byte with the twins.
    public static func sha256Hex(_ text: String) -> String {
        var bytes = Array(text.utf8)
        let bitLength = UInt64(bytes.count) * 8
        bytes.append(0x80)
        while bytes.count % 64 != 56 { bytes.append(0) }
        var shift = 56
        while shift >= 0 {
            bytes.append(UInt8(truncatingIfNeeded: bitLength >> UInt64(shift)))
            shift -= 8
        }

        var digest: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
        var schedule = [UInt32](repeating: 0, count: 64)
        var offset = 0
        while offset < bytes.count {
            for index in 0..<16 {
                let base = offset + index * 4
                schedule[index] = (UInt32(bytes[base]) << 24) | (UInt32(bytes[base + 1]) << 16)
                    | (UInt32(bytes[base + 2]) << 8) | UInt32(bytes[base + 3])
            }
            for index in 16..<64 {
                let w15 = schedule[index - 15]
                let w2 = schedule[index - 2]
                let s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >> 3)
                let s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >> 10)
                schedule[index] = schedule[index - 16] &+ s0 &+ schedule[index - 7] &+ s1
            }
            var a = digest[0], b = digest[1], c = digest[2], d = digest[3]
            var e = digest[4], f = digest[5], g = digest[6], h = digest[7]
            for index in 0..<64 {
                let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
                let ch = (e & f) ^ (~e & g)
                let temp1 = h &+ s1 &+ ch &+ sha256Round[index] &+ schedule[index]
                let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
                let maj = (a & b) ^ (a & c) ^ (b & c)
                let temp2 = s0 &+ maj
                h = g; g = f; f = e; e = d &+ temp1
                d = c; c = b; b = a; a = temp1 &+ temp2
            }
            digest[0] &+= a; digest[1] &+= b; digest[2] &+= c; digest[3] &+= d
            digest[4] &+= e; digest[5] &+= f; digest[6] &+= g; digest[7] &+= h
            offset += 64
        }

        return digest.map { word -> String in
            let hex = String(word, radix: 16)
            return String(repeating: "0", count: 8 - hex.count) + hex
        }.joined()
    }

    // ------------------------------------------------------------------ the report seal

    /// Seal a report body: the hash covers the canonical bytes WITHOUT the receipt, the sealed
    /// text is the canonical bytes WITH it. A body arriving with a receipt is re-sealed, never
    /// trusted.
    public static func reportSeal(_ body: [String: Any]) throws -> (hash: String, text: String) {
        var bare = body
        bare.removeValue(forKey: "receipt")
        let hash = sha256Hex(try canonical(bare))
        var sealed = bare
        sealed["receipt"] = ["alg": "sha256", "hash": hash] as [String: Any]
        return (hash: hash, text: try canonical(sealed))
    }

    /// The verifier — the support macro as a function. `not_report` is the verdict the motivating
    /// incident dies at (an AI-fabricated state dump is not the envelope); `modified` means the
    /// envelope shape is right and the bytes are not; `genuine` means the hash verifies.
    /// `assertion` reports whether an integrity attestation rides a GENUINE seal — verifying that
    /// attestation against Apple/Google is the relay/platform's job, never this core's.
    public static func reportVerdict(_ text: String) -> (verdict: String, assertion: Bool) {
        guard let parsed = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
              let doc = parsed as? [String: Any],
              doc["kind"] as? String == "dsxreport",
              wireOne(doc["v"]),
              let receipt = doc["receipt"] as? [String: Any],
              receipt["alg"] as? String == "sha256",
              let hash = receipt["hash"] as? String, hashShaped(hash) else {
            return (verdict: "not_report", assertion: false)
        }
        var body = doc
        body.removeValue(forKey: "receipt")
        guard let bytes = try? canonical(body), sha256Hex(bytes) == hash else {
            return (verdict: "modified", assertion: false)
        }
        return (verdict: "genuine", assertion: (receipt["integrity"] as? [String: Any]) != nil)
    }

    /// `v` must be the NUMBER 1 — a boolean true is not a version, exactly as `!== 1` refuses it
    /// in the TS twin.
    private static func wireOne(_ value: Any?) -> Bool {
        if let number = value as? NSNumber {
            if String(cString: number.objCType) == "c" { return false }
            return number.doubleValue == 1
        }
        if value is Bool { return false }
        if let int = value as? Int { return int == 1 }
        if let int64 = value as? Int64 { return int64 == 1 }
        if let double = value as? Double { return double == 1 }
        return false
    }

    /// The receipt hash's shape gate, `^[0-9a-f]{64}$` without a regex engine: 64 bytes, each a
    /// lowercase hex digit.
    private static func hashShaped(_ text: String) -> Bool {
        guard text.utf8.count == 64 else { return false }
        for byte in text.utf8 {
            let digit = byte >= 0x30 && byte <= 0x39
            let lowerHex = byte >= 0x61 && byte <= 0x66
            if !digit && !lowerHex { return false }
        }
        return true
    }
}

/// The bounded outbound queue: drop-oldest with a counted drop (the relay is told what it did not
/// receive), a batch PEEKS and only the ack removes — a refused POST loses nothing. Pure, like
/// TelemetryQueue: the platform half owns the timer and the transport.
public final class LiveQueue<Element> {

    public let cap: Int
    private var items: [Element] = []
    private var droppedCount = 0
    // A PEEKED BATCH IS PINNED: the exact-retry law says attempt 2 carries the SAME rows as
    // attempt 1, so the cap evicts the oldest UNPINNED row — never the in-flight head — and a
    // fully-pinned queue drops the newcomer, counted. Corpus: livelogs/wire.json `queue`.
    private var pinned = 0

    public init(cap: Int) {
        self.cap = cap
    }

    public var size: Int { items.count }

    /// Rows lost to the bound, ever — reported upstream so the viewer sees its own blind spot.
    public var dropped: Int { droppedCount }

    @discardableResult
    public func push(_ item: Element) -> (size: Int, dropped: Int) {
        if items.count >= cap {
            droppedCount += 1
            if pinned >= items.count {
                return (size: items.count, dropped: droppedCount)
            }
            items.remove(at: pinned)
        }
        items.append(item)
        return (size: items.count, dropped: droppedCount)
    }

    /// PEEKS — the queue is untouched until the relay's ack says the rows landed; what it
    /// returns is pinned.
    public func batch(_ max: Int) -> [Element] {
        let peeked = Array(items.prefix(Swift.max(0, max)))
        pinned = peeked.count
        return peeked
    }

    /// Drop the first `count` rows — called only after the relay accepted them. Never underflows.
    @discardableResult
    public func ack(_ count: Int) -> Int {
        let removed = Swift.max(0, Swift.min(count, items.count))
        items.removeFirst(removed)
        pinned = Swift.max(0, pinned - removed)
        return items.count
    }

    public func clear() {
        items.removeAll()
        droppedCount = 0
        pinned = 0
    }
}

/// The relay's replay ring — the durable-cursor-feed law (realtime.ts) over live rows: seq is
/// assigned monotonically from 1, a read resumes after a cursor, the bound evicts oldest, and a
/// reader whose cursor predates the ring is TOLD about the gap rather than silently spliced.
public final class LiveRing<Element> {

    public let cap: Int
    private var entries: [(seq: Int, row: Element)] = []
    private var lastSeq = 0
    private var lastBatch = 0

    public init(cap: Int) {
        self.cap = cap
    }

    public var last: Int { lastSeq }

    /// The batch index is the idempotency key: a replayed `n` is refused whole, so a retried POST
    /// can never duplicate rows and seq stays a truth a cursor can rely on.
    public func appendBatch(_ n: Int, rows: [Element]) -> (accepted: Bool, last: Int) {
        if n <= lastBatch { return (accepted: false, last: lastSeq) }
        lastBatch = n
        for row in rows {
            lastSeq += 1
            entries.append((seq: lastSeq, row: row))
            if entries.count > cap { entries.removeFirst() }
        }
        return (accepted: true, last: lastSeq)
    }

    public func read(after: Int, limit: Int) -> (rows: [(seq: Int, row: Element)], gap: Bool) {
        let oldest = entries.first?.seq ?? 0
        let gap = !entries.isEmpty && after < oldest - 1
        var rows: [(seq: Int, row: Element)] = []
        for entry in entries {
            if entry.seq <= after { continue }
            rows.append(entry)
            if rows.count >= Swift.max(0, limit) { break }
        }
        return (rows: rows, gap: gap)
    }
}
