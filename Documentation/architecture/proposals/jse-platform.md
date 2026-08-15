# The JSE platform — the four load-bearing investments (status: PROPOSED)

> **Status:** PROPOSED (v0, 2026-07-19) — design sketches for the four genuinely large
> platform items left after the syntax/stdlib waves closed the grammar gaps. Companion
> docs: `../constitution.md`, `/web/15-execution-tiers.md` + `/web/16-js-tier-performance.md`
> (the ratified tiering law this must compose with), `error-system.md` (ACCEPTED v1 — the
> ledger these items report into), `OpenSource/Skills/js-core.md` (the shipped floor).
>
> **The one-sentence pitch:** JSE's *language* is now complete enough to stop growing in
> waves — what remains is **platform work**: run each body once-compiled instead of
> re-walked (AOT), say *where* an error happened (source positions), make time-zone math
> honest (Temporal-lite), and cash in value semantics for a debugger JS apps cannot
> cheaply have (time travel).

---

## 1 · Why (one frame for four items)

The wave programme (`syntax-001..003`, `stdlib-001`, `hardening-001`, the actions corpus)
made JSE computationally complete for app logic, corpus-gated bug-for-bug on all three
renderers. The remaining gaps are not grammar. They are **properties of the platform**:

- **Execution cost.** The native runners re-walk the token stream on every evaluation —
  fine at app scale today, a tax on every `{{ }}` re-render and every hot action forever.
- **Diagnosability.** Tokens carry no positions, so a runtime error can say *what* but
  never *where*. The error ledger (`dsx.errors`) records values with no source anchor.
- **Domain honesty.** `Date` is device-local + UTC only; a scheduling app cannot express
  "9am in Europe/Berlin" without hand-rolled offset math that breaks twice a year. Money
  in doubles is a precision trap (appendix A).
- **Unclaimed leverage.** JSE's value semantics — the store holds only plain data, by law
  — makes whole-store snapshots nearly free. Nobody is spending that advantage yet.

Each item is too large for a wave: each is its own program with its own corpus additions.
This document gives each a concrete design sketch and then orders them (§4).

---

## 2 · What exists (the load-bearing walls — we extend, never duplicate)

| Seam | Where | Status |
|---|---|---|
| Token caches (tokenize once per distinct source) | web `jse/tokens.ts` `cachedTokens`, Kotlin `Jse.kt:187`, Swift `JSE.swift` twin (same key, same bound) | keep — AOT caches the *parse*, one level up |
| The compiled web executor: JSE → JS closures over semantic helpers | `OpenSource/Web/packages/kernel/src/compile/codegen.ts` (`/web/07`) | keep — **the precedent §3.1 generalizes** |
| Dual-executor conformance (interpreter AND compiled, same corpus) | `packages/kernel/test/conformance.test.ts` | keep — the gate shape natives adopt |
| Tiering law: JSE tier native-interpreted, JS tier sandboxed fallback | `/web/15`, `/web/16` (RATIFIED) | keep — AOT accelerates the JSE tier only |
| Loop budget (bounded execution) | `LOOP_CAP = 100_000` web `runner.ts`, `loopCap = 100_000` `JseRunner.kt:371`, Swift twin | keep — becomes per-app *configuration*, same default |
| The error system: `DSXError` ledger (ring 128), ambient fan-out, uncaught capture | `error-system.md` (ACCEPTED, landed ×3) | keep — positions (§3.2) enrich its entries additively |
| jse-audit: authoring-time locations via source search | `packages/kernel/bin/jse-audit.ts` (`SourceLocator`, best-effort file:line + caret) | keep — runtime positions give the same vocabulary at runtime |
| JSETrace: capped per-category diagnostic rings (actions, writes, fetches, calls) | `Engine/iOS/JSELibrary.swift:2162` | keep — the snapshot ring (§3.4) is its sibling |
| DevSettings dev center + the shared Console drawer | `Core/DevSettings/`, `Components/Console.dsx` | keep — the time-travel UI slots here |
| Date/Intl floor (local + UTC getters/setters, `Intl.*` formatters) | `js-core.md`, `stdlib-001` corpus | keep — Temporal-lite sits beside `Date`, replaces nothing |
| The fixtures-first law (corpus → TS → Kotlin → Swift) | the monorepo working rules, `Conformance/README` | binding for every item below |

---

## 3 · The design

### 3.1 The native AOT executor — parse once, run many

**Today.** All three runners cache *tokens*, then re-drive a parser/evaluator over the
token list on every evaluation (`Jse.kt:159` builds a fresh `Parser(cachedTokens(e), …)`
per eval; the Swift reference is the same shape; the web interpreter too). Every
`{{ }}` re-render, every `visible-if`, every action statement pays the walk again.

