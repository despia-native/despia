# Declared targets — a surface is a package, the scripts know zero names

**Status: v1 — FOUNDATION LANDED** (the `platform`/`embed` target grammar · the
`kind`-as-platform retirement · the one kernel BOM). Staged: the App module
absorbing the phone target's spec, the Android gradle-module declaration wave.
Companions: `../facet-contracts.md` (the facet registry this completes),
`tv-runtime.md` (the first all-new surface to land on this grammar).

## The problem — one boolean wearing a trench coat

The facet registry made surface *words* fully declared: `facet_registry` learns
`app · watch · activity · widget · legacy` from manifests and the scripts ship
knowing zero names. But the surface *targets* still weren't: synthesizing the
watch app hung off a literal in Ruby —

```ruby
watch    = spec['kind'].to_s == 'watch'     # the last surface name in a script
platform = watch ? :watchos : :ios
```

— with its blast radius spread over four sites (the SDK/settings branch, the
embed-phase names, the identity special-case, the deployment floor default) and
the kernel's per-surface render backends spelled in THREE hand-synced lists
(`RUNTIME_TIERS` in prepare_modules, `RUNTIME_TIER_FILES` in
check_module_rules, the codemagic heal step's `EXCLUDES`). Fine when watch was
the only second surface; the moment TV arrives, every `watch ?` becomes a
three-way branch and every list a fourth edit. `#if WATCH_ENABLED` relocated
into Ruby is illegal here — this was the same debt one layer down.

## The law

**A deployment surface is declared by the package that owns it. The build
scripts hold no surface vocabulary of their own: platform words validate
against the TOOLCHAIN's set, and everything else derives or is declared.**

```jsonc
// Core/Extensions/TV — the whole target, self-defined
"extensionTargets": [{
  "name": "TV",
  "platform": "tvos",            // ONE declared word — validated against xcodeproj's own set
  "productType": "application",
  "facet": "tv",                 // the surface word (facet-contracts.md, unchanged)
  "embed": false,                // a standalone sibling product — no host embed
  "sources": "TvApp",
  "runtime": ["tv", "logic"],    // kernel render tier + the UIKit-free logic pair
  "deploymentTarget": "17.0"
}]
```

### `platform` — the word is declared, the constants are the toolchain's

- Declared: one platform word per spec (`watchos`, `tvos`, …). Validated
  against **xcodeproj's own platform set** (the `LAST_KNOWN_<P>_SDK` constants
  — the gem's vocabulary, not ours); an unknown word aborts at prepare with
  the known set quoted (the fail-early tier).
- Derived: `SDKROOT`, `TARGETED_DEVICE_FAMILY`, and the
  `<P>_DEPLOYMENT_TARGET` key all come from
  `Xcodeproj::Project::ProjectHelper.common_build_settings` for the declared
  word — the manifest never spells `appletvos`, and neither does any script.
- Inherited: a spec with NO platform word builds off its HOST's settings —
  embedded things share their host's platform (the pre-existing documented
  behavior, now the *derivation* rather than the default). Only a hostless
  application must declare the word; there is no default platform, per the
  symmetric-tree law.
- A foreign-platform target must declare its own `deploymentTarget` (a host
  floor is meaningless across SDKs) — abort tier, manifest-knowable.

### `embed` — Apple's placement facts move into the manifest

- `embed: { "phase": "Embed Watch Content", "dst": "$(CONTENTS_FOLDER_PATH)/Watch" }`
  — an embedded APPLICATION product declares its copy phase (Watch, AppClip).
  Manifests already carry `WKCompanionAppBundleIdentifier` and friends; the
  phase name is the same kind of Apple constant and lives with them.
- `embed: false` — a standalone sibling product (TV): no host dependency, no
  copy phase, its own archive.
