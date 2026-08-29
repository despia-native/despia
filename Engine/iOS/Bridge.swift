//
//  Bridge.swift
//  DespiaScript
//
//  Despia LLC-FZ
//  Meydan Grandstand, 6th Floor, Meydan Road,
//  Nad Al Sheba, Dubai, United Arab Emirates
//  support@despia.com
//
//  The native side of the web bridge: proxy, typed params, and the window.virtual transport.
//

import Foundation

/// Error raised when a `dsx.module` call can't complete.
public enum ModuleCallError: Error {

    /// No package owns the URI's scheme (excluded from this build, or never
    /// existed). Matches `try?` for a "skip if absent" idiom.
    case notLoaded(scheme: String)

    /// The URI was malformed (couldn't parse a scheme).
    case invalidURI(String)

    /// The target package handled the call but settled with an error.
    /// `code` is the package-defined identifier (e.g. `"missing_param"`);
    /// `data` is whatever the handler passed to `dsx.error(_, _)`.
    case actionFailed(code: String, data: Any?)
}

extension ModuleCallError: CustomStringConvertible {
    /// Matches the Kotlin twin's exception messages (Engine/Android Bridge.kt), so a caller's
    /// own `catch { log(error) }` prints the same diagnosis on both platforms — instead of
    /// Foundation's generic "The operation couldn't be completed" for an un-described Error.
    public var description: String {
        switch self {
        case .notLoaded(let scheme):     return "No module owns scheme '\(scheme)' in this build."
        case .invalidURI(let uri):       return "Malformed module call URI: '\(uri)'"
        case .actionFailed(let code, _): return "Module action failed: '\(code)'"
        }
    }
}

public enum Bridge {

    /// Terminal outcome of an internal (package-to-package) call. Mirrors
    /// the JS-side `await window.despia(...)` resolution but stays Swift-side.
    enum Outcome {
        case resolve(Any?)
        /// `message`/`recoverable` widen the INTERNAL plumbing only (error-system.md §3.3a):
        /// the caller-facing `ModuleCallError` stays code+data (source-compat), but the
        /// call-failure funnel records the full fidelity the handler authored.
        case error(code: String, data: Any?, message: String?, recoverable: Bool)
    }

    // Bridge's web-delivery role is fully gone (messenger.md step 4b). `Bridge.proxy` (the kernel's
    // last `targetWebView` user) + its `jsonLiteral` helper are REMOVED — the correlated resolve /
    // error / event / broadcast envelope now builds in `Context` and delivers through the DSXWebView
    // package (`dsx.module.dom.proxy` → `Dom.proxyJS` → `window.despia.__proxy`), keeping DSXWebView the
    // single web egress. `Bridge.legacy` (variable/function) and `Bridge.css` were removed earlier;
    // the kernel/`targetWebView`/WebKit-for-delivery story is now closed.
}

// MARK: - Bridge.Params

extension Bridge {

    /// Unified reader for the inbound payload. Two construction paths:
    ///
    ///   - `init(url:)` reads the URL query string. Values arrive percent-decoded
    ///     by `URLComponents`; one additional smart pass handles `+`-as-space
    ///     (form encoding) and double-encoded values. Plain text with stray
    ///     `%` (`"50% off"`) is left alone. For the raw wire form, see `raw(_:)`.
    ///
    ///   - `init(dict:requestID:)` takes a structured `[String: Any]` from
    ///     `window.virtual.send({...})`. Real arrays, nested dicts, numbers,
    ///     and bools survive intact; strings are passed through verbatim
    ///     (structured callers shouldn't be percent-encoding values).
    ///
    /// Handlers use the same typed accessors regardless of source.
    public struct Params {

        private let named: [String: Any]

        /// `__rid` echo; carried in the result envelope (built in `Context`, delivered via
        /// `dsx.module.dom.proxy`) to correlate results to outbound requests. `nil` for legacy callers.
        public let requestID: String?

        /// Set when this call originated from a `dsx.module` call
        /// (one package calling another). `resolve` / `error` invoke this
        /// instead of writing a JS-promise result. Side-effect deliveries
        /// (`variable`, `function`, `broadcast`) still go through.
        let onTerminal: ((Outcome) -> Void)?

