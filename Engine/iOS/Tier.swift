//
//  Tier.swift - the W9 execution-tier classifier + escalation engine, the Swift twin of
//  the web kernel's compile/tier.ts + jstier.ts and Android's Tier.kt (/web/15). Every
//  action-tier body classifies once (cached) as JSE (the portable subset — the Stack.swift
//  interpreter) or JS (a real, sandboxed engine per /web/12). The verdicts MATCH the other
//  runners' token screen: the beyond-subset keyword set, generator functions, labeled
//  loops, accessor shapes; contextual words (get/set as calls or reads, member-position
//  `.with(...)` — the Array method, ternary colons, object keys, keywords inside
//  strings/comments) stay JSE. Conservative in the safe direction — a missed construct
//  classifies JSE and runs exactly as today. Verdict equivalence is corpus-gated:
//  OpenSource/Conformance/tier/verdicts.json (ConformanceHosts.TierConformance on the
//  record lane; the TS and Kotlin twins run the same file).
//
//  iOS BINDS THE REAL ENGINE HERE: JavaScriptCore is a system framework (no dependency
//  wave, no WebKit — the confinement rule names WebKit only, and this imports none), so
//  `JsTier.engine` defaults to the JSC executor below. The executor is the web
//  jstier.ts design executed inside JSC: a JS-side bootstrap builds the `with` fence and
//  the `dsx` facade over host-callback blocks, pending writes overlay reads and apply
//  BATCHED at settle (/web/15 law 3 — the engine emits operations, never touches live
//  state), and the /web/12 watchdog bounds the body TWICE: the promise race releases
//  the surface, and JSC's own execution watchdog (JSContextGroupSetExecutionTimeLimit,
//  same budget) terminates a synchronous loop the race alone could never stop — the
//  kill switch, LANDED (rendering-1.0-finalization.md). OTA policy: bodies arriving
//  over the air stay JSE-tier by default; `JsTierPolicy.otaEscalation` is the flag
//  (law 3) — bundled first-party markup escalates freely, which is what this executor
//  serves. v1 ships the flag only: per-body markup provenance is not knowable at the
//  escalation site yet (Stack.swift runActionBody — see JsTierPolicy below).
//

import Foundation
import JavaScriptCore

enum BodyTier { case jse, js }

struct TierVerdict {
    let tier: BodyTier
    let reason: String?
}

/// The engine seam (/web/15 law 3) — mirrors Android's JsTierEnv / the web JsTierEnv 1:1.
protocol JsTierEnvironment {
    func read(_ path: String) -> Any?
    func write(_ path: String, _ value: Any?)
    func callAction(_ name: String, _ args: [String: Any]) -> Any?
    func callModule(_ chain: String, _ args: [String: Any], _ completion: @escaping (Any?) -> Void)
    func emitEvent(_ name: String, _ payload: [String: Any])
    func log(_ message: String)
    func error(_ code: String, _ message: String)
}

protocol JsTierEngine {
    func run(_ body: String, env: JsTierEnvironment, done: @escaping () -> Void)
}

enum JsTier {
    /// iOS ships the engine by default — JavaScriptCore is always present.
    static var engine: JsTierEngine? = JsTierJSCEngine()
}

/// The OTA escalation policy (/web/15 law 3): "Markup delivered over the air executes
/// JSE tier only by default. Escalation for OTA content is a flag (aligned with the W0
/// recommendation that OTA-on-web ships behind a flag). Locally bundled first-party
/// markup escalates freely." — the spec, verbatim. WIRED ON iOS TODAY: the flag exists
/// with the safe default (off). NOT WIRED: the consult at the escalation site — the
/// runner cannot tell, inside runActionBody, whether the current body's markup arrived
/// over the air (the source plane publishes per-PLANE app state — `source.routes` /
/// `source.web` / `source.content`, Source.swift — not per-body provenance), so the
/// escalation site stays unconditional and the consult lands with the source-plane
/// integration. No fake provenance channel until then.
enum JsTierPolicy {
    /// May OTA-delivered markup escalate to the JS tier? Default false per law 3.
    static var otaEscalation = false
}