- absent — an app_extension rides the universal PlugIns phase (Apple's one
  extension mechanism — toolchain semantics, not a surface name). An
  APPLICATION product with no `embed` declaration aborts: placement is
  manifest-knowable, so silence is a typo, not a default.

### Identity templates — the watch special-case becomes grammar

`displayName` / `productName` accept the established `{{ app.name }}` template
(App.json `name`, the same source the old conditional read; an empty per-app
value falls back to the target default exactly as before). The Watch manifest
now DECLARES that its display + product share the app identity; the script
carries no `watch &&` conditional for it.

### `kind` — retired as a platform selector, kept as the scaffold picker

`kind` conflated two axes. The NSExtension-scaffold axis stays (it was always
open: an unknown kind + a manifest `nsExtension` is legal). The platform axis
is RETIRED grammar: `kind: "watch"` aborts at prepare and errors in
check_module_rules (rule 12's list), pointing here — the `relay`→`reach`
playbook, applied to targets.

## One kernel BOM — `DSXGraph::RUNTIME_TIERS`

The per-surface render-backend knowledge now lives ONCE, in the shared graph
library (beside `PLATFORM_FACETS`, the same "one vocabulary point" precedent):

- `DSXGraph::RUNTIME_TIERS` — tier word → engine files (the ladder; the only
  place a tier is spelled).
- `DSXGraph::KERNEL_NON_RUNTIME` — the kernel files that never compile into
  the phone Runtime target (the satellite backends derived from the tiers +
  the conformance hosts + the ApiBlock reference impl).

Consumers: prepare_modules (tier globs), check_module_rules (rule 8's
extension-safety file set — derived, no second list), the codemagic heal step
(EXCLUDES — requires the graph library instead of carrying a copy).
add_core_sources.rb stays a positive list by design (what Runtime must
compile); a satellite backend is simply never on it.

## What legitimately stays script-side — the two-line boundary

1. **The toolchain's platform set.** Validated against, never owned — the
   same relationship `productType` already has ("any symbol xcodeproj
   knows"). A module cannot manifest its way onto an SDK Apple didn't ship.
2. **The kernel's own BOM.** `RUNTIME_TIERS` describes the ENGINE's files; a
   new backend (StackTV.swift) is a kernel addition whose tier row lands in
   the same commit. The kernel describing its own render backends is
   self-description, not a surface name leaking into scripts.

Neither names a module or a surface the ecosystem defines — which is what the
registry law actually forbids.

## Migration ledger

| Piece | Status |
|---|---|
| `platform` word validated against the toolchain set; SDK trio derived via ProjectHelper | **landed** |
| `embed` declared (object / false / extension default); watch + clip name-branches deleted from `ensure_host_embeds` | **landed** |
| `displayName`/`productName` `{{ app.name }}` templates; the watch identity conditional deleted | **landed** |
| `kind:"watch"` retired (prepare abort + check_module_rules rule 12); Watch + AppClip manifests migrated | **landed** |
| `DSXGraph::RUNTIME_TIERS` / `KERNEL_NON_RUNTIME` — one BOM, three consumers rewired | **landed** |
| First all-new surface landing as pure data + one backend per lane (TV — `tv-runtime.md`) | **landed** (foundation) |
| `Mandatory/App` absorbing the phone target's spec (the host as the zeroth declared target) | staged |
| Android: gradle app modules (`:wear`, `:tv`) declared from manifests and stamped into settings by prepare_modules_android (today: hand-authored composite includes, the wear precedent) | staged — the "watch wave" |

## Design provenance

The facet registry's own rules, extended one layer down: regeneration from
manifests beats hand-wired branches; failures land at the earliest knowable
tier (unknown platform word / missing embed declaration abort at prepare);
absence stays load-bearing (an excluded surface module tears its target out —
the lockfile teardown, unchanged). Cross-framework: Expo config plugins
regenerate native projects from app.json the same way; Flutter's federated
`platforms:` maps declare per-platform realizations without the tool naming
any plugin.
