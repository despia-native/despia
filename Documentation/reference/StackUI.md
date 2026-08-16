# Stack — native declarative UI for DespiaScript (`dsx.stack`)

> **This is the guide** (concepts + worked examples). For the exhaustive
> dictionary — every tag, attribute, value, unit, and default, for building
> pixel-perfect — see **[`StackReference.md`](StackReference.md)**. For widgets /
> Live Activities, **[`StackWidgets.md`](StackWidgets.md)**.

Stack lets a module write its **view as an XML string** and its **logic/state in
native `dsx` code**, then mount it. It is a **core capability of DespiaScript** —
it extends `Context`, it is **not** a module and has **no scheme**. Every module
gets it for free as `dsx.stack.*`.

Everything Stack renders is **native** (SwiftUI on iOS, mirrored to Compose on
Android). There is **no JS engine and no bridge on the hot path**, so a Stack
surface **cannot be frozen by the web view** — it keeps animating, updating, and
responding in the background, during PiP, and even while the page's JS is hung.
(Why: the web view's JS runs in a separate Web Content process; Stack runs in the
app process. See "Freeze-proofing" below.)

The UI lives in a **file** — `Components/Player.dsx` in your module:

```xml
<vstack style="sheet">
  <text style="heading">{{ dsx.variable.title }}</text>

  <hstack spacing="44">
    <transport icon="gobackward.5" on:tap="dsx.module.player.skip({ by: -5 })"/>
    <glassButton icon="{{ dsx.variable.playing ? 'pause.fill' : 'play.fill' }}"
                 on:tap="dsx.event('toggle')"/>
    <transport icon="goforward.5" on:tap="dsx.module.player.skip({ by: 5 })"/>
  </hstack>

  <list bind="dsx.variable.episodes" key="id" spacing="8">
    <row style="card">
      <text bind="item.title"/>
      <glassButton color="{{ item.liked ? 'accent' : 'white' }}"
                   on:tap="dsx.event('like')" arg:id="{{ item.id }}"/>
    </row>
  </list>
</vstack>
```

…and Swift **mounts the file** and wires facts/events — it never carries inline XML
(full guide: [`Skills/mounting-components.md`](../../Skills/mounting-components.md)):

```swift
final class Player: Module {
    override class var scheme: String { "player" }

    override func setup() {
        dsx.action("start") { dsx in
            let ui = dsx.component.mount(.player.Player)   // GENERATED ref — autocompleted, compile-checked

            ui.variable("title", "Episodes")               // ⇄ dsx.variable.title
              .variable("playing", false)
            ui.list("episodes").set(episodes)
            ui.on("toggle") { /* native: toggle AVPlayer */ }
            ui.on("like") { p in /* native: like episode p["id"] (call your backend here) */ }

            present(ui.controller)                 // a module presents the surface
            dsx.resolve(JSON(["presented": true])) // …still your dsx — mix UI with the rest
        }
    }
}
```

---

## Mental model

- **XML = structure + declarative bindings.** The markup itself is declarative — the
  dynamic parts are bindings (`{{ … }}`, `bind`, `visible-if`) and actions (`on:tap=…`).
  Imperative logic — branch, `for` / `while` loops, `try`/`catch` — lives in **action
  bodies** (JSE, bounded) and native `dsx`, not in the tag structure.
- **Native `dsx` code = logic + state + data.** You push data into a reactive
  store and register event handlers; SwiftUI's own reconciler does the minimal
  patching. You never re-render by hand.
- **Escape hatch = `native:<name>`.** Anything the catalog can't express (maps,
  charts, one-off native views) is a real native view you register and mount by
  tag (`<usageChart/>`). See "The native registry". (Video needs no escape hatch —
  `<video>` is a first-party tag.)

---

## `dsx.stack` API

| Call | Returns | Purpose |
|---|---|---|
| **`dsx.component.mount(.Player)`** | `StackSurface` | **THE way to mount UI** — essentially *present a FILE*: the component is a `.dsx` file in the module's `Components/` folder (baked at build time), and every `<Tag>` inside resolves from folders too (module-local → global). The leading-dot refs (`.Player` global · `.verticalplayer.Episodes` module-scoped) are **generated from the `.dsx` files** — autocompleted, and a misspelling is a **compile error**. The String form (`"dsx.module.self.Player"` ≡ JSE `dsx.module.self`) is the dynamic, refactor-agnostic spelling for references that arrive as data. (`dsx.module` itself is the CALL root — `dsx.module.scheme.method(args)`.) The returned `ui` is the full surface: `ui.on` / `ui.action` / `ui.variable` / `ui.attribute`. Native code never carries inline XML. |
| `dsx.component.mount(ref, as: .overlay(.bottom))` | `StackSurface` | Same component, mounted **over the web view** with passthrough touches (glass nav/tab bars). `as: .screen` (default) = a full **page** you present (`.controller`); bottom sheets stay declarative (`<sheet>` inside the component, or `surface.sheet`). |
| `dsx.stack.render(xml)` | `StackSurface` | **Escape hatch**: parse raw XML → a reactive surface (same `as:` mounts). Reach for it only when the markup isn't a registered component. |
| `dsx.stack.register(name) { attributes in AnyView }` | — | Register a **`native:<name>`** component (a real native view). |
| `dsx.stack.component(name, xml:, global:)` | — | Register a reusable **DSX component** (`<Name/>`). `global:false` (default) = folder-scoped. |

**One entry point, two mounts.** Component or raw XML, `render(…, as:)` always returns a
`StackSurface`. `as: .screen` (default) → present `.controller` (a native screen
that owns the display). `as: .overlay(edge)` → mount it as a sibling above the
web view with passthrough hit-testing — only real controls capture touches, the
page stays live behind it (`edge`: `.bottom/.top/.leading/.trailing` size to
content, `.fill` covers the web view). Same reactive API either way.

### Surface (`StackSurface`) — reactive API

The native trio mirrors the JSE `$` namespaces 1:1 — what markup reads as `dsx.variable.x` /
`dsx.action.name()` / `dsx.attribute.x`, native writes/calls as:

