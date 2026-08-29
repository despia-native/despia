# DSX Scene — the native 3D / 2D / AR engine

> **RATIFIED 2026-08-07 (product owner).** Despia builds its OWN declarative
> scene engine instead of embedding Godot. The owner's words: Godot was tried
> and rejected; "you can make 3D games in HTML so why not in DSX? The
> ergonomics are better in DSX." This SUPERSEDES the Godot demand-driven
> embedding ratification (`elements-gaps.json` / android-status) as the
> forward path for 3D/AR — the `<Godot>`/`<GodotView>` embedding rows stay
> ratified-absent exactly as they are (an embedding is not this engine, and
> nothing here claims it), but new 3D/AR demand lands HERE, not there.

## 1 · Why an own engine is the right shape (not contrarianism)

- **The precedent is proven.** "3D in HTML" is A-Frame's model: declarative
  entity-component markup over WebGL, and it works — for the app-shaped 90%
  of 3D (product viewers, configurators, data scenes, casual games, AR
  overlays). DSX Scene is the same idea with a STRONGER substrate: DSX
  already has the reactive store, so `<box position="0 {{ y }} 0"/>` animates
  by writing `dsx.variable.y` — no game loop, no scripting API, no bridge.
  That is the ergonomic claim, and it is structural, not cosmetic.
- **The platform math favors us.** iOS: SceneKit + RealityKit are SYSTEM
  frameworks — zero dependency, the JavaScriptCore precedent. Web: WebGL is
  native — zero dependency. Android: Filament (Google's PBR renderer) rides
  the locked-dependency flow the JsEngine module just proved end-to-end.
- **Godot embedding was always the wrong grain.** An embedded engine is a
  black box on the bus: its scene graph, its script VM, its asset pipeline —
  none reactive, none corpus-gatable, all divergence. A DSX-native graph is
  ONE grammar corpus-pinned across three renderers, like every other element.
- **What this is NOT.** Not a AAA engine. No custom shader authoring, no
  physics middleware, no skeletal animation in v1 — the ladder below names
  what ships when. Godot-class needs stay honest: they are out of scope, and
  the unsupported placeholder says so.

## 2 · The grammar (authoring surface — corpus-first, three renderers)

One new subtree root, reusing every DSX convention (attributes are words,
values are JSE-bindable, events are `on:*`):

```xml
<scene mode="3d" background="#0b1020" on:ready="…">        <!-- mode: 3d · 2d · ar -->
  <camera position="0 1.5 4" look-at="0 0 0" fov="60"/>
  <light kind="ambient" intensity="0.4"/>
  <light kind="directional" position="3 5 2" intensity="0.8"/>
  <group id="rig" rotation="0 {{ dsx.variable.spin }} 0">
    <box     position="-1 0 0" size="1 1 1"  color="#2563eb" on:tap="pick('box')"/>
    <sphere  position="1 0 0"  radius="0.5"  color="#f59e0b"/>
    <plane   position="0 -0.5 0" size="10 10" rotation="-90 0 0" color="#1e293b"/>
    <model   src="widget.glb" position="0 1 0" scale="0.5 0.5 0.5"/>
    <text3d  value="{{ dsx.variable.label }}" position="0 2 0"/>
  </group>
  <anchor kind="plane" on:found="place()"> … </anchor>     <!-- ar mode only -->
</scene>
```

Laws:
- **Vectors are space-separated triples** (`"x y z"`), scalars plain — JSE
  holes interpolate exactly like every other attribute; a bound triple
  re-renders the node's transform reactively (the store IS the game loop for
  state-shaped motion; `on:frame` exists for the simulation-shaped rest,
  budgeted like every handler).
- **`mode="2d"`** is the SAME graph with an orthographic camera and z as the DRAW
  ORDER — no second grammar. **Superseded in one detail by dsx-game.md G6 (landed
  2026-08-08):** a sprite is NOT "a `<plane>` with a texture" any more — `<sprite>` is
  its own scene NODE KIND (a camera-facing textured quad with sheets, `frame`/`fps`
  animation, `anchor`/`flip` and z-locked 2D physics), still inside the SAME graph, so
  every transform/bind/animate/prefab/physics law already applies. `position` accepts a
  PAIR in 2D; the corpus is `Conformance/scene/sprite.json`.
- **`mode="ar"`** is the same graph anchored to the world: `<camera>` becomes
  the device camera (ARKit / ARCore), `<anchor>` nodes attach subtrees to
  detected planes/images. AR is a MODE of the one engine, not a sibling.
- **Assets** (`<model src>`, textures) ride the content plane (`dsx.content`)
  — cached, hash-addressed, OTA-updatable like all content. glTF/GLB is the
  ONE interchange format (all three platforms have first-party loaders).
- The scene subtree is owned by the scene element — Stack layout stops at
  `<scene>` (it sizes like an image/video box); inside, coordinates are scene
  space. `check_style_catalog` is untouched; scene attrs are element attrs.

## 3 · Architecture (the constitutional shape)

- **The scene IR + math kernel is platform-neutral and corpus-pinned**:
  parse → node tree → world transforms (TRS, column-major mat4) → camera
  projection. `OpenSource/Conformance/scene/` fixtures assert NUMBERS
  (world matrices, projected points) so three implementations cannot drift —
  the api-blocks template.
