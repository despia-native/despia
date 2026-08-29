Action / workflow conformance (the runner grammar) — fixtures BEFORE a runner change ships on any platform.

DSX **actions ARE workflows** (the Nordcraft "workflow" analogue): a declared `<action as="x">` runs
the full bounded-JS statement grammar (if/else · while · for / for…of · switch · try/catch · const/let ·
assignment · array mutation · `dsx.event`), and — the composition part — an action **calls other
actions**: `dsx.action.name(argsObj)` or the bare `name(argsObj)`, chaining and sequencing them, each
call depth-capped at 32 so a recursive workflow is BOUNDED (never a hang). This corpus gates that
behavior identically on every runtime that ships the runner:
  · TS: OpenSource/Web/packages/kernel/test/action-conformance.test.ts (per-PR, web-kernel lane)
  · Kotlin: Engine/Android :core ActionConformanceTest (per-PR, android-kernel lane)
  · Swift: `struct JSERunner` (OpenSource/Engine/iOS/Stack.swift) is the reference. It EXECUTES
    this corpus via `ActionsConformance` (OpenSource/Engine/iOS/ConformanceHosts.swift), run from
    the `conformance-record` lane (RecordMain.swift) — a byte-for-byte twin of the Kotlin
    ActionConformanceTest. That lane is manual-trigger and needs a Mac, so the Swift execution is
    compile-pending until the next record run; iOS is no longer verified by parity review alone.

`actions.json` case shape:
  { name, actions: { <name>: { inputs?: {k: expr}, body } }, scope,
    run | (runAction + runPayload), runItem?, expectStore, expectEvents }
- `actions` — the component's declared `<action>` table (inputs evaluate in the CALLER scope on invoke).
- `run` — a SURFACE entry: the handler string (an `on:*` body) — a bare action name, a
  `dsx.action.x()` call, or inline statements.
- `runAction` + `runPayload` — a HOST entry: a host invokes the named action with a payload and
  NO caller scope. See below; a case sets `run` or `runAction`, never both.
- `runItem` — optional `dsx.this` payload for the entry.

THE TWO KINDS OF CALL (`entry-*` cases). Only one of them has a caller, and a declared input means
a different (both correct) thing in each. A SURFACE call comes from another action or an `on:*`
handler, so `inputs="id: item.id"` means "compute this from what the caller can see". An ENTRY call
comes from outside the document — an HTTP request, a CLI invocation, a queue message, a native host
handing over a payload — so `inputs="message"` means "I accept a payload key by that name".

The entry case was UNSPECIFIED here until 2026-08-21, and the cost of leaving it so is the reason
these fixtures exist: every runtime fell through to the surface rule, evaluated the input against an
empty scope, bound the absent sentinel and DISCARDED the host's payload. A `<server>` action
declaring `inputs="title, total"` received null for both, which made declaring the contract strictly
worse than omitting it — and each host then invented its own way around it (the CLI node stripped
declared inputs entirely, a queue drain smuggled its message through the call-args plane, the HTTP
path shipped the nulls). One unspecified case, three workarounds, one live defect.

At an entry: a declared input the payload supplies binds the payload value; one the payload omits
falls back to its expression against the store (so a declared default survives), and binds the
absent sentinel if that resolves to nothing — a declared input is ALWAYS bound. Undeclared payload
keys still bind, so declaring one input does not turn the payload into an allowlist. The entry
reading applies to the ENTRY FRAME only: one hop in, an action the entry calls is an ordinary
surface call again.
  · TS: `ActionRunner.callAction(name, {}, item, payload, { entry: true })`
  · Kotlin: `JSERunner.runAction(name, payload, item)`
  · Swift: `JSERunner.runAction(_:payload:item:)`
- `expectStore` — dot-path → value assertions on the final store (JSE-equality; absent = null).
- `expectEvents` — the ORDERED list of `dsx.event` names emitted (the workflow's fired events).

Only SYNCHRONOUS grammar here (no fetch/timers/module calls — those have their own seams/corpora), so
every runtime completes a case deterministically. Recursion cases assert TERMINATION + a guarded
result, never an exact frame count (the 32 cap is a safety net, not a contract).

RETURNING ACTIONS (the `await-action-*` cases): an action's `return <expr>` is its VALUE to an
AWAITING caller — `const r = await dsx.action.name(args)` (and the assignment form
`r = await dsx.action.name(args)`, which writes the store per the pinned `x = e` rule) binds the
envelope `{ ok: true, data: <return value, null when the action never returns> }`, the dsx.module
success shape. `return` stays LOCAL control flow otherwise (fire-and-forget calls unchanged), and a
`throw` that unwinds the callee keeps propagating as a real exception to the caller's try/catch —
it is never enveloped (actions have no `{ ok: false }` arm; errors are throws). Still synchronous:
actions only suspend at their OWN awaits, so the natives bind inline and the walk continues.

`watch-dispatch.json` — the runner half of `<watch value= on:change=>` (the W12 stale-snapshot
investigation). Case shape = actions.json plus `global` (app-wide store seed), `watches`
[{ value, handler }], `pre` [{ path, value }] (bound-control writes landing before the entry), and
`expectGlobal` (dot-path asserts on the app-wide store). Pins: never fires on subscribe; fires on
MEANINGFUL change only (JSE.watchKey — an elided deep-equal write never re-fires); the payload rides
`dsx.this` (an object value as-is, else { value: … }); and the handler observes the POST-WRITE store
(every store read inside a watch handler sees the state that triggered the fire — the filed
2026-08-17 toggle revert was the wave-7 F4 entity lexing, jse/syntax-006, never a stale snapshot).
Runners:
  · TS: OpenSource/Web/packages/kernel/test/watch-conformance.test.ts (store.watch → ActionRunner, per-PR)
  · Kotlin: Engine/Android :core WatchConformanceTest (the WatchView evaluate loop → the real JSERunner.fireWatch, per-PR)
  · Swift: WatchConformance (ConformanceHosts.swift — the WatchView evaluate/fire loop over JSERunner), run from RecordMain.swift in the `conformance-record` lane (compile-pending until the next record run, like the actions corpus above).

The SATELLITE runner (`OpenSource/Engine/iOS/JSEActions.swift`, the watch statement walker) carries
the same awaited-action grammar (`parseAwaitAction`/`runNamedForValue` — decl + assignment + bare
forms, the same envelope, throw propagation via its JSEFlow seam). Its corpus execution still rides
the planned watch-simulator lane (watch-runtime.md W2); until that lane exists the fidelity anchor
for these cases stays the Kotlin twin, which runs them in CI on every PR.
