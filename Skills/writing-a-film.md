# Writing a film in DSX

A marketing film is a `.dsx` document. The same move `<server>` and `<cli>` made: the
composition is typed, linted, Git-diffable, and the same file the Studio, the CLI and an
MCP agent all edit. It renders your REAL application - the documents mount, the state
plane fills, taps dispatch, and the app renders its own state - so the advertisement can
never drift from the product.

The corpus is `OpenSource/Conformance/film/` (the timeline laws, pinned) and the kernel is
`OpenSource/Web/packages/kernel/src/film.ts` (the pure frame function). This is the recipe.

## The shortest complete film

```dsx
<film id="hello" duration="4s" fps="30" size="1080x1920">
  <theme bg="#0b0d12" ink="#f4f6fb" accent="#34d399" scheme="dark"/>

  <scene for="1.4s">
    <text role="hook" accent="seconds.">Your day, in seconds.</text>
  </scene>

  <scene for="2.6s" document="Dashboard" device="74%" cut="hard">
    <pose at="0s" for="0s" turn="-24deg" scale="0.9"/>
    <pose at="0.05s" for="1.2s" turn="-6deg" scale="1" ease="easeOut"/>
    <caption at="0.4s" for="1.8s">Everything on one screen</caption>
  </scene>
</film>
```

Then:

```bash
despia film check  marketing/hello/composition.dsx    # refusals, before any browser work
despia film render marketing/hello/composition.dsx    # webm preview, zero install
despia film render marketing/hello/composition.dsx --master   # H.264 mp4 (needs ffmpeg)
```

`--out DIR` chooses where the file lands. `DSX_FILM_DUMP=DIR` dumps every frame as a PNG,
which is how a composition question gets answered: look at frame 140, do not scrub a video.

## The shape

```
<film id= duration= fps= size=>
  <theme bg= ink= accent= [font=] [scheme=]/>
  <state name=> <value var=|global=>json-or-text</value> </state>
  <scene for= [document=] [state=] [device=|width=] [frame=] [cut=] [float=] [glow=]>
    <text role="hook|benefit|title|cta" [accent=]/>   the type card
    <caption at= for=/>                               the lower third
    <camera at= for= [target=] [zoom=] [ease=]/>      the move
    <pose at= for= [turn= tilt= roll= x= y= scale=] [ease=]/>
    <tap at= target=/>                                a REAL click into the app
    <set at= var= to=/>                               one write
    <tween at= for= var= from= to= [ease=] [round=]/> an animated write
    <apply at= state=/>                               a whole named state
    <focus at= for= target=/>                         the spotlight
    <morph target= for= [ease=]/>                     the hero transition INTO this scene
    <frame document= [state=] [width=] [x=] [y=] [depth=]/>   a supporting device
  </scene>
</film>
```

Scene `at` is DERIVED. Scenes are contiguous by law, so you write only `for=`, and
reordering scenes is moving lines rather than re-timing a film.

## The laws worth knowing before you write

**The grammar is closed.** An unknown attribute is a refusal, naming the line. A film that
renders is a film every renderer agrees about, and an attribute silently ignored is how two
renders of one document stop agreeing.

**Every duration carries a unit.** `2.5s` or `300ms`; a bare number is refused.

**A state name must exist.** `<scene state=>`, `<frame state=>` and `<apply state=>` all
resolve against declared `<state>` blocks. A typo does not quietly fall back to the
document's samples.

**The incoming scene owns both edges of its boundary.** `cut="fade"` (default) is the
320ms edit crossfade; `cut="hard"` is the commercial cut, and it kills the outgoing scene's
fade-out as well. A `<morph>` implies the hard boundary - the hero transition IS the edit.

**A tween owns its window; a set lets the app animate itself.** This is the one that
decides how a data change reads:

- `<tween>` when the film should choreograph the number: a ring counting 210 to 1480 over
  1.6s, macros staggering in one after another. While a tween is writing, the application's
  own transitions are driven to their end - the film supplies the in-betweens.
- `<set>` when the product already animates that value. One write, and the app's own
  transition plays: a `<progress>` fill sweeps on its own 200ms curve, a toggle slides, a
  button colour crosses. Reach for this first. A tween over a value the product already
  animates has the film re-describing motion the application defines, and a four-value
  count-up reads worse than the product's own sweep.

The application's motion is deterministic here: every animation is phased to the film
instant, so what you see in frame N is what any other run puts in frame N.

**A morph needs the component on both sides.** The named element must exist in the outgoing
scene AND in the incoming document; both are refusals if missing. The transition is true
matched geometry - the card is decomposed into pieces (elements carrying their own text,
plus childless visual leaves like a status dot), each piece exists once and travels between
its two measured rects, and the card surfaces crossfading underneath carry no text at all.
Pieces pair by their exact text, so a title travels to wherever that title now lives. Give
the two representations the same words where you want continuity.

**A supporting frame is scenery.** `<frame>` places extra devices around the primary mount;
each screen is a settled snapshot of its own document and state, and the PRIMARY owns every
interaction (taps, writes, camera, morph, focus). `depth="back|front"` orders it, `x`/`y`
place its centre in stage fractions, `width` sizes it against the stage. Supports float on
their own phases and yaw toward the hero, so a group of frames weaves instead of bobbing in
lockstep.

**Nothing may be static.** A scene that mounts no document and says nothing is refused
outright - it is the signature bad AI video.

**A tap is a landmark, never a coordinate.** `target="#lockButton"` is measured in the
mounted document and dispatched as a real click; the app flips because it decided to.

## The vocabulary

| Word | Values |
| --- | --- |
| `role` | `hook` `benefit` `title` `cta` |
| `ease` | `spring` `linear` `easeIn` `easeOut` `easeInOut` |
| `cut` | `fade` (default) `hard` |
| `frame` | `device` (default) `none` (the frameless product shot, sized by `width=`) |
| `depth` | `back` (default) `front` |
| `glow` | `accent` (default), any colour, or `none` |
| `scheme` | `light` `dark` |

`spring` is the one physics all renderers share, and `for=` is its settle envelope, so
hold-then-move never snaps.

## Directing, briefly

The camera and the pose are two different instruments. The CAMERA frames the stage (pan to
a measured landmark, push in with `zoom`); the POSE turns the device in space (six axes).
A flat component never rotates - `frame="none"` keeps only its position channel, because a
few degrees of yaw on something with no thickness reads as skew.

Captions are lower thirds; the type card (`<text>`) is a full-stage statement. Use one or
the other in a scene, not both.

`<focus>` spotlights a measured component: everything else dims behind an accent ring. It
answers "look here" without cutting the interface away.

## A worked composition

`OpenSource/Conformance/film/fixture/marketing/keto-launch/composition.dsx` is the demo
this engine is developed against: a hook card, a state journey through a real dashboard
with staggered tweens and supporting frames, a spotlight and a tap, a hero morph into the
frameless product shot where the card animates its own progress, and a CTA card. Read it
next to this page; it uses every word above.

## Checklist before you call a film done

1. `despia film check` is clean (it refuses before any browser work).
2. Every scene either mounts a document or says something.
3. Data changes: a tween where the film choreographs, a set where the product animates.
4. Morph targets exist on both sides and share their words.
5. Rendered at least once with `DSX_FILM_DUMP` and inspected at the boundaries.
6. `--master` produces the mp4 your channel needs (ffmpeg on PATH); the webm preview needs
   nothing installed.
