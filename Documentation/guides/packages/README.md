# Package catalog

The native capability catalog, by category — the packages you'll reach for most
(each module's own `README.md` is the exhaustive per-module reference). Call any
of these with the modern API:
`await window.dsx.module.<scheme>.<method>(params?)` (or scheme-only
`window.dsx.module.<scheme>(params?)`). Each package's folder under
`ClosedSource/DSX/Modules/<path>/` has a `README.md` with its full actions and payloads.

Parenthesized schemes are **aliases** — extra schemes routed to the same package
(usually legacy names kept for shipped pages), not separate capabilities.

Check availability first for optional packages: `window.dsx.has("<name or scheme>")`.

---

## Mandatory (always present)

| Package | Scheme(s) | What it does |
|---|---|---|
| [Dom](../../../../ClosedSource/DSX/Modules/Mandatory/Dom/README.md) | `dom` | Control the web view: `dom.load/reload/back/forward/stop/eval`; lifecycle events |
| [State](../../../../ClosedSource/DSX/Modules/Mandatory/State/README.md) | `global` (+ legacy `state`) | App-wide reactive store — backs `window.dsx.global.get/set/watch` |
| Routing | `route` *(kernel-owned — the package is scheme-less and feeds the Router its table)* | OTA route table + navigation: `route.push/pop/replace/reset`, `global.route.*` (`window.despia.navigate('/path')` is the legacy nav helper) |
| [Browser](../../../../ClosedSource/DSX/Modules/Mandatory/Browser/README.md) | `browser` | Open a link in an in-app Safari tab: `window.dsx.module.browser.open({ url })` |
| [Foundation](../../../../ClosedSource/DSX/Modules/Mandatory/Foundation/README.md) | *(components, no scheme)* | The DSX component libraries (stacks, lists, inputs, `video`, `sheet`, forms) + the DSX frame-content renderers (`DSXWebView`/`DSXView`) |

> **Legacy aliases, owned by a real module:** `getappversion` / `getstorelocation` /
> `checknativepushpermissions` are aliases of the shipped **Metadata** package (below) —
> they keep old pages working (see [legacy.md](../../legacy.md)); new code calls
> `window.dsx.module.metadata.*`.

## Core / Basics — device & UX

| Package | Scheme(s) | What it does |
|---|---|---|
| [Haptics](../../../../ClosedSource/DSX/Modules/Core/Basics/Haptics/README.md) | `haptic` (+ `lighthaptic`/`mediumhaptic`/`heavyhaptic`/`successhaptic`/`warninghaptic`/`errorhaptic`) | Haptic feedback + custom CoreHaptics patterns |
| [Location](../../../../ClosedSource/DSX/Modules/Core/Basics/Location/README.md) | `location`, `stoplocation` | Background GPS tracking (streams position) |
| [Gyroscope](../../../../ClosedSource/DSX/Modules/Core/Basics/Gyroscope/README.md) | `gyroscope` | Stream motion + heading |
| [Flashlight](../../../../ClosedSource/DSX/Modules/Core/Basics/Flashlight/README.md) | `enableflashlight`, `disableflashlight` | Torch on/off |
| [StatusBar](../../../../ClosedSource/DSX/Modules/Core/Basics/StatusBar/README.md) | `statusbar` (+ `statusbarbackgroundcolor`, `statusbartextcolor`) | Status-bar color / text style / transparency |
| [Spinner](../../../../ClosedSource/DSX/Modules/Core/Basics/Spinner/README.md) | `spinner` (+ `spinneron`, `spinneroff`) | Page-load activity spinner |
| [Screenshot](../../../../ClosedSource/DSX/Modules/Core/Basics/Screenshot/README.md) | `takescreenshot` | Capture the screen to the photo library |
| [AppIcon](../../../../ClosedSource/DSX/Modules/Core/Basics/AppIcon/README.md) | `changeicon` | Switch the home-screen icon (`default`/`icon1`/`icon2`/`icon3`) |
| [AppRating](../../../../ClosedSource/DSX/Modules/Core/Basics/AppRating/README.md) | `rateapp` | Native rating prompt (or custom App Store dialog) |
| [AppSettings](../../../../ClosedSource/DSX/Modules/Core/Basics/AppSettings/README.md) | `settings`, `settingsapp` | Open iOS Settings (with notification / default sub-pages) |
| [ExternalApps](../../../../ClosedSource/DSX/Modules/Core/Basics/ExternalApps/README.md) | `x` (+ `twitter`, `fb`, `instagram`, `youtube`, `coinbase`, `uber`, `lyft`) | Open another app via its deep link |
| [ValueStore](../../../../ClosedSource/DSX/Modules/Core/Basics/ValueStore/README.md) | `writevalue`, `readvalue` | Simple persisted web key/value (`window.storedValues`) |
| [Clipboard](../../../../ClosedSource/DSX/Modules/Core/Clipboard/README.md) | `clipboard`, `getclipboard` | Read / write the system clipboard |
| [ScreenBrightness](../../../../ClosedSource/DSX/Modules/Core/ScreenBrightness/README.md) | `scanningmode` | Max brightness for scanning, then restore |
| [ScreenRadius](../../../../ClosedSource/DSX/Modules/Core/ScreenRadius/README.md) | `screenradius` | Expose device corner radius (`window.screenRadius`, `--screen-radius`) |
| [PreventDefault](../../../../ClosedSource/DSX/Modules/Core/Basics/PreventDefault/README.md) | `preventdefault` | Disable iOS keyboard autoscroll |
| [Focus](../../../../ClosedSource/DSX/Modules/Core/Basics/Focus/README.md) | `focus` | App foreground/background callbacks |
| [Siri](../../../../ClosedSource/DSX/Modules/Core/Basics/Siri/README.md) | `addtosiri` | Siri shortcut integration *(off by default)* |
| [DeviceUUID](../../../../ClosedSource/DSX/Modules/Core/DeviceUUID/README.md) | `uuid` (+ legacy `get-uuid`) | Vendor identifier (`window.uuid`) |
| [Metadata](../../../../ClosedSource/DSX/Modules/Core/Metadata/README.md) | `metadata` (+ `getappversion`, `getstorelocation`, `checknativepushpermissions`) | App version, store location, push-permission state |
| CriticalAlerts | *(capability only)* | Critical-alert push entitlement |

## Core / Web platform — permissions & polyfills

| Package | Scheme(s) | What it does |
|---|---|---|
| [Contacts](../../../../ClosedSource/DSX/Modules/Core/WebPlatform/Contacts/README.md) | `contacts`, `readcontacts`, `requestcontactpermission` | Prompt + read contacts in one call |
| [AppTracking](../../../../ClosedSource/DSX/Modules/Core/WebPlatform/AppTracking/README.md) | `apptracking` (+ legacy `user-disable-tracking`, `trackingconsent`) | App Tracking Transparency prompt + status |
| [SpeechRecognition](../../../../ClosedSource/DSX/Modules/Core/WebPlatform/SpeechRecognition/README.md) | `speechrecognition` | Native `SpeechRecognition` polyfill (WKWebView lacks it) |
| [SpeechSynthesis](../../../../ClosedSource/DSX/Modules/Core/WebPlatform/SpeechSynthesis/README.md) | `speechsynthesis` | Native text-to-speech (`AVSpeechSynthesizer`) |
| Camera / Microphone / PhotoLibrary / Calendars / Location / NFC | *(permission strings only)* | Declare the Info.plist usage strings for those Web/native APIs |

## Core — capture, files, sharing

| Package | Scheme(s) | What it does |
|---|---|---|
| [QRScanner](../../../../ClosedSource/DSX/Modules/Core/QRScanner/README.md) | `scanner`, `qrcode` | Scan a QR / barcode |
| [CameraRoll](../../../../ClosedSource/DSX/Modules/Core/CameraRoll/README.md) | `savethisimage`, `gallery` | Save a URL / File / Blob to Photos |
| [FileSharing](../../../../ClosedSource/DSX/Modules/Core/FileSharing/README.md) | `sharefile`, `download` | Fetch a file and open the share sheet (auto for downloads) |
| [SocialShare](../../../../ClosedSource/DSX/Modules/Core/SocialShare/README.md) | `share`, `shareapp` | Native share sheet for text / links / files |
| [FileViewer](../../../../ClosedSource/DSX/Modules/Core/FileViewer/README.md) | `fileviewer` | Preview files in QuickLook |
| [PrintDocuments](../../../../ClosedSource/DSX/Modules/Core/PrintDocuments/README.md) | `printitem` | AirPrint a document |
| [Wallet](../../../../ClosedSource/DSX/Modules/Core/Wallet/README.md) | `wallet` | Add a `.pkpass` to Apple Wallet |
| [NFC](../../../../ClosedSource/DSX/Modules/Core/NFC/README.md) | `nfc` | Read NFC tags *(device only; off by default)* |
| [Bluetooth](../../../../ClosedSource/DSX/Modules/Core/Bluetooth/README.md) | `bluetooth` | BLE/GATT central *(off by default)* |

## Core — commerce

| Package | Scheme(s) | What it does |
|---|---|---|
| [Store](../../../../ClosedSource/DSX/Modules/Core/Store/README.md) | `store` | Unified commerce (StoreKit2 / RevenueCat): `store.paywall/checkout/restore/entitlements/catalog/…` |
| [RevenueCat](../../../../ClosedSource/DSX/Modules/Core/RevenueCat/README.md) | `revenuecat`, `getpurchasehistory` | RevenueCat purchases, paywall, customer center |
| [Stripe](../../../../ClosedSource/DSX/Modules/Core/Payments/Stripe/README.md) | `stripe` | Native Stripe PaymentSheet (`stripe.payment`) + CustomerSheet (`stripe.manage`) |
| [AdMob](../../../../ClosedSource/DSX/Modules/Core/AdMob/README.md) | `admob`, `displayrewardedad` | Rewarded / interstitial ads + UMP consent |
| [MetaAudienceNetwork](../../../../ClosedSource/DSX/Modules/Core/MetaAudienceNetwork/README.md) | `metaads` | Meta Audience Network ads |

## Core — auth & identity

| Package | Scheme(s) | What it does |
|---|---|---|
| [OAuth](../../../../ClosedSource/DSX/Modules/Core/Auth/OAuth/README.md) | `oauth` | OAuth / social sign-in via `ASWebAuthenticationSession` / Auth Tab; own-host [https callback](../oauth-https-callback.md) |
| [Clerk](../../../../ClosedSource/DSX/Modules/Core/Clerk/README.md) | `clerk` | Native Clerk auth *(iOS 17+, off by default)* |
| AppleAuth | *(capability only)* | Sign in with Apple entitlement |
| [IdentityVault](../../../../ClosedSource/DSX/Modules/Core/IdentityVault/README.md) | `identityvault`, `setvault`, `readvault` | Small iCloud-KVS vault with optional biometric gate |

## Core — push & analytics

| Package | Scheme(s) | What it does |
|---|---|---|
| [OneSignal](../../../../ClosedSource/DSX/Modules/Core/OneSignal/README.md) | `onesignal`, `getonesignalplayerid`, `setonesignalplayerid` | OneSignal push end-to-end |
| [Firebase](../../../../ClosedSource/DSX/Modules/Core/Firebase/README.md) | `firebase`, `getfirebaseplayerid` | FCM token surface (`window.firebaseplayerid`) |
| [Pushwoosh](../../../../ClosedSource/DSX/Modules/Core/Pushwoosh/README.md) | `pushwoosh`, `getpushwooshid` | Pushwoosh push |
| [LocalPush](../../../../ClosedSource/DSX/Modules/Core/LocalPush/README.md) | `localpush`, `sendlocalpushmsg` | Schedule local notifications (incl. cron) |
| [AppsFlyer](../../../../ClosedSource/DSX/Modules/Core/AppsFlyer/README.md) | `appsflyer` | Install + event attribution, OneLink |
| [PostHog](../../../../ClosedSource/DSX/Modules/Core/PostHog/README.md) | `posthog` | Native PostHog analytics |

## Core — data, health, media

| Package | Scheme(s) | What it does |
|---|---|---|
| [PowerSync](../../../../ClosedSource/DSX/Modules/Core/PowerSync/README.md) | `powersync` | Local SQLite + PowerSync sync |
| [HealthKit](../../../../ClosedSource/DSX/Modules/Core/HealthKit/README.md) | `healthkit`, `readhealthkit`, `writehealthkit` | HealthKit read/write |
| [Terra](../../../../ClosedSource/DSX/Modules/Core/Health/Terra/README.md) | `terra` | Terra health/wearables bridge |
| [Stream](../../../../ClosedSource/DSX/Modules/Core/Stream/README.md) | `stream` | Stream Video calling *(off by default)* |
| [Widgets](../../../../ClosedSource/DSX/Modules/Core/Widgets/README.md) | `widget` | Home-screen image widget |
| [QuickActions](../../../../ClosedSource/DSX/Modules/Core/QuickActions/README.md) | `quickactions` | Home-screen Quick Actions (set items; `tap` broadcast) |
| [ActionSheet](../../../../ClosedSource/DSX/Modules/Core/ActionSheet/README.md) | `actionsheet` | Native bottom action sheet |

## Core / Extensions (separate targets)

| Package | Scheme(s) | What it does |
|---|---|---|
| [ShareExtension](../../../../ClosedSource/DSX/Modules/Core/Extensions/ShareExtension/README.md) | `sharetarget` | Receive shares from other apps |
| [ActivityKit](../../../../ClosedSource/DSX/Modules/Core/Extensions/ActivityKit/README.md) | `liveactivity` | Live Activities |
| [AppClip](../../../../ClosedSource/DSX/Modules/Core/Extensions/AppClip/README.md) | `appclip` | App Clip |
| [Watch](../../../../ClosedSource/DSX/Modules/Core/Extensions/Watch/README.md) | `watch` | Apple Watch app (native DSX screens, OTA + phone relay) |
| [Keyboard](../../../../ClosedSource/DSX/Modules/Core/Extensions/Keyboard/README.md) | `keyboard` | System-wide custom keyboard (DSX layouts, runtime re-skin) *(off by default)* |

## Custom (per-app)

| Package | Scheme(s) | What it does |
|---|---|---|
| [VerticalPlayerStack](../../../../ClosedSource/DSX/Modules/Custom/VerticalPlayerStack/README.md) | `verticalplayer` | Vertical short-drama player (Stack + AVPlayer) |
| [Demo](../../../../ClosedSource/DSX/Modules/Custom/Demo/README.md) | `demo` | The on-device capability demo/diagnostics app — exclude from production |

---

*Pod-only packages with no scheme (host SDK wiring, not called from web):*
SwiftyGif, SwiftyStoreKit.

> Schemes are the routing identifiers; call them the current way,
> `window.dsx.module.<scheme>.<method>(…)`. (The pre-dot `window.virtual` / scheme-string forms are
> legacy — see [legacy.md](../../legacy.md).) For exact actions and
> payloads, open the package's `README.md` under `ClosedSource/DSX/Modules/`.
