# Router conformance — boot source, the root plan, resolution, popTo matching + the presentation machine

Four corpora pin the router's cross-runtime rules: `root-plan.json` (the
ordered root plan owning the boot, below), `resolve.json` (the unified route-table
grammar, below), `popto.json` (the multi-pop matching rule, below) and `present.json` (the
state-backed presentation machine: `as`/`touch` normalization, the dismissal topology, AND the
attribute contract — `attrs` ride the entry verbatim, and the `update` verb merges attrs into
the deepest-last match by tag/mode (top when untargeted; unmatched target = no-op) — its
`_note` is the contract). Executors for `present.json`:
- Kotlin: `Engine/Android :core RouterTest.presentMachineMatchesTheSharedConformanceCorpus`
  drives a real Router (presentModal/dismissModal) end-to-end.
- TS: `OpenSource/Web/packages/dom/test/present.test.ts` runs the SAME file over the web
  runtime's `PresentLedger` (the pure half of FrameRouter's presentation planes).
- Swift: `Engine/iOS/Router.swift` presentModal/removeModal is the reference (compile-pending).

## The boot rule — RETIRED

`boot.json` and the two-arm `bootsToEntryFallback` predicate are GONE on every lane —
replaced by the root plan below (`entry.surfaces`, root-plan.md). The web-optional
guarantee the second arm existed for is now structural: the plan mounts the app's own
candidates directly, so a pure-native app boots its native entry with no origin and no
predicate. The `legacyOriginSource` seam and `hasWebOrigin` survive as origin
introspection (boot_seam_guards_test.rb still pins the Dom fills).

## The root plan (`root-plan.json`) — the ordered fold that supersedes the boot rule

`App.json entry.surfaces` declares an ORDERED candidate list; `Router.boot()` folds over it
first-ready (`architecture/proposals/root-plan.md`):

```
for each candidate (array order = priority):
  mount as frame-0 content (config = component attributes, verbatim)
  race: frame settle (screen.ready)  ⊻  dsx.error with origin "root"  ⊻  timeoutMs
  ready  → fire root.ready — the plan is DONE for the process lifetime
  failed → fire root.failed — ALWAYS advance (there is no onFailure key)
exhausted → fire root.exhausted + the kernel boot diagnostic (not a component)
```

Normalization (shorthand, `ROOT_SETTLE_TIMEOUT_MS = 15000`, id derivation `view` /
`view#k`), failure attribution (`root.timeout` · `root.component_missing` · the
origin-"root" rule), the stale-token drop — a settle or error carrying an `attempt` is
delivered ONLY while that attempt is live — and the after-ready stability law are all
pinned by the cases — the file's `_note` is the contract, including the deterministic
virtual-clock simulation every runner drives.

Executors (all three drive the REAL extracted engine through its Host seam on the
corpus' virtual clock; the production wiring is pinned by per-runtime boot tests):
- TS: `OpenSource/Web/packages/dom/test/router-conformance.test.ts` (engine) — per-PR,
  web-kernel lane. The bootDsx WIRING needs a real DOM, so it is not in that lane:
  `packages/dom/oracle/boot-integration-browser.ts` (`npm run browser:boot`, Chromium)
  is the executing copy. `packages/dom/test/boot-integration.test.ts` holds the same
  four cases and reports four SKIPS under `node --test` — it proves nothing on its own.
- Kotlin: `Engine/Android :core RootPlanConformanceTest` (engine) + RouterTest's
  real-boot advance/settle/winner case, the frame-bound settle trio (a zombie frame's
  settle is dropped; a frameless and an unmapped report still settle the live attempt)
  and the `registered` seam cases (wiring).
- Swift: `RootPlanConformance` in `Engine/iOS/ConformanceHosts.swift` is the REFERENCE
  (RecordMain, conformance-record lane).

`expect.winnerView` pins the follow-on route rule: a routes.json row with no explicit
`view` renders the BOOT WINNER (the candidate that settled), replacing the deleted
`defaultView` constant.

## The resolution rule (`resolve.json`)

`resolve.json` pins the UNIFIED route-table grammar (/web/04-routing.md — ONE routes.json maps
URLs ↔ components on every renderer): given a table and a concrete path, which entry matches
(first match wins, DSXPathMatch grammar, PURE `{ path, redirect }` entries resolve through),
what the mounted screen receives (`vars` = matched params + parsed query MERGED WITH QUERY
WINNING — the web `navigatePath` rule), and the declared `meta.title` (web sets document.title;
native seeds the system bar with it when the component's own claim is unknown). A
`component: null` expectation = no component route matched — each runtime's degrade is its own
documented business (web warns + no-ops; native falls to the configured web fallback and
derives a bar title for PUSHED web frames — native-only behavior pinned by RouterTest units,
not here). Case shape: `{ name, table, path, expect: { component, vars, title } }`.

Executors:
- Kotlin: `Engine/Android :core RouterTest.resolveMatchesTheSharedConformanceCorpus` —
  END-TO-END: seeds the table, pushes the path through a real Router, asserts the resulting
  frame (component / native / route flags, vars) and the push-time-seeded `nav.chrome` bar.
- TS: `OpenSource/Web/packages/dom/test/router.test.ts` — drives the REAL
  `FrameRouter.resolveUrl` (guards/requires/redirects included) plus navigatePath's own URL
  decomposition and vars merge.
- Swift: `Engine/iOS/Router.swift` `resolved()`/`materialize()` is the reference
  (compile-pending — rides Codemagic).

## The popTo matching rule (`popto.json`)

`popto.json` pins the ONE cross-runtime rule behind `dsx.module.route.popTo({ path })`: given the
back-stack's concrete frame paths (root → top) and a target, which frame does the verb pop back
to? The rule — shared verbatim by all three runtimes:

- a frame matches when its path equals the target **with the query string stripped from BOTH
  sides** (`substringBefore('?')` / `prefix(while: != "?")` / `split("?")[0]` — same operation).
  Native frames store the full pushed path (query included); the web runtime stores frame paths
  query-stripped — stripping both sides is the only rule every renderer can implement identically.
- the **DEEPEST** match wins (the nearest previous instance, walking top-down);
- a `null` path never matches (web pathless frames; native has no null paths — its module-pushed
  frames carry synthetic `/__native/<id>` paths, which no real target names);
- an empty target — or one that strips to empty (`"?x=1"`) — never matches;
- never a route-table pattern: concrete string comparison only.

Case shape: `{ name, paths: [string|null…], target, expect }` — `expect` is the matching index
into `paths`, or `-1` for "no match" (the verb then no-ops; a match at the TOP index is also a
runtime no-op, but the FUNCTION still reports the index — truncation guards live in the runtimes).

Executors:
- TS: `OpenSource/Web/packages/dom/test/router.test.ts` (per-PR, web-kernel lane) — runs
  `deepestPathMatch` straight over the cases.
- Kotlin: `Engine/Android :core RouterTest.popToMatchesTheSharedConformanceCorpus` (per-PR,
  android-kernel lane) — drives a real Router (boot + push per path) and asserts the resulting
  truncation depth, so the corpus exercises the verb end-to-end, not just the comparator.
- Swift: `Engine/iOS/Router.swift deepestMatch` is the REFERENCE (compile-pending — rides
  Codemagic; the record-mode lane authoritates divergences).