- **Renderers are per-platform adapters** consuming the IR: WebGL (web,
  in-kernel, zero deps), SceneKit (iOS, system), Filament (Android, a
  module-owned locked dependency — the JsEngine/`build`-primitive path).
  AR adapters: RealityKit/ARKit (system) and ARCore (module dependency).
- **The AR capability is a MODULE** (`Core/Scene/AR` or facet of a Scene
  module) — camera permission, session lifecycle, anchor events on the bus;
  excludable, file-presence-gated, `unsupported_platform` where absent.
- **Diagnostics ride the unified primitives** — a scene parse/asset failure
  is a `dsx.error` + diagnostics-ledger card, never a bespoke channel.

## 4 · The ladder (phases, each gated)

| Phase | Ships | Gate |
|---|---|---|
| **P1 — LANDED (web), 2026-08-07** | The grammar in the shared lint facts; `Conformance/scene/` (parse + transform + projection fixtures); the platform-neutral TS scene IR + math kernel; the web `<scene>` WebGL renderer (camera, lights, box/sphere/plane/group, color materials, reactive transforms, on:tap picking v0); demo route | corpus green on TS; web suite; lint twins pick up the new tags from facts.json automatically |
| **P2 — LANDED 2026-08-07 (both halves; Kotlin record §6)** | Kotlin math/IR twin (:core, SDK-free) + Swift twin (record lane, compile-pending); the SceneKit adapter (iOS, system framework); the Filament module (Android, locked dep). The iOS half landed 2026-08-07 (compile-pending, rides Codemagic): SceneMath.swift + SceneIR.swift (the Swift math/IR twin, fed by StackXML — never a second parser), the record-lane corpus host (ConformanceHosts SceneConformance, all 37 cases, registered in RecordMain), and the SceneKit adapter (SceneElement, tag `scene` — per-node LOCAL T·Rz·Ry·Rx·S so SceneKit's own parent·child composition IS the corpus world law; SceneKit is a system framework, no WebKit). The Kotlin half landed 2026-08-07 (§6): SceneMath.kt + SceneIR.kt (:core, pure JVM, fed by StackNode — never a second parser), SceneConformanceTest 37/37, and **ONE shared software rasterizer** (SceneRaster.kt) rendering `<scene>` on BOTH Android (:render Bitmap) and desktop (:desktop Skia ImageBitmap) — 1:1 by construction, zero new deps, CI-pixel-tested; **Filament stays the named PBR/performance upgrade, unbuilt**, to be drawn on demand on top of the working rasterizer. | corpus on three runners (Kotlin 37/37 ☑, Swift record lane, TS per-PR); :core green ☑; :render/:desktop pixel tests ☑; Codemagic |
| **P3 — WRITTEN 2026-08-07 (iOS ARKit path + the module, compile-pending; Android availability-only; DEVICE QUALIFICATION OPEN)** | `mode="ar"`, ARKit-first. **iOS**: the SceneKit adapter mounts the SAME graph (per-node corpus locals untouched — the P2 design's payoff) into an `ARSCNView` obtained through the kernel seam `SceneAR.provider` (`OpenSource/Engine/iOS/SceneAR.swift` — nil by default; the kernel imports ZERO ARKit, the JsTier.engine shape). The **Core/SceneAR module** (scheme `scene`; probe `dsx.module.scene.ar.status`) binds the seam and borrows **Core/AR's one shared ARSession over the bus** (`dsx.module.ar.start` / `object("session")` — the Scene3D precedent), so camera permission + session lifecycle stay with their owner; SceneAR owns the scene-shaped half (the AR view on the shared session, the plane-anchor relay, plane detection armed when any `<anchor kind="plane">` exists). `<anchor>` subtrees mount HIDDEN and reparent onto the matched ARAnchor's live node (first unmatched anchor claims, document order); `on:found` fires through the standard gated handler path (env.runGated) with payload **`{kind, id, position}`** (id = the anchor's markup `id`, position = world meters at match). `<camera>` is ignored under AR (the device camera IS the camera, §2). `kind="image"` is a NAMED ABSENCE. Module excluded / Core/AR excluded / camera denied / unsupported device ⇒ the plain SceneKit render of the same graph + the honest label — never a crash, never a silent camera grab (Article 7). Ships OFF by default beside Core/AR. **Android**: the module's kotlin facet is the AVAILABILITY + groundwork half only — `com.google.ar:core` 1.54.0 landed as a module-owned locked dependency (QRScanner declaration shape; qa-expanded gradle locks + sha256 verification metadata regenerated, ownership ledger updated) answering `scene.ar.status` with the real ArCoreApk verdict, while AR **rendering stays named to the Filament upgrade** (the P2 software rasterizer cannot composite a camera feed) — the scheduled label remains, no fake AR. **Web**: the scheduled placeholder, unchanged. | Swift is compile-pending (rides Codemagic); structure/membership/module-law gates green locally. **The remaining gate is DEVICE QUALIFICATION** — cameras don't exist in CI: real plane detection, on:found, permission-denial fallback, and camera release on unmount must be verified on ARKit hardware before this row reads LANDED |
| **P4 — LANDED 2026-08-07 (web + both JVM lanes; §7)** | `<model>` glTF (GLB, embedded buffers only — the named absence); `<text3d>` billboards; `texture=` on box/sphere/plane; `on:frame` (60/s budget). **Swift P4 is the NAMED follow-up**: the ladder's TS→Kotlin ordering applied here — the Swift twin still runs the P1/P2 trio only, and the P4 corpus files (`model`/`text3d`/`frame`) + SceneKit wiring are the next Swift wave (the corpus README carries the same ledger line). | corpus (3 new files) on TS per-PR ☑ + Kotlin :core ☑ (Swift = the named follow-up); web suite + screenshot walk ☑; :render/:desktop pixel tests ☑; embed byte budgets unchanged ☑ |
| **P5 — LANDED 2026-08-07 (web reference + corpus; §8)** | Computational completeness: the ANIMATION SYSTEM (implicit `transition=` retargets + explicit `<animate>` tweens, pinned easing math incl. the analytic spring, the when-gate, on:done); DATA-DRIVEN CHILDREN (`<group bind key>` — keyed rows, `item.*` scope, the game-spawning primitive); COLLISIONS (`collide="sphere|box"` + `on:collide`, enter-only); ORBIT CAMERA CONTROLS; LIGHTING DEPTH (≤4 point lights + linear fog). Five new corpus files (`animation` 19 · `bind` 8 · `collide` 8 · `orbit` 6 · `lighting` 7), kernel modules `scene/{anim,bind,collide,orbit}.ts` + ir.ts extensions, the web renderer wiring, `<animate>` in the shared lint facts, `group` in `keyedCollections`. **Kotlin and Swift P5 are the NAMED follow-up** — the next wave lands from this corpus (the corpus README carries the ledger line). | corpus (5 new files, 48 new TS lanes — scene-conformance 104/104) ☑; web suite + typecheck + conformance 546 ☑; screenshot walk: looping tween animates with no on:frame, a store write spawns a bound row, `transition=` glides the cube left→right regionally ☑; layout oracle 7/7 ☑; embeds byte-identical (scene stays boot-only) ☑; both linters green ☑ |

| **2D — LANDED 2026-08-08 (dsx-game.md G6; all three kernels + the web renderer + the shared JVM rasterizer + SceneKit compile-pending)** | The 2D ENGINE, not just a 2D camera: `<sprite>` (a textured quad in the same graph — `src`/`size`/`anchor`/`flip`/`color`), sprite SHEETS (`frames="N"` or `"cols rows"`, a reactive `frame`, `fps` auto-advance on the shared frame clock, `loop`), the 2D conventions (+Y up, z = the DRAW ORDER under the painter's algorithm, a 2-number `position`, no pixel-space mode), and 2D PHYSICS through the EXISTING solver under a Z-LOCK (`collider="box"` from the sprite size, `"circle"` = half the smaller extent). Corpus `Conformance/scene/sprite.json` (65 cases + the constants gate). | corpus on three runners (TS 244/244 ☑, Kotlin :core 244/244 ☑, Swift record lane); gradle `test` fully green ☑; the REAL browser walk over `/sprites` ☑; embeds byte-identical ☑ |

Out of scope until separately ratified: custom shaders, multiplayer state.
Each is a named absence, not a silent one. PHYSICS graduated to its own
ratified program and LANDED 2026-08-07 as dsx-game.md G2 on all four renderers
(corpus `Conformance/scene/physics.json`); SKELETAL ANIMATION graduated the
same way and LANDED 2026-08-08 as dsx-game.md G3 (corpus
`Conformance/scene/skin.json`, all three kernels in one wave — the G3 landing
record carries the ledger); PREFABS (components instantiating inside `<scene>`
subtrees) LANDED 2026-08-08 as dsx-game.md G1 (corpus
`Conformance/scene/prefab.json` — the G1 landing record carries the ledger); the 2D
ENGINE (`<sprite>`, sheets, the 2D conventions, the z-locked solver) LANDED 2026-08-08
as dsx-game.md G6 (corpus `Conformance/scene/sprite.json`, all three kernels in one
wave — the G6 landing record carries the ledger).

## 5 · P1 landing record (2026-08-07)

What landed, where, and the decisions made in the landing:

- **Grammar** — all ten tags registered in the ONE shared lint facts file
  (`OpenSource/Conformance/lint/facts.json` `builtinTags`): `scene · camera ·
  light · group · box · sphere · plane · model · text3d · anchor`. **`<plane>`
  kept its proposed spelling** — no collision existed in the tag universe (the
  decision is recorded in `Conformance/scene/README.md`). Both lint runners went
  green unchanged (`lint_dsx.rb --strict` 0/0 over 107 files;
  `lint_conformance.rb` 0 drift; the TS lint suite 8/8).
- **Corpus** — `OpenSource/Conformance/scene/`: `transforms.json` (15 cases),
  `projection.json` (7), `parse.json` (15); every number computed by an
  independent scratch implementation. **The TRS law as implemented:** column-major
  mat4, column vectors; `local = T · Rz · Ry · Rx · S` (rotation degrees, X
  applied to the object first, then Y, then Z); `world = parentWorld · local`;
  right-handed lookAt (up +Y), GL projection (NDC z ∈ [-1,1]); `mode="2d"` =
  orthographic, `size` = vertical half-extent. Defaults pinned in `parse.json`
  (camera `0 0 5` → origin, fov 60, near 0.1, far 1000; light ambient/1;
  geometry sizes/radius 1, color `#ffffff`; malformed values → default + one
  diagnostic, Article 7).
- **Kernel** — `OpenSource/Web/packages/kernel/src/scene/{math,ir}.ts`,
  platform-neutral (no DOM/WebGL imports), exported through the kernel index;
  `test/scene-conformance.test.ts` runs all three corpus files (37 tests) +
  `test/scene.test.ts` (12 edge-case tests). `parse.json` markup parses through
  the compiler's own XML parser — no second parser exists.
- **Web renderer** — `packages/dom/src/scene.ts`: canvas + raw WebGL1 (zero
  deps, `preserveDrawingBuffer` for on-demand redraw + honest readback), flat
  Lambert shading (ambient + first directional), reactive transforms
  (per-attribute store bindings, rAF-coalesced redraw, no free-running loop),
  picking v0 (kernel `pickRay`/`raySphere` vs world bounding spheres, handlers
  through the normal runner path). Registered from `boot.ts` only, so sliced
  embeds pay zero bytes (the embed byte-budget ledger stayed green unchanged).
  SSR (`@despia-native/server` render.ts) emits the sized `.dsx-scene` box — scene nodes
  never degrade to DOM placeholders. `mode="ar"`, `<model>`, `<text3d>`,
  `<anchor>` render the labelled scheduled-placeholder inside the scene box.
- **Demo** — the `/scene-element` route (`packages/scene-demo`, a
  package-contributed route; `/scene` already belongs to the native scene3d/Godot
  demo page): spinning rig via a store variable, tap picking, ground plane. The
  screenshot walk drives it under real WebGL and asserts non-blank pixels
  (402 distinct canvas colors), a reactive redraw on the spin write, and a
  successful ball pick.
- **Gates at landing** — web suite 1818 pass / 0 fail; typecheck clean;
  `npm run conformance` 546 pass; layout oracle 7/7; the full screenshot walk
  green; `check_module_rules.rb` 0 errors.

## 6 · P2 landing record — the Kotlin half (2026-08-07)

What landed, where, and the ONE design decision that shaped it:

- **The decision: ONE Kotlin software rasterizer for both JVM lanes.** Instead of
  wiring Filament now, Android and desktop both paint the SAME pure-JVM pipeline
  (`OpenSource/Engine/Android/core/…/scene/SceneRaster.kt`): geometry (unit box
  12 tris · UV-sphere 16×24 · plane 2 tris) → corpus-law world matrices → camera
  → z-buffered flat Lambert matching the web shader's model
  (`color · (ambient + lightColor · max(0, n·lightDir))`, two-sided planes).
  That makes the two Kotlin surfaces 1:1 **by construction**, adds ZERO
  dependencies, and — because no GPU or display server is involved — makes the
  pixels CI-verifiable on any runner. Exact WebGL pixel parity is NOT claimed:
  the corpus pins the MATH; the pixel tests pin non-blank, reactivity, relative
  geometry, and occlusion. **Filament remains the named PBR/performance upgrade
  (§3), unbuilt** — a module-owned locked dependency to be drawn on demand on
  top of this working baseline. (SceneKit is the iOS half — see the P2 row.)
- **The math/IR twin** — `core/…/scene/SceneMath.kt` (column-major
  `DoubleArray(16)` mat4 + vec3: multiply, TRS, rotations X→Y→Z degrees, lookAt,
  perspective/orthographic, invert, transformPoint, projectToNdc, pickRay,
  raySphere) + `SceneIR.kt` (typed nodes with holes kept verbatim, resolver
  callback, corpus defaults, Article-7 fallbacks + diagnostics, worldMatrices,
  sceneCamera, sceneLighting, bounding spheres, the shared `scenePickAction` tap
  glue). The IR consumes **`StackNode`** — the tree `StackXML.parse` already
  produces — never a second XML parser (the ir.ts law).
- **Corpus** — `core/src/test/…/scene/SceneConformanceTest.kt` runs all three
  corpus files (**37/37**, @TestFactory, 1.5e-6 tolerance, diagnostics counted);
  `parse.json` markup parses through `StackXML.parse`. `SceneRasterTest.kt` pins
  the pixels: non-blank (≥8 shades on the proposal rig), the silhouette in the
  expected screen quadrant with exact ambient-lit color, a changed resolve value
  changing the framebuffer, z-buffer occlusion regardless of document order,
  picking, and the malformed-background fallback.
- **The Android element** — `render/…/elements/SceneElements.kt` registers
  `scene` via `ComposeStackComponents.defineNative` (the qrcode/svg wave shape,
  aggregated in `InputElements.register()`): framebuffer → `Bitmap` → Canvas
  (raster long edge capped at 640, the draw scales), reactive re-raster keyed on
  the resolved-attribute snapshot over its own `varsFlow` subscription, tap →
  kernel `scenePickAction` → `env.run`, the honest scheduled placeholder, and
  `on:ready`. Plain-JVM units (`SceneElementsTest`) cover the pure halves; the
  Bitmap paint + gesture pipeline are device-only (instrumented lane), the
  composable compile-gated by `:render:assembleDebug` like every element wave.
- **The desktop element** — `desktop/…/DesktopSceneElement.kt`, dispatched from
  `DesktopRenderer` as a binary-owned tag (NOT a `DesktopCapabilities` row —
  this build ships a real renderer; Scene3D/Scene360 stay capability rows): the
  same rasterizer into a Skia `ImageBitmap` (explicit BGRA bytes, no endianness
  assumption), same reactive key, same picking, same placeholder.
  `DesktopSceneUiTest` drives the real Compose/Skia scene display-server-free:
  non-blank capture (≥8 sampled colours), a store write changing the pixels, and
  a center tap firing the box's `on:tap` through the runner.
- **Gates at landing** — `:core:test` 1456 pass / 0 fail (incl. scene 37 + 6
  raster); `:render:test` 564 / 0; `:desktop:test` 165 / 0 (incl. the new scene
  UI test); `check_module_rules.rb` 0 errors; `prepare_modules_android.rb` ×2
  idempotent.

## 7 · P4 landing record — web + both JVM lanes (2026-08-07)

What landed, where, and the laws pinned in the landing (Swift P4 was the NAMED
follow-up — the closing bullet records its landing):

- **Corpus first** — three new files in `OpenSource/Conformance/scene/`, every
  number from an independent scratch implementation:
  - `model.json` (8 cases + 3 base64 GLB fixtures; byte layout documented in the
    README): the GLB container law — **embedded buffers only** (a buffer `uri` is
    the named absence, error value `external-buffer`; bad magic → `not-glb`;
    structurally broken → `malformed` — failure is a VALUE, Article 7), POSITION/
    NORMAL f32 VEC3, u8/u16/u32 indices (non-indexed synthesizes), `baseColorFactor`
    (default [1,1,1,1]), triangles only, and the draw list flattening the default
    scene's node hierarchy (`matrix` or T·R(quaternion)·S — a 90°-about-Z
    quaternion case pins the math). Model textures, skins, animations and sparse
    accessors are named absences; flat baseColor is the v1 material.
  - `text3d.json` (7 cases): the quad LAW — height = `size` (default 0.5), width
    = `size × 0.6 × codePointCount` (a surrogate-pair case pins code points),
    center = `position`, empty value → no quad; malformed `size` falls back with
    one diagnostic. Geometry ONLY — glyph pixels are per-platform and unpinned
    (the honest scope line).
  - `frame.json` (4 cases): the on:frame BUDGET LAW — ticks under 1000/60 ms
    since the last EMITTED tick coalesce; payload `{dt, elapsed, frame}` (first =
    {0,0,0}; dt spans the real gap; elapsed/frame strictly monotonic). The
    lifecycle half (loop only while a handler is authored and the element is
    mounted; no loop for static scenes — the P1 law stands) is stated as law and
    asserted by each surface's own tests.
  - The **UV law** is pinned in the corpus README (a pixel-space law a JSON corpus
    cannot carry): NEAREST sampling clamped to the edge; plane/box faces map
    `u = x_face + 0.5`, `v = 0.5 − y_face` (texel row 0 = image top); sphere maps
    `u = φ/2π` (+X meridian toward +Z), `v = θ/π` (0 at +Y); the texel MODULATES
    the lit color. Enforced by each lane's pixel tests; texel-exact cross-renderer
    parity is NOT claimed (the P2 stance).
- **Kernel twins** — TS: `packages/kernel/src/scene/{gltf,frame}.ts` + the quad
  law in `ir.ts` (`text3dQuad`, `text3dSize`/`texture` typed props); Kotlin:
  `core/…/scene/{SceneGltf,SceneFrame}.kt` + the same `SceneIR.kt` additions —
  both pure, zero deps, GLB JSON through each runtime's OWN JSON reader (never a
  second parser). `scene-conformance.test.ts` and `SceneConformanceTest.kt` run
  all SIX corpus files (56 TS tests / 56 Kotlin corpus cases).
