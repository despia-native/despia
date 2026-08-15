# motion/ — the UI MOTION numeric corpus

The **native UI layer's** motion engine executed as fixtures
(`architecture/proposals/ui-motion.md`). The UI layer has had a motion
*vocabulary* — `enter` · `transition` · `keep` · `anim` · `animDuration`, universal
attributes on every element on every renderer — since the first Studio catalog, but
until this corpus it had no motion *engine*: iOS resolved `anim="spring"` through
SwiftUI, Android through Compose, and the web through a hand-picked
`cubic-bezier(0.34, 1.28, 0.64, 1)` approximation, with **nothing** holding the three
to the same curve. Three renderers, three genuinely different springs.

This corpus is the fix, and it is the same treatment the SCENE layer already got
(`scene/animation.json`): the curve grammar, the spring, the settle law, the
interruption law and the UI physics primitives are **platform-neutral pinned math**,
and the three renderers derive their native animation objects from it instead of
each re-deriving the feel.

> **One spring, one bezier solver.** `motion.ts` does not implement its own — it
> imports `sceneBezier` / `sceneSpring` / `springSettleSeconds` from `scene/anim.ts`
> and re-exports them. The Kotlin twin (`core/…/Motion.kt`) calls
> `despia.engine.scene`'s functions; the Swift twin (`Engine/iOS/Motion.swift`)
> calls `SceneAnim`'s. A second spring in this codebase would be a bug.

## The four files

- **`curves.json`** — the `anim=` / `animDuration=` PARSE grammar (every default,
  every Article-7 fallback with its diagnostic), the two motion PRESETS the
  renderers apply when the author sets no `anim=`, and `motionProgress` sampled at
  pinned elapsed times for each curve.
- **`spring.json`** — **the crux of the 1:1 claim**: the SwiftUI
  `response`/`dampingFraction` → `stiffness`/`damping` conversion, the spring's
  progress samples (including the legitimate overshoot past 1), and the settle time.
- **`retarget.json`** — the interruption law as a fold: a mid-flight target change
  produces pinned values, never a snap and never a queue.
- **`physics.json`** — the three UI PHYSICS primitives: decay/fling, rubber-band
  overscroll, and snap projection.

All floats are stored to 6 decimals; runners compare with tolerance **1.5e-6**.
Every expected number was computed by an **independent scratch derivation** from the
prose laws below, never by a kernel under test (the `api-blocks` template).

## The laws

### The parse law (`curves.json`)

- `anim` is one of **`spring` · `linear` · `easeIn` · `easeOut` · `easeInOut`**.
  Absent or empty is `easeInOut` and is **not** an error. Any other word falls back
  to `easeInOut` with exactly **one `malformed-motion` diagnostic** — failure is a
  value, the element still animates (Article 7).
- `animDuration` is a plain decimal number of **seconds** matching
  `/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/` on the **trimmed** string and
  strictly `> 0`. Absent/empty is the default and is not an error; anything else
  (non-numeric, `0`, negative) is one `malformed-motion` diagnostic **and** the
  default. Both words can be malformed at once — two diagnostics.
