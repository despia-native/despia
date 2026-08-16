# The Root Plan — ACCEPTED v1, LANDED (2026-07-26)

> The ordered, app-declared root surface plan that made the kernel renderer-neutral in
> code, not just in the constitution. Status: **ACCEPTED and LANDED on all three
> runtimes** in one program (fixtures first). Corpus: `OpenSource/Conformance/router/
> root-plan.json` — its `_note` is the normative contract; this document is the law,
> the decisions, and the map.

## The problem this dissolved

Articles 1/9 promised "the kernel names nobody; DSXWebView and DSXView are equal
consumers" — but root selection was a hard-coded two-arm rule (`bootsToEntryFallback`)
over one scalar (`entry.fallback.view`), floored by a kernel literal `"DSXWebView"`
("the irreducible web floor", EngineConfig `defaults.view`). No ordered fallback, no
timeout, no observability — and a third renderer needed kernel edits (the readiness
`view == "DSXWebView" ? "web" : "native"` ternaries, Dom's self-pushed failure screen,
the `"DSXNativeUnavailable"` literal, both Android twins).

## The law

1. **The plan owns the root; the table owns navigation.** `App.json entry.surfaces`
   is a non-empty ordered candidate list; `Router.boot()` folds it first-ready inside
   the kernel-owned RouterHost. Candidates mount as ordinary frame-0 content —
   renderers never own the window.
2. **Any component in the build is a legal candidate.** Eligibility is EXISTENCE
   (markup `.dsx` + native Stack components); the build validator
   (`scripts/root_plan_schema.rb`, V1–V9) aborts unknown views with a closest-match
   fix-it. Zero new dsx.json grammar (`exposes.root` stays reserved for an optional
   curated picker).
