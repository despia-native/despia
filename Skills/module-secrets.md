# Module secrets: build-time SDK credentials, dynamic across every app

> Just want the setup steps? See the short
> [build-secrets-setup.md](../Documentation/guides/build-secrets-setup.md). This doc is
> the full contract + threat model.


Some modules need a credential to even INSTALL or COMPILE their SDK — an
install/download token for a private CocoaPods/SPM source (Mapbox's
`api.mapbox.com` Podspec host is the canonical example), a proprietary engine's
build license, an API key a build script needs before it can run. (The in-repo
embedded engine deliberately needs NONE of this: Godot is MIT — no license, no
serial, no account. This primitive exists for the SDKs that aren't.) These are **build-time-only secrets** — they never touch the
app binary. They belong per-package, exactly like `config.json` — but they can't BE
`config.json`: config values are committed to the repo and read at runtime, and a
secret value can't be committed (that would defeat it). So the split is:

- **`config.json`** (per package, committed) — non-secret runtime knobs. Article 4.
- **`secrets`** (per package, in `dsx.json` next to `pods`/`build`/`weights`) — the
  build-time credential *declaration*: which fields this package needs, delivered how.
  The VALUES arrive from outside at build time (never committed). This is the correct
  home — a secret is build-time provisioning like a pod or a framework, not a runtime
  knob — and it's still fully per-package: each module owns its own `secrets` block,
  and (via `as: "file"`, below) receives its own isolated secrets artifact at build
  time, so no module ever sees another's values.

This is the same shape as `pods` / `spm` / `build` / `weights` — a module *declares
what it needs*, the build *resolves* it — except what's resolved is a credential, not
a library/binary/blob, and it comes from **your own per-client secrets endpoint**, not
a URL baked into the manifest. Nothing here is SDK-specific: adding a new SDK's
credential need is a manifest edit, never a script edit.

## One shared source, per-package isolated delivery

There is ONE per-client payload (one `SIGNING_URL`/token, or one decoded `env.json`) —
not one file per package to configure — because the source is what costs setup effort,
and multiplying it per SDK helps nobody. The per-PACKAGE guarantee lives at **delivery**,
not the source: `deliver_module_secrets.rb` only ever hands a package the fields it
declared under its own namespace, and with `as: "file"` writes each package its OWN
private secrets file that only its build tooling reads. You get the isolation of
"a secrets file per module" without the setup cost of a secrets source per module.

## Why not just a Codemagic dashboard env var?

You can — a build tool can read a plain env var, so a Codemagic-dashboard-configured
env var works fine for a one-off test build (and for a **build-from-source** build,
the same names go in the one git-ignored `settings.local.env`, auto-loaded — see
[building.md](building.md)).
But this repo builds 50k+ different client apps from the SAME workflow; hand-configuring
a secret per app in Codemagic's UI doesn't scale and isn't how this repo already does it
for OTHER build-time secrets. Apple's signing keys (`APP_STORE_CONNECT_PRIVATE_KEY`,
`CERTIFICATE_PRIVATE_KEY`) already flow dynamically: a non-secret `SIGNING_URL` +
short-lived `SIGNING_TOKEN` (injected by whatever triggers the Codemagic build, per
client, via Codemagic's REST API — see `OpenSource/Documentation/guides/codemagic-build.md`
§4b) fetch ONE JSON payload from your own endpoint at build time. `secrets` rides that
exact same channel — it's the general form of what signing material already proved out.

## Declare it

In the owning module's `dsx.json`, next to `pods`/`build`/`weights`:

```json
"scheme": "acme",
"secrets": [
  { "name": "acme.license_key", "as": "file" },
  { "name": "acme.team_id",     "as": "file" }
]
```

- **`name`** — the field your own secrets endpoint returns this value under, inside the
  payload's `secrets` object,
  **namespaced `<this package's own scheme>.<field>`** (a package with scheme `acme`
  may only ever claim `acme.*`). This isn't cosmetic — it's the boundary between
  two *trusted* packages: without it, any Mandatory/Core package could declare
  `{"name": "mapbox.download_token", ...}` and harvest a credential meant for a
  different package, even though both are first-party/reviewed. A `secrets` entry
  whose `name` isn't prefixed with its own manifest's `scheme` is rejected.
