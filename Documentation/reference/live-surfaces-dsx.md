# Live surfaces from DSX XML — Live Activities + Widgets, fully dynamic

> Status: DESIGN (approved direction) · prerequisites SHIPPED 2026-06-11 — every
> extension target is module-owned + manifest-synthesized (`productType`,
> `sharedSources`, `resources`, `buildSettings`); ActivityKit/Widgets modules own
> their `.appex` sources end to end.

## The constraint that shapes everything

A widget/Live-Activity process **cannot execute downloaded code** — Apple compiles
its SwiftUI ahead of time. So "dynamic via DSX XML" cannot mean shipping new Swift.
It means what the in-app engine already proved: ship a small, generic **interpreter**
once, and feed it *markup + state* at runtime. The extension renders whatever DSX it
is handed; the layout is data, not code. (Same trick the app's Stack engine uses —
the contract is names, not platforms: Android renders the identical markup in
Compose/Glance.)

## Architecture (constitutional)

1. **One grammar, a render backend per surface** — the engine's renderer split
   into three engine-owned files, all `extensionTargets.extraSources` into the
   widget/Activity targets:
   - **`StackNode.swift`** — the AST + parser (`StackNode` / `StackXML`). Pure
     Foundation, the single source of truth for *what DSX means*; the full
     in-app engine (`Stack.swift`) and every extension compile the SAME parser.
   - **`StackScope.swift`** — value resolution: a `StackReader` gives elements
     typed, `$var`-substituted access to a node's attributes (no view code, so
     it's unit-testable in isolation).
   - **`StackLive.swift`** — the WidgetKit-safe backend. The node→View mapping
     is a **registry of tiny `StackElement` types** (`tag` + `body(reader)` —
     the exact shape the in-app component registry uses), not a switch: adding
     `<gauge>` registers one type, and an Android Glance backend implements the
     same table. The uniform layout box (padding/bg/radius/grow/opacity) and
     child recursion are the backend's job, so elements stay declarative.
   The full engine is the interactive backend of the same grammar; it is NOT
   forced behind this protocol (it is a live reactive runtime, not a static
   projection) — the honest seam is the shared AST, not a fake unification.
   Fail-open throughout: bad markup → `StackLive.parses` is false and the caller
   keeps its built-in view; unknown tag → nothing; missing `$var` → empty. Node set is
   deliberately tiny and WidgetKit-safe: `vstack/hstack/zstack/text/image/progress/
   gauge/spacer/timer`, attributes `color/size/weight/radius/padding/spacing/grow`,
   `{{ dsx.variable.x }}` interpolation from a `[String: String]` state dict (the simple-reference subset; no JS in-process). No actions, no
   scripts, no network — pure projection of state. (~300 lines; subset of Stack.swift
   semantics so the SAME markup previews inside the app via the full engine.)
2. **Markup + state cross the process boundary through the container plane** (the
   one reserved App Group — `containers.md`): the host writes
   `liveactivity.layout.<id>` (the DSX string) and the typed `ActivityAttributes`
   content state carries the variable dict. Widgets read `widget.layout` +
   `widget.state` from the same container on each timeline tick. Darwin signal =
   refresh nudge. No new IPC invented.
3. **The modules stay the only API surface** (modern `despia.<scheme>.<action>`
   calls — the `://` URL forms are documented only where a LEGACY api survives):
   - `despia.liveactivity.layout({ layout })` — set the default DSX layout
   - `despia.liveactivity.start({ id, layout?, name?, progress?, vars? })`
   - `despia.liveactivity.update({ id, progress?, status?, vars? })`
   - `despia.liveactivity.end({ id, success? })`
   - `despia.widget.layout({ layout, vars? })` — the dynamic widget surface.
     (Legacy: `widget://set` / `widget://<url>?refresh=N` keep working 1:1.)
   Web AND any module can call these (`dsx.command`), so a DSX-first app gets live
   surfaces with zero web code.

### The Live Activity document (DSX, not JSON)

A Live Activity is ONE DSX document whose presentation slots are **elements** —
the Dynamic Island is expressed in the same DSL and its primitives, never a JSON
map. `StackActivity` (engine) parses it with the one parser and exposes each
slot's subtree; `StackLive` renders each. Slot taxonomy is Apple's; the language
is ours.

