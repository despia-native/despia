# @despia-native/cli

The DSX web toolchain, and the **CLI node** it runs on.

```sh
dsx build          # compile a project into a deployable static site
dsx dev            # build, serve, watch, reload
dsx lint --strict  # static validation of DSX markup + JSE bodies
dsx doctor         # check a project for the mistakes that make a build fail later
dsx edit           # the visual editor, served locally against this project
dsx ota build      # over-the-air content: build, publish, roll back
dsx export all     # a real Xcode + Android Studio project from your own modules
```

Inside this repository, run it without installing anything:

```sh
cd OpenSource/Web
npm run dsx -- build --project ../../path/to/app
node packages/cli/bin/dsx.ts lint --package ../../ClosedSource/DSX/Modules
```

ESM only. Node ≥ 22.18.

## `dsx` runs on a `.dsx` document

`src/dsx.cli.dsx` is this toolchain's command surface: every command, every flag, the usage
text, and the whole implementation of `doctor`. `cli.ts` reads it at startup and dispatches
from it, so a command cannot exist in `--help` and not in the parser, or accept a flag the
help never mentions.

`build`, `dev`, `lint`, `edit`, `ota` and `export` declare `handler=` and keep their
TypeScript; `doctor` declares `action=` and is DSX all the way down. Full design:
`cli-authoring.md`. The export path (a complete native project from your own module folder,
kernel vendored, nothing withheld) is documented in the framework guide `native-export.md`.

## Build your own

The node is exported, because a node nobody else can use is a demo.

```ts
import { readCliDocument, dispatch, runDeclaredCommand, usage } from "@despia-native/cli";
import { readFileSync } from "node:fs";

const doc = readCliDocument(readFileSync("my.cli.dsx", "utf8"), "my.cli.dsx");
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help")) { console.log(usage(doc)); process.exit(0); }

const { command, inputs } = dispatch(doc, argv);
const { code } = await runDeclaredCommand(doc, doc.actions.get(command.action!)!, inputs, {
  cwd: process.cwd(),
  io: { out: console.log, err: console.error },
});
process.exitCode = code;
```

```dsx
<cli as="wc" version="1.0.0" summary="count words">
  <head>
    <root as="here" path="."/>
    <action as="count" inputs="files">
      dsx.variable.total = 0
      for (const name of files) {
        const read = await dsx.module.fs.read({ root: 'here', path: name })
        if (!read.ok) { throw { reason: 'not_found', message: name } }
        dsx.variable.total = dsx.variable.total + read.data.split(/\s+/).filter(w => w.length > 0).length
      }
      dsx.module.out.print({ text: 'total ' + dsx.variable.total })
      return 0
    </action>
  </head>
  <command as="count" action="count" summary="count words">
    <positional as="files" variadic="true"/>
  </command>
</cli>
```

A body reaches `out` · `env` · `fs` · `exec` and nothing else, and each is scoped by what the
head declared: `<root>` bounds the filesystem, `<env>` names the readable variables, `<exec>`
names the runnable programs. Undeclared means refused. There is no `import`, no `require`, no
`process` - not by policy but because JSE has no name for them.

## The project contract

A DSX project **is** a DSX package: `dsx.json` (identity + `scheme`) plus
`Components/**/*.dsx` - exactly the shape `buildRegistry` consumes for a module in the
monorepo. `dsx.config.json` adds only what a standalone app needs:

```json
{
  "name": "My App",
  "entry": "App",
  "outDir": "dist",
  "packages": ["../design-system"],
  "routes": [{ "path": "/", "component": "myapp.App", "meta": { "title": "My App" } }],
  "router": { "transition": "dsx" },
  "lang": "en",
  "theme": "dark",
  "app": { "name": "My App", "version": "1.0.0", "build": "web", "env": "debug" }
}
```

`entry` is qualified against the package `scheme` when it has no dot (`"App"` →
`"myapp.App"`). Every relative path resolves against the project root. Scaffold all of this
with [`create-dsx`](../create-dsx/).

## `dsx build`

Wraps the existing compile path - it does not reimplement it:

| Step | Who does it |
|---|---|
| `.dsx` → component IR + owner-scoped CSS | `@despia-native/compiler` `buildRegistry` |
| IR → a full SSR'd document (title/meta/og, the inlined cascade, hydration stamps) | `@despia-native/server` `renderPage` |
| one document per static route | `@despia-native/server` `exportStatic` |
| runtime ESM | the installed `@despia-native/{kernel,compiler,dom}` `dist/`, copied into `dist/vendor/` |

