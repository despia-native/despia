# Despia documentation

Despia is a **web-optional native runtime**: a fully dynamic kernel provides primitives,
**modules** provide everything else, and the surfaces you ship — web view, native UI, web
page, server, command line — are equal consumers of one native message bus. Your application
is **DespiaScript (DSX)**: plain-text `.dsx` documents (XML-style markup + JSE, a total,
budgeted, JavaScript-syntax logic tier) that the Swift, Kotlin, and TypeScript kernels all
render, held identical by one shared [conformance corpus](../Conformance/README.md).

## The 30-second model

One capability, one call shape, every node:

```js
// Web page — window.dsx
await window.dsx.module.haptic.success();
const { result } = await window.dsx.module.scanner();
```
```xml
<!-- DSX markup — the same call from a native screen -->
<button label="Share" on:tap="dsx.module.share.url({ url: dsx.variable.link })"/>
```
```swift
// Native (module code) — dsx.module
try await dsx.module.appsflyer.get_uid()     // await = result
try? dsx.module.haptic.success()             // bare = fire-and-forget
```
```dsx
<!-- Server — a <server> document's action body (backend-authoring.md) -->
<action as="create" inputs="title">
  const made = await dsx.module.data.order.create({ title: title })
  return { id: made.data.id }
</action>
```

- Each call routes to a **module** by its dotted chain (`haptic`, `watch.health`, …) — a
  folder with a `dsx.json` manifest and per-toolchain facets (`swift/`, `kotlin/`, `web/`).
  **File presence is the on/off switch**; a missing module degrades a feature, never bricks
  the app.
- Modules answer through one bus: resolve a promise, stream events, broadcast to
  `dsx.on(…)`, or write the shared reactive `global.*` store.
- **Screens are markup**: `.dsx` documents — head is the contract, state, and logic; body is
  pure markup. JSE interprets natively inside each kernel; a real JS engine exists only as a
  sandboxed escalation tier, never at the center.
- **The application spans five nodes**: iOS and Android render real SwiftUI and Jetpack
  Compose, the web kernel renders real DOM (with SSR), the **server is the fourth node**
  ([`backend-authoring.md`](architecture/proposals/backend-authoring.md)), and a
  **command-line program is the fifth**
  ([`cli-authoring.md`](architecture/proposals/cli-authoring.md)) — the `dsx` toolchain
  itself runs on a `.dsx` command table.
- (The pre-dot `window.virtual` / scheme-string forms are legacy — see
  [legacy.md](legacy.md); always call `window.dsx.module.<scheme>.<method>(…)`.)

## Where to start (by audience)

### 🚀 [Quickstart](guides/quickstart.md) — a DSX app from nothing
`npm create dsx`, one document, running in ten minutes.

### 🌐 [`guides/`](guides/) — the web app you already have
Point Despia at the app you already ship and every native feature is one `window.dsx` call
away — push, purchases, biometrics, GPS, no rewrite.
**[Start here →](guides/getting-started.md)**

### 🎨 Building native screens — the DSX markup layer
- [StackUI](reference/StackUI.md) — concepts: state, bindings, actions,
  components, animations.
- [StackReference](reference/StackReference.md) — the complete reference:
  every element, attribute, expression feature.
- [jse.md](reference/jse.md) — JSE, the expression/logic language (crypto,
  fetch, sockets, the budgets) — read "Not in JSE (on purpose)" before porting JS.

### 🖥 Backend and CLI — the same grammar off the screen
- [writing-a-backend.md](../Skills/writing-a-backend.md) — the shortest complete `<server>`
  document; deploy Supabase-first or to your own infrastructure.
- [cli-authoring.md](architecture/proposals/cli-authoring.md) — a command-line program as a
  `.dsx` document; `dsx doctor` is the shipped proof.

### 📦 [`../Skills/`](../Skills/) — writing modules
The authoring home (start with
[despiascript.md](../Skills/despiascript.md)): the `Package`/`dsx` runtime
API, the `dsx.json` manifest DSL, cross-module calls, mounting DSX from native,
storage/containers/cookies, **security**, **lifecycle**, Web-Crypto/JS-core in JSE,
and the Android (Kotlin) mapping.

### 🛠 [Closed Source framework docs](../../ClosedSource/Documentation/) — building the framework itself
The engine: [architecture](architecture/architecture.md), the
[`dsx` author API](reference/dsx-api.md), [events](reference/events.md),
[state & computation](reference/state-and-computation.md),
[engine capabilities](reference/engine-capabilities.md), audits, and the live
[ROADMAP.md](../../ClosedSource/Documentation/ROADMAP.md). **[Start here →](../../ClosedSource/Documentation/README.md)**

## Deep-dive references (authoritative)

- [`constitution.md`](architecture/constitution.md) — the architecture law: Articles 1–8 + the
  conformance ledger. Every change to the runtime is judged against it.
- [`../Conformance/`](../Conformance/README.md) — the shared fixture corpus that holds the
  three kernels identical. Parity is falsifiable; this is where you falsify it.
- [`on-device-ai.md`](architecture/on-device-ai.md) — **Despia as an AI-ready app framework**:
  the on-device inference runtimes, the two model-delivery mechanisms, and how an AI feature is
  just a module.
- [`KERNEL.md`](reference/KERNEL.md) — the kernel contract (node model, resolver,
  registries, build phases).
- [`OpenSource/Engine/`](../../OpenSource/Engine/) — the Swift and Kotlin kernel sources;
  [`OpenSource/Web/`](../../OpenSource/Web/) — the TypeScript kernel, compiler, DOM, and
  server packages (`@despia-native/*` on npm).
- [`scripts/README.md`](../../ClosedSource/scripts/README.md) — the toolchain
  (`prepare_modules.rb`, `prepare_config.rb`, **`lint_dsx.rb`**).
