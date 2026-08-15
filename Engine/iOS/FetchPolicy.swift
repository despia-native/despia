// FetchPolicy.swift
//
// Deterministic input and memory boundaries for the public `dsx.fetch` plane.
// Request construction is kept separate from Context so it can be exercised
// without a live network and shared verbatim by every native fetch caller.

import Foundation

enum DSXFetchPolicyError: Error, Equatable {
    case requestTooLarge
    case invalidBody
    case invalidMethod
    case invalidHeaders
}

enum DSXFetchPolicy {
    static let maximumRequestBytes = 4 * 1_024 * 1_024
    static let maximumResponseBytes = 16 * 1_024 * 1_024
    static let maximumJSONDepth = 64
    static let maximumJSONNodes = 100_000
    static let maximumURLBytes = 64 * 1_024
    static let maximumHeaderBytes = 256 * 1_024
    static let maximumHeaderCount = 256
    static let defaultTimeout: TimeInterval = 30
    static let maximumTimeout: TimeInterval = 10 * 60
    private static let minimumTimeout: TimeInterval = 0.001

    /// Accept only absolute HTTP(S) URLs with a real host and no embedded credentials.
    /// App Store builds are HTTPS-only; test channels may deliberately use HTTP for a
    /// local development origin. Query values are appended through URLComponents so
    /// they cannot alter the destination authority.
    static func validatedURL(_ raw: String,
                             query: [String: String],
                             allowCleartext: Bool) -> URL? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty,
              value.utf8.count <= maximumURLBytes,
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              query.count <= 1_024,
              var components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || (allowCleartext && scheme == "http"),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil else { return nil }
        if let port = components.port, !(1...65_535).contains(port) { return nil }

        if !query.isEmpty {
            // Bound caller-controlled query storage before URLQueryItem percent-encoding
            // allocates an intermediate string. Include the already-authored URL bytes and
            // separator overhead; the final encoded URL receives its own exact check below.
            var queryBudget = value.utf8.count
            for (key, itemValue) in query {
                for count in [key.utf8.count, itemValue.utf8.count, 2] {
                    guard count <= maximumURLBytes - queryBudget else { return nil }
                    queryBudget += count
                }
            }
            var items = components.queryItems ?? []
            items.reserveCapacity(items.count + query.count)
            for (key, value) in query.sorted(by: { $0.key < $1.key }) {
                items.append(URLQueryItem(name: key, value: value))
            }
            components.queryItems = items
        }
        guard let url = components.url,
              url.absoluteString.utf8.count <= maximumURLBytes else { return nil }
        return url
    }

    static func validatedMethod(_ raw: String) -> String? {
        let method = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if method.isEmpty { return "GET" }
        guard method.utf8.count <= 32,
              method.utf8.allSatisfy(isHTTPTokenByte) else { return nil }
        return method
    }

    static func headersAreValid(_ headers: [String: String]) -> Bool {
        guard headers.count <= maximumHeaderCount else { return false }
        var total = 0
        for (name, value) in headers {
            let nameBytes = name.utf8.count
            let valueBytes = value.utf8.count
            guard nameBytes > 0, nameBytes <= 256,
                  name.utf8.allSatisfy(isHTTPTokenByte),
                  !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  nameBytes <= maximumHeaderBytes - total else { return false }
            total += nameBytes
            guard valueBytes <= maximumHeaderBytes - total else { return false }
            total += valueBytes
        }
        return true
    }

    static func clampedTimeout(_ configured: TimeInterval) -> TimeInterval {
        guard configured.isFinite, configured > 0 else { return defaultTimeout }
        return min(maximumTimeout, max(minimumTimeout, configured))
    }

    /// Preflight the value graph before Foundation materializes a recursive object tree,
    /// then enforce the exact serialized byte ceiling as a second line of defence.
    static func encodedBody(_ root: JSON) throws -> Data {
        try preflight(root)
        let data: Data
        do {
            data = try JSONSerialization.data(
                withJSONObject: root.foundationValue,
                options: [.fragmentsAllowed]
            )
        } catch {
            throw DSXFetchPolicyError.invalidBody
        }
        guard data.count <= maximumRequestBytes else {
            throw DSXFetchPolicyError.requestTooLarge
        }
        return data
    }

    private static func preflight(_ root: JSON) throws {
        var pending: [(value: JSON, depth: Int)] = [(root, 0)]
        var nodes = 0
        var estimatedBytes = 0

        func addBytes(_ count: Int) throws {
            guard count >= 0, count <= maximumRequestBytes - estimatedBytes else {
                throw DSXFetchPolicyError.requestTooLarge
            }
            estimatedBytes += count
        }

        func addJSONString(_ string: String) throws {
            try addBytes(2) // surrounding quotes
            try addBytes(string.lengthOfBytes(using: .utf8))
            for byte in string.utf8 {
                switch byte {
                case 0x22, 0x5C:
                    try addBytes(1)
                case 0x00...0x1F:
                    try addBytes(5)
                default:
                    break
                }
            }
        }

        while let next = pending.popLast() {
            nodes += 1
            guard nodes <= maximumJSONNodes, next.depth <= maximumJSONDepth else {
                throw DSXFetchPolicyError.requestTooLarge
            }
            switch next.value {
            case .object(let dictionary):
                guard dictionary.count <= maximumJSONNodes - nodes - pending.count,
                      next.depth < maximumJSONDepth || dictionary.isEmpty else {
                    throw DSXFetchPolicyError.requestTooLarge
                }
                try addBytes(2 + (dictionary.count * 2))
                for (key, value) in dictionary {
                    try addJSONString(key)
                    pending.append((value, next.depth + 1))
                }
            case .array(let array):
                guard array.count <= maximumJSONNodes - nodes - pending.count,
                      next.depth < maximumJSONDepth || array.isEmpty else {
                    throw DSXFetchPolicyError.requestTooLarge
                }
                try addBytes(2 + array.count)
                for value in array { pending.append((value, next.depth + 1)) }
            case .string(let string):
                try addJSONString(string)
            case .int(let value):
                try addBytes(String(value).utf8.count)
            case .double(let value):
                guard value.isFinite else { throw DSXFetchPolicyError.invalidBody }
                try addBytes(32)
            case .bool(let value):
                try addBytes(value ? 4 : 5)
            case .null:
                try addBytes(4)
            }
        }
    }

    private static func isHTTPTokenByte(_ byte: UInt8) -> Bool {
        switch byte {
        case 0x30...0x39, 0x41...0x5A, 0x61...0x7A,
             0x21, 0x23...0x27, 0x2A, 0x2B, 0x2D, 0x2E,
             0x5E, 0x5F, 0x60, 0x7C, 0x7E:
            return true
        default:
            return false
        }
    }
}
