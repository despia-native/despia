# OAuth HTTPS Callback: Cross-Platform Specification

> The `type=https` contract of the `Core/Auth/OAuth` module: an OAuth / social sign-in
> whose provider redirects to an **https URL on the app's own host** instead of the
> custom URL scheme. Implementations: `Core/Auth/OAuth/swift/` (ASWebAuthenticationSession,
> `.https` callback) and `Core/Auth/OAuth/kotlin/` (Auth Tab, verified-App-Link fallback).
> The two must stay in step — the same call selects the same set of URLs on both
> platforms. The HTTPS callback is the recommended flow for providers that demand an
> https `redirect_uri`; the legacy custom-scheme flow remains supported indefinitely and
> is the automatic fallback for every invalid input.

## 1. Overview

The legacy contract sends the provider back to `<appscheme>://oauth/<path>?…`; the
runtime strips the `oauth` host and rebases path+query onto the app's base URL. That
flow drops the URL **fragment** (where implicit-flow tokens live), requires a custom
scheme registered with the provider, and several IdPs (Google's installed-app policy,
Microsoft Entra, others) now demand an https redirect URI outright.

The HTTPS callback runs the same call through a native auth session that ends on the
app's own domain:

1. The page calls `dsx.module.oauth({ url, type: "https" })` — or the migrated v3
   spelling `despia('oauth://?url=<encoded>&type=https')`. There is no path
   parameter: the session watches the whole host.
2. The runtime opens the provider URL in the platform auth surface
   (ASWebAuthenticationSession / Auth Tab or Custom Tab).
3. The provider redirects to `https://<own host><path>?…`.
4. The session/tab closes and **that exact URL** loads in the web view — path, query
   AND fragment, verbatim. Never rebased onto the start URL, never sanitized.

### Platform mapping

| | iOS | Android |
|---|---|---|
| Session | `ASWebAuthenticationSession` with `Callback.https(host:path:)` | **Auth Tab** (`androidx.browser.auth.AuthTabIntent`, primary) → verified App Link + Custom Tab (fallback) |
| Callback mechanism | The session's own matcher (+ the universal-link interception for the race, §4) | Auth Tab `AuthResult` (+ the `lifecycle.openURL` fan for the App-Link fallback) |
| Minimum version | iOS 17.4 | Auth Tab: a supporting browser (Chrome 137+); App-Link fallback: API 31+ for the verified promise |
| What closes the session | The OS, on the first URL matching host + path prefix | Auth Tab: the browser (Digital Asset Links); fallback: `singleTask` relaunch tearing down the tab |
| Domain association | `webcredentials:` in the AASA | `assetlinks.json` (both Auth Tab and App Link verify against it) |
| Loads the result | `dsx.module.dom.load`, main-thread, verbatim | `dsx.module.dom.load` verbatim (staged on the launch-url override when the return beats the surface mount) |

## 2. Capability detection — `capabilities()`

The `redirect_uri` is baked into the authorize URL before the flow starts and cannot be
swapped mid-flow, so ask the device **first**:

```js
const caps = await dsx.module.oauth.capabilities();
// iOS:     { httpsCallback, customScheme, iosVersion }
// Android: { httpsCallback, customScheme, androidVersion }

const redirectUri = caps.httpsCallback
  ? "https://yourapp.com/welcome"         // any URL on your host; register BOTH
  : "yourappscheme://oauth/callback";

await dsx.module.oauth({
  url: buildAuthorizeUrl(redirectUri),
  ...(caps.httpsCallback ? { type: "https" } : {})
});
```

Native and markup consumers can read the same answer reactively as
`dsx.module.oauth.context.httpsCallback`. Pages migrated from the v3 runtimes can read
it synchronously instead (§2.1). Every identifier on every one of those surfaces is
white-label.

The platforms answer with different certainty:

| Platform | Semantics |
|---|---|
| iOS 17.4+ | **Prediction.** True when the API exists and a static own host is configured with no live origin override. The `webcredentials` association has no runtime query API; a broken one still reports true and surfaces at session start as the `error` event with `host`/`code` plus the ambient `association_failed` (§6). |
| Android | **Promise.** True only when (a) the default browser supports the Auth Tab, or (b) API 31+ `DomainVerificationManager` confirms the host VERIFIED against `assetlinks.json` (or user-SELECTED) *and* link handling is enabled. A missing `assetlinks.json` therefore degrades to the legacy flow instead of stranding the user. The OS verification query is cached per process. |
| Android < 12, no Auth Tab | Always false — no query API exists, and an unverified link shows a chooser mid-login. These devices stay on the legacy flow. |
| Origin override active | Always false on both platforms (DevSettings dev origin, a dynamic-host migration target unknown to this build): an override host holds no association, so the runtime declines the HTTPS callback entirely. |

