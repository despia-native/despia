//
//  ConformanceHosts.swift - VERIFY MODE for the actions + <api> conformance corpora.
//
//  The jse corpus is RECORD-mode (JSEConformanceRecord regenerates `expected` from the Swift
//  kernel). The actions and <api> corpora instead carry EXPECTATIONS (expectStore / expect /
//  expectCalls / expectEvents), so their Swift host VERIFIES: it runs every case through the
//  REAL Swift runtime — `JSERunner` for actions, `ApiBlock` for <api> — and throws on the first
//  disagreement. This is the byte-for-byte twin of the Kotlin ActionConformanceTest /
//  ApiConformanceTest (the TS kernel runs the SAME files), so iOS stops being the one runtime
//  the actions/api corpora never execute on — the honest gap the READMEs called out.
//
//  Like JSEConformanceRecord.swift: NOT part of any app or extension target (the committed Xcode
//  project references no conformance file; prepare_modules.rb never adds engine refs). It compiles
//  ONLY in the Codemagic `conformance-record` lane, alongside the rest of OpenSource/Engine, via
//  RecordMain.swift. Foundation-only; pure computation + file IO; no UI, no network (fetch is a
//  seamed response queue, the clock is injected — deterministic by construction).
//

import Foundation

/// Expected leaf values compare as ABSENT null — the corpus runner contract (an unset store
/// path reads back null, and the fixtures write `null` for "absent").
private func conformanceUnwrapNull(_ v: Any?) -> Any? { (v is NSNull) ? nil : v }

// MARK: - pointer-input lifecycle corpus (input/hover.json)

enum HoverConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Execute the exact Stack.swift state machine used by the SwiftUI adapter. The UI
    /// toolkit supplies one synthetic pointer id, but the state machine intentionally
    /// retains arbitrary ids so this corpus also pins Web/Compose multi-pointer parity.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard (doc["version"] as? NSNumber)?.intValue == 1 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported version")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }

        for c in cases {
            let name = c["name"] as? String ?? "?"
            var hover = StackHoverLifecycle()
            var actions: [String] = []
            for event in c["events"] as? [[String: Any]] ?? [] {
                let pointer = event["pointer"] as? String ?? ""
                let emitted: [StackHoverLifecycleAction]
                switch event["type"] as? String {
                case "enter":
                    emitted = hover.enter(pointerID: pointer,
                                          pointerKind: event["kind"] as? String ?? "unknown",
                                          hoverCapable: event["hoverCapable"] as? Bool ?? false)
                case "leave": emitted = hover.leave(pointerID: pointer)
                case "cancel": emitted = hover.cancel(pointerID: pointer)
                case "unmount": emitted = hover.unmount()
                default:
                    throw Failure(description: "hover/\(name): unknown event \(String(describing: event["type"]))")
                }
                actions.append(contentsOf: emitted.map(\.rawValue))
            }
            let expected = c["expect"] as? [String] ?? []
            if actions != expected {
                throw Failure(description: "hover/\(name): actions \(actions) (expected \(expected))")
            }
            let active = hover.activePointers.sorted()
            let expectedActive = (c["expectActive"] as? [String] ?? []).sorted()
            if active != expectedActive {
                throw Failure(description: "hover/\(name): active \(active) (expected \(expectedActive))")
            }
        }
        return cases.count
    }
}

// MARK: - platform fold + vocabulary corpus (platform/platform.json)

enum PlatformConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/platform/platform.json through the Swift `StackPlatformAttrs` —
    /// the SAME file the TS `platform-conformance.test.ts` and Kotlin `PlatformConformanceTest`
    /// assert. Pins the vocabulary (exact targets + group members) against drift and re-derives
    /// every `fold[]` and `identity[]` row on the reference renderer, so the Swift fold stops being
    /// the one implementation the platform corpus never executes (the corpus `_note` claims the
    /// record lane pins it — this makes that true).
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let targets = root["targets"] as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no targets{}")
        }
        // Vocabulary drift gate — exact targets + group members must equal the reference's.
        let corpusExact = Set((targets["exact"] as? [String]) ?? [])
        guard corpusExact == StackPlatformAttrs.exactTargets else {
            throw Failure(description: "platform: exact targets \(StackPlatformAttrs.exactTargets.sorted()) != corpus \(corpusExact.sorted())")
        }
        var corpusGroups: [String: Set<String>] = [:]
        for (group, members) in (targets["groups"] as? [String: Any]) ?? [:] {
            corpusGroups[group] = Set((members as? [String]) ?? [])
        }
        guard corpusGroups == StackPlatformAttrs.groups else {
            throw Failure(description: "platform: groups \(StackPlatformAttrs.groups) != corpus \(corpusGroups)")
        }

        var count = 0
        // Fold matrix — resolve(attrs, target) must equal every declared per-target expectation.
        for (index, raw) in ((root["fold"] as? [[String: Any]]) ?? []).enumerated() {
            let name = raw["name"] as? String ?? "fold[\(index)]"
            let attrs = (raw["attrs"] as? [String: String]) ?? [:]
            guard let expect = raw["expect"] as? [String: Any] else {
                throw Failure(description: "platform/\(name): no expect{}")
            }
            for (target, expectedRaw) in expect {
                guard let expected = expectedRaw as? [String: String] else {
                    throw Failure(description: "platform/\(name) @\(target): expectation is not a string map")
                }
                let got = StackPlatformAttrs.resolve(attrs, target: target)
                guard got == expected else {
                    throw Failure(description: "platform/\(name) @\(target): \(got) (expected \(expected))")
                }
                count += 1
            }
        }
        // Identity — native/desktop membership is derived from the SAME group tables.
        for (index, raw) in ((root["identity"] as? [[String: Any]]) ?? []).enumerated() {
            let os = raw["os"] as? String ?? "identity[\(index)]"
            guard let expect = raw["expect"] as? [String: Any] else {
                throw Failure(description: "platform identity/\(os): no expect{}")
            }
            let native = StackPlatformAttrs.groups["native"]?.contains(os) ?? false
            let desktop = StackPlatformAttrs.groups["desktop"]?.contains(os) ?? false
            if let expectedNative = expect["native"] as? Bool, expectedNative != native {
                throw Failure(description: "platform identity/\(os): native \(native) (expected \(expectedNative))")
            }
            if let expectedDesktop = expect["desktop"] as? Bool, expectedDesktop != desktop {
                throw Failure(description: "platform identity/\(os): desktop \(desktop) (expected \(expectedDesktop))")
            }
            count += 1
        }
        return count
    }
}

// MARK: - desktop input grammar corpus (input/{shortcut,focusOrder,multiline-submit}.json)

enum ShortcutConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/input/shortcut.json through the shared StackDesktopInput matcher.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["version"] as? Int) == 1 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported version")
        }
        guard let cases = root["cases"] as? [[String: Any]] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            guard let shortcut = raw["shortcut"] as? String,
                  let event = raw["event"] as? [String: Any],
                  let expected = raw["fires"] as? Bool else {
                throw Failure(description: "shortcut/\(name): malformed case")
            }
            let got = StackDesktopInput.matchesShortcut(
                shortcut,
                key: event["key"] as? String ?? "",
                meta: event["meta"] as? Bool ?? false,
                ctrl: event["ctrl"] as? Bool ?? false,
                alt: event["alt"] as? Bool ?? false,
                shift: event["shift"] as? Bool ?? false,
                editable: event["editable"] as? Bool ?? false)
            guard got == expected else {
                throw Failure(description: "shortcut/\(name): fires \(got) (expected \(expected))")
            }
        }
        return cases.count
    }
}

/// Run OpenSource/Conformance/input/multiline-submit.json through the shared grammar - what
/// Return does in a MULTILINE field, which is a hardware-keyboard question everywhere (a soft
/// keyboard's Return stays a newline, which is why the corpus never asks about one).
enum MultilineSubmitConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["version"] as? Int) == 1 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported version")
        }
        guard let cases = root["cases"] as? [[String: Any]] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }
        let keys = Set((root["returnKeys"] as? [String] ?? []))
        guard keys == StackDesktopInput.returnKeys else {
            throw Failure(description: "multiline-submit: the Return spellings are a shared fact, "
                + "not a per-toolkit guess (\(StackDesktopInput.returnKeys) vs \(keys))")
        }
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            guard let event = raw["event"] as? [String: Any],
                  let expected = raw["expect"] as? String else {
                throw Failure(description: "multiline-submit/\(name): malformed case")
            }
            let got = StackDesktopInput.multilineReturn(
                key: event["key"] as? String ?? "",
                shift: event["shift"] as? Bool ?? false,
                meta: event["meta"] as? Bool ?? false,
                ctrl: event["ctrl"] as? Bool ?? false,
                alt: event["alt"] as? Bool ?? false,
                submitOnEnter: raw["submitOnEnter"] as? Bool ?? false,
                hasSubmit: raw["hasSubmit"] as? Bool ?? false)
            guard got == expected else {
                throw Failure(description: "multiline-submit/\(name): \(got) (expected \(expected))")
            }
        }
        return cases.count
    }
}

enum FocusOrderConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/input/focusOrder.json through the shared StackDesktopInput resolver.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["version"] as? Int) == 1 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported version")
        }
        guard let cases = root["cases"] as? [[String: Any]] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let disabled = raw["disabled"] as? Bool ?? false
            let got = StackDesktopInput.resolveFocusOrder(raw["focusOrder"] as? String, disabled: disabled)
            let expected = raw["index"] as? Int
            guard got == expected else {
                throw Failure(description: "focusOrder/\(name): index \(String(describing: got)) (expected \(String(describing: expected)))")
            }
        }
        return cases.count
    }
}

// MARK: - tooltip grammar corpus (input/tooltip.json)

enum TooltipConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/input/tooltip.json through the Swift StackTooltip fold and
    /// StackTooltipLifecycle state machine (design-system.md Wave 3 (c)1) — the SAME file the
    /// TS tooltip.test.ts and Kotlin TooltipConformanceTest execute, so the universal hint
    /// attribute can't drift: touch never reveals, Escape dismisses, and a resolved tooltip
    /// always doubles as the element's accessibility description.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["version"] as? Int) == 1 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported version")
        }
        guard let resolveCases = root["resolve"] as? [[String: Any]], !resolveCases.isEmpty,
              let lifecycleCases = root["lifecycle"] as? [[String: Any]], !lifecycleCases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no resolve[]/lifecycle[]")
        }
        var count = 0
        for raw in resolveCases {
            let name = raw["name"] as? String ?? "?"
            let got = StackTooltip.resolve(raw["tooltip"] as? String, side: raw["tooltipSide"] as? String)
            if let expect = raw["expect"] as? [String: Any] {
                guard let got else {
                    throw Failure(description: "tooltip/\(name): resolved nil (expected \(expect))")
                }
                guard got.text == expect["text"] as? String, got.side == expect["side"] as? String else {
                    throw Failure(description: "tooltip/\(name): (\(got.text), \(got.side)) disagrees with the corpus")
                }
                guard expect["described"] as? Bool == true else {
                    throw Failure(description: "tooltip/\(name): a resolved tooltip must describe its element")
                }
            } else if got != nil {
                throw Failure(description: "tooltip/\(name): resolved \(String(describing: got)) (expected none)")
            }
            count += 1
        }
        for raw in lifecycleCases {
            let name = raw["name"] as? String ?? "?"
            var machine = StackTooltipLifecycle()
            var actions: [String] = []
            for event in raw["events"] as? [[String: Any]] ?? [] {
                let capable = event["hoverCapable"] as? Bool ?? false
                let emitted: [StackTooltipAction]
                switch event["type"] as? String {
                case "hoverStart": emitted = machine.hoverStart(hoverCapable: capable)
                case "hoverEnd": emitted = machine.hoverEnd()
                case "focus": emitted = machine.focus(hoverCapable: capable)
                case "blur": emitted = machine.blur()
                case "escape": emitted = machine.escape()
                case "unmount": emitted = machine.unmount()
                default:
                    throw Failure(description: "tooltip/\(name): unknown event \(String(describing: event["type"]))")
                }
                actions.append(contentsOf: emitted.map(\.rawValue))
            }
            let expected = raw["expect"] as? [String] ?? []
            guard actions == expected else {
                throw Failure(description: "tooltip/\(name): actions \(actions) (expected \(expected))")
            }
            guard machine.visible == (raw["expectVisible"] as? Bool ?? false) else {
                throw Failure(description: "tooltip/\(name): visible \(machine.visible)")
            }
            count += 1
        }
        return count
    }
}

enum DensityConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/input/density.json through the Swift StackDensity fold and
    /// subtree resolution (component-library.md W9 — the universal density knob) — the SAME
    /// file the TS density.test.ts and Kotlin DensityConformanceTest execute, so the knob
    /// can't drift: exact-lowercase vocabulary, nearest-ancestor pin, fine-pointer platform
    /// default compact.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["version"] as? Int) == 1 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported version")
        }
        guard let resolveCases = root["resolve"] as? [[String: Any]], !resolveCases.isEmpty,
              let effectiveCases = root["effective"] as? [[String: Any]], !effectiveCases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no resolve[]/effective[]")
        }
        var count = 0
        for raw in resolveCases {
            let name = raw["name"] as? String ?? "?"
            let got = StackDensity.resolve(raw["density"] as? String)
            let expect = raw["expect"] as? String
            guard got == expect else {
                throw Failure(description: "density/\(name): \(String(describing: got)) (expected \(String(describing: expect)))")
            }
            count += 1
        }
        for raw in effectiveCases {
            let name = raw["name"] as? String ?? "?"
            let chain = (raw["chain"] as? [Any] ?? []).map { $0 as? String }
            let got = StackDensity.effective(chain, finePointer: raw["finePointer"] as? Bool ?? false)
            guard got == raw["expect"] as? String else {
                throw Failure(description: "density/\(name): \(got) disagrees with the corpus")
            }
            count += 1
        }
        return count
    }
}

enum ActionsConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/actions/actions.json through the Swift `JSERunner` and assert
    /// each case's expectStore + expectEvents. Returns the number of cases verified; throws on
    /// the first mismatch (or a malformed corpus — a silently-skipped suite is how drift starts).
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }
        for c in cases {
            let name = (c["name"] as? String) ?? "?"

            let store = StackStore()
            let scope = (c["scope"] as? [String: Any]) ?? [:]
            for (k, v) in scope { store.vars[k] = v }

            let actions = (c["actions"] as? [String: [String: Any]]) ?? [:]
            for (actionName, decl) in actions {
                var inputs: [String: String] = [:]
                for (k, v) in (decl["inputs"] as? [String: Any]) ?? [:] { inputs[k] = JSE.string(v) }
                store.actions[actionName] = StackFormula(inputs: inputs, body: JSE.string(decl["body"]))
            }

            var events: [String] = []
            store.anyHandlers.append { evName, _ in events.append(evName) }

            let runner = JSERunner(store: store, webView: nil, scope: nil, dsx: nil)
            if let runAction = c["runAction"] as? String {
                // The HOST entry path — what an HTTP request, a CLI command and a queue message
                // all do: a payload, and no caller scope.
                runner.runAction(runAction,
                                 payload: (c["runPayload"] as? [String: Any]) ?? [:],
                                 item: c["runItem"] as? [String: Any])
            } else {
                runner.run(JSE.string(c["run"]), item: c["runItem"] as? [String: Any])
            }

            for (path, expected) in (c["expectStore"] as? [String: Any]) ?? [:] {
                let actual = JSE.eval(path, store: store, item: nil)
                if !JSE.equals(conformanceUnwrapNull(actual), conformanceUnwrapNull(expected)) {
                    throw Failure(description: "actions/\(name): \(path) -> \(JSE.string(actual)) (expected \(JSE.string(expected)))")
                }
            }
            let expectEvents = ((c["expectEvents"] as? [Any]) ?? []).map { JSE.string($0) }
            if expectEvents != events {
                throw Failure(description: "actions/\(name): event order \(events) (expected \(expectEvents))")
            }
        }
        return cases.count
    }
}

// MARK: - the watch-dispatch corpus (actions/watch-dispatch.json — `<watch value= on:change=>`)

enum WatchConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/actions/watch-dispatch.json through this runtime's dispatch:
    /// the WatchView evaluate loop (Stack.swift — evaluate `value`, compare JSE.watchKey, fire
    /// on meaningful change, never on subscribe) feeding WatchView.fire's dispatch (the payload
    /// rule + `run(change, item: payload, args: payload)` against the LIVE store; the budget and
    /// afterRender hop are render-tick machinery, not dispatch semantics). The TS harness
    /// (watch-conformance.test.ts) and the Kotlin twin (WatchConformanceTest.kt, the real
    /// JSERunner.fireWatch) execute the SAME file.
    ///
    /// Pinned after the W12 stale-snapshot investigation: a watch handler observes the
    /// POST-WRITE store — every store read inside the handler sees the state that triggered the
    /// fire. (The filed 2026-08-17 starter toggle revert was the wave-7 F4 entity lexing
    /// assigning 0 through this path, never a snapshot — jse/syntax-006 pins the decode, the
    /// corpus's entity-spelled row pins the hold.) The settle loop below is the host's stand-in
    /// for the SwiftUI update pass: after the bound-control `pre` writes and after the entry,
    /// re-evaluate every watch and fire the changed ones until a quiet round (bounded — corpus
    /// rows are synchronous; fire COUNT within one multi-write entry stays unpinned).
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }
        for c in cases {
            let name = (c["name"] as? String) ?? "?"

            // The app-wide plane: DSX.state is a process singleton — bind the boot seam
            // (DSXBoot binds the same closure), snapshot + restore vars per case.
            let savedAppVars = JSE.appVars
            let savedState = DSX.state.vars
            JSE.appVars = { DSX.state.vars }
            defer { JSE.appVars = savedAppVars; DSX.state.vars = savedState }
            DSX.state.vars = (c["global"] as? [String: Any]) ?? [:]

            let store = StackStore()
            for (k, v) in (c["scope"] as? [String: Any]) ?? [:] { store.vars[k] = v }

            let actions = (c["actions"] as? [String: [String: Any]]) ?? [:]
            for (actionName, decl) in actions {
                var inputs: [String: String] = [:]
                for (k, v) in (decl["inputs"] as? [String: Any]) ?? [:] { inputs[k] = JSE.string(v) }
                store.actions[actionName] = StackFormula(inputs: inputs, body: JSE.string(decl["body"]))
            }

            var events: [String] = []
            store.anyHandlers.append { evName, _ in events.append(evName) }

            let runner = JSERunner(store: store, webView: nil, scope: nil, dsx: nil)

            // Subscribe: evaluate once, record the key, NEVER fire (the WatchView prev-nil arm;
            // no corpus row declares `immediate`).
            let watches = (c["watches"] as? [[String: Any]]) ?? []
            let exprs = watches.map { JSE.string($0["value"]) }
            let handlers = watches.map { JSE.string($0["handler"]) }
            var last = exprs.map { JSE.watchKey(JSE.eval($0, store: store, item: nil)) }

            // One update-pass settle: re-evaluate every watch, fire the meaningfully changed
            // ones with WatchView.fire's payload rule, repeat until a quiet round.
            func settle() {
                for _ in 0..<32 {
                    var fired = false
                    for i in exprs.indices {
                        let v = JSE.eval(exprs[i], store: store, item: nil)
                        let key = JSE.watchKey(v)
                        if key != last[i] {
                            last[i] = key
                            fired = true
                            let payload: [String: Any] = (v as? [String: Any]) ?? ["value": v as Any]
                            runner.run(handlers[i], item: payload, args: payload)
                        }
                    }
                    if !fired { break }
                }
            }

            for p in (c["pre"] as? [[String: Any]]) ?? [] {
                store.writeBound(JSE.string(p["path"]), p["value"] ?? NSNull())
            }
            settle()

            runner.run(JSE.string(c["run"]), item: c["runItem"] as? [String: Any])
            settle()

            for (path, expected) in (c["expectStore"] as? [String: Any]) ?? [:] {
                let actual = JSE.eval(path, store: store, item: nil)
                if !JSE.equals(conformanceUnwrapNull(actual), conformanceUnwrapNull(expected)) {
                    throw Failure(description: "watch/\(name): \(path) -> \(JSE.string(actual)) (expected \(JSE.string(expected)))")
                }
            }
            for (path, expected) in (c["expectGlobal"] as? [String: Any]) ?? [:] {
                let actual = DSX.state.getPath(path)
                if !JSE.equals(conformanceUnwrapNull(actual), conformanceUnwrapNull(expected)) {
                    throw Failure(description: "watch/\(name): global.\(path) -> \(JSE.string(actual)) (expected \(JSE.string(expected)))")
                }
            }
            let expectEvents = ((c["expectEvents"] as? [Any]) ?? []).map { JSE.string($0) }
            if expectEvents != events {
                throw Failure(description: "watch/\(name): event order \(events) (expected \(expectEvents))")
            }
        }
        return cases.count
    }
}

/// dotted-path read over a plain materialized-request value (no store involved) —
/// the twin of the TS/Kotlin `requestPath` helpers.
func conformanceRequestPath(_ value: Any?, _ path: String) -> Any? {
    var cur: Any? = value
    for part in path.split(separator: ".", omittingEmptySubsequences: false).map(String.init) {
        if cur == nil || cur is NSNull { return nil }
        if let list = cur as? [Any] {
            if part == "length" { cur = Double(list.count); continue }
            if let index = Int(part), index >= 0, index < list.count { cur = list[index]; continue }
            return nil
        }
        if let text = cur as? String, part == "length" { cur = Double(text.count); continue }
        cur = (cur as? [String: Any])?[part]
    }
    return cur
}

enum ApiConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/api/api-blocks.json through the Swift `ApiBlock` with a seamed
    /// fetch (a response queue), an injected clock, and the sync step interpreter (settle is a
    /// no-op — the async races are the web unit suite's job), asserting expect / expectCalls /
    /// expectBodies / expectEvents. Returns the number of cases verified; throws on the first
    /// mismatch. Twin of ApiConformanceTest.kt.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            ApiBlock.clearCache()

            // /web/11: a case declares EITHER one `spec` or an ORDERED `specs` list
            // (the dependency-graph cases) — one scope, one graph.
            let specsRaw = (c["specs"] as? [[String: Any]]) ?? [(c["spec"] as? [String: Any]) ?? [:]]
            let specs: [[String: String]] = specsRaw.map { raw in
                var out: [String: String] = [:]
                for (k, v) in raw { out[k] = JSE.string(v) }
                return out
            }
            let scope = (c["scope"] as? [String: Any]) ?? [:]
            var responses = (c["responses"] as? [[String: Any]]) ?? []
            var responsesByUrl: [String: [[String: Any]]] = [:]
            for (url, list) in (c["responsesByUrl"] as? [String: Any]) ?? [:] {
                responsesByUrl[url] = (list as? [[String: Any]]) ?? []
            }
            var calls: [String] = []
            var bodies: [Any?] = []
            var requests: [[String: Any]] = []
            var events: [String] = []
            var fakeNow: Double = 1_000_000

            let store = StackStore()
            for (k, v) in scope { store.vars[k] = v }

            // networking.md N0: seed the app-wide `dsx.const.*` plane (it rides the same
            // appVars() app store as global/env). Saved/restored so the process-global seam
            // stays isolated between cases.
            var consts: [String: Any] = (c["consts"] as? [String: Any]) ?? [:]
            let savedAppVars = JSE.appVars
            JSE.appVars = { ["const": consts] }
            defer { JSE.appVars = savedAppVars }
            // networking.md N1: the component scope an <api>-in-a-component reads.
            let item = c["item"] as? [String: Any]

            let fetch: (String, [String: Any]) -> [String: Any] = { url, req in
                calls.append(url)
                bodies.append(req["body"])
                requests.append(req)
                if var queued = responsesByUrl[url], !queued.isEmpty {
                    let next = queued.removeFirst()
                    responsesByUrl[url] = queued
                    return next
                }
                if responses.isEmpty { return ["ok": false, "status": 0.0, "data": NSNull()] }
                return responses.removeFirst()
            }
            var blocks: [(name: String, block: ApiBlock)] = []
            func make() -> ApiBlock {
                blocks.removeAll()
                let graph = ApiGraph(specs: specs)
                for one in specs {
                    blocks.append((
                        one["as"] ?? "api",
                        ApiBlock(
                            spec: one, store: store, item: item, fetch: fetch,
                            now: { fakeNow }, onEvent: { n, _ in events.append(n) },
                            graph: graph
                        )
                    ))
                }
                graph.start()
                return blocks[0].block
            }
            func pick(_ target: Any?) -> ApiBlock {
                let name = JSE.string(target)
                return blocks.first(where: { $0.name == name })?.block ?? blocks[0].block
            }
            var block = make()

            for step in (c["steps"] as? [[String: Any]]) ?? [] {
                if let set = step["set"] as? [String: Any] {
                    DsxPaths.set(store, JSE.string(set["path"]), set["value"])
                    // the watch machinery's publish → every block re-materializes
                    for entry in blocks { entry.block.storeChanged() }
                } else if let setConst = step["setConst"] as? [String: Any] {
                    consts[JSE.string(setConst["name"])] = setConst["value"]
                    for entry in blocks { entry.block.storeChanged() }   // dsx.const reactivity
                } else if step["settle"] != nil {
                    // sync runtime — nothing pending
                } else if JSE.string(step["call"]) == "refresh" {
                    pick(step["target"]).refresh()
                } else if JSE.string(step["call"]) == "cancel" {
                    pick(step["target"]).cancel()
                } else if JSE.string(step["call"]) == "remount" {
                    for entry in blocks { entry.block.dispose() }
                    block = make()
                } else if let send = step["send"] {
                    // /web/11: the last send envelope is observable at `sendResult`
                    let result = pick(step["target"]).send(send as? [String: Any])
                    store.vars["sendResult"] = result ?? NSNull()
                } else if step["advance"] != nil {
                    fakeNow += (JSE.number(step["advance"]) ?? 0) * 1000
                }
            }

            for (path, raw) in (c["expect"] as? [String: Any]) ?? [:] {
                let actual = JSE.eval(path, store: store, item: nil)
                // JSONSerialization encodes fixture null as NSNull and the runtime may
                // preserve that sentinel in its reserved API store. Normalize both sides,
                // as the actions/error harnesses do, before applying JSE equality.
                if !JSE.equals(conformanceUnwrapNull(actual), conformanceUnwrapNull(raw)) {
                    throw Failure(description: "api/\(name): \(path) -> \(JSE.string(actual)) (expected \(JSE.string(raw)))")
                }
            }
            let expectCalls = ((c["expectCalls"] as? [Any]) ?? []).map { JSE.string($0) }
            if expectCalls != calls {
                throw Failure(description: "api/\(name): seam calls \(calls) (expected \(expectCalls))")
            }
            if let expectBodies = c["expectBodies"] as? [Any] {
                for (i, b) in expectBodies.enumerated() {
                    let got: Any? = i < bodies.count ? bodies[i] : nil
                    if !JSE.equals(got, b) {
                        throw Failure(description: "api/\(name): body[\(i)] -> \(JSE.string(got))")
                    }
                }
            }
            if let expectRequests = c["expectRequests"] as? [Any] {
                for (i, raw) in expectRequests.enumerated() {
                    let expectations = (raw as? [String: Any]) ?? [:]
                    for (path, expected) in expectations {
                        let actual = conformanceRequestPath(i < requests.count ? requests[i] : nil, path)
                        if !JSE.equals(conformanceUnwrapNull(actual), conformanceUnwrapNull(expected)) {
                            throw Failure(description: "api/\(name): request[\(i)].\(path) -> \(JSE.string(actual))")
                        }
                    }
                }
            }
            let expectEvents = ((c["expectEvents"] as? [Any]) ?? []).map { JSE.string($0) }
            if expectEvents != events {
                throw Failure(description: "api/\(name): event order \(events) (expected \(expectEvents))")
            }
            for entry in blocks { entry.block.dispose() }
            _ = block
            ApiBlock.clearCache()
        }
        return cases.count
    }
}

/// Deterministic URLSession transport fixture. `/sse` deliberately remains open
/// after its first event so the test can prove `on:message` arrives before EOF;
/// `/blob` returns exact binary bytes. No DNS/socket leaves the process.
private final class ApiTransportFixtureURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var activeSSE: ApiTransportFixtureURLProtocol?
    private var stopped = false

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "transport.fixture"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else { return }
        switch url.path {
        case "/sse":
            Self.lock.lock()
            Self.activeSSE = self
            Self.lock.unlock()
            guard let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/event-stream; charset=utf-8"]
            ) else { return }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)

            // Split inside the UTF-8 encoding of "é" and use CRLF framing. The
            // delegate must retain incomplete bytes and emit this event now.
            let first = Data("data: {\"word\":\"café\"}\r\n\r\n".utf8)
            if let lead = first.firstIndex(of: 0xC3) {
                let split = first.index(after: lead)
                client?.urlProtocol(self, didLoad: Data(first[..<split]))
                client?.urlProtocol(self, didLoad: Data(first[split...]))
            } else {
                client?.urlProtocol(self, didLoad: first)
            }
        case "/blob":
            guard let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/octet-stream"]
            ) else { return }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data([0x00, 0x01, 0x02, 0xFF]))
            client?.urlProtocolDidFinishLoading(self)
        default:
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
        }
    }

    override func stopLoading() {
        stopped = true
        Self.lock.lock()
        if Self.activeSSE === self { Self.activeSSE = nil }
        Self.lock.unlock()
    }

    static func finishSSE() {
        lock.lock()
        let protocolInstance = activeSSE
        activeSSE = nil
        lock.unlock()
        guard let protocolInstance, !protocolInstance.stopped else { return }
        protocolInstance.client?.urlProtocol(
            protocolInstance,
            didLoad: Data("data: hello\ndata: world\n\n".utf8)
        )
        protocolInstance.client?.urlProtocolDidFinishLoading(protocolInstance)
    }
}

/// The shared corpus above proves ApiBlock's state law. This focused host test
/// proves the SHIPPING iOS wiring the corpus cannot see: Stack head mounting,
/// named action handles, async continuation, retry, store-publish coalescing,
/// cancellation and stale-response suppression. Every transport is an in-memory
/// seam — no DNS, sockets, clocks or real timers.
enum ApiRuntimeIntegration {
    struct Failure: Error, CustomStringConvertible { let description: String }

    private final class Call {
        let url: String
        let request: [String: Any]
        let completion: ([String: Any]) -> Void
        var cancelled = false

        init(url: String, request: [String: Any], completion: @escaping ([String: Any]) -> Void) {
            self.url = url
            self.request = request
            self.completion = completion
        }
    }

    private final class Seam {
        var calls: [Call] = []
        var cancelCount = 0

