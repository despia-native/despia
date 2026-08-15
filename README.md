# Despia

**One document, every platform.** Despia is an application framework built around DSX
(DespiaScript): you describe an application once, in plain text, and it runs as real SwiftUI
on iOS, real Jetpack Compose on Android, and real DOM on the web. The same grammar writes
your backend routes and your command-line tools. Nothing is emulated and nothing is wrapped:
each platform gets its own native kernel, and a shared conformance corpus holds all of them
to identical behavior.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.0.1-orange.svg)](Documentation/RELEASING.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

This is the first public release. The framework behind it has been shipping commercial apps
since 2011; the language, the kernels, and everything in this repository are new, actively
developed by the full Despia team, and open to contributions from day one.

## What a Despia app looks like

A `.dsx` document has a head (state and logic) and a body (pure markup). This is a complete,
working screen:

```xml
<vstack padding="20" spacing="12">
  <head>
    <variable as="count">return 0</variable>
    <action as="add">dsx.variable.count = dsx.variable.count + 1</action>
  </head>

  <text value="{{ dsx.variable.count }}" style="font-size: 2rem; font-weight: 700"/>
  <button label="Add one" on:tap="add()"/>
</vstack>
```

The `vstack` is a `VStack` on iOS, a `Column` on Android, and a flex column on the web.
State is reactive, expressions are JavaScript, and the document is the single source of
truth on every platform.

## One codebase, five nodes

| Node | Renders as | Where it lives |
|---|---|---|
| iOS | SwiftUI | [`Engine/iOS`](Engine/iOS) |
| Android | Jetpack Compose | [`Engine/Android`](Engine/Android) |
| Web | DOM, with SSR and hydration | [`Web`](Web) (`@despia/*` on npm) |
| Server | Backend routes, workers, and MCP tools authored in DSX | [`Web/packages/server`](Web/packages/server) |
| CLI | Command-line programs as `.dsx` documents | [`Web/packages/cli`](Web/packages/cli) |

The claim that these behave identically is not marketing: it is falsifiable. Every kernel
runs the same fixture corpus in [`Conformance/`](Conformance), and a behavior change that
does not land on every runtime fails a gate before it ships.

## Readable by people who do not read code

DSX is designed for how software is actually built now: by developers, by AI, and by people
who are neither but own the product. The markup you see above translates one to one into a
visual node tree, so a designer or a domain expert can review the exact logic of a screen
as a flowchart instead of trusting a summary of it. There is no lossy DSL in between, no
JSON blob pretending to be a language, and no generated code that only a machine can read.
The document is the app, whether you read it as text or as a diagram.

AI is optional everywhere. We built DSX because we wanted to build our own products faster
in the age of AI without giving up security, quality, or the human in the loop. The result
is a language that models write well and people verify easily, and that turned out to
matter just as much between humans: our developers, our designers, and our marketing team
review the same documents.

## Where Despia comes from

Despia has been around longer than the name. The framework started in 2011 at Jocapps, a
German software development studio, as the internal foundation for client work; more than
7,500 commercial apps shipped on it before it was ever a product. It then became the Despia
platform, a hosted way to turn web apps into native apps, which today serves more than
20,000 developers through its cloud deployment flow. That platform is now one feature of
something bigger: DSX, the full development framework in this repository, independently
operated by [Despia LLC-FZ](https://despia.com) and open source under Apache 2.0. You can
build and ship entirely from this repository, or use the [cloud platform](https://despia.com)
when you want managed builds, signing, and store delivery.

## Despia is built with Despia

We are user number one. The despia.com landing page, the dashboard, our APIs, our MCP
servers, and the [documentation site](https://github.com/despia-native/despia-docs) are
Despia apps, built from the same published packages you install. When something is awkward,
we hit it before you do. That is the standard the framework is held to, and it is why the
tooling ships as real packages instead of a private build system.

## Getting started

```sh
npm create dsx@latest my-app
cd my-app
npm install
npm run dev
```

That scaffolds a DSX package, serves it in your browser, and watches for changes. From the
same source you can build for iOS and Android, render on the server, or ship a PWA. The
[quickstart](Documentation/guides/quickstart.md) walks the whole path, and
[getting started](Documentation/guides/getting-started.md) covers the other door: adding
native capability to a web app you already have.

## What is in this repository

| Folder | What it is |
|---|---|
| [`Engine/`](Engine) | The kernel: Swift (iOS) and Kotlin (Android), plus the shared runtime files |
| [`Web/`](Web) | The TypeScript kernel: compiler, DOM renderer, SSR, CLI, scaffolder |
| [`AI/`](AI) | On-device inference: completions, embeddings, speech, vision, tool calling |
| [`Base/`](Base) | Despiabase, the on-device data plane: SQLite with vectors and snapshots |
| [`MCP/`](MCP) | Model Context Protocol, client and server, for apps |
| [`CanvasEditor/`](CanvasEditor) | The visual editor SDK: the node-tree view of a document |
| [`Conformance/`](Conformance) | The fixture corpus every kernel is held to |
| [`Documentation/`](Documentation) | Architecture, reference, and guides |
| [`Skills/`](Skills) | Focused how-to documents for authoring modules and apps |

## The ecosystem

| Repository | Role |
|---|---|
| [`despia`](https://github.com/despia-native/despia) | This repository: the framework, the docs, the issue tracker |
| [`despia-kernel`](https://github.com/despia-native/despia-kernel) | The native kernel, standalone |
| [`despia-ai`](https://github.com/despia-native/despia-ai) | On-device AI, standalone package |
| [`despiabase`](https://github.com/despia-native/despiabase) | The on-device data plane, standalone package |
| [`despia-mcp`](https://github.com/despia-native/despia-mcp) | MCP for apps, standalone package |
| [`despia-docs`](https://github.com/despia-native/despia-docs) | The documentation site, itself a Despia app |
| [`despia-example`](https://github.com/despia-native/despia-example) | One app on four surfaces, from published packages |

Docs live at [docs.despia.com](https://docs.despia.com) and in
[`Documentation/`](Documentation) right here. `llms.txt` at the root of this repository
indexes the tree for agents.

## Contributing

Issues and pull requests are welcome here, and we mean that plainly: this repository is the
single tracker for the framework, the team triages it as part of daily work, and reported
bugs get owned. PRs are imported into our monorepo with your authorship preserved, the full
gate suite runs there, and the next sync closes your PR with a reference to the landed
commit. Forking is fine and expected; the license places no surprises in your way.

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow, the fixtures-first rule for new
authoring surface, and the DCO sign-off. Security reports go through
[`SECURITY.md`](SECURITY.md), never public issues.

## Versioning

Current version: **0.0.1**, the first public release. Versioning follows
[`Documentation/RELEASING.md`](Documentation/RELEASING.md): every package starts at `0.0.x`
with no compatibility promised between patches, `0.1.0` means the shape has settled, and
`1.0.0` means the API is a contract. Releases are signed tags with the changelog attached.
We would rather earn a version number than claim one.

## License

[Apache License 2.0](LICENSE). Each distributed folder carries its own `LICENSE` file, so
every package you install or mirror you clone is self-contained. The license grants no
rights to the Despia name or logo.

---

Despia LLC-FZ, Meydan Grandstand, 6th Floor, Meydan Road, Nad Al Sheba, Dubai,
United Arab Emirates. [despia.com](https://despia.com) · support@despia.com
