# Build expressions — production specification

> **Status:** SETTLED + LANDED v1.1 (2026-08-08), companion to
> `proposals/build-expressions.md` (the rationale and sequencing). Every §17 decision is
> settled below; B1–B4 are implemented and CI-gated. The implementation:
> Ruby classifier/batch `ClosedSource/scripts/build_expressions.rb` (+ `_test.rb`),
> evaluator CLI `OpenSource/Web/packages/kernel/bin/build-expressions.ts` (+ kernel
> test), corpus `OpenSource/Conformance/build-expressions/`, wiring in both preparers
> (`prepare_modules.rb` `BUILD_EXPRESSIONS` · `prepare_modules_android.rb`
> `android_build_expressions`).
>
> **Scope.** Build-time evaluation of JSE expressions inside `{{ }}` placeholders in
> `dsx.json` / `config.json`. Erased at build; nothing reaches a device.

---

## 1 · The one rule

A placeholder body is either a **path** (substituted, as today) or an **expression**
(evaluated). Classification is purely syntactic and decided in Ruby before any evaluator is
consulted. Everything else in this spec follows from that split.

```
{{ config.host }}                          PATH        → Ruby substitution, unchanged
{{ config.domains.flatMap(h => …) }}       EXPRESSION  → evaluated
```

---

## 2 · Grammar

### 2.1 Classification — the three-way rule

The dotted-chain SHAPE:

```
CHAIN := ROOT ( '.' IDENT )*
IDENT := [A-Za-z_][A-Za-z0-9_]*
```

A body classifies (after trimming), in order:

| Class | Condition | Behaviour |
|---|---|---|
| **path** | the pipeline's **legacy token grammar** substitutes it (`config.key`, `env.NAME`, bare `key`; on iOS also dotted `app.a.b` — Android never grew `app.` tokens) | legacy substitution, byte-for-byte, never staged |
| **expression** | anything that is not a chain (operators, calls, literals) — **or** a chain rooted in a context root (`config`/`env`/`app`/`platform`/`modules`) that the legacy grammar cannot substitute (`config.a.b`, `config.list.length`) | evaluated, or rejected with a `BX` error — never emitted raw |
| **foreign** | a chain under any other root (`dsx.variable.progress`) | **verbatim passthrough** — the ActivityKit widget-span law: those spans must reach the extension intact |

Implementation: `BuildExpressions.classify(body, legacy_re)`; the two legacy grammars are
the single-source constants `LEGACY_IOS_BODY_RE` / `LEGACY_ANDROID_BODY_RE`, aliased by
both preparers so classifier and pipeline can never disagree.

This closes the live latent bug: `{{ config.x.map(…) }}` **and** `{{ config.a.b }}` in a
manifest previously shipped literal brace text into a plist / AndroidManifest; both now
evaluate (proven in the live pipeline: `config.hosts_list.length` → `android:value="2"`).

**Bare roots stay legacy.** `{{ platform }}` is a bare identifier, which the legacy
grammar owns as a config-key lookup — it does NOT read the context root (changing that
would re-type every bare-key spelling in the field). To read a context root as a whole
token, force expression shape: `{{ (platform) }}`.

### 2.2 Positions

| Position | Form | Allowed return |
|---|---|---|
| **Whole-token** | the string is exactly one placeholder | any JSON type (§5) |
| **Inline** | placeholder embedded in a larger string | scalar only: string, number, boolean |

An inline placeholder returning a list or object is error `BX07` (§8). Whole-token is
detected by anchored match, identical to today's `INFO_WHOLE_PLACEHOLDER_RE` behaviour.

### 2.3 Escaping

A literal `{{` is written `\{\{`. The unescape pass runs **after** placeholder extraction, so
an escaped sequence is never classified. No other escape exists; `}}` needs none because an
unmatched close is literal.

### 2.4 Nesting

Placeholders do not nest. A `{{` inside a placeholder body is part of the expression source
and is a JSE syntax error. Expressions cannot reference other expressions' results (§6.3).

