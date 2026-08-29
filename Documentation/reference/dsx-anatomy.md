# Anatomy of a .dsx file

> The normative document-shape spec. The enforcement lives in
> `ClosedSource/scripts/lint_dsx.rb` (`--strict` is the CI gate in `codemagic.yaml` and the
> local gate in the monorepo working rules); the runtime side is `StackHead` + the `head`/`event`/`expects`
> tags in `OpenSource/Engine/iOS/Stack.swift`. Grammar reference: [`StackReference.md`](./StackReference.md);
> state semantics: [`state-and-computation.md`](./state-and-computation.md).

DSX is a multi-language document the way HTML is: **markup is the tree, JSE is the logic,
JSON is inline data** ([`jse.md`](./jse.md)) — and like HTML, a document has a **head** (the
contract and the logic) and a **body** (the pixels). One file = one component; the file
basename is the component name.

## The shape

```
<!-- doc comment: what this is, who mounts it (one short paragraph) -->
<root view element>          ← carries exit / dismissEdge / on:appear, as before
  <head>                     ← the ONE place declarations live (first child, once)
    interface   →  attribute · override · expects · event · tool
    data        →  api
    state       →  variable (plain first, then computed="true")
    logic       →  formula · action · script
    reactions   →  watch
    styling     →  style
    parts       →  component
  </head>
  …body: pure markup…        ← view tags + component invocations only
</root>
```

Rules (each is a lint check):

1. **One root element per file.** The runtime XML parser rejects extra roots and silently
   drops the whole component — the linter now makes that an error before it ships.
2. **`<head>` is the first child of the root, at most one per element.** It renders nothing;
   its children are declarations.
3. **Canonical order, same-kind contiguous:**
   `attribute → override → expects → event/input/tool → api/variable (plain → computed) → formula →
   action → script → watch → style → component`. The interface always reads first — a reader
   learns the component's API without scrolling past a pixel of layout. The ground truth is
   `OpenSource/Conformance/lint/facts.json` (`headRank` + `headOrderHint`), which every
   linter loads; this sentence is its prose and must match it.
4. **Declarations outside the head are findings.** The one sanctioned exception is a
   `<watch>` inside a `list`/`grid`/`pager` row template — a watch is position-sensitive by
   design (one observer per row). Computed variables need no such exception: they evaluate
   in the *reader's* scope wherever they're declared, so they live in the head.
5. **The body is pure markup.** An inline `on:*` handler holds one call or one assignment
   (lint budget: ≤ 2 statements, ≤ 120 chars, nothing that needs `&lt;`/`&amp;&amp;`
   escapes). Bigger logic is a named action in the head. An expression with nested
   ternaries is a computed variable/formula.
6. **`as=` is the identifier, everywhere.** The legacy `name=` identifier alias is removed
   (on `formula`/`action`, `name` is just an ordinary input again). A declaration without
   `as=` is an error — at runtime it was a silent no-op.
7. **Head optional.** A markup-only component (a Chip, a paywall fragment, a watch screen)
   needs none — ceremony stays proportional to complexity.

