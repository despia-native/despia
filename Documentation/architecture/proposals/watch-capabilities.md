# Watch capabilities — every feature on the wrist, no sub-packages

**Status: v3 — FOUNDATION LANDED** · builds on `watch-runtime.md` (nodes + one bus;
Wear OS 1:1) and the constitution. The facet registry, the `provides`/`reach`
contract grammar, NESTED MODULES (a module's `Modules/` container — full-citizen
children, cascade exclusion, two parent shapes: feature-parent vs domain-parent,
"if excluding every child should leave nothing behind, the parent must own
nothing native"), and the build-visibility introspection (`despia.excluded` /
`wasExcluded`) are LANDED — the accepted law is **`../facet-contracts.md`**.
This proposal remains the watch program: the capability ladder, the feature
catalog, and the P1-P4 landing order (facet folder fan-in → elements → Health).
v2 history: facet names are REGISTERED, never script-known; no default
platform, no default target (the symmetric `<platform>/<facet>/` tree).

## The law: the wrist is a surface, not a platform fork

There is no "watch maps" package and there never will be. A capability's OWNER
owns it on every node: **Maps** owns maps on the phone *and* the wrist;
**Location** owns GPS wherever a fix is read; **Haptics** owns the tap wherever
a wrist buzzes. A module's watch support is a **facet of that module** — files
and declarations inside its own folder, exactly like the `kotlin/` facet —
never a sibling package. The payoffs are the same ones the android facet
already proved:

- **One switch.** Excluding Maps removes maps everywhere, including the watch.
  A sub-package would mean two modules to exclude, two configs, and drift.
- **One config.** The module's `config.json` serves every surface; a watch
  sub-package would fork per-app configuration.
- **One owner for parity.** The iOS/Android twin ledger stays per-module; a
  sub-package would need its own ledger row and its own deferral story.

## The capability ladder — per feature, take the lowest rung that works

1. **RELAY (works today).** Watch markup calls the owning module's phone-side
   actions through the compiled relay table (`reach: ["watch"]` in the owner's
   manifest — fail-closed, background-capable transport). GPS v0 is exactly
   this: the Location module relays `locate`, the watch shows the fix the phone
   read. Data flows ride phone-as-gateway `fetch`.
2. **STATE (works today).** The owner publishes context/state; the watch reads
   pushed snapshots (`dsx.module.<scheme>.state.*` on the phone side, snapshot
   vars on the wrist).
3. **ELEMENT (new primitive).** A module contributes a watch-renderable
   element — `<map>` from Maps is the canonical case (watchOS renders MapKit;
   Wear renders Compose maps). The manifest declares the element + its
   node-side sources; prepare wires them into the watch target's table the
   same way StackWatch extends the base table today. **This is authoring
   surface** — the unified-codebase law applies in full: platform-neutral
   fixture corpus first, then the TS, Kotlin (Wear) and Swift (watchOS)
   implementations.
4. **NATIVE FACET (new primitive).** A watch-LOCAL capability — on-wrist GPS,
   heart rate / workout sessions, wrist haptics — ships watch-target sources
   plus plist/entitlement contributions from the OWNING module, placed under a
   **registered facet folder** (next section). prepare_modules fans them into
   the registering target exactly like `extensionTargets` fan-in works today
   (file presence is the gate; excluding the module tears its facet files back
   out). The Wear twin is the same facet name under `android/`.

## The facet registry — no name is kernel-known

The scripts must not carry a vocabulary of deployment targets ("watch",
"keyboard", even "app") — a hardcoded facet name is `#if WATCH_ENABLED`
relocated into Ruby, and it is illegal here. Facet names are DECLARED, by the
module that OWNS the target, as one word on its target spec:

```jsonc
// Core/Extensions/Watch — the target owner binds the folder name
"extensionTargets": [{ "name": "DespiaWatch", "kind": "watch", "facet": "watch", … }]
```

- **`Mandatory/App`** declares the host target → it registers **`app`**.
- **`Core/Extensions/Watch`** registers **`watch`**; Keyboard registers
  **`keyboard`**; AppClip registers **`clip`**; a future target registers
  whatever it names.
- prepare stays fully generic: it joins *facet names registered by target
  owners* × *facet folders present in contributing modules*. It ships knowing
  zero names.
- **The cascade is the point:** exclude the Watch module and the word `watch`
  is UNREGISTERED — every other module's `watch/` folder across the tree goes
  inert in the same stroke. One switch removes the limb AND every organ's
  nerve ending into it.
- **Typo gate:** a facet folder whose name matches nothing ANY manifest
  declares warns loudly at prepare (a misspelling); a name that is declared
  but excluded is silent by design (that is what exclusion means).

