# Web Crypto in JSE — the standard API, 1:1, no JS engine

> DSX markup gets the real [Web Crypto API](https://developer.mozilla.org/docs/Web/API/SubtleCrypto):
> `crypto.subtle.*`, `crypto.getRandomValues`, `crypto.randomUUID` — verbatim syntax, every
> call mapped straight to native crypto (iOS: **CryptoKit / CommonCrypto / SecKey**; Android:
> `javax.crypto` / `java.security`). Code from MDN runs unchanged. There is no JS engine —
> JSE evaluates the calls and native does the math.

## The mental model

- **Bytes are plain arrays.** An `ArrayBuffer` / `Uint8Array` is array-like in JS, so in JSE
  it simply *is* a number array (`[72, 105, …]`). Anything that takes a `BufferSource` also
  accepts a **string** (auto-UTF-8). Results come back as byte arrays.
- **Keys are CryptoKey-shaped dicts** — `{ type, extractable, algorithm, usages }` — carrying
  their material in internal fields. Value semantics: store them in `dsx.variable.*`, pass them
  around, no handles to leak. `exportKey` honors `extractable`.
- **`await` is real.** Statement-level `await crypto.subtle.*` runs the work **off the main
  thread** (PBKDF2 iterations and RSA keygen never jank a surface) and continues the body
  with the result — exactly the `await fetch` contract. In expression position (`{{ }}`),
  the same calls evaluate synchronously (`await v` on a non-promise is `v` — JS semantics).
- **Total, like all of JSE.** An unsupported algorithm / malformed key logs `[JSE crypto]`
  and yields `null` — never a crash, never a hang.

## Recipes

### Hash → hex (the MDN example, character for character)

```js
const msgUint8 = new TextEncoder().encode(dsx.variable.message)
const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8)
const hashArray = Array.from(new Uint8Array(hashBuffer))
dsx.variable.hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
```

(Shortcut once you're off MDN: `(await crypto.subtle.digest('SHA-256', msg)).toHex()`.)

### AES-GCM — encrypt / decrypt

```js
const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
const iv = crypto.getRandomValues(new Uint8Array(12))
const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, 'top secret')
// sealed = ciphertext ‖ 16-byte tag (the WebCrypto layout)

const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, sealed)
dsx.variable.text = new TextDecoder().decode(plain)
```

### HMAC-signed API request

```js
const k = await crypto.subtle.importKey('raw', Uint8Array.fromBase64(dsx.variable.secret),
                                        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
const sig = await crypto.subtle.sign('HMAC', k, dsx.variable.payload)
const r = await fetch(dsx.variable.apiUrl, {
  method: 'POST',
  headers: { 'X-Signature': sig.toHex() },
  body: { payload: dsx.variable.payload }
})
```

### Password → key (PBKDF2), then encrypt

```js
const base = await crypto.subtle.importKey('raw', dsx.variable.password, 'PBKDF2', false, ['deriveKey'])
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt: Uint8Array.fromHex(dsx.variable.saltHex), iterations: 100000, hash: 'SHA-256' },
  base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
```

### ECDSA (P-256) — sign on device, verify anywhere

```js
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, payload)
const ok  = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, payload)
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)   // ship to the server
```

Signatures are raw `r‖s` (IEEE P1363) — exactly what WebCrypto on the server verifies.

### Random

```js
const iv = crypto.getRandomValues(new Uint8Array(12))   // returns the filled array
const id = crypto.randomUUID()                          // 'f81d4fae-7dec-…' (lowercase)
```

## What's supported

| Operation | Algorithms |
|---|---|
| `digest` | SHA-1 · SHA-256 · SHA-384 · SHA-512 |
| `encrypt` / `decrypt` | AES-GCM · AES-CBC · AES-CTR · RSA-OAEP |
| `sign` / `verify` | HMAC · ECDSA (P-256/384/521) · Ed25519 · RSASSA-PKCS1-v1_5 · RSA-PSS |
| `deriveBits` / `deriveKey` | PBKDF2 · HKDF · ECDH · X25519 |
| `generateKey` | AES-* · HMAC · EC · Ed25519 / X25519 · RSA-* |
| `importKey` / `exportKey` | `raw` · `spki` · `pkcs8` · `jwk` |
| `wrapKey` / `unwrapKey` | any encrypt algorithm + AES-KW |

**Companion globals** (the idioms around the API, all 1:1 JS): `new Uint8Array(n)` ·
`Uint8Array.fromHex(s)` / `.fromBase64(s)` · `bytes.toHex()` / `.toBase64()` ·
`new TextEncoder().encode(s)` / `new TextDecoder().decode(b)` · `Array.from(x)` ·
`btoa(s)` / `atob(s)` — plus `n.toString(16)`, `s.padStart(2, '0')` as general JS methods.

## Native limits (logged, never thrown)

| Constraint | Why |
|---|---|
| AES-GCM `tagLength` = 128 only | CryptoKit's sealed box is a fixed 16-byte tag |
| RSA `publicExponent` = 65537 only | SecKey generates F4 keys |
| RSA-PSS `saltLength` must equal the hash length | SecKey's PSS algorithms fix the salt |
| RSA-OAEP `label` unsupported | SecKey OAEP has no label parameter |
| `getRandomValues` ≤ 65536 bytes | the spec's own quota |
| AES-KW / HKDF / EC der formats | iOS 15+ / 14+ / 14+ (logged below) |

## Where the trust boundary is

JSE crypto is **author-side** crypto — hashing, request signing, sealing payloads, deriving
keys from secrets the markup already holds. It does *not* move the trust boundary: anything
the server must not take the client's word for (entitlements, balances, receipts) stays a
server reconciliation, exactly like the player's access model. Keys live in the reactive
store as values — for OS-protected keys (Secure Enclave, keychain), wrap a module and call
it with `await dsx.module.scheme.method({ … })`.
