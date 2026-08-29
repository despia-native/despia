# Staging, testing & the dev center

> **A note on paths.** This guide is written in the Despia monorepo, where the open tree
> you are reading lives under `OpenSource/` and the commercial layer (the production
> module catalog, host shells, and build machinery) lives in a sibling PRIVATE tree that
> is not part of this drop. An `OpenSource/X` path is `X/` in the public repository. A
> command or file named below as `scripts/…`, `DSX/Modules/…` or `Documentation/…`
> without the `OpenSource/` prefix belongs to that private tree: it is named for the
> record, never as something to run from what you have.

How to test a Despia app against staging environments — inside the **same TestFlight binary**
that later ships to the App Store — plus the environment plane every surface can branch on,
and sandbox best practices for payments, push, data and App Review.

**TL;DR:** install the TestFlight build → **shake the phone** → the dev center opens → pick a
staging environment (or type one) → the app reloads from it, and deep links, OTA routes and
content follow. Shake → *Reset to production* when done. None of this exists on an App Store
install.

---

## 1. The environment plane — know where you're running

Every install runs on exactly one **channel**, detected once at launch and **failing closed
to production** (anything ambiguous counts as `appstore`, so dev features default to off):

| Channel | When |
|---|---|
| `simulator` | Xcode simulator |
| `debug` | device, DEBUG build (an Xcode run) |
| `testflight` | device, release build, sandbox receipt — i.e. a TestFlight install |
| `adhoc` | device, release build, embedded provisioning profile (ad-hoc / dev-signed) |
| `appstore` | production — and the default whenever detection can't be sure |

Read it on any surface:

| Surface | Environment | Version |
|---|---|---|
| Native (module) | `dsx.env.channel` · `guard !dsx.env.isProduction` | `dsx.app.build >= 260` |
| DSX markup | `visible-if="env != 'appstore'"` · `{{ dsx.app.env }}` | `visible-if="dsx.app.build >= 260"` |
| Web | `window.dsx.global.app.env` / `.production` | `window.dsx.global.app.build` |

**Android channels.** The debug bit is Android's only certain runtime signal, so a debuggable
build reads `debug` and everything else fails closed to `appstore` — Play exposes no trustworthy
"testing track" API at runtime. A release **beta** build therefore *declares* its channel: stamp
the manifest meta-data `despia.channel` per build variant (a `manifestPlaceholder`) with
`testflight` (the internal-testing analog) or `adhoc` (dev-signed / side-load). Only those two
names are accepted; an unstamped or unrecognized value stays `appstore`, so a store build can
never be talked into a test channel.

```groovy
// build.gradle.kts, the beta variant
manifestPlaceholders["despiaChannel"] = "testflight"
```
```xml
<meta-data android:name="despia.channel" android:value="${despiaChannel}"/>
```

Rules of thumb:

1. **Feature-detect first, env-gate second.** "Is the module there" is `has()` / `dsx.has()`;
   env gating is for *behavioral* differences (verbose logging, QA affordances).
2. **Compare `build`, never `version`.** `build` (`CFBundleVersion`) is numeric (dotted
   values read their leading numeric component); `version` is a display string —
   lexicographic comparison lies (`"2.10" < "2.9"`).
3. **Gate dev affordances on BOTH checks in markup**: `has('dev') && !dsx.app.production`.
   The `dev` scheme *name* is registry-visible on every channel (schemes bind before
   `setup()` runs); it's the actions/hooks/seam that production never gets.
