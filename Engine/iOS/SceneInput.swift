//
//  SceneInput.swift - G4 UNIFIED INPUT, the Swift twin of the web kernel's input.ts and
//  Android's despia.engine.input.SceneInput (dsx-game.md §2 G4), corpus
//  OpenSource/Conformance/input/{mappings,axis,attenuation}.json.
//
//  ONE head declaration — `<input as="jump" keys="Space ArrowUp" gamepad="A" touch="tap"/>` —
//  bound to keyboard, gamepad and touch on every target. This file owns the two halves that
//  MUST be identical on all three runtimes:
//
//    1 · RESOLUTION — declaration attributes → one `InputBinding`, every unknown word
//        dropped behind exactly ONE Article-7 diagnostic.
//    2 · THE FOLD — raw device events → per-name pressed/axis values + press-edge events.
//
//  Everything platform-shaped stays OUTSIDE: StackInputHost (below) binds UIKit
//  pressesBegan/pressesEnded and the GameController framework, and the scene element
//  dispatches `on:input.<name>`. Keeping the DECISION separate from the PLUMBING is what
//  lets one corpus judge three runtimes. The record-lane leg is
//  ConformanceHosts.InputConformance.
//
//  The law in full: OpenSource/Conformance/input/README.md ("The G4 laws — unified input").
//

import Foundation

/// Analog stick deadzone when a declaration does not name one.
let INPUT_DEFAULT_DEADZONE: Double = 0.15
/// Largest deadzone a declaration may ask for; beyond it the stick would be unusable.
let INPUT_MAX_DEADZONE: Double = 0.9

/// One resolved binding — the record every runtime folds device events against.
struct InputBinding: Equatable {
    let name: String
    let axis: Bool
    let deadzone: Double
    /// button mode: any-of. axis mode: exactly 0 or 4, positional [up, left, down, right].
    let keys: [String]
    /// gamepad button words. axis mode: exactly 0 or 4, positional.
    let buttons: [String]
    /// gamepad stick words (axis mode only).
    let sticks: [String]
    /// touch gesture words (button mode only).
    let touch: [String]
}

/// One Article-7 diagnostic; `word` names the offending token when the defect is one word.
struct InputDiagnostic: Equatable {
    let code: String
    let name: String
    let word: String?
    init(_ code: String, _ name: String, _ word: String? = nil) {
        self.code = code; self.name = name; self.word = word
    }
}

struct InputResolution {
    let bindings: [InputBinding]
    let diagnostics: [InputDiagnostic]
}

/// A gamepad snapshot as every platform can produce it.
struct InputPadSnapshot {
    let buttons: [Double]
    let axes: [Double]
}

/// A press-edge event; the payload a `on:input.<name>` handler receives.
struct InputEvent: Equatable {
    let name: String
    let x: Double
    let y: Double
}

/// One frame's fold: live values (Bool for a button, (x, y) for an axis) + the edges.
struct InputCommit {
    /// name → Bool for a button, [Double] of two elements for an axis
    let values: [String: Any]
    let events: [InputEvent]
}

/// The positional-audio fold's result.
struct AudioAttenuation: Equatable {
    let distance: Double
    let gain: Double
    let pan: Double
}

enum SceneInput {

    /// Canonical gamepad button words → the W3C standard-mapping button index.
    static let padButtons: [String: Int] = [
        "A": 0, "B": 1, "X": 2, "Y": 3, "L": 4, "R": 5, "L2": 6, "R2": 7,
        "Select": 8, "Start": 9, "LStick": 10, "RStick": 11,
        "DPadUp": 12, "DPadDown": 13, "DPadLeft": 14, "DPadRight": 15,
    ]

    /// Canonical stick words → their (x, y) indices in the standard-mapping axes array.
    static let padSticks: [String: (Int, Int)] = [
        "leftStick": (0, 1), "rightStick": (2, 3),
    ]

