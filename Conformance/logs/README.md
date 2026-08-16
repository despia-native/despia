# The log corpus — `dsx.log`, the unified console primitive

Platform-neutral fixtures for the DSX logging primitive: `dsx.log(...)` in markup actions,
the module-handle form in native module code, the `console.*` builtin's feed into the same
ring, and the kernel `dsx.log` bus verb the DSXWebView page rides (`dsx.log(...)` on the
injected `window.dsx`; `despia.log` is the legacy alias). Every
runtime runs the SAME cases through its own statement runner + log ring — deterministic, no
timers, no network.

The primitive in one line: **`dsx.log` is `console.log` with a home** — one formatted line
per call, attributed to its source scheme, recorded in a structured ring the dev tooling
reads (`DSXLogBuffer`, cap 500, always on), and mirrored to the platform console (Xcode /
logcat / browser devtools; DEBUG-gated where the platform gates kernel logging — the armed
diagnostics drawer captures it on test installs either way). It never throws, never unwinds
control flow, and never grows memory unbounded.

| Runtime | Runner |
|---|---|
| TS kernel (per-PR, `web-kernel` lane) | `OpenSource/Web/packages/kernel/test/logs-conformance.test.ts` |
| Kotlin `:core` (per-PR, `android-kernel` lane) | `Engine/Android/core/src/test/kotlin/despia/engine/LogsConformanceTest.kt` |
| Swift (reference lane, Mac) | `Engine/iOS/ConformanceHosts.swift` (`LogsConformance.verify`) via `scripts/conformance/RecordMain.swift` |

## Case shape

```jsonc
{
  "name": "…",
  "steps": [
    { "jse":       { "body": "dsx.log('hello', 42)", "scheme?": "owner" } },  // markup form
    { "log":       { "scheme": "s", "args": [ "line", 7 ] } },                // module-handle form
    { "logRepeat": { "scheme": "s", "count": 505, "prefix": "line_" } },      // messages line_0 … line_504
    { "call":      { "scheme": "dsx", "action": "log", "args": {…}, "mode": "await" } }  // the bus verb
  ],
  "expect": {
    "logs":      [ { "scheme": "app", "level": "log", "message": "hello 42" } ],  // appended entries, in order (subset)
    "logCount":  500,                    // absolute retained total (the cap case)
    "logsTail":  [ { "message": "…" } ], // subset match on the newest entries
    "callErrors": [],                    // codes the driven calls received ([] = resolved)
    "jseStore":  { "after": "ran" }      // store reads after a jse step
  }
}
```

## The law

- **Formatting** — each argument formats with the HOUSE coercions, joined by single spaces:
  scalars via the JSE string coercion (booleans `"1"`/`"0"`, integral numbers without `.0`,
  null → `""`), dicts/arrays as canonical minified JSON with credential-looking keys masked
  to `•••` (the `JSERedact` contract, identical on all three renderers). Multi-key
  containers are NOT pinned — Swift's JSON writer does not order keys — so corpus containers
  stay single-key.
- **Attribution** — a markup `dsx.log` records the surface's owning package scheme (`"app"`
  unscoped); the module-handle form records the module's scheme; `console.*` feeds the same
  ring as scheme `"console"` with its own level (`log`/`info`/`debug`/`warn`/`error`);
  the kernel `dsx.log` bus verb (dispatch scheme `dsx`, action `log`) records its `scheme`
  arg, default `"page"` — the DSXWebView page is the canonical caller (`dsx.log(...)`).
- **The ring** — `DSXLogBuffer`: cap 500, oldest evicted, monotonic total survives eviction,
  always on (appending is nanoseconds; programs — not just testers — read it). Read API:
  `dsx.logs.recent()` / `.count()` / `.clear()` beside `dsx.errors`.
- **Console mirror** — every entry also emits one `[dsx.log] <scheme>: <message>` kernel-log
  line (Xcode / logcat, DEBUG builds; the armed diagnostics ring on test installs) — on web,
  one browser-console line. Logs are NOT errors: nothing here touches the error ledger, the
  hooks, or the reactive `global.dsx.*` keys.
- **Prod discipline** — production installs keep the in-memory ring (it is how a support
  build can export context) but never print: the console mirror rides `kernelLog`, which is
  DEBUG/test-gated per platform (`error-system.md` §3.6 channel table).