- **`as`** — delivery shape (pick the one your consumer actually reads):

  | `as` | What it does | Use when |
  |---|---|---|
  | `"file"` (default, preferred) | all of THIS package's `file` fields → one private `0600` JSON at `$DESPIA_SECRETS_<SCHEME>` (namespace stripped: `acme.license_key` → `{"license_key": …}`) | your OWN build tooling reads it — TRUE per-module isolation, values never in the shared build env |
  | `"env"` | value → an env var named by `env` | a THIRD-PARTY CLI reads a specific env var you can't change |
  | `"netrc"` | value → a `~/.netrc` entry (`machine`/`login` required) | an SDK whose CocoaPods/SPM install authenticates via HTTP Basic Auth (e.g. Mapbox's private Podspec host) |

  With `as: "file"`, the owning package's build tooling reads the JSON at
  `$DESPIA_SECRETS_<SCHEME>`, consumes it, and deletes it — the credential never
  touches the global build env. A `netrc` example for Mapbox:

  ```json
  "scheme": "mapbox",
  "secrets": [
    { "name": "mapbox.download_token", "as": "netrc", "machine": "api.mapbox.com", "login": "mapbox" }
  ]
  ```

Every field is **optional on the endpoint side** — an app that doesn't use a given
SDK just never returns its fields; nothing changes for it.

### The per-package secrets FILE (`as: "file"`) is the real `config.json` analogue

`config.json` gives each module its own committed, non-secret settings artifact.
`as: "file"` gives each module its own **build-time, secret** artifact: a private
`0600` JSON at `$DESPIA_SECRETS_<SCHEME>` containing only that module's own fields.
The module's own build script reads its own file — no other package's build step can
see the values, nothing lands in the shared global build environment, and the consumer
deletes the file after reading (consume it up front even when your build soft-skips, so
it never lingers). That's genuine per-module isolation, from one
shared source — the isolation benefit of "a secrets file per module" without a secrets
*source* per module (which would just multiply setup with no security gain).

## How it ships

1. **`scripts/fetch_signing_material.sh`** (codemagic step *Fetch Signing Material*)
   fetches the ONE per-client JSON payload from `SIGNING_URL` (Bearer `SIGNING_TOKEN`,
   never logged) — this already happens for Apple signing. Once validated, it ALSO
   stages the payload's `secrets` object to a private, `0600` temp file for the next
   step (nothing
   SDK-specific here — it doesn't know or care what fields exist).
2. **`scripts/deliver_module_secrets.rb`** (codemagic step *Deliver Module Secrets*,
   right after) reads that temp file, scans every **enabled, trusted-tier** module's
   `dsx.json` for a `secrets` block, and for each declared `name` present in the
   payload, delivers it the way that module asked: `file` → one private `0600` JSON per
   package at `$DESPIA_SECRETS_<SCHEME>`; `env` → `$CM_ENV`; `netrc` → `~/.netrc`
   (`0600`, never clobbering an existing entry for the same host). The shared payload
   temp file is always removed once read (an `ensure` covers it, even if something in
   that pass raises).
3. The module reads its own file (or a third-party tool reads the env var / `~/.netrc`
   transparently) — with `as: "file"`, consume the per-package file up front
   (read + delete) even when the build soft-skips, so it never lingers.

## Trust boundary — this is the part that actually has to be secure

The payload is one client's real secrets (Apple's App Store Connect private key and
distribution cert included), and this repo ships apps that accept a **client/third-party-
suppliable** package tier (`DSX/Modules/Custom/*`, delivered via a client's own
`ios_assets` zip). Without a boundary, ANY enabled Custom package could declare
`{"name": "api_key", "as": "file"}` and walk off with Apple's signing key —
or one first-party package could just as easily harvest a DIFFERENT first-party
package's credential. `deliver_module_secrets.rb` closes both with three independent
layers:

1. **Tier gate** — only `DSX/Modules/Mandatory/*` and `DSX/Modules/Core/*` manifests are
   ever scanned for `secrets`. `Custom/*` is skipped outright, no matter what it
   declares — this closes CROSS-TIER harvesting (a client/third-party package stealing
   a first-party credential).
2. **Namespacing** — a `secrets` entry's `name` must be prefixed with its OWN manifest's
   `scheme` (`mapbox.*` for Mapbox, `acme.*` for a package with scheme `acme`). This closes CROSS-PACKAGE
   harvesting WITHIN the trusted tier (one first-party package claiming a different
   first-party package's field) — it relies on scheme uniqueness, which the module
   registry already requires for `dsx.module.<scheme>` routing to work at all.
3. **Reserved names** — `key_id`/`issuer_id`/`api_key`/`cert_key`, the Android keystore
   quartet (`keystore`/`keystore_password`/`key_alias`/`key_password`) and the Play
   publishing credential (`play_credentials`) (+ the retired pre-v2 spellings — the fields
   `fetch_signing_material.sh` already owns) can never be re-claimed by a
   `secrets` block, and a fixed set of env vars (`PATH`, `CM_*`, `APP_STORE_CONNECT_*`,
   `CERTIFICATE_*`, `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS`, `BUNDLE_ID`,
   `SIGNING_URL`/`SIGNING_TOKEN`, …) can never be a
   delivery target — even from a trusted, correctly-namespaced manifest. This is
   defense in depth against a typo/collision, independent of tier trust or namespacing.

**Secrets never ride into logs** — the build-time counterpart of the runtime
`JSERedact` rule in [security.md](security.md) ("secrets must never ride along" into
NSLog/crash uploads). The delivery scripts print field/env/machine **names** only,
never a value; a build tool that passes a credential on a CLI's argv must log that
command with its args hidden (`build_frameworks.rb`'s `run(secret: true)` mode exists
for exactly this), because that log is shipped to the build log, the status
webhook, and `app_log.json`/`event_log.json`. A per-write **random** `$CM_ENV` heredoc
delimiter means a value can never terminate its own heredoc early (which would corrupt
the env or inject a bare export).

Additional hardening: `SIGNING_URL` must be `https://` (case-insensitive scheme check;
both the main fetch and a PEM's signed-object-store URL, pinned with
`--proto/--proto-redir '=https'` so a redirect can't downgrade to cleartext) — plaintext
is refused outright, never silently attempted. The temp payload file is created via
`mktemp` (unpredictable path, 0600 from the moment it exists — no create-then-chmod
window), carries **only package secrets** (the Apple signing fields are stripped before
hand-off, so the crown-jewel keys never enter it), and its path is handed to the next
step via `$CM_ENV`, never a fixed name. `machine`/`login` for `netrc` entries are
validated against a strict hostname/username charset before being written, so a
crafted value can't inject a second `~/.netrc` stanza or misattribute a credential to a
different host.

## Fail-open

- No `SIGNING_URL` configured (a build with no per-client secrets endpoint at all) →
  the whole chain no-ops. Codemagic-dashboard env vars, if any, stand unchanged.
- A module's declared `name` absent from the payload, declared by a `Custom/*` package,
  reserved, outside its own namespace, or otherwise invalid → that ONE field is
  skipped with a warning; the module's own build step degrades exactly as if the
  credential were never set (soft-skip → a visible runtime "unavailable" state).
- A malformed `secrets` entry (not an object, missing `env`, missing `machine`/`login`
  for `netrc`, or anything else unexpected) warns and is skipped — never aborts the
  build, and never leaves the payload file behind.

## Reference implementation

The channel is live end-to-end (fetch → stage → deliver → consume) and fully generic;
no in-repo module currently NEEDS a build credential — the embedded engine is Godot
(MIT: no license, no account, nothing to deliver). The first SDK that does (a Mapbox
download token, a proprietary engine) declares its `secrets` block and consumes its
`$DESPIA_SECRETS_<SCHEME>` file — no script edits. `build_frameworks.rb`'s
`run(secret: true)` mode is the ready-made log-redaction for any tool whose CLI takes
the credential as arguments.
