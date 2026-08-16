# Remote-bundle signing — signed manifests at the load gate

> Status: **implemented end-to-end (engine + module + build), mandatory for production OTA — incl. C1
> anti-rollback + C2 per-asset SHA-256.** ROADMAP #9 ("Remote bundle integrity — signed manifests for
> remote DSX once sources go third-party"). The model lives in
> [`OpenSource/Skills/security.md`](../../Skills/security.md) → *The load gate*; this note is the
> implemented contract: threat model, signing flow, key management, release/debug policy, failure mode — plus the
> exact byte/format contract, the header/sidecar names, the deploy how-to, and the routes.json object
> shape (`version` + `assets[].sha256`).
> Engine: `OpenSource/Engine/iOS/RemoteBundleGate.swift` (the verifier) + `Router.swift` (the one
> enforcement site) + `AppManifest.swift` (`bundle_signing`, the baked trust anchor); the Kotlin twin
> is `OpenSource/Engine/Android/core/src/main/kotlin/despia/engine/RemoteBundleGate.kt` — same names,
> same verdicts, one documented divergence (Ed25519 below the Android platform floor: *Platform floor
> — Ed25519 on Android*).
> Module: `ClosedSource/DSX/Modules/Mandatory/Routing/Routing.swift` (fetches the detached signature,
> calls `verifyManifest`, publishes `global.routes_signed`).
> Build/signer: `ClosedSource/scripts/sign_manifest.rb` (the reference signer) + the "Sign route
> manifest" step in `codemagic.yaml` (guarded by the `BUNDLE_SIGNING_PRIVATE_KEY` secret and required
> whenever an app ships production `entry.ota`).

## What this protects, and why HTTPS isn't enough

Remote DSX is **source-anchored**: a remote route/bundle manifest is trusted because the app itself
configured where it loads from — routes/manifests are app-authored, baked at build or served by the
app's own backend (see security.md). A manifest drives what the engine loads and renders, with the
**full engine** (same capability as bundled DSX). So the manifest's *integrity and authorship* are
load-bearing.

HTTPS authenticates the **channel** — that you reached *that host* over *that certificate*. It does
**not** authenticate the **author** of the bytes. The moment a remote source stops being "your own
backend over HTTPS" and becomes **third-party** — a CDN you don't fully control, an edge/proxy cache,
a partner-hosted origin, a static bucket — channel auth is no longer the whole story. The remote
cache already content-addresses (a stable URL hash keys the on-disk copy), which gives integrity
*relative to a URL*; **signed manifests are the missing half**: they bind the manifest **content** to
the app author's signing key, independent of which host or cache served it.

### Threat model

| Adversary | Capability | Without signing | With signing (enabled) |
|---|---|---|---|
| **Compromised / malicious CDN or edge cache** | Serves arbitrary bytes for the manifest URL over a valid TLS cert | Engine trusts and renders attacker DSX with full capability | Signature fails → table refused → fallback surface |
| **MITM with a mis-issued / pinned-bypass cert** | Substitutes manifest content in flight | Trusted as above | Rejected (author key, not the cert, is the anchor) |
| **Poisoned origin / supply-chain on a third-party host** | Replaces the deploy manifest at rest | Trusted | Rejected |
| **Stale/rollback of a previously-cached manifest** | Replays an older signed manifest | n/a | **Refused** (C1 anti-rollback): a monotonic `version` *inside* the signed bytes is recorded on each accept; a regressing version still verifies cryptographically but is rejected → fallback (`reason: "rollback_detected"`). |

What signing gives you: **only manifests signed by the holder of the app's private key are trusted.**
A network/CDN attacker who cannot sign cannot get the engine to render their content — the app fails
closed to its offline/web fallback instead.

### Non-goals (be honest about the boundary)

- **Not confidentiality.** Manifests are public content; this is authenticity/integrity, not secrecy.
- **Anti-rollback is now IN (C1), mandatory with production OTA.** A signed-but-old manifest still *verifies*
  cryptographically (the signature is genuine), but it is **refused** when its monotonic `version` (carried
  *inside* the signed bytes — see "The version object shape") regresses below the highest version accepted
  so far. The high-water mark is recorded on every accept and **persisted across launches** (so a relaunch
  can't be tricked into re-accepting an old manifest), and it is **never lowered** by a failed/rolled-back
  refresh. Freshness beyond monotonicity (wall-clock staleness) is still the manifest's own `deployed_at` +
  HTTPS revalidation; rollback to a strictly older *version* is the part C1 closes.
- **Signature covers the BYTES you sign — and (C2) per-asset hashes now extend it to the assets.** The
  gate authenticates the exact bytes submitted to it, and the engine re-parses the route table from
  those verified bytes (`global.routes_signed`), so the **table content** is authenticated end-to-end
  when the build signs the `routes.json` bytes. The DSX **screens/assets a route then points at**
  (`src` templates, models, media) are covered **transitively** by listing each asset's SHA-256 *inside*
  the signed `routes.json` (`assets[].sha256`); the asset consumer (DSXView / DSXRemoteCache) hashes the
  fetched bytes and refuses a mismatch (see "Extending to assets — now built (C2)"). A fetched asset
  with **no declared hash is refused** while verification is active. Signing only the deploy
  manifest's bare *asset path LIST* (the OTA deploy manifest's `{ assets: [...] }` schema) authenticates
  *which* paths the author declared, not any content — so it is **not** what `routes_signed` should carry.
