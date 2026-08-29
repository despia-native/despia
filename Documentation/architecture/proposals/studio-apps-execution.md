# Despia Apps execution — the agent playbook

> Companion to `studio-apps.md` (the law — read it first; this file assumes it). Same shape as
> `full-stack-execution.md`: the mental model, the landed substrate you must not rebuild, the
> workstreams with gates, and the environment memory that saves the next session an hour.
> Status: **PLANNED** (2026-08-28) — every T row below is OPEN; nothing here has landed.

## The mental model (internalize before touching anything)

An app is a registry package that declares contributions (`facets.apps` rows) into a closed
slot vocabulary and grants over a closed seam list. The Studio host compiles the app into a
per-app sub-registry, mounts it shadow-isolated through one facet component, and hands it a
`dsx` whose module funnel is a scoped table (`RunEnv.callModule` — the seam the server host
already uses). The store is the registry's apps shelf; approval is an Ed25519 signature over
`(coordinate, version, treeHash, grants)`; the kill switch is the denylist; the recursion story
is pinned-tree-vs-working-tree. **The kernel gains nothing** — the five-question record is
`studio-apps.md` §9. Every piece is a composition of shipped machinery; when you find yourself
writing something novel, stop and re-read the substrate table below.

## What is already landed (do not rebuild)

| Need | Shipped mechanism | Where |
|---|---|---|
| Distribution, pinning, verify | registry W1–W6: `despia add`, `dsx.lock.json` (commit SHA + tree hash), retag refusal, cache re-verify, `lockedModuleDirs` materializer | `packages/cli/src/registry*.ts`, `ClosedSource/RegistryRepo/` |
| Extension-point declarations | the facet fan-in word registration (object form) + `ownComponent` field kind | `architecture/facet-contracts.md`, `dsx_graph.rb`, live consumers `Core/Legacy` + `Core/Server/Modules/Import` |
| Scoped module reach | `RunEnv.callModule` (the overridable funnel) + the two shipped seam tables | `packages/kernel/src/runner.ts:97` + `:1413`, `packages/server/src/actions.ts#moduleTable`, `packages/cli/src/declared.ts#moduleTable` |
| Runtime compile + resolve | browser-safe `compileComponent` / `resolveComponent(registry, …)` | `packages/compiler/src/component.ts`, `resolve.ts` |
| Isolated mount | `mountFacet` + `isolation:"shadow"` + the `@despia-native/element` embed pattern + the unresolved-tag fallback children | `packages/dom/src/mount.ts:2470-2543`, `packages/element/src/index.ts` |
| Seam scanning | `viewSeamViolations` (the mcp-apps `ui` residence scan) | `packages/compiler` (see `mcp-apps.md` §10) |
| Signing + offline verify | the entitlement signer discipline (canonical bytes, Ed25519, majorVersion) | `sign_entitlement.rb`, `packages/cli/src/entitlement.ts` (read its header — the N-implementations lesson) |
| Contract evolution | `contract_diff.rb` (P5), the P1 envelope pattern | `ClosedSource/scripts/contract_diff.rb`, `dsx_graph.rb` |
| Automation substrate | `<server>` documents, webhooks/queues/workers, the spend plane, BYO deploy | `packages/server/`, `packages/cli/src/server-document.ts`, `Custom/Platform/web/server/platform.dsx` |
| Review governance prior art | deny-by-default profiles, the licence/URL-literal gate, the human-review doctrine | `select_release_profile.rb`, `ai_package_gate.rb`, `ClosedSource/Documentation/compliance/despia-initiated-review.md` |
| The one write door | `/edit/api/edit/<doc>` surgery splices + checkpoint/revert + the admission gate | `packages/cli/src/edit.ts` |

## Conformance decisions (fixtures first, runner wired in the same commit)

`OpenSource/Conformance/studio-apps/` — five files. `generate_conformance_index.rb` fails a
corpus run by nobody, so each lands WITH its runner:

| Fixture | Runners | Why |
|---|---|---|
| `manifest.json` | TS + ruby (shared fixtures, the `lint_conformance.rb` pattern) | two validators of one grammar (installed packages vs in-tree modules) — exactly where drift lives |
| `approval.json` | TS + ruby, day one | canonical bytes with N implementations and no shared corpus is the recorded entitlement lesson |
| `scope.json` (grants → seam verdicts) | single-runner TS | the plane has one runtime (the web Studio host) — the spend-precedent README |
| `slots.json` (the pure `resolveStudioApps(contributions, installed, approvals, denylist, studioApi) → mount table` fold: collision, denylist, skew, unapproved, disabled) | single-runner TS | same |
| `events.json` (payload shapes + delivery rules) | single-runner TS | same |

