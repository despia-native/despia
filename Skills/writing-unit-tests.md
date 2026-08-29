# Writing unit tests: self-contained actions in `dsx.json`

> Audience: module authors. How a package declares its command surface and its **unit tests** in one
> place — the `actions` block — so the **build gate** validates them and **StackCanvas** plays them as
> live simulations. One declaration, two consumers, no test target to wire up.

A package declares everything an action is in a single `actions` entry: its **args**, what it
**resolves** (or, for a stream, the **events** it emits), the **broadcasts** it fires, and its
**tests**. That one block is the package's typed API *and* its test suite:

- **The typed accessors** — `prepare_modules` reads each action's `args`/`resolves`/`stream` and
  generates the `dsx.module.<scheme>.<action>` dot-accessors (Swift/Kotlin/Java). See
  [typed-module-api.md](../Documentation/architecture/typed-module-api.md).
- **The build gate** — `ClosedSource/scripts/verify_module_tests.rb` checks every test is well-formed
  and its shapes agree with the action's own `args`/`resolves`/`stream`. Runs in CI.
- **StackCanvas** — `OpenSource/CanvasEditor` loads the same actions and *plays* each test:
  seed the state, call the action, watch it resolve, the broadcasts fire, the event stream animate.

---

## At a glance

```jsonc
{
  "scheme": "player",

  // package default — baseline state every test inherits (optional)
  "hydrate": { "context": { "credits": 0 } },

  "actions": {
    // a VALUE action — args in, a resolved value out
    "spend": {
      "args":     { "amount": "number" },
      "resolves": { "balance": "number" },     // the shape it resolves
      "broadcasts": ["creditsChanged"],         // bus events it can fire
      "tests": [
        { "name": "spends from balance",
          "given": { "context": { "credits": 100 } },   // precondition, merged OVER the package default
          "args":  { "amount": 30 },
          "resolve": { "balance": 70 },
          "broadcasts": [ { "event": "creditsChanged", "balance": 70 } ] },
        { "name": "rejects when insufficient",
          "given": { "context": { "credits": 10 } }, "args": { "amount": 30 }, "expectError": "insufficient" }
      ]
    },

    // a STREAM action — emits timed events (no terminal value)
    "load": {
      "args":   { "url": "string" },
      "stream": true,
      "events": ["buffer", "ready"],            // stream events it can emit
      "tests": [
        { "name": "buffers then becomes ready",
          "given": { "global": { "session": { "premium": true } } },
          "args": { "url": "https://cdn/clip.mp4" },
          "events": [ { "at": 0,   "event": "buffer", "data": { "pct": 0 } },
                      { "at": 400, "event": "ready",  "data": { "pct": 100 } } ] }
      ]
    },

    // a SUB-ACTION — dotted key
    "track.purchase": {
      "args": { "sku": "string", "value": "number" }, "resolves": { "ok": "boolean" },
      "tests": [ { "name": "tracks a purchase", "args": { "sku": "gold", "value": 9.99 }, "resolve": { "ok": true } } ]
    }
  }
}
```

[`OpenSource/CanvasEditor/sample-player.json`](../../OpenSource/CanvasEditor/sample-player.json) is
this exact deck, ready to load.

---

## The action object

Each entry under `actions` (keyed by action name, **dotted** for a sub-action like `"track.purchase"`)
declares the whole action:

| key | meaning |
|---|---|
| `args` | the call input — `name → type`, or `name → { type, optional, default }` |
| `resolves` | what the call resolves — a `type`, or an inline shape `{ field: type }`. **Omit for void or for a stream.** |
| `stream` | `true` if the action emits a `dsx.event` stream instead of resolving a single value |
| `events` | the stream event NAMES it can emit (a list of strings) — declares the stream's surface |
| `broadcasts` | the bus event NAMES it can fire via `dsx.broadcast` (a list of strings) |
| `gate` | optional — names a `veto` delegate this module declares (the kernel folds it before dispatch) |
| `tests` | the unit-test cases (below). Optional — an action with no tests still declares its contract |

### Resolve **or** stream — not both

An action normally does one of two things: it **resolves** a value (`resolves`), or it is a **stream**
(`stream: true` + `events`). The canonical action is one or the other. A handful of genuinely-streaming
APIs also resolve a terminal value when the stream ends (e.g. a BLE `scan` emits `device` events then
resolves `{ ended: true }`) — that's allowed, but it's the exception, not the shape to reach for.

### Types

One vocabulary everywhere: **`string` · `number` · `boolean` · `object` · `array` · `file`**. An inline
shape (`{ "balance": "number" }`) is an object with typed fields. Mark an arg `{ "type": "string",
"optional": true }` when the handler tolerates its absence.

---

## The test — one call, all facets

