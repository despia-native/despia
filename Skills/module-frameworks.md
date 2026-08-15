# Module build artifacts — binary dependencies without committing binaries

Some modules need a binary they don't want in git: an exported game content pack, a
vendor engine, a large `.xcframework`. Too large (or too derived) to commit — and we
never want it hosted on a private Despia CDN either. So the module **declares how to
resolve it** and the build does: by *exporting* it from an in-repo project (`godot`),
by *compiling* it from hash-pinned public upstream inputs (`cmake-android`), or by
*fetching* a hash-pinned public artifact directly (`fetch`). The result lands in the
package folder where the module's linking/bundling picks it up. Nothing binary is
committed; nothing comes from an unpinned or private host.

This is the **`build`** manifest primitive, run by
[`scripts/build_frameworks.rb`](../../ClosedSource/scripts/build_frameworks.rb) (the
generic *Build Module Frameworks* step in both lanes). It's the counterpart to
[`weights`](module-weights.md) (large ML blobs bundled as app resources): a module
*declares* a binary dependency in its own manifest, the build *resolves* it.

## The live example: Godot content (`tool: "godot"`)

The Godot package (`ClosedSource/DSX/Modules/Core/Godot`) runs the embedded Godot
engine (linked via SPM — see its README) and plays **content packs** (`.pck`). Its
zero-config demo pack is produced in CI from an in-repo Godot project:

```json
"build": [
  { "output":  "GodotDemo.pck",
    "tool":    "godot",
    "project": "ClosedSource/Codemagic/Example/Godot/GodotSampleProject",
    "preset":  "iOS" }
]
```

- **`build[].output`** — the artifact to produce, dropped in the package folder
  (module-folder files ship as app resources, so the pack rides the binary).
- **`build[].tool`** — the builder: `godot` | `cmake-android` | `fetch` (each below).
- **`build[].project`** — repo-relative path to the source project built in CI.
- **`build[].preset`** — (godot) the export preset name in the project's
  `export_presets.cfg`.
- **`build[].platform`** / **`url_env`** / **`sha256_env`** — every tool honors these:
  the lane gate and the operator prebuilt fast-path (both detailed under
  `cmake-android` below).

What happens in the build:

```
codemagic step "Build Module Frameworks"  →  ruby scripts/build_frameworks.rb
   │
   ├─ hash the Godot project → cache key
   ├─ cache HIT  → restore the exported pack instantly  ──────────────────┐
   └─ cache MISS → download the EXACT editor the project declares         │
                   (project.godot config/features → the official          │
                    godot-builds release zip; NO license/account — MIT)   │
                   → godot --headless --import                            │
                   → godot --headless --export-pack "iOS" GodotDemo.pck ──┘
   ▼
drops GodotDemo.pck in DSX/Modules/Core/Godot/  (ships as an app resource)
   ▼
<Godot/> boots the SPM-linked engine and runs the pack (OTA copies still win)
```

The step runs **before `prepare_modules`** (so the produced file is present for
resource bundling and any `if_present` pod gate) and **before `pod install`**.

Provisioning is entirely **self-contained and dynamic**: the required editor version
comes from the project's own `config/features` tag (never pinned in a script or in
codemagic.yaml), the editor is ONE self-contained notarized zip from the official
godot-builds release, and there is **no license, serial, account, or activation** —
Godot is MIT. `GODOT_BIN` (use a local editor) and `GODOT_VERSION` (pin an exact
patch release) override. A data-only `.pck` export needs no export templates and no
signing.

**Soft-skip**: no editor findable/installable, or any step fails → warn + proceed.
The app still builds; the `<Godot/>` screen visibly reports why the demo content is
missing. Local gates and non-engine builds are unaffected.

## The second tool: `cmake-android` — a module-built native library