```xml
<activity>
  <lockscreen> …one layout… </lockscreen>      <!-- lock screen / banner -->
  <island>                                      <!-- Dynamic Island -->
    <compact>
      <leading><image symbol="{{ dsx.variable.icon }}" color="accent"/></leading>
      <trailing><text weight="bold">{{ dsx.variable.percent }}%</text></trailing>
    </compact>
    <minimal><gauge value="{{ dsx.variable.progress }}" diameter="18"/></minimal>
    <expanded>
      <leading/> <trailing/> <center/> <bottom/>
    </expanded>
  </island>
</activity>
```

Each slot holds exactly one visual element (wrap multiples in a stack). A bare
layout with no `<activity>` root is treated as the lock screen, so a plain
layout string still works 1:1. Every slot is independently fail-open: a missing
or malformed slot falls back to that region's built-in Swift view, so a partial
document never blanks a region. The default ships as a lintable `.dsx`
(`ActivityKit/Components/DownloadActivity.dsx`), sourced into config verbatim via
the generic `"value": { "file": "…" }` config source.

## Binding the download manager (local-CDN downloads)

The host already emits download lifecycle notifications without knowing who listens
(`.downloadStarted/.downloadProgressed/.downloadEnded` — LiveActivityBridge consumes
them today with a HARDCODED SwiftUI view). The kernelized shape:

- Downloads (FileDownloadManager, VerticalPlayerStack offline downloads, ContentServer
  local-CDN fetches) keep firing `download.*` kernel events with
  `{ id, name, progress, bytes, url }` — facts out, no consumer named.
- The ActivityKit module binds **declaratively from its config**:
  `config.download_activity = { enabled, layout: "Components/DownloadActivity.dsx" }`.
  On `download.started` it starts an Activity whose layout is that DSX component and
  whose state mirrors the event payload; `download.progressed` → `Activity.update`;
  ended → `end`. The per-app pipeline (or web at runtime) can replace the layout —
  white-label live surfaces, no rebuild of logic.
- `DownloadActivityAttributes` generalizes to `StackLiveAttributes`
  (`state: [String: String]`, `layoutKey: String`) — one attributes type renders
  every activity; the layout decides meaning.

## ImageWidget → **Widget**

The Widgets module's extension becomes the generic `Widget` surface moving forward:
same `StackLive` interpreter, timeline entries render the stored layout with
its vars. The image-URL behavior survives as the default when no layout is
set, so the legacy `widget://set` api is unchanged. The
`ImageWidgetExtension` TARGET/bundle-id name is kept until a coordinated signing
migration (profiles are minted per bundle id across the fleet) — rename is a
provisioning event, not a code event; tracked separately.

## Delivery slices

1. `StackLive.swift` (shared component, in Foundation/Components, compiled into both
   extension targets via the modules' manifests) + unit-shaped lint (`lint_dsx`
   covers the layout files already).
2. ActivityKit module: replace the hardcoded `DownloadActivityView` body with
   `StackLive(layout, state)`; add `start/update/end` actions + the config-bound
   download binding; `Components/DownloadActivity.dsx` default layout.
3. Widgets module: timeline renders `StackLive`; `despia.widget.layout` action;
   the image pipeline preserves the legacy contract when no layout is set.
4. Android parity doc row (`Skills/android/api-mapping.md`): same tags → Glance.

Fail-open at every seam: missing/invalid layout → the built-in default view; missing
state vars render empty; an excluded module tears its whole surface out (the build
plane already guarantees that).

## Backend updates (the OneSignalLiveActivity module)

ActivityKit fires `liveactivity.started` / `liveactivity.token` /
`liveactivity.ended` kernel events — facts, no consumer named. The excludable
`Core/OneSignalLiveActivity` glue module claims them and registers the
ActivityKit push token with OneSignal (`OneSignal.LiveActivities.enter/exit`),
so the SERVER pushes ContentState updates to the lock screen via the OneSignal
`live_activities` REST api, addressed by the app's own activity id:

```
POST https://api.onesignal.com/apps/{app_id}/live_activities/{id}/notifications
{ "event": "update",
  "event_updates": { "progress": 0.62, "fileName": "ep12.mp4",
                     "statusLabel": "Downloading…", "vars": { "…": "…" } },
  "name": "la-update" }
```

`event_updates` decodes as `DownloadActivityAttributes.ContentState`; `vars`
feed the DSX layout's `$tokens`. Excluding the module removes exactly ONE
feature — the backend channel — while frontend (`despia.liveactivity.*`) and
download-driven activities keep working. `dependencies: ["OneSignal"]`
force-includes the SDK module whenever the glue ships.
