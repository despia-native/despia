# WebView-agnostic modules — "state in, DSX renders"

## The principle (architecture law)

A module is **WebView-agnostic**. It NEVER grabs the `WKWebView` to overlay UIKit on it or to
read its UI. It pushes **state / resolve / events** to the global root context; the *rendering
surfaces* — `DSXWebView` (web) **and** `DSXView` (native) — subscribe and render. So a load indicator is
just `global.ui.loading` state, drawn natively by the kernel surface `RouterHost` (as chrome) above whatever frame is showing, and
it works identically on web and native. **The only legitimate web-view access is the surface layer
itself** (`Dom`/`DomWebHost`/`WebDelegate`/`DSXWebView`) and **auth/cookies/content delivery**
(`ContentServer`, `OAuth`, `Clerk`, `LoginHelper`).

Exemplar (done): **Spinner** — now pure state (`import Foundation` only; sets `ui.loading`), the
native indicator rendered by `RouterHost` (`LoadingIndicator`). It no longer touches the web view, so
it works on `DSXView` too. The shell lifecycle it (and its peers) hook — the unified
`screen.loading`/`screen.ready` events + `global.screen.*` state that replace web-specific
`domFinish` — is documented in full at [screen-lifecycle.md](screen-lifecycle.md).

## Audit of the ~44 modules that touch the web view

### KEEP — the web layer + auth/cookies/content (the allowed exception)
| Module | Why it keeps web-view access |
|---|---|
| `Mandatory/Dom` (Dom, WebDelegate, DomWebHost) · `DSXWebView` | They ARE the web surface + relay. |
| `Mandatory/ContentServer` | cookies (16) + localStorage + the local server — the content/cookie layer. |
| `Core/Clerk` | auth session cookies/JS (69). |
| `Core/Auth/OAuth` · `Core/Auth/LoginHelper` | OAuth redirect + the login popup's OWN web view. |
| `Core/FileSharing` · `Core/Wallet` · `Core/FileViewer` (cookie part) · `Core/WebControls` | cookie-forwarded authed downloads/fetches. |

### REWORK 1 — native UI overlays → state-driven, DSX-rendered (the Spinner pattern). HIGHEST value (these are what break on `DSXView`).
| Module | Overlay | Target |
|---|---|---|
| `Core/Basics/Spinner` | load indicator | **DONE** — `ui.loading` → `RouterHost.LoadingIndicator`. |
| `Core/NativeVideo` | native video layer | state (`ui.video`) → a DSX video component. |
| `Core/AdMob` / `Core/MetaAudienceNetwork` | banner view | state (`ui.adBanner`) → DSX-positioned slot (ad SDK still needs a UIView, but placement is DSX). |
| `Mandatory/Splash` | splash overlay | state (`ui.splash`) → `RouterHost` overlay (boot-special; coordinate with the boot tier). |
| `Core/Basics/StatusBar` / `BottomBar` | chrome bars | already WINDOW overlays (self-owned) — migrate to DSX-rendered chrome later; low urgency. |
| `Mandatory/MenuBar` | legacy overlay | already has `<MenuBar/>`/`<Sidebar/>` DSX components — drop the residual overlay. |

### REWORK 2 — `evaluateJavaScript` data delivery → modern `dsx.broadcast` / `dsx.event` / `dsx.resolve` (constitution Rule 4; the web subscribes via `despia.on`). Build-gated (web-contract change).
`Core/Basics/Siri` · `Core/Payments/LegacyIAP` · `Core/QuickActions` · `Core/WebPlatform/SpeechRecognition` · `Core/WebSocket` · `Mandatory/PushRouting` · `Mandatory/SharedData` · `Core/AdMob` (the `js` site).

### REWORK 3 — scroll/gesture config → the surface owner (`DSXWebView`), not the module
`Core/Basics/PreventDefault` (disables web bounce/scroll) · `Mandatory/PullToRefresh` (UIRefreshControl on the web scroll view). These are web-surface config; fold into `DSXWebView` (and on `DSXView` the native scroll owns its own).

### REWORK 4 — direct `load`/`reload`/reads → `dsx.module.dom.*` (point-to-point, no `as? WKWebView`)
`Core/Audio` · `Core/Basics/Location` · `Custom/VerticalPlayerStack` · `Mandatory/Browser` · `Core/Store` · `Core/Payments/Stripe` · `Core/PostHog` · `Core/CameraRoll` · `Core/QRScanner` · `Core/Vision` · `Core/SocialShare` · `Core/Engagement` · `Core/ScreenShield` · `Core/AppsFlyer`. Most already call `dsx.module.dom.load/reload`; the residual `dsx.shared.use("web") as? WKWebView` reads should become `dsx.module.dom.*` calls (each verified per-file).

## Sequencing
1. **Spinner** (done) — proves the pattern.
2. **Rework 1** (overlays) — biggest payoff: makes native UI work on `DSXView` and removes the last reasons modules hold the web view. Each is its own slice.
3. **Rework 4** (reads → `dsx.module.dom`) — mechanical, low-risk, shrinks the access set fast.
4. **Rework 2/3** (JS-delivery, scroll) — build-gated / web-contract changes; do alongside the relevant device passes.

Per-file confirmation required before each rework (the pattern counts above are a heat-map, not a spec).