        /// The mounted SURFACE this call originated from (`dsx.messenger.mount` id),
        /// nil for the legacy web path and native `dsx.module` callers. `Context`
        /// routes this call's resolve / error / stream events to that surface's
        /// mounted sink (Messenger.swift) instead of the web fallback.
        public let surfaceID: String?

        /// `true` when the call carries `__stop=true` - the signal a stream
        /// caller sends when terminating its subscription.
        public var isStop: Bool { bool("__stop") }

        init(url: URL, surfaceID: String? = nil) {
            var dict: [String: Any] = [:]
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            for item in items {
                // Framing keys (`__rid`, `__stop`) keep their literal string
                // form; every other value is smart-parsed at ingestion so the
                // three legacy string entry points (a scheme + host + `?test=123`
                // query assigned to window.location.href, window.virtual.href, or
                // window.despia — see OpenSource/Documentation/legacy.md) all arrive
                // as a typed payload (`{ test: 123 }`).
                if item.name.hasPrefix("__") {
                    dict[item.name] = Self.urlDecode(item.value ?? "")
                } else {
                    dict[item.name] = Self.smartValue(item.value ?? "")
                }
            }
            self.named = dict
            self.requestID = dict["__rid"] as? String
            self.onTerminal = nil
            self.surfaceID = surfaceID
        }

        init(dict: [String: Any], requestID: String?, surfaceID: String? = nil) {
            // Structured values come in already-typed; no decode applied.
            // A handler that wants the wire form can still read it via raw(_:).
            self.named = dict
            self.requestID = requestID
            self.onTerminal = nil
            self.surfaceID = surfaceID
        }

        /// Internal-call constructor: the caller is another package, not JS.
        /// Terminal outcomes route to `onTerminal` instead of the JS bridge.
        init(dict: [String: Any], onTerminal: @escaping (Outcome) -> Void) {
            self.named = dict
            self.requestID = nil
            self.onTerminal = onTerminal
            self.surfaceID = nil
        }

        // MARK: - Accessors

        /// All params, structured. Useful when forwarding wholesale.
        public var all: [String: Any] { named }

        /// All params flattened to strings - the `[String: String]` view the
        /// legacy URL-style managers expect. Scalars stringify (bools as
        /// "true"/"false"); arrays join on "," (matching the legacy
        /// `services=180d,180f` convention); objects serialize to JSON.
        /// `__`-prefixed framing keys are dropped. This is the bridge that lets
        /// those managers read structured object-form calls unchanged.
        public var strings: [String: String] {
            var out: [String: String] = [:]
            for (key, value) in named where !key.hasPrefix("__") {
                if let s = Self.flatten(value) { out[key] = s }
            }
            return out
        }

        private static func flatten(_ value: Any) -> String? {
            switch value {
            case let s as String:   return s
            case let b as Bool:     return b ? "true" : "false"
            case let n as NSNumber: return n.stringValue
            case let arr as [Any]:  return arr.compactMap { flatten($0) }.joined(separator: ",")
            case is NSNull:         return nil
            default:
                guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
                      let s = String(data: data, encoding: .utf8) else { return nil }
                return s
            }
        }

        /// Raw underlying value (no coercion). Lets handlers distinguish
        /// "present but unparseable" from "absent".
        public func raw(_ key: String) -> Any? { named[key] }

        public func string(_ key: String) -> String? {
            switch named[key] {
            case let s as String:   return s
            case let b as Bool:     return b ? "true" : "false"
            case let n as NSNumber: return n.stringValue
            // A comma-list value parses to an array; rejoin it so callers reading
            // a single string (legacy URL handlers) still see "a,b,c".
            case let arr as [Any]:  return arr.compactMap { Self.flatten($0) }.joined(separator: ",")
            default:                return nil
            }
        }

        public func string(_ key: String, default fallback: String) -> String {
            string(key) ?? fallback
        }

