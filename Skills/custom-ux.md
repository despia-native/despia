# Custom UX: the escape hatches

> Audience: app authors building bespoke controls. The built-in elements cover the common
> cases; when you need something the system doesn't give you — a TikTok scrubber, a
> swipe-to-dismiss card, a press-and-hold mic, a rotary knob, a drag-to-reorder handle —
> you **compose it from primitives**, entirely in markup. No native code.

The model is HTML/CSS/JS, ported. **Any element is a "div"** (`zstack` / `vstack` /
`hstack`): every element takes **gestures** (the events), **bindable transforms** (the CSS),
and **JSE** supplies the logic between. Together they are *computationally complete for
interaction* — anything a system control does visually, you can rebuild and restyle.

```
gesture  ──writes──▶  dsx.variable state  ──read by──▶  transform / size / visibility
   ▲                                                        │
   └──────────────────  the user sees & touches  ◀──────────┘
```

A custom control is just that loop: **state + a gesture that writes it + a transform that
reads it.** Everything below is the reference for each leg.

---

## 1 · Gestures — the pointer lifecycle (any element)

| Attribute | Fires | Notes |
|---|---|---|
| `on:tap` | tap | On buttons/`pressable`/`row` it's the press; on any other element a tap gesture. |
| `on:longpress` | long press (0.4 s) | |
| `on:dragStart` | **finger down** (grab / press) | First touch — before any movement. |
| `on:drag` | **finger moves** — continuous | Fires for every movement sample. |
| `on:dragEnd` | **finger up** (release) | Always fires, even for a no-move tap. |

`minimumDistance` is **0**: a plain tap fires `dragStart` → `dragEnd`, so tap-to-seek and
press/release pairs work with no extra wiring. (Need `tap` + `doubleTap` + `longpress`
*together* on one element? Use `<pressable>` — it composes all three, and `on:tap` fires
**instantly**, also on each tap of a double — make it a toggle. See the gesture contract
in [StackReference → pressable](../Documentation/reference/StackReference.md).)

### The drag payload — `dsx.this` in the handler

Every drag handler runs with `dsx.this` set to:

| Field | Type | Meaning |
|---|---|---|
| `fraction` | 0–1 | `x / width`, **clamped** — the slider/scrubber value, ready to assign |
| `fractionY` | 0–1 | `y / height`, clamped — vertical sliders / knobs |
| `x` · `y` | pt | The touch point, **local** to the element (top-leading origin) |
| `width` · `height` | pt | The element's size (so you can do your own math) |
| `dx` · `dy` | pt | Translation since `dragStart` — the swipe distance (signed) |
| `phase` | string | `"start"` · `"move"` · `"end"` |

```xml
<zstack on:drag="dsx.variable.pos = dsx.this.fraction"/>          <!-- a slider in one line -->
<vstack on:drag="dsx.variable.cardX = dsx.this.dx"/>              <!-- a swipeable in one line -->
```

## 2 · `measure` — element size → state (any element)

```xml
<zstack measure="dsx.variable.bar" …>
```

Writes the element's **live** `{ width, height }` to the state path — re-written whenever
the size changes (rotation, split view), so layouts derived from it stay correct. Read it
anywhere: `{{ dsx.variable.bar.width }}`. This is how a custom fill/thumb sizes against the
real track:

```xml
<vstack width="{{ dsx.variable.pos * dsx.variable.bar.width }}"/>
```

## 3 · Bindable transforms — the "CSS" (any element)

These style attributes interpolate `{{ }}`, so gesture state drives them directly,
re-rendering reactively:

| Attribute | Effect |
|---|---|
| `offsetX` / `offsetY` / `offset` | translate (pt) |
| `scale` | scale factor |
| `rotation` | degrees |
| `opacity` | 0–1 |
| `width` / `height` | explicit size (pt) |
| `visible-if` / `keep` | show/hide (remove vs fade-in-place) |
| `anim` / `animDuration` | animate the change (`animate: x = …` for one-shot tweens) |

---

## Recipes

### Custom seek bar / slider (the player's scrubber — `PlayerScrubber.dsx`)
Drag (or tap) sets the value; the fill + thumb size off `measure`; every pixel is yours:

```xml
<zstack grow="width" height="22" align="leading" measure="dsx.variable.bar"
        on:drag="dsx.variable.pos = dsx.this.fraction">
  <vstack grow="width" height="4" radius="2" background="rgba(255,255,255,0.28)"/>   <!-- track -->
  <vstack width="{{ max(4, dsx.variable.pos * (dsx.variable.bar.width || 1)) }}"
          height="4" radius="2" background="white"/>                                  <!-- fill -->
  <vstack width="14" height="14" radius="7" background="white" shadow="3"
          offsetX="{{ (dsx.variable.pos * (dsx.variable.bar.width || 1)) - 7 }}"/>          <!-- thumb -->
</zstack>
```
The `<video bind="dsx.variable.pos">` shares the key — **drag = seek**, playback moves the fill.
Want a taller hit area? Raise `height`. Buffered-range bar? Add another fill bound to a
`buffered` fraction. Chapter ticks? A few absolutely-offset 2pt vstacks.

### Swipe-to-dismiss card
Drag moves it; release decides (threshold), with state driving offset *and* opacity:

```xml
<vstack offsetX="{{ dsx.variable.cardX }}" opacity="{{ 1 - abs(dsx.variable.cardX) / 400 }}"
        on:drag="dsx.variable.cardX = dsx.this.dx"
        on:dragEnd="if (abs(dsx.this.dx) > 120) { dsx.event('dismiss') } else { dsx.variable.cardX = 0 }">
  …card…
</vstack>
```

### Press-and-hold (mic, speed boost)
`dragStart`/`dragEnd` are press/release; a transform reacts while held:

```xml
<vstack scale="{{ dsx.variable.held ? 1.15 : 1 }}" anim="spring"
        on:dragStart="dsx.variable.held = true; dsx.event('recordStart')"
        on:dragEnd="dsx.variable.held = false; dsx.event('recordStop')">
  <image icon="mic.fill" iconSize="28" color="white"/>
</vstack>
```
(The vertical player's "hold for 2× speed" is this exact pattern with
`dsx.variable.speed = 2` / `= 1`.)

### Rotary knob / vertical fader
```xml
<image icon="dial.medium" iconSize="64" rotation="{{ dsx.variable.gain * 270 - 135 }}"
       on:drag="dsx.variable.gain = 1 - dsx.this.fractionY"/>
```

### Pull strength / elastic header
`dy` is signed translation — resist it with math:

```xml
<vstack offsetY="{{ max(0, dsx.variable.pull / 2.5) }}"
        on:drag="dsx.variable.pull = dsx.this.dy"
        on:dragEnd="if (dsx.variable.pull > 180) { dsx.action.refresh() }; animate: dsx.variable.pull = 0">
```

---

## Gotchas

- **Centering:** `vstack` cross-axis alignment defaults to **`leading`** (CSS block-flow
  model — *not* SwiftUI's center). A narrow child lands left. Centered sections must say
  `align="center"`; `<list>` accepts `align` too.
- **`measure` before first layout:** on the very first render the measured size may be a
  frame behind — guard divisions: `(dsx.variable.bar.width || 1)`.
- **Drag vs scroll:** a drag surface inside a scrolling container (a vertical `<pager>`)
  competes for the gesture — keep drag surfaces (scrubber, knob) on chrome layers, not
  inside the scrolling page, or the scroll will win intermittently.
- **Don't fight `bind`:** if a built-in two-way control already fits (`<slider>`,
  `<toggle>`), prefer it — the escape hatches are for when the *look or behavior* must be
  yours.
- **Android:** the same contract ships on the Compose renderer (pointer lifecycle, payload
  fields, `measure`) — same `.dsx`, native gesture handling per platform.

## Why this is "complete"

A system control is state + gesture + drawing. DSX gives you all three declaratively —
gestures write state (`on:drag*`), JSE computes (`if` / loops / math / `dsx.module.*`),
transforms and sizes read state reactively. So interaction design never needs to escape
*into* native; the native layer is for genuine system capabilities (camera, StoreKit, real
video decode) — not for shapes that move.