## Workstreams T1–T9

Dependency spine: **T1 → T2 → T3 → {T4, T6, T7} → T5 → T8 → T9** (T7 may start after T1; T8
converts per-app as soon as T3 lands). Standard gates on every T, unstated below:
`cd OpenSource/Web && npm test` · `ruby ClosedSource/scripts/lint_dsx.rb --strict` 0/0 ·
`ruby ClosedSource/scripts/check_gate_coverage.rb` 0 unwired · a STATUS.md row with the command.

### T1 — the grammar (word + envelope + twin validators + corpus)

Create `ClosedSource/DSX/Modules/Core/Apps/dsx.json` (scheme `apps`, shelf open, the `facet`
registration from the law §3.2 — the word `app` is taken by Mandatory/App; `apps` verified
collision-free 2026-08-28); `packages/cli/src/studio-apps/manifest.ts` (reader + validator);
corpus `manifest.json` + `packages/cli/test/studio-apps-manifest.test.ts` + ruby cases in
`ClosedSource/scripts/dsx_graph_test.rb`; the contract artifact
`OpenSource/Web/support/studio-api-v1.json` + its pin test. Remember the release-profile law: a
new module folder must be re-resolved into `Config/excluded.json`
(`select_release_profile.rb --profile production-minimal`) and the package catalog regenerated.
Gates: `node --test packages/cli/test/studio-apps-manifest.test.ts` ·
`ruby ClosedSource/scripts/dsx_graph_test.rb` · `ruby ClosedSource/scripts/prepare_modules.rb`
×2 idempotent · `ruby ClosedSource/scripts/generate_package_catalog.rb && ruby
ClosedSource/scripts/generate_package_catalog_test.rb`.
**DONE:** a fixture app manifest exercising every field validates identically under both
validators; every abort case (unknown slot/grant/event, `..` escape, grants⊄slot-legal)
mutation-proven.

### T2 — the runtime (scope + mount + isolation)

`packages/dom/src/mount.ts`: the `instantiate()` `env` option (`callModule` · `egress` ·
`ownerScheme` · budgets) threaded into `makeRunEnv` AND inherited through nested component
expansion (the ~2603 block — the inheritance hop is the whole containment story); the
src-attribute origin gate on app mounts. `packages/element/src/index.ts`: pass-through.
`packages/cli/src/studio-apps/scope.ts`: the seam table (law §5).
`packages/cli/src/studio-apps/registry.ts`: the sub-registry compiler (app `Components/` +
StudioKit + declared deps, byte-budgeted). `Core/Apps/web/`: the `StudioAppSurface` facet
component (shadow isolation, provenance strip, fallback children). `edit.ts`: `/edit/api/apps`
(the projection: lockfile via `lockedModuleDirs` + in-tree first-party rows + approvals +
grants + denylist → `resolveStudioApps`), `/edit/api/apps/storage/<scheme>`, and `app:<scheme>`
provenance on the surgery door. `packages/compiler`: the `studio` profile of
`viewSeamViolations`. Corpora `scope.json` · `slots.json` · `events.json` + runners; oracle
`packages/dom/oracle/studio-apps-browser.ts` (mount a fixture app; prove shadow isolation, one
granted round-trip, one refusal naming the missing grant, one refused image origin), wired into
the lane that runs `studio-surfaces-browser.ts`.
**DONE:** the fixture app edits a document through the surgery door with `app:<scheme>`
provenance visible in the agent-plane revert view; an ungranted seam and a hostile `src` both
refuse typed.

### T3 — slots become data + the installed-apps panel + `<override>` controls