        public func int(_ key: String) -> Int? {
            if let n = named[key] as? Int      { return n }
            if let n = named[key] as? NSNumber { return n.intValue }
            if let s = named[key] as? String   { return Int(s) }
            return nil
        }

        public func double(_ key: String) -> Double? {
            if let n = named[key] as? Double   { return n }
            if let n = named[key] as? NSNumber { return n.doubleValue }
            if let s = named[key] as? String   { return Double(s) }
            return nil
        }

        public func bool(_ key: String, default fallback: Bool = false) -> Bool {
            if let b = named[key] as? Bool     { return b }
            if let n = named[key] as? NSNumber { return n.boolValue }
            if let s = named[key] as? String {
                let l = s.lowercased()
                return l == "true" || l == "1" || l == "yes" || l == "on"
            }
            return fallback
        }

        /// Returns the value as an array. Structured callers pass real
        /// arrays (`["a","b","c"]`) - they flow through unchanged. URL-only
        /// callers send comma-separated strings (`tags=a,b,c`) - they're
        /// split and trimmed on read. Returns `nil` only when the key is
        /// absent; an empty string yields `[]`.
        public func array(_ key: String) -> [Any]? {
            if let a = named[key] as? [Any] { return a }
            if let s = named[key] as? String {
                if s.isEmpty { return [] }
                return s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            }
            return nil
        }

        /// Convenience for the common `[String]` case.
        public func stringArray(_ key: String) -> [String]? {
            guard let a = array(key) else { return nil }
            return a.compactMap { ($0 as? String) ?? ($0 as? NSNumber)?.stringValue }
        }

        /// Convenience for the common `[[String: Any]]` case - a list of
        /// JSON objects. Structured callers send `[{...}, {...}]` directly;
        /// URL callers can send a JSON-encoded string of the same shape.
        public func objectArray(_ key: String) -> [[String: Any]]? {
            if let a = named[key] as? [[String: Any]] { return a }
            if let s = named[key] as? String,
               let data = s.data(using: .utf8),
               let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                return parsed
            }
            return nil
        }

        /// Nested object. Structured callers pass real dicts; URL-only
        /// callers can pass a JSON-encoded string.
        public func object(_ key: String) -> [String: Any]? {
            if let o = named[key] as? [String: Any] { return o }
            if let s = named[key] as? String,
               let data = s.data(using: .utf8),
               let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return parsed
            }
            return nil
        }

        /// A `URL` value, intended for file references uploaded through
        /// `window.virtual.storage`. Files in the JS layer are auto-uploaded
        /// to the local CDN and replaced with their URL by `runtime.js`'s
        /// `resolvePayload`, so a handler reading `params.file("image")` gets
        /// the local-disk URL it can stream from. Returns `nil` if the value
        /// isn't present or doesn't parse as a URL.
        public func file(_ key: String) -> URL? {
            guard let s = string(key), let url = URL(string: s) else { return nil }
            return url
        }

        // MARK: - Smart URL decode

        /// One conservative decode pass for URL query values:
        ///   1. `+` -> space (form-encoding convention).
        ///   2. `removingPercentEncoding`, but only if the result actually
        ///      changes - so plain text with stray `%` (`"50% off"`) is
        ///      preserved.
        ///
        /// Structured (dict) callers bypass this entirely.
        private static func urlDecode(_ raw: String) -> String {
            let spaced = raw.replacingOccurrences(of: "+", with: " ")
            if let decoded = spaced.removingPercentEncoding, decoded != spaced {
                return decoded
            }
            return spaced
        }

        // MARK: - Smart value parse (URL query -> typed payload)

        /// URL-decode, then promote to a typed value:
        ///   - clearly-JSON text (number, bool, null, `[...]`, `{...}`, quoted string)
        ///     is parsed: `?test=123` -> 123, `?on=true` -> true, `?tags=["a","b"]`
        ///     (encoded) -> array.
        ///   - a comma-list becomes an array, each element smart-parsed:
        ///     `?types=one,two` -> ["one","two"], `?ids=1,2` -> [1,2].
        ///   - anything else stays a string: `?name=Ada` -> "Ada"; leading-zero
        ///     ids ("01234", rejected by strict JSON) stay strings.
        /// (A value that needs a literal comma should be sent structured or as a
        ///  JSON string, not in the legacy query form.)
        private static func smartValue(_ raw: String) -> Any {
            let decoded = urlDecode(raw)
            if let parsed = jsonParsed(decoded) { return parsed }
            if decoded.contains(",") {
                return decoded.split(separator: ",").map { part -> Any in
                    let trimmed = part.trimmingCharacters(in: .whitespaces)
                    return jsonParsed(trimmed) ?? trimmed
                }
            }
            return decoded
        }

        private static func jsonParsed(_ s: String) -> Any? {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let first = t.first else { return nil }
            // Only attempt a parse when the text opens like JSON, so arbitrary
            // words aren't fed to JSONSerialization.
            guard "-0123456789tfn[{\"".contains(first),
                  let data = t.data(using: .utf8) else { return nil }
            return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        }
    }
}