**The precedent is already in-tree.** The web's production executor
(`compile/codegen.ts`) walks the token stream **once** and emits a JS closure over an
explicit scope object `$`, where *operators compile to semantic-helper calls — the Swift
semantics, not raw JS operators* (its own words). One semantic table, corpus-gated
against the interpreter on every PR. The AOT executor is that idea minus the JS: on
iOS/Android the "emitted code" is a **closure tree** — each grammar production compiles
to a native closure (Swift `(inout Scope) -> Value`, Kotlin `(Scope) -> Any?`) that
captures its children and calls the SAME helpers the interpreter uses (`JSE.arith`,
`JSE.compare`, `member`, `index`, `truthy`, …). No codegen, no JIT, no new semantics —
the helpers *are* the semantics, so compiled and interpreted paths cannot drift
structurally. Compile once per distinct body (the existing token-cache key, one level
up: source → `CompiledProgram`), evaluate thousands of times.

- **Scope of the win.** Expressions first (`{{ }}`, `visible-if`, `<watch value>` — the
  render-bound hot path), then statement bodies (actions). Expected shape of the payoff:
  parse cost drops to zero on the steady state; evaluation becomes a closure call chain
  with no token dispatch. The interpreter REMAINS, as the reference and the fallback
  (unparseable-under-AOT bodies, and the `--interp` diagnostic lane).
- **Corpus-gated like both web executors.** The native test hosts grow the same dual
  lane `conformance.test.ts` has: every corpus case runs interpreted AND compiled, equal
  or red. Pinned quirks (store-always writes, the classic-`for` shadowing, budget
  semantics) are corpus rows already — the compiled tree must reproduce them bug-for-bug.
- **Off-main execution.** Today action bodies run on the main thread; a heavy loop janks.
  With value semantics this is fixable *safely*: a heavy action's compiled body runs on a
  worker queue against a **snapshot scope**, and its store writes queue as ordered
  **commits applied on main** (the store stays main-owned; `await` suspension points
  already exist). Reads-mid-flight see the entry's snapshot — exactly the isolation the
  entry-exclusive runner contract promises today. Opt-in per action first
  (`<action detach>`), automatic promotion later behind measurement.
- **Per-app loop budget.** `100_000` is hard-coded ×3. It becomes generated `CoreConfig`
  (per-app, same default, floor + ceiling clamped by the kernel) — bounded execution
  stays the law; only the constant becomes configuration. One corpus case pins that the
  budget still trips.

### 3.2 Source positions — errors that say *where*

**Today.** A `Token` is `{ kind, v }` — no offset, no line, on any renderer. So runtime
diagnostics locate nothing: the ledger's `DSXError` says what happened; `reportUncaught`
now carries the failing snippet, but a snippet is not a location. Authoring time is
covered — jse-audit recovers exact file:line + caret by searching the source
(`SourceLocator`) — but the runtime cannot use that trick: it holds tokens, not markup.

**The design is small; the migration is wide.** Tokens gain one field: `at` — the
character offset into the preprocessed source (line derives lazily; offsets survive the
comment-stripping pass because the preprocessor replaces comments with equal-length
blanks — verify per twin, or record a line map). Sites already know their file and base
line (the compiler/mount paths carry them). Then:

- The parser/StmtWalker threads "current statement's first token" — one field.
- Every runtime throw path (`throw` values, budget trips, helper warnings) stamps
  `at: {file, line}` into the value's ledger metadata — **additive** on `DSXError`
  (never a wire envelope key; same rule as `source`/`origin`).
- The drawer and `dsx.errors.recent()` render `Cart.dsx:41` next to the code.
- The AOT executor (§3.1) captures positions into its closures at compile time — free at
  run time.

Why it is its own wave: the change is mechanical but touches **every Token construction
×3** (tokenizer emit sites in `tokens.ts`, `Jse.kt`, `JSE.swift`, plus the synthetic
tokens sugar passes build) and every equality/corpus fixture that constructs tokens
directly. No behavior changes — which is exactly why it must not ride along inside a
behavioral wave where its diff noise would hide real changes. Fixtures first: a
`Conformance/errors/` extension pins `at` presence + line values for a known corpus of
throwing bodies, three runners.

### 3.3 Temporal-lite — explicit-IANA-zone date math

**Today.** `Date` getters/setters are device-local (plus the `getUTC*` set). A
scheduling app — "notify at 9am Europe/Berlin", "does this slot land on a Berlin
Sunday?" — has no honest spelling. Delta-based setter arithmetic (`setHours(hour + 2)`)
is ambiguous across DST transitions and answers in the *device's* zone, which is the
wrong zone whenever the user travels. This is the one domain gap that blocks a whole app
class rather than inconveniencing all of them.

**The design: one value-object constructor, zero changes to `Date`.**

```js
const z = zoned(dsx.variable.slotMs, 'Europe/Berlin')   // ms epoch + IANA zone
z.year · z.month · z.day · z.hour · z.minute · z.second · z.weekday · z.offsetMinutes
const nine = z.with({ hour: 9, minute: 0 })             // same wall-clock day, 9:00 Berlin
const next = z.plus({ days: 1 })                        // calendar-aware (23/25h DST days)
z.startOfDay()                                          // 00:00 in THAT zone
nine.toMs()                                             // back to the epoch — store it
```

- **A plain value dict** with `__` markers, like `Date`/`URL`: serializable, storable in
  `dsx.variable.*`, structural equality, string-coerces to ISO-with-offset. Statement
  mutations are not needed — the API is copy-on-`with`, the JSE norm.
