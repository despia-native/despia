# The DSX error system — errors as values on the bus (status: ACCEPTED v1)

> **Status:** ACCEPTED (v1, 2026-07-13) — the open questions of the DRAFT round are decided
> (maintainer call: the ambient verb is **`dsx.error`**; everything else per the mental model
> + modern reactive-framework practice — see §6 *Decisions*). P1 implements this document.
> Companion docs: `../constitution.md`, `../dsx-native-bus.md`, `../typed-module-api.md`. It
> builds directly on the landed module-call diagnostics funnel (`module.callFailed`,
> `Context.reportCallFailure` — see `OpenSource/Skills/cross-module-calls.md`
> § *Observability*).
>
> **The one-sentence pitch:** make the error a **first-class bus value** — one shape, one
> verb family, one ledger — so every failure in a Despia app is *emitted properly once* and
> *observable everywhere it matters*, instead of every module inventing its own error channel.

---

## 1 · Why (the problem, precisely)

The **terminal** half of the error story is already sound and doctrinally pinned:

- A handler settles a call with `dsx.error(code, data?)` / `dsx.fail(code, message:,
  recoverable:, data:)` / `dsx.reject(…)` — one structured `{code, message, recoverable,
  data}` contract (`dsx-native-bus.md`, canonical-surface table).
- The wire pins it: `Conformance/api/wire-contract.json` reserves the envelope keys
  `code` / `recoverable` / `message` and the kernel codes `not_loaded` /
  `unsupported_platform`.
- Every caller already has an idiom: web `catch (e) { e.code; e.message; e.recoverable;
  e.data }`, native `catch ModuleCallError.actionFailed(code, data)`, DSX markup
  `const r = await dsx.module.x.y({…})` → `{ ok, data | error }`, `<api>` blocks
  `.error{status,message,body}` + `on:error` (the Nordcraft parity floor,
  `web/21-nordcraft-parity.md` — note the floor requires error handling **only** there; a
  general error system is a differentiator we choose, not a parity debt).
- Since the diagnostics-funnel change, no *call* fails invisibly: every `dsx.module` failure
  kernelLogs and fires `module.callFailed` on all three renderers.

What is missing is everything **around** the settled call. Two structural gaps:

### Gap A — there is no ambient emission verb

An error that has **no awaiting caller** has no idiomatic way to be emitted: background work
(a model download, a sync push), streamed jobs that already resolved `{started: true}`,
delegate callbacks, failures discovered *after* a fire-and-forget call settled. So every
module invented its own channel, and each invention leaked into the public docs as a
**different integration contract**:

| Module (public docs) | Channel | Error shape an app developer must handle |
|---|---|---|
| LocalAI | `dsx.broadcast("error", …)` | `{ id, errorCode, errorMessage }` (flattened, bespoke keys) |
| Vision / OCR | `window.onVisionEvent` | `{ status: "error", error: { code, message } }` |
| NFC | `window.onNFCEvent` | `{ type: "error", error: "<raw platform string>" }` |
| Clerk | `window.onClerkEvent` | `{ ok: false, error: { code, message } }` |
| Legacy extensions | `despia.variable` | **`null` is the failure signal** ("write null to signal failure") |
| WebSocket | `onWebSocketEvent` return | `false` / throw / rejected Promise ⇒ replay |

And the same census *inside* the repo — every out-of-band error **event** a module emits
today (iOS cites; the Android twins match):

| Module | Event name | Payload keys |
|---|---|---|
| Core/Auth/OAuth (`OAuth.swift:214`) | `error` | `{ reason }` |
| Core/LocalAI Cactus (`CactusController.swift:304,358,209,161,169`) | `error` / `transcribeError` / `downloadError` / `removeError` / `removeAllError` | `{ id, errorCode, errorMessage }` · `{ id, message }` · `{ message }` — three shapes in one module |
| Core/LocalAI CactusMic (`CactusMic.swift:144`) | `listenError` | `{ errorCode, errorMessage }` (no `id`) |
| Core/RevenueCat (`RevenueCatBridge.swift:304`) | `restoreFailed` | `{ errorMessage, errorCode, errorDomain }` |
| Core/Bluetooth (`BLEManager.swift:480,609`) | `ble_state`, `state:"failed"` | `{ state, deviceId, …, error }` — **HTTP-POSTed to a server URL, not even the bus** |
| Core/Dom (`Dom.swift:307`) | `fail` | `{ url[, error] }` |
| VerticalPlayerStack (`Player.dsx:184`) | `playbackError` | `{ message }` |

Nine-plus event names, five-plus payload shapes, and none of them matches the terminal
`{code, message, recoverable, data}` contract. None of them is *wrong* — each solved a real
need with the tools available. The absence of a system is the bug: at 500k+ apps the error
contract must be a **platform invariant**, not a per-module invention. (This is the same
argument, one to one, that `dsx-css.md` makes about styling and that the typed-module API
makes about calls.)

### Gap B — errors have no memory

An emitted error that nobody observed *at that instant* is gone:

- The funnel writes a **log line** (a string in the KernelLog ring), not a value — you can
  read it in the drawer, but no program can act on it.
- `StackDiagnostics` is a real structured ledger, but scoped to **parse failures** and
  **iOS-only**.
- `module.callFailed` is an in-process native hook — **it never reaches the web page**
  (`runtime.js` has no reserved error channel; delivery is keyed on the envelope's scheme and
  no kernel scheme emits errors).
- Nothing like `dsx.errors` exists on any renderer (verified — greenfield).

Concretely: a TestFlight tester's "the sync stopped working an hour ago" is unanswerable
today unless the exact log line is still in the 600-line ring *and* someone exports it.

### Three smaller defects the system should subsume

- `dsx.error` on the **registrar** handle (outside a call) is *accidental behavior* today,
  traced end-to-end: the envelope goes out with `id: null`, `runtime.js` can't match a call
  (per-call rejection is rid-keyed, `runtime.js:291-297`), so it **degrades into a one-shot
  scheme broadcast** — `despia.on(<scheme>)` subscribers see an `event: "error"` payload
  once, nobody else sees anything, and the settle guard (`claimTerminal`) then marks the
  long-lived registrar context settled, so **every subsequent `dsx.error` on that handle is
  silently swallowed**. An emission verb that half-works exactly once is worse than one that
  never works — it trains module authors on a channel that dies under their feet (which is
  precisely why the LocalAI generation reached for `dsx.broadcast` instead).
