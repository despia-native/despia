# `media` conformance

The corpus behind `Core/Media` (parity/F04-media.md). Three fixtures, one shared pure core.

| Fixture | Pins | Runners |
|---|---|---|
| `manipulate.json` | EXIF orientation normalisation, the op-chain resolver (order, fits, crop clamping, the pixel budget), the decode hint, and the format/quality fold with its per-platform support table | TS `packages/kernel/test/media-conformance.test.ts` · Kotlin `:core MediaConformanceTest` · Swift `Engine/iOS/MediaCore.swift` (the reference implementation) |
| `pick.json` | the pick plan (type, source, `multiple`/`limit` interplay, ordering), the MIME filter, the resolve shape, and cancellation resolving rather than failing | TS + Kotlin + Swift |
| `permissions.json` | the permission posture as law: which action prompts, at what grade, with which API and which usage key on each platform | TS (which additionally cross-checks the shipped `dsx.json`) + Kotlin |

**`permissions.json` is the fixture that matters most.** The default `pick` call uses the
permission-free system picker on every platform, full library access exists only behind
`albums`/`assets` and is asked for lazily on their first call, and `save` uses the weaker
add-only grant. Getting that ladder backwards is the most common App Store privacy rejection
there is, so it is pinned rather than documented, and the fixture also asserts that no action
takes an argument capable of overriding it.

**`manipulate.json` is an ordering law, not a maths quiz.** `[crop, resize]` and
`[resize, crop]` are different pictures and both must be exact on three renderers; EXIF
orientation is normalised *before* the first op so the same crop rect selects the same region
everywhere, which is the fix for the classic sideways-photo bug. Every expected value in the
fixture was computed with an independent scratch implementation rather than read off one of the
three runtimes.

Rasterising is deliberately **not** pinned here. Turning a JPEG into pixels is platform work
(Core Image, `Bitmap`, `OffscreenCanvas`) and belongs in the facets; the arithmetic, the order
and the memory ceiling are what cannot differ.
