//
//  JSEActions.swift — the SATELLITE statement runner (watch-runtime.md W2).
//
//  The PORTABLE action grammar, executed on a satellite node (the watch; a keyboard next):
//  the statement set the cross-platform law already defines for markup that must run
//  everywhere (the monorepo working rules: "Actions ARE workflows" + the portable-idiom notes), over the SAME
//  corpus-pinned expression evaluator (JSE.swift) and the same state seam (JSEState).
//
//  WHY A FOURTH EXECUTOR, NOT AN EXTRACTION: the app's JSERunner (Stack.swift) is ~1,900
//  lines fused to the SwiftUI surface (mount/present/measuring/component expansion) — the
//  grammar already ships as three corpus-pinned implementations (Swift app · Kotlin
//  JseRunner.kt · TS runner.ts), and this is the satellite sibling of the Kotlin one:
//  pure logic over seams, no surface verbs. Its semantics follow the PINNED rules:
//    • `x = e` / `a.b.c = e` ALWAYS writes the STORE (never a block local) — the
//      bug-for-bug rule JseRunner.kt documents; reads prefer locals (JSE's item scope).
//    • loops are BUDGETED (shared work counter, 10_000) — a runaway loop yields, never hangs.
//    • `return`/`break`/`continue` are LOCAL to their action; only `throw` propagates.
//    • nested action calls are depth-capped at 32.
//  The next gate (per the execution plan) is running the actions corpus on a watch
//  simulator lane; until then the grammar's fidelity anchor is the Kotlin twin, which runs
//  that corpus in CI on every PR.
//
//  ASYNC BY CONSTRUCTION: `run` is `async` — `await dsx.module.s.a(args)` suspends on the
//  effects seam (the watch backs it with the WCSession relay; unreachable settles the
//  envelope immediately per the ADOPTED offline contract). The app runner's callback
//  machinery is not needed here.
//
//  Effects are a SEAM (`JSEActionEffects`) — the node injects its transports; nothing in
//  this file names WatchConnectivity, a router, or any surface. Foundation only.
//
//  ── DIAGNOSTICS ON A SATELLITE (the unified-primitives law, and where it bends) ────────
//  The monorepo working rules: "Diagnostics are unified primitives — never invent a bespoke error/log
//  channel." Both verbs are implemented HERE so the fourth executor is inside that law
//  rather than beside it — but a node is a constrained surface and the two halves land
//  differently. What follows is the honest divergence, not a summary of an ideal:
//
//   • `dsx.log(…)` — FULL FIDELITY, no divergence. `Logs.swift` and `JSELibrary.swift`
//     both ride the `logic` runtime tier this file rides (prepare_modules RUNTIME_TIERS),
//     so a node has the real ring and the real formatter: the house coercions
//     (`JSELogFormat.args` — canonical JSON, credential masking) → `reportLog` → the log
//     ring (`DSXLogBuffer`, cap 500) + one `[dsx.log] <scheme>: <message>` kernelLog line.
//     Byte-identical to the app runner (Stack.swift), the Kotlin twin (JseRunner.kt) and
//     the TS runner. The logs corpus (OpenSource/Conformance/logs/logs.json) runs its
//     markup cases through THIS runner in the Swift recorder — see
//     `LogsConformance.verifySatellite` (ConformanceHosts.swift).
//
//   • `dsx.error(…)` — PARTIAL, and deliberately so. The full ambient fan-out lives in
//     `Errors.swift`, which is NOT in the `logic` tier and cannot join it: its
//     `reportAmbientError` reaches `DSX.state` (the app-wide reactive store), the
//     `ModuleRegistry` (`module.error`), `DSXMessenger`/`DSXEvents` (the page channel) and
//     `JSON` — none of which exist in a satellite process. There is no ledger to append
//     to, no registry to fire a hook on, no page to mirror to, and no `global.*` plane at
//     all (`JSE.appVars` is bound only in DSXBoot.swift, an app-target file), so
//     `global.dsx.lastError` / `global.dsx.errorCount` are unreadable on a node by
//     construction. What a node DOES have is the kernel log sink, so that is what this
//     emits — the same `[dsx.error] <scheme> → <code>` line Errors.swift emits, widened to
//     carry the fields the missing ledger would otherwise have held (message, the
//     `(recoverable)` flag, and `data` through the masking formatter), because on a node
//     that one line is the whole record. It NEVER unwinds control flow and never throws.
//     NOT IMPLEMENTED on a satellite, and not faked: `dsx.errors` (the ring, cap 128),
//     the `module.error` hook, the page `dsx.on("dsx")` mirror, and the reactive
//     `global.dsx.*` keys. Closing that gap needs a node-side bus, which is the tracked
//     work — watch-runtime.md W5 ("one bus across nodes", cross-node `dsx.on` + proactive
//     push still open); the same section carries the diagnostics deferral. Do not paper
//     over it with a second, node-local ledger type: that is the bespoke channel the law
//     bans, and it would answer a `dsx.errors` read the node cannot serve anyway.
//
//   • An UNCAUGHT throw that unwinds an action is an error EMISSION with origin
//     "uncaught" (errors corpus §7), not a bespoke log line — it rides the same arm, with
//     the same corpus-pinned field derivation as `JSERunner.reportUncaughtThrow`. The
//     runner's own notices (unknown action, depth cap, loop budget) are NOT dsx.error
//     emissions and stay on the effects seam, where a node can route them.
//

import Foundation

/// What a satellite node lets actions DO — its transports and side effects. All optional in
/// spirit: a node that can't (no phone link) answers the documented failure envelope.
protocol JSEActionEffects: AnyObject {
    /// `dsx.event('name', {…})` — relay an event (the watch → the phone bus).
    func event(_ name: String, _ payload: [String: Any])
    /// `await dsx.module.<scheme>.<action>(args)` — resolve per the node's capability table
    /// (in-process → relay → `{ok:false,error:"unreachable"|"unsupported_on_surface"}`).
    func call(_ scheme: String, _ action: String, _ args: [String: Any]) async -> [String: Any]
    /// `await fetch(url, opts?)` — the node's network path (direct, else the link gateway).
    /// Envelope: `{ ok, status, body, json? }` (satellite fetch v1 — full Response parity
    /// arrives with the corpus lane).
    func fetch(_ url: String, _ opts: [String: Any]) async -> [String: Any]
    /// `setTimeout/setInterval(cb, ms, key)` — keyed; the node owns cancellation scope
    /// (the watch cancels on route/layout change). The callback body is re-run against the
    /// STORE (block locals are not captured across the timer boundary — portable subset).
    func setTimer(key: String, ms: Double, repeats: Bool, body: String)
    func clearTimer(key: String)
    /// `route.path = '/x'` / `dsx.module.route.push({path})` convenience on a satellite:
    /// navigate the node's OWN router.
    func navigate(_ path: String)
    /// The RUNNER'S OWN notices — unknown action, the depth cap, the loop budget. NOT the
    /// author's `dsx.log`/`dsx.error` (those are kernel primitives and go straight to the
    /// log ring / the kernel log sink — see the DIAGNOSTICS note in the file header), so a
    /// node may route these anywhere without bending the unified-diagnostics law.
    func log(_ line: String)
}

