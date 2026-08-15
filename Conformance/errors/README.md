# The error-system corpus

Platform-neutral fixtures for the DSX error system
(`OpenSource/Documentation/architecture/proposals/error-system.md`, ACCEPTED v1): the ambient
`dsx.error` hat, the error ledger, the `module.error` / `module.callFailed` hooks, the page
channel (`{scheme, event: "error"}` + the reserved `dsx` mirror), and the reactive keys
(`global.dsx.lastError` / `global.dsx.errorCount`). Every runtime runs the SAME cases through
its own bus + ledger — deterministic, no timers, no network.

| Runtime | Runner |
|---|---|
| TS kernel (per-PR, `web-kernel` lane) | `OpenSource/Web/packages/kernel/test/errors-conformance.test.ts` |
| Kotlin `:core` (per-PR, `android-kernel` lane) | `Engine/Android/core/src/test/kotlin/despia/engine/ErrorsConformanceTest.kt` |
| Swift (reference lane, Mac) | `Engine/iOS/ConformanceHosts.swift` (`ErrorsConformance.verify`) via `scripts/conformance/RecordMain.swift` |

## Case shape

```jsonc
{
  "name": "…",
  "register": [                       // optional fixture modules
    { "scheme": "errfx.x", "actions": { "boom": { "error": ["code", {…}] } } }
  ],                                  // action kinds: resolve:<v> · error:[code,data] · errorTwice:[c1,c2]
  "steps": [
    { "emit":       { "scheme": "s", "code": "c", "message?": "…", "recoverable?": true, "data?": {…},
                      "nestedEmitFromHook?": { "scheme": "s2", "code": "c2" } } },
    { "emitRepeat": { "scheme": "s", "count": 130, "codePrefix": "p_" } },   // codes p_0 … p_129
    { "jse":        { "body": "dsx.error('c', { message: '…' })", "scheme?": "owner" } },
    { "call":       { "scheme": "s", "action": "a", "args?": {…}, "mode": "await" | "post" } }
  ],
  "expect": { … }                     // see below
}
```

Step semantics:

- **emit** — an ambient emission through the module handle for `scheme` (the runner registers
  a bare module when none is fixtured). `nestedEmitFromHook` makes the harness's
  `module.error` hook emit the given error the moment it observes this one — the reentrancy
  probe: the nested emission must stay log-only (never recorded, never re-fired).
- **jse** — runs the body through the runtime's action/JSE runner; `scheme` is the surface's
  owning package (default `"app"`). `dsx.error` there is ALWAYS the ambient hat (a markup
  action holds no call to settle) and never unwinds control flow. A `throw` the body never
  catches unwinds to the top and reports through the same fan-out with `origin: "uncaught"`
  (a dict with a string `code` keeps its code/message/recoverable/data; any other value
  records code `"uncaught"` with the JSE string coercion as message; a codeless dict rides
  as `data`). A throw settled by `catch` records nothing.
- **call** — drives a bus call with optional `args`; `await` = the result form, `post` =
  fire-and-forget. The reserved scheme `dsx` answers KERNEL verbs here — the `dsx.error` verb
  { code, message?, recoverable?, data?, scheme? } runs the ambient fan-out attributed to
  the `scheme` arg (default `"page"`, the web-page bridge being the canonical caller) and
  resolves null; an unknown action on `dsx` answers `unknown_action` honestly (never
  `not_loaded` — the kernel does own the scheme). `dsx.has("dsx")` stays false: the reserved
  scheme is a kernel channel, not a module.

Expect semantics (every object comparison is a SUBSET match — unlisted keys are ignored;
listed keys compare deep-equal):

- **ledger** — exactly the entries this case APPENDED, in order (runners diff a
  before/after snapshot). Entry keys: `code`, `message` (null when omitted), `recoverable`
  (false when omitted), `data`, `scheme` (the source), `origin` (`"raised"` | `"call"` |
  `"uncaught"`), and — `origin: "call"` only — `delivered` (false = fire-and-forget: the
  call site never saw the error).
- **ledgerCount** / **ledgerTail** — absolute retained total (the ring cap is 128) and a
  subset match on the newest entries; used by the cap case where the diff form is
  impractical.
- **hooks** — observed payload lists per hook name, exact count + per-entry subset. An empty
  array asserts the hook did NOT fire during the case.
- **events** — page-channel deliveries in order: `{ scheme, event, data }`. Native runners
  observe the messenger egress (the `"web"` sink); the TS kernel observes its event plane
  (`DSXEvents`, name `"<scheme>:<event>"`). Every ambient error must appear on the module's
  own scheme AND mirrored on the reserved `dsx` scheme.
- **state** / **stateDelta** — `global.*` reads after the case (subset) / numeric deltas
  against a before-snapshot (`dsx.errorCount` is monotonic and shared, so it is always
  asserted as a delta).
- **callErrors** — the error codes the driven `call` steps received, in order.
- **jseStore** — the JSE store after the case (subset) — proves `dsx.error` records without
  unwinding.
- **schemeAvailable** — registry answers after `register` (the reserved-`dsx` case: a module
  claiming `dsx` is refused).

## Adoption (P3) — the two rows the module migration rests on

The corpus grew two cases when the module emitters moved onto the ambient verb
(`error-system.md` §4 P3): LocalAI, Vision and NFC all report failures that no caller is
waiting for, and both halves of that had to be pinned before the emitters changed.

- **`ambient-emission-outlives-its-settled-call`** — the emitting half. A streaming module
  resolves its call immediately (`{ started: true }`, or a bare resolve for a job whose
  results ride events) and fails later, so the per-call `dsx` is settled by then. The settle
  guard is per-CALL: the MODULE handle is never gagged, so the late emission records
  normally as `origin: "raised"`, and — being an ambient emission, not a call failure —
  `module.callFailed` stays silent. (Its mirror image, a settled call's own `dsx.error`
  recording nothing, is pinned by `hat-isolation-…`: together they say which handle a
  migrating module must reach for.)
- **`ambient-mirror-carries-the-full-wire-to-the-page`** — the consuming half. A page that
  trades a module's bespoke error broadcast for the canonical channel gets everything the
  bespoke payload carried: both deliveries (the module's own scheme AND the reserved `dsx`
  mirror) carry code + message + **recoverable** + scheme + origin + the free-form `data`
  the module used to flatten into custom keys.

The **dual-emit window** itself — a module keeping its legacy broadcast alongside the new
ambient emission for one release — is deliberately NOT a corpus case: a legacy broadcast is
an ordinary `Context.broadcast`, inert on the error plane by construction (no ledger entry,
no `module.error`, no `dsx` mirror). Nothing about the error plane changes when a module
finally deletes its legacy line, which is exactly what makes the window safe.

## The law, in one paragraph

`dsx.error` means "this module reports an error" on every hat: inside a call it settles that
call exactly once (unchanged, first-call-wins — hat isolation is case-pinned); on the
ambient hat it records a `DSXError` and fans out — ledger (ring 128), `module.error` hook,
page channel + `dsx` mirror, reactive keys — and is repeatable by design. Call failures feed
the same ledger with `origin: "call"` (the landed `module.callFailed` funnel stays the
transport hook). Nothing recorded ever alters control flow, and nothing here ever crashes
the app (constitution Article 7).