- **Web renderer** (`packages/dom/src/scene.ts`) — `<model src>` fetched with the
  media-surface posture (`safeMediaUrl`, CORS-anonymous) and drawn through the
  existing flat-Lambert pipeline (model = sceneWorld · draw.world, baseColor ×
  node color; absent normals flat-shade by de-indexing); `texture=` NEAREST/
  clamped WebGL sampling per the UV law; `<text3d>` canvas-2D-rasterized WHITE
  glyphs on a **billboard** (the BILLBOARD LAW: the quad always faces the camera —
  its rotation is the view rotation transposed; drawn UNLIT so labels stay
  legible; alpha-cutout edges); `on:frame` = a rAF loop that exists ONLY while a
  handler is authored and the element is mounted, driving the kernel frame clock
  and dispatching through the same runner path as on:tap. model/text3d left the
  scheduled-placeholder set; `mode="ar"`/`<anchor>` placeholders stay (P3).
- **The JVM lanes** — SceneRaster.kt grew perspective-correct textured triangles,
  GLB mesh rendering (flat facets), and billboard text3d, all fed through the new
  **SceneAssets SEAM** (`texture(url)` / `model(src)` / `text(value, w, h)`): the
  ELEMENTS own platform I/O, :core stays pure JVM and geometry-only
  (`checkPureJvm` green). Both elements wire the seam identically: bytes ride the
  CONTENT PLANE (`DSXContent` cached-then-fresh — the §2 asset law), decoded off
  the main thread (BitmapFactory on Android, Skia on desktop), text through
  android.graphics / java.awt; a finished load bumps an asset epoch keyed into
  the raster remember. on:frame is a `withFrameNanos` loop (LaunchedEffect
  cancellation IS the unmount law) over the :core `SceneFrameClock`.
