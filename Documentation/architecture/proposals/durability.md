# Durability — the 25-year contract, in Despia terms

**Status: PROPOSED v1 — ALL FIVE PHASES LANDED** (P1 envelope · P2 explain
ledger · P3 assembly receipt · P4 typed absence · P5 contract gate — the
program is enforcing in CI; TS + Kotlin verified locally, Swift is the
compile-pending reference riding Codemagic, per the unified-codebase law).
The grounded rewrite of the 25-year architecture blueprint draft: keeps its
goal and its best mechanisms; replaces its imported machinery with the
repo's own. Companions: `../constitution.md` (the law) ·
`../facet-contracts.md` (facets, nesting, introspection — ACCEPTED,
foundation landed) · `error-system.md` (errors as values — ACCEPTED v1).

## The goal, kept

> Twenty-five years from now the repository contains renderers, targets, and
> devices that do not exist today — and the original contract still holds.
> New technology should require new or updated **modules**, never new kernel
> concepts.

That goal is right, and it is already Article 2. The blueprint's one honest
clarification is also kept, as the two promises:

- **Semantic stability** — the contracts (manifest grammar, chain identity,
  the bus shapes, the error taxonomy, the corpus) remain understandable and
  resolvable for decades.
- **Replaceable mechanics** — any implementation may be rewritten behind the
  same contract. A future port reimplements the contract; it never redesigns
  the framework.

What the blueprint missed is that Despia already possesses the strongest known
mechanism for both promises, and it is the cheapest one: **the conformance
corpus run on independent implementations**. `OpenSource/Conformance/{jse,api,
actions,errors,logs,chains}` executes on three runners today — TS per-PR,
Kotlin gradle-gated, Swift as reference. That is how the web platform survived
three decades of engine rewrites. The durability program is therefore not a
new kernel model — it is: *widen what the corpus covers, and make the build
explain itself.* Everything below serves those two sentences.

## The map — what the blueprint asked for that already exists

The blueprint's machinery is imported from ecosystems that coordinate
third-party binaries they don't control (OSGi bundles, Wasm components).
Despia is a monorepo of first-party modules compiled into one signed binary —
so most of the blueprint's asks are already satisfied, by simpler mechanisms
that are *stronger* in this setting:

| Blueprint ask | Despia mechanism, landed | Where |
|---|---|---|
| Microkernel that names no product technology | The engine names no module, scheme, component, or WebKit; audited, regression-gated | Constitution Art. 1/9 · `check_module_rules.rb` |
| Self-describing module descriptor | `dsx.json`: typed actions (`args`/`resolves`), embedded unit tests, config, per-platform contributions, `version` | any manifest, e.g. `Core/Maps`, `Core/Extensions/Watch` |
| Requirement/capability wiring | The three shapes — `dsx.module` (named call) · `fire`⇄`hook` (1-to-N) · `claim` (role ownership) — plus `dependencies` with transitive rescue | `OpenSource/Skills/cross-module-calls.md` · `dsx_graph.rb` |
| Targets without a platform enum | Registered facet words, declared by target owners; scripts ship knowing zero names | `../facet-contracts.md` |
| Availability introspection | Exclusion cascade + `DespiaExcluded.json` → `despia.excluded` / `wasExcluded`, 1:1 page/native | `../facet-contracts.md` (landed) |
| Capability security | The file-presence gate: excluded code **is not in the binary** — stronger than any runtime handle check | `prepare_modules.rb` · Art. 3 |
| Spec-defined kernel, portable forever | The conformance corpus on three independent runners | `OpenSource/Conformance/` |
| Error taxonomy | Errors are values on the bus: the ledger (ring 128), origin-tagged, corpus-gated | `error-system.md` |
| Lockfile | Per-module `dsx.lock.json` pins binary deps | `OpenSource/Skills/module-frameworks.md` |
| Deterministic assembly | The idempotence gate (second run = no diff) + sorted walks | the monorepo gate block · `DSXGraph.manifests_under` |

