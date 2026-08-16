# Build expressions — authorable build-time logic (status: LANDED B1–B4)

> **Status:** ACCEPTED + LANDED B1–B4 (2026-08-08; proposed and landed the same day —
> the open decisions are SETTLED in the spec §17). Companion docs: `../constitution.md`
> (Article 2 — a module defines its own configuration; Article 4 — every value is module
> config), `jse-platform.md` (the runtime-side JSE programme this deliberately does not
> touch), `../../../Skills/js-core.md` (the shipped JSE floor), the monorepo working rules (the
> fixtures-first law).
>
> **Implementation contract:** `../build-expressions-spec.md` — the production spec
> (grammar incl. the three-way classification, context, type mapping, error table,
> evaluator protocol, security model, conformance, settled decisions). This document is
> the *why* and the sequencing; that one is the *what*.
>
> **Landed shape:** classifier/batch `ClosedSource/scripts/build_expressions.rb` (+ tests,
> CI-wired in both gate lanes) · evaluator `OpenSource/Web/packages/kernel/bin/`
> `build-expressions.ts` (dependency-free, kernel-src only; + kernel test) · corpus
> `OpenSource/Conformance/build-expressions/` · both preparers wired (iOS
> `BUILD_EXPRESSIONS`; Android `android_build_expressions`) · B4 shipped as the
> EQUIVALENCE TEST (`test_domains_derivation_matches_app_domains_expand`) — the `domains`
> sugar stays Ruby (Mandatory/App is not expression-eligible), with the expression
> spelling proven to derive identical registrations. B5 (docs-site authoring guide)
> remains open.
>
> **The one-sentence pitch:** A module's manifest is JSON, so it can *declare* a value but
> never *derive* one — every derivation therefore lives in closed Ruby, which means the set
> of people who can add build logic is "framework engineers" and the set who need it is
> "every app author". This proposes closing that gap with the language authors already
> write: **JSE expressions inside the `{{ }}` placeholders that 33 modules use today.**

---

## 1 · Why

`dsx.json` and `config.json` are data. That is correct and worth keeping: data is
inspectable, diffable, generatable by a dashboard, and safe to accept from a customer.

But real builds derive. "Add this permission *if* ads are enabled." "Emit one filter *per*
OneLink domain." "Turn one host *into* the two Apple service strings." None of that is
expressible in JSON, so all of it lives in Ruby that ships with the framework:

| | Today |
|---|---|
| Ruby build scripts | 175 |
| `prepare_modules.rb` + Android twin | ~9,500 lines |
| Modules in the tree | 142 (68 with `config.json`) |
| Modules already using `{{ }}` placeholders | **33** |

That last row is the argument. Thirty-three modules already reach for the placeholder
grammar; they are not missing the concept, they have hit its ceiling. `{{ config.host }}`
substitutes. `{{ config.domains }}` mapped into two prefixed strings does not, so it became
Ruby in `app_domains.rb` — a closed script no module author can extend, for a derivation
that is obviously the App package's own business.

The v3 build shows the same pressure resolved the other way: its manifest generator grew
lambdas, `foreach`, and a fifteen-branch conditional chain, because the logic had to live
*somewhere* and there was no authored surface for it.

**The structural problem:** module authors own their manifest, their config, their Swift,
their Kotlin, and their markup — but not the one step that turns their config into their
platform registration. That step is framework-private, and it should not be.

---

## 1.1 · The mental model

The build has three layers. Authors own the outer two and are locked out of the middle one.

```
  DECLARE   dsx.json / config.json — "I have a domain, a usage string, an API key"
            JSON. Author owns it. Inspectable, diffable, dashboard-generatable.        ✅

  DERIVE    config ──▶ platform registration
            "one host becomes two Apple service strings"
            "ads enabled becomes one uses-permission line"
            "each OneLink becomes one intent-filter"
            Closed Ruby. Framework engineers only.                                     ❌

  EMIT      Info.plist · Runtime.entitlements · AndroidManifest.xml · build.gradle.kts
            Ruby. Framework owns it, and should.                                       ✅
```

Said another way: **today the placeholder is a pointer; what is needed is a function.**
`{{ config.x }}` *reads* a value. `{{ config.x.map(…) }}` *computes* one. Everything in this
proposal follows from that one-word change.