- **Pixel evidence** — `SceneRasterTest.kt`: a textured box face samples the two
  distinct checker texels where the flat face was one color; a model triangle
  paints its exact baseColor at the corpus-computed screen positions (and stays
  absent without the seam — honest absence); text3d paints inside its
  corpus-computed quad with transparent texels cut out and nothing outside.
  `DesktopSceneUiTest`: an on:frame handler advances the store through the runner
  under a hand-driven frame clock and CHANGES the captured framebuffer, and the
  text3d billboard's white glyphs appear in the real Compose/Skia capture. The
  web screenshot walk drives the new P4 demo scene (textured box + `<text3d>` +
  on:frame): 68 distinct canvas colors, two probes differ (the loop animates),
  and the store variable advances.
- **Gates at landing** — web: suite 1838 pass / 0 fail, typecheck clean,
  conformance 546, layout oracle 7/7, full screenshot walk green (P1 scene
  checks unchanged: 402 colors, reactive spin, ball pick); Kotlin: `:core:test`
  1478 / 0 (+ `checkPureJvm`), `:render:test` 568 / 0, `:desktop:test` 166 / 0;
  `check_module_rules.rb` 0 errors; `lint_dsx.rb --strict` 0/0;
  `prepare_modules_android.rb` ×2 idempotent; the embed byte-budget ledger
  unchanged (scene stays boot-only; the GLB parser lives in the kernel package,
  imported only by the boot-registered scene surface).
