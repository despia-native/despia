//
//  StackInputHost.swift - the APP-WIDE G4 input runtime + its UIKit / GameController
//  plumbing (dsx-game.md §2 G4).
//
//  The DECISIONS live in SceneInput.swift (corpus-pinned, three runtimes). This file carries
//  them at runtime:
//
//    • `DsxInputRuntime` — the merged binding table across every surface that declared
//      `<input>` in its head, the ONE InputMachine, publication of each binding's live value
//      onto the reactive app store as `global.input.<name>` (so `dsx.input.jump` is an
//      ordinary tracked read — JSE.normalizeScope maps the `input` scope word), and the
//      press-edge subscription the `on:input.<name>` handlers ride.
//    • `StackInputResponder` — a UIKit responder that turns pressesBegan/pressesEnded into
//      canonical key words (HID usages: layout-INDEPENDENT by construction).
//    • The GameController bridge — a connected controller's buttons/sticks folded into one
//      snapshot per poll.
//
//  THE LOOP-EXISTENCE LAW, APPLIED TO INPUT: keyboard and touch commit on the EVENT EDGE and
//  never spin a loop. Only a gamepad must be polled, and only while some binding declares a
//  gamepad leg AND a controller is connected — `pollGamepad()` is called from whatever frame
//  loop already exists (the scene element's CADisplayLink), exactly like the web lane.
//

import Foundation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(GameController)
import GameController
#endif

/// The app-wide input runtime. Main-actor by convention (every caller is a UI path); the
/// registration table prunes owners whose surface store has been released.
final class DsxInputRuntime {

    static let shared = DsxInputRuntime()

    private final class Registration {
        weak var owner: AnyObject?
        var declarations: [[String: String]]
        init(owner: AnyObject, declarations: [[String: String]]) {
            self.owner = owner
            self.declarations = declarations
        }
    }

    private var registrations: [ObjectIdentifier: Registration] = [:]
    private var subscribers: [String: [(token: ObjectIdentifier, handler: (InputEvent) -> Void)]] = [:]
    private let machine = InputMachine([])
    private var published: [String: Any] = [:]

    /// Diagnostics from the LAST rebuild — the Article-7 ledger a host may surface.
    private(set) var diagnostics: [InputDiagnostic] = []

    /// The live resolved table — introspection for hosts and tests.
    var bindings: [InputBinding] { machine.bindings }

    private init() {}

    /// Register one surface's head `<input>` declarations, keyed by its store.
    func register(owner: AnyObject, declarations: [[String: String]]) {
        guard !declarations.isEmpty else { return }
        let key = ObjectIdentifier(owner)
        if let existing = registrations[key], existing.declarations == declarations { return }
        registrations[key] = Registration(owner: owner, declarations: declarations)
        rebuild()
    }

    func unregister(owner: AnyObject) {
        guard registrations.removeValue(forKey: ObjectIdentifier(owner)) != nil else { return }
        rebuild()
    }

    private func rebuild() {
        // Prune owners whose surface has gone; a released screen must not keep binding keys.
        for (key, registration) in registrations where registration.owner == nil {
            registrations.removeValue(forKey: key)
        }
        let all = registrations.values.flatMap { $0.declarations }
        let resolved = SceneInput.resolveDeclarations(all)
        diagnostics = resolved.diagnostics
        machine.reset(resolved.bindings)
        // Seed every declared name so a read BEFORE any device event is the honest resting
        // value rather than nil (the typed-absence rule).
        var next: [String: Any] = [:]
        for b in resolved.bindings { next[b.name] = b.axis ? [0.0, 0.0] : false }
        for (name, value) in next where !sameValue(published[name], value) {
            DSX.state.setPath("input.\(name)", axisDict(value))
        }
        for name in published.keys where next[name] == nil {
            DSX.state.setPath("input.\(name)", NSNull())
        }
        published = next
    }

    private func sameValue(_ a: Any?, _ b: Any?) -> Bool {
        if let x = a as? Bool, let y = b as? Bool { return x == y }
        if let x = a as? [Double], let y = b as? [Double] { return x == y }
        return a == nil && b == nil
    }

    /// An axis publishes as `{ x, y }` so `dsx.input.move.x` is an ordinary path read.
    private func axisDict(_ value: Any) -> Any {
        if let pair = value as? [Double], pair.count == 2 { return ["x": pair[0], "y": pair[1]] }
        return value
    }

    /// Subscribe to a binding's press EDGE — the `on:input.<name>` consumer path.
    func subscribe(_ name: String, token: AnyObject, handler: @escaping (InputEvent) -> Void) {
        subscribers[name, default: []].append((ObjectIdentifier(token), handler))
    }