        lazy var fetch: ApiBlock.AsyncFetch = { [weak self] url, request, completion in
            guard let self else { return nil }
            let call = Call(url: url, request: request, completion: completion)
            calls.append(call)
            return { [weak self, weak call] in
                guard let self, let call, !call.cancelled else { return }
                call.cancelled = true
                self.cancelCount += 1
            }
        }
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw Failure(description: "api/runtime: \(message)") }
    }

    /// Drain main-queue completions/store observers without sleeping. Fails
    /// boundedly instead of hanging the conformance executable.
    private static func settle(
        _ description: String,
        timeout: TimeInterval = 1,
        until condition: () -> Bool
    ) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.005))
        }
        try require(condition(), "\(description) did not settle")
    }

    private static func number(_ state: any JSEState, _ path: String) -> Double? {
        JSE.number(DsxPaths.get(state, path))
    }

    static func verify() throws -> Int {
        try verifyStatePathHardening()
        try verifySurfaceMountAndHandles()
        try verifyRetry()
        try verifyCacheIsolationAndEviction()
        try verifyLiveStreamingAndBlob()
        try verifyCookieConfidentiality()
        return 6
    }

    private static func verifyStatePathHardening() throws {
        let state = JSEVars()
        DsxPaths.set(state, "negative.-1.value", "blocked")
        DsxPaths.set(state, "signed.+10000.value", "blocked")
        DsxPaths.set(state, "huge.10000.value", "blocked")
        DsxPaths.set(state, "overflow.999999999999999999999.value", "blocked")
        DsxPaths.set(state, "growth.1024.value", "blocked")
        DsxPaths.set(
            state,
            (["deep"] + (0..<64).map { "d\($0)" }).joined(separator: "."),
            "blocked"
        )
        DsxPaths.set(state, "long.\(String(repeating: "x", count: 257))", "blocked")
        DsxPaths.set(state, "unicode.\(String(repeating: "é", count: 129))", "blocked")
        DsxPaths.set(state, "leading..empty", "blocked")
        DsxPaths.set(state, "trailing.", "blocked")
        DsxPaths.set(state, ".prefixed", "blocked")
        for key in [
            "negative", "signed", "huge", "overflow", "growth", "deep", "long", "unicode",
            "leading", "trailing", "prefixed",
        ] {
            try require(state.vars[key] == nil, "hostile path left partial state at \(key)")
        }

        DsxPaths.set(state, "boundary.1023.value", "ok")
        try require(JSE.string(DsxPaths.get(state, "boundary.1023.value")) == "ok",
                    "array growth boundary was rejected")
        try require((DsxPaths.get(state, "boundary") as? [Any])?.count == 1_024,
                    "array growth boundary produced the wrong shape")

        var fetches = 0
        let invalid = ApiBlock(
            spec: ["as": "payload.-1", "url": "/api/data"],
            store: state,
            fetch: { _, _ in
                fetches += 1
                return ["ok": true, "status": 200.0, "data": NSNull()]
            }
        )
        try require(fetches == 0, "invalid <api as> started its transport")
        _ = invalid.send()
        try require(fetches == 0, "invalid <api as> send started its transport")
        invalid.dispose()
        try require(state.vars["payload"] == nil, "invalid <api as> mutated state")
    }

    private static func verifyCookieConfidentiality() throws {
        let properties: [HTTPCookiePropertyKey: Any] = [
            .domain: "cookie-confidentiality.invalid",
            .path: "/",
        ]
        guard let visible = HTTPCookie(properties: properties.merging([
            .name: "visible-session",
            .value: "markup-readable",
        ]) { _, new in new }),
        let serverOnly = HTTPCookie(properties: properties.merging([
            .name: "server-credential",
            .value: "must-not-enter-dsx",
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
        ]) { _, new in new }) else {
            throw Failure(description: "api/runtime: could not create cookie-confidentiality fixtures")
        }

        let storage = HTTPCookieStorage.shared
        defer {
            storage.deleteCookie(visible)
            storage.deleteCookie(serverOnly)
            DSXCookies.shared.ingest([])
        }

        DSXCookies.shared.ingest([visible, serverOnly])
        try settle("cookie confidentiality publication") {
            DSXCookies.shared.jar["visible-session"] == "markup-readable"
                && DSXCookies.shared.jar["server-credential"] == nil
        }
        let mirroredNames = Set((storage.cookies ?? []).map(\.name))
        try require(mirroredNames.contains("visible-session"),
                    "script-readable cookie was not mirrored to native storage")
        try require(mirroredNames.contains("server-credential"),
                    "HttpOnly cookie was not mirrored to native storage")
    }

    private static func verifySurfaceMountAndHandles() throws {
        let xml = """
        <stack>
          <head>
            <variable as="user">{ id: 1 }</variable>
            <variable as="sendResumes">0</variable>
            <functions>function functionsRawBelow(a, b) { return a < b && b > 0 }</functions>
            <api as="orders"
                 url="https://api.test/orders/{{ user.id }}"
                 on:success="lastEvent = dsx.this.status"
                 on:error="lastError = dsx.this.error.status"/>
            <api as="save" url="https://api.test/orders" method="POST" auto="false"/>
            <action as="refreshOrders">orders.refresh()</action>
            <action as="submit">
              const r = await save.send({ value: 7 });
              sendResumes = sendResumes + 1;
              sendDone = true;
              sendStatus = r.status
            </action>
            <action as="cancelSave">save.cancel()</action>
          </head>
          <vstack/>
        </stack>
        """
        guard let root = StackXML.parse(xml) else {
            throw Failure(description: "api/runtime: integration fixture did not parse")
        }
        let seam = Seam()
        let surface = StackSurface(root: root, webView: nil, apiFetch: seam.fetch)
        try require(
            JSE.truthy(JSE.eval("functionsRawBelow(1, 2)", store: surface.store, item: nil)),
            "api/runtime: raw <functions> body was not lifted and registered"
        )

        // Mount: only GET auto-fires; POST auto defaults false.
        try require(seam.calls.count == 1, "Stack mount did not create exactly one GET request")
        try require(seam.calls[0].url == "https://api.test/orders/1", "initial URL was not materialized")
        try require(JSE.truthy(DsxPaths.get(surface.store, "orders.loading")), "initial loading was not published")
        try require(!JSE.truthy(DsxPaths.get(surface.store, "save.loading")), "POST auto default must be false")

        seam.calls[0].completion([
            "ok": true, "status": 200.0,
            "data": ["version": 1.0],
        ])
        try settle("initial response") {
            number(surface.store, "orders.data.version") == 1
                && number(surface.store, "lastEvent") == 200
        }

        // HTTP failures do not retry and stale data survives the failed refresh.
        surface.action("refreshOrders")
        try require(seam.calls.count == 2, "orders.refresh() was not routed")
        seam.calls[1].completion([
            "ok": false, "status": 503.0,
            "data": ["reason": "maintenance"],
        ])
        try settle("HTTP failure") {
            number(surface.store, "orders.error.status") == 503
                && number(surface.store, "lastError") == 503
        }
        try require(number(surface.store, "orders.data.version") == 1, "failed refresh destroyed stale data")
        try require(seam.calls.count == 2, "HTTP failure was incorrectly retried")

        // Three publishes in one turn become one materialization/refetch.
        surface.set("user", ["id": 2.0])
        surface.set("unrelatedA", 1.0)
        surface.set("unrelatedB", 2.0)
        try settle("coalesced reactive refetch") { seam.calls.count == 3 }
        try require(seam.calls[2].url == "https://api.test/orders/2", "reactive URL did not rematerialize")

        // A newer materialized request cancels the prior one. Even if that old
        // transport later calls back, generation gating must keep the newest data.
        surface.set("user", ["id": 3.0])
        try settle("replacement reactive refetch") { seam.calls.count == 4 }
        try require(seam.calls[2].cancelled, "replacement did not invoke transport cancellation")
        seam.calls[3].completion([
            "ok": true, "status": 200.0,
            "data": ["version": 3.0],
        ])
        try settle("newest response") { number(surface.store, "orders.data.version") == 3 }
        seam.calls[2].completion([
            "ok": true, "status": 200.0,
            "data": ["version": 2.0],
        ])
        _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        try require(number(surface.store, "orders.data.version") == 3, "stale response overwrote newest data")

        // Awaited send resumes the same action with the HTTP envelope/body.
        surface.action("submit")
        try require(seam.calls.count == 5, "await save.send() did not start")
        try require(numberFromDictionary(seam.calls[4].request["body"], key: "value") == 7,
                    "send body override was not forwarded")
        seam.calls[4].completion([
            "ok": true, "status": 201.0,
            "data": ["saved": true],
        ])
        try settle("awaited send") {
            JSE.truthy(DsxPaths.get(surface.store, "sendDone"))
                && number(surface.store, "sendStatus") == 201
                && number(surface.store, "sendResumes") == 1
        }
        seam.calls[4].completion([
            "ok": true, "status": 299.0,
            "data": ["duplicate": true],
        ])
        _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        try require(number(surface.store, "sendResumes") == 1, "transport double-completion resumed an action twice")
        try require(number(surface.store, "sendStatus") == 201, "transport double-completion replaced the first result")

        // Cancellation settles an awaiting action even when this seam deliberately
        // does not invoke its transport completion on cancel.
        surface.set("sendDone", false)
        surface.action("submit")
        try require(seam.calls.count == 6, "second awaited send did not start")
        let cancelsBefore = seam.cancelCount
        surface.action("cancelSave")
        try settle("cancelled await continuation") {
            JSE.truthy(DsxPaths.get(surface.store, "sendDone"))
                && !JSE.truthy(DsxPaths.get(surface.store, "save.loading"))
                && number(surface.store, "sendResumes") == 2
        }
        try require(seam.cancelCount == cancelsBefore + 1, "cancel did not reach transport")
        seam.calls[5].completion([
            "ok": true, "status": 202.0,
            "data": ["late": true],
        ])
        _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        try require(number(surface.store, "sendStatus") != 202, "cancelled send resumed twice from a late response")
        try require(number(surface.store, "sendResumes") == 2, "cancelled send continuation did not settle exactly once")
    }

    private static func numberFromDictionary(_ value: Any?, key: String) -> Double? {
        JSE.number((value as? [String: Any])?[key])
    }

    private static func verifyRetry() throws {
        let state = JSEVars()
        let seam = Seam()
        let block = ApiBlock(
            spec: ["as": "flaky", "url": "https://api.test/flaky", "retry": "1"],
            store: state,
            fetchAsync: seam.fetch
        )
        try require(seam.calls.count == 1, "retry fixture did not auto-fire")
        seam.calls[0].completion([
            "ok": false, "status": 0.0, "data": NSNull(), "error": "network",
        ])
        try settle("network retry") { seam.calls.count == 2 }
        seam.calls[1].completion([
            "ok": true, "status": 200.0, "data": ["attempt": 2.0],
        ])
        try settle("retry success") { number(state, "flaky.data.attempt") == 2 }
        try require(seam.calls.count == 2, "retry count exceeded retry=1")
        block.dispose()
    }

    private static func verifyCacheIsolationAndEviction() throws {
        // Explicit credentials are part of the cache identity, with HTTP header
        // names normalized case-insensitively.
        let authCache = ApiBlock.Cache(capacity: 8)
        let authState = JSEVars()
        authState.vars["token"] = "Bearer A"
        var authCalls: [String] = []
        let authFetch: (String, [String: Any]) -> [String: Any] = { _, request in
            let headers = request["headers"] as? [String: Any]
            let authorization = JSE.string(headers?["authorization"])
            authCalls.append(authorization)
            return [
                "ok": true, "status": 200.0,
                "data": ["authorization": authorization],
            ]
        }
        let auth = ApiBlock(
            spec: [
                "as": "profile",
                "url": "https://api.test/profile",
                "headers": "{ Authorization: token }",
                "cache": "max-age(60)",
            ],
            store: authState,
            fetch: authFetch,
            now: { 1_000_000 },
            cache: authCache
        )
        authState.vars["token"] = "Bearer B"
        auth.storeChanged()
        authState.vars["token"] = "Bearer A"
        auth.storeChanged()
        try require(authCalls == ["Bearer A", "Bearer B"],
                    "Authorization changes shared or bypassed the correct cache partition")
        try require(JSE.string(DsxPaths.get(authState, "profile.data.authorization")) == "Bearer A",
                    "returning to an Authorization partition did not restore its own entry")

        let lowerCaseHeader = ApiBlock(
            spec: [
                "as": "profileLower",
                "url": "https://api.test/profile",
                "headers": "{ authorization: token }",
                "cache": "max-age(60)",
            ],
            store: authState,
            fetch: authFetch,
            now: { 1_000_000 },
            cache: authCache
        )
        try require(authCalls.count == 2,
                    "case-only HTTP header spelling created a different cache identity")
        let textProfile = ApiBlock(
            spec: [
                "as": "profileText",
                "url": "https://api.test/profile",
                "headers": "{ authorization: token }",
                "expect": "text",
                "cache": "max-age(60)",
            ],
            store: authState,
            fetch: authFetch,
            now: { 1_000_000 },
            cache: authCache
        )
        let blobProfile = ApiBlock(
            spec: [
                "as": "profileBlob",
                "url": "https://api.test/profile",
                "headers": "{ authorization: token }",
                "expect": "blob",
                "cache": "max-age(60)",
            ],
            store: authState,
            fetch: authFetch,
            now: { 1_000_000 },
            cache: authCache
        )
        try require(authCalls.count == 4,
                    "json/text/blob expectations reused differently decoded cache entries")
        blobProfile.dispose()
        textProfile.dispose()
        lowerCaseHeader.dispose()
        auth.dispose()

        // A no-store response must not seed an entry that a later cache-enabled
        // declaration can consume.
        let noStoreCache = ApiBlock.Cache(capacity: 8)
        let noStoreState = JSEVars()
        var noStoreCalls = 0
        let noStoreFetch: (String, [String: Any]) -> [String: Any] = { _, _ in
            noStoreCalls += 1
            return [
                "ok": true, "status": 200.0,
                "data": ["generation": Double(noStoreCalls)],
            ]
        }
        let uncached = ApiBlock(
            spec: ["as": "uncached", "url": "https://api.test/sensitive"],
            store: noStoreState,
            fetch: noStoreFetch,
            cache: noStoreCache
        )
        let cached = ApiBlock(
            spec: [
                "as": "cached",
                "url": "https://api.test/sensitive",
                "cache": "max-age(60)",
            ],
            store: noStoreState,
            fetch: noStoreFetch,
            cache: noStoreCache
        )
        try require(noStoreCalls == 2, "no-store response was retained and served to a cached block")
        try require(number(noStoreState, "cached.data.generation") == 2,
                    "cached block observed the earlier no-store payload")
        uncached.dispose()
        cached.dispose()

        // HEAD is a safe read on every shipping transport. It has its own cache
        // identity (method is part of the key) but must not flush the surface like
        // a mutation or diverge from the web/Android read-method law.
        let headCache = ApiBlock.Cache(capacity: 8)
        let headState = JSEVars()
        var headCalls = 0
        let headFetch: (String, [String: Any]) -> [String: Any] = { _, _ in
            headCalls += 1
            return ["ok": true, "status": 204.0, "data": NSNull()]
        }
        let firstHead = ApiBlock(
            spec: [
                "as": "firstHead",
                "url": "https://api.test/metadata",
                "method": "HEAD",
                "auto": "true",
                "cache": "max-age(60)",
            ],
            store: headState,
            fetch: headFetch,
            cache: headCache
        )
        firstHead.dispose()
        let secondHead = ApiBlock(
            spec: [
                "as": "secondHead",
                "url": "https://api.test/metadata",
                "method": "HEAD",
                "auto": "true",
                "cache": "max-age(60)",
            ],
            store: headState,
            fetch: headFetch,
            cache: headCache
        )
        try require(headCalls == 1,
                    "HEAD response was treated as a mutation instead of a cached read")
        secondHead.dispose()

        // A successful mutation invalidates existing GET data and its own response
        // is never retained, even when the mutation declaration names a cache policy.
        let mutationCache = ApiBlock.Cache(capacity: 8)
        let mutationState = JSEVars()
        var profileVersion = 1
        var mutationCalls = 0
        let profile = ApiBlock(
            spec: [
                "as": "cachedProfile",
                "url": "https://api.test/profile-after-mutation",
                "cache": "max-age(60)",
            ],
            store: mutationState,
            fetch: { _, _ in
                defer { profileVersion += 1 }
                return [
                    "ok": true, "status": 200.0,
                    "data": ["version": Double(profileVersion)],
                ]
            },
            cache: mutationCache
        )
        let mutationFetch: (String, [String: Any]) -> [String: Any] = { _, _ in
            mutationCalls += 1
            return ["ok": true, "status": 204.0, "data": NSNull()]
        }
        let mutation = ApiBlock(
            spec: [
                "as": "mutation",
                "url": "https://api.test/mutate",
                "method": "POST",
                "auto": "false",
                "cache": "max-age(60)",
            ],
            store: mutationState,
            fetch: mutationFetch,
            cache: mutationCache
        )
        _ = mutation.send()
        _ = mutation.send()
        try require(mutationCalls == 2, "successful mutation response incorrectly seeded cache")
        profile.dispose()
        let revisitedProfile = ApiBlock(
            spec: [
                "as": "revisitedProfile",
                "url": "https://api.test/profile-after-mutation",
                "cache": "max-age(60)",
            ],
            store: mutationState,
            fetch: { _, _ in
                defer { profileVersion += 1 }
                return [
                    "ok": true, "status": 200.0,
                    "data": ["version": Double(profileVersion)],
                ]
            },
            cache: mutationCache
        )
        try require(number(mutationState, "revisitedProfile.data.version") == 2,
                    "successful non-GET mutation did not invalidate surface GET cache")
        mutation.dispose()
        revisitedProfile.dispose()

        // Capacity two with an explicit cache hit proves true LRU (not FIFO):
        // 1,2,hit-1,3 evicts 2; revisiting 2 must hit the network.
        let lruCache = ApiBlock.Cache(capacity: 2)
        let lruState = JSEVars()
        lruState.vars["id"] = 1.0
        var lruCalls: [String] = []
        let lru = ApiBlock(
            spec: [
                "as": "item",
                "url": "https://api.test/items/{{ id }}",
                "cache": "max-age(60)",
            ],
            store: lruState,
            fetch: { url, _ in
                lruCalls.append(url)
                return ["ok": true, "status": 200.0, "data": ["url": url]]
            },
            now: { 1_000_000 },
            cache: lruCache
        )
        for id in [2.0, 1.0, 3.0, 2.0] {
            lruState.vars["id"] = id
            lru.storeChanged()
        }
        try require(
            lruCalls == [
                "https://api.test/items/1",
                "https://api.test/items/2",
                "https://api.test/items/3",
                "https://api.test/items/2",
            ],
            "bounded cache did not evict/touch entries using LRU order"
        )
        lru.dispose()

        // Native can read HttpOnly cookies through HTTPCookieStorage even though
        // authored JSE cannot. They are therefore part of the implicit partition.
        let cookieConfiguration = URLSessionConfiguration.ephemeral
        guard let cookieStorage = cookieConfiguration.httpCookieStorage,
              let httpOnlyCookie = HTTPCookie(properties: [
                .domain: "api.test",
                .path: "/",
                .name: "session",
                .value: "account-a",
                .secure: "TRUE",
                HTTPCookiePropertyKey("HttpOnly"): "TRUE",
              ]) else {
            throw Failure(description: "api/runtime: could not create isolated HttpOnly cookie fixture")
        }
        let cookiePartition = ApiBlock.cookieCachePartition(baseURL: nil, storage: cookieStorage)
        let cookieRequest: ApiBlock.FetchRequest = ["url": "https://api.test/identity"]
        let cookieBefore = cookiePartition(cookieRequest)
        cookieStorage.setCookie(httpOnlyCookie)
        let cookieAfter = cookiePartition(cookieRequest)
        cookieStorage.deleteCookie(httpOnlyCookie)
        try require(cookieBefore != cookieAfter,
                    "HttpOnly cookie change did not alter native cache partition")

        // The response key is frozen before transport start. A cookie/auth
        // partition change while A is in flight must not file A under B.
        let identityCache = ApiBlock.Cache(capacity: 8)
        let identityState = JSEVars()
        var identity = "cookie=A"
        let identitySeam = Seam()
        let inFlightIdentity = ApiBlock(
            spec: [
                "as": "identityA",
                "url": "https://api.test/identity",
                "cache": "max-age(60)",
            ],
            store: identityState,
            fetchAsync: identitySeam.fetch,
            cache: identityCache,
            cachePartition: { _ in identity }
        )
        try require(identitySeam.calls.count == 1, "identity capture request did not start")
        identity = "cookie=B"
        identitySeam.calls[0].completion([
            "ok": true, "status": 200.0, "data": ["identity": "A"],
        ])
        try settle("identity A response") {
            JSE.string(DsxPaths.get(identityState, "identityA.data.identity")) == "A"
        }
        inFlightIdentity.dispose()
        var identityBCalls = 0
        let identityB = ApiBlock(
            spec: [
                "as": "identityB",
                "url": "https://api.test/identity",
                "cache": "max-age(60)",
            ],
            store: identityState,
            fetch: { _, _ in
                identityBCalls += 1
                return ["ok": true, "status": 200.0, "data": ["identity": "B"]]
            },
            cache: identityCache,
            cachePartition: { _ in identity }
        )
        try require(identityBCalls == 1,
                    "old-session response landed in the new cookie partition")
        identityB.dispose()
        identity = "cookie=A"
        let identityARevisit = ApiBlock(
            spec: [
                "as": "identityARevisit",
                "url": "https://api.test/identity",
                "cache": "max-age(60)",
            ],
            store: identityState,
            fetch: { _, _ in
                throwawayFetchFailure()
            },
            cache: identityCache,
            cachePartition: { _ in identity }
        )
        try require(
            JSE.string(DsxPaths.get(identityState, "identityARevisit.data.identity")) == "A",
            "captured old-session cache partition was not reusable by that identity"
        )
        identityARevisit.dispose()

        // A fresh cache-only B result supersedes in-flight A. The transport is
        // cancelled, generation advances, and a hostile late A callback is ignored.
        let raceCache = ApiBlock.Cache(capacity: 8)
        let seedState = JSEVars()
        seedState.vars["id"] = "B"
        let seed = ApiBlock(
            spec: [
                "as": "seed",
                "url": "https://api.test/race/{{ id }}",
                "cache": "max-age(60)",
            ],
            store: seedState,
            fetch: { _, _ in
                ["ok": true, "status": 200.0, "data": ["winner": "B"]]
            },
            cache: raceCache
        )
        seed.dispose()
        let raceState = JSEVars()
        raceState.vars["id"] = "A"
        let raceSeam = Seam()
        let race = ApiBlock(
            spec: [
                "as": "race",
                "url": "https://api.test/race/{{ id }}",
                "cache": "max-age(60)",
            ],
            store: raceState,
            fetchAsync: raceSeam.fetch,
            cache: raceCache
        )
        try require(raceSeam.calls.count == 1, "race A request did not start")
        raceState.vars["id"] = "B"
        race.storeChanged()
        try require(raceSeam.calls[0].cancelled, "cache-only B did not cancel in-flight A")
        try require(JSE.string(DsxPaths.get(raceState, "race.data.winner")) == "B",
                    "cache-only B did not win immediately")
        try require(!JSE.truthy(DsxPaths.get(raceState, "race.loading"))
                    && !JSE.truthy(DsxPaths.get(raceState, "race.refreshing")),
                    "cache-only win did not clear both loading flags")
        raceSeam.calls[0].completion([
            "ok": true, "status": 200.0, "data": ["winner": "late-A"],
        ])
        _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        try require(JSE.string(DsxPaths.get(raceState, "race.data.winner")) == "B",
                    "late A overwrote the cache-only B winner")
        race.dispose()
    }

    private static func verifyLiveStreamingAndBlob() throws {
        try require(
            !ApiBlock.allowsRedirect(
                from: URL(string: "https://transport.fixture/start"),
                to: URL(string: "http://transport.fixture/downgraded")
            ),
            "URLSession transport allowed an HTTPS-to-HTTP redirect downgrade"
        )
        try require(
            ApiBlock.allowsRedirect(
                from: URL(string: "https://transport.fixture/start"),
                to: URL(string: "https://transport.fixture/final")
            ),
            "URLSession transport rejected a safe HTTPS-to-HTTPS redirect"
        )
        try require(
            ApiBlock.allowsRedirect(
                from: URL(string: "http://transport.fixture/start"),
                to: URL(string: "https://transport.fixture/final")
            ),
            "URLSession transport rejected an HTTP-to-HTTPS upgrade"
        )

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ApiTransportFixtureURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let transport = ApiBlock.urlSessionTransport(baseURL: nil, session: session)

        // Request encoding is bounded before URLSession starts. These local
        // construction failures are terminal (-2), so retry=3 must not invoke the
        // transport repeatedly and amplify memory/CPU pressure.
        let requestLimit = 4 * 1024 * 1024
        let oneKeyObjectOverhead = 9 // conservative estimator cost for {"p":"..."}
        do {
            let exactPlain = String(
                repeating: "x",
                count: requestLimit - oneKeyObjectOverhead
            )
            try require(
                ApiBlock.jsonBodyFitsLimits(["p": exactPlain]),
                "exact-boundary plain request was rejected"
            )
            try require(
                !ApiBlock.jsonBodyFitsLimits(["p": exactPlain + "x"]),
                "over-boundary plain request was accepted"
            )
        }
        do {
            // Each quote costs two encoded bytes. The trailing plain byte makes
            // the conservative estimate land exactly on the odd-sized boundary.
            let quoteCount = (requestLimit - oneKeyObjectOverhead - 1) / 2
            let exactEscaped = String(repeating: "\"", count: quoteCount) + "x"
            try require(
                ApiBlock.jsonBodyFitsLimits(["p": exactEscaped]),
                "exact-boundary escaped request was rejected"
            )
            try require(
                !ApiBlock.jsonBodyFitsLimits(["p": exactEscaped + "\""]),
                "over-boundary escaped request was accepted"
            )
        }

        var oversizedStarts = 0
        let countedTransport: ApiBlock.AsyncFetch = { url, request, completion in
            oversizedStarts += 1
            return transport(url, request, completion)
        }
        let oversizedState = JSEVars()
        let oversized = ApiBlock(
            spec: [
                "as": "oversized",
                "url": "https://transport.fixture/request-limit",
                "method": "POST",
                "auto": "false",
                "retry": "3",
            ],
            store: oversizedState,
            fetchAsync: countedTransport
        )
        _ = oversized.send([
            "payload": String(repeating: "x", count: (4 * 1024 * 1024) + 1),
        ])
        try settle("oversized request rejection", timeout: 5) {
            JSE.string(DsxPaths.get(oversizedState, "oversized.error.message"))
                == "request_too_large"
        }
        try require(number(oversizedState, "oversized.error.status") == -2,
                    "oversized request was not classified as a terminal local failure")
        try require(oversizedStarts == 1,
                    "oversized request consumed network retry budget")
        oversized.dispose()

        var nested: Any = "leaf"
        for _ in 0..<66 { nested = ["next": nested] }
        let deepState = JSEVars()
        let deep = ApiBlock(
            spec: [
                "as": "deep",
                "url": "https://transport.fixture/request-depth",
                "method": "POST",
                "auto": "false",
            ],
            store: deepState,
            fetchAsync: transport
        )
        _ = deep.send(["payload": nested])
        try settle("deep request rejection") {
            JSE.string(DsxPaths.get(deepState, "deep.error.message"))
                == "request_too_large"
        }
        deep.dispose()

        let streamState = JSEVars()
        var streamEvents: [String] = []
        let stream = ApiBlock(
            spec: [
                "as": "events",
                "url": "https://transport.fixture/sse",
            ],
            store: streamState,
            fetchAsync: transport,
            onEvent: { event, _ in streamEvents.append(event) }
        )
        try settle("persistent SSE first message") {
            streamEvents == ["message"]
                && JSE.string(DsxPaths.get(streamState, "events.data.0.word")) == "café"
        }
        try require(!JSE.truthy(DsxPaths.get(streamState, "events.loading")),
                    "first persistent SSE message did not clear loading before EOF")
        try require(!streamEvents.contains("success"),
                    "persistent SSE emitted success before the connection ended")

        ApiTransportFixtureURLProtocol.finishSSE()
        try settle("SSE terminal event") {
            streamEvents == ["message", "message", "success"]
                && JSE.string(DsxPaths.get(streamState, "events.data.1")) == "hello\nworld"
        }
        try require((DsxPaths.get(streamState, "events.data") as? [Any])?.count == 2,
                    "SSE terminal envelope duplicated incrementally delivered messages")
        stream.dispose()

        let blobState = JSEVars()
        let blob = ApiBlock(
            spec: [
                "as": "binary",
                "url": "https://transport.fixture/blob",
                "expect": "blob",
            ],
            store: blobState,
            fetchAsync: transport
        )
        try settle("blob response") {
            number(blobState, "binary.data.size") == 4
        }
        try require(JSE.string(DsxPaths.get(blobState, "binary.data.__blob")) == "AAEC/w==",
                    "blob response bytes were not preserved in the shared base64 envelope")
        try require(JSE.string(DsxPaths.get(blobState, "binary.data.type")) == "application/octet-stream",
                    "blob response MIME type was not preserved")
        blob.dispose()
    }

    private static func throwawayFetchFailure() -> [String: Any] {
        ["ok": false, "status": 0.0, "data": NSNull()]
    }
}

// MARK: - the error-system corpus (errors/errors.json — error-system.md, ACCEPTED v1)

enum ErrorsConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Constructor stashes: `Module.init` resolves `scheme` (and runs `setup()`) before any
    /// subclass state could exist, so a corpus-driven (dynamic) scheme/action table must be
    /// readable during that window. The lane is single-threaded; set immediately before
    /// construction (`corpusModule` / `register` below).
    private static var pendingScheme = ""
    private static var pendingTable: [String: [String: Any]] = [:]

    /// Fixture module — action kinds per the corpus README (resolve / error / errorTwice).
    final class CorpusModule: Module {
        override class var scheme: String { ErrorsConformance.pendingScheme }
        override func setup() {
            for (name, kind) in ErrorsConformance.pendingTable {
                if let twice = kind["errorTwice"] as? [Any], twice.count >= 2 {
                    let c1 = JSE.string(twice[0]); let c2 = JSE.string(twice[1])
                    dsx.action(name) { dsx in dsx.error(c1); dsx.error(c2) }
                } else if let err = kind["error"] as? [Any], !err.isEmpty {
                    let code = JSE.string(err[0])
                    let data: Any? = (err.count > 1 && !(err[1] is NSNull)) ? err[1] : nil
                    dsx.action(name) { dsx in dsx.error(code, data == nil ? nil : JSON.from(data)) }
                } else {
                    let value = kind["resolve"]
                    dsx.action(name) { dsx in dsx.resolve(value == nil ? nil : JSON.from(value)) }
                }
            }
        }
    }

    /// The one registered hook observer (the registry is process-global — hooks register
    /// once; each case swaps the delegate closures in and out).
    final class HarnessModule: Module {
        override class var scheme: String { "errfx.harness" }
        static var onModuleError: (([String: Any]) -> Void)?
        static var onCallFailed: (([String: Any]) -> Void)?
        override func setup() {
            dsx.action("noop") { $0.resolve() }
            dsx.delegate.listen("module.error") { input in
                if let p = input as? [String: Any] { HarnessModule.onModuleError?(p) }
                return nil
            }
            dsx.delegate.listen("module.callFailed") { input in
                if let p = input as? [String: Any] { HarnessModule.onCallFailed?(p) }
                return nil
            }
        }
    }
    private static var harnessRegistered = false

    /// A bare (unregistered) module instance whose dsx IS the ambient handle for `scheme` —
    /// ambient emission needs no registry entry, only a primary scheme.
    private static func emitterDsx(_ scheme: String) -> Context {
        pendingScheme = scheme
        pendingTable = [:]
        return CorpusModule().dsx
    }

    /// Drain the main queue: every fan-out (ambient + call funnel) lands via
    /// DispatchQueue.main.async, and the lane's verify runs ON main (RecordMain) — pump the
    /// run loop so those blocks execute before steps proceed / assertions read.
    private static func drainMain(_ seconds: TimeInterval = 0.05) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    /// SUBSET match: every key listed in `expected` must match in `actual`; unlisted keys
    /// are ignored; JSON null expects absent/null/NSNull; primitives compare JSE-loosely.
    private static func subset(_ actual: Any?, _ expected: Any?) -> Bool {
        if expected == nil || expected is NSNull { return actual == nil || actual is NSNull }
        if let dict = expected as? [String: Any] {
            guard let a = actual as? [String: Any] else { return false }
            return dict.allSatisfy { subset(a[$0.key], $0.value) }
        }
        if let arr = expected as? [Any] {
            guard let a = actual as? [Any], a.count == arr.count else { return false }
            return arr.indices.allSatisfy { subset(a[$0], arr[$0]) }
        }
        return JSE.equals(actual, expected)
    }

    private static func assertSubset(_ actual: Any?, _ expected: Any?, _ label: String) throws {
        guard subset(actual, expected) else {
            throw Failure(description: "\(label): expected subset \(String(describing: expected)) — got \(String(describing: actual))")
        }
    }

    /// Run OpenSource/Conformance/errors/errors.json through the REAL Swift bus + ledger and
    /// assert every expectation. Returns the number of cases verified; throws on the first
    /// mismatch. Twin of errors-conformance.test.ts / ErrorsConformanceTest.kt.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }
        if !harnessRegistered { harnessRegistered = true; ModuleRegistry.shared.register(HarnessModule.self) }

        for c in cases {
            let name = (c["name"] as? String) ?? "?"

            // TYPED ABSENCE (durability.md P4): seed the case's build-excluded overlay —
            // the DespiaExcluded shape, chain → { reason [, from, aliases] } — and reset
            // to empty when the case declares none, so overlay state never leaks.
            ModuleRegistry.shared.setExcludedIdentities((c["excludedOverlay"] as? [String: [String: Any]]) ?? [:])

            for reg in (c["register"] as? [[String: Any]]) ?? [] {
                pendingScheme = JSE.string(reg["scheme"])
                pendingTable = (reg["actions"] as? [String: [String: Any]]) ?? [:]
                ModuleRegistry.shared.register(CorpusModule.self)
            }

            let expect = (c["expect"] as? [String: Any]) ?? [:]
            let countBefore = DSXErrorLedger.shared.count()
            var stateBefore: [String: Double] = [:]
            for path in ((expect["stateDelta"] as? [String: Any]) ?? [:]).keys {
                stateBefore[path] = JSE.number(DSX.state.getPath(path)) ?? 0
            }
            let hooksExpected = (expect["hooks"] as? [String: [[String: Any]]]) ?? [:]
            var hookSeen: [String: [[String: Any]]] = [:]
            var nestedProbe: (onCode: String, scheme: String, code: String)?
            HarnessModule.onModuleError = { payload in
                if hooksExpected["module.error"] != nil {
                    hookSeen["module.error", default: []].append(payload)
                }
                if let probe = nestedProbe, (payload["code"] as? String) == probe.onCode {
                    nestedProbe = nil   // once
                    emitterDsx(probe.scheme).error(probe.code)
                }
            }
            HarnessModule.onCallFailed = { payload in
                if hooksExpected["module.callFailed"] != nil {
                    hookSeen["module.callFailed", default: []].append(payload)
                }
            }
            let eventsExpected = (expect["events"] as? [[String: Any]]) ?? []
            let eventSchemes = Set(eventsExpected.map { JSE.string($0["scheme"]) })
            var eventSeen: [[String: Any]] = []
            let mount = DSXMessenger().mount("errfx-observer") { egress in
                let p = egress.payload
                if (p["event"] as? String) == "error", let s = p["scheme"] as? String, eventSchemes.contains(s) {
                    eventSeen.append(["scheme": s, "event": "error", "data": p["data"] as Any])
                }
            }
            defer {
                HarnessModule.onModuleError = nil
                HarnessModule.onCallFailed = nil
                mount.unmount()
            }

            var callErrors: [String] = []
            var jseStore: StackStore?

            for step in (c["steps"] as? [[String: Any]]) ?? [] {
                if let e = step["emit"] as? [String: Any] {
                    if let nested = e["nestedEmitFromHook"] as? [String: Any] {
                        nestedProbe = (JSE.string(e["code"]), JSE.string(nested["scheme"]), JSE.string(nested["code"]))
                    }
                    emitterDsx(JSE.string(e["scheme"])).fail(
                        JSE.string(e["code"]),
                        message: e["message"] as? String,
                        recoverable: (e["recoverable"] as? Bool) == true,
                        data: (e["data"] == nil || e["data"] is NSNull) ? nil : JSON.from(e["data"]))
                } else if let r = step["emitRepeat"] as? [String: Any] {
                    let dsx = emitterDsx(JSE.string(r["scheme"]))
                    let count = Int(JSE.number(r["count"]) ?? 0)
                    let prefix = JSE.string(r["codePrefix"])
                    for i in 0..<count { dsx.error("\(prefix)\(i)") }
                } else if let j = step["jse"] as? [String: Any] {
                    let store = StackStore()
                    jseStore = store
                    store.actions["corpuscase"] = StackFormula(inputs: [:], body: JSE.string(j["body"]))
                    let runner = JSERunner(store: store, webView: nil, scope: j["scheme"] as? String, dsx: nil)
                    runner.run("corpuscase", item: nil)
                } else if let k = step["call"] as? [String: Any] {
                    let scheme = JSE.string(k["scheme"]); let action = JSE.string(k["action"])
                    let callArgs = k["args"] as? [String: Any]
                    let caller = Module().dsx
                    if (k["mode"] as? String) == "post" {
                        try? caller.module[scheme][action](callArgs)
                    } else {
                        // The lane runs on main; the awaited chain resumes off-main, so pump
                        // the run loop (the dispatch itself runs inline on main) until the
                        // detached task settles — no semaphore, no deadlock.
                        final class Probe { var done = false; var code: String? }
                        let probe = Probe()
                        Task.detached {
                            do { _ = try await caller.module[scheme][action](callArgs) } catch let error as ModuleCallError {
                                switch error {
                                case .actionFailed(let code, _): probe.code = code
                                case .notLoaded:                 probe.code = "not_loaded"
                                case .invalidURI:                probe.code = "invalid_uri"
                                }
                            } catch {}
                            probe.done = true
                        }
                        while !probe.done { drainMain(0.01) }
                        if let code = probe.code { callErrors.append(code) }
                    }
                }
                drainMain()
            }
            drainMain()

            // ── assertions ──
            if let exp = expect["ledger"] as? [[String: Any]] {
                let appended = DSXErrorLedger.shared.count() - countBefore
                guard appended == exp.count else {
                    throw Failure(description: "errors/\(name): appended \(appended) ledger entries (expected \(exp.count))")
                }
                let tail = DSXErrorLedger.shared.recent().suffix(appended)
                for (i, e) in exp.enumerated() {
                    try assertSubset(Array(tail)[i].wire(), e, "errors/\(name): ledger[\(i)]")
                }
            }
            if let expCount = expect["ledgerCount"] as? Int {
                let retained = DSXErrorLedger.shared.recent().count
                guard retained == expCount else {
                    throw Failure(description: "errors/\(name): retained \(retained) (expected \(expCount))")
                }
            }
            if let expTail = expect["ledgerTail"] as? [[String: Any]] {
                let tail = Array(DSXErrorLedger.shared.recent().suffix(expTail.count))
                for (i, e) in expTail.enumerated() {
                    try assertSubset(tail[i].wire(), e, "errors/\(name): ledgerTail[\(i)]")
                }
            }
            for (hook, exp) in hooksExpected {
                let seen = hookSeen[hook] ?? []
                guard seen.count == exp.count else {
                    throw Failure(description: "errors/\(name): \(hook) fired \(seen.count)× (expected \(exp.count))")
                }
                for (i, e) in exp.enumerated() { try assertSubset(seen[i], e, "errors/\(name): \(hook)[\(i)]") }
            }
            if !eventsExpected.isEmpty {
                guard eventSeen.count == eventsExpected.count else {
                    throw Failure(description: "errors/\(name): \(eventSeen.count) page deliveries (expected \(eventsExpected.count))")
                }
                for (i, e) in eventsExpected.enumerated() {
                    guard JSE.string(eventSeen[i]["scheme"]) == JSE.string(e["scheme"]) else {
                        throw Failure(description: "errors/\(name): events[\(i)].scheme \(JSE.string(eventSeen[i]["scheme"]))")
                    }
                    try assertSubset(eventSeen[i]["data"], e["data"], "errors/\(name): events[\(i)].data")
                }
            }
            for (path, exp) in (expect["state"] as? [String: Any]) ?? [:] {
                try assertSubset(DSX.state.getPath(path), exp, "errors/\(name): state \(path)")
            }
            for (path, delta) in (expect["stateDelta"] as? [String: Any]) ?? [:] {
                let now = JSE.number(DSX.state.getPath(path)) ?? 0
                let want = JSE.number(delta) ?? 0
                guard now - (stateBefore[path] ?? 0) == want else {
                    throw Failure(description: "errors/\(name): stateDelta \(path) = \(now - (stateBefore[path] ?? 0)) (expected \(want))")
                }
            }
            if let exp = expect["callErrors"] as? [Any] {
                let want = exp.map { JSE.string($0) }
                guard callErrors == want else {
                    throw Failure(description: "errors/\(name): callErrors \(callErrors) (expected \(want))")
                }
            }
            for (path, exp) in (expect["jseStore"] as? [String: Any]) ?? [:] {
                guard let store = jseStore else { throw Failure(description: "errors/\(name): no jse step ran") }
                let actual = JSE.eval(path, store: store, item: nil)
                try assertSubset(conformanceUnwrapNull(actual), exp, "errors/\(name): jseStore \(path)")
            }
            for (scheme, avail) in (expect["schemeAvailable"] as? [String: Any]) ?? [:] {
                let want = (avail as? Bool) == true
                guard ModuleRegistry.shared.isAvailable(scheme) == want else {
                    throw Failure(description: "errors/\(name): schemeAvailable \(scheme) != \(want)")
                }
            }
        }
        return cases.count
    }
}

