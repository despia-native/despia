# Routing

A DSX app's screens are not files in a folder. They are a **table**: one declaration
mapping paths to components, compiled into your build and read by all three renderers.

This page is the whole model, and it opens with the part that decides how you ship.

## The line that matters: what updates over the air

Two layers, and only one of them is baked into the binary.

| Layer | Declared in | Ships via |
|---|---|---|
| Routes, screens, components, styles | `dsx.config.json` | **the OTA bundle** |
| The root, and app identity | `App.json` | **a store build** |

`dsx.config.json` is a build INPUT. `despia build` compiles it into `registry.json`
in your output, and `despia ota build` pins every file in that output into a signed
generation. So **adding a screen, changing a path, rewiring navigation or editing a
title is a bundle, not a store review.**

`App.json` holds almost nothing:

```json
{ "entry": { "root": "/", "surfaces": ["Home", "App"] } }
```

`root` is where the app starts. `surfaces` is the ordered candidate list for what
mounts at frame zero. There is no route table in it. The law, stated in the
architecture, is *the plan owns the root; the table owns navigation.* Changing the
SHAPE of the shell is a build; everything reachable from it is not.

## The table

```json
{
  "routes": [
    { "path": "/",          "component": "trails.App",      "meta": { "title": "Trails" } },
    { "path": "/trail/:id", "component": "trails.Detail" },
    { "path": "/settings",  "component": "trails.Settings" },
    { "path": "/files/*",   "component": "trails.Browser" }
  ],
  "notFound": "trails.Missing"
}
```

**Order is precedence.** First match wins, so put specific paths above general ones.

**Params.** `:id` and `{id}` are the same grammar and both bind one segment, readable
as `vars.id`. Query string lands in `vars` too, and on a name collision **the query
wins**. Query values are percent-decoded for you.

**Catch-all.** A trailing `*` soaks the remainder of the path. It binds NO param:
`/files/*` matching `/files/a/b` gives you the component and `vars: {}`. If you need
the tail, read it off the current path rather than expecting `vars.rest`.

**Unmatched paths** open `notFound`. Each renderer degrades in its own documented way
when there is no entry and no `notFound`.

This grammar is corpus-gated on every renderer
(`OpenSource/Conformance/router/resolve.json`), so a path resolves the same way on
iOS, Android and web or the build fails.

## Navigating

Navigation is **state**. Writing `route.path` navigates; the verbs are the ergonomic
form of the same write.

```js
dsx.module.route.push({ path: '/trail/42' })
dsx.module.route.pop()
dsx.module.route.replace({ path: '/settings' })
dsx.module.route.reset({ path: '/' })
```

Read the stack back through the `nav` plane: `nav.stack`, `nav.canPop`, `nav.depth`.
Because it is ordinary reactive state, a back button that should only appear when
there is something to pop is `visible-if="nav.canPop"` and nothing else.

**Back and close POP. They never `href`.** An `href` pushes, so wiring a back control
to one stacks a second copy of the previous screen underneath every tap. This is the
single most common routing mistake in generated code.

## Screens without a path

Not every screen belongs in the URL. Sheets, modals and pickers are **component
navigation**:

```js
dsx.component.push('Gallery')
dsx.component.present('Filters')
```

The rule of thumb: if a user should be able to link to it, bookmark it, or land on it
from a notification, give it a route. If it is a step inside a flow, push the
component.

## `href` and why your app is indexable

`<button>` and `<pressable>` take an `href`. On web and in SSR it renders a **real
`<a>`** that a crawler can follow; natively the same attribute performs a route push.

```dsx
<pressable href="/trail/42"><TrailRow bind="trail"/></pressable>
```

That is the whole reason a DSX app can be search-indexed without a second web build:
the markup is genuinely anchored, not a click handler pretending to be a link.

## Guards, redirects and capability gates

A route entry can carry three more fields:

- **`guard`** is a bounded predicate over `global.*` (session and entitlement state).
  Falsy follows `redirect` if one is declared, and otherwise skips the entry.
  It **fails open** by design: a guard is not a security boundary, it is a routing
  decision. Enforce authorisation on the server, in your `<server>` document.
- **`redirect`** sends a matched path to another one, depth-capped so a cycle cannot
  hang navigation.
- **`requires`** gates an entry on declared capabilities, so a route to a screen the
  build does not ship simply is not there.

## Deep links

The same table compiles into the native deep-link registry, so
`https://app.example/trail/42` opens the app and lands on `trails.Detail` with
`vars.id` set. You declare the route once; you do not write a second URL scheme.

## Common mistakes

- **Using `href` for back or close.** It pushes. Use `route.pop()`.
- **Expecting `*` to give you a param.** It does not. Read the path.
- **Ordering general routes above specific ones.** First match wins.
- **Treating `guard` as auth.** It is fail-open routing. Authorise on the server.
- **Putting a modal in the table.** If it is not linkable, push the component.

## See also

- `guides/state-and-events.md` — the store the `nav` plane lives in
- `guides/transport-and-ota-integrity.md` — signing the bundle your routes ship in
- `Skills/writing-an-app.md` — the screen-level patterns these routes connect
