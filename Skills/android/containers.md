# `dsx.container` on Android

Same mental model, Kotlin spelling. `dsx.container.<scheme>.<key>` is a **dynamic
proxy** - it resolves at runtime, nothing is hardcoded, the possibilities are
open-ended - and it means the same thing here as on iOS. The table below is the
*backing* a caller never sees; the syntax is the part that's 1:1. Read the iOS
[containers.md](../containers.md) for the model.

## Why Android is simpler

iOS `dsx.container` exists to share data across **separate, sandboxed, signed
processes** (the app and its extensions) through an App Group. Android doesn't
have that problem: a widget (`AppWidgetProvider` / Glance), a share Activity
(`ACTION_SEND`), and an FCM service all run **inside the same app package** and
read the app's own storage by default. So there's no group to provision, no
entitlement, no cross-process bridge - `dsx.container` is just a namespaced view
over the app's `DataStore` (or `SharedPreferences`).

| `dsx.container` | iOS backing | Android backing |
|---|---|---|
| key/value | App Group `UserDefaults` | `DataStore<Preferences>` (or `SharedPreferences`) |
| files (`url()`) | App Group container dir | `context.filesDir` subdir |
| `observe { }` | Darwin notification | `DataStore` `Flow` / `OnSharedPreferenceChangeListener` |
| `post()` | Darwin ping (needed cross-process) | no-op (same-process observers already fire) |
| `isAvailable` | App Group provisioned | always `true` (app storage always exists) |
| provisioning | one reserved App Group, signed | none |

## Same surface, Kotlin syntax

```swift
// iOS
dsx.container.set("player_id", id)                    // writes + signals; folder "<scheme>"
let id  = dsx.container.string("player_id")
let oid = dsx.container.onesignal.string("player_id") // read another folder (escape hatch)
dsx.container.post()                                   // signal WITHOUT writing (after a raw write)
let sub = dsx.container.observe { /* re-read */ }
```
```kotlin
// Android
dsx.container.set("player_id", id)                    // writes + signals (DataStore Flow emits)
val id  = dsx.container.string("player_id")
val oid = dsx.container["onesignal"].string("player_id")  // operator get, not dot
dsx.container.post()                                   // no-op; the write above already signalled
val sub = dsx.container.observe { /* re-read */ }
```

Only the cross-folder **step** differs (`.onesignal` vs `["onesignal"]`), the
same rule as `dsx.module`. Everything else is identical.

## Folders = namespaces (same as iOS)

Each module's folder is its scheme. On Android:

- key/value: keys are prefixed `<scheme>.<key>` in the one `DataStore`, or each
  scheme gets its own `DataStore` file - either gives per-module isolation.
- files: `filesDir/<scheme>/…`.

## observe / post

`observe` is **more reliable on Android**, because the listeners are same-process
and first-party:

```kotlin
override fun setup() {
    // re-run whenever our folder changes
    dsx.container.observe {
        val url = dsx.container.string("imageURL")
        dsx.broadcast("changed", JSON(mapOf("imageURL" to url)))
    }
}
```

Back it with a `DataStore` `Flow` collected on a scope, or a
`SharedPreferences.OnSharedPreferenceChangeListener`. Because a same-process write
already notifies those listeners, `post()` is a **no-op** on Android (keep it in
your module for parity - it does the work on iOS and harmlessly nothing here).

## Widgets: the consumer reacts, same as iOS

The widget module owns the refresh, reacting to the signal - exactly the iOS
pattern, with the Android API:

```swift
// iOS widget module
dsx.container.observe { WidgetCenter.shared.reloadAllTimelines() }
```
```kotlin
// Android widget module
dsx.container.observe {
    val mgr = AppWidgetManager.getInstance(context)
    val ids = mgr.getAppWidgetIds(ComponentName(context, ImageWidget::class.java))
    mgr.notifyAppWidgetViewDataChanged(ids, R.id.widget_list)   // or GlanceAppWidget.update(...)
}
```

WidgetKit stays in the iOS widget module; `AppWidgetManager` / Glance stays in
the Android widget module. The container core knows about neither.