What the blueprint adds *on top of* this table is a solver, an IDL, signatures,
runtime authority handles, and dynamic wiring — machinery whose precondition
(independently shipped modules from authors you don't control) does not hold
here, and on iOS cannot hold for native code at all. Those items move to the
shelf (§ The shelf) or the rejected list (§ Rejected), each with its reason.

Five of its ideas are genuinely missing, cheap, and compatible with the law.
They are the program:

## P1 — The manifest envelope

**LANDED** — `DSXGraph::MANIFEST_ENVELOPE` + the pure `envelope_error`
(the `chain_errors`/`validate_chains!` split), aborted at the shared parse
funnel (`nodes_from_manifests`), whitelisted in `MANIFEST_KEYS`, gated in
`dsx_graph_test.rb` (incl. the real-tree sweep).

Add one top-level key to `dsx.json`:

```jsonc
{ "dsx": 1, "name": "Maps", "scheme": "maps", … }
```

Absence means `1`. `dsx_graph.rb` (the one manifest parser — `nodes_from_manifests`)
learns the constant and **aborts with a clear message** on a major it doesn't
know; every consumer (prepare, config codegen, registry) inherits the check
from the shared module for free.

Why now: the grammar already retires words — the `relay` key and the
`manifest.json` name died by scattered hand-written gates in
`check_module_rules.rb` (rule 12). The envelope turns the *next* retirement
into a version bump with one error site instead of a hunt. It is the
blueprint's §7.1, shrunk to its useful core: the envelope changes rarely; the
body evolves by adding keys.

One PR. No behavior change for any existing manifest.

## P2 — The explain ledger

**LANDED** — `DSXGraph.explain_ledger` (one derivation over
`initially_excluded_rels → resolve_disabled → excluded_identity_entries`,
never a second resolver), surfaced as `prepare_modules.rb --explain[=json]
[<token>]` (read-only, exits before any generation), gated by golden
fixtures in `dsx_graph_test.rb` — incl. the found nuance that a PATH entry
excludes its subtree DIRECTLY (each child names the entry), while cascade
is the containment law for children no entry matches.

```bash
ruby ClosedSource/scripts/prepare_modules.rb --explain [<token>]
```

Per node, from facts `dsx_graph.rb` **already computes** (`rescued`,
`excluded_identity_entries`, `derive_chains!`, the facet registry):

```text
Core/Health/Modules/ECG   chain health.ecg   EXCLUDED
  ✗ cascade: ancestor Core/Health excluded by entry "Core/Health/*" (excluded.json)
  ✗ rescue suppressed: cascade WINS over dependency rescue (facet-contracts §nested)
  → facet folders gone inert: ios/watch (word "watch" still registered by Core/Extensions/Watch)

Mandatory/Dom             chain dom          INCLUDED (Mandatory tier)
Core/Store                chain store        RESCUED  ← required by Custom/VerticalPlayerStack
```

This is an *emitter over existing resolution*, not a new resolver. Machine
form: the same data as JSON — it feeds P3, and `DespiaExcluded.json` is
regenerated **from it**, so the build-time explanation and the runtime
introspection plane can never drift.

The blueprint is right that *"a resolver that cannot explain itself will be
distrusted"* (§13.6) — that is its best sentence, and this phase is that
sentence, pointed at the resolver we already have. Tests: golden explain
fixtures in `dsx_graph_test.rb` (the harness already gates cascade/rescue
laws and chain derivation — explain output becomes one more matcher family).

## P3 — The assembly receipt

**LANDED** — `DSX/Modules/Config/DespiaAssembly.json`, emitted by
`prepare_modules` §13 from P2's ledger rows (write-on-change, the
DSXContentSeeds pattern). It lives in `Config/` BESIDE `excluded.json` —
the gating plane's input and its resolution receipt on one plane — where
`Config/*.json` already keeps it out of the app bundle; the shipped
introspection faces stay `DespiaPackages.json` / `DespiaExcluded.json`.

`prepare_modules.rb` additionally emits **`DespiaAssembly.json`** (family
naming: sibling of `DespiaExcluded.json`):