Every integration must keep the legacy branch. The flag decides which `redirect_uri`
gets registered, and that decision cannot be changed mid-flow.

### 2.1 The legacy window surface

The promise above is the modern read. Pages carried over from the v3 runtimes read a
plain boolean synchronously instead, because they choose a `redirect_uri` *before* the
flow starts and there is nothing to await at that moment. Both runtimes therefore also
install, at document start and on every navigation:

```js
window.httpsAuthCallback          // boolean, the same answer capabilities() resolves
window.onAuthCallbackError(host, code)   // optional page-defined callback, association failures
```

Neither name carries a vendor: a white-labelled app ships the customer's product, so the
page API cannot say "despia". The runtime only ever sets `window.*`; the npm package is
what re-exposes values on its own object.

`window.onAuthCallbackError` is additive. The modern channels (the `error` broadcast and
the `association_failed` ledger entry) fire regardless, and the runtime guards on the
function existing, so a page that only uses the modern surface pays nothing.

## 3. The `type` parameter

| Value | Result |
|---|---|
| `"https"` (case-insensitive) | https callback on the app's own static host, watching the **whole host** |
| absent / any other value | legacy custom-scheme flow — **fail closed**: legacy works, and a session registered on something that cannot match never closes |
| no static host, or a live origin override | legacy flow — a dev-origin or unknown migration host holds no association |
| authorize URL itself on the callback host | legacy flow, with a logged explainer (§3.1) |

The host resolves from the app's **static** identity — the bundled `App.json` hosts plus
Dom's static `host` config — never the live launch URL, which push and deep-link handling
reassign at runtime.

### 3.1 There is no path parameter

A `callback` path that narrowed the match to one prefix used to exist. It was removed,
because it was never needed and it taught the wrong thing: that a path had to be chosen,
when a wrong choice fails in ways that look like a working login until someone reads the
URL bar.

The case it existed for is a flow that transits its own host mid-auth — a backend that
receives `?code=` and swaps it for tokens before redirecting onward. Under the host-wide
match the session does end at that hop, and nothing is lost: it ends at *navigation*
time, before the request is issued, so the code has not been consumed. The web view is
handed that exact URL, re-issues it, and follows the remaining redirects itself, so the
exchange completes in the WEB VIEW's cookie jar — where the session cookie has to land
anyway, and strictly better than completing it inside a session about to be discarded.

The one shape that genuinely cannot work is an authorize URL **itself** on the callback
host (NextAuth and most server-side SDKs hand you exactly that): the session's own first
navigation would match and close it before the provider is shown. Both runtimes detect
that, decline the https flow, log the fix — pass the provider's own authorize URL — and
run the legacy flow.

### 3.2 The `url` value is decoded exactly once, or not at all

Which one depends on how the call arrives, and both runtimes answer the same way:

| Call shape | What happens to `url` |
|---|---|
| `dsx.module.oauth({ url })` | Nothing. The argument arrives typed and untouched, so the string the page built IS the string the provider gets. |
| `despia('oauth://?url=<encoded>&type=https')` | Decoded exactly **once**, off the raw query. |

The v3 wire spelling therefore takes `encodeURIComponent(authUrl)` on the way in and one
percent-decode on the way out. Never decode again on top of that: an authorize URL
carries escapes of its own, and unwrapping them corrupts the request. A `state` of
`xY%2Bz` becomes `xY+z`, which a form decoder at the provider reads back as `xY z`, so
the echoed `state` no longer matches the one the page stored; a `%26` becomes a real `&`
and splits one parameter into two.

Both runtimes read the wire form off the **raw** query rather than the bridge's smart
parser, which is a separate trap in the same place: that parser splits comma-containing
values into arrays and folds `+` into a space, and an authorize URL routinely carries
both (comma scope lists, base64url `state`).

An unencoded URL does not work and never did: its own `&` separators end the `url`
parameter, and everything after the first is read as a parameter of the `oauth://` call.

## 4. Intermediate hops and the universal-link race (iOS)

The callback host is normally also an `applinks:` domain, so iOS can hand the
provider's redirect to the app as a **universal link** before the session's own
matcher sees it. The runtime intercepts the continuation with a two-level test:

1. **Ownership** — https + exact (lowercased) host equality with the running session's
   registered host. Not ours → the normal routing runs (any open sheet is dismissed —
   a real deep link should close it).
