# Despia

**Native to every platform.** Despia is a full-stack application
framework built around DSX (DespiaScript): you describe an application once, in plain text,
and it runs as real SwiftUI on iOS, real Jetpack Compose on Android, and real DOM on the
web. The same grammar builds your backend: APIs, data, workers, and MCP tools, and your
command-line programs. Nothing is emulated and nothing is wrapped: each platform gets its
own native kernel, and a shared conformance corpus holds all of them to identical behavior.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.0.1-orange.svg)](Documentation/RELEASING.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

This is the first public release. The framework behind it has been shipping commercial apps
since 2011; the language, the kernels, and everything in this repository are new, actively
developed by the full Despia team, and open to contributions from day one.

## The names, so nothing gets confused

- **Despia** is the framework and its ecosystem: this repository. Native to every platform.
- **DSX** is the language: one application document, and everything is written in it.
- **Despia Cloud** is the managed production layer: builds, signing, store delivery,
  hosting. Optional; everything here works without it.
- **Convert** is the migration path that turns an existing web app into a native one. It is
  the easiest way in if you already have a product, and it is one capability of the
  framework, not the framework.

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

## The same grammar is your backend

Despia is full stack. A `<server>` document declares your data, your logic, and your API in
the grammar you already know, and the tables, row-level security policies, migrations, route
handlers, and deploy plan are all emitted from it:

```xml
<server>
  <head>
    <entity as="order" ownership="owner">
      <field as="title" type="text"/>
      <field as="total" type="real"/>
    </entity>

    <action as="create" inputs="title, total">
      if (!title) { throw { reason: 'invalid', message: 'title is required' } }
      const made = await dsx.module.data.order.create({ title: title, total: total })
      return { id: made.data.id }
    </action>
  </head>

  <route method="POST" path="/orders"     action="create" auth="required"/>
  <route method="GET"  path="/orders"     entity="order" op="list" auth="required"/>
  <route method="GET"  path="/orders/:id" entity="order" op="get"  auth="required"/>
</server>
```

No TypeScript, no SQL, no handler boilerplate. Routes, background workers, and MCP tools
come from the same document; rejections are typed values with honest HTTP statuses; every
request runs inside declared budgets. Deploy targets are table-driven (Supabase, Firebase,
and Docker today), and TypeScript remains available as an explicit escape hatch when you
want it, not a requirement. The full law is
[backend authoring](Documentation/architecture/proposals/backend-authoring.md); the recipe
is [`Skills/writing-a-backend.md`](Skills/writing-a-backend.md).

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
7,500 commercial apps shipped on it before it was ever a product. It then went commercial
as a hosted platform for turning web apps into native apps, and more than 20,000 developers
use that flow through the cloud today. That capability lives on as **Convert**, and it is
still the fastest door in for a team with an existing web product. But it is one door, not
the house. Despia today is the full application framework in this repository: the language,
the kernels, the backend, the tooling, independently operated by
[Despia LLC-FZ](https://despia.com). The framework and the language are open source under
Apache 2.0; the managed deployment infrastructure and selected production modules remain
commercial, and that line is stated plainly wherever it runs. What that means practically:
web apps, PWAs, backends, and command-line tools build and ship entirely from this
repository; the native kernels are open source, embeddable, and portable; and the turnkey
production iOS and Android app assembly, signing, and store delivery are
[Despia Cloud](https://despia.com), the managed layer.

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
same source you can build for iOS and Android, render on the server, ship a PWA, and declare
your backend. The [quickstart](Documentation/guides/quickstart.md) walks the whole path.
Already have a web app? [Getting started](Documentation/guides/getting-started.md) covers
Convert, the migration door: your existing product becomes a native app first, and adopts
the rest of the framework at whatever pace suits you.

## What is in this repository

| Folder | What it is |
|---|---|
| [`Engine/`](Engine) | The kernel: Swift (iOS) and Kotlin (Android), plus the shared runtime files |
| [`Web/`](Web) | The TypeScript kernel: compiler, DOM renderer, SSR, CLI, scaffolder |
| [`AI/`](AI) | On-device inference: completions, embeddings, speech, vision, tool calling |
| [`Base/`](Base) | Despia Local, the on-device data plane: SQLite with vectors and snapshots |
| [`MCP/`](MCP) | Model Context Protocol, client and server, for apps |
| [`CanvasEditor/`](CanvasEditor) | The visual editor SDK: the node-tree view of a document |
| [`Conformance/`](Conformance) | The fixture corpus every kernel is held to |
| [`Documentation/`](Documentation) | Architecture, reference, and guides |
| [`Skills/`](Skills) | Focused how-to documents for authoring modules and apps |

## The ecosystem

| Repository | Role |
|---|---|
| [`despia`](https://github.com/despia-native/despia) | This repository: the framework, the docs, the issue tracker |
| [`despia-kernel`](https://github.com/despia-native/despia-kernel) | The portable execution contract: the native kernel, standalone |
| [`despia-ai`](https://github.com/despia-native/despia-ai) | Local intelligence: on-device inference, standalone package |
| [`despia-local`](https://github.com/despia-native/despia-local) | Local data: the on-device database, standalone package (not the backend; that is `@despia/server`) |
| [`despia-mcp`](https://github.com/despia-native/despia-mcp) | Apps that speak agent: MCP client and server, standalone package |
| [`despia-docs`](https://github.com/despia-native/despia-docs) | The documentation site, itself a Despia app |
| [`despia-example`](https://github.com/despia-native/despia-example) | One app on four surfaces, from published packages |

Docs live at [docs.despia.com](https://docs.despia.com) and in
[`Documentation/`](Documentation) right here. `llms.txt` at the root of this repository
indexes the tree for agents. One path note: this repository is generated from the Despia
monorepo, where the open tree lives in a folder named `OpenSource/`. A documentation path
written `OpenSource/X` is simply `X/` here.

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

[Apache License 2.0](LICENSE). The application framework and the language in this
repository are Apache-2.0, and each distributed folder carries its own `LICENSE` file, so
every package you install or mirror you clone is self-contained. The managed deployment
infrastructure (Despia Cloud) and the production module catalog remain commercial; where a
repository touches that boundary, its README says so plainly. The license grants no rights
to the Despia name or logo.

---

Proudly built in the United Arab Emirates 🇦🇪

Despia LLC-FZ · Dubai, United Arab Emirates · [despia.com](https://despia.com) · support@despia.com
