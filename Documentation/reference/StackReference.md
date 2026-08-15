# Stack — Complete Reference

The exhaustive reference for Stack, DespiaScript's interface scripting language
(`dsx.stack`). Every tag, every attribute, every value, with types, units, and
defaults — so you can build a UI **pixel-perfect** against a design.

For a narrative walkthrough see **`StackUI.md`**; for widgets/Live Activities see
**`StackWidgets.md`**. This file is the dictionary.

**Conventions.** Lengths are in **points** (pt, iOS logical pixels). Numbers are
plain (`16`, `0.5`). Booleans are `"true"`/`"false"`. Colors and materials are
defined under [Colors](#colors) / [Materials](#materials). Any attribute value
may contain `{{ … }}` [interpolation](#expressions). Unknown attributes are
ignored.

---

## Table of contents
1. [Document shape](#document-shape)
2. [Universal attributes](#universal-attributes) (work on every element) · [Accessibility](#accessibility)
3. [Elements](#elements)
4. [Style attributes](#style-attributes)
5. [Named styles](#named-styles)
6. [Colors](#colors)
7. [Materials](#materials)
8. [Expressions](#expressions)
9. [Bindings](#bindings)
10. [Actions (`on:` syntax)](#actions) · [Screen readiness](#screen-readiness) · [Component ↔ native comms & payloads](#comms)
11. [State — variables, computed, formulas & actions](#state)
12. [Animations](#animations)
13. [Lists](#lists)
14. [Components](#components)
15. [`native:<name>` registry](#native-registry)
16. [Reactive API (Swift)](#reactive-api)
17. [Pixel-perfect checklist](#pixel-perfect)

---

## Document shape <a id="document-shape"></a>

A template is **one XML string with a single root element**. Tags are
lowercase built-ins or Capitalized [components](#components). Whitespace is
insignificant; text content of `<text>` is its label.

```xml
<vstack style="sheet" spacing="12">
  <text style="heading">{{ dsx.variable.title }}</text>
  <Row title="Hi"/>
</vstack>
```

Reserved XML characters must be escaped in attribute values and text:
`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`. (So `a && b` is written `a &amp;&amp; b`.)

---

## Universal attributes <a id="universal-attributes"></a>

These work on **any** element (in addition to each element's own attributes and
all [style attributes](#style-attributes)).

| Attribute | Type | Default | Effect |
|---|---|---|---|
| `id` | string | — | Stable id for imperative patches (`ui.node("#id")`). |
| `visible-if` | expr | shown | Show only when truthy. `has:scheme` = a module is installed. See [Bindings](#bindings). |
| `keep` | bool | `false` | Stay mounted when hidden and fade opacity instead of insert/remove (glass stays painted). See [Animations](#animations). |
| `transition` | enum | — | Enter/leave animation when `visible-if` flips. See [Animations](#animations). |
| `enter` | enum | — | Entry animation on first appear (incl. whole pages). Same names as `transition`. See [Animations](#animations). |
| `anim` | enum | `easeInOut` | Curve for `transition`/`enter`/keep. See [Animations](#animations). |
| `animDuration` | number(s) | curve default | Duration in seconds for `anim`. |
| `on:tap` | action | — | Tap handler (see [Actions](#actions)). On buttons/`pressable`/`row` it's the press; on any element it's a tap gesture. |
| `href` | string | — | **The anchor attribute** — declarative navigation to a route-table path: a tap runs `on:tap` first (if any), then navigates, exactly `dsx.module.route.push({ path: href })` on every renderer. `{{ }}` interpolates (`href="/orders/{{ item.id }}"`). On **web** the element renders as a real `<a href>` (crawlable link graph; cmd/middle-click and external/unmatched URLs keep the browser default; internal paths SPA-navigate through the same guards as any route). On native, a path the table doesn't match falls to the app's configured fallback (App.json `entry.fallback` — the web surface), so full URLs work too. |
| `on:longpress` | action | — | Long-press handler. |
| `on:hoverStart` / `on:hoverEnd` | action | — | The **pointer-hover lifecycle** on any element (desktop-platforms.md input grammar). Fires only under a REAL pointer — macOS/Windows/Linux, iPad pointer, desktop-web mouse (`(any-hover: hover)` plus a non-touch pointer), Android mouse/stylus. The pair is balanced across pointer cancellation and unmount. On a touch screen it simply **never fires** (degradation, never divergence — Article 7), so one markup serves both: `on:hoverStart="hovered = true" on:hoverEnd="hovered = false" style="opacity: {{ hovered ? 1 : 0.8 }}"`. Never gate *content* behind hover alone — a touch user must have another path to it. |
| `shortcut` | string | — | The **declared keyboard accelerator** for this element's tap (desktop-platforms.md input grammar): `shortcut="cmd+s"` — `cmd` is the PRIMARY modifier (⌘ on Apple, Ctrl elsewhere; the web matches either), `ctrl`/`alt`/`shift` literal, the last token is the key. Fires the element's `on:tap` while mounted; a match consumes the browser default; an unmodified shortcut never steals keys from a focused text field. Touch surfaces never fire it (Article 7). On native desktops, menu-borne accelerators ride the Menu module (M1) with real system menu-item semantics. |
| `focusOrder` | number | — | The **keyboard-focus traversal order** (desktop-platforms.md input grammar): the web maps it to `tabIndex` verbatim; native twins map to the platform focus engines (M1/D1). Declare it on interactive elements when document order isn't the right tab order; touch users lose nothing. |
| `on:drag` / `on:dragEnd` | action | — | Raw drag on any element — build a **custom** slider / seek bar / knob / swipeable (no system `Slider`). `dsx.this` = `{ fraction` (x/width, 0–1)`, fractionY, x, y, width, height, dx, dy, phase }`. Fires continuously (a tap seeks too); `on:dragEnd` on release. See [Bindings](#bindings). |
| `on:adjust` | action | — | The **VoiceOver / assistive adjustable action** for a custom `on:drag` control — a swipe-up/-down fires this with `dsx.this` = `{ direction: "increment" \| "decrement", phase: "adjust" }`, so a hand-built slider/seek bar/knob is operable without sight. Opt-in; pair with `a11yValue` so the new value is announced. See [Accessibility](#accessibility). |
| `measure` | state path | — | Write the element's live `{ width, height }` to state (`measure="dsx.variable.bar"`), so a custom fill/thumb can size against it: `width="{{ dsx.variable.pos * dsx.variable.bar.width }}"`. **This is the container-query primitive** (the CSS `@container` analogue): put `measure="dsx.variable.card"` on a container and its descendants adapt to the space *it* occupies — `columns="{{ dsx.variable.card.width > 360 ? 2 : 1 }}"` — independent of `dsx.screen.*` (the whole window). Cheap: writes only when the size changes. The **implicit** form is the `container` attribute below. |
| `container` | bool | — | Mark this element a **query container**: it publishes its live size to descendants as `dsx.element.width` / `dsx.element.height` — the CSS `@container` analogue, **implicit nearest-ancestor, no key**: `columns="{{ dsx.element.width > 360 ? 2 : 1 }}"`, `visible-if="dsx.element.width > 480"`. Reactive (re-flows as the container resizes). `measure=` is the explicit named-key alternative. |
| `on:appear` | action | — | Runs when the element mounts (load-on-show, start a timer). |
| `on:disappear` | action | — | Runs when the element unmounts. |
| `settle` | enum (`auto` \| `manual`) | `auto` | **Root only.** When this screen reports **readiness** to the shell. `auto` settles on the screen's first completed render pass; `manual` means *this screen settles itself* — it stays `loading` until it calls `dsx.screen.settled()`. Drives the unified `screen.loading`/`screen.ready` events and `dsx.screen.ready`/`dsx.screen.phase` (spinner, splash reveal, analytics). See [Screen readiness](#screen-readiness). |
| `<any>:<target>` | — | — | Per-platform override of any attribute — the full suffix vocabulary is `:ios :android :web :watch :wear :macos :windows :linux` (exact targets) plus the group words `:desktop` (= macos+windows+linux) and `:native` (= every non-web target). Precedence **exact > `:desktop` > `:native` > bare**, resolved once at parse/compile (the law: `OpenSource/Conformance/platform/platform.json`): `icon:android="notifications"` wins over `icon` on Android; `label:macos="Preferences…"` wins on the Mac; losing suffixes are dropped. For one-off tweaks; for whole-element divergence use `visible-if="os == 'ios'"` (`os` values: `ios · android · web · macos · windows · linux`). (Suffix the *key* — values are never packed `ios:…/android:…`.) |
| `a11yLabel` / `a11yHint` / `a11yValue` / `a11yTrait` / `a11yHidden` / `a11yGroup` | — | — | The cross-platform **accessibility contract** — see [Accessibility](#accessibility). |

---

## Accessibility <a id="accessibility"></a>

One small attribute set, on **any** element, that maps **1:1** to SwiftUI
accessibility and Compose semantics — write it once in DSX and every renderer
speaks it. Values interpolate (`a11yLabel="{{ item.title }}, {{ item.price }}"`).

**Two equal spellings per key** — the DSX one and the **web-standard aria one**
(first present wins, all three renderers). A web developer writes exactly what
they already know — `aria-label`, `aria-hidden`, `role` — and it compiles to
native iOS/Android accessibility; the web renderer emits the aria attributes
**verbatim** to the DOM.

| Attribute (DSX · aria) | What assistive tech gets | iOS (SwiftUI) | Android (Compose) |
|---|---|---|---|
| `a11yLabel` · `aria-label` | What's read aloud. | `.accessibilityLabel` | `semantics { contentDescription = … }` |
| `a11yHint` · `aria-description` | Supplemental, read after a pause ("Double-tap to open"). | `.accessibilityHint` | appended to the `contentDescription` (Compose has no separate hint slot) |
| `a11yValue` · `aria-valuetext` | The current value of a stateful element ("50 percent"). | `.accessibilityValue` | `semantics { stateDescription = … }` |
| `a11yTrait` · `role` | CSV roles: `button` / `header` / `image` / `link` / `selected` / `static`. | `.accessibilityAddTraits` | `Role.Button` · `heading()` · `Role.Image` · link annotation · `selected = true` · plain text |
| `a11yHidden="true"` · `aria-hidden="true"` | Invisible to assistive tech (decorative). | `.accessibilityHidden(true)` | `clearAndSetSemantics { }` |
| `a11yGroup="true"` · `role="group"` | Children **combine into one element** — a card/row reads as one utterance instead of five fragments. | `.accessibilityElement(children: .combine)` | `semantics(mergeDescendants = true)` |

**Free defaults — markup is accessible before you add anything:**

- Any element carrying **`on:tap`** announces as a **button** (override with an
  explicit `a11yTrait`). Real `<button>`/`<pressable>` controls are native buttons
  already, and the two-way inputs (`toggle`/`slider`/`textfield`/`picker`/`stepper`/
  `datepicker`) ride the platform controls' built-in semantics.
- An **`<image>` with no `a11yLabel` is decorative** — hidden from assistive tech
  (the HTML `alt=""` / Compose `contentDescription = null` convention; raw SF Symbol
  names read as junk). Label content images: `a11yLabel="Cover art for {{ item.title }}"`.
- `<Skeleton/>` placeholders are always hidden (announce loading on the container
  instead); the built-in components (`NavBar`, `SettingsRow`, `EmptyState`, `Table`)
  ship grouped + labeled out of the box — see [Built-in components](#builtins).

**The grouping rule of thumb:** any tappable row or card built from several texts
and icons should carry `a11yGroup="true"` on its content container — one swipe stop,
one clear utterance. (The `<list>` row template is the most common place.)

**Custom controls (`on:drag`) → add `on:adjust`:** a hand-built slider / seek bar / knob is invisible
to VoiceOver's swipe gestures, so give it `on:adjust` — the adjustable action fires with `dsx.this`
= `{ direction: "increment" | "decrement", phase: "adjust" }` and SwiftUI applies the `.adjustable`
trait automatically. Pair it with `a11yValue` so the new value is spoken. (Compose mirror:
`semantics { setProgress … }` / the same named `adjust` event.)

**Dynamic Type (opt-in).** `dynamicType="true"` scales a fixed `fontSize` with the user's
text-size setting, live (via `@ScaledMetric`, relative to `.body`); `dynamicTypeMax="N"`
caps the scaled points so an accessibility run can't blow out a fixed-height control. It's
opt-in so pixel-perfect screens are unaffected by default — set it per `<text>`, or once in a
`<style as=…>` applied with `class=` to scale a whole screen:

```xml
<text value="{{ title }}" fontSize="17" dynamicType="true" dynamicTypeMax="28"/>
<style as="body" fontSize="16" dynamicType="true"/>   <!-- then class="body" on every text -->
```

**Custom `on:drag` controls** (a hand-built scrubber/slider) get the VoiceOver adjustable action via
`on:adjust` (swipe-up/-down → `dsx.this.direction`); pair it with `a11yValue` so the value is announced.
A button alternative (the player's ±5s transport) is still a fine belt-and-suspenders pattern.

---

## Elements <a id="elements"></a>

> **Module-provided elements** (`<chart>`, `<map>`, `<qrcode>`, `<lottie>`, …)
> ship from their packages, not the kernel, so their full attribute lists live in
> the module source headers (`DSX/Modules/Core/<Name>/<Name>.swift`), not this
> table. Two data contracts are easy to get wrong because they differ from
> `<list>`'s `bind=`: **`<chart>` reads its rows from `data=`** (e.g.
> `data="dsx.variable.sales" x="month" y="revenue"`), and **`<map>` reads markers
> from a bound `pins=` array** — `pinLat`/`pinLon`/`pinTitle` name the *fields*
> inside each row, they are **not** literal coordinates.

### Layout

#### `stack`
The **generic CSS-driven container** — one element, flexbox decides the
concrete layout: `flex-direction: column` (the default when unset) renders
vertically, `row` horizontally, `display: grid` (v1: no tracks — the
single-cell overlap idiom) as a depth stack. Web-true defaults on this element
only: unset gap = `0` (never the platform default), cross alignment from CSS
`align-items` (`flex-start`/`center`/`flex-end`/`baseline`) with the legacy
`align` tokens as fallback. `row-gap`/`column-gap`/two-value `gap` are
axis-correct. v1: `*-reverse` renders as its base axis; `justify-content`
lands with the Taffy phase. See `guides/styling.md`.

```xml
<stack style="flex-direction: row; column-gap: 1rem; align-items: baseline">…</stack>
```

#### `vstack` / `hstack` / `zstack`
Stacks (SwiftUI `VStack`/`HStack`/`ZStack`) — the fixed-axis presets of `stack`.
First-party markup was fully converted to `<stack>` + CSS; these remain
supported for third-party/OTA markup and are REQUIRED on StackLive snapshot
surfaces (Live Activities/widgets), which have no CSS engine.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `spacing` | number(pt) | system | Gap between children (stacks only). CSS `gap`/`row-gap`/`column-gap` resolve onto this axis-correctly (hstack reads the column gap, vstack the row gap). |
| `align` | enum | see → | Cross-axis alignment (pure alignment — hugs content, like SwiftUI/Compose; to center a section across the screen compose `grow="width" align="center"`). **vstack:** `leading`(default)/`center`/`trailing`. **hstack:** `center`(default)/`top`/`bottom`. **zstack:** `center`(default)/`top`/`bottom`/`leading`/`trailing`/`topLeading`/`topTrailing`/`bottomLeading`/`bottomTrailing`. |

> A `vstack` is **leading-aligned** by default — a narrow child lands on the left.
> Use `align="center"` to center it. See [Pixel-perfect](#pixel-perfect).

#### `scroll`
Vertical `ScrollView`, scroll indicators hidden. Children scroll.

#### `spacer`
Flexible space; expands along the parent stack's axis to push/distribute.

#### `divider`
Hairline rule.

### Content

#### `text` / `label`
| Attribute | Type | Default | Notes |
|---|---|---|---|
| `value` | string | — | Static text (interpolated). |
| `bind` | expr | — | Bind to a store key/path; takes precedence over inline text. |
| *(text content)* | string | — | `<text>Hello</text>`. |
| `color` | color | `label` | Foreground color. Unstyled = the semantic `label` slot (adaptive — system-defaults). |
| `fontSize` | number(pt) | system | |
| `fontWeight` | enum | `regular` | `regular`/`medium`/`semibold`/`bold`/`heavy`. |

`markdown="true"` on `text` renders the **inline** vocabulary only — emphasis, strong,
code spans, strikethrough, links — because that is what SwiftUI's `Text` renders; block
constructs stay their literal run of characters on every runtime. For headings, lists,
tables and fenced code, use `markdown` below.

#### `markdown`
The **block** vocabulary: headings, paragraphs, lists (nested, ordered and unordered),
fenced code, blockquotes, tables, standalone images and horizontal rules. Inline content
inside a block goes through the same parser `text markdown="true"` uses, so emphasis,
code spans, links and the link allowlist have exactly one implementation.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `bind` | expr | — | Bind to a store key/path; takes precedence over `value` and inner text. |
| `value` | string | — | Static source (interpolated). |
| *(text content)* | string | — | `<markdown># Title</markdown>`. |

Raw HTML in the source is **text**, never markup: the renderer never reaches innerHTML,
so a README fetched from a registry cannot inject an element. Image targets ride the same
allowlist links do (`http`/`https`/`mailto`/`tel` and relative); a refused target renders
as prose rather than as a live element. Bounded at 65,536 characters, 512 blocks and 6
levels of list nesting; past a bound the remainder renders as plain text.

**Platform posture, declared:** `markdown` renders on **web** today. The iOS and Android
twins land with A4b (v4-launch execution-plan), reading the same neutral block tree from
`OpenSource/Conformance/markdown/blocks.json` — which is why the parse is specified as a
tree rather than as DOM. It carries no `stack-elements.json` row yet on purpose: that
catalog's census is the native-parity one, and a row would claim a renderer that does not
exist.

#### `image`
Non-interactive (use `button` for a tappable icon).

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `icon` / `systemImage` | SF Symbol | — | Renders `Image(systemName:)`. |
| `iconSize` / `fontSize` | number(pt) | `24` | Symbol size (weight semibold). |
| `color` | color | `label` | Symbol tint. Unstyled = the semantic `label` slot, like text. |
| `src` | URL | — | Remote image (async, fills, placeholder while loading). |

#### `button` / `glassButton` / `transport`
Tappable. Identical today (glass is opt-in via `surface="glass"`; the names are
semantic). **Unstyled = the system's borderless accent text button** (flat, snappy
press-scale, accent label — system-defaults). The **variant words** stay in system
space — they select among real system button renderings without ejecting, and author
style attributes still layer on top (same grammar on every renderer):

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `icon` | SF Symbol | — | Icon content. |
| `iconSize` | number(pt) | `20` | Icon size (weight semibold). |
| `label` | string | — | Text content (used if no `icon`). |
| `color` | color | `accent` | Icon/label color. Unstyled = the app tint; with a `variant`/role word the system style drives it (authored `color` always wins). |
| `variant` | enum | — | `bordered` = the tonal system button (`.bordered`) · `prominent` = the filled system button (`.borderedProminent`). Both ride **`.controlSize(.large)`** — the modern full-size system button (the Apple-app CTA; larger tap target), never a label-hugging mini pill; pair with `grow="width"` for the full-width CTA. Web mirrors the large metrics (theme.ts); Android's M3 button already is the platform's full-size spec. The unstyled default button stays inline-sized — the system default for a bare text button. |
| `role` | enum | — | `destructive` (red danger semantics) / `cancel` (dismissive weight) — the SwiftUI `ButtonRole`. Only these two words; any other `role` value keeps its [accessibility](#accessibility) meaning. |
| `on:tap` | action | — | Press handler. |
| *(children)* | — | — | Used if neither `icon` nor `label`. |

#### `pressable` / `row`
Tappable container around its children (`row` is the `<list>` row template).
`on:tap` + any children; add `on:doubleTap` / `on:longPress` for a multi-gesture
surface (a video that toggles controls on tap, likes on double-tap).

**Gesture contract (the TikTok model):** `on:tap` fires **instantly** on every
tap-up — including each tap of a double — and `on:doubleTap` fires additionally
on the second tap. (An exclusive single would wait the system's ~350 ms
double-tap window on *every* tap, which reads as lag.) So pair a double-tap
with a tap handler that's a **toggle**: a double nets the toggle back and the
double's action lands.

**Long-press is a lifecycle:** `on:longPress` fires when the hold is recognized
(0.4 s); `on:longPressEnd` fires when the finger lifts **or** the gesture cancels
(a drag past the slop, an interruption) after a recognized hold. The pair composes
hold-states — the short-video "hold for 2× speed, release to restore" — with no
timer in the markup. A plain tap (released before 0.4 s) fires neither.

#### `progress` / `capsuleProgress`
Horizontal progress bar.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `bind` | expr(0…1) | — | Progress value. |
| `value` | number(0…1) | — | Static value if no `bind`. |
| `color` | color | `accent` | Fill tint (track = 20% of it). |
| `height` | number(pt) | `6` | Bar thickness. |

#### `spinner` / `activity`
Indeterminate `ProgressView`. Unstyled = the OS's own untinted spinner
(system-defaults); `color` tints it.

### Inputs (two-way bound)

Every input fires `on:change` when its bound value changes.

#### `textfield` / `input`
| Attribute | Type | Default | Notes |
|---|---|---|---|
| `bind` | store key | — | Two-way bound String. |
| `placeholder` | string | — | |
| `secure` | bool | `false` | `"true"` → `SecureField`. |
| `color` | color | `label` | Unstyled = the semantic `label` slot (system-defaults). |
| `on:change` | action | — | Fires on each edit. |
| `on:submit` | action | — | Return key. |
| `on:focus` / `on:blur` | action | — | Editing began / ended. |

#### `toggle` / `switch`
`bind` (two-way Bool), `color` (default `accent`), `on:change`.

#### `slider`
`bind` (two-way Number), `min` (default `0`), `max` (default `1`), `color`
(default `accent`), `on:change`. For a fully custom look, build your own with
`on:drag` + `measure` instead (see [Universal attributes](#universal-attributes)).

#### `picker` / `segmented`
Two-way String selection — `picker` is a menu, `segmented` a segmented control.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `bind` | store key | — | The selected value. |
| `options` | CSV | — | Static/interpolated: `options="Weekly,Monthly,Yearly"`. |
| `optionsKey` | list path | — | Bound options list; `valueField` / `labelField` pick the fields (default `id` / `label`). |
| `label` | string | — | |
| `color` | color | `accent` | Menu tint (`picker` only). |
| `on:change` | action | — | |

#### `datepicker` / `date`
Two-way date/time bound to an **ISO-8601 string**. `mode="date"` (default) /
`"time"` / `"datetime"`, plus `label`, `color` (default `accent`), `on:change`.

#### `stepper`
± a bound number, clamped. `bind`, `min` (default `0`), `max` (default `100`),
`step` (default `1`), `label`, `color` (default `accent`), `on:change`.

### Structure

#### `scaffold`
A custom body with **sticky bars** by default, or an opt-in adaptive large-screen shell. Direct
children marked `pin="top"` / `pin="bottom"` remain global safe-area bars while adaptive pane
children are partitioned by `pane="sidebar|content|inspector"`. The body is always inset so
nothing hides behind its pins.

```xml
<scaffold shell="automatic" collapse="platform" compactAt="760">
  <AppHeader pin="top"/>
  <LibrarySidebar pane="sidebar"/>
  <NowPlaying pane="content"/>
  <TrackDetails pane="inspector"/>
  <PlayerControls pin="bottom"/>
</scaffold>
```

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `pin` *(child marker)* | `top` \| `bottom` | — | Pins a direct child outside the adaptive body as a sticky safe-area bar. |
| `pane` *(child marker)* | `sidebar` \| `content` \| `inspector` | content | Assigns an unpinned direct child to an adaptive pane. Sidebar + content are required when adaptive mode is active; inspector is optional. |
| `shell` | `custom` \| `automatic` \| `native` | `custom` | `custom` preserves the authored layout. `automatic`/`native` opt into the adaptive shell; Apple uses a real `NavigationSplitView`, while Compose and Web use their accessible semantic split. |
| `collapse` | `platform` \| `stack` \| `content` \| `none` | `platform` | Compact-width policy below `compactAt`. `platform` delegates to the native Apple split and stacks semantic renderers. |
| `compactAt` | number (320–4096) | `760` | Compact/wide breakpoint in logical points/dp/CSS px. |
| `sidebarMin` / `sidebarIdeal` / `sidebarMax` | number | `220` / `280` / `360` | Sidebar width triplet; normalized so min ≤ ideal ≤ max. |
| `inspectorMin` / `inspectorIdeal` / `inspectorMax` | number | `240` / `320` / `420` | Inspector width triplet; normalized so min ≤ ideal ≤ max. |
| `sidebarLabel` / `contentLabel` / `inspectorLabel` | string | `Sidebar` / `Content` / `Inspector` | Accessible pane names. |

The same markup targets iPad/iOS, Android, Web, macOS, Windows, and Linux. See
[Adaptive large-screen shells](../guides/adaptive-native-shells.md) for collapse behavior,
platform suffixes, and a complete example.

#### `pager`
Swipeable full-bleed pages — horizontal (a paged TabView with dots) or
`axis="vertical"` (TikTok-style full-screen vertical paging). Pages are static
children or data-bound rows.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `axis` | enum | horizontal | `"vertical"` = full-screen vertical paging. |
| `dots` | bool | `true` | Page dots (horizontal only). |
| `bind` + `key` | list + field | — | Data-bound pages: one row template, each row in its own `item` scope with write-back (like `<list>`). `key="index"` keys by position. |
| `value` | store key (Int) | — | Two-way current page — a swipe writes it; writing it jumps/scrolls to that page (and a non-zero initial value is honored). |
| `ignoreSafeArea` | bool | `false` | Pages extend under the notch / home indicator (full-bleed video feeds). |
| `on:change` | action | — | Fires when a page **rests** on the viewport (fully covers it, confirmed ~80 ms — a frame that merely *grazes* a boundary mid-fling or mid-jump never commits), never mid-drag, and never for the page the pager opened on. The outgoing page stays live under the finger (a playing video keeps playing, TikTok-style) until the swipe commits; a programmatic jump (writing `value`) commits once, immediately. Read the new index from `value`. |

#### `tabs` / `tabview`
Bottom tab bar. Each child pane carries its own `tabTitle` / `tabIcon`
(SF Symbol); `color` (default `accent`) tints the selection.

```xml
<tabs>
  <vstack tabTitle="Home" tabIcon="house.fill">…</vstack>
  <vstack tabTitle="Library" tabIcon="books.vertical">…</vstack>
</tabs>
```

#### `grid`
The same keyed, per-row data model as [`<list>`](#lists), flowing into N
flexible columns (episode pickers, plan cards, …). The single child is the row
template, rendered once per row in its own `item` scope with write-back.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `bind` + `key` | list + field | `key="id"` | The rows. `key="index"` keys by position. |
| `columns` | int | `3` | Column count (interpolates `{{ }}`). |
| `spacing` | number(pt) | `10` | Cell gap, both axes. |
| `scroll` | bool | `true` | `"false"` = no own ScrollView — compose inside `<scroll>` / measured sheets (sizes to content; renders **eagerly** so intrinsic height is real — see the laziness rule under [Fit-content](#fit-content)). |
| `on:reachEnd` | action | — | Fires when the last cell appears (pagination). |

#### `refreshable` / `refresh`
Pull-to-refresh around its children. It provides the ScrollView — put
non-scrolling content inside (e.g. `<list scroll="false">`).

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `on:refresh` | action | — | The pull action (usually a `fetch:`). |
| `busy` | expr | — | Bare expression (like `bind`): the spinner holds until it turns falsy, so it tracks the **real** load. Omitted → a brief grace period. |

```xml
<refreshable on:refresh="fetch: feed = GET https://api/episodes" busy="feed.loading">
  <list bind="feed.data" scroll="false">…</list>
</refreshable>
```

#### `sheet`
A declarative native modal: presents its children while a Bool state key is
true; swipe-down (or setting it false) dismisses.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `present` | store key (Bool) | — | Two-way: set true to open, false to close. |
| `mode` | enum | `sheet` | `sheet` = edge-to-edge drawer · `card` = floating inset card (AirPods-style) that **sheds the gap** at the `full` detent and becomes a drawer · `cover` = full-screen modal, no detents. |
| `detents` | CSV | `half,full` | Stops: `content` / `half` / `full`. `content` is **fit-content, for any markup**: the slot lays out at its ideal height (greedy children — scrolls / spacers / `grow` — collapse to their content), the sheet hugs it (capped at 90% of the screen), taller content scrolls, and async rows grow the sheet live. |
| `inset` | number(pt) | `14` | Card mode: the floating gap. |
| `background` | color token | `background` | The PRESENTATION background (the sheet chrome itself, not the content) — defaults to the theme token so drawers match the app instead of the iOS 26 translucent glass / elevated-grey defaults. `system` keeps the OS default; `clear` is transparent. |
| `title` | text | — | Standard drawer chrome: centered header title. Declaring `title`/`close`/`action` renders the built-in header (the REAL system close control + system sheet-header language) — stop hand-rolling header rows. |
| `close` | `leading` \| `trailing` \| `none` | `leading`* | The SYSTEM close control (`UIButton(type: .close)` — the adaptive circular ✕ every system sheet uses, 44pt target), never a drawn glyph (*when chrome is on). Tapping sets `present` false → `on:dismiss` fires as usual. |
| `action` / `actionIcon` | text / SF symbol | — | Optional bar button (label, icon, or both) → raises `on:action`. |
| `actionSide` | `trailing` \| `leading` | `trailing` | Which side the action button sits. |
| `on:dismiss` | action | — | Fires on close (swipe or programmatic). |
| `on:action` | action | — | The chrome action button. |

```xml
<sheet present="dsx.variable.showEpisodes" detents="half,full" on:dismiss="dsx.variable.showEpisodes = false">
  <Episodes/>
</sheet>

<!-- standard drawer chrome: title + circular ✕ + an Edit action on the right -->
<sheet present="dsx.variable.layers" detents="content" title="Add Layer"
       action="Edit" on:action="dsx.variable.editing = true"
       on:dismiss="dsx.variable.layers = false">…</sheet>
```

#### `list` — see [Lists](#lists).
#### `node` / `dynamic` — a data-driven tag: `<node tag="{{ item.view }}" …/>` resolves to any tag **compiled into this binary** (an unknown / unshipped tag renders nothing — a remote screen can never name a view the app can't render). A bare `<node>` renders its children.
#### `native` — REMOVED (was the legacy alias `<native name="x"/>` ≡ `<x/>`): write the component tag directly — resolution finds registered surfaces too (see [native registry](#native-registry)).
#### `slot` — see [Components](#components).

### Media

#### `video`
Declarative, state-driven video — the native twin of HTML `<video>` (iOS =
AVPlayer, Android = ExoPlayer). The player is **pure state**: no imperative
calls; bindings drive everything.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `src` | URL | — | Reactive — changing it swaps the asset. |
| `active` | bool | `true` | Multi-video layouts (a pager mounts several): only the active video plays and publishes its bindings; an inactive one **preloads its asset** (loads, never plays, never touches the shared readouts) and is hard-paused and silent — and it **keeps its position**. Re-activation **resumes** there instantly (adopting + publishing its own position into the shared bindings, so a scrubber snaps to the resume point); a clip that already **finished restarts** from the top. Never write the position binding on a page change — the activating video owns it. |
| `autoplay` | bool | `true` | Re-arms when `active` flips back on. |
| `loop` / `muted` | bool | `false` | |
| `gravity` | enum | `fill` | `fill` / `fit`. |
| `speed` | number | `1` | Playback rate — applied live (no restart, no re-assert per render), and every resume path (play/pause, PiP, interruptions, remote play) honors it. |
| `start` | number(s) | `0` | One-shot initial seek, applied once per asset **load** (the HTML `#t=` twin — continue-watching across sessions). Never re-applied on re-activation or re-render; after load, position belongs to playback, the bindings and the resume logic. |
| `subtitles` | bool | `false` | Embedded legible track (HLS closed captions / `.legible` group): `true` selects the preferred-language option, `false` deselects. Reactive. Assets with no legible group (most progressive MP4s) no-op. |
| `reload` | number | `0` | A **changed** value forces the current `src` to reload from scratch — the tap-to-retry primitive after `on:error` (bump a nonce). Unchanged = no effect. |
| `paused` | store key (Bool) | — | Two-way play/pause. |
| `bind` | store key (0–1) | — | Two-way position fraction — a scrubber sharing the key seeks the video, playback moves the fill. A value already in the store when the asset **loads** is adopted as the starting state (it never seeks retroactively); only writes made after load seek. |
| `scrubbing` | store key (Bool) | — | The no-jump-back contract for **custom scrubbers**: while true the video stops publishing `bind`/`time` (the finger owns the position); on release one frame-precise seek commits. Wire to `on:dragStart`/`on:dragEnd`. |
| `preview` | store key | — | While scrubbing: publishes scrub-frame thumbnails as tmp file-URLs — float `<image src="{{ preview }}"/>` above the thumb. |
| `time` / `duration` | store keys | — | Published read-only **seconds** (`time` publishes on whole-second change — labels don't re-render the surface every frame). |
| `buffering` | store key (Bool) | — | Published read-only: `<spinner visible-if="buffering"/>`. |
| `audio` | enum | — | `"playback"` claims the movie-playback audio session (sound with the silent switch on). Refcounted; released when the last claiming video unmounts (other apps' music resumes). |
| `pip` | bool | `false` | Picture-in-Picture: auto-enters when the app backgrounds while playing; user can invoke from Control Center. |
| `nowPlaying` | bool | `false` | Lock-screen / Control Center transport (`MPNowPlayingInfo` + remote commands). `nowTitle` / `nowArtist` fill the widget (reactive); play/pause/±skip work out of the box (`remoteSkip` = step, default 5 s; pause writes the bound `paused` key). With several videos mounted, the **playing** one owns the widget. |
| `on:remoteNext` / `on:remotePrev` | action | — | Lock-screen next/previous track — the markup decides (e.g. next episode). |
| `on:ready` / `on:ended` / `on:error` / `on:timeupdate` | action | — | `timeupdate` carries `{ time, duration }` at most once a second; `error` carries `{ message }` when the **active** clip fails — a bad/malformed URL, an unplayable asset, mid-stream death, **or a CDN that neither plays nor fails within ~15 s** (the load-timeout guard, so a dead origin never hangs forever on a spinner). An inactive preload that fails reports when it's swiped into view. Play/pause are **state** (watch the `paused` key), not events. |

Skip ±5 s is position math, no API: `pos = (time + 5) / duration`.

#### `audio`
The **headless** twin of `<video>` (iOS = AVPlayer) — same pure-state contract,
no visual layer. It owns playback and publishes state; you build the UI (a play
button, a `<slider bind="…"/>` scrubber, `{{ fmt(time) }}` labels) in DSX.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `src` | URL | — | Reactive — changing it swaps the track. |
| `autoplay` | bool | `true` | Plays on mount unless `paused` is true. |
| `loop` / `muted` | bool | `false` | |
| `speed` | number | `1` | Playback rate — applied live (no restart); every resume path honors it (podcasts at 1.5×). |
| `start` | number(s) | `0` | One-shot initial seek per asset **load** (continue-listening across sessions). |
| `reload` | number | `0` | A **changed** value reloads the current `src` — the tap-to-retry primitive after `on:error`. |
| `session` | enum | `playback` | `playback` = audible past the silent switch (the music-app contract); `ambient` = respects the switch + mixes. Refcounted, shared with `<video>`'s session. |
| `paused` | store key (Bool) | — | Two-way play/pause. |
| `bind` | store key (0–1) | — | Two-way position fraction — a `<slider>` sharing the key seeks; playback moves it. A value in the store at **load** is the starting state, not a seek. |
| `scrubbing` | store key (Bool) | — | The no-jump-back contract for custom scrubbers: while true it stops publishing `bind`/`time`; on release one frame-precise seek commits. Wire to `on:dragStart`/`on:dragEnd`. |
| `time` / `duration` | store keys | — | Published read-only **seconds** (`time` on whole-second change). |
| `buffering` | store key (Bool) | — | Published read-only: `<spinner visible-if="buffering"/>`. |
| `nowPlaying` | bool | `false` | Lock-screen / Control Center transport. `nowTitle` / `nowArtist` fill the widget (reactive); play/pause/±skip work out of the box (`remoteSkip` = step, default 15 s; pause writes the bound `paused` key). **Process-global** — use it on either `<audio>` or `<video>`, not both at once. |
| `on:remoteNext` / `on:remotePrev` | action | — | Lock-screen next/previous — the markup decides what a "track" is. |
| `on:ready` / `on:ended` / `on:error` / `on:timeupdate` | action | — | `timeupdate` carries `{ time, duration }` ≤ once a second; `error` carries `{ message }` (bad/malformed URL, unplayable asset, mid-stream death, or a CDN that neither plays nor fails within ~15 s). Play/pause are **state** (watch `paused`), not events. |

`<audio>` draws nothing — pair it with your own controls and a `<slider bind="pos"/>`.

### Scene (3D · 2D · AR)

#### `scene`
The DSX-native 3D engine's root (`architecture/proposals/dsx-scene.md`, ratified):
a declarative scene graph over the reactive store — **the store IS the game loop**
for state-shaped motion (`rotation="0 {{ spin }} 0"` animates by writing the
variable; no scripting API, no bridge). Stack layout stops at `<scene>` (it sizes
like an image/video box; web default aspect 16:9); inside, coordinates are scene
space. Vectors are space-separated triples (`"x y z"`); every attribute is
JSE-bindable; a malformed vector/scalar falls back to its default with one
diagnostic — never a crash, never a blank scene. The math (TRS world matrices,
projection) is corpus-pinned in `OpenSource/Conformance/scene/`; composition law:
scale, then rotate X→Y→Z (degrees), then translate; world = parent · local.

**Status (the dsx-scene.md ladder):** P1 — **landed on web** (WebGL, in-kernel,
zero deps). SceneKit (iOS) and Filament (Android) are the P2 row; `mode="ar"` and
`<anchor>` are P3; `<model>`/`<text3d>`/textures are P4 — a scene authoring a
scheduled word renders it as an honest labelled placeholder inside the scene box,
never silently.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `mode` | enum | `3d` | `3d` / `2d` / `ar`. `2d` is the SAME graph under an orthographic camera (z = layer order); `ar` is scheduled (P3). |
| `background` | color | `#000000` | `#rgb`/`#rrggbb`; reactive. |
| `on:ready` | action | — | Fires after the first rendered frame. |

Children (the scene vocabulary — these tags exist only inside `<scene>`):

| Tag | Attributes (beyond `id`, `position`/`rotation`/`scale`) | Defaults |
|---|---|---|
| `camera` | `look-at`, `fov`, `near`, `far`, `size` (the 2d vertical half-extent) | position `0 0 5`, look-at `0 0 0`, fov `60`, near `0.1`, far `1000`, size `5` |
| `light` | `kind` (`ambient` / `directional`), `intensity`, `color`; a directional light's `position` is its direction toward the origin | kind `ambient`, intensity `1`, color `#ffffff` |
| `group` | transform-only container; nests arbitrarily | position `0 0 0`, rotation `0 0 0`, scale `1 1 1` |
| `box` | `size` (`"w h d"`), `color`, `on:tap` | size `1 1 1`, color `#ffffff` |
| `sphere` | `radius`, `color`, `on:tap` | radius `1` |
| `plane` | `size` (`"w h"`, faces +Z — rotate `-90 0 0` for a ground), `color`, `on:tap` | size `1 1` |
| `model` | `src` (glTF/GLB via the content plane) — **scheduled (P4)**, renders the placeholder | — |
| `text3d` | `value` — **scheduled (P4)** | — |
| `anchor` | `kind`, `on:found` — **scheduled (P3, ar mode)** | — |

`on:tap` on a geometry node is picking v0: the pointer unprojects against each
node's world-space bounding sphere; the nearest handler-bearing hit fires through
the normal action path (payload `{ id }`). Web SSR emits the sized box only (the
canvas is client-only); no WebGL renders an honest labelled fallback in the box.

```xml
<scene background="#0b1020">
  <camera position="0 1.5 4" look-at="0 0 0" fov="60"/>
  <light kind="ambient" intensity="0.4"/>
  <light kind="directional" position="3 5 2" intensity="0.8"/>
  <group id="rig" rotation="0 {{ spin }} 0">
    <box position="-1 0 0" color="#2563eb" on:tap="picked = 'box'"/>
    <sphere position="1 0 0" radius="0.5" color="#f59e0b"/>
    <plane position="0 -0.5 0" size="10 10" rotation="-90 0 0" color="#1e293b"/>
  </group>
</scene>
```

### Forms

#### `form`
A thin coordinator over the `<field>`s it wraps. It owns no field state — fields
write themselves into the `form.*` namespace; it lays them out, optionally
renders a submit button, and gates `on:submit` on validity.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `as` | string | `form` | The state namespace; nested `<field>`s inherit it automatically — multiple forms on a screen just need distinct `as`. |
| `submit` | string | — | Renders a submit button with this label; dims while invalid. An invalid submit marks every field touched + sets `form.submitted` (reveals all errors at once). Prefer your own button + `disabled-if="{{ !form.valid }}"` for full control. |
| `spacing` | number(pt) | `12` | |
| `scroll` | bool | `false` | Wrap in a ScrollView (the keyboard lifts the focused field). |
| `on:submit` | action | — | Runs only when `form.valid`. |

#### `field`
One declarative form field — label · input · touched-gated error — with the
platform tracking the state (all dot-accessible): `form.values.<name>`
(two-way), `form.fields.<name>.touched` / `.dirty` / `.error`, `form.valid`,
`form.focus` (the Return key advances to the next field; a keyboard accessory
bar gives ▲▼ / Done).

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `name` | string | — | The value key — `form.values.<name>`. |
| `type` | enum | `text` | `text` / `email` / `number` / `phone` / `url` (keyboard) · `secure` (password) · `toggle` (inline switch) · `picker` (`options` CSV or `optionsKey`). |
| `validate` | CSV | — | `validate="required,email,minLength:8"` — built-ins: `required` / `email` / `url` / `phone` / `minLength:n` / `maxLength:n` / `pattern` (the regex rides its own `pattern=` attribute, so commas in `{2,4}` don't collide). |
| `message` | string | validator default | Error message override. |
| `label` / `placeholder` | string | — | |
| `form` | string | enclosing `as` | Explicit namespace override (rarely needed — fields inherit the enclosing `<form as=…>`). |

#### Forms in practice

A complete sign-up form. Each `<field>` declares its own validation and writes
`form.values.<name>`; the `<form>` lays them out, tracks `form.*`, and gates `on:submit` on
`form.valid`.

```xml
<form as="signup" submit="Create account"
      on:submit="dsx.variable.busy = true; await fetch('/api/signup', { method: 'POST', body: form.values })">
  <field name="email"    type="email"  label="Email"    validate="required,email"/>
  <field name="password" type="secure" label="Password" validate="required,minLength:8"
         message="At least 8 characters"/>
  <field name="terms"    type="toggle" label="I accept the terms" validate="required"/>
</form>
```

- The error under a field appears once it's **touched**; an invalid submit marks every field
  touched at once (and sets `form.submitted`), so nothing fails silently.
- `on:submit` runs **only** when `form.valid`, and the submit button dims until then. For your
  own button instead, use `disabled-if="{{ !form.valid }}"`.
- For a check the built-ins don't cover, compute it: a `<variable computed>` `errors` block
  using the validator functions (`required`, `email`, `minLength(v,n)`, …) documented in
  [state-and-computation.md](state-and-computation.md).

---

## Style attributes <a id="style-attributes"></a>

Apply to **any** element (in declared order). Values interpolate `{{ … }}`, so
any style can bind to the store.

| Attribute | Type | Default | Effect |
|---|---|---|---|
| `padding` | number(pt) | `0` | Inset on all sides. |
| `paddingH`/`paddingX`, `paddingV`/`paddingY` | number(pt) | — | Horizontal / vertical inset. |
| `paddingTop`, `paddingBottom`, `paddingLeading`(`paddingLeft`), `paddingTrailing`(`paddingRight`) | number(pt) | — | Per-edge inset. |
| `background` | color | — | Fill behind the element (rounded by `radius`). A **literal** color (hex / `rgb()`/`rgba()` / `white`/`black`) that is opaque-ish (alpha ≥ 0.5) also **derives the subtree's color scheme** from its relative luminance — see `theme` below (the explicit form, which always wins). Semantic words keep following the ambient scheme. **On a page ROOT** (a route frame's root element, resolved through component references) the declared background also becomes the **host canvas, full-bleed** — behind a claimed system bar / large title and through top/bottom overscroll — so a `groupedBackground` or designed page is seamless edge-to-edge like a real system screen (semantic words stay adaptive; a literal canvas composes with the derived subtree scheme). No root background keeps the `systemBackground` host canvas; `clear`, gradients and materials never become a canvas; sheets, covers and overlay layers are unaffected. |
| `surface` | material | — | Blur/vibrancy material behind the element (`glass`, …). See [Materials](#materials). |
| `glassTint` | color | — | Colors the Liquid Glass ITSELF (iOS 26+) — a full-color glass button, not tinted text. Below 26: a solid fill of the tint (the full-color read survives everywhere). CSS: `-dsx-glass-tint`. |
| `glassInteractive` | bool | tappables: `true` | The system's bouncy press-stretch Liquid Glass response (iOS 26+). Defaults ON for elements with `on:tap`; `"false"` removes it, `"true"` forces it on static surfaces. CSS: `-dsx-glass-interactive`. |
| `gradient` | colors | — | Linear gradient `c1\|c2\|…` (2+ colors). |
| `gradientDir` | enum | `vertical` | `vertical` / `horizontal` / `diagonal`. |
| `radius` | number(pt) | `0` (surface: `16`, sheet `24`) | Corner radius; also clips the element. |
| `fontSize` | number(pt) | system | Text/symbol size. |
| `fontWeight` | enum | `regular` | `regular`/`medium`/`semibold`/`bold`/`heavy`. |
| `fontDesign` | enum | `default` | `default`/`rounded`/`serif`/`monospaced`. |
| `width` / `height` | number(pt) \| `fit` | intrinsic | Fixed size — or **`fit`** (alias `fit-content`): the element takes its content's **ideal** size on that axis; greedy descendants (scrolls, spacers, `grow`) collapse to their content. The hug primitive — `<sheet detents="content">` applies it to its slot automatically. |
| `minWidth`/`maxWidth`/`minHeight`/`maxHeight` | number(pt) | — | Flexible bounds. |
| `grow` | `true`/`width`/`height` | `false` | Fill available space: `true` = both axes; `width`/`height` = one axis (a pill fills its row width but keeps its natural height). |
| `aspectRatio` | `W:H` or number | — | Constrain aspect ratio (fit). |
| `ignoreSafeArea` / `fullBleed` | `true`/`all` · `top` · `bottom` · `horizontal` · `vertical` | — | Extend past the safe area (notch / home indicator). Put it on a background layer (video, dark fill, a bottom sheet) so it reaches the screen edge while the rest of the page stays inset. |
| `opacity` | number(0…1) | `1` | |
| `theme` | `dark`/`light` | follow system, or derived | Pin this subtree's **color scheme**: semantic colors (`secondary`/`tertiary`), materials and system controls render in the pinned scheme, and a pushed frame's system chrome (bar material, large title) follows it — a dark-designed page stays dark in device light mode. Normally set once on a page's root stack. Web: stamps `data-dsx-theme` (element-scoped token override). **Without `theme=`, an authored literal canvas derives it:** a `background` that parses to a literal color (hex / `rgb()` / `white`/`black`, alpha ≥ 0.5) sets the subtree scheme by its relative luminance (< 0.5 → dark, else light), so unstyled `label` text inside `background="#0A0A0A"` resolves light and inside a light card resolves dark. Any authored `theme=` suppresses the derivation; semantic-word backgrounds and gradients/materials never derive. |
| `rotation` | number(deg) | `0` | Rotate. |
| `scale` | number | `1` | Scale. |
| `blur` | number(pt) | — | Gaussian blur radius. |
| `zIndex` | number | `0` | Draw order within a stack. |
| `borderColor` | color | — | Stroke (rounded by `radius`). |
| `borderWidth` | number(pt) | `1` | Stroke width (needs `borderColor`). |
| `shadow` | number(pt) | — | Drop-shadow blur radius (presence enables it). |
| `shadowColor` | color | black 25% | Shadow color. |
| `shadowX` / `shadowY` | number(pt) | `0` / `2` | Shadow offset. |
| `offset` / `offsetY` | number(pt) | `0` | Vertical offset of the fully-styled element — background/border/shadow ride along, like a CSS transform (animatable — see [Animations](#animations)). |
| `offsetX` | number(pt) | `0` | Horizontal offset (same semantics — the whole styled element moves; a scrubber thumb positions with `offsetX="{{ pos * track.width }}"`). |
| `style` | name(s) | — | Apply [named styles](#named-styles) (space-separated; later wins; explicit attrs win over the style). |

**Text-only** (on `<text>`): `italic`, `underline`, `strikethrough` (bool),
`tracking` (letter spacing, pt), `lineLimit` (int), `lineSpacing` (pt),
`textAlign` (`leading`/`center`/`trailing`), `textCase` (`upper`/`lower`).
(`underline`/`strikethrough`/`tracking` need iOS 16+; no-ops below.)

**Order of application:** padding → frame(width/height) → font →
min/max-frame (`grow`) → background → surface → gradient → radius/clip →
aspectRatio → ignoreSafeArea → opacity → theme → rotation → scale → blur → border →
shadow → **offset** → zIndex. (Both frame blocks come *before* background, so the
fill spans the final size — a fixed-size circle, a `grow` pill, or a flex grid
card all paint edge to edge; padding is *before* background so a pill's
background covers the padded area; offset comes *last* so it moves the finished
element — frame, background, border and shadow together.)

### Fit-content (hug) sizing <a id="fit-content"></a>

Every element sizes in one of **three modes** per axis:

| Mode | Spelled | Behavior |
|---|---|---|
| **Hug** (the default) | *(nothing)* | Stacks, text, buttons size to their content — but **greedy children leak through**: a `<scroll>`/`<list>`/`<grid>`, a `<spacer/>`, or a `grow="true"` child expands the box to whatever the parent offers. |
| **Grow** | `grow="width" / "height" / "true"` | Fill the offered space on that axis. |
| **Fit** | `width="fit"` / `height="fit"` (alias `fit-content`) | **Force-hug**: take the content's *ideal* size on that axis — greedy descendants collapse to their content instead of expanding. CSS `fit-content`. |

**Stretch a box to fill its parent's width** — the inverse of hug, and the one
authors miss most. A stack does **not** fill its parent's width by default; it
hugs. It only *looks* full-width when it happens to contain a greedy child (a
`grow="width"` button, a `<slider>`, a `<chart>`). Make it explicit — put
`grow="width"` on the box itself so its width never depends on its contents:

```xml
<!-- A section card that is full-width no matter what's inside it. -->
<vstack grow="width" spacing="10" padding="14" radius="14" background="fillFaint">
  <text value="Title"/>      <!-- all intrinsic-width children …            -->
  <text value="Body copy"/>  <!-- … would otherwise collapse the card wide  -->
</vstack>
```

> **The collapse trap:** a card whose children are *all* intrinsic-width (only
> `<text>`/`<image>`, no greedy child) silently shrinks to its widest line and
> renders narrower than its siblings. If a panel looks ragged next to the
> others, it is missing `grow="width"`. There is **no `%` syntax** —
> `width="100%"` is ignored (it does not parse as a number); `grow="width"` is
> the only fill-width primitive, and `grow="true"` fills both axes.

`fit` is the tool for "size this box to what's *inside* it" when the inside
contains something greedy:

```xml
<!-- A floating panel around a scrolling list: without fit, the <list>'s
     ScrollView inflates the panel to the full screen; with it, the panel
     hugs the rows. -->
<vstack height="fit" padding="12" radius="16" background="rgba(0,0,0,0.6)">
  <list bind="dsx.variable.recent" key="id" spacing="6"> … </list>
</vstack>

<!-- A chip that hugs its label horizontally even inside a grow row. -->
<text width="fit" value="{{ dsx.variable.tag }}" paddingH="10" paddingV="4"
      radius="12" background="fillFaint"/>
```

Rules of thumb:

- **`fit` and `grow` on the same axis are opposites** — declare one, never both.
- `fit` takes the *ideal* size regardless of what the parent offers; content
  larger than the available space **overflows** (clip with `radius`, or put the
  fit box inside a `<scroll>`). It is a hug, not a clamp — combine with
  `maxWidth`/`maxHeight` only when you accept the overflow trade.
- Inside `<list>`/`<grid>` rows you rarely need it — rows already lay out at
  their natural height.
- **The laziness rule (engine-enforced):** lazy containers live only inside their
  own scrolling viewport. Embedded collections — `<list scroll="false">`,
  horizontal `<list>` rails, `<grid scroll="false">` — render **eagerly**, so
  their intrinsic size is real wherever fit-content measures it (a lazy stack
  reports ~zero ideal size before its cells materialize, which collapsed
  embedded rails/grids to nothing inside sheets).
- **Sheets consume it automatically:** `<sheet detents="content">` applies fit
  to its slot — the sheet hugs the slot's ideal height (90% cap, taller content
  scrolls, async rows grow it live), so sheet markup never needs `fit` or a
  special root. The native `ui.sheet(detents: [.content])` path implements the
  same contract with a one-shot hugging measurement (a fixed detent, pinned at
  present time).

See [Cross-platform mapping](#xplat) for the SwiftUI ↔ Compose equivalents.

---

## Named styles <a id="named-styles"></a>

`style="card"` (or several: `style="card heading"`). Exact values:

| Style | Expands to |
|---|---|
| `sheet` | `padding=20 background=#121212 radius=24 surface=sheet` |
| `card` | `padding=16 background=rgba(255,255,255,0.06) radius=16` |
| `heading` | `fontSize=24 fontWeight=bold` |
| `subheading` | `fontSize=15` |
| `rowTitle` | `fontSize=17 fontWeight=semibold` |
| `price` | `fontSize=17 fontWeight=bold` |

An explicit attribute on the element overrides the style's value for that key.

---

## Colors <a id="colors"></a>

| Form | Example | Notes |
|---|---|---|
| Named | `white`, `black`, `clear`, `accent` | `accent` = the app's own tint (the AccentColor asset — per-app, adaptive per scheme), never a fixed hex. |
| Semantic (adaptive) | `label` (`text`) · `secondary` (`secondaryLabel`) · `tertiary` (`tertiaryLabel`) · `background` (`systemBackground`) · `secondaryBackground` · `tertiaryBackground` · `groupedBackground` · `secondaryGroupedBackground` · `fill` · `fillFaint` · `separator` · `destructive` | Resolve against the surface's light/dark trait — they follow the device, the app-wide appearance override (`despia.appearance.set`), and a subtree `theme=` pin. The grouped pair is the native list language: `groupedBackground` page + `secondaryGroupedBackground` cards. |
| Hex (RGB) | `#RRGGBB` → `#FF2D55` | 6 digits, fully opaque. |
| Hex (ARGB) | `#AARRGGBB` → `#CCFF2D55` | 8 digits, leading alpha. |
| `rgb()` | `rgb(255,46,84)` | Channels 0–255. |
| `rgba()` | `rgba(255,255,255,0.12)` | Channels 0–255; **alpha 0–1**. |

Unrecognized values fall back to `white`. (3-digit `#RGB` is **not** supported —
use 6 digits.) The machine-readable token list (with adaptivity flags) is
`stack-style-properties.json` → `colorTokens`, kept in sync by `check_style_catalog.rb`.

**The system-defaults token corpus** (`OpenSource/Conformance/defaults/tokens.json`)
pins the ten cross-renderer words — `label · secondary · tertiary · background ·
groupedBackground · secondaryGroupedBackground · fill · separator · accent ·
destructive` — each resolving to exactly the UIColor slot its `ios` column names
(`fill` → `systemFill`, `destructive` → `systemRed`, `accent` → the app tint). The OS
owns the values, so looks inherit OS updates instead of rotting; the extra spellings
above (`secondaryBackground`, `fillFaint`, aliases) are pre-corpus and stay supported.

---

## Materials <a id="materials"></a>

`surface="…"` → a native blur/vibrancy material (iOS Liquid Glass family). Pair
with `radius` for rounded glass.

| `surface` value | Material |
|---|---|
| `glass` / `ultraThin` | `.ultraThinMaterial` |
| `thin` | `.thinMaterial` |
| `regular` | `.regularMaterial` |
| `thick` | `.thickMaterial` |
| `sheet` (default) | `.ultraThinMaterial` (radius defaults to 24) |

---

## Cross-platform style mapping (iOS ↔ Android) <a id="xplat"></a>

Stack attributes are **platform-neutral**: the same XML renders on iOS (SwiftUI)
and Android (Jetpack Compose). Lengths are points on iOS and the **same numeric
value as `dp`** on Android. This table is the contract each renderer implements 1:1.

| Stack attribute | SwiftUI (iOS) | Jetpack Compose (Android) |
|---|---|---|
| `padding` | `.padding(n)` | `Modifier.padding(n.dp)` |
| `paddingH`/`paddingV` | `.padding(.horizontal/.vertical, n)` | `Modifier.padding(horizontal/vertical = n.dp)` |
| `paddingTop/Bottom/Leading/Trailing` | `.padding(.top/…, n)` | `Modifier.padding(top/… = n.dp)` |
| `width` / `height` | `.frame(width:/height:)` | `Modifier.width(n.dp)` / `.height(n.dp)` |
| `width="fit"` / `height="fit"` | `.fixedSize(horizontal:/vertical:)` | `Modifier.width(IntrinsicSize.Max)` / `.height(IntrinsicSize.Max)` |
| `minWidth`/`maxWidth`/… | `.frame(minWidth:maxWidth:…)` | `.widthIn(min,max)` / `.heightIn(min,max)` |
| `grow` (`true`/`width`/`height`) | `.frame(maxWidth/maxHeight: .infinity)` | `fillMaxSize()` / `fillMaxWidth()` / `fillMaxHeight()` |
| `aspectRatio` | `.aspectRatio(_, .fit)` | `Modifier.aspectRatio(r)` |
| `ignoreSafeArea`/`fullBleed` | `.ignoresSafeArea(.container, edges:)` | edge-to-edge: the element skips `Modifier.windowInsetsPadding(...)` while its siblings keep theirs |
| `background` | `.background(RoundedRectangle.fill(color))` | `Modifier.background(color, RoundedCornerShape(radius))` |
| `surface` (glass) | `.background(.ultraThinMaterial, in:)` | `Modifier.background` + blur/Haze material |
| `gradient` / `gradientDir` | `LinearGradient(colors:startPoint:endPoint:)` | `Brush.linearGradient(colors)` |
| `radius` | `.clipShape(RoundedRectangle(cornerRadius:))` | `Modifier.clip(RoundedCornerShape(n.dp))` |
| `borderColor` / `borderWidth` | `.overlay(RoundedRectangle.stroke())` | `Modifier.border(w.dp, color, shape)` |
| `shadow` / `shadowColor` / `shadowX/Y` | `.shadow(color:radius:x:y:)` | `Modifier.shadow(elevation, shape)` (+ ambient/spot color) |
| `opacity` | `.opacity(x)` | `Modifier.alpha(x)` |
| `rotation` | `.rotationEffect(.degrees(d))` | `Modifier.rotate(d)` |
| `scale` | `.scaleEffect(s)` | `Modifier.scale(s)` |
| `blur` | `.blur(radius:)` | `Modifier.blur(n.dp)` |
| `zIndex` | `.zIndex(z)` | `Modifier.zIndex(z)` |
| `offset`/`offsetX`/`offsetY` | `.offset(x:y:)` | `Modifier.offset(x.dp, y.dp)` |
| `align` (stack) | `VStack/HStack/ZStack(alignment:)` | `Column/Row(...Alignment)` / `Box(contentAlignment)` |
| `fontSize` / `fontWeight` / `fontDesign` | `.font(.system(size:weight:design:))` | `fontSize=.sp, fontWeight=, fontFamily=` |
| `color` | `.foregroundColor` | `color=` / `tint=` |
| `icon` (semantic token) | shared icon set (Lucide/Material Symbols), SF Symbols as iOS fast path | same shared set, resolved by the **same name** — never a per-platform id |
| `italic` | `Text.italic()` | `fontStyle = Italic` |
| `underline` / `strikethrough` | `Text.underline()/.strikethrough()` | `textDecoration = Underline/LineThrough` |
| `tracking` | `Text.tracking(n)` | `letterSpacing = n.sp` |
| `lineLimit` / `lineSpacing` | `.lineLimit()` / `.lineSpacing()` | `maxLines=` / `lineHeight=` |
| `textAlign` | `.multilineTextAlignment()` | `textAlign = TextAlign.*` |
| `textCase` | `.textCase(.uppercase/.lowercase)` | `text.uppercase()/lowercase()` |
| `transition`/`anim`/`keep` | `.transition()/.animation()` | `AnimatedVisibility` / `animate*AsState` |
| `render(as: .overlay)` | sibling `UIView` + passthrough hit-test | overlay `Composable` + pass-through |
| `enter=` (page/element entry) | `.transition()` on appear (`@State` + `onAppear`) | `AnimatedVisibility`(visible on first composition) |
| `on:tap` (any element) | `.contentShape(Rectangle()).onTapGesture` | `Modifier.clickable { }` (fills the element, transparent areas included) |
| `ui.sheet(detents:)` | `UISheetPresentationController` (`.medium()`/`.large()`, grabber, corner radius) | `ModalBottomSheet` (PartiallyExpanded/Expanded, `dragHandle`, `shape`) |
| `StackDetent.content` / `.half` / `.full` | custom(content height) / `.medium()` / `.large()` | wrap_content / PartiallyExpanded / Expanded |

Anything the catalog can't express is a `native:<name>` view — a `UIView`/SwiftUI
view on iOS, a `@Composable` on Android — registered per platform.

---

## Expressions <a id="expressions"></a>

> The expression & logic engine is **JSE** — see [`jse.md`](jse.md). `{{ }}`, `visible-if`, bindings, and `on:` action bodies are all JSE.

> **Not JavaScript — JS-*lookalike*, interpreted straight to native.** The syntax
> is 1:1 with JS so a JS dev reads and writes it unchanged, but **there is no JS
> engine and no bridge.** Every expression is parsed and interpreted **directly
> into native values** (Swift on iOS, Kotlin on Android), reading straight from
> the native store: **bridgeless, instant, zero overhead** — no
> JavaScriptCore/Hermes, no marshaling on any read. It is also **bounded** — no
> unbounded loops or recursion (higher-order fns are bounded passes over a finite
> collection) — so remote/OTA content can never hang or DoS the UI.

Used in `{{ … }}`, `bind`, `visible-if`, and inside `on:` action args. **Pure** —
no assignment or side-effects in expression position (those are
[actions](#actions)). Recursive-descent, precedence low → high:

| Level | Operators | Notes |
|---|---|---|
| ternary | `cond ? a : b` | |
| or | `a \|\| b` | returns `a` if truthy else `b` (default values: `{{ dsx.variable.name \|\| 'Guest' }}`). |
| and | `a && b` | returns `b` if `a` truthy else `a`. |
| equality | `== !=` | numeric if both numbers, else string. |
| comparison | `< <= > >=` | numeric. |
| additive | `+ -` | `+` is numeric add **or** string concat. |
| multiplicative | `* /` | numeric (`/0` → `0`). |
| unary | `!x` `-x` | |
| postfix | `a[i]` `a.member` `a.length` | JS indexing / member access (`.length` on arrays & strings). |
| primary | `42` `'str'` `"str"` `true`/`false`/`null` `a.b.c` `( … )` | values & grouping. |
| literals | `[a, b]` · `{ id, qty }` | array / object literals (`{ id }` ≡ `{ id: id }`, JS shorthand). |
| arrow fn | `(a, { x, y }) => expr` `=> { … }` | a value passed to the higher-order fns (destructuring params; 2nd param = index). |
| calls | `upper(s)` `round(n)` · `coll.map(x => …)` `reduce(coll, fn, init)` · `discount(cart)` | built-ins · **bounded** higher-order taking an arrow (`map`/`filter`/`reduce`/`find`/`some`/`every`/`sortBy`/`sumBy`/`forEach`) · `function` calls. |

**Paths** resolve **locals first** (a component's attributes / list-row `item`), then the
shared store. Be explicit with `dsx.item.x` / `dsx.attribute.x`. Truthiness: non-empty
string, non-zero number, `true`, any non-null value.

**`dsx.this` — the current scope.** In a list/grid row, a `map`/`filter` element, or
an `<action>`/`<formula>` body, `dsx.this` is the current thing: `dsx.this.name` (≡
`item.name` ≡ bare `name`) reads its field, and **`dsx.this.index`** is its position
in the loop. (`$` is a valid identifier char, so `dsx.this` parses as a name.)

**`dsx.element.*` — the container query.** Inside an element marked `container`, descendants read
`dsx.element.width` / `dsx.element.height` = that nearest container's live size (the CSS `@container`
analogue, the per-container twin of the window-wide `dsx.screen.*`). Reactive; resolves to the
nearest `container` ancestor (so nested containers each scope their own). nil outside any container.

**Explicit `$`-namespaces (opt-in aliases).** Alongside the bare forms, every scope has a
`$`-prefixed spelling for disambiguation — both resolve identically: `dsx.variable.x` (this surface's
state) · `dsx.global.x` (≡ `global.x`) · `dsx.route.x` · `dsx.params.id` (≡ `route.params.id`) ·
`dsx.query.ref` · `dsx.path` (≡ `route.path`) · `dsx.attribute.name` · `dsx.item.x` · `dsx.this.x`. Invocation too:
`dsx.action.name()` runs an `<action>` (effect — keep `()`), `dsx.formula.name` reads a `<formula>`
(value — no `()`). Navigation is a state write: `dsx.route.path = '/home'`.

**White-label namespaces (app-wide, set once):** `dsx.global.theme.*` (≡ `global.theme` — design tokens:
`accent`, `gold`, dark-mode swaps) and `dsx.global.strings.*` (≡ `global.strings` — every user-facing
literal: `{ coins: "gems", save: "Guardar", … }`). Modules resolve **defaults ⊕ `dsx.global.strings`/`dsx.global.theme`
⊕ per-call payload** (most specific wins) — so one `global.strings` write re-skins every adopting
module, and a single `start()` payload can still override per call. The convention, with the
module-author recipe, lives in **`Skills/white-label.md`**.

**App identity (read-only):** `dsx.app.host` (the per-locale host resolved from `App.json`),
`dsx.app.name` (the app's display name), `dsx.app.version` (marketing version, a display STRING),
`dsx.app.build` (`CFBundleVersion` as a NUMBER — the blessed comparison key), `dsx.app.env` /
`dsx.app.production` (the runtime environment channel) — seeded at boot from the app manifest +
bundle; native code reads the same via `dsx.app.*`. See `app-manifest.md`.

**Reserved:** `os` (alias `platform`) → the running renderer, `"ios"` or
`"android"`. This is the **platform escape hatch** — gate any element to one
platform with `visible-if`, no new attribute syntax:

```xml
<SiriButton visible-if="os == 'ios'"/>          <!-- iOS only -->
<BackBar    visible-if="os == 'android'"/>       <!-- Android only -->
<TipsButton visible-if="os == 'ios' && !dsx.variable.premium"/>  <!-- composes with state -->
```

**Reserved:** `env` → the runtime environment channel: `"simulator"` | `"debug"` |
`"testflight"` | `"adhoc"` | `"appstore"`. Detection **fails closed** to `"appstore"`
(ambiguous ⇒ production), so an env-gated element defaults to hidden on prod. Static per
process (a channel can't change mid-run) — for the LIVE staging override read
`dsx.global.dev.origin` instead (`Core/DevSettings`):

```xml
<DebugRibbon visible-if="env != 'appstore'"/>                    <!-- anything off prod -->
<button visible-if="env == 'testflight'" label="Send feedback" on:tap="dsx.module.dev.open()"/>
<vstack visible-if="!dsx.app.production"> … </vstack>             <!-- boolean spelling -->
<NewCheckout visible-if="dsx.app.build >= 260"/>                  <!-- build is numeric; version is a display string -->
```

```xml
<text>{{ dsx.variable.episode + 1 }}/{{ dsx.variable.total }}</text>
<button visible-if="dsx.variable.coins >= dsx.variable.price && !dsx.variable.locked" .../>
<image icon="{{ dsx.variable.liked ? 'heart.fill' : 'heart' }}"/>
```

---

## Bindings <a id="bindings"></a>

| Mechanism | Where | Reads |
|---|---|---|
| `{{ expr }}` | any attribute value or text | interpolated into the string |
| `bind="path"` | `text`/`image`(value)/`progress`/inputs/`list` | the store value at `path` (or `item.*` in a row) |
| `value="…"` | `text` (and others) | static (interpolated) fallback |
| `visible-if="expr"` | any element | show/hide |
| `visible-if="has:scheme"` | any element | true if a module with that scheme is installed |
| `has('scheme')` | any expression (`{{ }}`, `on:*`, computed) | the callable form of the above — `true` when that module is in this build (e.g. `{{ has('clerk') ? 'Clerk' : 'OAuth' }}`) |

Inputs (`textfield`/`toggle`/`slider`/…) are **two-way**, and `bind=` is **path-aware** — it
reads/writes exactly where `{{ }}` / a store write (`x = …`) do, so an input can map onto a **key
of an object var**, the app store, or the current row:

```xml
<variable as="user">return { email: '', name: '' }</variable>
<textfield bind="dsx.variable.user.email"/>          <!-- two-way into user.email (the object var's key) -->
<textfield bind="dsx.variable.user.name"/>
<text>{{ dsx.variable.user.email }}</text>            <!-- reads the same value live -->

<toggle  bind="global.settings.dark"/>   <!-- app-wide store -->
<textfield bind="dsx.variable.name"/>                  <!-- a flat surface var -->
```

**Editable list** — an input over a `<list>`/`<grid>` row binds to the row (`item.*`, or the
`dsx.this.*` alias) and writes straight back into that element of the array var, reactively:

```xml
<variable as="todos">return [{ name: 'Milk', done: false }, { name: 'Eggs', done: true }]</variable>

<list bind="dsx.variable.todos">
  <hstack>
    <toggle    bind="dsx.this.done"/>        <!-- ≡ item.done  → todos[i].done -->
    <textfield bind="dsx.this.name"/>        <!-- ≡ item.name  → todos[i].name, live -->
  </hstack>
</list>
<text>{{ dsx.variable.todos.0.name }}</text>            <!-- re-renders as the row is edited -->
```

---

## Actions (`on:` syntax) <a id="actions"></a>

An action string is **bounded JS** — a statement (or several, on `;` / newlines).
Event/call forms take a payload object whose `{{ … }}` values are interpolated and
coerced to bool/number/string.

| Action | Effect |
|---|---|
| `dsx.send('name')` | Run the **native** handler `ui.on("name") { payload in … }` — in-process, internal to the owning module. |
| `dsx.event('name')` | Raise a [component](#components) event to the host's `on:name` (carries the payload up); also the web stream event on the originating call. |
| `scheme.host({ args })` | Dispatch to **another module / the web bridge** (`{ id: item.id }`). For crossing a boundary — not a component calling its own native code. |
| `key = expr` | Write a store var (declarative state: `dsx.variable.open = !dsx.variable.open`). |
| `animate: key = expr` | Same, inside an animation (tweens bound styles). |
| `arr.push(x)` / `.unshift(x)` / `.pop()` / `.shift()` / `.splice(s, c, …)` · `arr.splice(0)` (clear) · `arr.splice(i, 0, x)` (insert at `i`) | Array mutations on a bound list: `dsx.variable.todos.push({ text: dsx.variable.draft })`, `dsx.variable.rows.splice(2, 1)`. (The `remove: arr where done` filter-delete stays a verb — no JS form.) |
| `fetch: dest = METHOD url [body=…] [headers=…]` | **Reactive** HTTP for the *spinner* case: writes the `dest.{loading,error,data}` envelope. For sequential logic use the JS form **`const r = await fetch(url, { method, body, headers })`** → `{ data, error, status, ok }`, then branch with a normal `if`. |
| `name()` | Run a named `<action>` block (`dsx.action.checkout()`). |
| `dsx.broadcast('name', data)` | Out-of-band web event (always delivered). |
| `dsx.resolve({ … })` | Settle the call (deferred-result pattern). |
| `dsx.error('code', data)` | Reject the call. |
| `dsx.screen.settled()` | **This screen has settled** — report readiness to the shell (pairs with `settle="manual"`). Zero-arg, once per screen; see [Screen readiness](#screen-readiness). |

```xml
<button label="Save"   on:tap="dsx.send('save')"/>
<button icon="bars"    on:tap="dsx.variable.menuOpen = !dsx.variable.menuOpen"/>
<button label="Open"   on:tap="maps.open({ lat: dsx.variable.lat, lng: dsx.variable.lng })"/>
<button label="Pick"   on:tap="dsx.resolve({ id: item.id })"/>
```

### Navigation <a id="navigation"></a>

The route is **state**: `route.path = '/x'` navigates in place (a *replace*). A back-stack
(`global.nav.stack`) is opt-in via the `route` module — ordinary module calls:

| Call | Effect |
|---|---|
| `dsx.module.route.push({ path: '/cart' })` | grow history — push a screen (back-enabled) |
| `dsx.module.route.pop()` | back — pop the top screen |
| `dsx.module.route.popTo({ path })` | back to the deepest frame matching `path` (concrete paths, query strings ignored on both sides — the rule is pinned by `OpenSource/Conformance/router/popto.json`) — one transition, not N pops |
| `dsx.module.route.popToRoot()` | back to the root frame |
| `dsx.module.route.replace({ path })` | swap the top, no history growth |
| `dsx.module.route.reset({ path })` | clear to a single root (tab switch / after login) |

`route.path = '/x'` stays a **replace** (no history). Read `nav.canPop` / `nav.depth` for back
affordances; `route` (incl. `route.params` / `route.path`) always reflects the **top** screen.

```xml
<button icon="chevron-left" visible-if="{{ dsx.variable.nav.canPop }}" on:tap="dsx.module.route.pop()"/>
<row on:tap="dsx.module.route.push({ path: '/product/' + item.id })"> … </row>
```

**Component screens** (path-less, package-scoped) use the `dsx.component` verbs — `attrs` is
the component **input contract** (the same attributes a hard-coded `<Tag …/>` would carry,
seeding reactive `dsx.attribute.*`; see [`dsx-anatomy.md`](./dsx-anatomy.md)):

| Call | Effect |
|---|---|
| `dsx.component.push('Canvas', { attrs: { id: item.id } })` | open as a native nav **frame** (swipe-back, back history) |
| `dsx.component.present('Paywall', { as: 'sheet', attrs: { plan: 'pro' } })` | open as a modal — `as: 'sheet'` (default) / `'cover'` / `'overlay'` (+ `touch: 'passthrough'|'block'`, `detents`) |
| `dsx.component.update('Paywall', { attrs: { plan: 'team' } })` | **live input write** — merges into the open surface's attributes; bindings recalc, `<attribute on:change>` fires; no target = the top; unmatched target = no-op |
| `dsx.component.dismiss(['Paywall'])` | close the top modal, or by tag / `as` mode |

The machine (normalization, planes, dismissal topology, attrs/update semantics) is
corpus-pinned in `OpenSource/Conformance/router/present.json`; `vars:` remains the legacy
store-seed option — new code passes `attrs`.

Each pushed screen is an isolated surface (its own local `<variable>` state, preserved while
covered, restored on `pop`); `global.*` is shared. The APP web view (`DSXWebView`) is a single shared
instance — the stack never spins up a second one. For an EMBEDDED page (a partner checkout, a
docs panel, a mini-app shell) use the bare **`<WebView/>`** primitive instead: its own node-owned
web view with **no native bridge by construction** — the page gets only the neutral
`window.app.send(...)` channel. Attributes: `name` (the handle Dom verbs target —
`dsx.module.dom.eval({ target: "checkout", js: … })`), `src` (full URL, or a bare path on the app
host; alternatively the router's `path`/`origin` pair, so a `<WebView/>` can be a route's view),
`ephemeral` (`true` → non-persistent session). Events (payload = `dsx.this` scope):
`on:start`/`on:commit`/`on:finish` `{url, surface}` · `on:fail` `{url, surface, error, code}` ·
`on:message` `{data, surface}` (the page called `window.app.send`). `<DSXWebView/>` supports the same
navigation events plus `on:denied` `{origin, url, surface}` (the bridge gate refused a foreign
frame — `architecture/web-surface-policy.md`).

### Screen readiness — `settle` + `dsx.screen.settled()` <a id="screen-readiness"></a>

Every surface reports **one** unified lifecycle — `screen.loading` → `screen.ready`, plus the
reactive `dsx.screen.phase` / `dsx.screen.ready` — and the shell's spinner, splash reveal,
screen-capture guard and analytics all hang off it. A **web** screen (`<DSXWebView/>`) settles when its
page finishes (or fails) loading. A **native** screen (a DSX route/frame, `<DSXView/>`) settles by
the rule below. Nothing is required of ordinary markup: the default is correct.

| Spelling | Where | Meaning |
|---|---|---|
| *(nothing)* | — | **auto** — the screen settles on its **first completed render pass**. |
| `settle="manual"` | the **root** element only (the slot `exit=` occupies) | this screen settles **itself**; its first render does *not* settle it. |
| `dsx.screen.settled()` | any action / handler / `<script>` body | "this screen has settled" — settles the frame, **once**. |

Use `manual` when the first frame is not the real screen — the data has not landed, so settling
early would hide the spinner and reveal the splash over a skeleton:

```xml
<stack settle="manual">
  <head>
    <api as="orders" url="/api/orders" on:success="dsx.screen.settled()"
                                       on:error="dsx.screen.settled()"/>
  </head>
  …
</stack>
```

Rules worth knowing:

- **`settled()` is a call; `ready`/`phase` are values.** `dsx.screen.settled()` always carries `()`;
  `dsx.screen.ready` (bool) and `dsx.screen.phase` (`"loading"`/`"ready"`) are read-only reactive
  properties in the same namespace — never call them, never assign them.
- **At most once per screen.** Re-renders, repeat calls and a chatty screen can never re-fire it;
  a screen dismissed before it settles simply never settles (no late flash).
- **Harmless on an `auto` screen.** Calling it just settles that screen a beat early.
- **Always settle a `manual` screen** — on the failure path too (`on:error` above). A `manual` root
  in a file with no `dsx.screen.settled()` is a **lint error** (`lint_dsx.rb`), because at runtime
  that screen would hold the whole shell in `loading`: no splash reveal, no spinner clear, and on a
  hybrid app the *web* surface's consumers freeze too (one shared phase).
- **Nothing hangs forever anyway.** Every frame carries a bounded settle **deadline** (10 s,
  corpus-pinned, identical on all three renderers): if the screen never reports, the frame settles
  anyway. It is a fail-open backstop for a bug, not a budget to spend — write the settle call.
- **A screen that hosts `<DSXWebView/>` waits for the page.** A native frame that mounts the app's web
  view does not settle on its first render — it settles when that page finishes or fails, so the
  splash never reveals over a blank web view. Automatic; no markup involved.
- **Root-scoped.** `settle` is read from the **page root** (through a component reference, so a
  screen authored as a component declares it on its own root, not at each call site) and is
  ignored on non-root elements (the linter warns). Off a navigation frame — a mounted overlay, a
  bare render surface, a satellite (watch) screen — `dsx.screen.settled()` is a silent no-op.

The full model (the private `viewStart`/`viewFinish` reports, the coordinator, every consumer) is
[`screen-lifecycle.md`](./screen-lifecycle.md); the state machine is corpus-pinned in
`OpenSource/Conformance/lifecycle/`.

### Multi-line actions, control flow & JS syntax

Action bodies are **bounded JS** — full statement control flow, written across lines like
handwritten JS. **Bounded by construction:** every loop draws on a shared iteration budget
(100 000 per event) and aborts with a log past it, so remote DSX can never hang the app.

- **Branch** — `if (cond) { … } else if (c) { … } else { … }` (nestable); `switch (x) { case
  a: … break; default: … }` (JS fallthrough + `break`).
- **Loop** — `for (const x of arr) { … }`, `for (let i = 0; i < n; i++) { … }`,
  `while (cond) { … }`, with `break` / `continue` (`i++` / `i--` / `x += e` sugar).
- **Errors / exit** — `try { … } catch (e) { … } finally { … }`, `throw e`, `return`. A `try`
  is also **feature-detection**: calling an **unavailable module / undefined action** throws
  `{ code: 'unavailable', call }`, so `try { dsx.module.maybe.do() } catch { … }` degrades
  gracefully. (Outside a `try`, a missing optional-module call stays a silent no-op.)
- **JS statement forms** — `x = e` (store write), `arr.push(x)` / `.pop()` / `.splice(…)`
  (array mutations), `pkg.method({ a: x })` (module call), `dsx.send('x', { … })` /
  `dsx.event('x', { … })` / `dsx.broadcast('x', { … })` (events), `name()` (run an
  `<action>`), `{ id, qty }` object literal. `const`/`let` declare an execution-local
  (never the store).
- **Effect verbs (no JS form)** — `fetch:`, `animate:`, and `remove: … where` stay
  verb-prefixed, as leaf statements inside the JS control flow.
- **Multiline & comments** — a newline ends a statement (ASI) unless the line is unfinished
  (`x = a +`) or the next line can only continue it (`.method()` chains, `?` / `:`, `&&` / `||`);
  `//` and `/* … */` comments work (a bare `https://` URL in a verb is *not* a comment).

```xml
<pressable on:tap="
  if (dsx.variable.stock > 0) {
    const line = { id: dsx.this.id, qty: 1 };
    dsx.variable.cart.push(line);
    dsx.module.haptic.success();
  } else {
    dsx.module.haptic.error();
  }
"/>
```

Multi-statement bodies — loops, `switch`, `try`, or anything using `<` / `&&` — read best as a
named [`<action>`](#state): a **code-element body is read 1:1**, so write raw multi-line JS with
no XML escaping. Invoke with `name()` / `dsx.action.name()`.

```xml
<action as="checkout">
  // tally the in-stock lines, then settle the order
  let total = 0
  for (const line of dsx.variable.cart) {
    if (line.soldOut) continue
    total += line.price * line.qty
  }
  try {
    const r = await fetch('/order', { method: 'POST', body: { total } })
    if (r.error) throw r.error
    dsx.variable.orderId = r.data.id
  } catch (e) {
    dsx.event('checkoutFailed', { reason: e })
    return
  }
  dsx.module.haptic.success()
</action>
```

(An `on:` *attribute* is XML-parsed, so a body there must escape `<`→`&lt;` / `&&`→`&amp;&amp;` —
or just call a named `<action>`, whose code-element body needs no escaping.)

> Module calls pass an **options object** — `pkg.method({ a: x, b: y })`, not positional args.

### Component ↔ native communication & payloads <a id="comms"></a>

**`dsx.event` bubbles.** A raised event runs the nearest consumer's `on:<name>` handler — and that
handler executes **in the environment that declared it**, so re-raising the *same* name inside it
hops one level further up the mount chain (never back into itself). The relay idiom is therefore
legal and idiomatic at every depth, ending at the host's `ui.on(name)`:

```xml
<!-- Player.dsx — forward the rail's event to MY consumer (the host) -->
<PlayerRail on:download="dsx.event('download')"/>
<video on:ended="dsx.event('ended'); dsx.action.nextEpisode()"/>   <!-- notify host AND act locally -->
```

(Handler chains share the engine's bounded-execution ledger — a pathological cycle, e.g. an
action callback that re-raises its own event, is dropped with a console note at depth 32
instead of overflowing the stack.)

`dsx.send(…)` and `dsx.event(…)` are how components talk **internally** (to their
module and to their host). They carry a payload `[String: Any]` assembled from:

- **the row `item`** — inside a `list`/`grid` row, the tapped row's dict is the
  payload (`on:tap="dsx.send('goto')"` → `{ index, id, … }`); and
- **`arg:*` attributes** — typed inline args for non-row elements, interpolated and
  coerced (`arg:rate="1.5"` → `{ rate: 1.5 }`). `arg:*` wins on key clash with the item.

```xml
<grid bind="dsx.variable.episodes" columns="5">
  <row><vstack on:tap="dsx.send('goto')"> … </vstack></row>     <!-- payload = the episode item -->
</grid>
<text value="1.5×" on:tap="dsx.send('setspeed')" arg:rate="1.5"/> <!-- payload = { rate: 1.5 } -->
```
```swift
ui.on("goto")     { p in player.goTo(p["index"] as? Int ?? 0) }
ui.on("setspeed") { p in player.setRate(Float(p["rate"] as? Double ?? 1)) }
ui.on("close")    { player.dismiss() }     // no-arg overload — payload ignored
```

**Keep module calls for boundaries.** A component talking to the native code that
owns it should use `dsx.send(…)` (or `dsx.event(…)` → host `on:` → `dsx.send(…)`),
**not** `myscheme.…`. Routing internal taps through your own URL scheme leaks UI
plumbing into the public action namespace the web dispatches into. Expose as
module actions only what you mean to be public API; everything else stays a
`ui.on` handler. Full walkthrough: **StackUI.md → "How components talk to each
other"**.

---

## State — variables, computed, formulas & actions <a id="state"></a>

Declarations that give a screen reactive **data**, **derived values**, and
reusable **logic** — the read/derive/do model behind `{{ }}`, `bind`, and `on:`.
Declare them in the document **head** (the root element's first child — see
[`dsx-anatomy.md`](./dsx-anatomy.md); a surface root's head is hoisted at mount, so they
exist before anything renders); they render nothing. There are **two execution models**:

- **Actions** (`<action>`, and any `on:` attribute) **do** things — a statement
  sequence with side effects, **no return value** (see [Actions](#actions)).
- **Variables / computed / formulas** **compute** a value — a **pure** block whose
  value is its `return` (or last bare expression); they never write the store.

Variable/computed/formula/function bodies are **bounded JS** — `if (…) { } else if { } else { }`,
`const`/`let`, `return`, arrow fns. (`<action>` bodies are statement sequences with side effects —
see [Actions](#actions).) `dsx.this` is the current scope in any body.

| Tag | Runs | Produces |
|---|---|---|
| `<variable as="x">…</variable>` (`<var>` / `<let>`) | **once** | the initial value of a mutable store var — a store write (`x = …`) / `x.push(…)` / `bind` own it after |
| `<variable as="x" computed="true">` | **every read**, in the current scope (derives per list row over `item.*`) | a reactive, **read-only** value |
| `<formula as="x" a="…" b="…">` | **every read**; each attr is a **named input** evaluated at the use-site | a reactive value — a **reusable function** |
| `<action as="x" …>` | when invoked via `x()` | nothing (side effects) |
| `<watch value="…" on:change="…">` | whenever `value` settles to a **new** value | nothing — a reactive **observer** for side effects |
| `<script>function f(){…}</script>` | registers once | callable functions (positional args) for any body/expression |
| `<attribute as="x" default="…">` | declares once | a component INPUT (`dsx.attribute.x`) — THE contract: set by the invoking tag (`<C x="…"/>`), by mount verbs' `attrs:`, or natively (`ui.attribute`); reactive, passed beats `default=`, live changes fire `on:change` (see [`dsx-anatomy.md`](./dsx-anatomy.md)) |
| `<expects variable="x"/>` | declares once | the seed contract — state the mounting side must `ui.variable` (debug missing-seed log); `vars:` is the legacy mount-seed for it — new inputs are `<attribute>`s |
| `<event as="x" payload="a b"/>` | declares once | an event this component raises (`dsx.event('x')`) — the outbound contract, lint-checked |

### `<variable>` — state & derivations
```xml
<variable as="todos">return []</variable>                                  <!-- mutable, default once -->
<variable as="filter">'all'</variable>
<variable as="openCount" computed="true">dsx.variable.todos.filter(t => !t.done).length</variable>  <!-- reactive; one-liner → implicit return -->
```
The identifier is **`as`** (uniform across `<variable>` / `<formula>` / `<action>`; the legacy
bare `name=` identifier was removed). Computed is the **`computed="true"`** flag, not a separate tag.

A computed body is **pure** — its `const` / `let` / `x = e` write a
throwaway local scope, never the store — and **bounded** (no loops), so reading it
is side-effect-free and always terminates. A real store var (written with `x = …`) of
the same name overrides a default/computed.

**Return.** A single-expression body *is* the value — no `return` needed (like `openCount`
above, exactly like a JS `() => count(…)`). A multi-line body returns what you **`return`**;
once you branch with `if/else`, each arm returns. The same `openCount`, multi-line:
```xml
<variable as="openCount" computed="true">
  const open = dsx.variable.todos.filter(t => !t.done);
  return open.length
</variable>
```

### `<formula>` — a reactive function with named inputs
A `<formula>` is a computed value whose free variables are **declared inputs**: each
attribute is an expression evaluated *where the formula is read*, and the body uses
those names as locals. The same formula works in any scope that can supply its
inputs (a row, the screen, global) — explicit and reusable.

```xml
<formula as="lineTotal" qty="item.qty" price="item.price">
  return qty * price
</formula>
<formula as="label" done="item.done" text="item.text">
  return done ? '✓ ' + text : text
</formula>

<list bind="dsx.variable.cart" key="id">
  <text>{{ label }} — {{ lineTotal }}</text>      <!-- inputs bind to each row -->
</list>
```
Multi-line formulas are a full block (`if/else`, `const`, `return`):
```xml
<formula as="shipping" weight="item.kg" express="dsx.variable.rush">
  const base = weight * 2;
  if (express) { return base + 15; }
  return base;
</formula>
```
**Identifier — `as`.** The identifier is **`as`**, so every other attribute — including
one literally called `name` or `id` — is an input (a bare `name=` with no `as` is a legacy id):
```xml
<formula as="greet" name="dsx.variable.user.name">return 'Hi ' + name</formula>   <!-- `name` is an input -->
```

### `<action>` — named, reusable logic
The way to scale action logic past a couple of statements: define it once, invoke by
name with `name()`. Parameterized identically to `<formula>` (`as` +
input attrs, bound in the caller's scope when it runs).
```xml
<action as="addToCart" id="item.id" qty="1">
  dsx.variable.cart.push({ id: id, qty: qty });
  dsx.module.haptic.success()
</action>
<pressable on:tap="dsx.action.addToCart()"> … </pressable>   <!-- id/qty bind to the tapped row -->
```

### `<watch>` — a reactive observer (side effects on change)
Runs `on:change` whenever `value` (any expression) settles to a **new** value,
evaluated in the watch's own scope — a `<watch>` inside a list row observes that
row's `dsx.this`/`dsx.item` (one observer per row); a screen-level one observes
`dsx.variable`/`dsx.global`. In the handler, `dsx.this` is the new value (object/row →
`dsx.this.key`; scalar/array → `dsx.this.value`). `immediate="true"` also fires once
on mount.

```xml
<watch value="dsx.variable.prices" on:change="dsx.action.buildPaywall()"/>
```

Derive values with `<variable computed>` (pure, can't loop); reserve `<watch>`
for **side effects** — and never let a watcher rewrite its own dependency (the
evaluation budget aborts runaways, but it's a bug).

### `<script>` — a function library
`<script>function discount(cart) { … }</script>` registers every
`function name(params) { … }` as a callable (positional args, recursion
depth-capped) usable in any expression or action body. `<variable>` /
`<formula>` / `<action>` bodies register their inline `function`s the same way.
`<functions>` is the synonym tag; with `global="true"` —
`<functions global="true">…</functions>` — the block registers the **app-wide**
global function library instead: one table shared by every surface, last write
wins, a surface-local name shadows it (js-core.md "Shared logic"; corpus
`OpenSource/Conformance/functions/`).

### `<attribute>` — declare a component attribute
Inside a component definition: `<attribute as="accent" default="'#FF2D55'"/>`
declares the attribute's default (used when the consumer omits it — sugar for
"`dsx.attribute.accent` with a fallback"), and an optional `on:change="…"` watches
the consumer-supplied value.

> Full narrative + worked to-do app: **[state-and-computation.md](state-and-computation.md)**.

---

## Animations <a id="animations"></a>

**Enter/leave:** declare `transition` (+ optional `anim`/`animDuration`) on an
element and it animates whenever its `visible-if` flips — regardless of what
changed the var.

| `transition` | Effect (each combined with a fade) |
|---|---|
| `fade` | opacity |
| `scale` | scale + fade |
| `slide-top` / `slide-bottom` / `slide-left` / `slide-right` | move from that edge + fade |

| `anim` | Curve |
|---|---|
| `spring` | spring (response `0.4`, damping `0.8`; `animDuration` sets response) |
| `easeInOut` (default) / `easeIn` / `easeOut` / `linear` | named curve (`animDuration` = seconds) |

**Entry (`enter=`):** animates the element IN on first appear (HTML
`@starting-style`), using the same transition names + `anim`/`animDuration`:
`<vstack enter="slide-right" anim="spring">`. This is also how a whole **page**
animates in — present the surface `.overFullScreen` with `animated: false` and put
`enter=` on the root (the page behind shows through the slide). One vocabulary for
elements and pages; no separate presentation-transition system.

`enter=` is **layout-stable**: the element is at its *final* layout from the very
first frame — safe-area expansion (`ignoreSafeArea`), measurements and full-bleed
children are already resolved — and the animation is pure offset/opacity/scale.
A slide travels in from the **screen edge**; nothing is inserted, so the page
never re-lays out (no letterbox→full-screen jump) when the spring settles.

**Exit (`exit=`, root only):** the declarative twin for the way OUT. Put
`exit="slide-right"` (same vocabulary: `slide-top/bottom/left/right`, `fade`) on
the **root** and `StackSurface.dismiss(animated:)` (what a module's close path
calls) slides the page back out — `enter="slide-right" exit="slide-right"` is the
full iOS push/pop pair. Composes with `dismissEdge="left"`: the edge swipe already
moved the view off-screen, so the exit completes instantly and just tears down.

**Keep-painted:** `keep="true"` keeps the element mounted and fades opacity
(default `easeOut 0.18s`) instead of inserting/removing — use it for glass so it
never re-initializes (no flash).

**Value tweening:** bind an animatable style (`offset`, `opacity`, `width`,
`height`) and change it with `animate:` (declarative) or `ui.animate { }` /
`ui.set(_, _, animated: true)` (native).

---

## Lists <a id="lists"></a>

```xml
<list bind="dsx.variable.episodes" key="id" spacing="8">
  <row style="card" on:tap="app.open({ id: item.id })">
    <hstack>
      <text bind="item.title"/>
      <spacer/>
      <text bind="item.price" color="accent"/>
    </hstack>
  </row>
</list>
```

| Attribute | Default | Notes |
|---|---|---|
| `bind` | — | Store key holding an array of dictionaries. |
| `key` | `id` | Field used as the stable row identity (keyed diff). |
| `spacing` | `0` | Gap between rows. |

The single child is the **row template** (usually `<row>`); inside it, `item.*`
is that row's data. Update from native: `ui.list("k").set/insert/remove(id:)/
replace(id:,with:)/update(id:){ … }` — SwiftUI patches only the changed rows.

**The system default (system-defaults):** a fully **unstyled** vertical scrolling
list renders platform components — on iOS a real SwiftUI `List` in `.insetGrouped`;
on Android the existing keyed `LazyColumn` virtualizes real Material 3 `ListItem`
rows (Material defines the row identity but no list container). The gate is strict so
the landing is inert: any look-bearing attribute on the `<list>` element **or on the
row template's root** (background/style/spacing/align/padding/radius/color/…) keeps
the pre-law flat rendering byte-for-byte. Horizontal rails, `scroll="false"`
(fit-content) and sheet measuring always keep the flat path — a system list is greedy
and can't hug content. The list-construct features (`group_by`/swipe/reorder) use the
same real platform row path; Android does not imitate SwiftUI’s inset-grouped cards.

---

## Components <a id="components"></a>

**Inline definitions — a page in one file.** `<component as="Name">…</component>` registers
its subtree as a reusable component scoped to the current module, exactly like a
`Components/Name.dsx` file, and renders nothing where it stands. Combine with `<variable>` /
`<action>` and the whole page ships as ONE file (state + logic + UI + the wrapper).
Idempotent on re-render (same name + scope replaces);
an inline definition shadows a same-name file component in its scope. Define top-level,
single root (multiple children wrap in an implicit `vstack`).

**Positional list keys.** `key="index"` keys rows by POSITION — for data with no stable id
(chat messages, logs). A row missing its key field falls back to position automatically
(keyless rows used to collide on `""`).

Capitalized tags are reusable components (registered in code, or
folder-auto-registered — see `StackUI.md`).

- **Attributes down:** the tag's attributes become the component's local data
  (`{{ dsx.attribute.title }}`, `bind="dsx.attribute.title"`).
- **Events up:** the component raises `dsx.event('name')`; the host wires `on:name="…"`.
- **Slots:** `<slot/>` (default) and `<slot name="x"/>` render the children the
  caller passed (in the caller's data scope). Mark a child with `slot="x"` for a
  named slot.

```xml
<Card title="Episodes">
  <Row title="Weekly" on:select="dsx.send('buy')"/>   <!-- default slot -->
  <text slot="footer">Cancel anytime</text>     <!-- named slot -->
</Card>
```

### Where components come from

- **Module-local** — an `.dsx` file in a module's `Components/` folder. Scoped to
  that module (only its templates use it). File name = tag name.
- **Global / universal** — an `.dsx` file under
  **`DSX/Modules/Mandatory/Foundation/Components/`** (the `Core/` folder holds the
  shared set). Available to every module. Drop a `Card.dsx` there and any module
  can use `<Card/>`. See the folder's `README.md`.
- **Global native (Swift)** — a `.swift` file in the same tree declaring a
  `GlobalStackComponent` subclass, for components that need native state/gestures/views
  (e.g. `Drawer.swift` → `<Drawer/>`). It renders the consumer's XML via `context.slot()`
  and talks to the Stack via `emit`/`send`/`binding`. XML and native globals share one
  namespace (a same-name clash fails the build).
- **Inline** — `<component as="Name">…</component>` registers a component from inside
  any template (see [Components](#components) above).

### Built-in global components <a id="builtins"></a>

Ship with Foundation — usable from any module (or `<shared.X/>` when shadowed).
All are accessible by construction (grouped rows, labeled controls, decorative
icons hidden).

| Component | Attributes | Notes |
|---|---|---|
| `<Card>` | `bg` (default `fill`) · `radius` (16) · `padding` (16) | Rounded surface around its children (`<slot/>`). |
| `<EmptyState/>` | `title` · `message` · `icon` (`tray`) · `action` · `color` | The "nothing here yet" block; `action` renders a button raising `on:action`. Show via `visible-if`. |
| `<Skeleton/>` | `width` / `height` (14) / `radius` (8) — normal style attrs | Shimmering loading placeholder; compose lines/cards from several. Always hidden from assistive tech. |
| `<NavBar/>` | `title` · `system` (`true`) · `large` · `subtitle` · `back` · `backLabel` (`Back`) · `color` · `surface` | DEFAULT (`system="true"`): claims the REAL system navigation bar for the screen — system title (`large="true"` for large-title), the system back button (pop + edge-swipe already wired), iOS 26 Liquid Glass bar for free. `system="false"`: the custom centered-title bar (circular glass back raises `on:back`, trailing content via `slot="trailing"`) — use inside sheets (the system claim targets the top FRAME). |
| `<SettingsRow>` | `icon` · `iconBg` (`fill`) · `title` · `subtitle` · `value` · `chevron` · `tappable` | A disclosure row (`chevron="true"`) or explicit `tappable="true"` raises `on:tap` and reads as one button. A row with a slotted control stays static so the control keeps independent native semantics. |
| `<Table/>` | `bind` (rows) · `columns` (CSV labels) · `fields` (CSV keys; default = lowercased labels) · `color` | Plain text data table: header row (header trait) + one combined-utterance row per dict. For custom cells use `<grid>`. |
| `<AuthLogin/>` | `title` (`Welcome back`) · `subtitle` · `submitLabel` (`Sign in`) · `accent` · `forgot` · `signup` · `apple`/`google`/`facebook` | Email+password sign-in over `<form>/<field>` (state in the `authLogin` namespace — read `authLogin.values.email` etc.). The styled submit is validity-gated (invalid tap reveals all errors) and raises `on:submit`; optional social buttons raise `on:apple`/`on:google`/`on:facebook`; `on:forgot`/`on:signup` footers. Decoupled — wire the events to OAuth/Clerk/your backend. |
| `<AuthSignup/>` | `title` (`Create account`) · `subtitle` · `submitLabel` (`Sign up`) · `accent` · `name` · `terms` · `login` · `apple`/`google`/`facebook` | Account-creation sibling of `<AuthLogin>` (state in `authSignup`). Same decoupled event contract; `name`/`terms` add those fields; the `on:login` footer switches to sign-in. |
| `<VipCard/>` | `title` · `subtitle` · `price` · `productId` | The gold plan card (paywall rails); raises `on:tap` carrying its attributes. |
| `<Drawer>` | *(children)* | Swipe-to-dismiss native container (raises `on:close`). |

**Data-viz system elements (`Core/Charts`, `Core/Maps` — excludable via `Packages/Config/excluded.json`; lowercase like `<video>`, cross-platform contract):**

| Element | Key attributes | Notes |
|---|---|---|
| `<chart>` | `type` (`line`/`bar`/`area`/`point`) · `data` · `x` · `y` · `series` · `interpolation` (`smooth`/`step`) · `stacked` · `showPoints` · `xType` (`category`/`value`/`time`) · `yMin`/`yMax` · `xTitle`/`yTitle` · `xGrid`/`yGrid` · `color`/`colors` · `legend` · `ruleY` · `on:select` | Apple Swift Charts (iOS 16+). Multi-series, stacking/grouping, palettes, axis domains, reference lines, tap-to-select (`{x,y,series,index}`). Size with `height=`. Empty below iOS 16. Full table: [Charts README](../../../DSX/Modules/Core/Charts/README.md). |
| `<map>` | `lat`·`lon`·`zoom` · `style` (`standard`/`satellite`/`hybrid`) · `pins` (+`pinTitle`/`pinGlyph`/`pinColor`/`pinColorField`) · `route`·`routeColor`·`routeWidth` · `region`·`regionColor` · `circleLat`/`circleLon`/`circleRadius` · `userLocation` · `controls` · `interaction` · `on:tap` · `on:select` | MapKit `Map` (iOS 17+). Markers, polyline/polygon/circle overlays, user location, controls, map-tap + pin-select events. Size with `height=`. Empty below iOS 17. Full table: [Maps README](../../../DSX/Modules/Core/Maps/README.md). |

### Resolution & qualified names

Bare `<Card/>` resolves **module-local first, then global**. To address a specific
source explicitly — e.g. when a module has its own `Card` but wants the shared one —
use a `namespace.Name` tag:

| Tag | Resolves to |
| --- | --- |
| `<Card/>` | this module's `Card`, else the global `Card` |
| `<shared.Card/>` (or `<global.Card/>`) | the global `Card` (from a scheme-less module, e.g. `Foundation`) |
| `<store.PaywallVIP/>` | the `store` module's component (`scheme.Name`) — declare `store` under manifest `dependencies` |

Global component names must be unique across all scheme-less modules (the
build fails on a clash).

---

## `native:<name>` registry <a id="native-registry"></a>

The escape hatch for anything the catalog can't express (video, maps, charts,
custom gestures). A module registers a real native view; XML mounts it.

```swift
dsx.stack.register("feed") { attributes in AnyView(MyVideoView(zoom: attributes["zoom"])) }
```
```xml
<feed zoom="12"/>
```

The closure receives the element's **attributes** (`[String:String]`) and
returns any `AnyView`. Runs in-process like the rest of the surface.

---

## Reactive API (Swift) <a id="reactive-api"></a>

> Full guide: [`Skills/mounting-components.md`](../../Skills/mounting-components.md).

```swift
let ui = dsx.component.mount(.Player)          // THE way: a GENERATED ref — autocompleted,
dsx.component.mount(.verticalplayer.Episodes)  //   compile-checked (from the .dsx files)
dsx.component.mount("dsx.module.self.Player")    // dynamic/string form — for data-borne names (runtime)
dsx.stack.render(xml)                          // ESCAPE HATCH: raw markup (same mounts)
dsx.component.mount(.MiniBar, as: .overlay(.bottom))   // over the web view (passthrough)

ui.present(from: vc, animated: false)          // present .overFullScreen (page below)
present(ui.controller)                         // …or present the controller yourself

// the canonical trio — mirrors dsx.variable / dsx.action / dsx.attribute
ui.variable("paused", false)     // ⇄ dsx.variable.paused (set + chain; .state/.set = aliases)
ui.action("track", payload)      // ⇄ dsx.action.track() — run a markup <action>, dsx.this = payload
ui.attribute("accent", c)        // ⇄ dsx.attribute.accent — root-level attribute from native

ui.set("k", v, animated: true)   // animated set (tweens bound styles)
ui.animate(.spring) { … }        // batch mutations in one animation
ui.on("event") { … }             // markup dsx.event(…) → native
ui.onAny { name, payload in … }  // WILDCARD: every event, one tap (analytics/relay)
ui.node("#id").set("attr", "v")  // imperative attribute patch (+ animated:/.animate{})
ui.list("k").set(rows)           // …insert(_,at:)/remove(id:)/replace(id:,with:)/update(id:){}
ui.remove()                      // tear down an overlay
```

`mount(_, as:)` / `render(_, as:)` → `.screen` (default, present `.controller`) or
`.overlay(edge)` (`.bottom/.top/.leading/.trailing/.fill`, passthrough touches). Bottom
sheets stay declarative (`<sheet>` in the component, or `ui.sheet`).

**Page transitions reuse the animation engine** (no separate transition system).
Present `.overFullScreen` with `animated: false` (so the web view shows behind),
and give the **root element an `enter=`** animation — it plays on appear like
HTML's `@starting-style`, using the same `slide-*`/`fade`/`scale` + `anim`
vocabulary:

```xml
<vstack enter="slide-right" anim="spring"> … whole page … </vstack>
```

So a page slides/fades/scales in with the exact same names as element animations.
See [Animations](#animations) for `enter=`.

---

## Pixel-perfect checklist <a id="pixel-perfect"></a>

To match a design exactly:

1. **Alignment first.** Decide each container's `align` (vstack defaults to
   `leading`!). Center a control with `align="center"`, not stray spacers.
2. **Distribute with `spacer`.** One trailing spacer pins to the top; spacers on
   both sides center; a spacer between two items pushes them apart; a spacer
   before the last child pins it to the bottom.
3. **Float, don't inline.** To overlay an element at an edge (e.g. a side rail),
   make it its own `zstack` layer (`<hstack><spacer/><Rail/></hstack>`), not a
   row in the column.
4. **Exact spacing/size** are points: set `spacing`, `padding`, `width`,
   `height`, `fontSize`, `iconSize`, `radius` to the design's pt values. Defaults
   to know: button icon `20`, image icon `24`, progress height `6`, `radius` `0`
   (16/24 for surfaces).
5. **Colors** to the exact hex/`rgba`. `accent` is `#FF2D55` — override per
   element with `color` or theme via a bound `{{ accent }}`.
6. **Glass** is `surface="glass"` (+ `radius`); buttons are flat unless you add a
   `background`/`surface`. Keep glass painted across show/hide with `keep="true"`.
7. **Type** is `fontSize` + `fontWeight` (`regular/medium/semibold/bold/heavy`),
   or a named style (`heading`, `rowTitle`, `price`).
8. **Verify on device.** SwiftUI sizing (intrinsic vs. fill) is the usual source
   of "off by a bit" — set explicit `width`/`height` where a design demands it.
