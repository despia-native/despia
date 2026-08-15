# link-signing fixtures

Signed by the REAL reference signer — `ClosedSource/scripts/sign_manifest.rb`, Ed25519 — not by
the test. The point of these files is CROSS-IMPLEMENTATION proof: a Ruby signer runs at deploy
time and a WebCrypto verifier runs on the device, and `remote-bundle-signing.md`'s byte/format
contract says they must agree byte for byte. Fixtures signed by the code under test would prove
only that it agrees with itself.

- `link-v1.json` (+ `.sig`) — a table at version 1, the normal case.
- `link-v0.json` (+ `.sig`) — the SAME table at version 0. It verifies perfectly and must still
  be refused when the accepted floor is 1 (C1 anti-rollback): replaying a genuinely-signed older
  table is how a deliberately withdrawn route comes back.
- `public-key.b64` — the raw 32-byte Ed25519 public key, base64: the trust anchor an app bakes in.

The private key was generated for these fixtures and deliberately NOT kept — nothing here is a
credential. To regenerate:

    ruby ClosedSource/scripts/sign_manifest.rb genkey --alg ed25519 --out ./dsx
    ruby ClosedSource/scripts/sign_manifest.rb sign --key ./dsx.private.pem --in link-v1.json
