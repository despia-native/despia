# The Despia Constitution

> The architecture law of the runtime. Adopted 2026-06-11. Every PR is judged against it.
> Working docs: `ClosedSource/Documentation/webview-dissolution.md` · `OpenSource/Documentation/architecture/boot-tier.md` ·
> `OpenSource/Documentation/architecture/app-manifest.md` · `OpenSource/Documentation/architecture/asset-plane.md` · `ClosedSource/Documentation/content-server-kernelization.md`.

This is not a webview template. It is a **web-optional native runtime**: a fully dynamic
kernel providing primitives, and modules — uniformly — providing everything else. **DSX is a
native message bus: modules *provide*, surfaces *consume*.** The web view (`<DSXWebView/>`) and
native UI (`<DSXView/>`) are equal consumers; neither is privileged, and the kernel names no WebKit.

## Article 1 — The kernel is the bus, and it names nobody

`OpenSource/Engine/` provides **primitives only**: the registry
(`boot`/`bootstrap`/`fire`/`claim`/`fireAny`/`handle(url:)`), the surface-agnostic message
router (`receive(_ body:)` — operates on `String`/`[String:Any]`, never a `WKScriptMessage`),
the Stack UI engine, the bridge, app state, broadcasts/events, the `URLSchemeResponder`
protocol, the App-manifest loader. The kernel **never names a module, a scheme, a component,
or WebKit** — it consumes registries and vends data + closures.

*Audited 2026-06-11: the engine contains zero module references. Re-audited after the native-bus
migration: the engine imports **zero WebKit** — `configureWebView`, the `WKScriptMessageHandler`
shell, the cookie-store observer, and `dsx.configure`/`dsx.inject` all moved into the Dom module
(Article 9); a regression guard in `check_module_rules.rb` keeps it WebKit-free. The only names
are state namespaces (`dsx.route`, `dsx.global`, `dsx.screen`) — kernel **vocabulary**, whose
maintainers happen to be modules. A namespace is an alias for a state path; it grants its
maintainer nothing the registry doesn't grant everyone.*

## Article 2 — Everything is a module (or lives inside one)

A module may define, with no tier of capability withheld:

| It defines | Mechanism |
|---|---|
| **Functionality** | `dsx.action` (scheme calls) · `dsx.hook` (host events: lifecycle, `web.*`, `boot.*`, `background.urlSession`, `asset.url`, …) |
| **One or more schemes** | its primary `scheme` + extra schemes (`dsx.json` `aliases`); actions group under a scheme via `dsx.group` (`despia.x.g.a`) and scope to a second scheme via `dsx.scheme` (`despia.y.a`, isolated). One module can front several schemes when a sub-capability deserves its own brand yet must share the module's engine (LocalAI: `intelligence` + `rag`) |
| **Components** | the three tiers, all with **full Stack-engine access**: folder `.dsx` components (markup, OTA-shaped) · `GlobalStackComponent` (native SwiftUI body) · `PrivilegedStackComponent` (orchestrators: children, row scopes, measuring) |
| **First-frame behavior** | the boot tier (`bootEligible` + `claim("boot.splash")` — the Splash module is the precedent) |
| **Web behavior** | hooks on the Dom relay's events (`web.decidePolicy`, `web.jsDialog`, `web.filePicker`, `web.authChallenge`, …) — no host code implements a web delegate |
| **OS-delegate ownership** | the adapter-placement rule: the module owning an OS surface owns its delegate, as a policy-free relay (Dom → `DSXWebDelegate`; notification modules → `UNUserNotificationCenterDelegate`) |
| **Its configuration** | its own `config.json` (`{ value, _note }` → generated typed `config`) |
| **Its source language(s)** | native code authored **beyond** the platform language (C++ for a shared engine, via `languages` in `dsx.json`) — compiled + C-ABI-bridged by the build on both platforms, file-presence gated like Swift. A **module-system** primitive, not a kernel one: the kernel still names no language; foreign code lives below the bus (`OpenSource/Skills/native-languages.md`) |