final class VirtualBridge: NSObject {

    static let messageName = "virtual"

    /// Bumped whenever the wire format or capability surface changes. Web
    /// code can guard hard dependencies with `despia.supports.version >= N`.
    static let bridgeVersion = 3

    /// App marketing version (CFBundleShortVersionString), surfaced on
    /// `window.despia.runtime.appVersion` for feature gates that key on app
    /// release rather than the bridge protocol generation.
    static var appVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? ""
    }

    /// JSON array of the packages compiled into THIS build (name, optional
    /// version + scheme). Generated into the app bundle as `DespiaPackages.json`
    /// by `scripts/generate_package_registry.rb` (an Xcode pre-sign build phase),
    /// so versions live in each manifest, not Info.plist. Surfaced on
    /// `window.despia.runtime.packages` for web feature-detection. `[]` when absent.
    static var packagesJSON: String { bundledJSON("DespiaPackages") }

    /// The honest twin of `packagesJSON`: the packages EXCLUDED from this build
    /// ([{ name, scheme?, reason }] — reason "excluded" | "cascade"), generated
    /// beside the registry by the same pre-sign phase. Surfaced as
    /// `window.despia.runtime.excluded` / `despia.wasExcluded(...)`, so a page
    /// can distinguish "absent because this app excluded it" from "never
    /// existed". `[]` when absent (older builds).
    static var excludedJSON: String { bundledJSON("DespiaExcluded") }

    /// One reader for the generated build-introspection resources. The bytes are
    /// INTERPOLATED into the injected runtime script and consumed as an ARRAY by
    /// runtime.js, so they must parse as a JSON array — a corrupt file (or a
    /// non-array payload, which would make the page's `.filter` throw) degrades
    /// to the empty list instead of taking the `__nativeRuntime` install down.
    private static func bundledJSON(_ resource: String) -> String {
        guard let url = Bundle.main.url(forResource: resource, withExtension: "json"),
              let json = try? String(contentsOf: url, encoding: .utf8),
              let data = json.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) as? [Any] != nil else { return "[]" }
        return json
    }

    // The web view + the WKScriptMessageHandler shell live in the dom module now (DomWebHost installs
    // the "virtual" handler and forwards `message.body` here via `receive`). The kernel bridge is
    // WebKit-free: it resolves the body and routes through the registry.

    /// Script that defines `window.virtual` — the BASIC, can't-fail LEGACY transport. Inject at `.atDocumentStart`.
    static var injectedScript: String {
        return """
        (function() {
            // window.virtual — the BASIC legacy bridge: the string/object OUTBOUND transport old
            // pages use (window.virtual.href = "scheme://…" / .send({…})). Installed first and
            // unconditionally so legacy outbound always works even if runtime.js fails. The MODERN
            // protocol — the promise registry, streams, despia.on, and the inbound delivery sink
            // (window.despia.__proxy) — lives entirely in window.despia (runtime.js); native delivers
            // there directly, so window.virtual no longer carries an engine (no engine).
            if (window.virtual) { return; }
            function postString(uri) {
                if (uri == null) return;
                try {
                    window.webkit.messageHandlers.\(Self.messageName).postMessage(String(uri));
                } catch (e) {
                    try { window.location.href = String(uri); } catch (_) {}
                }
            }
            function postObject(obj) {
                try { window.webkit.messageHandlers.\(Self.messageName).postMessage(obj); }
                catch (e) { /* caller gates on capabilities.structured */ }
            }
            var api = {
                capabilities: { version: \(Self.bridgeVersion), structured: true, events: true, subscribe: true },
                // outbound transport (legacy + the substrate window.despia posts through)
                call: postString,
                set href(uri) { postString(uri); },
                get href() { return ''; },
                send: postObject
            };
            try {
                Object.defineProperty(window, 'virtual', { value: api, writable: false, configurable: false });
            } catch (e) {
                window.virtual = api;
            }

            // Native facts, re-exposed by runtime.js as window.despia.runtime. Wrapped so it can
            // never prevent the window.virtual install above. Does NOT touch window.despia.
            try {
                if (!window.__nativeRuntime) {
                    window.__nativeRuntime = Object.freeze({
                        version: \(Self.bridgeVersion),
                        appVersion: "\(Self.appVersion)",
                        platform: "ios",
                        capabilities: { structured: true, events: true, subscribe: true },
                        packages: \(Self.packagesJSON),
                        excluded: \(Self.excludedJSON)
                    });
                    // Historical spelling, aliased to the same frozen object so pages and
                    // shims written against the old global keep reading real facts.
                    window.__despiaRuntime = window.__nativeRuntime;
                }
            } catch (e) {}
        })();
        """
    }

    // MARK: - WebKit-free dispatch (the dom module's handler shell forwards the page message here)

    /// Resolve a page message body (a String — legacy — or a `[String: Any]` v2 envelope) to
    /// `(URL, Bridge.Params)` and route it through the registry. An unclaimed URL is handed to
    /// `navigate` (the dom shell loads it into the web view) — the kernel names no web-view type.
    func receive(_ body: Any, navigate: @escaping (URL) -> Void) {
        // Body is either a String (legacy) or a Dictionary (v2). Both resolve to
        // (URL, Bridge.Params) and funnel through the same dispatcher.
        let resolved: (url: URL, params: Bridge.Params)?

        if let raw = body as? String, !raw.isEmpty {
            guard let url = Self.makeURL(from: raw) else {
                kernelLog("[VirtualBridge] Invalid string body: \(raw.prefix(120))")
                return
            }
            // Stamp the ORIGIN surface explicitly (symmetric with a messenger
            // mount's receive) — replies route to the "web" sink by origin, not
            // by Context's surface-less default.
            resolved = (url, Bridge.Params(url: url, surfaceID: "web"))
        } else if let dict = body as? [String: Any] {
            guard let rawScheme = dict["scheme"] as? String, !rawScheme.isEmpty else {
                kernelLog("[VirtualBridge] Object body missing 'scheme'")
                return
            }
            let inner = dict["params"] as? [String: Any] ?? [:]
            let rid   = dict["rid"] as? String
            // The field is `<scheme>` or `<scheme>://<action/path>` — a routing KEY
            // plus action, NOT URL grammar. The type-safe window.despia surface is
            // property access, so identifier schemes (`godot_test`) are legal here:
            // dispatch goes by STRING, never through a URL parser (iOS 17+'s strict
            // Foundation parser rejects such schemes as URLs). Only an UNCLAIMED
            // key falls back to legacy navigation, and only when it forms a real URL.
            let parts = rawScheme.components(separatedBy: "://")
            let scheme = parts[0]
            let actionPath = parts.count > 1 ? parts[1] : ""
            let params = Bridge.Params(dict: inner, requestID: rid, surfaceID: "web")
            DispatchQueue.main.async {
                if !ModuleRegistry.shared.handle(scheme: scheme, actionPath: actionPath,
                                                 params: params, includeInternal: false) {
                    // No module owns this scheme. A rid-carrying call is a STRUCTURED promise
                    // call (`await window.despia.<scheme>…`) — reject it NOW with the same
                    // envelope a handler's dsx.error sends, instead of leaving the page's
                    // promise to die on the generic 30 s arm timeout (a deleted or typo'd
                    // scheme read as a silent hang: no screen, no error, for half a minute).
                    // rid-LESS bodies keep the legacy navigation fallback byte-for-byte — a
                    // decidePolicy-era handler may still claim the URL, and legacy callers
                    // never had a promise to reject.
                    if let rid, !rid.isEmpty {
                        // Three-way distinct (the ModuleRegistry.platformSupport contract): a
                        // catalog scheme with NO implementation on this OS rejects the promise
                        // with the STRUCTURED `unsupported_platform` envelope (message + data
                        // pinned in OpenSource/Skills/android/api-mapping.md "Unsupported
                        // platform"); excluded-by-this-app and unknown schemes keep `not_loaded`.
                        // Inert while platformSupport is empty (the bare kernel).
                        let envelope: [String: Any]
                        if let supported = ModuleRegistry.shared.unsupportedPlatforms(scheme, action: actionPath) {
                            envelope = [
                                "id": rid, "scheme": scheme, "host": actionPath,
                                "event": "error", "final": true,
                                "data": ModuleRegistry.shared.unsupportedPlatformData(scheme, supported),
                                "code": "unsupported_platform", "recoverable": false,
                                "message": ModuleRegistry.shared.unsupportedPlatformMessage(scheme)
                            ]
                            kernelLog("[VirtualBridge] Rejected call to scheme '\(scheme)' (unsupported_platform)")
                        } else {
                            envelope = [
                                "id": rid, "scheme": scheme, "host": actionPath,
                                "event": "error", "final": true, "data": NSNull(),
                                "code": "not_loaded", "recoverable": false,
                                "message": "No module owns scheme '\(scheme)' in this build."
                            ]
                            kernelLog("[VirtualBridge] Rejected call to unowned scheme '\(scheme)' (not_loaded)")
                        }
                        DSXMessenger().deliver(to: "web",
                            DSXEgress(target: "web", scheme: scheme, rid: rid, payload: envelope))
                    } else if let url = Self.makeURL(forScheme: rawScheme, rid: rid) {
                        navigate(url)   // unclaimed (object-body params lost, as before v2)
                    } else {
                        kernelLog("[VirtualBridge] Unclaimed object-body scheme: \(scheme)")
                    }
                }
            }
            return
        } else {
            kernelLog("[VirtualBridge] Unknown message body type")
            return
        }

        guard let (url, params) = resolved else { return }

        DispatchQueue.main.async {
            // Custom scheme → its owning package (registry first-dibs, params preserved). Anything the
            // registry doesn't claim NAVIGATES (the dom shell loads it, re-entering decidePolicy), so
            // every handler stays reachable. The kernel names no host / web-view type.
            if !ModuleRegistry.shared.handle(url: url, params: params) {
                navigate(url)   // unclaimed (object-body params lost, as before v2)
            }
        }
    }

    // MARK: - URL construction

    /// Builds a `URL` from an arbitrary string. Falls back to percent-encoding
    /// when the raw form isn't a valid URL (e.g. contains spaces).
    static func makeURL(from raw: String) -> URL? {
        if let url = URL(string: raw) { return url }
        var allowed = CharacterSet.urlQueryAllowed
        allowed.insert(charactersIn: ":/?#[]@!$&'()*+,;=%")
        if let encoded = raw.addingPercentEncoding(withAllowedCharacters: allowed),
           let url = URL(string: encoded) {
            return url
        }
        return nil
    }

    /// Routing-only URL for the object body path. Only `__rid` lives in the
    /// query string; the real payload travels alongside as `Bridge.Params`.
    static func makeURL(forScheme scheme: String, rid: String?) -> URL? {
        guard !scheme.isEmpty else { return nil }
        let base = scheme.contains("://") ? scheme : "\(scheme)://"
        var raw = base
        if let rid = rid, !rid.isEmpty {
            let encodedRid = rid.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? rid
            raw += (base.contains("?") ? "&" : "?") + "__rid=" + encodedRid
        }
        return makeURL(from: raw)
    }
}
