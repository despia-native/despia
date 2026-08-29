# create-dsx

Scaffold a DSX project that compiles.

```sh
npm create dsx my-app
cd my-app && npm install && npm run dev
```

Inside this repository, where nothing is published yet, point the generated project at the
local workspace:

```sh
cd OpenSource/Web
npm run create-dsx -- ../../../my-app --link "$PWD"
node packages/cli/bin/dsx.ts build --project ../../../my-app
```

ESM only. Node ≥ 22.18 runs the TypeScript source directly (native type stripping).

## What it generates

```
my-app/
  dsx.json            package identity - the `scheme` that namespaces every component
  dsx.config.json     app configuration - entry component, output directory (+ routes)
  Components/App.dsx  the entry screen
  package.json        @despia-native/* dependencies + build / dev / lint scripts
  README.md
  .gitignore
```

A scaffolded project **is** a DSX package: the same `dsx.json` + `Components/` shape the
framework's own modules use, so the same `.dsx` sources compile on the iOS and Android
renderers too. Markup is never platform-forked.

| Option | |
|---|---|
| `--template minimal` | one component: an `<attribute>`, a `<variable>`, a named `<action>`, a body of pure markup (default) |
| `--template routed` | adds `Components/About.dsx` and the route table that reaches it, so `dsx build` exports `/about/index.html` |
| `--name <name>` | package + app name (default: the directory's basename, npm-sanitized) |
| `--scheme <scheme>` | the DSX scheme (default: derived from the name) |
| `--link <workspace>` | rewrite the `@despia-native/*` dependencies to `file:` paths in a local `OpenSource/Web` checkout |
| `--force` | scaffold into a non-empty directory |

## The contract

**The generated project compiles with `dsx build` and passes `dsx lint --strict`, as
generated, with nothing edited.** That is asserted end to end for *every* template in
`test/scaffold.test.ts` - scaffold, lint strict, build, then check the built `index.html`
really contains the rendered screen and its import map.

## What it does NOT do

- **No `npm install`, no git init, no package-manager detection.** It writes files and prints
  the three commands to run next.
- **No interactive prompts.** Every choice is a flag, so the whole surface is scriptable and
  testable.
- **No framework variants.** There is no Vite, TypeScript, Tailwind or test-runner template -
  a DSX app's authoring surface is `.dsx`. For a Vite-hosted app, add
  [`@despia-native/vite-plugin`](../vite-plugin/) yourself.
- **No native project scaffolding.** It does not generate the iOS/Android host apps.
- The default (non-`--link`) dependency versions point at `@despia-native/*@0.1.0` on the public
  registry. Until the first tagged release publishes them, use `--link`.

## Release status

`create-dsx` is part of the tagged release set - the **tooling face** of the eight-package
release (`RELEASE_DIRS` in `scripts/release-packages.ts`). It is deliberately unscoped
because `npm create dsx` resolves exactly this name, and the whole first-run path - this
scaffolder from its tarball, the runtime tarballs into the generated project, `dsx build` on
the result - is gated per PR by `npm run cold-start`.