- every node in canonical order — chain, manifest `version`, state
  (`included | excluded | rescued`) and its P2 cause;
- the registered facet vocabulary and its owners;
- the platform facet set (`ios · android · web`);
- a digest over the canonical body. No timestamps, no absolute paths —
  byte-identical across machines and runs.

The idempotence gate already *proves* the graph is deterministic; the receipt
makes determinism a **verifiable artifact**. Two payoffs:

- **Review:** a PR's `git diff` on the receipt IS the shipped-set change —
  "this PR excludes nothing, adds chain `x.y`, re-pins nothing" at a glance.
- **Reproducibility:** CI archives the receipt per build; identical tree ⇒
  identical digest, and the pin story completes — `dsx.lock.json` pins a
  module's binaries, the receipt pins the graph.

This is the blueprint's §21 lockfile with everything speculative removed.

## P4 — Typed absence

**LANDED** — corpus-first across the three runners
(`Conformance/errors/errors.json`, five cases + the `excludedOverlay` op):
the reason IS the code. A call to a build-excluded chain answers **`excluded`**
(split out of `not_loaded` at each dispatch funnel — TS `bus.ts`, Kotlin +
Swift `Context.unhandledCallError`), the DespiaExcluded overlay entry riding
verbatim as `data` — the same fact `.excluded` introspection answers.
**`unsupported_platform` keeps its shipping name** as the never-on-facet
class (never repurpose a kept name — P5's own law; the draft spelling
`never_on_facet` is retired). `prerequisites_missing` and `unreachable` are
frozen pass-through spellings. Truly-unknown stays `not_loaded`. The corpus
also exposed and fixed a real twin divergence: post-mode funnel records are
`delivered:false` on all three runners now. The DECLARED abort:
`DSXGraph.required_absence_errors` (pure, harness-gated) — an action marked
`required: true` whose module is finally dropped while an enabled module
depends on it fails prepare before anything generates.

Article 7 stands: fail-open is law, degrade is the default, nothing here adds
a failure mode. What's added is that **absence carries a typed reason**, and
the abort tier is *declared*, not discovered:

1. **The reason enum.** `facet-contracts.md` already names the split — *never
   on this facet* vs *excluded from this build* vs *prerequisites missing*.
   Freeze the spellings — `never_on_facet | excluded | prerequisites_missing |
   unreachable` — carried on the ordinary call-failure path as a `reason`
   field on the error-ledger entry (`origin:"call"`, `error-system.md`).
   Corpus rows in `OpenSource/Conformance/errors/`, three runners, per the
   unified-codebase law.
2. **Declared abort.** An action row may declare `"required": true`: a build
   containing a bundled caller whose provider cannot answer becomes a
   **prepare-time error** — the call-tier abort facet-contracts already
   assigns (a bundled node screen invoking a non-relayable action is a build
   error). Today that abort is the relay table's special case; this makes the
   declaration general. Default remains degrade.

The blueprint's four-way `fail-build | fail-start | degrade | substitute`
(§24) collapses to two on purpose: *prepare-time abort* and *typed degrade*.
`fail-start` cannot exist under static assembly, and `substitute` is spelled
`claim` here.

## P5 — Contract evolution

**LANDED** — `ClosedSource/scripts/contract_diff.rb` (pure `classify`/`gate`
with an embedded `--self-test`, the parser_test pattern), wired into the
codemagic check chain before prepare. Modules are keyed by SCHEME (identity
survives folder moves); a removed module is the file-presence plane's
business (a notice); an unresolvable base soft-skips — a contract gate never
fails on git topology.

**One name, one shape** is law. This phase adds the evolution rules the
blueprint wanted an IDL for (§8.2) — without the IDL, because `dsx.json`
already *is* the IDL: typed `args`/`resolves`, embedded tests validated by
`verify_module_tests.rb` and played live in `OpenSource/CanvasEditor`.

The rules, enforced not prosed:

- **Compatible:** add an action; add an `optional` arg; add an `optional`
  resolves field; add tests; add `_note`.