## No default platform, no default target — the symmetric tree

Root-files-are-iOS is an assumption wearing a trench coat, and `Watch/` beside
it assumes a default target the same way. The lawful shape is symmetric — the
platform folders are the kernel's OWN matrix (ios/android/web are the three
renderers the unified-codebase law already names; that is constitutional
bedrock, not a hardcode), and every folder inside them is a registered facet:

```
Core/Maps/
  dsx.json                    ← ONE word: one scheme, one exclusion token
  ios/
    app/Maps.swift            ← MapKit — fans into whatever registered `app`
    watch/WatchMap.swift      ← SwiftUI Map (watchOS) — into the `watch` registrant
  android/
    app/MapsBridge.kt
    watch/WearMap.kt          ← Compose maps — into the Wear `watch` registrant
```

**Migration is declared, not a flag day:** the resolver treats legacy
module-root Swift as an alias for `swift/app/` (warned, so the tree drains
toward the symmetric shape), and today's `android/` re-reads as the platform
container it already almost is. Both aliases are removal-listed once the last
module migrates.

## The cross-platform gate — "one feature always works on both", as law

`watch-runtime.md §Cross-platform` already declares Wear OS 1:1. This proposal
makes the gate operational, mirroring the three-renderer rule:

> A watch feature SHIPS when the watchOS facet and the Wear facet both land —
> fixtures first wherever it adds authoring surface. A platform deferral is
> DECLARED (the `.kt`-header convention + the android-status roll-up), never
> silent.

## Feature map — owner → rung → platform APIs

| Feature | Owner module | Rung | watchOS | Wear OS |
|---|---|---|---|---|
| Wrist haptics | Haptics | 4 (tiny) | `WKInterfaceDevice.play` | `VibrationEffect` |
| GPS on wrist | Location | 1 today → 4 | CoreLocation (watch) | Fused Location |
| Maps | Maps | 3 | MapKit on watchOS | Compose Maps |
| Heart rate / workout | Health (new module) | 4 | HealthKit + Workout sessions | Health Services |
| Complications / tiles | Widgets | W7 (designed) | WidgetKit accessory families | Tiles + Complications |
| Audio on wrist | Media | 4 | AVAudio (watch) | Wear media session |
| Push / notifications | OneSignal | mostly free | mirrored + watch-custom | bridged |
| Connectivity status | kernel (`dsx.link`) | landed | WatchConnectivity | Wearable Data Layer |

## What lands first

- **P1 — the facet registry + native-facet primitive**, proved by the two
  smallest features: wrist haptics (a dozen lines per platform) and on-wrist
  GPS (the Location facet). This lands `facet:` on the target spec, the
  generic folder fan-in (zero names in scripts), the root→`swift/app/` alias,
  and the parity gate — everything later features reuse.
- **P2 — the element primitive**, proved by `<map>`: the fixture corpus, the
  table-extension wiring, the three implementations.
- **P3 — the Health module** (rung 4 at real scale) and W7's complications.

Nothing in this plan adds a package. Every row lands inside the module that
already owns the capability — the watch just becomes one more surface those
modules provide to.

## The wrist catalog — feature × verb × platform (the completeness matrix)

**Status: COMPLETE (both platforms).** Every feature of the shipped catalog
(`Core/Extensions/Watch` + its nested `watch.health` / `watch.face` children)
carries its full verb set — query / start / stop / status / cancel / clear
wherever the verb is *meaningful* — on watchOS **and** Wear OS. The shape
authority is the package's `dsx.json` (every verb is manifest-tested;
`verify_module_tests.rb` gates the build). Where a platform cannot support a
verb it answers the **structured** error and the divergence is pinned (`.kt`
headers + `android-status.md`) — never silent. Verb-completeness law by
feature *kind*: a **one-shot** settles in one leg and needs no stop/cancel
(dictate's only cancel is the wearer's — the sheet is modal on the wrist); a
**stream** has on/off + the `status` read; a **long-running capture** has
start/stop/cancel + `status`; a **store** has write/list/clear; a **scheduler**
has schedule/cancel/clear; a **push surface** has set/clear.