---

## 3 · The context object

Exactly five roots, all frozen, all read-only. There is no other reachable state.

| Root | Type | Contents |
|---|---|---|
| `config` | object | **the declaring module's own** resolved config values |
| `app` | object | `App.json` identity: `name`, `version`, `host`, `hosts`, `identifiers` — with the same trigger-variable fallbacks the iOS `{{ app.* }}` token uses (`APP_NAME` / `APP_VERSION` / `BUNDLE_ID` fill blanks). `host` collapses `hosts` (its `default` key, case-insensitive, else the first value); per-locale host logic stays runtime-only |
| `env` | object | build environment values, **least-privilege by construction**: the dict carries exactly the names spelled literally as `env.NAME` in the expression's own source — the same reach a `{{ env.NAME }}` token has today, nothing wider. A name reached any other way (computed access, aliasing) is simply absent and reads null |
| `platform` | string | `"ios"` \| `"android"` \| `"web"` — the pipeline currently generating. Whole-token spelling: `{{ (platform) }}` (§2.1); `platform.native` / `platform.os` also work |
| `modules` | string[] | **enabled** module chains, sorted, for presence checks — `modules.includes('auth.oauth')`. Runtime `has(scheme)` deliberately errors at build time (BX02) pointing here |

### 3.1 `config` resolution — identical to the substitution path

`config.x` yields exactly what `{{ config.x }}` would substitute today, which means the
platform override and localized collapse have **already been applied**:

1. entry-level platform override (`ios` / `android` key) wins over `value`
2. a localized map (`{ default, <locale>… }`) collapses to its `default`

Expressions therefore see one value, not a variant map. Authors needing the full locale map
have no path today; that is a named open decision (§17.1), not an accident.

### 3.2 Isolation

`config` is **only** the declaring module's. There is no cross-module config access, by
design — a module reads another module's declared values at runtime through
`dsx.module.<chain>.context.<var>`, and that plane deliberately does not exist at build time.
Use `modules` for presence, nothing more.

---

## 4 · Language

The evaluated language is **JSE**, unchanged, as already specified by
`OpenSource/Conformance/jse/` and implemented by the kernel executor. This spec adds no
syntax and removes none except the determinism bans (§7).

The bounded subset this domain actually exercises — all already shipped:
`map` · `flatMap` · `filter` · `includes` · `join` · ternary · string `+` · template
literals · object and array literals · comparison and logical operators.

The loop budget (`LOOP_CAP = 100_000`) applies unchanged.

---

## 5 · Return values and type mapping

| JSE value | plist / entitlements | AndroidManifest | gradle | `files` |
|---|---|---|---|---|
| string | `<string>` | attribute value, escaped | quoted literal | path segment |
| number | `<integer>` / `<real>` (§5.1) | attribute value | numeric literal | stringified |
| boolean | `<true/>` / `<false/>` | `"true"` / `"false"` | `true` / `false` | stringified |
| list | `<array>` of mapped items | one element per item (§11.2) | one line per item | error `BX07` |
| object | `<dict>` | error `BX08` | error `BX08` | error `BX08` |
| `null` / `undefined` | **key omitted entirely** | key omitted | line omitted | error `BX09` |
| `NaN` / `Infinity` | error `BX10` | error `BX10` | error `BX10` | error `BX10` |

### 5.1 Numbers

JSE numbers are IEEE doubles. A value with no fractional part and `|v| <= 2^53` emits as
`<integer>`; otherwise `<real>`. A value requiring more precision than a double holds is the
author's problem, not the build's — no silent rounding, and `NaN`/`Infinity` are rejected.

### 5.2 Null means absent

`null` omitting the key is deliberate and matches the existing repo convention that an empty
config "contributes nothing". It is what makes conditional contribution expressible without a
separate mechanism:

```jsonc
"NSCameraUsageDescription": "{{ config.camera ? config.camera_usage : null }}"
```