    /// Shorthand key SETS. The order is POSITIONAL and load-bearing: [up, left, down, right].
    static let keySets: [String: [String]] = [
        "wasd": ["W", "A", "S", "D"],
        "arrows": ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"],
        "zqsd": ["Z", "Q", "S", "D"],
        "ijkl": ["I", "J", "K", "L"],
    ]

    /// Touch gesture words (authored lowercase → canonical).
    static let touchWords: [String: String] = [
        "tap": "tap", "hold": "hold",
        "swipeleft": "swipeLeft", "swiperight": "swipeRight",
        "swipeup": "swipeUp", "swipedown": "swipeDown",
    ]

    /// The momentary touch words — pressed for exactly the frame they arrive in.
    static let momentaryTouch: [String] = ["tap", "swipeLeft", "swipeRight", "swipeUp", "swipeDown"]

    private static let keyAliases: [String: String] = [
        "space": "Space",
        "arrowup": "ArrowUp", "up": "ArrowUp",
        "arrowdown": "ArrowDown", "down": "ArrowDown",
        "arrowleft": "ArrowLeft", "left": "ArrowLeft",
        "arrowright": "ArrowRight", "right": "ArrowRight",
        "enter": "Enter", "return": "Enter",
        "escape": "Escape", "esc": "Escape",
        "tab": "Tab", "shift": "Shift",
        "control": "Control", "ctrl": "Control",
        "alt": "Alt", "option": "Alt",
        "meta": "Meta", "cmd": "Meta", "command": "Meta",
        "backspace": "Backspace",
    ]

    private static let padAliases: [String: String] = [
        "a": "A", "b": "B", "x": "X", "y": "Y",
        "l": "L", "l1": "L", "lb": "L", "r": "R", "r1": "R", "rb": "R",
        "l2": "L2", "lt": "L2", "r2": "R2", "rt": "R2",
        "select": "Select", "back": "Select", "start": "Start",
        "lstick": "LStick", "l3": "LStick", "rstick": "RStick", "r3": "RStick",
        "dpadup": "DPadUp", "dpaddown": "DPadDown", "dpadleft": "DPadLeft", "dpadright": "DPadRight",
    ]