enum TierClassifier {
    private static let beyondSubset: Set<String> = ["class", "extends", "super", "yield", "with", "debugger"]
    private static var cache: [String: TierVerdict] = [:]
    private static let lock = NSLock()

    static func classify(_ body: String) -> TierVerdict {
        lock.lock()
        if let hit = cache[body] { lock.unlock(); return hit }
        lock.unlock()
        let verdict = screen(body)
        lock.lock()
        if cache.count > 1024 { cache.removeAll(keepingCapacity: true) }
        cache[body] = verdict
        lock.unlock()
        return verdict
    }

    private static func screen(_ body: String) -> TierVerdict {
        let words = lex(body)
        for i in words.indices {
            let w = words[i]
            if beyondSubset.contains(w) {
                // member-position `with` is the ARRAY METHOD (`[1,2].with(1,9)` — in the
                // JSE method table, corpus stdlib-001), never the statement; only the bare
                // keyword shape escalates (the TS twin's rule — `?.` lexes here as `?` + `.`,
                // so the dot check covers optional chains too). Corpus tier/verdicts.json
                // `array-with-member` pins this cross-runtime.
                if w == "with", i >= 1, words[i - 1] == "." { continue }
                return TierVerdict(tier: .js, reason: "'\(w)' is outside the JSE grammar")
            }
            // accessor shape: `get name (` / `set name (` — plain get(...)/reads stay JSE
            if (w == "get" || w == "set"), i + 2 < words.count,
               isIdentifier(words[i + 1]), words[i + 2] == "(" {
                return TierVerdict(tier: .js, reason: "'\(w)' accessors are outside the JSE grammar")
            }
            // generators: `function *`
            if w == "function", i + 1 < words.count, words[i + 1] == "*" {
                return TierVerdict(tier: .js, reason: "generator functions are outside the JSE grammar")
            }
            // labeled statements: `name : (for|while|do)` — JSE loops are unlabeled
            if w == ":", i >= 1, isIdentifier(words[i - 1]), i + 1 < words.count,
               words[i + 1] == "for" || words[i + 1] == "while" || words[i + 1] == "do" {
                return TierVerdict(tier: .js, reason: "labeled loops are outside the JSE grammar")
            }
        }
        return TierVerdict(tier: .jse, reason: nil)
    }

    private static func isIdentifier(_ s: String) -> Bool {
        guard let first = s.first, first.isLetter || first == "_" || first == "$" else { return false }
        return s.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "$" }
    }

    /// identifiers + single punctuation, strings and comments skipped — the keyword
    /// screen's lexer, deliberately no more (the twins' rules verbatim).
    private static func lex(_ body: String) -> [String] {
        var out: [String] = []
        let c = Array(body)
        var i = 0
        let n = c.count
        while i < n {
            let ch = c[i]
            if ch == "/" && i + 1 < n && c[i + 1] == "/" {
                while i < n && c[i] != "\n" { i += 1 }
            } else if ch == "/" && i + 1 < n && c[i + 1] == "*" {
                i += 2
                while i + 1 < n && !(c[i] == "*" && c[i + 1] == "/") { i += 1 }
                i = min(i + 2, n)
            } else if ch == "\"" || ch == "'" || ch == "`" {
                let quote = ch; i += 1
                while i < n && c[i] != quote {
                    if c[i] == "\\" { i += 1 }
                    i += 1
                }
                i += 1
            } else if ch.isLetter || ch == "_" || ch == "$" {
                let start = i
                while i < n && (c[i].isLetter || c[i].isNumber || c[i] == "_" || c[i] == "$") { i += 1 }
                out.append(String(c[start..<i]))
            } else if ch.isWhitespace {
                i += 1
            } else {
                out.append(String(ch)); i += 1
            }
        }
        return out
    }
}

// ── the JavaScriptCore executor ──────────────────────────────────────────────────────────

