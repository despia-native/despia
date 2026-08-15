# DSX Game — the engine-under-AI program

> **RATIFIED 2026-08-07 (product owner).** The target, in the owner's accepted
> framing: "Unity/Godot-level game engine underneath, but an AI-first IDE on
> top so normal people never have to learn game-engine complexity." The
> positioning: **"Don't learn a game engine. Tell Despia what game you want."**
> The engine exists so the AI can hide it. This document is the ratified
> roadmap; it extends dsx-scene.md (P1–P5 landed/in-flight) and is judged by
> the same laws: corpus-first, three renderers, no silent gaps, progressive
> disclosure — simple markup for the 90%, advanced control exposed only when
> asked for.

## 0 · The abstraction law (what keeps this from becoming "Unity in XML")

The winning shape is DECLARATIVE DEFAULTS WITH PROGRESSIVE EXPOSURE:

```xml
<model src="player.glb" physics="character" collider="auto"
       gravity="true" on:collision="hit"/>
```

is the whole API for the common case. Every advanced knob (collision layers,
masses, friction, animation blending weights) exists but is NEVER required.
A feature that cannot be expressed as a one-attribute default with optional
depth does not ship in that form.

## 1 · Reconciliation — what the roadmap already has

| Roadmap item | State |
|---|---|
| Scene graph, rendering, transforms, events, reactive state, frame loop | ✅ landed (dsx-scene P1–P2, four renderers, corpus-pinned) |
| Models (GLB embedded), textures, text3d, on:frame | ✅ landed web+JVM (P4); Swift P4 in flight |
| AR (ARKit path, module law) | ✅ landed compile-pending (P3); device-qualified pending |
| Animations (implicit transitions, tweens, easing corpus), data-driven spawning (`bind`/`key` groups), collisions v1 (overlap + on:collide), orbit controls, point lights/fog | ✅ landed (P5, all three renderers) |
| Physics (G2: fixed 60 Hz tick, static/dynamic/kinematic/character bodies, triggers, layers, sleep, the own portable solver) | ✅ landed 2026-08-07 on all four renderers (web reference + corpus `Conformance/scene/physics.json`, then the JVM twins gradle-tested + SceneKit compile-pending the same day — the G2 landing record below) |
| Skeletal GLB (G3: skins → named clips → clip sampling → crossfade blending, `<model animation loop blend>`) | ✅ landed 2026-08-08 (corpus `Conformance/scene/skin.json` on all THREE kernels in the same wave; web + both JVM elements wired, SceneKit compile-pending — the G3 landing record below) |
| Unified input + the audio recipe (G4: one head `<input>` → keyboard · gamepad · touch, consumed as `on:input.<name>` or read as `dsx.input.<name>`; the positional-audio attenuation fold) | ✅ landed 2026-08-08 (NEW corpus `Conformance/input/{mappings,axis,attenuation}.json` on all THREE kernels the same day; web wired + REAL-browser proven, Compose key/handler wiring gradle-green, UIKit/GameController compile-pending — the G4 landing record below) |
| The `scene` bus surface (G5 wave 1: nodes · set · camera/flyTo · capture · pick · contacts · stats + scene.ready/scene.collide on the bus, MCP-opted-in) | ✅ landed 2026-08-07 (web + both JVM lanes tested; Swift compile-pending) — dsx-scene.md §9 |
| Prefabs/entities/behaviors (G1: components instantiate inside `<scene>` subtrees — expansion, transform inheritance, per-instance scope, keyed spawn/despawn) | ✅ landed 2026-08-08 (corpus `Conformance/scene/prefab.json` on all THREE kernels + all four renderer elements in one wave; SceneKit compile-pending — the G1 landing record below) |
| The 2D engine (G6: `<sprite>`, sprite sheets + `frame`/`fps` animation, the 2D conventions — +Y up, z as the draw order, a 2-number `position` — and 2D physics as a Z-LOCK over the ONE existing solver) | ✅ landed 2026-08-08 (corpus `Conformance/scene/sprite.json` on all THREE kernels in the same wave; the web WebGL renderer + the shared JVM rasterizer wired and browser/gradle-verified, SceneKit compile-pending — the G6 landing record below) |

## 2 · The P0 ladder (this program's build order)

### G1 — Entities, prefabs, behaviors: REUSE, don't invent

The analysis asks for prefabs/entities/behaviors. The constitutional answer:
DSX ALREADY has the reusable-unit primitive — `<component>` — and P5 already
adds keyed spawning (`<group bind key>`). Therefore:
- A **prefab IS a component** whose root is scene content: declared once,
  instantiated by tag, parameterized by attributes — no second concept.
- **Spawning IS data**: push a row into an array, the bound group instantiates
  the prefab; remove the row, it despawns (animations/physics cleaned up).