**The key-typo consequence, stated plainly:** a misspelled config *key*
(`config.hosts_lists` for `config.hosts_list`) reads null — JSE member semantics, the same
semantics `?? default` and ternaries depend on — so a whole-token expression built on it
quietly omits its key. This is the language's pinned behaviour, not an oversight; the
lenses are `--explain-expressions` (prints `=> null`) and the assembly receipt (§16).
`BX02` catches *root* typos (`configs.…`), which are always errors.

---

## 6 · Evaluation model

### 6.1 Order

Single pass, per module, in manifest key order, after config resolution (§3.1) and before
any merge across modules. A module's expressions cannot observe another module's emission.

### 6.2 Purity

Evaluation is a pure function of `(expression source, context)`. No I/O is reachable: JSE has
no `fetch`, no filesystem, no `process`, no `require`. This is a property of the language, not
a sandbox bolted on, which is what makes it safe to evaluate logic supplied by a customer's
Custom module.

### 6.3 No chaining

Expressions see raw resolved config, never another expression's output. Chaining would make
evaluation order observable and idempotence harder to guarantee for no real gain.

### 6.4 Memoization

Within one prepare run, identical `(source, context)` pairs evaluate once. There is
deliberately **no cross-run cache file**: correctness never depends on caching, and a stale
cache is a worse failure than a slower build.

---

## 7 · Determinism

`prepare_modules` must produce byte-identical output on a second run; that check is a
committed gate. Four builtins are therefore rejected at evaluation:

| Rejected | Why |
|---|---|
| `Date.now()`, `new Date()` with no argument | wall-clock varies per run |
| `Math.random()` | varies per run |
| `crypto.randomUUID()` | varies per run |
| `performance.now()` | wall-clock varies per run |

