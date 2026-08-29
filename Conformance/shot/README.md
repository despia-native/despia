# shot/ - the automated store-screenshot corpus

The two pure halves of `despia shot` (platform/10-screenshot-execution.md), plus a real fixture
project the browser drives end to end.

**Why the pure halves are pinned here rather than tested in place:** the same resolution has to
hold when this reaches a native lane, and a law that lives in one runtime's test file is a law
that runtime owns. Expected values were authored by hand from the ladder and the guard table,
never recorded from an implementation.

| File | Pins |
|---|---|
| `scope.json` | The SIX-TIER LADDER: override > snapshot > route param > sample= > default= > declared initial > FAIL. Two ladders, because the planes have different declaration sites - the global plane has no `sample=` to hang a value on, which is exactly why the project `hydrate` plane exists. Plus `<expects>` as the fifth sample kind, url-template matching (a hole is one path segment or one query value, never a `/` or `&`), and collision detection. |
| `guards.json` | The FOUR guards. `G-unresolved` and `G-unsettled` are the obvious ones. `G-empty` is the "No data found" screenshot - a screen that renders perfectly, throws nothing, and shows an empty list; only a zero-row rule on bound collections catches it. `G-blank` is a slide with no text and no image, which every other guard passes and which uploads to a store as a rectangle of background colour. |
| `fixture/` | A real DSX project: a sampled `<variable>` feeds an `<api>` url bound on it, a page-load action reads the global plane, a `<list>` binds to the api's data - and four negative documents that MUST be refused. |

## The fixture's negative documents

A guard that has never fired is a guard nobody should trust, so the fixture ships failures on
purpose and the suite asserts they produce NO IMAGE:

- `NoSample.dsx` - an `<api>` with no `sample=`. Refused at PLAN time, before a browser starts.
- `EmptyList.dsx` - everything resolves, the api answers with `[]`, the screen renders perfectly
  and says nothing. Refused at RENDER time, because emptiness cannot be predicted statically.
- the same document with `allowEmpty="orderList"` - ALLOWED, resolved through the author's own
  `ref=` name, which is why `allowEmpty` names elements rather than blanketing a shot.
- `Blank.dsx` - a template whose only layer collapses. Refused by `G-blank`.

## Device frame art

`device-ios.png` and `device-android.png` are rendered by `make-device-frame.mjs` with zlib and
nothing else - no image library, nothing vendored, reproducible from the script.

**Why they are rendered rather than drawn in CSS.** A `border-radius` rounded rectangle cannot
be a device, for reasons that are specific rather than aesthetic: it draws a CIRCULAR corner
where every phone shipped this decade uses a squircle, a gradient border has no thickness so the
chassis has no edge, and one box-shadow is a blur rather than a shadow. The generator draws the
object instead - superellipse corners, a chassis lit by its own SURFACE NORMAL against a
top-left key light with an ambient floor, a rail stepping down into a black bezel, side buttons
on the silhouette, 3x supersampled.

Two bugs the pixels caught during that work, both worth knowing before editing it:

- The first version inset the silhouette by shrinking the rect around a MOVING CENTRE, so every
  left and top pixel stayed exactly on the boundary at every depth and the rail never resolved
  there. The frame shipped with a chassis on two sides only, which reads as a lighting choice
  and is a geometry bug. Insets apply to edges and radius, never to the size.
- Lambert shading with no ambient term drove the unlit side to near-black, so the chassis
  vanished on the right and bottom. Real metal in a real room takes bounce.

Regenerate:

```
node make-device-frame.mjs device-ios.png
node make-device-frame.mjs device-android.png --android --radius=88 --bezel=12 --rail=6 --n=4.4
```

Each run prints the four screen-window percentages and the art aspect. Those go into
`ShotFrame`'s attributes, and the art aspect matters: the percentages are measured against the
ART (which carries bezel, rail and button margin), so the box they position in must be the
art's shape or every inset is read against the wrong denominator.

## The decoration layer

