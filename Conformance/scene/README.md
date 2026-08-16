# scene/ — the DSX Scene numeric corpus

The DSX-native 3D/2D/AR engine's law executed as fixtures
(`architecture/proposals/dsx-scene.md`, ratified 2026-08-07): the scene IR + math
kernel is platform-neutral and corpus-pinned — parse → node tree → world transforms
(TRS, column-major mat4) → camera projection — so three renderer implementations
cannot drift. Every expected number in these files was computed by an independent
scratch implementation, never by the kernel under test (fixtures first, the
api-blocks template).

## The fifteen files

- **`transforms.json`** — scene-node trees (nested groups, authored attribute
  STRINGS with JSE holes) → asserted WORLD MATRICES and transformed points.
- **`projection.json`** — camera words (position / look-at / fov / near / far /
  aspect, plus the `mode="2d"` orthographic `size`) → asserted NDC coordinates of
  world points.
- **`parse.json`** — markup snippets → the typed IR shape, every attribute
  DEFAULT pinned, hole retention, and Article-7 fallback diagnostics.
- **`model.json`** (P4) — base64 GLB fixtures → the parsed model: mesh
  vertex/index counts, positions/normals to 6 decimals, `baseColorFactor`, the
  node-hierarchy draw list (world matrices), a transformed vertex, and the error
  VALUES (`not-glb`, `external-buffer`). GLB byte layout below.
- **`text3d.json`** (P4) — the billboard-quad layout law: quad center +
  half-extents from `value`/`size`/`position`. Geometry ONLY — never glyph
  pixels (the honest scope line below).
- **`frame.json`** (P4) — the `on:frame` contract as data: raw tick timestamps →
  the emitted `{ dt, elapsed, frame }` payloads under the 60/s budget law.
- **`animation.json`** (P5) — the animation system: tween samples (each easing at
  pinned times, delay, loop wrap, pingpong reflection, spring convergence,
  componentwise vector + linear-RGB color), the `when` gate fold, and the
  transition RETARGET fold (base changes mid-flight start from the pinned
  mid-flight value).
- **`bind.json`** (P5) — data-driven children as data: row keying (the `<list>`
  law), the keyed diff across reorder, per-row `item.*` hole resolution, nested
  binds, the 256-row cap.
- **`collide.json`** (P5) — the collision depth laws (sphere/AABB pairs), the
  rotated-box world AABB, and the enter/separate sequencing fold.
- **`orbit.json`** (P5) — `controls="orbit"`: the spherical camera law, drag and
  zoom folds producing pinned camera positions.
- **`lighting.json`** (P5) — point-light attenuation, the extended lit-color
  fold, the 4-light cap, and linear fog factors/blends.
- **`physics.json`** (G2, dsx-game.md §2) — the fixed-tick solver as data:
  extraction worlds (markup → body records), full simulations (free fall,
  resting convergence, the restitution ladder, friction, kinematic push,
  character move-and-slide/jump/grounded, triggers, sleep/wake, teleport,
  layers, the 120-tick determinism replay), the 5-step accumulator fold, and
  interpolation. The G2 laws below.
- **`skin.json`** (G3, dsx-game.md §2) — the skeletal pipeline as data: GLB
  skin/clip/JOINTS_0/WEIGHTS_0 extraction (two hand-built base64 fixtures, byte
  layout below), joint matrices for a 3-joint hierarchy, vertex skinning (incl.
  the 2-influence and renormalization cases), clip sampling (LINEAR t/r/s,
  wrap + clamp, STEP hold, the slerp shortest-path flip, the nlerp branch),
  crossfade blends at pinned ramp values, the mixer fold (initial hard cut ·
  crossfade switch · unknown-clip diagnostic · fade-to-bind), and the
  `<model animation loop blend>` prop grammar. The G3 laws below.
- **`prefab.json`** (G1, dsx-game.md §2) — components as prefabs inside `<scene>`
  subtrees: instance expansion to the implicit group root, transform inheritance
  across the component boundary (pinned world matrices), attribute
  parameterization (scope-first hole resolution, declared defaults, instance-site
  evaluation), the multi-root implicit group, per-instance scope isolation,
  nested prefabs, the scene-content gate and depth-limit diagnostics, and the
  keyed spawn/despawn leg over the P5 bind machinery. The G1 laws below.
- **`sprite.json`** (G6, dsx-game.md §2) — the 2D engine as data: the `<sprite>` quad
  (anchor offsets, the texture-aspect size default, the malformed fallbacks), the sheet
  UV rectangle per frame index (single-row AND 2-D packed, `flip` mirroring, the
  out-of-range clamp), the frame grammar, the fps→index fold (loop wrap and the
  `loop="false"` hold), the 2D conventions (a 2-number `position`, the z draw order),
  the extracted sprite colliders, and the Z-LOCK simulations (a 2D body keeps its z
  EXACTLY; the same body in 3D drifts). The 2D laws below.

All floats are stored to 6 decimals; runners compare with tolerance 1.5e-6.

## The composition law (the one to memorize)

- Matrices are **column-major** mat4 (index = column·4 + row), vectors are
  columns (v′ = M·v).
- A node's local matrix composes **scale, then rotate, then translate**:
  `local = T · Rz(rz) · Ry(ry) · Rx(rx) · S` — the authored
  `rotation="rx ry rz"` triple is degrees, applied to the object **X first, then
  Y, then Z** (so the combined rotation matrix is Rz·Ry·Rx).
- `world = parentWorld · local`, root downward.
- View space is right-handed lookAt (up = +Y); projection is the GL convention,
  NDC z ∈ [−1, 1]; `mode="2d"` is the SAME graph under an orthographic camera
  whose `size` word is the vertical half-extent (half-width = size·aspect).
- Vectors are space-separated triples; JSE holes (`{{ expr }}`) interpolate
  before numeric parsing (each case's `vars` map is the resolver — the live
  store plays that role at runtime).