- **Swift P4 (2026-08-07, the named follow-up — landed)** — the kernel twins
  (`SceneGltf.swift` · `SceneFrame.swift` + the `SceneIR.swift` quad law and
  `text3dSize`/`texture` props), the record-lane host now running all SIX corpus
  files, and the `SceneElement.swift` SceneKit wiring (content-plane assets
  behind the media URL posture, draw.world verbatim on draw child nodes,
  NEAREST/clamp textures, `SCNBillboardConstraint` text3d, a CADisplayLink
  on:frame loop under the kernel clock) all landed together — compile-pending,
  verified on the Codemagic record lane.

## 8 · P5 landing record — computational completeness, web reference + corpus (2026-08-07)

The corpus-first P5 wave: five new fixture files (every number from an
independent scratch implementation), four new kernel modules, the web renderer
wiring, and the demo/walk evidence. **Kotlin and Swift P5 are the NAMED
follow-up** — the next wave lands from this corpus; the corpus README carries
the ledger line.

**The animation semantics law (verbatim, also in the corpus README):**

- An animation produces a value that OVERRIDES the authored/bound base value of
  one property while active; when it ends, the property returns to base (or
  holds, per `fill="hold"`).
- **Implicit transitions**: `transition="position 300ms ease-out, color 200ms"`
  on any scene node — when the property's resolved base value CHANGES (a store
  write), the rendered value RETARGETS from its current rendered value to the
  new base over the duration (the CSS transition model: **interrupt = start
  from where you are, never snap, never queue**). This makes
  `dsx.variable.x = 5` glide.