/// The kill-switch symbol: exported by JavaScriptCore, but declared in
/// JSContextRefPrivate.h, which the SDK does not surface to Swift — so the shipped
/// symbol is re-declared here (the C signature verbatim; a nil callback means
/// "terminate unconditionally when the limit hits"). `JSContextGetGroup` itself is
/// public JSContextRef.h API and imports normally.
@_silgen_name("JSContextGroupSetExecutionTimeLimit")
private func JSContextGroupSetExecutionTimeLimit(
    _ group: JSContextGroupRef?, _ limit: Double,
    _ callback: UnsafeRawPointer?, _ callbackContext: UnsafeMutableRawPointer?
)

/// The web jstier.ts design inside JSC. The bootstrap below is the SAME fence/facade
/// construction the web executor performs in TS — one design, two hosts.
final class JsTierJSCEngine: JsTierEngine {
    private static let queue = DispatchQueue(label: "dsx.jstier", qos: .userInitiated)
    private static let timeoutMs = 5000

    /// The JS bootstrap: builds the pending-write overlay, the data-root proxies, the
    /// dsx facade, and the `with` fence; runs the body async; flushes writes at settle.
    private static let bootstrap = """
    (function ($read, $write, $callAction, $callModule, $emit, $log, $error, $body) {
      var pending = new Map();
      function overlayRead(path) { return pending.has(path) ? pending.get(path) : $read(path); }
      function dataRoot(root) {
        return new Proxy({}, {
          get: function (_t, key) { return typeof key === 'string' ? overlayRead('dsx.' + root + '.' + key) : undefined; },
          set: function (_t, key, value) { if (typeof key === 'string') pending.set('dsx.' + root + '.' + key, value); return true; },
          has: function () { return true; }
        });
      }
      function moduleChain(chain) {
        return new Proxy(function () {}, {
          get: function (_t, key) {
            if (typeof key !== 'string' || key === 'then') return undefined;
            return moduleChain(chain.length === 0 ? key : chain + '.' + key);
          },
          apply: function (_t, _this, args) {
            return new Promise(function (resolve) {
              $callModule(chain, (args[0] !== null && typeof args[0] === 'object') ? args[0] : {}, resolve);
            });
          }
        });
      }
      var dsx = {
        variable: dataRoot('variable'),
        global: dataRoot('global'),
        cookie: dataRoot('cookie'),
        get this() { return overlayRead('dsx.this'); },
        get item() { return overlayRead('dsx.item'); },
        get route() { return overlayRead('dsx.route'); },
        get query() { return overlayRead('dsx.query'); },
        get app() { return overlayRead('dsx.app'); },
        get screen() { return overlayRead('dsx.screen'); },
        action: new Proxy({}, {
          get: function (_t, key) {
            return typeof key === 'string' ? function (args) { return $callAction(key, args || {}); } : undefined;
          }
        }),
        module: moduleChain(''),
        event: function (name, payload) { $emit(String(name), payload || {}); },
        send: function (name, payload) { $emit(String(name), payload || {}); },
        broadcast: function (name, payload) { $emit(String(name), payload || {}); },
        log: function () { $log(Array.prototype.map.call(arguments, function (a) { return String(a); }).join(' ')); },
        error: function (code, message) { $error(String(code), message === undefined ? '' : String(message)); }
      };
      var fence = new Proxy({}, {
        has: function () { return true; },
        get: function (_t, key) {
          if (typeof key !== 'string') return undefined;
          if (key === 'dsx') return dsx;
          var lib = { Math: Math, JSON: JSON, Object: Object, Array: Array, String: String,
                      Number: Number, Boolean: Boolean, Date: Date, RegExp: RegExp, Map: Map,
                      Set: Set, Symbol: Symbol, Promise: Promise, Error: Error, NaN: NaN,
                      Infinity: Infinity, undefined: undefined,
                      parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite };
          if (key in lib) return lib[key];
          return overlayRead(key);
        },
        set: function (_t, key, value) { if (typeof key === 'string') pending.set(key, value); return true; }
      });
      var run = new Function('$fence', 'with ($fence) { return (async function () {\\n' + $body + '\\n})(); }');
      function flush() { pending.forEach(function (value, path) { $write(path, value); }); }
      return Promise.resolve()
        .then(function () { return run(fence); })
        .then(function () { flush(); return null; },
              function (err) { flush(); $error('uncaught', String(err && err.message ? err.message : err)); return null; });
    })
    """

