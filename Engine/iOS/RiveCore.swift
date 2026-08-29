//
//  RiveCore.swift - the shared `<rive>` core, the Swift twin of the web kernel's rive-core.ts
//  and Android's RiveCore.kt (parity/U12-rive.md): the state-machine input plane,
//  artboard/machine/animation selection, the fit and alignment fold, the playback and
//  residency lifecycle, the event payloads and the accessibility verdict. The law is the
//  corpus, OpenSource/Conformance/rive/.
//
//  WHY A SHARED CORE WHEN THE RENDERER IS ONE VENDOR LIBRARY. Rive's own runtime draws the
//  same picture on all three platforms, so pixels are the one thing that cannot diverge and
//  the one thing pinned nowhere. What CAN diverge is everything around the vendor library:
//  which artboard a missing name resolves to, whether a trigger fires twice on a re-render,
//  whether an offscreen animation keeps advancing, what a state change looks like when it
//  reaches an author's handler. Those live here, as data folds with no vendor type in sight.
//
//  Apple-free by construction: only Foundation, so the same file serves iOS, macOS, watchOS
//  and the record lane, and it names no Rive symbol - the RUNTIME is a ClosedSource module
//  (Core/Rive, MIT, vendored and pinned there), so the kernel keeps resolving zero package
//  coordinates. The UIKit/SwiftUI adapter is the module's own swift/RiveElement.swift.
//

import Foundation

public enum RiveCore {

    // MARK: - numbers

