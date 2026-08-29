# auth/ — the AUTHENTICATION PROOF core

> The plan: `ClosedSource/Documentation/v4-launch/completeness/A1-auth-hardening.md`.
> Normative sources: RFC 7636 (PKCE), RFC 9700 / BCP 240 (OAuth 2.0 Security BCP),
> RFC 6749 §10.12, RFC 4648 §5.

**A login is the one flow where a fail-open default is a compromise.** Two folds live here,
both pure, both judged by the same files on all three runtimes.

| File | Section | What it pins |
|---|---|---|
| `trigger.json` | `matchesConfiguredTrigger` | **A configured login trigger is an ORIGIN, not a string prefix.** `https://idp.example` must not be satisfied by `https://idp.example.attacker.invalid`, by `https://idp.example:8443`, or by `https://idp.example@evil.tld` — each of those hands an attacker a web view wearing the identity provider's clothes and sharing the app's cookie jar. A prefix that is not a URL keeps raw-prefix behaviour, because deployments configure bare host fragments and silently dropping them disables their logins. |
| `trigger.json` | `isAllowedAuthorizationUrl` | What may be handed to a browser as an authorization START: https, a real host, no URL credentials. |
| `pkce.json` | `verifier` · `base64url` · `mint` · `challenge` | RFC 7636 §4.1's ABNF verbatim, RFC 4648 §5 with padding dropped, the 256-bit entropy floor expressed as a refusal, and `code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))`. |
| `pkce.json` | `plan` · `apply` | Which proofs the module OWNS for a given authorize URL — adopt what the caller already wrote, mint what is missing — and the exact string it builds. |
| `pkce.json` | `verify` | The verdict a returning callback earns. `unproven` is the compatibility floor; everything else refuses, and a refusal never resolves and never echoes the received value. |
| `pkce.json` | `idToken` · `tokenEndpoint` · `constantTime` | The unverified payload read used only to REFUSE a nonce mismatch, the verifier-release boundary, and the comparison every proof check runs through. |

**Nothing here hashes.** RFC 7636's S256 is `BASE64URL-ENCODE(SHA256(ASCII(verifier)))`; the
SHA-256 half is the platform's (CryptoKit / `MessageDigest` / WebCrypto), exactly as
`CryptoCore` says, and the encoding half is what would drift. Each runner hashes the corpus
verifier with its own primitive and asserts it reproduces the recorded `sha256Hex` before
encoding it, so the corpus cannot quietly carry a wrong digest.

**Nothing here draws entropy.** Every minted value is a function of bytes the module supplies,
which is what makes a login proof corpus-testable at all. The CSPRNG behind those bytes
(`SecRandomCopyBytes` / `SecureRandom` / `crypto.getRandomValues`) is the platform's and is
deliberately not modelled.

Three runners, one pair of files: `@despia-native/kernel` `auth-proof.ts`
(`packages/kernel/test/auth-proof-conformance.test.ts`), `:core` `AuthProof.kt`
(`AuthProofConformanceTest`), and the Swift reference `Engine/iOS/AuthProof.swift`
(`AuthProofConformance.swift`, record lane).

The consumers are `Core/Auth/LoginHelper` (the trigger fold, both twins) and `Core/Auth/OAuth`
(the proof folds, both twins). The folder is named for the LAW: any later module that starts
an authorization request answers to the same files.
