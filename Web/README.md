# Web — the TypeScript kernel (third renderer; twin of `OpenSource/Engine/`)

The DSX web framework lives here, per `/web/01` (W0 Open Question 1 — **stamped
2026-07-12**: in-repo, monorepo gravity decisive). The cross-platform contract is one
unchanged `.dsx` package source — iOS → UIKit/SwiftUI, Android → Compose, Web → DOM —
and the Web compiler currently consumes Demo + Foundation that way. Functional Web
coverage is claimed only by the [element support ledger](support/README.md): **60 of 79
canonical elements** are supported (71 of 94 counting aliases), and every non-supported row —
partial or unsupported — declares a machine-readable reason AND a rendered fallback (the
functional twin, or the labelled `dsx-unsupported` placeholder). Every row also declares its
`webClass`: the stable `.dsx-*` root class the renderer stamps, RENDERED and compared against
the real output so a rename cannot silently break an application stylesheet. Zero silent gaps,
gated by `element-support-ledger.test.ts`.

**Architecture (Option C, ratified in `/web/01`):** an own TS kernel — fine-grained
signals over the DSX store, compiled JSE, direct DOM writes, **no virtual DOM**.

## The workspace

| Package | Role | iOS analogue | Status |
|---|---|---|---|
| [`packages/kernel`](packages/kernel/) (`@despia-native/kernel`) | path-keyed signal store, JSE (interpreter + compiled-JS, ONE semantic helper table), action runner, module bus, `dsx.platform` | `OpenSource/Engine/` | **live** — corpus green on BOTH TS paths |
| [`packages/compiler`](packages/compiler/) (`@despia-native/compiler`) | .dsx → node-tree IR (per-node reactivity stamps), platform-suffix folding, CSS emission (`@layer` cascade + owner scoping), module registry | `prepare_config.rb` + `compile_dsx_css.rb` + StackXML | **live** — compiles Demo + Foundation unchanged |
| [`packages/dom`](packages/dom/) (`@despia-native/dom`) | element library (`.dsx-*` class contract), binding engine, keyed lists, slots (caller scope), frame router, theme layers | StackNodeView + Basics components | **live** — Demo acceptance runs in Playwright Chromium, Firefox, and WebKit |
| [`packages/element`](packages/element/) (`@despia-native/element`) | standards-based custom-element wrapper for exposed DSX components | native component embedding | **live** — export smoke-checked (`verify-packages`) and exercised as the embed import path; the attribute/property/event/slot contract SUITE is not written yet (diligence row, ClosedSource/Documentation/diligence.md) |
| [`packages/server`](packages/server/) (`@despia-native/server`) | string renderer (IR → HTML, same resolution rules), full-document pages (title/meta/og), per-node hydration stamps (`data-dsx-n`), SSR `<api>` prefetch + `window.__DSX__` seeding (`renderPageAsync`, nested instances too), islands (inert-subtree skip), embed-fragment SSR (`renderEmbedFragmentAsync`), static route export, redirect pages | — (new surface) | **v0 + adopt-hydration + SSR `<api>` (page/nested/embed) + islands live** — true streaming + the full-page live adapter = the open W6 gate |
| [`packages/cli`](packages/cli/) (`@despia-native/cli`) | `dsx build` (compile path → static site) · `dsx dev` (build · serve · watch · SSE reload) · `dsx lint` (the TS twin of `lint_dsx.rb`) · `dsx doctor` (project checks, authored in DSX — the CLI node's dogfood, `cli-authoring.md`) | `lint_dsx.rb` + `prepare_config.rb` | **live** — tooling face of the release set |
| [`packages/create-dsx`](packages/create-dsx/) (`create-dsx`) | project scaffolder — a real DSX package that `dsx build` compiles as generated | — | **live** — tooling face of the release set |
| [`packages/vite-plugin`](packages/vite-plugin/) (`@despia-native/vite-plugin`) | compile `.dsx` on import + `virtual:dsx-registry`; v0.1 HMR = full page reload | — | **v0.1** — tooling face of the release set |

All workspace packages are **open source** (`/web/01`: *"a framework competing with React
must be open"*); releases cut from the closed CI on tag (`/web/09`), single `0.x` train.
All eight workspaces ship compiled ESM plus declarations, exact internal versions,
package-local README/LICENSE files, public/provenance metadata, and a clean-consumer tarball
gate — the runtime five an application imports, and the tooling three (`cli`, `create-dsx`,
`vite-plugin`) a developer runs before an application exists (`RELEASE_DIRS` in
`scripts/release-packages.ts`); `npm run cold-start` drives the whole first-run path from
tarballs alone. Publishing credentials and the release tag remain operator owned; source
TypeScript, tests, CLIs, and browser oracles cannot enter these package payloads.

Tagged package releases are prepared without publishing by `npm run release:artifacts --
--tag vMAJOR.MINOR.PATCH`. The gate requires a clean checkout at that exact Git tag,
requires every package and internal dependency to equal the tag version, and preserves
the five exact tarballs with SHA-256 sums, the deterministic CycloneDX source SBOM, and
`provenance.json` binding the artifacts to the repository, commit, tree, and tag object.
`npm run release:verify -- --tag …` independently rejects tampering, missing or extra
files, a moved tag, or source/lock/SBOM drift. Neither command contains a publish path.

## Adaptive design language

DSX Web deliberately does **not** emulate UIKit or Material in CSS. Its default skin is
a neutral semantic layer informed by platform UI conventions, while the iOS and Android
renderers continue to instantiate their real native controls. The same `.dsx` markup and
state/interaction contract therefore travel across targets without pretending that a DOM
button is an Apple or Android system view.

The framework tokens and shipped control families are mobile-first and input-aware:

- the default control token is 44px, and touch-oriented control families pin at least
  44×44px targets under a coarse pointer;
- coarse-pointer tablets retain that geometry;
- viewports at least 64rem wide with a fine pointer use 38px precision controls, tighter
  radii/gaps, hover feedback and keyboard focus behavior;
- layout primitives remain author-directed. Responsive columns, master/detail composition,
  safe-area placement, and reading-measure caps are application/sidecar choices (the Demo
  exercises them), not universal geometry silently imposed on every `.dsx` surface.

All of those choices live in the weak `dsx-tokens` / `dsx-elements` cascade layers. An
application can override tokens, sidecar CSS, classes or a component's authored `style`
without `!important`; the renderer's semantic DOM, bindings and accessibility behavior
remain intact. A responsive default is never allowed to outrank an explicit `.dsx` choice.

### Icons are not a web table

`icon=` / `systemImage=` / `tabIcon=` / `actionIcon=` name **SF Symbols**, and the one
cross-runtime resolution table is `OpenSource/Conformance/icons/sf-map.json` — the same file
Android packages as a `:render` asset. Web does **not** keep its own list. Its two lookup
tables are generated from that corpus into `packages/dom/src/icons.generated.ts`
(`npm run icons:generate`), and `packages/dom/test/icons.test.ts` fails the suite when the
generated file drifts from the corpus, when a corpus row cannot be drawn on web at all, or
when the web package names an icon the shared table does not.
`npm run browser:icons` (also in `browser:matrix`, all three engines) then proves each
generated glyph actually **paints**: a malformed path passes a string check and renders
nothing, so every name is mounted for real and must report a non-degenerate ink box.

The browser render ladder mirrors Android's: a **24×24 fill vector** (the row's `web`
field — Boxicons fill paths since the 2026-08-23 axis v2, see the corpus `_web_axis`
note), else the row's **`fallback`** unicode glyph drawn as SVG `<text>`, else — only for a
name the corpus does not contain — the fail-open placeholder plus one console warning
(override such a name with `icon-web=`).

One documented divergence, recorded in the corpus rather than hidden (the old
no-web-vector gap is CLOSED: all 107 `icons` rows now carry a `web` path; the fallback
rung remains as the ladder's safety net, not a standing state):

- 15 names the in-repo web previews author live in the corpus's `web_extra` section instead
  of `icons`, because an `icons` row also pins a Material Symbols codepoint that the bundled
  Android subset font must carry (`FontSubsetTest`); promoting one means regenerating that
  font subset.

The tables cost nothing when unused: `iconSvg` is the only reader, so a slice that draws no
icon tree-shakes the generated module away entirely and the embed size gates
(`/web/13`) are unaffected.

### Bound collection safety ceiling

Bound `<list>`, `<grid>` and `<pager>` reconcile at most **1,000 live rows/pages** per
surface update and SSR request. When the source is larger, the root exposes
`data-dsx-truncated="true"`, `data-dsx-total-count` and `data-dsx-rendered-count`; list/grid
ARIA metadata retains the source size. `on:reachEnd` does not fire against a truncated
prefix, because that prefix is not the real end. This is a deterministic containment
guard, not virtualization: applications with more than 1,000 simultaneously addressable
items must page/chunk their data until windowed collection rendering lands. Web currently
implements the fixture-backed bind/key/spacing/axis/scroll/align/columns/reachEnd and pager
selection contracts; native-only list grouping, swipe actions, drag reorder and autoscroll
remain explicit parity gaps rather than inert lookalike APIs.

## Gates (run before committing web changes)

```bash
cd OpenSource/Web
npm install                 # once (typescript, playwright-core, @types/node)
npm run conformance         # OpenSource/Conformance/jse on BOTH TS paths — the keystone
npm test                    # kernel + compiler + server suites (incl. jse/api/action corpora)
npm run typecheck           # tsc --noEmit across all packages
npm run pack:check          # build + pack + clean-consumer import/type/browser-bundle gate
npm run release:test        # adversarial tag/version/hash/SBOM/provenance release tests
npm run icons:generate      # regenerate the web icon tables from the shared sf-map corpus
npm run build:demo          # .dsx → registry + browser kernel → demo/site
npm run layout-oracle       # Taffy fixtures vs headless Chromium (tri-runtime parity)
npm run browser:icons       # every generated icon glyph paints a real box in a real engine
npm run browser:hydrate     # W6 adopt-hydration: every static demo SSR route boots with mismatch=0, server DOM reused
npm run browser:matrix      # layout, Demo/UI/stress/offline, editor in all 3 engines
```

The same set runs in CI (`codemagic.yaml`, `web-kernel` lane). **A JSE change is illegal
without a green corpus on every runtime** (`/web/07`) — Swift is the reference (record
mode), Kotlin runs it per-PR, this kernel runs it on both executors per-PR.

Latest current-tree verification (2026-08-18, real runs): the built node test suite passes
with 0 failures (**2,929 passing plus 11 environment-gated skips** — including the committed
seeded parser-fuzz gate described below, the golden-HTML render suite, the L-01
element-closure proofs, and the CLI-node corpus), `npm run conformance` 837/837, and
`npm run typecheck` passed. The eight distributable packages passed the 562-file tarball,
clean-consumer import, type, repack, and browser-bundle resolution gate (`pack:check`) plus
the tarballs-only first-run walk (`cold-start`).
Conflict-copy filenames are excluded at compile time and rejected from release
tarballs. The demo compiled 26 route-table entries into 30 SSR route
pages (verified by rebuilding, 2026-08-23); its EmbedCard slice is 40,899 bytes gzip (that figure is the fixed-feature slice
built by `packages/compiler/test/embed-structural-slicing.test.ts`, which pins this
sentence; `npm run build:demo` emits the same bytes because both now build with ONE fold
map, `embedDefines` in `packages/compiler/bin/embed-entry.ts`). The G10 widget law is 40,960 bytes, so **70
bytes of headroom remain** (the moved row: `__DSX_OPTIONAL_CONTROL_METRICS__` - the density
plane's toggle, slider, field and textarea metrics are read by the control sheets and by
nothing else, so a widget that imports none of them stopped shipping 28 token declarations
it could not reach, 222 bytes gzip. The same commit put the fold map in one place: the
builder and the two slicing gates had drifted apart, and the copy that measured the law was
a fold behind the copy that shipped. The row before it: named styles now compile on web - a `<style as=>` head
declaration folds into an owner-scoped class rule, which both native renderers already
honoured - together with a list filling the card it sits in and the segmented thumb no
longer animating its first, pre-layout placement, 36 bytes gzip. The row before it: the style-override plane — the `<override>`
head contract, the `override:` usage split and the `dsx.override` read — whose runtime
folds behind `__DSX_OPTIONAL_STYLE_OVERRIDES__`, leaving a knob-free widget only the
folded shells, and the widget payload drops each head's empty `overrides: []` row. The
row before it: the `<tool>` head declaration and its
`__DSX_OPTIONAL_WEBMCP__` fold (proposals/webmcp.md), 2 bytes gzip here - the binding
folds away for a slice with no rows, so only the seam declaration moved. The row
before it: the review sweep before the dev merge - the SSR
reactive-context fold, the strict submitOnEnter read and the shared-context style bridge,
19 bytes gzip. The row before it: the glass pair - `glassTint` and
`glassInteractive` became properties the theme READS rather than a `-dsx-*` vendor
spelling a browser drops, and the numeric attribute reader stopped treating an absent
value as zero. Both land behind `__DSX_OPTIONAL_SURFACES__` and
`__DSX_OPTIONAL_STYLE_FORMULAS__`, which this slice unsets, so the slice moved 2 bytes
DOWN. The row before it: `__DSX_OPTIONAL_SPRING__`, the sampled `linear()` spring-upgrade table in `theme.ts`, plus the list/grid/pager fallback rules riding `__DSX_OPTIONAL_BOUND_COLLECTIONS__` - a widget that imports no spring consumer and authors no collection tag sheds both. The row before it: `<text type="...">`, the twelve ratified type
roles made reachable from markup, which costs one element-layer rule per role and 168 bytes
gzip here. The row before it: the token sheet stopped shipping its own documentation, twice. The state layer, the type ramp's leading rungs and the density
plane landed in TOKENS_CSS and took it 2,198 bytes OVER the law; the law was right and
the tokens were not the waste. 6,069 bytes of CSS comments were riding inside the
sheet's template literals and reaching every browser, so they moved out to TS comments
beside the declarations they document - same words, same place in the source, zero
payload. The design-system burn-down then added the label/caption2/reading rungs, the
fluid twins, the glyph scale, the loop periods and the focus halo, and wrote 2,229 more
bytes of CSS comment alongside them - 125 bytes back OVER the law. The same move
applied again to the new prose: every declaration is byte-identical after
comment-stripping (proven by dumping both builds and diffing), so the slice ships
strictly more design system and strictly less documentation. The prior row was
`__DSX_OPTIONAL_STRINGS__`, the P12 localization fold). Headroom is bought by making a subsystem OPTIONAL and proving the
slice does not reach it — `__DSX_OPTIONAL_FETCH__` was worth 1,246 bytes, and the
component-fidelity folds below are the most recent — never by raising the limit. The
ordinary self-contained widget budget is 40,960
bytes gzip and **EmbedCard now meets it with 63 bytes to spare, carrying NO declared
override** — the `budgetKB: 49` its package used to declare is retired. What closed the
~12% gap is four more slice-driven `__DSX_OPTIONAL_*` folds, all of the same shape as
the existing ones (the flag is unset for anything that is not a sliced embed, so full
apps, SSR and every test see byte-identical behavior): `__DSX_OPTIONAL_SCAFFOLD__`
(the `<scaffold>` application shell — factory, adaptive-shell resolver and its CSS
block), `__DSX_OPTIONAL_STATIC_ELEMENTS__` (image/scroll/spacer/divider and their
rules), `__DSX_OPTIONAL_CONTROLS__` (the toggle/slider/textfield/textarea/progress/
spinner/stepper factories), and the largest, `__DSX_OPTIONAL_JS_GLOBALS__` — the JSE
JS-globals layer (`JSECore` + `JSECrypto`: Date/URL/Intl/JSON/Math/Object/Map/Set/
crypto/base64). That layer is reachable only by NAME and mints every dict shape it
consumes, so a closed slice that names none of it cannot reach it; the folded stub
still serves the two shapes the layer does not mint, a regex literal's `.test()` and
the error system's `{__error}` coercion. The detector is
`registryUsesJsGlobals` (`packages/compiler/bin/embed-entry.ts`), deliberately a
superset — any capitalized foreign/facet tag, any `dsx.module.`/`dsx.component.` call,
or the mere appearance of a global's name anywhere in the slice keeps the layer.
A fifth fold joined them with the L-01 element closure: `__DSX_OPTIONAL_MARKDOWN__`
folds the whole inline markdown parser (`packages/dom/src/markdown.ts`) out of any slice
that authors no `<text markdown=>`. Its define is read INSIDE the `if` CONDITION, not
hoisted into a `const` — that is what lets esbuild delete the block and tree-shake the
module; a flag merely checked around a call site does not.
The component-fidelity wave bought its own headroom with three more folds of the same
shape plus three css rides on defines that already existed. `__DSX_OPTIONAL_REGEX__`
folds the JSE regex engine (`packages/kernel/src/jse/regex.ts` FULL/ABSENT twins) AND
the regex-literal lexing branches in `tokens.ts`/`jse.ts`; its detector
`registryUsesRegex` is deliberately a slash SUPERSET (any `/`, the `RegExp`/`regex`
words, or a foreign payload keeps the engine), which is exactly what makes folding the
lexer sound: a folded build's sources carry no `/` at all. The string-pattern halves of
`replace`/`split` stay real in the absent twin. `__DSX_OPTIONAL_STYLE_FORMULAS__` folds
the runtime style-value mapper (`packages/compiler/src/cssmap.ts` vocabulary tables and
the legacy-attr runtime half); static styles were already mapped at build time, so only
a `{{ }}` style/bridge formula, a semantic `color=`, bound rows, or universal globals
(their factories tint through semantic fallbacks) keep it, via
`registryUsesStyleFormulas`. `__DSX_OPTIONAL_BUTTON_VARIANTS__` folds the non-default
button skin (variant="bordered", the destructive/cancel role words) out of theme.ts;
`registryUsesButtonVariants` keeps it for those words or any interpolated
`variant=`/`role=`. `__DSX_OPTIONAL_STYLE_OVERRIDES__` folds the style-override plane
(the kernel's style-overrides.ts resolve machinery, the mount split/seed doors and the
JSE `dsx.override` branch) out of any slice that declares no `<override>`, authors no
`override:` spelling and reads no `dsx.override`, via `registryUsesStyleOverrides` —
the usual superset, and foreign payloads keep it; a knob-free widget's payload also
drops each head's empty `overrides: []` row. `__DSX_OPTIONAL_SPRING__` folds the sampled `linear()` upgrade of
`--dsx-ease-spring*`; the bezier fallbacks stay in the shared token plane (the
pre-linear() floor) and the float table drops when the slice imports no sheet that
names those tokens. The css rides: the list/grid/pager fallback rules under the
existing `__DSX_OPTIONAL_BOUND_COLLECTIONS__` (structural embeds load the fuller
twin; a collection-free widget does not), the `.dsx-surface-*` material rules under
`__DSX_OPTIONAL_SURFACES__`, the plain `aria-pressed` button rule under
`__DSX_OPTIONAL_PRESSED__`, and the `searchParams` parent-walk in the runner under
`__DSX_OPTIONAL_JS_GLOBALS__` (no URL shape can exist without the layer that mints it).
Theme pin tables stay unconditional: a host page can pin an embed's scheme by writing
`data-dsx-theme` itself, so a theme-less widget must still honor it.
The same folds hold the audio/video playback qualification at 1,058 bytes of headroom
(49,066 B audio / 49,069 B video / 49,118 B combined against its declared 50,176-byte
budget).
All generated offline assets matched their manifest SHA-256 hashes over localhost
HTTP. The locked Chromium, Firefox, and WebKit matrix is green: it walks every
component route in the demo route table (25 as of 2026-08-23; the oracle reads the
table itself, so a new route joins the matrix automatically, floored at 22)
at iOS-phone, Android-phone, iPad, desktop, and wide-desktop viewport
contracts, including overflow, navigation, focus/inert restoration, responsive
master-detail, breakpoint boundaries, offline reload, pointer/keyboard stress, embeds,
and editor interaction. The `visualViewport` software-keyboard path is not qualified by
a real mobile keyboard session. Portable viewport markup is pinned by compiler/SSR
assertions; it is not claimed as a WebKit runtime viewport guard.
**A seeded, deterministic hostile-parser fuzz gate IS committed to this tree**
(`packages/compiler/test/parser-fuzz.test.ts`). It runs inside `npm test` — which globs
`packages/*/test/*.test.ts`, the exact command the codemagic `web-kernel` lane runs —
and standalone as `npm run fuzz`. A committed mulberry32 PRNG (never `Math.random`,
which the runtime forbids and which would make the corpus un-reproducible) is driven by
a FIXED 12-seed set, so the SAME corpus is generated byte-for-byte on every run. That
corpus is 7,680 hostile/degenerate `.dsx` documents (12 seeds × 640, a build-time
constant sized to add ≈1.5 s to `npm test`) drawn from eight generator families: token
salad, deep / unbalanced / over-limit nesting, giant and malformed attribute lists,
ampersand and entity floods (valid, oversized, and unterminated numeric entities), raw
code-tag bodies, lone-surrogate / control / non-character bytes across
text / attribute / comment / CDATA / tag-name contexts, malformed head blocks, and
byte-level mutations of valid skeletons. Every document is driven through BOTH source→IR
entry points — `parseDsx` (the tokenizer/parser) and `compileComponent` (the full
component IR), 15,360 parse/compile invocations — and the gate asserts each outcome is
EITHER a parsed result OR the parser's one declared structured error, `DsxParseError`;
any other thrown type, or a single case exceeding a per-case time budget (the hang/OOM
proxy), fails the suite and prints the seed, family, index and exact input for one-line
reproduction. `DSX_FUZZ_CASES=<n> npm run fuzz` runs a larger manual campaign without
changing the committed corpus.

Across the committed budget — and a ~192,000-invocation exploratory sweep — the fuzzer
found no process crash, hang, or OOM in `parseDsx`: its byte (4 MiB), node (50,000) and
depth (256) bounds hold. It surfaced exactly one error-path inconsistency, fixed
together with the gate: `compileComponent`'s `<api as>` head validation threw a bare
`Error` rather than the declared `DsxParseError`, so the whole source→IR path now raises
a single structured error type. This states exactly what the committed gate runs; it
makes NO claim about any specific historical case count — the earlier "50,000-case" line
is retired, not restored.

This joins the tree's hand-written hostile-INPUT coverage inside `npm test` —
bounded/cyclic/oversize cases in the server render suites, the `<api>` graph depth and
complexity bounds (/web/05), and the JSE depth-boundary cases mirrored in
`OpenSource/CanvasEditor/test/run-jse-conformance.mjs`.
Playwright WebKit is not a physical Safari release, and Playwright Chromium is not a
branded Edge qualification. Supported Safari/Edge and mobile browser versions still
require external release-device testing. These are
repository/runtime acceptance results, not a substitute for release signing, production
observability, backend load testing, or fleet-scale certification.
The repository currently has no external release-controller-signed
`production-admission` bundle for this source, so these green Web gates do not authorize GA or
package publication.

## Workstream status (`/web/10` — gates, not dates)

- **W0 ratify** — ✅ stamped 2026-07-12 (repo home · OTA-on-web behind a flag ·
  `<api type=>` v1.1 · browser floor last-2 evergreen + Safari 16.4).
- **W1 kernel+JSE** — ✅ G1 green: corpus passes on interpreter AND compiled closures;
  store/action fixtures green (batching, COW paths, rowWrite); the effect SCHEDULER
  ships (writes publish immediately, bindings coalesce per microtask — /web/07);
  headless counter runs. State is our own kernel, zero runtime deps — **ratified in
  `/web/20-state-management.md`** (no Preact/React/Solid, and why).
- **W2 compiler+DOM+CSS** — ✅ core green: Demo's Launcher/Flex/Basics/System render
  from UNCHANGED sources across the locked Playwright engine matrix; layout oracle 7/7; cascade layers
  + tokens + element base shipped; slots (default+named, caller scope) live.
  The element ledger and focused DOM/SSR/browser suites cover the shipped sheet, alert,
  menu, segmented, picker and base-control implementations; the ledger carries
  **zero silent gaps** — every non-supported row declares a reason and a rendered fallback,
  and the gate requires both.
  **The `webClass` column LANDED** (2026-07-29): every one of the 91 ledger rows declares the
  stable `.dsx-*` class its ROOT carries, and `element-support-ledger.test.ts` RENDERS each tag
  through the DOM-free string renderer and fails on any drift between the declared class and
  the emitted one — a machine-checked class contract, not a documented one. A capitalized
  native-only tag is the one declared exception: SSR emits nothing for it (it cannot know
  whether a module facet will provide the tag), and the DOM renderer mounts the labelled
  `dsx-unsupported` marker, which the same suite proves.
  **The golden-HTML suite LANDED** as `packages/server/test/golden-html.test.ts`: a committed
  corpus of whole-component renders (`packages/server/test/golden/*.html`) that the server must
  reproduce byte-for-byte. `DSX_GOLDEN=update npm test` re-records it, so a markup change is a
  reviewable diff instead of an invisible one.
  Remaining W2 work: folding the same `webClass` column into the GENERATED editor catalog
  (`OpenSource/Documentation/reference/stack-elements.json`) — that file is emitted by
  `ClosedSource/scripts/generate_editor_catalog.rb`, so the catalog half is a Ruby-lane change,
  and the web-side column above is its source of truth.
- **W3 packages/npm** — package-distribution floor green: all five `@despia-native/*` workspaces
  build to compiled ESM + declarations and pass exact-tarball clean-consumer gates. Module
  `web/` facets ship for route, toast, haptic,
  spinner, darkmode, clipboard, share, browser, metadata (file presence = the gate;
  `dsx.has()` honest, `avail:` badges visibly degrade on the Launcher). dsx.json
  `aliases` ride each generated registration — legacy schemes route to the owning
  module, the native GeneratedModuleSchemes twin.
  **The dsx.json `web` BLOCK is now CONSUMED** (`packages/compiler/src/web-manifest.ts`):
  a package declares `routes` (merged into the unified table, collision-linted — see W4),
  `styles` (folded into the compiled sheet), `assets`, `base`, and `links` (the native
  universal-links declaration). `buildRegistry` reads every package manifest during the walk
  it already does, so the block costs no extra IO, and the resolved contributions land on
  `registry.packageWeb` for any consumer. `@despia-native/vite-plugin` consumes the same reader
  (`collectPackageWeb` + the new `virtual:dsx-routes` module), so a Vite app and `dsx build`
  see one implementation. Remaining product breadth: application-level bundling and
  code-splitting; neither is claimed by the 0.1 package line.
- **W4 router** — core live: application `Config/routes.json` consumption and validation,
  redirects, the unified route table (URLs ↔ component pushes),
  history integration (routed pushes write entries; pathless pushes keep the URL),
  deep-link cold load (walk-asserted), path/query params → `vars.*` +
  `route.{path,params,query}` store reads, 404 via `notFound`, the web system bar.
  **PACKAGE-CONTRIBUTED ROUTES + the collision lint LANDED** (2026-07-29): a package
  declares `web.routes` in its own dsx.json; a bare `component` qualifies inside the
  declaring package, the APPLICATION table (`Config/routes.json`) stays authoritative and a
  package path that collides with it is dropped with a warning, and two PACKAGES claiming the
  same path is a BUILD ERROR — a build whose URLs depend on directory order is worse than a
  build that refuses. `packages/compiler/src/web-manifest.ts`, gated by
  `packages/compiler/test/web-manifest.test.ts`.
  **SHEET FRAGMENTS LANDED**: a presented sheet/cover is a chain frame — pathless, so the URL
  used to say nothing about it. It now carries `#sheet=<Component>` on the current URL (path
  and query untouched), so a presented sheet is linkable, shareable and restored on reload;
  Back and `dismiss()` unwind the fragment with the history entry, and only the exact
  `#sheet=` shape is honored so an ordinary in-page anchor stays an anchor. Overlays
  deliberately do not participate (no history entry, dismissed by verb — the native contract).
  **The NATIVE UNIVERSAL-LINKS GENERATOR LANDED**: `apple-app-site-association` and
  `assetlinks.json` are GENERATED from the route table
  (`packages/compiler/src/universal-links.ts`, emitted by `build:demo` into `.well-known/`),
  so a route added on web is a deep link on both natives with no second edit. Path params
  collapse to a single path-component wildcard (`/orders/:id` → `/orders/*`), `exclude`
  patterns emit FIRST because Apple matches in declaration order, and a package that declares
  no `web.links` publishes NOTHING — an association that matches nothing is worse than none,
  because iOS caches it. A half-declared block is a build error, never a half-valid file.
  Remaining: SCROLL RESTORATION — narrower than this paragraph used to say. Back is covered by
  construction (frames are stacked layers that keep their DOM, so their scroll survives being
  covered — the native stack contract). The REBUILD case is now HALF PROVEN: the router banks a
  per-history-entry offset ledger (`router.ts` `restoreScroll()` + `history.scrollRestoration =
  "manual"`) and the `browser:scroll` oracle asserts the WRITE side in a real Chromium — a scrolled
  leave banks its live offset, an unscrolled leave banks nothing, a first visit stays put (3/3).
  What is still unproven is the RELOAD READ path: headless Chromium here returns
  `history.state === null` after a reload, so the ledger key cannot be looked up and the oracle
  declares that limit in its own header rather than asserting around it. It needs a browser that
  preserves entry state.
- **W5 `<api>`** — CROSS-PLATFORM core green: one corpus
  (`OpenSource/Conformance/api/api-blocks.json`, 41 cases) runs on the TS kernel,
  Kotlin `ApiBlock.kt`, and Swift `ApiBlock.swift`; all three runners passed in the
  latest cross-runtime audit. Auto-fetch, materialized-request refetch,
  debounce/abort-stale/retry, events (on:success/error/message), cache
  (max-age/swr), bounded `json|text|blob` decoding, cookie-partitioned auth,
  and true incremental SSE are live. The native coroutine/URLSession transports,
  head mounting, action handles (`refresh`/`send`/`cancel`), and stale-response guards
  are wired and covered by native integration/UI tests, including five green Swift
  native API integration suites. SSR prefetch/hydration LANDED in W6 (see below).
  **The dependency graph (doc 11) LANDED 2026-07-29** in all three kernels — `needs=`
  plus expression edges, value-presence gating, `<as>.status`/`<as>.blockedBy`,
  upstream-error propagation, identical-refetch suppression, `incomplete-input` on a
  manual send, and a DECLARED error on a cycle / unknown `needs=`; the SSR walk in
  `packages/server/src/render.ts` runs the same DAG (runnable blocks together,
  dependents as their upstreams resolve, still-gated blocks left for the client).
  **networking.md N2's declared transport controls LANDED** with it: `stream=`,
  `timeout=`, `redirect=`, `encode=` (json|text|form|multipart) and `on:progress`.
  **`via="server"` LANDED (routing plumbing)** — the client half rewrites to
  `/dsx/api/<as>?u=…` on all three runtimes; the server half is
  `packages/server/src/api-proxy.ts` with an SSRF allowlist and browser-credential
  confinement. Remaining: the native RENDER mounts (`StackApiView.kt`,
  `StackApiMountView`) do not yet hand the mount a per-scope graph, so on native UI
  the value-presence gate is live but the `needs=`/expression edges are not; the
  three doc-11 lint rules are specified, not implemented; and the `via="server"`
  credential provider + `native="direct"` escape are [S-BOUNDARY] Track-S work.
- **W6 SSR** — v0 + ADOPT-HYDRATION live: `@despia-native/server` renders IR → HTML
  (components/slots/lists), full-document pages with title/meta/og, static route
  export, redirect pages — and `renderPage` stamps per-node identity
  (`data-dsx-n` via the compiler's `stampNodeIds` + the host's `data-dsx-hydrate`),
  so the client boot ADOPTS the server DOM instead of replace-mounting
  (`packages/dom/src/adopt.ts`): the structural/content tier (stack family, scroll,
  text, image, buttons, slots, component roots, visible-if anchors) binds the
  EXISTING elements — identity preserved, listeners/effects attached in place;
  control machinery is claimed (structure verified by stamp) then factory-rebuilt
  in place — the documented v1 tier, counted, never a mismatch; any divergence
  logs one diagnostic and replace-mounts that subtree (fail-open, never blank),
  counted in the `__DSX_HYDRATION__` report. Gate evidence: `npm run
  browser:hydrate` — all 23 static demo SSR routes hydrate with **mismatch = 0**,
  the parse-time-captured server root is the SAME element (`===`) inside the live
  frame on every route, and an adopted server-rendered button drives the store.
  Embeds keep their v1 replace-on-upgrade path (`__DSX_OPTIONAL_ADOPT__` folds the
  walk out of embed bundles).
  SSR `<api>` EXECUTION + hydration seeding also landed: `executeSsrApis` +
  `renderPageAsync` (`packages/server`) run a route component's ssr-eligible GET
  blocks during render (opt-in `ssr=`, default true on GET, never a mutation and
  never `auto="false"`), embed each ok result in the body (data on first paint)
  AND the `window.__DSX__.api` payload, and the client boot seeds those blocks
  (`adopt.ts` `seedApiEnvelopes` → `api.ts` `ApiBlock` seed) so it adopts the data
  and SKIPS the initial fetch — then honors normal refetch/cache/events. Every
  failure (network, timeout, http, decode) is fail-open: the block is absent from
  the payload and the client fetches on mount, so a bad upstream never breaks the
  page. Proven by `packages/kernel/test/api.test.ts` (SSR execution + a seeded
  block making zero boot fetches, refetching on a dep change) and
  `packages/server/test/ssr-api.test.ts` (execution + payload round-trip: SSR
  fetches once, the client re-seeds from the payload and does not re-fetch).
  ISLANDS also landed: an inert subtree — the compiler's per-node reactive
  stamp is `false`, i.e. no `{{ }}`/`on:*`/`visible-if`/`bind`/`<api>`/component
  anywhere under a presentational root — is claimed by identity and SKIPPED by
  the adopt walk (`adopt.ts` `isIslandRoot`): its server DOM is reused verbatim,
  no ElementApi, no binding, no reactive graph (the Astro-islands result off the
  W6-1 stamps, zero authoring tax). Counted in `__DSX_HYDRATION__.islandsSkipped`;
  proven by `adopt.test.ts` (a deep inert element is the SAME object, adopted
  counts only the reactive shell, and a disposer-differential shows inert content
  builds zero reactive graph). NESTED-COMPONENT SSR apis landed too: `executeSsrApis`
  walks the route component AND every nested instance it renders (visible-if/has:
  honored, first bound row, slots in caller scope), so a CHILD's ssr GET runs during
  render and seeds the payload; the body threads `apiSeeds` into nested renders so a
  child's data paints on first render, and the client adopts it (payload is `as`-keyed,
  first mounter wins). The EMBED-FRAGMENT SSR path landed: `renderEmbedFragmentAsync`
  runs the exposed component's ssr apis, paints data into the DSD body AND embeds a
  per-instance seed payload; `@despia-native/element` reads it and skips the upgrade fetch — the
  whole seed reader folds out of a no-api embed (`__DSX_OPTIONAL_APIS__`, byte budget
  intact), and the live per-request fragment endpoint (`serve.ts`) calls the async path.
  `defer` now has correct non-streaming SSR semantics: a `defer`red block is excluded
  from the initial flush and keeps its client-fetch path (loading branch first).
  Still open in W6: true out-of-order STREAMING (flush a deferred subtree's chunk +
  store-patch as it resolves — the seam is documented, `defer` marks the blocks); the
  cross-block dependency graph (doc 11); and the full-PAGE live adapter (wiring
  `renderPageAsync` into a per-request/static-export production server — build-time
  static export stays sync/no-fetch, the embed fragment endpoint is the one live
  adapter proven locally).
  **W7 DevX** — the three toolchain packages ship:
  [`@despia-native/cli`](packages/cli/) (`dsx build` · `dsx dev` · `dsx lint` · `dsx doctor`),
  [`create-dsx`](packages/create-dsx/) (project scaffolder) and
  [`@despia-native/vite-plugin`](packages/vite-plugin/) (v0.1). They WRAP the existing entry points
  rather than reimplementing them: `dsx build` drives `buildRegistry` + `renderPage`/
  `exportStatic` and vendors the runtime ESM behind a derived import map (`--demo` spawns
  `packages/compiler/bin/build-demo.ts` itself); `dsx dev --demo` hands off to
  `packages/compiler/bin/serve.ts` `startServer`, and in project mode builds/serves/watches
  with an SSE full-page reload. `dsx lint` is the TypeScript twin of `lint_dsx.rb` and is
  **byte-identical to it** over this repo's 105 `.dsx` files
  (`dsx lint --package ClosedSource/DSX/Modules` → 0 errors / 0 warnings / 1 notice) and over
  a 21-finding hostile fixture; its declared gaps (the pool/scheme universe is only the roots
  you point it at — which softens `dsx.module.<scheme>` to a warning without `--package`;
  no `lint_dsx_css` or `check_module_rules` twin) are in
  [packages/cli/README.md](packages/cli/README.md), and `lint_dsx.rb` remains the in-repo
  authority and CI gate. `create-dsx` scaffolds a project that compiles with `dsx build` and
  passes `dsx lint --strict` as generated — asserted end to end for both templates.
  **`@despia-native/vite-plugin` v0.1 has NO hot module replacement**: a `.dsx` change is a full page
  reload, stated plainly in its README. These three are TOOLING and deliberately sit outside
  the five-package npm workspace set, so the release contract below still proves exactly
  `kernel · compiler · dom · element · server`; publishing them means adding them to
  `scripts/release-packages.ts` first. Open W7: component-level HMR, a bundler/asset pipeline
  in `dsx build`. **The dsx.json `web` block consumption LANDED** (see W3/W4): the plugin
  reads every package root's block through the shared `@despia-native/compiler` reader, folds declared
  stylesheets into the compiled sheet, merges package routes under the application table
  (throwing on a collision), and exposes the merged table as `virtual:dsx-routes`.
  **W8 ship gate** — artifact/build/consumer/audit gates landed;
  registry credentials, signed tag, release notes, and staged npm publication remain operator-owned.
- **Parity floor**: `/web/21-nordcraft-parity.md` — the Nordcraft engine matrix,
  re-scored at every W-gate (engine-core: cleared).

## Constitution mapping (`/web/01`)

`demo/site/index.html` + `main.js` are bootloaders (mount kernel, register chunks, hand
off); **direct DOM access lives only in `@despia-native/dom`** — module web facets create their
own overlays and talk to browser APIs, they never reach into the app render tree (the
no-`querySelector` law; `check_module_rules` gains a web twin later); an excluded
package's facet is simply not copied into the build — `dsx.has()` false, never a crash.
The wire is Article 8: the envelope keys, schemes, and error codes come from
`OpenSource/Conformance/api/wire-contract.json`.

Everything here is judged by `OpenSource/Conformance/` — the corpus is the referee, the
Swift kernel is the reference.
