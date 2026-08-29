# Browser extensions — one WebExtension payload, packaged Apple's way and the store's way

**Status: v1 — FOUNDATION LANDED** (the `Core/Extensions/WebExtension` module ·
the declared Safari appex target · the App-Group message plane · the Chrome zip
packager · the six-verb completeness law). Staged: the DSX-authored popup
(web-kernel compiled), the icon fill, per-app stamping of the Safari-side
payload, the desktop rungs (M1/D2 below). Companions:
`declared-targets.md` (the target grammar this rides), `desktop-platforms.md`
(the lane model — this module's `swift/` lane is iOS today and the M1 Mac app
tomorrow; its desktop-browser rungs ride D2), `../facet-contracts.md` (the
`web/` platform facet), `OpenSource/Skills/containers.md` (the App Group law),
and `Core/Extensions/Keyboard` (the two-process precedent this copies). The
module is **bucket E of the desktop disposition** (`desktop-status.md` —
target/surface owners declare no `platforms`; they OWN the machinery that
binds a surface).

## The problem — the app ends at the app icon

A Despia app has no presence inside the user's browser: no "save to app" from
an arbitrary page, no session hand-off from Safari, no page augmentation, no
toolbar surface. Both vendors offer exactly one door — Apple's is a **Safari Web
Extension** (an `.appex` inside the iOS/macOS app, running a standard
WebExtension), Google's is a **Chrome extension** (the same WebExtension
standard, zipped and listed on the Web Store). The naive Despia answer would be
a hand-wired Xcode target per app plus a second, drifting copy of the extension
for Chrome — the exact two debts (script-owned surface names, forked sources)
that `declared-targets.md` and the unified-codebase law exist to prevent.

## The law

**A browser extension is ONE WebExtension payload owned by ONE module, packaged
twice. The payload is the module's `web/` facet — a browser is a web platform.
The Safari packaging is a DECLARED appex target synthesized by
`prepare_modules` from the module's manifest; the Chrome packaging is a zip of
the same bytes. No second source tree, no per-browser fork, no hand-wired
target, and no WebKit anywhere in our processes — the extension runs in the
BROWSER's process, not ours.**

```
ClosedSource/DSX/Modules/Core/Extensions/WebExtension/
├── dsx.json                    # scheme webextension + the declared appex target
├── config.json                 # content-script match patterns (per-app via core_packages)
├── web/extension/              # THE payload (web facet — shared verbatim by every browser)
│   ├── manifest.json           #   MV3, cross-browser (service_worker + scripts declared)
│   ├── background.js           #   the hub: extension messages → native (Safari) or no-op (Chrome)
│   ├── content.js              #   the page door: window.postMessage envelope → background
│   ├── popup.html/js/css       #   the toolbar surface (talks the same channel)
├── swift/                      # the SWIFT LANE (Q5 spelling, desktop-platforms.md): iOS today, the M1 Mac app tomorrow
│   ├── WebExtensionBridge.swift  # host-side Module: dsx.module.webextension.*
│   └── WebExtensionStore.swift   # the App Group contract, compiled into BOTH processes
└── SafariWebExtension/         # the appex target's own sources (target-owned)
    ├── SafariWebExtensionHandler.swift   # NSExtensionRequestHandling ⇄ the store
    ├── Info.plist              #   com.apple.Safari.web-extension
    └── SafariWebExtension.entitlements   # the shared App Group
```

## The packaging plane