```swift
// ── the canonical trio (⇄ dsx.variable / dsx.action / dsx.attribute) ──
ui.variable("playing", true)                             // write a surface variable (chainable) — markup reads {{ dsx.variable.playing }}
ui.action("track", ["event": "like"])                    // run a markup <action as="track">, dsx.this = payload — native→DSX (the inverse of ui.on)
ui.attribute("accent", "#FF2D55")                        // set a root-level ATTRIBUTE — markup reads {{ dsx.attribute.accent }} (runtime value beats <attribute default>)

ui.set("title", "Episode 3")                             // alias of variable() (legacy); re-patches only bound elements
ui.set("barOffset", 0, animated: true)                   // animated set (tweens bound styles)
ui.animate(.spring) { ui.set("menuOpen", true) }         // batch mutations in one animation
ui.on("toggle") { … }                                    // DSX→native: wire dsx.event('toggle') / dsx.send
ui.onAny { name, payload in … }                          // WILDCARD tap: every dsx.event/component event — analytics/relay in ONE block (forward via dsx.event/dsx.broadcast)
ui.list("episodes").set(rows)                            // keyed list data
ui.list("episodes").insert(row, at: 0)                   // …insert / remove(id:) / replace(id:,with:)
ui.list("episodes").update(id: 5) { $0["liked"] = true } // patch ONE row in place
ui.node("#like").set("color", "accent")                  // imperative escape, by element id
ui.node("#bar").set("offsetY", "0", animated: true)      // animated node patch
ui.present(from: vc, animated: false)                    // present .overFullScreen (page below)
ui.sheet("<Episodes/>", from: vc, detents: [.half, .full])  // native drag-to-resize bottom sheet
ui.remove()                                              // tear down an overlay surface
```

**Writes de-dupe.** Setting a key to an equal value is a **no-op** — no re-render
(deep equality over strings/numbers/bools/arrays/dicts). Re-asserting state on
every tap (`controls = true`), re-publishing an unchanged measure dict, or
re-seeding the same rows costs nothing; only real changes redraw.

**Writes are main-thread (and self-healing).** The store drives SwiftUI, so
`ui.set` / `ui.variable` / `ui.action` / `ui.node` belong on the main thread —
call completions from a bare `Task { }` land on the cooperative pool, and an
off-main `@Published` write corrupts the AttributeGraph (crashing *later*, at the
next dismissal or sheet). The surface **re-dispatches stray background calls to
main** so they're safe — but hop your completions to the main actor yourself
(`await MainActor.run { … }`) so your own module state stays race-free too.

**Declarative back-swipe.** Put `dismissEdge="left"` on a presented surface's ROOT element and
the engine installs the iOS edge-swipe: 1:1 finger follow, dismiss past ⅓ width (or a fast
fling), spring-back otherwise. On dismissal it runs the root's `on:edgeDismiss` action
(e.g. `"dsx.event('close')"`); without one it just dismisses. Pairs with `enter="slide-right"`.

**Declarative exit.** `exit="slide-right"` on the root (same vocabulary as `enter=`) makes
`ui.dismiss(animated:)` slide the page back out instead of a plain modal dismiss —
`enter="slide-right" exit="slide-right" dismissEdge="left"` is the complete iOS
push / pop / back-swipe trio. The edge swipe already moves the view off-screen, so on that
path the exit completes instantly; a button-driven `dsx.event('close')` gets the full slide.

**Native bottom sheets (`ui.sheet`).** For drawers that should drag-to-resize,
snap between detents, and swipe-to-dismiss like a real bottom sheet, present a
sub-template (usually a single component tag) as a native sheet — it **shares
this surface's store/env**, so state, lists and `dsx.send`/`dsx.event` stay live:

```swift
ui.list("episodes").set(rows)
sheetVC = ui.sheet("<Episodes/>", from: controller,
                   detents: [.half, .full]) {      // onDismiss: interactive (swipe) only
    self.episodesDismissed()                       // a programmatic dismiss(animated:) does NOT fire this
}
```

