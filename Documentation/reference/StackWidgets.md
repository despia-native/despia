# Stack for widgets, lock-screen widgets & Live Activities

`StackWidgetKit.swift` renders a Stack **XML template + data** into **WidgetKit-safe
SwiftUI** — the snapshot counterpart of the live `dsx.stack.render` app engine.
Same XML grammar, restricted to what WidgetKit / ActivityKit allow.

It composes with the merged **`dsx.container`** (PR #492): the **app writes** the
template + data to the shared App Group and `post()`s; the **extension reads** it on
timeline reload / Activity update and renders. No JS, snapshot model — exactly how
widgets must work.

```
 APP (live)                         App Group (dsx.container)            EXTENSION (snapshot)
 ─────────────                      ────────────────────────            ───────────────────
 dsx.container                      widget.<id>.template  (XML)         StackWidgetView(widgetId:)
   .set("widget.x.template", xml)   widget.<id>.data      (JSON)   →    → StackWidgetView(xml:data:)
   .set("widget.x.data", json)                                          (WidgetKit-safe SwiftUI)
 dsx.container.post()  ────────────────────────────────────────────►   WidgetCenter.reload / Activity.update
```

## 1. The container schema
| key | value |
|---|---|
| `widget.<id>.template` | the XML view string |
| `widget.<id>.data` | a JSON object of the bound values (`StackWidgetData.encode`) |

App side (any module), reusing #492:
```swift
dsx.container.set("widget.now.template", """
  <hstack spacing="12" padding="14">
    <image icon="{{ icon }}" color="accent"/>
    <vstack spacing="1">
      <text bind="title" fontSize="15" fontWeight="semibold"/>
      <text bind="subtitle" fontSize="12" color="secondary"/>
    </vstack>
    <spacer/>
    <text value="{{ progress ? '...' : '' }}"/>
  </hstack>
""")
dsx.container.set("widget.now.data", StackWidgetData.encode([
  "icon": "arrow.down.circle.fill", "title": "Downloading", "subtitle": "blazes.mp4"
]))
dsx.container.post()   // → WidgetBridge.observe (already wired) reloads timelines
```

## 2. Wire it into the **home / lock-screen widget** (`ImageWidget/` target)
`ImageWidget` is a synchronized folder, so:
1. **Add `StackWidgetKit.swift` to the `ImageWidget` target** (copy the file into
   `ImageWidget/`, or add target membership — it has no app-only deps).
2. Point the entry at the container and render:
```swift
struct StackEntry: TimelineEntry { let date: Date; let template: String; let data: [String: Any] }

struct StackWidgetEntryView: View {
    let entry: StackEntry
    var body: some View { StackWidgetView(xml: entry.template, data: entry.data) }
}
// provider reads UserDefaults(suiteName: "group.com.despia.despiaadmin.container")
// keys widget.<id>.template / .data, schedules .after(refresh)
```
Lock-screen = the same view in the **accessory** families
(`.accessoryRectangular/.accessoryInline/.accessoryCircular`) — keep that template
minimal (text + a `gauge`/`capsuleProgress`).

## 3. Wire it into a **Live Activity** (`ActivityKit/` target)
Live Activities need the **attributes shared across the app + extension targets**
(that's why `DownloadActivityAttributes` already lives in both). Mirror that:

```swift
// StackActivityAttributes.swift — add to BOTH the app target AND ActivityKit target
@available(iOS 16.1, *)
struct StackActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable { var data: String }   // JSON of bound values
    var template: String                                          // lock-screen XML
    var island: String?                                           // expanded Dynamic Island XML
}
```
```swift
// StackActivityView.swift — ActivityKit target only
@available(iOS 16.1, *)
struct StackActivityView: View {
    let context: ActivityViewContext<StackActivityAttributes>
    var body: some View {
        StackWidgetView(xml: context.attributes.template,
                      data: StackWidgetData.decode(context.state.data))
    }
}
```
Register it in `ActivityKitBundle.swift` alongside `DownloadActivity`, and add the
Dynamic Island regions (compact/minimal/expanded) — each rendered with
`StackWidgetView` from a slice of the same data. Start/update from the app via the
existing `LiveActivityBridge` pattern (`Activity<StackActivityAttributes>.request` /
`.update`), encoding the data with `StackWidgetData.encode`.

## 4. Widget-safe component subset (v0.1)
Allowed (renders in WidgetKit / ActivityKit): `vstack hstack zstack text image
gauge progress capsuleProgress spacer divider` · bindings `{{ expr }}` / `bind` ·
ternary in expressions · styles `padding background radius fontSize fontWeight
color opacity height` · colors `primary/secondary/accent/white/#hex/rgba()`.

**Not** in widgets (by platform rule, not our choice): `scroll`, `list`, video,
`UIViewRepresentable`, arbitrary animation, tap handlers (use **App Intents** for
iOS-17 interactive widgets — a follow-up).

## 5. Cross-platform
- **Data layer:** already cross-platform — App Group ↔ Android **DataStore** (the
  `dsx.container` Android docs from #492).
- **Home widgets:** same XML → a **Glance** (Compose) renderer mirrors `StackWidgetView`.
- **Live Activities / Dynamic Island:** **iOS-only.** On Android the same "live
  status" XML degrades to an **ongoing notification** (semantic, not pixel parity).

## Honest status / what's left
- ✅ `StackWidgetKit.swift` — the widget-safe renderer (this PR). App-target-safe so it
  can't break the extension builds by merely existing; it's pure SwiftUI.
- ⏭️ **Adding it + the activity/widget views to the `ImageWidget` / `ActivityKit`
  targets** (steps 2–3) is target-membership work that must be done in Xcode/pbxproj
  and **build-tested** — I can't compile-verify it here, and a broken extension
  target breaks the whole app build, so it deserves a careful, log-driven pass.
- ⏭️ App Intents (interactive widgets), the Glance renderer, and the generic
  `LiveActivityBridge` start path.
