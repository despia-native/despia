# overlays/ — the snackbar contract

One corpus, three runners. `snackbar.json` encodes the whole platform-neutral law; each
runtime executes it against its own implementation of the same three functions.

| Runner | Implementation | Test | Runs |
|---|---|---|---|
| TS | `OpenSource/Web/packages/kernel/src/snackbar.ts` | `packages/kernel/test/snackbar-conformance.test.ts` | per-PR (`npm test`) |
| Kotlin | `OpenSource/Engine/Android/core/.../SnackbarQueue.kt` | `:core SnackbarConformanceTest` | per-PR (`gradle test`, SDK-free) |
| Swift | `OpenSource/Engine/iOS/SnackbarQueue.swift` | `SnackbarConformance` | record lane |

The presenter half lives in `ClosedSource/DSX/Modules/Core/Toast/{swift,kotlin,web}` — a
window-level card on iOS, a Compose card on the content frame on Android, a live-region
node on web. None of them owns the decision, which is why one corpus can judge all three.

## The design: `show` resolves on OUTCOME

`toast.show` does not resolve when the card appears. It resolves when the card **ends**,
with `{ id, result }` where `result` is one of `dismissed` · `action` · `timeout` ·
`replaced`. That single choice is what makes undo one expression:

```js
if ((await dsx.module.toast.show({ message: "Message deleted", action: { label: "Undo" } })).result === "action") {
  restore()
}
```

Every toast API that fires and forgets makes undo a callback plus a state variable. The
cost of resolving on outcome is that **every card must settle exactly once**: a card that
never settles is a leaked promise, and one that settles twice is a double undo. The corpus
pins both directions.

## What the corpus pins

**Duration.** The words are Material's — `short` 4 s, `long` 10 s. A **number stays
seconds**, because that is the unit `toast.show({ duration })` has shipped since it existed;
redefining it under the same key would halve or double every toast already in the field. An
unrecognized word falls back to the default rather than failing a build, and the default is
the shipped 2 s **except when the caller supplied an action button** — two seconds is not
enough time to notice an Undo and reach it, so `short` takes over there.

**One at a time, FIFO.** Stacking snackbars is how a bottom sheet becomes unreachable. A
second `show` waits its turn. `replace: true` settles the visible card as `replaced` and
takes its place, and it is a **swap, not a reset**: the cards already waiting keep waiting,
because the caller asked to change what is on screen, not to cancel a backlog.

**A swipe is not an API call.** A swipe obeys `dismissible: false` and does nothing.
`hide()` settles the card anyway — the app asked, not the finger. `hide({ id })` naming a
**queued** card drops it from the queue as `dismissed` without disturbing the visible one.

**The lift.** When the keyboard is up it IS the obstruction: it already covers the bottom
bar, the FAB and the safe area, so adding them would push the card into the middle of the
screen. Otherwise the obstruction is the safe area plus the bottom bar plus whatever the FAB
occupies above it. The 16 pt gap goes on top of whichever won. **The invariant is that the
bottom inset is never less than the safe-area inset plus the gap**, so no geometry a
platform reports — including nonsense from a rotation race — can put the card on the home
indicator. `clearsHomeIndicator` reports that rather than assuming it.

Adding a case here is the first step of any change to this behaviour, on any platform.