// MARK: - the log corpus (logs/logs.json — dsx.log, the unified console primitive)

enum LogsConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Constructor stash — the ErrorsConformance discipline (Module.init resolves `scheme`
    /// before any subclass state could exist; the lane is single-threaded).
    private static var pendingScheme = ""

    /// A bare module whose dsx IS the module handle for a corpus-driven scheme — the
    /// module-handle `dsx.log` form needs no registered actions, only a primary scheme.
    final class LogFixtureModule: Module {
        override class var scheme: String { LogsConformance.pendingScheme }
    }

    private static func handleDsx(_ scheme: String) -> Context {
        pendingScheme = scheme
        return LogFixtureModule().dsx
    }

    /// `dsx.log` is variadic — Swift cannot splat an array, so the host drives the small
    /// arities the corpus uses through the real public seam.
    private static func driveLog(_ dsx: Context, _ args: [Any?]) {
        switch args.count {
        case 0: dsx.log()
        case 1: dsx.log(args[0])
        case 2: dsx.log(args[0], args[1])
        default: dsx.log(args[0], args[1], args[2])
        }
    }

    private static func drainMain(_ seconds: TimeInterval = 0.05) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private static func subset(_ actual: Any?, _ expected: Any?) -> Bool {
        if expected == nil || expected is NSNull { return actual == nil || actual is NSNull }
        if let dict = expected as? [String: Any] {
            guard let a = actual as? [String: Any] else { return false }
            return dict.allSatisfy { subset(a[$0.key], $0.value) }
        }
        if let arr = expected as? [Any] {
            guard let a = actual as? [Any], a.count == arr.count else { return false }
            return arr.indices.allSatisfy { subset(a[$0], arr[$0]) }
        }
        return JSE.equals(actual, expected)
    }

    private static func assertSubset(_ actual: Any?, _ expected: Any?, _ label: String) throws {
        guard subset(actual, expected) else {
            throw Failure(description: "\(label): expected subset \(String(describing: expected)) — got \(String(describing: actual))")
        }
    }

    /// Run OpenSource/Conformance/logs/logs.json through the REAL Swift runner + log ring
    /// and assert every expectation. Returns the number of cases verified; throws on the
    /// first mismatch. Twin of logs-conformance.test.ts / LogsConformanceTest.kt.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }

        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            let expect = (c["expect"] as? [String: Any]) ?? [:]
            let countBefore = DSXLogBuffer.shared.count()
            var callErrors: [String] = []
            var jseStore: StackStore?

            for step in (c["steps"] as? [[String: Any]]) ?? [] {
                if let j = step["jse"] as? [String: Any] {
                    let store = StackStore()
                    jseStore = store
                    store.actions["corpuscase"] = StackFormula(inputs: [:], body: JSE.string(j["body"]))
                    let runner = JSERunner(store: store, webView: nil, scope: j["scheme"] as? String, dsx: nil)
                    runner.run("corpuscase", item: nil)
                } else if let l = step["log"] as? [String: Any] {
                    driveLog(handleDsx(JSE.string(l["scheme"])), (l["args"] as? [Any?]) ?? [])
                } else if let r = step["logRepeat"] as? [String: Any] {
                    let dsx = handleDsx(JSE.string(r["scheme"]))
                    let count = Int(JSE.number(r["count"]) ?? 0)
                    let prefix = JSE.string(r["prefix"])
                    for i in 0..<count { dsx.log("\(prefix)\(i)") }
                } else if let k = step["call"] as? [String: Any] {
                    let scheme = JSE.string(k["scheme"]); let action = JSE.string(k["action"])
                    let callArgs = k["args"] as? [String: Any]
                    let caller = Module().dsx
                    final class Probe { var done = false; var code: String? }
                    let probe = Probe()
                    Task.detached {
                        do { _ = try await caller.module[scheme][action](callArgs) } catch let error as ModuleCallError {
                            switch error {
                            case .actionFailed(let code, _): probe.code = code
                            case .notLoaded:                 probe.code = "not_loaded"
                            case .invalidURI:                probe.code = "invalid_uri"
                            }
                        } catch {}
                        probe.done = true
                    }
                    while !probe.done { drainMain(0.01) }
                    if let code = probe.code { callErrors.append(code) }
                }
                drainMain()
            }
            drainMain()

            if let exp = expect["logs"] as? [[String: Any]] {
                let appended = DSXLogBuffer.shared.count() - countBefore
                guard appended == exp.count else {
                    throw Failure(description: "logs/\(name): appended \(appended) log entries (expected \(exp.count))")
                }
                let tail = Array(DSXLogBuffer.shared.recent().suffix(appended))
                for (i, e) in exp.enumerated() {
                    try assertSubset(tail[i].wire(), e, "logs/\(name): logs[\(i)]")
                }
            }
            if let expCount = expect["logCount"] as? Int {
                let retained = DSXLogBuffer.shared.recent().count
                guard retained == expCount else {
                    throw Failure(description: "logs/\(name): retained \(retained) (expected \(expCount))")
                }
            }
            if let expTail = expect["logsTail"] as? [[String: Any]] {
                let tail = Array(DSXLogBuffer.shared.recent().suffix(expTail.count))
                for (i, e) in expTail.enumerated() {
                    try assertSubset(tail[i].wire(), e, "logs/\(name): logsTail[\(i)]")
                }
            }
            if let exp = expect["callErrors"] as? [Any] {
                let want = exp.map { JSE.string($0) }
                guard callErrors == want else {
                    throw Failure(description: "logs/\(name): callErrors \(callErrors) (expected \(want))")
                }
            }
            for (path, exp) in (expect["jseStore"] as? [String: Any]) ?? [:] {
                guard let store = jseStore else { throw Failure(description: "logs/\(name): no jse step ran") }
                let actual = JSE.eval(path, store: store, item: nil)
                try assertSubset(conformanceUnwrapNull(actual), exp, "logs/\(name): jseStore \(path)")
            }
        }
        return cases.count
    }

    // MARK: - the SATELLITE executor (JSEActions.swift — the watch/node statement runner)

    /// A no-op `JSEActionEffects`: a node's transports are irrelevant to the log corpus, and
    /// the runner's OWN notices (unknown action, depth cap, loop budget) are captured rather
    /// than printed so a stray notice cannot masquerade as a corpus log entry.
    private final class SatelliteEffects: JSEActionEffects {
        var notices: [String] = []
        func event(_ name: String, _ payload: [String: Any]) {}
        func call(_ scheme: String, _ action: String, _ args: [String: Any]) async -> [String: Any] {
            ["ok": false, "error": "unsupported_on_surface"]
        }
        func fetch(_ url: String, _ opts: [String: Any]) async -> [String: Any] {
            ["ok": false, "error": "offline"]
        }
        func setTimer(key: String, ms: Double, repeats: Bool, body: String) {}
        func clearTimer(key: String) {}
        func navigate(_ path: String) {}
        func log(_ line: String) { notices.append(line) }
    }

    /// Carrier across the @MainActor Task boundary — the recorder's `main()` is a plain
    /// synchronous entry, so each satellite body is driven by a Task the main runloop drains
    /// (the same discipline the `call` steps above use).
    private final class SatelliteProbe {
        var done = false
        var store: JSEVars?
    }

    /// Run the logs corpus through the FOURTH executor — `JSEActionRunner`, the satellite
    /// statement runner a watch (and next a keyboard) node executes markup with. Before this
    /// existed, `dsx.log` / `dsx.error` fell through that runner's dispatcher and vanished
    /// silently: the diagnostics law held on three runtimes and not on the wrist, and no
    /// harness could have noticed because this executor had ZERO conformance coverage.
    ///
    /// Scope of the arm — deliberately the MARKUP cases only. A satellite has no module
    /// registry, so the `log` / `logRepeat` steps (the module-handle form) and the `call`
    /// steps (the reserved `dsx` scheme answering on the bus) have no meaning on a node;
    /// they are SKIPPED, not faked. Every case whose steps are all `jse` runs whole,
    /// including the scheme-attribution case (through the runner's `scope` seam), the
    /// house-formatter cases (canonical JSON + credential masking), the never-unwinds case
    /// (its store expectation included) and the `console.*` builtin case. The count returned
    /// is the number of cases actually executed, so a corpus that grows markup cases without
    /// this arm growing with it is visible in the lane's stdout.
    static func verifySatellite(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }

        var ran = 0
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            let steps = (c["steps"] as? [[String: Any]]) ?? []
            // markup-only cases: the node has no bus and no module handle.
            guard !steps.isEmpty, steps.allSatisfy({ $0["jse"] != nil }) else { continue }
            ran += 1

            let expect = (c["expect"] as? [String: Any]) ?? [:]
            let countBefore = DSXLogBuffer.shared.count()
            var lastStore: JSEVars?

            for step in steps {
                guard let j = step["jse"] as? [String: Any] else { continue }
                let body = JSE.string(j["body"])
                let scheme = j["scheme"] as? String
                let probe = SatelliteProbe()
                Task { @MainActor in
                    let effects = SatelliteEffects()
                    let store = JSEVars()
                    let runner = JSEActionRunner(state: store, effects: effects)
                    runner.scope = scheme
                    await runner.run(body)
                    probe.store = store
                    probe.done = true
                    _ = effects            // hold the seam alive across the awaits (runner.effects is weak)
                }
                while !probe.done { drainMain(0.01) }
                lastStore = probe.store
            }
            drainMain()

            if let exp = expect["logs"] as? [[String: Any]] {
                let appended = DSXLogBuffer.shared.count() - countBefore
                guard appended == exp.count else {
                    throw Failure(description: "logs(satellite)/\(name): appended \(appended) log entries (expected \(exp.count))")
                }
                let tail = Array(DSXLogBuffer.shared.recent().suffix(appended))
                for (i, e) in exp.enumerated() {
                    try assertSubset(tail[i].wire(), e, "logs(satellite)/\(name): logs[\(i)]")
                }
            }
            for (path, exp) in (expect["jseStore"] as? [String: Any]) ?? [:] {
                guard let store = lastStore else {
                    throw Failure(description: "logs(satellite)/\(name): no jse step ran")
                }
                let actual = JSE.eval(path, store: store, item: nil)
                try assertSubset(conformanceUnwrapNull(actual), exp, "logs(satellite)/\(name): jseStore \(path)")
            }
        }
        guard ran > 0 else {
            throw Failure(description: "logs(satellite): no markup case executed — the arm is wired to nothing")
        }
        return ran
    }
}

// MARK: - native screen-readiness reporter (lifecycle/readiness.json)

enum ScreenReadinessConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run the NATIVE reporter state machine — `DSXScreenReadiness`, the exact type the frame host
    /// drives — against the shared corpus the TS `screen.ts` and Kotlin `ScreenReadinessTest`
    /// assert. The emission seam is swapped for a capture sink, so this executes the real machine
    /// (mount/manual/rendered/settled/release, the once-per-frame guarantee) with no bus attached.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard (doc["version"] as? NSNumber)?.intValue == 1 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported version")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }

        // The bounded settle deadline is corpus-pinned and must be the SAME number on all three
        // renderers — the whole point of a fail-open is that it degrades identically.
        guard let wantDeadline = (doc["settleDeadlineMs"] as? NSNumber)?.intValue,
              wantDeadline == DSXScreenReadiness.settleDeadlineMs else {
            throw Failure(description: "readiness: settleDeadlineMs \(DSXScreenReadiness.settleDeadlineMs) drifted from the corpus \(String(describing: doc["settleDeadlineMs"]))")
        }

        let restore = DSXScreenReadiness.emit
        let restoreClock = DSXScreenReadiness.scheduleDeadline
        defer {
            DSXScreenReadiness.emit = restore
            DSXScreenReadiness.scheduleDeadline = restoreClock
        }

        for c in cases {
            let name = c["name"] as? String ?? "?"
            var fired: [(event: String, payload: [String: Any])] = []
            // The machine arms the deadline itself at `mount`; the corpus drives the `deadline`
            // step directly, so the real main-queue clock is stubbed out and `armed` proves one
            // timer per frame INSTANCE at the pinned delay.
            var armed: [Double] = []
            DSXScreenReadiness.resetForTesting()
            DSXScreenReadiness.scheduleDeadline = { seconds, _ in
                armed.append(seconds)
                return {}
            }
            DSXScreenReadiness.emit = { event, payload in fired.append((event, payload)) }

            for step in (c["steps"] as? [[String: Any]]) ?? [] {
                let frame = (step["frame"] as? NSNumber)?.intValue ?? -1
                switch step["do"] as? String {
                case "mount":
                    DSXScreenReadiness.mount(frame: frame,
                                             path: step["path"] as? String,
                                             surface: step["surface"] as? String ?? "native")
                case "manual":     DSXScreenReadiness.manual(frame)
                case "hostsWeb":   DSXScreenReadiness.hostsWeb(frame)
                case "rendered":   DSXScreenReadiness.rendered(frame)
                case "settled":    DSXScreenReadiness.settled(frame)
                case "deadline":   DSXScreenReadiness.deadline(frame)
                case "release":    DSXScreenReadiness.release(frame)
                case "webStart":   DSXScreenReadiness.webStart()
                case "webSettled": DSXScreenReadiness.webSettled()
                default:
                    throw Failure(description: "readiness/\(name): unknown step \(String(describing: step["do"]))")
                }
            }

            let starts = fired.filter { $0.event == "surface.viewStart" }.count
            guard armed == Array(repeating: DSXScreenReadiness.settleDeadlineSeconds, count: starts) else {
                throw Failure(description: "readiness/\(name): armed deadlines \(armed) (expected \(starts) x \(DSXScreenReadiness.settleDeadlineSeconds))")
            }

            let expected = (c["expect"] as? [[String: Any]]) ?? []
            guard fired.count == expected.count else {
                throw Failure(description: "readiness/\(name): fired \(fired.map(\.event)) (expected \(expected.compactMap { $0["event"] as? String }))")
            }
            for (i, want) in expected.enumerated() {
                let got = fired[i]
                guard got.event == want["event"] as? String else {
                    throw Failure(description: "readiness/\(name): event[\(i)] \(got.event) (expected \(String(describing: want["event"])))")
                }
                let gotFrame = (got.payload["frame"] as? Int)
                let wantFrame = (want["frame"] as? NSNumber)?.intValue
                guard gotFrame == wantFrame else {
                    throw Failure(description: "readiness/\(name): event[\(i)] frame \(String(describing: gotFrame)) (expected \(String(describing: wantFrame)))")
                }
                let gotPath = got.payload["path"] as? String
                let wantPath = want["path"] as? String
                guard gotPath == wantPath else {
                    throw Failure(description: "readiness/\(name): event[\(i)] path \(String(describing: gotPath)) (expected \(String(describing: wantPath)))")
                }
                guard got.payload["surface"] as? String == "native" else {
                    throw Failure(description: "readiness/\(name): event[\(i)] surface is not \"native\"")
                }
            }
            let pending = DSXScreenReadiness.pendingFrames
            let wantPending = ((c["expectPending"] as? [Any]) ?? []).compactMap { ($0 as? NSNumber)?.intValue }.sorted()
            guard pending == wantPending else {
                throw Failure(description: "readiness/\(name): pending \(pending) (expected \(wantPending))")
            }
        }
        DSXScreenReadiness.resetForTesting()
        return cases.count
    }
}

// MARK: - surface → unified screen.* translation (lifecycle/phase.json)

enum ScreenPhaseConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// The COORDINATOR table: each surface's private report → the ONE `screen.*` vocabulary.
    ///
    /// The shipping coordinator is the `Lifecycle` MODULE (`Mandatory/Lifecycle/swift/Lifecycle.swift`),
    /// which is not in this lane's compile set — the recorder builds `OpenSource/Engine/iOS` plus the
    /// registry shims and nothing else. So this host runs a REFERENCE of the same three-line table
    /// (guard → publish → re-fire) against the REAL kernel state store, which is what pins the
    /// merge invariant (a phase publish must not wipe the window metrics, and vice versa). The
    /// module itself is gated by the Kotlin twin, which drives a live `Lifecycle` on the bus; keep
    /// the two helpers below byte-identical to Lifecycle.swift's `isAppSurface` / `routeString`.
    private enum Reference {
        static func isAppSurface(_ input: Any?) -> Bool {
            let tag = (input as? [String: Any])?["surface"] as? String ?? "web"
            return tag == "web" || tag == "native"
        }
        static func routeString(_ input: Any?) -> String? {
            if let d = input as? [String: Any] {
                return (d["url"] as? String) ?? (d["path"] as? String)
            }
            return input as? String
        }
        /// The IDENTITY of the report — a native report's `frame`, nil for a frameless one
        /// (the web relay names no frame). Byte-identical to Lifecycle.swift's `reportFrame`.
        static func reportFrame(_ input: Any?) -> Int? {
            (input as? [String: Any])?["frame"] as? Int
        }
        /// nil = the report is DROPPED (a bare embedded surface); else the (phase, ready, fire).
        static func translate(_ event: String, _ input: Any?) -> (phase: String, ready: Bool, fire: String)? {
            guard isAppSurface(input) else { return nil }
            switch event {
            case "surface.domStart", "surface.viewStart":                return ("loading", false, "screen.loading")
            case "surface.domFinish", "surface.domFail", "surface.viewFinish":   return ("ready", true, "screen.ready")
            default:                                     return nil
            }
        }
    }

    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard (doc["version"] as? NSNumber)?.intValue == 1 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported version")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }

        for c in cases {
            let name = c["name"] as? String ?? "?"
            DSX.state.set("screen", [:] as [String: Any])
            for (key, value) in (c["seedState"] as? [String: Any]) ?? [:] {
                DSX.state.set(key, value)
            }
            var fired: [(name: String, input: String?)] = []
            for step in (c["steps"] as? [[String: Any]]) ?? [] {
                guard let event = step["fire"] as? String else {
                    throw Failure(description: "phase/\(name): a step with no fire")
                }
                let input = conformanceUnwrapNull(step["input"])
                guard let t = Reference.translate(event, input) else { continue }
                // IDENTITY BEFORE LEVEL — `screen.frame` first, `screen.ready` last (the
                // ordering Lifecycle.swift/.kt publish in; the Kotlin sink runs inline and a
                // `ready` ahead of its frame would pair a true level with the PREVIOUS
                // report's identity — root-plan.md §5).
                DSX.state.setPath("screen.frame", Reference.reportFrame(input) ?? NSNull())
                DSX.state.setPath("screen.phase", t.phase)
                DSX.state.setPath("screen.ready", t.ready)
                fired.append((t.fire, Reference.routeString(input)))
            }

            let expected = (c["expect"] as? [[String: Any]]) ?? []
            guard fired.count == expected.count else {
                throw Failure(description: "phase/\(name): fired \(fired.map(\.name)) (expected \(expected.compactMap { $0["fire"] as? String }))")
            }
            for (i, want) in expected.enumerated() {
                guard fired[i].name == want["fire"] as? String else {
                    throw Failure(description: "phase/\(name): fire[\(i)] \(fired[i].name) (expected \(String(describing: want["fire"])))")
                }
                let wantInput = conformanceUnwrapNull(want["input"]) as? String
                guard fired[i].input == wantInput else {
                    throw Failure(description: "phase/\(name): fire[\(i)] input \(String(describing: fired[i].input)) (expected \(String(describing: wantInput)))")
                }
            }
            for (path, exp) in (c["expectState"] as? [String: Any]) ?? [:] {
                let actual = conformanceUnwrapNull(DSX.state.getPath(path))
                let want = conformanceUnwrapNull(exp)
                if want == nil {
                    guard actual == nil else {
                        throw Failure(description: "phase/\(name): \(path) is \(String(describing: actual)) (expected absent)")
                    }
                    continue
                }
                guard let actual, JSE.string(actual) == JSE.string(want as Any) else {
                    throw Failure(description: "phase/\(name): \(path) \(String(describing: actual)) (expected \(String(describing: want)))")
                }
            }
        }
        DSX.state.set("screen", [:] as [String: Any])
        return cases.count
    }
}

// MARK: - web-optional boot rule (router/boot.json)

enum RootPlanConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// The ROOT PLAN corpus (`router/root-plan.json`) through the REAL fold — the reference
    /// twin of the TS runner (packages/dom/test/router-conformance.test.ts) and the Kotlin
    /// RootPlanConformanceTest. The corpus `_note` is the contract; this harness implements
    /// its deterministic virtual-clock simulation: attempt 0 mounts at t=0, attempt N+1 at
    /// the instant N fails, deadline = mountAt + timeoutMs, a live attempt whose deadline ≤
    /// the next event's atMs times out FIRST, and after the last event a still-live attempt
    /// times out at its deadline. Normalization runs through the real
    /// `AppManifest.normalizeSurfaces`, the fold is the real `RootPlan.Fold`.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }
        for c in cases { try runCase(c) }
        return cases.count
    }

    private final class Timer {
        let at: Int; let fire: () -> Void; var cancelled = false
        init(at: Int, fire: @escaping () -> Void) { self.at = at; self.fire = fire }
    }

    private static func runCase(_ c: [String: Any]) throws {
        let name = c["name"] as? String ?? "?"
        func fail(_ what: String) -> Failure { Failure(description: "root-plan/\(name): \(what)") }
        guard let components = (c["components"] as? [Any])?.compactMap({ $0 as? String }),
              let rawSurfaces = c["surfaces"] as? [Any],
              let expect = c["expect"] as? [String: Any] else { throw fail("malformed case") }

        var now = 0
        var timers: [Timer] = []
        var fired: [String] = []
        var payloads: [[String: Any]] = []
        var mountedAttrs: [String: [String: Any]] = [:]
        var sawDiagnostic = false

        let plan = AppManifest.normalizeSurfaces(rawSurfaces)

        // ── the normalized plan pins (expect.normalized) ──
        guard let expNorm = expect["normalized"] as? [[String: Any]], expNorm.count == plan.count else {
            throw fail("normalized count \(plan.count)")
        }
        for (i, e) in expNorm.enumerated() {
            guard plan[i].view == (e["view"] as? String),
                  plan[i].id == (e["id"] as? String),
                  plan[i].timeoutMs == (e["timeoutMs"] as? NSNumber)?.intValue else {
                throw fail("normalized[\(i)] \(plan[i].view)/\(plan[i].id)/\(plan[i].timeoutMs)")
            }
            let expConfig = (e["config"] as? [String: Any]) ?? [:]
            guard NSDictionary(dictionary: plan[i].config).isEqual(to: expConfig) else {
                throw fail("normalized[\(i)].config")
            }
        }

        let host = RootPlan.Host(
            mount: { candidate, _ in mountedAttrs[candidate.id] = candidate.config },
            now: { now },
            setTimer: { ms, fire in
                let t = Timer(at: now + ms, fire: fire)
                timers.append(t)
                return { t.cancelled = true }
            },
            fire: { event, payload in
                fired.append(event)
                var p = payload; p["event"] = event
                payloads.append(p)
            },
            registered: { components.contains($0) },
            diagnostic: { _ in sawDiagnostic = true }
        )
        let fold = RootPlan.Fold(plan: plan, host: host, target: "web")
        fold.start()

        func nextTimer() -> Timer? { timers.filter { !$0.cancelled }.min { $0.at < $1.at } }
        func runTimersThrough(_ limit: Int) {
            while let t = nextTimer(), t.at <= limit {
                now = t.at
                t.cancelled = true
                t.fire()
            }
        }

        let events = ((c["events"] as? [[String: Any]]) ?? []).sorted {
            ((($0["atMs"] as? NSNumber)?.intValue) ?? 0) < ((($1["atMs"] as? NSNumber)?.intValue) ?? 0)
        }
        for e in events {
            let at = (e["atMs"] as? NSNumber)?.intValue ?? 0
            runTimersThrough(at)   // a deadline ≤ the event's atMs fires FIRST
            now = max(now, at)
            let attempt = (e["attempt"] as? NSNumber)?.intValue
            switch e["kind"] as? String {
            case "settle": fold.settle(attemptIndex: attempt)
            case "error": fold.rootError(code: (e["code"] as? String) ?? "error",
                                         origin: (e["origin"] as? String) ?? "root",
                                         attemptIndex: attempt)
            default: throw fail("unknown event kind")
            }
        }
        runTimersThrough(Int.max)   // the fold always terminates

        let attempts = payloads.filter { ($0["event"] as? String) == "root.failed" || ($0["event"] as? String) == "root.ready" }
            .compactMap { $0["id"] as? String }
        let failures = payloads.filter { ($0["event"] as? String) == "root.failed" }
            .map { ["id": ($0["id"] as? String) ?? "", "code": (($0["error"] as? [String: Any])?["code"] as? String) ?? ""] }
        let ready = payloads.first { ($0["event"] as? String) == "root.ready" }?["id"] as? String

        let expAttempts = (expect["attempts"] as? [Any])?.compactMap { $0 as? String } ?? []
        guard attempts == expAttempts else { throw fail("attempts \(attempts)") }
        let expFailures = ((expect["failures"] as? [[String: Any]]) ?? []).map {
            ["id": ($0["id"] as? String) ?? "", "code": ($0["code"] as? String) ?? ""]
        }
        guard failures == expFailures else { throw fail("failures \(failures)") }
        let expReady = conformanceUnwrapNull(expect["ready"]) as? String
        guard ready == expReady else { throw fail("ready \(ready ?? "nil")") }
        let expFired = (expect["fired"] as? [Any])?.compactMap { $0 as? String } ?? []
        guard fired == expFired else { throw fail("fired \(fired)") }
        guard sawDiagnostic == ((expect["diagnostic"] as? Bool) ?? false) else { throw fail("diagnostic \(sawDiagnostic)") }
        if let winnerView = expect["winnerView"] as? String {
            guard fold.winner?.view == winnerView else { throw fail("winnerView \(fold.winner?.view ?? "nil")") }
        }
        if let expMounted = expect["mountedAttrs"] as? [String: [String: Any]] {
            for (id, attrs) in expMounted {
                guard let got = mountedAttrs[id], NSDictionary(dictionary: got).isEqual(to: attrs) else {
                    throw fail("mountedAttrs[\(id)]")
                }
            }
        }
        guard fold.ledger.map({ $0.id }) == expFailures.map({ $0["id"] ?? "" }) else {
            throw fail("ledger mirrors failures")
        }
    }
}

// MARK: - the module-identity CHAIN corpus (chains/chains.json — facet-contracts.md, derived identity)

enum ChainsConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/chains/chains.json through the REAL Swift `ChainResolver` — the
    /// reference implementation of the longest-known-prefix FOLD the TS (`resolveChain`) and
    /// Kotlin (`ChainResolver.resolve`) runners execute over the SAME file. Each case splits its
    /// dotted callee on "." and drives `resolve(_:table:)`, asserting the resolved chain / spelling
    /// / known / excluded and — for a reserved-word remainder — the member-plane route (member +
    /// rest, never an action). Returns the number of cases verified; throws on the first mismatch
    /// (or a malformed corpus — a silently-skipped suite is how drift starts). Twin of
    /// chains-conformance.test.ts / ChainsConformanceTest.kt; this is the leg that closes
    /// chains/README.md's "Swift — NOT IMPLEMENTED" gap, so the corpus now runs on all three.
    ///
    /// The corpus `proxySafety` block is SKIPPED by contract: it pins the JS planes' proxy denylist
    /// (a property get of then/toString/… returns undefined), and Swift has no dynamic get plane —
    /// reserved members are REAL members, and real members shadow dynamic lookup (SE-0195), so the
    /// native proxies are immune by construction (the corpus `_note` says exactly this, and the
    /// Kotlin twin skips it for the same reason).
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let t = doc["table"] as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no table{}")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }

        // The reserved-member set is CLOSED and FROZEN — the corpus and the resolver must never
        // drift (growth is a major-version event on both sides at once). Twin of the Kotlin
        // `reserved-set-frozen` case and the TS reserved-set assertion.
        let reserved = Set(((doc["reserved"] as? [Any]) ?? []).map { JSE.string($0) })
        guard reserved == ChainResolver.reservedMembers else {
            throw Failure(description: "chains: reserved members \(ChainResolver.reservedMembers.sorted()) drifted from corpus \(reserved.sorted())")
        }

        // The corpus's synthetic identity table, exactly as the fixture states it.
        let chains = Set(((t["chains"] as? [Any]) ?? []).map { JSE.string($0) })
        var aliases: [String: String] = [:]
        for (spelling, target) in (t["aliases"] as? [String: Any]) ?? [:] { aliases[spelling] = JSE.string(target) }
        let excluded = Set(((t["excluded"] as? [Any]) ?? []).map { JSE.string($0) })
        let table = ChainResolver.Table(chains: chains, aliases: aliases, excluded: excluded)

        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            let input = JSE.string(c["input"])
            guard let expect = c["expect"] as? [String: Any] else {
                throw Failure(description: "chains/\(name): no expect{}")
            }
            // The corpus's pre-split reference face: "/" and "." are both wire path separators, but
            // a case `input` is the dotted callee after `dsx.module.`, so it splits on "." only —
            // `components(separatedBy:)` keeps empty tokens, the Kotlin/TS `split(".")` semantics.
            let res = ChainResolver.resolve(input.components(separatedBy: "."), table: table)

            guard res.chain == JSE.string(expect["chain"]) else {
                throw Failure(description: "chains/\(name): chain \(res.chain) (expected \(JSE.string(expect["chain"])))")
            }
            // expect.spelling is stated only when it differs from the chain (alias heads).
            let wantSpelling = JSE.string(expect["spelling"] ?? expect["chain"])
            guard res.spelling == wantSpelling else {
                throw Failure(description: "chains/\(name): spelling \(res.spelling) (expected \(wantSpelling))")
            }
            let wantKnown = (expect["known"] as? Bool) ?? true
            guard res.known == wantKnown else {
                throw Failure(description: "chains/\(name): known \(res.known) (expected \(wantKnown))")
            }
            let wantExcluded = (expect["excluded"] as? Bool) ?? false
            guard res.excluded == wantExcluded else {
                throw Failure(description: "chains/\(name): excluded \(res.excluded) (expected \(wantExcluded))")
            }
            if let member = expect["member"] as? String {
                // MEMBER route: a leading reserved word routes to the member plane — member + rest
                // instead of an action, never an action (res.action stays empty).
                guard res.member == member else {
                    throw Failure(description: "chains/\(name): member \(String(describing: res.member)) (expected \(member))")
                }
                let wantRest = JSE.string(expect["rest"] ?? "")
                guard res.rest == wantRest else {
                    throw Failure(description: "chains/\(name): rest \(res.rest) (expected \(wantRest))")
                }
                guard res.action.isEmpty else {
                    throw Failure(description: "chains/\(name): a member route exposes no action (got \(res.action))")
                }
            } else {
                // CALL route: slash-joined action ("" = the bare pre-filter call).
                guard res.member == nil else {
                    throw Failure(description: "chains/\(name): a call route has no member (got \(String(describing: res.member)))")
                }
                guard res.action == JSE.string(expect["action"] ?? "") else {
                    throw Failure(description: "chains/\(name): action \(res.action) (expected \(JSE.string(expect["action"] ?? "")))")
                }
                guard res.rest.isEmpty else {
                    throw Failure(description: "chains/\(name): a call route has no member rest (got \(res.rest))")
                }
            }
        }
        return cases.count
    }
}

// MARK: - the style-override READ corpus (overrides/style-overrides.json `read`)