4. **Web callers gate on `global.app.production`** before calling `despia.dev.*` — on
   production those actions are never registered, so a call never dispatches (the promise
   won't settle).

---

## 2. The dev center

Think Expo Go, inside your real TestFlight app. Entry points (test installs only): **shake**
(accelerometer-detected — works even while the web view holds first responder; simulator:
**⌃⌘Z**), the deep link **`<app-scheme>://dev`** (or `://sandbox` — e.g.
`xcrun simctl openurl booted myapp://dev`), tap the orange **STAGING badge** while an
override is active, or `despia.dev.open()` from the web console. If config `access_code` is
set, the panel asks for it once per launch.

The dev center opens as a **drawer in its own window** (the kernel's `DevOverlay`), layered
above the app's ENTIRE hierarchy — the web view, native screens, and any presented layer (a
sheet, the in-app browser tab, a file picker). It never rides the app's route or navigation
stack, so opening it can't mutate the state it inspects, and nothing the app shows can cover
it. The chrome is the REAL system navigation bar — large "Dev center" title (channel ·
version as the iOS 26 subtitle), the system Close item, native back chevron + edge-swipe on
nested pages, page verbs as real bar buttons — and every surface styles in adaptive grouped
tokens, so the whole panel follows the app's appearance (`despia.appearance.*`) instead of
mixing light chrome over dark pages. Nested pages stack inside the drawer, each opened with
a live snapshot:

**The home is built for non-developers first.** It leads with a live **health card** —
green *"Everything looks good"* or amber *"N problem(s) caught"*, reactive on
`global.dsx.errorCount`, tap-through to the Console — followed by **Copy report for AI**:
one tap puts the complete diagnostic bundle (errors, logs, kernel tail, device facts) on
the clipboard, paste-ready. The no-coder debugging loop is exactly that:
**shake → glance at the health card → Copy report → paste it into ChatGPT / Claude / a
support chat.** Nothing about the app needs to be understood to file a perfect bug report.

| Page | What it does |
|---|---|
| **Console** | the LIVE on-device console (`Console.dsx`, identical DSX on iOS and Android), readable by non-developers: a **nested page** of the drawer's nav (back chevron; **Export** on the real bar ships `dsx-diagnostics.txt` through the share sheet) streaming the unified **`dsx.log` ring**, the **error ledger** and the **kernel-log tail** in one newest-first feed, filtered by the REAL system **segmented control** (All · Logs · **Problems** · Kernel). Problems wear plain-English tags — **CRASH** (an uncaught throw in the app's own code), **CALL FAILED** (a `dsx.module` call refused), **ERROR** (the app reported one) — and a clean ledger shows a green all-clear card instead of a void. **Tap any row to copy that line**; **Copy report** puts the full diagnostic bundle on the clipboard; **Clear** drops the retained tails (the monotonic totals keep counting). The Panel row shows a live error-count badge (`global.dsx.errorCount`). A TestFlight / internal-testing build has no Xcode or logcat attached, so this IS the console — `dsx.log('checkout ready', cart)` from markup, native or the page shows up here in under a second, zero setup. (The stacked-sheet presentation is history: one nav, no colliding chrome; the `console` module action still presents a sheet for programmatic compat.) |
| **Environments** | one-tap presets · free-text origin · *Scan QR…* (when the QRScanner module ships) · reset |
| **App & device** | channel, version/build, host, active origin, persistence mode, bundle id, iOS, device, locale, screen — paste these into every bug report (`despia.dev.info()` returns the same snapshot) |
| **State inspector** | the live `dsx.global` tree as a DATA BROWSER: native grouped sections (app · dev · screen · route · …), every variable a row — **tap a row** to drill into its own nested page with the value editable in place, copyable, and writable back (`dsx.global.set`, type-coerced); plus the free-path write tester. Refresh is a native bar button |
| **Advanced** | deep-link tester · route-table refresh · clear web data & reload · restart app |

Parse failures keep their own richer surface: the **issues panel** — one card per component
failure, code-editor style (the parser's reason, the exact **line:column**, a **source
excerpt** with the offending line marked, and a plain-language **hint** like "unescaped
quote in an attribute — write `&quot;`"). The Console shows an orange **parse-issues
banner** whenever the kernel has recorded any; tapping it opens the panel (iOS — the ledger
has no Kotlin twin yet, so the banner simply never appears on Android). Test channels only;
production never captures a byte.

**Failures are loud on test channels — automatically.** A component whose markup fails to
parse registers as nothing; on a test install the kernel (1) **auto-presents the issues
panel** the moment the failure is recorded (once per new-issues batch — closing it doesn't
nag), and (2) renders a red **diagnostic card** in the component's place (never a silent
blank screen), tappable back into the panel. An App Store install renders exactly what it
always did (empty) — the auto-present, the card, the panel and the log capture are all gated
on the environment channel, fail-closed to production.