Everything a slide carries besides the screen and the headline - a logo, a mascot, a rating
badge, a feature chip, a callout ring over a UI detail - is one row of a JSON array on the
shot. An agent composing a set therefore writes DATA; it never authors markup.

```json
"decor": [
  {"id":1,"kind":"asset","src":"app-logo.png","x":"8%","y":"5%","w":"13%"},
  {"id":2,"kind":"badge","x":"8%","y":"80.5%","icon":"star.fill","label":"4.9","sub":"12,483 ratings"},
  {"id":3,"kind":"chip","x":"57%","y":"82.4%","icon":"bolt.fill","label":"Works offline"},
  {"id":4,"kind":"callout","x":"20.5%","y":"67.6%","w":"61%","h":"4.7%","label":"Live totals, no refresh"}
]
```

`x`/`y`/`w`/`h` are percentages of the slide, so a decoration means the same thing at every
device size. Icons resolve through the kernel's own set (`star.fill`, `bolt.fill`,
`checkmark.circle.fill`, `crown.fill`, `sparkles`, ...), so a badge needs no new asset.

**What it will not draw, which matters more than what it will.** There is no store-award badge.
"Editors' Choice" is a real Google Play award with its own branding and "Top Rated" reads as
one; both stores' metadata policies ban implying an editorial endorsement you do not have, and
it is a trademark problem besides. A badge here carries a claim the customer can substantiate:
their real rating, their real install count, a feature actually in the build, a press quote
actually received. `shot.test.ts` asserts the award vocabulary stays absent, because the
pressure to add it comes from every marketing conversation.

**A callout ring has no fill**, and that is a policy decision as much as a design one:
annotation must never obscure the UI it points at, because a screenshot that hides the thing it
advertises is the misrepresentation the stores actually care about.

Three defects the layer taught, all of them invisible in code and obvious in a pixel:

- A `<list>` was the obvious shape for "render an array" and cannot be used: `.dsx-list > *`
  resolves rows to `position: relative`, so every absolutely-placed decoration collapsed into
  flex flow. Measured `position: relative; top: 0px` on every row against a control pair
  outside a list that placed exactly. Eight fixed slots instead - and eight is the honest
  ceiling anyway, since a slide with more decorations than that is a collage.
- Translucent white-on-glass decorations are legible over a dark gradient and INVISIBLE where
  they cross the phone's white screen. A decoration cannot know what is behind it, so it
  carries its own opaque ground.
- A percentage height needs a definite containing block. The callout ring collapsed to a
  hairline until the slot itself took the declared height.

## The slide system

`DESIGN-NOTES.md` in the fixture records what was read off five professional reference sets and
what the first version of this pipeline was missing. The short version: a slide is a THEME plus
a HEADLINE plus a DEVICE plus DECORATIONS, and all four are data.

| Component | What it is |
|---|---|
| `ShotSlide` | The slide is a rounded CARD inset on a neutral ground, not a full-bleed gradient. This is structural, not decorative: it is what makes a strip read as one designed thing in the gallery rather than five unrelated posters, and every reference set does it. |
| `ShotHeadline` / `ShotHeadlinePart` | The TWO-TONE headline - `parts` is an array so the agent chooses the emphasis, with three treatments per part: ink, accent ink, or a filled highlight box. The most consistent device across every reference, and what makes copy scannable at thumbnail size. |
| `ShotFrame` | The device (see above), cropped by the card rather than centred in it. |
| `ShotDecor` / `ShotDecorItem` | Eight kinds: `asset` · `badge` · `chip` · `callout` · `laurel` · `arrow` · `review` · `panel`. |
| `ShotPro` | The four composed. A theme set once in the shot profile's defaults travels across the whole strip, which is most of what "designed" means when the set is seen at thumbnail size. |

`make-decor-art.mjs` draws the marks CSS cannot: a laurel wreath (two mirrored branches of
leaves whose angle follows the branch tangent) and curved arrows (a swept quadratic with a
solid head). The first laurel swept from 0.52pi to 1.32pi, which is most of a circle starting
at the side, and scattered leaves across the box instead of drawing a wreath; a wreath is two
arcs that start at the BOTTOM and open at the top.

