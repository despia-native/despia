//
//  JSON.swift - the binding's own JSON.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  The C ABI speaks JSON, so this binding needs to read it. It ships its own for
//  the same reason the C++ core and the Kotlin binding do: a JSON library would
//  need a pin, a NOTICE line, an SBOM component and a CVE watch, and what
//  crosses this seam is one well-known document shape rather than arbitrary
//  input from the world.
//
//  Two properties are load-bearing and are why Foundation's JSONSerialization is
//  not enough here:
//
//    ORDER. `[String: Any]` is unordered, and the host derives arrays from
//    object iteration (a tool's `required` list, the ignored-unknown-fields
//    notice). An unordered map would make those results depend on hashing.
//
//    BYTE STABILITY. Rendering sorts keys, so one document has exactly one
//    serialization. Fixtures bound the size of a single event; a rendering that
//    varied between runs would make that assertion flaky rather than tight.
//
//  Deliberately small and bounded: parse, render, and the typed accessors the
//  host uses. A missing key reads as `.null` rather than throwing, because a
//  must-ignore consumer asks for fields it may not get, constantly.
//

import Foundation

/// An insertion-ordered JSON object. Reads are by key; iteration is by the order
/// the keys arrived, which is what makes a derived array reproducible.
public struct JSONObject: Sendable, Equatable {
    public private(set) var keys: [String] = []
    private var storage: [String: JSON] = [:]

    public init() {}

    public init(_ pairs: [(String, JSON)]) {
        for (key, value) in pairs { set(key, value) }
    }

    public subscript(key: String) -> JSON? { storage[key] }

    public mutating func set(_ key: String, _ value: JSON) {
        if storage[key] == nil { keys.append(key) }
        storage[key] = value
    }

    public mutating func remove(_ key: String) {
        guard storage.removeValue(forKey: key) != nil else { return }
        keys.removeAll { $0 == key }
    }

    public func has(_ key: String) -> Bool { storage[key] != nil }
    public var count: Int { keys.count }
    public var isEmpty: Bool { keys.isEmpty }

    /// The pairs in insertion order.
    public var pairs: [(String, JSON)] { keys.map { ($0, storage[$0] ?? .null) } }

    public static func == (lhs: JSONObject, rhs: JSONObject) -> Bool {
        lhs.storage == rhs.storage
    }
}

public enum JSONError: Error, CustomStringConvertible {
    case syntax(String)

    public var description: String {
        switch self {
        case .syntax(let why): return "invalid JSON: \(why)"
        }
    }
}