- `recoverable` is part of the pinned contract but is **write-only** today, verified: no
  reader in `runtime.js`, the web bus `fail()` adapter literally discards it
  (`bus.ts:262` — `_recoverable`), and the native terminal path drops it before any caller
  (next bullet). A system should give it a consumer (the ledger + dev UI at minimum).
- **Fidelity collapses off the web wire.** The full `{code, message, recoverable, data}`
  exists only in `Context.sendError`'s web envelope. The native/JSE paths collapse first:
  `Bridge.Outcome.error` and `ModuleCallError.actionFailed` carry **code + data only**, and
  the markup envelope is `{ ok: false, error: <code string>, data? }` (`runner.ts:617`,
  `Stack.swift:2581`, `JseRunner.kt:1429`) — so a native or markup caller can never read the
  `message` a module carefully wrote. The error *value* deserves one fidelity everywhere it
  is recorded, even where the call-site contract stays narrow (§3.1).

---

## 2 · What exists (the load-bearing walls — we extend, never duplicate)

| Seam | Where | Status |
|---|---|---|
| Terminal verbs `error/fail/reject` → `sendError` | `Engine/iOS/Context.swift` (+ Kotlin/TS twins) | keep, unchanged |
| Wire envelope pins (`code`/`recoverable`/`message`; `not_loaded`, `unsupported_platform`) | `Conformance/api/wire-contract.json` | keep — additive only |
| Typed caller errors `ModuleCallError` (3 variants, 3 renderers) | `Engine/iOS/Bridge.swift`, `Android Bridge.kt`, `Web bus.ts` | keep, unchanged |
| `{ ok, data \| error }` action envelope + `throw`→`try/catch` grammar | JSE runners (3×), corpus-pinned (`Conformance/actions` "try-catch-across-an-action-call") | keep — bug-for-bug parity is law |
| `<api>` error states `.error{status,message,body}` + `on:error` | `api-blocks.json` + 3 implementations | keep — the declarative precedent |
| Call-failure funnel: kernelLog + `module.callFailed` `{scheme, action, code, data?, delivered}` | `Context.swift` / `Context.kt` `reportCallFailure`, `bus.ts` | keep — becomes one *feeder* of the ledger |
| `KernelLogBuffer` (ring, cap 600, armed on test channels) | `Engine/iOS/KernelLog.swift` + Kotlin twin | keep — the capped-ring precedent |
| `StackDiagnostics` issues ledger + DevOverlay + drawer export | `Engine/iOS/Diagnostics.swift` | keep — parse failures stay its scope; structural template for the error ledger |
| Out-of-band page delivery: `Context.broadcast` → messenger `"web"` sink → `despia.__proxy` → `despia.on(scheme)` / `'*'` | `Context.swift:816` → `Engine/runtime.js` | keep — the ambient-error→page bridge rides exactly this |
| DevSettings dev center (rows in `Panel.dsx`, `page` action, native-sheet precedent at `DevSettings.swift:240`) | `Core/DevSettings/` | keep — "Recent errors" slots here |
| Manifest `actions` block with `tests[].expectError` (3 consumers: accessors, build gate, StackCanvas) | `typed-module-api.md` | keep — grows a declared-`errors` sibling (§3.5) |

Two pinned cross-renderer divergences worth knowing (neither is touched here): a bare
unresolvable action inside a `try` throws `{code: "unavailable", call}` on iOS/Android but
only `console.warn`s on web (`Stack.swift:3367` vs `runner.ts:207`); and the web runner adds
a `message` key to the `{ok:false}` envelope for non-module throws (`runner.ts:621`) that the
native twins don't. Both belong to the JSE-parity ledger, not to this proposal.

---

## 3 · The design

### 3.1 The value: `DSXError`

One error **value**, identical on Swift / Kotlin / TS, and identical to what the wire already
pins — no new wire shape, the existing envelope fields *are* the value:

```
DSXError {
  code:        String            // stable, snake_case, machine-branchable ("card_declined")
  message:     String?           // human-readable, safe to show
  recoverable: Bool              // retry / alternate path worth offering (advisory)
  data:        JSON?             // free-form structured detail
  // ledger metadata (NOT wire keys — additive, never serialized into call envelopes):
  source:      { scheme, action? }   // whose error this is
  origin:      "raised" | "call" | "uncaught"   // ambient emission · failed bus call ·
                                                // a markup throw that unwound uncaught (P1.5)
  at:          timestamp
}
```

- Swift `struct DSXError` (kernel), Kotlin `data class DSXError`, TS `class DSXError` beside
  `ModuleCallError` in `bus.ts`. Conversions are mechanical: `ModuleCallError` ⇄ `DSXError`,
  `dsx.fail(…)` args ⇄ `DSXError`, wire envelope ⇄ `DSXError`.
- **Full fidelity lives where the value is *recorded*, not where the call settles.** The
  PUBLIC caller contracts stay narrow (`ModuleCallError` and the `{ok, error: <code>}`
  markup envelope are untouched — widening them breaks exhaustive `catch` matches on three
  platforms, a source-compat cliff for zero caller demand). The kernel-INTERNAL
  `Bridge.Outcome.error` does widen by `message` / `recoverable` (4 kernel match sites, no
  module or app code names it), so the call-side funnel records what the module actually
  said even when the caller's envelope could not carry it — see §3.3a for the two feeder
  sites.
- **The reserved-code table becomes real documentation**: `not_loaded`,
  `unsupported_platform`, `unknown_action` (`data: {action}`), `invalid_uri`, plus the
  kernel-adjacent codes already shipping (`eval_failed`, `timeout`, `upload_failed`). One
  table in this doc's final form + the wire contract; today they are folklore spread across
  five files.

### 3.2 The verbs — the same family, and the hat decides (DECIDED: `dsx.error`)