`new Date(<explicit value>)` is permitted — it is pure. Rejection is at evaluation with error
`BX05`, naming the **intercepted builtin** (a no-arg `new Date()` funnels through the
kernel's own `Date.now()` call, so its message names `Date.now`). Detection is by
evaluation-time interception of the bound globals, not source-text matching, so it cannot
be evaded by aliasing.

One documented sharp edge: `new Date(y, m, d)` with numeric parts constructs in the build
machine's LOCAL timezone — deterministic per machine (the twice-run gate holds), but
TZ-dependent across machines. Prefer ISO strings (`new Date('2026-01-01')`) and the
TZ-safe accessors (`toISOString`, `getTime`).

---

## 8 · Errors — complete table

Every error aborts the build. None degrades to a default, because a silently missing
entitlement is how a broken association becomes a multi-day mystery.

| Code | Condition | Message shape |
|---|---|---|
| `BX01` | syntax: unknown operator, parse residue (the evaluator runs the prefix, the tail would be dead), trailing operator (truncated source), empty body | `<file>: <key>: BX01 <detail>` |
| `BX02` | unknown reference root; the runtime planes (`global.*`/`route.*`/`cookie.*`/bare `env`); `has()` at build time | `<file>: <key>: BX02 unknown reference '<name>'; available roots: config, app, env, platform, modules` |
| `BX03` | runtime throw inside the expression | `<file>: <key>: BX03 expression threw: <message>` |
| `BX04` | loop budget exceeded | `<file>: <key>: BX04 expression exceeded the loop budget (100000)` |
| `BX05` | non-deterministic builtin (§7) | `<file>: <key>: BX05 <builtin> is not available at build time (builds must be reproducible)` |
| `BX06` | evaluator unavailable: Node absent/too old, protocol failure, batch timeout (§9.3/§9.4) | `<file>: <key>: BX06 …requires Node in the build lane…` (names `$DESPIA_NODE` and the zero-expression guarantee) |
| `BX07` | list/object in inline position, or any compound in a `files` set value | `<file>: <key>: BX07 an inline placeholder must return a scalar, got <type>` |
| `BX08` | object in a target with no dict form (AndroidManifest) | `<file>: <key>: BX08 AndroidManifest cannot represent an object value` |
| `BX09` | null in an inline position outside `files` (inline text has no absent form; in `files` null folds into the existing every-token-non-empty SKIP law instead) | `<file>: <key>: BX09 an inline placeholder requires a value; null omits a whole key, not a text fragment` |
| `BX10` | value a manifest cannot represent: `NaN`/`Infinity` (nested included), functions, Date/RegExp/URLSearchParams value objects | `<file>: <key>: BX10 <what> is not representable` |
| `BX11` | expression in an ineligible module (§13) | `<file>: <key>: BX11 build expressions are available to Custom / per-app modules; framework modules derive in Ruby` |

**Build-time is stricter than runtime, by design.** The runtime's JSE is fail-open
(contained nulls) by law; the evaluator drives the same parser fail-LOUD: unknown
operators, parse residue and truncated tails are `BX01` here even though a page would
render them as empty. `BX03`/`BX04` are containment backstops — JSE's own containment
makes them practically unreachable from expression position (division by zero is 0,
`JSON.parse` failures are null, higher-order loops are input-bounded), so the corpus does
not pin them; the codes exist so a future reachable case has a name.

Every failure in a run surfaces in ONE abort — the batch collects across all modules and
sections before raising, so a build never plays error whack-a-mole.

---

## 9 · The evaluator seam

### 9.1 Protocol

Ruby collects **every** expression in the run and issues **one** invocation. One process per
prepare, not per expression.

```jsonc
// stdin
{ "version": 1,
  "requests": [ { "id": "Mandatory/App#entitlements.com.apple…",
                  "source": "config.domains.flatMap(h => …)",
                  "context": { "config": {…}, "app": {…}, "env": {…},
                               "platform": "ios", "modules": [...] } } ] }

// stdout — one result per request, same order
{ "version": 1,
  "results": [ { "id": "…", "ok": true,  "value": ["applinks:example.com", …] },
               { "id": "…", "ok": false, "code": "BX05", "message": "…" } ] }
```

Exit `0` when the protocol succeeded, even if individual requests failed — request failures
are data, and Ruby maps them to §8 aborts so every error surfaces in one build, not one per
rerun. Non-zero exit means the evaluator itself broke, reported as `BX06`.

### 9.2 Placement

`OpenSource/Web/packages/kernel/bin/build-expressions.ts`, alongside the existing
`jse-audit.ts` — the precedent for a JSE-powered Node CLI in the kernel package. It imports
the same executor the runtime uses (`Parser`/`StackStore`/`JSESeams` from kernel src); it
does not fork a copy.

**Dependency-free by construction:** the CLI imports only kernel src (relative) and node
builtins, so `node bin/build-expressions.ts` works on a fresh clone with **no npm
install** — deliberately unlike `jse-audit.ts`, which pulls in `@despia-native/compiler`. The one
table both tools need (`KNOWN_OPS`) is mirrored, and a kernel test pins the two sets
identical so grammar growth updates both or fails loudly.

Two evaluator behaviours worth naming: unknown-reference detection rides the store's own
`onVarRead` hook (lambda parameters report the `dsx.attribute` pseudo-key and are exempt),
and the runtime planes plus `has()` are rejected through `JSESeams` bindings — aliasing
cannot reach around either.

### 9.3 When Node is absent

A run containing **zero** expressions never invokes Node and has no dependency — this is what
keeps the `ios-app` and `android-app` lanes working untouched regardless of their images. A
run containing expressions with no Node available aborts with `BX06`, whose message names
the fix rather than the symptom (`$DESPIA_NODE` overrides which binary is used; Node >=
22.18 runs the `.ts` CLI directly via type stripping).

### 9.4 Timeout

30s wall clock for the whole batch. Exceeded → `BX06` with a timeout note. The loop budget
already bounds any single expression; the timeout catches pathology in aggregate.

---

## 10 · Security model

The threat is a **Custom module supplied by a customer**, evaluated on build infrastructure.

| Concern | Mitigation |
|---|---|
| Filesystem / network / process access | Not expressible in JSE. No `require`, `fetch`, `fs`, `process` binding exists. |
| Reading another app's or module's config | `config` is the declaring module's only (§3.2). |
| Build-machine environment leakage | `env` is the existing allow-list, not `process.env`. |
| Denial of service | Loop budget + batch timeout (§9.4). |
| **Injection into generated XML / plist** | Values are **data**, escaped by the existing emitters — `xml_attr_escape` for AndroidManifest attributes, the plist writer for plist values. An expression can never contribute raw markup. This is the one property most likely to be assumed rather than verified: the emitter escapes, the expression does not pre-escape, and double-escaping is therefore a bug. |
| Non-reproducible builds | §7. |

An expression is **not** a trust boundary for *correctness* — a module can still declare a
wrong host. It is a trust boundary for *capability*, and that is what it enforces.

---

## 11 · Emission per target

### 11.1 plist / entitlements

Whole-token list → `<array>`; object → `<dict>`; scalars per §5. `null` omits the key.
Existing merge precedence across modules (Custom > Mandatory > Core) is unchanged —
expressions produce values, they do not alter merge order.

### 11.2 AndroidManifest

A list in an element-producing position emits **one complete element per item**, never a
single element with merged attributes. This matters: Android merges attributes across sibling
`<data>` elements into a cross product, so a split element silently widens an intent filter.
The `app_link_paths` emitter already follows this rule and is the reference.

### 11.3 gradle — RESERVED

`gradle` blocks are **not placeholder-bearing today**: `merged_gradle_deps` consumes
coordinates raw, with no `{{ }}` resolution at all. The type-mapping column in §5 is
therefore reserved until a gradle fill seam exists; an expression in a gradle block today
is simply a literal string, exactly as a path token would be.

### 11.4 `files`

Scalar text fragments only — a plist keypath position has no "several" form, so ANY
compound result is `BX07` even whole-token. A null (or empty-string) result folds into the
existing `set` law — *a value applies only when EVERY token resolves non-empty* — so the
committed plist stays byte-stable instead of gaining a broken value. (Android `files` rows
are asset **delivery** declarations with no content interpolation; nothing to wire there.)

### 11.5 v1 wiring map — what actually resolves expressions

| Pipeline | Sections wired |
|---|---|
| iOS (`prepare_modules.rb`) | `infoPlist` · `entitlements` · `entitlementsByTarget` · `buildSettings` · `projectAttributes` · `files[].set` |
| Android (`prepare_modules_android.rb`) | `androidManifest` (scanned post note-strip + `forEach` expansion — the exact shape the fill sees) |

Out of v1 scope, by name: `apply_package_files.rb` (the per-app override applier keeps
path-only grammar until wired) and the gradle seam above.

---

## 12 · Idempotence

The committed twice-run check is the acceptance gate. It holds because evaluation is pure
(§6.2), non-deterministic builtins are rejected (§7), iteration order over config keys is
insertion-ordered from JSON parse, and list results preserve expression order. No sorting is
applied to expression output — an author's order is meaningful and is preserved verbatim.

---

## 13 · Eligibility

| Tier | May use expressions |
|---|---|
| `Custom/*`, per-app modules | **yes** |
| `Mandatory/*`, `Core/*` | **no** — derive in Ruby |

Enforced at classification with `BX11` (no evaluator run needed — it fails identically on
a machine with no Node at all). **SETTLED** (was §17.2): the tier stands. The rationale,
corrected after measuring the lanes: Codemagic's standard images DO ship Node — the real
constraint is *hermetic stock builds everywhere*, including local dev machines and any
future lane image, not CI capability. A Mandatory module ships in every build; an
expression there would make "zero expressions → zero Node" false for every customer.
Custom/per-app modules are exactly the tier whose authors the system exists for. The
restriction is reversible in ONE place (`BuildExpressions.eligible?`) if maintainers later
choose to take the dependency; nothing else in the design assumes it.

Note the three-way rule's consequence (§2.1): a *deep* config read (`config.a.b`) in a
Mandatory/Core manifest now classifies as an expression and trips `BX11` — previously it
shipped verbatim braces. The audited catalog contains none; a framework module needing a
deep read restructures its config or derives in Ruby.

---

## 14 · Conformance

`OpenSource/Conformance/build-expressions/`:

| File | Contract | Runners |
|---|---|---|
| `classification-001.json` | the three-way split per pipeline grammar (§2.1) + span extraction + escaping | `build_expressions_test.rb` (Ruby owns classification) |
| `evaluation-001.json` | context roots, determinism bans, node-side `BX` codes, type edges | `packages/kernel/test/build-expressions.test.ts` (drives the CLI over the real protocol, one batch) **and** `build_expressions_test.rb` (replays the batch-reachable subset through the Batch layer; a property test proves the skipped cases can never stage, so nothing falls between runners) |

Position rules, per-target mapping and the Ruby-side codes (`BX06`–`BX09`, `BX11`) are
unit-tested in `build_expressions_test.rb` alone — both consuming pipelines share the one
Ruby implementation. Failure fixtures pin **codes**, never messages.

**Explicit exemption from the three-renderer law.** The monorepo working rules require new authoring
surface to ship on TS + Kotlin + Swift. Build expressions are exempt because they are
**erased at build and never reach a device** — there is no runtime behaviour for Kotlin or
Swift to match. The *language* they evaluate is already gated on all three by the existing
`Conformance/jse/` corpus; this corpus covers only the build-side contract.

---

## 15 · Back-compat

- All 33 modules currently using `{{ }}` are paths and are unaffected — same code path, same
  bytes.
- `associated_domains` and every other hand-authored value keeps working.
- Adding the classifier changes one observable behaviour, and it is a fix: a non-path body
  that today ships verbatim into the output now errors (§2.1).

---

## 16 · Observability

- `--explain-expressions` (both preparers) prints each expression with its module, key,
  resolved value and memoization state, to stderr:
  `expression Custom/Acme BXKey: "config.n * 2" => 42`.
- Every `BX` error names file, manifest key and detail; the batch aggregates every failure
  into one abort (§8).
- Evaluated values land in the assembly receipt (`DespiaAssembly.json` →
  `buildExpressions`: module/key/source/value rows) — **absent when a build has none**, so
  the stock receipt stays byte-identical. A shipped registration traces back to the
  expression that produced it.
- Evaluator kernel-style warnings (e.g. the ReDoS-pattern rejection) ride stderr and are
  forwarded, label-prefixed.

---

## 17 · Decisions — SETTLED (2026-08-08)

Formerly the open-decisions list; each is now resolved and implemented as stated.

1. **Localized config in expressions — collapse stands, full-map accessor DEFERRED.**
   `config.x` yields the same collapsed value the substitution path uses (§3.1): entry
   platform override, then localized `default`. No second accessor ships until a real
   consumer exists — a speculative locale-map API would have to guess its per-target
   mapping today and be honored forever.
2. **Node in the native lanes — the BX11 tier STANDS** (§13, rationale corrected there:
   hermetic stock builds everywhere, not CI capability — the images do ship Node).
   Reversible in one predicate if maintainers later choose otherwise.
3. **Cross-run caching — NO.** In-run memoization only (§6.4). Evaluation is a few dozen
   milliseconds per batch; a stale cache file is a categorically worse failure than any
   measured cost. Revisit only with profiling data.
4. **Expression-authored *validation* — NEVER.** Derivation is authorable; validation is
   not. A module may compute which hosts it registers; it may never weaken the check that
   rejects a host with a path in it. Structural: expression results re-enter the pipeline
   as plain VALUES upstream of every validator (`AppDomains`, `AndroidAppLinks`,
   `xml_attr_escape`), so there is no seam where an expression could bypass one — the
   guarantee is the data flow, not reviewer vigilance.