/// The portable callable surface of a declarative `<api>` block. Satellite runners
/// deliberately depend on this Foundation-only protocol instead of the concrete
/// `ApiBlock`, so the statement grammar remains independently compilable while a
/// host can still register the real production block.
@MainActor
protocol JSEApiHandle: AnyObject {
    func refresh(completion: (([String: Any]?) -> Void)?)
    func send(_ args: [String: Any]?, completion: (([String: Any]?) -> Void)?)
    func cancel()
}

/// Weak registry entry: the screen/runtime remains the sole lifecycle owner of its
/// blocks. Keeping only weak handles in the state prevents
/// runtime → state → handle → ApiBlock → state from becoming a retain cycle.
final class JSEApiHandleRef {
    weak var value: (any JSEApiHandle)?
    init(_ value: any JSEApiHandle) { self.value = value }
}

/// Optional state capability consumed by `JSEActionRunner`. Plain dictionary-backed
/// evaluator states need not implement it; WatchJSEState does when a screen mounts APIs.
protocol JSEApiHandleState: AnyObject {
    var apiHandles: [String: JSEApiHandleRef] { get set }
}

/// One action invocation's control-flow signal.
private enum JSEFlow { case normal, brk, cont, ret(Any?), thrown(Any?) }

/// The runner: statements over `JSEState` (shared with the evaluator) + `JSEActionEffects`.
/// One instance per surface; `actions` are the head-declared bodies (`<action as="x">…`).
/// @MainActor — a satellite surface is a SwiftUI world: the runner mutates the same state
/// the render reads and drives effects that schedule main-runloop timers, so bodies (and
/// every effects call they make) execute on the main actor; awaits merely suspend it.
/// Without this, run() rides the global executor and races the main-thread timer/sync
/// mutations of the same dictionaries (the Stack.swift "crash LATER" class).
@MainActor
final class JSEActionRunner {
    let state: any JSEState
    weak var effects: (any JSEActionEffects)?
    var actions: [String: String] = [:]           // head-declared: name → body
    /// Diagnostics ATTRIBUTION — the surface's owning package scheme, nil (⇒ "app") for
    /// unscoped markup. The satellite twin of `JSERunner.scope`: a node's BUNDLED screens
    /// are unscoped, which is why nothing sets this today, but the seam is what lets the
    /// logs corpus drive this runner with its per-case scheme and what a node that ever
    /// mounts package-owned screens sets. Reads only — never a control-flow input.
    var scope: String?
    private var depth = 0                          // nested dsx.action calls (cap 32)
    private var loopWork = 0                       // shared loop budget per entry action
    private var splitCache: [String: [String]] = [:]   // block → statements: timer/loop bodies re-run at 1Hz; split is pure on the exact string

    init(state: any JSEState, effects: any JSEActionEffects) {
        self.state = state
        self.effects = effects
    }

    /// Run an `on:` handler / action body. Entry point resets the ledgers (a fresh user
    /// gesture gets a fresh loop budget); nested action calls share them.
    func run(_ body: String, args: [String: Any] = [:]) async {
        if depth == 0 { loopWork = 0 }
        var locals = args
        let flow = await exec(block: Self.stripComments(body), locals: &locals)
        if case .thrown(let v) = flow {
            // UNCAUGHT CAPTURE (errors corpus §7): an uncaught throw is an error EMISSION
            // with origin "uncaught", never a bespoke log line. Control flow is already
            // unwound; recording changes nothing. Reported wherever the throw came to rest
            // — a `dsx.action.x()` STATEMENT call swallows the callee's flow (runNamed), so
            // the nested run is the only place that ever sees it; the awaited returning
            // form propagates instead (runNamedForValue) and reports once, at the top.
            reportUncaught(v, body: body)
        }
    }

    /// A named action (`dsx.action.x(args)` / bare `x()` / a timer body). Depth-capped.
    func runNamed(_ name: String, args: [String: Any] = [:]) async {
        guard let body = actions[name] else { effects?.log("[dsx] unknown action '\(name)'"); return }
        guard depth < 32 else { effects?.log("[dsx] action depth cap (32) at '\(name)'"); return }
        depth += 1
        await run(body, args: args)
        depth -= 1
    }

    /// `await dsx.action.<name>(args)` — the RETURNING action call (actions corpus
    /// `await-action-*`): the same depth-capped body run as runNamed, but KEEPING the
    /// callee's terminal flow — `.ret` carries the value for the caller's envelope and
    /// `.thrown` propagates to the caller's try/catch (never logged here, never
    /// enveloped). `break`/`continue`/falling off the end stay LOCAL to the callee
    /// (they normalize — the envelope then carries null data). Unknown action / the
    /// depth cap log-and-continue exactly like runNamed.
    private func runNamedForValue(_ name: String, args: [String: Any]) async -> JSEFlow {
        guard let body = actions[name] else { effects?.log("[dsx] unknown action '\(name)'"); return .normal }
        guard depth < 32 else { effects?.log("[dsx] action depth cap (32) at '\(name)'"); return .normal }
        depth += 1
        var locals = args
        let flow = await exec(block: Self.stripComments(body), locals: &locals)
        depth -= 1
        switch flow {
        case .ret, .thrown: return flow
        default: return .normal
        }
    }

    // MARK: - Statement execution

    private func exec(block: String, locals: inout [String: Any]) async -> JSEFlow {
        let stmts: [String]
        if let cached = splitCache[block] { stmts = cached }
        else {
            let fresh = Self.split(block)
            if splitCache.count >= 128 { splitCache.removeAll(keepingCapacity: true) }   // a screen's worth of bodies, never unbounded
            splitCache[block] = fresh
            stmts = fresh
        }
        for stmt in stmts {
            let flow = await exec(statement: stmt, locals: &locals)
            if case .normal = flow { continue }
            return flow
        }
        return .normal
    }

    private func exec(statement raw: String, locals: inout [String: Any]) async -> JSEFlow {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return .normal }

        // ── control flow keywords ──
        if s == "break" { return .brk }
        if s == "continue" { return .cont }
        if s == "return" { return .ret(nil) }
        if s.hasPrefix("return ") || s.hasPrefix("return(") {
            return .ret(eval(String(s.dropFirst(6)), locals))
        }
        if s.hasPrefix("throw ") { return .thrown(eval(String(s.dropFirst(6)), locals)) }