Anything that exists outside this table is either the kernel, a bootloader translation
line, or **debt scheduled for deletion** (the dissolution queue).

## Article 3 — No special exemptions

**Mandatory is a tier, never a privilege.** A Mandatory module ships in every build and
can't be excluded — but it registers, hooks, claims, configures, and is dispatched exactly
like any Custom module. *Audited: the runtime registry contains zero mandatory-aware
code.* No module may be reached by name from the kernel or a host; consumers use
`dsx.module.<scheme>.*`, claims, broadcasts, or shared handles — all feature-detectable
(`dsx.has`), all Android-portable.

**Dom LEFT the tier on 2026-08-21** (`v4-launch/registry/00-plan.md` D5), and the reason is worth
recording because it is the article working rather than bending. Dom sat in `Mandatory/` because it
was assumed, not because anything depended on it: the native-bus migration had already made every
consumer reach it through `dsx.module.dom.*`, and Article 3's own sentence says such a consumer is
feature-detectable. When the tier was actually tested by removing Dom, the whole coupling came to
**six compile errors in four files** across a 136-file kernel and a 17-package Mandatory tier, none
of them a dependency on Dom's CODE: three reads of Dom's generated config struct, one extension on
`AppManifest` that happened to live in Dom, and two errors that were not about Dom at all.

`Core/Dom` is now an ordinary excludable package, listed in the release profiles so the default
build is byte-for-byte what it was. Measured on iPhone 17 Pro / iOS 26.5: the default build links
`WebKit.framework` and references 2 `WKWebView` symbols; the same build with one line removed from
the profile compiles clean and links **no WebKit and zero `WKWebView` symbols**. A Despia app
without a web view now exists.

The three web-only behaviours that read Dom's config (PullToRefresh's overscroll attach, Splash's
page-loading indicator, PushRouting's external-link navigation) now gate on `dsx.has("dom")` first,
which is what this article said they should have been doing all along.

**Only `dsx` + the module system — no internal shortcuts (binding rule).** Every
cross-module interaction goes through `dsx`, the kernel facade: `dsx.action` / `dsx.hook`
to expose and consume, `dsx.module.<scheme>.<action>()` to call, `dsx.fire` / `dsx.claim`
/ `dsx.fireAny` to signal, `dsx.shared` / `dsx.values` for shared state. **Pick by shape:**
`dsx.module` to call a module you can name (point-to-point), `dsx.fire`⇄`dsx.hook` for
genuine 1-to-N events (lifecycle / broadcasts), `dsx.claim` for "who owns this?" decisions —
`fire` is never a disguised point-to-point call (the decision guide is `OpenSource/Skills/cross-module-calls.md`).
A module — or a
delegate relay — **never** reaches the kernel another way: no `ModuleRegistry.shared`, no
`NotificationCenter` (or other ambient singletons) for cross-module signaling, no global
mutable state, and **no "shim" modules** that exist only to forward. The relay reaches the
bus through its bound `dsx` too (Dom binds `DSXWebDelegate`). A legacy scheme is owned by a
real module's `dsx.action` (the registry gives custom schemes first-dibs); a new capability
is a real module method that resolves a promise — never a side-channel. If a behavior seems
to *need* a shortcut, the `dsx` / module primitive is missing — **add the primitive** (e.g.
the bus surfaced on `dsx`), don't bypass. *(The only tolerated `ModuleRegistry` reference in
module code is a `static` compile-time capability query — `isAvailable` — which has no `dsx`
form and is not runtime signaling.)*

## Article 4 — Every value is module config

A behavior knob ("pull-to-refresh color", "do X on refresh") lives in the **owning
module's** `config.json` — typed, documented per key, dynamically settable per app. Never
a hardcoded literal; never a central file. *Status: executed for Mandatory owners
(Dom 41 keys · ContentServer 27 · Splash · Security · Routing · MenuBar · PullToRefresh);
done for excludable owners too. `Config.swift` (the central shim) was deleted in #790 — every
config key now reads from generated `CoreConfig` / its owning module's `config.json`.*