The bus doctrine already gives `dsx` two hats ("inside an action `dsx` is the call, outside
it is the ambient handle" — `dsx-native-bus.md`; the closure parameter shadows the module
handle *on purpose*). The error verbs follow the hat — **no new verb**:

| Hat | Spelling | Meaning |
|---|---|---|
| **call `dsx`** (inside a handler) | `dsx.error(code, data?)` · `dsx.fail` / `dsx.reject` (structured) | **terminal** — settles *this* call; first call wins. Byte-for-byte unchanged. |
| **ambient `dsx`** (the module handle — `self.dsx` in native code, the registrar handle, the surface handle in markup) | the SAME verbs — `dsx.error` / `dsx.fail` / `dsx.reject` | **out-of-band emission** — there is no call to settle, so the error reports to the app: ledger + hook + page (§3.3). Repeatable (never rides `claimTerminal`). |
| caller side (any surface) | `try/catch` · `{ok, error}` · `catch (e)` | unchanged — the system adds **zero** new obligations on callers. |

Why the overload is the *right* call under the house doctrine (this reverses the DRAFT's
`dsx.raise` recommendation — maintainer decision, argued through):

- **The meaning is constant; only the routing follows the hat.** `dsx.error` always means
  "this module reports an error." Inside a call, the interested party is the caller — it
  settles. Outside a call there is no caller — it reports to the app. That is not two
  meanings for one spelling; it is one meaning with context-resolved delivery, which is the
  bus's core doctrine (`dsx` itself works exactly this way, and the per-call reads are
  already documented as "inert on the registrar handle").
- **Pit of success.** Every developer — human or LLM — types `dsx.error` first (the DRAFT's
  census proves it: the LocalAI generation *wanted* this verb and fell back to bespoke
  broadcasts when it half-worked). The obvious spelling must be the correct one; a second
  verb next to a broken first one is a trap with documentation.
- **The accident becomes the system.** Today's registrar-`dsx.error` (one accidental
  scheme-broadcast, then dead on the settle guard — §1) is *almost* the intended semantics.
  v1 replaces it outright: the ambient hat is legal, repeatable, and fans out
  deterministically. No misuse diagnosis needed — there is no misuse left to diagnose.
- `dsx.emit` stays banned; `dsx.raise` is not introduced (recorded as the road not taken).

Signature notes: nothing new on native — the existing family covers both hats
(`dsx.error(code, data?)` minimal, `dsx.fail`/`dsx.reject(code, message:, recoverable:,
data:)` structured; ambient emissions want the structured form). Inside a handler that needs
to report *ambiently* (a streaming job that already resolved), the module uses its own
handle — `self.dsx.error(…)` — exactly the shadowing the doctrine prescribes. JSE gets the
same builtin (§3.4).

### 3.3 Where an ambient error goes (deterministic fan-out, all five already have precedents)

```
dsx.error(code, …)   [ambient hat]
   │
   ├─ 1. the ERROR LEDGER          (new kernel primitive, 3 renderers — §3.3a)
   ├─ 2. kernelLog line            ("[dsx.error] localai → model_download_failed — …")
   ├─ 3. dsx.delegate.listen("module.error")  (native observer seam — crash-reporter modules, dev UI;
   │                                the semantic sibling of module.callFailed)
   ├─ 4. the page                  (broadcast on the module's OWN scheme, event "error",
   │                                payload = the wire form of the DSXError — §3.3b)
   └─ 5. reactive state            (global.dsx.lastError + global.dsx.errorCount via the
                                    declared-state plane — error state is OBSERVABLE state,
                                    the reactive-framework norm; markup binds it directly:
                                    `{{ global.dsx.lastError.message }}`, visible-if)
```

**3.3a The ledger.** A capped structured ring (cap ~128, `NSLock`/`synchronized`/plain array
— the `KernelLogBuffer` pattern with `DSXError` values instead of strings), **always on, all
channels** (appending a struct to a ring is nanoseconds; unlike the log buffer there is no
`arm()` gate because programs — not just testers — read it). Read API: `dsx.errors` —
`dsx.errors.recent()` (snapshot, newest last), `dsx.errors.clear()` (dev tooling). A new
public noun member on `dsx` is justified the same way `dsx.global` / `dsx.config` were:
nouns for stores, verbs for actions.

**Call failures feed the same ledger.** Two disjoint feeder sites, no double entries:
handler-settled errors whose caller is the **web** (the envelope path, no `onTerminal`)
append in `Context.sendError` — the one point that still holds `code + message + recoverable
+ data`; every **native/markup**-caller failure (handler-settled *and* the thrown kernel
errors `not_loaded` / `unknown_action` / `unsupported_platform` / `invalid_uri`) appends in
the landed funnel `reportCallFailure`, which alone knows the `delivered` flag. So the funnel
gains fidelity: the **internal** `Bridge.Outcome.error` widens by `message` / `recoverable`
(4 kernel match sites, zero public API — `ModuleCallError` and the markup envelope stay
untouched, that widening was rejected as a source-compat cliff). The ledger is then the ONE
answer to "what has gone wrong recently", `origin: "raised" | "call"` keeps the classes
distinguishable, and `module.callFailed` keeps firing unchanged (transport-level, includes
caller-handled errors like `card_declined`) beside the semantic `module.error`. *(One merged
hook was considered — free while unmerged — and rejected: it forces every observer to filter
transport noise from semantic errors forever. Two hooks, one ledger.)*

**3.3b The page bridge.** An ambient `dsx.error` emits through the exact existing
out-of-band path (`Context.broadcast` → messenger → `despia.__proxy` fan-out): envelope
`{ scheme: <module>, event: "error", final: true, data: <wire DSXError> }`. A page
subscribes per module — `despia.on("localai", p => { if (p.event === "error") … })` — which
is **precisely the pattern LocalAI hand-rolled**, promoted from convention to kernel
behavior with one canonical payload. Additionally the kernel mirrors every ambient error
onto the **reserved `dsx` scheme** (`despia.on("dsx", …)`) so an app builds one global error
toast without subscribing per module — the `window.onerror` analogue every modern framework
grew. (`dsx` becomes a reserved scheme the registry refuses to a module — enforced at
registration, one guard line. Ships in P1: it is three lines on top of the per-scheme
broadcast.)

