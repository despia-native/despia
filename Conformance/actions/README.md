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
  { name, actions: { <name>: { inputs?: {k: expr}, body } }, scope, run, runItem?, expectStore, expectEvents }
- `actions` — the component's declared `<action>` table (inputs evaluate in the CALLER scope on invoke).
- `run` — the entry handler string (an `on:*` body): a bare action name, a `dsx.action.x()` call, or
  inline statements.
- `runItem` — optional `dsx.this` payload for the entry.
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

The SATELLITE runner (`OpenSource/Engine/iOS/JSEActions.swift`, the watch statement walker) carries
the same awaited-action grammar (`parseAwaitAction`/`runNamedForValue` — decl + assignment + bare
forms, the same envelope, throw propagation via its JSEFlow seam). Its corpus execution still rides
the planned watch-simulator lane (watch-runtime.md W2); until that lane exists the fidelity anchor
for these cases stays the Kotlin twin, which runs them in CI on every PR.