        // ── blocks: if / for / while / try (keyword BOUNDARY required — `format = 1` /
        //    `tryCount = 3` are assignments, not keywords) ──
        if s.hasPrefix("if ") || s.hasPrefix("if(") { return await execIf(s, &locals) }
        if s.hasPrefix("for ") || s.hasPrefix("for(") { return await execFor(s, &locals) }
        if s.hasPrefix("while ") || s.hasPrefix("while(") { return await execWhile(s, &locals) }
        if s.hasPrefix("try ") || s.hasPrefix("try{") { return await execTry(s, &locals) }

        // ── awaited declarative APIs: `[const NAME =|path =] await orders.send(…)`
        //    / `.refresh()`. The async runner can suspend directly, so unlike the
        //    callback-oriented app runner no source-string continuation is needed.
        //    Disposal/cancel settles the concrete ApiBlock completion with nil, which
        //    resumes deterministically instead of hanging an action across navigation. ──
        if let api = Self.parseAwaitApi(s), let handle = apiHandle(named: api.name) {
            let result: [String: Any]? = await withCheckedContinuation { continuation in
                let resume: ([String: Any]?) -> Void = { continuation.resume(returning: $0) }
                if api.verb == "refresh" {
                    handle.refresh(completion: resume)
                } else {
                    let raw = api.args.trimmingCharacters(in: .whitespacesAndNewlines)
                    let first = Self.splitArgs(raw).first ?? ""
                    let body = first.isEmpty ? nil : eval(first, locals) as? [String: Any]
                    handle.send(body, completion: resume)
                }
            }
            // Navigation disposes and unregisters the screen's handle. ApiBlock settles
            // its pending completion with nil, but the abandoned action must not resume
            // and write into the next screen's state universe.
            guard let current = apiHandle(named: api.name),
                  (current as AnyObject) === (handle as AnyObject) else {
                return .ret(nil)
            }
            if let bind = api.bind {
                if api.decl { locals[bind] = result ?? NSNull() }
                else { writePath(bind, result ?? NSNull()) }
            }
            return .normal
        }

        // ── awaited actions: `[const NAME =|path =] await dsx.action.name(args)` — the
        //    RETURNING action call (actions corpus `await-action-*`): run the callee via the
        //    SAME depth-capped path as a statement call — actions stay synchronous on a
        //    satellite too (they only suspend at their OWN awaits) — then bind the envelope
        //    { ok: true, data: <return value, null when it never returned> }, the dsx.module
        //    success shape. The decl form binds a block LOCAL; the assignment form writes
        //    the STORE (the pinned `x = e` rule); a `throw` that unwinds the callee
        //    propagates to the caller's try/catch as the real exception — never enveloped.
        //    Checked BEFORE declarations/assignment so those branches keep their paths.
        //    Satellite twin of matchAwaitAction (Stack.swift · JseRunner.kt). ──
        if let aa = Self.parseAwaitAction(s) {
            let callArgs = (eval(aa.args.isEmpty ? "{}" : aa.args, locals)) as? [String: Any] ?? [:]
            let flow = await runNamedForValue(aa.name, args: callArgs)
            if case .thrown = flow { return flow }
            var value: Any? = nil
            if case .ret(let r) = flow { value = r }
            let envelope: [String: Any] = ["ok": true, "data": value ?? NSNull()]
            if let bind = aa.bind {
                if aa.decl { locals[bind] = envelope } else { writePath(bind, envelope) }
            }
            return .normal
        }