`Editor.dsx`: the rail composes builtin rows + `/edit/api/apps` rows through ONE fold; the work
area gains the `StudioAppSurface` destination; `buildDsxEditor` gains `modules: [appsChunk]`
(the `modules` field exists in `edit.ts` and is `[]` today — the first module on the Studio
page, a named decision). `EditorInspector.dsx` / `EditorStyles.dsx` gain section slots;
EditorStyles renders the `<override>` typed-control section from the catalog's
`components.*.overrides` (the long-named gap, closed here). New `Components/EditorApps.dsx` —
the central panel: installed list, grants verbatim, enable/disable, uninstall with the
storage-retention prompt, update-with-grant-diff, dev-mode badge, denylist state, skew
refusals. The Editor's own `dsx.json` declares its ten destinations as `facets.apps` rows
(dogfood); the ten identities stay pinned by a new studio-surfaces-oracle assertion — the
census move, named and gated.
Gates: `check_editor_scale.rb` · `check_editor_dogfood.rb` · `check_editor_icons.rb` ·
`node packages/dom/oracle/studio-surfaces-browser.ts` (extended: the new panel + a mounted
fixture app + the ten-identity pin) · `packages/cli/test/edit.test.ts`.
**DONE:** zero literal slot-destination branching remains for app panes; the ten first-party
rows arrive through the same fold; a fixture app appears in the rail with no editor rebuild.

### T4 — install surfaces + CLI

Studio: browse/install inside EditorApps.dsx (index search via the W2 fold; install → grant
dialog → `/edit/api/apps/install` runs the `despia add` mechanics server-side, writes lockfile
+ `.despia/apps/grants.json`). Dashboard: the Packages popup grows the Apps shelf tab; the
detail dialog gains the Permissions block + approval badges (`dashboard-concept.md` §3.3). CLI:
`despia add` stays THE install verb (one verb, one meaning — registry Q6) with shelf-aware
grant printing + confirm; new read-only `despia app list|grants|verify` rows in `dsx.cli.dsx`
(the MCP face derives automatically).
Gates: `packages/cli/test/cli.test.ts` · the dashboard `dsx build` component count ·
`lint_dsx --strict`.
**DONE:** install→grant→mount round-trips headless (CLI) and in both surfaces; a
grant-widening update forces re-consent on both paths.

### T4.5 — the headless faces (owner-directed 2026-08-28, LANDED)

An interface is ONE consumer (studio-apps.md §9.1). Tool rows carry `run="Doc.dsx#action"`
(corpus `manifest.json`, both validators; `missing_run`/`bad_run`);
`packages/cli/src/studio-apps/headless.ts` runs the action on the kernel runner under the
app-plane budgets, the seam table's CLI twin (corpus-gated beside the web funnel in
`studio-apps-scope.test.ts` — two funnels, one `scope.json`), and the edit mount invoked
in-process as the doors (same containment, same provenance ledger, storage writes flushed
before exit). `despia app tools|run` is the CLI face; the MCP server projects every
installed app's tools as `app_<scheme>_<action>` beside `despia_*` and routes calls into the
same runner. Gates: `studio-apps-headless.test.ts` · the twin-funnel scope corpus ·
`mcp.test.ts` · `check_studio_apps.rb`.
**DONE:** the Marketing Studio's `draftFilm` is one body with three triggers — the
release-published automation, `despia app run marketing draftFilm`, and
`app_marketing_draftFilm` over MCP — all under the same consented grants.

### T5 — the apps shelf: submission, gates, review, signing

`ClosedSource/RegistryRepo`: `apps.json` (coordinate, version, treeHash, contributions
snapshot, grants snapshot, approval ref), `approvals/<owner>/<repo>/<version>.json` signed
rows, denylist/yank semantics reaching the Studio projection, the CI workflow running the OPEN
CLI only (compile + lint + `despia review --app-strict` + seam scan + token lint + budget +
licence/URL-literal rows adapted from `ai_package_gate.rb`; **no submitted code executes**;
`pull_request_target` stays banned), a capability-disclosure diff comment for the reviewer;
`CONTRIBUTING-APPS.md` (the reviewer checklist under the despia-initiated-review doctrine:
automation flags, never final authority). Signing: `ClosedSource/scripts/sign_app_approval.rb`
+ TS verify in `packages/cli/src/studio-apps/approval.ts` + the two-runner `approval.json`
corpus; the key is offline, owner-local (the PUBLISH.md ceremony pattern), never in CI. Extend
`check_registry_repo.rb` + its test. `despia submit` prints the exact PR recipe.
Gates: `ruby ClosedSource/scripts/check_registry_repo.rb` · the approval corpus green on both
runners · the Action green on a fixture submission.
**DONE:** an unapproved third-party app refuses to mount outside dev mode with the reason
named; a tampered tree fails verify at install AND at every materialize. **[O]** publishing the
repo, minting the key, appointing the reviewer.

### T6 — events + automations