- **Not the web view.** `DSXWebView` loads an app-configured host over HTTPS; that's the web's own
  origin trust. This gate is for the **DSX route table / bundle** (the OTA-fetched DSX content).

## The signed routes.json shape — `version` (C1) + `assets[].sha256` (C2)

The signed `routes.json` must be an **object** carrying a non-negative integer `version`, a `routes`
array, and valid SHA-256 metadata for every declared asset. The legacy bare array remains readable
only on the signing-OFF debug path; it is never accepted as signed OTA:

```jsonc
// Object form (C1 version + C2 per-asset hashes):
{
  "version": 7,                       // C1 — monotonic integer; a regression below the recorded high-water mark is REFUSED
  "routes": [
    { "path": "/player", "view": "DSXView", "src": "/despia/dsx/player/",
      "assets": [                      // C2 — every remotely fetched DSX asset must be declared
        { "path": "/despia/dsx/player/manifest.json", "sha256": "9f86d0…" },
        { "path": "/despia/dsx/player/index.dsx",     "sha256": "2c2640…" }
      ] },
    { "path": "/*", "view": "DSXWebView" }
  ]
}

```

- **Legacy compatibility is debug-only.** The signing-OFF parser still accepts object-or-array for local
  development, but the signed load gate rejects a bare array, a missing/fractional/negative version,
  malformed asset metadata, and conflicting duplicate asset hashes.
- **`version`** is an integer (a JSON number; decoded as Int). It is read **only from bytes that already
  verified**, so it is authenticated by the table signature — there is no separate version to spoof. The
  high-water mark is recorded in `RemoteBundleGate` (`recordVersion` / `lastVerifiedVersion`, monotonic)
  and **persisted by `Routing`** under a namespace derived from the canonical deploy origin and complete
  baked trust-anchor set (not the attacker-selected routes path), then re-seeded before route selection.
- **`assets[].path`** is the **host-relative** path the consumer fetches (e.g. `/despia/dsx/player/index.dsx`);
  **`assets[].sha256`** is the lowercase-hex SHA-256 of that asset's exact bytes. Paths are matched after
  normalizing a leading `./` / `/` away, on both sides. The hash list lives *inside* the signed routes.json,
  so the table signature authenticates it — **no second signing key**. A route that fetches no remote DSX
  assets may omit `assets`; if an asset consumer later fetches a path that is not declared, it rejects the
  bytes as `.missing` while signed verification is active.

> **The signer is unchanged.** Because `version` and the hashes live *inside* the routes.json that is
> signed **verbatim**, `ClosedSource/scripts/sign_manifest.rb` and the `codemagic.yaml` "Sign route
> manifest" step need **no change** — author the routes.json **with** `version` + hashes *before*
> signing, and the existing "sign the final artifact byte-for-byte" rule still holds (the signature
> covers exactly the bytes the device verifies). The *deploy* tooling that authors routes.json must add
> the `version`/`assets[].sha256` fields and bump `version` per release; that is a build-pipeline concern,
> not a signer change.

## The signing flow

```
                BUILD / BACKEND (holds the PRIVATE key)          DEVICE (holds the PUBLIC key, baked in App.json)
                ────────────────────────────────────────         ──────────────────────────────────────────────
  routes.json ──sign(privateKey, bytes)──► signature              fetch routes.json bytes + its detached signature
       │                                      │                            │
       └──────────── publish both ────────────┘                           ▼
                 (bytes + detached sig:                       RemoteBundleGate.verifyManifest(bytes, signature)
                  sidecar file, header, or                          │            │
                  `signature` envelope field)                    verified      rejected / missing
                                                                     │            │
                                                 record SHA-256 + publish        clear verdict + log
                                                 global.routes_signed = bytes          │
                                                                     │                 │
                                                 Router.trustedRoutes(): parse table FROM routes_signed,
                                                 use it ONLY if isVerified(routes_signed) ──►
                                                                     │                         │
                                                              YES → trusted table     NO → empty table → fallback
                                                                                            + route_unavailable broadcast
```

1. **Sign at the source.** The app's build pipeline (or the app's backend, at deploy time) signs the
   **exact bytes of the artifact whose content the engine will render**. For the route table that is
   the **`routes.json` bytes** (the strict `{ "version": ..., "routes": [...] }` object — see
   [app-manifest.md](app-manifest.md) *The OTA two-file flow*). Output: a **detached** signature over
   those bytes. (Signing only the `{ assets: [...] }` deploy manifest authenticates the asset *path
   list*, not the table contents — insufficient for table integrity; sign the table itself.)
