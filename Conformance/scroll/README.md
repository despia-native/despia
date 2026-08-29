# scroll/ — the `<scroll>` observation plane and the scroll-linked style substrate

One corpus, three runners. Seven files encode the whole platform-neutral law; each runtime
executes them against its own twin of the same pure core.

| Runner | Implementation | Test | Runs |
|---|---|---|---|
| TS | `OpenSource/Web/packages/kernel/src/scroll.ts` | `packages/kernel/test/scroll-conformance.test.ts` | per-PR (`npm test`) |
| Kotlin | `OpenSource/Engine/Android/core/.../ScrollLinked.kt` | `:core ScrollLinkedConformanceTest` | per-PR (`gradle test`, SDK-free) |
| Swift | `OpenSource/Engine/iOS/ScrollLinked.swift` | `ScrollConformance.swift` | per-PR (`swift_conformance_run_test.rb`) + record lane |

| File | Pins |
|---|---|
| `metrics.json` | offset math, `atTop`/`atBottom` sub-pixel tolerance, progress normalisation, the degenerate cases |
| `events.json` | motion derivation from a sample pair, the coalescing policy, the `reachEnd` latch |
| `imperative.json` | `to` / `toTop` / `toBottom` / `toElement` target resolution, every `align` |
| `snap.json` | snap-point resolution (`page`/`start`/`center`/`end`), `maintainPosition` |
| `linked.json` | the published custom properties, per-axis nested scope, the `var()` / `calc()` / `clamp()` / `min()` / `max()` evaluator |
| `collapse.json` | `<CollapsingHeader>` (U10): fraction, parallax, stretch, title hand-off, reduced motion |
| `config.json` | the attribute table folded to a typed config, defaults and total parsing |

Every case's `_note` carries its own reasoning; what follows is only what the files cannot say
individually.

## The bug this exists for

`<scroll>` accepted `axis` and `direction` and nothing else, so a category of polish was simply
unexpressible: no back-to-top, no shrinking header, no reading progress, no parallax, no
scroll-linked anything. The obvious fix — an `on:scroll` handler on the bus — is the one that
made React Native's reputation: a handler dispatched per frame through a message bus turns every
scroll into a bus flood, and every author who wants a parallax header pays for it.

So the plane splits in two, and the split is the design:

- **`on:scroll` is for LOGIC** — analytics, load triggers, chrome state. It is coalesced to the
  display link, it never dispatches when no handler is bound, and the corpus asserts the count.
- **`--scroll-*` is for STYLE** — anything that moves with the scroll. It is a pure function of
  one sample, so every renderer resolves it inside its own frame callback and nothing crosses
  the bus at all.

That is the answer to Reanimated's `useAnimatedScrollHandler`, and it is simpler rather than
merely equivalent: the author writes CSS, there is no worklet, and there is no second thread
model to understand, because there is no second thread.

## The correction to the U01 plan: two spellings per length

The plan's headline example is not valid CSS:

```
transform: translateY(calc(var(--scroll-y) * 0.5));   /* unitless length: rejected */
opacity: calc(1 - var(--scroll-y) / 280)              /* number minus length: rejected */
```

A custom property cannot be both a `<number>` (so it can be divided into a ratio) and a
`<length>` (so it can be translated by), and no engine, ours or a browser's, accepts either
line. Both spellings are therefore published for both axes:

```
--scroll-y            unitless points        opacity: calc(1 - var(--scroll-y) / 280)
--scroll-y-px         the same value in px   transform: translateY(calc(var(--scroll-y-px) * 0.5))
--scroll-progress     unitless 0..1
--scroll-velocity     unitless points/second, signed
```

and `--scroll-x`, `--scroll-x-px`, `--scroll-progress-x`, `--scroll-velocity-x` for the
horizontal plane. These are the web's own semantics, so the same declaration is native behaviour
in a browser and evaluated by the twin on the two native renderers.

`--scroll-remaining` (and `-px`, and the `-x` twins) is the distance still to travel, measured
from the same clamped offset progress uses. It is the mirror of `--scroll-y`, and it exists
because progress cannot stand in for it: progress is a FRACTION of the content, so one
declaration written against it fades over 40pt on a short list and over 400pt on a long one.

## A named scroller publishes a second, document-wide plane

The cascade serves content that moves WITH the scroll and cannot serve chrome that does not.
Fade edges, a floating back-to-top, a progress rail: each sits OVER a scroller, so it is not a
descendant, so no cascade reaches it, and every way to make it a descendant makes it scroll away
(runtime-pressure R27).

So a scroll node carrying a `ref` publishes its whole plane a second time under that name, at the
document root, where any element reads it:

```
opacity: clamp(0, calc(var(--scroll-feed-remaining, 0) / 24), 1)
```

This is the web's own answer to the same problem — `scroll-timeline` plus `timeline-scope` name a
scroller precisely so something outside its subtree can read it — and it needs no new value
grammar, because the key is an ordinary custom property that `var()` already reads.

Three rules, each with its own cases:

- A `ref` that cannot spell a CSS custom property (a space, a dot) publishes **nothing**. A
  mangled key would be unreachable at best and collide with a second ref at worst.
- A name whose qualified key would spell one of the unqualified keys above does not publish
  THAT key and publishes the rest. `ref="progress"` on a horizontal rail would otherwise become
  the page's own `--scroll-progress-x`: action at a distance from a name chosen for an unrelated
  reason.
- A duplicated ref resolves to its LAST provider, which is the ref registry's law
  (`Conformance/input/ref.json`) rather than a second opinion about it.

## The fold knows four math functions, not one

`calc()` alone cannot express a BOUND, and almost every scroll-linked declaration wants one: a
fade is `0` until the header has moved, then `1`, and a raw ratio runs past both ends. So the
evaluator folds `clamp()`, `min()` and `max()` beside `calc()`, nesting freely in either
direction:

```
opacity: clamp(0, calc(var(--scroll-y) / 80), 1)
transform: translateY(calc(max(0px, calc(var(--scroll-y-px) - 200px)) * -0.4))
```

The rules are CSS's. Every argument of a comparison must carry the **same unit** (a bound
between a length and a ratio means nothing), `clamp()` is **exactly three** arguments folded as
`max(low, min(value, high))` — so an inverted pair resolves to the low bound rather than
dropping the declaration — and a refusal drops the declaration exactly as `calc()`'s do. An
identifier that merely ends in a function name (`admin(`) is left alone.

## Axis planes are independent

A scroll node contributes **only the plane of its own axis**. A horizontal rail inside a
vertical page therefore owns `--scroll-x*` and leaves `--scroll-y*` to the page, which is what
an author expects and what `linked.json` pins. With no scroll ancestor on an axis, that plane's
keys are **absent rather than zero**, so `var(--scroll-y, 0)` can distinguish "no scroller" from
"at the top".

## What is pure and what is not

Everything in this corpus is geometry in, values out. The surface work — observing the scroll
view, driving the display link, writing the resolved values into the render tree, and the `ref`
registry behind `dsx.scroll(name)` — belongs to each renderer's presenter. Keeping the decision
separate from the plumbing is what lets one corpus judge three runtimes, and it is why the Swift
twin imports only Foundation and the Kotlin twin runs in `:core` without an Android SDK.

## Number formatting is part of the contract

Published property values are **strings**, so three languages must format identically or the
corpus cannot compare them. The rule: round half away from zero to four decimals, render with no
exponent, trim trailing zeros and any trailing point, and normalise every zero (including a
negative one) to `0`. Non-finite input formats as `0`, because a `NaN` in a CSS declaration is a
dropped declaration and a silent layout hole.
