# Containers (the shared App Group)

A **container** is the app's one shared App Group, `group.<bundleid>.container`,
that every module and the app's extensions read and write. Inside that one
group, each module gets a **subcontainer**: a folder (for files) and a key
prefix (for values) named after the module's **scheme**. So the whole app uses
one App Group, organized like folders, instead of a new group per feature. iOS
only.

One reserved group replaces the old per-module groups (`.onesignal`,
`.sharetarget`, `.widgetsharing`, `.Clip`, …): the App ID provisions it once, CI
checks one group, and a new module needs zero new provisioning.

## Why one group

App Groups are a **provisioning** concern, not a security boundary. DespiaScript
modules compile into the app process, so a module can already reach every group
the app is entitled to (and the keychain, and the file system). One group vs.
many changes nothing about isolation; it just removes N-1 things to register,
sign, and gate in CI. Keep secrets in the Keychain, as always.

Collisions are the only real risk of a shared group, and subcontainers remove
them by namespacing per module instead of minting new groups.

## 1. Declare it - `"container": true`

A module opts into the container in `dsx.json`. The build adds the reserved
group to the module's `targets` (the app plus any extension it lists). You never
write a group string; the module's subcontainer is its `scheme`.

```json
{
  "name": "OneSignal",
  "scheme": "onesignal",
  "container": true,
  "targets": ["Runtime", "OneSignalNotificationServiceExtension"]
}
```

`prepare_modules` fans `group.<bundleid>.container` into each listed target's
entitlements (the same machinery as an explicit app-group entitlement); CI
provisions the one group and rewrites the bundle per app
(`group.${BUNDLE_ID}.container`). Excluding the module drops its claim like any
other entitlement. A module with no `scheme` has no subcontainer name, so give
it one (code-bearing modules already have a scheme).

## 2. Use your own folder - `dsx.container`

`dsx.container` is **your** subcontainer, named after your scheme. Read and write
it directly; keys are stored as `<scheme>.<key>` and files live in a
`<scheme>/` folder, both inside the one group.

```swift
final class OneSignalBridge: Module {          // scheme "onesignal"
    override func setup() {
        dsx.action("save") { dsx in
            dsx.container.set("player_id", dsx.args("id"))   // key "onesignal.player_id"
            dsx.resolve(true)
        }
        dsx.action("read") { dsx in
            dsx.resolve(JSON(["id": dsx.container.string("player_id")]))
        }
    }
}
```

| Call | Does |
|------|------|
| `dsx.container.set(k, v)` | store a value **and signal observers**; `nil` removes the key |
| `dsx.container.batch { … }` | several writes, **one** signal |
| `dsx.container.remove(k)` | delete a key (and signal) |
| `dsx.container.post()` | signal observers **without** writing (e.g. after a raw write) |
| `dsx.container.string(k)` / `.bool` / `.int` / `.double` / `.data` / `.value` | typed reads |
| `dsx.container.url()` | your folder in the shared file container (created on demand) |
| `dsx.container.isAvailable` | `false` on a build that didn't ship the container (reads return defaults, writes drop) |

## 3. Reach another module's folder - `dsx.container.<scheme>`

Address another module's subcontainer by name. The dot form is typed-feeling
(same shape as `dsx.module.<scheme>`); the subscript is the string fallback.

```swift
let id  = dsx.container.onesignal.string("player_id")   // dot form
let id2 = dsx.container["onesignal"].string("player_id") // string form
let c   = dsx.container.sub("onesignal")                 // explicit
```

Routing is **root-relative and flat**: `dsx.container.onesignal` is the top-level
`onesignal` folder no matter who asks. It addresses one level (one folder per
scheme); don't chain deeper.

## 4. React to changes - one generic signal, any consumer

The change mechanism is deliberately **consumer-agnostic**, so it fits any
app-group implementation imaginable, not just the four defaults. The core knows
two verbs and every consumer plugs into them; nothing about widgets - or any
specific consumer - is baked into the container.

- A write **signals on its own** - `dsx.container.set` / `remove` notify observers
  (the container is for shared data). `dsx.container.post()` signals **without**
  writing (after a raw write, or from an extension). Either is a name-only
  cross-process ping (Darwin notification; App Group `UserDefaults` changes aren't
  delivered across processes by KVO / `NSUserDefaultsDidChange`).