- **Explicit tweens**: `<animate target="rotation" from="0 0 0" to="0 360 0"
  duration="2s" easing="linear" loop="true"/>` as a CHILD of the node it
  animates. The target set is CLOSED: `position · rotation · scale · color ·
  intensity · fov` (opacity is a named absence — no material opacity channel).
  `from` defaults to the base value at start; `loop` is `false | true | N |
  "pingpong"` (on:done fires per COMPLETION, never per loop iteration; pingpong
  samples the easing at `clip − u` on odd cycles); `when` is a JSE-bindable
  gate — truthy = playing, becoming falsy stops at base, each falsy→truthy
  edge restarts the clock. An explicit tween WINS over an implicit transition
  on the same property.
- **Easing is pinned math**: `linear`; `ease`/`ease-in`/`ease-out`/
  `ease-in-out` as the CSS cubic-bezier constants — (0.25, 0.1, 0.25, 1) ·
  (0.42, 0, 1, 1) · (0, 0, 0.58, 1) · (0.42, 0, 0.58, 1) — solved by exactly
  60 bisection iterations; `spring(stiffness, damping)` as the analytic mass-1
  damped spring on the REAL clock, completing at the settle time
  `T = ln(1000)/(ωₙ·(ζ − √max(0, ζ²−1)))` where progress clamps to exactly 1
  (duration is ignored for spring — ending never snaps). Vector/color
  properties interpolate componentwise — **colors in linear RGB**.
