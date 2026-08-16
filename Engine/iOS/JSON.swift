//
//  JSON.swift
//  DespiaScript
//
//  Despia LLC-FZ
//  Meydan Grandstand, 6th Floor, Meydan Road,
//  Nad Al Sheba, Dubai, United Arab Emirates
//  support@despia.com
//
//  The JSON value packages hand back to the web. Build it with the fluent
//  JSON.obj()/.arr()/.put()/.add() chain (identical on Swift, Kotlin and Java),
//  or with the JSON([...]) literal when you'd rather use native map/array syntax.
//  Pass nil for null, nest a JSON, or hand over a dsx.args(...) value as-is.
//

import Foundation

public enum JSON {
    case object([String: JSON])
    case array([JSON])
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null
}

/// Anything that can become JSON. Native scalars and arrays conform, so the
/// builder accepts them directly (no manual wrapping).
public protocol JSONConvertible {
    var asJSON: JSON { get }
}

extension JSON: JSONConvertible { public var asJSON: JSON { self } }
extension String: JSONConvertible { public var asJSON: JSON { .string(self) } }
extension Int: JSONConvertible { public var asJSON: JSON { .int(self) } }
extension Double: JSONConvertible { public var asJSON: JSON { .double(self) } }
extension Bool: JSONConvertible { public var asJSON: JSON { .bool(self) } }
extension Array: JSONConvertible where Element: JSONConvertible {
    public var asJSON: JSON { .array(map { $0.asJSON }) }
}

public extension JSON {
    /// Start an empty object for the fluent builder: `JSON.obj().put(k, v)...`.
    static func obj() -> JSON { .object([:]) }

    /// Build an array — `JSON.arr("track", "event")` for the method path in the call
    /// envelope, or `JSON.arr()` empty for the fluent `.add(v)` builder. Each item becomes
    /// JSON via `JSON.from` (scalars, nested JSON, arrays, `nil` → null).
    static func arr(_ items: Any?...) -> JSON { .array(items.map { JSON.from($0) }) }

    /// Set a key on an object (chainable); starts an object if `self` isn't one.
    /// The value is any native scalar, a nested `JSON`, a `dsx.args(...)` result,
    /// or `nil` (-> JSON null).
    func put(_ key: String, _ value: Any?) -> JSON {
        if case .object(var d) = self {
            d[key] = JSON.from(value)
            return .object(d)
        }
        return .object([key: JSON.from(value)])
    }

    /// Append a value to an array (chainable); starts an array if `self` isn't one.
    func add(_ value: Any?) -> JSON {
        if case .array(var a) = self {
            a.append(JSON.from(value))
            return .array(a)
        }
        return .array([JSON.from(value)])
    }

    /// Build JSON from a dynamic Foundation value (`[String: Any]`, `[Any]`,
    /// or JSONSerialization output). Non-JSON values fall back to their
    /// description. Use it to forward native data through `resolve`/`event`.
    static func from(_ value: Any?) -> JSON {
        switch value {
        case nil, is NSNull:          return .null
        case let j as JSON:           return j
        case let s as String:         return .string(s)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            let d = n.doubleValue
            return d == d.rounded() ? .int(n.intValue) : .double(d)
        case let a as [Any]:          return .array(a.map { from($0) })
        case let o as [String: Any]:  return .object(o.mapValues { from($0) })
        default:                      return .string(String(describing: value!))
        }
    }

    /// Foundation representation for JSONSerialization / the bridge.
    var foundationValue: Any {
        switch self {
        case .object(let d): return d.mapValues { $0.foundationValue }
        case .array(let a):  return a.map { $0.foundationValue }
        case .string(let s): return s
        case .int(let i):    return i
        case .double(let d): return d
        case .bool(let b):   return b
        case .null:          return NSNull()
        }
    }
}

// MARK: - Cross-runtime literals (the `JSON(...)` constructor)

public extension JSON {
    /// Build a JSON object from a native dictionary literal:
    /// `JSON(["ok": true, "count": 2])`. Values are taken as-is - scalars, nested
    /// `JSON`, arrays, a `dsx.args(...)` result, or `nil` (-> JSON null). The
    /// dynamic, cross-runtime entry point (same `JSON(map)` shape on Kotlin/Java).
    init(_ dictionary: [String: Any?]) {
        self = .object(dictionary.mapValues { JSON.from($0) })
    }

    /// Build a JSON array from a native array literal: `JSON([1, 2, 3])`.
    init(_ array: [Any?]) {
        self = .array(array.map { JSON.from($0) })
    }
}

// Optionals carry through as JSON null - lets `dsx.resolve(maybeValue)` and
// `JSON(["id": maybeValue])` compile without forcing the caller to coalesce.
extension Optional: JSONConvertible where Wrapped: JSONConvertible {
    public var asJSON: JSON { self?.asJSON ?? .null }
}

/// `json("""{ "sku": "gold", "value": 9.99 }""")` — parse a STATIC JSON string into `JSON`. The
/// 1:1 cross-language register for static payloads: the same bytes everywhere, copy-pastes to a
/// `.json` file or curl. Invalid JSON → `.null`. For DYNAMIC payloads use the `JSON.obj().put(…)`
/// builder, which inserts values as data — never string-interpolate into JSON text (injection risk).
public func json(_ string: String) -> JSON {
    guard let data = string.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data, options: [.allowFragments])
    else { return .null }
    return JSON.from(obj)
}
