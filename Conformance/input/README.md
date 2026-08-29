# Input conformance

Two families live in this directory.

**Pointer/desktop lifecycle** (landed earlier): `hover.json`, `shortcut.json`,
`focusOrder.json`, `tooltip.json` — the element-level input contracts.

**The G4 unified-input abstraction** (dsx-game.md §2 G4): `mappings.json`,
`axis.json` — ONE head declaration bound to keyboard, gamepad and touch on every
target — plus `attenuation.json`, the positional-audio fold.

---

## Pointer / desktop lifecycle

`hover.json` is the renderer-neutral state-machine contract behind
`on:hoverStart` / `on:hoverEnd`. Web, Kotlin, and Swift execute the same cases.

The adapter for each UI toolkit decides whether an incoming event represents a real
hover-capable pointer. Once accepted, the shared rules are deterministic: deduplicate
enter, retain pointer identity, fire one authored start/end pair across multiple active
pointers, and balance the pair on leave, cancellation, or unmount. Touch never enters.

`shortcut.json` is the renderer-neutral `shortcut=` accelerator-matching contract, and
`focusOrder.json` is the `focusOrder=` traversal-resolution contract. Web
(`@despia-native/dom` `matchShortcut` / `resolveFocusOrder`), Kotlin (`StackDesktopInput`), and Swift
(`StackDesktopInput`, executed by the record lane) run the same cases. `cmd` is the primary
modifier (matches meta OR ctrl); an unmodified shortcut never fires while an editable target
holds focus; a disabled control is always out of traversal (index -1). The web renderer binds
these directly; the native element-level key/focus wiring lands with the M1 desktop menus.

`tooltip.json` is the `tooltip=` / `tooltipSide=` universal-hint contract
(design-system.md Wave 3 (c)1): `resolve[]` pins the attribute fold (whitespace-only text
drops the tooltip; the side vocabulary is `top | bottom | leading | trailing`, exact
lowercase after trim, `top` the default and the fallback; a resolved tooltip ALWAYS
doubles as the element's accessibility description — content is never gated behind
hover), and `lifecycle[]` pins the show/dismiss machine over intent-qualified events
(hover intent and keyboard focus reveal ONLY from a hover-capable fine-pointer source;
touch is never tracked; pointer-out, blur, and Escape dismiss, with Escape suppressing
re-show until hover and focus have both cleared; no authored events). Web
(`@despia-native/dom` `resolveTooltip` / `TooltipLifecycle`, wired in `mount.ts` to a
`role="tooltip"` node + `aria-describedby` + the floating solver), Kotlin
(`StackTooltip` / `StackTooltipLifecycle`, :core), and Swift (`StackTooltip` /
`StackTooltipLifecycle`, the record lane) run the same file; the native RENDER adapters
consume the fold through the platform hint slots (`UIToolTipInteraction`/`.help`,
`TooltipCompat`/`tooltipText`), and where a touch platform has none, the degradation IS
the behavior (Article 7).

---

## The G4 laws — unified input

The whole authoring surface:

```xml
<head>
  <input as="jump" keys="Space ArrowUp" gamepad="A" touch="tap"/>
  <input as="move" keys="WASD" gamepad="leftStick" axis="true"/>
</head>
…
<scene on:input.jump="hero.jump()">…</scene>
<text value="{{ dsx.input.move.x }}"/>
```

`<input>` is a **head declaration** — a contract, like `<attribute>` / `<event>` — and the
head/body POSITION is the whole disambiguation from the form element of the same name
(see "The tag-name law" below). One declaration reaches iPhone, Android, web, desktop
keyboard, gamepad and touch, and is consumed two ways:

- as an **EVENT** — `on:input.<name>` on any element, through the standard gated handler
  path (`on:input.<name>.throttle` / `.debounce` work unchanged), fired on the press edge;
- as a **READ** — `dsx.input.<name>`, which folds to `global.input.<name>` in every
  runtime's `normalizeScope` (so it is an ordinary tracked, reactive store read — no new
  dispatch). A button reads a BOOLEAN (pressed); an `axis="true"` binding reads a DICT
  `{ x, y }`.

### 1 · The declaration

| attribute | meaning | default |
|---|---|---|
| `as` | the binding name (ASCII identifier, ≤ 64 chars) — REQUIRED | — |
| `keys` | space-separated key words / shorthand sets | none |
| `gamepad` | space-separated gamepad button words and/or stick words | none |
| `touch` | space-separated touch gesture words | none |
| `axis` | `"true"` makes this a 2D axis instead of a button | `false` |
| `deadzone` | analog stick deadzone, `0 ≤ d ≤ 0.9` | `0.15` |