`detents`: `.content` (wraps the content's natural height — for a compact picker),
`.half`, and `.full` — the stops that map 1:1 on every platform (iOS custom /
`.medium()` / `.large()`; Android `ModalBottomSheet` wrap / PartiallyExpanded /
Expanded, or `skipPartiallyExpanded` for `[.full]`). Pass `[.half, .full]` to drag
between two stops, `[.content]` to pin a sheet to its content (Speed picker), or
one stop to pin it. (`.content` measures on iOS 16+, falls back to `.half` on 15.) The sheet shows a
grabber, rounds its corners, and (with a `scroll`/`list`/`grid` inside) expands to
the next stop when you scroll up at the top — so the drawer's content is just the
component, no backdrop or manual sheet chrome. The vertical player presents
Episodes / Speed / Paywall / Recommendations exactly this way.

> **Cross-platform rule:** the sheet API stays at the half/full vocabulary on
> purpose — arbitrary fraction/peek detents are easy on iOS but don't map cleanly
> to Compose's `ModalBottomSheet`, so they're intentionally not exposed.

**Page transitions reuse the animation engine.** Present `.overFullScreen` with
`animated: false` (so the web view shows behind) and give the **root** an `enter=`
animation — it plays on appear (HTML `@starting-style`) with the same
`slide-*`/`fade`/`scale` + `anim` names as element animations:

```xml
<vstack enter="slide-right" anim="spring"> … whole page … </vstack>
```

So pages and elements share one animation vocabulary — no separate presentation
system. The entry is **layout-stable**: the page is at its final, full-bleed layout
from frame one (safe areas, `ignoreSafeArea`, measurements all resolved) and slides
in via pure offset — it never re-lays out when the animation settles.

All of the above are **in-process Swift calls — no bridge, no JS.** They work in
the background / PiP and can't be stalled by the web view.

---

## Component catalog (XML tags)

### Layout
| Tag | Notes |
|---|---|
| `vstack` / `hstack` / `zstack` | Stacks. `spacing="…"` and `align="…"` (see below). |
| `scroll` | `ScrollView` (scrollbars hidden). `axis="horizontal"` for a horizontal rail. |
| `spacer` | Flexible space — pushes/distributes along the stack's axis. |
| `divider` | Hairline rule. |
| `pager` | Swipeable full-bleed pages (`TabView` `.page`); each child is one page, or data-bound rows via `bind`+`key`. `axis="vertical"` for TikTok-style paging, `value="dsx.variable.index"` two-way current page, `ignoreSafeArea="true"` for full-bleed feeds, `dots="false"` hides the index, `on:change`. |
| `tabs` | Bottom tab bar; each child pane sets `tabTitle` / `tabIcon`. |
| `scaffold` | Custom body + safe-area **sticky** bars by default. Opt in with `shell="automatic"`; direct children use `pane="sidebar|content|inspector"` and adapt across iPad/iOS, Android, Web, macOS, Windows, and Linux while `pin="top|bottom"` bars remain global. `collapse="platform|stack|content|none"` and `compactAt` control compact behavior. See [Adaptive large-screen shells](../guides/adaptive-native-shells.md). |
| `grid` | N-column grid over the same keyed row model as `<list>`: `bind`+`key`, `columns`, `spacing`, `scroll="false"` to size-to-content (sheets), `on:reachEnd` for pagination. |
| `refreshable` | Pull-to-refresh wrapper (it owns the ScrollView — put `<list scroll="false">` inside): `on:refresh` runs the action; `busy="feed.loading"` holds the spinner until the real load ends. |
| `sheet` | Declarative native modal: `present="dsx.variable.show"` (two-way Bool), `detents="content,half,full"` (`content` = **fit-content for any markup** — the sheet hugs the slot's ideal height, capped at 90%, taller content scrolls), `mode="sheet|card|cover"`, `inset`, `on:dismiss`. |
| `video` | Declarative state-driven video (AVPlayer / ExoPlayer): `src`/`active`/`autoplay`/`loop`/`muted`/`gravity`/`speed`, two-way `paused` + `bind` (position 0–1), `time`/`duration`/`buffering` readouts, `scrubbing`+`preview` for custom scrubbers, `audio="playback"`, `pip`, `nowPlaying` lock-screen transport (`on:remoteNext`/`on:remotePrev`). Full contract in [StackReference](StackReference.md#elements). |

**Alignment & distribution — the #1 layout gotcha.**
A `vstack` lays children top→bottom and is **leading-aligned by default** (the
cross-platform default — Compose `Column`, CSS flex, web blocks all start leading);
an `hstack` lays them left→right, centered on the cross axis. Like SwiftUI/Compose,
`align` is **pure alignment** — it positions children but does NOT make the stack
fill. A `vstack align="center"` *hugs its content* and centers its children
relative to each other (e.g. a caption under an icon).

- **Center children within the stack:** `align=` (the cross-axis alignment).
  - `vstack align="leading|center|trailing"` (default `leading`)
  - `hstack align="center|top|bottom"` (default `center`)
  - `zstack align="center|top|bottom|leading|trailing|topLeading|…|bottomTrailing"` (default `center`)
- **Center a *section* across the screen (e.g. a header):** make it fill the width
  **and** center — `grow` + `align` compose: `<vstack grow="width" align="center">`.
  (`grow="width"` fills the cross axis; `align="center"` centers the content in it.)
  Keep them orthogonal: a `grow="width" align="center"` header fills+centers, while a
  bare `align="center"` icon+caption hugs+centers — both are needed, so the engine
  doesn't conflate them.
- **Distribute along the axis:** use `spacer`. One trailing `spacer` pushes content to the top; a `spacer` on each side centers; `spacer` between two items pushes them apart.
- **Fill the screen:** a stack with a `spacer` (or a full-width child) expands on that axis; the root surface already fills.
- **Sizing is a trio — hug / grow / fit.** Default = *hug* (size to content — but a
  greedy child like a `<scroll>`/`<list>`, a `spacer`, or `grow="true"` leaks through
  and expands the box). `grow` = fill the offered space. **`width="fit"` /
  `height="fit"`** = *force-hug*: the content's ideal size, greedy children collapse —
  CSS `fit-content`. Sheets use it automatically (`detents="content"` hugs any markup);
  reach for it yourself on panels/chips wrapping something greedy. Full semantics:
  [StackReference → Fit-content](StackReference.md#fit-content).
- **Float one element over others (don't put it in the column):** make it its own `zstack` layer. e.g. a right-edge, vertically-centered rail: `<hstack><spacer/><Rail/></hstack>` as a `zstack` child — the spacer pushes it right, the zstack centers it vertically.

```xml
<!-- player chrome: top bar pinned top, controls centered, scrubber pinned bottom -->
<zstack>
  <feed/>
  <vstack align="center">           <!-- ← centers the transport row; no spacer hacks -->
    <TopBar/>
    <spacer/>
    <Transport/>
    <spacer/>
    <Scrubber/>
  </vstack>
  <hstack><spacer/><Rail/></hstack>  <!-- floats right, vertically centered -->
</zstack>
```

### Content
| Tag | Key attributes |
|---|---|
| `text` / `label` | `value="…"` or `bind="key"` or inline text; `color fontSize fontWeight`. `markdown="true"` for inline **bold**/_italic_/links. |
| `image` | `icon="sf.symbol"` / `systemImage`, or `src="https://…"` (async, cached). |
| `button` / `transport` | `icon` or `label`; `iconSize`, `color`; `on:tap`. |
| `glassButton` | Same as `button` (reserved for the glass treatment). |
| `pressable` / `row` | Tappable container around children; `on:tap`. `row` is the `<list>` row template. |
| `progress` / `capsuleProgress` | `bind`/`value` 0…1, `color`, `height`. |
| `spinner` / `activity` | Indeterminate `ProgressView`; `color`. |

### Reactive form inputs (two-way bound)
| Tag | Binds | Extra |
|---|---|---|
| `textfield` / `input` | `bind="dsx.variable.email"` (String) | `placeholder`, `secure="true"`, `color`. |
| `toggle` / `switch` | `bind="dsx.variable.enabled"` (Bool) | `color`. |
| `slider` | `bind="dsx.variable.volume"` (Number) | `min`, `max`, `color`. |
| `stepper` | `bind="dsx.variable.qty"` (Number) | `min`, `max`, `step`, `label`, `color`. |
| `picker` / `segmented` | `bind="dsx.variable.plan"` (String) | `options="A,B,C"` (CSV) or `optionsKey="list"` (+`labelField`/`valueField`); `picker`=menu, `segmented`=segmented control. |
| `datepicker` / `date` | `bind="dsx.variable.when"` (ISO-8601 String) | `mode="date|time|datetime"`, `label`, `color`. |
| `form` + `field` | `form.values.*` | Validated forms: `<form as="checkout" submit="Pay" on:submit="…">` wraps `<field name="email" validate="required,email"/>` rows — the platform tracks `form.valid` and per-field `touched`/`dirty`/`error`. See [StackReference](StackReference.md#elements). |

Inputs are **two-way**: typing updates the store var and `{{ dsx.variable.email }}` reads it
live. No `onChange` plumbing needed — bind and go (every input also fires
`on:change`, and `textfield` adds `on:submit` / `on:focus` / `on:blur` for the
moments state can't express).

```xml
<textfield bind="dsx.variable.email" placeholder="you@site.com"/>
<toggle bind="dsx.variable.notify"/>
<text>{{ dsx.variable.notify ? 'On' : 'Off' }}</text>
```

### Built-in components & accessibility

Foundation also ships **global components** — `<Card>` `<EmptyState/>`
`<Skeleton/>` `<NavBar/>` `<SettingsRow>` `<Table/>` `<VipCard/>` `<Drawer>` —
usable from any module, accessible by construction
([StackReference → Built-in components](StackReference.md#builtins)). And every
element takes the cross-platform **a11y attributes** (`a11yLabel` / `a11yHint` /
`a11yValue` / `a11yTrait` / `a11yHidden` / `a11yGroup`) that map 1:1 to SwiftUI
accessibility and Compose semantics — with free defaults: tappables announce as
buttons, unlabeled images are decorative
([StackReference → Accessibility](StackReference.md#accessibility)).

### List (keyed, diffed)
```xml
<list bind="dsx.variable.episodes" key="id" spacing="8">
  <row style="card">                 <!-- the row template; `item` = the row dict -->
    <text bind="item.title"/>
    <text bind="item.price" color="accent"/>
  </row>
</list>
```
`key` (default `id`) gives each row a stable identity, so `update/replace/remove`
patch the minimum. Inside a row, `item.*` is that row's data.

`axis="horizontal"` lays rows in a swipeable horizontal carousel; add
`autoscroll="N"` (points/sec) for a continuous looping **marquee**.

**`item` is a first-class, *writable* scope** — so editable and hierarchical
collections work natively, no flattening into the global store:

- **Edit a row in place:** any two-way input bound to `item.field` writes back to
  that row. `<toggle bind="item.done"/>` · `<textfield bind="item.name"/>` ·
  `<stepper bind="item.qty"/>` — the list re-renders with the patched row.
- **Nested / grouped data:** a row may contain `<list bind="item.children">`
  (sections, trees) — and edits in the inner list propagate back up through the
  parent row. Nests arbitrarily.

```xml
<list bind="dsx.variable.sections" key="id">
  <vstack>
    <text bind="item.title" fontWeight="bold"/>
    <list bind="item.rows" key="id">         <!-- row-local nested list -->
      <hstack>
        <text bind="item.label"/>
        <spacer/>
        <toggle bind="item.on"/>             <!-- edits the nested row in place -->
      </hstack>
    </list>
  </vstack>
</list>
```

---

## Expression language

> The expression & logic engine is **JSE** — see [`jse.md`](jse.md). Every `{{ }}`, `visible-if`, and `on:*` body below is JSE.

Used in `{{ … }}` interpolation, `bind=`, `visible-if=`, and to evaluate the expressions
inside `on:` / `<action>` statements. A small, **safe** expression layer — **pure** (no
assignment, no loops, so it can never block the UI), but *with* **function calls** (built-ins,
methods, arrow callbacks — see the table). Statement control flow — `if` / `switch` / `for` /
`while` / `try`, all in action bodies — is the runner layered on top; see
[`jse.md`](jse.md). Recursive-descent, precedence low → high:

| Level | Operators | Notes |
|---|---|---|
| ternary | `cond ? a : b` | |
| logical or | `a \|\| b` | returns `a` if truthy, else `b` → **default values** (`{{ dsx.variable.name \|\| 'Guest' }}`). |
| logical and | `a && b` | returns `b` if `a` truthy, else `a`. |
| equality | `== !=` | numeric if both numbers, else string compare. |
| comparison | `< <= > >=` | numeric. |
| additive | `+ -` | `+` is numeric add **or string concat** (`{{ 'Ep ' + dsx.variable.n }}`). |
| multiplicative | `* /` | numeric. |
| unary | `!x` `-x` | |
| primary | `42` `'str'` `"str"` `true`/`false`/`null` `a.b.c` `( … )` `fn(…)` | |

**Functions** (pure, no side effects): `upper lower cap trim` (string), `len`/`count`,
`abs round floor ceil min max int`, `pad(n,width)` (zero-pad), `if(cond,a,b)`. e.g.
`{{ upper(dsx.variable.name) }}`, `{{ pad(dsx.variable.mins,2) }}:{{ pad(dsx.variable.secs,2) }}`, `{{ round(dsx.variable.price) }}`.

**Paths** resolve **locals first** (a component's attributes / list-row `item`), then the
shared store: `{{ title }}` is a prop when present, otherwise the store key. Use
`dsx.item.x` / `dsx.attribute.x` to be explicit.

```xml
<text>{{ dsx.variable.episode + 1 }}/{{ dsx.variable.total }}</text>
<button visible-if="dsx.variable.coins >= dsx.variable.price && !dsx.variable.locked" .../>
<image icon="{{ dsx.variable.liked ? 'heart.fill' : 'heart' }}"/>
```

`visible-if="has:scheme"` is special: true when a module with that scheme is
installed (feature-detect a module before offering its UI).

---

## Recipes — worked examples

**Settings form (two-way inputs).** Each control binds a store var; `{{ }}` reads it live.
```xml
<vstack spacing="16" padding="20">
  <hstack><text>Notifications</text><spacer/><toggle bind="dsx.variable.notify"/></hstack>
  <hstack><text>Quality</text><spacer/>
    <segmented bind="dsx.variable.quality" options="Low,Medium,High"/></hstack>
  <hstack><text>Copies</text><spacer/>
    <stepper bind="dsx.variable.copies" min="1" max="9"/></hstack>
  <slider bind="dsx.variable.volume" min="0" max="1"/>
  <text color="secondary">Notify {{ dsx.variable.notify ? 'on' : 'off' }} · {{ dsx.variable.quality }} · {{ dsx.variable.copies }}×</text>
</vstack>
```

**Editable + nested list** (`item` is a writable, recursive scope).
```xml
<list bind="dsx.variable.groups" key="id">
  <vstack spacing="6">
    <text bind="item.title" fontWeight="bold"/>
    <list bind="item.items" key="id">          <!-- row-local nested list -->
      <hstack>
        <text bind="item.label"/><spacer/>
        <toggle bind="item.done"/>              <!-- edits the nested row in place -->
      </hstack>
    </list>
  </vstack>
</list>
```

**Horizontal carousel + auto-scroll marquee.**
```xml
<list bind="dsx.variable.cards" axis="horizontal" autoscroll="24" spacing="12">
  <vstack width="240" radius="16" padding="16" background="fill">
    <text bind="item.title" fontWeight="bold"/>
    <text bind="item.body" color="secondary" lineLimit="3"/>
  </vstack>
</list>
```

**Sticky footer (safe-area aware).** The body scrolls; the CTA pins above the home
indicator on every device, and the content insets so nothing hides behind it.
```xml
<scaffold>
  <scroll>
    <vstack spacing="16" padding="20"> …long content… </vstack>
  </scroll>
  <vstack pin="bottom" padding="16" background="systemBackground" fullBleed="bottom">
    <button label="Subscribe" grow="width" radius="28" paddingV="16"
            gradient="{{ dsx.variable.accentGrad }}" on:tap="dsx.send('buy')"/>
  </vstack>
</scaffold>
```

**Paged onboarding + tab bar.**
```xml
<pager dots="true" height="420">
  <vstack align="center"><image icon="sparkles" iconSize="64" color="accent"/><text>Welcome</text></vstack>
  <vstack align="center"><image icon="bolt.fill"  iconSize="64" color="accent"/><text>Fast</text></vstack>
</pager>

<tabs>
  <vstack tabTitle="Home"     tabIcon="house.fill"> … </vstack>
  <vstack tabTitle="Settings" tabIcon="gearshape.fill"> … </vstack>
</tabs>
```

**Expression functions + markdown.**
```xml
<text>{{ pad(dsx.variable.mins,2) }}:{{ pad(dsx.variable.secs,2) }}</text>     <!-- 04:09 -->
<text>{{ upper(dsx.variable.tier) }} · {{ round(dsx.variable.price) }}</text>
<text markdown="true">Save **60%** today — [terms]({{ dsx.variable.termsUrl }})</text>
```

---

## Styling

```xml
<vstack style="sheet">                              <!-- named style(s), space-separated -->
  <text style="heading" color="white">Title</text>
  <vstack surface="glass" radius="20" padding="16"> <!-- liquid-glass blur -->
    …
  </vstack>
</vstack>
```

**Named styles** (compose, later attrs win): `sheet card heading subheading
rowTitle price`.

**Attributes** (on any element, via `StackStyle`):
`padding background radius surface fontSize fontWeight width height opacity
borderColor borderWidth shadow`.

**`surface` (native materials / liquid glass):** `glass`/`ultraThin`, `thin`,
`regular`, `thick`, or `sheet` (dark sheet default). These map to SwiftUI
`.ultraThinMaterial` & friends — the real iOS blur/vibrancy.

**Colors:** `white black accent clear`, `#RGB`/`#RRGGBB`/`#AARRGGBB`, or
`rgb()/rgba()`.

---

## Events, actions & lifecycle

Any element can carry hooks:

| Attribute | Fires |
|---|---|
| `on:tap` | tap — on **any** element (a `vstack` backdrop, a `text` pill, an `image`), not just `button`/`pressable`/`row`. Transparent/empty areas are made hit-testable (`contentShape`), so a `grow` backdrop or a spacer-padded cell still receives the tap. |
| `on:longpress` | long press. |
| `on:dragStart` / `on:drag` / `on:dragEnd` | the raw pointer lifecycle (press / move / release) on **any** element — build custom sliders, seek bars, swipe-to-dismiss, press-and-hold. `dsx.this` = `{ fraction, fractionY, x, y, width, height, dx, dy, phase }`; pair with `measure` (size → state) and the bindable transforms. **Full guide: [`Skills/custom-ux.md`](../../Skills/custom-ux.md).** |
| `on:appear` / `on:disappear` | element mounted / unmounted (e.g. load-on-show, start a refresh timer). |

The action string is one of these forms. Each carries a **payload** (see below);
the `dsx.event`/`dsx.broadcast`/`dsx.resolve`/`dsx.error` forms take a payload
object whose `{{ … }}` values are interpolated and coerced to bool / number / string:

| Action | Effect |
|---|---|
| `dsx.send('name')` | runs the **native** handler you registered with `ui.on("name") { payload in … }`. In-process, no URL — this is how a component talks to its own module. |
| `dsx.event('name')` | raises a **component event** to the host's `on:name=…` (see Components). |
| `scheme.path({ args })` | dispatches to **another module / the web bridge** (interpolated: `{ id: item.id }`). Reserve this for genuinely cross-module or external dispatch — not a component talking to its own native code. |
| `dsx.broadcast('name', data)` | out-of-band web event, fanned out to scheme subscribers. Always delivered, even after the call settled. |
| `dsx.resolve({ … })` | terminal success for the originating call (the **deferred-result** pattern). |
| `dsx.error('code', data)` | terminal failure. |
| `key = expr` | write a store var declaratively (toggle UI state — `menuOpen = !menuOpen`). |
| `animate: key = expr` | same, inside an animation (tweens bound styles; show/hide animates via the element's own `transition=`). |

`dsx.event('name')` is both the component event (to the host `on:name`) and the
web stream event on the originating call (the page's awaiting `onEvent`); when used
for the stream, the action that rendered the surface must **not** have resolved yet.

```xml
<button label="Save"     on:tap="dsx.send('save')"/>
<button label="Open map" on:tap="maps.open({ lat: dsx.variable.lat, lng: dsx.variable.lng })"/>
<vstack on:appear="dsx.send('refresh')"/>           <!-- run a native handler when shown -->
<button label="Pick"     on:tap="dsx.resolve({ choice: dsx.variable.id })"/>  <!-- resolve the JS promise -->
<button label="Cancel"   on:tap="dsx.error('cancelled')"/>
```

**Deferred result:** the action that renders the surface can leave the call
*pending* (don't call `dsx.resolve`), then a tap settles it. That's how a native
picker resolves the awaiting `await window.dsx.picker.choose()` in the page:

```swift
dsx.action("choose") { dsx in
    let ui = dsx.stack.render(pickerXML)   // do NOT dsx.resolve here
    present(ui.controller)                 // a tap's `dsx.resolve({ id: item.id })` ends the call
}
```
The surface holds the call's `dsx`, so `dsx.event(…)` / `dsx.resolve(…)` /
`dsx.error(…)` reach the right promise. For events that fire after the call settled
(e.g. taps on a long-lived overlay), use `dsx.broadcast(…)`.

### How components talk to each other (without exposing module actions)

A Stack screen is a tree of components driven by one native module. They need to
talk — a tapped grid cell has to tell the player "play episode 7", a paywall
button has to start a purchase. There are **three channels**, and picking the
right one keeps your module's public URL namespace clean.

| You want to… | Channel | Looks like |
|---|---|---|
| A leaf tells **its own native code** to do something | `dsx.send` → `ui.on` | `on:tap="dsx.send('goto')"` |
| A child tells **its host component** something happened (and the host decides what to do) | `dsx.event` → `on:<event>` | child: `dsx.event('close')` · host: `on:close="dsx.send('closeDrawer')"` |
| You're dispatching to **another module** or the **web bridge** | a module call | `on:tap="maps.open({ lat: dsx.variable.lat })"` |

The rule of thumb: **`dsx.send` and `dsx.event` are internal; a module call crosses
a boundary.** A component talking to the module that owns it is internal — it should
never have to name a `scheme.action`. Routing internal UI through `myscheme.…` works,
but it leaks UI plumbing (`goto`, `setspeed`, `unlock`) into the same public action
namespace the *web* dispatches into — anyone holding the page can now fire them.
Keep those as `ui.on` handlers reached by `dsx.send(…)`, and your public actions stay
the deliberate few you actually want to expose.

**Payloads.** `dsx.send(…)` and `dsx.event(…)` both carry a payload `[String: Any]`
to the handler. It is assembled automatically from two sources:

1. **The row `item`** — inside a `list`/`grid` row, the tapped row's data is the
   payload. `<vstack on:tap="dsx.send('goto')">` inside a `grid bind="episodes"` delivers
   that episode's full dict (`index`, `id`, `locked`, …) — no need to thread
   `?index={{ item.index }}` through a URL.
2. **`arg:*` attributes** — for static elements (not row-bound), add typed args
   right on the element. They're interpolated and coerced (bool / number / string):

```xml
<!-- row-bound: the whole item is the payload -->
<grid bind="dsx.variable.episodes" columns="5">
  <row><vstack on:tap="dsx.send('goto')"> … </vstack></row>   <!-- payload = { index, id, locked, … } -->
</grid>

<!-- static: declare the args inline -->
<text value="1.5×" on:tap="dsx.send('setspeed')" arg:rate="1.5"/>        <!-- payload = { rate: 1.5 } -->
<button label="Buy" on:tap="dsx.send('buy')" arg:product="vip.year"/>    <!-- payload = { product: "vip.year" } -->
```

```swift
ui.on("goto")     { p in self.goTo(p["index"] as? Int ?? 0) }       // item-driven
ui.on("setspeed") { p in self.setRate(Float(p["rate"] as? Double ?? 1)) }  // arg-driven
ui.on("buy")      { p in self.purchase(p["product"] as? String ?? "") }
```

`arg:*` and the row item merge (args win on key clash), so a row can override or
augment its item. The no-arg overload is still there when you don't need a payload:
`ui.on("close") { self.dismiss() }`.

**Events up, then in.** A reusable component shouldn't know the module's handler
names, so it raises a semantic event with `dsx.event(…)` and the **host** decides —
usually mapping it straight to a `dsx.send(…)`. The payload flows through unchanged:

```xml
<!-- Episodes.dsx (reusable): raises a semantic event, no module knowledge -->
<grid bind="dsx.variable.episodes" columns="5">
  <row><vstack on:tap="dsx.event('pick')"> … </vstack></row>
</grid>
```
```xml
<!-- host template: maps the component event to its own native handler -->
<Episodes on:pick="dsx.send('goto')" on:close="dsx.send('closeEpisodes')"/>
```
The leaf `dsx.event('pick')` carries the row item → the host's `on:pick="dsx.send('goto')"`
→ the module's `ui.on("goto") { p in … }`, all with the episode payload intact, and
`goto` was never a public `myscheme.goto` action.

> The vertical player is built exactly this way: `goto`, `select`, `setspeed`,
> `unlock`, `back`, `forward` are `ui.on` handlers reached via `dsx.send(…)` and are
> **not** in the `verticalplayer://` namespace; only `start`, `skip`, `buy`,
> `restore`, `getcoins`, `close` (the genuine public API) are module actions.

### State-machine pattern
There's no separate FSM DSL — the reactive store **is** the state. Keep a `state`
var, drive the view off it with `visible-if`/`{{ }}`, and transition in handlers:

```swift
ui.state("phase", "idle")                 // idle | loading | done | error
ui.on("start") { ui.set("phase", "loading"); load { ok in ui.set("phase", ok ? "done" : "error") } }
```
```xml
<spinner   visible-if="dsx.variable.phase == 'loading'"/>
<text      visible-if="dsx.variable.phase == 'error'" color="accent">Something went wrong</text>
<vstack    visible-if="dsx.variable.phase == 'done'"> … </vstack>
```

---

## Animations

The HTML mental model — *toggle a class, a transition property decides what tweens*
— maps cleanly: the **store var is the "class"**, a **`transition=` attribute is
the "transition property"**, and a store write (`x = …` / `ui.set`) is the toggle.

### Enter / leave (`transition=` on `visible-if`)
Any element that declares a transition animates whenever its `visible-if` flips —
no matter how the var changed (a tap, an event, a timer, a module). The element,
not the caller, owns its animation:

```xml
<MenuBar visible-if="dsx.variable.menuOpen"
         transition="slide-bottom"   <!-- slide-top|bottom|left|right · fade · scale -->
         anim="spring"               <!-- spring · easeInOut · easeIn · easeOut · linear -->
         animDuration="0.35"/>
```

### Toggle the state
Declaratively (no native code) with a store write, or from native / an event:

```xml
<button icon="line.3.horizontal" on:tap="dsx.variable.menuOpen = !dsx.variable.menuOpen"/>
```
```swift
bar.set("menuOpen", true)            // event/dsx-driven — still animates (MenuBar owns the transition)
```

### Tween a value (offset / opacity / size / color)
Bind an animatable style to a var and change it inside an animation. Style values
interpolate `{{ … }}`, so any style can bind:

```xml
<NavBar offset="{{ dsx.variable.navOffset }}" opacity="{{ dsx.variable.navFaded ? 0.4 : 1 }}"/>
```
```xml
<button on:tap="animate: dsx.variable.navOffset = 0"/>           <!-- declarative animated tween -->
```
```swift
ui.animate(.spring) { ui.set("navOffset", 0) }       // or from code
ui.node("#bar").set("offsetY", "0", animated: true)  // or imperatively, by id
```

A plain store write (`x = …` / `ui.set`) snaps; `animate:` / `ui.animate` /
`ui.set(animated:)` tween. Enter/leave always uses the element's own `transition=` curve. Curves:
`spring · easeInOut · easeIn · easeOut · linear` (+ `animDuration` seconds).

---

## Components (attributes / events / slots)

Capitalized tags are reusable components. Register one and use it by tag:

```swift
dsx.stack.component("PlanRow", xml: """
  <pressable style="card" on:tap="dsx.event('select')">
    <text bind="dsx.attribute.title"/><text bind="dsx.attribute.price" color="accent"/>
  </pressable>
""")
```
```xml
<PlanRow title="Weekly" price="$9.99" on:select="dsx.send('buyWeekly')"/>
```

- **Attributes down** — the tag's attributes become the component's local data
  (`{{ dsx.attribute.title }}`, `bind="dsx.attribute.title"`). Interpolated against the caller's scope first.
- **Events up** — the component raises `dsx.event('select')`; the host's `on:select`
  maps it to a `dsx.send(…)` or a module call. This keeps components reusable (they
  don't know the host's handler names).
- **Shared state is the sync backbone** — components read the same store, so
  `visible-if="dsx.variable.plan == dsx.attribute.planId"` mixes a shared `dsx.variable.plan` with an attribute `dsx.attribute.planId`.

### Components-in-components & slots
Components compose (a component's template can use other components), and a
component renders the children its caller passes via **slots** (React-style):

```swift
dsx.stack.component("Card", xml: """
  <vstack style="card" spacing="8">
    <text bind="dsx.attribute.title" fontWeight="semibold"/>
    <slot/>                       <!-- default slot: caller's children -->
    <slot name="footer"/>         <!-- named slot -->
  </vstack>
""", global: true)
```
```xml
<Card title="Episodes">
  <PlanRow title="Weekly" price="$9.99" on:select="dsx.send('buy')"/>  <!-- default slot -->
  <text slot="footer">Cancel anytime</text>                     <!-- named slot -->
</Card>
```
Slotted children render in the **caller's** data scope (their bindings resolve
where `<Card>` was used), placed where the component puts `<slot/>`.

### Folder auto-registration (the `Components/` convention)
Drop an XML file in a module's **`Components/` folder** and it auto-registers as
a component — **no `dsx.stack.component(...)` call**:

```
DSX/Modules/Custom/MyPackage/
  MyModule.swift
  dsx.json               ← "scheme": "mypackage"
  Components/
    Paywall.dsx          ← <Paywall/> usable in MyPackage's templates
    rows/PlanRow.dsx     ← <PlanRow/> — subfolders are just organization
    paywall/coins/Pack.dsx  ← <Pack/> — nest to any depth
```

- The component **name is the file name** (`Paywall.dsx` → `<Paywall/>`).
- **Nest to any depth for organization.** Subfolders under `Components/` are
  org-only — they do *not* namespace or change how a component loads; the name is
  always just the file name (so `Card.dsx` is `<Card/>` wherever it sits, and two
  files named the same in one module collide — rename one).
- It is **scoped to that module's scheme** (folder-local: only this module's
  templates can use it; resolution is module-local first, then global).
- Build-time codegen (`ClosedSource/scripts/prepare_config.rb`) inlines each `Components/*.dsx`
  into `Registry/StackComponents.generated.swift` carrying its owning scheme, so
  the XML is *build input* (not a copied bundle resource) — two modules can both
  ship `Components/Card.dsx` without colliding, and the table loads once before
  any render. An explicit `dsx.stack.component(...)` still wins for its scope.

For globally-shared components, either put them in a core module and use
`global: true`, or register them in code. Resolution: **module-local first, then
global**, so a module can override a shared component.

---

## The native registry — `native:<name>` (escape hatch)

This is how Stack stays small **without** capping what you can build. Anything the
XML catalog can't express — `AVPlayerLayer`, `MKMapView`, a Metal view, a custom
`UIPanGestureRecognizer`, a charting view — stays **fully native**, and the XML
just *mounts* it. The hard native code keeps full SwiftUI / UIKit / AVFoundation
access **and** the module's `dsx`; the surrounding chrome stays declarative XML.

```swift
// In the module's setup(): register a real native view by name.
dsx.stack.register("feed") { [weak self] attributes in
    guard let self else { return AnyView(Color.black) }
    return AnyView(VPFeed(player: self.player,                 // AVPlayerLayer
                          onNext: { self.go(+1) },             // swipe paging
                          onPrev: { self.go(-1) }))
}
```
```xml
<zstack>
  <feed/>                 <!-- the real video + gestures, native -->
  <vstack>                              <!-- the chrome, declared in XML -->
    <text bind="dsx.variable.title"/>
    <capsuleProgress bind="dsx.variable.progress"/>
  </vstack>
</zstack>
```

- The closure gets the element's **attributes** (e.g. `<native
  name="map" zoom="12"/>` → `attributes["zoom"]`), so one registered view is
  configurable from XML.
- Return any `AnyView` — a `UIViewRepresentable` (the `VPFeed`
  `AVPlayerLayer` + pan-gesture case), a bespoke SwiftUI view, whatever.
- It runs in the **app process** like the rest of the surface, so it's
  freeze-proof too. Hard native stuff (player layer, gestures) lives here; the
  rest of the UI stays declarative.

This pattern — **declarative XML for the 90%, a typed native view for the 10%** —
is the intended way to build advanced surfaces. The vertical player
(`DSX/Modules/Custom/VerticalPlayerStack`) is the worked example.

### Icons (cross-platform)

`icon="…"` is a **semantic token**, not a platform glyph — so `<button icon="bell"/>`
is identical XML on both platforms. The only way to make one token resolve 1:1 is
to back it with **a single icon set that ships the same names on iOS *and*
Android** — *not* SF Symbols (iOS-only, so Android would need a brittle name-map).

**Recommended:** standardize on one open, dual-platform set —

| Set | iOS | Android | Notes |
|---|---|---|---|
| **Lucide** | `LucideIcons` (SPM) | `lucide-icons` / Compose | MIT, 1500+, identical names (`bell`, `chevron-left`) — great default |
| **Material Symbols** | SPM / font | native (`Icons.*`) | free, huge; Android is first-class |
| **Phosphor** | `phosphor-swift` | `phosphor-android` / Compose | MIT, consistent names + weights |

Pick one, bundle it on both platforms, and the renderer resolves `icon="bell"`
against *that* set — so the name is the contract and there is **no** `icon=123` on
iOS / `icon=456` on Android divergence. SF Symbols can stay an **iOS-only fast
path** for names that exist there, but the canonical cross-platform vocabulary is
the shared set.

```xml
<button icon="chevron-left" iconSize="18"/>   <!-- same name → Lucide glyph on iOS & Android -->
```

**Brand / one-off glyphs** that aren't in the set use the native escape hatch —
register a `native:<name>` **with the same token on both platforms** and reference
it identically:

```swift
dsx.stack.register("brandLogo") { _ in AnyView(Image("BrandLogo").renderingMode(.template)) }   // iOS
```
```kotlin
stack.register("brandLogo") { Image(painterResource(R.drawable.brand_logo), null) }             // Android
```
```xml
<brandLogo color="accent"/>     <!-- identical markup, native asset per platform -->
```

So the contract is: **one shared icon set resolved by name (no per-platform map),
and a symmetric `native:` token for anything custom.**

### Platform differences (the escape hatch)

Stack's promise is *one markup renders 1:1 on both platforms*, so divergence is the
exception. When you do hit a genuinely platform-only thing (an iOS "Add to Siri"
row, an Android back affordance), the sanctioned escape hatch is **visibility**,
not per-attribute overrides — exactly like `Platform.select` (RN), `expect/actual`
(Compose), `Platform.isIOS` (Flutter), but expressed with the `visible-if` you
already have. The reserved `os` (alias `platform`) resolves to `"ios"` / `"android"`:

```xml
<!-- whole element, one platform only -->
<SiriShortcut visible-if="os == 'ios'"/>
<PredictiveBack visible-if="os == 'android'"/>

<!-- two variants in the same slot -->
<button label="Share"  icon="square.and.arrow.up" visible-if="os == 'ios'"     on:tap="dsx.send('share')"/>
<button label="Send"   icon="send"                visible-if="os == 'android'" on:tap="dsx.send('share')"/>

<!-- composes with normal state, no special syntax -->
<TipsButton visible-if="os == 'ios' && !dsx.variable.premium"/>
```

A platform-only **native** feature pairs this with the registry — register the view
*only* on the platform that has it, and gate the tag so the other renderer never
asks for it:

```swift
dsx.stack.register("siriShortcut") { _ in AnyView(AddToSiriView()) }   // iOS only — Android simply doesn't register it
```
```xml
<siriShortcut visible-if="os == 'ios'"/>
```

**Small, single-attribute tweaks** don't need a whole duplicated element — suffix
the *key* with `:ios` / `:android` and that value wins on that platform (the other
is dropped). It composes with `on:` / `arg:`:

```xml
<button icon="bell" icon:android="notifications" on:tap="dsx.send('alerts')"/>   <!-- one button, right glyph each -->
<text value:ios="Add to Siri" value:android="Quick action"/>
```

Guidance: reach for all of this **sparingly** — prefer shared tokens (icons),
shared components, and shared state. Use `os ==` for whole-element divergence,
`key:ios`/`key:android` for a one-off attribute. Note the override **suffixes the
key**, never packs the value: `icon="ios:… android:…"` is *not* supported because
it breaks on URLs, `rgba(…)`, and text with spaces.

---

## Overlays over the web view (glass nav/tab bars, passthrough)

`dsx.stack.overlay(xml, edge:)` mounts a Stack surface as a **sibling above the
web view** (not a modal) with **passthrough hit-testing**: only real native
controls in the XML capture touches — taps on transparent areas fall straight
through to the page, which stays scrollable and clickable. This is how you float a
native liquid-glass nav/tab bar over web content.

```swift
let bar = dsx.stack.overlay("""
  <hstack surface="glass" radius="28" padding="14" spacing="28">
    <button icon="house.fill"            on:tap="app.home()"/>
    <button icon="magnifyingglass"       on:tap="app.search()"/>
    <button icon="bell"     id="bell"    on:tap="dsx.send('openNotifs')"/>
    <button icon="person.crop.circle"    on:tap="app.profile()"/>
  </hstack>
""", edge: .bottom)

bar?.on("openNotifs") { /* native */ }
bar?.node("#bell").set("color", "accent")    // live badge/tint
// later: bar?.remove()
```

- `edge`: `.bottom` (default) / `.top` / `.leading` / `.trailing` size to content
  and pin to the safe-area edge; `.fill` covers the whole web view (use with the
  passthrough so only your controls are hit).
- Same reactive API as a surface (`state/set/on/node/list`).
- **How passthrough works:** the container is a `PassthroughView` whose
  `point(inside:)` is true only where a subview *deeper* than the bare hosting
  view claims the point. Empty/transparent regions report "not inside", so UIKit
  forwards the touch to the web view sibling below — while the glass bar's buttons
  work normally.

---

## Freeze-proofing (why native, not JS)

`WKWebView` runs page JS in a **separate Web Content process**. Stack runs in the
**app process**. So if the page's JS hangs (a heavy loop, a bad `await`, a memory
spike), the Web Content process stalls — but the app process, and therefore every
Stack surface/overlay, keeps running: animations continue, `ui.set(…)` still
patches, taps still fire, PiP keeps going. A JS-authored surface would go *stale*
(its driver is the hung process); a native-driven Stack surface does not.

The corollary: drive Stack from **native `dsx` code** (timers, delegates,
`dsx.action` handlers, `dsx.fetch`), not from web JS, for anything that must
survive a web-side hang.

---

## Widgets, lock-screen widgets & Live Activities

The same XML renders in widget extensions (WidgetKit / Glance) and Live
Activities / Dynamic Island via `StackWidgetKit` + the shared App Group
(`dsx.container`). See **`StackWidgets.md`** for the widget renderer, the
`dsx.container.group` data channel, and the cross-platform mapping.

---

## Cross-platform

The XML and the `dsx` API are platform-neutral by design. The same templates and
the same `dsx.stack.*` / store / handler semantics map to **Jetpack Compose**
(surfaces/overlays) and **Glance** (widgets) on Android, with `dsx.container`
backed by DataStore. Author once; each platform has a native renderer.

---

## Limitations & roadmap

What Stack is **not**: a Turing-complete language. The expression layer is
**total by design** — bounded operators + pure functions, no unbounded loops or
recursion — so it can never block the UI thread. Arbitrary computation lives in
the native module behind it (`dsx.send(…)` / a module call / `native:<name>`). For
expressing **UI**, every category is present, so it's *categorically complete*.

- **Layout / content:** stacks, `scroll` (vertical **and** `axis="horizontal"`),
  spacer/divider, `pager` (paged) + `tabs` (tab bar), `scaffold` (sticky,
  **safe-area-aware** bars via `pin="top|bottom"`), text (+`markdown`), image
  (SF Symbol / `src`), buttons, progress/spinner.
- **Lists (keyed, diffed):** `list`/`grid`, vertical or `axis="horizontal"` (+
  `autoscroll` **marquee**). **`item` is a first-class WRITABLE scope** —
  `<input bind="item.field">` edits a row in place, and `<list bind="item.children">`
  renders/edits nested data (sections, trees) to any depth.
- **Form inputs (two-way):** textfield, toggle, slider, **stepper**,
  **picker**/**segmented**, **datepicker**.
- **Expression language:** `|| && == != < <= > >= + - * /`, ternary, paths
  (locals-first), parens, string concat, and **functions** (`upper lower cap trim
  len abs round floor ceil min max int pad if`).
- **Styling:** bindable named styles, semantic adaptive colors
  (`label/secondary/fill/separator/…`), materials/glass, gradient,
  frame/opacity/border/shadow/radius/transforms.
- **Events / lifecycle:** `on:tap/longpress/appear/disappear` running JS actions
  (`dsx.send` / `dsx.event` / `dsx.broadcast` / `dsx.resolve` / `dsx.error`, module
  calls, store writes `x = …`, the reactive `fetch:` and `animate:` effect verbs);
  **animations** (`transition=`/`anim=`, store write / `animate:`, `ui.animate`).
- **Composition:** components with attributes/events/slots + folder auto-registration;
  presentation as `sheet` (detents) / `cover` (fullscreen) / `render(as:)`
  overlay; the `native:<name>` escape hatch; widgets / Live Activities.

- **Next (additive, not expressiveness gaps):** a full navigation stack, list
  section-headers / swipe actions, `on:change`, accessibility traits, and the
  Compose/Glance renderers reaching parity.
- Greenfield SwiftUI: expect log-driven iteration on the first device builds.

> **Location:** the engine lives in `OpenSource/Engine/iOS/` (`Stack.swift`,
> `StackWidgetKit.swift`) — it is **core DespiaScript**, accessible to every
> module via `dsx.stack.*`, not a special-cased subsystem. Open-sourced as part of the engine.
