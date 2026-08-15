# Adaptive large-screen shells

`<scaffold>` remains a fully custom container unless you opt in. Set `shell="automatic"` to
author one large-screen structure that adapts across iPad, Mac Catalyst, Android tablets,
Compose Desktop on Windows/Linux, and Web:

```xml
<scaffold shell="automatic" collapse="platform" compactAt="760"
          sidebarMin="220" sidebarIdeal="280" sidebarMax="360"
          inspectorMin="240" inspectorIdeal="320" inspectorMax="420">
  <AppHeader pin="top"/>
  <LibrarySidebar pane="sidebar"/>
  <NowPlaying pane="content"/>
  <TrackDetails pane="inspector"/>
  <PlayerControls pin="bottom"/>
</scaffold>
```

`sidebar` and `content` are required; `inspector` is optional. An unpinned child without `pane`
is content for backward-compatible authoring. Pins are partitioned first and remain global while
the shell adapts. Within panes, selection stays owned by authored lists/buttons and keyboard/focus
traversal follows sidebar → content → inspector.

## Shell and collapse policy

- Omitted `shell`, or `shell="custom"`, preserves the authored one-column layout exactly.
- `shell="automatic"` uses a real SwiftUI `NavigationSplitView` on supported Apple hosts. Compose
  and Web render an accessible semantic split; this does not claim WinUI or GTK components.
- `shell="native"` expresses a native preference and uses the same deterministic semantic fallback
  where a real platform split host is unavailable.
- Below `compactAt`, `collapse="platform"` delegates to `NavigationSplitView` on Apple and stacks
  semantic renderers. `stack`, `content`, and `none` explicitly force those policies.

Column triplets are normalized in order (`min ≤ ideal ≤ max`). `sidebarLabel`, `contentLabel`, and
`inspectorLabel` provide pane accessibility names. All attributes support platform suffixes, so an
iPad can use orientation-aware compact behavior while Catalyst keeps a deterministic window
breakpoint:

```xml
<scaffold shell="automatic"
          compactAt:ios="{{ dsx.screen.height }}"
          compactAt:macos="900"
          collapse:web="stack"
          sidebarIdeal:desktop="300">
  …
</scaffold>
```

See `OpenSource/Conformance/examples/adaptive-shell.dsx` for a complete runnable authoring example.