- A **behavior IS a component's head** (its variables/actions/watches/on:frame
  logic) traveling with the prefab. A shared behavior library is a package of
  components — distribution already exists.
- The G1 work is therefore INTEGRATION, not invention: components must
  instantiate inside `<scene>` subtrees with scene-node semantics (transform
  inheritance, per-instance state, lifecycle on:appear/on:remove), corpus-gated.

**G1 LANDED 2026-08-08 — corpus-first on all three kernels + all four renderer
elements in one wave:**

- **The shape found**: component expansion did NOT reach scene subtrees on any
  renderer — every scene parser skipped a component tag as `unknown-tag`
  (Article 7). The chosen cut: expansion happens INSIDE `parseScene` through a
  **lookup seam** (`tag → def | null`) each renderer's `<scene>` element wires
  from its OWN existing component registry (web `resolveComponent` — the same
  resolution `mountComponent` uses; desktop the component table; iOS
  `StackComponents.resolve`) — the kernel never learns a component name
  (rule 18), and non-scene components keep their standing meaning everywhere
  else. No lint change was needed: a declared component tag was already a
  known identifier to both linters.
- **The corpus**: `OpenSource/Conformance/scene/prefab.json` — 12 cases
  (expansion, pinned cross-boundary world matrices, parameterization with
  template-derived AND declared params, multi-root implicit group,
  per-instance scope isolation, scope-first vs outer-plane resolution, nested
  prefabs, composed scaled transforms, the `prefab-not-scene` and
  `prefab-depth` diagnostics, the keyed spawn/despawn leg), every number from
  an independent scratch derivation. The laws live in the corpus README
  ("The G1 laws"): expansion-root · scope · scene-content gate · depth 8 ·
  definition · instantiation.
- **The kernels**: TS `packages/kernel/src/scene/ir.ts`
  (`scenePrefabDefFromTemplate` · `parseScene(markup, diag, prefabs)` ·
  `scenePrefabResolver` + the `ScenePrefabRef` stamp on expansion roots),
  the Kotlin twins in `SceneIR.kt`/`SceneBind.kt` (+ `ScenePrefabItems`, the
  live item plane), the Swift twins in `SceneIR.swift`/`SceneBind.swift`;
  `instantiateSceneRow` preserves the prefab stamp so a spawned row IS a
  fresh prefab instance sharing the raw scope.
- **The wiring**: per-instance scopes ride the EXISTING item plane on every
  renderer — web a per-instance subCtx whose `item` is the reactive scope
  dict (the bound-row machinery), JVM `ScenePrefabItems.itemFor` (innermost
  of prefab scope and row scope), iOS the `prefabChains` twin on the
  CADisplayLink element — so handlers, binds, animations and physics inside a
  prefab body resolve per instance with zero new concepts.
- **Evidence**: scene-conformance 169/169 on TS and Kotlin (15 prefab lanes
  each); web suite green + typecheck clean; gradle :core/:render/
  :desktop/:platform fully green; Swift compile-pending
  (`SceneConformance` runs all fourteen files in the record lane).
