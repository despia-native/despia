# DSX release notes

Shipped by Despia Native.

## Why the version still says 0.0.1

Because it is honest, and because moving it would tell you less than this file does.

DSX stays on `0.0.1` until `1.0.0`. We are refining the surface against real
feedback, internal and external, and a number that ticked every time we learned
something would imply a stability we have not earned yet while telling you nothing
about what actually moved. `0.0.x` says exactly one thing: the API is not frozen
and no compatibility is promised between changes. That is the truth of where we are.

What you get instead of version churn is **migrations**. When something has to
change, we ship the path forward with it, in this file and in each package's
`CHANGELOG.md`. Read those for what moved. The version string is not the story
until `1.0.0`, and when it becomes one, it will mean the API is a contract.

## What changed in this release

### The renderers stopped disagreeing

Most of this release is one rule applied everywhere: **a capability that ships on
one renderer ships on all of them.** Supported, polyfilled, or platform-limited
with a named degradation, and nothing else. "Unsupported" and "not yet mapped" are
descriptions, not justifications.

Applying that rule found more than we expected. The style catalogue had 67
attributes with no recorded web support, and measuring them in a real browser found
**37 wholly inert** on web while working on both native renderers, including
`paddingTop`, `textAlign`, `borderWidth`, `shadow` and the whole type family. 31 are
implemented here. Named styles (`<style as="card">` plus `class="card"`) were inert
on web too, so idiomatic DSX rendered structurally perfect and completely unstyled.
The `nav` plane had been published by the Kotlin router since the beginning and
documented in StackReference, while the web router kept its stack private.

**Impact:** if your app looked right on device and wrong on web, this is likely why,
and you should not need to change anything to get the fix.

### Removed: the embedded Godot runtime

`Core/Godot` is gone: the `<Godot/>` element, the `godot` scheme and its six actions,
the SwiftGodotKit link and the sample project. **This is the one breaking change in
this release.** The migration is in `Engine/CHANGELOG.md` under "Removed: the
embedded Godot runtime", with a line-by-line mapping to `Scene3D`.

**Why this and not the alternative.** We could have kept it as an optional module and
let the two engines diverge. We did not. It was iOS-only, carried a large binary
dependency, and sat permanently in the parity register as a declared gap on every
other renderer. A second engine that works on one platform is precisely the
"supported here, unsupported there" split the architecture exists to prevent, and
keeping it would have meant teaching two answers to every 3D question. DSX now has
its own 2D/3D and physics engine, so the honest move was to have one.

### New: theming is documented

The kernel draws every built-in control from a named token, 237 of them, and an app
can re-pin any of them from one `theme.css` and restyle the whole product at once.
That was true before this release and documented nowhere you would look, so the
most powerful thing in the styling system was effectively invisible.
`Documentation/guides/theming.md` is the missing page.

### New: the docs are gated against the runtime

A page that names a token, a file or a command that does not exist reads exactly
like one that does. `check_doc_claims` now verifies every such citation in every
shipped doc against the actual runtime, and it runs before anything is published.
Its first run found a styling guide teaching four tokens that do not exist.

## What is changing going forward

- **Migrations, not version bumps.** Expect breaking changes while we are pre-1.0,
  each shipped with its migration path. We would rather move the surface to the
  right place now than freeze the wrong one early.
- **Article 10 is not negotiable.** New authoring surface lands on every renderer,
  fixtures first, or it does not land. If you find a capability that behaves
  differently across renderers, that is a bug and we want to hear about it.
- **The parity register only shrinks.** Every remaining gap is itemised with a named
  degradation. It is not a wishlist; a row that outlives its debt is removed.

## If you are already building on DSX

You are the reason this line exists, and you are carrying the most risk. Two things:

**Read `CHANGELOG.md` before upgrading**, per package. That is where migrations live.
`Engine/CHANGELOG.md` is the kernel; `AI`, `Local` and `MCP` version independently
and have their own.

**Tell us when we break you.** If a migration does not cover your case, or you hit a
backward-compatibility problem we did not anticipate, please open an issue or ask in
the community on GitHub. We would much rather hear about it and help than have you
work around it alone. Early adopters running real apps are exactly who we are
refining this against, and a case we have not seen is worth more to us than a clean
issue tracker.

## Maintaining a DSX app

The habits that keep an app healthy across a moving pre-1.0 line:

- **Run the gates locally.** `despia lint --strict` and `despia review --strict`
  catch most of what a release would otherwise surprise you with, including
  accessibility floors, contrast and the type scale.
- **Look at both schemes, at phone width, with real content.** Theming is the one
  area a gate cannot judge for you.
- **Re-pin tokens, do not fight them.** If you find yourself repeating an inline
  `style=`, the answer was a token or a class. `guides/theming.md` has the ladder.
- **Keep your own conformance close to ours.** If you depend on behaviour, write the
  fixture. When we change something, a fixture tells you immediately.