- `dsx.container.observe { }` - receive that signal in any *running* process (the
  app, a live share / notification-service extension); re-read inside and emit.

```swift
override func setup() {
    // React when another process writes our folder, while the app is running.
    dsx.container.observe { [weak self] in
        let url = self?.dsx.container.string("imageURL")
        self?.dsx.broadcast("changed", JSON(["imageURL": url]))
    }
}

// A write signals on its own; observers re-read:
dsx.container.set("imageURL", url)

// Several writes, one signal:
dsx.container.batch { $0.set("imageURL", url); $0.set("refresh", 15) }
```

- `observe` returns a `ContainerSubscription`; ignore it to observe for the app's
  lifetime, or keep it and `cancel()`.
- The app only receives signals **while running**. On cold launch the signal is
  missed, so re-read in `hydrate` / the `"becomeActive"` hook - the ping is a live nudge,
  the container is the source of truth.
- Observe another folder the same way: `dsx.container.onesignal.observe { … }`.

### From an extension (no `dsx`)

An extension uses the App Group directly and posts the same Darwin name the app
observes - `group.<bundleid>.container.changed.<scheme>`:

```swift
let d = UserDefaults(suiteName: "group.<bundleid>.container")
d?.set(url, forKey: "<scheme>.imageURL")
CFNotificationCenterPostNotification(
    CFNotificationCenterGetDarwinNotifyCenter(),
    CFNotificationName("group.<bundleid>.container.changed.<scheme>" as CFString),
    nil, nil, true)
```

### A consumer that isn't a running process

Some consumers can't `observe` because they aren't alive to listen - a widget is
spun up only to rebuild its timeline. That's not the container's job to solve:
the consumer's **own module** drives its own framework, reacting to the generic
signal (while the app runs) or pulling on its own schedule. WidgetKit stays in
the widget module, never in the container core:

```swift
import WidgetKit   // in the widget module - NOT in the container engine

final class WidgetBridge: Module {            // scheme "widget"
    override func setup() {
        dsx.container.observe {                 // our folder changed
            if #available(iOS 14.0, *) { WidgetCenter.shared.reloadAllTimelines() }
        }
    }
}
```

A Live Activity module would `observe` and call `Activity.update`; a Watch
companion would use `WatchConnectivity`; a custom extension does whatever it
needs. The container never grows a method per consumer - it stays a generic
signal bus, so a brand-new kind of app-group consumer needs zero core changes.

## Bulletproofing - the rules that keep it safe

- **Name = scheme.** Your folder is your scheme; another module's is its scheme.
  Names are sanitized to `[A-Za-z0-9._-]` so they're always safe as keys and
  paths.
- **Member names win over the dot form.** The reads/writes above (`set`, `string`,
  `value`, `url`, `name`, `isAvailable`, `sub`, `remove`, …) are real members, so
  a subcontainer whose scheme is one of those names is shadowed by the dot form.
  Reach it with the **subscript**: `dsx.container["data"]`. Use the subscript
  whenever the name is dynamic or might collide.
- **Degrade, don't crash.** On a build without the container, `isAvailable` is
  `false`, reads return defaults, and writes are dropped. Code that uses the
  container still runs on a build that excluded it.
- **No secrets.** The group is shared in-process and across extensions; it's not
  an isolation boundary. Tokens and keys belong in the Keychain.

## How each consumer participates

Every app-group consumer stores in the one container; how it *reacts* to a change
depends on how that consumer can be woken. An extension target joins the group by
appearing in its module's `targets`; from the app side
`dsx.container.<scheme>.url()` and the extension's own `UserDefaults(suiteName:)`
meet in the same folder.

| Consumer | Reacts to a change via |
|----------|------------------------|
| **Widgets** | `WidgetBridge` runs `dsx.container.observe { WidgetCenter.reloadAllTimelines() }`; `widget://set` writes + `post()`s. A widget has no other wake, so it needs the signal - and WidgetKit lives in the widget module, not the core. |
| **Share extension** | already has a wake: the extension opens the host (`URLSCHEME://shareddata`), which reads the container on launch. Storage only, no observe. |
| **OneSignal** | pointed at the container with `OneSignal_app_groups_key` (app + NSE Info.plist); the bridge reacts to pushes through the `dsx.hook("remoteNotification")` hook, not the container. |
| **App Clip** | nothing today (shares no data, carries no group). A future handoff opts in with `"container": true` and reads via `dsx.container`. |