The derivations this domain actually needs are a small, bounded subset of JSE — all of it
already shipped and corpus-gated:

| Need | Shape | Real case |
|---|---|---|
| map / flatMap | `xs.flatMap(x => …)` | host → `applinks:` + `webcredentials:` |
| ternary | `c ? a : b` | ads on → `AD_ID` permission |
| string build | `'applinks:' + h` | any prefixed registration |
| filter | `xs.filter(x => x)` | drop unset optional config |
| presence | `modules.includes('OAuth')` | contribute only when a module is enabled |
| object literal | `{ key: v }` | a plist dict, an intent-filter row |

No new language. No new grammar. The same expressions an author already writes in a `.dsx`
action, evaluated once at build instead of every frame.

## 1.2 · Where it applies (inventory, measured not guessed)

Manifest keys that **already** reach for `{{ }}`, i.e. authors are asking for computation here:

| Key | Modules using placeholders | Derivation wanted |
|---|---|---|
| `infoPlist` | **33** | usage strings, conditional keys, URL-type and query-scheme arrays |
| `files` | **24** | name/path composition from env + config |
| `androidManifest` | **7** (29 declare the key) | permissions conditional on config, one filter per list item |
| `entitlements` | **2** (11 declare) | associated domains, app groups, capability flags |
| `buildSettings` | **2** | settings derived from config |
| `gradle` | 0 (48 declare) | conditional dependencies, version derivation |
| `capabilities` / `extensionTargets` | 0 (8 each) | contribute only when config enables the feature |

Ruby derivations that should migrate to authored expressions, in the order their value is
clearest:

1. **`app_domains.rb`** — `domains` → `applinks:`/`webcredentials:`. Shipped this cycle as
   closed Ruby; it is the poster child and the §5 acceptance test.
2. **`android_app_links.rb`** — schemes/hosts/paths → intent filters. Note the *validation*
   stays Ruby; only the value derivation moves. Security rules are not authorable.
3. **`collect_localized_plist`** — localized value maps → `.lproj` strings.
4. **Gradle dependency merge** — the union and the version-conflict resolution.
5. **Icon and launch-screen inputs** — the config-to-catalog derivation.

Not everything on that list should move, and the boundary matters: **derivation is
authorable, validation and emission are not.** A module may compute *which* hosts it
registers; it may never weaken the check that rejects a host with a path in it.

## 2 · What exists (the load-bearing walls — extend, never duplicate)

| Seam | Where | Disposition |
|---|---|---|
| The `{{ }}` placeholder grammar (whole-token + inline, `config.` / `env.` / `app.` roots) | `prepare_modules.rb` `INFO_PLACEHOLDER_RE` / `INFO_WHOLE_PLACEHOLDER_RE` | **keep** — expressions extend this, same braces |
| Per-package config loaders (one per pipeline) | `package_config_values` (iOS), `am_config_values` (Android) | **keep** — the single evaluation seam, as the `domains` expander already proved |
| JSE compiled executor (JSE → JS closures) | `OpenSource/Web/packages/kernel/src/compile/codegen.ts` | **keep** — this is the evaluator |
| Dual-executor conformance (interpreter AND compiled, one corpus) | `packages/kernel/test/conformance.test.ts` | **keep** — build evaluation joins the same gate |
| A JSE-powered Node CLI already invoked as tooling | `packages/kernel/bin/jse-audit.ts` | **precedent** — running JSE from the build is established |
| Loop budget (bounded execution) | `LOOP_CAP = 100_000`, all three runners | **keep** — bounds build evaluation too |
| Fixtures-first law (corpus → TS → Kotlin → Swift) | the monorepo working rules | **binding** — see §3.6 |

Note what is deliberately absent from this table: a Ruby JSE implementation. Writing one
would create a fourth, ungated implementation of the language the conformance corpus exists
to keep identical. This proposal never parses JSE in Ruby.

---

## 3 · The design

### 3.1 The grammar — expressions in the braces that already exist

A placeholder whose body is a bare path stays a substitution. A placeholder whose body is
an expression is evaluated as JSE and its **value** is spliced, preserving type:

