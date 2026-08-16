//
//  Json.swift - the binding's own JSON.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  Everything crossing despia_local.h is UTF-8 JSON, so this binding needs to read
//  and write it. It ships its own for the same reason the C++ core and the Kotlin
//  binding do: a JSON library would need a pin, a NOTICE line, an SBOM component
//  and a CVE watch, and what crosses this seam is one well-known document shape.
//
//  The twin of bindings/kotlin-jvm/.../Json.kt, field for field, including the two
//  properties that are load-bearing rather than tidy:
//
//    ORDER. Objects keep insertion order, because the corpus runners iterate a
//    case's `seed` and `mock.models` and a hash-ordered walk would make a run
//    depend on hashing.
//
//    BYTE STABILITY. Rendering SORTS keys, so one document has exactly one
//    serialization - which is what lets two runners compare renderings instead of
//    object identity, and what makes `subsetMatch`'s scalar arm a string compare.
//
//  Spelled `Json`, not `JSON`, deliberately. The Despia kernel declares its own
//  `JSON` and a module that imports this package must be able to name both without
//  qualifying either; the Kotlin lane solves the same collision with
//  `import com.despia.local.Json as BaseJson`.
//
//  Deliberately small and bounded: parse, render, and the typed accessors the
//  store face uses. `maxDepth` is enforced because a stored `value` is whatever
//  the app put there, and an app's data is not the engine's own envelope.
//

import Foundation

/// An insertion-ordered JSON object. Reads are by key; iteration is by the order
/// the keys arrived.
public struct JsonObject: Sendable, Equatable {
    public private(set) var keys: [String] = []
    private var storage: [String: Json] = [:]

    public init() {}

    public init(_ pairs: [(String, Json)]) {
        for (key, value) in pairs { set(key, value) }
    }

    public subscript(key: String) -> Json? { storage[key] }

    public mutating func set(_ key: String, _ value: Json) {
        if storage[key] == nil { keys.append(key) }
        storage[key] = value
    }

    public func has(_ key: String) -> Bool { storage[key] != nil }
    public var count: Int { keys.count }
    public var isEmpty: Bool { keys.isEmpty }

    /// The pairs in insertion order.
    public var pairs: [(String, Json)] { keys.map { ($0, storage[$0] ?? .null) } }

    public static func == (lhs: JsonObject, rhs: JsonObject) -> Bool {
        lhs.storage == rhs.storage
    }
}

public enum JsonError: Error, CustomStringConvertible {
    case syntax(String)

    public var description: String {
        switch self {
        case .syntax(let why): return "invalid JSON: \(why)"
        }
    }
}

