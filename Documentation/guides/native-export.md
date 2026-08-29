# `dsx export`: a real Xcode project, a real Android Studio project

> The native system is not a gotcha. The open kit — the kernel, the module grammar, this CLI
> — exports a **complete, buildable native project** for either platform from your own module
> folder. Nothing is withheld: the commercial platform adds convenience on top (a maintained
> module library, hosted builds with no Xcode anywhere, store submission handled), never
> capability. If you want to build every module yourself and own the whole project, this is
> that path, and it is first-class.

```bash
dsx export ios          # → export/ios: an .xcodeproj you open in Xcode
dsx export android      # → export/android: a Gradle project you open in Android Studio
dsx export all          # both
```

| Flag | Meaning |
|---|---|
| `--project <dir>` | project root (default: the nearest ancestor with `dsx.config.json`) |
| `--kernel <dir>` | a kernel checkout (default: `DSX_KERNEL`, or the monorepo when run inside it) |
| `--out <dir>` | output directory for a single-platform export (default: `export/<platform>`) |
| `--bundle-id <id>` | bundle / application id (default: `com.example.<name>`) |

## What you supply — everything is a module

The same project layout every other `dsx` command reads (C1's layout), plus a `Modules/`
folder where **you write your own package structure**, exactly the shape the framework's own
modules use:

```
myapp/
  dsx.json                      # identity: name, scheme, version
  dsx.config.json               # entry component
  Components/                   # your .dsx documents (all three renderers execute these)
  Modules/
    Badge/
      dsx.json                  # { "name": "Badge", "scheme": "badge", ... }
      swift/Badge.swift         # the iOS lane: one `class Badge: Module`
      kotlin/Badge.kt           # the Android lane: one `class Badge : Module()`
      Components/BadgePill.dsx  # components the module ships, scoped by its scheme
      config.json               # { "max_count": { "value": 99 } } → the module's config table
```

The lane folders are the platform gate (file presence, never `#if`): a module with only a
`kotlin/` lane simply contributes nothing to the iOS export. `ios/` and `android/` are the
accepted legacy aliases. Each lane declares **exactly one** `Module` subclass — two is an
error naming the fix, unless one carries the module folder's own name, in which case the
convention decides.

## What comes out

**iOS** — a deterministic `<Name>.xcodeproj` (one target, shared scheme, ready for
`xcodebuild`), the kernel sources vendored under `Kernel/`, your module lanes under
`Modules/<Name>/`, and `Resources/` carrying `App.json`, `EngineConfig.json`, `runtime.js`
and every component byte-exact under `DSXComponents/<scope>/`. The generated `App/` half is
the entire host: an `@main` AppDelegate that calls `DSXBoot.boot(present:)`, and one
`DSXGeneratedTables` subclass the registry's class walk finds at boot — schemes, config and
components installed with no call site to get wrong.

**Android** — a Gradle **composite build**: the kernel vendored whole under `kernel/` and
included via `includeBuild` + dependency substitution, so `dev.despia.engine:{core,platform,
render}` resolve to sources you can read and step through. The root build pins the kernel's
own Kotlin/AGP versions (extracted, not guessed — one classloader per plugin version), and
the generated `host/` half fills the same seams the framework's own app fills:
`GeneratedModuleSchemes`, `GeneratedConfigRaw`, `AppManifest` asset loaders, components
parsed at boot through `StackXML.parse` into `ComposeStackComponents.defineNode`.

Both exports are **byte-deterministic**: export twice, get identical trees. That makes
`export/` diffable build output — regenerate after changes, never hand-edit
([reserved-directories](reserved-directories.md)).

## The kernel

The export vendors kernel sources, so it needs a checkout: `--kernel`, or `DSX_KERNEL`, or —
inside the monorepo — it finds `OpenSource/Engine` itself. Standalone:

```bash
git clone https://github.com/despia-native/despia-kernel
DSX_KERNEL=./despia-kernel dsx export all
```

A named kernel is a contract: if `--kernel`/`DSX_KERNEL` points somewhere that is not a
kernel checkout, the export refuses rather than silently building against sources you never
chose.

## The honest boundary

Compiling the export needs the platform toolchain — Xcode for iOS, Android Studio (or an
Android SDK + `./gradlew assembleDebug`) for Android — on a machine you own. The CLI's own
gate proves structure and determinism (every pbxproj reference exists, the composite build
resolves, double exports are identical); compile smokes ride the platform CI lanes, where
those toolchains live.

## The same CLI, both sides of the line

The hosted platform uses **this exporter** — it supplies the module folder (yours plus the
commercial library's prebuilt, battle-tested modules) and runs the same `dsx export`, then
adds what the open path leaves to you: signing, store submission, updates. The difference
between the open kit and the product is who assembles the module folder and who clicks
through App Store Connect — not what the build system can do.