enum StyleOverridesReadConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run the corpus's `read` section through the REAL evaluator: declared knobs in a
    /// JSEState store, raw values on the item scope's `__overrides` dict (the tag door)
    /// and the store's `dsx.override` var (the mount/update door), every expectation
    /// evaluated by JSE itself — so composite expressions (`dsx.override.pad + 2`) are
    /// asserted against this runtime, not a re-implementation. The pure `split`/`resolve`
    /// halves run per-PR on the Linux lane (StyleOverridesConformance.swift); this host
    /// is the engine-coupled half beside it.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cases = doc["read"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "style-overrides.json: empty read[]")
        }
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            let store = JSEVars()
            for declMap in (c["declarations"] as? [[String: Any]] ?? []) {
                guard let as_ = declMap["as"] as? String else { continue }
                store.overrideDecls[as_] = OverrideDecl(name: as_,
                                                        type: declMap["type"] as? String,
                                                        default: declMap["default"] as? String,
                                                        options: declMap["options"] as? String,
                                                        min: declMap["min"],
                                                        max: declMap["max"])
            }
            var item: [String: Any] = (c["attributes"] as? [String: Any]) ?? [:]
            if let overrides = c["overrides"] as? [String: Any] { item["__overrides"] = overrides }
            if let storeOverrides = c["storeOverrides"] as? [String: Any] { store.vars["dsx.override"] = storeOverrides }
            for e in (c["expect"] as? [[String: Any]] ?? []) {
                guard let expr = e["expr"] as? String else { continue }
                let got = JSE.eval(expr, store: store, item: item)
                let expect: Any? = e.keys.contains("value") ? e["value"] : nil
                guard readValueMatches(got, expect) else {
                    throw Failure(description: "read/\(name): \(expr) got \(String(describing: got)) expected \(String(describing: expect))")
                }
            }
        }
        return cases.count
    }

    /// TRUE booleans only — on Linux corelibs a JSON 0/1 NSNumber answers `as? Bool`,
    /// so the type identity is the discriminator (the same rule the core applies).
    private static func readIsBoolean(_ v: Any) -> Bool {
        if type(of: v) == Bool.self { return true }
        let t = String(describing: type(of: v))
        return t == "__NSCFBoolean" || t == "NSCFBoolean" || t == "Boolean"
    }

    private static func readNumeric(_ v: Any?) -> Double? {
        guard let v = v, !readIsBoolean(v) else { return nil }
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let i = v as? Int64 { return Double(i) }
        if let f = v as? Float { return Double(f) }
        if let n = v as? NSNumber { return n.doubleValue }
        return nil
    }

    private static func readValueMatches(_ got: Any?, _ expect: Any?) -> Bool {
        let g: Any? = (got is NSNull) ? nil : got
        let e: Any? = (expect is NSNull) ? nil : expect
        if g == nil && e == nil { return true }
        guard let g = g, let e = e else { return false }
        if readIsBoolean(g) || readIsBoolean(e) {
            return readIsBoolean(g) && readIsBoolean(e) && (g as? Bool) == (e as? Bool)
        }
        if let gs = g as? String, let es = e as? String { return gs == es }
        if let gn = readNumeric(g), let en = readNumeric(e) { return gn == en }
        return false
    }
}

// MARK: - the tier verdict corpus (tier/verdicts.json)

enum TierConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/tier/verdicts.json through the REAL Swift `TierClassifier`
    /// (Tier.swift) — the W9 tier-equivalence lane's Swift leg. The TS reference
    /// (tier-conformance.test.ts over `classifyBody`) and the Kotlin twin
    /// (TierConformanceTest.kt over `TierClassifier.classify`) run the SAME file: every
    /// action-tier body classifies once as `jse` (the portable subset) or `js` (the
    /// escalation tier), and the three classifiers must never drift — since the
    /// strict-rejection hardening the TS verdict is also the compiler's subset gate, so a
    /// disagreement means a body compiles on one renderer and escalates (or is rejected)
    /// on another. Each case asserts the verdict; a `js` case additionally asserts its
    /// `reasonContains` SUBSTRING (wording legitimately differs per runner — this twin says
    /// "'get' accessors are outside …" where TS says "'get' is outside …"; the corpus pins
    /// only the stable fragment), and a `jse` verdict must carry NO reason. Returns the
    /// number of cases verified; throws on the first mismatch (or a malformed corpus — a
    /// silently-skipped suite is how drift starts).
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], cases.count >= 20 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[] (or suspiciously few)")
        }
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            guard let body = c["body"] as? String else {
                throw Failure(description: "tier/\(name): no body")
            }
            let want = JSE.string(c["tier"])
            let v = TierClassifier.classify(body)
            let got = v.tier == .js ? "js" : "jse"
            guard got == want else {
                throw Failure(description: "tier/\(name): classified \(got) (expected \(want)) — reason \(v.reason ?? "nil")")
            }
            if want == "js" {
                // corpus discipline: every js case names its stable reason fragment — a
                // missing substring is a malformed case, never a skippable one.
                guard let substring = c["reasonContains"] as? String, !substring.isEmpty else {
                    throw Failure(description: "tier/\(name): a js case must state reasonContains")
                }
                guard let reason = v.reason, reason.contains(substring) else {
                    throw Failure(description: "tier/\(name): reason \(v.reason ?? "nil") does not contain \(substring)")
                }
            } else if let reason = v.reason {
                throw Failure(description: "tier/\(name): a jse verdict carries no reason (got \(reason))")
            }
        }
        return cases.count
    }
}

// MARK: - the DSX Scene numeric corpus (scene/ — all THIRTEEN files)

