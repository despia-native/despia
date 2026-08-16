# dsx.json → Android

The **same `dsx.json`** describes a module on both platforms. The iOS build
(`prepare_modules.rb`) turns it into Podfile / SPM / Info.plist / entitlements /
Xcode targets; the Android build turns the same keys into Gradle dependencies,
`AndroidManifest.xml` entries, permissions, and components. One file, two builds.

| `dsx.json` | iOS | Android |
|---|---|---|
| `name` | folder identity | module / package identity |
| `scheme` | URI scheme bound to the class | same - the scheme the Kotlin `Module` claims |
| `aliases` | extra schemes | same |
| `version` | `DespiaPackages` entry | same (BuildConfig / registry entry) |
| `pods` | CocoaPods | **Gradle** `implementation("group:artifact:version")` |
| `spm` | Swift Package Manager | **Gradle / Maven** coordinates |
| `infoPlist` | merged into the generated app `Info.plist` (`Mandatory/App`) | n/a — Android manifest needs live in the dedicated `androidManifest` key below |
| `androidManifest` | n/a | merged into the host `AndroidManifest.xml` sentinel blocks by `prepare_modules_android.rb`: `permissions` (+ auto-implied `required=false` feature guards), `metaData`, components, `raw` — the `infoPlist` twin; full schema: [manifest-dsl.md](../manifest-dsl.md) |
| `entitlements` | `Runtime.entitlements` | n/a — the Android grant is a `androidManifest.permissions` entry |
| `capabilities` | App ID capabilities (App Store Connect) | runtime permissions + manifest features (declared via `androidManifest`) |
| `targets` | which Xcode targets receive entitlements | n/a - Android components live in the one app module |
| `extensionTargets` | a separate `.appex` target | an in-app **component** (see below) - no separate target |
| `container` | provisions one App Group | **no-op** (app-private storage; see [containers.md](containers.md)) |
| `languages` | C++ → synchronized group + bridging-header umbrella + `CLANG_CXX_LANGUAGE_STANDARD` | C++ → `prepare_modules_android.rb` wires AGP's `externalNativeBuild` at the module's own **`kotlin/CMakeLists.txt`** (the DSX MANAGED NATIVE BUILD sentinel; see *Native build* below); the shared `.cpp` + C-ABI header are the SAME files (see [native-languages.md](../native-languages.md)) |
| `actions` | typed dot accessors → `Registry/ModuleAccessors.generated.swift` | same — `ModuleAccessors.generated.kt` (`val ModuleProxy.<scheme>` + a `<Scheme>Module` class over the public `dsx.module` chain), emitted by `prepare_modules_android.rb`; call sites opt in with `import despia.registry.<scheme>`; undeclared actions keep the bracket form (the JVM has no `@dynamicMemberLookup`) |
| `deploymentTarget` | `IPHONEOS_DEPLOYMENT_TARGET` (highest enabled wins; applied by `prepare_modules.rb`) | n/a — Android declares its floor via `gradle.minSdk` (see *Deployment floor* below) |

## Dependencies

```jsonc
"pods": [ { "name": "SwiftQRScanner" } ],
"spm":  [ { "url": "https://github.com/…", "from": "5.5.1", "products": ["…"] } ]
```