2. **Publish artifact + signature.** The signature travels beside the bytes — a sidecar file
   (`routes.json.sig`), an HTTP response header (`X-DSX-Signature`), or a `signature` field in an
   envelope. The transport is the table-source module's choice; the engine only needs the exact bytes
   and the detached signature.
3. **Verify at the load gate (device).** The table-source submits `(routesJsonBytes, signature)` to
   `RemoteBundleGate.verifyManifest(...)` *before* trusting them, then publishes those same bytes at
   `global.routes_signed`. The gate verifies against the baked public key(s) and **records the SHA-256
   of the verified bytes**.
4. **Engine consumes the verdict — and re-derives the table.** `Router.trustedRoutes()` — the kernel's
   sole reader of the remote table — when signing is ON parses the table **directly from
   `global.routes_signed`** and uses it **only if** those bytes are the ones the gate verified. The
   trusted table is therefore provably the verified content; `global.routes` (which a fetch writes
   *before* verification) is never the trusted source while signing is on, so there is no
   table-vs-signature desync to exploit. Unverified / missing / unparsable ⇒ the table is dropped
   (empty), every path resolves to the configured fallback, and `route_unavailable` is broadcast.

The kernel **consumes** the verification; it never special-cases a node kind (constitution Art.1/3 +
[ROADMAP](../../../ClosedSource/Documentation/ROADMAP.md) locked-decision #3). One trust check for the
whole table, at the one place remote content becomes engine-trusted.

## The cryptography

Built on **CryptoKit** on Apple platforms — already the engine's crypto surface (`JSECrypto` in
`JSELibrary.swift` uses the same types — see [web-crypto.md](../../Skills/web-crypto.md)) — and on
`java.security` in the Kotlin twin. Two standard schemes, byte-identical on the wire on every runtime
(the one place the two verifiers differ is *where they get Ed25519 from*, below):

| Algorithm | Public key form (base64) | Signature | CryptoKit type |
|---|---|---|---|
| **Ed25519** *(default)* | raw 32-byte key | 64-byte Ed25519 | `Curve25519.Signing.PublicKey` |
| **ECDSA P-256** | X9.63 point (`0x04‖X‖Y`, 65 B) **or** DER/SPKI | raw `r‖s` (IEEE-P1363) over SHA-256 | `P256.Signing.PublicKey` |

Both are widely available signer-side: Ed25519 (`openssl`, `libsodium`, WebCrypto), ECDSA-P256
(WebCrypto `crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, …)`, `openssl dgst -sha256 -sign`). The
ECDSA signature layout is **raw `r‖s`** — exactly what `crypto.subtle` emits — *not* the DER-wrapped
form `openssl` emits by default (convert, or use a P1363 flag). Ed25519 is the recommended default:
no hash-parameter ambiguity, deterministic, smaller key.