- **Determinism**: value(t) is a pure function of the spec + start state —
  `animation.json` pins samples to 6 decimals (easings at 0/¼/½/¾/1, delay,
  loop wrap, pingpong reflection, spring convergence, the retarget-mid-flight
  fold, the when gate, vector + color componentwise cases).
- **The runtime law**: animations ride the EXISTING kernel frame clock
  (`createSceneFrameClock`, the 60/s budget); the loop runs ONLY while at least
  one animation is active or an on:frame handler exists — the zero-cost
  static-scene law survives. Verified in the walk: the looping tween animates
  a scene with NO on:frame handler.

**What landed, where:**

- **Kernel** — `packages/kernel/src/scene/anim.ts` (easing/spring/bezier math,
  the tween + transition evaluators, the linear-RGB color plane, the
  duration/loop grammar), `bind.ts` (row keying + keyed diff + template
  instantiation, `SCENE_BIND_LIMIT` 256), `collide.ts` (worldAabb, the pinned
  depth laws, `sceneColliderFor`, the enter-only tracker), `orbit.ts` (the
  spherical/drag/zoom laws, 0.4°/px, `e^(deltaY·0.0015)` zoom clamped
  [near, far]); ir.ts grew `animate` as a node kind (a CONTROLLER — no world
  matrix), point lights (`kind="point"`, range default 10, cap 4 in document
  order + one diagnostic), `sceneFog`/`sceneFogFactor`/`scenePointAttenuation`
  (`window²/(1+d²)`, `window = 1−(d/range)⁴`)/`sceneLitColor`, `controls` and
  `collide` typed props, and **the total-resolve law**: an unauthored attribute
  now consults the resolver with its formatted default as raw — numerically
  identical for pure hole resolvers, but it lets the override plane animate
  properties the author never wrote (found by the walk: a rotation tween on a
  box with no `rotation=`).
- **The override plane decision** — animations override at the RESOLVED
  ATTRIBUTE plane: the web renderer's resolver consults an override map first
  (`resolve`), the base plane never does (`resolveBase`), so the corpus-pinned
  `worldMatrices`/`sceneCamera`/`sceneLighting` folds needed ZERO signature
  changes, and the same seam serves tweens, transitions and orbit controls.
  Color overrides quantize to #hex at this last step (displays are 8-bit; the
  corpus pins the linear plane).