enum SceneConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/scene/ — all THIRTEEN files — through the REAL Swift
    /// scene kernel (SceneMath + SceneIR + SceneGltf + SceneFrame + the P5 twins
    /// SceneAnim/SceneBind/SceneCollide/SceneOrbit + the G2 twin ScenePhysics), the
    /// dsx-scene.md P2 + P4 + P5 + dsx-game.md G2 + G1 record-lane leg. The TS reference (scene-conformance.test.ts over the
    /// platform-neutral scene kernel) and the Kotlin twin (:core) run the SAME files,
    /// so the three implementations cannot drift on a single matrix element:
    /// transforms.json asserts world matrices + transformed points (hand-built IR,
    /// exactly the TS runner's `toSceneNodes`), projection.json asserts NDC through
    /// `sceneCamera` + `projectToNdc`, parse.json drives the markup through StackXML —
    /// this renderer's OWN parser (the corpus law: never a second one) — into
    /// `parseScene` + `resolvedProps`, model.json drives base64 GLB fixtures through
    /// `SceneGltf.parseGlb` (embedded buffers only — the error VALUES included),
    /// text3d.json asserts the billboard-quad layout law (`SceneIRKit.text3dQuad`),
    /// frame.json folds raw ticks through the `SceneFrameClock` budget law, and the P5
    /// five: animation.json (tween samples, the when-gate fold, the transition retarget
    /// fold — SceneAnim), bind.json (row keying · keyed diff · row scope · nesting ·
    /// the 256 cap — SceneBind), collide.json (depth laws · world AABB · the enter
    /// tracker — SceneCollide), orbit.json (the spherical/drag/zoom folds — SceneOrbit)
    /// and lighting.json (attenuation · lit color · the point cap · fog — SceneIRKit);
    /// plus the G2 file: physics.json (extraction worlds through StackXML → the frozen
    /// body records, full fixed-tick simulations with the exact event sequences and the
    /// bit-identical determinism replay, the 5-step accumulator fold, interpolation —
    /// ScenePhysics; the pinned `constants` block asserts against the kernel statics,
    /// the TS runner's pattern); plus the G1 file: prefab.json (components as prefabs
    /// inside <scene> subtrees — the case component tables parse through StackXML into
    /// `scenePrefabDefFromTemplate`, expansion runs through `parseScene` with the
    /// lookup seam, holes resolve through `scenePrefabResolver`, and the keyed-spawn
    /// leg rides SceneBind — the expansion-root/scope/gate/depth laws pinned).
    /// Floats compare at the corpus tolerance (6 decimals, 1.5e-6). Returns the number
    /// of cases verified; throws on the first mismatch (or a malformed corpus — a
    /// silently-skipped suite is how drift starts).
    static func verify(corpusDir: URL) throws -> Int {
        let transforms = try verifyTransforms(corpusFile: corpusDir.appendingPathComponent("transforms.json"))
        let projection = try verifyProjection(corpusFile: corpusDir.appendingPathComponent("projection.json"))
        let parse = try verifyParse(corpusFile: corpusDir.appendingPathComponent("parse.json"))
        let model = try verifyModel(corpusFile: corpusDir.appendingPathComponent("model.json"))
        let text3d = try verifyText3d(corpusFile: corpusDir.appendingPathComponent("text3d.json"))
        let frame = try verifyFrame(corpusFile: corpusDir.appendingPathComponent("frame.json"))
        let animation = try verifyAnimation(corpusFile: corpusDir.appendingPathComponent("animation.json"))
        let bind = try verifyBind(corpusFile: corpusDir.appendingPathComponent("bind.json"))
        let collide = try verifyCollide(corpusFile: corpusDir.appendingPathComponent("collide.json"))
        let orbit = try verifyOrbit(corpusFile: corpusDir.appendingPathComponent("orbit.json"))
        let lighting = try verifyLighting(corpusFile: corpusDir.appendingPathComponent("lighting.json"))
        let physics = try verifyPhysics(corpusFile: corpusDir.appendingPathComponent("physics.json"))
        let prefab = try verifyPrefab(corpusFile: corpusDir.appendingPathComponent("prefab.json"))
        let sprite = try verifySprite(corpusFile: corpusDir.appendingPathComponent("sprite.json"))
        return transforms + projection + parse + model + text3d + frame
            + animation + bind + collide + orbit + lighting + physics + prefab + sprite
    }

    private static let tolerance = 1.5e-6

    /// the identity resolver (P5 corpus specs carry no holes)
    private static let noHoles: SceneResolve = { _, _, raw in raw }

    /// the map-backed resolver: each case's `vars` plays the live store's role
    private static func mapResolver(_ vars: [String: Any]) -> SceneResolve {
        { _, _, raw in SceneIRKit.interpolateSceneHoles(raw) { vars[$0] } }
    }

    private static func loadCases(_ url: URL) throws -> [[String: Any]] {
        let data = try Data(contentsOf: url)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(url.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(url.lastPathComponent): no cases[]")
        }
        return cases
    }

    private static func numberList(_ raw: Any?) -> [Double]? {
        guard let list = raw as? [Any] else { return nil }
        var out: [Double] = []
        for v in list {
            guard let n = JSE.number(v) else { return nil }
            out.append(n)
        }
        return out
    }

    private static func close(_ actual: [Double], _ expected: [Double], _ label: String, _ name: String) throws {
        guard actual.count == expected.count else {
            throw Failure(description: "scene/\(name): \(label) has \(actual.count) numbers (expected \(expected.count))")
        }
        for i in 0..<expected.count where abs(actual[i] - expected[i]) > tolerance {
            throw Failure(description: "scene/\(name): \(label)[\(i)] = \(actual[i]) (expected \(expected[i]))")
        }
    }

    // ── transforms.json — corpus trees are JSON scene nodes, not markup ──────────────

    private static func sceneNode(_ tree: [String: Any], _ name: String) throws -> SceneNode {
        guard let kind = tree["kind"] as? String else {
            throw Failure(description: "scene/\(name): tree node without a kind")
        }
        var attrs: [String: String] = [:]
        if let id = tree["id"] as? String { attrs["id"] = id }
        for key in ["position", "rotation", "scale"] {
            if let value = tree[key] as? String { attrs[key] = value }
        }
        let children = try ((tree["children"] as? [[String: Any]]) ?? []).map { try sceneNode($0, name) }
        return SceneNode(kind: kind, id: tree["id"] as? String, attrs: attrs, children: children)
    }

    private static func verifyTransforms(corpusFile: URL) throws -> Int {
        let cases = try loadCases(corpusFile)
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            guard let tree = c["tree"] as? [String: Any] else {
                throw Failure(description: "scene/\(name): no tree{}")
            }
            let root = try sceneNode(tree, name)
            var diagnostics: [SceneDiagnostic] = []
            let resolve = mapResolver((c["vars"] as? [String: Any]) ?? [:])
            let worlds = SceneIRKit.worldMatrices([root], resolve) { diagnostics.append($0) }
            let targetId = JSE.string(c["node"])
            guard let entry = worlds.first(where: { $0.node.id == targetId }) else {
                throw Failure(description: "scene/\(name): target node '\(targetId)' has no world matrix")
            }
            guard let expectedWorld = numberList(c["world"]) else {
                throw Failure(description: "scene/\(name): no world[]")
            }
            try close(entry.world, expectedWorld, "world", name)
            if let point = c["point"] as? [String: Any],
               let local = numberList(point["local"]), let expectedPoint = numberList(point["world"]) {
                let w = entry.world
                let p = [
                    w[0] * local[0] + w[4] * local[1] + w[8] * local[2] + w[12],
                    w[1] * local[0] + w[5] * local[1] + w[9] * local[2] + w[13],
                    w[2] * local[0] + w[6] * local[1] + w[10] * local[2] + w[14],
                ]
                try close(p, expectedPoint, "point", name)
            }
            let expectedDiags = (c["diagnostics"] as? NSNumber)?.intValue ?? 0
            guard diagnostics.count == expectedDiags else {
                throw Failure(description: "scene/\(name): \(diagnostics.count) diagnostic(s) (expected \(expectedDiags)): \(diagnostics.map(\.message))")
            }
        }
        return cases.count
    }

    // ── projection.json ──────────────────────────────────────────────────────────────

    private static func verifyProjection(corpusFile: URL) throws -> Int {
        let cases = try loadCases(corpusFile)
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            guard let cam = c["camera"] as? [String: Any] else {
                throw Failure(description: "scene/\(name): no camera{}")
            }
            var attrs: [String: String] = [
                "position": JSE.string(cam["position"]),
                "look-at": JSE.string(cam["look-at"]),
                "near": JSE.string(cam["near"]),
                "far": JSE.string(cam["far"]),
            ]
            if cam["fov"] != nil { attrs["fov"] = JSE.string(cam["fov"]) }
            if cam["size"] != nil { attrs["size"] = JSE.string(cam["size"]) }
            let rootAttrs: [String: String] = (cam["mode"] as? String) == "2d" ? ["mode": "2d"] : [:]
            let markup = StackNode(tag: "scene", attrs: rootAttrs,
                                   children: [StackNode(tag: "camera", attrs: attrs, children: [])])
            var diagnostics: [SceneDiagnostic] = []
            let ir = SceneIRKit.parseScene(markup) { diagnostics.append($0) }
            let aspect = JSE.number(cam["aspect"]) ?? 1
            let camera = SceneIRKit.sceneCamera(ir, mapResolver([:]), aspect: aspect) { diagnostics.append($0) }
            for point in (c["points"] as? [[String: Any]]) ?? [] {
                guard let world = numberList(point["world"]), let ndc = numberList(point["ndc"]) else {
                    throw Failure(description: "scene/\(name): malformed point")
                }
                let got = SceneMath.projectToNdc(proj: camera.proj, view: camera.view, world: world)
                try close(got, ndc, "ndc(\(world.map { JSE.string($0) }.joined(separator: ",")))", name)
            }
            guard diagnostics.isEmpty else {
                throw Failure(description: "scene/\(name): no diagnostics expected, got \(diagnostics.map(\.message))")
            }
        }
        return cases.count
    }

    // ── parse.json — markup through StackXML, the renderer's OWN parser ──────────────

    private static func verifyParse(corpusFile: URL) throws -> Int {
        let cases = try loadCases(corpusFile)
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            guard let markupSource = c["markup"] as? String, let markup = StackXML.parse(markupSource) else {
                throw Failure(description: "scene/\(name): markup did not parse")
            }
            var diagnostics: [SceneDiagnostic] = []
            let diag: (SceneDiagnostic) -> Void = { diagnostics.append($0) }
            let ir = SceneIRKit.parseScene(markup, diag: diag)
            let resolve = mapResolver((c["vars"] as? [String: Any]) ?? [:])
            guard let expect = c["expect"] as? [String: Any] else {
                throw Failure(description: "scene/\(name): no expect{}")
            }
            if let mode = expect["mode"] as? String, ir.mode != mode {
                throw Failure(description: "scene/\(name): mode \(ir.mode) (expected \(mode))")
            }
            if let background = expect["background"] as? String {
                let raw = ir.attrs["background"] ?? "#000000"
                let got = resolve(nil, "background", raw)
                guard got == background else {
                    throw Failure(description: "scene/\(name): background \(got) (expected \(background))")
                }
            }
            if let nodes = expect["nodes"] as? [[String: Any]] {
                try checkNodes(ir.nodes, nodes, "nodes", name, resolve, diag)
            }
            let expectedDiags = (c["diagnostics"] as? NSNumber)?.intValue ?? 0
            guard diagnostics.count == expectedDiags else {
                throw Failure(description: "scene/\(name): \(diagnostics.count) diagnostic(s) (expected \(expectedDiags)): \(diagnostics.map(\.message))")
            }
        }
        return cases.count
    }

    private static func checkNodes(_ nodes: [SceneNode], _ expected: [[String: Any]], _ path: String,
                                   _ name: String, _ resolve: @escaping SceneResolve,
                                   _ diag: @escaping (SceneDiagnostic) -> Void) throws {
        guard nodes.count == expected.count else {
            throw Failure(description: "scene/\(name): \(path) has \(nodes.count) node(s) (expected \(expected.count))")
        }
        for (i, want) in expected.enumerated() {
            let node = nodes[i]
            let at = "\(path)[\(i)]"
            guard node.kind == JSE.string(want["kind"]) else {
                throw Failure(description: "scene/\(name): \(at).kind \(node.kind) (expected \(JSE.string(want["kind"])))")
            }
            if let id = want["id"] as? String, node.id != id {
                throw Failure(description: "scene/\(name): \(at).id \(node.id ?? "nil") (expected \(id))")
            }
            if let raw = want["raw"] as? [String: Any] {
                for (attr, value) in raw where node.attrs[attr] != JSE.string(value) {
                    throw Failure(description: "scene/\(name): \(at).raw.\(attr) \(node.attrs[attr] ?? "nil") not kept verbatim")
                }
            }
            let props = SceneIRKit.resolvedProps(node, resolve, diag)
            let vectors: [(String, [Double])] = [
                ("position", props.position), ("rotation", props.rotation),
                ("scale", props.scale), ("lookAt", props.lookAt),
            ]
            for (key, actual) in vectors {
                if let expectedVector = numberList(want[key]) {
                    try close(actual, expectedVector, "\(at).\(key)", name)
                }
            }
            if let sizeRaw = want["size"] {
                let size = numberList(sizeRaw) ?? [JSE.number(sizeRaw) ?? .nan]
                switch node.kind {
                case "camera": try close([props.size2d], size, "\(at).size", name)
                case "plane": try close(props.planeSize, size, "\(at).size", name)
                default: try close(props.boxSize, size, "\(at).size", name)
                }
            }
            let scalars: [(String, Double)] = [
                ("fov", props.fov), ("near", props.near), ("far", props.far),
                ("radius", props.radius), ("intensity", props.intensity),
            ]
            for (key, actual) in scalars {
                if want[key] != nil, let expectedScalar = JSE.number(want[key]) {
                    guard abs(actual - expectedScalar) <= tolerance else {
                        throw Failure(description: "scene/\(name): \(at).\(key) \(actual) (expected \(expectedScalar))")
                    }
                }
            }
            let strings: [(String, String)] = [
                ("lightKind", props.lightKind), ("anchorKind", props.anchorKind),
                ("color", props.color), ("src", props.src), ("value", props.value),
            ]
            for (key, actual) in strings {
                if let expectedString = want[key] as? String, actual != expectedString {
                    throw Failure(description: "scene/\(name): \(at).\(key) \(actual) (expected \(expectedString))")
                }
            }
            if let children = want["children"] as? [[String: Any]] {
                try checkNodes(node.children, children, "\(at).children", name, resolve, diag)
            }
        }
    }

    // ── model.json — GLB fixtures through the P4 parser (embedded buffers only) ──────

    private static func verifyModel(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let fixtures = doc["fixtures"] as? [String: Any], !fixtures.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no fixtures{}")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            guard let b64 = fixtures[JSE.string(c["fixture"])] as? String,
                  let bytes = Data(base64Encoded: b64) else {
                throw Failure(description: "scene/\(name): fixture '\(JSE.string(c["fixture"]))' missing or not base64")
            }
            let result = SceneGltf.parseGlb(bytes)
            if let error = c["error"] as? String {
                guard result.error?.rawValue == error else {
                    throw Failure(description: "scene/\(name): error \(result.error?.rawValue ?? "none") (expected \(error))")
                }
                continue
            }
            guard let model = result.model else {
                throw Failure(description: "scene/\(name): did not parse (\(result.error?.rawValue ?? "?"))")
            }
            let want = (c["expect"] as? [String: Any]) ?? [:]
            if let meshCount = (want["meshCount"] as? NSNumber)?.intValue, model.meshes.count != meshCount {
                throw Failure(description: "scene/\(name): meshCount \(model.meshes.count) (expected \(meshCount))")
            }
            if let drawCount = (want["drawCount"] as? NSNumber)?.intValue, model.draws.count != drawCount {
                throw Failure(description: "scene/\(name): drawCount \(model.draws.count) (expected \(drawCount))")
            }
            for meshWant in (want["meshes"] as? [[String: Any]]) ?? [] {
                let index = (meshWant["index"] as? NSNumber)?.intValue ?? -1
                guard index >= 0, index < model.meshes.count,
                      let primitive = model.meshes[index].primitives.first else {
                    throw Failure(description: "scene/\(name): mesh[\(index)] primitive 0 missing")
                }
                if let vertexCount = (meshWant["vertexCount"] as? NSNumber)?.intValue,
                   primitive.positions.count / 3 != vertexCount {
                    throw Failure(description: "scene/\(name): mesh[\(index)].vertexCount \(primitive.positions.count / 3) (expected \(vertexCount))")
                }
                if let indexCount = (meshWant["indexCount"] as? NSNumber)?.intValue,
                   primitive.indices.count != indexCount {
                    throw Failure(description: "scene/\(name): mesh[\(index)].indexCount \(primitive.indices.count) (expected \(indexCount))")
                }
                if let positions = numberList(meshWant["positions"]) {
                    try close(primitive.positions, positions, "mesh[\(index)].positions", name)
                }
                if let normals = numberList(meshWant["normals"]) {
                    try close(primitive.normals, normals, "mesh[\(index)].normals", name)
                }
                if let indices = numberList(meshWant["indices"]),
                   primitive.indices.map({ Double($0) }) != indices {
                    throw Failure(description: "scene/\(name): mesh[\(index)].indices \(primitive.indices) (expected \(indices))")
                }
                if let baseColor = numberList(meshWant["baseColor"]) {
                    try close(primitive.baseColor, baseColor, "mesh[\(index)].baseColor", name)
                }
            }
            for drawWant in (want["draws"] as? [[String: Any]]) ?? [] {
                let index = (drawWant["index"] as? NSNumber)?.intValue ?? -1
                guard index >= 0, index < model.draws.count else {
                    throw Failure(description: "scene/\(name): draw[\(index)] missing")
                }
                let draw = model.draws[index]
                guard draw.mesh == (drawWant["mesh"] as? NSNumber)?.intValue else {
                    throw Failure(description: "scene/\(name): draw[\(index)].mesh \(draw.mesh) (expected \(JSE.string(drawWant["mesh"])))")
                }
                guard let world = numberList(drawWant["world"]) else {
                    throw Failure(description: "scene/\(name): draw[\(index)] has no world[]")
                }
                try close(draw.world, world, "draw[\(index)].world", name)
            }
            for t in (want["transformed"] as? [[String: Any]]) ?? [] {
                let drawIndex = (t["draw"] as? NSNumber)?.intValue ?? -1
                let vertex = (t["vertex"] as? NSNumber)?.intValue ?? -1
                guard drawIndex >= 0, drawIndex < model.draws.count else {
                    throw Failure(description: "scene/\(name): transformed draw[\(drawIndex)] missing")
                }
                let draw = model.draws[drawIndex]
                guard draw.mesh < model.meshes.count,
                      let primitive = model.meshes[draw.mesh].primitives.first,
                      vertex >= 0, vertex * 3 + 2 < primitive.positions.count else {
                    throw Failure(description: "scene/\(name): transformed vertex \(vertex) out of range")
                }
                let m = draw.world
                let lx = primitive.positions[vertex * 3]
                let ly = primitive.positions[vertex * 3 + 1]
                let lz = primitive.positions[vertex * 3 + 2]
                let world = [
                    m[0] * lx + m[4] * ly + m[8] * lz + m[12],
                    m[1] * lx + m[5] * ly + m[9] * lz + m[13],
                    m[2] * lx + m[6] * ly + m[10] * lz + m[14],
                ]
                guard let expected = numberList(t["world"]) else {
                    throw Failure(description: "scene/\(name): transformed has no world[]")
                }
                try close(world, expected, "transformed[draw \(drawIndex) vertex \(vertex)]", name)
            }
        }
        return cases.count
    }

    // ── text3d.json — the billboard-quad layout law ──────────────────────────────────

    private static func verifyText3d(corpusFile: URL) throws -> Int {
        let cases = try loadCases(corpusFile)
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            var attrs: [String: String] = [:]
            for (k, v) in (c["attrs"] as? [String: Any]) ?? [:] { attrs[k] = JSE.string(v) }
            let node = SceneNode(kind: "text3d", id: nil, attrs: attrs, children: [])
            var diagnostics: [SceneDiagnostic] = []
            let resolve = mapResolver((c["vars"] as? [String: Any]) ?? [:])
            let props = SceneIRKit.resolvedProps(node, resolve) { diagnostics.append($0) }
            let quad = SceneIRKit.text3dQuad(props)
            if let expect = c["expect"] as? [String: Any] {
                guard let quad else {
                    throw Failure(description: "scene/\(name): no quad laid out")
                }
                guard let center = numberList(expect["center"]),
                      let halfWidth = JSE.number(expect["halfWidth"]),
                      let halfHeight = JSE.number(expect["halfHeight"]) else {
                    throw Failure(description: "scene/\(name): malformed expect{}")
                }
                try close(quad.center, center, "center", name)
                guard abs(quad.halfWidth - halfWidth) <= tolerance else {
                    throw Failure(description: "scene/\(name): halfWidth \(quad.halfWidth) (expected \(halfWidth))")
                }
                guard abs(quad.halfHeight - halfHeight) <= tolerance else {
                    throw Failure(description: "scene/\(name): halfHeight \(quad.halfHeight) (expected \(halfHeight))")
                }
            } else if quad != nil {
                // "expect": null — the empty value lays out NO quad (the no-quad law)
                throw Failure(description: "scene/\(name): empty value must lay out NO quad")
            }
            let expectedDiags = (c["diagnostics"] as? NSNumber)?.intValue ?? 0
            guard diagnostics.count == expectedDiags else {
                throw Failure(description: "scene/\(name): \(diagnostics.count) diagnostic(s) (expected \(expectedDiags)): \(diagnostics.map(\.message))")
            }
        }
        return cases.count
    }

    // ── frame.json — the on:frame schedule law (the budget fold) ─────────────────────

    private static func verifyFrame(corpusFile: URL) throws -> Int {
        let cases = try loadCases(corpusFile)
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            guard let ticks = numberList(c["ticks"]), let expect = c["expect"] as? [[String: Any]] else {
                throw Failure(description: "scene/\(name): no ticks[]/expect[]")
            }
            let emitted = SceneFrameClock.schedule(ticks)
            guard emitted.count == expect.count else {
                throw Failure(description: "scene/\(name): emitted \(emitted.count) payload(s) (expected \(expect.count))")
            }
            for (i, want) in expect.enumerated() {
                let got = emitted[i]
                guard let dt = JSE.number(want["dt"]), abs(got.dt - dt) <= tolerance else {
                    throw Failure(description: "scene/\(name): [\(i)].dt \(got.dt) (expected \(JSE.string(want["dt"])))")
                }
                guard let elapsed = JSE.number(want["elapsed"]), abs(got.elapsed - elapsed) <= tolerance else {
                    throw Failure(description: "scene/\(name): [\(i)].elapsed \(got.elapsed) (expected \(JSE.string(want["elapsed"])))")
                }
                guard got.frame == (want["frame"] as? NSNumber)?.intValue else {
                    throw Failure(description: "scene/\(name): [\(i)].frame \(got.frame) (expected \(JSE.string(want["frame"])))")
                }
            }
            // the stated semantics a runner CAN assert: monotonic elapsed/frame, dt ≥ 0
            for (i, payload) in emitted.enumerated() {
                guard payload.dt >= 0 else {
                    throw Failure(description: "scene/\(name): [\(i)].dt negative")
                }
                if i > 0 {
                    guard payload.elapsed > emitted[i - 1].elapsed,
                          payload.frame == emitted[i - 1].frame + 1 else {
                        throw Failure(description: "scene/\(name): [\(i)] elapsed/frame not strictly monotonic")
                    }
                }
            }
        }
        return cases.count
    }

    // ── animation.json — tweens · the when gate · transitions (P5) ───────────────────

    private static func stringList(_ raw: Any?) -> [String] {
        ((raw as? [Any]) ?? []).map { JSE.string($0) }
    }

    private static func animateNode(_ attrs: [String: Any]) -> SceneNode {
        var out: [String: String] = [:]
        for (k, v) in attrs { out[k] = JSE.string(v) }
        return SceneNode(kind: "animate", id: nil, attrs: out, children: [])
    }

    private static func tweenSetup(_ c: [String: Any], _ name: String)
        throws -> (spec: SceneTweenSpec, from: [Double], base: [Double]) {
        var diagnostics: [SceneDiagnostic] = []
        guard let specAttrs = c["spec"] as? [String: Any],
              let spec = SceneAnim.parseTween(animateNode(specAttrs), noHoles, { diagnostics.append($0) }),
              diagnostics.isEmpty else {
            throw Failure(description: "scene/\(name): spec did not parse cleanly (\(diagnostics.map(\.message)))")
        }
        guard let base = SceneAnim.parseAnimValue(spec.target, JSE.string(c["base"])) else {
            throw Failure(description: "scene/\(name): base did not parse")
        }
        return (spec: spec, from: spec.from ?? base, base: base)
    }

    private static func verifyAnimation(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        let tweens = (doc["tweens"] as? [[String: Any]]) ?? []
        let gated = (doc["gated"] as? [[String: Any]]) ?? []
        let transitions = (doc["transitions"] as? [[String: Any]]) ?? []
        guard tweens.count + gated.count + transitions.count >= 14 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): corpus is suspiciously small")
        }
        for c in tweens {
            let name = (c["name"] as? String) ?? "?"
            let setup = try tweenSetup(c, name)
            for want in (c["samples"] as? [[String: Any]]) ?? [] {
                guard let t = JSE.number(want["t"]), let value = numberList(want["value"]) else {
                    throw Failure(description: "scene/\(name): malformed sample")
                }
                let got = SceneAnim.tweenValue(setup.spec, from: setup.from, base: setup.base, tMs: t)
                try close(got.value, value, "value@\(JSE.string(want["t"]))", name)
                guard got.overriding == ((want["overriding"] as? Bool) ?? false) else {
                    throw Failure(description: "scene/\(name): overriding@\(JSE.string(want["t"])) = \(got.overriding)")
                }
                guard got.done == ((want["done"] as? Bool) ?? false) else {
                    throw Failure(description: "scene/\(name): done@\(JSE.string(want["t"])) = \(got.done)")
                }
            }
            if let format = c["format"] as? [String: Any], let t = JSE.number(format["t"]) {
                let got = SceneAnim.tweenValue(setup.spec, from: setup.from, base: setup.base, tMs: t)
                let formatted = SceneAnim.formatAnimValue(setup.spec.target, got.value)
                guard formatted == JSE.string(format["value"]) else {
                    throw Failure(description: "scene/\(name): formatted \(formatted) (expected \(JSE.string(format["value"])))")
                }
            }
        }
        for c in gated {
            let name = (c["name"] as? String) ?? "?"
            let setup = try tweenSetup(c, name)
            let events = (c["events"] as? [[String: Any]]) ?? []
            for want in (c["samples"] as? [[String: Any]]) ?? [] {
                guard let t = JSE.number(want["t"]), let value = numberList(want["value"]) else {
                    throw Failure(description: "scene/\(name): malformed sample")
                }
                // THE GATE LAW (the corpus _note): falsy ⇒ base; each falsy→truthy edge
                // restarts the clock. The fold below IS the law the surface implements.
                var playing = false
                var startMs = 0.0
                for event in events {
                    guard let et = JSE.number(event["t"]), et <= t else { break }
                    let when = (event["when"] as? Bool) ?? false
                    if when && !playing { startMs = et }
                    playing = when
                }
                let gotValue: [Double]
                let gotOverriding: Bool
                if playing {
                    let sample = SceneAnim.tweenValue(setup.spec, from: setup.from, base: setup.base, tMs: t - startMs)
                    gotValue = sample.value
                    gotOverriding = sample.overriding
                } else {
                    gotValue = setup.base
                    gotOverriding = false
                }
                try close(gotValue, value, "value@\(JSE.string(want["t"]))", name)
                guard gotOverriding == ((want["overriding"] as? Bool) ?? false) else {
                    throw Failure(description: "scene/\(name): overriding@\(JSE.string(want["t"])) = \(gotOverriding)")
                }
            }
        }
        for c in transitions {
            let name = (c["name"] as? String) ?? "?"
            var diagnostics: [SceneDiagnostic] = []
            let entries = SceneAnim.parseTransitions(JSE.string(c["entry"])) { diagnostics.append($0) }
            guard entries.count == 1, diagnostics.isEmpty else {
                throw Failure(description: "scene/\(name): entry did not parse to one clean entry (\(diagnostics.map(\.message)))")
            }
            let entry = entries[0]
            func parse(_ raw: String) throws -> [Double] {
                guard let v = SceneAnim.parseAnimValue(entry.property, raw) else {
                    throw Failure(description: "scene/\(name): \(raw) is not a \(entry.property) value")
                }
                return v
            }
            var state: SceneTransitionState? = nil
            func rendered(_ t: Double) throws -> (value: [Double], done: Bool) {
                guard let state else { return (value: try parse(JSE.string(c["base0"])), done: true) }
                return SceneAnim.transitionValue(entry, state, t)
            }
            let events = (c["events"] as? [[String: Any]]) ?? []
            var next = 0
            for want in (c["samples"] as? [[String: Any]]) ?? [] {
                guard let t = JSE.number(want["t"]), let value = numberList(want["value"]) else {
                    throw Failure(description: "scene/\(name): malformed sample")
                }
                while next < events.count, let et = JSE.number(events[next]["t"]), et <= t {
                    // THE RETARGET LAW: the new glide starts from the CURRENT RENDERED value
                    state = SceneTransitionState(from: try rendered(et).value,
                                                 to: try parse(JSE.string(events[next]["base"])),
                                                 startMs: et)
                    next += 1
                }
                let got = try rendered(t)
                try close(got.value, value, "value@\(JSE.string(want["t"]))", name)
                guard got.done == ((want["done"] as? Bool) ?? false) else {
                    throw Failure(description: "scene/\(name): done@\(JSE.string(want["t"])) = \(got.done)")
                }
            }
        }
        return tweens.count + gated.count + transitions.count
    }

    // ── bind.json — rows · keyed diff · row scope · nesting · the cap (P5) ───────────

    private static func verifyBind(corpusFile: URL) throws -> Int {
        let cases = try loadCases(corpusFile)
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            let key = JSE.string(c["key"])
            var diagnostics: [SceneDiagnostic] = []
            let diag: (SceneDiagnostic) -> Void = { diagnostics.append($0) }
            guard let expect = c["expect"] as? [String: Any] else {
                throw Failure(description: "scene/\(name): no expect{}")
            }
            switch JSE.string(c["kind"]) {
            case "rows":
                let rows = SceneBind.rows(c["value"], keyField: key, diag)
                guard rows.map(\.key) == stringList(expect["keys"]) else {
                    throw Failure(description: "scene/\(name): keys \(rows.map(\.key)) (expected \(stringList(expect["keys"])))")
                }
                guard rows.map({ Double($0.index) }) == (numberList(expect["indices"]) ?? []) else {
                    throw Failure(description: "scene/\(name): indices mismatch")
                }
                guard diagnostics.isEmpty else {
                    throw Failure(description: "scene/\(name): unexpected diagnostics \(diagnostics.map(\.message))")
                }
            case "diff":
                let previous = stringList(c["previous"])
                let rows = SceneBind.rows(c["value"], keyField: key, diag)
                let diffResult = SceneBind.diff(previous: previous, next: rows)
                guard diffResult.added == stringList(expect["added"]),
                      diffResult.removed == stringList(expect["removed"]),
                      diffResult.retained == stringList(expect["retained"]) else {
                    throw Failure(description: "scene/\(name): diff mismatch (added \(diffResult.added), removed \(diffResult.removed), retained \(diffResult.retained))")
                }
            case "scope":
                guard let template = c["template"] as? [String: Any],
                      let templateAttrs = template["attrs"] as? [String: Any] else {
                    throw Failure(description: "scene/\(name): no template{}")
                }
                var attrs: [String: String] = [:]
                for (k, v) in templateAttrs { attrs[k] = JSE.string(v) }
                let templateNode = SceneNode(kind: JSE.string(template["kind"]), id: nil,
                                             attrs: attrs, children: [])
                let rows = SceneBind.rows(c["value"], keyField: key, diag)
                var positions: [[Double]] = []
                var colors: [String] = []
                for row in rows {
                    guard let instance = SceneBind.instantiateRow([templateNode]).first else { continue }
                    // the row scope: item.* resolves against the row value (the <list> row law)
                    let rowResolve: SceneResolve = { _, _, raw in
                        SceneIRKit.interpolateSceneHoles(raw) { expr in
                            if expr == "item" { return row.item }
                            if expr == "item.index" { return row.index }
                            if expr.hasPrefix("item.") {
                                return (row.item as? [String: Any])?[String(expr.dropFirst(5))]
                            }
                            return nil
                        }
                    }
                    let props = SceneIRKit.resolvedProps(instance, rowResolve, diag)
                    positions.append(props.position)
                    colors.append(props.color)
                }
                let wantPositions = ((expect["positions"] as? [Any]) ?? []).map { numberList($0) ?? [] }
                guard positions.count == wantPositions.count else {
                    throw Failure(description: "scene/\(name): \(positions.count) row(s) (expected \(wantPositions.count))")
                }
                for (i, want) in wantPositions.enumerated() {
                    try close(positions[i], want, "positions[\(i)]", name)
                }
                guard colors == stringList(expect["colors"]) else {
                    throw Failure(description: "scene/\(name): colors \(colors) (expected \(stringList(expect["colors"])))")
                }
                guard diagnostics.isEmpty else {
                    throw Failure(description: "scene/\(name): unexpected diagnostics \(diagnostics.map(\.message))")
                }
            case "nested":
                let outer = SceneBind.rows(c["value"], keyField: key, diag)
                guard outer.map(\.key) == stringList(expect["outerKeys"]) else {
                    throw Failure(description: "scene/\(name): outer keys \(outer.map(\.key))")
                }
                let innerField = JSE.string(c["innerField"])
                let innerKey = JSE.string(c["innerKey"])
                var inner: [[String]] = []
                for r in outer {
                    inner.append(SceneBind.rows((r.item as? [String: Any])?[innerField],
                                                keyField: innerKey, diag).map(\.key))
                }
                let wantInner = ((expect["innerKeys"] as? [Any]) ?? []).map { stringList($0) }
                guard inner == wantInner else {
                    throw Failure(description: "scene/\(name): inner keys \(inner) (expected \(wantInner))")
                }
                guard diagnostics.isEmpty else {
                    throw Failure(description: "scene/\(name): unexpected diagnostics \(diagnostics.map(\.message))")
                }
            case "cap":
                // the runner builds the oversized array (a corpus file should not carry 300 rows)
                let count = (c["count"] as? NSNumber)?.intValue ?? 0
                let rows = SceneBind.rows(Array(0..<count), keyField: key, diag)
                guard rows.count == ((expect["rowCount"] as? NSNumber)?.intValue ?? -1) else {
                    throw Failure(description: "scene/\(name): rowCount \(rows.count)")
                }
                guard rows.first?.key == JSE.string(expect["firstKey"]),
                      rows.last?.key == JSE.string(expect["lastKey"]) else {
                    throw Failure(description: "scene/\(name): first/last key mismatch")
                }
                guard diagnostics.count == ((expect["diagnostics"] as? NSNumber)?.intValue ?? -1),
                      diagnostics.allSatisfy({ $0.code == "bind-overflow" }) else {
                    throw Failure(description: "scene/\(name): diagnostics \(diagnostics.map(\.message))")
                }
            default:
                throw Failure(description: "scene/\(name): unknown bind case kind")
            }
        }
        return cases.count
    }

    // ── collide.json — depth laws · world AABB · the enter fold (P5) ─────────────────

    private static func colliderShape(_ raw: [String: Any], _ name: String) throws -> SceneColliderShape {
        let id = JSE.string(raw["id"])
        switch JSE.string(raw["kind"]) {
        case "sphere":
            guard let center = numberList(raw["center"]), let radius = JSE.number(raw["radius"]) else {
                throw Failure(description: "scene/\(name): malformed sphere shape")
            }
            return .sphere(id: id, center: center, radius: radius)
        case "box":
            guard let minV = numberList(raw["min"]), let maxV = numberList(raw["max"]) else {
                throw Failure(description: "scene/\(name): malformed box shape")
            }
            return .box(id: id, min: minV, max: maxV)
        default:
            throw Failure(description: "scene/\(name): unknown collider shape kind")
        }
    }

    private static func verifyCollide(corpusFile: URL) throws -> Int {
        let cases = try loadCases(corpusFile)
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            switch JSE.string(c["kind"]) {
            case "contacts":
                let shapes = try ((c["shapes"] as? [[String: Any]]) ?? []).map { try colliderShape($0, name) }
                let got = SceneCollide.contacts(shapes)
                let want = (c["expect"] as? [[String: Any]]) ?? []
                guard got.count == want.count else {
                    throw Failure(description: "scene/\(name): \(got.count) contact(s) (expected \(want.count))")
                }
                for (i, w) in want.enumerated() {
                    guard got[i].a == JSE.string(w["a"]), got[i].b == JSE.string(w["b"]),
                          let depth = JSE.number(w["depth"]), abs(got[i].depth - depth) <= tolerance else {
                        throw Failure(description: "scene/\(name): contact[\(i)] \(got[i].a)/\(got[i].b)@\(got[i].depth)")
                    }
                }
            case "aabb":
                guard let half = numberList(c["half"]), let trs = c["trs"] as? [String: Any],
                      let position = numberList(trs["position"]), let rotation = numberList(trs["rotation"]),
                      let scale = numberList(trs["scale"]),
                      let expect = c["expect"] as? [String: Any],
                      let wantMin = numberList(expect["min"]), let wantMax = numberList(expect["max"]) else {
                    throw Failure(description: "scene/\(name): malformed aabb case")
                }
                let world = SceneMath.trs(position: position, rotationDeg: rotation, scale: scale)
                let got = SceneCollide.worldAabb(world, half: half)
                try close(got.min, wantMin, "min", name)
                try close(got.max, wantMax, "max", name)
            case "track":
                let tracker = SceneCollisionTracker()
                let frames = (c["frames"] as? [[[String: Any]]]) ?? []
                let want = (c["expect"] as? [[[String: Any]]]) ?? []
                guard frames.count == want.count, !frames.isEmpty else {
                    throw Failure(description: "scene/\(name): malformed track case")
                }
                for (i, frame) in frames.enumerated() {
                    let events = tracker.step(try frame.map { try colliderShape($0, name) })
                    guard events.count == want[i].count else {
                        throw Failure(description: "scene/\(name): frame \(i): \(events.count) event(s) (expected \(want[i].count))")
                    }
                    for (j, w) in want[i].enumerated() {
                        guard events[j].id == JSE.string(w["id"]), events[j].other == JSE.string(w["other"]),
                              let depth = JSE.number(w["depth"]), abs(events[j].depth - depth) <= tolerance else {
                            throw Failure(description: "scene/\(name): frame \(i)[\(j)] mismatch")
                        }
                    }
                }
            default:
                throw Failure(description: "scene/\(name): unknown collide case kind")
            }
        }
        return cases.count
    }

    // ── orbit.json — the spherical/drag/zoom laws (P5) ───────────────────────────────

    private static func verifyOrbit(corpusFile: URL) throws -> Int {
        let cases = try loadCases(corpusFile)
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            guard let camera = c["camera"] as? [String: Any],
                  let position = numberList(camera["position"]),
                  let lookAt = numberList(camera["lookAt"]),
                  let expect = c["expect"] as? [String: Any],
                  let yawDeg = JSE.number(expect["yawDeg"]),
                  let pitchDeg = JSE.number(expect["pitchDeg"]),
                  let distance = JSE.number(expect["distance"]),
                  let wantPosition = numberList(expect["position"]) else {
                throw Failure(description: "scene/\(name): malformed orbit case")
            }
            var state = SceneOrbit.fromCamera(position: position, lookAt: lookAt)
            for op in (c["ops"] as? [[String: Any]]) ?? [] {
                if let drag = numberList(op["drag"]), drag.count == 2 {
                    state = SceneOrbit.drag(state, dxPx: drag[0], dyPx: drag[1])
                } else if let zoom = op["zoom"] as? [String: Any],
                          let deltaY = JSE.number(zoom["deltaY"]),
                          let near = JSE.number(zoom["near"]), let far = JSE.number(zoom["far"]) {
                    state = SceneOrbit.zoom(state, deltaY: deltaY, near: near, far: far)
                } else {
                    throw Failure(description: "scene/\(name): malformed op")
                }
            }
            try close([state.yawDeg, state.pitchDeg, state.distance],
                      [yawDeg, pitchDeg, distance], "state", name)
            try close(SceneOrbit.position(state, lookAt: lookAt), wantPosition, "position", name)
        }
        return cases.count
    }

    // ── lighting.json — attenuation · lit color · the cap · fog (P5) ─────────────────

    private static func verifyLighting(corpusFile: URL) throws -> Int {
        let cases = try loadCases(corpusFile)
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            switch JSE.string(c["kind"]) {
            case "attenuation":
                guard let range = JSE.number(c["range"]) else {
                    throw Failure(description: "scene/\(name): no range")
                }
                for s in (c["samples"] as? [[String: Any]]) ?? [] {
                    guard let d = JSE.number(s["d"]), let value = JSE.number(s["value"]) else {
                        throw Failure(description: "scene/\(name): malformed sample")
                    }
                    let got = SceneIRKit.scenePointAttenuation(distance: d, range: range)
                    guard abs(got - value) <= tolerance else {
                        throw Failure(description: "scene/\(name): att(\(JSE.string(d))) = \(got) (expected \(value))")
                    }
                }
            case "lit":
                guard let base = numberList(c["base"]), let normal = numberList(c["normal"]),
                      let point = numberList(c["point"]), let ambient = numberList(c["ambient"]),
                      let expect = numberList(c["expect"]) else {
                    throw Failure(description: "scene/\(name): malformed lit case")
                }
                var directional: (dir: [Double], color: [Double])? = nil
                if let d = c["directional"] as? [String: Any],
                   let dir = numberList(d["dir"]), let color = numberList(d["color"]) {
                    directional = (dir: dir, color: color)
                }
                var points: [ScenePointLightResolved] = []
                for p in (c["points"] as? [[String: Any]]) ?? [] {
                    guard let position = numberList(p["position"]), let color = numberList(p["color"]),
                          let intensity = JSE.number(p["intensity"]), let range = JSE.number(p["range"]) else {
                        throw Failure(description: "scene/\(name): malformed point light")
                    }
                    points.append(ScenePointLightResolved(position: position, color: color,
                                                          intensity: intensity, range: range))
                }
                let got = SceneIRKit.sceneLitColor(base: base, normal: normal, point: point,
                                                   ambient: ambient, directional: directional,
                                                   points: points)
                try close(got, expect, "lit", name)
            case "cap":
                var diagnostics: [SceneDiagnostic] = []
                var nodes: [SceneNode] = []
                for light in (c["lights"] as? [[String: Any]]) ?? [] {
                    var attrs: [String: String] = [:]
                    for (k, v) in light { attrs[k] = JSE.string(v) }
                    nodes.append(SceneNode(kind: "light", id: nil, attrs: attrs, children: []))
                }
                let ir = SceneIR(mode: "3d", attrs: [:], nodes: nodes)
                let lighting = SceneIRKit.sceneLighting(ir, noHoles) { diagnostics.append($0) }
                guard let expect = c["expect"] as? [String: Any],
                      let positions = expect["positions"] as? [Any] else {
                    throw Failure(description: "scene/\(name): malformed expect{}")
                }
                guard lighting.points.count == ((expect["pointCount"] as? NSNumber)?.intValue ?? -1) else {
                    throw Failure(description: "scene/\(name): pointCount \(lighting.points.count)")
                }
                for (i, p) in lighting.points.enumerated() {
                    guard i < positions.count, let want = numberList(positions[i]) else {
                        throw Failure(description: "scene/\(name): points[\(i)] has no expectation")
                    }
                    try close(p.position, want, "points[\(i)]", name)
                }
                guard diagnostics.count == ((expect["diagnostics"] as? NSNumber)?.intValue ?? -1),
                      diagnostics.allSatisfy({ $0.code == "light-cap" }) else {
                    throw Failure(description: "scene/\(name): diagnostics \(diagnostics.map(\.message))")
                }
            case "fog-factor":
                guard let near = JSE.number(c["near"]), let far = JSE.number(c["far"]) else {
                    throw Failure(description: "scene/\(name): malformed fog-factor case")
                }
                for s in (c["samples"] as? [[String: Any]]) ?? [] {
                    guard let d = JSE.number(s["d"]), let value = JSE.number(s["value"]) else {
                        throw Failure(description: "scene/\(name): malformed sample")
                    }
                    let got = SceneIRKit.sceneFogFactor(distance: d, near: near, far: far)
                    guard abs(got - value) <= tolerance else {
                        throw Failure(description: "scene/\(name): fog(\(JSE.string(d))) = \(got) (expected \(value))")
                    }
                }
            case "fog-blend":
                // final = f·lit + (1 − f)·fogColor (the blend law verbatim)
                guard let lit = numberList(c["lit"]), let fogColor = numberList(c["fogColor"]),
                      let near = JSE.number(c["near"]), let far = JSE.number(c["far"]),
                      let d = JSE.number(c["d"]), let expect = numberList(c["expect"]) else {
                    throw Failure(description: "scene/\(name): malformed fog-blend case")
                }
                let f = SceneIRKit.sceneFogFactor(distance: d, near: near, far: far)
                let got = (0..<3).map { f * lit[$0] + (1 - f) * fogColor[$0] }
                try close(got, expect, "blend", name)
            default:
                throw Failure(description: "scene/\(name): unknown lighting case kind")
            }
        }
        return cases.count
    }

    // ── physics.json — the G2 fixed-tick solver (dsx-game.md §2 G2) ──────────────────

    private static func physicsBodySpec(_ spec: [String: Any], _ name: String) throws -> ScenePhysicsBodySpec {
        guard let id = spec["id"] as? String, let kind = spec["kind"] as? String,
              let shapeSpec = spec["shape"] as? [String: Any] else {
            throw Failure(description: "scene/\(name): malformed body spec")
        }
        let shape: ScenePhysicsShape
        if JSE.string(shapeSpec["kind"]) == "sphere" {
            guard let radius = JSE.number(shapeSpec["radius"]) else {
                throw Failure(description: "scene/\(name): sphere shape without radius")
            }
            shape = .sphere(radius: radius)
        } else {
            guard let half = numberList(shapeSpec["half"]) else {
                throw Failure(description: "scene/\(name): box shape without half")
            }
            shape = .box(half: half)
        }
        var body = ScenePhysicsBodySpec(id: id, kind: kind, shape: shape)
        if let position = numberList(spec["position"]) { body.position = position }
        if let velocity = numberList(spec["velocity"]) { body.velocity = velocity }
        if let rotation = numberList(spec["rotation"]) { body.rotation = rotation }
        if let angularVelocity = numberList(spec["angularVelocity"]) { body.angularVelocity = angularVelocity }
        if let torque = numberList(spec["torque"]) { body.torque = torque }
        if let damping = JSE.number(spec["angularDamping"]) { body.angularDamping = damping }
        if let mass = JSE.number(spec["mass"]) { body.mass = mass }
        if let bounce = JSE.number(spec["bounce"]) { body.bounce = bounce }
        if let friction = JSE.number(spec["friction"]) { body.friction = friction }
        if let trigger = spec["trigger"] as? Bool { body.trigger = trigger }
        if let layer = spec["layer"] as? String { body.layer = layer }
        if let collides = spec["collides"] as? [Any] { body.collides = collides.map { JSE.string($0) } }
        if let speed = JSE.number(spec["speed"]) { body.speed = speed }
        if let jump = JSE.number(spec["jump"]) { body.jump = jump }
        return body
    }

    /// the corpus sim driver (the TS runner's runPhysicsSim, verbatim): writes land
    /// BEFORE their tick's step; kinematic drives position the body at
    /// start + velocity·dt·(tick+1); samples record state AFTER the named tick's step
    private static func runPhysicsSim(_ c: [String: Any], _ name: String) throws
        -> (world: ScenePhysicsWorld,
            samples: [String: (position: [Double], velocity: [Double], rotation: [Double],
                               angularVelocity: [Double], angularMomentum: [Double],
                               grounded: Bool, sleeping: Bool)],
            events: [String]) {
        let gravity = numberList(c["gravity"]) ?? [0, -9.81, 0]
        let specs = try ((c["bodies"] as? [[String: Any]]) ?? []).map { try physicsBodySpec($0, name) }
        let world = ScenePhysics.createWorld(
            gravity: gravity, specs: specs, mode2d: (c["mode2d"] as? Bool) == true)
        var wanted: [Int: [String]] = [:]
        for s in (c["samples"] as? [[String: Any]]) ?? [] {
            guard let tick = (s["tick"] as? NSNumber)?.intValue, let id = s["id"] as? String else {
                throw Failure(description: "scene/\(name): malformed sample spec")
            }
            wanted[tick, default: []].append(id)
        }
        var samples: [String: (position: [Double], velocity: [Double], rotation: [Double],
                              angularVelocity: [Double], angularMomentum: [Double],
                              grounded: Bool, sleeping: Bool)] = [:]
        var events: [String] = []
        var drivenRotations: [String: [Double]] = [:]
        let ticks = (c["ticks"] as? NSNumber)?.intValue ?? 0
        for n in 0..<ticks {
            for w in (c["writes"] as? [[String: Any]]) ?? [] {
                guard (w["tick"] as? NSNumber)?.intValue == n,
                      let id = w["id"] as? String, let value = numberList(w["value"]) else { continue }
                switch JSE.string(w["attr"]) {
                case "velocity": ScenePhysics.writeVelocity(world, id: id, value)
                case "angular-velocity": ScenePhysics.writeAngularVelocity(world, id: id, value)
                case "torque": ScenePhysics.writeTorque(world, id: id, value)
                case "rotation": ScenePhysics.teleportRotation(world, id: id, value)
                default: ScenePhysics.teleport(world, id: id, value)
                }
            }
            var intents: [String: ScenePhysicsIntent] = [:]
            for d in (c["drives"] as? [[String: Any]]) ?? [] {
                guard let id = d["id"] as? String, let start = numberList(d["start"]),
                      let velocity = numberList(d["velocity"]) else {
                    throw Failure(description: "scene/\(name): malformed drive spec")
                }
                intents[id] = ScenePhysicsIntent(position: [
                    start[0] + velocity[0] * (ScenePhysics.dt * Double(n + 1)),
                    start[1] + velocity[1] * (ScenePhysics.dt * Double(n + 1)),
                    start[2] + velocity[2] * (ScenePhysics.dt * Double(n + 1)),
                ])
            }
            for drive in (c["rotationDrives"] as? [[String: Any]]) ?? [] {
                guard (drive["tick"] as? NSNumber)?.intValue == n,
                      let id = drive["id"] as? String,
                      let value = numberList(drive["value"]) else { continue }
                drivenRotations[id] = value
            }
            for (id, rotation) in drivenRotations {
                var intent = intents[id] ?? ScenePhysicsIntent()
                intent.rotation = rotation
                intents[id] = intent
            }
            for m in (c["moves"] as? [[String: Any]]) ?? [] {
                guard let id = m["id"] as? String, let from = (m["from"] as? NSNumber)?.intValue,
                      let to = (m["to"] as? NSNumber)?.intValue, let move = numberList(m["move"]) else {
                    throw Failure(description: "scene/\(name): malformed move spec")
                }
                if from <= n && n <= to {
                    var intent = intents[id] ?? ScenePhysicsIntent()
                    intent.move = move
                    intents[id] = intent
                }
            }
            let result = ScenePhysics.step(world, intents: intents)
            guard result.tick == n, result.dt == ScenePhysics.dt else {
                throw Failure(description: "scene/\(name): step payload tick \(result.tick) dt \(result.dt)")
            }
            for (label, list) in [("collision", result.collisions), ("enter", result.enters), ("exit", result.exits)] {
                for e in list { events.append("\(n) \(label) \(e.id) \(e.other)") }
            }
            for id in wanted[n] ?? [] {
                guard let body = world.byId[id] else {
                    throw Failure(description: "scene/\(name): sample body '\(id)' missing")
                }
                samples["\(n):\(id)"] = (position: body.position, velocity: body.velocity,
                                         rotation: body.rotation, angularVelocity: body.angularVelocity,
                                         angularMomentum: physicsBodyAngularMomentum(body),
                                         grounded: body.grounded, sleeping: body.sleeping)
            }
        }
        return (world: world, samples: samples, events: events)
    }

    private static func physicsBodyAngularMomentum(_ body: ScenePhysicsBody) -> [Double] {
        let q = body.orientation, x = q[0], y = q[1], z = q[2], w = q[3]
        let axes = [
            [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
            [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
            [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
        ]
        var out = [0.0, 0.0, 0.0]
        for axis in 0..<3 {
            let basis = axes[axis]
            let component = body.angularVelocity[0] * basis[0]
                + body.angularVelocity[1] * basis[1] + body.angularVelocity[2] * basis[2]
            let inertia = body.invInertia[axis] > 0 ? 1 / body.invInertia[axis] : 0
            for k in 0..<3 { out[k] += basis[k] * component * inertia }
        }
        return out
    }

    private static func verifyPhysics(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let constants = doc["constants"] as? [String: Any],
              let cases = doc["cases"] as? [[String: Any]], cases.count >= 16 else {
            throw Failure(description: "physics.json: malformed corpus")
        }
        // the pinned constants match the kernel statics (the TS runner's pattern)
        let constantChecks: [(String, Double)] = [
            ("dt", ScenePhysics.dt), ("maxStepsPerFrame", Double(ScenePhysics.maxStepsPerFrame)),
            ("correctionPercent", ScenePhysics.correctionPercent), ("slop", ScenePhysics.slop),
            ("restitutionMinSpeed", ScenePhysics.restitutionMinSpeed),
            ("groundNormalY", ScenePhysics.groundNormalY), ("sleepSpeed", ScenePhysics.sleepSpeed),
            ("sleepTicks", Double(ScenePhysics.sleepTicks)),
            ("characterSlideIterations", Double(ScenePhysics.slideIterations)),
            ("manifoldIterations", Double(ScenePhysics.manifoldIterations)),
            ("defaultMass", 1), ("defaultBounce", 0), ("defaultFriction", 0.5),
            ("defaultSpeed", ScenePhysics.defaultSpeed), ("defaultJump", ScenePhysics.defaultJump),
            ("defaultAngularDamping", ScenePhysics.defaultAngularDamping),
            ("radiansToDegrees", ScenePhysics.radiansToDegrees),
        ]
        for (key, value) in constantChecks {
            guard let pinned = JSE.number(constants[key]), abs(pinned - value) <= tolerance else {
                throw Failure(description: "physics constants: \(key) drifted (kernel \(value))")
            }
        }
        guard let pinnedGravity = numberList(constants["gravity"]) else {
            throw Failure(description: "physics constants: no gravity")
        }
        try close(ScenePhysics.defaultGravity, pinnedGravity, "constants.gravity", "constants")

        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            switch JSE.string(c["kind"]) {
            case "world":
                guard let markupSource = c["markup"] as? String, let markup = StackXML.parse(markupSource) else {
                    throw Failure(description: "scene/\(name): markup did not parse")
                }
                var diagnostics: [SceneDiagnostic] = []
                let diag: (SceneDiagnostic) -> Void = { diagnostics.append($0) }
                let ir = SceneIRKit.parseScene(markup, diag: diag)
                let resolve = mapResolver((c["vars"] as? [String: Any]) ?? [:])
                let extraction = ScenePhysics.extract(ir, resolve, diag)
                guard let expect = c["expect"] as? [String: Any],
                      let wantGravity = numberList(expect["gravity"]),
                      let wantBodies = expect["bodies"] as? [[String: Any]] else {
                    throw Failure(description: "scene/\(name): malformed expect{}")
                }
                try close(extraction.gravity, wantGravity, "gravity", name)
                // build the world from the extraction — the corpus pins the BODY records
                let world = ScenePhysics.createWorld(gravity: extraction.gravity, specs: extraction.bodies,
                                                    mode2d: extraction.mode2d)
                guard world.bodies.count == wantBodies.count else {
                    throw Failure(description: "scene/\(name): \(world.bodies.count) bodies (expected \(wantBodies.count))")
                }
                for (i, w) in wantBodies.enumerated() {
                    let body = world.bodies[i]
                    guard body.id == JSE.string(w["id"]), body.kind == JSE.string(w["kind"]),
                          body.shape == JSE.string(w["shape"]) else {
                        throw Failure(description: "scene/\(name): [\(i)] \(body.id)/\(body.kind)/\(body.shape) drifted")
                    }
                    if body.shape == "sphere" {
                        guard let radius = JSE.number(w["radius"]), abs(body.radius - radius) <= tolerance else {
                            throw Failure(description: "scene/\(name): [\(i)].radius \(body.radius)")
                        }
                    } else {
                        guard let half = numberList(w["half"]) else {
                            throw Failure(description: "scene/\(name): [\(i)] box without half")
                        }
                        try close(body.half, half, "[\(i)].half", name)
                    }
                    guard let position = numberList(w["position"]), let velocity = numberList(w["velocity"]) else {
                        throw Failure(description: "scene/\(name): [\(i)] malformed expectation")
                    }
                    try close(body.position, position, "[\(i)].position", name)
                    try close(body.velocity, velocity, "[\(i)].velocity", name)
                    if let rotation = numberList(w["rotation"]) {
                        try close(body.rotation, rotation, "[\(i)].rotation", name)
                    }
                    if let angularVelocity = numberList(w["angularVelocity"]) {
                        try close(body.angularVelocity, angularVelocity, "[\(i)].angularVelocity", name)
                    }
                    if let torque = numberList(w["torque"]) {
                        try close(body.torque, torque, "[\(i)].torque", name)
                    }
                    if let inertia = numberList(w["invInertia"]) {
                        try close(body.invInertia, inertia, "[\(i)].invInertia", name)
                    }
                    if let damping = JSE.number(w["angularDamping"]), body.angularDamping != damping {
                        throw Failure(description: "scene/\(name): [\(i)].angularDamping \(body.angularDamping)")
                    }
                    guard let invMass = JSE.number(w["invMass"]), abs(body.invMass - invMass) <= tolerance,
                          body.bounce == JSE.number(w["bounce"]), body.friction == JSE.number(w["friction"]),
                          body.trigger == (w["trigger"] as? Bool ?? false),
                          body.layer == JSE.string(w["layer"]),
                          body.speed == JSE.number(w["speed"]), body.jump == JSE.number(w["jump"]) else {
                        throw Failure(description: "scene/\(name): [\(i)] body words drifted")
                    }
                    let wantCollides = (w["collides"] as? [Any]).map { $0.map { JSE.string($0) } }
                    guard body.collides == wantCollides else {
                        throw Failure(description: "scene/\(name): [\(i)].collides \(body.collides ?? [])")
                    }
                }
                let expectedDiags = (c["diagnostics"] as? NSNumber)?.intValue ?? 0
                guard diagnostics.count == expectedDiags else {
                    throw Failure(description: "scene/\(name): \(diagnostics.count) diagnostic(s) (expected \(expectedDiags)): \(diagnostics.map(\.message))")
                }
                if let corners = c["corners"] as? [[Any]] {
                    guard world.bodies.count == 1 else {
                        throw Failure(description: "scene/\(name): corner containment requires one body")
                    }
                    let body = world.bodies[0]
                    let matrix = SceneMath.trs(position: [0, 0, 0], rotationDeg: body.rotation,
                                               scale: [1, 1, 1])
                    let axes = [[matrix[0], matrix[1], matrix[2]],
                                [matrix[4], matrix[5], matrix[6]],
                                [matrix[8], matrix[9], matrix[10]]]
                    for (cornerIndex, raw) in corners.enumerated() {
                        guard let corner = numberList(raw) else {
                            throw Failure(description: "scene/\(name): malformed corner")
                        }
                        let delta = (0..<3).map { corner[$0] - body.position[$0] }
                        for axis in 0..<3 {
                            let projection = abs(delta[0] * axes[axis][0]
                                + delta[1] * axes[axis][1] + delta[2] * axes[axis][2])
                            if projection > body.half[axis] + tolerance {
                                throw Failure(description: "scene/\(name): corner \(cornerIndex) axis \(axis) escapes")
                            }
                        }
                    }
                }
            case "contact":
                let specs = try ((c["bodies"] as? [[String: Any]]) ?? []).map {
                    try physicsBodySpec($0, name)
                }
                let world = ScenePhysics.createWorld(gravity: [0, 0, 0], specs: specs)
                guard world.bodies.count == 2,
                      let got = ScenePhysics.contact(world.bodies[0], world.bodies[1]),
                      let want = c["expect"] as? [String: Any],
                      let depth = JSE.number(want["depth"]),
                      let normal = numberList(want["normal"]),
                      let pointCount = (want["pointCount"] as? NSNumber)?.intValue,
                      let centroidWant = numberList(want["centroid"]) else {
                    throw Failure(description: "scene/\(name): malformed contact case")
                }
                guard abs(got.depth - depth) <= tolerance, got.points.count == pointCount else {
                    throw Failure(description: "scene/\(name): depth/pointCount drift")
                }
                try close(got.normal, normal, "normal", name)
                var centroid = [0.0, 0.0, 0.0]
                for point in got.points { for k in 0..<3 {
                    centroid[k] += point[k] / Double(got.points.count)
                }}
                try close(centroid, centroidWant, "centroid", name)
                if (want["symmetric"] as? Bool) == true {
                    guard let reverse = ScenePhysics.contact(world.bodies[1], world.bodies[0]),
                          reverse.points.count == got.points.count else {
                        throw Failure(description: "scene/\(name): reverse contact missing")
                    }
                    try close(reverse.normal, got.normal.map { -$0 }, "reverse normal", name)
                    var reverseCentroid = [0.0, 0.0, 0.0]
                    for point in reverse.points { for k in 0..<3 {
                        reverseCentroid[k] += point[k] / Double(reverse.points.count)
                    }}
                    try close(reverseCentroid, centroid, "reverse centroid", name)
                }
            case "sim":
                let run = try runPhysicsSim(c, name)
                for want in (c["samples"] as? [[String: Any]]) ?? [] {
                    guard let tick = (want["tick"] as? NSNumber)?.intValue, let id = want["id"] as? String,
                          let position = numberList(want["position"]), let velocity = numberList(want["velocity"]),
                          let grounded = want["grounded"] as? Bool, let sleeping = want["sleeping"] as? Bool else {
                        throw Failure(description: "scene/\(name): malformed sample expectation")
                    }
                    guard let got = run.samples["\(tick):\(id)"] else {
                        throw Failure(description: "scene/\(name): sample @\(tick) \(id) not recorded")
                    }
                    try close(got.position, position, "@\(tick) \(id) position", name)
                    try close(got.velocity, velocity, "@\(tick) \(id) velocity", name)
                    if let rotation = numberList(want["rotation"]) {
                        try close(got.rotation, rotation, "@\(tick) \(id) rotation", name)
                    }
                    if let angularVelocity = numberList(want["angularVelocity"]) {
                        try close(got.angularVelocity, angularVelocity, "@\(tick) \(id) angularVelocity", name)
                    }
                    if let angularMomentum = numberList(want["angularMomentum"]) {
                        try close(got.angularMomentum, angularMomentum, "@\(tick) \(id) angularMomentum", name)
                    }
                    guard got.grounded == grounded, got.sleeping == sleeping else {
                        throw Failure(description: "scene/\(name): @\(tick) \(id) grounded \(got.grounded) sleeping \(got.sleeping)")
                    }
                }
                if let wantEvents = c["events"] as? [[String: Any]] {
                    let expected = wantEvents.map {
                        "\((($0["tick"] as? NSNumber)?.intValue ?? -1)) \(JSE.string($0["name"])) \(JSE.string($0["id"])) \(JSE.string($0["other"]))"
                    }
                    guard run.events == expected else {
                        throw Failure(description: "scene/\(name): events \(run.events) (expected \(expected))")
                    }
                }
                if (c["replay"] as? Bool) == true {
                    // THE DETERMINISM LAW: a second identical run ends BIT-identical
                    let again = try runPhysicsSim(c, name)
                    for body in run.world.bodies {
                        guard let twin = again.world.byId[body.id],
                              twin.position == body.position, twin.velocity == body.velocity,
                              twin.rotation == body.rotation,
                              twin.angularVelocity == body.angularVelocity else {
                            throw Failure(description: "scene/\(name): \(body.id) replay diverged")
                        }
                    }
                }
            case "accumulator":
                guard let frames = numberList(c["frames"]),
                      let want = c["expect"] as? [[String: Any]] else {
                    throw Failure(description: "scene/\(name): malformed accumulator case")
                }
                let got = ScenePhysics.schedule(frames)
                guard got.count == want.count else {
                    throw Failure(description: "scene/\(name): \(got.count) frames (expected \(want.count))")
                }
                for (i, w) in want.enumerated() {
                    guard got[i].steps == ((w["steps"] as? NSNumber)?.intValue ?? -1),
                          let alpha = JSE.number(w["alpha"]), abs(got[i].alpha - alpha) <= tolerance else {
                        throw Failure(description: "scene/\(name): [\(i)] steps \(got[i].steps) alpha \(got[i].alpha)")
                    }
                }
            case "parentframe":
                // THE PARENT-FRAME LAW: this runner composes the parent with its OWN
                // SceneMath.trs — the root⇄local pair every nested body rides
                let spec = c["parent"] as? [String: Any]
                let parentWorld: [Double]? = spec.flatMap { p -> [Double]? in
                    guard let position = numberList(p["position"]), let rotation = numberList(p["rotation"]),
                          let scale = numberList(p["scale"]) else { return nil }
                    return SceneMath.trs(position: position, rotationDeg: rotation, scale: scale)
                }
                guard let root = numberList(c["root"]), let local = numberList(c["local"]) else {
                    throw Failure(description: "scene/\(name): malformed parentframe case")
                }
                try close(ScenePhysics.toLocal(root, parentWorld: parentWorld), local, "toLocal", name)
                if (c["noRoundTrip"] as? Bool) != true {
                    try close(ScenePhysics.toRoot(local, parentWorld: parentWorld), root, "toRoot", name)
                }
            case "orientationframe":
                let spec = c["parent"] as? [String: Any]
                let parentWorld: [Double]? = spec.flatMap { p -> [Double]? in
                    guard let position = numberList(p["position"]),
                          let rotation = numberList(p["rotation"]),
                          let scale = numberList(p["scale"]) else { return nil }
                    return SceneMath.trs(position: position, rotationDeg: rotation, scale: scale)
                }
                guard let local = numberList(c["localRotation"]),
                      let root = numberList(c["rootRotation"]) else {
                    throw Failure(description: "scene/\(name): malformed orientationframe case")
                }
                try close(ScenePhysics.rotationToRoot(
                    local, parentWorld: parentWorld, reference: root), root, "rotationToRoot", name)
                if (c["noRoundTrip"] as? Bool) != true {
                    let expectedLocal = numberList(c["localRoundTrip"]) ?? local
                    try close(ScenePhysics.rotationToLocal(
                        root, parentWorld: parentWorld, reference: expectedLocal),
                              expectedLocal, "rotationToLocal", name)
                }
            case "interpolate":
                guard let prev = numberList(c["prev"]), let curr = numberList(c["curr"]),
                      let alpha = JSE.number(c["alpha"]), let expect = numberList(c["expect"]) else {
                    throw Failure(description: "scene/\(name): malformed interpolate case")
                }
                try close(ScenePhysics.interpolate(prev: prev, curr: curr, alpha: alpha),
                          expect, "interpolated", name)
            default:
                throw Failure(description: "scene/\(name): unknown physics case kind")
            }
        }
        return cases.count + 1   // the sim/world cases + the constants lane (the TS runner's count)
    }

    // ── prefab.json — components as prefabs inside <scene> subtrees (dsx-game.md G1) ─

    /// the case's component table as a prefab lookup: templates parse through StackXML —
    /// this renderer's OWN parser (the corpus law: never a second one); explicit
    /// `params` override the template-derived declaration (the web ComponentIR shape);
    /// a per-component `components` sub-table becomes the def's OWN lookup (the
    /// defining-scope law).
    private static func prefabLookupOver(_ table: [String: Any], _ name: String) throws -> ScenePrefabLookup {
        var defs: [String: ScenePrefabDef] = [:]
        for (tag, entryRaw) in table {
            guard let entry = entryRaw as? [String: Any],
                  let source = entry["template"] as? String,
                  let template = StackXML.parse(source) else {
                throw Failure(description: "scene/\(name): prefab template for '\(tag)' does not parse")
            }
            let derived = SceneIRKit.scenePrefabDefFromTemplate(template)
            var def: ScenePrefabDef
            if let params = entry["params"] as? [[String: Any]] {
                def = ScenePrefabDef(
                    params: params.map { ScenePrefabParam(name: JSE.string($0["name"]), default: $0["default"] as? String) },
                    roots: derived.roots)
            } else {
                def = derived
            }
            if let nested = entry["components"] as? [String: Any] {
                def.lookup = try prefabLookupOver(nested, name)
            }
            defs[tag] = def
        }
        return { tag in defs[tag] }
    }

    private static func prefabLookup(_ c: [String: Any], _ name: String) throws -> ScenePrefabLookup {
        try prefabLookupOver((c["components"] as? [String: Any]) ?? [:], name)
    }

    private static func prefabNodeAtPath(_ nodes: [SceneNode], _ path: [Int], _ name: String) throws -> SceneNode {
        var list = nodes
        var node: SceneNode?
        for index in path {
            guard index >= 0, index < list.count else {
                throw Failure(description: "scene/\(name): path \(path) does not resolve")
            }
            node = list[index]
            list = node?.children ?? []
        }
        guard let node else { throw Failure(description: "scene/\(name): empty world path") }
        return node
    }

    private static func verifyPrefab(corpusFile: URL) throws -> Int {
        let cases = try loadCases(corpusFile)
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            var diagnostics: [SceneDiagnostic] = []
            let diag: (SceneDiagnostic) -> Void = { diagnostics.append($0) }
            let lookup = try prefabLookup(c, name)
            guard let markupSource = c["markup"] as? String, let markup = StackXML.parse(markupSource) else {
                throw Failure(description: "scene/\(name): markup did not parse")
            }
            let ir = SceneIRKit.parseScene(markup, diag: diag, prefabs: lookup)
            let vars = (c["vars"] as? [String: Any]) ?? [:]
            let outer: (String) -> Any? = { vars[$0] }

            if let rows = c["rows"] as? [String: Any] {
                // the keyed-spawn leg (the instantiation law): rows of prefab instances
                // at the IR plane — fresh identity per spawn, the prefab stamp preserved,
                // item.* resolving through the per-instance scope at the instance site.
                guard let group = ir.nodes.first(where: { $0.kind == "group" && $0.attrs["bind"] != nil }) else {
                    throw Failure(description: "scene/\(name): no bound group")
                }
                let template = group.children
                guard let templateRoot = template.first, templateRoot.prefab != nil else {
                    throw Failure(description: "scene/\(name): the template child is not a prefab expansion root")
                }
                guard let expect = rows["expect"] as? [String: Any] else {
                    throw Failure(description: "scene/\(name): rows without expect{}")
                }
                let keyField = group.attrs["key"] ?? "id"
                let firstRows = SceneBind.rows(rows["first"], keyField: keyField, diag)
                guard firstRows.map(\.key) == stringList(expect["firstKeys"]) else {
                    throw Failure(description: "scene/\(name): first keys \(firstRows.map(\.key)) (expected \(stringList(expect["firstKeys"])))")
                }
                var instances: [(nodes: [SceneNode], resolve: SceneResolve)] = []
                for row in firstRows {
                    let nodes = SceneBind.instantiateRow(template)
                    guard let instanceRoot = nodes.first, instanceRoot !== templateRoot,
                          instanceRoot.prefab != nil else {
                        throw Failure(description: "scene/\(name): instantiation lost identity or the prefab stamp")
                    }
                    let rowEval: (String) -> Any? = { expr in
                        if expr.hasPrefix("item.") { return (row.item as? [String: Any])?[String(expr.dropFirst(5))] }
                        return outer(expr)
                    }
                    instances.append((nodes, SceneIRKit.scenePrefabResolver(nodes, rowEval)))
                }
                if instances.count > 1, instances[0].nodes.first === instances[1].nodes.first {
                    throw Failure(description: "scene/\(name): instances share node identity")
                }
                for (i, want) in (numberList(expect["radius"]) ?? []).enumerated() {
                    guard i < instances.count, let sphere = instances[i].nodes.first?.children.first else {
                        throw Failure(description: "scene/\(name): row[\(i)] has no body node")
                    }
                    let props = SceneIRKit.resolvedProps(sphere, instances[i].resolve, diag)
                    try close([props.radius], [want], "row[\(i)].radius", name)
                }
                let diffResult = SceneBind.diff(previous: firstRows.map(\.key),
                                                next: SceneBind.rows(rows["next"], keyField: keyField, diag))
                guard diffResult.removed == stringList(expect["nextRemoved"]),
                      diffResult.retained == stringList(expect["nextRetained"]) else {
                    throw Failure(description: "scene/\(name): diff removed \(diffResult.removed) retained \(diffResult.retained)")
                }
            } else {
                let resolver = SceneIRKit.scenePrefabResolver(ir.nodes, outer)
                if let expect = c["expect"] as? [String: Any], let nodes = expect["nodes"] as? [[String: Any]] {
                    try checkNodes(ir.nodes, nodes, "nodes", name, resolver, diag)
                }
                for w in (c["worlds"] as? [[String: Any]]) ?? [] {
                    let worlds = SceneIRKit.worldMatrices(ir.nodes, resolver, diag)
                    let target: SceneNode
                    if let id = w["node"] as? String {
                        guard let found = SceneIRKit.findSceneNode(ir.nodes, id: id) else {
                            throw Failure(description: "scene/\(name): world target '\(id)' not found")
                        }
                        target = found
                    } else {
                        let path = ((w["path"] as? [Any]) ?? []).compactMap { (v: Any) -> Int? in
                            guard let n = JSE.number(v) else { return nil }
                            return Int(n)
                        }
                        target = try prefabNodeAtPath(ir.nodes, path, name)
                    }
                    guard let entry = worlds.first(where: { $0.node === target }) else {
                        throw Failure(description: "scene/\(name): no world matrix for the target")
                    }
                    try close(entry.world, numberList(w["world"]) ?? [], "world", name)
                    if let point = w["point"] as? [String: Any] {
                        guard let local = numberList(point["local"]), local.count == 3 else {
                            throw Failure(description: "scene/\(name): malformed point")
                        }
                        let m = entry.world
                        try close([
                            m[0] * local[0] + m[4] * local[1] + m[8] * local[2] + m[12],
                            m[1] * local[0] + m[5] * local[1] + m[9] * local[2] + m[13],
                            m[2] * local[0] + m[6] * local[1] + m[10] * local[2] + m[14],
                        ], numberList(point["world"]) ?? [], "point", name)
                    }
                }
            }
            let expectedDiags = (c["diagnostics"] as? NSNumber)?.intValue ?? 0
            guard diagnostics.count == expectedDiags else {
                throw Failure(description: "scene/\(name): \(diagnostics.count) diagnostic(s) (expected \(expectedDiags)): \(diagnostics.map(\.message))")
            }
        }
        return cases.count
    }
}