    /// One authored key word → its canonical key(s), or nil when it is not vocabulary.
    static func canonicalKeys(_ word: String) -> [String]? {
        let low = word.lowercased()
        if let set = keySets[low] { return set }
        if let alias = keyAliases[low] { return [alias] }
        if word.count == 1, let c = word.unicodeScalars.first {
            if (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") { return [word.uppercased()] }
            if c >= "0" && c <= "9" { return [word] }
        }
        return nil
    }

    private static func words(_ raw: String?) -> [String] {
        (raw ?? "").split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" })
            .map(String.init)
    }

    private static func isIdentifier(_ s: String) -> Bool {
        guard !s.isEmpty, s.count <= 64 else { return false }
        var first = true
        for c in s.unicodeScalars {
            let letter = (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c == "_"
            let digit = c >= "0" && c <= "9"
            if first { if !letter { return false }; first = false } else if !(letter || digit) { return false }
        }
        return true
    }

    /// Declarations → bindings. Pure and total: a malformed word never throws and never
    /// takes the rest of the binding with it — it drops behind ONE diagnostic (Article 7).
    static func resolveDeclarations(_ decls: [[String: String]]) -> InputResolution {
        var bindings: [InputBinding] = []
        var diagnostics: [InputDiagnostic] = []
        var seen = Set<String>()
        for d in decls {
            let name = (d["as"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard isIdentifier(name) else {
                diagnostics.append(InputDiagnostic("input-as", name))
                continue
            }
            if seen.contains(name) {
                diagnostics.append(InputDiagnostic("input-duplicate", name))
                continue
            }
            seen.insert(name)

            let rawAxis = d["axis"] ?? ""
            var axis = false
            if !rawAxis.isEmpty {
                if rawAxis == "true" { axis = true }
                else if rawAxis != "false" { diagnostics.append(InputDiagnostic("input-axis", name, rawAxis)) }
            }

            var deadzone = INPUT_DEFAULT_DEADZONE
            let rawDz = (d["deadzone"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !rawDz.isEmpty {
                if let v = Double(rawDz), v.isFinite, v >= 0.0, v <= INPUT_MAX_DEADZONE {
                    deadzone = v
                } else {
                    diagnostics.append(InputDiagnostic("input-deadzone", name, rawDz))
                }
            }

            var keys: [String] = []
            for w in words(d["keys"]) {
                guard let got = canonicalKeys(w) else {
                    diagnostics.append(InputDiagnostic("input-key", name, w)); continue
                }
                for k in got where !keys.contains(k) { keys.append(k) }
            }

            var buttons: [String] = []
            var sticks: [String] = []
            for w in words(d["gamepad"]) {
                let low = w.lowercased()
                if low == "leftstick" || low == "rightstick" {
                    let stick = low == "leftstick" ? "leftStick" : "rightStick"
                    if !sticks.contains(stick) { sticks.append(stick) }
                    continue
                }
                if let button = padAliases[low] {
                    if !buttons.contains(button) { buttons.append(button) }
                    continue
                }
                diagnostics.append(InputDiagnostic("input-gamepad", name, w))
            }

            var touch: [String] = []
            for w in words(d["touch"]) {
                guard let canonical = touchWords[w.lowercased()] else {
                    diagnostics.append(InputDiagnostic("input-touch", name, w)); continue
                }
                if !touch.contains(canonical) { touch.append(canonical) }
            }

            // Mode constraints — an axis reads its legs POSITIONALLY, so a wrong count is
            // not a usable axis and drops loudly rather than half-working.
            if axis {
                if !keys.isEmpty && keys.count != 4 {
                    diagnostics.append(InputDiagnostic("input-axis-keys", name)); keys = []
                }
                if !buttons.isEmpty && buttons.count != 4 {
                    diagnostics.append(InputDiagnostic("input-axis-buttons", name)); buttons = []
                }
                if !touch.isEmpty {
                    diagnostics.append(InputDiagnostic("input-touch-axis", name)); touch = []
                }
            } else if !sticks.isEmpty {
                diagnostics.append(InputDiagnostic("input-stick-button", name)); sticks = []
            }

            bindings.append(InputBinding(name: name, axis: axis, deadzone: deadzone,
                                         keys: keys, buttons: buttons, sticks: sticks, touch: touch))
        }
        return InputResolution(bindings: bindings, diagnostics: diagnostics)
    }

    /// The DIGITAL fold: four booleans → a vector, +x right / +y up, diagonals normalized.
    static func digitalAxis(up: Bool, left: Bool, down: Bool, right: Bool) -> (Double, Double) {
        var x = (right ? 1.0 : 0.0) - (left ? 1.0 : 0.0)
        var y = (up ? 1.0 : 0.0) - (down ? 1.0 : 0.0)
        // sqrt-of-squares, never hypot — the physics precedent: IEEE doubles must agree
        // across runtimes, and hypot()'s intermediate scaling is implementation-defined.
        let len = (x * x + y * y).squareRoot()
        if len > 1.0 { x /= len; y /= len }
        return (x, y)
    }

    /// The ANALOG fold: a raw stick pair → a vector. Raw Y is DOWN-positive on every
    /// platform, so it is negated here and the +y-up convention holds everywhere. The
    /// deadzone applies RADIALLY and then rescales, so the live range stays a full 0..1 and
    /// the magnitude never exceeds 1 (an overshooting stick clamps to the unit circle).
    static func analogAxis(rawX: Double, rawY: Double, deadzone: Double) -> (Double, Double) {
        let x = rawX
        let y = -rawY
        let len = (x * x + y * y).squareRoot()
        if len <= deadzone { return (0.0, 0.0) }
        let clamped = len > 1.0 ? 1.0 : len
        let scale = ((clamped - deadzone) / (1.0 - deadzone)) / len
        return (x * scale, y * scale)
    }

    /// The positional-audio FOLD (corpus attenuation.json). Pure math: no platform audio
    /// API is touched here, and none is touched by this rung at all — playing the folded
    /// numbers back through a real 3D mixer is the named absence in the G4 landing record.
    static func audioAttenuation(listener: [Double], source: [Double],
                                 ref: Double = 1.0, max maxDistance: Double = 50.0,
                                 rolloff: Double = 1.0) -> AudioAttenuation {
        let dx = source[0] - listener[0]
        let dy = source[1] - listener[1]
        let dz = source[2] - listener[2]
        let distance = (dx * dx + dy * dy + dz * dz).squareRoot()
        let clamped = distance < ref ? ref : (distance > maxDistance ? maxDistance : distance)
        let gain = ref / (ref + rolloff * (clamped - ref))
        let raw = distance == 0.0 ? 0.0 : dx / distance
        let pan = raw < -1.0 ? -1.0 : (raw > 1.0 ? 1.0 : raw)
        return AudioAttenuation(distance: distance, gain: gain, pan: pan)
    }
}

/// The fold, as a small mutable machine. Every platform pushes raw events in and calls
/// `commit()` once per frame; the machine owns the edge law and the momentary-touch pulse.
final class InputMachine {

    private(set) var bindings: [InputBinding]
    private var down = Set<String>()
    private var pad: InputPadSnapshot?
    private var pulse = Set<String>()
    private var held = Set<String>()
    private var prev: [String: Bool] = [:]

    init(_ bindings: [InputBinding]) {
        self.bindings = bindings
        for b in bindings { prev[b.name] = false }
    }

    /// Replace the whole binding table (a re-declared surface), keeping no stale edges.
    func reset(_ next: [InputBinding]) {
        bindings = next
        prev.removeAll()
        for b in next { prev[b.name] = false }
    }

    func keyDown(_ key: String) { down.insert(key) }
    func keyUp(_ key: String) { down.remove(key) }
    /// Every held key released — the resign-active / app-background case.
    func releaseKeys() { down.removeAll() }
    func gamepad(_ snapshot: InputPadSnapshot?) { pad = snapshot }
    /// A touch gesture arrived. `hold` becomes sustained; everything else is a one-frame pulse.
    func touch(_ word: String) { if word == "hold" { held.insert(word) } else { pulse.insert(word) } }
    func touchRelease(_ word: String) { held.remove(word) }

    private func padButton(_ word: String) -> Bool {
        guard let snapshot = pad, let index = SceneInput.padButtons[word],
              index < snapshot.buttons.count else { return false }
        return snapshot.buttons[index] > 0.0
    }

    /// Fold one frame: live values + the press-edge events, then clear the momentary pulse.
    func commit() -> InputCommit {
        var values: [String: Any] = [:]
        var events: [InputEvent] = []
        for b in bindings {
            var pressed = false
            var persistentPressed = false
            var x = 0.0
            var y = 0.0
            if b.axis {
                var vec: (Double, Double)?
                if let snapshot = pad {
                    for stick in b.sticks {
                        guard let idx = SceneInput.padSticks[stick] else { continue }
                        let rx = idx.0 < snapshot.axes.count ? snapshot.axes[idx.0] : 0.0
                        let ry = idx.1 < snapshot.axes.count ? snapshot.axes[idx.1] : 0.0
                        let candidate = SceneInput.analogAxis(rawX: rx, rawY: ry, deadzone: b.deadzone)
                        if candidate.0 != 0.0 || candidate.1 != 0.0 { vec = candidate; break }
                    }
                }
                if vec == nil {
                    let k: [String]? = b.keys.count == 4 ? b.keys : nil
                    let p: [String]? = b.buttons.count == 4 ? b.buttons : nil
                    func dir(_ i: Int) -> Bool {
                        (k != nil && down.contains(k![i])) || (p != nil && padButton(p![i]))
                    }
                    vec = SceneInput.digitalAxis(up: dir(0), left: dir(1), down: dir(2), right: dir(3))
                }
                x = vec!.0
                y = vec!.1
                values[b.name] = [x, y]
                pressed = x != 0.0 || y != 0.0
                persistentPressed = pressed
            } else {
                let keyOrPad = b.keys.contains(where: { down.contains($0) })
                    || b.buttons.contains(where: { padButton($0) })
                let heldTouch = b.touch.contains(where: { held.contains($0) })
                let momentaryTouch = b.touch.contains(where: { pulse.contains($0) })
                persistentPressed = keyOrPad || heldTouch
                pressed = persistentPressed || momentaryTouch
                values[b.name] = pressed
            }
            if pressed && prev[b.name] != true { events.append(InputEvent(name: b.name, x: x, y: y)) }
            // A momentary touch exists for this commit only. Rearm it immediately while
            // retaining genuinely held key/pad/hold state; contact hosts commit on edges.
            prev[b.name] = persistentPressed
        }
        pulse.removeAll()
        return InputCommit(values: values, events: events)
    }
}

/// UIKit key plumbing: a `UIKeyboardHIDUsage` raw value → the canonical kernel key word,
/// or nil when the key is outside the vocabulary. Kept beside the table it serves so the
/// element lane never re-invents the vocabulary. (The HID usage table is layout-INDEPENDENT,
/// which is exactly what a game binding wants — WASD stays under the same fingers.)
func hidUsageToCanonical(_ usage: Int) -> String? {
    switch usage {
    case 0x2C: return "Space"          // keyboardSpacebar
    case 0x52: return "ArrowUp"
    case 0x51: return "ArrowDown"
    case 0x50: return "ArrowLeft"
    case 0x4F: return "ArrowRight"
    case 0x28: return "Enter"          // keyboardReturnOrEnter
    case 0x29: return "Escape"
    case 0x2B: return "Tab"
    case 0xE1, 0xE5: return "Shift"
    case 0xE0, 0xE4: return "Control"
    case 0xE2, 0xE6: return "Alt"
    case 0xE3, 0xE7: return "Meta"
    case 0x2A: return "Backspace"      // keyboardDeleteOrBackspace
    case 0x04...0x1D:                  // keyboardA … keyboardZ
        let scalar = UnicodeScalar(UInt8(65 + (usage - 0x04)))
        return String(Character(scalar))
    case 0x1E...0x26:                  // keyboard1 … keyboard9
        let scalar = UnicodeScalar(UInt8(49 + (usage - 0x1E)))
        return String(Character(scalar))
    case 0x27: return "0"              // keyboard0
    default: return nil
    }
}

/// Pointer-gesture recognition thresholds, identical to the web and Compose recognizers so
/// the touch words mean the same thing on every surface.
enum InputGestureLimits {
    static let tapMaxMs: Double = 250
    static let tapMaxPoints: Double = 10
    static let holdMs: Double = 350
    static let swipeMinPoints: Double = 32
    static let swipeMaxMs: Double = 600

    /// Classify a completed touch stroke into a touch word, or nil when it is neither.
    static func classify(dx: Double, dy: Double, dtMs: Double) -> String? {
        let adx = abs(dx)
        let ady = abs(dy)
        if dtMs <= tapMaxMs && adx <= tapMaxPoints && ady <= tapMaxPoints { return "tap" }
        if dtMs <= swipeMaxMs && (adx >= swipeMinPoints || ady >= swipeMinPoints) {
            if adx >= ady { return dx > 0 ? "swipeRight" : "swipeLeft" }
            return dy > 0 ? "swipeDown" : "swipeUp"
        }
        return nil
    }
}