Verification is **total** (matches the engine's crypto contract): a malformed key, wrong-length
signature, or bad algorithm yields `false` / a typed rejection — never a crash, never a throw across
the engine boundary.

### Platform floor — Ed25519 on Android (the one verifier divergence)

The same two schemes are the contract on **every** runtime, but the two verifiers do not get Ed25519
from the same place, and that is worth stating plainly:

| Runtime | Ed25519 comes from | ECDSA-P256 comes from |
|---|---|---|
| **iOS / watchOS** (`Engine/iOS/RemoteBundleGate.swift`) | CryptoKit `Curve25519.Signing` — present since iOS 13, at or below every supported deployment target | CryptoKit `P256.Signing` |
| **Android / JVM** (`Engine/Android/core/.../RemoteBundleGate.kt`) | the platform JCA provider **when it exists**; below API 33, the **optional, excludable legacy facet** `Core/LegacyCrypto` — see below | `SHA256withECDSA` + the `EC` KeyFactory, present on **every** supported API level |

**The problem this closes.** Android's Conscrypt gained the `Ed25519` JCA algorithm only at **API 33
(Android 13)**, while every Android module in this repo targets **`minSdk = 24` (Android 7)**. On API
24–32 `KeyFactory.getInstance("Ed25519")` and `Signature.getInstance("Ed25519")` both throw
`NoSuchAlgorithmException`. Since Ed25519 is the **documented default** algorithm, a verifier that
only asked the platform would have swallowed that throw into its totality `catch` and returned
`false` — meaning **every correctly signed remote bundle would have been refused on Android 7
through 12**: those devices frozen on the bundled floor, OTA silently never applying, and no test
able to see it (the Kotlin suite is pure-JVM, where the provider always exists).

**The resolution — an EMPTY KERNEL SEAM plus a LEGACY FACET.** This is backward compatibility for
old Android, so it is maintained as legacy support and kept out of the kernel; the modern path stays
wholly dynamic.

- The **kernel** (`RemoteBundleGate`) probes the provider once (`ed25519PlatformAvailable`). Present
  ⇒ the platform verify runs verbatim (API 33+, the JVM, and CI are byte-for-byte unchanged).
  Absent ⇒ it consults one nullable hook and nothing else:

  ```kotlin
  fun interface Ed25519Verifier {
      fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean
  }
  var ed25519LegacyVerifier: Ed25519Verifier? = null   // EMPTY SEAM by default
  ```

  The kernel contains **no RFC 8032 math and no curve constants**. It knows only "the platform
  cannot do Ed25519 here; ask the seam". Same shape as `AppManifest.dynamicHostSource` /
  `devOriginSource` and the web kernel's `RunnerScreenSeam`.
- **An unfilled seam REJECTS.** `null` means an Ed25519 anchor cannot verify on that runtime, so
  `verifyManifest` answers `.rejectedBadSignature` — byte-for-byte the pre-fix verdict. Fail-closed:
  an empty seam can only refuse, never widen what the gate accepts.
- The **facet** `ClosedSource/DSX/Modules/Core/LegacyCrypto` fills it at boot, through the ordinary
  module mechanism (the generated registry constructs the module and calls `setup()` — never a
  registry singleton). Its `LegacyEd25519` object is the self-contained **RFC 8032 §5.1.7**
  verification over `java.math.BigInteger`: no new dependency, no native code, no reflection, using
  only the SHA-512 every Android release has shipped since API 1.
- The first time the floor is reached the kernel names it in the log, and it **distinguishes the two
  cases**: `… verifying through the installed legacy Ed25519 facet (Core/LegacyCrypto)` versus
  `… AND no legacy Ed25519 facet is installed — every Ed25519 anchor is REFUSED on this device
  (fail-closed)`. So "which code verified my bundle?" — or "why did nothing verify it?" — is
  answerable from logcat rather than inferred.

**Excluding it — apps with `minSdk >= 33` should ship zero hand-written crypto.** The facet ships
included by default; excluding it is the whole point of the quarantine.

1. add `"Core/LegacyCrypto"` to the `exclude` list of your release-profile descriptor under
   `ClosedSource/release/profiles/` (the `production-minimal` descriptor is an **allowlist** —
   there, simply leave it out of `include`);
2. `ruby ClosedSource/scripts/select_release_profile.rb` — regenerates
   `DSX/Modules/Config/excluded.json`;
3. `ruby ClosedSource/scripts/prepare_modules_android.rb`.

`prepare_modules_android` then drops the module's `kotlin/` lane from the app source set —
**file-presence is the gate, never `#if`** — and the build contains no RFC 8032 code at all. Do this
when `minSdk >= 33`, or when your rotation set carries an ECDSA-P256 anchor.

Scope and posture, honestly:

- **Verification only.** There is no signing, no key generation, and no private-key handling in the
  facet — the private key never reaches a device (see *Key management*).
- **Every input is public** (baked anchor, fetched manifest, detached signature), so the standard
  objection to a hand-written verifier — key-dependent timing — does not apply; the code is written
  for auditability, not constant time.
- **It is no more permissive than a platform provider.** Non-canonical `y` (≥ p) in the key or in
  `R`, an x with no square root, `x = 0` with the sign bit set, and `S ≥ L` (the §5.1.7 malleability
  check) are all refused, and the group equation is checked in the strict, non-cofactored form
  `[S]B = R + [k]A` — which accepts a **subset** of the cofactored variant.
- **Both configurations are pinned by tests that can fail.** A test seam
  (`_overrideEd25519PlatformAvailable`) forces the provider absent — the only way the API-24-32 path
  is reachable on a JVM.
  - *Facet present* — `Core/LegacyCrypto/shared/tests/LegacyEd25519Test.kt`, run in the `:app` JVM
    unit-test lane (`ClosedSource/RuntimeAndroid` → `./gradlew :app:test`; CI `android-app`),
    wired **exclusion-blind** so it runs under every release profile: the RFC 8032 §7.1 vectors, a
    24-round randomized differential cross-check against the JDK provider (genuine accept; foreign
    key / appended bytes / corrupt R / corrupt S reject), the `S + L` malleability forgery,
    malformed-material totality, that `LegacyCrypto.setup()` is what fills the seam, and that every
    fail-closed verdict is unchanged with the provider gone.
  - *Facet excluded* — `RemoteBundleGateTest` (`gradle :core:test`, runs locally) asserts that the
    kernel seam is **empty by default**, that an empty seam refuses a **correctly signed** manifest
    with the provider absent (and that the same bytes verify the instant the provider returns), that
    a filled seam is consulted only when the platform cannot, that a facet returning `false` *or
    throwing* still fails closed, and that malformed material never reaches the seam at all.
- **Cost:** two 255-bit BigInteger scalar multiplications per manifest — single-digit milliseconds on
  a modern device, well under 100 ms on API-24-era hardware, paid once per refresh, off-main.

**The modern alternative:** ship an **ECDSA-P256** anchor. That algorithm is platform-provided on
every supported API level, needs no facet at all, and a rotation set may carry both
(`keys: [...]`) — one build that serves Android 7 through 16 with zero hand-written crypto.

## Key management

- **Private key**: lives at the build/backend, *never* in the app binary or in JSE. It is the only
  secret; protect it like a code-signing key.
- **Public key**: baked into **`App.json`** (`bundle_signing`). App.json is the app-authored trust
  anchor — Article 5: *the one input the framework takes on faith*. A verification key is build-time
  **identity** (who signs this app's content), not behavior, so it belongs here beside `host`, not in
  a module config.
- **Rotation**: ship a new app build with the new public key. To overlap a rotation (sign with the
  new key while old installs still trust the old one), list **multiple** keys — a manifest verifies if
  **any** baked key validates it. An optional `kid` (key id) on a signature only *reorders* which key
  is tried first; it is an untrusted hint and never restricts the set of valid signers.
- **Threat if the public key is wrong/garbage**: the gate fails **closed, loudly** (see failure mode)
  — it never silently degrades to "unsigned is fine".

### App.json `bundle_signing`

```jsonc
// Single key (Ed25519 default):
"bundle_signing": { "algorithm": "Ed25519", "public_key": "BASE64_RAW_32_BYTES" }

// Rotation set (verify against any; ECDSA-P256 alongside Ed25519):
"bundle_signing": {
  "enabled": true,                       // present block defaults to ON; set false to stage a key with enforcement OFF
  "keys": [
    { "algorithm": "Ed25519",    "public_key": "BASE64", "kid": "2026-06" },
    { "algorithm": "ECDSA-P256", "public_key": "BASE64", "kid": "2026-01" }
  ]
}
```

- `algorithm` — `Ed25519` (default) or `ECDSA-P256`. Spelling is tolerant (`ed25519`, `p256`,
  `ecdsa-p256`, `ES256`, …).
- `public_key` — base64 (standard or URL-safe, padded or not).
- `enabled` — defaults **true** when a block is present. `false` may stage a key only in debug or in a
  bundled-only release; the release gate rejects disabled signing when `entry.ota` is non-empty.
- `kid` — optional opaque key id; logging + first-try ordering only.

## Release policy & debug compatibility

`bundle_signing` remains a **config-presence** switch, not a feature compile flag (constitution Art.3 /
monorepo working rules rule 3), but production OTA is never fail-open. In a release build, a non-empty `entry.ota`
forces `RemoteBundleGate.requiresVerification`; an absent, disabled, or unusable signing block is then a
loud fail-closed misconfiguration. The static release validator rejects that configuration before packaging.
No signing block remains valid for bundled-only releases, and explicit DEBUG builds retain the legacy
unsigned parser for local development.

### Shipped posture

- **Bundled-only release:** `entry.ota` is empty; no signing key is required.
- **Phone production OTA:** `entry.ota` is relative or HTTPS and `bundle_signing` contains at least one
  usable key. Every published route table uses the strict signed object shape described above.
- **DEBUG/local development:** unsigned object-or-array route tables retain the legacy behavior.
- **watchOS/Wear release:** OTA is bundled-only until those runtimes share the phone verifier; the release
  validator rejects a non-empty wrist `ota_manifest`.

## Failure mode (fail-closed when ON, never brick)

When signing is **enabled** and a remote manifest is **not** verified, the engine **refuses the
remote table** — it does **not** render unverified remote content — and **degrades to the configured
fallback** (App.json `entry.fallback`; default the web view). Article 7 holds: a feature degrades,
the app never bricks, never blanks. The refusal cases (`RemoteBundleGate.Verdict`):

| Situation | Verdict | Engine behavior |
|---|---|---|
| Signature valid against a baked key | `.verified` | table trusted (like bundled) |
| Signing OFF in DEBUG or a bundled-only release | `.disabled` | legacy/local behavior; no production OTA accepted |
| Signing ON, no signature supplied | `.rejectedNoSignature` | table refused → fallback + `route_unavailable` |
| Signing ON, signature present but invalid | `.rejectedBadSignature` | table refused → fallback + `route_unavailable` |
| Signing ON but **no usable public key parsed** | `.rejectedMisconfigured` | table refused → fallback (loud log) — never silently "off" |
| Signing ON, signature VALID but **version regressed** | `.rejectedRollback` (C1) | table refused → fallback + `route_unavailable` (`reason: "rollback_detected"`). The signature is genuine; the manifest is an older one being replayed. *The verdict is the policy outcome the courier derives after `verifyManifest` returns `.verified` — it reads the version inside the verified bytes, calls `RemoteBundleGate.rejectForRollback()` to revoke the recorded digest, and publishes nothing.* |

`route_unavailable` reaches the web/native layer as
`despia.on("route", e => e.event === "route_unavailable")` with `{ path, reason }`. The Router OWNS this
broadcast (the `route` scheme + envelope); the table-source and asset consumers trigger the SAME broadcast
through `Router.reportRouteUnavailable(path:reason:)` rather than minting a side-channel. Reasons:

- `missing_capability` — a matched route `requires` a module this binary excludes.
- `unverified_manifest` — signing ON, no signed bytes recorded (the table-source never published `routes_signed`).
- `signature_invalid` — signing ON, bytes recorded but the gate's verdict does not cover them.
- `rollback_detected` (C1) — signing ON, the signature is genuine but the manifest `version` regressed; the
  table-source refused it (`path` is empty — a table-level rejection, not a single route).
- `asset_integrity` (C2) — signing ON, a fetched asset had no declared hash or its SHA-256 did not match
  the signed manifest; the consumer discarded the bytes and degraded that surface (`path` is the asset's
  host-relative path).

> **Offline note.** Verification is over the signed **bytes**, so a *cached* `routes.json` that was
> verified in this process stays trusted; a relaunch re-verifies on the next submit. The cached
> signed bytes verify offline (no network needed — the public key is local), so signing does not
> break offline-first routing.

## What the engine guarantees vs. what the table-source must do

**The engine (this change) guarantees, with no module cooperation:** when signing is ON, the Router
parses the trusted table **only from `global.routes_signed`** and only when `RemoteBundleGate` holds a
verified verdict for those exact bytes. It never trusts `global.routes` (the pre-verification fetch
write) while signing is on, so a buggy/old/malicious write to `global.routes` cannot get rendered —
the app gets the fallback. Fail-closed by construction.

**The table-source module (Routing / the OTA layer) does, to make signed routing WORK** (now
implemented in `Routing.swift`): on each fetch, (1) obtain the detached signature beside the
`routes.json` — an `X-DSX-Signature` response header, else a `<routesURL>.sig` sidecar, (2) call
`RemoteBundleGate.verifyManifest(routesJsonBytes, signature:)` with the **exact bytes the signature
covers** (the routes.json the table is parsed from), (3) on `.verified` publish those same bytes (as
text) at `global.routes_signed`; on any rejection publish nothing (and drop any prior signed bytes), so
the engine degrades to the fallback. The engine re-parses the table from those verified bytes, so they
MUST be the signed `routes.json` object itself (`{ "version": ..., "routes": [...] }`) — not a deploy
manifest, and not a hash. The module only runs this path when `RemoteBundleGate.requiresVerification` is
true; the legacy signing-OFF behavior (publish `global.routes`, no signature fetch) is confined to DEBUG
or bundled-only builds.

## The byte/format contract (exact — what the signer emits and the gate verifies)

The signature is over the **exact `routes.json` bytes** the device fetches and the table is parsed from
— no JSON re-serialization, no normalization, no added/removed newline anywhere between signing and
verifying. Sign the **final artifact** (the bytes the CDN serves). Two schemes:

| | Ed25519 *(default)* | ECDSA-P256 |
|---|---|---|
| **What is signed** | the raw manifest bytes (no pre-hash) | `SHA-256(manifest bytes)` |
| **Signature bytes** | **raw 64-byte** Ed25519 | **raw `r‖s` (IEEE-P1363), 64 bytes** — *not* DER (convert DER→P1363) |
| **Public key (App.json)** | **raw 32-byte** key, base64 | **X9.63 point** `0x04‖X‖Y` (65 B), base64 (or SPKI/DER) |
| **CryptoKit verify** | `Curve25519.Signing.PublicKey(rawRepresentation:)` `.isValidSignature(sig, for: bytes)` | `P256.Signing.ECDSASignature(rawRepresentation: sig)` `.isValidSignature(_, for: SHA256.hash(data: bytes))` |

**Transport of the detached signature (the module reads either, header first):**

- **`X-DSX-Signature` response header** on the `routes.json` response — value is the **base64**
  signature (standard or URL-safe, padded or not).
- **`<routesURL>.sig` sidecar** — a file beside the routes.json (same URL + `.sig`) whose body is the
  **base64** signature. Trailing whitespace/newline is tolerated.

**Publish flow on the device** (`Routing.swift`, only when `RemoteBundleGate.requiresVerification`):
fetch the routes.json **body + its signature** → `RemoteBundleGate.verifyManifest(bodyBytes,
signature:)` → on `.verified` `dsx.global.set("routes_signed", bodyText)` (and `route.sync`); on any
rejection publish nothing and drop the cached signed bytes. The engine (`Router.trustedRoutes`) then
parses the trusted table **only** from `global.routes_signed`, and only when the gate holds a verified
verdict for those exact bytes — so the rendered table is provably the signed content.

> The reference signer `ClosedSource/scripts/sign_manifest.rb` emits **exactly** this — and
> **self-verifies** its own output (Ruby OpenSSL) before writing it, since the CryptoKit verifier
> can't run at build time. Confirmed lengths: Ed25519 sig 64 B / pubkey 32 B; P-256 sig 64 B (P1363) /
> pubkey 65 B (X9.63, leading `0x04`).

## Signing on deploy (how-to)

Three steps: **generate keys → configure App.json → sign on deploy.**

**1 · Generate a keypair** (once; keep the private key secret — treat it like a code-signing key):

```bash
# Ed25519 (recommended default):
ruby ClosedSource/scripts/sign_manifest.rb genkey --alg ed25519 --out ./signing/dsx
#   → ./signing/dsx.private.pem  (SECRET, never commit)   ./signing/dsx.public.pem
#   → prints the base64 PUBLIC key + a ready-to-paste App.json bundle_signing block
# ECDSA-P256 instead:  --alg p256
```

**2 · Configure App.json** — paste the printed PUBLIC key into `bundle_signing` and set `enabled: true`:

```jsonc
"bundle_signing": { "enabled": true, "algorithm": "Ed25519", "public_key": "BASE64_FROM_genkey" }
```

(Rotation: list several under `keys: [...]` — a manifest verifies if **any** key validates it.) Shipping
this block (with `enabled` not false and ≥1 usable key) activates verification; production `entry.ota`
requires it and fail-closes on an unverified remote table.

**3 · Sign the manifest on every deploy** — sign the **exact `routes.json` you publish**:

```bash
ruby ClosedSource/scripts/sign_manifest.rb sign --key ./signing/dsx.private.pem --in ./deploy/routes.json
#   → ./deploy/routes.json.sig  (base64 detached signature) + prints sha256 + the signature
```

> **C1/C2 author-before-sign.** A release signed-OTA table must use the routes.json **object form**
> with a non-negative integer `"version"` (bump it every release). If a route declares `"assets"`, every
> entry must contain a non-empty `"path"` and a 64-character hexadecimal `"sha256"` — add those fields
> **before** signing. The signer is unchanged: it signs the final routes.json verbatim, so the version
> and hashes are authenticated by the same signature (no new key). A bare array, an unversioned object,
> or malformed declared asset metadata is rejected fail-closed by the signed release path. Legacy bare
> arrays remain accepted only by the signing-OFF debug/local-development parser.

Then **publish the signature beside the bytes**: upload `routes.json.sig` to `<routesURL>.sig`, **or**
serve the base64 as the `X-DSX-Signature` header on the `routes.json` response. Where signing runs:

- **Backend-served OTA manifest (the common case):** the route table is fetched at runtime from
  `host + entry.ota`, so the **backend signs it** — call `sign_manifest.rb` (or any Ed25519 /
  ECDSA-P256-over-SHA-256-P1363 signer) in the deploy pipeline that publishes the routes.json, and serve
  the `.sig`/header. The app never holds the private key.
- **routes.json shipped in the per-app assets bundle:** the **"Sign route manifest"** step in
  `codemagic.yaml` signs `$ASSETS_DIR/routes.json` when a private key is configured — the
  `BUNDLE_SIGNING_PRIVATE_KEY` application-scoped Codemagic **env SECRET** (inline PEM). URL-based
  private-key retrieval is rejected to keep credentials out of process metadata and to avoid expanding
  the build worker's network trust boundary. The signed `.sig` is a build artifact. The step is a
  **no-op** when no key is set or no routes.json is present, so non-signing apps are untouched. The
  private key lives **only** in the application-scoped Codemagic secret — never in the repo, the
  assets bundle, or the IPA.

## Status & deployment responsibilities

- **Implemented & in-scope (engine):** the verifier (`RemoteBundleGate`), the trust-anchor surface
  (`AppManifest.bundleSigning`), and the **enforcement** at the one load gate (`Router.trustedRoutes`).
  Bundled-only releases may leave it inactive; production `entry.ota` forces fail-closed verification.
- **Implemented (module, `ClosedSource`):** `Routing.swift` fetches the detached signature
  (`X-DSX-Signature` header → `<routesURL>.sig` sidecar), calls `verifyManifest` with the exact signed
  bytes, and publishes them at `global.routes_signed` on `.verified` (offline-first: a previously-verified
  routes.json re-verifies locally from a small signed-bytes cache, so signing doesn't break offline
  routing). The signing-OFF DEBUG/bundled-only path remains byte-for-byte unchanged.
- **Implemented (build/signer):** the reference signer `ClosedSource/scripts/sign_manifest.rb` (ruby +
  openssl: `genkey` / `sign` / `pubkey`, emitting the exact verifier format and self-verifying it) and
  the guarded "Sign route manifest" step in `codemagic.yaml`. No private key material is ever introduced
  into the app binary or the repo.
- **Resolved review asks:** (a) the ECDSA-P256 layout the signer emits is **raw r‖s (P1363)**, DER→P1363
  converted — confirmed 64 B; (b) Ed25519 signs the **raw bytes** (no pre-hash) and the module submits
  the **exact fetched bytes** (`requestFull` body) — byte-identical to what was signed, no
  re-serialization; (d) the engine re-parses the table from `routes_signed` (never `global.routes` while
  signing is on) — that is the intended contract the module honors.
- **Implemented (C1 anti-rollback · C2 per-asset hashes — engine + module):** release signed OTA requires
  the **object form** `{ version, routes:[…] }`; the legacy bare array remains available only when signing
  is OFF in debug/local development. `RemoteBundleGate` records a monotonic `lastVerifiedVersion`
  (persisted via `Routing` next to the verified body, re-seeded on launch);
  the courier refuses a regressing version (`.rejectedRollback` / `route_unavailable reason:"rollback_detected"`).
  Per-route `assets[].sha256` (inside the signed bytes) lets `DSXView`/`DSXRemoteCache` hash each fetched asset
  and refuse a missing hash or mismatch (`route_unavailable reason:"asset_integrity"`). Both are enforced
  whenever signed verification is active and are a
  **byte-for-byte no-op when signing is OFF** (the version compare and the hash check are skipped entirely).
  On the signed path, a missing/invalid version or a declared asset entry with a missing/invalid hash is a
  hard table-policy rejection; any fetched path omitted from the authenticated hash map is rejected by the
  asset consumer as `.missing`. **No signer change** — the fields ride inside the verbatim-signed routes.json.
- **Needs the user's own infra:** the **private key** (a Codemagic env SECRET, or the URL the build
  fetches it from) — never committed; and, if the OTA manifest is **served by the client's backend**,
  the **backend signing** step (the build step only covers a routes.json shipped in the assets bundle).
- **Implemented (Android platform floor):** the Kotlin gate keeps Ed25519 — the documented DEFAULT
  algorithm — working on the whole `minSdk 24` range, not just the API 33+ slice where Conscrypt has
  it. The kernel holds an EMPTY SEAM (`ed25519LegacyVerifier` — null by default, consulted only when
  the platform provider is absent, refusing when unfilled); the RFC 8032 verifier itself is
  BACKWARD-COMPAT for Android < 33 and lives in the excludable legacy facet `Core/LegacyCrypto`, so an
  app whose `minSdk >= 33` excludes it and ships zero hand-written crypto (see *Platform floor —
  Ed25519 on Android*). Before this, an Android 7–12 install would have refused every correctly signed
  manifest and never applied an OTA, silently. BOTH configurations are pinned by tests that can fail:
  facet present in `gradle :app:test`, facet excluded (the empty-seam refusal) in `gradle :core:test`.
- **Unverifiable without a device build:** the CryptoKit verify path runs only on-device (Swift doesn't
  compile in the authoring environment); the signer's self-verification + the documented byte lengths are
  the build-time proof that the formats line up. The **Kotlin** verifier is the exception — the platform
  backend and the empty-seam refusal run locally under `gradle :core:test`, and the legacy facet's RFC
  8032 vectors + differential cross-check with the JDK provider under `gradle :app:test`.

## Extending to assets — now built (C2)

The route **table** is authenticated (v1); per-asset integrity (C2) chains off it. Each asset's SHA-256
is listed **inside** the signed `routes.json` (`routes[].assets[].sha256`, lowercase hex), so the table
signature already protects the hash list — **no second signing key**, the trust chains from the one anchor.

**Where the state lives.** The hash table is engine TRUST STATE, held by the **kernel gate**
(`RemoteBundleGate`) right beside the verified-bytes digest and the anti-rollback version — *not* by the
Routing module. `Routing` is only the COURIER: on a `.verified`-and-accepted manifest it parses
`routes[].assets[].sha256` (`Routing.assetHashes(from:)`) and publishes the table via
`RemoteBundleGate.setAssetHashes(_:)` (and re-seeds it from the offline cache on launch). The asset
consumers then read it **through the gate**, so a cross-module read never reaches across to a module
singleton (monorepo working rules rule 1) — it goes to a kernel authority, exactly like `verifyManifest`.

**Consumer flow (`DSXView` → `DSXRemoteCache` → `RemoteBundleGate`).** When `DSXView` fetches a screen
file / folder manifest / component asset, it calls `DSXRemoteCache.passesIntegrity(text:url:)`, which maps
the URL back to its host-relative path and delegates to `RemoteBundleGate.checkAsset(_:forPath:)`:

1. **Signing OFF** → `.skip` ⇒ `passesIntegrity` returns `true` immediately (no hashing — today's
   behavior, byte-for-byte).
2. **Signing ON** with no declared hash for the fetched path → `.missing` ⇒ `false`; the bytes are discarded,
   the route falls back, and `route_unavailable` reports `reason:"asset_integrity"`.
3. Else the gate computes `SHA256.hash(data:)` of the fetched bytes, hex-encodes, and **constant-time-ish**
   compares against the manifest hash → `.match` (`true`) or `.mismatch`. On `.mismatch` the consumer
   **discards** the bytes and degrades to the route-level fallback (DSXWebView), and a `route_unavailable`
   (`reason:"asset_integrity"`, `path` = the asset) is broadcast through the engine-owned channel. The one
   CryptoKit hash-compare lives in the gate, beside the signature verify it chains from.

So a CDN that swaps an asset's bytes (but can't re-sign the table that pins its hash) gets the fallback,
not attacker DSX — the same fail-closed posture the table already had, now extended to the assets a route
points at. While signing is ON, assets without a declared hash are refused; the legacy skip behavior is
confined to the signing-OFF debug/local-development path.