**Reentrancy + storms:** the ambient fan-out reuses the funnel's guard discipline (a hook or
page handler whose own body emits must not loop the fan-out — same thread-identity guard as
`reportCallFailure`). The ledger absorbs bursts by construction (ring); the page mirror adds
no correlation state (broadcasts are fire-and-forget by design).

**Bycatch fixed in P1:** the web bus `fail()` adapter currently discards `recoverable`
(`bus.ts:262`, `_recoverable`) — with `DSXError` in place it flows through like everywhere
else. First consumer of the flag: the ledger + the DevSettings page (a "retry-worthy" badge);
kernel retry policy stays a non-goal (§3.9).

### 3.4 The authoring surface (fixtures first — the unified-codebase law)

`dsx.error(code, opts?)` becomes a JSE builtin with the ambient semantics (a markup action
never holds a call to settle, so in markup the ambient hat is the only hat — no ambiguity
exists there at all), and a markup `<action>` can emit properly too:

```xml
<action name="sync">
  try {
    const r = await dsx.module.powersync.push({})
    if (!r.ok) { dsx.error(r.error, { message: 'sync push failed', data: r.data }) }
  } catch (e) {
    dsx.error('sync_failed', { message: String(e) })
  }
</action>
```

- **Corpus first**: `OpenSource/Conformance/errors/errors.json` (+ README row) lands before
  any implementation — cases in §3.7. The builtin's statement semantics ride the same corpus.
- **`throw` / `try/catch` stay byte-identical** — the corpus already pins them
  ("try-catch-across-an-action-call"); the builtin never interacts with control flow (it is
  not a throw, it does not unwind, it records). This is a hard rule: bug-for-bug JSE parity
  is law and control-flow changes are the most dangerous class.
- **Reactive error state ships in P1** (reactive-framework decision, §6/D5): the ledger
  publishes `global.dsx.lastError` (wire shape) and `global.dsx.errorCount` through the
  EXISTING declared-state plane on every append — no new reactive machinery, two `setPath`
  calls — so markup binds error UI declaratively. `<api>` blocks keep their reserved
  `.error` paths unchanged.
- The emitting source recorded for a markup emission is the surface's owning package scheme
  (portable components never hard-code their own scheme), falling back to `"app"` for
  unscoped app-level markup — corpus-pinned.

### 3.5 The manifest: declared errors (the contract closes end-to-end)

The `actions` block (already the source for typed accessors, the build gate, StackCanvas
*and* rule 10) grows a declarative sibling:

```jsonc
"actions": {
  "charge": {
    "args": { "amount": "number" },
    "errors": {
      "card_declined":     { "message": "The card was declined.",  "recoverable": true  },
      "network_timeout":   { "message": "The payment host timed out.", "recoverable": true }
    },
    "tests": [ { "args": { "amount": -1 }, "expectError": "invalid_amount" } ]
  }
},
"errors": {                        // module-level ambient errors (ambient dsx.error codes)
  "model_download_failed": { "recoverable": true }
}
```

Consumers, in order of payoff:

1. **Docs generation** — the public setup.despia.com error zoo (§1) converges on generated,
   always-true error tables per module.
2. **`verify_module_tests.rb`** — `expectError` must name a **declared** code (today any
   string passes); a typo'd expectation becomes a build error.
3. **Typed accessors** (`prepare_config.rb`) — per-module error-code constants
   (`DomErrors.evalFailed`), so native `catch` sites stop hand-typing strings.
4. **Rule 10's sibling gate (optional tightening)** — a literal `dsx.error("…")` /
   `dsx.fail("…")` in module source whose code is undeclared can WARN (never fail — codes
   must stay runtime-open per Article 7's fail-open spirit; the *declaration* is
   documentation pressure, not a runtime wall).

Undeclared codes remain **legal at runtime** on every renderer. The gate applies to tests
and tooling, never to dispatch.

> **Status (P2):** the **grammar** (both the top-level `errors` zoo and per-action
> `actions.<a>.errors`), **consumer #2** (the `verify_module_tests.rb` gate — opt-in per
> action, reserved kernel codes always allowed), and **consumer #1** (docs generation — the
> generated `Registry/DSXErrorCatalog.json`) are **LANDED and enforcing** (unit-tested in
> `verify_module_tests_test.rb` + `generate_error_catalog_test.rb`; proof-of-use in LocalAI + Dom).
> **Consumer #3** (the Swift error-code constants — `DomErrors.evalFailed`, emitted by
> `prepare_config.rb` into `ModuleAccessors.generated.swift`) and **consumer #4** (the Rule-10
> sibling WARN — `check_module_rules` rule 20) are **LANDED (2026-07-28)**; see §4 P2. All four
> consumers now exist. Undeclared codes remain legal at runtime on every renderer — #4 is a
> WARN that never touches the exit status, and it is opt-in per module.

### 3.6 Policy: what shows where (channel discipline, unchanged philosophy)

