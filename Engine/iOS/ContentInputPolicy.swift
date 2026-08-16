// ContentInputPolicy.swift
// Pure cross-platform-safe manifest identifier policy, kept separate so hostile
// path/hash cases can be tested without constructing the content store.

import Foundation
import CoreFoundation

enum DSXContentInputPolicy {
    static func normalizeRelativePath(_ path: String, maximumUTF8Bytes: Int = 1_024,
                                      reservedComponent: String = ".dsx-complete") -> String {
        let value = path
        guard value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty, value.utf8.count <= maximumUTF8Bytes,
              !value.hasPrefix("/"), !value.contains("%"),
              !value.contains(":"), !value.contains("\\"),
              !value.contains("://"),
              !value.unicodeScalars.contains(where: {
                  $0.value == 0 || $0.value < 0x20 || $0.value == 0x7f
              }) else { return "" }
        let components = value.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !components.isEmpty,
              components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0 != reservedComponent }) else {
            return ""
        }
        return components.joined(separator: "/")
    }

    static func validSHA256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy {
            ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66)
        }
    }

    /// Parse a JSON integer without NSNumber's lossy `intValue` coercions. JSON booleans bridge
    /// to NSNumber and floating-point spellings such as `1.0`/`1e0` are numerically integral, but
    /// neither is an integer token. Reject them so signed manifests have one representation on
    /// Swift and Kotlin, and reject unsigned values above Int64.max before conversion.
    static func strictNonnegativeInteger(_ value: Any) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              !CFNumberIsFloatType(number),
              let parsed = Int64(number.stringValue), parsed >= 0,
              parsed <= Int64(Int.max) else { return nil }
        return Int(parsed)
    }
}

enum DSXContentMemoryPolicy {
    static let maximumSingleDataBytes = 32 * 1_024 * 1_024
    static let maximumAggregateDataBytes = 64 * 1_024 * 1_024
    static let maximumBatchItems = 64

    static func permits(advertisedBytes: Int64, maximumBytes: Int) -> Bool {
        maximumBytes >= 0 && advertisedBytes >= 0 && advertisedBytes <= Int64(maximumBytes)
    }

    static func permitsAppend(currentBytes: Int, newBytes: Int) -> Bool {
        currentBytes >= 0 && newBytes >= 0
            && currentBytes <= maximumAggregateDataBytes
            && newBytes <= maximumAggregateDataBytes - currentBytes
    }

    static func readFile(at url: URL, maximumBytes: Int) -> Data? {
        guard maximumBytes >= 0,
              let values = try? url.resourceValues(forKeys: [
                .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey
              ]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let advertised = values.fileSize,
              permits(advertisedBytes: Int64(advertised), maximumBytes: maximumBytes),
              let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }

        var result = Data()
        if advertised > 0 { result.reserveCapacity(advertised) }
        while true {
            let remaining = maximumBytes - result.count
            let count = min(1_048_576, remaining + 1)
            let chunk: Data
            do {
                chunk = try handle.read(upToCount: count) ?? Data()
            } catch {
                return nil
            }
            guard !chunk.isEmpty else { return result }
            result.append(chunk)
            guard result.count <= maximumBytes else { return nil }
        }
    }
}

/// Pure limits shared by the native image and SVG components. Keeping the arithmetic here
/// makes decompression-bomb and malformed-URL cases executable without UIKit/SwiftUI.
enum DSXMediaInputPolicy {
    static let maximumURLBytes = 8 * 1_024
    static let maximumAssetPathBytes = 1_024
    static let maximumEncodedImageBytes = 16 * 1_024 * 1_024
    static let maximumDecodedPixels: Int64 = 32_000_000
    static let maximumDecodedBytes: Int64 = 128 * 1_024 * 1_024
    static let maximumPixelDimension = 8_192
    static let maximumAnimationFrames = 120
    static let maximumSVGBytes = 1 * 1_024 * 1_024
    static let maximumSVGPrimitives = 4_096
    static let maximumSVGPathTokens = 100_000

    struct Dimensions: Equatable {
        let width: Int
        let height: Int
        let frames: Int
    }