- **Bound rows** — `<group bind key>`: the template children leave the static
  walk; each row instantiates fresh SceneNode identities (kernel
  `instantiateSceneRow`) bound through a row-scoped MountCtx
  (`adoptInternals.subCtx` + `itemRefresh` — the `<list>` row seam verbatim), so
  `item.*` holes resolve per row and a row node's `on:tap` runs in the row
  scope (the payload's scope carries the row item). Keyed diff via the kernel;
  a removed row disposes its bindings, drops its caches/overrides, and stops
  its animations. Nested binds recurse. `group` joined the lint facts
  `keyedCollections` so `<group bind>` without `key=` warns.
- **Collisions** — the pass rides each RENDERED frame (never its own loop)
  while any `on:collide` is authored; tracker identity is a per-node serial,
  payload `{id, other, depth}` carries authored ids ("" when none), both
  directions fire on enter, separation re-arms.
- **Web renderer** — `packages/dom/src/scene.ts`: ONE rAF loop for on:frame +
  animations (shared kernel clock), orbit pointer/wheel wiring (drag suppresses
  the following click-pick), the shader grew 4 point lights + linear fog
  (formulas verbatim from the kernel), bound-group reconciliation, and the
  honest-diagnostic paths (`malformed-animation`, `bind-overflow`, `light-cap`,
  `malformed-fog`, `unknown-collide` — Article 7 throughout).
- **Corpus** — `OpenSource/Conformance/scene/{animation,bind,collide,orbit,
  lighting}.json`: 19 + 8 + 8 + 6 + 7 cases, 48 new TS conformance lanes
  (scene-conformance 104/104). Laws pinned in the corpus README: the animation
  semantics law, the bind/keying laws, the collide depth + ENTER laws, the
  orbit laws, the attenuation/lit/fog laws, and the total-resolve law.
- **Demo + walk** — the third `/scene-element` scene: a `transition=` glider
  (tap or button), a looping `<animate>` tween, a bound enemy group spawned by
  a store write, a point light, fog, and `controls="orbit"`. The walk asserts:
  non-blank paint (point light + fog + rows), two probes differ with NO
  on:frame handler (the tween loop), Enemies 2 → 3 after the spawn write, and
  the REGIONAL glide check (blue-dominant pixels move from the lower-left third
  to the lower-right third — honest evidence the transition moved the cube,
  since the tween churns the whole-canvas hash every frame).
- **Gates at landing** — web suite 1884 pass / 0 new failures (the two embed
  byte-ledger pins were red on the CLEAN tree in this environment with
  byte-identical measurements before/after — scene stays boot-only, embeds
  gained zero bytes); typecheck clean; conformance 546; layout oracle 7/7; the
  full screenshot walk green (P1/P4 checks unchanged); `lint_dsx.rb --strict`
  0/0 over 107 files; `lint_conformance.rb` 0 drift; the TS lint suite green
  with `animate` in the one shared facts file.

## 9 · The scene BUS surface — `dsx.module.scene` (dsx-game.md G5 wave 1, landed 2026-08-07)

Scenes were elements only; nothing else on the bus could drive or inspect them.
The G5 foundation makes the engine bus-reachable: **Core/Scene** owns scheme
`scene`, and every mounted `<scene>` registers a handle into a per-kernel
**SceneRegistry seam** the module drives — any module, any action, and (via
Core/MCP) any AI agent can now query the graph, write attributes, drive the
camera, capture frame evidence, and read the ledgers.

- **The module shape** — the chain law decided it: two modules cannot share a
  chain (`dsx_graph` duplicate-chain abort), and the core surface must not
  require the off-by-default AR module, so the flat `Core/SceneAR` (scheme
  `scene`, group `ar`) became the NESTED CHILD `Core/Scene/Modules/AR` (local
  segment `ar`, derived chain `scene.ar`) under the new parent `Core/Scene`
  (scheme `scene`). The AR call face is byte-identical
  (`dsx.module.scene.ar.status()` — the former in-module group became the
  nesting itself); the parent owns the core actions and no AR. Cascade
  exclusion holds: dropping the parent drops the child; dropping only the
  child keeps the bus surface.
- **The seam** (the JsTier.engine / SceneAR.provider shape, one file per
  kernel): `OpenSource/Engine/iOS/SceneRegistry.swift` ·
  `Engine/Android core scene/SceneRegistry.kt` ·
  `Web packages/kernel/src/scene/registry.ts` (backed by
  `Symbol.for("dsx.scene-surfaces.v1")` so the independently bundled web facet
  never imports @despia-native/kernel — the Dom facet precedent). Elements register on
  mount keyed by their `id` attr (auto key `scene#N`), unregister on unmount;
  actions target `{scene}` (default: the FIRST mounted scene). The kernel
  names no module; Core/Scene excluded leaves the seam unread and scenes
  render untouched.
- **The actions** (typed errors declared per action — scene_not_found ·
  node_not_found · bad_attr · no_camera · bad_value · capture_failed ·
  bad_point): `nodes` (the resolved tree: kind/id/resolved props/world
  position, the corpus worldMatrices/resolvedProps folds), `set` (writes the
  resolved-attribute BASE plane, so a `transition=`-covered property GLIDES —
  the P5 interrupt model, never a second mutation path), `camera`
  (read/position/lookAt/`flyTo` — flyTo rides the P5 transition evaluator,
  **EASE-OUT**, default 600 ms, from the current rendered position), `capture`
  (web canvas.toDataURL; JVM rasterizer framebuffer → PNG → base64 —
  javax.imageio on desktop, android.graphics on :render; iOS
  SCNView.snapshot, compile-pending), `pick` (the on:tap pickRay/raySphere
  math at normalized (x, y), NO handlers fired), `contacts` (the current
  overlapping collider pairs — the pure sceneContacts fold, authored ids),
  `stats` (nodes · active animations · last frame dt · bound rows — the
  honest v0 profiler).
- **Events** — the element emits `ready`/`collide` through the seam; the
  module (never the element) re-fires them on the standard planes:
  `scene.ready`/`scene.collide` on the delegate fan-out + the module event
  channel (`dsx.module.scene.on(…)`, page `dsx.on("scene")`) — the
  WatchHealthBridge re-fire shape.
- **MCP** — reachability is per-module opt-in (`facets.mcp`), and the manifest
  opts all seven actions in (`scene_nodes` … `scene_stats`; mutating rows
  declare `mutates` and stay approval-gated). The worked agent loop lives in
  the module README (spawn via store write → set → capture → pick).
- **JVM write plane** — the ONE shared `:core` `SceneBusAdapter` both JVM
  elements construct layers a bus-owned BASE overlay under the live-store
  resolver (`SceneAnimator.noteBase` retargets from it) and gained
  `SceneAnimator.glide` for flyTo; iOS mirrors it with a `busBase` overlay in
  the element's base resolver; web writes the element's base cache. One
  override plane, three spellings, zero new mutation paths.
- **Gates at landing** — web: suite green including the new
  `scene-bus.test.ts` (10 module-call-path tests against a mounted scene),
  typecheck clean, embeds untouched (the facet is a separate chunk; the
  registry seam is boot-only); Kotlin: `:core` SceneBusTest 12/12, `:render`
  SceneElementsTest 13/13 (the plain-JVM bus half), `:desktop`
  DesktopSceneUiTest 5/5 including the capture PNG decode
  (framebuffer-exact dims); Swift compile-pending (balance-checked, Xcode
  membership via add_core_sources); `prepare_modules[_android].rb` ×2
  idempotent; `check_module_rules` 0 errors; `contract_diff` module `scene`
  added (no breaking); the compose-desktop qualification ledger moved with the
  generated map (185→186 schemes; ios 186, android 171, macos 127) under a
  green guards test.
- **Named absences** — run/pause/step + input synthesis (the NEXT G5 slice);
  a conformance corpus for the bus surface (module actions are not authoring
  grammar — the three implementations are pinned by their per-platform suites
  instead); Android/desktop capture of GPU-composited future renderers
  (Filament stays the named upgrade); web `ready` under a WebGL-less
  environment (no first draw ever happens — the fallback label is the
  answer).