An arrow matters more than it looks. A ring says "look here"; an arrow says "look here, from
over there", and that is what lets an annotation label sit on clean ground instead of on top of
the UI it is annotating.

## The scene law: DSX rules, not a freeform canvas

The composed slide is a DSX document and OBEYS DSX's discipline - three positioning schemes,
one clip boundary, a structural safe area - with the guard set enforcing on the measured
frame what the templates make hard to get wrong in the first place:

- **FLOW is the default.** Headline, sub, feature chips and the device stack the way DSX
  stacks anywhere; each element reserves space, so flow content is INCAPABLE of covering the
  app screen. Percent-positioning everything is what made earlier output read as
  machine-made: it cannot reflow when a headline wraps, so every slide needed hand-tuned
  numbers - and a chip tuned against one layout drifted onto the greeting of the next.
  `ShotPro` takes `chips` (a data array rendered in flow) and a `<slot/>` between the copy
  and the device for arbitrary flow content.
- **ANCHORED decorations name their box.** A decor row with `at: "device"` renders inside
  the device box: its percentages are device-space, it rides the device when the layout
  reflows, and the crop clips it with the phone. Everything else anchors to the card.
- **DECLARED exceptions, refused otherwise.** Covering readable app UI requires
  `over: "screen"` on the row (G-cover); running off the card edge past the safe inset
  requires `bleed: true` (G-safe). An undeclared cover or bleed is a guard failure - a
  report, never an image.
- **ONE CLIP BOUNDARY: the card; ONE SAFE AREA: 1rem.** Nothing clips inside the card, so a
  drop shadow falls off softly instead of being sliced into a hard band by an inner
  `overflow: hidden`. The crop box carries the 1rem safe inset as side padding, so
  `deviceWidth: 100%` is the largest lawful phone - sized against the SAFE width, never
  glued to the card border. Only the shadow paints inside the inset (padding does not clip),
  which is exactly what the inset is for.

The guard reads the frame through LANDMARKS: the templates name their structural boxes with
the universal `id=` attribute (`shot-card`, `shot-device`, `shot-screen`, `shot-crop`,
`shot-veil`, and `shot-decor-<row id>` stamped by each decoration from its own data), and
the report measures where each actually landed. The declarations (`over`, `bleed`) live on
the profile's decor rows - the same rows an agent writes - so the composition and its
licences are one artifact.

## The hero device: crop, dissolve, zoom

- **`deviceCrop` + the DISSOLVE.** The device defaults large (92 to 100 percent of the safe
  width). When `deviceCrop` sets the visible height, the phone runs past that edge and
  dissolves under a TRUE progressive blur - the Apple/Chrome material, not an approximation:
  six stacked backdrop layers whose linear-gradient masks crossfade across eight fenceposts
  of the band, so the ramp starts at literally zero (no layer covers the top eighth) and no
  seam exists anywhere. Each deeper layer's backdrop already contains the shallower layers'
  output, so the radii (0.5 to 16px) COMPOUND smoothly down the band; `mask-image` on a
  `backdrop-filter` element masks the filtered output itself, which is what makes the
  crossfade possible. The first version stepped three discrete bands and every band boundary
  printed a visible seam across the dark rails. The layers and the closing colour gradient
  are PIXEL heights hugging the bottom edge, never percentages of the crop - a percent
  gradient dilutes on a tall crop exactly where the dark rails are darkest. It is the single
  move that most separates a designed slide from a rendered one, and it is honest: the UI
  visibly continues rather than hiding behind a bar. The crop box carries top padding because
  `overflow: hidden` flush against the frame's drop shadow slices the shadow into a hard
  grey band that reads as a compositing bug.