Progressive disclosure is the point: `<input as="jump" keys="Space"/>` is the whole common
case; every other word is optional.

### 2 · The vocabulary (fixed, pinned by `mappings.json`)

**Keys** — `Space` · `ArrowUp` `ArrowDown` `ArrowLeft` `ArrowRight` · the letters `A`–`Z`
· the digits `0`–`9` · `Enter` `Escape` `Tab` `Shift` `Control` `Alt` `Meta` `Backspace`.
Matching is case-insensitive and a small alias set folds in: `up`/`down`/`left`/`right` →
the arrows, `return` → `Enter`, `esc` → `Escape`, `ctrl` → `Control`, `option` → `Alt`,
`cmd`/`command` → `Meta`.

**Key SETS** — a single word that expands to FOUR keys, in the pinned positional order
**[up, left, down, right]**:

| set | expands to |
|---|---|
| `WASD` | `W A S D` |
| `Arrows` | `ArrowUp ArrowLeft ArrowDown ArrowRight` |
| `ZQSD` | `Z Q S D` (AZERTY) |
| `IJKL` | `I J K L` (the second player's hand) |

**Gamepad buttons** — the W3C standard-mapping order, by name:
`A`(0) `B`(1) `X`(2) `Y`(3) `L`(4) `R`(5) `L2`(6) `R2`(7) `Select`(8) `Start`(9)
`LStick`(10) `RStick`(11) `DPadUp`(12) `DPadDown`(13) `DPadLeft`(14) `DPadRight`(15).
Aliases: `l1`/`lb` → `L`, `r1`/`rb` → `R`, `lt` → `L2`, `rt` → `R2`, `back` → `Select`,
`l3` → `LStick`, `r3` → `RStick`.

**Gamepad sticks** — `leftStick` (axes 0,1) · `rightStick` (axes 2,3). Sticks are
AXIS-ONLY.

**Touch** — `tap` · `hold` · `swipeLeft` · `swipeRight` · `swipeUp` · `swipeDown`.
Touch words are BUTTON-only. `tap` and the four swipes are MOMENTARY (pressed for exactly
the frame they arrive in); `hold` is SUSTAINED (a down/up pair).

### 3 · Resolution and the Article-7 diagnostics

Every unrecognized word is DROPPED with exactly ONE diagnostic; the rest of the binding
survives — a typo never costs a whole control scheme. Duplicate words inside one leg dedupe
silently (first occurrence wins, which matters because axis position is ordinal).

| code | when |
|---|---|
| `input-as` | `as` missing, blank, or not an identifier → the declaration is dropped |
| `input-duplicate` | a second `<input>` with the same `as` → the later one is dropped |
| `input-axis` | `axis` is neither `"true"` nor `"false"` → treated as `false` |
| `input-deadzone` | `deadzone` unparseable or outside `[0, 0.9]` → falls back to `0.15` |
| `input-key` | an unknown word in `keys` |
| `input-gamepad` | an unknown word in `gamepad` |
| `input-touch` | an unknown word in `touch` |
| `input-axis-keys` | `axis="true"` whose `keys` resolve to a count other than 0 or 4 → the keys leg is dropped |
| `input-axis-buttons` | `axis="true"` whose gamepad BUTTONS are a count other than 0 or 4 → the buttons leg is dropped |
| `input-touch-axis` | `touch` on an `axis="true"` binding → the touch leg is dropped |
| `input-stick-button` | a stick word on a BUTTON binding → the stick leg is dropped |

An axis binding's four keys (and its four gamepad buttons, when declared) are read
POSITIONALLY as `[up, left, down, right]` — which is exactly why the sets expand in that
order and why the resolver never sorts.

### 4 · The axis fold (`axis.json` → `digital` / `analog` / `combined`)

**Digital** — from the four booleans, with **+x RIGHT and +y UP**:

```
x = (right ? 1 : 0) − (left ? 1 : 0)
y = (up    ? 1 : 0) − (down ? 1 : 0)
if |(x,y)| > 1 → divide by |(x,y)|          # a diagonal normalizes to length 1
```

Opposing keys cancel to 0; a diagonal is `±0.707107`, never `±1` — a keyboard player is
never faster on the diagonal.

**Analog** — a raw stick pair. Raw gamepad Y is DOWN-positive on every platform, so the
fold NEGATES it (`y = −rawY`) and the DSX convention (+y up) holds everywhere. The deadzone
is applied RADIALLY and then rescaled, so the live range stays a full `0..1`:

```
x, y = rawX, −rawY
len   = √(x² + y²)
if len ≤ dz              → (0, 0)
clamped = min(len, 1)
scale   = ((clamped − dz) / (1 − dz)) / len
→ (x·scale, y·scale)                         # |result| ∈ [0, 1], never above 1
```

**Combining** — a binding may declare keys, dpad buttons AND a stick at once:

1. an analog stick whose POST-DEADZONE magnitude is non-zero WINS (declaration order picks
   among several sticks);
2. otherwise the digital fold runs over the UNION of the keys and the declared dpad
   buttons, per direction.

### 5 · The edge law (`axis.json` → `frames`)

The state machine folds raw device events into per-frame state:

- an **event fires ONCE on the transition to pressed** — never per frame while held, and
  never on release (release edges are a named absence);
- a **read returns the live state** every frame;
- "pressed" for an axis binding means a non-zero vector, and the event payload carries the
  vector (`{ name, x, y }`; a button's `x`/`y` are `0`);
- a key released and re-pressed WITHIN one frame is invisible (the frame-committed state is
  what the law sees);
- a momentary touch word is pressed for exactly the frame it arrived in and clears on
  commit; `hold` stays pressed until its release;
- events are emitted in DECLARATION order.

### 6 · The tag-name law (head vs body)

`input` is already a builtin BODY tag (the form element) in
`Conformance/lint/facts.json` `builtinTags`, and it stays one. The game word is
disambiguated by POSITION — the same mechanism both linters already use to tell a
declaration from markup:

- `input` gains a `headRank` entry (rank 2, shared with `event` — the interface-contract
  group, exactly as `api` and `variable` already share rank 3), so `<input>` inside `<head>`
  is a legal declaration instead of a head-purity warning;
- `input` is deliberately NOT added to `declTags`, so a `<input>` in the BODY keeps its form
  meaning with no `decl-outside-head` warning;
- `input` is deliberately NOT added to `identifierTags` (that table is unconditional); the
  `as=` requirement is a positional rule in each runner: an `<input>` **in the head** without
  `as=` is the standard `missing-as` error.

### 7 · The runner ledger

| runner | file |
|---|---|
| TS (per-PR, `npm run conformance`) | `packages/kernel/test/input-conformance.test.ts` → `packages/kernel/src/input.ts` |
| Kotlin (`:core`, `gradle test`) | `core/src/test/kotlin/despia/engine/input/InputConformanceTest.kt` → `core/src/main/kotlin/despia/engine/input/SceneInput.kt` |
| Swift (record lane, compile-pending) | `ClosedSource/scripts/conformance/RecordMain.swift` → `InputConformance` in `ConformanceHosts.swift` → `OpenSource/Engine/iOS/SceneInput.swift` |

Each runner also asserts the kernel CONSTANTS (`deadzone 0.15`, the button index table, the
set expansions) against the corpus tables, and the `scope` rows against its own
`JSE.normalizeScope`.

Case counts: `mappings.json` 31 declaration cases + 3 scope rows;
`axis.json` 13 digital + 14 analog + 7 combined + 4 streams / 27 frames;
`attenuation.json` 14 cases. **69 corpus cases**, on three kernels.

---

## The G4 laws — positional audio attenuation

`attenuation.json` pins the FOLD only — pure math in the shared kernel, no platform audio
API. A listener position, a source position and three knobs give `{ distance, gain, pan }`:

```
d       = |source − listener|
clamped = min(max(d, ref), max)
gain    = ref / (ref + rolloff · (clamped − ref))       # the clamped inverse-distance law
pan     = d == 0 ? 0 : clamp((source.x − listener.x) / d, −1, 1)
```

Defaults `ref = 1`, `max = 50`, `rolloff = 1`. The curve is deliberately the Web Audio
`inverse` panner model, so a web renderer can hand the folded numbers straight to a
`PannerNode` and a native renderer can drive its own mixer with identical values.

Playback is NOT part of this rung: `dsx.module.audio.*` plays SFX and music
UNATTENUATED, and wiring the fold into per-platform 3D playback is the named absence
(dsx-game.md, the G4 landing record).
