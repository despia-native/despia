# White-labeling — `dsx.global.strings` + `dsx.global.theme` (the platform convention)

The platform ships into **many different apps**. Nothing user-facing may be baked into a
module: not text, not brand colors. This skill defines the one convention every module
follows so white-labeling is a *platform property*, not a per-module re-invention.

## The three layers (most specific wins)

```
module defaults   ⊕   app-global (dsx.global.strings / dsx.global.theme)   ⊕   per-call payload
(English, stock     (set ONCE per app — re-skins every    (one start()/action call
 brand — in code)    adopting module at once)              overrides just itself)
```

| Layer | Who sets it | Where |
|---|---|---|
| Defaults | the module author | a Swift table (e.g. `VerticalPlayerStack.uiStrings`) / struct defaults |
| App-global | the app, once | `global.strings` / `global.theme` — from DSX (`dsx.global.strings.save = 'Guardar'`), web (`window.dsx.global`), or native (`DSX.state.setPath("strings", […])`) |
| Per-call | the caller | the action payload (`strings: { … }`, `theme: { … }`, `accentColor: …`) |

## The namespaces

- **`dsx.global.strings.*`** (≡ `global.strings`) — user-facing **text**. Flat keys, module-agnostic
  where possible (`save`, `cancel`, `retry`, `coins`) so one table serves many modules.
- **`dsx.global.theme.*`** (≡ `global.theme`) — **design tokens**: `accent`, `gold`, `coinIcon`,
  `coinColor`, … Swappable at runtime (dark mode, brand variants).

Markup reads them like any scope:

```xml
<text value="{{ dsx.global.strings.save || 'Save' }}"/>
<button gradient="{{ dsx.global.theme.accent || '#FF2D55' }}" …/>
```

## The module-author recipe (native modules)

Strings are **configuration, not state** — they ride ATTRIBUTES. Resolve once at mount,
set the merged table as a ROOT attribute, and components consume pure attributes:

```swift
// 1. defaults (the module's own table)
var str = Self.uiStrings
// 2. ⊕ the app-global table
if let app = DSX.state.getPath("strings") as? [String: Any] {
    for (k, v) in app { if let s = v as? String { str[k] = s } }
}
// 3. ⊕ this call's payload
for (k, v) in cfg.strings { str[k] = v }
for (k, v) in str { ui.attribute(k, v) }   // ONE ROOT ATTRIBUTE PER KEY — markup reads {{ dsx.attribute.save }}
```

Per-key (never a nested dict) so **every key is individually overridable** at every layer
of the engine's own cascade: **instance attribute** (`<Paywall unlockEpisode="…">` on a
consumer tag — a dict can't be passed through markup, single keys can) → **root runtime
attribute** (this mount's merged value, visible from any nested component) → **markup
default** (`<attribute as=… default=…>`). No magic surface variable; the tree stays
attribute-driven and portable. Root attributes are only reachable via the explicit
`dsx.attribute.` path — bare-name reads never see them — so generic keys can't collide.

Theme is the same merge shape — apply each layer through one function so "most specific
wins" falls out of call order (see `VerticalPlayerStackAccess.applyTheme`).

## Shared/standalone components (no owning module mount)

A shared-tier component (Core/Store, Foundation) can't assume a module mounted it.
Use the bare-name prop read (attr-or-store) with the `dsx.global.strings` fallback chain:

```xml
<text value="{{ label || dsx.global.strings.balance || 'Balance:' }}"/>
<!--        prop/state    app-global         default      -->
```

## Rules

1. **No user-facing literal in markup or Swift UI strings** — every literal goes through the
   table. (Lint-able: a future `lint_dsx` pass can flag bare text in shipped modules.)
2. **Keys are documented** in the module README (the player's table is the house example).
3. **Per-call always wins** — an app-global table must never make a specific call's override
   impossible.
4. **Don't seed app-global values from a module** — `global.strings`/`global.theme` belong
   to the APP. A module only *reads* them.

## Adopters

**`Core/Store`** (the paywall component tier): its literals resolve
`per-call prop ⊕ dsx.global.strings ⊕ default`, sharing the player's keys (`balance`,
`coinsCap`, `restore`, `vipHeader`) plus `offerEnds` — proof the convention is
one table serving many modules, not a per-module dialect.

## Reference adopter

`Custom/VerticalPlayerStack` resolves **strings** (30+ keys incl. the economy noun
`coins`/`coinsCap`), **theme** (`gold`, `goldGradient`, `coinIcon`, `coinColor`) and
**accent** through all three layers. Set once for the whole app:

```js
window.dsx.global  // ≡ global.* — e.g. from the web at boot:
//   global.strings = { coins: "gems", coinsCap: "Gems", save: "Guardar" }
//   global.theme   = { accent: "#7C4DFF", gold: "#E0B84C" }
```

…and every show the player opens — plus every future adopting module — re-skins at once.

## Localization vs white-label — two selectors

`dsx.global.strings` is **app-driven**: the app sets `global.strings`, and to localize it the app
picks the table per device locale. A module's OWN text can instead be **localized
config** — `{ "default": "…", "de-DE": "…" }` values that **auto-resolve to the device
language** with no app code (`self.config.x` / `dsx.config.x`; the platform runs the
locale ladder). Use **localized config** for a module's own translated defaults (and any
text that flows into the Info.plist — it also generates `.lproj` / `CFBundleLocalizations`),
and **`dsx.global.strings`** for the app's cross-module overrides. They compose, most specific wins:

```
module localized-config default   ⊕   app dsx.global.strings   ⊕   per-call payload
(automatic, per device locale)         (app-driven)        (one call)
```

Full picture (the four localization planes, `dsx.config` introspection, `.lproj`
generation): **[localization.md](localization.md)**.

> Spelling: white-label text/tokens live at `dsx.global.strings.*` / `dsx.global.theme.*` (DSX) ↔
> `dsx.global.strings.*` / `dsx.global.theme.*` (native). The old `$strings` / `$theme` namespace
> aliases were removed — `dsx.global.*` is the one store access (see [global-state.md](global-state.md)).