    func unsubscribe(_ name: String, token: AnyObject) {
        let id = ObjectIdentifier(token)
        subscribers[name]?.removeAll { $0.token == id }
        if subscribers[name]?.isEmpty == true { subscribers.removeValue(forKey: name) }
    }

    func keyDown(_ key: String) { machine.keyDown(key) }
    func keyUp(_ key: String) { machine.keyUp(key) }
    func releaseKeys() { machine.releaseKeys() }
    func touch(_ word: String) { machine.touch(word) }
    func touchRelease(_ word: String) { machine.touchRelease(word) }

    /// Does any declared binding name a gamepad leg? (the polling gate)
    func wantsGamepad() -> Bool {
        machine.bindings.contains { !$0.buttons.isEmpty || !$0.sticks.isEmpty }
    }

    /// Fold one frame: publish changed values, then dispatch the press edges.
    func commit() {
        let result = machine.commit()
        for (name, value) in result.values where !sameValue(published[name], value) {
            published[name] = value
            DSX.state.setPath("input.\(name)", axisDict(value))
        }
        guard !result.events.isEmpty else { return }
        for event in result.events {
            for entry in subscribers[event.name] ?? [] { entry.handler(event) }
        }
    }

    /// Poll the connected controller and commit. Called from whatever frame loop already
    /// exists — this runtime never starts one of its own.
    func pollGamepad() {
        guard wantsGamepad() else { return }
        #if canImport(GameController)
        guard let pad = GCController.controllers().first?.extendedGamepad else {
            machine.gamepad(nil)
            commit()
            return
        }
        // The standard-mapping order the corpus pins (SceneInput.padButtons).
        var buttons = [Double](repeating: 0, count: 16)
        func set(_ word: String, _ pressed: Bool) {
            if let i = SceneInput.padButtons[word] { buttons[i] = pressed ? 1 : 0 }
        }
        set("A", pad.buttonA.isPressed)
        set("B", pad.buttonB.isPressed)
        set("X", pad.buttonX.isPressed)
        set("Y", pad.buttonY.isPressed)
        set("L", pad.leftShoulder.isPressed)
        set("R", pad.rightShoulder.isPressed)
        set("L2", pad.leftTrigger.isPressed)
        set("R2", pad.rightTrigger.isPressed)
        set("Select", pad.buttonOptions?.isPressed ?? false)
        set("Start", pad.buttonMenu.isPressed)
        set("LStick", pad.leftThumbstickButton?.isPressed ?? false)
        set("RStick", pad.rightThumbstickButton?.isPressed ?? false)
        set("DPadUp", pad.dpad.up.isPressed)
        set("DPadDown", pad.dpad.down.isPressed)
        set("DPadLeft", pad.dpad.left.isPressed)
        set("DPadRight", pad.dpad.right.isPressed)
        // GameController reports +y UP; the corpus fold expects the raw DOWN-positive Y of
        // the web/Android APIs and negates it, so hand it the negated value here — the
        // ONE place this platform difference is spelled out.
        let axes: [Double] = [
            Double(pad.leftThumbstick.xAxis.value), Double(-pad.leftThumbstick.yAxis.value),
            Double(pad.rightThumbstick.xAxis.value), Double(-pad.rightThumbstick.yAxis.value),
        ]
        machine.gamepad(InputPadSnapshot(buttons: buttons, axes: axes))
        #else
        machine.gamepad(nil)
        #endif
        commit()
    }
}

#if canImport(UIKit)
/// The UIKit keyboard door: a view that becomes first responder and turns hardware key
/// presses into canonical key words. Attached by the scene element (and by any surface that
/// wants keyboard bindings without a scene); an editable first responder always wins,
/// because UIKit routes the press to IT and never to this view.
final class StackInputResponderView: UIView {

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var canBecomeFirstResponder: Bool { true }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { becomeFirstResponder() } else { DsxInputRuntime.shared.releaseKeys() }
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for press in presses {
            guard let key = press.key,
                  let word = hidUsageToCanonical(key.keyCode.rawValue) else { continue }
            DsxInputRuntime.shared.keyDown(word)
            handled = true
        }
        if handled { DsxInputRuntime.shared.commit() } else { super.pressesBegan(presses, with: event) }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for press in presses {
            guard let key = press.key,
                  let word = hidUsageToCanonical(key.keyCode.rawValue) else { continue }
            DsxInputRuntime.shared.keyUp(word)
            handled = true
        }
        if handled { DsxInputRuntime.shared.commit() } else { super.pressesEnded(presses, with: event) }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        DsxInputRuntime.shared.releaseKeys()
        DsxInputRuntime.shared.commit()
        super.pressesCancelled(presses, with: event)
    }
}
#endif