    /// The canonical text of a number, used as the input plane's change token. Six decimals,
    /// no negative zero, integers without a point - the same spelling CanvasCore uses, for
    /// the same reason: three languages must agree on when a value "changed".
    public static func numberText(_ value: Double) -> String {
        guard value.isFinite else { return "0" }
        let rounded = (value * 1e6).rounded() / 1e6
        if rounded == 0 { return "0" }
        if rounded == rounded.rounded(.towardZero) && abs(rounded) < 1e15 {
            return String(Int64(rounded))
        }
        var text = String(format: "%.6f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text
    }

    static func round6(_ value: Double) -> Double {
        (value * 1e6).rounded() / 1e6
    }

    /// The ONE numeric grammar all three renderers accept in a bound input: an optional sign,
    /// decimal digits, an optional exponent. Deliberately narrower than any one language's
    /// own parser - JS `Number()` reads `0x10`, Kotlin's `toDouble()` reads `1d`, and a value
    /// that means 16 on the web and nothing here is the exact drift the corpus exists to stop.
    static func parseNumber(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var index = trimmed.startIndex
        if trimmed[index] == "+" || trimmed[index] == "-" { index = trimmed.index(after: index) }
        var digitsBefore = 0, digitsAfter = 0, dots = 0
        var exponentAt: String.Index?
        var cursor = index
        while cursor < trimmed.endIndex {
            let ch = trimmed[cursor]
            if ch == "e" || ch == "E" { exponentAt = cursor; break }
            if ch == "." {
                dots += 1
                if dots > 1 { return nil }
            } else if ch.isNumber && ch.isASCII {
                if dots == 0 { digitsBefore += 1 } else { digitsAfter += 1 }
            } else {
                return nil
            }
            cursor = trimmed.index(after: cursor)
        }
        guard digitsBefore + digitsAfter > 0 else { return nil }
        if let exponentAt {
            var expCursor = trimmed.index(after: exponentAt)
            guard expCursor < trimmed.endIndex else { return nil }
            if trimmed[expCursor] == "+" || trimmed[expCursor] == "-" {
                expCursor = trimmed.index(after: expCursor)
            }
            var expDigits = 0
            while expCursor < trimmed.endIndex {
                let ch = trimmed[expCursor]
                guard ch.isNumber && ch.isASCII else { return nil }
                expDigits += 1
                expCursor = trimmed.index(after: expCursor)
            }
            guard expDigits > 0 else { return nil }
        }
        guard let value = Double(trimmed), value.isFinite else { return nil }
        return value
    }

    // MARK: - the state-machine input plane

    public struct DeclaredInput {
        public let name: String
        public let type: String

        public init(name: String, type: String) {
            self.name = name
            self.type = type
        }
    }

    /// A value bound from markup, as the adapter hands it over. The enum keeps the core
    /// Foundation-only and total: there is no `Any` to mis-cast at a call site.
    public enum BoundValue {
        case bool(Bool)
        case number(Double)
        case text(String)
        case absent
    }

    /// `value` is the level to write; `.edge` for a trigger, which carries no level at all.
    public struct InputOp: Equatable {
        /// `edge` rather than `none`: a case literally named `none` collides with
        /// `Optional.none` at every `.none` call site, and the compiler's disambiguation is a
        /// warning nobody reads.
        public enum Level: Equatable {
            case bool(Bool)
            case number(Double)
            case edge
        }
        public let name: String
        public let kind: String
        public let value: Level
    }

    public struct InputRefusal: Equatable {
        public let name: String
        public let code: String
        public let message: String
    }

    public struct InputPlan {
        public let ops: [InputOp]
        public let refusals: [InputRefusal]
        /// the token map to feed the NEXT fold: this is the trigger edge detector
        public let values: [String: String]
    }

    /// the tokens a trigger reads as "not fired yet"
    static let falsyTokens: Set<String> = ["", "false", "0"]

    static func booleanToken(_ raw: BoundValue) -> Bool? {
        switch raw {
        case .bool(let flag): return flag
        case .number(let value): return value.isFinite ? value != 0 : nil
        case .text(let text):
            let low = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if low == "true" { return true }
            if low == "false" { return false }
            guard let parsed = parseNumber(low) else { return nil }
            return parsed != 0
        case .absent: return nil
        }
    }

    static func numberValue(_ raw: BoundValue) -> Double? {
        switch raw {
        case .bool: return nil   // `count: true` is a shape mistake, not a 1
        case .number(let value): return value.isFinite ? value : nil
        case .text(let text): return parseNumber(text)
        case .absent: return nil
        }
    }

    static func triggerToken(_ raw: BoundValue) -> String {
        switch raw {
        case .bool(let flag): return flag ? "true" : "false"
        case .number(let value): return numberText(value)
        case .text(let text): return text.trimmingCharacters(in: .whitespacesAndNewlines)
        case .absent: return ""
        }
    }

    /// Turn a bound `inputs` object into the smallest set of writes the machine needs.
    ///
    /// The DECLARED list is authority (an undeclared key is refused, never guessed at),
    /// LEVELS are diffed against `previous` so an unchanged re-render writes nothing, and a
    /// TRIGGER is an EDGE: it fires when its token changes to a truthy one. That last rule is
    /// the whole reason `inputs` can be declarative - `{ celebrate: order.justPlaced }` fires
    /// once per order rather than once per frame, with no imperative call anywhere.
    ///
    /// A refusal never aborts the plan: one bad binding must not freeze an animation.
    public static func inputPlan(
        declared: [DeclaredInput],
        bound: [String: BoundValue],
        previous: [String: String]
    ) -> InputPlan {
        var ops: [InputOp] = []
        var refusals: [InputRefusal] = []
        var values = previous
        var seen: Set<String> = []

        for input in declared {
            let name = input.name
            seen.insert(name)
            guard let raw = bound[name] else { continue }
            if case .absent = raw { continue }   // an unresolved binding is not an error
            let prev = previous[name]

            switch input.type {
            case "boolean":
                guard let flag = booleanToken(raw) else {
                    refusals.append(InputRefusal(name: name, code: "input_type",
                                                 message: "input '\(name)' expects a boolean"))
                    continue
                }
                let token = flag ? "true" : "false"
                if token != prev {
                    ops.append(InputOp(name: name, kind: "boolean", value: .bool(flag)))
                    values[name] = token
                }
            case "number":
                guard let value = numberValue(raw) else {
                    refusals.append(InputRefusal(name: name, code: "input_type",
                                                 message: "input '\(name)' expects a number"))
                    continue
                }
                let token = numberText(value)
                if token != prev {
                    ops.append(InputOp(name: name, kind: "number", value: .number(round6(value))))
                    values[name] = token
                }
            case "trigger":
                let token = triggerToken(raw)
                if token != prev && !falsyTokens.contains(token.lowercased()) {
                    ops.append(InputOp(name: name, kind: "trigger", value: .edge))
                }
                values[name] = token             // the falling edge is recorded too
            default:
                refusals.append(InputRefusal(name: name, code: "input_type",
                                             message: "input '\(name)' has an unknown input type"))
            }
        }

        for name in bound.keys.filter({ !seen.contains($0) }).sorted() {
            refusals.append(InputRefusal(
                name: name, code: "unknown_input",
                message: "the state machine declares no input named '\(name)'"))
        }

        return InputPlan(ops: ops, refusals: refusals, values: values)
    }

    // MARK: - artboard / machine / animation selection

    public struct Artboard {
        public let name: String
        public let isDefault: Bool
        public let stateMachines: [String]
        public let animations: [String]

        public init(name: String, isDefault: Bool = false,
                    stateMachines: [String] = [], animations: [String] = []) {
            self.name = name
            self.isDefault = isDefault
            self.stateMachines = stateMachines
            self.animations = animations
        }
    }

    public struct SelectionError: Equatable {
        public let code: String
        public let message: String
    }

    public struct Selection: Equatable {
        public let artboard: String?
        public let stateMachine: String?
        public let animation: String?
        public let mode: String
        public let error: SelectionError?
    }

    /// A refusal is TOTAL: nothing half-mounts a selection it was told to reject.
    static func refused(_ code: String, _ message: String) -> Selection {
        Selection(artboard: nil, stateMachine: nil, animation: nil, mode: "idle",
                  error: SelectionError(code: code, message: message))
    }

    static func attrText(_ attrs: [String: String], _ name: String) -> String {
        (attrs[name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Resolve which artboard, and which machine or animation inside it, this `<rive>` plays.
    ///
    /// Every miss is `not_found` NAMING what was asked for and where it was looked up, because
    /// a mistyped artboard rendering a blank box is the single worst failure mode this
    /// component has (plan §7). `stateMachine` and `animation` together is a conflict rather
    /// than a silent precedence rule - the kind of rule an author never finds when it goes the
    /// other way.
    public static func selection(artboards: [Artboard], attrs: [String: String]) -> Selection {
        guard !artboards.isEmpty else {
            return refused("not_found", "this .riv file declares no artboard")
        }
        let wantBoard = attrText(attrs, "artboard")
        let wantMachine = attrText(attrs, "stateMachine")
        let wantAnimation = attrText(attrs, "animation")
        if !wantMachine.isEmpty && !wantAnimation.isEmpty {
            return refused("conflict", "<rive> takes stateMachine or animation, not both")
        }

        let board: Artboard
        if !wantBoard.isEmpty {
            guard let found = artboards.first(where: { $0.name == wantBoard }) else {
                return refused("not_found", "no artboard named '\(wantBoard)' in this .riv file")
            }
            board = found
        } else {
            board = artboards.first(where: { $0.isDefault }) ?? artboards[0]
        }

        if !wantAnimation.isEmpty {
            guard board.animations.contains(wantAnimation) else {
                return refused("not_found",
                               "no animation named '\(wantAnimation)' on artboard '\(board.name)'")
            }
            return Selection(artboard: board.name, stateMachine: nil, animation: wantAnimation,
                             mode: "animation", error: nil)
        }
        if !wantMachine.isEmpty {
            guard board.stateMachines.contains(wantMachine) else {
                return refused("not_found",
                               "no state machine named '\(wantMachine)' on artboard '\(board.name)'")
            }
            return Selection(artboard: board.name, stateMachine: wantMachine, animation: nil,
                             mode: "machine", error: nil)
        }
        if let machine = board.stateMachines.first {
            return Selection(artboard: board.name, stateMachine: machine, animation: nil,
                             mode: "machine", error: nil)
        }
        if let animation = board.animations.first {
            return Selection(artboard: board.name, stateMachine: nil, animation: animation,
                             mode: "animation", error: nil)
        }
        // An artboard with neither is a static drawing. Legal, and not an error.
        return Selection(artboard: board.name, stateMachine: nil, animation: nil,
                         mode: "idle", error: nil)
    }

    // MARK: - fit and alignment

    public static let fitWords: [String: String] = [
        "cover": "cover", "contain": "contain", "fill": "fill",
        "fitwidth": "fitWidth", "fitheight": "fitHeight", "none": "none",
    ]

    public static let alignmentWords: [String: String] = [
        "center": "center", "centre": "center",
        "top": "topCenter", "topcenter": "topCenter", "topleft": "topLeft", "topright": "topRight",
        "bottom": "bottomCenter", "bottomcenter": "bottomCenter",
        "bottomleft": "bottomLeft", "bottomright": "bottomRight",
        "left": "centerLeft", "centerleft": "centerLeft",
        "right": "centerRight", "centerright": "centerRight",
    ]

    static let alignmentFactors: [String: (Double, Double)] = [
        "topLeft": (0, 0), "topCenter": (0.5, 0), "topRight": (1, 0),
        "centerLeft": (0, 0.5), "center": (0.5, 0.5), "centerRight": (1, 0.5),
        "bottomLeft": (0, 1), "bottomCenter": (0.5, 1), "bottomRight": (1, 1),
    ]

    public struct Placement {
        public let fit: String
        public let alignment: String
        public let scaleX: Double
        public let scaleY: Double
        public let x: Double
        public let y: Double
        public let diagnostics: [String]
    }

    /// lowercase, strip every separator, then look the word up: `Bottom-Right` is `bottomright`.
    static func foldWord(_ raw: String?, _ table: [String: String], _ fallback: String,
                         _ diagnostics: inout [String], _ kind: String) -> String {
        guard let raw else { return fallback }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = String(text.lowercased().unicodeScalars.filter {
            ($0.value >= 97 && $0.value <= 122) || ($0.value >= 48 && $0.value <= 57)
        }.map { Character($0) })
        if key.isEmpty { return fallback }        // absent is not a diagnostic
        guard let word = table[key] else {
            diagnostics.append("unknown \(kind) '\(text)'")
            return fallback
        }
        return word
    }

    /// Place an artboard of `content` size inside a `box`. Scale is per-fit; placement is
    /// `align * (box - content * scale)`, so the same nine factors serve all six fits.
    ///
    /// An unknown word FOLDS to the default and is diagnosed rather than refused: a typo in a
    /// presentation attribute must not blank an animation, and must not be silent either. A
    /// zero-sized artboard is diagnosed and placed at scale 1, because a NaN transform is an
    /// invisible animation nobody can debug.
    public static func fit(_ fitWord: String?, _ alignmentWord: String?,
                           contentWidth: Double, contentHeight: Double,
                           boxWidth: Double, boxHeight: Double) -> Placement {
        var diagnostics: [String] = []
        let resolvedFit = foldWord(fitWord, fitWords, "contain", &diagnostics, "fit")
        let resolvedAlignment = foldWord(alignmentWord, alignmentWords, "center", &diagnostics, "alignment")
        let factors = alignmentFactors[resolvedAlignment] ?? (0.5, 0.5)
        let ax = factors.0
        let ay = factors.1

        let sane = contentWidth.isFinite && contentHeight.isFinite
            && boxWidth.isFinite && boxHeight.isFinite
            && contentWidth > 0 && contentHeight > 0 && boxWidth >= 0 && boxHeight >= 0
        if !sane {
            diagnostics.append("the artboard has no intrinsic size")
            return Placement(fit: resolvedFit, alignment: resolvedAlignment, scaleX: 1, scaleY: 1,
                             x: round6(ax * max(boxWidth.isFinite ? boxWidth : 0, 0)),
                             y: round6(ay * max(boxHeight.isFinite ? boxHeight : 0, 0)),
                             diagnostics: diagnostics)
        }

        var scaleX: Double
        var scaleY: Double
        switch resolvedFit {
        case "cover":
            let s = max(boxWidth / contentWidth, boxHeight / contentHeight)
            scaleX = s; scaleY = s
        case "fill":
            scaleX = boxWidth / contentWidth; scaleY = boxHeight / contentHeight
        case "fitWidth":
            let s = boxWidth / contentWidth
            scaleX = s; scaleY = s
        case "fitHeight":
            let s = boxHeight / contentHeight
            scaleX = s; scaleY = s
        case "none":
            scaleX = 1; scaleY = 1
        default:
            let s = min(boxWidth / contentWidth, boxHeight / contentHeight)
            scaleX = s; scaleY = s
        }
        return Placement(fit: resolvedFit, alignment: resolvedAlignment,
                         scaleX: round6(scaleX), scaleY: round6(scaleY),
                         x: round6(ax * (boxWidth - contentWidth * scaleX)),
                         y: round6(ay * (boxHeight - contentHeight * scaleY)),
                         diagnostics: diagnostics)
    }

    // MARK: - playback lifecycle

    public static let frameMinIntervalMs: Double = 1000.0 / 60.0

    public struct Advance: Equatable {
        public let time: Double
        public let delta: Double
        public let frame: Int
    }

    public struct PlaybackFold {
        public let emitted: [Advance]
        public let starts: Int
        public let pauses: Int
        public let instantiations: Int
        public let disposals: Int
        public let drops: Int
        public let advancing: Bool
        public let live: Bool
    }

    /// A Rive artboard is a live scene, not a decoded image: an offscreen one that keeps
    /// advancing is a battery bug, and twenty of them retained in a list is a memory bug. The
    /// machine advances only while it is LIVE (mounted), WANTED (autoplay or an explicit
    /// play), ON SCREEN, and the app is FOREGROUND; a tick arriving otherwise is DROPPED,
    /// never queued, so `time` is accumulated delta and excludes the offscreen interval.
    ///
    /// Unmount DISPOSES, and a remount is a fresh instance: the clock restarts at zero and the
    /// wanted-state returns to `autoplay`, because an imperative play() belongs to the scene
    /// that received it.
    public final class Playback {
        private let autoplay: Bool
        private var visible = true
        private var active = true
        private var wanted: Bool
        private var liveFlag = false
        private var advancingFlag = false
        private var lastTick: Double?
        private var time: Double = 0
        private var frame = 0

        public private(set) var starts = 0
        public private(set) var pauses = 0
        public private(set) var instantiations = 0
        public private(set) var disposals = 0
        public private(set) var drops = 0

        public init(autoplay: Bool) {
            self.autoplay = autoplay
            self.wanted = autoplay
        }

        public var live: Bool { liveFlag }
        public var advancing: Bool { advancingFlag }

        public func setMounted(_ value: Bool) {
            if value {
                if !liveFlag { liveFlag = true; instantiations += 1 }
                settle()
                return
            }
            if liveFlag { liveFlag = false; disposals += 1 }
            settle()
            wanted = autoplay          // a fresh instance forgets the imperative state
            time = 0
            frame = 0
            lastTick = nil
        }

        public func setVisible(_ value: Bool) { visible = value; settle() }

        public func setActive(_ value: Bool) { active = value; settle() }

        public func play() { wanted = true; settle() }

        public func pause() { wanted = false; settle() }

        private func settle() {
            let want = liveFlag && wanted && visible && active
            if want && !advancingFlag {
                advancingFlag = true
                starts += 1
                lastTick = nil
            } else if !want && advancingFlag {
                advancingFlag = false
                pauses += 1
            }
        }

        /// one raw platform tick (ms); the advance to apply, or nil when dropped or coalesced
        public func tick(_ nowMs: Double) -> Advance? {
            guard advancingFlag else { drops += 1; return nil }
            guard let last = lastTick else {
                lastTick = nowMs
                let advance = Advance(time: round6(time), delta: 0, frame: frame)
                frame += 1
                return advance
            }
            let gap = nowMs - last
            if gap < frameMinIntervalMs { drops += 1; return nil }
            lastTick = nowMs
            let delta = gap / 1000
            time += delta
            let advance = Advance(time: round6(time), delta: round6(delta), frame: frame)
            frame += 1
            return advance
        }
    }

    public enum PlaybackEvent {
        case mount
        case unmount
        case visible(Bool)
        case active(Bool)
        case play
        case pause
        case tick(Double)
    }

    /// the pure fold the corpus pins: an autoplay flag plus a lifecycle/tick event list
    public static func playbackSchedule(autoplay: Bool, events: [PlaybackEvent]) -> PlaybackFold {
        let loop = Playback(autoplay: autoplay)
        var emitted: [Advance] = []
        for event in events {
            switch event {
            case .mount: loop.setMounted(true)
            case .unmount: loop.setMounted(false)
            case .visible(let value): loop.setVisible(value)
            case .active(let value): loop.setActive(value)
            case .play: loop.play()
            case .pause: loop.pause()
            case .tick(let at):
                if let advance = loop.tick(at) { emitted.append(advance) }
            }
        }
        return PlaybackFold(emitted: emitted, starts: loop.starts, pauses: loop.pauses,
                            instantiations: loop.instantiations, disposals: loop.disposals,
                            drops: loop.drops, advancing: loop.advancing, live: loop.live)
    }

    // MARK: - residency: a list of animations, bounded

    public struct ResidencyEvent {
        public let key: String
        public let visible: Bool

        public init(key: String, visible: Bool) {
            self.key = key
            self.visible = visible
        }
    }

    public struct ResidencyFold {
        public let live: [String]
        public let instantiated: Int
        public let disposed: Int
    }

    /// At most `capacity` live artboards, most-recently-visible first. An offscreen row is
    /// DEMOTED rather than disposed (it keeps its instance while there is room) and is evicted
    /// before any visible one; eviction disposes, and a returning row is re-instantiated. That
    /// re-instantiation is the price of the cap and the corpus counts it, because "bounded
    /// memory" is a number a fixture can assert while an allocation is not.
    public static func residency(capacity: Double, events: [ResidencyEvent]) -> ResidencyFold {
        let cap = Int(max(1, (capacity.isFinite ? capacity : 1).rounded(.down)))
        var live: [String] = []
        var instantiated = 0
        var disposed = 0
        for event in events {
            let at = live.firstIndex(of: event.key)
            if !event.visible {
                if let at {
                    live.remove(at: at)
                    live.append(event.key)
                }
                continue
            }
            if let at { live.remove(at: at) } else { instantiated += 1 }
            live.insert(event.key, at: 0)
            while live.count > cap {
                live.removeLast()
                disposed += 1
            }
        }
        return ResidencyFold(live: live, instantiated: instantiated, disposed: disposed)
    }

    // MARK: - event payloads

    public struct StateChange: Equatable {
        public let machine: String
        public let state: String
    }

    /// `on:stateChange` fires on a TRANSITION, never on an advance: a state that survives sixty
    /// frames is one emission, and returning to a previous state emits again.
    public static func stateChanges(machine: String, states: [String?]) -> [StateChange] {
        var out: [StateChange] = []
        var last: String?
        for raw in states {
            let name = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if name.isEmpty || name == last { continue }
            last = name
            out.append(StateChange(machine: machine, state: name))
        }
        return out
    }

    /// A rive event property, after coercion. Booleans, finite numbers and strings survive;
    /// anything else is dropped, because a bus payload is data and a handle is not portable.
    public enum EventProperty: Equatable {
        case bool(Bool)
        case number(Double)
        case text(String)
    }

    public struct EventPayload: Equatable {
        public let name: String
        public let properties: [String: EventProperty]
    }

    public struct EventFold {
        public let payload: EventPayload?
        public let dropped: Int
    }

    /// `on:event` is `{name, properties}`. Properties keep booleans, finite numbers and
    /// strings, in sorted key order so three renderers agree; anything else is dropped and
    /// counted.
    ///
    /// A Rive `openUrl` event arrives here as ordinary properties (`url`, `target`) and NOTHING
    /// NAVIGATES. The .riv file is an asset, and an asset that could open a URL by itself would
    /// be a hole an OTA-delivered animation walks straight through.
    public static func eventPayload(name: String?, properties: [String: BoundValue]) -> EventFold {
        let trimmed = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return EventFold(payload: nil, dropped: 0) }
        var out: [String: EventProperty] = [:]
        var dropped = 0
        for key in properties.keys.sorted() {
            switch properties[key] ?? .absent {
            case .bool(let flag): out[key] = .bool(flag)
            case .text(let text): out[key] = .text(text)
            case .number(let value):
                if value.isFinite { out[key] = .number(round6(value)) } else { dropped += 1 }
            case .absent: dropped += 1
            }
        }
        return EventFold(payload: EventPayload(name: trimmed, properties: out), dropped: dropped)
    }

    public struct LoadPayload: Equatable {
        public let artboard: String?
        public let stateMachine: String?
        public let animation: String?
        public let width: Double
        public let height: Double
    }

    /// `on:load` carries the resolved selection plus the artboard's INTRINSIC size, which is
    /// what a caller needs to size a box around it.
    public static func loadPayload(_ selection: Selection, width: Double, height: Double) -> LoadPayload {
        LoadPayload(artboard: selection.artboard, stateMachine: selection.stateMachine,
                    animation: selection.animation,
                    width: round6(width.isFinite ? width : 0),
                    height: round6(height.isFinite ? height : 0))
    }

    public static let errorMessages: [String: String] = [
        "not_found": "the artboard, state machine or animation this <rive> names is not in the file",
        "no_source": "<rive> has no src",
        "decode_failed": "this .riv file could not be decoded",
        "load_failed": "the .riv file could not be loaded",
        "unsupported_platform": "this platform ships no Rive runtime",
    ]

    public struct ErrorPayload: Equatable {
        public let code: String
        public let message: String
    }

    /// `on:error` over a closed code set; an unknown code keeps the code and takes the generic
    /// message rather than vanishing, and a blank code IS `load_failed`.
    public static func errorPayload(_ code: String?) -> ErrorPayload {
        var resolved = (code ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if resolved.isEmpty { resolved = "load_failed" }
        return ErrorPayload(code: resolved,
                            message: errorMessages[resolved] ?? "this <rive> could not be played")
    }

    // MARK: - accessibility

    /// the same ten gesture words `<canvas>` uses. `on:stateChange` and `on:event` are absent
    /// on purpose: an animation reporting what it did is not a control.
    public static let gestureHandlers: [String] = [
        "on:tap", "on:doubletap", "on:longpress", "on:drag", "on:pan",
        "on:pinch", "on:rotate", "on:swipe", "on:press", "on:adjust",
    ]

    public static let a11yLintCode = "rive-a11y-label"
    public static let a11yLintMessage =
        "<rive> with a gesture handler needs a11yLabel — an animation is opaque to assistive tech"

    public struct A11yChild: Equatable {
        public let role: String
        public let label: String
        public let value: String?

        public init(role: String, label: String, value: String?) {
            self.role = role
            self.label = label
            self.value = value
        }
    }

    public struct A11yLint: Equatable {
        public let code: String
        public let level: String
        public let message: String
    }

    public struct A11yVerdict {
        public let interactive: Bool
        public let label: String?
        public let children: [A11yChild]
        public let role: String
        public let hidden: Bool
        public let lint: A11yLint?
    }

    /// The `<canvas>` verdict shape applied to an animation: same six fields, same
    /// three-surface fold, one extra input. A Rive state machine can carry its OWN pointer
    /// listeners inside the .riv file, so the component can be interactive with no `on:`
    /// handler in sight. That flips `interactive` and the role but emits NO lint, because the
    /// linter reads markup and markup cannot see inside an asset. Two verdicts, one fold, and
    /// the difference is stated rather than fudged.
    public static func a11y(attrs: [String: String],
                            a11yChildren: [A11yChild] = [],
                            hasListeners: Bool = false) -> A11yVerdict {
        let handled = gestureHandlers.contains { name in
            !((attrs[name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)).isEmpty
        }
        let interactive = handled || hasListeners
        let trimmed = (attrs["a11yLabel"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let label: String? = trimmed.isEmpty ? nil : trimmed
        let declared = label != nil || !a11yChildren.isEmpty
        let role: String
        if !a11yChildren.isEmpty {
            role = "group"
        } else if interactive {
            role = label != nil ? "button" : "group"
        } else {
            role = label != nil ? "image" : "none"
        }
        return A11yVerdict(
            interactive: interactive,
            label: label,
            children: a11yChildren,
            role: role,
            hidden: !interactive && !declared,
            lint: handled && !declared
                ? A11yLint(code: a11yLintCode, level: "error", message: a11yLintMessage)
                : nil)
    }
}
