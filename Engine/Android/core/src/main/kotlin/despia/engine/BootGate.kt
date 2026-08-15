//
//  BootGate.kt — composable launch gates (dsx.boot.gate). Kotlin twin of Engine/BootGate.swift —
//  same names, same arguments, same behaviors.
//
//  A GATE holds the launch until it is satisfied — optionally showing its OWN screen — then
//  hands off. Gates COMPOSE: any boot-tier package registers one with
//  `dsx.boot.gate(priority:when:)`; the kernel runs them HIGHEST-PRIORITY-FIRST, one at a time,
//  and the app mounts only after the last one settles. A gate that never settles is a hard
//  block (e.g. a forced-update screen). `resolve` is the SAME primitive an action uses: the
//  runner invokes each gate as a boot-time OPERATION whose terminal continuation advances the
//  chain. The chain is run once, by the kernel's app-entry, via `BootGates.run(present:then:)`.
//
//  ── SEAMS (PLAN.md ground rule 3) ──
//  • PRESENTER — Swift presents the gate's mounted screen as a `UIViewController`
//    (`present: (UIViewController) -> Void`). :core is pure JVM, so `present` receives the
//    mounted surface handle as an OPAQUE `Any` (the :render wiring casts to its controller).
//  • CONTEXT — Swift builds each gate's per-run `Context(store: gate.store, scheme: "boot",
//    host: "gate", url: boot://gate, params: Bridge.Params(dict: [:]) { advance() })` and reads
//    `dsx.lastMount` for its screen. Context/Bridge are concurrent ports, so construction is
//    the settable `BootGates.contextFactory` seam: (gate, advance) → the value handed to
//    `gate.run` + a `lastMount` probe. The DEFAULT hands the gate a plain `BootHandle`
//    (`resolve()` == `dsx.resolve()`, `error()` its terminal twin) with no mount — enough for
//    pure-JVM gates and tests; the kernel wiring installs the real factory when Context lands.
//  • `dsx.boot` — Swift extends Context with `var boot: BootProxy`; that extension rides the
//    Context.kt port. This file declares the proxy + registry only.
//
//  ── NOTES (pinned decisions; PLAN.md ground rule 1) ──
//  • `when` is a Kotlin keyword — the member keeps its Swift name via backticks (`` `when` ``).
//    Swift's `@autoclosure` has no Kotlin twin, so callers pass `{ config.enabled }` explicitly.
//  • Sort stability: gates of EQUAL priority run in REGISTRATION order (Kotlin's sort is
//    stable; Swift 5's is stable in practice — pinned here and in tests).
//  • `BootProxy` records the registering context handle as the gate's `store` (Swift records
//    `dsx.store`, its Registration — a type :core cannot name yet); the installed factory
//    adapts. Opaque plumbing either way.
//  • `BootGates.reset()` is a JVM test affordance (no Swift twin — the chain registers once per
//    process on iOS).
//

package despia.engine

/// The boot-phase namespace. `dsx.boot.gate(...)` registers a composable launch gate.
/// (Swift: `extension Context { var boot: BootProxy }` — the extension rides Context.kt.)
class BootProxy(val dsx: Any?) {

    /// Register a launch GATE. It runs before the app mounts (highest `priority` first); show a
    /// screen with `dsx.component.mount(...)`, do your work (sync or async), then
    /// `dsx.resolve()` to advance. `when` (default true) scopes it — false ⇒ the gate is
    /// skipped. Keep it self-contained: read the package's OWN config in `when`, never a host
    /// global.
    fun gate(priority: Int = 0, `when`: () -> Boolean = { true }, handler: (Any) -> Unit) {
        BootGates.register(BootGate(priority = priority, `when` = `when`, store = dsx, run = handler))
    }
}

/// One registered gate. `store` is the registering package's context handle (see NOTES) — the
/// runner builds the gate's per-run context from it, so `dsx.*` inside the handler is that
/// package's context.
class BootGate(
    val priority: Int,
    val `when`: () -> Boolean,
    val store: Any?,
    val run: (Any) -> Unit,
)