The editor-session dispatcher in `Core/Apps/web` + `edit.ts` event taps; `events.json`
enforced. `packages/cli/src/studio-apps/automations.ts` folds granted `<automation>` documents
into the `despia build` server emit (reusing `server-document.ts` reading + the spend/egress
abort rows verbatim); `mode` enforcement + per-run ledger lines; local `platform.*` absence
answers typed in EditorApps ("requires your deployed node / the GitHub App"). Platform fan-out
rows staged in `platform.dsx` (parses, stays excluded — **[O]** the platform deploy + the P6
GitHub App).
Gates: the events corpus · `ruby ClosedSource/scripts/server_document_test.rb` extended · the
`packages/server` suite · a live local check: a draft automation runs on `build.finished` and
writes its draft artifact, never publishes.
**DONE:** the Films "release published → draft film" automation is expressible end-to-end and
executes locally in draft mode.

### T7 — StudioKit + the app lint tier

`OpenSource/StudioKit/` (scheme `studiokit`; `Components/`: PanelHeader, Section, PropertyRow,
RailPane, EmptyState, Toast, …; `tokens.css` referencing only `--dsx-*`/kit tokens), added to
the first-party index. `packages/cli/src/studio-apps/applint.ts` behind `despia review --app`:
token-only styling (the E006/`check_editor_dogfood` rule as an open TS twin), the ladder rungs,
kit-first composition, the remote-literal ban, the byte budget.
Gates: the lint suite + shared fixtures · StudioKit builds + browser-asserted in the components
oracle lane.
**DONE:** the fixture app passes `--app-strict` with zero colour literals; a literal fails with
the token named.

### T8 — first-party conversions (the proof)

Films/Shots → an app module (rail row "Distribution", `tool` rows, the T6 automation; markup
moves out of `EditorShots.dsx`; `/edit/api/films|shots` become the module's granted backing,
endpoints unchanged). Spend Guard → `dashboard.card` + a Studio row (SpendGuard.dsx/
SpendMeter.dsx move). Live Logs next. Preinstalled = in-tree rows shown "built-in" in
EditorApps.
Gates: the studio-surfaces oracle re-walks Distribution/Spend through the slot table · a
grep-gate asserting `Editor.dsx` carries no `shots`/`films`/`spend` rail literals (the census
move, named).
**DONE:** `despia edit` shows Distribution and Spend as apps riding the identical mechanism a
third party gets; disabling them in EditorApps removes them live.

### T9 — docs, skills, the operator ledger

`OpenSource/Skills/writing-a-studio-app.md` (contract-first: manifest → StudioKit → seams →
fixtures → `despia review --app` → submit); the submission guide in RegistryRepo; llms.txt
rows; the CLAUDE.md binding-rule line ("app contributions ride the `apps` facet word; the
`studio` residence seam list is closed — extend it in the proposal + corpus, never inline");
the consolidated owner-gated checklist in `01-apps-shelf.md` §7.

## Environment memory (read or lose an hour)

- **The word `app` is taken** (Mandatory/App). The word is `apps`; the owner is `Core/Apps`;
  the singular spelling aborts at prepare and the error will not say why you expected it to work.
- **The inheritance hop is the whole story.** Threading `env` into `instantiate` without also
  threading it through the nested component expansion (`mount.ts` ~2603) compiles, passes a
  shallow test, and silently hands every CHILD component the global registry. Write the nested
  fixture first.
- **`buildRegistry` is node-only; `compileComponent` is browser-safe.** The sub-registry
  compiler lives beside the editor host (packages/cli), not in the page.
- **The src gate is not optional.** Image/media URLs bypass the fetch funnel by construction;
  without the mount-time origin check, `project:read` alone is an exfiltration primitive.
- **New module folder ⇒ profile + catalog.** `select_release_profile.rb` is an allowlist;
  `Core/Apps` and every first-party app conversion must be classified or they silently vanish
  from release builds, and `generate_package_catalog.rb --check` reds CI until regenerated.
- **Census moves are named or they are rejected.** The rail identities, the editor catalog
  component count, the conformance index corpus count and the gate-coverage census all move in
  this program — each bump names its landed row in the commit that moves it.
- **The shelf CI never executes submissions.** Compile and lint only; the moment someone
  proposes running a submitted app's tests "for quality", re-read the review-poisoning row.
- **`despia add` is the one install verb.** Do not mint `despia app install`; Q6's "one verb,
  one meaning" was settled for the framework repo and holds here.
- **Grants gate at the seam.** If a feature seems to need a dialog-side check, it is designed
  wrong — the dialog renders what the seam enforces, never the reverse.