- **Breaking:** remove or rename anything; change a type; make optional
  required. Breaking requires a **new action name** (or a major bump of the
  manifest's `version` with the old name retired loudly).

Mechanics: `ClosedSource/scripts/contract_diff.rb <base-ref>` — CI diffs every
manifest's `actions` against the PR's merge base and fails on
breaking-without-rename. Optional `"since"` on new args/fields feeds docs.
This is semver where it matters — on the action shapes markup actually calls —
with zero new languages and zero codegen.

## The shelf — deferred, each with its wake trigger

A shelf is a trigger, not a no. Reject none of these forever; adopt none of
them early:

| Shelved | Wakes when |
|---|---|
| Renderer-neutral UI-IR + a `render/tree` interface | a **second, externally-owned renderer** becomes a goal. Until then `.dsx` + the corpus IS the neutral representation, with three first-party consumers proving it |
| Provider solver (candidates, ranking, backtracking) | the first need with **two providers in one build**. Today every requirement has ≤1 candidate and `claim` decides roles; a solver would have nothing to solve |
| Signed descriptors + authority manifests | third-party modules ship as **artifacts** (a marketplace). The OTA trust chain already exists for content (`../remote-bundle-signing.md`) — data, not code |
| Dynamic resolution | never, for native code on iOS — the platform forbids executable code outside the signed bundle. The dynamic plane is the **content plane** (`../content-plane.md`), and it landed |
| Version adapters | the first breaking interface migration with **external consumers**. Today `Core/Legacy` is the adapter, and it is one excludable module (`legacy-package.md`) |
| `ClosedSource/DSX/Modules` → `ClosedSource/Modules` rename | a quiet week and one mechanical PR — pure path churn, never bundled with semantic change |

## Rejected — with reasons

| Rejected | Because |
|---|---|
| DIDL (a new interface language) | a second source of truth beside `dsx.json` + the corpus. A JSON-schema *for* `dsx.json` is welcome tooling; a new language is drift by design |
| Runtime capability handles | one process, one signed binary — no enforcement boundary exists, so the check is theater; the file-presence gate is the real authority model. Handles would also re-legalize aliasing the bus (the no-alias law) |
| "Depend on interfaces, never implementations" | deprecates the named point-to-point call — the most-used pattern and a deliberate law (the three shapes). Feature detection is `dsx.has`, not provider abstraction |
| A second identity grammar (`module#variant`, `ns:pkg/iface@v`) | identity is **derived** from the tree (the chain), reserved nine frozen. Variants are facet folders and config, not addressable units |
| Compatibility council | governance for an ecosystem of zero external authors. The constitution + PR review is the council until that changes |

## The durability laws

1. **The corpus outranks any implementation.** A future runner ships by
   passing the same suite — that is the entire porting story.
2. **New technology is a module.** The kernel learns mechanics, never
   products. (Article 2, unchanged.)
3. **Identity is derived, never declared twice.** One grammar: the chain.
4. **Absence is typed, never silent.** Every missing thing has a reason a
   tool can print.
5. **Contracts evolve by addition or by new name** — never by mutation under
   an old name.
6. **The build explains itself.** The ledger and the receipt are artifacts,
   not logs.
7. **A shelf is a trigger, not a no.** Every deferred idea names the
   condition that wakes it.

## Landing order

P1 (envelope) is one trivial PR and lands first. P2 (explain) is emitter work
over `dsx_graph.rb` facts, gated by `dsx_graph_test.rb` golden fixtures. P3
(receipt) consumes P2's data. P4 (typed absence) is the corpus phase — the
reason enum rows land in `OpenSource/Conformance/errors/` first, then the
three runners, per the unified-codebase law; the `required` abort is prepare
work. P5 (evolution lint) is a standalone CI script. Every phase is
independently green under the standard gates; none changes runtime behavior
except P4's typed reasons — which change *messages*, never outcomes.

The blueprint's closing sentence survives the rewrite intact, because it was
already true here: the kernel remains the quiet machinery underneath.