    func run(_ body: String, env: JsTierEnvironment, done: @escaping () -> Void) {
        JsTierJSCEngine.queue.async {
            guard let context = JSContext() else {
                DispatchQueue.main.async {
                    env.error("js_tier_unavailable", "JavaScriptCore context creation failed")
                    done()
                }
                return
            }
            context.exceptionHandler = { _, exception in
                let message = exception?.toString() ?? "unknown"
                // JSC's watchdog surfaces termination as an exception reading "JavaScript
                // execution terminated." — report the timeout it is, not a body bug. Any
                // other message keeps the exception code.
                let code = message.lowercased().contains("execution terminated")
                    ? "js_tier_timeout" : "js_tier_exception"
                DispatchQueue.main.async { env.error(code, message) }
            }
            // The synchronous-loop kill switch (/web/12): the promise race below can only
            // release the surface — it cannot stop a body that never yields, e.g.
            // `while (true) {}`. JSC's own execution watchdog can: past the limit the vm
            // throws a termination exception the body cannot catch, which surfaces through
            // the exceptionHandler above (mapped to js_tier_timeout there) and fails the
            // settle. Same budget as the async watchdog — one constant, two enforcement
            // points.
            if let group = JSContextGetGroup(context.jsGlobalContextRef) {
                JSContextGroupSetExecutionTimeLimit(group, Double(JsTierJSCEngine.timeoutMs) / 1000.0, nil, nil)
            }
            let read: @convention(block) (String) -> Any? = { path in env.read(path) }
            let write: @convention(block) (String, Any?) -> Void = { path, value in
                DispatchQueue.main.async { env.write(path, value) }
            }
            let callAction: @convention(block) (String, [String: Any]) -> Any? = { name, args in
                var result: Any?
                DispatchQueue.main.sync { result = env.callAction(name, args) }
                return result
            }
            let callModule: @convention(block) (String, [String: Any], JSValue) -> Void = { chain, args, resolve in
                DispatchQueue.main.async {
                    env.callModule(chain, args) { envelope in
                        JsTierJSCEngine.queue.async { resolve.call(withArguments: [envelope ?? NSNull()]) }
                    }
                }
            }
            let emit: @convention(block) (String, [String: Any]) -> Void = { name, payload in
                DispatchQueue.main.async { env.emitEvent(name, payload) }
            }
            let log: @convention(block) (String) -> Void = { message in
                DispatchQueue.main.async { env.log(message) }
            }
            let error: @convention(block) (String, String) -> Void = { code, message in
                DispatchQueue.main.async { env.error(code, message) }
            }
            guard let entry = context.evaluateScript(JsTierJSCEngine.bootstrap),
                  let settled = entry.call(withArguments: [
                      unsafeBitCast(read, to: AnyObject.self),
                      unsafeBitCast(write, to: AnyObject.self),
                      unsafeBitCast(callAction, to: AnyObject.self),
                      unsafeBitCast(callModule, to: AnyObject.self),
                      unsafeBitCast(emit, to: AnyObject.self),
                      unsafeBitCast(log, to: AnyObject.self),
                      unsafeBitCast(error, to: AnyObject.self),
                      body,
                  ]) else {
                DispatchQueue.main.async {
                    env.error("js_tier_exception", "escalated body failed to start")
                    done()
                }
                return
            }
            // settle → done (the promise resolves after the batched flush); the /web/12
            // watchdog releases the surface if the body never settles.
            var finished = false
            let finish: @convention(block) () -> Void = {
                if finished { return }
                finished = true
                DispatchQueue.main.async { done() }
            }
            let finishValue = unsafeBitCast(finish, to: AnyObject.self)
            settled.invokeMethod("then", withArguments: [finishValue, finishValue])
            JsTierJSCEngine.queue.asyncAfter(deadline: .now() + .milliseconds(JsTierJSCEngine.timeoutMs)) {
                if finished { return }
                finished = true
                DispatchQueue.main.async {
                    env.error("js_tier_timeout", "JS-tier body exceeded \(JsTierJSCEngine.timeoutMs)ms — the watchdog released the surface (/web/12)")
                    done()
                }
            }
        }
    }
}