```jsonc
// substitution — unchanged, no evaluator involved
"CFBundleName": "{{ config.name }}"

// expression — evaluated, returns a list
"entitlements": {
  "com.apple.developer.associated-domains":
    "{{ config.domains.flatMap(h => ['applinks:' + h, 'webcredentials:' + h]) }}"
}

// expression — conditional contribution
"androidManifest": {
  "permissions": "{{ config.ads ? ['com.google.android.gms.permission.AD_ID'] : [] }}"
}
```

Whole-token placeholders may return any JSON type (list, object, boolean, number, string).
Inline placeholders inside a larger string must return a scalar, exactly as today.

### 3.2 The context — read-only, and small

| Root | Contents |
|---|---|
| `config` | the declaring package's own resolved config values |
| `app` | App.json identity (host, name, identifiers) |
| `env` | allow-listed build environment values, as today |
| `platform` | `"ios"` / `"android"` / `"web"` — the pipeline currently generating |
| `modules` | the enabled set, for presence checks |

No filesystem, no network, no process, no other package's private config. JSE cannot reach
any of those by construction, which is precisely why it is the right language for evaluating
logic a *customer's* Custom module supplied. Raw JS would hand them the build machine.

### 3.3 Determinism — the idempotence contract

`prepare_modules` must produce identical output on a second run; that check is a committed
gate. Build evaluation therefore bans the two things that would break it:

- `Date.now()` and `new Date()` with no argument
- `Math.random()`

Rejected at evaluation with a build error naming the expression, not silently tolerated.
(The workflow runtime already applies this rule for the same reason — a non-reproducible
build is a worse failure than a missing feature.)

### 3.4 Lazy escalation — existing builds gain no dependency

Node is not currently required by the `ios-app` or `android-app` lanes, and this must not
change that for apps that do not use expressions.

```
{{ config.host }}                    → Ruby substitution, as today. Node never invoked.
{{ config.domains.flatMap(...) }}    → escalate: evaluate via the kernel's JSE executor.
```

Ruby keeps the fast path and classifies the placeholder body: a bare dotted path is
substitution, anything else is an expression. A build whose manifests contain no
expressions is byte-identical to today and needs no Node. Results are cached by
`hash(expression + context)` so repeated evaluation across 142 modules stays cheap.

### 3.5 Failure is loud

A failed expression aborts the build naming the file, the placeholder, and the JSE error.
It never yields an empty value: a silently missing entitlement is how a broken association
becomes a three-day mystery, which is the exact failure class the OAuth work spent this
cycle chasing.

### 3.6 The corpus

New authoring surface ships fixtures-first. A `Conformance/build-expressions/` corpus
covers the grammar (substitution vs expression classification, return types, inline scalar
rule), the context shape, and the determinism rejections. Because evaluation reuses the
kernel executor, the *language* is already gated by the existing JSE corpus on three
runtimes — the new corpus covers only the build-side contract.

---

## 4 · Non-goals

- **Not a general build scripting hook.** No `build/*.mjs`, no arbitrary JS, no I/O. If an
  expression cannot express it, that is a signal the primitive is missing, not that an
  escape hatch is needed.
- **Not a replacement for the Ruby pipeline.** Ruby stays the orchestrator: discovery,
  merging, file emission, validation. Expressions compute *values*, nothing else.
- **Not runtime.** `jse-platform.md` owns the runtime programme; these expressions run once,
  at build, and leave no trace in the app.

---

## 5 · Sequencing — the to-do list

Each step is independently shippable and leaves the tree green.

**B1 · Classifier.** Ruby splits a placeholder body into *path* (substitute, as today) or
*expression* (escalate). Pure Ruby, no evaluator yet; expressions abort with "not yet
supported" so the classification lands and is gated before anything can consume it.
*Gate:* new corpus for the classification rule; existing builds byte-identical.

**B2 · Evaluator seam.** One Node entry point in `packages/kernel/bin/`, invoked only for
expressions, results cached by `hash(expression + context)`.
*Gate:* `prepare_modules` ×2 idempotent; a no-expression build never spawns Node.

**B3 · Context + determinism.** The five roots (§3.2); `Date.now`/`Math.random` rejected;
failures name file + placeholder + JSE error.
*Gate:* corpus for each rejection.

