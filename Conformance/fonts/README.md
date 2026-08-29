# fonts/ — the font face-selection corpus

The typography law executed as fixtures (`parity/F01-fonts.md`): given a family's declared
faces and a requested weight/slant, **which face renders** — plus variable-axis clamping and
the two style-string parsers.

This corpus exists because font selection is the one place where "close enough" is invisible
until a customer sees it. A heading that comes out semibold on iOS and bold on Android is not a
crash, not a log line, and not something a single-platform screenshot diff catches. Same file,
three runners, no drift.

`matching.json` carries the law in its `_note` and five sections (47 cases):

| Section | Pins |
|---|---|
| `matching` | The CSS Fonts 4 weight algorithm, deliberately NOT "nearest weight": in the 400-500 band the search goes UP to 500 first, which is why a family shipping 400 and 700 renders **400** for a requested 500 and **700** for a requested 501. |
| `italic` | An exact italic face always wins; the weight search runs WITHIN a slant set, not across it; italic with no italic face SYNTHESISES (and the build warns); upright with only italic available uses the italic face, because a rendered wrong slant beats no text. |
| `variation` | Axis clamping to the declared range, undeclared axes dropped, a static family ignoring every axis without erroring. Both reports are sorted, so they are deterministic. |
| `parse` | The `fontVariation` string grammar: case-sensitive tags, fractional and negative values, one malformed pair dropped without discarding the rest. |
| `features` | The `fontFeature` string grammar: four-character tags only, duplicates collapsed with first position winning. |

Runners — three implementations, all three execute this file:

- **TS** — `node --test OpenSource/Web/packages/kernel/test/fonts-conformance.test.ts`
  (per-PR, `npm test`), driving `packages/kernel/src/fonts.ts`.
- **Kotlin** — `:core FontsConformanceTest` under `gradle test`, driving
  `OpenSource/Engine/Android/core/.../StackFonts.kt`.
- **Swift** — the record lane. `OpenSource/Engine/iOS/StackFonts.swift` is the implementation
  and `FontsConformance.verify(corpusFile:)`
  (`OpenSource/Engine/iOS/FontsConformance.swift`) drives every case through it.

**What is NOT in this corpus, on purpose.** The PostScript-name indirection is a BUILD fact,
not a runtime one: `prepare_modules.rb` reads each face's name out of the font's own `name`
table and writes it into the registry, and that extraction is pinned by
`ClosedSource/scripts/font_registry_test.rb` against synthesized sfnt/WOFF bytes rather than by
a checked-in binary nobody can licence. Likewise the unknown-family refusal is a build error,
pinned there.

Every cross-runtime divergence bug becomes a fixture here in the same commit as its fix.