| field | required | meaning |
|---|---|---|
| `name` | **yes** | a non-empty label (shown by the gate and the StackCanvas runner) |
| `given` | no | this case's **precondition**, merged **over** the package `hydrate` — `global` / `context` / `variable` slots |
| `args` | no | the call input — validated against the action's `args` (unknown / wrong-typed / missing-required ⇒ build error) |
| `resolve` | no | the expected resolved value — validated against the action's `resolves`. **XOR** `expectError` |
| `expectError` | no | the expected `dsx.reject` code (a non-empty string). **XOR** `resolve` |
| `broadcasts` | no | bus events the call fires — `[{ "event": "name", … }]` |
| `events` | no | the timed `dsx.event` stream — `[{ "at": ms, "event": "name", "data": {…} }]`, `at` non-decreasing; **`stream: true` only** |

### `hydrate` (package default) and `given` (per-case)

A top-level `hydrate` is the baseline state seeded before *every* test; each test's `given` layers on top
(a shallow merge per slot). So `spend`'s default `{ context: { credits: 0 } }` becomes `{ credits: 100 }`
for the first case — each test states only what it changes. Three slots, each optional:

| slot | seeds | the store |
|---|---|---|
| `global` | `dsx.global` | the app / page store ([global-state.md](global-state.md)) |
| `context` | `dsx.context` | this package's own data face ([module-state.md](module-state.md)) |
| `variable` | `dsx.variable` | the surface's view-state |

### `resolve` xor `expectError`

```jsonc
{ "name": "happy path", "args": { "amount": 30 }, "resolve": { "balance": 70 } }   // dsx.resolve
{ "name": "too much",   "args": { "amount": 99 }, "expectError": "insufficient" }  // dsx.reject("insufficient")
```

`resolve` is checked against the action's `resolves` (a shape must match key-for-key; a scalar is
type-checked). An `expectError` case asserts the failure path — its input may intentionally omit or
violate the arg contract (that's how you test a "missing param" rejection), so the gate skips the
arg-contract checks for it.

---

## Run the gate

```bash
ruby ClosedSource/scripts/verify_module_tests.rb
# verify_module_tests: N action(s) · M tested · K test(s) · 0 error(s)
```

It scans every package (honouring `excluded.json`) and exits non-zero with a precise message on any
violation. Run it before you commit, with the other gates:

```bash
ruby ClosedSource/scripts/prepare_modules.rb && ruby ClosedSource/scripts/prepare_modules.rb   # idempotent
ruby ClosedSource/scripts/lint_dsx.rb --strict
ruby ClosedSource/scripts/check_module_rules.rb
ruby ClosedSource/scripts/verify_module_tests.rb
```

What the gate checks: every test has a `name`; `args` ⊆ the action's `args`, typed, required present
(skipped for `expectError`); `resolve` vs `resolves`; `resolve` XOR `expectError`; `given`/`broadcasts`/
`events` shapes; `events` ordering + `stream: true`; declared `broadcasts`/`events` are string lists.

---

## Play it in StackCanvas

Open `OpenSource/CanvasEditor/CanvasEditor.html` (no server, no build) and feed it the manifest:

```js
canvas.loadTests(playerManifest)   // reads each action's own contract + tests, + the package hydrate
const summary = canvas.runTests()  // { passed, failed, total, results } — emits a "testresult" per case
```

- **Runner** — `runTests()` validates every case exactly as the gate does and emits a `testresult`.
- **Mock mode** — while previewing a deck, a real call `dsx.module.<scheme>.<action>(args)` that matches a
  test plays its scenario: `broadcasts` fire immediately, the `events` stream fires on a clock at each `at`
  ms into the deck's `on:<event>` / callback, and the call resolves with `resolve`. `expectError` cases are
  skipped by the mock. The package `hydrate` is applied first, then the matched test's `given` on top.

---

## Gotchas

- **`actions` is the one source.** An action's `args`/`resolves`/`stream` are both the typed contract
  (they generate the dot-accessors) and what the tests validate against. There is no separate `methods`
  block any more.
- **`resolves` for a value, `stream`+`events` for a stream.** Don't reach for both — pick the one the
  handler actually does.
- **`events` need `stream: true`.** Declaring `events` on a non-stream action fails the gate.
- **`at` is non-decreasing.** The stream is a timeline; an `at` that goes backwards is a build error.
- **`resolve` xor `expectError`.** A case asserts one outcome. Want both paths? Write two cases.
- **A dotted key is a sub-action path.** `"track.purchase"` is the `purchase` sub-action of `track`; it
  generates `dsx.module.<scheme>.track.purchase`. It is not an action literally named `track.purchase`.

See also: [typed-module-api.md](../Documentation/architecture/typed-module-api.md) (the typed accessors),
[module-state.md](module-state.md) (`dsx.context`), [global-state.md](global-state.md) (`dsx.global`),
[cross-module-calls.md](cross-module-calls.md) (the call shapes),
[`OpenSource/CanvasEditor/README.md`](../../OpenSource/CanvasEditor/README.md) (the previewer).
