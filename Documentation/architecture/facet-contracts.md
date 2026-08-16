# Facet contracts — one word, declared residence, declared reach

**Status: ACCEPTED v1 — foundation LANDED** (facet registry · contract grammar ·
nested modules · build-visibility introspection · the runtime **resolution
ladder**, corpus-gated on TS + Kotlin with Swift declared open). The facet
source FOLDER fan-in is the one staged phase left (see *What landed, what's
staged*). Companion proposal: `proposals/watch-capabilities.md`.

## The problem

A module is one organ with one scheme — but it may have many runtimes: the app
process, the watch process, a clip, the Wear twins. The manifest used to
describe one implicit runtime (the app). The moment code runs on a second
target, three questions appear: *where does each action live? who may call it
from afar? what happens when a runtime asks for something that isn't there?*
Every answer here is a declaration — no facet name is kernel-known, and nothing
is watch-specific.

## The facet registry — no name is kernel-known

A **facet** is a registered word binding a folder name to a target. The module
that OWNS a target binds the word:

```jsonc
// Mandatory/App — the host binds "app"
"facet": "app",
// Core/Extensions/Watch — the target owner binds "watch"
"extensionTargets": [{ "name": "DespiaWatch", "kind": "watch", "facet": "watch", … }]
```

A module may own **more than one word**, and then `facet` holds an ARRAY:

```jsonc
// Core/LocalAI — the tool registry AND the provider registry
"facet": [
  { "word": "tools",    "declarations": { … "emit": "ToolsMap" } },
  { "word": "provider", "declarations": { … "emit": "ProviderMap" } }
]
```

The array is repetition and nothing else. Each element is a word String or an
object-form registration, validated exactly as it would be validated alone, so
there is no third grammar to learn. `DSXGraph.facet_words` returns every word in
manifest order; `facet_word` still returns the FIRST, because folder and target
binding are single-valued by nature — a module lives in one folder. **A
namespace still has ONE owner, and that now includes itself**: binding the same
word twice inside one array aborts, so the law cannot be dodged by
self-collision. This exists because a registry owner must outlive everything
registered under it. Splitting a second word onto a child module would look
tidier and would be a trap: excluding that child would delete the whole
namespace, taking every other module's rows with it.

Declared **node roles** (`activity`, `widget` — the snapshot nodes) are facet
words too. The scripts learn the vocabulary ONLY from these declarations
(`facet_registry` in prepare_modules); today's registered set on the template
is `activity · app · watch · widget`. Several targets/nodes may bind the same
word — a facet word names a KIND of surface, not an instance. A
`provides`/`reach` naming anything else warns at prepare time with the
registered words AND their owners — the fail-early tier ("generation-time
error when manifest-knowable"; cf. Expo's prebuild throw). Two deliberate
tier choices:

- **Vocabulary comes from ALL manifests, enabled and excluded.** Excluding a
  facet's owning module changes *availability* (the ladder answers
  `unavailable`), never *spelling* — an excluded owner must not turn every
  other module's contract lines into unknown-word noise.
