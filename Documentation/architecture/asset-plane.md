# The universal asset plane + the fully-dynamic bootloader

> Status: **design adopted (2026-06-11) · superseded-and-completed by the CONTENT PLANE
> (2026-07-04, `content-plane.md`)** — the directive stands (one plane, every surface
> resolves through the kernel, `asset.url` remains the module-contribution seam), but the
> STORE became a kernel primitive (`dsx.content`, content-addressed generations) rather
> than ContentServer's private tree; step 4 below landed in that stronger form, and
> `FileDownloadManager` is gone (the web bundle is a content folder).

## 1. The fully-dynamic bootloader — attach any listener from module code

The contract, stated once: **the bootloader (AppDelegate) may contain only translation
lines.** Every delegate callback it implements is one declared
`dsx.delegate.send("plane.event", payload, combine:)`; a module attaches to any of them from its
own `setup()` (`dsx.delegate.listen("plane.event")`) with
zero host knowledge. When a module needs a callback the bootloader doesn't relay yet, the
ONLY permitted host edit is adding that one translation line — the event name joins the
contract, the body stays empty of policy.

We deliberately do NOT auto-forward all ~50 `UIApplicationDelegate` selectors via ObjC
`forwardInvocation` dynamism: implementing a delegate method changes iOS behavior even when
empty (e.g. remote-notification delivery mode), so the fired set must be intentional. Named
events, added on demand, each with a documented input shape — that is "fully dynamic" the
kernel way: dynamic for modules, explicit on the wire.

Remaining hardcoded branches in the bootloader, as mapped at adoption — **all landed since
(verified against `AppDelegate.swift`, 2026-07-07)**: HuggingFace background-session fallback
(gone — every download owner claims `background.urlSession`; an unknown identifier gets the
fail-safe completion) · calendar permission helper (gone — requested lazily on-use by the
Calendars module) · biometric soft-start check (gone — AppLock is a DSXBoot gate) · the
pre-splash sync `startFileDownload` (gone — ContentServer's first-install sync is a boot-tier
GATE inside DSXBoot's chain, kernelization doc §4; the boot tier's registration-only `setup()`
rule is what kept it off the splash's critical path) · `switchToMainAppFlow` (root swap —
genuine bootloader duty, stays; the one that was always meant to).

## 2. The universal asset plane (ContentServer below ALL surfaces)

**Ground truth today:** two sync systems. `FileDownloadManager` syncs the WEB bundle
(manifest: `entry` + `deployed_at` + `assets[]`); `DSXRemoteCache` separately fetches and
caches Routing's OTA artifacts (routes.json, screen sources). Two caches, two policies, and
the native side can't use the offline bundle.

**The directive:** one plane. The manifest's bundle is just **files** — web assets, DSX
screens, routes.json, models, anything. ContentServer (Mandatory — already *below* both
surfaces, which is why it owns this) stores and serves them; **every surface resolves assets
through the kernel, no special exemptions**:

```
claim("asset.url", path)        // ONE new kernel event — the whole extension
  → ContentServer answers a local URL (file:// or loopback) when the synced
    bundle has `path` (current per deployed_at); nil → the consumer uses its
    remote URL. Fail-open by construction.
```

- **DSXWebView** already rides this plane (`web.startURL` / `web.mapURL` / the loopback origin).
- **DSXView / Routing**: `DSXRemoteCache` resolves every fetch through `claim("asset.url")`
  FIRST, falls back to its remote fetch on nil. It never asks "is the local server on?" —
  it asks the kernel for the asset; ContentServer answers only when it can. A DSX screen
  shipped in the offline bundle then renders **offline, natively**, from the same sync that
  delivered the web app.
- **Any module** (LocalAI models, media, fonts) asks the same question the same way.
- **One revalidation bell**: the `web.didLoad` SWR check (#684) detects a new `deployed_at`
  for the WHOLE bundle — `contentUpdated` now means web AND native screens.
- **Manifest schema: unchanged.** A DSX screen is a path in `assets[]` like any other file
  — the server decides what to ship; the client never type-switches on asset kinds.

### Migration steps (each fail-open, each its own PR)

1. ContentServer registers `hook("asset.url")` — path-traversal-guarded lookup into the
   synced bundle + the LocalCDN store; answers a servable URL or nil.
2. `DSXRemoteCache` consumes the claim before its remote fetch (the only consumer edit).
3. Manifests begin shipping `routes.json` + `.dsx` sources in `assets[]` — server-side only.
4. ~~(Later) `DSXRemoteCache`'s private cache and `FileDownloadManager`'s bundle unify into
   one `deployed_at`-keyed store~~ ✅ LANDED STRONGER (2026-07-04): both unified into the
   kernel content store — content-addressed blobs + atomic generations
   (`content-plane.md`); consumer APIs unchanged.

The kernel grew by one event name (`asset.url`) plus the content primitive that the 2026-07
consolidation promoted out of module-private storage. Serving and policy remain modules.