2. **Finality** — raw path prefix against the registered path (skipped when the path
   is `/`). A match consumes the link: the session is cancelled, the URL loads
   verbatim. **A non-match on the own host is an intermediate hop: it is IGNORED and
   the session keeps running.** Consuming it — or letting it fall through to the
   dismiss-on-deeplink path — cancels the session mid-flow with the token still in
   flight.

Android's App-Link fallback applies the same discipline through the pending pair: an
own-host URL that doesn't match the armed prefix is left unconsumed and the pair stays
armed.

## 5. The Android chain — Auth Tab primary, App Link fallback, legacy last

1. **Auth Tab** (`AuthTabIntent`, androidx.browser 1.10): the true
   ASWebAuthenticationSession equivalent. The launcher registers in
   `MainActivity.onCreate` — before the activity reaches STARTED, the androidx
   requirement — through the generated `activityInitializers` seam. The browser
   verifies the host via Digital Asset Links (the same `assetlinks.json`) and returns
   `AuthResult { resultCode, resultUri }`: `RESULT_OK` loads `resultUri` verbatim;
   `RESULT_VERIFICATION_FAILED` / `RESULT_VERIFICATION_TIMED_OUT` log loudly and
   surface the association failure (§6).
2. **Verified App Link + Custom Tab** (no Auth Tab support): the plain tab opens with
   the pending `{host, path}` pair persisted in the module's container — it must
   survive **process death** behind the tab; the return can land in a fresh process
   where the cold-start relay redelivers it after module hooks are registered. The
   pair is one-shot: **cleared before loading** (copy → clear → load), so re-entrant
   loaders — offline recovery, renderer crash — can never replay a consumed one-time
   auth code.
3. **Legacy custom scheme**: untouched, byte-identical.

### `RESULT_CANCELED` is ambiguous — by design