3. **No kinds, no floors.** Everything is a native component; what differs is what it
   SERVES, declared as capability: web-surface owners register their tags
   (`DSXScreenReadiness.webSurfaceTags` / Kotlin twin — Dom inserts `"DSXWebView"` in
   setup) and hosts derive `surface` by membership. The unavailable screen is a
   CLAIMED role (`route.nativeUnavailable`, Routing claims Foundation's screen).
   `defaults.view` is deleted; the templates carry the product defaults
   (starter `["DSXStartup"]`, web `["DSXWebView","DSXWebUnavailable"]`).
4. **Candidate grammar** — `"View"` shorthand or `{ view, config?, timeoutMs?, id? }`:
   `config` rides the mount VERBATIM as component attributes (moustache resolves in
   the attribute plane); `timeoutMs` defaults to `ROOT_SETTLE_TIMEOUT_MS = 15000`
   (identical on every runtime, corpus-pinned) and is capped at Int32 — Android
   carries the deadline as an `Int`, so a larger value could only be truncated there
   while the other two honored it, and 24 days is not a boot timeout anyone means;
   derived ids are the view name, `view#k` on repeats, explicit ids verbatim. `view`
   and `id` are `clean`ed (trimmed; blank or non-string ⇒ absent) identically by all
   three runtimes AND by the validator — an unusable `id` aborts the build rather than
   normalizing one way at prepare and another at runtime. There is deliberately **no
   onFailure/policy key** (failure ALWAYS advances), no `strategy`, no `when`, no
   presets — each rejected on the record (the decisions ledger below).
5. **Ready / failed / done.** Ready = the existing frame-settle (`screen.ready` for
   frame 0, read as STATE by the Router's observe sink — Article 1, no bus hook).
   Because that state is LEVEL-triggered, both natives retire it (`screen.ready =
   false`) as they mount a candidate: a `true` left standing by the candidate that
   just failed would otherwise crown its successor before it rendered a pixel, with
   the successor's own `timeoutMs` never applying. Inside the fold every terminal
   path closes its attempt token BEFORE emitting, so a hook on `root.failed` cannot
   re-enter and settle the candidate that just failed; the deadline carries its
   attempt index, and a mount that synchronously advances the fold keeps ownership of
   its own timer. Readiness is FRAME-BOUND at the production call sites too: each
   report names its frame (`global.screen.frame`, published by the coordinator BEFORE
   the level flips — screen-lifecycle.md), each runtime maps the frames its plan
   mounted back to the attempt that mounted them, and `settle(attemptIndex:)` drops a
   report whose attempt is no longer live. So a ZOMBIE frame — a released screen's
   queued render callback, a re-mounted id — cannot crown the candidate that happens
   to be live when it lands. A frameless report (the web relay names no frame) or a
   frame outside the plan (a cold deep-link frame, whose settling still proves the app
   interactive) is UNBOUND, not stale, and settles the live attempt as before.
   **A REFUSED settle retires the level with it.** Identity and level are separate state
   keys, and a native sink observing them is level-triggered: dropping a stale report but
   leaving its `screen.ready = true` standing is only half a fix, because the NEXT
   report's `screen.frame` write pairs a fresh identity with the corpse's level and
   crowns a candidate that has not rendered — on a `loading` report, no less. No write
   ORDER escapes this (frame-first pairs new identity with stale level; level-first pairs
   new level with stale identity), and neither native has a batch primitive to make the
   triple atomic, so both retire `screen.ready` when the fold refuses a BOUND-but-stale
   frame. Only bound-and-stale: an unmapped report already settled, and an exhausted plan
   (`Fold.active == false`) must never fight the level. The web is edge-triggered off the
   `screen.ready` event and needs none of this; `Fold.active` exists on all three anyway
   so the folds keep one surface. On the
   web the same law needed the frame ALLOCATOR to become per-renderer rather than
   per-router: one FrameRouter per candidate handed every candidate's root the id 1,
   so a dead candidate's queued `rendered(1)` landed on the LIVE candidate's record.
   Failed = a `dsx.error` with `origin: "root"` while the attempt is live (forwarded
   through the reactive `global.dsx.lastError`/`errorCount` keys), or the deadline
   (`root.timeout` through the same error plane). The kernel publishes `root.attempt`
   (identity) before `root.live` (level) at every mount; a surface that tags origin
   "root" STAMPS the failure with `data.attempt` read at emission — Dom does — so an
   error whose delivery is deferred past an advance (a re-entrant publication queued
   until after the successor mounted) resolves to the attempt that actually died and
   is dropped as stale instead of failing the successor with its predecessor's code.
   An unstamped root error stays unbound and lands on the live attempt, as ever. While an attempt is live its
   frame's bounded readiness deadline is SUSPENDED (`suppressedDeadlineFrame`) — the
   candidate's own `timeoutMs` is the bounded fail-open. After `root.ready` the plan
   is DONE for the process lifetime: no silent root swap — recovery is module/route-
   owned (Dom's post-ready claim + `DSXWebUnavailable.dsx`). D4's LAW is behavioral —
   Dom never navigates the framework by name at boot — while the `.dsx` FILE stays in
   Foundation's System screens: Foundation is the scheme-less GLOBAL component
   namespace, and root candidates resolve globally (a schemed module's markup
   registers under its scheme — moving the screen into Dom made the tag
   unresolvable as a plan candidate; caught by the simulator smoke).
6. **Exhaustion is honest.** `root.exhausted` fires with the attempt ledger and the
   kernel boot diagnostic renders — kernel-owned pixels, deliberately NOT a component
   (test channels: the full ledger; production: neutral + Retry → `retryRootPlan()`).
7. **Events** — `root.ready` / `root.failed` / `root.exhausted`, lowercase dotted,
   same names and payload shapes on every runtime (Article 8): id · view · index ·
   target · elapsedMs (+ the error envelope on failures, the ledger on exhaustion).
8. **Route rows with no `view` follow the BOOT WINNER** (the candidate that settled),
   never a constant.
9. **`entry.fallback` is retired grammar** (rule-12 family — build abort with the
   fix-it plan). V4 was unshipped: deleted, not translated. v3 `scheme://` compat is
   untouched (the Legacy package). `Entry.fallback` survives internally as the
   DERIVED alias of `surfaces[0]` for floor/no-match consumers; an empty plan derives
   an empty view — the kernel names no surface in either direction.
9b. **The ten-year claim, scoped honestly**: any new component on an EXISTING host
    surface kind becomes a root candidate with zero kernel edits (the ProofShell
    gate). A genuinely new HOST kind (a new OS surface) still needs its mount/host
    adapter — host work, never selection-architecture work. Pre-winner route
    arrivals (deep links/pushes during an attempt) resolve against the live
    candidate frame exactly like any route write; multi-scene/Activity-recreation
    re-runs the plan per boot — both are documented edges, corpus rows welcome.
10. **Rule 18 keeps it true forever** (`check_module_rules.rb`): no ORCHESTRATION
    source (iOS Engine, Android core + platform + the desktop host/renderer/capability
    files, web kernel + dom boot/router/root-plan/mount)
    may contain a string literal naming a registered component tag — self-maintaining
    (the tag universe is discovered, so `Custom/ProofSurface`'s never-heard-of
    `ProofShell` extends the ban automatically: the ten-year proof, mutation-proven).
    Rule 18b pins `defaults.view` dead. Element-REGISTRY layers (Android :render and
    :glance, the web element waves, the desktop element/studio/media waves and
    DesktopRemoteDsxView's anti-shadowing allowlist) are exempt by construction —
    registering an implementation for a tag IS the data mechanism the rule points to.
    That exemption is expressed ONLY by what is not globbed, so a module mixing both
    roles (`:desktop`) is enumerated file by file, exactly like the web `dom` package.
    Closing that scope cost `:desktop` its two selection-by-name sites: the five-tag
    `desktopNativeUnavailableTags` set and the `"DSXView"` render branch are now ONE
    registered capability table (`DesktopCapabilities` +
    `resources/dsx/DesktopCapabilities.tsv`, header-pinned and validated like the
    package catalog) — a tag DECLARES the native capability it needs, code BINDS
    capabilities to implementations, and neither spells the other's name.

## The engine (one fold, three twins)

`RootPlan.Fold` + a `Host` seam (mount · now · setTimer · fire · registered ·
diagnostic) — Swift `Engine/iOS/RootPlan.swift` (REFERENCE) · Kotlin
`Engine/Android core RootPlan.kt` · TS `Web/packages/dom/src/root-plan.ts`. Production
wires real frames/bus/daemon timers; the conformance runners wire the corpus `_note`'s
deterministic virtual clock. Runners: TS `packages/dom/test/router-conformance.test.ts`
(per-PR, also in the `conformance` keystone script) · Kotlin `RootPlanConformanceTest`
(`:core`, gradle) · Swift `RootPlanConformance` (`ConformanceHosts.swift`, RecordMain,
conformance-record lane). `boot.json` and `bootsToEntryFallback` are RETIRED on every
lane; the `legacyOriginSource` seam + `hasWebOrigin` survive as origin introspection
(boot_seam_guards still pins the Dom fills).

`registered` consults the REAL component registry on every runtime — iOS
`StackComponents.has`, web `registry.components`, and on Android the `:render` twin
`ComposeStackComponents.has` reaching `:core` through the `JSE.componentAvailable` seam
the host binds (`:core` compiles SDK-free and owns no component table, which is why the
Android production path shipped a `= true` stub and corpus F-10 was unreachable there).
That seam is TYPED ABSENCE: unbound means "no registry here" and fails OPEN, never "no
such component" — a runtime with no render layer must still boot its plan.
`Router.available()` (route `requires`) unions it with `JSE.moduleAvailable` to match
Swift's `isAvailable(name) || StackComponents.has(name)`; the `has()` BUILTIN stays
packages-only on both runtimes, which is why the union lives at the call site and never
in the seam.

## The decisions ledger (owner-ratified 2026-07-26 — do not re-litigate)

- **D1** Keep DSX grammar; reject the outside spec's machinery (npm-style exports,
  JSON Schema, `$ref`, renderer protocol/lifecycle API, kind enums, migration period).
- **D2** The web floor is deleted — product default moved to templates; never-boot-to-
  nothing became the diagnostic; the tier question (Dom Mandatory → excludable) is a
  SEPARATE, still-open product call now unblocked.
- **D3** No kind/surface field — capability registration + feature detection only.
- **D4** `DSXWebUnavailable.dsx` lives in Dom (ecosystem cohesion; leaves with it).
- **D5** Permissive eligibility; zero new manifest keys.
- **D6** ids derived; scalar shorthand legal.
- **D7** No legacy entry parsing (pre-ship: nothing to migrate).
- **D8** No failure-policy key — `stop` had no coherent use once conditions were out.
- **D9** Bus rules everywhere (`try? dsx.module.…`, `dsx.hook`, state observation).
- **Plan session**: view-less route rows follow the boot winner; implementation tree
  `despia-framework-pr79-rc`, branch `feat/root-plan`.

## Non-goals (rejected on the record)

Source fallback stays INSIDE surfaces via the content plane (bundled-floor.md's one
ladder — candidates are for SURFACES); no `strategy`/`when`/preset/override planes; no
JSON event-binding block (apps use `dsx.hook`); durability.md's candidate-solver
deferral stays honored (first-ready is a fold, not a solver).

## Companions

Corpus `Conformance/router/root-plan.json` + `router/README.md` · grammar/validator
`scripts/root_plan_schema.rb` (+ `_test.rb`) · rule 18 in `check_module_rules.rb` ·
the app manifest law `architecture/app-manifest.md` · the review/spec trail (owner
artifacts, 2026-07-26).