// MARK: - the legacy verb corpus (legacy/verbs.json)

/// THE NATIVE LEGACY-CORPUS RUNNER (proposals/legacy-package.md §follow-ups — "a native
/// (Swift/Kotlin) corpus runner is a ledgered follow-up"), the Swift reference leg.
///
/// The v3 API is a CLOSED FINITE set: every verb is a declared `facets.legacy` row, the
/// aggregate generates into `LegacyMap.generated.swift/.kt`, and the native routers
/// (`Legacy.swift` / `Legacy.kt`) only ever do FOUR pure things with a v3 string —
///   1. `verb(of:)`      split the known "<verb>://" prefix, lowercased (no URL parsing),
///   2. `tail(of:)`      take the VERBATIM remainder (never decoded, never split),
///   3. `arguments(...)` fill the declared args template ($tail → the tail, $url → the
///                       whole string, anything else a literal),
///   4. `pick(_:spec:)`  resolve the declared response `value` ($data, or a dotted
///                       $data.path) out of the resolve payload.
/// Everything else is a dictionary lookup in the generated table. This runner replays the
/// corpus through exactly that fold and asserts each `calls` spelling lands on its own row
/// with the declared args and response — the leg the corpus `_note` named as missing.
///
/// DECLARED DIVERGENCE (why the fold is restated here rather than imported): the recorder
/// lane compiles the OPEN kernel only (`record_jse_conformance.sh` globs
/// OpenSource/Engine/iOS), and `Legacy.swift` is a closed MODULE facet plus a GENERATED
/// table, so neither is in this binary. The four functions below are therefore the
/// REFERENCE spelling of the router contract, kept byte-for-byte in step with
/// `Legacy.verb/tail/arguments/pick` (and their `Legacy.kt` twins) — the same
/// reference-implementation relationship the jse corpus has with the Swift kernel. The
/// TABLE itself is not restated: `dsx_graph_test.rb` already pins tree-declarations ==
/// corpus in both directions, so this runner takes the corpus AS the table.
///
/// The Kotlin twin (`:app` test source set) stays the one open leg of the follow-up.
enum LegacyConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    // MARK: the router fold (the reference spelling — Legacy.swift / Legacy.kt twins)

    /// The verb of a v3 string: everything before "://", lowercased ("" when absent).
    static func verb(of raw: String) -> String {
        guard let r = raw.range(of: "://") else { return "" }
        return String(raw[raw.startIndex..<r.lowerBound]).lowercased()
    }

    /// The verbatim tail after "<verb>://" — never decoded, never split further.
    static func tail(of raw: String) -> String {
        guard let r = raw.range(of: "://") else { return "" }
        return String(raw[r.upperBound...])
    }

    /// The declared args template: $tail → the verbatim tail, $url → the whole string,
    /// anything else a literal.
    static func arguments(_ template: [String: String], raw: String, tail: String) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in template {
            switch value {
            case "$tail": out[key] = tail
            case "$url":  out[key] = raw
            default:      out[key] = value
            }
        }
        return out
    }

    /// `$data` (or a dotted `$data.path`) picks from the resolve payload; anything else
    /// passes as a literal.
    static func pick(_ data: Any?, spec: String?) -> Any? {
        guard let spec, spec != "$data" else { return data }
        guard spec.hasPrefix("$data.") else { return spec }
        var value: Any? = data
        for segment in spec.dropFirst("$data.".count).split(separator: ".") {
            value = (value as? [String: Any])?[String(segment)]
        }
        return value
    }

    // MARK: the corpus walk

    /// Run OpenSource/Conformance/legacy/verbs.json through the fold above. Returns the number
    /// of verb fixtures verified; throws on the first disagreement (or a malformed corpus — a
    /// silently-skipped suite is how drift starts).
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let verbs = doc["verbs"] as? [String: Any], !verbs.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no verbs{}")
        }

        for name in verbs.keys.sorted() {
            guard let fixture = verbs[name] as? [String: Any] else {
                throw Failure(description: "legacy/\(name): fixture is not an object")
            }
            guard let route = fixture["route"] as? [String: Any] else {
                throw Failure(description: "legacy/\(name): no route{}")
            }
            let chain = JSE.string(route["chain"])
            let action = JSE.string(route["action"])
            guard !chain.isEmpty, !action.isEmpty else {
                throw Failure(description: "legacy/\(name): route needs a non-empty chain + action")
            }
            var template: [String: String] = [:]
            for (k, v) in (route["args"] as? [String: Any]) ?? [:] { template[k] = JSE.string(v) }
            // The args grammar is CLOSED: $tail · $url · a literal. An unknown "$…" would fall
            // through the fold as a literal (both routers' `default:` arm), which is exactly the
            // silent-drift class prepare aborts on — pin it natively too.
            for (key, value) in template where value.hasPrefix("$") {
                guard value == "$tail" || value == "$url" else {
                    throw Failure(description: "legacy/\(name): arg \(key) uses unknown substitution \(value) (known: $tail · $url)")
                }
            }

            // The key IS the wire spelling: a router only ever matches a "<key>://…" string.
            guard verb(of: "\(name)://") == name else {
                throw Failure(description: "legacy/\(name): the corpus key is not a routable url-scheme token")
            }

            // Every `calls` line that quotes a real "<verb>://…" spelling must fold onto THIS
            // row: same verb, and the declared args filled from that string's verbatim tail.
            // (Dot-form lines carry no "://" and are the shim harness's plane, not the router's.)
            var routable = 0
            for call in (fixture["calls"] as? [Any]) ?? [] {
                let line = JSE.string(call)
                guard let range = line.range(of: "\(name)://") else { continue }
                // The literal spelling inside the doc line: from the verb to the first quote,
                // space or end — the corpus writes them as `verb://<tail>` inside prose.
                let spelling = String(line[range.lowerBound...])
                    .prefix { $0 != "\"" && $0 != " " && $0 != ")" }
                let raw = String(spelling)
                routable += 1
                guard verb(of: raw) == name else {
                    throw Failure(description: "legacy/\(name): \(raw) folds to verb \(verb(of: raw))")
                }
                let filled = arguments(template, raw: raw, tail: tail(of: raw))
                guard filled.keys.sorted() == template.keys.sorted() else {
                    throw Failure(description: "legacy/\(name): args \(filled.keys.sorted()) (expected \(template.keys.sorted()))")
                }
                for (key, value) in template {
                    let want = value == "$tail" ? tail(of: raw) : (value == "$url" ? raw : value)
                    guard filled[key] == want else {
                        throw Failure(description: "legacy/\(name): arg \(key) = \(filled[key] ?? "nil") (expected \(want))")
                    }
                }
            }
            guard routable > 0 else {
                throw Failure(description: "legacy/\(name): no `calls` line carries the \(name):// wire spelling")
            }

            // The declared RESPONSE convention: `value` must pick out of a resolve payload the
            // way the routers' deliverResponse does before it hands the value to dom.set/dom.call.
            if let response = fixture["response"] as? [String: Any] {
                let global = JSE.string(response["global"])
                let callback = JSE.string(response["callback"])
                guard !global.isEmpty || !callback.isEmpty else {
                    throw Failure(description: "legacy/\(name): a response convention needs a global and/or a callback")
                }
                let spec = response["value"].map { JSE.string($0) }
                if spec == nil || spec == "$data" {
                    // The WHOLE resolve payload goes to the global/callback, untouched.
                    let probe: [String: Any] = ["marker": "whole-payload"]
                    guard let whole = pick(probe, spec: spec) as? [String: Any],
                          whole["marker"] as? String == "whole-payload" else {
                        throw Failure(description: "legacy/\(name): $data must pick the WHOLE resolve payload")
                    }
                } else if let spec, spec.hasPrefix("$data.") {
                    // Plant a leaf at exactly the declared path and require the walk to find it.
                    let segments = spec.dropFirst("$data.".count).split(separator: ".").map(String.init)
                    guard !segments.isEmpty else {
                        throw Failure(description: "legacy/\(name): response value \(spec) names an empty path")
                    }
                    var probe: Any = "planted-leaf"
                    for segment in segments.reversed() { probe = [segment: probe] }
                    guard pick(probe, spec: spec) as? String == "planted-leaf" else {
                        throw Failure(description: "legacy/\(name): response value \(spec) did not walk the payload (got \(String(describing: pick(probe, spec: spec))))")
                    }
                } else {
                    throw Failure(description: "legacy/\(name): response value must be $data or a dotted $data.path")
                }
            }
        }

        // The CLOSED-SET law: a spelling nobody declares is never in the table, so the routers
        // decline it (nil claim / ignored dispatch) instead of parsing it.
        guard verbs["zz-nobody-owns-this"] == nil, verb(of: "no-scheme-here") == "" else {
            throw Failure(description: "legacy: the closed-set guard fixtures drifted")
        }
        return verbs.count
    }
}

/// The SOFT-KEYBOARD VIEWPORT corpus (OpenSource/Conformance/keyboard/viewport.json) against the
/// Swift twin. The TS and Kotlin runners execute the same file; this lane is the reference.
///
/// The rule worth restating, because it is the one that makes a page portable across modes:
/// `insetHeight` reports what the keyboard obscures OF THE LAYOUT VIEWPORT, not how tall the
/// keyboard is. Under `.resize` the viewport has already shrunk, so the answer is 0 — publishing
/// the raw height there would double-count and push content off screen — while `boundingRect`
/// stays real, because it answers the different question of where the keyboard is.
enum KeyboardViewportConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }

        for c in cases {
            let name = c["name"] as? String ?? "?"
            guard let keyboard = c["keyboard"] as? [String: Any],
                  let viewport = c["viewport"] as? [String: Any],
                  let expect = c["expect"] as? [String: Any],
                  let rect = expect["boundingRect"] as? [String: Any] else {
                throw Failure(description: "\(name): malformed case")
            }

            let got = KeyboardViewport.resolve(
                declared: c["declared"] as? String,
                platform: c["platform"] as? String ?? "",
                api: (c["api"] as? NSNumber)?.intValue,
                keyboardVisible: keyboard["visible"] as? Bool ?? false,
                keyboardHeight: (keyboard["height"] as? NSNumber)?.intValue ?? 0,
                viewportWidth: (viewport["width"] as? NSNumber)?.intValue ?? 0,
                viewportHeight: (viewport["height"] as? NSNumber)?.intValue ?? 0,
                requested: c["requested"] as? Bool
            )

            func check(_ label: String, _ actual: String, _ wanted: String) throws {
                guard actual == wanted else {
                    throw Failure(description: "\(name) — \(label): got \(actual), want \(wanted)")
                }
            }
            try check("mode", got.mode.rawValue, expect["mode"] as? String ?? "")
            try check("degraded", String(got.degraded), String(expect["degraded"] as? Bool ?? false))
            try check("insetHeight", String(got.insetHeight),
                      String((expect["insetHeight"] as? NSNumber)?.intValue ?? -1))
            try check("overlaysContent", String(got.overlaysContent),
                      String(expect["overlaysContent"] as? Bool ?? false))
            let wantRect = KeyboardRect(
                x: (rect["x"] as? NSNumber)?.intValue ?? -1,
                y: (rect["y"] as? NSNumber)?.intValue ?? -1,
                width: (rect["width"] as? NSNumber)?.intValue ?? -1,
                height: (rect["height"] as? NSNumber)?.intValue ?? -1
            )
            guard got.boundingRect == wantRect else {
                throw Failure(description: "\(name) — boundingRect: got \(got.boundingRect), want \(wantRect)")
            }
        }
        return cases.count
    }
}

/// The FILE-INPUT ROUTING corpus (OpenSource/Conformance/upload/routing.json) against the Swift
/// twin. The TS and Kotlin runners execute the same file; this lane is the reference.
///
/// The case worth restating: `accept="image/*"` with `capture` must open a STILLS-ONLY camera. The
/// media-type array, not the capture mode, is what draws the PHOTO/VIDEO toggle — which is how a
/// stills-only page ended up being handed a `.mov` despite the mode being correctly pinned.
enum UploadRoutingConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }

        for c in cases {
            let name = c["name"] as? String ?? "?"
            guard let expect = c["expect"] as? [String: Any],
                  let wantRoute = expect["route"] as? String else {
                throw Failure(description: "\(name): malformed case")
            }
            let got = DSXFileUploadPolicy.route(
                accept: c["accept"] as? String,
                capture: c["capture"] as? String,
                nativeInterception: c["nativeInterception"] as? Bool ?? true
            )

            func scopeWord(_ scope: DSXCameraMediaScope) -> String {
                switch scope {
                case .imagesOnly: return "imagesOnly"
                case .videosOnly: return "videosOnly"
                case .both: return "both"
                }
            }
            func fail(_ detail: String) -> Failure { Failure(description: "\(name) — \(detail)") }

            switch got {
            case .camera(let front, let scope):
                guard wantRoute == "camera" else { throw fail("got camera, want \(wantRoute)") }
                guard front == (expect["front"] as? Bool ?? !front) else { throw fail("front") }
                guard scopeWord(scope) == expect["scope"] as? String else { throw fail("scope \(scopeWord(scope))") }
            case .photoLibrary(let scope):
                guard wantRoute == "photoLibrary" else { throw fail("got photoLibrary, want \(wantRoute)") }
                guard scopeWord(scope) == expect["scope"] as? String else { throw fail("scope \(scopeWord(scope))") }
            case .documents(let types):
                guard wantRoute == "documents" else { throw fail("got documents, want \(wantRoute)") }
                guard types == (expect["types"] as? [String] ?? []) else { throw fail("types \(types)") }
            case .sourceSheet:
                guard wantRoute == "sourceSheet" else { throw fail("got sourceSheet, want \(wantRoute)") }
            }
        }
        return cases.count
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// SPRITE — OpenSource/Conformance/scene/sprite.json through the REAL Swift G6 kernel
// (SceneSprite + the SceneIR sprite props + the ScenePhysics z-lock). The TS reference
// and the Kotlin twin (:core spriteCorpus) run the SAME file.

extension SceneConformance {

    /// The G6 2D lane: the sprite quad (anchor/flip/texture-aspect size), the sheet UV
    /// rectangle per frame index, the frame grammar + Article-7 clamp, the fps→index
    /// fold, the 2D conventions (a 2-number `position`, the draw order), the extracted
    /// sprite colliders and the Z-LOCK simulations. Returns the case count + 1 (the
    /// constants lane — the physics runner's shape).
    static func verifySprite(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty,
              let constants = doc["constants"] as? [String: Any] else {
            throw Failure(description: "sprite.json: malformed corpus")
        }
        // the pinned constants match the kernel statics (the physics runner's pattern)
        let constantChecks: [(String, Double)] = [
            ("defaultHeight", SceneSprite.defaultHeight),
            ("colliderHalfZ", ScenePhysics.spriteColliderHalfZ),
        ]
        for (key, value) in constantChecks {
            guard let pinned = JSE.number(constants[key]), abs(pinned - value) <= tolerance else {
                throw Failure(description: "sprite constants: \(key) drifted (kernel \(value))")
            }
        }
        guard JSE.string(constants["defaultAnchor"]) == SceneIRKit.spriteDefaultAnchor,
              (constants["defaultLoop"] as? Bool) == true else {
            throw Failure(description: "sprite constants: defaultAnchor/defaultLoop drifted")
        }
        guard let anchors = constants["anchors"] as? [String: Any],
              anchors.count == SceneIRKit.spriteAnchors.count else {
            throw Failure(description: "sprite constants: anchor word set drifted")
        }
        for (word, raw) in anchors {
            guard let want = numberList(raw), let got = SceneIRKit.spriteAnchors[word] else {
                throw Failure(description: "sprite constants: anchor '\(word)' missing")
            }
            try close(got, want, "anchor \(word)", "constants")
        }

        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            var diagnostics: [SceneDiagnostic] = []
            let diag: (SceneDiagnostic) -> Void = { diagnostics.append($0) }
            let vars = (c["vars"] as? [String: Any]) ?? [:]
            let expectedDiags = (c["diagnostics"] as? NSNumber)?.intValue ?? 0

            func spriteProps() -> SceneNodeProps {
                let attrs = ((c["attrs"] as? [String: Any]) ?? [:]).mapValues { JSE.string($0) }
                let node = SceneNode(kind: "sprite", id: nil, attrs: attrs, children: [], mode2d: true)
                return SceneIRKit.resolvedProps(node, mapResolver(vars), diag)
            }
            func checkDiagnostics() throws {
                guard diagnostics.count == expectedDiags else {
                    throw Failure(description: "sprite/\(name): \(diagnostics.count) diagnostic(s) (expected \(expectedDiags)): \(diagnostics.map(\.message))")
                }
            }

            switch JSE.string(c["kind"]) {
            case "quad":
                let props = spriteProps()
                let aspect = JSE.number(c["aspect"])
                let quad = SceneSprite.quad(props, aspect)
                guard let want = c["expect"] as? [String: Any], let offset = numberList(want["offset"]),
                      let halfWidth = JSE.number(want["halfWidth"]),
                      let halfHeight = JSE.number(want["halfHeight"]) else {
                    throw Failure(description: "sprite/\(name): malformed quad expectation")
                }
                try close(quad.center, offset, "quad center offset", name)
                try close([quad.halfWidth, quad.halfHeight], [halfWidth, halfHeight], "quad half extents", name)
                let size = SceneSprite.sizeOf(props, aspect)
                try close([size[0] / 2, size[1] / 2], [halfWidth, halfHeight], "spriteSizeOf", name)
                try checkDiagnostics()
            case "uv":
                let props = spriteProps()
                guard let want = numberList(c["expect"]) else {
                    throw Failure(description: "sprite/\(name): malformed uv expectation")
                }
                try close(SceneSprite.uvRect(props, props.spriteFrame), want, "uv rect", name)
                try close(SceneSprite.quad(props).uv, want, "quad.uv", name)
                try checkDiagnostics()
            case "sheet":
                let props = spriteProps()
                guard let want = c["expect"] as? [String: Any],
                      let cols = (want["cols"] as? NSNumber)?.intValue,
                      let rows = (want["rows"] as? NSNumber)?.intValue,
                      let total = (want["total"] as? NSNumber)?.intValue,
                      let frame = (want["frame"] as? NSNumber)?.intValue else {
                    throw Failure(description: "sprite/\(name): malformed sheet expectation")
                }
                guard props.spriteFrames == [cols, rows], SceneSprite.frameCount(props) == total,
                      props.spriteFrame == frame else {
                    throw Failure(description: "sprite/\(name): sheet \(props.spriteFrames) frame \(props.spriteFrame)")
                }
                try checkDiagnostics()
            case "fps":
                let props = spriteProps()
                for sample in (c["samples"] as? [[String: Any]]) ?? [] {
                    guard let elapsed = JSE.number(sample["elapsed"]),
                          let frame = (sample["frame"] as? NSNumber)?.intValue else {
                        throw Failure(description: "sprite/\(name): malformed fps sample")
                    }
                    let got = SceneSprite.frameAt(props, elapsed)
                    guard got == frame else {
                        throw Failure(description: "sprite/\(name): frame @\(elapsed)s = \(got) (expected \(frame))")
                    }
                }
                try checkDiagnostics()
            case "order":
                guard let zs = numberList(c["z"]), let want = c["expect"] as? [Any] else {
                    throw Failure(description: "sprite/\(name): malformed order case")
                }
                let got = SceneSprite.drawOrder2d(zs)
                guard got == want.map({ ($0 as? NSNumber)?.intValue ?? -1 }) else {
                    throw Failure(description: "sprite/\(name): draw order \(got)")
                }
            case "parse":
                guard let markupSource = c["markup"] as? String, let markup = StackXML.parse(markupSource) else {
                    throw Failure(description: "sprite/\(name): markup did not parse")
                }
                let ir = SceneIRKit.parseScene(markup, diag: diag)
                let resolve = mapResolver(vars)
                let want = (c["expect"] as? [String: Any]) ?? [:]
                if let mode = want["mode"] as? String, ir.mode != mode {
                    throw Failure(description: "sprite/\(name): mode \(ir.mode) (expected \(mode))")
                }
                for (i, expected) in ((want["nodes"] as? [[String: Any]]) ?? []).enumerated() {
                    guard i < ir.nodes.count else {
                        throw Failure(description: "sprite/\(name): nodes[\(i)] missing")
                    }
                    let node = ir.nodes[i]
                    guard node.kind == JSE.string(expected["kind"]) else {
                        throw Failure(description: "sprite/\(name): nodes[\(i)].kind \(node.kind)")
                    }
                    let props = SceneIRKit.resolvedProps(node, resolve, diag)
                    if let v = numberList(expected["position"]) { try close(props.position, v, "nodes[\(i)].position", name) }
                    if let v = numberList(expected["rotation"]) { try close(props.rotation, v, "nodes[\(i)].rotation", name) }
                    if let v = numberList(expected["scale"]) { try close(props.scale, v, "nodes[\(i)].scale", name) }
                    if let v = numberList(expected["spriteSize"]) { try close(props.spriteSize, v, "nodes[\(i)].spriteSize", name) }
                    if let v = numberList(expected["frames"]) {
                        try close(props.spriteFrames.map(Double.init), v, "nodes[\(i)].frames", name)
                    }
                    if let v = (expected["frame"] as? NSNumber)?.intValue, props.spriteFrame != v {
                        throw Failure(description: "sprite/\(name): nodes[\(i)].frame \(props.spriteFrame)")
                    }
                    if let v = JSE.number(expected["fps"]) { try close([props.spriteFps], [v], "nodes[\(i)].fps", name) }
                    if let v = expected["loop"] as? Bool, props.spriteLoop != v {
                        throw Failure(description: "sprite/\(name): nodes[\(i)].loop \(props.spriteLoop)")
                    }
                    for (key, actual) in [("anchor", props.spriteAnchor), ("flip", props.spriteFlip),
                                          ("src", props.src), ("color", props.color)] {
                        if let v = expected[key] as? String, actual != v {
                            throw Failure(description: "sprite/\(name): nodes[\(i)].\(key) \(actual) (expected \(v))")
                        }
                    }
                }
                for w in (c["worlds"] as? [[String: Any]]) ?? [] {
                    guard let id = w["node"] as? String, let wantWorld = numberList(w["world"]) else {
                        throw Failure(description: "sprite/\(name): malformed world expectation")
                    }
                    let walked = SceneIRKit.worldMatrices(ir.nodes, resolve, diag)
                    guard let entry = walked.first(where: { $0.node.id == id }) else {
                        throw Failure(description: "sprite/\(name): world target '\(id)' missing")
                    }
                    try close(entry.world, wantWorld, "world(\(id))", name)
                }
                try checkDiagnostics()
            case "physics-world":
                guard let markupSource = c["markup"] as? String, let markup = StackXML.parse(markupSource) else {
                    throw Failure(description: "sprite/\(name): markup did not parse")
                }
                let ir = SceneIRKit.parseScene(markup, diag: diag)
                let extraction = ScenePhysics.extract(ir, mapResolver(vars), diag)
                guard let want = c["expect"] as? [String: Any], let wantGravity = numberList(want["gravity"]),
                      let wantMode2d = want["mode2d"] as? Bool,
                      let wantBodies = want["bodies"] as? [[String: Any]] else {
                    throw Failure(description: "sprite/\(name): malformed physics-world expectation")
                }
                try close(extraction.gravity, wantGravity, "gravity", name)
                guard extraction.mode2d == wantMode2d else {
                    throw Failure(description: "sprite/\(name): mode2d \(extraction.mode2d)")
                }
                let world = ScenePhysics.createWorld(gravity: extraction.gravity, specs: extraction.bodies,
                                                    mode2d: extraction.mode2d)
                guard world.mode2d == wantMode2d, world.bodies.count == wantBodies.count else {
                    throw Failure(description: "sprite/\(name): \(world.bodies.count) bodies (expected \(wantBodies.count))")
                }
                for (i, w) in wantBodies.enumerated() {
                    let body = world.bodies[i]
                    guard body.id == JSE.string(w["id"]), body.kind == JSE.string(w["kind"]),
                          body.shape == JSE.string(w["shape"]) else {
                        throw Failure(description: "sprite/\(name): [\(i)] \(body.id) \(body.kind) \(body.shape)")
                    }
                    if body.shape == "sphere" {
                        guard let radius = JSE.number(w["radius"]) else {
                            throw Failure(description: "sprite/\(name): [\(i)] no radius")
                        }
                        try close([body.radius], [radius], "[\(i)].radius", name)
                    } else {
                        guard let half = numberList(w["half"]) else {
                            throw Failure(description: "sprite/\(name): [\(i)] no half")
                        }
                        try close(body.half, half, "[\(i)].half", name)
                    }
                    guard let position = numberList(w["position"]), let velocity = numberList(w["velocity"]),
                          let invMass = JSE.number(w["invMass"]) else {
                        throw Failure(description: "sprite/\(name): [\(i)] malformed body expectation")
                    }
                    try close(body.position, position, "[\(i)].position", name)
                    try close(body.velocity, velocity, "[\(i)].velocity", name)
                    try close([body.invMass], [invMass], "[\(i)].invMass", name)
                }
                try checkDiagnostics()
            default:
                // physics-sim: the physics.json driver shape plus the mode2d flag
                let gravity = numberList(c["gravity"]) ?? [0, -9.81, 0]
                let specs = try ((c["bodies"] as? [[String: Any]]) ?? []).map { try physicsBodySpec($0, name) }
                let mode2d = (c["mode2d"] as? Bool) == true
                let world = ScenePhysics.createWorld(gravity: gravity, specs: specs, mode2d: mode2d)
                let samples = (c["samples"] as? [[String: Any]]) ?? []
                var wanted: [Int: [String]] = [:]
                for sample in samples {
                    guard let tick = (sample["tick"] as? NSNumber)?.intValue,
                          let id = sample["id"] as? String else {
                        throw Failure(description: "sprite/\(name): malformed sample spec")
                    }
                    wanted[tick, default: []].append(id)
                }
                var recorded: [String: (position: [Double], velocity: [Double], grounded: Bool, sleeping: Bool)] = [:]
                for n in 0..<((c["ticks"] as? NSNumber)?.intValue ?? 0) {
                    for w in (c["writes"] as? [[String: Any]]) ?? [] {
                        guard (w["tick"] as? NSNumber)?.intValue == n,
                              let id = w["id"] as? String, let value = numberList(w["value"]) else { continue }
                        if JSE.string(w["attr"]) == "velocity" { ScenePhysics.writeVelocity(world, id: id, value) }
                        else { ScenePhysics.teleport(world, id: id, value) }
                    }
                    _ = ScenePhysics.step(world, intents: [:])
                    for id in wanted[n] ?? [] {
                        guard let body = world.byId[id] else {
                            throw Failure(description: "sprite/\(name): sample body '\(id)' missing")
                        }
                        recorded["\(n):\(id)"] = (position: body.position, velocity: body.velocity,
                                                  grounded: body.grounded, sleeping: body.sleeping)
                    }
                }
                for want in samples {
                    guard let tick = (want["tick"] as? NSNumber)?.intValue, let id = want["id"] as? String,
                          let position = numberList(want["position"]), let velocity = numberList(want["velocity"]),
                          let grounded = want["grounded"] as? Bool, let sleeping = want["sleeping"] as? Bool,
                          let got = recorded["\(tick):\(id)"] else {
                        throw Failure(description: "sprite/\(name): malformed/missing sample")
                    }
                    try close(got.position, position, "@\(tick) \(id) position", name)
                    try close(got.velocity, velocity, "@\(tick) \(id) velocity", name)
                    guard got.grounded == grounded, got.sleeping == sleeping else {
                        throw Failure(description: "sprite/\(name): @\(tick) \(id) grounded/sleeping")
                    }
                }
                // THE Z-LOCK LAW as an invariant, not only as pinned samples
                if mode2d {
                    for body in world.bodies {
                        guard body.position[2] == body.zLock, body.previous[2] == body.zLock,
                              body.velocity[2] == body.vzLock else {
                            throw Failure(description: "sprite/\(name): \(body.id) drifted off its z-lock")
                        }
                    }
                }
            }
        }
        return cases.count + 1   // the cases + the constants lane (the physics shape)
    }
}