On a browser without Auth Tab support the same intent degrades to a plain Custom Tab
and the launcher only ever returns `RESULT_CANCELED` — including after a *successful*
login, because the App-Link relaunch tears the tab down first and the launcher's
result arrives after the callback was already consumed. `RESULT_CANCELED` therefore
counts as a user abort **only while the pending pair is still armed**. The
`becomeActive` cancel heuristic (the Custom Tab flows' dismissal detector) stands down
while an Auth Tab flow is in flight — its result callback is the single cancellation
emitter for that flow.

## 6. Failure surface

All failures ride the module's existing channels — no bespoke events, no window
globals:

- The `error` broadcast on the `oauth` scheme keeps its wire shape:
  `{ reason: "cancelled" | "failed" }`. Association failures **add** `host` and
  `code` fields (additive — old handlers keep working).
- The ambient error ledger receives the declared `association_failed` code (visible on
  the page as the reserved `dsx` mirror, `dsx.errors`, and `global.dsx.lastError`).
- The native console logs a loud explainer naming exactly what to fix
  (`webcredentials:<host>` / `assetlinks.json`).

```js
const off = dsx.on("oauth", (p) => {
  if (p.event === "result") setSession(p.data);
  else if (p.event === "error") {
    stopSpinner();
    if (p.data.host) reportAssociationFailure(p.data.host, p.data.code);  // https-callback only
  }
});
```

### A missing association looks exactly like a user cancel (iOS)

`ASWebAuthenticationSession.start()` only reports synchronous problems. A missing
`webcredentials:` association arrives **asynchronously** as `.canceledLogin` — the same
code as a user dismissal — distinguishable only by its non-empty `userInfo`. The
runtime makes that distinction; a genuine cancel is reported as `cancelled`, everything
else as the association failure above. There is deliberately **no automatic legacy
retry** on an association failure: the page built its authorize URL for the https
`redirect_uri`, and a second sheet against the same URL strands the user twice.

### Failure modes

| Symptom | Cause |
|---|---|
| Sheet/tab opens, closes immediately, `error` with `host`/`code` | Missing `webcredentials:` association (iOS) / failed Digital Asset Links verification (Android Auth Tab) |
| Login completes in the tab but nothing returns to the app (Android, API 31+) | `assetlinks.json` missing or not yet propagated — an unverified App Link is **silently ignored** by the OS |
| Login completes, user lands in the app on the home page | The callback path doesn't prefix-match the redirect's real path |
| Works on iOS, chooser appears on Android < 12 | No Auth Tab and no verification API — those devices must use the legacy flow (the capability answers false; honor it) |
| `?code=` arrives instead of a token | The path was too broad (`/`) and consumed an intermediate hop — name the real terminal path |
| Flow works in development, fails after a domain move | The new host isn't part of this build's static identity — ship an `App.json` update |
| `capabilities().httpsCallback` false in a TestFlight/dev build | A dev-origin override is active; the runtime declines the HTTPS callback while overridden |

### AASA caching (iOS)

Apple's CDN caches a **failed** AASA fetch. If the file was wrong at first install,
fixing the server is not enough — reinstall after the CDN revalidates. Review rejects
`?mode=developer` builds, so verify on a real device with the production file early.

## 7. Prerequisites (outside this repository)

Both associations are per-app **configuration**, not build steps — the generators
consume the same values (`core_packages.json` → the `App` package's
`associated_domains`):

```json
{ "App": { "associated_domains": [
    "applinks:yourapp.com",
    "webcredentials:yourapp.com"
] } }
```

- **iOS**: the entitlement is spliced from that list. The AASA at
  `https://yourapp.com/.well-known/apple-app-site-association` (served
  `application/json`, https, no redirects) needs **BOTH** sections — an
  `applinks`-only AASA verifies deep links while sign-in silently fails:
  ```json
  {
    "applinks":       { "apps": [], "details": [ { "appID": "TEAMID.bundle.id", "paths": ["*"] } ] },
    "webcredentials": { "apps": ["TEAMID.bundle.id"] }
  }
  ```
- **Android**: every `applinks:` entry becomes a generated `autoVerify` HTTPS VIEW
  filter plus the runtime allowlist, failing the build closed on invalid hosts. Serve
  `https://yourapp.com/.well-known/assetlinks.json` for the app's signing key — the
  Auth Tab verifies against the same file.
- **Provider**: register **both** redirect URIs (https and custom-scheme) so either
  path works without a rebuild.

## 7.1 Narrowing what else opens the app (Android)

`applinks:yourapp.com` generates an `autoVerify` filter with **no path attribute**, so
every https URL on that host opens the app, not just the callback. For an app that only
wants sign-in, that is far wider than intended: a link to `/invoices/8821` in someone's
email cold-starts the app instead of opening the browser.

Two ways to avoid it, in order of preference:

**Don't register `applinks:` at all.** The Auth Tab returns the redirect as an activity
result and routes nothing through intents, so sign-in needs only `assetlinks.json` on the
domain. Omit the `applinks:` entry, no filter is generated, nothing is intercepted. The
filter is required only for the pre-Auth-Tab App Link fallback. iOS is the same shape:
the callback is gated on `webcredentials`, a service separate from `applinks`, so
`webcredentials:` alone works and the universal-link race in §4 cannot arise.

**Or narrow it.** Set `app_link_paths` on the App package and the filter becomes an
allowlist:

```jsonc
{ "App": { "associated_domains": ["applinks:yourapp.com", "webcredentials:yourapp.com"],
           "app_link_paths": ["/invite"] },
  "OAuth": { "app_link_paths": ["/callback"] } }
```

```xml
<data android:host="yourapp.com" android:scheme="https" android:pathPrefix="/invite" />
<data android:host="yourapp.com" android:scheme="https" android:pathPrefix="/callback" />
```

Empty (the default) keeps the host-wide filter, so existing apps are unaffected. Entries
union across every ENABLED module, which is why OAuth declares its own callback path:
narrowing your deep links can then never silently lock out the sign-in return, and
excluding the module drops its entry. `pathPrefix` matches on every API level, unlike the
`pathAdvancedPattern` negation chains a denylist would need (API 31+, silently ignored
below). The runtime re-checks the same prefixes in `AppLinkPolicy` because MainActivity is
exported and an explicit VIEW intent bypasses manifest matching.

***

## 8. Legacy custom-scheme flow

Unchanged and supported indefinitely — see the module README for the full contract
(`<appscheme>://oauth` native mode, `<appscheme>://oauth/<path>` redirect mode). Calls
without `type=https` take it automatically, byte-identically to before this
feature existed. Its known limitations — fragment loss, rebase onto the live base URL,
custom-scheme `redirect_uri` policy walls — are exactly what the HTTPS callback
resolves.

## 9. Verifying on a device

The association machinery cannot be exercised in a simulator ("not associated" is the
expected simulator failure). The device matrix that proves a build:

- iOS 17.4+: success, user cancel, association failure (remove the AASA section),
  intermediate own-host hop (multi-redirect provider), fragment-carrying token.
- Android with Chrome stable (Auth Tab): success, cancel, verification failure
  (remove `assetlinks.json`).
- Android with a non-Auth-Tab browser as default: the degraded interleave — App-Link
  return, then the launcher's late `RESULT_CANCELED` (must NOT emit a cancel), plus
  process death behind the tab (cold-start return).
