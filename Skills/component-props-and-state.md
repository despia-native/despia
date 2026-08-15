# Component props vs state — attributes vs variables

> Audience: component + module authors. The one rule that keeps a component reusable:
> **a component's EXTERNAL inputs are *attributes* (props); its INTERNAL mutable data is
> *variables* (state).** They are different namespaces with different verbs — don't mix them.
> Companion to [mounting-components.md](mounting-components.md) (how native code mounts a
> component) and [module-state.md](module-state.md) (cross-module declared values).

Think React: **props come in from the parent and the component does not own them; state is
the component's own and it mutates it.** DSX has the exact same split.

| | Props (inputs) | State (internal) |
|---|---|---|
| Called | **attribute** | **variable** |
| Like | a React prop / an HTML attribute | React `useState` |
| Owner | the **host/parent** passes them in | the **component** owns + mutates them |
| Set from native | `surface.attribute("src", "/demo")` | `surface.variable("paused", false)` |
| Set from markup | a tag attribute: `<Godot src="/demo"/>` | `set: x = …` / two-way `bind` |
| Read in markup | `dsx.attribute.src` (or just the prop) | `dsx.variable.paused` |
| Read in a native component | `dsx.string("src")` (tag) → `dsx.attribute.src` (mounted) | `dsx.variable.x` / `dsx.boundValue("x")` |
| Default | `<attribute as="src" default="…"/>` | the initial value you set |
| Mutates at runtime? | no — re-passed by the host | yes — that's the point |

## Setting them (the host / native side)

```swift
let ui = dsx.component.mount("Godot")
    .attribute("src", "/demo")        // PROP  → dsx.attribute.src   (external input)
    .attribute("origin", host)        // PROP
    .variable("paused", false)        // STATE → dsx.variable.paused (the component flips it)
ui.push(from: dsx, path: "/godot") { teardown() }
```

- `src`/`origin` are **inputs the host chose** → `attribute`.
- `paused`/`index`/`buffering` are **the component's own live state** → `variable`.

A quick litmus test: *would the parent set this when placing the component?* → **attribute**.
*Does the component change it while running?* → **variable**.

## Reading them

### In markup (`.dsx`)

```html
<!-- a prop with a declared default; the host's attribute() value wins over it -->
<attribute as="src" default="/home"/>

<Godot src="{{ src }}"/>          <!-- pass a prop down -->
<text value="{{ dsx.variable.score }}"/>   <!-- read state -->
```

### In a native component (`GlobalStackComponent`)

A native screen is reached **three** ways, so read a prop tag-first, then the mounted
attribute (one helper covers all three — inline tag, route frame, and `mount().attribute()`):

```swift
// inline:  <Godot src="/demo"/>                         → tag attribute
// route:   { "view": "Godot", "src": "/demo" }          → tag attribute (RouterHost sets it)
// mount:   mount("Godot").attribute("src", "/demo")     → dsx.attribute.src
private func prop(_ key: String) -> String {
    let tag = dsx.string(key)                                   // tag attribute (inline / route)
    return tag.isEmpty ? (dsx.boundValue("dsx.attribute.\(key)") as? String ?? "")   // mounted prop
                       : tag
}
```

`DSXView`/`Godot` are exactly this: the kernel renders a route as
`StackNode(tag: view, attrs: ["src": …, "origin": …])` (a tag attribute), and a module that
mounts the same component passes `src` with `.attribute(...)`. Same prop, both paths.

## Anti-patterns

- **Passing an input as a `variable`.** `mount("Godot").variable("src", …)` works mechanically
  but is wrong: `src` is an input, not the component's state. Use `.attribute`. Variables are
  for values the component itself owns and mutates (`paused`, `index`).
- **Mutating an attribute from inside the component.** Props are read-only to the child; if you
  need to change it, it's state — make it a `variable`, or raise an event (`dsx.event`/`dsx.run`)
  and let the host re-pass the attribute.
- **Inline XML to inject a prop.** Don't build `"<Godot src=\"\(x)\"/>"` with `dsx.stack.render`
  to pass a value — that's the escape hatch. Mount the component and set `.attribute(...)`.

## See also

- [mounting-components.md](mounting-components.md) — `dsx.component.mount`, `.on`, `.action`, `.push` vs `.present`.
- [module-state.md](module-state.md) — values one MODULE declares for OTHER modules (`dsx.module.<scheme>.state.<var>`), a different axis from a component's own props/state.