        // ── declarations: const/let create BLOCK LOCALS (reads shadow the store; a later
        //    bare assignment still writes the store — the pinned portable rule) ──
        if s.hasPrefix("const ") || s.hasPrefix("let ") || s.hasPrefix("var ") {
            let rest = s.drop { $0 != " " }.trimmingCharacters(in: .whitespaces)
            if let eq = Self.topLevelIndex(of: "=", in: rest) {
                let name = String(rest[..<eq]).trimmingCharacters(in: .whitespaces)
                let rhs = String(rest[rest.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
                locals[name] = await evalAsync(rhs, &locals) ?? NSNull()
            }
            return .normal
        }

        // ── timers ──
        if let t = Self.parseTimer(s) {
            if t.clear { effects?.clearTimer(key: t.key) }
            else { effects?.setTimer(key: t.key, ms: t.ms, repeats: t.repeats, body: t.body) }
            return .normal
        }

        // ── dsx.event('name', {…}) ──
        if s.hasPrefix("dsx.event(") {
            let inner = Self.callArgs(of: s, prefix: "dsx.event")
            let parts = Self.splitArgs(inner)
            let name = JSE.string(eval(parts.first ?? "''", locals))
            let payload = (parts.count > 1 ? eval(parts[1], locals) : nil) as? [String: Any] ?? [:]
            effects?.event(name, payload)
            return .normal
        }

        // ── dsx.error(code, { message?, recoverable?, data? }) — the AMBIENT error hat
        //    (error-system.md §3.4). A markup action never holds a call to settle, so this is
        //    always the emission form. NEVER unwinds control flow — it is not a throw, it
        //    records; the next statement still runs. On a satellite the "record" is the
        //    kernelLog line and nothing else — the ledger/hook/page/global fan-out cannot
        //    exist on a node; see the DIAGNOSTICS note in the file header for the full,
        //    deliberate divergence. Claimed HERE, ahead of the api-handle / module /
        //    assignment parsers, so the verb is RECOGNIZED instead of falling through to the
        //    expression evaluator as a bogus member call — one screen authored once runs
        //    everywhere (Article 7), and a diagnostics primitive that silently vanishes on
        //    the fourth executor is exactly the bespoke-channel drift the law forbids. ──
        if s.hasPrefix("dsx.error("), s.hasSuffix(")") {
            let parts = Self.splitArgs(Self.callArgs(of: s, prefix: "dsx.error"))
            var code = JSE.string(eval(parts.first ?? "", locals))
            if code.isEmpty { code = "error" }
            let opts = (parts.count > 1 ? eval(parts[1], locals) : nil) as? [String: Any] ?? [:]
            report(error: code, message: opts["message"] as? String,
                   recoverable: JSE.truthy(opts["recoverable"]), data: opts["data"],
                   origin: "raised")
            return .normal
        }

        // ── dsx.log(…) — the unified console primitive (logs corpus). console.log-shaped
        //    variadic args through the HOUSE formatter (JSE coercions + canonical JSON +
        //    credential masking), recorded in the log ring attributed to the surface's
        //    owning scheme + one `[dsx.log]` kernelLog mirror line. Records, never unwinds,
        //    never throws. FULL parity with the other three runners here — the ring and the
        //    formatter both ride the `logic` tier, so a node needs no divergence at all. ──
        if s.hasPrefix("dsx.log("), s.hasSuffix(")") {
            let values = Self.splitArgs(Self.callArgs(of: s, prefix: "dsx.log")).map { eval($0, locals) }
            reportLog(scheme: attribution, level: "log", message: JSELogFormat.args(values))
            return .normal
        }

        // ── dsx.screen.settled() — the SCREEN-READINESS report (reference/screen-lifecycle.md;
        //    corpus lifecycle/readiness.json). A kernel verb of the dsx.log / dsx.error family:
        //    zero-arg, records, never unwinds, never throws. Past tense and only ever in CALL
        //    position, so it can never be confused with the read-only reactive PROPERTIES
        //    `dsx.screen.ready` (Bool) / `dsx.screen.phase` (String) that share the namespace.
        //
        //    On a SATELLITE it is the documented silent NO-OP. The readiness machine is keyed by
        //    the Router's `nav.stack` frame id (DSXScreenReadiness / ScreenReadiness), and a node's
        //    screens are not phone nav frames — this runner has no frame id at all, which is
        //    exactly the "off a nav frame (`frameId` nil — a mounted overlay, a bare surface) it is
        //    a silent no-op" arm the app runner (Stack.swift) and the Kotlin twin (JseRunner.kt)
        //    take. Claimed HERE, ahead of the api-handle / module / assignment parsers, so the verb
        //    is RECOGNIZED on every surface instead of falling through to the expression evaluator
        //    as a bogus member call on the `screen` metrics object: one screen authored once runs
        //    everywhere, and `settle="manual"` markup mirrored onto a watch must degrade, never
        //    diverge (Article 7). A node that ever grows its own readiness plane wires it here.
        if s.hasPrefix("dsx.screen.settled("), s.hasSuffix(")") { return .normal }

        // ── plain declarative API handles: orders.refresh() / send({...}) / cancel().
        //    Resolve before packages/actions so a declared API name cannot be mistaken
        //    for a module scheme or a bare action. ──
        if let api = Self.parseApiCall(s), let handle = apiHandle(named: api.name) {
            switch api.verb {
            case "refresh":
                handle.refresh(completion: nil)
            case "send":
                let raw = api.args.trimmingCharacters(in: .whitespacesAndNewlines)
                let first = Self.splitArgs(raw).first ?? ""
                let body = first.isEmpty ? nil : eval(first, locals) as? [String: Any]
                handle.send(body, completion: nil)
            default:
                handle.cancel()
            }
            return .normal
        }

        // ── module calls: [await] dsx.module.<scheme>.<action>(args) — a STATEMENT here;
        //    a `const x = await …` binding was intercepted above and rides evalAsync ──
        if let m = Self.parseModuleCall(s) {
            let args = (eval(m.args.isEmpty ? "{}" : m.args, locals)) as? [String: Any] ?? [:]
            if m.scheme == "route", ["push", "pop", "replace"].contains(m.action) {
                // satellite convenience: the node's OWN router (path arg; pop = "..").
                // THIS TRIO IS THE WHOLE LOCAL SURFACE — the bundled-screen lint in
                // generate_node_capabilities exempts exactly these three, so any other
                // route.* fails the BUILD instead of settling unsupported_on_surface
                // on a device. Grow the two lists together.
                let path = JSE.string(args["path"] ?? args["route"] ?? "")
                effects?.navigate(m.action == "pop" ? ".." : path)
                return .normal
            }
            _ = await effects?.call(m.scheme, m.action, args)
            return .normal
        }

        // ── named action calls: dsx.action.x(args) / bare x(args) for a declared action ──
        if let c = Self.parseActionCall(s, declared: actions) {
            let args = (eval(c.args.isEmpty ? "{}" : c.args, locals)) as? [String: Any] ?? [:]
            await runNamed(c.name, args: args)
            return .normal
        }

        // ── array mutations: path.push(e) / path.pop() (store paths) ──
        if let p = Self.parsePushPop(s) {
            var arr = (readPath(p.path, locals) as? [Any]) ?? []
            if p.push { arr.append(eval(p.arg, locals) ?? NSNull()) } else if !arr.isEmpty { arr.removeLast() }
            writePath(p.path, arr)
            return .normal
        }

        // ── assignment: ALWAYS the store (dotted paths create nests); += / -= sugar ──
        if let a = Self.parseAssignment(s) {
            let rhs: String
            switch a.op {
            case "=":  rhs = a.rhs
            case "+=": rhs = "(\(a.path)) + (\(a.rhs))"
            case "-=": rhs = "(\(a.path)) - (\(a.rhs))"
            default:   rhs = a.rhs
            }
            writePath(a.path, await evalAsync(rhs, &locals) ?? NSNull())
            return .normal
        }

        // ── anything else: evaluate for its effect (a bare expression) ──
        _ = await evalAsync(s, &locals)
        return .normal
    }

    // MARK: - Control-flow forms

    private func execIf(_ s: String, _ locals: inout [String: Any]) async -> JSEFlow {
        var rest = Substring(s.dropFirst(2))   // past the `if` keyword
        while true {
            guard let cond = Self.parenGroup(&rest) else { return .normal }
            guard let body = Self.braceGroup(&rest) else { return .normal }
            if JSE.truthy(eval(cond, locals)) {
                var inner = locals
                let f = await exec(block: body, locals: &inner)
                merge(&locals, from: inner)
                return f
            }
            let after = rest.trimmingCharacters(in: .whitespaces)
            if after.hasPrefix("else if") { rest = Substring(after.dropFirst(7)); continue }
            if after.hasPrefix("else") {
                var tail = Substring(after.dropFirst(4))
                guard let body = Self.braceGroup(&tail) else { return .normal }
                var inner = locals
                let f = await exec(block: body, locals: &inner)
                merge(&locals, from: inner)
                return f
            }
            return .normal
        }
    }

    private func execWhile(_ s: String, _ locals: inout [String: Any]) async -> JSEFlow {
        var rest = Substring(s.dropFirst(5))
        guard let cond = Self.parenGroup(&rest), let body = Self.braceGroup(&rest) else { return .normal }
        while JSE.truthy(eval(cond, locals)) {
            if budgetExceeded() { return .normal }
            var inner = locals
            let f = await exec(block: body, locals: &inner)
            merge(&locals, from: inner)
            switch f {
            case .brk: return .normal
            case .ret, .thrown: return f
            default: break
            }
        }
        return .normal
    }

    private func execFor(_ s: String, _ locals: inout [String: Any]) async -> JSEFlow {
        var rest = Substring(s.dropFirst(3))
        guard let head = Self.parenGroup(&rest), let body = Self.braceGroup(&rest) else { return .normal }
        // for (const x of expr)
        if let ofR = head.range(of: " of ") {
            var name = String(head[..<ofR.lowerBound]).trimmingCharacters(in: .whitespaces)
            for kw in ["const ", "let ", "var "] where name.hasPrefix(kw) { name = String(name.dropFirst(kw.count)) }
            let seq = eval(String(head[ofR.upperBound...]), locals)
            let items: [Any] = (seq as? [Any]) ?? ((seq as? [String: Any]).map { Array($0.values) } ?? [])
            for item in items {
                if budgetExceeded() { return .normal }
                var inner = locals; inner[name] = item
                let f = await exec(block: body, locals: &inner)
                merge(&locals, from: inner, dropping: name)
                switch f {
                case .brk: return .normal
                case .ret, .thrown: return f
                default: break
                }
            }
            return .normal
        }
        // classic for (init; cond; step) — the STORE-COUNTER portable idiom (`for (i = 0; …)`)
        let parts = Self.splitTop(head, on: ";")
        guard parts.count == 3 else { return .normal }
        var seedLocals = locals
        _ = await exec(statement: parts[0], locals: &seedLocals)
        merge(&locals, from: seedLocals)
        while JSE.truthy(eval(parts[1], locals)) {
            if budgetExceeded() { return .normal }
            var inner = locals
            let f = await exec(block: body, locals: &inner)
            merge(&locals, from: inner)
            switch f {
            case .brk: return .normal
            case .ret, .thrown: return f
            default: break
            }
            var stepLocals = locals
            _ = await exec(statement: parts[2], locals: &stepLocals)
            merge(&locals, from: stepLocals)
        }
        return .normal
    }

    private func execTry(_ s: String, _ locals: inout [String: Any]) async -> JSEFlow {
        var rest = Substring(s.dropFirst(3))
        guard let body = Self.braceGroup(&rest) else { return .normal }
        var inner = locals
        var flow = await exec(block: body, locals: &inner)
        merge(&locals, from: inner)
        let after = rest.trimmingCharacters(in: .whitespaces)
        var tail = Substring(after)
        if after.hasPrefix("catch") {
            tail = Substring(after.dropFirst(5))
            var errName: String? = nil
            var probe = tail
            if let group = Self.parenGroup(&probe) { errName = group.trimmingCharacters(in: .whitespaces); tail = probe }
            guard let catchBody = Self.braceGroup(&tail) else { return flow }
            if case .thrown(let v) = flow {
                var cLocals = locals
                if let errName, !errName.isEmpty { cLocals[errName] = v ?? NSNull() }
                flow = await exec(block: catchBody, locals: &cLocals)
                merge(&locals, from: cLocals, dropping: errName)
            }
        }
        let fin = tail.trimmingCharacters(in: .whitespaces)
        if fin.hasPrefix("finally") {
            var fTail = Substring(fin.dropFirst(7))
            if let finBody = Self.braceGroup(&fTail) {
                var fLocals = locals
                _ = await exec(block: finBody, locals: &fLocals)
                merge(&locals, from: fLocals)
            }
        }
        return flow
    }

    // MARK: - Diagnostics (dsx.log / dsx.error — the unified primitives)

    /// Log/error ATTRIBUTION: the surface's owning package scheme, "app" when unscoped —
    /// the default the logs corpus pins for markup emissions.
    private var attribution: String { (scope?.isEmpty == false) ? scope! : "app" }

    /// The SATELLITE arm of the ambient error hat — `dsx.error(…)` and the uncaught-throw
    /// capture both land here. A node has no ledger, no registry, no page channel and no
    /// `global.*` plane (file header, DIAGNOSTICS), so the kernel log sink is the whole
    /// record; the line therefore carries the fields the absent ledger would have held.
    /// The `[dsx.error] <scheme> → <code>` prefix and the `(uncaught)` marker are
    /// byte-identical to `Errors.swift`, so one grep reads all four executors. `data` goes
    /// through the house formatter, which MASKS credential-looking keys — an error payload
    /// is exactly where a token leaks otherwise. Never unwinds, never throws (Article 7);
    /// kernelLog directly rather than the effects seam, so a node with no effects attached
    /// still records.
    private func report(error code: String, message: String?, recoverable: Bool,
                        data: Any?, origin: String) {
        var line = "[dsx.error] \(attribution) → \(code)"
        if origin == "uncaught" { line += " (uncaught)" }
        if let message, !message.isEmpty { line += " — \(message)" }
        if recoverable { line += " (recoverable)" }
        if let data, !(data is NSNull) { line += " " + JSELogFormat.value(data) }
        kernelLog(line)
    }

    /// Derive the canonical error fields from an uncaught thrown value — corpus-pinned
    /// (errors corpus §7) and the exact twin of `JSERunner.reportUncaughtThrow`: a dict with
    /// a string `code` keeps its code/message/recoverable/data; a codeless dict with a
    /// string `message` (a JSE `new Error(…)`, the browser-parity throw) keeps the message
    /// and rides whole as data; any other dict rides as data; anything else records code
    /// "uncaught" with the JSE string coercion as message. The data additionally carries
    /// `snippet` — the first 120 chars of the body that threw — so the record says WHAT threw.
    private func reportUncaught(_ value: Any?, body: String) {
        var code = "uncaught"
        var message: String?
        var recoverable = false
        var data: Any?
        if let dict = value as? [String: Any] {
            if let dictCode = dict["code"] as? String, !dictCode.isEmpty {
                code = dictCode
                if let m = dict["message"], !(m is NSNull) { message = JSE.string(m) }
                recoverable = JSE.truthy(dict["recoverable"])
                data = dict["data"]
            } else if let dictMessage = dict["message"] as? String, !dictMessage.isEmpty {
                message = dictMessage
                data = dict
            } else {
                data = dict
            }
        } else {
            message = JSE.string(value ?? "")
        }
        let snippet = String(body.prefix(120))
        if var dataDict = data as? [String: Any] {
            if dataDict["snippet"] == nil { dataDict["snippet"] = snippet }
            data = dataDict
        } else if data == nil || data is NSNull {
            data = ["snippet": snippet]
        }
        report(error: code, message: message, recoverable: recoverable, data: data,
               origin: "uncaught")
    }

    // MARK: - Evaluation + state

    private func eval(_ expr: String, _ locals: [String: Any]) -> Any? {
        JSE.eval(expr, store: state, item: locals.isEmpty ? nil : locals)
    }

    /// RHS evaluation that understands ONE leading `await`: `await dsx.module…` /
    /// `await fetch(…)` suspend on the effects seam; anything else evaluates synchronously.
    private func evalAsync(_ expr: String, _ locals: inout [String: Any]) async -> Any? {
        let e = expr.trimmingCharacters(in: .whitespaces)
        let body = e.hasPrefix("await ") ? String(e.dropFirst(6)).trimmingCharacters(in: .whitespaces) : e
        if body.hasPrefix("dsx.module."), let m = Self.parseModuleCall("const __r = await " + body) {
            let args = (eval(m.args.isEmpty ? "{}" : m.args, locals)) as? [String: Any] ?? [:]
            return await effects?.call(m.scheme, m.action, args) ?? ["ok": false, "error": "unreachable"]
        }
        if body.hasPrefix("fetch(") {
            let inner = Self.callArgs(of: body, prefix: "fetch")
            let parts = Self.splitArgs(inner)
            let url = JSE.string(eval(parts.first ?? "''", locals))
            let opts = (parts.count > 1 ? eval(parts[1], locals) : nil) as? [String: Any] ?? [:]
            return await effects?.fetch(url, opts) ?? ["ok": false, "error": "offline"]
        }
        return eval(e, locals)
    }

    private func readPath(_ path: String, _ locals: [String: Any]) -> Any? {
        eval(path, locals)
    }

    private func apiHandle(named name: String) -> (any JSEApiHandle)? {
        (state as? any JSEApiHandleState)?.apiHandles[name]?.value
    }

    /// Store writes — dotted paths build nested dictionaries. The satellite twin of the
    /// app runner's `set:` semantics; the store publish is the node's re-render signal.
    private func writePath(_ path: String, _ value: Any) {
        var parts = path.split(separator: ".").map(String.init)
        if parts.first == "dsx", parts.count > 2, parts[1] == "variable" { parts.removeFirst(2) }
        guard !parts.isEmpty else { return }
        if parts.count == 1 { state.vars[parts[0]] = value; return }
        var root = state.vars[parts[0]] as? [String: Any] ?? [:]
        Self.set(&root, Array(parts.dropFirst()), value)
        state.vars[parts[0]] = root
    }

    private static func set(_ dict: inout [String: Any], _ path: [String], _ value: Any) {
        guard let head = path.first else { return }
        if path.count == 1 { dict[head] = value; return }
        var child = dict[head] as? [String: Any] ?? [:]
        set(&child, Array(path.dropFirst()), value)
        dict[head] = child
    }

    /// Block locals: mutations to PRE-EXISTING locals propagate out (JS closure feel);
    /// names born inside the block (or the loop/catch binder) stay scoped to it.
    private func merge(_ outer: inout [String: Any], from inner: [String: Any], dropping: String? = nil) {
        for (k, v) in inner where outer[k] != nil && k != dropping { outer[k] = v }
    }

    private func budgetExceeded() -> Bool {
        loopWork += 1
        if loopWork > 10_000 {
            effects?.log("[dsx] loop budget (10000) exceeded — bailing (portable-bounded execution)")
            return true
        }
        return false
    }

    // MARK: - Micro-parsers (top-level aware: strings + () {} [] nesting respected)

    /// The shared JSE preprocessor pass (quote-, template- AND regex-literal-aware,
    /// `://` URL guard — syntax wave 1); this forwarder keeps call sites source-compatible.
    static func stripComments(_ s: String) -> String { JSE.stripComments(s) }

    /// Split a block into top-level statements at `;` and newlines (a newline splits only
    /// when nesting depth is 0 — brace blocks ride whole).
    static func split(_ block: String) -> [String] {
        var out: [String] = []; var cur = ""; var depth = 0; var quote: Character? = nil
        var i = block.startIndex
        while i < block.endIndex {
            let c = block[i]
            if let q = quote {
                cur.append(c)
                if c == "\\" { let n = block.index(after: i); if n < block.endIndex { cur.append(block[n]); i = block.index(after: n); continue } }
                if c == q { quote = nil }
                i = block.index(after: i); continue
            }
            switch c {
            case "'", "\"", "`": quote = c; cur.append(c)
            case "(", "{", "[": depth += 1; cur.append(c)
            case ")", "}", "]":
                depth -= 1; cur.append(c)
                // a closing brace at depth 0 ends a block-statement even without `;`
                if depth == 0, c == "}" {
                    // keep attached else/catch/finally with their statement
                    let rest = block[block.index(after: i)...].drop { $0 == " " || $0 == "\n" }
                    if !(rest.hasPrefix("else") || rest.hasPrefix("catch") || rest.hasPrefix("finally")) {
                        out.append(cur); cur = ""
                    }
                }
            case ";", "\n":
                if depth == 0 {
                    if c == ";" || Self.completeStatement(cur) { out.append(cur); cur = "" }
                    else { cur.append(" ") }   // a soft newline inside an unfinished statement
                } else { cur.append(c == ";" ? ";" : " ") }
            default: cur.append(c)
            }
            i = block.index(after: i)
        }
        if !cur.trimmingCharacters(in: .whitespaces).isEmpty { out.append(cur) }
        return out.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }

    /// Heuristic: is `cur` a complete statement at a newline? Incomplete when it ends in an
    /// operator/comma/open context or is a bare keyword awaiting its group.
    private static func completeStatement(_ cur: String) -> Bool {
        let t = cur.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return false }
        if let last = t.last, "+-*/%<>=&|,.?:(".contains(last) { return false }
        for kw in ["if", "for", "while", "try", "else", "catch", "finally"] where t == kw { return false }
        return true
    }