- **Maps 1:1 to platform machinery**: `java.time.ZonedDateTime`/`ZoneId` (Android),
  Foundation `Calendar` + `TimeZone(identifier:)` (iOS), the host IANA database via
  `Intl` — and TC39 Temporal where present — on web. No zone table ships in the kernel.
- **Deliberately -lite**: instants + one zone + wall-clock reads + `with`/`plus`/
  `startOf`. No `Duration` algebra, no non-ISO calendars, no parsing zoo — those are the
  full-Temporal swamp; the floor covers scheduling apps.
- **Corpus-gated** (`Conformance/jse/temporal-001.json`): fixed instants around the
  Europe/Berlin spring-forward/fall-back, half-hour zones (Asia/Kolkata), and the
  `with`-across-DST cases, identical ×3 — zone math is exactly the kind of
  quietly-divergent host behavior the fixtures-first law exists for.

### 3.4 Time-travel debugging — spending value semantics

**The observation.** The store holds only plain values — no handles, no closures over
live objects, by law (`js-core.md` "value objects"). So "snapshot the app's entire
reactive state" is: copy the vars map. On iOS that copy is Swift COW dictionaries —
effectively a retain; on web a shallow `Map` copy; on Android a map copy of immutable
values. Per **entry event** (one tap, one timer fire — the natural transaction boundary
the runner already owns), a snapshot is nanoseconds-to-microseconds, not a heap walk.

**The design.** A `snapshots` ring beside JSETrace's existing category rings
(`JSELibrary.swift:2162` is the pattern: capped, DEBUG/test-channel-armed, zero cost
when off): each entry appends `{ label ("on:tap dsx.action.save"), storeBefore,
eventsEmitted, durationMs, at }`, cap ~64. Diffing two snapshots is the existing
`watchKey`/`jseEquals` machinery — no new comparison code.

- **The drawer is the UI.** The DevSettings Console drawer (`Components/Console.dsx`,
  already one DSX for iOS + Android) grows a timeline row: scrub entries, see the diff
  (key, old → new), and **Restore** — which writes `storeBefore` back through the normal
  reactive `set` sweep. The UI re-renders into the past state; no special render path,
  because state-driven rendering is the whole architecture. Errors with positions (§3.2)
  anchor each timeline row to file:line.
- **Why JS apps cannot cheaply have this.** Reference semantics: a JS heap snapshot must
  deep-clone or proxy everything, so Redux DevTools-class tooling works only where the
  app *promises* immutability and keeps the promise. DSX gets the promise from the
  language — every app, no discipline required. This is a differentiator we choose, not
  parity debt (the same argument shape as the error system's).
- **Scope fence.** Snapshots capture the STORE, not the world: module side effects
  (a sent push, a completed payment) do not replay, and restore never re-fires actions.
  A prod flight recorder is a non-goal — this is the dev drawer, test channels only.
- **Corpus** where behavior is pinned (snapshot-per-entry boundary, restore = one
  reactive sweep); the drawer UI itself is product surface, not corpus surface.

---

## 4 · Sequencing (each next for a reason)

**AOT → positions → Temporal-lite → time-travel.**

1. **AOT first** — it is the only item with zero new authoring surface (no new fixtures
   beyond the corpus that already exists), so it carries the least doctrinal risk while
   paying on every render of every app; and every later item rides it (positions compile
   into the closures for free; snapshots are cheapest when entries are fast).
2. **Positions second** — the AOT work just visited every parser/tokenizer site on all
   three kernels; landing the wide-but-mechanical `Token.at` sweep immediately after
   reuses that context while it is hot, and everything afterwards (Temporal's runtime
   errors, the time-travel timeline) inherits file:line from day one.
3. **Temporal-lite third** — the first *new authoring surface* in the sequence, so it
   goes where the fixtures-first machinery is warmed up and the executor it lands on is
   stable; it unblocks the scheduling-app class outright.
4. **Time-travel last** — pure leverage with no blocker, but it pays most when entries
   are fast (1), rows carry positions (2), and there is more surface worth debugging (3).
   Landing it last costs nothing; landing it first would mean rebuilding its rows twice.

---

## Appendix A · Decimal money (one paragraph, one convention, one rule)

Until a real decimal type exists, **money rides as integer cents** — `price: 450` means
$4.50 — because doubles hold every integer exactly up to 2^53 and `0.1 + 0.2` does not
survive an equality check; format at the edge with
`Intl.NumberFormat(…, { style: 'currency' })` over `cents / 100`. The in-repo example
fixture (`Conformance/examples/cart.dsxtest.json`) models the convention, and the new
jse-audit rule **`unsafe-number-literal`** guards the cliff edge: any numeric literal
above 2^53 flags with the instruction that backend IDs (and any monetary amount that
large) must ride as strings. Later — after Temporal-lite proves the value-object recipe
again — a `decimal('19.99')` value object (Foundation `NSDecimalNumber` /
`java.math.BigDecimal` / a small scaled-int TS twin, banker's rounding, corpus-gated)
upgrades the convention into a type; the cents convention stays valid forever, so
nothing written now needs rewriting.