- **Failure is a value** (constitution Article 7): a malformed triple/scalar
  falls back to that attribute's default with exactly one diagnostic; an unknown
  tag inside `<scene>` is skipped with one diagnostic. Never a crash, never a
  blank scene.

## The P4 laws (model · text3d · textures · on:frame)

Pinned 2026-08-07 with the P4 landing (web + both JVM lanes; Swift is the NAMED
follow-up — the dsx-scene.md P4 row records it):

- **glTF/GLB, embedded buffers only.** `<model src>` consumes glTF 2.0 BINARY
  (GLB). v1 reads the embedded BIN chunk only — a buffer carrying a `uri`
  (external `.bin`, data URI) is the **named absence**, surfaced as the
  `external-buffer` error value (Article 7: a broken container parses to an
  error code — `not-glb` / `external-buffer` / `malformed` — never a throw).
  Supported: POSITION/NORMAL f32 VEC3, u8/u16/u32 indices (non-indexed
  synthesizes 0..n−1), `pbrMetallicRoughness.baseColorFactor` (default
  [1,1,1,1]), triangle mode only, node `matrix` or T·R(quaternion)·S. Model
  TEXTURES (glTF images/samplers), skins, animations and sparse accessors are
  named absences too — flat baseColor is the v1 material. The renderer's model
  matrix is `sceneWorld · draw.world` (the P1 `world · S(geometry)` law with the
  glTF node transform in the geometry-local seat).
- **The text3d quad law.** Height = `size` (default 0.5 scene units); width =
  `size × 0.6 × characterCount` (0.6 is the LAW's fixed per-character advance;
  characters are Unicode CODE POINTS — the surrogate-pair case pins it); the
  quad centers on `position`; empty value → no quad. **The billboard law:** the
  quad always faces the camera (orientation derives from the view matrix at
  draw time, so it is runtime behavior, not layout corpus). **Honest scope
  line:** the corpus pins the QUAD GEOMETRY only — glyph pixels are rasterized
  by each platform's own text stack (canvas 2D · android.graphics · java.awt ·
  Core Text) and deliberately unpinned; fonts differ per platform.
