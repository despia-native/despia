---
name: writing-dsx-apps
description: "Write correct DSX app markup: the mental model, the element vocabulary, state in order of preference, lists, navigation (back and close POP, never href), and the mistakes generated code actually makes. Use before writing or editing any .dsx file. DSX is not React, React Native, HTML or Vue; do not guess syntax from adjacent frameworks."
---

<!-- GENERATED from OpenSource/Skills/writing-an-app.md in despia-native/despia.
     Edit the source, then: ruby ClosedSource/scripts/generate_agent_skills.rb -->

# Writing an app in DSX

> Audience: anyone (human or agent) building an APP in DSX markup, as opposed to building
> the framework. The normative document shape is
> [`dsx-anatomy.md`](https://github.com/despia-native/despia/blob/main/OpenSource/Documentation/reference/dsx-anatomy.md); every element, attribute
> and value is [`StackReference.md`](https://github.com/despia-native/despia/blob/main/OpenSource/Documentation/reference/StackReference.md); markup
> hygiene is [`dsx-best-practices.md`](https://github.com/despia-native/despia/blob/main/OpenSource/Skills/dsx-best-practices.md). This file is the working
> knowledge between them: the mental model, the vocabulary map, and the mistakes that cost
> the most time. If you know React or React Native, read
> [`thinking-in-dsx.md`](../thinking-in-dsx/SKILL.md) first; before styling anything, read
> [`designing-an-app.md`](../designing-dsx-apps/SKILL.md).
>
> A complete worked app (list, detail, settings, onboarding, paywall) lives in
> [`examples/`](https://github.com/despia-native/despia/tree/main/OpenSource/Skills/examples) as a real project you can lint, build and run.

## 0. The one warning that saves hours

DSX is newer than every model's training data and resembles several things it is not.
There is no JSX, no `import`, no hooks, no `className`, no HTML tags, no `div`. Guessed
syntax fails the linter, and the linter is the contract: `despia lint --strict` after
every edit is faster than any amount of reasoning about whether markup is legal.

```sh
npx despia lint --strict     # zero errors, zero warnings, or it is not done
npx despia review --strict   # the design bar's objective floor (a11y, tap targets, type scale)
npx despia build             # compile Components/**.dsx
npx despia dev               # serve + watch; open it and LOOK at the screen
npx despia doctor            # when a project will not build, this says why
```

## 1. The mental model

- **One `.dsx` file is one component.** The file basename is the component name;
  capitalized tags mount components (`Components/Card.dsx` renders as `<Card/>`),
  lowercase tags are built-in elements.
- **A document is head + body.** The `<head>` (first child of the root, at most one) is
  the contract and the logic; the body is pure markup. Head order is canonical:
  `attribute · expects · event · variable (plain, then computed) · formula · action ·
  script · watch · style · component`.
- **Each screen is a surface with its own store.** `dsx.variable.*` is local to the
  surface; `dsx.global.*` is shared app state ([`global-state.md`](https://github.com/despia-native/despia/blob/main/OpenSource/Skills/global-state.md));
  a pushed screen keeps its state while covered and restores it on pop.
- **Logic is JSE**, a JavaScript subset: expressions, `if`/`for`/`while`, arrow lambdas,
  the array/string stdlib. No classes, no imports, no DOM, no `fetch` by default.
  Arithmetic is total (`1/0` is `0`). `{{ ... }}` interpolates any attribute.
- **Capabilities are modules on the bus**: `dsx.module.<name>.<action>(args)`, awaited
  for the result. Haptics, storage, camera, routing: everything native is a module call,
  never an import.

## 2. The vocabulary map

Do not guess tag names; these are the families and where the full tables live.

| Family | Tags | Reference |
|---|---|---|
| Layout | `stack` (axis by content), `vstack`, `hstack`, `zstack`, `scroll`, `spacer`, `grid`, `flow`, `scaffold` (safe areas) | [Elements · Layout](https://github.com/despia-native/despia/blob/main/OpenSource/Documentation/reference/StackReference.md#elements) |
| Content | `text`, `image` (`icon=` draws a symbol), `progress`, `spinner`, `divider`, `qrcode`, `Skeleton` | Elements · Content |
| Inputs (two-way) | `textfield`, `textarea`, `toggle`, `slider`, `picker`, `stepper`, `datepicker`, `segmented`, all with `bind=`; array-backed choices ride `optionsKey=` + `labelField`/`valueField` (`options=` is CSV) | Elements · Inputs |
| Collections | `list`, `grid` with `bind=` + `key=`; the row template is the child markup, row scope is `item` | [Lists](https://github.com/despia-native/despia/blob/main/OpenSource/Documentation/reference/StackReference.md#lists) |
| Structure | `button`, `pressable`, `row`, `sheet`, `popover`, `alert`, `tabs`, `form`/`field` | Elements · Structure |
| Media | `video`, `audio`, `canvas`, `lottie`, `rive` | Elements · Media |

Universal attributes work on every element: `visible-if`, `on:tap`, `href`, `id`, `ref`,
`enter`/`transition`/`anim`, `measure`/`container`, `tooltip`, `shortcut`, the
accessibility set (`a11yLabel` or `aria-label`, both spellings), and per-platform
suffixes (`icon:android="notifications"`).

## 3. State, in order of preference

1. **`<attribute as="x" default="expr"/>`** for anything the consumer passes in. The
   default is a JSE expression, so a string literal keeps its quotes:
   `default="'Hello'"`. Read as `dsx.attribute.x`, never write it.
2. **`<variable as="x">return 0</variable>`** for state this file owns. The body is the
   initializer.
3. **`computed="true"`** for every derivation. If a value follows from other state, it
   is computed, full stop. A `<watch>` that maintains a value is a lint finding and a
   bug factory.
4. **`<formula as="f" a="item.x">`** for a parameterized derivation used per row.
5. **`<action as="do">`** for named logic; the body runs the full statement grammar and
   can call other actions (`dsx.action.other()`).
6. **`<watch value="expr" on:change="...">`** for genuine side effects only (fire a
   haptic, log, kick a module call).

With a head present, every `dsx.variable.x` the file touches must be declared (as
`variable` or `expects`); the linter enforces it, which makes a file's state surface
enumerable by reading the head.

## 4. Lists

```xml
<list bind="dsx.variable.episodes" key="id">
  <hstack class="row" spacing="12" a11yGroup="true" on:tap="dsx.module.route.push({ path: '/episode/' + item.id })">
    <image src="{{ item.poster }}" width="44" height="44" radius="8"/>
    <vstack spacing="2">
      <text value="{{ item.title }}" fontWeight="semibold"/>
      <text value="{{ item.subtitle }}" fontSize="13" color="secondary"/>
    </vstack>
    <spacer/>
  </hstack>
</list>
```

- `bind=` names the array, `key=` the stable id field (`key="index"` for data with none).
- Row scope: `item` (the row's dict), `index`. A formula reads row fields via its inputs.
- Every list needs its empty, loading and error branches; see
  [`designing-an-app.md`](../designing-dsx-apps/SKILL.md) section 5 for the pattern.

**The list-row laws.** Each of these was learned by looking at a rendered feed in a real
browser, and the worked example's oracle now asserts them structurally:

1. **Row text truncates, it never wraps**: `lineLimit="1"` on every line. A wrapped meta
   line with a dangling separator at the line end is the single fastest way to look broken.
2. **The LIST is the card.** The container around `<list>` owns the grouped surface
   (background, radius, `style="overflow: hidden"` so row highlights clip at the corners);
   rows paint no background of their own, so the platform's separators and highlight read
   correctly.
3. **One trailing element**: a value (a rating, a count) OR a disclosure chevron, never
   both. Two trailing elements starve the text column and everything ellipsizes.
4. **A list supplies its rows' horizontal inset** - the platform's own, and the same
   measure its separators use. A row template that adds its own `paddingH` doubles it:
   the content lands twice as far in as the hairline, so every separator starts visibly
   left of the row's leading icon. A row owns its VERTICAL rhythm (`paddingV`) only.
5. **The flexible column carries `grow="width"`**, and a row component's root carries
   `grow="width"` too, so it stretches to the pressable that wraps it. A row that hugs its
   content leaves its trailing value floating short of the card edge.
6. **Budget the row for a 390pt phone.** Fewer facts rendered whole beat many facts
   ellipsized; move the overflow to the detail screen.
7. **Declared sizes are fixed frames.** `width="36"` measures 36 on every renderer; if a
   row feels cramped the fix is the content budget, never trusting a tile to shrink.

## 5. Navigation

- **Routes are state.** The route table lives in `dsx.config.json`; `route.path = '/x'`
  is a replace. The back stack is the route module:
  `dsx.module.route.push({ path })` · `pop()` · `replace({ path })` · `reset({ path })`.
- **`href` is the anchor attribute** on any element: declarative push, a real `<a>` on
  web (crawlable), interpolates (`href="/orders/{{ item.id }}"`). Prefer it for plain
  "go here" taps.
- **Component screens** (path-less) use the component verbs:
  `dsx.component.push('Detail', { attrs: { id: item.id } })` for a nav frame,
  `dsx.component.present('Paywall', { as: 'sheet', attrs: { plan: 'pro' } })` for a
  modal. `attrs` seeds the target's declared `<attribute>`s; `vars:` is legacy.
- **Back, Close and Skip POP; they are never `href`.** `href` always pushes, so a back
  affordance spelled `href="/"` stacks a second copy of where you came from under every
  tap (found in a real browser, not in the linter). The pattern that always works, on
  every renderer, reads the router's published `nav` plane:

```xml
<action as="back">
  if (dsx.variable.nav.canPop) { dsx.module.route.pop() }
  else { dsx.module.route.replace({ path: '/' }) }
</action>
```

  Pop when there is history; replace when deep-linked. A dismissed screen lands on the
  screen that opened it, never teleports home. The worked app uses this on every back,
  close and skip.

## 6. Components you write

- Attributes down, events up: the tag's attributes arrive as `dsx.attribute.*`; the
  component raises `dsx.event('save', { id })` and the consumer wires `on:save`.
- `<slot/>` renders the children the caller passed, in the caller's scope; named slots
  via `<slot name="footer"/>` + `slot="footer"` on the child.
- A page-local part that will never be reused elsewhere can be declared inline:
  `<component as="Row">...</component>` in the head registers it for this file's scope.
- A component boundary cannot forward a two-way `bind`; a reusable input takes `value`
  in and raises `on:change`.
- Components also arrive from packages: `despia search <query>` finds one,
  `despia add github:owner/repo` pins it, and its components join your tag namespace.
  A bare scaffolded project resolves only its own `Components/` plus the built-in
  elements; library components (`<Card>`, `<NavBar>`, ...) ship with framework packages.

## 7. The mistakes that actually happen

Each of these is a real failure mode observed in generated DSX; the linter catches most,
the build catches the rest.

1. **HTML or JSX leaking in**: `div`, `span`, `img`, `onClick`, `className`,
   `style={{...}}`. The spellings are `vstack`/`text`/`image`, `on:tap`, `class`,
   `style="..."`.
2. **Multi-statement inline handlers.** An inline `on:` holds one call or one
   assignment. More than that is a named `<action>`.
3. **Watch-maintained values.** Derived state is `computed="true"`.
4. **Mutating an attribute** (`dsx.attribute.x = ...`). Attributes are read-only inputs;
   the component raises an event and the owner changes the value.
5. **Imperative handles.** There is no `ref.current.clear()`. Design the value instead:
   clearing a signature is `sig = []`. A method survives only when it changes something
   that is not state, and then it is a module action.
6. **Undeclared state.** With a head present, every touched variable is declared. The
   error reads like bureaucracy and is actually the feature: heads are the API.
7. **Guessed attribute names.** `fontSize`, not `font-size`, as an attribute
   (`style="font-size: 17px"` is the CSS-string alternative); `visible-if`, not `if`;
   `bind`, not `value=` + `onChange` on two-way inputs.
8. **Rebuilding system controls out of stacks.** If it is a toggle, use `<toggle>`. The
   unstyled element already renders the platform's own control on every renderer.
9. **Skipping the loop.** Lint after every edit, build before done, open `despia dev`
   and look. A screen nobody looked at is not finished.

## 8. Where deeper knowledge lives

- Anatomy + a worked golden template: [`dsx-anatomy.md`](https://github.com/despia-native/despia/blob/main/OpenSource/Documentation/reference/dsx-anatomy.md)
- Every element and attribute: [`StackReference.md`](https://github.com/despia-native/despia/blob/main/OpenSource/Documentation/reference/StackReference.md)
- Design quality bar: [`designing-an-app.md`](../designing-dsx-apps/SKILL.md)
- Coming from React Native: [`thinking-in-dsx.md`](../thinking-in-dsx/SKILL.md)
- Custom gesture-driven controls: [`custom-ux.md`](https://github.com/despia-native/despia/blob/main/OpenSource/Skills/custom-ux.md)
- Offline + caching behavior: [`offline-best-practices.md`](https://github.com/despia-native/despia/blob/main/OpenSource/Skills/offline-best-practices.md)
- Backend routes and entities in the same project: [`writing-a-backend.md`](https://github.com/despia-native/despia/blob/main/OpenSource/Skills/writing-a-backend.md)