## Article 5 — The only hardcoded artifact is `/App.json`

The app-identity manifest at the root: the host (with per-locale hosts) — **the source**.
It is the one thing an app author must provide and the one input the framework takes on
faith. Everything else — every screen, behavior, string, color, policy — is modules on
the kernel. (`OpenSource/Documentation/architecture/app-manifest.md`.)

## Article 6 — Hosts are bootloaders

`AppDelegate` may contain **only translation lines** (one `fire`/`claim` per OS callback;
adding a missing callback is the sole legal host edit). `WebViewController` is debt with a
published dissolution map and dies by attrition; the bare web host is a `WKWebView` whose
delegates are the Dom relay. The legacy `WebView/` folder was renamed to `Host/` (the bootloader
home) once `WebViewController` was gone; with `Config.swift` deleted (#790) and the last host-state
file `HostGlobals.swift` fully dissolved (#794 — its state into the owning modules, its residual
`UIColor(hex:)` helper later promoted to a kernel primitive at `OpenSource/Engine/iOS/Color.swift` and the
file deleted), it is now a pure bootloader owning no app state and no utility code.

## Article 7 — Fail-open is law

Every claim has a platform default; every module answer is optional; an excluded or
missing module **degrades a feature, never bricks the app**. This governs FAILURE, not
ABSENCE — it is not a licence for a capability to be missing on a platform by design, and
Article 10 is the article that says so. Boot-path claims double this:
a failed hook yields the legacy path byte-for-byte. (The splash, start-URL, deep-link,
session, dialog, and asset claims all already conform.)

## Article 8 — The contract is names, not platforms

Kernel events are **named, untyped-shaped, completion-passing** — the same names and
shapes the Kotlin host fires and the Android adapters emit. The wire (`despia.*`,
broadcasts, `dsx.event`) is the cross-platform spec; no iOS type leaks into a contract.

## Article 9 — WebKit lives only in the Dom module

The runtime is **web-optional**, so WebKit is one swappable surface, not the substrate. The
kernel (`OpenSource/Engine/`) imports **zero** WebKit (Article 1), and so does every module —
**except the web-surface owners**: `Core/Dom` (owns the web surfaces — the composed app
`WKWebView` plus node-owned bare surfaces, the surface directory, the ONE bridged
`WKScriptMessageHandler` origin-gated by `DomBridgeGate`, the cookie store observer, each wrapped
`URLSchemeResponder`), its two components — `<DSXWebView/>` (the app surface: bare construction +
`DomBridgeKit` + kernel wiring) and `<WebView/>` (the bare primitive: NO bridge by construction —
`architecture/web-surface-policy.md`) — and the surface plugins `Core/Clerk` (SSR
navigation-action auth), `Core/Auth/LoginHelper` (its own OAuth-popup web view), and the
standalone `AppClip` extension.

Every other module reaches the web surface **only through the Dom module**, exactly like any
cross-module call — `dsx.module.dom.{inject, serveScheme, eval, call, set, css, load, reload,
clearWebData, saveCookies, restoreCookies, home, proxy}` — or by casting Dom's exported handle
(`dsx.module.dom.object("view" | "scrollView" | "userAgent")`) to a `UIView` / `UIScrollView` /
`String`. A module **never** holds a `WKWebView`, attaches its own message/scheme handler, or
configures the shared web view. `dsx.*` itself carries **no web-view verb**: the web view (DSXWebView)
and the native view (DSXView) are equal consumers that attach to the bus; the kernel special-cases
neither. `check_module_rules.rb` enforces all of this (Engine scan + handler ban + the
`import WebKit` ban with the exempt set above), so a regression fails the build.

## Article 10 — One feature, every platform

**A capability that ships on one renderer ships on all of them.** Not the same code, not the
same weight, not the same mental model - the same BEHAVIOUR and the same LOOK, to an author and
to the person holding the device. A feature that works on one platform and not another is not a
smaller feature; it is a false statement in the catalogue, and it is the one defect this
framework exists to make impossible.

The renderers are Swift/SwiftUI, Kotlin/Compose, Compose Desktop and TypeScript/DOM. Four
implementations of one contract. Implementation divergence is expected and legal: a native list
is a `LazyColumn`, a web list is a DOM subtree, and a scroll-linked value is folded by our own
evaluator on two of them and by the browser on the third. **Divergence in what the author gets
is not.**

### The three legal states, and the one that is gone

Every element, attribute and module action is, on every renderer, exactly one of:

1. **Supported** - a real implementation.
2. **Polyfilled** - the same observable behaviour, built out of different parts. `<AudioLevel>`
   drawn from primitives where a native meter exists; a `@keyframes` sampler driving a display
   link where a browser owns its own animations. A polyfill is a first-class implementation and
   is named as one.
3. **Platform-limited, with a named degradation** - the OS genuinely has no such concept, AND we
   ship the closest coherent thing anyway, AND the degradation is SPECIFIED: what the author
   gets instead, stated in the ledger, not discovered on a device.

**"Unsupported" is not a state.** Neither is "declared gap", "inert", "not yet mapped", "no web
renderer", or "deferred". Those describe; they do not justify. A row that carries one of them
and no polyfill is a defect with a ledger entry, and `check_platform_parity.rb` fails on it.

### Article 7 is about failure, not about absence

Fail-open governs what happens when a module is EXCLUDED or an answer never arrives: degrade the
feature, never brick the app. It has been read as a licence for a capability to be absent on a
platform by design. It is not one, and never was. `unsupported_platform` is a correct answer to a
call for something an app deliberately did not ship; it is not a correct answer to a capability
the catalogue advertises.

### Two kinds of building block, and only two

A capability is unified by being built out of things that are already unified. So there are
exactly two kinds of UI building block, and the line between them is not a matter of taste:

1. **A primitive** is native, and it is native BECAUSE it wraps a platform capability markup
   cannot reach - a decoder, a camera, a text input, a map, a secure field, a system control.
   `<video>`, `<canvas>`, `<textfield>`, `<map>`, `<stack>`. A primitive exists on EVERY renderer
   (that is Article 10 applied to it) and is styled through the ordinary DSX-CSS surface, so an
   author overrides it with `class=` and `style=` like anything else. A primitive that only one
   platform has is not a primitive; it is a defect with a register row.

2. **A component** is DSX markup over primitives. It is written once and runs on all four
   renderers by construction, because every part of it already does.

**An advanced surface is a COMPONENT.** The Studio editor, a media player, a chat composer, a
waveform lane: these compose primitives. They are never a per-platform native element, and a
per-platform native element is never the right way to close an Article 10 gap - writing a third
implementation of a drawing is how a two-renderer feature becomes a three-renderer feature and
still is not unified.

**The test is one question: does it need a platform capability markup cannot express?** If the
honest answer is "it draws shapes", it is a component and it belongs in `.dsx`. Two files in
`Core/StudioEditor` carried the comment "drawn natively because markup primitives can't paint a
metered gradient" and were 198 lines of Swift and Kotlin that rendered on two renderers out of
four. They can. The claim was never tested; it became true only because nobody re-read it.

### What this costs, honestly

It costs the cheap release. A feature is not done when it works on the platform its author was
holding; it is done when the corpus runs on all four. The unified-codebase law already says this
for authoring surface (fixtures first, then TS, Kotlin, Swift); Article 10 extends it to every
capability we ship, and gives it a gate.

The bar for a new platform-limited row is high and it is written down: name the OS limitation
concretely, name the degradation an author receives, and name the polyfill. A row with no
polyfill needs the sentence explaining why one is impossible, not merely absent - and that
sentence has to survive somebody reading it.


---

### Amendments

**2026-08-17 — the web default is the Despia design language** (`proposals/design-system.md`).
The system-defaults law (`proposals/system-defaults.md`) ratified the unstyled baseline as the
platform's own on every target, with the web row carrying an "honest neutral skin". The
design-system ruling supersedes the web half of that sentence: the web renderer's unstyled
baseline is the crafted **Despia design language** — premium by default, token-derived,
AA-contrast-enforced in CI (the token contrast gate + the demo axe sweep, `web-kernel` lane).
Native baselines stay platform-true (SwiftUI / Material 3 — inherited looks self-update,
re-specified ones rot), the one precedence ladder and explicit ejection are unchanged, and web
stays never-fake-Cupertino: its default is its OWN design language, not an imitation of a
platform it cannot host. The amended sentences live in system-defaults.md; this entry is the
constitutional record.

### Conformance ledger (historical — every row RESOLVED; kept as the audit record)

| Violation | Disposition |
|---|---|
| ~~`Host/` bootloader shell — `Config.swift` read-through shim~~ ✅ RESOLVED. `AppDelegate` keeps the APNs push-payload parse (the provider adapter, legal per the adapter-placement rule) | `WebViewController` DISSOLVED (2026-06-16); folder renamed `WebView/` → `Host/` (2026-06-20); IAP/RevenueCat/calendar already moved to module `lifecycle.launch` listeners; `Config.swift` deleted (#790); the last host-state file `HostGlobals.swift` dissolved into its modules + kernel `dsx.global` (#794), then its residual `UIColor(hex:)` helper became a kernel primitive (`OpenSource/Engine/iOS/Color.swift`) and the file was deleted — `Host/` now owns no app state and no utility code (`webview-dissolution.md`) |
| ~~`Host/Config.swift` shim + central-config remnant~~ ✅ RESOLVED | central `CoreConfig` collapsed **8 groups → 1** (2026-06-22): only `first_run.ask_for_push_permission` remains (read by the always-compiled `AppDelegate`/OneSignal/Firebase, so it can't move into an excludable module). `image_downloader`→CameraRoll, `rate_app`+`facebook_friends`+first-run notice→Engagement, `appearance`→StatusBar/BottomBar (colors held as module state, overridden at runtime by `statusbarcolor://`/`bottombarcolor://`), `app_icons` (dead dupe)+`translation_*` (alternate-language tables) removed — each verified exclusion-safe (excluding the owner generates cleanly, 0 dangling refs) and per-app-overridable via `core_packages.json`. Then the **read-through shim itself** dissolved per-consumer (2026-06-22): ~55 of ~69 globals removed (Phases 0–3 — owner-only + cross-module Mandatory reads + host reads), each consumer now reading `config.<key>` / the Mandatory owner's `<Owner>Config().<key>` (gate-legal + exclusion-safe). Then `Config.swift` was **deleted** (#790): the former "14 remaining" weren't read-throughs but already have homes — `host`/`webviewurl`→`AppManifest`; `useLoadingSign`, the `localHost*`/`onlyUseLocalServer` cluster, `pulltorefresh_*colour_*`, `loadingIndicatorColor`/`useLoadingProgressBar` → their owning modules / generated config. The last host-state file `HostGlobals.swift` then dissolved (#794), so `Host/` owns no app state |
| ~~Host-level services reached by name (`Services/LocalServer`)~~ | ✅ RESOLVED — the local stack (`ServerManager`/`FileDownloadManager`/`CDNSchemeHandler`/`LocalCDN`) moved **into** the `ContentServer` module; `Services/` is gone, so the daemon is module-owned, not a free-floating Service. Most by-name calls are now intra-module (a module using its own internals — legal); the two that aren't are the bootloader's documented pre-bootstrap deep-link fallback (`AppDelegate:333`, behind the `web.mapURL` claim) and the dormant ShareExtension's app-group path read — both pre-existing, both fine. Kernelization doc §6 Phase 3. |
| ~~`localcdn://` inline handler~~ | ✅ RESOLVED — `LocalCDNCompat` in the ContentServer module (slice 2 landed) |
| ~~HuggingFace background fallback, calendar helper, biometric branch in AppDelegate~~ ✅ RESOLVED (audited 2026-06-23) | the actual code already lives in its module — HuggingFace background session in `LocalAI` (`LocalAI.swift`), calendar permission in the Calendars module, biometric in `AppLock` (via the boot gate). Only explanatory **comments** remain in `AppDelegate`/`SplashscreenVC` pointing at those homes; no executable host branch survives |
| ~~Template-era artifacts: license/facebook groups~~ ✅ RESOLVED (2026-06-23, maintainer decision) | obfuscated `download()` + `webviewgold` POST removed earlier; the **follow-on-Facebook** prompt (`facebook_*` keys + code) deleted from the Engagement module. `LicenseCheck` is **KEPT** — a constitutional, fail-open Mandatory kill-switch with fully dynamic config (not template debt). No open items |
| ~~WebKit in the kernel + modules reaching the web view directly~~ ✅ RESOLVED (native-bus migration, 2026-06-24 — Article 9) | the unit `package`→`module` (Swift API + `dsx.module` call root); the kernel went **WebKit-free** — `configureWebView`/`dsx.configure`/`dsx.inject`/the `WKScriptMessageHandler` shell/the cookie observer all moved into `Core/Dom`, which now exposes `dom.{inject,serveScheme,eval,call,set,css,load,reload,clearWebData,saveCookies,restoreCookies}` + the WebKit-free `URLSchemeResponder` protocol. Every non-surface module dropped `import WebKit` (UIView/UIScrollView/`userAgent` casts of Dom's exported handle, or a `dom.*` call); only `Core/Dom`, `<DSXWebView/>`, `Core/Clerk`, `Core/Auth/LoginHelper`, and the `AppClip` extension may name WebKit. `check_module_rules.rb` enforces the Engine scan + handler ban + `import WebKit` ban |
| ~~The hard-coded root: `bootsToEntryFallback`'s two-arm rule, the `"DSXWebView"` "irreducible web floor" literal + EngineConfig `defaults.view`, the readiness `view == "DSXWebView"` ternaries, Dom's self-pushed failure screen, the kernel `"DSXNativeUnavailable"` literal (+ both Android twins)~~ ✅ RESOLVED (the ROOT PLAN, 2026-07-26 — `proposals/root-plan.md`) | Root selection is `App.json entry.surfaces` — an ordered first-ready fold in the kernel Router (any component is a legal candidate; failure always advances; exhaustion = the kernel boot diagnostic + `root.exhausted`). The floors dissolved into data: templates carry the product defaults, web-surface tags REGISTER (`webSurfaceTags` — Dom names its own component), the unavailable screen is a CLAIMED role (Routing), `DSXWebUnavailable.dsx` moved into Dom, `entry.fallback`/`defaults.view` are retired grammar (build aborts). `check_module_rules` rule 18 (+18b) keeps the orchestration path literal-free forever — mutation-proven with `Custom/ProofSurface`, corpus `Conformance/router/root-plan.json` on all three runtimes |
| ~~Fragmented content caching: module-private stores (GodotContentCache, DSXRemoteCache's `.cache` tree, FileDownloadManager's bundle), three manifest formats, three integrity schemes, triplicated host resolution, zero eviction~~ ✅ RESOLVED (content plane, 2026-07-04 — `content-plane.md`) | ONE kernel content primitive — `dsx.content` (`Engine/Content.swift` + `ContentStore.swift`): content-addressed blobs + atomic generations + stale-while-revalidate + generation-granular eviction + purge healing; trust chains through the existing `RemoteBundleGate` (pure per-anchor verify; per-folder anti-rollback). Godot and the text plane are consumers; the offline web bundle is a content folder (FileDownloadManager DELETED, with a read-only legacy-tree fallback for old installs); the `content` dsx.json capability seeds mounts from the bundle (`module-content.md`); hosted content lives under App.json `hosting.content_root` (default `/dsx`). Mechanism kernel, policy modules — ContentServer keeps serving + sync UX + the `asset.url` claim; `LocalCDN` deliberately stays user-data (not cache) |
