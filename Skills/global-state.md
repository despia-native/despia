# Global app state — `global.*`

> Audience: app authors building with DSX / DespiaScript.

One app-wide **reactive** store, shared by everything in the app — native Stack
routes, modules, components, and the web layer (a `DSXWebView` web view). Write it in
one place and every reader updates: a native paywall flips `premium` and the web
app reflects it instantly, with no reload; the web logs a user in and native routes
react.

This is the layer you reach for **auth, entitlements, credits, theme, the current
route, feature flags** — anything more than one screen or platform needs.

---

## The four layers — use the smallest one that fits

Do **not** make everything global. Pick the tightest scope:

| Layer | Where it lives | Reach | Use for |
|---|---|---|---|
| **Global** — `global.*` | the app-wide store (`DSX.state`) | every route / node + the web | auth, entitlements, credits, theme, route, flags |
| **Surface** — bare names | the screen's `StackStore` | one screen / surface | drawer open, selected tab, form values |
| **Component** — SwiftUI `@State` | one native view | one view | drag offset, gesture, animation |
| **Web** — React/Vue/Svelte state | inside a `DSXWebView` | one web route | the web UI's own internals |

Rule of thumb: **shared across routes or platforms → `global`. Otherwise → keep it
local.**

> **Typed, per-module values → package state.** When one module *owns* a value another module reads (a
> flag, an id, a list), don't hand-roll it into the global bag — declare it in the owner's `dsx.json`
> `context` block and read it typed + exclusion-safe as `dsx.module.<scheme>.context.<var>`. Live context vars
> physically live in this same store (under `<scheme>.<var>`); `context` is just the declared, typed face on
> that slice. See [module-state.md](module-state.md).

---

## Read it (XML / Stack)

`global.` is a reserved namespace in every `{{ }}` expression and `visible-if`.
Dot-paths address nested keys:

```xml
<text>{{ global.session.credits }} credits</text>

<route path="/premium" visible-if="global.session.premium"/>

<vstack visible-if="global.theme == 'dark'"> … </vstack>
```

`global.*` is **reactive** — when the value changes (from anywhere: native, web, a
module), every element that reads it re-renders automatically.

> `dsx.global.x` ≡ `global.x` (the `$` prefix only disambiguates from a surface var). White-label text
> and design tokens are just paths under it — `dsx.global.strings.*` / `dsx.global.theme.*` (the old
> `$strings` / `$theme` namespace aliases were removed; see [white-label.md](white-label.md)).

## Write it (XML / Stack)

Assign a `global.` key (a bare key writes the *surface* store instead):

```xml
<button on:tap="global.session.premium = true">Upgrade</button>
<toggle on:change="global.theme = 'dark'"/>
```

> The bare assignment above is the only form — the legacy `set:` verb has been removed (JSE; see [`jse.md`](../Documentation/reference/jse.md)).

---

## Native (modules & components) — `dsx.global`

Every `dsx` (a module handler or a component `body`) carries `dsx.global`:

```swift
// READ — dot notation (preferred); the Swift twin of {{ dsx.global.session.credits }}:
let credits = dsx.global.session.credits.int ?? 0    // .string / .bool / .double / .list / .dict / .exists
let save    = dsx.global.strings.save.string ?? "Save"   // optional leaf → clean `?? default`

// WRITE / seed — dot-path strings:
dsx.global.set("session.credits", 200)               // write a dot-path (creates nesting)
dsx.global.state("session", ["userId": "1",          // seed / replace a whole top-level key
                             "premium": false,
                             "credits": 120])

let raw = dsx.global.get("session.credits")          // get(path) → Any? stays for dynamic paths
```

A folder component reads it in its `body` (it's a class func, so `dsx.global`):

```swift
final class CreditsBadge: GlobalStackComponent {
    override class func body(_ dsx: StackComponentContext) -> AnyView {
        let n = dsx.global.session.credits.int ?? 0
        return AnyView(Text("\(n)"))
    }
}
```

Any write — native or web — re-renders every Stack view reading `global.*`.

---

## Web (`DSXWebView` / any web view) — `window.dsx.global`

The same store, over the page bridge — so the web app is a **consumer** of DSX
state, not the owner of it (legacy pages keep the `window.despia.global` alias
spelling; same sugar, same engine):

```js
// READ — resolve-once
const session = await dsx.global.get("session");

// WRITE — a dot-path
await dsx.global.set("session.credits", 200);

// WATCH — reactive: called with the current value now, and on every change
const sub = dsx.global.watch("session", (session) => {
  render(session.credits);
});
// later:
sub.stop();
```

`watch` streams the **current** value immediately, then on every change (deduped —
an unrelated key changing won't re-fire your handler). `set` and `get` return
Promises.

End-to-end, one store:

```swift
dsx.global.set("session.premium", true)            // native paywall
```
```js
dsx.global.watch("session", s => paint(s));        // web reacts live, no reload
```
```xml
<route path="/premium" visible-if="global.session.premium"/>   <!-- native route reacts -->
```

---

## How it works (under the hood)

- `global.*` is a single reactive `StackStore` singleton (`DSX.state`). The Stack
  renderer observes it, so a write re-renders every view that reads `global.*`.
- The web side is the **`global://`** module (`global://get|set|watch` — the State
  module, scheme `global`, legacy alias `state`) riding the existing page transport;
  `window.dsx.global` (legacy `window.despia.global`) is sugar on top. No new bridge.
- Writes coalesce per top-level key; `watch` dedupes by serialized value.

## Gotchas

- **Dot-paths create nesting.** `set("session.credits", 200)` makes
  `{ session: { credits: 200 } }`. Read it back as `global.session.credits`.
- **`global.` is explicit.** A bare `{{ credits }}` reads the *surface* store, never
  global — so a screen-local var can't accidentally shadow app state.
- **Don't over-global.** Form values, a tab index, a drawer's open state belong in
  the surface store (bare names), not `global`.
- **Reserved namespaces.** The kernel and its maintainers own some top-level keys —
  `nav`, `screen`, `app`, `route`, `dsx` (diagnostics), `source` (provenance —
  `dsx.source.<plane>.state`, Source.swift) — plus every module's context slice
  (`<scheme>.*`). Read them freely; never write them from app markup.
- **Persistence / widgets:** in-process today. Cross-process sharing (widgets,
  watch) lands with the target-node work; design keys you'll share with that in mind.

See also: `runtime-api.md` (the full page surface — `window.dsx`, legacy `window.despia`), `writing-a-module.md`,
and `../Documentation/reference/KERNEL.md` (the architecture).