- **The `lean` and the specular.** A device may TURN: `lean` composes the CSS
  `perspective()` transform function, so the frame rotates about its own Y axis with real
  foreshortening - the receding rail narrows and the parallel edges stop being parallel,
  which is what separates a turned object from a skewed picture of one. A decoration row
  may declare the same `lean` and share the camera; a flat card beside a turned phone is
  the exact tell that reads as collage. `shine` rakes one specular sweep across the cover
  glass, clipped to the screen so it reflects on the display rather than hazing the app's
  content, and it flips with the lean direction so two leaning slides light the same way.
  There is no 3D engine and none is needed - perspective is a projection and CSS does
  projections. What is deliberately NOT done is bending the glass: a cylindrical curve
  needs a mesh, and a faked one looks worse than an honest flat plane.
- **The `zoom` decoration** is the one only this pipeline can make honestly: a magnified crop
  of the SAME render the device shows (`region` in percent of the source image; the image is
  scaled so the region fills the card and translated by `-x%/-y%` - translate percentages are
  of the element's own box, which is exactly region's coordinate space). Place the crisp zoom
  over the BLURRED zone and the magnification sells itself: the same row is soft behind it and
  sharp inside it, ringed in accent when `tint` is set. Because the source is the real render,
  the enlarged detail is real UI at real fidelity, never a mock.

Beyond the mechanics, the fixture carries `AUDIT.md`: a self-audit of the strip renders held
against five professional reference sets, defect by defect with root causes. Its laws bind
anyone editing the templates: the showcased app must itself be a designed app (a wireframe
inner screen poisons every slide around it); bigger phone means bigger UI, not a bigger bezel;
decorations overlap the dissolve zone rather than queueing below it; decor is placed against
PROBE-MEASURED boxes, never by eye against a screenshot; and the scene keeps DSX's rules -
the safe inset, the anchor split and the declared exceptions exist because their absence was
a measured defect, not a hypothetical.

## The studio: editing a slide by hand

`ShotStudio.dsx` (with `StudioLayers` and `StudioInspector`) is the visual editor for a shot
profile, and it is a DSX document like everything else here. Three things make it worth having
rather than a JSON file and a rebuild:

- **The canvas IS the renderer.** The middle pane mounts the real `<ShotPro/>` bound to the
  draft, so what you drag is what `despia shot` captures. There is no preview implementation to
  keep in step with a production one, because there is only one implementation. DSX is reactive,
  so a keystroke repaints the slide with no refresh, no serializer and no diff.
- **The document is DATA, so the editor can save losslessly.** A shot profile is JSON - theme,
  headline parts, chips, decor rows - which is exactly why this editor may write where the tree
  editor may not (`edit.ts` explains that asymmetry: an editor that cannot serialize markup
  without dropping head entries must not own the file). There is no markup to serialize back, so
  nothing can be dropped on the way out.
- **The panel IS the schema.** `OpenSource/Documentation/reference/shot-properties.json`
  describes every editable field, typed and constrained, and `check_shot_properties.rb` walks it
  BOTH ways: a field the templates read but the schema omits is invisible in the UI, and a
  control the schema offers but no template reads is worse - it edits nothing while the author
  watches the canvas not move. 58 controls over 9 decoration kinds, and the build fails the day
  they disagree.

Two things the editor learned that are laws rather than details:

- **An editor shows EFFECTIVE values.** A profile is allowed to be sparse - it omits everything
  it is happy to inherit - so a panel bound to the raw draft shows empty boxes for fields that
  are visibly doing something on the canvas. The inspector reads the draft over the schema's
  defaults and WRITES explicit values.
- **A numeric control must restore the unit.** A slider hands back `12`; the document speaks
  `12deg` and `12px`. Writing the bare number renders nothing while the panel insists the value
  is set, so the unit rides the descriptor and the write puts it back.

## Running

```
cd OpenSource/Web
node --test packages/kernel/test/shot-conformance.test.ts   # the two corpora (TS reference)
node --test packages/cli/test/shot.test.ts                  # the fixture, through real Chromium
```

Both run per-PR in the `web-kernel` lane via the package test glob.