| Channel | Ledger | Hooks (`module.error` / `module.callFailed`) | UI | Console |
|---|---|---|---|---|
| production / `appstore` | on (memory ring only) | fire — a telemetry/crash module MAY subscribe (the app's choice, a normal module) | none | none (kernelLog stays DEBUG-gated) |
| test channels (TestFlight, debug, simulator) | on | fire | **DevSettings → "Recent errors"** | DEBUG print |

- The DevSettings page: one new row in `Panel.dsx` `sections` + a branch beside
  `page == "diagnostics"` (`DevSettings.swift:240`) presenting a **native kernel sheet**
  (mirror of `StackDiagnostics.present()` — kernel-owned so it works even when DSX rendering
  itself is the thing that broke). Rows show `scheme.action → code`, message, origin,
  relative time; Copy-all/Export ride the existing drawer idiom. *(The DSX-page alternative
  via `pushPage` is viable and was mapped; the native sheet wins for the same reason
  Diagnostics is native.)*
- **No auto-present.** Parse failures auto-pop because they are rare, boot-adjacent and
  always authoring bugs. Runtime errors can be high-frequency and legitimate (a flaky
  network); a badge count on the DevSettings row is the right pressure, a modal is not.

### 3.7 Conformance + twins (what "done" means)

New corpus `OpenSource/Conformance/errors/errors.json`, cases at minimum:

1. An ambient `dsx.error` records a ledger entry with the canonical shape (code-only call
   fills defaults) and is REPEATABLE (no settle guard — the second emission records too).
2. It fires `module.error` with the wire form; a hook's own emission does not recurse.
3. It reaches the page as `{scheme, event: "error", data}` + the `dsx`-scheme mirror, and
   publishes `global.dsx.lastError` / `global.dsx.errorCount` (reactive keys).
3b. HAT ISOLATION: inside a call, `dsx.error` still settles exactly once (first-call-wins,
   envelope unchanged) — the ambient semantics never leak into the call hat.
4. A failed `dsx.module` call appends `origin: "call"` (delivered and discarded both).
5. Ring cap: N+overflow keeps the newest N, oldest dropped.
6. Reserved codes table (`not_loaded`, `unsupported_platform`, `unknown_action`,
   `invalid_uri`) — shapes pinned.
7. Registrar-`dsx.error` misuse: no envelope leaves the kernel; the misuse line is logged.

Two more landed with the **P3 adoption** slice, because the module migration rests on them
(both fit the existing case grammar — no runner changed):
`ambient-emission-outlives-its-settled-call` (a module whose call already resolved
fire-and-forget still emits ambiently; `module.callFailed` stays silent) and
`ambient-mirror-carries-the-full-wire-to-the-page` (own scheme + `dsx` mirror both carry
`recoverable` and the free-form `data`, not just the code). The dual-emit window itself is
deliberately NOT a case: a legacy `broadcast` is inert on the error plane by construction,
so nothing there changes when a module deletes its legacy line.

Runner wiring (no central registry — four known edits): TS
`packages/kernel/test/errors-conformance.test.ts`, Kotlin `ErrorsConformanceTest.kt`
(`:core`, per-PR), Swift `ErrorsConformance` in `ConformanceHosts.swift` +
`RecordMain.swift` (reference lane). The ledger + the ambient verb land on **all three renderers in the
same phase** — the bus twins have never been allowed to drift and this is a bus primitive.

### 3.8 Migration map (the zoo converges, module by module, no flag day)

| Today | Becomes | Compat |
|---|---|---|
| LocalAI `broadcast("error", {id, errorCode, errorMessage})` | ambient `dsx.fail(code, message:, data: {id})` | one release of dual-emit (legacy broadcast kept), then docs flip; page listeners keep working throughout (same scheme, same `event: "error"` name — only the payload keys canonicalize) |
| NFC `event.error` raw string | ambient `dsx.fail("nfc_failed", message: <platform string>)` | `onNFCEvent` legacy global untouched (window-global compat is legacy by doctrine, never new) |
| Vision `{status:"error", error:{code,message}}` | already canonical-adjacent — the ambient verb feeds the same shape | trivial |

> **Status (P3, executed):** LANDED for all three, in the shape above with one correction of
> record — **NFC never shipped an `onNFCEvent` in this repo**. Its census row describes the
> *public docs*, not the code: every NFC failure with a caller is already a terminal
> `dsx.fail`, so what P3 added there is the Gap-A half (the failures with *no* caller, which
> both platforms were dropping on the floor) plus its declared zoo — a pure gain, not a
> dual-emit. Vision landed as a dual-emit because its `window.onVisionEvent` delivery is real
> and still the documented contract. See §4 P3 for the per-module ledger.
| Clerk `{ok:false, error:{…}}` envelope | stays — it is a per-event protocol envelope, not an ambient error; Clerk MAY additionally emit ambiently for session-level failures | none needed |
| Legacy `despia.variable` null-signal | documented legacy, untouched | — |
| Dom `eval_failed`, kernel `unknown_action` etc. | unchanged (terminal path) — they gain ledger presence via the call-failure feeder automatically | none |

### 3.9 Non-goals (as important as the goals)

- **No exceptions across the bus.** The three `ModuleCallError` variants and the envelope
  stay the entire cross-boundary error transport.
- **No crash-on-error, ever** (Article 7). The system observes and records; it never turns a
  degradation into a failure.
- **No wire changes.** The pinned envelope keys and reserved codes are extended by
  documentation, not altered; `bridgeVersion` stays 3.
- **Not a crash-reporting product.** Sentry/Crashlytics-style shipping is a *module's* job;
  the system's job ends at giving that module one honest seam (`module.error` + the ledger).
- **No kernel retry policy.** `recoverable` stays advisory; retries belong to callers and UI.
- **`<api>` error handling stays as is** — it is already corpus-pinned parity surface.

---

## 4 · Phasing

- **P1 — the system** (one PR-sized unit per renderer, corpus-first): `DSXError` + the
  ambient `dsx.error` family + ledger + `module.error` + page bridge incl. the `dsx`
  reserved-scheme mirror + reactive keys (`global.dsx.*`) + call-failure feeder (internal
  `Outcome` widening) + `Conformance/errors/` on TS + Kotlin + Swift. **LANDED.**
- **P1.5 — capture + the log spine (LANDED with the finalization pass):**
  - **Uncaught markup throws** report through the same ambient fan-out as
    `origin: "uncaught"` (a thrown dict with a string `code` keeps its
    code/message/recoverable/data; a codeless dict rides as `data`; any other value records
    code `"uncaught"` with the JSE string coercion as message; a `catch` records nothing) —
    corpus-pinned in `Conformance/errors/`.
  - **The reserved scheme answers kernel verbs on the bus** — dispatch scheme `dsx`,
    action `error` (the ambient fan-out, source = the `scheme` arg, default `"page"`) or
    `log` — so the page in DSXWebView gets the SAME spellings markup has: `dsx.error(...)`,
    `dsx.log(...)` (window.dsx — the 1:1 surface; `despia.*` stays as the legacy alias),
    plus AUTOMATIC `window.onerror` / `unhandledrejection` forwarding (burst-guarded) with
    zero page setup (runtime.js). Unknown verbs answer `unknown_action` honestly.
  - **`dsx.log` — the logging sibling** (its own corpus, `Conformance/logs/`): the unified
    console primitive on all three renderers + the page — house formatting + JSERedact
    masking, the log ring (`DSXLogBuffer`, cap 500, `dsx.logs` read API), the `console.*`
    builtin feeding the same ring (scheme `"console"`), and one `[dsx.log]` kernelLog
    mirror line (Xcode / logcat / the armed drawer). Logs are not errors: no hooks, no
    reactive keys, no ledger crossover.
  - **DevSettings tooling (the P2 slice worth pulling forward)**: the iOS diagnostics
    drawer gains the "Recent errors" ledger section (+ the errors in the Copy-all/Export
    report), the Panel row shows a live `global.dsx.errorCount` badge, and the dev center
    gains the shared live **Console** drawer (`Components/Console.dsx`, one DSX for iOS +
    Android: a half/full sheet streaming the merged dsx.log + error rows via the
    package-private `tail` verb, tap-to-copy, `copydiag`/`sharediag` export) over the same
    rings — the `diagnostics_unavailable` stub is gone.
- **P2 — the remaining tooling** (PARTIAL — the manifest grammar, the `verify_module_tests.rb`
  gate, and docs generation (`generate_error_catalog.rb`) are LANDED; the Swift-compounding +
  speculative consumers stay open):
  - **LANDED (local-provable — Ruby + manifest + corpus):**
    - **Manifest `errors` blocks** — both zoos of §3.5's grammar: the module-level top-level
      `errors` (the ambient `dsx.error` codes, no awaiting caller) and per-action
      `actions.<a>.errors` (the call errors an action settles with). One shape both share:
      snake_case CODE → `{ message?: string, recoverable?: boolean, data?: object }`. The
      top-level key is registered in BOTH manifest envelopes — `prepare_modules.rb`
      `MANIFEST_KEYS` and the shared `dependency_license_schema.rb` `MANIFEST_KEYS` (so the iOS
      pass AND the Android pass, which validates through the same schema, both accept it) — and
      the spec word is known to the contract gate (`contract_diff.rb` `SPEC_KEYS`: an `errors`
      block is action-internal data, never a contract plane, so it is never diffed).
    - **The `verify_module_tests.rb` gate** (§3.5 consumer #2) — well-formedness of every
      declared errors block (snake_case code, object descriptor, known fields, typed
      `message`/`recoverable`/`data`), and the `expectError`-must-be-declared rule, **opt-in per
      action**: once an action declares an `errors` block, each of its tests' `expectError` must
      name a declared code (the action's own · a module-level ambient code · a reserved kernel
      code — `not_loaded` / `unsupported_platform` from `Conformance/api/wire-contract.json` plus
      the §3.1 kernel-adjacent set); an action that declares NO block keeps `expectError` free.
      This is the deliberate non-flag-day shape: the 44 manifests / ~80 existing `expectError`
      codes stay legal, adoption is incremental, and undeclared codes remain legal at runtime on
      every renderer (Article 7 fail-open — the declaration is documentation pressure, never a
      dispatch wall). Unit-tested by the new `verify_module_tests_test.rb` (fixture manifests via
      the `DSX_PACKAGES` scan-root override).
    - **Proof-of-use declarations** (declaration only — the emitter migration is P3): **LocalAI**
      — a module-level ambient zoo (`model_download_failed`, `transcribe_failed`, `listen_failed`,
      `inference_busy`) plus action-level `errors` on `detectLanguage` / `embed` / `tokenize`
      that now gate their `expectError`s; **Dom** — module-level `load_failed` / `eval_failed`
      plus action-level `errors` on `load` / `eval` / `call`. Exclusion-safe: the blocks are inert
      manifest data; excluding the module drops the whole manifest.
    - **Docs generation** (§3.5 consumer #1) — `scripts/generate_error_catalog.rb` aggregates every
      module's declared `errors` (the module-level ambient zoo + each action's call zoo) into
      `Registry/DSXErrorCatalog.json`, the always-true error tables the public setup.despia.com zoo
      converges on. It is a CROSS-MODULE reference (profile-independent, like generate_package_catalog:
      it lists LocalAI's declared codes even though production-minimal excludes the module — an
      enabled-only catalog would hide the very P2 proof-of-use), so its `--check` drift gate is
      deterministic on every lane. It re-validates each block against the §3.5 grammar fail-closed
      (the same rules verify_module_tests.rb enforces) and is wired into `prepare_modules.rb`, so the
      local double-run gate keeps it fresh and CI's `prepare_modules --check` enforces its drift.
      Unit-tested by `generate_error_catalog_test.rb`.
  - **LANDED (2026-07-28) — consumers #3 and #4 close the loop:**
    - **Accessor error constants** (§3.5 consumer #3) — `prepare_config.rb` now emits ONE
      namespace per declaring module into `Registry/ModuleAccessors.generated.swift`:
      `DomErrors.evalFailed` instead of a hand-typed `"eval_failed"`. The namespace carries the
      FLAT union of the module's two zoos (ambient + every action's call zoo), each constant
      doc-commented with its declared `message`/`recoverable`, plus a `.all: [String]`. They are
      standalone `enum`s, deliberately NOT a member on the typed module struct — the module-proxy
      reserved members are the CLOSED, FROZEN nine (`facet-contracts.md`), and a tenth would both
      break that law and shadow an action legitimately named `errors`. Emission follows the
      accessors' own laws (enabled modules only, chain-keyed, non-identifier chains skipped) and
      is a pure function of the manifests: deterministic, idempotent, with abort-tier collision
      gates on both the namespace name and the constant name. Proven locally with
      `swiftc -parse` — this generator is Swift-only because no Kotlin/TS accessor twin mirrors
      the shape (the Kotlin `ModuleAccessors.generated.kt` twin could grow the same namespaces:
      a named, un-landed follow-up).
    - **Rule 10's sibling WARN** (§3.5 consumer #4) — `check_module_rules` rule 20
      (`scripts/declared_error_usage.rb`, unit-gated by `declared_error_usage_test.rb`) flags a
      `fail("…")` / `error("…")` / `reject("…")` literal whose code is outside the module's
      declared union. WARN tier exactly as specified: printed and counted, never part of the exit
      status, because undeclared codes stay runtime-open. OPT-IN per MODULE — a module that
      declares no `errors` block anywhere is silent, mirroring consumer #2's per-action opt-in, so
      this is not a flag day. First run over the tree: **17 undeclared codes across the four
      adopters** (Dom 11 — incl. `no_webview` ×19, `origin_denied`, `unsafe_url`, `unsafe_file`;
      LocalAI 4; Vision 2), i.e. the catalog and the public zoo are currently missing them.
  - **OPEN (left for the adoption slices):**
    - **The markup-envelope widening decision** — an OWNER call, written up OPEN in §6/D6 below;
      NOT implemented in this slice.
- **P3 — adoption** (PARTIAL — the three named emitter migrations are LANDED; the public
  docs rewrite is OPEN and is its own slice):
  - **LANDED — the emitter migrations.** Every out-of-band failure in `Core/LocalAI`,
    `Core/Vision` and `Core/NFC` now reports on the AMBIENT `dsx.error` hat, on **both**
    native lanes (Swift + Kotlin twins, edited together). Every emitted code is DECLARED in
    that module's `dsx.json` `errors` block (the P2 grammar), so `generate_error_catalog.rb`
    carries the whole zoo — the catalog went from 2 modules / 14 codes to **4 modules / 27
    codes**.

    | Module | Ambient sites | Declared codes used | Shape |
    |---|---|---|---|
    | **LocalAI** (`CactusController.raise`, `CactusMic.fail`) | `downloadError` · `removeError` · `removeAllError` · `error` (inference) · `transcribeError` · `listenError` | `model_download_failed` · `model_remove_failed`\* · `inference_busy` / `inference_failed`\* · `transcribe_failed` · `listen_failed` | **DUAL-EMIT** — the legacy `broadcast("intelligence", …)` line is kept verbatim beside each ambient emission |
    | **Vision** (`VisionBridge.sendError`) | the single error funnel — input-policy violations, picker/scanner/decode failures, `unknown_command` | `ocr_failed`\* (one declared code; the precise reason rides `data.code`) | **DUAL-EMIT** — the legacy `window.onVisionEvent({status:"error"})` delivery is unchanged |
    | **NFC** (`didInvalidateWithError` / `armReader` onFailure) | a reader session that dies with **no call waiting** (previously a bare `return` / a no-op `pendingCtx?.fail`) | `session_failed`\* | **not** a dual-emit — there is no legacy channel; this is the Gap-A fix. Its call errors are now declared per action (`read`, `write`) too |

    \* declared by this slice; the rest were the P2 proof-of-use declarations, now actually emitted.

    Three properties make the dual-emit window safe, and all three are structural rather
    than promised: the legacy `broadcast` is an ordinary `Context.broadcast` and is **inert
    on the error plane** (no ledger entry, no `module.error`, no `dsx` mirror), so deleting
    it later changes nothing observable there; the ambient emission always uses the
    **module handle**, never a per-call `Context` (Vision's and LocalAI's calls have already
    resolved by then — a per-call handle would be swallowed by the terminal guard); and the
    legacy flat payload (`{id, errorCode, errorMessage}`) rides the canonical error's `data`
    verbatim, so the canonical channel is a strict superset of what the bespoke one carried.
  - **LANDED — corpus first** (`OpenSource/Conformance/errors/`, two new rows, three
    runners, **no runner code changed** — both express themselves in the existing case
    grammar): `ambient-emission-outlives-its-settled-call` (the emitting half: a settled
    call never gags its module's ambient hat; `module.callFailed` stays silent because this
    is an emission, not a call failure) and
    `ambient-mirror-carries-the-full-wire-to-the-page` (the consuming half: the module's own
    scheme AND the `dsx` mirror both carry code + message + `recoverable` + `data` + scheme
    + origin — `recoverable` being what one global error toast branches on).
  - **OPEN — the public docs rewrite (its own slice).** The generated
    `Registry/DSXErrorCatalog.json` is now complete enough to drive it, but the
    setup.despia.com error zoo (§1's table of five different integration contracts) is
    hand-written prose in a different repo surface; flipping it is a docs deliverable with
    its own review, not a code change, and it is what ENDS the dual-emit window (the legacy
    broadcast lines above are deleted only once the docs no longer describe them). Also open:
    the same treatment for the remaining census emitters (OAuth `error{reason}`, RevenueCat
    `restoreFailed`, Bluetooth's HTTP-POSTed `state:"failed"`, the `VerticalPlayerStack`
    `playbackError`) — each is an independent module slice on the same pattern.

## 6 · Decisions (v1 — closing the DRAFT's open questions)

| # | Question (DRAFT §5) | Decision | Why |
|---|---|---|---|
| D1 | Verb spelling | **`dsx.error`** (the whole `error`/`fail`/`reject` family gains the ambient hat; no `dsx.raise`) | Maintainer call; one meaning with context-resolved delivery is the bus doctrine, and the obvious spelling must be the correct one (§3.2) |
| D2 | `dsx`-scheme page mirror | **P1** | Three lines on the existing broadcast path; the `window.onerror` analogue of modern frameworks |
| D3 | Hook unification | **Two hooks** — `module.error` (semantic, new) beside `module.callFailed` (transport, landed); the ledger unifies | Observers should never have to filter transport noise; naming pairs as siblings under `module.*` |
| D4 | Ledger cap | **Flat 128** + the reentrancy guard | Per-scheme sub-caps are speculative complexity; revisit only with storm evidence |
| D5 | Reactive projection | **P1**, minimal: `global.dsx.lastError` + `global.dsx.errorCount` via the existing declared-state plane | "Reactive app framework" is the product's mental model — error state is observable state; two `setPath` calls, no new machinery |
| D6 | Markup envelope widening (`message`/`recoverable` keys) | **CLOSED — Option B, do not widen** (owner decision, 2026-08-10) | §3.1's law decides it: fidelity lives where the value is RECORDED, not where the call settles. Both readers already shipped — the reactive `global.dsx.lastError` (P1) carries `message`/`recoverable` live, and the declared `errors` table (P2) is the static code→message map. Widening would buy a destructuring convenience at the price of making the MARKUP call site richer than the NATIVE one, turning a deliberate asymmetry into an apparent accident — and would cost a 3-runner corpus change with a compile-pending Swift leg. Closed as decided, not deferred: an open decision is a standing tax on everyone who reads this table. Reopen only with a concrete authoring case the two existing readers cannot serve. |

### 6.1 · CLOSED DECISION — D6, the markup-envelope widening

> **Status: CLOSED 2026-08-10 — Option B. The envelope stays `{ ok, error, data? }`; it is NOT
> widened, and there is nothing to implement.** The owner took the recommendation below.
>
> Read the rest of this section as the RECORD OF WHY, not as a live question. Both readers a
> markup author needs already exist and both are landed: `global.dsx.lastError` for the live
> message/recoverable pair, and the declared `errors` table for the static code→message map. The
> deciding argument is §3.1's — full fidelity belongs where the value is recorded, and the public
> caller contracts stay narrow and *symmetric* across markup, native and page. Widening only the
> markup envelope would have made that symmetry look like an oversight.
>
> Reopen only against a concrete authoring case the two existing readers cannot serve. "It would
> be more convenient to destructure" is not one — that was weighed and lost.

<details>
<summary>The original framing, kept for the reasoning trail</summary>

> **(Historic — the decision above supersedes this.)** The P2 manifest grammar + gate landed
> without touching any call-site envelope. This section framed the decision for the owner —
> options + a recommendation —
> and nothing here is a commitment. Whoever decides should edit the D6 row to CLOSED and, if the
> answer is *widen*, open a separate corpus-first slice (below).

**The question.** A markup caller reads a failed `dsx.module.x.y()` as the envelope
`{ ok: false, error: <code string>, data? }` (`runner.ts:617`, `Stack.swift:2581`,
`JseRunner.kt:1429`). The declared `errors` block (now landed) gives every code a `message` and a
`recoverable` flag. Do we widen that call-site envelope to
`{ ok: false, error: <code>, message?, recoverable?, data? }` on all three JSE runners so a markup
`{ ok, error }` / `catch` site can read them at the call site — or keep the envelope code-only and
route message/recoverable through the planes that already carry them?

Key facts that bound the call:

- The markup envelope is a **dict**, so ADDING keys is source-additive — it does NOT break
  `const { ok, error } = await …` or `catch (e) { e.error }`. This is the DRAFT's "additive map
  keys" point, and it is why D6 leaned yes. (The source-compat *cliff* §3.1 warns about is the
  **native `ModuleCallError` enum**, whose exhaustive `catch` matches DO break on a new case —
  that widening stays rejected and is NOT what D6 is about.)
- §3.1's governing principle pulls the other way: **"full fidelity lives where the value is
  *recorded*, not where the call settles"**, and "the PUBLIC caller contracts stay narrow." The
  DSXError value already keeps `message`/`recoverable` in the **ledger**.
- P1 already gives markup a live reader with **zero** envelope change: `global.dsx.lastError`
  (wire shape, incl. `message` + `recoverable`) via the reactive plane —
  `{{ global.dsx.lastError.message }}`, `visible-if`.
- The landed declared-`errors` table is the **static** code→message/recoverable source (the
  "always-true" table of §3.5 consumer #1) — resolvable by a caller or the docs without a call.
- Widening touches **three runners** (one compile-pending on iOS) and a corpus (`errors/` +
  `actions/`) — the exact Swift-compounding this GA slice was scoped to avoid.

**Options.**

- **Option A — Widen (add `message` + `recoverable` to the markup envelope), corpus-first, all
  three runners.** Pro: the module's carefully-written message is readable at the point of failure
  with no extra lookup; `expectError` fixtures can additionally assert message/recoverable straight
  off the settled call; it is source-additive on a dict. Con: it contradicts §3.1's
  record-site-not-call-site principle; it makes the **markup** call-site richer than the
  **native** one (`ModuleCallError` stays code+data — a deliberate asymmetry that would now look
  accidental); and it is a 3-runner corpus change with a compile-pending Swift leg.
- **Option B — Keep the envelope code-only; route message/recoverable through the planes that
  already carry them** (the reactive `global.dsx.lastError` + the static declared-`errors` table).
  Pro: preserves §3.1's fidelity-at-the-record-site rule and the uniform-narrow-call-site symmetry
  across all three surfaces; ships **no** runner/corpus/Swift change; the readers already exist
  (both landed in P1 / P2). Con: a markup author who wants the message at a specific call site
  reads it from `global.dsx.lastError` (last-write, reactive) or maps the code via the table rather
  than destructuring one envelope; `expectError` fixtures assert the **code** only (message lives
  in the declaration, asserted there).
- **Option C — Widen the web runner only** (`runner.ts` already appends a `message` for non-module
  throws, `runner.ts:621`). Rejected on sight: it deepens the exact web/native JSE divergence the
  doc already books as debt (§2), buying a third inconsistent shape.

**Recommendation (non-binding): Option B — do not widen; defer.** The strongest law in this
document is §3.1 (fidelity at the record site, narrow uniform call-site contracts), and P1+P2
already shipped the two readers a markup author needs — the reactive `global.dsx.lastError.message`
and the static declared-`errors` table. Widening buys marginal call-site ergonomics at the cost of
(a) contradicting that law, (b) a markup-vs-native asymmetry that reads as accident, and (c) a
3-runner + compile-pending-Swift + corpus change — precisely the compounding a local slice should
not fold in silently. If concrete caller demand appears, re-open as its OWN corpus-first slice:
new rows in `Conformance/errors/` (the envelope carries `message`/`recoverable`) and `actions/`
(an `expectError` case asserts them), then TS → Kotlin → Swift, `bridgeVersion` unchanged (still a
non-wire, JSE-envelope change). Until then the DRAFT's "leaning yes" is superseded by "the readers
already exist — prove the demand first."

</details>
