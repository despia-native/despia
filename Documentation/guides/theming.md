# Theming a DSX app

Every built-in control in DSX is drawn from a token. Not "can be" - IS. A button's
height, a switch's radius, a focus ring's colour, the exact grey of a disabled label:
each is a named value the kernel reads at paint time, on every renderer. Theming is
re-pinning those names.

That is the whole idea, and it is worth stating plainly because the alternative is what
most people try first: fighting the framework with per-element overrides until the app
looks consistent by accident. You do not have to. **Re-pin the token and every control
that reads it moves at once**, on iOS, Android, desktop and web, from one file.

## The one file

`theme.css`, beside your app manifest. Its existing IS the declaration - there is no
flag to set and no import to write, the same file-presence rule the rest of DSX uses. A
missing file is simply no theme tier, never an error.

```css
/* theme.css */
:root {
  --dsx-accent: #0a84ff;
  --dsx-radius-card: 14px;
  --dsx-button-min-height: 48px;
}

@media (prefers-color-scheme: dark) {
  :root { --dsx-accent: #4da3ff; }
}
```

Those are the kernel's own token names. Setting `--dsx-accent` restyles every accent
surface in the app: prominent buttons, selected segments, the focus ring, the slider
fill, the switch's on state. You did not touch any of those elements.

## The cascade

Five tiers, weakest to strongest. This ordering is not a convention, it is corpus-gated
(`OpenSource/Conformance/defaults/project-theme.json`):

| | Tier | Who writes it |
|---|---|---|
| 1 | renderer defaults | the kernel |
| 2 | package sheets | packages you install, in package order |
| 3 | **your `theme.css`** | you, folded last |
| 4 | component sheets | a `Card.css` beside its `Card.dsx` |
| 5 | inline styles | a `style=` on one tag |

So **your app re-pin beats every package and the kernel**, and a component's own sheet
still beats your app. That is deliberate: an app sets the language, a component keeps
the right to be itself, and one tag can always say something local.

## The vocabulary

237 tokens today. They are grouped by what they govern, and the family prefix tells you
where a name will bite:

| Family | Count | Governs |
|---|---|---|
| `type` | 59 | the type ramp: sizes, weights, line heights, tracking |
| `state` | 13 | hover, pressed, focus, disabled, dragged layers |
| `space` | 13 | the spacing scale (`--dsx-space-1` … `--dsx-space-12`) |
| `button` | 10 | height, radius, padding, font, density |
| `toggle` · `slider` | 18 | the two most geometry-heavy controls |
| `surface` | 9 | `base`, `cut`, `level-1`, `level-2`, `highlight`, `hover` |
| `control` | 8 | shared control metrics |
| `segment` | 7 | the segmented control |
| `radius` | 7 | `--dsx-radius`, `-card`, `-control`, `-sheet`, `-full`, `-lg` |
| `focus` | 7 | ring colour, width, offset, inset, halo |
| `shadow` | 6 | `xs` through `4` |
| `accent` | 4 | `--dsx-accent`, `-hover`, `-pressed`, `-muted` |
| `dur` · `ease` · `motion` | 16 | the motion plane |
| `safe` | 4 | safe-area insets |

To read the live list rather than this table, which is the habit worth building:

```bash
grep -oE '\-\-dsx-[a-z0-9-]+' OpenSource/Web/packages/dom/src/theme.ts | sort -u
```

The Studio shows the same set grouped as Ink / Surfaces / Accent / Geometry, with light
and dark wells side by side, and writes this exact file.

## Light and dark

Tokens carry both schemes. Re-pin inside a `prefers-color-scheme` block and the
runtime resolves per scheme; the unstyled baseline is already the platform's own in both,
which is the system-defaults law: an app that sets nothing looks native, not beige.

Do not invert a colour to get its dark value. A translucent surface composites with its
ground, so ink that measures fine on white can fail on a tinted panel. Set both, and
check the contrast rather than trusting the eye.

## When a token is not enough

In order of preference, because each step is narrower than the last:

1. **A token re-pin** if the change is a language change. Accent, radius, spacing.
2. **A class** for a repeated look: `<style as="card" .../>` in the head, `class="card"`
   at the usage site. Both native renderers and web merge it under the element's own
   attributes.
3. **A component sheet** - `Card.css` beside `Card.dsx`, scoped to that component's
   subtree automatically.
4. **`<override>`** when a component should expose a typed knob to its consumers. This
   is the component's STYLE contract, beside its data contract, and the editor renders
   real controls for it. See `Skills/style-overrides.md`.
5. **An inline `style=`** for the genuinely one-off.

If you reach for 5 repeatedly, the answer was 1.

## "Can I just write SwiftUI or Compose?"

Almost always the honest answer is: you do not need to, and you should not want to.

A DSX component is markup over primitives, written once, running on four renderers. The
moment you hand-write a SwiftUI view for it you have one implementation of a four-
implementation contract, and the other three silently diverge. That is the failure
Article 10 of the constitution exists to prevent: a capability that ships on one renderer
ships on all of them.

The test is one question: **does this need a platform capability markup cannot express?**

- **It draws something.** A meter, a chart, a waveform, a custom card. That is `.dsx`
  over primitives, and it is not a compromise: `<Plot>` is ten chart shapes in markup,
  `<Diagram>` is a node graph, both on every renderer.
- **It reaches hardware or an OS surface** markup has no word for. A decoder, a camera,
  a text input, a biometric prompt. That is a PRIMITIVE, and primitives are native by
  definition. Write it per platform, expose it through the bus, and style it with the
  ordinary token surface like every other element. See `Skills/native-components.md`.

The escape hatches are real and documented (`Skills/custom-ux.md`), and they exist for
the second case. Reaching for them in the first case is how an app ends up looking
correct on one platform and wrong on three.

## Verify by looking

Theming is the one area where the gates cannot tell you that you are done. Contrast is
computable and `despia review --strict` checks it (WCAG floors, tap targets, the type
scale, raw-hex discipline). Whether the result looks like a product is not.

```bash
despia dev            # framed at real device size, with a scheme toggle
despia review --strict
```

Look at it in both schemes, at phone width, with real content. A theme that was only ever
seen in one scheme is a theme that is half-checked.

## See also

- `guides/styling.md` - the CSS surface itself: sheets, units, what the bridge maps
- `Skills/style-overrides.md` - the per-component typed style contract
- `Skills/style-catalog.md` - the machine-readable style-panel schema
- `Skills/designing-an-app.md` - the design bar, and the four states every screen owes
- `architecture/proposals/system-defaults.md` - the law: why unstyled IS the platform
