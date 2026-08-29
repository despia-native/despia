# Shots - the store-screenshot slide library

The slide system behind `despia shot`, authored in DSX. One implementation renders the marketing
image everywhere it appears: the CLI captures it headlessly for the App Store and Play, the
Studio's **Distribution** board edits it live on a Figma-style canvas, and a project can compose
the components directly.

| Component | What it is |
|---|---|
| `ShotSlide` | The slide is a rounded CARD inset on a neutral ground. Structural, not decorative: it is what makes a strip read as one designed thing in a store gallery rather than five unrelated posters. |
| `ShotPro` | The composed slide: theme, two-tone headline, tagline with a measure, flow chips, the hero device, the decoration layer. The scene keeps DSX's rules - flow by default, decor anchored to a named box, a 1rem safe inset, and covering the app UI only by declaration. |
| `ShotFrame` | The device. Generic by law (no Apple industrial-design cues, no logo); `mockup=` is the seam for a studio's own licensed art. `lean=` turns it with real perspective foreshortening. |
| `ShotHeadline` / `ShotHeadlinePart` | The two-tone headline: ink, accent ink, or a filled highlight box, chosen per part. |
| `ShotChip` | One flow feature pill. Flow content reserves its own space, so a chip is INCAPABLE of landing on the app screen. |
| `ShotDecor` / `ShotDecorItem` | Nine decoration kinds: asset, badge, chip, laurel, arrow, review, panel, callout and the honest `zoom` (a magnified crop of the same render the device shows). |
| `ShotHero` · `ShotAngled` · `ShotBleed` · `ShotFeature` · `ShotMockup` · `ShotShowcase` · `StoreCard` | Poster templates over the same frame. |

The editable surface of every component is described by
`OpenSource/Documentation/reference/shot-properties.json`, and
`ClosedSource/scripts/check_shot_properties.rb` fails the build when the schema and these
templates disagree in either direction - so the Studio's inspector can never offer a control
that edits nothing, and never omit a field these templates read.

The laws, the guard set and the defect ledger live with the corpus:
`OpenSource/Conformance/shot/`.