> **Module naming in markup** — a handler call like `dsx.module.haptic.warning()` names its
> target by the module's derived dotted **chain**: a manifest declares only its local
> `scheme` segment, and `Modules/` nesting derives the rest
> (`dsx.module.watch.health.heartRate({…})`) — see
> [`facet-contracts.md`](../architecture/facet-contracts.md), *Derived identity*. A module's
> bus actions can never be named one of the proxy's reserved members (`on · available ·
> excluded · state · context · object · delegate · dsx · then` — build-enforced); head
> `<action as=…>` / `<event as=…>` names are component-local and unaffected.

## The interface tags

**`<attribute as="x" default="expr"/>`** — a prop this component consumes
(`dsx.attribute.x`). Declare one per consumed attribute, comment each; `default=` only when
the component genuinely defaults it. The head's attribute block replaces the prose `• prop`
bullet lists — it is the machine-readable `Props:` table.

**`sample=`** — the unit-test sample value, on `variable`/`event`/`api`/`attribute` (v1;
formula/action deferred). JSON only, carried verbatim, editor fuel with no production
semantics: the runtime never evaluates it and a failed `<api>` never reads its sample.
Full law: `OpenSource/Skills/sample-values.md`.

Attributes are **THE component input contract** — the same declarations serve every way the
component can appear, with identical semantics:

| The component appears as… | Its attributes arrive via… |
|---|---|
| a tag in a parent's body | the tag's attributes — `<Paywall plan="pro"/>` |
| a pushed/presented screen | the verb's `attrs` — `dsx.component.present('Paywall', { attrs: { plan: 'pro' } })` |
| a native mount | `ui.attribute("plan", "pro")` (before push, or live after) |

All three seed the same reactive `dsx.attribute.*` dict: a passed value beats `default=`, an
absent key falls back to it, every read re-derives when the value changes, and a **live**
change (`dsx.component.update(target, { attrs })` / `ui.attribute`) fires the declaration's
**`on:change`** handler — `<attribute as="plan" on:change="dsx.action.replan()"/>` is the
component reacting to its inputs with its own logic (the web-component
`attributeChangedCallback` analogue). The mounting side sets declared inputs; it never
touches the component's internal variables — that boundary is what `attrs` exists to keep.

**`<override as="radius" type="number" default="10" min="0" max="32"/>`** — the component's
STYLE contract, beside the attribute DATA contract (the law:
`architecture/proposals/style-overrides.md`; authoring:
[`Skills/style-overrides.md`](../../Skills/style-overrides.md)). A typed style knob a
consumer turns on ONE instance — `override:radius="6"`, `override:radius="{{ expr }}"`
(live), `override:radius:ios="8"` (the ordinary platform fold), or the verbs'
`{ overrides: {…} }` / native `ui.override` — and the component spends wherever its design
needs it, at any depth: `radius="{{ dsx.override.radius }}"`. `type=` is the style catalog's
control vocabulary + `css`; `default=` is a LITERAL style value (never a JSE expression —
the one deliberate asymmetry with `<attribute default=>`); reads are reactive, coerced
fail-open (invalid → the default), and default-backed. Nothing auto-applies — a declared
knob the markup never reads is a lint warning, which is what keeps the contract enumerable
and the editor's styling panel truthful.

**`<expects variable="x"/>`** — state the mounting side must seed (`ui.variable(…)`), or —
in a fragment that shares its parent surface's store — shared surface state it reads/writes.
This is the old "Seeded facts:" header comment as a contract. At runtime the root head's
`expects` are checked one tick after mount: a missing seed logs
`[Stack] <expects …> was never seeded` (the "seed before you push" flash-of-empty, caught).
(The mount verbs' `vars:` option seeds store state under `vars.*` the same way — that is the
**legacy** input channel: it bypasses the declared interface, so new components declare
`<attribute>`s and take `attrs` instead; keep `expects` for genuinely *shared* surface state.)

**`<event as="x" payload="a b"/>`** — an event this component raises (`dsx.event('x')`).
Purely declarative at runtime (DSX's `defineEmits`); the linter checks every literal
`dsx.event('x')` in a file with a head against these, and it replaces the prose `Raises:`
lists.

**`<tool action="x" description="..." as="y" mutates="z"/>`** — an action this document
exposes to an AI AGENT (`proposals/webmcp.md`). The row names one action the same head
declares and carries no schema of its own: the descriptor an agent reads is DERIVED from
that action's declared inputs, which is why there is no `schema=` and never will be — the
`facets.mcp` rule, applied to a document. `as` defaults to the action name; `mutates` names
what the action changes when it changes anything, and its ABSENCE is what emits the
read-only hint. On the web renderer the rows register with `document.modelContext` for
exactly as long as the document is mounted, so the tool set an agent sees is always the set
the current screen can honour; on a native surface the row is declarative and waits for its
consumer. A row naming an action the document does not declare fails the BUILD.

With a head present, the linter also requires every `dsx.variable.x` the file touches to be
declared — as a `variable` (own state) or `expects` (seeded/shared). **A file's state
surface is enumerable from its head.**

Classification rule of thumb: `expects` when the value comes from outside (Swift, the parent
surface) — it is a pure declaration with zero runtime impact; a plain `variable` with a
`return` default only for state this file itself owns and initializes; `computed` for every
derivation.

Logic note: `<functions>`/`<script>` register a surface-local function library. With the
`global` attribute — `<functions global="true">` (presence is the switch; the valued
spelling is canonical, strict-XML parsers reject a bare `global`) — the block registers the
**app-wide** global function library instead: one table shared by every surface, last write
wins, surface-local names shadow it (`OpenSource/Skills/js-core.md` "Shared logic"; corpus
`OpenSource/Conformance/functions/`). Same head slot, same canonical order.

## Head hoisting (what the engine does with it)

A surface root's head is processed at **mount time** (`StackHead.hoist`,
`OpenSource/Engine/iOS/Stack.swift`): actions, variables, formulas, scripts, styles, attribute
defaults and inline components register before SwiftUI evaluates anything. Declarations are
facts of the surface, not render side effects — the old footguns (a declaration inside a
`visible-if`-false subtree never registering; define-before-use ordering) don't apply to
head declarations. The head node itself is a transparent container when rendered: every
registration is idempotent, and view-backed declarations (`watch`, `attribute on:change`)
mount as views. A component template's head registers into the INSTANCE's own store (the
instance-store law: each component instance mounts against a store born with it, so two
instances hold independent state and nothing a component declares leaks into the consumer's
store; slot content is the deliberate exception — it is the consumer's markup and binds in
the consumer's scope and store). Registration still happens on the first render walk.

## Root-shape exception

A head needs a root that renders children. A component whose root is a **leaf control**
(`button`, `text`) or a **data-bound collection** (`list`/`grid` with `bind=` on the root —
its children are row templates) takes **no head**; its contract stays in the header comment.
Everything stack-, scroll- or pressable-rooted takes one.

## Surface dialects

**Snapshot surfaces** execute no JSE in-process, and their renderers skip unknown tags entirely
— so on these documents the head is **declaration-only**: it documents the seed contract
(`expects`) and the relayed event names (`event`), and the renderer ignores it. Logic tags
(variables, actions, formulas) stay out of snapshot documents — there is nothing to run them:

- **Widgets / Live Activities** (`StackLive`/`StackWidgetKit`; in an `<activity>` slot
  document the head sits before the slot elements) — the OS renders archived state; a
  widget is a *snapshot node* (`watch-runtime.md`: "state replication in, forever; never
  calls, never a runtime"). Their two forms of declared dynamism — live tokens like
  `<countdown>` and compiled `on:tap` interactions — still run no JSE in the node.

**watchOS is NOT a snapshot surface** (corrected 2026-07-25 — this section previously listed
it as one). The watch app is a **live node** with its own JSE runtime:
`WatchRuntime.swift` mounts the screen's head — `<variable>` (initials + `computed`),
`<formula>`, `<action>`, and `<api>` blocks — into one `WatchJSEState` shared by expressions
and the `JSEActionRunner`, so the FULL head anatomy applies on the wrist. Logic tags belong in
watch documents, and the package's own bundled screens use them:
`WatchApp/BundledScreens/demo-state.dsx` declares `<variable as="count">`, a
`computed="true"` variable, and three `<action>` bodies; `demo-timer.dsx` runs `setInterval`
from an action. `{{ … }}` spans evaluate through the real JSE evaluator, `visible-if` gates on
real truthiness, and `await dsx.module.<s>.<a>()` resolves in-process against the generated
capability table. The wrist limits are about the ENGINE tier, not the dialect: the UIKit-coupled
`Stack.swift`/`Router` do not compile on watchOS, so `StackWatch` is a separate render backend —
see `reference/StackWatch.md` and `architecture/watch-runtime.md` (W1/W2/W3) for exactly which
tiers landed. Wear OS mirrors the watch's tier, with its own pins in `StackWear.kt`.

On the full engine the anatomy degrades gracefully on OLD binaries too (remote-delivered
DSX has no version handshake): unknown tags render their children, so a head's declarations
register exactly as before and `event`/`expects` no-op.

## Removed legacy

| Removed | Write instead |
|---|---|
| `name=` as the declaration identifier | `as=` (on `formula`/`action`, `name` is an ordinary input) |
| `<prop …>` | `<attribute as="…"/>` |
| `<native name="x"/>` | `<x/>` (component resolution finds registered surfaces) |
| `.xml` file extension (remote/DSXView) | `.dsx` |
| the `<listener>` app bus | component events + `computed`/`global.*` — see [`events.md`](./events.md) |

## The golden template

```xml
<!-- Downloads — the offline-episodes manager sheet.
     Swift seeds the facts and owns the filesystem; this file owns everything visual. -->