// SkinConformance — OpenSource/Conformance/scene/skin.json through the REAL Swift G3
// skeletal kernel (SceneGltf skins/clips/JOINTS_0/WEIGHTS_0 + SceneSkin joint matrices ·
// vertex skinning · clip sampling · crossfade · the SceneClipMixer state machine), the
// dsx-game.md §2 G3 record-lane leg. The TS reference (scene-conformance.test.ts) and
// the Kotlin twin (:core SceneConformanceTest skinCorpus) run the SAME file, so the
// three implementations cannot drift on a single blended quaternion. `props` cases
// drive markup through StackXML — this renderer's OWN parser (never a second one) —
// into parseScene + resolvedProps. Floats compare at the corpus tolerance (6 decimals,
// 1.5e-6). Returns the number of cases verified (+1 for the constants gate); throws on
// the first mismatch.
// ═══════════════════════════════════════════════════════════════════════════════════════

enum SkinConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    private static let tolerance = 1.5e-6

    private static func numberList(_ raw: Any?) -> [Double]? {
        guard let list = raw as? [Any] else { return nil }
        var out: [Double] = []
        for v in list {
            guard let n = JSE.number(v) else { return nil }
            out.append(n)
        }
        return out
    }

    private static func intList(_ raw: Any?) -> [Int]? {
        numberList(raw).map { $0.map { Int($0) } }
    }

    private static func close(_ actual: [Double], _ expected: [Double], _ label: String, _ name: String) throws {
        guard actual.count == expected.count else {
            throw Failure(description: "skin/\(name): \(label) has \(actual.count) numbers (expected \(expected.count))")
        }
        for i in 0..<expected.count where abs(actual[i] - expected[i]) > tolerance {
            throw Failure(description: "skin/\(name): \(label)[\(i)] = \(actual[i]) (expected \(expected[i]))")
        }
    }

    private static func skinNodes(_ raw: [[String: Any]]) -> [GlbNode] {
        raw.map { n in
            GlbNode(
                translation: numberList(n["translation"]) ?? [0, 0, 0],
                rotation: numberList(n["rotation"]) ?? [0, 0, 0, 1],
                scale: numberList(n["scale"]) ?? [1, 1, 1],
                matrix: nil,
                children: intList(n["children"]) ?? [],
                mesh: (n["mesh"] as? NSNumber)?.intValue,
                skin: (n["skin"] as? NSNumber)?.intValue)
        }
    }

    private static func skinPose(_ raw: [String: Any]?) -> GlbPose {
        var pose = GlbPose()
        for (index, entry) in raw ?? [:] {
            guard let key = Int(index), let e = entry as? [String: Any] else { continue }
            pose[key] = GlbTrsOverride(t: numberList(e["t"]), r: numberList(e["r"]), s: numberList(e["s"]))
        }
        return pose
    }

    private static func inlineModel(_ c: [String: Any], _ name: String) throws -> GlbModel {
        guard let source = c["model"] as? [String: Any],
              let rawNodes = source["nodes"] as? [[String: Any]],
              let rawClips = source["clips"] as? [[String: Any]] else {
            throw Failure(description: "skin/\(name): malformed inline model")
        }
        let clips: [GlbClip] = try rawClips.map { clip in
            guard let clipName = clip["name"] as? String,
                  let duration = JSE.number(clip["duration"]),
                  let rawChannels = clip["channels"] as? [[String: Any]] else {
                throw Failure(description: "skin/\(name): malformed inline clip")
            }
            let channels: [GlbChannel] = try rawChannels.map { ch in
                guard let node = (ch["node"] as? NSNumber)?.intValue,
                      let path = ch["path"] as? String,
                      let interpolation = ch["interpolation"] as? String,
                      let times = numberList(ch["times"]),
                      let values = numberList(ch["values"]) else {
                    throw Failure(description: "skin/\(name): malformed inline channel")
                }
                return GlbChannel(node: node, path: path, interpolation: interpolation,
                                  times: times, values: values)
            }
            return GlbClip(name: clipName, duration: duration, channels: channels)
        }
        return GlbModel(meshes: [], draws: [], nodes: skinNodes(rawNodes), skins: [], clips: clips)
    }

    /// re-assert the CURRENT name between events — a per-frame update with an unchanged
    /// name must be a no-op (the surfaces call update every frame)
    private static func mixerCurrentName(_ events: [[String: Any]], _ model: GlbModel, _ ms: Double) -> String {
        var name = ""
        for event in events {
            guard let at = JSE.number(event["ms"]), let set = event["set"] as? String else { continue }
            if at > ms { break }
            // an unknown-name event keeps the previous name (the mixer law) — mirror it
            if set.isEmpty || model.clips.contains(where: { $0.name == set }) { name = set }
        }
        return name
    }

    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let constants = doc["constants"] as? [String: Any],
              let fixtures = doc["fixtures"] as? [String: Any],
              let cases = doc["cases"] as? [[String: Any]], cases.count >= 16 else {
            throw Failure(description: "\(corpusFile.lastPathComponent): missing constants/fixtures or suspiciously few cases")
        }

        // the pinned constants match the kernel statics (the physics runner's pattern)
        guard JSE.number(constants["slerpNlerpThreshold"]) == SceneSkin.slerpNlerpThreshold,
              JSE.number(constants["weightEpsilon"]) == SceneSkin.weightEpsilon,
              JSE.number(constants["defaultBlendMs"]) == SceneSkin.defaultBlendMs,
              (constants["defaultLoop"] as? Bool) == SceneSkin.defaultLoop else {
            throw Failure(description: "skin/constants: the pinned constants diverge from SceneSkin")
        }

        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            var diagnostics: [SceneDiagnostic] = []
            let diag: (SceneDiagnostic) -> Void = { diagnostics.append($0) }
            let kind = (c["kind"] as? String) ?? "?"
            switch kind {
            case "parse":
                guard let b64 = fixtures[JSE.string(c["fixture"])] as? String,
                      let bytes = Data(base64Encoded: b64) else {
                    throw Failure(description: "skin/\(name): fixture missing or not base64")
                }
                guard let model = SceneGltf.parseGlb(bytes).model else {
                    throw Failure(description: "skin/\(name): fixture did not parse")
                }
                guard let want = c["expect"] as? [String: Any] else {
                    throw Failure(description: "skin/\(name): no expect{}")
                }
                guard model.nodes.count == (want["nodeCount"] as? NSNumber)?.intValue,
                      model.meshes.count == (want["meshCount"] as? NSNumber)?.intValue,
                      model.draws.count == (want["drawCount"] as? NSNumber)?.intValue else {
                    throw Failure(description: "skin/\(name): node/mesh/draw counts diverge (\(model.nodes.count)/\(model.meshes.count)/\(model.draws.count))")
                }
                for drawWant in (want["draws"] as? [[String: Any]]) ?? [] {
                    let draw = model.draws[(drawWant["index"] as? NSNumber)?.intValue ?? 0]
                    guard draw.mesh == (drawWant["mesh"] as? NSNumber)?.intValue,
                          draw.node == (drawWant["node"] as? NSNumber)?.intValue,
                          draw.skin == (drawWant["skin"] as? NSNumber)?.intValue else {
                        throw Failure(description: "skin/\(name): draw mesh/node/skin diverge")
                    }
                }
                let wantSkins = (want["skins"] as? [[String: Any]]) ?? []
                guard model.skins.count == wantSkins.count else {
                    throw Failure(description: "skin/\(name): skin count \(model.skins.count) (expected \(wantSkins.count))")
                }
                for (i, skinWant) in wantSkins.enumerated() {
                    guard model.skins[i].joints == intList(skinWant["joints"]) else {
                        throw Failure(description: "skin/\(name): skins[\(i)].joints diverge")
                    }
                    let ibms = (skinWant["ibms"] as? [Any]) ?? []
                    guard model.skins[i].inverseBindMatrices.count == ibms.count else {
                        throw Failure(description: "skin/\(name): skins[\(i)].ibm count diverges")
                    }
                    for (j, ibm) in ibms.enumerated() {
                        try close(model.skins[i].inverseBindMatrices[j], numberList(ibm) ?? [],
                                  "skins[\(i)].ibms[\(j)]", name)
                    }
                }
                for p in (want["primitives"] as? [[String: Any]]) ?? [] {
                    let primitive = model.meshes[(p["mesh"] as? NSNumber)?.intValue ?? 0]
                        .primitives[(p["primitive"] as? NSNumber)?.intValue ?? 0]
                    guard primitive.joints == intList(p["joints"]) else {
                        throw Failure(description: "skin/\(name): primitive joints diverge")
                    }
                    try close(primitive.weights, numberList(p["weights"]) ?? [], "primitive.weights", name)
                }
                let wantClips = (want["clips"] as? [[String: Any]]) ?? []
                guard model.clips.count == wantClips.count else {
                    throw Failure(description: "skin/\(name): clip count \(model.clips.count) (expected \(wantClips.count))")
                }
                for (i, clipWant) in wantClips.enumerated() {
                    let clip = model.clips[i]
                    guard clip.name == clipWant["name"] as? String else {
                        throw Failure(description: "skin/\(name): clips[\(i)].name \(clip.name)")
                    }
                    guard abs(clip.duration - (JSE.number(clipWant["duration"]) ?? .nan)) <= tolerance else {
                        throw Failure(description: "skin/\(name): clips[\(i)].duration \(clip.duration)")
                    }
                    let wantChannels = (clipWant["channels"] as? [[String: Any]]) ?? []
                    guard clip.channels.count == wantChannels.count else {
                        throw Failure(description: "skin/\(name): clips[\(i)] channel count \(clip.channels.count)")
                    }
                    for (j, chWant) in wantChannels.enumerated() {
                        let channel = clip.channels[j]
                        guard channel.node == (chWant["node"] as? NSNumber)?.intValue,
                              channel.path == chWant["path"] as? String,
                              channel.interpolation == chWant["interpolation"] as? String,
                              channel.times.count == (chWant["keys"] as? NSNumber)?.intValue else {
                            throw Failure(description: "skin/\(name): clips[\(i)][\(j)] channel diverges")
                        }
                    }
                }
            case "jointMatrices":
                guard let skinRaw = c["skin"] as? [String: Any],
                      let joints = intList(skinRaw["joints"]),
                      let ibmsRaw = skinRaw["ibms"] as? [Any],
                      let rawNodes = c["nodes"] as? [[String: Any]],
                      let meshNode = (c["meshNode"] as? NSNumber)?.intValue,
                      let want = c["expect"] as? [String: Any] else {
                    throw Failure(description: "skin/\(name): malformed jointMatrices case")
                }
                let ibms = try ibmsRaw.map { raw -> [Double] in
                    guard let m = numberList(raw) else {
                        throw Failure(description: "skin/\(name): malformed ibm")
                    }
                    return m
                }
                let model = GlbModel(meshes: [], draws: [], nodes: skinNodes(rawNodes),
                                     skins: [GlbSkin(joints: joints, inverseBindMatrices: ibms)],
                                     clips: [])
                let worlds = SceneSkin.nodeWorlds(model, pose: skinPose(c["pose"] as? [String: Any]))
                for (i, w) in ((want["worlds"] as? [Any]) ?? []).enumerated() {
                    try close(worlds[joints[i]], numberList(w) ?? [], "worlds[joint \(i)]", name)
                }
                let matrices = SceneSkin.jointMatrices(model, skin: 0, meshNode: meshNode, worlds: worlds)
                let wantMatrices = (want["jointMatrices"] as? [Any]) ?? []
                guard matrices.count == wantMatrices.count else {
                    throw Failure(description: "skin/\(name): joint matrix count \(matrices.count)")
                }
                for (i, m) in wantMatrices.enumerated() {
                    try close(matrices[i], numberList(m) ?? [], "jointMatrices[\(i)]", name)
                }
            case "skinVertex":
                guard let matricesRaw = c["matrices"] as? [Any] else {
                    throw Failure(description: "skin/\(name): no matrices[]")
                }
                let matrices = matricesRaw.map { numberList($0) ?? SceneMath.identity() }
                for v in (c["vertices"] as? [[String: Any]]) ?? [] {
                    guard let position = numberList(v["position"]),
                          let joints = intList(v["joints"]),
                          let weights = numberList(v["weights"]),
                          let expect = numberList(v["expect"]) else {
                        throw Failure(description: "skin/\(name): malformed vertex")
                    }
                    let got = SceneSkin.skinPosition(position, joints: joints, weights: weights,
                                                     matrices: matrices)
                    try close(got, expect, "skin(\(position))", name)
                }
            case "sample":
                guard let ch = c["channel"] as? [String: Any],
                      let path = ch["path"] as? String,
                      let interpolation = ch["interpolation"] as? String,
                      let times = numberList(ch["times"]),
                      let values = numberList(ch["values"]),
                      let duration = JSE.number(c["duration"]) else {
                    throw Failure(description: "skin/\(name): malformed sample case")
                }
                let channel = GlbChannel(node: 0, path: path, interpolation: interpolation,
                                         times: times, values: values)
                for s in (c["samples"] as? [[String: Any]]) ?? [] {
                    guard let time = JSE.number(s["time"]), let expect = numberList(s["expect"]) else {
                        throw Failure(description: "skin/\(name): malformed sample")
                    }
                    let wrapped = SceneSkin.clipTime(time, duration: duration, loop: s["loop"] as? Bool ?? false)
                    try close(SceneSkin.sampleChannel(channel, at: wrapped), expect, "sample@\(time)", name)
                }
            case "crossfade":
                func trs(_ raw: Any?) throws -> GlbTrs {
                    guard let d = raw as? [String: Any], let t = numberList(d["t"]),
                          let r = numberList(d["r"]), let s = numberList(d["s"]) else {
                        throw Failure(description: "skin/\(name): malformed trs")
                    }
                    return GlbTrs(t: t, r: r, s: s)
                }
                let from = try trs(c["from"])
                let to = try trs(c["to"])
                for s in (c["samples"] as? [[String: Any]]) ?? [] {
                    guard let progress = JSE.number(s["progress"]) else {
                        throw Failure(description: "skin/\(name): malformed blend sample")
                    }
                    let got = SceneSkin.blendTrs(from, to, progress: progress)
                    try close(got.t, numberList(s["t"]) ?? [], "t@\(progress)", name)
                    try close(got.r, numberList(s["r"]) ?? [], "r@\(progress)", name)
                    try close(got.s, numberList(s["s"]) ?? [], "s@\(progress)", name)
                }
            case "progress":
                for s in (c["samples"] as? [[String: Any]]) ?? [] {
                    guard let elapsed = JSE.number(s["elapsedMs"]), let blend = JSE.number(s["blendMs"]),
                          let expect = JSE.number(s["progress"]) else {
                        throw Failure(description: "skin/\(name): malformed progress sample")
                    }
                    let got = SceneSkin.crossfadeProgress(elapsedMs: elapsed, blendMs: blend)
                    guard abs(got - expect) <= tolerance else {
                        throw Failure(description: "skin/\(name): progress(\(elapsed), \(blend)) = \(got) (expected \(expect))")
                    }
                }
            case "mixer":
                let model = try inlineModel(c, name)
                let mixer = SceneClipMixer(model: model, diag: diag)
                let loop = c["loop"] as? Bool ?? true
                let blendMs = JSE.number(c["blendMs"]) ?? 0
                let events = (c["events"] as? [[String: Any]]) ?? []
                var next = 0
                for s in (c["samples"] as? [[String: Any]]) ?? [] {
                    guard let ms = JSE.number(s["ms"]),
                          let nodeIndex = (s["node"] as? NSNumber)?.intValue else {
                        throw Failure(description: "skin/\(name): malformed mixer sample")
                    }
                    while next < events.count, let at = JSE.number(events[next]["ms"]), at <= ms {
                        mixer.update(name: JSE.string(events[next]["set"]), loop: loop,
                                     blendMs: blendMs, nowMs: at)
                        next += 1
                    }
                    mixer.update(name: mixerCurrentName(events, model, ms), loop: loop,
                                 blendMs: blendMs, nowMs: ms)
                    let pose = mixer.pose(nowMs: ms)
                    let trs = SceneSkin.effectiveTrs(model.nodes[nodeIndex], pose: pose[nodeIndex])
                    if let t = numberList(s["t"]) { try close(trs.t, t, "t@\(ms)", name) }
                    if let r = numberList(s["r"]) { try close(trs.r, r, "r@\(ms)", name) }
                    if let active = s["active"] as? Bool {
                        guard mixer.active(nowMs: ms) == active else {
                            throw Failure(description: "skin/\(name): active@\(ms) = \(mixer.active(nowMs: ms)) (expected \(active))")
                        }
                    }
                }
                let expectedDiags = (c["diagnostics"] as? NSNumber)?.intValue ?? 0
                guard diagnostics.count == expectedDiags else {
                    throw Failure(description: "skin/\(name): \(diagnostics.count) diagnostic(s) (expected \(expectedDiags)): \(diagnostics.map(\.message))")
                }
            case "props":
                guard let markupSource = c["markup"] as? String,
                      let markup = StackXML.parse(markupSource) else {
                    throw Failure(description: "skin/\(name): markup did not parse")
                }
                let ir = SceneIRKit.parseScene(markup, diag: diag)
                guard let modelNode = ir.nodes.first(where: { $0.kind == "model" }) else {
                    throw Failure(description: "skin/\(name): markup contains no <model>")
                }
                let vars = (c["vars"] as? [String: Any]) ?? [:]
                let resolve: SceneResolve = { _, _, raw in
                    SceneIRKit.interpolateSceneHoles(raw) { vars[$0] }
                }
                let props = SceneIRKit.resolvedProps(modelNode, resolve, diag)
                guard let want = c["expect"] as? [String: Any] else {
                    throw Failure(description: "skin/\(name): no expect{}")
                }
                guard props.animation == want["animation"] as? String,
                      props.clipLoop == want["loop"] as? Bool,
                      abs(props.blendMs - (JSE.number(want["blendMs"]) ?? .nan)) <= tolerance else {
                    throw Failure(description: "skin/\(name): props diverge (animation=\(props.animation) loop=\(props.clipLoop) blendMs=\(props.blendMs))")
                }
                let expectedDiags = (c["diagnostics"] as? NSNumber)?.intValue ?? 0
                guard diagnostics.count == expectedDiags else {
                    throw Failure(description: "skin/\(name): \(diagnostics.count) diagnostic(s) (expected \(expectedDiags)): \(diagnostics.map(\.message))")
                }
            default:
                throw Failure(description: "skin/\(name): unknown case kind '\(kind)'")
            }
        }
        return cases.count + 1
    }
}

// MARK: - the UI MOTION corpus (motion/{curves,spring,retarget,physics}.json)

enum MotionConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    private static let tolerance = 1.5e-6

    private static func close(_ actual: Double, _ expected: Double, _ label: String) throws {
        guard abs(actual - expected) <= tolerance else {
            throw Failure(description: "motion/\(label): \(actual) !~ \(expected)")
        }
    }

    private static func doc(_ dir: URL, _ file: String) throws -> [String: Any] {
        let data = try Data(contentsOf: dir.appendingPathComponent(file))
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "motion/\(file): not a JSON object")
        }
        return object
    }

    private static func rows(_ object: [String: Any], _ key: String, _ minimum: Int) throws -> [[String: Any]] {
        guard let list = object[key] as? [[String: Any]], list.count >= minimum else {
            throw Failure(description: "motion/\(key): missing or suspiciously small")
        }
        return list
    }

    private static func num(_ value: Any?) -> Double { JSE.number(value) ?? .nan }

    /// Run OpenSource/Conformance/motion/ — all FOUR files — through the REAL Swift UI
    /// motion kernel (`DSXMotion`, Motion.swift), the ui-motion.md record-lane leg. The TS
    /// reference (motion-conformance.test.ts, per-PR) and the Kotlin twin (:core
    /// MotionConformanceTest, gradle) run the SAME files, so `anim="spring"` can never
    /// again mean three different curves on the three renderers:
    /// curves.json pins the `anim=`/`animDuration=` parse grammar (every default, every
    /// Article-7 fallback with its ONE `malformed-motion` diagnostic), the two motion
    /// PRESETS (`keep` 0.18 s easeOut, `press` 0.12 s easeOut — what Stack.swift applies
    /// when no anim= is authored) and `motionProgress` sampled at pinned elapsed times;
    /// spring.json pins THE CRUX — the SwiftUI response/dampingFraction →
    /// stiffness/damping conversion (ωₙ = 2π/response, k = ωₙ², c = 2ζωₙ), the spring's
    /// progress samples INCLUDING the legitimate overshoot past 1, and the settle time
    /// T = ln(1000)/(ωₙ(ζ − √max(0, ζ²−1))); retarget.json pins the CSS-transition
    /// interruption fold (a mid-flight target change glides from the CURRENT rendered
    /// value — never a snap, never a queue); physics.json pins the three UI physics
    /// primitives (UIScrollView decay/fling, the c = 0.55 rubber band and its inverse,
    /// and snap projection with the lower-point tie rule) plus their constants.
    /// Floats compare at the corpus tolerance (6 decimals, 1.5e-6). Returns the number of
    /// cases verified; throws on the first mismatch (or a malformed corpus — a
    /// silently-skipped suite is how drift starts).
    static func verify(corpusDir: URL) throws -> Int {
        var verified = 0
        verified += try verifyCurves(corpusDir)
        verified += try verifySpring(corpusDir)
        verified += try verifyRetarget(corpusDir)
        verified += try verifyPhysics(corpusDir)
        return verified
    }

    private static func verifyCurves(_ dir: URL) throws -> Int {
        let object = try doc(dir, "curves.json")
        var count = 0

        for c in try rows(object, "parse", 15) {
            let name = (c["name"] as? String) ?? "?"
            var codes: [String] = []
            let spec = DSXMotion.parse(anim: c["anim"] as? String,
                                       animDuration: c["animDuration"] as? String) { code, _ in
                codes.append(code)
            }
            guard let expect = c["expect"] as? [String: Any] else {
                throw Failure(description: "motion/curves/\(name): no expect{}")
            }
            guard spec.name == (expect["name"] as? String) else {
                throw Failure(description: "motion/curves/\(name): name \(spec.name)")
            }
            let wantKind = (expect["kind"] as? String) ?? ""
            guard (spec.isSpring ? "spring" : "curve") == wantKind else {
                throw Failure(description: "motion/curves/\(name): kind")
            }
            try close(spec.durationMs, num(expect["durationMs"]), "curves/\(name) durationMs")
            try close(DSXMotion.settleMs(spec), num(expect["durationMs"]), "curves/\(name) settleMs")
            if spec.isSpring {
                try close(spec.response, num(expect["response"]), "curves/\(name) response")
                try close(spec.dampingFraction, num(expect["dampingFraction"]), "curves/\(name) dampingFraction")
            } else {
                try close(spec.x1, num(expect["x1"]), "curves/\(name) x1")
                try close(spec.y1, num(expect["y1"]), "curves/\(name) y1")
                try close(spec.x2, num(expect["x2"]), "curves/\(name) x2")
                try close(spec.y2, num(expect["y2"]), "curves/\(name) y2")
            }
            let wantCodes = ((c["diagnostics"] as? [Any]) ?? []).map { JSE.string($0) }
            guard codes == wantCodes else {
                throw Failure(description: "motion/curves/\(name): diagnostics \(codes) (expected \(wantCodes))")
            }
            count += 1
        }

        // The pinned PRESETS — the two motion defaults a renderer applies when the author
        // sets no anim=. A renderer must not invent a third.
        let presets = (object["presets"] as? [String: [String: Any]]) ?? [:]
        let table: [String: DSXMotionSpec] = [
            "keep": DSXMotion.presetKeep,
            "press": DSXMotion.presetPress,
            "default": DSXMotion.presetDefault,
        ]
        for (key, expect) in presets {
            guard let spec = table[key] else {
                throw Failure(description: "motion/curves: no preset for \(key)")
            }
            guard spec.name == (expect["name"] as? String) else {
                throw Failure(description: "motion/curves/preset \(key): name \(spec.name)")
            }
            try close(spec.durationMs, num(expect["durationMs"]), "curves/preset \(key) durationMs")
            try close(spec.x1, num(expect["x1"]), "curves/preset \(key) x1")
            try close(spec.y1, num(expect["y1"]), "curves/preset \(key) y1")
            try close(spec.x2, num(expect["x2"]), "curves/preset \(key) x2")
            try close(spec.y2, num(expect["y2"]), "curves/preset \(key) y2")
            count += 1
        }

        for c in try rows(object, "progress", 8) {
            let name = (c["name"] as? String) ?? "?"
            let spec = DSXMotion.parse(anim: c["anim"] as? String, animDuration: c["animDuration"] as? String)
            try close(spec.durationMs, num(c["durationMs"]), "curves/\(name) durationMs")
            for s in (c["samples"] as? [[String: Any]]) ?? [] {
                let t = num(s["t"])
                try close(DSXMotion.progress(spec, elapsedMs: t), num(s["p"]), "curves/\(name) p(\(t))")
            }
            count += 1
        }
        return count
    }

    private static func verifySpring(_ dir: URL) throws -> Int {
        let object = try doc(dir, "spring.json")
        var count = 0

        for c in try rows(object, "conversion", 5) {
            let name = (c["name"] as? String) ?? "?"
            let response = num(c["response"])
            let dampingFraction = num(c["dampingFraction"])
            let k = DSXMotion.springConstants(response: response, dampingFraction: dampingFraction)
            try close(k.stiffness.squareRoot(), num(c["omega"]), "spring/\(name) omega")
            try close(k.stiffness, num(c["stiffness"]), "spring/\(name) stiffness")
            try close(k.damping, num(c["damping"]), "spring/\(name) damping")
            try close(k.damping / (2 * k.stiffness.squareRoot()), num(c["zeta"]), "spring/\(name) zeta")
            // At the authored damping fraction (0.8 — the only one `anim=` reaches), the
            // parse must produce exactly these numbers and this settle time.
            if dampingFraction == 0.8 {
                let spec = DSXMotion.parse(anim: "spring", animDuration: String(response))
                guard spec.isSpring else {
                    throw Failure(description: "motion/spring/\(name): parse did not yield a spring")
                }
                try close(spec.stiffness, num(c["stiffness"]), "spring/\(name) spec.stiffness")
                try close(spec.damping, num(c["damping"]), "spring/\(name) spec.damping")
                try close(spec.durationMs, num(c["settleMs"]), "spring/\(name) settleMs")
            }
            count += 1
        }

        for c in try rows(object, "progress", 4) {
            let name = (c["name"] as? String) ?? "?"
            // Non-default damping fractions are not reachable through `anim=`; build from
            // the authoring plane so the corpus pins the whole oscillator family.
            let spec = DSXMotion.spring(response: num(c["response"]), dampingFraction: num(c["dampingFraction"]))
            try close(DSXMotion.settleMs(spec), num(c["settleMs"]), "spring/\(name) settleMs")
            for s in (c["samples"] as? [[String: Any]]) ?? [] {
                let t = num(s["t"])
                try close(DSXMotion.progress(spec, elapsedMs: t), num(s["p"]), "spring/\(name) p(\(t))")
            }
            count += 1
        }
        return count
    }

    private static func verifyRetarget(_ dir: URL) throws -> Int {
        let object = try doc(dir, "retarget.json")
        var count = 0
        for c in try rows(object, "cases", 6) {
            let name = (c["name"] as? String) ?? "?"
            let spec = DSXMotion.parse(anim: c["anim"] as? String, animDuration: c["animDuration"] as? String)
            var state = DSXMotion.start(from: num(c["from"]), to: num(c["to"]), startMs: 0)
            let events = ((c["events"] as? [[String: Any]]) ?? []).sorted { num($0["at"]) < num($1["at"]) }
            var next = 0
            for s in (c["samples"] as? [[String: Any]]) ?? [] {
                let t = num(s["t"])
                while next < events.count, num(events[next]["at"]) <= t {
                    state = DSXMotion.retarget(spec, state, to: num(events[next]["to"]),
                                               nowMs: num(events[next]["at"]))
                    next += 1
                }
                let got = DSXMotion.value(spec, state, nowMs: t)
                try close(got.value, num(s["value"]), "retarget/\(name) value(\(t))")
                guard got.done == ((s["done"] as? Bool) ?? false) else {
                    throw Failure(description: "motion/retarget/\(name): done(\(t)) is \(got.done)")
                }
            }
            count += 1
        }
        return count
    }

    private static func verifyPhysics(_ dir: URL) throws -> Int {
        let object = try doc(dir, "physics.json")
        var count = 0

        guard let constants = object["constants"] as? [String: Any] else {
            throw Failure(description: "motion/physics: no constants{}")
        }
        try close(DSXMotion.decelerationRate, num(constants["decelerationRate"]), "physics decelerationRate")
        try close(DSXMotion.decayTauMs, num(constants["tauMs"]), "physics tauMs")
        try close(DSXMotion.decayMinVelocity, num(constants["minVelocity"]), "physics minVelocity")
        try close(DSXMotion.rubberBandC, num(constants["rubberBandC"]), "physics rubberBandC")
        try close(DSXMotion.rubberBandRelease.response, num(constants["releaseResponse"]), "physics releaseResponse")
        try close(DSXMotion.rubberBandRelease.dampingFraction,
                  num(constants["releaseDampingFraction"]), "physics releaseDampingFraction")
        count += 1

        for c in try rows(object, "decay", 3) {
            let name = (c["name"] as? String) ?? "?"
            let x0 = num(c["x0"])
            let v0 = num(c["v0"])
            try close(DSXMotion.decayTarget(x0: x0, v0: v0), num(c["target"]), "decay/\(name) target")
            try close(DSXMotion.decayDurationMs(v0: v0), num(c["durationMs"]), "decay/\(name) durationMs")
            for s in (c["samples"] as? [[String: Any]]) ?? [] {
                let t = num(s["t"])
                try close(DSXMotion.decayAt(x0: x0, v0: v0, tMs: t), num(s["x"]), "decay/\(name) x(\(t))")
            }
            count += 1
        }

        for c in try rows(object, "rubberBand", 6) {
            let name = (c["name"] as? String) ?? "?"
            let dimension = num(c["dimension"])
            let y = DSXMotion.rubberBand(num(c["x"]), dimension: dimension)
            try close(y, num(c["y"]), "rubberBand/\(name) y")
            try close(DSXMotion.rubberBandInverse(y, dimension: dimension), num(c["inverse"]),
                      "rubberBand/\(name) inverse")
            count += 1
        }

        for c in try rows(object, "snap", 6) {
            let name = (c["name"] as? String) ?? "?"
            let points = ((c["points"] as? [Any]) ?? []).map { num($0) }
            let got = DSXMotion.snapTarget(x0: num(c["x0"]), v0: num(c["v0"]), points: points)
            try close(got.projected, num(c["projected"]), "snap/\(name) projected")
            try close(got.target, num(c["target"]), "snap/\(name) target")
            guard got.index == Int(num(c["index"])) else {
                throw Failure(description: "motion/snap/\(name): index \(got.index)")
            }
            count += 1
        }
        return count
    }
}

// MARK: - G4 unified input + positional audio (input/{mappings,axis,attenuation}.json)