- The four **curves** default to **0.35 s** (SwiftUI's default curve duration) and
  their control points are the SwiftUI unit beziers, which are identical to the CSS
  timing functions of the same names: `easeIn` (0.42, 0, 1, 1) · `easeOut`
  (0, 0, 0.58, 1) · `easeInOut` (0.42, 0, 0.58, 1) · `linear` (0, 0, 1, 1).
- For **spring**, `animDuration` sets the **response** (default **0.4 s**) at
  damping fraction **0.8**, and the spec's `durationMs` is not authored at all — it
  is the **settle time** (below).
- The `presets` block pins the two motion defaults a renderer applies when the
  author sets no `anim=` on a built-in behaviour: **`keep`** (`keep="true"` hide/show
  fade — 0.18 s easeOut) and **`press`** (the button press-scale snap — 0.12 s
  easeOut). A renderer must not invent a third.

### The progress law (`curves.json`, `spring.json`)

`motionProgress(spec, elapsedMs)` → the 0..1 parameter every animated property is a
linear function of.

- A **curve** normalizes `u = clamp(elapsed / duration, 0, 1)`, returns `u` for
  `linear`, else the cubic bezier `((0,0) P1 P2 (1,1))` solved for `y` at `x = u` by
  **exactly 60 bisection iterations** on `s ∈ [0, 1]` — deterministic on every
  IEEE-double runtime. This is `sceneBezier`, unchanged.
- A **spring** runs on the REAL clock, ignores any notion of a normalized parameter,
  and clamps to exactly `1` at and after its settle time.

### The spring conversion (`spring.json`) — the crux

The **authoring** plane is SwiftUI's `.spring(response:dampingFraction:)`, because
that is what `anim="spring"` has meant on iOS since the vocabulary existed. The
**math** plane is the mass-1 damped oscillator the scene kernel already pins. The
conversion is:

```
ωₙ = 2π / response
stiffness k = ωₙ²
damping   c = 2 · dampingFraction · ωₙ          (so ζ = c / (2√k) = dampingFraction)
```

The value law is then the analytic mass-1 damped spring from 0 to 1 (initial
position 0, initial velocity 0) at real elapsed seconds — `sceneSpring`. The
**settle law**: a spring owns its clock and completes at

```
T = ln(1000) / (ωₙ · (ζ − √max(0, ζ² − 1)))
```

the time its envelope decays to 0.1%; progress clamps to exactly 1 at and after `T`
so ending never snaps. `motionSettleMs(spec)` returns `T · 1000` for a spring and
the authored duration for a curve. The default spring (0.4 / 0.8) therefore settles
at **549.701699 ms**, and underdamped springs legitimately **overshoot past 1**
before settling — the bouncy case pins that.

### The retarget law (`retarget.json`)

The CSS-transition model, the same one the scene kernel implements: an in-flight
value whose target changes **glides on from its current rendered value** toward the
new target over a fresh clip. Never snap to the new target, never queue the new clip
behind the old one, and no special case for retargeting to the value already being
animated toward.

The fold each runner executes: `state = {from, to, startMs}`;
`value(t) = from + (to − from) · motionProgress(spec, t − startMs)`, and `done` once
`t − startMs ≥ clip` (the authored duration for a curve, the settle time for a
spring), where `value(t) = to` exactly. A retarget event at time `at` replaces the
state with `{from: value(at), to: event.to, startMs: at}`. Events apply in `at`
order and a sample at exactly `at` is taken **after** the event — the retarget
instant belongs to the new clip, and the value is continuous either way, which is
the whole point.

### The physics laws (`physics.json`)

Offsets and dimensions are in **points**, velocities in **points per millisecond**.

- **Decay / fling** — the `UIScrollView` deceleration model in its continuous form.
  With the deceleration rate `d = 0.998` per millisecond
  (`UIScrollView.DecelerationRate.normal`) the time constant is
  `τ = −1 / ln(d) ≈ 499.499833 ms`:

  ```
  x(t)     = x0 + v0·τ·(1 − e^(−t/τ))
  resting  = x0 + v0·τ                      (the t → ∞ limit)
  duration = τ · ln(|v0| / 0.001)           terminal threshold 0.001 pt/ms (1 pt/s)
  ```

  A fling released at or under the threshold **does not move at all**
  (`x(t) = x0`, `target = x0`) and lasts 0 ms — never a negative duration.

- **Rubber-band** — the standard iOS overscroll compression

  ```
  f(x) = sign(x) · (1 − 1 / (|x|·c/d + 1)) · d          c = 0.55
  ```

  where `d` is the dimension being overscrolled. It is asymptotic: no amount of
  finger travel moves the content more than `d` past the edge.
  `rubberBandInverse` is its exact inverse
  (`x = (d/c)·(1/(1 − |y|/d) − 1)`, `|y|` clamped just inside `d`) so a gesture can
  resume from a compressed offset — each case's `inverse` is the **round trip**
  `rubberBandInverse(rubberBand(x, d), d)` fed the runner's own unrounded `y`, and
  must return `x`. A zero or negative dimension yields `0` on both.
  The **release** spring is the pinned constant `RUBBER_BAND_RELEASE` =
  `spring(response 0.35 s, dampingFraction 1.0)` — **critically damped**, because an
  overscroll snapping back must never bounce past the edge it is returning to.

- **Snap** — project the release with the decay fold, then take the **nearest** snap
  point to that projection; an exact tie takes the **lower** point (deterministic on
  all three runtimes). This is the one law behind sheet detents, pagers and pickers.

## Platform fidelity — what matches exactly, and what does not

| runtime | curves | spring |
| --- | --- | --- |
| **iOS / SwiftUI** | exact — `.timingCurve(x1,y1,x2,y2,duration:)` **is** the pinned cubic bezier | exact — `.spring(response:dampingFraction:)` **is** this oscillator; the pinned numbers are its own parameters |
| **Android / Compose** | exact — `tween(ms, CubicBezierEasing(x1,y1,x2,y2))` | exact oscillator — `spring(dampingRatio = ζ, stiffness = k)` is the same mass-1 system, fed the converted numbers |
| **Web / CSS** | exact — `cubic-bezier(x1,y1,x2,y2)` | **approximated by sampling**: CSS has no spring, so the renderer emits a `linear()` easing with 61 stops sampled from *this* kernel across the settle time. The sampled points are exact; values between them are linearly interpolated |

Two honest divergences, both about *termination* rather than the curve: SwiftUI and
Compose each decide internally when a spring is "close enough" to stop, so their
clips can end a few milliseconds either side of the pinned `T`. The pinned settle
time governs the kernel, the corpus, and every place the framework needs to know how
long a spring lasts (`keep` teardown, the web clip length); it does not reach inside
a platform's own spring integrator.

## The runner ledger

| runner | file | when |
| --- | --- | --- |
| **TS** (reference) | `OpenSource/Web/packages/kernel/test/motion-conformance.test.ts` | per-PR (`npm run conformance`, `npm test`) |
| **Kotlin** | `OpenSource/Engine/Android/core/src/test/kotlin/despia/engine/MotionConformanceTest.kt` | `gradle test` (`:core`, SDK-free) |
| **Swift** | `OpenSource/Engine/iOS/ConformanceHosts.swift` → `MotionConformance` | the record lane (`RecordMain.swift`) |

## Named absences

Pinned here so nobody mistakes silence for coverage:

- **Gesture-driven interactive transitions** (a transition whose progress is driven
  by a finger rather than a clock) are not in this wave. The retarget fold is the
  seam they will attach to.
- **Per-element markup for the physics primitives** — the decay/rubber-band/snap
  folds are kernel functions the elements call; no new authoring attribute lands
  in this wave.
- **Reduced-motion** interaction with springs: the accessibility law (collapse a
  motion to its end state) is a surface concern and is not modelled by these
  fixtures.
- **Per-property transitions on native UI** (`transition="opacity 300ms"` on a
  `<stack>`, the scene layer's implicit-transition grammar) — the UI layer still
  has only the whole-element `enter`/`transition` vocabulary.