<vstack background="{{ dsx.attribute.background }}" radius="24" padding="16" spacing="12">
  <head>
    <!-- interface -->
    <attribute as="title"       default="'Downloads'"/>     <!-- sheet heading -->
    <attribute as="removeTitle" default="'Remove download?'"/>
    <attribute as="accent"      default="'#6C5CE7'"/>
    <attribute as="background"  default="'#111'"/>

    <expects variable="downloads"/>      <!-- [{id,title,poster,bytes,progress,state}] · seeded + kept live -->
    <expects variable="quotaBytes"/>     <!-- device quota, seeded once -->

    <event as="pause"  payload="episodeId"/>
    <event as="resume" payload="episodeId"/>
    <event as="remove" payload="episodeId"/>
    <event as="close"/>

    <!-- state: plain first, computed after -->
    <variable as="confirmingId">return ''</variable>

    <variable as="usedBytes" computed="true">sumBy(dsx.variable.downloads, d => d.bytes)</variable>
    <variable as="quotaShare" computed="true">
      if (dsx.variable.quotaBytes == 0) { return 0 }
      return min(1, dsx.variable.usedBytes / dsx.variable.quotaBytes)
    </variable>

    <!-- logic: formulas derive (nouns), actions do (verbs) -->
    <formula as="sizeLabel" bytes="item.bytes">
      if (bytes > 1073741824) { return round(bytes / 1073741824) + ' GB' }
      return round(bytes / 1048576) + ' MB'
    </formula>

    <action as="toggle" id="item.id" state="item.state">
      if (state == 'downloading') { dsx.event('pause', { episodeId: id }) }
      else { dsx.event('resume', { episodeId: id }) }
    </action>
    <action as="confirmRemove">
      dsx.event('remove', { episodeId: dsx.variable.confirmingId });
      dsx.variable.confirmingId = ''
    </action>

    <!-- reactions: side effects only — values are computed, never watched -->
    <watch value="dsx.variable.quotaShare"
           on:change="if (dsx.variable.quotaShare >= 1) { dsx.module.haptic.warning() }"/>

    <!-- style: repeated looks get a class -->
    <style as="row"  padding="12" radius="14" background="rgba(255,255,255,0.06)"/>
    <style as="pill" radius="16" paddingH="12" paddingV="6" fontSize="13" fontWeight="semibold"/>
  </head>

  <!-- body: pure markup — every handler is one call or one assignment -->
  <hstack>
    <text value="{{ dsx.attribute.title }}" fontSize="20" fontWeight="bold"/>
    <spacer/>
    <button icon="xmark" on:tap="dsx.event('close')"/>
  </hstack>

  <progress value="{{ dsx.variable.quotaShare }}" color="{{ dsx.attribute.accent }}"/>

  <list bind="dsx.variable.downloads" key="id">
    <hstack class="row" spacing="12">
      <image src="{{ item.poster }}" width="44" height="44" radius="8"/>
      <vstack spacing="2">
        <text value="{{ item.title }}" fontWeight="semibold"/>
        <text value="{{ sizeLabel }}" fontSize="12" color="secondary"/>
      </vstack>
      <spacer/>
      <progress value="{{ item.progress }}" width="48" visible-if="item.state == 'downloading'"/>
      <button class="pill" label="{{ item.state == 'downloading' ? 'Pause' : 'Resume' }}"
              on:tap="dsx.action.toggle()"/>
      <button icon="trash" on:tap="dsx.variable.confirmingId = item.id"/>
    </hstack>
  </list>

  <confirmDialog present="dsx.variable.confirmingId != ''" title="{{ dsx.attribute.removeTitle }}"
                 on:confirm="dsx.action.confirmRemove()"
                 on:dismiss="dsx.variable.confirmingId = ''"/>
</vstack>
```

Reference implementations in-tree: `VerticalPlayerStack/Components/player/Player.dsx` (a full
screen), `Foundation/Components/Core/Banner.dsx` (a small component),
`VerticalPlayerStack/Components/player/Episodes.dsx` (a fragment sharing its parent surface's
store). Style guidance: [`Skills/dsx-best-practices.md`](../../Skills/dsx-best-practices.md).