On Android these map to Gradle coordinates. A cross-platform module that needs a
scanner declares the iOS pod/SPM here and the Android artifact in the Android
build's dependency resolution keyed by the same module - the manifest is the
source of truth; each build picks the deps for its platform. (If a dep is
iOS-only or Android-only, only that platform's build consumes it.)

## Deployment floor — `gradle.minSdk`

The Android twin of iOS `deploymentTarget`, same law on both platforms: **the
min OS version is package-declared, and the highest value across enabled
modules wins for the whole app**.

```jsonc
"gradle": { "minSdk": 26 }
```

`prepare_modules_android.rb` scans every **enabled** package (not just the
android-ported subset — `Mandatory/App` is pure manifest and declares the 24
baseline) and rewrites the one `minSdk = <n>` assignment in
`RuntimeAndroid/app/build.gradle.kts` — both directions, so excluding the
demanding module lowers the floor back. Engine library modules keep their own
`minSdk = 24` (a library floor at or below the app floor is always valid).

## Native build — `languages` + `kotlin/CMakeLists.txt`

The generalized `languages` C/C++ back-half (C, C++ and Obj-C++ all ride the
`cxx` key — [native-languages.md](../native-languages.md)). **Any** enabled
module that declares `languages.cxx` **and** ships a `kotlin/CMakeLists.txt`
becomes the native-build owner: `prepare_modules_android.rb` emits `ndkVersion`
+ the `externalNativeBuild { cmake { path = …/kotlin/CMakeLists.txt } }` wiring
into the DSX MANAGED NATIVE BUILD sentinel of
`RuntimeAndroid/app/build.gradle.kts`. Excluding the owner empties the block, so
the native build leaves together with its managed prefab deps — no hand edit.
The optional **`gradle.native`** block carries the per-module gradle knobs:

```jsonc
"languages": { "cxx": "c++17" },
"gradle": {
  "native": { "stl": "c++_shared", "prefab": ["com.google.oboe"] },
  "dependencies": [ "com.google.oboe:oboe:1.10.0" ]
}
```

- `stl` — emitted as the app-wide `-DANDROID_STL=<stl>` CMake argument (omit for
  AGP's default).
- `prefab` — the prefab C++ AAR **groups** the module's CMakeLists
  `find_package()`s; a non-empty list turns `buildFeatures.prefab = true` on.
  Each named group should also ride a gradle dependency (warned otherwise).

Pre-certified (hard aborts, normal **and** `--check` runs): an
`kotlin/CMakeLists.txt` with no `languages.cxx` declaration (the native build
is manifest-declared); a malformed `languages`/`gradle.native` shape; an
orphaned `gradle.native` (no `cxx` or no CMakeLists); a CMakeLists whose
`set(CMAKE_CXX_STANDARD n)` contradicts the declared `cxx` standard. AGP wires
**one** CMake script per Gradle module, so two enabled owners abort — fold the
scripts or exclude one. The toolchain pins (NDK r27 LTS + CMake) are
script-owned constants, not per-module knobs. Core/Studio is the first consumer
of this path.

## Permissions vs entitlements

## Config values — `android ?? value`

The same `config.json` feeds both builds. Each entry's committed `value` is the
cross-platform default; an entry may **rarely** carry entry-level
`"ios"`/`"android"` overrides (schema + guidance:
[dynamic-modules.md](../dynamic-modules.md) §2). The Android codegen
(`prepare_modules_android.rb` → `ModuleConfig.generated.kt`) resolves
**`android` ?? `value`** per entry; the iOS codegen resolves `ios` ?? `value`.
No `value` and no `"android"` key ⇒ the key is absent on Android (dropped from
`ModuleConfig.byScheme`, so `dsx.config` fails open). This is for ONE shared
knob whose *value* genuinely differs — a knob that only *exists* on one
platform stays a separate per-platform **key** (Firebase's `android_app_id`/
`android_api_key`, RevenueCat's `androidApiKey`). `core_packages.json` sets
platform values with the same object shape (`{ "min_ms": { "android": 2000 } }`
merges per-key into the entry, preserving the iOS side).

## Permissions vs entitlements

iOS `entitlements` / Info.plist usage strings become Android **permissions** and,
where relevant, a runtime permission request:

| iOS | Android |
|---|---|
| `NSCameraUsageDescription` (Info.plist) | `<uses-permission android:name="android.permission.CAMERA"/>` + runtime request |
| `NSLocationWhenInUseUsageDescription` | `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` + runtime request |
| `com.apple.developer.healthkit` | Health Connect permissions |
| `com.apple.security.application-groups` | nothing - same-process storage (see containers.md) |
| push entitlement (`aps-environment`) | FCM (no explicit permission pre-13; `POST_NOTIFICATIONS` on 13+) |

The module still declares its intent once in `dsx.json`; each build emits the
right platform artifact — on iOS via `infoPlist`/`entitlements`, on Android via
the `androidManifest` key (`"permissions": ["CAMERA"]` expands to
`android.permission.CAMERA` and auto-emits the `required="false"` hardware
guard so Play never filters devices; see
[manifest-dsl.md](../manifest-dsl.md)).

## Extension targets → Android components

iOS app extensions are separate signed targets. Android has no direct equivalent;
the same capability is an **in-app component** declared in `AndroidManifest.xml`,
running in the app process:

| `extensionTargets` kind | iOS | Android |
|---|---|---|
| `widget` | WidgetKit extension (`.appex`) | `AppWidgetProvider` / Glance `<receiver>` (in-app) |
| `share` | Share Extension (`.appex`) | Activity with `<intent-filter>` `ACTION_SEND` |
| `notification-service` | Notification Service Extension | `FirebaseMessagingService` (`onMessageReceived`) |
| App Clip | on-demand-install target | **Instant App** / Instant-enabled module |

Because Android components share the app process and storage, they don't need the
shared-container plumbing iOS extensions do - which is exactly why `container`
is a no-op on Android.

## What the Android build should do (parity with `prepare_modules.rb`)

1. Read every `dsx.json` (same discovery, same `excluded.json` gating).
2. Add `pods`/`spm` → Gradle dependencies for enabled modules.
3. Merge each module's `androidManifest` block → the host `AndroidManifest.xml`
   sentinel blocks (permissions + the auto-implied `required=false` feature
   guards, meta-data, components, raw XML — landed in
   `prepare_modules_android.rb`; schema: [manifest-dsl.md](../manifest-dsl.md)).
4. Register each code-bearing module's scheme → class (the Kotlin equivalent of
   `ModuleSchemes.generated`).
5. Wire `extensionTargets` to the matching in-app component.
6. Ignore `container` for provisioning; module code still uses `dsx.container`.
7. For `languages.cxx`, wire the enabled owner's `kotlin/CMakeLists.txt` into
   AGP's `externalNativeBuild` (+ the `gradle.native` stl/prefab knobs) — landed
   in `prepare_modules_android.rb`, see *Native build* above. The module's own
   CMakeLists references its `engine/` sources and pins the declared standard
   (drift aborts the build) — the `.cpp` and the `extern "C"` ABI header are the
   SAME files iOS compiles; only the audio/JNI driver differs
   ([native-languages.md](../native-languages.md)).

Net: a module author edits one `dsx.json`; both builds stay in sync with no
per-platform manifest.
