# Changelog

The DSX kernel's version. One number across all three faces (Swift, Kotlin,
TypeScript), because they are one codebase compiled three ways and a version that
meant different things per face would be a lie. Independent of Despia AI's and
Despia Local's, which release for their own reasons.

**DSX stays on `0.0.1` until `1.0.0`.** That is deliberate, not neglect. We are
still refining the surface against real feedback, and a version number that moved
every time we learned something would tell you nothing while implying stability we
have not earned yet. What you get instead is MIGRATIONS: when something has to
change, we ship the path forward with it and say so here. Read this file for what
moved, not the version string.

## 0.0.1 (unreleased changes on the 0.0.1 line)

The renderers stopped disagreeing. Most of this release is one rule applied
everywhere: a capability that ships on one renderer ships on all of them, and the
gaps that rule exposed turned out to be real and numerous.

### Removed: the embedded Godot runtime (`<Godot/>`, `godot://`)

**What changed.** `Core/Godot` is gone: the `<Godot/>` element, the `godot` scheme
and its six actions (`open` `close` `toggle` `send` `pause` `resume`), the SwiftGodotKit
link, and the sample project.

**Why, and why not the alternative.** DSX now has its own 2D/3D and physics engine,
and shipping two was not a neutral cost. The embedded runtime was iOS-only, added a
large binary dependency, and could never satisfy Article 10 - it was permanently in
the parity register as a declared gap on every other renderer. We could have kept it
as an optional module and let the two diverge. We did not, because a second engine
that only works on one platform is exactly the "supported here, unsupported there"
split the whole architecture exists to prevent, and carrying it would have meant
teaching two answers to every 3D question.

**How to migrate.** `Scene3D` is the replacement and it is a real one: `<scene3d>`
with `ScenePhysics`, glTF/GLB loading, raycasting and snapshots, corpus-gated across
renderers rather than native on one.

```diff
- <Godot src="/demo"/>
+ <scene3d src="/model.glb"/>
```
```diff
- dsx.module.godot.open({ src: '/demo' })
+ dsx.module.scene3d.open({ src: '/model.glb' })
```

`open` `close` `toggle` `pause` `resume` map across directly. `send` has no direct
twin: the Godot bridge passed opaque messages into a foreign runtime, where Scene3D
exposes the scene as addressable state, so what was a message is now a call
(`scene3d.camera`, `scene3d.raycast`) or a state write. If you were sending custom
GDScript commands, that logic moves into your DSX actions.

**If this breaks you.** If you shipped on the embedded runtime and this migration
does not cover your case, please open an issue or ask in the community on GitHub. We
would rather hear about it and help than have you discover it alone: early adopters
carrying real apps are exactly who this line is being refined against.

- **Article 10, one feature every platform.** A capability is now supported,
  polyfilled, or platform-limited with a NAMED degradation, and nothing else.
  "Unsupported", "inert" and "not yet mapped" are descriptions, not
  justifications. `check_platform_parity.rb` enforces it against a register that
  only shrinks.
- **The style catalogue got its web column, and it was mostly empty.** 67 style
  attributes were mounted in a real browser and diffed against a bare twin. 37
  were wholly inert on web while working on both native renderers, including
  `paddingTop`, `textAlign`, `borderWidth`, `shadow`, `rotation`, `minWidth` and
  the whole type family. 31 are implemented here; the remaining pins only shrink.
- **Named styles were inert on web.** `<style as="card">` plus `class="card"` is
  the reusable-look contract both app-authoring skills teach, and both native
  renderers had always honoured it. The web compiler dropped the head tag, so
  idiomatic DSX rendered structurally perfect and completely unstyled.
- **`<override>`, the component styling contract.** A component declares typed
  style knobs beside its data attributes; a usage site sets them with
  `override:<name>=`, and `dsx.override.<name>` reads them back. All four
  renderers, corpus-gated.
- **New primitives and components.** `<ink>` (drawing on `<canvas>`, one shared
  ink law per language), `<Signature>`, `<Plot>` (ten chart shapes), `<Diagram>`,
  `<Swipe>`, `<ImageGeneration>`, and 29 further gaps closed against the PanelUI
  survey, all in markup rather than as native implementations.
- **Motion and scroll.** `@keyframes` and `animation` were parsed, linted and
  catalogued while both native resolvers dropped them; a keyframe sampler now
  runs them everywhere. Scroll-linked values gained `clamp()`, `min()` and
  `max()`, so a bounded scroll effect needs no handler.
- **The `nav` plane reached web.** `nav.stack`, `nav.canPop` and `nav.depth` had
  been published by the Kotlin router since the beginning and documented in
  StackReference, while the web router kept its stack private, so
  `dsx.variable.nav.canPop` read absent on exactly one renderer.
- **Localization on all three renderers**, corpus-first, with the display points
  re-resolving live so a locale write repaints without a reload.
- **`<tool>`, the WebMCP row.** A document declares what an agent may do and the
  descriptor is DERIVED from that action's declared inputs. No `schema=`, ever.
- **Fixed: the kernel did not compile for iOS.** `CanvasSurface.inkPath` was
  reachable only from its own file after the ink wave, and `<flow>`'s bind
  fallback called `slot()` on a privileged context that has none. Both had been
  broken for three days in a tree where every other gate was green, because no
  environment in this project's history had a Mac to compile Swift on.

### The first cut

The message bus, the primitives, the JSE evaluator, the three renderers and the
conformance corpora that keep them agreeing.