public enum Json: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([Json])
    case object(JsonObject)

    public static let maxDepth = 64

    // MARK: - construction

    /// The empty object, which is what an action with no arguments sends and what
    /// an action with nothing to say answers.
    public static var empty: Json { .object(JsonObject()) }

    public static func obj(_ pairs: [(String, Json)]) -> Json { .object(JsonObject(pairs)) }

    public static func of(_ value: String) -> Json { .string(value) }
    public static func of(_ value: Int) -> Json { .number(Double(value)) }
    public static func of(_ value: Double) -> Json { .number(value) }
    public static func of(_ value: Bool) -> Json { .bool(value) }
    public static func of(_ values: [String]) -> Json { .array(values.map { .string($0) }) }
    public static func of(_ values: [Double]) -> Json { .array(values.map { .number($0) }) }

    // MARK: - accessors
    //
    // A missing key reads as `.null` rather than throwing, because a must-ignore
    // consumer asks for fields it may not get, constantly.

    public subscript(key: String) -> Json {
        guard case .object(let fields) = self else { return .null }
        return fields[key] ?? .null
    }

    public subscript(index: Int) -> Json {
        guard case .array(let values) = self, index >= 0, index < values.count else { return .null }
        return values[index]
    }

    public var items: [Json] {
        guard case .array(let values) = self else { return [] }
        return values
    }

    public var fields: JsonObject {
        guard case .object(let fields) = self else { return JsonObject() }
        return fields
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    public var isArray: Bool {
        if case .array = self { return true }
        return false
    }

    public var isNumber: Bool {
        if case .number = self { return true }
        return false
    }

    public var isObject: Bool {
        if case .object = self { return true }
        return false
    }

    public func has(_ key: String) -> Bool {
        guard case .object(let fields) = self else { return false }
        return fields.has(key)
    }

    public func string(_ fallback: String = "") -> String {
        guard case .string(let value) = self else { return fallback }
        return value
    }

    public var stringOrNull: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    public func number(_ fallback: Double = 0) -> Double {
        guard case .number(let value) = self else { return fallback }
        return value
    }

    public func int(_ fallback: Int = 0) -> Int {
        guard case .number(let value) = self, value.isFinite else { return fallback }
        return Int(value)
    }

    public func bool(_ fallback: Bool = false) -> Bool {
        guard case .bool(let value) = self else { return fallback }
        return value
    }

    /// Every string in an array, skipping anything that is not one.
    public var strings: [String] { items.compactMap { $0.stringOrNull } }

    /// Every element of an array as a number. Non-numbers read as 0, matching
    /// `Json.numbers()` on the Kotlin lane.
    public var numbers: [Double] { items.map { $0.number() } }

    // MARK: - rendering

    /// One document, one serialization. Keys are sorted so the output is
    /// byte-stable across runs and across the three implementations.
    public func render() -> String {
        switch self {
        case .null:
            return "null"
        case .bool(let value):
            return value ? "true" : "false"
        case .number(let value):
            return Json.renderNumber(value)
        case .string(let value):
            return Json.escape(value)
        case .array(let values):
            return "[" + values.map { $0.render() }.joined(separator: ",") + "]"
        case .object(let fields):
            let body = fields.keys.sorted().map { key in
                Json.escape(key) + ":" + (fields[key] ?? .null).render()
            }
            return "{" + body.joined(separator: ",") + "}"
        }
    }

    private static func renderNumber(_ value: Double) -> String {
        guard value.isFinite else { return "null" }
        // An integral double renders as an integer, so a count that arrived as
        // `2` does not become `2.0` - the corpus asserts the type vocabulary
        // round-trips and a page comparing `=== 2` is entitled to be right.
        if value == value.rounded(.towardZero),
           value >= -9_007_199_254_740_992, value <= 9_007_199_254_740_992 {
            return String(Int64(value))
        }
        return String(value)
    }

    private static func escape(_ text: String) -> String {
        var out = "\""
        out.reserveCapacity(text.count + 2)
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    // MARK: - the Foundation bridge
    //
    // A host speaks Foundation values (what JSONSerialization and a native bus
    // hand around) and this binding speaks Json. Both directions live HERE rather
    // than in each host, for the reason the whole package exists: a conversion
    // copied into a wrapper is a conversion nobody tests. The Kotlin twin is
    // BaseStore.kt's toBase/fromBase, and this is deliberately the same pair of
    // rules - including the one that is easy to get wrong.

    /// The Foundation form. `nil` for JSON null, so a caller can put the result
    /// straight into a `[String: Any?]` and keep the key.
    ///
    /// WHOLE NUMBERS CROSS AS INTEGERS. A count that arrived as `2` must not
    /// reach a page as `2.0`: the corpus asserts the type vocabulary round-trips,
    /// and a page comparing `=== 2` is entitled to be right.
    public var foundationValue: Any? {
        switch self {
        case .null:
            return nil
        case .bool(let flag):
            return flag
        case .number(let value):
            if value == value.rounded(.towardZero), value.magnitude < 9_007_199_254_740_992 {
                return Int(value)
            }
            return value
        case .string(let text):
            return text
        case .array(let values):
            return values.map { $0.foundationValue }
        case .object(let fields):
            var out: [String: Any?] = [:]
            // updateValue, not `out[key] = …`: assigning nil through the subscript
            // would REMOVE the key, and "the store answered null" is not the same
            // answer as "the store said nothing".
            for (key, value) in fields.pairs { out.updateValue(value.foundationValue, forKey: key) }
            return out
        }
    }

    /// The other direction. Anything this does not recognise becomes its
    /// description rather than being dropped, because a value the host could not
    /// name is still better carried than silently lost.
    public init(foundation value: Any?) {
        switch value {
        case nil, is NSNull:
            self = .null
        case let json as Json:
            self = json
        case let number as NSNumber:
            // CFBoolean bridges to NSNumber, so booleans are separated by their
            // ObjC type rather than by a cast that would turn `true` into 1.
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else {
                self = .number(number.doubleValue)
            }
        case let text as String:
            self = .string(text)
        case let list as [Any]:
            self = .array(list.map { Json(foundation: $0) })
        case let map as [String: Any]:
            var out = JsonObject()
            for (key, element) in map { out.set(key, Json(foundation: element)) }
            self = .object(out)
        case let other?:
            // Unwrapped before `String(describing:)` so the text is the value and
            // not "Optional(the value)". With `case nil` above, these two arms
            // cover the whole of Any? and no default is reachable.
            self = .string(String(describing: other))
        }
    }

    // MARK: - parsing

    public static func parse(_ text: String) throws -> Json {
        var parser = JsonParser(text)
        let value = try parser.value(0)
        parser.skipWhitespace()
        guard parser.atEnd else {
            throw JsonError.syntax("trailing content at offset \(parser.offset)")
        }
        return value
    }

    public static func parseOrNull(_ text: String) -> Json? { try? parse(text) }
}

// MARK: - the parser

private struct JsonParser {
    private let scalars: [Unicode.Scalar]
    private(set) var offset = 0

    init(_ text: String) { scalars = Array(text.unicodeScalars) }

    var atEnd: Bool { offset >= scalars.count }

    mutating func skipWhitespace() {
        while offset < scalars.count {
            let scalar = scalars[offset]
            guard scalar == " " || scalar == "\t" || scalar == "\n" || scalar == "\r" else { return }
            offset += 1
        }
    }

    mutating func value(_ depth: Int) throws -> Json {
        guard depth <= Json.maxDepth else {
            throw JsonError.syntax("nesting too deep at offset \(offset)")
        }
        skipWhitespace()
        guard !atEnd else { throw JsonError.syntax("unexpected end of input") }
        switch scalars[offset] {
        case "{": return try object(depth)
        case "[": return try array(depth)
        case "\"": return .string(try str())
        case "t": return try literal("true", .bool(true))
        case "f": return try literal("false", .bool(false))
        case "n": return try literal("null", .null)
        default: return try num()
        }
    }

    private mutating func literal(_ word: String, _ value: Json) throws -> Json {
        let expected = Array(word.unicodeScalars)
        guard offset + expected.count <= scalars.count,
              Array(scalars[offset ..< offset + expected.count]) == expected else {
            throw JsonError.syntax("bad literal at offset \(offset)")
        }
        offset += expected.count
        return value
    }

    private mutating func object(_ depth: Int) throws -> Json {
        offset += 1   // '{'
        var out = JsonObject()
        skipWhitespace()
        if !atEnd, scalars[offset] == "}" { offset += 1; return .object(out) }
        while true {
            skipWhitespace()
            let key = try str()
            skipWhitespace()
            guard !atEnd, scalars[offset] == ":" else {
                throw JsonError.syntax("expected ':' at offset \(offset)")
            }
            offset += 1
            out.set(key, try value(depth + 1))
            skipWhitespace()
            guard !atEnd else { throw JsonError.syntax("unterminated object") }
            switch scalars[offset] {
            case ",": offset += 1
            case "}": offset += 1; return .object(out)
            default: throw JsonError.syntax("expected ',' or '}' at offset \(offset)")
            }
        }
    }

    private mutating func array(_ depth: Int) throws -> Json {
        offset += 1   // '['
        var out: [Json] = []
        skipWhitespace()
        if !atEnd, scalars[offset] == "]" { offset += 1; return .array(out) }
        while true {
            out.append(try value(depth + 1))
            skipWhitespace()
            guard !atEnd else { throw JsonError.syntax("unterminated array") }
            switch scalars[offset] {
            case ",": offset += 1
            case "]": offset += 1; return .array(out)
            default: throw JsonError.syntax("expected ',' or ']' at offset \(offset)")
            }
        }
    }

    private mutating func str() throws -> String {
        guard !atEnd, scalars[offset] == "\"" else {
            throw JsonError.syntax("expected a string at offset \(offset)")
        }
        offset += 1
        var units: [UInt16] = []
        while offset < scalars.count {
            let scalar = scalars[offset]
            offset += 1
            if scalar == "\"" {
                return String(decoding: units, as: UTF16.self)
            }
            if scalar != "\\" {
                JsonParser.appendUTF16(scalar, to: &units)
                continue
            }
            guard offset < scalars.count else { throw JsonError.syntax("truncated escape") }
            let escape = scalars[offset]
            offset += 1
            switch escape {
            case "\"": units.append(0x22)
            case "\\": units.append(0x5C)
            case "/": units.append(0x2F)
            case "n": units.append(0x0A)
            case "r": units.append(0x0D)
            case "t": units.append(0x09)
            case "b": units.append(0x08)
            case "f": units.append(0x0C)
            case "u":
                // Collected as UTF-16 code units so a surrogate PAIR reassembles
                // into one scalar. Decoding each escape on its own would reject
                // any character outside the BMP.
                guard offset + 4 <= scalars.count else {
                    throw JsonError.syntax("truncated \\u escape")
                }
                var code: UInt32 = 0
                for _ in 0 ..< 4 {
                    guard let digit = JsonParser.hex(scalars[offset]) else {
                        throw JsonError.syntax("bad \\u escape at offset \(offset)")
                    }
                    code = code * 16 + digit
                    offset += 1
                }
                units.append(UInt16(truncatingIfNeeded: code))
            default:
                throw JsonError.syntax("unknown escape")
            }
        }
        throw JsonError.syntax("unterminated string")
    }

    /// Encoded by hand rather than through a String round-trip: the surrogate
    /// arithmetic is the whole point, and it has to be visible.
    private static func appendUTF16(_ scalar: Unicode.Scalar, to units: inout [UInt16]) {
        if scalar.value <= 0xFFFF {
            units.append(UInt16(scalar.value))
        } else {
            let value = scalar.value - 0x10000
            units.append(UInt16(0xD800 + (value >> 10)))
            units.append(UInt16(0xDC00 + (value & 0x3FF)))
        }
    }

    private static func hex(_ scalar: Unicode.Scalar) -> UInt32? {
        switch scalar.value {
        case 0x30 ... 0x39: return scalar.value - 0x30
        case 0x41 ... 0x46: return scalar.value - 0x41 + 10
        case 0x61 ... 0x66: return scalar.value - 0x61 + 10
        default: return nil
        }
    }

    private mutating func num() throws -> Json {
        let start = offset
        if !atEnd, scalars[offset] == "-" || scalars[offset] == "+" { offset += 1 }
        while !atEnd {
            let scalar = scalars[offset]
            let isDigit = scalar.value >= 0x30 && scalar.value <= 0x39
            guard isDigit || scalar == "." || scalar == "e" || scalar == "E"
                    || scalar == "+" || scalar == "-" else { break }
            offset += 1
        }
        var text = ""
        for scalar in scalars[start ..< offset] { text.unicodeScalars.append(scalar) }
        guard let value = Double(text) else {
            throw JsonError.syntax("bad number at offset \(start)")
        }
        return .number(value)
    }
}
