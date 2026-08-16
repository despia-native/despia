# keyboard/ — the soft-keyboard viewport contract

One corpus, three runners. `viewport.json` encodes the whole platform-neutral law; each
runtime executes it against its own implementation of the same function.

| Runner | Implementation | Test | Runs |
|---|---|---|---|
| TS | `OpenSource/Web/packages/kernel/src/keyboard.ts` | `packages/kernel/test/keyboard.test.ts` | per-PR (`npm test`) |
| Kotlin | `OpenSource/Engine/Android/core/.../KeyboardViewport.kt` | `:core KeyboardViewportConformanceTest` | per-PR (`gradle test`, SDK-free) |
| Swift | `OpenSource/Engine/iOS/KeyboardViewport.swift` | `KeyboardViewportConformance` | record lane |

## The bug this exists for

When the soft keyboard opens, the **layout viewport does not shrink**. The page keeps its
full height while a keyboard covers the bottom of it, so anything anchored to the viewport
bottom — a chat composer, a footer, a sticky CTA — ends up underneath the keyboard. The
platform then autoscrolls the document to reveal the focused field, which leaves a blank
band where the keyboard is not, and the page appears to drift.

Suppressing autoscroll treats the symptom. The cause is the **scroll slack** autoscroll
operates on, and `resize` removes it: with no slack there is nothing to scroll, so there is
nothing to suppress. That is why `preventdefault://autoscroll` is accepted but inert outside
`legacy` — it is asking to stop something that can no longer happen.

## What the corpus pins

**Mode resolution.** `legacy` is the default and the fallback for any unrecognized word — a
typo in a dashboard field must not fail a build. Words are trimmed and lowercased.

**The inset is what the keyboard still obscures OF THE LAYOUT VIEWPORT**, which is the one
rule that makes a page portable across modes. In `resize` it is `0` even while the keyboard
is up, because the viewport already shrank; publishing the raw keyboard height there would
double-count and push content off screen. `overlaysContent` is that same fact as a boolean.

**`boundingRect` is the keyboard's real geometry** in every mode, clamped to the viewport —
it answers "where is the keyboard", not "what should I do about it". That is why it is
non-empty in `resize` while the inset is `0`: the two answer different questions.

**The declared word is a default, not a ceiling.** A page selects between the two live states at
runtime by assigning `navigator.virtualKeyboard.overlaysContent` — the setter the Chromium
VirtualKeyboard API already defines, so one line of JavaScript picks the behavior on every
platform. That assignment (`requested` in a case) outranks `declared` for the rest of the session.
`legacy` is unreachable from the runtime plane on purpose: it is the frozen build default, not a
state a page can ask to return to.

**`overlaysContent` is a read-back contract, not an echo.** Capability gating applies to whichever
plane won, so a request the platform refuses degrades exactly as a declared word does, and the
page is told what is IN FORCE rather than being left believing it got what it asked for.

**Degradation is reported, not silent.** `resize` and `overlay` need reliable IME geometry,
which Android only has from API 30 (`WindowInsets.Type.ime`). Below that the mode degrades
to `legacy` and `degraded` is `true`, so a build that quietly behaves differently on old
devices can be diagnosed instead of guessed at. Declaring `legacy` on API 29 is not
degradation — it got what it asked for.

## The web-facing API is available in ALL THREE modes

`--keyboard-inset-height` and `navigator.virtualKeyboard` are published regardless of mode,
and both are purely additive. A page can therefore be written once against them and behave
correctly whichever mode the build ships — which is the point of publishing them in `legacy`
too, where they change nothing on their own.

Adding a case here is the first step of any change to this behavior, on any platform.
