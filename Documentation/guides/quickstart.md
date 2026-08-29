# Quickstart: a DSX app from nothing

Ten minutes, one command, no monorepo checkout. At the end you have a real DSX
application: a `.dsx` document that the Swift, Kotlin, and TypeScript kernels all render,
running in your browser and ready to build for a store.

> **Registry status.** The commands below resolve `@despia-native/*` and `create-dsx` from npm at
> **0.0.1**. Until that version is published, run the same flow from a checkout — see
> [From this repository](#from-this-repository) at the end. Every command on this page was
> executed against the actual package tarballs, not written from memory; the gate that
> keeps it that way is `npm run cold-start` in `OpenSource/Web`.

If instead you already have a **web app** you want to turn into a native app, that is a
different (and shorter) door: go to [Getting started](getting-started.md), which starts
from `window.dsx` inside the page you already have. Nothing on this page is a prerequisite
for that one.

## 1 · Scaffold

```sh
npm create dsx@latest my-app
cd my-app
npm install
```

You get a DSX **package**, which is the same shape a module inside Despia has:

```
my-app/
  dsx.json            package identity — the `scheme` that namespaces every component
  dsx.config.json     app config — entry component, output directory
  Components/App.dsx  the entry screen
  package.json        @despia-native/* dependencies + build / dev / lint scripts
```

Pass `--template routed` instead for a two-screen project with navigation.

## 2 · Run it

```sh
npm run dev
```

That builds the components, serves the result, and reloads the page when a `.dsx` file
changes. Open the printed URL.

## 3 · Read the screen you got

```xml
<stack style="gap: 1rem; padding: 2rem">
  <head>
    <attribute as="title" default="'Hello, DSX'"/>
    <variable as="count">return 0</variable>
    <action as="bump">
      dsx.variable.count = dsx.variable.count + 1;
    </action>
  </head>
  <text value="{{ dsx.attribute.title }}" style="font-size: 1.5rem; font-weight: 600"/>
  <text value="Tapped {{ dsx.variable.count }} times"/>
  <button label="Tap me" on:tap="dsx.action.bump()"/>
</stack>
```

Three rules explain the whole document, and they hold for every `.dsx` file you will ever
write ([full anatomy](../reference/dsx-anatomy.md)):

- **`<head>` is the contract, the state, and the logic.** `<attribute>` is what a caller
  may pass in, `<variable>` is this component's own state, `<action>` is behaviour.
- **The body is pure markup.** No logic hides in it. What you read is what renders.
- **`{{ }}` is an expression**, and so is an attribute default — which is why
  `default="'Hello, DSX'"` keeps its inner quotes: it is the JSE string literal, not the
  attribute's syntax.

The logic tier is **JSE**, JavaScript Expressions: JavaScript-shaped, deliberately not
JavaScript. It is total and budgeted, so bad input yields `null` and a log line instead of
throwing into your UI, and a runaway loop hits a budget instead of hanging the app. Read
[the JSE reference](../reference/jse.md), and specifically **"Not in JSE (on purpose)"**,
before porting existing JavaScript. The divergences are short and deliberate, and knowing
them up front costs you a minute; discovering them costs an afternoon.

## 4 · Change something

Edit `Components/App.dsx` while `npm run dev` is running:

```xml
<button label="Reset" on:tap="dsx.variable.count = 0"/>
```

The page reloads. Then check it the way CI will:

```sh
npm run lint
```

`dsx lint --strict` is the same markup law the runtimes enforce, so a document that lints
clean here is one all three kernels agree about.

## 5 · Build

```sh
npm run build
```

`dist/` now holds a complete static application: `index.html`, the compiled component
bundle, and the kernel and DOM runtime it needs. Serve that directory anywhere.

## Where to go next

| You want | Read |
|---|---|
| Every element, attribute, and value | [StackReference](../reference/StackReference.md) |
| Styling rules and the token ladder | [styling.md](styling.md) |
| State across screens, events between them | [state-and-events.md](state-and-events.md) |
| Native features (haptics, camera, purchases, push) | [the module catalog](packages/README.md) |
| A backend in the same grammar | [writing-a-backend.md](../../Skills/writing-a-backend.md) |
| Turning an existing web app native instead | [Getting started](getting-started.md) |
| Shipping a signed iOS build | [codemagic-build.md](codemagic-build.md) |

## From this repository

Before 0.0.1 is on the registry, or when you want to run against unreleased kernel
changes, scaffold against the workspace instead:

```sh
cd OpenSource/Web
npm install && npm run build
npm run create-dsx -- ../../../my-app --link "$PWD"
cd ../../../my-app && npm install && npm run build
```

`--link` writes `file:` dependencies pointing at the workspace packages rather than
registry versions, so the generated project consumes your local kernel. Everything else on
this page is identical.
