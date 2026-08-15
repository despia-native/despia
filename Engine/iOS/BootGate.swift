//
//  BootGate.swift — composable launch gates  (dsx.boot.gate)
//
//  A GATE holds the launch until it is satisfied — optionally showing its OWN screen — then hands
//  off. Gates COMPOSE: any boot-tier package registers one with `dsx.boot.gate(priority:when:)`; the
//  kernel runs them HIGHEST-PRIORITY-FIRST, one at a time, and the app mounts only after the last one
//  settles. A gate that never settles is a hard block (e.g. a forced-update screen). Scalable (any
//  number of gates), reusable (any package), self-contained (a gate reads its OWN config in `when` —
//  never a host global).
//
//      // a boot-tier package (e.g. AppLock):
//      dsx.boot.gate(priority: 100, when: config.enabled) { dsx in
//          dsx.component.mount("AppLock")     // this gate's screen (shown while it runs)
//          unlock { dsx.resolve() }           // settle → the boot advances to the next gate / mounts
//      }
//
//  `resolve` is the SAME primitive an action uses, not a new verb: the runner invokes each gate as a
//  boot-time OPERATION — a `Context` whose terminal continuation advances the chain — so `dsx.resolve()`
//  here means exactly "this operation is done," identical to web/native callers. The gate's screen is
//  simply whatever it `dsx.component.mount`s; the runner installs it (no return value, no boilerplate).
//
//  The chain is run once, by the kernel's app-entry, via `BootGates.run(present:then:)`.
//

import UIKit

extension Context {
    /// The boot-phase namespace. `dsx.boot.gate(...)` registers a composable launch gate.
    public var boot: BootProxy { BootProxy(dsx: self) }
}

public struct BootProxy {
    let dsx: Context

    /// Register a launch GATE. It runs before the app mounts (highest `priority` first); show a screen
    /// with `dsx.component.mount(...)`, do your work (sync or async), then `dsx.resolve()` to advance.
    /// `when` (default `true`) scopes it — `false` ⇒ the gate is skipped. Keep it self-contained: read
    /// the package's OWN config in `when`, never a host global.
    public func gate(priority: Int = 0,
                     when: @autoclosure @escaping () -> Bool = true,
                     _ handler: @escaping (Context) -> Void) {
        BootGates.register(BootGate(priority: priority, when: when, store: dsx.store, run: handler))
    }
}

/// One registered gate. `store` is the registering package's `Registration` — the runner builds the
/// gate's per-run `Context` from it, so `dsx.*` inside the handler is that package's context.
struct BootGate {
    let priority: Int
    let when: () -> Bool
    let store: Registration
    let run: (Context) -> Void
}

/// The launch gate chain. Registration is global (any boot-tier package contributes); the kernel runs
/// the chain exactly once at launch.
enum BootGates {
    private static var registered: [BootGate] = []

    static func register(_ gate: BootGate) { registered.append(gate) }

    /// Run the gates highest-priority-first, in SEQUENCE — each settles via `dsx.resolve()` (which
    /// advances) — then call `mount`. A gate that mounts a screen has it `present`ed while it runs.
    /// No gates (or all `when`-skipped) → `mount` immediately. A gate that never resolves holds the
    /// launch (an intentional hard block).
    static func run(present: @escaping (UIViewController) -> Void, then mount: @escaping () -> Void) {
        let chain = registered.filter { $0.when() }.sorted { $0.priority > $1.priority }
        func step(_ i: Int) {
            guard i < chain.count else { mount(); return }
            let gate = chain[i]
            var advanced = false
            let advance = { if !advanced { advanced = true; step(i + 1) } }   // idempotent
            // The gate runs as a boot OPERATION: its Context's terminal (dsx.resolve / dsx.error)
            // advances the chain — the very continuation an action's native caller awaits.
            let params = Bridge.Params(dict: [:]) { _ in advance() }
            let dsx = Context(store: gate.store, scheme: "boot", host: "gate",
                              url: URL(string: "boot://gate")!, params: params)
            gate.run(dsx)
            if let surface = dsx.lastMount {
                present(surface.windowRootController)  // a gate replaces the UIWindow root
            }
        }
        step(0)
    }
}
