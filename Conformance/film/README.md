# film - the marketing-film corpus

The film timeline's laws executed as fixtures (12-marketing-video.md, the marketing
compiler): scene selection at boundaries, camera hold-then-move composition, single-frame
tap attribution, the contiguity/duration validation, and the guard refusals (G-static,
G-overrun and the rest of the film four).

| File | Pins | Runners |
|---|---|---|
| `timeline.json` | the pure timeline (`packages/kernel/src/film.ts`): scenes, camera, the POSE track (six axes, hold-then-move), the idle float (pinned at exact quarter-periods), taps, the CUT law (the incoming scene owns both edges of its boundary), STATE WRITES (a set is single-frame like a tap; a tween emits its exact end value exactly once), the SPOTLIGHT envelope (`focus`, the caption envelope on a measured component), the HERO MORPH progress law, and every guard refusal | TS `packages/kernel/test/film.test.ts` |
| `fixture/` | the KetoLock demo project the DRIVER gates run against: the reader, the WebM muxer, and the Phase 0 determinism gates (two renders, identical frame hashes - the device path AND the frameless/state-write/hard-cut path) | TS `packages/cli/test/film.test.ts` |

Interpolation pins use LINEAR easing so every expected number is exact hand arithmetic;
eased moves are pinned only at their endpoints, because the curve between them is
`Conformance/motion`'s law and a second set of bezier expectations here would be a second
opinion about it. Kotlin and Swift twins follow when the film node reaches those renderers;
the grammar is corpus-first for exactly that reason.