/// The Swift leg of the G4 unified-input corpus (dsx-game.md §2 G4). The TS runner
/// (packages/kernel/test/input-conformance.test.ts) and the Kotlin runner
/// (:core InputConformanceTest) execute the SAME files, so the mapping table, the axis math,
/// the edge law and the audio attenuation curve cannot drift by a decimal. Every expectation
/// came from an independent scratch implementation, never from any kernel under test.
enum InputConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    private static let tolerance = 1.5e-6

    private static func doc(_ file: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: file)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["version"] as? Int) == 1 else {
            throw Failure(description: "\(file.lastPathComponent): unsupported version")
        }
        return root
    }

    private static func num(_ v: Any?) -> Double {
        (v as? NSNumber)?.doubleValue ?? 0
    }

    private static func close(_ actual: Double, _ expected: Double, _ label: String) throws {
        guard abs(actual - expected) <= tolerance else {
            throw Failure(description: "\(label): \(actual) !~ \(expected)")
        }
    }

    private static func declarations(_ raw: Any?) -> [[String: String]] {
        (raw as? [[String: Any]] ?? []).map { row in
            var out: [String: String] = [:]
            for (k, v) in row { if let s = v as? String { out[k] = s } }
            return out
        }
    }

    /// Run all three files; returns the number of cases executed.
    static func verify(corpusDir: URL) throws -> Int {
        var count = 0
        count += try verifyMappings(corpusDir.appendingPathComponent("mappings.json"))
        count += try verifyAxis(corpusDir.appendingPathComponent("axis.json"))
        count += try verifyAttenuation(corpusDir.appendingPathComponent("attenuation.json"))
        return count
    }

    private static func verifyMappings(_ file: URL) throws -> Int {
        let root = try doc(file)
        guard let cases = root["cases"] as? [[String: Any]], cases.count >= 30 else {
            throw Failure(description: "mappings.json: no cases[] (or suspiciously small)")
        }
        var seenCodes = Set<String>()
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let got = SceneInput.resolveDeclarations(declarations(raw["declarations"]))
            let want = raw["bindings"] as? [[String: Any]] ?? []
            guard got.bindings.count == want.count else {
                throw Failure(description: "mappings/\(name): binding count \(got.bindings.count) (expected \(want.count))")
            }
            for (i, expected) in want.enumerated() {
                let have = got.bindings[i]
                guard have.name == (expected["name"] as? String ?? ""),
                      have.axis == (expected["axis"] as? Bool ?? false),
                      have.keys == (expected["keys"] as? [String] ?? []),
                      have.buttons == (expected["buttons"] as? [String] ?? []),
                      have.sticks == (expected["sticks"] as? [String] ?? []),
                      have.touch == (expected["touch"] as? [String] ?? []) else {
                    throw Failure(description: "mappings/\(name)[\(i)]: binding mismatch (\(have))")
                }
                try close(have.deadzone, num(expected["deadzone"]), "mappings/\(name)[\(i)].deadzone")
            }
            let wantCodes = raw["diagnostics"] as? [String] ?? []
            let gotCodes = got.diagnostics.map { $0.code }
            guard gotCodes == wantCodes else {
                throw Failure(description: "mappings/\(name): diagnostics \(gotCodes) (expected \(wantCodes))")
            }
            for code in wantCodes { seenCodes.insert(code) }
        }
        // every declared code is EXERCISED — a code nothing produces is a dead law
        let declared = Set(root["diagnosticCodes"] as? [String] ?? [])
        guard seenCodes == declared else {
            throw Failure(description: "mappings.json: diagnostic-code set \(seenCodes.sorted()) != declared \(declared.sorted())")
        }
        // the `dsx.input` scope fold, on THIS runtime's JSE
        for row in root["scope"] as? [[String: Any]] ?? [] {
            let path = row["path"] as? String ?? ""
            let expected = row["resolved"] as? String ?? ""
            let got = JSE.normalizeScope(path)
            guard got == expected else {
                throw Failure(description: "mappings/scope \(path): \(got) (expected \(expected))")
            }
        }
        // the kernel CONSTANTS agree with the corpus law
        guard INPUT_DEFAULT_DEADZONE == 0.15,
              SceneInput.keySets["wasd"] == ["W", "A", "S", "D"],
              SceneInput.keySets["arrows"] == ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"],
              SceneInput.keySets["zqsd"] == ["Z", "Q", "S", "D"],
              SceneInput.keySets["ijkl"] == ["I", "J", "K", "L"],
              SceneInput.padSticks["leftStick"]?.0 == 0, SceneInput.padSticks["leftStick"]?.1 == 1,
              SceneInput.padSticks["rightStick"]?.0 == 2, SceneInput.padSticks["rightStick"]?.1 == 3,
              SceneInput.momentaryTouch.sorted() == ["swipeDown", "swipeLeft", "swipeRight", "swipeUp", "tap"],
              SceneInput.touchWords.values.sorted() == ["hold", "swipeDown", "swipeLeft", "swipeRight", "swipeUp", "tap"]
        else {
            throw Failure(description: "mappings.json: kernel constants disagree with the corpus law")
        }
        let order = ["A", "B", "X", "Y", "L", "R", "L2", "R2", "Select", "Start",
                     "LStick", "RStick", "DPadUp", "DPadDown", "DPadLeft", "DPadRight"]
        for (index, word) in order.enumerated() where SceneInput.padButtons[word] != index {
            throw Failure(description: "mappings.json: pad button \(word) is not index \(index)")
        }
        return cases.count
    }

    private static func verifyAxis(_ file: URL) throws -> Int {
        let root = try doc(file)
        var count = 0

        for raw in root["digital"] as? [[String: Any]] ?? [] {
            let name = raw["name"] as? String ?? "?"
            let want = raw["vector"] as? [Any] ?? []
            let got = SceneInput.digitalAxis(up: raw["up"] as? Bool ?? false,
                                             left: raw["left"] as? Bool ?? false,
                                             down: raw["down"] as? Bool ?? false,
                                             right: raw["right"] as? Bool ?? false)
            try close(got.0, num(want.first), "digital/\(name).x")
            try close(got.1, num(want.last), "digital/\(name).y")
            count += 1
        }

        for raw in root["analog"] as? [[String: Any]] ?? [] {
            let name = raw["name"] as? String ?? "?"
            let input = raw["raw"] as? [Any] ?? []
            let want = raw["vector"] as? [Any] ?? []
            let got = SceneInput.analogAxis(rawX: num(input.first), rawY: num(input.last),
                                            deadzone: num(raw["deadzone"]))
            try close(got.0, num(want.first), "analog/\(name).x")
            try close(got.1, num(want.last), "analog/\(name).y")
            let magnitude = (got.0 * got.0 + got.1 * got.1).squareRoot()
            try close(magnitude, num(raw["magnitude"]), "analog/\(name).magnitude")
            guard magnitude <= 1 + tolerance else {
                throw Failure(description: "analog/\(name): magnitude \(magnitude) exceeds 1")
            }
            count += 1
        }

        for raw in root["combined"] as? [[String: Any]] ?? [] {
            let name = raw["name"] as? String ?? "?"
            let resolved = SceneInput.resolveDeclarations(declarations([raw["declaration"] as Any]))
            guard resolved.diagnostics.isEmpty, let binding = resolved.bindings.first else {
                throw Failure(description: "combined/\(name): the declaration is not clean")
            }
            let machine = InputMachine(resolved.bindings)
            for key in raw["keysDown"] as? [String] ?? [] { machine.keyDown(key) }
            if let pad = raw["gamepad"] as? [String: Any] {
                machine.gamepad(InputPadSnapshot(
                    buttons: (pad["buttons"] as? [Any] ?? []).map { num($0) },
                    axes: (pad["axes"] as? [Any] ?? []).map { num($0) }))
            }
            guard let value = machine.commit().values[binding.name] as? [Double], value.count == 2 else {
                throw Failure(description: "combined/\(name): no axis value")
            }
            let want = raw["vector"] as? [Any] ?? []
            try close(value[0], num(want.first), "combined/\(name).x")
            try close(value[1], num(want.last), "combined/\(name).y")
            count += 1
        }

        for stream in root["frames"] as? [[String: Any]] ?? [] {
            let name = stream["name"] as? String ?? "?"
            let resolved = SceneInput.resolveDeclarations(declarations(stream["declarations"]))
            guard resolved.diagnostics.isEmpty else {
                throw Failure(description: "frames/\(name): the declarations are not clean")
            }
            let machine = InputMachine(resolved.bindings)
            for (i, frame) in (stream["frames"] as? [[String: Any]] ?? []).enumerated() {
                for op in frame["ops"] as? [[String: Any]] ?? [] {
                    switch op["op"] as? String ?? "" {
                    case "keyDown": machine.keyDown(op["key"] as? String ?? "")
                    case "keyUp": machine.keyUp(op["key"] as? String ?? "")
                    case "touch": machine.touch(op["word"] as? String ?? "")
                    case "touchRelease": machine.touchRelease(op["word"] as? String ?? "")
                    case "gamepad":
                        machine.gamepad(InputPadSnapshot(
                            buttons: (op["buttons"] as? [Any] ?? []).map { num($0) },
                            axes: (op["axes"] as? [Any] ?? []).map { num($0) }))
                    default:
                        throw Failure(description: "frames/\(name)[\(i)]: unknown op")
                    }
                }
                let got = machine.commit()
                for (key, want) in frame["values"] as? [String: Any] ?? [:] {
                    if let wantBool = want as? Bool {
                        guard (got.values[key] as? Bool) == wantBool else {
                            throw Failure(description: "frames/\(name)[\(i)].\(key): \(String(describing: got.values[key])) (expected \(wantBool))")
                        }
                    } else if let wantAxis = want as? [String: Any] {
                        guard let axis = got.values[key] as? [Double], axis.count == 2 else {
                            throw Failure(description: "frames/\(name)[\(i)].\(key): not an axis value")
                        }
                        try close(axis[0], num(wantAxis["x"]), "frames/\(name)[\(i)].\(key).x")
                        try close(axis[1], num(wantAxis["y"]), "frames/\(name)[\(i)].\(key).y")
                    }
                }
                let wantEvents = frame["events"] as? [[String: Any]] ?? []
                guard got.events.count == wantEvents.count else {
                    throw Failure(description: "frames/\(name)[\(i)]: event count \(got.events.count) (expected \(wantEvents.count))")
                }
                for (j, event) in got.events.enumerated() {
                    guard event.name == (wantEvents[j]["name"] as? String ?? "") else {
                        throw Failure(description: "frames/\(name)[\(i)].event[\(j)]: \(event.name)")
                    }
                    try close(event.x, num(wantEvents[j]["x"]), "frames/\(name)[\(i)].event[\(j)].x")
                    try close(event.y, num(wantEvents[j]["y"]), "frames/\(name)[\(i)].event[\(j)].y")
                }
                count += 1
            }
        }
        return count
    }

    private static func verifyAttenuation(_ file: URL) throws -> Int {
        let root = try doc(file)
        guard let cases = root["cases"] as? [[String: Any]], cases.count >= 12 else {
            throw Failure(description: "attenuation.json: no cases[] (or suspiciously small)")
        }
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let listener = (raw["listener"] as? [Any] ?? []).map { num($0) }
            let source = (raw["source"] as? [Any] ?? []).map { num($0) }
            let got = SceneInput.audioAttenuation(listener: listener, source: source,
                                                  ref: num(raw["ref"]), max: num(raw["max"]),
                                                  rolloff: num(raw["rolloff"]))
            try close(got.distance, num(raw["distance"]), "attenuation/\(name).distance")
            try close(got.gain, num(raw["gain"]), "attenuation/\(name).gain")
            try close(got.pan, num(raw["pan"]), "attenuation/\(name).pan")
            guard got.gain > 0, got.gain <= 1 + tolerance else {
                throw Failure(description: "attenuation/\(name): gain \(got.gain) outside the 0..1 range")
            }
        }
        // the kernel DEFAULTS are what an omitted-argument call uses
        let defaults = root["defaults"] as? [String: Any] ?? [:]
        let explicit = SceneInput.audioAttenuation(listener: [0, 0, 0], source: [7, 0, 0],
                                                   ref: num(defaults["ref"]), max: num(defaults["max"]),
                                                   rolloff: num(defaults["rolloff"]))
        let implicit = SceneInput.audioAttenuation(listener: [0, 0, 0], source: [7, 0, 0])
        guard explicit == implicit else {
            throw Failure(description: "attenuation.json: the kernel defaults disagree with the corpus")
        }
        return cases.count
    }
}

// MARK: - the <split> planning corpus (split/split.json)

enum SplitConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/split/split.json through the Swift `SplitPlan` — the SAME
    /// file the TS split.test.ts and Kotlin SplitConformanceTest execute, so the `<split>`
    /// pane-role/collapse/selection grammar cannot drift across the three renderers.
    /// Twin discipline: expectation keys are asserted only when a case pins them.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["schema"] as? String) == "dev.dsx.split/v1" else {
            throw Failure(description: "\(corpusFile.lastPathComponent): unsupported schema")
        }
        guard let cases = root["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let attrs = (raw["attrs"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
            let childRoles: [String?] = (raw["childRoles"] as? [Any] ?? []).map { $0 as? String }
            let width: Double
            if let n = raw["width"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() {
                width = n.doubleValue
            } else if (raw["width"] as? String) == "nonfinite" {
                width = .nan
            } else {
                throw Failure(description: "split/\(name): width must be a number or \"nonfinite\"")
            }
            let plan = SplitPlan.resolve(attrs: attrs, childRoles: childRoles, width: width)
            guard let expect = raw["expect"] as? [String: Any] else {
                throw Failure(description: "split/\(name): no expect{}")
            }
            try check(name, expect, "panes", Double(plan.panes))
            try check(name, expect, "collapseAt", plan.collapseAt)
            try check(name, expect, "expandAt", plan.expandAt)
            try check(name, expect, "detailMin", plan.detailMin)
            try check(name, expect, "presentation", plan.presentation)
            try check(name, expect, "host", plan.host.rawValue)
            try check(name, expect, "overlay", plan.overlay)
            try check(name, expect, "detail", plan.detail)
            try check(name, expect, "resizable", plan.resizable)
            if let roles = expect["roles"] as? [String] {
                guard roles == plan.roles.map(\.rawValue) else {
                    throw Failure(description: "split/\(name): roles \(plan.roles.map(\.rawValue)) (expected \(roles))")
                }
            }
            if let columns = expect["columns"] as? [String] {
                guard columns == plan.columns.map(\.rawValue) else {
                    throw Failure(description: "split/\(name): columns \(plan.columns.map(\.rawValue)) (expected \(columns))")
                }
            }
            try widths(name, "sidebar", expect["sidebar"], plan.sidebar)
            try widths(name, "content", expect["content"], plan.content)
        }
        guard let selection = root["selection"] as? [[String: Any]], !selection.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no selection[]")
        }
        for raw in selection {
            let name = raw["name"] as? String ?? "?"
            guard let expected = raw["active"] as? Bool else {
                throw Failure(description: "split/selection/\(name): no active")
            }
            let got = SplitPlan.selectionActive(raw["value"])
            guard got == expected else {
                throw Failure(description: "split/selection/\(name): active \(got) (expected \(expected))")
            }
        }
        return cases.count + selection.count
    }

    private static func check(_ name: String, _ expect: [String: Any], _ key: String, _ got: Double) throws {
        guard let n = expect[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return }
        guard n.doubleValue == got else {
            throw Failure(description: "split/\(name): \(key) \(got) (expected \(n.doubleValue))")
        }
    }

    private static func check(_ name: String, _ expect: [String: Any], _ key: String, _ got: String) throws {
        guard let expected = expect[key] as? String else { return }
        guard expected == got else {
            throw Failure(description: "split/\(name): \(key) \(got) (expected \(expected))")
        }
    }

    private static func check(_ name: String, _ expect: [String: Any], _ key: String, _ got: Bool) throws {
        guard let n = expect[key] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return }
        guard n.boolValue == got else {
            throw Failure(description: "split/\(name): \(key) \(got) (expected \(n.boolValue))")
        }
    }

    private static func widths(_ name: String, _ role: String, _ raw: Any?, _ got: SplitPlan.Widths) throws {
        guard let expected = raw as? [String: Any] else { return }
        let want = SplitPlan.Widths(
            (expected["min"] as? NSNumber)?.doubleValue ?? got.min,
            (expected["ideal"] as? NSNumber)?.doubleValue ?? got.ideal,
            (expected["max"] as? NSNumber)?.doubleValue ?? got.max)
        guard want == got else {
            throw Failure(description: "split/\(name): \(role) \(got) (expected \(want))")
        }
    }
}

// MARK: - the markdown BLOCK corpus (markdown/blocks.json — the `<markdown>` element, A4b)

enum MarkdownBlocksConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/markdown/blocks.json through the REAL Swift parser
    /// (MarkdownBlocks.parse — the tree MarkdownBlocksView renders) — the SAME file the TS
    /// reference (dom test markdown-blocks.test.ts) and the Kotlin twin
    /// (MarkdownBlocksConformanceTest) execute, so `<markdown>` can never mean a different
    /// tree on iOS. Every case is (source → the neutral block tree); the serializer below
    /// emits exactly the corpus shape (ordered lists carry `start`, items carry `blocks`
    /// only when nested — the web tree's own key discipline). Returns the number of cases
    /// verified; throws on the first mismatch.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }
        if let limits = doc["limits"] as? [String: Any] {
            let expected = [(limits["characters"], MarkdownBlocks.limitCharacters, "characters"),
                            (limits["blocks"], MarkdownBlocks.limitBlocks, "blocks"),
                            (limits["listDepth"], MarkdownBlocks.limitListDepth, "listDepth")]
            for (corpus, mine, name) in expected {
                if let n = corpus as? NSNumber, n.intValue != mine {
                    throw Failure(description: "markdown: limit \(name) \(mine) drifted from corpus \(n.intValue)")
                }
            }
        }
        for c in cases {
            let name = c["name"] as? String ?? "?"
            guard let source = c["source"] as? String else {
                throw Failure(description: "markdown/\(name): no source")
            }
            guard let expected = c["blocks"] as? [Any] else {
                throw Failure(description: "markdown/\(name): no blocks[]")
            }
            let actual = MarkdownBlocks.parse(source).map(neutral)
            if !(expected as NSArray).isEqual(actual as NSArray) {
                throw Failure(description: "markdown/\(name): tree \(actual) (expected \(expected))")
            }
        }
        return cases.count
    }

    /// The corpus's neutral shape, from this runtime's tree.
    private static func neutral(_ block: MarkdownBlock) -> [String: Any] {
        switch block {
        case .paragraph(let inline):
            return ["type": "paragraph", "inline": inline]
        case .heading(let level, let inline):
            return ["type": "heading", "level": level, "inline": inline]
        case .code(let language, let text):
            return ["type": "code", "language": language, "text": text]
        case .quote(let blocks):
            return ["type": "quote", "blocks": blocks.map(neutral)]
        case .rule:
            return ["type": "rule"]
        case .image(let src, let alt):
            return ["type": "image", "src": src, "alt": alt]
        case .list(let ordered, let start, let items):
            var out: [String: Any] = ["type": "list", "ordered": ordered]
            if ordered { out["start"] = start }
            out["items"] = items.map { item -> [String: Any] in
                var row: [String: Any] = ["inline": item.inline]
                if !item.blocks.isEmpty { row["blocks"] = item.blocks.map(neutral) }
                return row
            }
            return out
        case .table(let header, let rows):
            return ["type": "table", "header": header, "rows": rows]
        }
    }
}

// MARK: - the attribute-binding corpus (composition/attribute-binding.json)

enum CompositionConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/composition/attribute-binding.json through the REAL Swift
    /// fold (`JSE.attributeBinding` / `JSE.bindAttribute`) — the reference implementation the
    /// TS (`attributeBinding`) and Kotlin (`JSE.attributeBinding`) runners execute over the
    /// SAME file. Returns the number of cases verified; throws on the first mismatch (or a
    /// malformed corpus — a silently-skipped suite is how drift starts).
    ///
    /// The law: markup has ONE way to write a consumer attribute and three things an author
    /// can mean by it. A sole `{{ … }}` carries the expression's VALUE, a mixed template
    /// carries the sentence, a template with no hole is its own text. Before the fold every
    /// .dsx component prop arrived interpolated, so a component could not be handed structure
    /// and a self-recursive component — a tree, an outliner, a comment thread — was
    /// unbuildable. The `recursion` block additionally pins `JSE.componentDepthCap`.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let fold = doc["fold"] as? [[String: Any]], !fold.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no fold[]")
        }
        guard let typed = doc["typed"] as? [[String: Any]], !typed.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no typed[]")
        }
        var verified = 0

        for c in fold {
            let name = (c["name"] as? String) ?? "?"
            let template = JSE.string(c["template"])
            let got = JSE.attributeBinding(template)
            let kind: String
            var expr: String?
            switch got {
            case .staticText: kind = "static"
            case .value(let e): kind = "value"; expr = e
            case .text: kind = "text"
            }
            guard kind == JSE.string(c["kind"]) else {
                throw Failure(description: "composition-fold/\(name): kind \(kind) (expected \(JSE.string(c["kind"])))")
            }
            if let want = c["expr"] as? String {
                guard expr == want else {
                    throw Failure(description: "composition-fold/\(name): expr \(expr ?? "nil") (expected \(want))")
                }
            }
            verified += 1
        }

        for c in typed {
            let name = (c["name"] as? String) ?? "?"
            let store = StackStore()
            for (k, v) in (c["vars"] as? [String: Any]) ?? [:] { store.vars[k] = v }
            let got = JSE.bindAttribute(JSE.string(c["template"]), store: store, item: nil)
            let want = JSE.string(c["type"])
            guard typeName(got) == want else {
                throw Failure(description: "composition-typed/\(name): type \(typeName(got)) (expected \(want))")
            }
            if c.index(forKey: "json") != nil {
                let a = canonical(c["json"])
                let b = canonical(got)
                guard a == b else {
                    throw Failure(description: "composition-typed/\(name): value \(b) (expected \(a))")
                }
            }
            verified += 1
        }

        guard let recursion = doc["recursion"] as? [String: Any],
              let cap = JSE.number(recursion["cap"]) else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no recursion.cap")
        }
        guard Int(cap) == JSE.componentDepthCap else {
            throw Failure(description: "composition-recursion: componentDepthCap \(JSE.componentDepthCap) drifted from corpus \(Int(cap))")
        }
        for c in (recursion["cases"] as? [[String: Any]]) ?? [] {
            let name = (c["name"] as? String) ?? "?"
            guard let depth = JSE.number(c["depth"]) else {
                throw Failure(description: "composition-recursion/\(name): no depth")
            }
            let expands = (c["expands"] as? Bool) ?? true
            guard (Int(depth) < JSE.componentDepthCap) == expands else {
                throw Failure(description: "composition-recursion/\(name): expands \(!expands)")
            }
            verified += 1
        }
        return verified
    }

    /// The cross-language type name for a resolved attribute value. TS and Kotlin name the
    /// same six categories; anything outside them is a divergence, not a detail. NSNumber
    /// carries booleans and numbers alike on this platform, so the CFTypeID decides.
    private static func typeName(_ v: Any?) -> String {
        guard let v, !(v is NSNull) else { return "null" }
        if v is [Any] { return "array" }
        if v is [String: Any] { return "object" }
        if let n = v as? NSNumber {
            return CFGetTypeID(n) == CFBooleanGetTypeID() ? "boolean" : "number"
        }
        if v is Bool { return "boolean" }
        if v is String { return "string" }
        if v is Int || v is Double { return "number" }
        return String(describing: type(of: v))
    }

    /// Canonical JSON for the deep-equality check, so the three runners compare the same
    /// bytes rather than three languages' idea of a number.
    private static func canonical(_ v: Any?) -> String {
        guard let v, !(v is NSNull) else { return "null" }
        if let a = v as? [Any] { return "[" + a.map(canonical).joined(separator: ",") + "]" }
        if let d = v as? [String: Any] {
            return "{" + d.keys.sorted().map { "\"\($0)\":\(canonical(d[$0]!))" }.joined(separator: ",") + "}"
        }
        if let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() {
            return n.boolValue ? "true" : "false"
        }
        if let b = v as? Bool { return b ? "true" : "false" }
        if v is NSNumber || v is Int || v is Double { return JSE.string(v) }
        return "\"\(JSE.string(v))\""
    }
}

enum StringsConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/strings/cases.json through the REAL Swift `DSXStrings` —
    /// the reference implementation of the localization kernel seam the TS runner
    /// (strings-conformance.test.ts) and the Kotlin runner (StringsConformanceTest.kt)
    /// execute over the SAME file. The seams are driven exactly as the twins drive them:
    /// `statePath` reads the case's dot-keyed state map, `loader` serves the case's
    /// bundle-table TEXT (text, so invalid JSON is expressible), `deviceLang` is the
    /// case's device. Returns the number of cases verified; throws on the first mismatch.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], cases.count >= 15 else {
            throw Failure(description: "strings/cases.json: expected the full case set")
        }

        let savedLoader = DSXStrings.loader
        let savedStatePath = DSXStrings.statePath
        let savedDeviceLang = DSXStrings.deviceLang
        defer {
            DSXStrings.loader = savedLoader
            DSXStrings.statePath = savedStatePath
            DSXStrings.deviceLang = savedDeviceLang
            DSXStrings.resetForConformance()
        }

        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            var state: [String: Any] = (c["state"] as? [String: Any]) ?? [:]
            let tables: [String: Any] = (c["tables"] as? [String: Any]) ?? [:]
            DSXStrings.resetForConformance()
            DSXStrings.loader = { candidate in tables[candidate] as? String }
            DSXStrings.statePath = { path in state[path] }
            DSXStrings.deviceLang = (c["device"] as? String) ?? "en"

            let steps: [[String: Any]]
            if let s = c["steps"] as? [[String: Any]] {
                steps = s
            } else {
                steps = [["input": c["input"] ?? "", "expect": c["expect"] ?? ""]]
            }
            for (index, step) in steps.enumerated() {
                if let patch = step["state"] as? [String: Any] {
                    for (k, v) in patch { state[k] = v }
                }
                let input = (step["input"] as? String) ?? ""
                let expect = (step["expect"] as? String) ?? ""
                let got = DSXStrings.localize(input)
                guard got == expect else {
                    throw Failure(description: "strings/\(name) step \(index + 1): localize(\"\(input)\") == \"\(got)\", corpus expects \"\(expect)\"")
                }
            }
        }
        return cases.count
    }
}

// MARK: - the `<code>` highlighter corpus (code/tokens.json)

enum HighlightConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run OpenSource/Conformance/code/tokens.json through the Swift `Highlight` scanner - the
    /// same file the TS runner (highlight-conformance.test.ts) and the Kotlin twin
    /// (HighlightConformanceTest) execute. The expectation is a MASK, one letter per character,
    /// so a mismatch prints the source and the two masks aligned rather than a list of offsets.
    ///
    /// Beyond the corpus this asserts the two structural invariants the mask form depends on:
    /// the spans TILE the source (contiguous, non-overlapping, index 0 to length) and no two
    /// adjacent spans share a kind. A scanner that satisfies both cannot lose a character.
    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], cases.count >= 30 else {
            throw Failure(description: "code/tokens.json: the corpus should not shrink silently")
        }
        // the letter table is shared vocabulary: a rename on one side has to fail on all three
        guard let letters = doc["_letters"] as? [String: String] else {
            throw Failure(description: "code/tokens.json: no _letters{}")
        }
        for kind in HiKind.allCases {
            guard letters[kind.word] == String(kind.letter) else {
                throw Failure(description: "code: letter for \(kind.word) is \(kind.letter), corpus says \(letters[kind.word] ?? "nothing")")
            }
        }
        guard letters.count == HiKind.allCases.count else {
            throw Failure(description: "code: the corpus knows \(letters.count) kinds, the scanner emits \(HiKind.allCases.count)")
        }

        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            let source = (c["source"] as? String) ?? ""
            let want = (c["mask"] as? String) ?? ""
            let got = Highlight.mask(source)
            guard got == want else {
                throw Failure(description: "code/\(name)\n  src  \(source)\n  want \(want)\n  got  \(got)")
            }
            var at = 0
            var previous: HiKind?
            for tok in Highlight.scan(source) {
                guard tok.start == at else {
                    throw Failure(description: "code/\(name): gap or overlap at \(tok.start), expected \(at)")
                }
                guard tok.end > tok.start else {
                    throw Failure(description: "code/\(name): empty span at \(tok.start)")
                }
                guard tok.kind != previous else {
                    throw Failure(description: "code/\(name): split run at \(tok.start)")
                }
                previous = tok.kind
                at = tok.end
            }
            guard at == Array(source).count else {
                throw Failure(description: "code/\(name): stopped at \(at) of \(Array(source).count)")
            }
        }
        return cases.count
    }
}

// MARK: - the WebMCP corpora (webmcp/project.json + webmcp/registry.json)

enum WebMcpConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Run BOTH WebMCP corpora through this runtime's `WebMcp` fold: the outbound projection
    /// of a `<tool>` head row into a W3C WebMCP descriptor, and the inbound page tool table a
    /// shell keeps when a page registers through `document.modelContext`. The TS
    /// (webmcp-conformance.test.ts) and Kotlin (WebMcpConformanceTest) twins execute the SAME
    /// two files. Returns the number of cases verified; throws on the first mismatch, or on a
    /// malformed corpus, because a silently-skipped suite is how drift starts.
    static func verify(projectFile: URL, registryFile: URL) throws -> Int {
        try verifyProject(corpusFile: projectFile) + verifyRegistry(corpusFile: registryFile)
    }

    private static func cases(_ corpusFile: URL) throws -> [[String: Any]] {
        let data = try Data(contentsOf: corpusFile)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        guard let cases = doc["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw Failure(description: "\(corpusFile.lastPathComponent): no cases[]")
        }
        return cases
    }

    /// Structural comparison over corpus JSON: NSNull is absence, and a number compares by
    /// value so 3 and 3.0 are the same fact on every runner.
    private static func same(_ a: Any?, _ b: Any?) -> Bool {
        let x = conformanceUnwrapNull(a), y = conformanceUnwrapNull(b)
        if x == nil && y == nil { return true }
        guard let x, let y else { return false }
        if let xs = x as? String, let ys = y as? String { return xs == ys }
        if let xn = x as? NSNumber, let yn = y as? NSNumber { return xn == yn }
        if let xd = x as? [String: Any], let yd = y as? [String: Any] {
            guard xd.count == yd.count else { return false }
            for (k, v) in xd where !same(v, yd[k]) { return false }
            return true
        }
        if let xa = x as? [Any], let ya = y as? [Any] {
            guard xa.count == ya.count else { return false }
            for (i, v) in xa.enumerated() where !same(v, ya[i]) { return false }
            return true
        }
        return false
    }

    private static func verifyProject(corpusFile: URL) throws -> Int {
        let all = try cases(corpusFile)
        for c in all {
            let name = (c["name"] as? String) ?? "?"

            // A RESULT case pins the MCP shaping a tool call answers with.
            if let result = c["result"] as? [String: Any] {
                let expected = (c["expect"] as? [String: Any])?["result"]
                let actual: [String: Any] = conformanceUnwrapNull(result["thrown"]) != nil
                    ? WebMcpResult.error(correlationId: (result["correlationId"] as? String) ?? "")
                    : WebMcpResult.value(conformanceUnwrapNull(result["value"]))
                if !same(actual, expected) {
                    throw Failure(description: "webmcp-project/\(name): result \(actual) (expected \(String(describing: expected)))")
                }
                continue
            }

            var actionInputs: [String: [String]] = [:]
            for (action, decl) in (c["actions"] as? [String: [String: Any]]) ?? [:] {
                actionInputs[action] = (decl["inputs"] as? [String]) ?? []
            }
            let rows = ((c["tools"] as? [[String: Any]]) ?? []).map { row in
                WebMcp.ToolRow(action: (row["action"] as? String) ?? "",
                               description: (row["description"] as? String) ?? "",
                               asName: row["as"] as? String,
                               mutates: row["mutates"] as? String)
            }
            let projection = WebMcp.project(rows: rows, actionInputs: actionInputs)

            if let expectError = c["expectError"] as? [String: Any] {
                guard !projection.errors.isEmpty else {
                    throw Failure(description: "webmcp-project/\(name): expected \(expectError["code"] ?? "?"), got a clean projection")
                }
                let code = (expectError["code"] as? String) ?? ""
                for e in projection.errors where e.code.rawValue != code {
                    throw Failure(description: "webmcp-project/\(name): error \(e.code.rawValue) (expected \(code))")
                }
                let names = (expectError["names"] as? [String]) ?? []
                if projection.errors.map({ $0.name }) != names {
                    throw Failure(description: "webmcp-project/\(name): error names \(projection.errors.map { $0.name }) (expected \(names))")
                }
                for e in projection.errors where e.message.isEmpty {
                    throw Failure(description: "webmcp-project/\(name): an error must carry a message")
                }
                continue
            }

            if !projection.errors.isEmpty {
                throw Failure(description: "webmcp-project/\(name): unexpected errors \(projection.errors.map { $0.message })")
            }
            let expect = (c["expect"] as? [String: Any]) ?? [:]
            if let names = expect["descriptorNames"] as? [String], projection.descriptors.map({ $0.name }) != names {
                throw Failure(description: "webmcp-project/\(name): names \(projection.descriptors.map { $0.name }) (expected \(names))")
            }
            if let descriptors = expect["descriptors"] as? [Any] {
                let actual = projection.descriptors.map { $0.wire() }
                if !same(actual, descriptors) {
                    throw Failure(description: "webmcp-project/\(name): descriptors \(actual) (expected \(descriptors))")
                }
            }
        }
        return all.count
    }

    private static func verifyRegistry(corpusFile: URL) throws -> Int {
        let all = try cases(corpusFile)
        for c in all {
            let name = (c["name"] as? String) ?? "?"
            var events: [[String: Any]] = []
            let table = WebMcp.PageToolTable { surface in
                events.append(["event": "toolchange", "surface": surface])
            }
            var rejections: [[String: Any]] = []

            for step in (c["steps"] as? [[String: Any]]) ?? [] {
                if let register = step["register"] as? [String: Any] {
                    let tool = (register["tool"] as? [String: Any]) ?? [:]
                    if let rejected = table.register(
                        surface: (register["surface"] as? String) ?? "",
                        origin: (register["origin"] as? String) ?? "",
                        name: (tool["name"] as? String) ?? "",
                        description: (tool["description"] as? String) ?? "",
                        inputSchema: tool["inputSchema"] as? [String: Any],
                        annotations: tool["annotations"] as? [String: Any]
                    ) {
                        rejections.append(["reason": rejected.reason.rawValue, "name": rejected.name])
                    }
                } else if let commit = step["commit"] as? [String: Any] {
                    table.commit(surface: (commit["surface"] as? String) ?? "")
                } else if let abort = step["abort"] as? [String: Any] {
                    table.abort(surface: (abort["surface"] as? String) ?? "",
                                name: (abort["name"] as? String) ?? "")
                } else {
                    throw Failure(description: "webmcp-registry/\(name): unknown step \(step)")
                }
            }

            let expect = (c["expect"] as? [String: Any]) ?? [:]
            if let tools = expect["tools"] as? [Any] {
                let actual = table.tools().map { wire($0) }
                if !same(actual, tools) {
                    throw Failure(description: "webmcp-registry/\(name): tools \(actual) (expected \(tools))")
                }
            }
            if let names = expect["toolNames"] as? [String], table.tools().map({ $0.name }) != names {
                throw Failure(description: "webmcp-registry/\(name): names \(table.tools().map { $0.name }) (expected \(names))")
            }
            if let expected = expect["rejections"] as? [Any], !same(rejections, expected) {
                throw Failure(description: "webmcp-registry/\(name): rejections \(rejections) (expected \(expected))")
            }
            if let expected = expect["events"] as? [Any], !same(events, expected) {
                throw Failure(description: "webmcp-registry/\(name): events \(events) (expected \(expected))")
            }
        }
        return all.count
    }

    /// The recorded row as the corpus writes it — provenance, the verbatim schema, approval.
    private static func wire(_ tool: WebMcp.PageTool) -> [String: Any] {
        var out: [String: Any] = [
            "surface": tool.surface,
            "origin": tool.origin,
            "name": tool.name,
            "description": tool.description,
            "inputSchema": tool.inputSchema,
            "approval": tool.approval,
        ]
        if let annotations = tool.annotations { out["annotations"] = annotations }
        return out
    }
}
