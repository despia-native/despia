# Production readiness — v1 boundary

Despia v1 is production-ready only when the exact candidate passes the binary release gate
below and has no known P0/P1 defect inside the supported surface. This is a release boundary,
not a claim that Despia replaces every feature of a general-purpose engine such as Unity or
Unreal.

## Supported for production

- Database-driven applications: typed CRUD, identity-scoped repositories, Postgres and
  Firestore provider parity, SSR/API execution, bounded queries, field allowlists, and
  row-level-isolation tests. The server boundary also rate-bounds unauthenticated JWKS
  refreshes, caps and times out JWKS documents, bounds Postgres admission/acquisition and
  ships finite client/server statement deadlines, and re-authorizes every API-proxy redirect
  while bounding its request, response, hop, and time budgets. A deployed app must still
  supply its database, authentication, migrations, backups, secrets, monitoring, and incident
  procedures.
- 2D games: sprite sheets, frame and FPS animation, z-ordered drawing, fixed-tick physics,
  gravity, oriented collision/contact impulses, planar rotation, deterministic rest/sleep,
  reactive state, and unified keyboard/gamepad/touch input. Locked 3D degrees of freedom are
  removed during contact solving, not corrected after the fact.
- 3D games and interactive scenes: WebGL rendering, transforms, prefabs, lights, fog,
  orbit cameras, glTF/skeletal kernels, fixed-tick rigid bodies, gravity, free angular
  velocity, persistent torque, shape-derived inertia, angular-momentum-preserving integration,
  angular damping, sphere/OBB and OBB/OBB collision, deterministic clipped face and edge
  manifolds, contact-driven linear/angular impulses, warm-started stacked contacts, collision
  events, triggers, spawning/despawning, and deterministic rest/sleep. Nested transformed
  bodies use scene-root solver poses with conservative sheared-parent bounds.
- Native delivery: the shared kernels are conformance-tested through web, Kotlin, and Swift;
  the Android APK and iOS Runtime build are release gates.

## Explicit v1 limits

- The collider set is sphere and oriented box (including the 2D circle/box spellings).
  Capsules, continuous collision detection for extreme-speed tunnelling, joints, soft bodies,
  fluids, and arbitrary convex/mesh rigid-body collision are future version goals.
- The release corpus certifies deterministic five-box stack sleep plus staggered tilted-crate
  convergence with immutable sleeping supports; the browser stress lane certifies its pinned
  512-sprite/256-object workloads. Larger or substantially different
  scenes still require target-device profiling; passing the gate is not a promise of unbounded
  object counts.
- The current native 3D path is a functional renderer, not a high-end PBR/AAA renderer.
  Profile real target devices before shipping visually or thermally demanding scenes.
- Multiplayer, authoritative game servers, anti-cheat, asset streaming strategy, database
  operations, and live-service observability are application/backend responsibilities.

## Binary release gate

A v1 release is shippable only when `node scripts/dev3-release-gate.mjs` succeeds on the
release commit. The fail-fast command requires all of these lanes without an implicit skip:

1. `npm run conformance && npm test`
2. The Crate Blaster playthrough plus 3D, 2D sprite, unified-input, and deterministic
   512-sprite/256-object mass-scene browser certification, followed by the mandatory
   alternating 2D/3D mount-run-unmount sustained soak
3. `OpenSource/Engine/Android/gradlew test`
4. `ClosedSource/scripts/conformance/record_jse_conformance.sh`
5. Android `:app:assembleDebug` (or the release signing equivalent) and the iOS Runtime build

This gate certifies the checked-in candidate. It does not manufacture evidence for 100,000
developers: that requires signed releases, documentation/support operations, external beta
cohorts, crash/latency telemetry, real-device thermal and memory soaks, and staged rollout.

Anything outside the supported surface is a new version goal, not an unfinished v1 workflow.
