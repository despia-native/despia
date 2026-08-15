# Live Activities & widgets — authoring the OS surfaces

The snapshot surfaces — the Lock Screen banner, the Dynamic Island, home-screen
widgets, the watch Smart Stack — render DSX with the same elements as every
other surface, but under OS rules an app screen never has: hard clipping masks,
fixed slot geometry, half-width mirrors, no JSE at render time. This page is
the practice for cards that look deliberate on all of them. The document
anatomy is [dsx-best-practices.md](dsx-best-practices.md) §12 (declaration-only
heads); the shipped reference document is the ActivityKit module's
`Components/DownloadActivity.dsx`, and the four Demo presets
(`Custom/Demo/Components/Live.dsx` — food · ride · coffee · flight) are worked
examples of everything below.

## 1 · One document, every surface — author every slot you ship on

```xml
<activity>
  <lockscreen>…</lockscreen>     <!-- Lock Screen / banner — the baseline card -->
  <small>…</small>               <!-- watch Smart Stack (watchOS 11 mirrors the activity) -->
  <island>
    <compact><leading>…</leading><trailing>…</trailing></compact>
    <minimal>…</minimal>
    <expanded><leading>…</leading><trailing>…</trailing><bottom>…</bottom></expanded>
  </island>
</activity>
```

Every slot **fails open per slot**: a missing island region falls back to the
module's built-in Swift view, a missing `<small>` falls back to the lockscreen
card system-scaled. Fail-open is a safety net, not a design — a partial
document never blanks a region, but the fallback is never as good as a slot
you authored.

## 2 · The watch card is not the phone card — always author `<small>`

The Smart Stack renders at roughly **half the phone card's width**. Omit
`<small>` and the system squeezes your lockscreen layout down — every text
ellipsizes (`DXB` becomes `D…`, `Finding your driver` becomes `Finding yo…`).
If the activity matters on the wrist, author the slot: **one key metric,
single-line texts, tight sizes** — the module's reference shape:

```xml
<small>
  <hstack spacing="8" paddingh="10" paddingv="8">
    <gauge value="{{ dsx.variable.progress }}" diameter="30" line="3" tint="#0A84FF" size="11">{{ dsx.variable.mins }}</gauge>
    <vstack align="leading" spacing="1" grow="width">
      <text weight="semibold" size="12" lines="1">{{ dsx.variable.status }}</text>
      <text size="10" color="secondary" lines="1">Driver ETA in minutes</text>
    </vstack>
  </hstack>
</small>
```

Rules of thumb: `lines="1"` on every text (a wrapped small card is worse than
a truncated detail line); lead with the number the wearer glances for (ETA,
percent, gate); one icon or gauge, never both sides.

## 3 · The island clips — and the renderer covers the bottom for you

The expanded island's `.bottom` region spans the **full island width, under
the corner curves, with no system content margin** — unlike leading/trailing,
which the system places. The renderer therefore applies default insets to a
DSX `<bottom>` slot (8pt horizontal, 4pt bottom), so a full-width
`<progress>` no longer touches the mask and a leading text's first glyph
keeps its stroke. Your own padding stacks on top — roomier, never clipped.
Don't pad leading/trailing to "match"; their placement is the system's.

## 4 · Gauges never need clip compensation

`<gauge>` rings draw **inset by half the stroke width**, so the full stroke
sits inside `diameter` — in slots that hard-clip to bounds (island regions,
widgets, the watch), the ring renders complete on all four sides. Size the
frame (`diameter`), pick the stroke (`line`), and never shrink a gauge to
dodge clipping — that bug class is closed at the renderer.

## 5 · Exactly one widget per OS — the Swift shape laws (module authors)

Markup authors never touch this; anyone hand-writing the extension's Swift
must know three compiler laws — each learned as an archive-only failure
(Swift does not compile locally in this repo):

- **`WidgetBundle.body` accepts no `if/else`.** Its result builder
  (`WidgetBundleBuilder`) has no `buildEither`; the ONLY branch it supports is
  a **lone `if #available`** (no else). An `if/else` dies with *"closure
  containing control flow statement cannot be used with result builder"*.
- **`Widget.body` accepts no branch at all.** It is a plain opaque property —
  no builder — so availability branches fail with *"branches have mismatching
  types"*. Each widget's body stays one branch-free expression.
- **OS-conditional widget sets branch in `static main()`.** The `@main` type
  is a plain struct whose `@MainActor static func main()` picks between
  branch-free `WidgetBundle`s — the shipped pattern is
  `ActivityKit/ActivityKitBundle.swift` (iOS 18+ registers the Smart-Stack
  variant, older OSes the base bundle, exactly one per OS).

## 6 · Data reaches the card as a snapshot, not a program

The head is declaration-only (`expects` the variable names; `event` the
relayed tap names) — snapshot renderers run no JSE, and only the
simple-reference interpolation subset (`{{ dsx.variable.x }}`) resolves.
Values ride the activity's ContentState: `despia.liveactivity.start/update`
vars merge under `dsx.variable.*`, layout precedence is per-call layout →
`despia.liveactivity.layout({…})` default → the module's `config.json`
document. Interactive `<button>`s are compiled interactions: they run only
bus actions the relay table admits (fail-closed) — see
`watch-runtime.md` for the gate.