- **Safari** — the manifest declares the appex via `extensionTargets`:
  an unknown `kind` plus a manifest-supplied `nsExtension` object is the
  declared-targets door for new extension points, so
  `com.apple.Safari.web-extension` lands with **zero script vocabulary** —
  no scaffold row, no surface name in Ruby. No `platform` word (an embedded
  appex shares its host's platform by derivation), no `embed` key (an
  app_extension rides Apple's universal PlugIns phase). The payload rides the
  spec's `resources` globs (`../web/extension/*`) into the appex bundle —
  flat, which is why the payload keeps a flat file layout (an iOS bundle
  copies file references shallow; folder trees would need folder refs).
  Excluding the module tears the whole target back out — the lockfile
  teardown, unchanged.
- **Chrome** — `ClosedSource/scripts/build_webextension.rb` zips the same
  `web/extension/` bytes into a Chrome-Web-Store-ready artifact, stamping
  identity at PACKAGE time (name from App.json / `APP_NAME`, version and
  content-script matches from the module config) so the committed payload
  stays byte-stable — the TV/watch philosophy: the repo carries the template,
  per-app CI stamps the real identity.
- The `web/` facet is already invisible to the iOS app bundle
  (`**/web/**/*` lives in the synced-group exceptions), so the payload ships
  ONLY inside the two packagings — never as loose app resources.

## The communication plane — the container is the channel

A Safari extension's native half (`SafariWebExtensionHandler`) runs in the
**appex process**, spun up per message; the app may not even be running. So the
transport is the shared App Group container (`container: true` + `targets`),
exactly the Keyboard's shape — but WITHOUT its Full-Access gate: a Safari web
extension appex reaches the group unconditionally, so the channel needs no user
consent beyond enabling the extension itself.

- **App → extension**: `dsx.module.webextension.update({ vars })` merges typed
  string vars into the container; the extension reads them on each invocation
  (`get`/`status` native messages). There is no live push INTO Safari — iOS
  offers none — so vars are read-on-demand by design, never "synced".
- **Extension → app**: extension JS calls
  `browser.runtime.sendNativeMessage("application.id", { type: "send", event, payload })`;
  the handler queues it in the container (ring-capped) and stamps a heartbeat.
  The bridge drains the queue when the app next foregrounds: native hooks hear
  the `webextension.message` bus event immediately; the page subscribes the
  module proxy's reserved `.on` member —
  `dsx.module.webextension.on("message", ({ event, payload, origin }) => …)`,
  the canonical grammar (no flat page-bus spelling is taught) — with the web
  copy buffered until `screen.ready` (the Keyboard's exact web-boot guarantee).
- **Page ⇄ extension**: on matched pages the content script speaks ONE
  envelope, request/response —
  `window.postMessage({ source: "dsx-webext", id, type, … })` in, and (when an
  `id` rides along) `{ source: "dsx-webext-reply", id, …result }` back; an
  id-less `{ event }` stays valid fire-and-forget sugar for `send`. The hub
  stamps `origin` from the SENDER (page-claimed origins are never trusted) and
  every reply carries `native: true|false`. No reply within a page timeout
  means the extension isn't installed or the page isn't matched — the
  feature-detect. Everything else on the page is ignored.
- **Setup state**: `dsx.module.webextension.status()` →
  `{ used, lastSeen, queued }`. Apple offers no is-my-extension-enabled query
  on iOS (`SFSafariExtensionManager` is macOS-only), so `lastSeen > 0` is the
  honest, public-API answer — the Keyboard's heartbeat semantics, verbatim.
  `openSettings()` opens the app's own Settings page; enabling the extension
  is the user's act in Settings → Apps → Safari → Extensions (iOS 18+; Safari
  settings on earlier majors), which the README spells out.

## The completeness law — every verb answers on every surface, ONE app end each

**The grammar is closed and total: six verbs — `status · get · send`
(universal) and `update · clear · drain` (app-end) — and every one of them has
a defined, observable result on every surface. Each surface has exactly ONE
"app end" (the party that owns the vars and drains the queue): where a native
channel exists, the NATIVE APP; where none does, the CUSTOMER'S WEB APP on a
matched page. Never both, never neither, never undefined.**

- **Native surfaces (the Safari family)**: all six verbs forward to the appex
  handler. The app end is the native app, so the handler answers the app-end
  verbs `{ ok: false, error: "native_owns_state" }` — a Safari page (or the
  popup) reads (`status`/`get`) and sends, it never overwrites the app's vars
  or steals the app's inbox. A page that wants popup-visible state sends it TO
  the app and lets the app `update` — one writer, by law.
- **Non-native surfaces (Chrome/Edge/Firefox, desktop AND Android)**: the same
  six verbs run on the **extension-local floor** (`browser.storage.local`,
  same ring cap) — the web app pushes vars down (`update`/`clear`) and drains
  the queue (`drain`); popup and other matched pages `send` into it. The
  bundled floor stands with zero native anything.
- **Native-ness is discovered, not assumed**: Chrome DEFINES
  `sendNativeMessage` but settles it only for installed desktop host
  manifests, so a capability probe would lie — the first call's own failure is
  the truth, memoized, and every reply stamps `native: true|false`.
- **The absent extension is a defined state too**: no content script → no
  reply → the page's timeout detect answers "not installed / not matched".
- **The matrix upgrades by RUNG, never by rewrite** (the desktop mental model,
  `desktop-platforms.md`): the app-end assignment is today-honest per surface,
  and because native-ness is per-call discovered, a surface that GAINS a
  native channel later (Safari-macOS at M1; Chrome/Edge/Firefox desktop when
  D2's packaged app registers native-messaging host manifests) simply starts
  answering `native: true` — the app end moves to the native side and payload
  + page code, already branching on `native`, change ZERO bytes. The
  extension-local floor stays underneath forever, the bundled-floor law.

| Surface | Packaging | Native channel | App end | Status |
|---|---|---|---|---|
| Safari iOS | the declared appex | **live** (`sendNativeMessage` ⇄ App Group) | the native app | **landed** |
| Safari macOS | the SAME appex + `swift/` lane, riding the M1 Mac target (the `Core/Extensions/Mac` family, `desktop-status.md`) | live when M1 lands — plus the REAL APIs iOS lacks (`showPreferencesForExtension`, a true enabled query) | the native app | staged (M1) |
| Chrome / Edge desktop | the zip | none TODAY — and no longer vacuous: D2's packaged desktop app (msi/deb/AppImage) is exactly the artifact that CAN register a native-messaging HOST manifest | the web app (extension-local floor) today; the desktop app once the D2 rung lands | landed floor · staged rung (D2) |
| Firefox desktop | the same zip | none today; the same D2 host-manifest rung (Firefox's own manifest location, same mechanism) | the web app today | landed; AMO listing (gecko id) + D2 rung staged |
| Firefox on Android | the same zip via AMO (installs in the browser, no APK) | none — GeckoView offers no third-party native messaging | the web app | landed; listing staged |
| Chrome on Android | **none exists** — no APK can inject an extension into Chrome | — | — | honestly absent; Android's siblings are OS extension points (Share target, Keyboard, widgets — their own modules; a `ProcessText` module is the content-script analogue, staged) |

The payload speaks `globalThis.browser ?? globalThis.chrome` and declares BOTH
`background.service_worker` (Chrome) and `background.scripts` (Safari/Firefox)
— each browser takes its key. Failure is value-level everywhere
(`{ ok: false, error | reason }`), the container law.

## The auth plane — the extension borrows a session, it never owns identity

**Where an app end has a session, the extension borrows it — scoped and
revocable; only where NO app end can have one does the extension run its own
flow. And the credential is the first secret-class datum in this system, so it
gets the policy the state bag never needed: a dedicated store and a closed
audience.**

- **Native surfaces**: the APP decides to lend its session —
  `dsx.module.webextension.grant({ token, accountId, expiresAt })` after its
  own OAuth/Clerk/session flow (nothing auto-grants; lending a session to a
  browser is a customer policy act). Storage is the **shared keychain** via
  the app-group access group (`WebExtensionAuthStore`) — never the App Group
  UserDefaults, never `webextVars`: the mailbox is not a vault. `revoke()`
  takes it back; an expired grant deletes itself on read.
- **Local surfaces** (Chrome/Edge/Firefox where the site is the app end): the
  signed-in SITE grants the same way — `ext.auth.grant(...)` from
  `@despia-native/webext` — into extension-private storage.
- **Standalone** (no signed-in app end anywhere): the hub runs
  `identity.launchWebAuthFlow` + PKCE (public client, S256, state-checked)
  against the customer's OAuth, configured per app via `oauth_*` config keys
  stamped into the ZIP as `oauth.json` (the committed payload never carries
  it; the packager aborts on partial config). The only browsers lacking the
  API — Safari, Firefox Android — are exactly the ones with a better path.
- **The audience law**: `auth.token` is served ONLY to extension contexts
  (popup/background). A matched page asking is refused at the hub AND again
  at the Safari handler (`audience_denied` — defense in depth, sender-derived
  origins, never page claims). Pages get `auth.status` — they need to KNOW,
  not to HOLD; a page inside the app or on the site has its own session.
- Sign-out narrows and is therefore always allowed from the extension side;
  `grant` over the wire on a native surface answers `native_owns_state` (the
  app grants through the bus, nothing else); `signin` on Safari settles
  `open_app` (the appex has no UI — signing in is the app's act).

## Hardening roadmap — from transport-complete to protocol-complete

An external review (2026-07) landed the right frame: v1 is
**transport-complete, not protocol-complete** — the remaining work is not more
routes but behavior under concurrency, crashes, upgrades, account changes,
hostile page code, and partial transport failure. Accepted, staged in order;
one earlier claim is AMENDED: the conformance exemption ("no corpus owed — not
authoring grammar") was too narrow — a cross-language protocol implemented by
five runtimes (hub, content bridge, npm SDK, Swift bridge, appex handler, the
D2 host) earns canonical fixtures on its own merits.

1. **Protocol v1 spec**: versioned envelopes (`protocol: 1`), request ids,
   uniform response shape, typed error codes with `retryable`, size limits
   (one Despia-wide cap well under Chrome's transport limits), and a shared
   fixture corpus run by every implementation.
2. **Status state machine** replacing bare `native: boolean`: mode ×
   availability × owner + owner epochs; the cardinal rule — a generic
   native-messaging failure NEVER auto-transfers ownership to the web app
   (degrade + backoff, don't flip); state persisted, not held in MV3 worker
   globals.
3. **Durable delivery**: leased, acknowledged `drain` (at-least-once +
   dedup ids), TTLs, queue/byte caps with a backpressure error, dead-letter
   policy, account-switch cleanup; the Safari queue moves from UserDefaults
   to a crash-safe journal (UserDefaults keeps only small status values).
4. **Ownership scope**: one authoritative owner per
   `{app, extension install, browser profile, account}` — not per "surface";
   revisioned writes (`expectedRevision` → `revision_conflict`) or an owner
   lease for multi-tab; an account-generation id that expires state, queue,
   and leases on logout/user change.
5. **Key visibility policy**: per-key `readableBy`/`writableBy`/sensitivity
   generalizing the auth audience gate to the whole vars plane; per-app
   Safari manifest stamping becomes a RELEASE BLOCKER (exact host matching is
   part of the security boundary); iframe access off by default; rate limits.
6. **Manifests as compiled targets**: one common model generating validated
   per-browser outputs (Firefox Android's MV2/event-page reality, pinned
   gecko/gecko_android ids, stable store identities per channel) + store
   policy metadata (data-collection, permission justifications) declared in
   dsx.json and failed at packaging when inconsistent.
7. **Native validation as a merge gate**: archive with the appex embedded,
   entitlement + bundle-id verification on both processes, handler and
   shared-store smoke tests, module-excluded archive test — a green JS suite
   proves none of that.
8. **The relay SPI** (Android arrival): pairing, publish/pull/ack cursors,
   replay protection, multi-device fan-out, push as an ARRIVAL HINT over the
   authoritative backend event; App Links carry opaque event ids, never
   payloads.
9. **Bus semantics + SDK lifecycle**: commands (exactly-once, module-executed,
   result broadcast) vs broadcasts (per-consumer cursors, replay on mount);
   SDK `onStatusChanged`/`onMessagesAvailable`, resync on visibility/account/
   reconnect, and a discriminated detection result (absent vs not-allowed vs
   unavailable-retryable) richer than `null`.

## How the extension talks to each consumer

- **A normal web app** (any matched site): the page envelope above, both
  directions — wrapped for real-world use by **`@despia-native/webext`**
  (`OpenSource/Web/packages/webext`, npm-publishable): one typed import, total
  across all four contexts (in-app → delegates to the real module; native →
  read/send; local → app-end verbs; absent → `null`), never throwing, never
  minting a `dsx` global (the in-app detect stays the kernel's). Script-tag
  pages can still speak the raw envelope. Plus the extension's own direct leg
  (popup/background `fetch` to the customer's backend under its own
  permissions, no page involved).
- **A DSX web app** (the Despia Web renderer): identical mechanics — in a
  browser tab it IS a normal page. The typed envelope surface in the web
  kernel is staged, and the moment it becomes authoring API the
  unified-codebase law applies (corpus first, three renderers).
- **The DSX native app**: the extension never runs inside it (not in Dom's
  WKWebView, not in the `Mandatory/Browser` SFSafariViewController tab — the
  OS runs web extensions only in Safari itself). The talk is the App Group
  plane on iOS/macOS (M1); the D2 desktop app talks to desktop browsers over
  its registered host manifests; on Android there is no OS path from any
  browser extension to the app — the backend is the rendezvous, the
  generalization of this proposal's no-live-socket law: **the backend is the
  meeting point wherever the OS offers nothing better.**

## What v1 deliberately does NOT add

- **Zero new authoring surface.** No new DSX grammar, no JSE builtin, no new
  head block — so the unified-codebase law's fixtures-first gate is not
  triggered. The popup is plain HTML in v1; the moment a DSX-authored popup
  (compiled by the web kernel) lands, THAT wave brings the corpus.
- **No WebKit, no web-surface exception.** The appex handler imports
  SafariServices (message keys), never WebKit; rule 6's Dom monopoly is
  untouched. The extension's web content runs in Safari's/Chrome's own
  process — outside `web-surface-policy.md`'s jurisdiction entirely.
- **No live app↔extension socket.** The OS doesn't offer one; pretending
  otherwise (polling loops, Darwin-notification relays held open) buys
  latency theater for battery. Queue + drain is the honest shape.

## Migration ledger

| Piece | Status |
|---|---|
| `Core/Extensions/WebExtension` module: manifest, bridge, store, appex handler, payload | **landed** |
| Safari appex as a DECLARED target (unknown-kind + `nsExtension` door, zero script edits) | **landed** |
| App-Group message plane (vars / queue / heartbeat) + `screen.ready` web buffering | **landed** |
| The COMPLETE page envelope: request/response with reply + timeout detect, the six-verb grammar total on every surface, the one-owner law (`native_owns_state`), the extension-local floor (`browser.storage`) for every no-native browser, sender-stamped origins | **landed** |
| `@despia-native/webext` — the page SDK (npm package, `OpenSource/Web/packages/webext`): one typed import total across in-app / native / local / absent, in-app delegation to the real module, no `dsx` global minted | **landed** (repo + gates; the npm PUBLISH itself needs the org/token — a release-lane row) |
| The AUTH plane: borrowed sessions (app grants → shared keychain via the app-group access group; site grants → extension storage), the closed token audience (hub + handler refusals), `launchWebAuthFlow` + PKCE standalone rung with packager-stamped `oauth.json`, `grant`/`revoke`/`authStatus` module actions, SDK `auth` namespace | **landed** |
| Protocol v2 hardening (the review's ladder: versioned wire spec + shared fixtures · status state machine + owner epochs · leased/acked durable delivery + journal store · `{install, profile, account}` ownership scope + revisions · per-key visibility policy · compiled per-target manifests + store metadata · native CI gates · the relay SPI · bus command-vs-broadcast + SDK lifecycle) | staged — the section above, in order |
| `build_webextension.rb` — the Chrome zip with package-time identity stamping | **landed** |
| Platform-facet stylesheets exempt from the DSX-CSS catalog (`lint_dsx_css` — a `web/` popup.css is the BROWSER's CSS; the rule-12 "platform asset trees" boundary, one vocabulary point) | **landed** |
| Ships OFF by default (`Config/excluded.json`), like every other extension surface | **landed** |
| Icon fill (payload `icons` + appiconset) — the `generate_icons` wave | staged |
| Per-app stamping of the SAFARI-side payload (manifest name/matches at prepare) | staged |
| DSX-authored popup compiled by the web kernel (fixtures first — the corpus wave) | staged |
| macOS Safari (the SAME appex + swift lane riding the M1 Mac target — bucket E joins the `Core/Extensions/Mac` family; real enable/enabled APIs replace the heartbeat heuristic there) | staged (M1) |
| Desktop-browser NATIVE channel — D2's packaged app registers Chrome/Edge/Firefox native-messaging HOST manifests; surfaces flip to `native: true` with zero payload changes (native-ness is per-call discovered) | staged (D2) |
| Chrome Web Store / Firefox AMO upload lanes in CI (gecko id for the AMO listing) | staged |
| Typed envelope surface in the DSX web kernel (becomes authoring API ⇒ fixtures first, three renderers) | staged |
| `ProcessText` sibling module — Android's content-script analogue (`ACTION_PROCESS_TEXT`, selection-toolbar presence in any app incl. Chrome; `android/`-only, the mirror of this module's ios-only map row) | staged (own module, own PR) |

## Design provenance

The Keyboard package proved every hard part on this exact OS boundary: a
separate-process surface owned by one module, the App Group as the only
transport, heartbeat-as-status, queue-drained-on-foreground events, the
committed payload as the bundled floor. Declared targets proved the packaging:
a whole product as manifest data the scripts hold no names for. Cross-industry:
Apple's own `safari-web-extension-converter` wraps ONE WebExtension for both
worlds the same way; Expo config plugins regenerate the native target from
declared config rather than hand-wiring it.
