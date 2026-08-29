# Transport & OTA integrity: HTTP/HTTPS and signed updates (the visual guide)

> **A note on paths.** This guide is written in the Despia monorepo, where the open tree
> you are reading lives under `OpenSource/` and the commercial layer (the production
> module catalog, host shells, and build machinery) lives in a sibling PRIVATE tree that
> is not part of this drop. An `OpenSource/X` path is `X/` in the public repository. A
> command or file named below as `scripts/…`, `DSX/Modules/…` or `Documentation/…`
> without the `OpenSource/` prefix belongs to that private tree: it is named for the
> record, never as something to run from what you have.

> **Who this is for.** Anyone who needs to answer "does my app need HTTPS?", "can I load an HTTP
> site?", or "what is `bundle_signing` and do I need it?" without reading the crypto spec. This is
> the plain-language map. The two authoritative docs it ties together:
> - `Documentation/app-transport-security.md` (private tree) — the ATS decision + App Review text.
> - `OpenSource/Documentation/architecture/remote-bundle-signing.md` — the signing spec (crypto, byte format).

---

## The whole thing in two questions

Every byte the app loads gets asked two independent questions:

```
   ┌─────────────────────────────────────────────────────────────┐
   │  1. HOW did these bytes travel?   → TRANSPORT  (ATS: http/https)
   │  2. WHO wrote these bytes?         → INTEGRITY  (signing: optional)
   └─────────────────────────────────────────────────────────────┘
```

They are **separate locks** and solve **different problems**. You almost always want #1 (HTTPS).
You rarely need #2 (signing). Mixing them up is the #1 source of confusion — so we keep them apart
below.

---

## Part 1 — Transport (HTTP vs HTTPS): what's allowed, where

iOS enforces **App Transport Security (ATS)**: by default, every network connection must be HTTPS.
DSX keeps that production default for web content, media, native APIs, and OTA traffic. The only
framework-level exception is local networking for the on-device, capability-protected offline server:

```
  ┌──────────────────────── the app ────────────────────────┐
  │                                                          │
  │   WKWebView (the publisher's website)  ── HTTPS ONLY 🔒  │
  │   AVPlayer  (that site's audio/video)  ── HTTPS ONLY 🔒  │
  │   Loopback  (127.0.0.1 offline bundle) ── local HTTP ✅  │  NSAllowsLocalNetworking
  │                                                          │
  │   Native URLSession  ───────────────── HTTPS ONLY 🔒    │  (no relaxation → ATS enforced)
  │   • OTA route/bundle manifests                           │
  │   • refresh_url host updates                             │
  │   • any module's network fetch                           │
  └──────────────────────────────────────────────────────────┘
```

**Read it as:** all remote traffic is HTTPS. Plain HTTP exists only on numeric loopback for the
bundled offline path; the server requires a per-process capability and is not a fleet-wide web
transport exception.

The generated `Info.plist` says exactly this:

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>            <true/>   <!-- offline bundle -->
</dict>
```

> You don't edit this file — it's **generated** by `prepare_modules.rb` from the Dom module's
> manifest. The block lives in the Dom module's `dsx.json` (`DSX/Modules/Core/Dom/`, private tree) under `infoPlist`.

---

## Part 2 — HTTP is an explicit per-app exception

There are **two very different HTTP questions**. Pick your row:

| I want to serve over HTTP… | Easy? | What to do |
|---|---|---|
| My **website** (loads in the web view) | ⚠️ Possible, deliberate | scoped per-app ATS exception — see below |
| My **native API / OTA updates** | ⚠️ Possible, deliberate | per-app ATS override — see below |

### 2a. HTTP website → configuration plus a scoped ATS exception

The web view's address = **Dom's `webview_url` base** with your App.json host swapped in. The base
carries the **scheme**, and it defaults to `https://`. Changing it to `http://` is not enough in a
production build: ATS will block the load unless that app also declares a narrow host exception.

```jsonc
// the Dom module's config.json  (or the per-app config override)
"webview_url": {
  "value": "http://myapp.com"    // ← http, not https
}
```

Add an `NSExceptionDomains` entry for that exact publisher host in a reviewed per-app Custom
package. Do not restore `NSAllowsArbitraryLoadsInWebContent` or a blanket exception.

```
  App.json host:  myapp.com   ─┐
                               ├─▶  http://myapp.com   ─▶  WKWebView loads it ✅
  webview_url base: http://…  ─┘
```

> A LAN development server such as `http://192.168.1.20:3000` also needs an explicit development
> ATS exception. `NSAllowsLocalNetworking` is retained for DSX's numeric-loopback offline server;
> it is not permission to ship arbitrary cleartext sites.

