# Conformance: `device`

Device, application, screen, locale and power (`ClosedSource/DSX/Modules/Core/Device`, plan
`ClosedSource/Documentation/v4-launch/parity/F06-device.md`).

| Fixture | Pins |
|---|---|
| `first-launch.json` | the launch fold: `isFirstLaunch` true exactly once per install, `previousVersion` correct across an upgrade, and what gets written back |
| `year-class.json` | the coarse performance bucket from memory and core count |
| `shape.json` | every field of every action: its type, and which renderers may legitimately answer it. The executable form of "absent, never zero" |
| `locale.json` | measurement system, temperature unit, text direction, language against region, and preference-order preservation |
| `power.json` | the battery state and thermal folds, plus the no-polling delivery rule |
| `insets.json` | the safe-area payload, its republish triggers, and the boundary against the keyboard inset |

The first two are **pure folds** and run as written. The other four describe platform reads and
delivery rules, so a runner drives a seam (a fake platform snapshot, a driven callback) and checks
the published result. The three twins were written against all six.

**No runner is wired yet.** Registering one edits `OpenSource/Web/package.json` (the `conformance`
script) plus the Kotlin and Swift record lanes, shared files the F06 workstream was not allowed to
touch in the parallel build. The registration is filed verbatim in that workstream's handoff block.

One correction to the plan is recorded in `insets.json`: a keyboard frame change is a republish
**trigger**, but the keyboard's own height never appears in the four safe-area numbers. What the
keyboard covers is `Core/Basics/Viewport`'s `--keyboard-inset-height`, pinned in
`Conformance/keyboard/`.