The rule: a consumer that can't be woken any other way (a widget) uses
`observe`/`post`; one that already has a wake (a URL open, a push hook) just uses
the container for storage. New consumers pick whichever fits.

### An SDK that dictates its own group

OneSignal's NSE coordinates over an app group it names itself, so point it at the
container with its override - the `OneSignal_app_groups_key` Info.plist value set
in the app and the NSE - and it uses the reserved group instead of its
`.onesignal` default. Same idea for any SDK that hardcodes a group name.

## Scales to any number of modules

The point of one group: 4 core or 400 custom modules, still **one** App Group.

- A module opts in with `"container": true` - the only provisioning step, and it
  never changes. `prepare_modules` adds the one reserved group to the module's
  targets; many modules requesting it collapse to a single entitlement (deduped),
  so the App ID, profiles, and CI still deal with exactly one group.
- Each module's data is isolated by its scheme subcontainer (`<scheme>.` keys, a
  `<scheme>/` folder), so modules never collide however many there are.
- Change signals are per-subcontainer, so modules don't hear each other's posts.
- Nothing in the container core, `prepare_modules`, or codemagic is named after a
  module or a consumer type, so the Nth module needs zero core or CI changes.

## Fully dynamic - nothing hardcoded per module

Adding a module never means editing the core. Everything is derived at runtime:

- **Namespace = your scheme.** `dsx.container` binds to `store.primaryScheme`; you
  never write your module's name anywhere.
- **Keys are yours, prefixed automatically.** `set("k", v)` stores `<scheme>.k` -
  you choose the key, the system prefixes it. No key is hardcoded in the core.
- **Cross-module access is dynamic.** `dsx.container.<scheme>` and
  `dsx.module.<scheme>.<action>` resolve through `@dynamicMemberLookup` - no
  generated accessor, no per-module method; any scheme/action string works.
- **Group id is derived:** `group.<Bundle.main.bundleIdentifier>.<suffix>`.

The single fixed string is the reserved suffix `container` (the shared group's
name). It lives in exactly three spots, one per layer: the engine
(`Container.groupID`), the build (`prepare_modules.rb` `CONTAINER_GROUP`), and CI
(`codemagic.yaml`, the app-groups step). Change it there and nowhere else.

(A module's *own* keys inside its folder - `widgetImageURL`, `player_id` - are
yours to name; that's your data, not the system hardcoding anything.)

That's the whole mental model, and it's **cross-platform by being a proxy**:
`dsx.container.<x>` resolves dynamically at runtime and reads the same in Swift
and Kotlin (only the dot vs `["x"]` step differs). You think in `dsx.container` -
not in App Groups or DataStore - so the model is identical on both platforms even
though the backing isn't. Infinite, never hardcoded, same syntax everywhere. See
the [android/](android/) folder.

## Security model

How one group serves every module without modules stepping on (or spying on)
each other. Read this before storing anything sensitive.

### What is actually isolated

- **From other apps: yes, by the OS.** The App Group is shared only by *this*
  app and its extensions (same Apple Developer team, the provisioned group id).
  No other app on the device can read it. That boundary is real and enforced.
- **Between modules: no, by design.** Every module compiles into the app
  process and already has the app's full rights - every App Group, file, and
  Keychain item the app can reach. The per-module folders are **organization and
  convention, not a sandbox.** No in-process mechanism can wall one module off
  from another; they share the process.

### Folders + the write-your-own rule

- Each module gets a folder named by its `scheme`; you read and write yours
  through `dsx.container` (keys become `<scheme>.<key>`, files live in
  `<scheme>/`). That alone removes collisions, however many modules there are.
- `dsx.container.<other>` is **read-only**: `set` / `remove` / `post` / `observe`
  on another module's folder are blocked by the API (a no-op, with a debug
  nudge). You can only mutate or signal your *own* folder. This stops one module
  from clobbering or impersonating another through the blessed API.

### Use another module through its exposed feature, not its folder

If you need data or behavior another module owns, call the action it chose to
expose:

```swift
let result = try await dsx.module.onesignal.id()    // onesignal decides what to return
```