- **The texture UV law** (`texture="url"` on box/sphere/plane — a pixel-space
  law the JSON corpus cannot carry, so it is pinned HERE and enforced by each
  lane's pixel tests): sampling is NEAREST texel, coordinates clamped to the
  edge. Plane and every box face map their local face coordinates as
  `u = x_face + 0.5`, `v = 0.5 − y_face` (texel row 0 is the image's TOP, so
  the image reads upright on a +Z-facing surface). The sphere maps longitude
  and latitude: `u = φ / 2π` (the +X meridian at 0, advancing toward +Z),
  `v = θ / π` (0 at the +Y pole). The sampled texel MODULATES the material
  color (`color × texel × lighting`), matching the flat-Lambert model on all
  lanes. **Honest scope line:** the corpus pins the mapping law as prose + the
  per-lane pixel tests; cross-renderer texel-exact parity is NOT claimed (the
  P2 rasterizer stance, verbatim).
- **The on:frame budget law.** At most 60 emitted ticks/second — a raw platform
  tick arriving under 1000/60 ms after the last EMITTED tick coalesces into the
  next one. Payload `{ dt, elapsed, frame }` (seconds / seconds since first
  tick / emitted counter from 0), dispatched through the SAME runner path as
  `on:tap`. The loop exists ONLY while an `on:frame` handler is authored and
  the element is mounted — a static scene runs no loop (the P1 law stands), and
  unmounting stops it. `frame.json` pins the schedule math; each surface's own
  tests pin the lifecycle (a data corpus cannot mount elements).

## The P5 laws (animations · bind · collide · orbit · lighting)

Pinned 2026-08-07 with the P5 landing (web reference; Kotlin/Swift are the NAMED
follow-up — the dsx-scene.md P5 row records it):

- **The animation override law.** An animation produces a value that OVERRIDES
  the authored/bound base value of ONE property while active; when it ends, the
  property returns to base (or holds, per `fill="hold"`). The animatable set is
  CLOSED: `position · rotation · scale` (vec3) · `color` (linear-RGB triple) ·
  `intensity · fov` (scalars); **opacity is a named absence** (no material
  opacity channel). Vector and color properties interpolate COMPONENTWISE —
  colors on the LINEAR-RGB plane (sRGB channels linearized by the IEC 61966-2-1
  curve before the lerp, delinearized to #hex only as the 8-bit last step).
- **Implicit transitions** — `transition="position 300ms ease-out, color 200ms"`
  on any scene node (entries `<property> <duration> [easing] [delay]`, split on
  top-level commas so `spring(100,10)` keeps its comma): when the property's
  resolved BASE value changes, the rendered value RETARGETS from its CURRENT
  RENDERED value to the new base over the duration — the CSS transition model:
  **interrupt = start from where you are, never snap, never queue**. The entry's
  delay HOLDS the pre-change value. This makes `dsx.variable.x = 5` glide.
- **Explicit tweens** — `<animate target from to duration delay easing loop when
  fill on:done/>` as a CHILD of the node it animates. `from` defaults to the
  base value at clip start. `duration`/`delay` accept `ms`/`s`/bare-ms. `loop`:
  `false` (one clip) · `true` (infinite; u = 0 at the exact wrap instant) ·
  `N` (N clips; **on:done fires ONCE at completion, never per iteration**) ·
  `"pingpong"` (infinite; odd cycles sample the easing at `clip − u` — the same
  curve traversed backwards). Delay applies ONCE, before the first cycle; during
  it the property shows base. `when` is a JSE-bindable gate: truthy = playing;
  **becoming falsy stops at base** (no on:done); each falsy→truthy edge RESTARTS
  the clock. An active explicit tween WINS over an implicit transition on the
  same property.
- **Easing is pinned math.** `linear`; the CSS cubic-bezier constants —
  `ease` (0.25, 0.1, 0.25, 1) · `ease-in` (0.42, 0, 1, 1) · `ease-out`
  (0, 0, 0.58, 1) · `ease-in-out` (0.42, 0, 0.58, 1) — solved by EXACTLY 60
  bisection iterations on the x-axis (deterministic on every IEEE-double
  runtime); and `spring(stiffness, damping)` (defaults 100, 10), the analytic
  mass-1 damped spring from 0 to 1 with zero initial velocity, evaluated on the
  REAL clock in seconds: ωₙ = √stiffness, ζ = damping/(2√stiffness);
  ζ<1: `1 − e^(−ζωₙt)·(cos(ω_d t) + (ζωₙ/ω_d)·sin(ω_d t))`, ω_d = ωₙ√(1−ζ²);
  ζ=1: `1 − e^(−ωₙt)(1 + ωₙt)`; ζ>1: `1 − (s₂e^(s₁t) − s₁e^(s₂t))/(s₂ − s₁)`,
  s₁,₂ = −ζωₙ ± ωₙ√(ζ²−1). **A spring clip IGNORES `duration`**: it completes at
  the settle time `T = ln(1000)/(ωₙ·(ζ − √max(0, ζ²−1)))` (the envelope's 0.1%
  point), where progress clamps to exactly 1 — ending never snaps.
- **Determinism.** value(t) is a pure function of the spec + start state —
  `animation.json` pins sampled values at fixed times to 6 decimals. The RUNTIME
  law (surface-tested): animations ride the EXISTING kernel frame clock, and the
  loop runs ONLY while at least one animation is active or an on:frame handler
  exists — the zero-cost static-scene law survives.
- **The total-resolve law** (the override plane's reach): an UNAUTHORED
  attribute still consults the resolver, carrying its formatted DEFAULT as the
  raw value — a pure hole-interpolating resolver returns it unchanged
  (numerically identical to the old early-return), while a renderer's override
  plane can animate properties the author never wrote.
- **The bind laws** — `<group bind="expr" key="field">`: template children
  instantiate once per array row; row scope binds `item.*` exactly like `<list>`
  (a row node's handlers run in the row scope, so on:tap carries the row item);
  keys are `String(row[keyField] ?? index)` for dicts / `String(row)` for
  scalars, duplicates suffixed `·n`; a key kept across a reconcile keeps its
  instantiated subtree (identity survives reorder); removing a row removes its
  subtree AND STOPS ITS ANIMATIONS; rows cap at 256 with one diagnostic; nested
  binds are full rows of rows.
- **The collide laws** — opt-in via `collide="sphere"` (the picking bounding
  sphere verbatim) or `collide="box"` (world AABB of the local half extents —
  box `size/2` · sphere `radius` · plane `[w/2, h/2, 0]`). Depths: sphere↔sphere
  `ra + rb − |ca−cb|`; box↔box needs every axis overlap > 0, depth = the
  smallest; sphere↔box clamps the center to the box (outside: `r − dist`;
  center inside: `r + nearest-face distance`). **Depth 0 is NOT a contact.**
  **The enter law:** `on:collide` fires on overlap START ({id, other, depth},
  both directions) and again only after the pair has separated. **The runtime
  law:** the pass rides each RENDERED frame while an on:collide handler is
  authored — nothing moves without a render, so a static scene pays nothing.
- **The orbit laws** — `controls="orbit"` on `<camera>`: spherical coordinates
  around look-at (`pitch = asin(y/d)`, `yaw = atan2(x, z)`, yaw 0 on +Z); drag:
  `yaw −= dx·0.4°/px`, `pitch += dy·0.4°/px` clamped ±89°; zoom:
  `distance ×= e^(deltaY·0.0015)` clamped `[max(near, 1e-3), far]`. A drag
  suppresses the click-pick that follows it.
- **The lighting laws** — `<light kind="point" position color intensity range>`
  (range default 10, root-level lights only): attenuation
  `window²/(1 + d²)` with `window = max(0, 1 − (d/range)⁴)` — 1 at d = 0,
  exactly 0 at and past range; lit = `base · (ambient + dirColor·max(0, n·dirL)
  + Σ colorᵢ·intensityᵢ·att(dᵢ)·max(0, n·Lᵢ))`, channels clamped to [0, 1];
  **cap 4 point lights** (first in document order, extras drop with one
  diagnostic). Fog: `fog="#color near far"` on `<scene>` (far > near or the
  whole attribute rejects): `f = clamp((far − d)/(far − near), 0, 1)` for
  d = eye→fragment; `final = f·lit + (1 − f)·fogColor`.

## The G2 laws (physics — dsx-game.md §2, corpus `physics.json`)

Pinned 2026-08-07 with the G2 landing (web reference + corpus; the Kotlin and
Swift twins landed the same day — the fixed-tick solver now runs on all four
renderers, corpus-locked). Every constant
below is also carried as data in `physics.json` `constants`, and the TS runner
asserts them against the kernel exports.

- **The fixed-tick law.** The simulation steps at EXACTLY 60 Hz — `dt = 1/60 s`
  — decoupled from rendering; the renderer INTERPOLATES body positions between
  the last two steps (`rendered = prev + (curr − prev)·alpha`,
  `alpha = accumulator/dt`). `on:tick` fires per fixed step with
  `{ dt: 1/60, tick: n }` (tick is the ZERO-based completed-step index);
  `on:frame` stays render-rate. **The accumulator law:**
  `acc = min(acc + frameDt, 5·dt)` — the **5-step cap** is the spiral-of-death
  guard and DISCARDS the excess (the sim slows, never death-spirals);
  `steps = floor(acc/dt); acc −= steps·dt; alpha = acc/dt`.
- **The determinism law.** Same initial state + same inputs → identical states
  to 6 decimals on every runner: all solver math in DOUBLE precision, fixed
  document-order iteration, only `+ − × ÷` and `sqrt` (never `hypot` in the
  solver — sqrt of a sum of squares is identically rounded on every IEEE
  runtime; hypot is not so pinned), no wall clock, no random. The corpus replay
  case runs twice and demands BIT-identical end state.
- **The body laws.** `physics="static|dynamic|kinematic|character"` on
  box/sphere/plane/model (any other word/tag: not a body, one diagnostic).
  Static: invMass 0. Dynamic: invMass = 1/mass (`mass` default **1**; ≤ 0 or
  malformed → 1 + diagnostic). Kinematic: follows its authored/bound/animated
  transform each step; push velocity DERIVED (`Δp/dt`, 0 when undriven);
  unaffected by dynamics. Character: move-and-slide (`speed` default **5**,
  `jump` default **8** — the declared jump speed; G4 unified input is its named
  consumer); infinite mass against dynamics (pushes them); NEVER sleeps;
  character↔character is a named non-interaction. `bounce` default **0**
  (clamped 0..1), `friction` default **0.5** (clamped ≥ 0).
- **The angular law.** Dynamic bodies carry DSX Euler `rotation` in degrees and
  world `angular-velocity` in radians/second, with a normalized quaternion as
  the solver orientation. Persistent world `torque` integrates angular momentum
  against diagonal solid-shape inertia: sphere
  `I = 2/5·m·r²`; box `Ix = m/3·(hy²+hz²)` and axis permutations. Then linear
  angular damping applies `L *= max(0, 1 − angularDamping·dt)`, quaternion
  orientation advances by the world angular-velocity exponential map, and world
  `ω = Iworld⁻¹·L` is recomputed. Euler output chooses the equivalent branch
  nearest its prior value. Default damping is **0**. In `mode="2d"`, authored
  X/Y rotation stays locked and only Z angular inertia/impulses participate.
- **The collider laws.** `collider="auto"` (default) derives at EXTRACTION from
  the authored WORLD transform: `<sphere>` → bounding sphere (radius × largest
  world basis); box/plane/model-bounds → conservative world OBB (center =
  transformed local center, half = the projection of all eight transformed
  corners onto a stable orthonormal root frame; a model uses its loaded
  draw-transformed bounds,
  `[0.5 0.5 0.5]` until known). Explicit `collider="sphere"|"box"` overrides
  per the P5 collider laws; another word → auto + one diagnostic. **The freeze
  law:** extents derive ONCE; orientation then follows the solver quaternion.
  Box contacts use 15-axis OBB SAT, clipped face manifolds or selected support
  edges, and contact-point angular impulses with deterministic warm starting.
  **Capsule colliders are a named absence.** Bodies are ROOT-FRAME citizens: a
  transformed ancestor draws one diagnostic and the body simulates in
  scene-root space. Bodies without an `id` get `#N` (1-based, extraction
  order).
- **The step order** (pinned by `physics.json` `_note` plus `_angular_law`):
  1 scene-root kinematic pose drive (`v = Δp/dt`; world `ω` from shortest-arc
  quaternion delta) · 2 character intent (`v.xz = move·speed`, normalized only
  when |move| > 1) · 3 awake-body linear integration (`v += g·dt`, then
  `x += v·dt`) and dynamic angular-momentum/quaternion integration · 4 contact
  discovery in document pair order, coherent warm start, **32 global sequential
  impulse iterations**, then positional correction · 5 character
  move-and-slide · 6 trigger overlap · 7 events · 8 sleep · 8.5 mode-2D lock
  plus stale-cache eviction · 9 tick increment. Gravity defaults to
  **0 −9.81 0**; malformed scene gravity falls back with one diagnostic.
- **The contact laws.** Depths are the P5 collide corpus verbatim (depth 0 is
  NOT a contact); normals point from the FIRST body toward the SECOND:
  sphere↔sphere along the center line (`[0 1 0]` when coincident); sphere↔OBB
  from the oriented clamped point toward the sphere center (center inside: the
  nearest face); OBB↔OBB uses all 15 SAT axes in fixed order. A face-axis winner
  clips the deterministic support faces and reduces to at most four
  provenance-keyed points; an edge-axis winner uses closest points on its two
  selected support edges.
- **The impulse law.** At every manifold point, relative velocity is
  `(vB + ωB×rB) − (vA + ωA×rA)`. Restitution only resolves approach along `n`.
  Restitution `e = max(bounceA, bounceB)`, but 0 when the approach speed
  is ≤ 0.5 (**the micro-bounce guard**). Each constraint accumulates a
  non-negative normal impulse and a vector tangent impulse capped to the
  Coulomb disc `|λt| ≤ sqrt(frictionA·frictionB)·λn`. The private warm cache
  reuses them only when feature provenance, normal and both body-local anchors
  stay coherent; changed/teleported bodies invalidate their entries.
- **The correction law** (Baumgarte): `0.8 · max(depth − 0.005, 0)/(invA+invB)`
  along the normal by invMass share — **percent 0.8, slop 0.005, pinned**.
- **The character laws.** Move-and-slide vs static/kinematic only: up to **4
  iterations**, each resolving the DEEPEST contact by FULL depenetration (no
  slop) + velocity projection (`v −= n·(v·n)` only when moving INTO the
  surface — the "slide along the wall" law); **grounded = any resolving surface
  normal with up.y > 0.7 (pinned)**, re-evaluated every step.
- **The sleep law.** A dynamic body with both `|v| < 0.05` and `|ω| < 0.05`,
  and zero persistent torque, for **60 consecutive ticks** sleeps (linear and
  angular velocity zeroed, integration skipped); it wakes on a velocity
  write, a teleport, or ENERGETIC contact-point surface motion, including
  `ω×r` from a pure rotating collider. A stationary kinematic platform never
  wakes its sleeper. A sleeper stays in every manifold as an immutable support:
  warm-start, normal, friction, angular and correction terms use zero effective
  mass/inertia without changing its stored physical mass. An awake body already
  accumulating quiet sleep ticks cannot wake a neighbour solely from its one
  pre-solve gravity step; a real impact or explicit write resets that count. A
  kinematic position **or rotation** write wakes sleeping bodies (v1 has no
  island graph). Pair keys join ids with NUL (`\u0000`) on every runner. The
  pinned five-box pile has all bodies asleep by tick 148; the staggered
  game-sized three-crate pile converges by tick 161. Both sample bounded results
  at tick 200 and remain bit-still with zero linear/angular velocity through
  tick 300.
- **The write laws** (the override plane's G2 half). While a body is dynamic or
  character its rendered `position` is SOLVER-OWNED (an interpolated override);
  the authored/bound base holds the SPAWN pose. A base write to `position`
  (store, bus `set`) **TELEPORTS** the body — velocity reset to zero, no
  interpolation and no `transition=` glide across a teleport. A write to
  `velocity` sets it verbatim (the attribute-shaped impulse verb — `jump()` IS
  `set velocity "0 <jump> 0"` through the bus). Rotation, angular-velocity and
  torque writes follow the same wake law; a rotation write resets hidden spin.
- **The trigger law.** `trigger="true"` bodies exert and receive NO forces;
  overlap start fires `on:enter`, separation fires `on:exit` (the P5
  enter-tracker semantics, both directions `{id, other}`; exits in prior
  insertion order). `on:collision` fires on SOLID overlap start the same way.
- **The layer law.** `layer` defaults to `"default"`; `collides` unset =
  everything collides (progressive exposure); a pair collides only when each
  side's `collides` list (if set) contains the other's layer.
- **The runtime law** (surface-tested + walk-verified, not corpus-carriable):
  the fixed-tick accumulator rides the ONE existing frame loop, which now also
  exists while any dynamic body is AWAKE or any character exists — a
  fully-asleep world stops the loop (and `on:tick` with it), and a static scene
  still runs none. `on:tick`/`on:collision`/`on:enter`/`on:exit` dispatch
  through the SAME runner path as `on:tap`.

## The G3 laws (skeletal — dsx-game.md §2 G3, corpus `skin.json`)

Pinned 2026-08-08 with the G3 landing (all three kernels in the same wave: TS
reference + Kotlin :core + Swift record lane — the dsx-game.md G3 record). Every
constant below is also carried as data in `skin.json` `constants`, and each
runner asserts them against its kernel's exports.

- **The parse-extension law.** `parseGlb` also retains the NODE FOREST (base
  TRS + `matrix` + children + mesh/skin references), `skins` (joints +
  inverseBindMatrices — an ABSENT IBM accessor is identity per joint),
  `animations` as NAMED CLIPS, and JOINTS_0/WEIGHTS_0 vertex attributes.
  JOINTS_0 (u8/u16) reads RAW; integer-typed WEIGHTS_0 normalizes by 255/65535
  (the glTF normalized law — the flag is not consulted). A channel that is not
  translation/rotation/scale (weights/morphs) or not LINEAR/STEP
  (**CUBICSPLINE is the named absence**) DROPS silently at parse, and a clip's
  `duration` folds over the KEPT channels only. An unnamed animation is named
  by its zero-based index (`"0"`). Each draw carries its referencing node
  index + skin (null = unskinned).
- **The joint-matrix law.** `jointMatrix[i] = inverse(meshNodeWorld) ·
  globalJointTransform[i] · inverseBindMatrix[i]`. Node worlds compose over the
  FULL retained node forest — parent = the unique referencing node, an
  unreferenced node is a root; a pose channel overrides the base TRS PER
  PROPERTY (an unanimated property stays base); a matrix-authored node with no
  pose entry uses its matrix verbatim. A singular mesh-node world inverts to
  identity (failure is a value, Article 7).
- **The skinning law.** `skinnedPos = Σ w[i] · jointMatrix[i] · pos` over the
  4 influences. Weights renormalize by their sum whenever it differs from 1;
  a sum at or below **weightEpsilon = 1e-6** passes the vertex through
  untransformed. Skinned vertices live in MESH-NODE space and draw with the
  mesh node's world (the inverse leg cancels it — the glTF convention).
- **The clip-sampling law.** Time wraps by `loop`: true = modulo duration
  (`t − floor(t/d)·d`), false = clamp to [0, duration]; a non-positive
  duration is always 0. Channel sampling is keyframe INTERVAL SEARCH: at/before
  the first key the first value, at/after the last key the last; between keys,
  LINEAR lerps translation/scale componentwise and slerps rotation
  quaternions — SHORTEST PATH via the dot-sign flip (a negative dot negates
  the right key), falling back to normalized lerp when the dot exceeds
  **slerpNlerpThreshold = 0.9995** (the near-parallel branch); STEP holds the
  LEFT key.
- **The crossfade law.** `progress = clamp(elapsedMs / blendMs, 0, 1)`;
  **blendMs ≤ 0 is the hard cut** (progress exactly 1 —
  `defaultBlendMs = 0`). A blended pose lerps t/s componentwise and slerps r,
  per node over the UNION of both poses (a side missing a node reads its base
  TRS).
- **The mixer law** (the crossfade state machine every renderer drives): the
  INITIAL clip assignment applies WITHOUT a fade (the mount law); switching
  `animation` starts ONE crossfade — the out-clip keeps its own CONTINUING
  clock, the in-clip's clock starts at the switch; a mid-fade switch DROPS the
  older fade (the out-clip is the clip that was current); an unknown clip name
  draws one `unknown-clip` diagnostic and KEEPS the current clip (Article 7);
  the EMPTY name is the BIND POSE (an empty pose — crossfaded like any clip).
  A per-frame update with an unchanged name is a no-op.
- **The prop grammar** (`<model>` only): `animation` is the clip NAME,
  hole-interpolated like every scene prop ("" = bind pose); `loop` is
  `true` (**defaultLoop = true**) or `false`, any other word → true + one
  diagnostic; `blend` takes the P5 duration grammar (`ms`/`s`/bare-ms),
  malformed → 0 + one diagnostic.
- **The runtime law** (surface-tested, not corpus-carriable): the mixer rides
  the ONE existing frame loop — **the loop-existence law extended again**: the
  loop also runs while any model has an ACTIVE clip or crossfade, and a
  finished non-looping clip with no crossfade lets it stop. CPU skinning feeds
  each renderer's existing draw path (recomputed flat facet normals — the
  raster stance); **GPU skinning is the named perf upgrade**.

## The skin.json fixture byte layout

Built by an independent scratch script (never by a kernel under test),
little-endian throughout, the model.json container conventions:

- **`fixtures.skinned`** — 4 nodes (0 = mesh+skin, 1→2→3 = a 3-joint chain,
  each child at (0,1,0)); skin joints [1,2,3] with IBMs I · T(0,−1,0) ·
  T(0,−2,0); one primitive: 4 f32 positions, u8 JOINTS_0, f32 WEIGHTS_0
  (incl. the 0.5/0.5 two-influence vertex and the 0.25 renormalization
  vertex), u16 indices; two named clips — `wave` (LINEAR: node-2 rotation
  0°→90°z→0° over [0, 0.5, 1.0] + node-1 translation over [0, 1]; duration
  1.0) and `spin` (STEP: node-1 rotation about Y over [0, 0.4, 0.8]; duration
  0.8).
- **`fixtures.skinnedWide`** — the format-coverage twin: u16 JOINTS_0 with
  normalized-u8 WEIGHTS_0 (128/127 → 0.501961/0.498039) on one primitive and
  normalized-u16 WEIGHTS_0 (49152/16384 → 0.750011/0.250004) on the other;
  a skin with NO inverseBindMatrices accessor (the identity law); one UNNAMED
  animation (→ name `"0"`) whose CUBICSPLINE channel (input to 2.0 s) drops
  while its LINEAR channel (input to 0.6 s) stays — duration 0.6 proves both
  the drop and the kept-channels-only duration fold.

## The G1 laws (prefabs — dsx-game.md §2 G1, corpus `prefab.json`)

A **prefab IS a `<component>`** whose body is scene content — no second concept.
The kernel owns only the STRUCTURAL law; each renderer's `<scene>` element
derives definitions from its OWN component registry and hands `parseScene` a
lookup (`tag → def | null`) — the kernel never learns a component name
(constitution rule 18: the lookup is the seam).

- **The expansion-root law** — an instance tag ALWAYS expands to one implicit
  `group` carrying the instance's transform words (`position`/`rotation`/
  `scale`) and `id`; the body roots become its children. Instance transforms
  therefore COMPOSE with body-authored transforms (never clobber), and the
  scope boundary is a node boundary.
- **The scope law** — every non-reserved, non-transform, non-handler instance
  attribute enters the instance scope RAW; declared `<attribute>` params
  missing from the instance fall to their declared default string. Scope
  values resolve at the INSTANCE SITE (the enclosing scope); body holes
  resolve SCOPE-FIRST (an expr that is exactly a scope key reads the
  per-instance value), everything else falls through to the outer plane.
  Reserved words never in scope: `id`, `__css`, `css-owner`, `slot`, `bind`,
  `key`, `on:*`.
- **The scene-content gate** — every body root must be a scene tag or itself a
  prefab; otherwise ONE `prefab-not-scene` diagnostic and the WHOLE instance
  skips (Article 7 — never a phantom, never a crash).
- **The depth law** — expansion nests at most **8** levels
  (`SCENE_PREFAB_DEPTH_LIMIT`); deeper skips with ONE `prefab-depth`
  diagnostic (the runaway self-reference guard).
- **The definition law** — a definition derives from the component TEMPLATE: a
  bare scene root is the single body root; any other root is a WRAPPER whose
  non-declaration children are the roots and whose head/declaration
  `<attribute as default>` entries are the params.
- **The instantiation law** — a spawned `<group bind>` row instantiates the
  prefab with FRESH node identities sharing the raw scope (per-instance state
  by construction); removing the row despawns it through the standing P5/G2
  machinery (animations and physics bodies cleaned up). A LIVE scope change
  (an instance param re-resolving) reaches every already-spawned row — rows
  never keep the scope values they were born with.
- **The defining-scope law** — a def may carry its OWN lookup (the corpus
  spells it as a per-component `components` sub-table): body tags resolve
  where the component was DECLARED, exactly as component expansion outside
  scenes; absent means the instance site's lookup (flat registries).
- **The bare-root head law** — a bare scene root may carry its `<head>` as a
  child (registries that keep templates verbatim): declarations are scanned
  for params AND stripped from the body there too.
- **The say-so law** — `bind`/`key`/`on:*` on an INSTANCE tag do nothing, and
  ONE `prefab-ignored` diagnostic says so (spawning is `<group bind>` around
  the instance; handlers live inside the component body).

## The GLB fixture byte layout (model.json `fixtures.twoMesh`)

Built by an independent scratch script (never by a kernel under test), 1500
bytes total, little-endian throughout:

- **Header** (12 B): magic `0x46546C67` ("glTF") · version `2` · total length.
- **JSON chunk**: length + type `0x4E4F534A` ("JSON"), space-padded to 4 B —
  two meshes, two materials, two nodes (node 0: mesh 0, no transform; node 1:
  mesh 1, translation (1,2,3), quaternion (0,0,sin45°,cos45°) = 90° about +Z,
  scale (2,1,1)), one scene listing both.
- **BIN chunk** (188 B): length + type `0x004E4942` ("BIN\0"), then
  - `@0` triangle positions, 3×vec3 f32: (0,0,0) (1,0,0) (0,1,0)
  - `@36` triangle normals, 3×vec3 f32: (0,0,1) ×3
  - `@72` triangle indices, 3×u16: 0 1 2 (+2 pad bytes)
  - `@80` quad positions, 4×vec3 f32: (±0.5, ±0.5, 0) counter-clockwise
  - `@128` quad normals, 4×vec3 f32: (0,0,1) ×4
  - `@176` quad indices, 6×u16: 0 1 2 0 2 3

Materials: mesh 0 `baseColorFactor` [0.8, 0.2, 0.1, 1], mesh 1
[0.2, 0.4, 0.9, 1]. `fixtures.externalBuffer` is a JSON-chunk-only GLB whose
buffer names `model.bin` (the named-absence probe); `fixtures.notGlb` is plain
text (the bad-magic probe).

## The 2D laws (sprites — dsx-game.md §2 G6, corpus `sprite.json`)

Pinned 2026-08-08 with the G6 landing (all three kernels in the same wave: TS reference +
Kotlin :core + Swift record lane — the dsx-game.md G6 record). Every constant below is
also carried as data in `sprite.json` `constants`, and each runner asserts them against
its kernel's exports. Before this rung `mode="2d"` was an orthographic CAMERA and nothing
else; the answer to "is DSX 2D ready?" is these laws.

- **The quad law.** `<sprite src size position rotation scale color anchor flip>` lays
  out a TEXTURED QUAD in the node's LOCAL XY plane facing +Z, riding the node's world
  transform exactly like `<plane>` — so transforms, `bind`, `<animate>`, prefabs and
  physics all already apply (a sprite is a scene NODE KIND, not a second graph). In
  `mode="2d"` that IS camera-facing, because the orthographic camera looks down −Z.
  **BILLBOARDING IN 3D IS A NAMED ABSENCE** — an authored `rotation` keeps meaning what
  it means everywhere else. The texel MODULATES `color` (the P4 texture law verbatim)
  and a texel with alpha < 0.5 is CUT OUT — the sprite's silhouette, the text3d cutout
  path verbatim. An authored `src` draws NOTHING until its texture arrives (the
  `<model>` posture); a src-less sprite is an honest flat `color` rectangle.
- **The size default.** `size="w h"` is scene units. UNAUTHORED, height = 1
  (`defaultHeight`) and width = the TEXTURE ASPECT (image width/height) at that height —
  1 (a square) when the texture is unknown or still loading. An authored size WINS over
  the aspect; a malformed one falls back to `1 1` with one diagnostic.
- **The anchor law.** `anchor` names WHICH POINT OF THE QUAD `position` names: `center`
  (default) · `top` · `bottom` · `left` · `right` · `top-left` · `top-right` ·
  `bottom-left` · `bottom-right`. The quad CENTER sits at `(−ax·w, −ay·h, 0)` from the
  node origin with ax ∈ {−½ left, 0 center, +½ right} and ay ∈ {+½ top, 0 center,
  −½ bottom}. An unknown word → `center` + one diagnostic.
- **The sheet law.** `frames` is the sheet GRID: ONE number N = a SINGLE ROW
  (`cols = N, rows = 1`); TWO numbers = `"cols rows"` EXPLICITLY. **The kernel NEVER
  guesses a grid — `cols = ceil(√N)` is WRONG and is not the law**; a 2-D packed sheet
  must spell its columns and rows. Unauthored = 1×1 (the whole texture); a fraction, a
  value < 1, three numbers or a word → 1×1 + one diagnostic. The UV RECTANGLE of frame
  `n` is ROW-MAJOR (left→right, then top→bottom): `col = n mod cols`,
  `row = floor(n / cols)`, `u0 = col/cols`, `u1 = (col+1)/cols`, `v0 = row/rows`,
  `v1 = (row+1)/rows` — **v0 is the frame's TOP edge** (texel row 0 = the image's top,
  the P4 UV law verbatim). `flip` mirrors that rect: `""` (default) or any arrangement
  of the letters x and y (the word is a SET — `"yx"` IS `"xy"`), `x` swapping u0/u1 and
  `y` swapping v0/v1; any other word → no mirror + one diagnostic.
- **The frame law.** `frame` is the 0-based index, hole-bound like every scene prop (a
  store write animates it). The resolved value FLOORS, then CLAMPS into
  `[0, cols·rows − 1]` with one diagnostic when it was out of range (Article 7); a
  malformed value falls back to 0 with one diagnostic (the shared malformed-number law).
- **The fps law.** `fps` > 0 AUTO-ADVANCES on the SAME frame clock the P4 `on:frame`
  budget rides — **never a second loop**: `advanced = floor(elapsedSeconds × fps)`, with
  `loop="true"` (the default) wrapping `index = advanced mod total` and `loop="false"`
  holding `index = min(advanced, total − 1)`; a non-positive elapsed reads frame 0.
  **A positive `fps` OWNS the index — `frame` is not read.** fps ≤ 0 (unauthored) means
  no auto-advance; malformed diagnoses once and does the same. **The loop-existence law,
  extended again** (surface-tested, not corpus-carriable): the ONE frame loop also runs
  while some sprite has `fps` > 0 and either loops or has not reached its last frame.
- **The 2D conventions law.** In `mode="2d"`: the camera is ORTHOGRAPHIC with `size` the
  VERTICAL half-extent (half-width = size·aspect — the P1 law, unchanged); **+Y is UP**;
  **z is the DRAW ORDER** — higher z draws IN FRONT: `sceneDrawOrder2d` sorts world z
  ASCENDING with a STABLE sort (equal z keeps document order) and each renderer paints in
  that order with depth testing OFF (the painter's algorithm — so coplanar sprites layer
  instead of z-fighting); and `position` accepts a PAIR `"x y"` meaning **z = 0** (a
  triple still means what it always did). **Every OTHER vector word — rotation, scale,
  velocity — stays a triple, a NAMED ABSENCE**, and outside 2D a 2-number position is
  malformed exactly as before. **There is NO pixel-space mode**: units stay scene units,
  and a `size` of half the viewport height in units IS the 1 unit = 1 pixel mapping
  (progressive disclosure).
- **The z-lock physics law.** `physics=` on a `<sprite>` runs through the EXISTING G2
  solver — **there is no second solver**. A `mode="2d"` world carries a Z-LOCK: every
  body records `zLock` = its initial world z and `vzLock` = its initial z velocity at
  world creation, and the LAST act of every step (after the sleep pass, before the tick
  advances) re-pins `position.z = previous.z = zLock` and `velocity.z = vzLock`. A
  TELEPORT (a base `position` write) RE-ANCHORS `zLock` to the written z; **nothing
  re-anchors `vzLock`** (the named v1 shape). Contacts INSIDE a step still see the
  pre-lock z — at most one step's drift, erased before anything reads it (the honest v1
  statement).
- **The sprite collider law.** `collider="box"` (the sprite default, also `auto`) derives
  from the sprite's SIZE: half extents `[w/2, h/2, colliderHalfZ]` with the pinned
  **1000** extrusion, so the minimum-overlap axis of a box↔box contact ALWAYS lands in
  the XY plane (the 2D semantics of an extruded rectangle), centered on the QUAD CENTER
  (the anchor offset applied). `collider="circle"` — the 2D spelling of `sphere`, an
  accepted alias everywhere — takes radius = **half the SMALLER extent**, `min(w, h)/2`,
  scaled by the largest world basis. The collider reads the RESOLVED `size`, so an
  unauthored size colliders as 1×1 (**the texture-aspect refinement is render-time
  only** — the honest v1). Everything else — masses, restitution, friction, triggers,
  layers, sleep, characters, the fixed 60 Hz tick — is G2 verbatim.
- **The bus-write law, corrected here** (found by the G6 browser walk, fixed on all three
  renderers in the same commit): while a property is SOLVER- or animation-OWNED the base
  plane still holds the SPAWN string, so a bus `set` of that same string — "put the crate
  back where it started" — is a real COMMAND, not a no-op. A bus write of
  `position`/`velocity` on a body is honoured even when the string did not change.
- **Named absences of this rung** (so nothing here reads as more than it is): a
  PIXEL-SPACE camera mode · TILEMAPS (`<tilemap>`, tile layers, tile colliders) · sprite
  ATLASES packed by tooling (a TexturePacker-style sidecar — only the uniform grid is the
  law) · 2D-specific JOINTS (springs, distance, revolute) · SORTING LAYERS beyond z
  (named layers / order-in-layer) · 9-slice and tiled sprite draw modes · per-sprite
  opacity (the P5 `opacity` absence stands) · `collide=`/`on:collide` on `<sprite>`
  (physics `on:collision` covers 2D contact today) · billboarded sprites inside
  `mode="3d"`.

## Grammar decision recorded here

The proposal writes `<plane>`. The shared lint facts
(`OpenSource/Conformance/lint/facts.json` `builtinTags`) had **no** collision on
`plane` (nor on `scene`, `camera`, `light`, `group`, `box`, `sphere`, `model`,
`text3d`, `anchor`), so the registered tag is **`plane`** exactly as proposed —
no `plane3d` rename was needed. All tags are registered in the one shared
facts file, so both lint runners accept them at once. P5 added **`animate`** to
`builtinTags` the same way (no collision), and **`group`** joined
`keyedCollections` so `<group bind>` without `key=` warns like a keyless
`<list bind>`. G6 added **`sprite`** the same way — no collision existed in the tag
universe, so the registered tag is `sprite` exactly as proposed.

## Runners

- **TS** (the reference — per-PR, `web-kernel` lane):
  `OpenSource/Web/packages/kernel/test/scene-conformance.test.ts` drives all
  fifteen files through the platform-neutral kernel (`packages/kernel/src/scene/`):
  `parseScene` + `resolvedProps` (parse), `worldMatrices` (transforms),
  `sceneCamera` + `projectToNdc` (projection), `parseGlb` (model),
  `text3dQuad` (text3d), `sceneFrameSchedule` (frame), `sceneTweenValue` +
  `sceneTransitionValue` (animation), `sceneBindRows`/`diffSceneBindRows`
  (bind), `sceneContacts`/`worldAabb`/the collision tracker (collide), the
  orbit fold (orbit), `scenePointAttenuation`/`sceneLitColor`/`sceneFogFactor`
  + `sceneLighting` (lighting), `extractScenePhysics`/
  `createScenePhysicsWorld`/`stepScenePhysicsWorld`/`scenePhysicsSchedule`/
  `scenePhysicsInterpolate` (physics), and `glbNodeWorlds`/`glbJointMatrices`/
  `skinPosition`/`glbClipTime`/`sampleGlbChannel`/`blendGlbTrs`/
  `sceneCrossfadeProgress`/`createSceneClipMixer` (skin), and
  `scenePrefabDefFromTemplate`/`parseScene`-with-lookup/`scenePrefabResolver`
  + the bind row machinery (prefab), and `spriteQuad`/`spriteSizeOf`/`spriteUvRect`/
  `spriteFrameAt`/`spriteFrameCount`/`sceneDrawOrder2d` + the `readPosition` pair law +
  the z-locked `createScenePhysicsWorld` (sprite) — the physics, skin and sprite runners
  also assert
  the pinned constants against the kernel exports.
  `parse.json`'s markup parses through the compiler's own XML parser
  (`@despia/compiler/xml`) — the corpus never grows a second parser (the prefab
  component templates parse through it too).
- **Kotlin** (:core, SDK-free, per-PR):
  `Engine/Android/core/src/test/…/scene/SceneConformanceTest.kt` runs ALL
  fifteen files through the Kotlin twins (`SceneMath`/`SceneIR`/`SceneGltf`/
  `SceneFrame`/`SceneAnim`/`SceneBind`/`SceneCollide`/`SceneOrbit`/
  `ScenePhysics`/`SceneSkin`/`SceneSprite`); `parse.json` and the physics/skin/prefab/
  sprite markup cases parse through `StackXML.parse`. (The P5 five and `physics.json`
  joined with the 2026-08-07 twins wave; `skin.json` joined with G3; `prefab.json`
  with G1; `sprite.json` with G6.)
- **Swift** (record lane) runs ALL fifteen files: `ConformanceHosts`
  `SceneConformance` (the P1–P5 + G2 twelve, plus the G1 `prefab.json` and the G6
  `sprite.json`) + `SkinConformance` (the G3 `skin.json`), both registered in
  `RecordMain` —
  compile-pending, verified on the Codemagic record lane like every Swift wave.

Every cross-runtime divergence bug becomes a fixture here in the same commit as
its fix.
