---
name: designing-dsx-apps
description: "The design bar for DSX apps: structure before pixels, semantic tokens with one accent job, the type scale, the 4-point grid, the four states every screen has, motion and haptics as punctuation, the accessibility floor, and the flows that decide whether an app sells. Use before styling any screen and before calling any screen done."
---

<!-- GENERATED from OpenSource/Skills/designing-an-app.md in despia-native/despia.
     Edit the source, then: ruby ClosedSource/scripts/generate_agent_skills.rb -->

# Designing an app that does not look generated

> Audience: anyone (human or agent) deciding what a DSX screen looks like. The renderer
> holds up its half of the bargain: an unstyled element is the platform's own control on
> every target (`../Documentation/architecture/proposals/system-defaults.md`). What the
> renderer cannot supply is composition, and composition is where generated apps die:
> right components, wrong structure, twelve accent colors, no empty states. This file is
> the bar. `despia review --strict` enforces the objective floor of it (accessible names,
> tap targets, the type scale, token discipline); everything else is enforced by your eyes
> on `despia dev`. Nothing here is optional because it is prose.
>
> Companions: [`writing-an-app.md`](../writing-dsx-apps/SKILL.md) (the language),
> [`thinking-in-dsx.md`](../thinking-in-dsx/SKILL.md) (coming from React Native), the token law in
> [`StackReference.md`](https://github.com/despia-native/despia/blob/main/OpenSource/Documentation/reference/StackReference.md#colors).

## 1. Structure before pixels

Most "AI apps look bad" is structure, not styling. Decide these before any color:

- **Navigation shape.** Three to five top-level destinations: tabs. A drill-down
  hierarchy: a stack (`dsx.module.route.push`, or `href=`). A task that interrupts
  without changing place: a sheet (`dsx.component.present(..., { as: 'sheet' })`).
  A destructive confirmation: `<alert>`. Never a custom overlay where a sheet exists,
  and never navigation buried inside cards when it is really a tab.
- **Dismissal returns where you came from.** Back, Close and Skip pop the stack (the
  guarded-back pattern in [`writing-an-app.md`](../writing-dsx-apps/SKILL.md) section 5); a paywall
  closed from a detail screen lands back on that detail. A back button that pushes home
  grows the stack forever and breaks the platform's back gesture.
- **One screen, one job.** A screen that lists picks; a screen that shows details acts.
  Settings is a grouped list, not a dashboard. If a screen needs a paragraph to explain,
  it is two screens.
- **The list language.** Screens of rows use the grouped idiom the platform already
  taught users: page on `groupedBackground`, the LIST'S CONTAINER on
  `secondaryGroupedBackground` (the list is the card; rows paint no background of their
  own), hairlines with `separator`. A tappable row gets a trailing value OR a chevron,
  never both, plus `a11yGroup="true"` so it reads as one thing. Row text truncates with
  `lineLimit="1"`, it never wraps; the full row laws are in
  [`writing-an-app.md`](../writing-dsx-apps/SKILL.md) section 4.
- **Hierarchy is spatial before it is typographic.** Group related things with spacing
  and section headers before reaching for another font size.

## 2. Color: tokens first, one accent, one job

- **Semantic tokens are the default**: `label`, `secondary`, `tertiary`, `background`,
  `groupedBackground`, `secondaryGroupedBackground`, `fill`, `separator`, `accent`,
  `destructive`. They resolve to the platform's own adaptive colors, so light and dark
  mode are correct for free and the look inherits OS updates instead of rotting.
- **`accent` has exactly one job**: the primary action and selection. When the accent
  marks the tab bar, the headings, the borders, the badges and three buttons per screen,
  it marks nothing. Everything that is not the primary action defaults to `label` on
  `fill`.
- **`destructive` means destruction**, never emphasis.
- **Raw hex is a brand moment**, deliberately placed (a hero, a logo lockup, a plan
  card), not a habit. A screen written entirely in hex has opted out of dark mode and
  platform updates in one move.
- **Ink hierarchy**: primary content in `label`, supporting metadata in `secondary`,
  timestamps and captions in `tertiary`. Never the reverse; the biggest text on screen
  should not be the faintest.
- **Contrast floor**: body text at 4.5:1 against its background, large text at 3:1.
  Tokens meet this by construction; every hex pair you invent, you own.

## 3. Type: a scale, not a slider

- Take sizes from a scale and stay on it: 12 (caption) · 13 (footnote) · 15
  (subheadline) · 17 (body) · 20 (title) · 24 (heading) · 34 (large title). Arbitrary
  sizes (16, 19, 22) read as noise across screens.
- **Weight before size** for emphasis: `fontWeight="semibold"` at body size beats
  bumping the size.
- One heading per screen zone; the named styles (`style="heading"`,
  `style="subheading"`, `style="rowTitle"`) exist so screens agree with each other.
- Long-form or accessibility-sensitive text opts into Dynamic Type:
  `dynamicType="true"` (`dynamicTypeMax=` caps a fixed-height control).

## 4. Spacing: the 4-point grid

- Every padding, gap and margin is a multiple of 4. Screen edge padding is 16 or 20;
  card padding 16; row internal spacing 12; tight metadata 4 or 8.
- Prefer container `spacing=` / `gap` over per-child margins; the container owns rhythm.
- Align to edges. Mixed left-alignments inside one column is the single most visible
  "generated" tell.
- Let content breathe: when in doubt between two spacings, take the larger. Cramped
  reads as broken; airy reads as intended.

## 5. States: every screen has four

A screen that only handles the happy path is half a screen. For anything data-backed:

- **Loading**: skeleton shapes where the content will land, not a lone spinner, so
  arrival is a repaint and nothing jumps.
- **Empty**: say what would be here and hand the user the action that creates the first
  one. An empty list with no words is indistinguishable from a bug.
- **Error**: say what failed in the user's terms and offer retry. Never render the raw
  error string from a module as the UI.
- **Content**: the happy path, last, because it is the easy one.

```xml
<vstack visible-if="dsx.variable.phase == 'empty'" spacing="8" padding="32" align="center">
  <image icon="tray" iconSize="34" color="tertiary"/>
  <text value="No episodes yet" style="rowTitle"/>
  <text value="Subscribe to a show and new episodes land here." color="secondary" align="center"/>
  <button label="Browse shows" on:tap="dsx.module.route.push({ path: '/browse' })"/>
</vstack>
```

## 6. Motion and haptics: punctuation, not decoration

- Motion answers "where did this come from": `transition=` on things that appear and
  disappear, `enter=` on a screen's hero. If a screen animates everything, it animates
  nothing.
- One duration family per app; the defaults are tuned, so override rarely.
- Haptics mark meaning: success, warning, a value crossing a threshold
  (`dsx.module.haptic.warning()`), never every tap.
- The kernel honors reduced-motion preferences in its own components; anything custom
  you animate must stay legible when motion is off.

## 7. The accessibility floor (non-negotiable, mostly free)

- Tap targets at least 44 points on anything tappable.
- Every icon-only button carries `a11yLabel` (or `aria-label`).
- Content images get a label; decorative images get none and are hidden automatically.
- Composite tappable rows carry `a11yGroup="true"` so they read as one utterance.
- Custom drag controls add `on:adjust` + `a11yValue` so they work without sight.

The defaults do most of this: `on:tap` announces as a button, inputs ride the platform
controls' semantics. The floor is about not undoing that with custom chrome.

## 8. The flows that decide whether an app sells

- **Onboarding shows value before it asks for anything.** Two or three screens maximum,
  each one concrete benefit, skippable. Permission prompts (notifications, location)
  fire in the context where the value is obvious, never as a wall at first launch.
- **The paywall comes after the aha moment**, not before it. State the price plainly,
  make the free path visible, and present it as a sheet the user can dismiss. A paywall
  the user cannot leave is a refund and a one-star review.
- **Auth is as late as possible.** Let users see the product; ask for the account when
  something must be saved.
- **Settings follow the platform's grammar**: grouped rows, disclosure chevrons,
  destructive actions in their own group at the bottom, in `destructive`.

For pattern research, a design-reference MCP server (a library of shipped screens from
top-grossing apps) is the right tool: study how winners structure a flow, then implement
the structure in DSX with this file's rules. Reference the pattern, never clone the
brand, the copy or the assets.

## 9. Verify by looking

Design review is running the app, not reading the markup:

1. `despia dev`, open the FRAMED PREVIEW it prints (`/__dsx/preview`): the app at real
   phone size in a device frame, with size presets and a light/dark toggle. A phone
   layout judged full-bleed in a desktop tab always looks wrong; judge it at the size
   it ships.
2. Walk Phone, Tablet and Desktop; nothing should overflow, collapse to zero, or float
   unanchored in empty space.
3. Toggle light and dark in the shell: token-colored screens survive automatically;
   anything unreadable is a hex that should be a token.
4. Walk every state in section 5, not just content.
5. Then read the screen against sections 1 to 4: one accent job? on-scale type? grid
   spacing? aligned edges?

If a screenshot of the running screen is possible, take it and look at it. Markup that
"should look right" and was never looked at is the whole reason this file exists.