The owning module validates the input and controls what it hands back - that's
the encapsulation boundary. Reading `dsx.container.<other>` directly is an escape
hatch for trivial cases; the durable, intended path is `dsx.module`. See
[cross-module-calls.md](cross-module-calls.md).

### The honest caveat

The write-your-own rule is an **API guardrail, not a kernel boundary**. An
in-process module *can* bypass it with raw `UserDefaults(suiteName:)` or the
container URL, because it shares the process. Treat it as a strong convention and
a nudge, never as a wall against a hostile module. Real isolation between code
needs separate processes (an extension over XPC) - a different architecture from
an in-process module.

### Secrets

Never put secrets in the container - it's plaintext plists and files shared with
every extension. Use the **Keychain** (a keychain access group when an extension
needs it). Even the Keychain is shared in-process, so it guards against other
apps and at-rest exposure, not against a malicious in-process module.

### Trust is established at build time

Because modules run in-process with full app privileges, the real control is
**reviewing what you bundle**: a module can do anything the app can, so vet
custom modules before they're compiled in. The container organizes data and
nudges callers toward clean boundaries; it does not sandbox, because nothing
in-process can.

## Android & cross-platform parity (plan)

DespiaScript is 1:1 across iOS and Android, so `dsx.container` should read the
same in Kotlin. It ports cleanly, and Android is *simpler*. (Full Android dev
mapping, with Kotlin examples: [android/containers.md](android/containers.md) and
the [android/](android/) folder. This is the summary.)

**Android has no "App Groups" - and doesn't need them.** A home-screen widget
(`AppWidgetProvider` / Glance) and a share target (an `ACTION_SEND` Activity) run
*inside the same app package*, sharing the app's own storage by default. The
iOS-only problem `dsx.container` solves - cross-process, entitlement-gated sharing
between the app and its extensions - mostly doesn't exist on Android. So the API
stays identical; only the backing differs:

| `dsx.container` | iOS | Android |
|---|---|---|
| storage | App Group `UserDefaults` + container dir | app `DataStore` / `SharedPreferences` + `filesDir` (no entitlement) |
| folders (per scheme) | key prefix + subdir | key prefix + DataStore file / subdir |
| `observe { }` | Darwin notification | `OnSharedPreferenceChangeListener` / DataStore `Flow` (same-process, more reliable) |
| `post()` | Darwin ping (needed cross-process) | usually implicit - same-process listeners fire on write; `post()` is a no-op / local emit |
| provisioning | one reserved App Group, signed | none - app-private storage |
| widget refresh | `WidgetCenter.reloadTimelines` (in the widget module) | `AppWidgetManager.updateAppWidget` / `GlanceAppWidget.update` (in the widget module) |

**Plan (for the Android runtime repo, not this one):**

1. `Container` (Kotlin) with the same surface - `set`/`string`/`value`/`remove`/
   `url`, subcontainer routing (`container["scheme"]` via `operator get`),
   `observe`, `post`, `isAvailable` - backed by DataStore, namespaced by scheme.
2. `observe` registers a change listener / collects a `Flow`; `post` is a no-op
   (or emits to a local flow), since same-process observers already fire on write.
3. Consumer refresh stays in the consumer module: the Android widget module
   calls `AppWidgetManager` / Glance from its `observe`, exactly as the iOS widget
   module calls `WidgetCenter`.
4. `"container": true` in the manifest is a **no-op on Android** (no group to
   provision); the build ignores it and module code calls `dsx.container` the same.
5. Same security story: in-process modules share the app, folders are convention,
   secrets go in the Android Keystore / `EncryptedSharedPreferences`.

Net: write `dsx.container…` once and it compiles on both. iOS does the heavy
lifting (entitlements, Darwin); Android is a thin DataStore wrapper. Worth doing
when the Android runtime gains widget / share parity - **no iOS change needed
now**, and the iOS API above is already shaped so the Kotlin port is mechanical.

## Relationship to `dsx.module.cdn.object("store")` / `storage://`

Different stores. `dsx.container` is the cross-process App Group (small key/value
plus files shared with extensions). `dsx.module.cdn.object("store")` / `storage://` is the LocalCDN
file store for web uploads and downloads. Use the container for app↔extension
handoff, the CDN for web-facing files.