/// The launch gate chain. Registration is global (any boot-tier package contributes); the
/// kernel runs the chain exactly once at launch.
object BootGates {
    private val registered = ArrayList<BootGate>()

    fun register(gate: BootGate) {
        registered.add(gate)
    }

    /// One gate invocation as the context seam sees it: the value handed to `gate.run` plus the
    /// mounted-screen probe (Swift: `dsx.lastMount?.controller`, read AFTER the handler ran).
    class GateRun(val context: Any, val lastMount: () -> Any?)

    /// The Context seam (see SEAMS): builds each gate's per-run context with `advance` as its
    /// terminal continuation. Default: a plain `BootHandle`, no mount probe.
    var contextFactory: (gate: BootGate, advance: () -> Unit) -> GateRun =
        { _, advance -> GateRun(BootHandle(advance)) { null } }

    /// Run the gates highest-priority-first, in SEQUENCE — each settles via `dsx.resolve()`
    /// (which advances) — then call `then`. A gate that mounts a screen has it `present`ed
    /// while it runs. No gates (or all `when`-skipped) → mount immediately. A gate that never
    /// resolves holds the launch (an intentional hard block).
    fun run(present: (Any) -> Unit, then: () -> Unit) {
        val chain = registered.filter { it.`when`() }.sortedByDescending { it.priority }
        fun step(i: Int) {
            if (i >= chain.size) { then(); return }
            val gate = chain[i]
            var advanced = false
            val advance = { if (!advanced) { advanced = true; step(i + 1) } }   // idempotent
            // The gate runs as a boot OPERATION: its context's terminal (dsx.resolve /
            // dsx.error) advances the chain — the very continuation an action's caller awaits.
            val run = contextFactory(gate, advance)
            gate.run(run.context)
            run.lastMount()?.let { present(it) }                                // show its screen, if any
        }
        step(0)
    }

    /// JVM test affordance (no Swift twin — see NOTES): clear the chain between tests.
    internal fun reset() {
        registered.clear()
        contextFactory = { _, advance -> GateRun(BootHandle(advance)) { null } }
    }
}

/// Kernel-owned compromised-device launch decision. The Security package installs the policy
/// during the synchronous boot tier; the Android host reads the result before it composes splash,
/// RouterHost, modals, or any app/WebView surface. The returned value is only a compiled component
/// name — rendering stays in the native Stack renderer, while ownership of the non-router plane
/// stays with the host.
///
/// The nullable overrides are deterministic DEBUG/instrumentation inputs supplied by the host.
/// Production calls omit them, so the package's real config and device detector are authoritative.
/// This seam is deliberately not exposed through Context/JSE or the Router: normal application
/// code cannot dismiss, replace, or cover the selected security root.
object CompromisedDeviceBootGate {
    @Volatile
    private var evaluator: ((policyEnabledOverride: Boolean?, compromisedOverride: Boolean?) -> String?)? = null

    @Synchronized
    fun installPolicy(
        evaluate: (policyEnabledOverride: Boolean?, compromisedOverride: Boolean?) -> String?,
    ) {
        // Security is Mandatory and installs once. First-writer-wins prevents a later package from
        // weakening the process-wide boot decision after the boot tier has completed.
        if (evaluator == null) evaluator = evaluate
    }

    fun blockedComponent(
        policyEnabledOverride: Boolean? = null,
        compromisedOverride: Boolean? = null,
    ): String? = evaluator?.invoke(policyEnabledOverride, compromisedOverride)

    internal fun reset() {
        evaluator = null
    }
}

/// The DEFAULT per-run gate context (no Context factory installed yet): just the terminal —
/// `resolve()` means exactly "this operation is done", identical to web/native callers, and
/// `error(...)` is its terminal twin (Swift's Bridge.Params completion runs for either).
class BootHandle internal constructor(private val advance: () -> Unit) {
    /// Settle → the boot advances to the next gate / mounts. Idempotent through the runner.
    fun resolve() = advance()

    /// The failing terminal — a gate that errors still hands off (the operation is DONE).
    fun error(code: String = "", data: Any? = null) = advance()
}
