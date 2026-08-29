# Build secrets: simple setup guide

> **Scope.** This guide documents Despia's managed build pipeline, part of
> [Despia Cloud](https://despia.com), the commercial layer. It ships in the open tree for
> transparency: the contract is public even though running the pipeline is not. Building
> and shipping web apps, PWAs, backends, and CLI tools needs none of this; see the
> [quickstart](quickstart.md).

Some packages need a **credential to build**, not to run: a private-SDK install token
(Mapbox), a proprietary engine's build license, an API key a build script needs. These
never go in the app and are never committed. This is how you give a build one,
dynamically, per app. (The in-repo embedded engine needs none of this — Godot is MIT,
no license/account; this channel is for the SDKs that aren't.)

> Deep dive: [`OpenSource/Skills/module-secrets.md`](../../Skills/module-secrets.md).

---

## How it works (30 seconds)

```
  your secret values                        the build
  ──────────────────                        ─────────
  Codemagic secret var   ─┐
  (or) env.json (base64) ─┼─►  ONE JSON payload  ─►  deliver_module_secrets.rb
  (or) your CDN endpoint ─┘    (per build)            │
                                                      │  reads each ENABLED package's
                                                      │  `secrets` block in its dsx.json
                                                      ▼
                              ┌─ as:"file"  → private 0600 JSON the package reads itself
                              ├─ as:"env"   → an env var a third-party CLI reads
                              └─ as:"netrc" → ~/.netrc for pod/SPM Basic-Auth (e.g. Mapbox)
```

- **One** payload per build carries every package's secrets. You never configure a
  secret per package by hand.
- Each package declares — in its **own** `dsx.json`, next to `pods`/`build` — exactly
  which fields it needs, namespaced under its own scheme (`mapbox.*`, `acme.*`).
- Delivery is **per-package isolated**: a package only ever receives its own fields, and
  with `as:"file"` the values never touch the shared build env.

---

## A package declares what it needs (once, by whoever writes the package)

In the package's `dsx.json`:

```json
"scheme": "acme",
"secrets": [
  { "name": "acme.license_key", "as": "file" },
  { "name": "acme.team_id",     "as": "file" }
]
```

Mapbox-style (private CocoaPods source, HTTP Basic Auth):

```json
"scheme": "mapbox",
"secrets": [
  { "name": "mapbox.download_token", "as": "netrc", "machine": "api.mapbox.com", "login": "mapbox" }
]
```

That's the only code change. Everything below is just *supplying the values*.

---

## Supplying the values — pick ONE

### Option A — Codemagic secret variables (simplest, one app)

In Codemagic → your app → **Environment variables**, add each as **Secret**:

| Variable | Value |
|---|---|
| `ACME_API_TOKEN` | `••••••••` |

Marked Secret, Codemagic encrypts them and keeps them out of logs. A build tool reads
these as a fallback. Good for a test build; tedious across many apps.

### Option B — one `env.json`, base64'd into a secret var (a few SDKs, no backend)

```json
// env.json — never committed
{
  "acme.license_key": "XXXX-XXXX-XXXX",
  "mapbox.download_token": "sk.xxxxx"
}
```

```bash
base64 -i env.json     # paste the output as ONE Codemagic Secret var: DESPIA_SECRETS_JSON_B64
```

That's the whole setup — the *Decode env.json secrets* step is **already in
`codemagic.yaml`**. It decodes the var to the payload the delivery step reads. Nothing
to edit; just set the variable.

### Option C — your own endpoint (the scalable path, 50k+ apps)

Your control-plane triggers each build via Codemagic's REST API and passes two vars:

```jsonc
{
  "SIGNING_URL":   "https://secrets.you.com/app/<client-id>",  // non-secret
  "SIGNING_TOKEN": "<short-lived token>"                        // Bearer, one build
}
```

`fetch_signing_material.sh` GETs that URL with the token (header only, never logged) and
your endpoint returns one JSON with whatever this client needs — signing keys **and** any
package secrets:

```jsonc
{
  "signing": {                             // the store material, both platforms —
                                           // file-shaped values are SIGNED CDN URLs
                                           // (short TTL; inline forms also accepted)
    "key_id": "…",                         // Apple signing (already used today)
    "api_key": "https://cdn…/asc.p8?sig=…",    // the ASC .p8 — signed CDN URL
    "keystore": "https://cdn…/acme.jks?sig=…", // Android keystore — signed CDN URL
    "key_alias": "…",                      // + keystore_password / key_password
    "play_credentials": "https://cdn…/play-sa.json?sig=…"  // Google Play service-account JSON
  },
  "secrets": {                             // the app's module secrets — plain JSON, no base64
    "acme.license_key": "…",               // a proprietary SDK (namespaced)
    "mapbox.download_token": "…"           // Mapbox (namespaced)
  }
}
```

(The two-key envelope is the only accepted shape — root-level strays are ignored.)

Nothing is configured per app in Codemagic. Add a field, a client gets that SDK.

---

## Security, in one breath

- Values are **never committed** and **never logged** (scripts print field *names* only).
- `SIGNING_URL` must be `https://`; the Bearer token rides a header, not the URL.
- Only **first-party** (`Mandatory/`, `Core/`) packages may claim secrets — a
  client-supplied `Custom/` package is ignored, so it can never harvest another app's keys.
- A package can only claim fields under **its own scheme** (`acme.*`); it can't grab
  another package's credential or the reserved signing/publishing fields (Apple,
  the Android keystore, Google Play).
- `as:"file"` keeps a package's values out of the shared build env entirely; the file is
  `0600`, unpredictably named, and deleted after it's read.

Full threat model + the adversarial review behind these: `module-secrets.md` §"Trust boundary".

---

## Who uses this today?

No in-repo package currently needs a build credential: the embedded game engine is
**Godot** (MIT — `build_frameworks.rb` downloads the editor itself; no license, no
account, nothing secret anywhere in that flow — see
`DSX/Modules/Core/Godot/PROVISIONING.md`). The channel is live end-to-end and waits for
the first SDK that does need one (a Mapbox token, a proprietary engine): declare the
`secrets` block, supply the values via one option above, done. Missing values can never
fail the app build — the owning package soft-skips to a visible "unavailable" state.