| Feature | Verb | Kind / what it does | watchOS | Wear OS |
|---|---|---|---|---|
| render | `watch.render` | push a DSX layout to the wrist | ✓ | ✓ |
| route | `watch.route` | navigate the wrist router | ✓ | ✓ |
| update | `watch.update` | push state vars (snapshot family) | ✓ | ✓ |
| link | `watch.reachable` | one-shot: paired / reachable / online | ✓ | ✓ (`paired` = connected ∪ installed nodes — pinned) |
| haptic | `watch.haptic` | one-shot play | ✓ WKInterfaceDevice | ✓ VibrationEffect map |
| notify | `watch.notify` | schedule (+ `actions` buttons, inline `reply`) → `{ scheduled, id }` | ✓ | ✓ |
| | `watch.notifyCancel` | cancel ONE by the resolved `id` — pending AND delivered | ✓ removePending/removeDelivered | ✓ NotificationManager.cancel + the unscheduled delayed post |
| | `watch.notifyClear` | clear ALL of the app's wrist notifications | ✓ removeAll* | ✓ cancelAll + parked posts |
| battery | `watch.battery` | one-shot read | ✓ | ✓ |
| dictate | `watch.dictate` | one-shot input sheet (wearer dismiss ⇒ `cancelled`) | ✓ | ✓ (RecognizerIntent; backgrounded ⇒ `unavailable`, pinned) |
| audio | `watch.audio` | play a bundled / remote sound | ✓ | ✓ |
| | `watch.audioStop` | stop NOW → `{ stopped }`; an in-flight play settles its own promise `cancelled` (never a hang) | ✓ (remote-fetch generation) | ✓ (preparing-player seam) |
| locate | `watch.locate` | one-shot fix on the wrist | ✓ | ✓ |
| keepAwake | `watch.keepAwake` | on/off; an arm that cannot engage NOW defers honestly → `{ on: true, deferred: true }` | ✓ ACTIVE-only session start (the activation law) — a wrist-down arm engages on the next wrist-raise | ✓ window flag applies with ANY live window; only the no-activity case defers, engaging on next resume (pinned asymmetry) |
| wrist status | `watch.status` | THE session/stream snapshot: `keepAwake · keepAwakeArmed · crown · motion · recording · dictating · playing` (with `reachable` + `ambient`, the whole wrist state is queryable) | ✓ | ✓ |
| openOnPhone | `watch.openOnPhone` | wrist→phone handoff (deferred-to-foreground shape) | ✓ | ✓ |
| crown | `watch.crown` | stream on/off (status via `watch.status`) | ✓ digital crown | ✓ rotary |
| ambient | `watch.ambient` | display snapshot + the change stream | ✓ | ✓ (`reduced` always false — pinned until AmbientLifecycleObserver) |
| motion | `watch.motion` | stream on/off (status via `watch.status`) | ✓ CMMotionManager | ✓ SensorManager (accelerometer fallback pinned) |
| record | `watch.record` | start the capture (wrist sheet: Stop / ✕ / `maxSeconds` cap; file rides back as `watch.file`) | ✓ | ✓ (foreground required — pinned) |
| | `watch.recordStop` | phone-initiated Stop — the take ends and KEEPS (the record promise resolves) | ✓ | ✓ |
| | `watch.recordCancel` | phone-initiated ✕ — the take DISCARDS (the record promise rejects `cancelled`) | ✓ | ✓ |
| transfer | `watch.transfer` | queue a file TO the watch (the ONE queued verb — no live-link gate by design) | ✓ | ✓ |
| | `watch.transferList` | list the wrist's delivered store, newest first | ✓ Documents/transfers/ | ✓ files/transfers/ |
| | `watch.transferClear` | delete one (`name`) or all → `{ cleared: n }` | ✓ | ✓ |
| face | `watch.face.set` | push the glanceable `{ text, value? }` pair | ✓ complication | ✓ tile (placeholder-tile pin) |
| | `watch.face.clear` | remove the pair — placeholder returns on the next repaint | ✓ | ✓ |
| health | `watch.health.heartRate` | stream on/off | ✓ | ✓ (~1 Hz classic sensor — pinned) |
| | `watch.health.workout` | start/stop + pause/resume `control` + live metrics | ✓ | ✓ (metric-cadence pin) |
| | `watch.health.steps` | one-shot read | ✓ | ✓ |
| | `watch.health.read` | one-shot metric read (CLOSED vocabulary) | ✓ all six | calories + distance; the rest answer the structured `unsupported_metric` + supported list (pinned) |
| internal | `watch.command` | the nested children's transport (`exposed: false`) | ✓ | ✓ |

Failure symmetry: every wrist-executed verb fails `unreachable` NOW with no
live link (the adopted offline contract — `transfer` alone is queued by
design); transport errors are `timeout` / `link_failed`; per-feature codes
(`missing_id`, `no_recording`, `cancelled`, `notifications_denied`,
`mic_denied`, `location_denied`, `unsupported_metric`, …) are byte-identical
across the two host bridges. Received-file housekeeping on the PHONE side
(`Documents/watch/` · `filesDir/watch/`) is app-owned storage announced with
its absolute path via the `watch.file` event — outside the wrist catalog by
design.