- **The gate warns; it does not abort.** A declaration is an OFFER, not a
  call: deleting a facet's owner from the tree (the file-presence law) must
  not hard-fail the modules still addressing it. The abort tier belongs to
  CALLS — a bundled node screen invoking a non-relayable action is a build
  error (rule 10's sibling), because there the callee must exist in the same
  build.

## The contract — residence and reach, per action

```jsonc
"actions": {
  "locate": {
    "args": { "accuracy": { "type": "string", "optional": true } },
    "resolves": { "lat": "number", "lng": "number", "onWrist": { "type": "boolean", "optional": true } },
    "provides": ["app", "watch"],      // where a LOCAL implementation lives
    "reach":    ["activity", "widget"] // who may call it OVER THEIR LINK
  }
}
```

- **`provides`** — the facets whose runtime implements the action locally.
- **`reach`** — the facets that may invoke it remotely; this is what the
  compiled per-node capability tables are generated from (fail-closed — a call
  a table doesn't admit never fires). Per-action `reach` overrides the module
  default; explicit `false` is the deny. `reach` is THE spelling: the `relay`
  manifest key and the `true ≡ ["watch"]` shorthand are RETIRED grammar
  (pre-release cleanup — a facet word is never implicit), aborted at prepare
  and errored by check_module_rules. The generated table keeps `relay` as its
  FIELD name — that is the mechanism's noun on the wire, not a manifest key.
  (The page-facing legacy surface — `window.despia`, old scheme spellings —
  is a separate, kept compatibility contract; retiring internal grammar never
  touches it.)
- **One name, one shape.** A facet differs in PRESENCE, never in arg/result
  shape; a runtime that can't fill a field ships it `optional` and omits it.
  Genuinely different semantics = a different action name.

**The resolution ladder** (LANDED — TS + Kotlin; corpus
`OpenSource/Conformance/facets/`): a call resolves local → declared reach over
the link → typed `unavailable` error into the ledger. The caller never spells
the route; markup ships identically on every surface. Following Capacitor's
typed-code contract, absence splits into *never on this facet* vs *excluded
from this build* vs *prerequisites missing* — all through the ordinary
call-failure path, never a side channel.

The kernel knows no facet word: a runtime binds one registered word and
consumes a compiled capability table, both build data arriving through an
empty seam (`FacetSeam` — TS `packages/kernel/src/bus.ts`, Kotlin `:core`
`Facets.kt`). The decision itself is ONE pure function over eight facts
(`resolveFacetLadder` / `FacetLadder.resolve`), which is what the corpus
drives; the dispatch funnels resolve the facts and compose the envelope each
code has always carried. Precedence is frozen and deliberate:

| Rung | Answer |
|---|---|
| 1 · local | a registered module answering this action wins before the table is consulted — a partly-local chain never pays for it |
| 2 · reach | the row admits THIS facet ⇒ over the link; admitted with no transport ⇒ the typed `unreachable`, never a hang. Fail-closed: an absent `reach` admits nobody, `false` is the deny |
| 3 · typed unavailable | `unknown_action` (the module IS here — a caller bug, not absence) > `unsupported_platform` (the platform catalog, then a row that neither provides nor reaches us — the NEVER-ON-THIS-FACET class) > `excluded` (a build fact beats a runtime one) > `prerequisites_missing` (the row promised a local implementation nothing stood up) > `not_loaded` |

`unsupported_platform` **keeps** the never-on-this-facet meaning it always had
on the wire — durability P4 retired the draft spelling `never_on_facet`, and
the corpus asserts it can never be produced. **The empty seam is the default
and is not a failure mode:** an unbound runtime with an empty table answers
exactly what the funnels answered before the ladder existed, which is what let
it land in kernels whose builds have no facets yet.

## Nested modules — optional dynamic kernelization (LANDED)

A module may contain modules under its **`Modules/`** container:

```
Core/Health/
  dsx.json                      ← domain-parent: contract only, no native weight
  Modules/
    Store/dsx.json              ← the shared seam IS a module (siblings depend on it)
    HeartRate/dsx.json          ← "dependencies": ["healthstore"]
    ECG/dsx.json                ← own entitlements/pods/usage strings — a compliance boundary
```

The laws:

1. **A child is a module, entirely** — own manifest, scheme (its LOCAL identity
   segment — the chain derives, next chapter), code, deps, permissions, config,
   tests, facets, twins.
2. **Only the container recurses.** Discovery opens `Modules/` past a package
   leaf and nothing else, so target source dirs are never misread as packages.
3. **Containment is dependency; exclusion cascades.** Parent excluded → the
   subtree drops (cascade WINS over a dependency rescue, loudly). A child is
   excludable alone by name or by tier-rooted path (`"ECG"`,
   `"Core/Health/Modules/ECG"`, `"Core/Health/*"` for the subtree) — the one
   exclusion plane, unchanged.
4. **Nearest manifest owns the file.** A parent's file walks subtract its
   container, at every depth.
5. **Two legal parent shapes.** *Feature-parent* (the parent's code IS a
   feature; Watch) and *domain-parent* (contract-only; Health). Rule of thumb:
   **if excluding every child should leave nothing behind, the parent must own
   nothing native.**
6. **Childhood is earned.** A piece becomes a child only when it has an
   independent removal story — its own permission, dependency, or compliance
   boundary (cf. permission_handler's per-permission gates; Play Feature
   Delivery's per-module conditions). Otherwise it's just files.

## Derived identity — the dotted chain (LANDED)

A module's identity is its **chain**: the `.`-joined local segments from the
module tree. A manifest declares ONLY its local segment (`"scheme": "health"`);
the full chain (`watch.health`) derives from `Modules/` nesting — organizational
folders (`Core/Extensions/…`) contribute nothing, so a module can move and its
chain re-derives. `DSXGraph.derive_chains!` computes it; nothing hand-writes it.
The chain is BOTH the API face (`dsx.module.watch.health.heartRate({…})` on
every surface) and the wire scheme token (`watch.health://heartRate`).

**Grammar (abort tier, `DSXGraph.chain_errors`):** a segment is
`[a-z][a-z0-9_]*` (underscore, never hyphen — a segment is a JS property name);
chains cap at four segments; a chain names exactly one module.

**Resolution is the FOLD, at each runtime's ONE dispatch funnel** (Swift
`ChainResolver` + `Context._call/_dispatch` + the `handle(url:)` wire · Kotlin
twin · TS `bus.ts` · corpus `OpenSource/Conformance/chains/`): alias-normalize
the arriving head to its primary chain, then fold action segments into the
chain while the identity set (registered chains ∪ build-excluded chains — the
honest universe, so an excluded child attributes correctly instead of becoming
a phantom action on its parent) knows the deeper name; the remainder is the
action path. Never dot-counting, never a first-dot split.

**The bidirectional ban makes dots provably unambiguous** (abort tier): a child
segment may not equal a parent action/group first-segment or a reserved member
— and no action/group may be a reserved member either. `intelligence.rag.add`
can only ever mean the `rag` GROUP, because a child named `rag` could not have
built.

**The reserved nine — CLOSED and FROZEN:** `on · available · excluded · state ·
context · object · delegate · dsx · then`. These are the module proxy's members
(`.on(kind, handler)` events · `.available`/`.excluded` build facts ·
`.context.<var>` declared vars — `.state` routes to the same plane, kept as the
transitional alias of the pre-rename spelling · `.object("…")`/`.delegate` ·
`.dsx` the bus escape hatch · `then` held inert so `await` and JSON can never
half-call a proxy). They are REAL members on the typed proxies,
and real members shadow dynamic lookup (SE-0195) — a tenth word could silently
steal a module's action name, so growth is a major-version event, never a
patch. There are exactly TWO reserved planes and they never mix: the `dsx`
handle's own verbs (`dsx.log`, `dsx.error`, the reserved `dsx` bus scheme) and
the module proxy's member set above — a module segment may collide with
neither. Three ADJACENT vocabularies carry reservation semantics too, gated at
build (`DSXGraph`) but — unlike the nine — BUILD vocabulary rather than frozen
API (they were never legal, so banning or later growing them can break no
shipped module): segments `dsx · route · self` (kernel/markup-claimed), the
call-plane verbs `post · invoke` never as action/group names (the Kotlin
fire-and-forget/awaitable leaves on every ModuleAction), and the typed leaf
accessors `bool · int · double · string · list · strings · exists · raw · set ·
on` never as declared context/state var names (`.context.exists` must always
mean the read).

**Aliases are the legacy plane's routing data**: `"aliases": ["watchhealth"]`
keeps every shipped spelling (flat schemes, hyphenated v3 verbs like
`get-uuid`) routing to the chain. Head-position only, legacy grammar allowed,
never the modern dot face. A multi-claim alias (`registerpush` — Firebase and
OneSignal both honor the v3 verb) is legal at tree level and an error only when
two SHIPPING claimants collide (`DSXGraph.alias_conflicts`, enforced where the
build knows the shipping set).

**Debts the gates flushed out (paid, with aliases):** schemes `get-uuid`→`uuid`,
`user-disable-tracking`→`apptracking`, `state`→`global` (the store module now
matches the `global.*` namespace it fronts); actions `watch.state`→`update`,
plus the reserved-colliding action renames in Biometric/Bluetooth/Clerk/
Keyboard/ScreenBrightness (each legacy wire spelling kept as a code-only NAMED
action — `dsx.action("available")` etc. — deliberately absent from the manifest,
which is the modern face; NOT a catch-all pre-filter, so the module's
unknown_action behavior is untouched).

## Build-visibility — the DSX API answers "what was excluded?" (LANDED)

The registry generator emits the honest twin of the presence list:

- **`DespiaPackages.json`** (unchanged shape) → `despia.packages`,
  `despia.hasPackage(x)`, `despia.package(x)`.
- **`DespiaExcluded.json`** (new, same bundle, same pre-sign phase) →
  `despia.excluded` (`[{ name, scheme?, reason: "excluded"|"cascade" }]`) and
  `despia.wasExcluded(x)` — 1:1 in the DSXWebView page runtime.

Both derive from the SAME discovery+exclusion+cascade+rescue computation that
decides what compiles ("make coarse availability queries authoritative or
don't ship them" — the SplitInstallManager lesson, not the
isPluginAvailable one). That computation is ONE function —
`DSXGraph.resolve_disabled` — and every exclusion consumer calls it:
prepare_modules, prepare_config, prepare_modules_android,
generate_package_registry, signing_targets, fetch_weights, build_frameworks
(unit-gated by `scripts/dsx_graph_test.rb`). Its precedence laws: cascade
wins over rescue; a rescued ancestor revives its subtree; **a dead requirer
rescues nothing** (a dropped module's transitive requirement never revives an
explicitly-excluded one).

## The unification law — one principle, three languages (BINDING for the fan-in)

The facet system is ONE kernel principle that behaves identically on iOS,
Android, and — to the extent a facet exists there — Web. Write once, ship on
every deployment platform; the implementation language is the only permitted
difference. Concretely:

- **One grammar.** `<lane>/<facet-word>/` is the only residence shape
  (`swift/message/` · `kotlin/message/` · `web/message/` — lane folders renamed
  per desktop-platforms.md Q5 now that each lane spans multiple OSes; `ios/`/
  `android/` stay accepted legacy aliases): lane names are
  each build lane's OWN name, facet words come from the registry, and every
  lane runs the same sentence — compile each enabled module's
  `<platform>/<word>/` into every target bound to `<word>`, exclusion/cascade/
  rescue applying file-by-file through the one resolver. No lane knows a word.
- **One contract.** A single `provides`/`reach` line in the one dsx.json
  covers every platform; each platform generates its role capability tables
  from the SAME manifest bytes (the same-bytes law, extended cross-platform).
- **One markup corpus.** DSX is facet-portable by the unified-codebase law —
  rung 1 of the ladder ships everywhere with zero native code; a
  facet-tailored screen is a component choice, never new folder semantics.
  `Components/` therefore NEVER holds platform-forked markup (lint-enforced):
  a `.dsx` component compiles into all three registries by construction, and a
  platform-SPECIFIC component is a NATIVE class registered under the same tag
  name — one tag, one owner per platform build (a native class reserves its
  tag, so a same-named `.dsx` fails the build; a platform with neither answers
  by Article 7 fail-open: the unknown tag renders nothing, gracefully).
  Authoring recipe for the custom-coded (Swift/Kotlin/TS-twins) component
  primitive: `OpenSource/Skills/native-components.md` — contract-first
  (`dsx.json` + a `Conformance/elements/` fixture), the `<video>` exemplar.
- **The ladder IS the API.** markup → `reach` relay → native residence.
  Only rung 3 is per-platform, and there Swift/Kotlin/TS twins under the same
  folder grammar are the whole difference (divergences tracked in `.kt`
  headers + the android-status roll-up, as everywhere).
- **Absence is load-bearing.** A facet a platform doesn't realize (no
  iMessage on web, no Clip on Android) keeps the identical grammar and
  registry and answers the graceful typed envelope
  (`unsupported_platform` / `unavailable`) — never an authoring-time fork.
- **Corpus-gated like everything else.** The resolution ladder + routing
  semantics land fixtures-first (`OpenSource/Conformance/facets/`) on all
  three implementations before any platform ships them.

## What landed, what's staged

| Piece | Status |
|---|---|
| Facet registry (`facet` bindings, role words, warn-gated vocabulary from ALL manifests) | **landed** |
| `provides`/`reach` grammar + prepare-time validation (`false` = deny on reach; `provides` is always a list) | **landed** |
| `reach` feeding the compiled node tables (explicit `false` = deny) | **landed** |
| RETIRED internal grammar staying dead — `relay` key, `reach: true` shorthand, `manifest.json` filename, off-facet native code (Swift/Kotlin/Java) — prepare aborts + check_module_rules errors; page-facing legacy (`window.despia`, old schemes) explicitly KEPT | **landed** |
| Nested-module discovery, cascade, ownership subtraction, registry parity | **landed** |
| Symmetric PLATFORM folders — `ios/` beside `android/`/`web/`, **no default platform**: `ios/` is THE home for a module's (and a native component's) Swift | **landed** |
| ONE disabled-set resolver (`DSXGraph.resolve_disabled`) across all seven consumer scripts, unit-gated | **landed** |
| `DespiaExcluded.json` + `despia.excluded`/`wasExcluded` (legacy surface + the modern `window.dsx` mirror) | **landed** (Swift side compile-pending, mirrors `packagesJSON`) |
| Android runtime readers for `DespiaPackages.json`/`DespiaExcluded.json` (VirtualBridge assets) | **landed** — and the Android-side GENERATOR now emits both assets (`prepare_modules_android.rb` §7c, the `generate_package_registry.rb` twin: same shape + reason vocabulary, byte-verified; committed into `HostAndroid/src/main/assets/`) |
| Runtime resolution ladder (local → reach → typed `unavailable`) | **landed** on TWO kernels, corpus-first: `OpenSource/Conformance/facets/facets.json` (28 cases + the frozen-code and totality sweeps) runs on TS (`packages/kernel/test/facets-conformance.test.ts`) and Kotlin (`:core FacetsConformanceTest`), each driving the pure ladder AND its own live dispatch funnel. **Swift is the declared gap** — no `Facets.swift` twin and no Swift runner yet; the same position `chains/` held before its record-lane runner landed (`Conformance/facets/README.md` names it). Two smaller declared gaps ride the Kotlin side: no client-link twin (`FacetFacts.linked` is always false — A0-SWEEP L-10), and a remote-only chain must be depth-1 until the identity FOLD is widened to capability-table chains (the generated client-link table has the same edge today — corpus README §Scope) |
| Facet **DECLARATION** fan-in (a module registers a word as a declaration NAMESPACE via the object-form `facet` binding — `{ word, declarations: { key, fields, emit, embed } }`; any module declares rows under the generic `facets` block; `DSXGraph.facet_declaration_*` validates abort-tier — stale target actions, unregistered words, identity shadowing — and both preparers emit each word's ENABLED aggregate into the OWNER's platform facets as `<Emit>.generated.swift/.kt`, with the FULL aggregate available to `embed` templates via `__DSX_FACET_ROWS_ALL__`; owner EXCLUDED ⇒ word stays registered, declarations stay valid, the generated files are deleted; owner DELETED ⇒ declarations abort) | **landed** — first consumer: Core/Legacy (`proposals/legacy-package.md`); unit-gated in `dsx_graph_test.rb` |
| Facet FOLDER fan-in (`swift/watch/` sources → registered targets) + per-facet codegen | staged (P1 of `proposals/watch-capabilities.md`). SCOPED, with the tree surveyed — it is **four** pieces, not one: (1) a per-LANE word→destination binding (Swift: an `extensionTargets[].facet` or the host binding; Kotlin: a gradle module; Web: `prepare_server`) — note a word may legitimately have NO destination in a lane, so `Core/Server`'s `server` lives only in `web/server/`; (2) the Swift fan-in, which is pbxproj work — drop `swift/<word>/` from the Runtime synchronized group's membership exceptions AND add it to the bound target's compile phase (`apply_source_exclusions` + `ensure_ext_sources`), with `--check`/idempotence paths; (3) the Kotlin fan-in, which subsumes a MIGRATION: the two shipping Wear residences are `Core/Extensions/Watch/Modules/{Face,Health}/wear/kotlin/` — facet-FIRST, under an unregistered word, wired by hand-written `java.srcDir` lines in `rewrite_wear_gradle` — and must become `kotlin/watch/` before a generic walk can replace those lines (`kotlin/{desktop,windows,linux}` in `prepare_modules_android.rb` is the working precedent for the walk); (4) deleting `facet_residence.rb`'s transitional unsplit-lane clause together with its `facet_residence_test.rb` case. Grep-verified state: **zero** `swift/<subfolder>/` exist anywhere, so the Swift lane is entirely unsplit and the transitional clause must NOT be deleted before (2) and (3) land — deleting it early would order the next module to split a lane nothing routes |
| Component-scope platform folders (`Components/<Name>/{ios,android,web}/` code twins beside the shared contract — `Skills/native-components.md`) | staged with the folder fan-in (markup lint already scoped: it bans only `.dsx` under platform folders, never code) |
| Root→`ios/` MIGRATION of the whole tree (250 files: every module's root Swift + every component-home `<Name>.swift` moved into its owning folder's `ios/`; generated registries proven byte-identical) — native code outside its OWNING platform facet folder is now a `check_module_rules` ERROR in EVERY tier (this repo predates any per-app tree, so all trees are born canonical — no grandfather window exists); the legacy spelling is DEAD | **landed** |
| `provides`↔folder presence enforcement (both directions) | **landed** — `check_module_rules` rule 19 (`scripts/facet_residence.rb`, unit-gated by `facet_residence_test.rb`). A `provides` naming a REGISTERED facet word needs a residence (`<lane>/<facet>/`, or an `extensionTargets` entry binding it), and a `<lane>/<facet>/` folder must be claimed by some action's `provides`. Zero-false-positive by construction: an UNREGISTERED word is invisible to both directions (prepare's grammar gate already warns on it), so excluding or deleting a facet owner can never turn the rule red; a module with no `actions` has no declaration site and is exempt from the folder⇒declaration direction. ONE transitional clause remains, to be deleted WITH the folder fan-in: an UNSPLIT lane (sources at the lane root, no facet subfolder) serves every facet the module declares — the root→`swift/app/` alias, so the ceremony arrives with the migration rather than ahead of it |

## Design provenance

Cross-framework research (Flutter federated plugins & `platforms:` maps, Expo
Modules autolinking + config-plugin regeneration, KMP expect/actual, Capacitor
typed unavailability codes, Play Feature Delivery conditions, App Clip targets
+ On-Demand Resources) informed four rules this system follows: absence must
be load-bearing (no compiled-in stubs); regeneration-from-manifests beats
merge-then-subtract for compliance stripping; availability queries must derive
from the same source that gates compilation; and failures land at the earliest
knowable tier — generation-time when manifest-knowable, typed runtime values
only for genuinely dynamic absence.
