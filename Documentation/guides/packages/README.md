# Package catalog

The native capability catalog, by category — the packages you'll reach for most
(each module's own `README.md` is the exhaustive per-module reference). Call any
of these with the modern API:
`await window.dsx.module.<scheme>.<method>(params?)` (or scheme-only
`window.dsx.module.<scheme>(params?)`). Each package's folder under
The production modules live in the monorepo's commercial layer; this table is their
public reference, and the exhaustive per-module documentation is at
[docs.despia.com](https://docs.despia.com).

Parenthesized schemes are **aliases** — extra schemes routed to the same package
(usually legacy names kept for shipped pages), not separate capabilities.

Check availability first for optional packages: `window.dsx.has("<name or scheme>")`.

---

## Mandatory (always present)

| Package | Scheme(s) | What it does |
|---|---|---|
| **Dom** | `dom` | Control the web view: `dom.load/reload/back/forward/stop/eval`; lifecycle events |
| **State** | `global` (+ legacy `state`) | App-wide reactive store — backs `window.dsx.global.get/set/watch` |
| Routing | `route` *(kernel-owned — the package is scheme-less and feeds the Router its table)* | OTA route table + navigation: `route.push/pop/replace/reset`, `global.route.*` (`window.despia.navigate('/path')` is the legacy nav helper) |
| **Browser** | `browser` | Open a link in an in-app Safari tab: `window.dsx.module.browser.open({ url })` |
| **Foundation** | *(components, no scheme)* | The DSX component libraries (stacks, lists, inputs, `video`, `sheet`, forms) + the DSX frame-content renderers (`DSXWebView`/`DSXView`) |

> **Legacy aliases, owned by a real module:** `getappversion` / `getstorelocation` /
> `checknativepushpermissions` are aliases of the shipped **Metadata** package (below) —
> they keep old pages working (see [legacy.md](../../legacy.md)); new code calls
> `window.dsx.module.metadata.*`.

## Core / Basics — device & UX

| Package | Scheme(s) | What it does |
|---|---|---|
| **Haptics** | `haptic` (+ `lighthaptic`/`mediumhaptic`/`heavyhaptic`/`successhaptic`/`warninghaptic`/`errorhaptic`) | Haptic feedback + custom CoreHaptics patterns |
| **Location** | `location`, `stoplocation` | Background GPS tracking (streams position) |
| **Gyroscope** | `gyroscope` | Stream motion + heading |
| **Flashlight** | `enableflashlight`, `disableflashlight` | Torch on/off |
| **StatusBar** | `statusbar` (+ `statusbarbackgroundcolor`, `statusbartextcolor`) | Status-bar color / text style / transparency |
| **Spinner** | `spinner` (+ `spinneron`, `spinneroff`) | Page-load activity spinner |
| **Screenshot** | `takescreenshot` | Capture the screen to the photo library |
| **AppIcon** | `changeicon` | Switch the home-screen icon (`default`/`icon1`/`icon2`/`icon3`) |
| **AppRating** | `rateapp` | Native rating prompt (or custom App Store dialog) |
| **AppSettings** | `settings`, `settingsapp` | Open iOS Settings (with notification / default sub-pages) |
| **ExternalApps** | `x` (+ `twitter`, `fb`, `instagram`, `youtube`, `coinbase`, `uber`, `lyft`) | Open another app via its deep link |
| **ValueStore** | `writevalue`, `readvalue` | Simple persisted web key/value (`window.storedValues`) |
| **Clipboard** | `clipboard`, `getclipboard` | Read / write the system clipboard |
| **ScreenBrightness** | `scanningmode` | Max brightness for scanning, then restore |
| **ScreenRadius** | `screenradius` | Expose device corner radius (`window.screenRadius`, `--screen-radius`) |
| **PreventDefault** | `preventdefault` | Disable iOS keyboard autoscroll |
| **Focus** | `focus` | App foreground/background callbacks |
| **Siri** | `addtosiri` | Siri shortcut integration *(off by default)* |
| **DeviceUUID** | `uuid` (+ legacy `get-uuid`) | Vendor identifier (`window.uuid`) |
| **Metadata** | `metadata` (+ `getappversion`, `getstorelocation`, `checknativepushpermissions`) | App version, store location, push-permission state |
| CriticalAlerts | *(capability only)* | Critical-alert push entitlement |

## Core / Web platform — permissions & polyfills

| Package | Scheme(s) | What it does |
|---|---|---|
| **Contacts** | `contacts`, `readcontacts`, `requestcontactpermission` | Prompt + read contacts in one call |
| **AppTracking** | `apptracking` (+ legacy `user-disable-tracking`, `trackingconsent`) | App Tracking Transparency prompt + status |
| **SpeechRecognition** | `speechrecognition` | Native `SpeechRecognition` polyfill (WKWebView lacks it) |
| **SpeechSynthesis** | `speechsynthesis` | Native text-to-speech (`AVSpeechSynthesizer`) |
| Camera / Microphone / PhotoLibrary / Calendars / Location / NFC | *(permission strings only)* | Declare the Info.plist usage strings for those Web/native APIs |

## Core — capture, files, sharing

| Package | Scheme(s) | What it does |
|---|---|---|
| **QRScanner** | `scanner`, `qrcode` | Scan a QR / barcode |
| **CameraRoll** | `savethisimage`, `gallery` | Save a URL / File / Blob to Photos |
| **FileSharing** | `sharefile`, `download` | Fetch a file and open the share sheet (auto for downloads) |
| **SocialShare** | `share`, `shareapp` | Native share sheet for text / links / files |
| **FileViewer** | `fileviewer` | Preview files in QuickLook |
| **PrintDocuments** | `printitem` | AirPrint a document |
| **Wallet** | `wallet` | Add a `.pkpass` to Apple Wallet |
| **NFC** | `nfc` | Read NFC tags *(device only; off by default)* |
| **Bluetooth** | `bluetooth` | BLE/GATT central *(off by default)* |

## Core — commerce

| Package | Scheme(s) | What it does |
|---|---|---|
| **Store** | `store` | Unified commerce (StoreKit2 / RevenueCat): `store.paywall/checkout/restore/entitlements/catalog/…` |
| **RevenueCat** | `revenuecat`, `getpurchasehistory` | RevenueCat purchases, paywall, customer center |
| **Stripe** | `stripe` | Native Stripe PaymentSheet (`stripe.payment`) + CustomerSheet (`stripe.manage`) |
| **AdMob** | `admob`, `displayrewardedad` | Rewarded / interstitial ads + UMP consent |
| **MetaAudienceNetwork** | `metaads` | Meta Audience Network ads |

## Core — auth & identity

| Package | Scheme(s) | What it does |
|---|---|---|
| **OAuth** | `oauth` | OAuth / social sign-in via `ASWebAuthenticationSession` / Auth Tab; own-host [https callback](../oauth-https-callback.md) |
| **Clerk** | `clerk` | Native Clerk auth *(iOS 17+, off by default)* |
| AppleAuth | *(capability only)* | Sign in with Apple entitlement |
| **IdentityVault** | `identityvault`, `setvault`, `readvault` | Small iCloud-KVS vault with optional biometric gate |

## Core — push & analytics

| Package | Scheme(s) | What it does |
|---|---|---|
| **OneSignal** | `onesignal`, `getonesignalplayerid`, `setonesignalplayerid` | OneSignal push end-to-end |
| **Firebase** | `firebase`, `getfirebaseplayerid` | FCM token surface (`window.firebaseplayerid`) |
| **Pushwoosh** | `pushwoosh`, `getpushwooshid` | Pushwoosh push |
| **LocalPush** | `localpush`, `sendlocalpushmsg` | Schedule local notifications (incl. cron) |
| **AppsFlyer** | `appsflyer` | Install + event attribution, OneLink |
| **PostHog** | `posthog` | Native PostHog analytics |

## Core — data, health, media

| Package | Scheme(s) | What it does |
|---|---|---|
| **PowerSync** | `powersync` | Local SQLite + PowerSync sync |
| **HealthKit** | `healthkit`, `readhealthkit`, `writehealthkit` | HealthKit read/write |
| **Terra** | `terra` | Terra health/wearables bridge |
| **Stream** | `stream` | Stream Video calling *(off by default)* |
| **Widgets** | `widget` | Home-screen image widget |
| **QuickActions** | `quickactions` | Home-screen Quick Actions (set items; `tap` broadcast) |
| **ActionSheet** | `actionsheet` | Native bottom action sheet |

## Core / Extensions (separate targets)

| Package | Scheme(s) | What it does |
|---|---|---|
| **ShareExtension** | `sharetarget` | Receive shares from other apps |
| **ActivityKit** | `liveactivity` | Live Activities |
| **AppClip** | `appclip` | App Clip |
| **Watch** | `watch` | Apple Watch app (native DSX screens, OTA + phone relay) |
| **Keyboard** | `keyboard` | System-wide custom keyboard (DSX layouts, runtime re-skin) *(off by default)* |

## Custom (per-app)

| Package | Scheme(s) | What it does |
|---|---|---|
| **VerticalPlayerStack** | `verticalplayer` | Vertical short-drama player (Stack + AVPlayer) |
| **Demo** | `demo` | The on-device capability demo/diagnostics app — exclude from production |

---

*Pod-only packages with no scheme (host SDK wiring, not called from web):*
SwiftyGif, SwiftyStoreKit.

> Schemes are the routing identifiers; call them the current way,
> `window.dsx.module.<scheme>.<method>(…)`. (The pre-dot `window.virtual` / scheme-string forms are
> legacy — see [legacy.md](../../legacy.md).) For exact actions and
> payloads, see the per-module reference at [docs.despia.com](https://docs.despia.com).