The Android twin of the same idea: a module that needs a **standalone `.so`** it doesn't
want in git — typically a vendor engine (published upstream only as static libs) linked
against the module's own JNI shim. The live example is LocalAI's
[Cactus](https://github.com/cactus-compute/cactus) engine
(`ClosedSource/DSX/Modules/Core/LocalAI` — the static libs ship in the
[cactus-react-native](https://www.npmjs.com/package/cactus-react-native) npm package):

```json
"build": [
  { "output":  "kotlin/jniLibs/arm64-v8a/libcactus.so",
    "tool":    "cmake-android",
    "platform": "android",
    "project": "ClosedSource/DSX/Modules/Core/LocalAI/kotlin/jni",
    "abi":     "arm64-v8a",
    "api":     24,
    "sources": [
      { "from": "npm:cactus-react-native@1.13.1",
        "extract": { "package/…/libcactus.a": "libcactus.a",
                     "package/cpp/cactus_ffi.h": "cactus_ffi.h" } }
    ] }
]
```

- **`project`** — the module's own CMake project (repo-relative), committed like any source.
- **`sources[]`** — PINNED upstream inputs the module OWNS: a `from` locator (pin
  recorded in the module's `dsx.lock.json` by `--lock` — see the Locators section) or
  an explicit https `url` + 64-hex `sha256`, plus an `extract` map of archive members
  (`.tgz`/`.zip`/`.aar`) → names staged into the dir CMake receives as
  **`-DDSX_BUILD_INPUTS`** (the tool↔project contract). Pins live with the module —
  **never in a script or codemagic.yaml** (the godot rule: nothing tool- or
  module-specific outside the manifest + the generic driver).
- **`abi`** / **`api`** — optional (`arm64-v8a` / 24).

Flow: the **env fast-path** first (`url_env`/`sha256_env`, below), then `output`
already present (a previous run, a committed copy) → left untouched; else fetch each
source, extract into the staging dir, configure with the NDK toolchain (`c++_static`,
Release), build, `llvm-strip`, publish (cache + package folder). Cached like the godot
tool — artifact keyed by project content + resolved pins + abi/api **+ NDK version**
(a CI toolchain bump rebuilds instead of pinning the fleet to a stale runtime);
pinned downloads keyed by their sha256 — both under `ClosedSource/.framework-cache/`
(in both lanes' `cache_paths`).

**Loud vs soft — the failure law.** Only *environmental absence* soft-skips (no
NDK/cmake on this machine, a pinned-source download failure, an unpinned locator):
warn + proceed, the module degrades visibly at runtime (Article 7). Everything that
means "the declaration or the code is wrong" is a **red build**: a SHA-256 mismatch
(tamper-evidence), a missing archive member or `root` subtree (the archive is pinned —
its contents can't drift), and a **compile/link failure of the committed project** (a
broken shim must never silently ship an engine-less app).

**Prebuilt fast-paths, in preference order:**

1. **A PUBLIC prebuilt → commit it in the manifest.** Entries run in array order and
   an already-present output is left untouched, so a `fetch` entry ahead of the
   `cmake-android` entry (same `output`) IS the fast-path — the pinned public
   prebuilt is used, and if its download soft-skips the source build runs as the
   fallback. Everything stays in the module's own dsx.json + dsx.lock.json; no env,
   no payload, nothing out-of-band:

   ```json
   "build": [
     { "output": "kotlin/jniLibs/arm64-v8a/libcactus.so", "tool": "fetch",
       "platform": "android", "from": "github:acme/engines@v1.13.1:libcactus.so" },
     { "output": "kotlin/jniLibs/arm64-v8a/libcactus.so", "tool": "cmake-android", "…": "…" }
   ]
   ```

2. **A PRIVATE/SIGNED prebuilt (an expiring URL — the only thing a manifest can't
   pin) → `url_env` / `sha256_env` on the entry.** When that env is delivered the
   prebuilt is fetched (signed URLs never printed), pin-verified, and used instead
   of building — and explicit operator intent fails LOUD: a delivered-but-failing
   fetch or a pin mismatch aborts rather than silently substituting. Delivery is
   constitutional: in CI the values arrive through the module's own
   [`secrets`](module-secrets.md) declaration (`as: "env"`, the same names —
   namespaced fields on the ONE generic `DESPIA_SECRETS_JSON_B64` payload), so no
   lane env block and no dashboard trigger contract ever carries a module-named
   variable; local dev just exports the vars. Reach for this ONLY when the URL is
   genuinely unpinnable — a public artifact belongs in the manifest per option 1
   (LocalAI's engine is fully manifest-declared and uses no env keys).

**`platform`** gates the entry to its lane (defaults per tool: `godot` → `ios`,
`cmake-android` → `android`, `fetch` → every lane); each Codemagic lane passes
`--platform <ios|android>`, so the iOS lane never NDK-compiles an Android engine and
the Linux android lane never downloads the macOS Godot editor.

## The third tool: `fetch` — a pinned prebuilt artifact, no compile

When upstream already publishes the binary (an `.xcframework` in a release zip, a
prebuilt `.so`, a binary pack), a module declares WHERE — one locator line — and the
tool downloads, SHA-256-verifies, and places it:

```json
"build": [
  { "output": "Some.xcframework",
    "tool":   "fetch",
    "from":   "npm:some-sdk@2.1.0",
    "root":   "package/ios/Some.xcframework",
    "overlay": { "Some.modulemap": "ios-arm64/Some.framework/Modules/module.modulemap" } }
]
```

- **`root`** (optional) — the archive subtree (`.tgz`/`.zip`/`.aar`) that becomes
  `output`; omit it and the verified download itself is the output file.
- **`overlay`** (optional) — COMMITTED module files grafted into the fetched artifact
  (module-relative source → output-relative destination; directory outputs only). The
  classic use: the `module.modulemap` a raw vendor `.xcframework` lacks but Swift's
  `import` needs.
- An already-present `output` is **left untouched** — a committed copy keeps winning
  until you delete it, so a module can migrate a committed binary gradually.
- The failure law applies here too: a download failure soft-skips (module degrades
  visibly), while a pin mismatch, a `root`/member missing from the pinned archive, or
  a missing overlay source **aborts** — pinned bytes can't drift, so those are
  declaration bugs, never transient conditions.

## Locators + `dsx.lock.json` — add a link, run `--lock`, done

Anywhere a pinned source appears (a `fetch` entry, a `cmake-android` `sources[]` row),
write ONE **`from` locator** instead of hunting URLs and hashes by hand:

| locator | resolves to |
|---|---|
| `npm:cactus-react-native@1.13.1` | that version's tarball on the [npm registry](https://registry.npmjs.org) (scoped `npm:@scope/pkg@v` works) — e.g. [cactus-react-native](https://www.npmjs.com/package/cactus-react-native) |
| `github:owner/repo@v1.2.3` | the tag's source tarball (codeload) — e.g. [cactus-compute/cactus](https://github.com/cactus-compute/cactus) |
| `github:owner/repo@v1.2.3:asset.zip` | that GitHub release's uploaded asset |
| `jsdelivr:pkg@1.0.0/dist/file.wasm` | the [jsDelivr](https://www.jsdelivr.com/) npm CDN file |
| `https://…` | any https URL, verbatim |
| `path:OpenSource/AI@0.1.0` | an **in-repo source tree** — nothing downloads |

`path:` is the odd one out and exists for a specific job: a module consuming a sibling
package in this repo (`OpenSource/AI`, `Base`, `MCP`) declares it the same way it declares
any vendored dependency, and gets the same lock discipline. Two properties come with it.
The version after `@` must equal the package's own `VERSION` file or the run aborts — two
places to bump means one of them is eventually wrong, and here "wrong" means an artifact
whose SBOM says it is something it is not. And the pin records a **content digest** over the
tree (every file's SHA-256, folded in sorted path order) rather than a git tree hash, because
the release SBOM requires a 64-hex digest per locator and git tree hashes are SHA-1. Edit the
package, re-run `--lock`, commit both. After the first public mirror push these entries flip
to `github:` locators against the mirror tags, which is a one-line manifest edit precisely
because it is the same mechanism.

Then once, after adding or bumping a locator:

```bash
ruby ClosedSource/scripts/build_frameworks.rb --lock   # resolve → download → hash → pin
```

The pin lands in the module's own committed **`dsx.lock.json`** (sibling of dsx.json —
the module owns its pins):

```json
{ "npm:cactus-react-native@1.13.1":
    { "url": "https://registry.npmjs.org/…tgz", "sha256": "fc4a8a74…" } }
```

Commit the manifest + lock together. Every other machine — CI, teammates — builds
**fully pinned**: a normal run never trusts an unpinned locator (it soft-skips with a
loud "run --lock"), and a hash mismatch aborts (tamper-evidence). `--lock` records
pins even on a machine that can't run the build itself (no NDK) — pins are
environment-independent. Explicit `url` + `sha256` on an entry still work and win
over `from`. Version bump = edit the locator, re-run `--lock`, commit both files.

## Choosing the mechanism — every shape, all declarative, zero hardcoding

| The module needs | Mechanism (all in ITS `dsx.json`) |
|---|---|
| a registry pod / Swift package | `pods` / `spm` |
| a Maven artifact (Android) | `gradle.dependencies` |
| a big ML blob bundled as a resource | `weights` (pinned file fetch; `url_env` for signed URLs) |
| a prebuilt binary upstream hosts (xcframework, `.so`, pack) | `build` + **`fetch`** (pin + optional archive subtree) |
| a native lib that must be LINKED from upstream static libs + its own shim | `build` + **`cmake-android`** (pins + its own CMake project) |
| an artifact exported from an in-repo project | `build` + **`godot`** (or the next tool) |
| its own shared C++/foreign source compiled into the app | `languages` |

The invariants across all of them: the module OWNS its declaration (URLs, pins,
projects — never a script or lane literal), exclusion gates everything
(file-presence law), a missing artifact degrades fail-open (Article 7), and the
lane steps are generic (`Fetch Module Weights`, `Build Module Frameworks` — they
walk manifests, they name nobody).

**iOS vendored-framework linking caveat:** pair a fetched `.xcframework` with
`pods[].if_present` (below) and put its API behind `#if canImport(...)` so a
soft-skipped fetch still compiles. Note a raw vendor framework may lack a
`Modules/module.modulemap` (Swift's `import` needs one) — commit the modulemap
beside the module and graft it via the podspec, or keep the framework committed.
Never use a committed binary to work around either issue when its license restricts
commercial use or downstream redistribution. Such a module must stay excluded until
`check_dependency_licenses.rb` finds an exact legal approval and the build receives a
properly licensed private artifact. LocalAI/Cactus intentionally follows that rule.

## The fourth tool: `xcframework` — in-repo C/C++ becomes something Xcode links

The iOS counterpart of `cmake-android`. That tool NDK-compiles an in-tree core into a `.so`;
this one compiles the same sources per slice and runs `xcodebuild -create-xcframework`.

```json
"build": [
  { "tool": "xcframework", "output": "swift/DespiaAI.xcframework",
    "from": "path:OpenSource/AI@0.1.0",
    "sources": ["engine/src", "mock"],
    "headers": "engine/include",
    "library": "libdespia_ai.a",
    "defines": { "DESPIA_AI_VERSION": "0.1.0" },
    "std": "c++17" }
]
```

It exists because a package like Despia AI is consumed two deliberately different ways from
ONE tree: an SPM consumer builds the sources itself, and the DSX app build takes a prebuilt
xcframework so app builds do not pay the compile.

**The v1 fence, stated so it stays v1:** compile per slice, create the xcframework, cache on
the source digest, iOS device and simulator only. No macOS slice (that is the desktop
workstream), no dSYM handling, no codesigning, no Metal bundling. The cache key covers
everything that changes the output — digest, slice set, standard, defines, header dir — so a
cached CI artifact is trustworthy and not merely fast. On a lane without Xcode the entry
soft-skips with a reason rather than failing a build it was never going to produce.

## The other shape: a vendored `.xcframework`

The same primitive covers a module that links a big binary `.xcframework` it doesn't
author (a proprietary native SDK compiled from an in-repo project). Two extra pieces
make the LINK side safe when the binary may not exist yet:

```json
"pods": [
  { "name": "SomeEngine", "path": "DSX/Modules/Core/SomeEngine", "if_present": "SomeEngine.xcframework" }
]
```

- **`pods[].if_present`** — emit the local `:path` pod **only once the file exists**.
  CocoaPods makes `vendored_frameworks` a **hard** requirement: a glob that matches no
  file **aborts `pod install`** ([CocoaPods #6608](https://github.com/CocoaPods/CocoaPods/issues/6608)),
  so the pod can only be declared once the binary was produced.
- The framework's API goes behind `#if canImport(<Name>)` so Swift compiles either way
  (the [Stream](../../ClosedSource/DSX/Modules/Core/Stream)/[Clerk](../../ClosedSource/DSX/Modules/Core/Clerk)
  pattern):

| State | build step | pod line | Swift | Result |
|---|---|---|---|---|
| tool present | produces (or cache-restores) the binary | emitted | `canImport` → real | full SDK |
| no tool / build fails | **soft-skip** (warn, proceed) | **deferred** | `canImport` → stub | builds; degrades visibly |

If the SDK's build **needs a credential** (a proprietary engine license, a private
registry token), the module declares it in its own `dsx.json` `secrets` block and it
arrives per-client at build time — the **[module-secrets.md](module-secrets.md)**
primitive. (Godot needs none — that's half the reason it's the in-repo engine.)

## Caching (npm-like)

The output is keyed by the source project's content hash (`cmake-android` adds the
resolved pins + abi/api + NDK version) and stashed in
`ClosedSource/.framework-cache/` — along with per-version editor downloads and every
sha-keyed pinned source download. The cache deliberately lives OUTSIDE
`DSX/Modules/`: that tree is a filesystem-synchronized group of the app target, so
anything cached inside it (e.g. the downloaded macOS Godot editor app) would ship
into the app bundle as a resource and break the App Store upload.
Codemagic's `cache_paths` includes it (both lanes), so unchanged inputs **restore
instantly** instead of re-exporting/recompiling every build. Edit the project or bump
a pin → the key changes → it rebuilds once. `ruby scripts/build_frameworks.rb
--check` is an offline dry-run (reports what would build and whether the cache is
warm) for the local gate.

**Never in git.** `output` (`*.pck`, `*.xcframework/`) and `.framework-cache/` are
`.gitignored`.

## Alternative: Git LFS (commit once, no rebuild)

If you'd rather **store** a prebuilt artifact than produce it in CI, commit it via
Git LFS — still no CDN, and CI pulls it on clone:

```bash
git lfs track "ClosedSource/DSX/Modules/Core/Godot/GodotDemo.pck"
# remove the matching ignore line from .gitignore so it can be tracked
git add .gitattributes ClosedSource/DSX/Modules/Core/Godot/GodotDemo.pck
git commit -m "Vendor the demo pack via LFS"
```

Then **drop the `build` block** from `dsx.json`. LFS keeps normal clones small
(pointer files) while the binary still ships. Pick **one** of `build` / LFS, not both
(they target the same path).

## Restricted framework intake

A framework classified `Restricted`, `Proprietary`, `Commercial`, or `NOASSERTION`
must be declared under its module's `restrictedDependencies`. The release gate binds
legal approval to the exact module path/version, dependency/version, classification,
license identifier, and license URL. With no exact checked-in approval the module is
excluded and its declared artifacts must be absent. Per-app `excluded.json`
replacements cannot bypass this: CI runs the gate again before dependency resolution
and inspects the final IPA/APK/AAB for forbidden payloads.

LocalAI/Cactus is the reference case: it is excluded by default, its old committed
XCFramework and local podspec were removed, and no Cactus binary is redistributed by
DSX. A future licensed integration must arrive privately, be version-pinned, and add
an independently reviewed exact approval.

## When NOT to use it

- A small committed asset → use **`files`**.
- A large ML data blob bundled as a resource → use **[`weights`](module-weights.md)**.
- A normal source/registry pod or Swift package → use **`pods`** / **`spm`** (this is
  how the Godot ENGINE itself arrives — only its CONTENT uses `build`).

`build` is for a **binary artifact resolved at build time** — exported from an
in-repo project or pinned to public upstream bytes — that you don't want in git or on
a private CDN.