    static func validatedRemoteImageURL(_ raw: String) -> URL? {
        guard !raw.isEmpty, raw.utf8.count <= maximumURLBytes,
              raw == raw.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.unicodeScalars.contains(where: {
                  CharacterSet.whitespacesAndNewlines.contains($0)
                      || CharacterSet.controlCharacters.contains($0)
              }),
              let components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              validAuthorityPort(in: raw),
              let url = components.url else { return nil }
        if let port = components.port, !(1...65_535).contains(port) { return nil }
        return url
    }

    static func validatedRemoteImageURL(_ url: URL) -> URL? {
        guard url.baseURL == nil else { return nil }
        return validatedRemoteImageURL(url.absoluteString)
    }

    static func normalizedAssetPath(_ raw: String) -> String? {
        let normalized = DSXContentInputPolicy.normalizeRelativePath(
            raw, maximumUTF8Bytes: maximumAssetPathBytes, reservedComponent: ".dsx-complete")
        return normalized.isEmpty ? nil : normalized
    }

    static func acceptsSVGMarkup(_ markup: String) -> Bool {
        markup.utf8.count <= maximumSVGBytes
    }

    static func targetDimensions(width: Int, height: Int, frames: Int = 1) -> Dimensions? {
        guard width > 0, height > 0, (1...maximumAnimationFrames).contains(frames) else { return nil }
        let (pixels, pixelOverflow) = Int64(width).multipliedReportingOverflow(by: Int64(height))
        let perFrameLimit = maximumDecodedPixels / Int64(frames)
        guard !pixelOverflow, pixels > 0, perFrameLimit > 0 else { return nil }
        let scale = min(
            1,
            Double(maximumPixelDimension) / Double(width),
            Double(maximumPixelDimension) / Double(height),
            sqrt(Double(perFrameLimit) / Double(pixels))
        )
        var targetWidth = max(1, Int(floor(Double(width) * scale)))
        var targetHeight = max(1, Int(floor(Double(height) * scale)))
        while Int64(targetWidth) * Int64(targetHeight) > perFrameLimit {
            if targetWidth >= targetHeight { targetWidth -= 1 } else { targetHeight -= 1 }
        }
        return Dimensions(width: targetWidth, height: targetHeight, frames: frames)
    }

    static func decodedCostBytes(_ dimensions: Dimensions) -> Int? {
        guard dimensions.width > 0, dimensions.height > 0 else { return nil }
        let (pixels, pixelOverflow) = Int64(dimensions.width).multipliedReportingOverflow(
            by: Int64(dimensions.height))
        guard dimensions.frames > 0,
              !pixelOverflow,
              pixels > 0,
              pixels <= maximumDecodedPixels / Int64(dimensions.frames) else { return nil }
        let (aggregatePixels, frameOverflow) = pixels.multipliedReportingOverflow(by: Int64(dimensions.frames))
        let (bytes, byteOverflow) = aggregatePixels.multipliedReportingOverflow(by: 4)
        guard !frameOverflow, !byteOverflow,
              bytes > 0, bytes <= maximumDecodedBytes, bytes <= Int64(Int.max) else { return nil }
        return Int(bytes)
    }

    private static func validAuthorityPort(in raw: String) -> Bool {
        guard let schemeEnd = raw.range(of: "://") else { return false }
        let remainder = raw[schemeEnd.upperBound...]
        let authority = remainder.prefix { $0 != "/" && $0 != "?" && $0 != "#" }
        guard !authority.isEmpty else { return false }
        if authority.first == "[" {
            guard let closing = authority.firstIndex(of: "]") else { return false }
            let suffix = authority[authority.index(after: closing)...]
            if suffix.isEmpty { return true }
            guard suffix.first == ":" else { return false }
            return validPortText(suffix.dropFirst())
        }
        guard let colon = authority.lastIndex(of: ":") else { return true }
        return validPortText(authority[authority.index(after: colon)...])
    }

    private static func validPortText<S: StringProtocol>(_ text: S) -> Bool {
        guard !text.isEmpty, text.allSatisfy({ $0.isNumber }),
              let port = Int(text), (1...65_535).contains(port) else { return false }
        return true
    }
}