public enum JSON: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object(JSONObject)

    public static let maxDepth = 64

    // MARK: - construction

    public static func obj(_ pairs: [(String, JSON)]) -> JSON { .object(JSONObject(pairs)) }

    public static func of(_ value: String) -> JSON { .string(value) }
    public static func of(_ value: Int) -> JSON { .number(Double(value)) }
    public static func of(_ value: Double) -> JSON { .number(value) }
    public static func of(_ value: Bool) -> JSON { .bool(value) }
    public static func of(_ values: [String]) -> JSON { .array(values.map { .string($0) }) }

    // MARK: - accessors

    public subscript(key: String) -> JSON {
        guard case .object(let o) = self else { return .null }
        return o[key] ?? .null
    }

    public subscript(index: Int) -> JSON {
        guard case .array(let a) = self, index >= 0, index < a.count else { return .null }
        return a[index]
    }

    public var items: [JSON] {
        guard case .array(let a) = self else { return [] }
        return a
    }

    public var fields: JSONObject {
        guard case .object(let o) = self else { return JSONObject() }
        return o
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    public var isObject: Bool {
        if case .object = self { return true }
        return false
    }

    public func has(_ key: String) -> Bool {
        guard case .object(let o) = self else { return false }
        return o.has(key)
    }

    public func string(_ fallback: String = "") -> String {
        guard case .string(let s) = self else { return fallback }
        return s
    }

    public var stringOrNull: String? {
        guard case .string(let s) = self else { return nil }
        return s
    }

    public func number(_ fallback: Double = 0) -> Double {
        guard case .number(let n) = self else { return fallback }
        return n
    }

    public func int(_ fallback: Int = 0) -> Int {
        guard case .number(let n) = self, n.isFinite else { return fallback }
        return Int(n)
    }

    public func bool(_ fallback: Bool = false) -> Bool {
        guard case .bool(let b) = self else { return fallback }
        return b
    }

    /// Every string in an array, skipping anything that is not one.
    public var strings: [String] { items.compactMap { $0.stringOrNull } }

    // MARK: - rendering

    /// One document, one serialization. Keys are sorted so the output is
    /// byte-stable across runs and across the three host implementations.
    public func render() -> String {
        switch self {
        case .null:
            return "null"
        case .bool(let value):
            return value ? "true" : "false"
        case .number(let value):
            return JSON.renderNumber(value)
        case .string(let value):
            return JSON.escape(value)
        case .array(let values):
            return "[" + values.map { $0.render() }.joined(separator: ",") + "]"
        case .object(let o):
            let body = o.keys.sorted().map { key in
                JSON.escape(key) + ":" + (o[key] ?? .null).render()
            }
            return "{" + body.joined(separator: ",") + "}"
        }
    }

    private static func renderNumber(_ value: Double) -> String {
        guard value.isFinite else { return "null" }
        // An integral double renders as an integer, so `1` does not become `1.0`
        // and a fixture's `"seq": 1` compares equal to what the engine produced.
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

    // MARK: - parsing

    public static func parse(_ text: String) throws -> JSON {
        var parser = JSONParser(text)
        let value = try parser.value(0)
        parser.skipWhitespace()
        guard parser.atEnd else {
            throw JSONError.syntax("trailing content at offset \(parser.offset)")
        }
        return value
    }

    public static func parseOrNull(_ text: String) -> JSON? { try? parse(text) }
}

// MARK: - the parser

/// A collision-free spelling for consumers whose application target already owns a `JSON`
/// type. The package product and its engine class are both named `DespiaAI`, so spelling the
/// module-qualified form as `DespiaAI.JSON` can resolve to the class on some Swift compiler
/// paths. This additive alias keeps the public value type unambiguous without renaming either
/// established surface.
public typealias DespiaAIJSON = JSON

private struct JSONParser {
    private let scalars: [Unicode.Scalar]
    private(set) var offset = 0

    init(_ text: String) { scalars = Array(text.unicodeScalars) }

    var atEnd: Bool { offset >= scalars.count }

    mutating func skipWhitespace() {
        while offset < scalars.count {
            let s = scalars[offset]
            guard s == " " || s == "\t" || s == "\n" || s == "\r" else { return }
            offset += 1
        }
    }

    mutating func value(_ depth: Int) throws -> JSON {
        guard depth <= JSON.maxDepth else {
            throw JSONError.syntax("nesting too deep at offset \(offset)")
        }
        skipWhitespace()
        guard !atEnd else { throw JSONError.syntax("unexpected end of input") }
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

    private mutating func literal(_ word: String, _ value: JSON) throws -> JSON {
        let expected = Array(word.unicodeScalars)
        guard offset + expected.count <= scalars.count,
              Array(scalars[offset ..< offset + expected.count]) == expected else {
            throw JSONError.syntax("bad literal at offset \(offset)")
        }
        offset += expected.count
        return value
    }

    private mutating func object(_ depth: Int) throws -> JSON {
        offset += 1   // '{'
        var out = JSONObject()
        skipWhitespace()
        if !atEnd, scalars[offset] == "}" { offset += 1; return .object(out) }
        while true {
            skipWhitespace()
            let key = try str()
            skipWhitespace()
            guard !atEnd, scalars[offset] == ":" else {
                throw JSONError.syntax("expected ':' at offset \(offset)")
            }
            offset += 1
            out.set(key, try value(depth + 1))
            skipWhitespace()
            guard !atEnd else { throw JSONError.syntax("unterminated object") }
            switch scalars[offset] {
            case ",": offset += 1
            case "}": offset += 1; return .object(out)
            default: throw JSONError.syntax("expected ',' or '}' at offset \(offset)")
            }
        }
    }

    private mutating func array(_ depth: Int) throws -> JSON {
        offset += 1   // '['
        var out: [JSON] = []
        skipWhitespace()
        if !atEnd, scalars[offset] == "]" { offset += 1; return .array(out) }
        while true {
            out.append(try value(depth + 1))
            skipWhitespace()
            guard !atEnd else { throw JSONError.syntax("unterminated array") }
            switch scalars[offset] {
            case ",": offset += 1
            case "]": offset += 1; return .array(out)
            default: throw JSONError.syntax("expected ',' or ']' at offset \(offset)")
            }
        }
    }

    private mutating func str() throws -> String {
        guard !atEnd, scalars[offset] == "\"" else {
            throw JSONError.syntax("expected a string at offset \(offset)")
        }
        offset += 1
        var units: [UInt16] = []
        while offset < scalars.count {
            let c = scalars[offset]
            offset += 1
            if c == "\"" {
                return String(decoding: units, as: UTF16.self)
            }
            if c != "\\" {
                JSONParser.appendUTF16(c, to: &units)
                continue
            }
            guard offset < scalars.count else { throw JSONError.syntax("truncated escape") }
            let e = scalars[offset]
            offset += 1
            switch e {
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
                guard offset + 4 <= scalars.count else { throw JSONError.syntax("truncated \\u escape") }
                var code: UInt32 = 0
                for _ in 0 ..< 4 {
                    guard let digit = JSONParser.hex(scalars[offset]) else {
                        throw JSONError.syntax("bad \\u escape at offset \(offset)")
                    }
                    code = code * 16 + digit
                    offset += 1
                }
                units.append(UInt16(truncatingIfNeeded: code))
            default:
                throw JSONError.syntax("unknown escape '\\\(e)'")
            }
        }
        throw JSONError.syntax("unterminated string")
    }

    /// Encoded by hand rather than through a String round-trip: the surrogate
    /// arithmetic is the whole point, and it has to be visible.
    private static func appendUTF16(_ scalar: Unicode.Scalar, to units: inout [UInt16]) {
        if scalar.value <= 0xFFFF {
            units.append(UInt16(scalar.value))
        } else {
            let v = scalar.value - 0x10000
            units.append(UInt16(0xD800 + (v >> 10)))
            units.append(UInt16(0xDC00 + (v & 0x3FF)))
        }
    }

    private static func hex(_ s: Unicode.Scalar) -> UInt32? {
        switch s.value {
        case 0x30 ... 0x39: return s.value - 0x30
        case 0x41 ... 0x46: return s.value - 0x41 + 10
        case 0x61 ... 0x66: return s.value - 0x61 + 10
        default: return nil
        }
    }

    private mutating func num() throws -> JSON {
        let start = offset
        if !atEnd, scalars[offset] == "-" || scalars[offset] == "+" { offset += 1 }
        while !atEnd {
            let s = scalars[offset]
            let isDigit = s.value >= 0x30 && s.value <= 0x39
            guard isDigit || s == "." || s == "e" || s == "E" || s == "+" || s == "-" else { break }
            offset += 1
        }
        var text = ""
        for s in scalars[start ..< offset] { text.unicodeScalars.append(s) }
        guard let value = Double(text) else {
            throw JSONError.syntax("bad number \(text.isEmpty ? "<empty>" : text) at offset \(start)")
        }
        return .number(value)
    }
}
