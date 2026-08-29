# The `despia` command line

One toolchain, twenty-one commands, and no hidden second build. Everything CI does to
your project, you can run locally with the same command.

If you only ever learn three: `despia dev` while you work, `despia review --strict`
before you push, `despia build` to ship.

## The loop you live in

```bash
despia dev          # build, serve, watch, reload
```

Serves your app framed at real device size with a light/dark toggle, so a phone app is
judged at phone width instead of smeared across a desktop tab. Edits hot-swap: the
running app repaints and your typed state survives.

```bash
despia lint --strict     # DSX markup + JSE bodies: 0 errors, 0 warnings
despia review --strict   # the design floor
despia doctor            # the mistakes that make a build fail later
```

`lint` is correctness. **`review` is different and worth understanding**: it checks the
objective floor of the design bar, and only things a machine can judge without taste.
Accessible names on icon-only buttons, tap targets under the 44pt floor, text off the
type scale, raw hex discipline, and real WCAG contrast computed rather than eyeballed.
It deliberately does NOT encode taste as a threshold, because a judgement expressed as
a number is a false-positive factory.

`doctor` is the one to run when something is confusing: it checks the project's shape
rather than its contents.

## Shipping

```bash
despia build                 # .dsx sources to a deployable static site
despia deploy <target>       # prints the plan; --apply runs it
despia ota build|publish|rollback
```

`deploy` prints a plan by default and changes nothing. `--apply` is the deliberate act,
and it refuses to publish a backend it has not verified. Targets include Cloudflare,
Supabase, Firebase, Docker and a plain Node server; the same document emits to all of
them.

`ota` is the content plane: build a generation, publish it, roll it back. Because your
route table compiles into the build output, **a route change ships here rather than
through a store** (see `guides/routing.md`).

## Native projects

```bash
despia export ios      # a real .xcodeproj
despia export android  # a real Android Studio Gradle project
```

Nothing is withheld and nothing is generated behind a paywall: the export is a genuine
native project built from your own modules, which you can open, read and build.

## Store assets, rendered from the app

```bash
despia shot            # store screenshots, no simulator, no designer
despia film <name>     # a marketing video, rendered from the app's own documents
```

Both render from your real app and its own sample data, so a screenshot cannot show a
screen your app does not have. `shot --check` fails on drift, which makes your store
listing a gated artifact like anything else.

## Packages

```bash
despia search <query>   # bundled first-party index answers offline; --remote adds community
despia add <package>    # resolve by git tag, verify the tree hash, pin in dsx.lock.json
despia remove <package>
despia list             # what is pinned, and whether its bytes are cached
```

`add` pins a **content hash**, not a version range, so a package cannot change under
you between installs.

## The visual editor

```bash
despia edit             # the Studio, served locally against this project
```

No account, no hosting, no upload. It edits the files on your disk: select on the real
render, drag to reorder, and the change lands in the source file as a one-line splice.

## For agents

```bash
despia mcp              # serve the toolchain over MCP on stdio
despia mcp --list       # every tool an agent will see
```

Every command above becomes an MCP tool automatically, because the command table and
the tool table are the same declaration. An agent that cannot run a shell can still
build, lint, add packages and export.

## The rest

| Command | What it is for |
|---|---|
| `provision` | create and verify Despia's tables in your database; reports by default |
| `report` | judge a pasted diagnostic blob: genuine, modified, or not a report |
| `app` | the Despia Apps plane, and running an app's tools headless |
| `submit` | the apps-shelf submission recipe, run entirely on your machine |
| `licence` | sign entitlements where the signing key actually lives |

## Options worth knowing

- `--project` finds the nearest ancestor holding `dsx.config.json`, so you rarely pass it.
- `--strict` on `lint` and `review` is what CI runs. Use it locally and there are no surprises.
- `--plan` / `--apply` is the pattern everywhere something changes the world: the plan is
  the default, the change is deliberate.