Because the drawer lives in its own top window, it is reachable from **any** screen state —
mid-sheet, inside the in-app browser, over a fullscreen game — including when the staging
host you pointed at is down (the panel is compiled into the binary; it needs no network).
The window exists only while the drawer or issues panel is up and tears down the moment the
last sheet closes.

---

## 3. Setting up staging environments

**A channel is just an origin.** The app's host resolves at runtime, so switching origin
swaps the web app, deep-link mapping, OTA route table and the content plane together — your
staging deployment at `staging.myapp.com` (web + `/dsx` content root) *is* the staging
channel. Nothing server-side to run.

### Named presets (recommended for teams)

DevSettings `config.json` → `environments`, **host-first exactly like App.json** (bare
domain, no scheme, no www — https by default):

```jsonc
[{ "name": "Staging", "host": "staging.example.com" },
 { "name": "Local",   "host": "192.168.1.20", "scheme": "http", "port": 3000 }]
```

`scheme`/`port` exist for local dev servers; a full-URL `"origin"` key is the escape hatch.
Presets flow through the normal per-app config pipeline like every module knob.

### The other entry paths

- **Free-text** in the panel (`allow_custom_origin`) — bare host reads as https.
- **QR / deep link** — `dev://set?origin=https://pr-123.preview.example.com` (put it in the
  PR description; the panel's *Scan QR…* also accepts a bare-origin QR). Always shows a
  native confirm — a link can never repoint the app silently.
- **Web** — `await despia.dev.set({ origin })` (native confirm) / `despia.dev.reset()`.
- **Launch argument** (CI/simulator only, this run only, never persisted):
  `xcrun simctl launch booted <bundle> -DespiaDevOrigin http://localhost:3000` or the
  `DESPIA_DEV_ORIGIN` env var.

Every path funnels through one validator: https required (http only for loopback/private-LAN
hosts on simulator/debug); userinfo/path/query stripped; the `allowed_hosts` wildcard
allowlist (`"*.example.com"`) enforced on TestFlight/ad-hoc installs.

### What a switch does

Persists the origin (in memory + App Group write-through — without a provisioned App Group
the switch still fully works for the session; the App & device page's *Persistence* row says
which), publishes `global.dev.origin`, re-seeds `global.app.*`, fires the `dev.originChanged`
audit event, refetches the route table, and reloads the web surface at its default launch URL
(dropping any stale deep-link override). Content folders re-point by construction — their
cache keys hash the origin. On a native-routed app, **Restart app** is the guaranteed clean
slate. The orange badge stays visible the whole time an override is active.

---

## 4. Testing workflows

**Local EXPANDED builds (qa-expanded, or re-enabling excluded modules).** The dependency
system is fully dynamic — each module declares its pods/SPM packages in its own `dsx.json`,
`prepare_modules.rb` REGENERATES the Podfile from the enabled set (its header says
"PACKAGE-DERIVED, do not edit by hand"), and `Pods/` is never committed. The corollary:
**changing the enabled set changes the dependency set**, so after switching profiles or
un-excluding modules you must materialize the new set before building locally:

```bash
ruby scripts/select_release_profile.rb --profile qa-expanded    # private tree
ruby scripts/prepare_modules.rb                       # regenerates the Podfile for the new set
pod install                                           # materializes it (RUBYOPT=-rlogger on system Ruby 2.6)
```

Skipping `pod install` after expanding the set fails the build with
`Unable to resolve module dependency: '<PodName>'` (SVGView, PostHog, RevenueCat…) — that is
a stale local Pods checkout, not a repo defect.

**Headless Xcode builds (CI-style, no IDE).** `xcodebuild` skips macro validation with
`-skipMacroValidation`, but Swift-package BUILD-TOOL PLUGINS (e.g. swiftgodot's
CodeGeneratorPlugin) are validated separately and have no CLI skip flag. A headless/agent
build on a machine whose Xcode has never trusted them needs the developer defaults, and they
should be REVERTED after (they disable a safety prompt machine-wide):

```bash
defaults write com.apple.dt.Xcode IDESkipPackagePluginFingerprintValidatation -bool YES
defaults write com.apple.dt.Xcode IDESkipMacroFingerprintValidation -bool YES
# … build …
defaults delete com.apple.dt.Xcode IDESkipPackagePluginFingerprintValidatation
defaults delete com.apple.dt.Xcode IDESkipMacroFingerprintValidation
```

(The misspelling `Validatation` is Xcode's own key name, not a typo here.)

**TestFlight QA (the everyday flow).** Internal testers install one build. Shake → preset →
walk the app → shake → reset. Every bug report includes the App & device snapshot. The badge
answers "which env am I on" at a glance — if a tester reports weird data, look at their badge
first.

**PR previews.** Deploy each PR to its own origin (`pr-123.preview.example.com`), embed a
`dev://set?origin=…` QR in the PR description, testers scan it from the panel — confirm →
switched. Reset when the PR closes.

**Local dev server.** `http://<mac-ip>:3000` works on simulator/debug channels (validation
allows http only for local hosts there). Note **ATS**: on release-signed builds iOS may still
block plain-http loads unless the app's ATS config permits them — if the web view stays
blank, that's the first thing to check. The dev center itself is unaffected (it's native).

**CI / XCUITest.** Pass `-DespiaDevOrigin` per run — adopted at bootstrap, before the route
table or content plane resolve anything, and gone on the next normal launch. It never
persists, so automation can't leave a device pointing at staging.

**Web-driven env logic.** Your staging web app can render its own banner and enable debug
tooling off one value the native side guarantees:

```js
if (!window.dsx.global.app.production) showEnvBanner(window.dsx.global.app.env);
const info = await despia.dev.info();   // { environment, origin, host, version, build, switchedAt, persistence }
```

**Prod-inertness testing (the release blocker).** On a DEBUG build, set
`AppEnvironment.simulatedChannel = .appstore` (a DEBUG-only hook, compiled out of release)
and assert: shake does nothing; `despia.dev.info()` never resolves; a `dev://` URL falls
through unclaimed; a persisted override is ignored; the badge is absent; `env == 'appstore'`
in markup. Re-run the same assertions on the store-promoted build as a post-release canary.

---

## 5. Sandbox best practices

**Channels ≠ StoreKit sandbox, but they travel together.** A TestFlight install runs against
the **sandbox receipt** (that's exactly how the `testflight` channel is detected) and StoreKit
purchases there use sandbox/TestFlight billing automatically. Best practices: use dedicated
Sandbox Apple IDs (App Store Connect → Users → Sandbox Testers) for purchase flows on
debug/ad-hoc builds; never hardcode a production `verifyReceipt` endpoint (the payments
modules already pick sandbox vs prod by receipt); expect sandbox subscriptions to renew on
accelerated clocks when testing renewal logic.

**Push runs on a different axis.** The APNs environment rides the *provisioning*: Xcode debug
builds get APNs sandbox; TestFlight and App Store builds get APNs production. Your staging
backend must therefore send to **production APNs** for TestFlight testers even though the web
origin is staging — pointing the app at staging does not change where pushes come from.

**Keep staging data visibly staged.** Cookie jars are per-domain, so prod cookies never leak
into a staging origin — but a staging *backend* wired to production data will bite someone.
Give staging its own data, render the env banner (`global.app.env`), and let the badge do its
job. When re-testing successive deploys of the *same* staging host, use the panel's *Clear web
data & reload* (or the `clear_web_data_on_switch` config) to drop stale service workers and
caches.

**Auth across origins.** Switching origins changes the cookie domain — staging sessions are
separate by construction. Treat staging OAuth/Clerk instances as their own tenant; don't
share production client secrets with a staging origin.

**Signed OTA bundles.** If `bundle_signing` is on, staging tables must be signed with the
same key. The anti-rollback high-water mark resets automatically on an environment switch
(and the persisted marks are per-origin), so a lower-versioned staging table verifies
cleanly; *Restart app* is the fallback clean slate.

**The offline floor is switch-proof.** Bundled screens (compiled package markup, `content`
capability seeds, the bundled web fallback) resolve against no origin — a dead staging host
degrades exactly like a dead prod host, and the dev center itself is part of that floor, so
you can always switch back. Screens on the floor should keep the string-fallback idiom
(`{{ label || dsx.global.strings.key || 'Literal' }}`) so nothing renders blank offline.

**App Review.** The dev center is runtime-gated the same way Expo/React-Native dev menus are,
and reviewers may run with a sandbox receipt — the surface is deliberately a visible
diagnostics panel (badge on, no hidden app features, no content unlocks; Guideline 2.3.1
targets deception). Zero-risk builds can drop every byte: add `"DevSettings"` to
`DSX/Modules/Config/excluded.json`, or flip config `enabled` to `false` without a code change.

---

## 6. Production safety (condensed)

1. Detection **fails closed** — ambiguous ⇒ `appstore` ⇒ everything off.
2. On production the package registers **no actions, no hooks, no seam** — shake is inert,
   `dev://` URLs fall through unclaimed, persisted overrides are never read (a TestFlight →
   App Store update self-heals to production).
3. The kernel **double-gates** the origin seam: even a filled seam is ignored on `appstore`.
4. Markup fails to prod too: `env` reads `appstore` when anything is absent, and the
   package's context defaults are the production values.
5. Per-app kill switch (`enabled: false`) and build-time removal (`excluded.json`) on top.

## 7. Release checklist

| # | Install | Assert |
|---|---|---|
| 1 | simulator | ⌃⌘Z opens the panel; `-DespiaDevOrigin http://localhost:3000` applies for the run; `env == 'simulator'` |
| 2 | debug device | shake opens; local `http://<lan-ip>` works (ATS permitting); persistence across relaunch; reset restores prod |
| 3 | TestFlight | preset switch + badge + persistence; `allowed_hosts` rejects a non-listed host; web `despia.dev.set` and `dev://` QR both show the native confirm; routes/content follow the origin |
| 4 | prod-inertness (DEBUG + `simulatedChannel = .appstore`) | shake inert; `despia.dev.*` never dispatches; `dev://` unclaimed; override ignored; badge absent; `env == 'appstore'` — **release blocker** |
| 5 | store-promoted build | repeat #4 as a post-release canary |
| 6 | excluded build (`"DevSettings"` in excluded.json) | no DevSettings symbols; `has('dev')` false; context reads return prod defaults |

## 8. Troubleshooting

- **Shake does nothing** — presented sheet/browser up? The action sheet should appear instead;
  if not, check the channel (App & device page via `despia.dev.open()` in a web console) and
  the `enabled` config. On production, inert is correct behavior.
- **Switch didn't survive relaunch** — check the *Persistence* row: "in-memory only" means the
  App Group isn't provisioned on this build; the switch still works per-session.
- **Blank web view after switching to a local server** — ATS is blocking plain http; the
  origin is applied (badge shows it), the load is what's failing.
- **QR shows "Not applied"** — the payload must be a bare origin or `dev://set?origin=…`, and
  the host must pass `allowed_hosts` on TestFlight/ad-hoc.
- **Native routes vanished after a switch (signed apps)** — refresh the route table from
  Advanced, or *Restart app*; verify the staging table is signed with the app's key.

## Reference

- Module docs: the DevSettings module's `README.md` (`DSX/Modules/Core/DevSettings/`, private tree) (web API, config,
  cross-module use, error codes).
- The environment primitive + host seam: `OpenSource/Skills/runtime-api.md` (`dsx.env`,
  `motionShake`), `OpenSource/Documentation/architecture/app-manifest.md` (the resolution
  ladder), `OpenSource/Documentation/reference/StackReference.md` (the `env` reserved word).
