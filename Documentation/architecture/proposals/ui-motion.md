# The UI MOTION ENGINE

**Status: ACCEPTED v1 — Phase 1 and Phase 2 LANDED.**
Corpus: `OpenSource/Conformance/motion/` (four files, three runners).
Kernel: `OpenSource/Web/packages/kernel/src/motion.ts` ·
`OpenSource/Engine/Android/core/…/despia/engine/Motion.kt` ·
`OpenSource/Engine/iOS/Motion.swift`.

---

## 1. The problem

The native UI layer had a motion **vocabulary** and no motion **engine**.

`enter` · `transition` · `keep` · `anim` · `animDuration` are universal attributes in
`stack-elements.json` — the Studio offers them on **every element on every renderer**.
Three implementations answered them:

| renderer | how `anim="spring"` resolved | default curve duration |
| --- | --- | --- |
| iOS | `SwiftUI .spring(response: 0.4, dampingFraction: 0.8)` | 0.35 s (`.easeInOut`) |
| Android | `Compose spring(dampingRatio, stiffness = (2π/response)²)` | 0.35 s (`tween`) |
| Web | `cubic-bezier(0.34, 1.28, 0.64, 1)` — a lookalike | **0.25 s**, spring **0.4 s** |

There was **no corpus anywhere** for UI motion. `OpenSource/Conformance/` had no motion
directory; the scene layer's `scene/animation.json` is scene-only. So the three renderers
were not provably 1:1 — and in fact were not 1:1: the same `anim="spring"` produced a real
SwiftUI spring, a real Compose spring, and a bezier that merely *looked* springy, over
three different default durations.

There were also **no UI physics primitives** — no fling/decay law, no rubber-band
overscroll, no snap-to-nearest, no interruptible retargeting on UI properties. Per-platform
ad-hoc versions existed (Android `Sheets.kt`, `PickerElements.kt`, `RefreshableElements.kt`,
`Lightbox.kt`; iOS `Stack.swift`) — exactly the divergence the scene corpus exists to
prevent.

The **scene** layer had already solved this shape of problem correctly (`dsx-scene.md` P5:
one platform-neutral `anim.ts`, one corpus, three runners). This proposal gives the UI
layer the same treatment.

## 2. The shape

```
                       OpenSource/Conformance/motion/
                    curves · spring · retarget · physics
                       ▲            ▲            ▲
      TS runner (per-PR)   Kotlin (:core)   Swift (record lane)
                       │            │            │
   packages/kernel/src/motion.ts  Motion.kt   Motion.swift      ← the ONE motion kernel
                       │            │            │
        dom/element-motion.ts  render/StackMotion.kt   Stack.swift StackStyle
              (CSS edge)        (Compose edge)          (SwiftUI edge)
```

Three rules hold the shape:

1. **The kernel owns every number.** The curve table, the defaults, the spring
   conversion, the settle law, the retarget fold and the physics constants live in the
   kernel. A renderer file may only *map* a `MotionSpec` onto its platform's animation
   object. `StackMotion.kt` reads `Motion.CURVES`; `Stack.swift`'s `StackStyle.animation`
   is two lines over `DSXMotion.parse`; `element-motion.ts` has no curve table at all.
2. **One spring, one bezier solver.** `motion.ts` imports `sceneBezier` / `sceneSpring` /
   `springSettleSeconds` from `scene/anim.ts` and re-exports them; `Motion.kt` calls
   `despia.engine.scene`'s; `Motion.swift` calls `SceneAnim`'s. A second spring in this
   codebase would be a bug.
3. **Fixtures first.** Every number in the corpus came from an independent scratch
   derivation of the prose laws, never from a kernel under test.

## 3. The laws

The normative statement of each law is `OpenSource/Conformance/motion/README.md` —
it is the file the three runners are judged against. In brief:

- **Parse.** `anim` ∈ {`spring`, `linear`, `easeIn`, `easeOut`, `easeInOut`}; absent/empty
  is `easeInOut` and is not an error; anything else is `easeInOut` plus **one**
  `malformed-motion` diagnostic (Article 7). `animDuration` is a strictly-positive decimal
  number of seconds on the trimmed string, matching one regex all three runtimes spell the
  same way; anything else is one diagnostic and the default. Curves default to **0.35 s**
  and carry the SwiftUI unit beziers (identical to the CSS timing functions of the same
  names). For `spring`, `animDuration` sets the **response** (default 0.4 s) at damping
  fraction 0.8.
- **Progress.** `motionProgress(spec, elapsedMs)` → 0..1. Curves normalize by duration and
  solve the cubic bezier by exactly 60 bisection iterations (the scene solver, unchanged).
  Springs run on the real clock.
- **The spring conversion — the crux.** SwiftUI's `response`/`dampingFraction` is the
  *authoring* plane (it is what `anim="spring"` has always meant on iOS); the mass-1 damped
  oscillator is the *math* plane. `ωₙ = 2π/response`, `k = ωₙ²`, `c = 2·ζ·ωₙ`. Pinned in
  `spring.json`, and the reason the three renderers can be claimed 1:1 at all.
- **Settle.** A spring owns its clock and completes at
  `T = ln(1000)/(ωₙ·(ζ − √max(0, ζ²−1)))`, clamping to exactly 1 at and after `T`. The
  default spring therefore lasts **549.701699 ms**, not the 400 ms the web used to guess.
