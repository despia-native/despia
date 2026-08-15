# Deploying from Xcode (no Despia CI/CD)

For developers shipping from **Xcode directly**, without the Despia CI/CD
platform (which archives, signs, and uploads to TestFlight for you). Do the build
prep first ([building.md](building.md)), then archive + distribute.

## Prerequisites

- An **Apple Developer Program** account, signed in at Xcode ▸ Settings ▸ Accounts.
- App prepped: `ruby ClosedSource/scripts/prepare_modules.rb && pod install`.
- A **Bundle Identifier** you own. To use TestFlight/App Store, create the app in
  App Store Connect with that same id first.

## 1. Signing & version

Open `Runtime.xcworkspace`, select the **Runtime** target ▸ **Signing &
Capabilities**:
- **Team** - your Apple Developer team.
- **Bundle Identifier** - your reverse-DNS id (must match App Store Connect).
- **Automatically manage signing** - on (Xcode makes the profile). Turn off only
  if you manage profiles yourself.

Set **version** + **build** under the target ▸ General ▸ Identity. App Store
Connect rejects a build number it has already seen - bump it every upload.

> Capabilities (Push, App Groups, HealthKit, ...) are written into
> `Runtime.entitlements` by `prepare_modules` from module `dsx.json`
> entitlements. Enable the matching capabilities on your App ID so the profile
> covers them.

## 2. Archive

- Set the run destination to **Any iOS Device (arm64)** - you can't archive to a
  simulator.
- **Product ▸ Archive.**
- The **Organizer** opens when it finishes (Window ▸ Organizer ▸ Archives).

## 3. Distribute

Select the archive ▸ **Distribute App**, then choose:
- **App Store Connect ▸ Upload** - sends it to TestFlight / App Store; it appears
  under App Store Connect ▸ TestFlight after processing.
- **App Store Connect ▸ Export** - a signed `.ipa` to upload later (Transporter).
- **Ad Hoc** / **Development** - a signed `.ipa` for registered devices.

Accept the automatic-signing prompts and finish.

## TestFlight

After the build finishes processing in App Store Connect ▸ TestFlight, add it to
a test group (internal testers need no review). Testers install via the
TestFlight app.

## Extensions

If you enabled extension modules (OneSignal notification-service, App Clip,
widgets, ...), each extra target needs its own Bundle ID + Team under that target ▸
Signing & Capabilities. With automatic signing + the Team set, Xcode handles the
profiles.

## Troubleshooting

- **Signing / no-profile errors** - set Team on every target; toggle Automatic
  signing off then on; confirm the Bundle ID exists in App Store Connect.
- **"Build number already used"** - bump the build number.
- **Missing capability at upload** - enable it on the App ID
  (developer.apple.com ▸ Identifiers) so it matches `Runtime.entitlements`.
- **"My fix did nothing" — test the binary that actually has the fix.** A fix only
  exists in the build you install. Before concluding a change "doesn't work", confirm:
  (1) the commit is on the **branch your CI builds** (e.g. Codemagic builds `v4`, not your
  PR branch — merge it first), and (2) the **build number changed** on the new TestFlight
  build (an old build installs as a no-op). The byte-identical screenshot (same clock,
  same battery) across "rebuilds" is the tell that you're still on the previous binary.
  This wastes more time than any code bug — rule it out first.