Output: `index.html` (plus `<route>/index.html` per static route), `registry.json`,
`main.js` (a bootloader that owns zero behavior), `vendor/**`, and anything in `public/`.

The import map is **derived** from the vendored graph - every bare `@despia-native/*` specifier the
copied `.js` files import must resolve to a file that was actually vendored, or the build
fails. A missing entry otherwise survives every other gate and becomes a blank page.

`dsx build --demo` builds *this repository's* demo instead, by spawning
`packages/compiler/bin/build-demo.ts` (a top-level script bound to the repo layout, so a
child process is the only correct way to invoke it) after ensuring `OpenSource/Web/dist`
exists.

### What `dsx build` does NOT do

- **No bundler, no minifier, no code splitting.** The runtime ships as the packages' own ESM
  behind an import map. Application-level bundling is [`@despia-native/vite-plugin`](../vite-plugin/)'s job.
- **No `<api>` prefetch at build time.** It uses the sync `renderPage`; `renderPageAsync`
  (SSR data seeding) is the open W6 live-adapter seam, not a static-export behavior.
- **No dynamic routes.** `exportStatic` skips `:param` / `{param}` / `*` paths, which need a
  live server. The SPA shell still cold-loads them client-side.
- **No web-component embeds.** `web.expose` artifacts are the demo builder's job (`/web/13`).
- **No module web facets.** A project build compiles components; it does not bundle module
  `web/index.js` chunks or register them.
- **No hashing, no asset pipeline, no image processing.** `public/` is copied verbatim.

## `dsx dev`

Builds, serves `outDir`, watches the project, rebuilds on change, and pushes a reload to open
browsers over one Server-Sent Events channel (`/__dsx_dev_reload`). Every 200 carries
`cache-control: no-store` - the same policy, for the same reason, as the repository's own
`packages/compiler/bin/serve.ts`. A failing build is served as a 500 error page, never as a
stale document, and the page recovers on the next good build.

`dsx dev --demo` hands off to `packages/compiler/bin/serve.ts` `startServer` - the
repository's own dev/CI server, with its embed CORS and DSD fragment endpoint intact.

### What `dsx dev` does NOT do

- **No hot module replacement.** A change is a full rebuild and a full page reload; component
  state is lost. (Neither does `@despia-native/vite-plugin` v0.1.)
- **No HTTPS, no proxy, no middleware.** It serves files and one SSE endpoint.
- **No `<api>` mocking.** Requests go wherever the markup points them.
- Note: the open SSE stream means a browser automation tool will never observe
  `networkidle` on a `dsx dev` page - wait for `load` instead.

## `dsx lint`

The TypeScript twin of `ClosedSource/scripts/lint_dsx.rb`, for the surface a CLI can see.
Same findings, same wording, same severity ladder (`error` / `warning` / `notice`, where a
notice is printed and never counted by `--strict`), same exit codes: `0` clean, `1` on any
error, or on any warning under `--strict`.

**Gated parity, two tethers** (`test/lint-corpus.test.ts`, runs in `npm test`): every
fixture in the shared anti-drift corpus (`OpenSource/Conformance/lint/cases/shared/`) must
produce the expected `(line, level, rule)` set through this linter, the same comparison
`lint_conformance.rb` makes for the Ruby gate; and this linter's `BUILTIN_TAGS` must equal
the tag table in `Conformance/lint/facts.json` byte for byte, because a hand-maintained copy
of a rule table is exactly the thing that drifts (the gate caught a real twelve-tag
divergence on its first run). Beyond the corpus: measured over this repository's `.dsx`
files, `lint_dsx.rb` and `dsx lint --package ClosedSource/DSX/Modules` produce identical
findings, and on a hostile fixture exercising 21 findings across 16 rules the two outputs
match line for line - same lines, same order, same counts.

Implemented, ported rule for rule:

| | |
|---|---|
| well-formedness | one root, tag balance, unterminated tags - through `@despia-native/compiler`'s `parseDsx`, the TS twin of the runtime's own parser |
| comments | `--` inside a comment (fatal in XML); a code-tag name written in comment prose |
| document anatomy | `<head>` is the first child, once, never the root; declarations live in the head; canonical head order and same-kind contiguity; `<watch>` inside a list/grid/pager row is legal |
| identifiers | `as=` required on every declaration; the removed `name=` alias; `<expects variable=>`; `<api as>` identifier shape |
| removed spellings | `<native>`, `<prop>` |
| screen readiness | `settle` is root-only; `settle="manual"` must call `dsx.screen.settled()`; unknown modes |
| row identity | data-bound `<list>`/`<grid>`/`<pager>` without `key=` |
| components | every `<Capitalized/>` and `<scheme.Name/>` resolves (package-local → scheme-qualified → global pool), including in-file `<component as=>` |
| tags | unknown lowercase element tags |
| JSE | balanced `(){}[]` and quotes in `on:*` and in `<action>`/`<formula>`/`<variable>` bodies; unknown `dsx.*` namespaces; `dsx.module.<scheme>`; crypto algorithm names; un-keyed `new WebSocket(` |
| handlers | the inline `on:*` budget (≤ 2 statements, ≤ 120 chars) |
| expressions | nested ternaries in `{{ }}` / `visible-if` |
| platform suffixes | a near-miss like `:andriod` names the word you meant |
| interface contract | in a file with a `<head>`, every `dsx.event('x')` and `dsx.variable.x` is declared |
| reactivity | a `<watch>` whose handler writes its own watched key |
| system defaults | the `systemPath: "ejects"` notice on `<list>` / worded `<button>`, silenced by `appearance="custom"` |
| corpus law | a platform folder inside `Components/` |

Code bodies are lifted (blanked line-stably) before the structural scans, exactly like
`StackNode.liftCode`, so raw JS inside an `<action>` is never misread as markup.

### Declared parity gaps - what `dsx lint` does NOT do

1. **The component pool and scheme universe are only what you point it at.** `lint_dsx.rb`
   scans all of `ClosedSource/DSX/Modules` by default; a CLI outside the monorepo cannot.
   `dsx lint` builds its universe from the project root, its configured `packages`, and any
   `--package <dir>` trees (each scanned recursively for `dsx.json`, including Swift-declared
   global components). **Consequence, and it is deliberate:** with at least one `--package`
   tree, an unknown `dsx.module.<scheme>` is an **error**, matching the Ruby; without one it
   softens to a **warning** whose text says the Ruby linter is the tool that can prove it.
   Unresolved-component errors are likewise only as complete as the pool you supply.
2. **No `lint_dsx_css.rb` twin.** DSX-CSS sheets and inline styles are not linted here.
3. **No `check_module_rules.rb` twin.** The constitution's Swift/Kotlin code rules (the `dsx`
   bus rules, WebKit confinement, platform lane folders, the retired-grammar gate) are not
   linted here at all.
4. **No alias-chain resolution.** `lint_dsx.rb` seeds its scheme set through `DSXGraph`
   (nested chains, `alias_chains`); `dsx lint` reads each manifest's `scheme` and `aliases`
   directly. For a flat project the two agree; for deeply nested module chains the Ruby is
   authoritative.
5. **Parser message text differs** for a malformed document: the Ruby quotes REXML, this
   quotes `parseDsx`. Same file, same line, same severity - different wording.

**In this repository, `lint_dsx.rb` remains the authority and the CI gate.** `dsx lint` is
what an application outside the monorepo gets.

## Programmatic use

Every command is also a function:

```ts
import { buildProject, loadConfig, startDevServer, lintSource, runCli } from "@despia-native/cli";

const config = loadConfig("/path/to/app");
const result = buildProject(config);          // { outDir, components, written, importMap }
const server = await startDevServer(config);  // { port, rebuild, close }
const exitCode = await runCli(["lint", "--strict"]);
```

## Release status

`@despia-native/cli` is part of the tagged release set - the **tooling face** of the eight-package
release (`RELEASE_DIRS` in `scripts/release-packages.ts`): five runtime packages an
application imports, plus `@despia-native/cli`, `create-dsx` and `@despia-native/vite-plugin`, which a
developer runs before an application exists. All eight are packed, consumed from their
tarballs, and driven end to end per PR by `npm run pack:check` and `npm run cold-start` -
the latter installs this package from its tarball into an empty directory, scaffolds, builds,
and runs the markup-authored `dsx doctor`, with no monorepo on the path.