- **Retarget.** The CSS-transition interruption model on UI scalars: a new target
  mid-flight starts a fresh clip **from the current rendered value** — never a snap, never
  a queue, no special case for retargeting to the value already being animated toward.
- **Physics (phase 2).** Decay/fling as the continuous `UIScrollView` model
  (`rate = 0.998/ms`, `τ = −1/ln(rate) ≈ 499.499833 ms`, terminal velocity 0.001 pt/ms);
  rubber-band as `f(x) = sign(x)·(1 − 1/(|x|·c/d + 1))·d` with `c = 0.55` plus its exact
  inverse and a critically-damped release spring (response 0.35 s, ζ = 1.0); and snap as
  *project with decay, take the nearest point, ties to the lower*.

## 4. Evidence

| gate | result |
| --- | --- |
| TS — `packages/kernel/test/motion-conformance.test.ts` (wired into `npm run conformance` **and** `npm test`) | 65 cases, green |
| Kotlin — `:core MotionConformanceTest` | 67 dynamic tests, green under `gradle test` |
| Swift — `MotionConformance` in `ConformanceHosts.swift`, registered in `RecordMain.swift` | compile-pending, rides the record lane |
| Web renderer wiring | `attribute-support.test.ts` now asserts the corpus-pinned numbers (0.35 s default, `cubic-bezier(0.42,0,0.58,1)`) and that `anim="spring"` is the **kernel** spring sampled into `linear()` — with the overshoot the old bezier could not carry |
| Kotlin renderer wiring | `StackMotionTest` / `RouterHostTest` still green with every number now sourced from `:core Motion` |

## 5. Platform fidelity — what matches exactly, and what does not

- **iOS / SwiftUI — exact, both planes.** `.timingCurve(x1,y1,x2,y2,duration:)` *is* the
  pinned cubic bezier; `.spring(response:dampingFraction:)` *is* the pinned oscillator,
  because those are the kernel's own authoring parameters.
- **Android / Compose — exact, both planes.** `tween(ms, CubicBezierEasing(…))` and
  `spring(dampingRatio = ζ, stiffness = k)` consume the converted numbers directly.
- **Web / CSS — curves exact, spring approximated by sampling.** CSS has no spring
  primitive. `anim="spring"` used to be a lookalike bezier that could not overshoot
  correctly; it is now a CSS `linear()` easing with **61 stops sampled from the kernel**
  across the settle time. The sampled points are exact; values between two stops are
  linearly interpolated. This is the closest a CSS timing function can come to a real
  spring, and it is named here rather than hidden.
- **Termination is the one honest divergence, on all three.** SwiftUI and Compose each
  decide internally when a spring is "close enough" to stop, so a native clip can end a few
  milliseconds either side of the pinned `T`. The pinned settle time governs the kernel,
  the corpus, and every place the framework itself needs to know how long a spring lasts
  (`keep` teardown, the web clip length); it does not reach inside a platform's own spring
  integrator.

## 6. Named absences

Stated so nobody mistakes silence for coverage:

- **Gesture-driven interactive transitions** — a transition whose progress is driven by a
  finger rather than a clock. Not in this wave; the retarget fold is the seam they attach to.
- **Per-element markup for the physics primitives.** Decay, rubber-band and snap are kernel
  functions the elements call. **No new authoring attribute lands in this wave** — naming
  them in markup (`fling`, `snap-to`, `overscroll`) is the next rung, and it must land
  fixtures-first on all three renderers like any other authoring surface.
- **Reduced-motion × springs.** The accessibility law (collapse a motion to its end state)
  is a surface concern and is not modelled by these fixtures. A spring's settle time is
  known, which is what a future reduced-motion policy will need; the policy itself is not
  written.
- **Per-property transitions on native UI.** The scene layer has
  `transition="position 300ms ease-out"`; the UI layer still has only the whole-element
  `enter`/`transition` vocabulary. The retarget fold is already scalar and ready for it.
- **Most existing per-platform physics call sites are not yet migrated.** Two landed with
  this wave as the proof the folds are callable, not ornamental: Android `SheetMath`
  (`Sheets.kt`) now projects a detent release through `Motion.decayTarget` — its rounded
  local `PROJECTION = 0.499f` becomes the corpus τ, `0.4994998` — and the web
  `<refreshable>` pull (`data-controls.ts`) now compresses finger travel through
  `rubberBand(delta, refreshPullMaximum)` instead of a hard-coded `* 0.55` (the constant
  it hard-coded *is* the rubber-band `c`, so small pulls are unchanged and only long ones
  get honestly stiffer). `PickerElements.kt`, `Lightbox.kt` and their iOS counterparts
  still carry their own feel; each adoption is a behaviour change that deserves its own
  before/after.
- **A bundle cost, measured not hidden.** Routing the web through the shared kernel adds
  **≈1.0 KB gzipped** to any bundle that includes `element-motion.ts` (1367 B → 2392 B for
  that module graph, esbuild minified + gzipped), because the parse, the bezier solver and
  the spring now travel with it. A motion-free embed still pays nothing (the seam is
  unchanged). The `EmbedCard` widget-budget test was already failing on the clean tree and
  still fails; its pins were not touched.
- **`exit`** remains a web divergence recorded in `element-support.json` — it is a frame
  concern (the router owns unmount), untouched here.
