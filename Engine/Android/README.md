# Engine/Android - the Kotlin kernel (twin of `OpenSource/Engine/iOS/`)

This folder holds the Android kernel: the same primitives as `OpenSource/Engine/`
(the bus, JSE, the Stack engine, content plane, app state, manifest loader), written
in Kotlin against the same wire - Constitution Article 8: *the contract is names, not
platforms*. `OpenSource/Engine/` (Swift) is the reference implementation; shared
conformance fixtures decide parity, not eyeballs.

Status: **built and green** - every K1 wave is ☑ in `PLAN.md`'s wave table (plus the K2 bus
pulled into `:core`), 554 JUnit tests run locally and on every PR (`android-kernel` lane);
the roll-up lives at `ClosedSource/Documentation/android-status.md`. The module split
(planned in `/ClosedSource/Documentation/archive/ANDROID-V4-UNIFIED-REPO-ASSESSMENT.md` §5, as landed):

- `core/` - pure JVM, zero `android.*` imports: JSE + JSERunner, JSON, StackNode/AST,
  DSXPathMatch, DSXEvents, Messenger, DSXShared, DSXStrings, Content facade.
  Compiles and runs the fixture suite locally on every PR (unlike Swift, which only
  compiles on Codemagic - exploit the asymmetry).
- `platform/` - Context/bus/envelopes, dsx.fetch (OkHttp), ModuleRegistry (generated
  registry, no class-walking), DSXState (StateFlow), ContentStore, AppManifest + env
  channel, RemoteBundleGate, Bridge/window.virtual (capabilities + `__proxy` delivery).
- `render/` - the Stack renderer in Jetpack Compose (style engine in the exact
  18-step modifier order of `stack-style-properties.json` `applicationOrder`).
- `glance/` - the snapshot backend (StackLive dialect → Glance app widgets).

Port order was K1 → K2 → K3 (first bootable) → K4, per the assessment - all executed.
`runtime.js` and `EngineConfig.json` are NOT duplicated here - both platforms bundle
the single copy in `OpenSource/Engine/`.

Kernel law is unchanged and platform-blind: zero WebView imports (Article 9 - the
Android analog of the WebKit ban), no module names, no scheme names
(`OpenSource/Documentation/architecture/constitution.md`). The Swift⇄Kotlin API
mapping is `OpenSource/Skills/android/api-mapping.md`.