### 2b. HTTP for **native** traffic (API calls, OTA) → per-app override

Native HTTPS is enforced on purpose, so this is an explicit opt-out, done **per app** (never
fleet-wide). Because module manifests merge **Custom > Mandatory**, a per-app **Custom** package can
override Dom's ATS block. Prefer a **scoped exception** for just your host (App-Review-friendly)
over re-opening everything:

```jsonc
// A per-app Custom package manifest: DSX/Modules/Custom/<YourApp>/dsx.json
"infoPlist": {
  "NSAppTransportSecurity": {
    "NSExceptionDomains": {
      "api.myapp.com": {
        "NSExceptionAllowsInsecureHTTPLoads": true,
        "NSIncludesSubdomains": true
      }
    }
  }
}
```

```
   ❌ Don't:  NSAllowsArbitraryLoads = true      (blanket — App Review will ask why)
   ✅ Do:     NSExceptionDomains → api.myapp.com  (one host, justifiable)
```

> **Reality check:** if you're reaching for this, first ask whether the server can just do HTTPS —
> a free Let's Encrypt cert is usually less work than an App Review justification. HTTP-native is
> for the genuine edge case (a legacy backend you can't change).

---

## Part 3 — Integrity (signing): who wrote the bytes

This is question #2, and it's **completely optional and OFF by default**. HTTPS already proves you
reached the right *server*. Signing proves the *file itself* was authored by you — which only
matters once the file stops coming straight from your own server.

### When you DON'T need it (almost everyone)

```
   your app  ──HTTPS──▶  your own backend  ──▶  OTA update
                         (you control it)
                                              → you trust it. Done. Signing OFF. ✅
```

### The ONE case you might

```
   your app  ──HTTPS──▶  a CDN / cache / partner host  ──▶  OTA update
                         (you DON'T fully control it)
                                              → someone could swap the file ON the CDN.
                                                HTTPS still delivers the swapped file. ⚠️
                                                Signing catches it. 🔒
```

HTTPS authenticates the **channel**; signing authenticates the **author**. On a third-party host,
the channel is fine but the author guarantee is gone — that's the gap signing fills.

### How to turn it on (per app)

```jsonc
// App.json  —  default (most apps): omit the block entirely → HTTPS-only, no signing
{ }

// App.json  —  opt in: your build signs manifests with a PRIVATE key; the app carries the PUBLIC key
"bundle_signing": {
  "enabled": true,
  "algorithm": "Ed25519",
  "public_key": "BASE64_PUBLIC_KEY"    // private key NEVER ships — it stays in your deploy pipeline
}
```

Flipping this one block on buys **three** protections at once (no separate switches):

```
   signature check   →  unsigned or tampered manifest  → REFUSED, app degrades to fallback
   anti-rollback     →  an OLDER signed manifest replayed → REFUSED (version is inside signed bytes)
   per-asset SHA-256 →  an asset doesn't match its hash  → bytes discarded
```

And it **fails safe**: when a manifest can't be verified, the app doesn't brick — it falls back to
the configured fallback surface (default the web view). Full mechanics + the reference signer
(`scripts/sign_manifest.rb`) are in `remote-bundle-signing.md`.

---

## The one-look decision map

```
  ┌─ TRANSPORT ─────────────────────────────────────────────────┐
  │  Serving your WEBSITE over http?                             │
  │     → set webview_url and add one scoped host exception      │
  │  Need NATIVE/OTA over http?                                  │
  │     → per-app NSExceptionDomains    (deliberate, per app)    │
  │     → or just use https (recommended)                        │
  └─────────────────────────────────────────────────────────────┘

  ┌─ INTEGRITY ─────────────────────────────────────────────────┐
  │  Do OTA updates come from YOUR OWN server?                   │
  │     → HTTPS is enough. Leave bundle_signing OFF.  (default)  │
  │  Served from a CDN / partner you don't fully control?        │
  │     → turn bundle_signing ON for that app.        (opt-in)   │
  └─────────────────────────────────────────────────────────────┘
```

**Bottom line:** HTTPS is the DSX production default for every remote path, including the web view.
Any remote HTTP use is a conscious, host-scoped per-app exception. Signing is a separate, optional
lock you add when a third party hosts your update files.

---

## See also

- `Documentation/app-transport-security.md` (private tree) — the ATS sign-off record + the exact App Review justification paragraph.
- `OpenSource/Documentation/architecture/remote-bundle-signing.md` — signing: threat model, crypto, byte format, deploy how-to.
- `OpenSource/Documentation/guides/staging-and-testing.md` — the dev-origin override (local `http://host:port` servers, non-production).
- `OpenSource/Skills/security.md` — the load-gate model (why remote DSX is source-anchored).