- **The review wave (same day)**: a max-effort adversarial review of the
  landing surfaced seven findings; all seven landed as fixes with three new
  corpus cases: (1) a LIVE instance-scope change now reaches already-spawned
  bind rows on web+JVM (the web rows chain to their parent refresh plane;
  the JVM reconciler restamps on scope change — iOS already restamped per
  pass), dom-tested; (2) a bare scene root carrying its `<head>` scans
  params and strips declarations on all three kernels (the bare-root head
  law); (3) nested tags in a prefab body resolve in the component's OWNING
  scope (`ScenePrefabDef.lookup`, the defining-scope law — web per-scheme
  lookups, Compose per-owning-scope, iOS `StackComponents` scope chain;
  the desktop flat table is the law's flat-registry case); (4) resolved
  instance scopes cache per render pass on JVM+iOS instead of re-deriving
  per attribute read; (5) the iOS scheduled-kind scan expands prefabs with
  the same lookup as the coordinator, so anchors inside prefab bodies reach
  the honest label; (6) `bind`/`key`/`on:*` on an instance tag speak ONE
  `prefab-ignored` diagnostic instead of dropping silently; (7) the dead
  `hasPrefabs()` probe was removed.
- **NAMED ABSENCES**: lifecycle `on:appear`/`on:remove` events on instances
  (spawn/despawn is observable through the bound array today; dedicated
  events are the next slice) · `on:*` handlers directly on an instance tag
  (diagnosed, not wired — handlers live inside the body) · slot content
  inside scene prefabs · a component's OWN `<watch>`/`on:frame` head logic
  firing per scene instance (behaviors run today through the standard head
  machinery when the component also mounts as UI; the scene-side
  per-instance handler plane covers `on:*` markup) · editor-side prefab
  overrides (IDE wave).

### G2 — Physics: fixed tick, bodies, the stupidly-simple surface

```xml
<scene gravity="0 -9.81 0" on:tick="…">
  <box physics="static" size="20 1 20"/>
  <sphere physics="dynamic" mass="1" position="0 10 0" on:collision="hit"/>
  <model physics="character" speed="5" jump="8" src="hero.glb"/>
</scene>
```
- **The fixed-tick law**: physics steps at a fixed rate (default 60 Hz)
  DECOUPLED from rendering; rendering interpolates between steps. `on:tick`
  is the fixed-rate handler (simulation), `on:frame` stays render-rate
  (presentation). Corpus: stepping determinism — same inputs, same states,
  to 6 decimals, on every runner.
- Body kinds: `static · dynamic · kinematic · character` (character =
  move-and-slide, the 90% of player controllers). Triggers: `trigger="true"`
  → on:enter/on:exit, no forces. Colliders default `auto` (shape-derived,
  model AABB); explicit `collider="sphere|box|capsule"` when needed. Layers/
  masks exist but default to "everything collides" (progressive exposure).
- Verbs on the handle: impulse/velocity writes as attribute-shaped state
  (`velocity="0 5 0"`), raycast via the scene bus module.
- Implementation: OWN portable solver in the shared math kernel (the
  rasterizer precedent — 1:1 by construction, CI-determinism-tested); a
  platform physics middleware is a NAMED later upgrade only if profiling
  demands it.

**G2 LANDED 2026-08-07 — web reference + corpus**, and the JVM/Swift twins
landed FROM this corpus the same day (ScenePhysics.kt gradle-tested on both JVM
lanes · ScenePhysics.swift + the SceneConformance physics leg compile-pending —
the reconciliation row above carries the four-renderer state):

- **The corpus**: `OpenSource/Conformance/scene/physics.json` — 30 cases
  (9 extraction worlds, 16 simulations incl. the 120-tick determinism replay,
  the stationary-kinematic sleep case and the spaced-ids trigger case,
  3 accumulator folds, 2 interpolations), every number from an independent
  scratch implementation, every law + constant pinned in the file's `_note`
  and the corpus README "The G2 laws" section (fixed tick 1/60 · 5-step cap ·
  Baumgarte 0.8/0.005 · restitution guard 0.5 · ground normal 0.7 · sleep
  0.05/60 · slide iterations 4 · defaults mass 1/bounce 0/friction 0.5/
  speed 5/jump 8). The TS runner asserts the constants against the kernel
  exports, and the replay case demands a BIT-identical second run.
- **The kernel**: `packages/kernel/src/scene/physics.ts` — extraction
  (`physics/collider/mass/bounce/friction/trigger/layer/collides/speed/jump`
  props + `gravity` on `<scene>`, Article-7 diagnostics; collider extents
  FREEZE from the authored transform), the own portable solver (semi-implicit
  Euler, the P5 contact depths + pinned normals, restitution/friction
  impulses, positional correction, character move-and-slide with grounded
  detection, triggers, layers, sleep/wake), the accumulator and the
  interpolation helper. Solver math uses sqrt-of-squares only (never hypot) so
  IEEE doubles agree across runtimes.
- **The web wiring** (`packages/dom/src/scene.ts`): the fixed-tick accumulator
  inside the ONE existing rAF loop — **the loop-existence law extended**: the
  loop also runs while any dynamic body is awake or a character exists, and a
  fully-asleep world stops it (with `on:tick`). Solver-owned positions ride
  the P5 override plane INTERPOLATED; a base `position` write teleports
  (velocity reset), a `velocity` write is the impulse verb — both on the same
  plane the bus `set` writes (jump() IS `set velocity "0 <jump> 0"`; the
  `move` intent is attribute-shaped state read each step).
  `on:tick`/`on:collision`/`on:enter`/`on:exit` dispatch through the standard
  runner path; `grounded`/`sleeping`/`velocity` ride the bus `nodes()` read.
- **Evidence**: the shared scene corpus includes a floor-plus-three-box stack
  whose supporters all sleep identically in TS, Kotlin, and Swift; the screenshot
  walk's G2 leg — the demo ball RESTS at the corpus-pinned height projected to
  screen (regional centroid check), launches on the bus impulse verb,
  re-settles, and the tick counter advances awake / stops asleep with
  tick totals matching the scratch implementation exactly.
- **NAMED ABSENCES**: rotation dynamics (colliders translate only; orientation
  stays authored/animated) · capsule colliders · character↔character
  interaction · a sleep island graph (a kinematic write wakes the world) ·
  raycast on the bus (the G5 slice) · platform physics middleware
  (profiling-gated upgrade, per the bullet above).

### G3 — The GLB pipeline completed

Model textures → skeletal animation → named clips → crossfade blending:
```xml
<model src="robot.glb" animation="{{ state }}" loop="true" blend="200ms"/>
```
Corpus: skinning math (joint matrices × weights, pinned vertices), clip
sampling, blend weights. External buffers + basis/texture-compression ride
the content plane. Import CONFIGURATION stays out until the IDE wave.

**G3 LANDED 2026-08-08 — the skeletal wave, corpus-first on all three kernels
in the SAME commit** (the markup above is the WHOLE common-case API — the §0
abstraction law holds: one reactive attribute, two optional knobs):

- **The corpus**: `OpenSource/Conformance/scene/skin.json` — 20 cases + the
  constants gate (2 GLB parse extractions over two hand-built base64 fixtures,
  2 joint-matrix hierarchies, 2 vertex-skinning batteries, 6 clip-sampling
  channels, 2 crossfade folds, 3 mixer folds, 3 prop-grammar cases), every
  number from an independent scratch implementation, every law + constant
  pinned in the file's `_note` and the corpus README "The G3 laws" section
  (slerp nlerp threshold 0.9995 · weight epsilon 1e-6 · default blend 0 =
  hard cut · default loop true). Each runner asserts the constants against
  its kernel's exports; the fixture byte layouts are documented in the README.
- **The kernels** — all three in the same wave (the twins ordering collapsed:
  the corpus is small enough to land 1:1 at once): TS
  `packages/kernel/src/scene/skin.ts` + the `gltf.ts` parse extension (skins/
  clips/JOINTS_0/WEIGHTS_0 + the retained node forest, per-draw node+skin);
  Kotlin `core/…/scene/SceneSkin.kt` + `SceneGltf.kt`; Swift `SceneSkin.swift`
  + `SceneGltf.swift` (compile-pending). The laws: jointMatrix =
  inverse(meshNodeWorld) · jointWorld · IBM; skinnedPos = Σ w·M·pos with
  weight renormalization (≤ε passes through); interval-search sampling with
  shortest-path slerp (dot-sign flip, nlerp past 0.9995) and STEP left-hold;
  wrap-by-loop; the crossfade ramp + per-node TRS blend; and the MIXER state
  machine (initial hard cut · one fade at a time · mid-fade switch drops the
  older fade · unknown name diagnoses `unknown-clip` + keeps · "" = bind).
  `<model animation loop blend>` joined `resolvedProps` on all three IRs
  (no new tags — the lint facts are untouched).
- **The wiring** — web (`packages/dom/src/scene.ts`): the mixer per
  `<model animation>` node advanced inside render, pose-aware GLB node worlds
  (animated transforms move unskinned draws too), CPU-skinned positions
  re-uploaded into per-draw dynamic buffers feeding the existing draw path
  (flat facet normals); JVM (the ONE shared rasterizer): `SceneAssets.pose`
  seam + skinning BEFORE raster in `SceneRaster.kt`, the shared :core
  `SceneClipMixers` bundle advanced from the raster path in BOTH elements
  (pose-less path byte-identical to P4 — `SceneRasterTest` pins bind ==
  static and a posed joint moving the silhouette); iOS (`SceneElement.swift`,
  compile-pending): manual per-frame sampling on the existing CADisplayLink —
  the P5 evaluator pattern, never a CAAnimation — updating draw-child
  transforms and rebuilding skinned SCNGeometry per emitted tick.
  **The loop-existence law extended again** on all three surfaces: the one
  frame loop also runs while any model has an active clip or crossfade
  (`mixer.active`); a finished non-looping clip with no crossfade lets it stop.
- **Evidence**: TS scene-conformance 154/154 (21 skin lanes — the exact case
  count the Kotlin wave runs); web suite green + typecheck clean (embeds
  untouched — the kernel additions ride the boot-only scene chunk); Kotlin
  `:core` SceneConformanceTest 154 incl. the skin wave + the two new
  SceneRasterTest skinning pixels; Swift rides the record lane
  (`SkinConformance` in RecordMain, balance 0/0/0 on every touched file).
- **NAMED ABSENCES**: CUBICSPLINE interpolation (channels drop at parse) ·
  morph targets / weights channels (drop at parse) · model TEXTURES through
  glTF images (the P4 absence stands — flat baseColor is the material) ·
  external buffers + basis/texture compression (the content-plane ride, per
  the rung text) · animation EVENTS (no per-keyframe callbacks) · IK ·
  skinned-mesh picking/colliders (bounding volumes stay bind-pose) · GPU
  skinning (the named perf upgrade — CPU skinning is the corpus-honest v1 on
  every lane) · additive/partial-body blending (one mixer, whole-pose
  crossfades).

### G4 — Audio + unified input

- Audio: the existing Core/Audio module gains the scene-facing recipe now
  (SFX/music/volume/loop via `dsx.module.audio.*` from any handler);
  positional/spatial audio is the G4 engine half (distance attenuation from
  the corpus-pinned world positions).
- Unified input — the cross-device abstraction DSX is uniquely placed to own:
```xml
<input as="jump" keys="Space" gamepad="A" touch="tap"/>
```
  declared in the head, consumed as `on:input.jump` or read as
  `dsx.input.jump` (pressed/axis). One declaration → iPhone, Android, web,
  desktop keyboard, gamepad, touch. Corpus: mapping tables + axis math.

**G4 LANDED 2026-08-08 — corpus-first on all three kernels in one wave, and
PROVEN in a real browser on the real app page** (the markup above is the WHOLE
common case — `<input as="jump" keys="Space"/>` is a complete declaration; the
§0 abstraction law holds: `gamepad`/`touch`/`axis`/`deadzone` are optional):

- **The shape found — POSITION is the disambiguation.** `input` was already a
  BODY builtin (the form element; the `textfield` alias on both native lanes),
  and it stays one. The head-declared game word coexists by the mechanism both
  linters already use to tell a declaration from markup: `input` gains a
  `headRank` entry (rank 2, shared with `event` — the interface-contract group,
  exactly as `api` and `variable` already share rank 3) and is deliberately
  ABSENT from `declTags` (so a body `<input>` never earns `decl-outside-head`)
  and from `identifierTags` (that table is unconditional). The `as=` discipline
  is therefore POSITIONAL — a head `<input>` without `as=` is the standard
  `missing-as` error — one small rule added to each of the two runners. Every
  renderer filters the head's `<input>` children out of the rendered head, so
  the body tag's meaning is untouched on all three.
- **The consumption is the EXISTING two planes, not new ones**: `on:input.<name>`
  rides the standard gated handler path (`.throttle`/`.debounce` keep working
  because `runHandler` owns the gate), and `dsx.input.<name>` folds to
  `global.input.<name>` in every runtime's `JSE.normalizeScope` — an ordinary
  tracked, reactive store read, no new dispatch. A button reads a BOOLEAN, an
  `axis="true"` binding a `{ x, y }` dict.
- **The corpus**: `OpenSource/Conformance/input/` gains three files —
  `mappings.json` (31 declaration cases + 3 scope rows: the key/gamepad/touch
  vocabularies, the WASD/Arrows/ZQSD/IJKL positional set expansion, alias
  folding, dedupe, and ELEVEN Article-7 diagnostics each dropping one word and
  keeping the rest of the binding), `axis.json` (13 digital folds + 14 analog
  deadzone folds + 7 combined-leg cases + 4 pinned device-event streams over 27
  frames), `attenuation.json` (14 audio cases). **69 corpus cases**, every
  number from an independent scratch implementation, every law written out in
  the corpus README ("The G4 laws"): the fixed vocabulary, the positional
  `[up, left, down, right]` set order, the digital fold with diagonals
  normalized to 0.707107, the RADIAL deadzone applied then rescaled so the live
  range stays 0..1 (raw pad Y is DOWN-positive and is negated once, in the
  fold), analog-beats-digital, and the EDGE law (one event on the transition to
  pressed, never per frame; a momentary touch word lives exactly one frame).
  Each runner also asserts the kernel CONSTANTS and the `dsx.input` scope fold
  against the corpus.
- **The kernels** — all three in the same wave: TS
  `packages/kernel/src/input.ts` (`resolveInputDeclarations` ·
  `inputDigitalAxis` · `inputAnalogAxis` · `InputMachine` ·
  `sceneAudioAttenuation`), Kotlin
  `core/…/input/SceneInput.kt` + `DsxInputRuntime.kt`, Swift
  `OpenSource/Engine/iOS/SceneInput.swift` + `StackInputHost.swift`
  (compile-pending). Solver math is sqrt-of-squares only (never `hypot`) — the
  G2 precedent, so IEEE doubles agree across runtimes.
- **The wiring**: web `packages/dom/src/input.ts` binds real `keydown`/`keyup`
  (layout-INDEPENDENT: `event.code` wins for letters/digits, so WASD stays under
  the same fingers on AZERTY), the Gamepad API, and pointer gestures
  (tap/hold/four swipes at shared thresholds); `mount.ts` registers the head
  declarations before the body mounts and `wireCommon` subscribes any element's
  `on:input.*`. Compose: `StackNodeView`'s head branch registers and filters,
  `SceneElements` binds `onKeyEvent` (hardware keys AND gamepad buttons) plus
  the `on:input.<name>` handler subscription. iOS: `StackHead.hoist` registers,
  `StackInputResponderView` turns `pressesBegan/Ended` HID usages into canonical
  words, and the scene element subscribes handlers + polls GameController.
  **THE LOOP-EXISTENCE LAW, APPLIED TO INPUT**: keyboard and touch commit on the
  EVENT EDGE and never spin a loop; only the gamepad is polled, and it is polled
  INSIDE THE LOOP THAT ALREADY EXISTS (one line in the web rAF and one in the
  iOS CADisplayLink). The web runtime's own gated rAF exists only when no
  external loop is driving AND a pad is connected — because input is not
  scene-scoped (a page may declare `<input>` and never mount a scene).
- **Sliceability**: the whole input runtime is a `__DSX_OPTIONAL_INPUT__`
  feature — an embed that declares no `<input>` and authors no `on:input.<name>`
  folds it out entirely (`registryUsesDeclaredInput`). Landing it that way also
  brought `<demo-embedcard>` back UNDER the 40KB G10 widget budget (38.5KB gz).
- **Audio**: the scene-facing RECIPE is documented on the module itself
  (`Core/Audio/README.md`, "The scene / game recipe") — any handler, including
  an input edge, calls `dsx.module.audio.{setqueue,play,pause,playat,speed}`;
  nothing about a scene is special and the call is fail-open when the module is
  excluded. The positional half landed as a corpus-pinned PURE FOLD on all three
  kernels: `sceneAudioAttenuation` → `{ distance, gain, pan }`, the clamped
  inverse-distance law `ref / (ref + rolloff·(clamp(d, ref, max) − ref))` with
  defaults 1 / 50 / 1 — deliberately the Web Audio `inverse` panner model, so
  the numbers hand straight to a `PannerNode` or a native mixer.
- **Evidence**: TS input-conformance **87/87** (the exact case count the Kotlin
  runner executes: `:core InputConformanceTest` **87/87**, gradle-green); the
  web suite and `typecheck` clean; `lint_dsx --strict` 0/0, `lint_dsx_css
  --strict` 0/0, `check_module_rules` and `lint_conformance` green; Swift rides
  the record lane (`InputConformance` in `RecordMain`, balance delta 0 on every
  touched file). **The REAL-browser proof** (`packages/dom/oracle/input-browser.ts`,
  `npm run browser:input`): 13/13 checks on the shipped `/game` page —
  both head declarations resolved with zero diagnostics, the resting reads typed
  (`false` / `{0,0}`, never null), a real `page.keyboard.press("Space")` firing
  `on:input.jump` (the ball state moved through the scene bus), `page.keyboard
  .down("KeyD")` reading `{1, 0}`, W+D reading the pinned `0.707107` diagonal,
  release returning to `{0,0}`, a 600 ms hold firing the move edge EXACTLY ONCE
  (cannon −1.850 → −1.500, one `steer()` of +0.35 over ~36 frames), and a
  synthesized stick beating the held key at the pinned `0.4634517` rescale.
- **NAMED ABSENCES**: REBINDABLE-AT-RUNTIME mappings (a declaration is static —
  there is no `dsx.input.rebind(...)`, and a settings screen cannot yet remap a
  control) · HAPTICS ON INPUT (an input edge does not auto-fire
  `dsx.module.haptic`; a handler must call it) · MULTI-PLAYER LOCAL INPUT
  ROUTING (pad 0 only — bindings are app-global, so two controllers drive the
  same names) · RELEASE EDGES (`on:input.<name>` fires on press only; the
  release is observable through the `dsx.input.<name>` read) · an ON-SCREEN
  VIRTUAL JOYSTICK (touch words are BUTTON-only by law — `touch` on an
  `axis="true"` binding is diagnosed `input-touch-axis`, so mobile axis control
  needs a gamepad today) · ANDROID ANALOG STICKS (joystick axes ride
  `MotionEvent`, which the Compose element does not surface — pad BUTTONS work
  through the key path) · POSITIONAL-AUDIO PLAYBACK (the fold is pinned and
  shipped on three kernels; nothing plays it back — `dsx.module.audio.*` is
  unattenuated 2D, and the `PannerNode` / `AVAudioEnvironmentNode` /
  spatializer wiring is the next slice) · per-binding input CAPTURE/priority
  (a declared key is preventDefault-ed app-wide while any surface declares it).

### G5 — AI eyes and hands (the killer loop)

The AI must RUN, SEE, PLAY, and DEBUG the game it wrote. The substrate is
already constitutional: everything is a module on the bus, and Core/MCP
exposes modules to agents. G5 ships the `scene`/`game` bus surface as MCP-
reachable tools:
- inspect/modify: node queries, live attribute writes, spawn/despawn
- run/pause/step; `input.synthesize` (tap/drag/key/gamepad events through
  the REAL input path)
- `camera.capture` (the screenshot walk's machinery, exposed); logs/errors
  (the ledgers already exist); `physics.collisions` (the ledger of recent
  contacts); `profiler.*` (the §3 profiler rung's counters)
The loop this buys: build → run → press the controls → look at frames →
read diagnostics → fix → re-run. That loop is the product.

**G5 wave 1 LANDED 2026-08-07 — the `dsx.module.scene` bus surface**
(dsx-scene.md §9 carries the landing record): Core/Scene owns scheme `scene`
(the former flat Core/SceneAR became the nested child `scene.ar`, call face
unchanged) with `nodes · set · camera`(read/move/`flyTo` on the P5 transition
path)` · capture · pick · contacts · stats`, elements registering through a
per-kernel SceneRegistry seam, `scene.ready`/`scene.collide` on the standard
event planes, and all seven actions opted into Core/MCP as served tools
(`facets.mcp` — spawn/despawn already IS a store write into a bound group).
HONEST REMAINDER of this rung: run/pause/step and `input.synthesize` are the
NEXT G5 slice (named absences); logs/errors already read through the unified
ledgers; `profiler.*` beyond the stats() v0 counters stays the §3 profiler rung.
(G6 is the 2D engine — the rung below.)

### G6 — The 2D engine: sprites, sheets, and z-locked physics

`mode="2d"` was an orthographic CAMERA and nothing else — no sprite, no sheets, no 2D
physics conventions. The §0 abstraction law says the whole common case is one attribute
each:

```xml
<scene mode="2d" size="5">
  <sprite src="hero.png" position="0 1" size="1 1"/>
  <sprite src="hero-sheet.png" frames="4 2" fps="12" frame="{{ state }}" size="1 1"/>
  <sprite src="crate.png" physics="dynamic" collider="box"/>
</scene>
```

**G6 LANDED 2026-08-08 — corpus-first on all three kernels in the SAME commit,
web + both JVM lanes wired, SceneKit compile-pending:**

- **The shape found**: 2D was a camera word, so a "2D game" had to be built out of
  `<plane texture>` — no frame index, no sheet, no anchor, no flip, and a 3D solver that
  let a body wander off the plane in z. The chosen cut keeps ONE graph and ONE solver:
  `<sprite>` is a new scene NODE KIND (so transforms, `bind`, `<animate>`, prefabs,
  picking and physics all already apply), and 2D physics is a **Z-LOCK pass** on the
  existing fixed-tick solver rather than a second solver. The 2D-ness a node needs is a
  single `mode2d` stamp `parseScene` puts on every node, so no fold's signature grew a
  mode parameter.
- **The corpus**: `OpenSource/Conformance/scene/sprite.json` — **65 cases + the
  constants gate** (11 quad · 15 uv · 13 sheet · 7 fps · 7 parse · 4 draw-order ·
  4 physics-world · 4 physics-sim), every number from an independent scratch derivation,
  every law + constant pinned in the file's `_note` and the corpus README's "The 2D
  laws" (defaultHeight 1 · colliderHalfZ 1000 · defaultAnchor center · defaultLoop true ·
  the nine anchor words). The pinned decisions worth naming: the sheet grid is EXPLICIT
  (`cols = ceil(√N)` is WRONG and is written into the corpus as not-the-law — one number
  is a SINGLE ROW), the UV rect's `v0` is the frame's TOP edge (the P4 UV law verbatim),
  an out-of-range `frame` CLAMPS with one diagnostic (Article 7), and the z-lock case
  pairs a 2D fall against the SAME body in 3D so the lock is visible as the difference.
- **The kernels** — all three in one wave: TS `packages/kernel/src/scene/sprite.ts`
  (+ the `ir.ts` sprite props, the `readPosition` 2D pair law, the `SPRITE_ANCHORS`/
  `parseSpriteFrames`/`normalizeSpriteFlip` grammar and the `physics.ts` z-lock +
  sprite collider), Kotlin `core/…/scene/SceneSprite.kt` (+ the same `SceneIR.kt`/
  `ScenePhysics.kt` extensions), Swift `OpenSource/Engine/iOS/SceneSprite.swift`
  (+ `SceneIR.swift`/`ScenePhysics.swift`, compile-pending, registered in
  `Runtime.xcodeproj`). `sprite` joined `builtinTags` in the ONE shared lint facts file,
  so both linters accepted it at once.
- **The wiring**: web (`packages/dom/src/scene.ts`) — the sheet's frame rectangle rides
  the EXISTING GL program as a `uUvOffset`/`uUvScale` uniform pair (**no second shader,
  no per-frame geometry**; `flip` is a negative scale), the quad reuses the plane
  geometry with the anchor offset in its model matrix, alpha < 0.5 CUTS OUT, and
  `mode="2d"` paints in `sceneDrawOrder2d` order with `DEPTH_TEST` off; JVM (the ONE
  shared `SceneRaster.kt`) — the same quad with the frame rect substituted into the plane
  UVs and a `depthTest` flag threading the painter's algorithm through the fills, so
  Android and desktop both get sprites by construction; iOS (`SceneElement.swift`,
  compile-pending) — an `SCNPlane` on a CHILD node carrying the anchor offset (so the
  node's corpus-local transform stays untouched), the frame rect as
  `diffuse.contentsTransform`, and `renderingOrder` monotone in world z with depth
  reads/writes off. **The loop-existence law extended again** on all three surfaces: the
  ONE frame loop also runs while some sprite has `fps > 0` and either loops or has not
  reached its last frame.
- **Evidence**: scene-conformance **244/244 on TS and 244/244 on Kotlin** (66 new lanes
  each, up from 178); web suite 2059 pass / 2 fail (the two embed byte-pins that are RED
  on the clean tree — verified byte-identical before and after: `{"Audio":43372,
  "Video":43374,"Combined":43426}` and `39393B gzip`, so the 2D engine added ZERO embed
  bytes); typecheck clean; `npm run conformance` 546; gradle `test` fully green
  (`:core` 1691 · `:render` 584 · `:desktop` 170 · `:platform` 56, 0 failures); Swift
  balance-checked (delta 0 on every touched file) and riding the record lane through
  `SceneConformance.verify`, which now runs all FIFTEEN corpus files. **The real browser
  walk** is the honest half: `packages/dom/oracle/sprites-browser.ts` boots the shipped
  site, walks to the new `/sprites` route (`packages/scene-demo/Components/Sprites.dsx`)
  and asserts, under a live WebGL context, that sprite PIXELS cover the canvas
  (100% non-background, 13 colour buckets), that a store write moves the UV rect one
  cell (frame 0 → 1 → 5, the last on the sheet's SECOND ROW), that `flip="x"` still reads
  frame 3, that the 6 fps strip cycles through six distinct cells with NO store write,
  that a dynamic 2D crate falls (y 2.682 → −0.546) with its **z EXACTLY 0.5 throughout**,
  rests at y −3.0057 on the ground sprite and SLEEPS, and that the z −1 backdrop paints
  behind everything — 16/16 checks green.
- **The bug the walk exposed (fixed on all three renderers in this commit)**: while a
  property is SOLVER- or animation-OWNED the base plane still holds the SPAWN string, so
  `dsx.module.scene.set(id, "position", <spawn>)` — "put the crate back where it
  started" — was DEDUPED away as a no-op and the crate never moved. The fix is the same
  law three ways: web dedupes only when nothing overrides the property; the JVM adds a
  `forceWrite` seam the bus adapter calls (`SceneBusAdapter.forcePhysicsWrite`, wired by
  both JVM elements, covered by a new `SceneBusTest` case); iOS marks the write FORCED
  and the next physics scan honours it once. It was a G2/G5 bug on every renderer, not a
  2D one — the 2D walk is simply what stepped on it.
- **NAMED ABSENCES**: a **pixel-space camera mode** (units stay scene units — a `size` of
  half the viewport height IS the 1 unit = 1 pixel mapping) · **TILEMAPS** (`<tilemap>`,
  tile layers, tile colliders) · sprite **ATLASES packed by tooling** (a
  TexturePacker-style sidecar — only the uniform grid is the law) · **2D-specific
  JOINTS** (springs, distance, revolute) · **SORTING LAYERS beyond z** (named layers /
  order-in-layer) · 9-slice and tiled sprite draw modes · per-sprite opacity (the P5
  `opacity` absence stands) · a 2-number `rotation`/`scale`/`velocity` (only `position`
  takes the pair) · `collide=`/`on:collide` on `<sprite>` (physics `on:collision` covers
  2D contact today) · billboarded sprites inside `mode="3d"` (a sprite's authored
  rotation is honoured instead) · SceneKit sprite pixels (compile-pending, device-only).

## 3 · P1 and beyond (scheduled, not now)

- **IDE**: hierarchy/inspector/viewport/gizmos/play-pause — the AI is the
  primary interface; the panels serve verification. Rides StudioEditor.
- **Profiler + auto-fix**: frame-time/draw-call/memory counters as bus
  reads; perf-budget corpus lane; instancing/batching/culling/LOD (with
  Filament as the Android GPU tier).
- Particles, materials/PBR, shadows, post; navmesh/pathfinding; camera
  controllers beyond orbit; save/load (the store already serializes —
  recipe + slots); terrain/streaming.
- **P2/P3 (explicitly deferred)**: networking/multiplayer, shader language,
  AAA animation graphs, open worlds, consoles. Named, not chased.

## 4 · Standing constraints

Every G-rung lands corpus-first across the renderers; Swift rides Codemagic;
Android GPU (Filament) and device AR remain the named platform upgrades;
physics/skeletal math live in the shared kernels so the software lanes stay
1:1 and CI-provable. No rung may break the abstraction law in §0.