    static func topLevelIndex(of char: Character, in s: String) -> String.Index? {
        var depth = 0; var quote: Character? = nil
        var i = s.startIndex
        while i < s.endIndex {
            let c = s[i]
            if let q = quote {
                if c == "\\" { i = s.index(after: i); if i < s.endIndex { i = s.index(after: i) }; continue }
                if c == q { quote = nil }
            } else if c == "'" || c == "\"" || c == "`" { quote = c }
            else if "({[".contains(c) { depth += 1 }
            else if ")}]".contains(c) { depth -= 1 }
            else if depth == 0, c == char {
                // reject == / >= / <= / != when looking for a bare `=`
                if char == "=" {
                    let prev = i > s.startIndex ? s[s.index(before: i)] : " "
                    let nextI = s.index(after: i)
                    let next = nextI < s.endIndex ? s[nextI] : " "
                    if prev == "=" || prev == "!" || prev == "<" || prev == ">" || next == "=" { i = s.index(after: i); continue }
                }
                return i
            }
            i = s.index(after: i)
        }
        return nil
    }

    static func splitTop(_ s: String, on sep: Character) -> [String] {
        var out: [String] = []; var cur = ""; var depth = 0; var quote: Character? = nil
        for c in s {
            if let q = quote { cur.append(c); if c == q { quote = nil }; continue }
            if c == "'" || c == "\"" || c == "`" { quote = c; cur.append(c); continue }
            if "({[".contains(c) { depth += 1 }
            if ")}]".contains(c) { depth -= 1 }
            if depth == 0, c == sep { out.append(cur); cur = ""; continue }
            cur.append(c)
        }
        out.append(cur)
        return out.map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// `prefix(...)` → the inside of the FIRST balanced paren group after the prefix.
    static func callArgs(of s: String, prefix: String) -> String {
        guard let r = s.range(of: prefix + "(") else { return "" }
        var depth = 1; var out = ""; var quote: Character? = nil
        var i = r.upperBound
        while i < s.endIndex {
            let c = s[i]
            if let q = quote { out.append(c); if c == q { quote = nil }; i = s.index(after: i); continue }
            if c == "'" || c == "\"" || c == "`" { quote = c; out.append(c) }
            else if c == "(" { depth += 1; out.append(c) }
            else if c == ")" { depth -= 1; if depth == 0 { break }; out.append(c) }
            else { out.append(c) }
            i = s.index(after: i)
        }
        return out
    }

    static func splitArgs(_ inner: String) -> [String] { splitTop(inner, on: ",").filter { !$0.isEmpty } }

    /// `(cond)` group at the head of `rest` (advances rest past it).
    static func parenGroup(_ rest: inout Substring) -> String? {
        var r = rest.drop { $0 == " " || $0 == "\n" }
        guard r.first == "(" else { return nil }
        var depth = 0; var out = ""; var quote: Character? = nil
        var idx = r.startIndex
        while idx < r.endIndex {
            let c = r[idx]
            if let q = quote { if c == q { quote = nil }; if depth > 0 { out.append(c) } }
            else if c == "'" || c == "\"" || c == "`" { quote = c; if depth > 0 { out.append(c) } }
            else if c == "(" { depth += 1; if depth > 1 { out.append(c) } }
            else if c == ")" { depth -= 1; if depth == 0 { r = r[r.index(after: idx)...]; rest = r; return out }; out.append(c) }
            else if depth > 0 { out.append(c) }
            idx = r.index(after: idx)
        }
        return nil
    }

    /// `{ body }` group at the head of `rest` (advances rest past it).
    static func braceGroup(_ rest: inout Substring) -> String? {
        var r = rest.drop { $0 == " " || $0 == "\n" }
        guard r.first == "{" else { return nil }
        var depth = 0; var out = ""; var quote: Character? = nil
        var idx = r.startIndex
        while idx < r.endIndex {
            let c = r[idx]
            if let q = quote { if c == q { quote = nil }; if depth > 0 { out.append(c) } }
            else if c == "'" || c == "\"" || c == "`" { quote = c; if depth > 0 { out.append(c) } }
            else if c == "{" { depth += 1; if depth > 1 { out.append(c) } }
            else if c == "}" { depth -= 1; if depth == 0 { r = r[r.index(after: idx)...]; rest = r; return out }; out.append(c) }
            else if depth > 0 { out.append(c) }
            idx = r.index(after: idx)
        }
        return nil
    }

    // MARK: - Statement-shape parsers

    struct ModuleCall { let scheme: String; let action: String; let args: String }
    static func parseModuleCall(_ s: String) -> ModuleCall? {
        var t = Substring(s)
        for kw in ["const ", "let ", "var "] where t.hasPrefix(kw) {
            // A declaration prefix reaches this parser only via evalAsync's SYNTHETIC
            // "const __r = await …" shape — the binding is the caller's business, and the
            // real declaration-statement path is intercepted before parseModuleCall runs.
            t = t.dropFirst(kw.count)
            guard let eq = t.firstIndex(of: "=") else { return nil }
            t = t[t.index(after: eq)...]
        }
        var body = t.trimmingCharacters(in: .whitespaces)
        if body.hasPrefix("await ") { body = String(body.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
        guard body.hasPrefix("dsx.module.") else { return nil }
        let after = body.dropFirst("dsx.module.".count)
        guard let paren = after.firstIndex(of: "(") else { return nil }
        let chain = after[..<paren].split(separator: ".").map(String.init)
        // One segment = the bare pre-filter call (dsx.module.spinner()); deeper spellings
        // (watch.health.heartRate, intelligence.rag.add) parse whole — the dispatch funnel's
        // chain FOLD (ChainResolver, Conformance/chains) resolves identity-vs-action, so the
        // parser never counts dots.
        guard chain.count >= 1, chain.allSatisfy({ !$0.isEmpty }) else { return nil }
        let args = callArgs(of: String(body), prefix: "dsx.module.\(chain.joined(separator: "."))")
        return ModuleCall(scheme: chain[0], action: chain.dropFirst().joined(separator: "."), args: args)
    }

    struct ActionCall { let name: String; let args: String }
    static func parseActionCall(_ s: String, declared: [String: String]) -> ActionCall? {
        if s.hasPrefix("dsx.action.") {
            let after = s.dropFirst("dsx.action.".count)
            guard let paren = after.firstIndex(of: "(") else { return nil }
            let name = String(after[..<paren])
            return ActionCall(name: name, args: callArgs(of: s, prefix: "dsx.action.\(name)"))
        }
        // bare `name(args)` — only for a HEAD-DECLARED action (feature-detection stays sane)
        guard let paren = s.firstIndex(of: "("), s.last == ")" else { return nil }
        let name = String(s[..<paren]).trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, declared[name] != nil,
              name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return nil }
        return ActionCall(name: name, args: callArgs(of: s, prefix: name))
    }

    struct AwaitActionCall { let bind: String?; let decl: Bool; let name: String; let args: String }
    /// `[const|let|var NAME =] await dsx.action.name( … )` — the RETURNING action call —
    /// its bare-assignment form `path = await dsx.action.name( … )` (no decl keyword;
    /// that bind writes the STORE, the pinned `x = e` rule), and the bind-less bare
    /// spelling. The "dsx.action." marker keeps `dsx.module.…` on its own path — the
    /// satellite twin of matchAwaitAction (Stack.swift · JseRunner.kt): same forms,
    /// same envelope. Anything that is not exactly this shape returns nil, so the
    /// declaration/assignment branches keep today's behavior.
    static func parseAwaitAction(_ s: String) -> AwaitActionCall? {
        var rest = s
        var bind: String? = nil
        var decl = false
        for kw in ["const ", "let ", "var "] where s.hasPrefix(kw) {
            let after = String(s.dropFirst(kw.count))
            guard let eq = topLevelIndex(of: "=", in: after) else { return nil }
            let name = String(after[..<eq]).trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return nil }
            bind = name; decl = true
            rest = String(after[after.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            break
        }
        if bind == nil, let eq = topLevelIndex(of: "=", in: s) {
            // bare-assignment form: `path = await …` (never `==` — topLevelIndex skips it);
            // claimed only when `await dsx.action.` follows — anything else keeps its path.
            let path = String(s[..<eq]).trimmingCharacters(in: .whitespaces)
            let after = String(s[s.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            if isPath(path), after.hasPrefix("await ") { bind = path; rest = after }
        }
        guard rest.hasPrefix("await ") else { return nil }
        let body = String(rest.dropFirst(6)).trimmingCharacters(in: .whitespaces)
        guard body.hasPrefix("dsx.action.") else { return nil }
        let after = String(body.dropFirst("dsx.action.".count))
        guard let paren = after.firstIndex(of: "(") else { return nil }
        let name = String(after[..<paren])
        guard !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return nil }
        return AwaitActionCall(bind: bind, decl: decl, name: name,
                               args: callArgs(of: body, prefix: "dsx.action.\(name)"))
    }

    struct PushPop { let path: String; let push: Bool; let arg: String }
    static func parsePushPop(_ s: String) -> PushPop? {
        if let r = s.range(of: ".push(") {
            let path = String(s[..<r.lowerBound])
            guard path.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." }) else { return nil }
            return PushPop(path: path, push: true, arg: callArgs(of: s, prefix: path + ".push"))
        }
        if s.hasSuffix(".pop()") {
            let path = String(s.dropLast(6))
            guard path.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." }) else { return nil }
            return PushPop(path: path, push: false, arg: "")
        }
        return nil
    }

    struct ApiCall {
        let name: String
        let verb: String
        let args: String
    }

    /// Exact `<identifier>.(refresh|send|cancel)(…)` shape. Registry lookup remains
    /// separate and is the final claim gate, so ordinary object method calls keep
    /// falling through to the expression evaluator.
    static func parseApiCall(_ s: String) -> ApiCall? {
        let body = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let dot = body.firstIndex(of: "."),
              let open = body[dot...].firstIndex(of: "("),
              body.last == ")" else { return nil }
        let name = String(body[..<dot])
        let verb = String(body[body.index(after: dot)..<open])
        guard isIdentifier(name),
              verb == "refresh" || verb == "send" || verb == "cancel" else { return nil }
        let args = callArgs(of: body, prefix: "\(name).\(verb)")
        return ApiCall(name: name, verb: verb, args: args)
    }

    struct AwaitApiCall {
        let bind: String?
        let decl: Bool
        let name: String
        let verb: String
        let args: String
    }

    /// `[const|let|var NAME =] await <api>.send|refresh(…)`, the bare awaited
    /// spelling, and the store-assignment form `path = await …`. Only send/refresh
    /// suspend; cancel is deliberately the synchronous handle operation on every
    /// runtime.
    static func parseAwaitApi(_ s: String) -> AwaitApiCall? {
        var rest = s.trimmingCharacters(in: .whitespacesAndNewlines)
        var bind: String?
        var decl = false

        for keyword in ["const ", "let ", "var "] where rest.hasPrefix(keyword) {
            let afterKeyword = String(rest.dropFirst(keyword.count))
            guard let equal = topLevelIndex(of: "=", in: afterKeyword) else { return nil }
            let name = String(afterKeyword[..<equal]).trimmingCharacters(in: .whitespaces)
            guard isIdentifier(name) else { return nil }
            bind = name
            decl = true
            rest = String(afterKeyword[afterKeyword.index(after: equal)...])
                .trimmingCharacters(in: .whitespaces)
            break
        }

        if bind == nil, let equal = topLevelIndex(of: "=", in: rest) {
            let path = String(rest[..<equal]).trimmingCharacters(in: .whitespaces)
            let after = String(rest[rest.index(after: equal)...])
                .trimmingCharacters(in: .whitespaces)
            if isPath(path), after.hasPrefix("await ") {
                bind = path
                rest = after
            }
        }

        guard rest.hasPrefix("await ") else { return nil }
        let body = String(rest.dropFirst(6)).trimmingCharacters(in: .whitespaces)
        guard let call = parseApiCall(body),
              call.verb == "send" || call.verb == "refresh" else { return nil }
        return AwaitApiCall(
            bind: bind,
            decl: decl,
            name: call.name,
            verb: call.verb,
            args: call.args
        )
    }

    struct Assignment { let path: String; let op: String; let rhs: String }
    static func parseAssignment(_ s: String) -> Assignment? {
        for op in ["+=", "-="] {
            if let r = s.range(of: op) {
                let path = String(s[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
                guard Self.isPath(path) else { continue }
                return Assignment(path: path, op: op, rhs: String(s[r.upperBound...]).trimmingCharacters(in: .whitespaces))
            }
        }
        guard let eq = topLevelIndex(of: "=", in: s) else { return nil }
        let path = String(s[..<eq]).trimmingCharacters(in: .whitespaces)
        guard Self.isPath(path) else { return nil }
        return Assignment(path: path, op: "=", rhs: String(s[s.index(after: eq)...]).trimmingCharacters(in: .whitespaces))
    }

    private static func isPath(_ p: String) -> Bool {
        !p.isEmpty && !p.contains(" ") && p.first!.isLetter &&
        p.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." }
    }

    private static func isIdentifier(_ value: String) -> Bool {
        !value.isEmpty && (value.first?.isLetter == true || value.first == "_") &&
        value.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" }
    }

    struct TimerCall { let key: String; let ms: Double; let repeats: Bool; let body: String; let clear: Bool }
    static func parseTimer(_ s: String) -> TimerCall? {
        if s.hasPrefix("clearTimeout(") || s.hasPrefix("clearInterval(") {
            let prefix = s.hasPrefix("clearTimeout(") ? "clearTimeout" : "clearInterval"
            let key = callArgs(of: s, prefix: prefix).trimmingCharacters(in: CharacterSet(charactersIn: " '\""))
            return TimerCall(key: key, ms: 0, repeats: false, body: "", clear: true)
        }
        let repeats = s.hasPrefix("setInterval(")
        guard repeats || s.hasPrefix("setTimeout(") else { return nil }
        let inner = callArgs(of: s, prefix: repeats ? "setInterval" : "setTimeout")
        let parts = splitArgs(inner)
        guard parts.count >= 2 else { return nil }
        // the callback: `() => { body }` / `() => stmt`
        var cb = parts[0].trimmingCharacters(in: .whitespaces)
        if let arrow = cb.range(of: "=>") {
            cb = String(cb[arrow.upperBound...]).trimmingCharacters(in: .whitespaces)
            if cb.hasPrefix("{"), cb.hasSuffix("}") { cb = String(cb.dropFirst().dropLast()) }
        }
        let ms = Double(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
        let key = parts.count > 2 ? parts[2].trimmingCharacters(in: CharacterSet(charactersIn: " '\"")) : UUID().uuidString
        return TimerCall(key: key, ms: ms, repeats: repeats, body: cb, clear: false)
    }
}
