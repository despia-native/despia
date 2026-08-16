# Building in Xcode directly (no Despia CI/CD)

For developers who build in **Xcode themselves**, without the Despia CI/CD
platform (which runs these steps for you on every push). It's also how you
regenerate after editing config/modules. Nothing here needs the platform.

## Prerequisites

- **Xcode** (you build the `Runtime.xcworkspace`, not the bare `.xcodeproj`).
- **Ruby 3.x** with two gems:
  ```bash
  gem install xcodeproj cocoapods
  ```

## Build

```bash
# 1. Generate everything from the declarative sources (every dsx.json +
#    config files): the Podfile block, project deps, Info.plist, entitlements,
#    the lockfile, AND the typed Swift surfaces (CoreConfig, per-module despia,
#    ModuleSchemes).
ruby ClosedSource/scripts/prepare_modules.rb

# 2. Install the pods it chose (Podfile lives in ClosedSource/):
cd ClosedSource && pod install

# 3. Open the workspace, pick the "Runtime" scheme, and Run (⌘R):
open Runtime.xcworkspace   # still inside ClosedSource/
```

That's the whole build. `prepare_modules.rb` runs `prepare_config.rb` for you, so
one command regenerates both the project and the DespiaScript config/scheme code.

## Local env (one file — covers `{{ env.* }}` config AND build-time secrets)

Every dynamic per-app value in Despia resolves from the **process environment** at the
moment `prepare_modules.rb` (and `build_frameworks.rb`) run. There are two kinds, and
**one file feeds both**:

- **`{{ env.NAME }}`** in a module's `config.json`/`infoPlist`/`entitlements` — a
  **runtime** value baked into the binary (a universal-link domain, a public SDK key).
- a **build-time input** a build tool reads (`GODOT_BIN`/`GODOT_VERSION` overrides for
  the Godot `build` tool; a `secrets` fallback for an SDK that needs a credential) —
  consumed during the build, **never** in the binary. See
  [module-secrets.md](module-secrets.md).

Who supplies that environment is the only thing that differs across the three ways this
repo gets built — the resolution itself is identical:

| You are… | Where the env comes from | What you do |
|---|---|---|
| on **Despia CI** (Codemagic) | Codemagic variables + the per-client `SIGNING_URL` fetch | nothing — the platform fills it |
| **building from source** locally | **`settings.local.env`** (repo root), auto-loaded | drop the file, fill it in |
| opening the **pre-built workspace zip** | already resolved/consumed at generation time | nothing — values are baked, the framework is compiled |

For the local case there is exactly **one file**:

```bash
cp settings.example.env settings.local.env   # committed template → your git-ignored copy
# edit settings.local.env — set only the keys your modules actually use
ruby ClosedSource/scripts/prepare_modules.rb  # auto-loads settings.local.env into ENV
```

`prepare_modules.rb` and `build_frameworks.rb` **auto-load** `settings.local.env` before
they resolve anything — you don't `source` it or export by hand. Rules:

- **git-ignored, never committed** — it may hold secrets. Its values are never printed
  and never included in the workspace zip. The committed `settings.example.env` is just
  the key list.
- **a real env var always wins** — anything already exported (or a Codemagic variable)
  overrides the file, so this is a from-source convenience only, inert in CI.
- **fail-open** — no file, or a key left unset, is fine: a `{{ env.NAME }}` token ships
  as-is (with a warning) and a build-time tool soft-skips (Godot → the demo pack just
  isn't exported; the screen reports why).
- plain `KEY=value` (a leading `export ` and surrounding quotes are accepted); **not** a
  shell script — no `$VAR`/`$(...)` expansion.

## When to re-run `prepare_modules.rb`

Re-run it whenever you:
- add / remove / rename a module folder under `DSX/Modules/`,
- edit any `dsx.json` (pods, scheme, Info.plist, entitlements), or
- toggle a module (add it to `DSX/Modules/Config/excluded.json`).

If you **only** changed config *values* (`DSX/Modules/Config/config.json` or a
module's `config.json`) you can regenerate just the Swift, no pods touched:

```bash
ruby ClosedSource/scripts/prepare_config.rb     # CoreConfig + per-module despia + schemes
```

## Turn a module off

Add its name (or a `Core/Group/*` path glob) to `DSX/Modules/Config/excluded.json`,
then re-run `prepare_modules`.

## Commit the generated output

`prepare_modules.rb` edits tracked files: `Podfile`, `Runtime.xcodeproj`,
the generated app `Info.plist` (`DSX/Modules/Mandatory/App/Info.plist`),
`Runtime.entitlements`, `DSX/Modules/.plugin_deps.lock.json`,
and `Registry/*.generated.swift`. Review the diff and commit them so CI and other
machines stay in sync - these are generated **and** committed (like `Podfile.lock`).
