# StackKeys — DSX as a system keyboard (1:1 grammar, keyboard semantics)

`StackKeys.swift` renders a Stack **XML layout + state** into a **custom-keyboard
extension's SwiftUI**. It is the keyboard sibling of `StackLive` (widgets /
Live-Activities) and `StackWatch` (watchOS): **one grammar, a backend per surface**
(`StackNode.swift`). It consumes the same shared AST (`StackNode` / `StackXML` /
`StackScope`) and reuses `StackLive`'s element registry + recursion verbatim, overriding
only the tags a keyboard reads differently — `button` (a key) and `hstack` (a
flex-weighted key row).

```
 HOST APP (the bus)                shared App Group             KEYBOARD (this renderer)
 ──────────────────                ────────────────             ────────────────────────
 dsx.module.keyboard.layout({…})   KeyboardStore write    →     KeyboardModel.refresh → layout+vars
 dsx.module.keyboard.update({…})   (latest snapshot)            StackKeysView(node:vars:perform:)
   ▲ dsx.fire("keyboard.tap") ◄──  event queue, drained   ◄──     key tap → StackKeyAction
     (on app foreground)           on foreground                  event="x" → enqueue(name)
```

A keyboard is a **separate process on the same device**, so the App Group **is** the
transport (unlike the watch, a separate device riding WatchConnectivity) — see
[Skills/containers.md](../../Skills/containers.md). iOS gates that container behind the
user's **Full Access** consent; without it the keyboard renders its **bundled** layout
and the host channel is simply never read (the bundled floor, same guarantee as the
watch's BundledScreens).

## Why a render profile, not the full engine

Apple forbids downloaded code in a keyboard and the kernel's full runtime
(`Stack.swift`, `Router`) is UIKit-app-coupled, so the keyboard uses the **snapshot
model**: the host composes markup + vars, the keyboard renders a pure function of that
state. A tap never runs code — it collapses to ONE typed `StackKeyAction` value, and the
**target's** `UIInputViewController` (UIKit, outside the kernel) performs it against
`textDocumentProxy`. Rule 8 keeps `StackKeys.swift` UIKit/WebKit-free like every kernel
product.

## Key semantics (attributes on `button`)

| Attribute | Action |
|---|---|
| `insert="q"` | `.insert("q")` — types the text; single letters uppercase while shifted |
| `action="delete"` | `.delete` — press-and-hold repeats (0.45s delay, then 90ms); the repeat timer is cancellation-safe (`@GestureState` reset + `onDisappear`), so a cancelled touch or torn-down plane can never leave it running |
| `action="space"` / `"return"` | `.space` / `.newline` |
| `action="shift"` | `.shift` — the TARGET owns shift state; `stackKeyShifted` + `stackKeyLocale` case labels (one-character-preserving: ß stays ß, tr-TR i → İ) |
| `action="globe"` | `.globe` — renders as blank space when `stackKeyNeedsGlobe` is false |
| `action="layer:<name>"` | `.layer(name)` — the target swaps to the root child with `layer="<name>"` (validated target-side; unknown names are inert) |
| `action="dismiss"` | `.dismiss` |
| `event="x"` / `on:tap="dsx.event('x')"` | `.emit("x", payload:)` — the same relay contract as the watch (`StackReader.tapEvent`); `payload="…"` rides along as `{ value: … }` |

`flex="1.5"` weights a key's width within its row (default 1; interpolated like every
attribute; a half-key inset is `<spacer flex="0.5"/>`) — `weight` stays the **font**
weight, as everywhere else in the grammar. An `hstack` becomes a key row only when it
OPTS IN (a `button` child or a `flex=` child); otherwise it keeps StackLive's plain
container semantics, so pushed layouts can use hstack ordinarily. Key caps come from
`label=` / body text / `symbol=` (SF Symbol) / child elements (the watch button's
children-as-label contract); `bg=`, `color=`, `size=`, `radius=` restyle a key —
`KeyElement` declares `ownsLayoutBox`, so the generic layout box never re-paints
`bg=` behind the rounded cap or clips the cap's under-edge shadow. Control keys
default to the darker system key color, typing keys to the lighter, both theme-aware.
Row slots carry meaning-derived identity (position + tag + insert/action/event/label/
symbol), so a layout push or plane swap tears old key state down instead of migrating
a live press into whatever lands at that offset.

## Layers and geometry

The document root's `height=` (default 216) declares the keyboard height, and its
`start-layer=` names the plane a freshly adopted layout opens on (default: first
`layer=` child). Each root child carrying `layer="name"` is one switchable plane
(letters / symbols / more); the **target** selects the active plane — exactly like the
watch target owning routes. Shift is state, not a plane. A layout with no `layer=`
children renders whole.

## The element table is injected, not forked

`StackKeysView` installs its table (`StackBackend.elements` — which carries
`list`/`scroll`/`divider` for every tier — + the key overrides) through `StackLive`'s
`stackTable` environment at the root, plus four keyboard environment values:
`stackKeyPerform` (the action sink), `stackKeyShifted`, `stackKeyNeedsGlobe`,
`stackKeyLocale`. Widgets and the watch never see any of it. Same "register an
element, never grow a switch" rule, made injectable.

## Where the pieces live

| Piece | Home |
|---|---|
| Renderer (this doc) | `OpenSource/Engine/iOS/StackKeys.swift` — the `keys` runtime tier (`StackNode` + `StackScope` + `StackLive` + `StackKeys`) |
| Surface module | `ClosedSource/DSX/Modules/Core/Extensions/Keyboard/` — bridge, shared store, the `DespiaKeyboard` target, the bundled QWERTY |
| Authoring guide | that package's [README](../../../ClosedSource/DSX/Modules/Core/Extensions/Keyboard/README.md) |
