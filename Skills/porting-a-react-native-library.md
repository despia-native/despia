# Porting a React Native library into DSX

> Audience: anyone who has just been handed an npm package — `panelui-native`,
> `react-native-signature-canvas`, `react-native-<anything>` — and asked to "ship this for
> Despia". This is the flow: how to decide what the package actually IS, what to port and what
> to refuse, and every file a landed port touches. Companions:
> [native-components.md](native-components.md) (markup vs machinery),
> [writing-a-module.md](writing-a-module.md) (a capability on the bus),
> [component-props-and-state.md](component-props-and-state.md),
> [custom-ux.md](custom-ux.md). Law: the unified-codebase law (`/CLAUDE.md`) and
> `Documentation/architecture/system-defaults.md`.
>
> Worked examples throughout: **`<Signature>`** + the `<ink>` primitive it forced out of the
> canvas (from PanelUI's `Signature` / `react-native-signature-canvas`), and **`<Swipe>`**, the
> swipe-to-reveal row that needed no native code at all.

## 1. The claim, stated once

**You port the DESIGN, never the code.** An RN library is two things welded together: a
product decision (what the control is, what it is called, what it does) and an implementation
that exists to work around React Native (a JS thread, a bridge, a `<WebView>` where a canvas
should be, a re-implementation of a platform control in `Animated`). The first half is worth
having. The second half is the thing Despia exists to delete.

So the port is not a translation. It is: read the package's contract, write that contract as a
fixture, and implement it natively four times from the fixture. **Never copy source** — you
are not licensed to by default, and the source you would copy is the half you are throwing
away. (If you genuinely must vendor bytes, they clear `check_opensource_purity.rb`'s
allowlist — permissive licence, pinned in `vendor/VERSIONS`, licence text on disk — or the
tree moves to `ClosedSource/`.)

## 2. Triage: what is this package?

Every RN package lands in exactly one of three buckets. Decide before you write anything.

| Bucket | What it is | Where it goes |
|---|---|---|
| **Component** | Something you put on screen: a card, a sheet, a chart, a signing pad | a `.dsx` markup component, or a native element — §3 |
| **Capability** | Something you *call*: a payment SDK, a scanner, a health store | a module on the bus — [writing-a-module.md](writing-a-module.md) |
| **Non-port** | A package that exists only because RN lacks something the kernel already has | nothing. Name the DSX primitive and move on — §7 |

The third bucket is bigger than people expect. When a component library lists 118 exports,
a third of them are usually the library re-implementing what a platform already ships.

## 3. Component: markup or native?

Ask the essence question from [native-components.md](native-components.md): *could this be
markup?* If the thing is composition, spacing, text and existing elements — it is a `.dsx`
file in a module's `Components/` folder and it compiles into all three renderers by
construction. That is ~95% of a UI library and it is a one-file port.

It is a **native element** only when the component owns real platform machinery: a drawing
surface, a player, a map, a camera preview. `<Signature>` qualifies — the essence is ink under
a finger at 120Hz, which is exactly what a JS thread cannot do and what the RN packages fake
with a `WebView`.

A native element is roughly a day of work and touches ~22 files (§6). A markup component is
an afternoon. Choose deliberately: shipping a markup component and being wrong is cheap;
shipping a native element you did not need is a permanent tax on four renderers.

## 4. Translate the API, do not transliterate it

This is the part that decides whether the port feels like DSX or like React with angle
brackets. Work through the RN component's props table and rewrite each row:

| React Native | DSX | Note |
|---|---|---|
| props | attributes | `strokeWidth={3}` → `strokeWidth="3"`; every attribute interpolates `{{ }}` |
| `children` / compound `Card.Header` | `<slot/>` + named slots | `slot="header"` replaces a subcomponent |
| `onFoo` callbacks | `on:foo` actions | payload rides `dsx.this` |
| `ref` + imperative handle (`ref.current.clear()`) | **a bound value** | see below — this is the important one |
| `useState` in the component | the store (`bind`) | one plane, reactive, inspectable |
| `StyleSheet` / `className` | style attributes + DSX-CSS + tokens | `system-defaults.md`: the unstyled baseline IS the platform |
| context provider + `useTheme()` | `dsx.global.theme` / module context | no provider tree to mount |
| `useToast()` and friends | `dsx.module.toast.show(…)` | a capability is a module, not a hook |
| `Animated` / Reanimated | `enter`/`exit`/`transition`/`anim` | the motion kernel, one duration ramp |
| `PanResponder` / gesture-handler | universal `on:drag*`, `on:pinch`, … | [custom-ux.md](custom-ux.md) |
| `Portal` | the overlay elements (`sheet`, `popover`, `alert`, `Drawer`) | |
| `SafeAreaView` | `<scaffold>` | |

**The imperative-handle rule.** RN hands you methods on a ref because React has no other
channel. DSX has one: the value. Before you invent an action, ask what state the method
*changes* and let the author write that state instead.

```xml
<!-- Not this: a control channel nobody can inspect, replay or undo.
     <Signature ref="sig"/>  dsx.module.signature.clear({ ref: "sig" })      -->

<Signature bind="sig" placeholder="Sign here" ref="sig"/>
<button title="Clear" on:tap="sig = []"                          disabled-if="sig.length == 0"/>
<button title="Undo"  on:tap="sig = sig.slice(0, sig.length - 1)"/>
```

Two methods (`clear`, `undo`) became zero API. What remains is an ordinary bound value the
author can persist, diff, seed in a test, or send to a server. A method survives this test
only when it changes something that is *not* state — starting a camera, opening a sheet — and
then it belongs to a module, on the bus.

**Then design the value.** The wire shape is the real contract, and it is the one decision the
port cannot revisit later. For the signature pad:

- RN packages hand back a base64 PNG (opaque, unreplayable, resolution-locked) or raw pixel
  paths (meaningless on a different-sized pad).
- DSX stores `[{ points: [[x, y], …], width }]` with x/y **normalized 0…1** and rounded at
  capture, so a phone capture replays unchanged on a 1024pt desktop pad and in SSR'd HTML.
- Image export is not part of the component at all: `ref` + `dsx.module.capture.element` is
  the primitive that already exists. **A port never grows its own encoder, cache, or event
  channel when a kernel primitive covers it.**

Write the commit law down too: the pad writes the store **once per stroke, on pointer-up**.
Live ink is view state. A port that writes per pointer-move has moved React's render loop into
the store, which is the performance bug you ported the library to escape.

## 4b. Ask what PRIMITIVE the port needs before you write the component

The most expensive mistake in a port is not getting a prop wrong. It is shipping four renderer
implementations of machinery that should have been one.

The test is mechanical: **write the port's per-renderer code in your head, and look for the part
that is identical in all four.** If every twin would hand-roll the same capture, the same
smoothing, the same coalescing floor, that is not the component's business — it is a kernel
primitive the framework is missing, and the component is the first consumer of it.

`<Signature>` is the worked example of getting this wrong first and right second. The pad landed
with four private implementations of an ink law; the framework already had `<canvas>` — a real
2-D surface on every renderer — and what it lacked was a way to DRAW on one, because gestures
reach an author as JSE actions and a drawing surface cannot route every pointer sample through
the store. So the primitive is `<ink>`: the committed drawing is ordinary tier-1 canvas
geometry, the in-flight stroke is native paint, and the store is written once per stroke. The
law moved into the kernel of each language, the corpus moved to `canvas/ink.json`, and the pad
became chrome around a primitive any author can now reach directly
(`<canvas><ink bind="drawing"/></canvas>` is a whiteboard, an annotation layer, a colouring
page). The ledger row is `runtime-pressure.md` R25.

The corollary is a rule about WHERE a port lands: a component that needs no new machinery is
markup (`<Swipe>` is 60 lines of `.dsx` — the pointer writes one number, a transform reads it).
A component that needs machinery lands as *primitive + thin component*, never as machinery
copied four times.

## 5. Contract first, then four twins

Fixtures first, or it does not ship (`/CLAUDE.md`). The order is not negotiable, because each
step is checked against the one before it:

1. **The fixture** — `OpenSource/Conformance/elements/<Tag>.json`: every attribute default,
   every hardcoded number, every semantic colour token, each with a `_src` line, plus the
   laws in `notes` (the value shape, the commit law, the ink law, the a11y position).
2. **The shared law** — the pure part goes in the kernel, once per language, never in a
   renderer: `@despia-native/kernel` `signature-core.ts` · `:core SignatureCore.kt` · the Swift
   `SignatureInk` enum inside the component. Decode, capture folds, the curve. Both Compose
   renderers and both web planes (DOM + SSR) then share one implementation of the maths, and
   the unit tests read the SAME fixture.
3. **Swift** — the reference renderer (`Components/Core/swift/<Tag>.swift`, a
   `GlobalStackComponent`). It compiles on the mac lanes; here it is parse-checked
   (`check_swift_parse.rb --changed`).
4. **Kotlin** — `:render` for Android and `:desktop` for Compose Desktop. Both compile and
   test locally; use that.
5. **Web** — the DOM factory in `packages/dom/src/globals.ts` (+ its CSS in
   `GLOBAL_ELEMENTS_CSS`) and the server twin in `packages/server/src/render.ts`. SSR is not
   optional: a static export that omits the element ships an inaccessible first paint.

The web twin has one extra obligation worth naming: the sheet may not improvise a design
constant (`design-system-gate.test.ts`). A `font-size: 15px` that the fixture pins as 15 is
still wrong — take the ratified rung (`var(--dsx-type-body-size)`) and let
`check_renderer_constants.rb` compare the rung's DEFINITION against the other renderers.

## 6. The ledgers: what a native element actually costs

A new catalogued element is a census in a dozen places, on purpose — the repo refuses to let a
tag exist that some renderer has never heard of. This is the complete list, in the order the
gates ask for it. **Run the gate, let it name the file, fix that file.** Do not try to
remember this list; it is here so you know the shape of the work before you start.

| Ledger | What it wants |
|---|---|
| `Conformance/elements/<Tag>.json` | the contract |
| `render/…/ElementSpec.kt` | `ElementDefaults` constants (alias the shared core) + a `register(ElementSpec(…))` row |
| `render/…/elements/StackElements.kt` | the registration call |
| `desktop/…/DesktopExtendedElements.kt` | the tag set, the `when` branch, the composable |
| `desktop/…/DesktopExtendedElementsTest.kt` | the tag-set assertion |
| `desktop/…/DesktopRemoteDsxView.kt` | the reserved-tag set (a remote folder may not shadow it) |
| `Web/packages/kernel/src/index.ts` | the shared core's exports (+ `support/public-api-v1.json`, regenerated) |
| `Web/packages/dom/src/globals.ts` | the factory, the CSS, the registry entry |
| `Web/packages/server/src/render.ts` | the SSR tag, its classes, its inner markup, its aria |
| `Web/support/element-support.json` | the row, its `webClass` (**every** class the renderer stamps), the summary counts |
| `Web/packages/dom/oracle/element-geometry-parity.ts` | a `CASES` fixture + one LEDGER entry per geometry key (`assert` with a probe, or `absent` with an owner) |
| `Web/packages/dom/test/element-geometry-parity.test.ts` | the asserted/absent census |
| `Web/packages/dom/test/element-colour-parity.test.ts` | the colour/geometry/fixture census |
| `scripts/generate_editor_catalog.rb` | a `CATEGORIES` and an `EXAMPLES` row → regenerate `stack-elements.json` |
| `scripts/generate_ui_qualification.rb` | `EXPECTED_ELEMENTS` |
| `scripts/generate_ui_qualification_fixtures.rb` | `ELEMENT_FIXTURE_VARIABLES` — a REAL seed, so the screenshot shows the control doing its job |
| `scripts/run_ui_qualification_test.rb` | the case census |
| `scripts/compose_desktop_release_guards_test.rb` + `release/compose-desktop-qualification.json` | the canonical-element census |
| `scripts/check_renderer_constants.rb` | one fact row per cross-renderer number |
| `Conformance/library/matrix.json` | regenerate (`generate_library_matrix.rb`) |
| `ClosedSource/CapabilityManifest.json` | regenerate (`generate_capability_manifest.rb`) |
| `Documentation/reference/StackReference.md` | the attribute table and the recipes |

A census that goes red is not paperwork: it is the repo telling you a renderer, a screenshot
lane or a published catalogue does not know about the thing you just shipped. **Name the
element that moved the number in the same commit that moves it.**

## 7. What NOT to port

Refusing is most of the value. For each of these, the answer is not "later" — it is "the
kernel already decided this, and shipping the RN shape would be a second opinion":

| The RN package | Why it does not port |
|---|---|
| Reanimated / Animated wrappers | motion is `enter`/`exit`/`transition` + the motion kernel; a JS animation library has nothing to add to a native renderer. NOTE the honest exception found by the PanelUI sweep: `Marquee` and `TextAnimation` are LOOPING and STAGGERED motion, and DSX has no primitive for either off the web (`@keyframes` parses and lints everywhere and executes only in a browser) - runtime-pressure R28. They are not ported yet, and shipping them web-only would be worse than the gap |
| gesture-handler wrappers, swipeables | universal `on:drag*` / `on:pinch` gestures, [custom-ux.md](custom-ux.md) |
| styling engines (Tailwind-for-RN, styled-components) | style attributes + DSX-CSS + the token plane; a class compiler at runtime is exactly the tax DSX removes |
| `SafeAreaView`, `KeyboardAvoidingView` | `<scaffold>` and the keyboard plane |
| navigation stacks | the router (`App.json entry.surfaces`) |
| `AsyncStorage`, `NetInfo`, `Clipboard`, `Linking` | shipped modules — check the manifest set first |
| `<WebView>`-based anything (signature pads, editors, charts) | the reason to port at all: implement the real surface |
| a component the Foundation library already ships | check `stack-elements.json` first; a second `Card` is a bug |

The honest way to say no to a whole library: run the gap analysis. List the package's exports,
diff them against `stack-elements.json` (`elements` + `components`), and port the remainder —
not the overlap. The worked example is
`ClosedSource/Documentation/audits/panelui-parity.md`: 118 modules, one table, four verdicts
(HAVE · HAVE-recipe · GAP-sized · blocked-and-named). Write the audit BEFORE the first
component; it is what stops a sweep from porting a `Card` that already ships and from calling
a blocked gap done.

## 7b. What a sweep of many components teaches that one port does not

Five things came out of shipping eighteen components in one wave. They cost real debugging
time and none of them is discoverable from lint:

- **Mount every component you write.** A markup component is JSE plus markup: nothing
  type-checks the head and no corpus pins it. `lint_dsx --strict` was 0/0 on all eighteen and
  a browser mount found five real bugs immediately — a formula called like a function, a
  `Number.isFinite` that silently returned null, a `<slider value=>` that is not an attribute,
  two components that accepted only a typed array where the repo convention is "JSON text or
  typed array". The harness is `packages/dom/oracle/components-browser.ts`; add a probe with
  your component rather than writing a new oracle.
- **A `<formula>` is a derived VALUE over named scope bindings, not a function the template
  calls with arguments.** Need the same fold twice, fold both in one `<variable>` and return
  an object.
- **A component boundary cannot forward a two-way binding**, so anything that looks bindable
  is `value` in / `on:change` out — and a control that must WRITE (a slider, a textarea) binds
  a LOCAL, re-seeded from the prop by `<watch value="dsx.attribute.x" immediate="true">`. That
  pattern is now used by `<ColorPicker>` and `<MarkdownEditor>`; copy it rather than inventing
  a third shape.
- **Take chrome, not the control.** `<InputGroup>` draws the border and the addons and takes
  the author's own `<textfield>` in its slot, which is the only shape that lets the caller keep
  `bind`. Reach for it whenever the RN component "wraps" an input.
- **When the runtime blocks you, size the fix before you dodge.** Two of the sweep's blockers
  were worth fixing on the spot (the `--scroll-*` fold learning `clamp()`/`min()`/`max()`,
  R26) and three were renderer workstreams (R27, R28, R29). Fix the small one, name the big
  ones in the ledger AND in the audit, and ship neither a handler-driven imitation nor a
  web-only one.

## 8. The recipe, condensed

```bash
# 0. what already exists — port the GAP, not the overlap
python3 -c "import json;d=json.load(open('OpenSource/Documentation/reference/stack-elements.json'));print(sorted(d['elements'])+sorted(d['components']))"

# 1. the contract
$EDITOR OpenSource/Conformance/elements/<Tag>.json

# 2. the shared law + its two unit suites (both read the fixture)
$EDITOR OpenSource/Web/packages/kernel/src/<tag>-core.ts
$EDITOR OpenSource/Engine/Android/core/src/main/kotlin/despia/engine/<Tag>Core.kt

# 3-5. the four twins, then the ledgers (§6) until every gate names nothing

cd OpenSource/Web && npm test && npm run typecheck
cd OpenSource/Engine/Android && gradle :core:test :render:test
gradle --settings-file settings-desktop.gradle.kts :desktop:test
ruby ClosedSource/scripts/check_module_rules.rb          # regenerates nothing; names every stale ledger
ruby ClosedSource/scripts/check_renderer_constants.rb    # the three sources must SAY the same numbers
ruby ClosedSource/scripts/check_swift_parse.rb --changed
ruby ClosedSource/scripts/lint_dsx.rb --strict && ruby ClosedSource/scripts/lint_dsx_css.rb --strict
ruby ClosedSource/scripts/prepare_modules.rb && ruby ClosedSource/scripts/prepare_modules.rb
```

## 9. Done-when

A port is finished when all of these are true, and not before:

1. The fixture exists and every renderer's constants are read from a shared source, not
   retyped.
2. Four renderers implement it: Swift (parse-clean here, compiled on the mac lanes), Compose
   Android, Compose Desktop, DOM + SSR.
3. `check_renderer_constants.rb` shows the element's numbers agreeing across all three
   sources, with any platform adaptation carrying a written reason.
4. Every census that moved names the element that moved it.
5. `StackReference.md` documents the attribute table AND the recipes that replaced the RN
   imperative API — the author looking for `clear()` must find the answer.
6. The element renders in the qualification fixtures with SEEDED data, so the screenshot lanes
   show it working rather than empty.