**B4 · Acceptance — equivalence, without shipping the migration.** A test evaluates the
expression form of the `domains` derivation and asserts it produces byte-identical output to
`app_domains.rb`. The Ruby stays the live path (see the constraint below); the test is the
proof the expression tier is trustworthy.

**B5 · Open it to authored modules.** Document in `Skills/`, and allow Custom / per-app
modules to use expressions.

### ⚠ The constraint that shapes all of the above

**Neither the `ios-app` nor the `android-app` lane has Node.** The sole mention in
`codemagic.yaml` is a comment that "node/chromium absence soft-skips those sub-checks
(environmental)".

That kills the original B4. Migrating `Mandatory/App` — a Mandatory package, present in
every build — to an expression would make a JS toolchain a hard dependency of every native
build. So the tier splits by *who maintains the module*:

| | Derivation lives in | Needs Node |
|---|---|---|
| Mandatory / Core (framework-maintained) | Ruby, as today | no |
| Custom / per-app (author-maintained) | **expressions** | yes, for that app's lane |

This is the honest reading of the original problem anyway. The gap is not "framework
engineers cannot write Ruby" — they can. It is **"app authors have no extension point."**
Keeping framework internals in Ruby costs nothing and keeps every stock build
dependency-free; the expression tier exists precisely where it was missing.

Two consequences worth stating plainly:

- The framework's own derivations (`app_domains.rb`, `android_app_links.rb`) **stay Ruby**.
  B4 proves equivalence in a test rather than by migrating the live path.
- Any app that authors an expression needs Node in its lane. Lazy escalation (§3.4) means
  only those apps pay it, and the build should say so loudly rather than fail obscurely:
  *"this manifest uses a build expression; add Node to the lane."*

**Open infrastructure decision:** adding Node to the native lanes unconditionally would let
framework derivations migrate too, unifying the whole picture. That is a real cost against a
real simplification, and it is the maintainers' call — not something this proposal presumes.

---

## 6 · The v3 runtimes (`d-ios`, `d-android`)

None of this ports, and it should not be forced to. v3 has **no module manifests** — there is
no `dsx.json`, no per-module `config.json`, no placeholder grammar. Its build is a dashboard
function plus `Config.java` / `Config.swift` plus `sed` steps in `codemagic.yaml`.

The v3 equivalent of "authorable build logic" already exists and is the dashboard manifest
function: it has conditionals, `foreach`, and lambdas, and it is where the fifteen-branch
App Link chain lives. The gap there is different — that logic is centralised in one function
rather than owned per feature.

So the split is:

| | v4 (`despia-framework`) | v3 (`d-ios`, `d-android`) |
|---|---|---|
| Author-facing build logic | JSE expressions in the manifest | the dashboard function's DSL |
| Per-app values | `core_packages.json` → module config | env vars (`APP_LINK_PATHS`) + `Config.*` |
| Extension point for a new derivation | authored expression | edit the dashboard function |

Retrofitting an expression engine onto v3 would mean inventing the manifest layer it does not
have, for a runtime that is being superseded. The proportionate v3 answer is what the App
Link work already used: **a typed env var read by a small, tested script in the repo**, which
needs no new engine and no dashboard change.

### Not in scope for this workstream

The OAuth / App Link work that surfaced this is already shipped and does not depend on it.
`app_domains.rb` and `android_app_links.rb` keep working exactly as they are until B4 proves
the replacement produces identical bytes. This proposal is a **separate track** and should
not gate anything currently in flight.

---

## Appendix · The `domains` case, before and after

Shipped today, in a closed script no author can extend:

```ruby
# ClosedSource/scripts/app_domains.rb
derived = Array(hosts).flat_map do |authored|
  host = authored.strip.downcase
  ["applinks:#{host}", "webcredentials:#{host}"]
end
```

The same rule, owned by the package it belongs to:

```jsonc
// Mandatory/App/dsx.json
"entitlements": {
  "com.apple.developer.associated-domains":
    "{{ config.domains.flatMap(h => ['applinks:' + h, 'webcredentials:' + h]) }}"
}
```

Identical output. The difference is who can write the second one: anyone who has ever
written a `.dsx` action.
