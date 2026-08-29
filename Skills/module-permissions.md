# Permissions: `Config/permissions.json`

`DSX/Modules/Config/permissions.json` states **what the app asks the user for**.
`DSX/Modules/Config/excluded.json` states **what it ships**. They are the same statement seen
from two sides, so the first resolves onto the second: a permission the app does not ask for
excludes the modules that would have asked for it.

```json
{
  "camera_usage": "Take a photo to attach to your report.",
  "tracking_usage": ""
}
```

## Three states, and the difference between the last two is the whole point

| State | Meaning | What happens |
|---|---|---|
| present, non-blank | the app asks for it | the string becomes the purpose shown to the user, overriding the owning module's config default |
| present, **blank** | the app explicitly does **not** ask for it | the plist key is removed **and** the owning modules are excluded |
| absent | not stated | nothing changes — the module's own default stands |

A blank is a **decision**, not an oversight, and nothing may backfill over it. That distinction is
the entire content of d-ios#1027: a customer cleared `tracking_usage`, a later step read the
missing purpose string as an oversight worth covering, and ATT shipped anyway.

Both halves always move together. A purpose string with no feature is an App Review rejection; a
feature with no purpose string is a crash on first use. Removing one without the other is worse
than doing nothing.

## Ownership is derived, never registered

A module that declares the governing plist key in its `dsx.json` `infoPlist` **owns** that
permission. That is the only registration there is — adding a permission-bearing module requires
no edit to any script or table. One permission can have several owners (the camera is owned by
the file picker, the WebPlatform camera facet and AR); clearing it reaches all of them.

## When a MANDATORY module owns it

Mandatory modules ship in every build by construction, so exclusion cannot reach them. Stripping
the purpose string while the code still runs is worse than either half — iOS terminates an app
that touches a guarded API with no string. So the resolver **refuses both halves and says so**:

```
[permissions] camera_usage is cleared, but Mandatory/FileUpload is MANDATORY and cannot be
excluded. Leaving the key in place: a guarded API with no purpose string terminates the app on
first use, which is worse than shipping the permission.
```

If you need that permission genuinely gone, the fix is to make the owner excludable, not to
half-apply the clear.

## The vocabulary

Seventeen keys, matching the dashboard payload byte for byte — a mismatch means a customer's
cleared key silently does nothing:

`location_when_in_use` · `background_location_always_and_when_in_use` · `location_always` ·
`camera_usage` · `microphone` · `speech_recognition` · `photo_library` · `photo_library_add` ·
`contacts` · `calendar_usage` · `face_id_usage` · `nfc_reader` · `health_share` ·
`health_update` · `bluetooth_always` · `tracking_usage` · `push_notifications`

`push_notifications` has no purpose string of its own; it still takes part in the three states.

An unknown key **warns and is ignored** — a typo (`camra_usage`) must be said out loud, because
the author believes they cleared the camera, but a stale dashboard payload carrying a key this
build does not know must not stop a release.

## Gates

- `ruby ClosedSource/scripts/app_permissions_test.rb` — 31 assertions over the resolution,
  including the precedence rule and the mandatory-owner refusal.
- The resolver is `ClosedSource/scripts/app_permissions.rb`; `prepare_modules` folds its
  exclusions into `config_exclude_list` and applies its plist half after the merge.

## Not yet landed

The Android manifest half (`androidManifest.permissions` stripping) and the runtime read surface
(`dsx.permissions.<key>` + the `window.permissions` legacy alias) are not implemented. The
authoring file governs the iOS build today.