## Manifest

`"container": true` is a **no-op on Android** - there's no group to provision.
Keep it in the shared `dsx.json` (it does the iOS work); the Android build
ignores it and module code calls `dsx.container` the same way.

## Security

Same story as iOS, one platform note: in-process modules share the app, folders
are convention not a sandbox, and the write-your-own / read-others-as-escape-hatch
+ use-`dsx.module`-for-features rules are identical. For secrets use the **Android
Keystore** / `EncryptedSharedPreferences` (the iOS Keychain analog), never the
container.

## Worked example: a novel consumer (zero core changes)

Nothing about widgets, watches, or Live Activities lives in the container. A
brand-new consumer plugs in with `container: true` + `dsx.container` + `observe`
+ its own framework - the core never changes. Here's an Apple Watch / Wear OS
module that didn't exist before.

**dsx.json (shared by both platforms):**

```json
{ "name": "Watch", "scheme": "watch", "container": true }
```

**iOS (Swift) - WatchConnectivity:**

```swift
import WatchConnectivity

final class WatchBridge: Module {
    override func setup() {
        dsx.action("set") { dsx in                       // web pushes data for the watch
            dsx.container.set("payload", dsx.args("payload"))   // writes + signals our observer
            dsx.resolve(true)
        }
        dsx.container.observe { [weak self] in            // folder changed -> send to watch
            guard WCSession.default.activationState == .activated else { return }
            try? WCSession.default.updateApplicationContext(
                ["payload": self?.dsx.container.value("payload") as Any])
        }
    }
    // (activate WCSession in the launch hook; delegate omitted)
}
```

**Android (Kotlin) - Wear Data Layer:**

```kotlin
class WatchBridge : Module() {
    override fun setup() {
        dsx.action("set") { dsx ->
            dsx.container.set("payload", dsx.args("payload"))   // writes + signals our observer
            dsx.resolve(true)
        }
        dsx.container.observe {
            val payload = dsx.container.string("payload") ?: return@observe
            val req = PutDataMapRequest.create("/payload")
                .apply { dataMap.putString("payload", payload) }
                .asPutDataRequest().setUrgent()
            Wearable.getDataClient(context).putDataItem(req)
        }
    }
}
```

The web call is identical on both: `await dsx.module.watch.set({ payload })`.
The author wrote `dsx.container` + `observe` + their device framework
(WatchConnectivity / Wear `DataClient`). **The container core, `prepare_modules`,
and codemagic did not change** - that's the test of "infinite, never hardcoded."

### Same shape, other novel consumers

- **Lock Screen widget (iOS 16+):** identical to the home-screen widget module -
  `dsx.container.observe { WidgetCenter.shared.reloadAllTimelines() }`; the
  extension just adds `accessoryRectangular` / `accessoryCircular` families and
  reads the container in its timeline. No new mechanism.
- **Live Activity / Dynamic Island (iOS 16.1+):** `dsx.container.observe {
  Activity.update(...) }`. Android's closest is an ongoing notification, written
  the same way in the Android module.
- **Aggregator (a watch face showing several modules' data):** *read* other
  folders through the escape hatch (`dsx.container.onesignal.string(...)`) or pull
  their exposed features (`dsx.module.onesignal.id()`), then refresh on your
  own cadence. You still only *write* your own folder.

## Build checklist (Android runtime repo)

1. `Container` (Kotlin) with the iOS surface: `set` / `string` / `bool` / `int` /
   `double` / `data` / `value` / `remove` / `url()` / `isAvailable`, subcontainer
   routing via `operator fun get` (+ `sub(name)`), `observe`, `post`.
2. Back it with `DataStore`, namespaced by `store.primaryScheme`; `filesDir` for
   files.
3. `observe` → collect a `Flow` / register a listener; `post` → no-op (or emit to
   a local flow for symmetry).
4. Enforce write-your-own (named views are read-only), same as iOS.
5. Consumer refresh (widgets, etc.) lives in the consumer module, not the core.
